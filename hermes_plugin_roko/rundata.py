"""A run card: one roko run as the person and the UIs see it.

roko serve's run summary reports cost, tokens and gates as zero for plan
runs, whose spend and gate verdicts are recorded as events it does not read,
and it has no start or end time. So a card is put together from four reads:

- `run_status` (MCP): state, verdict, queue position, task counts, milestones;
- the run's durable event index, `GET /api/runs/{id}/events`: the tasks, the
  model of each attempt, gate verdicts, cost and tokens;
- the run's bundle manifest, `GET /api/runs/{id}/bundle`: start and end times;
- what the run waits on the person for, and, once it ends, its batch branch.

Events are folded incrementally: a `RunTracker` keeps its cursor and running
totals, so polling an active run reads only the rows written since the last
poll, and a finished run's index is read once. Everything that came from roko
passes through `sanitize.clean` on the way in.
"""

from __future__ import annotations

import logging
import re
import shlex
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from .catalog import TERMINAL_STATES
from .client import RokoClient
from .decisions import pending_effects, pending_for_run
from .errors import Code, RokoError
from .sanitize import clean
from .workspace import delivered_work, reported_work

logger = logging.getLogger(__name__)

# The event kinds a card is built from: everything but agent output,
# heartbeats and learning-loop noise. roko accepts at most 16 per request.
FOLD_TYPES = (
    "plan_set_loaded",
    "plan_started",
    "task_started",
    "agent_spawned",
    "gate_rung_started",
    "gate_result",
    "efficiency_event",
    "task_completed",
    "task_blocked",
    "plan_completed",
    "run_completed",
    "error",
)
TIMELINE_TYPES = frozenset(FOLD_TYPES) - {"efficiency_event"}
_TASK_KINDS = frozenset(
    {"task_started", "agent_spawned", "gate_rung_started", "gate_result", "task_completed", "task_blocked"}
)
_PLAN_KINDS = frozenset({"plan_started", "plan_completed"})
PAGE_LIMIT = 200
# One refresh reads at most this many pages (40,000 rows); the next one goes on.
MAX_PAGES = 200
MAX_TIMELINE = 400
MAX_TASKS = 200
MAX_PLANS = 8
OUTPUT_CHARS = 2_000
EXCERPT_CHARS = 200
WHY_CHARS = 1_200
MAX_TRACKERS = 64
DELIVERED_TTL_S = 30.0
BUNDLE_RETRY_S = 10.0
# roko names a prompt run's synthetic live-hub plan `run-<8 hex>`; it never
# belongs on a card.
_SYNTHETIC_PLAN = re.compile(r"^run-[0-9a-f]{8}$")
TOKEN_METRICS = {
    "input_tokens": "input",
    "output_tokens": "output",
    "cache_read_tokens": "cache_read",
    "cache_write_tokens": "cache_write",
}


@dataclass
class GateView:
    gate: str
    passed: bool
    output: str
    runs: int = 1

    def excerpt(self, limit: int = EXCERPT_CHARS) -> str:
        """A passing gate's command line, or the end of a failing gate's output."""
        text = self.output.strip()
        if not text:
            return ""
        if self.passed:
            return clean(text.splitlines()[0], limit)
        tail = text[-limit:]
        return tail if len(text) <= limit else "…" + tail[1:]


@dataclass
class TaskView:
    plan_id: str
    task_id: str
    title: str = ""
    outcome: str = "pending"
    model: str | None = None
    provider: str | None = None
    role: str | None = None
    attempts: int = 0
    rung: str | None = None
    cost_usd: float = 0.0
    saw_cost: bool = False
    blocked_by: str | None = None
    reason: str | None = None
    depends_on: list[str] = field(default_factory=list)
    gates: dict[str, GateView] = field(default_factory=dict)


@dataclass
class EventFold:
    """Running totals over a run's event index, fed one row at a time."""

    cursor: int = 0
    cost_usd: float = 0.0
    saw_cost: bool = False
    tokens: dict[str, int] = field(default_factory=lambda: dict.fromkeys(TOKEN_METRICS.values(), 0))
    tasks: dict[tuple[str, str], TaskView] = field(default_factory=dict)
    plans: dict[str, dict[str, Any]] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    completed: dict[str, Any] | None = None
    timeline: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=MAX_TIMELINE))
    rows: int = 0

    def feed(self, cursor: int, kind: str, event: dict[str, Any]) -> None:
        self.rows += 1
        plan_id = clean(event.get("plan_id"), 120, one_line=True)
        if plan_id and _SYNTHETIC_PLAN.match(plan_id):
            return
        task_id = clean(event.get("task_id"), 80, one_line=True)
        task = self._task(plan_id, task_id) if plan_id and task_id else None
        if kind == "plan_set_loaded":
            for plan in event.get("plans") or []:
                if isinstance(plan, dict) and plan.get("plan_id"):
                    pid = clean(plan["plan_id"], 120, one_line=True)
                    entry = self.plans.setdefault(pid, {"plan_id": pid})
                    entry["title"] = clean(plan.get("title"), 160, one_line=True)
                    entry["tasks_total"] = _int(plan.get("tasks_total"))
                    entry["wave"] = _int(plan.get("wave"))
        elif kind == "plan_started" and plan_id:
            entry = self.plans.setdefault(plan_id, {"plan_id": plan_id})
            entry["started"] = True
            entry.setdefault("tasks_total", _int(event.get("tasks_total")))
        elif kind == "plan_completed" and plan_id:
            entry = self.plans.setdefault(plan_id, {"plan_id": plan_id})
            entry["success"] = bool(event.get("success"))
        elif kind == "task_started" and task is not None:
            task.title = clean(event.get("title"), 160, one_line=True) or task.title
            if task.outcome == "pending":
                task.outcome = "running"
        elif kind == "agent_spawned" and task is not None:
            task.attempts = max(task.attempts, _int(event.get("attempt")) + 1)
            task.model = clean(event.get("model"), 80, one_line=True) or task.model
            task.provider = clean(event.get("provider"), 80, one_line=True) or task.provider
            task.role = clean(event.get("role"), 40, one_line=True) or task.role
            if task.outcome == "pending":
                task.outcome = "running"
        elif kind == "gate_rung_started" and task is not None:
            task.rung = clean(event.get("rung_name"), 120, one_line=True) or None
        elif kind == "gate_result" and task is not None:
            name = clean(event.get("gate"), 120, one_line=True) or "gate"
            output = clean(event.get("output_text"), OUTPUT_CHARS * 4)
            if len(output) > OUTPUT_CHARS:  # keep the command line and the end of the output
                head = output.splitlines()[0][:200] if output else ""
                output = head + "\n…\n" + output[-(OUTPUT_CHARS - len(head) - 3) :]
            previous = task.gates.get(name)
            task.gates[name] = GateView(
                name, bool(event.get("passed")), output, (previous.runs + 1) if previous else 1
            )
            task.rung = None
        elif kind == "efficiency_event":
            self._efficiency(event, task)
        elif kind == "task_completed" and task is not None:
            task.outcome = clean(event.get("outcome"), 40, one_line=True) or "unknown"
            task.rung = None
        elif kind == "task_blocked" and task is not None:
            task.outcome = "blocked"
            task.blocked_by = clean(event.get("blocked_by"), 200, one_line=True) or None
            task.reason = clean(event.get("reason"), 400, one_line=True) or None
        elif kind == "run_completed":
            self.completed = {
                "outcome": clean(event.get("outcome"), 40, one_line=True) or None,
                "duration_ms": _int(event.get("duration_ms")) or None,
            }
        elif kind == "error":
            message = clean(event.get("message"), 400, one_line=True)
            if message:
                self.errors = [*self.errors[-9:], message]
        line = timeline_entry(cursor, kind, event)
        if line is not None:
            self.timeline.append(line)

    def _task(self, plan_id: str, task_id: str) -> TaskView | None:
        key = (plan_id, task_id)
        task = self.tasks.get(key)
        if task is None:
            if len(self.tasks) >= MAX_TASKS:
                return None
            task = self.tasks[key] = TaskView(plan_id, task_id)
        return task

    def _efficiency(self, event: dict[str, Any], task: TaskView | None) -> None:
        metric = str(event.get("metric") or "")
        try:
            value = float(event.get("value") or 0.0)
        except (TypeError, ValueError):
            return
        if value != value or value < 0:  # NaN or negative: not a measurement
            return
        if metric == "cost_usd":
            self.cost_usd += value
            self.saw_cost = True
            if task is not None:
                task.cost_usd += value
                task.saw_cost = True
        elif metric in TOKEN_METRICS:
            self.tokens[TOKEN_METRICS[metric]] += int(value)

    @property
    def gate_counts(self) -> dict[str, int]:
        verdicts = [gate.passed for task in self.tasks.values() for gate in task.gates.values()]
        passed = sum(verdicts)
        return {"passed": passed, "failed": len(verdicts) - passed, "total": len(verdicts)}


def timeline_entry(cursor: int, kind: str, event: dict[str, Any]) -> dict[str, Any] | None:
    """One event index row as a readable timeline line, or None for rows the timeline skips."""
    if kind not in TIMELINE_TYPES:
        return None
    plan = clean(event.get("plan_id"), 120, one_line=True)
    if plan and _SYNTHETIC_PLAN.match(plan):
        return None
    task = clean(event.get("task_id"), 80, one_line=True) or None
    if (kind in _TASK_KINDS and task is None) or (kind in _PLAN_KINDS and not plan):
        return None  # roko's log entries carry empty ids; they name nothing
    # A prompt run is a one-task plan named after the run: call it the run.
    run_id = clean(event.get("run_id"), 80, one_line=True)
    own_plan = bool(plan) and plan == run_id
    if kind == "plan_completed" and own_plan:
        return None  # run_completed says the same, with the duration
    entry: dict[str, Any] = {"cursor": cursor, "type": kind, "task_id": task}
    if kind == "plan_set_loaded":
        plans = [p for p in event.get("plans") or [] if isinstance(p, dict)]
        text = f"loaded {len(plans)} plan{'s' if len(plans) != 1 else ''}"
        if len(plans) == 1:
            only = clean(plans[0].get("plan_id"), 120, one_line=True)
            text = "run set up" if run_id and only == run_id else f"loaded plan {only}"
    elif kind == "plan_started":
        total = _int(event.get("tasks_total"))
        tasks = f"{total} task{'s' if total != 1 else ''}"
        text = f"run started ({tasks})" if own_plan else f"plan {plan} started ({tasks})"
    elif kind == "task_started":
        title = clean(event.get("title"), 120, one_line=True)
        text = f"{task} started" + (f": {title}" if title else "")
    elif kind == "agent_spawned":
        model = clean(event.get("model"), 80, one_line=True) or "?"
        provider = clean(event.get("provider"), 60, one_line=True)
        attempt = _int(event.get("attempt")) + 1
        text = f"{task} attempt {attempt} on {model}" + (f" ({provider})" if provider else "")
    elif kind == "gate_rung_started":
        text = f"{task} checking {clean(event.get('rung_name'), 120, one_line=True)}"
    elif kind == "gate_result":
        passed = bool(event.get("passed"))
        entry["passed"] = passed
        gate = clean(event.get("gate"), 120, one_line=True)
        text = f"{task} gate {gate} {'passed' if passed else 'did not pass'}"
    elif kind == "task_completed":
        outcome = clean(event.get("outcome"), 40, one_line=True) or "ended"
        entry["outcome"] = outcome
        text = (
            f"{task} {outcome}" if outcome in ("passed", "skipped", "blocked") else f"{task} ended: {outcome}"
        )
    elif kind == "task_blocked":
        reason = clean(event.get("reason"), 200, one_line=True)
        text = f"{task} blocked" + (f": {reason}" if reason else "")
    elif kind == "plan_completed":
        success = bool(event.get("success"))
        entry["passed"] = success
        text = f"plan {plan} finished" if success else f"plan {plan} ended without success"
    elif kind == "run_completed":
        outcome = clean(event.get("outcome"), 40, one_line=True) or "ended"
        duration = _int(event.get("duration_ms"))
        text = f"run {outcome}" + (f" in {fmt_duration(duration)}" if duration else "")
    else:  # error
        text = "error: " + clean(event.get("message"), 300, one_line=True)
    entry["text"] = clean(text, 400, one_line=True)
    return entry


class RunTracker:
    """What the plugin knows about one run between card builds."""

    def __init__(self, run_id: str) -> None:
        self.run_id = run_id
        self.lock = threading.Lock()
        self.fold = EventFold()
        self.has_index = False
        self.index_missing = False
        self.started_at: str | None = None
        self.finished_at: str | None = None
        self.origin: str | None = None
        self.plan_ids: list[str] = []
        self.invocations = 0
        self.bundle_final = False
        self.bundle_next_try = 0.0
        self.plan_tasks: dict[str, list[dict[str, Any]]] = {}
        self.plans_fetched: set[str] = set()
        self.delivered: dict[str, Any] | None = None
        self.delivered_at = 0.0
        self.final: dict[str, Any] | None = None

    def refresh_events(self, client: RokoClient) -> None:
        """Read the rows written since the last refresh."""
        path = f"/api/runs/{quote(self.run_id, safe='')}/events"
        for _ in range(MAX_PAGES):
            params = {"cursor": self.fold.cursor, "limit": PAGE_LIMIT, "types": ",".join(FOLD_TYPES)}
            try:
                page = client.get(path, params)
            except RokoError as exc:
                if exc.code is Code.NOT_FOUND:  # a queued run has no index yet
                    self.index_missing = True
                    return
                if exc.code is Code.INVALID and self.fold.cursor:
                    # The index was rewritten under us (a repair): start over.
                    logger.debug("roko: event cursor for %s rejected, rereading", self.run_id)
                    self.fold = EventFold()
                    continue
                raise
            if not isinstance(page, dict):
                raise RokoError(Code.PROTOCOL, "GET /api/runs/{id}/events did not answer with an object")
            self.has_index = True
            self.index_missing = False
            events = page.get("events")
            for row in events if isinstance(events, list) else []:
                if not isinstance(row, dict):
                    continue
                event = row.get("event")
                kind = str(row.get("type") or (event.get("type") if isinstance(event, dict) else "") or "")
                if isinstance(event, dict) and kind:
                    self.fold.feed(_int(row.get("cursor")), kind, event)
            next_cursor = _int(page.get("next_cursor"))
            moved = next_cursor > self.fold.cursor
            self.fold.cursor = max(self.fold.cursor, next_cursor)
            if not page.get("has_more") or not moved:
                return

    def refresh_bundle(self, client: RokoClient, terminal: bool) -> None:
        """Start and end times, origin and plans, from the run's manifest."""
        if self.bundle_final or time.monotonic() < self.bundle_next_try:
            return
        if self.started_at is not None and not terminal:
            return
        self.bundle_next_try = time.monotonic() + BUNDLE_RETRY_S
        try:
            body = client.get(f"/api/runs/{quote(self.run_id, safe='')}/bundle")
        except RokoError as exc:
            if exc.code in (Code.NOT_FOUND, Code.FORBIDDEN):
                if terminal:
                    self.bundle_final = True
                return
            raise
        manifest = body.get("manifest") if isinstance(body, dict) else None
        if not isinstance(manifest, dict):
            return
        invocations = [i for i in manifest.get("invocations") or [] if isinstance(i, dict)]
        self.invocations = len(invocations)
        if invocations:
            self.started_at = _stamp(invocations[0].get("started_at"))
        closed = manifest.get("closed")
        if isinstance(closed, dict):
            self.finished_at = _stamp(closed.get("ended_at"))
        self.origin = clean(manifest.get("origin"), 80, one_line=True) or None
        self.plan_ids = [
            clean(pid, 120, one_line=True) for pid in manifest.get("plan_ids") or [] if isinstance(pid, str)
        ][:MAX_PLANS]
        if terminal:
            self.bundle_final = True

    def refresh_plan_tasks(self, client: RokoClient) -> None:
        """The authored task list of each plan in a plan run, so tasks that have not started show."""
        for plan_id in self.plan_ids:
            if plan_id in self.plans_fetched or plan_id == self.run_id:
                continue
            self.plans_fetched.add(plan_id)
            try:
                body = client.get(f"/api/plans/{quote(plan_id, safe='')}/tasks")
            except RokoError as exc:
                logger.debug("roko: no task list for plan %s: %s", plan_id, exc)
                continue
            tasks = body.get("tasks") if isinstance(body, dict) else None
            self.plan_tasks[plan_id] = [
                {
                    "id": clean(task.get("id"), 80, one_line=True),
                    "title": clean(task.get("title"), 160, one_line=True),
                    "depends_on": [
                        clean(dep, 80, one_line=True) for dep in task.get("depends_on") or [] if dep
                    ][:20],
                }
                for task in (tasks if isinstance(tasks, list) else [])[:MAX_TASKS]
                if isinstance(task, dict) and task.get("id")
            ]

    def task_rows(self) -> list[TaskView]:
        """Every task: authored plan order first, then any the events named that the plan did not."""
        rows: list[TaskView] = []
        seen: set[tuple[str, str]] = set()
        for plan_id, tasks in self.plan_tasks.items():
            for authored in tasks:
                key = (plan_id, authored["id"])
                view = self.fold.tasks.get(key) or TaskView(plan_id, authored["id"])
                view.title = view.title or authored["title"]
                view.depends_on = authored["depends_on"]
                rows.append(view)
                seen.add(key)
        rows.extend(task for key, task in self.fold.tasks.items() if key not in seen)
        return rows[:MAX_TASKS]


class CardCache:
    """Run trackers by (roko URL, run id), least recently used dropped first."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._trackers: OrderedDict[tuple[str, str], RunTracker] = OrderedDict()

    def tracker(self, url: str, run_id: str) -> RunTracker:
        key = (url, run_id)
        with self._lock:
            tracker = self._trackers.get(key)
            if tracker is None:
                tracker = self._trackers[key] = RunTracker(run_id)
            self._trackers.move_to_end(key)
            while len(self._trackers) > MAX_TRACKERS:
                self._trackers.popitem(last=False)
            return tracker


# -- building a card ----------------------------------------------------------


def build_card(
    client: RokoClient,
    cache: CardCache,
    run_id: str,
    *,
    summary: dict[str, Any] | None = None,
    logged: dict[str, Any] | None = None,
    workdir: Any = None,
) -> dict[str, Any]:
    """The full card for one run.

    `summary` is a `run_status` answer the caller already has (a tool that
    just waited on the run); `logged` is the run's entry in the plugin's run
    log, if Hermes started it.
    """
    if summary is None:
        summary = run_status(client, run_id)
    kind = str(summary.get("kind") or "")
    if kind.startswith("plan_generate:"):
        return _plan_generation_card(run_id, summary, logged)
    state = clean(summary.get("state"), 40, one_line=True) or "unknown"
    terminal = state in TERMINAL_STATES
    tracker = cache.tracker(client.settings.url, run_id)
    with tracker.lock:
        if tracker.final is not None and terminal:
            card = dict(tracker.final)
        else:
            # run_status already answered, so roko is up: a part that fails now
            # leaves a gap in the card, not an error instead of it.
            problems: list[str] = []
            steps: tuple[Callable[[], None], ...] = (
                lambda: tracker.refresh_events(client),
                lambda: tracker.refresh_bundle(client, terminal),
                lambda: tracker.refresh_plan_tasks(client),
            )
            for step in steps:
                try:
                    step()
                except RokoError as exc:
                    problems.append(exc.message)
            card = _compose(tracker, run_id, state, summary, logged)
            card["problems"] = problems
            # A finished run's events never change, so its card is kept; the
            # parts that can (what waits, the branch) are refreshed below.
            if terminal and tracker.has_index and tracker.bundle_final and not problems:
                tracker.final = dict(card)
        card["waiting"] = _waiting(client, run_id, state)
        if terminal:
            delivered = _delivered(tracker, workdir, run_id, summary)
            if delivered is not None:
                card.update(delivered)
    card["headline"] = headline(card)
    card["checked_at"] = now_iso()
    return card


def quick_totals(
    client: RokoClient, cache: CardCache, run_id: str, summary: dict[str, Any]
) -> dict[str, Any]:
    """A run's state and spend so far, without the requests only a full card needs."""
    state = clean(summary.get("state"), 40, one_line=True) or None
    if str(summary.get("kind") or "").startswith("plan_generate:"):
        return {"state": state}
    terminal = state in TERMINAL_STATES
    tracker = cache.tracker(client.settings.url, run_id)
    with tracker.lock:
        if tracker.final is not None and terminal:
            return {
                key: tracker.final.get(key) for key in ("state", "cost_usd", "finished_at", "events_read")
            }
        tracker.refresh_events(client)
        if terminal:
            tracker.refresh_bundle(client, True)
        fold = tracker.fold
        settled = terminal and (tracker.has_index or tracker.index_missing)
        return {
            "state": state,
            "cost_usd": round(fold.cost_usd, 6) if fold.saw_cost else None,
            "finished_at": tracker.finished_at if terminal else None,
            "events_read": fold.rows if settled else None,
        }


def run_status(client: RokoClient, run_id: str) -> dict[str, Any]:
    body = client.call_tool("run_status", {"run_id": run_id, "wait_secs": 0})
    if not isinstance(body, dict):
        raise RokoError(Code.PROTOCOL, "run_status did not answer with a JSON object")
    return body


def _compose(
    tracker: RunTracker,
    run_id: str,
    state: str,
    summary: dict[str, Any],
    logged: dict[str, Any] | None,
) -> dict[str, Any]:
    fold = tracker.fold
    logged = logged or {}
    kind = logged.get("kind") or _kind_from_plans(run_id, tracker.plan_ids)
    plan_id = logged.get("plan_id") or (tracker.plan_ids[0] if kind == "plan" and tracker.plan_ids else None)
    cost: float | None = round(fold.cost_usd, 6) if fold.saw_cost else None
    reported = summary.get("cost_usd")
    if cost is None and isinstance(reported, (int, float)) and reported > 0:
        cost = float(reported)
    started_at = tracker.started_at
    finished_at = tracker.finished_at
    duration_ms = (fold.completed or {}).get("duration_ms") or _between(started_at, finished_at)
    tasks = [_task_card(task) for task in tracker.task_rows()]
    multi_plan = len({task.plan_id for task in tracker.task_rows()}) > 1
    if not multi_plan:
        for task in tasks:
            task.pop("plan_id", None)
    card: dict[str, Any] = {
        "run_id": run_id,
        "kind": kind,
        "label": clean(logged.get("label") or plan_id or f"run {run_id[:8]}", 120, one_line=True),
        "plan_id": plan_id,
        "plan_ids": tracker.plan_ids,
        "state": state,
        "verdict": clean(summary.get("verdict"), 40, one_line=True) or None,
        "active": state not in TERMINAL_STATES,
        "position": summary.get("position") if isinstance(summary.get("position"), int) else None,
        "cost_usd": cost,
        "max_usd": logged.get("max_usd"),
        "tokens": dict(fold.tokens) if fold.saw_cost or any(fold.tokens.values()) else None,
        "started_at": started_at,
        "finished_at": finished_at,
        "duration_ms": duration_ms,
        "elapsed_ms": _between(started_at, now_iso()) if state == "running" and started_at else None,
        "tasks": tasks,
        "task_counts": _task_counts(summary, tasks),
        "gates": fold.gate_counts,
        "milestones": _milestones(summary, run_id),
        "errors": list(fold.errors),
        "origin": tracker.origin,
        "session_id": logged.get("session_id"),
        "hermes_started_at": logged.get("started_at"),
        "resumed": tracker.invocations > 1,
        "events_read": fold.rows,
    }
    return card


def _plan_generation_card(
    run_id: str, summary: dict[str, Any], logged: dict[str, Any] | None
) -> dict[str, Any]:
    logged = logged or {}
    result = summary.get("result") if isinstance(summary.get("result"), dict) else {}
    state = clean(summary.get("state"), 40, one_line=True) or "unknown"
    plan_id = clean((result or {}).get("slug") or logged.get("plan_id"), 120, one_line=True) or None
    card: dict[str, Any] = {
        "run_id": run_id,
        "kind": "plan_generate",
        "label": clean(logged.get("label") or "plan generation", 120, one_line=True),
        "plan_id": plan_id,
        "state": state,
        "verdict": state if state in TERMINAL_STATES else None,
        "active": state not in TERMINAL_STATES,
        "cost_usd": None,
        "max_usd": None,
        "task_count": _int((result or {}).get("task_count")) or None,
        "planner_error": clean(summary.get("error"), 1_000) or None,
        "session_id": logged.get("session_id"),
        "hermes_started_at": logged.get("started_at"),
        "tasks": [],
        "gates": {"passed": 0, "failed": 0, "total": 0},
        "milestones": [],
        "waiting": [],
    }
    card["headline"] = headline(card)
    card["checked_at"] = now_iso()
    return card


def _task_card(task: TaskView) -> dict[str, Any]:
    row: dict[str, Any] = {
        "plan_id": task.plan_id,
        "task_id": task.task_id,
        "title": task.title,
        "outcome": task.outcome,
        "model": task.model,
        "provider": task.provider,
        "attempts": task.attempts,
        "cost_usd": round(task.cost_usd, 6) if task.saw_cost else None,
        "rung": task.rung,
        "depends_on": task.depends_on,
        "gates": [
            {"gate": gate.gate, "passed": gate.passed, "excerpt": gate.excerpt(), "runs": gate.runs}
            for gate in task.gates.values()
        ],
    }
    if task.blocked_by or task.reason:
        row["blocked_by"] = task.blocked_by
        row["reason"] = task.reason
    return row


def _task_counts(summary: dict[str, Any], tasks: list[dict[str, Any]]) -> dict[str, int]:
    counts = summary.get("tasks")
    if isinstance(counts, dict) and counts.get("total"):
        return {str(key): _int(value) for key, value in counts.items()}
    done = [task["outcome"] for task in tasks]
    return {
        "total": len(done),
        "passed": sum(1 for outcome in done if outcome in ("passed", "already_satisfied")),
        "failed": sum(1 for outcome in done if outcome in ("failed", "blocked")),
        "unverified": sum(1 for outcome in done if outcome == "unverified"),
        "other": sum(
            1
            for outcome in done
            if outcome not in ("passed", "already_satisfied", "failed", "blocked", "unverified")
        ),
    }


def _milestones(summary: dict[str, Any], run_id: str = "") -> list[dict[str, Any]]:
    out = []
    for milestone in summary.get("milestones") or []:
        if isinstance(milestone, dict):
            text = clean(milestone.get("text"), 300, one_line=True)
            if run_id:  # roko names a prompt run's plan after the run
                text = text.replace(f"plan {run_id} ", "run ")
            out.append(
                {
                    "kind": clean(milestone.get("kind"), 40, one_line=True),
                    "text": text,
                    "at": milestone.get("at") if isinstance(milestone.get("at"), str) else None,
                }
            )
    return out[:20]


def _waiting(client: RokoClient, run_id: str, state: str) -> list[dict[str, Any]]:
    try:
        if state in ("running", "queued"):
            return pending_for_run(client, run_id)
        return pending_effects(client, run_id)
    except RokoError as exc:
        logger.debug("roko: could not list what run %s waits on: %s", run_id, exc)
        return []


def _delivered(
    tracker: RunTracker, workdir: Any, run_id: str, summary: dict[str, Any]
) -> dict[str, Any] | None:
    # roko serve says where an ended run's work is (gap-8409d0). An older one
    # does not, and then the plugin reads the branch itself when the workspace
    # is on this machine.
    work = reported_work(summary.get("result"))
    if work is None:
        if time.monotonic() - tracker.delivered_at > DELIVERED_TTL_S:
            tracker.delivered = delivered_work(workdir, run_id)
            tracker.delivered_at = time.monotonic()
        work = tracker.delivered
    if not work or not work.get("files_changed"):
        return None
    work = dict(work)
    branch = work["branch"]
    git = "git"
    if workdir is not None and str(workdir):
        work["workspace"] = str(workdir)
        git = f"git -C {shlex.quote(str(workdir))}"
    base = work.get("base")
    review = f"{git} diff {base}..{branch}" if base else f"{git} diff HEAD...{branch}"
    if work.get("source") == "roko":
        # roko leaves the command out once the checkout has the work or the run was promoted.
        command = work.pop("merge_command", None)
        merge = f"{git} {command.removeprefix('git ')}" if command else None
    else:
        merge = f"{git} merge {branch}"
    return {"delivered": work, "review_command": review, "merge_command": merge}


def _kind_from_plans(run_id: str, plan_ids: list[str]) -> str:
    # A prompt run is a one-task plan named after the run.
    if not plan_ids or plan_ids == [run_id]:
        return "run"
    return "plan"


def explain(cache: CardCache, url: str, card: dict[str, Any]) -> dict[str, Any]:
    """Why a run ended the way it did: gates that did not pass (with their output), blocks, errors."""
    tracker = cache.tracker(url, str(card.get("run_id")))
    with tracker.lock:
        rows = tracker.task_rows()
        not_passed: list[dict[str, Any]] = [
            {
                "task_id": task.task_id,
                "title": task.title,
                "gate": gate.gate,
                "runs": gate.runs,
                "output": gate.output[-WHY_CHARS:] if len(gate.output) > WHY_CHARS else gate.output,
            }
            for task in rows
            for gate in task.gates.values()
            if not gate.passed
        ]
        blocked = [
            {"task_id": task.task_id, "blocked_by": task.blocked_by, "reason": task.reason}
            for task in rows
            if task.outcome == "blocked"
        ]
        unverified = [task.task_id for task in rows if task.outcome == "unverified"]
        errors = list(tracker.fold.errors)
    parts: list[str] = []
    if card.get("state") == "cancelled":
        parts.append("The run was cancelled before it finished.")
    for gate in not_passed[:3]:
        again = f" after {gate['runs']} runs" if gate["runs"] > 1 else ""
        parts.append(f"Task {gate['task_id']}'s gate {gate['gate']} did not pass{again}.")
    for block in blocked[:3]:
        by = f" by {block['blocked_by']}" if block["blocked_by"] else ""
        reason = f": {block['reason']}" if block["reason"] else ""
        parts.append(f"Task {block['task_id']} was blocked{by}{reason}.")
    if unverified:
        names = ", ".join(unverified[:5])
        parts.append(
            f"No gate checked {names}, so the result is unverified: roko's workspace may have no "
            "checks for this kind of work."
        )
    if errors:
        parts.append(f"roko reported: {errors[-1]}")
    if not parts:
        parts.append(
            "Every gate that ran passed."
            if card.get("state") == "succeeded"
            else "roko recorded no gate that did not pass, no blocked task and no error; the "
            "milestones are all there is."
        )
    return {
        "summary": " ".join(parts),
        "gates_not_passed": not_passed[:10],
        "blocked": blocked[:10],
        "unverified_tasks": unverified[:20],
        "errors": errors,
    }


# -- formatting ---------------------------------------------------------------


def headline(card: dict[str, Any]) -> str:
    """The run in one line: state, gates, cost, time, where the work is."""
    state = str(card.get("state") or "unknown")
    parts = [state]
    if state == "queued" and card.get("position"):
        parts[0] = f"queued (position {card['position']})"
    if card.get("kind") == "plan_generate":
        if card.get("plan_id"):
            parts.append(f"plan {card['plan_id']}")
        if card.get("task_count"):
            parts.append(f"{card['task_count']} tasks")
        return " · ".join(parts)
    gates = card.get("gates") or {}
    if gates.get("total"):
        parts.append(f"gates {gates.get('passed', 0)}/{gates['total']}")
    elif state in TERMINAL_STATES and state != "cancelled":
        parts.append("no gate ran")
    counts = card.get("task_counts") or {}
    if (counts.get("total") or 0) > 1:
        parts.append(f"tasks {counts.get('passed', 0)}/{counts['total']}")
    cost, cap = card.get("cost_usd"), card.get("max_usd")
    if cost is not None or cap is not None:
        parts.append(fmt_money(cost) + (f" of {fmt_money(cap)}" if cap is not None else ""))
    duration = card.get("duration_ms") or card.get("elapsed_ms")
    if duration:
        parts.append(fmt_duration(int(duration)))
    waiting = card.get("waiting") or []
    if waiting:
        parts.append(f"{len(waiting)} waiting on you")
    delivered = card.get("delivered")
    if isinstance(delivered, dict) and delivered.get("branch"):
        branch = str(delivered["branch"])
        short = branch if len(branch) <= 24 else branch[:23] + "…"
        parts.append(f"branch {short} ({'merged' if delivered.get('merged') else 'not merged'})")
    return " · ".join(parts)


def fmt_money(value: Any) -> str:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return "—"
    if 0 < value < 0.01:
        return f"${value:.3f}"
    return f"${value:.2f}"


def fmt_duration(ms: int) -> str:
    seconds = max(0, round(ms / 1000))
    if seconds < 60:
        return f"{seconds}s"
    minutes, seconds = divmod(seconds, 60)
    if minutes < 60:
        return f"{minutes}m{seconds:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"


def now_iso() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _stamp(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = clean(value, 40, one_line=True)
    return text if _parse(text) is not None else None


def _parse(stamp: str | None) -> datetime | None:
    if not stamp:
        return None
    try:
        when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=UTC)


def _between(start: str | None, end: str | None) -> int | None:
    first, last = _parse(start), _parse(end)
    if first is None or last is None or last < first:
        return None
    return int((last - first).total_seconds() * 1000)


def _int(value: Any) -> int:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, float) and value == value:
        return int(value)
    if isinstance(value, str):
        try:
            return int(float(value))
        except ValueError:
            return 0
    return 0

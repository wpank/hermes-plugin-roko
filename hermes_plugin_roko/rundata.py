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

import json
import logging
import math
import re
import shlex
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, TypeGuard
from urllib.parse import quote

from . import loopevents
from .catalog import TERMINAL_STATES
from .client import RokoClient
from .decisions import name_items, pending_effects, pending_for_run
from .errors import Code, RokoError
from .sanitize import clean
from .workspace import delivered_work, reported_work

logger = logging.getLogger(__name__)

# The event kinds a card is built from. roko's run index takes at most 16
# types per request and a card needs more, so the whole index is read and
# the fold skips the rest (heartbeats and other noise).
FOLD_TYPES = frozenset(
    {
        "plan_set_loaded",
        "plan_started",
        "task_started",
        "agent_spawned",
        "agent_output",
        "agent_completed",
        "gate_rung_started",
        "gate_result",
        "efficiency_event",
        "task_completed",
        "task_blocked",
        "plan_completed",
        "run_completed",
        "critical_path_eta_updated",
        "error",
    }
    | loopevents.LOOP_TYPES
)
# loop_health is written at every plan close: its transitions are the news.
TIMELINE_TYPES = FOLD_TYPES - {
    "efficiency_event",
    "agent_completed",
    "critical_path_eta_updated",
    "loop_health",
}
# How each timeline line is grouped, for the UIs' icons and filters. Lines
# about roko's loops are `loop` and also carry their `ring` (L0..L4).
TIMELINE_GROUPS = {
    "plan_set_loaded": "run",
    "plan_started": "run",
    "plan_completed": "run",
    "run_completed": "run",
    "task_started": "task",
    "task_completed": "task",
    "task_blocked": "task",
    "agent_spawned": "agent",
    "agent_output": "agent",
    "gate_rung_started": "gate",
    "gate_result": "gate",
    "error": "error",
    **{kind: "loop" for kind in loopevents.LOOP_TYPES - {"agent_spawned", "task_started"}},
}
# roko writes an agent's messages as `\x1eroko.stream.v1 {json}` lines.
_STREAM_PREFIX = "\x1eroko.stream.v1 "
NOTE_CHARS = 1_200
_TASK_KINDS = frozenset(
    {
        "task_started",
        "agent_spawned",
        "agent_output",
        "gate_rung_started",
        "gate_result",
        "task_completed",
        "task_blocked",
    }
)
_PLAN_KINDS = frozenset({"plan_started", "plan_completed"})
# Rows whose timeline line is their loop event's words.
_LOOP_ONLY_KINDS = loopevents.LOOP_TYPES - {"agent_spawned", "task_started"}
PAGE_LIMIT = 200
# One refresh reads at most this many pages (40,000 rows); the next one goes on.
MAX_PAGES = 200
# roko limits each caller to 30 requests a second; a long index pages faster than that. A refresh
# waits as roko asks (at most this long, this many times) rather than stopping halfway.
RATE_WAITS = 3
RATE_WAIT_MAX_S = 2.0
MAX_TIMELINE = 400
MAX_TASKS = 200
MAX_ATTEMPTS = 12
MAX_STEPS = 8
MAX_LOOPS = 60
LIVE_TEXT_CHARS = 600
MAX_PLANS = 8
OUTPUT_CHARS = 2_000
EXCERPT_CHARS = 200
WHY_CHARS = 1_200
MAX_TRACKERS = 64
DELIVERED_TTL_S = 30.0
BUNDLE_RETRY_S = 10.0
# roko titles a chat-started run's one task "Request from chat host <name>";
# the card and the timeline use the run's own name instead.
GENERIC_TASK_TITLE = re.compile(r"^Request from chat host [\w.-]+\Z")
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
    # When the task started and ended (ms since the epoch, from each row's `ts_millis`).
    started_ms: int | None = None
    finished_ms: int | None = None
    # What the task is doing now ("agent", "check"), and since when.
    step: str | None = None
    step_detail: str | None = None
    step_since_ms: int | None = None
    # One entry per agent attempt: model, provider, when it started, and the route that picked it.
    attempt_log: list[dict[str, Any]] = field(default_factory=list)
    # The last thing the task's agent said, cleaned and clipped (its attempt's transcript).
    note: str | None = None
    # The agent's latest tool steps, newest last: {tool, target, ts}.
    steps: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=MAX_STEPS))
    step_ids: set[str] = field(default_factory=set)
    # What the agent is saying right now (roko's trusted live output), until its attempt ends.
    live_text: str | None = None
    # A route_decided that came before its attempt's agent_spawned: (attempt, route).
    pending_route: tuple[int, dict[str, Any]] | None = None
    # A sign-off the task waits on, or waited on: state, question, deadline, outcome.
    hold: dict[str, Any] | None = None
    # Calls the task's agent proposed that roko held for the person.
    effects: list[dict[str, Any]] = field(default_factory=list)
    # What the task taught roko's knowledge store.
    lessons: list[dict[str, Any]] = field(default_factory=list)


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
    # The first and newest event times seen, and roko's latest estimate of the minutes left.
    first_ms: int | None = None
    last_ms: int | None = None
    eta_minutes: float | None = None
    # The run's cybernetic events so far (loopevents.loop_events), oldest first.
    loops: deque[dict[str, Any]] = field(default_factory=lambda: deque(maxlen=MAX_LOOPS))
    loop_ctx: loopevents.LoopContext = field(default_factory=loopevents.LoopContext)
    # The adaptive gate thresholds roko last published (L3), most observed first.
    thresholds: list[dict[str, Any]] = field(default_factory=list)

    def feed(self, cursor: int, kind: str, event: dict[str, Any]) -> None:
        self.rows += 1
        at = _ms(event.get("ts_millis"))
        if at is not None:
            self.first_ms = at if self.first_ms is None else min(self.first_ms, at)
            self.last_ms = at if self.last_ms is None else max(self.last_ms, at)
        if kind == "critical_path_eta_updated":
            eta = event.get("eta_minutes")
            if (
                isinstance(eta, (int, float))
                and not isinstance(eta, bool)
                and math.isfinite(eta)
                and eta >= 0
            ):
                self.eta_minutes = float(eta)
            elif eta is None:
                self.eta_minutes = None
            return
        plan_id = clean(event.get("plan_id"), 120, one_line=True)
        if plan_id and _SYNTHETIC_PLAN.match(plan_id):
            return
        if kind not in FOLD_TYPES:
            return
        task_id = clean(event.get("task_id"), 80, one_line=True)
        task = self._task(plan_id, task_id) if plan_id and task_id else None
        if kind in loopevents.LOOP_TYPES:
            self.loops.extend(loopevents.loop_events(kind, event, self.loop_ctx))
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
            if task.started_ms is None:
                task.started_ms = at
            if task.outcome == "pending":
                task.outcome = "running"
            _step(task, "starting", None, at)
        elif kind == "agent_spawned" and task is not None:
            number = attempt_number(event, task.attempts)
            fresh = number > task.attempts or not task.attempt_log
            task.attempts = max(task.attempts, number)
            task.model = clean(event.get("model"), 80, one_line=True) or task.model
            task.provider = clean(event.get("provider"), 80, one_line=True) or task.provider
            task.role = clean(event.get("role"), 40, one_line=True) or task.role
            if task.started_ms is None:
                task.started_ms = at
            if task.outcome == "pending":
                task.outcome = "running"
            if not fresh:
                # Another agent for the same attempt: roko failed over to the next model.
                task.attempt_log[-1].update(model=task.model, provider=task.provider)
            elif len(task.attempt_log) < MAX_ATTEMPTS:
                entry = {
                    "attempt": task.attempts,
                    "model": task.model,
                    "provider": task.provider,
                    "started_ms": at,
                }
                if task.pending_route is not None and task.pending_route[0] in (task.attempts, 0):
                    entry["route"] = task.pending_route[1]
                task.pending_route = None
                task.attempt_log.append(entry)
            task.live_text = None
            _step(task, "agent", task.model, at)
        elif kind == "agent_output" and task is not None:
            self._agent_output(task, event, at)
        elif kind == "agent_completed" and task is not None:
            task.live_text = None
            if task.step == "agent":
                _step(task, "agent done", None, at)
        elif kind == "route_decided" and task is not None:
            route = route_of(event)
            number = route["attempt"] or task.attempts + 1
            if task.attempt_log and task.attempt_log[-1].get("attempt") == number:
                task.attempt_log[-1]["route"] = route  # failover within the attempt
            else:
                task.pending_route = (number, route)
        elif kind == "confirm_waiting" and task is not None:
            seconds = event.get("timeout_secs")
            task.hold = {
                "state": "waiting",
                "rung": clean(event.get("rung"), 80, one_line=True) or None,
                "question": clean(event.get("question"), 300) or None,
                "timeout_secs": int(seconds) if _is_number(seconds) else None,
                "deadline_at": clean(event.get("deadline_at"), 40, one_line=True) or None,
                "since": _iso_ms(at),
                "outcome": None,
            }
            _step(task, "waiting", "your sign-off", at)
        elif kind == "confirm_resolved" and task is not None:
            hold = dict(task.hold or {})
            hold.update(
                state="resolved",
                outcome=clean(event.get("outcome"), 40, one_line=True) or "answered",
                note=clean(event.get("note"), 300) or None,
            )
            task.hold = hold
            if task.step == "waiting":
                _step(task, "check", hold.get("rung"), at)
        elif kind == "effect_staged" and task is not None:
            if len(task.effects) < MAX_ATTEMPTS:
                task.effects.append(
                    {
                        "effect_id": clean(event.get("effect_id"), 120, one_line=True) or None,
                        "tool": clean(event.get("tool"), 80, one_line=True) or None,
                        "server": clean(event.get("server"), 80, one_line=True) or None,
                        "state": "held",
                        "outcome": None,
                        "since": _iso_ms(at),
                    }
                )
        elif kind == "effect_decided":
            ident = clean(event.get("effect_id"), 120, one_line=True)
            for held in self._effects():
                if held.get("effect_id") == ident:
                    held.update(
                        state="decided", outcome=clean(event.get("outcome"), 40, one_line=True) or None
                    )
        elif kind == "knowledge_written" and task is not None:
            if len(task.lessons) < 5:
                task.lessons.append(
                    {
                        "admission": clean(event.get("admission"), 40, one_line=True) or None,
                        "entry_id": clean(event.get("entry_id"), 120, one_line=True) or None,
                        "lesson": clean(event.get("lesson"), 160, one_line=True) or None,
                        "reinforced": _whole(event.get("reinforced")),
                        "promoted": _whole(event.get("promoted")),
                    }
                )
        elif kind == "gate_thresholds_updated":
            rungs = loopevents.threshold_rungs(event.get("snapshot_json"))
            if rungs:
                self.thresholds = rungs[:8]
        elif kind == "gate_rung_started" and task is not None:
            task.rung = clean(event.get("rung_name"), 120, one_line=True) or None
            _step(task, "check", task.rung, at)
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
            if task.attempt_log:
                verdicts = task.attempt_log[-1].setdefault("gates", [])
                if len(verdicts) < 20:
                    verdicts.append({"gate": name, "passed": bool(event.get("passed"))})
        elif kind == "efficiency_event":
            self._efficiency(event, task)
        elif kind == "task_completed" and task is not None:
            task.outcome = clean(event.get("outcome"), 40, one_line=True) or "unknown"
            task.rung = None
            task.finished_ms = at
            task.live_text = None
            _step(task, None, None, None)
        elif kind == "task_blocked" and task is not None:
            task.outcome = "blocked"
            task.blocked_by = clean(event.get("blocked_by"), 200, one_line=True) or None
            task.reason = clean(event.get("reason"), 400, one_line=True) or None
            task.finished_ms = at
            _step(task, None, None, None)
        elif kind == "run_completed":
            self.completed = {
                "outcome": clean(event.get("outcome"), 40, one_line=True) or None,
                "duration_ms": _int(event.get("duration_ms")) or None,
            }
        elif kind == "error":
            message = clean(event.get("message"), 400, one_line=True)
            if message:
                self.errors = [*self.errors[-9:], message]
        line = timeline_entry(cursor, kind, event, attempt_hint=task.attempts if task is not None else 0)
        if line is not None:
            self.timeline.append(line)

    def _agent_output(self, task: TaskView, event: dict[str, Any], at: int | None) -> None:
        """An agent's records: tool steps (live, or in its transcript), live words, and its transcript."""
        for record in loopevents.stream_records(event.get("content")):
            payload = loopevents.as_dict(record.get("payload"))
            kind = record.get("kind")
            if kind == "tool_start":
                ident = clean(payload.get("tool_id"), 80, one_line=True)
                target = clean(payload.get("target"), 200, one_line=True) or None
                if ident and ident in task.step_ids:
                    # The same call again (roko's trusted mode publishes it twice): keep one step, and
                    # take the target if the first record did not name it.
                    if target:
                        for step in reversed(task.steps):
                            if step.get("id") == ident and not step.get("target"):
                                step["target"] = target
                                break
                    continue
                if ident:
                    if len(task.step_ids) > 400:
                        task.step_ids.clear()
                    task.step_ids.add(ident)
                task.steps.append(
                    {
                        "tool": clean(payload.get("tool"), 60, one_line=True) or "tool",
                        "target": target,
                        "ts": at,
                        "id": ident or None,
                    }
                )
            elif kind in ("text", "reasoning") and record.get("live") is True:
                text = clean(payload.get("text"), LIVE_TEXT_CHARS)
                if text.strip():
                    joined = (task.live_text or "") + text
                    task.live_text = joined[-LIVE_TEXT_CHARS:]
        note = _stream_text(event.get("content"))
        if note:
            task.note = note

    def _effects(self) -> list[dict[str, Any]]:
        return [held for task in self.tasks.values() for held in task.effects]

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


def attempt_number(event: dict[str, Any], seen: int) -> int:
    """Which attempt an `agent_spawned` row starts, counting from 1.

    roko numbers attempts from 1 since bug-369c21; before that every attempt was 0, so a row
    without a number is the attempt after the last one seen.
    """
    number = _int(event.get("attempt"))
    return number if number > 0 else seen + 1


def _ms(value: Any) -> int | None:
    """A row's `ts_millis`, when it is a plausible time."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    return int(value) if value > 0 else None


def _step(task: TaskView, step: str | None, detail: str | None, at: int | None) -> None:
    task.step = step
    task.step_detail = detail
    task.step_since_ms = at if step else None


def _stream_text(content: Any) -> str | None:
    """The text an agent wrote, from roko's `\\x1eroko.stream.v1 {json}` lines."""
    if not isinstance(content, str) or not content:
        return None
    texts: list[str] = []
    for line in content.split("\n"):
        if not line.startswith(_STREAM_PREFIX):
            continue
        try:
            frame = json.loads(line[len(_STREAM_PREFIX) :])
        except ValueError:
            continue
        payload = frame.get("payload") if isinstance(frame, dict) else None
        if isinstance(frame, dict) and frame.get("live") is True:
            continue  # what the agent says as it works: live_text, not its transcript
        if isinstance(frame, dict) and frame.get("kind") == "text" and isinstance(payload, dict):
            text = payload.get("text")
            if isinstance(text, str) and text.strip():
                texts.append(text)
    if not texts and not content.startswith("\x1e"):
        texts.append(content)
    joined = clean("\n".join(texts).strip(), NOTE_CHARS)
    return joined or None


def retitle(entries: list[dict[str, Any]], name: str | None) -> list[dict[str, Any]]:
    """Timeline lines with roko's generic chat-task title replaced by the run's own name."""
    if not name:
        return entries
    out = []
    for entry in entries:
        text = str(entry.get("text") or "")
        prefix, sep, title = text.partition(" started: ")
        if entry.get("type") == "task_started" and sep and GENERIC_TASK_TITLE.match(title):
            entry = {**entry, "text": clean(f"{prefix} started: {name}", 400, one_line=True)}
        out.append(entry)
    return out


def timeline_entry(
    cursor: int, kind: str, event: dict[str, Any], *, attempt_hint: int = 0
) -> dict[str, Any] | None:
    """One event index row as a readable timeline line, or None for rows the timeline skips.

    Besides its `text`, a line carries what a UI needs to rebuild the run at that moment: `gate` on
    check lines, `model`, `provider` and `attempt` on agent lines, `outcome` and `passed` where they
    apply. `attempt_hint` is the attempt an older roko's unnumbered `agent_spawned` row starts.
    """
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
    entry: dict[str, Any] = {
        "cursor": cursor,
        "type": kind,
        "group": TIMELINE_GROUPS.get(kind, "run"),
        "task_id": task,
        "ts_millis": _ms(event.get("ts_millis")),
    }
    if kind in _LOOP_ONLY_KINDS:
        loops = loopevents.loop_events(kind, event, loopevents.LoopContext())
        if not loops:
            return None
        loop = loops[0]
        entry.update(ring=loop["ring"], loop=loop["kind"], key=loop["key"], text=loop["text"])
        entry["task_id"] = loop["task_id"]  # a diagnosis names its task in its subject
        if kind == "route_decided":
            entry.update(model=loop["data"].get("model"), attempt=loop["data"].get("attempt"))
        return entry
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
        number = _int(event.get("attempt"))
        attempt = number if number > 0 else max(1, attempt_hint)
        entry.update(model=model, provider=provider or None, attempt=attempt)
        text = f"{task} attempt {attempt} on {model}" + (f" ({provider})" if provider else "")
    elif kind == "agent_output":
        live = loopevents.live_record(event)
        if live is not None:
            if live["kind"] != "tool":
                return None  # live words stream to the pages; the transcript makes the line
            entry.update(group="tool", ring="L0", tool=live["tool"], target=live["target"])
            entry["attempt"] = live["attempt"]
            entry["text"] = clean(f"{task} {live['tool']} {live['target'] or ''}".strip(), 400, one_line=True)
            return entry
        note = _stream_text(event.get("content"))
        if not note:
            return None
        first = note.strip().splitlines()[0] if note.strip() else ""
        text = f"{task} agent: {clean(first, 160, one_line=True)}"
    elif kind == "gate_rung_started":
        entry["gate"] = clean(event.get("rung_name"), 120, one_line=True) or None
        text = f"{task} checking {entry['gate'] or 'a check'}"
    elif kind == "gate_result":
        passed = bool(event.get("passed"))
        entry["passed"] = passed
        gate = clean(event.get("gate"), 120, one_line=True)
        entry["gate"] = gate or None
        text = f"{task} gate {gate} {'passed' if passed else 'did not pass'}"
    elif kind == "task_completed":
        outcome = clean(event.get("outcome"), 40, one_line=True) or "ended"
        entry["outcome"] = outcome
        text = (
            f"{task} {outcome}" if outcome in ("passed", "skipped", "blocked") else f"{task} ended: {outcome}"
        )
    elif kind == "task_blocked":
        reason = clean(event.get("reason"), 200, one_line=True)
        entry["blocked_by"] = clean(event.get("blocked_by"), 200, one_line=True) or None
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
        waits = 0
        for _ in range(MAX_PAGES):
            params = {"cursor": self.fold.cursor, "limit": PAGE_LIMIT}
            try:
                page = client.get(path, params)
            except RokoError as exc:
                if exc.code is Code.RATE_LIMITED and waits < RATE_WAITS:
                    waits += 1
                    time.sleep(min(exc.retry_after_s or 1.0, RATE_WAIT_MAX_S))
                    continue
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
        return plan_generation_card(run_id, summary, logged)
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
        if logged and logged.get("label"):
            name_items(card["waiting"], {run_id: str(logged["label"])})
        if terminal:
            delivered = _delivered(tracker, workdir, run_id, summary)
            if delivered is not None:
                card.update(delivered)
    if terminal and state != "succeeded" and card.get("kind") != "plan_generate":
        card["why"] = explain(cache, client.settings.url, card)
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
                key: tracker.final.get(key)
                for key in ("state", "cost_usd", "finished_at", "events_read", "progress")
            }
        tracker.refresh_events(client)
        # Both read once per run (the bundle again only until it has a start time): the plan's task
        # list makes the progress count tasks that have not started yet.
        try:
            tracker.refresh_bundle(client, terminal)
            tracker.refresh_plan_tasks(client)
        except RokoError as exc:
            logger.debug("roko: no bundle for run %s yet: %s", run_id, exc)
        fold = tracker.fold
        settled = terminal and (tracker.has_index or tracker.index_missing)
        rows = tracker.task_rows()
        return {
            "state": state,
            "cost_usd": round(fold.cost_usd, 6) if fold.saw_cost else None,
            "finished_at": tracker.finished_at if terminal else None,
            "events_read": fold.rows if settled else None,
            "progress": progress([{"outcome": task.outcome} for task in rows]) if rows else None,
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
    name = clean(logged.get("label") or logged.get("request"), 160, one_line=True)
    for task in tasks:
        if name and GENERIC_TASK_TITLE.match(str(task.get("title") or "")):
            task["title"] = name
    multi_plan = len({task.plan_id for task in tracker.task_rows()}) > 1
    if not multi_plan:
        for task in tasks:
            task.pop("plan_id", None)
    card: dict[str, Any] = {
        "run_id": run_id,
        "kind": kind,
        "label": clean(logged.get("label") or plan_id or f"run {run_id[:8]}", 120, one_line=True),
        "request": logged.get("request"),
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
        "progress": progress(tasks),
        "graph": graph(tasks),
        "eta_minutes": fold.eta_minutes if state == "running" else None,
        "last_event_at": _iso_ms(fold.last_ms),
        "loops": card_loops(fold, tracker.task_rows()),
        "thresholds": list(fold.thresholds) or None,
        "gates": fold.gate_counts,
        "milestones": _milestones(summary, run_id),
        "errors": list(fold.errors),
        "origin": tracker.origin,
        "session_id": logged.get("session_id"),
        "source": logged.get("source"),
        "hermes_started_at": logged.get("started_at"),
        "resumed": tracker.invocations > 1,
        "events_read": fold.rows,
    }
    return card


def plan_generation_card(
    run_id: str, summary: dict[str, Any], logged: dict[str, Any] | None
) -> dict[str, Any]:
    logged = logged or {}
    result = loopevents.as_dict(summary.get("result"))
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
        "started_at": _iso_ms(task.started_ms),
        "finished_at": _iso_ms(task.finished_ms),
        "duration_ms": (task.finished_ms - task.started_ms)
        if task.started_ms is not None and task.finished_ms is not None
        else None,
        "step": task.step,
        "step_detail": task.step_detail,
        "step_since": _iso_ms(task.step_since_ms),
        "attempt_log": [
            {
                "attempt": entry.get("attempt"),
                "model": entry.get("model"),
                "provider": entry.get("provider"),
                "started_at": _iso_ms(entry.get("started_ms")),
                "gates": list(entry.get("gates") or []),
                "route": entry.get("route"),
            }
            for entry in task.attempt_log
        ],
        "note": task.note,
        "steps": [
            {"tool": step["tool"], "target": step["target"], "ts": _iso_ms(step.get("ts"))}
            for step in task.steps
        ],
        "live_text": task.live_text,
        "hold": dict(task.hold) if task.hold else None,
        "effects": [dict(held) for held in task.effects],
        "lessons": [dict(lesson) for lesson in task.lessons],
    }
    if task.blocked_by or task.reason:
        row["blocked_by"] = task.blocked_by
        row["reason"] = task.reason
    return row


def _task_counts(summary: dict[str, Any], tasks: list[dict[str, Any]]) -> dict[str, int]:
    counts = summary.get("tasks")
    if isinstance(counts, dict) and counts.get("total"):
        reported = {str(key): _int(value) for key, value in counts.items()}
        # roko counts the tasks that ended; a running plan knows all of its tasks (dogfood 2026-10-13).
        reported["total"] = max(reported.get("total", 0), len(tasks))
        return reported
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


_PASSED_OUTCOMES = frozenset({"passed", "already_satisfied"})
_FAILED_OUTCOMES = frozenset({"failed", "error", "crashed", "timeout", "timed_out", "rejected"})
_STOPPED_OUTCOMES = frozenset({"cancelled", "interrupted", "skipped"})


def card_loops(fold: EventFold, rows: list[TaskView]) -> list[dict[str, Any]]:
    """The run's loop events for its card: what the fold saw, plus each wave's opening, oldest first.

    Waves come from the plan's graph, which the fold does not know, so their openings are derived
    here from when each wave's first task started; the live relay emits the same events (same keys).
    """
    events = list(fold.loops)
    cards = [{"task_id": row.task_id, "plan_id": None, "depends_on": row.depends_on} for row in rows]
    waves = graph(cards)["waves"]
    started = {row.task_id: row.started_ms for row in rows if row.started_ms is not None}
    plan = rows[0].plan_id if rows else ""
    for index, wave in enumerate(waves):
        times = [started[node] for node in wave if node in started]
        if not times:
            continue
        text = f"wave {index + 1} open: {', '.join(wave[:6])}" + (" in parallel" if len(wave) > 1 else "")
        events.append(
            {
                "ring": "L2",
                "kind": "wave",
                "text": text,
                "data": {"wave": index + 1, "tasks": wave[:20]},
                "task_id": None,
                "plan_id": plan or None,
                "ts": min(times),
                "key": f"wave:{index}",
            }
        )
    events.sort(key=lambda event: event["ts"] if isinstance(event.get("ts"), int) else 0)
    return events[-MAX_LOOPS:]


def route_of(event: dict[str, Any]) -> dict[str, Any]:
    """A `route_decided` row as an attempt's `route`: the pick, who made it, and what it weighed."""
    candidates = loopevents.route_candidates(event.get("candidates"))
    model = clean(event.get("model"), 80, one_line=True) or None
    chosen = next((c for c in candidates if c["model"] == model), None)
    attempt = event.get("attempt")
    return {
        "attempt": int(attempt) if _is_number(attempt) and attempt > 0 else None,
        "model": model,
        "provider": clean(event.get("provider"), 60, one_line=True) or None,
        "source": clean(event.get("source"), 40, one_line=True) or None,
        "stage": clean(event.get("stage"), 60, one_line=True) or None,
        "reason": clean(event.get("reason"), 300, one_line=True) or None,
        "p": chosen["p"] if chosen else None,
        "candidates": candidates,
    }


def _whole(value: Any) -> int:
    return int(value) if _is_number(value) else 0


def _is_number(value: Any) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def progress(tasks: list[dict[str, Any]]) -> dict[str, int]:
    """How far the run's tasks got: every task counted once, by where it is now."""
    out = dict.fromkeys(
        ("total", "passed", "failed", "running", "pending", "blocked", "stopped", "unverified"), 0
    )
    for task in tasks:
        outcome = str(task.get("outcome") or "pending")
        out["total"] += 1
        if outcome in _PASSED_OUTCOMES:
            out["passed"] += 1
        elif outcome in _FAILED_OUTCOMES:
            out["failed"] += 1
        elif outcome == "running":
            out["running"] += 1
        elif outcome == "blocked":
            out["blocked"] += 1
        elif outcome in _STOPPED_OUTCOMES:
            out["stopped"] += 1
        elif outcome == "unverified":
            out["unverified"] += 1
        else:
            out["pending"] += 1
    return out


def graph(tasks: list[dict[str, Any]]) -> dict[str, Any]:
    """The run's tasks as waves (each depends only on earlier ones) and dependency edges, per plan."""
    order: list[str] = []
    deps: dict[str, list[str]] = {}
    for task in tasks:
        if task.get("task_id"):
            node = _node_id(task)
            order.append(node)
            deps[node] = [_node_id(task, dep) for dep in task.get("depends_on") or []]
    known = set(order)
    needs = {node: {dep for dep in deps[node] if dep in known} for node in order}
    done: set[str] = set()
    waves: list[list[str]] = []
    while len(done) < len(order) and len(waves) < MAX_TASKS:
        wave = [node for node in order if node not in done and needs[node] <= done]
        if not wave:  # a cycle: what is left is one last wave
            waves.append([node for node in order if node not in done])
            break
        waves.append(wave)
        done.update(wave)
    edges = [[dep, node] for node in order for dep in sorted(needs[node])]
    return {"waves": waves, "edges": edges}


def _node_id(task: dict[str, Any], task_id: Any = None) -> str:
    """A task's id in the graph: the task id, prefixed by its plan when the card names plans."""
    tid = str(task_id if task_id is not None else task.get("task_id"))
    return f"{task['plan_id']}/{tid}" if task.get("plan_id") else tid


def _iso_ms(value: Any) -> str | None:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        return None
    return datetime.fromtimestamp(value / 1000, UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


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
                "runs_not_passed": _runs_not_passed(task, gate.gate),
                "output": gate.output[-WHY_CHARS:] if len(gate.output) > WHY_CHARS else gate.output,
                "key_line": key_line(gate.output),
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
        outcomes = {task.task_id: task.outcome for task in rows}
        errors = list(tracker.fold.errors)
    task_errors = {
        match.group(1): match.group(2).strip().rstrip(".")
        for match in (_TASK_ERROR.match(error) for error in errors)
        if match
    }
    other_errors = [
        error for error in errors if not _TASK_ERROR.match(error) and not _ENGINE_TALLY.match(error)
    ]
    parts: list[str] = []
    if card.get("state") == "cancelled":
        parts.extend(_cancel_story(outcomes, task_errors))
    gated = {gate["task_id"] for gate in not_passed}
    for task_id, reason in list(task_errors.items())[:3]:
        if reason.startswith("cancelled") or (task_id in gated and reason.startswith("gate error")):
            continue  # told by the cancel story, or by the gate below with its output
        parts.append(f"{task_id} did not finish: {clean(reason, 300, one_line=True)}.")
    for gate in not_passed[:3]:
        runs = gate["runs"]
        if runs <= 1:
            how = ""
        elif gate["runs_not_passed"] >= runs:
            how = f", all {runs} times it ran"
        else:
            how = f" the last time it ran (it ran {runs} times)"
        line = f"{gate['task_id']}'s check {gate['gate']} did not pass{how}"
        parts.append(line + (f": {gate['key_line']}" if gate["key_line"] else "") + ".")
    by_blocker: dict[str, list[str]] = {}
    for block in blocked:
        by_blocker.setdefault(str(block["blocked_by"] or ""), []).append(str(block["task_id"]))
    for blocker, tasks in list(by_blocker.items())[:3]:
        verb = "was" if len(tasks) == 1 else "were"
        parts.append(
            f"{_join_names(tasks)} {verb} blocked"
            + (f" because {blocker} did not pass" if blocker else "")
            + "."
        )
    if unverified:
        parts.append(
            f"No gate checked {_join_names(unverified)}, so the result is unverified: roko's workspace may "
            "have no checks for this kind of work."
        )
    if other_errors:
        parts.append(f"roko reported: {other_errors[-1]}")
    elif errors and not parts:
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


def _runs_not_passed(task: TaskView, gate: str) -> int:
    """How many of a check's runs did not pass, from the task's attempt log."""
    return sum(
        1
        for attempt in task.attempt_log
        for verdict in attempt.get("gates") or []
        if verdict.get("gate") == gate and not verdict.get("passed")
    )


def _cancel_story(outcomes: dict[str, str], task_errors: dict[str, str]) -> list[str]:
    """What a cancelled run had done: what ran when it stopped, what passed, what never started."""
    stopped = [
        task_id
        for task_id, outcome in outcomes.items()
        if outcome in ("running", "cancelled", "interrupted")
        or (outcome in _FAILED_OUTCOMES and task_errors.get(task_id, "").startswith("cancelled"))
    ]
    passed = [task_id for task_id, outcome in outcomes.items() if outcome in _PASSED_OUTCOMES]
    never = [task_id for task_id, outcome in outcomes.items() if outcome in ("pending", "skipped")]
    story = ["The run was cancelled" + (f" while {_join_names(stopped)} ran." if stopped else ".")]
    if passed:
        story.append(f"{_join_names(passed)} had passed" + (" before that." if stopped else "."))
    if never:
        story.append(f"{_join_names(never)} never started.")
    return story


# Lines that most often say why a check failed, in the order they are looked for.
_KEY_LINE = re.compile(
    r"(error\b|error:|not found|no such file|failed|failure|assert|traceback|exception|panicked|denied|"
    r"timed out|exit code)",
    re.IGNORECASE,
)


def key_line(output: str) -> str | None:
    """The line of a check's output most likely to say why it failed."""
    lines = [line.strip() for line in output.splitlines() if line.strip() and line.strip() != "…"]
    if not lines:
        return None
    body = lines[1:] if len(lines) > 1 and lines[0].startswith("$") else lines
    hits = [line for line in body if _KEY_LINE.search(line) and not line.startswith("---")]
    # The last error-looking line names the cause more often than the first (a summary follows a trace).
    chosen = hits[-1] if hits else body[-1]
    return clean(chosen, 200, one_line=True) or None


_TASK_ERROR = re.compile(r"^plan '[^']*': task '([^']+)' failed: (.+)$", re.S)
# roko's closing tally ("Graph Engine: 1 plan(s), 0 succeeded, 1 failed") adds nothing to a reason.
_ENGINE_TALLY = re.compile(r"^Graph Engine: \d+ plan\(s\)")


def _join_names(names: list[str]) -> str:
    shown = names[:5]
    more = len(names) - len(shown)
    if more:
        return ", ".join(shown) + f" and {more} more"
    if len(shown) == 1:
        return shown[0]
    return ", ".join(shown[:-1]) + " and " + shown[-1]


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
            count = int(card["task_count"])
            parts.append(f"{count} task{'s' if count != 1 else ''}")
        return " · ".join(parts)
    gates = card.get("gates") or {}
    if gates.get("total"):
        parts.append(f"gates {gates.get('passed', 0)}/{gates['total']}")
    elif state in TERMINAL_STATES and state != "cancelled":
        parts.append("no gate ran")
    counts = card.get("progress") or card.get("task_counts") or {}
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

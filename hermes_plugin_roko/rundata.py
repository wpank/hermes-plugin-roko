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
import tomllib
from collections import OrderedDict, deque
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, TypeGuard
from urllib.parse import quote

from . import loopevents, runwork
from .catalog import TERMINAL_STATES
from .client import RokoClient
from .decisions import name_items, pending_effects, pending_for_run
from .errors import Code, RokoError
from .sanitize import clean
from .workspace import BATCH_PREFIX, delivered_work, reported_work

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
        "check_started",
        "check_finished",
        # A plan's whole-plan check, step by step (roko gap-6b6ec1).
        "plan_check_started",
        "plan_check_heartbeat",
        "plan_check_finished",
        # A plan's delivery into the run's batch branch: its start and how it ended (roko gap-4f6cbe).
        "delivery_started",
        "delivery_finished",
    }
    | loopevents.LOOP_TYPES
)
# loop_health is written at every plan close: its transitions are the news.
TIMELINE_TYPES = FOLD_TYPES - {
    "efficiency_event",
    "agent_completed",
    "critical_path_eta_updated",
    "loop_health",
    "plan_check_heartbeat",
}
# roko's names for a whole-plan check's events (gap-6b6ec1), and the plugin's for the same.
PLAN_CHECK = {"plan_check_started": "check_started", "plan_check_finished": "check_finished"}
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
    "check_started": "gate",
    "check_finished": "gate",
    "plan_check_started": "gate",
    "plan_check_finished": "gate",
    "delivery_started": "run",
    "delivery_finished": "run",
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
_PLAN_KINDS = frozenset({"plan_started", "plan_completed", "delivery_started", "delivery_finished"})
# How a plan's delivery ended (roko gap-4f6cbe `delivery_finished` `state`), in words.
DELIVERY_ENDS = {
    "conflict": "its merge into {target} conflicted",
    "regression_failed": "the check on its merge failed",
}
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
# The checkout's state for Merge changes when the person commits; it is read again this often.
MERGE_TTL_S = 5.0
BUNDLE_RETRY_S = 10.0
# roko serve's start time (`GET /health` uptime) and its plan list are read again this often.
SERVE_TTL_S = 15.0
PLANS_TTL_S = 60.0
# A run whose last invocation began this long before roko serve started is not run by that serve.
INTERRUPT_SLACK_S = 2.0
MAX_REFUSALS = 5
# A run's name, when it was given none: the first sentence of the request, at most this long.
SHORT_TITLE_CHARS = 60
# Why a run ended when its roko serve stopped under it, for an older roko (roko says it since bug-dceafd).
INTERRUPTED_REASON = (
    "roko serve stopped while this run was going (a restart or a crash), so nothing runs it any more"
)
# roko refuses to start a plan after it gave out the run's id (another plan runner holds the workspace,
# say) with this error: unscoped on its hub (roko bug-9a5970 asks for the run's id on it), and as the
# `error` of the run's plan status.
_START_FAILED = re.compile(r"^plan execution failed for (?P<plan>\S+?): (?P<why>.+)$", re.S)
# roko's way past a checkout an earlier run left (bug-e998be): "move it aside with its branch, which keeps
# its work: git -C <repo> worktree move <checkout> <aside> && git -C <repo> branch -m <branch> <kept>". The
# error that says it is longer than an error line keeps, so the command is kept whole, and only in exactly
# that shape: each word plain or single-quoted, as roko quotes them.
_SHELL_WORD = r"(?:[A-Za-z0-9/._+:@%,=-]+|'(?:[^']|'\\'')*')"
MOVE_ASIDE = re.compile(
    rf"git -C {_SHELL_WORD} worktree move {_SHELL_WORD} {_SHELL_WORD} && "
    rf"git -C {_SHELL_WORD} branch -m {_SHELL_WORD} {_SHELL_WORD}"
)
# roko refuses to run a plan its validator rejects: "plan 'x' failed validation with 1 error(s); fix them
# before running it", or, for a run that waited in the queue, "its plans failed validation with 1 error(s)
# while it was queued". Its validator says why (`plan_validation`).
FAILED_VALIDATION = re.compile(r"failed validation with \d+ error", re.I)
MAX_PLAN_ERRORS = 10
MAX_OPEN_QUESTIONS = 20
_TASK_NAMED = re.compile(r"task '([^']+)'")
# Since roko bug-7a08a8 a refusal and a failed plan generation list why after the count, one "- RULE message"
# line per error (a refusal writes "RULE: message"), each error's later lines indented under it: PLAN_045's
# questions as "  - question". A plan generation names the plan it wrote anyway:
# "plan generation failed for <slug>: the plan was written to plans/<slug>, but it cannot run: 1 error(s)".
_ERROR_LINE = re.compile(r"- (?:(?P<rule>[A-Z]+_[A-Z0-9_]+):? )?(?P<message>.+)")
# The error roko adds to a run its spec gate refused, after the gate's own entries (bug-9a5970).
SPEC_GATE_ERROR = "the spec gate refused the plan before any agent ran:"
# What writing a plan cost, at the end of a failed plan generation that wrote it anyway (roko bug-a0432b).
_WRITING_COST = re.compile(r"Writing the plan cost \$(\d+(?:\.\d+)?)\.")
WRITTEN_BUT_INVALID = re.compile(
    r"plan generation failed for (?P<plan>[^\s:]+): the plan was written to \S+, but it cannot run"
)
# roko checks a plan in a copy in a temporary folder, and its words can name that copy's path.
_TEMP_COPY = re.compile(r"\S*/\.tmp[A-Za-z0-9]{6,}/[^\s/]+")
# roko stops a run at its cap (bug-4fabd0, in graph_task_dispatch/budget.rs): before an attempt's next model
# call when what is left cannot pay for it ("plan budget exhausted: the attempt's next model call would cost
# about $X, as much as its last, and only $Y of the plan's $Z cap is left", the task's error), and before a
# task when the cap is spent or less is left than an attempt needs ("plan budget exhausted: $A spent of $B,
# and the $C left is less than an attempt needs: $D, …", why it did not start). Since gap-e14344 a capped
# Claude CLI attempt also stops at the CLI's own limit, the attempt's share: "Budget exhausted: the Claude CLI
# stopped at its spend limit (--max-budget-usd $X) after $Y". A stop, not a failure: what passed is kept.
# Matched in any case, as roko words both.
_CAP_STOP = re.compile(r"\b(?:plan )?budget exhausted: ", re.I)
_CALL_OVER_CAP = re.compile(
    r"next model call would cost about \$(?P<call>\d+(?:\.\d+)?), as much as its last, and only "
    r"\$(?P<left>\d+(?:\.\d+)?) of the plan's \$(?P<cap>\d+(?:\.\d+)?) cap is left",
    re.I,
)
_CAP_SPENT = re.compile(
    r"\$(?P<spent>\d+(?:\.\d+)?) spent of \$(?P<cap>\d+(?:\.\d+)?)"
    r"(?:, and the \$(?P<left>\d+(?:\.\d+)?) left is less than an attempt needs: "
    r"\$(?P<needs>\d+(?:\.\d+)?))?",
    re.I,
)
_AGENT_LIMIT = re.compile(
    r"stopped at its spend limit \(--max-budget-usd \$(?P<limit>\d+(?:\.\d+)?)\)"
    r"(?: after \$(?P<spent>\d+(?:\.\d+)?))?",
    re.I,
)
# roko's daily limit (budget.max_daily_usd, also in budget.rs): why a task did not start ("daily budget
# exhausted: $X spent today (UTC) of budget.max_daily_usd = $Y"), or an attempt's refusal as its
# BudgetExceeded error ("budget exceeded: daily spend in micro-USD (budget.max_daily_usd) (used N, limit
# M)", in micro-dollars). Also a stop.
_DAY_SPENT = re.compile(
    r"daily budget exhausted: \$(?P<spent>\d+(?:\.\d+)?) spent today \(UTC\) of budget\.max_daily_usd = "
    r"\$(?P<cap>\d+(?:\.\d+)?)",
    re.I,
)
_DAY_EXCEEDED = re.compile(
    r"budget exceeded: daily spend in micro-USD \(budget\.max_daily_usd\) \(used (?P<used>\d{1,20}), limit "
    r"(?P<limit>\d{1,20})\)",
    re.I,
)
# A tool loop's own daily budget (roko-agent's BudgetTracker): "budget exhausted: daily $X / $Y (lifetime
# $Z)", a budget stop since gap-e14344, not a provider failure.
_DAY_TRACKER = re.compile(
    r"budget exhausted: daily \$(?P<spent>\d+(?:\.\d+)?) / \$(?P<cap>\d+(?:\.\d+)?)", re.I
)
# A cap roko cannot count because a call had no price: the run's ("plan budget cannot be enforced: 1 unpriced
# call(s) against max_plan_usd = $Z; …", or "…: a model call of this attempt has no price against
# max_plan_usd = $Z; …") or the day's ("budget.max_daily_usd = $Y cannot be enforced: today's spend (UTC)
# includes …").
_UNENFORCED = re.compile(
    r"(?:plan budget|budget\.max_daily_usd = \$(?P<day>\d+(?:\.\d+)?)) cannot be enforced"
    r"(?:: [^;]*?max_plan_usd = \$(?P<cap>\d+(?:\.\d+)?))?"
)
# A capped run passes over every model roko has no price for (roko gap-8548e3); with none left, the task's
# error names them: "no usable provider for this task: `<model>` on `<provider>`: has no price, and a budget
# cap can count only priced calls. Give <model> a price: …".
_UNPRICED = re.compile(
    r"`(?P<model>[^`\n]{1,120})` on `[^`\n]{1,80}`: "
    r"has no price, and a budget cap can count only priced calls"
)
# Where the plugin's docs say how to give a model its price: readiness.DOCS[NO_PRICE] (readiness imports this
# module, so the anchor is here too; a test keeps the two the same).
NO_PRICE_DOCS = "using-roko.md#roko-has-no-priced-model-for-runs-from-hermes"
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
    # roko stopped it at the run's cap (`cap_stop`): its attempt before a model call, or before it started.
    cap_stop: dict[str, Any] | None = None

    def _checked_attempt(self) -> int | None:
        """The latest attempt that ran checks: an attempt that ended before its checks (its agent failed, or
        changed nothing) leaves the verdicts of the one before standing. None without such an attempt."""
        for index in range(len(self.attempt_log) - 1, -1, -1):
            if self.attempt_log[index].get("gates"):
                return index
        return None

    def final_checks(self) -> dict[str, bool]:
        """The task's checks as its final checked attempt left them (by check, its last verdict). Without
        attempt rows that ran checks (an older roko), each check's latest verdict."""
        final = self._checked_attempt()
        if final is None:
            return {name: gate.passed for name, gate in self.gates.items()}
        return {
            str(verdict.get("gate")): bool(verdict.get("passed"))
            for verdict in self.attempt_log[final].get("gates") or []
        }

    def retried_checks(self) -> int:
        """How many check runs of the attempts before the final checked one did not pass: roko tried the
        task again."""
        final = self._checked_attempt()
        return sum(
            1
            for entry in self.attempt_log[: final or 0]
            for verdict in entry.get("gates") or []
            if not verdict.get("passed")
        )

    def superseded(self, gate: str) -> bool:
        """Whether check `gate`'s verdict is from an earlier attempt: the final checked attempt ran checks,
        but not this one."""
        final = self.final_checks() if self._checked_attempt() is not None else {}
        return bool(final) and gate not in final


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
    # What roko's spec gate refused before any agent ran ("T1: HF3: verify passes on the unchanged base").
    refusals: list[str] = field(default_factory=list)
    # roko's command that moves a leftover checkout aside (MOVE_ASIDE), when an error gave one.
    move_aside: str | None = None
    # Why roko did not start the run, when its own events say so (roko bug-9a5970 writes the error there).
    start_error: str | None = None
    # Each plan's delivery into the run's batch branch, by delivery id (roko gap-4f6cbe).
    deliveries: dict[str, dict[str, Any]] = field(default_factory=dict)
    # A check of the whole plan or workspace that is running now (not one task's), and how those ended.
    plan_check: dict[str, Any] | None = None
    plan_checks: list[dict[str, Any]] = field(default_factory=list)

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
        # A log entry names no task row: the spec gate names its plan by the tasks.toml path.
        task = self._task(plan_id, task_id) if plan_id and task_id and kind != "event_log_entry" else None
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
        elif kind in ("delivery_started", "delivery_finished") and plan_id:
            self._delivery(kind, event, plan_id)
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
        elif kind == "event_log_entry":
            self._log_entry(event)
        elif kind in ("check_started", "check_finished"):
            self._check(kind, event, task, plan_id, at)
        elif kind in PLAN_CHECK:
            self._check(PLAN_CHECK[kind], plan_check_view(event), None, plan_id, at)
        elif kind == "plan_check_heartbeat" and self.plan_check is not None:
            elapsed = event.get("elapsed_ms")
            if _is_number(elapsed) and at is not None:
                self.plan_check["since_ms"] = at - int(elapsed)
        elif kind == "gate_rung_started" and task is None and plan_id:
            # A check of the plan's whole work, not one task's.
            self._check("check_started", {"what": event.get("rung_name")}, None, plan_id, at)
        elif kind == "gate_result" and task is None and plan_id:
            gate = {
                "what": event.get("gate"),
                "passed": event.get("passed"),
                "output": event.get("output_text"),
            }
            self._check("check_finished", gate, None, plan_id, at)
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
            stop = cap_stop(event.get("reason")) if task.blocked_by is None else None
            if stop is not None:  # it did not start: the run reached its cap (roko bug-4fabd0)
                task.outcome = "stopped"
                task.cap_stop = {"when": "start", **stop}
                task.reason = cap_reason(task.cap_stop)
        elif kind == "run_completed":
            self.completed = {
                "outcome": clean(event.get("outcome"), 40, one_line=True) or None,
                "duration_ms": _int(event.get("duration_ms")) or None,
            }
            reason = clean(event.get("reason"), 300, one_line=True)
            if reason:  # an interrupted run's (bug-dceafd)
                self.completed["reason"] = reason
            self.plan_check = None
        elif kind == "error":
            message = clean(event.get("message"), 400, one_line=True)
            # After a task got going, roko's "plan execution failed" is how the run ended (a conductor stop).
            started = start_failure(event.get("message")) if not self.tasks else None
            if started is not None:  # why roko did not start it, without its advice to kill the other runner
                self.start_error = self.start_error or started[1] or None
            elif message.startswith(SPEC_GATE_ERROR) and self.refusals:
                pass  # it repeats what the spec gate refused (bug-9a5970)
            elif message:
                self.errors = [*self.errors[-9:], message]
                self._stopped_at_cap(clean(event.get("message"), 1_000, one_line=True))
            found = MOVE_ASIDE.search(clean(event.get("message"), 4_000))
            if found:
                self.move_aside = found.group(0)
        line = timeline_entry(cursor, kind, event, attempt_hint=task.attempts if task is not None else 0)
        tally = kind == "error" and _ENGINE_TALLY.match(clean(event.get("message"), 200, one_line=True))
        if tally and any(row.cap_stop for row in self.tasks.values()):
            line = None  # its "N failed" counts what the cap stopped, which the lines above say
        if line is not None:
            if kind in ("plan_completed", "run_completed"):
                self._ended_at_cap(line, plan_id)
            self.timeline.append(line)

    def _stopped_at_cap(self, message: str) -> None:
        """A task's error that says roko stopped its attempt at the run's cap (bug-4fabd0): the task reads
        stopped, not failed, and so does the line that said it ended (roko says why only after that)."""
        found = _TASK_ERROR.match(message)
        stop = cap_stop(found["reason"]) if found else None
        if found is None or stop is None:
            return
        task = self.tasks.get((found["plan"], found["task"]))
        if task is None:  # a prompt run's error may name roko serve's wrapper plan
            same = [task for task in self.tasks.values() if task.task_id == found["task"]]
            task = same[0] if len(same) == 1 else None
        if task is None:
            return
        # Inside its attempt (before a model call, or at its agent's own limit); else roko refused the attempt
        # itself: another one, or its first.
        when = "call" if stop.get("inside") else "attempt" if task.attempts else "start"
        task.outcome = "stopped"
        task.cap_stop = {"when": when, **stop}
        task.reason = cap_reason(task.cap_stop)
        for line in reversed(self.timeline):
            if line.get("type") == "task_completed" and line.get("task_id") == task.task_id:
                line.update(outcome="stopped", text=f"{task.task_id} stopped")
                break

    def _ended_at_cap(self, line: dict[str, Any], plan_id: str) -> None:
        """A plan, or the run, that ended without success because roko stopped it at its cap reads stopped."""
        stops = [task.cap_stop for task in self.tasks.values() if task.cap_stop]
        stopped = {task.plan_id for task in self.tasks.values() if task.cap_stop}
        at = "roko's daily limit" if any(stop.get("limit") == "day" for stop in stops) else "its cap"
        ended = self.completed or {}
        if line["type"] == "plan_completed" and plan_id in stopped and line.get("passed") is False:
            line.update(passed=None, outcome="stopped", text=f"plan {plan_id} stopped at {at}")
        elif line["type"] == "run_completed" and stopped and ended.get("outcome") == "failed":
            duration = ended.get("duration_ms")
            line["text"] = f"run stopped at {at}" + (f" after {fmt_duration(duration)}" if duration else "")

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
                # Keep a chunk that is only a space: roko streams words a token at a time, and the space
                # between two words can come on its own.
                text = clean(payload.get("text"), LIVE_TEXT_CHARS)
                if text:
                    joined = (task.live_text or "") + text
                    task.live_text = joined[-LIVE_TEXT_CHARS:]
        note = _stream_text(event.get("content"))
        if note:
            task.note = note

    def _effects(self) -> list[dict[str, Any]]:
        return [held for task in self.tasks.values() for held in task.effects]

    def _delivery(self, kind: str, event: dict[str, Any], plan_id: str) -> None:
        """A plan's delivery starting or ending: where it goes, and how it ended (roko gap-4f6cbe)."""
        ident = clean(event.get("delivery_id"), 160, one_line=True) or plan_id
        if ident not in self.deliveries and len(self.deliveries) >= MAX_PLANS * 2:
            return
        entry = self.deliveries.setdefault(
            ident, {"plan_id": plan_id, "partial": ident.endswith(":partial"), "state": "delivering"}
        )
        entry["target"] = clean(event.get("target"), 200, one_line=True) or entry.get("target")
        if kind == "delivery_finished":
            entry["state"] = clean(event.get("state"), 40, one_line=True) or "ended"
            entry["reason"] = clean(event.get("reason"), 300, one_line=True) or None
            stopped_by = clean(event.get("stopped_by"), 40, one_line=True)
            entry["stopped"] = (STOPPED_BY.get(stopped_by, stopped_by) or None) if stopped_by else None

    def _log_entry(self, event: dict[str, Any]) -> None:
        """roko's log lines that matter for why a run ended: what the spec gate refused."""
        if str(event.get("event_type") or "") != "spec.gate.refused":
            return
        message = clean(event.get("message"), 300, one_line=True)
        who = clean(event.get("task_id"), 80, one_line=True)
        text = f"{who}: {message}" if who and message else message
        if text and text not in self.refusals and len(self.refusals) < MAX_REFUSALS:
            self.refusals.append(text)

    def _check(
        self, kind: str, event: dict[str, Any], task: TaskView | None, plan_id: str, at: int | None
    ) -> None:
        """A check starting or ending: a task's (its step), or the plan's or workspace's (`plan_check`)."""
        what = (
            clean(
                event.get("what") or event.get("command") or event.get("label") or event.get("gate"),
                300,
                one_line=True,
            )
            or "a check"
        )
        label = clean(event.get("label"), 60, one_line=True) or check_label(what)
        scope = clean(event.get("scope"), 20, one_line=True) or ("task" if task is not None else "plan")
        if kind == "check_started":
            if task is not None:
                task.rung = what
                _step(task, "check", what, at)
            else:
                self.plan_check = {
                    "what": what,
                    "label": label,
                    "scope": scope,
                    "plan_id": plan_id or None,
                    "since_ms": at,
                    "packages": event.get("packages") or None,
                    "step": event.get("step"),
                    "steps": event.get("steps"),
                }
            return
        if task is not None:
            task.rung = None
            return
        self.plan_check = None
        passed = event.get("passed")
        if len(self.plan_checks) < MAX_ATTEMPTS:
            self.plan_checks.append(
                {
                    "what": what,
                    "label": label,
                    "scope": scope,
                    "passed": passed if isinstance(passed, bool) else None,
                    "duration_ms": _int(event.get("duration_ms")) or None,
                    "output": clean(event.get("output") or event.get("output_tail"), OUTPUT_CHARS) or None,
                    "exit_code": event.get("exit_code") if _is_number(event.get("exit_code")) else None,
                    "reason": clean(event.get("reason"), 300, one_line=True) or None,
                    # What stopped it before it ended (a cancel), when something did: it did not fail.
                    "stopped": stopped_cause(event) or None,
                }
            )

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
        """Each task's checks as its final attempt left them, and `retried`: the check runs of earlier
        attempts that did not pass. A check that failed once and passed on the retry is not a failure of the
        run."""
        verdicts = [passed for task in self.tasks.values() for passed in task.final_checks().values()]
        passed = sum(verdicts)
        retried = sum(task.retried_checks() for task in self.tasks.values())
        return {
            "passed": passed,
            "failed": len(verdicts) - passed,
            "total": len(verdicts),
            "retried": retried,
        }


def row_kind(row: dict[str, Any]) -> str:
    """An index row's event type, without the `dashboard.` some of roko's logs put before it."""
    event = row.get("event")
    kind = str(row.get("type") or (event.get("type") if isinstance(event, dict) else "") or "")
    return kind.removeprefix("dashboard.")


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
    plan_check = kind in ("gate_rung_started", "gate_result") and task is None and bool(plan)
    if (kind in _TASK_KINDS and task is None and not plan_check) or (kind in _PLAN_KINDS and not plan):
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
    if kind == "event_log_entry" and str(event.get("event_type") or "") == "spec.gate.refused":
        message = clean(event.get("message"), 300, one_line=True)
        entry.update(group="error", plan_id=None)
        entry["text"] = clean(f"{task or 'a task'} was refused before it ran: {message}", 400, one_line=True)
        return entry
    if kind in PLAN_CHECK:
        return _check_line(entry, PLAN_CHECK[kind], plan_check_view(event), None)
    if plan_check or kind in ("check_started", "check_finished"):
        return _check_line(entry, kind, event, task)
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
        if outcome in OUTCOME_WORDS:  # roko's own word, as the card says it
            entry["outcome"], words = OUTCOME_WORDS[outcome]
            text = f"{task} {words}"
    elif kind == "task_blocked":
        reason = clean(event.get("reason"), 200, one_line=True)
        entry["blocked_by"] = clean(event.get("blocked_by"), 200, one_line=True) or None
        stop = cap_stop(event.get("reason")) if entry["blocked_by"] is None else None
        if stop is not None:  # roko bug-4fabd0: not blocked; the run's cap (or the day's) stopped it first
            entry["outcome"] = "stopped"
            text = stop_line(task, stop, started=False)
        else:
            text = f"{task} blocked" + (f": {reason}" if reason else "")
    elif kind == "plan_completed":
        success = bool(event.get("success"))
        entry["passed"] = success
        text = f"plan {plan} finished" if success else f"plan {plan} ended without success"
    elif kind in ("delivery_started", "delivery_finished"):
        text = _delivery_line(entry, kind, event, plan, own_plan)
    elif kind == "run_completed":
        outcome = clean(event.get("outcome"), 40, one_line=True) or "ended"
        duration = _int(event.get("duration_ms"))
        text = f"run {outcome}" + (f" in {fmt_duration(duration)}" if duration else "")
        reason = clean(event.get("reason"), 200, one_line=True)
        if outcome in ("interrupted", "refused") and reason:  # bug-dceafd; bug-9a5970
            text += f": {reason}"
    else:  # error
        started = start_failure(event.get("message"))
        failed = _TASK_ERROR.match(clean(event.get("message"), 1_000, one_line=True))
        stop = cap_stop(failed["reason"]) if failed else None
        if started is not None:
            # roko's words without its advice to kill the other runner; a run that began fails in them too
            text = f"error: plan execution failed for {started[0]}: {started[1]}"
        elif failed is not None and stop is not None:  # roko stopped it at the run's cap (bug-4fabd0)
            entry.update(group="task", task_id=clean(failed["task"], 80, one_line=True), outcome="stopped")
            text = stop_line(entry["task_id"], stop, started=True)
        else:
            text = "error: " + clean(event.get("message"), 300, one_line=True)
    entry["text"] = clean(text, 400, one_line=True)
    return entry


def _delivery_line(entry: dict[str, Any], kind: str, event: dict[str, Any], plan: str, own_plan: bool) -> str:
    """A plan's delivery into the run's batch branch, starting or ending, as a line (roko gap-4f6cbe)."""
    target = clean(event.get("target"), 200, one_line=True) or "the run's batch branch"
    whose = "the run's work" if own_plan else f"plan {plan}"
    if str(event.get("delivery_id") or "").endswith(":partial"):
        whose = f"the passed part of {whose}"
    if kind == "delivery_started":
        return f"delivering {whose} into {target}"
    state = clean(event.get("state"), 40, one_line=True)
    entry["delivery"] = state or None
    if state == "delivered":
        entry["passed"] = True
        return f"{whose} delivered into {target}"
    if state == "cancelled":  # a stop cut its check short: it did not fail (roko 2359ba4ec)
        label = clean(event.get("stopped_by"), 40, one_line=True)
        return f"{whose}: its delivery was stopped" + (f" by {STOPPED_BY.get(label, label)}" if label else "")
    entry.update(group="error", passed=False)
    words = DELIVERY_ENDS.get(state, "").format(target=target) or clean(
        event.get("reason"), 200, one_line=True
    )
    return f"{whose} was not delivered" + (f": {words}" if words else "")


def plan_check_view(event: dict[str, Any]) -> dict[str, Any]:
    """roko's whole-plan check event (gap-6b6ec1) in the words of the plugin's checks: `what` the command,
    `label` its short name, `scope` workspace or plan (roko's `packages` and `command` scopes), the packages,
    the step, and how it ended."""
    scope = clean(event.get("scope"), 20, one_line=True)
    packages = [
        clean(name, 80, one_line=True) for name in event.get("packages") or [] if isinstance(name, str)
    ]
    elapsed = event.get("elapsed_ms")
    return {
        "what": event.get("command") or event.get("name"),
        "label": event.get("name"),
        "scope": "workspace" if scope == "workspace" else "plan",
        "packages": packages[:10] or None,
        "step": event.get("step") if _is_number(event.get("step")) else None,
        "steps": event.get("steps") if _is_number(event.get("steps")) else None,
        "passed": event.get("passed"),
        "duration_ms": int(elapsed) if _is_number(elapsed) else None,
        "exit_code": event.get("exit_code"),
        "reason": event.get("reason"),
        "stopped_by": event.get("stopped_by"),
    }


def _check_line(entry: dict[str, Any], kind: str, event: dict[str, Any], task: str | None) -> dict[str, Any]:
    """A check's start or end as a line: a task's (roko's `check_*` events) or the whole plan's."""
    what = (
        clean(
            event.get("what")
            or event.get("command")
            or event.get("label")
            or event.get("rung_name")
            or event.get("gate"),
            200,
            one_line=True,
        )
        or "a check"
    )
    label = clean(event.get("label"), 60, one_line=True) or check_label(what)
    scope = clean(event.get("scope"), 20, one_line=True) or ("task" if task else "plan")
    packages = [str(name) for name in event.get("packages") or []]
    where = task or (
        "the workspace" if scope == "workspace" else ", ".join(packages[:3]) if packages else "the plan"
    )
    entry.update(group="gate", gate=what, scope=scope)
    step, steps = event.get("step"), event.get("steps")
    of = f" (step {step} of {steps})" if _is_number(step) and _is_number(steps) and steps > 1 else ""
    if kind in ("check_started", "gate_rung_started"):
        entry["text"] = clean(f"checking {where}: {label}{of}", 400, one_line=True)
        return entry
    passed = event.get("passed")
    duration = _int(event.get("duration_ms"))
    stopped = stopped_cause(event)
    if passed is not True and stopped:
        # A stop request ended it (roko 2359ba4ec): it did not pass, and it did not fail.
        entry.update(passed=None, stopped_by=clean(event.get("stopped_by"), 40, one_line=True))
        took = f" after {fmt_duration(duration)}" if duration else ""
        entry["text"] = clean(f"{where}: {label} stopped by {stopped}{took}", 400, one_line=True)
        return entry
    entry["passed"] = passed if isinstance(passed, bool) else None
    verdict = "passed" if passed is True else "did not pass" if passed is False else "ended"
    code = event.get("exit_code")
    if passed is False and _is_number(code):
        verdict += f" (exit {int(code)})"
    took = f" in {fmt_duration(duration)}" if duration else ""
    reason = clean(event.get("reason"), 200, one_line=True)
    text = f"{where}: {label} {verdict}{took}" + (f": {reason}" if reason else "")
    entry["text"] = clean(text, 400, one_line=True)
    return entry


# What stopped a check, by roko's label for it (PlanRunInterrupt::label), when its reason does not say.
STOPPED_BY = {
    "cancel": "a cancel request",
    "SIGINT": "an interrupt (SIGINT)",
    "SIGTERM": "SIGTERM",
    "SIGHUP": "a hang-up (SIGHUP)",
    "deadline": "the FAST deadline",
    "conductor": "a conductor watcher",
    "tui-closed": "closing the TUI",
}


def stopped_cause(event: dict[str, Any]) -> str:
    """What stopped a check before it ended, in words, or "" when nothing did: roko names it in `stopped_by`
    since 2359ba4ec (`cancel`), and its `reason` says it ("a cancel request stopped it"). An older roko names
    no stop, and its check reads as before."""
    label = clean(event.get("stopped_by"), 40, one_line=True)
    if not label:
        return ""
    reason = clean(event.get("reason"), 200, one_line=True)
    if reason.endswith(" stopped it") and len(reason) > len(" stopped it"):
        return reason[: -len(" stopped it")]
    return STOPPED_BY.get(label, label)


def cap_stop(reason: Any) -> dict[str, Any] | None:
    """roko's stop at a run's cap in `reason` (a task's error, or why a task did not start; bug-4fabd0), or at
    its daily limit (`limit: "day"`), in numbers: the cap (the day's limit), what was spent (today), what was
    left, what the refused model call would have cost, and what an attempt needs, each None where roko's words
    do not say; and its words (`said`). None for any other reason."""
    text = clean(reason, 1_000, one_line=True)
    stop: dict[str, Any] = dict.fromkeys(("cap_usd", "spent_usd", "left_usd", "call_usd", "needs_usd"))
    # The day's words first: one of them reads "budget exhausted: daily $X / $Y".
    day = _DAY_SPENT.search(text) or _DAY_TRACKER.search(text)
    if day is not None:
        stop.update(cap_usd=float(day["cap"]), spent_usd=float(day["spent"]))
    elif (day := _DAY_EXCEEDED.search(text)) is not None:
        stop.update(cap_usd=round(int(day["limit"]) / 1e6, 6), spent_usd=round(int(day["used"]) / 1e6, 6))
    if day is not None:
        # roko's own daily limit names its setting; a tool loop's own daily budget does not.
        setting = "budget.max_daily_usd" if "budget.max_daily_usd" in day.group(0).lower() else None
        stop.update(limit="day", setting=setting, said=clean(text[day.start() :], 300, one_line=True))
        return stop
    start = _CAP_STOP.search(text)
    if start is None:
        return None
    for pattern in (_CALL_OVER_CAP, _CAP_SPENT):
        found = pattern.search(text, start.start())
        if found:
            stop.update({f"{key}_usd": float(value) for key, value in found.groupdict().items() if value})
    agent = _AGENT_LIMIT.search(text, start.start())
    if agent is not None:  # the Claude CLI stopped itself at the limit the attempt gave it (gap-e14344)
        stop.update(agent_limit_usd=float(agent["limit"]))
        stop.update(agent_spent_usd=float(agent["spent"]) if agent["spent"] else None)
    # Inside an attempt (before its next model call, or at its agent's own limit), else before one.
    inside = stop["call_usd"] is not None or agent is not None
    stop.update(limit="run", inside=inside, said=clean(text[start.start() :], 300, one_line=True))
    return stop


def cap_line(stop: dict[str, Any]) -> str:
    """A run's `budget_stop` after "it" or "the run": "reached its cap of $0.03 ($0.0264 spent)", or "reached
    roko's daily limit of $1.00 ($1.0123 spent today, UTC)"."""
    cap, spent = stop.get("cap_usd"), stop.get("spent_usd")
    day = stop.get("limit") == "day"
    return (
        ("reached roko's daily limit" if day else "reached its cap")
        + (f" of {usd(cap)}" if cap is not None else "")
        + (f" ({usd(spent)} spent{' today, UTC' if day else ''})" if spent is not None else "")
    )


def cap_reason(stop: dict[str, Any]) -> str:
    """Why a task roko stopped at the run's cap, or at its daily limit, ended where it did: its `reason`."""
    where = {"call": "", "attempt": " before another attempt"}.get(str(stop.get("when")))
    if stop.get("limit") == "day":
        return f"{'did not start' if where is None else 'stopped' + where}: {cap_words(stop)}"
    if where is None:
        return f"did not start at the run's cap: {cap_words(stop)}"
    return f"stopped at the run's cap{where}: {cap_words(stop)}"


def stop_line(task: Any, stop: dict[str, Any], *, started: bool) -> str:
    """A timeline line for a task roko stopped at the run's cap or at its daily limit: "T2 stopped at the
    run's cap: …", "T3 did not start: roko's daily limit was reached (…)"."""
    if stop.get("limit") == "day":
        return f"{task} {'stopped' if started else 'did not start'}: {cap_words(stop)}"
    return f"{task} {'stopped' if started else 'did not start'} at the run's cap: {cap_words(stop)}"


def cap_words(stop: dict[str, Any]) -> str:
    """A stop at the run's cap (`cap_stop`) in a clause: what the refused model call would have cost and what
    was left, or what was left and what an attempt needs, or what was spent; at roko's daily limit, what was
    spent today of it."""
    if stop.get("limit") == "day":
        spent, limit = stop.get("spent_usd"), stop.get("cap_usd")
        if spent is None or limit is None:
            return "roko's daily limit was reached"
        return f"roko's daily limit was reached ({usd(spent)} of {usd(limit)} spent today, UTC)"
    if stop.get("agent_limit_usd") is not None:  # the Claude CLI's own limit (gap-e14344)
        limit = usd(stop["agent_limit_usd"])
        after = f" after {usd(stop['agent_spent_usd'])}" if stop.get("agent_spent_usd") is not None else ""
        return f"the Claude CLI stopped at the spend limit roko gave it ({limit}){after}"
    cap = stop.get("cap_usd")
    of_cap = f" of the {usd(cap)} cap" if cap is not None else " of the cap"
    left, call, needs, spent = (stop.get(key) for key in ("left_usd", "call_usd", "needs_usd", "spent_usd"))
    if call is not None and left is not None:
        return f"its next model call would cost about {usd(call)}, and only {usd(left)}{of_cap} was left"
    if needs is not None and left is not None:
        return f"only {usd(left)}{of_cap} was left, less than an attempt needs ({usd(needs)})"
    if spent is not None:
        return f"{usd(spent)}{of_cap} was spent"
    return "the cap was reached"


# What a check is, in a word or two, from its command or its rung's name.
_CHECK_WORDS = (
    ("clippy", "clippy"),
    ("fmt", "formatting"),
    ("rustfmt", "formatting"),
    ("ruff", "lint"),
    ("eslint", "lint"),
    ("lint", "lint"),
    ("mypy", "types"),
    ("tsc", "types"),
    ("typecheck", "types"),
    ("pytest", "tests"),
    ("unittest", "tests"),
    ("test", "tests"),
    ("compile", "compile"),
    ("check", "compile"),
    ("build", "build"),
)
_RUNG_NAME = re.compile(r"\[\d+:([^\]]+)\]")


def check_label(what: str) -> str:
    """A short name for a check ("clippy", "tests"), from its command or its rung's name."""
    found = _RUNG_NAME.search(what)
    name = found.group(1) if found else what
    words = re.findall(r"[a-z]+", name.lower())
    for word, label in _CHECK_WORDS:
        if word in words:
            return label
    return clean(name, 40, one_line=True) or "a check"


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
        # The run's work kept on its plan branches (read with git) and the checkout's state for Merge.
        self.kept: list[dict[str, Any]] | None = None
        self.work_at = 0.0
        # Whether the run's batch branch was seen holding work: read with git after a merge, it no longer
        # differs from HEAD, like a batch that never got any.
        self.had_delivery = False
        self.merge: dict[str, Any] | None = None
        self.merge_at = 0.0
        # When the run's latest invocation began, as last read from its manifest, and when that was read.
        self.last_invocation_at: str | None = None
        self.invocation_read_at = 0.0
        # Why roko refused to start the run, from its hub's unscoped error (the run's index has none) or
        # its plan status; and whether that status was read.
        self.start_error: str | None = None
        self.start_error_read = False
        # What roko's spec gate refused, from its summary (`refused`, bug-9a5970), when the events lack it.
        self.gate_refusal: str | None = None
        # What roko's validator says about the run's plan, when the run did not start because of it.
        self.validation: dict[str, Any] | None = None
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
                kind = row_kind(row)
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
            self.last_invocation_at = _stamp(invocations[-1].get("started_at"))
            self.invocation_read_at = time.monotonic()
        closed = manifest.get("closed")
        if isinstance(closed, dict):
            self.finished_at = _stamp(closed.get("ended_at"))
        self.origin = clean(manifest.get("origin"), 80, one_line=True) or None
        self.plan_ids = [
            clean(pid, 120, one_line=True) for pid in manifest.get("plan_ids") or [] if isinstance(pid, str)
        ][:MAX_PLANS]
        if terminal:
            self.bundle_final = True

    def take_refusal(self, refused: dict[str, Any]) -> None:
        """Why roko did not run the run, as its summary says it since bug-9a5970 (`refused`): its start
        failed (`stage: start`), or its spec gate refused the plan (`stage: spec_gate`)."""
        reason = clean(refused.get("reason"), 400, one_line=True).split(" hint:", 1)[0].strip()
        if not reason:
            return
        if refused.get("stage") == "spec_gate":
            self.gate_refusal = reason
        else:
            self.start_error = self.start_error or reason

    def refresh_start_error(self, client: RokoClient) -> None:
        """Why roko refused to start the run, from the `error` of its plan status, when nothing said so yet: a
        refused start writes no event, and its hub error reaches only a relay that was listening then."""
        if self.start_error is not None or self.start_error_read:
            return
        self.start_error_read = True
        try:
            body = client.get(f"/api/plans/{quote(self.run_id, safe='')}/status")
        except RokoError as exc:  # roko keeps it until it restarts
            logger.debug("roko: no plan status for %s: %s", self.run_id, exc)
            return
        found = start_failure(body.get("error") if isinstance(body, dict) else None)
        if found is not None:
            self.start_error = found[1] or None

    def latest_invocation(self, client: RokoClient) -> datetime | None:
        """When the run's latest invocation began, read again from its manifest (at most every 30 s)."""
        if time.monotonic() - self.invocation_read_at > DELIVERED_TTL_S:
            self.invocation_read_at = time.monotonic()
            try:
                body = client.get(f"/api/runs/{quote(self.run_id, safe='')}/bundle")
            except RokoError as exc:
                logger.debug("roko: no manifest for %s: %s", self.run_id, exc)
                return None
            manifest = body.get("manifest") if isinstance(body, dict) else None
            rows = manifest.get("invocations") if isinstance(manifest, dict) else None
            invocations = [row for row in rows or [] if isinstance(row, dict)]
            if invocations:
                self.last_invocation_at = _stamp(invocations[-1].get("started_at"))
        return _parse(self.last_invocation_at)

    def refresh_plan_tasks(self, client: RokoClient, logged_plan: str | None = None) -> None:
        """The authored task list of each plan in a plan run, so the card draws the plan's tasks and waves
        from the start, and a task a re-run skips keeps its title. The plans are the ones the run log, the
        run's manifest and its events name (the manifest can name none yet when the run starts)."""
        named = [logged_plan or "", *self.plan_ids, *self.fold.plans, *(plan for plan, _ in self.fold.tasks)]
        for plan_id in dict.fromkeys(named):
            if not plan_id or plan_id in self.plans_fetched or plan_id == self.run_id:
                continue
            if _SYNTHETIC_PLAN.match(plan_id):
                continue
            if len(self.plans_fetched) >= MAX_PLANS:
                return
            try:
                body = client.get(f"/api/plans/{quote(plan_id, safe='')}/tasks")
            except RokoError as exc:
                logger.debug("roko: no task list for plan %s: %s", plan_id, exc)
                if exc.code is Code.NOT_FOUND:  # else read it again with the next card
                    self.plans_fetched.add(plan_id)
                continue
            self.plans_fetched.add(plan_id)
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
    """Run trackers by (roko URL, run id), least recently used dropped first; and, per roko URL, when its
    roko serve started and its plan list, read again now and then."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._trackers: OrderedDict[tuple[str, str], RunTracker] = OrderedDict()
        self._serve: dict[str, tuple[float, datetime | None]] = {}
        self._plans: dict[str, tuple[float, dict[str, dict[str, Any]]]] = {}
        self._slugs: dict[str, tuple[float, dict[str, str]]] = {}
        self._ladders: dict[str, tuple[float, list[tuple[str, str]]]] = {}
        self._tool_args: dict[str, tuple[float, dict[str, frozenset[str]]]] = {}
        self._validations: dict[tuple[str, str], tuple[float, tuple[bool, dict[str, Any] | None]]] = {}

    def plan_validation(self, client: RokoClient, plan_id: str) -> dict[str, Any] | None:
        """`plan_validation` of a plan, at most a minute old: the person may fix the plan in the meantime."""
        return self.check_plan(client, plan_id)[1]

    def check_plan(self, client: RokoClient, plan_id: str) -> tuple[bool, dict[str, Any] | None]:
        """`check_plan` of a plan, at most a minute old."""
        key = (client.settings.url, plan_id)
        with self._lock:
            cached = self._validations.get(key)
        if cached is not None and time.monotonic() - cached[0] < PLANS_TTL_S:
            return cached[1]
        found = check_plan(client, plan_id)
        with self._lock:
            if len(self._validations) >= MAX_TRACKERS:
                self._validations.clear()
            self._validations[key] = (time.monotonic(), found)
        return found

    def tool_arguments(self, client: RokoClient) -> dict[str, frozenset[str]]:
        """The arguments each of roko's MCP tools declares (`tools/list` `inputSchema.properties`), at most a
        minute old; {} when roko won't list them. A newer roko takes more (a run's `title` since gap-c2efe7),
        and declares `additionalProperties: false`, so the plugin sends only what this roko names."""
        key = client.settings.url
        with self._lock:
            cached = self._tool_args.get(key)
        if cached is not None and time.monotonic() - cached[0] < PLANS_TTL_S:
            return cached[1]
        found: dict[str, frozenset[str]] = {}
        try:
            result = client.rpc("tools/list")
        except RokoError as exc:
            logger.debug("roko: no tool list: %s", exc)
            result = None
        listed = result.get("tools") if isinstance(result, dict) else None
        for tool in listed if isinstance(listed, list) else []:
            if not isinstance(tool, dict):
                continue
            schema = tool.get("inputSchema")
            properties = schema.get("properties") if isinstance(schema, dict) else None
            if isinstance(tool.get("name"), str) and isinstance(properties, dict):
                found[tool["name"]] = frozenset(str(name) for name in properties)
        with self._lock:
            # A failed read is tried again soon rather than held for a minute.
            self._tool_args[key] = (time.monotonic() - (0 if listed is not None else PLANS_TTL_S - 10), found)
        return found

    def model_slugs(self, client: RokoClient) -> dict[str, str]:
        """roko's model keys and the slugs they name (`GET /api/models`), at most a minute old."""
        key = client.settings.url
        with self._lock:
            cached = self._slugs.get(key)
        if cached is not None and time.monotonic() - cached[0] < PLANS_TTL_S:
            return cached[1]
        slugs: dict[str, str] = {}
        try:
            body = client.get("/api/models")
        except RokoError as exc:
            logger.debug("roko: no model list: %s", exc)
            body = None
        listed = body.get("models") if isinstance(body, dict) else None
        for row in listed if isinstance(listed, list) else []:
            if isinstance(row, dict) and isinstance(row.get("key"), str) and isinstance(row.get("slug"), str):
                slugs[row["key"]] = row["slug"]
        with self._lock:
            self._slugs[key] = (time.monotonic(), slugs)
        return slugs

    def ladder(self, workdir: Path | None) -> list[tuple[str, str]]:
        """The workspace roko.toml's model ladder, as (rung, model) pairs; [] when it names none."""
        path = workdir / "roko.toml" if workdir is not None else None
        try:
            stamp = path.stat().st_mtime if path is not None else None
        except OSError:
            stamp = None
        if path is None or stamp is None:
            return []
        with self._lock:
            cached = self._ladders.get(str(path))
        if cached is not None and cached[0] == stamp:
            return cached[1]
        rungs: list[tuple[str, str]] = []
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError, UnicodeDecodeError):
            data = {}
        routing: dict[str, Any] = data["routing"] if isinstance(data.get("routing"), dict) else {}
        ladder: dict[str, Any] = routing["ladder"] if isinstance(routing.get("ladder"), dict) else {}
        for rung in ladder.get("rungs") or []:
            if (
                isinstance(rung, dict)
                and isinstance(rung.get("name"), str)
                and isinstance(rung.get("model"), str)
            ):
                rungs.append((rung["name"], rung["model"]))
        with self._lock:
            self._ladders[str(path)] = (stamp, rungs)
        return rungs

    def serve_started(self, client: RokoClient) -> datetime | None:
        """When the roko serve at the client's URL started (`GET /health` uptime), or None if it won't say."""
        key = client.settings.url
        with self._lock:
            cached = self._serve.get(key)
        if cached is not None and time.monotonic() - cached[0] < SERVE_TTL_S:
            return cached[1]
        started: datetime | None = None
        try:
            uptime = client.health().get("uptime_secs")
        except RokoError as exc:
            logger.debug("roko: no uptime from %s: %s", client.settings.display_url, exc)
            uptime = None
        if _is_number(uptime) and uptime >= 0:
            started = datetime.now(UTC) - timedelta(seconds=float(uptime))
        with self._lock:
            self._serve[key] = (time.monotonic(), started)
        return started

    def plans(self, client: RokoClient) -> dict[str, dict[str, Any]]:
        """roko's plan rows by id (`GET /api/plans`), at most a minute old; {} when roko won't list them."""
        key = client.settings.url
        with self._lock:
            cached = self._plans.get(key)
        if cached is not None and time.monotonic() - cached[0] < PLANS_TTL_S:
            return cached[1]
        rows: dict[str, dict[str, Any]] = {}
        try:
            listed = client.get("/api/plans")
        except RokoError as exc:
            logger.debug("roko: no plan list: %s", exc)
            listed = None
        for plan in listed if isinstance(listed, list) else []:
            if isinstance(plan, dict) and isinstance(plan.get("id"), str):
                rows[plan["id"]] = {
                    "title": clean(plan.get("title"), 200, one_line=True) or None,
                    "group": clean(plan.get("group"), 200, one_line=True) or None,
                    "status": clean(plan.get("status"), 80, one_line=True) or None,
                    # roko's word that it is a demo or test plan, kept once it has run (gap-8f84d1).
                    "fixture": plan["fixture"] if isinstance(plan.get("fixture"), bool) else None,
                }
        with self._lock:
            # A failed read is tried again soon rather than held for a minute.
            self._plans[key] = (time.monotonic() - (0 if listed is not None else PLANS_TTL_S - 10), rows)
        return rows

    def forget_merges(self, url: str) -> None:
        """The checkout changed (a commit, a merge): every card reads it again for Merge."""
        with self._lock:
            trackers = [tracker for (where, _), tracker in self._trackers.items() if where == url]
        for tracker in trackers:
            with tracker.lock:
                tracker.merge_at = 0.0
                tracker.delivered_at = 0.0
                tracker.work_at = 0.0
                tracker.final = None

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
        card = plan_generation_card(run_id, summary, logged)
        # Since roko bug-7a08a8 a plan that cannot run fails its generation, yet stays written: say why, as
        # for a plan an older roko reported written that cannot run.
        written = WRITTEN_BUT_INVALID.search(str(summary.get("error") or ""))
        if written and not card.get("plan_id"):
            card["plan_id"] = clean(written["plan"], 120, one_line=True)
        if card.get("plan_id") and card["state"] in ("succeeded", "failed"):
            answered, found = cache.check_plan(client, str(card["plan_id"]))
            if written and not answered:  # roko's words at the time, when it cannot say now
                found = validation_from_text(summary.get("error"))
            _check_the_written_plan(card, found)
        return card
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
                lambda: tracker.refresh_plan_tasks(client, (logged or {}).get("plan_id")),
            )
            for step in steps:
                try:
                    step()
                except RokoError as exc:
                    problems.append(exc.message)
            refused = summary.get("refused")
            if isinstance(refused, dict):  # roko says why it did not run it, under its own id (bug-9a5970)
                tracker.take_refusal(refused)
            elif state == "failed" and not tracker.fold.tasks and not tracker.fold.start_error:
                try:  # an older roko: the reason is in its plan status, until it restarts
                    tracker.refresh_start_error(client)
                except RokoError as exc:
                    problems.append(exc.message)
            if state == "failed" and not tracker.fold.tasks:
                # A plan roko's validator rejected while the run waited: say what it found.
                plan = (logged or {}).get("plan_id") or next(iter(tracker.plan_ids), None)
                started = tracker.start_error or tracker.fold.start_error
                if plan and started and FAILED_VALIDATION.search(started):
                    tracker.validation = cache.plan_validation(client, str(plan))
            stopped = interruption(client, cache, tracker, summary, logged)
            if stopped is not None:
                state, terminal = "interrupted", True
            card = _compose(tracker, run_id, state, summary, logged)
            card["interrupted"] = stopped
            if stopped is not None:
                card.update(verdict="interrupted", finished_at=card.get("finished_at") or stopped.get("at"))
            card["problems"] = problems
            # A finished run's events never change, so its card is kept; the
            # parts that can (what waits, the branch) are refreshed below. A run
            # the plugin found interrupted is not: roko may yet record its end.
            if (
                terminal
                and tracker.has_index
                and tracker.bundle_final
                and not problems
                and (stopped is None or stopped["source"] == "roko")
            ):
                tracker.final = dict(card)
        card["waiting"] = _waiting(client, run_id, state)
        if logged and logged.get("label"):
            name_items(card["waiting"], {run_id: str(logged["label"])})
        _name_the_plan(card, tracker, cache, client)
        fixture = run_fixture(summary)
        if fixture is not None:  # roko says whether the run's plans are demos (gap-8f84d1)
            card["demo"] = fixture
        _name_the_rungs(card, cache, client, workdir)
        if terminal:
            delivered = _delivered(tracker, workdir, run_id, summary)
            if delivered is not None:
                card.update(delivered)
            card["work"] = _work(tracker, workdir, run_id, summary, card)
            card["merge"] = _merge(tracker, workdir, run_id, card)
            card["checking"] = None
        else:
            card["checking"] = checking(tracker, state)
    if terminal and state != "succeeded" and card.get("kind") != "plan_generate":
        card["why"] = explain(cache, client.settings.url, card)
    card["next"] = next_action(card, max_run_usd=client.settings.max_run_usd)
    card["headline"] = headline(card)
    card["checked_at"] = now_iso()
    return card


def plan_validation(client: RokoClient, plan_id: str) -> dict[str, Any] | None:
    """Why roko will not run plan `plan_id`, as its validator says (`check_plan`). None when the plan is
    valid or roko cannot say."""
    return check_plan(client, plan_id)[1]


def check_plan(client: RokoClient, plan_id: str) -> tuple[bool, dict[str, Any] | None]:
    """What roko's validator says about plan `plan_id` (`POST /api/plans/{id}/validate`): whether it answered,
    and why roko will not run the plan: each error in roko's own words, and each question a task still has
    open (PLAN_045), from roko's message or else the plan's source. None when the plan can run."""
    path = f"/api/plans/{quote(plan_id, safe='')}"
    try:
        body = client.post(f"{path}/validate", {})
    except RokoError as exc:
        logger.debug("roko: no validation of plan %s: %s", plan_id, exc)
        return False, None
    if not isinstance(body, dict) or not isinstance(body.get("valid"), bool):
        return False, None
    if body["valid"]:
        return True, None
    errors: list[dict[str, Any]] = []
    questions: list[dict[str, Any]] = []
    listed: set[str] = set()  # the tasks whose questions roko's message lists
    diagnostics = [d for d in body.get("diagnostics") or [] if isinstance(d, dict)]
    found = [
        (d.get("rule_id"), d.get("task_id"), str(d.get("message") or ""))
        for d in diagnostics
        if d.get("severity") == "error"
    ] or [  # an older roko: only its "<rule>: <message>" lines
        (line.partition(": ")[0], None, line.partition(": ")[2])
        for line in (str(item) for item in body.get("errors") or [])
    ]
    for rule, task, message in found:
        lines = message.splitlines() or [""]
        error = _error_row(rule, task, lines[0])
        errors.append(error)
        asked = [line.strip()[2:] for line in lines[1:] if line.strip().startswith("- ")]
        questions.extend(open_question(error["task_id"] or "", text) for text in asked)
        if asked and error["task_id"]:
            listed.add(error["task_id"])
    unlisted = {e["task_id"] for e in errors if e["rule"] == "PLAN_045" and e["task_id"] not in listed}
    if unlisted:
        questions.extend(_source_questions(client, path, unlisted))
    return True, _validation(errors, questions)


def validation_from_text(text: Any) -> dict[str, Any] | None:
    """Why a plan cannot run, read from roko's own words: the errors it lists after "failed validation with N
    error(s)" (a refused run) or "but it cannot run: N error(s)" (a failed plan generation) since roko
    bug-7a08a8, with each error's questions. None when it lists none (an older roko names only the count)."""
    errors: list[dict[str, Any]] = []
    questions: list[dict[str, Any]] = []
    for line in str(text or "").splitlines()[1:]:
        if line.startswith("  "):  # an error's later lines: PLAN_045's questions
            if errors and line.strip().startswith("- "):
                questions.append(open_question(errors[-1]["task_id"] or "", line.strip()[2:]))
            continue
        found = _ERROR_LINE.fullmatch(line.strip())
        if found:
            errors.append(_error_row(found["rule"], None, found["message"]))
    return _validation(errors, questions) if errors else None


def _error_row(rule: Any, task: Any, message: str) -> dict[str, Any]:
    """One validation error: its rule, its task (named, or found in its words) and its first line, with roko's
    temporary copy of the plan called the plan's folder."""
    named = _TASK_NAMED.search(message)
    words = clean(message, 400, one_line=True).rstrip(":")
    return {
        "rule": clean(rule, 40, one_line=True) or None,
        "task_id": clean(task, 80, one_line=True) or (named.group(1) if named else None),
        "message": _TEMP_COPY.sub("the plan's folder", words),
    }


def _validation(errors: list[dict[str, Any]], questions: list[dict[str, Any]]) -> dict[str, Any]:
    shown = [f"{e['rule']}: {e['message']}" if e["rule"] else e["message"] for e in errors[:3]]
    return {
        "valid": False,
        "errors": errors[:MAX_PLAN_ERRORS],
        "open_questions": questions[:MAX_OPEN_QUESTIONS],
        "summary": clean("; ".join(shown), 600, one_line=True),
    }


def open_question(task_id: str, text: str) -> dict[str, Any]:
    """One open question of a task, with the assumption the planner wrote after it, when it wrote one."""
    asked, _, assumed = clean(text, 600, one_line=True).partition("Assumption:")
    return {"task_id": task_id or None, "question": asked.strip(), "assumption": assumed.strip() or None}


def _source_questions(client: RokoClient, path: str, tasks: set[str | None]) -> list[dict[str, Any]]:
    """The open questions in the plan's own tasks.toml (`GET /api/plans/{id}/source`) of `tasks`, or of every
    task when roko named none."""
    try:
        body = client.get(f"{path}/source")
        source = tomllib.loads(str(body.get("toml") or "")) if isinstance(body, dict) else {}
    except (RokoError, tomllib.TOMLDecodeError) as exc:
        logger.debug("roko: no plan source at %s: %s", path, exc)
        return []
    every = None in tasks
    return [
        open_question(str(task.get("id")), text)
        for task in source.get("task") or []
        if isinstance(task, dict) and (every or task.get("id") in tasks)
        for text in task.get("open_questions") or []
        if isinstance(text, str) and text.strip()
    ]


def validation_words(validation: dict[str, Any]) -> str:
    """What roko's validator found, in a sentence or two: its errors in its own words, then the open
    questions."""
    words = f"{validation['summary'].rstrip('.')}."
    asked = validation.get("open_questions") or []
    if asked:
        listed = "; ".join(
            f"({n}) {q['question']}"
            + (f" (suggested: {str(q['assumption']).rstrip('.')})" if q.get("assumption") else "")
            for n, q in enumerate(asked[:5], 1)
        )
        words += (
            f" Open questions: {listed}" + (f"; and {len(asked) - 5} more" if len(asked) > 5 else "") + "."
        )
    return words


def _check_the_written_plan(card: dict[str, Any], validation: dict[str, Any] | None) -> None:
    """A plan the planner wrote that roko's validator rejects cannot run yet: the card says why and what to
    do."""
    card["validation"] = validation
    if validation is None:
        return
    card["why"] = {
        "summary": f"roko wrote the plan, but it cannot run yet: {validation_words(validation)}",
        "validation": validation,
    }
    asked = bool(validation.get("open_questions"))
    card["next"] = {
        "action": None,
        "label": "answer the plan's open questions" if asked else "fix what roko found in the plan",
        "why": validation["summary"],
    }
    card["headline"] = headline(card)


def start_failure(message: Any) -> tuple[str, str] | None:
    """roko's "plan execution failed for <plan>: <why>" as (plan, why), or None for any other message. roko's
    advice after the reason ("hint: … kill it with `kill <pid>`") is left out: it is for whoever runs that
    other runner, not for a chat model to act on."""
    found = _START_FAILED.match(str(message or "").strip())
    if found is None:
        return None
    return found["plan"], clean(found["why"], 400, one_line=True).split(" hint:", 1)[0].strip()


def interruption(
    client: RokoClient,
    cache: CardCache,
    tracker: RunTracker,
    summary: dict[str, Any],
    logged: dict[str, Any] | None,
) -> dict[str, Any] | None:
    """Why a run ended because roko stopped under it, or None.

    roko says so itself since bug-dceafd (`interrupted` on the summary). An older roko keeps calling such a
    run `running` forever, so the plugin finds it: a run started over /mcp (as Hermes starts them) runs in
    roko serve's own process, so if its latest invocation began before this roko serve started, nothing
    runs it any more. A cancel that roko answered "no active execution" (a run nothing runs) is kept in the
    run log as `interrupted` and read from there.
    """
    reported = summary.get("interrupted")
    if isinstance(reported, dict) or clean(summary.get("state"), 40, one_line=True) == "interrupted":
        told = reported if isinstance(reported, dict) else {}
        return {
            "reason": clean(told.get("reason"), 300, one_line=True) or INTERRUPTED_REASON,
            "at": _stamp(told.get("at")) or _stamp(summary.get("finished_at")),
            "source": "roko",
        }
    if clean(summary.get("state"), 40, one_line=True) not in ("running", "queued"):
        return None
    marked = (logged or {}).get("interrupted")
    if isinstance(marked, dict):
        return {
            "reason": clean(marked.get("reason"), 300, one_line=True) or INTERRUPTED_REASON,
            "at": _stamp(marked.get("at")),
            "source": "plugin",
        }
    if logged is None and not str(tracker.origin or "").startswith("mcp:"):
        return None  # a run another process runs (a terminal's `roko run`) outlives roko serve
    first = _parse(tracker.started_at)
    if first is None:
        return None
    started = cache.serve_started(client)
    if started is None or first >= started - timedelta(seconds=INTERRUPT_SLACK_S):
        return None
    last = tracker.fold.last_ms
    if last is not None and last >= (started.timestamp() - INTERRUPT_SLACK_S) * 1000:
        return None  # it wrote events after this roko serve started: something runs it
    latest = tracker.latest_invocation(client)
    if latest is None or latest >= started - timedelta(seconds=INTERRUPT_SLACK_S):
        return None
    return {
        "reason": INTERRUPTED_REASON,
        "at": _iso_ms(tracker.fold.last_ms) or latest.isoformat(timespec="milliseconds"),
        "source": "plugin",
    }


def _name_the_plan(card: dict[str, Any], tracker: RunTracker, cache: CardCache, client: RokoClient) -> None:
    """A plan run is named by its plan's title, not its id; and a demo plan's run says it is one."""
    plan_id = card.get("plan_id")
    if card.get("kind") != "plan" or not isinstance(plan_id, str) or not plan_id:
        card["demo"] = False
        return
    row = cache.plans(client).get(plan_id) or {}
    card["demo"] = is_demo(row)
    if card.get("label") == plan_id:
        loaded = str(tracker.fold.plans.get(plan_id, {}).get("title") or "")
        title = loaded if loaded and loaded != plan_id else str(row.get("title") or "")
        if title and title != plan_id:
            card["label"] = clean(title, 120, one_line=True)


def work_view(
    client: RokoClient,
    cache: CardCache,
    run_id: str,
    summary: dict[str, Any],
    *,
    workdir: Any = None,
    logged: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """An ended run's `work`, `delivered` work and whether it ran a demo plan, as its card says them,
    without building the card (Merge asks for these)."""
    tracker = cache.tracker(client.settings.url, run_id)
    logged = logged or {}
    with tracker.lock:
        kind = logged.get("kind") or _kind_from_plans(run_id, tracker.plan_ids)
        plans = tracker.plan_ids
        plan_id = logged.get("plan_id") or (plans[0] if kind == "plan" and plans else None)
        stopped = isinstance(logged.get("interrupted"), dict) or summary.get("state") == "interrupted"
        view: dict[str, Any] = {
            "plan_id": plan_id,
            "state": "interrupted" if stopped else summary.get("state"),
        }
        delivered = _delivered(tracker, workdir, run_id, summary)
        if delivered is not None:
            view.update(delivered)
        view["work"] = _work(tracker, workdir, run_id, summary, view)
    fixture = run_fixture(summary)  # roko's word (gap-8f84d1), else the plan's row
    view["demo"] = (
        fixture
        if fixture is not None
        else kind == "plan" and bool(plan_id) and is_demo(cache.plans(client).get(str(plan_id)))
    )
    return view


def _name_the_rungs(card: dict[str, Any], cache: CardCache, client: RokoClient, workdir: Any) -> None:
    """A ladder pick names its rung: roko's route says only "ladder", so the rung is read from the workspace's
    own ladder (roko.toml), when exactly one rung names the model."""
    routes = [
        route
        for task in card.get("tasks") or []
        for route in [task.get("route"), *(entry.get("route") for entry in task.get("attempt_log") or [])]
        if isinstance(route, dict) and route.get("decided_by") == "ladder" and not route.get("rung")
    ]
    if not routes:
        return
    path = workdir if isinstance(workdir, Path) else Path(workdir) if workdir else None
    rungs = cache.ladder(path)
    if not rungs:
        return
    slugs = cache.model_slugs(client)
    for route in routes:
        model = route.get("model")
        names = {name for name, named in rungs if model in (named, slugs.get(named))}
        if len(names) == 1:
            route["rung"] = names.pop()


def is_demo(plan: dict[str, Any] | None) -> bool:
    """Whether a plan row is one of roko's demos: roko's own `fixture` flag (since gap-8f84d1, still set once
    the plan has run); from an older roko, a `demos` group, or a status that still says fixture."""
    if not isinstance(plan, dict):
        return False
    if isinstance(plan.get("fixture"), bool):
        return bool(plan["fixture"])
    group = str(plan.get("group") or "")
    return group == "demos" or group.startswith("demos/") or str(plan.get("status") or "") == "fixture"


def run_fixture(summary: dict[str, Any]) -> bool | None:
    """roko's word on whether an ended run ran only demo or test plans (gap-8f84d1: its result's `fixture`),
    whose output stays on its branch; None from an older roko, and before the run ends."""
    fixture = (loopevents.as_dict(summary.get("result")) or {}).get("fixture")
    return fixture if isinstance(fixture, bool) else None


def _work(
    tracker: RunTracker, workdir: Any, run_id: str, summary: dict[str, Any], card: dict[str, Any]
) -> dict[str, Any] | None:
    """The card's `work`: where the run's changes are and how far they are verified (runwork.py)."""
    path = workdir if isinstance(workdir, Path) else Path(workdir) if workdir else None
    if tracker.kept is None or time.monotonic() - tracker.work_at > DELIVERED_TTL_S:
        plans = list(tracker.plan_ids) or [plan for plan in tracker.fold.plans if plan] or [run_id]
        if card.get("plan_id") and card["plan_id"] not in plans:
            plans.append(str(card["plan_id"]))
        tracker.kept = runwork.git_parts(path, run_id, plans, f"refs/heads/{BATCH_PREFIX}{run_id}")
        tracker.work_at = time.monotonic()
    git = f"git -C {shlex.quote(str(path))}" if path is not None else "git"
    delivered = card.get("delivered")
    local = tracker.delivered
    if (
        delivered is None
        and isinstance(local, dict)
        and local.get("merged")
        and (tracker.had_delivery or runwork.batch_has_run(path, run_id))
    ):
        delivered = local  # merged: read with git, HEAD...branch shows no files any more
    return runwork.run_work(
        delivered,
        card.get("review_command"),
        summary.get("result"),
        tracker.kept,
        git=git,
        interrupted=card.get("state") == "interrupted",
        stopped=next((str(c["stopped"]) for c in tracker.fold.plan_checks if c.get("stopped")), None)
        or next(
            (
                str(d.get("stopped") or "a stop request")
                for d in tracker.fold.deliveries.values()
                if d.get("state") == "cancelled"
            ),
            None,
        ),
    )


def _merge(tracker: RunTracker, workdir: Any, run_id: str, card: dict[str, Any]) -> dict[str, Any] | None:
    """The card's `merge`: whether Merge can take the run's work now (read from the checkout alone)."""
    if card.get("work") is None:
        return None
    if tracker.merge is None or time.monotonic() - tracker.merge_at > MERGE_TTL_S:
        path = workdir if isinstance(workdir, Path) else Path(workdir) if workdir else None
        state = runwork.merge_state(
            path,
            runwork.pick_part(card.get("work")),
            run_id=run_id,
            terminal=True,
            demo=bool(card.get("demo")),
        )
        tracker.merge = {key: value for key, value in state.items() if not key.startswith("_")}
        tracker.merge_at = time.monotonic()
    return dict(tracker.merge)


def checking(tracker: RunTracker, state: str) -> dict[str, Any] | None:
    """What roko is checking right now, while the run goes: the plan's or workspace's check roko named,
    else the task check that has run longest, else (an older roko says nothing) the checks after the last
    task, when every task has ended and the run still goes."""
    if state != "running":
        return None
    now = time.time() * 1000
    fold = tracker.fold
    if fold.plan_check is not None:
        found = dict(fold.plan_check)
        view = _checking(
            found["what"], found["label"], found["scope"], None, found.get("since_ms"), "roko", now
        )
        view.update({key: found.get(key) for key in ("packages", "step", "steps")})
        return view
    rows = tracker.task_rows()
    busy = [task for task in rows if task.step == "check" and task.step_since_ms is not None]
    if busy:
        task = min(busy, key=lambda task: task.step_since_ms or 0)
        what = str(task.step_detail or task.rung or "a check")
        return _checking(what, check_label(what), "task", task.task_id, task.step_since_ms, "roko", now)
    if not rows or any(task.outcome in ("running", "pending") for task in rows):
        return None
    ended = [task.finished_ms for task in rows if task.finished_ms is not None]
    what = "the plan's checks before delivery"
    return _checking(what, what, "plan", None, max(ended) if ended else None, "plugin", now)


def _checking(
    what: str, label: str, scope: str, task_id: str | None, since_ms: int | None, source: str, now_ms: float
) -> dict[str, Any]:
    return {
        "what": what,
        "label": label,
        "scope": scope,
        "task_id": task_id,
        "since": _iso_ms(since_ms),
        "elapsed_s": max(0, round((now_ms - since_ms) / 1000)) if since_ms else None,
        "source": source,
    }


def next_action(card: dict[str, Any], *, max_run_usd: float | None = None) -> dict[str, Any] | None:
    """The one thing to offer on a run that ended: merge it, review it, commit roko.toml first, or run
    it again. None while it runs, and when there is nothing to do."""
    if card.get("active") or card.get("kind") == "plan_generate":
        return None
    state = card.get("state")
    work = card.get("work") or {}
    merge = card.get("merge") or {}
    kind = work.get("kind")
    if state == "interrupted":
        again = "run the plan again" if card.get("kind") == "plan" else "start it again"
        why = str((card.get("interrupted") or {}).get("reason") or INTERRUPTED_REASON)
        if kind in ("partial", "unverified", "verified"):
            why += "; what it finished is kept on its branch"
        return {"action": "rerun", "label": again, "why": why}
    stop = card.get("budget_stop")
    if state == "failed" and isinstance(stop, dict):  # stopped at its cap (bug-4fabd0): offered, not started
        why = f"it {cap_line(stop)}"
        if kind in ("partial", "unverified", "verified"):
            why += "; what it finished is kept on its branch"
        if stop.get("limit") == "day":  # nothing to press: a run now stops at once, until the UTC day turns
            return {
                "action": None,
                "label": "raise the daily limit or run it after the day turns (UTC)",
                "why": why,
            }
        # The cap to offer instead (dogfood R2-3): the same one would stop it again. A page fills its composer
        # with it; nothing starts until the person presses Run. It stays within the plugin's per-run limit.
        need = cap_need(stop, card.get("cost_usd"), card.get("max_usd"))
        offer = suggested_cap(stop, card.get("cost_usd"), card.get("max_usd"))
        over = False
        if offer is not None and _is_number(max_run_usd) and offer > max_run_usd:
            offer, over = float(max_run_usd), need is not None and need > max_run_usd
        if over:
            limit = fmt_money(max_run_usd)
            why += (
                f"; the cap this needs is above your per-run limit of {limit}, which you can raise in the "
                "plugin's settings"
            )
        return {
            "action": "rerun",
            "label": "raise the cap and run it again",
            "why": why,
            "max_usd": offer,
            **({"over_limit": True} if over else {}),
        }
    if card.get("demo") and kind not in (None, "none"):
        return {
            "action": "review",
            "label": "look at the demo's output",
            "why": "demo output stays on its run branch",
        }
    if merge.get("merged"):
        return None
    if merge.get("fix"):
        return {"action": "commit-roko-toml", "label": "commit roko.toml", "why": merge.get("reason")}
    if kind == "verified" and merge.get("available"):
        into = merge.get("into")
        return {
            "action": "merge",
            "label": "merge",
            "why": f"its checks passed; it goes into {into}" if into else None,
        }
    if kind == "unverified":
        return {"action": "review", "label": "review the unverified changes", "why": "no check ran on them"}
    if kind == "partial":
        stopped = next((part["stopped"] for part in work.get("parts") or [] if part.get("stopped")), None)
        return {
            "action": "review",
            "label": "review what passed",
            "why": f"{stopped} stopped roko's check of the merged work"
            if stopped
            else "only part of the work passed its checks",
        }
    if state == "failed":
        start_error = (card.get("why") or {}).get("start_error")
        if start_error:  # nothing ran: there is no check that did not pass
            return {"action": None, "label": "read why roko did not start it", "why": str(start_error)}
        refusals = (card.get("why") or {}).get("refusals")
        if refusals:  # no agent ran: the spec gate refused the plan
            why = "; ".join(str(refusal) for refusal in refusals[:3])
            return {"action": None, "label": "read why roko's spec gate refused it", "why": why}
        return {"action": None, "label": "read why it did not pass", "why": None}
    return None


def quick_totals(
    client: RokoClient,
    cache: CardCache,
    run_id: str,
    summary: dict[str, Any],
    logged: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """A run's state and spend so far, without the requests only a full card needs."""
    state = clean(summary.get("state"), 40, one_line=True) or None
    if str(summary.get("kind") or "").startswith("plan_generate:"):
        return {"state": state, "cost_usd": plan_writing_cost(summary)}
    terminal = state in TERMINAL_STATES
    tracker = cache.tracker(client.settings.url, run_id)
    with tracker.lock:
        if tracker.final is not None and terminal:
            known = {
                key: tracker.final.get(key)
                for key in ("state", "cost_usd", "finished_at", "events_read", "progress", "interrupted")
            } | run_facts(tracker.task_rows())
            if isinstance(tracker.final.get("budget_stop"), dict):  # a row that ended says it stopped at once
                known["budget_stop"] = budget_stop_row(tracker.final["budget_stop"])
            return known
        tracker.refresh_events(client)
        # Both read once per run (the bundle again only until it has a start time): the plan's task
        # list makes the progress count tasks that have not started yet.
        try:
            tracker.refresh_bundle(client, terminal)
            tracker.refresh_plan_tasks(client)
        except RokoError as exc:
            logger.debug("roko: no bundle for run %s yet: %s", run_id, exc)
        stopped = interruption(client, cache, tracker, summary, logged)
        if stopped is not None:
            state, terminal = "interrupted", True
        fold = tracker.fold
        settled = terminal and (tracker.has_index or tracker.index_missing)
        rows = tracker.task_rows()
        totals: dict[str, Any] = {
            "state": state,
            "cost_usd": round(fold.cost_usd, 6) if fold.saw_cost else None,
            "finished_at": (tracker.finished_at or (stopped or {}).get("at")) if terminal else None,
            "events_read": fold.rows if settled else None,
            "progress": progress([{"outcome": task.outcome} for task in rows]) if rows else None,
            "interrupted": stopped,
        }
        if settled:
            totals.update(run_facts(rows))
            stop = budget_stop(rows, totals["cost_usd"], multi_plan=len({row.plan_id for row in rows}) > 1)
            if stop is not None:  # the run lists say a stop at the cap, not a failure
                totals["budget_stop"] = budget_stop_row(stop)
        return totals


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
    # A run Hermes started came over /mcp, whose runs carry the `stage` outbound policy: a CLI agent that runs
    # its own tools cannot honour it, so the route panel marks those models as not for this run.
    chat_run = bool(logged) or str(tracker.origin or "").startswith("mcp:")
    tasks = [_task_card(task, chat_run=chat_run) for task in tracker.task_rows()]
    # roko's own name for the run when it has one (gap-c2efe7), else the one the plugin logged.
    ids = [*tracker.plan_ids, str(logged.get("plan_id") or "")]
    name = run_title(summary, run_id, ids) or display_label(logged)
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
        "label": clean(name or plan_id or f"run {run_id[:8]}", 120, one_line=True),
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
        "progress": progress([{"outcome": task.outcome} for task in tracker.task_rows()]),
        "graph": graph(tasks),
        "eta_minutes": fold.eta_minutes if state == "running" else None,
        "last_event_at": _iso_ms(fold.last_ms),
        # How each plan's delivery into the batch went (roko gap-4f6cbe); [] from an older roko.
        "deliveries": [
            {key: delivery.get(key) for key in ("plan_id", "partial", "state", "target", "reason", "stopped")}
            for delivery in fold.deliveries.values()
        ],
        # roko stopped the run at its cap (roko bug-4fabd0): a stop, not a failure; None otherwise.
        "budget_stop": budget_stop(
            tracker.task_rows(),
            cost,
            multi_plan=multi_plan,
            cap=logged.get("max_usd") if not multi_plan else None,
        ),
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


def budget_stop(
    rows: list[TaskView], cost: float | None, *, multi_plan: bool, cap: float | None = None
) -> dict[str, Any] | None:
    """The card's `budget_stop`: roko stopped the run at its cap (bug-4fabd0). The cap and what was spent
    (roko's figures when its words give them, else the cap the run was started with, `cap`, and what its
    events add up to), the tasks it stopped inside an attempt or before another one, those it did not start,
    and roko's words. None when it stopped no task at the cap."""
    stopped = [(task, task.cap_stop) for task in rows if task.cap_stop]
    if not stopped:
        return None
    # roko's daily limit wins over the run's cap: a higher cap would not help until the day turns.
    day = [(task, stop) for task, stop in stopped if stop.get("limit") == "day"]
    caps = [stop["cap_usd"] for _, stop in day or stopped if stop.get("cap_usd") is not None]
    spent = [stop["spent_usd"] for _, stop in day or stopped if stop.get("spent_usd") is not None]
    plans = sorted({task.plan_id for task, _ in stopped})
    if multi_plan:  # the cap is a plan's: what its own tasks spent
        priced = [task for task in rows if task.plan_id in plans and task.saw_cost]
        cost = round(sum(task.cost_usd for task in priced), 6) if priced else None

    def entry(task: TaskView, stop: dict[str, Any], **more: Any) -> dict[str, Any]:
        # The Claude CLI's own limit, when it stopped itself there (gap-e14344): the attempt's share, spent.
        agent = {
            key: stop[key] for key in ("agent_limit_usd", "agent_spent_usd") if stop.get(key) is not None
        }
        return {
            "task_id": task.task_id,
            **({"plan_id": task.plan_id} if multi_plan else {}),
            **more,
            "left_usd": stop.get("left_usd"),
            "attempt_needs_usd": stop.get("needs_usd"),
            **agent,
        }

    return {
        # `run`: the run's cap; `day`: roko's daily limit (budget.max_daily_usd), spent today (UTC).
        "limit": "day" if day else "run",
        "cap_usd": max(caps) if caps else None if day else cap,
        "spent_usd": max(spent) if spent else None if day else cost,
        "plan_id": plans[0] if multi_plan and len(plans) == 1 else None,
        # Stopped before a model call of an attempt, or before another attempt.
        "stopped": [
            entry(
                task,
                stop,
                before="model_call" if stop.get("when") == "call" else "attempt",
                next_call_usd=stop.get("call_usd"),
            )
            for task, stop in stopped
            if stop.get("when") in ("call", "attempt")
        ][:20],
        "not_started": [entry(task, stop) for task, stop in stopped if stop.get("when") == "start"][:20],
        "said": next(
            (stop["said"] for _, stop in stopped if stop.get("when") == "call"), stopped[0][1]["said"]
        ),
    }


# The composer's cap detents, and past them 1-2-5 to each power of ten: where a raised cap is suggested.
CAP_DETENTS = (0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0, 1000.0)


def suggested_cap(stop: dict[str, Any], cost: Any, max_usd: Any) -> float | None:
    """The cap to offer after roko stopped a run at its cap (dogfood R2-3): the composer's next detent at or
    above `cap_need`. None when neither a cap nor a spend is known."""
    want = cap_need(stop, cost, max_usd)
    if want is None:
        return None
    return next((detent for detent in CAP_DETENTS if detent >= want - 1e-9), float(math.ceil(want)))


def cap_need(stop: dict[str, Any], cost: Any, max_usd: Any) -> float | None:
    """What a run roko stopped at its cap needs to go on: twice the cap, or what was spent plus the call (or
    the attempt) that did not fit, whichever is more; from roko's numbers, else the run's own cap and cost."""
    cap = stop.get("cap_usd") if _is_number(stop.get("cap_usd")) else max_usd
    spent = stop.get("spent_usd") if _is_number(stop.get("spent_usd")) else cost
    unfit = [entry.get("next_call_usd") for entry in stop.get("stopped") or []]
    unfit += [entry.get("attempt_needs_usd") for entry in stop.get("not_started") or []]
    needs = [2 * float(cap)] if _is_number(cap) and cap > 0 else []
    if _is_number(spent):
        needs.append(float(spent) + max([float(value) for value in unfit if _is_number(value)], default=0.0))
    return max(needs) if needs else None


def budget_stop_row(stop: dict[str, Any]) -> dict[str, Any]:
    """A `budget_stop` as a run row carries it: which limit, the cap, and what was spent."""
    return {key: stop.get(key) for key in ("limit", "cap_usd", "spent_usd")}


def plan_writing_cost(summary: dict[str, Any]) -> float | None:
    """What roko's planner spent writing the plan (roko bug-a0432b): a completed generation's `cost_usd`, or
    what a failed one that wrote the plan anyway says it cost; else, since roko gap-11d870, what its returned
    calls cost so far (`progress.cost_usd`: while it runs, and kept after a failure). None from an older roko,
    and when roko does not say."""
    result = loopevents.as_dict(summary.get("result")) or {}
    cost = result.get("cost_usd")
    if _is_number(cost) and cost >= 0:
        return round(float(cost), 6)
    found = _WRITING_COST.search(str(summary.get("error") or ""))
    if found:
        return float(found.group(1))
    spent = (loopevents.as_dict(summary.get("progress")) or {}).get("cost_usd")
    return round(float(spent), 6) if _is_number(spent) and spent >= 0 else None


# The stages of roko's plan writing (gap-11d870 `progress.stage`), in words. Those that retry say why.
WRITING_STAGES = {
    "planning": "planning",
    "retrying": "retrying",
    "fixing": "fixing the plan",
    "regenerating": "rewriting the plan",
    "writing": "writing its files",
    "recording": "recording it",
}
_WRITING_WHY = frozenset({"retrying", "fixing", "regenerating"})


def writing_view(summary: dict[str, Any]) -> dict[str, Any] | None:
    """What roko's planner is doing on a plan writing (gap-11d870), from its `progress` and `elapsed_secs`:
    the stage, this stage's attempt of how many, the planner calls so far, what the returned ones cost, the
    model, why it tries again, and how long the writing has run; with `text`, the line a ticker shows. roko
    keeps the last stage after the end. None from an older roko, and in the second before the first stage."""
    progress = loopevents.as_dict(summary.get("progress")) or {}
    stage = clean(progress.get("stage"), 40, one_line=True)
    if not stage:
        return None
    attempt, attempts, calls = (progress.get(key) for key in ("attempt", "attempts", "calls"))
    cost, elapsed = progress.get("cost_usd"), summary.get("elapsed_secs")
    view: dict[str, Any] = {
        "stage": stage,
        "attempt": int(attempt) if _is_number(attempt) and attempt > 0 else None,
        "attempts": int(attempts) if _is_number(attempts) and attempts > 0 else None,
        "calls": int(calls) if _is_number(calls) and calls >= 0 else None,
        "cost_usd": round(float(cost), 6) if _is_number(cost) and cost >= 0 else None,
        "model": clean(progress.get("model"), 80, one_line=True) or None,
        "reason": clean(progress.get("reason"), 300, one_line=True) or None,
        "elapsed_s": int(elapsed) if _is_number(elapsed) and elapsed >= 0 else None,
    }
    view["text"] = writing_words(view)
    return view


def writing_words(view: dict[str, Any], *, clock: bool = True) -> str:
    """A plan writing's stage as a line: "writing the plan: planning · attempt 1 of 1 · 0:12 · $0.00", or for
    a stage that tries again, why: "retrying: the planner call ran into roko's 300 s limit … · attempt 2 of
    2"."""
    stage = str(view.get("stage") or "")
    words = WRITING_STAGES.get(stage, stage)
    reason = view.get("reason") if stage in _WRITING_WHY else None
    parts = [f"{words}: {reason}" if reason else f"writing the plan: {words}"]
    if view.get("attempt") and view.get("attempts"):
        parts.append(f"attempt {view['attempt']} of {view['attempts']}")
    if clock and view.get("elapsed_s") is not None:
        parts.append(clock_face(int(view["elapsed_s"])))
    if view.get("cost_usd") is not None:
        parts.append(fmt_money(view["cost_usd"]))
    return " · ".join(parts)


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
        "cost_usd": plan_writing_cost(summary),
        "max_usd": None,
        "task_count": _int((result or {}).get("task_count")) or None,
        "planner_error": clean(summary.get("error"), 1_000) or None,
        # roko's planner at work (gap-11d870): its stage, attempt, calls, spend so far and model; None from an
        # older roko. `elapsed_ms` is how long it has run, while it runs.
        "writing": writing_view(summary),
        "elapsed_ms": int(summary["elapsed_secs"]) * 1000
        if state not in TERMINAL_STATES and _is_number(summary.get("elapsed_secs"))
        else None,
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


def _task_card(task: TaskView, *, chat_run: bool = False) -> dict[str, Any]:
    routes = [loopevents.route_view(entry.get("route"), chat_run=chat_run) for entry in task.attempt_log]
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
            {
                "gate": gate.gate,
                "passed": gate.passed,
                "excerpt": gate.excerpt(),
                "runs": gate.runs,
                "superseded": task.superseded(gate.gate),
            }
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
                "route": route,
            }
            for entry, route in zip(task.attempt_log, routes, strict=True)
        ],
        # Why the latest attempt runs on its model (its attempt_log route), or null.
        "route": next((route for route in reversed(routes) if route), None),
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
    if task.outcome in OUTCOME_WORDS:  # roko's own word, plainer: the pages know "passed" and "skipped"
        row["outcome"], row["reason"] = OUTCOME_WORDS[task.outcome]
        row.setdefault("blocked_by", None)
    return row


_TITLE_LABEL = re.compile(r"^[\w ]{1,20}:$")
_ABBREVIATIONS = frozenset({"e.g", "i.e", "etc", "vs", "cf", "approx", "no", "mr", "mrs", "dr"})


def short_title(text: Any, limit: int = SHORT_TITLE_CHARS) -> str:
    """A run's name from its request: the first sentence of its first line that says something, without
    the sentence's full stop, at most `limit` characters (cut at a word)."""
    first = ""
    for raw in clean(text).splitlines():
        line = " ".join(raw.split()).lstrip("#>*-•· ").strip()
        if line and not _TITLE_LABEL.match(line):
            first = line
            break
    if not first:
        return ""
    for match in re.finditer(r"[.!?](?=\s|$)", first):
        if first[: match.start()].rsplit(" ", 1)[-1].lower() in _ABBREVIATIONS:
            continue
        if match.start() > 0:
            first = first[: match.start()] if first[match.start()] == "." else first[: match.end()]
            break
    first = first.strip()
    if len(first) <= limit:
        return first
    cut = first[: limit - 1]
    space = cut.rfind(" ")
    if space >= limit // 2:
        cut = cut[:space]
    return cut.rstrip(" ,;:-(") + "…"


def run_title(summary: dict[str, Any], run_id: str, plan_ids: list[str]) -> str:
    """roko's name for a run (its summary's `title`: its plans' titles, since gap-c2efe7), or "" when roko
    names it only by an id: a plan without a title is called by its id, and a prompt run before gap-c2efe7
    by the run's."""
    title = clean(summary.get("title"), 120, one_line=True)
    ids = {run_id, *(plan for plan in plan_ids if plan)}
    if not title or all(part.strip() in ids for part in title.split("; ")):
        return ""
    return title


def display_label(logged: dict[str, Any] | None) -> str:
    """A logged run's name: its title, or the short form of its request when the run was given none (an
    older plugin logged the whole request as the label)."""
    if not logged:
        return ""
    label = clean(logged.get("label"), 160, one_line=True)
    request = clean(logged.get("request"), 600, one_line=True)
    if not request:
        return label
    if not label:
        return short_title(logged.get("request"))
    # The old label was the request itself, clipped at 120 characters; a title or a short title is shorter.
    old_style = request.startswith(label.rstrip("…")) or label.startswith(request[:110])
    if old_style and (len(label) > SHORT_TITLE_CHARS or label == request):
        return short_title(logged.get("request")) or label
    return label


def tracker_facts(cache: CardCache, url: str, run_id: str) -> dict[str, Any]:
    """`run_facts` of a run whose card was built, and when roko last wrote an event for it."""
    tracker = cache.tracker(url, run_id)
    with tracker.lock:
        facts = run_facts(tracker.task_rows())
        facts["last_event_at"] = _iso_ms(tracker.fold.last_ms)
    return facts


def run_facts(rows: list[TaskView]) -> dict[str, Any]:
    """What an ended run adds to the Insights of Hermes' runs: each check's runs, and each model's tasks."""
    checks: dict[str, list[int]] = {}
    models: dict[str, dict[str, Any]] = {}
    for task in rows:
        for gate in task.gates.values():  # each task's check once, by how it last ended
            tally = checks.setdefault(gate.gate, [0, 0])
            tally[0 if gate.passed else 1] += 1
        if task.model and task.outcome not in ("pending", "running"):
            entry = models.setdefault(
                task.model, {"tasks": 0, "verified": 0, "unverified": 0, "cost_usd": 0.0}
            )
            # A task roko stopped at the run's cap is no verdict on its model: its spend counts, not the task.
            entry["tasks"] += 0 if task.cap_stop else 1
            entry["verified"] += 1 if task.outcome in _PASSED_OUTCOMES else 0
            entry["unverified"] += 1 if task.outcome == "unverified" else 0
            entry["cost_usd"] = round(entry["cost_usd"] + task.cost_usd, 6)
    return {"checks": dict(list(checks.items())[:10]), "models": dict(list(models.items())[:8])}


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


# "passed_with_preexisting_failures": its check passed apart from failures that were there before the task
# (roko gap-161be1); it counts as passed.
_PASSED_OUTCOMES = frozenset({"passed", "already_satisfied", "passed_with_preexisting_failures"})
_FAILED_OUTCOMES = frozenset({"failed", "error", "crashed", "timeout", "timed_out", "rejected"})
# roko skips a task no conditional route of its plan chose: a no-op by design, neither failed nor stopped.
_SKIPPED_OUTCOMES = frozenset({"condition-skipped"})
# What a card calls those two, and why (its task row's `reason`, and its timeline line).
OUTCOME_WORDS = {
    "passed_with_preexisting_failures": (
        "passed",
        "passed: the failures its check found were already there before the task",
    ),
    "condition-skipped": ("skipped", "skipped: no route of the plan chose it, so it did not need to run"),
}
# "stopped": a task roko stopped at the run's cap (bug-4fabd0), before a model call or before it started.
_STOPPED_OUTCOMES = frozenset({"cancelled", "interrupted", "skipped", "stopped"})


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
        "rung": clean(event.get("rung"), 40, one_line=True) or None,
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
        ("total", "passed", "failed", "running", "pending", "blocked", "stopped", "unverified", "skipped"), 0
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
        elif outcome in _SKIPPED_OUTCOMES:
            out["skipped"] += 1
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
    tracker.had_delivery = True
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
            if not gate.passed and not task.superseded(gate.gate)
        ]
        blocked = [
            {"task_id": task.task_id, "blocked_by": task.blocked_by, "reason": task.reason}
            for task in rows
            if task.outcome == "blocked"
        ]
        unverified = [task.task_id for task in rows if task.outcome == "unverified"]
        outcomes = {task.task_id: task.outcome for task in rows}
        errors = list(tracker.fold.errors)
        refusals = list(tracker.fold.refusals) or ([tracker.gate_refusal] if tracker.gate_refusal else [])
        move_aside = tracker.fold.move_aside
        # A run whose tasks got going was started, whatever error ended it (the live relay's hub error too).
        start_error = None if tracker.fold.tasks else tracker.start_error or tracker.fold.start_error
        validation = tracker.validation
        plan_checks = [
            check
            for check in tracker.fold.plan_checks
            if check.get("passed") is False and not check.get("stopped")
        ]
        stopped_checks = [check for check in tracker.fold.plan_checks if check.get("stopped")]
        undelivered = [
            d for d in tracker.fold.deliveries.values() if d.get("state") not in ("delivered", "delivering")
        ]
        capped = {task.task_id for task in rows if task.cap_stop}
        models = {task.task_id: task.model for task in rows if task.model}
        checks_failed = {task.task_id for task in rows if not all(task.final_checks().values())}
    task_errors = {
        match["task"]: match["reason"].strip().rstrip(".")
        for match in (_TASK_ERROR.match(error) for error in errors)
        if match and match["task"] not in capped  # the cap's story tells them
    }
    found = {task_id: _UNPRICED.findall(reason) for task_id, reason in task_errors.items()}
    unpriced = {task_id: list(dict.fromkeys(named)) for task_id, named in found.items() if named}
    # A cap roko could not count, because a call had no price: why each such task stopped, in roko's words.
    unenforced = {
        task_id: match
        for task_id, match in ((t, _UNENFORCED.search(r)) for t, r in task_errors.items())
        if match
    }
    held_back = {
        str(block["task_id"]): match
        for block, match in ((block, _UNENFORCED.search(str(block["reason"] or ""))) for block in blocked)
        if match and not block["blocked_by"]
    }
    other_errors = [
        error for error in errors if not _TASK_ERROR.match(error) and not _ENGINE_TALLY.match(error)
    ]
    parts: list[str] = []
    if card.get("state") == "cancelled":
        parts.extend(_cancel_story(outcomes, task_errors))
    if card.get("state") == "interrupted":
        parts.extend(_interrupted_story(outcomes, card))
    if isinstance(card.get("budget_stop"), dict):
        parts.extend(_cap_story(card["budget_stop"], checks_failed))
    if start_error:
        parts.append(f"roko did not start the run: {clean(start_error, 300, one_line=True).rstrip('.')}.")
    if validation:
        parts.append(f"roko's check of the plan says: {validation_words(validation)}")
    if refusals:
        parts.append(
            "roko's spec gate refused the plan before any agent ran: "
            + "; ".join(refusals[:3]).rstrip(".")
            + "."
        )
    for check in plan_checks[:2]:
        line = key_line(str(check.get("output") or ""))
        whose = "The workspace's" if check.get("scope") == "workspace" else "The plan's"
        parts.append(f"{whose} check {check['label']} did not pass" + (f": {line}" if line else "") + ".")
    for check in stopped_checks[:2]:
        whose = "The workspace's" if check.get("scope") == "workspace" else "The plan's"
        parts.append(f"{whose} check {check['label']} was stopped by {check['stopped']}; it did not fail.")
    parts.extend(_delivery_story(undelivered, said_check=bool(plan_checks), said_stop=bool(stopped_checks)))
    gated = {gate["task_id"] for gate in not_passed}
    for task_id, reason in list(task_errors.items())[:3]:
        if reason.startswith("cancelled") or (task_id in gated and reason.startswith("gate error")):
            continue  # told by the cancel story, or by the gate below with its output
        if task_id in unpriced:  # a capped run found no model with a price for it (roko gap-8548e3)
            parts.append(_no_price_words(task_id, unpriced[task_id]))
            continue
        if task_id in unenforced:  # a call with no price: roko cannot count the cap
            parts.append(_unenforced_words([task_id], unenforced[task_id], started=True))
            continue
        parts.append(f"{task_id} did not finish: {clean(reason, 300, one_line=True)}.")
    if move_aside:
        parts.append(f"roko's way past that checkout moves it aside and keeps its work: {move_aside}")
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
        if str(block["task_id"]) not in held_back:
            by_blocker.setdefault(str(block["blocked_by"] or ""), []).append(str(block["task_id"]))
    by_words: dict[str, list[str]] = {}
    for task_id, match in held_back.items():
        by_words.setdefault(match.group(0), []).append(task_id)
    for tasks in list(by_words.values())[:2]:
        parts.append(_unenforced_words(tasks, held_back[tasks[0]], started=False))
    for blocker, tasks in list(by_blocker.items())[:3]:
        verb = "was" if len(tasks) == 1 else "were"
        parts.append(
            f"{_join_names(tasks)} {verb} blocked"
            + (f" because {blocker} did not pass" if blocker else "")
            + "."
        )
    if unverified:
        kept = next(
            (
                part
                for part in (card.get("work") or {}).get("parts") or []
                if part.get("trust") == "unverified" and not part.get("delivered")
            ),
            None,
        )
        kept_on = (kept or {}).get("branch") or (kept or {}).get("commit")
        parts.append(
            f"No gate checked {_join_names(unverified)}, so the result is unverified"
            + (
                f": its changes are kept on {kept_on}, not merged; read them in Changes."
                if kept_on
                else ": roko's workspace may have no checks for this kind of work."
            )
        )
    kept_verified = next(
        (
            part
            for part in (card.get("work") or {}).get("parts") or []
            if part.get("trust") == "verified" and (part.get("partial") or not part.get("delivered"))
        ),
        None,
    )
    if kept_verified is not None and card.get("state") != "interrupted":
        names = [str(task.get("task_id")) for task in kept_verified.get("tasks") or [] if task.get("task_id")]
        held = _join_names(names) if names else "The tasks that passed"
        where = kept_verified.get("branch") or kept_verified.get("commit")
        verb = "passed its check" if len(names) == 1 else "passed their checks"
        parts.append(f"{held} {verb}: that work is kept on {where}; Changes shows it.")
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
        "refusals": refusals,
        "start_error": start_error,
        "validation": validation,
        # Tasks no model with a price could take under the cap (roko gap-8548e3), and where the docs say
        # how to give a model its price; None otherwise.
        "no_price": {
            "tasks": [*unpriced, *unenforced, *held_back][:10],
            "models": sorted(
                {model for named in unpriced.values() for model in named}
                | {models[task_id] for task_id in [*unenforced, *held_back] if task_id in models}
            )[:10],
            "docs": NO_PRICE_DOCS,
        }
        if unpriced or unenforced or held_back
        else None,
    }


def _runs_not_passed(task: TaskView, gate: str) -> int:
    """How many of a check's runs did not pass, from the task's attempt log."""
    return sum(
        1
        for attempt in task.attempt_log
        for verdict in attempt.get("gates") or []
        if verdict.get("gate") == gate and not verdict.get("passed")
    )


def _delivery_story(deliveries: list[dict[str, Any]], *, said_check: bool, said_stop: bool) -> list[str]:
    """The plans roko did not deliver into the run's batch, and why (roko gap-4f6cbe), less what the plan's
    check lines already say: a failed check on the merge, or a stop that cut it short."""
    story = []
    for delivery in deliveries[:3]:
        state, target = delivery.get("state"), delivery.get("target") or "the run's batch branch"
        whose = f"Plan {delivery.get('plan_id')}"
        if state == "cancelled":
            if not said_stop:
                stopper = delivery.get("stopped") or "a stop request"
                story.append(f"{whose}'s delivery was stopped by {stopper}; it did not fail.")
        elif state == "regression_failed":
            if not said_check:
                story.append(f"{whose} was not delivered: the check on its merge failed.")
        else:
            words = DELIVERY_ENDS.get(str(state), "").format(target=target) or delivery.get("reason")
            story.append(f"{whose} was not delivered" + (f": {words}" if words else "") + ".")
    return story


def _cap_story(stop: dict[str, Any], checks_failed: set[str]) -> list[str]:
    """A run roko stopped at its cap (roko bug-4fabd0): the cap and what was spent, the tasks it stopped
    before a model call or before another attempt, and those it did not start. A stop, not a failure (a task
    whose check did not pass says so in its own line); what passed is said after it, as for any run."""
    cap, spent = stop.get("cap_usd"), stop.get("spent_usd")
    who = f"Plan {stop['plan_id']}" if stop.get("plan_id") else "The run"
    if stop.get("limit") == "day":
        # roko's own daily limit names its setting; a tool loop's own daily budget does not.
        setting = " (budget.max_daily_usd)" if "budget.max_daily_usd" in str(stop.get("said") or "") else ""
        story = [
            f"{who} stopped: it reached roko's daily limit"
            + (f" of {usd(cap)}" if cap is not None else "")
            + setting
            + (f", with {usd(spent)} spent today (UTC)" if spent is not None else "")
            + "."
        ]
    else:
        story = [
            f"{who} stopped: it reached its cap"
            + (f" of {usd(cap)}" if cap is not None else "")
            + (f", with {usd(spent)} spent" if spent is not None else "")
            + "."
        ]
    stopped = [entry for entry in stop.get("stopped") or [] if entry.get("task_id")]
    calls = [entry for entry in stopped if entry.get("before") == "model_call"]
    names = [str(entry["task_id"]) for entry in calls]
    # A task whose check did not pass before the stop says so in its own line: no "did not fail" for it.
    clean_stop = "; it did not fail" if len(calls) == 1 else "; they did not fail"
    if checks_failed & set(names):
        clean_stop = ""
    if len(calls) == 1 and calls[0].get("agent_limit_usd") is not None:  # the Claude CLI's own limit
        words = cap_words(calls[0])
        story.append(f"{names[0]} was stopped inside its attempt: {words}{clean_stop}.")
    elif len(calls) == 1:
        call, left = calls[0].get("next_call_usd"), calls[0].get("left_usd")
        price = (
            f", which would have cost about {usd(call)} with only {usd(left)} of the cap left"
            if call is not None and left is not None
            else ""
        )
        story.append(f"{names[0]} was stopped before its next model call{price}{clean_stop}.")
    elif calls:
        story.append(f"{_join_names(names)} were stopped before their next model calls{clean_stop}.")
    for entries, verb in (
        ([entry for entry in stopped if entry.get("before") == "attempt"], "got no further attempt"),
        ([entry for entry in stop.get("not_started") or [] if entry.get("task_id")], "did not start"),
    ):
        if entries:
            left, needs = entries[0].get("left_usd"), entries[0].get("attempt_needs_usd")
            story.append(
                f"{_join_names([str(entry['task_id']) for entry in entries])} {verb}"
                + (
                    f": only {usd(left)} of the cap was left, less than an attempt needs ({usd(needs)})"
                    if left is not None and needs is not None
                    else ""
                )
                + "."
            )
    return story


def _no_price_words(task_id: str, models: list[str]) -> str:
    """Why a task of a capped run did not run when roko had no price for any model that could take it (roko
    gap-8548e3), and where the plugin's docs say how to give one its price."""
    named = _join_names([clean(model, 80, one_line=True) for model in models])
    has = "has" if len(models) == 1 else "have"
    page = NO_PRICE_DOCS.partition("#")[0]
    return (
        f"No model with a price could take {task_id} under the cap: roko counts only priced calls against a "
        f"cap, and {named} {has} no price. The plugin's docs/{page} (“roko has no priced model for runs from "
        "Hermes”) shows how to give a model its price."
    )


def _unenforced_words(task_ids: list[str], found: re.Match[str], *, started: bool) -> str:
    """Tasks roko stopped because it could not count a cap: a model call had no price (the run's cap, or its
    daily limit when today's spend holds such calls); and what roko needs, with where the docs say how."""
    names = _join_names(task_ids)
    page = NO_PRICE_DOCS.partition("#")[0]
    needs = (
        "roko needs a price for every model it calls under a cap: cost_input_per_m and cost_output_per_m "
        f"on the model's [models.*] entry in roko.toml. The plugin's docs/{page} (“roko has no priced model "
        "for runs from Hermes”) shows how."
    )
    if found["day"]:
        limit = usd(float(found["day"]))
        return (
            f"{names} did not start: today's spend includes calls with no price, so roko cannot count its "
            f"daily limit of {limit} (budget.max_daily_usd). {needs}"
        )
    cap = f" of {usd(float(found['cap']))}" if found["cap"] else ""
    verb = "did not finish" if started else "did not start"
    return (
        f"{names} {verb}: a model call had no price, so roko cannot count it against the run's cap{cap}. "
        + needs
    )


def _interrupted_story(outcomes: dict[str, str], card: dict[str, Any]) -> list[str]:
    """What an interrupted run had done when roko stopped under it, and that what passed is kept."""
    reason = str((card.get("interrupted") or {}).get("reason") or INTERRUPTED_REASON).rstrip(".")
    was = [task_id for task_id, outcome in outcomes.items() if outcome == "running"]
    passed = [task_id for task_id, outcome in outcomes.items() if outcome in _PASSED_OUTCOMES]
    never = [task_id for task_id, outcome in outcomes.items() if outcome == "pending"]
    story = [f"The run was interrupted: {reason}."]
    if was:
        story.append(f"{_join_names(was)} {'was' if len(was) == 1 else 'were'} running then.")
    if passed:
        story.append(f"{_join_names(passed)} had passed before that; what passed is kept on its branch.")
    if never:
        story.append(f"{_join_names(never)} never started.")
    return story


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


_TASK_ERROR = re.compile(r"^plan '(?P<plan>[^']*)': task '(?P<task>[^']+)' failed: (?P<reason>.+)$", re.S)
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
    stop = card.get("budget_stop") if state == "failed" else None
    # roko stopped the run at its cap (bug-4fabd0), or at its daily limit: a stop, not a failure.
    if isinstance(stop, dict) and stop.get("limit") == "day":
        parts = ["stopped: today's limit was reached"]
    else:
        parts = ["stopped: the run reached its cap" if isinstance(stop, dict) else state]
    if state == "queued" and card.get("position"):
        parts[0] = f"queued (position {card['position']})"
    if card.get("kind") == "plan_generate":
        writing = card.get("writing")
        if state == "running" and isinstance(writing, dict) and writing.get("text"):
            return " · ".join([*parts, str(writing["text"])])  # what roko's planner is doing (gap-11d870)
        if card.get("plan_id"):
            parts.append(f"plan {card['plan_id']}")
        if card.get("task_count"):
            count = int(card["task_count"])
            parts.append(f"{count} task{'s' if count != 1 else ''}")
        if card.get("cost_usd") is not None:
            parts.append(fmt_money(card["cost_usd"]))
        if card.get("validation"):
            parts.append("cannot run yet")
        return " · ".join(parts)
    gates = card.get("gates") or {}
    if gates.get("total"):
        parts.append(f"gates {gates.get('passed', 0)}/{gates['total']}")
    elif (card.get("why") or {}).get("start_error"):
        parts.append("roko did not start it")
    elif (card.get("why") or {}).get("refusals"):
        parts.append("roko's spec gate refused it")
    elif state in TERMINAL_STATES and state not in ("cancelled", "interrupted", "missing") and stop is None:
        parts.append("no gate ran")
    counts = card.get("progress") or card.get("task_counts") or {}
    if (counts.get("total") or 0) > 1:
        parts.append(f"tasks {counts.get('passed', 0)}/{counts['total']}")
    cost, cap = card.get("cost_usd"), card.get("max_usd")
    money = fmt_money
    if isinstance(stop, dict) and stop.get("limit") != "day":  # what was spent of the cap, as roko says it
        cap, money = cap if cap is not None else stop.get("cap_usd"), usd
    if cost is not None or cap is not None:
        parts.append(money(cost) + (f" of {money(cap)}" if cap is not None else ""))
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
    kept = [part for part in (card.get("work") or {}).get("parts") or [] if not part.get("delivered")]
    if any(part.get("trust") == "unverified" for part in kept):
        parts.append("unverified changes kept")
    elif kept:
        parts.append("passed work kept on its plan branch")
    return " · ".join(parts)


def fmt_money(value: Any) -> str:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return "—"
    if 0 < value < 0.01:
        return f"${value:.3f}"
    return f"${value:.2f}"


def usd(value: Any) -> str:
    """A sum spent against a cap, as roko says it: to the cent from ten cents up, below that to a hundredth of
    a cent ($0.0264), where a cent is a large part of a small cap."""
    if not _is_number(value):
        return "—"
    if value >= 0.1:
        return f"${value:.2f}"
    text = f"{value:.4f}".rstrip("0")
    return "$" + (text if len(text.partition(".")[2]) >= 2 else f"{value:.2f}")


def clock_face(seconds: int) -> str:
    """Seconds as a clock shows them, as the pages' clocks do: 0:12, 1:02:03."""
    hours, rest = divmod(max(0, seconds), 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}" if hours else f"{minutes}:{secs:02d}"


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

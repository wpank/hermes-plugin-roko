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
from array import array
from bisect import bisect_left
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
        # An attempt's verdict and where it stood on the model ladder, once roko publishes it (backlog R1).
        "attempt_settled",
        # A line a task's check printed, as it printed it.
        "gate_output_line",
        # What roko put in an attempt's prompt: the lessons, playbooks and sections (backlog R3).
        "prompt_assembled",
        # What a failed check left the task's next attempt: the failing steps and a diagnosis (backlog R2).
        "retry_feedback",
        # roko's cost per verified task, run by run, as a run ends (gap-de0e96).
        "efficiency_trend_updated",
        # A task failed on the top rung it can climb with no try left (roko 37088dc12, backlog R4).
        "ladder_exhausted",
        # Each model call's cost as it happens (roko f2ee9a0d3), and the spec gate step by step (97d9b1819).
        "call_cost",
        "spec_gate_started",
        "spec_gate_step",
        "spec_gate_finished",
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
    "attempt_settled",
    "gate_output_line",
    "prompt_assembled",
    "retry_feedback",
    "efficiency_trend_updated",
    "ev.update",  # the homeostat moves with every resolution: the card's `homeostat` holds it
    "ladder_exhausted",  # roko's ladder_exhausted diagnosis beside it makes the line
    "call_cost",  # the spend moves on the card; a line a model call would bury the run's news
    "spec_gate_started",
    "spec_gate_step",
    "spec_gate_finished",
}
# A run id that names a folder of roko's `.roko/runs/`, and the largest attempts.jsonl read (8 MB).
_RUN_DIR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
ATTEMPTS_BYTES = 8 * 1024 * 1024
# The rows that belong to a task's latest try: the try lasts until the last of them.
_TRY_KINDS = frozenset(
    {
        "agent_output",
        "agent_completed",
        "gate_rung_started",
        "gate_result",
        "efficiency_event",
        "task_completed",
        "gate_output_line",
    }
)
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
# A tool call roko's tool loop failed, as its result says (round v7: the real P0 run's bash timeouts).
_TOOL_ERROR = re.compile(r"\s*error:\s*(\S.*)", re.DOTALL)
# Rows whose timeline line is their loop event's words.
_LOOP_ONLY_KINDS = loopevents.LOOP_TYPES - {"agent_spawned", "task_started"}
PAGE_LIMIT = 200
# One refresh reads at most this many pages (40,000 rows); the next one goes on. A card's first read of a
# run reads fewer (about 2 s at the client's 25 requests a second): a long run's page paints soon, on roko's
# totals.
MAX_PAGES = 200
FIRST_PAGES = 50
# roko limits each caller to 30 requests a second; a long index pages faster than that. A refresh
# waits as roko asks (at most this long, this many times) rather than stopping halfway.
RATE_WAITS = 3
RATE_WAIT_MAX_S = 2.0
# What a read behind the index's end leaves out (roko gap-cb9044, `?skip=`): the agents' streamed words,
# 96% of the real P0 index and 99% of phase 1's. The heartbeats stay, so when roko last wrote stays true. At
# the end the fold reads every row again, for a running task's live words. An older roko ignores it.
SKIP_BEHIND = "live_text"
# The timeline's own reads leave out the heartbeats too: it shows neither.
SKIP_TIMELINE = "live_text,heartbeats"
MAX_TIMELINE = 400
# The lines older than those a fold keeps whole, kept as compact JSON for "earlier ↑" (round v7): about 1 MB
# at most. A real phase's index runs past 100,000 rows (97% of them agent words, which make no line) and 2,000
# lines.
MAX_HISTORY = 4_000
MAX_TASKS = 200
MAX_ATTEMPTS = 12
MAX_STEPS = 8
MAX_LOOPS = 60
LIVE_TEXT_CHARS = 600
MAX_PLANS = 8
OUTPUT_CHARS = 2_000
EXCERPT_CHARS = 200
# The lines of a task's newest check its card keeps (`check_tail`).
CHECK_TAIL_LINES = 40
WHY_CHARS = 1_200
MAX_TRACKERS = 64
DELIVERED_TTL_S = 30.0
# The checkout's state for Merge changes when the person commits; it is read again this often.
MERGE_TTL_S = 5.0
BUNDLE_RETRY_S = 10.0
# roko serve's start time (`GET /health` uptime) and its plan list are read again this often.
SERVE_TTL_S = 15.0
PLANS_TTL_S = 60.0
# GET /estimate's fallback reads the newest this many tasks roko recorded in the workspace.
TASK_HISTORY = 40
# The most of roko's daily cost ledger (its last bytes) the overview reads for today's spend in roko.
LEDGER_BYTES = 8 * 1024 * 1024
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
    # Its tier as its plan names it (`focused`, …): where it starts on the model ladder.
    tier: str | None = None
    outcome: str = "pending"
    model: str | None = None
    provider: str | None = None
    role: str | None = None
    attempts: int = 0
    # roko's budget for its tries (max_retries + 1, from the run's attempts.jsonl), when known.
    max_tries: int | None = None
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
    # One entry per agent attempt: model, provider, when it started and its last row, the route that picked
    # it, its check verdicts and the first that failed, what roko counted for it (cost, tokens), the model a
    # failover passed over, and roko's own verdict once it sends one (attempt_settled).
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
    # What its newest check printed: attempt, gate, verdict (None while it runs), command, exit code, its last
    # lines, and whether they came line by line as it printed them (`gate_output_line`).
    check_tail: dict[str, Any] | None = None
    # What roko put in each attempt's prompt (`prompt_assembled`), and what a failed check left each attempt
    # (`retry_feedback`), by attempt.
    prompts: dict[int, dict[str, Any]] = field(default_factory=dict)
    feedback: dict[int, dict[str, Any]] = field(default_factory=dict)
    # It failed on the top rung it can climb with no try left: the attempt, rung, model and roko's advice.
    exhausted: dict[str, Any] | None = None

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
    # The lines before those (compact JSON, oldest first), and the cursor of every line the run has had: where
    # a page of older lines starts in roko's index, when it is older than these too.
    history: deque[str] = field(default_factory=lambda: deque(maxlen=MAX_HISTORY))
    line_cursors: array[int] = field(default_factory=lambda: array("q"))
    rows: int = 0
    # The first and newest event times seen, and roko's latest estimate of the minutes left.
    first_ms: int | None = None
    last_ms: int | None = None
    eta_minutes: float | None = None
    # When roko made that estimate (its event's time): roko sends one only when a task completes (P-38).
    eta_ms: int | None = None
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
    # M1's essential variables as the run last saw them (`ev.update`), by name, and its controller's last act
    # (`m1.episode`).
    essential: dict[str, dict[str, Any]] = field(default_factory=dict)
    controller: dict[str, Any] | None = None
    # roko's own figures for this run, as it ended (`efficiency_trend_updated`, its last bucket).
    roko_cost: dict[str, Any] | None = None
    # A running try's spend so far (`call_cost`'s attempt_cost_usd) by (plan, task, attempt), until roko
    # states the try's cost; and the spec gate's progress before any agent runs.
    live: dict[tuple[str, str, int], float] = field(default_factory=dict)
    spec_gate: dict[str, Any] | None = None

    @property
    def live_cost_usd(self) -> float:
        """What the tries running now have spent so far, beyond `cost_usd` (only tries roko stated)."""
        return round(sum(self.live.values()), 6)

    def spec_gate_view(self) -> dict[str, Any] | None:
        """The card's `spec_gate`: its steps run of `steps_total` (each red-on-base step, cache hits too), how
        many were cached or passed (a step should fail on the unchanged base), their time, and how it ended;
        None before roko's spec gate starts."""
        if self.spec_gate is None:
            return None
        return {key: self.spec_gate.get(key) for key in SPEC_GATE_FIELDS}

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
                self.eta_minutes, self.eta_ms = float(eta), at
            elif eta is None:
                self.eta_minutes, self.eta_ms = None, None
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
        if kind in ("plan_set_loaded", "plan_started") and self.completed is not None:
            # A run's end, then its plans again: a resume under the same run id (roko's checkpoint resume
            # keeps it, "one more invocation"). The end was the earlier invocation's, not this one's.
            self.completed = None
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
            if not fresh and task.attempt_log[-1].pop("agent_to_come", False):
                # roko's verdict on the attempt was read before its agent's row: this is that agent.
                last = task.attempt_log[-1]
                last.update(model=task.model, provider=task.provider, started_ms=at)
                if task.pending_route is not None and task.pending_route[0] in (last.get("attempt"), 0):
                    last["route"] = task.pending_route[1]
                task.pending_route = None
            elif not fresh:
                # Another agent for the same attempt: roko failed over to the next model.
                last = task.attempt_log[-1]
                was = {"model": last.get("model"), "provider": last.get("provider")}
                if (was["model"], was["provider"]) != (task.model, task.provider):
                    last.setdefault("failover", was)
                last.update(model=task.model, provider=task.provider)
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
        elif kind == "ev.update":
            view = loopevents.essential_view(event)
            if view is not None and (view["ev"] in self.essential or len(self.essential) < 8):
                self.essential[view["ev"]] = view
        elif kind == "m1.episode":
            self.controller = loopevents.controller_view(event) or self.controller
        elif kind == "efficiency_trend_updated":
            self.roko_cost = _run_bucket(event.get("buckets")) or self.roko_cost
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
            output = full = clean(event.get("output_text"), OUTPUT_CHARS * 4)
            if len(output) > OUTPUT_CHARS:  # keep the command line and the end of the output
                head = output.splitlines()[0][:200] if output else ""
                output = head + "\n…\n" + output[-(OUTPUT_CHARS - len(head) - 3) :]
            _check_ended(task, name, bool(event.get("passed")), full)
            previous = task.gates.get(name)
            task.gates[name] = GateView(
                name, bool(event.get("passed")), output, (previous.runs + 1) if previous else 1
            )
            task.rung = None
            if task.attempt_log:
                verdicts = task.attempt_log[-1].setdefault("gates", [])
                if len(verdicts) < 20:
                    verdicts.append({"gate": name, "passed": bool(event.get("passed"))})
                if not event.get("passed"):  # the try's first check that did not pass, and its key line
                    task.attempt_log[-1].setdefault("failed", {"gate": name, "key_line": key_line(full)})
        elif kind == "gate_output_line" and task is not None:
            _check_printed(task, event)
        elif kind == "prompt_assembled" and task is not None:
            _keep(task.prompts, event.get("attempt"), prompt_view(event))
        elif kind == "retry_feedback" and task is not None:
            _keep(task.feedback, event.get("next_attempt"), feedback_view(event))
        elif kind == "attempt_settled" and task is not None:
            _settle(task, event, at)
            if _is_number(event.get("attempt")):
                self.live.pop((task.plan_id, task.task_id, int(event["attempt"])), None)
        elif kind == "call_cost" and task is not None:
            spent, tried = event.get("attempt_cost_usd"), event.get("attempt")
            if _is_number(spent) and spent >= 0 and _is_number(tried) and 0 < tried <= MAX_ATTEMPTS:
                self.live[(task.plan_id, task.task_id, int(tried))] = float(spent)
                for row in reversed(task.attempt_log):
                    if row.get("attempt") == tried:
                        row["live_cost_usd"] = float(spent)
                        break
        elif kind in ("spec_gate_started", "spec_gate_step", "spec_gate_finished"):
            self._spec_gate(kind, event, at)
        elif kind == "ladder_exhausted" and task is not None:
            attempt = event.get("attempt")
            task.exhausted = {
                "attempt": int(attempt) if _is_number(attempt) and attempt > 0 else None,
                "rung": clean(event.get("rung"), 40, one_line=True) or None,
                "model": clean(event.get("model"), 120, one_line=True) or None,
                "suggestion": clean(event.get("suggestion"), 300, one_line=True) or None,
            }
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
        if task is not None and at is not None and kind in _TRY_KINDS and task.attempt_log:
            last = task.attempt_log[-1]
            last["ended_ms"] = max(last.get("ended_ms") or at, at)
        line = timeline_entry(cursor, kind, event, attempt_hint=task.attempts if task is not None else 0)
        tally = kind == "error" and _ENGINE_TALLY.match(clean(event.get("message"), 200, one_line=True))
        if tally and any(row.cap_stop for row in self.tasks.values()):
            line = None  # its "N failed" counts what the cap stopped, which the lines above say
        if line is not None:
            if kind in ("plan_completed", "run_completed"):
                self._ended_at_cap(line, plan_id)
            if len(self.timeline) == self.timeline.maxlen:
                self.history.append(json.dumps(self.timeline[0], separators=(",", ":")))
            self.timeline.append(line)
            self.line_cursors.append(cursor)

    def lines_before(self, before: int, limit: int) -> tuple[list[dict[str, Any]], int, int]:
        """The run's last `limit` lines before roko's cursor `before`, oldest first, as far as this fold keeps
        them; how many lines come before those; and how many of those are older than the fold keeps."""
        end = bisect_left(self.line_cursors, before)
        start = max(0, end - limit)
        kept_from = len(self.line_cursors) - len(self.timeline) - len(self.history)
        lines: list[dict[str, Any]] = []
        for at in range(max(start, kept_from), end):
            back = at - (len(self.line_cursors) - len(self.timeline))
            lines.append(dict(self.timeline[back]) if back >= 0 else json.loads(self.history[at - kept_from]))
        return lines, start, max(0, min(end, kept_from) - start)

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
                if task.attempt_log:  # the try's tool calls so far (P-1): roko publishes no turn count live
                    latest = task.attempt_log[-1]
                    latest["tool_steps"] = int(latest.get("tool_steps") or 0) + 1
            elif kind in ("text", "reasoning") and record.get("live") is True:
                # Keep a chunk that is only a space: roko streams words a token at a time, and the space
                # between two words can come on its own.
                text = clean(payload.get("text"), LIVE_TEXT_CHARS)
                if text:
                    joined = (task.live_text or "") + text
                    task.live_text = joined[-LIVE_TEXT_CHARS:]
        note = _stream_text(event.get("content"))
        said = harness_words(note) if note else None
        if (
            said is not None
        ):  # roko's own message in the agent's place: what stopped the try, not the agent's words
            if task.attempt_log:
                task.attempt_log[-1]["stopped"] = said
        elif note:
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
        # roko reports a try's spend as its checks end, before the next try's route: it is the latest try's.
        latest = task.attempt_log[-1] if task is not None and task.attempt_log else None
        if metric == "cost_usd":
            self.cost_usd += value
            self.saw_cost = True
            if task is not None and latest is not None and _is_number(latest.get("attempt")):
                # The try's spend is stated now: what call_cost said of it so far is in this figure.
                self.live.pop((task.plan_id, task.task_id, int(latest["attempt"])), None)
            if task is not None:
                task.cost_usd += value
                task.saw_cost = True
            if latest is not None:
                latest["cost_usd"] = latest.get("cost_usd", 0.0) + value
        elif metric in TOKEN_METRICS:
            self.tokens[TOKEN_METRICS[metric]] += int(value)
            if latest is not None:
                tokens = latest.setdefault("tokens", {})
                tokens[TOKEN_METRICS[metric]] = tokens.get(TOKEN_METRICS[metric], 0) + int(value)

    def _spec_gate(self, kind: str, event: dict[str, Any], at: int | None) -> None:
        """roko's spec gate (97d9b1819): started with its steps, each step as it ends, then how it ended."""
        if kind == "spec_gate_started" or self.spec_gate is None:
            total = event.get("steps_total")
            self.spec_gate = {
                "state": "running",
                "steps_total": int(total) if _is_number(total) and total >= 0 else None,
                "steps_done": 0,
                "cached": 0,
                "passed": 0,
                "ms": 0,
                "elapsed_ms": None,
                "blocked": None,
                "started_at": _iso_ms(at),
            }
        gate = self.spec_gate
        if kind == "spec_gate_step":
            gate["steps_done"] += 1
            gate["cached"] += 1 if event.get("cached") is True else 0
            gate["passed"] += 1 if event.get("passed") is True else 0
            took = event.get("ms")
            gate["ms"] += int(took) if _is_number(took) and took >= 0 else 0
        elif kind == "spec_gate_finished":
            gate["state"] = "done"
            for key in ("elapsed_ms", "blocked"):
                said = event.get(key)
                gate[key] = int(said) if _is_number(said) and said >= 0 else None

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


def _settle(task: TaskView, record: dict[str, Any], at: int | None, *, create: bool = True) -> None:
    """roko's verdict on one of a task's attempts, and where the attempt stood on the model ladder: its
    `attempt_settled` event (backlog R1), or the verdict line roko keeps in the run's attempts.jsonl
    (`roko.verdict/1`). Kept on the attempt's entry, whose try it then states exactly.

    `create`: a verdict on an attempt the run's events have not shown is one of its tries too (an event of
    the run's own); a record in the run's folder may be a later invocation's (a resume, which the hub calls
    another run), so it is not."""
    attempt = record.get("attempt")
    if not _is_number(attempt) or not 0 < attempt <= 10_000:
        return
    number = int(attempt)
    entry = next((row for row in reversed(task.attempt_log) if row.get("attempt") == number), None)
    if entry is None:  # an attempt whose agent never started (a cap stop), or whose rows are still to come
        if (
            not create
            or len(task.attempt_log) >= MAX_ATTEMPTS
            or any((row.get("attempt") or 0) > number for row in task.attempt_log)
        ):
            return
        entry = {"attempt": number, "model": None, "provider": None, "started_ms": None}
        entry["agent_to_come"] = True
        task.attempt_log.append(entry)
        task.attempts = max(task.attempts, number)
    settled = entry["settled"] = settled_view(record)
    if entry.get("model") is None:  # roko's record names the model that ran
        entry.update(model=settled["model"], provider=settled["provider"])
    if settled["exhausted"] and task.exhausted is None:
        task.exhausted = {
            "attempt": number,
            "rung": settled["rung"],
            "model": settled["model"],
            "suggestion": None,
        }
    if at is not None:
        entry["ended_ms"] = max(entry.get("ended_ms") or at, at)


def settled_view(record: dict[str, Any]) -> dict[str, Any]:
    """An attempt's settlement as its try reads it: from roko's `attempt_settled` event (R1's flat fields:
    rung, escalations, failures_on_rung, reason, blame, verdict, usage, cost_usd, duration_ms) or from its
    verdict record (`ladder`, `outcome`, `blame`, `usage`, `cost`, `timing`, `executed`, `steps`)."""
    ladder = loopevents.as_dict(record.get("ladder"))
    executed = loopevents.as_dict(record.get("executed"))
    timing = loopevents.as_dict(record.get("timing"))
    usage = loopevents.as_dict(record.get("usage"))
    verdict = record.get("verdict") or record.get("outcome")
    if isinstance(verdict, dict):
        verdict = verdict.get("outcome")
    cost = record.get("cost_usd")
    if cost is None:
        cost = loopevents.as_dict(record.get("cost")).get("billed_usd")
    duration = record.get("duration_ms")
    began, settled_at = timing.get("attempt_started_at"), timing.get("settled_at")
    if duration is None and _is_number(began) and _is_number(settled_at):
        duration = settled_at - began
    if "escalations" in record:
        # roko's attempt_settled gives the task's standing once the try counts: a try that moved the task up
        # (`climbed`) ran a rung below it. The verdict record's `ladder.step` is the step the try ran at.
        steps = record["escalations"]
        if record.get("climbed") is True and _is_number(steps) and steps > 0:
            steps -= 1
    else:
        steps = ladder.get("step")
    failures = record.get("failures_on_rung")
    tokens = {
        name: int(usage[key])
        for name, keys in (("input", ("in", "tokens_in")), ("output", ("out", "tokens_out")))
        for key in keys
        if _is_number(usage.get(key)) and usage[key] >= 0
    }
    for key in ("cache_read", "tokens_cache_read"):
        if _is_number(usage.get(key)) and usage[key] >= 0:
            tokens["cache_read"] = int(usage[key])
    chain = [clean(model, 120, one_line=True) for model in executed.get("failover_chain") or [] if model]
    refused = next((one for one in executed.get("failover_refusals") or [] if isinstance(one, dict)), {})
    return {
        "rung": clean(record.get("rung") or ladder.get("rung"), 40, one_line=True) or None,
        "escalations": int(steps) if _is_number(steps) and steps >= 0 else None,
        "failures_on_rung": int(failures) if _is_number(failures) and failures >= 0 else None,
        "reason": clean(record.get("reason") or ladder.get("reason"), 40, one_line=True) or None,
        "exhausted": ladder.get("exhausted") is True or record.get("exhausted") is True,
        "blame": clean(record.get("blame"), 20, one_line=True) or None,
        "verdict": clean(verdict, 40, one_line=True) or None,
        # attempt_settled's check that failed it (`custom:test`) and the first line of why it failed.
        "failed_check": clean(record.get("failed_check"), 120, one_line=True) or None,
        "detail": clean(record.get("detail"), WHY_CHARS, one_line=True) or None,
        "cost_usd": float(cost) if _is_number(cost) and cost >= 0 else None,
        "duration_ms": int(duration) if _is_number(duration) and duration >= 0 else None,
        # Where the try's time went: `phases` on attempt_settled, `timing.phases` on the verdict record.
        "phases": phases_view(record.get("phases") or timing.get("phases")),
        "usage": tokens,
        "turns": int(executed["turns"]) if _is_number(executed.get("turns")) else None,
        "model": clean(executed.get("model_dispatched") or record.get("model"), 120, one_line=True) or None,
        "provider": clean(executed.get("provider") or record.get("provider"), 80, one_line=True) or None,
        # The model failover passed over first (the routed one), its provider and roko's class for why.
        "failover": {
            "model": chain[0],
            "provider": clean(refused.get("provider"), 80, one_line=True) or None,
            "class": clean(refused.get("class"), 60, one_line=True) or None,
        }
        if chain
        else None,
        # Each verify step's verdict, exit code and time, in the order the checks ran.
        "steps": [
            {
                "rung": clean(step.get("rung"), 120, one_line=True) or None,
                "passed": step.get("passed") is True,
                "exit_code": int(step["exit_code"]) if _is_number(step.get("exit_code")) else None,
                "duration_ms": int(step["duration_ms"]) if _is_number(step.get("duration_ms")) else None,
            }
            for step in (record["steps"] if isinstance(record.get("steps"), list) else [])[:20]
            if isinstance(step, dict)
        ],
    }


PHASE_MS = (
    "queue_ms",
    "workspace_ms",
    "prompt_ms",
    "ttft_ms",
    "model_ms",
    "tools_ms",
    "checks_ms",
    "other_ms",
)
SPEC_GATE_FIELDS = (
    "state",
    "steps_total",
    "steps_done",
    "cached",
    "passed",
    "ms",
    "elapsed_ms",
    "blocked",
    "started_at",
)


def _span(value: Any) -> int | None:
    """A duration in ms: 0 or more; None when roko does not know it (it never sends 0 for unknown)."""
    return int(value) if _is_number(value) and value >= 0 else None


def phases_view(raw: Any) -> dict[str, Any] | None:
    """roko's split of a try's time (22de26a8c): each phase's ms, its model and tool calls, the time by tool
    (summed per call, so parallel calls can add up past `tools_ms`) and each check's. prompt, model, tools,
    checks and other make the try's duration; queue and workspace come before it. None from an older roko."""
    if not isinstance(raw, dict):
        return None
    view: dict[str, Any] = {key: _span(raw.get(key)) for key in PHASE_MS}
    view["model_calls"], view["tool_calls"] = _span(raw.get("model_calls")), _span(raw.get("tool_calls"))
    tools: list[Any] = raw["tools_by_name"] if isinstance(raw.get("tools_by_name"), list) else []
    checks: list[Any] = raw["checks"] if isinstance(raw.get("checks"), list) else []
    view["tools"] = [
        {
            "tool": clean(one["tool"], 60, one_line=True),
            "calls": _span(one.get("calls")),
            "ms": _span(one.get("ms")),
        }
        for one in tools[:8]
        if isinstance(one, dict) and one.get("tool")
    ]
    view["checks"] = [
        {
            "name": clean(one["name"], 120, one_line=True),
            "ms": _span(one.get("ms")),
            "passed": one.get("passed") is True,
        }
        for one in checks[:8]
        if isinstance(one, dict) and one.get("name")
    ]
    return view


def try_timing(settled: dict[str, Any], duration: int | None) -> dict[str, Any] | None:
    """Where a try's time went (`Try.timing`): roko's split (`basis: roko`), else its checks' times and the
    rest as the agent's (`basis: events`). `split` is false when model and tools are one span: a roko before
    f407b62e9 counted a tool's time as model time when the result ended in the model turn's millisecond
    (bug-15ba19), so tool calls with no tool time say the split was not measured."""
    phases = settled.get("phases")
    if phases is not None:
        return {
            "basis": "roko",
            **phases,
            "split": not (phases.get("tool_calls") and not phases.get("tools_ms")),
        }
    if duration is None:
        return None
    checks = [
        step["duration_ms"] for step in settled.get("steps") or [] if step.get("duration_ms") is not None
    ]
    spent = min(duration, sum(checks)) if checks else None
    return {"basis": "events", "agent_ms": duration - (spent or 0), "checks_ms": spent, "split": False}


def _check_printed(task: TaskView, event: dict[str, Any]) -> None:
    """A line a task's check printed (`gate_output_line`), onto the task's newest check: a check of another
    gate or try (roko's `attempt`, else the task's latest), or one that already ended, starts a new one.
    roko's own note that it skipped lines (`stream: roko`) marks the check, so its result's output, which
    keeps the end, replaces the lines when it ends."""
    gate = clean(event.get("gate"), 120, one_line=True) or "gate"
    attempt = loopevents.check_attempt(event) or _try_of(task)
    line = loopevents.check_text(event.get("line"))
    tail = task.check_tail
    if not (
        tail
        and tail["live"]
        and tail["passed"] is None
        and (tail["gate"], tail["attempt"]) == (gate, attempt)
    ):
        tail = task.check_tail = _new_tail(task, gate, live=True)
        tail["attempt"] = attempt
    if loopevents.check_stream(event) == "roko":
        tail["skipped"] = True
    if line.strip():
        tail["lines"].append(line)


def _check_ended(task: TaskView, gate: str, passed: bool, output: str) -> None:
    """A task's check ended (`gate_result`): its verdict onto the lines it printed, or, without them (or when
    roko skipped some of them), the end of the output roko gives with its result, its command line apart."""
    tail = task.check_tail
    lines = [line for line in output.splitlines() if line.strip() and line.strip() != "…"]
    if (
        tail
        and tail["live"]
        and tail["lines"]
        and tail["passed"] is None
        and (tail["gate"], tail["attempt"]) == (gate, _try_of(task))
        and not (tail.get("skipped") and lines)
    ):
        # The streamed lines stay; the result adds the command it ran and the exit status roko ends it with.
        tail["passed"] = passed
        if lines and lines[0].startswith("$ ") and tail["command"] is None:
            tail["command"] = clean(lines[0][2:], loopevents.CHECK_LINE_CHARS, one_line=True) or None
        tail["exit_code"] = next(
            (int(found[1]) for line in reversed(lines) if (found := _EXIT_STATUS.match(line))), None
        )
        return
    tail = task.check_tail = _new_tail(task, gate, live=False)
    tail["passed"] = passed
    if lines and lines[0].startswith("$ "):
        tail["command"] = clean(lines.pop(0)[2:], loopevents.CHECK_LINE_CHARS, one_line=True) or None
    tail["lines"].extend(loopevents.check_text(line) for line in lines[-CHECK_TAIL_LINES:])


def _new_tail(task: TaskView, gate: str, *, live: bool) -> dict[str, Any]:
    return {
        "attempt": _try_of(task),
        "gate": gate,
        "passed": None,
        "command": None,
        "lines": deque(maxlen=CHECK_TAIL_LINES),
        "live": live,
    }


def _try_of(task: TaskView) -> int | None:
    """The try a task's check is checking: its latest."""
    return task.attempt_log[-1].get("attempt") if task.attempt_log else (task.attempts or None)


def _run_bucket(buckets: Any) -> dict[str, Any] | None:
    """The run's own bucket in roko's `efficiency_trend_updated` (the last; a per-run one names its run): its
    cost, tasks, verified tasks and cost per verified task. None without one."""
    last = buckets[-1] if isinstance(buckets, list) and buckets else None
    if not isinstance(last, dict) or not last.get("run_id"):
        return None
    cost, each = last.get("cost_usd"), last.get("cost_per_verified_usd")
    return {
        "cost_usd": float(cost) if _is_number(cost) and cost >= 0 else None,
        "tasks": _whole(last.get("tasks")),
        "verified_tasks": _whole(last.get("verified_tasks")),
        "cost_per_verified_usd": float(each) if _is_number(each) and each >= 0 else None,
    }


# roko's run records (`.roko/runs/<run>/manifest.json`): the most manifests GET /learning reads, newest first,
# and the most bytes of each.
RECORDS_SCAN = 200
MANIFEST_BYTES = 256 * 1024
# Who started a run, by roko's `origin` (`cli`, `http`, `mcp:<client>`), in the pages' words.
ORIGINS = {"cli": "terminal", "http": "http"}


def run_records(workdir: Any, limit: int) -> list[dict[str, Any]] | None:
    """roko's records of the plan runs in its workspace (`.roko/runs/<run>/manifest.json`, one folder per run,
    its resumes included), newest first: of the newest RECORDS_SCAN folders, at most `limit` that closed, each
    with its id, plans, who started it (`origin`), when it ended and how. None without a workspace."""
    if not workdir:
        return None
    root = Path(workdir) / ".roko" / "runs"
    try:
        folders = [entry for entry in root.iterdir() if _RUN_DIR.match(entry.name)]
    except OSError:
        return []
    stamped = []
    for folder in folders:
        try:
            stamped.append((folder.joinpath("manifest.json").stat().st_mtime_ns, folder))
        except OSError:
            continue
    stamped.sort(key=lambda pair: pair[0], reverse=True)
    found: list[dict[str, Any]] = []
    for _, folder in stamped[:RECORDS_SCAN]:
        record = _manifest(folder / "manifest.json")
        if record is not None:
            found.append(record)
    found.sort(key=lambda record: str(record["ended_at"]), reverse=True)
    return found[:limit]


def _manifest(path: Path) -> dict[str, Any] | None:
    """A run's manifest as `run_records` gives it, or None when it did not close or does not parse."""
    try:
        with path.open("rb") as handle:
            data = json.loads(handle.read(MANIFEST_BYTES))
    except (OSError, ValueError):
        return None
    closed = data.get("closed") if isinstance(data, dict) else None
    if not isinstance(closed, dict) or not isinstance(data.get("run_id"), str):
        return None
    origin = clean(data.get("origin"), 80, one_line=True)
    return {
        "run_id": clean(data["run_id"], 120, one_line=True),
        "plan_ids": [clean(plan, 120, one_line=True) for plan in data.get("plan_ids") or [] if plan][:10],
        "origin": "chat" if origin.startswith("mcp:") else ORIGINS.get(origin),
        "ended_at": clean(closed.get("ended_at"), 40, one_line=True) or "",
        "state": clean(closed.get("status"), 40, one_line=True) or None,
    }


def record_learning(workdir: Any, run_id: str, ladder: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """What a run taught, from roko's records of its tries alone (`attempts.jsonl`, every invocation): its
    tasks on the ladder (`RungCount`s), what its tries cost, and its `learning_record`, without the lessons
    and prompts only its events tell (`kept`, `used` and `first_prompt` are None). None without records."""
    path = attempts_path(workdir, run_id)
    try:
        if path is None or path.stat().st_size > ATTEMPTS_BYTES:
            return None
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    fold = EventFold()
    for line in text.splitlines():
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if not isinstance(record, dict) or "outcome" not in record:
            continue  # an attempt-open line: its verdict comes later
        task = fold._task(
            clean(record.get("plan_id"), 120, one_line=True), clean(record.get("task_id"), 80, one_line=True)
        )
        if task is not None:
            _settle(task, record, None)
    rows = [task for task in fold.tasks.values() if task.attempt_log]
    if not rows:
        return None
    spent: list[float] = []
    for task in rows:
        last = task.attempt_log[-1].get("settled") or {}
        task.outcome = "passed" if SETTLED_OUTCOMES.get(str(last.get("verdict"))) == "passed" else "failed"
        costs = [
            float(entry["settled"]["cost_usd"])
            for entry in task.attempt_log
            if (entry.get("settled") or {}).get("cost_usd") is not None
        ]
        task.cost_usd, task.saw_cost = sum(costs), bool(costs)
        spent.extend(costs)
    card = {"tasks": [_task_card(task, ladder=ladder, ended=True) for task in rows], "roko_cost": None}
    learned = learning_record(card)
    learned.update(kept=None, used=None, first_prompt=None)
    return {
        "learning": learned,
        "rungs": rung_counts(rows, ladder, ended=True),
        "cost_usd": round(sum(spent), 6) if spent else None,
    }


def attempts_path(workdir: Any, run_id: str) -> Path | None:
    """Where roko keeps run `run_id`'s attempt records in the workspace, or None without a workspace or for
    an id that is not one roko gives."""
    if not workdir or not _RUN_DIR.match(run_id):
        return None
    return Path(workdir) / ".roko" / "runs" / run_id / "attempts.jsonl"


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


def harness_words(text: str) -> str | None:
    """What stopped an attempt, in words, when its last text is a message roko wrote in the agent's place: a
    turn cap, its immune boundary refusing the model's answer, the model's output limit, a network error, a
    budget stop. None for the agent's own words."""
    said = text.strip()
    if found := _ALLOWANCE_SAID.search(said):  # before "Budget exhausted:", which roko may put in front of it
        amount = f"${found[2]} of ${found[3]}" if found[3] else f"${found[2]}"
        return f"it spent its allowance on {found['rung']} ({amount})"
    if found := _TURN_CAP_SAID.match(said):
        return f"it hit its turn cap ({found[1]} turns)"
    if found := _DENIED_SAID.match(said):
        reason = found[1] or ""
        return DENIED_WORDS.get(reason) or (
            f"roko refused the model's answer: {reason.replace('_', ' ')}"
            if reason
            else "roko refused the model's answer"
        )
    if _OUTPUT_LIMIT_SAID.match(said):
        return "the model hit its output limit"
    if found := _NETWORK_SAID.match(said):
        return clean(f"the network failed: {found[1]}", 200, one_line=True)
    if said.lower().startswith("budget exhausted:"):
        return "roko stopped it at the run's cap"
    return None


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
    if kind == "event_log_entry" and str(event.get("event_type") or "") == "checkpoint.set_aside":
        # A plan run that started over, and how to bring back what it set aside (roko bug-cbdb6b, P-14).
        entry.update(group="run", plan_id=None, set_aside=True)
        entry["text"] = (
            clean(event.get("message"), 400, one_line=True) or "started over: the last run was set aside"
        )
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
            failed = _TOOL_ERROR.match(str(live.get("text") or "")) if live["kind"] == "result" else None
            if failed:  # roko's tool loop failed the call ("error: timed out after 60001 ms"): a problem line
                error = clean(failed[1], 160, one_line=True)
                entry.update(group="error", ring="L0", tool_error=error, passed=False)
                entry["attempt"] = live["attempt"]
                entry["text"] = f"{task} tool error: {error}"
                return entry
            if live["kind"] != "tool":
                return None  # live words stream to the pages; the transcript makes the line
            if live.get("screened") is False and not live.get("target"):
                return None  # in trusted mode, the twin of the screened step before it (same call, no target)
            entry.update(group="tool", ring="L0", tool=live["tool"], target=live["target"])
            entry["attempt"] = live["attempt"]
            entry["text"] = clean(f"{task} {live['tool']} {live['target'] or ''}".strip(), 400, one_line=True)
            return entry
        note = _stream_text(event.get("content"))
        if not note:
            return None
        said = harness_words(note)
        if said is not None:  # roko's message in the agent's place
            entry["stopped"] = True
            text = f"{task} stopped: {said}"
        else:
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
    if start is None or _ALLOWANCE_SAID.search(text):  # a try that spent its rung's allowance, not the cap
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
        # The size and time of the run's attempts.jsonl when it was last read (refresh_attempts).
        self.attempts_stamp: tuple[int, int] | None = None
        # Whether the last read reached the index's end (until then reads leave the words out, SKIP_BEHIND),
        # and whether roko takes the name (one that knows `skip` but not it answers 400).
        self.at_end = False
        self.skips = True

    def refresh_events(self, client: RokoClient, pages: int | None = None) -> bool:
        """Read the rows written since the last refresh, at most `pages` pages (MAX_PAGES): whether it read
        to the end of the run's index (or the run has none yet), not stopping at the page bound with more to
        read."""
        path = f"/api/runs/{quote(self.run_id, safe='')}/events"
        waits = 0
        for _ in range(MAX_PAGES if pages is None else pages):
            params: dict[str, Any] = {"cursor": self.fold.cursor, "limit": PAGE_LIMIT}
            if self.skips and not self.at_end:
                params["skip"] = SKIP_BEHIND
            try:
                page = client.get(path, params)
            except RokoError as exc:
                if exc.code is Code.RATE_LIMITED and waits < RATE_WAITS:
                    waits += 1
                    time.sleep(min(exc.retry_after_s or 1.0, RATE_WAIT_MAX_S))
                    continue
                if exc.code is Code.NOT_FOUND:  # a queued run has no index yet
                    self.index_missing = True
                    return True
                if exc.code is Code.INVALID and "skip" in params:  # ask again for every row
                    self.skips = False
                    continue
                if exc.code is Code.INVALID and self.fold.cursor:
                    # The index was rewritten under us (a repair): start over.
                    logger.debug("roko: event cursor for %s rejected, rereading", self.run_id)
                    self.fold = EventFold()
                    self.at_end, self.skips = False, True
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
            if page.get("skipped"):
                # Words it left out came between those read before and the next: a running task's live words
                # start again from the next ones read. They count as read (roko's `skipped_rows`).
                for task in self.fold.tasks.values():
                    task.live_text = None
                passed = page.get("skipped_rows")
                if isinstance(passed, int) and not isinstance(passed, bool) and passed > 0:
                    self.fold.rows += passed
            next_cursor = _int(page.get("next_cursor"))
            moved = next_cursor > self.fold.cursor
            self.fold.cursor = max(self.fold.cursor, next_cursor)
            self.at_end = not page.get("has_more")
            if not page.get("has_more") or not moved:
                return True
        return False

    def refresh_attempts(self, workdir: Any) -> None:
        """roko's verdict on each of the run's attempts, where the plugin shares roko's workspace: the run's
        record (`.roko/runs/<run>/attempts.jsonl`, `roko.verdict/1` lines) states each try exactly (its
        rung, why it ran there, its verdict and blame, cost and time), as roko's `attempt_settled` will once
        it publishes one (R1). Read again when it changes; nothing without the file."""
        path = attempts_path(workdir, self.run_id)
        try:
            info = path.stat() if path is not None else None
        except OSError:
            info = None
        if path is None or info is None or info.st_size > ATTEMPTS_BYTES:
            return
        stamp = (info.st_size, info.st_mtime_ns)
        if stamp == self.attempts_stamp:
            return
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return
        self.attempts_stamp = stamp
        for line in text.splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict):
                continue
            key = (
                clean(record.get("plan_id"), 120, one_line=True),
                clean(record.get("task_id"), 80, one_line=True),
            )
            task = self.fold.tasks.get(key)
            if task is None:
                if not self.at_end:  # a task the events have not reached yet: read the file again then
                    self.attempts_stamp = None
                continue
            retries = record.get("max_retries")  # on an attempt-open line (hermes-pilot P-11)
            if isinstance(retries, int) and not isinstance(retries, bool) and 0 <= retries <= 100:
                task.max_tries = retries + 1
            if "outcome" in record:  # else an attempt-open line: its verdict comes later
                _settle(task, record, None, create=False)

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
                    "tier": clean(task.get("tier"), 20, one_line=True) or None,
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
                view.tier = view.tier or authored.get("tier")
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
        self._models: dict[str, tuple[float, dict[str, dict[str, Any]]]] = {}
        self._providers: dict[str, tuple[float, dict[str, str] | None]] = {}
        self._knowledge: dict[str, tuple[float, dict[str, dict[str, Any]]]] = {}
        self._history: dict[str, tuple[float, list[dict[str, Any]]]] = {}
        self._ledger: dict[str, tuple[tuple[int, int, str], float | None]] = {}
        self._by_plan: dict[str, tuple[tuple[int, int], dict[str, Any]]] = {}
        self._tomls: dict[str, tuple[float, dict[str, Any]]] = {}
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
        return {key: str(row["slug"]) for key, row in self.models(client).items() if row.get("slug")}

    def models(self, client: RokoClient) -> dict[str, dict[str, Any]]:
        """roko's models by key (`GET /api/models`): slug, provider and the per-million prices its [models.*]
        entry names, at most a minute old; {} when roko will not list them."""
        key = client.settings.url
        with self._lock:
            cached = self._models.get(key)
        if cached is not None and time.monotonic() - cached[0] < PLANS_TTL_S:
            return cached[1]
        models: dict[str, dict[str, Any]] = {}
        try:
            body = client.get("/api/models")
        except RokoError as exc:
            logger.debug("roko: no model list: %s", exc)
            body = None
        listed = body.get("models") if isinstance(body, dict) else None
        for row in listed if isinstance(listed, list) else []:
            if isinstance(row, dict) and isinstance(row.get("key"), str) and isinstance(row.get("slug"), str):
                models[row["key"]] = {
                    "slug": clean(row["slug"], 120, one_line=True) or None,
                    "provider": clean(row.get("provider"), 80, one_line=True) or None,
                    "price_in": _price(row.get("cost_input_per_m")),
                    "price_out": _price(row.get("cost_output_per_m")),
                    "price_cache_read": _price(row.get("cost_cache_read_per_m")),
                    # Where roko's rates come from (gap-a5ebd4): its price snapshot, the profile, or built in.
                    "priced_by": clean(row.get("priced_by"), 20, one_line=True) or None,
                    "price_snapshot": clean(row.get("price_snapshot"), 80, one_line=True) or None,
                }
        with self._lock:
            self._models[key] = (time.monotonic(), models)
        return models

    def providers(self, client: RokoClient) -> dict[str, str] | None:
        """roko's providers by id and their kind (`GET /api/providers`), at most a minute old; None when roko
        will not list them."""
        key = client.settings.url
        with self._lock:
            cached = self._providers.get(key)
        if cached is not None and time.monotonic() - cached[0] < PLANS_TTL_S:
            return cached[1]
        kinds: dict[str, str] | None
        try:
            body = client.get("/api/providers")
        except RokoError as exc:
            logger.debug("roko: no provider list: %s", exc)
            body = None
        listed = body.get("providers") if isinstance(body, dict) else None
        if isinstance(listed, list):
            kinds = {
                str(row["id"]): clean(row.get("kind"), 40, one_line=True)
                for row in listed
                if isinstance(row, dict) and isinstance(row.get("id"), str)
            }
        else:
            kinds = None
        with self._lock:
            self._providers[key] = (time.monotonic(), kinds)
        return kinds

    def knowledge(self, client: RokoClient) -> dict[str, dict[str, Any]]:
        """roko's stored lessons by id (`GET /api/knowledge/entries`): the first 80 characters of each, its
        confidence and the episodes and confirmations behind it, at most a minute old; {} when roko will not
        list them."""
        key = client.settings.url
        with self._lock:
            cached = self._knowledge.get(key)
        if cached is not None and time.monotonic() - cached[0] < PLANS_TTL_S:
            return cached[1]
        try:
            body = client.get("/api/knowledge/entries")
        except RokoError as exc:
            logger.debug("roko: no knowledge entries: %s", exc)
            body = None
        items = body.get("items") if isinstance(body, dict) else None
        entries = {
            clean(row["id"], 120, one_line=True): {
                "text": clean(row.get("label"), 200) or None,
                "confidence": round(float(row["confidence"]), 3)
                if _is_number(row.get("confidence"))
                else None,
                "citations": int(row["citations"]) if _is_number(row.get("citations")) else None,
            }
            for row in (items if isinstance(items, list) else [])
            if isinstance(row, dict) and isinstance(row.get("id"), str)
        }
        with self._lock:
            self._knowledge[key] = (time.monotonic(), entries)
        return entries

    def roko_today(self, workdir: Path | None) -> float | None:
        """What roko recorded today (the UTC day) across its workspace, from its own daily ledger
        (`.roko/learn/costs.jsonl`, which `budget.max_daily_usd` reads too): runs from a terminal, other
        hosts' runs and helper calls included (P-3). Its last LEDGER_BYTES are read, again when it changes.
        None without the workspace or the ledger."""
        if workdir is None:
            return None
        path = Path(workdir) / ".roko" / "learn" / "costs.jsonl"
        day = datetime.now(UTC).date().isoformat()
        try:
            info = path.stat()
        except OSError:
            return None
        stamp = (info.st_size, info.st_mtime_ns, day)
        with self._lock:
            cached = self._ledger.get(str(path))
        if cached is not None and cached[0] == stamp:
            return cached[1]
        try:
            with path.open("rb") as handle:
                handle.seek(max(0, info.st_size - LEDGER_BYTES))
                text = handle.read().decode("utf-8", errors="replace")
        except OSError:
            return None
        total = 0.0
        for line in text.splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue  # a partial first line, or not a record
            if not isinstance(record, dict) or not _is_number(record.get("cost_usd")):
                continue
            when = _parse(str(record.get("timestamp") or ""))
            if when is not None and when.astimezone(UTC).date().isoformat() == day:
                total += float(record["cost_usd"])
        spent = round(total, 4)
        with self._lock:
            self._ledger[str(path)] = (stamp, spent)
        return spent

    def ledger_by_plan(self, workdir: Path | None) -> dict[str, Any] | None:
        """What roko recorded across its workspace, from its own ledger (`.roko/learn/costs.jsonl`, its last
        LEDGER_BYTES), by plan id: each plan's runs (its tasks' calls, helpers included) and its writing
        (the planner's calls, `generate`, and what roko ran after it), and the whole (round v7, #3: the
        build's money is roko's). None without the workspace or the ledger."""
        if workdir is None:
            return None
        path = Path(workdir) / ".roko" / "learn" / "costs.jsonl"
        try:
            info = path.stat()
        except OSError:
            return None
        stamp = (info.st_size, info.st_mtime_ns)
        with self._lock:
            cached = self._by_plan.get(str(path))
        if cached is not None and cached[0] == stamp:
            return cached[1]
        try:
            with path.open("rb") as handle:
                handle.seek(max(0, info.st_size - LEDGER_BYTES))
                text = handle.read().decode("utf-8", errors="replace")
        except OSError:
            return None
        plans: dict[str, dict[str, float]] = {}
        total = 0.0
        for line in text.splitlines():
            try:
                record = json.loads(line)
            except ValueError:
                continue
            if not isinstance(record, dict) or not _is_number(record.get("cost_usd")):
                continue
            cost = float(record["cost_usd"])
            total += cost
            plan = clean(record.get("plan_id"), 120, one_line=True)
            task = str(record.get("task_id") or "")
            part = "writing" if task == "generate" or task.startswith("plan:generate:") else "runs"
            row = plans.setdefault(plan, {"runs": 0.0, "writing": 0.0})
            row[part] += cost
        found = {"total": round(total, 6), "plans": plans}
        with self._lock:
            self._by_plan[str(path)] = (stamp, found)
        return found

    def task_history(self, client: RokoClient) -> list[dict[str, Any]]:
        """The newest tasks roko recorded in this workspace (`GET /api/learn/efficiency` `tasks`, at most
        TASK_HISTORY), oldest first: what each cost and how long its agent worked, at most a minute old; []
        when roko will not say."""
        key = client.settings.url
        with self._lock:
            cached = self._history.get(key)
        if cached is not None and time.monotonic() - cached[0] < PLANS_TTL_S:
            return cached[1]
        try:
            body = client.get("/api/learn/efficiency")
        except RokoError as exc:
            logger.debug("roko: no task history: %s", exc)
            body = None
        rows = body.get("tasks") if isinstance(body, dict) else None
        tasks = [
            {
                "cost_usd": float(row["cost_usd"]),
                "duration_ms": int(row["duration_ms"]) if _is_number(row.get("duration_ms")) else None,
            }
            for row in (rows if isinstance(rows, list) else [])
            if isinstance(row, dict) and _is_number(row.get("cost_usd")) and row["cost_usd"] >= 0
        ][-TASK_HISTORY:]
        with self._lock:
            self._history[key] = (time.monotonic(), tasks)
        return tasks

    def ladder_view(self, client: RokoClient | None, workdir: Any) -> list[dict[str, Any]] | None:
        """The workspace's model ladder (`Rung`s, docs/ui-api.md), cheapest first: roko.toml's rungs, each
        with its model's slug, provider and prices from roko's `/api/models` and whether a run from Hermes can
        use it. None when roko.toml names no rungs or turns the ladder off; without `client` (roko serve
        down), the rungs alone."""
        path = workdir if isinstance(workdir, Path) else Path(workdir) if workdir else None
        rungs = self.ladder(path)
        if not rungs:
            return None
        models = self.models(client) if client is not None else {}
        providers = self.providers(client) if client is not None else None
        local = self.toml_models(path)
        # Where each task tier starts: roko.toml's [routing.ladder.start], else roko's own (D11); a name that
        # matches no rung starts on the first, as roko starts it.
        names, named = [name for name, _ in rungs], self.ladder_starts(path)
        starts = {tier: named.get(tier, rung) for tier, rung in LADDER_STARTS.items()}
        starts = {tier: rung if rung in names else names[0] for tier, rung in starts.items()}
        out = []
        for name, model in rungs:
            # roko's (effective) entry first; the workspace's own for what roko serve does not give, such as
            # the cache-read rate, or everything when roko serve is down.
            served, own = resolve_model(model, models) or {}, resolve_model(model, local) or {}
            row = {
                key: served.get(key) if served.get(key) is not None else own.get(key) for key in own | served
            }
            provider = row.get("provider")
            kind = (providers or {}).get(str(provider)) if provider else None
            chat_ok = not (loopevents.is_cli_provider(kind) or loopevents.is_cli_provider(provider))
            why_not = None if chat_ok else "not for chat runs: its agent runs its own tools"
            if chat_ok and provider and providers is not None and provider not in providers:
                why_not = "its provider is not set up in this workspace"
            out.append(
                {
                    "rung": clean(name, 40, one_line=True),
                    "model": clean(model, 120, one_line=True),
                    "slug": row.get("slug"),
                    "provider": provider,
                    "price_in": row.get("price_in"),
                    "price_out": row.get("price_out"),
                    "price_cache_read": row.get("price_cache_read"),
                    "priced_by": served.get("priced_by")
                    or (
                        "roko.toml"
                        if row.get("price_in") is not None or row.get("price_out") is not None
                        else None
                    ),
                    "price_snapshot": served.get("price_snapshot"),
                    "chat_ok": chat_ok,
                    "why_not": why_not,
                    "starts": [tier for tier, rung in starts.items() if rung == name],
                }
            )
        return out

    def workspace_toml(self, workdir: Path | None) -> dict[str, Any]:
        """The workspace's roko.toml, parsed, read again when it changes; {} without one."""
        path = workdir / "roko.toml" if workdir is not None else None
        try:
            stamp = path.stat().st_mtime if path is not None else None
        except OSError:
            stamp = None
        if path is None or stamp is None:
            return {}
        with self._lock:
            cached = self._tomls.get(str(path))
        if cached is not None and cached[0] == stamp:
            return cached[1]
        try:
            data = tomllib.loads(path.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError, UnicodeDecodeError):
            data = {}
        with self._lock:
            self._tomls[str(path)] = (stamp, data)
        return data

    def ladder(self, workdir: Path | None) -> list[tuple[str, str]]:
        """The workspace roko.toml's model ladder, as (rung, model) pairs; [] when it names none."""
        data = self.workspace_toml(workdir)
        routing: dict[str, Any] = data["routing"] if isinstance(data.get("routing"), dict) else {}
        ladder: dict[str, Any] = routing["ladder"] if isinstance(routing.get("ladder"), dict) else {}
        if ladder.get("enabled") is False:  # an off ladder routes nothing: it names no rungs
            return []
        return [
            (rung["name"], rung["model"])
            for rung in ladder.get("rungs") or []
            if isinstance(rung, dict)
            and isinstance(rung.get("name"), str)
            and isinstance(rung.get("model"), str)
        ]

    def ladder_starts(self, workdir: Path | None) -> dict[str, str]:
        """The workspace roko.toml's start rung for each task tier it names ([routing.ladder.start])."""
        data = self.workspace_toml(workdir)
        routing: dict[str, Any] = data["routing"] if isinstance(data.get("routing"), dict) else {}
        ladder: dict[str, Any] = routing["ladder"] if isinstance(routing.get("ladder"), dict) else {}
        start: dict[str, Any] = ladder["start"] if isinstance(ladder.get("start"), dict) else {}
        return {tier: rung for tier, rung in start.items() if tier in LADDER_STARTS and isinstance(rung, str)}

    def toml_models(self, workdir: Path | None) -> dict[str, dict[str, Any]]:
        """The workspace roko.toml's own [models.*] entries, as `models` gives roko's: the rates it names."""
        data = self.workspace_toml(workdir)
        table = data["models"] if isinstance(data.get("models"), dict) else {}
        return {
            key: {
                "slug": clean(entry.get("slug"), 120, one_line=True) or None,
                "provider": clean(entry.get("provider"), 80, one_line=True) or None,
                "price_in": _price(entry.get("cost_input_per_m")),
                "price_out": _price(entry.get("cost_output_per_m")),
                "price_cache_read": _price(entry.get("cost_cache_read_per_m")),
            }
            for key, entry in table.items()
            if isinstance(key, str) and isinstance(entry, dict)
        }

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
    ladder = cache.ladder_view(client, workdir)  # the ladder its tasks climb (0.6.0)
    with tracker.lock:
        if tracker.final is not None and terminal:
            card = dict(tracker.final)
        else:
            # run_status already answered, so roko is up: a part that fails now
            # leaves a gap in the card, not an error instead of it.
            problems: list[str] = []
            # Whether the events were read to the end of the run's index: a long run's (a real phase's runs
            # past 100,000 rows) takes several refreshes, and until then its card is what they read so far.
            read = False
            try:
                first = min(FIRST_PAGES, MAX_PAGES) if tracker.fold.rows == 0 else None
                read = tracker.refresh_events(client, first)
            except RokoError as exc:
                problems.append(exc.message)
            steps: tuple[Callable[[], None], ...] = (
                lambda: tracker.refresh_attempts(workdir),
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
            # roko's summary reads only its first 10,000 events (bug-e529e3): when the events say the run
            # ended while the summary still says it goes, the events are right (P-1).
            behind = not terminal and tracker.fold.completed is not None
            if behind:
                state, terminal = events_state(tracker), True
            stopped = interruption(client, cache, tracker, summary, logged)
            if stopped is not None:
                state, terminal = "interrupted", True
            card = _compose(tracker, run_id, state, summary, logged, ladder=ladder)
            card["summary_behind"] = behind
            card["interrupted"] = stopped
            if stopped is not None:
                card.update(verdict="interrupted", finished_at=card.get("finished_at") or stopped.get("at"))
            card["problems"] = problems
            card["reading"] = not read
            # A finished run's events never change, so its card is kept once they are all read; the
            # parts that can (what waits, the branch) are refreshed below. A run
            # the plugin found interrupted is not: roko may yet record its end.
            if (
                terminal
                and read
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
        _name_the_lessons(card, cache, client)
        card["ladder"] = ladder
        if terminal:
            delivered = _delivered(tracker, workdir, run_id, summary)
            if delivered is not None:
                card.update(delivered)
            card["work"] = _work(tracker, workdir, run_id, summary, card)
            card["merge"] = _merge(tracker, workdir, run_id, card)
            card["checking"] = None
        else:
            card["checking"] = checking(tracker, state)
        card["receipt"] = receipt(card) if terminal else None  # the strip its end prints (0.6.0)
    if card.get("reading"):
        roko_totals(card, summary)
    elif terminal and state != "succeeded" and card.get("kind") != "plan_generate":
        card["why"] = explain(cache, client.settings.url, card)
    card["next"] = next_action(card, max_run_usd=client.settings.max_run_usd)
    card["headline"] = headline(card)
    card["checked_at"] = now_iso()
    return card


def roko_totals(card: dict[str, Any], summary: dict[str, Any]) -> None:
    """A long run read partway (hermes-pilot P-17): its spend and task counts are roko's own, from its
    summary, which skips the agents' words; no receipt or why is drawn from half a run. The events fill in the
    rest."""
    reported = summary.get("cost_usd")
    if _is_number(reported) and reported >= 0:
        card["cost_usd"] = round(float(reported), 6)
    counts = summary.get("tasks")
    if isinstance(counts, dict) and _int(counts.get("total")):
        card["progress"] = progress_of_counts(counts, card.get("state") in TERMINAL_STATES)
    card["receipt"] = None


def totals_agree(logged: dict[str, Any], summary: dict[str, Any]) -> bool:
    """Whether a run's kept task counts and spend are roko's own (its summary's), to a cent or 2%."""
    counts, kept = summary.get("tasks"), logged.get("progress")
    if isinstance(counts, dict) and _int(counts.get("total")) and isinstance(kept, dict):
        theirs = (_int(counts.get("total")), _int(counts.get("passed")))
        if theirs != (_int(kept.get("total")), _int(kept.get("passed"))):
            return False
    reported, cost = summary.get("cost_usd"), logged.get("cost_usd")
    if _is_number(reported) and _is_number(cost):
        return abs(float(reported) - float(cost)) <= max(0.01, 0.02 * float(reported))
    # No spend kept where roko reports some (hermes-pilot P-23: a cancelled run read "—" for its $0.025).
    return not (_is_number(reported) and float(reported) > 0)


def progress_of_counts(counts: dict[str, Any], ended: bool) -> dict[str, int]:
    """roko's summary task counts as a `progress`: what has not ended is running while the run goes."""
    out = dict.fromkeys(
        ("total", "passed", "failed", "running", "pending", "blocked", "stopped", "unverified", "skipped"), 0
    )
    out.update(
        total=_int(counts.get("total")),
        passed=_int(counts.get("passed")),
        failed=_int(counts.get("failed")),
        unverified=_int(counts.get("unverified")),
        stopped=_int(counts.get("cancelled")),
    )
    rest = out["total"] - out["passed"] - out["failed"] - out["unverified"] - out["stopped"]
    out["stopped" if ended else "running"] += max(0, rest)
    return out


def events_state(tracker: RunTracker) -> str:
    """How a run ended, as its own `run_completed` event says (`succeeded`, `failed`, `cancelled`,
    `interrupted`): for a run roko's summary still calls going. A run that succeeded with no check on any task
    reads unverified, as roko's summary would have said."""
    outcome = str((tracker.fold.completed or {}).get("outcome") or "")
    if outcome in ("succeeded", "completed"):
        rows = tracker.task_rows()
        if rows and all(task.outcome == "unverified" for task in rows):
            return "unverified"
        return "succeeded"
    return outcome if outcome in TERMINAL_STATES else "failed"


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


def _name_the_lessons(card: dict[str, Any], cache: CardCache, client: RokoClient) -> None:
    """Each lesson in a try's prompt, named: as the task of this run that kept it wrote it, else roko's label
    for it, with roko's confidence in it and the episodes and confirmations behind it."""
    tasks = [task for task in card.get("tasks") or [] if isinstance(task, dict)]
    lessons = [
        lesson
        for task in tasks
        for one in task.get("climb") or []
        for lesson in (one.get("prompt") or {}).get("lessons") or []
    ]
    if not lessons:
        return
    # What this run's tasks wrote of each lesson (its whole text, where roko lists 80 characters), and which
    # of them kept it (a task that confirmed a lesson roko had did not).
    written: dict[str, str] = {}
    kept: dict[str, str] = {}
    for task in tasks:
        for lesson in task.get("lessons") or []:
            ident = str(lesson.get("entry_id") or "")
            if ident and lesson.get("lesson"):
                written.setdefault(ident, str(lesson["lesson"]))
            if ident and lesson.get("admission") in _KEPT_LESSONS:
                kept.setdefault(ident, str(task.get("task_id")))
    known = cache.knowledge(client)
    for lesson in lessons:
        row = known.get(lesson["id"]) or {}
        lesson["kept_by"] = kept.get(lesson["id"])
        lesson["text"] = written.get(lesson["id"]) or row.get("text")
        lesson["confidence"], lesson["citations"] = row.get("confidence"), row.get("citations")


def resolve_model(name: str, models: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """The `/api/models` row a ladder rung's model names, as roko resolves it (roko-core `resolve_model`): by
    key, then by slug, then a slug the name starts (at a separator). None when roko lists no such model."""
    if name in models:
        return models[name]
    for row in models.values():
        if row.get("slug") == name:
            return row
    for row in models.values():
        slug = str(row.get("slug") or "")
        if len(slug) > len(name) and slug.startswith(name) and slug[len(name)] in "-._":
            return row
    return None


def _price(value: Any) -> float | None:
    """A per-million price roko gives, or None for one it does not."""
    return round(float(value), 6) if _is_number(value) and value >= 0 else None


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
    resume = _resume(card) if state == "failed" else None
    if resume is not None:
        return resume
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


def _resume(card: dict[str, Any]) -> dict[str, Any] | None:
    """For a plan run whose tasks got going and did not all pass: resume the plan, which keeps what passed and
    runs the rest (dogfood U2: the person had to find that switch in the Run dialog). None otherwise."""
    tasks = [task for task in card.get("tasks") or [] if isinstance(task, dict)]
    if card.get("kind") != "plan" or not card.get("plan_id") or card.get("demo"):
        return None
    if not any(task.get("outcome") not in ("pending", None) for task in tasks):
        return None  # nothing ran: why roko did not start it comes first
    # What passed: the tasks that say so, and the ones whose verified work roko kept on a plan branch.
    kept = {
        str(done.get("task_id"))
        for part in (card.get("work") or {}).get("parts") or []
        if isinstance(part, dict) and part.get("trust") == "verified"
        for done in part.get("tasks") or []
        if isinstance(done, dict)
    }
    passed = {str(task.get("task_id")) for task in tasks if task.get("outcome") in _PASSED_OUTCOMES} | kept
    missed = [
        str(task.get("task_id"))
        for task in tasks
        if str(task.get("task_id")) not in passed and task.get("outcome") != "skipped"
    ]
    if not missed:
        return None
    why = f"{_join_names(missed)} did not pass; " + (
        "a resume keeps what passed and runs the rest" if passed else "a resume runs them again"
    )
    return {"action": "rerun", "label": "resume the plan", "why": why, "resume": True}


def spent_so_far(fold: EventFold, cost: float | None, *, ended: bool) -> float | None:
    """A run's spend: what roko stated (`cost`), and while it runs, what its running tries' model calls cost
    so far (`call_cost`). The card, the run's row and the status chip all read this one figure (phase 2's S2
    stills: the header said $0.732, the row and the chip $0.61)."""
    if fold.live_cost_usd > 0 and not ended:
        return round((cost or 0.0) + fold.live_cost_usd, 6)
    return cost


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
    ladder = cache.ladder_view(client, client.settings.workdir)
    with tracker.lock:
        if tracker.final is not None and terminal:
            known = {
                key: tracker.final.get(key)
                for key in (
                    "state",
                    "cost_usd",
                    "finished_at",
                    "events_read",
                    "progress",
                    "interrupted",
                    "rungs",
                )
            } | run_facts(tracker.task_rows())
            if isinstance(tracker.final.get("budget_stop"), dict):  # a row that ended says it stopped at once
                known["budget_stop"] = budget_stop_row(tracker.final["budget_stop"])
            return known
        read = tracker.refresh_events(client)
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
        settled = terminal and read and (tracker.has_index or tracker.index_missing)
        rows = tracker.task_rows()
        totals: dict[str, Any] = {
            "state": state,
            "cost_usd": spent_so_far(
                fold, round(fold.cost_usd, 6) if fold.saw_cost else None, ended=terminal
            ),
            "finished_at": (tracker.finished_at or (stopped or {}).get("at")) if terminal else None,
            "events_read": fold.rows if settled else None,
            "progress": progress([{"outcome": task.outcome} for task in rows]) if rows else None,
            "rungs": rung_counts(rows, ladder, ended=terminal) if rows else None,
            "interrupted": stopped,
        }
        if not read:  # a long run read partway: roko's own totals (hermes-pilot P-17)
            roko_totals(totals, summary)
            totals.pop("receipt", None)
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
    *,
    ladder: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    fold = tracker.fold
    logged = logged or {}
    kind = logged.get("kind") or _kind_from_plans(run_id, tracker.plan_ids)
    plan_id = logged.get("plan_id") or (tracker.plan_ids[0] if kind == "plan" and tracker.plan_ids else None)
    cost: float | None = round(fold.cost_usd, 6) if fold.saw_cost else None
    reported = summary.get("cost_usd")
    if cost is None and isinstance(reported, (int, float)) and reported > 0:
        cost = float(reported)
    cost = spent_so_far(fold, cost, ended=state in TERMINAL_STATES)
    started_at = tracker.started_at
    finished_at = tracker.finished_at
    duration_ms = (fold.completed or {}).get("duration_ms") or _between(started_at, finished_at)
    # A run Hermes started came over /mcp, whose runs carry the `stage` outbound policy: a CLI agent that runs
    # its own tools cannot honour it, so the route panel marks those models as not for this run.
    chat_run = bool(logged) or str(tracker.origin or "").startswith("mcp:")
    ended = state in TERMINAL_STATES
    tasks = [_task_card(task, chat_run=chat_run, ladder=ladder, ended=ended) for task in tracker.task_rows()]
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
        "label": clean(name or plan_id or f"run {short_run_id(run_id)}", 120, one_line=True),
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
        # Its tasks on the ladder, for the mini ladder (0.6.0).
        "rungs": rung_counts(tracker.task_rows(), ladder, ended=ended),
        # M1's homeostat as the run last saw it, and roko's own figures for the run as it ended (0.6.0).
        "homeostat": homeostat_view(fold),
        "spec_gate": fold.spec_gate_view(),
        "roko_cost": dict(fold.roko_cost) if fold.roko_cost else None,
        "graph": graph(tasks),
        "eta_minutes": fold.eta_minutes if state == "running" else None,
        "eta_at": _iso_ms(fold.eta_ms) if state == "running" else None,
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
        # The run Hermes resumed with this one (0.6.0, dogfood U10); views adds the chain.
        "resumes": logged.get("resumes") if isinstance(logged.get("resumes"), str) else None,
        "events_read": fold.rows,
    }
    return card


def homeostat_view(fold: EventFold) -> dict[str, Any] | None:
    """M1's essential variables as the run last saw them, in the homeostat's order, and its controller's last
    act (`Homeostat`, docs/ui-api.md); None when the run saw neither."""
    if not fold.essential and fold.controller is None:
        return None
    order = list(loopevents.EV_WORDS)
    named = sorted(
        fold.essential.values(), key=lambda view: order.index(view["ev"]) if view["ev"] in order else 9
    )
    return {
        "variables": [dict(view) for view in named],
        "controller": dict(fold.controller) if fold.controller else None,
    }


def learning_record(card: dict[str, Any]) -> dict[str, Any]:
    """What an ended run taught, kept in the run log for `GET /learning`: its tasks that ran, passed and
    passed on their first try, its climbs, the lessons its tasks kept and the ones its prompts carried (with
    how each task that carried one did), and roko's own cost per verified task."""
    tasks = [task for task in card.get("tasks") or [] if isinstance(task, dict) and task.get("climb")]
    passed = [task for task in tasks if task.get("outcome") in _PASSED_OUTCOMES]
    first = [task for task in tasks if task["climb"][0].get("outcome") == "passed"]
    kept = [
        {"id": str(lesson["entry_id"]), "task": task.get("task_id"), "text": lesson.get("lesson")}
        for task in card.get("tasks") or []
        if isinstance(task, dict)
        for lesson in task.get("lessons") or []
        if lesson.get("entry_id") and lesson.get("admission") in _KEPT_LESSONS
    ]
    used: list[dict[str, Any]] = []
    with_lessons, without, withheld = [0, 0], [0, 0], [0, 0]
    for task in tasks:
        tries, seen = task["climb"], set()
        if isinstance(tries[0].get("lesson_ids"), list):  # what the task's first prompt carried
            # roko's control arm held its lessons back at random (prompt_assembled left_out `withheld_arm`).
            left_out = (tries[0].get("prompt") or {}).get("left_out") or []
            held = any(
                isinstance(item, dict)
                and item.get("kind") == "knowledge"
                and item.get("reason") == "withheld_arm"
                for item in left_out
            )
            tally = with_lessons if tries[0]["lesson_ids"] else withheld if held else without
            tally[0] += 1 if tries[0].get("outcome") == "passed" else 0
            tally[1] += 1
        for index, one in enumerate(tries):
            for ident in one.get("lesson_ids") or []:
                if ident in seen:
                    continue
                seen.add(ident)
                used.append(
                    {
                        "id": ident,
                        "task": task.get("task_id"),
                        "first_try": index == 0 and one.get("outcome") == "passed",
                        "climbed": any(later.get("reason") == "climb" for later in tries[index:]),
                        "passed": task.get("outcome") in _PASSED_OUTCOMES,
                    }
                )
    roko = card.get("roko_cost") or {}
    seen_prompts = any(isinstance(one.get("lesson_ids"), list) for task in tasks for one in task["climb"])
    return {
        "tasks": len(tasks),
        "passed": len(passed),
        "first_try": len(first),
        "climbs": sum(1 for task in tasks for one in task["climb"] if one.get("reason") == "climb"),
        # Bounded: the run log keeps it for each of its runs.
        "kept": kept[:10],
        "used": used[:20],
        "first_prompt": {"with": with_lessons, "without": without, "withheld": withheld}
        if seen_prompts
        else None,
        "roko_cost_per_pass": roko.get("cost_per_verified_usd"),
        # roko's own cost of the run and its verified tasks (model and helper calls together), for the KPI's
        # sums.
        "roko_cost_usd": roko.get("cost_usd"),
        "roko_verified": roko.get("verified_tasks"),
    }


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
        # What became of the checks the request states, as roko's planner reports them (gap-dc5d7c, 0.6.0).
        "source_checks": source_checks_view((result or {}).get("source_checks"), logged.get("spec_path")),
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


# `cannot_run` since roko gap-ecafde (08d4fe558): a step covers the check, but cannot pass as written.
SOURCE_CHECK_STATUSES = ("kept", "cannot_run", "shallow", "dropped", "missing")
MAX_SOURCE_CHECKS = 40


def source_checks_view(value: Any, spec_path: Any = None) -> dict[str, Any] | None:
    """A plan writing's `source_checks` (`SourceChecks`, docs/ui-api.md): roko's counts of the checks the
    request states that the plan keeps, covers with a step that cannot pass as written, keeps shallowly, drops
    with a reason or misses, and each check; and the files they come from (`from`): the spec the plan was
    written from (P-6), else the documents its request names, which roko read (gap-ac6b9b). None when roko
    reports none."""
    if not isinstance(value, dict) or not _is_number(value.get("total")):
        return None
    rows = value.get("checks")
    documents = value.get("documents")
    named = documents if isinstance(documents, list) else []
    return {
        **{key: _int(value.get(key)) for key in ("total", *SOURCE_CHECK_STATUSES)},
        "regenerated": value.get("regenerated") is True,
        "from": [clean(spec_path, 200, one_line=True)]
        if isinstance(spec_path, str) and spec_path
        else [clean(path, 200, one_line=True) for path in named[:5] if isinstance(path, str) and path],
        "checks": [
            {
                "id": clean(row.get("id"), 20, one_line=True) or None,
                "check": clean(row.get("check"), 300, one_line=True),
                "status": row["status"],
                "task": clean(row.get("task"), 80, one_line=True) or None,
                "criterion": clean(row.get("criterion"), 20, one_line=True) or None,
                "reason": clean(row.get("reason"), 300, one_line=True) or None,
            }
            for row in (rows if isinstance(rows, list) else [])[:MAX_SOURCE_CHECKS]
            if isinstance(row, dict) and row.get("status") in SOURCE_CHECK_STATUSES
        ],
    }


def _task_card(
    task: TaskView,
    *,
    chat_run: bool = False,
    ladder: list[dict[str, Any]] | None = None,
    ended: bool = False,
) -> dict[str, Any]:
    routes = [loopevents.route_view(entry.get("route"), chat_run=chat_run) for entry in task.attempt_log]
    tries = climb(task, ladder, ended=ended)
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
        # Its tier, so the Ladder places a task not started yet on its tier's start rung (P-36).
        "tier": task.tier,
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
        # Its tries on the model ladder, its tries on the rung it stands on, and what its newest check
        # printed (0.6.0).
        "climb": tries,
        "lives": lives(task, tries),
        "tries_allowed": task.max_tries,
        "check_tail": check_tail_view(task),
        # It failed on its top rung with no try left: split or replan it (0.6.0).
        "exhausted": dict(task.exhausted) if task.exhausted else None,
    }
    if task.blocked_by or task.reason:
        row["blocked_by"] = task.blocked_by
        row["reason"] = task.reason
    if task.outcome in OUTCOME_WORDS:  # roko's own word, plainer: the pages know "passed" and "skipped"
        row["outcome"], row["reason"] = OUTCOME_WORDS[task.outcome]
        row.setdefault("blocked_by", None)
    return row


def climb(
    task: TaskView, ladder: list[dict[str, Any]] | None, *, ended: bool = False
) -> list[dict[str, Any]]:
    """A task's tries, oldest first (`Try`, docs/ui-api.md): the rung each ran on and why it ran there, how
    it ended, its first failed check with that check's key line, its cost and its time. roko's
    `attempt_settled` states a try exactly; before roko sends it, the route, agent and check events tell.
    `ended`: the run ended, so a try still going was stopped under it."""
    places, named = ladder_places(ladder)
    tries: list[dict[str, Any]] = []
    for index, entry in enumerate(task.attempt_log):
        settled: dict[str, Any] = entry.get("settled") or {}
        route: dict[str, Any] = entry.get("route") or {}
        # The model it ran on: roko's verdict on the try names it, else its route; an agent's row last, as
        # roko names its run-level agent "claude" for a run serve starts (P-2, bug-c7de28).
        model = settled.get("model") or route.get("model") or entry.get("model")
        rung = settled.get("rung") or route.get("rung") or (named.get(str(model)) if model else None)
        failover = _failover(entry, route, settled)
        # roko's word (route_decided's ladder_reason, attempt_settled's reason), else worked out from the
        # rungs. A verdict record's reason says how its rung was chosen: `escalated` marks every try above the
        # start rung, not only the one that climbed.
        said = route.get("ladder_reason") or settled.get("reason")
        if (
            said == "pinned"
            or settled.get("reason") == "pinned"
            or loopevents.decided_by(route.get("source")) == "pinned"
        ):
            reason = "pinned"
        elif failover is not None:
            reason = "failover"
        elif said == "climb" or (
            index
            and said not in ("start", "retry")
            and _climbed(task.attempt_log[:index], tries, settled, rung, places)
        ):
            reason = "climb"
        else:
            reason = "retry" if index else "start"
        outcome = _try_outcome(task, entry, latest=index == len(task.attempt_log) - 1, ended=ended)
        started, last = entry.get("started_ms"), entry.get("ended_ms")
        duration = settled.get("duration_ms")
        if duration is None and outcome != "running" and started is not None and last is not None:
            duration = max(0, last - started)
        cost = settled["cost_usd"] if settled.get("cost_usd") is not None else entry.get("cost_usd")
        if cost is None and outcome == "running":
            cost = entry.get("live_cost_usd")  # what its model calls cost so far (call_cost)
        failed = entry.get("failed") or (
            {"gate": check_of(task, settled["failed_check"]), "key_line": None}
            if settled.get("failed_check")
            else {}
        )
        number = entry.get("attempt")
        prompt = _try_prompt(task.prompts.get(number)) if isinstance(number, int) else None
        feedback = task.feedback.get(number) if isinstance(number, int) else None
        tries.append(
            {
                "attempt": entry.get("attempt"),
                "rung": rung,
                "model": model,
                "provider": entry.get("provider"),
                "reason": reason,
                "outcome": outcome,
                "failed_check": failed.get("gate"),
                "key_line": failed.get("key_line"),
                "cost_usd": round(cost, 6) if cost is not None else None,
                "tokens": try_tokens(settled),
                "tool_steps": entry.get("tool_steps"),
                "duration_ms": duration,
                "timing": try_timing(settled, duration),
                "started_at": _iso_ms(started),
                "lesson_ids": [lesson["id"] for lesson in prompt["lessons"]] if prompt is not None else None,
                "failover": failover,
                "blame": settled.get("blame"),
                "source": "roko" if settled else "events",
                "why": _why(task, entry, outcome, latest=index == len(task.attempt_log) - 1),
                "verdict": settled.get("verdict"),
                "prompt": prompt,
                "feedback": dict(feedback) if feedback is not None else None,
            }
        )
    return tries


def try_tokens(settled: dict[str, Any]) -> dict[str, Any] | None:
    """A try's tokens as roko counted them (`Try.tokens`: attempt_settled's `usage`, or its verdict record's):
    input, output and cache read; None when roko does not say both input and output."""
    usage = settled.get("usage") or {}
    if usage.get("input") is None or usage.get("output") is None:
        return None
    return {"input": usage["input"], "output": usage["output"], "cache_read": usage.get("cache_read")}


def _try_prompt(kept: dict[str, Any] | None) -> dict[str, Any] | None:
    """A try's `prompt` (`TryPrompt`) from what its prompt_assembled said; its lessons' text, confidence and
    keeper are filled in once the card is built (`_name_the_lessons`)."""
    if kept is None:
        return None
    lessons = [
        {"id": ident, "text": None, "confidence": None, "citations": None, "kept_by": None}
        for ident in kept["lessons"]
    ]
    return {**kept, "lessons": lessons, "left_out": [dict(item) for item in kept["left_out"]]}


def _why(task: TaskView, entry: dict[str, Any], outcome: str, *, latest: bool) -> str | None:
    """What ended a try that did not pass, in words (`Try.why`): roko's own message in the agent's place, its
    verdict, the check that failed, or the cap it stopped at. None while it runs, and when it passed."""
    if outcome in ("passed", "running"):
        return None
    settled: dict[str, Any] = entry.get("settled") or {}
    verdict, stopped = settled.get("verdict"), entry.get("stopped")
    failed = entry.get("failed") or {}
    gate = failed.get("gate") or check_of(task, settled.get("failed_check"))
    check = f"its check {gate} failed" if gate else "its check failed"
    if verdict == "gate_failed" or (verdict is None and failed):
        return check
    if stopped:  # roko's own words for what stopped it say more than its verdict ("provider_error")
        return str(stopped)
    if settled.get("detail"):  # attempt_settled's first line of why ("turn_cap: agent turn cap reached …")
        said = harness_words(_VERDICT_PREFIX.sub("", str(settled["detail"])))
        if said:
            return said
    if verdict == "turn_cap":
        turns = settled.get("turns")
        return f"it hit its turn cap ({turns} turns)" if turns else "it hit its turn cap"
    if verdict in VERDICT_WORDS:
        return VERDICT_WORDS[verdict]
    if latest and task.cap_stop:
        return "roko stopped it at the run's cap"
    if outcome == "unverified":
        return "no check ran"
    if verdict:
        return str(verdict).replace("_", " ")
    return "the run stopped while it ran" if outcome == "stopped" else None


def prompt_view(event: dict[str, Any]) -> dict[str, Any]:
    """What roko's `prompt_assembled` says a try's prompt carried, cleaned and bounded."""
    left = event.get("left_out")
    return {
        "lessons": _ids(event.get("knowledge_ids")),
        "playbook_ids": _ids(event.get("playbook_ids")),
        "episodes": len(_ids(event.get("episode_ids"))),
        "left_out": [
            {
                "kind": clean(item.get("kind"), 20, one_line=True) or None,
                "id": clean(item.get("id"), 120, one_line=True) or None,
                "reason": clean(item.get("reason"), 40, one_line=True) or None,
            }
            for item in (left if isinstance(left, list) else [])[:20]
            if isinstance(item, dict)
        ],
        "sections": _ids(event.get("included_sections")),
        "dropped_sections": _ids(event.get("dropped_sections")),
        "estimated_tokens": int(event["estimated_tokens"])
        if _is_number(event.get("estimated_tokens"))
        else None,
    }


def feedback_view(event: dict[str, Any]) -> dict[str, Any]:
    """What roko's `retry_feedback` says a failed check left the next try (`TryFeedback`)."""
    attempt = event.get("attempt")
    steps, errors = event.get("failing_steps"), event.get("errors")
    return {
        "from_attempt": int(attempt) if _is_number(attempt) else None,
        "check": clean(event.get("check"), 80, one_line=True) or None,
        "failing_steps": [
            clean(step, 400, one_line=True) for step in (steps if isinstance(steps, list) else [])[:10]
        ],
        "diagnosis": clean(event.get("diagnosis"), WHY_CHARS) or None,
        "errors": [
            clean(line, 300, one_line=True) for line in (errors if isinstance(errors, list) else [])[:5]
        ],
    }


def _ids(value: Any) -> list[str]:
    """A list of ids (or names) roko gives, cleaned; [] for anything else."""
    return [
        clean(item, 120, one_line=True) for item in (value if isinstance(value, list) else [])[:50] if item
    ]


def _keep(kept: dict[int, dict[str, Any]], attempt: Any, view: dict[str, Any]) -> None:
    """Keep `view` for attempt `attempt` (from 1), at most MAX_ATTEMPTS attempts."""
    if not _is_number(attempt) or not 0 < attempt <= 10_000:
        return
    if int(attempt) in kept or len(kept) < MAX_ATTEMPTS:
        kept[int(attempt)] = view


def lives(task: TaskView, tries: list[dict[str, Any]]) -> dict[str, Any] | None:
    """A task's tries on the rung it stands on (`Lives`): the rung of its latest try (a failover's aside),
    its tries there since it got there, and the 2 a rung gives. None when the ladder does not place it."""
    standing = [index for index, one in enumerate(tries) if one["reason"] != "failover"] or list(
        range(len(tries))
    )
    if not standing:
        return None
    latest = tries[standing[-1]]
    if latest["reason"] == "pinned" or not latest["rung"]:
        return None
    if not _ladder_routed(task.attempt_log[standing[-1]]):
        return None
    used = 0
    for one in reversed(tries):
        if one["reason"] == "failover":
            continue  # a substitute ran: roko's standing on the rung does not change (backlog 1118)
        if one["rung"] != latest["rung"]:
            break
        if one["outcome"] == "failed" and one["blame"] not in (None, "agent"):
            continue  # a provider's or roko's own failure is not held against the task
        used += 1
    return {"rung": latest["rung"], "used": used, "of": FAILURES_PER_RUNG}


_STEP_NAME = re.compile(r"^verify:(\d{1,4})/(.{1,100})$")


def check_of(task: TaskView, step: Any) -> str | None:
    """A check roko's verdict names (`custom:test`, `verify:0/test`) as the run names it (`verify[0:test]`):
    by its index when roko gives one, else the task's one check of that name, else the name alone."""
    name = clean(step, 120, one_line=True)
    if not name:
        return None
    found = _STEP_NAME.match(name)
    if found:
        return f"verify[{found[1]}:{found[2]}]"
    bare = name.removeprefix("custom:")
    named = [gate for gate in task.gates if gate.endswith(f":{bare}]")]
    return named[0] if len(named) == 1 else bare


def check_tail_view(task: TaskView) -> dict[str, Any] | None:
    """The card's `check_tail`: what the task's newest check printed and its verdict, with roko's exit code
    and time for it: from roko's verdict on the try, else the exit code from the `✗ exit status N` line roko
    ends a failed check's output with. None before the task's first check."""
    tail = task.check_tail
    if tail is None:
        return None
    lines = list(tail["lines"])
    step = _verdict_step(task, tail) or {}
    exit_code = step.get("exit_code")
    if exit_code is None and tail["passed"] is False:
        exit_code = next(
            (int(found[1]) for line in reversed(lines) if (found := _EXIT_STATUS.match(line))),
            tail.get("exit_code"),
        )
    return {
        "attempt": tail["attempt"],
        "gate": tail["gate"],
        "passed": tail["passed"],
        "command": tail["command"],
        "exit_code": exit_code,
        "duration_ms": step.get("duration_ms"),
        "lines": lines,
        "live": tail["live"],
    }


def _verdict_step(task: TaskView, tail: dict[str, Any]) -> dict[str, Any] | None:
    """roko's verdict on the step a check ran (exit code, time), from its verdict on the try: check
    `verify[0:test]` is step `verify:0/test`, or the one step `custom:test`."""
    if tail["passed"] is None:
        return None
    entry = next((row for row in task.attempt_log if row.get("attempt") == tail["attempt"]), None)
    steps = ((entry or {}).get("settled") or {}).get("steps") or []
    found = _VERIFY_GATE.match(str(tail["gate"]))
    if found is None or not steps:
        return None
    named = [step for step in steps if step.get("rung") == f"verify:{found[1]}/{found[2]}"]
    named = named or [step for step in steps if step.get("rung") == f"custom:{found[2]}"]
    return named[0] if len(named) == 1 else None


def rung_counts(
    rows: list[TaskView], ladder: list[dict[str, Any]] | None, *, ended: bool = False
) -> list[dict[str, Any]] | None:
    """A run's tasks on each rung of its ladder (`RungCount`, docs/ui-api.md), cheapest first: the tasks that
    passed there and the ones running there, the tries that failed there, the tries a provider or roko itself
    failed there (`refused`: not the agent's, so they never count toward a climb), and the tasks waiting to
    start, on their tier's start rung. None without a ladder."""
    if not ladder:
        return None
    counts: dict[str, dict[str, Any]] = {
        str(rung.get("rung")): {
            "rung": str(rung.get("rung")),
            "passed": 0,
            "running": 0,
            "failed": 0,
            "refused": 0,
            "waiting": 0,
        }
        for rung in ladder
    }
    starts = {str(tier): str(rung.get("rung")) for rung in ladder for tier in rung.get("starts") or []}
    first = next(iter(counts))
    for task in rows:
        tries = climb(task, ladder, ended=ended)
        if not tries:
            if task.outcome == "pending":
                counts[starts.get(task.tier or "focused", first)]["waiting"] += 1
            continue
        for one in tries:
            if one["outcome"] == "failed" and one["rung"] in counts:
                # As `lives` counts them: a provider's or roko's own failure is not the agent's.
                agents = one["blame"] in (None, "agent")
                counts[one["rung"]]["failed" if agents else "refused"] += 1
        last = tries[-1]
        if last["rung"] in counts and last["outcome"] in ("passed", "running"):
            counts[last["rung"]][last["outcome"]] += 1
    return list(counts.values())


def ladder_places(ladder: list[dict[str, Any]] | None) -> tuple[dict[str, int], dict[str, str | None]]:
    """The ladder's rungs by name with their place (0 the cheapest), and the rung each model names, by its key
    or its slug (None for a model two rungs name)."""
    places: dict[str, int] = {}
    named: dict[str, str | None] = {}
    for place, rung in enumerate(ladder or []):
        name = str(rung.get("rung") or "")
        if not name or name in places:
            continue
        places[name] = place
        for model in {str(rung.get("model") or ""), str(rung.get("slug") or "")} - {""}:
            named[model] = name if named.get(model, name) == name else None
    return places, named


def _climbed(
    before: list[dict[str, Any]],
    earlier: list[dict[str, Any]],
    settled: dict[str, Any],
    rung: str | None,
    places: dict[str, int],
) -> bool:
    """Whether a try ran higher on the ladder than the task's try before it (a failover's aside): by roko's
    count of the rungs it climbed, else by the places of their rungs."""
    pairs = [pair for pair in zip(before, earlier, strict=True) if pair[1]["reason"] != "failover"]
    entry, previous = (pairs or list(zip(before, earlier, strict=True)))[-1]
    steps, then = settled.get("escalations"), (entry.get("settled") or {}).get("escalations")
    if steps is not None and then is not None:
        return bool(steps > then)
    if rung in places and previous["rung"] in places:
        return places[rung] > places[previous["rung"]]
    return False


def _try_outcome(task: TaskView, entry: dict[str, Any], *, latest: bool, ended: bool) -> str:
    """How a try ended (`Try.outcome`): roko's verdict when it gave one; a try before another one failed;
    the latest try ended as its task did, failed on a failed check, or still runs."""
    verdict = (entry.get("settled") or {}).get("verdict")
    if verdict:
        return SETTLED_OUTCOMES.get(str(verdict), "failed")
    if not latest:
        return "failed"  # roko tried again after it
    if task.outcome in _PASSED_OUTCOMES:
        return "passed"
    if task.outcome == "unverified":
        return "unverified"
    if task.outcome in _FAILED_OUTCOMES:
        return "failed"
    if task.outcome in _STOPPED_OUTCOMES or task.outcome == "blocked":
        return "stopped"
    if entry.get("failed"):
        return "failed"  # its check did not pass; roko tries again or ends the task
    return "stopped" if ended else "running"


def _failover(entry: dict[str, Any], route: dict[str, Any], settled: dict[str, Any]) -> dict[str, Any] | None:
    """The model failover passed over for a try, its provider and why (`Try.failover`); None for a try that
    ran on its pick."""
    if settled.get("failover"):  # roko's own record of it
        passed_over = dict(settled["failover"])
        why = passed_over.get("class")
        passed_over["why"] = FAILOVER_WORDS.get(why or "") or (why.replace("_", " ") if why else None)
        return passed_over
    if str(route.get("source") or "") == "failover":
        # roko lists the models it passed over newest first, after the one that ran: its pick is the last.
        passed = [one for one in route.get("candidates") or [] if one.get("eligible") is False]
        pick: dict[str, Any] = passed[-1] if passed else {}
        why = clean(pick.get("ineligible_reason"), 60, one_line=True) or None
        return {
            "model": pick.get("model"),
            "provider": pick.get("provider"),
            "class": why,
            "why": FAILOVER_WORDS.get(why or "") or (why.replace("_", " ") if why else None),
        }
    moved = entry.get("failover")  # another agent for the same attempt, on another model or provider
    if moved is not None or settled.get("reason") == "failover":
        return {
            "model": (moved or {}).get("model"),
            "provider": (moved or {}).get("provider"),
            "class": None,
            "why": None,
        }
    return None


def _ladder_routed(entry: dict[str, Any]) -> bool:
    """Whether the ladder placed a try: roko names its rung, its route says the ladder (or failover from a
    rung) picked it, or an older roko sent no route and its model is a rung's."""
    if (entry.get("settled") or {}).get("rung"):
        return True
    route = entry.get("route")
    return not route or str(route.get("source") or "") in _LADDER_SOURCES


_TITLE_LABEL = re.compile(r"^[\w ]{1,20}:$")
_ABBREVIATIONS = frozenset({"e.g", "i.e", "etc", "vs", "cf", "approx", "no", "mr", "mrs", "dr"})


# A title a request states for its plan (P-8): "Title: P0 · …" as its first line, or a sentence that sets it.
_FIRST_LINE_TITLE = re.compile(r"^(?:the\s+)?(?:plan(?:['’]s)?\s+)?title\s*:\s*(.+)$", re.I)
_QUOTED = r"(?:\"([^\"\n]{2,80})\"|“([^”\n]{2,80})”)"
_SENTENCE_TITLES = (
    re.compile(
        r"\b(?:set|make|use|call|give)\s+(?:the\s+)?(?:plan(?:['’]s)?\s+)?title\s+(?:to\s+|as\s+)?" + _QUOTED,
        re.I,
    ),
    re.compile(r"\btitle\s+(?:the|this|it)\s+(?:plan\s+)?" + _QUOTED, re.I),
)


def stated_title(text: Any) -> str:
    """The title a plan's request states for it, or "": its first line "Title: P0 · …" ("Plan title: …"), or
    a sentence that sets it ("Set the plan title to "…"", "Title the plan "…""). Asked to title a plan, a
    model wrote the title there, since `title` read as a run's name in lists (P-8)."""
    lines = [" ".join(raw.split()) for raw in clean(text).splitlines() if raw.strip()]
    found = _FIRST_LINE_TITLE.match(lines[0].lstrip("#>*-• ")) if lines else None
    if found:
        return clean(found[1].strip().strip('"“”').rstrip("."), SHORT_TITLE_CHARS, one_line=True)
    for pattern in _SENTENCE_TITLES:
        if said := pattern.search(" ".join(lines)):
            return clean((said[1] or said[2]).strip(), SHORT_TITLE_CHARS, one_line=True)
    return ""


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
# roko's model ladder (graph_task_dispatch/ladder.rs): a task climbs one rung after this many agent-blamed
# failures on its rung (FAILURES_PER_RUNG), at most two rungs.
FAILURES_PER_RUNG = 2
# Where each task tier starts on the ladder when roko.toml does not say (roko-core LadderStart::d11).
LADDER_STARTS = {"mechanical": "cheap", "focused": "cheap", "integrative": "mid", "architectural": "top"}
# How roko's verdict on an attempt (attempt_settled's AttemptOutcome) reads on a try: every other one failed,
# `forced_accept` too (a judge accepted a try whose checks failed; roko-graph: "Never a pass").
SETTLED_OUTCOMES = {
    "passed": "passed",
    "already_satisfied": "passed",
    "unverified": "unverified",
    "budget_exhausted": "stopped",
    "cancelled": "stopped",
}
# Why failover passed a model over (roko's FailoverRefusal class), for people.
FAILOVER_WORDS = {
    "provider_exhausted": "out of usage",
    "billing": "a billing problem",
    "circuit_open": "failing, so roko paused it",
    "disabled": "turned off",
    "no_credentials": "no key for it",
    "not_configured": "not set up",
    "not_dispatchable": "roko cannot run it here",
    "contract_unsupported": "it cannot keep the task's rules",
    "unguarded_in_checkout": "roko cannot guard it in your checkout",
}
# What ended a try that did not pass, by roko's verdict on it (AttemptOutcome), in words.
VERDICT_WORDS = {
    "forced_accept": "its check failed, and a judge accepted the work anyway",
    "timeout": "it timed out",
    "provider_error": "the provider failed",
    "provider_exhausted": "every provider it could use failed",
    "budget_exhausted": "roko stopped it at the run's cap",
    "cancelled": "the run was cancelled",
    "workspace_error": "its checkout failed",
    "harness_error": "roko failed (its own error)",
    "promise_terminated": "roko ended it",
    "abandoned": "it ended with no verdict",
    "unverified": "no check ran",
}
# The messages roko ends an attempt with in the agent's place (the attempt's last text record).
_TURN_CAP_SAID = re.compile(r"^agent turn cap reached \(turns=(\d{1,6}), cap=\d{1,6}\)")
# roko bounds a try on a rung it can still climb from (37088dc12, `[routing.ladder]` max_usd): "the try
# spent its allowance on rung `cheap`: $0.0123 of $0.0150 ([routing.ladder] max_usd)", or only the allowance
# when the agent kept the count itself. The try fails there (turn_cap, the agent's blame), behind "Budget
# exhausted: " or "rung_allowance: ".
_ALLOWANCE_SAID = re.compile(
    r"spent its allowance on rung `(?P<rung>[^`]{1,40})`: \$(\d+(?:\.\d+)?)(?: of \$(\d+(?:\.\d+)?))?"
)
# The verdict that opens attempt_settled's `detail` ("turn_cap: …", "rung_allowance: …").
_VERDICT_PREFIX = re.compile(r"^(?:[a-z_]{1,40}: )+")
_DENIED_SAID = re.compile(
    r"^(?:error: )?provider (?:result|stream) denied by immune boundary(?: \(reason: ([\w.-]{1,80})\))?"
)
_OUTPUT_LIMIT_SAID = re.compile(r"^model hit output token limit")
_NETWORK_SAID = re.compile(r"^network error: (.+)", re.S)
# Why roko's immune boundary denied a model's answer, in words.
DENIED_WORDS = {
    "provider_stream_limit_exceeded": "roko stopped the model's stream: it ran past roko's limit",
    "containment_persistence_failed": "roko stopped the model's answer: it could not keep it safely",
    "provider_output_quarantined": "roko quarantined the model's answer",
}
# The route sources that place a try on a rung: the ladder's pick, the self-model's, and failover from one.
_LADDER_SOURCES = frozenset({"ladder", "self_model", "failover"})


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
        **loopevents.route_ladder(event),
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
        # roko's own message in the agent's place, in words (dogfood U2): "roko stopped the model's stream",
        # not "agent error (zai): provider result denied by immune boundary (reason: …)".
        said = harness_words(_AGENT_ERROR.sub("", reason))
        parts.append(f"{task_id} did not finish: {said or clean(reason, 300, one_line=True)}.")
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
        # Each try can fail it its own way (hermes-pilot P-10): the line is the last run's.
        said = f"; the last time: {gate['key_line']}" if how.startswith(", all") else f": {gate['key_line']}"
        parts.append(line + (said if gate["key_line"] else "") + ".")
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


# roko's last line of a check that did not pass, and a task's check by its place in `verify` and its phase.
_EXIT_STATUS = re.compile(r"^✗ exit status (\d{1,5})$")
_VERIFY_GATE = re.compile(r"^verify\[(\d{1,3}):([^\]]{1,60})\]$")
# Lines that state a cause: an exception with its message, a compiler's or a program's `error:`, a panic,
# CMake's errors, doctest's failed assertions.
_CAUSE_LINE = re.compile(
    r"\b[A-Z]\w*(?:Error|Exception)\b|\berror(?:\[\w+\])?:|\bpanicked at\b"
    r"|^CMake Error\b|^Error: @\d+,\d+:|:\d+: (?:FATAL )?ERROR: "
)
# What those say on one line (round v7, the real P0 run): CMake's message under its error, the presets file's
# own error, the line doctest logged for an assertion; and roko's attempt checkout, where paths there start.
_CMAKE_AT = re.compile(r"^CMake Error at (\S+?):(\d{1,7}) \([^)]{0,80}\):$")
_CMAKE_PRESET = re.compile(r"^Error: @(\d{1,7}),(\d{1,5}): (.+)$")
_DOCTEST_ERROR = re.compile(r"^(\S+?:\d{1,7}): (?:FATAL )?ERROR: (.+?)(?: is NOT correct!)?$")
_DOCTEST_LOGGED = re.compile(r"^logged: (.+)$")
_ATTEMPT_CHECKOUT = re.compile(r"\S*/\.roko/worktrees/[^/\s]+/?")
# Lines that only count or name what failed (a test runner's summary, roko's exit line): a cause says more.
_SUMMARY_LINE = re.compile(
    r"^(?:FAILED\b|FAIL:|ERROR:|test result:|Ran \d+ tests?\b|error: could not compile|✗ exit status)"
)


def key_line(output: str) -> str | None:
    """The line of a check's output most likely to say why it failed: the first that states a cause (an
    exception, an `error:`, a panic), else the last error-looking line, else the last line."""
    lines = [line.strip() for line in output.splitlines() if line.strip() and line.strip() != "…"]
    if not lines:
        return None
    body = lines[1:] if len(lines) > 1 and lines[0].startswith("$") else lines
    causes = [
        at for at, line in enumerate(body) if _CAUSE_LINE.search(line) and not _SUMMARY_LINE.match(line)
    ]
    hits = [line for line in body if _KEY_LINE.search(line) and not line.startswith("---")]
    # Without a cause, the last error-looking line says more than the first (a summary follows a trace).
    chosen = _cause(body, causes[0]) if causes else hits[-1] if hits else body[-1]
    chosen = _ATTEMPT_CHECKOUT.sub("", chosen)
    return clean(re.sub(r"^E\s{2,}", "", chosen), 200, one_line=True) or None  # without pytest's `E` margin


def _cause(body: list[str], at: int) -> str:
    """The cause `body[at]` states, as one line: CMake's error with its message (the presets file's own
    error under "could not read presets"), doctest's assertion with the line its test logged."""
    line, after = body[at], body[at + 1 : at + 4]
    if found := _CMAKE_AT.match(line):
        message = after[0] if after and not after[0].startswith(("--", "CMake ")) else ""
        return f"{found[1]}:{found[2]}: {message}" if message else line
    if line.startswith("CMake Error: "):
        preset = next((m for m in map(_CMAKE_PRESET.match, after) if m), None)
        return f"CMakePresets.json:{preset[1]}:{preset[2]}: {preset[3]}" if preset else line
    if found := _DOCTEST_ERROR.match(line):
        logged = next((m[1] for m in map(_DOCTEST_LOGGED.match, after) if m), None)
        return f"{found[1]}: {found[2]}" + (f": {logged}" if logged else "")
    return line


# How roko's error for a task names the provider the agent's attempt failed on: "agent error (zai): …".
_AGENT_ERROR = re.compile(r"^agent error \([^)]{0,80}\): ")
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


# How roko prices a model's cache tokens when the model names no price for them (model_registry.rs
# DEFAULT_CACHE_READ_MULTIPLIER, DEFAULT_CACHE_WRITE_MULTIPLIER): shares of its input price.
CACHE_READ_SHARE = 0.1
CACHE_WRITE_SHARE = 1.25
# What roko's knowledge store did with a lesson (knowledge_written `admission`): kept it, or had it already.
_KEPT_LESSONS = frozenset({"light_admitted", "full_admitted"})


def receipt(card: dict[str, Any]) -> dict[str, Any]:
    """An ended run's `receipt` (`Receipt`, docs/ui-api.md), from its card: where its tasks passed on the
    ladder, its climbs and first-try passes, what its tokens would have cost on the ladder's top rung (≈),
    what it learned and what it changed."""
    tasks = [task for task in card.get("tasks") or [] if isinstance(task, dict)]
    ladder = [rung for rung in card.get("ladder") or [] if isinstance(rung, dict)]
    places = {str(rung.get("rung")): place for place, rung in enumerate(ladder)}
    by_rung: dict[str, dict[str, Any]] = {}
    climbs = first_try = 0
    for task in tasks:
        tries = [one for one in task.get("climb") or [] if isinstance(one, dict)]
        climbs += sum(1 for one in tries if one.get("reason") == "climb")
        first_try += 1 if tries and tries[0].get("outcome") == "passed" else 0
        for one in tries:
            if not one.get("rung"):
                continue
            row = by_rung.setdefault(str(one["rung"]), {"passed": 0, "tries": 0, "cost_usd": None})
            row["tries"] += 1
            row["passed"] += 1 if one.get("outcome") == "passed" else 0
            if one.get("cost_usd") is not None:
                row["cost_usd"] = round((row["cost_usd"] or 0.0) + float(one["cost_usd"]), 6)
    cost = card.get("cost_usd")
    top, top_usd, basis, detail, by, not_compared = _top_rung_line(
        ladder[-1] if ladder else None, tasks, cost, card.get("tokens")
    )
    lessons = [lesson for task in tasks for lesson in task.get("lessons") or [] if isinstance(lesson, dict)]
    # The lessons in its tries' prompts, where roko said (prompt_assembled).
    prompted = [
        one["lesson_ids"]
        for task in tasks
        for one in task.get("climb") or []
        if isinstance(one, dict) and isinstance(one.get("lesson_ids"), list)
    ]
    return {
        "cost_usd": cost,
        "tasks": card.get("progress"),
        "checks": card.get("gates"),
        "by_rung": {name: by_rung[name] for name in sorted(by_rung, key=lambda name: places.get(name, 99))}
        or None,
        "climbs": climbs,
        "first_try_passes": first_try,
        "top_rung": top,
        "top_rung_usd": top_usd,
        "top_rung_by": by,
        "not_compared": not_compared,
        "ratio": round(top_usd / cost, 1) if top_usd and _is_number(cost) and cost > 0 else None,
        "basis": basis,
        "basis_detail": detail,
        "lessons_kept": sum(1 for lesson in lessons if lesson.get("admission") in _KEPT_LESSONS),
        "lessons_confirmed": sum(1 for lesson in lessons if lesson.get("admission") == "duplicate"),
        "lessons_used": len({ident for one in prompted for ident in one}) if prompted else None,
        "changes": _changes(card.get("work")),
    }


def _top_rung_line(
    top: dict[str, Any] | None, tasks: list[dict[str, Any]], cost: Any, totals: Any
) -> tuple[dict[str, Any] | None, float | None, str | None, str | None, str | None, int]:
    """The Receipt's top-rung line (spec §4.6, plugin-review's question 1): (rung, ≈ USD, basis, the basis in
    full, how it was worked out, the tasks it leaves out). The conservative counterfactual: each passed task's
    passing try's tokens at the top rung's list prices, plus the run's helper calls at what they cost (the
    run's cost less its tries', never below 0); tasks that never passed are left out and counted. When a
    passing try carries no tokens (an older roko), the run's own tokens are priced instead, failed tries
    included."""
    passing: list[dict[str, Any]] = []
    for task in tasks:
        tries = [one for one in task.get("climb") or [] if isinstance(one, dict)]
        won = next((one for one in reversed(tries) if one.get("outcome") == "passed"), None)
        if won is not None and task.get("outcome") in _PASSED_OUTCOMES:
            passing.append(won)
    not_compared = len(tasks) - len(passing)
    rung, usd_total, basis, detail = _top_rung_cost(top, totals)
    if usd_total is None and basis is not None and not basis.startswith("the run counted"):
        return rung, None, basis, None, None, not_compared  # no ladder, or no price for its top rung
    if tasks and not passing:
        return rung, None, "no task passed: nothing to compare", None, None, not_compared
    if not passing or any(one.get("tokens") is None for one in passing):
        if usd_total is None:
            return rung, None, basis, detail, None, not_compared
        return rung, usd_total, "≈ from run totals, failed tries included", detail, "run_totals", not_compared
    if top is None:  # _top_rung_cost said so above; this keeps the type checker sure of it
        return rung, None, basis, None, None, not_compared
    price_in, price_out = float(top["price_in"]), float(top["price_out"])
    cache_price = top.get("price_cache_read")
    cache_price = float(cache_price) if _is_number(cache_price) else price_in * CACHE_READ_SHARE
    counts = {
        key: sum(_whole(one["tokens"].get(key)) for one in passing)
        for key in ("input", "output", "cache_read")
    }
    priced = (
        counts["input"] * price_in + counts["output"] * price_out + counts["cache_read"] * cache_price
    ) / 1_000_000
    tried = sum(
        float(one["cost_usd"])
        for task in tasks
        for one in task.get("climb") or []
        if isinstance(one, dict) and _is_number(one.get("cost_usd"))
    )
    helper = round(max(0.0, float(cost) - tried), 6) if _is_number(cost) else 0.0
    name = str(top.get("slug") or top.get("model") or top.get("rung"))
    which = "the passing try's" if len(passing) == 1 else f"the {len(passing)} passing tries'"
    plus = f", plus {usd(helper)} helper calls" if helper > 0 else ""
    of = "the passing try" if len(passing) == 1 else f"the {len(passing)} passing tries"
    detail = (
        f"{counts['input']:,} input, {counts['output']:,} output and {counts['cache_read']:,} cache-read "
        f"tokens of {of} at {name}'s list prices (${_rate(price_in)} in, ${_rate(price_out)} out per million)"
        + (f", plus {usd(helper)} of helper calls at their cost" if helper > 0 else "")
    )
    basis = f"≈ {which} tokens at {name}'s list prices{plus}"
    return rung, round(priced + helper, 6), basis, detail, "passing_tries", not_compared


def _top_rung_cost(
    top: dict[str, Any] | None, tokens: Any
) -> tuple[dict[str, Any] | None, float | None, str | None, str | None]:
    """The ladder's top rung, and what `tokens` (the run's totals) cost at its list prices: (rung, ≈ USD,
    basis, the basis in full). Without a ladder, a price or tokens, the USD is None and the basis says why."""
    if top is None:
        return None, None, "no model ladder in roko.toml", None
    name = str(top.get("slug") or top.get("model") or top.get("rung"))
    rung = {"rung": top.get("rung"), "model": top.get("model"), "slug": top.get("slug")}
    price_in, price_out = top.get("price_in"), top.get("price_out")
    if not _is_number(price_in) or not _is_number(price_out):
        return rung, None, f"no list price for {name}", None
    counts = {
        key: _whole((tokens or {}).get(key)) for key in ("input", "output", "cache_read", "cache_write")
    }
    if not any(counts.values()):
        return rung, None, "the run counted no tokens", None
    cache_read = top.get("price_cache_read")
    if not _is_number(cache_read):
        cache_read = price_in * CACHE_READ_SHARE
    usd = (
        counts["input"] * price_in
        + counts["output"] * price_out
        + counts["cache_read"] * cache_read
        + counts["cache_write"] * price_in * CACHE_WRITE_SHARE
    ) / 1_000_000
    written = f", {counts['cache_write']:,} cache-write" if counts["cache_write"] else ""
    prices = f"${_rate(price_in)} in, ${_rate(price_out)} out per million"
    detail = (
        f"{counts['input']:,} input, {counts['output']:,} output, {counts['cache_read']:,} cache-read"
        f"{written} tokens at {name}'s list prices ({prices})"
    )
    return rung, round(usd, 6), "≈ from run totals", detail


def _rate(price: float) -> str:
    """A per-million price as people write it: two decimals, or as many as it needs below a dime ($0.75,
    $0.075)."""
    return f"{price:.2f}" if price >= 0.1 or price <= 0 else f"{price:.6f}".rstrip("0")


def _changes(work: Any) -> dict[str, Any] | None:
    """What an ended run changed, from its card's `work`: every part's counts added up, and the branch of the
    first part (its delivered work comes first)."""
    if not isinstance(work, dict):
        return None
    parts = [part for part in work.get("parts") or [] if isinstance(part, dict)]
    counts = [part["counts"] for part in parts if isinstance(part.get("counts"), dict)]
    return {
        "kind": work.get("kind"),
        "files": sum(_whole(count.get("files")) for count in counts),
        "additions": sum(_whole(count.get("additions")) for count in counts),
        "deletions": sum(_whole(count.get("deletions")) for count in counts),
        "branch": next((part["branch"] for part in parts if part.get("branch")), None),
        "merged": bool(parts) and all(part.get("merged") for part in parts),
    }


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
    if card.get("reading"):  # a long run read partway: its checks so far are no count of its checks
        parts.append("reading its history")
    elif gates.get("total"):
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


# A CLI run's id: `graph-<plan>-<uuid>`; roko shows it by its UUID's first 8 characters (roko-ladder, P-14).
_GRAPH_RUN_ID = re.compile(r"^graph-.+-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def short_run_id(run_id: str) -> str:
    """A run's id as roko shows and takes it short: its UUID's first 8 characters."""
    found = _GRAPH_RUN_ID.match(run_id or "")
    return found[1] if found else (run_id or "")[:8]


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

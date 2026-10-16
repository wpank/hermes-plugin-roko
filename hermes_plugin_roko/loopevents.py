"""roko's five loops, as the pages show them: which ring an event lights, and in what words.

roko regulates itself on five nested clocks (its whitepaper, "cybernetic mechanisms"):

- L0, tool calls (seconds): each tool step an agent takes; a call held for the person.
- L1, attempts (minutes): the router's model pick, retries, failover, a check that regressed.
- L2, the plan (hours): waves opening, the conductor's interventions, budget alerts, sign-offs.
- L3, learning (days): gate thresholds moving, knowledge written.
- L4, audit (weeks): loop health and its transitions, learning updates held back by their guard.

`loop_events()` turns one row of a run's events (from the run's index or from roko's hub) into the
loop events it shows; `live_record()` turns a live agent record into a `live` item. The run card's
fold and the live relay both use them, so a page opened late draws the loops the socket showed. Each
loop event carries a `key` built from what it says, never from when it was read, so the two copies of
one event can be merged.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, field
from typing import Any, TypeGuard

from .sanitize import clean

RINGS: dict[str, tuple[str, str]] = {
    "L0": ("tool calls", "seconds"),
    "L1": ("attempts", "minutes"),
    "L2": ("the plan", "hours"),
    "L3": ("learning", "days"),
    "L4": ("audit", "weeks"),
}
# The ring of each loop event kind.
KIND_RING = {
    "tool_held": "L0",
    "tool_decided": "L0",
    "withheld": "L0",
    "route": "L1",
    "failover": "L1",
    "retry": "L1",
    "regression": "L1",
    "wave": "L2",
    "diagnosis": "L2",
    "budget": "L2",
    "hold": "L2",
    "thresholds": "L3",
    "knowledge": "L3",
    "loop_health": "L4",
    "guarded_commit": "L4",
}
STREAM_PREFIX = "\x1eroko.stream.v1 "
# A live record's kind, as a `live` item names it.
LIVE_KINDS = {"tool_start": "tool", "text": "text", "reasoning": "reasoning", "tool_result": "result"}
LIVE_TEXT_CHARS = 400
TEXT_CHARS = 220
MAX_CANDIDATES = 5
# roko numbers a gate's rungs; the adaptive thresholds are kept per rung number.
# roko's check rungs by number (roko_gate::Rung; 1000 and 1001 are gate_dispatch's whole-plan and post-merge
# checks), in the pages' words (RUNG_NAMES in desktop/plugin.js and dashboard/dist/index.js).
RUNG_NAMES = {
    0: "compile",
    1: "lint",
    2: "test",
    3: "symbol",
    4: "gen-test",
    5: "prop-test",
    6: "integration",
    1000: "whole-plan",
    1001: "post-merge",
}
# Who produced a route's pick, as people say it.
ROUTE_SOURCES = {
    "router": "learned",
    "ladder": "ladder",
    "task_hint": "task hint",
    "override": "override",
    "fallback": "fallback",
    "default": "default",
    "explore": "exploring",
    "control": "control arm",
    "self_model": "self-model",
    "failover": "failover",
}
# What decided a route, by roko's `source` (else its `routing_reason`, which an older row holds it in).
DECIDED_BY = {
    "ladder": "ladder",
    "task_hint": "pinned",
    "override": "pinned",
    "fallback": "fallback",
    "default": "fallback",
    "explore": "explore",
    "control": "explore",
    "self_model": "learned",
    "failover": "failover",
}
# Providers whose agent runs its own tools: a run a chat host starts carries roko's `stage` outbound
# policy, which such an agent cannot honour, so those models are not for it.
CLI_PROVIDERS = frozenset(
    {"claude_cli", "codex_cli", "gemini_cli", "cursor_cli", "cursor_acp", "hermes", "openclaw", "codex"}
)
_CLI_PROVIDER = re.compile(r"(?:^|[_-])(?:cli|acp)$")
# roko's learning loops by the names people know them by (roko's crates/roko-learn/src/loop_audit/loops.toml),
# in the pages' words (LOOP_NAMES in desktop/plugin.js and dashboard/dist/index.js; ui-notes D8).
LOOP_NAMES = {
    "L-route": "model routing",
    "L-linucb": "model routing (LinUCB stage)",
    "L-model-exp": "model experiments",
    "L-routing-log": "routing decision log",
    "L-know": "lessons in prompts",
    "L-rag11": "retrieval experiment",
    "L-play": "playbooks in prompts",
    "L-hdc": "episode recall",
    "L-err": "error patterns",
    "L-dream": "dream consolidation",
    "L-prompt-exp": "prompt experiments",
    "L-bid": "attention bidders",
    "L-sec": "prompt sections",
    "L-gate-thr": "check thresholds",
    "L-retry-budget": "retry budgets",
    "L-holdout": "holdout experiment",
    "L-M1": "M1 controller",
    "L-M3": "M3 self-model",
    "L-M4": "M4 audit feedback",
    "L-placebo": "placebo (checks the audit)",
}
# Why the audit flagged or demoted a loop (roko-learn's loop_audit ReasonCode), in the pages' words.
LOOP_REASONS = {
    "dormant:label_only": "it only labels decisions",
    "dormant:degenerate": "it has nothing to vary",
    "dormant:no_opportunity": "no chance to act yet",
    "dormant:no_learning": "it learns nothing",
    "dormant:write_only": "what it learns is never read",
    "dormant:cut": "what it reads is empty",
    "dormant:stale": "it reads an old state",
    "dormant:mask": "something else overrides what it picks",
    "dormant:unlogged": "its effect is not recorded",
    "inert": "it changes nothing",
    "null": "no measurable benefit",
    "harm": "it made things worse",
}
# A loop's audit state where a transition starts from; its full words are `loop_state_words`.
LOOP_STATES = {"probation": "on probation", "live": "proven", "flagged": "flagged", "demoted": "demoted"}
# What roko's knowledge store did with a task's outcome (`admission`), in the pages' words (ui-notes D7).
ADMISSION_WORDS = {
    "deferred": "a lesson waits for more evidence",
    "duplicate": "confirmed a lesson it had",
    "full_admitted": "kept a new lesson",
    "full_deferred": "a lesson waits for more evidence",
    "full_rejected": "a lesson was not kept",
    "full_suppressed": "a lesson was not kept",
    "light_admitted": "kept a new lesson",
    "no_candidate": "nothing new to learn from this task",
}
# roko's reasons a candidate could not be picked, in words.
WHY_NOT = {
    "provider_unconfigured": "its provider is not set up in this workspace",
    "not_configured": "its provider is not set up in this workspace",
    "no_credentials": "its API key is not set",
    "missing_key": "its API key is not set",
    "disabled": "[routing] turns its provider off",
    "circuit_open": "roko holds off its provider after errors",
    "breaker_open": "roko holds off its provider after errors",
    "unhealthy": "roko holds off its provider after errors",
    "no_tools": "it cannot call tools",
    "contract_unsupported": "it cannot honour this run's policy",
}


@dataclass
class LoopContext:
    """What classifying one run's events needs to remember between rows."""

    # (plan, task) -> the attempt number and model of its latest agent.
    attempts: dict[tuple[str, str], tuple[int, str]] = field(default_factory=dict)
    # (plan, task) -> agents spawned, for an older roko that numbers every attempt 0.
    spawns: dict[tuple[str, str], int] = field(default_factory=dict)
    # Whether this run's roko publishes route_decided (then failover comes from it).
    saw_routes: bool = False
    # task id -> its wave (0-based), once the plan's graph is known; the waves already open.
    wave_of: dict[str, int] = field(default_factory=dict)
    wave_tasks: dict[int, list[str]] = field(default_factory=dict)
    waves_open: set[int] = field(default_factory=set)

    def set_waves(self, waves: list[list[str]]) -> None:
        """The plan's waves (task ids, or `plan/task` ids), from the run card's graph."""
        self.wave_of = {}
        self.wave_tasks = {}
        for index, wave in enumerate(waves):
            names = [str(node).rsplit("/", 1)[-1] for node in wave]
            self.wave_tasks[index] = names
            for name in names:
                self.wave_of.setdefault(name, index)


def stream_records(content: Any) -> list[dict[str, Any]]:
    """The `\\x1eroko.stream.v1 {json}` records in an `agent_output` row's content."""
    if not isinstance(content, str) or STREAM_PREFIX not in content:
        return []
    records = []
    for line in content.split("\n"):
        if not line.startswith(STREAM_PREFIX):
            continue
        try:
            record = json.loads(line[len(STREAM_PREFIX) :])
        except ValueError:
            continue
        if isinstance(record, dict):
            records.append(record)
    return records


def live_record(event: dict[str, Any]) -> dict[str, Any] | None:
    """A live agent record (`agent_output` with `live: true`) as a `live` item, or None."""
    for record in stream_records(event.get("content")):
        if record.get("live") is not True:
            continue
        kind = LIVE_KINDS.get(str(record.get("kind") or ""))
        payload = as_dict(record.get("payload"))
        if kind is None:
            continue
        item: dict[str, Any] = {
            "kind": kind,
            "plan_id": clean(record.get("plan_id") or event.get("plan_id"), 120, one_line=True) or None,
            "task_id": clean(record.get("task_id") or event.get("task_id"), 80, one_line=True) or None,
            "attempt": _attempt(record.get("attempt"), event.get("attempt")),
            "ts": _ms(event.get("ts_millis")),
        }
        if kind == "tool":
            item["tool"] = clean(payload.get("tool"), 60, one_line=True) or "tool"
            item["target"] = clean(payload.get("target"), 200, one_line=True) or None
            item["tool_id"] = clean(payload.get("tool_id"), 80, one_line=True) or None
        elif kind in ("text", "reasoning"):
            # A chunk that is only a space still counts: it is the gap between two words.
            text = clean(payload.get("text"), LIVE_TEXT_CHARS)
            if not text:
                continue
            item["text"] = text
        else:  # a tool's result
            item["tool_id"] = clean(payload.get("tool_id"), 80, one_line=True) or None
            item["text"] = clean(payload.get("output"), LIVE_TEXT_CHARS)
        if record.get("screened") is False:
            item["screened"] = False
        return item
    return None


def heartbeat(event: dict[str, Any]) -> dict[str, Any]:
    """An `agent_heartbeat` row as a `live` item: the agent is still at work."""
    elapsed = event.get("elapsed_ms")
    return {
        "kind": "beat",
        "plan_id": clean(event.get("plan_id"), 120, one_line=True) or None,
        "task_id": clean(event.get("task_id"), 80, one_line=True) or None,
        "attempt": None,
        "elapsed_ms": int(elapsed) if _number(elapsed) else None,
        "ts": _ms(event.get("ts_millis")),
    }


_PLAN_TASK = re.compile(r"(?P<plan>[^/\s:]+)/(?P<task>[^/\s:]+)")


def event_scope(kind: str, event: dict[str, Any]) -> tuple[str, str | None]:
    """The (plan id, task id) an event is about. Most carry `plan_id` and `task_id`; a diagnosis names
    them in its subject or id (`plan/task`), and a budget alert in its item id (`budget:<plan>:<pct>`)."""
    plan = clean(event.get("plan_id"), 120, one_line=True)
    task = clean(event.get("task_id"), 80, one_line=True) or None
    if plan:
        return plan, task
    if kind == "diagnosis":
        summary = as_dict(event.get("summary"))
        for text in (summary.get("subject"), str(summary.get("id") or "").split(":", 1)[-1]):
            found = _PLAN_TASK.fullmatch(str(text or ""))
            if found:
                return clean(found["plan"], 120, one_line=True), clean(found["task"], 80, one_line=True)
    if kind == "inbox_item_received" and str(event.get("category") or "") == "budget_alert":
        ident = str(event.get("item_id") or "")
        if ident.startswith("budget:") and ident.count(":") >= 2:
            return clean(ident[len("budget:") :].rsplit(":", 1)[0], 120, one_line=True), task
    return plan, task


def unplanned(kind: str, event: dict[str, Any]) -> bool:
    """Whether an event names no plan at all: under roko serve it belongs to whichever run is
    recording (the learning loops' health, gate thresholds, a guard holding a learning update back)."""
    return kind in UNPLANNED_TYPES or (kind in _SCOPELESS_TYPES and not event_scope(kind, event)[0])


def loop_events(kind: str, event: dict[str, Any], ctx: LoopContext) -> list[dict[str, Any]]:
    """The loop events one row lights, in order (usually none or one)."""
    plan, task = event_scope(kind, event)
    ts = _ms(event.get("ts_millis"))
    handler = _HANDLERS.get(kind)
    if handler is None:
        return []
    out = []
    for loop_kind, text, data, key in handler(event, ctx, plan, task):
        out.append(
            {
                "ring": KIND_RING[loop_kind],
                "kind": loop_kind,
                "text": clean(text, TEXT_CHARS, one_line=True),
                "data": data,
                "task_id": task,
                "plan_id": plan or None,
                "ts": ts,
                "key": key,
            }
        )
    return out


# -- one handler per roko event type: yields (kind, text, data, key) ----------------------

Emit = list[tuple[str, str, dict[str, Any], str]]


def _route(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    ctx.saw_routes = True
    attempt = _attempt(event.get("attempt"))
    model = clean(event.get("model"), 80, one_line=True) or "?"
    provider = clean(event.get("provider"), 60, one_line=True) or None
    source = clean(event.get("source"), 40, one_line=True)
    stage = clean(event.get("stage"), 60, one_line=True) or None
    reason = clean(event.get("reason"), 300, one_line=True) or None
    candidates = route_candidates(event.get("candidates"))
    chosen = next((c for c in candidates if c["model"] == model), None)
    data = {
        "attempt": attempt,
        "model": model,
        "provider": provider,
        "source": source or None,
        "stage": stage,
        "reason": reason,
        "rung": clean(event.get("rung"), 40, one_line=True) or None,
        "p": chosen["p"] if chosen else None,
        "candidates": candidates,
    }
    data.update(route_view(data) or {})
    who = f"{task} attempt {attempt}" if attempt else str(task)
    if source == "failover":
        text = f"{who} switched to {model} (failover)" + (f": {reason}" if reason else "")
        return [("failover", text, data, f"failover:{plan}:{task}:{attempt}:{model}")]
    words = [route_words(data)] if data.get("decided_by") or source else []
    if data.get("scored"):
        # Only a learned pick's figures say why it won; a ladder rung or a pinned model ignores them.
        if chosen and chosen["p"] is not None:
            words.append(f"p {chosen['p']:.2f}")
        rival = next((c for c in candidates if c["model"] != model and c["eligible"]), None)
        if rival:
            figure = rival["p"] if rival["p"] is not None else rival["score"]
            words.append(f"over {rival['model']}" + (f" {figure:.2f}" if figure is not None else ""))
    said = [word for word in words if word]
    text = (
        f"{who} → {model}"
        + (f", {said[0]}" if said else "")
        + (f" ({'; '.join(said[1:])})" if len(said) > 1 else "")
    )
    return [("route", text, data, f"route:{plan}:{task}:{attempt}:{model}:{source}")]


def _spawned(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    if task is None:
        return []
    key = (plan, task)
    model = clean(event.get("model"), 80, one_line=True) or "?"
    spawns = ctx.spawns.get(key, 0) + 1
    ctx.spawns[key] = spawns
    number = _attempt(event.get("attempt")) or spawns
    previous = ctx.attempts.get(key)
    ctx.attempts[key] = (number, model)
    if previous is not None and previous[0] == number:
        if previous[1] != model and not ctx.saw_routes:
            text = f"{task} switched to {model} (failover)"
            return [
                (
                    "failover",
                    text,
                    {"attempt": number, "model": model},
                    f"failover:{plan}:{task}:{number}:{model}",
                )
            ]
        return []
    if number > 1:
        data = {"attempt": number, "model": model}
        return [("retry", f"{task} attempt {number} on {model}", data, f"retry:{plan}:{task}:{number}")]
    return []


def _task_started(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    if task is None or task not in ctx.wave_of:
        return []
    wave = ctx.wave_of[task]
    if wave in ctx.waves_open:
        return []
    ctx.waves_open.add(wave)
    peers = ctx.wave_tasks.get(wave, [task])
    text = f"wave {wave + 1} open: {', '.join(peers[:6])}" + (" in parallel" if len(peers) > 1 else "")
    return [("wave", text, {"wave": wave + 1, "tasks": peers[:20]}, f"wave:{wave}")]


def _log_entry(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    kind = str(event.get("event_type") or "")
    message = clean(event.get("message"), 300, one_line=True)
    stamp = event.get("timestamp_ms") or event.get("ts_millis")
    if kind == "gate_regression":
        text = f"{task}: {message}" if task and message else message or f"{task}: a check regressed"
        return [("regression", text, {"message": message}, f"regression:{plan}:{task}:{stamp}")]
    if kind == "learning.guarded_commit":
        text = "a learning update was held back by its guard" + (f": {message}" if message else "")
        return [("guarded_commit", text, {"message": message}, f"guarded:{stamp}:{message[:40]}")]
    if kind == "graph.plan_budget_raised":
        return [
            ("budget", message or "the plan's budget was raised", {"message": message}, f"budget:{stamp}")
        ]
    return []


def _diagnosis(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    summary = as_dict(event.get("summary"))
    ident = clean(summary.get("id"), 200, one_line=True)
    subject = clean(summary.get("subject"), 120, one_line=True)
    detail = clean(summary.get("detail"), 300, one_line=True)
    action = clean(summary.get("intervention_taken"), 200, one_line=True)
    who = _diagnosis_source(ident)
    body = action or detail or "flagged"
    named = _PLAN_TASK.fullmatch(subject)
    shown = named["task"] if named else subject
    text = f"{who}: {shown + ' · ' if shown else ''}{body}"
    data = {
        "id": ident or None,
        "severity": clean(summary.get("severity"), 20, one_line=True) or None,
        "subject": subject or None,
        "detail": detail or None,
        "suggested_action": clean(summary.get("suggested_action"), 300, one_line=True) or None,
        "intervention_taken": action or None,
    }
    return [("diagnosis", text, data, f"diagnosis:{ident or detail[:60]}")]


_BUDGET_ALERT = re.compile(r"plan \S+ has spent \$(?P<spent>[\d.]+) of \$(?P<cap>[\d.]+) \((?P<pct>\d+)%\)")


def _inbox(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    if str(event.get("category") or "") != "budget_alert":
        return []
    summary = clean(event.get("summary"), 200, one_line=True) or "spend crossed a budget alert"
    ident = clean(event.get("item_id"), 120, one_line=True)
    urgency = clean(event.get("urgency"), 20, one_line=True) or None
    data: dict[str, Any] = {"item_id": ident or None, "urgency": urgency}
    found = _BUDGET_ALERT.fullmatch(summary)
    if found:
        spent, cap, percent = float(found["spent"]), float(found["cap"]), int(found["pct"])
        data.update(percent=percent, spent_usd=spent, cap_usd=cap)
        summary = f"spend passed {percent}% of the cap: ${spent:.2f} of ${cap:.2f}"
    key = ident if ident.startswith("budget:") else f"budget:{ident or summary[:40]}"
    return [("budget", summary, data, key)]


def _confirm_waiting(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    seconds = event.get("timeout_secs")
    minutes = round(seconds / 60) if _number(seconds) and seconds > 0 else None
    wait = f" ({minutes} min)" if minutes else ""
    attempt_key = clean(event.get("attempt_key"), 200, one_line=True)
    data = {
        "attempt": _attempt(event.get("attempt")),
        "attempt_key": attempt_key or None,
        "rung": clean(event.get("rung"), 80, one_line=True) or None,
        "question": clean(event.get("question"), 300) or None,
        "timeout_secs": int(seconds) if _number(seconds) else None,
        "deadline_at": clean(event.get("deadline_at"), 40, one_line=True) or None,
        "state": "waiting",
    }
    text = f"{task} waits for your sign-off{wait}"
    return [("hold", text, data, f"hold:{plan}:{task}:{attempt_key}:waiting")]


def _confirm_resolved(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    outcome = clean(event.get("outcome"), 40, one_line=True) or "answered"
    attempt_key = clean(event.get("attempt_key"), 200, one_line=True)
    words = {"timed_out": "timed out, the check was skipped", "stopped": "stopped with the run"}
    data = {
        "attempt": _attempt(event.get("attempt")),
        "attempt_key": attempt_key or None,
        "rung": clean(event.get("rung"), 80, one_line=True) or None,
        "outcome": outcome,
        "note": clean(event.get("note"), 300) or None,
        "state": "resolved",
    }
    text = f"{task} sign-off: {words.get(outcome, outcome)}"
    return [("hold", text, data, f"hold:{plan}:{task}:{attempt_key}:resolved")]


def _phase(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    old = str(event.get("old_phase") or "")
    new = str(event.get("new_phase") or "")
    if new == "awaiting_approval":
        return [
            (
                "hold",
                f"{task} waits for your review",
                {"state": "waiting"},
                f"review:{plan}:{task}:{old}>{new}",
            )
        ]
    if old == "awaiting_approval":
        return [
            ("hold", f"{task} review answered", {"state": "resolved"}, f"review:{plan}:{task}:{old}>{new}")
        ]
    return []


def _effect_staged(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    ident = clean(event.get("effect_id"), 120, one_line=True)
    tool = clean(event.get("tool"), 80, one_line=True) or "a tool"
    server = clean(event.get("server"), 80, one_line=True)
    where = f" on {server}" if server else ""
    data = {
        "effect_id": ident or None,
        "tool": tool,
        "server": server or None,
        "attempt": _attempt(event.get("attempt")),
    }
    who = task or "the run"
    return [("tool_held", f"{who} wants to call {tool}{where}: held for you", data, f"effect:{ident}:staged")]


def _effect_decided(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    ident = clean(event.get("effect_id"), 120, one_line=True)
    tool = clean(event.get("tool"), 80, one_line=True) or "the held call"
    server = clean(event.get("server"), 80, one_line=True)
    outcome = clean(event.get("outcome"), 40, one_line=True) or "decided"
    where = f" on {server}" if server else ""
    data = {
        "effect_id": ident or None,
        "tool": tool,
        "server": server or None,
        "outcome": outcome,
        "decided_by": clean(event.get("decided_by"), 80, one_line=True) or None,
    }
    return [("tool_decided", f"{tool}{where}: {outcome}", data, f"effect:{ident}:decided")]


def _knowledge(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    admission = clean(event.get("admission"), 40, one_line=True)
    lesson = clean(event.get("lesson"), 160, one_line=True)
    entry = clean(event.get("entry_id"), 120, one_line=True)
    raw_reinforced, raw_promoted = event.get("reinforced"), event.get("promoted")
    reinforced = int(raw_reinforced) if _number(raw_reinforced) else 0
    promoted = int(raw_promoted) if _number(raw_promoted) else 0
    if lesson.lower() in ("none", "null", "n/a", "-"):  # roko's protocol for no lesson
        lesson = ""
    # What happened, as the pages word a task's lessons: "nothing new to learn from this task · confirmed 3
    # lessons it had · 3 moved up a tier". A duplicate is a confirmation: its count says it once.
    what = (
        ""
        if admission == "duplicate" and reinforced
        else ADMISSION_WORDS.get(admission) or admission.replace("_", " ") or ("kept" if lesson else "")
    )
    said = [what] if what else []
    if reinforced:
        said.append(f"confirmed {reinforced} lesson{'s' if reinforced != 1 else ''} it had")
    if promoted:
        said.append(f"{promoted} moved up a tier")
    if lesson:  # the lesson itself, after what happened to it
        said = [f"{said[0]}: {lesson}", *said[1:]] if said else [lesson]
    said = said or [ADMISSION_WORDS["no_candidate"]]
    if not task:
        said[0] = said[0].replace("from this task", "from this run")
    text = f"{task or 'the run'}: " + " · ".join(said)
    data = {
        "admission": admission or None,
        "entry_id": entry or None,
        "reinforced": reinforced,
        "promoted": promoted,
        "lesson": lesson or None,
    }
    return [
        ("knowledge", text, data, f"knowledge:{plan}:{task}:{entry or admission}:{reinforced}:{promoted}")
    ]


def _thresholds(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    rungs = threshold_rungs(event.get("snapshot_json"))
    observations = sum(rung["observations"] for rung in rungs)
    shown = [
        f"{rung['name']} {round(rung['ema_pass_rate'] * 100)}%"
        for rung in rungs[:3]
        if rung["ema_pass_rate"] is not None
    ]
    text = "gate thresholds updated" + (f": {' · '.join(shown)}" if shown else "")
    return [("thresholds", text, {"rungs": rungs[:8]}, f"thresholds:{observations}:{len(rungs)}")]


def _loop_health(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    loop_id = clean(event.get("loop_id"), 40, one_line=True) or "a loop"
    told = clean(event.get("state"), 40, one_line=True)
    state = told or "?"
    reason = clean(event.get("reason"), 120, one_line=True)
    data = {
        "loop_id": loop_id,
        "state": state,
        "reason": reason or None,
        "h": _float(event.get("h")),
        "eps": _float(event.get("eps")),
        "iota_net": _float(event.get("iota_net")),
        "beta": _float(event.get("beta")),
    }
    text = f"{loop_name(loop_id)}: {loop_state_words(told, reason)}" + _audit_figures(data)
    stamp = clean(event.get("ts"), 40, one_line=True)
    return [("loop_health", text, data, f"loop:{loop_id}:{state}:{stamp}")]


def _loop_transition(event: dict[str, Any], ctx: LoopContext, plan: str, task: str | None) -> Emit:
    loop_id = clean(event.get("loop_id"), 40, one_line=True) or "a loop"
    before = clean(event.get("from"), 40, one_line=True) or "?"
    after = clean(event.get("to"), 40, one_line=True) or "?"
    reason = clean(event.get("reason"), 120, one_line=True)
    data = {
        "loop_id": loop_id,
        "from": before,
        "to": after,
        "state": after,
        "reason": reason or None,
        "rule": clean(event.get("rule"), 80, one_line=True) or None,
        "actor": clean(event.get("actor"), 40, one_line=True) or None,
    }
    stamp = clean(event.get("ts"), 40, one_line=True)
    # The state it left in a word, then the new state as the pages say it; its reason, when those words leave
    # it out.
    left = LOOP_STATES.get(before) or before.replace("_", " ")
    text = f"{loop_name(loop_id)}: {left} → {loop_state_words(after, reason)}"
    if reason and after not in ("flagged", "demoted"):
        text += f" ({loop_reason(reason)})"
    return [("loop_health", text, data, f"loop:{loop_id}:{before}>{after}:{stamp}")]


def loop_name(loop_id: str) -> str:
    """A learning loop's name as people know it, or its id."""
    return LOOP_NAMES.get(loop_id, loop_id)


def loop_reason(reason: str) -> str:
    """Why the audit flagged or demoted a loop, in words."""
    return LOOP_REASONS.get(reason) or reason.removeprefix("dormant:").replace("_", " ")


def loop_state_words(state: str, reason: str = "") -> str:
    """A loop's audit state as the pages say it (ui-notes D8): "on probation", "proven: its learning is in
    use", "flagged: no chance to act yet", "demoted: roko uses its default (it made things worse)"; another
    state as roko writes it."""
    why = loop_reason(reason) if reason else ""
    if state == "probation":
        return "on probation"
    if state == "live":
        return "proven: its learning is in use"
    if state == "flagged":
        return "flagged" + (f": {why}" if why else "")
    if state == "demoted":
        return "demoted: roko uses its default" + (f" ({why})" if why else "")
    return state.replace("_", " ") or "not checked yet"


def _audit_figures(data: dict[str, Any]) -> str:
    """A loop's holdout share (h) and reach (eps: how often what it learned reached a decision), as %."""
    parts = []
    if data.get("h") is not None:
        parts.append(f"holdout {round(data['h'] * 100)}%")
    if data.get("eps") is not None:
        parts.append(f"reach {round(data['eps'] * 100)}%")
    return "".join(f" · {part}" for part in parts)


_HANDLERS = {
    "route_decided": _route,
    "agent_spawned": _spawned,
    "task_started": _task_started,
    "event_log_entry": _log_entry,
    "diagnosis": _diagnosis,
    "inbox_item_received": _inbox,
    "confirm_waiting": _confirm_waiting,
    "confirm_resolved": _confirm_resolved,
    "task_phase_changed": _phase,
    "effect_staged": _effect_staged,
    "effect_decided": _effect_decided,
    "knowledge_written": _knowledge,
    "gate_thresholds_updated": _thresholds,
    "loop_health": _loop_health,
    "loop_transition": _loop_transition,
}
# Event types that light a loop (or feed the classification of one).
LOOP_TYPES = frozenset(_HANDLERS)
# Event types that name no plan; under roko serve they belong to whichever run is recording.
UNPLANNED_TYPES = frozenset({"gate_thresholds_updated", "loop_health", "loop_transition"})
# Event types that name one only sometimes (a guard's notice has empty ids; a diagnosis may not say).
_SCOPELESS_TYPES = frozenset({"event_log_entry", "diagnosis", "inbox_item_received"})


# -- helpers ------------------------------------------------------------------------------


def decided_by(source: Any, stage: Any = None, reason: Any = None) -> str | None:
    """What decided a route: `ladder`, `router` (its fixed role table), `learned`, `pinned`, `fallback`,
    `failover` or `explore`; None when roko does not say."""
    said = str(source or reason or "")
    if said == "router":
        # The cascade's `static` stage is its fixed role table: nothing learned picked that model.
        return "router" if str(stage or "") in ("", "static") else "learned"
    return DECIDED_BY.get(said)


def route_words(route: dict[str, Any]) -> str:
    """The pick's maker, as people say it ("ladder rung cheap", "learned", "roko's default for the role")."""
    who = route.get("decided_by")
    if who == "ladder":
        return (
            f"picked by the model ladder (rung {route['rung']})"
            if route.get("rung")
            else "picked by the model ladder"
        )
    if who == "router":
        return "roko's default for the role"
    if who == "learned":
        return "picked by what roko learned"
    if who == "pinned":
        return "named by the task"
    if who == "explore":
        return "exploring"
    if who == "fallback":
        return "roko's fallback"
    if who is None:
        source = str(route.get("source") or "")
        return ROUTE_SOURCES.get(source, source)
    return str(who)


def is_cli_provider(provider: Any) -> bool:
    """Whether a provider's agent runs its own tools (a CLI or ACP agent), as roko's `claude_cli` does."""
    name = str(provider or "").lower()
    return name in CLI_PROVIDERS or bool(_CLI_PROVIDER.search(name))


def route_view(route: Any, *, chat_run: bool = False) -> dict[str, Any] | None:
    """A route as the pages show it: what decided it, its ladder rung, whether its scores decided it,
    and for each candidate why it was not picked. In a run a chat host started, models whose agent runs
    its own tools could never be picked, so they are marked `excluded_by_policy`."""
    if not isinstance(route, dict):
        return None
    out = dict(route)
    who = decided_by(route.get("source"), route.get("stage"), route.get("reason"))
    out["decided_by"] = who
    out["rung"] = clean(route.get("rung"), 40, one_line=True) or None
    out["scored"] = who in ("learned", "explore")
    candidates = []
    for raw in route.get("candidates") or []:
        if not isinstance(raw, dict):
            continue
        candidate = dict(raw)
        why = None
        if candidate.get("eligible") is False:
            reason = str(candidate.get("ineligible_reason") or "")
            why = WHY_NOT.get(reason) or (reason.replace("_", " ") if reason else "roko could not pick it")
        if (
            chat_run
            and candidate.get("model") != route.get("model")
            and is_cli_provider(candidate.get("provider"))
        ):
            candidate["eligible"] = False
            candidate["excluded_by_policy"] = True
            why = why or "it runs its own tools, so a run from Hermes cannot use it"
        candidate["why_not"] = why
        candidates.append(candidate)
    out["candidates"] = candidates
    return out


def route_candidates(value: Any) -> list[dict[str, Any]]:
    """A route's candidates, cleaned: at most five, the picked model first."""
    out = []
    for candidate in value if isinstance(value, list) else []:
        if not isinstance(candidate, dict):
            continue
        out.append(
            {
                "model": clean(candidate.get("model") or candidate.get("id"), 80, one_line=True) or "?",
                "provider": clean(candidate.get("provider"), 60, one_line=True) or None,
                "score": _float(candidate.get("score")),
                "p": _float(candidate.get("p")),
                "eligible": candidate.get("eligible") is not False,
                "ineligible_reason": clean(candidate.get("ineligible_reason"), 160, one_line=True) or None,
            }
        )
        if len(out) >= MAX_CANDIDATES:
            break
    return out


def threshold_rungs(snapshot: Any) -> list[dict[str, Any]]:
    """The adaptive thresholds in a `gate_thresholds_updated` snapshot, most observed first."""
    data = snapshot
    if isinstance(snapshot, str):
        try:
            data = json.loads(snapshot)
        except ValueError:
            return []
    rungs = data.get("rungs") if isinstance(data, dict) else None
    out: list[dict[str, Any]] = []
    for key, stats in rungs.items() if isinstance(rungs, dict) else []:
        if not isinstance(stats, dict):
            continue
        try:
            number = int(key)
        except (TypeError, ValueError):
            number = -1
        observations = stats.get("total_observations", stats.get("total_count"))
        out.append(
            {
                "rung": number,
                "name": RUNG_NAMES.get(number, clean(key, 40, one_line=True)),
                "ema_pass_rate": _rate(stats.get("ema_pass_rate")),
                "observations": int(observations) if _number(observations) else 0,
                "consecutive_passes": _whole(stats.get("consecutive_passes")),
                "shift": stats.get("cusum_shift_detected") is True,
            }
        )
    out.sort(key=lambda rung: (-rung["observations"], rung["rung"]))
    return out


def _diagnosis_source(ident: str) -> str:
    """Who raised a diagnosis, from its id (`conductor:…`, `stall-watchdog:…`, `ladder_exhausted:…`)."""
    head = ident.split(":", 1)[0]
    return {
        "conductor": "conductor",
        "stall-watchdog": "stall watchdog",
        "ladder_exhausted": "model ladder exhausted",
        "self_model_refine": "self-model",
        "self_model_abandon": "self-model",
    }.get(head, head.replace("_", " ") or "roko")


def _attempt(*values: Any) -> int | None:
    for value in values:
        if _number(value) and int(value) > 0:
            return int(value)
    return None


def _number(value: Any) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def _whole(value: Any) -> int:
    return int(value) if _number(value) else 0


def as_dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _float(value: Any) -> float | None:
    if not _number(value):
        return None
    return float(value)


def _rate(value: Any) -> float | None:
    number = _float(value)
    return None if number is None else round(min(1.0, max(0.0, number)), 4)


def _ms(value: Any) -> int | None:
    return int(value) if _number(value) and value > 0 else None

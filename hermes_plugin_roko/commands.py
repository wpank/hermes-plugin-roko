"""`/roko`: the person's own view of roko, and their direct answers to it.

A slash command comes from the person, never the model, so `/roko approve`
and `/roko reject` record decisions without a second approval prompt. Items
are named by a short code derived from the decision itself, not by their
position in a list: in a gateway, several chats share one process, and a list
one chat saw can be stale by the time another answers.

In the gateway Hermes calls the handler on its event loop, so the handler is
async and does its HTTP work in a thread.
"""

from __future__ import annotations

import asyncio
import logging
import shlex
from collections.abc import Awaitable, Callable
from typing import Any

from . import render
from .decisions import answer, parse_decision_id, pending_confirmations, pending_effects, short_code
from .diagnostics import run_doctor
from .errors import Code, RokoError
from .runtime import Runtime
from .tools import call, overview

logger = logging.getLogger(__name__)

USAGE = """/roko — roko from Hermes
  /roko status [RUN_ID]           roko's health and recent runs, or one run
  /roko plans [PLAN_ID]           list plans, or show one plan's tasks
  /roko pending                   what roko runs wait on you for, each with a code
  /roko approve CODE [NOTE]       approve that item
  /roko reject CODE [NOTE]        reject it; the note is the run's feedback
  /roko cancel RUN_ID             stop a run
  /roko recall QUERY              search roko's project knowledge
  /roko doctor                    check the connection to roko"""

ARGS_HINT = "[status|plans|pending|approve|reject|cancel|recall|doctor]"


def make_command(rt: Runtime) -> Callable[[str], Awaitable[str]]:
    async def roko_command(raw_args: str = "") -> str:
        return await asyncio.to_thread(run_command, rt, raw_args)

    return roko_command


def run_command(rt: Runtime, raw_args: str) -> str:
    try:
        words = shlex.split(raw_args or "")
    except ValueError:
        words = (raw_args or "").split()
    sub = words[0].lower() if words else "help"
    rest = words[1:]
    try:
        handler = _SUBCOMMANDS.get(sub)
        if handler is None:
            return f"Unknown subcommand {sub!r}.\n\n{USAGE}"
        return handler(rt, rest)
    except RokoError as exc:
        return exc.one_line()
    except Exception as exc:
        logger.exception("roko: /roko %s failed", sub)
        return f"roko: /roko {sub} failed: {type(exc).__name__}: {exc}"


def _help(rt: Runtime, rest: list[str]) -> str:
    return USAGE


def _status(rt: Runtime, rest: list[str]) -> str:
    if not rest:
        return render.overview(overview(rt))
    return render.run(call(rt, "roko_status", {"run_id": rest[0], "wait_secs": 0}))


def _plans(rt: Runtime, rest: list[str]) -> str:
    if rest:
        return render.plan(call(rt, "roko_plans", {"plan_id": rest[0]}))
    return render.plans(call(rt, "roko_plans", {}))


def _pending(rt: Runtime, rest: list[str]) -> str:
    return render.pending(_collect_pending(rt))


def _collect_pending(rt: Runtime) -> list[dict[str, Any]]:
    """Everything roko waits on the person for: confirmations of Hermes' runs, and all held actions."""
    client = rt.client()
    items: list[dict[str, Any]] = []
    for run in rt.runs.recent(10):
        if run.get("state") in ("running", "queued", None):
            try:
                items.extend(pending_confirmations(client, str(run["run_id"])))
            except RokoError as exc:
                if exc.code is not Code.NOT_FOUND:
                    raise
    items.extend(pending_effects(client))
    for item in items:
        item["code"] = short_code(str(item["decision_id"]))
    return items


def _decide(approve: bool) -> Callable[[Runtime, list[str]], str]:
    def decide(rt: Runtime, rest: list[str]) -> str:
        verb = "approve" if approve else "reject"
        if not rest:
            return f"Usage: /roko {verb} CODE [NOTE]. /roko pending lists the codes."
        target, note = rest[0], " ".join(rest[1:]) or None
        item = _find(rt, target)
        decision = parse_decision_id(str(item["decision_id"]))
        body = answer(rt.client(), decision, approve, note)
        done = "approved" if approve else "rejected"
        outcome = (body.get("decision") or body.get("outcome")) if isinstance(body, dict) else None
        suffix = f" ({outcome})" if outcome and outcome != done else ""
        return f"Recorded: {done} {render.pending_title(item)}{suffix}."

    return decide


def _find(rt: Runtime, target: str) -> dict[str, Any]:
    """The pending item a code (or full decision id) names, looked up fresh."""
    wanted = target.strip()
    matches = [
        item
        for item in _collect_pending(rt)
        if item["code"] == wanted.lower() or item["decision_id"] == wanted
    ]
    if not matches:
        raise RokoError(
            Code.NOT_FOUND,
            f"nothing waiting on you has the code {target!r}; it may have been answered already",
            hint="run /roko pending to see what still waits",
        )
    return matches[0]


def _cancel(rt: Runtime, rest: list[str]) -> str:
    if not rest:
        return "Usage: /roko cancel RUN_ID"
    body = rt.client().call_tool("run_cancel", {"run_id": rest[0]})
    rt.runs.update(rest[0], state="cancelled")
    state = body.get("state", "cancelled") if isinstance(body, dict) else "cancelled"
    return f"run {rest[0]}: {state}"


def _recall(rt: Runtime, rest: list[str]) -> str:
    if not rest:
        return "Usage: /roko recall QUERY"
    return render.recall(call(rt, "roko_recall", {"query": " ".join(rest), "limit": 8}))


def _doctor(rt: Runtime, rest: list[str]) -> str:
    return render.doctor(run_doctor(rt, probe_runs="--no-probe" not in rest))


_SUBCOMMANDS: dict[str, Callable[[Runtime, list[str]], str]] = {
    "help": _help,
    "status": _status,
    "plans": _plans,
    "plan": _plans,
    "pending": _pending,
    "approve": _decide(True),
    "reject": _decide(False),
    "cancel": _cancel,
    "recall": _recall,
    "doctor": _doctor,
}

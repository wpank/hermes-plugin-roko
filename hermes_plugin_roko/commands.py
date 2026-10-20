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

from . import insights, ledger, render, views
from .decisions import answer, parse_decision_id
from .diagnostics import run_doctor
from .errors import Code, RokoError
from .rundata import explain
from .runtime import Runtime
from .sanitize import clean, home_relative
from .tools import call, decision_outcome

logger = logging.getLogger(__name__)

USAGE = """/roko — roko from Hermes
  /roko status [RUN_ID|last] [why]  health, spend and recent runs; or one run's card
  /roko runs                        runs started from Hermes, with state and cost
  /roko plans [PLAN_ID]             list plans, or one plan's waves and estimate
  /roko pending                     what roko runs wait on you for, each with a code
  /roko approve CODE [NOTE]         approve that item
  /roko reject CODE [NOTE]          reject it; the note goes back to the run
  /roko cancel RUN_ID|last          stop a run
  /roko cost                        roko spend today against the daily limit
  /roko gates                       gate pass rates across roko's workspace
  /roko learn                       models roko used, their success and cost
  /roko effects                     held actions, and how they were decided
  /roko knowledge QUERY             search roko's project knowledge (or: recall)
  /roko doctor                      check the connection to roko"""

ARGS_HINT = "[status|runs|plans|pending|approve|reject|cancel|cost|gates|learn|effects|knowledge|doctor]"
DESCRIPTION = "roko runs, plans, approvals and spend"


def make_command(rt: Runtime) -> Callable[[str], Awaitable[str]]:
    async def roko_command(raw_args: str = "") -> str:
        # The chat shows it: the person's home as `~`, as on the pages (sanitize.home_relative).
        return home_relative(await asyncio.to_thread(run_command, rt, raw_args))

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
        return f"roko: /roko {sub} failed: {type(exc).__name__}: {clean(exc, 300, one_line=True)}"


def _help(rt: Runtime, rest: list[str]) -> str:
    return USAGE


def _status(rt: Runtime, rest: list[str]) -> str:
    if not rest:
        return render.overview(views.overview(rt))
    run = views.card(rt, rest[0])
    why = None
    if len(rest) > 1 and rest[1].lower() == "why":
        why = explain(rt.cards, rt.for_run(str(run.get("run_id"))).settings().url, run)
    return render.card(run, why)


def _runs(rt: Runtime, rest: list[str]) -> str:
    client = rt.client()
    runs = rt.runs.recent(15)
    views.refresh_runs(rt, client, runs)
    return render.runs(views.run_rows(rt, runs), views.spend(rt))


def _cost(rt: Runtime, rest: list[str]) -> str:
    client = rt.client()
    runs = rt.runs.recent(200)
    views.refresh_runs(rt, client, runs[:20])
    today = ledger.local_today()
    rows = views.run_rows(rt, runs)
    for row, run in zip(rows, runs, strict=True):
        row["today"] = ledger.local_day(run.get("started_at")) == today
    return render.cost(views.spend(rt), rows)


def _plans(rt: Runtime, rest: list[str]) -> str:
    if rest:
        return render.plan(call(rt, "roko_plans", {"plan_id": rest[0]}))
    return render.plans(call(rt, "roko_plans", {}))


def _pending(rt: Runtime, rest: list[str]) -> str:
    return render.pending(views.collect_pending(rt, rt.client()))


def _decide(approve: bool) -> Callable[[Runtime, list[str]], str]:
    def decide(rt: Runtime, rest: list[str]) -> str:
        verb = "approve" if approve else "reject"
        if not rest:
            return f"Usage: /roko {verb} CODE [NOTE]. /roko pending lists the codes."
        target, note = rest[0], " ".join(rest[1:]) or None
        item = _find(rt, target)
        decision = parse_decision_id(str(item["decision_id"]))
        client = rt.client()
        body = answer(views.decision_client(rt, client, decision), decision, approve, note)
        done = "approved" if approve else "rejected"
        outcome = decision_outcome(body, approve)
        suffix = f" ({outcome})" if outcome != done else ""
        return f"Recorded: {done} {render.pending_title(item)}{suffix}."

    return decide


def _find(rt: Runtime, target: str) -> dict[str, Any]:
    """The pending item a code (or full decision id) names, looked up fresh."""
    wanted = target.strip()
    matches = [
        item
        for item in views.collect_pending(rt, rt.client())
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
        return "Usage: /roko cancel RUN_ID (or last)"
    run_id = views.resolve_run_id(rt, rest[0])
    body = rt.for_run(run_id).client().call_tool("run_cancel", {"run_id": run_id})
    rt.runs.update(run_id, state="cancelled")
    state = body.get("state", "cancelled") if isinstance(body, dict) else "cancelled"
    return f"⊘ run {render.short(run_id)}: {state}"


def _knowledge(rt: Runtime, rest: list[str]) -> str:
    if not rest:
        return "Usage: /roko knowledge QUERY"
    return render.recall(call(rt, "roko_recall", {"query": " ".join(rest), "limit": 8}))


def _gates(rt: Runtime, rest: list[str]) -> str:
    if rest:  # one run's gates
        return render.card(views.card(rt, rest[0]))
    return render.gates(insights.gates(rt.client()))


def _learn(rt: Runtime, rest: list[str]) -> str:
    client = rt.client()
    models, models_problem = insights.safe(insights.models, client)
    spend, spend_problem = insights.safe(insights.efficiency, client)
    if models is None and spend is None:
        raise RokoError(Code.UNREACHABLE, models_problem or spend_problem or "roko did not answer")
    return render.learn(models, spend)


def _effects(rt: Runtime, rest: list[str]) -> str:
    return render.effects(insights.effects(rt.client()))


def _doctor(rt: Runtime, rest: list[str]) -> str:
    return render.doctor(run_doctor(rt, probe_runs="--no-probe" not in rest))


_SUBCOMMANDS: dict[str, Callable[[Runtime, list[str]], str]] = {
    "help": _help,
    "status": _status,
    "run": _status,
    "runs": _runs,
    "plans": _plans,
    "plan": _plans,
    "pending": _pending,
    "approve": _decide(True),
    "reject": _decide(False),
    "cancel": _cancel,
    "cost": _cost,
    "spend": _cost,
    "gates": _gates,
    "learn": _learn,
    "effects": _effects,
    "knowledge": _knowledge,
    "recall": _knowledge,
    "doctor": _doctor,
}

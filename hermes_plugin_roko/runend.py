"""The chat that started a run hears when it ends (round v7, hermes-pilot P-13).

A run outlives the turn that started it: the chat's model waits on roko_status for a while, answers with a
snapshot ("still running"), and nothing tells the chat when the run ends. The person has to ask. Now:

- **By default** the chat's next turn leads with the outcome. Hermes' `pre_llm_call` hook adds it to the
  person's message: once per ended run, only in the chat that started it, and only for an end the chat has
  not already seen in a roko_status answer. Before it answers, the hook asks roko about that chat's runs the
  log says still run (a few, one quick request each), so no page has to be open.
- **Opt in**, `run_end_follow_up` with Hermes' `plugins.entries.roko.allow_gateway_injection`: when a page or
  the live relay sees the run end, the plugin sends that chat one short turn, so its model reports the end
  without being asked. That is one model call per run.

An end counts once the plugin has seen the run turn from going to ended (`ended_seen_at` in the run log), so
runs that ended before this version, and ends a chat already heard about, are never announced.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from . import rundata, views
from .catalog import TERMINAL_STATES
from .errors import RokoError
from .runtime import Runtime
from .sanitize import clean

logger = logging.getLogger(__name__)

KINDS = ("run", "plan", "plan_generate")
# The runs of one chat the log says still run, asked of roko at each of its turns; the ends told in one turn.
CHECK_ACTIVE = 3
MAX_TOLD = 3


def make_hook(rt: Runtime) -> Callable[..., dict[str, str] | None]:
    """Hermes' `pre_llm_call` hook: `{"context": …}` for the chat's next message when a run it started
    ended."""

    def pre_llm_call(session_id: str = "", **_: Any) -> dict[str, str] | None:
        try:
            news = ended_news(rt, session_id)
        except Exception:  # a hook never stops the chat
            logger.debug("roko: could not tell the chat about its ended runs", exc_info=True)
            return None
        return {"context": news} if news else None

    return pre_llm_call


def ended_news(rt: Runtime, session_id: str) -> str | None:
    """What the chat `session_id` has not heard: the runs it started that ended since (each once)."""
    if not session_id:
        return None
    mine = [
        run
        for run in rt.runs.recent(100)
        if run.get("session_id") == session_id and run.get("kind") in KINDS and not run.get("told")
    ]
    for run in [run for run in mine if run.get("state") not in TERMINAL_STATES][:CHECK_ACTIVE]:
        _look(rt, run)
    ended = [run for run in mine if run.get("state") in TERMINAL_STATES and run.get("ended_seen_at")]
    if not ended:
        return None
    ended = ended[:MAX_TOLD]
    for run in ended:
        rt.runs.update(str(run["run_id"]), told=True)
    lines = "\n".join(f"- {outcome(run)}" for run in ended)
    which = (
        "A roko run this chat started has"
        if len(ended) == 1
        else f"{len(ended)} roko runs this chat started have"
    )
    return (
        f"[roko] {which} ended since your last reply:\n{lines}\n"
        "Lead your reply with one short line saying so, then answer the person's message."
    )


def _look(rt: Runtime, run: dict[str, Any]) -> None:
    """Ask roko how a run the log says still runs stands; when it ended, log the end as seen now."""
    run_id = str(run.get("run_id") or "")
    client = views.run_client(rt, rt.client(), run)
    if not run_id or client is None:
        return
    try:
        summary = rundata.run_status(client, run_id)
    except RokoError as exc:
        logger.debug("roko: no state for run %s: %s", run_id, exc.message)
        return
    state = clean(summary.get("state"), 40, one_line=True)
    if state not in TERMINAL_STATES:
        return
    fields: dict[str, Any] = {"state": state, "ended_seen_at": rundata.now_iso()}
    cost = summary.get("cost_usd")
    if isinstance(cost, (int, float)) and not isinstance(cost, bool) and cost >= 0:
        fields["cost_usd"] = round(float(cost), 6)
    counts = summary.get("tasks")
    if isinstance(counts, dict) and isinstance(counts.get("total"), int) and counts["total"] > 0:
        fields["progress"] = rundata.progress_of_counts(counts, True)
    result = summary.get("result")
    if run.get("kind") == "plan_generate" and isinstance(result, dict) and result.get("slug"):
        fields["plan_id"] = clean(result.get("slug"), 120, one_line=True)
    run.update(fields)
    rt.runs.update(run_id, **fields)


def outcome(run: dict[str, Any]) -> str:
    """A run's end in one line: what it was, its short id, how it ended, its tasks and spend, and why it
    failed."""
    run_id = str(run.get("run_id") or "")
    label = clean(run.get("label"), 80, one_line=True) or run_id
    state = str(run.get("state") or "ended")
    short = rundata.short_run_id(run_id)
    if run.get("kind") == "plan_generate":
        plan = clean(run.get("plan_id"), 120, one_line=True)
        if state == "succeeded":
            return (
                f"roko wrote the plan “{label}”"
                + (f" ({plan})" if plan else "")
                + ": review it, then run it."
            )
        return f"roko's plan writing “{label}” ({short}) {state}" + (
            f": {clean(run.get('note'), 160)}" if run.get("note") else "."
        )
    parts = [state]
    progress = run.get("progress")
    if isinstance(progress, dict) and isinstance(progress.get("total"), int) and progress["total"]:
        parts.append(f"{int(progress.get('passed') or 0)}/{progress['total']} tasks passed")
    if isinstance(run.get("cost_usd"), (int, float)):
        parts.append(f"${float(run['cost_usd']):.2f}")
    why = clean(run.get("why"), 240, one_line=True) if state != "succeeded" else ""
    return f"“{label}” ({short}): {', '.join(parts)}" + (f". {why}" if why else ".")


def follow_up(rt: Runtime, run_id: str) -> bool:
    """Opt in (`run_end_follow_up`): send the chat that started `run_id` one short turn now that it ended,
    through Hermes' `inject_message` (it needs `plugins.entries.roko.allow_gateway_injection`). Whether Hermes
    took it."""
    try:
        if not rt.settings().run_end_follow_up:
            return False
    except Exception:
        return False
    run = rt.runs.get(run_id)
    inject = getattr(rt.ctx, "inject_message", None)
    if not run or run.get("told") or not run.get("session_id") or run.get("state") not in TERMINAL_STATES:
        return False
    if not callable(inject):
        return False
    words = f"[roko] {outcome(run)} Tell the person in a line or two; nothing else needs doing."
    try:
        taken = bool(inject(words, role="user", session_key=str(run["session_id"])))
    except Exception:
        logger.debug("roko: could not send the end of run %s to its chat", run_id, exc_info=True)
        return False
    if taken:
        rt.runs.update(run_id, told=True)
    return taken

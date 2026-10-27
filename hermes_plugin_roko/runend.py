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

from . import resume, rundata, views
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
    resumes = [_resume_words(rt, run) for run in ended]
    lines = "\n".join(f"- {outcome(run)}{words}" for run, words in zip(ended, resumes, strict=True))
    which = (
        "A roko run this chat started has"
        if len(ended) == 1
        else f"{len(ended)} roko runs this chat started have"
    )
    can = " and that it can be resumed," if any(resumes) else ""
    return (
        f"[roko] {which} ended since your last reply:\n{lines}\n"
        f"Lead your reply with one short line saying so,{can}{_recharge(ended)} then answer the person's "
        "message."
    )


# The ends of a plan run roko may resume (resume.py's): a stopped run's tasks that passed are kept.
STOPPED = ("failed", "interrupted", "cancelled")


def _resume_words(rt: Runtime, run: dict[str, Any]) -> str:
    """For a stopped plan run roko can resume, as the plan's row names it (or, from an older roko, the run
    log), what a resume runs (P-62: the pilot's window B answered from the end news alone and never said so,
    though the card offers it); '' for any other run, and for one whose card offers no resume."""
    if run.get("kind") != "plan" or run.get("state") not in STOPPED or not run.get("plan_id"):
        return ""
    if run.get("resume_offered") is False:  # its card said a resume would not help (a refusal that stays)
        return ""
    client = views.run_client(rt, rt.client(), run)
    if client is None:
        return ""
    try:
        found = resume.resumable_run(rt, client, str(run["plan_id"]))
    except Exception:  # the news matters more than the offer
        logger.debug("roko: could not ask whether run %s can be resumed", run.get("run_id"), exc_info=True)
        return ""
    if found is None or found.get("run_id") != run.get("run_id") or found.get("continues") is False:
        return ""
    if found.get("delivery_pending") is True:
        what = "no task runs again, only its delivery"
    else:
        left = list(found.get("tasks_left") or [])
        many = len(left) != 1
        what = (
            f"only {resume.names(left)} {'run' if many else 'runs'}"
            if left
            else "only what did not pass runs"
        )
    return f" It can be resumed: {what}; offer that, and resume it only if the person asks."


def _recharge(runs: list[dict[str, Any]]) -> str:
    """The chat's ask when a provider could not bill the account in one of `runs` (roko bug-390e4b): roko's
    line goes to the person as it is, since only they can recharge it."""
    billing = any(
        isinstance(item, dict) and item.get("billing")
        for run in runs
        for item in run.get("provider_exhausted") or []
    )
    return (
        " quote roko's words about the provider that could not bill as they are (only the person can recharge"
        " it),"
        if billing
        else ""
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
    if summary.get("provider_exhausted"):  # the providers it went on without (bug-390e4b)
        fields["provider_exhausted"] = rundata.kept_refusals(summary["provider_exhausted"])
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
    # roko's own line for each provider it went on without (bug-390e4b), for the chat to pass on as it is.
    said = "".join(
        f" roko said: “{clean(item['detail'], 400, one_line=True)}”"
        for item in run.get("provider_exhausted") or []
        if isinstance(item, dict) and item.get("detail")
    )
    return f"“{label}” ({short}): {', '.join(parts)}" + (f". {why}" if why else ".") + said


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
    words = (
        f"[roko] {outcome(run)}{_resume_words(rt, run)} Tell the person in a line or two;{_recharge([run])} "
        "nothing else needs doing."
    )
    try:
        taken = bool(inject(words, role="user", session_key=str(run["session_id"])))
    except Exception:
        logger.debug("roko: could not send the end of run %s to its chat", run_id, exc_info=True)
        return False
    if taken:
        rt.runs.update(run_id, told=True)
    return taken

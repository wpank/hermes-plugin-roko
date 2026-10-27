"""A plan whose last run stopped part way: continue it, or start over (round v7, hermes-pilot P-14).

The pilot asked the chat to resume phase 0 after T1 and T2 passed and T3 failed; the model called
roko_plan_run without `resume`, roko started over, and T1 and T2 ran (and were paid for) again. roko now
refuses a chat's plan run over a run that stopped part way unless it says `resume: true` or `fresh: true`
(bug-cbdb6b), and names the run on the plan's row (`resumable_run`, gap-b78706). The plugin asks first: the
same refusal, in roko's words, comes before Hermes asks the person to approve a paid run.

From an older roko, which starts over and names no run, the plugin reads the plan's last run in its run log.

A chat's `fresh` over such a run is refused too unless it says `set_aside` (P-57): asked "Run it again." in
the pilot's window, the chat started over with no word that the run's passed tasks, its checkpoint and its
spend would be set aside. The refusal names them and offers the resume; the tool text keeps `set_aside` for a
person who said to start over. The pages' start over is the person's own choice, made beside what it sets
aside.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

from . import rundata
from .client import RokoClient, resumable_view
from .errors import Code, Refusal, RokoError, hint_for_refusal
from .runtime import Runtime

# How a stopped run's tasks are named in a refusal: up to six, then the first five and how many more.
NAMES_SHOWN = 6
_STOPPED = ("failed", "interrupted", "cancelled")


def names(tasks: list[str]) -> str:
    """ "T1", "T1 and T2", "T1, T2 and T3"; past six, "T1, T2, T3, T4, T5 and 3 more" (roko's words)."""
    if len(tasks) > NAMES_SHOWN:
        return f"{', '.join(tasks[:5])} and {len(tasks) - 5} more"
    if len(tasks) <= 1:
        return "".join(tasks)
    return f"{', '.join(tasks[:-1])} and {tasks[-1]}"


def words(plan_id: str, found: dict[str, Any]) -> str:
    """roko's refusal, word for word (bug-cbdb6b), from the run it names."""
    short = rundata.short_run_id(str(found.get("run_id") or ""))
    passed, left = list(found.get("passed_tasks") or []), list(found.get("tasks_left") or [])
    status = found.get("status") or "stopped"
    # An older roko names no tasks: the plugin's run log counts them.
    counted = (int(found.get("passed") or 0), int(found.get("left") or 0))
    passed_words = names(passed) if passed else _tasks(counted[0])
    left_words = names(left) if left else _tasks(counted[1])
    many = len(left) > 1 if left else counted[1] != 1
    if found.get("delivery_pending") is True:  # roko's own words since bug-4fadf8 (P-61)
        return (
            f"Plan '{plan_id}' has a run that can be resumed: {short} ({status}) passed {passed_words}, and "
            "its delivery didn't finish. Pass resume=true to deliver it, so no task runs again, or "
            "fresh=true to start over and run every task again."
        )
    return (
        f"Plan '{plan_id}' has a run that can be resumed: {short} ({status}) passed {passed_words}, and "
        f"{left_words} {'are' if many else 'is'} left. Pass resume=true to continue it, so only "
        f"{left_words} {'run' if many else 'runs'}, or fresh=true to start over and set its progress aside."
    )


def _tasks(count: int) -> str:
    return f"{count} task" if count == 1 else f"{count} tasks"


def start_over_words(plan_id: str, found: dict[str, Any], spent: float | None) -> str:
    """What starting over sets aside (P-57): the run, its passed tasks, its checkpoint and what it `spent`,
    and how to continue it instead."""
    short = rundata.short_run_id(str(found.get("run_id") or ""))
    passed, left = list(found.get("passed_tasks") or []), list(found.get("tasks_left") or [])
    counted = (int(found.get("passed") or 0), int(found.get("left") or 0))
    passed_words = names(passed) if passed else _tasks(counted[0])
    left_words = names(left) if left else _tasks(counted[1])
    many_left = len(left) > 1 if left else counted[1] != 1
    many_passed = len(passed) > 1 if passed else counted[0] != 1
    status = found.get("status") or "stopped"
    aside = []
    if passed or counted[0]:
        aside.append(
            f"{passed_words} {'run' if many_passed else 'runs'} again and {'are' if many_passed else 'is'} "
            "paid for again"
        )
    aside.append("its checkpoint is set aside (it can be brought back)")
    if spent:
        aside.append(f"the {rundata.fmt_money(spent)} it spent stays spent")
    listed = aside[0] if len(aside) == 1 else ", ".join(aside[:-1]) + ", and " + aside[-1]
    if found.get("delivery_pending") is True:  # every task passed; a crash cut the delivery (P-61)
        return (
            f"Plan '{plan_id}' has a run that can be resumed: {short} ({status}) passed {passed_words}, and "
            f"its delivery didn't finish. Starting over sets that run aside: {listed}. Pass resume=true to "
            "deliver it, so no task runs again, or fresh=true with set_aside=true to start over anyway."
        )
    return (
        f"Plan '{plan_id}' has a run that can be resumed: {short} ({status}) passed {passed_words}, and "
        f"{left_words} {'are' if many_left else 'is'} left. Starting over sets that run aside: {listed}. "
        f"Pass resume=true to continue it, so only {left_words} {'run' if many_left else 'runs'}, or "
        "fresh=true with set_aside=true to start over anyway."
    )


def start_over_refusal(rt: Runtime, plan_id: str, found: dict[str, Any]) -> RokoError:
    """The refusal of a fresh start that would set `found` aside unasked (P-57), with what it spent: roko's
    figure since bug-b7f6a8, else the run log's."""
    spent = found.get("spent_usd")
    if not isinstance(spent, (int, float)) or isinstance(spent, bool):
        logged = rt.runs.get(str(found.get("run_id") or "")) or {}
        cost = logged.get("cost_usd")
        spent = float(cost) if isinstance(cost, (int, float)) and not isinstance(cost, bool) else None
    message = start_over_words(plan_id, found, spent)
    resumable = {
        key: found.get(key)
        for key in ("run_id", "status", "passed_tasks", "tasks_left", "spent_usd", "delivery_pending")
    }
    return RokoError(
        Code.REFUSED,
        message,
        hint=hint_for_refusal(message, Refusal.START_OVER),
        refusal=Refusal.START_OVER.value,
        resumable={key: value for key, value in resumable.items() if value is not None},
    )


def refusal(plan_id: str, found: dict[str, Any]) -> RokoError:
    """The refusal, as roko gives it, before anything is approved or spent."""
    message = words(plan_id, found)
    resumable = {key: found.get(key) for key in ("run_id", "status", "passed_tasks", "tasks_left")}
    if found.get("delivery_pending") is True:
        resumable["delivery_pending"] = True
    return RokoError(
        Code.REFUSED,
        message,
        hint=hint_for_refusal(message, Refusal.RESUMABLE_RUN),
        refusal=Refusal.RESUMABLE_RUN.value,
        resumable=resumable,
    )


def resumable_run(rt: Runtime, client: RokoClient, plan_id: str) -> dict[str, Any] | None:
    """The run of `plan_id` a plan run would have to continue or set aside: roko's own word on the plan's row
    (gap-b78706), else, from an older roko that has no word for it, the plan's last run in the run log when it
    stopped part way."""
    try:
        row = client.get(f"/api/plans/{quote(plan_id, safe='')}")
    except RokoError:
        row = None
    if isinstance(row, dict) and "resumable_run" in row:
        return resumable_view(row["resumable_run"])
    return predicted(rt, plan_id)


def predicted(rt: Runtime, plan_id: str) -> dict[str, Any] | None:
    """The plan's newest run Hermes started, when it stopped with tasks passed and tasks left."""
    last = next(
        (run for run in rt.runs.recent(200) if run.get("kind") == "plan" and run.get("plan_id") == plan_id),
        None,
    )
    progress = (last or {}).get("progress")
    if not last or last.get("state") not in _STOPPED or not isinstance(progress, dict):
        return None
    total, passed = int(progress.get("total") or 0), int(progress.get("passed") or 0)
    if not 0 < passed < total:
        return None
    return {
        "run_id": str(last["run_id"]),
        "status": last.get("state"),
        "passed_tasks": [],
        "tasks_left": [],
        "passed": passed,
        "left": total - passed,
    }


def check(
    rt: Runtime,
    client: RokoClient,
    plan_id: str,
    *,
    resume: bool,
    fresh: bool,
    from_run: str | None,
    set_aside: bool = False,
) -> None:
    """Refuse what roko would, before Hermes asks for approval: `fresh` with `resume` or `from_run`, a short
    `from_run`, and a plan run that says neither `resume` nor `fresh` over a run that stopped part way. Also,
    the plugin's own (P-57): `fresh` over such a run without `set_aside`, the person's word to start over."""
    if fresh and (resume or from_run):
        raise RokoError(
            Code.INVALID, "fresh starts the plan over, so it cannot be combined with resume or from_run"
        )
    if set_aside and not fresh:
        raise RokoError(
            Code.INVALID, "set_aside goes with fresh: true, when the person chose to start the plan over"
        )
    if from_run is not None and len(from_run) < 8:
        raise RokoError(Code.INVALID, "from_run must be a run id, or at least its first 8 characters")
    if resume or from_run or set_aside:
        return
    found = resumable_run(rt, client, plan_id)
    if found is not None:
        raise start_over_refusal(rt, plan_id, found) if fresh else refusal(plan_id, found)

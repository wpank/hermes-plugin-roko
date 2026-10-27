"""0.8.0 (round v7, roko-ladder's bug-4fadf8): a run whose tasks all passed but whose delivery a crash cut (P-61).

roko-recovery's kill points e and e' stop a run during its merge, its plan check or its batch, after every task
passed. roko now names such a run as one a resume continues, with no task left and `delivery_pending: true`
(bug-4fadf8); before, it read `resumable: false`, and a plain plan run started over and redid every task. A
resume runs no task again: it replays them without a model call and delivers. The plugin says only the delivery
is left, in roko's own words.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import client, rundata, tools

PLAN = "recov"
RUN = "0a7e3e7b-6580-4657-96cb-edc99d0faaf8"
CUT = {
    "run_id": RUN,
    "status": "interrupted",
    "passed_tasks": ["T1", "T2"],
    "tasks_left": [],
    "resumable": True,
    "delivery_pending": True,
    "spent_usd": 0.31,
}
# roko's own refusal of a plan run over it (bug-4fadf8).
ROKO_WORDS = (
    "Plan 'recov' has a run that can be resumed: 0a7e3e7b (interrupted) passed T1 and T2, and its delivery didn't "
    "finish. Pass resume=true to deliver it, so no task runs again, or fresh=true to start over and run every task "
    "again."
)


def _cut(fake: FakeRoko) -> None:
    fake.add_plan(PLAN, "recov", [{"id": "T1"}, {"id": "T2"}])
    fake.plans[PLAN]["resumable_run"] = dict(CUT)


def test_p61_the_resumable_run_keeps_roko_s_delivery_pending() -> None:
    assert client.resumable_view(CUT)["delivery_pending"] is True
    assert "delivery_pending" not in client.resumable_view({**CUT, "delivery_pending": False})


def test_p61_a_plan_run_over_it_is_refused_in_roko_s_words(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _cut(fake)
    refused = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0})
    assert refused["refusal"] == "resumable_run" and refused["error"] == ROKO_WORDS
    assert refused["resumable_run"]["delivery_pending"] is True
    # Starting over from the chat: what it sets aside, and that a resume only delivers.
    refused = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "fresh": True})
    assert refused["refusal"] == "start_over" and refused["error"] == (
        "Plan 'recov' has a run that can be resumed: 0a7e3e7b (interrupted) passed T1 and T2, and its delivery "
        "didn't finish. Starting over sets that run aside: T1 and T2 run again and are paid for again, its "
        "checkpoint is set aside (it can be brought back), and the $0.31 it spent stays spent. Pass resume=true to "
        "deliver it, so no task runs again, or fresh=true with set_aside=true to start over anyway."
    )
    assert refused["resumable_run"]["delivery_pending"] is True
    assert approvals.asked == [] and fake.tool_calls("plan_run") == []


def test_p61_a_resume_s_answer_and_the_card_say_only_the_delivery_is_left() -> None:
    shown, said = tools.resumed_words({**CUT, "continues": True, "left_usd": 0.69}, 1.0) or ({}, "")
    assert said == (
        "It continues run 0a7e3e7b: no task runs again, only its delivery, and the $0.31 it spent before it "
        "stopped counts against the $1.00 cap, so $0.69 is left."
    )
    assert shown["delivery_pending"] is True
    assert rundata.resume_note({"checkpoint": {**CUT, "continues": True}}) == (
        "A resume continues where it stopped: no task runs again, only its delivery, and the $0.31 it spent before "
        "it stopped counts against its cap."
    )

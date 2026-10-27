"""0.8.0 (round v7, the pilot's second P-51/P-53 pass): a resume and a start over are told with their figures (P-62).

On 9aa32c8 both windows passed, with two gaps in the replies. The interrupted run's resume read "Resumed recov with a
$1 cap; only T2 is left", though the answer's `next` said what the run had spent and what was left of the cap. The
start over read "Rerunning fails from scratch with a $1 cap", with no word of the run it set aside (6e62dcbd, F1
passed, $0.45). The answer now asks the chat to tell the person both, with their figures, and gives the words.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import learning_guard

SAY = "Tell the person in your reply, with its figures: "


def test_p62_a_resume_s_reply_says_what_the_run_spent_and_what_is_left(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    fake.add_plan("recov", "recov", [{"id": "T1"}, {"id": "T2"}])
    fake.plans["recov"]["checkpoint"] = {
        "run_id": "0a7e3e7b-6580-4657-96cb-edc99d0faaf8",
        "status": "interrupted",
        "passed_tasks": ["T1"],
        "tasks_left": ["T2"],
        "resumable": True,
        "continues": True,
        "spent_usd": 0.2,
    }
    fake.run_script = ["running"]
    started = call("roko_plan_run", {"plan_id": "recov", "max_usd": 1.0, "resume": True})
    assert started["next"].startswith(
        f"{SAY}It continues run 0a7e3e7b: only T2 runs, and the $0.20 it spent before it stopped counts against "
        "the $1.00 cap, so $0.80 is left. "
    )
    assert not learning_guard.teaches_repair(started["next"])


def test_p62_a_start_over_s_reply_says_which_run_it_set_aside_and_how_to_bring_it_back(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    fake.add_plan("fails", "fails", [{"id": "F1"}, {"id": "F2"}])
    fake.plans["fails"]["resumable_run"] = {
        "run_id": "6e62dcbd-b026-46c6-91b2-89532ce6abd3",
        "status": "failed",
        "passed_tasks": ["F1"],
        "tasks_left": ["F2"],
        "resumable": True,
        "spent_usd": 0.451,
    }
    fake.run_script = ["running"]
    started = call("roko_plan_run", {"plan_id": "fails", "max_usd": 1.0, "fresh": True, "set_aside": True})
    assert started["set_aside"]["run_id"] == "6e62dcbd-b026-46c6-91b2-89532ce6abd3"
    assert started["next"].startswith(
        f"{SAY}It started over and set aside run 6e62dcbd, which had passed F1 and spent $0.45; "
        "`roko resume 6e62dcbd` in a terminal brings it back. "
    )
    assert not learning_guard.teaches_repair(started["next"])

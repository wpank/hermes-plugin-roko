"""0.8.0 (round v7, roko bug-b7f6a8 via roko-recovery, 5e9af6682): a resume says what roko will do, in its fields.

roko-recovery's kill matrix: a crash with a task in flight left a checkpoint every way back failed on (the CLI) or
silently started over from (serve's resume, the REST route, the Run button), and passed tasks ran again, so P-51's
copy said a resume "may start the run over". roko now settles what the stopped process left and continues the run,
or, when its checkpoint no longer fits the plan, refuses the resume with `cannot_resume` and its reason; only
fresh=true starts over. It says what the run spent before it stopped (`spent_usd`; a resumed run's `carried_usd`),
which counts against the cap: max_usd caps the whole run.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko
from test_v06_runs import LADDER_TOML, MODELS, PROVIDERS
from test_v08_interrupted import PLAN, REASON, _dead_run

from hermes_plugin_roko import learning_guard, rundata, tools, views
from hermes_plugin_roko.client import resumable_view
from hermes_plugin_roko.runtime import Runtime

DEAD = "6059db44-0000-4000-8000-000000000001"
STUCK = {
    "run_id": DEAD,
    "status": "interrupted",
    "passed_tasks": ["T1", "T2"],
    "tasks_left": [],
    "resumable": False,
    "continues": False,
    "reason": "the converted plan graph has changed",
    "spent_usd": 0.205,
}
REFUSED = (
    f"Plan '{PLAN}' cannot resume run 6059db44 (interrupted): the converted plan graph has changed. Pass "
    "fresh=true to start over and set its progress aside: T1 and T2 run again, though they passed."
)


@pytest.fixture
def rt(fake: FakeRoko, tmp_path: Path) -> Iterator[Runtime]:
    """Undertow's workspace after the reboot, as test_v08_interrupted has it."""
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "roko.toml").write_text(LADDER_TOML)
    fake.models = [dict(row) for row in MODELS]
    fake.providers = [dict(row) for row in PROVIDERS]
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    try:
        yield runtime
    finally:
        runtime.close()


def test_the_reader_keeps_whether_a_resume_continues_and_what_the_run_spent() -> None:
    row = {
        **STUCK,
        "tasks_left": ["T3"],
        "continues": True,
        "reason": None,
        "spent_usd": 0.022,
        "left_usd": 0.978,
    }
    view = resumable_view(row)
    assert view is not None
    assert (view["continues"], view["spent_usd"], view["left_usd"]) == (
        True,
        0.022,
        0.978,
    ) and "reason" not in view
    stuck = resumable_view(STUCK)
    assert stuck is not None and (stuck["continues"], stuck["reason"]) == (
        False,
        "the converted plan graph has changed",
    )
    # An older roko's run: the fields it sends, and nothing it does not.
    old = resumable_view({"run_id": DEAD, "status": "failed", "passed_tasks": ["T1"], "tasks_left": ["T2"]})
    assert old == {"run_id": DEAD, "status": "failed", "passed_tasks": ["T1"], "tasks_left": ["T2"]}


def test_a_resume_roko_cannot_continue_is_refused_in_its_words_and_starting_over_is_the_persons_call(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    fake.add_plan(PLAN, "P4.1 · bone only for the one number", [{"id": "T1"}, {"id": "T2"}])
    fake.plans[PLAN]["checkpoint"] = dict(STUCK)
    refused = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "resume": True})
    assert (
        refused["success"] is False and refused["error"] == REFUSED and refused["refusal"] == "cannot_resume"
    )
    assert refused["cannot_resume"] == {
        "run_id": DEAD,
        "status": "interrupted",
        "reason": "the converted plan graph has changed",
        "passed_tasks": ["T1", "T2"],
        "spent_usd": 0.205,
    }
    hint = refused["hint"]
    assert (
        "only starting the plan over (fresh: true) runs it" in hint
        and "only if they ask for it in this turn" in hint
    )
    assert not learning_guard.teaches_repair(hint)
    assert not [run for run in fake.runs.values() if run.kind == "plan"]  # nothing ran


def test_a_resume_that_continues_says_what_the_run_spent_before_and_what_is_left_of_the_cap(
    fake: FakeRoko,
    call: Callable[..., dict[str, Any]],
    rt: Runtime,
    approvals: Approvals,
) -> None:
    fake.add_plan(PLAN, "P4.1 · bone only for the one number", [{"id": "T1"}, {"id": "T2"}])
    fake.plans[PLAN]["checkpoint"] = {
        **STUCK,
        "passed_tasks": ["T1"],
        "tasks_left": ["T2"],
        "resumable": True,
        "continues": True,
        "reason": None,
        "spent_usd": 0.022,
    }
    fake.run_script = ["running"]
    started = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "resume": True})
    assert started["resumes"] == {
        "run_id": DEAD,
        "passed_tasks": ["T1"],
        "tasks_left": ["T2"],
        "spent_usd": 0.022,
        "left_usd": 0.978,
    }
    assert (
        "It continues run 6059db44: only T2 runs, and the $0.02 it spent before it stopped counts against the "
        "$1.00 cap, so $0.98 is left." in started["next"]
    )


def test_an_interrupted_plans_resume_note_follows_roko_and_keeps_the_caveat_for_an_older_roko(
    rt: Runtime,
    fake: FakeRoko,
    approvals: Approvals,
) -> None:
    run_id = _dead_run(fake, rt)
    # roko since bug-b7f6a8 says what the run carried (0 for one that resumed nothing), and its plan's row names
    # the run a resume continues.
    fake.runs[run_id].summary_extra = {**fake.runs[run_id].summary_extra, "carried_usd": 0.0}
    fake.plans[PLAN]["resumable_run"] = {
        "run_id": run_id,
        "status": "interrupted",
        "passed_tasks": ["T1"],
        "tasks_left": ["T2"],
        "resumable": True,
        "continues": True,
        "spent_usd": 0.022071,
    }
    note = "A resume continues where it stopped: only T2 runs, and the $0.02 it spent before it stopped counts against its cap."
    step = views.card(rt, run_id)["next"]
    assert (step["label"], step["resume"], step["note"]) == ("resume the plan", True, note)
    assert (
        step["why"]
        == f"{REASON}; a resume continues where it stopped: only T2 runs, and the $0.02 it spent before it stopped counts against its cap"
    )
    said = call_status(rt, run_id)
    assert note in said and "may start the run over" not in said and not learning_guard.teaches_repair(said)
    # The plan's row names no run (nothing passed yet, or a checkpoint roko cannot continue): what roko does.
    fake.plans[PLAN]["resumable_run"] = None
    assert views.card(rt, run_id)["next"]["note"] == (
        "A resume continues where it stopped, or roko refuses it and says why: it never starts over unasked."
    )


def call_status(rt: Runtime, run_id: str) -> str:
    return str(tools.call(rt, "roko_status", {"run_id": run_id})["next"])


def test_a_resumed_runs_spend_counts_what_it_carried_and_its_timeline_says_so(
    rt: Runtime,
    fake: FakeRoko,
    approvals: Approvals,
) -> None:
    fake.add_plan(PLAN, "P4.1 · bone only for the one number", [{"id": "T1"}, {"id": "T2"}])
    fake.run_script = ["succeeded"]
    run_id = tools.call(rt, "roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0})["run_id"]
    run = fake.runs[run_id]
    detail = (
        "Resumed with $0.0221 spent before the restart (by 1 attempt a stopped process left); $0.9779 of its "
        "$1.0000 budget is left"
    )
    run.events = [
        {"type": "plan_started", "plan_id": PLAN, "tasks_total": 2, "ts_millis": 1},
        {
            "type": "budget_carried",
            "plan_id": PLAN,
            "carried_usd": 0.022071,
            "settled_usd": 0.022071,
            "ceiling_usd": 1.0,
            "detail": detail,
            "ts_millis": 2,
        },
    ]
    run.cost_usd = 0.040582
    run.summary_extra = {"carried_usd": 0.022071}
    card = views.card(rt, run_id)
    assert card["cost_usd"] == 0.040582 and card["carried_usd"] == 0.022071
    assert "$0.06 of $1.00 · $0.02 spent before the restart, $0.94 left" in card["headline"]
    line = rundata.timeline_entry(2, "budget_carried", {**run.events[1], "run_id": run_id})
    assert line is not None and (line["group"], line["text"]) == ("run", detail)

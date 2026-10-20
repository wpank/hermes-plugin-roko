"""0.8.0 (round v7, P-43): after a plan writing, its cap stays in view and stays the writing's.

Phase 3's plan writing (R1f) ran under the chat's $0.50 cap, and roko said so. Once it ended the cap showed nowhere:
the writing's line read "plan written · 2 tasks · $0.04", and the plan sheet named no cap. The chat then took the
writing's cap for the run's ("Your cap of $0.50 is enough if you want me to run it next"), though roko estimated the
run at $0.28 likely and $0.76 at worst. It also retyped the plan's check commands and dropped four of them (P3.04,
P3.06, P3.08 and P3.09), while the sheet had them all: the chat quotes counts now, and the counts are in its answers.
"""

from __future__ import annotations

from pathlib import Path

from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import plansheet, rundata, tools
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

SKILLS = Path(__file__).resolve().parents[1] / "hermes_plugin_roko" / "skills"
WRITTEN = {"state": "succeeded", "result": {"slug": "p3-sequencer", "task_count": 2, "cost_usd": 0.04}}


def test_an_ended_writing_keeps_its_cap_on_its_line() -> None:
    card = rundata.plan_generation_card("w-1", WRITTEN, {"label": "P3 · Sequencer", "max_usd": 0.5})
    assert card["headline"] == "succeeded · plan p3-sequencer · 2 tasks · $0.04 of $0.50"
    # Without a cap the run log knows (an older roko, or a writing from before 0.8.0), the spend alone.
    plain = rundata.plan_generation_card("w-2", WRITTEN, {"label": "P3 · Sequencer"})
    assert plain["headline"] == "succeeded · plan p3-sequencer · 2 tasks · $0.04"


def test_the_plan_sheet_says_what_writing_the_plan_cost_of_its_cap(
    fake: FakeRoko, approvals: Approvals
) -> None:
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        started = call(rt, "roko_plan_generate", {"prompt": "Build the step sequencer", "title": "P3"})
        asked = plansheet.plan_sheet(rt, started["plan_id"])["asked"]
        assert (asked["cost_usd"], asked["max_usd"]) == (None, None)  # nothing known yet
        rt.runs.update(started["run_id"], cost_usd=0.04, max_usd=0.5)
        asked = plansheet.plan_sheet(rt, started["plan_id"])["asked"]
        assert (asked["cost_usd"], asked["max_usd"]) == (0.04, 0.5)
    finally:
        rt.close()


def test_the_chat_hears_that_the_writing_cap_is_not_a_run_cap(fake: FakeRoko, approvals: Approvals) -> None:
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        started = call(rt, "roko_plan_generate", {"prompt": "Build the step sequencer"})
        assert tools.WRITING_CAP_ONLY in started["next"]
    finally:
        rt.close()
    card = {"kind": "plan_generate", "state": "succeeded", "cost_usd": 0.04, "max_usd": 0.5}
    step = tools._next_step({"state": "succeeded", "plan_id": "p3-sequencer"}, card)
    assert "Writing it cost $0.04 of its $0.50 cap" in step and tools.WRITING_CAP_ONLY in step
    assert "twice" in step and "likely" in step  # the run's cap comes from roko's estimate
    # Without a cost or a cap known, it still keeps the two caps apart.
    bare = tools._next_step({"state": "succeeded", "plan_id": "p"}, {"kind": "plan_generate"})
    assert tools.WRITING_CAP_ONLY in bare and "Writing it cost" not in bare


def test_the_chat_gets_counts_of_a_plans_checks_to_quote() -> None:
    steps = [{"phase": "post", "command": f"tools/spec.sh 3 sequencer 'P3.0{n}*'"} for n in range(1, 6)]
    row = tools._task_row({"id": "T1", "title": "the sequencer", "verify": steps})
    # The row lists the first four commands; its count says how many there are.
    assert len(row["checks"]) == 4 and row["check_count"] == 5
    assert "check_count" not in tools._task_row({"id": "T2", "title": "no checks"})
    # roko's own count of the spec's checks the plan keeps, beside the writing's state.
    counts = {"total": 9, "kept": 9, "shallow": 0, "cannot_run": 0, "dropped": 0, "missing": 0}
    card = {
        "kind": "plan_generate",
        "state": "succeeded",
        "source_checks": {**counts, "checks": [{"id": "x"}]},
    }
    assert tools.for_model(card, {})["source_checks"] == counts
    assert "source_checks" not in tools.for_model({"kind": "plan_generate", "state": "running"}, {})


def test_the_skill_quotes_counts_and_keeps_the_caps_apart() -> None:
    plan = (SKILLS / "roko-plan" / "SKILL.md").read_text()
    assert "Never retype the check commands" in plan and "check_count" in plan
    assert "covered writing the plan only" in plan

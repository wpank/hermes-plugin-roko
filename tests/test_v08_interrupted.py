"""0.8.0 (round v7, P-51): a run whose roko serve died mid-try (the reboot of 2026-10-26: phase 4.1's run 6059db44).

roko handled it: the restarted serve reports the run `interrupted` ("roko stopped while this run was going (machine
restart or crash)"), and a resume removed the stuck worktree lock, re-attached the try's checkout and delivered in
2.5 minutes. The plugin misled four ways:
- roko_status told the chat never to start it again, so the chat refused the person's own ask to resume it;
- the card offered "run the plan again", and the page said running it again starts from a clean checkout, where a
  resume picks up where it stopped;
- T1 still read running, lit on the ladder, on a run that had ended;
- the ladder was roko.toml's now: roko records no rungs for a run that settled no try.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko
from test_v06_runs import LADDER_TOML, MODELS, PROVIDERS

from hermes_plugin_roko import rundata, tools, views
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

PLAN = "p4-1-bone-only-for-the-one-number"
REASON = "roko stopped while this run was going (machine restart or crash)"
T1 = {"plan_id": PLAN, "task_id": "T1"}


@pytest.fixture
def rt(fake: FakeRoko, tmp_path: Path) -> Iterator[Runtime]:
    """Undertow's workspace as the reboot left it: roko.toml's ladder, and roko serve back up."""
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


def _dead_run(fake: FakeRoko, rt: Runtime, cap: float = 1.0) -> str:
    """Phase 4.1's run 6059db44 after the reboot: T1's first try on strong was checking when roko died, T2 never
    started; $0.022 spent of its $1 cap."""
    fake.add_plan(PLAN, "P4.1 · bone only for the one number", [{"id": "T1"}, {"id": "T2"}])
    fake.run_script = ["interrupted"]
    run_id = call(rt, "roko_plan_run", {"plan_id": PLAN, "max_usd": cap})["run_id"]
    run = fake.runs[run_id]
    run.events = [
        {"type": "plan_started", "plan_id": PLAN, "tasks_total": 2, "ts_millis": 1},
        {"type": "task_started", **T1, "title": "Bone only for the one number", "ts_millis": 2},
        {
            "type": "route_decided",
            **T1,
            "attempt": 1,
            "model": "gpt-5.4-mini",
            "rung": "strong",
            "source": "ladder",
            "stage": "static",
            "reason": "ladder",
            "ts_millis": 3,
        },
        {
            "type": "agent_spawned",
            **T1,
            "attempt": 1,
            "model": "gpt-5.4-mini",
            "provider": "openai",
            "ts_millis": 4,
        },
        {
            "type": "call_cost",
            **T1,
            "attempt": 1,
            "call": 1,
            "cost_usd": 0.022071,
            "attempt_cost_usd": 0.022071,
        },
        {"type": "check_started", **T1, "what": "tools/spec.sh 4.1 bone", "ts_millis": 6},
    ]
    run.cost_usd = 0.022071
    run.tasks = {"total": 2, "passed": 0, "failed": 0}
    run.summary_extra = {"interrupted": {"at": "2026-10-26T09:55:56.203Z", "reason": REASON}}
    return run_id


def test_the_chat_resumes_an_interrupted_plan_the_person_asks_for_and_never_unasked(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """P-51 point 1: "Please resume that run" was refused, roko_status having said "Do not start it again". A
    person's ask in this turn is enough: a resume at the cap they name, else the run's own, saying which and what
    the run already spent. Unasked, the chat only tells them, and that they can ask."""
    run_id = _dead_run(fake, rt)
    step = call(rt, "roko_status", {"run_id": run_id})["next"]
    assert "Do not start it again" not in step
    assert f"roko_plan_run(plan_id={PLAN}, resume=true" in step
    assert "the cap they named, else this run's $1.00" in step
    assert "this run already spent $0.02" in step
    assert "reuses each unfinished task's checkout and its edits" in step
    assert "If they did not ask" in step and "do not resume it on your own" in step


def test_an_interrupted_plans_next_step_is_its_resume_and_says_what_it_keeps(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """P-51 point 2: the card offered "run the plan again"; a resume is what works, and it keeps what passed."""
    card = views.card(rt, _dead_run(fake, rt))
    step = card["next"]
    assert (step["action"], step["label"], step["resume"]) == ("rerun", "resume the plan", True)
    assert (
        step["why"]
        == f"{REASON}; a resume keeps what passed and picks up where it stopped, on each unfinished task's own checkout"
    )


def test_an_ended_runs_task_that_was_still_running_reads_stopped_and_never_live(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """P-51 point 4: T1 still read running, its token lit on the ladder, on a run that had ended."""
    card = views.card(rt, _dead_run(fake, rt))
    [t1] = [task for task in card["tasks"] if task["task_id"] == "T1"]
    assert (t1["outcome"], t1["step"], t1["step_detail"], t1["live_text"]) == ("stopped", None, None, None)
    assert card["progress"]["running"] == 0 and card["progress"]["stopped"] >= 1
    # While it goes, it goes.
    tracker = rundata.RunTracker("r-live")
    tracker.fold.feed(1, "task_started", {"type": "task_started", **T1, "ts_millis": 1})
    tracker.fold.feed(2, "agent_spawned", {"type": "agent_spawned", **T1, "attempt": 1, "model": "m"})
    live = rundata._compose(tracker, "r-live", "running", {"state": "running"}, {"kind": "plan"})
    assert [task["outcome"] for task in live["tasks"]] == ["running"]


def test_an_ended_run_roko_recorded_no_rungs_for_draws_the_rungs_its_tries_ran_on(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """P-51, the lead's point 3: P-46's ladder as it ran comes from roko's summary `rungs[]`, which a run that
    settled no try has none of; its own tries' routes say where it ran."""
    card = views.card(rt, _dead_run(fake, rt))
    assert card["ladder_from"] == "run"
    assert [(rung["rung"], rung["model"], rung["spent_usd"]) for rung in card["ladder"]] == [
        ("strong", "gpt-5.4-mini", 0.022071)
    ]
    assert rundata.tried_ladder([], card["ladder"]) is None


def test_a_prompt_run_that_was_interrupted_is_started_again_only_when_asked() -> None:
    card = {"kind": "run", "state": "interrupted", "cost_usd": 0.01, "max_usd": 0.5}
    result = {"state": "interrupted", "run_id": "r1", "interrupted": {"reason": REASON}, "cost_usd": 0.01}
    step = tools._step(result, card)
    assert "roko_run" in step and "else this run's $0.50" in step and "this run already spent $0.01" in step
    assert "do not start it on your own" in step


@pytest.mark.parametrize(
    ("text", "lesson"),
    [
        # The person's own ask, in this turn: theirs to ask, and the step does it then (P-51).
        (
            "If the person asked in this turn to resume or run it again, call roko_plan_run(plan_id=p, resume=true).",
            False,
        ),
        (
            "If they asked in this turn to run it again, start it again with roko_run and the cap they named.",
            False,
        ),
        # Anything else is still a lesson to do it unasked.
        ("When a run is interrupted, call roko_plan_run with resume=true to run it again.", True),
        ("After a restart, start the roko run again with roko_run.", True),
        ("If the person asked earlier, run it again with roko_run.", True),
    ],
)
def test_the_guard_lets_a_resume_the_person_asks_for_in_this_turn_through_and_nothing_else(
    text: str, lesson: bool
) -> None:
    from hermes_plugin_roko import learning_guard

    assert learning_guard.teaches_repair(text) is lesson

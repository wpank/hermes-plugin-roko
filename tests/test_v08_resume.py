"""0.8.0 (round v7, hermes-pilot P-14): a plan whose last run stopped part way, continued or started over.

The pilot asked the chat to resume phase 0 (T1 and T2 passed, T3 failed); the model called roko_plan_run without
`resume`, roko started over, and T1 and T2 ran and were paid for again. roko now refuses a chat's plan run over
such a run until it says resume or fresh (bug-cbdb6b) and names the run on the plan's row (gap-b78706). The
plugin gives the same refusal, in roko's words, before Hermes asks the person to approve anything.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import resume, rundata, views
from hermes_plugin_roko.runtime import Runtime

PLAN = "p0-undertow-foundation"
STOPPED = "6988f0b8-4199-4abf-9cfc-67713bc60e34"
WORDS = (
    "Plan 'p0-undertow-foundation' has a run that can be resumed: 6988f0b8 (failed) passed T1 and T2, and T3 is "
    "left. Pass resume=true to continue it, so only T3 runs, or fresh=true to start over and set its progress "
    "aside."
)


def _stopped(fake: FakeRoko) -> None:
    fake.add_plan(PLAN, "P0 · Undertow foundation", [{"id": f"T{n}"} for n in (1, 2, 3)])
    fake.plans[PLAN]["resumable_run"] = {
        "run_id": STOPPED,
        "status": "failed",
        "passed_tasks": ["T1", "T2"],
        "tasks_left": ["T3"],
        "resumable": True,
    }


def test_a_plan_run_over_a_run_that_stopped_part_way_is_refused_before_anything_is_approved(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _stopped(fake)
    refused = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.5})
    assert refused["success"] is False and refused["error"] == WORDS and refused["refusal"] == "resumable_run"
    assert refused["resumable_run"] == {
        "run_id": STOPPED,
        "status": "failed",
        "passed_tasks": ["T1", "T2"],
        "tasks_left": ["T3"],
    }
    assert "resume: true" in refused["hint"] and "fresh: true" in refused["hint"]
    assert approvals.asked == [] and fake.tool_calls("plan_run") == []  # nothing approved, nothing spent


def test_resume_continues_the_run_and_fresh_starts_over_saying_what_it_set_aside(
    fake: FakeRoko, rt: Runtime, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _stopped(fake)
    fake.run_script = ["running"]
    resumed = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.5, "resume": True})
    assert fake.tool_calls("plan_run")[-1] == {"plan_id": PLAN, "resume": True, "max_usd": 1.5}
    assert (rt.runs.get(resumed["run_id"]) or {})["resumes"] == STOPPED
    assert approvals.asked[-1]["message"].startswith("Resume roko plan p0-undertow-foundation")
    _stopped(fake)
    fresh = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.5, "fresh": True})
    assert fake.tool_calls("plan_run")[-1] == {
        "plan_id": PLAN,
        "resume": False,
        "max_usd": 1.5,
        "fresh": True,
    }
    assert approvals.asked[-1]["message"].startswith("Start over roko plan p0-undertow-foundation")
    aside = (rt.runs.get(fresh["run_id"]) or {})["set_aside"]
    assert aside == {
        "run_id": STOPPED,
        "status": "failed",
        "passed_tasks": ["T1", "T2"],
        "tasks_left": ["T3"],
    }
    assert views.card(rt, fresh["run_id"])["set_aside"] == aside


def test_fresh_with_resume_or_a_short_from_run_is_refused_as_roko_would(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _stopped(fake)
    both = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "resume": True, "fresh": True})
    assert both["code"] == "invalid" and "cannot be combined" in both["error"]
    short = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "from_run": "6988"})
    assert short["code"] == "invalid" and "first 8 characters" in short["error"]
    assert approvals.asked == [] and fake.tool_calls("plan_run") == []


def test_an_older_roko_is_read_from_the_plans_last_run_in_the_run_log(
    fake: FakeRoko, rt: Runtime, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    """An older roko names no run and starts over: the plugin reads the plan's last run Hermes started."""
    fake.resumes = False
    _stopped(fake)
    rt.runs.add(STOPPED, "plan", "P0 · Undertow foundation", plan_id=PLAN, state="failed")
    rt.runs.update(STOPPED, progress={"total": 3, "passed": 2, "failed": 1})
    refused = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0})
    assert refused["error"] == (
        "Plan 'p0-undertow-foundation' has a run that can be resumed: 6988f0b8 (failed) passed 2 tasks, and 1 "
        "task is left. Pass resume=true to continue it, so only 1 task runs, or fresh=true to start over and set "
        "its progress aside."
    )
    assert approvals.asked == [] and fake.tool_calls("plan_run") == []
    fake.run_script = ["running"]
    started = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "resume": True})
    assert started["run_id"] and (rt.runs.get(started["run_id"]) or {})["resumes"] == STOPPED


def test_the_page_offers_continue_or_start_over(fake: FakeRoko, rt: Runtime) -> None:
    from test_v07_projects import web

    _stopped(fake)
    fake.run_script = ["running"]
    with web(rt) as client:
        sheet = client.get(f"/api/plugins/roko/plans/{PLAN}").json()["plan"]
        assert sheet["resumable_run"]["run_id"] == STOPPED and sheet["resumable_run"]["tasks_left"] == ["T3"]
        refused = client.post(f"/api/plugins/roko/plans/{PLAN}/run", json={"max_usd": 1.0}).json()
        assert refused["ok"] is False and refused["error"]["message"] == WORDS
        assert refused["resumable_run"]["passed_tasks"] == ["T1", "T2"]
        started = client.post(
            f"/api/plugins/roko/plans/{PLAN}/run", json={"max_usd": 1.0, "fresh": True}
        ).json()
        assert started["ok"] is True
        card = client.get(f"/api/plugins/roko/runs/{started['run_id']}").json()["run"]
        assert card["set_aside"]["run_id"] == STOPPED
        assert client.get(f"/api/plugins/roko/plans/{PLAN}").json()["plan"]["resumable_run"] is None


def test_a_run_that_started_over_says_how_to_bring_back_what_it_set_aside() -> None:
    message = (
        "started over: set aside run 6988f0b8 as ~/dev/undertow/.roko/state/graph/p0/checkpoint.json.bak.17; "
        "`roko resume 6988f0b8` puts it back"
    )
    line = rundata.timeline_entry(
        42,
        "event_log_entry",
        {"type": "event_log_entry", "event_type": "checkpoint.set_aside", "message": message},
    )
    assert (
        line is not None and line["text"] == message and line["set_aside"] is True and line["group"] == "run"
    )


@pytest.mark.parametrize(
    ("tasks", "said"),
    [
        (["T3"], "T3"),
        (["T1", "T2"], "T1 and T2"),
        (["T1", "T2", "T3"], "T1, T2 and T3"),
        ([f"T{n}" for n in range(1, 8)], "T1, T2, T3, T4, T5 and 2 more"),
    ],
)
def test_a_refusal_names_tasks_as_roko_does(tasks: list[str], said: str) -> None:
    assert resume.names(tasks) == said

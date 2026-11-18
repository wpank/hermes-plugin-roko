"""A run's readings follow the one definition every surface uses (design system §4.8, roko gap-c1726f).

TIME runs from when roko accepted the run (`last_run.started_at` on `GET /api/plans/{id}`) and is roko's own
`run_completed.duration_ms` once the run ended. CHECKS is x of y, with y fixed from the start: every task's verify
steps, the workspace's rungs once they report, and the plan's own checks (`plan_checks` on
`GET /api/plans/{id}/tasks`), each counted once, on its task's last try.

Round v8, phase 7.2: Hermes read TIME 14m 04s where the portal read 15:04 (it counted from the run's directory, about a
minute after roko accepted the run), and CHECKS 10 of 10 where the portal read 11 of 11 (it left out the plan's check).
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import views
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

PLAN = "p7-2-the-window"
TASKS = [
    {
        "id": "T1",
        "title": "Knobs and switches",
        "verify": [
            {"phase": "compile", "command": "cmake --build build"},
            {"phase": "test", "command": "ctest"},
        ],
    },
    {"id": "T2", "title": "Step cells", "verify": [{"phase": "test", "command": "ctest -R steps"}]},
]
CHECK = {
    "plan_id": PLAN,
    "stage": "regression",
    "step": 1,
    "steps": 1,
    "name": "check.sh",
    "scope": "command",
}


def plan_run(rt: Runtime, fake: FakeRoko, *, plan_checks: bool = True) -> str:
    fake.add_plan(PLAN, "P7.2 · The window as designed", [dict(task) for task in TASKS])
    if plan_checks:
        fake.plans[PLAN]["plan_checks"] = [{"phase": "regression", "command": "./check.sh --plugin"}]
    return str(call(rt, "roko_plan_run", {"plan_id": PLAN, "max_usd": 0.5})["run_id"])


def task(task_id: str) -> dict[str, Any]:
    return {"plan_id": PLAN, "task_id": task_id}


def checked(task_id: str, gate: str, passed: bool, at: int) -> list[dict[str, Any]]:
    return [
        {**task(task_id), "type": "agent_spawned", "attempt": 1, "model": "glm-4.7", "ts_millis": at},
        {**task(task_id), "type": "gate_result", "gate": gate, "passed": passed, "ts_millis": at + 1},
    ]


def ended(outcome: str = "passed") -> list[dict[str, Any]]:
    """Both tasks through their checks, then the plan's check."""
    return [
        {**task("T1"), "type": "task_started", "ts_millis": 1_000},
        *checked("T1", "verify[0:compile]", True, 1_100),
        {**task("T1"), "type": "gate_result", "gate": "verify[1:test]", "passed": True, "ts_millis": 1_200},
        {**task("T1"), "type": "task_completed", "outcome": "passed", "ts_millis": 1_300},
        {**task("T2"), "type": "task_started", "ts_millis": 1_400},
        *checked("T2", "verify[0:test]", True, 1_500),
        {**task("T2"), "type": "task_completed", "outcome": "passed", "ts_millis": 1_600},
        {**CHECK, "type": "plan_check_started", "ts_millis": 1_700},
        {
            **CHECK,
            "type": "plan_check_finished",
            "passed": outcome == "passed",
            "exit_code": 0,
            "ts_millis": 1_800,
        },
    ]


def test_checks_count_every_check_from_the_start(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    run_id = plan_run(rt, fake)
    run = fake.runs[run_id]
    run.states = ["running"]
    run.events = [
        {**task("T1"), "type": "task_started", "ts_millis": 1_000},
        *checked("T1", "verify[0:compile]", True, 1_100),
    ]
    # One check has run, of the four the run will run: T1's two steps, T2's one and the plan's own.
    assert views.card(rt, run_id)["gates"] == {"passed": 1, "failed": 0, "total": 4, "retried": 0}

    rt.cards._trackers.clear()
    run.states = ["succeeded"]
    run.events = [*ended(), {"type": "run_completed", "outcome": "succeeded", "duration_ms": 1_333_900}]
    card = views.card(rt, run_id)
    assert card["gates"] == {"passed": 4, "failed": 0, "total": 4, "retried": 0}
    assert card["headline"].startswith("succeeded · checks 4/4")


def test_a_plan_check_that_did_not_pass_counts_against_the_run(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = plan_run(rt, fake)
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [*ended("failed"), {"type": "run_completed", "outcome": "failed", "duration_ms": 90_000}]
    assert views.card(rt, run_id)["gates"] == {"passed": 3, "failed": 1, "total": 4, "retried": 0}


def test_a_resumes_kept_task_passed_its_checks_before_and_a_rung_counts_once_it_reports(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = plan_run(rt, fake)
    run = fake.runs[run_id]
    run.states = ["succeeded"]
    run.events = [
        # A resume says the tasks an earlier process passed, without their checks: T1's two passed then.
        {**task("T1"), "type": "task_completed", "outcome": "passed", "ts_millis": 1_000},
        {**task("T2"), "type": "task_started", "ts_millis": 1_400},
        *checked("T2", "verify[0:test]", True, 1_500),
        # The workspace's rung ran after T2's own step: one more check, counted once it reported.
        {**task("T2"), "type": "gate_result", "gate": "clippy", "passed": True, "ts_millis": 1_550},
        {**task("T2"), "type": "task_completed", "outcome": "passed", "ts_millis": 1_600},
        {**CHECK, "type": "plan_check_finished", "passed": True, "exit_code": 0, "ts_millis": 1_800},
        {"type": "run_completed", "outcome": "succeeded", "duration_ms": 60_000},
    ]
    assert views.card(rt, run_id)["gates"] == {"passed": 5, "failed": 0, "total": 5, "retried": 0}


def test_an_older_roko_without_the_plans_checks_counts_the_one_that_ran(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = plan_run(rt, fake, plan_checks=False)
    run = fake.runs[run_id]
    run.states = ["running"]
    run.events = [{**task("T1"), "type": "task_started", "ts_millis": 1_000}]
    assert views.card(rt, run_id)["gates"]["total"] == 3  # the tasks' steps; the plan's check isn't named yet
    rt.cards._trackers.clear()
    run.states = ["succeeded"]
    run.events = [*ended(), {"type": "run_completed", "outcome": "succeeded", "duration_ms": 60_000}]
    assert views.card(rt, run_id)["gates"] == {"passed": 4, "failed": 0, "total": 4, "retried": 0}


def test_time_runs_from_when_roko_accepted_the_run(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    run_id = plan_run(rt, fake)
    run = fake.runs[run_id]
    run.states = ["running"]
    run.events = [{**task("T1"), "type": "task_started", "ts_millis": 1_000}]
    # roko accepted the run a minute before its run's folder (the manifest's first invocation) began.
    folder = datetime.fromisoformat(
        run.bundle()["manifest"]["invocations"][0]["started_at"].replace("Z", "+00:00")
    )
    accepted = (folder - timedelta(seconds=61)).astimezone(UTC)
    fake.plans[PLAN]["last_run"] = {
        "run_id": run_id,
        "status": "running",
        "started_at": accepted.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
    }
    card = views.card(rt, run_id)
    assert datetime.fromisoformat(str(card["started_at"]).replace("Z", "+00:00")) == accepted
    assert card["elapsed_ms"] >= 61_000

    # Once it ended, TIME is roko's own count: run_completed.duration_ms.
    rt.cards._trackers.clear()
    run.states = ["succeeded"]
    run.events = [*ended(), {"type": "run_completed", "outcome": "succeeded", "duration_ms": 1_333_900}]
    assert views.card(rt, run_id)["duration_ms"] == 1_333_900


def test_time_ignores_a_last_run_that_is_another_runs(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = plan_run(rt, fake)
    run = fake.runs[run_id]
    run.states = ["running"]
    run.events = [{**task("T1"), "type": "task_started", "ts_millis": 1_000}]
    folder = run.bundle()["manifest"]["invocations"][0]["started_at"]
    fake.plans[PLAN]["last_run"] = {
        "run_id": "another-run",
        "status": "failed",
        "started_at": "2026-11-12T20:00:00.000Z",
    }
    card = views.card(rt, run_id)
    assert datetime.fromisoformat(str(card["started_at"]).replace("Z", "+00:00")) == datetime.fromisoformat(
        folder.replace("Z", "+00:00")
    )

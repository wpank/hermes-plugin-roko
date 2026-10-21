"""0.8.0 (round v7, #4): where a run's time and money go while it runs.

roko main 22de26a8c states each try's time by phase (`phases` on attempt_settled, `timing.phases` on the verdict
record), f2ee9a0d3 sends each model call's cost as it happens (`call_cost`), and 97d9b1819 reports the spec gate's
steps as they end (`spec_gate_step`). The card carries them, so the pages can draw where the time went, a spend
that moves during a try, and the spec gate's progress before any agent runs.
"""

from __future__ import annotations

from typing import Any

from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import rundata, views
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

PHASES = {
    "queue_ms": 81,
    "workspace_ms": 290,
    "prompt_ms": 28,
    "ttft_ms": 302,
    "model_ms": 6081,
    "model_calls": 3,
    "tools_ms": 64,
    "tool_calls": 2,
    "tools_by_name": [
        {"tool": "write_file", "calls": 1, "ms": 36},
        {"tool": "read_file", "calls": 1, "ms": 28},
    ],
    "checks_ms": 2150,
    "checks": [{"name": "verify[0:build]", "ms": 2024, "passed": True}],
    "other_ms": 4,
}


def _feed(tracker: Any, rows: list[tuple[str, dict[str, Any]]]) -> None:
    for cursor, (kind, event) in enumerate(rows, start=1):
        tracker.fold.feed(
            cursor * 100, kind, {"type": kind, "run_id": "r1", "ts_millis": 1_000 + cursor, **event}
        )


def _started(tracker: Any, task: str = "T2") -> None:
    _feed(
        tracker,
        [
            ("plan_started", {"plan_id": "p", "tasks_total": 1}),
            ("task_started", {"plan_id": "p", "task_id": task, "title": "Sine sub oscillator"}),
            ("agent_spawned", {"plan_id": "p", "task_id": task, "attempt": 1, "model": "glm-4.7"}),
        ],
    )


def _try(tracker: Any, task: str = "T2") -> dict[str, Any]:
    [row] = [rundata._task_card(view) for view in tracker.task_rows() if view.task_id == task]
    return row["climb"][-1]


def test_a_try_carries_rokos_own_split_of_its_time() -> None:
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    _feed(
        tracker,
        [
            (
                "attempt_settled",
                {
                    "plan_id": "p",
                    "task_id": "T2",
                    "attempt": 1,
                    "verdict": "passed",
                    "blame": "none",
                    "cost_usd": 0.0044,
                    "duration_ms": 8327,
                    "model": "glm-4.7",
                    "phases": PHASES,
                },
            ),
        ],
    )
    timing = _try(tracker)["timing"]
    assert timing["basis"] == "roko"
    assert (timing["model_ms"], timing["tools_ms"], timing["checks_ms"], timing["other_ms"]) == (
        6081,
        64,
        2150,
        4,
    )
    assert (timing["queue_ms"], timing["workspace_ms"], timing["prompt_ms"], timing["ttft_ms"]) == (
        81,
        290,
        28,
        302,
    )
    assert (timing["model_calls"], timing["tool_calls"], timing["split"]) == (3, 2, True)
    assert timing["tools"] == [
        {"tool": "write_file", "calls": 1, "ms": 36},
        {"tool": "read_file", "calls": 1, "ms": 28},
    ]
    assert timing["checks"] == [{"name": "verify[0:build]", "ms": 2024, "passed": True}]


def test_a_verdict_records_timing_is_read_too_and_unknown_stays_null() -> None:
    settled = rundata.settled_view(
        {
            "attempt": 1,
            "outcome": "passed",
            "timing": {
                "attempt_started_at": 1_000,
                "settled_at": 9_327,
                "phases": {**PHASES, "ttft_ms": None, "tools_by_name": "not a list"},
            },
        }
    )
    assert settled["duration_ms"] == 8_327
    assert settled["phases"]["ttft_ms"] is None  # roko says null when it does not know: never 0
    assert settled["phases"]["tools"] == []
    assert rundata.settled_view({"attempt": 1, "outcome": "passed"})["phases"] is None


def test_an_older_rokos_tool_time_counted_as_model_time_is_marked_not_split() -> None:
    """bug-15ba19 (roko f407b62e9): a tool result that ended in the same millisecond as the next model turn had its
    time counted as model time, so T3 read run_tests "2 calls, 0 ms" beside model_ms 13,072. A run written by such
    a roko keeps that split: the page must not say the model took 13 s."""
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    old = {**PHASES, "model_ms": 13_072, "tools_ms": 0, "tool_calls": 2, "tools_by_name": []}
    _feed(
        tracker,
        [
            (
                "attempt_settled",
                {"plan_id": "p", "task_id": "T2", "attempt": 1, "verdict": "passed", "phases": old},
            )
        ],
    )
    timing = _try(tracker)["timing"]
    assert (timing["basis"], timing["split"], timing["model_ms"], timing["tools_ms"]) == (
        "roko",
        False,
        13_072,
        0,
    )


def test_a_try_without_rokos_split_is_its_checks_and_the_agents_time_from_events() -> None:
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    steps = [{"rung": "custom:test", "passed": True, "exit_code": 0, "duration_ms": 2_500}]
    settled = {"plan_id": "p", "task_id": "T2", "attempt": 1, "verdict": "passed", "duration_ms": 10_000}
    _feed(tracker, [("attempt_settled", {**settled, "steps": steps})])
    timing = _try(tracker)["timing"]
    assert timing == {"basis": "events", "agent_ms": 7_500, "checks_ms": 2_500, "split": False}


def test_a_running_trys_spend_moves_with_each_model_call_and_settles_once() -> None:
    """call_cost (roko f2ee9a0d3): the try's spend so far, call by call; the try's settled cost replaces it, so
    nothing is counted twice."""
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    call = {"plan_id": "p", "task_id": "T2", "attempt": 1, "model": "glm-4.7", "cost_usd": 0.0015}
    _feed(tracker, [("call_cost", {**call, "call": 1, "attempt_cost_usd": 0.0015})])
    assert tracker.fold.live_cost_usd == 0.0015
    _feed(tracker, [("call_cost", {**call, "call": 2, "attempt_cost_usd": 0.0030})])
    assert tracker.fold.live_cost_usd == 0.0030
    assert _try(tracker)["cost_usd"] == 0.003
    _feed(
        tracker,
        [
            ("efficiency_event", {"plan_id": "p", "task_id": "T2", "metric": "cost_usd", "value": 0.0044}),
            (
                "attempt_settled",
                {"plan_id": "p", "task_id": "T2", "attempt": 1, "verdict": "passed", "cost_usd": 0.0044},
            ),
        ],
    )
    assert tracker.fold.live_cost_usd == 0.0
    assert round(tracker.fold.cost_usd, 6) == 0.0044
    assert _try(tracker)["cost_usd"] == 0.0044


def test_the_spec_gate_is_counted_step_by_step_and_said_when_it_ends() -> None:
    tracker = rundata.RunTracker("r1")
    step = {"plan_id": "p", "task_id": "T1", "step": 1, "passed": False}
    _feed(
        tracker,
        [
            ("spec_gate_started", {"plan_ids": ["p"], "steps_total": 4, "tasks_total": 2}),
            ("spec_gate_step", {**step, "run": 1, "ms": 31_000, "cached": False}),
            ("spec_gate_step", {**step, "run": 2, "ms": 420, "cached": True}),
        ],
    )
    gate = tracker.fold.spec_gate_view()
    assert gate == {
        "state": "running",
        "steps_total": 4,
        "steps_done": 2,
        "cached": 1,
        "passed": 0,
        "ms": 31_420,
        "elapsed_ms": None,
        "blocked": None,
        "started_at": rundata._iso_ms(1_001),
    }
    _feed(
        tracker,
        [
            ("spec_gate_step", {**step, "task_id": "T2", "run": 1, "ms": 900, "cached": False}),
            ("spec_gate_step", {**step, "task_id": "T2", "run": 2, "ms": 800, "cached": False}),
            (
                "spec_gate_finished",
                {"elapsed_ms": 33_400, "steps_run": 3, "cached": 1, "blocked": 0, "tasks_checked": 2},
            ),
        ],
    )
    done = tracker.fold.spec_gate_view()
    assert (done["state"], done["steps_done"], done["elapsed_ms"], done["blocked"]) == ("done", 4, 33_400, 0)
    assert rundata.RunTracker("r2").fold.spec_gate_view() is None


def test_a_running_runs_spend_is_one_figure_on_its_card_its_row_and_the_status_chip(
    fake: FakeRoko, approvals: Approvals
) -> None:
    """Phase 2's S2 stills: the run's header said $0.732 (with the running try's call_cost) while its row in the
    run list and the status chip said $0.61, the tries roko had settled. The row (and the chip, which reads it)
    now counts the running try's spend as the card does."""
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        fake.run_script = ["running"] * 20
        run_id = call(rt, "roko_run", {"prompt": "wire the voice modulation", "max_usd": 3.0})["run_id"]
        settled = {"plan_id": "p", "task_id": "T1", "attempt": 1}
        running = {"plan_id": "p", "task_id": "T2", "attempt": 1, "model": "glm-4.7"}
        fake.runs[run_id].events = [
            {"type": "plan_started", "plan_id": "p", "tasks_total": 2},
            {"type": "task_started", "plan_id": "p", "task_id": "T1", "title": "LFO module"},
            {"type": "agent_spawned", **settled, "model": "glm-4.7"},
            {
                "type": "efficiency_event",
                "plan_id": "p",
                "task_id": "T1",
                "metric": "cost_usd",
                "value": 0.61,
            },
            {"type": "attempt_settled", **settled, "verdict": "passed", "cost_usd": 0.61},
            {"type": "task_completed", "plan_id": "p", "task_id": "T1", "outcome": "passed"},
            {"type": "task_started", "plan_id": "p", "task_id": "T2", "title": "Wire voice modulation"},
            {"type": "agent_spawned", **running},
            {"type": "call_cost", **running, "call": 7, "cost_usd": 0.02, "attempt_cost_usd": 0.122},
        ]
        fake.runs[run_id].events = [{**row, "run_id": run_id} for row in fake.runs[run_id].events]
        card = views.card(rt, run_id)
        [row] = [row for row in views.ui_overview(rt)["runs"] if row["run_id"] == run_id]
        assert card["cost_usd"] == row["cost_usd"] == 0.732
        assert rt.runs.get(run_id)["cost_usd"] == 0.732
    finally:
        rt.close()


def test_rokos_estimate_keeps_when_roko_made_it() -> None:
    """P-38: roko sends critical_path_eta_updated only when a task completes, so phase 2's page read "~12 min left"
    from 21:15 still at 21:33. The card keeps when the estimate was made (`eta_at`), and the page counts down from it."""
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    _feed(tracker, [("critical_path_eta_updated", {"eta_minutes": 12.0})])
    assert (tracker.fold.eta_minutes, tracker.fold.eta_ms) == (12.0, 1_001)
    _feed(tracker, [("critical_path_eta_updated", {"eta_minutes": None})])
    assert (tracker.fold.eta_minutes, tracker.fold.eta_ms) == (None, None)


# roko bcce6c05c (gap-c1045f): the median, its 90th percentile, when roko computed it, and what it rests on.
RANGE = {
    "eta_minutes": 28,
    "eta_p90_minutes": 75,
    "computed_at_ms": 1_792_539_699_986,
    "basis": {"source": "history", "tasks": 9, "runs": 12},
}


def test_rokos_estimate_keeps_its_range_its_time_and_what_it_rests_on() -> None:
    """The page reads "~28 min left, up to 75 · est. 21:15 · from 12 runs": on long, heavy-tailed tasks the median
    alone runs low (phase 2: about 28 min, up to 75, with 74 left)."""
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    _feed(tracker, [("critical_path_eta_updated", RANGE)])
    fold = tracker.fold
    assert (fold.eta_minutes, fold.eta_p90_minutes, fold.eta_ms) == (28.0, 75.0, 1_792_539_699_986)
    assert fold.eta_basis == {"source": "history", "tasks": 9, "runs": 12}
    # What roko should not send is left out, never shown: a range below its median, a source it has no word for.
    odd = {"eta_minutes": 5, "eta_p90_minutes": 3, "basis": {"source": "vibes", "runs": 4}}
    _feed(tracker, [("critical_path_eta_updated", odd)])
    assert (fold.eta_minutes, fold.eta_p90_minutes, fold.eta_basis) == (5.0, None, None)
    assert fold.eta_ms == 1_001  # an older roko's estimate: its event's time, as before
    guess = {"eta_minutes": 30, "eta_p90_minutes": 30, "basis": {"source": "guess", "tasks": 0, "runs": 0}}
    _feed(tracker, [("critical_path_eta_updated", guess)])
    assert fold.eta_basis == {"source": "guess", "tasks": 0, "runs": 0}
    # The run's end clears all of it.
    _feed(tracker, [("critical_path_eta_updated", {"eta_minutes": None})])
    assert (fold.eta_minutes, fold.eta_p90_minutes, fold.eta_basis, fold.eta_ms) == (None, None, None, None)


def test_a_running_runs_card_carries_rokos_range(fake: FakeRoko, approvals: Approvals) -> None:
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        fake.run_script = ["running"] * 20
        run_id = call(rt, "roko_run", {"prompt": "write the step sequencer", "max_usd": 3.0})["run_id"]
        fake.runs[run_id].events = [
            {"type": "plan_started", "plan_id": "p", "tasks_total": 2, "run_id": run_id},
            {"type": "critical_path_eta_updated", "plan_id": "p", "run_id": run_id, **RANGE},
        ]
        card = views.card(rt, run_id)
        assert (card["eta_minutes"], card["eta_p90_minutes"]) == (28.0, 75.0)
        assert card["eta_basis"] == {"source": "history", "tasks": 9, "runs": 12}
        assert card["eta_at"] == rundata._iso_ms(1_792_539_699_986)
    finally:
        rt.close()

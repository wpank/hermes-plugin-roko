"""0.8.0 (round v7, #4): where a run's time and money go while it runs.

roko main 22de26a8c states each try's time by phase (`phases` on attempt_settled, `timing.phases` on the verdict
record), f2ee9a0d3 sends each model call's cost as it happens (`call_cost`), and 97d9b1819 reports the spec gate's
steps as they end (`spec_gate_step`). The card carries them, so the pages can draw where the time went, a spend
that moves during a try, and the spec gate's progress before any agent runs.
"""

from __future__ import annotations

from typing import Any

from hermes_plugin_roko import rundata

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

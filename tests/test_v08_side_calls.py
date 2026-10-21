"""0.8.0 (round v7): a run's side calls in its spend (roko de778b612, bug-11e54b, roko-speed).

roko's run summary now counts a Graph run's side calls in its `cost_usd`, as their cost rows bill them: calls a
provider refused before a failover, helper calls and audit checks, by role in `side_call_usd`. Each reaches the event
stream as an `efficiency_event` whose metric is `side_call_usd.<role>`. Run 20c780ae reads $0.7185 in roko's summary
and the Build tab's ledger, where the card, which sums its tries' costs, read $0.6915.

A refused call is one of its try's own calls: while the try runs its cost is inside that try's live `call_cost`
(`attempt_cost_usd`), and once the try settles roko's figure for the try leaves it out. So it counts once: in the
live figure, then as a side call. roko names the try on the event only from the field roko-speed adds; until then a
refused call is left out rather than guessed at.
"""

from __future__ import annotations

from typing import Any

from hermes_plugin_roko import rundata

T1 = {"plan_id": "p", "task_id": "T1"}


def _feed(tracker: Any, rows: list[tuple[str, dict[str, Any]]]) -> None:
    for cursor, (kind, event) in enumerate(rows, start=tracker.fold.rows + 1):
        tracker.fold.feed(
            cursor * 100, kind, {"type": kind, "run_id": "r1", "ts_millis": 1_000 + cursor, **event}
        )


def _spend(tracker: Any, *, ended: bool) -> float | None:
    return rundata.spent_so_far(tracker.fold, tracker.fold.stated_usd, ended=ended)


def _started(tracker: Any, attempt: int = 1) -> None:
    _feed(
        tracker,
        [
            ("plan_started", {"plan_id": "p", "tasks_total": 1}),
            ("task_started", {**T1, "title": "Sequencer"}),
            ("agent_spawned", {**T1, "attempt": attempt, "model": "glm-4.7"}),
        ],
    )


def _side(role: str, value: float, **more: Any) -> tuple[str, dict[str, Any]]:
    return ("efficiency_event", {**T1, "metric": f"side_call_usd.{role}", "value": value, **more})


def test_a_refused_call_counts_once_while_its_try_runs_and_after_it_settles() -> None:
    """roko-speed's case: $0.0068 refused, then $0.01 on the model that served: $0.0168, never $0.0236."""
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    _feed(
        tracker,
        [
            ("call_cost", {**T1, "attempt": 1, "call": 1, "cost_usd": 0.0068, "attempt_cost_usd": 0.0068}),
            _side("failover_refused", 0.0068, attempt=1),
            ("call_cost", {**T1, "attempt": 1, "call": 2, "cost_usd": 0.01, "attempt_cost_usd": 0.0168}),
        ],
    )
    assert _spend(tracker, ended=False) == 0.0168
    # roko's figure for the try leaves the refused call out: it is a side call from now on.
    _feed(tracker, [("efficiency_event", {**T1, "metric": "cost_usd", "value": 0.01})])
    assert _spend(tracker, ended=False) == 0.0168
    _feed(tracker, [("attempt_settled", {**T1, "attempt": 1, "verdict": "passed", "cost_usd": 0.01})])
    assert _spend(tracker, ended=True) == 0.0168
    assert tracker.fold.side_usd == {"failover_refused": 0.0068}


def test_a_refused_call_of_a_try_that_settled_already_is_a_side_call() -> None:
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    _feed(
        tracker,
        [
            ("efficiency_event", {**T1, "metric": "cost_usd", "value": 0.01}),
            ("attempt_settled", {**T1, "attempt": 1, "verdict": "failed", "cost_usd": 0.01}),
            _side("failover_refused", 0.0068, attempt=1),
        ],
    )
    assert _spend(tracker, ended=True) == 0.0168


def test_helper_and_audit_calls_count_at_once() -> None:
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    _feed(
        tracker,
        [
            ("call_cost", {**T1, "attempt": 1, "call": 1, "cost_usd": 0.02, "attempt_cost_usd": 0.02}),
            _side("helper", 0.125),
            _side("audit", 0.004),
        ],
    )
    assert _spend(tracker, ended=False) == 0.149
    assert tracker.fold.side_usd == {"helper": 0.125, "audit": 0.004}


def test_a_refused_call_roko_names_no_try_for_is_left_out() -> None:
    """de778b612's event names the plan and task, not the try: inside a live figure or not, it cannot tell."""
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    _feed(
        tracker,
        [
            ("call_cost", {**T1, "attempt": 1, "call": 2, "cost_usd": 0.01, "attempt_cost_usd": 0.0168}),
            _side("failover_refused", 0.0068),
        ],
    )
    assert _spend(tracker, ended=False) == 0.0168
    assert tracker.fold.side_usd == {}


def _run_20c780ae() -> Any:
    """20c780ae's shape: its tries $0.6915, three calls refused before a failover ($0.027), a helper call at $0."""
    tracker = rundata.RunTracker("r1")
    _feed(
        tracker,
        [
            ("plan_started", {"plan_id": "p", "tasks_total": 1}),
            ("task_started", {**T1, "title": "Sequencer"}),
        ],
    )
    tries = [0.2105, 0.25, 0.231]
    for attempt, (cost, refused) in enumerate(zip(tries, (0.009, 0.009, 0.009), strict=True), start=1):
        _feed(
            tracker,
            [
                ("agent_spawned", {**T1, "attempt": attempt, "model": "glm-4.7"}),
                (
                    "call_cost",
                    {**T1, "attempt": attempt, "call": 1, "cost_usd": refused, "attempt_cost_usd": refused},
                ),
                _side("failover_refused", refused, attempt=attempt),
                ("efficiency_event", {**T1, "metric": "cost_usd", "value": cost}),
                ("attempt_settled", {**T1, "attempt": attempt, "verdict": "failed", "cost_usd": cost}),
            ],
        )
    _feed(tracker, [_side("helper", 0.0)])
    return tracker


def test_20c780aes_card_reads_rokos_summary_and_p17s_check_stays_quiet() -> None:
    tracker = _run_20c780ae()
    spend = _spend(tracker, ended=True)
    assert spend == 0.7185
    summary = {"cost_usd": 0.7185, "side_call_usd": {"failover_refused": 0.027, "helper": 0.0}}
    assert rundata.totals_agree({"cost_usd": spend}, summary)


def test_an_older_roko_without_side_calls_reads_as_before() -> None:
    tracker = rundata.RunTracker("r1")
    _started(tracker)
    _feed(
        tracker,
        [
            ("call_cost", {**T1, "attempt": 1, "call": 1, "cost_usd": 0.02, "attempt_cost_usd": 0.02}),
            ("efficiency_event", {**T1, "metric": "cost_usd", "value": 0.03}),
            ("attempt_settled", {**T1, "attempt": 1, "verdict": "passed", "cost_usd": 0.03}),
        ],
    )
    assert _spend(tracker, ended=True) == 0.03 and tracker.fold.side_usd == {}
    assert rundata.totals_agree({"cost_usd": 0.03}, {"cost_usd": 0.03})
    # roko-speed's case and a run with helper calls agree with roko's summary too.
    assert rundata.totals_agree({"cost_usd": 0.0168}, {"cost_usd": 0.0168})
    assert rundata.RunTracker("r2").fold.stated_usd is None

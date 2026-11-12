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


def test_an_ended_runs_spend_is_its_tries_and_side_calls_from_rokos_summary_too() -> None:
    """guide-v7: phase 3's ended run 7b8cb121 read $0.70 on its page and its receipt ("1.8× less"), where roko's
    summary and ledger said $0.9085 (1.4×): its binary predates 9334ba4a9, so the $0.2076 glm-4.7 spent on T2 before
    z.ai's 429s came as refused calls with no try's number, and the fold left them out. An ended run's spend is its
    stated tries plus its side calls by role, the events' or roko's summary's, whichever says more (PW-5: roko's
    summary itself can count a try's row twice, so its `cost_usd` is the cross-check, not the figure)."""
    from test_v06_runs import LADDER, ended_card

    tracker = rundata.RunTracker("r1")
    _started(tracker)
    _feed(
        tracker,
        [
            ("efficiency_event", {**T1, "metric": "cost_usd", "value": 0.7009}),
            ("attempt_settled", {**T1, "attempt": 1, "verdict": "passed", "cost_usd": 0.7009}),
            _side("failover_refused", 0.2076),  # no try's number: left out of the events' sum
        ],
    )
    side = {"failover_refused": 0.2076, "helper": 0.0}
    summary = {"state": "succeeded", "cost_usd": 0.9085, "side_call_usd": side}
    assert tracker.fold.stated_usd == 0.7009
    assert rundata.run_spend(tracker.fold, summary, ended=True) == 0.9085
    card = rundata._compose(tracker, "r1", "succeeded", summary, {"kind": "plan"})
    assert card["cost_usd"] == 0.9085 and card["side_call_usd"] == side  # roko's own, once it ended
    # Where the events' sum and roko disagree, the card says so in its details, never on the receipt.
    assert card["cost_check"] == {"events_usd": 0.7009, "roko_usd": 0.9085}
    tokens = {"input": 1_000_000, "output": 120_000, "cache_read": 0, "cache_write": 0}  # ≈ $1.29 at the top
    priced = rundata.receipt(ended_card(tokens=tokens, ladder=LADDER[:3], cost_usd=card["cost_usd"]))
    assert (priced["cost_usd"], priced["ratio"]) == (0.9085, 1.4)
    # Without a figure from roko, the events' sum.
    assert rundata.run_spend(tracker.fold, {"state": "succeeded"}, ended=True) == 0.7009


def test_a_run_whose_refused_calls_name_their_try_agrees_both_ways_and_a_live_run_reads_its_events() -> None:
    tracker = _run_20c780ae()
    summary = {"state": "failed", "cost_usd": 0.7185}
    assert rundata.run_spend(tracker.fold, summary, ended=True) == tracker.fold.stated_usd == 0.7185
    assert rundata._compose(tracker, "r1", "failed", summary, {"kind": "plan"})["cost_check"] is None
    live = rundata.RunTracker("r2")
    _started(live)
    _feed(live, [("call_cost", {**T1, "attempt": 1, "call": 1, "cost_usd": 0.02, "attempt_cost_usd": 0.05})])
    # roko's summary of a running run lags its calls: the card reads the events while it runs.
    assert rundata.run_spend(live.fold, {"state": "running", "cost_usd": 0.0}, ended=False) == 0.05


def test_p17s_check_adopts_rokos_spend_for_a_run_it_checked_before() -> None:
    """7b8cb121 is checked already (P-17, before this rule) and kept $0.70: it is checked once more, and keeps
    roko's $0.9085, so its row, the chip and the header agree with its page."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import views
    from hermes_plugin_roko.runtime import Runtime

    fake = FakeRoko().start()
    fake.runs["r-7b"] = Run("r-7b", "plan", ["succeeded"], plan_id="p3")
    fake.runs["r-7b"].cost_usd, fake.runs["r-7b"].tasks = 0.9085, {"total": 2, "passed": 2, "failed": 0}
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        rt.runs.add("r-7b", "plan", "P3 · Undertow sequencer", plan_id="p3")
        rt.runs.update(
            "r-7b",
            state="succeeded",
            progress={"total": 2, "passed": 2},
            cost_usd=0.7,
            cost_final=True,
            checked=True,
        )
        views.ui_overview(rt)
        row = rt.runs.get("r-7b") or {}
        assert (row["cost_usd"], row["spend_checked"], row["cost_final"]) == (0.9085, True, True)
    finally:
        rt.close()
        fake.stop()


def test_the_top_rung_side_takes_helper_and_audit_calls_never_refused_ones() -> None:
    """A call refused before a failover is the cheap route's own waste: on the top rung's side of the receipt, only
    the helper and audit calls roko names run at their cost."""
    from test_v06_runs import CLIMB_LADDER_PRICED, ended_card, priced_try

    tokens = {"input": 1_000_000, "output": 100_000, "cache_read": 0}
    tasks = [{"task_id": "T1", "outcome": "passed", "climb": [priced_try("passed", 0.01, tokens)]}]
    side = {"failover_refused": 0.2, "helper": 0.002, "audit": 0.001}
    card = ended_card(ladder=CLIMB_LADDER_PRICED, cost_usd=0.213, tasks=tasks, side_call_usd=side)
    priced = rundata.receipt(card)
    assert priced["top_rung_usd"] == 1.203  # 1.20 at the top rung's prices, plus $0.003 of helper and audit
    assert priced["basis"].endswith("plus <$0.01 helper calls")  # to the cent, as the pages say money
    # An older roko names none: no helper calls (PW-5: never the run's cost less its tries').
    assert rundata.receipt({**card, "side_call_usd": {}})["top_rung_usd"] == 1.2

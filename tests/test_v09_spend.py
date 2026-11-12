"""Plugin 0.9 (round v8): a run's spend, counted once.

PW-5 (hermes-pilot-v8, with run-analyst-v8's reading of roko's records): rehearsal run b2372e07 passed two tasks for
$0.0054 by roko's verdicts, its books and its plan ledger (5442 µ$), but its card read $0.009 and its top-rung line
"plus $0.0032 helper calls". roko had published task 1's `cost_usd` row twice (bug-6fddf2), and the card added
both; its summary did too, and the receipt took the run's cost less its tries as helper calls. A try's spend is
now set, never added, its verdict's own once it says one; helper calls are only the helper and audit side calls.
"""

from __future__ import annotations

from typing import Any

import pytest

from hermes_plugin_roko import rundata
from hermes_plugin_roko.rundata import EventFold

T1_USD = 0.0031639
T2_USD = 0.0022777


def _spawn(fold: EventFold, cursor: int, task: str) -> None:
    fold.feed(
        cursor, "agent_spawned", {"plan_id": "p", "task_id": task, "attempt": 1, "model": "gpt-5.6-luna"}
    )


def _cost(fold: EventFold, cursor: int, task: str, value: float) -> None:
    # As roko sends it: after the try's checks, with no attempt.
    fold.feed(
        cursor, "efficiency_event", {"plan_id": "p", "task_id": task, "metric": "cost_usd", "value": value}
    )


def _b2372e07(*, doubled: bool = True) -> EventFold:
    fold = EventFold()
    _spawn(fold, 1, "T1")
    _cost(fold, 2, "T1", T1_USD)
    if doubled:
        _cost(fold, 3, "T1", T1_USD)  # rows 285 and 286 of its run index: the same row twice
    _spawn(fold, 4, "T2")
    _cost(fold, 5, "T2", T2_USD)
    return fold


def test_a_tries_cost_row_sent_twice_counts_once() -> None:
    fold = _b2372e07()
    assert fold.stated_usd == pytest.approx(T1_USD + T2_USD, abs=1e-6)  # roko's figures, to the µ$
    assert fold.tasks[("p", "T1")].cost_usd == pytest.approx(T1_USD)
    assert fold.tasks[("p", "T1")].attempt_log[-1]["cost_usd"] == pytest.approx(T1_USD)
    # Once it ended, the card reads the tries (and side calls), not roko's summary that added the doubled row.
    summary: dict[str, Any] = {"cost_usd": 0.0086055, "state": "succeeded"}
    assert rundata.run_spend(fold, summary, ended=True) == pytest.approx(0.005442)


def test_a_settled_tries_own_cost_wins_over_the_cost_row() -> None:
    fold = EventFold()
    _spawn(fold, 1, "T1")
    fold.feed(
        2,
        "attempt_settled",
        {"plan_id": "p", "task_id": "T1", "attempt": 1, "verdict": "passed", "cost_usd": T1_USD},
    )
    _cost(fold, 3, "T1", 0.009)  # a later row with another figure: the verdict's stands
    assert fold.stated_usd == pytest.approx(T1_USD, abs=1e-6)


def test_two_tries_of_one_task_each_count() -> None:
    fold = EventFold()
    _spawn(fold, 1, "T1")
    _cost(fold, 2, "T1", 0.002)
    fold.feed(3, "agent_spawned", {"plan_id": "p", "task_id": "T1", "attempt": 2, "model": "glm-4.7"})
    _cost(fold, 4, "T1", 0.003)
    assert fold.tasks[("p", "T1")].cost_usd == pytest.approx(0.005)
    assert [row["cost_usd"] for row in fold.tasks[("p", "T1")].attempt_log] == [
        pytest.approx(0.002),
        pytest.approx(0.003),
    ]


def _passing(task: str, usd: float) -> dict[str, Any]:
    tokens = {"input": 1000, "output": 200, "cache_read": 0}
    return {
        "task_id": task,
        "outcome": "passed",
        "climb": [{"attempt": 1, "outcome": "passed", "cost_usd": usd, "tokens": tokens}],
    }


TOP = {"rung": "top", "slug": "claude-sonnet-4-6", "price_in": 3.0, "price_out": 15.0, "chat_ok": True}


def test_with_no_side_calls_the_top_rung_line_has_no_helper_calls() -> None:
    tasks = [_passing("T1", T1_USD), _passing("T2", T2_USD)]
    # The card's cost said $0.0086 (the doubled row): never read as $0.0032 of helper calls.
    _rung, usd, basis, detail, by, _left = rundata._top_rung_line(TOP, tasks, 0.0086055, None, None)
    assert by == "passing_tries" and "helper" not in (basis or "") and "helper" not in (detail or "")
    assert usd == pytest.approx((2000 * 3 + 400 * 15) / 1_000_000)


def test_helper_calls_are_the_helper_and_audit_side_calls_and_read_to_the_cent() -> None:
    tasks = [_passing("T1", T1_USD)]
    side = {"helper": 0.0021, "audit": 0.0012, "failover_refused": 0.5, "episode-distiller": 0.4}
    _rung, usd, basis, _detail, _by, _left = rundata._top_rung_line(TOP, tasks, 1.0, None, side)
    assert basis is not None and basis.endswith(", plus <$0.01 helper calls")
    assert usd == pytest.approx((1000 * 3 + 200 * 15) / 1_000_000 + 0.0033)


@pytest.mark.parametrize(
    ("value", "said"),
    [(None, "—"), (0, "$0.00"), (0.0032, "<$0.01"), (0.009, "<$0.01"), (0.01, "$0.01"), (2.789, "$2.79")],
)
def test_money_in_the_pages_words_is_to_the_cent(value: float | None, said: str) -> None:
    assert rundata.cents(value) == said

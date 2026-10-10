from __future__ import annotations

from typing import Any

import pytest
from conftest import FakeState

from hermes_plugin_roko.decisions import (
    Confirmation,
    Effect,
    confirmation_id,
    effect_decision_id,
    parse_decision_id,
)
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.runlog import MAX_RUNS, STATE_KEY, RunLog


@pytest.mark.parametrize("attempt_key", ["RUN:p:T1:1", "p:t:2", "a/b c:d", "ünïcode:1"])
def test_confirmation_ids_round_trip(attempt_key: str) -> None:
    decision_id = confirmation_id("run-1", "T1", attempt_key)
    assert decision_id.startswith("c_") and ":" not in decision_id and " " not in decision_id
    assert parse_decision_id(f"  {decision_id} ") == Confirmation("run-1", "T1", attempt_key)


def test_effect_ids() -> None:
    assert parse_decision_id(effect_decision_id("effect-20261003T101500-1a2b")) == Effect(
        "effect-20261003T101500-1a2b"
    )


@pytest.mark.parametrize("bad", ["", "e_", "c_", "c_!!!", "c_" + "e30", "x_1", "run-1"])
def test_bad_ids(bad: str) -> None:
    with pytest.raises(RokoError) as error:
        parse_decision_id(bad)
    assert error.value.code is Code.INVALID


def test_runlog_keeps_newest_first_and_caps() -> None:
    state = FakeState()
    log = RunLog(state)
    for index in range(MAX_RUNS + 5):
        log.add(f"r{index}", "run", f"task {index}")
    runs = state.get(STATE_KEY)
    assert len(runs) == MAX_RUNS and runs[0]["run_id"] == f"r{MAX_RUNS + 4}"
    log.update("r54", state="succeeded", cost_usd=0.4, ignored=None)
    assert log.get("r54")["state"] == "succeeded" and "ignored" not in log.get("r54")
    log.add("r54", "run", "again")  # re-adding moves it to the front instead of duplicating
    assert [r["run_id"] for r in log.recent(2)] == ["r54", "r53"]


def test_runlog_falls_back_to_memory() -> None:
    class Broken:
        def get(self, key: str, default: Any = None) -> Any:
            raise OSError("disk full")

        def set(self, key: str, value: Any) -> None:
            raise OSError("disk full")

    log = RunLog(Broken())
    log.add("r1", "run", "x")
    assert log.get("r1") is not None


def test_runlog_store_is_resolved_lazily() -> None:
    calls: list[int] = []

    def factory() -> FakeState:
        calls.append(1)
        return FakeState()

    log = RunLog(factory)
    assert calls == []
    log.add("r1", "run", "x")
    log.recent()
    assert calls == [1]

from __future__ import annotations

import time
from pathlib import Path
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
    last, before = f"r{MAX_RUNS + 4}", f"r{MAX_RUNS + 3}"
    log.update(before, state="succeeded", cost_usd=0.4, ignored=None)
    assert log.get(before)["state"] == "succeeded" and "ignored" not in log.get(before)
    log.add(before, "run", "again")  # re-adding moves it to the front instead of duplicating
    assert [r["run_id"] for r in log.recent(2)] == [before, last]


def test_runlog_skips_writes_that_change_nothing() -> None:
    writes: list[str] = []

    class Counting(FakeState):
        def set(self, key: str, value: Any) -> None:
            writes.append(key)
            super().set(key, value)

    log = RunLog(Counting())
    log.add("r1", "run", "line one\nline two\x1b[31m")
    assert log.get("r1")["label"] == "line one line two"  # one clean line
    log.update("r1", state="running")
    log.update("r1", state="running", cost_usd=None)
    assert len(writes) == 2


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


def test_two_processes_never_drop_each_others_runs(tmp_path: Path) -> None:
    """A chat adding runs while a UI backend records states: every run survives."""
    import threading

    class SharedState(FakeState):
        """One state file seen by two processes: each get/set is atomic, the pair is not."""

        data_dir = tmp_path

        def get(self, key: str, default: Any = None) -> Any:
            value = super().get(key, default)
            time.sleep(0.003)  # widen the window between a read and the write that follows
            return value

    store = SharedState()
    chat, ui = RunLog(store), RunLog(store)  # two RunLogs: two processes' worth of thread locks
    for index in range(5):
        chat.add(f"seed{index}", "run", "x")

    def add_runs() -> None:
        for index in range(30):
            chat.add(f"new{index}", "run", "x")

    def record_states() -> None:
        for index in range(30):
            ui.update(f"seed{index % 5}", state=f"s{index}")

    threads = [threading.Thread(target=add_runs), threading.Thread(target=record_states)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    ids = {run["run_id"] for run in store.get(STATE_KEY)}
    assert {f"new{index}" for index in range(30)} <= ids and {f"seed{index}" for index in range(5)} <= ids
    assert (tmp_path / "runs.lock").exists()

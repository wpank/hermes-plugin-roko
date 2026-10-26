"""0.8.0 (round v7, roko bug-b7d9ad via roko-speed): a run that changed the person's own checkout says so.

In round v7's rehearsal p41, T2's checks, run in the attempt's own worktree, wrote the review PNGs into the base
checkout through a path compiled into a warm build tree: the worktree held nothing and the delivery had no PNGs. In a
live run that base is the person's own checkout. roko now names it: its run summary's `checkout_written`
({plan_id, task_id, attempt, paths} for each try whose checks changed the checkout), a warning diagnosis that says how
to drop or keep the changes, and an attempt that changed nothing settles unverified. The card lists them, and
roko_status tells the chat the paths and the task whose checks ran: keeping or dropping them is the person's call,
and the chat never runs git on their checkout unasked (the lead).
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import learning_guard, rundata, views
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

PLAN = "p41-rehearsal"
PATHS = ["artifacts/ui/editor-idle.png", "artifacts/ui/editor-playing.png"]
WRITTEN = {"plan_id": PLAN, "task_id": "T2", "attempt": 1, "paths": PATHS}


@pytest.fixture
def rt(fake: FakeRoko, tmp_path: Path) -> Iterator[Runtime]:
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        yield runtime
    finally:
        runtime.close()


def _run(fake: FakeRoko, rt: Runtime, state: str, summary: dict[str, Any] | None = None) -> str:
    fake.add_plan(PLAN, "P41 · rehearsal", [{"id": "T1"}, {"id": "T2"}])
    fake.run_script = [state]
    run_id = call(rt, "roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0})["run_id"]
    fake.runs[run_id].summary_extra = summary or {}
    return run_id


def test_the_reader_keeps_rokos_rows_and_untrusted_paths_stay_text() -> None:
    assert rundata.checkout_written({"checkout_written": [WRITTEN]}) == [{**WRITTEN, "more": 0}]
    many = {**WRITTEN, "paths": [f"out/{n}.png" for n in range(25)] + ["bad\npath"]}
    [row] = rundata.checkout_written({"checkout_written": [many]})
    assert len(row["paths"]) == rundata.WRITTEN_PATHS and row["more"] == 26 - rundata.WRITTEN_PATHS
    odd = {"task_id": "T3\nx", "attempt": "2", "paths": ["a\nb"]}
    [row] = rundata.checkout_written({"checkout_written": [odd]})
    assert (row["task_id"], row["attempt"], row["plan_id"], row["paths"]) == ("T3 x", None, None, ["a b"])
    # No task or no path is no row; an older roko says nothing.
    assert (
        rundata.checkout_written({"checkout_written": [{"task_id": "T1", "paths": []}, {"paths": PATHS}]})
        == []
    )
    assert rundata.checkout_written({}) == [] and rundata.checkout_written(None) == []


def test_a_runs_card_lists_the_tries_that_changed_the_persons_checkout(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    card = views.card(rt, _run(fake, rt, "running", {"checkout_written": [WRITTEN]}))
    assert card["checkout_written"] == [{**WRITTEN, "more": 0}]
    assert views.card(rt, _run(fake, rt, "succeeded"))["checkout_written"] == []


def test_roko_status_tells_the_chat_the_paths_and_the_task_and_that_the_person_decides(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = _run(fake, rt, "succeeded", {"checkout_written": [WRITTEN]})
    status = call(rt, "roko_status", {"run_id": run_id})
    assert status["checkout_written"] == [
        "while T2's checks ran (try 1): artifacts/ui/editor-idle.png, artifacts/ui/editor-playing.png"
    ]
    note = status["checkout_note"]
    assert "changed the person's own checkout" in note and "did not deliver them" in note
    assert "naming the paths and the task" in note
    assert "theirs to decide" in note and "unless they ask you to in this turn" in note
    assert not learning_guard.teaches_repair(note)
    # A run that changed nothing there says nothing of it.
    quiet = call(rt, "roko_status", {"run_id": _run(fake, rt, "succeeded")})
    assert "checkout_written" not in quiet and "checkout_note" not in quiet

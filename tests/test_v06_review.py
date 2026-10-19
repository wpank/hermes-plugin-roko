"""0.6: what the review of the round v6 working tree found before commit, each as the test that showed it.

- A plan.md heading with a long run of spaces took the plan sheet's heading pattern cubic time: one look at such a
  plan pinned a worker thread of Hermes' web server for minutes.
- roko's `forced_accept` (a judge accepted a try whose checks failed: "Never a pass", roko-graph) counted as a pass:
  in the Receipt, on the ladder, and in the learning numbers.
- "Turn on roko's learning" promised that lessons are never left out of a prompt they match. Pinning
  `domain_context` stops only the section bandit: the control arm the same step keeps on holds lessons back from
  some tries, and roko's top-3 cap and token budget still leave lessons out.
- A plan.md or rubric.md that is a link to a file outside the workspace was read, and shown on the plan sheet.
- `GET /estimate?chars=²` answered "internal": `isdigit()` takes "²", which `int()` refuses.
- A run resumed under its own id (roko's checkpoint resume) read as its first invocation's end.
- roko's `cannot_run` source checks (gap-ecafde) were dropped from a plan writing's report, count and rows.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from conftest import FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import onboard, plansheet, rundata, views
from hermes_plugin_roko.runtime import Runtime

ROOT = Path(__file__).resolve().parent.parent

# -- the plan sheet: a heading with a long run of spaces ------------------------------------------------


def test_a_heading_with_a_long_run_of_spaces_reads_at_once(tmp_path: Path) -> None:
    folder = tmp_path / "plans" / "p"
    folder.mkdir(parents=True)
    (folder / "plan.md").write_text(
        "# A title" + " " * 2_000 + "x\n\nIts first paragraph.\n\n## Next ##\n\nMore.\n\n### C#\n\nSharp.\n"
    )
    started = time.perf_counter()
    doc = plansheet.plan_doc(folder, "plans/p/tasks.toml")
    assert time.perf_counter() - started < 1.0
    assert doc is not None
    # A closing run of #s goes, as markdown reads it; a # that ends a word stays.
    assert [section["heading"] for section in doc["sections"]][1:] == ["Next", "C#"]


# -- roko's forced accept is never a pass ---------------------------------------------------------------


def test_a_forced_accept_is_never_a_pass(tmp_path: Path) -> None:
    folder = tmp_path / ".roko" / "runs" / "r1"
    folder.mkdir(parents=True)
    record = {
        "plan_id": "p",
        "task_id": "T1",
        "attempt": 1,
        "outcome": "forced_accept",
        "ladder": {"rung": "cheap", "step": 0},
        "cost": {"billed_usd": 0.01},
    }
    (folder / "attempts.jsonl").write_text(json.dumps(record) + "\n")
    learned = rundata.record_learning(tmp_path, "r1", None)
    assert learned is not None
    assert (learned["learning"]["passed"], learned["learning"]["first_try"]) == (0, 0)
    task = rundata.TaskView("p", "T1")
    rundata._settle(task, record, None)
    [one] = rundata.climb(task, None, ended=True)
    assert one["outcome"] == "failed" and one["why"] and "accepted" in one["why"]


# -- what turning learning on promises --------------------------------------------------------------------


def test_learning_on_does_not_promise_every_matching_lesson_in_every_prompt() -> None:
    texts = {
        "LEARNING_WORDS on": onboard.LEARNING_WORDS["on"],
        "LEARNING_NOTE": " ".join(onboard.LEARNING_NOTE),
        **{doc: (ROOT / doc).read_text(encoding="utf-8") for doc in DOCS},
    }
    assert [name for name, text in texts.items() if "never left out" in text] == []
    # What pinning does say, with the control arm that still holds lessons back from some tries.
    assert "control arm" in " ".join(onboard.LEARNING_NOTE)


DOCS = ("README.md", "docs/getting-started.md", "docs/reference.md", "docs/using-roko.md")


# -- the plan sheet: a link that leaves the workspace --------------------------------------------------


def test_a_plan_doc_that_links_outside_the_workspace_is_not_read(tmp_path: Path, fake: FakeRoko) -> None:
    workspace = tmp_path / "ws"
    folder = workspace / "plans" / "p"
    folder.mkdir(parents=True)
    secret = tmp_path / "secret.md"
    secret.write_text("# Keys\n\nOPENAI_API_KEY=sk-test-not-a-key\n")
    (folder / "plan.md").symlink_to(secret)
    (folder / "rubric.md").symlink_to(secret)
    toml = '[meta]\ntitle = "P"\n\n[[task]]\nid = "T1"\ntitle = "t"\n'
    (folder / "tasks.toml").write_text(toml)
    fake.add_plan("p", "P", [{"id": "T1", "title": "t"}])
    fake.plan_sources["p"] = toml
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    try:
        sheet = plansheet.plan_sheet(runtime, "p")
        assert (sheet["doc"], sheet["rubric"]) == (None, None)
        # A link that stays in the workspace is read.
        (workspace / "docs").mkdir()
        (workspace / "docs" / "plan.md").write_text("# P\n\nThe plan, kept with the docs.\n")
        (folder / "plan.md").unlink()
        (folder / "plan.md").symlink_to(workspace / "docs" / "plan.md")
        sheet = plansheet.plan_sheet(runtime, "p")
    finally:
        runtime.close()
    assert sheet["doc"] is not None and "kept with the docs" in sheet["doc"]["markdown"]
    assert sheet["rubric"] is None


# -- GET /estimate's `chars` (the lead's decision 5) ---------------------------------------------------------


def test_estimate_chars_takes_only_a_plain_count() -> None:
    import pytest

    from hermes_plugin_roko import ui_api
    from hermes_plugin_roko.errors import Code, RokoError

    runtime = Runtime(FakeContext({}))
    try:
        # "²" is a digit to str.isdigit() but no number to int(): it must be a refused parameter, not a crash.
        for bad in ("²", "-1", "1e3", "0x10", "1234567"):
            with pytest.raises(RokoError) as refused:
                ui_api.estimate_request(runtime, {"chars": bad})
            assert refused.value.code is Code.INVALID, bad
    finally:
        runtime.close()


# -- a run resumed under its own id reads as running, not as its first invocation's end ----------------------


def test_a_run_resumed_under_its_own_id_reads_as_running(
    call: Any, approvals: Any, fake: FakeRoko, rt: Runtime
) -> None:
    # roko's checkpoint resume keeps the run id ("same run, one more invocation"): the run's events hold the first
    # invocation's end, then the new one's rows, while roko's summary says it runs. P-1 read the old end as the
    # run's, so the whole resumed invocation read as ended.
    fake.run_script = ["running"]
    run_id = call("roko_run", {"prompt": "implement synth/env.py", "max_usd": 0.2})["run_id"]
    task = {"plan_id": "p", "task_id": "T1"}
    fake.runs[run_id].events = [
        {"type": "plan_started", "plan_id": "p", "tasks_total": 1, "ts_millis": 1},
        {"type": "task_started", **task, "title": "env", "ts_millis": 2},
        {"type": "agent_spawned", **task, "attempt": 1, "model": "m", "ts_millis": 3},
        {"type": "task_completed", **task, "outcome": "failed", "ts_millis": 4},
        {
            "type": "run_completed",
            "run_id": run_id,
            "outcome": "interrupted",
            "duration_ms": 4,
            "ts_millis": 5,
        },
        # The resume, under the same id.
        {"type": "plan_set_loaded", "plans": [{"plan_id": "p", "tasks_total": 1}], "ts_millis": 10},
        {"type": "plan_started", "plan_id": "p", "tasks_total": 1, "ts_millis": 11},
        {"type": "task_started", **task, "title": "env", "ts_millis": 12},
        {"type": "agent_spawned", **task, "attempt": 2, "model": "m", "ts_millis": 13},
    ]
    card = views.card(rt, run_id)
    assert (card["state"], card["summary_behind"]) == ("running", False), card["headline"]


# -- roko's `cannot_run` source checks (gap-ecafde) stay in the report ----------------------------------------


def test_a_source_check_that_cannot_run_stays_in_the_report() -> None:
    # Since gap-ecafde (roko 08d4fe558) a check whose only real step cannot pass as written (pytest not installed,
    # a test that does not exist) is `cannot_run`, not kept. The report dropped the count and the check, so
    # "1 of 3 kept" said nothing of a check the plan cannot prove.
    report = {
        "total": 3,
        "kept": 1,
        "shallow": 0,
        "cannot_run": 1,
        "dropped": 0,
        "missing": 1,
        "regenerated": True,
        "checks": [
            {
                "id": "SC1",
                "check": "osc.render() returns floats",
                "status": "kept",
                "task": "T1",
                "criterion": "AC1",
            },
            {
                "id": "SC2",
                "check": "the lowpass passes lows",
                "status": "cannot_run",
                "task": "T2",
                "reason": "`pytest` is not installed",
            },
            {"id": "SC3", "check": "write_wav writes a RIFF header", "status": "missing"},
        ],
    }
    view = rundata.source_checks_view(report)
    assert view is not None
    assert (view["kept"], view.get("cannot_run"), view["missing"]) == (1, 1, 1)
    [stuck] = [row for row in view["checks"] if row["id"] == "SC2"]
    assert (stuck["status"], stuck["task"], stuck["reason"]) == (
        "cannot_run",
        "T2",
        "`pytest` is not installed",
    )

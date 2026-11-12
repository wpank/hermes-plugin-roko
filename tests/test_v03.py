"""0.3.0: live run cards, the diff, merging from a UI, starting runs from a UI, and titles.

Card tests fold the event indexes of real runs from the Hermes dogfood (roko serve 6ab6fde47,
2026-10-13; paths scrubbed): a five-task plan in four waves, the same plan cancelled half way, the
plan failing on a check whose command was missing, a prompt run, and a sign-off run.
"""

from __future__ import annotations

import json
import subprocess
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import review, rundata, ui_api, views
from hermes_plugin_roko.decisions import pending_confirmations
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.rundata import CardCache, RunTracker
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "dogfood_runs.json").read_text())


def tracker_for(name: str) -> tuple[RunTracker, dict[str, Any]]:
    fx = FIXTURES[name]
    tracker = RunTracker(fx["run_id"])
    for row in fx["events"]:
        tracker.fold.feed(row["cursor"], row["type"], row["event"])
    if fx.get("plan_tasks"):
        plan = fx["plan_tasks"]
        tracker.plan_tasks[plan["plan_id"]] = [
            {"id": t["id"], "title": t.get("title", ""), "depends_on": t.get("depends_on") or []}
            for t in plan["tasks"]
        ]
    return tracker, fx


def cards_of(tracker: RunTracker) -> list[dict[str, Any]]:
    return [rundata._task_card(task) for task in tracker.task_rows()]


def why_of(name: str) -> str:
    tracker, fx = tracker_for(name)
    cache = CardCache()
    cache._trackers[("u", fx["run_id"])] = tracker
    return str(
        rundata.explain(cache, "u", {"run_id": fx["run_id"], "state": fx["summary"]["state"]})["summary"]
    )


# -- the live card -----------------------------------------------------------------


def test_a_multi_wave_plan_folds_into_waves_timing_and_attempts() -> None:
    tracker, _ = tracker_for("multiwave_plan_run")
    tasks = cards_of(tracker)
    assert [t["task_id"] for t in tasks] == ["T1", "T2", "T3", "T4", "T5"]
    assert rundata.progress(tasks) == {
        "total": 5,
        "passed": 5,
        "failed": 0,
        "running": 0,
        "pending": 0,
        "blocked": 0,
        "stopped": 0,
        "unverified": 0,
        "skipped": 0,
    }
    # One plan: the card drops the plan from each task, as _compose does.
    assert rundata.graph([{**t, "plan_id": None} for t in tasks]) == {
        "waves": [["T1"], ["T2", "T4"], ["T3"], ["T5"]],
        "edges": [["T1", "T2"], ["T1", "T3"], ["T2", "T3"], ["T1", "T4"], ["T2", "T5"], ["T3", "T5"]],
    }
    t1 = tasks[0]
    assert t1["duration_ms"] == 64711 and t1["started_at"].endswith("Z") and t1["step"] is None
    [attempt] = t1["attempt_log"]
    assert attempt["attempt"] == 1 and attempt["model"] == "glm-5.1" and attempt["started_at"]
    assert [g["gate"] for g in attempt["gates"]] == ["verify[0:test]", "verify[1:compile]", "rung[test]"]
    assert t1["note"].startswith("The implementation is complete.")
    # Every line says what kind of thing happened, and when.
    timeline = list(tracker.fold.timeline)
    assert {line["group"] for line in timeline} == {"run", "task", "agent", "gate"}
    assert all(isinstance(line["ts_millis"], int) for line in timeline)
    assert any(line["text"].startswith("T1 agent: The implementation is complete.") for line in timeline)
    assert round(tracker.fold.cost_usd, 4) == 0.1952
    assert tracker.fold.first_ms == 1791901014561 and tracker.fold.last_ms == 1791901447773


def test_a_retried_task_lists_each_attempt_although_roko_numbers_them_all_zero() -> None:
    tracker, _ = tracker_for("failed_run")
    t1 = cards_of(tracker)[0]
    assert t1["attempts"] == 6 and [a["attempt"] for a in t1["attempt_log"]] == [1, 2, 3, 4, 5, 6]
    assert all(a["gates"] == [{"gate": "verify[0:compile]", "passed": False}] for a in t1["attempt_log"])


def test_a_running_task_says_what_it_is_doing() -> None:
    tracker, fx = tracker_for("multiwave_plan_run")
    partial = RunTracker(fx["run_id"])
    partial.plan_tasks = tracker.plan_tasks
    for row in fx["events"]:
        partial.fold.feed(row["cursor"], row["type"], row["event"])
        if row["type"] == "gate_rung_started" and row["event"].get("task_id") == "T2":
            break
    tasks = {t["task_id"]: t for t in cards_of(partial)}
    assert tasks["T1"]["outcome"] == "passed"
    assert tasks["T2"]["outcome"] == "running" and tasks["T2"]["step"] == "check"
    assert tasks["T2"]["step_detail"].startswith("verify[") and tasks["T2"]["step_since"]
    assert tasks["T5"]["outcome"] == "pending"
    progress = rundata.progress(list(tasks.values()))
    assert progress["passed"] >= 1 and progress["running"] >= 1 and progress["pending"] >= 1


def test_why_a_failed_plan_names_the_key_line_and_groups_what_it_blocked() -> None:
    assert why_of("failed_run") == (
        "T1's check verify[0:compile] did not pass, all 6 times it ran; the last time: bash: line 1: python: "
        "command not found. T2, T3, T4 and T5 were blocked because T1 did not pass."
    )


def test_why_a_cancelled_plan_says_what_was_done() -> None:
    # roko reports the interrupted task as failed and adds a "failed" engine tally (roko bug-1d09e8).
    assert why_of("cancelled_plan_run") == (
        "The run was cancelled while T3 ran. T1, T2 and T4 had passed before that. T5 never started."
    )


@pytest.mark.parametrize(
    ("output", "line"),
    [
        ("$ cargo test\nerror[E0308]: mismatched types\n --> src/lib.rs:3", "error[E0308]: mismatched types"),
        # 0.6.0: the line that states the cause beats the runner's summary of what failed.
        ("$ pytest\nE   AssertionError: 2 != 3\nFAILED tests/t.py::test_x", "AssertionError: 2 != 3"),
        ("$ make\nall good\nbut odd", "but odd"),
        ("", None),
    ],
)
def test_key_line(output: str, line: str | None) -> None:
    assert rundata.key_line(output) == line


# -- the card through the backend ---------------------------------------------------


def test_card_carries_progress_graph_and_request(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["running", "succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "add a --json flag", "max_usd": 1, "title": "JSON output"})[
        "run_id"
    ]
    card = views.card(rt, run_id)
    assert card["label"] == "JSON output" and card["request"] == "add a --json flag"
    assert card["progress"]["total"] == 1 and card["graph"] == {"waves": [["T1"]], "edges": []}
    assert "last_event_at" in card and "eta_minutes" in card


def test_overview_rows_carry_progress(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["running"]
    call(rt, "roko_run", {"prompt": "x", "max_usd": 1})
    [row] = views.ui_overview(rt)["runs"]
    assert row["progress"]["total"] == 1 and row["progress"]["running"] == 1


def test_a_run_roko_has_no_record_of_is_shown_as_missing(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    del fake.runs[run_id]
    # Just started: roko may not know it yet, so this is an error to retry.
    with pytest.raises(RokoError) as raised:
        views.card(rt, run_id)
    assert raised.value.code is Code.NOT_FOUND
    old = (datetime.now(UTC) - timedelta(minutes=2)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rt.runs.update(run_id, started_at=old)
    card = views.card(rt, run_id)
    assert card["state"] == "missing" and card["active"] is False and "no record" in card["problems"][0]
    # It no longer counts against today's spend as if it were running.
    assert views.ui_overview(rt)["spend"]["committed_usd"] == 0


# -- what waits on the person ---------------------------------------------------------


def test_a_confirmation_deadline_comes_from_roko_only(rt: Runtime, fake: FakeRoko) -> None:
    held = "2026-10-13T14:28:53.126917+00:00"
    fake.runs["r1"] = fake._new_run("run")
    fake.runs["r1"].run_id = "r1"
    fake.confirms["r1"] = [{"task_id": "T1", "attempt_key": "k:1", "question": "OK?", "held_at": held}]
    [item] = pending_confirmations(rt.client(), "r1")
    assert item["deadline_at"] is None and item["timeout_secs"] is None
    fake.confirms["r1"][0]["timeout_secs"] = 1800
    [item] = pending_confirmations(rt.client(), "r1")
    assert item["timeout_secs"] == 1800 and item["deadline_at"] == "2026-10-13T14:58:53+00:00"
    fake.confirms["r1"][0]["deadline_at"] = "2026-10-13T15:00:00Z"
    [item] = pending_confirmations(rt.client(), "r1")
    assert item["deadline_at"] == "2026-10-13T15:00:00+00:00"


# -- titles -------------------------------------------------------------------------------


def test_titles_name_runs_and_plans(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.plans["p1"] = {"title": "P", "tasks": [{"id": "T1", "title": "t"}]}
    call(rt, "roko_run", {"prompt": "a very long request " * 10, "max_usd": 1, "title": "  Short\nname "})
    call(rt, "roko_plan_run", {"plan_id": "p1", "max_usd": 1, "title": "Ledger budgets"})
    labels = [run["label"] for run in rt.runs.recent(5)]
    assert labels == ["Ledger budgets", "Short name"]
    assert rt.runs.recent(5)[1]["request"].startswith("a very long request")


# -- the diff -----------------------------------------------------------------------------


PATCH = (
    "diff --git a/tally/cli.py b/tally/cli.py\n"
    "index 1111111..2222222 100644\n"
    "--- a/tally/cli.py\n"
    "+++ b/tally/cli.py\n"
    "@@ -1,3 +1,4 @@ def main\n"
    " import sys\n"
    "+import json\n"
    " \n"
    "-print('x')\n"
    "+print(json.dumps(x))\n"
    "\\ No newline at end of file\n"
)


def test_parse_patch_numbers_both_sides() -> None:
    hunks, clipped = review.parse_patch(PATCH)
    assert not clipped
    [hunk] = hunks
    assert hunk["old_start"] == 1 and hunk["new_start"] == 1 and hunk["context"] == "def main"
    assert hunk["lines"] == [
        [" ", 1, 1, "import sys"],
        ["+", None, 2, "import json"],
        [" ", 2, 3, ""],
        ["-", 3, None, "print('x')"],
        ["+", None, 4, "print(json.dumps(x))"],
        ["\\", None, None, "No newline at end of file"],
    ]


def test_diff_from_roko(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    views.card(rt, run_id)
    body = FIXTURES["multiwave_plan_run"]["diff"]
    fake.diffs[run_id] = {key: value for key, value in body.items() if key != "run_id"}  # type: ignore[index]
    diff = review.run_diff(rt, run_id[:8])
    assert diff["available"] is True and diff["source"] == "roko" and diff["run_id"] == run_id
    assert diff["branch"].startswith("roko/batch/") and len(diff["commit"]) == 40
    paths = [f["path"] for f in diff["files"]]
    assert "tally/budgets.py" in paths
    budgets = next(f for f in diff["files"] if f["path"] == "tally/budgets.py")
    assert budgets["status"] == "added" and budgets["language"] == "python" and budgets["deletions"] == 0
    assert budgets["hunks"][0]["lines"][0][:3] == ["+", None, 1]
    assert sum(1 for line in budgets["hunks"][0]["lines"] if line[0] == "+") == budgets["additions"]
    assert diff["totals"]["files"] == len(diff["files"])
    asked = [r for r in fake.requests if r["path"].endswith("/diff")][-1]
    assert asked["query"] == {"max_files": "100", "max_patch_bytes": "65536"}


def test_diff_of_a_running_run_or_a_run_without_work(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    views.card(rt, run_id)
    assert review.run_diff(rt, run_id) | {"checked_at": None} == {
        "run_id": run_id,
        "available": False,
        "why": "running",
        "message": "the run is still going: its changes show once it ends",
        "files": [],
        "totals": {"files": 0, "additions": 0, "deletions": 0},
        "checked_at": None,
    }
    fake.runs[run_id].states = ["failed"]
    views.card(rt, run_id)
    assert review.run_diff(rt, run_id)["why"] == "none"


# -- merging ------------------------------------------------------------------------------


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


@pytest.fixture
def identity(monkeypatch: pytest.MonkeyPatch) -> None:
    for key, value in (
        ("GIT_AUTHOR_NAME", "t"),
        ("GIT_AUTHOR_EMAIL", "t@t"),
        ("GIT_COMMITTER_NAME", "t"),
        ("GIT_COMMITTER_EMAIL", "t@t"),
    ):
        monkeypatch.setenv(key, value)


@pytest.fixture
def repo(tmp_path: Path, identity: None) -> Path:
    path = tmp_path / "ws"
    path.mkdir()
    git(path, "init", "-q", "-b", "main")
    (path / "lib.py").write_text("a = 1\n")
    (path / "other.py").write_text("b = 1\n")
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "base")
    return path


@pytest.fixture
def wrt(fake: FakeRoko, repo: Path) -> Iterator[Runtime]:
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(repo)}))
    try:
        yield runtime
    finally:
        runtime.close()


def deliver(repo: Path, run_id: str, path: str = "lib.py", text: str = "a = 2\n") -> str:
    """What roko does: a batch branch off HEAD with the verified change, never checked out."""
    git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
    (repo / path).write_text(text)
    git(repo, "commit", "-q", "-am", "roko: T1")
    git(repo, "checkout", "-q", "main")
    return git(repo, "rev-parse", f"roko/batch/{run_id}")


def ended_run(rt: Runtime, fake: FakeRoko, repo: Path, **deliver_args: str) -> tuple[str, str]:
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    commit = deliver(repo, run_id, **deliver_args)
    return run_id, commit


def test_merge_fast_forwards_exactly_what_was_reviewed(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id, commit = ended_run(wrt, fake, repo)
    check = review.merge_check(wrt, run_id)
    assert check["can_merge"] is True and check["mode"] == "fast-forward" and check["into"] == "main"
    assert check["command"].endswith(f"merge --ff-only roko/batch/{run_id}")
    before = git(repo, "rev-parse", "HEAD")
    with pytest.raises(RokoError, match="moved since you reviewed"):
        review.merge_run(wrt, run_id, {"commit": before[:12]})
    result = review.merge_run(wrt, run_id, {"commit": commit[:12]})
    assert result["merged"] is True and result["mode"] == "fast-forward" and result["into"] == "main"
    assert git(repo, "rev-parse", "HEAD") == commit
    assert result["undo_command"].endswith(f"reset --keep {before}")
    assert (repo / "lib.py").read_text() == "a = 2\n"
    assert review.merge_run(wrt, run_id, {})["already"] is True
    assert review.merge_check(wrt, run_id)["merged"] is True


def test_merge_makes_a_merge_commit_when_the_branch_moved_on_without_conflict(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id, commit = ended_run(wrt, fake, repo)
    (repo / "other.py").write_text("b = 2\n")
    git(repo, "commit", "-q", "-am", "meanwhile")
    check = review.merge_check(wrt, run_id)
    assert check["can_merge"] is True and check["mode"] == "merge"
    result = review.merge_run(wrt, run_id, {"commit": commit})
    assert result["mode"] == "merge"
    assert git(repo, "log", "-1", "--format=%s") == f"Merge roko run {run_id[:8]}: x"
    assert (repo / "lib.py").read_text() == "a = 2\n" and (repo / "other.py").read_text() == "b = 2\n"


def test_merge_refuses_a_conflict_and_leaves_the_checkout_alone(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id, _ = ended_run(wrt, fake, repo)
    (repo / "lib.py").write_text("a = 3\n")
    git(repo, "commit", "-q", "-am", "meanwhile")
    head = git(repo, "rev-parse", "HEAD")
    check = review.merge_check(wrt, run_id)
    assert check["can_merge"] is False and "conflict" in check["reason"]
    with pytest.raises(RokoError, match="conflict") as raised:
        review.merge_run(wrt, run_id, {})
    assert raised.value.code is Code.REFUSED and "merge it in a terminal" in str(raised.value.hint)
    assert git(repo, "rev-parse", "HEAD") == head and git(repo, "status", "--porcelain") == ""


@pytest.mark.parametrize("trouble", ["dirty", "detached"])
def test_merge_refuses_an_unsafe_checkout(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals, trouble: str
) -> None:
    run_id, _ = ended_run(wrt, fake, repo)
    if trouble == "dirty":
        (repo / "other.py").write_text("b = 9\n")
        expected = "uncommitted changes to 1 tracked file"
    else:
        git(repo, "checkout", "-q", "--detach")
        expected = "detached HEAD"
    check = review.merge_check(wrt, run_id)
    assert check["can_merge"] is False and expected in check["reason"]
    with pytest.raises(RokoError, match=expected):
        review.merge_run(wrt, run_id, {})


def test_merge_without_a_local_workspace_gives_the_command(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["succeeded"]
    fake.run_result = lambda rid: {
        "branch": f"roko/batch/{rid}",
        "commit": "0123456789abcdef0123456789abcdef01234567",
        "files_changed": ["a.py"],
        "merged": False,
        "merge_command": f"git merge --ff-only roko/batch/{rid}",
    }
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    check = review.merge_check(rt, run_id)
    assert check["can_merge"] is False and "not on this machine" in check["reason"]
    assert check["command"] == f"git merge roko/batch/{run_id}"


# -- the routes -----------------------------------------------------------------------------


fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

PREFIX = "/api/plugins/roko"


@pytest.fixture
def web(wrt: Runtime) -> Iterator[TestClient]:
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: wrt), prefix=PREFIX)
    with TestClient(app) as test_client:
        yield test_client


def test_post_runs_starts_a_run_without_asking_again(
    web: TestClient, wrt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    body = web.post(PREFIX + "/runs", json={"prompt": "add tests", "max_usd": 0.5, "title": "Tests"}).json()
    assert body["ok"] is True and body["kind"] == "run" and body["max_usd"] == 0.5
    assert approvals.asked == []  # the click was the person's approval
    [logged] = wrt.runs.recent(1)
    assert logged["label"] == "Tests" and logged["request"] == "add tests" and logged["source"] == "ui"
    started = [r for r in fake.requests if r["path"] == "/mcp" and "run_prompt" in json.dumps(r["body"])]
    assert started and started[-1]["body"]["params"]["arguments"] == {"prompt": "add tests", "max_usd": 0.5}


def test_post_runs_can_write_a_plan_instead(web: TestClient, wrt: Runtime, fake: FakeRoko) -> None:
    body = web.post(PREFIX + "/runs", json={"prompt": "a ledger", "plan": True}).json()
    assert body["ok"] is True and body["kind"] == "plan_generate"
    assert wrt.runs.recent(1)[0]["kind"] == "plan_generate"


@pytest.mark.parametrize(
    ("payload", "message"),
    [
        ({"max_usd": 1}, "say what roko should do"),
        ({"prompt": "x"}, "max_usd is required"),
        ({"prompt": "x", "max_usd": 50}, "above the 5.00 cap"),
        ({"prompt": "x", "max_usd": 1, "domain": "chain"}, "domain must be one of"),
        ({"prompt": "x" * 9000, "max_usd": 1}, "longer than"),
    ],
)
def test_post_runs_refusals(web: TestClient, payload: dict[str, Any], message: str) -> None:
    body = web.post(PREFIX + "/runs", json=payload).json()
    assert body["ok"] is False and message in body["error"]["message"]


def test_diff_and_merge_routes(
    web: TestClient, wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    fake.diffs = None  # an older roko serve: the diff comes from the branch itself
    run_id, commit = ended_run(wrt, fake, repo)
    diff = web.get(f"{PREFIX}/runs/{run_id}/diff").json()["diff"]
    assert diff["available"] is True and diff["source"] == "git" and diff["commit"] == commit
    [changed] = diff["files"]
    assert changed["path"] == "lib.py" and changed["additions"] == 1 and changed["deletions"] == 1
    assert [line[0] for line in changed["hunks"][0]["lines"]] == ["-", "+"]
    check = web.get(f"{PREFIX}/runs/{run_id}/merge").json()["merge"]
    assert check["can_merge"] is True and not any(key.startswith("_") for key in check)
    merged = web.post(f"{PREFIX}/runs/{run_id}/merge", json={"commit": commit}).json()
    assert merged["ok"] is True and merged["merge"]["merged"] is True
    assert git(repo, "rev-parse", "HEAD") == commit


def test_actions_off_makes_the_new_routes_read_only(fake: FakeRoko, repo: Path, approvals: Approvals) -> None:
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(repo), "ui_actions": False}))
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: runtime), prefix=PREFIX)
    with TestClient(app) as web:
        for path, payload in (("/runs", {"prompt": "x", "max_usd": 1}), ("/runs/abc/merge", {})):
            body = web.post(PREFIX + path, json=payload).json()
            assert body["ok"] is False and body["error"]["code"] == "forbidden"
    runtime.close()


# -- the replay server the UIs are built against -----------------------------------------


def test_replay_roko_moves_a_recorded_run_and_takes_new_work(tmp_path: Path, approvals: Approvals) -> None:
    import time

    from replay_roko import Replay, build

    server = build(400.0, tmp_path / "ws").start()
    runtime = Runtime(FakeContext({"url": server.url, "workdir": str(tmp_path / "ws")}))
    try:
        ended = [r for r in server.runs.values() if isinstance(r, Replay) and r.current() != "running"]
        assert {r.current() for r in ended} == {"succeeded", "failed", "cancelled"}
        started = ui_api.start_run(runtime, {"prompt": "add a --json flag", "max_usd": 0.5})
        card = views.card(runtime, started["run_id"])
        for _ in range(40):
            if not card["active"]:
                break
            time.sleep(0.1)
            card = views.card(runtime, started["run_id"])
        assert card["state"] == "succeeded" and card["progress"]["passed"] == 1
        assert review.merge_check(runtime, started["run_id"])["can_merge"] is True
        sign_off = ui_api.start_run(runtime, {"prompt": "write a report", "max_usd": 0.5})
        waiting: list[dict[str, Any]] = []
        for _ in range(40):
            waiting = views.card(runtime, sign_off["run_id"])["waiting"]
            if waiting:
                break
            time.sleep(0.1)
        assert waiting and waiting[0]["timeout_secs"] == 1800 and waiting[0]["deadline_at"]
        ui_api.decide(runtime, {"code": waiting[0]["code"], "approve": True})
        for _ in range(40):
            if views.card(runtime, sign_off["run_id"])["state"] == "succeeded":
                break
            time.sleep(0.1)
        assert views.card(runtime, sign_off["run_id"])["state"] == "succeeded"
    finally:
        runtime.close()
        server.stop()


# -- roko's numbered attempts and queued prompt runs ---------------------------------------


def test_numbered_attempts_with_a_failover_inside_one() -> None:
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1"}
    fold.feed(1, "agent_spawned", {**base, "attempt": 1, "model": "cheap", "ts_millis": 1000})
    fold.feed(2, "agent_spawned", {**base, "attempt": 1, "model": "backup", "ts_millis": 2000})
    fold.feed(3, "gate_result", {**base, "gate": "verify[0:test]", "passed": False, "output_text": "$ t\nx"})
    fold.feed(4, "agent_spawned", {**base, "attempt": 2, "model": "strong", "ts_millis": 3000})
    task = fold.tasks[("p", "T1")]
    assert task.attempts == 2
    assert [(a["attempt"], a["model"]) for a in task.attempt_log] == [(1, "backup"), (2, "strong")]
    lines = [line for line in fold.timeline if line["type"] == "agent_spawned"]
    assert [(line["attempt"], line["model"]) for line in lines] == [
        (1, "cheap"),
        (1, "backup"),
        (2, "strong"),
    ]
    [check] = [line for line in fold.timeline if line["type"] == "gate_result"]
    assert check["gate"] == "verify[0:test]" and check["passed"] is False


def test_unnumbered_attempts_from_an_older_roko_are_counted() -> None:
    fold = rundata.EventFold()
    for cursor in (1, 2, 3):
        fold.feed(cursor, "agent_spawned", {"plan_id": "p", "task_id": "T1", "attempt": 0, "model": "m"})
    assert fold.tasks[("p", "T1")].attempts == 3
    assert [line["attempt"] for line in fold.timeline] == [1, 2, 3]


def test_a_queued_prompt_run_says_where_it_waits(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    original = fake._tool_run_prompt

    def queued(args: dict[str, Any], who: Any) -> dict[str, Any]:
        answer = original(args, who)
        body = json.loads(answer["content"][0]["text"])
        body.update(state="queued", position=1)
        return {**answer, "structuredContent": body, "content": [{"type": "text", "text": json.dumps(body)}]}

    fake._tool_run_prompt = queued  # type: ignore[method-assign]
    result = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})
    assert result["state"] == "queued" and result["queue_position"] == 1
    started = ui_api.start_run(rt, {"prompt": "y", "max_usd": 1})
    assert started["state"] == "queued" and started["queue_position"] == 1


# -- names: a chat run's task, and a plan run started from a UI -----------------------------


def test_a_chat_runs_task_and_timeline_use_the_runs_name(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "add a --json flag", "max_usd": 1, "title": "JSON output"})[
        "run_id"
    ]
    events = fake.runs[run_id].index() or []
    for row in events:
        if row["type"] == "task_started":
            row["title"] = "Request from chat host hermes"
    fake.runs[run_id].events = events
    card = views.card(rt, run_id)
    assert card["tasks"][0]["title"] == "JSON output"
    lines = ui_api.timeline(rt, run_id, {"tail": "50"})["events"]
    assert "T1 started: JSON output" in [line["text"] for line in lines]
    paged = ui_api.timeline(rt, run_id, {})["events"]
    assert "T1 started: JSON output" in [line["text"] for line in paged]


def test_a_plan_started_from_a_ui_is_named_after_the_request_that_wrote_it(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    written = ui_api.start_run(rt, {"prompt": "CSV export for tally", "plan": True, "title": "CSV export"})
    plan_id = written["plan_id"]
    started = ui_api.start_plan(rt, plan_id, {"max_usd": 1})
    assert rt.runs.get(started["run_id"])["label"] == "CSV export"  # type: ignore[index]


def test_a_waiting_sign_off_is_named_by_its_run_not_rokos_generic_title(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "write the report", "max_usd": 1, "title": "Ledger report"})[
        "run_id"
    ]
    hold = {
        "task_id": "T1",
        "attempt_key": "k:1",
        "question": "Good?",
        "title": "Request from chat host hermes",
    }
    fake.confirms[run_id] = [hold]
    [item] = views.card(rt, run_id)["waiting"]
    assert item["title"] == f"the result of “Ledger report” (run {run_id[:8]})" and item["task_title"] is None
    # The pages say it without the run's id (design system §6.4).
    assert item["words"] == "the result of “Ledger report”"
    [listed] = views.collect_pending(rt, rt.client())
    assert listed["title"] == item["title"] and listed["code"] == item["code"]

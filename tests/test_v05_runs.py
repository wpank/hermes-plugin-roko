"""0.5.0: run data that says what actually happened.

Interrupted runs (roko's own word, and an older roko's phantom), where an ended run's work is and how far it is
verified (delivered, unverified, the passed half of a failed plan), whether Merge can take it (demo output, an
uncommitted roko.toml, confirmations), what roko is checking right now, why a model was picked, short titles,
plan titles and demos, spec-gate refusals and failed starts, live words that keep their spaces, and Insights
in two scopes. Every field also degrades for an older roko that lacks the newer events and fields.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko, tool_error, tool_ok

from hermes_plugin_roko import (
    errors,
    insights,
    ledger,
    loopevents,
    readiness,
    review,
    rundata,
    runwork,
    tools,
    ui_api,
    views,
)
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.live_relay import LiveRelay
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

# -- helpers ------------------------------------------------------------------------------------


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
    (path / "roko.toml").write_text("[serve]\n")
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


def accept(repo: Path, plan: str, run_id: str, task: str, verdict: str, path: str, text: str) -> str:
    """What roko's acceptance does (gap-3b5361): the task's commit on the plan branch, with its trailers."""
    branch = f"roko/plan/{plan}"
    exists = subprocess.run(
        ["git", "-C", str(repo), "rev-parse", "--verify", "--quiet", branch], capture_output=True
    )
    git(
        repo,
        "checkout",
        "-q",
        branch if exists.returncode == 0 else "-b",
        *([] if exists.returncode == 0 else [branch]),
    )
    (repo / path).write_text(text)
    git(repo, "add", "-A")
    message = (
        f"roko: {task}\n\nRoko-Plan: {plan}\nRoko-Task: {task}\nRoko-Attempt: {run_id}:{task}:1\n"
        f"Roko-Run: {run_id}\nRoko-Verdict: {verdict}\n"
    )
    git(repo, "commit", "-q", "-m", message)
    commit = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", "main")
    return commit


def batch_at_base(repo: Path, run_id: str) -> None:
    """roko starts every run's batch branch at the checkout's HEAD; a run that delivered nothing leaves it there."""
    git(repo, "branch", f"roko/batch/{run_id}", "main")


def ended(rt: Runtime, fake: FakeRoko, state: str, **args: Any) -> str:
    fake.run_script = [state]
    return str(call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5, **args})["run_id"])


class InterruptingRoko(FakeRoko):
    """roko since bug-dceafd: a run whose process died reads `interrupted`; its cancel answers so."""

    dead: set[str]

    def __post_init__(self) -> None:
        super().__post_init__()
        self.dead = set()

    def _tool_run_status(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        answer = super()._tool_run_status(args, who)
        run_id = str(args.get("run_id"))
        if run_id in self.dead:
            body = dict(answer["structuredContent"])
            body.update(
                state="interrupted",
                verdict="interrupted",
                active=False,
                interrupted={
                    "reason": "roko stopped while this run was going (machine restart or crash)",
                    "at": "2026-10-15T14:58:49.000Z",
                },
                finished_at="2026-10-15T14:58:49.000Z",
            )
            return tool_ok(body)
        return answer

    def _tool_run_cancel(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run_id = str(args.get("run_id"))
        if run_id in self.dead:
            return tool_ok(
                {
                    "run_id": run_id,
                    "state": "interrupted",
                    "reason": "roko stopped while this run was going (machine restart or crash)",
                }
            )
        return super()._tool_run_cancel(args, who)


class PhantomRoko(FakeRoko):
    """roko before bug-dceafd: a dead run reads `running` forever, and its cancel finds nothing to stop."""

    dead: set[str]

    def __post_init__(self) -> None:
        super().__post_init__()
        self.dead = set()

    def _tool_run_cancel(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        if str(args.get("run_id")) in self.dead:
            return tool_error("no active execution for this plan")  # an older roko names no code
        return super()._tool_run_cancel(args, who)


# -- R1: interrupted runs ---------------------------------------------------------------------


@pytest.fixture
def interrupting() -> Iterator[InterruptingRoko]:
    server = InterruptingRoko().start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def phantom() -> Iterator[PhantomRoko]:
    server = PhantomRoko().start()
    try:
        yield server
    finally:
        server.stop()


def runtime_for(server: FakeRoko, **settings: Any) -> Runtime:
    return Runtime(FakeContext({"url": server.url, **settings}))


def test_an_interrupted_run_says_so_releases_its_cap_and_tells_what_passed(
    interrupting: InterruptingRoko, approvals: Approvals
) -> None:
    rt = runtime_for(interrupting)
    try:
        interrupting.run_script = ["running"]
        run_id = call(rt, "roko_run", {"prompt": "Add a flag. Then test it.", "max_usd": 0.5})["run_id"]
        assert ledger.spend(rt.runs.recent(), None)["committed_usd"] == 0.5
        interrupting.dead.add(run_id)
        card = views.card(rt, run_id)
        assert card["state"] == "interrupted" and card["active"] is False and card["verdict"] == "interrupted"
        assert card["interrupted"]["source"] == "roko" and "machine restart" in card["interrupted"]["reason"]
        assert card["finished_at"] == "2026-10-15T14:58:49.000Z"
        assert card["why"]["summary"].startswith(
            "The run was interrupted: roko stopped while this run was going"
        )
        assert card["next"] == {
            "action": "rerun",
            "label": "start it again",
            "why": card["interrupted"]["reason"],
        }
        assert "no check ran" not in card["headline"]
        # The run log knows it ended: its cap no longer counts against the day, and it is not "running".
        assert rt.runs.get(run_id)["state"] == "interrupted"
        assert ledger.spend(rt.runs.recent(), None)["committed_usd"] == 0.0
        overview = views.ui_overview(rt)
        assert overview["counts"]["running"] == 0
        [row] = overview["runs"]
        assert (
            row["state"] == "interrupted"
            and row["active"] is False
            and row["interrupted"]["source"] == "roko"
        )
        # Its cancel is no error: roko says it was interrupted. roko's /mcp answer names no time, its
        # summary does.
        stopped = call(rt, "roko_cancel", {"run_id": run_id})
        assert stopped["state"] == "interrupted" and "machine restart" in stopped["reason"]
        assert stopped["already_ended"] is True
        assert stopped["interrupted"]["at"] == "2026-10-15T14:58:49.000Z"
    finally:
        rt.close()


def test_an_older_rokos_phantom_run_is_found_interrupted_after_its_serve_restarted(
    phantom: PhantomRoko, approvals: Approvals
) -> None:
    rt = runtime_for(phantom)
    try:
        phantom.run_script = ["running"]
        run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
        # It began ten minutes ago; this roko serve started a minute ago, so nothing runs it any more.
        phantom.runs[run_id].created_at = datetime.now(UTC) - timedelta(minutes=10)
        phantom.uptime_secs = 60
        card = views.card(rt, run_id)
        assert card["state"] == "interrupted" and card["interrupted"]["source"] == "plugin"
        assert "roko serve stopped while this run was going" in card["interrupted"]["reason"]
        assert rt.runs.get(run_id)["state"] == "interrupted"
        assert ledger.spend(rt.runs.recent(), None)["committed_usd"] == 0.0
    finally:
        rt.close()


def test_a_live_run_on_an_older_roko_is_not_called_interrupted(
    phantom: PhantomRoko, approvals: Approvals
) -> None:
    rt = runtime_for(phantom)
    try:
        phantom.run_script = ["running"]
        run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
        phantom.uptime_secs = 3600  # serve has run for an hour; the run began just now
        card = views.card(rt, run_id)
        assert card["state"] == "running" and card["interrupted"] is None and card["active"] is True
    finally:
        rt.close()


def test_cancel_finding_nothing_running_marks_an_older_rokos_run_interrupted(
    phantom: PhantomRoko, approvals: Approvals
) -> None:
    rt = runtime_for(phantom)
    try:
        phantom.refusal_words = False  # an older roko: no structuredContent on failures
        phantom.run_script = ["running"]
        run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
        phantom.dead.add(run_id)
        stopped = views.cancel(rt, run_id)
        assert stopped["state"] == "interrupted" and stopped["interrupted"]["source"] == "plugin"
        assert stopped["already_ended"] is True
        assert rt.runs.get(run_id)["interrupted"]["source"] == "plugin"
        # roko still says running; the run log's word holds, and the cap is released.
        card = views.card(rt, run_id)
        assert card["state"] == "interrupted" and card["active"] is False
        assert ledger.spend(rt.runs.recent(), None)["committed_usd"] == 0.0
        # An id roko has no run for is still not found.
        with pytest.raises(RokoError) as raised:
            views.cancel(rt, "no-such-run")
        assert raised.value.code is Code.NOT_FOUND
    finally:
        rt.close()


def test_the_page_cancel_route_answers_interrupted(phantom: PhantomRoko, approvals: Approvals) -> None:
    rt = runtime_for(phantom)
    try:
        phantom.run_script = ["running"]
        run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
        phantom.dead.add(run_id)
        body = ui_api.guarded(lambda: rt, lambda r: ui_api.cancel_run(r, run_id))
        assert body["ok"] is True and body["state"] == "interrupted"
    finally:
        rt.close()


# -- R2, R3: where the work is ------------------------------------------------------------------


def test_unverified_work_reported_by_roko_is_shown_kept_and_needs_a_yes_to_merge(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id = ended(wrt, fake, "unverified")
    batch_at_base(repo, run_id)
    commit = accept(repo, run_id, run_id, "T1", "unverified", "lib.py", "a = 2\n")
    base = git(repo, "rev-parse", "main")
    fake.run_result = lambda rid: {
        "branch": f"roko/batch/{rid}",
        "commit": base,
        "base": base,
        "files_changed": [],
        "diffstat": {"files": 0, "insertions": 0, "deletions": 0},
        "merged": False,
        "unverified": [
            {
                "plan_id": rid,
                "branch": f"roko/plan/{rid}",
                "commit": commit,
                "base": base,
                "tasks": [{"task_id": "T1", "verdict": "unverified"}],
                "files_changed": ["lib.py"],
                "diffstat": {"files": 1, "insertions": 1, "deletions": 1},
                "review_command": f"git diff {base[:12]}..roko/plan/{rid}",
            }
        ],
    }
    card = views.card(wrt, run_id)
    assert card.get("delivered") is None  # nothing verified was delivered
    work = card["work"]
    assert work["kind"] == "unverified" and work["source"] == "roko"
    [part] = work["parts"]
    assert part["trust"] == "unverified" and part["delivered"] is False
    assert part["branch"] == f"roko/plan/{run_id}" and part["commit"] == commit[:12]
    assert (
        part["files_changed"] == ["lib.py"]
        and part["diffstat"] == "1 file changed, 1 insertion(+), 1 deletion(-)"
    )
    assert part["review_command"].startswith(f"git -C {repo}") and part["review_command"].endswith(
        f"..roko/plan/{run_id}"
    )
    assert card["merge"]["available"] is True and card["merge"]["work"] == "unverified"
    assert "No check ran on this work (Task 1)" in card["merge"]["confirm"]
    assert card["next"]["action"] == "review" and card["next"]["label"] == "review the unverified changes"
    assert f"its changes are kept on roko/plan/{run_id}" in card["why"]["summary"]
    assert "unverified changes kept" in card["headline"]
    # Changes shows it, marked unverified (roko serve here has no unverified diff: git reads it).
    diff = review.run_diff(wrt, run_id)
    assert diff["available"] is True and diff["work"] == "unverified" and diff["delivered"] is False
    assert [f["path"] for f in diff["files"]] == ["lib.py"] and diff["source"] == "git"
    # Merge needs the person's yes on top of the click.
    with pytest.raises(RokoError, match="needs the person's own yes"):
        review.merge_run(wrt, run_id, {"commit": commit[:12]})
    merged = review.merge_run(wrt, run_id, {"commit": commit[:12], "confirm": True})
    assert merged["merged"] is True and merged["work"] == "unverified"
    assert git(repo, "rev-parse", "HEAD") == commit and (repo / "lib.py").read_text() == "a = 2\n"
    assert views.card(wrt, run_id)["merge"]["merged"] is True


def test_an_older_roko_unverified_run_is_read_from_its_plan_branch(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id = ended(wrt, fake, "unverified")
    batch_at_base(repo, run_id)
    commit = accept(repo, run_id, run_id, "T1", "unverified", "lib.py", "a = 3\n")
    card = views.card(wrt, run_id)
    work = card["work"]
    assert work["source"] == "git" and work["kind"] == "unverified"
    [part] = work["parts"]
    assert part["commit"] == commit[:12] and part["branch"] == f"roko/plan/{run_id}"
    assert part["tasks"] == [{"task_id": "T1", "verdict": "unverified"}]
    assert part["counts"] == {"files": 1, "additions": 1, "deletions": 1}
    # Another run's commits on a plan branch are never this run's.
    other = ended(wrt, fake, "unverified")
    batch_at_base(repo, other)
    accept(repo, other, "some-other-run", "T1", "unverified", "lib.py", "a = 9\n")
    assert views.card(wrt, other)["work"] == {"kind": "none", "parts": [], "source": "git"}


def test_the_passed_half_of_a_failed_plan_is_kept_and_reviewable(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    fake.add_plan("flags", "Add two flags", [{"id": "T1", "title": "a"}, {"id": "T2", "title": "b"}])
    fake.run_script = ["failed"]
    run_id = call(wrt, "roko_plan_run", {"plan_id": "flags", "max_usd": 0.5})["run_id"]
    batch_at_base(repo, run_id)
    passed = accept(repo, "flags", run_id, "T1", "passed", "lib.py", "a = 2\n")
    card = views.card(wrt, run_id)
    work = card["work"]
    assert work["kind"] == "partial"
    [part] = work["parts"]
    assert part["trust"] == "verified" and part["delivered"] is False and part["plan_id"] == "flags"
    assert part["branch"] == "roko/plan/flags" and part["commit"] == passed[:12]
    assert (
        card["merge"]["work"] == "partial"
        and "only the work that passed its checks (Task 1)" in card["merge"]["confirm"]
    )
    # 0.6.0 (dogfood U2): a plan whose tasks did not all pass is resumed, which keeps what passed.
    assert card["next"] == {
        "action": "rerun",
        "label": "resume the plan",
        "why": "Task 2 did not pass; a resume keeps what passed and runs the rest",
        "resume": True,
    }
    diff = review.run_diff(wrt, run_id, {"work": "verified", "plan_id": "flags"})
    assert diff["available"] is True and diff["work"] == "verified" and diff["plan_id"] == "flags"
    assert diff["delivered"] is False


def test_unverified_on_top_of_passed_work_is_two_parts(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id = ended(wrt, fake, "unverified")
    batch_at_base(repo, run_id)
    passed = accept(repo, run_id, run_id, "T1", "passed", "lib.py", "a = 2\n")
    loose = accept(repo, run_id, run_id, "T2", "unverified", "other.py", "b = 1\n")
    parts = views.card(wrt, run_id)["work"]["parts"]
    assert [(p["trust"], p["commit"]) for p in parts] == [
        ("verified", passed[:12]),
        ("unverified", loose[:12]),
    ]
    assert parts[1]["base"] == passed[:12]  # the unverified part shows only what came after the verified one


def test_delivered_work_is_verified_and_merges_without_an_extra_yes(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id = ended(wrt, fake, "succeeded")
    git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
    (repo / "lib.py").write_text("a = 5\n")
    git(repo, "commit", "-q", "-am", "roko: T1")
    git(repo, "checkout", "-q", "main")
    card = views.card(wrt, run_id)
    assert card["work"]["kind"] == "verified" and card["work"]["parts"][0]["delivered"] is True
    assert card["merge"]["available"] is True and card["merge"]["confirm"] is None
    assert card["next"]["action"] == "merge"
    # One key, "review", on every surface: merge lives in the changes it opens (round v8).
    assert card["next"]["label"] == "review"
    assert card["next"]["why"] == "its checks passed; review it, then merge it into main"
    review.merge_run(wrt, run_id, {"commit": git(repo, "rev-parse", f"roko/batch/{run_id}")[:12]})
    after = views.card(wrt, run_id)
    assert after["merge"]["merged"] is True and after["merge"]["into"] == "main"  # "Merged into main"
    assert after["next"] is None


def test_an_older_roko_without_the_workspace_here_says_nothing_about_work(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = ended(rt, fake, "unverified")
    card = views.card(rt, run_id)
    assert card["work"] is None and card["merge"] is None


def test_roko_unverified_diff_is_used_only_when_roko_says_it_is_one(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id = ended(wrt, fake, "unverified")
    batch_at_base(repo, run_id)
    accept(repo, run_id, run_id, "T1", "unverified", "lib.py", "a = 2\n")
    # An older roko ignores `work` and answers with something else: the plugin reads git instead.
    fake.diffs = {run_id: {"files": [{"path": "elsewhere.py", "additions": 1, "patch": ""}], "totals": {}}}
    diff = review.run_diff(wrt, run_id, {"work": "unverified"})
    assert diff["source"] == "git" and [f["path"] for f in diff["files"]] == ["lib.py"]
    fake.diffs = {
        run_id: {
            "work": "unverified",
            "plan_id": run_id,
            "files": [{"path": "lib.py", "additions": 1}],
            "totals": {"files": 1, "additions": 1, "deletions": 0},
        }
    }
    diff = review.run_diff(wrt, run_id, {"work": "unverified"})
    assert diff["source"] == "roko" and diff["work"] == "unverified"
    with pytest.raises(RokoError, match="work must be"):
        review.run_diff(wrt, run_id, {"work": "everything"})


# -- R7: Merge on the card --------------------------------------------------------------------


def test_demo_output_is_never_offered_for_merge(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    fake.add_plan("demo-hello-world", "Start here: hello world demo", [{"id": "T1", "title": "hello"}])
    fake.plans["demo-hello-world"]["group"] = "demos/parallel-plans"
    fake.run_script = ["succeeded"]
    run_id = call(wrt, "roko_plan_run", {"plan_id": "demo-hello-world", "max_usd": 0.25})["run_id"]
    git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
    (repo / "hello.rs").write_text("// roko demo output\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "roko: T1")
    git(repo, "checkout", "-q", "main")
    card = views.card(wrt, run_id)
    assert card["demo"] is True and card["label"] == "Start here: hello world demo"
    assert card["merge"]["available"] is False and card["merge"]["demo"] is True
    assert card["merge"]["reason"] == "demo output: it stays on its run branch"
    assert card["next"]["action"] == "review" and "stays on its run branch" in card["next"]["why"]
    with pytest.raises(RokoError, match="demo output"):
        review.merge_run(wrt, run_id, {})
    assert rt_label(wrt, run_id) == "Start here: hello world demo"


def rt_label(rt: Runtime, run_id: str) -> str:
    return str(rt.runs.get(run_id)["label"])


def test_an_uncommitted_roko_toml_is_named_and_committing_it_is_offered(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id = ended(wrt, fake, "succeeded")
    git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
    (repo / "lib.py").write_text("a = 5\n")
    git(repo, "commit", "-q", "-am", "roko: T1")
    git(repo, "checkout", "-q", "main")
    (repo / "roko.toml").write_text("[serve]\n\n[serve.mcp]\nallow_without_data_llm = true\n")
    card = views.card(wrt, run_id)
    merge = card["merge"]
    assert merge["available"] is False and merge["dirty"] == ["roko.toml"]
    assert "commit roko.toml, then merge" in merge["reason"]
    assert merge["fix"]["action"] == "commit-roko-toml" and merge["fix"]["label"] == "commit roko.toml"
    assert merge["fix"]["command"].endswith("-- roko.toml")
    assert card["next"]["action"] == "commit-roko-toml"
    # The fix goes through the setup-fix routes, previewed, then applied as previewed.
    preview = ui_api.setup_fix_preview(wrt, {"action": "commit-roko-toml"})
    assert "+allow_without_data_llm = true" in preview["preview"] and preview["digest"]
    with pytest.raises(RokoError) as raised:
        ui_api.setup_fix(wrt, {"action": "commit-roko-toml", "digest": "0" * 16})
    assert raised.value.code is Code.CONFLICT
    done = ui_api.setup_fix(wrt, {"action": "commit-roko-toml", "digest": preview["digest"]})
    assert done["done"] is True and done["commit"]
    assert git(repo, "log", "-1", "--format=%s") == runwork.SETTINGS_MESSAGE
    assert git(repo, "show", "--name-only", "--format=", "HEAD") == "roko.toml"
    after = views.card(wrt, run_id)["merge"]
    assert after["available"] is True and after["mode"] == "merge" and after["fix"] is None
    again = ui_api.setup_fix(wrt, {"action": "commit-roko-toml"})
    assert again["done"] is False


def test_other_uncommitted_files_are_named(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id = ended(wrt, fake, "succeeded")
    git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
    (repo / "lib.py").write_text("a = 5\n")
    git(repo, "commit", "-q", "-am", "roko: T1")
    git(repo, "checkout", "-q", "main")
    (repo / "roko.toml").write_text("[serve]\nx = 1\n")
    (repo / "lib.py").write_text("a = 7\n")
    merge = views.card(wrt, run_id)["merge"]
    assert merge["dirty"] == ["lib.py", "roko.toml"] and merge["fix"] is None
    assert "uncommitted changes to 2 tracked files (lib.py, roko.toml)" in merge["reason"]


# -- R9: what roko is checking ------------------------------------------------------------------


def rows(*events: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"cursor": index + 1, "type": event["type"], "event": event} for index, event in enumerate(events)
    ]


def tracker_with(events: list[dict[str, Any]]) -> rundata.RunTracker:
    tracker = rundata.RunTracker("r1")
    for row in events:
        tracker.fold.feed(row["cursor"], row["type"], row["event"])
    return tracker


def test_a_tasks_long_check_is_what_roko_checks() -> None:
    NOW = int(time.time() * 1000)
    tracker = tracker_with(
        rows(
            {"type": "task_started", "plan_id": "p", "task_id": "T1", "ts_millis": NOW - 200_000},
            {
                "type": "gate_rung_started",
                "plan_id": "p",
                "task_id": "T1",
                "rung_name": "verify[0:compile]",
                "ts_millis": NOW - 180_000,
            },
        )
    )
    checking = rundata.checking(tracker, "running")
    assert checking is not None
    assert (checking["what"], checking["label"], checking["scope"], checking["task_id"]) == (
        "verify[0:compile]",
        "compile",
        "task",
        "T1",
    )
    assert checking["source"] == "roko" and 175 <= checking["elapsed_s"] <= 200


def test_after_the_last_task_an_older_roko_is_checking_the_plan() -> None:
    NOW = int(time.time() * 1000)
    tracker = tracker_with(
        rows(
            {"type": "task_started", "plan_id": "p", "task_id": "T1", "ts_millis": NOW - 600_000},
            {
                "type": "task_completed",
                "plan_id": "p",
                "task_id": "T1",
                "outcome": "passed",
                "ts_millis": NOW - 590_000,
            },
        )
    )
    checking = rundata.checking(tracker, "running")
    assert checking is not None and checking["scope"] == "plan" and checking["source"] == "plugin"
    assert checking["label"] == "the plan's checks before delivery" and checking["elapsed_s"] >= 589
    assert rundata.checking(tracker, "succeeded") is None


def test_a_whole_workspace_check_roko_announces_is_named_and_lined() -> None:
    NOW = int(time.time() * 1000)
    events = rows(
        {
            "type": "task_completed",
            "plan_id": "p",
            "task_id": "T1",
            "outcome": "passed",
            "ts_millis": NOW - 9_000,
        },
        {
            "type": "gate_rung_started",
            "plan_id": "p",
            "task_id": "",
            "rung_name": "cargo clippy --workspace --no-deps",
            "ts_millis": NOW - 5_000,
        },
    )
    tracker = tracker_with(events)
    checking = rundata.checking(tracker, "running")
    assert checking is not None and checking["label"] == "clippy" and checking["scope"] == "plan"
    assert checking["source"] == "roko"
    line = rundata.timeline_entry(2, "gate_rung_started", events[1]["event"])
    assert line is not None and line["group"] == "gate" and line["text"] == "checking the plan: clippy"
    done = {
        "type": "check_finished",
        "plan_id": "p",
        "what": "cargo clippy --workspace",
        "scope": "workspace",
        "passed": False,
        "duration_ms": 192_000,
        "output": "error: unused import",
    }
    tracker.fold.feed(3, "check_finished", done)
    assert rundata.checking(tracker, "running")["scope"] == "plan"  # the plan's own checks still run
    end = rundata.timeline_entry(3, "check_finished", done)
    assert (
        end is not None
        and end["text"] == "the workspace: clippy did not pass in 3m12s"
        and end["passed"] is False
    )
    cache = rundata.CardCache()
    cache._trackers[("u", "r1")] = tracker
    why = rundata.explain(cache, "u", {"run_id": "r1", "state": "failed"})
    assert "The workspace's check clippy did not pass: error: unused import." in why["summary"]


@pytest.mark.parametrize(
    ("what", "label"),
    [
        ("cargo fmt --all -- --check", "formatting"),
        ("verify[1:test]", "tests"),
        ("python3 -m unittest", "tests"),
        ("cargo check --workspace", "compile"),
        ("verify[0:runs]", "runs"),
    ],
)
def test_check_labels(what: str, label: str) -> None:
    assert rundata.check_label(what) == label


# -- R10: why a model was picked ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("source", "stage", "decided", "scored"),
    [
        ("ladder", "static", "ladder", False),
        ("router", "static", "router", False),
        ("router", "ucb", "learned", True),
        ("task_hint", "", "pinned", False),
        ("explore", "ucb", "explore", True),
        ("failover", "failover", "failover", False),
        ("", "", None, False),
    ],
)
def test_what_decided_a_route(source: str, stage: str, decided: str | None, scored: bool) -> None:
    view = loopevents.route_view({"model": "m", "source": source, "stage": stage, "candidates": []})
    assert view is not None and view["decided_by"] == decided and view["scored"] is scored


def test_a_chat_runs_route_marks_what_it_could_not_use() -> None:
    route = {
        "model": "gpt-oss-120b",
        "source": "ladder",
        "stage": "static",
        "candidates": [
            {"model": "gpt-oss-120b", "provider": "cerebras", "score": 0.11, "eligible": True},
            {"model": "claude-haiku-4-5", "provider": "claude_cli", "score": 0.11, "eligible": True},
            {
                "model": "gemini-2.5-pro",
                "provider": "gemini",
                "score": 0.11,
                "eligible": False,
                "ineligible_reason": "provider_unconfigured",
            },
        ],
    }
    view = loopevents.route_view(route, chat_run=True)
    assert view is not None
    chosen, cli, gemini = view["candidates"]
    assert chosen["why_not"] is None and chosen.get("excluded_by_policy") is None
    assert (
        cli["eligible"] is False
        and cli["excluded_by_policy"] is True
        and "runs its own tools" in cli["why_not"]
    )
    assert gemini["why_not"] == "its provider is not set up in this workspace"
    plain = loopevents.route_view(route)
    assert plain is not None and plain["candidates"][1]["eligible"] is True  # a terminal run may use it


def test_a_ladder_route_is_worded_without_scores() -> None:
    [loop] = loopevents.loop_events(
        "route_decided",
        {
            "plan_id": "p",
            "task_id": "T1",
            "attempt": 1,
            "model": "gpt-oss-120b",
            "source": "ladder",
            "stage": "static",
            "candidates": [
                {"model": "gpt-oss-120b", "score": 0.11, "p": 1.0, "eligible": True},
                {"model": "claude-haiku-4-5", "score": 0.11, "p": 0.0, "eligible": True},
            ],
        },
        loopevents.LoopContext(),
    )
    # Without the run's models (roko's ladder_step counts from the task's own start rung), no place is guessed.
    assert loop["text"] == "Task 1 · try 1 → gpt-oss-120b, started where its kind of task starts"
    assert loop["data"]["decided_by"] == "ladder" and loop["data"]["scored"] is False


def test_a_cards_tasks_carry_their_latest_route(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
    run = fake.runs[run_id]
    base = run.index() or []
    route = {
        "type": "route_decided",
        "plan_id": run_id,
        "task_id": "T1",
        "attempt": 1,
        "model": "fake-model",
        "provider": "fake",
        "source": "ladder",
        "stage": "static",
        "run_id": run_id,
        "candidates": [
            {"model": "fake-model", "provider": "fake", "score": 0.1, "eligible": True},
            {"model": "claude-sonnet-4-6", "provider": "claude_cli", "score": 0.1, "eligible": True},
        ],
    }
    run.events = [*base[:4], route, *base[4:]]
    card = views.card(rt, run_id)
    [task] = card["tasks"]
    assert task["route"]["decided_by"] == "ladder" and task["route"]["scored"] is False
    assert task["route"]["candidates"][1]["excluded_by_policy"] is True  # Hermes started it: a chat run
    assert task["attempt_log"][0]["route"]["decided_by"] == "ladder"


# -- the loop feed in the pages' words (ui-notes D7, D8) ------------------------------------------

PAGES = Path(__file__).resolve().parent.parent
_JS_PAIR = re.compile(r"""(?:['"]([^'"]+)['"]|(\w+))\s*:\s*['"]([^'"]*)['"]""")


@pytest.mark.parametrize(
    ("page", "table"),
    [
        (page, table)
        for page in ("desktop/plugin.js", "dashboard/dist/index.js")
        # 0.9: neither page names check rungs (Learning's loops are in plain words; the loops tab went), so only the
        # feed's own text carries RUNG_NAMES.
        for table in ("LOOP_NAMES", "LOOP_REASONS", "ADMISSION_WORDS")
    ],
)
def test_the_loop_feed_uses_the_pages_tables(page: str, table: str) -> None:
    # Both pages show the feed's text as it is, beside their own words for the same loops, lessons and checks.
    found = re.search(table + r" = \{(.*?)\}", (PAGES / page).read_text(), re.S)
    assert found is not None
    pairs = {quoted or bare: words for quoted, bare, words in _JS_PAIR.findall(found[1])}
    assert pairs == {str(key): words for key, words in getattr(loopevents, table).items()}


def test_the_loop_feed_says_lessons_and_loop_states_as_the_pages_do() -> None:
    def said(kind: str, event: dict[str, Any]) -> str:
        row = {"plan_id": "p", "task_id": "T1", "ts_millis": 1000, "ts": "t", **event}
        [loop] = loopevents.loop_events(kind, row, loopevents.LoopContext())
        return str(loop["text"])

    lessons = [
        (
            {"admission": "no_candidate", "reinforced": 3, "promoted": 3},
            "nothing new to learn from this task · confirmed 3 lessons it had · 3 moved up a tier",
        ),
        ({"admission": "duplicate", "reinforced": 2, "lesson": "x"}, "confirmed 2 lessons it had: x"),
        ({"admission": "duplicate", "lesson": "x"}, "confirmed a lesson it had: x"),
        ({"admission": "light_admitted", "lesson": "none"}, "kept a new lesson"),
        ({"admission": "full_rejected"}, "a lesson was not kept"),
    ]
    for event, words in lessons:
        assert said("knowledge_written", event) == f"Task 1 · {words}"
    health = {"loop_id": "L-know", "state": "live", "h": 0.05}
    assert said("loop_health", health) == "lessons in prompts: proven: its learning is in use · holdout 5%"
    flagged = {"loop_id": "L-linucb", "state": "flagged", "reason": "dormant:mask"}
    assert said("loop_health", flagged) == (
        "model routing (LinUCB stage): flagged: something else overrides what it picks"
    )
    moved = {"loop_id": "L-route", "from": "live", "to": "demoted", "reason": "harm", "rule": "r"}
    assert said("loop_transition", moved) == (
        "model routing: proven → demoted: roko uses its default (it made things worse)"
    )


def test_the_thresholds_line_names_rokos_rungs() -> None:
    snapshot = {
        "rungs": {"1": {"ema_pass_rate": 0.8, "total_observations": 9}, "1000": {"ema_pass_rate": 1.0}}
    }
    row = {"plan_id": "p", "ts_millis": 1000, "snapshot_json": json.dumps(snapshot)}
    [loop] = loopevents.loop_events("gate_thresholds_updated", row, loopevents.LoopContext())
    assert loop["text"] == "check thresholds updated: lint 80% · whole-plan 100%"


def test_l2_has_the_wave_openings_of_runs_the_page_never_followed(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("four", "Four tasks", FOUR)
    fake.run_script = ["running"]
    runs = [call(rt, "roko_plan_run", {"plan_id": "four", "max_usd": 0.5})["run_id"] for _ in range(2)]
    for n, run_id in enumerate(runs):
        fake.runs[run_id].events = [
            {"type": "task_started", "plan_id": "four", "task_id": "T1", "ts_millis": 1000 + n},
            {"type": "task_started", "plan_id": "four", "task_id": "T2", "ts_millis": 2000 + n},
        ]
        views.card(rt, run_id)  # its card is built; no page follows it live
    waves = [event for event in views.recent_loops(rt) if event["kind"] == "wave"]
    # Each run's own openings: wave 1 (T1) and wave 2 (T2 and T3, of which T2 started).
    assert sorted((event["run_id"], event["text"]) for event in waves) == sorted(
        (run_id, text)
        for run_id in runs
        for text in ("step 1 starts: Task 1", "step 2 starts: Task 2, Task 3 at once")
    )


# -- R11, R6: names ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("request_text", "title"),
    [
        (
            "Add a --version flag to the wordy CLI. Files: - wordy/cli.py: the argparse-based CLI.",
            "Add a --version flag to the wordy CLI",
        ),
        ("Fix the bug, e.g. the parser crash. Then test.", "Fix the bug, e.g. the parser crash"),
        ("Task:\nMake the tests pass", "Make the tests pass"),
        ("# Release notes\nWrite them", "Release notes"),
        ("Is the cache safe? Check it.", "Is the cache safe?"),
        ("Bump the version to 0.1.0. Then tag it.", "Bump the version to 0.1.0"),
        ("x" * 80, "x" * 59 + "…"),
        (
            "Rewrite the budget module so every category keeps integer cents and the report rounds once",
            "Rewrite the budget module so every category keeps integer…",
        ),
    ],
)
def test_short_titles(request_text: str, title: str) -> None:
    assert rundata.short_title(request_text) == title


def test_runs_are_named_short_and_plan_runs_by_their_plans_title(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("demo-hello-world", "Start here: hello world demo", [{"id": "T1", "title": "hi"}])
    call(
        rt,
        "roko_run",
        {"prompt": "Add a --version flag to the wordy CLI. Files: - wordy/cli.py", "max_usd": 0.5},
    )
    call(rt, "roko_plan_run", {"plan_id": "demo-hello-world", "max_usd": 0.25})
    plan_run, prompt_run = rt.runs.recent(2)
    assert prompt_run["label"] == "Add a --version flag to the wordy CLI"
    assert prompt_run["request"].startswith("Add a --version flag to the wordy CLI. Files:")
    assert plan_run["label"] == "Start here: hello world demo"
    # An older plugin logged the whole request as the label: rows and cards show its short form.
    rt.runs.update(prompt_run["run_id"], label=prompt_run["request"])
    [row] = [r for r in views.run_rows(rt, rt.runs.recent(5)) if r["run_id"] == prompt_run["run_id"]]
    assert row["label"] == "Add a --version flag to the wordy CLI"


def test_plans_say_which_are_demos_and_where_to_start(rt: Runtime, fake: FakeRoko) -> None:
    fake.add_plan("01-backend", "Backend plan service", [{"id": "T1"}])
    fake.add_plan("demo-hello-world", "Start here: hello world demo", [{"id": "T1"}])
    fake.plans["demo-hello-world"]["group"] = "demos/parallel-plans"
    fake.add_plan("demo-fixture", "Roko plan-runner demo", [{"id": "T1"}])
    fake.plans["demo-fixture"]["status"] = "fixture"
    rows_by_id = {row["id"]: row for row in call(rt, "roko_plans", {})["plans"]}
    assert (rows_by_id["01-backend"]["demo"], rows_by_id["01-backend"]["start_here"]) == (False, False)
    assert (
        rows_by_id["demo-hello-world"]["demo"] is True
        and rows_by_id["demo-hello-world"]["start_here"] is True
    )
    assert rows_by_id["demo-hello-world"]["group"] == "demos/parallel-plans"
    assert rows_by_id["demo-fixture"]["demo"] is True
    detail = call(rt, "roko_plans", {"plan_id": "demo-hello-world"})
    assert detail["title"] == "Start here: hello world demo" and detail["demo"] is True
    assert detail["group"] == "demos/parallel-plans" and detail["start_here"] is True


def test_plan_detail_keeps_the_tasks_title_when_roko_has_no_plan_row(
    rt: Runtime, fake: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake.add_plan("p1", "P one", [{"id": "T1"}])
    original = rt.client().get

    def no_row(path: str, params: Any = None, **kwargs: Any) -> Any:
        if path == "/api/plans/p1":
            raise RokoError(Code.NOT_FOUND, "no such route")
        return original(path, params, **kwargs)

    monkeypatch.setattr(rt.client(), "get", no_row)
    detail = call(rt, "roko_plans", {"plan_id": "p1"})
    assert detail["title"] == "P one" and detail["demo"] is False


# -- titles: roko names the run (gap-c2efe7) ------------------------------------------------------


class TitledRoko(FakeRoko):
    """roko since gap-c2efe7: `run_prompt` and `plan_generate` declare a `title`, and the run's summary says
    it (as its plans' titles)."""

    titles: dict[str, str]

    def __post_init__(self) -> None:
        super().__post_init__()
        self.titles = {}
        self.tool_args = {
            "run_prompt": ["prompt", "title", "domain", "max_usd"],
            "plan_generate": ["prompt", "title"],
        }

    def _tool_run_prompt(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        answer = super()._tool_run_prompt(args, who)
        started = answer.get("structuredContent") or {}
        if isinstance(args.get("title"), str) and started.get("run_id"):
            self.titles[started["run_id"]] = args["title"]
        return answer

    def _tool_run_status(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        answer = super()._tool_run_status(args, who)
        run_id = str(args.get("run_id"))
        if run_id not in self.titles:
            return answer
        return tool_ok({**answer["structuredContent"], "title": self.titles[run_id]})


@pytest.fixture
def titled() -> Iterator[TitledRoko]:
    server = TitledRoko().start()
    try:
        yield server
    finally:
        server.stop()


PROMPT = "Add a --json flag to the balance command. Keep the output stable."


def test_a_roko_that_takes_titles_is_sent_the_runs_name(titled: TitledRoko, approvals: Approvals) -> None:
    rt = runtime_for(titled)
    try:
        call(rt, "roko_run", {"prompt": PROMPT, "max_usd": 0.5, "title": "JSON balance"})
        call(rt, "roko_run", {"prompt": PROMPT, "max_usd": 0.5})
        call(rt, "roko_plan_generate", {"prompt": PROMPT, "title": "A plan for JSON"})
        page = [
            ui_api.start_run(rt, {"prompt": PROMPT, "max_usd": 0.5, "title": "From the composer"}),
            ui_api.start_run(rt, {"prompt": PROMPT, "plan": True}),
        ]
        assert all(started["run_id"] for started in page)
        first = "Add a --json flag to the balance command"  # the request's short title
        sent = [args.get("title") for args in titled.tool_calls("run_prompt")]
        assert sent == ["JSON balance", first, "From the composer"]
        assert [args.get("title") for args in titled.tool_calls("plan_generate")] == [
            "A plan for JSON",
            first,
        ]
        # What roko is told is what the plugin calls the run.
        logged = {run["label"] for run in rt.runs.recent(10)}
        assert logged == {"JSON balance", first, "A plan for JSON", "From the composer"}
        # roko's tool list is read once a minute, not before every start.
        lists = [r for r in titled.requests if (r.get("body") or {}).get("method") == "tools/list"]
        assert len(lists) == 1
    finally:
        rt.close()


def test_an_older_roko_is_not_sent_a_title_and_its_runs_still_start(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    # Its tools declare no `title` (and `additionalProperties: false`).
    started = call(rt, "roko_run", {"prompt": PROMPT, "max_usd": 0.5, "title": "JSON balance"})
    generated = call(rt, "roko_plan_generate", {"prompt": PROMPT, "title": "A plan"})
    from_page = ui_api.start_run(rt, {"prompt": PROMPT, "max_usd": 0.5, "title": "From the composer"})
    assert started["run_id"] and generated["run_id"] and from_page["run_id"]
    assert all(
        "title" not in args for args in fake.tool_calls("run_prompt") + fake.tool_calls("plan_generate")
    )
    # The card is named by what the plugin logged.
    assert views.card(rt, started["run_id"])["label"] == "JSON balance"


def test_a_card_is_named_by_rokos_title_unless_roko_names_only_an_id(
    titled: TitledRoko, approvals: Approvals
) -> None:
    rt = runtime_for(titled)
    try:
        run_id = call(rt, "roko_run", {"prompt": PROMPT, "max_usd": 0.5, "title": "JSON balance"})["run_id"]
        titled.titles[run_id] = "JSON balance for tally"  # roko's own word wins
        card = views.card(rt, run_id)
        assert card["label"] == "JSON balance for tally"
        assert all(task["title"] != "Request from chat host hermes" for task in card["tasks"])
        # A run from before gap-c2efe7: roko calls its plan by the plan's id, the run's.
        older = call(rt, "roko_run", {"prompt": PROMPT, "max_usd": 0.5, "title": "Old run"})["run_id"]
        titled.titles[older] = older
        assert views.card(rt, older)["label"] == "Old run"
    finally:
        rt.close()


# -- dogfood-desktop P1: a plan roko will not run says why ------------------------------------------

QUESTIONS = [
    "When n > number of unique words, should the list be shorter than n or raise? Assumption: return only as "
    "many as exist.",
    "Should punctuation be stripped before splitting? Assumption: simple .lower().split().",
]
PLAN_045 = (
    "task 'T2' has open questions, so its plan cannot run; answer each in the spec, then delete it from "
    "open_questions"
)


def refuse_the_plan(fake: FakeRoko, *, listed: bool = True) -> None:
    """A planner's plan with two open questions on T2: roko's validator rejects it (PLAN_045). A newer roko lists
    the questions under its message; an older one does not, and they are in the plan's source."""
    fake.add_plan(
        "two-modules",
        "Two small modules",
        [{"id": "T1", "title": "stats"}, {"id": "T2", "title": "top words", "depends_on": ["T1"]}],
    )
    message = PLAN_045 + (":" + "".join(f"\n- {q}" for q in QUESTIONS) if listed else "")
    fake.plan_checks["two-modules"] = {
        "valid": False,
        "errors": [f"PLAN_045: {message}"],
        "warnings": [],
        "diagnostics": [{"severity": "error", "rule_id": "PLAN_045", "task_id": "T2", "message": message}],
    }
    fake.plan_sources["two-modules"] = (
        '[meta]\nplan = "two-modules"\n\n[[task]]\nid = "T1"\ntitle = "stats"\n\n[[task]]\nid = "T2"\n'
        'title = "top words"\nopen_questions = [\n' + "".join(f'    "{q}",\n' for q in QUESTIONS) + "]\n"
    )


def test_a_plan_roko_will_not_run_says_rokos_reasons_and_its_open_questions(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    refuse_the_plan(fake)
    with pytest.raises(tools.PlanInvalid) as refused:
        call(rt, "roko_plan_run", {"plan_id": "two-modules", "max_usd": 0.5})
    error = refused.value
    assert "roko will not run plan two-modules: PLAN_045: task 'T2' has open questions" in error.message
    assert (
        "(1) When n > number of unique words" in error.message and "(suggested: return only" in error.message
    )
    assert error.validation is not None
    assert error.validation["errors"] == [{"rule": "PLAN_045", "task_id": "T2", "message": PLAN_045}]
    first = error.validation["open_questions"][0]
    assert first["task_id"] == "T2" and first["question"].endswith("or raise?")
    assert first["assumption"] == "return only as many as exist."
    assert error.hint is not None and "open_questions" in error.hint  # the person's step
    answer = error.as_dict()
    assert answer["validation"] == error.validation and "do not edit the plan" in str(answer["hint"])
    # The page's Run plan: the refusal and what the plan card shows.
    body = ui_api.guarded(lambda: rt, lambda r: ui_api.start_plan(r, "two-modules", {"max_usd": 0.5}))
    assert body["ok"] is False and "PLAN_045" in body["error"]["message"]
    assert body["validation"]["open_questions"] == error.validation["open_questions"]
    detail = call(rt, "roko_plans", {"plan_id": "two-modules"})
    assert detail["validation"]["summary"].startswith("PLAN_045: task 'T2' has open questions")
    t1, t2 = detail["tasks"]
    assert "open_questions" not in t1 and [q["question"] for q in t2["open_questions"]] == [
        q["question"] for q in error.validation["open_questions"]
    ]
    assert not [r for r in rt.runs.recent(5) if r.get("plan_id") == "two-modules"]  # nothing ran


def test_an_older_rokos_open_questions_are_read_from_the_plans_source(rt: Runtime, fake: FakeRoko) -> None:
    refuse_the_plan(fake, listed=False)
    # roko checks the plan in a temporary copy, whose path its words can name.
    copy = "/var/folders/bn/x/T/.tmpCg1yIi/two-modules"
    missing = f"task 'T1' [task.accept] src `accept/test_stats.py` is missing from {copy}"
    fake.plan_checks["two-modules"]["diagnostics"].insert(
        0, {"severity": "error", "rule_id": "PLAN_038", "task_id": "T1", "message": missing}
    )
    found = rundata.plan_validation(rt.client(), "two-modules")
    assert found is not None
    assert found["errors"][0]["message"].endswith("is missing from the plan's folder")
    assert [q["question"] for q in found["open_questions"]] == [q.split(" Assumption:")[0] for q in QUESTIONS]
    # A valid plan has nothing to say.
    fake.add_plan("fine", "Fine", [{"id": "T1"}])
    assert rundata.plan_validation(rt.client(), "fine") is None


def no_validation(rt: Runtime, monkeypatch: pytest.MonkeyPatch) -> None:
    """roko cannot say now why a plan cannot run: its validate route is gone (or the plan is)."""
    client = rt.client()
    original = client.post

    def no_validate(path: str, body: dict[str, Any], **kwargs: Any) -> Any:
        if path.endswith("/validate"):
            raise RokoError(Code.NOT_FOUND, "No API route matches POST")
        return original(path, body, **kwargs)

    monkeypatch.setattr(client, "post", no_validate)


def test_a_refusal_that_lists_its_errors_says_them_without_the_validator(
    rt: Runtime, fake: FakeRoko, approvals: Approvals, monkeypatch: pytest.MonkeyPatch
) -> None:
    # roko since bug-7a08a8 lists each error in its refusal: the reasons are there even without its validator.
    refuse_the_plan(fake)
    no_validation(rt, monkeypatch)
    with pytest.raises(tools.PlanInvalid) as refused:
        call(rt, "roko_plan_run", {"plan_id": "two-modules", "max_usd": 0.5})
    found = refused.value.validation
    assert found is not None and found["errors"] == [
        {"rule": "PLAN_045", "task_id": "T2", "message": PLAN_045}
    ]
    assert [q["task_id"] for q in found["open_questions"]] == ["T2", "T2"]
    assert found["open_questions"][1]["assumption"] == "simple .lower().split()."
    assert refused.value.message.startswith("roko will not run plan two-modules: PLAN_045:")


def test_an_older_roko_that_cannot_validate_still_says_its_own_refusal(
    rt: Runtime, fake: FakeRoko, approvals: Approvals, monkeypatch: pytest.MonkeyPatch
) -> None:
    refuse_the_plan(fake)
    fake.refusal_lists_errors = False  # it names only how many errors
    no_validation(rt, monkeypatch)
    with pytest.raises(tools.PlanInvalid) as refused:
        call(rt, "roko_plan_run", {"plan_id": "two-modules", "max_usd": 0.5})
    assert refused.value.message.startswith("plan 'two-modules' failed validation with 1 error(s)")
    assert refused.value.validation is None and "roko plan validate" in str(refused.value.hint)


class PlannerRoko(FakeRoko):
    """roko since bug-7a08a8: a plan generation whose plan cannot run fails, with the plan written anyway;
    and since bug-a0432b a completed one says what writing the plan cost (`writing_costs`)."""

    failed_generations: dict[str, str]
    writing_costs: dict[str, float]

    def __post_init__(self) -> None:
        super().__post_init__()
        self.failed_generations = {}
        self.writing_costs = {}

    def _tool_run_status(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        answer = super()._tool_run_status(args, who)
        run_id = str(args.get("run_id"))
        error = self.failed_generations.get(run_id)
        body = dict(answer.get("structuredContent") or {})
        if error is None and run_id in self.writing_costs and isinstance(body.get("result"), dict):
            return tool_ok({**body, "result": {**body["result"], "cost_usd": self.writing_costs[run_id]}})
        if error is None:
            return answer
        body = {**answer["structuredContent"], "state": "failed", "active": False, "result": None}
        return tool_ok({**body, "error": error})


def written_but_invalid(slug: str) -> str:
    """roko's error for a generation that wrote plan `slug`, which cannot run (bug-7a08a8)."""
    return (
        f"plan generation failed for {slug}: the plan was written to plans/{slug}, but it cannot run: 1 error(s)\n"
        f"- PLAN_045 {PLAN_045.replace('T2', 'T1')}:\n"
        f"  - {QUESTIONS[0]}"
    )


@pytest.fixture
def planner() -> Iterator[PlannerRoko]:
    server = PlannerRoko().start()
    try:
        yield server
    finally:
        server.stop()


def test_a_plan_generation_that_wrote_a_plan_roko_will_not_run_says_why(
    planner: PlannerRoko, approvals: Approvals, monkeypatch: pytest.MonkeyPatch
) -> None:
    rt = runtime_for(planner)
    try:
        started = call(rt, "roko_plan_generate", {"prompt": "Add two small modules to wordy"})
        run_id, slug = started["run_id"], started["plan_id"]
        planner.failed_generations[run_id] = written_but_invalid(slug)
        planner.plan_checks[slug] = {
            "valid": False,
            "errors": [f"PLAN_045: {PLAN_045}"],
            "warnings": [],
            "diagnostics": [
                {
                    "severity": "error",
                    "rule_id": "PLAN_045",
                    "task_id": "T1",
                    "message": PLAN_045.replace("T2", "T1") + ":\n- " + QUESTIONS[0],
                }
            ],
        }
        card = views.card(rt, run_id)
        assert card["state"] == "failed" and card["plan_id"] == slug
        assert card["validation"]["open_questions"][0]["task_id"] == "T1"
        assert card["why"]["summary"].startswith("roko wrote the plan, but it cannot run yet: PLAN_045:")
        assert card["next"]["label"] == "answer the plan's open questions"
        assert card["headline"] == f"failed · plan {slug} · cannot run yet"
        status = call(rt, "roko_status", {"run_id": run_id})
        assert status["validation"] == card["validation"]
        assert status["next"].startswith(f"roko wrote the plan (roko_plans(plan_id={slug}) shows it)")
        # roko cannot say now (its validate route is gone): its words at the time say why.
        rt.cards._validations.clear()
        no_validation(rt, monkeypatch)
        again = views.card(rt, run_id)
        assert again["validation"]["errors"][0]["rule"] == "PLAN_045"
        assert again["validation"]["open_questions"][0]["question"].endswith("or raise?")
    finally:
        rt.close()


def test_a_plan_generation_that_wrote_no_plan_still_reads_as_the_planners_failure(
    planner: PlannerRoko, approvals: Approvals
) -> None:
    rt = runtime_for(planner)
    try:
        started = call(rt, "roko_plan_generate", {"prompt": "Add csv import"})
        run_id, slug = started["run_id"], started["plan_id"]
        planner.failed_generations[run_id] = f"plan generation failed for {slug}: the planner timed out"
        del planner.plans[slug]  # nothing was written
        card = views.card(rt, run_id)
        assert (
            card["state"] == "failed" and card["validation"] is None and "timed out" in card["planner_error"]
        )
        assert "cannot run yet" not in card["headline"]
        assert call(rt, "roko_status", {"run_id": run_id})["next"].startswith(
            "The planner did not produce a plan"
        )
    finally:
        rt.close()


def test_what_writing_a_plan_cost_is_on_its_card_and_in_the_days_spend(
    planner: PlannerRoko, approvals: Approvals
) -> None:
    rt = runtime_for(planner)
    try:
        planner.run_script = ["succeeded"]
        written = call(rt, "roko_plan_generate", {"prompt": "Add csv import"})["run_id"]
        planner.writing_costs[written] = 0.01152
        card = views.card(rt, written)
        assert card["cost_usd"] == 0.01152 and card["headline"].endswith("· $0.01")
        # A plan written that cannot run: roko's last line says what writing it cost.
        failed = call(rt, "roko_plan_generate", {"prompt": "Add two small modules to wordy"})
        planner.failed_generations[failed["run_id"]] = (
            written_but_invalid(failed["plan_id"]) + "\nWriting the plan cost $0.0115."
        )
        assert views.card(rt, failed["run_id"])["cost_usd"] == 0.0115
        # Hermes' spend for the day counts both.
        assert ledger.spend(rt.runs.recent(), None)["today_usd"] == round(0.01152 + 0.0115, 4)
        # An older roko says no cost: none is counted.
        older = call(rt, "roko_plan_generate", {"prompt": "Add a flag"})["run_id"]
        assert views.card(rt, older)["cost_usd"] is None
        assert ledger.spend(rt.runs.recent(), None)["today_usd"] == round(0.01152 + 0.0115, 4)
    finally:
        rt.close()


def test_a_plan_writing_with_no_tool_loop_model_names_the_setup_problem(
    planner: PlannerRoko, approvals: Approvals
) -> None:
    rt = runtime_for(planner)
    try:
        views.ui_overview(rt)  # the page's look of the setup, which a refusal adds to
        started = call(rt, "roko_plan_generate", {"prompt": "Add csv import"})
        planner.failed_generations[started["run_id"]] = (
            f"plan generation failed for {started['plan_id']}: no model can write the plan for a chat host's "
            "request: a run from a chat host needs a model that runs in roko's own tool loop with its key set, "
            "and this workspace has none: rung cheap: gpt-oss-120b has no key. To fix it, put OPENAI_API_KEY "
            "in ~/.roko/.env and restart roko serve, which reads that file when it starts"
        )
        card = views.card(rt, started["run_id"])
        assert card["state"] == "failed" and card["problem"]["id"] == readiness.NO_TOOL_LOOP_MODEL
        assert card["cost_usd"] is None  # no call was made
        problems = views.ui_overview(rt)["setup"]["problems"]
        assert readiness.NO_TOOL_LOOP_MODEL in [problem["id"] for problem in problems]
    finally:
        rt.close()


def test_rokos_listed_errors_are_read_from_a_refusal_and_a_failed_generation() -> None:
    refusal = (
        "plan 'p' failed validation with 2 error(s); fix them before running it\n"
        "- PLAN_038: task 'T1' [task.accept] src `a.py` is missing from /var/folders/x/T/.tmpAb12Cd/p\n"
        f"- PLAN_045: {PLAN_045}:\n  - {QUESTIONS[0]}\n  - {QUESTIONS[1]}"
    )
    found = rundata.validation_from_text(refusal)
    assert found is not None
    assert [(e["rule"], e["task_id"]) for e in found["errors"]] == [("PLAN_038", "T1"), ("PLAN_045", "T2")]
    assert found["errors"][0]["message"].endswith("is missing from the plan's folder")
    assert [q["task_id"] for q in found["open_questions"]] == ["T2", "T2"]
    generation = rundata.validation_from_text(written_but_invalid("p"))
    assert generation is not None and generation["errors"][0]["rule"] == "PLAN_045"
    assert generation["open_questions"][0]["task_id"] == "T1"
    # An older roko names only the count.
    assert rundata.validation_from_text("plan 'p' failed validation with 1 error(s); fix them") is None


def test_a_plan_the_planner_wrote_that_cannot_run_says_so_on_its_card(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["succeeded"]
    started = call(rt, "roko_plan_generate", {"prompt": "Add two small modules to wordy"})
    plan_id = started["plan_id"]
    fake.plan_checks[plan_id] = {
        "valid": False,
        "errors": [f"PLAN_045: {PLAN_045}"],
        "warnings": [],
        "diagnostics": [
            {
                "severity": "error",
                "rule_id": "PLAN_045",
                "task_id": "T1",
                "message": PLAN_045.replace("T2", "T1") + ":\n- " + QUESTIONS[0],
            }
        ],
    }
    card = views.card(rt, started["run_id"])
    assert card["state"] == "succeeded" and card["validation"]["open_questions"][0]["task_id"] == "T1"
    assert card["why"]["summary"].startswith("roko wrote the plan, but it cannot run yet: PLAN_045:")
    assert card["next"]["label"] == "answer the plan's open questions"
    assert card["headline"].endswith("cannot run yet")


def test_a_queued_run_whose_plan_failed_validation_says_what_roko_found(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    refuse_the_plan(fake)
    check = fake.plan_checks.pop("two-modules")  # valid when it was queued
    run_id = call(rt, "roko_plan_run", {"plan_id": "two-modules", "max_usd": 0.5})["run_id"]
    fake.plan_checks["two-modules"] = check  # not when its turn came
    run = fake.runs[run_id]
    run.states, run.events = ["failed"], []
    fake.run_errors[run_id] = (
        "plan execution failed for two-modules: its plans failed validation with 1 error(s) while it was queued"
    )
    why = views.card(rt, run_id)["why"]
    assert why["start_error"] == "its plans failed validation with 1 error(s) while it was queued"
    assert why["validation"]["errors"][0]["rule"] == "PLAN_045"
    assert "roko's check of the plan says: PLAN_045: task 'T2' has open questions" in why["summary"]


# -- dogfood-desktop P5: the card draws the plan's own tasks and waves ------------------------------

FOUR = [
    {"id": "T1", "title": "Add stats"},
    {"id": "T2", "title": "Add top words", "depends_on": ["T1"]},
    {"id": "T3", "title": "Add CLI options", "depends_on": ["T1"]},
    {"id": "T4", "title": "Document them", "depends_on": ["T2", "T3"]},
]


def test_the_card_draws_the_plans_tasks_and_waves_from_the_start(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("four", "Four tasks", FOUR)
    fake.run_script = ["running"]
    run_id = call(rt, "roko_plan_run", {"plan_id": "four", "max_usd": 0.5})["run_id"]
    run = fake.runs[run_id]
    manifest = run.bundle()
    manifest["manifest"]["plan_ids"] = []  # the run's manifest names no plan yet
    run.bundle = lambda: manifest  # type: ignore[method-assign]
    run.events = [
        {"type": "task_started", "plan_id": "four", "task_id": "T1", "title": "Add stats", "ts_millis": 1000},
    ]
    card = views.card(rt, run_id)
    assert card["progress"]["total"] == 4 and [t["task_id"] for t in card["tasks"]] == [
        "T1",
        "T2",
        "T3",
        "T4",
    ]
    assert card["graph"]["waves"] == [["T1"], ["T2", "T3"], ["T4"]]
    # A re-run that skips T1 (it passed before): its pad keeps the task's title.
    again = call(rt, "roko_plan_run", {"plan_id": "four", "max_usd": 0.5})["run_id"]
    fake.runs[again].events = [
        {
            "type": "task_completed",
            "plan_id": "four",
            "task_id": "T1",
            "outcome": "passed",
            "ts_millis": 2000,
        },
        {
            "type": "task_started",
            "plan_id": "four",
            "task_id": "T2",
            "title": "Add top words",
            "ts_millis": 2001,
        },
    ]
    skipped = views.card(rt, again)
    assert skipped["progress"]["total"] == 4 and skipped["tasks"][0]["title"] == "Add stats"


# -- dogfood-desktop P7: a check that passed on its retry is not a failure ----------------------------


def test_checks_count_each_tasks_final_attempt_and_say_how_many_were_retried(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "Add a flag.", "max_usd": 0.5})["run_id"]

    def attempt(n: int, gate: str, passed: bool) -> list[dict[str, Any]]:
        return [
            {
                "type": "agent_spawned",
                "plan_id": "p",
                "task_id": "T1",
                "attempt": n,
                "model": "m",
                "ts_millis": n,
            },
            {
                "type": "gate_result",
                "plan_id": "p",
                "task_id": "T1",
                "gate": gate,
                "passed": passed,
                "ts_millis": n,
            },
        ]

    fake.runs[run_id].events = [
        {"type": "task_started", "plan_id": "p", "task_id": "T1", "title": "Add a flag", "ts_millis": 1},
        *attempt(1, "pre_verify:no_changes", False),
        *attempt(2, "verify[0:test]", True),
        {"type": "task_completed", "plan_id": "p", "task_id": "T1", "outcome": "passed", "ts_millis": 9},
    ]
    card = views.card(rt, run_id)
    assert card["gates"] == {"passed": 1, "failed": 0, "total": 1, "retried": 1}
    assert card["headline"].startswith("succeeded · checks 1/1")
    gates = {gate["gate"]: gate for gate in card["tasks"][0]["gates"]}
    assert (
        gates["pre_verify:no_changes"]["superseded"] is True
        and gates["verify[0:test]"]["superseded"] is False
    )
    assert call(rt, "roko_status", {"run_id": run_id})["gates"]["retried"] == 1


# -- dogfood-desktop: the token line counts cache reads ----------------------------------------------


def test_the_watch_token_line_counts_cache_reads() -> None:
    from hermes_plugin_roko import live

    tokens = {"input": 47484, "output": 17402, "cache_read": 411392}
    watch = live.Watch(
        "run-1", 2.0, card={"state": "succeeded", "cost_usd": 0.17, "max_usd": 0.5, "tokens": tokens}
    )
    assert "tokens 47.5k in · 17.4k out · 411.4k cached" in live.money_line(watch, time.time(), 140).plain


# -- a check a stop request ended reads stopped, not failed (roko 2359ba4ec) ----------------------------


def stopped_step(**changes: Any) -> dict[str, Any]:
    """roko's PlanCheckFinished for a regression check step a cancel stopped (CheckStep::stopped): passed false,
    no exit code, the reason "<cause> stopped it" and `stopped_by` the interrupt's label."""
    return {
        "type": "plan_check_finished",
        "plan_id": "speed",
        "stage": "regression",
        "step": 3,
        "steps": 3,
        "name": "cargo test",
        "scope": "packages",
        "packages": ["speed-test"],
        "passed": False,
        "reason": "a cancel request stopped it",
        "stopped_by": "cancel",
        "elapsed_ms": 62_000,
        "ts_millis": 5_000,
        **changes,
    }


def test_a_check_a_cancel_stopped_reads_stopped_not_failed() -> None:
    line = rundata.timeline_entry(9, "plan_check_finished", stopped_step())
    assert line is not None
    assert line["text"] == "speed-test: cargo test stopped by a cancel request after 1m02s"
    assert line["passed"] is None and line["stopped_by"] == "cancel"
    # A stop roko names only by its label: its words for it.
    sigint = rundata.timeline_entry(9, "plan_check_finished", stopped_step(reason=None, stopped_by="SIGINT"))
    assert sigint is not None and sigint["text"].startswith(
        "speed-test: cargo test stopped by an interrupt (SIGINT)"
    )
    # An older roko names no stop: the check reads as before.
    older = rundata.timeline_entry(9, "plan_check_finished", stopped_step(stopped_by=None))
    assert older is not None and older["passed"] is False
    assert older["text"] == "speed-test: cargo test did not pass in 1m02s: a cancel request stopped it"


def test_a_cancelled_runs_why_says_its_check_was_stopped(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("speed", "Speed test", [{"id": "T1", "title": "Speed it up"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "speed", "max_usd": 0.5})["run_id"]
    run = fake.runs[run_id]
    started = {
        key: value for key, value in stopped_step().items() if key not in ("passed", "reason", "stopped_by")
    }
    run.states = ["cancelled"]
    run.events = [
        {
            "type": "task_started",
            "plan_id": "speed",
            "task_id": "T1",
            "title": "Speed it up",
            "ts_millis": 1_000,
        },
        {
            "type": "task_completed",
            "plan_id": "speed",
            "task_id": "T1",
            "outcome": "passed",
            "ts_millis": 2_000,
        },
        {**started, "type": "plan_check_started", "command": "cargo test -p speed-test", "ts_millis": 3_000},
        stopped_step(),
        {"type": "run_completed", "outcome": "cancelled", "ts_millis": 6_000},
    ]
    card = views.card(rt, run_id)
    assert card["state"] == "cancelled"
    assert (
        "The plan's check cargo test was stopped by a cancel request; it did not fail."
        in card["why"]["summary"]
    )
    assert "did not pass" not in card["why"]["summary"]
    # The page's timeline says the same.
    texts = [entry.get("text") for entry in ui_api.timeline(rt, run_id, {})["events"]]
    assert "speed-test: cargo test stopped by a cancel request after 1m02s" in texts


def test_a_delivery_a_cancel_stopped_keeps_its_work_as_stopped_not_partial(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    # roko 2359ba4ec: a cancel during the delivery's regression check cancels the delivery and takes its merge back
    # out of the batch; the plan's verified commits stay on its branch.
    fake.add_plan("speed", "Speed test", [{"id": "T1", "title": "Speed it up"}])
    run_id = call(wrt, "roko_plan_run", {"plan_id": "speed", "max_usd": 0.5})["run_id"]
    batch_at_base(repo, run_id)
    passed = accept(repo, "speed", run_id, "T1", "passed", "lib.py", "a = 2\n")
    run = fake.runs[run_id]
    run.states = ["cancelled"]
    run.events = [
        {
            "type": "task_started",
            "plan_id": "speed",
            "task_id": "T1",
            "title": "Speed it up",
            "ts_millis": 1_000,
        },
        {
            "type": "task_completed",
            "plan_id": "speed",
            "task_id": "T1",
            "outcome": "passed",
            "ts_millis": 2_000,
        },
        stopped_step(),
        {"type": "run_completed", "outcome": "cancelled", "ts_millis": 6_000},
    ]
    card = views.card(wrt, run_id)
    [part] = card["work"]["parts"]
    assert part["trust"] == "verified" and part["commit"] == passed[:12] and part["delivered"] is False
    assert part["checks_finished"] is False and part["stopped"] == "a cancel request"
    assert card["merge"]["confirm"] == (
        "Each task passed its own check (Task 1), but a cancel request stopped roko's check of the merged work "
        "before it ended. Merge it anyway?"
    )
    assert card["next"]["why"] == "a cancel request stopped roko's check of the merged work"
    assert "did not pass" not in card["why"]["summary"] and "fail" not in card["headline"]


# -- a plan's delivery into the batch, as roko publishes it (gap-4f6cbe) --------------------------------


def delivered(state: str, **changes: Any) -> dict[str, Any]:
    """roko's DeliveryFinished (gap-4f6cbe) for plan `speed` of run `run-1`, as the run index holds it."""
    return {
        "type": "delivery_finished",
        "plan_id": "speed",
        "delivery_id": "run-1:speed",
        "target": "roko/batch/run-1",
        "state": state,
        "ts_millis": 7_000,
        **changes,
    }


def test_each_way_a_delivery_ends_reads_as_roko_means_it() -> None:
    started = {
        "type": "delivery_started",
        "plan_id": "speed",
        "delivery_id": "run-1:speed",
        "target": "roko/batch/run-1",
        "branch": "roko/plan/speed",
        "commit": "abc123",
        "ts_millis": 6_000,
    }
    lines = {
        "started": rundata.timeline_entry(1, "delivery_started", started),
        "delivered": rundata.timeline_entry(
            2, "delivery_finished", delivered("delivered", merge_commit="def456")
        ),
        "conflict": rundata.timeline_entry(
            3, "delivery_finished", delivered("conflict", reason="merge failed")
        ),
        "regression": rundata.timeline_entry(
            4, "delivery_finished", delivered("regression_failed", reason="x")
        ),
        "cancelled": rundata.timeline_entry(
            5,
            "delivery_finished",
            delivered("cancelled", stopped_by="cancel", reason="… a cancel request stopped it"),
        ),
        "terminal": rundata.timeline_entry(
            6, "delivery_finished", delivered("terminal_failed", reason="publish failed")
        ),
    }
    texts = {name: line["text"] for name, line in lines.items() if line is not None}
    assert texts == {
        "started": "delivering plan speed into roko/batch/run-1",
        "delivered": "plan speed delivered into roko/batch/run-1",
        "conflict": "plan speed was not delivered: its merge into roko/batch/run-1 conflicted",
        "regression": "plan speed was not delivered: the check on its merge failed",
        "cancelled": "plan speed: its delivery was stopped by a cancel request",
        "terminal": "plan speed was not delivered: publish failed",
    }
    assert lines["cancelled"] is not None and lines["cancelled"]["group"] == "run"  # a stop, not an error
    assert lines["conflict"] is not None and lines["conflict"]["group"] == "error"
    partial = rundata.timeline_entry(
        7, "delivery_finished", delivered("delivered", delivery_id="run-1:speed:partial")
    )
    assert partial is not None and partial["text"].startswith("the passed part of plan speed delivered")


# A cancel during a real run's regression check (plugin-runs, 2026-10-16, roko serve built with gap-4f6cbe and
# 2359ba4ec, plan slow-check): the run index's rows as roko wrote them, the run's id shortened.
CANCELLED_DELIVERY_ROWS = [
    {
        "type": "delivery_started",
        "event": {
            "branch": "roko/plan/slow-check",
            "commit": "4b9162d7a53a58e9c4b1722d7ff11f1a5c8bb321",
            "delivery_id": "run-1:slow-check",
            "plan_id": "slow-check",
            "run_id": "run-1",
            "target": "roko/batch/run-1",
            "ts_millis": 1792150484629,
            "type": "delivery_started",
        },
    },
    {
        "type": "plan_check_started",
        "event": {
            "command": 'sleep 45 && test -f notes/hello.txt && grep -q "hello from roko" notes/hello.txt',
            "name": "sleep",
            "plan_id": "slow-check",
            "run_id": "run-1",
            "scope": "command",
            "source": "authored",
            "stage": "regression",
            "step": 1,
            "steps": 1,
            "ts_millis": 1792150484950,
            "type": "plan_check_started",
        },
    },
    {
        "type": "plan_check_finished",
        "event": {
            "elapsed_ms": 14307,
            "name": "sleep",
            "passed": False,
            "plan_id": "slow-check",
            "reason": "a cancel request stopped it",
            "run_id": "run-1",
            "scope": "command",
            "stage": "regression",
            "step": 1,
            "steps": 1,
            "stopped_by": "cancel",
            "ts_millis": 1792150499257,
            "type": "plan_check_finished",
        },
    },
    {
        "type": "delivery_finished",
        "event": {
            "delivery_id": "run-1:slow-check",
            "merge_commit": "4b9162d7a53a58e9c4b1722d7ff11f1a5c8bb321",
            "plan_id": "slow-check",
            "reason": "post-merge regression stopped for slow-check: `sleep 45 && test -f notes/hello.txt && grep -q "
            '"hello from roko" notes/hello.txt`: a cancel request stopped it',
            "run_id": "run-1",
            "state": "cancelled",
            "stopped_by": "cancel",
            "target": "roko/batch/run-1",
            "ts_millis": 1792150499258,
            "type": "delivery_finished",
        },
    },
]


def test_a_real_cancel_during_the_regression_check_reads_as_a_stop() -> None:
    fold = rundata.EventFold()
    for cursor, row in enumerate(CANCELLED_DELIVERY_ROWS, 1):
        fold.feed(cursor, rundata.row_kind(row), row["event"])
    assert [line["text"] for line in fold.timeline] == [
        "delivering plan slow-check into roko/batch/run-1",
        "checking the plan: sleep",
        "the plan: sleep stopped by a cancel request after 14s",
        "plan slow-check: its delivery was stopped by a cancel request",
    ]
    assert [line.get("passed") for line in fold.timeline] == [None, None, None, None]
    assert fold.plan_checks[0]["stopped"] == "a cancel request"
    [delivery] = fold.deliveries.values()
    assert delivery["state"] == "cancelled" and delivery["stopped"] == "a cancel request"


def test_a_cancelled_delivery_reads_as_a_stop_on_the_card(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    # A newer roko says the delivery was cancelled even when no check event says what was cut short.
    fake.add_plan("speed", "Speed test", [{"id": "T1", "title": "Speed it up"}])
    run_id = call(wrt, "roko_plan_run", {"plan_id": "speed", "max_usd": 0.5})["run_id"]
    batch_at_base(repo, run_id)
    accept(repo, "speed", run_id, "T1", "passed", "lib.py", "a = 2\n")
    run = fake.runs[run_id]
    run.states = ["cancelled"]
    run.events = [
        {
            "type": "task_started",
            "plan_id": "speed",
            "task_id": "T1",
            "title": "Speed it up",
            "ts_millis": 1_000,
        },
        {
            "type": "task_completed",
            "plan_id": "speed",
            "task_id": "T1",
            "outcome": "passed",
            "ts_millis": 2_000,
        },
        delivered(
            "cancelled",
            stopped_by="cancel",
            reason="post-merge regression stopped for speed: a cancel request stopped it",
            target=f"roko/batch/{run_id}",
            delivery_id=f"{run_id}:speed",
        ),
        {"type": "run_completed", "outcome": "cancelled", "ts_millis": 8_000},
    ]
    card = views.card(wrt, run_id)
    assert card["deliveries"] == [
        {
            "plan_id": "speed",
            "partial": False,
            "state": "cancelled",
            "target": f"roko/batch/{run_id}",
            "reason": "post-merge regression stopped for speed: a cancel request stopped it",
            "stopped": "a cancel request",
        }
    ]
    [part] = card["work"]["parts"]
    assert part["stopped"] == "a cancel request" and part["checks_finished"] is False
    assert "Plan speed's delivery was stopped by a cancel request; it did not fail." in card["why"]["summary"]


def test_a_delivery_that_failed_says_why_once(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.add_plan("speed", "Speed test", [{"id": "T1", "title": "Speed it up"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "speed", "max_usd": 0.5})["run_id"]
    run = fake.runs[run_id]
    run.states = ["failed"]
    passed = [
        {
            "type": "task_started",
            "plan_id": "speed",
            "task_id": "T1",
            "title": "Speed it up",
            "ts_millis": 1_000,
        },
        {
            "type": "task_completed",
            "plan_id": "speed",
            "task_id": "T1",
            "outcome": "passed",
            "ts_millis": 2_000,
        },
    ]
    run.events = [*passed, delivered("conflict", reason="merge conflict in lib.py")]
    why = views.card(rt, run_id)["why"]["summary"]
    assert "Plan speed was not delivered: its merge into roko/batch/run-1 conflicted." in why
    # A check on the merge that failed is said by its check line, not again by the delivery.
    rt.cards._trackers.clear()
    check = stopped_step(passed=False, reason=None, stopped_by=None, exit_code=101)
    run.events = [*passed, check, delivered("regression_failed", reason="the check failed")]
    why = views.card(rt, run_id)["why"]["summary"]
    assert "The plan's check cargo test did not pass" in why and "was not delivered" not in why


def test_the_plan_check_that_counts_is_its_last_run(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """hermes-pilot, phase 6 (roko run 23837ede, its third invocation): check.sh exited 8, roko sent a task back,
    and the check's second run passed before the delivery. The run's page said "The plan's check check.sh did not
    pass", the first run's verdict; the last run's is the plan's."""
    fake.add_plan("speed", "Speed test", [{"id": "T1", "title": "Speed it up"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "speed", "max_usd": 0.5})["run_id"]
    run = fake.runs[run_id]
    run.states = ["unverified"]
    step = {
        "plan_id": "speed",
        "stage": "regression",
        "step": 1,
        "steps": 1,
        "name": "check.sh",
        "scope": "command",
    }
    task = {"plan_id": "speed", "task_id": "T1", "title": "Speed it up"}
    run.events = [
        {**task, "type": "task_started", "ts_millis": 1_000},
        {**task, "type": "task_completed", "outcome": "passed", "ts_millis": 2_000},
        {**step, "type": "plan_check_started", "ts_millis": 3_000},
        {
            **step,
            "type": "plan_check_finished",
            "passed": False,
            "exit_code": 8,
            "elapsed_ms": 248_588,
            "ts_millis": 4_000,
        },
        {**task, "type": "task_started", "ts_millis": 5_000},
        {**task, "type": "task_completed", "outcome": "unverified", "ts_millis": 6_000},
        {**step, "type": "plan_check_started", "ts_millis": 7_000},
        {
            **step,
            "type": "plan_check_finished",
            "passed": True,
            "exit_code": 0,
            "elapsed_ms": 78_725,
            "ts_millis": 8_000,
        },
        delivered("delivered", ts_millis=9_000),
        {"type": "run_completed", "outcome": "succeeded", "ts_millis": 10_000},
    ]
    why = views.card(rt, run_id)["why"]["summary"]
    assert "check.sh did not pass" not in why
    assert "The plan's check check.sh passed the last time it ran (it ran 2 times)." in why
    # The other way round, the last run is the one the page tells.
    rt.cards._trackers.clear()
    run.events = [*run.events[:3], run.events[7], *run.events[4:7], run.events[3], *run.events[8:]]
    why = views.card(rt, run_id)["why"]["summary"]
    assert "The plan's check check.sh did not pass the last time it ran (it ran 2 times)." in why
    assert "check.sh passed" not in why


# -- the plan's title from its task list (roko bug-e0624e) ---------------------------------------------


def test_a_plans_title_comes_from_its_task_list_with_the_row_for_an_older_roko(
    rt: Runtime, fake: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake.add_plan("p1", "P one", [{"id": "T1"}])
    client = rt.client()
    original = client.get
    seen: list[str] = []

    def answer(path: str, params: Any = None, **kwargs: Any) -> Any:
        seen.append(path)
        return original(path, params, **kwargs)

    monkeypatch.setattr(client, "get", answer)
    # roko since bug-e0624e: `/tasks` titles the plan as the listing does; the label needs no other call.
    assert tools.plan_title(client, "p1") == "P one" and seen == ["/api/plans/p1/tasks"]
    assert tools.plan_detail(client, "p1", estimate=False)["title"] == "P one"

    def older(path: str, params: Any = None, **kwargs: Any) -> Any:
        body = original(path, params, **kwargs)
        return {**body, "title": "p1"} if path.endswith("/tasks") else body  # it gave the plan's id there

    monkeypatch.setattr(client, "get", older)
    assert tools.plan_title(client, "p1") == "P one"
    assert tools.plan_detail(client, "p1", estimate=False)["title"] == "P one"


# -- R5: why a run did not start -----------------------------------------------------------------


def test_a_spec_gate_refusal_is_why_and_makes_no_phantom_task() -> None:
    events = rows(
        {"type": "plan_set_loaded", "plans": [{"plan_id": "p", "title": "P", "tasks_total": 1}]},
        {
            "type": "event_log_entry",
            "event_type": "spec.gate.refused",
            "plan_id": "plans/p/tasks.toml",
            "task_id": "T1",
            "message": "HF3: verify passes on the unchanged base",
        },
        {"type": "run_completed", "outcome": "failed"},
    )
    tracker = tracker_with(events)
    assert list(tracker.fold.tasks) == []  # no task row keyed by the tasks.toml path
    assert tracker.fold.refusals == ["T1: HF3: verify passes on the unchanged base"]
    cache = rundata.CardCache()
    cache._trackers[("u", "r1")] = tracker
    why = rundata.explain(cache, "u", {"run_id": "r1", "state": "failed"})
    assert why["summary"] == (
        "roko's spec check refused the plan before any agent ran: T1: HF3: verify passes on the unchanged base."
    )
    assert why["refusals"] == ["T1: HF3: verify passes on the unchanged base"]
    line = rundata.timeline_entry(2, "event_log_entry", events[1]["event"])
    assert line is not None and line["group"] == "error"
    assert line["text"] == "Task 1 was refused before it ran: HF3: verify passes on the unchanged base"


def test_a_start_refusal_roko_records_under_the_runs_id_is_why_on_its_card(
    rt: Runtime, fake: FakeRoko, approvals: Approvals, monkeypatch: pytest.MonkeyPatch
) -> None:
    # roko since bug-9a5970 (roko-recovery's capture B): the summary's `refused`, and the run's own events.
    fake.add_plan("crash-demo", "Crash demo", [{"id": "T1"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "crash-demo", "max_usd": 0.25})["run_id"]
    reason = "A roko plan runner is already active in this workspace (PID 29056)."
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [
        {
            "type": "error",
            "message": f"plan execution failed for crash-demo: {reason}\n  hint: wait for it to finish, or kill "
            "it with `kill 29056`",
            "ts_millis": 1_000,
        },
        {
            "type": "run_completed",
            "outcome": "refused",
            "stage": "start",
            "reason": reason,
            "ts_millis": 1_001,
        },
    ]
    say_refused(fake, monkeypatch, run_id, {"stage": "start", "reason": reason})
    card = views.card(rt, run_id)
    why = card["why"]
    assert why["start_error"] == reason and why["errors"] == []  # no "kill" advice anywhere
    assert why["summary"].startswith(f"roko did not start the run: {reason}")
    assert card["next"]["label"] == "read why roko did not start it"
    texts = [entry["text"] for entry in ui_api.timeline(rt, run_id, {})["events"]]
    assert texts == [f"error: plan execution failed for crash-demo: {reason}", f"run refused: {reason}"]
    # roko said why: its plan status (an older roko's only word) is not asked.
    assert not [r for r in fake.requests if str(r.get("path", "")).endswith("/status")]


def test_a_spec_gate_refusal_roko_records_reads_once_as_the_gates(
    rt: Runtime, fake: FakeRoko, approvals: Approvals, monkeypatch: pytest.MonkeyPatch
) -> None:
    # roko since bug-9a5970 (roko-recovery's capture A): the gate's entry, then an error that repeats it.
    fake.add_plan("gated", "Gated", [{"id": "G1"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "gated", "max_usd": 0.25})["run_id"]
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [
        {
            "type": "event_log_entry",
            "event_type": "spec.gate.refused",
            "plan_id": "plans/gated/tasks.toml",
            "task_id": "G1",
            "message": "HF2: step 1: ends in `|| true`",
            "ts_millis": 1_000,
        },
        {
            "type": "error",
            "message": "the spec gate refused the plan before any agent ran: plans/gated/tasks.toml G1: HF2: step 1: "
            "ends in `|| true`. Fix the task specs; [spec_quality] in roko.toml sets what the gate checks",
            "ts_millis": 1_001,
        },
        {"type": "run_completed", "outcome": "failed", "ts_millis": 1_002},
    ]
    refused = {"stage": "spec_gate", "reason": "G1: HF2: step 1: ends in `|| true`"}
    say_refused(fake, monkeypatch, run_id, refused)
    card = views.card(rt, run_id)
    why = card["why"]
    assert why["refusals"] == ["G1: HF2: step 1: ends in `|| true`"] and why["errors"] == []
    assert why["summary"] == (
        "roko's spec check refused the plan before any agent ran: G1: HF2: step 1: ends in `|| true`."
    )
    assert card["next"]["label"] == "read why roko's spec check refused it"
    assert card["headline"].startswith("failed · roko's spec check refused it")
    # Without the gate's events, roko's summary still says what it refused.
    rt.cards._trackers.clear()
    run.events = []
    assert views.card(rt, run_id)["why"]["refusals"] == ["G1: HF2: step 1: ends in `|| true`"]


def say_refused(
    fake: FakeRoko, monkeypatch: pytest.MonkeyPatch, run_id: str, refused: dict[str, Any]
) -> None:
    """The fake's run_status answers `refused` for run `run_id`, as roko since bug-9a5970."""
    original = fake._tool_run_status

    def answer(args: dict[str, Any], who: Any) -> dict[str, Any]:
        body = original(args, who)
        if str(args.get("run_id")) != run_id:
            return body
        return tool_ok({**body["structuredContent"], "refused": refused})

    monkeypatch.setattr(fake, "_tool_run_status", answer)


def test_a_start_roko_refused_on_its_hub_is_why_on_the_runs_card(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("demo-hello", "Demo", [{"id": "T1"}])
    fake.run_script = ["failed"]
    run_id = call(rt, "roko_plan_run", {"plan_id": "demo-hello", "max_usd": 0.25})["run_id"]
    fake.runs[run_id].events = []  # it never started: an older roko wrote nothing for it
    relay = rt.live
    assert isinstance(relay, LiveRelay)
    relay.handle_event(
        {
            "type": "error",
            "ts_millis": int(time.time() * 1000),
            "message": "plan execution failed for demo-hello: A roko plan runner is already active in this workspace",
        }
    )
    card = views.card(rt, run_id)
    assert card["why"]["start_error"] == "A roko plan runner is already active in this workspace"
    assert (
        "roko did not start the run: A roko plan runner is already active in this workspace."
        in card["why"]["summary"]
    )


def test_an_earlier_runs_start_error_replayed_on_connect_is_not_this_runs(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("demo-hello", "Demo", [{"id": "T1"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "demo-hello", "max_usd": 0.25})["run_id"]
    rt.live.handle_event(
        {
            "type": "error",
            "ts_millis": int(time.time() * 1000) - 600_000,
            "message": "plan execution failed for demo-hello: an old one",
        }
    )
    assert rt.cards.tracker(fake.url, run_id).start_error is None


# -- R8: live words keep their spaces ------------------------------------------------------------


def words(text: str, attempt: int = 1) -> dict[str, Any]:
    record = {
        "kind": "text",
        "live": True,
        "task_id": "T1",
        "plan_id": "p",
        "attempt": attempt,
        "payload": {"text": text},
    }
    import json

    return {
        "type": "agent_output",
        "plan_id": "p",
        "task_id": "T1",
        "content": "\x1eroko.stream.v1 " + json.dumps(record),
        "ts_millis": int(time.time() * 1000),
    }


def test_a_space_on_its_own_joins_the_words_without_a_frame(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("p", "P", [{"id": "T1"}])
    fake.run_script = ["running"]
    run_id = call(rt, "roko_plan_run", {"plan_id": "p", "max_usd": 0.25})["run_id"]
    relay = rt.live
    sent: list[dict[str, Any]] = []
    relay._publish = sent.extend  # type: ignore[method-assign]
    for chunk in ("printing", " ", "`wordy", " ", "0.1.0`", " and exiting with code", " ", "0"):
        relay.handle_event(words(chunk))
    said = [frame["said"] for frame in sent if frame.get("type") == "live"]
    assert said[-1] == "printing `wordy 0.1.0` and exiting with code 0"
    assert all(frame["text"].strip() for frame in sent if frame.get("type") == "live")
    assert loopevents.live_record(words(" ")) is not None
    # The card's live text keeps them too.
    tracker = rundata.RunTracker(run_id)
    for index, chunk in enumerate(("code", " ", "0")):
        tracker.fold.feed(index + 1, "agent_output", {**words(chunk), "plan_id": "p", "task_id": "T1"})
    assert tracker.fold.tasks[("p", "T1")].live_text == "code 0"


# -- R4: Insights in two scopes ------------------------------------------------------------------


def test_insights_of_hermes_runs_count_unverified_apart(rt: Runtime) -> None:
    rt.runs.add("r1", "run", "a", state="succeeded", max_usd=0.5)
    rt.runs.update(
        "r1",
        cost_usd=0.01,
        cost_final=True,
        progress={"total": 1, "passed": 1},
        finished_at="2026-10-15T10:00:30Z",
        checks={"verify[0:test]": [1, 0]},
        models={"gpt-5.4-mini": {"tasks": 1, "verified": 1, "unverified": 0, "cost_usd": 0.01}},
    )
    rt.runs.add("r2", "run", "b", state="unverified", max_usd=0.5)
    rt.runs.update(
        "r2",
        cost_usd=0.01,
        cost_final=True,
        progress={"total": 1, "unverified": 1},
        models={"gpt-5.4-mini": {"tasks": 1, "verified": 0, "unverified": 1, "cost_usd": 0.01}},
    )
    rt.runs.add("r3", "plan", "c", state="interrupted", max_usd=0.5)
    rt.runs.update("r3", progress={"total": 2, "passed": 1, "running": 1})
    body = ui_api.insight_view(rt, {})
    assert body["scope"]["kind"] == "hermes" and body["scope"]["label"] == "runs started from Hermes"
    summary = body["summary"]
    assert summary["runs"]["succeeded"] == 1 and summary["runs"]["unverified"] == 1
    assert summary["runs"]["interrupted"] == 1 and summary["runs"]["failed"] == 0
    assert summary["checks"] == {
        "passed": 1,
        "failed": 0,
        "ran": 1,
        "pass_rate": 1.0,
    }  # no check ran ≠ failed
    assert summary["tasks"] == {"total": 4, "verified": 2, "unverified": 1, "failed": 0}
    assert summary["spend_usd"] == 0.02
    [model] = body["models"]
    assert model["model"] == "gpt-5.4-mini" and model["success_rate"] == 0.5 and model["unverified"] == 1
    assert [gate["gate"] for gate in body["gates"]] == ["verify[0:test]"]
    with pytest.raises(RokoError, match="scope must be"):
        ui_api.insight_view(rt, {"scope": "everything"})


def test_an_ended_card_records_its_checks_and_models_for_insights(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = ended(rt, fake, "succeeded")
    views.card(rt, run_id)
    logged = rt.runs.get(run_id)
    assert logged["checks"] == {"verify[0:test]": [1, 0]}
    assert logged["models"]["fake-model"]["verified"] == 1
    summary = insights.hermes_view(rt.runs.recent())["summary"]
    assert summary["checks"]["ran"] == 1


# -- U1: the workspace in the connection ----------------------------------------------------------


def test_an_unreachable_roko_names_the_real_workspace(tmp_path: Path) -> None:
    rt = Runtime(FakeContext({"url": "http://127.0.0.1:9", "workdir": str(tmp_path)}))
    try:
        conn = views.connection(rt)
        assert conn["reachable"] is False and conn["workdir"] == str(tmp_path)
        assert f"--project {tmp_path}" in conn["error"]["hint"] and "WORKSPACE" not in conn["error"]["hint"]
    finally:
        rt.close()


# -- the model's view ----------------------------------------------------------------------------


def test_the_model_hears_where_unverified_work_is_and_that_merging_it_is_the_persons(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    run_id = ended(wrt, fake, "unverified")
    batch_at_base(repo, run_id)
    accept(repo, run_id, run_id, "T1", "unverified", "lib.py", "a = 2\n")
    status = call(wrt, "roko_status", {"run_id": run_id, "wait_secs": 0})
    assert status["work"]["kind"] == "unverified"
    assert status["work"]["parts"][0]["branch"] == f"roko/plan/{run_id}"
    assert "unverified" in status["next"] and f"roko/plan/{run_id}" in status["next"]
    assert "Merging them is the person's choice" in status["next"]


def test_the_model_hears_an_interrupted_run_and_not_to_restart_it_unasked(
    interrupting: InterruptingRoko, approvals: Approvals
) -> None:
    rt = runtime_for(interrupting)
    try:
        interrupting.run_script = ["running"]
        run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
        interrupting.dead.add(run_id)
        status = call(rt, "roko_status", {"run_id": run_id, "wait_secs": 0})
        assert status["state"] == "interrupted" and status["interrupted"]["reason"]
        # P-51: only when the person asks in this turn; otherwise the chat tells them, and that they can ask.
        assert "If the person asked in this turn" in status["next"]
        assert "do not start it on your own" in status["next"]
    finally:
        rt.close()


# -- found by the real runs (plugin-runs, 2026-10-15) ---------------------------------------------


def test_a_cancel_that_finds_a_phantom_keeps_when_it_stopped(
    phantom: PhantomRoko, approvals: Approvals
) -> None:
    rt = runtime_for(phantom)
    try:
        phantom.run_script = ["running"]
        run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
        phantom.runs[run_id].created_at = datetime.now(UTC) - timedelta(minutes=10)
        phantom.uptime_secs = 60
        phantom.dead.add(run_id)
        # Cancel first, with no card built yet in this process: the card's finding (with its time) is kept.
        stopped = views.cancel(rt, run_id)
        assert stopped["state"] == "interrupted" and stopped["interrupted"]["at"]
        assert rt.runs.get(run_id)["interrupted"]["at"] == stopped["interrupted"]["at"]
        # A second cancel keeps it too.
        assert views.cancel(rt, run_id)["interrupted"]["at"] == stopped["interrupted"]["at"]
    finally:
        rt.close()


def test_work_delivered_by_an_interrupted_run_needs_a_yes(
    interrupting: InterruptingRoko, identity: None, tmp_path: Path, approvals: Approvals
) -> None:
    repo = tmp_path / "ws"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    (repo / "notes.txt").write_text("a\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "base")
    rt = runtime_for(interrupting, workdir=str(repo))
    try:
        interrupting.run_script = ["running"]
        run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
        # roko merged the plan into the batch, then stopped while it checked the merged whole.
        git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
        (repo / "notes.txt").write_text("b\n")
        git(repo, "commit", "-q", "-am", "roko: T1")
        git(repo, "checkout", "-q", "main")
        interrupting.dead.add(run_id)
        card = views.card(rt, run_id)
        assert card["state"] == "interrupted" and card["work"]["kind"] == "partial"
        [part] = card["work"]["parts"]
        assert part["delivered"] is True and part["checks_finished"] is False
        assert (
            card["merge"]["work"] == "partial"
            and "roko stopped before it finished checking" in card["merge"]["confirm"]
        )
        assert card["next"]["action"] == "rerun"
        diff = review.run_diff(rt, run_id)
        assert diff["available"] is True and [f["path"] for f in diff["files"]] == ["notes.txt"]
        with pytest.raises(RokoError, match="needs the person's own yes"):
            review.merge_run(rt, run_id, {})
    finally:
        rt.close()


def test_a_run_roko_forgot_keeps_how_it_ended_and_why(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["failed"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
    card = views.card(rt, run_id)
    assert rt.runs.get(run_id)["why"] == card["why"]["summary"]
    del fake.runs[run_id]  # roko serve restarted and kept nothing of a run that failed to start
    rt.runs.update(run_id, started_at="2026-10-15T10:00:00Z")
    again = views.card(rt, run_id)
    assert again["state"] == "failed" and again["why"]["summary"] == card["why"]["summary"]
    assert "no longer has this run's record" in again["problems"][0]
    assert rt.runs.get(run_id)["state"] == "failed"


def test_a_start_error_drops_rokos_advice_to_kill_the_other_runner(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("demo-hello", "Demo", [{"id": "T1"}])
    fake.run_script = ["failed"]
    run_id = call(rt, "roko_plan_run", {"plan_id": "demo-hello", "max_usd": 0.25})["run_id"]
    fake.runs[run_id].events = []  # it never started: an older roko wrote nothing for it
    rt.live.handle_event(
        {
            "type": "error",
            "ts_millis": int(time.time() * 1000),
            "message": "plan execution failed for demo-hello: A roko plan runner is already active in this "
            "workspace (PID 4066).\n  hint: wait for it to finish, or kill it with `kill 4066`",
        }
    )
    why = views.card(rt, run_id)["why"]
    assert why["start_error"] == "A roko plan runner is already active in this workspace (PID 4066)."
    assert "kill" not in why["summary"]


def test_a_refused_start_no_relay_heard_reads_why_from_rokos_plan_status(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    # No page was open, so no relay heard roko's hub error; roko keeps the reason as the run's plan status.
    fake.add_plan("demo-hello", "Demo", [{"id": "T1"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "demo-hello", "max_usd": 0.25})["run_id"]
    run = fake.runs[run_id]
    run.states, run.events = ["failed"], []  # it never started: roko wrote nothing for it
    fake.run_errors[run_id] = (
        "plan execution failed for demo-hello: A roko plan runner is already active in this workspace "
        "(PID 4066).\n  hint: wait for it to finish, or kill it with `kill 4066`"
    )
    card = views.card(rt, run_id)
    why = card["why"]
    assert why["start_error"] == "A roko plan runner is already active in this workspace (PID 4066)."
    assert why["summary"].startswith("roko did not start the run: A roko plan runner is already active")
    assert "kill" not in why["summary"]
    assert card["next"] == {
        "action": None,
        "label": "read why roko did not start it",
        "why": why["start_error"],
    }
    assert card["headline"].startswith("failed · roko did not start it")
    # Any other error of a plan status is not a start error.
    other = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.25})["run_id"]
    fake.runs[other].states, fake.runs[other].events = ["failed"], []
    fake.run_errors[other] = "plan run-1 completed with task-level failures"
    assert views.card(rt, other)["why"]["start_error"] is None


def test_a_demo_that_failed_says_to_read_why(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.add_plan("demo-hello", "Demo", [{"id": "T1"}])
    fake.plans["demo-hello"]["group"] = "demos"
    fake.run_script = ["failed"]
    run_id = call(rt, "roko_plan_run", {"plan_id": "demo-hello", "max_usd": 0.25})["run_id"]
    card = views.card(rt, run_id)
    assert card["demo"] is True
    assert card["next"] == {"action": None, "label": "read why it did not pass", "why": None}


def test_rokos_plan_check_events_name_the_check_its_scope_and_step() -> None:
    now = int(time.time() * 1000)
    started = {
        "type": "plan_check_started",
        "plan_id": "p",
        "stage": "regression",
        "step": 2,
        "steps": 3,
        "name": "cargo clippy",
        "command": "cargo clippy --workspace --no-deps -- -D warnings",
        "scope": "workspace",
        "source": "cargo-default",
        "ts_millis": now - 200_000,
    }
    beat = {
        "type": "plan_check_heartbeat",
        "plan_id": "p",
        "stage": "regression",
        "step": 2,
        "steps": 3,
        "name": "cargo clippy",
        "scope": "workspace",
        "elapsed_ms": 195_000,
        "ts_millis": now - 5_000,
    }
    events = rows(
        {
            "type": "task_completed",
            "plan_id": "p",
            "task_id": "T1",
            "outcome": "passed",
            "ts_millis": now - 210_000,
        },
        started,
        beat,
    )
    tracker = tracker_with(
        [
            {**row, "type": "dashboard." + row["type"]} if row["type"].startswith("plan_check") else row
            for row in events
        ][:1]
        + events[1:]
    )
    checking = rundata.checking(tracker, "running")
    assert checking is not None
    assert (
        checking["label"],
        checking["scope"],
        checking["step"],
        checking["steps"],
        checking["source"],
    ) == ("cargo clippy", "workspace", 2, 3, "roko")
    assert checking["what"] == "cargo clippy --workspace --no-deps -- -D warnings"
    assert 195 <= checking["elapsed_s"] <= 230
    line = rundata.timeline_entry(2, "plan_check_started", started)
    assert line is not None and line["text"] == "checking the workspace: cargo clippy (step 2 of 3)"
    assert rundata.timeline_entry(3, "plan_check_heartbeat", beat) is None
    finished = {
        "type": "plan_check_finished",
        "plan_id": "p",
        "step": 3,
        "steps": 3,
        "name": "cargo test",
        "scope": "packages",
        "packages": ["speed-test"],
        "passed": False,
        "exit_code": 101,
        "elapsed_ms": 61_234,
        "ts_millis": now,
    }
    tracker.fold.feed(4, "plan_check_finished", finished)
    assert tracker.fold.plan_check is None
    end = rundata.timeline_entry(4, "plan_check_finished", finished)
    assert end is not None and end["text"] == "speed-test: cargo test did not pass (exit 101) in 1m01s"
    # The index may call them `dashboard.<type>`.
    assert (
        rundata.row_kind({"type": "dashboard.plan_check_started", "event": started}) == "plan_check_started"
    )


def test_a_partial_delivery_roko_reports_needs_a_yes_and_names_what_is_missing(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    fake.add_plan("flags", "Add two flags", [{"id": "T1", "title": "a"}, {"id": "T2", "title": "b"}])
    fake.run_script = ["failed"]
    run_id = call(wrt, "roko_plan_run", {"plan_id": "flags", "max_usd": 0.5})["run_id"]
    git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
    (repo / "lib.py").write_text("a = 2\n")
    git(repo, "commit", "-q", "-am", "roko: T1")
    tip = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", "main")
    base = git(repo, "rev-parse", "main")
    # roko-delivery's item 2 (draft): the verified tasks of a plan that did not finish are delivered.
    fake.run_result = lambda rid: {
        "branch": f"roko/batch/{rid}",
        "commit": tip,
        "base": base,
        "files_changed": ["lib.py"],
        "diffstat": {"files": 1, "insertions": 1, "deletions": 1},
        "merged": False,
        "merge_command": f"git merge --ff-only roko/batch/{rid}",
        "partial": True,
        "plans": [
            {
                "plan_id": "flags",
                "partial": True,
                "delivered_tasks": ["T1"],
                "missing_tasks": [{"task_id": "T2", "why": "failed"}],
            }
        ],
    }
    card = views.card(wrt, run_id)
    assert card["work"]["kind"] == "partial"
    [part] = card["work"]["parts"]
    assert part["delivered"] is True and part["partial"] is True
    assert part["tasks"] == [{"task_id": "T1", "verdict": "passed"}]
    assert part["missing"] == [{"task_id": "T2", "why": "failed", "plan_id": "flags"}]
    assert card["merge"]["work"] == "partial"
    assert card["merge"]["confirm"] == (
        "The plan did not finish: this takes only the work that passed its checks (Task 1), without Task 2. Merge it anyway?"
    )
    assert f"Task 1 passed its check: that work is kept on roko/batch/{run_id}" in card["why"]["summary"]


def test_a_runs_first_events_before_it_is_followed_still_reach_the_pages(rt: Runtime) -> None:
    import json as _json

    relay = rt.live
    sent: list[dict[str, Any]] = []
    relay._publish = sent.extend  # type: ignore[method-assign]
    record = {
        "kind": "tool_start",
        "live": True,
        "task_id": "T1",
        "plan_id": "r-fast",
        "attempt": 1,
        "payload": {"tool": "read_file", "target": "README.md", "tool_id": "T1-1-0"},
    }
    early = {
        "type": "agent_output",
        "plan_id": "r-fast",
        "task_id": "T1",
        "ts_millis": int(time.time() * 1000),
        "content": "\x1eroko.stream.v1 " + _json.dumps(record),
    }
    relay.handle_event(early)  # the hub was quicker than the tool that started the run
    assert not [frame for frame in sent if frame.get("type") == "live"]
    relay.track("r-fast", kind="run", label="fast")
    [frame] = [frame for frame in sent if frame.get("type") == "live"]
    assert frame["run_id"] == "r-fast" and frame["tool"] == "read_file" and frame["target"] == "README.md"


def test_a_ladder_pick_names_its_rung_from_the_workspaces_ladder(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    (repo / "roko.toml").write_text(
        '[routing.ladder]\nenabled = true\n\n[[routing.ladder.rungs]]\nname = "cheap"\nmodel = "cerebras-gptoss"\n\n'
        '[[routing.ladder.rungs]]\nname = "strong"\nmodel = "gpt-5.4-mini"\n\n'
        '[[routing.ladder.rungs]]\nname = "top"\nmodel = "gpt-5.4-mini"\n'
    )
    fake.models = [{"key": "cerebras-gptoss", "slug": "gpt-oss-120b", "provider": "cerebras"}]
    fake.run_script = ["succeeded"]
    run_id = call(wrt, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
    run = fake.runs[run_id]
    base = run.index() or []

    def route(model: str, attempt: int) -> dict[str, Any]:
        return {
            "type": "route_decided",
            "plan_id": run_id,
            "task_id": "T1",
            "attempt": attempt,
            "model": model,
            "source": "ladder",
            "stage": "static",
            "run_id": run_id,
            "candidates": [],
        }

    run.events = [*base[:4], route("gpt-oss-120b", 1), *base[4:]]
    [task] = views.card(wrt, run_id)["tasks"]
    assert task["route"]["rung"] == "cheap"  # the rung names the model by its key; roko routes by its slug
    run.events = [*base[:4], route("gpt-5.4-mini", 1), *base[4:]]
    wrt.cards._trackers.clear()
    [task] = views.card(wrt, run_id)["tasks"]
    assert task["route"]["rung"] is None  # two rungs name it: no guess


# -- the live socket race (test_v04_live::test_socket_says_hello_then_streams_a_run, flaky since 0.4.0) -----


def stream_a_replayed_run(tmp_path: Path) -> set[str]:
    """Start a replayed prompt run from a page with the socket open, and the frame types the socket got."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from replay_roko import build

    server = build(150.0, tmp_path / "ws").start()
    rt = Runtime(FakeContext({"url": server.url, "workdir": str(tmp_path / "ws")}))
    app = FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix="/api/plugins/roko")
    seen: set[str] = set()
    try:
        with TestClient(app) as client, client.websocket_connect("/api/plugins/roko/live") as socket:
            assert socket.receive_json()["type"] == "hello"
            started = client.post(
                "/api/plugins/roko/runs", json={"prompt": "add a --json flag", "max_usd": 0.5}
            )
            run_id = started.json()["run_id"]
            state, deadline = None, time.monotonic() + 20
            while time.monotonic() < deadline and state != "succeeded":
                frame = socket.receive_json()
                seen.add(frame["type"])
                if frame["type"] == "run" and frame["run"]["run_id"] == run_id:
                    state = frame["run"]["state"]
            assert state == "succeeded"
    finally:
        rt.close()
        server.stop()
    return seen


@pytest.fixture
def slow_start(monkeypatch: pytest.MonkeyPatch) -> None:
    """The request thread is slow once roko has answered (a busy backend): by the time it logs and follows
    the run it started, the replayed run (0.4 s at 150x) has published every one of its events on roko's
    hub. Neither the run log nor the relay knows of the run before then."""
    from hermes_plugin_roko import live_relay

    original = tools.start_paid

    def late(*args: Any, **kwargs: Any) -> dict[str, Any]:
        body = original(*args, **kwargs)
        time.sleep(1.5)
        return body

    monkeypatch.setattr(live_relay, "broadcast", lambda event, payload: None)
    monkeypatch.setattr(tools, "start_paid", late)


def test_the_race_a_run_whose_events_beat_its_start_streamed_nothing_live(
    tmp_path: Path, slow_start: None, monkeypatch: pytest.MonkeyPatch, approvals: Approvals
) -> None:
    # The relay as it was: events of a run nobody follows yet are dropped. Every live frame is lost.
    monkeypatch.setattr(LiveRelay, "_claim_unmapped", lambda self, tracked: None)
    seen = stream_a_replayed_run(tmp_path)
    assert "live" not in seen and "run" in seen


def test_a_run_whose_events_beat_its_start_streams_live_frames(
    tmp_path: Path, slow_start: None, approvals: Approvals
) -> None:
    assert {"run", "lines", "live", "loop"} <= stream_a_replayed_run(tmp_path)


# -- roko's stops at a run's cap (roko bug-4fabd0) and capped runs with no priced model (gap-8548e3) ----------

# roko-caps' live run of plan caps-check under a $0.03 cap (proj-after, 2026-10-16), less its agents' words,
# routes and loop-health rows: T1 passed and was delivered; roko refused T2's seventh model call.
CAP_STOP = (
    "plan 'caps-check': task 'T2' failed: gateway error (budget): plan budget exhausted: the attempt's next model "
    "call would cost about $0.0049, as much as its last, and only $0.0036 of the plan's $0.0300 cap is left"
)
CAP_STOPPED_ROWS: list[dict[str, Any]] = [
    {
        "type": "plan_set_loaded",
        "plans": [
            {
                "conflicts_with": [],
                "depends_on": [],
                "plan_id": "caps-check",
                "tasks_total": 2,
                "title": "caps-check",
                "wave": 0,
            }
        ],
        "ts_millis": 1792118063598,
    },
    {"type": "plan_started", "plan_id": "caps-check", "tasks_total": 2, "ts_millis": 1792118063966},
    {
        "type": "task_started",
        "phase": "graph-executing",
        "plan_id": "caps-check",
        "task_id": "T1",
        "title": "Add shout to wordy",
        "ts_millis": 1792118064068,
    },
    {
        "type": "agent_spawned",
        "agent_id": "caps-check/T1",
        "attempt": 1,
        "model": "gpt-oss-120b",
        "plan_id": "caps-check",
        "provider": "cerebras",
        "role": "implementer",
        "task_id": "T1",
        "ts_millis": 1792118064561,
    },
    {
        "type": "gate_rung_started",
        "plan_id": "caps-check",
        "rung_name": "verify[0:runs]",
        "task_id": "T1",
        "ts_millis": 1792118067548,
    },
    {
        "type": "gate_result",
        "gate": "verify[0:runs]",
        "output_text": '$ PYTHONDONTWRITEBYTECODE=1 python3 -c \'from wordy.shout import shout; assert shout("hi") == "HI!", shout("hi")\' ',
        "passed": True,
        "plan_id": "caps-check",
        "task_id": "T1",
        "ts_millis": 1792118067640,
    },
    {
        "type": "efficiency_event",
        "metric": "cost_usd",
        "plan_id": "caps-check",
        "task_id": "T1",
        "ts_millis": 1792118067686,
        "value": 0.007937549613416195,
    },
    {
        "type": "task_completed",
        "outcome": "passed",
        "plan_id": "caps-check",
        "task_id": "T1",
        "ts_millis": 1792118068176,
    },
    {
        "type": "task_started",
        "phase": "graph-executing",
        "plan_id": "caps-check",
        "task_id": "T2",
        "title": "Record the data chain",
        "ts_millis": 1792118068176,
    },
    {
        "type": "agent_spawned",
        "agent_id": "caps-check/T2",
        "attempt": 1,
        "model": "gpt-oss-120b",
        "plan_id": "caps-check",
        "provider": "cerebras",
        "role": "implementer",
        "task_id": "T2",
        "ts_millis": 1792118068671,
    },
    {
        "type": "inbox_item_received",
        "category": "budget_alert",
        "item_id": "budget:caps-check:80",
        "summary": "plan caps-check has spent $0.0264 of $0.0300 (80%)",
        "ts_millis": 1792118072881,
        "urgency": "question",
    },
    {
        "type": "agent_completed",
        "agent_id": "caps-check/T2",
        "attempt": 1,
        "plan_id": "caps-check",
        "task_id": "T2",
        "ts_millis": 1792118072881,
    },
    {
        "type": "efficiency_event",
        "metric": "cost_usd",
        "plan_id": "caps-check",
        "task_id": "T2",
        "ts_millis": 1792118072893,
        "value": 0.01843145117163658,
    },
    {
        "type": "task_completed",
        "outcome": "failed",
        "plan_id": "caps-check",
        "task_id": "T2",
        "ts_millis": 1792118072986,
    },
    {
        "type": "event_log_entry",
        "event_type": "graph.plan_partially_delivered",
        "message": "plan 'caps-check' did not finish: the work of its verified task(s) Task 1 was delivered into roko/batch/20261016T023423Z-a18779d2 at d2ca6d67a83b",
        "plan_id": "",
        "task_id": "",
        "timestamp_ms": 1792118073476,
        "ts_millis": 1792118073476,
    },
    {"type": "error", "message": CAP_STOP, "ts_millis": 1792118073706},
    {"type": "plan_completed", "plan_id": "caps-check", "success": False, "ts_millis": 1792118073706},
    {"type": "error", "message": "Graph Engine: 1 plan(s): 1 failed", "ts_millis": 1792118074344},
    {
        "type": "run_completed",
        "cleanup_degraded": False,
        "duration_ms": 12992,
        "outcome": "failed",
        "surviving_agent_ids": [],
        "surviving_agent_pids": [],
        "ts_millis": 1792118074404,
    },
]
# The same stop of a Claude CLI agent's attempt, from what it streamed (roko gap-ca1c92; proj-cli, $0.04 cap).
CLI_CAP_STOP = (
    "plan 'caps-cli': task 'T1' failed: gateway error (budget): plan budget exhausted: the attempt's next model "
    "call would cost about $0.0081, as much as its last, and only $0.0027 of the plan's $0.0400 cap is left"
)
# roko's own words for a plan with less left than an attempt needs (graph_task_dispatch/budget.rs, its test
# an_attempt_hold_grows_with_its_calls_until_the_plan_cannot_pay): why a task did not start, and the error of a
# task whose attempt roko would not start.
FLOOR_STOP = (
    "plan budget exhausted: $0.0800 spent of $0.1000, and the $0.0200 left is less than an attempt needs: $0.0900, "
    "room for 3 model calls like its costliest so far ($0.0300)"
)
# A capped run whose only model has no price (proj-unpriced, $0 spent): roko passes it over before any call.
UNPRICED = (
    "plan 'unpriced': task 'T1' failed: gateway error (provider_exhausted): no usable provider for this task: "
    "`local-unpriced` on `local`: has no price, and a budget cap can count only priced calls. Give local-unpriced "
    "a price: cost_input_per_m and cost_output_per_m on its [models.*] entry in roko.toml (0 for a free local "
    "model), or run with --no-budget. No fallback model is usable (local-unpriced: has no price, and a budget cap "
    "can count only priced calls): put the missing API key in ~/.roko/.env (loaded automatically at startup) or "
    "extend [routing] fallback_models. Then re-run."
)


def test_rokos_cap_stops_are_read_into_their_numbers() -> None:
    attempt = rundata.cap_stop(CAP_STOP)
    assert attempt is not None
    assert {key: attempt[key] for key in ("cap_usd", "spent_usd", "left_usd", "call_usd", "needs_usd")} == {
        "cap_usd": 0.03,
        "spent_usd": None,
        "left_usd": 0.0036,
        "call_usd": 0.0049,
        "needs_usd": None,
    }
    assert attempt["said"] == CAP_STOP.partition("(budget): ")[2]
    cli = rundata.cap_stop(CLI_CAP_STOP)
    assert cli is not None and (cli["cap_usd"], cli["left_usd"], cli["call_usd"]) == (0.04, 0.0027, 0.0081)
    floor = rundata.cap_stop(FLOOR_STOP)
    assert floor is not None
    assert (floor["spent_usd"], floor["cap_usd"], floor["left_usd"], floor["needs_usd"]) == (
        0.08,
        0.1,
        0.02,
        0.09,
    )
    spent = rundata.cap_stop("plan budget exhausted: $0.1200 spent of $0.1000")  # an older roko's too
    assert spent is not None and (spent["spent_usd"], spent["cap_usd"], spent["left_usd"]) == (
        0.12,
        0.1,
        None,
    )
    for other in (
        UNPRICED,
        "plan 'p': task 'T1' failed: gate error: tests failed",
        "plan budget cannot be enforced: 1 unpriced call(s) against max_plan_usd = $0.0500; give their models a "
        "price in [models], or run with --no-budget",
        None,
    ):
        assert rundata.cap_stop(other) is None
    assert rundata.cap_words(attempt) == (
        "its next model call would cost about $0.0049, and only $0.0036 of the $0.03 cap was left"
    )
    assert rundata.cap_words(floor) == "only $0.02 of the $0.10 cap was left, less than a try needs ($0.09)"
    assert rundata.cap_words(spent) == "$0.12 of the $0.10 cap was spent"
    assert [rundata.usd(value) for value in (0.03, 0.0264, 0.0049, 0.1, 1.5, 0.0, 0.026369)] == [
        "$0.03",
        "$0.0264",
        "$0.0049",
        "$0.10",
        "$1.50",
        "$0.00",
        "$0.0264",
    ]


def test_a_run_roko_stopped_at_its_cap_reads_as_a_stop_and_offers_a_higher_cap(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    fake.add_plan("caps-check", "caps-check", [{"id": "T1", "title": "Add shout to wordy"}, {"id": "T2"}])
    run_id = call(wrt, "roko_plan_run", {"plan_id": "caps-check", "max_usd": 0.03})["run_id"]
    git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
    (repo / "lib.py").write_text("a = 2\n")
    git(repo, "commit", "-q", "-am", "roko: T1")
    tip = git(repo, "rev-parse", "HEAD")
    git(repo, "checkout", "-q", "main")
    fake.run_result = lambda rid: {
        "branch": f"roko/batch/{rid}",
        "commit": tip,
        "base": git(repo, "rev-parse", "main"),
        "files_changed": ["lib.py"],
        "merged": False,
        "merge_command": f"git merge --ff-only roko/batch/{rid}",
        "partial": True,
        "plans": [{"plan_id": "caps-check", "partial": True, "delivered_tasks": ["T1"], "missing_tasks": []}],
    }
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [dict(row) for row in CAP_STOPPED_ROWS]
    card = views.card(wrt, run_id)
    said = CAP_STOP.partition("(budget): ")[2]
    assert card["state"] == "failed"  # roko's word stays; the card says it was a stop
    assert card["budget_stop"] == {
        "limit": "run",
        "cap_usd": 0.03,
        "spent_usd": 0.026369,
        "plan_id": None,
        "stopped": [
            {
                "task_id": "T2",
                "before": "model_call",
                "next_call_usd": 0.0049,
                "left_usd": 0.0036,
                "attempt_needs_usd": None,
            }
        ],
        "not_started": [],
        "said": said,
    }
    t1, t2 = card["tasks"]
    assert t1["outcome"] == "passed" and t2["outcome"] == "stopped"
    assert t2["reason"] == (
        "stopped at the run's cap: its next model call would cost about $0.0049, and only $0.0036 of the $0.03 "
        "cap was left"
    )
    assert card["progress"]["stopped"] == 1 and card["progress"]["failed"] == 0
    assert card["headline"].startswith(
        "stopped: the run reached its cap · checks 1/1 · tasks 1/2 · $0.0264 of $0.03"
    )
    why = card["why"]["summary"]
    assert why.startswith(
        "The run stopped: it reached its cap of $0.03, with $0.0264 spent. Task 2 was stopped before its next model "
        "call, which would have cost about $0.0049 with only $0.0036 of the cap left; it did not fail."
    )
    # Verified work stays kept as usual.
    assert (
        f"Task 1 passed its check: that work is kept on roko/batch/{run_id}; open the changes to see it."
        in why
    )
    assert "did not finish" not in why and "gateway error" not in why and "roko reported" not in why
    assert card["why"]["errors"][0] == CAP_STOP  # roko's own words stay with the why
    assert card["work"]["kind"] == "partial"
    assert card["next"] == {
        "action": "rerun",
        "label": "raise the cap and run it again",
        "why": "it reached its cap of $0.03 ($0.0264 spent); what it finished is kept on its branch",
        # The composer's next detent above twice the cap ($0.06) and above what was spent plus the call that
        # did not fit ($0.0313): the same cap would stop it again (dogfood R2-3).
        "max_usd": 0.25,
    }
    fold = wrt.cards.tracker(wrt.settings().url, run_id).fold
    lines = [
        line["text"]
        for line in fold.timeline
        if line["type"] in ("task_completed", "error", "plan_completed", "run_completed")
    ]
    assert lines == [
        "Task 1 · passed",
        "Task 2 · stopped",
        "Task 2 · stopped at the run's cap: its next model call would cost about $0.0049, and only $0.0036 of the $0.03 cap was left",
        "plan caps-check stopped at its cap",
        "run stopped at its cap after 13s",
    ]
    stop_line = next(line for line in fold.timeline if line["type"] == "error")
    assert (stop_line["group"], stop_line["task_id"], stop_line["outcome"]) == ("task", "T2", "stopped")
    # The model hears a stop, what passed, and that a run with a higher cap is the person's to start.
    status = call(wrt, "roko_status", {"run_id": run_id, "wait_secs": 0})
    assert status["budget_stop"] == {
        "limit": "run",
        "cap_usd": 0.03,
        "spent_usd": 0.026369,
        "stopped": ["T2"],
        "not_started": [],
        # 0.6.0: how the stopped task's tries went (no ladder here, so each names its model only)
        "climb": ["T2: gpt-oss-120b: roko stopped it at the run's cap"],
    }
    assert status["headline"].startswith("stopped: the run reached its cap")
    assert status["next"] == (
        "roko stopped the run when it reached its cap of $0.03 ($0.0264 spent): a stop, not a failed check. Tell "
        f"the person how far it got: what passed (roko keeps it on roko/batch/{run_id}), and what the cap stopped "
        "(budget_stop): for each stopped task, the rungs it tried and how each try ended, with the line of its "
        "last failed check (budget_stop.climb), so they see how close it came. The cap is their limit on "
        "spending, so running it again with a higher max_usd (roko_plan_run with resume=true skips the tasks "
        "that passed, and its cap counts what the plan already spent) is their decision: offer it in words they "
        'can say back, such as "continue with $0.25" (the card suggests $0.25; the same cap would stop it '
        "again), and start it only when they ask, with the cap they choose. Do not raise a cap or limit "
        "yourself, and do not start other paid work in its place. "
        + errors.NOT_IN_ROKOS_PLACE
        + " "
        + errors.REPORT_NOT_REPAIR
    )


def test_a_cli_agents_attempt_the_cap_stopped_leaves_nothing_and_reads_as_a_stop(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = call(rt, "roko_run", {"prompt": "record the data chain", "max_usd": 0.04})["run_id"]
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [
        {
            "type": "task_started",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "title": "Record the data chain",
            "ts_millis": 1792145686528,
        },
        {
            "type": "agent_spawned",
            "agent_id": "caps-cli/T1",
            "attempt": 1,
            "model": "claude-haiku-4-5",
            "plan_id": "caps-cli",
            "provider": "claude_cli",
            "role": "implementer",
            "task_id": "T1",
            "ts_millis": 1792145686938,
        },
        {
            "type": "efficiency_event",
            "metric": "cost_usd",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "ts_millis": 1792145704751,
            "value": 0.037266798317432404,
        },
        {
            "type": "task_completed",
            "outcome": "failed",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "ts_millis": 1792145704802,
        },
        {"type": "error", "message": CLI_CAP_STOP, "ts_millis": 1792145704839},
        {"type": "plan_completed", "plan_id": "caps-cli", "success": False, "ts_millis": 1792145704839},
        {"type": "error", "message": "Graph Engine: 1 plan(s): 1 failed", "ts_millis": 1792145705239},
        {"type": "run_completed", "duration_ms": 19895, "outcome": "failed", "ts_millis": 1792145705271},
    ]
    card = views.card(rt, run_id)
    assert card["headline"] == "stopped: the run reached its cap · $0.0373 of $0.04 · 20s"
    assert card["why"]["summary"] == (
        "The run stopped: it reached its cap of $0.04, with $0.0373 spent. Task 1 was stopped before its next model "
        "call, which would have cost about $0.0081 with only $0.0027 of the cap left; it did not fail."
    )
    assert card["next"] == {
        "action": "rerun",
        "label": "raise the cap and run it again",
        "why": "it reached its cap of $0.04 ($0.0373 spent)",
        "max_usd": 0.25,
    }
    status = call(rt, "roko_status", {"run_id": run_id, "wait_secs": 0})
    assert "(roko_plan_run" not in status["next"] and "start it only when they ask" in status["next"]
    assert "what passed" not in status["next"]  # nothing did


# plugin-runs' zero-cost run of plan cap-stop through roko serve (git 0216a4cbd, 2026-10-16) on a fake priced
# model, under a $0.05 cap, less its agent's words, routes and loop-health rows: roko ran T2 first and stopped it
# before its third model call, and did not start T1.
LIVE_CAP_ROWS: list[dict[str, Any]] = [
    {
        "type": "plan_set_loaded",
        "plans": [
            {
                "conflicts_with": [],
                "depends_on": [],
                "plan_id": "cap-stop",
                "tasks_total": 2,
                "title": "cap-stop",
                "wave": 0,
            }
        ],
        "ts_millis": 1792154745225,
    },
    {"type": "plan_started", "plan_id": "cap-stop", "tasks_total": 2, "ts_millis": 1792154745521},
    {
        "type": "task_started",
        "phase": "graph-executing",
        "plan_id": "cap-stop",
        "task_id": "T2",
        "title": "Add shout to wordy",
        "ts_millis": 1792154745624,
    },
    {
        "type": "agent_spawned",
        "agent_id": "cap-stop/T2",
        "attempt": 1,
        "model": "fake-model-1",
        "plan_id": "cap-stop",
        "provider": "fakeapi",
        "role": "implementer",
        "task_id": "T2",
        "ts_millis": 1792154745992,
    },
    {
        "type": "inbox_item_received",
        "category": "budget_alert",
        "item_id": "budget:cap-stop:50",
        "summary": "plan cap-stop has spent $0.0320 of $0.0500 (50%)",
        "ts_millis": 1792154746141,
        "urgency": "question",
    },
    {
        "type": "agent_completed",
        "agent_id": "cap-stop/T2",
        "attempt": 1,
        "plan_id": "cap-stop",
        "task_id": "T2",
        "ts_millis": 1792154746141,
    },
    {
        "type": "efficiency_event",
        "metric": "cost_usd",
        "plan_id": "cap-stop",
        "task_id": "T2",
        "ts_millis": 1792154746164,
        "value": 0.03199999779462814,
    },
    {
        "type": "task_completed",
        "outcome": "skipped",
        "plan_id": "cap-stop",
        "task_id": "T1",
        "ts_millis": 1792154746245,
    },
    {
        "type": "task_completed",
        "outcome": "failed",
        "plan_id": "cap-stop",
        "task_id": "T2",
        "ts_millis": 1792154746245,
    },
    {
        "type": "event_log_entry",
        "event_type": "graph.task_not_started",
        "message": "plan 'cap-stop': task 'Task 1' did not start: plan budget exhausted: $0.0320 spent of $0.0500, and the $0.0180 left is less than a try needs: $0.0500, room for 3 model calls like its costliest so far ($0.0210)",
        "plan_id": "",
        "task_id": "",
        "timestamp_ms": 1792154746270,
        "ts_millis": 1792154746270,
    },
    {
        "type": "task_blocked",
        "plan_id": "cap-stop",
        "reason": "plan budget exhausted: $0.0320 spent of $0.0500, and the $0.0180 left is less than an attempt needs: $0.0500, room for 3 model calls like its costliest so far ($0.0210)",
        "task_id": "T1",
        "title": "Read the README",
        "ts_millis": 1792154746271,
    },
    {
        "type": "error",
        "message": "plan 'cap-stop': task 'T2' failed: gateway error (budget): plan budget exhausted: the attempt's next model call would cost about $0.0210, as much as its last, and only $0.0180 of the plan's $0.0500 cap is left",
        "ts_millis": 1792154746271,
    },
    {"type": "plan_completed", "plan_id": "cap-stop", "success": False, "ts_millis": 1792154746271},
    {
        "type": "event_log_entry",
        "event_type": "graph.batch_discarded",
        "message": "the run left no work, so its batch branch roko/batch/9f468701-fa29-421a-bcb1-369377c12c6d was removed",
        "plan_id": "",
        "task_id": "",
        "timestamp_ms": 1792154746650,
        "ts_millis": 1792154746650,
    },
    {"type": "error", "message": "Graph Engine: 1 plan(s): 1 failed", "ts_millis": 1792154746671},
    {
        "type": "run_completed",
        "cleanup_degraded": False,
        "duration_ms": 2870,
        "outcome": "failed",
        "surviving_agent_ids": [],
        "surviving_agent_pids": [],
        "ts_millis": 1792154746700,
    },
]


def test_a_live_cap_stop_through_roko_serve_reads_as_a_stop() -> None:
    tracker = tracker_with(rows(*LIVE_CAP_ROWS))
    tasks = {task.task_id: task for task in tracker.task_rows()}
    assert (tasks["T1"].outcome, tasks["T2"].outcome) == ("stopped", "stopped")
    assert [line["text"] for line in tracker.fold.timeline if line["group"] in ("task", "run")] == [
        "loaded plan cap-stop",
        "plan cap-stop started (2 tasks)",
        "Task 2 · started: Add shout to wordy",
        "Task 1 · skipped",
        "Task 2 · stopped",
        "Task 1 · did not start at the run's cap: only $0.018 of the $0.05 cap was left, less than a try needs ($0.05)",
        "Task 2 · stopped at the run's cap: its next model call would cost about $0.021, and only $0.018 of the $0.05 cap was left",
        "plan cap-stop stopped at its cap",
        "run stopped at its cap after 3s",
    ]
    stop = rundata.budget_stop(tracker.task_rows(), round(tracker.fold.cost_usd, 6), multi_plan=False)
    assert stop is not None
    assert (stop["cap_usd"], stop["spent_usd"]) == (0.05, 0.032)  # roko's "$0.0320 spent of $0.0500"
    # Insights: a task the cap stopped is no verdict on its model; what it spent still counts.
    assert rundata.run_facts(tracker.task_rows())["models"] == {
        "fake-model-1": {"tasks": 0, "verified": 0, "unverified": 0, "cost_usd": 0.032}
    }
    assert rundata._cap_story(stop, set()) == [
        "The run stopped: it reached its cap of $0.05, with $0.032 spent.",
        "Task 2 was stopped before its next model call, which would have cost about $0.021 with only $0.018 of the cap "
        "left; it did not fail.",
        "Task 1 did not start: only $0.018 of the cap was left, less than a try needs ($0.05).",
    ]


def test_tasks_the_cap_kept_from_starting_did_not_start_and_are_not_blocked() -> None:
    def blocked(task: str) -> list[dict[str, Any]]:
        # roko since gap-f59fe9: the node it skipped, then why it did not start.
        return [
            {
                "type": "task_completed",
                "plan_id": "p",
                "task_id": task,
                "outcome": "skipped",
                "ts_millis": 3_000,
            },
            {
                "type": "task_blocked",
                "plan_id": "p",
                "task_id": task,
                "title": "",
                "blocked_by": None,
                "reason": FLOOR_STOP,
                "ts_millis": 3_000,
            },
        ]

    events = rows(
        {"type": "task_started", "plan_id": "p", "task_id": "T1", "ts_millis": 1_000},
        {"type": "task_completed", "plan_id": "p", "task_id": "T1", "outcome": "passed", "ts_millis": 2_000},
        *blocked("T2"),
        *blocked("T3"),
        {
            "type": "task_blocked",
            "plan_id": "p",
            "task_id": "T4",
            "blocked_by": "T9",
            "reason": "blocked by failed task 'T9'",
            "ts_millis": 3_000,
        },
    )
    tracker = tracker_with(events)
    rows_ = {task.task_id: task for task in tracker.task_rows()}
    assert [rows_[task].outcome for task in ("T1", "T2", "T3", "T4")] == [
        "passed",
        "stopped",
        "stopped",
        "blocked",
    ]
    assert rows_["T2"].reason == (
        "did not start at the run's cap: only $0.02 of the $0.10 cap was left, less than a try needs ($0.09)"
    )
    line = next(entry for entry in tracker.fold.timeline if entry["type"] == "task_blocked")
    assert line["outcome"] == "stopped" and line["text"].startswith(
        "Task 2 · did not start at the run's cap: only $0.02"
    )
    stop = rundata.budget_stop(tracker.task_rows(), 0.08, multi_plan=False)
    assert stop is not None and stop["stopped"] == [] and stop["spent_usd"] == 0.08
    assert [entry["task_id"] for entry in stop["not_started"]] == ["T2", "T3"]
    story = rundata._cap_story(stop, set())
    assert story == [
        "The run stopped: it reached its cap of $0.10, with $0.08 spent.",
        "Task 2 and Task 3 did not start: only $0.02 of the cap was left, less than a try needs ($0.09).",
    ]
    # A task whose next attempt roko would not start: its check did not pass, so no "it did not fail".
    retried = tracker_with(
        rows(
            {"type": "task_started", "plan_id": "p", "task_id": "T1", "ts_millis": 1_000},
            {
                "type": "agent_spawned",
                "plan_id": "p",
                "task_id": "T1",
                "attempt": 1,
                "model": "m",
                "ts_millis": 1_000,
            },
            {
                "type": "gate_result",
                "plan_id": "p",
                "task_id": "T1",
                "gate": "verify[0:tests]",
                "passed": False,
                "output_text": "1 failed",
                "ts_millis": 2_000,
            },
            {
                "type": "task_completed",
                "plan_id": "p",
                "task_id": "T1",
                "outcome": "failed",
                "ts_millis": 3_000,
            },
            {
                "type": "error",
                "message": f"plan 'p': task 'T1' failed: gateway error (budget): {FLOOR_STOP}",
                "ts_millis": 3_000,
            },
        )
    )
    [task] = retried.task_rows()
    assert task.outcome == "stopped" and task.reason is not None
    assert task.reason.startswith("stopped at the run's cap before another attempt: only $0.02")
    stop = rundata.budget_stop(retried.task_rows(), None, multi_plan=False)
    assert stop is not None and stop["stopped"][0]["before"] == "attempt"
    assert rundata._cap_story(stop, {"T1"})[1] == (
        "Task 1 got no further try: only $0.02 of the cap was left, less than a try needs ($0.09)."
    )


def test_a_capped_run_with_no_priced_model_says_so_and_points_at_the_docs(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = call(rt, "roko_run", {"prompt": "add shout to wordy", "max_usd": 0.05})["run_id"]
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [
        {
            "type": "task_started",
            "plan_id": "unpriced",
            "task_id": "T1",
            "title": "Add shout to wordy",
            "ts_millis": 1792145583328,
        },
        {
            "type": "agent_spawned",
            "agent_id": "unpriced/T1",
            "attempt": 1,
            "model": "my-local-model-1",
            "plan_id": "unpriced",
            "provider": "local",
            "role": "implementer",
            "task_id": "T1",
            "ts_millis": 1792145583791,
        },
        {
            "type": "task_completed",
            "outcome": "failed",
            "plan_id": "unpriced",
            "task_id": "T1",
            "ts_millis": 1792145583853,
        },
        {"type": "error", "message": UNPRICED, "ts_millis": 1792145583905},
        {"type": "plan_completed", "plan_id": "unpriced", "success": False, "ts_millis": 1792145583905},
        {"type": "error", "message": "Graph Engine: 1 plan(s): 1 failed", "ts_millis": 1792145584404},
        {"type": "run_completed", "duration_ms": 2510, "outcome": "failed", "ts_millis": 1792145584428},
    ]
    card = views.card(rt, run_id)
    why = card["why"]
    assert why["summary"] == (
        "No model with a price could take Task 1 under the cap: roko counts only priced calls against a cap, and "
        "local-unpriced has no price. The plugin's docs/using-roko.md (“roko has no priced model for runs from "
        "Hermes”) shows how to give a model its price."
    )
    assert why["no_price"] == {"tasks": ["T1"], "models": ["local-unpriced"], "docs": rundata.NO_PRICE_DOCS}
    assert readiness.DOCS[readiness.NO_PRICE] == rundata.NO_PRICE_DOCS
    assert (Path(__file__).resolve().parent.parent / "docs" / "using-roko.md").read_text().count(
        "### roko has no priced model for runs from Hermes"
    ) == 1
    # Not a stop at the cap, and no setup problem on the card (plugin-safety's call).
    assert card["budget_stop"] is None and "problem" not in card
    assert card["headline"].startswith("failed · no check ran")
    assert card["next"] == {"action": None, "label": "read why it did not pass", "why": None}


def test_an_older_rokos_failed_run_reads_as_before() -> None:
    tracker = tracker_with(
        rows(
            {"type": "task_started", "plan_id": "p", "task_id": "T1", "ts_millis": 1_000},
            {
                "type": "task_completed",
                "plan_id": "p",
                "task_id": "T1",
                "outcome": "failed",
                "ts_millis": 2_000,
            },
            {
                "type": "error",
                "message": "plan 'p': task 'T1' failed: gate error: tests failed",
                "ts_millis": 2_000,
            },
            {"type": "plan_completed", "plan_id": "p", "success": False, "ts_millis": 2_000},
            {"type": "error", "message": "Graph Engine: 1 plan(s): 1 failed", "ts_millis": 2_000},
            {"type": "run_completed", "duration_ms": 2_000, "outcome": "failed", "ts_millis": 2_000},
        )
    )
    [task] = tracker.task_rows()
    assert task.outcome == "failed" and task.cap_stop is None
    assert rundata.budget_stop(tracker.task_rows(), 0.01, multi_plan=False) is None
    assert [line["text"] for line in tracker.fold.timeline] == [
        "Task 1 · started",
        "Task 1 · ended: failed",
        "error: plan 'p': task 'T1' failed: gate error: tests failed",
        "plan p ended without success",
        "error: Graph Engine: 1 plan(s): 1 failed",
        "run failed in 2s",
    ]
    card = {"state": "failed", "kind": "plan", "budget_stop": None, "why": {}, "gates": {}, "progress": {}}
    assert rundata.headline(card).startswith("failed · no check ran")
    assert rundata.next_action(card) == {"action": None, "label": "read why it did not pass", "why": None}


def test_the_watch_shows_a_stop_at_the_cap_not_a_failure() -> None:
    from rich.console import Console

    from hermes_plugin_roko import live

    card = {
        "run_id": "r1",
        "kind": "plan",
        "state": "failed",
        "cost_usd": 0.026369,
        "max_usd": 0.03,
        "duration_ms": 12_992,
        "tasks": [
            {"task_id": "T1", "outcome": "passed", "gates": [{"gate": "verify[0:runs]", "passed": True}]},
            {"task_id": "T2", "outcome": "stopped", "gates": [], "reason": "stopped at the run's cap: …"},
        ],
        "gates": {"passed": 1, "failed": 0, "total": 1},
        "errors": [CAP_STOP, "Graph Engine: 1 plan(s): 1 failed"],
        "budget_stop": {
            "cap_usd": 0.03,
            "spent_usd": 0.026369,
            "stopped": [{"task_id": "T2"}],
            "not_started": [],
        },
        "next": {"action": "rerun", "label": "raise the cap and run it again", "why": "…"},
    }
    watch = live.Watch(run_id="r1", interval=2.0)
    watch.take(card, [], 1_000.0)
    assert watch.shown == "stopped" and watch.state == "failed"
    console = Console(record=True, width=120, color_system=None)
    console.print(live.summary(watch, 1_000.0, 120))
    text = console.export_text()
    assert text.startswith(
        "■ roko plan r1 stopped after 13s · $0.026 of $0.03 · 1/2 tasks passed · gates 1/1"
    )
    assert "stopped the run reached its cap of $0.03 ($0.0264 spent); what passed is kept" in text
    assert "next    raise the cap and run it again" in text
    assert "Graph Engine" not in text and "gateway error" not in text
    console = Console(record=True, width=120, color_system=None)
    console.print(live.frame(watch, 1_000.0, 120))
    screen = console.export_text()
    assert "STOPPED" in screen and "■ stopped: the run reached its cap of $0.03 ($0.0264 spent)" in screen
    assert "1 stopped at the cap" in screen and "⚠" not in screen
    assert live.window_title(watch) == "■ roko r1 stopped · 2/2"


# -- what roko's planner is doing on a plan writing (roko gap-11d870) ------------------------------------------

# roko-planner's captures on a real serve (5bfc209cf, 2026-10-16): a chat host's plan writing on gpt-5-4-mini over
# /mcp run_status, and a stand-in planner whose calls run into roko's 300 s limit (`GET /api/operations/{id}`,
# the same fields).
SLUG = "add-count-lines-text-to-wordy-cli-py-returning-t"
WRITING_RUNNING = {
    "active": True,
    "elapsed_secs": 0,
    "error": None,
    "kind": f"plan_generate:{SLUG}",
    "progress": {
        "attempt": 1,
        "attempts": 1,
        "calls": 1,
        "cost_usd": 0.0,
        "model": "gpt-5-4-mini",
        "stage": "planning",
    },
    "result": None,
    "run_id": "6fd9a441-6274-43d3-be5d-0cf6882e1167",
    "state": "running",
}
WRITING_DONE = {
    "active": False,
    "error": None,
    "kind": f"plan_generate:{SLUG}",
    "progress": {
        "attempt": 1,
        "attempts": 1,
        "calls": 1,
        "cost_usd": 0.013156,
        "model": "gpt-5-4-mini",
        "stage": "recording",
    },
    "result": {"cost_usd": 0.013156, "slug": SLUG, "task_count": 1},
    "run_id": "6fd9a441-6274-43d3-be5d-0cf6882e1167",
    "state": "succeeded",
}
TIMED_OUT = "the planner call ran into roko's 300 s limit for one call and was stopped"
WRITING_RETRYING = {
    "elapsed_secs": 3,
    "id": "c602cf0c-ca00-4ebe-ade4-8c5afe2e416e",
    "kind": f"plan_generate:{SLUG}",
    "progress": {
        "attempt": 2,
        "attempts": 2,
        "calls": 2,
        "cost_usd": 0.0,
        "model": "planner",
        "reason": TIMED_OUT,
        "stage": "retrying",
    },
    "status": "running",
}
WRITING_TIMED_OUT = (
    f"plan generation failed for {SLUG}: plan generation stopped after 2 planner calls: the last ran into roko's "
    "300 s limit for one call and was stopped. Hint: The agent ran into roko's time limit for one call and was "
    "stopped; a faster model, or a smaller request, finishes in time"
)


def test_a_plan_writings_stage_reads_as_roko_reports_it() -> None:
    assert rundata.writing_view(WRITING_RUNNING) == {
        "stage": "planning",
        "attempt": 1,
        "attempts": 1,
        "calls": 1,
        "cost_usd": 0.0,
        "model": "gpt-5-4-mini",
        "reason": None,
        "elapsed_s": 0,
        "max_usd": None,  # roko says the writing's cap since 55d0acda8 (P-7)
        "text": "writing the plan: planning · try 1 of 1 · 0:00 · $0.00",
    }
    retrying = rundata.writing_view(WRITING_RETRYING)
    assert retrying is not None and retrying["text"] == f"retrying: {TIMED_OUT} · try 2 of 2 · 0:03 · $0.00"
    done = rundata.writing_view(WRITING_DONE)
    assert done is not None and done["text"] == "writing the plan: recording it · try 1 of 1 · $0.01"
    assert rundata.writing_words({"stage": "planning", "elapsed_s": 12, "cost_usd": 0.0}) == (
        "writing the plan: planning · 0:12 · $0.00"
    )
    assert rundata.writing_words({"stage": "fixing", "reason": "the reply held no valid plan"}) == (
        "fixing the plan: the reply held no valid plan"
    )
    # The second before the first stage, and an older roko: nothing to say.
    assert rundata.writing_view({"elapsed_secs": 0, "status": "running"}) is None
    assert rundata.writing_view({"state": "running", "result": None}) is None
    assert [rundata.clock_face(seconds) for seconds in (0, 12, 62, 3723)] == [
        "0:00",
        "0:12",
        "1:02",
        "1:02:03",
    ]


def test_a_plan_writings_card_shows_its_stage_while_it_runs_and_keeps_it_after() -> None:
    logged = {"plan_id": SLUG, "label": "Add count_lines"}
    running = rundata.plan_generation_card("6fd9a441", WRITING_RUNNING, logged)
    assert running["headline"] == "running · writing the plan: planning · try 1 of 1 · 0:00 · $0.00"
    assert running["writing"]["model"] == "gpt-5-4-mini" and running["elapsed_ms"] == 0
    assert running["cost_usd"] == 0.0  # what its returned calls cost so far
    retrying = rundata.plan_generation_card("c602cf0c", {**WRITING_RETRYING, "state": "running"}, logged)
    assert retrying["headline"] == f"running · retrying: {TIMED_OUT} · try 2 of 2 · 0:03 · $0.00"
    done = rundata.plan_generation_card("6fd9a441", WRITING_DONE, logged)
    assert done["headline"] == f"succeeded · plan {SLUG} · 1 task · $0.01"
    assert done["writing"]["stage"] == "recording" and done["elapsed_ms"] is None
    failed = rundata.plan_generation_card(
        "c602cf0c",
        {
            **WRITING_RETRYING,
            "state": "failed",
            "active": False,
            "error": WRITING_TIMED_OUT,
            "elapsed_secs": None,
            "result": None,
        },
        logged,
    )
    # roko keeps the last stage: how far it got, and what it spent (nothing came back).
    assert failed["writing"]["stage"] == "retrying" and failed["writing"]["reason"] == TIMED_OUT
    assert failed["cost_usd"] == 0.0 and failed["planner_error"] == WRITING_TIMED_OUT
    assert failed["headline"] == f"failed · plan {SLUG} · $0.00"
    # An older roko: running, as before.
    older = rundata.plan_generation_card("x", {"state": "running", "result": None}, logged)
    assert older["writing"] is None and older["headline"] == f"running · plan {SLUG}"
    assert older["cost_usd"] is None


class StagedPlanner(PlannerRoko):
    """A plan writing whose run_status answers roko-planner's captured stages in turn (the last one sticks)."""

    stages: dict[str, list[dict[str, Any]]]

    def __post_init__(self) -> None:
        super().__post_init__()
        self.stages = {}

    def _tool_run_status(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run_id = str(args.get("run_id"))
        answers = self.stages.get(run_id)
        if not answers:
            return super()._tool_run_status(args, who)
        answer = answers.pop(0) if len(answers) > 1 else answers[0]
        return tool_ok({**answer, "run_id": run_id})


def test_the_model_and_the_watch_hear_the_planners_stage(approvals: Approvals) -> None:
    from rich.console import Console

    from hermes_plugin_roko import live

    server = StagedPlanner().start()
    rt = runtime_for(server)
    try:
        run_id = call(rt, "roko_plan_generate", {"prompt": "Add count_lines to wordy"})["run_id"]
        server.stages[run_id] = [WRITING_RUNNING, {**WRITING_RETRYING, "state": "running", "active": True}]
        status = call(rt, "roko_status", {"run_id": run_id, "wait_secs": 0})
        assert status["state"] == "running"
        assert status["headline"] == "running · writing the plan: planning · try 1 of 1 · 0:00 · $0.00"
        assert status["writing"] == {
            "stage": "planning",
            "attempt": 1,
            "attempts": 1,
            "calls": 1,
            "cost_usd": 0.0,
            "model": "gpt-5-4-mini",
            "elapsed_s": 0,
        }
        card = views.card(rt, run_id)
        assert card["writing"]["stage"] == "retrying" and card["writing"]["reason"] == TIMED_OUT
        watch = live.Watch(run_id=run_id, interval=2.0)
        watch.take(card, [], 1_000.0)
        console = Console(record=True, width=160, color_system=None)
        console.print(live.frame(watch, 1_000.0, 160))
        assert f"retrying: {TIMED_OUT} · try 2 of 2 · $0.00" in console.export_text()
    finally:
        rt.close()
        server.stop()


def test_the_relay_reads_a_running_plan_writing_without_hub_events(rt: Runtime) -> None:
    from hermes_plugin_roko.live_relay import Tracked

    relay = rt.live
    relay.hub_state = "open"
    writing = Tracked("w1", kind="plan_generate", state="running")
    run = Tracked("r1", kind="run", state="running")
    assert relay._polled(writing) and not relay._polled(run)  # a run's events come on the hub
    writing.state = "succeeded"
    assert not relay._polled(writing)
    relay.hub_state = "closed"
    assert relay._polled(run)  # with the hub away, every active run is read again


# -- roko says which plans are demos, also after they ran (roko gap-8f84d1) -------------------------------------

# roko-demos' live check of gap-8f84d1 (its build of dc6296f07, a fake agent, 2026-10-16): a demo plan's row in the
# listing after it ran, and the results of a demo run and of a run of plain work.
DEMO_PLAN_ROW = {
    "completed": True,
    "completed_task_count": 1,
    "estimated_minutes": 1,
    "fixture": True,
    "group": "demos/parallel-plans",
    "id": "demo-hello-world",
    "old_format": True,
    "status": "done (3h ago)",
    "task_count": 1,
    "tasks_done": 1,
    "tasks_failed": 0,
    "title": "Start here: hello world demo",
}
DEMO_RUN_RESULT = {
    "base": "4d255ebfec2a11625600257bc17538f1a302e849",
    "branch": "roko/batch/7bfdff32-4ac5-4cb0-9868-cd3dfb984646",
    "commit": "c3f9cf4e54619def0473c091e5e02c81a9a0bf5c",
    "diffstat": {"deletions": 0, "files": 1, "insertions": 3},
    "files_changed": ["demo/hello-world/main.rs"],
    "fixture": True,
    "merge_command": "git merge roko/batch/7bfdff32-4ac5-4cb0-9868-cd3dfb984646",
    "merged": False,
    "partial": False,
}
REAL_RUN_RESULT = {**DEMO_RUN_RESULT, "files_changed": ["out/real-work.txt"], "fixture": False}


def test_a_plan_is_a_demo_by_rokos_flag_and_by_its_group_on_an_older_roko() -> None:
    # The listing since gap-8f84d1: `status` is the last run's once the plan ran; `fixture` stays.
    assert rundata.is_demo(DEMO_PLAN_ROW) and tools._plan_row(DEMO_PLAN_ROW)["demo"] is True
    ran = {key: value for key, value in DEMO_PLAN_ROW.items() if key != "group"}
    assert rundata.is_demo(ran)  # no group needed
    # roko's word wins over the plugin's guess from the group.
    assert not rundata.is_demo({**DEMO_PLAN_ROW, "fixture": False})
    # An older roko names no flag: the group, or a status that still says fixture.
    older = {key: value for key, value in DEMO_PLAN_ROW.items() if key != "fixture"}
    assert rundata.is_demo(older)
    assert rundata.is_demo({"id": "x", "status": "fixture"})
    assert not rundata.is_demo({key: value for key, value in older.items() if key != "group"})
    assert rundata.run_fixture({"result": DEMO_RUN_RESULT}) is True
    assert rundata.run_fixture({"result": REAL_RUN_RESULT}) is False
    assert (
        rundata.run_fixture({"result": {k: v for k, v in DEMO_RUN_RESULT.items() if k != "fixture"}}) is None
    )
    assert rundata.run_fixture({"result": None}) is None


def test_a_demo_that_ran_keeps_its_output_out_of_merge_by_rokos_flag(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    # The demo already ran once: roko's listing no longer says "fixture" in its status. No group either.
    fake.add_plan("demo-hello", "Start here: hello world demo", [{"id": "T1", "title": "hello"}])
    fake.plans["demo-hello"].update(status="done (3h ago)", fixture=True)
    fake.run_script = ["succeeded"]
    run_id = call(wrt, "roko_plan_run", {"plan_id": "demo-hello", "max_usd": 0.25})["run_id"]
    git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
    (repo / "hello.rs").write_text("// roko demo output\n")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "roko: T1")
    here = {
        "branch": f"roko/batch/{run_id}",
        "commit": git(repo, "rev-parse", "HEAD"),
        "base": git(repo, "rev-parse", "main"),
        "files_changed": ["hello.rs"],
        "merge_command": f"git merge --ff-only roko/batch/{run_id}",
    }
    git(repo, "checkout", "-q", "main")
    fake.run_result = lambda rid: {**DEMO_RUN_RESULT, **here}
    card = views.card(wrt, run_id)
    assert card["demo"] is True
    assert card["merge"]["available"] is False and card["merge"]["demo"] is True
    assert card["merge"]["reason"] == "demo output: it stays on its run branch"
    assert card["next"]["action"] == "review" and "stays on its run branch" in card["next"]["why"]
    with pytest.raises(RokoError, match="demo output"):
        review.merge_run(wrt, run_id, {})
    assert tools.plan_detail(wrt.client(), "demo-hello")["demo"] is True
    # roko's word on the run wins over the plan's row: a run that was not all demo plans can be merged.
    wrt.cards._trackers.clear()
    fake.run_result = lambda rid: {**REAL_RUN_RESULT, **here}
    card = views.card(wrt, run_id)
    assert card["demo"] is False and card["merge"]["demo"] is not True
    # The plan list keeps roko's flag itself (0.4.0 dropped it), as a boolean only.
    assert tools._plan_row(DEMO_PLAN_ROW)["fixture"] is True
    assert "fixture" not in tools._plan_row({**DEMO_PLAN_ROW, "fixture": "yes"})


# -- roko's daily limit, and caps roko cannot count (lead, 10-16) ----------------------------------------------

# roko's words (graph_task_dispatch/budget.rs): why a task did not start once today's spend reached
# budget.max_daily_usd, and an attempt's refusal as roko-core's BudgetExceeded error (micro-dollars).
DAY_HELD = "daily budget exhausted: $1.0123 spent today (UTC) of budget.max_daily_usd = $1.0000"
DAY_REFUSED = (
    "plan 'nightly': task 'T1' failed: budget exceeded: daily spend in micro-USD (budget.max_daily_usd) "
    "(used 1012345, limit 1000000)"
)
UNENFORCED_CALL = (
    "plan 'p': task 'T1' failed: gateway error (budget): plan budget cannot be enforced: a model call of this "
    "attempt has no price against max_plan_usd = $0.0500; give its model a price in [models], or run with "
    "--no-budget"
)
UNENFORCED_HELD = (
    "plan budget cannot be enforced: 1 unpriced call(s) against max_plan_usd = $0.0500; give their models a "
    "price in [models], or run with --no-budget"
)
UNENFORCED_DAY = (
    "plan 'p': task 'T1' failed: config error: budget.max_daily_usd = $1.0000 cannot be enforced: today's spend "
    "(UTC) includes 2 provider call(s) whose cost was never priced; give their models a price in [models], or "
    "run with --no-budget"
)


def test_rokos_daily_limit_reads_as_a_stop_with_its_own_next(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("nightly", "Nightly chores", [{"id": "T1", "title": "a"}, {"id": "T2", "title": "b"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "nightly", "max_usd": 0.5})["run_id"]
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [
        {"type": "task_started", "plan_id": "nightly", "task_id": "T1", "title": "a", "ts_millis": 1_000},
        {
            "type": "task_completed",
            "plan_id": "nightly",
            "task_id": "T1",
            "outcome": "failed",
            "ts_millis": 1_500,
        },
        {
            "type": "task_completed",
            "plan_id": "nightly",
            "task_id": "T2",
            "outcome": "skipped",
            "ts_millis": 1_600,
        },
        {
            "type": "task_blocked",
            "plan_id": "nightly",
            "task_id": "T2",
            "blocked_by": None,
            "reason": DAY_HELD,
            "ts_millis": 1_600,
        },
        {"type": "error", "message": DAY_REFUSED, "ts_millis": 1_700},
        {"type": "plan_completed", "plan_id": "nightly", "success": False, "ts_millis": 1_700},
        {"type": "error", "message": "Graph Engine: 1 plan(s): 1 failed", "ts_millis": 1_800},
        {"type": "run_completed", "duration_ms": 2_000, "outcome": "failed", "ts_millis": 1_900},
    ]
    card = views.card(rt, run_id)
    stop = card["budget_stop"]
    # roko's figures: the refused attempt's error counts to the micro-dollar.
    assert (stop["limit"], stop["cap_usd"], stop["spent_usd"]) == ("day", 1.0, 1.012345)
    assert [task["outcome"] for task in card["tasks"]] == ["stopped", "stopped"]
    assert card["tasks"][1]["reason"] == (
        "did not start: roko's daily limit was reached ($1.01 of $1.00 spent today, UTC)"
    )
    assert card["headline"].startswith("stopped: today's limit was reached")
    assert card["why"]["summary"].startswith(
        "The run stopped: it reached roko's daily limit of $1.00 (budget.max_daily_usd), with $1.01 spent "
        "today (UTC). Task 1 and Task 2 did not start."
    )
    # Nothing to press: a run started now stops at once, until the day turns or the limit is raised.
    assert card["next"] == {
        "action": None,
        "label": "raise the daily limit or run it after the day turns (UTC)",
        "why": "it reached roko's daily limit of $1.00 ($1.01 spent today, UTC)",
    }
    lines = [line["text"] for line in rt.cards.tracker(rt.settings().url, run_id).fold.timeline]
    assert "Task 2 · did not start: roko's daily limit was reached ($1.01 of $1.00 spent today, UTC)" in lines
    assert "Task 1 · stopped: roko's daily limit was reached ($1.01 of $1.00 spent today, UTC)" in lines
    assert lines[-1] == "run stopped at roko's daily limit after 2s"
    status = call(rt, "roko_status", {"run_id": run_id, "wait_secs": 0})
    assert status["budget_stop"]["limit"] == "day"
    assert status["next"].startswith(
        "roko stopped the run when its daily spending limit was reached ($1.01 of $1.00 spent today, UTC): a "
        "stop, not a failed check."
    )
    assert "A higher max_usd does not help" in status["next"] and "Do not edit roko.toml" in status["next"]
    # The run lists say it too: the row carries the stop, and the model's run line says it.
    [row] = views.run_rows(rt, [rt.runs.get(run_id)])
    assert row["budget_stop"] == {"limit": "day", "cap_usd": 1.0, "spent_usd": 1.012345}
    assert " · stopped at today's limit · " in tools._run_line(rt.runs.get(run_id))


def test_a_run_rows_budget_stop_comes_with_its_card_and_with_a_quick_refresh(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = call(rt, "roko_run", {"prompt": "record the data chain", "max_usd": 0.04})["run_id"]
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [
        {
            "type": "task_started",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "title": "Record the data chain",
            "ts_millis": 1_000,
        },
        {
            "type": "efficiency_event",
            "metric": "cost_usd",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "ts_millis": 1_100,
            "value": 0.037266798317432404,
        },
        {
            "type": "task_completed",
            "outcome": "failed",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "ts_millis": 1_200,
        },
        {"type": "error", "message": CLI_CAP_STOP, "ts_millis": 1_300},
        {"type": "run_completed", "duration_ms": 19_895, "outcome": "failed", "ts_millis": 1_400},
    ]
    # The overview's quick refresh (no card built) learns it from the run's events.
    views.refresh_runs(rt, rt.client(), [rt.runs.get(run_id)])
    [row] = views.run_rows(rt, [rt.runs.get(run_id)])
    assert row["state"] == "failed" and row["budget_stop"] == {
        "limit": "run",
        "cap_usd": 0.04,
        "spent_usd": 0.037267,
    }
    assert " · stopped at its cap · " in tools._run_line(rt.runs.get(run_id))
    # An ordinary failure has none.
    other = call(rt, "roko_run", {"prompt": "x", "max_usd": 0.04})["run_id"]
    fake.runs[other].states = ["failed"]
    views.card(rt, other)
    assert views.run_rows(rt, [rt.runs.get(other)])[0]["budget_stop"] is None


def test_a_cap_roko_cannot_count_says_what_roko_needs() -> None:
    def explained(*events: dict[str, Any]) -> dict[str, Any]:
        cache = rundata.CardCache()
        tracker = cache.tracker("u", "r1")
        for row in rows(*events):
            tracker.fold.feed(row["cursor"], row["type"], row["event"])
        return rundata.explain(cache, "u", {"run_id": "r1", "state": "failed"})

    started = {"type": "task_started", "plan_id": "p", "task_id": "T1", "ts_millis": 1}
    spawned = {
        "type": "agent_spawned",
        "plan_id": "p",
        "task_id": "T1",
        "attempt": 1,
        "model": "glm-5v",
        "ts_millis": 1,
    }
    failed = {"type": "task_completed", "plan_id": "p", "task_id": "T1", "outcome": "failed", "ts_millis": 2}
    why = explained(started, spawned, failed, {"type": "error", "message": UNENFORCED_CALL, "ts_millis": 3})
    needs = (
        "roko needs a price for every model it calls under a cap: cost_input_per_m and cost_output_per_m on the "
        "model's [models.*] entry in roko.toml. The plugin's docs/using-roko.md (“roko has no priced model for "
        "runs from Hermes”) shows how."
    )
    assert why["summary"] == (
        "Task 1 did not finish: a model call had no price, so roko cannot count it against the run's cap of $0.05. "
        + needs
    )
    assert why["no_price"] == {"tasks": ["T1"], "models": ["glm-5v"], "docs": rundata.NO_PRICE_DOCS}
    # A task that did not start for it (roko's dispatch stop), and the daily limit's form.
    held = {
        "type": "task_blocked",
        "plan_id": "p",
        "task_id": "T2",
        "blocked_by": None,
        "reason": UNENFORCED_HELD,
        "ts_millis": 4,
    }
    why = explained(
        started, spawned, failed, held, {"type": "error", "message": UNENFORCED_CALL, "ts_millis": 3}
    )
    assert (
        "Task 2 did not start: a model call had no price, so roko cannot count it against the run's cap"
        in why["summary"]
    )
    assert "Task 2 was blocked" not in why["summary"] and why["no_price"]["tasks"] == ["T1", "T2"]
    why = explained(started, failed, {"type": "error", "message": UNENFORCED_DAY, "ts_millis": 3})
    assert why["summary"].startswith(
        "Task 1 did not start: today's spend includes calls with no price, so roko cannot count its daily limit of "
        "$1.00 (budget.max_daily_usd). roko needs a price"
    )
    # Neither is a stop at a cap: the task stays failed, and the card has no budget_stop.
    assert rundata.cap_stop(UNENFORCED_CALL) is None and rundata.cap_stop(UNENFORCED_DAY) is None


def test_rokos_two_other_task_outcomes_are_counted_as_what_they_are() -> None:
    tracker = tracker_with(
        rows(
            {"type": "task_started", "plan_id": "p", "task_id": "T1", "ts_millis": 1},
            {
                "type": "agent_spawned",
                "plan_id": "p",
                "task_id": "T1",
                "attempt": 1,
                "model": "m1",
                "ts_millis": 1,
            },
            {
                "type": "task_completed",
                "plan_id": "p",
                "task_id": "T1",
                "outcome": "passed_with_preexisting_failures",
                "ts_millis": 2,
            },
            {
                "type": "task_completed",
                "plan_id": "p",
                "task_id": "T2",
                "outcome": "condition-skipped",
                "ts_millis": 3,
            },
        )
    )
    counts = rundata.progress([{"outcome": task.outcome} for task in tracker.task_rows()])
    assert (counts["passed"], counts["skipped"], counts["failed"], counts["stopped"]) == (1, 1, 0, 0)
    t1, t2 = (rundata._task_card(task) for task in tracker.task_rows())
    assert t1["outcome"] == "passed"
    assert t1["reason"] == "passed: the failures its check found were already there before the task"
    assert t2["outcome"] == "skipped"
    assert t2["reason"] == "skipped: no route of the plan chose it, so it did not need to run"
    ended = [line for line in tracker.fold.timeline if line["type"] == "task_completed"]
    assert [line["text"] for line in ended] == [
        "Task 1 · passed: the failures its check found were already there before the task",
        "Task 2 · skipped: no route of the plan chose it, so it did not need to run",
    ]
    assert [line["outcome"] for line in ended] == ["passed", "skipped"]
    # Insights counts the first as verified for its model.
    assert rundata.run_facts(tracker.task_rows())["models"]["m1"]["verified"] == 1


def test_a_cap_stop_whose_why_names_rokos_own_state_hears_that_first() -> None:
    card = {"kind": "run", "budget_stop": {"limit": "run", "cap_usd": 0.03, "spent_usd": 0.03}, "gates": {}}
    result = {
        "state": "failed",
        "run_id": "r1",
        "budget_stop": card["budget_stop"],
        "why": {"summary": "fatal: 'roko/attempt/x' is already checked out in this repository"},
    }
    assert tools._next_step(result, card) == errors.ROKO_STATE_GUIDANCE
    del result["why"]
    assert tools._next_step(result, card).startswith("roko stopped the run when it reached its cap of $0.03")


# -- the Claude CLI's own spend limit, a second fence (roko gap-e14344) ------------------------------------------

# roko's words (claude_cli_agent.rs, and graph_task_dispatch/budget.rs's test of it): a capped Claude CLI attempt
# stopped itself at the limit the attempt gave it (--max-budget-usd), as the task's error.
CLI_OWN_LIMIT = (
    "plan 'caps-cli': task 'T1' failed: gateway error (budget): Budget exhausted: the Claude CLI stopped at its "
    "spend limit (--max-budget-usd $0.1000) after $0.0600"
)
# roko-agent's tool loop with its own daily budget (BudgetTracker), a budget stop since gap-e14344.
TOOL_LOOP_DAY = "plan 'p': task 'T1' failed: gateway error (budget): Budget exhausted: budget exhausted: daily $1.00 / $1.00 (lifetime $3.21)"


def test_the_claude_clis_own_limit_reads_as_the_same_cap_stop(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    stop = rundata.cap_stop(CLI_OWN_LIMIT)
    assert stop is not None and stop["limit"] == "run" and stop["inside"] is True
    assert (stop["agent_limit_usd"], stop["agent_spent_usd"]) == (0.1, 0.06)
    assert (
        rundata.cap_words(stop)
        == "the Claude CLI stopped at the spend limit roko gave it ($0.10) after $0.06"
    )
    # Either case: roko writes "Budget exhausted" here and "plan budget exhausted" elsewhere.
    assert rundata.cap_stop(CLI_OWN_LIMIT.lower()) is not None
    assert rundata.cap_stop(CAP_STOP.replace("plan budget exhausted", "Plan Budget Exhausted")) is not None
    run_id = call(rt, "roko_run", {"prompt": "record the data chain", "max_usd": 0.25})["run_id"]
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [
        {
            "type": "task_started",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "title": "Record",
            "ts_millis": 1_000,
        },
        {
            "type": "agent_spawned",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "attempt": 1,
            "model": "claude-haiku-4-5",
            "provider": "claude_cli",
            "ts_millis": 1_000,
        },
        {
            "type": "efficiency_event",
            "metric": "cost_usd",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "ts_millis": 1_100,
            "value": 0.06,
        },
        {
            "type": "task_completed",
            "plan_id": "caps-cli",
            "task_id": "T1",
            "outcome": "failed",
            "ts_millis": 1_200,
        },
        {"type": "error", "message": CLI_OWN_LIMIT, "ts_millis": 1_300},
        {"type": "run_completed", "duration_ms": 9_000, "outcome": "failed", "ts_millis": 1_400},
    ]
    card = views.card(rt, run_id)
    assert card["budget_stop"]["limit"] == "run"
    assert (
        card["budget_stop"]["cap_usd"] == 0.25
    )  # the cap the run was started with: roko's words name only the CLI's
    assert card["budget_stop"]["stopped"] == [
        {
            "task_id": "T1",
            "before": "model_call",
            "next_call_usd": None,
            "left_usd": None,
            "attempt_needs_usd": None,
            "agent_limit_usd": 0.1,
            "agent_spent_usd": 0.06,
        }
    ]
    assert card["tasks"][0]["outcome"] == "stopped"
    assert card["headline"].startswith("stopped: the run reached its cap")
    assert card["why"]["summary"] == (
        "The run stopped: it reached its cap of $0.25, with $0.06 spent. Task 1 was stopped inside its try: the "
        "Claude CLI stopped at the spend limit roko gave it ($0.10) after $0.06; it did not fail."
    )
    assert card["next"]["label"] == "raise the cap and run it again"


def test_a_tool_loops_own_daily_budget_reads_as_a_daily_stop() -> None:
    stop = rundata.cap_stop(TOOL_LOOP_DAY)
    assert stop is not None and stop["limit"] == "day" and stop["setting"] is None
    assert (stop["cap_usd"], stop["spent_usd"]) == (1.0, 1.0)
    tracker = tracker_with(
        rows(
            {"type": "task_started", "plan_id": "p", "task_id": "T1", "ts_millis": 1},
            {
                "type": "agent_spawned",
                "plan_id": "p",
                "task_id": "T1",
                "attempt": 1,
                "model": "m",
                "ts_millis": 1,
            },
            {"type": "task_completed", "plan_id": "p", "task_id": "T1", "outcome": "failed", "ts_millis": 2},
            {"type": "error", "message": TOOL_LOOP_DAY, "ts_millis": 3},
        )
    )
    summary = rundata.budget_stop(tracker.task_rows(), None, multi_plan=False)
    assert summary is not None and summary["limit"] == "day"
    # Not roko's budget.max_daily_usd: the why names no setting.
    assert rundata._cap_story(summary, set())[0] == (
        "The run stopped: it reached roko's daily limit of $1.00, with $1.00 spent today (UTC)."
    )
    assert (
        rundata.cap_stop(DAY_HELD) is not None
        and rundata.cap_stop(DAY_HELD)["setting"] == "budget.max_daily_usd"
    )
    # An absurd figure (roko's is a u64) does not break the card: the words are not read as a stop.
    absurd = (
        f"budget exceeded: daily spend in micro-USD (budget.max_daily_usd) (used {'9' * 400}, limit 5000000)"
    )
    assert rundata.cap_stop(absurd) is None


# -- dogfood-will's run 2: the cap to raise to (R2-3), and a stop the first finished row already says (R2-2) ----


def test_a_cap_stop_suggests_the_next_detent_above_what_would_fit() -> None:
    def suggested(cap: Any, spent: Any, call: Any = None, needs: Any = None, **card: Any) -> float | None:
        stop = {
            "limit": "run",
            "cap_usd": cap,
            "spent_usd": spent,
            "stopped": [{"task_id": "T1", "next_call_usd": call}] if call is not None else [],
            "not_started": [{"task_id": "T2", "attempt_needs_usd": needs}] if needs is not None else [],
        }
        return rundata.suggested_cap(stop, card.get("cost"), card.get("max_usd"))

    # dogfood R2-3: $0.0171 of a $0.02 cap, a $0.0051 call that did not fit: not $0.02 again.
    assert suggested(0.02, 0.0171, call=0.0051) == 0.25
    assert suggested(0.5, 0.48, call=0.1) == 1.0  # twice the cap
    assert suggested(0.25, 0.24, call=0.4) == 1.0  # what was spent plus the call: $0.64
    assert suggested(3.0, 2.9, call=0.5) == 10.0  # past the composer's $5, the next of 1-2-5
    assert suggested(0.1, 0.08, needs=0.09) == 0.25  # a task that did not start: what an attempt needs
    assert suggested(None, None, max_usd=0.5) == 1.0  # roko named no cap: the one the run was started with
    assert suggested(None, None) is None
    assert suggested(600.0, 599.0) == 1200.0  # past every detent, whole dollars


def test_a_row_that_ended_says_its_cap_stop_even_when_its_card_was_built_first(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_id = call(rt, "roko_run", {"prompt": "count words", "max_usd": 0.02})["run_id"]
    run = fake.runs[run_id]
    run.states = ["failed"]
    run.events = [
        {"type": "task_started", "plan_id": "w", "task_id": "T1", "title": "Count", "ts_millis": 1_000},
        {
            "type": "efficiency_event",
            "metric": "cost_usd",
            "plan_id": "w",
            "task_id": "T1",
            "ts_millis": 1_100,
            "value": 0.0171,
        },
        {"type": "task_completed", "plan_id": "w", "task_id": "T1", "outcome": "failed", "ts_millis": 1_200},
        {
            "type": "error",
            "message": "plan 'w': task 'T1' failed: gateway error (budget): plan budget exhausted: the attempt's next "
            "model call would cost about $0.0051, as much as its last, and only $0.0029 of the plan's $0.0200 cap is left",
            "ts_millis": 1_300,
        },
        {"type": "run_completed", "duration_ms": 12_000, "outcome": "failed", "ts_millis": 1_400},
    ]
    # The live relay builds the card the moment the run ends (the tracker keeps it); a page's overview read its
    # run log a moment before, when the run was still running. Its refresh must still say the stop.
    stale = {**rt.runs.get(run_id), "state": "running"}
    stale.pop("budget_stop", None)
    views.card(rt, run_id)
    assert rt.cards.tracker(rt.settings().url, run_id).final is not None  # kept: the refresh reads it
    views.refresh_runs(rt, rt.client(), [stale])
    [row] = views.run_rows(rt, [stale])
    assert row["state"] == "failed"
    assert row["budget_stop"] == {"limit": "run", "cap_usd": 0.02, "spent_usd": 0.0171}


def test_the_suggested_cap_stays_within_the_plugins_per_run_limit() -> None:
    def stopped(cap: float, spent: float, call: float) -> dict[str, Any]:
        stop = {
            "limit": "run",
            "cap_usd": cap,
            "spent_usd": spent,
            "stopped": [{"task_id": "T1", "next_call_usd": call}],
            "not_started": [],
        }
        return {"state": "failed", "kind": "plan", "budget_stop": stop, "work": {}, "merge": {}}

    # A $3 cap stop needs $6: the $10 detent is over the $5 limit, so the card offers $5 and says why.
    card = stopped(3.0, 2.9, 0.5)
    step = rundata.next_action(card, max_run_usd=5.0)
    assert step is not None and step["max_usd"] == 5.0 and step["over_limit"] is True
    assert step["why"] == (
        "it reached its cap of $3.00 ($2.90 spent); the cap this needs is above your per-run limit of $5.00, which "
        "you can raise in the plugin's settings"
    )
    # Needs $3.20: the $5 detent is over a $4 limit, but $4 is enough, so nothing more to say.
    step = rundata.next_action(stopped(1.6, 1.5, 0.1), max_run_usd=4.0)
    assert step is not None and (step["max_usd"], "over_limit" in step) == (4.0, False)
    assert "per-run limit" not in step["why"]
    # Within the limit, the detent itself; with no limit known, unclamped.
    step = rundata.next_action(stopped(0.03, 0.0264, 0.0049), max_run_usd=5.0)
    assert step is not None and step["max_usd"] == 0.25 and "over_limit" not in step
    step = rundata.next_action(stopped(3.0, 2.9, 0.5))
    assert step is not None and step["max_usd"] == 10.0
    # The model hears the limit as the person's to raise, and the offer as an offer.
    card["next"] = rundata.next_action(card, max_run_usd=5.0)
    result = {"state": "failed", "run_id": "r1", "budget_stop": card["budget_stop"]}
    text = tools._next_step(result, card)
    assert (
        'offer it in words they can say back, such as "continue with $5.00" ($5.00 is the plugin\'s per-run '
        "limit, though the run needs more: raising that limit in the plugin's settings is theirs too), and start "
        "it only when they ask" in text
    )


# -- gap-b67fdd: a run's batch branch is named from its plans, roko/work/<slug> --------------------------------


@pytest.mark.parametrize("naming", ["work", "batch"])
def test_gap_b67fdd_a_passed_run_reads_verified_and_merges_on_the_branch_roko_reports(
    wrt: Runtime, fake: FakeRoko, repo: Path, approvals: Approvals, naming: str
) -> None:
    """Round v8 PW-9: roko gap-b67fdd names a run's batch `roko/work/<slug>`, and roko serve's run result says so,
    with `partial: false`. A fully passed run on it reads verified, shows its diff and merges as verified work
    (it read "partial", and its merge dialog said "NOT FULLY CHECKED"); a run recorded before gap-b67fdd, on
    `roko/batch/<run-id>`, reads as it always did."""
    fake.add_plan("p5-the-sound", "The sound", [{"id": "T1", "title": "a"}, {"id": "T2", "title": "b"}])
    fake.run_script = ["succeeded"]
    run_id = call(wrt, "roko_plan_run", {"plan_id": "p5-the-sound", "max_usd": 3})["run_id"]
    base = git(repo, "rev-parse", "main")
    accept(repo, "p5-the-sound", run_id, "T1", "passed", "lib.py", "a = 2\n")
    tip = accept(repo, "p5-the-sound", run_id, "T2", "passed", "sound.py", "b = 1\n")
    branch = "roko/work/p5-the-sound" if naming == "work" else f"roko/batch/{run_id}"
    git(repo, "branch", branch, tip)  # roko's delivery: the plan's passed work, a fast-forward of the batch
    fake.run_result = lambda rid: {
        "branch": branch,
        "commit": tip,
        "base": base,
        "files_changed": ["lib.py", "sound.py"],
        "diffstat": {"files": 2, "insertions": 2, "deletions": 1},
        "merged": False,
        "merge_command": f"git merge --ff-only {branch}",
        "partial": False,
    }
    card = views.card(wrt, run_id)
    assert card["delivered"]["branch"] == branch
    assert card["work"]["kind"] == "verified"
    [part] = card["work"]["parts"]  # the plan branch's commits are in the batch: nothing is kept apart
    assert part["delivered"] is True and part["branch"] == branch and not part.get("partial")
    merge = card["merge"]
    assert (merge["work"], merge["confirm"], merge["available"], merge["mode"]) == (
        "verified",
        None,
        True,
        "fast-forward",
    )
    assert merge["command"].endswith(f"merge --ff-only {branch}")
    # roko's own diff of the verified work names the branch it is on.
    fake.diffs[run_id] = {  # type: ignore[index]
        "branch": branch,
        "base": base,
        "commit": tip,
        "files": [{"path": "sound.py", "status": "A", "additions": 1, "deletions": 0}],
        "totals": {"files": 1, "additions": 1, "deletions": 0},
    }
    diff = review.run_diff(wrt, run_id)
    assert (diff["available"], diff["delivered"], diff["branch"], diff["commit"]) == (True, True, branch, tip)
    done = review.merge_run(wrt, run_id, {"commit": tip[:12]})
    assert (done["merged"], done["mode"], done["work"]) == (True, "fast-forward", "verified")
    assert git(repo, "rev-parse", "main") == tip

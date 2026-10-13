from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko.commands import run_command
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call
from hermes_plugin_roko.workspace import MAX_FILES, delivered_work, reported_work


def git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", str(repo), *args],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    path = tmp_path / "ws"
    path.mkdir()
    git(path, "init", "-q", "-b", "main")
    (path / "lib.rs").write_text("fn sub() {}\n")
    git(path, "add", "-A")
    git(path, "commit", "-q", "-m", "base")
    return path


def deliver(repo: Path, run_id: str) -> str:
    """Do what roko does: a batch branch off HEAD with the verified change, never checked out."""
    git(repo, "checkout", "-q", "-b", f"roko/batch/{run_id}")
    (repo / "lib.rs").write_text("fn sub() {}\nfn add() {}\n")
    git(repo, "commit", "-q", "-am", "roko: T1")
    git(repo, "checkout", "-q", "main")
    return git(repo, "rev-parse", f"roko/batch/{run_id}")


def test_delivered_work_reads_the_batch_branch(repo: Path) -> None:
    commit = deliver(repo, "run-1")
    work = delivered_work(repo, "run-1")
    assert work is not None
    assert work["branch"] == "roko/batch/run-1" and work["commit"] == commit[:12]
    assert work["files_changed"] == ["lib.rs"] and work["merged"] is False
    assert "1 file changed" in work["diffstat"]
    git(repo, "merge", "-q", "--ff-only", "roko/batch/run-1")
    assert delivered_work(repo, "run-1")["merged"] is True  # type: ignore[index]


@pytest.mark.parametrize("run_id", ["missing", "../etc", "a b", ""])
def test_no_branch_or_unsafe_id(repo: Path, run_id: str) -> None:
    assert delivered_work(repo, run_id) is None


def test_no_workdir_or_not_a_repo(tmp_path: Path) -> None:
    assert delivered_work(None, "r") is None
    assert delivered_work(tmp_path, "r") is None


def test_status_reports_the_unmerged_branch(fake: FakeRoko, repo: Path, approvals: Approvals) -> None:
    fake.run_script = ["succeeded"]
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(repo)}))
    run_id = call(rt, "roko_run", {"prompt": "add add()", "max_usd": 1})["run_id"]
    deliver(repo, run_id)
    status = call(rt, "roko_status", {"run_id": run_id})
    assert status["delivered"]["branch"] == f"roko/batch/{run_id}"
    assert status["delivered"]["workspace"] == str(repo)
    assert f"git -C {repo} diff HEAD...roko/batch/{run_id}" in status["next"]
    assert f"git -C {repo} merge roko/batch/{run_id}" in status["next"]
    text = run_command(rt, f"status {run_id}")
    assert f"Result: branch roko/batch/{run_id}" in text and "not merged yet" in text and "lib.rs" in text
    assert f"merge:  git -C {repo} merge roko/batch/{run_id}" in text


# -- roko's own answer (gap-8409d0) ---------------------------------------------


def roko_result(run_id: str, **extra: object) -> dict[str, object]:
    """An ended run's summary `result`, as roko serve reports it."""
    return {
        "branch": f"roko/batch/{run_id}",
        "commit": "d" * 40,
        "base": "c" * 40,
        "files_changed": ["src/lib.rs"],
        "diffstat": {"files": 1, "insertions": 1, "deletions": 0},
        "merged": False,
        "merge_command": f"git merge --ff-only roko/batch/{run_id}",
        **extra,
    }


def test_reported_work_reads_rokos_result() -> None:
    rlo = chr(0x202E)
    work = reported_work(
        roko_result(
            "run-9",
            files_changed=["src/lib.rs", f"src/new{rlo}.rs"],
            diffstat={"files": 2, "insertions": 3, "deletions": 1},
        )
    )
    assert work == {
        "branch": "roko/batch/run-9",
        "commit": "d" * 12,
        "base": "c" * 40,
        "files_changed": ["src/lib.rs", "src/new.rs"],
        "diffstat": "2 files changed, 3 insertions(+), 1 deletion(-)",
        "merged": False,
        "merge_command": "git merge --ff-only roko/batch/run-9",
        "source": "roko",
    }
    merged = reported_work(roko_result("run-9", merged=True))
    assert merged is not None and merged["merged"] is True and "merge_command" not in merged
    promoted = reported_work(
        {**roko_result("run-9", tag="roko/run/run-9", promoted_into="release"), "merge_command": None}
    )
    assert promoted is not None
    assert promoted["promoted_tag"] == "roko/run/run-9" and promoted["promoted_into"] == "release"
    assert "merge_command" not in promoted
    many = reported_work(
        roko_result(
            "run-9",
            files_changed=[f"f{n}.rs" for n in range(50)],
            diffstat={"files": 75, "insertions": 75, "deletions": 0},
        )
    )
    assert many is not None and len(many["files_changed"]) == MAX_FILES + 1
    assert many["files_changed"][-1] == f"… {75 - MAX_FILES} more"


@pytest.mark.parametrize(
    "result",
    [
        None,
        {},
        "roko/batch/run-9",
        {"branch": "main", "commit": "d" * 40},
        {"branch": "roko/batch/../x", "commit": "d" * 40},
        {"branch": "roko/batch/run-9"},
    ],
)
def test_reported_work_ignores_what_is_not_a_result(result: object) -> None:
    assert reported_work(result) is None


def test_status_prefers_rokos_result_and_needs_no_local_workspace(
    fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["succeeded"]
    fake.run_result = roko_result
    rt = Runtime(FakeContext({"url": fake.url}))
    run_id = call(rt, "roko_run", {"prompt": "add add()", "max_usd": 1})["run_id"]
    status = call(rt, "roko_status", {"run_id": run_id})
    assert status["delivered"]["branch"] == f"roko/batch/{run_id}"
    assert status["delivered"]["files_changed"] == ["src/lib.rs"]
    assert "workspace" not in status["delivered"]
    assert status["review_command"] == f"git diff {'c' * 40}..roko/batch/{run_id}"
    assert status["merge_command"] == f"git merge --ff-only roko/batch/{run_id}"
    assert f"merge it with `git merge --ff-only roko/batch/{run_id}`" in status["next"]
    text = run_command(rt, f"status {run_id}")
    assert "1 file changed, 1 insertion(+)" in text and "src/lib.rs" in text
    assert f"merge:  git merge --ff-only roko/batch/{run_id}" in text


def test_status_reports_a_promoted_run_without_a_merge_command(
    fake: FakeRoko, repo: Path, approvals: Approvals
) -> None:
    fake.run_script = ["succeeded"]
    fake.run_result = lambda run_id: {
        **roko_result(run_id, tag=f"roko/run/{run_id}", promoted_into="release"),
        "merge_command": None,
    }
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(repo)}))
    run_id = call(rt, "roko_run", {"prompt": "add add()", "max_usd": 1})["run_id"]
    # roko's answer wins over the local checkout, which has no batch branch for this run.
    status = call(rt, "roko_status", {"run_id": run_id})
    assert status["delivered"]["promoted_into"] == "release"
    assert status["delivered"]["workspace"] == str(repo)
    assert status["review_command"] == f"git -C {repo} diff {'c' * 40}..roko/batch/{run_id}"
    assert status["merge_command"] is None
    assert "promoted it from branch" in status["next"] and "into release" in status["next"]
    assert "merge it with" not in status["next"]
    text = run_command(rt, f"status {run_id}")
    assert f"promoted into release (tag roko/run/{run_id})" in text
    assert "merge:" not in text

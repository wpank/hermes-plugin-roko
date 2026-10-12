from __future__ import annotations

import subprocess
from pathlib import Path

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko.commands import run_command
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call
from hermes_plugin_roko.workspace import delivered_work


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

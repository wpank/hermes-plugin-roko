"""Where a finished run's verified work lives in roko's git workspace.

roko never commits into the operator's checkout. Each run gets a batch
branch, `roko/batch/<run-id>`, started at the operator's HEAD; every plan
whose tasks all passed their gates is merged into it
(crates/roko-cli/src/graph_execution/batch.rs). roko serve says so in an
ended run's summary, as `result` (gap-8409d0), and `reported_work` reads that.
An older roko serve does not, so when the workspace is on this machine
`delivered_work` reads the branch itself, read-only, to tell the person what
changed and that it still needs merging.
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from typing import Any

from .sanitize import clean

logger = logging.getLogger(__name__)

BATCH_PREFIX = "roko/batch/"
RUN_TAG_PREFIX = "roko/run/"
MAX_FILES = 30
GIT_TIMEOUT_S = 5.0


def reported_work(result: Any) -> dict[str, Any] | None:
    """roko's own answer to where a run's work is, in `delivered_work`'s shape, or None.

    `result` is an ended run's summary `result`: `branch`, `commit`, `base`,
    `files_changed`, `diffstat` (`files`, `insertions`, `deletions`), `merged`,
    and `tag` with `promoted_into`, or else `merge_command`.
    """
    if not isinstance(result, dict):
        return None
    branch, commit = result.get("branch"), result.get("commit")
    if not isinstance(branch, str) or not branch.startswith(BATCH_PREFIX) or not isinstance(commit, str):
        return None
    if not _safe_ref_part(branch[len(BATCH_PREFIX) :]):
        return None
    listed = result.get("files_changed") or []
    files = [clean(path, 300, one_line=True) for path in listed if isinstance(path, str)]
    stat = result.get("diffstat") if isinstance(result.get("diffstat"), dict) else None
    total = _count(stat.get("files")) if stat else len(files)
    work: dict[str, Any] = {
        "branch": branch,
        "commit": clean(commit, one_line=True)[:12],
        "files_changed": files[:MAX_FILES],
        "merged": result.get("merged") is True,
        "source": "roko",
    }
    if total > len(work["files_changed"]):
        work["files_changed"].append(f"… {total - len(work['files_changed'])} more")
    if stat:
        work["diffstat"] = shortstat(total, _count(stat.get("insertions")), _count(stat.get("deletions")))
    for key, limit in (("base", None), ("tag", 200), ("promoted_into", 200)):
        value = result.get(key)
        if isinstance(value, str) and value.strip():
            work[key] = clean(value, limit, one_line=True)
    if "tag" in work:
        work["promoted_tag"] = work.pop("tag")
    command = result.get("merge_command")
    if isinstance(command, str) and command.startswith("git merge ") and not work["merged"]:
        work["merge_command"] = clean(command, 300, one_line=True)
    return work


def shortstat(files: int, insertions: int, deletions: int) -> str:
    """The counts as `git diff --shortstat` words them."""
    parts = [f"{files} file{'' if files == 1 else 's'} changed"]
    if insertions:
        parts.append(f"{insertions} insertion{'' if insertions == 1 else 's'}(+)")
    if deletions:
        parts.append(f"{deletions} deletion{'' if deletions == 1 else 's'}(-)")
    return ", ".join(parts)


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def delivered_work(workdir: Path | None, run_id: str) -> dict[str, Any] | None:
    """The run's batch branch, its commit and changed files, or None if it cannot be read."""
    if workdir is None or not (workdir / ".git").exists() or not _safe_ref_part(run_id):
        return None
    branch = BATCH_PREFIX + run_id
    commit = _git(workdir, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}")
    if not commit:
        return None
    head = _git(workdir, "rev-parse", "--verify", "--quiet", "HEAD^{commit}")
    files_text = _git(workdir, "diff", "--name-only", f"HEAD...{commit}") if head else None
    files = [line for line in (files_text or "").splitlines() if line.strip()]
    result: dict[str, Any] = {
        "branch": branch,
        "commit": commit[:12],
        "files_changed": files[:MAX_FILES],
    }
    if len(files) > MAX_FILES:
        result["files_changed"].append(f"… {len(files) - MAX_FILES} more")
    stat = _git(workdir, "diff", "--shortstat", f"HEAD...{commit}") if head else None
    if stat:
        result["diffstat"] = stat.strip()
    if head:
        result["merged"] = _git_ok(workdir, "merge-base", "--is-ancestor", commit, "HEAD")
    if _git(workdir, "rev-parse", "--verify", "--quiet", f"refs/tags/{RUN_TAG_PREFIX}{run_id}"):
        result["promoted_tag"] = RUN_TAG_PREFIX + run_id
    return result


def _safe_ref_part(value: str) -> bool:
    return bool(value) and all(ch.isalnum() or ch in "-_." for ch in value) and ".." not in value


def _git(workdir: Path, *args: str) -> str | None:
    try:
        proc = subprocess.run(
            ["git", "-C", str(workdir), *args],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_S,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"},
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("roko: git %s failed: %s", args[0], exc)
        return None
    return proc.stdout.strip() if proc.returncode == 0 else None


def _git_ok(workdir: Path, *args: str) -> bool:
    try:
        proc = subprocess.run(
            ["git", "-C", str(workdir), *args],
            capture_output=True,
            timeout=GIT_TIMEOUT_S,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_OPTIONAL_LOCKS": "0"},
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return proc.returncode == 0

"""Where a finished run's verified work lives in roko's git workspace.

roko never commits into the operator's checkout. Each run gets a batch
branch, `roko/batch/<run-id>`, started at the operator's HEAD; every plan
whose tasks all passed their gates is merged into it
(crates/roko-cli/src/graph_execution/batch.rs). roko serve's run summary does
not say so, so when the workspace is on this machine the plugin reads the
branch itself, read-only, to tell the person what changed and that it still
needs merging.
"""

from __future__ import annotations

import logging
import os
import subprocess
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

BATCH_PREFIX = "roko/batch/"
RUN_TAG_PREFIX = "roko/run/"
MAX_FILES = 30
GIT_TIMEOUT_S = 5.0


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

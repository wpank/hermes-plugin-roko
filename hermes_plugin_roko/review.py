"""A finished run's changes, and taking them into the checkout from a Hermes UI.

`run_diff` asks roko serve for an ended run's diff (`GET /api/runs/{id}/diff`,
roko gap-0d6d21): each changed file's status, line counts and unified patch.
An older roko serve has no such route; then, when roko's workspace is on this
machine, the same diff is read from the run's batch branch with git,
read-only. Patches come back parsed into hunks with line numbers on both
sides, so every UI draws them the same way.

`merge_run` takes a run's verified work into the checkout's current branch
when the person clicks Merge. It only ever merges the run's own batch branch,
`roko/batch/<run-id>`, at the commit the person reviewed, and only when that
needs no one at a terminal:

- roko's workspace is a git checkout on this machine, on a branch, with no
  merge, rebase, cherry-pick or revert in progress and no uncommitted changes
  to tracked files;
- the batch is a fast-forward of HEAD, or merges into it without a conflict
  (checked first with `git merge-tree`, which touches nothing).

Anything else is refused with the command to run by hand.
"""

from __future__ import annotations

import logging
import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import rundata, views
from .catalog import TERMINAL_STATES
from .errors import Code, RokoError
from .runtime import Runtime
from .sanitize import clean
from .workspace import BATCH_PREFIX, delivered_work, reported_work

logger = logging.getLogger(__name__)

DEFAULT_FILES = 100
MAX_FILES = 500
DEFAULT_PATCH_BYTES = 65_536
MIN_PATCH_BYTES = 1_024
MAX_PATCH_BYTES = 262_144
# Patches past this many bytes in one answer are left out (their files stay listed).
MAX_TOTAL_PATCH_BYTES = 1_500_000
MAX_LINES_PER_FILE = 4_000
GIT_TIMEOUT_S = 20.0
MERGE_TIMEOUT_S = 60.0
_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$")
_SHA = re.compile(r"^[0-9a-f]{7,64}$")
_STATUSES = {"A": "added", "D": "deleted", "M": "modified", "R": "renamed", "C": "copied", "T": "modified"}
_LANGUAGES = {
    ".py": "python",
    ".rs": "rust",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".go": "go",
    ".md": "markdown",
    ".toml": "toml",
    ".json": "json",
    ".yaml": "yaml",
    ".yml": "yaml",
    ".sh": "shell",
    ".css": "css",
    ".html": "html",
    ".sql": "sql",
}


# -- the diff -----------------------------------------------------------------


def run_diff(rt: Runtime, run_id: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    """`GET /runs/{id}/diff`: what an ended run's verified work changes, file by file."""
    params = params or {}
    run_id = views.resolve_run_id(rt, run_id)
    max_files = _bounded(params, "max_files", DEFAULT_FILES, 1, MAX_FILES)
    max_patch = _bounded(params, "max_patch_bytes", DEFAULT_PATCH_BYTES, MIN_PATCH_BYTES, MAX_PATCH_BYTES)
    settings = rt.settings()
    client = rt.client(settings)
    try:
        body = client.get(
            f"/api/runs/{quote(run_id, safe='')}/diff",
            {"max_files": max_files, "max_patch_bytes": max_patch},
        )
    except RokoError as exc:
        if exc.code is Code.CONFLICT:
            return _unavailable(run_id, "running", "the run is still going: its changes show once it ends")
        if exc.code is not Code.NOT_FOUND:
            raise
        # No result to diff, or a roko serve older than the route: try the branch itself.
        local = local_diff(settings.workdir, run_id, max_files, max_patch)
        if local is not None:
            return local
        return _unavailable(
            run_id,
            "none",
            "this run left no changes to review: no batch branch with verified work",
        )
    if not isinstance(body, dict):
        raise RokoError(Code.PROTOCOL, "GET /api/runs/{id}/diff did not answer with an object")
    return shape_diff(run_id, body, source="roko")


def shape_diff(run_id: str, body: dict[str, Any], *, source: str) -> dict[str, Any]:
    """roko's diff answer, cleaned, with each patch parsed into hunks."""
    files_in = [entry for entry in body.get("files") or [] if isinstance(entry, dict)]
    files: list[dict[str, Any]] = []
    budget = MAX_TOTAL_PATCH_BYTES
    for entry in files_in[:MAX_FILES]:
        path = clean(entry.get("path"), 400, one_line=True)
        if not path:
            continue
        patch = entry.get("patch") if isinstance(entry.get("patch"), str) else None
        dropped = False
        if patch is not None and len(patch) > budget:
            patch, dropped = None, True
        if patch is not None:
            budget -= len(patch)
        hunks, clipped = parse_patch(patch) if patch else ([], False)
        status = clean(entry.get("status"), 20, one_line=True) or "modified"
        files.append(
            {
                "path": path,
                "old_path": clean(entry.get("old_path"), 400, one_line=True) or None,
                "status": _STATUSES.get(status[:1].upper(), status) if len(status) <= 2 else status,
                "additions": _count(entry.get("additions")),
                "deletions": _count(entry.get("deletions")),
                "binary": entry.get("binary") is True,
                "language": language_of(path),
                "hunks": hunks,
                "truncated": entry.get("truncated") is True or clipped or dropped,
            }
        )
    totals: dict[str, Any] = body["totals"] if isinstance(body.get("totals"), dict) else {}
    return {
        "run_id": run_id,
        "available": True,
        "source": source,
        "branch": _branch(body.get("branch")),
        "base": _sha(body.get("base")),
        "commit": _sha(body.get("commit")),
        "files": files,
        "totals": {
            "files": _count(totals.get("files")) or len(files),
            "additions": _count(totals.get("additions")) or sum(f["additions"] for f in files),
            "deletions": _count(totals.get("deletions")) or sum(f["deletions"] for f in files),
        },
        "truncated": body.get("truncated") is True or len(files_in) > len(files),
        "checked_at": rundata.now_iso(),
    }


def parse_patch(patch: str) -> tuple[list[dict[str, Any]], bool]:
    """A unified patch as hunks of `[tag, old line, new line, text]` rows, and whether it was clipped.

    `tag` is "+", "-", " " or "\\" (git's "\\ No newline at end of file"). The
    `diff --git`, `index`, `---` and `+++` header lines are left out.
    """
    hunks: list[dict[str, Any]] = []
    current: dict[str, Any] | None = None
    old = new = 0
    rows = 0
    raw_lines = patch.split("\n")
    if raw_lines and raw_lines[-1] == "":
        raw_lines.pop()  # the patch's final newline
    for raw in raw_lines:
        line = clean(raw.rstrip("\r"), 2_000)
        match = _HUNK.match(line)
        if match:
            old, new = int(match.group(1)), int(match.group(3))
            current = {
                "header": line,
                "old_start": old,
                "new_start": new,
                "context": clean(match.group(5), 200, one_line=True) or None,
                "lines": [],
            }
            hunks.append(current)
            continue
        if current is None:
            continue  # the file header
        if rows >= MAX_LINES_PER_FILE:
            return hunks, True
        if line.startswith("+"):
            current["lines"].append(["+", None, new, line[1:]])
            new += 1
        elif line.startswith("-"):
            current["lines"].append(["-", old, None, line[1:]])
            old += 1
        elif line.startswith("\\"):
            current["lines"].append(["\\", None, None, line[1:].strip()])
        elif line.startswith(" ") or line == "":
            current["lines"].append([" ", old, new, line[1:]])
            old += 1
            new += 1
        else:
            continue
        rows += 1
    return hunks, False


def local_diff(workdir: Path | None, run_id: str, max_files: int, max_patch: int) -> dict[str, Any] | None:
    """The diff read from the run's batch branch with git, when roko serve cannot give it."""
    work = delivered_work(workdir, run_id)
    if workdir is None or not work:
        return None
    branch = work["branch"]
    commit = _git(workdir, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}")
    base = _git(workdir, "merge-base", "HEAD", commit) if commit else None
    if not commit or not base:
        return None
    numstat = _git(workdir, "diff", "--numstat", "-z", "--no-renames", base, commit) or ""
    statuses = _git(workdir, "diff", "--name-status", "-z", "--no-renames", base, commit) or ""
    kinds: dict[str, str] = {}
    parts = statuses.split("\0")
    for index in range(0, len(parts) - 1, 2):
        kinds[parts[index + 1]] = parts[index]
    files: list[dict[str, Any]] = []
    total_files = 0
    for record in numstat.split("\0"):
        fields = record.split("\t", 2)
        if len(fields) != 3 or not fields[2]:
            continue
        total_files += 1
        if len(files) >= max_files:
            continue
        added, deleted, path = fields
        binary = added == "-" and deleted == "-"
        patch = None
        truncated = False
        if not binary:
            patch = _git(workdir, "diff", "--no-color", "--no-ext-diff", base, commit, "--", path)
            if patch is not None and len(patch.encode()) > max_patch:
                patch, truncated = None, True
        files.append(
            {
                "path": path,
                "status": kinds.get(path, "M"),
                "additions": int(added) if added.isdigit() else 0,
                "deletions": int(deleted) if deleted.isdigit() else 0,
                "binary": binary,
                "patch": patch,
                "truncated": truncated,
            }
        )
    body = {
        "branch": branch,
        "base": base,
        "commit": commit,
        "files": files,
        "totals": {
            "files": total_files,
            "additions": sum(f["additions"] for f in files),
            "deletions": sum(f["deletions"] for f in files),
        },
        "truncated": total_files > len(files),
    }
    return shape_diff(run_id, body, source="git")


def language_of(path: str) -> str | None:
    """A language name for highlighting, from the file's extension."""
    suffix = Path(path).suffix.lower()
    return _LANGUAGES.get(suffix)


# -- the merge ----------------------------------------------------------------


def merge_check(rt: Runtime, run_id: str) -> dict[str, Any]:
    """`GET /runs/{id}/merge`: whether Merge would work now, and how, without changing anything."""
    plan = _merge_plan(rt, views.resolve_run_id(rt, run_id))
    return {key: value for key, value in plan.items() if not key.startswith("_")}


def merge_run(rt: Runtime, run_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """`POST /runs/{id}/merge`: take the run's verified work into the checkout's current branch."""
    run_id = views.resolve_run_id(rt, run_id)
    plan = _merge_plan(rt, run_id)
    if plan.get("merged"):
        return {"run_id": run_id, "merged": True, "already": True, "branch": plan.get("branch")}
    if not plan.get("can_merge"):
        raise RokoError(
            Code.REFUSED,
            str(plan.get("reason") or "this run's work cannot be merged from here"),
            hint=f"merge it in a terminal: {plan['command']}" if plan.get("command") else None,
        )
    expected = payload.get("commit")
    commit: str = plan["_commit"]
    if expected is not None:
        if not isinstance(expected, str) or not _SHA.match(expected.strip().lower()):
            raise RokoError(Code.INVALID, "commit must be the commit id the review showed")
        if not commit.startswith(expected.strip().lower()):
            raise RokoError(
                Code.CONFLICT,
                "the run's branch moved since you reviewed it, so nothing was merged",
                hint="review the changes again, then merge",
            )
    workdir: Path = plan["_workdir"]
    previous = _git(workdir, "rev-parse", "HEAD")
    if plan["mode"] == "fast-forward":
        args = ["merge", "--ff-only", "--no-edit", commit]
    else:
        label = clean(plan.get("label"), 72, one_line=True)
        message = f"Merge roko run {run_id[:8]}" + (f": {label}" if label else "")
        args = ["merge", "--no-ff", "--no-edit", "-m", message, commit]
    ok, output = _git_run(workdir, *args, timeout=MERGE_TIMEOUT_S)
    if not ok:
        # A merge that stopped half way leaves MERGE_HEAD; put the checkout back as it was.
        if _in_progress(workdir):
            _git_run(workdir, "merge", "--abort")
        raise RokoError(
            Code.REFUSED,
            "git did not merge the run's work: " + clean(output, 400, one_line=True),
            hint=f"merge it in a terminal: {plan['command']}",
        )
    head = _git(workdir, "rev-parse", "HEAD")
    if not head or not _git_ok(workdir, "merge-base", "--is-ancestor", commit, "HEAD"):
        raise RokoError(
            Code.PROTOCOL, "git reported a merge, but the checkout does not have the run's commit"
        )
    # The card reads the branch again on its next build.
    tracker = rt.cards.tracker(rt.settings().url, run_id)
    with tracker.lock:
        tracker.delivered_at = 0.0
        tracker.final = None
    git = f"git -C {shlex.quote(str(workdir))}"
    return {
        "run_id": run_id,
        "merged": True,
        "already": False,
        "mode": plan["mode"],
        "into": plan.get("into"),
        "branch": plan.get("branch"),
        "commit": commit[:12],
        "previous_head": (previous or "")[:12] or None,
        "head": head[:12],
        "undo_command": f"{git} reset --keep {previous}" if previous else None,
        "checked_at": rundata.now_iso(),
    }


def _merge_plan(rt: Runtime, run_id: str) -> dict[str, Any]:
    """Whether and how the run's work can be merged here; private keys carry what the merge needs."""
    settings = rt.settings()
    client = rt.client(settings)
    summary = rundata.run_status(client, run_id)
    state = clean(summary.get("state"), 40, one_line=True) or "unknown"
    work = reported_work(summary.get("result")) or delivered_work(settings.workdir, run_id)
    logged = rt.runs.get(run_id) or {}
    out: dict[str, Any] = {
        "run_id": run_id,
        "state": state,
        "can_merge": False,
        "merged": False,
        "mode": None,
        "into": None,
        "branch": work.get("branch") if work else None,
        "commit": None,
        "reason": None,
        "command": None,
        "label": logged.get("label"),
    }
    if state not in TERMINAL_STATES:
        out["reason"] = "the run is still going"
        return out
    if not work:
        out["reason"] = "this run left no verified work to merge"
        return out
    if work.get("merged"):
        out["merged"] = True
        out["reason"] = "the checkout already has this run's work"
        return out
    if work.get("promoted_into"):
        out["merged"] = True
        out["reason"] = f"roko already promoted this work into {work['promoted_into']}"
        return out
    branch = str(work.get("branch") or "")
    if not branch.startswith(BATCH_PREFIX) or branch[len(BATCH_PREFIX) :] != run_id:
        out["reason"] = "the run's work is not on its own batch branch"
        return out
    workdir = settings.workdir
    git = f"git -C {shlex.quote(str(workdir))}" if workdir else "git"
    out["command"] = f"{git} merge {branch}"
    if workdir is None or not workdir.is_dir():
        out["reason"] = "roko's workspace is not on this machine, so merge it where roko runs"
        return out
    if _git(workdir, "rev-parse", "--is-inside-work-tree") != "true":
        out["reason"] = f"{workdir} is not a git checkout"
        return out
    commit = _git(workdir, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}")
    if not commit:
        out["reason"] = f"the branch {branch} is not in {workdir}"
        return out
    out["commit"] = commit[:12]
    reported = str(work.get("commit") or "")
    if reported and not commit.startswith(reported[:12]):
        out["reason"] = "the branch no longer points at the commit roko reported"
        return out
    into = _git(workdir, "symbolic-ref", "--quiet", "--short", "HEAD")
    if not into:
        out["reason"] = "the checkout is not on a branch (detached HEAD)"
        return out
    out["into"] = into
    if _in_progress(workdir):
        out["reason"] = "a merge, rebase, cherry-pick or revert is in progress in the checkout"
        return out
    dirty = _git(workdir, "status", "--porcelain", "--untracked-files=no")
    if dirty is None or dirty.strip():
        count = len([line for line in (dirty or "").splitlines() if line.strip()])
        out["reason"] = (
            f"the checkout has uncommitted changes to {count} tracked file{'s' if count != 1 else ''}; "
            "commit or stash them first"
            if count
            else "git could not read the checkout's status"
        )
        return out
    if _git_ok(workdir, "merge-base", "--is-ancestor", commit, "HEAD"):
        out["merged"] = True
        out["reason"] = "the checkout already has this run's work"
        return out
    if _git_ok(workdir, "merge-base", "--is-ancestor", "HEAD", commit):
        out.update(can_merge=True, mode="fast-forward")
        out["command"] = f"{git} merge --ff-only {branch}"
    else:
        clean_merge, detail = _merges_cleanly(workdir, commit)
        if not clean_merge:
            out["reason"] = detail
            return out
        out.update(can_merge=True, mode="merge")
    out["_commit"] = commit
    out["_workdir"] = workdir
    return out


def _merges_cleanly(workdir: Path, commit: str) -> tuple[bool, str]:
    """Whether `commit` merges into HEAD without a conflict, checked by a merge that writes no files."""
    ok, output = _git_run(workdir, "merge-tree", "--write-tree", "--no-messages", "HEAD", commit)
    if ok:
        return True, ""
    if "usage:" in output or "unknown option" in output:  # git older than 2.38
        return False, "this git cannot check a merge without making it, so merge it in a terminal"
    return False, "the run's changes conflict with the checkout's branch, so merge it in a terminal"


def _in_progress(workdir: Path) -> bool:
    for name in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"):
        path = _git(workdir, "rev-parse", "--git-path", name)
        if path and (Path(path) if Path(path).is_absolute() else workdir / path).exists():
            return True
    return False


# -- helpers --------------------------------------------------------------------


def _unavailable(run_id: str, why: str, message: str) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "available": False,
        "why": why,
        "message": message,
        "files": [],
        "totals": {"files": 0, "additions": 0, "deletions": 0},
        "checked_at": rundata.now_iso(),
    }


def _bounded(params: dict[str, str], key: str, default: int, low: int, high: int) -> int:
    raw = params.get(key)
    if raw is None or raw == "":
        return default
    try:
        number = int(raw)
    except ValueError as exc:
        raise RokoError(Code.INVALID, f"{key} must be a whole number") from exc
    return max(low, min(high, number))


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _sha(value: Any) -> str | None:
    text = clean(value, 64, one_line=True).lower()
    return text if _SHA.match(text) else None


def _branch(value: Any) -> str | None:
    text = clean(value, 200, one_line=True)
    return text if text.startswith(BATCH_PREFIX) else None


def _env() -> dict[str, str]:
    return {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_EDITOR": "true",
        "GIT_MERGE_AUTOEDIT": "no",
        "LC_ALL": "C",
    }


def _git(workdir: Path, *args: str) -> str | None:
    ok, output = _git_run(workdir, *args)
    return output.strip() if ok else None


def _git_ok(workdir: Path, *args: str) -> bool:
    return _git_run(workdir, *args)[0]


def _git_run(workdir: Path, *args: str, timeout: float = GIT_TIMEOUT_S) -> tuple[bool, str]:
    try:
        proc = subprocess.run(
            ["git", "-C", str(workdir), *args],
            capture_output=True,
            text=True,
            timeout=timeout,
            env=_env(),
            check=False,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("roko: git %s failed: %s", args[0], exc)
        return False, str(exc)
    return proc.returncode == 0, proc.stdout if proc.returncode == 0 else (proc.stderr or proc.stdout)

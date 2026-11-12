"""Where an ended run's changes are, how far they can be trusted, and whether Merge can take them.

roko delivers into a run's batch branch, `roko/batch/<run-id>`, only the work of plans whose tasks all
passed their checks (workspace.py). Everything else the run accepted stays on its plan's own branch,
`roko/plan/<plan>`, one commit per task with trailers that name the plan, the task, the run and the
task's verdict (roko gap-3b5361):

- work no check ran on (verdict `unverified`), which roko names in the summary's `result.unverified`
  since bug-db89d4;
- the tasks that passed in a plan that did not succeed. roko-delivery's item 2 delivers those into the batch
  too and says so (`result.partial`, `result.plans`); an older roko leaves them on the plan branch.

`run_work` puts these together as the card's `work`: one part per place, each `verified` or
`unverified`, `delivered` or kept on a plan branch. roko's own answer comes first; when the workspace is on
this machine the plan branches are also read with git, read-only, the way roko reads them
(`PlanWork::read`), so an older roko's runs show the same.

`merge_state` says whether Merge can take a part now, from the checkout alone (no request to roko), and
`commit_preview` / `commit_settings` commit `roko.toml` for the person when that is all that stands in
Merge's way (the setup fix changes it).
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shlex
import subprocess
from pathlib import Path
from typing import Any

from .sanitize import clean
from .workspace import BATCH_PREFIX, shortstat

logger = logging.getLogger(__name__)

PLAN_PREFIX = "roko/plan/"
# How far back along a plan branch's first parents a run's commits are looked for (as roko does).
MAX_COMMITS = 512
MAX_FILES = 30
MAX_PARTS = 8
GIT_TIMEOUT_S = 5.0
# A commit runs the checkout's own hooks, which may take a while.
COMMIT_TIMEOUT_S = 60.0
# The verdicts roko counts as verified: every check passed, passed but for failures the base already
# had, or passed on work that was already there.
VERIFIED_VERDICTS = frozenset({"passed", "passed_with_preexisting_failures", "already_satisfied"})
# What a kept part of verified work may be called in roko's summary, once roko names it.
KEPT_KEYS = ("kept",)
SETTINGS_FILE = "roko.toml"
# The message `hermes roko init` commits roko.toml with too.
SETTINGS_MESSAGE = "roko: accept runs started from Hermes"
_SHA = re.compile(r"^[0-9a-f]{7,64}$")
# roko's review command for kept work: `git diff <base>..<plan branch or commit>`.
_PLAIN_DIFF = re.compile(r"git diff [0-9a-f]{7,64}\.\.[A-Za-z0-9._/-]+")
_SHORTSTAT = re.compile(r"(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?")
_RECORD = "\x1e"
_FIELD = "\x1f"


# -- the parts ------------------------------------------------------------------------------


def delivered_part(delivered: dict[str, Any] | None, review_command: str | None) -> dict[str, Any] | None:
    """The card's `delivered` work (the batch branch, all of it verified) as a part."""
    if not isinstance(delivered, dict):
        return None
    merged = delivered.get("merged") is True or bool(delivered.get("promoted_into"))
    if not delivered.get("files_changed") and not merged:
        return None
    return {
        "trust": "verified",
        "delivered": True,
        "plan_id": None,
        "branch": delivered.get("branch"),
        "commit": delivered.get("commit"),
        "base": _short(delivered.get("base")),
        "files_changed": list(delivered.get("files_changed") or []),
        "diffstat": delivered.get("diffstat"),
        "counts": counts(delivered.get("diffstat")),
        "tasks": [],
        "merged": merged,
        "review_command": review_command,
    }


def roko_parts(result: Any, git: str = "git") -> tuple[list[dict[str, Any]], bool]:
    """The kept parts roko's summary names, and whether it named any list of them (a newer roko)."""
    if not isinstance(result, dict):
        return [], False
    parts: list[dict[str, Any]] = []
    listed = False
    for key, trust in (("unverified", "unverified"), *((key, "verified") for key in KEPT_KEYS)):
        rows = result.get(key)
        if not isinstance(rows, list):
            continue
        listed = True
        for row in rows[:MAX_PARTS]:
            part = _roko_part(row, trust, git)
            if part is not None:
                parts.append(part)
    return parts, listed


def _roko_part(row: Any, trust: str, git: str) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    commit = _sha(row.get("commit"))
    if commit is None:
        return None
    branch = clean(row.get("branch"), 200, one_line=True)
    stat = row.get("diffstat") if isinstance(row.get("diffstat"), dict) else None
    files = [
        clean(path, 300, one_line=True) for path in row.get("files_changed") or [] if isinstance(path, str)
    ]
    total = _count(stat.get("files")) if stat else len(files)
    if total == 0 and not files:
        return None
    shown = files[:MAX_FILES]
    if total > len(shown):
        shown.append(f"… {total - len(shown)} more")
    base = _sha(row.get("base"))
    # roko names the branch after the plan, whose name may hold anything a ref allows (`;`, `$(…)`): a branch
    # or a command built from one is passed on only when it is a plain ref, since the person may paste it.
    plain = branch.startswith(PLAN_PREFIX) and _safe_ref(branch[len(PLAN_PREFIX) :])
    command = clean(row.get("review_command"), 300, one_line=True)
    if not _PLAIN_DIFF.fullmatch(command) or not _safe_ref(command.rsplit("..", 1)[-1]):
        command = f"git diff {base[:12]}..{commit[:12]}" if base else ""
    return {
        "trust": trust,
        "delivered": False,
        "plan_id": clean(row.get("plan_id"), 120, one_line=True) or None,
        "branch": branch if plain else None,
        "commit": commit[:12],
        "base": base[:12] if base else None,
        "files_changed": shown,
        "diffstat": shortstat(total, _count(stat.get("insertions")), _count(stat.get("deletions")))
        if stat
        else None,
        "counts": {
            "files": total,
            "additions": _count(stat.get("insertions")),
            "deletions": _count(stat.get("deletions")),
        }
        if stat
        else None,
        "tasks": _tasks(row.get("tasks")),
        "merged": False,
        "review_command": f"{git} {command.removeprefix('git ')}"
        if command.startswith("git diff ")
        else None,
    }


def git_parts(
    workdir: Path | None, run_id: str, plan_ids: list[str], batch_tip: str | None = None
) -> list[dict[str, Any]] | None:
    """The run's work kept on its plans' branches, read with git; None when git cannot tell here.

    For each plan, the branch's commits from its tip back along first parents, as long as their trailers
    name the plan and this run, oldest first. The verified ones up to the first that is not (a commit on
    top of unverified work is not verified either) are kept work unless the batch already has them; the
    rest is unverified.
    """
    if workdir is None or not (workdir / ".git").exists():
        return None
    git = f"git -C {shlex.quote(str(workdir))}"
    parts: list[dict[str, Any]] = []
    for plan_id in dict.fromkeys(plan_ids or [run_id]):
        if not _safe_ref(plan_id):
            continue
        branch = PLAN_PREFIX + plan_id
        tip = _git(workdir, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}")
        if not tip:
            continue
        commits, base = _run_commits(workdir, tip, plan_id, run_id)
        if not commits or base is None:
            continue
        verified = 0
        while verified < len(commits) and commits[verified]["verdict"] in VERIFIED_VERDICTS:
            verified += 1
        if verified:
            last = commits[verified - 1]["commit"]
            delivered = bool(batch_tip) and _git_ok(
                workdir, "merge-base", "--is-ancestor", last, str(batch_tip)
            )
            if not delivered:
                part = _git_part(
                    workdir, git, "verified", plan_id, branch, tip, base, last, commits[:verified]
                )
                if part is not None:
                    parts.append(part)
        if verified < len(commits):
            start = commits[verified - 1]["commit"] if verified else base
            rest = commits[verified:]
            part = _git_part(
                workdir, git, "unverified", plan_id, branch, tip, start, rest[-1]["commit"], rest
            )
            if part is not None:
                parts.append(part)
        if len(parts) >= MAX_PARTS:
            break
    return parts


def _run_commits(
    workdir: Path, tip: str, plan_id: str, run_id: str
) -> tuple[list[dict[str, str]], str | None]:
    log = _git(
        workdir,
        "log",
        "--first-parent",
        f"--max-count={MAX_COMMITS}",
        f"--format=%H{_FIELD}%P{_FIELD}%B{_RECORD}",
        tip,
    )
    commits: list[dict[str, str]] = []
    base: str | None = None
    for record in (log or "").split(_RECORD):
        fields = record.lstrip("\n").split(_FIELD, 2)
        if len(fields) != 3:
            break
        commit, parents, body = fields
        task, verdict = _trailer(body, "Roko-Task"), _trailer(body, "Roko-Verdict")
        if (
            _trailer(body, "Roko-Plan") != plan_id
            or _trailer(body, "Roko-Run") != run_id
            or not task
            or not verdict
        ):
            break
        commits.append({"commit": commit.strip(), "task_id": task, "verdict": verdict})
        base = parents.split()[0] if parents.split() else None
    commits.reverse()
    return commits, base


def _git_part(
    workdir: Path,
    git: str,
    trust: str,
    plan_id: str,
    branch: str,
    tip: str,
    base: str,
    commit: str,
    commits: list[dict[str, str]],
) -> dict[str, Any] | None:
    names = _git(workdir, "diff", "--name-only", "--no-renames", base, commit)
    files = [line for line in (names or "").splitlines() if line.strip()]
    if not files:
        return None
    shown = [clean(path, 300, one_line=True) for path in files[:MAX_FILES]]
    if len(files) > MAX_FILES:
        shown.append(f"… {len(files) - MAX_FILES} more")
    stat = _git(workdir, "diff", "--shortstat", base, commit)
    on_branch = commit == tip
    return {
        "trust": trust,
        "delivered": False,
        "plan_id": plan_id,
        "branch": branch if on_branch else None,
        "commit": commit[:12],
        "base": base[:12],
        "files_changed": shown,
        "diffstat": stat.strip() if stat else None,
        "counts": counts(stat),
        "tasks": [
            {"task_id": clean(c["task_id"], 80, one_line=True), "verdict": c["verdict"]} for c in commits
        ][:20],
        "merged": _git_ok(workdir, "merge-base", "--is-ancestor", commit, "HEAD"),
        "review_command": f"{git} diff {base[:12]}..{branch if on_branch else commit[:12]}",
    }


def batch_has_run(workdir: Path | None, run_id: str) -> bool:
    """Whether the run's batch branch holds any of the run's own commits (a batch that got nothing is still
    at the checkout's HEAD of when the run began, which no commit of the run can be)."""
    if workdir is None or not _safe_ref(run_id):
        return False
    log = _git(workdir, "log", "-n", "64", "--format=%B", f"refs/heads/{BATCH_PREFIX}{run_id}")
    return any(line.strip() == f"Roko-Run: {run_id}" for line in (log or "").splitlines())


def counts(diffstat: Any) -> dict[str, int] | None:
    """`git diff --shortstat`'s sentence ("2 files changed, 12 insertions(+)") as numbers, or None."""
    found = _SHORTSTAT.search(diffstat) if isinstance(diffstat, str) else None
    if found is None:
        return None
    return {"files": int(found[1]), "additions": int(found[2] or 0), "deletions": int(found[3] or 0)}


def run_work(
    delivered: dict[str, Any] | None,
    review_command: str | None,
    result: Any,
    local: list[dict[str, Any]] | None,
    *,
    git: str = "git",
    interrupted: bool = False,
    stopped: str | None = None,
) -> dict[str, Any] | None:
    """The card's `work`: the delivered part, then the kept ones, and what they add up to.

    `result` is roko's summary `result`; `local` the parts read with git (None when the workspace is
    not on this machine). None when nothing says where the work is. In an interrupted run the delivered
    work's own checks passed, but roko may have stopped before the checks it runs on the delivered whole
    finished (`checks_finished: false`), so the run's work counts as partial. `stopped` says what stopped a
    check of the plan's merged work (roko 2359ba4ec: a cancel during the delivery's regression check, which
    then takes the merge back out of the batch): the verified work kept on its plan branch passed each task's
    check, but that one did not finish.
    """
    parts: list[dict[str, Any]] = []
    first = delivered_part(delivered, review_command)
    if first is not None:
        first["checks_finished"] = not interrupted
        _partial_delivery(first, result)
        parts.append(first)
    reported, listed = roko_parts(result, git)
    known = {(part["trust"], part.get("plan_id"), part["commit"]) for part in reported}
    parts.extend(reported)
    for part in local or []:
        if (part["trust"], part.get("plan_id"), part["commit"]) not in known:
            parts.append(part)
    for part in parts:
        if stopped and part["trust"] == "verified" and not part["delivered"]:
            part.update(checks_finished=False, stopped=stopped)
    told = first is not None or isinstance(result, dict) or local is not None
    if not parts:
        return {"kind": "none", "parts": [], "source": _source(listed, local)} if told else None
    trusts = {part["trust"] for part in parts}
    if trusts == {"unverified"}:
        kind = "unverified"
    elif trusts == {"verified"} and all(
        part["delivered"] and part.get("checks_finished", True) and not part.get("partial") for part in parts
    ):
        kind = "verified"
    else:
        kind = "partial"
    return {"kind": kind, "parts": parts[:MAX_PARTS], "source": _source(listed or bool(reported), local)}


def _partial_delivery(part: dict[str, Any], result: Any) -> None:
    """roko delivers the verified tasks of a plan that did not finish (`result.partial`, `result.plans`): the
    delivered part then names the tasks it holds and the ones it lacks, with why."""
    if not isinstance(result, dict) or result.get("partial") is not True:
        return
    held: list[dict[str, Any]] = []
    missing: list[dict[str, Any]] = []
    for plan in result.get("plans") or []:
        if not isinstance(plan, dict):
            continue
        plan_id = clean(plan.get("plan_id"), 120, one_line=True) or None
        for task in plan.get("delivered_tasks") or []:
            if isinstance(task, str) and task:
                held.append({"task_id": clean(task, 80, one_line=True), "verdict": "passed"})
        for task in plan.get("missing_tasks") or []:
            if isinstance(task, dict) and task.get("task_id"):
                missing.append(
                    {
                        "task_id": clean(task.get("task_id"), 80, one_line=True),
                        "why": clean(task.get("why"), 120, one_line=True) or None,
                        "plan_id": plan_id,
                    }
                )
    part["partial"] = True
    part["tasks"] = held[:20]
    part["missing"] = missing[:20]


def _source(reported: bool, local: list[dict[str, Any]] | None) -> str | None:
    if reported:
        return "roko"
    return "git" if local is not None else None


def pick_part(
    work: dict[str, Any] | None, which: str | None = None, plan_id: str | None = None
) -> dict[str, Any] | None:
    """The part `which` ("verified" or "unverified") names, of `plan_id` when given; by default the
    delivered work, else the first kept part (verified before unverified)."""
    parts: list[dict[str, Any]] = [part for part in (work or {}).get("parts") or [] if isinstance(part, dict)]
    if plan_id:
        parts = [part for part in parts if part.get("plan_id") == plan_id or part.get("delivered")]
    if which in ("verified", "unverified"):
        parts = [part for part in parts if part.get("trust") == which]
    ranked = sorted(parts, key=lambda part: (not part.get("delivered"), part.get("trust") != "verified"))
    return ranked[0] if ranked else None


# -- merge ----------------------------------------------------------------------------------


def merge_words(part: dict[str, Any] | None) -> tuple[str | None, str | None]:
    """What Merge would take (`verified`, `partial` or `unverified`) and the extra confirmation it needs."""
    if part is None:
        return None, None
    if part.get("delivered") and part.get("partial"):
        held = _names([str(task.get("task_id")) for task in part.get("tasks") or [] if task.get("task_id")])
        lacks = _names(
            [str(task.get("task_id")) for task in part.get("missing") or [] if task.get("task_id")]
        )
        return "partial", (
            f"The plan did not finish: this takes only the work that passed its checks ({held})"
            + (f", without {lacks}" if part.get("missing") else "")
            + ". Merge it anyway?"
        )
    if part.get("delivered") and part.get("checks_finished") is False:
        return "partial", (
            "roko stopped before it finished checking this run: each task's own check passed, but the "
            "checks roko runs on the delivered work may not have finished. Merge it anyway?"
        )
    if part.get("delivered"):
        return "verified", None
    tasks = _names([str(task.get("task_id")) for task in part.get("tasks") or [] if task.get("task_id")])
    if part["trust"] == "verified" and part.get("stopped"):
        return "partial", (
            f"Each task passed its own check ({tasks}), but {part['stopped']} stopped roko's check of the "
            "merged work before it ended. Merge it anyway?"
        )
    if part["trust"] == "verified":
        return "partial", (
            f"The plan did not finish: this takes only the work that passed its checks ({tasks}), "
            "without the rest of the plan. Merge it anyway?"
        )
    return "unverified", (
        f"No check ran on this work ({tasks}), so roko could not verify it. Read the changes first. "
        "Merge it anyway?"
    )


def merge_state(
    workdir: Path | None,
    part: dict[str, Any] | None,
    *,
    run_id: str,
    terminal: bool,
    demo: bool = False,
) -> dict[str, Any]:
    """Whether Merge can take `part` into the checkout now, read from the checkout alone.

    The public keys are the card's `merge`; `_commit` (the full commit) and `_workdir` are what a merge
    needs. Nothing here writes.
    """
    work, confirm = merge_words(part)
    out: dict[str, Any] = {
        "available": False,
        "merged": False,
        "reason": None,
        "demo": demo,
        "work": work,
        "confirm": confirm,
        "dirty": [],
        "fix": None,
        "mode": None,
        "into": None,
        "branch": part.get("branch") if part else None,
        "commit": None,
        "plan_id": part.get("plan_id") if part else None,
        "command": None,
    }
    if not terminal:
        out["reason"] = "the run is still going"
        return out
    if demo:
        out["reason"] = "demo output: it stays on its run branch"
        out["confirm"] = None
        return out
    if part is None:
        out["reason"] = "this run left no changes to merge"
        return out
    if part.get("merged"):
        out["merged"] = True
        out["reason"] = "the checkout already has this run's work"
        if workdir is not None and workdir.is_dir():  # the branch that has it: "Merged into main"
            out["into"] = _git(workdir, "symbolic-ref", "--quiet", "--short", "HEAD") or None
        return out
    git = f"git -C {shlex.quote(str(workdir))}" if workdir else "git"
    target = str(part.get("branch") or part.get("commit") or "")
    out["command"] = f"{git} merge {shlex.quote(target)}" if target else None
    if workdir is None or not workdir.is_dir():
        out["reason"] = "roko's workspace is not on this machine, so merge it where roko runs"
        return out
    if _git(workdir, "rev-parse", "--is-inside-work-tree") != "true":
        out["reason"] = f"{workdir} is not a git checkout"
        return out
    if part.get("delivered") and not _is_batch(part.get("branch"), run_id):
        out["reason"] = "the run's work is not on its own batch branch"
        return out
    commit, problem = _resolve(workdir, part)
    if commit is None:
        out["reason"] = problem
        return out
    out["commit"] = commit[:12]
    into = _git(workdir, "symbolic-ref", "--quiet", "--short", "HEAD")
    if not into:
        out["reason"] = "the checkout is not on a branch (detached HEAD)"
        return out
    out["into"] = into
    if in_progress(workdir):
        out["reason"] = "a merge, rebase, cherry-pick or revert is in progress in the checkout"
        return out
    dirty = dirty_files(workdir)
    if dirty is None:
        out["reason"] = "git could not read the checkout's status"
        return out
    if dirty:
        out["dirty"] = dirty[:10]
        if dirty == [SETTINGS_FILE]:
            out["reason"] = (
                "roko.toml has a change that is not committed yet (the setup fix makes one): "
                "commit roko.toml, then merge"
            )
            out["fix"] = commit_fix(workdir)
        else:
            count = len(dirty)
            shown = ", ".join(dirty[:3]) + (f" and {count - 3} more" if count > 3 else "")
            out["reason"] = (
                f"the checkout has uncommitted changes to {count} tracked file{'s' if count != 1 else ''} "
                f"({shown}); commit or stash them first"
            )
        return out
    if _git_ok(workdir, "merge-base", "--is-ancestor", commit, "HEAD"):
        out["merged"] = True
        out["reason"] = "the checkout already has this run's work"
        return out
    if _git_ok(workdir, "merge-base", "--is-ancestor", "HEAD", commit):
        out.update(available=True, mode="fast-forward")
        out["command"] = f"{git} merge --ff-only {shlex.quote(target)}"
    else:
        clean_merge, detail = merges_cleanly(workdir, commit)
        if not clean_merge:
            out["reason"] = detail
            return out
        out.update(available=True, mode="merge")
    out["_commit"] = commit
    out["_workdir"] = workdir
    return out


def _resolve(workdir: Path, part: dict[str, Any]) -> tuple[str | None, str | None]:
    """The full commit Merge would take for `part`, or None and why not.

    Delivered work is the batch branch's tip, which must still be the commit roko reported. Kept work is
    its commit, which its plan branch may have moved past.
    """
    short = str(part.get("commit") or "")
    branch = str(part.get("branch") or "")
    if part.get("delivered"):
        tip = _git(workdir, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}")
        if not tip:
            return None, f"the branch {branch} is not in {workdir}"
        if short and not tip.startswith(short):
            return None, "the branch no longer points at the commit roko reported"
        return tip, None
    found = (
        _git(workdir, "rev-parse", "--verify", "--quiet", f"{short}^{{commit}}")
        if _SHA.match(short)
        else None
    )
    if not found:
        return None, f"the run's commit {short or '?'} is not in {workdir}"
    return found, None


def _is_batch(branch: Any, run_id: str) -> bool:
    return (
        isinstance(branch, str) and branch.startswith(BATCH_PREFIX) and branch[len(BATCH_PREFIX) :] == run_id
    )


def merges_cleanly(workdir: Path, commit: str) -> tuple[bool, str]:
    """Whether `commit` merges into HEAD without a conflict, checked by a merge that writes no files."""
    ok, output = _git_run(workdir, "merge-tree", "--write-tree", "--no-messages", "HEAD", commit)
    if ok:
        return True, ""
    if "usage:" in output or "unknown option" in output:  # git older than 2.38
        return False, "this git cannot check a merge without making it, so merge it in a terminal"
    return False, "the run's changes conflict with the checkout's branch, so merge it in a terminal"


def in_progress(workdir: Path) -> bool:
    for name in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"):
        path = _git(workdir, "rev-parse", "--git-path", name)
        if path and (Path(path) if Path(path).is_absolute() else workdir / path).exists():
            return True
    return False


def dirty_files(workdir: Path) -> list[str] | None:
    """The tracked files with uncommitted changes, or None when git cannot say."""
    ok, output = _git_run(workdir, "status", "--porcelain=v1", "-z", "--untracked-files=no")
    if not ok:
        return None
    files: list[str] = []
    entries = output.split("\0")
    index = 0
    while index < len(entries):
        entry = entries[index]
        index += 1
        if len(entry) < 4:
            continue
        files.append(clean(entry[3:], 300, one_line=True))
        if entry[0] in "RC":  # a rename or copy names its source next
            index += 1
    return files


# -- committing roko.toml for the person ------------------------------------------------------


def commit_fix(workdir: Path) -> dict[str, Any]:
    """The setup fix's shape for "commit roko.toml" (applied through GET/POST /setup/fix)."""
    git = f"git -C {shlex.quote(str(workdir))}"
    return {
        "kind": "action",
        "label": "commit roko.toml",
        "action": COMMIT_ACTION,
        "command": f'{git} commit -m "{SETTINGS_MESSAGE}" -- {SETTINGS_FILE}',
        "docs": None,
    }


COMMIT_ACTION = "commit-roko-toml"


def commit_preview(workdir: Path | None) -> dict[str, Any]:
    """What committing roko.toml would record: its diff against HEAD, to read before applying."""
    path = _settings_path(workdir)
    diff = _git(path.parent, "diff", "--no-color", "--no-ext-diff", "HEAD", "--", SETTINGS_FILE) or ""
    git = f"git -C {shlex.quote(str(path.parent))}"
    out: dict[str, Any] = {
        "action": COMMIT_ACTION,
        "title": "Commit roko.toml",
        "variant": None,
        "variants": [],
        "preview": diff,
        "path": str(path),
        "summary": (
            f'Records the change in roko.toml as one commit, "{SETTINGS_MESSAGE}", on the checkout\'s '
            "current branch. Nothing else is committed. Merge needs a checkout with no uncommitted changes "
            "to tracked files."
            if diff
            else "roko.toml has no uncommitted change: nothing to commit."
        ),
        "digest": _digest(diff),
        "note": f"Your git name and email sign the commit. To undo it: {git} reset --soft HEAD~1",
    }
    return out


def commit_settings(workdir: Path | None, digest: str | None) -> dict[str, Any]:
    """Commit roko.toml alone, exactly as previewed (`digest`), with the person's git identity."""
    from .errors import Code, RokoError

    path = _settings_path(workdir)
    repo = path.parent
    diff = _git(repo, "diff", "--no-color", "--no-ext-diff", "HEAD", "--", SETTINGS_FILE) or ""
    out: dict[str, Any] = {"action": COMMIT_ACTION, "variant": None, "path": str(path), "next": None}
    if not diff:
        return {
            **out,
            "done": False,
            "ready": True,
            "summary": "roko.toml has no uncommitted change.",
            "message": "Nothing to commit: roko.toml has no uncommitted change.",
        }
    if digest is not None and digest != _digest(diff):
        raise RokoError(
            Code.CONFLICT,
            "roko.toml changed since you read the preview, so nothing was committed",
            hint="look at the preview again, then commit",
        )
    if in_progress(repo):
        raise RokoError(Code.REFUSED, "a merge, rebase, cherry-pick or revert is in progress in the checkout")
    if not _git(repo, "symbolic-ref", "--quiet", "--short", "HEAD"):
        raise RokoError(
            Code.REFUSED, "the checkout is not on a branch (detached HEAD), so nothing was committed"
        )
    ok, output = _git_run(
        repo, "commit", "-q", "-m", SETTINGS_MESSAGE, "--", SETTINGS_FILE, timeout=COMMIT_TIMEOUT_S
    )
    if not ok:
        raise RokoError(
            Code.REFUSED,
            "git did not commit roko.toml: " + clean(output, 300, one_line=True),
            hint=f"commit it in a terminal: {commit_fix(repo)['command']}",
        )
    head = _git(repo, "rev-parse", "--short=12", "HEAD")
    return {
        **out,
        "done": True,
        "ready": True,
        "commit": head,
        "summary": f"Committed roko.toml ({head}).",
        "message": f"Committed roko.toml as {head}. Merge can take a run's work now.",
    }


def _settings_path(workdir: Path | None) -> Path:
    from .errors import Code, RokoError

    if workdir is None or not workdir.is_dir():
        raise RokoError(
            Code.FORBIDDEN,
            "roko's workspace is not on this machine, so the plugin cannot commit its roko.toml",
            hint="commit roko.toml where roko runs",
        )
    top = _git(workdir, "rev-parse", "--show-toplevel")
    if not top:
        raise RokoError(Code.FORBIDDEN, f"{workdir} is not a git checkout")
    path = Path(top) / SETTINGS_FILE
    if not path.is_file() or _git(Path(top), "ls-files", "--error-unmatch", SETTINGS_FILE) is None:
        raise RokoError(Code.INVALID, "roko.toml is not a file git tracks in this checkout")
    return path


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", "replace")).hexdigest()[:16]


# -- helpers ----------------------------------------------------------------------------------


def _tasks(value: Any) -> list[dict[str, Any]]:
    out = []
    for row in value if isinstance(value, list) else []:
        if isinstance(row, dict) and row.get("task_id"):
            out.append(
                {
                    "task_id": clean(row.get("task_id"), 80, one_line=True),
                    "verdict": clean(row.get("verdict"), 40, one_line=True) or None,
                }
            )
        elif isinstance(row, str) and row:
            out.append({"task_id": clean(row, 80, one_line=True), "verdict": None})
    return out[:20]


def _names(names: list[str]) -> str:
    shown = names[:4]
    more = len(names) - len(shown)
    if not shown:
        return "its tasks"
    text = ", ".join(shown)
    return text + (f" and {more} more" if more else "")


def _trailer(message: str, key: str) -> str | None:
    """The value of the last `<key>: <value>` line in a commit message."""
    prefix = key + ":"
    for line in reversed(message.splitlines()):
        if line.startswith(prefix):
            return line[len(prefix) :].strip()
    return None


def _sha(value: Any) -> str | None:
    text = clean(value, 64, one_line=True).lower()
    return text if _SHA.match(text) else None


def _short(value: Any) -> str | None:
    found = _sha(value)
    return found[:12] if found else None


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _safe_ref(value: str) -> bool:
    return (
        bool(value)
        and all(ch.isalnum() or ch in "-_./" for ch in value)
        and ".." not in value
        and not value.startswith(("/", "-", "."))
        and not value.endswith(("/", ".lock"))
    )


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
        logger.debug("roko: git %s failed: %s", args[0] if args else "", exc)
        return False, str(exc)
    return proc.returncode == 0, proc.stdout if proc.returncode == 0 else (proc.stderr or proc.stdout)

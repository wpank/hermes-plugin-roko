"""A plan as a document (round v6, P8): what the plan sheet shows beside the tasks and their waves.

roko serves a plan's tasks (`GET /api/plans/{id}/tasks`) and its `tasks.toml` (`/source`); this adds what
makes a plan read as a document: its `plan.md` condensed to headings and first paragraphs, its rubric, each
task's acceptance criteria with the checks that cover them, its start rung on the workspace's model ladder,
and the estimate by rung. roko serves no `plan.md` or `rubric.md`, so those are read from the plan's folder in
the workspace, when the plugin shares roko's workdir. A plan `roko plan import --mori` wrote says so
(`imported_from`).
"""

from __future__ import annotations

import logging
import re
import tomllib
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import resume, runlog, tools
from .errors import RokoError
from .runtime import Runtime
from .sanitize import clean

logger = logging.getLogger(__name__)

DOC_BYTES = 8 * 1024
RUBRIC_BYTES = 4 * 1024
SECTION_CHARS = 1_200
COMMAND_CHARS = 400
# The most of a plan's files read, whatever their size.
READ_BYTES = 256 * 1024
# The comment `roko plan import --mori` heads a plan's tasks.toml with.
_MORI = re.compile(r"^# Imported from the mori plan `([^`]{1,200})`")
# roko's id of an acceptance item: its own `ACn` prefix (TSS v1, roko-gate `ac_id`).
_AC_ID = re.compile(r"^\s*(AC\d{1,4})\b[:.)]?\s*")
# A check of the plan's source (its spec), as roko's planner numbers them (gap-dc5d7c), and the ids that open
# a criterion's text ("SC2: …", "SC1, SC3: …").
_SC_ID = re.compile(r"\bSC\d{1,4}\b")
_SC_LEAD = re.compile(r"^\s*SC\d{1,4}(?:\s*,\s*SC\d{1,4})*\s*:\s*")
# An ATX heading: its #s, then its text. Its closing #s are taken off in `_heading`, not here: a pattern that
# also matched them, around runs of spaces, took cubic time on a line with a long run of spaces.
_HEADING = re.compile(r"^(#{1,6})(?:\s+(.*))?$")
# What a criterion quotes, a name a test runner takes, and the dotted words of a command (P8 links).
_QUOTED = re.compile(r"`([^`\n]{1,300})`")
_NAME = re.compile(r"[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*")
_TOKEN = re.compile(r"[\w.]+")
# One part of a plan's folder path (its plan set's parts, its id), and the heads of the tasks.toml files the
# plan list read, by path, with when each changed.
_SEGMENT = re.compile(r"[A-Za-z0-9][\w.-]{0,120}")
_HEADS: dict[str, tuple[int, dict[str, Any] | None]] = {}
MAX_HEADS = 512


def plan_sheet(rt: Runtime, plan_id: str) -> dict[str, Any]:
    """`GET /plans/{id}`: the plan as the plan list knows it, its tasks and waves and roko's estimate
    (`tools.plan_detail`), and the document it is: `doc`, `rubric`, each task's acceptance and named checks,
    its start rung, the whole-plan check, and the estimate by rung (docs/ui-api.md, 0.6.0)."""
    settings = rt.settings()
    client = rt.client(settings)
    plan = tools.plan_detail(client, plan_id, detail=True)
    if "resumable_run" not in plan:  # an older roko: the plan's last run in the run log (P-14)
        plan["resumable_run"] = resume.predicted(rt, plan_id)
    found = plan.get("estimate")
    estimate: dict[str, Any] = found if isinstance(found, dict) else {}
    by_rung = estimate.pop("_by_rung", None)
    per_task = {str(row.get("task_id")): row for row in estimate.pop("_per_task", None) or []}
    source, path = _source(client, plan_id)
    authored = {str(task.get("id")): task for task in source.get("task") or [] if isinstance(task, dict)}
    ladder = rt.cards.ladder_view(client, settings.workdir)
    starts = {str(tier): str(rung.get("rung")) for rung in ladder or [] for tier in rung.get("starts") or []}
    first = str(ladder[0].get("rung")) if ladder else None
    for row in plan.get("tasks") or []:
        task = authored.get(str(row.get("id"))) or {}
        acceptance = acceptance_rows(task)
        row["verify"] = checks(task.get("verify"), "verify")
        link_checks(acceptance, row["verify"])
        row["acceptance"] = acceptance
        tier = str(task.get("tier") or row.get("tier") or "focused")
        row["start_rung"] = starts.get(tier, first) if ladder else None
        priced = per_task.get(str(row.get("id")))
        if priced is not None and priced.get("start_rung"):  # roko's own start rung for it (R7)
            row["start_rung"] = clean(priced["start_rung"], 40, one_line=True)
        row["estimate"] = task_estimate(priced)
        # What it must also do that no check proves (a mori import's block, the lead's option B).
        text, row["also_required"], row["also_required_judged_in_review"], row["also_required_more"] = (
            also_required(str(task.get("description") or row.get("description") or ""))
        )
        if row["also_required"]:
            row["description"] = clean(text, 4_000) or None
        row["section"] = clean(task.get("plan_section"), 200, one_line=True) or None
        row["goal"] = clean(task.get("goal"), 600) or None
        row["non_goals"] = [clean(item, 300, one_line=True) for item in _strings(task.get("non_goals"))][:10]
    meta: dict[str, Any] = source["meta"] if isinstance(source.get("meta"), dict) else {}
    plan["plan_checks"] = checks(meta.get("verify"), "plan")
    plan["dropped_checks"] = dropped_checks(meta)
    folder = _folder(settings.workdir, path)
    root = Path(settings.workdir).resolve() if settings.workdir else None
    plan["doc"] = plan_doc(folder, path, root=root)
    plan["rubric"] = _rubric(folder, path, root=root)
    plan["imported_from"] = _imported(source.get("_header", ""))
    plan["asked"] = asked_for(rt, plan_id)
    if isinstance(plan.get("estimate"), dict):
        plan["estimate"].update(_by_rung(plan["estimate"], plan.get("tasks") or [], ladder, by_rung))
    return plan


def asked_for(rt: Runtime, plan_id: str) -> dict[str, Any] | None:
    """What was asked for the plan (P-1): the request of its newest writing in the run log, the spec it named,
    and whose words they are (`by`: "chat", the chat model's, or "page", the person's). roko's plan sheet does
    not repeat a chat's request ("it is untrusted data"), so the person saw the chat model's rewording only in
    Hermes' tool-call arguments. With what writing it cost and the cap it ran under (P-43), as the run log has
    them. None when no writing of the plan is logged (roko's CLI, another tool)."""
    for run in rt.runs.recent(runlog.MAX_RUNS):
        if run.get("kind") != "plan_generate" or run.get("plan_id") != plan_id:
            continue
        said = clean(run.get("request"), runlog.REQUEST_CHARS) or None
        spec = clean(run.get("spec_path"), 300, one_line=True) or None
        if said is None and spec is None:
            return None
        return {
            "text": said,
            "spec_path": spec,
            "by": "page" if run.get("source") == "ui" else "chat",
            "run_id": run.get("run_id"),
            "at": run.get("started_at"),
            "cost_usd": _money(run.get("cost_usd")),
            "max_usd": _money(run.get("max_usd")),
        }
    return None


def _money(value: Any) -> float | None:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _source(client: Any, plan_id: str) -> tuple[dict[str, Any], str | None]:
    """The plan's tasks.toml as roko serves it (`GET /api/plans/{id}/source`), parsed, with its header comment
    kept under `_header`; and its path in the workspace. ({}, None) when roko will not give it."""
    try:
        body = client.get(f"/api/plans/{quote(plan_id, safe='')}/source")
    except RokoError as exc:
        logger.debug("roko: no source for plan %s: %s", plan_id, exc)
        return {}, None
    text = str(body.get("toml") or "") if isinstance(body, dict) else ""
    try:
        parsed = tomllib.loads(text)
    except tomllib.TOMLDecodeError as exc:
        logger.debug("roko: plan %s's tasks.toml does not parse: %s", plan_id, exc)
        parsed = {}
    parsed["_header"] = text[:400]
    path = body.get("path") if isinstance(body, dict) and isinstance(body.get("path"), str) else None
    return parsed, path


def acceptance_rows(task: dict[str, Any]) -> list[dict[str, Any]]:
    """A task's acceptance criteria (`Acceptance`): each with roko's id, its own `ACn` prefix or its place,
    and the source checks it keeps (the `SCk` ids it names, as roko's planner writes them: "AC1: SC2: …")."""
    rows = []
    for index, item in enumerate(_strings(task.get("acceptance"))[:40]):
        found = _AC_ID.match(item)
        text = item[found.end() :] if found else item
        named = list(dict.fromkeys(_SC_ID.findall(text)))[:10]
        rows.append(
            {
                "id": found[1] if found else f"AC{index + 1}",
                "text": clean(_SC_LEAD.sub("", text), 600),
                "checks": [],
                "source_checks": named,
            }
        )
    return rows


def link_checks(acceptance: list[dict[str, Any]], verify: list[dict[str, Any]]) -> None:
    """Each criterion's checks, and how they were found (`linked_by`): the steps whose `covers` names it or a
    source check it keeps; or, when no step of the task declares `covers` (a mori import writes none), the
    steps whose command the criterion quotes: the whole command, or a test or module name it runs."""
    declared = any(check["covers"] for check in verify)
    for item in acceptance:
        if declared:
            # A step covers a criterion by its id, or by a source check the criterion keeps.
            ids = {item["id"], *item["source_checks"]}
            item["checks"] = [check["name"] for check in verify if ids & set(check["covers"])]
        else:
            item["checks"] = quoted_checks(item["text"], verify)
        item["linked_by"] = ("covers" if declared else "quote") if item["checks"] else None


def quoted_checks(text: str, verify: list[dict[str, Any]]) -> list[str]:
    """The checks whose command a criterion quotes in backticks: the whole command, or a name a test runner
    takes (one with `_` or `.`, at least 4 characters) that matches whole dotted parts of the command. So
    `test_locked_loop_repeats` finds `… tests.test_turing.TuringMachineTest.test_locked_loop_repeats`, and
    `tests.test_turing` finds `python3 -m unittest tests.test_turing`, but `test_lock` finds neither."""
    quoted = [" ".join(span.split()) for span in _QUOTED.findall(text)]
    if not quoted:
        return []
    found = []
    for check in verify:
        command = " ".join(str(check.get("command") or "").split())
        names = [token.strip(".").split(".") for token in _TOKEN.findall(command)]
        for span in quoted:
            parts = span.split(".")
            named = (
                bool(_NAME.fullmatch(span))
                and len(span) >= 4
                and ("_" in span or "." in span)
                and any(
                    name[index : index + len(parts)] == parts
                    for name in names
                    for index in range(len(name) - len(parts) + 1)
                )
            )
            if span == command or named:
                found.append(str(check["name"]))
                break
    return found


def listed_import(workdir: Path | None, group: Any, plan_id: Any) -> dict[str, Any] | None:
    """`imported_from` for a plan list row: the head of its tasks.toml in the workspace's plans folder
    (`plans/`, else `.roko/plans/`, as roko resolves it), under its plan set; None when it is not there, or
    is a link out of the workspace (as `_read` refuses one)."""
    if workdir is None or not isinstance(plan_id, str):
        return None
    parts = [*(group.split("/") if isinstance(group, str) and group else []), plan_id]
    if not all(_SEGMENT.fullmatch(part) for part in parts):
        return None
    top = workdir / "plans"
    path = (top if top.is_dir() else workdir / ".roko" / "plans").joinpath(*parts, "tasks.toml")
    try:
        if not path.resolve().is_relative_to(workdir.resolve()):
            return None
        stamp = path.stat().st_mtime_ns
    except (OSError, RuntimeError):
        return None
    key = str(path)
    if key in _HEADS and _HEADS[key][0] == stamp:
        return _HEADS[key][1]
    try:
        with path.open("rb") as handle:
            head = handle.read(400).decode("utf-8", "replace")
    except OSError:
        return None
    if len(_HEADS) >= MAX_HEADS:
        _HEADS.clear()
    _HEADS[key] = (stamp, _imported(head))
    return _HEADS[key][1]


# The block a mori import ends a task's description with: the criteria no check proves (the lead's option B).
ALSO_REQUIRED = "Also required, not checked automatically:"
JUDGED_IN_REVIEW = "(the review task judges these)"
# As many as the pages show (20 items of 600 characters). Lines past the cap stay in the description, which
# the pages show too: the bardo corpus' largest block holds 39 (roko 537ac5411).
MAX_ALSO_REQUIRED = 20
ALSO_REQUIRED_CHARS = 600


def also_required(description: str) -> tuple[str, list[str], bool, int]:
    """A task's description without its "Also required, not checked automatically:" block, the block's "- "
    lines (at most MAX_ALSO_REQUIRED, each cut at ALSO_REQUIRED_CHARS with a visible "…"), whether the block
    says the plan's review task judges them, and how many lines it holds past the cap. Those lines are never
    dropped: they stay in the description, after a blank line, and so do lines a person wrote after the block,
    below them. The description as it is, [], False and 0 without the block."""
    lines = description.splitlines()
    start = next((index for index, line in enumerate(lines) if line.strip() == ALSO_REQUIRED), None)
    if start is None:
        return description, [], False, 0
    items: list[str] = []
    beyond: list[str] = []
    judged = False
    end = len(lines)
    for index in range(start + 1, len(lines)):
        stripped = lines[index].strip()
        if stripped == JUDGED_IN_REVIEW and not items:
            judged = True
        elif stripped.startswith("- "):
            item = clean(stripped[2:], ALSO_REQUIRED_CHARS)
            if item and len(items) < MAX_ALSO_REQUIRED:
                items.append(item)
            elif item:
                beyond.append(stripped)
        elif stripped:
            end = index  # the block ends at the first other line
            break
    parts = ["\n".join(lines[:start]).rstrip(), "\n".join(beyond), "\n".join(lines[end:]).strip()]
    return "\n\n".join(part for part in parts if part), items, judged, len(beyond)


def dropped_checks(meta: dict[str, Any]) -> list[dict[str, str]]:
    """The source's checks a plan does not keep, and why (`[meta] dropped_checks`: "SC3: <why>")."""
    rows = []
    for entry in _strings(meta.get("dropped_checks"))[:40]:
        ident, _, reason = entry.partition(":")
        if _SC_ID.fullmatch(ident.strip()) and reason.strip():
            rows.append({"id": ident.strip(), "reason": clean(reason.strip(), 300, one_line=True)})
    return rows


def checks(value: Any, kind: str) -> list[dict[str, Any]]:
    """Verify steps as checks (`Check`), named as a run names them: `verify[0:test]` for a task's,
    `plan[0:compile]` for a whole-plan check."""
    out = []
    for index, step in enumerate(value if isinstance(value, list) else []):
        if not isinstance(step, dict) or not isinstance(step.get("command"), str):
            continue
        phase = clean(step.get("phase"), 60, one_line=True) or None
        out.append(
            {
                "name": f"{kind}[{index}:{phase or 'check'}]",
                "phase": phase,
                "command": clean(step["command"], COMMAND_CHARS, one_line=True),
                "fail_msg": clean(step.get("fail_msg"), 300, one_line=True) or None,
                "covers": [clean(item, 20, one_line=True) for item in _strings(step.get("covers"))][:20],
                "expect": clean(step.get("expect"), 40, one_line=True) or None,
            }
        )
        if len(out) >= 30:
            break
    return out


def plan_doc(folder: Path | None, path: str | None, *, root: Path | None = None) -> dict[str, Any] | None:
    """plan.md condensed (`PlanDoc`): its title, and each heading with the first paragraph (or list) under it;
    the text before the first heading too. None without the file, or for one that is a link out of `root` (the
    workspace; the plan's folder without one)."""
    text = _read(folder, "plan.md", root)
    if text is None or folder is None:
        return None
    sections: list[dict[str, Any]] = []
    current: dict[str, Any] = {"heading": None, "level": 0, "lines": [], "blocks": 0, "taking": False}
    for line in _body(text).splitlines():
        heading = _heading(line)
        if heading:
            sections.append(current)
            current = {
                "heading": heading[1],
                "level": heading[0],
                "lines": [],
                "blocks": 0,
                "taking": False,
            }
            continue
        if line.strip() in ("", "---", "***", "___"):
            if current["taking"]:
                current["taking"] = False
                current["blocks"] += 1
            continue
        # The title's section keeps its first two paragraphs (a goal and what it depends on, say); others one.
        if current["blocks"] < (2 if current["level"] <= 1 else 1):
            if not current["taking"] and current["lines"]:
                current["lines"].append("")  # a paragraph after the first: markdown's blank line between them
            current["taking"] = True
            current["lines"].append(line.rstrip())
    sections.append(current)
    rows = [
        {
            "heading": clean(section["heading"], 200, one_line=True) if section["heading"] else None,
            "level": section["level"],
            "text": _clip("\n".join(section["lines"]).strip(), SECTION_CHARS),
        }
        for section in sections
        if section["heading"] or section["lines"]
    ]
    markdown, truncated = _join(rows)
    title = next((row["heading"] for row in rows if row["heading"]), None)
    return {
        "title": title,
        "sections": rows[:60],
        "markdown": markdown,
        "truncated": truncated or len(rows) > 60 or len(text.encode()) > len(markdown.encode()),
        "path": str(Path(path).parent / "plan.md") if path else "plan.md",
    }


def _rubric(folder: Path | None, path: str | None, *, root: Path | None = None) -> dict[str, Any] | None:
    text = _read(folder, "rubric.md", root)
    if text is None:
        return None
    clipped = _clip(clean(text.strip()), RUBRIC_BYTES)
    return {
        "markdown": clipped,
        "truncated": len(clipped) < len(text.strip()),
        "path": str(Path(path).parent / "rubric.md") if path else "rubric.md",
    }


def _imported(header: str) -> dict[str, Any] | None:
    found = _MORI.match(header)
    return {"kind": "mori", "plan": clean(found[1], 200, one_line=True)} if found else None


def task_estimate(priced: dict[str, Any] | None) -> dict[str, Any] | None:
    """A task's estimate from roko's per-task estimate (R7): likely and worst cost, the likely time, the rungs
    its worst case climbs, its first-try rate, and what that rests on. None from a roko before R7."""
    if priced is None:
        return None

    def number(key: str) -> float | None:
        value = priced.get(key)
        return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None

    seconds = number("likely_duration_secs")
    samples = priced.get("samples")
    return {
        "likely_usd": number("likely_cost_usd"),
        "likely_secs": round(seconds) if seconds is not None else None,
        "worst_usd": number("worst_cost_usd"),
        "worst_rungs": [clean(rung, 40, one_line=True) for rung in _strings(priced.get("worst_rungs"))][:12],
        "first_try_rate": number("first_try_rate"),
        "basis": clean(priced.get("basis"), 40, one_line=True) or None,
        "samples": int(samples) if isinstance(samples, int) and not isinstance(samples, bool) else None,
    }


def _by_rung(
    estimate: dict[str, Any],
    tasks: list[dict[str, Any]],
    ladder: Any,
    priced: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The estimate by rung: the tasks that start on each rung, cheapest first, with roko's likely cost of
    them there (its per-task estimate, R7; null before it)."""
    if not ladder:
        return {
            "by_rung": None,
            "likely_usd": estimate.get("likely_usd"),
            "worst_usd": estimate.get("worst_usd"),
            "cap_usd": estimate.get("cap_usd"),
            "unpriced_tasks": estimate.get("unpriced_tasks") or [],
            "start_rung": None,
        }
    likely = {
        str(row.get("rung")): float(row["likely_cost_usd"])
        for row in priced or []
        if isinstance(row.get("likely_cost_usd"), (int, float))
        and not isinstance(row.get("likely_cost_usd"), bool)
    }
    rows = [
        {
            "rung": str(rung.get("rung")),
            "model": rung.get("slug") or rung.get("model"),
            "tasks": [str(task.get("id")) for task in tasks if task.get("start_rung") == rung.get("rung")],
            "likely_usd": likely.get(str(rung.get("rung"))),
        }
        for rung in ladder
    ]
    busiest = max(rows, key=lambda row: len(row["tasks"])) if any(row["tasks"] for row in rows) else None
    return {
        "by_rung": rows,
        "likely_usd": estimate.get("likely_usd"),
        "worst_usd": estimate.get("worst_usd"),
        "cap_usd": estimate.get("cap_usd"),
        "unpriced_tasks": estimate.get("unpriced_tasks") or [],
        "start_rung": busiest["rung"] if busiest else None,
    }


# -- helpers --------------------------------------------------------------------------------------------


def _folder(workdir: Any, path: str | None) -> Path | None:
    """The plan's folder in the workspace, from the path roko gives its tasks.toml; None outside it."""
    if not workdir or not path:
        return None
    root = Path(workdir).resolve()
    folder = (root / path).resolve().parent
    return folder if folder.is_relative_to(root) and folder.is_dir() else None


def _read(folder: Path | None, name: str, root: Path | None = None) -> str | None:
    """The file `name` in the plan's folder, unless it is a link to a file outside `root` (the workspace; the
    folder itself without one): a plan.md linked to a key file must not reach the page."""
    if folder is None:
        return None
    try:
        target = (folder / name).resolve()
        if not target.is_relative_to((root or folder).resolve()):
            return None
        with target.open("rb") as handle:
            data = handle.read(READ_BYTES)
    except (OSError, RuntimeError):
        return None
    return data.decode("utf-8", errors="replace")


def _heading(line: str) -> tuple[int, str] | None:
    """A markdown heading's level and text, its closing #s gone (a run of #s after a space, as markdown reads
    it: `## Next ##` is "Next", `### C#` is "C#"); None for any other line. Linear in the line's length."""
    found = _HEADING.match(line)
    if found is None:
        return None
    text = (found[2] or "").strip()
    bare = text.rstrip("#")
    if bare != text and (not bare or bare[-1].isspace()):
        text = bare.rstrip()
    return len(found[1]), text


def _body(text: str) -> str:
    """Markdown without its front matter (`---` … `---` at the top)."""
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            return text[end + 4 :]
    return text


def _join(rows: list[dict[str, Any]]) -> tuple[str, bool]:
    """The condensed document as one markdown text, at most DOC_BYTES; and whether rows were left out."""
    parts: list[str] = []
    size = 0
    for row in rows:
        part = (f"{'#' * max(1, row['level'])} {row['heading']}\n\n" if row["heading"] else "") + row["text"]
        cost = len(part.encode()) + 2
        if size + cost > DOC_BYTES:
            return "\n\n".join(parts), True
        parts.append(part.strip())
        size += cost
    return "\n\n".join(parts), False


def _clip(text: str, limit: int) -> str:
    """`text` cut at a line or word at most `limit` characters in, with an ellipsis when cut."""
    if len(text) <= limit:
        return text
    cut = text[: limit - 1]
    for mark in ("\n", " "):
        at = cut.rfind(mark)
        if at >= limit // 2:
            cut = cut[:at]
            break
    return cut.rstrip() + "…"


def _strings(value: Any) -> list[str]:
    return [
        item for item in (value if isinstance(value, list) else []) if isinstance(item, str) and item.strip()
    ]

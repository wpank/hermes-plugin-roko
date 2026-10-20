"""A project's build (round v7, #3): its phases in order, as one piece of work.

A long build (Metakosmia Undertow: six phases, each a spec, then a plan, then its runs) reads here as one
thing: which phases passed, which one runs, what is written and what is only specified, what the build cost
and took, and what roko's cheap rungs saved across the whole of it. A phase is found from

- a spec, `docs/specs/phase-<n>-<slug>.md` in the project, whose first lines say "# Phase <n>: <name>" and
  "**Goal**: …";
- a plan titled "P<n> · <name>" ("Title: P<n> · …" too: a planner may keep the request's word) or named
  `p<n>-<slug>` (`title-p<n>-…`).

Its runs are the ones Hermes started (the run log); its task counts are roko's plan row (`tasks_done` of
`task_count`), which hold across a resume. Nothing here starts work or reads a run's events: a run's receipt
is the one the run log kept when its whole card was read.
"""

from __future__ import annotations

import logging
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import tools, views
from .catalog import TERMINAL_STATES
from .errors import RokoError
from .runtime import Runtime
from .sanitize import clean

logger = logging.getLogger(__name__)

SPEC_DIR = Path("docs") / "specs"
_SPEC_FILE = re.compile(r"^phase-(\d{1,2})-([a-z0-9][a-z0-9-]{0,60})\.md$")
_SPEC_TITLE = re.compile(r"^#\s*phase\s+\d{1,2}\s*[:·.\-–—]\s*(.+?)\s*$", re.I)
_SPEC_GOAL = re.compile(r"^\*\*goal\*\*\s*:?\s*(.+)$", re.I)
_PLAN_TITLE = re.compile(r"^(?:title:\s*)?p(\d{1,2})\s*[·:.\-–—]\s*(.+?)\s*$", re.I)
_PLAN_ID = re.compile(r"^(?:title-)?p(\d{1,2})-([a-z0-9][a-z0-9-]*)$")
MAX_PHASES = 24
# A spec's head is read for its name and goal: at most this much of it.
SPEC_HEAD_BYTES = 8 * 1024
GOAL_CHARS = 240
# The ended runs whose receipt the run log lacks, listed so a page can open them (and so read it) one by one.
UNREAD_LISTED = 8
# How a phase's latest run ended, as the build says it.
_STOPPED = {"failed": "failed", "cancelled": "cancelled", "interrupted": "interrupted", "missing": "missing"}


def plan_phase(plan_id: str, title: str | None) -> tuple[int, str] | None:
    """The phase a plan is, and its name, from its title ("P2 · Undertow rumble") or its id
    (`p2-undertow-rumble`)."""
    found = _PLAN_TITLE.match(clean(title, 200, one_line=True))
    if found:
        return int(found[1]), found[2]
    found = _PLAN_ID.match(plan_id or "")
    if found:
        return int(found[1]), found[2].replace("-", " ")
    return None


def spec_phases(workdir: Path | None) -> dict[int, dict[str, Any]]:
    """The phases the project's specs name, by number: `{name, goal, spec}` (its path in the project)."""
    folder = workdir / SPEC_DIR if workdir is not None else None
    try:
        names = (
            sorted(path.name for path in folder.iterdir()) if folder is not None and folder.is_dir() else []
        )
    except OSError:
        return {}
    phases: dict[int, dict[str, Any]] = {}
    for name in names:
        found = _SPEC_FILE.match(name)
        if found is None or len(phases) >= MAX_PHASES or int(found[1]) in phases:
            continue
        title: str | None = None
        goal: str | None = None
        try:
            with (folder / name).open("rb") as handle:  # type: ignore[operator]
                head = handle.read(SPEC_HEAD_BYTES).decode("utf-8", errors="replace")
        except OSError:
            head = ""
        for line in head.splitlines()[:40]:
            if title is None and (named := _SPEC_TITLE.match(line.strip())):
                title = named[1]
            elif goal is None and (said := _SPEC_GOAL.match(line.strip())):
                goal = said[1]
        phases[int(found[1])] = {
            "name": clean(title or found[2].replace("-", " "), 80, one_line=True),
            "goal": clean(goal, GOAL_CHARS, one_line=True) or None,
            "spec": f"{SPEC_DIR.as_posix()}/{name}",
        }
    return phases


def _when(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=UTC)


def _wall_ms(run: dict[str, Any], now: datetime) -> int | None:
    started = _when(run.get("started_at"))
    ended = _when(run.get("finished_at")) or (now if run.get("state") not in TERMINAL_STATES else None)
    if started is None or ended is None or ended < started:
        return None
    return int((ended - started).total_seconds() * 1000)


def _cost(runs: list[dict[str, Any]]) -> float | None:
    costs = [float(run["cost_usd"]) for run in runs if isinstance(run.get("cost_usd"), (int, float))]
    return round(sum(costs), 6) if costs else None


def _phase_state(
    runs: list[dict[str, Any]], writing: list[dict[str, Any]], plan: dict[str, Any] | None, spec: bool
) -> tuple[str, str | None]:
    """Where a phase stands, and the state of its latest run when that says more ("failed")."""
    going = [run for run in runs if run.get("state") not in TERMINAL_STATES]
    if going:
        return ("queued" if all(run.get("state") == "queued" for run in going) else "running"), None
    if any(run.get("state") not in TERMINAL_STATES for run in writing):
        return "writing", None
    if runs:
        latest = str(runs[0].get("state") or "")
        if latest == "succeeded":
            return "passed", None
        if latest == "unverified":
            return "unverified", None
        return "stopped", _STOPPED.get(latest, latest or None)
    if plan is not None:
        total, done = plan.get("task_count"), plan.get("tasks_done")
        if isinstance(total, int) and total > 0 and done == total:
            return "passed", None  # roko's own word: run outside Hermes
        return "written", None
    return ("specified", None) if spec else ("written", None)


def build_view(rt: Runtime) -> dict[str, Any]:
    """`GET /build`: the project's phases in order and the build's totals (docs/ui-api.md)."""
    settings = rt.settings()
    specs = spec_phases(settings.workdir)
    try:
        plans = [row for row in tools.plan_list(rt.client(settings)) if not row.get("demo")]
        reachable = True
    except RokoError as exc:
        logger.debug("roko: no plan list for the build: %s", exc)
        plans, reachable = [], False
    phases: dict[int, dict[str, Any]] = {
        n: {"n": n, "name": spec["name"], "goal": spec["goal"], "spec": spec["spec"], "plans": []}
        for n, spec in specs.items()
    }
    for row in plans:
        found = plan_phase(str(row.get("id") or ""), row.get("title"))
        if found is not None and (found[0] in phases or len(phases) < MAX_PHASES):
            phase = phases.setdefault(
                found[0],
                {"n": found[0], "name": clean(found[1], 80, one_line=True), "goal": None, "spec": None},
            )
            phase.setdefault("plans", []).append(row)
    logged = [run for run in rt.runs.recent(200) if run.get("kind") in ("plan", "plan_generate")]
    here = str(settings.workdir) if settings.workdir is not None else None
    default = rt.root.settings().workdir
    mine = [run for run in logged if _in_project(run, here, default)]
    now = datetime.now(UTC)
    out: list[dict[str, Any]] = []
    # For the build's receipt: every phase's runs, and the passing run of each phase that passed.
    every: list[dict[str, Any]] = []
    passing: list[dict[str, Any]] = []
    for n in sorted(phases):
        phase = phases[n]
        candidates: list[dict[str, Any]] = phase.pop("plans", [])
        # Its plans: roko's, and those its runs name (the run log places them while roko is down).
        ids = {str(row.get("id")) for row in candidates} | {
            str(run["plan_id"])
            for run in mine
            if run.get("kind") == "plan" and run.get("plan_id") and _phase_of(run) == n
        }
        runs = [run for run in mine if run.get("kind") == "plan" and run.get("plan_id") in ids]
        writing = [
            run
            for run in mine
            if run.get("kind") == "plan_generate" and (run.get("plan_id") in ids or _phase_of(run) == n)
        ]
        runs.sort(key=lambda run: str(run.get("started_at") or ""), reverse=True)
        plan = _chosen(candidates, runs, n)
        plan_id = str(plan["id"]) if plan else (str(runs[0]["plan_id"]) if runs else None)
        state, ended = _phase_state(runs, writing, plan, phase["spec"] is not None)
        every += runs
        won = next((run for run in runs if run.get("state") == "succeeded"), None)
        if state == "passed" and won is not None:
            passing.append(won)
        latest = runs[0] if runs else None
        progress = latest.get("progress") if latest and isinstance(latest.get("progress"), dict) else None
        # roko's plan row (`tasks_done` holds across a resume), or what the latest run passed if more.
        total = plan.get("task_count") if plan else None
        done = plan.get("tasks_done") if plan else None
        ran = (progress or {}).get("passed") if latest and latest.get("plan_id") == plan_id else None
        if not isinstance(total, int) or total <= 0:
            total, done = (progress or {}).get("total"), ran
        elif isinstance(ran, int):
            done = min(total, max(ran, done if isinstance(done, int) else 0))
        walls = [ms for ms in (_wall_ms(run, now) for run in runs) if ms is not None]
        out.append(
            {
                **phase,
                "plan_id": plan_id,
                "title": plan.get("title") if plan else None,
                "state": state,
                "ended": ended,
                "tasks": {"passed": int(done or 0), "total": int(total)}
                if isinstance(total, int) and total
                else None,
                "runs": len(runs),
                "run_id": latest.get("run_id") if latest else None,
                "writing_id": writing[0].get("run_id") if writing else None,
                "cost_usd": _cost(runs + writing),
                "wall_ms": sum(walls) if walls else None,
                "rungs": latest.get("rungs") if latest and isinstance(latest.get("rungs"), list) else None,
            }
        )
    return {
        "project": views.project_ref(rt, {"project": here} if here else None),
        "reachable": reachable,
        "phases": out,
        "totals": _totals(out),
        "receipt": _receipt(every, passing),
        "next": _next(out),
    }


def _in_project(run: dict[str, Any], here: str | None, default: Path | None) -> bool:
    """Whether a logged run ran in the project shown: its own project, or the default one for a run logged
    before 0.7.0 (`Runtime.for_run`)."""
    project = run.get("project")
    if isinstance(project, str) and project.startswith("/"):
        return here is None or project == here
    return here is None or default is None or str(default) == here


def _chosen(candidates: list[dict[str, Any]], runs: list[dict[str, Any]], n: int) -> dict[str, Any] | None:
    """A phase's plan: the one its latest run ran, else the one named `p<n>-…`, else the first written."""
    if runs:
        for row in candidates:
            if row.get("id") == runs[0].get("plan_id"):
                return row
    plain = [row for row in candidates if str(row.get("id") or "").startswith(f"p{n}-")]
    return next(iter(plain or candidates), None)


def _phase_of(run: dict[str, Any]) -> int | None:
    """The phase a logged plan writing is for, from the plan it names or its label."""
    found = plan_phase(str(run.get("plan_id") or ""), run.get("label"))
    return found[0] if found else None


def _totals(phases: list[dict[str, Any]]) -> dict[str, Any]:
    tasks = [phase["tasks"] for phase in phases if phase["tasks"]]
    costs = [phase["cost_usd"] for phase in phases if phase["cost_usd"] is not None]
    walls = [phase["wall_ms"] for phase in phases if phase["wall_ms"] is not None]
    return {
        "phases": len(phases),
        "passed": sum(1 for phase in phases if phase["state"] == "passed"),
        "tasks_passed": sum(task["passed"] for task in tasks),
        "tasks_total": sum(task["total"] for task in tasks),
        "runs": sum(phase["runs"] for phase in phases),
        "cost_usd": round(sum(costs), 6) if costs else None,
        "wall_ms": sum(walls) if walls else None,
    }


def _receipt(every: list[dict[str, Any]], passing: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The build so far on the ladder's top rung, against all roko spent on it. The top-rung side is each
    passed phase's passing run's receipt (each task once, its passing try at the top rung's list prices; a
    run that resumed another counts only what it ran, so it errs low), as the run log kept it when that run's
    whole card was read. The spend side is every run of every phase, failed and cancelled ones included: what
    did not pass counts against roko. `unread` names the passing runs whose receipt the log does not hold yet
    (opening a run reads it), `missing` counts them."""
    if not passing:
        return None
    kept = [run["receipt"] for run in passing if isinstance(run.get("receipt"), dict)]
    unread = [str(run.get("run_id")) for run in passing if not isinstance(run.get("receipt"), dict)]
    spend = sum(float(run["cost_usd"]) for run in every if isinstance(run.get("cost_usd"), (int, float)))
    priced = [one for one in kept if isinstance(one.get("top_rung_usd"), (int, float))]
    top = round(sum(float(one["top_rung_usd"]) for one in priced), 6) if priced else None
    models = [
        str(one["top_rung"]) for one in priced if isinstance(one.get("top_rung"), str) and one["top_rung"]
    ]
    model = max(set(models), key=models.count) if models else None
    lost = sum(1 for run in every if run.get("state") in TERMINAL_STATES and run.get("state") != "succeeded")
    going = sum(1 for run in every if run.get("state") not in TERMINAL_STATES)
    basis = (
        f"≈ each passed phase's passing tries at {model}'s list prices · roko's spend includes "
        f"{lost} run{'' if lost == 1 else 's'} that didn't pass"
        + (f" and {going} still running" if going else "")
        if model
        else None
    )
    return {
        "phases": len(kept),
        "cost_usd": round(spend, 6),
        "top_rung": model,
        "top_rung_usd": top,
        "ratio": round(top / spend, 1) if top and spend > 0 else None,
        "basis": basis,
        "runs_not_passed": lost,
        "runs_running": going,
        "missing": len(unread),
        "unread": unread[:UNREAD_LISTED],
        "not_compared": sum(int(one.get("not_compared") or 0) for one in kept),
    }


def _next(phases: list[dict[str, Any]]) -> dict[str, Any] | None:
    """What the build waits on: the first phase that has not passed, and what moves it."""
    for phase in phases:
        state = phase["state"]
        if state in ("passed", "unverified"):
            continue
        if state in ("running", "queued", "writing"):
            return {"n": phase["n"], "do": "wait", "run_id": phase["run_id"] or phase["writing_id"]}
        if state == "stopped":
            return {"n": phase["n"], "do": "resume", "plan_id": phase["plan_id"], "run_id": phase["run_id"]}
        if state == "written":
            return {"n": phase["n"], "do": "run", "plan_id": phase["plan_id"]}
        return {"n": phase["n"], "do": "write", "spec": phase["spec"]}
    return None

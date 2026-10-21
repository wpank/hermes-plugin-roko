"""Views every surface shares: the connection, recent runs, what waits on the person, spend.

The tools, `/roko`, `hermes roko` and the desktop and dashboard UIs all build
their answers from these, so a run reads the same everywhere. Since 0.7.0 a
view is about one project (the runtime's, `rt.scoped`), and a single run's
view is about the project it ran in (`rt.for_run`); the run lists hold every
run Hermes started, each with its project.
"""

from __future__ import annotations

import contextlib
import logging
import re
import shlex
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import ledger, readiness, rundata
from . import serve as serving
from .catalog import TERMINAL_STATES
from .client import RokoClient
from .decisions import (
    Confirmation,
    Decision,
    find_pending,
    name_items,
    pending_confirmations,
    pending_effects,
)
from .errors import Code, Refusal, RokoError
from .runtime import Runtime
from .sanitize import clean
from .settings import same_path
from .version import __version__

logger = logging.getLogger(__name__)

# How many runs one overview refreshes from roko: active ones first, then
# finished ones whose cost was never read from their events.
REFRESH_ACTIVE = 6
REFRESH_SETTLE = 3
# Ended runs whose kept totals are checked against roko's once (`_check_totals`), per refresh.
REFRESH_CHECK = 1
OVERVIEW_RUNS = 20


def connection(rt: Runtime) -> dict[str, Any]:
    """Whether roko serve answers and accepts the plugin's credential, and (0.7.0) the project's roko serve
    (`serve`, a ServeState). Never raises."""
    try:
        settings = rt.settings()
        out: dict[str, Any] = {
            "url": settings.display_url or None,
            "reachable": False,
            "version": None,
            "status": None,
            "credential": settings.credential().source,
            "active_runs": None,
            "active_plans": None,
            "workdir": str(settings.workdir) if settings.workdir else None,
            "error": None,
            "serve": None,
        }
        client = rt.client(settings)
    except RokoError as exc:
        return {
            "url": None,
            "reachable": False,
            "version": None,
            "status": None,
            "credential": "none",
            "error": _error(exc),
            "serve": None,
        }
    try:
        health = client.health()
    except RokoError as exc:
        out["error"] = _error(exc)
        if settings.workdir and out["error"].get("hint"):
            # The plugin knows the workspace: name it rather than a placeholder.
            hint = str(out["error"]["hint"])
            out["error"]["hint"] = hint.replace(
                "--workdir WORKSPACE", f"--workdir {shlex.quote(str(settings.workdir))}"
            )
        out["serve"] = _serve(rt)
        return out
    out["reachable"] = True
    out["version"] = clean(health.get("version"), 40, one_line=True) or None
    out["status"] = clean(health.get("status"), 40, one_line=True) or None
    try:
        api = client.get("/api/health")
    except RokoError as exc:
        out["error"] = _error(exc)
        out["serve"] = _serve(rt, health=health)
        return out
    if isinstance(api, dict):
        out["active_runs"] = api.get("active_runs") if isinstance(api.get("active_runs"), int) else None
        out["active_plans"] = api.get("active_plans") if isinstance(api.get("active_plans"), int) else None
    counts = [out["active_runs"], out["active_plans"]]
    active = sum(count for count in counts if isinstance(count, int)) if None not in counts else None
    out["serve"] = _serve(rt, health=health, active=active)
    return out


def _serve(
    rt: Runtime, *, health: dict[str, Any] | None = None, active: int | None = None
) -> dict[str, Any] | None:
    """The project's roko serve for `connection`, from what it already asked; None without a project."""
    try:
        state = serving.serve_state(rt, health=health, active=active)
    except Exception:  # the connection must answer whatever the plugin's own look does
        logger.exception("roko: could not look at the project's roko serve")
        return None
    return state.as_dict() if state is not None else None


def project_ref(rt: Runtime, run: dict[str, Any] | None) -> dict[str, Any] | None:
    """`{path, name}` of the project a logged run ran in; runs from before 0.7.0 belong to the default
    project. None when there is none."""
    path = (run or {}).get("project")
    if not isinstance(path, str) or not path.startswith("/"):
        default = rt.root.settings().workdir
        if default is None:
            return None
        path = str(default)
    return {"path": path, "name": rt.projects.name(Path(path))}


# The refusals that stop runs from Hermes in a project roko is set up in.
_BLOCKING = {readiness.REFUSES_CHAT_RUNS, readiness.NO_TOOL_LOOP_MODEL, readiness.NO_PRICE}


def project_row(rt: Runtime, path: Path, serve: dict[str, Any] | None = None) -> dict[str, Any]:
    """A project as the pages list it (`Project`): from files and the plugin's last looks, never the network
    unless `serve` is passed in already."""
    state = rt.projects.state()
    entry = state["items"].get(str(path)) or {}
    view = rt.scoped(path)
    has_toml = (path / "roko.toml").is_file()
    look = readiness.cached(view)
    seen = {str(item.get("id")) for item in look.problems} if look is not None else set()
    if serve is None:
        cached = serving.cached_state(rt, path)
        serve = cached.as_dict() if cached is not None else None
    return {
        "path": str(path),
        "name": rt.projects.name(path),
        "default": state.get("default") == str(path),
        "last_used": entry.get("last_used"),
        "ready": has_toml and not (seen & _BLOCKING),
        "needs_setup": not has_toml or readiness.REFUSES_CHAT_RUNS in seen,
        "serve": serve,
    }


def project_rows(
    rt: Runtime, current: tuple[Path, dict[str, Any] | None] | None = None
) -> list[dict[str, Any]]:
    """Every known project (`Project`), the default first, then the most recently used. `current` passes the
    serve of the project an answer is about, which it looked at already."""
    settings = rt.root.settings()
    if settings.remote:
        if settings.workdir is None:
            return []
        remote = serving.serve_state(rt, settings.workdir, look=False)
        return [project_row(rt, settings.workdir, remote.as_dict() if remote is not None else None)]
    rows = []
    for path in rt.projects.paths():
        serve = current[1] if current is not None and current[0] == path else None
        rows.append(project_row(rt, path, serve))
    return rows


# The shortest start of a run id that names a run: the lists show 8 characters.
MIN_RUN_PREFIX = 4


def resolve_run_id(rt: Runtime, run_id: str) -> str:
    """`last` names the run Hermes started most recently, and the first characters of a run id (at least
    `MIN_RUN_PREFIX`) name the run Hermes started whose id begins with them, when only one does. Anything
    else goes to roko as it is."""
    wanted = run_id.strip()
    if wanted.lower() in ("last", "latest"):
        recent = rt.runs.recent(1)
        if not recent:
            raise RokoError(Code.NOT_FOUND, "no runs were started from Hermes yet, so there is no last run")
        return str(recent[0]["run_id"])
    if len(wanted) < MIN_RUN_PREFIX:
        return wanted
    known = {str(run.get("run_id") or "") for run in rt.runs.recent(200)}
    if wanted in known:
        return wanted
    # A CLI run's `graph-<plan>-<uuid>` goes by its UUID's first characters, as roko shows it (P-14).
    matches = sorted(
        run for run in known if run.startswith(wanted) or rundata.short_run_id(run).startswith(wanted)
    )
    return matches[0] if len(matches) == 1 else wanted


def card(rt: Runtime, run_id: str, *, summary: dict[str, Any] | None = None) -> dict[str, Any]:
    """The full card for one run, from the project it ran in; also records what it learned in the run log."""
    run_id = resolve_run_id(rt, run_id)
    rt = rt.for_run(run_id)
    settings = rt.settings()
    client = rt.client(settings)
    logged = rt.runs.get(run_id)
    if summary is None:
        try:
            summary = rundata.run_status(client, run_id)
        except RokoError as exc:
            recovered = finished_plan_generation(rt, client, run_id) if exc.code is Code.NOT_FOUND else None
            if recovered is None:
                if exc.code is Code.NOT_FOUND and logged is not None and _settled(logged):
                    if logged.get("kind") == "plan_generate":
                        return lost_plan_generation(rt, run_id, logged)
                    return missing_card(rt, run_id, logged)
                raise
            summary = recovered
    built = rundata.build_card(
        client, rt.cards, run_id, summary=summary, logged=logged, workdir=settings.workdir
    )
    # Who in Hermes cancelled it, and why: roko keeps no reason for a cancel (P-1).
    built["cancelled_by"] = (logged or {}).get("cancelled_by")
    # The run whose progress it set aside to start over (P-14): `{run_id, status, passed_tasks, tasks_left}`.
    aside = (logged or {}).get("set_aside")
    built["set_aside"] = aside if isinstance(aside, dict) else None
    built.setdefault("summary_behind", False)
    built.setdefault("reading", False)
    if built.get("kind") == "plan_generate" and built.get("state") == "failed":
        _name_the_setup_problem(rt, built)
    if logged is not None:
        facts = rundata.tracker_facts(rt.cards, settings.url, run_id) if not built.get("active") else {}
        _remember(rt, run_id, {**built, "checks": facts.get("checks"), "models": facts.get("models")})
    # The plan's runs together, when this one resumed another (0.6.0, dogfood U10).
    built["chain"] = chain(rt, rt.runs.get(run_id) or {}) if logged is not None else None
    built["project"] = project_ref(rt, logged)
    return built


# Since roko bug-a0432b a chat host's plan is written only by a model roko's own tool loop runs; with none,
# the generation fails before any call, in the words of the no_tool_loop_model refusal of a run.
_NO_TOOL_LOOP_MODEL = re.compile(r"needs a model that runs in roko's own tool loop", re.I)


def _name_the_setup_problem(rt: Runtime, card: dict[str, Any]) -> None:
    """A plan writing that failed for a setup problem the person can fix (no model roko's own tool loop runs)
    names it, as a refused run does: the card's `problem`, and the setup card from now on."""
    said = str(card.get("planner_error") or "")
    if not _NO_TOOL_LOOP_MODEL.search(said):
        return
    refused = RokoError(Code.REFUSED, said, refusal=Refusal.NO_TOOL_LOOP_MODEL.value)
    found = readiness.problem_for_error(rt, refused)
    if found is not None:
        card["problem"] = found
        readiness.remember(rt, found)


def cancel(rt: Runtime, run_id: str, *, reason: Any = None, by: str = "page") -> dict[str, Any]:
    """Stop a run. A run nothing runs any more (its roko serve stopped under it) is interrupted, not an error:
    roko says so since bug-dceafd, and an older roko's "no active execution" for a run it still calls running
    means the same. A run it stops is recorded as cancelled `by` the chat or a page, with the person's
    `reason` (P-1), which roko does not keep."""
    run_id = resolve_run_id(rt, run_id)
    rt = rt.for_run(run_id)
    settings = rt.settings()
    client = rt.client(settings)
    try:
        body = client.call_tool("run_cancel", {"run_id": run_id})
    except RokoError as exc:
        found = _nothing_runs(rt, client, run_id) if exc.code is Code.NOT_FOUND else None
        if found is None:
            raise
        return found
    body = body if isinstance(body, dict) else {}
    state = clean(body.get("state"), 40, one_line=True) or "cancelled"
    out: dict[str, Any] = {"run_id": run_id, "state": state}
    if state == "interrupted":
        # It had ended before this cancel. roko's /mcp answer names no time; the run's summary does.
        stopped = {
            "reason": clean(body.get("reason"), 300, one_line=True) or rundata.INTERRUPTED_REASON,
            "at": clean(body.get("ended_at"), 40, one_line=True) or _interrupted_at(client, run_id),
            "source": "roko",
        }
        out.update(reason=stopped["reason"], interrupted=stopped, already_ended=True)
        rt.runs.update(run_id, state=state, interrupted=stopped)
    else:
        rt.runs.update(run_id, state=state)
    if state == "cancelled" and not out.get("already_ended"):
        out["cancelled_by"] = {"by": by, "reason": cancel_reason(reason), "at": rundata.now_iso()}
        rt.runs.update(run_id, cancelled_by=out["cancelled_by"])
    rt.live.poke(run_id)
    return out


# A cancel's reason, as roko_cancel's schema allows it (plugin-safety's catalog): at most this many.
CANCEL_REASON_CHARS = 200


def cancel_reason(reason: Any) -> str | None:
    """The person's reason for a cancel, on one line, at most CANCEL_REASON_CHARS; None without one."""
    return clean(reason, CANCEL_REASON_CHARS, one_line=True) or None


def _nothing_runs(rt: Runtime, client: RokoClient, run_id: str) -> dict[str, Any] | None:
    """roko has nothing running for `run_id`. If it still calls the run going, its serve stopped under it."""
    try:
        summary = rundata.run_status(client, run_id)
    except RokoError:
        return None
    state = clean(summary.get("state"), 40, one_line=True)
    if state in TERMINAL_STATES:  # it had ended already
        rt.runs.update(run_id, state=state)
        return {"run_id": run_id, "state": state, "already_ended": True}
    if state not in ("running", "queued"):
        return None
    logged = rt.runs.get(run_id) or {}
    stopped = logged.get("interrupted") if isinstance(logged.get("interrupted"), dict) else None
    if stopped is None:
        # The card finds it interrupted when its roko serve started after the run did, with when it stopped.
        try:
            built = card(rt, run_id, summary=summary)
        except RokoError:
            built = {}
        found = built.get("interrupted")
        if (
            not isinstance(found, dict)
            and not logged
            and not str(built.get("origin") or "").startswith("mcp:")
        ):
            return None  # a run another process runs (a terminal's `roko run`): roko serve cannot stop it
        stopped = (
            dict(found)
            if isinstance(found, dict)
            else {"reason": rundata.INTERRUPTED_REASON, "at": built.get("last_event_at"), "source": "plugin"}
        )
        rt.runs.update(run_id, state="interrupted", interrupted=stopped)
    rt.live.poke(run_id)
    return {
        "run_id": run_id,
        "state": "interrupted",
        "reason": stopped.get("reason"),
        "interrupted": stopped,
        "already_ended": True,
    }


def _interrupted_at(client: RokoClient, run_id: str) -> str | None:
    """When roko says run `run_id` stopped (its summary's `interrupted.at`), or None."""
    try:
        told = rundata.run_status(client, run_id).get("interrupted")
    except RokoError:
        return None
    return (clean(told.get("at"), 40, one_line=True) or None) if isinstance(told, dict) else None


# A plan generation roko no longer knows, that left no plan: the planner did not write it.
LOST_PLAN_NOTE = "roko's planner wrote no plan"
LOST_PLAN_ERROR = (
    "roko's planner did not write this plan. roko keeps a plan generation's outcome for only a minute "
    "after it ends, so the reason is gone: ask again, and see roko serve's log for what happened. A large "
    "request can take the planner longer than its time limit."
)


def lost_plan_generation(rt: Runtime, run_id: str, logged: dict[str, Any]) -> dict[str, Any]:
    """The card of a plan generation roko has forgotten, when no plan was written (it did not succeed)."""
    rt.runs.update(run_id, state="failed", note=LOST_PLAN_NOTE)
    summary = {
        "run_id": run_id,
        "kind": f"plan_generate:{logged.get('plan_id') or ''}",
        "state": "failed",
        "error": LOST_PLAN_ERROR,
    }
    return rundata.plan_generation_card(run_id, summary, logged)


def missing_card(rt: Runtime, run_id: str, logged: dict[str, Any]) -> dict[str, Any]:
    """The card of a run Hermes started that roko has no record of.

    roko gave out the run id, then kept nothing: it refuses a prompt run at once while another run holds
    the workspace, and that refusal leaves no record (roko bug-09e21e). A run that ended before roko
    forgot it (a start roko refused, then a restart) keeps the end the plugin saw, and why.
    """
    ended = logged.get("state")
    if ended in TERMINAL_STATES and ended != "missing":
        return _forgotten_card(rt, run_id, logged, str(ended))
    rt.runs.update(run_id, state="missing", cost_final=True, note="roko has no record of this run")
    card: dict[str, Any] = {
        "run_id": run_id,
        "kind": logged.get("kind"),
        "label": clean(logged.get("label") or f"run {run_id[:8]}", 120, one_line=True),
        "request": logged.get("request"),
        "plan_id": logged.get("plan_id"),
        "state": "missing",
        "verdict": None,
        "active": False,
        "cost_usd": None,
        "max_usd": logged.get("max_usd"),
        "started_at": logged.get("started_at"),
        "hermes_started_at": logged.get("started_at"),
        "session_id": logged.get("session_id"),
        "tasks": [],
        "progress": rundata.progress([]),
        "graph": {"waves": [], "edges": []},
        "gates": {"passed": 0, "failed": 0, "total": 0},
        "milestones": [],
        "errors": [],
        "waiting": [],
        "problems": [
            "roko has no record of this run. roko refuses a run that starts while another run holds "
            "the workspace, and keeps nothing of it: start it again once the other run ends."
        ],
    }
    card["headline"] = "missing · roko has no record of this run"
    card["checked_at"] = rundata.now_iso()
    return card


def _forgotten_card(rt: Runtime, run_id: str, logged: dict[str, Any], state: str) -> dict[str, Any]:
    """The card of a run that ended, and whose record roko no longer has: what the plugin saw of it."""
    note = "roko no longer has this run's record (its roko serve restarted); this is what the plugin saw"
    rt.runs.update(run_id, note=note)
    card: dict[str, Any] = {
        "run_id": run_id,
        "kind": logged.get("kind"),
        "label": clean(rundata.display_label(logged) or f"run {run_id[:8]}", 120, one_line=True),
        "request": logged.get("request"),
        "plan_id": logged.get("plan_id"),
        "state": state,
        "verdict": state,
        "active": False,
        "cost_usd": logged.get("cost_usd") if cost_known(logged) else None,
        "max_usd": logged.get("max_usd"),
        "started_at": logged.get("started_at"),
        "finished_at": logged.get("finished_at"),
        "hermes_started_at": logged.get("started_at"),
        "session_id": logged.get("session_id"),
        "interrupted": logged.get("interrupted") if isinstance(logged.get("interrupted"), dict) else None,
        "tasks": [],
        "progress": logged.get("progress")
        if isinstance(logged.get("progress"), dict)
        else rundata.progress([]),
        "graph": {"waves": [], "edges": []},
        "gates": {"passed": 0, "failed": 0, "total": 0},
        "milestones": [],
        "errors": [],
        "waiting": [],
        "work": None,
        "merge": None,
        "checking": None,
        "next": None,
        "problems": [note + "."],
    }
    why = clean(logged.get("why"), 1_200)
    if why:
        card["why"] = {
            "summary": why,
            "gates_not_passed": [],
            "blocked": [],
            "unverified_tasks": [],
            "errors": [],
            "refusals": [],
            "start_error": None,
        }
    card["headline"] = rundata.headline(card)
    card["checked_at"] = rundata.now_iso()
    return card


# roko knows a run as soon as it hands out its id; this long after, a run it does not know is gone.
MISSING_AFTER_S = 15


def _settled(logged: dict[str, Any]) -> bool:
    started = _parse_time(logged.get("started_at"))
    if started is None:
        return True
    return (datetime.now(UTC) - started).total_seconds() >= MISSING_AFTER_S


def generation_label(rt: Runtime, plan_id: str) -> str | None:
    """The name of the plan generation Hermes started that wrote `plan_id`, if it started one."""
    for run in rt.runs.recent(200):
        if run.get("kind") == "plan_generate" and run.get("plan_id") == plan_id and run.get("label"):
            return str(run["label"])
    return None


def finished_plan_generation(rt: Runtime, client: RokoClient, run_id: str) -> dict[str, Any] | None:
    """roko forgets a plan_generate operation a minute after it ends; the plan itself stays."""
    run = rt.runs.get(run_id)
    if not run or run.get("kind") != "plan_generate" or not run.get("plan_id"):
        return None
    plan_id = str(run["plan_id"])
    try:
        body = client.get(f"/api/plans/{quote(plan_id, safe='')}/tasks")
    except RokoError:
        return None
    tasks = body.get("tasks") if isinstance(body, dict) else None
    return {
        "run_id": run_id,
        "kind": f"plan_generate:{plan_id}",
        "state": "succeeded",
        "result": {"slug": plan_id, "task_count": len(tasks) if isinstance(tasks, list) else None},
    }


# After a paid start timed out, this many runs Hermes does not know are checked for the one it started.
RECOVER_CANDIDATES = 40


def find_new_run(rt: Runtime, client: RokoClient, since: datetime) -> str | None:
    """The run roko started over /mcp since `since` that Hermes has not logged, if there is exactly one.

    A paid start that timed out may still have started: roko had the request.
    Its answer, and so its run id, never came back. roko lists runs without
    times or origins, so each unknown, unfinished run's manifest is read.
    """
    try:
        body = client.get("/api/dashboard/runs")
    except RokoError:
        return None
    rows = body.get("runs") if isinstance(body, dict) else None
    known = {str(run.get("run_id")) for run in rt.runs.recent(200)}
    candidates = [
        str(row["run_id"])
        for row in (rows if isinstance(rows, list) else [])
        if isinstance(row, dict)
        and isinstance(row.get("run_id"), str)
        and row["run_id"] not in known
        and not row.get("is_complete")
    ][:RECOVER_CANDIDATES]
    found = []
    for run_id in candidates:
        try:
            bundle = client.get(f"/api/runs/{quote(run_id, safe='')}/bundle")
        except RokoError:
            continue
        manifest = bundle.get("manifest") if isinstance(bundle, dict) else None
        if not isinstance(manifest, dict) or not str(manifest.get("origin") or "").startswith("mcp:"):
            continue
        invocations = [i for i in manifest.get("invocations") or [] if isinstance(i, dict)]
        started = _parse_time(invocations[0].get("started_at")) if invocations else None
        if started is not None and started >= since:
            found.append(run_id)
    return found[0] if len(found) == 1 else None


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else None


def _spend_today(rt: Runtime, settings: Any) -> dict[str, Any]:
    """Today's spend: the runs started from this Hermes, in every project (its daily limit counts them, `from:
    hermes`), and what roko recorded today across the workspaces of those projects and the one shown, from
    roko's own daily ledgers (P-3; 0.7.0: one per project)."""
    runs = rt.runs.recent(200)
    spend = ledger.spend(runs, settings.max_day_usd)
    default = rt.root.settings().workdir
    folders: list[Path] = [settings.workdir] if settings.workdir is not None else []
    for run in runs:
        project = run.get("project")
        if isinstance(project, str) and project.startswith("/"):
            folders.append(Path(project))
        elif default is not None:
            folders.append(default)  # a run from before 0.7.0: the default project's
    totals = [rt.cards.roko_today(folder) for folder in dict.fromkeys(folders)]
    known = [total for total in totals if total is not None]
    spend.update({"from": "hermes", "roko_today_usd": round(sum(known), 6) if known else None})
    return spend


def _check_totals(rt: Runtime, client: RokoClient, run: dict[str, Any], *, current: bool) -> None:
    """Check an ended run's kept totals once against roko's own summary: 0.6.0 kept a long run's card after
    its first 40,000 rows as final (hermes-pilot P-17: the real phase-1 run kept "2 of 5 tasks, $0.28"). Its
    spend becomes roko's (an ended run's spend is roko's own); when its task counts disagree, the run is read
    again, as a run that has not settled is."""
    run_id = str(run["run_id"])
    own = run_client(rt, client, run)
    if own is None or (own is client and not current):
        return
    try:
        summary = rundata.run_status(own, run_id)
    except RokoError as exc:
        if exc.code is not Code.NOT_FOUND:
            return
        summary = None  # roko forgot it: nothing to check against
    fields: dict[str, Any] = {"checked": True, "spend_checked": True}
    reported = (summary or {}).get("cost_usd")
    if isinstance(reported, (int, float)) and not isinstance(reported, bool) and reported > 0:
        fields["cost_usd"] = round(float(reported), 6)  # an ended run's spend is roko's own
    if summary is not None and not rundata.totals_agree({**run, **fields}, summary):
        fields["cost_final"] = False
    run.update(fields)
    rt.runs.update(run_id, **fields)


def _writing_from_ledger(rt: Runtime, run: dict[str, Any]) -> None:
    """An ended plan writing's spend is roko's ledger's, side calls included (P-47): roko's episode distiller
    runs as the writing ends, so the ledger, a file of its project's, is read until it shows what ran."""
    project = run.get("project")
    folder = (
        Path(project) if isinstance(project, str) and project.startswith("/") else rt.root.settings().workdir
    )
    view = {key: run.get(key) for key in ("kind", "state", "plan_id", "cost_usd")}
    view["hermes_started_at"] = run.get("started_at")
    rundata.writing_from_ledger(view, rt.cards, folder)
    if view.get("side_call_usd"):
        fields = {"cost_usd": view["cost_usd"], "side_call_usd": view["side_call_usd"]}
        run.update(fields)
        rt.runs.update(str(run["run_id"]), **fields)


def refresh_runs(
    rt: Runtime, client: RokoClient, runs: list[dict[str, Any]], *, current: bool = True
) -> None:
    """Bring the state and spend of logged runs up to date, a bounded number per call."""
    active = [run for run in runs if run.get("state") not in TERMINAL_STATES]
    unsettled = [
        run
        for run in runs
        if run.get("state") in TERMINAL_STATES
        and run.get("kind") in ("run", "plan")
        and not run.get("cost_final")
    ]
    unchecked = [
        run
        for run in runs
        if run.get("state") in TERMINAL_STATES
        and run.get("kind") in ("run", "plan")
        and run.get("cost_final")
        # Checked before an ended run's spend was roko's own: checked once more, for its spend.
        and not (run.get("checked") and run.get("spend_checked"))
    ]
    for run in unchecked[:REFRESH_CHECK]:
        _check_totals(rt, client, run, current=current)
    for run in runs:  # an ended plan writing, until the ledger has what roko ran after its planner (P-47)
        if (
            run.get("kind") == "plan_generate"
            and run.get("state") in TERMINAL_STATES
            and "side_call_usd" not in run
        ):
            _writing_from_ledger(rt, run)
    for run in active[:REFRESH_ACTIVE] + unsettled[:REFRESH_SETTLE]:
        run_id = str(run["run_id"])
        own = run_client(rt, client, run)  # each run is read from its own project's roko serve
        if own is None or (own is client and not current):
            continue  # its serve is down: the run keeps what the log knows
        run_rt = rt if own is client else rt.for_run(run_id)
        try:
            summary = rundata.run_status(own, run_id)
        except RokoError as exc:
            recovered = finished_plan_generation(run_rt, own, run_id) if exc.code is Code.NOT_FOUND else None
            if recovered is None:
                if exc.code is Code.NOT_FOUND and run.get("kind") == "plan_generate" and _settled(run):
                    run.update(state="failed", note=LOST_PLAN_NOTE)
                    rt.runs.update(run_id, state="failed", note=LOST_PLAN_NOTE)
                    continue
                if exc.code is Code.NOT_FOUND and run.get("kind") in ("run", "plan") and _settled(run):
                    note = "roko has no record of this run"
                    run.update(state="missing", note=note, cost_final=True)
                    rt.runs.update(run_id, state="missing", note=note, cost_final=True)
                    continue
                run["note"] = clean(exc.message, 200, one_line=True)
                continue
            summary = recovered
        try:
            totals = rundata.quick_totals(own, rt.cards, run_id, summary, run)
        except RokoError as exc:
            logger.debug("roko: could not total run %s: %s", run_id, exc)
            totals = {"state": summary.get("state")}
        run.update({key: value for key, value in totals.items() if value is not None})
        run.update(_remember(rt, run_id, totals))


def run_client(rt: Runtime, client: RokoClient, run: dict[str, Any]) -> RokoClient | None:
    """The client of the project `run` ran in: `client` when it is that project's, else that project's own;
    None when no roko serve runs there (nothing to ask, and nothing is started to ask it)."""
    path = run.get("project")
    here = client.settings.workdir
    if not isinstance(path, str) or not path.startswith("/"):
        # Logged before 0.7.0: the default project's run (Runtime.for_run), whichever project the page shows.
        default = rt.root.settings().workdir
        if default is None or here is None or default == here:
            return client
        path = str(default)
    if here is not None and str(here) == path:
        return client
    if here is None and client.settings.url:
        return client  # no project known: the one URL there is (a `url` setting from before 0.7.0)
    return _serve_client(rt, Path(path))


def _serve_client(rt: Runtime, path: Path) -> RokoClient | None:
    """The client of `path`'s roko serve while it runs (its serve.json and a live pid: files only), else
    None."""
    state = serving.serve_state(rt, path, look=False)
    if state is None or state.state != "running" or state.pid is None:
        return None
    own = rt.scoped(path).client()
    return own if own.settings.url else None


def serving_clients(rt: Runtime, client: RokoClient, *, current: bool = True) -> list[RokoClient]:
    """The clients of every roko serve that runs (0.7.0, the overview's scope): this project's (with
    `current`), the known projects', and those of the projects of the runs Hermes started recently. A serve
    that is down is skipped, never started."""
    found: dict[str, RokoClient] = {}
    if current and client.settings.url:
        found[client.settings.url] = client
    if client.settings.remote:
        return list(found.values())
    paths: list[Path] = list(rt.projects.paths())
    for run in rt.runs.recent(20):
        project = run.get("project")
        if isinstance(project, str) and project.startswith("/"):
            paths.append(Path(project))
    here = client.settings.workdir
    for path in dict.fromkeys(paths):
        if here is not None and same_path(path, here):
            continue
        own = _serve_client(rt, path)
        if own is not None:
            found.setdefault(own.settings.url, own)
    return list(found.values())


def _with_project(rt: Runtime, client: RokoClient, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`items`, each with the project whose roko serve holds it (`{path, name}`, or None without one)."""
    workdir = client.settings.workdir
    ref = {"path": str(workdir), "name": rt.projects.name(workdir)} if workdir is not None else None
    for item in items:
        item["project"] = dict(ref) if ref else None
    return items


def cost_known(run: dict[str, Any]) -> bool:
    """Whether the run log's figure is an ended run's spend: a run's once read from its events, and a plan
    writing's, which has none to read, once it ended (roko's figure, its ledger's since P-47)."""
    return bool(run.get("cost_final")) or run.get("kind") == "plan_generate"


def run_rows(
    rt: Runtime, runs: list[dict[str, Any]], titles: dict[str, str] | None = None
) -> list[dict[str, Any]]:
    """Run log entries as the UI's RunRow. `titles` names plans by id, for runs logged under a plan's id."""
    rows = []
    for run in runs:
        state = run.get("state")
        label = rundata.display_label(run)
        if run.get("kind") == "plan" and label == run.get("plan_id") and titles:
            label = titles.get(label) or label
        rows.append(
            {
                "run_id": run.get("run_id"),
                "kind": run.get("kind"),
                "label": clean(label, 120, one_line=True),
                "plan_id": run.get("plan_id"),
                "state": state,
                "active": state not in TERMINAL_STATES,
                # A finished run's cost counts once it was read from its events;
                # before that the log may hold roko's summary figure, which is 0.
                "cost_usd": run.get("cost_usd") if cost_known(run) or state not in TERMINAL_STATES else None,
                "max_usd": run.get("max_usd"),
                "started_at": run.get("started_at"),
                "finished_at": run.get("finished_at"),
                "session_id": run.get("session_id"),
                "source": run.get("source"),
                "progress": run.get("progress") if isinstance(run.get("progress"), dict) else None,
                "note": run.get("note"),
                "interrupted": run.get("interrupted") if isinstance(run.get("interrupted"), dict) else None,
                # 0.5.0: roko stopped it at its cap (or its daily limit): a stop, though `state` says failed.
                "budget_stop": run.get("budget_stop") if isinstance(run.get("budget_stop"), dict) else None,
                "work": run.get("work") if isinstance(run.get("work"), str) else None,
                # 0.6.0: its tasks on the ladder (RungCount[]), for the mini ladder.
                "rungs": run.get("rungs") if isinstance(run.get("rungs"), list) else None,
                # 0.6.0: the run it resumed, and the plan's runs together (dogfood U10).
                "resumes": run.get("resumes") if isinstance(run.get("resumes"), str) else None,
                "chain": chain(rt, run),
                # 0.7.0: the project it ran in.
                "project": project_ref(rt, run),
            }
        )
    return rows


def resumed_run(rt: Runtime, plan_id: str, run_id: str) -> str | None:
    """The run a resume of plan `plan_id` continues: the newest earlier run of the plan in the run log."""
    for run in rt.runs.recent(200):
        if run.get("run_id") != run_id and run.get("kind") == "plan" and run.get("plan_id") == plan_id:
            return str(run["run_id"])
    return None


def chain(rt: Runtime, run: dict[str, Any]) -> dict[str, Any] | None:
    """A run that resumed another: the plan's runs so far, oldest first, what they spent together, and where
    its tasks are now (`Chain`). None for a run that resumed none."""
    if not isinstance(run.get("resumes"), str):
        return None
    runs, seen = [run], {str(run.get("run_id"))}
    while isinstance(runs[0].get("resumes"), str) and runs[0]["resumes"] not in seen and len(runs) < 20:
        earlier = rt.runs.get(runs[0]["resumes"])
        if earlier is None:
            break
        seen.add(str(earlier.get("run_id")))
        runs.insert(0, earlier)
    costs = [one.get("cost_usd") for one in runs]
    known = all(isinstance(cost, (int, float)) for cost in costs)
    return {
        "run_ids": [str(one.get("run_id")) for one in runs],
        "cost_usd": round(sum(float(cost) for cost in costs if isinstance(cost, (int, float))), 6)
        if known
        else None,
        "progress": run.get("progress") if isinstance(run.get("progress"), dict) else None,
    }


def collect_pending(
    rt: Runtime, client: RokoClient, runs: list[dict[str, Any]] | None = None, *, current: bool = True
) -> list[dict[str, Any]]:
    """Everything roko waits on the person for: confirmations in Hermes' active runs, and held actions, in
    every project whose roko serve runs (0.7.0), each item with its `project`. `current` False leaves out this
    project's serve (it does not answer); the others' failures are skipped, this one's raised."""
    runs = runs if runs is not None else rt.runs.recent(10)
    items: list[dict[str, Any]] = []
    for run in runs[:10]:
        if run.get("state") in ("running", "queued", None) and run.get("kind") in ("run", "plan"):
            own = run_client(rt, client, run)
            if own is None or (own is client and not current):
                continue
            try:
                items.extend(_with_project(rt, own, pending_confirmations(own, str(run["run_id"]))))
            except RokoError as exc:
                if exc.code is not Code.NOT_FOUND and own is client:
                    raise
    # Held actions are per roko serve: every one that runs.
    for serving_client in serving_clients(rt, client, current=current):
        try:
            items.extend(_with_project(rt, serving_client, pending_effects(serving_client)))
        except RokoError:
            if serving_client is client:
                raise
    seen: set[str] = set()
    unique = []
    for item in items:
        if item["decision_id"] not in seen:
            seen.add(item["decision_id"])
            unique.append(item)
    labels = {
        str(run.get("run_id")): str(run.get("label")) for run in rt.runs.recent(200) if run.get("label")
    }
    return name_items(unique, labels)


def decision_client(rt: Runtime, client: RokoClient, decision: Decision) -> RokoClient:
    """The client of the roko serve an item waits in (0.7.0: each project has its own): a confirmation's, its
    run's project; a held action's, the first serve that holds it among those that run (`serving_clients`)."""
    if isinstance(decision, Confirmation):
        return run_client(rt, client, rt.runs.get(decision.run_id) or {}) or client
    candidates = serving_clients(rt, client)
    if len(candidates) <= 1:
        return client
    for candidate in candidates:
        try:
            if find_pending(candidate, decision) is not None:
                return candidate
        except RokoError:
            continue
    return client


def spend(rt: Runtime) -> dict[str, Any]:
    settings = rt.settings()
    return ledger.spend(rt.runs.recent(200), settings.max_day_usd)


@dataclass
class _Flight:
    """An overview being built, which callers that come while it builds share."""

    runs: tuple[str, ...]  # the run log's runs when the build began
    done: threading.Event = field(default_factory=threading.Event)
    result: dict[str, Any] | None = None


_FLIGHTS: dict[tuple[int, str], _Flight] = {}
_FLIGHTS_LOCK = threading.Lock()
# How long a caller waits for the build it joined before it builds its own.
OVERVIEW_JOIN_S = 20.0


def ui_overview(rt: Runtime) -> dict[str, Any]:
    """`GET /overview`: everything the status chip, badges and landing page show, in one answer.

    The relay's push, the pages' polls and the health route often ask at once (45 requests to roko in the
    second after Run plan, plugin-setup's round v6 take): callers that come while one is built share it, as
    long as no run joined the run log since that build began (a run just started must be in the answer).
    """
    runs = tuple(str(run.get("run_id")) for run in rt.runs.recent(OVERVIEW_RUNS))
    key = (id(rt.root), str(rt.settings().workdir))  # one build per project
    with _FLIGHTS_LOCK:
        building = _FLIGHTS.get(key)
        if building is not None and not building.done.is_set() and building.runs == runs:
            joined: _Flight | None = building
        else:
            joined, own = None, _Flight(runs)
            _FLIGHTS[key] = own
    if joined is not None:
        if joined.done.wait(OVERVIEW_JOIN_S) and joined.result is not None:
            return dict(joined.result)
        return _build_overview(rt)  # it failed, or took too long: build one
    try:
        own.result = _build_overview(rt)
        return dict(own.result)
    finally:
        own.done.set()
        with _FLIGHTS_LOCK:
            if _FLIGHTS.get(key) is own:
                del _FLIGHTS[key]


def _build_overview(rt: Runtime) -> dict[str, Any]:
    settings = rt.settings()
    conn = connection(rt)
    serve = conn.get("serve")
    if (
        isinstance(serve, dict)
        and serve.get("state") in ("stopped", "failed")
        and settings.auto_start
        and settings.workdir is not None
    ):
        # 0.7.0: a stopped serve is started in the background (not one that failed a moment ago).
        started = serving.ensure_serve(rt, settings.workdir, wait=False, reason="overview")
        if started is not None:
            conn["serve"] = started.as_dict()
    runs = rt.runs.recent(OVERVIEW_RUNS)
    pending: list[dict[str, Any]] = []
    # 0.7.0: runs, counts, spend and what waits cover every project; this project's serve when it answers.
    current = conn["reachable"] and conn["error"] is None
    client = rt.client(settings)
    refresh_runs(rt, client, runs, current=current)
    try:
        pending = collect_pending(rt, client, runs, current=current)
    except RokoError as exc:
        conn["error"] = _error(exc)
    titles: dict[str, str] = {}
    if conn["reachable"] and any(
        r.get("kind") == "plan" and r.get("label") == r.get("plan_id") for r in runs
    ):
        listed = rt.cards.plans(rt.client(settings))
        titles = {plan: str(row["title"]) for plan, row in listed.items() if row.get("title")}
    rows = run_rows(rt, runs, titles)
    counts = {
        "running": sum(1 for row in rows if row["state"] == "running"),
        "queued": sum(1 for row in rows if row["state"] == "queued"),
        "waiting": len(pending),
    }
    try:
        rt.live.notice(rows)
    except Exception:
        logger.debug("roko: live relay notice failed", exc_info=True)
    return {
        "ok": True,
        "plugin_version": __version__,
        "connection": conn,
        "setup": readiness.setup_view(rt),
        "counts": counts,
        "spend": _spend_today(rt, settings),
        "limits": {"max_run_usd": settings.max_run_usd, "max_day_usd": settings.max_day_usd},
        # P-7: whether this roko caps a plan writing (roko 55d0acda8), so the composer offers a cap for one.
        "plan_writing_cap": conn["reachable"]
        and "max_usd" in rt.cards.tool_arguments(rt.client(settings)).get("plan_generate", frozenset()),
        "permissions": {"write": settings.ui_actions},
        "runs": rows,
        "pending": pending,
        # The workspace's model ladder (0.6.0): roko.toml's rungs, with roko's model list when roko answers.
        "ladder": rt.cards.ladder_view(rt.client(settings) if conn["reachable"] else None, settings.workdir),
        # 0.7.0: the project this answer is about, and every known one.
        "project": project_row(rt, settings.workdir, conn.get("serve")) if settings.workdir else None,
        "projects": project_rows(
            rt, (settings.workdir, conn.get("serve")) if settings.workdir is not None else None
        ),
        "checked_at": rundata.now_iso(),
    }


def overview(rt: Runtime) -> dict[str, Any]:
    """roko's health, the runs Hermes started recently, what waits on the person, and spend."""
    settings = rt.settings()
    client = rt.client(settings)
    health = client.health()
    roko: dict[str, Any] = {
        "url": settings.display_url,
        "version": clean(health.get("version"), 40, one_line=True) or None,
        "status": clean(health.get("status"), 40, one_line=True) or None,
    }
    if settings.workdir is not None:
        roko["project"] = {"path": str(settings.workdir), "name": rt.projects.name(settings.workdir)}
    try:
        api = client.get("/api/health")
        if isinstance(api, dict):
            roko["active_runs"] = api.get("active_runs")
            roko["active_plans"] = api.get("active_plans")
    except RokoError as exc:
        roko["api_problem"] = f"{exc.message} ({exc.code.value})"
    recent = rt.runs.recent(8)
    refresh_runs(rt, client, recent)
    result: dict[str, Any] = {
        "roko": roko,
        "recent_runs": [
            {
                key: (clean(run.get(key), 120, one_line=True) if key == "label" else run.get(key))
                for key in (
                    "run_id",
                    "kind",
                    "label",
                    "plan_id",
                    "state",
                    "cost_usd",
                    "max_usd",
                    "started_at",
                    "note",
                    "budget_stop",
                )
                if run.get(key) is not None
            }
            for run in recent
        ],
    }
    waiting: list[dict[str, Any]] = []
    with contextlib.suppress(RokoError):
        waiting = collect_pending(rt, client, recent)
    if waiting:
        result["waiting_on_person"] = waiting
    result["spend"] = _spend_today(rt, settings)
    if not recent:
        result["note"] = "No runs started from Hermes yet."
    setup = readiness.setup_view(rt)
    if setup["problems"]:
        # What stands between the person and a working run, with its fix (the setup card's words).
        result["setup_problems"] = setup["problems"]
    result["checked_at"] = rundata.now_iso()
    return result


# The counts of a plan writing's `source_checks` the run log keeps.
KEPT_COUNTS = ("total", "kept", "shallow", "cannot_run", "dropped", "missing")


def _remember(rt: Runtime, run_id: str, view: dict[str, Any]) -> dict[str, Any]:
    """Keep what a refresh learned in the run log, so the ledger and lists see it; return it. A card read
    partway (`reading`) gives roko's own totals only: what else it holds is half a run's."""
    fields: dict[str, Any] = {}
    state = view.get("state")
    if isinstance(state, str) and state:
        fields["state"] = state
        before = rt.runs.get(run_id) or {}
        ended = state in TERMINAL_STATES and before.get("state") not in TERMINAL_STATES
        if ended and not before.get("ended_seen_at"):
            # The end happened while the plugin watched: the chat that started the run hears it (P-13).
            fields["ended_seen_at"] = rundata.now_iso()
    if isinstance(view.get("cost_usd"), (int, float)):
        fields["cost_usd"] = round(float(view["cost_usd"]), 6)
    if view.get("kind") == "plan_generate" and isinstance(view.get("side_call_usd"), dict):
        # What roko ran after a writing's planner, in its spend (P-47).
        fields["side_call_usd"] = view["side_call_usd"]
    if view.get("finished_at"):
        fields["finished_at"] = view["finished_at"]
    if isinstance(view.get("progress"), dict) and view["progress"].get("total"):
        fields["progress"] = {
            key: int(value) for key, value in view["progress"].items() if isinstance(value, int)
        }
    if view.get("reading"):
        if fields:
            rt.runs.update(run_id, **fields)
        return fields
    if isinstance(view.get("rungs"), list):  # its tasks on the ladder, for the rows' mini ladder (0.6.0)
        fields["rungs"] = view["rungs"]
    if (
        state in TERMINAL_STATES
        and view.get("kind") in ("run", "plan")
        and isinstance(view.get("tasks"), list)
    ):
        fields["learning"] = rundata.learning_record(view)  # what it taught, for GET /learning (0.6.0)
        # Its tasks that ran out of rungs (roko's `exhausted`): the build's NEXT names them (phase 2).
        fields["exhausted"] = [
            clean(task["task_id"], 40, one_line=True)
            for task in view["tasks"]
            if isinstance(task, dict) and isinstance(task.get("exhausted"), dict) and task.get("task_id")
        ][:20]
    if isinstance(view.get("homeostat"), dict):  # M1's homeostat as the run last saw it
        fields["homeostat"] = view["homeostat"]
    if state in TERMINAL_STATES and view.get("events_read") is not None:
        # The events of a finished run are complete, so its cost is final.
        fields["cost_final"] = True
    receipt = view.get("receipt")
    if state in TERMINAL_STATES and isinstance(receipt, dict):  # for the build's receipt (round v7, #3)
        top = receipt.get("top_rung")
        fields["receipt"] = {
            **{key: receipt.get(key) for key in ("cost_usd", "top_rung_usd", "not_compared")},
            "top_rung": clean(top.get("model") if isinstance(top, dict) else top, 120, one_line=True) or None,
        }
    if isinstance(view.get("interrupted"), dict):
        fields["interrupted"] = {key: view["interrupted"].get(key) for key in ("reason", "at", "source")}
    if isinstance(view.get("budget_stop"), dict):  # roko stopped it at its cap, or at its daily limit
        fields["budget_stop"] = rundata.budget_stop_row(view["budget_stop"])
    work = view.get("work")
    if isinstance(work, dict) and work.get("kind"):
        fields["work"] = str(work["kind"])
    checks = view.get("source_checks")
    if state in TERMINAL_STATES and view.get("kind") == "plan_generate" and isinstance(checks, dict):
        # roko's own count of the spec's checks the plan keeps (honest since bug-72dc0d), for the build.
        fields["source_checks"] = {key: checks.get(key) for key in KEPT_COUNTS}
    for key in ("checks", "models"):
        if state in TERMINAL_STATES and isinstance(view.get(key), dict) and view[key]:
            fields[key] = view[key]
    why = view.get("why")
    if state in TERMINAL_STATES and isinstance(why, dict) and why.get("summary"):
        # roko may forget a run (a refused start, after a restart): its card can still say why it ended.
        fields["why"] = clean(why["summary"], 600)
    if fields:
        rt.runs.update(run_id, **fields)
    return fields


# GET /learning reads the newest ended runs Hermes started, at most this many; its KPIs compare the first and
# the last few of them.
LEARNING_RUNS = 20
KPI_RUNS = 3


LEARNING_SCOPES = {"hermes": "runs started from Hermes", "workspace": "every plan run in roko's workspace"}


def learning_view(rt: Runtime, params: dict[str, str] | None = None) -> dict[str, Any]:
    """`GET /learning?scope=hermes|workspace`: what roko has learned (docs/ui-api.md), in the runs Hermes
    started (the default) or in every plan run of roko's workspace: the hero KPIs, where work passed on the
    ladder, the lessons that paid off and what the first tries owe them, M1's homeostat, and how much the
    numbers rest on."""
    scope = (params or {}).get("scope") or "hermes"
    if scope not in LEARNING_SCOPES:
        raise RokoError(Code.INVALID, f"scope must be one of {', '.join(LEARNING_SCOPES)}")
    settings = rt.settings()
    logged = rt.runs.recent(200)
    client = rt.client(settings) if connection(rt)["reachable"] else None
    ladder = rt.cards.ladder_view(client, settings.workdir)
    recorded: dict[str, Any] | None = None
    if scope == "hermes":
        everything = [
            {**run, "origin": "hermes", "source": "card"}
            for run in reversed(logged)
            if run.get("state") in TERMINAL_STATES and isinstance(run.get("learning"), dict)
        ]
        ended = everything[-LEARNING_RUNS:]
        coverage: dict[str, Any] = {
            "source": "run log",
            "runs": len(ended),
            "found": len(everything),
            "lessons_from": len(ended),
            "note": None,
        }
    else:
        ended, coverage = _workspace_learning(settings, logged, ladder, client)
        recorded = _recorded_tasks(client)
    rows = [_learning_run(run) for run in ended]
    known = rt.cards.knowledge(client) if client is not None else {}
    first_prompts = [
        run["learning"].get("first_prompt") for run in ended if run["learning"].get("first_prompt")
    ]
    homeostat = next((run["homeostat"] for run in logged if isinstance(run.get("homeostat"), dict)), None)
    return {
        "ok": True,
        "scope": scope,
        "scope_label": LEARNING_SCOPES[scope],
        "coverage": coverage,
        "recorded_tasks": recorded,
        "runs": rows,
        "kpis": {
            # Per verified task: every run's cost over every verified task (plugin-review's question 2).
            "cost_per_pass": _kpi(
                [_spend(run) for run in ended], _per_verified, lambda pair: _per_verified([pair])
            ),
            "first_try_rate": _kpi(
                [(row["first_try"], row["tasks"]) for row in rows], _pooled, lambda pair: _pooled([pair])
            ),
            "climbs_per_run": _kpi([float(row["climbs"]) for row in rows], _mean),
        },
        "lessons_first_try": first_try_line(first_prompts) if first_prompts else None,
        "where_passed": _where_passed(rows, ladder),
        "lessons": _paid_off(ended, known),
        "homeostat": homeostat,
        "checked_at": rundata.now_iso(),
    }


def _workspace_learning(
    settings: Any,
    logged: list[dict[str, Any]],
    ladder: list[dict[str, Any]] | None,
    client: RokoClient | None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The workspace's newest plan runs that closed, oldest first, as `learning_view` reads them: each from
    roko's records of its tries (`rundata.record_learning`), with the prompts and lessons its card saw when
    Hermes started it; and the coverage that says so. Without a shared workspace, only roko's run index's
    count of runs."""
    found = rundata.run_records(settings.workdir, rundata.RECORDS_SCAN)
    if found is None:
        return [], {
            "source": "run index",
            "runs": 0,
            "found": _indexed_runs(client),
            "lessons_from": 0,
            "note": "the plugin does not share roko's workspace: no run records to read",
        }
    mine = {str(run.get("run_id")): run for run in logged}
    entries: list[dict[str, Any]] = []
    for record in reversed(found[:LEARNING_RUNS]):
        learned = rundata.record_learning(settings.workdir, record["run_id"], ladder)
        if learned is None:
            continue
        own = mine.get(record["run_id"])
        seen = own.get("learning") if own is not None else None
        learning = dict(learned["learning"])
        if isinstance(seen, dict):  # its card saw what its prompts carried and the lessons it kept
            learning.update(
                {
                    key: seen.get(key)
                    for key in (
                        "kept",
                        "used",
                        "first_prompt",
                        "roko_cost_per_pass",
                        "roko_cost_usd",
                        "roko_verified",
                    )
                }
            )
        plans = [plan for plan in record["plan_ids"] if plan != record["run_id"]]
        entries.append(
            {
                "run_id": record["run_id"],
                "label": rundata.display_label(own)
                if own
                else ", ".join(plans) or f"run {record['run_id'][:8]}",
                "state": record["state"],
                "finished_at": record["ended_at"] or None,
                "cost_usd": learned["cost_usd"],
                "learning": learning,
                "rungs": learned["rungs"],
                "origin": "hermes" if own is not None else record["origin"],
                "source": "records",
                "lessons_known": isinstance(seen, dict),
            }
        )
    known = sum(1 for entry in entries if entry["lessons_known"])
    note = (
        None
        if known == len(entries)
        else f"lessons and what prompts carried are known for {known} of {len(entries)} runs, the ones "
        "Hermes started"
    )
    return entries, {
        "source": "run records",
        "runs": len(entries),
        "found": len(found),
        "lessons_from": known,
        "note": note,
    }


def _indexed_runs(client: RokoClient | None) -> int | None:
    """How many complete runs roko's run index lists (`GET /api/dashboard/runs`); None when it will not
    say."""
    if client is None:
        return None
    try:
        body = client.get("/api/dashboard/runs")
    except RokoError as exc:
        logger.debug("roko: no run index: %s", exc)
        return None
    rows = body.get("runs") if isinstance(body, dict) else None
    return (
        sum(1 for row in rows if isinstance(row, dict) and row.get("is_complete"))
        if isinstance(rows, list)
        else None
    )


def _recorded_tasks(client: RokoClient | None) -> dict[str, Any] | None:
    """roko's spend over every task it recorded in the workspace (`GET /api/learn/efficiency`), passed or not;
    None when roko will not say."""
    if client is None:
        return None
    from . import insights

    try:
        spend = insights.efficiency(client)
    except RokoError as exc:
        logger.debug("roko: no efficiency: %s", exc)
        return None
    if "total_cost_usd" not in spend:
        return None
    return {
        "tasks": int(spend.get("tasks_recorded") or 0),
        "cost_usd": spend.get("total_cost_usd"),
        "cost_per_task_usd": spend.get("cost_per_task_usd"),
        "typical_task_ms": spend.get("avg_task_duration_ms"),
    }


def _learning_run(run: dict[str, Any]) -> dict[str, Any]:
    record = run["learning"]
    cost = run.get("cost_usd") if isinstance(run.get("cost_usd"), (int, float)) else None
    passed = int(record.get("passed") or 0)
    roko = record.get("roko_cost_per_pass")
    own = round(cost / passed, 6) if cost is not None and passed else None
    each = roko if isinstance(roko, (int, float)) else own
    kept, used = record.get("kept"), record.get("used")
    return {
        "run_id": run.get("run_id"),
        "label": clean(
            run.get("label") if run.get("source") == "records" else rundata.display_label(run),
            120,
            one_line=True,
        ),
        "state": run.get("state"),
        "finished_at": run.get("finished_at"),
        "cost_usd": cost,
        "tasks": int(record.get("tasks") or 0),
        "passed": passed,
        "first_try": int(record.get("first_try") or 0),
        "climbs": int(record.get("climbs") or 0),
        "cost_per_pass": round(float(each), 6) if each is not None else None,
        "cost_per_pass_by": "roko"
        if isinstance(roko, (int, float))
        else "plugin"
        if own is not None
        else None,
        "rungs": run.get("rungs") if isinstance(run.get("rungs"), list) else None,
        "lessons_kept": [str(item["id"]) for item in kept if item.get("id")]
        if isinstance(kept, list)
        else None,
        "lessons_used": sorted({str(item["id"]) for item in used if item.get("id")})
        if isinstance(used, list)
        else None,
        "origin": run.get("origin"),
        "source": run.get("source") or "card",
    }


def _kpi(
    values: list[Any], together: Callable[[list[Any]], float | None], each: Any = None
) -> dict[str, Any]:
    """One hero number: the newest runs' value together, the first runs' (with enough runs to compare), and
    the series per run."""
    each = each or (lambda value: value)
    first = together(values[:KPI_RUNS]) if len(values) > KPI_RUNS else None
    return {
        "value": together(values[-KPI_RUNS:]),
        "first": first,
        "series": [each(value) for value in values],
    }


def _spend(run: dict[str, Any]) -> tuple[float | None, int]:
    """A run's cost and its verified tasks, for the cost per verified task: roko's own figures for the run
    when it gave them (efficiency_trend_updated: model and helper calls together), else the run's cost and its
    tasks that passed."""
    record = run["learning"]
    cost, verified = record.get("roko_cost_usd"), record.get("roko_verified")
    if isinstance(cost, (int, float)) and isinstance(verified, int):
        return float(cost), verified
    own = run.get("cost_usd")
    return (float(own) if isinstance(own, (int, float)) else None), int(record.get("passed") or 0)


def _per_verified(pairs: list[Any]) -> float | None:
    """Cost per verified task over several runs, as one ratio of sums: their cost (every ended run's, failed
    and stopped ones included) over their verified tasks. A run whose cost is unknown is left out of both."""
    known = [(float(cost), int(passed)) for cost, passed in pairs if isinstance(cost, (int, float))]
    verified = sum(passed for _, passed in known)
    return round(sum(cost for cost, _ in known) / verified, 6) if verified else None


# The first-try comparison needs this many tasks on each side before it says which way it points.
COMPARE_FROM = 5


def first_try_line(prompts: list[dict[str, Any]]) -> dict[str, Any]:
    """`lessons_first_try` (docs/ui-api.md, plugin-review's question 3): the tasks whose first prompt carried
    a lesson against those it is compared with, both counts always, the comparison's design, and its
    direction whichever way it points, once each side has COMPARE_FROM tasks. When roko's control arm withheld
    lessons at random, the comparison is with those tasks (randomised); else with every task whose first
    prompt had none (observational)."""

    def side(name: str) -> dict[str, Any]:
        passed = sum(int((prompt.get(name) or [0, 0])[0]) for prompt in prompts)
        of = sum(int((prompt.get(name) or [0, 0])[1]) for prompt in prompts)
        return {"passed": passed, "of": of, "rate": round(passed / of, 4) if of else None}

    shown, withheld = side("with"), side("withheld")
    design = "control_arm" if withheld["of"] else "observational"
    other = withheld if design == "control_arm" else side("without")
    comparable = shown["of"] >= COMPARE_FROM and other["of"] >= COMPARE_FROM
    if not comparable:
        note = f"too few tasks to compare yet (n = {shown['of']} and {other['of']})"
    elif design == "control_arm":
        note = "randomised: roko's control arm withheld the lessons from the tasks without"
    else:
        note = "observational: tasks without a lesson differ in other ways too"
    return {
        "with": shown,
        "without": other,
        "design": design,
        "comparable": comparable,
        "difference": round(shown["rate"] - other["rate"], 4) if comparable else None,
        "note": note,
    }


def _mean(values: list[Any]) -> float | None:
    known = [float(value) for value in values if isinstance(value, (int, float))]
    return round(sum(known) / len(known), 6) if known else None


def _pooled(pairs: list[Any]) -> float | None:
    """A rate over several runs: their counts added up (first-try passes over tasks that ran)."""
    top, bottom = sum(pair[0] for pair in pairs), sum(pair[1] for pair in pairs)
    return round(top / bottom, 4) if bottom else None


def _where_passed(rows: list[dict[str, Any]], ladder: list[dict[str, Any]] | None) -> dict[str, Any] | None:
    """Each run's passes per rung of the ladder, and the cheapest rung's share of them: first runs, last."""
    if not ladder:
        return None
    cheapest = str(ladder[0].get("rung"))
    runs = [
        {
            "run_id": row["run_id"],
            "passed": {str(count.get("rung")): int(count.get("passed") or 0) for count in row["rungs"]},
        }
        for row in rows
        if row["rungs"]
    ]

    def share(chosen: list[dict[str, Any]]) -> float | None:
        total = sum(sum(run["passed"].values()) for run in chosen)
        return round(sum(run["passed"].get(cheapest, 0) for run in chosen) / total, 4) if total else None

    return {
        "rungs": ladder,
        "runs": runs,
        "cheapest_share": {
            "first": share(runs[:KPI_RUNS]) if len(runs) > KPI_RUNS else None,
            "last": share(runs[-KPI_RUNS:]),
        },
    }


def _paid_off(ended: list[dict[str, Any]], known: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """The lessons a run kept that later tries carried (`PaidOff`), most first-try passes first, ≤10."""
    keepers: dict[str, dict[str, Any]] = {}
    for order, run in enumerate(ended):
        for kept in run["learning"].get("kept") or []:
            if kept.get("id"):
                keepers.setdefault(
                    str(kept["id"]),
                    {
                        "order": order,
                        "run_id": run.get("run_id"),
                        "task_id": kept.get("task"),
                        "at": run.get("finished_at"),
                        "text": kept.get("text"),
                    },
                )
    uses: dict[str, list[dict[str, Any]]] = {}
    for order, run in enumerate(ended):
        for use in run["learning"].get("used") or []:
            ident = str(use.get("id") or "")
            keeper = keepers.get(ident)
            if not ident or (
                keeper
                and (
                    keeper["order"] > order
                    or (keeper["order"] == order and keeper["task_id"] == use.get("task"))
                )
            ):
                continue  # not a later use of what a run kept
            uses.setdefault(ident, []).append(
                {
                    "run_id": run.get("run_id"),
                    "task_id": use.get("task"),
                    "first_try": bool(use.get("first_try")),
                    "climbed": bool(use.get("climbed")),
                    "passed": bool(use.get("passed")),
                }
            )
    paid: list[dict[str, Any]] = []
    for ident, chain in uses.items():
        keeper, row = keepers.get(ident), known.get(ident) or {}
        paid.append(
            {
                "id": ident,
                "text": (keeper or {}).get("text") or row.get("text"),
                "kept_by": {key: keeper[key] for key in ("run_id", "task_id", "at")} if keeper else None,
                "uses": chain[-12:],
                "first_try": sum(1 for use in chain if use["first_try"]),
                "confidence": row.get("confidence"),
            }
        )
    paid.sort(key=lambda lesson: (-lesson["first_try"], -len(lesson["uses"])))
    return paid[:10]


def _error(exc: RokoError) -> dict[str, Any]:
    return {"code": exc.code.value, "message": exc.message, "hint": exc.hint}


# -- roko's five loops ---------------------------------------------------------------------

LOOP_RECENT_S = 600


def loops_view(rt: Runtime) -> dict[str, Any]:
    """`GET /loops`: roko's five loops, each with what roko reports for it and its latest events.

    Every part is read on its own; a part roko cannot answer goes into `problems` and its ring shows
    what it has. The latest events come from the live relay (and the cards of Hermes' recent runs).
    """
    from . import insights, loopevents
    from .loopevents import RINGS

    client = rt.client()
    problems: list[str] = []

    def part(name: str, fn: Any, default: Any) -> Any:
        value, problem = insights.safe(fn, client)
        if problem:
            problems.append(f"{name}: {problem}")
            return default
        return value

    recent = recent_loops(rt)
    now_ms = time.time() * 1000
    rings: list[dict[str, Any]] = []
    for ring, (name, clock) in RINGS.items():
        events = [event for event in recent if event.get("ring") == ring]
        fresh = any(
            isinstance(event.get("ts"), int) and now_ms - event["ts"] < LOOP_RECENT_S * 1000
            for event in events
        )
        rings.append(
            {
                "ring": ring,
                "name": name,
                "clock": clock,
                "state": "active" if fresh else "quiet",
                "recent": events[-12:][::-1],
            }
        )
    by_ring = {entry["ring"]: entry for entry in rings}
    by_ring["L0"]["counts"] = {
        "held": part("held calls", insights.held_count, 0),
        "withheld": part("withheld results", insights.withheld_count, 0),
    }
    # What decided each pick (a ladder rung, roko's role table, what it learned): only learned picks were
    # decided by the scores the rows carry.
    by_ring["L1"]["routes"] = [
        loopevents.route_view(row) for row in part("route decisions", insights.route_decisions, [])
    ]
    by_ring["L1"]["retry_budgets"] = part("adaptive thresholds", insights.retry_budgets, [])
    by_ring["L2"]["diagnoses"] = part("diagnoses", insights.diagnoses, [])
    by_ring["L3"]["models"] = part("model scorecard", insights.models, [])
    by_ring["L3"]["thresholds"] = by_ring["L1"]["retry_budgets"]
    by_ring["L3"]["knowledge"] = part("knowledge", insights.knowledge_summary, {"total": 0, "recent": []})
    by_ring["L3"]["playbooks"] = part("playbooks", insights.playbook_summary, {"total": 0})
    by_ring["L4"]["loops"] = part("loop registry", insights.loop_registry, [])
    live = rt.live
    return {
        "rings": rings,
        "live": {"running": live.running, "hub": live.hub_state, "subscribers": live.subscribers()},
        "problems": problems,
        "checked_at": rundata.now_iso(),
    }


def recent_loops(rt: Runtime, limit: int = 120) -> list[dict[str, Any]]:
    """The latest loop events this process saw, oldest first: the relay's, and those on the cards of the
    runs Hermes started recently (cached cards only: this reads nothing from roko), each with its wave
    openings, which the cards derive and the relay sends only for a run it followed from its start."""
    # By run and key: every run has its own "wave:0".
    seen: dict[tuple[str, str], dict[str, Any]] = {}
    for run in rt.runs.recent(5):
        run_id = str(run.get("run_id") or "")
        tracker = rt.cards.tracker(rt.for_run(run_id).settings().url, run_id)
        with tracker.lock:
            events = rundata.card_loops(tracker.fold, tracker.task_rows())
        for event in events:
            seen.setdefault((run_id, str(event.get("key"))), {"run_id": run.get("run_id"), **event})
    for event in list(rt.live.recent_loops):
        key = (str(event.get("run_id") or ""), str(event.get("key")))
        seen[key] = {name: value for name, value in event.items() if name != "type"}
    ordered = sorted(seen.values(), key=_event_ms)
    return ordered[-limit:]


def _event_ms(event: dict[str, Any]) -> int:
    stamp = event.get("ts")
    return stamp if isinstance(stamp, int) else 0

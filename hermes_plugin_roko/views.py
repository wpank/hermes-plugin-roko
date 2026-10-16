"""Views every surface shares: the connection, recent runs, what waits on the person, spend.

The tools, `/roko`, `hermes roko` and the desktop and dashboard UIs all build
their answers from these, so a run reads the same everywhere.
"""

from __future__ import annotations

import contextlib
import logging
import re
import shlex
import time
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from . import ledger, readiness, rundata
from .catalog import TERMINAL_STATES
from .client import RokoClient
from .decisions import name_items, pending_confirmations, pending_effects
from .errors import Code, Refusal, RokoError
from .runtime import Runtime
from .sanitize import clean
from .version import __version__

logger = logging.getLogger(__name__)

# How many runs one overview refreshes from roko: active ones first, then
# finished ones whose cost was never read from their events.
REFRESH_ACTIVE = 6
REFRESH_SETTLE = 3
OVERVIEW_RUNS = 20


def connection(rt: Runtime) -> dict[str, Any]:
    """Whether roko serve answers and accepts the plugin's credential. Never raises."""
    try:
        settings = rt.settings()
        out: dict[str, Any] = {
            "url": settings.display_url,
            "reachable": False,
            "version": None,
            "status": None,
            "credential": settings.credential().source,
            "active_runs": None,
            "active_plans": None,
            "workdir": str(settings.workdir) if settings.workdir else None,
            "error": None,
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
        return out
    out["reachable"] = True
    out["version"] = clean(health.get("version"), 40, one_line=True) or None
    out["status"] = clean(health.get("status"), 40, one_line=True) or None
    try:
        api = client.get("/api/health")
    except RokoError as exc:
        out["error"] = _error(exc)
        return out
    if isinstance(api, dict):
        out["active_runs"] = api.get("active_runs") if isinstance(api.get("active_runs"), int) else None
        out["active_plans"] = api.get("active_plans") if isinstance(api.get("active_plans"), int) else None
    return out


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
    matches = sorted(run for run in known if run.startswith(wanted))
    return matches[0] if len(matches) == 1 else wanted


def card(rt: Runtime, run_id: str, *, summary: dict[str, Any] | None = None) -> dict[str, Any]:
    """The full card for one run; also records what it learned in the run log."""
    run_id = resolve_run_id(rt, run_id)
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
    if built.get("kind") == "plan_generate" and built.get("state") == "failed":
        _name_the_setup_problem(rt, built)
    if logged is not None:
        facts = rundata.tracker_facts(rt.cards, settings.url, run_id) if not built.get("active") else {}
        _remember(rt, run_id, {**built, "checks": facts.get("checks"), "models": facts.get("models")})
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


def cancel(rt: Runtime, run_id: str) -> dict[str, Any]:
    """Stop a run. A run nothing runs any more (its roko serve stopped under it) is interrupted, not an error:
    roko says so since bug-dceafd, and an older roko's "no active execution" for a run it still calls running
    means the same."""
    run_id = resolve_run_id(rt, run_id)
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
    rt.live.poke(run_id)
    return out


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
        "cost_usd": logged.get("cost_usd") if logged.get("cost_final") else None,
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


def refresh_runs(rt: Runtime, client: RokoClient, runs: list[dict[str, Any]]) -> None:
    """Bring the state and spend of logged runs up to date, a bounded number per call."""
    active = [run for run in runs if run.get("state") not in TERMINAL_STATES]
    unsettled = [
        run
        for run in runs
        if run.get("state") in TERMINAL_STATES
        and run.get("kind") in ("run", "plan")
        and not run.get("cost_final")
    ]
    for run in active[:REFRESH_ACTIVE] + unsettled[:REFRESH_SETTLE]:
        run_id = str(run["run_id"])
        try:
            summary = rundata.run_status(client, run_id)
        except RokoError as exc:
            recovered = finished_plan_generation(rt, client, run_id) if exc.code is Code.NOT_FOUND else None
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
            totals = rundata.quick_totals(client, rt.cards, run_id, summary, run)
        except RokoError as exc:
            logger.debug("roko: could not total run %s: %s", run_id, exc)
            totals = {"state": summary.get("state")}
        run.update({key: value for key, value in totals.items() if value is not None})
        run.update(_remember(rt, run_id, totals))


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
                "cost_usd": run.get("cost_usd")
                if run.get("cost_final") or state not in TERMINAL_STATES
                else None,
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
            }
        )
    return rows


def collect_pending(
    rt: Runtime, client: RokoClient, runs: list[dict[str, Any]] | None = None
) -> list[dict[str, Any]]:
    """Everything roko waits on the person for: confirmations in Hermes' active runs, and held actions."""
    runs = runs if runs is not None else rt.runs.recent(10)
    items: list[dict[str, Any]] = []
    for run in runs[:10]:
        if run.get("state") in ("running", "queued", None) and run.get("kind") in ("run", "plan"):
            try:
                items.extend(pending_confirmations(client, str(run["run_id"])))
            except RokoError as exc:
                if exc.code is not Code.NOT_FOUND:
                    raise
    items.extend(pending_effects(client))
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


def spend(rt: Runtime) -> dict[str, Any]:
    settings = rt.settings()
    return ledger.spend(rt.runs.recent(200), settings.max_day_usd)


def ui_overview(rt: Runtime) -> dict[str, Any]:
    """`GET /overview`: everything the status chip, badges and landing page show, in one answer."""
    settings = rt.settings()
    conn = connection(rt)
    runs = rt.runs.recent(OVERVIEW_RUNS)
    pending: list[dict[str, Any]] = []
    if conn["reachable"] and conn["error"] is None:
        client = rt.client(settings)
        refresh_runs(rt, client, runs)
        try:
            pending = collect_pending(rt, client, runs)
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
        "spend": ledger.spend(rt.runs.recent(200), settings.max_day_usd),
        "limits": {"max_run_usd": settings.max_run_usd, "max_day_usd": settings.max_day_usd},
        "permissions": {"write": settings.ui_actions},
        "runs": rows,
        "pending": pending,
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
    result["spend"] = ledger.spend(rt.runs.recent(200), settings.max_day_usd)
    if not recent:
        result["note"] = "No runs started from Hermes yet."
    setup = readiness.setup_view(rt)
    if setup["problems"]:
        # What stands between the person and a working run, with its fix (the setup card's words).
        result["setup_problems"] = setup["problems"]
    result["checked_at"] = rundata.now_iso()
    return result


def _remember(rt: Runtime, run_id: str, view: dict[str, Any]) -> dict[str, Any]:
    """Keep what a refresh learned in the run log, so the ledger and lists see it; return it."""
    fields: dict[str, Any] = {}
    state = view.get("state")
    if isinstance(state, str) and state:
        fields["state"] = state
    if isinstance(view.get("cost_usd"), (int, float)):
        fields["cost_usd"] = round(float(view["cost_usd"]), 6)
    if view.get("finished_at"):
        fields["finished_at"] = view["finished_at"]
    if isinstance(view.get("progress"), dict) and view["progress"].get("total"):
        fields["progress"] = {
            key: int(value) for key, value in view["progress"].items() if isinstance(value, int)
        }
    if state in TERMINAL_STATES and view.get("events_read") is not None:
        # The events of a finished run are complete, so its cost is final.
        fields["cost_final"] = True
    if isinstance(view.get("interrupted"), dict):
        fields["interrupted"] = {key: view["interrupted"].get(key) for key in ("reason", "at", "source")}
    if isinstance(view.get("budget_stop"), dict):  # roko stopped it at its cap, or at its daily limit
        fields["budget_stop"] = rundata.budget_stop_row(view["budget_stop"])
    work = view.get("work")
    if isinstance(work, dict) and work.get("kind"):
        fields["work"] = str(work["kind"])
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
    url = rt.settings().url
    for run in rt.runs.recent(5):
        run_id = str(run.get("run_id") or "")
        tracker = rt.cards.tracker(url, run_id)
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

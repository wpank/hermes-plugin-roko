"""The eight `roko_*` tools Hermes offers the model.

Every handler has Hermes' tool signature, `(args, **kwargs) -> str`, returns a
JSON string, and never raises: a failure comes back as `{"error", "code",
"hint"}` so the model can explain it or recover. Tools that spend money or
record a decision for the person ask the person first, through Hermes' own
approval gate, before anything reaches roko.

Two Hermes heuristics shape the results (agent/display.py and
agent/tool_guardrails.py on 0.21.0). A result with a bare `"failed"` or
`"error"` token in its first 500 characters counts as a failed call, and a
tool that "fails" 8 times in a turn is halted. A call that repeats the same
arguments and gets a byte-identical result 3 times draws a "do not repeat it"
note, and on gateways the turn halts at 5. So successful results avoid those
tokens, and status results carry the time they were checked.
"""

from __future__ import annotations

import contextlib
import json
import logging
import math
import time
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any
from urllib.parse import quote

from . import _hermes
from .catalog import DEFAULT_WAIT_SECS, MAX_WAIT_SECS, TERMINAL_STATES
from .client import RokoClient
from .decisions import (
    answer,
    describe,
    find_pending,
    parse_decision_id,
    pending_confirmations,
    pending_effects,
    pending_for_run,
)
from .errors import Code, RokoError
from .runtime import Runtime
from .settings import Settings
from .workspace import delivered_work

logger = logging.getLogger(__name__)

Handler = Callable[..., str]
ToolFn = Callable[[Runtime, dict[str, Any], dict[str, Any]], dict[str, Any]]

# Hermes budgets 100,000 characters per tool result; roko answers are small,
# but plan listings and recall can grow, so the plugin keeps well under it.
MAX_RESULT_CHARS = 12_000
# roko serve's run_status waits up to 30 s per request; the plugin asks in
# short slices so it notices an interrupt, and so a slow answer costs little.
WAIT_CHUNK_SECS = 5
RECALL_MAX = 20
MIN_CAP_USD = 0.01


def make_handlers(rt: Runtime) -> dict[str, Handler]:
    """Hermes tool handlers, by tool name."""
    return {name: _wrap(rt, name, fn) for name, fn in _TOOLS.items()}


def call(rt: Runtime, name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Run one tool's logic directly: returns its result or raises `RokoError`."""
    return _TOOLS[name](rt, dict(args), {})


def _wrap(rt: Runtime, name: str, fn: ToolFn) -> Handler:
    def handler(args: dict[str, Any] | None = None, **kwargs: Any) -> str:
        try:
            if args is not None and not isinstance(args, dict):
                raise RokoError(Code.INVALID, f"{name} takes a JSON object of arguments")
            return _dump(fn(rt, dict(args or {}), kwargs))
        except RokoError as exc:
            return json.dumps(exc.as_dict(), ensure_ascii=False)
        except Exception as exc:  # never let a bug surface as a Hermes tool crash
            logger.exception("roko: %s failed", name)
            return json.dumps(
                {"error": f"the roko plugin failed: {type(exc).__name__}: {exc}", "code": "internal"},
                ensure_ascii=False,
            )

    handler.__name__ = f"{name}_handler"
    return handler


# -- the tools ---------------------------------------------------------------


def _run(rt: Runtime, args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    settings = rt.settings()
    prompt = _required_str(args, "prompt")
    max_usd = _cap(args, settings)
    domain = _optional_str(args, "domain")
    if settings.approve_paid:
        where = f" ({domain})" if domain else ""
        _approve(
            "roko_run",
            f"roko will run one gated task{where}, spending up to ${max_usd:.2f}:\n{_preview(prompt)}",
            f"roko:run_prompt:{max_usd:.2f}",
        )
    arguments: dict[str, Any] = {"prompt": prompt, "max_usd": max_usd}
    if domain:
        arguments["domain"] = domain
    body = _start(rt.client(settings), "run_prompt", arguments)
    run_id = _run_id(body, "run_prompt")
    rt.runs.add(
        run_id, "run", prompt, session_id=ctx.get("session_id"), state=body.get("state"), max_usd=max_usd
    )
    return {"run_id": run_id, "state": body.get("state"), "max_usd": max_usd, "next": _follow(run_id)}


def _plan_generate(rt: Runtime, args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    settings = rt.settings()
    prompt = _required_str(args, "prompt")
    if settings.approve_paid:
        _approve(
            "roko_plan_generate",
            f"roko's planner will write a plan (model spend, nothing runs yet):\n{_preview(prompt)}",
            "roko:plan_generate",
        )
    body = _start(rt.client(settings), "plan_generate", {"prompt": prompt})
    run_id = _run_id(body, "plan_generate")
    plan_id = body.get("plan_id")
    rt.runs.add(
        run_id,
        "plan_generate",
        prompt,
        plan_id=str(plan_id) if plan_id else None,
        session_id=ctx.get("session_id"),
        state=body.get("state"),
    )
    return {
        "run_id": run_id,
        "plan_id": plan_id,
        "state": body.get("state"),
        "next": (
            f"Call roko_status with run_id {run_id} until it succeeds, then show the plan with "
            f"roko_plans(plan_id={plan_id!s}) and ask the person before roko_plan_run."
        ),
    }


def _plan_run(rt: Runtime, args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    settings = rt.settings()
    plan_id = _required_str(args, "plan_id")
    max_usd = _cap(args, settings)
    resume = _optional_bool(args, "resume", False)
    if settings.approve_paid:
        verb = "resume" if resume else "run"
        _approve(
            "roko_plan_run",
            f"roko will {verb} plan '{plan_id}', spending up to ${max_usd:.2f}.",
            f"roko:plan_run:{plan_id}:{max_usd:.2f}",
        )
    body = _start(rt.client(settings), "plan_run", {"plan_id": plan_id, "resume": resume, "max_usd": max_usd})
    run_id = _run_id(body, "plan_run")
    rt.runs.add(
        run_id,
        "plan",
        plan_id,
        plan_id=plan_id,
        session_id=ctx.get("session_id"),
        state=body.get("state"),
        max_usd=max_usd,
    )
    result: dict[str, Any] = {
        "run_id": run_id,
        "state": body.get("state"),
        "plan_id": plan_id,
        "max_usd": max_usd,
    }
    if body.get("position") is not None:
        result["queue_position"] = body.get("position")
    result["next"] = _follow(run_id)
    return result


def _status(rt: Runtime, args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    run_id = _optional_str(args, "run_id")
    if not run_id:
        view = overview(rt)
        view["recent_runs"] = [_run_line(run) for run in view.get("recent_runs", [])]
        return view
    wait = _bounded_int(args, "wait_secs", DEFAULT_WAIT_SECS, 0, MAX_WAIT_SECS)
    settings = rt.settings()
    client = rt.client(settings)
    started = time.monotonic()
    try:
        summary = _wait_for_change(client, run_id, wait)
    except RokoError as exc:
        recovered = _finished_plan_generation(rt, client, run_id) if exc.code is Code.NOT_FOUND else None
        if recovered is None:
            raise
        summary = recovered
    result = _trim_summary(summary)
    state = str(result.get("state") or "")
    rt.runs.update(run_id, state=state or None, cost_usd=result.get("cost_usd"))
    waiting = _waiting(client, run_id, state)
    if waiting:
        result["waiting_on_person"] = waiting
    if state in TERMINAL_STATES and not str(result.get("kind") or "").startswith("plan_generate:"):
        delivered = delivered_work(settings.workdir, run_id)
        if delivered and delivered.get("files_changed"):
            result["delivered"] = {"workspace": str(settings.workdir), **delivered}
    result["checked_at"] = _now()
    result["waited_s"] = round(time.monotonic() - started, 1)
    result["next"] = _next_step(result, bool(waiting))
    return result


def _cancel(rt: Runtime, args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    run_id = _required_str(args, "run_id")
    body = _object(rt.client().call_tool("run_cancel", {"run_id": run_id}), "run_cancel")
    rt.runs.update(run_id, state=str(body.get("state") or "cancelled"))
    return {"run_id": run_id, "state": body.get("state", "cancelled")}


def _plans(rt: Runtime, args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    plan_id = _optional_str(args, "plan_id")
    client = rt.client()
    if plan_id:
        return plan_detail(client, plan_id)
    plans = client.get("/api/plans")
    if not isinstance(plans, list):
        raise RokoError(Code.PROTOCOL, "GET /api/plans did not return a list")
    listed = [_plan_row(plan) for plan in plans if isinstance(plan, dict)]
    result: dict[str, Any] = {"plans": listed[:60], "total": len(listed)}
    if len(listed) > 60:
        result["note"] = "only the first 60 plans are shown"
    if not listed:
        result["note"] = "roko has no plans yet; write one with roko_plan_generate"
    return result


def _recall(rt: Runtime, args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    query = _required_str(args, "query")
    limit = _bounded_int(args, "limit", 5, 1, RECALL_MAX)
    body = _object(rt.client().call_tool("recall", {"query": query, "limit": limit}), "recall")
    entries = [
        {
            "content": _clip(str(entry.get("content", "")), 600),
            "kind": entry.get("kind"),
            "tier": entry.get("tier"),
            "confidence": entry.get("relevance"),
            "created_at": entry.get("created_at"),
        }
        for entry in _list(body.get("results"))
        if isinstance(entry, dict)
    ]
    result: dict[str, Any] = {"query": query, "entries": entries}
    if not entries:
        result["note"] = "roko's knowledge store has nothing on this yet"
    return result


def _decide(rt: Runtime, args: dict[str, Any], ctx: dict[str, Any]) -> dict[str, Any]:
    settings = rt.settings()
    decision_id = _required_str(args, "decision_id")
    approve = _required_bool(args, "approve")
    note = _optional_str(args, "note")
    decision = parse_decision_id(decision_id)
    client = rt.client(settings)
    # Answer only what roko still waits on, and show the person what it is:
    # an id alone would let a confused model attach their "yes" to another item.
    item = find_pending(client, decision)
    if item is None:
        raise RokoError(
            Code.NOT_FOUND,
            f"roko is not waiting on {decision_id}: it was answered already, or never existed",
            hint="call roko_status for the run to see what still waits on the person",
        )
    if settings.confirm_decisions:
        verdict = "APPROVE" if approve else "REJECT"
        extra = f"\nNote: {_preview(note, 200)}" if note else ""
        _approve(
            "roko_decide",
            f"Record YOUR decision in roko: {verdict} {describe(item)}.{extra}\n"
            "Approve only if this is what you, the person, decided.",
            # The verdict is part of the key, so answering "always" to one
            # verdict never approves the opposite one later.
            f"roko:decide:{decision_id}:{'approve' if approve else 'reject'}",
        )
    body = answer(client, decision, approve, note)
    return {"decision_id": decision_id, "approved": approve, "recorded": body}


_TOOLS: dict[str, ToolFn] = {
    "roko_status": _status,
    "roko_plans": _plans,
    "roko_run": _run,
    "roko_plan_generate": _plan_generate,
    "roko_plan_run": _plan_run,
    "roko_cancel": _cancel,
    "roko_recall": _recall,
    "roko_decide": _decide,
}


# -- shared views (also used by /roko and `hermes roko status`) ---------------


def overview(rt: Runtime) -> dict[str, Any]:
    """roko's health, the runs Hermes started recently, and what waits on the person."""
    settings = rt.settings()
    client = rt.client(settings)
    health = client.health()
    roko: dict[str, Any] = {
        "url": settings.display_url,
        "version": health.get("version"),
        "status": health.get("status"),
    }
    try:
        api = client.get("/api/health")
        if isinstance(api, dict):
            roko["active_runs"] = api.get("active_runs")
            roko["active_plans"] = api.get("active_plans")
    except RokoError as exc:
        roko["api_problem"] = f"{exc.message} ({exc.code.value})"
    recent = rt.runs.recent(8)
    refreshed = 0
    for run in recent:
        if run.get("state") in TERMINAL_STATES or refreshed >= 5:
            continue
        refreshed += 1
        try:
            summary = _object(
                client.call_tool("run_status", {"run_id": run["run_id"], "wait_secs": 0}), "run_status"
            )
        except RokoError as exc:
            recovered = (
                _finished_plan_generation(rt, client, str(run["run_id"]))
                if exc.code is Code.NOT_FOUND
                else None
            )
            if recovered is None:
                run["note"] = exc.message
                continue
            summary = recovered
        run["state"] = summary.get("state")
        if summary.get("cost_usd") is not None:
            run["cost_usd"] = summary.get("cost_usd")
        rt.runs.update(run["run_id"], state=run.get("state"), cost_usd=run.get("cost_usd"))
    result: dict[str, Any] = {
        "roko": roko,
        "recent_runs": [
            {
                key: run.get(key)
                for key in ("run_id", "kind", "label", "plan_id", "state", "cost_usd", "started_at", "note")
                if run.get(key) is not None
            }
            for run in recent
        ],
    }
    waiting: list[dict[str, Any]] = []
    for run in recent:
        if run.get("state") in ("running", "queued"):
            with contextlib.suppress(RokoError):
                waiting.extend(pending_confirmations(client, run["run_id"]))
    with contextlib.suppress(RokoError):
        waiting.extend(pending_effects(client))
    if waiting:
        result["waiting_on_person"] = waiting
    if not recent:
        result["note"] = "No runs started from Hermes yet."
    result["checked_at"] = _now()
    return result


def plan_detail(client: RokoClient, plan_id: str) -> dict[str, Any]:
    body = _object(client.get(f"/api/plans/{quote(plan_id, safe='')}/tasks"), "GET /api/plans/{id}/tasks")
    tasks = _list(body.get("tasks"))
    return {
        "plan_id": body.get("plan_id", plan_id),
        "title": body.get("title"),
        "task_count": body.get("task_count", len(tasks)),
        "max_parallel": body.get("max_parallel"),
        "tasks": [_task_row(task) for task in tasks[:40] if isinstance(task, dict)],
        **({"note": f"only the first 40 of {len(tasks)} tasks are shown"} if len(tasks) > 40 else {}),
    }


# -- helpers -----------------------------------------------------------------


def _start(client: RokoClient, tool: str, arguments: dict[str, Any]) -> dict[str, Any]:
    """Call a tool that starts paid work; a timeout may still have started it."""
    try:
        return _object(client.call_tool(tool, arguments), tool)
    except RokoError as exc:
        if exc.timed_out:
            raise RokoError(
                Code.UNREACHABLE,
                f"roko did not answer {tool} in time; the work may have started anyway",
                hint="call roko_status without a run_id and look for a new run before trying again, "
                "so the work does not run twice",
                timed_out=True,
            ) from exc
        raise


def _wait_for_change(client: RokoClient, run_id: str, wait: int) -> dict[str, Any]:
    """`run_status`, waiting up to `wait` seconds in short slices so an interrupt is noticed."""
    deadline = time.monotonic() + wait
    previous: str | None = None
    while True:
        remaining = max(0, math.ceil(deadline - time.monotonic()))
        chunk = min(WAIT_CHUNK_SECS, remaining)
        started = time.monotonic()
        summary = _object(
            client.call_tool("run_status", {"run_id": run_id, "wait_secs": chunk}, timeout=chunk + 15.0),
            "run_status",
        )
        state = summary.get("state")
        returned_early = chunk > 0 and time.monotonic() - started < chunk - 0.5
        if (
            chunk == 0
            or state in TERMINAL_STATES
            or returned_early
            or (previous is not None and state != previous)
            or time.monotonic() >= deadline
            or _hermes.is_interrupted()
        ):
            return summary
        previous = str(state) if state is not None else None


def _finished_plan_generation(rt: Runtime, client: RokoClient, run_id: str) -> dict[str, Any] | None:
    """roko forgets a plan_generate operation a minute after it ends; the plan itself stays."""
    run = rt.runs.get(run_id)
    if not run or run.get("kind") != "plan_generate" or not run.get("plan_id"):
        return None
    plan_id = str(run["plan_id"])
    try:
        detail = plan_detail(client, plan_id)
    except RokoError:
        return None
    return {
        "run_id": run_id,
        "kind": f"plan_generate:{plan_id}",
        "state": "succeeded",
        "result": {"slug": plan_id, "task_count": detail.get("task_count")},
    }


def _waiting(client: RokoClient, run_id: str, state: str) -> list[dict[str, Any]]:
    try:
        if state in ("running", "queued"):
            return pending_for_run(client, run_id)
        return pending_effects(client, run_id)
    except RokoError as exc:
        logger.debug("roko: could not list what run %s waits on: %s", run_id, exc)
        return []


def _trim_summary(summary: dict[str, Any]) -> dict[str, Any]:
    keep = (
        "run_id",
        "kind",
        "state",
        "verdict",
        "active",
        "position",
        "cost_usd",
        "tasks",
        "milestones",
        "untrusted_input_boundary",
        "started_at",
        "finished_at",
        "result",
        "error",
    )
    trimmed = {key: summary[key] for key in keep if key in summary and summary[key] is not None}
    tasks = trimmed.get("tasks")
    if isinstance(tasks, dict):
        # A "failed" task count on every poll would make Hermes count the poll
        # as a failed call (see the module docstring).
        trimmed["tasks"] = {("not_passed" if key == "failed" else key): value for key, value in tasks.items()}
    if "error" in trimmed:
        trimmed["planner_error"] = trimmed.pop("error")
    kind = str(trimmed.get("kind") or "")
    if kind.startswith("plan_generate:"):
        result = trimmed.get("result")
        if isinstance(result, dict) and result.get("slug"):
            trimmed["plan_id"] = result.get("slug")
    return trimmed


def _next_step(result: dict[str, Any], waiting: bool) -> str:
    state = result.get("state")
    run_id = result.get("run_id")
    if waiting:
        return (
            "The run waits on the person: ask them about each waiting_on_person item and pass "
            "their answer to roko_decide. Do not answer for them."
        )
    if str(result.get("kind") or "").startswith("plan_generate:"):
        if state == "succeeded":
            return (
                f"The plan is written: show it with roko_plans(plan_id={result.get('plan_id')!s}) "
                "and ask the person before running it with roko_plan_run."
            )
        if state == "failed":
            return "The planner did not produce a plan; report planner_error to the person."
    if state in ("queued", "running"):
        return f"Still {state}. Call roko_status with run_id {run_id} again to keep waiting."
    delivered = result.get("delivered")
    if state == "succeeded" and isinstance(delivered, dict) and not delivered.get("merged"):
        branch, workspace = delivered.get("branch"), delivered.get("workspace")
        return (
            "Done, and roko's gates verified the result. The change is on branch "
            f"{branch} in roko's workspace {workspace}, not merged into its checked-out branch. "
            "Tell the person what changed (delivered.files_changed) and the cost; they can review "
            f"it with `git -C {workspace} diff HEAD...{branch}` and merge it with "
            f"`git -C {workspace} merge {branch}`. No need to look for the workspace yourself."
        )
    if state == "succeeded":
        return "Done, and roko's gates verified the result. Report the outcome and its cost."
    if state == "unverified":
        return "The run ended but no gate checked the result: tell the person it is unverified."
    if state == "failed":
        return "The run did not pass. Report why, using the milestones and task results."
    if state == "cancelled":
        return "The run was cancelled."
    return "Report this state to the person."


def _run_line(run: dict[str, Any]) -> str:
    """One recent run as a line: readable, and free of Hermes' failure tokens."""
    cost = f" · ${float(run['cost_usd']):.2f}" if isinstance(run.get("cost_usd"), (int, float)) else ""
    plan = f" · plan {run['plan_id']}" if run.get("plan_id") else ""
    note = f" · {run['note']}" if run.get("note") else ""
    return (
        f"{run.get('run_id')} · {run.get('state') or 'unknown'}{cost} · {run.get('kind')}{plan} · "
        f"{run.get('label', '')} · started {run.get('started_at', '?')}{note}"
    )


def _plan_row(plan: dict[str, Any]) -> dict[str, Any]:
    row = {
        key: plan.get(key)
        for key in ("id", "title", "task_count", "tasks_done", "tasks_failed", "status", "last_error")
        if plan.get(key) not in (None, "")
    }
    if row.get("status") == "failed":
        row["status"] = "last run did not pass"
    if "last_error" in row:
        row["last_error"] = _clip(str(row["last_error"]), 200)
    return row


def _task_row(task: dict[str, Any]) -> dict[str, Any]:
    row: dict[str, Any] = {
        key: task.get(key)
        for key in ("id", "title", "status", "role", "depends_on")
        if task.get(key) not in (None, "", [])
    }
    if row.get("status") == "failed":
        row["status"] = "did not pass"
    description = task.get("description")
    if isinstance(description, str) and description:
        row["description"] = _clip(description, 300)
    verify = task.get("verify")
    if isinstance(verify, list) and verify:
        row["checks"] = [
            _clip(str(step.get("command", "")), 160) for step in verify[:4] if isinstance(step, dict)
        ]
    return row


def _approve(tool_name: str, message: str, rule_key: str) -> None:
    approved, reason = _hermes.request_approval(tool_name, message, rule_key)
    if not approved:
        raise RokoError(Code.DENIED, reason or f"the person did not approve {tool_name}")


def _cap(args: dict[str, Any], settings: Settings) -> float:
    if "max_usd" not in args or args.get("max_usd") in (None, ""):
        raise RokoError(
            Code.INVALID,
            "max_usd is required: name a spending cap for this run",
            hint=f"pass max_usd between {MIN_CAP_USD:.2f} and {settings.max_run_usd:.2f}",
        )
    try:
        value = float(args["max_usd"])
    except (TypeError, ValueError) as exc:
        raise RokoError(Code.INVALID, f"max_usd must be a number, not {args['max_usd']!r}") from exc
    if not math.isfinite(value) or round(value, 2) < MIN_CAP_USD:
        raise RokoError(Code.INVALID, f"max_usd must be at least {MIN_CAP_USD:.2f}")
    if value > settings.max_run_usd + 1e-9:
        raise RokoError(
            Code.INVALID,
            f"max_usd {value:.2f} is above the {settings.max_run_usd:.2f} cap set for runs "
            "started from Hermes",
            hint="pick a smaller cap, or raise plugins.entries.roko.settings.max_run_usd "
            "(roko serve has its own cap too)",
        )
    return round(value, 2)


def _required_str(args: dict[str, Any], key: str) -> str:
    value = args.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RokoError(Code.INVALID, f"{key} is required and must be a non-empty string")
    return value.strip()


def _optional_str(args: dict[str, Any], key: str) -> str | None:
    value = args.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        raise RokoError(Code.INVALID, f"{key} must be a string")
    return value.strip() or None


def _required_bool(args: dict[str, Any], key: str) -> bool:
    if key not in args:
        raise RokoError(Code.INVALID, f"{key} is required (true or false)")
    return _optional_bool(args, key, False)


def _optional_bool(args: dict[str, Any], key: str, default: bool) -> bool:
    value = args.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "false"):
        return value.strip().lower() == "true"
    if value is None:
        return default
    raise RokoError(Code.INVALID, f"{key} must be true or false")


def _bounded_int(args: dict[str, Any], key: str, default: int, low: int, high: int) -> int:
    value = args.get(key, default)
    if value is None:
        return default
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise RokoError(Code.INVALID, f"{key} must be a whole number") from exc
    return max(low, min(high, number))


def _follow(run_id: str) -> str:
    return f"Call roko_status with run_id {run_id} until the run ends, then report its verdict and cost."


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="milliseconds")


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _object(value: Any, what: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise RokoError(Code.PROTOCOL, f"{what} did not answer with a JSON object")
    return value


def _run_id(body: dict[str, Any], what: str) -> str:
    run_id = body.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise RokoError(Code.PROTOCOL, f"{what} answered without a run_id")
    return run_id


def _preview(text: str, limit: int = 300) -> str:
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[: limit - 1] + "…"


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _dump(payload: dict[str, Any]) -> str:
    text = json.dumps(payload, ensure_ascii=False, default=str)
    if len(text) <= MAX_RESULT_CHARS:
        return text
    text = json.dumps(_shrink(payload), ensure_ascii=False, default=str)
    if len(text) <= MAX_RESULT_CHARS:
        return text
    # Still too long: hand back valid JSON with the start of the result.
    return json.dumps({"truncated": True, "partial": text[: MAX_RESULT_CHARS - 200]}, ensure_ascii=False)


def _shrink(value: Any, depth: int = 0) -> Any:
    if isinstance(value, str):
        return _clip(value, 400)
    if isinstance(value, list):
        items = [_shrink(item, depth + 1) for item in value[:15]]
        if len(value) > 15:
            items.append(f"… {len(value) - 15} more")
        return items
    if isinstance(value, dict):
        return {key: _shrink(item, depth + 1) for key, item in value.items()}
    return value

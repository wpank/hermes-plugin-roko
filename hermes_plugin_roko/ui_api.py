"""The routes the desktop and dashboard halves call, under `/api/plugins/roko`.

`build_router()` returns a FastAPI router. `dashboard/plugin_api.py` exports it
as `router`, and Hermes mounts it in both of its web backends: `hermes serve`
(behind the desktop app) and `hermes dashboard`. docs/ui-api.md is the contract.

- Every route answers 200 with `{"ok": true, ...}` or `{"ok": false, "error":
  {"code", "message", "hint"}}`; a non-200 means the route itself is missing.
- Hermes authenticates every request before it gets here. These routes add no
  auth of their own, and never do more than the plugin's roko key allows.
- The roko API key stays in this process: the UIs only see these answers.
- Blocking work runs in a worker thread, so a slow roko never stalls Hermes.
- A click in the UI is the person acting, so starting a plan, answering a held
  item and cancelling need no second approval. `ui_actions: false` turns them
  off, and every start is checked against the run cap and the daily limit.
"""

# No `from __future__ import annotations` here: FastAPI reads the route
# functions' annotations at runtime, and `Request` is only imported inside
# `build_router`, so string annotations could not be resolved.
import asyncio
import json
import logging
import math
from collections.abc import Callable
from typing import Any
from urllib.parse import quote

from . import (
    _hermes,
    estimate,
    insights,
    live_relay,
    plansheet,
    readiness,
    review,
    rundata,
    runwork,
    tools,
    views,
)
from .decisions import answer, find_pending, parse_decision_id
from .diagnostics import run_doctor
from .errors import Code, RokoError
from .runtime import Runtime
from .sanitize import clean

logger = logging.getLogger(__name__)

MAX_BODY_BYTES = 16_384
EVENTS_DEFAULT = 100
EVENTS_MAX = 200
KNOWLEDGE_DEFAULT = 10
KNOWLEDGE_MAX = 50
MAX_ID_CHARS = 200

Work = Callable[[Runtime], dict[str, Any]]


def build_router(runtime: Callable[[], Runtime]) -> Any:
    """A FastAPI router whose routes use the Runtime `runtime()` returns."""
    from fastapi import APIRouter, Request, WebSocket
    from fastapi.responses import JSONResponse

    router = APIRouter()

    async def reply(work: Work) -> JSONResponse:
        body = await asyncio.to_thread(guarded, runtime, work)
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    @router.get("/overview")
    async def get_overview() -> JSONResponse:
        return await reply(views.ui_overview)

    @router.get("/runs/{run_id}")
    async def get_run(run_id: str) -> JSONResponse:
        return await reply(lambda rt: {"run": views.card(rt, _id(run_id, "run id"))})

    @router.get("/runs/{run_id}/events")
    async def get_run_events(run_id: str, request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: timeline(rt, _id(run_id, "run id"), params))

    @router.post("/runs/{run_id}/cancel")
    async def post_cancel(run_id: str, request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: cancel_run(rt, _id(run_id, "run id"), payload))

    @router.get("/runs/{run_id}/diff")
    async def get_run_diff(run_id: str, request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: {"diff": review.run_diff(rt, _id(run_id, "run id"), params)})

    @router.get("/runs/{run_id}/merge")
    async def get_merge_check(run_id: str, request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: {"merge": review.merge_check(rt, _id(run_id, "run id"), params)})

    @router.post("/runs/{run_id}/merge")
    async def post_merge(run_id: str, request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: merge_run(rt, _id(run_id, "run id"), payload))

    @router.post("/runs")
    async def post_run(request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: start_run(rt, payload))

    @router.get("/plans")
    async def get_plans() -> JSONResponse:
        return await reply(plan_rows)

    @router.get("/plans/{plan_id}")
    async def get_plan(plan_id: str) -> JSONResponse:
        return await reply(lambda rt: {"plan": plansheet.plan_sheet(rt, _id(plan_id, "plan id"))})

    @router.post("/plans/{plan_id}/run")
    async def post_plan_run(plan_id: str, request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: start_plan(rt, _id(plan_id, "plan id"), payload))

    @router.get("/learning")
    async def get_learning(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: views.learning_view(rt, params))

    @router.get("/estimate")
    async def get_estimate(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: estimate_request(rt, params))

    @router.get("/pending")
    async def get_pending() -> JSONResponse:
        return await reply(lambda rt: {"items": views.collect_pending(rt, rt.client())})

    @router.post("/decide")
    async def post_decide(request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: decide(rt, payload))

    @router.get("/knowledge")
    async def get_knowledge(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: knowledge(rt, params))

    @router.get("/health")
    async def get_health() -> JSONResponse:
        return await reply(health)

    @router.get("/setup/fix")
    async def get_setup_fix(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: setup_fix_preview(rt, params))

    @router.post("/setup/fix")
    async def post_setup_fix(request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: setup_fix(rt, payload))

    @router.get("/insights")
    async def get_insights(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: insight_view(rt, params))

    @router.get("/effects")
    async def get_effects() -> JSONResponse:
        return await reply(lambda rt: insights.effects(rt.client()))

    @router.get("/loops")
    async def get_loops() -> JSONResponse:
        return await reply(views.loops_view)

    @router.websocket("/live")
    async def live(websocket: WebSocket) -> None:
        await live_socket(websocket, runtime)

    return router


# -- the live socket ----------------------------------------------------------------

MAX_SOCKET_RUNS = 8


async def live_socket(websocket: Any, runtime: Callable[[], Runtime]) -> None:
    """`WS /live`: a `hello` frame, then the relay's frames as they come (docs/ui-api.md).

    Receive-only: the desktop app's `ctx.socket` cannot send, so `?runs=a,b` (runs Hermes did not
    start) is the only input. A ping goes out after 15 s without a frame, so a dead socket is noticed.
    """
    if not ws_authorized(websocket):
        await websocket.close(code=4401)
        return
    await websocket.accept()
    runs = [
        run_id
        for run_id in (part.strip() for part in str(websocket.query_params.get("runs") or "").split(","))
        if run_id and len(run_id) <= MAX_ID_CHARS and clean(run_id, MAX_ID_CHARS, one_line=True) == run_id
    ][:MAX_SOCKET_RUNS]
    rt = runtime()
    sub = rt.live.subscribe(asyncio.get_running_loop(), runs)
    closed = asyncio.create_task(_until_closed(websocket))
    closed.add_done_callback(_quiet)
    try:
        hello = await asyncio.to_thread(rt.live.hello)
        await websocket.send_text(json.dumps(_finite(hello), ensure_ascii=False))
        while not closed.done():
            getter = asyncio.create_task(sub.get(live_relay.PING_S))
            done, _ = await asyncio.wait({getter, closed}, return_when=asyncio.FIRST_COMPLETED)
            if getter not in done:
                getter.cancel()
                break
            frame = getter.result() or {"type": "ping", "server_time": rundata.now_iso()}
            await websocket.send_text(json.dumps(_finite(frame), ensure_ascii=False))
    except Exception as exc:  # a closed socket, mostly; never let it reach Hermes' log as an error
        logger.debug("roko: live socket ended: %s", type(exc).__name__)
    finally:
        rt.live.unsubscribe(sub)
        closed.cancel()


def _quiet(task: asyncio.Task[None]) -> None:
    """Retrieve a finished task's exception, so a socket that died mid-read logs nothing."""
    if not task.cancelled():
        task.exception()


async def _until_closed(websocket: Any) -> None:
    while True:
        message = await websocket.receive()
        if message.get("type") == "websocket.disconnect":
            return


def ws_authorized(websocket: Any) -> bool:
    """Hermes' check for the socket's credential; allowed in a bare FastAPI app (tests, tools)."""
    verdict = _hermes.ws_auth_ok(websocket)
    return True if verdict is None else verdict


# -- the work behind each route (plain functions, so tests need no web server) --


def guarded(runtime: Callable[[], Runtime], work: Work) -> dict[str, Any]:
    """`work`'s answer as `{"ok": true, ...}`, or its failure as `{"ok": false, "error": ...}`."""
    try:
        result = work(runtime())
        body: dict[str, Any] = {"ok": True, **{key: value for key, value in result.items() if key != "ok"}}
    except RokoError as exc:
        body = {"ok": False, "error": {"code": exc.code.value, "message": exc.message, "hint": exc.hint}}
        if exc.problem:
            # A setup problem the person can fix: the page shows its card, not the raw error.
            body["problem"] = exc.problem
        if isinstance(exc, tools.PlanInvalid) and exc.validation is not None:
            # What roko's validator found in the plan, as the plan card shows it (PlanValidation).
            body["validation"] = exc.validation
    except Exception as exc:  # a bug must still answer 200 with a reason
        logger.exception("roko: a UI route failed")
        body = {
            "ok": False,
            "error": {
                "code": "internal",
                "message": f"the roko plugin failed: {type(exc).__name__}",
                "hint": "Hermes' log has the details",
            },
        }
    finite = _finite(body)
    assert isinstance(finite, dict)
    return finite


async def read_json(request: Any) -> dict[str, Any] | RokoError:
    """The request's JSON object, or the error to answer with."""
    raw = await request.body()
    if len(raw) > MAX_BODY_BYTES:
        return RokoError(Code.INVALID, "the request body is too large")
    if not raw.strip():
        return {}
    try:
        value = json.loads(raw)
    except ValueError:
        return RokoError(Code.INVALID, "the request body is not JSON")
    if not isinstance(value, dict):
        return RokoError(Code.INVALID, "the request body must be a JSON object")
    return value


def timeline(rt: Runtime, run_id: str, params: dict[str, str]) -> dict[str, Any]:
    """`GET /runs/{id}/events`: the run's readable timeline, from `cursor` on, or its last `tail` lines."""
    run_id = views.resolve_run_id(rt, run_id)
    client = rt.client()
    tail = _int_param(params, "tail", None, 1, rundata.MAX_TIMELINE)
    if tail is not None:
        tracker = rt.cards.tracker(client.settings.url, run_id)
        with tracker.lock:
            if tracker.final is None:
                tracker.refresh_events(client)
            entries = list(tracker.fold.timeline)[-tail:]
            cursor = tracker.fold.cursor
        entries = rundata.retitle(entries, _run_name(rt, run_id))
        return {"run_id": run_id, "events": entries, "next_cursor": cursor, "has_more": False}
    start = _int_param(params, "cursor", 0, 0, 2**53) or 0
    limit = _int_param(params, "limit", EVENTS_DEFAULT, 1, EVENTS_MAX) or EVENTS_DEFAULT
    try:
        # roko takes at most 16 types per request and the timeline shows more: filter here.
        page = client.get(f"/api/runs/{quote(run_id, safe='')}/events", {"cursor": start, "limit": limit})
    except RokoError as exc:
        if exc.code is Code.NOT_FOUND:  # queued, or not started yet
            return {"run_id": run_id, "events": [], "next_cursor": start, "has_more": False}
        raise
    if not isinstance(page, dict):
        raise RokoError(Code.PROTOCOL, "GET /api/runs/{id}/events did not answer with an object")
    events = []
    for row in page.get("events") or []:
        if isinstance(row, dict) and isinstance(row.get("event"), dict):
            at = row.get("cursor")
            entry = rundata.timeline_entry(
                at if isinstance(at, int) else 0, rundata.row_kind(row), row["event"]
            )
            if entry is not None:
                events.append(entry)
    next_cursor = page.get("next_cursor")
    return {
        "run_id": run_id,
        "events": rundata.retitle(events, _run_name(rt, run_id)),
        "next_cursor": next_cursor if isinstance(next_cursor, int) else start,
        "has_more": bool(page.get("has_more")),
    }


def _run_name(rt: Runtime, run_id: str) -> str | None:
    logged = rt.runs.get(run_id) or {}
    return clean(logged.get("label") or logged.get("request"), 160, one_line=True) or None


def cancel_run(rt: Runtime, run_id: str, payload: dict[str, Any] | RokoError | None = None) -> dict[str, Any]:
    """`POST /runs/{id}/cancel`, body `{"reason"}` (optional): a run nothing runs any more answers
    `interrupted` rather than an error; the person's reason goes on the run's card (P-1)."""
    if isinstance(payload, RokoError):
        raise payload
    _require_actions(rt)
    reason = (payload or {}).get("reason")
    if reason is not None and not isinstance(reason, str):
        raise RokoError(Code.INVALID, "reason must be text")
    return views.cancel(rt, run_id, reason=reason, by="page")


def plan_rows(rt: Runtime) -> dict[str, Any]:
    settings = rt.settings()
    rows = tools.plan_list(rt.client(settings))
    for row in rows:  # for the list's FROM DOCS group (0.6.0)
        row["imported_from"] = plansheet.listed_import(settings.workdir, row.get("group"), row.get("id"))
    return {"plans": rows, "total": len(rows)}


MAX_PROMPT_CHARS = 8_000
DOMAINS = ("code", "research", "docs")


def start_run(rt: Runtime, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    """`POST /runs`: the person asks roko for work from the UI.

    `{"prompt", "max_usd", "domain"?, "title"?}` starts one gated task; with `"plan": true`, roko's
    planner writes a plan for the request instead, and nothing runs until the person starts the plan.
    A refusal the person can fix answers with its setup `problem`.
    """
    return _naming_problems(rt, lambda: _start_run(rt, payload))


def _start_run(rt: Runtime, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    if isinstance(payload, RokoError):
        raise payload
    _require_actions(rt)
    prompt = payload.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise RokoError(Code.INVALID, "say what roko should do")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise RokoError(Code.INVALID, f"the request is longer than {MAX_PROMPT_CHARS:,} characters")
    prompt = prompt.strip()
    title = payload.get("title")
    if title is not None and not isinstance(title, str):
        raise RokoError(Code.INVALID, "title must be text")
    title = clean(title, tools.TITLE_CHARS, one_line=True) or None
    name = title or rundata.short_title(prompt) or prompt
    if payload.get("plan") is True:
        client = rt.client()
        asked = tools.titled(rt, client, "plan_generate", {"prompt": prompt}, name)
        body = tools.start_paid(rt, client, "plan_generate", asked)
        run_id = _started(body, "plan_generate")
        plan_id = clean(body.get("plan_id"), 120, one_line=True) or None
        state = clean(body.get("state"), 40, one_line=True) or None
        rt.runs.add(run_id, "plan_generate", name, plan_id=plan_id, state=state, source="ui", request=prompt)
        rt.live.track(run_id, kind="plan_generate", label=name, state=state, source="ui")
        return {"run_id": run_id, "kind": "plan_generate", "plan_id": plan_id, "state": body.get("state")}
    domain = payload.get("domain")
    if domain is not None and domain not in DOMAINS:
        raise RokoError(Code.INVALID, f"domain must be one of {', '.join(DOMAINS)}")
    settings = rt.settings()
    max_usd = tools.validate_cap(payload, settings)
    client = rt.client(settings)
    tools.check_day(rt, client, settings, max_usd)
    arguments: dict[str, Any] = {"prompt": prompt, "max_usd": max_usd}
    if domain and domain != "code":
        arguments["domain"] = domain
    body = tools.start_paid(rt, client, "run_prompt", tools.titled(rt, client, "run_prompt", arguments, name))
    run_id = _started(body, "run_prompt")
    state = clean(body.get("state"), 40, one_line=True) or None
    rt.runs.add(run_id, "run", name, state=state, max_usd=max_usd, source="ui", request=prompt)
    if domain and domain != "code":  # GET /estimate compares a request with runs of its domain
        rt.runs.update(run_id, domain=domain)
    rt.live.track(run_id, kind="run", label=name, state=state, max_usd=max_usd, source="ui")
    position = body.get("position")
    return {
        "run_id": run_id,
        "kind": "run",
        "state": state,
        "max_usd": max_usd,
        "queue_position": position if isinstance(position, int) else None,
    }


def merge_run(rt: Runtime, run_id: str, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    """`POST /runs/{id}/merge`: the person takes the run's reviewed work into their checkout."""
    if isinstance(payload, RokoError):
        raise payload
    _require_actions(rt)
    merged = review.merge_run(rt, run_id, payload)
    rt.live.poke(merged.get("run_id"))
    return {"merge": merged}


def _started(body: dict[str, Any], what: str) -> str:
    run_id = body.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise RokoError(Code.PROTOCOL, f"{what} answered without a run_id")
    return run_id


def estimate_request(rt: Runtime, params: dict[str, Any]) -> dict[str, Any]:
    """`GET /estimate?chars=&domain=&max_usd=`: where a request would start on the model ladder and about
    what it would cost, before it starts (docs/ui-api.md, 0.6.0). `chars` is the request's length; the
    parameters are checked as `POST /runs` checks them; nothing is spent."""
    chars = params.get("chars")
    if chars not in (None, ""):
        # The request's length, never the request: a request in a URL ends up in logs and history
        # (plugin-review's question 5).
        if not str(chars).isdecimal() or len(str(chars)) > 6:  # isdigit() takes "²", which int() refuses
            raise RokoError(Code.INVALID, f"chars must be a whole number from 0 to {MAX_PROMPT_CHARS:,}")
        if int(chars) > MAX_PROMPT_CHARS:
            raise RokoError(Code.INVALID, f"the request is longer than {MAX_PROMPT_CHARS:,} characters")
    else:
        # An older caller's `prompt`, this release only: read for its length, never for its words.
        prompt = params.get("prompt")
        if isinstance(prompt, str) and len(prompt) > MAX_PROMPT_CHARS:
            raise RokoError(Code.INVALID, f"the request is longer than {MAX_PROMPT_CHARS:,} characters")
    domain = params.get("domain") or "code"
    if domain not in DOMAINS:
        raise RokoError(Code.INVALID, f"domain must be one of {', '.join(DOMAINS)}")
    settings = rt.settings()
    cap = params.get("max_usd")
    max_usd = settings.max_run_usd if cap in (None, "") else tools.validate_cap({"max_usd": cap}, settings)
    reachable = bool(views.connection(rt)["reachable"])
    return {"estimate": estimate.estimate(rt, domain, max_usd, reachable=reachable)}


def start_plan(rt: Runtime, plan_id: str, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    """`POST /plans/{id}/run`: the person starts a plan from the UI, under the same caps as the tools.

    A refusal the person can fix answers with its setup `problem`.
    """
    return _naming_problems(rt, lambda: _start_plan(rt, plan_id, payload))


def _naming_problems(rt: Runtime, start: Callable[[], dict[str, Any]]) -> dict[str, Any]:
    """`start()`, with a refusal the person can fix named as its setup problem (and on the setup card)."""
    try:
        return start()
    except RokoError as exc:
        found = readiness.problem_for_error(rt, exc)
        if found is not None:
            exc.problem = found
            readiness.remember(rt, found)
        raise


def _start_plan(rt: Runtime, plan_id: str, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    if isinstance(payload, RokoError):
        raise payload
    _require_actions(rt)
    settings = rt.settings()
    max_usd = tools.validate_cap(payload, settings)
    resume = payload.get("resume") is True
    title = payload.get("title")
    title = clean(title, tools.TITLE_CHARS, one_line=True) or None if isinstance(title, str) else None
    client = rt.client(settings)
    tools.check_day(rt, client, settings, max_usd)
    body = tools.start_plan_run(
        rt, client, plan_id, {"plan_id": plan_id, "resume": resume, "max_usd": max_usd}
    )
    run_id = _started(body, "plan_run")
    state = clean(body.get("state"), 40, one_line=True) or None
    name = title or views.generation_label(rt, plan_id) or tools.plan_title(client, plan_id) or plan_id
    rt.runs.add(run_id, "plan", name, plan_id=plan_id, state=state, max_usd=max_usd, source="ui")
    if resume:  # the run it continues, so the lists can join them (dogfood U10)
        rt.runs.update(run_id, resumes=views.resumed_run(rt, plan_id, run_id))
    rt.live.track(run_id, kind="plan", label=name, state=state, plan_id=plan_id, max_usd=max_usd, source="ui")
    position = body.get("position")
    return {
        "run_id": run_id,
        "state": state,
        "queue_position": position if isinstance(position, int) else None,
    }


def decide(rt: Runtime, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    """`POST /decide`: the person's own answer to an item, looked up again first."""
    if isinstance(payload, RokoError):
        raise payload
    _require_actions(rt)
    approve = payload.get("approve")
    if not isinstance(approve, bool):
        raise RokoError(Code.INVALID, "approve must be true or false")
    note = payload.get("note")
    if note is not None and not isinstance(note, str):
        raise RokoError(Code.INVALID, "note must be text")
    note = clean(note, 2_000) or None
    client = rt.client()
    decision_id = payload.get("decision_id")
    code = payload.get("code")
    if isinstance(decision_id, str) and decision_id.strip():
        item = find_pending(client, parse_decision_id(decision_id))
    elif isinstance(code, str) and code.strip():
        wanted = code.strip().lower()
        item = next((i for i in views.collect_pending(rt, client) if i.get("code") == wanted), None)
    else:
        raise RokoError(Code.INVALID, "name the item to answer by its code or decision_id")
    if item is None:
        raise RokoError(
            Code.NOT_FOUND,
            "nothing waits on you under that name: it may have been answered already",
            hint="refresh the list of what waits on you",
        )
    result = answer(client, parse_decision_id(str(item["decision_id"])), approve, note)
    rt.live.poke(item.get("run_id"))
    return {
        "decision_id": item["decision_id"],
        "code": item.get("code"),
        "approved": approve,
        "outcome": tools.decision_outcome(result, approve),
        "title": item.get("title"),
    }


def knowledge(rt: Runtime, params: dict[str, str]) -> dict[str, Any]:
    query = clean(params.get("q"), 200, one_line=True) or None
    limit = _int_param(params, "limit", KNOWLEDGE_DEFAULT, 1, KNOWLEDGE_MAX) or KNOWLEDGE_DEFAULT
    return {
        "query": query,
        "entries": insights.knowledge(rt.client(), query, limit),
        "provenance": "recorded by roko's runs in its workspace",
    }


def health(rt: Runtime) -> dict[str, Any]:
    # roko's side comes from the setup card's last look, so a page polling this asks roko nothing new.
    report = run_doctor(rt, cached=True)
    return {
        "checks": [check.as_dict() for check in report.checks],
        "status": "fail" if report.failed else "warn" if report.warned else "ok",
        "install": readiness.install_status(),
        "setup": readiness.setup_view(rt),
    }


def setup_fix_preview(rt: Runtime, params: dict[str, str]) -> dict[str, Any]:
    """`GET /setup/fix?action=&variant=`: what a fix would change, for the person to read first."""
    action = params.get("action") or ""
    if action == runwork.COMMIT_ACTION:
        # Merge's fix for an uncommitted roko.toml (the card's `merge.fix`).
        return review.commit_preview(rt)
    return readiness.fix_preview(rt, action, params.get("variant") or None)


def setup_fix(rt: Runtime, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    """`POST /setup/fix {"action", "variant"?, "digest"?}`: the person applies a fix they read."""
    if isinstance(payload, RokoError):
        raise payload
    _require_actions(rt)
    action = payload.get("action")
    variant = payload.get("variant")
    digest = payload.get("digest")
    if not isinstance(action, str) or not action:
        raise RokoError(Code.INVALID, "name the fix to apply (action)")
    if variant is not None and not isinstance(variant, str):
        raise RokoError(Code.INVALID, "variant must be text")
    if digest is not None and not isinstance(digest, str):
        raise RokoError(Code.INVALID, "digest must be text")
    if action == runwork.COMMIT_ACTION:
        return review.commit_settings(rt, digest or None)
    return readiness.apply_fix(rt, action, variant or None, digest or None)


def insight_view(rt: Runtime, params: dict[str, str] | None = None) -> dict[str, Any]:
    """`GET /insights?scope=hermes|workspace`: the runs Hermes started (the default), or every run in roko's
    workspace, each labelled with its scope and period."""
    scope = (params or {}).get("scope") or "hermes"
    if scope not in insights.SCOPES:
        raise RokoError(Code.INVALID, f"scope must be one of {', '.join(insights.SCOPES)}")
    if scope == "hermes":
        return insights.hermes_view(rt.runs.recent(200))
    client = rt.client()
    gates, gates_problem = insights.safe(insights.gates, client)
    models, models_problem = insights.safe(insights.models, client)
    spend, spend_problem = insights.safe(insights.efficiency, client)
    problems = [problem for problem in (gates_problem, models_problem, spend_problem) if problem]
    if len(problems) == 3:  # nothing answered: say why, rather than show three empty panels
        raise RokoError(Code.UNREACHABLE, problems[0])
    return insights.workspace_view(gates or [], models or [], spend or {}, problems)


def _require_actions(rt: Runtime) -> None:
    if not rt.settings().ui_actions:
        raise RokoError(
            Code.FORBIDDEN,
            "actions from the Hermes UI are turned off for roko",
            hint="set plugins.entries.roko.settings.ui_actions: true to allow them",
        )


def _id(value: str, label: str) -> str:
    text = clean(value, MAX_ID_CHARS + 1, one_line=True)
    if not text or text != value or len(text) > MAX_ID_CHARS:
        raise RokoError(Code.INVALID, f"that is not a valid {label}")
    return text


def _int_param(params: dict[str, str], key: str, default: int | None, low: int, high: int) -> int | None:
    raw = params.get(key)
    if raw is None or raw == "":
        return default
    try:
        number = int(raw)
    except ValueError as exc:
        raise RokoError(Code.INVALID, f"{key} must be a whole number") from exc
    return max(low, min(high, number))


def _finite(value: Any) -> Any:
    """The answer with NaN and infinities replaced by null: JSON has neither."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(item) for item in value]
    return value

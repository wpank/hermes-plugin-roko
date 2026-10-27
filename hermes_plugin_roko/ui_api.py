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
- 0.7.0: each project has its own roko serve. A route about one project takes
  `project` (a query parameter, or a body field) and answers about the default
  project without it; a route about one run finds the run's project itself.
"""

# No `from __future__ import annotations` here: FastAPI reads the route
# functions' annotations at runtime, and `Request` is only imported inside
# `build_router`, so string annotations could not be resolved.
import asyncio
import json
import logging
import math
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any
from urllib.parse import quote

from . import (
    _hermes,
    artifacts,
    buildview,
    estimate,
    fixes,
    insights,
    live_relay,
    plansheet,
    readiness,
    review,
    rundata,
    runwork,
    specfile,
    tools,
    views,
)
from . import serve as serving
from .decisions import answer, find_pending, parse_decision_id
from .diagnostics import run_doctor
from .errors import Code, RokoError
from .resume import check as resume_check
from .runtime import Runtime
from .sanitize import clean, home_relative
from .settings import same_path

logger = logging.getLogger(__name__)

MAX_BODY_BYTES = 16_384
EVENTS_DEFAULT = 100
EVENTS_MAX = 200
# How long one `?tail=` or `?before=` request reads on through a run's index the backend has not read yet,
# and how many pages a step between looks at the clock (round v7). The client keeps to 25 requests a second
# (roko allows a caller 30) of 200 rows: the real P0 run's 34,633 rows took 6 s, a whole phase's run past
# 100,000 rows takes 20 s or more, so such a run answers `reading` (no lines yet) once or twice first.
READ_S = 10.0
READ_PAGES = 50
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
    async def get_overview(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: views.ui_overview(scoped(rt, params.get("project"))))

    @router.get("/projects")
    async def get_projects() -> JSONResponse:
        return await reply(projects_view)

    @router.post("/projects")
    async def post_projects(request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: change_projects(rt, payload))

    @router.post("/serve")
    async def post_serve(request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: serve_action(rt, payload))

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

    @router.get("/runs/{run_id}/artifacts")
    async def get_run_artifacts(run_id: str) -> JSONResponse:
        return await reply(lambda rt: artifacts.run_made(rt, _id(run_id, "run id")))

    @router.get("/runs/{run_id}/artifact")
    async def get_run_artifact(run_id: str, request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: artifacts.run_made_file(rt, _id(run_id, "run id"), params))

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
    async def get_plans(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: plan_rows(scoped(rt, params.get("project"))))

    @router.get("/plans/{plan_id}")
    async def get_plan(plan_id: str, request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(
            lambda rt: {
                "plan": plansheet.plan_sheet(scoped(rt, params.get("project")), _id(plan_id, "plan id"))
            }
        )

    @router.post("/plans/{plan_id}/run")
    async def post_plan_run(plan_id: str, request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: start_plan(rt, _id(plan_id, "plan id"), payload))

    @router.get("/learning")
    async def get_learning(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: views.learning_view(scoped(rt, params.get("project")), params))

    @router.get("/estimate")
    async def get_estimate(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: estimate_request(scoped(rt, params.get("project")), params))

    @router.get("/pending")
    async def get_pending(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: pending(scoped(rt, params.get("project"))))

    @router.post("/decide")
    async def post_decide(request: Request) -> JSONResponse:
        payload = await read_json(request)
        return await reply(lambda rt: decide(rt, payload))

    @router.get("/knowledge")
    async def get_knowledge(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: knowledge(scoped(rt, params.get("project")), params))

    @router.get("/health")
    async def get_health(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: health(scoped(rt, params.get("project"))))

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
        return await reply(lambda rt: insight_view(scoped(rt, params.get("project")), params))

    @router.get("/effects")
    async def get_effects(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: insights.effects(scoped(rt, params.get("project")).client()))

    @router.get("/loops")
    async def get_loops(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: views.loops_view(scoped(rt, params.get("project"))))

    @router.get("/build")
    async def get_build(request: Request) -> JSONResponse:
        params = dict(request.query_params)
        return await reply(lambda rt: buildview.build_view(scoped(rt, params.get("project"))))

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
    project = _socket_project(rt, websocket.query_params.get("project"))
    sub = rt.live.subscribe(asyncio.get_running_loop(), runs, project)
    closed = asyncio.create_task(_until_closed(websocket))
    closed.add_done_callback(_quiet)
    try:
        hello = await asyncio.to_thread(rt.live.hello, project)
        await websocket.send_text(json.dumps(for_page(hello), ensure_ascii=False))
        while not closed.done():
            getter = asyncio.create_task(sub.get(live_relay.PING_S))
            done, _ = await asyncio.wait({getter, closed}, return_when=asyncio.FIRST_COMPLETED)
            if getter not in done:
                getter.cancel()
                break
            frame = getter.result() or {"type": "ping", "server_time": rundata.now_iso()}
            await websocket.send_text(json.dumps(for_page(frame), ensure_ascii=False))
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


def _socket_project(rt: Runtime, value: Any) -> Path | None:
    """The project a socket's page shows (`?project=`), when it is one Hermes knows; else the default."""
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return rt.projects.find(value)
    except Exception:
        return None


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
        if exc.serve:
            # 0.7.0: the project's roko serve as it stands (a busy restart, a serve that could not start).
            body["serve"] = exc.serve
        if isinstance(exc, tools.PlanInvalid) and exc.validation is not None:
            # What roko's validator found in the plan, as the plan card shows it (PlanValidation).
            body["validation"] = exc.validation
        if exc.resumable:
            # The run the plan's last run left part way (P-14): the page offers continue or start over.
            body["resumable_run"] = exc.resumable
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
    shown = for_page(body)
    assert isinstance(shown, dict)
    return shown


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
    rt = rt.for_run(run_id)
    client = rt.client()
    tail = _int_param(params, "tail", None, 1, rundata.MAX_TIMELINE)
    if tail is not None:
        tracker = rt.cards.tracker(client.settings.url, run_id)
        with tracker.lock:
            read = _read_on(tracker, client)
            entries = list(tracker.fold.timeline)[-tail:] if read else []
            lines = len(tracker.fold.line_cursors)
            cursor = tracker.fold.cursor
            rows = tracker.fold.rows
        if not read:
            # Not the newest lines yet: a long run's first lines are no answer to "its last N". The page asks
            # again.
            return _still_reading(run_id, cursor, rows, earlier=False)
        return {
            "run_id": run_id,
            "events": rundata.retitle(entries, _run_name(rt, run_id)),
            "next_cursor": cursor,
            "has_more": False,
            "earlier": lines > len(entries),
            "reading": False,
        }
    before = _int_param(params, "before", None, 1, 2**53)
    if before is not None:
        limit = _int_param(params, "limit", EVENTS_MAX, 1, EVENTS_MAX) or EVENTS_MAX
        return _timeline_before(rt, client, run_id, before, limit)
    start = _int_param(params, "cursor", 0, 0, 2**53) or 0
    limit = _int_param(params, "limit", EVENTS_DEFAULT, 1, EVENTS_MAX) or EVENTS_DEFAULT
    try:
        # roko takes at most 16 types per request and the timeline shows more: filter here.
        page = _index_page(client, run_id, start, limit)
    except RokoError as exc:
        if exc.code is Code.NOT_FOUND:  # queued, or not started yet
            return {"run_id": run_id, "events": [], "next_cursor": start, "has_more": False}
        raise
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


def _read_on(tracker: Any, client: Any, until: int | None = None) -> bool:
    """With the tracker's lock held: read the run's index on until it is read to its end (or past roko's
    cursor `until`), for at most READ_S; whether it got there."""
    deadline = time.monotonic() + READ_S
    while tracker.final is None and (until is None or tracker.fold.cursor < until):
        if tracker.refresh_events(client, min(READ_PAGES, rundata.MAX_PAGES)):
            return True
        if time.monotonic() >= deadline:
            return False
    return True


def _timeline_before(rt: Runtime, client: Any, run_id: str, before: int, limit: int) -> dict[str, Any]:
    """`?before=C&limit=N` (round v7): the N timeline lines just before roko's cursor C, oldest first, and
    whether there are lines before those (`earlier`). The backend keeps a run's newest lines (MAX_TIMELINE
    whole, MAX_HISTORY more as JSON) and where every line starts: older ones are read from roko from the line
    before them, never from the index's start."""
    tracker = rt.cards.tracker(client.settings.url, run_id)
    with tracker.lock:
        if not _read_on(tracker, client, until=before):
            return _still_reading(run_id, before, tracker.fold.rows, earlier=True)
        lines, start, older = tracker.fold.lines_before(before, limit)
        wanted = set(tracker.fold.line_cursors[start : start + older])
        seek = tracker.fold.line_cursors[start - 1] if start else 0
    if older:
        lines = _lines_between(client, run_id, seek, wanted) + lines
    entries = rundata.retitle(lines, _run_name(rt, run_id))
    return {
        "run_id": run_id,
        "events": entries,
        "next_cursor": before,
        "has_more": False,
        "earlier": start > 0,
        "reading": False,
    }


def _still_reading(run_id: str, cursor: int, rows: int, *, earlier: bool) -> dict[str, Any]:
    """An answer while the backend has not read the run's index far enough yet: no lines, and how far it
    got."""
    return {
        "run_id": run_id,
        "events": [],
        "next_cursor": cursor,
        "has_more": False,
        "earlier": earlier,
        "reading": True,
        "rows_read": rows,
    }


def _lines_between(client: Any, run_id: str, cursor: int, wanted: set[int]) -> list[dict[str, Any]]:
    """The timeline lines at the roko cursors `wanted`, read from roko's index from `cursor` on."""
    found: list[dict[str, Any]] = []
    last = max(wanted)
    for _ in range(4 * rundata.MAX_PAGES):
        page = _index_page(client, run_id, cursor, EVENTS_MAX)
        for row in page.get("events") or []:
            at = row.get("cursor") if isinstance(row, dict) else None
            if at in wanted and isinstance(row.get("event"), dict):
                entry = rundata.timeline_entry(at, rundata.row_kind(row), row["event"])
                if entry is not None:
                    found.append(entry)
        next_cursor = page.get("next_cursor")
        if not page.get("has_more") or not isinstance(next_cursor, int) or not cursor < next_cursor < last:
            break
        cursor = next_cursor
    return found


def _index_page(client: Any, run_id: str, cursor: int, limit: int) -> dict[str, Any]:
    """A page of the run's event index from `cursor`, without the rows no timeline line comes from (roko
    gap-cb9044); a roko that refuses the names is asked again for every row."""
    path = f"/api/runs/{quote(run_id, safe='')}/events"
    try:
        page = client.get(path, {"cursor": cursor, "limit": limit, "skip": rundata.SKIP_TIMELINE})
    except RokoError as exc:
        if exc.code is not Code.INVALID:
            raise
        page = client.get(path, {"cursor": cursor, "limit": limit})
    if not isinstance(page, dict):
        raise RokoError(Code.PROTOCOL, "GET /api/runs/{id}/events did not answer with an object")
    return page


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
    planner writes a plan for the request instead, and nothing runs until the person starts the plan. A plan
    may come from a spec file in the project, `"spec_path"`, which roko reads exactly; the prompt then only
    adds to it (P-6). A refusal the person can fix answers with its setup `problem`.
    """
    return _naming_problems(rt, lambda: _start_run(rt, payload))


def _start_run(rt: Runtime, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    if isinstance(payload, RokoError):
        raise payload
    _require_actions(rt)
    rt = running_in(rt, payload.get("project"))
    writes_plan = payload.get("plan") is True
    if payload.get("spec_path") is not None and not writes_plan:
        raise RokoError(Code.INVALID, "spec_path is for writing a plan: send it with plan: true")
    spec_path = specfile.checked(rt.settings().workdir, payload.get("spec_path")) if writes_plan else None
    given = payload.get("prompt")
    prompt = given if isinstance(given, str) else ""
    if not prompt.strip() and spec_path is None:
        raise RokoError(Code.INVALID, "say what roko should do")
    if len(prompt) > MAX_PROMPT_CHARS:
        raise RokoError(Code.INVALID, f"the request is longer than {MAX_PROMPT_CHARS:,} characters")
    prompt = prompt.strip()
    title = payload.get("title")
    if title is not None and not isinstance(title, str):
        raise RokoError(Code.INVALID, "title must be text")
    title = clean(title, tools.TITLE_CHARS, one_line=True) or None
    if writes_plan:
        client = rt.client()
        name = tools.plan_name(client.settings, prompt or None, spec_path, title)
        cap = tools.plan_cap(rt, client, payload, client.settings)  # P-7: optional, as the tool takes it
        request = tools.plan_request(rt, client, prompt or None, spec_path)
        asked = tools.titled(rt, client, "plan_generate", request, name)
        if cap is not None:
            asked["max_usd"] = cap
        body = tools.start_paid(rt, client, "plan_generate", asked)
        run_id = _started(body, "plan_generate")
        plan_id = clean(body.get("plan_id"), 120, one_line=True) or None
        state = clean(body.get("state"), 40, one_line=True) or None
        place = tools.run_place(rt, client.settings)
        rt.runs.add(
            run_id,
            "plan_generate",
            name,
            plan_id=plan_id,
            state=state,
            source="ui",
            request=prompt or None,
            **place,
        )
        if spec_path:
            rt.runs.update(run_id, spec_path=spec_path)
        capped = tools.cap_said(body, cap)
        rt.runs.update(run_id, max_usd=capped["max_usd"])
        rt.live.track(
            run_id, kind="plan_generate", label=name, state=state, source="ui", project=place["project"]
        )
        return {
            "run_id": run_id,
            "kind": "plan_generate",
            "plan_id": plan_id,
            "state": body.get("state"),
            "project": views.project_ref(rt, place),
            **capped,
        }
    name = title or rundata.short_title(prompt) or prompt
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
    place = tools.run_place(rt, settings)
    rt.runs.add(run_id, "run", name, state=state, max_usd=max_usd, source="ui", request=prompt, **place)
    if domain and domain != "code":  # GET /estimate compares a request with runs of its domain
        rt.runs.update(run_id, domain=domain)
    rt.live.track(
        run_id, kind="run", label=name, state=state, max_usd=max_usd, source="ui", project=place["project"]
    )
    position = body.get("position")
    return {
        "run_id": run_id,
        "kind": "run",
        "state": state,
        "max_usd": max_usd,
        "queue_position": position if isinstance(position, int) else None,
        "project": views.project_ref(rt, place),
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
    rt = running_in(rt, payload.get("project"))
    settings = rt.settings()
    max_usd = tools.validate_cap(payload, settings)
    resume = payload.get("resume") is True
    fresh = payload.get("fresh") is True
    from_run = payload.get("from_run") if isinstance(payload.get("from_run"), str) else None
    title = payload.get("title")
    title = clean(title, tools.TITLE_CHARS, one_line=True) or None if isinstance(title, str) else None
    client = rt.client(settings)
    # A run that stopped part way: the page asks continue or start over (P-14), before anything starts. Its
    # start over is the person's own choice, made beside what it sets aside (P-57).
    resume_check(rt, client, plan_id, resume=resume, fresh=fresh, from_run=from_run, set_aside=fresh)
    tools.check_day(rt, client, settings, max_usd)
    body = tools.start_plan_run(
        rt, client, plan_id, tools.plan_run_arguments(plan_id, max_usd, resume, fresh, from_run)
    )
    run_id = _started(body, "plan_run")
    state = clean(body.get("state"), 40, one_line=True) or None
    name = title or views.generation_label(rt, plan_id) or tools.plan_title(client, plan_id) or plan_id
    place = tools.run_place(rt, settings)
    rt.runs.add(run_id, "plan", name, plan_id=plan_id, state=state, max_usd=max_usd, source="ui", **place)
    tools.remember_start(rt, run_id, plan_id, body, resume or bool(from_run))
    rt.live.track(
        run_id,
        kind="plan",
        label=name,
        state=state,
        plan_id=plan_id,
        max_usd=max_usd,
        source="ui",
        project=place["project"],
    )
    position = body.get("position")
    return {
        "run_id": run_id,
        "state": state,
        "queue_position": position if isinstance(position, int) else None,
        "project": views.project_ref(rt, place),
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
        named = parse_decision_id(decision_id)
        item = find_pending(views.decision_client(rt, client, named), named)
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
    decision = parse_decision_id(str(item["decision_id"]))
    result = answer(views.decision_client(rt, client, decision), decision, approve, note)
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
    """`GET /setup/fix?action=&variant=&project=`: what a fix would change, for the person to read first."""
    action = params.get("action") or ""
    rt = scoped(rt, params.get("project"))
    if action == runwork.COMMIT_ACTION:
        # Merge's fix for an uncommitted roko.toml (the card's `merge.fix`).
        return review.commit_preview(rt)
    if action in fixes.ACTIONS:  # 0.7.0: set a project up, start or restart its roko serve
        return fixes.preview(rt, action)
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
    rt = scoped(rt, payload.get("project"))
    if action == runwork.COMMIT_ACTION:
        return review.commit_settings(rt, digest or None)
    if action in fixes.ACTIONS:
        return fixes.apply(rt, action, digest or None, force=payload.get("force") is True)
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


def pending(rt: Runtime) -> dict[str, Any]:
    """`GET /pending`: what waits on the person, in the project's serve and in the runs Hermes started."""
    return {"items": views.collect_pending(rt, rt.client())}


# -- projects and their roko serves (0.7.0) ---------------------------------------------------------


def scoped(rt: Runtime, value: Any) -> Runtime:
    """The runtime of the project a request names (`project`: a path, or a known project's name); without
    one, the default project's. A project Hermes does not know is refused."""
    if value is None or value == "":
        return rt
    if not isinstance(value, str):
        raise RokoError(Code.INVALID, "project must be a folder path")
    settings = rt.settings()
    if settings.remote:
        if settings.workdir is not None and same_path(Path(value).expanduser(), settings.workdir):
            return rt
        raise RokoError(
            Code.INVALID,
            f"the plugin uses one roko serve, at {settings.display_url}, and no other project",
            hint="leave project out",
        )
    found = rt.projects.find(value)
    if found is None:
        raise RokoError(
            Code.INVALID,
            f"{clean(value, 300, one_line=True)} is not a project Hermes knows",
            hint="add it first (Choose folder… on the roko page)",
        )
    return rt.scoped(found)


def running_in(rt: Runtime, value: Any) -> Runtime:
    """`scoped`, with the project's roko serve started first when it is stopped (the person clicked Run), as
    `POST /serve {"action": "start"}` would, waiting for it. Raises the setup problem that stops it."""
    view = scoped(rt, value)
    settings = view.settings()
    if settings.remote or settings.workdir is None:
        return view
    state = serving.serve_state(rt, settings.workdir)
    if state is not None and state.state != "running":
        if state.state != "starting" and (state.error or {}).get("code") != "not_initialized":
            state = serving.ensure_serve(rt, settings.workdir, wait=True, reason="manual")
        if state is not None and state.state != "running":
            raise tools._not_running(view, state)
    return view


def projects_view(rt: Runtime) -> dict[str, Any]:
    """`GET /projects`: every known project, the default first (files only: never waits on the network)."""
    default = rt.settings().workdir if rt.settings().remote else rt.projects.default()
    return {"default": str(default) if default is not None else None, "projects": views.project_rows(rt)}


def change_projects(rt: Runtime, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    """`POST /projects {"action": "add" | "remove" | "set_default", "path"}`."""
    if isinstance(payload, RokoError):
        raise payload
    _require_actions(rt)
    action = payload.get("action")
    path = payload.get("path")
    if action not in ("add", "remove", "set_default"):
        raise RokoError(Code.INVALID, "action must be add, remove or set_default")
    if not isinstance(path, str) or not path.strip():
        raise RokoError(Code.INVALID, "name the project's folder (path)")
    if rt.settings().remote:
        raise RokoError(
            Code.FORBIDDEN,
            "the plugin uses one roko serve elsewhere, so it keeps no projects",
            hint="remove the plugin's url setting (or ROKO_URL) to use roko on this machine",
        )
    added = None
    if action == "add":
        added = rt.projects.add(path)
    elif action == "remove":
        rt.projects.remove(path)
    else:
        rt.projects.set_default(path)
    out = projects_view(rt)
    if added is not None:
        out["project"] = views.project_row(rt, added)
    return out


SERVE_ACTIONS = ("ensure", "start", "restart", "stop")


def serve_action(rt: Runtime, payload: dict[str, Any] | RokoError) -> dict[str, Any]:
    """`POST /serve {"action": "ensure" | "start" | "restart" | "stop", "project"?, "force"?}`."""
    if isinstance(payload, RokoError):
        raise payload
    action = payload.get("action")
    if action not in SERVE_ACTIONS:
        raise RokoError(Code.INVALID, f"action must be one of {', '.join(SERVE_ACTIONS)}")
    view = scoped(rt, payload.get("project"))
    settings = view.settings()
    if settings.remote:
        raise RokoError(
            Code.FORBIDDEN,
            f"{settings.where} is not on this machine, so the plugin starts and stops nothing there",
            hint="manage that roko serve where it runs",
        )
    if action != "ensure":
        _require_actions(rt)
    if settings.workdir is None:
        raise RokoError(Code.INVALID, "no project is chosen", hint="pick a project on the roko page")
    force = payload.get("force") is True
    if action == "ensure":
        state = serving.ensure_serve(rt, settings.workdir, wait=False, reason="app_open")
    elif action == "start":
        state = serving.ensure_serve(rt, settings.workdir, wait=False, reason="manual")
    elif action == "restart":
        state = serving.restart_serve(rt, settings.workdir, force=force)
    else:
        state = serving.stop_serve(rt, settings.workdir, force=force)
    return {"serve": state.as_dict() if state is not None else None}


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


def for_page(value: Any) -> Any:
    """An answer or a frame as the pages may show it: NaN and infinities as null (JSON has neither), and the
    person's home as `~` in every string (`sanitize.home_relative`), so no page shows an account name."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, str):
        return home_relative(value)
    if isinstance(value, dict):
        return {key: for_page(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [for_page(item) for item in value]
    return value

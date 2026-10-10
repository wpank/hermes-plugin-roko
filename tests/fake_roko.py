"""A stand-in for `roko serve`: the REST routes and `POST /mcp` tools the plugin uses.

Pure standard library, so the same server runs under the plugin's test venv
and under Hermes' own interpreter (tests/compat). Its answers copy roko
serve's shapes and refusals (crates/roko-serve/src/routes/mcp.rs and friends,
as of 2026-10-09): the JSON-RPC envelope, `isError` tool failures, the
spending-cap guards, the data-model-boundary refusal, and auth by
`X-Api-Key` or `Authorization: Bearer`.
"""

from __future__ import annotations

import json
import secrets
import threading
import time
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit

MCP_TOOLS = [
    "run_status",
    "recall",
    "run_prompt",
    "plan_run",
    "plan_generate",
    "run_cancel",
    "confirm_pending",
    "confirm_answer",
    "effects_pending",
    "effect_decide",
]
WRITE_TOOLS = {"run_prompt", "plan_run", "plan_generate", "run_cancel", "confirm_answer", "effect_decide"}
TERMINAL = {"succeeded", "failed", "unverified", "cancelled"}


@dataclass
class Run:
    run_id: str
    kind: str  # "run" | "plan" | "plan_generate:<slug>"
    states: list[str]  # the states run_status reports, one per call; the last one sticks
    cost_usd: float = 0.0
    plan_id: str | None = None
    max_usd: float | None = None
    origin: str = "mcp:local"
    # When set, the state follows the clock instead: (seconds after start, state) pairs.
    timeline: list[tuple[float, str]] | None = None
    started: float = field(default_factory=time.monotonic)

    def current(self) -> str:
        if self.timeline is not None:
            elapsed = time.monotonic() - self.started
            return [state for at, state in self.timeline if at <= elapsed][-1]
        return self.states[0]

    def advance(self) -> str:
        """The state to report now; the next call reports the next scripted one."""
        if self.timeline is not None:
            return self.current()
        state = self.states[0]
        if len(self.states) > 1:
            self.states.pop(0)
        return state


@dataclass
class FakeRoko:
    auth: bool = False
    boundary: bool = True
    max_run_usd: float = 5.0
    plans: dict[str, dict[str, Any]] = field(default_factory=dict)
    runs: dict[str, Run] = field(default_factory=dict)
    knowledge: list[dict[str, Any]] = field(default_factory=list)
    confirms: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    effects: list[dict[str, Any]] = field(default_factory=list)
    decided: list[dict[str, Any]] = field(default_factory=list)
    keys: dict[str, dict[str, str]] = field(default_factory=dict)  # key value -> {name, scope}
    launch_token: str = field(default_factory=lambda: secrets.token_hex(16))
    # States a new run reports, call by call (copied per run).
    run_script: list[str] = field(default_factory=lambda: ["running", "succeeded"])
    # Or, when set, the states a new run goes through over time, as roko's do.
    timeline: list[tuple[float, str]] | None = None
    # How long effect_decide takes, to test timeouts.
    decide_delay_s: float = 0.0
    requests: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def __post_init__(self) -> None:
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    # -- lifecycle -----------------------------------------------------------

    def start(self) -> FakeRoko:
        handler = _make_handler(self)
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    @property
    def url(self) -> str:
        assert self._server is not None
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def add_key(self, name: str, scope: str = "write") -> str:
        value = "roko_" + secrets.token_urlsafe(32)
        self.keys[value] = {"name": name, "scope": scope}
        return value

    def add_plan(self, plan_id: str, title: str = "", tasks: list[dict[str, Any]] | None = None) -> None:
        self.plans[plan_id] = {"title": title or plan_id, "tasks": tasks or []}

    def tool_calls(self, name: str) -> list[dict[str, Any]]:
        return [
            r["body"]["params"]["arguments"]
            for r in self.requests
            if r["path"] == "/mcp"
            and isinstance(r.get("body"), dict)
            and r["body"].get("method") == "tools/call"
            and r["body"]["params"].get("name") == name
        ]

    # -- auth ----------------------------------------------------------------

    def credential(self, headers: Any) -> tuple[str, str] | None:
        """(name, scope) of the request's credential, or None."""
        value = headers.get("X-Api-Key")
        if not value:
            bearer = headers.get("Authorization", "")
            value = bearer[7:] if bearer.startswith("Bearer ") else None
        if not value:
            return None
        if value == self.launch_token:
            return ("local", "admin")
        key = self.keys.get(value)
        return (key["name"], key["scope"]) if key else None

    # -- MCP tools -----------------------------------------------------------

    def call_tool(self, name: str, args: dict[str, Any], who: tuple[str, str] | None) -> dict[str, Any]:
        if name not in MCP_TOOLS:
            raise RpcError(-32600, f"unknown tool: {name}")
        if self.auth and name in WRITE_TOOLS and (who is None or who[1] not in ("write", "admin", "owner")):
            return tool_error(f"the {name} tool needs the write scope")
        return getattr(self, f"_tool_{name}")(args, who)

    def _cap(self, args: dict[str, Any]) -> float:
        cap = args.get("max_usd")
        if cap is None:
            raise RpcError(
                -32600,
                f"max_usd is required: name the most this run may spend, at most {self.max_run_usd:.2f} USD",
            )
        if not isinstance(cap, (int, float)) or cap <= 0:
            raise RpcError(-32600, "max_usd must be a number above 0")
        if cap > self.max_run_usd:
            raise RpcError(
                -32600,
                f"max_usd {cap:.2f} is above the {self.max_run_usd:.2f} USD a run started over /mcp may spend ([serve.mcp] max_run_usd)",
            )
        return float(cap)

    def _boundary(self) -> dict[str, Any] | None:
        if self.boundary:
            return None
        return tool_error(
            "a run from a chat host needs the data-model boundary: set [agent.data_llm] in roko.toml, "
            "or [serve.mcp] allow_without_data_llm = true to run without it"
        )

    def _new_run(
        self, kind: str, *, plan_id: str | None = None, max_usd: float | None = None, who: Any = None
    ) -> Run:
        run = Run(
            str(uuid.uuid4()),
            kind,
            list(self.run_script),
            plan_id=plan_id,
            max_usd=max_usd,
            origin=f"mcp:{who[0] if who else 'local'}",
            timeline=list(self.timeline) if self.timeline else None,
        )
        self.runs[run.run_id] = run
        return run

    def _tool_run_prompt(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        if not isinstance(args.get("prompt"), str):
            raise RpcError(-32600, "missing string argument prompt")
        cap = self._cap(args)
        refusal = self._boundary()
        if refusal:
            return refusal
        if any(r.kind == "plan" and r.current() not in TERMINAL for r in self.runs.values()):
            return tool_error("a plan run is active in this workspace; start the prompt run once it ends")
        run = self._new_run("run", max_usd=cap, who=who)
        return tool_ok(
            {
                "run_id": run.run_id,
                "state": "running",
                "links": {
                    "summary": f"/api/runs/{run.run_id}/summary",
                    "status": f"/api/run/{run.run_id}/status",
                },
            }
        )

    def _tool_plan_run(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        plan_id = args.get("plan_id")
        if not isinstance(plan_id, str):
            raise RpcError(-32600, "missing string argument plan_id")
        cap = self._cap(args)
        refusal = self._boundary()
        if refusal:
            return refusal
        if plan_id not in self.plans:
            return tool_error(f"plan '{plan_id}' not found")
        active = [r for r in self.runs.values() if r.kind == "plan" and r.current() not in TERMINAL]
        run = self._new_run("plan", plan_id=plan_id, max_usd=cap, who=who)
        if active:
            run.states = ["queued", *run.states]
            return tool_ok({"run_id": run.run_id, "state": "queued", "position": len(active), "links": {}})
        return tool_ok({"run_id": run.run_id, "state": "running", "position": None, "links": {}})

    def _tool_plan_generate(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        prompt = args.get("prompt")
        if not isinstance(prompt, str):
            raise RpcError(-32600, "missing string argument prompt")
        slug = "-".join(prompt.lower().split()[:4]) or "plan"
        while slug in self.plans:
            slug += "-2"
        run = self._new_run(f"plan_generate:{slug}", plan_id=slug, who=who)
        self.plans[slug] = {
            "title": prompt[:60],
            "tasks": [
                {
                    "id": "T1",
                    "title": "do it",
                    "depends_on": [],
                    "verify": [{"phase": "post", "command": "cargo test"}],
                }
            ],
        }
        return tool_ok(
            {
                "run_id": run.run_id,
                "plan_id": slug,
                "state": "running",
                "links": {"operation": f"/api/operations/{run.run_id}", "plan": f"/api/plans/{slug}"},
            }
        )

    def _tool_run_status(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run = self.runs.get(str(args.get("run_id")))
        if run is None:
            return tool_error(f"run '{args.get('run_id')}' not found")
        if run.timeline is not None:
            # roko's run_status: wait until the state changes, the run ends, or wait_secs pass.
            first = run.current()
            deadline = time.monotonic() + float(args.get("wait_secs") or 0)
            self.lock.release()  # let other requests in while this one waits
            try:
                while run.current() == first and first not in TERMINAL and time.monotonic() < deadline:
                    time.sleep(0.02)
            finally:
                self.lock.acquire()
        state = run.advance()
        if run.kind.startswith("plan_generate:"):
            return tool_ok(
                {
                    "run_id": run.run_id,
                    "kind": run.kind,
                    "state": state,
                    "active": state not in TERMINAL,
                    "result": {"slug": run.plan_id, "task_count": 1} if state == "succeeded" else None,
                    "error": None,
                }
            )
        done = state in TERMINAL
        return tool_ok(
            {
                "run_id": run.run_id,
                "state": state,
                "verdict": state if done else None,
                "position": None,
                "active": not done,
                "cost_usd": run.cost_usd,
                "tasks": {
                    "total": 1,
                    "passed": 1 if state == "succeeded" else 0,
                    "failed": 1 if state == "failed" else 0,
                    "unverified": 1 if state == "unverified" else 0,
                    "other": 0,
                },
                "untrusted_input_boundary": [{"plan_id": "p", "task_id": "T1", "boundary": "data_llm"}],
                "milestones": [{"kind": "started", "text": "run started", "at": 1}],
                "started_at": "1",
                "finished_at": "5" if done else None,
                "links": {"summary": "/api/runs/x/summary"},
            }
        )

    def _tool_run_cancel(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run = self.runs.get(str(args.get("run_id")))
        if run is None or run.current() in TERMINAL:
            return tool_error("no active execution for this plan")
        run.states = ["cancelled"]
        return tool_ok({"run_id": run.run_id, "state": "cancelled"})

    def _tool_recall(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        query = str(args.get("query", "")).lower()
        limit = int(args.get("limit", 5))
        hits = [k for k in self.knowledge if any(w in k["content"].lower() for w in query.split())][:limit]
        return tool_ok({"results": hits, "total": len(hits)})

    def _tool_confirm_pending(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        return tool_ok({"pending": list(self.confirms.get(str(args.get("run_id")), []))})

    def _tool_confirm_answer(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        holds = self.confirms.get(str(args.get("run_id")), [])
        for hold in holds:
            if hold["task_id"] == args.get("task_id") and hold["attempt_key"] == args.get("attempt_key"):
                holds.remove(hold)
                decision = "approved" if args.get("approve") else "rejected"
                return tool_ok(
                    {
                        "run_id": args["run_id"],
                        "task_id": args["task_id"],
                        "attempt_key": args["attempt_key"],
                        "decision": decision,
                    }
                )
        return tool_error(
            f"task {args.get('task_id')} of run {args.get('run_id')} waits for no confirmation "
            f"of attempt {args.get('attempt_key')}"
        )

    def _tool_effects_pending(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run_id = args.get("run_id")
        waiting = [e for e in self.effects if not run_id or e["run_id"] == run_id]
        return tool_ok({"waiting": waiting, "decided": list(self.decided)})

    def _tool_effect_decide(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        if self.decide_delay_s:
            self.lock.release()
            try:
                time.sleep(self.decide_delay_s)
            finally:
                self.lock.acquire()
        for effect in self.effects:
            if effect["effect_id"] == args.get("effect_id"):
                self.effects.remove(effect)
                record = {
                    **effect,
                    "outcome": "applied" if args.get("approve") else "rejected",
                    "decided_by": who[0] if who else "local-mcp",
                    "note": args.get("note"),
                    "receipts": [],
                    "decided_at": "2026-10-09T00:00:00Z",
                }
                self.decided.insert(0, record)
                return tool_ok(record)
        return tool_error(f"no staged effect {args.get('effect_id')}")


class RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def tool_ok(value: Any) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(value)}],
        "structuredContent": value,
        "isError": False,
    }


def tool_error(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def _make_handler(fake: FakeRoko) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:  # silence the test output
            return

        def _send(self, status: int, body: Any, headers: dict[str, str] | None = None) -> None:
            data = b"" if body is None else json.dumps(body).encode()
            self.send_response(status)
            if body is not None:
                self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            for name, value in (headers or {}).items():
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(data)

        def _body(self) -> Any:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            try:
                return json.loads(raw) if raw else None
            except ValueError:
                return raw.decode(errors="replace")

        def _record(self, body: Any) -> None:
            with fake.lock:
                fake.requests.append(
                    {
                        "method": self.command,
                        "path": urlsplit(self.path).path,
                        "headers": dict(self.headers),
                        "body": body,
                    }
                )

        def _authorized(self) -> tuple[bool, Any]:
            who = fake.credential(self.headers)
            if fake.auth and who is None:
                self._send(
                    401,
                    {
                        "code": "unauthorized",
                        "message": "missing X-Api-Key header or Authorization bearer token",
                    },
                )
                return False, None
            return True, who

        def do_GET(self) -> None:
            parts = urlsplit(self.path)
            path = parts.path
            self._record(None)
            if path == "/health":
                return self._send(200, {"status": "ok", "uptime_secs": 1, "version": "0.1.0"})
            ok, who = self._authorized()
            if not ok:
                return None
            method = "api_key" if who else "none"
            with fake.lock:
                if path == "/api/health":
                    active = sum(1 for r in fake.runs.values() if r.current() not in TERMINAL)
                    return self._send(
                        200,
                        {"status": "ok", "version": "0.1.0", "active_runs": active, "active_plans": 0},
                        {"X-Auth-Method": method},
                    )
                if path == "/api/plans":
                    return self._send(
                        200,
                        [
                            {
                                "id": pid,
                                "title": p["title"],
                                "task_count": len(p["tasks"]),
                                "tasks_done": 0,
                                "status": p.get("status", "ready"),
                            }
                            for pid, p in fake.plans.items()
                        ],
                    )
                if path.startswith("/api/plans/") and path.endswith("/tasks"):
                    pid = unquote(path[len("/api/plans/") : -len("/tasks")])
                    plan = fake.plans.get(pid)
                    if plan is None:
                        return self._send(404, {"code": "not_found", "message": f"plan '{pid}' not found"})
                    return self._send(
                        200,
                        {
                            "plan_id": pid,
                            "title": plan["title"],
                            "task_count": len(plan["tasks"]),
                            "max_parallel": 2,
                            "tasks": plan["tasks"],
                        },
                    )
                if path == "/api/api-keys":
                    # roko lists keys to admins only (route_permissions.rs, rbac.rs).
                    if fake.auth and (who is None or who[1] != "admin"):
                        return self._send(
                            403, {"error": "forbidden", "permission": "config:edit", "role": "member"}
                        )
                    return self._send(
                        200, {"keys": [{"name": k["name"], "scope": k["scope"]} for k in fake.keys.values()]}
                    )
                if path == "/api/knowledge":
                    query = parse_qs(parts.query).get("q", [""])[0]
                    return self._send(
                        200, {"results": [k for k in fake.knowledge if query in k["content"]], "total": 0}
                    )
            return self._send(404, {"error": "not_found", "message": f"No API route matches GET {path}"})

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            body = self._body()
            self._record(body)
            ok, who = self._authorized()
            if not ok:
                return None
            with fake.lock:
                if path == "/mcp":
                    return self._mcp(body, who)
                if path == "/api/api-keys":
                    if who is None or who[1] != "admin":
                        return self._send(
                            403, {"error": "forbidden", "permission": "config:edit", "role": "member"}
                        )
                    name = body.get("name")
                    if any(k["name"] == name for k in fake.keys.values()):
                        return self._send(
                            409, {"code": "conflict", "message": f"API key with name '{name}' already exists"}
                        )
                    value = fake.add_key(name, body.get("scope", "admin"))
                    return self._send(
                        201,
                        {
                            "name": name,
                            "key": value,
                            "scope": body.get("scope", "admin"),
                            "created_at": "2026-10-09T00:00:00Z",
                        },
                    )
                if path.startswith("/api/api-keys/") and path.endswith("/rotate"):
                    name = path[len("/api/api-keys/") : -len("/rotate")]
                    for value, key in list(fake.keys.items()):
                        if key["name"] == name:
                            del fake.keys[value]
                            new = fake.add_key(name, key["scope"])
                            return self._send(
                                200,
                                {
                                    "name": name,
                                    "key": new,
                                    "scope": key["scope"],
                                    "created_at": "2026-10-09T00:00:00Z",
                                },
                            )
                    return self._send(
                        404, {"code": "not_found", "message": f"API key with name '{name}' not found"}
                    )
            return self._send(404, {"error": "not_found", "message": f"No API route matches POST {path}"})

        def _mcp(self, request: Any, who: Any) -> None:
            if not isinstance(request, dict):
                return self._send(
                    200,
                    {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {"code": -32600, "message": "expected one JSON-RPC request object"},
                    },
                )
            rid = request.get("id")
            method = request.get("method")
            if isinstance(method, str) and method.startswith("notifications/"):
                return self._send(202, None)
            try:
                if method == "initialize":
                    result: Any = {
                        "protocolVersion": "2025-11-25",
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "roko", "version": "0.1.0"},
                    }
                elif method == "tools/list":
                    result = {
                        "tools": [
                            {"name": n, "description": n, "inputSchema": {"type": "object"}}
                            for n in MCP_TOOLS
                        ]
                    }
                elif method == "tools/call":
                    params = request.get("params") or {}
                    result = fake.call_tool(str(params.get("name")), params.get("arguments") or {}, who)
                else:
                    raise RpcError(-32601, f"method not found: {method}")
            except RpcError as exc:
                return self._send(
                    200, {"jsonrpc": "2.0", "id": rid, "error": {"code": exc.code, "message": exc.message}}
                )
            return self._send(200, {"jsonrpc": "2.0", "id": rid, "result": result})

    return Handler

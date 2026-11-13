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
import tomllib
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
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
# The plan or run id the plugin's readiness probes name: one that cannot exist.
PROBE_PREFIX = "roko-doctor-probe-"


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
    # The state run_status last reported; the event index follows it.
    reported: str | None = None
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    # Overrides the scripted event index (rows as the runner writes them).
    events: list[dict[str, Any]] | None = None
    # Overrides run_status `tasks` (roko's own task counts), else one task.
    tasks: dict[str, int] | None = None
    # Overrides run_status `finished_at` once the run ended (roko's summary's end), else a placeholder.
    finished_at: str | None = None
    # More of roko's summary for run_status (its `rungs[]`, say).
    summary_extra: dict[str, Any] = field(default_factory=dict)
    # Overrides the manifest its bundle serves (a Graph run's, with every invocation's start, say).
    manifest: dict[str, Any] | None = None

    def current(self) -> str:
        if self.timeline is not None:
            elapsed = time.monotonic() - self.started
            return [state for at, state in self.timeline if at <= elapsed][-1]
        return self.states[0]

    def advance(self) -> str:
        """The state to report now; the next call reports the next scripted one."""
        if self.timeline is not None:
            self.reported = self.current()
            return self.reported
        state = self.states[0]
        if len(self.states) > 1:
            self.states.pop(0)
        self.reported = state
        return state

    @property
    def event_plan(self) -> str:
        # A prompt run is a one-task plan named after the run.
        return self.plan_id if self.kind == "plan" and self.plan_id else self.run_id

    def index(self) -> list[dict[str, Any]] | None:
        """The run's event index as roko's runner writes it, for the state last reported."""
        if self.events is not None:
            return self.events
        state = self.reported or (self.states[0] if self.timeline is None else self.current())
        if state == "queued":
            return None
        plan, rid = self.event_plan, self.run_id
        rows: list[dict[str, Any]] = [
            {
                "type": "plan_set_loaded",
                "plans": [{"plan_id": plan, "title": plan, "tasks_total": 1, "wave": 0}],
            },
            {"type": "event_log_entry", "plan_id": "", "task_id": "", "message": "spec gate: allow"},
            {"type": "plan_started", "plan_id": plan, "tasks_total": 1},
            {"type": "task_started", "plan_id": plan, "task_id": "T1", "title": "do the work", "phase": "x"},
            {
                "type": "agent_spawned",
                "plan_id": plan,
                "task_id": "T1",
                "attempt": 0,
                "model": "fake-model",
                "provider": "fake",
                "role": "implementer",
                "agent_id": f"{plan}/T1",
            },
            {"type": "agent_heartbeat", "plan_id": plan, "task_id": "T1", "elapsed_ms": 5000},
        ]
        if state in ("succeeded", "failed", "unverified"):
            if state != "unverified":
                rows.append(
                    {
                        "type": "gate_rung_started",
                        "plan_id": plan,
                        "task_id": "T1",
                        "rung_name": "verify[0:test]",
                    }
                )
                output = (
                    "$ cargo test\ntest result: ok. 3 passed"
                    if state == "succeeded"
                    else ("$ cargo test\nerror[E0308]: mismatched types\ntest result: 1 did not pass")
                )
                rows.append(
                    {
                        "type": "gate_result",
                        "plan_id": plan,
                        "task_id": "T1",
                        "gate": "verify[0:test]",
                        "passed": state == "succeeded",
                        "output_text": output,
                    }
                )
            for metric, value in (
                ("input_tokens", 1000.0),
                ("output_tokens", 200.0),
                ("cache_read_tokens", 50.0),
                ("cost_usd", self.cost_usd),
            ):
                rows.append(
                    {
                        "type": "efficiency_event",
                        "plan_id": plan,
                        "task_id": "T1",
                        "metric": metric,
                        "value": value,
                    }
                )
            outcome = {"succeeded": "passed", "failed": "failed", "unverified": "unverified"}[state]
            rows.append({"type": "task_completed", "plan_id": plan, "task_id": "T1", "outcome": outcome})
            rows.append({"type": "plan_completed", "plan_id": plan, "success": state == "succeeded"})
        if state in TERMINAL:
            rows.append({"type": "run_completed", "outcome": state, "duration_ms": 42_000})
        return [{**row, "run_id": rid} for row in rows]

    def bundle(self) -> dict[str, Any]:
        if self.manifest is not None:
            return {"manifest": self.manifest, "files": []}
        state = self.reported or "running"
        return {
            "manifest": {
                "run_id": self.run_id,
                "kind": "plan_run",
                "origin": self.origin,
                "plan_ids": [self.event_plan],
                "invocations": [{"inv": 1, "started_at": _iso(self.created_at)}],
                "closed": (
                    {"status": state, "ended_at": _iso(self.created_at + timedelta(seconds=42))}
                    if state in TERMINAL
                    else None
                ),
            },
            "files": [],
        }


@dataclass
class FakeRoko:
    auth: bool = False
    boundary: bool = True
    # When set, the boundary follows this roko.toml, which roko reads for each run: `[agent.data_llm]`, or
    # `[serve.mcp] allow_without_data_llm = true`, lets runs from chat start. Since 2026-10-15 roko also
    # needs `[agent.data_llm]` to name a model it calls over an API with its key set (`refusal_words`).
    config: Path | None = None
    # roko since 2026-10-15 names every tool failure in `structuredContent.error` (its `code`, and a
    # refused run's `data.refusal`); an older one says it only in the text.
    refusal_words: bool = True
    # Whether a model a run from chat can use exists; a roko with `refusal_words` refuses up front
    # without one (gap-cf427e). An older roko starts the run, which then fails.
    tool_loop: bool = True
    # Whether one of those models has a price; roko since gap-8548e3 refuses `no_price` without one (only once a
    # tool-loop model exists, as roko orders its reasons). An older roko never refuses for a price.
    priced: bool = True
    # `GET /api/providers` and `GET /api/models`, as roko lists them; None answers 404.
    providers: list[dict[str, Any]] | None = field(
        default_factory=lambda: [
            {"id": "anthropic", "kind": "anthropic_api", "has_api_key": True, "model_count": 1},
            {"id": "claude_cli", "kind": "claude_cli", "has_api_key": False, "model_count": 1},
        ]
    )
    models: list[dict[str, Any]] | None = field(
        default_factory=lambda: [
            {
                "key": "claude-haiku",
                "slug": "claude-haiku-4-5",
                "provider": "anthropic",
                "supports_tools": True,
                "cost_input_per_m": 1.0,
                "cost_output_per_m": 5.0,
            },
            {
                "key": "claude-sonnet",
                "slug": "claude-sonnet-4-6",
                "provider": "claude_cli",
                "supports_tools": True,
            },
        ]
    )
    # `POST /api/config/reload`: its status (403 as with a write key, 400 for a config roko rejects).
    reload_status: int = 200
    # `GET /health` uptime: the time since start(), unless a test names one.
    uptime_secs: int | None = None
    # `GET /api/plans/{run_id}/status` `error`: why a failed run failed, by run id (roko keeps it until it
    # restarts; a refused start's reason is only here and on the hub).
    run_errors: dict[str, str] = field(default_factory=dict)
    # The arguments `tools/list` declares for a tool, by name (a newer roko's `title`, say); by default it
    # declares none.
    tool_args: dict[str, list[str]] = field(default_factory=dict)
    # `POST /api/plans/{id}/validate` answers (roko's PlanValidationDto), by plan id; a known plan without one
    # is valid. `plan_run` refuses a plan whose answer is not valid, as roko does (422 with the report).
    plan_checks: dict[str, dict[str, Any]] = field(default_factory=dict)
    # `GET /api/plans/{id}/source` `toml`, by plan id.
    plan_sources: dict[str, str] = field(default_factory=dict)
    # Since roko bug-7a08a8 its refusal lists each error after the count ("\n- RULE: message", later lines indented);
    # an older roko names only how many.
    refusal_lists_errors: bool = True
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
    # How long run_prompt takes to answer after it started the run.
    start_delay_s: float = 0.0
    gates_summary: dict[str, Any] = field(default_factory=dict)
    # When set, an ended run's summary carries `result`, where its work is, as
    # roko serve reports it since gap-8409d0; it gets the run's id.
    run_result: Callable[[str], dict[str, Any]] | None = None
    scorecard: list[dict[str, Any]] = field(default_factory=list)
    cost_trend: list[dict[str, Any]] = field(default_factory=list)
    # GET /api/learn/efficiency `tasks`: each task roko recorded, with its cost_usd and duration_ms.
    efficiency_tasks: list[dict[str, Any]] = field(default_factory=list)
    # `GET /api/runs/{id}/diff` answers (roko gap-0d6d21) by run id; None answers 404 as an older roko does.
    diffs: dict[str, dict[str, Any]] | None = field(default_factory=dict)
    # What `GET /api/runs/{id}/events?skip=` leaves out (roko gap-cb9044); any other name answers 400. None is an
    # older roko, which ignores `skip`.
    skip_names: tuple[str, ...] | None = ("live_text", "heartbeats")
    # Whether such a page also counts the rows it passed over (`skipped_rows`); roko 8d02ac126 does not.
    counts_skipped: bool = True
    # roko since bug-cbdb6b and gap-b78706: a plan's row names the run a plan run would continue
    # (`resumable_run`, from `plans[id]["resumable_run"]`, null without one), and a chat's plan_run over it that
    # says neither resume nor fresh is refused. False is an older roko: no field, and plan_run starts over.
    resumes: bool = True
    # roko's StateHub (GET /api/events): each run's index rows as they appear (run_id dropped, as the hub
    # drops it, but on run_completed), plus anything a test publishes. (seq, event) pairs.
    hub: list[tuple[int, dict[str, Any]]] = field(default_factory=list)
    hub_emitted: dict[str, int] = field(default_factory=dict)
    hub_lock: threading.Lock = field(default_factory=threading.Lock)
    hub_closed: bool = False
    # The next connection starts with an `event: gap` frame / closes after this many events.
    hub_gap: bool = False
    hub_drop_after: int | None = None
    hub_keepalive_s: float = 8.0
    # Each connection's Last-Event-ID (None for a first connection).
    hub_connects: list[str | None] = field(default_factory=list)
    # roko's loop routes (GET /api/learn/loops, …); `learn_broken` makes each answer 500.
    loops: list[dict[str, Any]] = field(default_factory=list)
    route_rows: list[dict[str, Any]] = field(default_factory=list)
    adaptive: list[dict[str, Any]] = field(default_factory=list)
    diagnoses: list[dict[str, Any]] = field(default_factory=list)
    playbooks: int = 0
    incidents: list[dict[str, Any]] = field(default_factory=list)
    learn_broken: bool = False
    estimate: dict[str, Any] | None = field(
        default_factory=lambda: {
            "estimate": {"total_cost_usd": "0.0267", "total_duration_secs": "30"},
            "confidence": "low",
            "note": "Based on historical efficiency events",
        }
    )
    requests: list[dict[str, Any]] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)
    # 0.7: what a roko serve bound to loopback adds to `GET /health` (pid, workdir, instance_id, git_sha,
    # git_dirty, started_at, idle_exit_secs); `GET /api/doctor` names its `workdir`. None: an older roko.
    identity: dict[str, Any] | None = None
    # False plays a roko from before `/mcp` (August): `POST /mcp` answers 404 as an unknown route.
    mcp: bool = True
    # When something other than `/health` or `/ready` last asked (monotonic): roko's idle exit counts from it.
    last_activity: float = field(default_factory=time.monotonic)

    def __post_init__(self) -> None:
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None
        self.started_at = time.monotonic()

    # -- lifecycle -----------------------------------------------------------

    def start(self, port: int = 0) -> FakeRoko:
        self.started_at = time.monotonic()
        handler = _make_handler(self)
        self._server = ThreadingHTTPServer(("127.0.0.1", port), handler)
        self._server.daemon_threads = True
        self._thread = threading.Thread(
            target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True
        )
        self._thread.start()
        return self

    def stop(self) -> None:
        self.hub_closed = True
        if self._server is not None:
            self._server.shutdown()
            self._server.server_close()

    # -- the hub -------------------------------------------------------------

    def publish(self, event: dict[str, Any]) -> int:
        """Put one event on the hub, as roko's runner publishes it; its seq."""
        with self.hub_lock:
            seq = (self.hub[-1][0] if self.hub else 0) + 1
            self.hub.append((seq, {"ts_millis": int(time.time() * 1000), **event}))
            return seq

    def pump_hub(self) -> None:
        """Copy the rows each run's index gained since the last pump onto the hub (call with `lock` held)."""
        for run in list(self.runs.values()):
            rows = run.index() or []
            done = self.hub_emitted.get(run.run_id, 0)
            for row in rows[done:]:
                event = dict(row)
                if event.get("type") != "run_completed":
                    event.pop("run_id", None)
                with self.hub_lock:
                    seq = (self.hub[-1][0] if self.hub else 0) + 1
                    self.hub.append((seq, event))
            self.hub_emitted[run.run_id] = max(done, len(rows))

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

    def plan_row(self, plan_id: str) -> dict[str, Any]:
        """A plan as `GET /api/plans` lists it and `GET /api/plans/{id}` answers it: with its `group` (the
        plan set, as roko names it) when the plan has one."""
        plan = self.plans[plan_id]
        row = {
            "id": plan_id,
            "title": plan["title"],
            "task_count": len(plan["tasks"]),
            "tasks_done": plan.get("tasks_done", 0),
            "status": plan.get("status", "ready"),
        }
        if plan.get("group"):
            row["group"] = plan["group"]
        if "fixture" in plan:  # roko since gap-8f84d1: a demo or test plan, also once it has run
            row["fixture"] = plan["fixture"]
        if self.resumes:
            row["resumable_run"] = plan.get("resumable_run")
        if "last_run" in plan:  # roko since gap-c1726f: the plan's last run, with when roko accepted it
            row["last_run"] = plan["last_run"]
        return row

    # -- roko's learning and control routes ----------------------------------
    # GET /api/learn/…, /api/diagnosis/recent, /api/safety/incidents and /api/knowledge/entries answer
    # from these. FakeRoko answers from the fields above; the replay roko derives them from its runs.

    def learn_loops(self) -> list[dict[str, Any]]:
        """`GET /api/learn/loops`: one row per registered loop."""
        return self.loops

    def learn_loop(self, loop_id: str) -> dict[str, Any] | None:
        """`GET /api/learn/loops/{id}`: the loop's row, its latest health, transitions and canaries."""
        row = next((row for row in self.learn_loops() if row.get("loop_id") == loop_id), None)
        if row is None:
            return None
        return {"loop": row, "health": None, "transitions": [], "canaries": []}

    def learn_decisions(self, loop_id: str, limit: int) -> list[dict[str, Any]]:
        """`GET /api/learn/loops/{id}/decisions`: the runs' decision rows naming the loop, newest first."""
        return self.route_rows[:limit]

    def learn_adaptive(self) -> dict[str, Any]:
        """`GET /api/learn/adaptive-thresholds`."""
        return {"source": "fake", "tracked_rungs": len(self.adaptive), "rungs": self.adaptive}

    def learn_gate_thresholds(self) -> dict[str, Any]:
        """`GET /api/learn/gate-thresholds`: the thresholds file as roko's projection serves it."""
        raw = {
            "rungs": {
                str(row.get("rung")): {
                    "ema_pass_rate": row.get("ema_pass_rate"),
                    "total_observations": row.get("total_observations", 0),
                    "consecutive_passes": row.get("consecutive_passes", 0),
                }
                for row in self.adaptive
            },
            "cusum_sensitivity": 0.25,
            "cusum_threshold": 4.0,
        }
        return {
            **raw,
            "projection_state": "fresh",
            "source": ".roko/learn/gate-thresholds.json",
            "value": raw,
            "evidence": {},
        }

    def learn_diagnoses(self) -> list[dict[str, Any]]:
        """`GET /api/diagnosis/recent`."""
        return self.diagnoses

    def learn_playbooks(self) -> dict[str, Any]:
        """`GET /api/learn/playbooks`."""
        return {"total": self.playbooks, "playbooks": []}

    def learn_reflexes(self) -> dict[str, Any]:
        """`GET /api/learn/reflexes`: T0 reflex rules."""
        return {"total_rules": 0, "max_rules": 200, "top_rules": [], "recent_demotions": []}

    def safety_incidents(self) -> dict[str, Any]:
        """`GET /api/safety/incidents`."""
        return {"incidents": self.incidents, "total": len(self.incidents)}

    def knowledge_entries(self, limit: int) -> dict[str, Any]:
        """`GET /api/knowledge/entries`."""
        items = [
            {
                "id": entry.get("id", "k"),
                "label": entry["content"][:80],
                "domain": "gate",
                "citations": 3,
                "confidence": 0.9,
            }
            for entry in self.knowledge
        ][:limit]
        return {"items": items, "total": len(items), "has_more": False}

    def input_schema(self, name: str) -> dict[str, Any]:
        """Tool `name`'s `inputSchema` in `tools/list`: its arguments when a test names them (`tool_args`)."""
        if name not in self.tool_args:
            return {"type": "object"}
        properties = {arg: {"type": "string"} for arg in self.tool_args[name]}
        return {"type": "object", "properties": properties, "additionalProperties": False}

    def tool_calls(self, name: str, *, probes: bool = False) -> list[dict[str, Any]]:
        """The arguments of each call of tool `name`, oldest first.

        The plugin's readiness probes (a plan or run named `roko-doctor-probe-…`, which cannot exist)
        are left out unless `probes`: they change nothing, and a page that shows the setup card makes
        them on its own.
        """
        calls = [
            r["body"]["params"]["arguments"]
            for r in self.requests
            if r["path"] == "/mcp"
            and isinstance(r.get("body"), dict)
            and r["body"].get("method") == "tools/call"
            and r["body"]["params"].get("name") == name
        ]
        return calls if probes else [args for args in calls if not _is_probe(args)]

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
        result: dict[str, Any] = getattr(self, f"_tool_{name}")(args, who)
        if result.get("isError") and not self.refusal_words:
            result.pop("structuredContent", None)
        return result

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

    def screened(self) -> bool:
        """Whether runs from chat may start: `boundary`, or what `config` says."""
        return self._unscreened() is None

    def _unscreened(self) -> str | None:
        """Why runs from chat may not start for want of the boundary, in roko's words; None if they may."""
        boundary = (
            "a run from a chat host needs the data-model boundary: set [agent.data_llm] in roko.toml, "
            "or [serve.mcp] allow_without_data_llm = true to run without it"
        )
        if self.config is None:
            return None if self.boundary else boundary
        try:
            data = tomllib.loads(self.config.read_text(encoding="utf-8"))
        except (OSError, tomllib.TOMLDecodeError):
            return boundary
        agent = data.get("agent") if isinstance(data.get("agent"), dict) else {}
        serve = data.get("serve") if isinstance(data.get("serve"), dict) else {}
        mcp = serve.get("mcp") if isinstance(serve.get("mcp"), dict) else {}
        if isinstance(agent.get("data_llm"), dict):
            model = agent["data_llm"].get("model")
            if not self.refusal_words or self._api_model_with_key(model):
                return None
            return (
                "a run from a chat host needs a working data-model boundary, and [agent.data_llm] model "
                f"`{model}` is not a configured model: name a model roko calls over an API, with its key set"
            )
        return None if mcp.get("allow_without_data_llm") is True else boundary

    def _api_model_with_key(self, key: Any) -> bool:
        kinds = {"anthropic_api", "openai_compat", "perplexity_api", "gemini_api", "cerebras_api"}
        providers = {p["id"]: p for p in self.providers or []}
        for model in self.models or []:
            provider = providers.get(model.get("provider"))
            if model.get("key") == key and provider is not None:
                return provider.get("kind") in kinds and provider.get("has_api_key") is True
        return False

    def _boundary(self) -> dict[str, Any] | None:
        refusals = []
        unscreened = self._unscreened()
        if unscreened:
            refusals.append("no_data_boundary")
        if not self.tool_loop and self.refusal_words:
            refusals.append("no_tool_loop_model")
        elif not self.priced and self.refusal_words:
            refusals.append("no_price")
        if not refusals:
            return None
        if unscreened:
            text = unscreened
        elif refusals[0] == "no_price":
            keys = [str(m.get("key")) for m in self.models or [] if self._api_model_with_key(m.get("key"))]
            text = (
                "a run from a chat host is held to its max_usd, and a cap can count only the calls of a model "
                f"with a price; the models it can run on have none ({', '.join(keys)}). To fix it, set "
                "cost_input_per_m and cost_output_per_m on one's [models.*] entry in roko.toml (0 for a free "
                "local model)"
            )
        else:
            text = (
                "a run from a chat host needs a model roko runs in its own tool loop with its key set; "
                "this workspace routes tasks only to CLI agents"
            )
        refused = tool_error(text, "forbidden")
        refused["structuredContent"]["error"]["data"] = {"refusal": refusals[0], "refusals": refusals}
        return refused

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
            return tool_error(
                "a plan run is active in this workspace; start the prompt run once it ends", "conflict"
            )
        run = self._new_run("run", max_usd=cap, who=who)
        self._slow_start()
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
            return tool_error(f"plan '{plan_id}' not found", "not_found")
        check = self.plan_checks.get(plan_id)
        if check is not None and check.get("valid") is False:
            errors = [str(error) for error in check.get("errors") or []]
            listed = "".join("\n- " + error.replace("\n", "\n  ") for error in errors)
            failure = tool_error(
                f"plan '{plan_id}' failed validation with {len(errors)} error(s); fix them before running it"
                + (listed if self.refusal_lists_errors else ""),
                "unprocessable_entity",
            )
            failure["structuredContent"]["error"]["data"] = check
            return failure
        resume, fresh, from_run = args.get("resume") is True, args.get("fresh") is True, args.get("from_run")
        if fresh and (resume or from_run):
            raise RpcError(
                -32602, "fresh starts the plan over, so it cannot be combined with resume or from_run"
            )
        left = self.plans[plan_id].get("resumable_run") if self.resumes else None
        answer: dict[str, Any] = {}
        # roko since bug-b7f6a8: a resume answers from the plan's checkpoint (`plans[id]["checkpoint"]`), which
        # the plan's row shows only while it is resumable. One roko cannot continue is refused with
        # `cannot_resume`; one it continues says what the run spent before it stopped and what is left.
        checkpoint = self.plans[plan_id].get("checkpoint")
        if resume and isinstance(checkpoint, dict):
            if checkpoint.get("continues") is False:
                failure = tool_error(_cannot_resume_words(plan_id, checkpoint), "conflict")
                failure["structuredContent"]["error"]["data"] = {
                    "refusal": "cannot_resume",
                    "refusals": ["cannot_resume"],
                    **{
                        key: checkpoint.get(key)
                        for key in ("run_id", "status", "reason", "passed_tasks", "spent_usd")
                    },
                }
                return failure
            spent = checkpoint.get("spent_usd")
            left_usd = (
                {"left_usd": round(max(0.0, cap - spent), 6)} if isinstance(spent, float) and cap else {}
            )
            answer["resumes"] = {**checkpoint, **left_usd}
            self.plans[plan_id]["checkpoint"] = None
            left = None
        if isinstance(left, dict):
            if not (resume or fresh or from_run):
                failure = tool_error(_resumable_words(plan_id, left), "conflict")
                failure["structuredContent"]["error"]["data"] = {
                    "refusal": "resumable_run",
                    "refusals": ["resumable_run"],
                    **left,
                }
                return failure
            answer["set_aside" if fresh else "resumes"] = {**left, "resumable": True}
            self.plans[plan_id]["resumable_run"] = None
        active = [r for r in self.runs.values() if r.kind == "plan" and r.current() not in TERMINAL]
        run = self._new_run("plan", plan_id=plan_id, max_usd=cap, who=who)
        if active:
            run.states = ["queued", *run.states]
            return tool_ok(
                {"run_id": run.run_id, "state": "queued", "position": len(active), "links": {}, **answer}
            )
        return tool_ok({"run_id": run.run_id, "state": "running", "position": None, "links": {}, **answer})

    def _tool_plan_generate(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        prompt = args.get("prompt")
        # Since gap-fe4225: a spec in the workspace, which roko reads itself.
        spec_path = args.get("spec_path")
        if not isinstance(prompt, str) and not isinstance(spec_path, str):
            raise RpcError(-32600, "missing string argument prompt")
        prompt = prompt if isinstance(prompt, str) else str(spec_path)
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
        answer: dict[str, Any] = {
            "run_id": run.run_id,
            "plan_id": slug,
            "state": "running",
            "links": {"operation": f"/api/operations/{run.run_id}", "plan": f"/api/plans/{slug}"},
        }
        if "max_usd" in self.tool_args.get("plan_generate", []):
            # Since roko 55d0acda8 (gap-33d458): the cap that applies, the request's or [authoring]'s.
            asked = args.get("max_usd")
            answer["max_usd"] = float(asked) if isinstance(asked, (int, float)) else 2.0
            answer["max_usd_source"] = "request" if isinstance(asked, (int, float)) else "config"
        return tool_ok(answer)

    def _slow_start(self) -> None:
        """Answer a start late, as a busy roko does: the run exists already."""
        if self.start_delay_s:
            self.lock.release()
            try:
                time.sleep(self.start_delay_s)
            finally:
                self.lock.acquire()

    def _tool_run_status(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run = self.runs.get(str(args.get("run_id")))
        if run is None:
            return tool_error(f"run '{args.get('run_id')}' not found", "not_found")
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
        reported = self.run_result(run.run_id) if done and self.run_result else None
        return tool_ok(
            {
                **({"result": reported} if reported is not None else {}),
                "run_id": run.run_id,
                "state": state,
                "verdict": state if done else None,
                "position": None,
                "active": not done,
                "cost_usd": run.cost_usd,
                "tasks": dict(run.tasks)
                if run.tasks is not None
                else {
                    "total": 1,
                    "passed": 1 if state == "succeeded" else 0,
                    "failed": 1 if state == "failed" else 0,
                    "unverified": 1 if state == "unverified" else 0,
                    "other": 0,
                },
                "untrusted_input_boundary": [{"plan_id": "p", "task_id": "T1", "boundary": "data_llm"}],
                "milestones": [{"kind": "started", "text": "run started", "at": 1}],
                "started_at": "1",
                "finished_at": (run.finished_at or "5") if done else None,
                "links": {"summary": "/api/runs/x/summary"},
                **run.summary_extra,
            }
        )

    def _tool_run_cancel(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run = self.runs.get(str(args.get("run_id")))
        # roko has no cancel for a plan writing (an operation): its run_cancel knows only runs (38bedecea).
        if run is None or run.current() in TERMINAL or run.kind.startswith("plan_generate:"):
            return tool_error("no active execution for this plan", "not_found")
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
            f"of attempt {args.get('attempt_key')}",
            "not_found",
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
        return tool_error(f"no staged effect {args.get('effect_id')}", "not_found")


def _is_probe(args: Any) -> bool:
    return isinstance(args, dict) and any(
        str(args.get(key) or "").startswith(PROBE_PREFIX) for key in ("plan_id", "run_id")
    )


def _iso(when: datetime) -> str:
    return when.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _resumable_words(plan_id: str, left: dict[str, Any]) -> str:
    """roko's refusal of a plan run over a run that stopped part way (bug-cbdb6b), word for word."""

    def names(tasks: list[str]) -> str:
        return tasks[0] if len(tasks) == 1 else f"{', '.join(tasks[:-1])} and {tasks[-1]}"

    passed, rest = list(left["passed_tasks"]), list(left["tasks_left"])
    many = len(rest) > 1
    return (
        f"Plan '{plan_id}' has a run that can be resumed: {str(left['run_id'])[:8]} ({left['status']}) passed "
        f"{names(passed)}, and {names(rest)} {'are' if many else 'is'} left. Pass resume=true to continue it, "
        f"so only {names(rest)} {'run' if many else 'runs'}, or fresh=true to start over and set its progress "
        "aside."
    )


def _cannot_resume_words(plan_id: str, run: dict[str, Any]) -> str:
    """roko's refusal of a resume it cannot continue (bug-b7f6a8), word for word."""
    passed = list(run.get("passed_tasks") or [])
    named = passed[0] if len(passed) == 1 else f"{', '.join(passed[:-1])} and {passed[-1]}" if passed else ""
    again = (
        f"{named} {'runs' if len(passed) == 1 else 'run'} again, though {'it' if len(passed) == 1 else 'they'} passed"
        if passed
        else "every task runs"
    )
    return (
        f"Plan '{plan_id}' cannot resume run {str(run['run_id'])[:8]} ({run['status']}): "
        f"{run.get('reason') or 'its checkpoint cannot be resumed'}. Pass fresh=true to start over and set its "
        f"progress aside: {again}."
    )


def _skipped(row: dict[str, Any], skip: list[str]) -> bool:
    """Whether `?skip=` leaves the index row out, as roko gap-cb9044 does: `live_text` an agent's streamed reasoning
    and its text while it streams (its tool steps, results and final text stay), `heartbeats` both heartbeats."""
    if "heartbeats" in skip and row.get("type") in ("agent_heartbeat", "plan_check_heartbeat"):
        return True
    content = row.get("content")
    if "live_text" not in skip or row.get("type") != "agent_output" or not isinstance(content, str):
        return False
    prefix = "\x1eroko.stream.v1 "
    try:
        envelope = json.loads(content[len(prefix) :]) if content.startswith(prefix) else None
    except ValueError:
        return False
    if not isinstance(envelope, dict):
        return False
    return envelope.get("kind") == "reasoning" or (
        envelope.get("kind") == "text" and envelope.get("live") is True
    )


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


def tool_error(message: str, code: str | None = None) -> dict[str, Any]:
    """A failed tool call; with `code`, named as roko names it since 2026-10-15."""
    failure: dict[str, Any] = {"content": [{"type": "text", "text": message}], "isError": True}
    if code:
        failure["structuredContent"] = {"error": {"code": code, "message": message}}
    return failure


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
                parts = urlsplit(self.path)
                if parts.path not in ("/health", "/ready"):
                    fake.last_activity = time.monotonic()
                fake.requests.append(
                    {
                        "method": self.command,
                        "path": parts.path,
                        "query": {key: values[0] for key, values in parse_qs(parts.query).items()},
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
                uptime = fake.uptime_secs
                if uptime is None:
                    uptime = int(time.monotonic() - fake.started_at)
                return self._send(
                    200, {"status": "ok", "uptime_secs": uptime, "version": "0.1.0", **(fake.identity or {})}
                )
            ok, who = self._authorized()
            if not ok:
                return None
            method = "api_key" if who else "none"
            if path in ("/api/events", "/api/sse"):
                return self._hub_stream(parts.query)
            with fake.lock:
                if fake.learn_broken and (
                    path.startswith(("/api/learn/", "/api/learning/", "/api/showcase/m2/"))
                    or path in ("/api/diagnosis/recent", "/api/safety/incidents", "/api/knowledge/entries")
                ):
                    return self._send(500, {"code": "internal", "message": "the learning store is broken"})
                learned = self._learn_route(path, parse_qs(parts.query))
                if learned is not None:
                    return self._send(*learned)
                if path == "/api/doctor" and (fake.identity or {}).get("workdir"):
                    return self._send(200, {"workdir": fake.identity["workdir"], "checks": []})
                if path == "/api/health":
                    active = sum(1 for r in fake.runs.values() if r.current() not in TERMINAL)
                    return self._send(
                        200,
                        {"status": "ok", "version": "0.1.0", "active_runs": active, "active_plans": 0},
                        {"X-Auth-Method": method},
                    )
                if path == "/api/plans":
                    return self._send(200, [fake.plan_row(pid) for pid in fake.plans])
                if path.startswith("/api/plans/") and path.count("/") == 3:
                    pid = unquote(path[len("/api/plans/") :])
                    if pid not in fake.plans:
                        return self._send(404, {"code": "not_found", "message": f"plan '{pid}' not found"})
                    return self._send(200, fake.plan_row(pid))
                if path.startswith("/api/plans/") and path.endswith("/tasks"):
                    pid = unquote(path[len("/api/plans/") : -len("/tasks")])
                    plan = fake.plans.get(pid)
                    if plan is None:
                        return self._send(404, {"code": "not_found", "message": f"plan '{pid}' not found"})
                    # roko since bug-35c1f3: the plan's own checks, and whether its tasks run the workspace's rungs.
                    extra = {key: plan[key] for key in ("plan_checks", "workspace_rungs") if key in plan}
                    return self._send(
                        200,
                        {
                            "plan_id": pid,
                            "title": plan["title"],
                            "task_count": len(plan["tasks"]),
                            "max_parallel": 2,
                            "tasks": plan["tasks"],
                            **extra,
                        },
                    )
                if path.startswith("/api/plans/") and path.endswith("/source"):
                    pid = unquote(path[len("/api/plans/") : -len("/source")])
                    if pid not in fake.plan_sources:
                        return self._send(404, {"code": "not_found", "message": f"plan '{pid}' not found"})
                    toml = fake.plan_sources[pid]
                    return self._send(200, {"id": pid, "path": f"plans/{pid}/tasks.toml", "toml": toml})
                if path.startswith("/api/plans/") and path.endswith("/status"):
                    rid = unquote(path[len("/api/plans/") : -len("/status")])
                    run = fake.runs.get(rid)
                    if run is None:
                        return self._send(
                            404, {"code": "not_found", "message": "no execution of this plan is known"}
                        )
                    state = run.current()
                    return self._send(
                        200,
                        {
                            "id": rid,
                            "run_id": rid,
                            "status": state,
                            "error": fake.run_errors.get(rid),
                            "finished": state in TERMINAL,
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
                if path == "/api/knowledge/search":
                    params = parse_qs(parts.query)
                    query = params.get("q", [""])[0].lower()
                    k = int(params.get("k", ["10"])[0])
                    hits = [
                        {
                            **entry,
                            "score": 1.5,
                            "confidence": 0.8,
                            "confirmations": 2,
                            "created_at": 1791549828,
                        }
                        for entry in fake.knowledge
                        if any(word in entry["content"].lower() for word in query.split())
                    ][:k]
                    return self._send(200, {"query": query, "results": hits, "timestamp": 1})
                if path == "/api/knowledge/entries":
                    limit = int(parse_qs(parts.query).get("limit", ["20"])[0])
                    return self._send(200, fake.knowledge_entries(limit))
                if path == "/api/gates/summary":
                    return self._send(200, {"rungs": [], **fake.gates_summary})
                if path == "/api/learn/model-scorecard":
                    return self._send(200, {"model_count": len(fake.scorecard), "models": fake.scorecard})
                if path == "/api/learn/efficiency":
                    total = sum(point["cost_usd"] for point in fake.cost_trend)
                    return self._send(
                        200,
                        {
                            "total_cost": total,
                            "cost_per_task": total / max(1, len(fake.cost_trend)),
                            "avg_task_duration": 30000.0,
                            "cost_trend": fake.cost_trend,
                            "tasks": fake.efficiency_tasks,
                        },
                    )
                if path == "/api/providers" and fake.providers is not None:
                    return self._send(200, {"providers": fake.providers})
                if path == "/api/models" and fake.models is not None:
                    return self._send(200, {"models": fake.models})
                if path == "/api/dashboard/runs":
                    rows = [
                        {"run_id": rid, "is_complete": run.current() in TERMINAL, "outcome": None}
                        for rid, run in sorted(fake.runs.items())  # roko sorts by id, not time
                        if not run.kind.startswith("plan_generate:")
                    ]
                    return self._send(200, {"runs": rows, "truncated": False})
                if path.startswith("/api/runs/") and path.endswith("/events"):
                    return self._run_events(unquote(path[len("/api/runs/") : -len("/events")]), parts.query)
                if path.startswith("/api/runs/") and path.endswith("/diff"):
                    rid = unquote(path[len("/api/runs/") : -len("/diff")])
                    if fake.diffs is None:
                        return self._send(
                            404, {"error": "not_found", "message": f"No API route matches GET {path}"}
                        )
                    run = fake.runs.get(rid)
                    if run is not None and (run.reported or run.current()) not in TERMINAL:
                        return self._send(
                            409, {"code": "conflict", "message": f"run '{rid}' is still active"}
                        )
                    if rid not in fake.diffs:
                        return self._send(
                            404, {"code": "not_found", "message": f"run '{rid}' has no result to diff"}
                        )
                    return self._send(200, {"run_id": rid, **fake.diffs[rid]})
                if path.startswith("/api/runs/") and path.endswith("/bundle"):
                    run = fake.runs.get(unquote(path[len("/api/runs/") : -len("/bundle")]))
                    if run is None:
                        return self._send(404, {"code": "not_found", "message": "run has no bundle"})
                    return self._send(200, run.bundle())
            return self._send(404, {"error": "not_found", "message": f"No API route matches GET {path}"})

        def do_POST(self) -> None:
            path = urlsplit(self.path).path
            body = self._body()
            self._record(body)
            ok, who = self._authorized()
            if not ok:
                return None
            with fake.lock:
                if path == "/mcp" and not fake.mcp:
                    return self._send(
                        404, {"error": "not_found", "message": "No API route matches POST /mcp"}
                    )
                if path == "/mcp":
                    return self._mcp(body, who)
                if path == "/api/config/reload":
                    if fake.auth and (who is None or who[1] != "admin"):
                        return self._send(403, {"error": "forbidden", "permission": "config:edit"})
                    if fake.reload_status == 400:
                        return self._send(
                            400, {"code": "bad_request", "message": "invalid config: unknown field"}
                        )
                    if fake.reload_status != 200:
                        return self._send(fake.reload_status, {"error": "refused"})
                    return self._send(
                        200, {"success": True, "warnings": [], "timestamp": "2026-10-15T00:00:00Z"}
                    )
                if path.startswith("/api/plans/") and path.endswith("/validate"):
                    pid = unquote(path[len("/api/plans/") : -len("/validate")])
                    if pid not in fake.plans:
                        return self._send(404, {"code": "not_found", "message": f"plan '{pid}' not found"})
                    valid = {"valid": True, "errors": [], "warnings": [], "diagnostics": []}
                    return self._send(200, fake.plan_checks.get(pid, valid))
                if path.startswith("/api/plans/") and path.endswith("/estimate"):
                    pid = unquote(path[len("/api/plans/") : -len("/estimate")])
                    if pid not in fake.plans:
                        return self._send(404, {"code": "not_found", "message": f"plan '{pid}' not found"})
                    if fake.estimate is None:
                        return self._send(403, {"error": "forbidden", "permission": "plan:write"})
                    return self._send(200, {"plan_id": pid, **fake.estimate})
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

        def _learn_route(self, path: str, query: dict[str, list[str]]) -> tuple[int, Any] | None:
            """roko's learning and control routes (and their /api/learning/… and showcase aliases), as
            (status, body); None for any other path. Called with `fake.lock` held."""
            for alias in ("/api/learning/", "/api/showcase/m2/"):
                if path.startswith(alias):
                    path = "/api/learn/" + path[len(alias) :]
            if path == "/api/learn/loops":
                return 200, fake.learn_loops()
            if path.startswith("/api/learn/loops/"):
                rest = unquote(path[len("/api/learn/loops/") :])
                if rest.endswith("/decisions"):
                    raw = query.get("limit", ["50"])[0]
                    limit = min(500, int(raw)) if raw.isdigit() else 50
                    return 200, fake.learn_decisions(rest[: -len("/decisions")], limit)
                detail = fake.learn_loop(rest)
                if detail is None:
                    return 404, {"code": "not_found", "message": f"no registered loop {rest}"}
                return 200, detail
            answers: dict[str, Callable[[], Any]] = {
                "/api/learn/adaptive-thresholds": fake.learn_adaptive,
                "/api/learn/gate-thresholds": fake.learn_gate_thresholds,
                "/api/diagnosis/recent": fake.learn_diagnoses,
                "/api/learn/playbooks": fake.learn_playbooks,
                "/api/learn/reflexes": fake.learn_reflexes,
                "/api/safety/incidents": fake.safety_incidents,
            }
            answer = answers.get(path)
            return (200, answer()) if answer is not None else None

        def _hub_stream(self, query: str) -> None:
            """`GET /api/events`: the hub as server-sent events, from `Last-Event-ID` on, until closed."""
            params = parse_qs(query)
            last = self.headers.get("Last-Event-ID") or params.get("lastEventId", [None])[0]
            with fake.hub_lock:
                fake.hub_connects.append(last)
                gap, fake.hub_gap = fake.hub_gap, False
                drop_after, fake.hub_drop_after = fake.hub_drop_after, None
            try:
                cursor = int(last) if last else 0
            except ValueError:
                cursor = 0
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            sent = 0
            keepalive_at = time.monotonic()
            try:
                if gap:
                    self.wfile.write(b'event: gap\ndata: {"missed_events": 300}\n\n')
                    self.wfile.flush()
                while not fake.hub_closed:
                    with fake.lock:
                        fake.pump_hub()
                    with fake.hub_lock:
                        fresh = [(seq, event) for seq, event in fake.hub if seq > cursor]
                    for seq, event in fresh:
                        self.wfile.write(f"id: {seq}\ndata: {json.dumps(event)}\n\n".encode())
                        self.wfile.flush()
                        cursor = seq
                        sent += 1
                        if drop_after is not None and sent >= drop_after:
                            return
                    if time.monotonic() - keepalive_at >= fake.hub_keepalive_s:
                        self.wfile.write(b": keepalive\n\nevent: keepalive\ndata: {}\n\n")
                        self.wfile.flush()
                        keepalive_at = time.monotonic()
                    time.sleep(0.03)
            except OSError:  # the client went away
                return

        def _run_events(self, run_id: str, query: str) -> None:
            run = fake.runs.get(run_id)
            rows = run.index() if run is not None else None
            if rows is None:
                return self._send(404, {"code": "not_found", "message": f"run '{run_id}' has no event index"})
            params = parse_qs(query)
            cursor = int(params.get("cursor", ["0"])[0])
            limit = int(params.get("limit", ["100"])[0])
            types = {t for t in params.get("types", [""])[0].split(",") if t}
            if not 1 <= limit <= 200:
                return self._send(400, {"code": "bad_request", "message": "limit must be between 1 and 200"})
            skip = [s.strip() for s in params.get("skip", [""])[0].split(",") if s.strip()]
            if fake.skip_names is None:
                skip = []
            elif any(name not in fake.skip_names for name in skip):
                message = f"skip takes a comma list of {' and '.join(fake.skip_names)}"
                return self._send(400, {"code": "bad_request", "message": message})
            offsets, offset = [], 0
            for row in rows:  # each row's cursor is the byte offset just past it, as roko's are
                offset += len(json.dumps(row)) + 1
                offsets.append(offset)
            if cursor and cursor not in offsets:
                return self._send(
                    400,
                    {
                        "code": "bad_request",
                        "message": "cursor must be a next_cursor returned by this endpoint",
                    },
                )
            events, next_cursor, passed = [], cursor, 0
            for row, end in zip(rows, offsets, strict=True):
                if end <= cursor:
                    continue
                if len(events) >= limit:
                    break
                next_cursor = end
                if _skipped(row, skip):
                    passed += 1
                    continue
                if types and row["type"] not in types:
                    continue
                events.append({"cursor": end, "type": row["type"], "source": "runner", "event": row})
            page = {
                "run_id": run_id,
                "cursor": cursor,
                "events": events,
                "next_cursor": next_cursor,
                "has_more": next_cursor < (offsets[-1] if offsets else 0),
            }
            if skip:
                page["skipped"] = [name for name in ("live_text", "heartbeats") if name in skip]
                if fake.counts_skipped:
                    page["skipped_rows"] = passed
            return self._send(200, page)

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
                            {"name": n, "description": n, "inputSchema": fake.input_schema(n)}
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

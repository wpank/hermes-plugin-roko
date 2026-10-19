"""The /api/plugins/roko routes the desktop and dashboard halves call (docs/ui-api.md)."""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import ui_api
from hermes_plugin_roko.decisions import confirmation_id, short_code
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
PREFIX = "/api/plugins/roko"


@pytest.fixture
def client(rt: Runtime) -> Iterator[TestClient]:
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix=PREFIX)
    with TestClient(app) as test_client:
        yield test_client


def get(client: TestClient, path: str) -> dict[str, Any]:
    response = client.get(PREFIX + path)
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert isinstance(body, dict) and isinstance(body["ok"], bool)
    return body


def post(client: TestClient, path: str, body: Any = None, raw: bytes | None = None) -> dict[str, Any]:
    response = client.post(PREFIX + path, content=raw if raw is not None else json.dumps(body or {}))
    assert response.status_code == 200, response.text
    result = response.json()
    assert isinstance(result, dict)
    return result


# -- overview ------------------------------------------------------------------------


def test_overview_when_nothing_ran(client: TestClient) -> None:
    body = get(client, "/overview")
    assert body["ok"] is True and body["plugin_version"]
    assert body["connection"]["reachable"] is True and body["connection"]["error"] is None
    assert body["connection"]["credential"] == "none" and body["connection"]["version"] == "0.1.0"
    assert body["counts"] == {"running": 0, "queued": 0, "waiting": 0}
    assert body["spend"]["today_usd"] == 0 and body["spend"]["max_day_usd"] == 20.0
    assert body["limits"] == {"max_run_usd": 5.0, "max_day_usd": 20.0}
    assert body["permissions"] == {"write": True}
    assert body["runs"] == [] and body["pending"] == [] and body["checked_at"]


def test_overview_with_runs_and_waiting(
    client: TestClient, rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "write the report", "max_usd": 1})["run_id"]
    fake.confirms[run_id] = [{"task_id": "T1", "attempt_key": "k:1", "question": "Good?", "title": "Report"}]
    body = get(client, "/overview")
    [row] = body["runs"]
    assert row["run_id"] == run_id and row["state"] == "running" and row["active"] is True
    assert row["kind"] == "run" and row["label"] == "write the report" and row["max_usd"] == 1.0
    assert body["counts"] == {"running": 1, "queued": 0, "waiting": 1}
    assert body["spend"]["committed_usd"] == 1.0
    [item] = body["pending"]
    assert item["code"] == short_code(confirmation_id(run_id, "T1", "k:1"))
    assert item["title"] == f"the result of task T1 (Report) in run {run_id[:8]}"
    assert item["kind"] == "confirm" and item["question"] == "Good?"


def test_overview_when_roko_is_down(rt: Runtime) -> None:
    down = Runtime(FakeContext({"url": "http://127.0.0.1:9"}))
    down.runs.add("old-run", "run", "something", state="running", max_usd=1.0)
    body = ui_api.guarded(lambda: down, ui_api.views.ui_overview)
    assert body["ok"] is True and body["connection"]["reachable"] is False
    assert body["connection"]["error"]["code"] == "unreachable"
    assert body["runs"][0]["run_id"] == "old-run" and body["runs"][0]["state"] == "running"  # last known
    assert body["pending"] == []


def test_overview_with_a_refused_key(fake: FakeRoko) -> None:
    fake.auth = True
    rt = Runtime(FakeContext({"url": fake.url}))
    body = ui_api.guarded(lambda: rt, ui_api.views.ui_overview)
    assert body["connection"]["reachable"] is True
    assert body["connection"]["error"]["code"] == "unauthorized"
    assert "hermes roko setup" in body["connection"]["error"]["hint"]


# -- one run ---------------------------------------------------------------------------


def test_run_card_and_timeline(client: TestClient, rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    fake.runs[run_id].cost_usd = 0.02
    body = get(client, f"/runs/{run_id}")
    run = body["run"]
    assert run["state"] == "succeeded" and run["cost_usd"] == 0.02 and run["gates"]["total"] == 1
    assert run["headline"].startswith("succeeded · gates 1/1 · $0.02 of $1.00")
    page = get(client, f"/runs/{run_id}/events?limit=3")
    assert page["has_more"] is True and len(page["events"]) <= 3
    seen = list(page["events"])
    while page["has_more"]:
        page = get(client, f"/runs/{run_id}/events?limit=3&cursor={page['next_cursor']}")
        seen.extend(page["events"])
    types = [event["type"] for event in seen]
    assert types[0] == "plan_set_loaded" and types[-1] == "run_completed"
    assert "efficiency_event" not in types and "agent_heartbeat" not in types
    gate = next(event for event in seen if event["type"] == "gate_result")
    assert gate["passed"] is True and gate["text"] == "T1 gate verify[0:test] passed"
    tail = get(client, f"/runs/{run_id}/events?tail=2")
    # A prompt run's own plan finishing is the run finishing: one line, not two.
    assert [event["type"] for event in tail["events"]] == ["task_completed", "run_completed"]


def test_run_card_errors_are_ok_false(client: TestClient, fake: FakeRoko) -> None:
    body = get(client, "/runs/no-such-run")
    assert body == {
        "ok": False,
        "error": {"code": "not_found", "message": "run 'no-such-run' not found", "hint": None},
    }
    assert get(client, "/runs/last")["error"]["code"] == "not_found"
    assert get(client, "/runs/x/events?limit=lots")["error"]["code"] == "invalid"


def test_events_of_a_queued_run(
    client: TestClient, rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["queued"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    body = get(client, f"/runs/{run_id}/events")
    assert body["ok"] is True and body["events"] == [] and body["has_more"] is False


def test_cancel(client: TestClient, rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    body = post(client, f"/runs/{run_id}/cancel")
    # 0.6.0 (P-1): the cancel is recorded as the person's, from a page; they gave no reason here.
    cancelled_by = body.pop("cancelled_by")
    assert body == {"ok": True, "run_id": run_id, "state": "cancelled"}
    assert (cancelled_by["by"], cancelled_by["reason"]) == ("page", None) and cancelled_by["at"]
    assert rt.runs.get(run_id)["state"] == "cancelled"


# -- plans ----------------------------------------------------------------------------


def test_plans_and_plan(client: TestClient, fake: FakeRoko) -> None:
    fake.add_plan(
        "p1",
        "Parser",
        [
            {"id": "T1", "title": "lexer", "depends_on": [], "verify": [{"command": "cargo test -p lexer"}]},
            {"id": "T2", "title": "ast", "depends_on": []},
            {"id": "T3", "title": "parser", "depends_on": ["T1", "T2"]},
        ],
    )
    listing = get(client, "/plans")
    assert listing["total"] == 1 and listing["plans"][0]["id"] == "p1"
    plan = get(client, "/plans/p1")["plan"]
    assert plan["waves"] == [["T1", "T2"], ["T3"]]
    assert plan["estimate"] == {
        "total_cost_usd": 0.0267,
        "total_duration_secs": 30,
        "confidence": "low",
        "basis": "Based on historical efficiency events",
        # 0.6.0: the estimate by rung, null without a ladder; roko's likely, worst and cap since R7
        "by_rung": None,
        "likely_usd": None,
        "worst_usd": None,
        "cap_usd": None,
        "unpriced_tasks": [],
        "start_rung": None,
    }
    assert plan["tasks"][0]["checks"] == ["cargo test -p lexer"]
    assert get(client, "/plans/nope")["error"]["code"] == "not_found"


def test_starting_a_plan_from_the_ui(client: TestClient, rt: Runtime, fake: FakeRoko) -> None:
    fake.add_plan("p1")
    fake.run_script = ["running"]
    body = post(client, "/plans/p1/run", {"max_usd": 1.5, "resume": False})
    assert body["ok"] is True and body["state"] == "running" and body["queue_position"] is None
    assert fake.tool_calls("plan_run")[-1] == {"plan_id": "p1", "resume": False, "max_usd": 1.5}
    logged = rt.runs.get(body["run_id"])
    assert logged["source"] == "ui" and logged["max_usd"] == 1.5 and logged["kind"] == "plan"


@pytest.mark.parametrize(
    ("payload", "code"),
    [
        ({}, "invalid"),
        ({"max_usd": 0}, "invalid"),
        ({"max_usd": 99}, "invalid"),
        ({"max_usd": "x"}, "invalid"),
    ],
)
def test_ui_starts_are_capped(client: TestClient, fake: FakeRoko, payload: dict[str, Any], code: str) -> None:
    fake.add_plan("p1")
    assert post(client, "/plans/p1/run", payload)["error"]["code"] == code
    assert fake.tool_calls("plan_run") == []


def test_ui_starts_respect_the_daily_limit(client: TestClient, ctx: FakeContext, fake: FakeRoko) -> None:
    fake.add_plan("p1")
    fake.run_script = ["running"]
    ctx.settings["max_day_usd"] = 3
    assert post(client, "/plans/p1/run", {"max_usd": 2})["ok"] is True
    refused = post(client, "/plans/p1/run", {"max_usd": 2})
    assert refused["error"]["code"] == "refused" and "daily limit" in refused["error"]["message"]
    assert "at most $1.00 is left today" in refused["error"]["hint"]
    assert len(fake.tool_calls("plan_run")) == 1


def test_bad_bodies(client: TestClient, fake: FakeRoko) -> None:
    fake.add_plan("p1")
    assert post(client, "/plans/p1/run", raw=b"{not json")["error"]["code"] == "invalid"
    assert post(client, "/plans/p1/run", raw=b"[1, 2]")["error"]["code"] == "invalid"
    assert post(client, "/plans/p1/run", raw=b"x" * 20_000)["error"]["code"] == "invalid"


# -- what waits on the person ---------------------------------------------------------


def test_decide_by_code(client: TestClient, rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    fake.effects.append(
        {
            "effect_id": "mail-1",
            "run_id": run_id,
            "task_id": "T1",
            "tool": "mail.send",
            "server": "mail",
            "arguments": {"to": "string (15 chars)"},
        }
    )
    [item] = get(client, "/pending")["items"]
    assert item["code"] == short_code("e_mail-1") and item["arguments"] == {"to": "string (15 chars)"}
    approvals.asked.clear()
    body = post(client, "/decide", {"code": item["code"].upper(), "approve": True, "note": "fine"})
    assert body["ok"] is True and body["outcome"] == "applied" and body["decision_id"] == "e_mail-1"
    # Named by the run Hermes started it in (its label is the prompt, "x").
    assert body["title"] == f"the held action mail.send on mail (“x”, run {run_id[:8]})"
    assert approvals.asked == []  # the click is the person's answer
    assert fake.tool_calls("effect_decide")[-1] == {"effect_id": "mail-1", "approve": True, "note": "fine"}
    stale = post(client, "/decide", {"code": item["code"], "approve": True})
    assert stale["error"]["code"] == "not_found"


def test_decide_by_decision_id(client: TestClient, fake: FakeRoko) -> None:
    fake.confirms["r9"] = [{"task_id": "T1", "attempt_key": "k:1", "question": "ok?"}]
    decision_id = confirmation_id("r9", "T1", "k:1")
    body = post(client, "/decide", {"decision_id": decision_id, "approve": False, "note": "redo it"})
    assert body["ok"] is True and body["outcome"] == "rejected" and body["approved"] is False


@pytest.mark.parametrize(
    "payload",
    [
        {"code": "abc123"},
        {"code": "abc123", "approve": "yes"},
        {"approve": True},
        {"code": 1, "approve": True},
    ],
)
def test_decide_needs_a_target_and_a_verdict(client: TestClient, payload: dict[str, Any]) -> None:
    assert post(client, "/decide", payload)["error"]["code"] == "invalid"


def test_actions_can_be_turned_off(client: TestClient, ctx: FakeContext, fake: FakeRoko) -> None:
    ctx.settings["ui_actions"] = False
    fake.add_plan("p1")
    assert get(client, "/overview")["permissions"] == {"write": False}
    for path, payload in (
        ("/plans/p1/run", {"max_usd": 1}),
        ("/decide", {"code": "abcdef", "approve": True}),
        ("/runs/r1/cancel", {}),
    ):
        assert post(client, path, payload)["error"]["code"] == "forbidden"
    assert fake.tool_calls("plan_run") == [] and fake.tool_calls("run_cancel") == []


# -- knowledge, health, insights, effects ------------------------------------------------


def test_knowledge(client: TestClient, fake: FakeRoko) -> None:
    fake.knowledge.append(
        {"id": "k1", "content": "the parser needs utf-8", "kind": "insight", "tier": "working"}
    )
    found = get(client, "/knowledge?q=parser&limit=5")
    [entry] = found["entries"]
    assert entry["id"] == "k1" and entry["score"] == 1.5 and entry["confidence"] == 0.8
    assert entry["created_at"].startswith("2026-")
    browse = get(client, "/knowledge")
    assert browse["query"] is None and browse["entries"][0]["content"] == "the parser needs utf-8"


def test_health(client: TestClient) -> None:
    body = get(client, "/health")
    names = [check["name"] for check in body["checks"]]
    # The setup card's look probes runs too (a plan that cannot exist: nothing starts, nothing is paid),
    # so the page's doctor says what `hermes roko doctor` says.
    assert "reachable" in names and "mcp" in names and "runs" in names
    assert body["status"] in ("ok", "warn", "fail")


def test_insights(client: TestClient, fake: FakeRoko) -> None:
    fake.gates_summary = {
        "verify[0:test]": {"pass_rate": 0.5, "passed_runs": 1, "failed_runs": 1, "total_runs": 2},
        "verify:0/test": {"pass_rate": 1.0, "passed_runs": 1, "failed_runs": 0, "total_runs": 1},
        "terminal": {
            "pass_rate": 0.8,
            "passed_runs": 4,
            "failed_runs": 1,
            "total_runs": 5,
            "avg_duration_ms": 30_000.0,
            "last_run": {"model": "glm-5.1", "timestamp_ms": 1791553020587},
        },
    }
    fake.scorecard = [{"model_slug": "glm-5.1", "task_count": 5, "success_rate": 1.0, "total_cost_usd": 0.05}]
    fake.cost_trend = [{"timestamp": "2026-10-09T12:43:48Z", "cost_usd": 0.01, "cumulative_cost_usd": 0.01}]
    body = get(client, "/insights?scope=workspace")
    assert body["scope"]["kind"] == "workspace" and body["scope"]["since"] == "2026-10-09T12:43:48Z"
    assert [gate["gate"] for gate in body["gates"]] == ["task verdict", "verify[0:test]"]  # one name per rung
    assert [gate["kind"] for gate in body["gates"]] == ["verdict", "check"]
    # The checks that ran: the task verdict (which counts a task no check ran on as failed) is not one.
    assert body["summary"]["checks"] == {"passed": 1, "failed": 1, "ran": 2, "pass_rate": 0.5}
    assert body["gates"][1]["total"] == 2 and body["gates"][0]["last_model"] == "glm-5.1"
    assert body["models"] == [
        {
            "model": "glm-5.1",
            "attempts": 5,
            "tasks": 5,
            "success_rate": 1.0,
            "total_cost_usd": 0.05,
            "avg_cost_usd": None,
            "total_tokens": 0,
        }
    ]
    assert body["cost_trend"] == [{"at": "2026-10-09T12:43:48Z", "cost_usd": 0.01, "cumulative_usd": 0.01}]
    assert body["problems"] == []


def test_effects_history(client: TestClient, fake: FakeRoko) -> None:
    fake.decided.append(
        {
            "effect_id": "e1",
            "run_id": "r",
            "tool": "mail.send",
            "server": "mail",
            "outcome": "applied",
            "decided_by": "hermes",
            "receipts": [{"rung": "delivered", "passed": True, "output": "250 OK"}],
        }
    )
    body = get(client, "/effects")
    assert body["waiting"] == 0 and body["decided"][0]["receipts"] == [
        {"rung": "delivered", "passed": True, "output": "250 OK"}
    ]


def test_no_route_leaks_the_key(fake: FakeRoko, monkeypatch: pytest.MonkeyPatch) -> None:
    fake.auth = True
    key = fake.add_key("hermes")
    monkeypatch.setenv("ROKO_API_KEY", key)
    rt = Runtime(FakeContext({"url": fake.url}))
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix=PREFIX)
    with TestClient(app) as test_client:
        for path in ("/overview", "/health", "/plans", "/pending", "/insights", "/knowledge?q=x"):
            text = test_client.get(PREFIX + path).text
            assert key not in text and key[:12] not in text


def test_answers_are_strict_json(rt: Runtime) -> None:
    body = ui_api.guarded(lambda: rt, lambda _: {"nan": float("nan"), "nested": [float("inf"), 1.5]})
    assert body == {"ok": True, "nan": None, "nested": [None, 1.5]}
    json.dumps(body, allow_nan=False)


def test_a_bug_is_still_a_200_with_a_reason(rt: Runtime) -> None:
    def broken(_: Runtime) -> dict[str, Any]:
        raise ValueError("boom")

    body = ui_api.guarded(lambda: rt, broken)
    assert body == {
        "ok": False,
        "error": {
            "code": "internal",
            "message": "the roko plugin failed: ValueError",
            "hint": "Hermes' log has the details",
        },
    }


# -- the file Hermes imports ---------------------------------------------------------------


def test_dashboard_plugin_api_loads_by_path_like_hermes(tmp_path: Path, fake: FakeRoko) -> None:
    """Import dashboard/plugin_api.py the way hermes_cli/web_server.py does, in a fresh process."""
    script = f"""
import importlib.util, json, sys
sys.path[:] = [p for p in sys.path if p not in ("", {str(ROOT)!r})]
from fastapi import FastAPI
from fastapi.testclient import TestClient
path = {str(ROOT / "dashboard" / "plugin_api.py")!r}
spec = importlib.util.spec_from_file_location("hermes_dashboard_plugin_roko", path)
mod = importlib.util.module_from_spec(spec)
sys.modules["hermes_dashboard_plugin_roko"] = mod
spec.loader.exec_module(mod)
assert "hermes_plugin_roko" not in sys.modules  # loaded under a private name
app = FastAPI()
app.include_router(mod.router, prefix="/api/plugins/roko")
client = TestClient(app)
print(json.dumps(client.get("/api/plugins/roko/overview").json()))
"""
    env = {
        "HERMES_HOME": str(tmp_path),
        "ROKO_URL": fake.url,
        "PATH": "/usr/bin:/bin",
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    proc = subprocess.run(
        [sys.executable, "-c", script], capture_output=True, text=True, env=env, timeout=60, cwd=tmp_path
    )
    assert proc.returncode == 0, proc.stderr
    body = json.loads(proc.stdout.strip().splitlines()[-1])
    assert body["ok"] is True and body["connection"]["url"] == fake.url and body["connection"]["reachable"]

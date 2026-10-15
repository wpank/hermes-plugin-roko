"""The plugin against a real `roko serve`: setup, doctor and every tool, at no model cost.

Opt in with the roko binary to test:

    ROKO_BIN=/path/to/roko .venv/bin/pytest tests/contract

Each test starts roko serve in a scratch git workspace with auth on and a
scratch HOME (so ~/.roko/config.toml cannot leak in), and stops it after.
Nothing here starts an agent: runs are refused (no data-model boundary) or
name a plan that does not exist.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import Approvals, FakeContext

from hermes_plugin_roko import _hermes, cli
from hermes_plugin_roko.catalog import ROKO_MCP_TOOLS
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call, make_handlers

pytestmark = pytest.mark.contract
ROKO_BIN = os.environ.get("ROKO_BIN")


@dataclass
class Serve:
    url: str
    workdir: Path
    home: Path
    process: subprocess.Popen[bytes]

    def token(self) -> str:
        return (self.workdir / ".roko" / "runtime" / "serve.token").read_text().strip()

    def stop(self) -> None:
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def start_serve(base: Path, extra_toml: str = "") -> Serve:
    if not ROKO_BIN:
        pytest.skip("set ROKO_BIN to a roko binary to run the contract tests")
    workdir, home = base / "ws", base / "home"
    home.mkdir(parents=True, exist_ok=True)
    if not workdir.exists():
        workdir.mkdir(parents=True)
        subprocess.run(["git", "init", "-q"], cwd=workdir, check=True)
        subprocess.run(
            [
                "git",
                "-c",
                "user.name=t",
                "-c",
                "user.email=t@t",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
            cwd=workdir,
            check=True,
        )
    port = _free_port()
    # `false` as the agent command: roko serve starts, and any agent it ever
    # dispatched would exit at once, so no test can spend money.
    (workdir / "roko.toml").write_text(
        f'[agent]\ncommand = "false"\n\n[serve.auth]\nenabled = true\n\n'
        f'[server]\nbind = "127.0.0.1"\nport = {port}\n\n{extra_toml}'
    )
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home),
        "USER": os.environ.get("USER", "test"),
        "RUST_LOG": "warn",
    }
    log = (base / f"serve-{port}.log").open("wb")
    process = subprocess.Popen(
        [ROKO_BIN, "serve", "--workdir", str(workdir), "--port", str(port)],
        cwd=workdir,
        env=env,
        stdout=log,
        stderr=subprocess.STDOUT,
    )
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AssertionError(
                f"roko serve exited early: {(base / f'serve-{port}.log').read_text()[-2000:]}"
            )
        try:
            if httpx.get(f"{url}/health", timeout=1).status_code == 200:
                break
        except httpx.HTTPError:
            time.sleep(0.2)
    else:
        process.kill()
        raise AssertionError("roko serve did not come up within 60 s")
    return Serve(url, workdir, home, process)


@pytest.fixture
def serve(tmp_path: Path) -> Iterator[Serve]:
    handle = start_serve(tmp_path)
    try:
        yield handle
    finally:
        handle.stop()


@pytest.fixture
def saved(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    store: dict[str, str] = {}
    env_file = tmp_path / "hermes.env"

    def save(key: str, value: str) -> Path:
        store[key] = value
        os.environ[key] = value
        env_file.write_text(f"{key}={value}\n")
        return env_file

    monkeypatch.setattr(_hermes, "save_env_value", save)
    return store


def setup_cli(rt: Runtime, *argv: str) -> int:
    import argparse

    parser = argparse.ArgumentParser()
    cli.build_parser(parser)
    return cli.make_main(rt)(parser.parse_args(list(argv)))


def test_setup_mints_a_write_key_and_doctor_names_the_boundary(
    serve: Serve, saved: dict[str, str], capsys: pytest.CaptureFixture[str]
) -> None:
    ctx = FakeContext({})
    code = setup_cli(Runtime(ctx), "setup", "--workdir", str(serve.workdir), "--mint")
    out = capsys.readouterr().out
    assert code == cli.EXIT_FAIL, out  # setup worked; doctor fails only on the boundary
    assert "key: minted 'hermes' with the write scope" in out
    assert "✓ scope: the key can start, cancel and answer runs" in out  # probed through real roko
    assert "✗ runs: roko refuses runs started from Hermes" in out
    keys = httpx.get(f"{serve.url}/api/api-keys", headers={"X-Api-Key": serve.token()}).json()["keys"]
    assert {"name": "hermes", "scope": "write"}.items() <= next(
        k for k in keys if k["name"] == "hermes"
    ).items()
    assert ctx.settings["url"] == serve.url
    assert saved["ROKO_API_KEY"].startswith("roko_") and saved["ROKO_API_KEY"] not in out


def test_tools_against_real_serve(serve: Serve, saved: dict[str, str], approvals: Approvals) -> None:
    rt = Runtime(FakeContext({}))
    assert setup_cli(rt, "setup", "--workdir", str(serve.workdir), "--mint") in (0, cli.EXIT_FAIL)
    handlers = make_handlers(rt)

    def tool(name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
        result: dict[str, Any] = json.loads(handlers[name](args or {}, task_id="t", session_id="s"))
        return result

    assert sorted(rt.client().tool_names()) == sorted(ROKO_MCP_TOOLS)
    assert tool("roko_plans")["total"] == 0
    assert tool("roko_recall", {"query": "parser"})["entries"] == []
    assert tool("roko_status", {"run_id": "no-such-run", "wait_secs": 0})["code"] == "not_found"
    refused = tool("roko_run", {"prompt": "add a test", "max_usd": 0.1})
    assert refused["code"] == "refused" and "data-model boundary" in refused["error"]
    assert (
        tool("roko_plan_run", {"plan_id": "missing", "max_usd": 0.1})["code"] == "refused"
    )  # boundary first
    assert tool("roko_cancel", {"run_id": "no-such-run"})["code"] == "not_found"
    assert tool("roko_decide", {"decision_id": "e_no-such-effect", "approve": False})["code"] == "not_found"
    assert tool("roko_status")["roko"]["version"]
    over = tool("roko_run", {"prompt": "x", "max_usd": 50})
    assert over["code"] == "invalid"  # stopped by the plugin before roko saw it


def test_with_the_boundary_opted_out_runs_are_accepted(
    tmp_path: Path, saved: dict[str, str], approvals: Approvals
) -> None:
    handle = start_serve(tmp_path, "[serve.mcp]\nallow_without_data_llm = true\n")
    try:
        rt = Runtime(FakeContext({}))
        assert setup_cli(rt, "setup", "--workdir", str(handle.workdir), "--mint") == 0
        created = httpx.post(
            f"{handle.url}/api/plans",
            json={"title": "Parser tests", "slug": "parser-tests"},
            headers={"X-Api-Key": handle.token()},
        )
        assert created.status_code == 201, created.text
        listed = call(rt, "roko_plans", {})
        assert [plan["id"] for plan in listed["plans"]] == ["parser-tests"]
        assert call(rt, "roko_plans", {"plan_id": "parser-tests"})["plan_id"] == "parser-tests"
        missing = json.loads(make_handlers(rt)["roko_plan_run"]({"plan_id": "nope", "max_usd": 0.1}))
        assert missing["code"] == "not_found"
    finally:
        handle.stop()


PLAN_TOML = """[meta]
done = 0
plan = "two-step"
status = "ready"
total = 2

[[task]]
id = "T1"
title = "write the lexer"
description = "Write the lexer."
role = "implementer"
status = "ready"
depends_on = []
files = ["src/lexer.rs"]

[[task.verify]]
phase = "test"
command = "cargo test -p lexer"

[[task]]
id = "T2"
title = "write the parser"
description = "Write the parser on top of the lexer."
role = "implementer"
status = "ready"
depends_on = ["T1"]
files = ["src/parser.rs"]
"""


def test_ui_routes_against_real_serve(serve: Serve, saved: dict[str, str], approvals: Approvals) -> None:
    """The desktop and dashboard backend, through FastAPI, against a real roko serve: nothing runs."""
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from hermes_plugin_roko import ui_api

    plan_dir = serve.workdir / "plans" / "two-step"
    plan_dir.mkdir(parents=True)
    (plan_dir / "tasks.toml").write_text(PLAN_TOML)
    (plan_dir / "plan.md").write_text("# two-step\n")
    rt = Runtime(FakeContext({}))
    assert setup_cli(rt, "setup", "--workdir", str(serve.workdir), "--mint") in (0, cli.EXIT_FAIL)
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix="/api/plugins/roko")
    client = TestClient(app)

    def get(path: str) -> dict[str, Any]:
        response = client.get("/api/plugins/roko" + path)
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body

    overview = get("/overview")
    assert overview["ok"] and overview["connection"]["reachable"] and overview["connection"]["error"] is None
    assert overview["connection"]["credential"] == "env:ROKO_API_KEY" and overview["runs"] == []
    plans = get("/plans")
    assert [plan["id"] for plan in plans["plans"]] == ["two-step"]
    plan = get("/plans/two-step")["plan"]
    assert plan["waves"] == [["T1"], ["T2"]] and plan["tasks"][0]["checks"] == ["cargo test -p lexer"]
    # With no efficiency history roko may decline to estimate: the plan still shows.
    assert plan["estimate"] is None or plan["estimate"]["total_cost_usd"] is not None
    assert get("/runs/no-such-run")["error"]["code"] == "not_found"
    assert get("/runs/no-such-run/events") == {
        "ok": True,
        "run_id": "no-such-run",
        "events": [],
        "next_cursor": 0,
        "has_more": False,
    }
    assert get("/pending") == {"ok": True, "items": []}
    assert get("/knowledge?q=parser")["entries"] == []
    assert get("/effects") == {"ok": True, "waiting": 0, "decided": []}
    insights = get("/insights")
    assert insights["ok"] and insights["gates"] == [] and insights["models"] == []
    health = get("/health")
    assert {check["name"] for check in health["checks"]} >= {"reachable", "auth", "scope", "mcp"}
    decided = client.post("/api/plugins/roko/decide", json={"decision_id": "e_nope", "approve": True}).json()
    assert decided["ok"] is False and decided["error"]["code"] == "not_found"
    refused = client.post("/api/plugins/roko/plans/two-step/run", json={"max_usd": 0.1}).json()
    assert refused["ok"] is False and "data-model boundary" in refused["error"]["message"]


def test_live_channel_and_loops_against_real_serve(
    serve: Serve, saved: dict[str, str], approvals: Approvals
) -> None:
    """The live socket follows roko's real hub (`GET /api/events`), and `/loops` reads roko's real loop
    routes: every ring answers, whatever a fresh workspace lacks goes into `problems`."""
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from hermes_plugin_roko import ui_api

    rt = Runtime(FakeContext({}))
    assert setup_cli(rt, "setup", "--workdir", str(serve.workdir), "--mint") in (0, cli.EXIT_FAIL)
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix="/api/plugins/roko")
    try:
        with TestClient(app) as client, client.websocket_connect("/api/plugins/roko/live") as socket:
            hello = socket.receive_json()
            assert hello["type"] == "hello" and hello["overview"]["connection"]["reachable"]
            deadline = time.monotonic() + 15
            while rt.live.hub_state != "open" and time.monotonic() < deadline:
                time.sleep(0.1)
            assert rt.live.hub_state == "open", rt.live.hub_state
            loops = client.get("/api/plugins/roko/loops").json()
        assert loops["ok"] and [ring["ring"] for ring in loops["rings"]] == ["L0", "L1", "L2", "L3", "L4"]
        assert loops["live"]["hub"] == "open" and loops["live"]["subscribers"] == 1
        assert all(isinstance(problem, str) for problem in loops["problems"])
    finally:
        rt.close()

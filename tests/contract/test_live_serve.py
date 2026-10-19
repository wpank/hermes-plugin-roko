"""0.7.0 against a real roko: the plugin starts, looks at, restarts and stops roko serve through serve.py.

    ROKO_BIN=/path/to/roko .venv/bin/pytest tests/contract

roko must have `roko serve --detach` and `roko serve status|stop|restart` (round roko-autostart, §A). Each
test runs in a scratch HOME and a scratch git project whose roko.toml pins a port in 6850-6899 (so a serve
never takes 6677), with the environment roko gets fenced to what it needs. roko's one API model points at a
local endpoint that records every request, and the test asserts there were none: nothing here spends.
"""

from __future__ import annotations

import json
import os
import signal
import socket
import subprocess
import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
import pytest
from conftest import FakeContext, git_checkout
from test_live_roko import ModelEndpoint

from hermes_plugin_roko import serve, views
from hermes_plugin_roko.catalog import ROKO_MCP_TOOLS
from hermes_plugin_roko.runtime import Runtime

pytestmark = pytest.mark.contract
ROKO_BIN = os.environ.get("ROKO_BIN")
PORTS = range(6850, 6900)  # this worker's ports in round roko-autostart


@dataclass
class Scratch:
    project: Path
    home: Path
    port: int
    model: ModelEndpoint
    env: dict[str, str]


def free_port() -> int:
    for port in PORTS:
        with socket.socket() as probe:
            try:
                probe.bind(("127.0.0.1", port))
            except OSError:
                continue
            return port
    raise AssertionError("no free port in 6850-6899")


@pytest.fixture
def scratch(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Scratch]:
    if not ROKO_BIN:
        pytest.skip("set ROKO_BIN to a roko binary to run the contract tests")
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    project = git_checkout(tmp_path / "pocket-synth")
    port = free_port()
    model = ModelEndpoint()
    (project / "roko.toml").write_text(
        '[agent]\ncommand = "false"\ndefault_model = "contract-mini"\n\n'
        f'[serve.auth]\nenabled = true\n\n[server]\nbind = "127.0.0.1"\nport = {port}\n\n'
        f'[providers.contract]\nkind = "openai_compat"\nbase_url = "{model.url}"\n'
        'api_key_env = "CONTRACT_API_KEY"\n\n'
        '[models.contract-mini]\nprovider = "contract"\nslug = "contract-mini"\n'
    )
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home),
        "USER": os.environ.get("USER", "test"),
        "RUST_LOG": "warn",
        "CONTRACT_API_KEY": "not-a-key",
    }
    # Fence what roko serve inherits: no key or config of this machine reaches it.
    monkeypatch.setattr(serve, "_roko_env", lambda: dict(env))
    handle = Scratch(project, home, port, model, env)
    try:
        yield handle
    finally:
        endpoint = project / ".roko" / "runtime" / "serve.json"
        if endpoint.exists():  # a serve this test started: stop it
            subprocess.run(
                [ROKO_BIN, "serve", "stop", "--workdir", str(project), "--json", "--force"],
                env=env,
                capture_output=True,
                timeout=60,
                check=False,
            )
            pid = _pid(endpoint)
            if pid is not None and _alive(pid):
                os.kill(pid, signal.SIGTERM)
        model.close()
        assert model.calls == [], f"roko called its model: {model.calls}"


def _pid(endpoint: Path) -> int | None:
    try:
        pid = json.loads(endpoint.read_text()).get("pid")
    except (OSError, ValueError):
        return None
    return pid if isinstance(pid, int) else None


def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


def wait_for(predicate: Any, timeout: float = 30.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.2)
    return bool(predicate())


def test_the_plugin_starts_checks_restarts_and_stops_a_real_roko_serve(scratch: Scratch) -> None:
    assert ROKO_BIN
    settings = {"workdir": str(scratch.project), "roko_bin": ROKO_BIN}
    rt = Runtime(FakeContext(settings))
    other = Runtime(FakeContext(settings))  # another Hermes process with the same plugin data
    try:
        found = serve.find_roko(rt)
        assert found is not None and found.detach and found.problem is None and found.git_sha, found
        assert serve.serve_state(rt).state == "stopped"  # type: ignore[union-attr]

        state = serve.ensure_serve(rt, scratch.project, wait=True, reason="manual")
        assert state is not None and state.state == "running", state
        assert state.url == f"http://127.0.0.1:{scratch.port}" and state.started_by == "hermes"
        assert state.idle_exit_minutes == 60 and state.git_sha == found.git_sha
        endpoint = json.loads((scratch.project / ".roko" / "runtime" / "serve.json").read_text())
        assert endpoint["pid"] == state.pid and endpoint["instance_id"] == state.instance_id
        assert endpoint["idle_exit_secs"] == 3600
        health = httpx.get(f"{state.url}/health", timeout=5).json()
        assert health["instance_id"] == state.instance_id and health["workdir"] == str(scratch.project)
        # The project's launch token is the credential, and /mcp answers with every tool the plugin uses.
        assert rt.settings().credential().source.startswith("launch-token:")
        assert set(ROKO_MCP_TOOLS) <= set(rt.client().tool_names())
        assert serve.serve_state(rt).state == "running"  # type: ignore[union-attr]
        connection = views.connection(rt)
        assert connection["reachable"] is True and connection["serve"]["state"] == "running"

        again = serve.ensure_serve(other, scratch.project, wait=True, reason="tool")
        assert again is not None and again.pid == state.pid and again.started_by == "hermes"

        restarted = serve.restart_serve(rt, scratch.project, wait=True)
        assert restarted is not None and restarted.state == "running", restarted
        assert restarted.pid != state.pid and restarted.instance_id != state.instance_id
        assert restarted.url == state.url  # its old port, free again
        assert wait_for(lambda: not _alive(state.pid or 0), 20)

        stopped = serve.stop_serve(rt, scratch.project)
        assert stopped is not None and stopped.state == "stopped"
        assert not (scratch.project / ".roko" / "runtime" / "serve.json").exists()
        assert wait_for(lambda: not _alive(restarted.pid or 0), 20)
    finally:
        rt.close()
        other.close()


def test_the_overview_starts_a_stopped_real_roko_serve(scratch: Scratch) -> None:
    assert ROKO_BIN
    rt = Runtime(FakeContext({"workdir": str(scratch.project), "roko_bin": ROKO_BIN}))
    try:
        first = views.ui_overview(rt)
        assert first["connection"]["serve"]["state"] in ("starting", "running")
        assert first["project"]["path"] == str(scratch.project)
        assert wait_for(lambda: views.ui_overview(rt)["connection"]["reachable"] is True, 60)
        answer = views.ui_overview(rt)
        assert answer["connection"]["serve"]["started_by"] == "hermes"
        assert answer["connection"]["url"] == f"http://127.0.0.1:{scratch.port}"
    finally:
        rt.close()


def test_a_real_roko_serve_stops_itself_when_idle(scratch: Scratch) -> None:
    assert ROKO_BIN
    started = subprocess.run(
        [ROKO_BIN, "serve", "--detach", "--json", "--workdir", str(scratch.project), "--idle-exit", "2"],
        cwd=scratch.project,
        env=scratch.env,
        capture_output=True,
        text=True,
        timeout=90,
        check=False,
    )
    answer = json.loads(started.stdout)
    assert started.returncode == 0 and answer["ok"] is True and answer["idle_exit_secs"] == 2, started.stderr
    assert wait_for(lambda: not (scratch.project / ".roko" / "runtime" / "serve.json").exists(), 30)
    assert wait_for(lambda: not _alive(int(answer["pid"])), 10)

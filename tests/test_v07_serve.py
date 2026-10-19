"""0.7.0: Hermes starts roko serve by itself, one per project (serve.py), and says what stands in the way.

A fake `roko` command (tests/fake_roko_cli.py) plays roko's §A contract: `serve --detach --json`, `serve
status|stop|restart --json`, `--idle-exit`, `roko.lock`, the identity fields on serve.json and `/health`, a
roko without `--detach`, one without `/mcp`, one whose serve fails to start, and one with runs going.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeContext, roko_calls, stop_serves

from hermes_plugin_roko import _hermes, cli, readiness, serve, ui_api, views
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.runtime import Runtime

TESTS = Path(__file__).parent


@pytest.fixture
def runtime() -> Iterator[Callable[..., Runtime]]:
    made: list[Runtime] = []

    def make(settings: dict[str, Any] | None = None) -> Runtime:
        rt = Runtime(FakeContext(settings or {}))
        made.append(rt)
        return rt

    try:
        yield make
    finally:
        for rt in made:
            rt.close()


def detaches(tmp_path: Path) -> list[list[str]]:
    return [call for call in roko_calls(tmp_path) if call[:2] == ["serve", "--detach"]]


def wait_for(predicate: Callable[[], bool], timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


# -- find_roko ---------------------------------------------------------------------------------------------


def test_no_roko_anywhere_is_not_found(runtime: Callable[..., Runtime]) -> None:
    found = serve.find_roko(runtime())
    assert found is not None and (found.path, found.problem) == (None, "not_found")


def test_roko_bin_is_found_with_its_version_commit_and_detach(
    roko_cli: Path, runtime: Callable[..., Runtime], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FAKE_ROKO_GIT", "abc1234ef")
    found = serve.find_roko(runtime())
    assert found is not None
    assert (found.path, found.source, found.version, found.git_sha, found.detach, found.problem) == (
        str(roko_cli),
        "env",
        "0.1.0",
        "abc1234ef",
        True,
        None,
    )
    # Run once per file version: a second lookup (another runtime) runs nothing.
    serve._FOUND.clear()
    before = len(roko_calls(tmp_path))
    assert serve.find_roko(runtime()) == found
    assert len(roko_calls(tmp_path)) == before


def test_a_roko_without_detach_is_too_old_and_the_setting_wins(
    roko_cli: Path, runtime: Callable[..., Runtime], monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setenv("FAKE_ROKO_NO_DETACH", "1")
    found = serve.find_roko(runtime())
    assert found is not None and (found.detach, found.problem) == (False, "too_old")
    # The roko_bin setting comes first, even when it names something that does not run.
    missing = tmp_path / "nowhere" / "roko"
    named = serve.find_roko(runtime({"roko_bin": str(missing)}))
    assert named is not None and (named.path, named.source, named.problem) == (
        str(missing),
        "setting",
        "not_found",
    )


def test_a_roko_with_detach_is_preferred_over_an_older_one(
    roko_cli: Path, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, runtime: Callable[..., Runtime]
) -> None:
    old = tmp_path / "old" / "roko"
    old.parent.mkdir()
    old.write_text(
        f'#!/bin/sh\nFAKE_ROKO_NO_DETACH=1 exec "{sys.executable}" "{TESTS / "fake_roko_cli.py"}" "$@"\n'
    )
    old.chmod(0o755)
    monkeypatch.delenv("ROKO_BIN")
    monkeypatch.setattr(serve, "_known_locations", lambda: [(str(old), "path"), (str(roko_cli), "cargo")])
    found = serve.find_roko(runtime())
    assert found is not None and (found.path, found.source, found.problem) == (str(roko_cli), "cargo", None)
    monkeypatch.setattr(serve, "_known_locations", lambda: [(str(old), "path")])
    serve._FOUND.clear()
    only_old = serve.find_roko(runtime())
    assert only_old is not None and (only_old.path, only_old.problem) == (str(old), "too_old")


# -- starting ------------------------------------------------------------------------------------------------


def test_ensure_starts_roko_serve_detached_and_the_state_names_it(
    roko_cli: Path, make_project: Callable[..., Path], runtime: Callable[..., Runtime], tmp_path: Path
) -> None:
    project = make_project("pocket-synth")
    rt = runtime({"workdir": str(project)})
    assert serve.serve_state(rt).state == "stopped"  # type: ignore[union-attr]
    state = serve.ensure_serve(rt, project, wait=True, reason="tool")
    assert state is not None and state.state == "running", state
    endpoint = json.loads((project / ".roko" / "runtime" / "serve.json").read_text())
    assert (
        state.url == endpoint["url"]
        and state.pid == endpoint["pid"]
        and state.url.startswith("http://127.0.0.1:")
    )
    assert state.started_by == "hermes" and state.idle_exit_minutes == 60 and state.name == "pocket-synth"
    assert (state.version, state.git_sha) == ("0.1.0", "fa4e000ab")
    assert state.actions == ["restart", "stop"] and state.busy is None and state.error is None
    [call] = detaches(tmp_path)
    assert call == ["serve", "--detach", "--json", "--workdir", str(project), "--idle-exit", "3600"]
    # The settings follow its serve.json, and the launch token is the credential.
    settings = rt.settings()
    assert settings.url == endpoint["url"] and settings.credential().source.startswith("launch-token:")
    # Idempotent: a second ensure finds it running and starts nothing.
    again = serve.ensure_serve(rt, project, wait=True, reason="tool")
    assert again is not None and again.state == "running" and len(detaches(tmp_path)) == 1
    # Another Hermes process (the same plugin data) sees that this plugin started it.
    other = runtime({"workdir": str(project)})
    seen = serve.serve_state(other)
    assert seen is not None and seen.started_by == "hermes" and seen.pid == state.pid


def test_without_waiting_it_says_starting_at_once_then_running(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_ROKO_START_DELAY", "1")
    project = make_project()
    rt = runtime({"workdir": str(project)})
    state = serve.ensure_serve(rt, project, wait=False, reason="app_open")
    assert state is not None and state.state == "starting" and state.since
    # Every process sees `starting` while it runs (the marker), never a second start.
    other = runtime({"workdir": str(project)})
    assert serve.serve_state(other).state == "starting"  # type: ignore[union-attr]
    assert serve.ensure_serve(other, project, wait=False, reason="overview").state == "starting"  # type: ignore[union-attr]
    assert wait_for(lambda: serve.serve_state(rt).state == "running")  # type: ignore[union-attr]


def test_one_start_however_many_ask_at_once(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_ROKO_START_DELAY", "0.5")
    project = make_project()
    runtimes = [runtime({"workdir": str(project)}) for _ in range(3)]  # three Hermes processes, say
    results: list[Any] = []
    threads = [
        threading.Thread(
            target=lambda rt=rt: results.append(serve.ensure_serve(rt, project, wait=True, reason="tool"))
        )
        for rt in runtimes
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join(60)
    assert [state.state for state in results] == ["running"] * 3
    assert len(detaches(tmp_path)) == 1 and len({state.pid for state in results}) == 1


def test_auto_start_off_starts_only_when_asked(
    roko_cli: Path, make_project: Callable[..., Path], runtime: Callable[..., Runtime], tmp_path: Path
) -> None:
    project = make_project()
    rt = runtime({"workdir": str(project), "auto_start": False, "idle_exit_minutes": 0})
    for reason in ("app_open", "overview", "tool"):
        assert serve.ensure_serve(rt, project, wait=True, reason=reason).state == "stopped"  # type: ignore[union-attr]
    assert detaches(tmp_path) == []
    state = serve.ensure_serve(rt, project, wait=True, reason="manual")
    assert state is not None and state.state == "running" and state.idle_exit_minutes is None
    assert detaches(tmp_path)[0][-1] == str(project)  # idle_exit_minutes 0: no --idle-exit


def test_a_start_that_fails_says_why_and_waits_before_trying_again(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_ROKO_START_FAIL", "1")
    project = make_project()
    rt = runtime({"workdir": str(project)})
    state = serve.ensure_serve(rt, project, wait=True, reason="tool")
    assert state is not None and state.state == "failed" and state.error is not None
    assert state.error["code"] == "start_failed" and state.since
    assert any("told not to start" in line for line in state.log_tail or [])
    assert state.actions == ["start"]
    # An automatic start waits a minute after a failure; Start does not.
    assert serve.ensure_serve(rt, project, wait=True, reason="overview").state == "failed"  # type: ignore[union-attr]
    assert len(detaches(tmp_path)) == 1
    monkeypatch.delenv("FAKE_ROKO_START_FAIL")
    started = serve.ensure_serve(rt, project, wait=True, reason="manual")
    assert started is not None and started.state == "running" and len(detaches(tmp_path)) == 2


def test_without_a_model_provider_roko_serve_does_not_start_and_says_so(
    roko_cli: Path, make_project: Callable[..., Path], runtime: Callable[..., Runtime], tmp_path: Path
) -> None:
    # No roko.toml and no provider key anywhere roko looks: roko answers `not_initialized` (round 1, §A).
    project = make_project(toml=None)
    rt = runtime({"workdir": str(project)})
    state = serve.ensure_serve(rt, project, wait=True, reason="manual")
    assert state is not None and state.state == "failed" and (state.error or {})["code"] == "not_initialized"
    assert "no LLM provider configured" in (state.error or {})["message"]
    assert "~/.roko/.env" in (state.error or {})["hint"] and state.actions == ["start"]
    assert len(detaches(tmp_path)) == 1  # roko was asked: a missing roko.toml alone stops nothing
    [problem] = readiness.problems(rt)
    assert problem["id"] == "no-model-provider" and problem["fix"]["kind"] == "command"
    assert problem["fix"]["command"] == f"hermes roko init --workdir {project}"


def test_without_roko_toml_roko_serve_runs_on_its_defaults_and_the_project_needs_setting_up(
    roko_cli: Path, make_project: Callable[..., Path], runtime: Callable[..., Runtime]
) -> None:
    # A provider key in ~/.roko/.env: roko serve starts with no roko.toml, but refuses runs started from Hermes.
    roko_home = Path(os.environ["HOME"]) / ".roko"
    roko_home.mkdir(exist_ok=True)
    (roko_home / ".env").write_text("OPENAI_API_KEY=sk-test-not-a-key\n")
    project = make_project(toml=None)
    rt = runtime({"workdir": str(project)})
    state = serve.ensure_serve(rt, project, wait=True, reason="overview")
    assert state is not None and state.state == "running", state
    problems = readiness.problems(rt)
    [problem] = [item for item in problems if item["id"] == "project-needs-setup"]
    assert problem["title"] == "roko isn't set up for runs from Hermes in proj."
    assert problem["fix"]["action"] == "setup-project" and problem["fix"]["project"] == str(project)
    assert not any(item["id"] == "workspace-refuses-chat-runs" for item in problems)


def test_no_roko_and_a_roko_too_old_are_said_and_nothing_starts(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    project = make_project()
    monkeypatch.setenv("FAKE_ROKO_NO_DETACH", "1")
    rt = runtime({"workdir": str(project)})
    state = serve.ensure_serve(rt, project, wait=True, reason="manual")
    assert state is not None and state.state == "outdated" and (state.error or {})["code"] == "too_old"
    assert "git pull && cargo install --path crates/roko-cli" in (state.error or {})["hint"]
    [problem] = readiness.problems(rt)
    assert problem["id"] == "roko-too-old" and problem["fix"]["kind"] == "command"
    monkeypatch.delenv("FAKE_ROKO_NO_DETACH")
    monkeypatch.delenv("ROKO_BIN")
    serve._FOUND.clear()
    gone = runtime({"workdir": str(project)})
    state = serve.ensure_serve(gone, project, wait=True, reason="manual")
    assert state is not None and state.state == "not_found" and state.actions == []
    [problem] = readiness.problems(gone)
    assert problem["id"] == "roko-not-found" and problem["fix"]["kind"] == "docs"
    assert detaches(tmp_path) == []


def test_a_serve_without_mcp_is_outdated(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_ROKO_NO_MCP", "1")
    project = make_project()
    rt = runtime({"workdir": str(project)})
    state = serve.ensure_serve(rt, project, wait=True, reason="manual")
    assert state is not None and state.state == "outdated" and (state.error or {})["code"] == "no_mcp"
    assert state.actions == ["restart"] and state.url
    # The setup card says so (a 404 on /mcp counts), with the restart the plugin can make.
    problem = next(item for item in readiness.problems(rt) if item["id"] == "roko-serve-outdated")
    assert problem["severity"] == "block" and problem["fix"]["action"] == "restart-serve"
    assert problem["fix"]["project"] == str(project)


def test_a_stopped_serve_the_plugin_can_start_is_an_action(
    roko_cli: Path, make_project: Callable[..., Path], runtime: Callable[..., Runtime], tmp_path: Path
) -> None:
    project = make_project()
    rt = runtime({"workdir": str(project), "auto_start": False})
    [problem] = readiness.problems(rt)
    assert problem["id"] == "roko-unreachable" and problem["title"] == "roko serve is not running for proj."
    assert problem["fix"]["kind"] == "action" and problem["fix"]["action"] == "start-serve"
    assert problem["fix"]["project"] == str(project) and detaches(tmp_path) == []


def test_idle_exit_stops_the_serve_by_itself(roko_cli: Path, make_project: Callable[..., Path]) -> None:
    project = make_project()
    started = subprocess.run(
        [str(roko_cli), "serve", "--detach", "--json", "--workdir", str(project), "--idle-exit", "1"],
        capture_output=True,
        text=True,
        check=True,
    )
    answer = json.loads(started.stdout)
    assert answer["started"] is True and answer["idle_exit_secs"] == 1
    assert wait_for(lambda: not (project / ".roko" / "runtime" / "serve.json").exists(), 15)
    registry = Path(os.environ["HOME"]) / ".roko" / "runtime" / "serves"
    assert not list(registry.glob("*.json"))  # its registry entry went with it


# -- stopping and restarting -----------------------------------------------------------------------------------


def test_stop_and_restart_go_through_roko_and_refuse_a_busy_serve(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_ROKO_ACTIVE", "2")
    project = make_project("pocket-synth")
    rt = runtime({"workdir": str(project)})
    state = serve.ensure_serve(rt, project, wait=True, reason="manual")
    assert state is not None and state.busy == {"active_runs": 2}
    with pytest.raises(RokoError) as busy:
        serve.stop_serve(rt, project)
    assert busy.value.code is Code.CONFLICT
    assert busy.value.message == "2 runs are going in pocket-synth; stopping roko serve stops them."
    assert busy.value.serve is not None and busy.value.serve["state"] == "running"
    with pytest.raises(RokoError) as busy_restart:
        serve.restart_serve(rt, project)
    assert busy_restart.value.message.endswith("restarting roko serve stops them.")
    assert not any(call[:2] == ["serve", "stop"] for call in roko_calls(tmp_path))  # nothing was sent
    old_pid = state.pid
    stopped = serve.stop_serve(rt, project, force=True)
    assert stopped is not None and stopped.state == "stopped"
    assert ["serve", "stop", "--workdir", str(project), "--json", "--timeout", "20", "--force"] in roko_calls(
        tmp_path
    )
    assert not (project / ".roko" / "runtime" / "serve.json").exists()
    monkeypatch.delenv("FAKE_ROKO_ACTIVE")
    again = serve.ensure_serve(rt, project, wait=True, reason="manual")
    assert again is not None and again.state == "running" and again.pid != old_pid
    restarting = serve.restart_serve(rt, project)
    assert restarting is not None and restarting.state == "starting"

    def restarted() -> bool:
        state = serve.serve_state(rt)
        # Its marker names the new serve once `roko serve restart` has answered.
        return (
            state is not None
            and state.state == "running"
            and state.pid != again.pid
            and (state.started_by == "hermes")
        )

    assert wait_for(restarted)
    assert ["serve", "restart", "--workdir", str(project), "--json"] in roko_calls(tmp_path)


def test_a_remote_url_starts_and_stops_nothing(
    roko_cli: Path, runtime: Callable[..., Runtime], tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ROKO_URL", "https://roko.invalid")
    rt = runtime({"workdir": str(tmp_path)})
    state = serve.ensure_serve(rt, wait=True, reason="manual")
    assert state is not None and state.state == "remote" and state.url == "https://roko.invalid"
    assert state.actions == []
    with pytest.raises(RokoError) as refused:
        serve.stop_serve(rt)
    assert refused.value.code is Code.FORBIDDEN
    assert detaches(tmp_path) == []


# -- the routes -------------------------------------------------------------------------------------------------


def web(rt: Runtime) -> Any:
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix="/api/plugins/roko")
    return TestClient(app)


def test_post_serve_ensure_answers_at_once_and_the_overview_follows(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_ROKO_START_DELAY", "0.5")
    project = make_project("pocket-synth")
    rt = runtime({"workdir": str(project)})
    with web(rt) as client:
        body = client.post("/api/plugins/roko/serve", json={"action": "ensure"}).json()
        assert body["ok"] is True and body["serve"]["state"] == "starting"
        assert body["serve"]["project"] == str(project) and body["serve"]["name"] == "pocket-synth"

        def overview() -> dict[str, Any]:
            got: dict[str, Any] = client.get(f"/api/plugins/roko/overview?project={project}").json()
            return got

        assert wait_for(lambda: overview()["connection"]["serve"]["state"] == "running")
        answer = overview()
        assert answer["connection"]["reachable"] is True
        assert answer["project"]["path"] == str(project) and answer["project"]["serve"]["state"] == "running"
        assert [row["path"] for row in answer["projects"]] == [str(project)]
        assert answer["connection"]["url"] == answer["connection"]["serve"]["url"]


def test_the_overview_starts_a_stopped_serve(
    roko_cli: Path, make_project: Callable[..., Path], runtime: Callable[..., Runtime]
) -> None:
    project = make_project()
    rt = runtime({"workdir": str(project)})
    first = views.ui_overview(rt)
    assert first["connection"]["serve"]["state"] in ("starting", "running")
    assert wait_for(lambda: views.ui_overview(rt)["connection"]["reachable"] is True)


def test_the_overview_without_any_project(runtime: Callable[..., Runtime]) -> None:
    answer = views.ui_overview(runtime())
    assert answer["project"] is None and answer["projects"] == [] and answer["connection"]["serve"] is None
    assert answer["connection"]["url"] is None
    [problem] = [item for item in answer["setup"]["problems"] if item["id"] == "roko-unreachable"]
    assert (
        problem["title"] == "No project is chosen for roko yet."
        and problem["fix"]["command"] == "hermes roko init"
    )


def test_post_serve_rules(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FAKE_ROKO_ACTIVE", "2")
    project = make_project("pocket-synth")
    rt = runtime({"workdir": str(project), "ui_actions": False})
    with web(rt) as client:

        def post(body: dict[str, Any]) -> dict[str, Any]:
            got: dict[str, Any] = client.post("/api/plugins/roko/serve", json=body).json()
            return got

        assert post({"action": "dance"})["error"]["code"] == "invalid"
        assert post({"action": "start"})["error"]["code"] == "forbidden"  # ui_actions off
        assert post({"action": "ensure"})["ok"] is True  # the app opening is always allowed
        assert wait_for(lambda: (serve.serve_state(rt) or serve.ServeState(None, "", "x")).state == "running")
        assert isinstance(rt.ctx, FakeContext)
        rt.ctx.settings["ui_actions"] = True
        busy = post({"action": "restart", "project": str(project)})
        assert busy["ok"] is False and busy["error"]["code"] == "conflict"
        assert (
            busy["error"]["message"] == "2 runs are going in pocket-synth; restarting roko serve stops them."
        )
        assert busy["serve"]["busy"] == {"active_runs": 2}
        stopped = post({"action": "stop", "force": True})
        assert stopped["ok"] is True and stopped["serve"]["state"] == "stopped"
        assert post({"action": "ensure", "project": "/no/such/project"})["error"]["code"] == "invalid"
    monkeypatch.setenv("ROKO_URL", "https://roko.invalid")
    with web(runtime({})) as client:
        remote = client.post("/api/plugins/roko/serve", json={"action": "ensure"}).json()
        assert remote["ok"] is False and remote["error"]["code"] == "forbidden"


def test_the_start_and_restart_fixes(
    roko_cli: Path, make_project: Callable[..., Path], runtime: Callable[..., Runtime]
) -> None:
    project = make_project("pocket-synth")
    rt = runtime({"workdir": str(project), "auto_start": False})
    with web(rt) as client:
        preview = client.get(f"/api/plugins/roko/setup/fix?action=start-serve&project={project}").json()
        assert preview["ok"] is True and preview["title"] == "Start roko serve for pocket-synth"
        assert preview["preview"] == "" and preview["digest"] is None and "60 minutes" in preview["summary"]
        applied = client.post(
            "/api/plugins/roko/setup/fix", json={"action": "start-serve", "project": str(project)}
        ).json()
        assert applied["ok"] is True and applied["serve"]["state"] in ("starting", "running")
        assert wait_for(lambda: (serve.serve_state(rt) or serve.ServeState(None, "", "x")).state == "running")
        note = client.get(f"/api/plugins/roko/setup/fix?action=restart-serve&project={project}").json()
        assert note["ok"] is True and note["note"] is None and "starts it again" in note["summary"]


def test_the_live_channel_says_when_a_serve_changes(
    roko_cli: Path, make_project: Callable[..., Path], runtime: Callable[..., Runtime]
) -> None:
    import asyncio

    project = make_project()
    rt = runtime({"workdir": str(project)})
    loop = asyncio.new_event_loop()
    try:
        sub = rt.live.subscribe(loop, (), project)
        rt.live.serve_changed(project)
        serve.ensure_serve(rt, project, wait=True, reason="manual")
        rt.live.serve_changed(project)
        frames = []
        while True:
            frame = loop.run_until_complete(sub.get(0.2))
            if frame is None:
                break
            frames.append(frame)
        states = [frame["serve"]["state"] for frame in frames if frame.get("type") == "serve"]
        assert states[0] == "stopped" and states[-1] == "running", frames
        rt.live.unsubscribe(sub)
    finally:
        rt.live.stop()
        loop.close()


# -- the tools ---------------------------------------------------------------------------------------------------


def test_a_tool_starts_the_projects_serve_first_and_names_the_project(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    approvals: Any,
    tmp_path: Path,
) -> None:
    from hermes_plugin_roko.tools import make_handlers

    project = make_project("pocket-synth")
    rt = runtime({"workdir": str(project)})
    handlers = make_handlers(rt)

    def tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = json.loads(handlers[name](args, task_id="t", session_id="s"))
        return result

    started = tool("roko_run", {"prompt": "add a test", "max_usd": 0.5})
    assert started.get("run_id"), started
    assert started["project"] == {"name": "pocket-synth", "path": str(project)}
    assert len(detaches(tmp_path)) == 1  # started before the run, once
    logged = rt.runs.get(started["run_id"])
    endpoint = json.loads((project / ".roko" / "runtime" / "serve.json").read_text())
    assert logged is not None and logged["project"] == str(project) and logged["url"] == endpoint["url"]
    status = tool("roko_status", {"run_id": started["run_id"], "wait_secs": 0})
    assert status["project"] == {"path": str(project), "name": "pocket-synth"}
    overview = tool("roko_status", {})
    assert overview["project"]["path"] == str(project) and overview["projects"][0]["default"] is True


def test_a_tool_says_what_stops_the_serve(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    approvals: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hermes_plugin_roko.tools import make_handlers

    monkeypatch.setenv("FAKE_ROKO_NO_DETACH", "1")
    project = make_project()
    rt = runtime({"workdir": str(project)})
    answer = json.loads(make_handlers(rt)["roko_plans"]({}, task_id="t", session_id="s"))
    assert answer["success"] is False and answer["code"] == "refused"
    assert "update" in answer["hint"] and "yourself" in answer["hint"] and approvals.asked == []
    # The setup card says it too.
    assert any(item["id"] == "roko-too-old" for item in readiness.problems(rt))


def test_a_tool_sets_roko_up_in_a_checkout_once_the_person_approves(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    approvals: Any,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    from hermes_plugin_roko.tools import make_handlers

    monkeypatch.setenv("FAKE_ROKO_PRESET", "1")
    fresh = make_project("fresh", toml=None)
    rt = runtime({})
    handlers = make_handlers(rt)
    approvals.deny()
    denied = json.loads(handlers["roko_plans"]({"project": str(fresh)}, task_id="t", session_id="s"))
    assert denied["code"] == "denied" and not (fresh / "roko.toml").exists()
    assert approvals.asked[0]["rule_key"] == f"roko:setup:{fresh}"
    assert (
        "Set up roko in" in approvals.asked[0]["message"]
        and "Nothing is committed" in approvals.asked[0]["message"]
    )
    approvals.answer = (True, None)
    listed = json.loads(handlers["roko_plans"]({"project": str(fresh)}, task_id="t", session_id="s"))
    assert listed.get("plans") == [] and listed["project"]["path"] == str(fresh), listed
    assert (fresh / "roko.toml").is_file() and "allow_without_data_llm = true" in (
        fresh / "roko.toml"
    ).read_text()
    assert subprocess.run(["git", "status", "--porcelain"], cwd=fresh, capture_output=True, text=True).stdout
    assert ["init"] in roko_calls(tmp_path)  # roko init ran; nothing was committed
    assert rt.projects.known(fresh)


def test_a_tool_asks_which_project_when_it_cannot_tell(
    runtime: Callable[..., Runtime], approvals: Any, tmp_path: Path
) -> None:
    from hermes_plugin_roko.tools import make_handlers

    answer = json.loads(make_handlers(runtime())["roko_plans"]({}, task_id="t", session_id="s"))
    assert answer["code"] == "invalid" and answer["projects"] == []
    assert "ask which one" in answer["hint"]
    unknown = json.loads(
        make_handlers(runtime())["roko_plans"]({"project": "no-such-name"}, task_id="t", session_id="s")
    )
    assert unknown["code"] == "invalid" and "roko knows no project called no-such-name" in unknown["error"]


def test_the_chat_folder_is_the_project_when_roko_knows_it(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    approvals: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hermes_plugin_roko.tools import choose_project

    default = make_project("default-one")
    chat = make_project("chat-one")
    plain = make_project("plain-one", toml=None)
    rt = runtime({"workdir": str(default)})
    monkeypatch.setattr(_hermes, "agent_cwd", lambda: chat / "src")
    (chat / "src").mkdir()
    assert choose_project(rt, {}).settings().workdir == chat  # a checkout with a roko.toml
    monkeypatch.setattr(_hermes, "agent_cwd", lambda: plain)
    assert choose_project(rt, {}).settings().workdir == default  # no roko.toml: the default project
    monkeypatch.setattr(_hermes, "agent_cwd", lambda: Path(os.environ["HERMES_HOME"]))
    assert choose_project(rt, {}).settings().workdir == default  # never Hermes' own folder
    assert choose_project(rt, {"project": "chat-one"}).settings().workdir == chat  # by name, once known
    stop_serves(default, chat)


# -- the CLI --------------------------------------------------------------------------------------------------------


def run_cli(rt: Runtime, *argv: str) -> int:
    import argparse

    parser = argparse.ArgumentParser(prog="hermes roko")
    cli.build_parser(parser)
    return cli.make_main(rt)(parser.parse_args(list(argv)))


def test_hermes_roko_serve(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    capsys: pytest.CaptureFixture[str],
) -> None:
    project = make_project("pocket-synth")
    rt = runtime({"workdir": str(project)})
    assert run_cli(rt, "serve") == cli.EXIT_ACTION
    assert "pocket-synth: stopped" in capsys.readouterr().out
    assert run_cli(rt, "serve", "start") == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "pocket-synth: running · http://127.0.0.1:" in out and "started by Hermes" in out
    assert run_cli(rt, "serve", "status", "--json") == cli.EXIT_OK
    [state] = json.loads(capsys.readouterr().out)["serves"]
    assert state["state"] == "running" and state["project"] == str(project)
    assert run_cli(rt, "serve", "stop", "--project", "pocket-synth") == cli.EXIT_OK
    assert "pocket-synth: stopped" in capsys.readouterr().out


def test_init_starts_roko_serve_the_one_way(
    roko_cli: Path, make_project: Callable[..., Path], runtime: Callable[..., Runtime], tmp_path: Path
) -> None:
    from hermes_plugin_roko.onboard import Init, Options

    project = make_project("pocket-synth")
    lines: list[str] = []
    rt = runtime({})
    Init(rt, Options(workdir=project, yes=True), out=lines.append).run()
    out = "\n".join(lines)
    assert "✓ roko serve: started at http://127.0.0.1:" in out and "stops by itself after 60 minutes" in out
    assert len(detaches(tmp_path)) == 1


def test_init_refuses_a_roko_too_old_to_start_roko_serve(
    roko_cli: Path,
    make_project: Callable[..., Path],
    runtime: Callable[..., Runtime],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from hermes_plugin_roko.onboard import Init, Options

    monkeypatch.setenv("FAKE_ROKO_NO_DETACH", "1")
    project = make_project()
    lines: list[str] = []
    code = Init(runtime({}), Options(workdir=project, yes=True), out=lines.append).run()
    out = "\n".join(lines)
    assert code == 3 and "from before `roko serve --detach`" in out and "cargo install --path" in out


def test_hermes_roko_projects(
    make_project: Callable[..., Path], runtime: Callable[..., Runtime], capsys: pytest.CaptureFixture[str]
) -> None:
    alpha, beta = make_project("alpha"), make_project("beta", toml=None)
    rt = runtime({"workdir": str(alpha)})
    assert run_cli(rt, "projects") == cli.EXIT_OK
    assert f"* alpha  {alpha}  (ready; roko serve" in capsys.readouterr().out
    assert run_cli(rt, "projects", "add", str(beta)) == cli.EXIT_OK
    out = capsys.readouterr().out
    assert f"added beta: {beta}" in out and f"  beta  {beta}  (needs setting up;" in out
    assert run_cli(rt, "projects", "default", "beta") == cli.EXIT_OK
    assert "the default project is beta" in capsys.readouterr().out
    assert run_cli(rt, "projects", "--json") == cli.EXIT_OK
    assert json.loads(capsys.readouterr().out)["default"] == str(beta)
    assert run_cli(rt, "projects", "remove", "beta") == cli.EXIT_OK
    assert rt.projects.default() == alpha
    assert run_cli(rt, "projects", "add", "/no/such/folder") == cli.EXIT_USAGE


# -- never at plugin load; the settings -----------------------------------------------------------------------


def test_registering_the_plugin_starts_nothing(
    roko_cli: Path, make_project: Callable[..., Path], tmp_path: Path
) -> None:
    import hermes_plugin_roko

    project = make_project()
    hermes_plugin_roko.register(FakeContext({"workdir": str(project)}))
    assert roko_calls(tmp_path) == [] and not (project / ".roko").exists()


def test_the_manifest_declares_the_settings() -> None:
    import yaml

    from hermes_plugin_roko.settings import load_settings

    schema = yaml.safe_load((TESTS.parent / "plugin.yaml").read_text())["config_schema"]
    assert (schema["auto_start"]["type"], schema["auto_start"]["default"]) == ("bool", True)
    assert (schema["roko_bin"]["type"], schema["roko_bin"]["default"]) == ("str", "")
    assert (schema["idle_exit_minutes"]["type"], schema["idle_exit_minutes"]["default"]) == ("int", 60)
    assert "default" not in schema["url"]  # a default would pin port 6677 for everyone
    settings = load_settings(None)
    assert (settings.auto_start, settings.roko_bin, settings.idle_exit_minutes) == (True, None, 60)
    bad = load_settings(
        lambda key, default: {"idle_exit_minutes": -5, "auto_start": "maybe"}.get(key, default)
    )
    assert bad.idle_exit_minutes == 60 and bad.auto_start is True and len(bad.problems) == 2


# -- roko's own report shapes (round 1, §A additions), as the fake plays them --------------------------------


def test_the_fake_reports_busy_unresponsive_and_failed_as_roko_does(
    roko_cli: Path, make_project: Callable[..., Path], monkeypatch: pytest.MonkeyPatch
) -> None:
    def roko(*args: str) -> tuple[int, dict[str, Any]]:
        done = subprocess.run([str(roko_cli), *args], capture_output=True, text=True, check=False)
        return done.returncode, json.loads(done.stdout)

    monkeypatch.setenv("FAKE_ROKO_ACTIVE", "2")
    project = make_project()
    code, started = roko("serve", "--detach", "--json", "--workdir", str(project))
    assert code == 0 and started["ok"] is True
    endpoint = json.loads((project / ".roko" / "runtime" / "serve.json").read_text())
    assert endpoint["args"] == {
        "bind": "127.0.0.1",
        "port_requested": None,
        "enable_terminal": False,
        "config": None,
    }
    code, refused = roko("serve", "stop", "--workdir", str(project), "--json")
    assert code == 1 and refused["ok"] is False and refused["error"]["code"] == "busy"
    assert refused["busy"] == [{"workdir": str(project), "active_runs": 2}] and refused["unresponsive"] == []
    assert refused["error"]["message"].startswith(
        f"2 runs are going in {project}; stopping roko serve stops them."
    )
    code, every = roko("serve", "stop", "--all", "--json")
    assert code == 0 and every["ok"] is True and every["busy"] and "error" not in every  # --all skips it
    code, again = roko("serve", "restart", "--workdir", str(project), "--json")
    assert (
        code == 1 and again["error"]["code"] == "busy" and again["failed"] == [] and again["restarted"] == []
    )
    code, forced = roko("serve", "stop", "--workdir", str(project), "--json", "--force")
    assert code == 0 and forced["stopped"][0]["pid"] == endpoint["pid"]
    code, gone = roko("serve", "restart", "--workdir", str(project), "--json")
    assert code == 0 and gone["not_running"] == [str(project)] and gone["restarted"] == []

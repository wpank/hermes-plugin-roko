"""0.5: is roko ready for Hermes, and the fix the plugin makes itself (readiness.py).

Every surface shows the same setup problems: the routes the pages read (`/overview`, `/health`,
`/setup/fix`), a refused run start, the tools, `hermes roko doctor | fix | setup` and `/roko doctor`.
"""

from __future__ import annotations

import argparse
import json
import re
import tomllib
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import fake_roko
import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import cli, install_state, readiness, render, ui_api
from hermes_plugin_roko.client import RokoClient
from hermes_plugin_roko.commands import run_command
from hermes_plugin_roko.diagnostics import run_doctor
from hermes_plugin_roko.errors import Code, Refusal, RokoError
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.settings import load_settings

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

PREFIX = "/api/plugins/roko"
DOLLAR = "$"

# A workspace's roko.toml as people write it: comments everywhere, a ladder, a [serve] table.
ROKO_TOML = """\
# my project's roko settings
config_version = 2

[agent]
default_model = "claude-sonnet"  # the top rung

# cheap first, Claude on top
[routing.ladder]
enabled = true
rungs = [
  { name = "cheap", model = "claude-haiku" },
  { name = "top", model = "claude-sonnet" },
]

[serve]
share_ttl_days = 7   # keep shares a week
"""


@pytest.fixture(autouse=True)
def _fresh_cache() -> Iterator[None]:
    yield
    readiness._LOOP_VERDICTS.clear()


@pytest.fixture(autouse=True)
def _loaded_is_on_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    # Other work may change the checkout while a test runs; install_state would call that a stale backend.
    pinned = install_state._fingerprint()
    monkeypatch.setattr(install_state, "_LOADED_FINGERPRINT", pinned)
    monkeypatch.setattr(install_state, "_fingerprint", lambda: pinned)


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "roko.toml").write_text(ROKO_TOML)
    return ws


@pytest.fixture
def served(workspace: Path) -> Iterator[FakeRoko]:
    """A fake roko serve whose refusal follows the workspace's roko.toml, as roko's watcher makes it."""
    server = FakeRoko(config=workspace / "roko.toml").start()
    (workspace / ".roko" / "runtime").mkdir(parents=True)
    (workspace / ".roko" / "runtime" / "serve.json").write_text(
        json.dumps({"pid": 1, "url": server.url, "workdir": str(workspace)})
    )
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def wrt(served: FakeRoko, workspace: Path) -> Iterator[Runtime]:
    runtime = Runtime(FakeContext({"url": served.url, "workdir": str(workspace)}))
    try:
        yield runtime
    finally:
        runtime.close()


def web(rt: Runtime) -> TestClient:
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix=PREFIX)
    return TestClient(app)


def get(client: TestClient, path: str) -> dict[str, Any]:
    response = client.get(PREFIX + path)
    assert response.status_code == 200, response.text
    body = response.json()
    assert isinstance(body, dict)
    return body


def post(client: TestClient, path: str, body: Any) -> dict[str, Any]:
    response = client.post(PREFIX + path, content=json.dumps(body))
    assert response.status_code == 200, response.text
    result = response.json()
    assert isinstance(result, dict)
    return result


def ids(problems: list[dict[str, Any]]) -> list[str]:
    return [problem["id"] for problem in problems]


def run_cli(rt: Runtime, *argv: str) -> int:
    parser = argparse.ArgumentParser(prog="hermes roko")
    cli.build_parser(parser)
    return cli.make_main(rt)(parser.parse_args(list(argv)))


# -- roko's words for a refusal ---------------------------------------------------------------


def test_the_client_reads_rokos_refusal_word_first(fake: FakeRoko) -> None:
    fake.boundary, fake.tool_loop = False, False
    client = RokoClient(load_settings(lambda key, default: {"url": fake.url}.get(key, default)))
    with pytest.raises(RokoError) as refused:
        client.call_tool("run_prompt", {"prompt": "x", "max_usd": 1})
    assert refused.value.code is Code.REFUSED and refused.value.refusal == Refusal.NO_DATA_BOUNDARY
    assert refused.value.refusals == ["no_data_boundary", "no_tool_loop_model"]
    assert "hermes roko fix workspace-chat-ready" in (refused.value.hint or "")
    assert refused.value.as_dict()["refusal"] == "no_data_boundary"
    fake.boundary = True  # only the model is missing: its text starts "a run", never "no ..."
    with pytest.raises(RokoError) as refused:
        client.call_tool("plan_run", {"plan_id": "nope", "max_usd": 0.01})
    assert refused.value.refusal == Refusal.NO_TOOL_LOOP_MODEL and refused.value.code is Code.REFUSED
    client.close()


def test_an_older_rokos_refusal_is_read_from_its_words(fake: FakeRoko) -> None:
    fake.boundary, fake.refusal_words = False, False
    client = RokoClient(load_settings(lambda key, default: {"url": fake.url}.get(key, default)))
    with pytest.raises(RokoError) as refused:
        client.call_tool("plan_run", {"plan_id": "nope", "max_usd": 0.01})
    assert refused.value.refusal == Refusal.NO_DATA_BOUNDARY and refused.value.refusals == [
        "no_data_boundary"
    ]
    with pytest.raises(RokoError) as missing:
        client.call_tool("run_cancel", {"run_id": "nope"})  # "no active execution": still not found
    assert missing.value.code is Code.NOT_FOUND and missing.value.refusal is None
    client.close()


def test_rokos_error_code_decides_what_is_missing(fake: FakeRoko) -> None:
    client = RokoClient(load_settings(lambda key, default: {"url": fake.url}.get(key, default)))
    # roko since 2026-10-15 names the failure: an unknown hold is `not_found`, whatever its words say.
    with pytest.raises(RokoError) as missing:
        client.call_tool(
            "confirm_answer", {"run_id": "r", "task_id": "T1", "attempt_key": "a", "approve": True}
        )
    assert missing.value.code is Code.NOT_FOUND
    fake.refusal_words = False  # an older roko: its words decide, and these do not say "not found"
    with pytest.raises(RokoError) as refused:
        client.call_tool(
            "confirm_answer", {"run_id": "r", "task_id": "T1", "attempt_key": "a", "approve": True}
        )
    assert refused.value.code is Code.REFUSED
    client.close()


def test_a_code_other_than_not_found_is_never_read_as_missing() -> None:
    from hermes_plugin_roko.client import RokoClient as Client

    class Answering(Client):
        def rpc(self, method: str, params: Any = None, *, timeout: float | None = None) -> Any:
            text = "no free slot: a plan run is active"
            return {
                "content": [{"type": "text", "text": text}],
                "structuredContent": {"error": {"code": "conflict", "message": text}},
                "isError": True,
            }

    client = Answering(load_settings(lambda key, default: default))
    with pytest.raises(RokoError) as conflict:
        client.call_tool("run_prompt", {"prompt": "x", "max_usd": 1})
    assert conflict.value.code is Code.REFUSED and "wait for the plan run" in (conflict.value.hint or "")
    client.close()


def test_a_json_rpc_error_keeps_its_refusal_data() -> None:
    from hermes_plugin_roko.client import _rpc_error

    exc = _rpc_error(
        "tools/call",
        {
            "code": -32000,
            "message": "a run from a chat needs a model",
            "data": {"refusal": "no_tool_loop_model", "refusals": ["no_tool_loop_model", "made_up"]},
        },
    )
    assert exc.code is Code.REFUSED and exc.refusal == "no_tool_loop_model"
    assert exc.refusals == ["no_tool_loop_model"]  # words the plugin does not know are dropped
    plain = _rpc_error("tools/call", {"code": -32000, "message": "boom", "data": {"refusal": "weird"}})
    assert plain.code is Code.PROTOCOL and plain.refusal is None


# -- the problems -------------------------------------------------------------------------------


def test_a_ready_workspace_has_no_problems(fake: FakeRoko, rt: Runtime) -> None:
    assert readiness.problems(rt) == []
    view = readiness.setup_view(rt)
    assert view["ok"] is True and view["problems"] == [] and view["checked_at"]


def test_the_boundary_problem_offers_the_fix_on_this_machine(served: FakeRoko, wrt: Runtime) -> None:
    [problem] = readiness.problems(wrt)
    assert problem["id"] == "workspace-refuses-chat-runs" and problem["severity"] == "block"
    assert problem["title"] == "roko refuses runs started from Hermes in this workspace."
    assert str(Path(wrt.settings().workdir or "") / "roko.toml") in problem["detail"]
    assert problem["fix"] == {
        "kind": "action",
        "label": "make ready",
        "action": "workspace-chat-ready",
        "command": "hermes roko fix workspace-chat-ready",
        "docs": "troubleshooting.md#roko-refuses-runs-started-from-hermes",
    }
    assert served.tool_calls("plan_run") == [] and served.runs == {}  # the probe started nothing


def test_the_boundary_problem_points_to_the_docs_without_a_local_workspace(
    fake: FakeRoko, rt: Runtime
) -> None:
    fake.boundary = False
    [problem] = readiness.problems(rt)
    assert problem["fix"]["kind"] == "docs" and problem["fix"]["action"] is None
    assert "allow_without_data_llm = true" in problem["detail"] and "does not know" in problem["detail"]


def test_an_older_roko_refusal_gives_the_same_problem(fake: FakeRoko, rt: Runtime) -> None:
    fake.boundary, fake.refusal_words = False, False
    assert ids(readiness.problems(rt)) == ["workspace-refuses-chat-runs"]


def test_no_tool_loop_model_from_rokos_word_and_both_at_once(fake: FakeRoko, rt: Runtime) -> None:
    fake.boundary, fake.tool_loop = False, False
    found = readiness.problems(rt)
    assert ids(found) == ["workspace-refuses-chat-runs", "no-tool-loop-model"]
    assert found[1]["title"] == "roko has no model it can use for runs started from Hermes."
    assert found[1]["fix"]["kind"] == "docs" and "~/.roko/.env" in found[1]["detail"]


def test_an_older_roko_without_api_models_is_caught_from_its_model_list(fake: FakeRoko, rt: Runtime) -> None:
    # Before roko refused it up front, such a run started and failed in milliseconds.
    fake.refusal_words = False
    fake.providers = [{"id": "claude_cli", "kind": "claude_cli", "has_api_key": False, "model_count": 1}]
    fake.models = [{"key": "claude-sonnet", "provider": "claude_cli", "supports_tools": True}]
    [problem] = readiness.problems(rt)
    assert problem["id"] == "no-tool-loop-model" and problem["severity"] == "block"
    assert problem["title"].startswith("roko lists no API model with a key")
    readiness.invalidate(rt)
    fake.providers[0] = {"id": "openai", "kind": "openai_compat", "has_api_key": False, "model_count": 1}
    fake.models = [{"key": "gpt-4o-mini", "provider": "openai", "supports_tools": True}]
    assert ids(readiness.problems(rt)) == ["no-tool-loop-model"]  # an API model, but no key


def test_the_claude_cli_counts_when_the_anthropic_api_has_its_key(fake: FakeRoko, rt: Runtime) -> None:
    # roko's failover moves a Claude CLI model to the Anthropic API when that has its key (what roko lists
    # with only ANTHROPIC_API_KEY set: the provider, with no model of its own).
    fake.refusal_words = False
    fake.providers = [
        {"id": "anthropic", "kind": "anthropic_api", "has_api_key": True, "model_count": 0},
        {"id": "claude_cli", "kind": "claude_cli", "has_api_key": False, "model_count": 1},
    ]
    fake.models = [{"key": "claude-sonnet-4-6", "provider": "claude_cli", "supports_tools": True}]
    assert readiness.problems(rt) == []
    readiness.invalidate(rt)
    fake.providers[0]["has_api_key"] = False
    assert ids(readiness.problems(rt)) == ["no-tool-loop-model"]


def test_a_roko_that_lists_no_models_is_not_guessed_about(fake: FakeRoko, rt: Runtime) -> None:
    fake.providers = fake.models = None  # 404: say nothing rather than guess
    assert readiness.problems(rt) == []


def test_unreachable_names_the_command_that_starts_roko(tmp_path: Path) -> None:
    ws = tmp_path / "my ws"
    ws.mkdir()
    rt = Runtime(FakeContext({"url": "http://127.0.0.1:9", "workdir": str(ws)}))
    [problem] = readiness.problems(rt)
    assert problem["id"] == "roko-unreachable" and problem["severity"] == "block"
    assert problem["title"] == "Hermes cannot reach roko serve at http://127.0.0.1:9."
    assert problem["fix"]["kind"] == "command"
    assert problem["fix"]["command"] == f"roko serve --workdir '{ws}' --port 9"


def test_the_unreachable_hint_names_the_workspace_the_plugin_knows(tmp_path: Path) -> None:
    ws = tmp_path / "my ws"
    ws.mkdir()
    known = RokoClient(
        load_settings(
            lambda key, default: {"url": "http://127.0.0.1:9", "workdir": str(ws)}.get(key, default)
        )
    )
    with pytest.raises(RokoError) as down:
        known.health()
    assert down.value.code is Code.UNREACHABLE
    assert f"`roko serve --workdir '{ws}' --port 9`" in (down.value.hint or "") and "WORKSPACE" not in (
        down.value.hint or ""
    )
    known.close()
    unknown = RokoClient(load_settings(lambda key, default: {"url": "http://127.0.0.1:9"}.get(key, default)))
    with pytest.raises(RokoError) as down:
        unknown.health()
    assert "roko serve --workdir WORKSPACE" in (down.value.hint or "")
    unknown.close()


def test_unreachable_points_hermes_where_roko_serve_says_it_listens(fake: FakeRoko, tmp_path: Path) -> None:
    runtime_dir = tmp_path / "ws" / ".roko" / "runtime"
    runtime_dir.mkdir(parents=True)
    (runtime_dir / "serve.json").write_text(json.dumps({"pid": 1, "url": fake.url}))
    rt = Runtime(FakeContext({"url": "http://127.0.0.1:9", "workdir": str(tmp_path / "ws")}))
    [problem] = readiness.problems(rt)
    assert fake.url in problem["detail"] and problem["fix"]["label"] == "point hermes there"
    assert problem["fix"]["command"] == f"hermes roko setup --workdir {tmp_path / 'ws'}"


def test_a_missing_or_refused_key(fake: FakeRoko, monkeypatch: pytest.MonkeyPatch) -> None:
    fake.auth = True
    rt = Runtime(FakeContext({"url": fake.url}))
    [problem] = readiness.problems(rt)
    assert problem["id"] == "roko-key-refused" and problem["title"].startswith("roko serve needs an API key")
    assert problem["fix"]["command"] == "hermes roko setup --workdir WORKSPACE --mint"
    monkeypatch.setenv("ROKO_API_KEY", "roko_" + "x" * 43)
    readiness.invalidate(rt)
    [problem] = readiness.problems(rt)
    assert problem["title"] == "roko serve refused the plugin's API key."
    assert "ROKO_API_KEY" in problem["detail"] and "roko_x" not in json.dumps(problem)


def test_a_read_only_key_is_named_and_no_run_is_probed(
    fake: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake.auth = True
    monkeypatch.setenv("ROKO_API_KEY", fake.add_key("viewer", "read"))
    rt = Runtime(FakeContext({"url": fake.url}))
    [problem] = readiness.problems(rt)
    assert problem["id"] == "key-read-only"
    assert problem["fix"]["command"] == "hermes roko setup --workdir WORKSPACE --mint --key-name hermes-write"
    assert fake.tool_calls("plan_run", probes=True) == []  # the scope answer was enough


def test_a_roko_serve_without_the_run_tools_is_too_old(
    fake: FakeRoko, rt: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(fake_roko, "MCP_TOOLS", [name for name in fake_roko.MCP_TOOLS if name != "plan_run"])
    [problem] = readiness.problems(rt)
    assert problem["id"] == "roko-serve-outdated" and problem["severity"] == "block"
    assert "plan_run" in problem["detail"] and "cannot start or follow runs" in problem["detail"]


def test_an_older_roko_serve_without_the_diff_route_is_a_warning(fake: FakeRoko, rt: Runtime) -> None:
    fake.diffs = None  # roko before 2026-10-13 answers "No API route matches"
    [problem] = readiness.problems(rt)
    assert problem["id"] == "roko-serve-outdated" and problem["severity"] == "warn"
    assert "Review and Merge do not work" in problem["detail"] and problem["detail"].startswith(
        "Runs still work"
    )
    assert readiness.setup_view(rt)["ok"] is True  # a warning does not stop anything


def test_loop_events_are_judged_from_a_run_this_roko_serve_ran(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    from hermes_plugin_roko.tools import call

    fake.uptime_secs = 3600
    run_id = call(rt, "roko_run", {"prompt": "add a test", "max_usd": 0.5})["run_id"]
    rt.runs.update(run_id, state="succeeded")
    run = fake.runs[run_id]
    run.events = [
        {"type": "agent_spawned", "plan_id": run_id, "task_id": "T1", "model": "m", "run_id": run_id},
        {"type": "run_completed", "outcome": "succeeded", "run_id": run_id},
    ]
    [problem] = readiness.problems(rt)
    assert problem["id"] == "roko-serve-outdated" and problem["severity"] == "warn"
    assert "loop dial" in problem["detail"]
    readiness._LOOP_VERDICTS.clear()
    readiness.invalidate(rt)
    run.events.insert(0, {"type": "route_decided", "plan_id": run_id, "task_id": "T1", "run_id": run_id})
    assert readiness.problems(rt) == []


def test_a_run_from_an_earlier_roko_serve_proves_nothing(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    from hermes_plugin_roko.tools import call

    run_id = call(rt, "roko_run", {"prompt": "add a test", "max_usd": 0.5})["run_id"]
    rt.runs.update(run_id, state="succeeded")
    fake.runs[run_id].events = [
        {"type": "agent_spawned", "plan_id": run_id, "task_id": "T1", "run_id": run_id}
    ]
    fake.uptime_secs = 0  # this serve started after the run
    assert readiness.problems(rt) == []


def test_the_look_is_cached_and_never_raises(
    fake: FakeRoko, rt: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    readiness.problems(rt)
    before = len(fake.requests)
    readiness.problems(rt)
    assert len(fake.requests) == before  # within CACHE_S: no new look
    readiness.invalidate(rt)
    readiness.problems(rt)
    assert len(fake.requests) > before

    def broken(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("a bug")

    monkeypatch.setattr(readiness, "_look", broken)
    readiness.invalidate(rt)
    assert readiness.problems(rt) == []  # a bug costs the card, never the page
    monkeypatch.setattr(readiness, "probe", broken)
    readiness.invalidate(rt)
    view = readiness.setup_view(rt)
    assert view["ok"] is True and view["problems"] == []


def test_a_roko_toml_edit_or_a_serve_restart_is_seen_at_once(
    served: FakeRoko, wrt: Runtime, workspace: Path
) -> None:
    assert ids(readiness.problems(wrt)) == ["workspace-refuses-chat-runs"]
    # The person allows runs by hand: the next look asks roko again, within CACHE_S.
    (workspace / "roko.toml").write_text(ROKO_TOML + "\n[serve.mcp]\nallow_without_data_llm = true\n")
    assert readiness.problems(wrt) == []
    before = len(served.requests)
    assert readiness.problems(wrt) == [] and len(served.requests) == before  # cached again
    endpoint = workspace / ".roko" / "runtime" / "serve.json"
    endpoint.write_text(json.dumps({"pid": 2, "url": served.url, "workdir": str(workspace)}))  # restarted
    readiness.problems(wrt)
    assert len(served.requests) > before


def test_a_look_just_after_an_edit_is_taken_again_soon(
    served: FakeRoko, wrt: Runtime, workspace: Path
) -> None:
    import os

    # roko serve may still answer from the old roko.toml for a moment after an edit.
    (workspace / "roko.toml").write_text(ROKO_TOML + "\n")
    readiness.problems(wrt)
    assert readiness._CACHE[wrt].lifetime <= readiness.RELOAD_S
    old = os.stat(workspace / "roko.toml").st_mtime - 60
    os.utime(workspace / "roko.toml", (old, old))
    readiness.problems(wrt)
    assert readiness._CACHE[wrt].lifetime == readiness.CACHE_S


def test_install_problems_come_first(fake: FakeRoko, rt: Runtime, monkeypatch: pytest.MonkeyPatch) -> None:
    fake.diffs = None
    restart = {
        "id": "restart-hermes",
        "severity": "block",
        "title": "Hermes runs an older roko plugin than the one installed.",
        "detail": "Quit Hermes and open it again.",
        "fix": {
            "kind": "restart-hermes",
            "label": "restart hermes",
            "action": None,
            "command": None,
            "docs": None,
        },
    }
    monkeypatch.setattr(readiness, "install_problems", lambda install=None: [restart])
    view = readiness.setup_view(rt)
    assert ids(view["problems"]) == ["restart-hermes", "roko-serve-outdated"] and view["ok"] is False


def test_problem_words_are_safe_for_hermes(fake: FakeRoko, tmp_path: Path) -> None:
    """No "failed"/"error" token (Hermes counts a tool result with one as failed), nothing the install
    scanner blocks, and no key."""
    settings = load_settings(
        lambda key, default: {"url": fake.url, "workdir": str(tmp_path)}.get(key, default)
    )
    words = [
        readiness._unreachable(settings, RokoError(Code.UNREACHABLE, "x")),
        readiness._unreachable(settings, RokoError(Code.PROTOCOL, "x")),
        readiness._key_refused(settings, True),
        readiness._key_refused(settings, False),
        readiness._read_only(settings),
        readiness._refuses_chat_runs(settings),
        readiness._refuses_chat_runs(
            settings, "a run needs a working boundary, and [agent.data_llm] model `x`"
        ),
        readiness._no_tool_loop_model(roko_said=True),
        readiness._no_tool_loop_model(roko_said=False),
    ]
    for problem in words:
        text = json.dumps(problem)
        assert not re.search(r"\b(failed|error)\b", text, re.IGNORECASE), text
        # The install scanner's two text checks (kept off one line here, like the plugin's own files).
        assert not re.search(r"\bhost\b.*" + re.escape(DOLLAR), text), text
        assert not re.search(r"env\s*\|", text), text
        assert set(problem) == {"id", "severity", "title", "detail", "fix"}
        assert set(problem["fix"]) == {"kind", "label", "action", "command", "docs"}
        assert problem["title"].endswith(".") and problem["fix"]["label"] == problem["fix"]["label"].lower()


def test_every_problem_points_at_a_heading_that_exists() -> None:
    docs = Path(__file__).parents[1] / "docs"

    def headings(name: str) -> set[str]:
        # GitHub's anchors: lower case, punctuation dropped, spaces turned into hyphens.
        return {
            re.sub(r"[^\w\- ]", "", line.lstrip("#").strip().lower()).replace(" ", "-")
            for line in (docs / name).read_text().splitlines()
            if line.startswith("#")
        }

    for target in readiness.DOCS.values():
        name, anchor = target.split("#")
        assert anchor in headings(name), target


# -- the routes ---------------------------------------------------------------------------------


def test_overview_and_health_carry_setup(served: FakeRoko, wrt: Runtime) -> None:
    with web(wrt) as client:
        overview = get(client, "/overview")
        assert overview["setup"]["ok"] is False
        assert ids(overview["setup"]["problems"]) == ["workspace-refuses-chat-runs"]
        health = get(client, "/health")
        assert ids(health["setup"]["problems"]) == ["workspace-refuses-chat-runs"]
        assert "install" in health and isinstance(health["install"], (dict, type(None)))
        [runs] = [check for check in health["checks"] if check["name"] == "runs"]
        assert runs["status"] == "fail" and runs["problem"]["id"] == "workspace-refuses-chat-runs"


def test_preview_then_apply_through_the_routes(served: FakeRoko, wrt: Runtime, workspace: Path) -> None:
    with web(wrt) as client:
        preview = get(client, "/setup/fix?action=workspace-chat-ready")
        # The default lets runs from Hermes run as terminal runs do: one line, no model to depend on.
        assert preview["ok"] is True and preview["variant"] == "local"
        assert preview["path"] == str((workspace / "roko.toml").resolve())
        assert "+[serve.mcp]" in preview["preview"] and "+allow_without_data_llm = true" in preview["preview"]
        assert "Only runs started from a chat change." in preview["summary"]
        assert "no restart" in preview["note"] and "Commit" not in preview["note"]  # not a git checkout
        assert [(v["id"], v["recommended"]) for v in preview["variants"]] == [
            ("local", True),
            ("boundary", False),
        ]
        assert (workspace / "roko.toml").read_text() == ROKO_TOML  # a preview changes nothing
        applied = post(client, "/setup/fix", {"action": "workspace-chat-ready", "digest": preview["digest"]})
        assert applied["ok"] is True and applied["done"] is True and applied["ready"] is True
        assert applied["next"] is None and "roko accepts runs started from Hermes now." in applied["message"]
        backup = Path(applied["backup"])
        assert backup.parent == workspace / ".roko" / "backups" and backup.read_text() == ROKO_TOML
        assert get(client, "/overview")["setup"] == {
            "ok": True,
            "problems": [],
            "checked_at": get(client, "/overview")["setup"]["checked_at"],
        }
    text = (workspace / "roko.toml").read_text()
    assert text.startswith(ROKO_TOML)  # every comment and line kept; the table added at the end
    data = tomllib.loads(text)
    assert data["serve"]["mcp"] == {"allow_without_data_llm": True} and data["serve"]["share_ttl_days"] == 7
    assert "# Added by hermes roko fix workspace-chat-ready on" in text


def test_the_boundary_variant_through_the_routes(served: FakeRoko, wrt: Runtime, workspace: Path) -> None:
    with web(wrt) as client:
        preview = get(client, "/setup/fix?action=workspace-chat-ready&variant=boundary")
        assert preview["variant"] == "boundary"
        assert '+model = "claude-haiku"' in preview["preview"] and "+[agent.data_llm]" in preview["preview"]
        assert "on anthropic, its maker's own API" in preview["summary"]
        assert "runs started in a terminal too" in preview["summary"]
        applied = post(client, "/setup/fix", {"action": "workspace-chat-ready", "variant": "boundary"})
        assert applied["ready"] is True and applied["next"] is None
    assert tomllib.loads((workspace / "roko.toml").read_text())["agent"]["data_llm"] == {
        "model": "claude-haiku"
    }


def test_the_fix_is_refused_off_this_machine_or_for_another_serve(
    fake: FakeRoko, workspace: Path, tmp_path: Path
) -> None:
    remote = Runtime(FakeContext({"url": "https://roko.example.com", "workdir": str(workspace)}))
    with web(remote) as client:
        body = get(client, "/setup/fix?action=workspace-chat-ready")
    assert body["ok"] is False and body["error"]["code"] == "forbidden"
    assert "is not on this machine" in body["error"]["message"]
    runtime_dir = workspace / ".roko" / "runtime"
    runtime_dir.mkdir(parents=True)
    (runtime_dir / "serve.json").write_text(json.dumps({"pid": 1, "url": "http://127.0.0.1:6999"}))
    other = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    with web(other) as client:
        body = get(client, "/setup/fix?action=workspace-chat-ready")
    assert body["ok"] is False and "listens on http://127.0.0.1:6999" in body["error"]["message"]
    empty = tmp_path / "empty"
    empty.mkdir()
    bare = Runtime(FakeContext({"url": fake.url, "workdir": str(empty)}))
    with web(bare) as client:
        body = get(client, "/setup/fix?action=workspace-chat-ready")
    assert body["ok"] is False and "has no roko.toml" in body["error"]["message"]
    assert (workspace / "roko.toml").read_text() == ROKO_TOML


def test_apply_needs_ui_actions_and_names_a_known_fix(
    served: FakeRoko, wrt: Runtime, workspace: Path
) -> None:
    with web(wrt) as client:
        unknown = post(client, "/setup/fix", {"action": "rm-rf"})
        assert unknown["ok"] is False and unknown["error"]["code"] == "invalid"
        bad = get(client, "/setup/fix?action=workspace-chat-ready&variant=yolo")
        assert bad["ok"] is False and bad["error"]["code"] == "invalid"
        assert isinstance(wrt.ctx, FakeContext)
        wrt.ctx.settings["ui_actions"] = False
        assert get(client, "/setup/fix?action=workspace-chat-ready")["ok"] is True  # reading is fine
        refused = post(client, "/setup/fix", {"action": "workspace-chat-ready"})
        assert refused["ok"] is False and refused["error"]["code"] == "forbidden"
    assert (workspace / "roko.toml").read_text() == ROKO_TOML


def test_a_stale_preview_is_not_applied(served: FakeRoko, wrt: Runtime, workspace: Path) -> None:
    preview = readiness.fix_preview(wrt, "workspace-chat-ready")
    (workspace / "roko.toml").write_text(ROKO_TOML + "\n[gates]\n")
    with pytest.raises(RokoError) as stale:
        readiness.apply_fix(wrt, "workspace-chat-ready", None, preview["digest"])
    assert stale.value.code is Code.CONFLICT and "changed since the preview" in stale.value.message
    assert "data_llm" not in (workspace / "roko.toml").read_text()


def test_a_change_roko_rejects_is_put_back(served: FakeRoko, wrt: Runtime, workspace: Path) -> None:
    served.reload_status = 400
    with pytest.raises(RokoError) as rejected:
        readiness.apply_fix(wrt, "workspace-chat-ready", "local")
    assert rejected.value.code is Code.INVALID and "the old one is back" in rejected.value.message
    assert (workspace / "roko.toml").read_text() == ROKO_TOML


def test_without_the_reload_route_roko_serves_watcher_is_enough(
    served: FakeRoko, wrt: Runtime, workspace: Path
) -> None:
    served.reload_status = 403  # a write key may not reload; roko serve re-reads roko.toml every 2 s anyway
    result = readiness.apply_fix(wrt, "workspace-chat-ready", "boundary")
    assert result["next"] is None and result["done"] is True


def test_a_roko_serve_that_does_not_read_the_file_is_named(
    fake: FakeRoko, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake.boundary = False  # this roko serve's refusal does not follow the workspace's roko.toml
    monkeypatch.setattr(readiness, "SETTLE_S", 0.3)
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    result = readiness.apply_fix(rt, "workspace-chat-ready", "local")
    assert result["done"] is True and result["ready"] is False
    assert result["message"].endswith("roko serve still refuses runs started from Hermes.")
    assert result["next"].startswith(f"check that roko serve at {fake.url} runs in {workspace.resolve()}")
    assert "roko config validate" in result["next"] and "restart" not in result["next"]
    again = readiness.fix_preview(rt, "workspace-chat-ready")
    assert again["preview"] == "" and again["variants"] == []
    assert "already allows runs started from Hermes" in again["summary"] and "check that" in again["note"]
    redo = readiness.apply_fix(rt, "workspace-chat-ready")
    assert redo["done"] is False and redo["next"].startswith("check that roko serve")


def test_nothing_changes_when_roko_already_accepts_runs(
    served: FakeRoko, wrt: Runtime, workspace: Path
) -> None:
    served.boundary, served.config = True, None
    preview = readiness.fix_preview(wrt, "workspace-chat-ready")
    assert preview["preview"] == "" and "nothing needs changing" in preview["summary"]
    result = readiness.apply_fix(wrt, "workspace-chat-ready")
    assert result["done"] is False and result["ready"] is True and result["backup"] is None
    assert (
        result["message"]
        == f"Nothing to change in {(workspace / 'roko.toml').resolve()}. roko accepts runs started from Hermes now."
    )
    assert (workspace / "roko.toml").read_text() == ROKO_TOML


def test_the_fix_does_not_claim_runs_work_when_only_the_model_is_missing(
    served: FakeRoko, wrt: Runtime, workspace: Path
) -> None:
    served.boundary, served.config, served.tool_loop = True, None, False
    preview = readiness.fix_preview(wrt, "workspace-chat-ready")
    assert preview["preview"] == "" and "not what stops runs" in preview["summary"]
    result = readiness.apply_fix(wrt, "workspace-chat-ready")
    assert result["done"] is False and result["ready"] is False
    assert "roko still refuses them" in result["message"]
    assert result["next"].startswith("give roko a model for runs started from Hermes")


def test_a_data_model_roko_cannot_call_is_replaced(served: FakeRoko, wrt: Runtime, workspace: Path) -> None:
    # roko since 2026-10-15 refuses a boundary whose model it cannot call, and the local switch does not
    # help then: roko uses [agent.data_llm] whenever it is set.
    broken = ROKO_TOML + '\n[agent.data_llm]\nmodel = "claude-sonnet"  # runs on the Claude CLI\n'
    (workspace / "roko.toml").write_text(broken)
    [problem] = readiness.problems(wrt)
    assert problem["id"] == "workspace-refuses-chat-runs"
    assert "names a data model ([agent.data_llm]) roko cannot call" in problem["detail"]
    preview = readiness.fix_preview(wrt, "workspace-chat-ready")
    assert preview["variant"] == "boundary"
    assert (
        '-model = "claude-sonnet"' in preview["preview"] and '+model = "claude-haiku"' in preview["preview"]
    )
    assert [(v["id"], v["available"]) for v in preview["variants"]] == [("boundary", True), ("local", False)]
    with pytest.raises(RokoError) as useless:
        readiness.fix_preview(wrt, "workspace-chat-ready", "local")
    assert useless.value.code is Code.INVALID and "changes nothing" in useless.value.message
    result = readiness.apply_fix(wrt, "workspace-chat-ready", None, preview["digest"])
    assert result["ready"] is True
    text = (workspace / "roko.toml").read_text()
    assert text == broken.replace(
        'model = "claude-sonnet"  # runs on the Claude CLI',
        'model = "claude-haiku"  # runs on the Claude CLI',
    )  # in place, its comment kept


def test_a_tracked_roko_toml_is_to_be_committed(served: FakeRoko, wrt: Runtime, workspace: Path) -> None:
    import subprocess

    def git(*args: str) -> None:
        subprocess.run(
            ["git", "-C", str(workspace), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *args],
            check=True,
            capture_output=True,
        )

    git("init", "-q")
    git("add", "roko.toml")
    git("commit", "-qm", "roko.toml")
    preview = readiness.fix_preview(wrt, "workspace-chat-ready")
    assert "Commit roko.toml afterwards" in preview["note"]
    result = readiness.apply_fix(wrt, "workspace-chat-ready", None, preview["digest"])
    assert result["ready"] is True and result["next"].startswith("commit roko.toml before you merge a run")
    assert (
        f'git -C {workspace.resolve()} commit -m "roko: accept runs started from Hermes" -- roko.toml'
        in (result["next"])
    )


def test_without_an_api_model_the_fix_runs_without_the_boundary(served: FakeRoko, wrt: Runtime) -> None:
    served.providers = [{"id": "claude_cli", "kind": "claude_cli", "has_api_key": False, "model_count": 1}]
    served.models = [{"key": "claude-sonnet", "provider": "claude_cli", "supports_tools": True}]
    preview = readiness.fix_preview(wrt, "workspace-chat-ready")
    assert preview["variant"] == "local" and preview["variants"][1] == {
        "id": "boundary",
        "label": "screen with an API model",
        "recommended": False,
        "available": False,
        "why": "no model roko lists runs on an API provider whose key is set",
    }
    with pytest.raises(RokoError) as none:
        readiness.fix_preview(wrt, "workspace-chat-ready", "boundary")
    assert "no API model with a key" in none.value.message


def test_the_boundary_model_is_a_dependable_cheap_one(
    served: FakeRoko, wrt: Runtime, workspace: Path
) -> None:
    (workspace / "roko.toml").write_text("[agent]\n")
    served.providers = [
        {"id": "cerebras", "kind": "cerebras_api", "has_api_key": True},
        {
            "id": "openai",
            "kind": "openai_compat",
            "has_api_key": True,
            "base_url": "https://api.openai.com/v1",
        },
        {"id": "pplx", "kind": "perplexity_api", "has_api_key": True},
        {"id": "anthropic", "kind": "anthropic_api", "has_api_key": False},
    ]
    served.models = [
        {"key": "gptoss", "provider": "cerebras", "cost_input_per_m": 0.25, "cost_output_per_m": 0.69},
        {"key": "gpt-4o", "provider": "openai", "cost_input_per_m": 2.5, "cost_output_per_m": 10.0},
        {"key": "gpt-4o-mini", "provider": "openai", "cost_input_per_m": 0.15, "cost_output_per_m": 0.6},
        {"key": "sonar", "provider": "pplx", "cost_input_per_m": 0.01, "cost_output_per_m": 0.01},
        {"key": "haiku", "provider": "anthropic", "cost_input_per_m": 0.01, "cost_output_per_m": 0.01},
    ]
    preview = readiness.fix_preview(wrt, "workspace-chat-ready", "boundary")
    # Cerebras is cheaper, but a screening call that does not go through withholds what the agent fetched.
    assert '+model = "gpt-4o-mini"' in preview["preview"]
    assert (
        "on openai, its maker's own API" in preview["summary"] and "$0.75 per million" in preview["summary"]
    )
    served.providers[1]["health"] = {"state": "unhealthy", "consecutive_failures": 3}
    preview = readiness.fix_preview(wrt, "workspace-chat-ready", "boundary")
    assert '+model = "gptoss"' in preview["preview"]  # roko holds openai off for now


def test_a_refused_start_names_its_problem(served: FakeRoko, wrt: Runtime) -> None:
    served.add_plan("p1")
    with web(wrt) as client:
        for path, body in (
            ("/runs", {"prompt": "add a test", "max_usd": 0.5}),
            ("/plans/p1/run", {"max_usd": 1}),
        ):
            refused = post(client, path, body)
            assert refused["ok"] is False and refused["error"]["code"] == "refused"
            assert refused["problem"]["id"] == "workspace-refuses-chat-runs"
            assert refused["problem"]["fix"]["action"] == "workspace-chat-ready"
        assert ids(get(client, "/overview")["setup"]["problems"]) == ["workspace-refuses-chat-runs"]
        other = post(client, "/runs", {"prompt": ""})  # not a setup problem: no card
        assert other["ok"] is False and "problem" not in other


def test_a_tool_refusal_tells_the_model_how_the_person_fixes_it(
    fake: FakeRoko, call: Any, approvals: Approvals
) -> None:
    fake.boundary = False
    result = call("roko_run", {"prompt": "add a test", "max_usd": 0.5})
    assert result["success"] is False and result["code"] == "refused"
    assert (
        result["refusal"] == "no_data_boundary" and "hermes roko fix workspace-chat-ready" in result["hint"]
    )


def test_the_status_tool_and_overview_text_show_setup_problems(
    fake: FakeRoko, rt: Runtime, call: Any
) -> None:
    fake.boundary = False
    status = call("roko_status")
    assert ids(status["setup_problems"]) == ["workspace-refuses-chat-runs"]
    assert not re.search(r"\b(failed|error)\b", json.dumps(status)[:500])
    text = run_command(rt, "status")
    assert "✗ roko refuses runs started from Hermes in this workspace." in text


# -- the CLI ------------------------------------------------------------------------------------


def test_doctor_says_the_problem_and_its_fix(
    capsys: pytest.CaptureFixture[str], served: FakeRoko, wrt: Runtime
) -> None:
    assert run_cli(wrt, "doctor") == cli.EXIT_FAIL
    out = capsys.readouterr().out
    assert "✗ runs: roko refuses runs started from Hermes in this workspace." in out
    assert (
        "neither sets roko's data-model boundary" in out
        and "→ make ready: hermes roko fix workspace-chat-ready" in out
    )
    assert run_cli(wrt, "doctor", "--json") == cli.EXIT_FAIL
    body = json.loads(capsys.readouterr().out)
    assert ids(body["problems"]) == ["workspace-refuses-chat-runs"]
    [runs] = [check for check in body["checks"] if check["name"] == "runs"]
    assert runs["problem"]["id"] == "workspace-refuses-chat-runs"


def test_doctor_names_hermes_approvals_off_and_the_learning_guard(
    capsys: pytest.CaptureFixture[str], fake: FakeRoko, rt: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hermes_plugin_roko import _hermes

    monkeypatch.setattr(_hermes, "approval_mode", lambda: "off")
    monkeypatch.setattr(_hermes, "hooks_gated_per_call", lambda: True)
    report = run_doctor(rt)
    assert "approvals-off" in ids(report.problems)
    [approvals] = [check for check in report.checks if check.name == "approvals"]
    assert approvals.status == "warn" and approvals.problem and approvals.problem["id"] == "approvals-off"
    [guard] = [check for check in report.checks if check.name == "learning guard"]
    assert guard.status == "ok" and guard.detail.startswith("off (opt-in)")  # the guard is opt-in
    rt.ctx.settings["learning_guard"] = True
    [guard] = [check for check in run_doctor(rt).checks if check.name == "learning guard"]
    assert guard.status == "ok" and guard.detail.startswith("on:")
    offline = run_doctor(rt, offline=True)
    assert "approvals-off" in ids(offline.problems)


def test_doctor_in_chat_says_the_same_words(served: FakeRoko, wrt: Runtime) -> None:
    reply = run_command(wrt, "doctor")
    assert render.doctor(run_doctor(wrt)) == reply
    assert "→ make ready: hermes roko fix workspace-chat-ready" in reply


def test_fix_lists_then_previews_then_asks(
    capsys: pytest.CaptureFixture[str], served: FakeRoko, wrt: Runtime, workspace: Path
) -> None:
    assert run_cli(wrt, "fix") == cli.EXIT_ACTION
    listed = capsys.readouterr().out
    assert listed.startswith("✗ roko refuses runs started from Hermes in this workspace.")
    assert "→ make ready: hermes roko fix workspace-chat-ready" in listed
    assert run_cli(wrt, "fix", "workspace-chat-ready", "--dry-run") == cli.EXIT_OK
    dry = capsys.readouterr().out
    assert "+allow_without_data_llm = true" in dry
    assert "(or screen with claude-haiku: hermes roko fix workspace-chat-ready --variant boundary)" in dry
    # No terminal to ask on: print the change and the command that makes it.
    assert run_cli(wrt, "fix", "workspace-chat-ready") == cli.EXIT_ACTION
    asked = capsys.readouterr().out
    assert "Make this change with: hermes roko fix workspace-chat-ready --variant local --yes" in asked
    assert (workspace / "roko.toml").read_text() == ROKO_TOML
    assert run_cli(wrt, "fix", "workspace-chat-ready", "--variant", "boundary", "--yes") == cli.EXIT_OK
    done = capsys.readouterr().out
    assert "roko accepts runs started from Hermes now." in done and "the old file is kept as" in done
    assert (
        tomllib.loads((workspace / "roko.toml").read_text())["agent"]["data_llm"]["model"] == "claude-haiku"
    )
    assert run_cli(wrt, "fix") == cli.EXIT_OK
    assert "Nothing stands between Hermes and roko" in capsys.readouterr().out


def test_fix_asks_on_a_terminal(
    capsys: pytest.CaptureFixture[str],
    served: FakeRoko,
    wrt: Runtime,
    workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(cli, "_confirm", lambda question: False)
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    assert run_cli(wrt, "fix", "workspace-chat-ready") == cli.EXIT_ACTION
    assert "Nothing was changed." in capsys.readouterr().out
    monkeypatch.setattr(cli, "_confirm", lambda question: True)
    assert run_cli(wrt, "fix", "workspace-chat-ready") == cli.EXIT_OK
    assert "allow_without_data_llm = true" in (workspace / "roko.toml").read_text()


def test_setup_ends_by_offering_the_fix(
    capsys: pytest.CaptureFixture[str], served: FakeRoko, workspace: Path
) -> None:
    ctx = FakeContext({})
    rt = Runtime(ctx)
    assert run_cli(rt, "setup", "--workdir", str(workspace)) == cli.EXIT_FAIL  # not a terminal: shown only
    out = capsys.readouterr().out
    assert "Fix: roko refuses runs started from Hermes in this workspace." in out
    assert "+allow_without_data_llm = true" in out and "Make this change with:" in out
    assert (workspace / "roko.toml").read_text() == ROKO_TOML
    assert run_cli(rt, "setup", "--workdir", str(workspace), "--yes") == cli.EXIT_OK
    out = capsys.readouterr().out
    assert "roko accepts runs started from Hermes now." in out and "✓ runs: roko accepts runs" in out
    assert tomllib.loads((workspace / "roko.toml").read_text())["serve"]["mcp"]["allow_without_data_llm"]


def test_setup_checks_again_after_a_change_that_leaves_a_problem(
    capsys: pytest.CaptureFixture[str], served: FakeRoko, workspace: Path
) -> None:
    served.tool_loop = False  # the boundary is fixable here; the missing model is not
    rt = Runtime(FakeContext({}))
    assert run_cli(rt, "setup", "--workdir", str(workspace), "--yes") == cli.EXIT_FAIL
    out = capsys.readouterr().out
    assert "still refuses them" in out and "Next: give roko a model for runs started from Hermes" in out
    first, again = out.split("roko still refuses them.", 1)
    assert "neither sets roko's data-model boundary" in first and "neither sets" not in again
    assert "✗ runs: roko has no model it can use for runs started from Hermes." in again


def test_status_text_shows_an_interrupted_run_and_kept_work() -> None:
    run = {
        "run_id": "f68b58a8-12a8-43d0-aa4c-79550ec28c46",
        "state": "interrupted",
        "interrupted": {
            "reason": "roko stopped while this run was going (a restart or a crash).",
            "at": None,
        },
        "work": {
            "kind": "partial",
            "parts": [
                {"trust": "verified", "delivered": True, "branch": "roko/batch/f68b58a8", "commit": "a" * 12},
                {
                    "trust": "unverified",
                    "delivered": False,
                    "branch": "roko/plan/two-step",
                    "commit": "b" * 12,
                    "base": "c" * 12,
                    "diffstat": "1 file changed, 3 insertions(+)",
                },
            ],
        },
    }
    text = render.card(run)
    assert text.startswith("↯ roko run f68b58a8 · interrupted")
    assert (
        "Interrupted: roko stopped while this run was going (a restart or a crash). What passed is kept."
        in text
    )
    assert f"Kept, unverified (no check ran on it): roko/plan/two-step @ {'b' * 12}" in text
    assert f"look: git diff {'c' * 12}..{'b' * 12}" in text and "roko/batch/f68b58a8 @" not in text
    assert render.glyph("interrupted") == "↯"


def test_setup_refuses_another_projects_serve_that_a_stale_file_names(
    capsys: pytest.CaptureFixture[str], served: FakeRoko, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import time

    endpoint = workspace / ".roko" / "runtime" / "serve.json"
    # The serve that wrote this file stopped an hour ago; the one answering at its address started since.
    endpoint.write_text(json.dumps({"pid": 1, "url": served.url, "started_at": time.time() - 3600}))
    ctx = FakeContext({})
    assert run_cli(Runtime(ctx), "setup", "--workdir", str(workspace)) == cli.EXIT_UNREACHABLE
    err = capsys.readouterr().err
    assert f"is the roko serve of another project, not of {workspace.resolve()}" in err
    assert "serve.json is left over from a roko serve that stopped" in err and "Nothing was saved." in err
    assert "url" not in ctx.settings and "workdir" not in ctx.settings

    # When roko names its own workspace (/api/doctor), the message names both.
    real_get = RokoClient.get

    def get(self: RokoClient, path: str, params: Any = None, **kwargs: Any) -> Any:
        if path == "/api/doctor":
            return {"workdir": "/Users/someone/other-project", "healthy": True}
        return real_get(self, path, params, **kwargs)

    monkeypatch.setattr(RokoClient, "get", get)
    assert run_cli(Runtime(ctx), "setup", "--workdir", str(workspace)) == cli.EXIT_UNREACHABLE
    assert (
        f"is the roko serve of /Users/someone/other-project, not of {workspace.resolve()}"
        in capsys.readouterr().err
    )

    # Its own workspace, by roko's word, is the same serve whatever the file's time says.
    monkeypatch.setattr(
        RokoClient,
        "get",
        lambda self, path, params=None, **kw: (
            {"workdir": str(workspace)} if path == "/api/doctor" else real_get(self, path, params, **kw)
        ),
    )
    assert run_cli(Runtime(ctx), "setup", "--workdir", str(workspace), "--dry-run") == cli.EXIT_OK


def test_a_remote_url_in_serve_json_is_neither_refused_nor_contacted(
    capsys: pytest.CaptureFixture[str], served: FakeRoko, workspace: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import time

    import httpx

    endpoint = workspace / ".roko" / "runtime" / "serve.json"
    # A file naming a host off this machine, with a start time no serve here shares.
    endpoint.write_text(
        json.dumps({"pid": 1, "url": "https://roko.example.invalid", "started_at": time.time() - 3600})
    )
    asked: list[str] = []
    real_send = httpx.Client.send

    def send(self: httpx.Client, request: httpx.Request, **kwargs: Any) -> httpx.Response:
        asked.append(str(request.url.host))
        return real_send(self, request, **kwargs)

    monkeypatch.setattr(httpx.Client, "send", send)
    ctx = FakeContext({"url": served.url})
    assert run_cli(Runtime(ctx), "setup", "--workdir", str(workspace), "--dry-run") == cli.EXIT_OK
    out = capsys.readouterr()
    assert "ignored the URL in serve.json" in out.out and "left over from a roko serve" not in out.err
    assert "roko.example.invalid" not in asked and "127.0.0.1" in asked


# -- editing roko.toml --------------------------------------------------------------------------


def edit_local(text: str) -> str:
    return readiness._allow_without_boundary(text, tomllib.loads(text))


def test_the_local_switch_is_changed_in_place_with_its_comment() -> None:
    text = "[serve.mcp]\nmax_run_usd = 5.0\nallow_without_data_llm = false   # off by default\n\n[gates]\n"
    assert edit_local(text) == (
        "[serve.mcp]\nmax_run_usd = 5.0\nallow_without_data_llm = true  # off by default\n\n[gates]\n"
    )


def test_the_local_switch_goes_under_an_existing_table() -> None:
    text = "# serve\n[ serve . mcp ]  # limits\nmax_run_usd = 2.0\n[gates]\nrungs = []\n"
    assert edit_local(text) == (
        "# serve\n[ serve . mcp ]  # limits\nallow_without_data_llm = true\nmax_run_usd = 2.0\n[gates]\nrungs = []\n"
    )


def test_line_endings_and_a_missing_last_newline_are_kept() -> None:
    crlf = "[serve]\r\nport = 1\r\n"
    edited = edit_local(crlf)
    assert edited.startswith(crlf) and "\r\n[serve.mcp]\r\nallow_without_data_llm = true\r\n" in edited
    assert "\n" not in edited.replace("\r\n", "")
    bare = '[agent]\ndefault_model = "x"'
    added = readiness._add_data_model(bare, tomllib.loads(bare), "cheap")
    assert added.startswith(bare + "\n\n# Added by") and added.endswith('[agent.data_llm]\nmodel = "cheap"\n')


def test_a_layout_the_edit_cannot_change_safely_is_refused() -> None:
    dotted = "[serve]\nmcp.max_run_usd = 2.0\n"
    with pytest.raises(RokoError) as refused:
        edit_local(dotted)
    assert refused.value.code is Code.CONFIG and "by hand" in (refused.value.hint or "")
    inline = 'agent = { default_model = "x" }\n'
    with pytest.raises(RokoError):
        readiness._add_data_model(inline, tomllib.loads(inline), "cheap")


def test_a_symlinked_roko_toml_is_edited_where_it_lives(
    served: FakeRoko, wrt: Runtime, workspace: Path, tmp_path: Path
) -> None:
    real = tmp_path / "dotfiles" / "roko.toml"
    real.parent.mkdir()
    real.write_text(ROKO_TOML)
    (workspace / "roko.toml").unlink()
    (workspace / "roko.toml").symlink_to(real)
    served.config = real
    result = readiness.apply_fix(wrt, "workspace-chat-ready", "local")
    assert result["path"] == str(real.resolve()) and (workspace / "roko.toml").is_symlink()
    assert "allow_without_data_llm = true" in real.read_text()

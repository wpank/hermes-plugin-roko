from __future__ import annotations

import contextlib
import copy
import json
import os
import signal
import subprocess
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from fake_roko import FakeRoko

from hermes_plugin_roko import _hermes, serve
from hermes_plugin_roko.runtime import Runtime


class FakeState:
    """Hermes' `ctx.state`: JSON values by key."""

    def __init__(self) -> None:
        self.data: dict[str, Any] = {}

    def get(self, key: str, default: Any = None) -> Any:
        return copy.deepcopy(self.data.get(key, default))

    def set(self, key: str, value: Any) -> None:
        json.dumps(value)  # Hermes stores JSON; anything else must fail here too
        self.data[key] = copy.deepcopy(value)


class FakeContext:
    """A strict stand-in for Hermes' PluginContext: unknown attributes raise.

    It records registrations and enforces the rules of Hermes 0.21.0 that the
    plugin relies on (dict schemas, prompt-section limits, settings key shape).
    """

    def __init__(self, settings: dict[str, Any] | None = None) -> None:
        self.settings: dict[str, Any] = dict(settings or {})
        self.tools: dict[str, dict[str, Any]] = {}
        self.commands: dict[str, dict[str, Any]] = {}
        self.cli: dict[str, dict[str, Any]] = {}
        self.sections: dict[str, dict[str, Any]] = {}
        self.hooks: list[tuple[str, Any]] = []
        self.unload: list[Callable[[], None]] = []
        self.state = FakeState()

    def get_config(self, key: str, default: Any = None) -> Any:
        assert "/" not in key and key.split(".")[0] not in ("model", "plugins", "security", "settings")
        return self.settings.get(key, default)

    def set_config(self, key: str, value: Any) -> None:
        assert "/" not in key
        self.settings[key] = value

    def register_tool(
        self,
        name: str,
        toolset: str,
        schema: dict[str, Any],
        handler: Callable[..., str],
        check_fn: Any = None,
        requires_env: Any = None,
        is_async: bool = False,
        description: str = "",
        emoji: str = "",
        override: bool = False,
    ) -> object:
        assert isinstance(schema, dict) and schema.get("name") == name
        assert schema["parameters"]["type"] == "object"
        assert name not in self.tools, f"{name} registered twice"
        self.tools[name] = {
            "toolset": toolset,
            "schema": schema,
            "handler": handler,
            "description": description,
        }
        return object()

    def register_hook(self, hook_name: str, callback: Any) -> object:
        self.hooks.append((hook_name, callback))
        return object()

    def register_command(
        self, name: str, handler: Any, description: str = "", args_hint: str = "", argument_mode: Any = None
    ) -> object:
        assert not args_hint.startswith("<"), "Telegram drops commands whose args_hint starts with '<'"
        self.commands[name] = {"handler": handler, "description": description, "args_hint": args_hint}
        return object()

    def register_cli_command(
        self, name: str, help: str, setup_fn: Any, handler_fn: Any = None, description: str = ""
    ) -> object:
        self.cli[name] = {"help": help, "setup_fn": setup_fn, "handler_fn": handler_fn}
        return object()

    def register_system_prompt_section(
        self, id: str, content: Any, *, position: str = "after_memory", max_chars: int = 4000
    ) -> object:
        assert max_chars <= 4000 and id not in self.sections
        self.sections[id] = {"content": content, "max_chars": max_chars}
        return object()

    def on_unload(self, callback: Callable[[], None]) -> object:
        self.unload.append(callback)
        return object()

    def __getattr__(self, name: str) -> Any:
        raise AttributeError(f"PluginContext has no attribute {name!r}")


class Approvals:
    """Records what the plugin asked the person, and answers as told."""

    def __init__(self) -> None:
        self.asked: list[dict[str, str]] = []
        self.answer: tuple[bool, str | None] = (True, None)

    def __call__(self, tool_name: str, message: str, rule_key: str) -> tuple[bool, str | None]:
        self.asked.append({"tool": tool_name, "message": message, "rule_key": rule_key})
        return self.answer

    def deny(self, message: str = "BLOCKED: Action denied by user. Do NOT retry it.") -> None:
        self.answer = (False, message)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in ("ROKO_URL", "ROKO_SERVE_URL", "ROKO_API_KEY", "ROKO_BIN"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HERMES_HOME", str(tmp_path / "hermes-home"))
    # 0.7.0: the plugin looks for roko where it is installed (~/.roko/bin, PATH, ~/.cargo/bin). A test sees
    # only the roko it names (ROKO_BIN, or the roko_bin setting): never this machine's.
    monkeypatch.setattr(serve, "_known_locations", lambda: [])
    for cache in (serve._FOUND, serve._PROBES, serve._MCP, serve._DOCTOR, serve._JOBS):
        cache.clear()
    # The unit tests run without Hermes installed: pretend its approval gate
    # and config are there (tests that need otherwise patch these again).
    monkeypatch.setattr(_hermes, "approval_gate_available", lambda: True)
    monkeypatch.setattr(_hermes, "mcp_servers", lambda: {})


@pytest.fixture
def fake() -> Iterator[FakeRoko]:
    server = FakeRoko().start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def approvals(monkeypatch: pytest.MonkeyPatch) -> Approvals:
    recorder = Approvals()
    monkeypatch.setattr(_hermes, "request_approval", recorder)
    return recorder


@pytest.fixture
def ctx(fake: FakeRoko) -> FakeContext:
    return FakeContext({"url": fake.url})


@pytest.fixture
def rt(ctx: FakeContext) -> Iterator[Runtime]:
    runtime = Runtime(ctx)
    try:
        yield runtime
    finally:
        runtime.close()


@pytest.fixture
def call(rt: Runtime, approvals: Approvals) -> Callable[..., dict[str, Any]]:
    """Call a tool through the handler Hermes would call, and decode its JSON."""
    from hermes_plugin_roko.tools import make_handlers

    handlers = make_handlers(rt)

    def invoke(name: str, args: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
        raw = handlers[name](args or {}, task_id="task-1", session_id="session-1", **kwargs)
        assert isinstance(raw, str)
        result = json.loads(raw)
        assert isinstance(result, dict)
        return result

    return invoke


# -- 0.7.0: a fake roko binary, and git projects whose roko serves are stopped after the test ----------------

TESTS = Path(__file__).parent
# The fake roko command's modes (tests/fake_roko_cli.py); a test sets the ones it plays.
FAKE_ROKO_MODES = (
    "FAKE_ROKO_OLD",
    "FAKE_ROKO_NO_DETACH",
    "FAKE_ROKO_NO_MCP",
    "FAKE_ROKO_START_FAIL",
    "FAKE_ROKO_START_DELAY",
    "FAKE_ROKO_GIT",
    "FAKE_ROKO_ACTIVE",
    "FAKE_ROKO_PRESET",
    "FAKE_ROKO_PRESET_NO_MODEL",
    "FAKE_ROKO_RELOAD_DELAY",
)
# A roko.toml whose roko serve accepts runs started from Hermes: no data-model boundary needed, and a priced
# model a run from chat can use (its key in FAKE_MODEL_KEY, which the plugin passes to roko).
READY_TOML = """\
[serve.auth]
enabled = true

[serve.mcp]
max_run_usd = 5.0
allow_without_data_llm = true

[providers.fake]
kind = "openai_compat"
base_url = "http://127.0.0.1:9/v1"
api_key_env = "FAKE_MODEL_KEY"

[models.fake-mini]
provider = "fake"
slug = "gpt-5.4-mini"
"""


@pytest.fixture
def roko_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """`ROKO_BIN`: a wrapper that runs the fake roko command, with a scratch HOME (the fake keeps its list of
    serves in ~/.roko/runtime/serves) and every invocation's arguments in `roko-argv.jsonl`."""
    home = tmp_path / "home"
    home.mkdir(exist_ok=True)
    monkeypatch.setenv("HOME", str(home))
    wrapper = tmp_path / "bin" / "roko"
    wrapper.parent.mkdir(exist_ok=True)
    wrapper.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{TESTS / "fake_roko_cli.py"}" "$@"\n')
    wrapper.chmod(0o755)
    monkeypatch.setenv("ROKO_BIN", str(wrapper))
    monkeypatch.setenv("FAKE_ROKO_ARGV_LOG", str(tmp_path / "roko-argv.jsonl"))
    monkeypatch.setenv("FAKE_MODEL_KEY", "not-a-key")
    for name in FAKE_ROKO_MODES:
        monkeypatch.delenv(name, raising=False)
    return wrapper


def roko_calls(tmp_path: Path) -> list[list[str]]:
    """Every invocation of the fake roko command in this test, in order (roko_cli)."""
    log = tmp_path / "roko-argv.jsonl"
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_text().splitlines() if line.strip()]


def git_checkout(path: Path) -> Path:
    """`path` as a git checkout with one commit."""
    path.mkdir(parents=True, exist_ok=True)
    env = {
        **os.environ,
        "GIT_AUTHOR_NAME": "t",
        "GIT_AUTHOR_EMAIL": "t@example.invalid",
        "GIT_COMMITTER_NAME": "t",
        "GIT_COMMITTER_EMAIL": "t@example.invalid",
    }
    subprocess.run(["git", "init", "-q"], cwd=path, check=True, env=env)
    (path / "README.md").write_text("# a project\n")
    subprocess.run(["git", "add", "-A"], cwd=path, check=True, env=env)
    subprocess.run(["git", "commit", "-qm", "first commit"], cwd=path, check=True, env=env)
    return path.resolve()


def stop_serves(*projects: Path) -> None:
    """SIGTERM the roko serve a test started in each project (its serve.json's pid), and wait for it to go."""
    pids = []
    for project in projects:
        endpoint = project / ".roko" / "runtime" / "serve.json"
        try:
            pid = json.loads(endpoint.read_text()).get("pid")
        except (OSError, ValueError):
            continue
        if isinstance(pid, int) and pid not in (os.getpid(), 1):
            with contextlib.suppress(ProcessLookupError):
                os.kill(pid, signal.SIGTERM)
                pids.append(pid)
    deadline = time.monotonic() + 10
    for pid in pids:
        while time.monotonic() < deadline:
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)


@pytest.fixture
def make_project(tmp_path: Path) -> Iterator[Callable[..., Path]]:
    """Make git checkouts (with READY_TOML as roko.toml unless `toml` says otherwise); the roko serves a test
    starts in them are stopped after it."""
    made: list[Path] = []

    def make(name: str = "proj", *, toml: str | None = READY_TOML) -> Path:
        path = git_checkout(tmp_path / name)
        if toml is not None:
            (path / "roko.toml").write_text(toml)
        made.append(path)
        return path

    try:
        yield make
    finally:
        stop_serves(*made)

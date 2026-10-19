from __future__ import annotations

import copy
import json
import sys
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
    for cache in (serve._FOUND, serve._PROBES, serve._MCP, serve._JOBS):
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

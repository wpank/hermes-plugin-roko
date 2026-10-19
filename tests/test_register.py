from __future__ import annotations

import asyncio
import inspect
import re
import socket
import time
import tomllib
from pathlib import Path
from typing import Any

import pytest
import yaml
from conftest import FakeContext

import hermes_plugin_roko
from hermes_plugin_roko import _hermes, catalog, prompt
from hermes_plugin_roko.runtime import Runtime

ROOT = Path(__file__).resolve().parents[1]


def _register(settings: dict[str, Any] | None = None) -> FakeContext:
    ctx = FakeContext(settings or {})
    hermes_plugin_roko.register(ctx)
    return ctx


def test_registers_tools_command_cli_and_prompt_but_no_hooks() -> None:
    ctx = _register()
    assert sorted(ctx.tools) == sorted(catalog.tool_schemas(5.0))
    assert {t["toolset"] for t in ctx.tools.values()} == {"roko"}
    assert list(ctx.commands) == ["roko"] and list(ctx.cli) == ["roko"]
    assert list(ctx.sections) == ["roko"]
    assert ctx.hooks == []
    assert len(ctx.unload) == 1


def test_register_is_offline_and_fast(monkeypatch: pytest.MonkeyPatch) -> None:
    def no_network(*args: Any, **kwargs: Any) -> Any:
        raise AssertionError("register() must not touch the network")

    monkeypatch.setattr(socket.socket, "connect", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    started = time.monotonic()
    ctx = _register({"url": "http://127.0.0.1:1"})
    assert time.monotonic() - started < 1.0
    assert len(ctx.tools) == 8


def test_bad_settings_still_register_everything(caplog: pytest.LogCaptureFixture) -> None:
    ctx = _register({"url": "not a url", "max_run_usd": "lots", "approve_paid": "maybe"})
    assert len(ctx.tools) == 8 and "roko" in ctx.cli
    assert "max_run_usd" in caplog.text


def test_slash_command_is_async_for_the_gateway_loop(fake: Any) -> None:
    ctx = _register({"url": fake.url})
    handler = ctx.commands["roko"]["handler"]
    assert inspect.iscoroutinefunction(handler)
    assert "/roko status" in asyncio.run(handler("help"))


def test_prompt_section_fits_and_can_be_turned_off() -> None:
    ctx = _register({"max_run_usd": 2})
    render = ctx.sections["roko"]["content"]
    text = render({"session_id": "s", "platform": "cli"})
    assert len(text) <= prompt.MAX_CHARS and "$2.00" in text
    for name in (
        "roko_run",
        "roko_plan_generate",
        "roko_plans",
        "roko_plan_run",
        "roko_status",
        "roko_decide",
        "roko_recall",
    ):
        assert name in text
    ctx.settings["prompt_section"] = False
    assert render({}) == ""
    assert "roko" not in _register({"prompt_section": False}).sections


def test_manifest_matches_the_code(monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = yaml.safe_load((ROOT / "plugin.yaml").read_text())
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())
    assert manifest["name"] == "roko" and manifest["kind"] == "standalone"
    assert "manifest_version" not in manifest  # Hermes 0.21.0's installer rejects 2
    assert manifest["version"] == pyproject["project"]["version"] == hermes_plugin_roko.__version__
    assert sorted(manifest["provides_tools"]) == sorted(_register().tools)
    # The learning guard's hook is opt-in, so a default registration (what Hermes' doctor checks) adds only the
    # desktop's three turn hooks (cards.py), on a Hermes that gates hooks per call.
    monkeypatch.setattr(_hermes, "hooks_gated_per_call", lambda: True)
    assert manifest["provides_hooks"] == [name for name, _ in _register().hooks]
    assert manifest["provides_hooks"] == ["transform_llm_output", "on_interim_message", "on_session_end"]
    assert pyproject["project"]["entry-points"]["hermes_agent.plugins"]["roko"] == "hermes_plugin_roko"
    assert set(manifest["config_schema"]) >= {
        "url",
        "workdir",
        "api_key_env",
        "max_run_usd",
        "approve_paid",
        "confirm_decisions",
        "prompt_section",
        "timeout_s",
    }


def test_no_memory_provider_text_in_the_entry_module() -> None:
    # Hermes classifies a plugin whose __init__ mentions this name as a memory
    # provider (only when `kind` is absent, but a pip install cannot set kind).
    for path in (ROOT / "__init__.py", ROOT / "hermes_plugin_roko" / "__init__.py"):
        assert not re.search(r"MemoryProvider|register_memory_provider", path.read_text()[:8192])


def test_only_one_module_imports_hermes() -> None:
    hermes_modules = re.compile(
        r"^\s*(from|import)\s+(tools|hermes_cli|agent|gateway|hermes_constants)\b", re.M
    )
    offenders = [
        path.name
        for path in (ROOT / "hermes_plugin_roko").glob("*.py")
        if path.name != "_hermes.py" and hermes_modules.search(path.read_text())
    ]
    assert offenders == []


def test_prompt_section_names_the_workspace_and_stays_in_budget(tmp_path: Path) -> None:
    render = _register({"workdir": str(tmp_path)}).sections["roko"]["content"]
    text = render({})
    assert str(tmp_path) in text and "roko/batch/<run_id>" in text and len(text) <= prompt.MAX_CHARS
    deep = tmp_path / ("x" * 200) / ("y" * 200) / ("z" * 200) / ("w" * 200)
    deep.mkdir(parents=True)
    long_text = _register({"workdir": str(deep)}).sections["roko"]["content"]({})
    assert len(long_text) <= prompt.MAX_CHARS and str(deep) not in long_text
    assert long_text.endswith(prompt.ASKS.strip())


def test_the_desktop_section_keeps_the_workspace_with_a_long_path(tmp_path: Path) -> None:
    # 0.7.2: 0.7's per-project text made the desktop section about 2,540 characters with any path, over the old
    # 2,500 limit, so render() dropped the workspace from every desktop chat.
    room = 199 - len(str(tmp_path))
    if room < 1:
        pytest.skip("the temporary folder's own path is too long for a 200-character workspace")
    folder = tmp_path / ("p" * room)
    folder.mkdir()
    assert len(str(folder)) == 200
    render = _register({"workdir": str(folder)}).sections["roko"]["content"]
    for platform in ("desktop", "cli", ""):
        text = render({"platform": platform})
        assert str(folder) in text and len(text) <= prompt.MAX_CHARS


def test_the_section_without_a_path_leaves_room_for_one() -> None:
    render = prompt.make_render(Runtime(FakeContext({})))
    for platform in ("desktop", "cli", ""):
        assert len(render({"platform": platform})) <= prompt.MAX_CHARS - 200
    assert prompt.MAX_CHARS <= 4_000  # Hermes' own limit per section


def test_register_survives_a_workdir_it_cannot_use() -> None:
    ctx = _register({"workdir": "~no-such-user-for-roko/ws"})
    assert len(ctx.tools) == 8 and "roko" in ctx.cli


def test_prompt_section_only_promises_approval_when_it_is_on() -> None:
    ctx = _register({})
    render = ctx.sections["roko"]["content"]
    assert prompt.ASKS.strip() in render({})
    ctx.settings["approve_paid"] = False
    assert "asks the person" not in render({})

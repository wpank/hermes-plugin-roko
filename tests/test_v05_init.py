"""0.5: `hermes roko init` makes a project ready in one command (onboard.py).

A fake `roko` command (tests/fake_roko_cli.py) writes roko.toml as a roko before 2026-10-15 did, and its
`serve` is a FakeRoko that follows that roko.toml and the keys in ~/.roko/.env, as roko does.
"""

from __future__ import annotations

import contextlib
import json
import os
import plistlib
import re
import signal
import socket
import subprocess
import sys
import tomllib
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeContext

from hermes_plugin_roko import _hermes, cli, install_state, onboard, readiness
from hermes_plugin_roko.onboard import Init, Options, add_api_model, add_priced_rung
from hermes_plugin_roko.runtime import Runtime

TESTS = Path(__file__).parent


@pytest.fixture(autouse=True)
def _loaded_is_on_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    # Other work may change the checkout while a test runs; install_state would call that a stale backend.
    pinned = install_state._fingerprint()
    monkeypatch.setattr(install_state, "_LOADED_FINGERPRINT", pinned)
    monkeypatch.setattr(install_state, "_fingerprint", lambda: pinned)


@pytest.fixture
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A HOME with no ~/.roko, an environment with no model keys, and a git identity."""
    path = tmp_path / "home"
    path.mkdir()
    monkeypatch.setenv("HOME", str(path))
    for name in [
        *onboard.ROKO_KEYS,
        "ROKO_API_KEY",
        "ROKO_URL",
        "ROKO_SERVE_URL",
        "FAKE_ROKO_PRESET",
        "FAKE_ROKO_OLD",
    ]:
        monkeypatch.delenv(name, raising=False)
    for name in ("GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME"):
        monkeypatch.setenv(name, "t")
    for name in ("GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL"):
        monkeypatch.setenv(name, "t@example.invalid")
    return path


@pytest.fixture
def roko(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """`ROKO_BIN`: a wrapper that runs the fake roko command."""
    wrapper = tmp_path / "bin" / "roko"
    wrapper.parent.mkdir()
    wrapper.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{TESTS / "fake_roko_cli.py"}" "$@"\n')
    wrapper.chmod(0o755)
    monkeypatch.setenv("ROKO_BIN", str(wrapper))
    return wrapper


def git(path: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(path), *args], check=True, capture_output=True, text=True).stdout


@pytest.fixture
def project(tmp_path: Path, home: Path) -> Iterator[Path]:
    """A git checkout with one commit; the roko serve a test starts in it is stopped after."""
    path = tmp_path / "proj"
    path.mkdir()
    git(path, "init", "-q")
    (path / "README.md").write_text("# a project\n")
    git(path, "add", "-A")
    git(path, "commit", "-qm", "first commit")
    try:
        yield path
    finally:
        endpoint = path / ".roko" / "runtime" / "serve.json"
        if endpoint.is_file():
            pid = json.loads(endpoint.read_text()).get("pid")
            if isinstance(pid, int) and pid != os.getpid():
                with contextlib.suppress(ProcessLookupError):
                    os.kill(pid, signal.SIGTERM)


@pytest.fixture
def saved(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """Hermes' .env: what `hermes roko setup` saves there."""
    store: dict[str, str] = {}

    def save(key: str, value: str) -> Path:
        store[key] = value
        os.environ[key] = value
        return Path("/nonexistent/hermes.env")

    monkeypatch.setattr(_hermes, "save_env_value", save)
    monkeypatch.setattr(cli, "_env_file_has", lambda path, key, value: store.get(key) == value)
    return store


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def init(ctx: FakeContext, project: Path, *, port: int | None = None, **options: Any) -> tuple[int, str]:
    lines: list[str] = []
    rt = Runtime(ctx)
    try:
        code = Init(rt, Options(workdir=project, port=port or free_port(), **options), out=lines.append).run()
    finally:
        rt.close()
    return code, "\n".join(lines)


# -- a project from nothing --------------------------------------------------------------------------


@pytest.mark.parametrize("old_roko", [False, True])
def test_init_makes_a_fresh_project_ready(
    old_roko: bool,
    project: Path,
    home: Path,
    roko: Path,
    saved: dict[str, str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    if old_roko:
        monkeypatch.setenv("FAKE_ROKO_OLD", "1")  # a roko that names refusals only in its text
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")  # the key Hermes has
    ctx = FakeContext({})
    code, out = init(ctx, project, yes=True)
    assert code == 0, out
    env = home / ".roko" / ".env"
    assert env.read_text() == "OPENAI_API_KEY=sk-test-not-a-key\n" and (env.stat().st_mode & 0o777) == 0o600
    assert "sk-test-not-a-key" not in out  # a key is never printed
    data = tomllib.loads((project / "roko.toml").read_text())
    assert data["serve"]["mcp"]["allow_without_data_llm"] is True
    assert data["providers"]["openai"]["api_key_env"] == "OPENAI_API_KEY"
    model = data["models"]["gpt-5-4-mini"]
    assert model["provider"] == "openai" and model["slug"] == "gpt-5.4-mini"
    assert model["cost_input_per_m"] == 0.75 and model["cost_output_per_m"] == 4.5  # roko holds runs to caps
    assert [rung["model"] for rung in data["routing"]["ladder"]["rungs"] if rung["name"] == "top"] == [
        "gpt-5-4-mini"
    ]
    endpoint = json.loads((project / ".roko" / "runtime" / "serve.json").read_text())
    # 0.7.0: the project is Hermes' default project; its serve.json says where its roko serve listens (no
    # URL is saved), and Hermes talks to it with the project's launch token (no key is minted).
    assert "url" not in ctx.settings and ctx.settings["workdir"] == str(project.resolve())
    assert endpoint["instance_id"] and "ROKO_API_KEY" not in saved
    assert "the project's launch token works" in out
    assert (project / "plans" / "demos" / "demo-hello-world" / "tasks.toml").is_file()
    # The fix keeps a copy of roko.toml first, and so does init's first own change (the model; not learning).
    assert len(list((project / ".roko" / "backups").glob("roko.toml.bak-*"))) == 2
    assert onboard.learning_state(data) == "on" and data["sections"]["pinned"] == ["domain_context"]
    for said in (
        "✓ project: git checkout on",
        "✓ model key: copied OPENAI_API_KEY to ~/.roko/.env",
        "✓ roko.toml: `roko init` wrote it",
        "✓ roko serve: started at",
        "✓ models: roko.toml names gpt-5-4-mini (gpt-5.4-mini), and roko can use it",
        "✓ demo: added plans/demos/demo-hello-world",
        "✓ Nothing stands between Hermes and roko.",
        "Start here: hello world demo",
    ):
        assert said in out, (said, out)


def test_init_again_changes_nothing(
    project: Path, home: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    ctx = FakeContext({})
    port = free_port()
    assert init(ctx, project, port=port, yes=True)[0] == 0
    toml = (project / "roko.toml").read_bytes()
    code, out = init(ctx, project, port=port, yes=True)
    assert code == 0, out
    assert (project / "roko.toml").read_bytes() == toml and saved == {}
    assert (home / ".roko" / ".env").read_text().count("OPENAI_API_KEY=") == 1
    assert "→" not in out and "started at" not in out and "copied" not in out, out
    assert "✓ connected: Hermes uses roko serve at" in out


def test_dry_run_changes_nothing(
    project: Path, home: Path, roko: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    code, out = init(FakeContext({}), project, dry_run=True)
    assert code == 0, out
    assert not (home / ".roko").exists() and not (project / "roko.toml").exists()
    assert (
        "would create ~/.roko" in out
        and "would copy OPENAI_API_KEY" in out
        and "would run `roko init`" in out
    )


def test_without_a_terminal_nothing_changes_and_it_says_how(
    project: Path, home: Path, roko: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    code, out = init(FakeContext({}), project)
    assert code == 3
    assert not (project / "roko.toml").exists() and not (home / ".roko" / ".env").exists()
    assert "run `hermes roko init --yes` to make those changes" in out


def test_saying_no_in_a_terminal_changes_nothing(
    project: Path, home: Path, roko: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    asked: list[str] = []
    lines: list[str] = []
    rt = Runtime(FakeContext({}))
    code = Init(
        rt, Options(workdir=project), out=lines.append, confirm=lambda q: asked.append(q) or False
    ).run()
    rt.close()
    assert code == 3 and not (project / "roko.toml").exists()
    assert any("Copy OPENAI_API_KEY from Hermes" in question for question in asked)
    assert any("Run `roko init` here" in question for question in asked)


# -- what stops it ---------------------------------------------------------------------------------------


def test_a_folder_without_git_stops_with_the_commands(tmp_path: Path, home: Path, roko: Path) -> None:
    plain = tmp_path / "plain"
    plain.mkdir()
    code, out = init(FakeContext({}), plain, yes=True)
    assert code == 3 and "is not a git checkout" in out and "init && git -C" in out
    assert not (plain / "roko.toml").exists()


def test_a_checkout_without_a_commit_stops(tmp_path: Path, home: Path, roko: Path) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    git(empty, "init", "-q")
    code, out = init(FakeContext({}), empty, yes=True)
    assert code == 3 and "has no commit yet" in out


def test_without_roko_it_says_how_to_get_it(
    project: Path, home: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv("ROKO_BIN", raising=False)
    monkeypatch.setenv("PATH", "/usr/bin:/bin")
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 3 and "roko is not installed" in out and "cargo install --path crates/roko-cli" in out


def test_without_a_key_anywhere_it_says_where_to_put_one(
    project: Path, home: Path, roko: Path, saved: dict[str, str]
) -> None:
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 3
    assert "Hermes has none roko can use" in out and "chmod 600 ~/.roko/.env" in out
    assert "echo" not in out  # a key typed into an echo stays in the shell's history
    assert "add a model key to ~/.roko/.env" in out


# -- the ways of each step --------------------------------------------------------------------------------


def test_rokos_own_preset_makes_the_change_when_roko_has_it(
    project: Path, home: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    monkeypatch.setenv("FAKE_ROKO_PRESET", "1")
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 0, out
    assert "roko's own `config preset chat-host` makes this change" in out
    assert "✓ runs from Hermes: roko's preset changed roko.toml, and roko accepts them now" in out
    text = (project / "roko.toml").read_text()
    assert "allow_without_data_llm = true" in text and "Added by hermes roko fix" not in text


API_TOML = """\
[agent]
default_model = "gpt-5-4-mini"

[providers.openai]
kind = "openai_compat"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"

[models.gpt-5-4-mini]
provider = "openai"
slug = "gpt-5.4-mini"

[serve.auth]
enabled = true

[serve.mcp]
max_run_usd = 5.0
allow_without_data_llm = false
"""


def test_init_waits_for_roko_serve_to_read_the_presets_change(
    project: Path, home: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    # roko serve reads roko.toml again only after a while; the preset says `ready` at once. With a model
    # already named, nothing else waits: the closing check must not run before roko serve read the change.
    (project / "roko.toml").write_text(API_TOML)
    (home / ".roko").mkdir()
    (home / ".roko" / ".env").write_text("OPENAI_API_KEY=sk-test-not-a-key\n")
    monkeypatch.setenv("FAKE_ROKO_PRESET", "1")
    monkeypatch.setenv("FAKE_ROKO_RELOAD_DELAY", "2")
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 0, out
    assert "✓ runs from Hermes: roko's preset changed roko.toml, and roko accepts them now" in out
    assert "✓ Nothing stands between Hermes and roko." in out and "✗" not in out


def test_after_rokos_preset_a_missing_model_is_the_next_step(
    project: Path, home: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    monkeypatch.setenv("FAKE_ROKO_PRESET", "1")
    monkeypatch.setenv("FAKE_ROKO_PRESET_NO_MODEL", "1")
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 0, out
    assert "roko's preset changed roko.toml; roko still needs a model for them (the next step)" in out
    assert "✓ models: roko.toml names gpt-5-4-mini (gpt-5.4-mini), and roko can use it" in out


def test_a_preset_that_refuses_is_said_and_the_plugins_fix_used(
    project: Path, home: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    monkeypatch.setenv("FAKE_ROKO_PRESET", "refuse")
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 0, out
    assert "roko's own `config preset chat-host` did not apply: roko.toml at ./roko.toml is not valid" in out
    assert "allow_without_data_llm = true" in (project / "roko.toml").read_text()  # the plugin's fix did it


UNPRICED_TOML = """\
config_version = 2

[agent]
default_model = "oss"

[providers.router]
kind = "openai_compat"
base_url = "https://router.example.invalid/v1"
api_key_env = "ROUTER_API_KEY"

[models.oss]
provider = "router"
slug = "oss-large"

[providers.claude_cli]
kind = "claude_cli"

[models.claude-sonnet-4-6]
provider = "claude_cli"
slug = "claude-sonnet-4-6"

[routing.ladder]
enabled = true

[[routing.ladder.rungs]]
name = "cheap"
model = "oss"

[[routing.ladder.rungs]]
name = "top"
model = "claude-sonnet-4-6"

[serve.auth]
enabled = true

[serve.mcp]
max_run_usd = 5.0
allow_without_data_llm = true
"""


def test_without_a_priced_model_init_adds_one_above_the_rungs_and_leaves_them(
    project: Path, home: Path, roko: Path, saved: dict[str, str]
) -> None:
    # roko refuses runs from Hermes while none of their models has a price (gap-8548e3). Init never invents
    # rates: it adds a model roko has a price for, on a new rung above the person's, which their own rungs
    # and terminal runs' start points keep.
    (project / "roko.toml").write_text(UNPRICED_TOML)
    (home / ".roko").mkdir()
    (home / ".roko" / ".env").write_text(
        "ROUTER_API_KEY=rk-test-not-a-key\nOPENAI_API_KEY=sk-test-not-a-key\n"
    )
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 0, out
    for said in (
        "✓ runs from Hermes: roko.toml settles the data-model boundary; roko still needs a model it has a "
        "price for (the next step)",
        "→ models: roko has no priced model for runs started from Hermes; roko.toml can name gpt-5.4-mini "
        "(OpenAI), which roko has a price for, on a new rung above the others:",
        "Terminal runs keep the rungs they start on",
        "✓ models: roko.toml names gpt-5-4-mini (gpt-5.4-mini) on the rung `priced`, and roko has a price for it",
        "✓ Nothing stands between Hermes and roko.",
    ):
        assert said in out, (said, out)
    assert "✗" not in out
    # The closing summary names what changed for runs under a cap, so nobody is surprised later.
    summary = out[out.index("✓ Nothing stands between Hermes and roko.") :]
    assert (
        "Added to roko.toml:\n  - rung `priced`: gpt-5-4-mini (gpt-5.4-mini) at $0.75/$4.50 per M tokens in/out; "
        "runs under a cap use it; terminal runs reach it only after every other rung fails"
    ) in summary
    data = tomllib.loads((project / "roko.toml").read_text())
    assert data["routing"]["ladder"]["rungs"] == [
        {"name": "cheap", "model": "oss"},
        {"name": "top", "model": "claude-sonnet-4-6"},
        {"name": "priced", "model": "gpt-5-4-mini"},
    ]
    assert data["models"]["gpt-5-4-mini"]["cost_input_per_m"] == 0.75
    assert data["models"]["oss"] == {"provider": "router", "slug": "oss-large"}  # no rates made up for it
    assert data["agent"]["default_model"] == "oss"


@pytest.mark.parametrize("layout", ["no key it knows", "no rungs of its own"])
def test_without_a_safe_way_to_a_priced_model_init_points_to_the_rates(
    layout: str, project: Path, home: Path, roko: Path, saved: dict[str, str]
) -> None:
    text = UNPRICED_TOML
    keys = "ROUTER_API_KEY=rk-test-not-a-key\n"
    if layout == "no rungs of its own":
        text = text[: text.index("[[routing.ladder.rungs]]")] + text[text.index("[serve.auth]") :]
        keys += "OPENAI_API_KEY=sk-test-not-a-key\n"
    (project / "roko.toml").write_text(text)
    (home / ".roko").mkdir()
    (home / ".roko" / ".env").write_text(keys)
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 3, out
    why = (
        "roko.toml lists no ladder rungs of its own"
        if layout == "no rungs of its own"
        else "no key in ~/.roko/.env for a model this step knows the price of"
    )
    said = f"→ models: roko has no priced model for runs started from Hermes; give one of its models its real rates ({why})"
    assert said in out, out
    assert (
        "give one of roko's models for runs from Hermes its real rates: "
        "docs/using-roko.md#roko-has-no-priced-model-for-runs-from-hermes"
    ) in out
    assert "✗ roko has no priced model for runs started from Hermes." in out
    # Nothing but learning (turned on by --yes) changed in roko.toml.
    assert without_learning((project / "roko.toml").read_text()) == without_learning(text)


def without_learning(text: str) -> dict[str, Any]:
    """A parsed roko.toml without the tables `turn_on_learning` writes to."""
    data = tomllib.loads(text)
    for table in ("learning", "sections", "self_model", "experiments"):
        data.pop(table, None)
    return data


# -- roko's learning ----------------------------------------------------------------------------------

READY_TOML = API_TOML.replace("allow_without_data_llm = false", "allow_without_data_llm = true")


@pytest.fixture
def ready(project: Path, home: Path) -> Path:
    """A project roko already accepts runs from Hermes in: only learning is left to ask about."""
    (project / "roko.toml").write_text(READY_TOML)
    (home / ".roko").mkdir()
    (home / ".roko" / ".env").write_text("OPENAI_API_KEY=sk-test-not-a-key\n")
    return project


def test_init_turns_on_rokos_learning_and_names_it_at_the_end(
    project: Path, home: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 0, out
    for said in (
        "→ learning: off. Turn on roko's learning (recommended):",
        "+gate_threshold_flush_interval = 1",
        '+pinned = ["domain_context"]',
        "✓ learning: on, from roko's next run",
    ):
        assert said in out, (said, out)
    summary = out[out.index("Added to roko.toml:") :]
    assert (
        'learning: [learning] gate_threshold_flush_interval = 1 and [sections] pinned gains "domain_context"; '
        "dreams, the daimon and the self-model's control stay off"
    ) in summary
    data = tomllib.loads((project / "roko.toml").read_text())
    assert onboard.learning_state(data) == "on" and data["self_model"]["mode"] == "shadow"
    assert data["learning"]["guarded_commit"] == "observe" and data["experiments"]["maximize"] is False
    # Run again: it is on, and nothing changes.
    toml = (project / "roko.toml").read_bytes()
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 0 and (project / "roko.toml").read_bytes() == toml, out
    assert (
        "✓ learning: on: the prompt section that carries lessons from verified work is never dropped" in out
    )


def test_saying_no_to_learning_or_a_dry_run_leaves_roko_toml_as_it_was(
    ready: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("sys.stdin.isatty", lambda: True)
    asked: list[str] = []
    ctx = FakeContext({})
    rt = Runtime(ctx)
    try:
        # Yes to everything but learning.
        answer = lambda question: asked.append(question) or "learning" not in question  # noqa: E731
        code = Init(rt, Options(workdir=ready, port=free_port()), out=lambda line: None, confirm=answer).run()
    finally:
        rt.close()
    assert code == 0 and any("Turn on roko's learning (recommended)?" in question for question in asked)
    assert (ready / "roko.toml").read_text() == READY_TOML
    code, out = init(ctx, ready, dry_run=True)  # Hermes connected now, so the dry run gets as far as learning
    assert code == 0 and (ready / "roko.toml").read_text() == READY_TOML, out
    assert "+gate_threshold_flush_interval = 1" in out  # the change is shown, not made


def test_frozen_learning_is_left_frozen(ready: Path, roko: Path, saved: dict[str, str]) -> None:
    frozen = READY_TOML + "\n[learning]\nfrozen = true\n"
    (ready / "roko.toml").write_text(frozen)
    code, out = init(FakeContext({}), ready, yes=True)
    assert code == 0, out
    assert (
        "· learning: frozen: roko.toml has [learning] frozen = true, so roko learns nothing; left as it is"
        in out
    )
    assert (ready / "roko.toml").read_text() == frozen


def test_learning_in_a_symlinked_roko_toml_is_turned_on_where_it_lives(
    ready: Path, roko: Path, saved: dict[str, str], tmp_path: Path
) -> None:
    real = tmp_path / "dotfiles" / "roko.toml"
    real.parent.mkdir()
    real.write_text(READY_TOML)
    (ready / "roko.toml").unlink()
    (ready / "roko.toml").symlink_to(real)
    code, out = init(FakeContext({}), ready, yes=True)
    assert code == 0, out
    assert (ready / "roko.toml").is_symlink() and onboard.learning_state(
        tomllib.loads(real.read_text())
    ) == "on"
    backups = list((ready / ".roko" / "backups").glob("roko.toml.bak-*"))
    assert [backup.read_text() for backup in backups] == [READY_TOML]


def test_a_tracked_roko_toml_is_committed(
    project: Path, home: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    subprocess.run([str(roko), "init"], cwd=project, check=True, capture_output=True)
    git(project, "add", "roko.toml")
    git(project, "commit", "-qm", "roko.toml")
    code, out = init(FakeContext({}), project, yes=True)
    assert code == 0, out
    assert git(project, "status", "--porcelain", "--", "roko.toml") == ""
    assert git(project, "log", "-1", "--format=%s").strip() == "roko: accept runs started from Hermes"
    assert '✓ roko.toml in git: committed as "roko: accept runs started from Hermes"' in out


def test_a_running_serve_is_used_and_a_new_key_needs_its_restart(
    project: Path, home: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    subprocess.run([str(roko), "init"], cwd=project, check=True, capture_output=True)
    port = free_port()
    process = subprocess.Popen(
        [str(roko), "serve", "--workdir", str(project), "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        endpoint = project / ".roko" / "runtime" / "serve.json"
        for _ in range(100):
            if endpoint.is_file():
                break
            import time

            time.sleep(0.05)
        monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
        _, out = init(FakeContext({}), project, port=port, yes=True)
        assert f"✓ roko serve: runs for this project at http://127.0.0.1:{port}" in out
        assert "restart roko serve so it reads the key just added to ~/.roko/.env" in out
    finally:
        process.terminate()
        process.wait(timeout=10)


def test_launchd_writes_a_login_item_and_loads_nothing(
    project: Path, home: Path, roko: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    calls: list[list[str]] = []
    real_run = subprocess.run

    def run(args: list[str], **kwargs: Any) -> Any:
        calls.append(list(args))
        return real_run(args, **kwargs)

    lines: list[str] = []
    rt = Runtime(FakeContext({}))
    code = Init(
        rt, Options(workdir=project, yes=True, launchd=True, port=6799), out=lines.append, run_command=run
    ).run()
    rt.close()
    out = "\n".join(lines)
    assert code == 3
    [item] = list((home / "Library" / "LaunchAgents").glob("dev.roko.serve.proj.*.plist"))
    plist = plistlib.loads(item.read_bytes())
    assert plist["ProgramArguments"][1:] == ["serve", "--workdir", str(project.resolve()), "--port", "6799"]
    assert plist["RunAtLoad"] is True and "launchctl bootstrap gui/" in out
    assert not any("launchctl" in " ".join(call) for call in calls)  # loading it stays the person's
    assert not (project / ".roko" / "runtime" / "serve.json").exists()


def test_launchd_is_macos_only(
    project: Path, home: Path, roko: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    monkeypatch.setattr(onboard.sys, "platform", "linux")
    code, out = init(FakeContext({}), project, yes=True, launchd=True, port=6799)
    assert code == 3 and "login items are macOS's" in out and "roko serve --workdir" in out
    assert not (home / "Library").exists()


def test_the_cli_runs_init(project: Path, home: Path, roko: Path, capsys: pytest.CaptureFixture[str]) -> None:
    import argparse

    parser = argparse.ArgumentParser(prog="hermes roko")
    cli.build_parser(parser)
    args = parser.parse_args(["init", "--workdir", str(project), "--dry-run", "--port", "6799"])
    assert cli.make_main(Runtime(FakeContext({})))(args) == 0
    assert (
        f"roko for Hermes: making {project.resolve()} ready (dry run: nothing changes)"
        in capsys.readouterr().out
    )


# -- naming an API model in roko.toml -------------------------------------------------------------------------


OLD_TOML = (TESTS / "fake_roko_cli.py").read_text().split('INIT_TOML = """\\\n', 1)[1].split('"""', 1)[0]


def test_an_api_model_is_added_and_put_on_the_top_rung() -> None:
    new = add_api_model(OLD_TOML, "ANTHROPIC_API_KEY")
    assert new.startswith(
        OLD_TOML.replace('model = "claude-sonnet-4-6"\n\n[serve', 'model = "claude-haiku-4-5"\n\n[serve')
    )
    data = tomllib.loads(new)
    assert data["providers"]["anthropic"] == {
        "kind": "anthropic_api",
        "base_url": "https://api.anthropic.com",
        "api_key_env": "ANTHROPIC_API_KEY",
    }
    assert data["models"]["claude-haiku-4-5"]["provider"] == "anthropic"
    assert data["models"]["claude-haiku-4-5"]["tool_format"] == "anthropic_blocks"
    assert data["routing"]["ladder"]["rungs"][0] == {"name": "cheap", "model": "gpt-oss-120b"}  # left alone


def test_a_provider_already_there_is_reused_and_a_missing_top_rung_added() -> None:
    text = '[providers.openai]\nkind = "openai_compat"\nbase_url = "https://api.openai.com/v1"\napi_key_env = "OPENAI_API_KEY"\n'
    data = tomllib.loads(add_api_model(text, "OPENAI_API_KEY"))
    assert data["routing"]["ladder"]["rungs"] == [{"name": "top", "model": "gpt-5-4-mini"}]
    assert data["providers"]["openai"]["base_url"] == "https://api.openai.com/v1"


def test_a_priced_rung_goes_above_the_others_and_changes_nothing_else() -> None:
    text = UNPRICED_TOML
    new = add_priced_rung(text, "OPENROUTER_API_KEY")
    assert new.startswith(text)  # only added to
    data = tomllib.loads(new)
    assert [rung["name"] for rung in data["routing"]["ladder"]["rungs"]] == ["cheap", "top", "priced"]
    assert data["routing"]["ladder"]["rungs"][-1]["model"] == "gpt-5-4-mini-openrouter"
    assert data["models"]["gpt-5-4-mini-openrouter"]["cost_output_per_m"] == 4.5


@pytest.mark.parametrize(
    ("change", "why"),
    [
        (lambda t: t.replace("enabled = true\n\n[[", "enabled = false\n\n[["), "the model ladder is off"),
        (
            lambda t: t[: t.index("[[routing.ladder.rungs]]")] + t[t.index("[serve.auth]") :],
            "lists no ladder rungs of its own",
        ),
        (
            lambda t: (
                t + '\n[[routing.ladder.roles]]\nrole = "reviewer"\nrungs = [{ name = "r", model = "oss" }]\n'
            ),
            "some roles climb ladder rungs of their own",
        ),
        (lambda t: t.replace('name = "top"', 'name = "priced"'), "already has a rung named priced"),
        (
            lambda t: t + '\n[models.gpt-5-4-mini]\nprovider = "router"\nslug = "gpt-5.4-mini"\n',
            "already has [models.gpt-5-4-mini]",
        ),
        (
            lambda t: (
                t[: t.index("[[routing.ladder.rungs]]")]
                + 'rungs = [{ name = "cheap", model = "oss" }]\n\n'
                + t[t.index("[serve.auth]") :]
            ),
            "cannot change safely",
        ),
    ],
)
def test_a_ladder_a_priced_rung_cannot_join_safely_is_refused(change: Callable[[str], str], why: str) -> None:
    with pytest.raises(ValueError, match=re.escape(why)):
        add_priced_rung(change(UNPRICED_TOML), "OPENAI_API_KEY")


def test_a_layout_it_cannot_change_safely_is_refused() -> None:
    inline = '[routing.ladder]\nrungs = [{ name = "top", model = "x" }]\n'
    with pytest.raises(ValueError):
        add_api_model(inline, "OPENAI_API_KEY")
    other = '[providers.openai]\nkind = "codex_cli"\n'
    with pytest.raises(ValueError, match="another kind of provider"):
        add_api_model(other, "OPENAI_API_KEY")


def test_readiness_is_what_init_ends_with(
    project: Path, home: Path, roko: Path, saved: dict[str, str], monkeypatch: pytest.MonkeyPatch
) -> None:
    # The summary is the setup card's own words: the same `setup_problems` text `hermes roko fix` prints.
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-not-a-key")
    ctx = FakeContext({})
    code, _ = init(ctx, project, yes=True)
    rt = Runtime(ctx)
    readiness.invalidate(rt)
    assert readiness.setup_view(rt)["ok"] is True and code == 0
    rt.close()

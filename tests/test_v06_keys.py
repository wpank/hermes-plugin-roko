"""The key a Hermes process started with is not the last word (round v6, plugin-setup).

dogfood-desktop's take l6-setup-q1: the Hermes app started with an older ROKO_API_KEY in its environment, and
`hermes roko init` then saved a new key for a new roko serve in `$HERMES_HOME/.env`. `_hermes.get_secret` reads the
environment first, so the page kept sending the old key and said "roko serve refused the plugin's API key".
"""

from __future__ import annotations

import argparse
import json
from collections.abc import Iterator
from pathlib import Path

import pytest
from conftest import FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import _hermes, cli, readiness, views
from hermes_plugin_roko.runtime import Runtime

OLD = "roko_old_key_not_valid"


@pytest.fixture
def roko() -> Iterator[FakeRoko]:
    server = FakeRoko(auth=True).start()
    try:
        yield server
    finally:
        server.stop()


def save_in_hermes_env(line: str) -> None:
    path = _hermes.hermes_home() / ".env"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(line + "\n")


def test_a_key_hermes_started_with_gives_way_to_the_newer_one_saved(
    roko: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    new = roko.add_key("hermes", "write")
    monkeypatch.setenv("ROKO_API_KEY", OLD)  # what an app that started before the new key holds
    save_in_hermes_env(f"ROKO_API_KEY={new}")  # what `hermes roko init` saved since
    rt = Runtime(FakeContext({"url": roko.url}))
    try:
        seen = views.connection(rt)
        assert seen["reachable"] is True and seen["error"] is None, seen
        problems = readiness.problems(rt)
        assert readiness.KEY_REFUSED not in [problem["id"] for problem in problems], problems
        shown = json.dumps(seen) + json.dumps(problems)
        assert OLD not in shown and new not in shown  # neither key is ever shown
    finally:
        rt.close()


def test_the_live_stream_switches_to_the_saved_key_too(
    roko: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    new = roko.add_key("hermes", "write")
    monkeypatch.setenv("ROKO_API_KEY", OLD)
    save_in_hermes_env(f"ROKO_API_KEY={new}")
    rt = Runtime(FakeContext({"url": roko.url}))
    try:
        with rt.client().stream("/api/events") as response:
            assert response.status_code == 200
    finally:
        rt.close()


@pytest.mark.parametrize("saved", ["nothing", "the same key"])
def test_a_refused_key_is_still_refused_when_no_other_is_saved(
    roko: FakeRoko, monkeypatch: pytest.MonkeyPatch, saved: str
) -> None:
    monkeypatch.setenv("ROKO_API_KEY", OLD)
    if saved == "the same key":
        save_in_hermes_env(f"ROKO_API_KEY={OLD}")
    rt = Runtime(FakeContext({"url": roko.url}))
    try:
        seen = views.connection(rt)
        assert seen["error"]["code"] == "unauthorized" and OLD not in json.dumps(seen), seen
    finally:
        rt.close()


# -- what setup and init say when they save a new key over an older one -------------------------------


def run_cli(rt: Runtime, *argv: str) -> int:
    parser = argparse.ArgumentParser(prog="hermes roko")
    cli.build_parser(parser)
    return cli.make_main(rt)(parser.parse_args(list(argv)))


def workspace(tmp_path: Path, roko: FakeRoko) -> Path:
    """A roko workspace as roko serve leaves it while running: serve.json and the launch token."""
    runtime = tmp_path / "ws" / ".roko" / "runtime"
    runtime.mkdir(parents=True)
    (runtime / "serve.json").write_text(
        json.dumps({"pid": 1, "url": roko.url, "workdir": str(tmp_path / "ws")})
    )
    (runtime / "serve.token").write_text(roko.launch_token)
    return tmp_path / "ws"


NOTE = "key: a Hermes started before now holds the old key; the roko page uses the saved one"


def test_saving_a_new_key_over_an_older_one_says_the_page_uses_it(
    roko: FakeRoko, monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    older = roko.add_key("before", "write")
    monkeypatch.setenv("ROKO_API_KEY", older)
    save_in_hermes_env(f"ROKO_API_KEY={older}")
    code = run_cli(Runtime(FakeContext({})), "setup", "--workdir", str(workspace(tmp_path, roko)), "--mint")
    out = capsys.readouterr().out
    assert code == 0, out
    assert NOTE in out and "quit it with ⌘Q" in out
    saved = _hermes.saved_secret("ROKO_API_KEY")
    assert saved and saved != older and saved not in out and older not in out


def test_a_first_key_says_nothing_of_an_older_one(
    roko: FakeRoko, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    code = run_cli(Runtime(FakeContext({})), "setup", "--workdir", str(workspace(tmp_path, roko)), "--mint")
    out = capsys.readouterr().out
    assert code == 0 and "saved ROKO_API_KEY" in out and NOTE not in out, out

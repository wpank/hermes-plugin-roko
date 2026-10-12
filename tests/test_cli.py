from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import _hermes, cli
from hermes_plugin_roko.runtime import Runtime


def run_cli(rt: Runtime, *argv: str) -> int:
    parser = argparse.ArgumentParser(prog="hermes roko")
    cli.build_parser(parser)
    return cli.make_main(rt)(parser.parse_args(list(argv)))


@pytest.fixture
def saved_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> dict[str, str]:
    """Capture what setup stores in Hermes' .env instead of writing a real one."""
    saved: dict[str, str] = {}
    env_file = tmp_path / "hermes.env"

    def save(key: str, value: str) -> Path:
        saved[key] = value
        os.environ[key] = value
        lines = [
            line
            for line in (env_file.read_text().splitlines() if env_file.exists() else [])
            if not line.startswith(f"{key}=")
        ]
        env_file.write_text("\n".join([*lines, f"{key}={value}"]) + "\n")
        return env_file

    monkeypatch.setattr(_hermes, "save_env_value", save)
    return saved


@pytest.fixture
def workspace(tmp_path: Path, fake: FakeRoko) -> Path:
    """A roko workspace as roko serve leaves it while running: serve.json and the launch token."""
    runtime = tmp_path / "ws" / ".roko" / "runtime"
    runtime.mkdir(parents=True)
    (runtime / "serve.json").write_text(
        json.dumps({"pid": 1, "url": fake.url, "workdir": str(tmp_path / "ws")})
    )
    (runtime / "serve.token").write_text(fake.launch_token)
    return tmp_path / "ws"


def test_setup_with_auth_off_stores_only_the_url(
    capsys: pytest.CaptureFixture[str], fake: FakeRoko, saved_env: dict[str, str]
) -> None:
    ctx = FakeContext({})
    code = run_cli(Runtime(ctx), "setup", "--url", fake.url)
    out = capsys.readouterr().out
    assert code == 0, out
    assert "auth: off" in out and ctx.settings["url"] == fake.url and saved_env == {}
    assert ctx.state.get("setup.v1")["url"] == fake.url


def test_setup_mints_a_write_key_with_the_launch_token(
    capsys: pytest.CaptureFixture[str], fake: FakeRoko, workspace: Path, saved_env: dict[str, str]
) -> None:
    fake.auth = True
    ctx = FakeContext({})
    code = run_cli(Runtime(ctx), "setup", "--workdir", str(workspace), "--mint")
    out = capsys.readouterr().out
    assert code == 0, out
    key = saved_env["ROKO_API_KEY"]
    assert fake.keys[key] == {"name": "hermes", "scope": "write"}
    assert ctx.settings == {"url": fake.url, "workdir": str(workspace.resolve())}
    assert ctx.state.get("setup.v1")["key_name"] == "hermes"
    assert "✓ scope: the key can start, cancel and answer runs" in out and "✓ runs:" in out
    assert key not in out


def test_setup_reuses_a_working_key(
    capsys: pytest.CaptureFixture[str],
    fake: FakeRoko,
    monkeypatch: pytest.MonkeyPatch,
    saved_env: dict[str, str],
) -> None:
    fake.auth = True
    monkeypatch.setenv("ROKO_API_KEY", fake.add_key("mine", "write"))
    assert run_cli(Runtime(FakeContext({})), "setup", "--url", fake.url) == 0
    assert "the key in ROKO_API_KEY works" in capsys.readouterr().out and saved_env == {}


def test_setup_needs_a_key_when_auth_is_on(capsys: pytest.CaptureFixture[str], fake: FakeRoko) -> None:
    fake.auth = True
    assert run_cli(Runtime(FakeContext({})), "setup", "--url", fake.url) == cli.EXIT_ACTION
    assert "--mint" in capsys.readouterr().err


def test_setup_mint_without_token(capsys: pytest.CaptureFixture[str], fake: FakeRoko, tmp_path: Path) -> None:
    fake.auth = True
    code = run_cli(Runtime(FakeContext({})), "setup", "--url", fake.url, "--workdir", str(tmp_path), "--mint")
    assert code == cli.EXIT_ACTION and "no launch token" in capsys.readouterr().err


def test_setup_existing_key_name_needs_yes(
    capsys: pytest.CaptureFixture[str], fake: FakeRoko, workspace: Path, saved_env: dict[str, str]
) -> None:
    fake.auth = True
    old = fake.add_key("hermes", "write")
    rt = Runtime(FakeContext({}))
    assert run_cli(rt, "setup", "--workdir", str(workspace), "--mint") == cli.EXIT_ACTION
    assert "--yes" in capsys.readouterr().err and old in fake.keys
    assert run_cli(rt, "setup", "--workdir", str(workspace), "--mint", "--yes") == 0
    assert old not in fake.keys and fake.keys[saved_env["ROKO_API_KEY"]]["name"] == "hermes"


def test_setup_key_from_stdin(
    capsys: pytest.CaptureFixture[str],
    fake: FakeRoko,
    monkeypatch: pytest.MonkeyPatch,
    saved_env: dict[str, str],
) -> None:
    import io

    fake.auth = True
    key = fake.add_key("given", "write")
    monkeypatch.setattr("sys.stdin", io.StringIO(key + "\n"))
    assert run_cli(Runtime(FakeContext({})), "setup", "--url", fake.url, "--key-stdin") == 0
    assert saved_env["ROKO_API_KEY"] == key
    monkeypatch.setattr("sys.stdin", io.StringIO("roko_wrong\n"))
    assert run_cli(Runtime(FakeContext({})), "setup", "--url", fake.url, "--key-stdin") == cli.EXIT_FAIL


def test_setup_dry_run_saves_nothing(fake: FakeRoko, saved_env: dict[str, str]) -> None:
    ctx = FakeContext({})
    assert run_cli(Runtime(ctx), "setup", "--url", fake.url, "--dry-run") == 0
    assert ctx.settings == {} and saved_env == {}


def test_setup_unreachable(capsys: pytest.CaptureFixture[str]) -> None:
    assert run_cli(Runtime(FakeContext({})), "setup", "--url", "http://127.0.0.1:9") == cli.EXIT_UNREACHABLE
    assert "could not reach roko serve" in capsys.readouterr().err


def test_doctor_reports_the_boundary(capsys: pytest.CaptureFixture[str], fake: FakeRoko) -> None:
    fake.boundary = False
    rt = Runtime(FakeContext({"url": fake.url}))
    assert run_cli(rt, "doctor") == cli.EXIT_FAIL
    out = capsys.readouterr().out
    assert "✗ runs: roko refuses runs started from Hermes" in out and "allow_without_data_llm" in out
    assert not fake.runs  # the probe started nothing
    assert run_cli(rt, "doctor", "--no-probe") == 0


def test_doctor_json_and_exit_codes(capsys: pytest.CaptureFixture[str], fake: FakeRoko) -> None:
    rt = Runtime(FakeContext({"url": fake.url}))
    assert run_cli(rt, "doctor", "--json") == 0
    checks = {check["name"]: check["status"] for check in json.loads(capsys.readouterr().out)["checks"]}
    assert checks["reachable"] == checks["mcp"] == checks["runs"] == "ok"
    down = Runtime(FakeContext({"url": "http://127.0.0.1:9"}))
    assert run_cli(down, "doctor") == cli.EXIT_UNREACHABLE
    assert run_cli(down, "doctor", "--offline") == 0
    bad = Runtime(FakeContext({"url": fake.url, "max_run_usd": "lots"}))
    assert run_cli(bad, "doctor", "--strict") == cli.EXIT_ACTION


def test_status(capsys: pytest.CaptureFixture[str], fake: FakeRoko) -> None:
    assert run_cli(Runtime(FakeContext({"url": fake.url})), "status") == 0
    assert "roko 0.1.0 at" in capsys.readouterr().out


def test_no_subcommand_prints_usage(capsys: pytest.CaptureFixture[str]) -> None:
    # Bare `hermes roko` is a request for the usage, not a mistake.
    assert run_cli(Runtime(FakeContext({}))) == cli.EXIT_OK
    assert "usage: hermes roko" in capsys.readouterr().out


def test_parser_builds_on_a_hostile_parser() -> None:
    class Hostile(argparse.ArgumentParser):
        def add_subparsers(self, **kwargs: Any) -> Any:
            raise RuntimeError("no")

    cli.build_parser(Hostile())  # must not raise into Hermes


def test_doctor_flags_a_duplicate_mcp_entry_and_a_missing_gate(
    capsys: pytest.CaptureFixture[str], fake: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(_hermes, "mcp_servers", lambda: {"roko": {"url": f"{fake.url}/mcp"}})
    monkeypatch.setattr(_hermes, "approval_gate_available", lambda: False)
    rt = Runtime(FakeContext({"url": fake.url}))
    assert run_cli(rt, "doctor", "--offline") == cli.EXIT_FAIL
    out = capsys.readouterr().out
    assert "! mcp: Hermes also has roko as an MCP server (mcp_servers.roko)" in out
    assert "✗ approvals:" in out
    rt.ctx.settings["approve_paid"] = False
    assert run_cli(rt, "doctor", "--offline") == 0  # only a warning once approvals are off


def test_doctor_notices_the_launch_token(
    capsys: pytest.CaptureFixture[str], fake: FakeRoko, workspace: Path
) -> None:
    fake.auth = True
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    assert run_cli(rt, "doctor", "--strict") == cli.EXIT_ACTION
    assert "launch token" in capsys.readouterr().out


def test_setup_reports_a_managed_install_instead_of_crashing(
    capsys: pytest.CaptureFixture[str], fake: FakeRoko, saved_env: dict[str, str]
) -> None:
    class Managed(FakeContext):
        def set_config(self, key: str, value: Any) -> None:
            raise PermissionError("Plugin settings cannot be changed in a managed install")

    assert run_cli(Runtime(Managed({})), "setup", "--url", fake.url) == cli.EXIT_FAIL
    assert "managed install" in capsys.readouterr().err


def test_setup_notices_when_hermes_did_not_save_the_key(
    capsys: pytest.CaptureFixture[str],
    fake: FakeRoko,
    workspace: Path,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    fake.auth = True
    monkeypatch.setattr(_hermes, "save_env_value", lambda key, value: tmp_path / "never-written.env")
    assert run_cli(Runtime(FakeContext({})), "setup", "--workdir", str(workspace), "--mint") == cli.EXIT_FAIL
    assert "did not save ROKO_API_KEY" in capsys.readouterr().err


def test_rotating_a_read_key_is_refused(
    capsys: pytest.CaptureFixture[str], fake: FakeRoko, workspace: Path, saved_env: dict[str, str]
) -> None:
    fake.auth = True
    fake.add_key("hermes", "read")
    code = run_cli(Runtime(FakeContext({})), "setup", "--workdir", str(workspace), "--mint", "--yes")
    assert code == cli.EXIT_FAIL and "read scope" in capsys.readouterr().err and saved_env == {}


def test_doctor_catches_a_read_only_key(
    capsys: pytest.CaptureFixture[str], fake: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake.auth = True
    monkeypatch.setenv("ROKO_API_KEY", fake.add_key("viewer", "read"))
    assert run_cli(Runtime(FakeContext({"url": fake.url})), "doctor", "--no-probe") == cli.EXIT_FAIL
    assert "✗ scope: the key is read-only" in capsys.readouterr().out
    assert not fake.runs  # the scope probe cancels a run that does not exist

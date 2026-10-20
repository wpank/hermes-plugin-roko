from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from hermes_plugin_roko.settings import is_loopback_url, load_settings


def settings_from(values: dict[str, Any]) -> Any:
    return load_settings(lambda key, default=None: values.get(key, default))


def test_defaults() -> None:
    s = load_settings(None)
    # 0.7.0: no URL at all without a project (nothing falls back to port 6677).
    assert (s.url, s.url_source, s.workdir, s.remote) == ("", "none", None, False)
    assert (s.auto_start, s.roko_bin, s.idle_exit_minutes) == (True, None, 60)
    assert (s.api_key_env, s.max_run_usd, s.approve_paid, s.confirm_decisions) == (
        "ROKO_API_KEY",
        5.0,
        True,
        True,
    )
    assert s.problems == () and s.credential().source == "none"


def test_url_precedence(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    runtime = tmp_path / ".roko" / "runtime"
    runtime.mkdir(parents=True)
    (runtime / "serve.json").write_text(json.dumps({"pid": 1, "url": "http://127.0.0.1:7001/"}))
    assert settings_from({"workdir": str(tmp_path)}).url == "http://127.0.0.1:7001"
    # 0.7.0: a project's URL comes from its serve.json; a loopback `url` setting (0.5 and 0.6 saved one) is
    # used only while that project has none.
    pinned = settings_from({"workdir": str(tmp_path), "url": "http://127.0.0.1:7002"})
    assert (pinned.url, pinned.url_source, pinned.remote) == ("http://127.0.0.1:7001", "serve.json", False)
    (runtime / "serve.json").unlink()
    legacy = settings_from({"workdir": str(tmp_path), "url": "http://127.0.0.1:7002"})
    assert (legacy.url, legacy.url_source) == ("http://127.0.0.1:7002", "settings")
    assert legacy.for_project(tmp_path / "other").url == ""  # never another project's
    remote = settings_from({"workdir": str(tmp_path), "url": "https://roko.example.com"})
    assert (remote.url, remote.url_source, remote.remote) == ("https://roko.example.com", "settings", True)
    monkeypatch.setenv("ROKO_SERVE_URL", "http://127.0.0.1:7003")
    assert settings_from({"url": "http://127.0.0.1:7002"}).url_source == "env:ROKO_SERVE_URL"
    monkeypatch.setenv("ROKO_URL", "http://127.0.0.1:7004/")
    s = settings_from({"url": "http://127.0.0.1:7002"})
    assert (s.url, s.url_source, s.remote) == ("http://127.0.0.1:7004", "env:ROKO_URL", True)


@pytest.mark.parametrize(
    ("values", "problem"),
    [
        ({"url": "ftp://x"}, "not an http(s) URL"),
        ({"url": 42}, "expected a string"),
        ({"url": "http://roko.example.com:6677"}, "travel unencrypted"),
        ({"max_run_usd": "lots"}, "max_run_usd"),
        ({"max_run_usd": -1}, "must be above 0"),
        ({"approve_paid": "maybe"}, "approve_paid"),
        ({"api_key_env": "not a name"}, "api_key_env"),
        ({"workdir": "/definitely/not/here"}, "not a directory"),
    ],
)
def test_bad_values_become_problems_not_exceptions(values: dict[str, Any], problem: str) -> None:
    s = settings_from(values)
    assert any(problem in p for p in s.problems), s.problems


def test_https_and_explicit_opt_in_are_fine() -> None:
    assert settings_from({"url": "https://roko.example.com"}).problems == ()
    assert settings_from({"url": "http://10.0.0.2:6677", "allow_insecure_remote": True}).problems == ()


def test_booleans_from_strings() -> None:
    s = settings_from({"approve_paid": "false", "confirm_decisions": "yes", "prompt_section": False})
    assert (s.approve_paid, s.confirm_decisions, s.prompt_section) == (False, True, False)


def test_credential_from_the_named_env_var(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MY_ROKO_KEY", " roko_abc ")
    credential = settings_from({"api_key_env": "MY_ROKO_KEY"}).credential()
    assert (credential.value, credential.source) == ("roko_abc", "env:MY_ROKO_KEY")


def test_launch_token_only_on_loopback_and_first_there(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    runtime = tmp_path / ".roko" / "runtime"
    runtime.mkdir(parents=True)
    (runtime / "serve.token").write_text("a" * 64 + "\n")
    local = settings_from({"workdir": str(tmp_path)}).credential()
    assert local.value == "a" * 64 and local.source.startswith("launch-token:")
    remote = settings_from({"workdir": str(tmp_path), "url": "https://roko.example.com"}).credential()
    assert remote.source == "none"
    # 0.7.0: each project has its own roko serve, so its launch token comes before the configured key.
    monkeypatch.setenv("ROKO_API_KEY", "roko_configured")
    assert settings_from({"workdir": str(tmp_path)}).credential().source.startswith("launch-token:")
    assert settings_from({"workdir": str(tmp_path)}).configured_key().source == "env:ROKO_API_KEY"


def test_redacted_never_holds_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ROKO_API_KEY", "roko_secret_value")
    assert "roko_secret_value" not in json.dumps(load_settings(None).redacted())


@pytest.mark.parametrize(
    ("url", "loopback"),
    [
        ("http://127.0.0.1:1", True),
        ("http://localhost", True),
        ("http://[::1]:6677", True),
        ("http://127.1.2.3", True),
        ("http://127.0.0.1.attacker.example", False),
        ("http://localhost.attacker.example", False),
        ("http://10.0.0.1", False),
        ("https://roko.dev", False),
    ],
)
def test_loopback(url: str, loopback: bool) -> None:
    assert is_loopback_url(url) is loopback


def test_serve_json_may_only_point_at_this_machine(tmp_path: Path) -> None:
    runtime = tmp_path / ".roko" / "runtime"
    runtime.mkdir(parents=True)
    (runtime / "serve.json").write_text(json.dumps({"url": "https://collector.example"}))
    s = settings_from({"workdir": str(tmp_path)})
    assert s.url == "" and any("non-loopback" in p for p in s.problems)


def test_unusable_workdirs_are_problems_not_crashes() -> None:
    s = settings_from({"workdir": "~no-such-user-for-roko/ws"})
    assert s.workdir is None and any("cannot be used" in p for p in s.problems)


def test_display_url_hides_credentials() -> None:
    s = settings_from({"url": "https://user:secret@roko.example:8443/base"})
    assert "secret" not in s.display_url and s.display_url == "https://roko.example:8443/base"
    assert "secret" not in json.dumps(s.redacted())

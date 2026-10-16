"""The plugin's settings: `plugins.entries.roko.settings` in Hermes' config.yaml.

Settings are read on every use rather than once at load, so `hermes roko
setup` or `hermes config set plugins.entries.roko.settings.url ...` take
effect without restarting a running gateway. A value of the wrong type is
replaced by its default and reported as a problem, never raised: the plugin
must keep loading so `hermes roko doctor` can explain what is wrong.
"""

from __future__ import annotations

import ipaddress
import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import _hermes

DEFAULT_URL = "http://127.0.0.1:6677"
DEFAULT_KEY_ENV = "ROKO_API_KEY"
# roko serve's own default for [serve.mcp] max_run_usd.
DEFAULT_MAX_RUN_USD = 5.0
# The most runs started from Hermes may spend in one day, all together.
DEFAULT_MAX_DAY_USD = 20.0
URL_ENV_VARS = ("ROKO_URL", "ROKO_SERVE_URL")

ConfigGetter = Callable[[str, Any], Any]


@dataclass(frozen=True)
class Credential:
    """The API key the plugin sends, and where it came from (never the value in output)."""

    value: str | None
    source: str

    @property
    def present(self) -> bool:
        return bool(self.value)


@dataclass(frozen=True)
class Settings:
    url: str
    url_source: str
    workdir: Path | None
    api_key_env: str
    max_run_usd: float
    max_day_usd: float | None
    approve_paid: bool
    confirm_decisions: bool
    prompt_section: bool
    allow_insecure_remote: bool
    timeout_s: float
    ui_actions: bool = True
    # Refuse Hermes' background review a skill or memory that teaches repairing roko (learning_guard.py).
    # Opt-in: while any plugin hook is registered, Hermes 0.22 can block concurrent tool calls without ids.
    learning_guard: bool = False
    problems: tuple[str, ...] = field(default=())

    @property
    def is_loopback(self) -> bool:
        return is_loopback_url(self.url)

    @property
    def display_url(self) -> str:
        """The URL without any user:password part, for output."""
        return display_url(self.url)

    def credential(self) -> Credential:
        """Resolve the key now, so a key stored by `hermes roko setup` is seen at once."""
        key = _hermes.get_secret(self.api_key_env)
        if key:
            return Credential(key.strip(), f"env:{self.api_key_env}")
        token = self.launch_token_path()
        if token is not None and self.is_loopback:
            try:
                value = token.read_text(encoding="utf-8").strip()
            except OSError:
                value = ""
            if value:
                return Credential(value, f"launch-token:{token}")
        return Credential(None, "none")

    def launch_token_path(self) -> Path | None:
        if self.workdir is None:
            return None
        path = self.workdir / ".roko" / "runtime" / "serve.token"
        try:
            return path if path.is_file() else None
        except OSError:  # e.g. a workspace this process may not enter
            return None

    def redacted(self) -> dict[str, object]:
        """Settings as a dict that is safe to print."""
        return {
            "url": self.display_url,
            "url_source": self.url_source,
            "workdir": str(self.workdir) if self.workdir else None,
            "api_key_env": self.api_key_env,
            "credential": self.credential().source,
            "max_run_usd": self.max_run_usd,
            "max_day_usd": self.max_day_usd,
            "approve_paid": self.approve_paid,
            "confirm_decisions": self.confirm_decisions,
            "prompt_section": self.prompt_section,
            "allow_insecure_remote": self.allow_insecure_remote,
            "timeout_s": self.timeout_s,
            "ui_actions": self.ui_actions,
            "learning_guard": self.learning_guard,
            "problems": list(self.problems),
        }


def load_settings(get: ConfigGetter | None) -> Settings:
    problems: list[str] = []

    def read(key: str) -> Any:
        if get is None:
            return None
        try:
            return get(key, None)
        except Exception as exc:  # a malformed config must not break the plugin
            problems.append(f"{key}: could not be read ({exc})")
            return None

    workdir = _as_path(read("workdir"), "workdir", problems)
    url, url_source = _resolve_url(read("url"), workdir, problems)
    allow_insecure_remote = _as_bool(read("allow_insecure_remote"), False, "allow_insecure_remote", problems)
    if urlsplit(url).scheme == "http" and not is_loopback_url(url) and not allow_insecure_remote:
        problems.append(
            f"url: {display_url(url)} is plain http to another host; the API key would travel "
            "unencrypted (use https, or set allow_insecure_remote: true)"
        )
    return Settings(
        url=url,
        url_source=url_source,
        workdir=workdir,
        api_key_env=_as_env_name(read("api_key_env"), problems),
        max_run_usd=_as_positive_float(read("max_run_usd"), DEFAULT_MAX_RUN_USD, "max_run_usd", problems),
        max_day_usd=_as_limit(read("max_day_usd"), DEFAULT_MAX_DAY_USD, "max_day_usd", problems),
        approve_paid=_as_bool(read("approve_paid"), True, "approve_paid", problems),
        confirm_decisions=_as_bool(read("confirm_decisions"), True, "confirm_decisions", problems),
        prompt_section=_as_bool(read("prompt_section"), True, "prompt_section", problems),
        allow_insecure_remote=allow_insecure_remote,
        timeout_s=_as_positive_float(read("timeout_s"), 20.0, "timeout_s", problems),
        ui_actions=_as_bool(read("ui_actions"), True, "ui_actions", problems),
        learning_guard=_as_bool(read("learning_guard"), False, "learning_guard", problems),
        problems=tuple(problems),
    )


def is_loopback_url(url: str) -> bool:
    """Whether `url` names this machine: `localhost`, or a loopback IP literal.

    A name merely starting with "127." (such as 127.0.0.1.example.com) is not
    loopback: it resolves wherever its owner wants.
    """
    try:
        host = (urlsplit(url).hostname or "").lower()
    except ValueError:
        return False
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def display_url(url: str) -> str:
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if parts.username is None and parts.password is None:
        return url
    host = parts.hostname or ""
    if ":" in host:
        host = f"[{host}]"
    netloc = f"{host}:{parts.port}" if parts.port else host
    return parts._replace(netloc=netloc).geturl()


def read_serve_endpoint(workdir: Path) -> dict[str, Any] | None:
    """The `{pid, url, workdir, started_at}` roko serve writes while it runs."""
    path = workdir / ".roko" / "runtime" / "serve.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _resolve_url(configured: Any, workdir: Path | None, problems: list[str]) -> tuple[str, str]:
    for name in URL_ENV_VARS:
        value = os.environ.get(name, "").strip()
        if value:
            return _normalize_url(value, f"env {name}", problems), f"env:{name}"
    if isinstance(configured, str) and configured.strip():
        return _normalize_url(configured, "url", problems), "settings"
    if configured not in (None, ""):
        problems.append("url: expected a string; using the default")
    if workdir is not None:
        endpoint = read_serve_endpoint(workdir)
        url = endpoint.get("url") if endpoint else None
        if isinstance(url, str) and url.strip():
            # serve.json is a file in the workspace: anything that can write the
            # workspace could point the key at another host, so only a loopback
            # URL is taken from it.
            if is_loopback_url(url):
                return _normalize_url(url, "serve.json url", problems), "workdir"
            problems.append(f"workdir: ignored the non-loopback URL in serve.json ({display_url(url)})")
    return DEFAULT_URL, "default"


def _normalize_url(value: str, label: str, problems: list[str]) -> str:
    url = value.strip().rstrip("/")
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
    except ValueError:
        hostname = None
        parts = urlsplit("")
    if parts.scheme not in ("http", "https") or not hostname:
        problems.append(f"{label}: {value!r} is not an http(s) URL; using {DEFAULT_URL}")
        return DEFAULT_URL
    return url


def _as_path(value: Any, label: str, problems: list[str]) -> Path | None:
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        problems.append(f"{label}: expected a path string")
        return None
    try:
        path = Path(value).expanduser()
        if not path.is_dir():
            problems.append(f"{label}: {path} is not a directory")
    except (OSError, RuntimeError) as exc:  # ~nosuchuser, or a directory we may not enter
        problems.append(f"{label}: {value!r} cannot be used ({exc})")
        return None
    return path


def _as_env_name(value: Any, problems: list[str]) -> str:
    if value in (None, ""):
        return DEFAULT_KEY_ENV
    if isinstance(value, str) and value.replace("_", "").isalnum() and not value[0].isdigit():
        return value
    problems.append(f"api_key_env: {value!r} is not an environment variable name")
    return DEFAULT_KEY_ENV


def _as_bool(value: Any, default: bool, label: str, problems: list[str]) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, str) and value.strip().lower() in ("true", "yes", "on", "1"):
        return True
    if isinstance(value, str) and value.strip().lower() in ("false", "no", "off", "0"):
        return False
    problems.append(f"{label}: expected true or false; using {default}")
    return default


def _as_positive_float(value: Any, default: float, label: str, problems: list[str]) -> float:
    if value is None:
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        problems.append(f"{label}: expected a number; using {default}")
        return default
    if number <= 0 or number != number:  # also rejects NaN
        problems.append(f"{label}: must be above 0; using {default}")
        return default
    return number


def _as_limit(value: Any, default: float, label: str, problems: list[str]) -> float | None:
    """A spending limit in dollars, where 0 (or "off") turns the limit off."""
    if value is None:
        return default
    if isinstance(value, str) and value.strip().lower() in ("off", "none", "unlimited"):
        return None
    if isinstance(value, bool):
        problems.append(f"{label}: expected a number of dollars, or 0 for no limit; using {default}")
        return default
    try:
        number = float(value)
    except (TypeError, ValueError):
        problems.append(f"{label}: expected a number of dollars, or 0 for no limit; using {default}")
        return default
    if number != number or number < 0:
        problems.append(f"{label}: must be 0 or more; using {default}")
        return default
    return None if number == 0 else number

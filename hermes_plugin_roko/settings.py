"""The plugin's settings: `plugins.entries.roko.settings` in Hermes' config.yaml.

Settings are read on every use rather than once at load, so `hermes roko
setup` or `hermes config set plugins.entries.roko.settings.url ...` take
effect without restarting a running gateway. A value of the wrong type is
replaced by its default and reported as a problem, never raised: the plugin
must keep loading so `hermes roko doctor` can explain what is wrong.

Since 0.7.0 each project has its own roko serve, and a project's URL comes
from the `.roko/runtime/serve.json` that serve writes (`for_project`). A URL
from ROKO_URL, or a `url` setting that is not on this machine, is a remote pin
instead: one project, and the plugin starts and stops nothing. A loopback `url`
setting (0.5 and 0.6 saved one) is used only for the `workdir` setting's own
project while that has no serve.json. Nothing falls back to port 6677.
"""

from __future__ import annotations

import ipaddress
import json
import os
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import _hermes

DEFAULT_URL = "http://127.0.0.1:6677"
DEFAULT_KEY_ENV = "ROKO_API_KEY"
# How long a roko serve the plugin starts stays up without work before it stops itself (0: never).
DEFAULT_IDLE_EXIT_MINUTES = 60
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
    url: str  # "" while no roko serve runs for the project (its serve.json names none)
    url_source: str  # env:ROKO_URL | settings | serve.json | none (setup: what `hermes roko setup` checks)
    workdir: Path | None  # the project these settings are about (0.7.0); the `workdir` setting by default
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
    # 0.7.0: start a project's roko serve when Hermes needs it; the roko binary to use (None: find it); how
    # long a serve the plugin starts stays up without work (0: never).
    auto_start: bool = True
    roko_bin: str | None = None
    idle_exit_minutes: int = DEFAULT_IDLE_EXIT_MINUTES
    # A remote pin (ROKO_URL, or a `url` setting not on this machine): one project, nothing started or
    # stopped.
    remote: bool = False
    # The `workdir` setting itself, and a loopback `url` setting (legacy: used only for that workdir's
    # project).
    workdir_setting: Path | None = None
    legacy_url: str | None = None

    @property
    def is_loopback(self) -> bool:
        """Whether roko serve is on this machine: its URL is, or (no serve runs yet) the project is local."""
        if not self.url:
            return not self.remote
        return is_loopback_url(self.url)

    @property
    def display_url(self) -> str:
        """The URL without any user:password part, for output."""
        return display_url(self.url)

    @property
    def where(self) -> str:
        """Where roko serve is, for a sentence: "roko serve at URL", or "roko serve for <project>"."""
        if self.url:
            return f"roko serve at {self.display_url}"
        if self.workdir is not None:
            return f"roko serve for {self.workdir}"
        return "roko serve"

    def for_project(self, project: Path | None) -> Settings:
        """These settings for `project`, whose URL comes from its serve.json (module docstring). A remote pin
        has one project, the `workdir` setting's, whatever `project` says."""
        if self.remote:
            return self
        problems: list[str] = []
        url, source = _project_url(project, self.workdir_setting, self.legacy_url, problems)
        return replace(
            self,
            url=url,
            url_source=source,
            workdir=project,
            problems=tuple(dict.fromkeys([*self.problems, *problems])),
        )

    def credential(self) -> Credential:
        """Resolve the key now, so a key stored by `hermes roko setup` is seen at once.

        On this machine the project's launch token (`serve.token`, which its roko serve writes at every start
        when auth is on) comes first: each project has its own roko serve, and one key would not work for all
        of them. Otherwise, and for a remote pin always, the configured key.
        """
        if not self.remote and self.is_loopback:
            token = self.launch_token_path()
            if token is not None:
                try:
                    value = token.read_text(encoding="utf-8").strip()
                except OSError:
                    value = ""
                if value:
                    return Credential(value, f"launch-token:{token}")
        return self.configured_key()

    def configured_key(self) -> Credential:
        """The key in the environment variable `api_key_env` names (Hermes' .env), never a launch token."""
        key = _hermes.get_secret(self.api_key_env)
        if key:
            return Credential(key.strip(), f"env:{self.api_key_env}")
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
            "url": self.display_url or None,
            "url_source": self.url_source,
            "workdir": str(self.workdir) if self.workdir else None,
            "remote": self.remote,
            "auto_start": self.auto_start,
            "roko_bin": self.roko_bin,
            "idle_exit_minutes": self.idle_exit_minutes,
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
    pinned, legacy = _configured_url(read("url"), problems)
    allow_insecure_remote = _as_bool(read("allow_insecure_remote"), False, "allow_insecure_remote", problems)
    if pinned is not None:
        url, url_source = pinned
        if urlsplit(url).scheme == "http" and not is_loopback_url(url) and not allow_insecure_remote:
            problems.append(
                f"url: {display_url(url)} is plain http to another host; the API key would travel "
                "unencrypted (use https, or set allow_insecure_remote: true)"
            )
    else:
        url, url_source = _project_url(workdir, workdir, legacy, problems)
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
        auto_start=_as_bool(read("auto_start"), True, "auto_start", problems),
        roko_bin=_as_command(read("roko_bin"), problems),
        idle_exit_minutes=_as_minutes(read("idle_exit_minutes"), problems),
        problems=tuple(problems),  # last: every value above may add one
        remote=pinned is not None,
        workdir_setting=workdir,
        legacy_url=legacy,
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
    """What roko serve writes while it runs: `{pid, url, workdir, started_at}`, and since 0.7.0's roko its
    identity (`instance_id`, `port`, `version`, `git_sha`, `exe`, `idle_exit_secs`, `args`)."""
    path = workdir / ".roko" / "runtime" / "serve.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _configured_url(configured: Any, problems: list[str]) -> tuple[tuple[str, str] | None, str | None]:
    """(the remote pin and its source, or None; a loopback `url` setting, or None). ROKO_URL (or
    ROKO_SERVE_URL) pins whatever it names; the `url` setting pins only a URL that is not on this machine."""
    for name in URL_ENV_VARS:
        value = os.environ.get(name, "").strip()
        if value:
            return (_normalize_url(value, f"env {name}", problems), f"env:{name}"), None
    if isinstance(configured, str) and configured.strip():
        url = _normalize_url(configured, "url", problems)
        if url and not is_loopback_url(url):
            return (url, "settings"), None
        return None, url or None
    if configured not in (None, ""):
        problems.append("url: expected a string; ignored")
    return None, None


def _project_url(
    project: Path | None, workdir: Path | None, legacy: str | None, problems: list[str]
) -> tuple[str, str]:
    """A local project's URL: its serve.json's, else a loopback `url` setting when the project is the
    `workdir` setting's (or there is none), else none."""
    if project is not None:
        endpoint = read_serve_endpoint(project)
        url = endpoint.get("url") if endpoint else None
        if isinstance(url, str) and url.strip():
            # serve.json is a file in the workspace: anything that can write the
            # workspace could point the key at another host, so only a loopback
            # URL is taken from it.
            if is_loopback_url(url):
                return _normalize_url(url, "serve.json url", problems), "serve.json"
            problems.append(f"workdir: ignored the non-loopback URL in serve.json ({display_url(url)})")
    if legacy and same_path(project, workdir):
        return legacy, "settings"
    return "", "none"


def same_path(one: Path | None, two: Path | None) -> bool:
    """Whether two paths name the same folder (both None counts)."""
    if one is None or two is None:
        return one is two
    if one == two:
        return True
    try:
        return one.expanduser().resolve() == two.expanduser().resolve()
    except (OSError, RuntimeError):
        return False


def _normalize_url(value: str, label: str, problems: list[str]) -> str:
    url = value.strip().rstrip("/")
    try:
        parts = urlsplit(url)
        hostname = parts.hostname
    except ValueError:
        hostname = None
        parts = urlsplit("")
    if parts.scheme not in ("http", "https") or not hostname:
        problems.append(f"{label}: {value!r} is not an http(s) URL; ignored")
        return ""
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


def _as_command(value: Any, problems: list[str]) -> str | None:
    """`roko_bin`: a path to roko (`~` allowed), or None to find it."""
    if value in (None, ""):
        return None
    if not isinstance(value, str):
        problems.append("roko_bin: expected a path to the roko binary; finding roko instead")
        return None
    return value.strip() or None


def _as_minutes(value: Any, problems: list[str]) -> int:
    """`idle_exit_minutes`: a whole number of minutes, 0 or more (0: never)."""
    if value is None:
        return DEFAULT_IDLE_EXIT_MINUTES
    if isinstance(value, bool):
        problems.append(f"idle_exit_minutes: expected minutes; using {DEFAULT_IDLE_EXIT_MINUTES}")
        return DEFAULT_IDLE_EXIT_MINUTES
    try:
        number = float(value)
    except (TypeError, ValueError):
        problems.append(f"idle_exit_minutes: expected minutes; using {DEFAULT_IDLE_EXIT_MINUTES}")
        return DEFAULT_IDLE_EXIT_MINUTES
    if number != number or number < 0 or number > 7 * 24 * 60:
        problems.append(
            f"idle_exit_minutes: must be from 0 to a week (10080); using {DEFAULT_IDLE_EXIT_MINUTES}"
        )
        return DEFAULT_IDLE_EXIT_MINUTES
    return int(number)


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

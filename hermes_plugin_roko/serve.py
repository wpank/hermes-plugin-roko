"""roko serve, one per project: find roko, look at a project's serve, start, stop and restart it (0.7.0).

The plugin starts roko serve only with `roko serve --detach --json`: roko spawns the serve in a session of its
own, its output appended to `<project>/.roko/logs/serve.log`, and answers once it listens. So the serve keeps
running after Hermes quits (runs in flight finish), never writes into Hermes' pipes, and with `--idle-exit`
stops itself once it has had no work for `idle_exit_minutes`. The plugin never kills a process: it stops and
restarts a serve only through `roko serve stop|restart`, which act only on a serve that passes roko's own
identity check.

Who starts one: the desktop page when the app opens and the dashboard when it loads (`POST /serve
{"action": "ensure"}`), an overview that finds the project's serve stopped, a tool before its first roko call,
and `hermes roko init` or `hermes roko serve start`. Never `register()`, which runs in every Hermes process,
`plugins validate` included. A start takes a lock file per project in the plugin's data dir first, so the
desktop backend, a chat and the CLI never start two at once, and leaves a marker there that every Hermes
process reads: `starting` while it runs, `failed` (with roko's reason and its log's last lines) once it
failed, `started` (the serve's instance id, for `started_by: hermes`) once it listens.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import logging
import os
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from . import _hermes
from .errors import Code, RokoError
from .runtime import Runtime
from .sanitize import clean
from .settings import Settings, is_loopback_url, read_serve_endpoint, same_path

logger = logging.getLogger(__name__)

# How long `roko serve --detach` may take (roko itself waits up to 60 s for the serve to listen), and how long
# a tool or the CLI waits for a start, another process's included.
START_TIMEOUT_S = 75.0
START_WAIT_S = 90.0
# After a start failed, an automatic one (the app opening, an overview, a tool) waits this long; Start does
# not.
FAILED_PAUSE_S = 60.0
# A `starting` marker counts while the process that wrote it lives, and at most this long.
STARTING_MAX_S = 120.0
STOP_TIMEOUT_S = 20
STOP_COMMAND_S = 45.0
RESTART_COMMAND_S = 120.0
VERSION_TIMEOUT_S = 10.0
HEALTH_TIMEOUT_S = 5.0
# One silent look at a serve that answered within this long is a busy serve, not a dead one.
VOUCH_S = 60.0
LOG_TAIL = 20
# How long a lookup of the roko binary is reused, when nothing about it changed.
FIND_CACHE_S = 30.0

# The keys roko calls models with, as `roko init` looks for them, and who issues each.
ROKO_KEYS = {
    "OPENAI_API_KEY": "OpenAI",
    "ANTHROPIC_API_KEY": "Anthropic",
    "OPENROUTER_API_KEY": "OpenRouter",
    "CEREBRAS_API_KEY": "Cerebras",
    "ZAI_API_KEY": "Z.ai",
    "MOONSHOT_API_KEY": "Moonshot",
}
# What any process needs to run: kept for roko even when Hermes' .env names it.
PROCESS_ENV = frozenset({"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"})

INSTALL_COMMAND = "cargo install --path crates/roko-cli"
INSTALL_DOCS = "getting-started.md#install-roko"
SERVE_DOCS = "troubleshooting.md#roko-serve-is-not-reachable"

STATES = ("running", "starting", "stopped", "failed", "outdated", "not_found", "remote")


# -- the roko binary -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class Found:
    """The roko binary the plugin uses, and whether it can start a serve in the background."""

    path: str | None
    source: str | None  # setting | env | roko_home | path | cargo
    version: str | None
    git_sha: str | None
    detach: bool  # `roko serve --help` lists --detach
    problem: str | None  # None | not_found | too_old


@dataclass(frozen=True)
class _Probe:
    runs: bool
    version: str | None
    git_sha: str | None
    detach: bool


_PROBES: dict[tuple[str, int, int], _Probe] = {}
_FOUND: dict[tuple[Any, ...], tuple[float, Found]] = {}
_FIND_LOCK = threading.Lock()


def find_roko(rt: Runtime, settings: Settings | None = None, *, cached_only: bool = False) -> Found | None:
    """The roko binary to use: the `roko_bin` setting, `ROKO_BIN`, `~/.roko/bin/roko`, `roko` on PATH, then
    `~/.cargo/bin/roko`. A binary the setting or ROKO_BIN names is used even when it is too old (reported
    `too_old`); otherwise the first that has `serve --detach`, else the first that runs (`too_old`).

    Each candidate is run (`--version`, `serve --help`) once per file version. `cached_only` answers from the
    last lookup without running anything (None when there was none), for views that must not wait.
    """
    settings = settings or rt.settings()
    candidates = _candidates(settings)
    key = (tuple(path for path, _ in candidates), *(_stamp(path) for path, _ in candidates))
    with _FIND_LOCK:
        hit = _FOUND.get(key)
        if hit is not None and (cached_only or time.monotonic() - hit[0] < FIND_CACHE_S):
            return hit[1]
        if cached_only:
            last = max(_FOUND.values(), key=lambda entry: entry[0], default=None)
            return last[1] if last is not None else None
    found = _find(candidates)
    with _FIND_LOCK:
        _FOUND[key] = (time.monotonic(), found)
        while len(_FOUND) > 16:
            del _FOUND[next(iter(_FOUND))]
    return found


def _candidates(settings: Settings) -> list[tuple[str, str]]:
    found: list[tuple[str, str]] = []
    if settings.roko_bin:
        found.append((str(Path(settings.roko_bin).expanduser()), "setting"))
    env = os.environ.get("ROKO_BIN", "").strip()
    if env:
        found.append((str(Path(env).expanduser()), "env"))
    found.extend(_known_locations())
    seen: set[str] = set()
    unique = []
    for path, source in found:
        real = os.path.realpath(path)
        if real not in seen:
            seen.add(real)
            unique.append((path, source))
    return unique


def _known_locations() -> list[tuple[str, str]]:
    """Where roko is when nothing names it: roko's own bin folder, PATH, then cargo's bin folder."""
    found = [(str(Path.home() / ".roko" / "bin" / "roko"), "roko_home")]
    which = shutil.which("roko")
    if which:
        found.append((which, "path"))
    found.append((str(Path.home() / ".cargo" / "bin" / "roko"), "cargo"))
    return found


def _stamp(path: str) -> tuple[int, int] | None:
    try:
        info = os.stat(path)
    except OSError:
        return None
    return (info.st_mtime_ns, info.st_size)


def _find(candidates: list[tuple[str, str]]) -> Found:
    fallback: Found | None = None
    for path, source in candidates:
        probe = _probe(path)
        named = source in ("setting", "env")
        if probe is None or not probe.runs:
            if named:  # the person named this one: say it does not run rather than use another
                return Found(path, source, None, None, False, "not_found")
            continue
        found = Found(
            path, source, probe.version, probe.git_sha, probe.detach, None if probe.detach else "too_old"
        )
        if named or probe.detach:
            return found
        fallback = fallback or found
    return fallback or Found(None, None, None, None, False, "not_found")


def _probe(path: str) -> _Probe | None:
    """Whether `path` is a roko that runs, its version and commit, and whether it has `serve --detach`."""
    stamp = _stamp(path)
    if stamp is None or not os.access(path, os.X_OK) or os.path.isdir(path):
        return None
    key = (os.path.realpath(path), *stamp)
    with _FIND_LOCK:
        if key in _PROBES:
            return _PROBES[key]
    version = _run_quietly([path, "--version"])
    if version is None or version.returncode != 0:
        probe = _Probe(False, None, None, False)
    else:
        text = version.stdout.strip()
        words = re.match(r"^\S+\s+(\d[\w.+-]*)", text)
        sha = re.search(r"\bgit ([0-9a-f]{7,40})\b", text)
        helped = _run_quietly([path, "serve", "--help"])
        detach = helped is not None and helped.returncode == 0 and "--detach" in helped.stdout
        probe = _Probe(True, words.group(1) if words else None, sha.group(1) if sha else None, detach)
    with _FIND_LOCK:
        _PROBES[key] = probe
    return probe


def _run_quietly(argv: list[str]) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(
            argv,
            capture_output=True,
            text=True,
            timeout=VERSION_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
            env=_roko_env(),
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("roko: %s did not run: %s", argv[0], exc)
        return None


# -- what a serve is in now -------------------------------------------------------------------------------


@dataclass
class ServeState:
    """A project's roko serve, as docs/ui-api.md's `ServeState` describes it."""

    project: Path | None
    name: str
    state: str
    url: str | None = None
    pid: int | None = None
    version: str | None = None
    git_sha: str | None = None
    started_by: str | None = None
    since: str | None = None
    idle_exit_minutes: int | None = None
    error: dict[str, str] | None = None
    log_tail: list[str] | None = None
    actions: list[str] = field(default_factory=list)
    busy: dict[str, int] | None = None
    instance_id: str | None = None  # the plugin's own: which serve process this is

    def as_dict(self) -> dict[str, Any]:
        return {
            "project": str(self.project) if self.project is not None else None,
            "name": self.name,
            "state": self.state,
            "url": self.url,
            "pid": self.pid,
            "version": self.version,
            "git_sha": self.git_sha,
            "started_by": self.started_by,
            "since": self.since,
            "idle_exit_minutes": self.idle_exit_minutes,
            "error": dict(self.error) if self.error else None,
            "log_tail": list(self.log_tail) if self.log_tail is not None else None,
            "actions": list(self.actions),
            "busy": dict(self.busy) if self.busy else None,
        }

    @property
    def can_start(self) -> bool:
        return "start" in self.actions

    def signature(self) -> tuple[Any, ...]:
        """What makes a change worth a `serve` frame."""
        code = (self.error or {}).get("code")
        return (self.state, self.url, self.pid, code, tuple(self.actions), bool(self.busy))


def serve_state(
    rt: Runtime,
    project: Path | None = None,
    *,
    look: bool = True,
    health: dict[str, Any] | None = None,
    active: int | None = None,
) -> ServeState | None:
    """The project's roko serve now (default: the runtime's project). None when there is no project and no
    remote URL (nothing to say a serve is for).

    `look` asks the serve itself (`/health`, once `/mcp`, `/api/health` for its active runs); without it, only
    files are read (serve.json, the plugin's markers, the last lookup of the roko binary), for views that must
    not wait. `health` and `active` pass in what a caller already asked.
    """
    view = rt.scoped(project) if project is not None else rt
    settings = view.settings()
    if settings.remote:
        return _remote(rt, settings)
    project = settings.workdir
    if project is None:
        return None
    state = _look(rt, view, settings, project, look=look, health=health, active=active)
    if look:
        rt.root.serve_states[str(project)] = (time.monotonic(), state)
    return state


def cached_state(rt: Runtime, project: Path) -> ServeState | None:
    """The last state a look found, when it is still what the files say (no network)."""
    files = serve_state(rt, project, look=False)
    held = rt.root.serve_states.get(str(project))
    if files is None or held is None:
        return files
    last: ServeState = held[1]
    if last.state in ("running", "outdated") and files.state == "running" and last.pid == files.pid:
        return last
    return files


def _remote(rt: Runtime, settings: Settings) -> ServeState:
    project = settings.workdir
    if project is not None:
        name = rt.projects.name(project)
    else:
        try:
            name = httpx.URL(settings.url).host or settings.display_url
        except Exception:
            name = settings.display_url
    return ServeState(project, name, "remote", url=settings.display_url or None)


def _look(
    rt: Runtime,
    view: Runtime,
    settings: Settings,
    project: Path,
    *,
    look: bool,
    health: dict[str, Any] | None,
    active: int | None,
) -> ServeState:
    name = rt.projects.name(project)
    marker = read_marker(rt, project)
    found = find_roko(rt, settings, cached_only=not look)
    can_manage = found is not None and found.problem is None
    alive = _alive(view, settings, project, look=look, health=health)
    if alive is not None:
        instance = alive.get("instance_id") if isinstance(alive.get("instance_id"), str) else None
        state = ServeState(
            project,
            name,
            "running",
            url=_text(alive.get("url")),
            pid=_int(alive.get("pid")),
            version=_text(alive.get("version")),
            git_sha=_text(alive.get("git_sha")),
            started_by="hermes" if instance and marker.get("instance_id") == instance else "other",
            since=_text(alive.get("started_at")) or _iso(alive.get("started_at")),
            idle_exit_minutes=_minutes(alive.get("idle_exit_secs")),
            actions=["restart", "stop"] if can_manage else [],
            instance_id=instance,
        )
        if look:
            if _has_mcp(view, alive) is False:
                state.state = "outdated"
                state.error = _error(
                    "no_mcp",
                    f"roko serve for {name} runs a roko from before its /mcp endpoint, which Hermes needs",
                    "update roko, then restart roko serve (Restart on the roko page)"
                    if can_manage
                    else f"update roko ({INSTALL_COMMAND} in your roko clone), then restart roko serve",
                )
                state.actions = ["restart"] if can_manage else []
            count = active if active is not None else _active_runs(view)
            if count:
                state.busy = {"active_runs": count}
        return state
    if _starting(marker):
        return ServeState(
            project,
            name,
            "starting",
            since=_text(marker.get("at")),
            idle_exit_minutes=_setting_minutes(settings),
        )
    base = ServeState(
        project,
        name,
        "stopped",
        version=found.version if found else None,
        git_sha=found.git_sha if found else None,
        idle_exit_minutes=_setting_minutes(settings),
    )
    if found is not None and found.problem == "not_found":
        base.state = "not_found"
        named = f" ({found.path} does not run)" if found.path else ""
        base.error = _error(
            "not_found",
            f"roko is not installed on this machine{named}",
            f"install roko: in a clone of roko's repository, `{INSTALL_COMMAND}` (Rust 1.91 or later); or "
            "set the plugin's roko_bin setting to a roko binary",
        )
        return base
    if found is not None and found.problem == "too_old":
        base.state = "outdated"
        base.error = _error(
            "too_old",
            f"the roko at {found.path} is from before `roko serve --detach`, so Hermes cannot start roko "
            "serve with it",
            f"update roko: in your roko clone, `git pull && {INSTALL_COMMAND}`",
        )
        return base
    if not (project / "roko.toml").is_file():
        # roko serve refuses a folder roko is not set up in (not_initialized): setting it up comes first.
        base.state = "failed"
        base.error = _error(
            "not_initialized",
            f"roko is not set up in {name} yet (it has no roko.toml), so roko serve cannot start there",
            _failure_hint("not_initialized", project),
        )
        return base
    if marker.get("state") == "failed":
        error = _dict(marker.get("error"))
        base.state = "failed"
        base.since = _text(marker.get("at"))
        base.error = _error(
            _text(error.get("code")) or "start_failed",
            _text(error.get("message")) or f"roko serve for {name} did not start",
            _text(error.get("hint")) or _failure_hint(_text(error.get("code")), project),
        )
        tail = marker.get("log_tail")
        base.log_tail = (
            [clean(line, 300, one_line=True) for line in tail if isinstance(line, str)]
            if (isinstance(tail, list))
            else None
        )
        base.actions = ["start"] if can_manage or found is None else []
        return base
    base.actions = ["start"] if can_manage or found is None else []
    return base


def _alive(
    view: Runtime, settings: Settings, project: Path, *, look: bool, health: dict[str, Any] | None
) -> dict[str, Any] | None:
    """What the project's running serve says about itself (serve.json, else `/health`), or None when none
    runs for it. A serve.json whose process is gone, or whose address another serve answers, does not
    count."""
    endpoint = read_serve_endpoint(project)
    url = endpoint.get("url") if endpoint else None
    if endpoint is not None and isinstance(url, str) and is_loopback_url(url):
        if not _pid_alive(endpoint.get("pid")):
            return None
        if not look:
            return {**endpoint, "url": url.rstrip("/")}
        said = health if health is not None else _health(url)
        if said is None:
            # A busy serve may miss one look: one that answered a moment ago still counts.
            held = view.root.serve_states.get(str(project))
            if (
                held is not None
                and time.monotonic() - held[0] < VOUCH_S
                and held[1].pid == endpoint.get("pid")
            ):
                return {**endpoint, "url": url.rstrip("/")}
            return None
        if not _same_identity(endpoint, said, project, url):
            return None
        return {**endpoint, **_identity(said), "url": url.rstrip("/")}
    if settings.url and settings.url_source == "settings" and look:
        # A `url` setting from 0.5 or 0.6 and no serve.json: whatever answers there, unless it says it is
        # another project's serve.
        said = health if health is not None else _health(settings.url)
        if said is None:
            return None
        named = said.get("workdir") if isinstance(said.get("workdir"), str) else None
        if named and not same_path(Path(named), project):
            return None
        return {**_identity(said), "url": settings.url.rstrip("/")}
    return None


def _same_identity(endpoint: dict[str, Any], said: dict[str, Any], project: Path, url: str) -> bool:
    """Whether the serve that answers at serve.json's address is the one that wrote it (roko's identity), or
    for a roko without identity fields, started when the file says and names this workspace."""
    instance = said.get("instance_id")
    if isinstance(instance, str) and instance:
        if instance != endpoint.get("instance_id"):
            return False
        named = said.get("workdir")
        return not isinstance(named, str) or same_path(Path(named), project)
    return _same_serve(endpoint, url)


def _identity(said: dict[str, Any]) -> dict[str, Any]:
    keys = ("pid", "instance_id", "version", "git_sha", "started_at", "idle_exit_secs", "workdir")
    return {key: said[key] for key in keys if key in said}


def _health(url: str) -> dict[str, Any] | None:
    try:
        response = httpx.get(f"{url.rstrip('/')}/health", timeout=HEALTH_TIMEOUT_S, trust_env=False)
        body = response.json() if response.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None
    return body if isinstance(body, dict) else None


_MCP: dict[tuple[str, str], bool] = {}
_MCP_LOCK = threading.Lock()


def _has_mcp(view: Runtime, alive: dict[str, Any]) -> bool | None:
    """Whether the running serve has `/mcp` (a roko from before it answers 404). Asked once per serve
    process."""
    key = (
        str(alive.get("url")),
        str(alive.get("instance_id") or alive.get("started_at") or alive.get("pid")),
    )
    with _MCP_LOCK:
        if key in _MCP:
            return _MCP[key]
    try:
        view.client().tool_names()
        verdict: bool | None = True
    except RokoError as exc:
        verdict = False if exc.code is Code.NOT_FOUND else None
    if verdict is not None:
        with _MCP_LOCK:
            _MCP[key] = verdict
    return verdict


def mcp_missing(view: Runtime) -> bool:
    """Whether the project's serve, as last asked, lacks `/mcp` (readiness counts it)."""
    held = view.root.serve_states.get(str(view.settings().workdir))
    return held is not None and (held[1].error or {}).get("code") == "no_mcp"


def _active_runs(view: Runtime) -> int | None:
    try:
        body = view.client().get("/api/health")
    except RokoError:
        return None
    if not isinstance(body, dict):
        return None
    counts = [body.get(key) for key in ("active_runs", "active_plans")]
    if not all(isinstance(count, int) and not isinstance(count, bool) for count in counts):
        return None
    return int(sum(count for count in counts if isinstance(count, int)))


# -- starting ------------------------------------------------------------------------------------------------


@dataclass
class _Job:
    done: threading.Event = field(default_factory=threading.Event)
    result: ServeState | None = None


_JOBS: dict[tuple[int, str], _Job] = {}
_JOBS_LOCK = threading.Lock()


def ensure_serve(
    rt: Runtime,
    project: Path | None = None,
    *,
    wait: bool,
    reason: str,
    port: int | None = None,
) -> ServeState | None:
    """Make the project's roko serve run, when it may (module docstring). `reason` is app_open, overview, tool
    or manual: only `manual` starts it when `auto_start` is off, or within FAILED_PAUSE_S of a failed start.

    With `wait` it returns once the serve answers (or the start failed), at most START_WAIT_S, keeping Hermes'
    activity heartbeat going and returning early, `starting`, when the person interrupts the turn. Without it,
    it returns at once: `starting` while the start runs in the background. None without a project.
    """
    view = rt.scoped(project) if project is not None else rt
    settings = view.settings()
    state = serve_state(rt, settings.workdir) if not settings.remote else _remote(rt, settings)
    if state is None or state.state in ("running", "starting", "remote", "not_found", "outdated"):
        return state
    unset = state.project is not None and not (state.project / "roko.toml").is_file()
    if unset and (state.error or {}).get("code") == "not_initialized":
        return state  # roko would refuse: the project needs setting up first (setup-project)
    if reason != "manual":
        if not settings.auto_start:
            return state
        if state.state == "failed" and _age(state.since) < FAILED_PAUSE_S:
            return state
    assert settings.workdir is not None
    job = _start_job(rt, settings.workdir, reason, port)
    if not wait:
        return _starting_state(rt, settings)
    activity = {"last_touch": time.monotonic(), "start": time.monotonic()}
    deadline = time.monotonic() + START_WAIT_S
    while not job.done.wait(0.25):
        _hermes.touch_activity(activity, f"starting roko serve for {state.name}")
        if _hermes.is_interrupted() or time.monotonic() >= deadline:
            return serve_state(rt, settings.workdir, look=False)
    return job.result or serve_state(rt, settings.workdir)


def _starting_state(rt: Runtime, settings: Settings) -> ServeState:
    assert settings.workdir is not None
    return ServeState(
        settings.workdir,
        rt.projects.name(settings.workdir),
        "starting",
        since=_now_iso(),
        idle_exit_minutes=_setting_minutes(settings),
    )


def _start_job(rt: Runtime, project: Path, reason: str, port: int | None) -> _Job:
    """The start of `project`'s serve this process runs: a new one in a background thread, or the one already
    running (two callers in one process share it)."""
    key = (id(rt.root), str(project))
    with _JOBS_LOCK:
        job = _JOBS.get(key)
        if job is not None and not job.done.is_set():
            return job
        job = _JOBS[key] = _Job()
    # Other processes see the start at once; the thread writes the same marker once it holds the lock.
    write_marker(rt, project, {"state": "starting", "reason": reason})
    _notify(rt, project)

    def run() -> None:
        try:
            job.result = _start(rt, project, reason, port)
        except Exception:  # a start must never take the backend down
            logger.exception("roko: starting roko serve for %s failed", project)
            write_marker(
                rt,
                project,
                {
                    "state": "failed",
                    "error": {"code": "spawn_failed", "message": "the plugin's start failed"},
                },
            )
        finally:
            job.done.set()
            with _JOBS_LOCK:
                if _JOBS.get(key) is job:
                    del _JOBS[key]
            _notify(rt, project)

    threading.Thread(target=run, name=f"roko-start-{project.name}", daemon=True).start()
    return job


def _start(rt: Runtime, project: Path, reason: str, port: int | None) -> ServeState | None:
    view = rt.scoped(project)
    with _project_lock(rt, project, START_WAIT_S) as held:
        state = serve_state(rt, project)
        if state is None or state.state in ("running", "remote", "not_found", "outdated"):
            if state is not None and state.state == "running":
                _clear_starting(rt, project)
            return state
        if not held:
            # Another process held the lock all along: its start is what there is.
            return state
        settings = view.settings()
        found = find_roko(rt, settings)
        if found is None or found.path is None or found.problem is not None:
            _clear_starting(rt, project)
            return serve_state(rt, project)
        write_marker(rt, project, {"state": "starting", "reason": reason})
        answer = _detach(found.path, project, settings, port)
        if answer.get("ok") is True:
            write_marker(
                rt,
                project,
                {
                    "state": "started",
                    "instance_id": _text(answer.get("instance_id")),
                    "serve_pid": _int(answer.get("pid")),
                    "url": _text(answer.get("url")),
                    "reason": reason,
                },
            )
        else:
            error = _dict(answer.get("error"))
            code = _text(error.get("code")) or "start_failed"
            tail = error.get("log_tail")
            lines = [line for line in tail if isinstance(line, str)] if isinstance(tail, list) else []
            write_marker(
                rt,
                project,
                {
                    "state": "failed",
                    "error": {
                        "code": code,
                        "message": clean(
                            error.get("message") or "roko serve did not start", 600, one_line=True
                        ),
                        "hint": _failure_hint(code, project),
                    },
                    "log_tail": [clean(line, 300, one_line=True) for line in lines[-LOG_TAIL:]]
                    or _tail(project / ".roko" / "logs" / "serve.log", LOG_TAIL),
                    "reason": reason,
                },
            )
    _forget_look(view)
    return serve_state(rt, project)


def _detach(roko: str, project: Path, settings: Settings, port: int | None) -> dict[str, Any]:
    """`roko serve --detach --json` for `project`: its answer, or the plugin's own failure in its shape.

    Its output goes to temporary files, never pipes: a serve that held a pipe the plugin closed would die on
    its next line (a Rust `println!` panics on EPIPE).
    """
    argv = [roko, "serve", "--detach", "--json", "--workdir", str(project)]
    minutes = settings.idle_exit_minutes
    if minutes:
        argv += ["--idle-exit", str(minutes * 60)]
    if port:
        argv += ["--port", str(port)]
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            process = subprocess.Popen(
                argv,
                cwd=project,
                env=_roko_env(),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                start_new_session=True,
            )
        except OSError as exc:
            return _failed("spawn_failed", f"{roko} did not run: {exc}")
        try:
            code = process.wait(timeout=START_TIMEOUT_S)
        except subprocess.TimeoutExpired:
            # The plugin's own `--detach` command; roko kills its serve itself on its own timeout.
            process.kill()
            process.wait(timeout=5)
            return _failed("timeout", f"roko serve did not start within {int(START_TIMEOUT_S)} s")
        out.seek(0)
        err.seek(0)
        stdout = out.read().decode("utf-8", "replace")
        stderr = err.read().decode("utf-8", "replace")
    answer = _last_json(stdout)
    if answer is not None:
        return answer
    said = [line for line in stderr.splitlines() if line.strip()]
    if code != 0 and re.search(r"unexpected argument|unrecognized|unknown argument", stderr):
        return _failed("too_old", "this roko cannot start roko serve in the background (no --detach)")
    return _failed("start_failed", said[-1] if said else f"roko serve --detach ended with exit code {code}")


def _failed(code: str, message: str) -> dict[str, Any]:
    return {
        "ok": False,
        "error": {"code": code, "message": clean(message, 600, one_line=True), "log_tail": []},
    }


def _last_json(text: str) -> dict[str, Any] | None:
    for line in reversed([line.strip() for line in text.splitlines() if line.strip()]):
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict) and "ok" in value:
            return value
    try:
        value = json.loads(text)
    except ValueError:
        return None
    return value if isinstance(value, dict) and "ok" in value else None


# -- stopping and restarting -------------------------------------------------------------------------------


def stop_serve(rt: Runtime, project: Path | None = None, *, force: bool = False) -> ServeState | None:
    """`roko serve stop` for the project's serve. A busy one (runs going, or roko cannot say) is refused with
    `conflict` unless `force`, nothing done."""
    view, settings = _managed(rt, project)
    assert settings.workdir is not None
    state = serve_state(rt, settings.workdir)
    if state is None or state.state not in ("running", "outdated") or state.pid is None:
        return state
    found = _found_for_command(rt, settings, "stop")
    if not force:
        _refuse_busy(state, "stopping")
    argv = [
        found,
        "serve",
        "stop",
        "--workdir",
        str(settings.workdir),
        "--json",
        "--timeout",
        str(STOP_TIMEOUT_S),
    ]
    answer = _command(argv + (["--force"] if force else []), settings.workdir, STOP_COMMAND_S)
    _busy_answer(answer, state, "stopping")
    if answer.get("ok") is False:
        raise _command_error(answer, "roko serve did not stop")
    clear_marker(rt, settings.workdir)
    _forget_look(view)
    _notify(rt, settings.workdir)
    return serve_state(rt, settings.workdir)


def restart_serve(
    rt: Runtime, project: Path | None = None, *, force: bool = False, wait: bool = False
) -> ServeState | None:
    """`roko serve restart` for the project's serve (in the background unless `wait`): a busy one is refused
    with `conflict` unless `force`. A serve that does not run is started instead."""
    view, settings = _managed(rt, project)
    assert settings.workdir is not None
    state = serve_state(rt, settings.workdir)
    if state is None or state.state not in ("running", "outdated") or state.pid is None:
        return ensure_serve(rt, settings.workdir, wait=wait, reason="manual")
    found = _found_for_command(rt, settings, "restart")
    if not force:
        _refuse_busy(state, "restarting")
    workdir = settings.workdir
    argv = [found, "serve", "restart", "--workdir", str(workdir), "--json"] + (["--force"] if force else [])
    key = (id(rt.root), str(workdir))
    job = _Job()
    with _JOBS_LOCK:
        if key in _JOBS and not _JOBS[key].done.is_set():
            return _starting_state(rt, settings)
        _JOBS[key] = job
    write_marker(rt, workdir, {"state": "starting", "reason": "restart"})
    _notify(rt, workdir)

    def run() -> None:
        try:
            with _project_lock(rt, workdir, START_WAIT_S):
                answer = _command(argv, workdir, RESTART_COMMAND_S)
                restarted = answer.get("restarted")
                first = restarted[0] if isinstance(restarted, list) and restarted else None
                if isinstance(first, dict) and first.get("ok") is not False and first.get("instance_id"):
                    write_marker(
                        rt,
                        workdir,
                        {
                            "state": "started",
                            "instance_id": _text(first.get("instance_id")),
                            "serve_pid": _int(first.get("pid")),
                            "url": _text(first.get("url")),
                            "reason": "restart",
                        },
                    )
                else:
                    error = (first or {}).get("error") if isinstance(first, dict) else answer.get("error")
                    error = error if isinstance(error, dict) else {}
                    busy = answer.get("busy")
                    code = (
                        "busy"
                        if isinstance(busy, list) and busy
                        else _text(error.get("code")) or "start_failed"
                    )
                    write_marker(
                        rt,
                        workdir,
                        {
                            "state": "failed",
                            "error": {
                                "code": code,
                                "message": clean(
                                    error.get("message") or "roko serve did not restart", 600, one_line=True
                                ),
                                "hint": _failure_hint(code, workdir),
                            },
                            "log_tail": _tail(workdir / ".roko" / "logs" / "serve.log", LOG_TAIL),
                            "reason": "restart",
                        },
                    )
            _forget_look(view)
            job.result = serve_state(rt, workdir)
        except Exception:
            logger.exception("roko: restarting roko serve for %s failed", workdir)
        finally:
            job.done.set()
            with _JOBS_LOCK:
                if _JOBS.get(key) is job:
                    del _JOBS[key]
            _notify(rt, workdir)

    threading.Thread(target=run, name=f"roko-restart-{workdir.name}", daemon=True).start()
    if wait:
        job.done.wait(RESTART_COMMAND_S + START_WAIT_S)
        return job.result or serve_state(rt, workdir)
    return _starting_state(rt, settings)


def _managed(rt: Runtime, project: Path | None) -> tuple[Runtime, Settings]:
    view = rt.scoped(project) if project is not None else rt
    settings = view.settings()
    if settings.remote:
        raise RokoError(
            Code.FORBIDDEN,
            f"{settings.where} is not on this machine, so the plugin starts and stops nothing there",
            hint="manage that roko serve where it runs",
        )
    if settings.workdir is None:
        raise RokoError(
            Code.INVALID,
            "no project is chosen, so there is no roko serve to manage",
            hint="pick a project on the roko page, or pass --project",
        )
    return view, settings


def _found_for_command(rt: Runtime, settings: Settings, verb: str) -> str:
    found = find_roko(rt, settings)
    if found is None or found.path is None or found.problem == "not_found":
        raise RokoError(
            Code.CONFIG,
            "roko is not installed on this machine",
            hint=f"install roko: in a clone of roko's repository, `{INSTALL_COMMAND}`",
        )
    if found.problem == "too_old":
        raise RokoError(
            Code.REFUSED,
            f"the roko at {found.path} cannot {verb} roko serve (it is from before `roko serve {verb}`)",
            hint=f"update roko: in your roko clone, `git pull && {INSTALL_COMMAND}`",
        )
    return found.path


def _refuse_busy(state: ServeState, doing: str) -> None:
    if state.busy and state.busy.get("active_runs"):
        _raise_busy(state, int(state.busy["active_runs"]), doing)


def _busy_answer(answer: dict[str, Any], state: ServeState, doing: str) -> None:
    """roko refused a busy serve itself (`busy` rows, or the code `busy`)."""
    busy = answer.get("busy")
    error = _dict(answer.get("error"))
    if (isinstance(busy, list) and busy) or error.get("code") == "busy":
        rows = [row for row in busy if isinstance(row, dict)] if isinstance(busy, list) else []
        count = _int(rows[0].get("active_runs")) if rows else None
        _raise_busy(state, count, doing)


def _raise_busy(state: ServeState, count: int | None, doing: str) -> None:
    runs = (
        f"{count} run{'s are' if count != 1 else ' is'} going"
        if count
        else "roko cannot say whether runs are going"
    )
    exc = RokoError(
        Code.CONFLICT,
        f"{runs} in {state.name}; {doing} roko serve stops them.",
        hint="wait for them to end, or confirm to stop them (their work so far is kept)",
    )
    exc.serve = state.as_dict()
    raise exc


def _command(argv: list[str], project: Path, timeout: float) -> dict[str, Any]:
    """Run a `roko serve status|stop|restart --json` command; its JSON answer (or the plugin's failure)."""
    with tempfile.TemporaryFile() as out, tempfile.TemporaryFile() as err:
        try:
            process = subprocess.Popen(
                argv,
                cwd=project,
                env=_roko_env(),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                start_new_session=True,
            )
            code = process.wait(timeout=timeout)
        except OSError as exc:
            return _failed("spawn_failed", f"{argv[0]} did not run: {exc}")
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
            return _failed("timeout", f"`roko serve {argv[2]}` did not finish within {int(timeout)} s")
        out.seek(0)
        err.seek(0)
        stdout = out.read().decode("utf-8", "replace")
        stderr = err.read().decode("utf-8", "replace")
    answer = _last_json(stdout)
    if answer is not None:
        return answer
    said = [line for line in stderr.splitlines() if line.strip()]
    return _failed("start_failed", said[-1] if said else f"roko serve {argv[2]} ended with exit code {code}")


def _command_error(answer: dict[str, Any], fallback: str) -> RokoError:
    error = _dict(answer.get("error"))
    return RokoError(Code.SERVER, clean(error.get("message") or fallback, 600, one_line=True))


# -- markers and locks -------------------------------------------------------------------------------------


def _key(project: Path) -> str:
    return hashlib.sha256(str(project).encode()).hexdigest()[:16]


def _folder(rt: Runtime) -> Path:
    return rt.data_dir() / "serves"


def read_marker(rt: Runtime, project: Path) -> dict[str, Any]:
    try:
        data = json.loads((_folder(rt) / f"{_key(project)}.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) and data.get("project") == str(project) else {}


def write_marker(rt: Runtime, project: Path, data: dict[str, Any]) -> None:
    """Replace the project's marker; a new start keeps which serve the plugin started last until it knows
    the new one."""
    folder = _folder(rt)
    record = {
        "project": str(project),
        "at": _now_iso(),
        "at_epoch": time.time(),
        "pid": os.getpid(),
        **data,
    }
    if data.get("state") in ("starting", "failed"):
        old = read_marker(rt, project)
        if old.get("instance_id") and "instance_id" not in data:
            record["instance_id"] = old["instance_id"]
    try:
        folder.mkdir(parents=True, exist_ok=True)
        handle, temp = tempfile.mkstemp(prefix=".serve-", dir=folder)
        with os.fdopen(handle, "w", encoding="utf-8") as out:
            json.dump(record, out)
        os.replace(temp, folder / f"{_key(project)}.json")
    except OSError as exc:
        logger.debug("roko: could not write the serve marker for %s: %s", project, exc)


def clear_marker(rt: Runtime, project: Path) -> None:
    with contextlib.suppress(OSError):
        (_folder(rt) / f"{_key(project)}.json").unlink()


def _clear_starting(rt: Runtime, project: Path) -> None:
    marker = read_marker(rt, project)
    if marker.get("state") == "starting":
        if marker.get("instance_id"):
            write_marker(rt, project, {"state": "started", "instance_id": marker["instance_id"]})
        else:
            clear_marker(rt, project)


def _starting(marker: dict[str, Any]) -> bool:
    if marker.get("state") != "starting":
        return False
    at = marker.get("at_epoch")
    if not isinstance(at, (int, float)) or time.time() - float(at) > STARTING_MAX_S:
        return False
    return _pid_alive(marker.get("pid"))


@contextlib.contextmanager
def _project_lock(rt: Runtime, project: Path, timeout: float) -> Iterator[bool]:
    """The project's start lock, across Hermes processes: yields True once held, False when another process
    held it for `timeout` seconds."""
    try:
        import fcntl
    except ImportError:  # pragma: no cover - Windows: one process at a time is all there is
        yield True
        return
    folder = _folder(rt)
    try:
        folder.mkdir(parents=True, exist_ok=True)
        handle = (folder / f"{_key(project)}.lock").open("a+b")
    except OSError as exc:
        logger.debug("roko: no start lock for %s: %s", project, exc)
        yield True
        return
    with handle:
        deadline = time.monotonic() + timeout
        held = False
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                held = True
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    break
                time.sleep(0.2)
        try:
            yield held
        finally:
            if held:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


# -- helpers ------------------------------------------------------------------------------------------------


def _notify(rt: Runtime, project: Path) -> None:
    """Tell this process's live relay that a serve may have changed (it sends a `serve` frame if it did)."""
    live = rt.root._live
    if live is None:
        return
    try:
        live.serve_changed(project)
    except Exception:
        logger.debug("roko: could not tell the live relay about %s", project, exc_info=True)


def _forget_look(view: Runtime) -> None:
    """The readiness look and the cached state of the project are stale now."""
    from . import readiness

    readiness.invalidate(view)


def _failure_hint(code: str | None, project: Path) -> str:
    quoted = shlex.quote(str(project))
    if code == "not_initialized":
        return (
            "set roko up in this project: Set up roko here on the roko page, or "
            f"`hermes roko init --workdir {quoted}`"
        )
    if code == "locked":
        return (
            "another roko process (a plan run in a terminal, say) holds this project: wait for it to end, "
            "then start roko serve again"
        )
    if code == "not_a_workspace":
        return "the project's folder is gone: remove it from Hermes' projects"
    if code == "spawn_failed":
        return "check that the roko binary runs (`roko --version`), or set the plugin's roko_bin setting"
    if code == "busy":
        return "runs are going there: try again once they end"
    if code == "too_old":
        return f"update roko: in your roko clone, `git pull && {INSTALL_COMMAND}`"
    return (
        f"the log's last lines say why; `roko serve --workdir {quoted}` in a terminal shows the whole error"
    )


def _error(code: str, message: str, hint: str) -> dict[str, str]:
    return {
        "code": code,
        "message": clean(message, 600, one_line=True),
        "hint": clean(hint, 600, one_line=True),
    }


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _setting_minutes(settings: Settings) -> int | None:
    return settings.idle_exit_minutes or None


def _minutes(secs: Any) -> int | None:
    if isinstance(secs, int) and not isinstance(secs, bool) and secs > 0:
        return max(1, secs // 60)
    return None


def _age(stamp: str | None) -> float:
    if not stamp:
        return float("inf")
    try:
        when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return float("inf")
    return time.time() - when.timestamp()


def _now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _iso(value: Any) -> str | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return datetime.fromtimestamp(float(value), UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return None


def _text(value: Any) -> str | None:
    return clean(value, 300, one_line=True) or None if isinstance(value, str) else None


def _int(value: Any) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return False
    return True


def _tail(path: Path, count: int) -> list[str]:
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return []
    return [clean(line, 300, one_line=True) for line in lines[-count:]]


# Moved here from onboard.py (0.7.0): every way of running roko shares them.


def _env_names(path: Path) -> set[str]:
    """The names a dotenv file sets to something (never the values)."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return set()
    names = set()
    for line in lines:
        name, sep, value = line.strip().removeprefix("export ").partition("=")
        if sep and name.strip() and value.strip().strip("'\""):
            names.add(name.strip())
    return names


def _roko_env() -> dict[str, str]:
    """The environment roko runs in: this one, without the keys Hermes holds. `hermes` loads its own .env
    into its environment when it starts; roko reads its keys from ~/.roko/.env, so a key the person did
    not give roko stays Hermes'."""
    hermes = _env_names(_hermes.hermes_home() / ".env") - PROCESS_ENV
    return {name: value for name, value in os.environ.items() if name not in ROKO_KEYS and name not in hermes}


def _same_serve(endpoint: dict[str, Any], url: str) -> bool:
    """Whether the roko serve at `url` is the one that wrote `endpoint`, for a roko without identity fields:
    it started when the file says (its `/health` uptime). Unknown counts as the same, as before this check."""
    stamp = endpoint.get("started_at")
    try:
        if isinstance(stamp, str):
            started = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
        elif isinstance(stamp, int | float) and not isinstance(stamp, bool):
            started = float(stamp)
        else:
            return True
        uptime = httpx.get(f"{url.rstrip('/')}/health", timeout=2.0).json().get("uptime_secs")
    except (ValueError, AttributeError, httpx.HTTPError):
        return True
    if not isinstance(uptime, int | float) or isinstance(uptime, bool):
        return True
    return abs(time.time() - float(uptime) - started) <= SAME_SERVE_SLACK_S


# roko serve writes serve.json once it listens, after it started: how far apart the two may be.
SAME_SERVE_SLACK_S = 60.0


def describe(state: ServeState | None) -> str:
    """A ServeState in one line, for the CLI and tool answers."""
    if state is None:
        return "no project is chosen"
    if state.state == "running":
        pid = f", pid {state.pid}" if state.pid else ""
        return f"roko serve runs for {state.name} at {state.url}{pid}"
    if state.state == "starting":
        return f"roko serve is starting for {state.name}"
    if state.state == "remote":
        return f"roko serve is remote ({state.url})"
    message = (state.error or {}).get("message")
    if message:
        return f"roko serve for {state.name}: {state.state}: {message}"
    return f"roko serve for {state.name}: {state.state}"

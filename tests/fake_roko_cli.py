"""A stand-in for the `roko` command, for the tests of `hermes roko init` and of the plugin starting roko serve
(ROKO_BIN, or the `roko_bin` setting, points at a wrapper that runs this file).

    roko --version                              "roko 0.1.0 (fake, …, git <sha>)"
    roko init                                   writes the roko.toml a roko before 2026-10-15 wrote
    roko serve [--workdir DIR] [--port N] [--idle-exit SECS]
                                                a FakeRoko that follows DIR/roko.toml, until SIGTERM, SIGINT, SIGHUP
                                                or SECS without work
    roko serve --detach [--json] [--workdir W] [--port P] [--bind B] [--idle-exit SECS] [--wait SECS]
    roko serve status|stop|restart [--workdir W | --all] [--json] [--force] [--timeout SECS]
    roko serve --help                           lists --detach
    roko config preset chat-host … --json       only with FAKE_ROKO_PRESET=1, as roko-chathost's preset
    roko plan validate DIR

`roko serve` reads its models from roko.toml and its keys from the environment and ~/.roko/.env, as roko does,
and re-reads roko.toml every 0.2 s like roko's watcher. Without roko.toml it starts on roko's defaults when a
provider's key is set (refusing runs started from a chat), else it says "no LLM provider configured" and exits 1,
which `--detach` reports as `not_initialized`. While it runs it holds `.roko/runtime/roko.lock`, writes `serve.json`
with roko's identity fields (instance_id, port, version, git_sha, exe, idle_exit_secs, args), answers them on
`/health`, and keeps an entry in `$HOME/.roko/runtime/serves/`; it removes all of it when it stops. `--detach`,
`status`, `stop` and `restart` follow round roko-autostart's §A and its round-1 additions, as roko-serve's
`serve_lifecycle.rs` writes them: the same JSON, codes and exit codes. Unlike roko, a serve given no port takes
roko.toml's `[server] port` or else one the OS picks: never 6677.

Modes, by environment variable:
    FAKE_ROKO_OLD=1             names refusals only in text, never refuses for want of a model
    FAKE_ROKO_NO_DETACH=1       a roko from before `serve --detach`: no --detach, status, stop or restart
    FAKE_ROKO_NO_MCP=1          its serve answers `POST /mcp` with 404, as a roko from August does
    FAKE_ROKO_START_FAIL=1      its serve writes an error to its log and exits 1 before it listens
    FAKE_ROKO_START_DELAY=SECS  its serve waits this long before it listens
    FAKE_ROKO_RESTART_DELAY=SECS  `serve restart` waits this long before it stops the serve
    FAKE_ROKO_GIT=SHA           the commit this build reports (default fa4e000ab)
    FAKE_ROKO_ACTIVE=N          its serve reports N active runs on /api/health (a busy serve)
    FAKE_ROKO_ARGV_LOG=PATH     each invocation appends its arguments to PATH, one JSON list per line
"""

from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import tomllib
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

sys.path.insert(0, str(Path(__file__).parent))

from fake_roko import FakeRoko

INIT_TOML = """\
config_version = 2

[agent]
default_model = "claude-sonnet-4-6"

[providers.claude_cli]
kind = "claude_cli"

[models.claude-sonnet-4-6]
provider = "claude_cli"
slug = "claude-sonnet-4-6"

[routing.ladder]
enabled = true

[[routing.ladder.rungs]]
name = "cheap"
model = "gpt-oss-120b"

[[routing.ladder.rungs]]
name = "top"
model = "claude-sonnet-4-6"

[serve.auth]
enabled = true

[serve.mcp]
max_run_usd = 5.0
allow_without_data_llm = false

[gates]
rungs = []
"""

API_KINDS = {"anthropic_api", "openai_compat", "perplexity_api", "gemini_api", "cerebras_api"}
# Slugs roko's own price table covers (config/prices/2026-09-28.toml and the built-in table in roko-core): a
# `[models.*]` entry on one of them needs no rates of its own.
PRICED_SLUGS = {"gpt-5.4-mini", "claude-haiku-4-5", "gpt-oss-120b"}
VERSION = "0.1.0"
# The provider keys roko finds on its own (the environment, ~/.roko/.env): without roko.toml, a serve starts on
# roko's defaults when one is set.
PROVIDER_KEYS = (
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "CEREBRAS_API_KEY",
    "ZAI_API_KEY",
    "MOONSHOT_API_KEY",
    "GEMINI_API_KEY",
)
NO_PROVIDER_MESSAGE = "no LLM provider configured"
SERVE_HELP = """Start the HTTP API server

Usage: roko serve [OPTIONS] [COMMAND]

Commands:
  status   Show the roko serves of a workspace, or of all workspaces
  stop     Stop a roko serve
  restart  Restart a roko serve with the arguments it started with

Options:
      --bind <BIND>            Address to bind to (default: 127.0.0.1)
      --port <PORT>            Port number (default: 6677)
      --workdir <WORKDIR>      Working directory (default: cwd)
      --detach                 Start roko serve in the background and print where it listens
      --idle-exit <SECS>       Stop after SECS without work (0: never)
      --wait <SECS>            With --detach: how long to wait for it to listen (default: 60)
      --json                   Emit JSON output instead of human-readable text
"""
OLD_SERVE_HELP = """Start the HTTP API server

Usage: roko serve [OPTIONS]

Options:
      --bind <BIND>            Address to bind to (default: 127.0.0.1)
      --port <PORT>            Port number (default: 6677)
      --workdir <WORKDIR>      Working directory (default: cwd)
      --json                   Emit JSON output instead of human-readable text
"""


def git_sha() -> str:
    return os.environ.get("FAKE_ROKO_GIT") or "fa4e000ab"


def keys() -> set[str]:
    names = {name for name, value in os.environ.items() if value}
    env = Path.home() / ".roko" / ".env"
    if env.is_file():
        for line in env.read_text().splitlines():
            name, sep, value = line.partition("=")
            if sep and value.strip():
                names.add(name.strip())
    return names


def follow(fake: FakeRoko, config: Path) -> None:
    """Keep the fake's model and provider lists as roko.toml and the keys say."""
    while True:
        try:
            data = tomllib.loads(config.read_text())
        except (OSError, tomllib.TOMLDecodeError):
            data = {}
        have = keys()
        providers = []
        for pid, row in (data.get("providers") or {}).items():
            kind = row.get("kind")
            has_key = kind in API_KINDS and (row.get("api_key_env") in have)
            providers.append(
                {"id": pid, "kind": kind, "has_api_key": has_key, "base_url": row.get("base_url")}
            )
        models = [
            {"key": key, "slug": row.get("slug"), "provider": row.get("provider"), "supports_tools": True}
            for key, row in (data.get("models") or {}).items()
        ]
        keyed = {p["id"] for p in providers if p["has_api_key"]}
        with fake.lock:
            fake.providers, fake.models = providers, models
            fake.tool_loop = any(m["provider"] in keyed for m in models)
            # roko since gap-8548e3: one of those models needs a price, its own rates or roko's table's.
            fake.priced = any(
                row.get("provider") in keyed
                and (
                    "cost_input_per_m" in row
                    or "cost_output_per_m" in row
                    or str(row.get("slug") or key) in PRICED_SLUGS
                )
                for key, row in (data.get("models") or {}).items()
            )
        time.sleep(0.2)


def watch(config: Path, seen: Path, delay: float) -> None:
    """roko serve's config watcher: what it serves from is `seen`, a copy of roko.toml taken `delay` seconds
    after each change (FAKE_ROKO_RELOAD_DELAY), as roko re-reads roko.toml only every 2 s or so."""
    last = config.stat().st_mtime_ns
    while True:
        time.sleep(0.05)
        try:
            now = config.stat().st_mtime_ns
        except OSError:
            continue
        if now != last:
            time.sleep(delay)
            copy = seen.with_suffix(".tmp")
            copy.write_bytes(config.read_bytes())
            copy.replace(seen)
            last = now


# -- where a serve is, and whether it is alive -------------------------------------------------------------


def option(argv: list[str], name: str) -> str | None:
    if name in argv:
        index = argv.index(name)
        if index + 1 < len(argv):
            return argv[index + 1]
    return None


def runtime_dir(workdir: Path) -> Path:
    return workdir / ".roko" / "runtime"


def registry_path(workdir: Path) -> Path:
    digest = hashlib.sha256(str(workdir).encode()).hexdigest()[:16]
    return Path.home() / ".roko" / "runtime" / "serves" / f"{digest}.json"


def read_json(path: Path) -> dict[str, Any] | None:
    try:
        value = json.loads(path.read_text())
    except (OSError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def pid_alive(pid: Any) -> bool:
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def lock_holder(workdir: Path) -> int | None:
    """The pid written in roko.lock while a process holds it; None when nobody holds it."""
    path = runtime_dir(workdir) / "roko.lock"
    try:
        handle = path.open("a+")
    except OSError:
        return None
    with handle:
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            handle.seek(0)
            text = handle.read().strip()
            return int(text) if text.isdigit() else -1
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        return None


def health(url: str, timeout: float = 1.0) -> dict[str, Any] | None:
    try:
        response = httpx.get(f"{url.rstrip('/')}/health", timeout=timeout)
        body = response.json() if response.status_code == 200 else None
    except (httpx.HTTPError, ValueError):
        return None
    return body if isinstance(body, dict) else None


def ours_and_alive(workdir: Path) -> dict[str, Any] | None:
    """The serve.json of W's serve when it passes §A2: its pid alive and holding roko.lock, and /health
    answering with its instance_id."""
    endpoint = read_json(runtime_dir(workdir) / "serve.json")
    if endpoint is None or not pid_alive(endpoint.get("pid")):
        return None
    if lock_holder(workdir) != endpoint.get("pid"):
        return None
    said = health(str(endpoint.get("url") or ""))
    if said is None or said.get("instance_id") != endpoint.get("instance_id"):
        return None
    return endpoint


def active_runs(endpoint: dict[str, Any], workdir: Path) -> int | None:
    token = runtime_dir(workdir) / "serve.token"
    headers = {"X-Api-Key": token.read_text().strip()} if token.is_file() else {}
    try:
        body = httpx.get(f"{endpoint['url']}/api/health", headers=headers, timeout=2.0).json()
    except (httpx.HTTPError, ValueError, KeyError):
        return None
    runs, plans = body.get("active_runs"), body.get("active_plans")
    if not isinstance(runs, int) or not isinstance(plans, int):
        return None
    return runs + plans


def remove_files(workdir: Path, pid: int) -> None:
    """serve.json, serve.token and the registry entry, when serve.json is `pid`'s."""
    endpoint = read_json(runtime_dir(workdir) / "serve.json")
    if endpoint is not None and endpoint.get("pid") not in (pid, None):
        return
    for path in (
        runtime_dir(workdir) / "serve.json",
        runtime_dir(workdir) / "serve.token",
        registry_path(workdir),
    ):
        with contextlib.suppress(OSError):
            path.unlink()


def free(port: int, bind: str = "127.0.0.1") -> bool:
    with socket.socket() as probe:
        try:
            probe.bind((bind, port))
        except OSError:
            return False
    return True


def configured_port(workdir: Path) -> int | None:
    try:
        data = tomllib.loads((workdir / "roko.toml").read_text())
    except (OSError, tomllib.TOMLDecodeError):
        return None
    port = (data.get("server") or {}).get("port")
    return port if isinstance(port, int) and not isinstance(port, bool) and port != 6677 else None


# -- roko serve, in the foreground ---------------------------------------------------------------------------


def serve(argv: list[str]) -> int:
    workdir = Path(option(argv, "--workdir") or os.getcwd()).resolve()
    requested = option(argv, "--port")
    port = int(requested) if requested is not None else (configured_port(workdir) or 0)
    idle = int(option(argv, "--idle-exit") or 0)
    config = workdir / "roko.toml"
    runtime = runtime_dir(workdir)
    runtime.mkdir(parents=True, exist_ok=True)
    lock = (runtime / "roko.lock").open("a+")
    try:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(f"Error: another roko process holds {workdir}", file=sys.stderr)
        return 1
    lock.seek(0)
    lock.truncate()
    lock.write(str(os.getpid()))
    lock.flush()
    delay = float(os.environ.get("FAKE_ROKO_START_DELAY") or 0)
    if delay:
        time.sleep(delay)
    if os.environ.get("FAKE_ROKO_START_FAIL"):
        print("roko serve: reading roko.toml", flush=True)
        print(
            "Error: the fake roko was told not to start (FAKE_ROKO_START_FAIL)", file=sys.stderr, flush=True
        )
        return 1
    seen: Path | None = None
    if config.is_file():
        data = tomllib.loads(config.read_text())
        auth = bool((data.get("serve") or {}).get("auth", {}).get("enabled", False))
        reload_delay = float(os.environ.get("FAKE_ROKO_RELOAD_DELAY") or 0)
        seen = config
        if reload_delay:
            seen = runtime / "seen-roko.toml"
            seen.write_bytes(config.read_bytes())
            threading.Thread(target=watch, args=(config, seen, reload_delay), daemon=True).start()
    elif not keys() & set(PROVIDER_KEYS):
        print(f"error: {NO_PROVIDER_MESSAGE}. Run `roko init` to set one up.", file=sys.stderr, flush=True)
        return 1
    else:
        auth = True  # roko's default
    fake = FakeRoko(
        auth=auth,
        config=seen,
        # roko's defaults (no roko.toml) set no data-model boundary: it refuses runs started from a chat.
        boundary=seen is not None,
        refusal_words=not os.environ.get("FAKE_ROKO_OLD"),
        mcp=not os.environ.get("FAKE_ROKO_NO_MCP"),
    ).start(port)
    if seen is not None:
        threading.Thread(target=follow, args=(fake, seen), daemon=True).start()
    busy = int(os.environ.get("FAKE_ROKO_ACTIVE") or 0)
    if busy:
        busy_plans(fake, busy)
    started_at = datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    instance = str(uuid.uuid4())
    bound = int(fake.url.rsplit(":", 1)[1])
    identity = {
        "pid": os.getpid(),
        "workdir": str(workdir),
        "instance_id": instance,
        "git_sha": git_sha(),
        "git_dirty": False,
        "started_at": started_at,
        "idle_exit_secs": idle or None,
    }
    fake.identity = identity
    if auth:
        (runtime / "serve.token").write_text(fake.launch_token)
    endpoint = {
        "pid": os.getpid(),
        "url": fake.url,
        "workdir": str(workdir),
        "started_at": started_at,
        "instance_id": instance,
        "port": bound,
        "version": VERSION,
        "git_sha": git_sha(),
        "git_dirty": False,
        "exe": os.environ.get("FAKE_ROKO_EXE") or str(Path(__file__).resolve()),
        "idle_exit_secs": idle or None,
        "args": {
            "bind": "127.0.0.1",
            "port_requested": int(requested) if requested is not None else None,
            "enable_terminal": False,
            "config": None,
        },
    }
    (runtime / "serve.json").write_text(json.dumps(endpoint))
    registry = registry_path(workdir)
    registry.parent.mkdir(parents=True, exist_ok=True)
    registry.write_text(json.dumps(endpoint))
    print(f"roko server listening on {fake.url}", flush=True)
    stop = threading.Event()
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, lambda *_: stop.set())
    while not stop.wait(0.1):
        if idle and time.monotonic() - fake.last_activity >= idle and not busy:
            print(f"roko serve: idle for {idle}s, stopping", flush=True)
            break
    remove_files(workdir, os.getpid())
    fake.stop()
    fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    lock.close()
    return 0


def busy_plans(fake: FakeRoko, count: int) -> None:
    """FAKE_ROKO_ACTIVE: runs that stay running, so `/api/health` reports them."""
    from fake_roko import Run

    with fake.lock:
        for n in range(count):
            run_id = f"busy-{n}"
            fake.runs[run_id] = Run(run_id, "run", ["running"])


# -- roko serve --detach / status / stop / restart --------------------------------------------------------


def answer(as_json: bool, body: dict[str, Any], human: list[str], code: int) -> int:
    if as_json:
        print(json.dumps(body))
    else:
        for line in human:
            print(line, file=sys.stdout if code == 0 else sys.stderr)
    return code


def failure(as_json: bool, code: str, message: str, exit_code: int, log_tail: list[str] | None = None) -> int:
    body = {"ok": False, "error": {"code": code, "message": message, "log_tail": log_tail or []}}
    return answer(as_json, body, [f"Error: {message}", *(log_tail or [])], exit_code)


def described(endpoint: dict[str, Any], started: bool) -> dict[str, Any]:
    workdir = Path(str(endpoint.get("workdir")))
    return {
        "ok": True,
        "started": started,
        **{key: endpoint.get(key) for key in ("workdir", "pid", "url", "port", "instance_id", "version")},
        **{key: endpoint.get(key) for key in ("git_sha", "git_dirty", "exe", "started_at", "idle_exit_secs")},
        "log": str(workdir / ".roko" / "logs" / "serve.log"),
    }


def tail(path: Path, count: int = 20) -> list[str]:
    try:
        return path.read_text(errors="replace").splitlines()[-count:]
    except OSError:
        return []


def detach(argv: list[str]) -> int:
    as_json = "--json" in argv
    workdir = Path(option(argv, "--workdir") or os.getcwd()).resolve()
    if not workdir.is_dir():
        return failure(as_json, "not_a_workspace", f"{workdir} is not a directory", 2)
    running = ours_and_alive(workdir)
    if running is not None:
        body = described(running, False)
        return answer(
            as_json, body, [f"roko serve runs for {workdir} at {body['url']} (pid {body['pid']})"], 0
        )
    holder = lock_holder(workdir)
    if holder is not None and pid_alive(holder):
        return failure(as_json, "locked", f"another roko process (pid {holder}) holds {workdir}", 1)
    requested = option(argv, "--port")
    if requested is not None:
        port = int(requested)
    else:
        configured = configured_port(workdir)
        port = configured if configured and free(configured) else 0
    log = workdir / ".roko" / "logs" / "serve.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    before = log.stat().st_size if log.exists() else 0
    child = [sys.executable, str(Path(__file__).resolve()), "serve", "--workdir", str(workdir)]
    if requested is not None or port:
        child += ["--port", str(port)]
    idle = option(argv, "--idle-exit")
    if idle and idle != "0":
        child += ["--idle-exit", idle]
    env = {name: value for name, value in os.environ.items() if name != "PORT"}
    with log.open("ab") as sink:
        process = subprocess.Popen(
            child,
            cwd=workdir,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=sink,
            stderr=sink,
            start_new_session=True,
        )
    deadline = time.monotonic() + float(option(argv, "--wait") or 60)
    while time.monotonic() < deadline:
        if process.poll() is not None:
            with log.open("rb") as handle:
                handle.seek(before)
                output = handle.read().decode(errors="replace")
            if NO_PROVIDER_MESSAGE in output:
                return failure(
                    as_json,
                    "not_initialized",
                    f"{workdir} is not set up for roko: no LLM provider configured. Run `roko init` there, "
                    "or put a provider's API key in ~/.roko/.env",
                    2,
                    tail(log),
                )
            return failure(
                as_json,
                "start_failed",
                f"roko serve exited before it listened ({process.returncode})",
                1,
                tail(log),
            )
        endpoint = read_json(runtime_dir(workdir) / "serve.json")
        if endpoint is not None and endpoint.get("pid") == process.pid:
            said = health(str(endpoint.get("url")))
            if said is not None and said.get("instance_id") == endpoint.get("instance_id"):
                body = described(endpoint, True)
                return answer(
                    as_json,
                    body,
                    [f"started roko serve for {workdir} at {body['url']} (pid {body['pid']})"],
                    0,
                )
        time.sleep(0.05)
    with contextlib.suppress(ProcessLookupError):
        process.kill()
    return failure(as_json, "timeout", "roko serve did not listen in time", 1, tail(log))


def targets(argv: list[str]) -> list[Path]:
    if "--all" in argv:
        found = []
        folder = Path.home() / ".roko" / "runtime" / "serves"
        for entry in sorted(folder.glob("*.json")) if folder.is_dir() else []:
            data = read_json(entry)
            if data is None or not pid_alive(data.get("pid")):
                with contextlib.suppress(OSError):
                    entry.unlink()
                continue
            found.append(Path(str(data.get("workdir"))))
        return found
    return [Path(option(argv, "--workdir") or os.getcwd()).resolve()]


def status(argv: list[str]) -> int:
    serves = []
    for workdir in targets(argv):
        endpoint = read_json(runtime_dir(workdir) / "serve.json")
        if endpoint is None:
            serves.append({"workdir": str(workdir), "state": "stopped"})
            continue
        alive = pid_alive(endpoint.get("pid"))
        if not alive:
            remove_files(workdir, int(endpoint.get("pid") or 0))
            serves.append({**endpoint, "state": "stale", "removed": True})
            continue
        if ours_and_alive(workdir) is None:
            serves.append({**endpoint, "state": "unresponsive", "uptime_secs": None, "active_runs": None})
            continue
        serves.append(
            {
                **endpoint,
                "state": "running",
                "uptime_secs": 1,
                "active_runs": active_runs(endpoint, workdir),
                "outdated": endpoint.get("git_sha") != git_sha(),
            }
        )
    every = all(serve.get("state") == "running" for serve in serves) and bool(serves)
    lines = [f"{serve['workdir']}: {serve['state']}" for serve in serves]
    return answer("--json" in argv, {"ok": True, "serves": serves}, lines, 0 if every else 1)


def stop_one(workdir: Path, force: bool, timeout: float) -> tuple[str, dict[str, Any]]:
    """("stopped" | "not_running" | "busy" | "unresponsive", its row), by §A2's check: a serve whose pid holds the
    lock but whose /health is silent is unresponsive and never signalled."""
    endpoint = read_json(runtime_dir(workdir) / "serve.json")
    pid = endpoint.get("pid") if endpoint is not None else None
    if endpoint is None or not pid_alive(pid) or lock_holder(workdir) != pid:
        return "not_running", {"workdir": str(workdir)}
    if ours_and_alive(workdir) is None:
        return "unresponsive", {"workdir": str(workdir), "pid": pid}
    runs = active_runs(endpoint, workdir)
    if not force and (runs is None or runs > 0):
        return "busy", {"workdir": str(workdir), "active_runs": runs}
    pid = int(endpoint["pid"])
    os.kill(pid, signal.SIGTERM)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline and lock_holder(workdir) == pid:
        time.sleep(0.05)
    if lock_holder(workdir) == pid:
        with contextlib.suppress(ProcessLookupError):
            os.kill(pid, signal.SIGKILL)
        remove_files(workdir, pid)
    return "stopped", {"workdir": str(workdir), "pid": pid, "endpoint": endpoint}


def busy_error(workdir: str, runs: int | None, doing: str) -> dict[str, Any]:
    if runs == 1:
        message = f"1 run is going in {workdir}; {doing} roko serve stops it. Pass --force to do it anyway"
    elif runs is not None:
        message = (
            f"{runs} runs are going in {workdir}; {doing} roko serve stops them. Pass --force to do it anyway"
        )
    else:
        message = (
            f"roko serve in {workdir} does not say whether runs are going; {doing} it would stop them. Pass "
            "--force to do it anyway"
        )
    return {"code": "busy", "message": message}


def unresponsive_error(workdir: str, pid: int) -> dict[str, Any]:
    return {
        "code": "unresponsive",
        "message": f"roko serve (PID {pid}) holds {workdir} but /health does not answer, so it was left alone",
    }


def finish(as_json: bool, report: dict[str, Any], error: dict[str, Any] | None, lines: list[str]) -> int:
    """roko's report with `ok`/`error` set by `error`, and its exit status (busy, unresponsive and failed: 1)."""
    if error is not None:
        report["ok"] = False
        report["error"] = error
        lines.append(f"Error: {error['message']}")
    return answer(as_json, report, lines, 1 if error is not None else 0)


def stop(argv: list[str]) -> int:
    force = "--force" in argv
    every = "--all" in argv
    timeout = float(option(argv, "--timeout") or 20)
    report: dict[str, Any] = {"ok": True, "stopped": [], "not_running": [], "busy": [], "unresponsive": []}
    error = None
    for workdir in targets(argv):
        kind, row = stop_one(workdir, force, timeout)
        row.pop("endpoint", None)
        report[kind].append(row["workdir"] if kind == "not_running" else row)
        if kind == "busy" and error is None:
            error = busy_error(row["workdir"], row["active_runs"], "stopping")
        elif kind == "unresponsive" and error is None:
            error = unresponsive_error(row["workdir"], row["pid"])
    lines = [f"stopped {row['workdir']}" for row in report["stopped"]]
    return finish("--json" in argv, report, None if every else error, lines)


def restart(argv: list[str]) -> int:
    force = "--force" in argv
    every = "--all" in argv
    report: dict[str, Any] = {
        "ok": True,
        "restarted": [],
        "not_running": [],
        "busy": [],
        "unresponsive": [],
        "failed": [],
    }
    refused = failed = None
    time.sleep(float(os.environ.get("FAKE_ROKO_RESTART_DELAY") or 0))
    for workdir in targets(argv):
        kind, row = stop_one(workdir, force, 20)
        if kind != "stopped":
            report[kind].append(row["workdir"] if kind == "not_running" else row)
            if kind == "busy" and refused is None:
                refused = busy_error(row["workdir"], row["active_runs"], "restarting")
            elif kind == "unresponsive" and refused is None:
                refused = unresponsive_error(row["workdir"], row["pid"])
            continue
        old = row["endpoint"]
        again = ["serve", "--detach", "--json", "--workdir", str(workdir)]
        port = old.get("port")
        if isinstance(port, int) and free(port):
            again += ["--port", str(port)]
        if old.get("idle_exit_secs"):
            again += ["--idle-exit", str(old["idle_exit_secs"])]
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), *again],
            capture_output=True,
            text=True,
            check=False,
        )
        try:
            started = json.loads(result.stdout)
        except ValueError:
            started = {"ok": False, "error": {"code": "start_failed", "message": result.stderr.strip()}}
        if started.get("ok") is True:
            report["restarted"].append(started)
        else:
            report["failed"].append({"workdir": str(workdir), "error": started.get("error")})
            failed = failed or started.get("error")
    lines = [f"restarted {row.get('workdir')}" for row in report["restarted"]]
    return finish("--json" in argv, report, failed or (None if every else refused), lines)


def serve_command(argv: list[str]) -> int:
    old = bool(os.environ.get("FAKE_ROKO_NO_DETACH"))
    if "--help" in argv or "-h" in argv:
        print(OLD_SERVE_HELP if old else SERVE_HELP)
        return 0
    words = [word for word in argv[1:2] if not word.startswith("-")]
    if words and words[0] in ("status", "stop", "restart"):
        if old:
            print(f"error: unexpected argument '{words[0]}' found", file=sys.stderr)
            return 2
        return {"status": status, "stop": stop, "restart": restart}[words[0]](argv)
    if "--detach" in argv:
        if old:
            print("error: unexpected argument '--detach' found", file=sys.stderr)
            return 2
        return detach(argv)
    return serve(argv)


def preset(argv: list[str]) -> int:
    if not os.environ.get("FAKE_ROKO_PRESET"):
        print("error: unrecognized subcommand 'chat-host'", file=sys.stderr)
        return 2
    if os.environ["FAKE_ROKO_PRESET"] == "refuse":
        print("Error: roko.toml at ./roko.toml is not valid: duplicate key `mcp`", file=sys.stderr)
        return 2
    workdir = Path(argv[argv.index("--workdir") + 1]) if "--workdir" in argv else Path.cwd()
    path = workdir / "roko.toml"
    old = path.read_text()
    new = re.sub(r"(?m)^allow_without_data_llm = false$", "allow_without_data_llm = true", old)
    diff = "" if new == old else "-allow_without_data_llm = false\n+allow_without_data_llm = true\n"
    written = "--yes" in argv and new != old
    if written:
        path.write_text(new)
    answer_body: dict[str, Any] = {
        "preset": "chat-host",
        "path": str(path),
        "dry_run": "--dry-run" in argv,
        "written": written,
        "edit": {"key": "serve.mcp.allow_without_data_llm", "value": True},
        "why": "--allow-without-data-llm",
        "diff": diff,
        "ready": (written or new == old) and not os.environ.get("FAKE_ROKO_PRESET_NO_MODEL"),
        "refusals": ["no_tool_loop_model"] if os.environ.get("FAKE_ROKO_PRESET_NO_MODEL") else [],
        "refusal": "a run from a chat host needs a model …"
        if os.environ.get("FAKE_ROKO_PRESET_NO_MODEL")
        else None,
        "commit": False,
    }
    print(json.dumps(answer_body))
    return 0


def main(argv: list[str]) -> int:
    logged = os.environ.get("FAKE_ROKO_ARGV_LOG")
    if logged:
        with open(logged, "a", encoding="utf-8") as out:
            out.write(json.dumps(argv) + "\n")
    if argv[:1] in (["--version"], ["-V"]):
        print(f"roko {VERSION} (fake, aarch64-apple-darwin, git {git_sha()})")
        return 0
    if argv[:1] == ["init"]:
        Path("roko.toml").write_text(INIT_TOML)
        print("wrote ./roko.toml")
        print("detected project domain: general")
        return 0
    if argv[:1] == ["serve"]:
        return serve_command(argv)
    if argv[:3] == ["config", "preset", "chat-host"]:
        return preset(argv)
    if argv[:2] == ["plan", "validate"]:
        return 0
    print(f"fake roko: unknown command {argv}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

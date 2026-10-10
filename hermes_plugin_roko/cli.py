"""`hermes roko setup | doctor | status`: connect Hermes to roko serve, and check the link.

`setup` finds roko serve, works out whether it has auth on, and if so stores
a write-scoped API key for Hermes. With `--mint` it creates that key itself,
using the admin launch token roko serve writes to
`<workspace>/.roko/runtime/serve.token` while it runs. Nothing here asks
roko to spend money.

Exit codes: 0 ok · 1 failed · 2 bad usage · 3 the person must act (or a
warning under --strict) · 4 roko serve unreachable.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

from . import _hermes, render
from .catalog import ROKO_MCP_TOOLS
from .client import RokoClient
from .diagnostics import SETUP_STATE_KEY, run_doctor
from .errors import Code, RokoError
from .runtime import Runtime
from .settings import DEFAULT_URL, URL_ENV_VARS, Credential, Settings, read_serve_endpoint
from .tools import overview

logger = logging.getLogger(__name__)

EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_ACTION, EXIT_UNREACHABLE = 0, 1, 2, 3, 4


def build_parser(parser: argparse.ArgumentParser) -> None:
    """Add the subcommands. Hermes stops loading every plugin's CLI if this raises."""
    try:
        sub = parser.add_subparsers(dest="roko_command", metavar="{setup,doctor,status}")
        setup = sub.add_parser("setup", help="connect Hermes to roko serve and store an API key")
        setup.add_argument("--url", dest="roko_url", help=f"roko serve URL (default {DEFAULT_URL})")
        setup.add_argument(
            "--workdir",
            dest="roko_workdir",
            help="the roko workspace roko serve runs in; finds its URL and launch token",
        )
        setup.add_argument(
            "--mint",
            dest="roko_mint",
            action="store_true",
            help="create a write-scoped key with roko serve's launch token (needs --workdir)",
        )
        setup.add_argument(
            "--key-stdin", dest="roko_key_stdin", action="store_true", help="read an existing key from stdin"
        )
        setup.add_argument("--key-name", dest="roko_key_name", default="hermes", help="name for a minted key")
        setup.add_argument(
            "--yes",
            dest="roko_yes",
            action="store_true",
            help="answer yes (rotate an existing key of that name)",
        )
        setup.add_argument("--dry-run", dest="roko_dry_run", action="store_true", help="change nothing")
        doctor = sub.add_parser("doctor", help="check that Hermes can use roko")
        doctor.add_argument("--json", dest="roko_json", action="store_true")
        doctor.add_argument("--offline", dest="roko_offline", action="store_true", help="local checks only")
        doctor.add_argument("--strict", dest="roko_strict", action="store_true", help="exit 3 on a warning")
        doctor.add_argument(
            "--no-probe", dest="roko_no_probe", action="store_true", help="skip the free run-permission probe"
        )
        status = sub.add_parser("status", help="roko's health and the runs Hermes started")
        status.add_argument("--json", dest="roko_json", action="store_true")
    except Exception:  # pragma: no cover - defensive: never break Hermes' CLI
        logger.exception("roko: could not build the `hermes roko` parser")


def make_main(rt: Runtime) -> Callable[[argparse.Namespace], int]:
    def main(args: argparse.Namespace) -> int:
        command = getattr(args, "roko_command", None)
        try:
            if command == "setup":
                return setup(rt, args)
            if command == "doctor":
                return doctor(rt, args)
            if command == "status":
                return status(rt, args)
        except RokoError as exc:
            _err(exc.one_line())
            return EXIT_UNREACHABLE if exc.code is Code.UNREACHABLE else EXIT_FAIL
        except KeyboardInterrupt:
            _err("roko: interrupted")
            return EXIT_FAIL
        except Exception as exc:  # e.g. a managed install refusing to save settings
            _err(f"roko: hermes roko {command} failed: {type(exc).__name__}: {exc}")
            return EXIT_FAIL
        print("usage: hermes roko {setup,doctor,status} [--help]")
        return EXIT_USAGE

    return main


# -- doctor / status ---------------------------------------------------------


def doctor(rt: Runtime, args: argparse.Namespace) -> int:
    report = run_doctor(
        rt,
        offline=bool(getattr(args, "roko_offline", False)),
        probe_runs=not getattr(args, "roko_no_probe", False),
    )
    if getattr(args, "roko_json", False):
        print(json.dumps({"checks": [check.as_dict() for check in report.checks]}, indent=2))
    else:
        print(render.doctor(report))
    return report.exit_code(strict=bool(getattr(args, "roko_strict", False)))


def status(rt: Runtime, args: argparse.Namespace) -> int:
    view = overview(rt)
    if getattr(args, "roko_json", False):
        print(json.dumps(view, indent=2, default=str))
    else:
        print(render.overview(view))
    return EXIT_OK


# -- setup -------------------------------------------------------------------


def setup(rt: Runtime, args: argparse.Namespace) -> int:
    current = rt.settings()
    workdir = current.workdir
    if getattr(args, "roko_workdir", None):
        workdir = Path(args.roko_workdir).expanduser().resolve()
        if not workdir.is_dir():
            _err(f"roko: --workdir {workdir} is not a directory")
            return EXIT_USAGE
    endpoint = read_serve_endpoint(workdir) if workdir else None
    url = _pick_url(args, current, endpoint)
    target = replace(current, url=url, url_source="setup", workdir=workdir)
    env_override = next((name for name in URL_ENV_VARS if _env(name)), None)

    print(f"roko serve: {target.display_url}")
    anonymous = RokoClient(target, credential=Credential(None, "none"))
    try:
        health = anonymous.health()
    except RokoError as exc:
        _err(exc.one_line())
        if workdir and endpoint is None:
            _err(f"  (no roko serve is running in {workdir}: start it with `roko serve --workdir {workdir}`)")
        return EXIT_UNREACHABLE
    finally:
        anonymous.close()
    print(f"  reachable: roko {health.get('version', '?')}, {health.get('status', '?')}")

    auth_on = _auth_required(target)
    key, key_name, minted = None, None, False
    if not auth_on:
        print("  auth: off on this roko serve, so Hermes needs no key")
        if not target.is_loopback:
            print("  ! a roko serve reachable from other machines should run with auth on")
    else:
        print("  auth: on")
        key, key_name, minted, code = _obtain_key(args, target, current)
        if key is None:
            return code

    credential = Credential(key, "setup") if key else Credential(None, "none")
    checked = RokoClient(target, credential=credential)
    try:
        names = set(checked.tool_names())
    except RokoError as exc:
        _err(f"roko: the key works but roko's /mcp endpoint failed: {exc.one_line()}")
        return EXIT_FAIL
    finally:
        checked.close()
    missing = [name for name in ROKO_MCP_TOOLS if name not in names]
    if missing:
        _err(f"roko: this roko serve lacks MCP tools the plugin needs: {', '.join(missing)}; update roko")
        return EXIT_FAIL
    print(f"  /mcp: all {len(ROKO_MCP_TOOLS)} tools the plugin uses are served")

    if getattr(args, "roko_dry_run", False):
        print("\n--dry-run: nothing was saved.")
        return EXIT_OK

    _save(rt, current, target, key, key_name, minted)
    if env_override:
        print(f"  ! {env_override} is set in the environment and overrides the saved URL")

    print()
    report = run_doctor(rt)
    print(render.doctor(report))
    print()
    print("Next: start a new Hermes session (restart a running gateway) and ask it to use roko,")
    print('e.g. "Use roko to add a unit test for the parser, max $1".')
    return report.exit_code()


def _pick_url(args: argparse.Namespace, current: Settings, endpoint: dict[str, Any] | None) -> str:
    if getattr(args, "roko_url", None):
        return str(args.roko_url).strip().rstrip("/")
    if endpoint and isinstance(endpoint.get("url"), str):
        return str(endpoint["url"]).rstrip("/")
    return current.url


def _auth_required(target: Settings) -> bool:
    client = RokoClient(target, credential=Credential(None, "none"))
    try:
        response = client.get_response("/api/health")
    finally:
        client.close()
    return response.status_code == 401


def _obtain_key(
    args: argparse.Namespace, target: Settings, current: Settings
) -> tuple[str | None, str | None, bool, int]:
    """(key, key name if minted, minted?, exit code if no key)."""
    if getattr(args, "roko_key_stdin", False):
        key = sys.stdin.readline().strip()
        if not key:
            _err("roko: --key-stdin read an empty line")
            return None, None, False, EXIT_USAGE
        if not _key_works(target, key):
            _err("roko: roko serve refused that key")
            return None, None, False, EXIT_FAIL
        print("  key: the key from stdin works")
        return key, None, False, EXIT_OK

    existing = current.credential()
    if existing.present and existing.source.startswith("env:") and not getattr(args, "roko_mint", False):
        if _key_works(target, existing.value or ""):
            print(f"  key: the key in {existing.source[4:]} works")
            return existing.value, None, False, EXIT_OK
        print(f"  key: the key in {existing.source[4:]} is refused")

    if not getattr(args, "roko_mint", False):
        _err(
            "roko: Hermes needs an API key for this roko serve. Either\n"
            "  hermes roko setup --workdir WORKSPACE --mint    "
            f"(creates a write-scoped key '{args.roko_key_name}')\n"
            "  hermes roko setup --key-stdin < keyfile            (stores a key you already have)"
        )
        return None, None, False, EXIT_ACTION

    token_path = target.launch_token_path()
    if token_path is None:
        where = f"in {target.workdir}" if target.workdir else "without --workdir"
        _err(
            f"roko: no launch token found {where}. roko serve writes .roko/runtime/serve.token "
            "only when auth is on, it binds to loopback, and no API key is configured; pass "
            "--workdir WORKSPACE (where roko serve runs), or use --key-stdin"
        )
        return None, None, False, EXIT_ACTION
    token = token_path.read_text(encoding="utf-8").strip()
    admin = RokoClient(target, credential=Credential(token, f"launch-token:{token_path}"))
    name = str(args.roko_key_name)
    try:
        try:
            created = admin.post("/api/api-keys", {"name": name, "scope": "write"})
        except RokoError as exc:
            if exc.code is not Code.CONFLICT:
                raise
            if not getattr(args, "roko_yes", False) and not _confirm(
                f"  roko already has a key named '{name}'. Rotate it (the old one stops working)? [y/N] "
            ):
                _err(f"roko: kept the existing key; pass --key-name NAME or --yes to rotate '{name}'")
                return None, None, False, EXIT_ACTION
            created = admin.post(f"/api/api-keys/{name}/rotate", {})
    finally:
        admin.close()
    key = created.get("key") if isinstance(created, dict) else None
    if not isinstance(key, str) or not key:
        _err("roko: roko serve did not return the new key")
        return None, None, False, EXIT_FAIL
    if not _key_works(target, key):
        _err("roko: the new key was refused")
        return None, None, False, EXIT_FAIL
    scope = created.get("scope") if isinstance(created, dict) else None
    print(f"  key: minted '{name}' with the {scope or 'unknown'} scope")
    if scope not in ("write", "admin", "owner"):
        # Rotating keeps the old key's scope, which may be too small.
        _err(
            f"roko: key '{name}' has the {scope} scope, which cannot start runs; "
            "pass --key-name NAME to mint a write-scoped key instead"
        )
        return None, None, False, EXIT_FAIL
    return key, name, True, EXIT_OK


def _key_works(target: Settings, key: str) -> bool:
    client = RokoClient(target, credential=Credential(key, "check"))
    try:
        response = client.get_response("/api/health")
    except RokoError:
        return False
    finally:
        client.close()
    return response.status_code < 400 or response.status_code == 503


def _save(
    rt: Runtime, current: Settings, target: Settings, key: str | None, key_name: str | None, minted: bool
) -> None:
    if key and (minted or current.credential().value != key):
        path = _hermes.save_env_value(current.api_key_env, key)
        if not _env_file_has(path, current.api_key_env, key):
            # Hermes declines to save on a managed install, and says so only on stderr.
            raise RokoError(
                Code.CONFIG,
                f"Hermes did not save {current.api_key_env} to {path}",
                hint=f"set {current.api_key_env} in the environment Hermes runs with, then rerun setup",
            )
        print(f"  saved {current.api_key_env} to {path}")
    if target.url != current.url or current.url_source != "settings":
        rt.set_config("url", target.url)
        print(f"  saved plugins.entries.roko.settings.url = {target.display_url}")
    if target.workdir and target.workdir != current.workdir:
        rt.set_config("workdir", str(target.workdir))
        print(f"  saved plugins.entries.roko.settings.workdir = {target.workdir}")
    record: dict[str, Any] = {"url": target.url, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if key_name:
        record["key_name"] = key_name
    try:
        if rt.ctx is not None:
            rt.ctx.state.set(SETUP_STATE_KEY, record)
    except Exception as exc:
        logger.debug("roko: could not record setup state: %s", exc)


def _env_file_has(path: Path, key: str, value: str) -> bool:
    """Whether the dotenv file at `path` sets `key` to `value` (quoted or not)."""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return False
    for line in lines:
        name, sep, raw = line.strip().removeprefix("export ").partition("=")
        if sep and name.strip() == key and raw.strip().strip("'\"") == value:
            return True
    return False


def _confirm(question: str) -> bool:
    if not sys.stdin.isatty():
        return False
    try:
        return input(question).strip().lower() in ("y", "yes")
    except EOFError:
        return False


def _env(name: str) -> str:
    import os

    return os.environ.get(name, "").strip()


def _err(text: str) -> None:
    print(text, file=sys.stderr)

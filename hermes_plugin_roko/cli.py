"""`hermes roko init | setup | doctor | fix | status | watch | serve | projects`: make a project ready,
connect Hermes to roko serve, check it, fix it, follow runs, and (0.7.0) start, stop and restart each
project's roko serve and keep the list of projects.

`init` makes a project ready in one command (onboard.py): roko's key, `roko init`, roko serve, the
connection, the settings runs from Hermes need, and the hello-world demo.

`setup` finds roko serve, works out whether it has auth on, and if so stores
a write-scoped API key for Hermes. With `--mint` it creates that key itself,
using the admin launch token roko serve writes to
`<workspace>/.roko/runtime/serve.token` while it runs. It ends with the
doctor, and offers each fix the plugin can make itself (`fix` does that on its
own: it shows the change, then asks). `watch` redraws a run's card until the
run ends, for a second terminal next to a chat. `serve` starts, stops and
restarts a project's roko serve the one way the plugin does (serve.py), and
`projects` lists, adds, removes and picks the default project. Nothing here
asks roko to spend money.

Exit codes: 0 ok · 1 failed · 2 bad usage · 3 the person must act (or a
warning under --strict) · 4 roko serve unreachable.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import shlex
import sys
import time
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

from . import _hermes, readiness, render, views
from . import serve as serving
from .catalog import ROKO_MCP_TOOLS, TERMINAL_STATES
from .client import RokoClient
from .diagnostics import SETUP_STATE_KEY, run_doctor
from .errors import Code, RokoError
from .rundata import explain
from .runtime import Runtime
from .sanitize import clean
from .settings import (
    URL_ENV_VARS,
    Credential,
    Settings,
    display_url,
    is_loopback_url,
    read_serve_endpoint,
    same_path,
)
from .views import overview

logger = logging.getLogger(__name__)

EXIT_OK, EXIT_FAIL, EXIT_USAGE, EXIT_ACTION, EXIT_UNREACHABLE = 0, 1, 2, 3, 4
WATCH_CHARS = 8_000
WATCH_EVENTS = 10
WATCH_INTERVAL = 2.0  # seconds between checks of a watched run


def build_parser(parser: argparse.ArgumentParser) -> None:
    """Add the subcommands. Hermes stops loading every plugin's CLI if this raises."""
    try:
        sub = parser.add_subparsers(
            dest="roko_command", metavar="{init,setup,doctor,fix,status,watch,serve,projects}"
        )
        init = sub.add_parser(
            "init", help="make a project ready for roko runs started from Hermes, in one command"
        )
        init.add_argument("--workdir", dest="roko_workdir", help="the project (default: the current folder)")
        init.add_argument(
            "--port",
            dest="roko_port",
            type=int,
            help="the port for a roko serve it starts (default: roko.toml's, or a free one)",
        )
        init.add_argument(
            "--no-serve", dest="roko_no_serve", action="store_true", help="do not start roko serve; say how"
        )
        init.add_argument(
            "--launchd",
            dest="roko_launchd",
            action="store_true",
            help="write a login item that starts roko serve (macOS), instead of starting it now",
        )
        init.add_argument("--yes", dest="roko_yes", action="store_true", help="answer yes to every question")
        init.add_argument(
            "--dry-run", dest="roko_dry_run", action="store_true", help="look only; change nothing"
        )
        setup = sub.add_parser("setup", help="connect Hermes to roko serve and store an API key")
        setup.add_argument(
            "--url",
            dest="roko_url",
            help="roko serve's URL: one on another machine is saved; on this machine it finds the project",
        )
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
            help="answer yes (rotate an existing key of that name, apply the fixes it offers)",
        )
        setup.add_argument("--dry-run", dest="roko_dry_run", action="store_true", help="change nothing")
        doctor = sub.add_parser("doctor", help="check that Hermes can use roko")
        doctor.add_argument("--json", dest="roko_json", action="store_true")
        doctor.add_argument("--offline", dest="roko_offline", action="store_true", help="local checks only")
        doctor.add_argument("--strict", dest="roko_strict", action="store_true", help="exit 3 on a warning")
        doctor.add_argument(
            "--no-probe", dest="roko_no_probe", action="store_true", help="skip the free run-permission probe"
        )
        fix = sub.add_parser(
            "fix", help="fix what stands between Hermes and roko: shows the change, then asks"
        )
        fix.add_argument(
            "roko_fix_action",
            nargs="?",
            metavar="ACTION",
            help=f"the fix to make ({', '.join(readiness.ACTIONS)}); without it, list what needs fixing",
        )
        fix.add_argument(
            "--variant",
            dest="roko_variant",
            choices=readiness.VARIANTS,
            help="for workspace-chat-ready: local (the default: run without the boundary, as runs started "
            "in a terminal do) or boundary (screen what their agents fetch with an API model)",
        )
        fix.add_argument("--yes", dest="roko_yes", action="store_true", help="apply it without asking")
        fix.add_argument("--dry-run", dest="roko_dry_run", action="store_true", help="show the change only")
        status = sub.add_parser("status", help="roko's health and the runs Hermes started, or one run")
        status.add_argument("roko_status_run", nargs="?", metavar="RUN", help="a run id, or last")
        status.add_argument("--json", dest="roko_json", action="store_true")
        status.add_argument(
            "--why", dest="roko_why", action="store_true", help="with RUN: why it ended as it did"
        )
        watch = sub.add_parser(
            "watch", help="follow a run live until it ends (q stops watching; the run goes on)"
        )
        watch.add_argument(
            "roko_watch_run", nargs="?", default="last", metavar="RUN", help="a run id, or last"
        )
        watch.add_argument(
            "--interval",
            dest="roko_interval",
            type=float,
            default=WATCH_INTERVAL,
            help=f"seconds between checks (default {WATCH_INTERVAL:g})",
        )
        watch.add_argument(
            "--once", dest="roko_once", action="store_true", help="print the card once, as plain text"
        )
        serve = sub.add_parser("serve", help="a project's roko serve: status, start, stop, restart")
        serve.add_argument(
            "roko_serve_action",
            nargs="?",
            default="status",
            choices=("status", "start", "stop", "restart"),
            help="what to do (default: status)",
        )
        serve.add_argument(
            "--project", dest="roko_project", help="the project: a folder, or a known project's name"
        )
        serve.add_argument("--all", dest="roko_all", action="store_true", help="every known project")
        serve.add_argument(
            "--force",
            dest="roko_force",
            action="store_true",
            help="stop or restart it even while runs are going (they stop; their work so far is kept)",
        )
        serve.add_argument("--json", dest="roko_json", action="store_true")
        projects = sub.add_parser("projects", help="the projects Hermes uses roko in, and the default one")
        projects.add_argument(
            "roko_projects_action",
            nargs="?",
            default="list",
            choices=("list", "add", "remove", "default"),
            help="what to do (default: list)",
        )
        projects.add_argument("roko_projects_path", nargs="?", metavar="PATH", help="the project's folder")
        projects.add_argument("--json", dest="roko_json", action="store_true")
    except Exception:  # pragma: no cover - defensive: never break Hermes' CLI
        logger.exception("roko: could not build the `hermes roko` parser")


def make_main(rt: Runtime) -> Callable[[argparse.Namespace], int]:
    def main(args: argparse.Namespace) -> int:
        command = getattr(args, "roko_command", None)
        try:
            if command == "init":
                return init_command(rt, args)
            if command == "setup":
                return setup(rt, args)
            if command == "doctor":
                return doctor(rt, args)
            if command == "fix":
                return fix_command(rt, args)
            if command == "status":
                return status(rt, args)
            if command == "watch":
                return watch(rt, args)
            if command == "serve":
                return serve_command(rt, args)
            if command == "projects":
                return projects_command(rt, args)
        except RokoError as exc:
            _err(exc.one_line())
            return EXIT_UNREACHABLE if exc.code is Code.UNREACHABLE else EXIT_FAIL
        except KeyboardInterrupt:
            _err("roko: interrupted")
            return EXIT_FAIL
        except Exception as exc:  # e.g. a managed install refusing to save settings
            _err(f"roko: hermes roko {command} failed: {type(exc).__name__}: {exc}")
            return EXIT_FAIL
        print("usage: hermes roko {init,setup,doctor,fix,status,watch,serve,projects} [--help]")
        return EXIT_OK if command is None else EXIT_USAGE

    return main


# -- doctor / status ---------------------------------------------------------


def doctor(rt: Runtime, args: argparse.Namespace) -> int:
    report = run_doctor(
        rt,
        offline=bool(getattr(args, "roko_offline", False)),
        probe_runs=not getattr(args, "roko_no_probe", False),
    )
    if getattr(args, "roko_json", False):
        body = {"checks": [check.as_dict() for check in report.checks], "problems": report.problems}
        print(json.dumps(body, indent=2))
    else:
        print(render.doctor(report))
    return report.exit_code(strict=bool(getattr(args, "roko_strict", False)))


# -- fix ---------------------------------------------------------------------


def fix_command(rt: Runtime, args: argparse.Namespace) -> int:
    """`hermes roko fix [ACTION]`: list what needs fixing, or show one fix and make it."""
    action = getattr(args, "roko_fix_action", None)
    if not action:
        readiness.invalidate(rt)
        setup = readiness.setup_view(rt)
        print(render.setup_problems(setup["problems"]))
        return EXIT_OK if setup["ok"] else EXIT_ACTION
    return offer_fix(
        rt,
        action,
        getattr(args, "roko_variant", None),
        yes=bool(getattr(args, "roko_yes", False)),
        dry_run=bool(getattr(args, "roko_dry_run", False)),
    )


def offer_fix(rt: Runtime, action: str, variant: str | None, *, yes: bool, dry_run: bool = False) -> int:
    """Show what a fix changes, then make it: at once with `yes`, else after the person says y.

    Without a terminal to ask on, print the change and the command that makes it.
    """
    return _offer_fix(rt, action, variant, yes=yes, dry_run=dry_run)[0]


def _offer_fix(
    rt: Runtime, action: str, variant: str | None, *, yes: bool, dry_run: bool = False
) -> tuple[int, bool]:
    """`offer_fix`, and whether it changed anything."""
    preview = readiness.fix_preview(rt, action, variant)
    print(f"{preview['title']}: {preview['path']}")
    print(f"  {preview['summary']}")
    if preview["preview"]:
        print()
        print(clean(preview["preview"]).rstrip("\n"))
        print()
    if preview["note"]:
        print(f"  {preview['note']}")
    others = [v for v in preview["variants"] if v["id"] != preview["variant"] and v.get("available")]
    for other in others:
        print(f"  (or {other['label']}: hermes roko fix {action} --variant {other['id']})")
    if dry_run:
        return EXIT_OK, False
    if preview["preview"] and not yes:
        command = f"hermes roko fix {action} --variant {preview['variant']} --yes"
        if not sys.stdin.isatty():
            print(f"Make this change with: {command}")
            return EXIT_ACTION, False
        if not _confirm("Make this change? [y/N] "):
            print("Nothing was changed.")
            return EXIT_ACTION, False
    result = readiness.apply_fix(rt, action, preview["variant"], preview["digest"])
    print(result["message"])
    if result.get("backup"):
        print(f"  the old file is kept as {result['backup']}")
    if result.get("next"):
        print(f"  Next: {result['next']}")
    return (EXIT_OK if result.get("ready") else EXIT_ACTION), bool(result.get("done"))


def status(rt: Runtime, args: argparse.Namespace) -> int:
    run = getattr(args, "roko_status_run", None)
    view = views.card(rt, run) if run else overview(rt)
    why = None
    if run and getattr(args, "roko_why", False):
        why = explain(rt.cards, rt.for_run(str(view.get("run_id"))).settings().url, view)
    if getattr(args, "roko_json", False):
        print(json.dumps({**view, "why": why} if why else view, indent=2, default=str))
    elif run:
        print(render.card(view, why, limit=WATCH_CHARS))
    else:
        print(render.overview(view))
    return EXIT_OK


def watch(rt: Runtime, args: argparse.Namespace) -> int:
    """Follow a run until it ends: live and full screen on a terminal, else its card as text.

    Ends 0 when the run ends or the person stops watching, whatever the run's verdict.
    """
    run_id = views.resolve_run_id(rt, str(getattr(args, "roko_watch_run", None) or "last"))
    interval = max(1.0, float(getattr(args, "roko_interval", WATCH_INTERVAL) or WATCH_INTERVAL))
    if getattr(args, "roko_once", False) or not sys.stdout.isatty():
        text, _ = _watch_frame(rt, run_id)
        print(text)
        return EXIT_OK
    try:
        from rich.console import Console

        from . import live
    except ImportError:  # pragma: no cover - rich ships with Hermes
        return _watch_plain(rt, run_id, interval)

    def fetch() -> tuple[dict[str, Any], list[dict[str, Any]]]:
        return views.card(rt, run_id), _timeline(rt, run_id)

    first = fetch()  # a run roko does not know fails here, before the screen opens
    live.watch(fetch, run_id=run_id, interval=interval, console=Console(), first=first)
    return EXIT_OK


def _watch_plain(rt: Runtime, run_id: str, interval: float) -> int:
    try:
        while True:
            text, done = _watch_frame(rt, run_id)
            print("\x1b[2J\x1b[H" + text, flush=True)
            if done:
                return EXIT_OK
            time.sleep(interval)
    except KeyboardInterrupt:
        return EXIT_OK


def _watch_frame(rt: Runtime, run_id: str) -> tuple[str, bool]:
    """The text to show now, and whether the run has ended."""
    stamp = time.strftime("%H:%M:%S")
    try:
        run = views.card(rt, run_id)
    except RokoError as exc:
        if exc.code is Code.NOT_FOUND:
            raise
        return f"roko run {run_id[:8]}\n⚠ {exc.message} (retrying) · {stamp}", False
    lines = [render.card(run, limit=WATCH_CHARS)]
    recent = _timeline(rt, run_id)[-WATCH_EVENTS:]
    if recent:
        lines.append("")
        lines.append("Recent events:")
        lines.extend(
            f"  {'✓' if e.get('passed') else '✗' if e.get('passed') is False else '·'} {e['text']}"
            for e in recent
        )
    done = run.get("state") in TERMINAL_STATES
    lines.append("")
    lines.append(f"checked {stamp} · " + ("the run has ended" if done else "Ctrl-C to stop watching"))
    return "\n".join(lines), done


def _timeline(rt: Runtime, run_id: str) -> list[dict[str, Any]]:
    """The run's readable timeline as the last card read left it."""
    tracker = rt.cards.tracker(rt.for_run(run_id).settings().url, run_id)
    with tracker.lock:
        return list(tracker.fold.timeline)


# -- serve / projects (0.7.0) --------------------------------------------------


def serve_command(rt: Runtime, args: argparse.Namespace) -> int:
    """`hermes roko serve [status|start|stop|restart] [--project P | --all] [--force] [--json]`."""
    action = str(getattr(args, "roko_serve_action", None) or "status")
    force = bool(getattr(args, "roko_force", False))
    if rt.settings().remote:
        _err(f"roko: {rt.settings().where} is not on this machine, so Hermes starts and stops nothing there")
        return EXIT_USAGE
    try:
        targets = _projects_for(rt, args)
    except RokoError as exc:
        _err(exc.one_line())
        return EXIT_USAGE
    if not targets:
        _err("roko: no project is known yet: run `hermes roko init` in your project, or pass --project PATH")
        return EXIT_ACTION
    states: list[serving.ServeState] = []
    code = EXIT_OK
    for project in targets:
        try:
            if action == "status":
                state = serving.serve_state(rt, project)
            elif action == "start":
                state = serving.ensure_serve(rt, project, wait=True, reason="manual")
            elif action == "stop":
                state = serving.stop_serve(rt, project, force=force)
            else:
                state = serving.restart_serve(rt, project, force=force, wait=True)
        except RokoError as exc:
            _err(exc.one_line())
            code = max(code, EXIT_ACTION if exc.code is Code.CONFLICT else EXIT_FAIL)
            continue
        if state is None:
            continue
        states.append(state)
        code = max(code, _serve_exit(action, state))
    if getattr(args, "roko_json", False):
        print(json.dumps({"serves": [state.as_dict() for state in states]}, indent=2))
    else:
        for state in states:
            print(_serve_line(state))
            if state.state == "failed" and state.log_tail:
                for line in state.log_tail[-6:]:
                    print(f"    {line}")
    return code


def _projects_for(rt: Runtime, args: argparse.Namespace) -> list[Path]:
    if getattr(args, "roko_all", False):
        return rt.projects.paths()
    named = getattr(args, "roko_project", None)
    if named:
        found = rt.projects.find(str(named))
        if found is not None:
            return [found]
        from .projects import check_folder

        return [check_folder(str(Path(str(named)).expanduser().resolve()))]
    default = rt.settings().workdir
    return [default] if default is not None else []


def _serve_exit(action: str, state: serving.ServeState) -> int:
    if action == "stop":
        return EXIT_OK if state.state in ("stopped", "failed") else EXIT_FAIL
    if state.state == "running":
        return EXIT_OK
    if state.state == "starting":
        return EXIT_OK if action == "restart" else EXIT_ACTION
    if state.state in ("not_found", "outdated", "stopped"):
        return EXIT_ACTION
    return EXIT_FAIL


def _serve_line(state: serving.ServeState) -> str:
    parts = [f"{state.name}: {state.state}"]
    if state.url:
        parts.append(state.url)
    if state.pid:
        parts.append(f"pid {state.pid}")
    if state.version:
        parts.append(f"roko {state.version}" + (f" (git {state.git_sha})" if state.git_sha else ""))
    if state.started_by == "hermes":
        parts.append("started by Hermes")
    if state.state == "running" and state.idle_exit_minutes:
        parts.append(f"stops after {state.idle_exit_minutes} idle minutes")
    if state.busy:
        parts.append(f"{state.busy.get('active_runs')} runs going")
    line = " · ".join(parts)
    if state.error:
        line += f"\n    {state.error.get('message')}"
        if state.error.get("hint"):
            line += f"\n    {state.error.get('hint')}"
    return line


def projects_command(rt: Runtime, args: argparse.Namespace) -> int:
    """`hermes roko projects [list | add PATH | remove PATH | default PATH] [--json]`."""
    action = str(getattr(args, "roko_projects_action", None) or "list")
    path = getattr(args, "roko_projects_path", None)
    if action != "list":
        if not path:
            _err(f"roko: `hermes roko projects {action}` needs the project's folder")
            return EXIT_USAGE
        if rt.settings().remote:
            _err(
                "roko: the plugin uses one roko serve elsewhere (its url setting or ROKO_URL), so it keeps "
                "no projects"
            )
            return EXIT_USAGE
        folder = str(Path(str(path)).expanduser().resolve()) if not rt.projects.find(str(path)) else str(path)
        try:
            if action == "add":
                added = rt.projects.add(folder)
                print(f"added {rt.projects.name(added)}: {added}")
            elif action == "remove":
                removed = rt.projects.remove(folder)
                print(f"removed {removed} (its roko serve keeps running until it stops by itself)")
            else:
                chosen = rt.projects.set_default(folder)
                print(f"the default project is {rt.projects.name(chosen)}: {chosen}")
        except RokoError as exc:
            _err(exc.one_line())
            return EXIT_USAGE if exc.code is Code.INVALID else EXIT_FAIL
    rows = views.project_rows(rt)
    if getattr(args, "roko_json", False):
        default = next((row["path"] for row in rows if row["default"]), None)
        print(json.dumps({"default": default, "projects": rows}, indent=2))
        return EXIT_OK
    if action == "list":
        if not rows:
            print(
                "No projects yet: run `hermes roko init` in your project, or `hermes roko projects add PATH`"
            )
        for row in rows:
            mark = "*" if row["default"] else " "
            state = (row.get("serve") or {}).get("state") or "?"
            setup = "needs setting up" if row["needs_setup"] else "ready" if row["ready"] else "not ready"
            print(f"{mark} {row['name']}  {row['path']}  ({setup}; roko serve {state})")
    return EXIT_OK


# -- setup -------------------------------------------------------------------


def init_command(rt: Runtime, args: argparse.Namespace) -> int:
    """`hermes roko init`: make a project ready in one command (onboard.py)."""
    from .onboard import Init, Options

    options = Options(
        workdir=Path(getattr(args, "roko_workdir", None) or "."),
        yes=bool(getattr(args, "roko_yes", False)),
        dry_run=bool(getattr(args, "roko_dry_run", False)),
        port=getattr(args, "roko_port", None),
        serve=not getattr(args, "roko_no_serve", False),
        launchd=bool(getattr(args, "roko_launchd", False)),
    )
    return Init(rt, options, confirm=_confirm).run()


def setup(rt: Runtime, args: argparse.Namespace) -> int:
    code = _connect(rt, args)
    if code != EXIT_OK or getattr(args, "roko_dry_run", False):
        return code
    print()
    report = run_doctor(rt)
    print(render.doctor(report))
    fixable = [
        problem
        for problem in report.problems
        if isinstance(problem.get("fix"), dict) and problem["fix"].get("kind") == "action"
    ]
    changed = False
    for problem in fixable:
        print()
        print(f"Fix: {problem['title']}")
        try:
            _, done = _offer_fix(
                rt, str(problem["fix"]["action"]), None, yes=bool(getattr(args, "roko_yes", False))
            )
        except RokoError as exc:
            _err(exc.one_line())
            continue
        changed = changed or done
    if changed:
        print()
        report = run_doctor(rt)
        print(render.doctor(report))
    print()
    print("Next: start a new Hermes session (restart a running gateway) and ask it to use roko,")
    print('e.g. "Use roko to add a unit test for the parser, max $1".')
    return report.exit_code()


def _connect(rt: Runtime, args: argparse.Namespace) -> int:
    """Find roko serve, check it, get a key when it has auth on, and save where it is. EXIT_OK when
    Hermes is connected (or, with --dry-run, could be)."""
    current = rt.settings()
    workdir = current.workdir
    if getattr(args, "roko_workdir", None):
        workdir = Path(args.roko_workdir).expanduser().resolve()
        if not workdir.is_dir():
            _err(f"roko: --workdir {workdir} is not a directory")
            return EXIT_USAGE
    endpoint = read_serve_endpoint(workdir) if workdir else None
    url = _pick_url(args, current, endpoint)
    if not url:
        where = f"for {workdir}" if workdir else "anywhere Hermes knows"
        start = (
            f"hermes roko serve start --project {shlex.quote(str(workdir))}"
            if workdir
            else "hermes roko init"
        )
        _err(f"roko: no roko serve runs {where}: start it with `{start}`, or pass --url")
        return EXIT_UNREACHABLE
    target = replace(current, url=url, url_source="setup", workdir=workdir, remote=not is_loopback_url(url))
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
    if target.workdir is None and not target.remote:
        # 0.7.0 saves no URL on this machine: the project's serve.json says where its serve listens.
        found = _serve_workdir(target, health)
        if found is None:
            _err(
                f"roko: roko serve at {target.display_url} does not say which project it runs in, and Hermes "
                "keeps a project rather than an address on this machine: pass --workdir PROJECT"
            )
            return EXIT_ACTION
        print(f"  project: {found}")
        target = replace(target, workdir=found)
    # Only when setup uses serve.json's own address (a URL `_pick_url` ignored names some other serve).
    named = endpoint.get("url") if endpoint else None
    if (
        workdir
        and endpoint
        and not getattr(args, "roko_url", None)
        and isinstance(named, str)
        and url == named.rstrip("/")
    ):
        other = _other_serve(target, current.credential(), endpoint, workdir)
        if other is not None:
            # serve.json outlived the roko serve that wrote it, and another one answers at its address:
            # saving it would send this workspace's runs to another project.
            init = f"hermes roko init --workdir {shlex.quote(str(workdir))}"
            _err(
                f"roko: {target.display_url} answers, but it is the roko serve of {other}, not of {workdir}: "
                f"{workdir}/.roko/runtime/serve.json is left over from a roko serve that stopped. Start roko "
                f"serve in {workdir} (`{init}` starts one on a free port), then run setup again. Nothing was "
                "saved."
            )
            return EXIT_UNREACHABLE

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
            if code == EXIT_OK:  # --dry-run, where it would mint a key
                print("\n--dry-run: nothing was saved.")
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
    return EXIT_OK


def _other_serve(
    target: Settings, credential: Credential, endpoint: dict[str, Any], workdir: Path
) -> str | None:
    """The workspace of the roko serve at serve.json's address when it is not `workdir`'s own, else None.

    roko's `/api/doctor` names its workspace; when it does not answer (auth on and no key yet, or an older
    roko), the serve must have started when serve.json says (onboard._same_serve), else it is "another
    project's".
    """
    from .onboard import _same_serve

    client = RokoClient(target, credential=credential)
    try:
        report = client.get("/api/doctor")
    except RokoError:
        report = None
    finally:
        client.close()
    named = report.get("workdir") if isinstance(report, dict) else None
    if isinstance(named, str) and named:
        try:
            same = Path(named).resolve() == workdir.resolve()
        except OSError:
            same = named == str(workdir)
        return None if same else clean(named, 300, one_line=True)
    return None if _same_serve(endpoint, target.url) else "another project"


def _serve_workdir(target: Settings, health: dict[str, Any]) -> Path | None:
    """The project the roko serve at `target` runs in, as it says (`/health` on a loopback bind since roko's
    0.7.0 identity fields, else `/api/doctor`), or None."""
    named = health.get("workdir")
    if not isinstance(named, str) or not named:
        client = RokoClient(target, credential=Credential(None, "none"))
        try:
            report = client.get("/api/doctor")
        except RokoError:
            report = None
        finally:
            client.close()
        named = report.get("workdir") if isinstance(report, dict) else None
    if not isinstance(named, str) or not named.startswith("/"):
        return None
    path = Path(named)
    return path if path.is_dir() else None


def _pick_url(args: argparse.Namespace, current: Settings, endpoint: dict[str, Any] | None) -> str:
    if getattr(args, "roko_url", None):
        return str(args.roko_url).strip().rstrip("/")
    if endpoint and isinstance(endpoint.get("url"), str):
        url = str(endpoint["url"]).rstrip("/")
        # serve.json is a file in the workspace: as settings._resolve_url does, take only a loopback URL from
        # it, so nothing that can write the workspace points Hermes' key, and every later request, elsewhere.
        if is_loopback_url(url):
            return url
        print(
            f"  ! ignored the URL in serve.json ({display_url(url)}): it is not on this machine; pass --url"
        )
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
        workdir = shlex.quote(str(target.workdir)) if target.workdir else "WORKSPACE"
        _err(
            "roko: Hermes needs an API key for this roko serve. Either\n"
            f"  hermes roko setup --workdir {workdir} --mint    "
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
    name = str(args.roko_key_name)
    if getattr(args, "roko_dry_run", False):
        # Minting, or rotating a key of that name, changes roko's keys: a dry run only says it would.
        print(f"  key: would mint a write-scoped key '{name}' (or rotate the one of that name)")
        return None, None, False, EXIT_OK
    token = token_path.read_text(encoding="utf-8").strip()
    admin = RokoClient(target, credential=Credential(token, f"launch-token:{token_path}"))
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
        # A Hermes started before now read the old key into its environment (the .env's, or one exported).
        before = {_hermes.saved_secret(current.api_key_env), os.environ.get(current.api_key_env)}
        path = _hermes.save_env_value(current.api_key_env, key)
        if not _env_file_has(path, current.api_key_env, key):
            # Hermes declines to save on a managed install, and says so only on stderr.
            raise RokoError(
                Code.CONFIG,
                f"Hermes did not save {current.api_key_env} to {path}",
                hint=f"set {current.api_key_env} in the environment Hermes runs with, then rerun setup",
            )
        print(f"  saved {current.api_key_env} to {path}")
        if any(old and old != key for old in before):
            print("  key: a Hermes started before now holds the old key; the roko page uses the saved one")
            print(
                "    (if it still says the key is refused, that Hermes runs an older plugin: quit it with ⌘Q"
            )
            print("    and open it again)")
    # 0.7.0: a URL on this machine is never saved (the project's serve.json says where its serve listens,
    # and it changes when the serve restarts); one on another machine is the remote pin.
    if target.remote and (target.url != current.url or current.url_source != "settings"):
        rt.set_config("url", target.url)
        print(f"  saved plugins.entries.roko.settings.url = {target.display_url}")
    if target.workdir and not same_path(target.workdir, current.workdir_setting):
        rt.set_config("workdir", str(target.workdir))
        print(f"  saved plugins.entries.roko.settings.workdir = {target.workdir} (the default project)")
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

"""0.7.0's fixes for a project's roko serve, in the setup card's preview, then apply (`/setup/fix`).

- `setup-project` sets roko up in a git checkout: `roko init` (roko.toml and `.roko/`), then the change that
  lets roko accept runs started from Hermes (roko's own `config preset chat-host`, or the plugin's
  `workspace-chat-ready` fix on an older roko), then its roko serve. It never commits anything. A tool runs
  the same steps once the person approved them.
- `start-serve` and `restart-serve` start or restart the project's roko serve (serve.py), as `POST /serve`.
"""

from __future__ import annotations

import hashlib
import json
import logging
import subprocess
from pathlib import Path
from typing import Any

from . import readiness
from . import serve as serving
from .errors import Code, RokoError
from .projects import check_folder
from .runtime import Runtime
from .sanitize import clean
from .workspace import _git

logger = logging.getLogger(__name__)

ACTIONS = (readiness.SETUP_PROJECT, readiness.START_SERVE, readiness.RESTART_SERVE)
INIT_TIMEOUT_S = 120.0
PRESET_TIMEOUT_S = 60.0
# The refusals that stop runs from Hermes in a project roko is set up in.
BLOCKING = {readiness.REFUSES_CHAT_RUNS, readiness.NO_TOOL_LOOP_MODEL, readiness.NO_PRICE}


def preview(rt: Runtime, action: str) -> dict[str, Any]:
    """What a fix would do for the runtime's project, for the person to read first. Changes nothing."""
    project = _project(rt)
    name = rt.projects.name(project)
    if action == readiness.SETUP_PROJECT:
        toml = project / "roko.toml"
        first = (
            "roko.toml is there already, so `roko init` is not run again. "
            if toml.is_file()
            else f"Runs `roko init` in {project}: it writes roko.toml (the project's checks and its model "
            "ladder) and roko's `.roko/` folder. "
        )
        return {
            "action": action,
            "title": f"Set up roko in {name}",
            "variant": None,
            "variants": [],
            "preview": "",
            "path": str(project),
            "summary": first
            + "Then it lets roko accept runs started from Hermes there (roko's own `config preset "
            "chat-host`, or [serve.mcp] allow_without_data_llm = true on an older roko), and starts the "
            "project's roko serve.",
            "digest": digest(project),
            "note": "Nothing is committed: commit roko.toml yourself when you are happy with it.",
        }
    if action == readiness.START_SERVE:
        settings = rt.settings()
        idle = (
            f"stops itself after {settings.idle_exit_minutes} minutes without work"
            if settings.idle_exit_minutes
            else "runs until it is stopped"
        )
        return {
            "action": action,
            "title": f"Start roko serve for {name}",
            "variant": None,
            "variants": [],
            "preview": "",
            "path": str(project),
            "summary": f"Starts roko serve for {name} in the background (`roko serve --detach`) on a port of "
            f"its own. It keeps running after Hermes quits, so runs finish, and {idle}.",
            "digest": None,
            "note": None,
        }
    if action == readiness.RESTART_SERVE:
        state = serving.serve_state(rt, project)
        found = serving.find_roko(rt)
        built = (
            f" with the roko at {found.path} ({found.version or '?'}, git {found.git_sha or '?'})"
            if found is not None and found.path
            else ""
        )
        busy = (state.busy or {}).get("active_runs") if state is not None else None
        return {
            "action": action,
            "title": f"Restart roko serve for {name}",
            "variant": None,
            "variants": [],
            "preview": "",
            "path": str(project),
            "summary": f"Stops roko serve for {name} and starts it again{built}, with the arguments it "
            "started with: it reads roko.toml and ~/.roko/.env again.",
            "digest": None,
            "note": f"{busy} run{'s are' if busy != 1 else ' is'} going in {name}: restarting stops "
            f"{'them' if busy != 1 else 'it'} (their work so far is kept)."
            if busy
            else None,
        }
    raise RokoError(Code.INVALID, f"there is no fix called {action!r}")


def apply(rt: Runtime, action: str, digest_seen: str | None = None, *, force: bool = False) -> dict[str, Any]:
    """Make the fix the person read (`preview`), for the runtime's project."""
    project = _project(rt)
    if action == readiness.SETUP_PROJECT:
        if digest_seen and digest_seen != digest(project):
            raise RokoError(
                Code.CONFLICT,
                f"{project} changed since the preview",
                hint="look at the preview again, then apply it",
            )
        return {"action": action, **setup_project(rt, project)}
    if action == readiness.START_SERVE:
        state = serving.ensure_serve(rt, project, wait=False, reason="manual")
        return _serve_answer(action, project, state)
    if action == readiness.RESTART_SERVE:
        state = serving.restart_serve(rt, project, force=force)
        return _serve_answer(action, project, state)
    raise RokoError(Code.INVALID, f"there is no fix called {action!r}")


def setup_project(rt: Runtime, project: Path) -> dict[str, Any]:
    """Set roko up in `project` and start its roko serve (module docstring). Answers `{done, ready, path,
    message, next, serve}`; raises for what stops it (not a git checkout, no roko, roko init failing)."""
    project = check_folder(str(project))
    if not _git(project, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"):
        raise RokoError(
            Code.INVALID,
            f"{project} has no commit yet, and roko's runs branch from one",
            hint=f"commit what you have first: git -C '{project}' add -A && git -C '{project}' commit -m "
            "'first commit'",
        )
    found = serving.find_roko(rt)
    if found is None or found.path is None or found.problem == "not_found":
        raise RokoError(
            Code.CONFIG,
            "roko is not installed on this machine",
            hint=f"install roko: in a clone of roko's repository, `{serving.INSTALL_COMMAND}`",
        )
    done = False
    steps: list[str] = []
    toml = project / "roko.toml"
    if not toml.is_file():
        proc = _roko(found.path, ["init"], project, INIT_TIMEOUT_S)
        if proc.returncode != 0 or not toml.is_file():
            said = [clean(line, 200, one_line=True) for line in (proc.stdout + proc.stderr).splitlines()]
            raise RokoError(
                Code.REFUSED,
                f"`roko init` did not write roko.toml in {project} (exit code {proc.returncode})"
                + (f": {said[-1]}" if said else ""),
                hint=f"run `roko init` in {project} to see why",
            )
        done = True
        steps.append("roko init wrote roko.toml")
    preset = _preset(found.path, project)
    if preset is not None and preset.get("written"):
        done = True
        steps.append("roko's chat-host preset changed roko.toml")
    view = rt.scoped(project)
    rt.projects.touch(project)
    state = serving.ensure_serve(rt, project, wait=True, reason="manual")
    left: list[str] = []
    if state is None or state.state != "running":
        why = (state.error or {}).get("message") if state is not None else None
        left.append(f"start roko serve: {why or serving.describe(state)}")
    elif preset is None:
        # An older roko has no preset: the plugin's own fix, which asks roko serve whether it took.
        try:
            fixed = readiness.apply_fix(view, readiness.CHAT_READY, readiness.LOCAL)
        except RokoError as exc:
            left.append(f"let roko accept runs started from Hermes: {exc.message}")
        else:
            done = done or bool(fixed.get("done"))
            if fixed.get("done"):
                steps.append("the plugin's fix changed roko.toml")
    readiness.invalidate(view)
    found_problems = readiness.problems(view) if state is not None and state.state == "running" else []
    blocking = [item for item in found_problems if item.get("id") in BLOCKING]
    for item in blocking:
        left.append(f"{clean(item.get('title'), 200, one_line=True)} ({_how(item)})")
    ready = state is not None and state.state == "running" and not blocking
    did = "; ".join(steps) if steps else "roko was set up already"
    message = f"{did}. " + (
        f"roko accepts runs started from Hermes in {rt.projects.name(project)} now."
        if ready
        else "Something is left before runs started from Hermes work there."
    )
    return {
        "done": done,
        "ready": ready,
        "path": str(project),
        "message": message,
        "next": "; then ".join(left) or None,
        "serve": state.as_dict() if state is not None else None,
    }


def digest(project: Path) -> str:
    """What the setup preview saw: whether roko.toml was there, and its text."""
    try:
        text = (project / "roko.toml").read_text(encoding="utf-8")
    except OSError:
        text = "\0absent"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _project(rt: Runtime) -> Path:
    settings = rt.settings()
    if settings.remote:
        raise RokoError(
            Code.FORBIDDEN,
            f"{settings.where} is not on this machine, so Hermes cannot set it up or start it",
            hint="manage that roko serve where it runs",
        )
    if settings.workdir is None:
        raise RokoError(Code.INVALID, "name the project (project)", hint="pick a project on the roko page")
    return settings.workdir


def _serve_answer(action: str, project: Path, state: serving.ServeState | None) -> dict[str, Any]:
    serve = state.as_dict() if state is not None else None
    running = state is not None and state.state == "running"
    return {
        "action": action,
        "done": state is not None and state.state in ("starting", "running"),
        "ready": running,
        "path": str(project),
        "message": serving.describe(state) + ".",
        "next": None,
        "serve": serve,
    }


def _roko(roko: str, args: list[str], project: Path, timeout: float) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            [roko, *args],
            cwd=project,
            env=serving._roko_env(),
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return subprocess.CompletedProcess([roko, *args], 1, "", str(exc))


def _preset(roko: str, project: Path) -> dict[str, Any] | None:
    """roko's `config preset chat-host --allow-without-data-llm --yes` (roko since 2026-10-15); None when
    this roko lacks it or it refused (the plugin's own fix follows then)."""
    proc = _roko(
        roko,
        [
            "config",
            "preset",
            "chat-host",
            "--workdir",
            str(project),
            "--allow-without-data-llm",
            "--json",
            "--yes",
        ],
        project,
        PRESET_TIMEOUT_S,
    )
    if proc.returncode != 0:
        return None
    try:
        answer = json.loads(proc.stdout)
    except ValueError:
        return None
    return answer if isinstance(answer, dict) and answer.get("preset") == "chat-host" else None


def _how(item: dict[str, Any]) -> str:
    held = item.get("fix")
    remedy: dict[str, Any] = held if isinstance(held, dict) else {}
    if remedy.get("command"):
        return f"`{remedy['command']}`"
    if remedy.get("docs"):
        return f"docs/{remedy['docs']}"
    return "see the setup card"

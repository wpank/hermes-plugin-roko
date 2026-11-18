"""`hermes roko init`: make a project ready for work started from Hermes, in one command.

Each step looks first and changes only what is missing, so running it again changes nothing that is
already right. A step that would change something says what, then asks; `--yes` answers for the
person, and without a terminal nothing changes and the summary says how to run it. `--dry-run` only
looks. The steps:

1. the project is a git checkout with a commit (roko's runs work on branches of it);
2. roko is installed, recent enough to start roko serve in the background (serve.find_roko);
3. roko has the key of a model it calls over an API (`~/.roko/.env`), or takes one Hermes has;
4. the project has a `roko.toml` (`roko init` writes it);
5. roko serve runs for the project: started the one way the plugin starts it (serve.ensure_serve), or as a
   login item with `--launchd`;
6. Hermes is connected to it: the project is Hermes' default project, and the project's launch token (or a
   key, when roko serve writes none) works;
7. roko accepts runs started from Hermes (roko's own `config preset chat-host` when this roko has
   it, else the plugin's fix), and has an API model for them;
8. `roko.toml` is committed when git tracks it, so the roko page's Merge is not blocked;
9. the hello-world demo is among the project's plans;
10. what is left is said: the desktop app's switch, and what to try first.
"""

from __future__ import annotations

import argparse
import contextlib
import copy
import json
import os
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from . import _hermes, readiness, render
from . import serve as serving
from .runtime import Runtime
from .sanitize import clean
from .serve import PROCESS_ENV, ROKO_KEYS, _env_names, _roko_env, _same_serve
from .settings import same_path
from .workspace import _git, _git_ok

# Moved to serve.py in 0.7.0, where every way of running roko shares them; still importable from here.
__all__ = ["PROCESS_ENV", "ROKO_KEYS", "_env_names", "_roko_env", "_same_serve"]

DEFAULT_PORT = 6677
SETTLE_S = 8.0  # how long a step waits for roko serve to read a roko.toml change (its watcher: every 2 s)
DEMO_TITLE = "# Start here: hello world demo"
DEMO_DIR = Path(__file__).resolve().parent / "demos" / "demo-hello-world"
COMMIT_MESSAGE = "roko: accept runs started from Hermes"
# The ladder rung `add_priced_rung` adds for runs with a spending cap.
PRICED_RUNG = "priced"
# What "Turn on roko's learning" writes into roko.toml (learning-research, round v6, section 2). It changes
# two of roko's defaults:
# - the checks' learned thresholds are saved, and published, after every verify run instead of every 10th,
#   so they move where the person can see them;
# - `domain_context`, the prompt section that carries lessons, playbooks and episodes, is pinned. The
#   section bandit never leaves it out then; early on it did on about 1 chain in 5, which hid a lesson from
#   a whole task.
# Three defaults are written out where roko.toml lacks them, so that turning learning on never turns on what
# is not ready: the self-model only forecasts, the guard only observes, and the control arms that measure
# each loop stay. Dreams, the daimon, M1 and M4 stay off: a dream pushed a real lesson out of a prompt
# (bug-7e0556).
LEARNING_CHANGES = (("learning", "gate_threshold_flush_interval", 1),)
LEARNING_PINNED = "domain_context"
LEARNING_DEFAULTS = (
    ("self_model", "mode", "shadow"),
    ("learning", "guarded_commit", "observe"),
    ("experiments", "maximize", False),
)

# An API model to name in roko.toml when roko has none for runs started from Hermes (a `roko init`
# older than 2026-10-15 writes a ladder whose only runnable rung is the Claude CLI): per key, the
# provider and the model, as a newer `roko init` writes them (roko's 2026-09-28 price snapshot; the
# prices let roko hold a run to its cap).
API_MODELS: dict[str, tuple[str, dict[str, str], str, dict[str, Any]]] = {
    "OPENAI_API_KEY": (
        "openai",
        {"kind": "openai_compat", "base_url": "https://api.openai.com/v1", "api_key_env": "OPENAI_API_KEY"},
        "gpt-5-4-mini",
        {
            "slug": "gpt-5.4-mini",
            "context_window": 200000,
            "max_output": 16384,
            "tool_format": "openai_json",
            "cost_input_per_m": 0.75,
            "cost_output_per_m": 4.5,
            "cost_cache_read_per_m": 0.075,
        },
    ),
    "ANTHROPIC_API_KEY": (
        "anthropic",
        {
            "kind": "anthropic_api",
            "base_url": "https://api.anthropic.com",
            "api_key_env": "ANTHROPIC_API_KEY",
        },
        "claude-haiku-4-5",
        {
            "slug": "claude-haiku-4-5",
            "context_window": 200000,
            "tool_format": "anthropic_blocks",
            "max_tools": 32,
        },
    ),
    "OPENROUTER_API_KEY": (
        "openrouter",
        {
            "kind": "openai_compat",
            "base_url": "https://openrouter.ai/api/v1",
            "api_key_env": "OPENROUTER_API_KEY",
        },
        "gpt-5-4-mini-openrouter",
        {
            "slug": "openai/gpt-5.4-mini",
            "context_window": 200000,
            "max_output": 16384,
            "tool_format": "openai_json",
            "cost_input_per_m": 0.75,
            "cost_output_per_m": 4.5,
        },
    ),
}

OK, DONE, TODO, BLOCKED, NOTE = "ok", "done", "todo", "blocked", "note"
MARKS = {OK: "✓", DONE: "✓", TODO: "→", BLOCKED: "✗", NOTE: "·"}


@dataclass
class Options:
    workdir: Path
    yes: bool = False
    dry_run: bool = False
    port: int | None = None  # the port for a roko serve it starts (default: roko picks one)
    serve: bool = True  # start roko serve when it does not run
    launchd: bool = False  # write a login item for roko serve instead (macOS)


@dataclass
class Init:
    """One run of `hermes roko init`; `run()` returns the exit code."""

    rt: Runtime
    options: Options
    out: Callable[[str], None] = print
    confirm: Callable[[str], bool] = lambda question: False
    run_command: Callable[..., subprocess.CompletedProcess[str]] = subprocess.run
    workdir: Path = field(init=False)
    roko: str | None = None
    url: str | None = None
    key_added: bool = False
    serve_started_here: bool = False
    left: list[str] = field(default_factory=list)  # what the person still has to do
    added: list[str] = field(default_factory=list)  # changes to routing to name again at the end
    backup: Path | None = None  # the copy of roko.toml from before this run's first change to it
    stopped: bool = False  # a step could not be done, and the ones after it need it
    asked_nothing: bool = False  # a change waited for an answer no one could give

    def __post_init__(self) -> None:
        self.workdir = self.options.workdir.expanduser().resolve()
        # The runtime about this project (its roko serve, its readiness), whatever the default project is.
        self.view = self.rt.scoped(self.workdir)

    # -- the run -----------------------------------------------------------------------------

    def run(self) -> int:
        mode = " (dry run: nothing changes)" if self.options.dry_run else ""
        self.out(f"roko for Hermes: making {self.workdir} ready{mode}")
        self.out("")
        for step in (self.project, self.roko_command, self.roko_home, self.model_key, self.roko_toml):
            step()
            if self.stopped:
                return self.finish()
        self.serve()
        if self.url is None:
            return self.finish()
        if not self.connect():
            return self.finish()
        self.chat_runs()
        self.models()
        self.learning()
        self.commit()
        self.demo()
        self.desktop()
        return self.finish(check=True)

    def finish(self, check: bool = False) -> int:
        ready = False
        if check:
            readiness.invalidate(self.view)
            view = readiness.setup_view(self.view)
            ready = bool(view["ok"])
            self.out("")
            self.out(render.setup_problems(view["problems"]))
        if self.added:
            self.out("")
            self.out("Added to roko.toml:")
            for item in self.added:
                self.out(f"  - {item}")
        if self.left:
            self.out("")
            self.out("Left for you:")
            for item in dict.fromkeys(self.left):
                self.out(f"  - {item}")
        if self.asked_nothing:
            self.out("")
            self.out(
                "Nothing was changed where a question had no answer: run `hermes roko init --yes` to make "
                "those changes, or answer the questions in a terminal."
            )
        if ready and not self.stopped:
            self.out("")
            if _find_demo(self.workdir) is not None:
                self.out(
                    "Next: open the roko page ▸ Plans ▸ Start here: hello world demo ▸ Run plan ($0.25 is"
                )
                self.out(
                    'plenty), or ask in a Hermes chat: "Use roko to run the demo-hello-world plan. Cap it'
                )
                self.out('at $0.25." Leave its output on its branch; it is a demo.')
            else:
                self.out('Next: ask in a Hermes chat for something small: "Use roko to … Cap it at $0.50."')
        if self.options.dry_run:
            return 0
        return 0 if ready and not self.stopped else 3

    def say(self, status: str, name: str, text: str, *more: str) -> None:
        self.out(f"{MARKS[status]} {name}: {text}")
        for line in more:
            self.out(f"    {line}")

    def ask(self, question: str) -> bool:
        if self.options.dry_run:
            return False
        if self.options.yes:
            return True
        if not sys.stdin.isatty():
            self.asked_nothing = True
            return False
        return self.confirm(question)

    def _rewrite(self, path: Path, text: str) -> None:
        """roko.toml replaced with `text`. Its first change in this run keeps a copy of the file as it was."""
        backup = _replace_file(path, text, backup=self.backup is None)
        self.backup = self.backup or backup
        self.out(f"    the old roko.toml is kept as {self.backup}")

    def stop(self, name: str, text: str, *more: str) -> None:
        self.say(BLOCKED, name, text, *more)
        self.stopped = True

    # -- 1. the project ------------------------------------------------------------------------

    def project(self) -> None:
        ws = self.workdir
        if not ws.is_dir():
            return self.stop("project", f"{ws} is not a folder")
        if _git(ws, "rev-parse", "--is-inside-work-tree") != "true":
            return self.stop(
                "project",
                f"{ws} is not a git checkout, and roko's runs work on branches of one.",
                f"git -C {_arg(ws)} init && git -C {_arg(ws)} add -A && "
                f"git -C {_arg(ws)} commit -m 'first commit'",
            )
        if not _git(ws, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"):
            return self.stop(
                "project",
                f"{ws} has no commit yet, and roko branches from one. Commit what you have first:",
                f"git -C {_arg(ws)} add -A && git -C {_arg(ws)} commit -m 'first commit'",
            )
        branch = _git(ws, "symbolic-ref", "--quiet", "--short", "HEAD")
        self.say(OK, "project", f"git checkout on {branch}" if branch else "git checkout (detached HEAD)")
        return None

    # -- 2. roko ----------------------------------------------------------------------------------

    def roko_command(self) -> None:
        found = serving.find_roko(self.rt, self.view.settings())
        if found is None or found.path is None or found.problem == "not_found":
            named = f"{found.path} does not run, and " if found is not None and found.path else ""
            return self.stop(
                "roko",
                f"{named}roko is not installed. Build it in a clone of roko's repository (Rust 1.91 or "
                "later):",
                serving.INSTALL_COMMAND,
            )
        if found.problem == "too_old":
            return self.stop(
                "roko",
                f"the roko at {found.path} is from before `roko serve --detach`, so Hermes cannot start roko "
                "serve with it. Update it in your roko clone:",
                f"git pull && {serving.INSTALL_COMMAND}",
            )
        self.roko = found.path
        built = f" (git {found.git_sha})" if found.git_sha else ""
        self.say(OK, "roko", f"roko {found.version or '?'}{built} at {found.path}")
        return None

    # -- 3. roko's home and its key ------------------------------------------------------------

    def roko_home(self) -> None:
        home = Path.home() / ".roko"
        if home.is_dir():
            self.say(OK, "roko home", "~/.roko exists")
            return
        if self.options.dry_run:
            self.say(TODO, "roko home", "would create ~/.roko, where roko keeps its keys")
            return
        home.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.say(DONE, "roko home", "created ~/.roko, where roko keeps its keys")

    def model_key(self) -> None:
        path = Path.home() / ".roko" / ".env"
        have = [name for name in ROKO_KEYS if name in _env_names(path)]
        if have:
            self.say(OK, "model key", f"roko has a key for {_providers(have)} in ~/.roko/.env")
            return
        offer = [name for name in ROKO_KEYS if _hermes.get_secret(name)]
        if not offer:
            self.say(
                TODO,
                "model key",
                "roko has no key for a model it calls itself, and Hermes has none roko can use.",
                "A run started from Hermes needs one. Make roko's key file, which only you can read:",
                "mkdir -p ~/.roko && touch ~/.roko/.env && chmod 600 ~/.roko/.env",
                "then add a line OPENAI_API_KEY=… to it with your editor (or "
                f"{', '.join(name for name in ROKO_KEYS if name != 'OPENAI_API_KEY')}), and run this again",
            )
            self.left.append("add a model key to ~/.roko/.env, then run `hermes roko init` again")
            return
        names = ", ".join(offer)
        question = f"  Copy {names} from Hermes to ~/.roko/.env, so roko can call {_providers(offer)}? [y/N] "
        if not self.ask(question):
            verb = "would copy" if self.options.dry_run else "did not copy"
            self.say(TODO, "model key", f"roko has no model key in ~/.roko/.env; {verb} {names} from Hermes")
            if not self.options.dry_run:
                self.left.append("give roko a model key: `hermes roko init` offers the one Hermes has")
            return
        _append_env(path, {name: _hermes.get_secret(name) or "" for name in offer})
        self.key_added = True
        self.say(DONE, "model key", f"copied {names} to ~/.roko/.env (only you can read it)")

    # -- 4. roko.toml -----------------------------------------------------------------------------

    def roko_toml(self) -> None:
        path = self.workdir / "roko.toml"
        if path.is_file():
            self.say(OK, "roko.toml", "the project has one")
            return
        if not self.ask("  Run `roko init` here to write roko.toml? [y/N] "):
            if self.options.dry_run:
                self.say(
                    TODO, "roko.toml", "the project has none; would run `roko init` (the rest waits for it)"
                )
                self.stopped = True
                return
            self.stop("roko.toml", f"the project has none; run `roko init` in {self.workdir}")
            self.left.append(f"run `roko init` in {self.workdir}, or `hermes roko init` again")
            return
        proc = self._roko(["init"], timeout=120)
        lines = [clean(line, 200) for line in (proc.stdout + proc.stderr).splitlines() if line.strip()]
        if proc.returncode != 0 or not path.is_file():
            return self.stop(
                "roko.toml", f"`roko init` did not write it (exit code {proc.returncode})", *lines[-8:]
            )
        self.say(DONE, "roko.toml", "`roko init` wrote it", *lines[:20])

    # -- 5. roko serve ----------------------------------------------------------------------------

    def serve(self) -> None:
        state = serving.serve_state(self.rt, self.workdir)
        if state is not None and state.state in ("running", "outdated") and state.url:
            self.url = state.url
            pid = f" (pid {state.pid})" if state.pid else ""
            self.say(OK, "roko serve", f"runs for this project at {self.url}{pid}")
            if state.state == "outdated":
                self.say(NOTE, "roko serve", (state.error or {}).get("message") or "it is older than roko")
                self.left.append(f"restart roko serve from a newer roko: {self._serve_command('restart')}")
            if self.key_added:
                self.left.append(
                    "restart roko serve so it reads the key just added to ~/.roko/.env (it reads keys only "
                    f"when it starts): {self._serve_command('restart')}"
                )
            return
        port = self.options.port or DEFAULT_PORT
        if self.options.launchd:
            self.launchd(port)
            return
        command = self._serve_command("start")
        if not self.options.serve:
            self.say(TODO, "roko serve", "does not run for this project. Start it with:", command)
            self.left.append(f"start roko serve (`{command}`), then run `hermes roko init` again")
            return
        if not self.ask("  Start roko serve for this project in the background? [y/N] "):
            verb = "would start" if self.options.dry_run else "start it yourself"
            self.say(TODO, "roko serve", f"does not run for this project; {verb}:", command)
            if not self.options.dry_run:
                self.left.append(f"start roko serve (`{command}`), then run `hermes roko init` again")
            return
        started = serving.ensure_serve(
            self.rt, self.workdir, wait=True, reason="manual", port=self.options.port
        )
        if started is None or started.state != "running" or not started.url:
            error = (started.error if started is not None else None) or {}
            why = error.get("message") or (serving.describe(started) if started is not None else "no project")
            tail = (started.log_tail if started is not None else None) or []
            log = self.workdir / ".roko" / "logs" / "serve.log"
            self.stop("roko serve", f"did not start: {why}; its log, {log}, ends:", *tail[-6:])
            return
        self.url = started.url
        self.serve_started_here = True
        idle = (
            f"it stops by itself after {started.idle_exit_minutes} minutes without work, and Hermes starts "
            "it again when it needs it"
            if started.idle_exit_minutes
            else "it runs until you stop it"
        )
        self.say(
            DONE,
            "roko serve",
            f"started at {self.url} (pid {started.pid}), in the background",
            f"log: {self.workdir / '.roko' / 'logs' / 'serve.log'}",
            f"{idle}; stop it with: {self._serve_command('stop')}",
        )

    def _serve_command(self, verb: str) -> str:
        return f"hermes roko serve {verb} --project {_arg(self.workdir)}"

    def launchd(self, port: int) -> None:
        """Write a login item for roko serve (macOS) and say how to load it; loading stays the person's."""
        assert self.roko is not None
        if sys.platform != "darwin":
            command = f"roko serve --workdir {_arg(self.workdir)} --port {port}"
            self.say(
                TODO,
                "roko serve",
                "login items are macOS's (launchd); start roko serve another way:",
                command,
            )
            self.left.append(f"start roko serve (`{command}`), then run `hermes roko init` again")
            return
        label = f"dev.roko.serve.{_slug(self.workdir)}"
        path = Path.home() / "Library" / "LaunchAgents" / f"{label}.plist"
        log = self.workdir / ".roko" / "logs" / "roko-serve.log"
        plist = {
            "Label": label,
            "ProgramArguments": [
                str(Path(self.roko).resolve()),
                "serve",
                "--workdir",
                str(self.workdir),
                "--port",
                str(port),
            ],
            "WorkingDirectory": str(self.workdir),
            "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/bin:/bin")},
            "RunAtLoad": True,
            "KeepAlive": {"SuccessfulExit": False},
            "StandardOutPath": str(log),
            "StandardErrorPath": str(log),
        }
        uid = os.getuid()
        load = f"launchctl bootstrap gui/{uid} {_arg(path)}"
        unload = f"launchctl bootout gui/{uid} {_arg(path)}"
        if path.is_file() and plistlib.loads(path.read_bytes()) == plist:
            self.say(
                OK,
                "roko serve",
                f"its login item is {path}; load it, then run `hermes roko init` again:",
                load,
            )
            self.left.append(f"load roko serve's login item: `{load}`")
            return
        if not self.ask(f"  Write a login item that starts roko serve for this project at {path}? [y/N] "):
            verb = "would write" if self.options.dry_run else "did not write"
            self.say(TODO, "roko serve", f"{verb} the login item {path}")
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        log.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(plistlib.dumps(plist))
        self.say(
            DONE,
            "roko serve",
            f"wrote its login item {path}. Load it now (it then starts at every login), and run "
            "`hermes roko init` again:",
            load,
            f"to remove it: {unload} && rm {_arg(path)}",
        )
        self.left.append(f"load roko serve's login item: `{load}`")

    # -- 6. Hermes ↔ roko -----------------------------------------------------------------------------

    def connect(self) -> bool:
        """The project becomes Hermes' default project (the `workdir` setting), and Hermes reaches its roko
        serve: with no key when auth is off, else with the project's launch token, else with a key `hermes
        roko setup` mints."""
        from . import cli

        assert self.url is not None
        settings = self.view.settings()
        target = settings if settings.url else replace(settings, url=self.url, url_source="serve.json")
        credential = target.credential()
        try:
            auth_on = cli._auth_required(target)
        except Exception:
            auth_on = True
        if not auth_on or (credential.present and cli._key_works(target, credential.value or "")):
            if not auth_on:
                key = "no key needed: auth is off"
            elif credential.source.startswith("launch-token:"):
                key = "the project's launch token works"
            else:
                key = f"its key ({credential.source}) works"
            self._make_default()
            self.say(OK, "connected", f"Hermes uses roko serve at {target.display_url}; {key}")
            return True
        self.say(NOTE, "connect", "connecting Hermes to roko serve:")
        args = argparse.Namespace(
            roko_url=None,
            roko_workdir=str(self.workdir),
            roko_mint=True,
            roko_key_name="hermes",
            roko_key_stdin=False,
            roko_yes=self.options.yes,
            roko_dry_run=self.options.dry_run,
        )
        code = cli._connect(self.rt, args)
        if code != cli.EXIT_OK:
            self.stop("connect", "Hermes could not connect to roko serve (see above)")
            return False
        return not self.options.dry_run

    def _make_default(self) -> None:
        """Save the project as the `workdir` setting (Hermes' default project) when it is not yet."""
        if self.options.dry_run:
            return
        current = self.rt.settings().workdir_setting
        if current is not None and same_path(current, self.workdir):
            return
        self.rt.set_config("workdir", str(self.workdir))
        self.out(f"    saved plugins.entries.roko.settings.workdir = {self.workdir} (the default project)")

    # -- 7. runs from Hermes ------------------------------------------------------------------------

    def chat_runs(self) -> None:
        from . import cli

        readiness.invalidate(self.view)
        found = {item["id"]: item for item in readiness.problems(self.view)}
        problem = found.get(readiness.REFUSES_CHAT_RUNS)
        if problem is None:
            if readiness.NO_TOOL_LOOP_MODEL in found or readiness.NO_PRICE in found:
                needs = "a model" if readiness.NO_TOOL_LOOP_MODEL in found else "a model it has a price for"
                text = f"roko.toml settles the data-model boundary; roko still needs {needs} (the next step)"
            else:
                text = "roko accepts them in this workspace"
            self.say(OK, "runs from Hermes", text)
            return
        self.say(TODO, "runs from Hermes", str(problem["title"]))
        preset, refused = self._preset(dry_run=True)
        if refused:
            self.out(f"    roko's own `config preset chat-host` did not apply: {refused}")
        if preset is not None:
            self.out("    roko's own `config preset chat-host` makes this change:")
            diff = str(preset.get("diff") or "")
            for line in diff.rstrip("\n").splitlines():
                self.out(f"    {clean(line, 200)}")
            if not self.ask("  Make this change with roko's preset? [y/N] "):
                return
            done, refused = self._preset(dry_run=False)
            left = [word for word in (done or {}).get("refusals") or [] if isinstance(word, str)]
            # roko serve reads roko.toml again only every 2 s or so. When the preset says the boundary is
            # settled, wait for roko serve to stop refusing for want of it, as the plugin's own fix does, so
            # the closing check sees what the preset did.
            expected = done is not None and "no_data_boundary" not in left
            settled = expected and self._settled(readiness.REFUSES_CHAT_RUNS)
            ready = bool(done and done.get("ready")) and settled
            if ready:
                text = "roko's preset changed roko.toml, and roko accepts them now"
            elif expected and not settled:
                text = (
                    "roko's preset changed roko.toml, but roko serve has not read it yet (it re-reads the "
                    "file every 2 s); `hermes roko doctor` checks again"
                )
            elif left == ["no_tool_loop_model"]:
                text = "roko's preset changed roko.toml; roko still needs a model for them (the next step)"
            else:
                why = (done or {}).get("refusal") or refused
                text = "roko's preset changed roko.toml; roko still refuses them" + (
                    f": {clean(why, 300, one_line=True)}" if why else ""
                )
            self.say(DONE if ready else TODO, "runs from Hermes", text)
            readiness.invalidate(self.view)
            return
        try:
            cli._offer_fix(
                self.view, readiness.CHAT_READY, None, yes=self.options.yes, dry_run=self.options.dry_run
            )
        except Exception as exc:  # a RokoError says why; the summary below shows what is left
            self.say(TODO, "runs from Hermes", f"the fix did not apply: {clean(exc, 300, one_line=True)}")
        readiness.invalidate(self.view)

    def _settle_models(self) -> bool:
        """Whether roko lists an API model for runs from Hermes, once its watcher read roko.toml (2 s)."""
        return self._settled(readiness.NO_TOOL_LOOP_MODEL)

    def _settled(self, problem_id: str) -> bool:
        """Whether roko stops reporting `problem_id` within `SETTLE_S`: roko serve's watcher re-reads
        roko.toml about every 2 s, so a change written a moment ago may not show at once."""
        deadline = time.monotonic() + SETTLE_S
        while True:
            readiness.invalidate(self.view)
            if not any(item["id"] == problem_id for item in readiness.problems(self.view)):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(0.5)

    def _preset(self, *, dry_run: bool) -> tuple[dict[str, Any] | None, str | None]:
        """roko's `config preset chat-host` (roko since 2026-10-15): its answer, or (None, None) when this
        roko lacks the preset, or (None, roko's words) when the preset refused (it exits 2 then)."""
        args = [
            "config",
            "preset",
            "chat-host",
            "--workdir",
            str(self.workdir),
            "--allow-without-data-llm",
            "--json",
        ]
        args.append("--dry-run" if dry_run else "--yes")
        try:
            proc = self._roko(args, timeout=60)
        except (OSError, subprocess.SubprocessError):
            return None, None
        if proc.returncode != 0:
            said = [line for line in (proc.stderr or proc.stdout or "").splitlines() if line.strip()]
            older = re.search(
                r"unrecognized subcommand|invalid value 'chat-host'|unexpected argument", proc.stderr or ""
            )
            if older or not said:
                return None, None
            return None, clean(said[0].removeprefix("error: ").removeprefix("Error: "), 300, one_line=True)
        try:
            answer = json.loads(proc.stdout)
        except ValueError:
            return None, None
        if isinstance(answer, dict) and answer.get("preset") == "chat-host":
            return answer, None
        return None, None

    def models(self) -> None:
        facts, found = readiness.look(self.view)
        ids = {item["id"] for item in found}
        if readiness.NO_TOOL_LOOP_MODEL not in ids and readiness.NO_PRICE in ids:
            self._priced_model(found)
            return
        if readiness.NO_TOOL_LOOP_MODEL not in ids:
            usable = facts.tool_loop_models() or []
            names = ", ".join(model.name for model in usable[:4]) + (" …" if len(usable) > 4 else "")
            self.say(
                OK,
                "models",
                f"roko has API models for runs started from Hermes: {names}"
                if names
                else "roko has an API model for runs started from Hermes",
            )
            return
        keys = [name for name in API_MODELS if name in _env_names(Path.home() / ".roko" / ".env")]
        path = self.workdir / "roko.toml"
        if not keys:
            self.say(
                TODO,
                "models",
                "roko has no model it can use for runs started from Hermes, and no key for one",
            )
            self.left.append(f"give roko an API model: docs/{readiness.DOCS[readiness.NO_TOOL_LOOP_MODEL]}")
            return
        try:
            old = path.read_text(encoding="utf-8")
            new = add_api_model(old, keys[0])
        except (OSError, ValueError) as exc:
            self.say(
                TODO, "models", f"roko has no API model for runs started from Hermes; add one by hand ({exc})"
            )
            self.left.append(f"give roko an API model: docs/{readiness.DOCS[readiness.NO_TOOL_LOOP_MODEL]}")
            return
        _, _, model, fields = API_MODELS[keys[0]]
        slug = fields["slug"]
        self.say(
            TODO,
            "models",
            "roko has no model it can use for runs started from Hermes; roko.toml can name "
            f"{slug} ({ROKO_KEYS[keys[0]]}):",
        )
        for line in _diff(old, new):
            self.out(f"    {line}")
        if not self.ask(f"  Add {slug} to roko.toml and use it as the strongest model? [y/N] "):
            return
        self._rewrite(path, new)
        if self._settle_models():
            self.say(DONE, "models", f"roko.toml names {model} ({slug}), and roko can use it")
        else:
            self.say(DONE, "models", f"roko.toml names {model} ({slug}); roko does not list it yet")
        if self.key_added and not self.serve_started_here:
            self.left.append("restart roko serve so it reads the key just added to ~/.roko/.env")

    def _priced_model(self, found: list[dict[str, Any]]) -> None:
        """roko (since gap-8548e3) refuses runs from Hermes while none of their models has a price. Never
        invent one: offer a model whose real rates roko knows, on a new rung above the others, where
        capped runs climb to it and terminal runs keep their rungs (`add_priced_rung`)."""
        problem = next(item for item in found if item["id"] == readiness.NO_PRICE)
        title = str(problem["title"]).rstrip(".")
        docs = f"docs/{readiness.DOCS[readiness.NO_PRICE]}"
        keys = [name for name in API_MODELS if name in _env_names(Path.home() / ".roko" / ".env")]
        path = self.workdir / "roko.toml"
        why = "no key in ~/.roko/.env for a model this step knows the price of"
        old = new = ""
        if keys:
            try:
                old = path.read_text(encoding="utf-8")
                new = add_priced_rung(old, keys[0])
            except (OSError, ValueError) as exc:
                why = str(exc)
        if not new:
            self.say(TODO, "models", f"{title}; give one of its models its real rates ({why})")
            self.left.append(f"give one of roko's models for runs from Hermes its real rates: {docs}")
            return
        _, _, model, fields = API_MODELS[keys[0]]
        slug = fields["slug"]
        self.say(
            TODO,
            "models",
            f"{title}; roko.toml can name {slug} ({ROKO_KEYS[keys[0]]}), which roko has a price for, as the "
            "strongest model, above the others:",
        )
        for line in _diff(old, new):
            self.out(f"    {line}")
        for line in (
            "Runs with a spending cap, runs from Hermes among them, move up past the models roko has no",
            "price for to this one. Terminal runs keep the models they start on, and reach it only after",
            "failing on every model below it.",
        ):
            self.out(f"    {line}")
        if not self.ask(f"  Add {slug} as the strongest model, above the others? [y/N] "):
            return
        self._rewrite(path, new)
        if "cost_input_per_m" in fields and "cost_output_per_m" in fields:
            rates = (
                f"at ${fields['cost_input_per_m']:.2f}/${fields['cost_output_per_m']:.2f} per M tokens in/out"
            )
        else:
            rates = "at the rates in roko's own price table"
        self.added.append(
            f"{model} ({slug}) as the strongest model, {rates}; runs under a cap use it; terminal runs "
            "reach it only after every other model fails"
        )
        where = f"roko.toml names {model} ({slug}) as the strongest model"
        if self._settled(readiness.NO_PRICE):
            self.say(DONE, "models", f"{where}, and roko has a price for it")
        else:
            self.say(DONE, "models", f"{where}; roko does not count it yet")
        if self.key_added and not self.serve_started_here:
            self.left.append("restart roko serve so it reads the key just added to ~/.roko/.env")

    # -- 8. roko's learning -----------------------------------------------------------------------

    def learning(self) -> None:
        """Turn on roko's learning where it is safe (LEARNING_CHANGES), with the person's yes."""
        path = self.workdir / "roko.toml"
        try:
            old = path.read_text(encoding="utf-8")
            state = learning_state(tomllib.loads(old))
        except (OSError, tomllib.TOMLDecodeError) as exc:
            self.say(TODO, "learning", f"roko.toml could not be read ({clean(exc, 200, one_line=True)})")
            return
        if state == "on":
            self.say(OK, "learning", LEARNING_WORDS["on"])
            return
        if state == "frozen":
            self.say(NOTE, "learning", f"{LEARNING_WORDS['frozen']}; left as it is")
            return
        try:
            new = turn_on_learning(old)
        except ValueError as exc:
            self.say(TODO, "learning", f"off, and roko.toml is laid out in a way this cannot change ({exc})")
            self.left.append(f"turn on roko's learning by hand: {LEARNING_DOCS}")
            return
        if new is None:
            return
        self.say(TODO, "learning", "off. Turn on roko's learning (recommended):")
        for line in _diff(old, new):
            self.out(f"    {line}")
        for line in LEARNING_NOTE:
            self.out(f"    {line}")
        if not self.ask("  Turn on roko's learning (recommended)? [y/N] "):
            return
        self._rewrite(path, new)
        self.say(DONE, "learning", "on, from roko's next run")
        self.added.append(
            f"learning: [learning] gate_threshold_flush_interval = 1 and [sections] pinned gains "
            f'"{LEARNING_PINNED}"; dreams, the daimon and the self-model\'s control stay off'
        )

    # -- 9. commit roko.toml -----------------------------------------------------------------------

    def commit(self) -> None:
        ws = self.workdir
        if not _git_ok(ws, "ls-files", "--error-unmatch", "--", "roko.toml"):
            self.say(OK, "roko.toml in git", "git does not track it, so it never blocks a merge")
            return
        if not (_git(ws, "status", "--porcelain", "--", "roko.toml") or ""):
            self.say(OK, "roko.toml in git", "committed")
            return
        command = f'git -C {_arg(ws)} commit -m "{COMMIT_MESSAGE}" -- roko.toml'
        self.say(
            TODO,
            "roko.toml in git",
            "it has uncommitted changes, and the roko page merges a run's work only into a checkout "
            "without them",
        )
        if not self.ask("  Commit roko.toml now (only that file)? [y/N] "):
            self.left.append(f"commit roko.toml: `{command}`")
            return
        ok = _git_ok(ws, "commit", "--quiet", "-m", COMMIT_MESSAGE, "--", "roko.toml")
        if ok:
            self.say(DONE, "roko.toml in git", f'committed as "{COMMIT_MESSAGE}"')
        else:
            self.say(TODO, "roko.toml in git", "git did not commit it (is your git identity set?)", command)
            self.left.append(f"commit roko.toml: `{command}`")

    # -- 10. the demo ---------------------------------------------------------------------------------

    def demo(self) -> None:
        found = _find_demo(self.workdir)
        if found is not None:
            self.say(OK, "demo", f"the hello-world demo is in {found.relative_to(self.workdir)}")
            return
        target = self.workdir / "plans" / "demos" / DEMO_DIR.name
        if target.exists():
            # Another plan by that name, the person's: copying the demo in would replace its files.
            self.say(TODO, "demo", f"{target.relative_to(self.workdir)} holds another plan; left it as it is")
            return
        if not self.ask(f"  Add the hello-world demo plan to {target.relative_to(self.workdir)}? [y/N] "):
            verb = "would add" if self.options.dry_run else "did not add"
            self.say(TODO, "demo", f"{verb} the hello-world demo plan")
            return
        target.mkdir(parents=True, exist_ok=True)
        for source in sorted(DEMO_DIR.iterdir()):
            if source.is_file():
                shutil.copy2(source, target / source.name)
        self.say(
            DONE,
            "demo",
            f"added {target.relative_to(self.workdir)}: one task writes a shell script that prints "
            "hello world",
        )

    # -- 11. the desktop app ------------------------------------------------------------------------

    def desktop(self) -> None:
        self.say(
            NOTE,
            "desktop app",
            "turn on roko's Desktop switch in Capabilities ▸ Plugins",
            "(Settings ▸ Plugins ▸ Manage plugins leads there). If the app was open when you installed the",
            "plugin, quit it with ⌘Q and open it again first.",
        )

    # -- helpers ---------------------------------------------------------------------------------------

    def _roko(self, args: list[str], *, timeout: float) -> subprocess.CompletedProcess[str]:
        command = self.roko or os.environ.get("ROKO_BIN") or "roko"
        return self.run_command(
            [command, *args],
            cwd=self.workdir,
            env=_roko_env(),
            capture_output=True,
            text=True,
            timeout=timeout,
            stdin=subprocess.DEVNULL,
            check=False,
        )


# -- editing roko.toml: an API model for runs started from Hermes ---------------------------------------

_RUNG = re.compile(r"^\s*\[\[\s*routing\s*\.\s*ladder\s*\.\s*rungs\s*\]\]\s*(?:#.*)?$")
_KEY = re.compile(
    r"^(?P<lead>[ \t]*)(?P<key>[A-Za-z0-9_-]+)[ \t]*=[ \t]*(?P<value>[^#\r\n]*?)[ \t]*(?P<rest>#[^\r\n]*)?"
    r"(?P<eol>\r?\n?)$"
)


def add_api_model(text: str, key_env: str) -> str:
    """`text` with the provider and model `API_MODELS[key_env]` names, that model on the ladder's
    `top` rung (a new rung when there is none). Raises ValueError when the file is laid out in a way
    this cannot change safely."""
    provider_id, provider, model, fields = API_MODELS[key_env]
    data = tomllib.loads(text)
    providers = _table(data, "providers")
    models = _table(data, "models")
    blocks = [f"# Added by hermes roko init: a model roko calls over the API with {key_env}."]
    if provider_id in providers:
        if providers[provider_id].get("kind") != provider["kind"]:
            raise ValueError(f"[providers.{provider_id}] is another kind of provider")
    else:
        blocks.append(f"[providers.{provider_id}]")
        blocks.extend(f"{key} = {_toml_value(value)}" for key, value in provider.items())
        blocks.append("")
    if model not in models:
        blocks.append(f"[models.{model}]")
        blocks.append(f'provider = "{provider_id}"')
        blocks.extend(f"{key} = {_toml_value(value)}" for key, value in fields.items())
        blocks.append("")
    eol = "\r\n" if "\r\n" in text else "\n"
    base = text if not text or text.endswith(("\n", "\r")) else text + eol
    new = base + eol + eol.join(blocks).rstrip() + eol
    new = _top_rung(new, model)
    parsed = tomllib.loads(new)
    expected = copy.deepcopy(data)
    expected.setdefault("providers", {}).setdefault(provider_id, dict(provider))
    expected.setdefault("models", {}).setdefault(model, {"provider": provider_id, **fields})
    rungs = _table(_table(parsed, "routing"), "ladder").get("rungs", [])
    top = [rung for rung in rungs if isinstance(rung, dict) and rung.get("name") == "top"]
    if not top or top[-1].get("model") != model:
        raise ValueError("the model ladder is laid out in a way this cannot change safely")
    for name in ("providers", "models"):
        if parsed.get(name) != expected[name]:
            raise ValueError("roko.toml is laid out in a way this cannot change safely")
    return new


def add_priced_rung(text: str, key_env: str) -> str:
    """`text` with the provider and model `API_MODELS[key_env]` names, at its real rates, on a new rung
    named `PRICED_RUNG` above every other rung of the ladder.

    Under a spending cap roko passes over a model it has no price for before calling it, and moves a task
    only up the ladder, never to a cheaper rung (decision 1119). So every capped run, a run from Hermes
    among them, ends on this rung, while a run without a cap starts on the rung it did and reaches this
    one only after failing on every rung below it. Raises ValueError when the file is laid out in a way
    this cannot change safely: a ladder that is off, one without rungs of its own (a rung added would
    replace roko's defaults), roles that climb rungs of their own, or a model of that name already there.
    """
    provider_id, provider, model, fields = API_MODELS[key_env]
    data = tomllib.loads(text)
    providers = _table(data, "providers")
    models = _table(data, "models")
    ladder = _table(_table(data, "routing"), "ladder")
    rungs = ladder.get("rungs")
    if ladder.get("enabled") is False:
        raise ValueError("the model ladder is off")
    if not isinstance(rungs, list) or not rungs:
        raise ValueError("roko.toml lists no ladder rungs of its own")
    roles = ladder.get("roles")
    if isinstance(roles, list) and any(isinstance(role, dict) and "rungs" in role for role in roles):
        raise ValueError("some roles climb ladder rungs of their own")
    if any(isinstance(rung, dict) and rung.get("name") == PRICED_RUNG for rung in rungs):
        raise ValueError(f"the ladder already has a rung named {PRICED_RUNG}")
    if model in models:
        raise ValueError(f"roko.toml already has [models.{model}]")
    blocks = [
        f"# Added by hermes roko init: a model roko calls over the API with {key_env}, at its real rates."
    ]
    if provider_id in providers:
        if providers[provider_id].get("kind") != provider["kind"]:
            raise ValueError(f"[providers.{provider_id}] is another kind of provider")
    else:
        blocks.append(f"[providers.{provider_id}]")
        blocks.extend(f"{key} = {_toml_value(value)}" for key, value in provider.items())
        blocks.append("")
    blocks.append(f"[models.{model}]")
    blocks.append(f'provider = "{provider_id}"')
    blocks.extend(f"{key} = {_toml_value(value)}" for key, value in fields.items())
    blocks.append("")
    blocks.append("# Runs with a spending cap climb to this rung past the models roko has no price for.")
    blocks.extend(["[[routing.ladder.rungs]]", f'name = "{PRICED_RUNG}"', f'model = "{model}"'])
    eol = "\r\n" if "\r\n" in text else "\n"
    base = text if not text or text.endswith(("\n", "\r")) else text + eol
    new = base + eol + eol.join(blocks) + eol
    try:
        parsed = tomllib.loads(new)
    except tomllib.TOMLDecodeError:
        raise ValueError("the model ladder is laid out in a way this cannot change safely") from None
    expected = copy.deepcopy(data)
    expected.setdefault("providers", {}).setdefault(provider_id, dict(provider))
    expected.setdefault("models", {})[model] = {"provider": provider_id, **fields}
    expected["routing"]["ladder"]["rungs"].append({"name": PRICED_RUNG, "model": model})
    if parsed != expected:
        raise ValueError("roko.toml is laid out in a way this cannot change safely")
    return new


def _toml_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join(_toml_value(item) for item in value) + "]"
    return '"' + str(value).replace("\\", "\\\\").replace('"', '\\"') + '"'


def _top_rung(text: str, model: str) -> str:
    """`text` with the `model` of the `[[routing.ladder.rungs]]` entry named "top" set to `model`."""
    lines = text.splitlines(keepends=True)
    eol = "\r\n" if "\r\n" in text else "\n"
    starts = [i for i, line in enumerate(lines) if _RUNG.match(line)]
    for start in starts:
        end = next((i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith("[")), len(lines))
        fields = {m["key"]: (i, m) for i in range(start + 1, end) if (m := _KEY.match(lines[i]))}
        name = fields.get("name")
        if name is None or name[1]["value"].strip().strip("\"'") != "top":
            continue
        if "model" in fields:
            i, found = fields["model"]
            rest = f"  {found['rest']}" if found["rest"] else ""
            lines[i] = f'{found["lead"]}model = "{model}"{rest}{found["eol"] or ""}'
        else:
            lines.insert(name[0] + 1, f'model = "{model}"{eol}')
        return "".join(lines)
    return text + f'{eol}[[routing.ladder.rungs]]{eol}name = "top"{eol}model = "{model}"{eol}'


_TABLE = re.compile(r"^\s*\[\s*(?P<name>[A-Za-z0-9_.-]+)\s*\]\s*(?:#.*)?$")
# How `hermes roko doctor` and this step name roko's learning, by `learning_state`. Pinning `domain_context`
# stops only the section bandit: the control arm the step keeps on still holds lessons back from some tries,
# and a prompt carries at most the few that match best, so nothing here promises every lesson in every prompt.
LEARNING_WORDS = {
    "on": "on: the prompt section that carries lessons from verified work is never dropped, and the checks' "
    "thresholds update after every run",
    "off": "off: roko keeps lessons from verified work, but a prompt may leave them out, and the checks' "
    "thresholds are saved only every few runs",
    "frozen": "frozen: roko.toml has [learning] frozen = true, so roko learns nothing",
}
LEARNING_DOCS = "docs/using-roko.md#turn-on-rokos-learning"
# What the learning step tells the person before it asks.
LEARNING_NOTE = (
    "The prompt section that carries lessons from verified work is then never dropped (a control arm",
    "still holds lessons back from some tries, to measure what they are worth), and the checks' learned",
    "thresholds update after every run. The self-model keeps to forecasts, roko keeps the control arms",
    "that measure each loop, and dreams stay off.",
)


def learning_state(data: dict[str, Any]) -> str:
    """roko's learning in a parsed roko.toml: "on" (LEARNING_CHANGES and LEARNING_PINNED set), "frozen"
    (`[learning] frozen = true`) or "off"."""
    learning = _table(data, "learning")
    if learning.get("frozen") is True:
        return "frozen"
    pinned = _table(data, "sections").get("pinned")
    changed = all(_table(data, table).get(key) == value for table, key, value in LEARNING_CHANGES)
    return "on" if changed and isinstance(pinned, list) and LEARNING_PINNED in pinned else "off"


def turn_on_learning(text: str) -> str | None:
    """`text`, a roko.toml, with roko's learning on: LEARNING_CHANGES set, LEARNING_PINNED pinned, and the
    LEARNING_DEFAULTS it lacks written out (a value the person chose stays). None when learning is on, or
    frozen. Raises ValueError when the file is laid out in a way this cannot change safely."""
    data = tomllib.loads(text)
    if learning_state(data) != "off":
        return None
    pinned = _table(data, "sections").get("pinned", [])
    if not isinstance(pinned, list) or not all(isinstance(item, str) for item in pinned):
        raise ValueError("[sections] pinned is not a list of section names")
    wanted = [
        *LEARNING_CHANGES,
        ("sections", "pinned", pinned if LEARNING_PINNED in pinned else [*pinned, LEARNING_PINNED]),
        *((table, key, value) for table, key, value in LEARNING_DEFAULTS if key not in _table(data, table)),
    ]
    new, expected = text, copy.deepcopy(data)
    for table, key, value in wanted:
        if table in data and not isinstance(data[table], dict):
            raise ValueError(f"{table} in roko.toml is not a table")
        here = _table(data, table)
        if key in here and here[key] == value and type(here[key]) is type(value):
            continue
        new = _set_key(new, table, key, value)
        expected.setdefault(table, {})[key] = value
    try:
        parsed = tomllib.loads(new)
    except tomllib.TOMLDecodeError:
        raise ValueError("roko.toml is laid out in a way this cannot change safely") from None
    if parsed != expected:
        raise ValueError("roko.toml is laid out in a way this cannot change safely")
    return new


def _set_key(text: str, table: str, key: str, value: Any) -> str:
    """`text` with `key = value` in `[table]`: its line rewritten (a comment on it kept), else a new line
    under the table's header, else a new table at the end."""
    lines = text.splitlines(keepends=True)
    eol = "\r\n" if "\r\n" in text else "\n"
    rendered = _toml_value(value)
    start = next(
        (i for i, line in enumerate(lines) if (m := _TABLE.match(line)) and m["name"] == table), None
    )
    if start is None:
        base = text if not text or text.endswith(("\n", "\r")) else text + eol
        return base + f"{eol}[{table}]{eol}{key} = {rendered}{eol}"
    end = next((i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith("[")), len(lines))
    last = start
    for i in range(start + 1, end):
        found = _KEY.match(lines[i])
        if found and found["key"] == key:
            rest = f"  {found['rest']}" if found["rest"] else ""
            lines[i] = f"{found['lead']}{key} = {rendered}{rest}{found['eol'] or eol}"
            return "".join(lines)
        if lines[i].strip():
            last = i
    if not lines[last].endswith(("\n", "\r")):
        lines[last] += eol
    lines.insert(last + 1, f"{key} = {rendered}{eol}")
    return "".join(lines)


# -- small helpers -----------------------------------------------------------------------------------


def _table(data: dict[str, Any], key: str) -> dict[str, Any]:
    value = data.get(key)
    return value if isinstance(value, dict) else {}


def _append_env(path: Path, values: dict[str, str]) -> None:
    """Add `NAME=value` lines to a dotenv file only its owner can read."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as out:
        if path.stat().st_size and not path.read_bytes().endswith(b"\n"):
            out.write("\n")
        for name, value in values.items():
            out.write(f"{name}={value}\n")
    path.chmod(0o600)


def _replace_file(path: Path, text: str, *, backup: bool = True) -> Path | None:
    """Keep a copy of `path` (in the workspace's `.roko/backups` when there is one, as the setup fix
    does) unless `backup` is false, then replace it in one step with its mode kept. A `path` that is a
    symlink is replaced where it lives, as the setup fix does: the link stays. Returns the copy."""
    copy_path = None
    if backup:
        data_dir = path.parent / ".roko"
        folder = data_dir / "backups" if data_dir.is_dir() else path.parent
        folder.mkdir(parents=True, exist_ok=True)
        stem = f"{path.name}.bak-{time.strftime('%Y%m%d-%H%M%S')}"
        copy_path = folder / stem
        n = 1
        while copy_path.exists():
            n += 1
            copy_path = folder / f"{stem}-{n}"
        shutil.copy2(path, copy_path)
    target = path.resolve()
    mode = target.stat().st_mode & 0o7777
    handle, temp = tempfile.mkstemp(prefix=f".{target.name}.", dir=target.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as out:
            out.write(text)
        os.chmod(temp, mode)
        os.replace(temp, target)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise
    return copy_path


def _providers(names: list[str]) -> str:
    return ", ".join(ROKO_KEYS[name] for name in names)


def _find_demo(workdir: Path) -> Path | None:
    plans = workdir / "plans"
    if not plans.is_dir():
        return None
    for plan in sorted(plans.glob("**/plan.md")):
        if len(plan.relative_to(plans).parts) > 4:
            continue
        try:
            head = plan.read_text(encoding="utf-8")[:2000]
        except OSError:
            continue
        if any(line.strip() == DEMO_TITLE for line in head.splitlines()):
            return plan.parent
    return None


def _diff(old: str, new: str) -> list[str]:
    import difflib

    return [
        line.rstrip("\n")
        for line in difflib.unified_diff(
            old.splitlines(keepends=True),
            new.splitlines(keepends=True),
            "roko.toml (now)",
            "roko.toml (after)",
            n=1,
        )
    ]


def _slug(path: Path) -> str:
    import hashlib

    name = re.sub(r"[^a-z0-9]+", "-", path.name.lower()).strip("-") or "project"
    return f"{name}.{hashlib.sha256(str(path).encode()).hexdigest()[:8]}"


def _arg(value: Path | str) -> str:
    text = str(value)
    return text if re.fullmatch(r"[\w@%+=:,./~-]+", text) else "'" + text.replace("'", "'\\''") + "'"

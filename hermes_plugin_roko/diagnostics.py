"""`hermes roko doctor` and `/roko doctor`: is Hermes' link to roko usable, and if not, why.

The checks against roko come from the same look the setup card uses (readiness.py): a failing check
says that setup problem's own words and its fix, so the doctor, the CLI and the pages agree.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import _hermes, readiness
from .catalog import ROKO_MCP_TOOLS
from .errors import Code, Refusal
from .runtime import Runtime
from .version import __version__

OK, WARN, FAIL = "ok", "warn", "fail"
SETUP_STATE_KEY = "setup.v1"
# A directory install puts desktop/ and dashboard/ next to this package; a pip install has neither.
PLUGIN_ROOT = Path(__file__).resolve().parent.parent


@dataclass
class Check:
    name: str
    status: str
    detail: str
    hint: str | None = None
    # The setup problem behind a failing check (readiness), whose detail the doctor prints too.
    problem: dict[str, Any] | None = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "status": self.status, "detail": self.detail}
        if self.hint:
            out["hint"] = self.hint
        if self.problem:
            out["problem"] = self.problem
        return out


@dataclass
class Report:
    checks: list[Check]
    unreachable: bool = False
    # Every setup problem found, as the setup card shows them: the install's, then roko's.
    problems: list[dict[str, Any]] = field(default_factory=list)

    @property
    def failed(self) -> bool:
        return any(check.status == FAIL for check in self.checks)

    @property
    def warned(self) -> bool:
        return any(check.status == WARN for check in self.checks)

    def exit_code(self, strict: bool = False) -> int:
        if self.unreachable:
            return 4
        if self.failed:
            return 1
        if strict and self.warned:
            return 3
        return 0


def run_doctor(
    rt: Runtime, *, offline: bool = False, probe_runs: bool = True, cached: bool = False
) -> Report:
    """Every check. `cached` takes roko's side from the setup card's last look (a page polls it);
    otherwise the doctor looks again, and the setup card shows what it found."""
    checks = local_checks(rt)
    install = readiness.install_problems()
    checks.extend(problem_check("install", found) for found in install)
    # Hermes' own settings that change what roko's runs do without the person (approvals off).
    hermes = readiness.hermes_problems()
    checks.extend(problem_check("approvals", found) for found in hermes)
    if offline:
        return Report(checks, problems=readiness.blocks_first([*install, *hermes]))
    if cached:
        facts, found = readiness.look(rt)
    else:
        facts = readiness.probe(rt, runs=probe_runs)
        found = readiness.problems_from(facts)
        if probe_runs:
            readiness.store(rt, facts, found)
    checks.extend(roko_checks(facts, found))
    unreachable = any(item["id"] == readiness.UNREACHABLE for item in found) or (
        facts.error is not None and facts.error.code is Code.UNREACHABLE
    )
    return Report(
        checks, unreachable=unreachable, problems=readiness.blocks_first([*install, *hermes, *found])
    )


def local_checks(rt: Runtime) -> list[Check]:
    """What the doctor can tell without asking roko: the plugin, Hermes, the settings and the UI halves."""
    checks: list[Check] = []
    settings = rt.settings()
    hermes = _hermes.hermes_version() or "unknown"
    checks.append(Check("plugin", OK, f"hermes-plugin-roko {__version__} on Hermes {hermes}"))
    if hermes.startswith("0.21.0"):
        checks.append(
            Check(
                "hermes",
                OK,
                "Hermes 0.21.0: the plugin registers no hooks, so 0.21.0's concurrent-hook bug "
                "cannot block other tools",
            )
        )
    elif _hermes.hooks_gated_per_call():
        checks.append(
            Check(
                "learning guard",
                OK,
                "on: Hermes' background review cannot save a skill or memory that repairs roko's state or "
                "re-runs paid work"
                if settings.learning_guard
                else "off (opt-in): learning_guard: true refuses Hermes' background review a skill or memory "
                "that repairs roko's state or re-runs paid work",
            )
        )
    for problem in settings.problems:
        checks.append(Check("settings", WARN, problem, "fix plugins.entries.roko.settings in config.yaml"))
    credential = settings.credential()
    if settings.workdir is not None and not settings.remote:
        # 0.7.0: each project has its own roko serve, whose serve.json says where it listens.
        where = settings.display_url or "no roko serve runs for it now (Hermes starts it when it needs it)"
        checks.append(
            Check(
                "project",
                OK,
                f"{settings.workdir}: {where}; credential: {credential.source}",
            )
        )
    else:
        source = "remote, from " + settings.url_source if settings.remote else f"from {settings.url_source}"
        checks.append(
            Check(
                "url",
                OK if settings.url else WARN,
                f"{settings.display_url} ({source}); credential: {credential.source}"
                if settings.url
                else "no project and no roko serve: run `hermes roko init` in your project",
            )
        )
    if not _hermes.approval_gate_available():
        checks.append(
            Check(
                "approvals",
                WARN if not settings.approve_paid else FAIL,
                "Hermes' approval gate is not importable, so paid roko tools cannot ask the person",
                "update Hermes, or set approve_paid: false to run them without asking",
            )
        )
    learning = learning_check(settings.workdir)
    if learning is not None:
        checks.append(learning)
    checks.extend(ui_checks(settings.ui_actions))
    duplicate = _mcp_server_entry()
    if duplicate:
        checks.append(
            Check(
                "mcp",
                WARN,
                f"Hermes also has roko as an MCP server (mcp_servers.{duplicate}), so the model sees "
                "roko's tools twice: once as roko_* and once as mcp__roko__*",
                f"remove one: `hermes mcp remove {duplicate}`, or disable this plugin",
            )
        )
    return checks


def learning_check(workdir: Path | None) -> Check | None:
    """roko's learning, by the workspace's roko.toml: on, off or frozen (`hermes roko init` turns it on).
    None when the plugin does not know the workspace or cannot read its roko.toml."""
    # onboard imports render, which imports this module: import it here.
    from .onboard import LEARNING_DOCS, LEARNING_WORDS, learning_state

    if workdir is None:
        return None
    try:
        data = tomllib.loads((workdir / "roko.toml").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    state = learning_state(data)
    if state == "off":
        return Check(
            "learning", OK, f"{LEARNING_WORDS['off']}; `hermes roko init` turns it on", LEARNING_DOCS
        )
    return Check("learning", OK, LEARNING_WORDS[state])


def roko_checks(facts: readiness.Facts, found: list[dict[str, Any]]) -> list[Check]:
    """The checks against roko serve, from one look at it and the problems that look found."""
    by_id = {item["id"]: item for item in found}
    checks: list[Check] = []
    if facts.bug:
        checks.append(Check("roko", WARN, f"the plugin could not finish its look at roko ({facts.bug})"))
    error = facts.error
    if error is not None and not facts.health:
        reach = by_id.get(readiness.UNREACHABLE)
        checks.append(
            problem_check("reachable", reach)
            if reach
            else Check("reachable", FAIL, error.message, error.hint)
        )
        return checks
    health = facts.health
    checks.append(
        Check("reachable", OK, f"roko serve {health.get('version', '?')}, status {health.get('status', '?')}")
    )
    if error is not None:
        refused = by_id.get(readiness.KEY_REFUSED)
        checks.append(
            problem_check("auth", refused) if refused else Check("auth", FAIL, error.message, error.hint)
        )
        return checks
    settings = facts.settings
    if facts.has_key:
        checks.append(Check("auth", OK, f"key accepted ({facts.auth_method or 'auth off on the server'})"))
    else:
        checks.append(
            Check(
                "auth",
                OK if settings.is_loopback else WARN,
                "roko serve has auth off; no key is needed",
                None if settings.is_loopback else "a non-loopback roko serve should have auth on",
            )
        )
    # A look that broke part way (`facts.bug`) found no problems, so each lookup may come back empty.
    read_only = by_id.get(readiness.READ_ONLY)
    if facts.read_only and read_only is not None:
        checks.append(problem_check("scope", read_only))
    elif facts.has_key and facts.read_only is False:
        checks.append(Check("scope", OK, "the key can start, cancel and answer runs"))
    elif facts.scope_problem:
        checks.append(Check("scope", WARN, f"could not tell the key's scope: {facts.scope_problem}"))
    outdated = by_id.get(readiness.OUTDATED)
    if facts.tools_error is not None and not facts.missing_tools:
        checks.append(
            Check(
                "mcp",
                FAIL,
                f"roko's /mcp endpoint failed: {facts.tools_error.message}",
                facts.tools_error.hint,
            )
        )
    elif facts.missing_tools and outdated is not None:
        checks.append(problem_check("mcp", outdated))
        outdated = None
    elif facts.tools is not None:
        extra = sorted(facts.tools - set(ROKO_MCP_TOOLS))
        detail = f"all {len(ROKO_MCP_TOOLS)} MCP tools the plugin uses are served"
        if extra:
            detail += f" (roko also offers {', '.join(extra)}, which this plugin does not use yet)"
        checks.append(Check("mcp", OK, detail))
    no_model = by_id.get(readiness.NO_TOOL_LOOP_MODEL)
    # roko since gap-8548e3: models a run from Hermes can use, none with a price its cap can count.
    no_price = by_id.get(readiness.NO_PRICE)
    refuses = by_id.get(readiness.REFUSES_CHAT_RUNS)
    if facts.runs == "accepted":
        checks.append(Check("runs", OK, "roko accepts runs started from Hermes"))
    elif facts.runs == "refused" and Refusal.NO_DATA_BOUNDARY in facts.refusals and refuses is not None:
        checks.append(problem_check("runs", refuses))
    elif facts.runs == "refused" and no_model is not None:
        checks.append(problem_check("runs", no_model))
        no_model = None
    elif facts.runs == "refused" and no_price is not None:
        checks.append(problem_check("runs", no_price))
        no_price = None
    elif facts.runs == "unclear":
        detail = f"could not tell whether roko accepts runs: {facts.refusal_text}"
        checks.append(Check("runs", WARN, detail, facts.runs_problem.hint if facts.runs_problem else None))
    if no_model is not None:
        checks.append(problem_check("models", no_model))
    elif no_price is not None:
        checks.append(problem_check("models", no_price))
    elif readiness.NO_PRICE not in by_id:
        usable = facts.tool_loop_models()
        if usable:
            names = ", ".join(model.name for model in usable[:4]) + (" …" if len(usable) > 4 else "")
            checks.append(Check("models", OK, f"roko has API models for work from chat: {names}"))
    if outdated is not None:
        checks.append(problem_check("roko", outdated))
    return checks


def problem_check(name: str, problem: dict[str, Any]) -> Check:
    """A setup problem as a doctor line: its title, then (when printed) its detail and its fix."""
    status = FAIL if problem.get("severity") == readiness.BLOCK else WARN
    return Check(name, status, _after_colon(str(problem.get("title") or "")), fix_line(problem), problem)


def fix_line(problem: dict[str, Any]) -> str | None:
    """A problem's fix in one line: its label and the command to run, or where the docs explain it."""
    remedy = problem.get("fix")
    if not isinstance(remedy, dict):
        return None
    label = str(remedy.get("label") or "fix")
    if remedy.get("command"):
        return f"{label}: {remedy['command']}"
    if remedy.get("docs"):
        return f"{label}: see docs/{remedy['docs']}"
    return label


def _after_colon(title: str) -> str:
    """A sentence placed after `name:`: its article in lower case, as the doctor writes its own lines."""
    return title[0].lower() + title[1:] if title.startswith(("The ", "A ", "An ")) else title


def ui_checks(ui_actions: bool, root: Path = PLUGIN_ROOT) -> list[Check]:
    """Which UI halves this install carries, and what the person must do to see them."""
    desktop = (root / "desktop" / "plugin.js").is_file()
    dashboard = (root / "dashboard" / "manifest.json").is_file() and (
        root / "dashboard" / "plugin_api.py"
    ).is_file()
    if not desktop and not dashboard:
        return [
            Check(
                "ui",
                WARN,
                "this install has no desktop or dashboard half (a pip install carries only the tools)",
                "install the plugin's directory (hermes plugins install) for the roko page, chip and cards",
            )
        ]
    checks = []
    if desktop:
        checks.append(
            Check(
                "desktop",
                OK,
                "desktop app half installed: turn on its Desktop switch in Capabilities > Plugins "
                "(Settings > Plugins > Manage plugins leads there); if the app was open when you installed "
                "or updated the plugin, quit it (⌘Q) and open it again",
            )
        )
    if dashboard:
        checks.append(
            Check(
                "dashboard",
                OK,
                "web dashboard half installed: its routes load when the desktop app or hermes dashboard "
                "starts, so restart them after installing or updating the plugin",
            )
        )
    if not ui_actions:
        checks.append(
            Check(
                "ui actions",
                OK,
                "the desktop app and dashboard are read-only for roko (ui_actions: false)",
            )
        )
    return checks


def _mcp_server_entry() -> str | None:
    """The name of an mcp_servers entry that points at roko, if Hermes has one."""
    for name, entry in _hermes.mcp_servers().items():
        if entry.get("enabled") is False:
            continue
        url = str(entry.get("url") or "").rstrip("/")
        if name == "roko" or (url.endswith("/mcp") and ":6677" in url):
            return name
    return None

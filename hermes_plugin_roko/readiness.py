"""Is roko ready for Hermes, and if not, what fixes it: the setup problems every surface shows.

`problems(rt)` lists what stands between the person and a run that works. The desktop app and the
dashboard show it as the setup card (`GET /overview`, `GET /health`); `hermes roko doctor`, `/roko
doctor` and the end of `hermes roko setup` print the same words. Every problem comes from roko's own
answers: requests that change nothing (a run probe names a plan that cannot exist), and the routes
where roko lists its models and runs. Nothing here guesses; what roko does not say is left out.

A problem is the dict docs/ui-api.md describes: `{id, severity, title, detail, fix}`. One fix the
plugin applies itself, and only on this machine: `workspace-chat-ready` edits the workspace's
`roko.toml` so roko accepts runs started from Hermes (`fix_preview`, `apply_fix`). roko reads
roko.toml for every run it is asked to start, so the fix needs no restart.

Since 0.7.0 every look is about one project (the runtime's: `rt.scoped(project)`), and is kept per
project. When roko serve does not run for the project, the problem says why from the plugin's own
side (serve.py): no roko binary, one too old to start a serve, a project roko is not set up in, or a
serve the plugin can start (`start-serve`). Those fixes, and `setup-project`, live in fixes.py.
"""

from __future__ import annotations

import contextlib
import copy
import difflib
import hashlib
import logging
import os
import re
import secrets
import shutil
import tempfile
import threading
import time
import tomllib
import weakref
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TypeGuard
from urllib.parse import quote, urlsplit

from . import _hermes, rundata
from .catalog import ROKO_MCP_TOOLS, TERMINAL_STATES
from .client import RokoClient
from .errors import Code, Refusal, RokoError
from .runtime import Runtime
from .sanitize import clean
from .settings import Settings, is_loopback_url, read_serve_endpoint
from .workspace import _git_ok

logger = logging.getLogger(__name__)

Problem = dict[str, Any]

BLOCK, WARN = "block", "warn"

# Problem ids (docs/ui-api.md). `restart-hermes` is the install's own (install_state.py).
UNREACHABLE = "roko-unreachable"
# 0.7.0: why roko serve does not run for the project, from the plugin's side (serve.py).
NOT_FOUND = "roko-not-found"
TOO_OLD = "roko-too-old"
NEEDS_SETUP = "project-needs-setup"
KEY_REFUSED = "roko-key-refused"
SETTINGS = "plugin-settings"
READ_ONLY = "key-read-only"
REFUSES_CHAT_RUNS = "workspace-refuses-chat-runs"
NO_TOOL_LOOP_MODEL = "no-tool-loop-model"
# roko since gap-8548e3: a run from chat is held to its max_usd, so it needs a model with a price.
NO_PRICE = "no-priced-model"
OUTDATED = "roko-serve-outdated"
# Hermes' own settings (hermes_problems): with approvals off, nothing asks the person before a paid run.
APPROVALS_OFF = "approvals-off"

# The fix the plugin applies itself, and its two ways: let runs from chat run as terminal runs do
# (the default), or screen what their agents fetch with a data model.
CHAT_READY = "workspace-chat-ready"
# 0.7.0's fixes for a project's roko serve (fixes.py).
SETUP_PROJECT = "setup-project"
START_SERVE = "start-serve"
RESTART_SERVE = "restart-serve"
ACTIONS = (CHAT_READY,)
LOCAL, BOUNDARY = "local", "boundary"
VARIANTS = (LOCAL, BOUNDARY)

# How long a look at roko stays good, and how long a fix waits for roko to answer differently (roko
# reads roko.toml for each run; its watcher re-reads it every 2 s).
CACHE_S = 30.0
SETTLE_S = 8.0
RELOAD_S = 3.0  # how long after a roko.toml edit roko serve may still answer from the old one

# Provider kinds whose models roko calls in its own tool loop: the only ones that can hold a run's
# outbound actions for approval, so the only ones a run started from chat may use (roko-cli
# `dispatch_v2::runs_own_tools`). Perplexity's search models make poor data models.
TOOL_LOOP_KINDS = frozenset(
    {"anthropic_api", "openai_compat", "perplexity_api", "gemini_api", "cerebras_api"}
)
DATA_MODEL_KINDS = TOOL_LOOP_KINDS - {"perplexity_api"}
# The makers' own APIs. Each model roko lists is on one of them, or on a reseller or host.
FIRST_PARTY_HOSTS = frozenset({"api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"})
FIRST_PARTY_KINDS = frozenset({"anthropic_api", "gemini_api"})  # their own API unless a base_url says not

# A CLI provider whose models roko's failover moves to an API provider of the same family, when that one
# has its key (roko-core `chat_run_refusal`: the Claude CLI's slug runs on the Anthropic API).
FAILOVER_FAMILY = {"claude_cli": "anthropic_api"}

# roko's words (since 2026-10-15) when roko.toml's `[agent.data_llm]` names a model it cannot use.
DATA_MODEL_UNUSABLE = "[agent.data_llm] model"

# roko's answer for a path no route serves (routes/mod.rs `api_not_found`).
NO_ROUTE = "no api route matches"

# Where each problem is explained (relative to the plugin's docs/).
DOCS = {
    UNREACHABLE: "troubleshooting.md#roko-serve-is-not-reachable",
    NOT_FOUND: "getting-started.md#install-roko",
    TOO_OLD: "troubleshooting.md#roko-is-too-old-to-start-roko-serve",
    NEEDS_SETUP: "getting-started.md#set-roko-up-in-a-project",
    SETTINGS: "reference.md#plugin-settings",
    KEY_REFUSED: "troubleshooting.md#the-key-is-refused-or-read-only",
    READ_ONLY: "troubleshooting.md#the-key-is-refused-or-read-only",
    REFUSES_CHAT_RUNS: "troubleshooting.md#roko-refuses-runs-started-from-hermes",
    NO_TOOL_LOOP_MODEL: "troubleshooting.md#roko-has-no-model-for-runs-started-from-hermes",
    NO_PRICE: "using-roko.md#roko-has-no-priced-model-for-runs-from-hermes",
    OUTDATED: "troubleshooting.md#roko-serve-is-older-than-the-plugin",
    APPROVALS_OFF: "using-roko.md#when-hermes-approvals-are-off",
}


# -- one look at roko ------------------------------------------------------------------------------


@dataclass
class Model:
    """A model roko lists (`GET /api/models`), with what its provider says (`GET /api/providers`)."""

    key: str
    provider: str
    kind: str
    has_key: bool
    supports_tools: bool
    cost_per_m: float | None  # input + output, USD per million tokens
    first_party: bool = False  # on its maker's own API (OpenAI, Anthropic, Google)
    unhealthy: bool = False  # roko's circuit breaker holds its provider off for now


@dataclass
class Facts:
    """What one look at roko serve found. Nothing it does changes roko."""

    settings: Settings
    error: RokoError | None = None  # what stopped the look early: unreachable, a refused key, ...
    health: dict[str, Any] = field(default_factory=dict)
    auth_method: str | None = None
    has_key: bool = False
    read_only: bool | None = None  # None: no key, or roko did not say
    scope_problem: str | None = None  # a scope answer the plugin could not read
    tools: set[str] | None = None
    tools_error: RokoError | None = None
    runs: str | None = None  # accepted | refused | unclear; None when not probed
    refusals: list[str] = field(default_factory=list)
    refusal_text: str | None = None
    runs_problem: RokoError | None = None
    models: list[Model] | None = None  # None: not read
    models_problem: str | None = None
    keyed_kinds: set[str] = field(default_factory=set)  # provider kinds roko lists with their key set
    lacks: list[str] = field(default_factory=list)  # what this roko serve lacks that the plugin uses
    bug: str | None = None  # the plugin's own look broke: say so, and name no problem it did not see
    checked_at: str = field(default_factory=rundata.now_iso)
    # 0.7.0: when roko serve does not answer, why, from the plugin's side (`not_running`), and whether the
    # plugin can restart the serve (a binary with `roko serve --detach`) when it is too old.
    not_running: Problem | None = None
    can_restart: bool = False

    @property
    def reached(self) -> bool:
        return self.error is None

    @property
    def missing_tools(self) -> list[str]:
        if self.tools is None:
            return []
        return [name for name in ROKO_MCP_TOOLS if name not in self.tools]

    def tool_loop_models(self) -> list[Model] | None:
        """The models a run started from chat can use, as roko lists them; None when unknown.

        A CLI model counts too when an API provider of its family has its key: roko's failover moves the
        model there.
        """
        if self.models is None:
            return None
        keyed = {m.kind for m in self.models if m.has_key} | self.keyed_kinds
        return [
            m
            for m in self.models
            if m.supports_tools
            and ((m.kind in TOOL_LOOP_KINDS and m.has_key) or FAILOVER_FAMILY.get(m.kind) in keyed)
        ]


def probe(rt: Runtime, *, runs: bool = True) -> Facts:
    """Look at roko serve the way the doctor does. Never raises."""
    try:
        settings = rt.settings()
    except Exception as exc:  # unreadable settings: the doctor says so on its own
        logger.debug("roko: settings unreadable during the readiness look: %s", exc)
        from .settings import load_settings

        settings = load_settings(None)
    facts = Facts(settings)
    try:
        _look(rt, facts, runs=runs)
    except RokoError as exc:
        facts.error = facts.error or exc
    except Exception as exc:  # a bug must not take the page down
        logger.exception("roko: the readiness look broke")
        facts.bug = f"{type(exc).__name__}: {clean(exc, 200, one_line=True)}"
    try:
        if facts.error is not None and facts.error.code is Code.UNREACHABLE and not facts.error.timed_out:
            facts.not_running = not_running(rt, settings, facts.error)
        elif "tools" in facts.lacks:
            facts.can_restart = _can_manage(rt, settings)
    except Exception:  # the plugin's own side must not take the page down either
        logger.exception("roko: could not say why roko serve does not run")
    return facts


def _look(rt: Runtime, facts: Facts, *, runs: bool) -> None:
    settings = facts.settings
    credential = settings.credential()
    facts.has_key = credential.present
    client = rt.client(settings)
    facts.health = client.health()
    response = client.get_response("/api/health")
    if response.status_code == 401:
        hint = None if credential.present else "roko serve has auth on, and the plugin has no key"
        facts.error = RokoError(Code.UNAUTHORIZED, "roko serve refused the request (401)", hint=hint)
        return
    if response.status_code >= 400 and response.status_code != 503:
        facts.error = RokoError(Code.SERVER, f"GET /api/health answered HTTP {response.status_code}")
        return
    facts.auth_method = response.headers.get("X-Auth-Method")
    if credential.present:
        _probe_scope(client, facts)
    try:
        facts.tools = set(client.tool_names())
    except RokoError as exc:
        facts.tools_error = exc
    if runs and facts.read_only is not True and facts.tools is not None and not facts.missing_tools:
        facts.runs, facts.refusals, facts.refusal_text, facts.runs_problem = probe_runs(
            client, settings.max_run_usd
        )
        if facts.runs == "refused" and Refusal.READ_ONLY_KEY in facts.refusals:
            facts.read_only = True
    if Refusal.NO_TOOL_LOOP_MODEL not in facts.refusals:
        # roko lists every refusal that applies, so its word is the answer when it gives one; an
        # older roko starts the run and fails it in milliseconds, so ask what models it has.
        facts.models, facts.models_problem, facts.keyed_kinds = roko_models_and_keys(client)
    facts.lacks = _lacks(rt, client, facts)


def _probe_scope(client: RokoClient, facts: Facts) -> None:
    """Can the key start and answer runs? Cancel a run that cannot exist: nothing changes.

    roko lists API keys only to admins, so a write key cannot read its own scope; the write-scoped
    tools say so instead when the scope is too small.
    """
    try:
        client.call_tool("run_cancel", {"run_id": _probe_id()})
    except RokoError as exc:
        if exc.refusal == Refusal.READ_ONLY_KEY:
            facts.read_only = True
        elif exc.code is Code.NOT_FOUND:
            facts.read_only = False
        else:
            facts.scope_problem = exc.message
        return
    facts.read_only = False


def probe_runs(client: RokoClient, max_run_usd: float) -> tuple[str, list[str], str | None, RokoError | None]:
    """Would roko start a run Hermes asks for? Ask it to run a plan that cannot exist: nothing runs.

    Returns (accepted | refused | unclear, the refusals roko named, roko's words, an unclear error).
    roko checks whether it takes runs from chat before it looks the plan up.
    """
    try:
        client.call_tool("plan_run", {"plan_id": _probe_id(), "max_usd": min(0.01, max_run_usd)})
    except RokoError as exc:
        if exc.refusals:
            return "refused", list(exc.refusals), exc.message, None
        if exc.code is Code.NOT_FOUND:  # roko's `not_found`, or an older roko's "not found"
            return "accepted", [], None, None
        return "unclear", [], exc.message, exc
    # A plan with this name exists after all, and roko started it: nobody can tell from here.
    return "unclear", [], "the run probe unexpectedly started something; check roko_status", None


def roko_models(client: RokoClient) -> tuple[list[Model] | None, str | None]:
    """The models roko can use, as it lists them, or why it did not say."""
    models, problem_text, _ = roko_models_and_keys(client)
    return models, problem_text


def roko_models_and_keys(client: RokoClient) -> tuple[list[Model] | None, str | None, set[str]]:
    """`roko_models`, and the kinds of the providers roko lists with their key set (a provider with no
    model of its own can still take a CLI model's work by failover)."""
    try:
        providers = client.get("/api/providers")
        models = client.get("/api/models")
    except RokoError as exc:
        return None, exc.message, set()
    rows = providers.get("providers") if isinstance(providers, dict) else None
    listed = models.get("models") if isinstance(models, dict) else None
    if not isinstance(rows, list) or not isinstance(listed, list):
        return None, "roko's model list had an unexpected shape", set()
    by_id = {str(row.get("id")): row for row in rows if isinstance(row, dict)}
    keyed = {
        clean(row.get("kind"), 40, one_line=True) for row in by_id.values() if row.get("has_api_key") is True
    }
    out = []
    for row in listed:
        if not isinstance(row, dict) or not isinstance(row.get("key"), str):
            continue
        provider = by_id.get(str(row.get("provider")))
        if provider is None:
            continue
        costs = [
            cost for cost in (row.get("cost_input_per_m"), row.get("cost_output_per_m")) if _number(cost)
        ]
        kind = clean(provider.get("kind"), 40, one_line=True)
        health = provider.get("health")
        out.append(
            Model(
                key=clean(row["key"], 80, one_line=True),
                provider=clean(row.get("provider"), 80, one_line=True),
                kind=kind,
                has_key=provider.get("has_api_key") is True,
                supports_tools=row.get("supports_tools") is not False,
                cost_per_m=float(sum(costs)) if len(costs) == 2 else None,
                first_party=_first_party(kind, provider.get("base_url")),
                unhealthy=isinstance(health, dict) and health.get("state") == "unhealthy",
            )
        )
    return out, None, keyed


def _first_party(kind: str, base_url: Any) -> bool:
    if not isinstance(base_url, str) or not base_url:
        return kind in FIRST_PARTY_KINDS
    try:
        host = urlsplit(base_url).hostname
    except ValueError:
        return False
    return host in FIRST_PARTY_HOSTS


def _probe_id() -> str:
    return f"roko-doctor-probe-{secrets.token_hex(4)}"


# -- what this roko serve lacks --------------------------------------------------------------------

# What the person loses with a roko serve that lacks each part.
LOSES = {
    "tools": "Hermes cannot start or follow runs with it",
    "diff": "the roko page cannot show what a finished run changed, so Review and Merge do not work",
    "loop_events": (
        "it does not publish roko's loop events, so the roko page's loop dial and live steps stay "
        "quiet: no route decisions, sign-offs, held actions or lessons as they happen"
    ),
}

# Verdicts about one roko serve process that cannot change while it runs: (url, start) -> verdict.
_LOOP_VERDICTS: dict[tuple[str, int], bool] = {}
_LOOP_LOCK = threading.Lock()


def _lacks(rt: Runtime, client: RokoClient, facts: Facts) -> list[str]:
    lacks = []
    # A roko from before /mcp answers it 404 (0.7.0: counted, so the setup card says roko is too old).
    gone = facts.tools_error is not None and facts.tools_error.code in (Code.PROTOCOL, Code.NOT_FOUND)
    if facts.missing_tools or gone:
        lacks.append("tools")
    if _route_missing(client, f"/api/runs/{_probe_id()}/diff"):
        lacks.append("diff")
    if _publishes_loop_events(rt, client, facts.health) is False:
        lacks.append("loop_events")
    return lacks


def _route_missing(client: RokoClient, path: str) -> bool:
    """Whether roko serves no route at `path` (an older build), as opposed to an unknown id."""
    try:
        client.get(path)
    except RokoError as exc:
        return exc.code is Code.NOT_FOUND and NO_ROUTE in exc.message.lower()
    return False


def _publishes_loop_events(rt: Runtime, client: RokoClient, health: dict[str, Any]) -> bool | None:
    """Whether this roko serve publishes route decisions with each attempt (roko since 2026-10-14).

    No route says what a roko build publishes, so the answer comes from a run Hermes started on this
    roko serve process: one that spawned an agent shows `route_decided` rows beside it, or this roko
    is older. None until such a run exists.
    """
    uptime = health.get("uptime_secs")
    if not _number(uptime):
        return None
    started = time.time() - float(uptime)
    key = (client.settings.url, int(started // 60))
    with _LOOP_LOCK:
        if key in _LOOP_VERDICTS:
            return _LOOP_VERDICTS[key]
    for run in rt.runs.recent(20):
        if run.get("kind") not in ("run", "plan") or run.get("state") not in TERMINAL_STATES:
            continue
        when = _parse_time(run.get("started_at"))
        if when is None or when.timestamp() < started + 2:
            continue  # an earlier roko serve process ran it
        seen = _event_types(client, str(run.get("run_id") or ""))
        if seen is None or "agent_spawned" not in seen:
            continue
        verdict = "route_decided" in seen
        with _LOOP_LOCK:
            _LOOP_VERDICTS[key] = verdict
        return verdict
    return None


def _event_types(client: RokoClient, run_id: str) -> set[str] | None:
    """Which of `agent_spawned` and `route_decided` a run's event index holds."""
    path = f"/api/runs/{quote(run_id, safe='')}/events"
    seen: set[str] = set()
    cursor = 0
    for _ in range(5):
        try:
            page = client.get(path, {"cursor": cursor, "limit": 200, "types": "agent_spawned,route_decided"})
        except RokoError:
            return None
        if not isinstance(page, dict):
            return None
        for row in page.get("events") or []:
            if isinstance(row, dict) and isinstance(row.get("type"), str):
                seen.add(row["type"])
        nxt = page.get("next_cursor")
        if not page.get("has_more") or not isinstance(nxt, int) or nxt <= cursor or len(seen) == 2:
            break
        cursor = nxt
    return seen


# -- problems ---------------------------------------------------------------------------------------


def problems_from(facts: Facts) -> list[Problem]:
    """The setup problems one look found, the ones that block first."""
    settings = facts.settings
    out: list[Problem] = []
    if facts.bug:
        return out
    error = facts.error
    if error is not None:
        if facts.not_running is not None:
            out.append(facts.not_running)
        elif error.code is Code.UNREACHABLE or (error.code is Code.PROTOCOL and not facts.health):
            out.append(_unreachable(settings, error))
        elif error.code is Code.UNAUTHORIZED:
            out.append(_key_refused(settings, facts.has_key))
        elif error.code is Code.CONFIG:
            out.append(_settings_problem(error))
        return out
    if facts.read_only:
        out.append(_read_only(settings))
    if "tools" in facts.lacks:
        out.append(_outdated(facts, ["tools"], settings))
    for refusal in facts.refusals:
        if refusal == Refusal.NO_DATA_BOUNDARY:
            out.append(_refuses_chat_runs(settings, facts.refusal_text))
        elif refusal == Refusal.NO_TOOL_LOOP_MODEL:
            out.append(_no_tool_loop_model(roko_said=True))
        elif refusal == Refusal.NO_PRICE:
            out.append(_no_price(facts.refusal_text))
    usable = facts.tool_loop_models()
    if usable == [] and not any(p["id"] == NO_TOOL_LOOP_MODEL for p in out):
        out.append(_no_tool_loop_model(roko_said=False))
    later = [part for part in facts.lacks if part != "tools"]
    if later:
        out.append(_outdated(facts, later, settings))
    return blocks_first(out)


def problem(pid: str, severity: str, title: str, detail: str, remedy: dict[str, Any]) -> Problem:
    return {"id": pid, "severity": severity, "title": title, "detail": detail, "fix": remedy}


def blocks_first(found: list[Problem]) -> list[Problem]:
    return sorted(found, key=lambda item: item.get("severity") != BLOCK)


def fix(
    kind: str,
    label: str,
    *,
    action: str | None = None,
    command: str | None = None,
    docs: str | None = None,
    project: Path | None = None,
) -> dict[str, Any]:
    """A problem's fix. `project` (0.7.0) names the project an action is for; the page passes it back."""
    out: dict[str, Any] = {"kind": kind, "label": label, "action": action, "command": command, "docs": docs}
    if project is not None:
        out["project"] = str(project)
    return out


def _workdir_arg(settings: Settings) -> str:
    return _quote_arg(str(settings.workdir)) if settings.workdir else "WORKSPACE"


def not_running(rt: Runtime, settings: Settings, error: RokoError) -> Problem:
    """Why roko serve does not answer for a project on this machine, and the fix: no roko binary, one too
    old to start a serve, a project roko is not set up in, or a serve the plugin can start (`start-serve`)
    or is starting. A remote pin, or no project, says what it did before 0.7.0."""
    from . import serve as serving

    project = settings.workdir
    if settings.remote or project is None:
        return _unreachable(settings, error)
    found = serving.find_roko(rt, settings)
    name = rt.projects.name(project)
    if found is None or found.problem == "not_found":
        named = f" ({found.path} does not run)" if found is not None and found.path else ""
        return problem(
            NOT_FOUND,
            BLOCK,
            f"roko is not installed on this machine{named}.",
            f"Hermes starts roko serve for {name} by itself, but it needs the roko command: install it (in a "
            f"clone of roko's repository, `{serving.INSTALL_COMMAND}`), or set the plugin's roko_bin setting "
            "to a roko binary.",
            fix("docs", "install roko", command=serving.INSTALL_COMMAND, docs=DOCS[NOT_FOUND]),
        )
    if found.problem == "too_old":
        command = f"git pull && {serving.INSTALL_COMMAND}"
        return problem(
            TOO_OLD,
            BLOCK,
            "roko is too old to start roko serve in the background.",
            f"The roko at {found.path} is from before `roko serve --detach`, so Hermes cannot start roko "
            f"serve for {name}. Update roko: in your roko clone, `{command}`.",
            fix("command", "update roko", command=command, docs=DOCS[TOO_OLD]),
        )
    if not (project / "roko.toml").is_file():
        quoted = _quote_arg(str(project))
        return problem(
            NEEDS_SETUP,
            BLOCK,
            f"roko is not set up in {name} yet.",
            f"{project} has no roko.toml, so roko serve cannot start there. Setting roko up runs `roko init` "
            "and lets roko accept runs started from Hermes; nothing is committed.",
            fix(
                "action",
                "set up roko here",
                action=SETUP_PROJECT,
                command=f"hermes roko init --workdir {quoted}",
                docs=DOCS[NEEDS_SETUP],
                project=project,
            ),
        )
    state = serving.serve_state(rt, project, look=False)
    if state is not None and state.state == "failed" and state.error:
        return problem(
            UNREACHABLE,
            BLOCK,
            f"roko serve did not start for {name}.",
            f"{state.error.get('message')}. {_sentence(state.error.get('hint'))}",
            fix(
                "action",
                "start roko serve",
                action=START_SERVE,
                command=f"hermes roko serve start --project {_quote_arg(str(project))}",
                docs=DOCS[UNREACHABLE],
                project=project,
            ),
        )
    starting = state is not None and state.state == "starting"
    return problem(
        UNREACHABLE,
        BLOCK,
        f"roko serve is starting for {name}." if starting else f"roko serve is not running for {name}.",
        "Hermes started it a moment ago; this clears once it answers."
        if starting
        else "Nothing roko does works from Hermes until roko serve runs. Hermes starts it in the background, "
        "and it keeps running after Hermes quits until it has had no work for a while.",
        fix(
            "action",
            "start roko serve",
            action=START_SERVE,
            command=f"hermes roko serve start --project {_quote_arg(str(project))}",
            docs=DOCS[UNREACHABLE],
            project=project,
        ),
    )


def _can_manage(rt: Runtime, settings: Settings) -> bool:
    """Whether the plugin can start and restart roko serve for this project (a local one, with a roko that
    has `roko serve --detach`)."""
    from . import serve as serving

    if settings.remote or settings.workdir is None:
        return False
    found = serving.find_roko(rt, settings)
    return found is not None and found.problem is None


def _sentence(text: Any) -> str:
    said = clean(text, 600, one_line=True).rstrip(".")
    return f"{said[:1].upper()}{said[1:]}." if said else ""


def _unreachable(settings: Settings, error: RokoError) -> Problem:
    if not settings.url and settings.workdir is None and not settings.remote:
        # 0.7.0: no project at all, so no roko serve to ask (nothing falls back to port 6677).
        return problem(
            UNREACHABLE,
            BLOCK,
            "No project is chosen for roko yet.",
            "Hermes starts a roko serve for each project roko works in. Pick your project's folder on the "
            "roko page (Choose folder…), or run `hermes roko init` in it.",
            fix("command", "set up a project", command="hermes roko init", docs=DOCS[NEEDS_SETUP]),
        )
    endpoint = read_serve_endpoint(settings.workdir) if settings.workdir else None
    elsewhere = endpoint.get("url") if endpoint else None
    if (
        isinstance(elsewhere, str)
        and is_loopback_url(elsewhere)
        and not _same_server(elsewhere, settings.url)
    ):
        return problem(
            UNREACHABLE,
            BLOCK,
            f"Hermes cannot reach roko serve at {settings.display_url}.",
            f"roko serve in {settings.workdir} says it listens on {clean(elsewhere, 200, one_line=True)} "
            "instead. Point Hermes there.",
            fix(
                "command",
                "point hermes there",
                command=f"hermes roko setup --workdir {_workdir_arg(settings)}",
                docs=DOCS[UNREACHABLE],
            ),
        )
    if error.code is Code.PROTOCOL:
        return problem(
            UNREACHABLE,
            BLOCK,
            f"Something answers at {settings.display_url}, but it is not roko serve.",
            "Another program has that address, or the URL is wrong. Point Hermes at the address roko serve "
            "prints when it starts.",
            fix(
                "command",
                "point hermes at roko",
                command=f"hermes roko setup --workdir {_workdir_arg(settings)}",
                docs=DOCS[UNREACHABLE],
            ),
        )
    detail = (
        "roko serve did not answer in time: it may be busy or stuck. Nothing roko does works from Hermes "
        "until it answers."
        if error.timed_out
        else "Nothing roko does works from Hermes until roko serve runs. Start it in your roko workspace."
    )
    command = f"roko serve --workdir {_workdir_arg(settings)}"
    port = urlsplit(settings.url).port
    if settings.is_loopback and port and port != 6677:
        command += f" --port {port}"
    return problem(
        UNREACHABLE,
        BLOCK,
        f"Hermes cannot reach roko serve at {settings.display_url}.",
        detail,
        fix("command", "start roko serve", command=command, docs=DOCS[UNREACHABLE]),
    )


def _settings_problem(error: RokoError) -> Problem:
    return problem(
        SETTINGS,
        BLOCK,
        "The plugin's settings stop it from using roko serve.",
        f"{error.message}." + (f" {error.hint[:1].upper()}{error.hint[1:]}." if error.hint else ""),
        fix("docs", "how to fix", docs=DOCS[SETTINGS]),
    )


def _key_refused(settings: Settings, has_key: bool) -> Problem:
    command = f"hermes roko setup --workdir {_workdir_arg(settings)} --mint"
    if has_key:
        title = "roko serve refused the plugin's API key."
        detail = (
            f"The key from {settings.credential().source} does not work on this roko serve: it may have "
            "expired, been rotated, or belong to another roko serve. Until it works, Hermes sees nothing."
        )
    else:
        title = "roko serve needs an API key, and Hermes has none."
        detail = "roko serve has auth on, so it refuses every request from Hermes until the plugin has a key."
    return problem(
        KEY_REFUSED,
        BLOCK,
        title,
        detail,
        fix("command", "make a key", command=command, docs=DOCS[KEY_REFUSED]),
    )


def _read_only(settings: Settings) -> Problem:
    return problem(
        READ_ONLY,
        BLOCK,
        "The key is read-only, so Hermes cannot start, cancel or answer roko runs.",
        "Hermes can still show roko's runs. Make a write-scoped key under a new name; the old one keeps "
        "working for whatever else uses it.",
        fix(
            "command",
            "make a write key",
            command=f"hermes roko setup --workdir {_workdir_arg(settings)} --mint --key-name hermes-write",
            docs=DOCS[READ_ONLY],
        ),
    )


def _refuses_chat_runs(settings: Settings, said: str | None = None) -> Problem:
    path, why_not = editable_config(settings)
    where = str(path) if path else "The roko.toml of the workspace roko serve runs in"
    if said and DATA_MODEL_UNUSABLE in said:
        detail = (
            f"{where} names a data model ([agent.data_llm]) roko cannot call, so roko refuses every run you "
            "start from Hermes, and runs that use an API model stop before they start."
        )
    else:
        detail = (
            f"{where} neither sets roko's data-model boundary ([agent.data_llm]) nor allows runs from a chat "
            "without it, so roko refuses every run you start from Hermes."
        )
    if path is not None:
        return problem(
            REFUSES_CHAT_RUNS,
            BLOCK,
            "roko refuses runs started from Hermes in this workspace.",
            detail,
            fix(
                "action",
                "make ready",
                action=CHAT_READY,
                command=f"hermes roko fix {CHAT_READY}",
                docs=DOCS[REFUSES_CHAT_RUNS],
                project=settings.workdir,
            ),
        )
    return problem(
        REFUSES_CHAT_RUNS,
        BLOCK,
        "roko refuses runs started from Hermes in this workspace.",
        f"{detail} Hermes cannot change it from here ({why_not}). In that roko.toml, set [serve.mcp] "
        "allow_without_data_llm = true for local use, or name an API model with its key set in "
        "[agent.data_llm]; roko reads the change at once, with no restart.",
        fix("docs", "how to fix", docs=DOCS[REFUSES_CHAT_RUNS]),
    )


# roko's words name the models that have no price: "… the models it can run on have none (oss, glm). …"
_UNPRICED = re.compile(r"have none \(([^()\n]{1,200})\)")


def _no_price(said: str | None = None) -> Problem:
    match = _UNPRICED.search(said or "")
    named = f" ({clean(match.group(1), 200, one_line=True)})" if match else ""
    return problem(
        NO_PRICE,
        BLOCK,
        "roko has no priced model for runs started from Hermes.",
        "A run from Hermes is held to its cap, and roko can count only the calls of a model with a price, so "
        f"it refuses every run while none of the models such a run can use has one{named}. Give one of them "
        "its real rates in roko.toml (cost_input_per_m and cost_output_per_m on its [models.*] entry; 0 only "
        "for a free local model), which roko reads within seconds with no restart, or give roko another "
        "model that has a price: `hermes roko init` can add one.",
        fix("docs", "how to fix", docs=DOCS[NO_PRICE]),
    )


def _no_tool_loop_model(*, roko_said: bool) -> Problem:
    detail = (
        "A run from a chat must use a model roko calls over an API with its key set: a CLI agent such "
        "as Claude Code cannot hold the run's actions for your approval. Give roko.toml an API model "
        "([providers.*] and [models.*] tables, and a rung of the model ladder) and put its key in "
        "~/.roko/.env, then restart roko serve: it reads keys only when it starts."
    )
    title = (
        "roko has no model it can use for runs started from Hermes."
        if roko_said
        else "roko lists no API model with a key, so runs started from Hermes cannot work."
    )
    return problem(
        NO_TOOL_LOOP_MODEL, BLOCK, title, detail, fix("docs", "how to fix", docs=DOCS[NO_TOOL_LOOP_MODEL])
    )


def _outdated(facts: Facts, parts: list[str], settings: Settings | None = None) -> Problem:
    project = settings.workdir if settings is not None and facts.can_restart else None
    # 0.7.0: when the roko binary here is newer, the plugin restarts the serve on it (restart-serve).
    remedy = (
        fix(
            "action",
            "restart roko serve",
            action=RESTART_SERVE,
            command=f"hermes roko serve restart --project {_quote_arg(str(project))}",
            docs=DOCS[OUTDATED],
            project=project,
        )
        if project is not None
        else fix("docs", "how to update", docs=DOCS[OUTDATED])
    )
    if "tools" in parts:
        missing = ", ".join(facts.missing_tools) or "its /mcp tools"
        return problem(
            OUTDATED,
            BLOCK,
            "roko serve is too old for this plugin.",
            f"It lacks {missing}, so {LOSES['tools']}. Update roko, then restart roko serve.",
            remedy,
        )
    lost = "; and ".join(LOSES[part] for part in parts)
    return problem(
        OUTDATED,
        WARN,
        "roko serve is older than this plugin.",
        f"Runs still work, but {lost}. Restart roko serve from a current roko build to get them.",
        fix("docs", "how to update", docs=DOCS[OUTDATED]),
    )


def hermes_problems() -> list[Problem]:
    """Hermes' own settings that change what roko's runs do without the person: approvals off.

    One read of Hermes' config, which Hermes caches; never raises.
    """
    try:
        return [_approvals_off()] if _hermes.approval_mode() == "off" else []
    except Exception as exc:
        logger.debug("roko: could not read Hermes' approval mode: %s", exc)
        return []


def _approvals_off() -> Problem:
    command = "hermes config set approvals.mode smart"
    home = _hermes.hermes_home().expanduser()
    if home != Path.home() / ".hermes":
        command = f"HERMES_HOME={_quote_arg(str(home))} {command}"
    return problem(
        APPROVALS_OFF,
        WARN,
        "Hermes approvals are off: roko runs start without asking you.",
        "Hermes' approvals.mode is off, so it approves every tool call by itself: a chat can start paid "
        "roko runs, and run commands in your roko workspace, without a question. Set it to smart to be "
        "asked first (in the desktop app, the ⚡ Off item at the bottom right), and run `hermes config set "
        "skills.write_approval true` so Hermes asks you before it keeps a skill it wrote itself.",
        fix("command", "turn approvals on", command=command, docs=DOCS[APPROVALS_OFF]),
    )


def problem_for_error(rt: Runtime, exc: RokoError) -> Problem | None:
    """The setup problem a failed call is, when it is one, so the page shows its card and fix."""
    try:
        settings = rt.settings()
    except Exception:
        return None
    if exc.refusal == Refusal.NO_DATA_BOUNDARY:
        return _refuses_chat_runs(settings, exc.message)
    if exc.refusal == Refusal.NO_PRICE:
        return _no_price(exc.message)
    if exc.refusal == Refusal.NO_TOOL_LOOP_MODEL:
        return _no_tool_loop_model(roko_said=True)
    if exc.refusal == Refusal.READ_ONLY_KEY:
        return _read_only(settings)
    if exc.code is Code.UNREACHABLE and not exc.timed_out:
        try:
            return not_running(rt, settings, exc)
        except Exception:
            logger.debug("roko: could not say why roko serve does not run", exc_info=True)
            return _unreachable(settings, exc)
    if exc.code is Code.UNAUTHORIZED:
        return _key_refused(settings, settings.credential().present)
    return None


# -- the cached view every surface shows -----------------------------------------------------------


@dataclass
class _Cached:
    key: tuple[Any, ...]
    at: float
    facts: Facts
    problems: list[Problem]
    lifetime: float = CACHE_S


# By the process's runtime, then by project: each project's last look.
_CACHE: weakref.WeakKeyDictionary[Runtime, dict[str, _Cached]] = weakref.WeakKeyDictionary()
_CACHE_LOCK = threading.Lock()


def _slot(rt: Runtime) -> str:
    """The project a runtime's look is about, as the cache keys it."""
    try:
        settings = rt.settings()
    except Exception:
        return "?"
    return str(settings.workdir) if settings.workdir is not None else f"url:{settings.url}"


def cached(rt: Runtime) -> _Cached | None:
    """The project's last look, whatever its age (None before the first)."""
    with _CACHE_LOCK:
        return _CACHE.get(rt.root, {}).get(_slot(rt))


def _cache_key(rt: Runtime) -> tuple[Any, ...]:
    try:
        settings = rt.settings()
        credential = settings.credential()
    except Exception:
        return ("unreadable settings",)
    digest = hashlib.sha256((credential.value or "").encode()).hexdigest()[:12]
    marks = _local_marks(settings)
    return (settings.url, credential.source, digest, str(settings.workdir), settings.max_run_usd, *marks)


def _local_marks(settings: Settings) -> tuple[Any, ...]:
    """What changes on this machine when roko's answers may: roko.toml edited, roko serve restarted.

    A look taken before either is stale at once, not only after `CACHE_S`.
    """
    if settings.workdir is None:
        return ()
    workdir = settings.workdir.expanduser()
    try:
        mtime: int | None = (workdir / "roko.toml").stat().st_mtime_ns
    except OSError:
        mtime = None
    endpoint = read_serve_endpoint(workdir) or {}
    return (mtime, endpoint.get("pid"), endpoint.get("started_at"))


def problems(rt: Runtime) -> list[Problem]:
    """roko's setup problems, looked at most every `CACHE_S` seconds. Never raises."""
    return look(rt)[1]


def look(rt: Runtime) -> tuple[Facts, list[Problem]]:
    """The last look at roko and the problems it found, taken again once `CACHE_S` has passed."""
    key = _cache_key(rt)
    slot = _slot(rt)
    with _CACHE_LOCK:
        hit = _CACHE.get(rt.root, {}).get(slot)
        if hit is not None and hit.key == key and time.monotonic() - hit.at < hit.lifetime:
            return hit.facts, copy.deepcopy(hit.problems)
    facts = probe(rt)
    found = problems_from(facts)
    store(rt, facts, found)
    return facts, copy.deepcopy(found)


def store(rt: Runtime, facts: Facts, found: list[Problem]) -> None:
    """Keep a look someone just took (the doctor's), so every surface shows what it found."""
    entry = _Cached(_cache_key(rt), time.monotonic(), facts, copy.deepcopy(found), _lifetime(rt))
    with _CACHE_LOCK:
        _CACHE.setdefault(rt.root, {})[_slot(rt)] = entry


def _lifetime(rt: Runtime) -> float:
    """`CACHE_S`, or less when roko.toml changed a moment ago: roko serve re-reads it every 2 s, so a
    look taken just after an edit may hold its old answer and must be taken again soon."""
    try:
        workdir = rt.settings().workdir
        if workdir is None:
            return CACHE_S
        age = time.time() - (workdir.expanduser() / "roko.toml").stat().st_mtime
    except Exception:
        return CACHE_S
    return CACHE_S if age >= RELOAD_S else min(CACHE_S, max(RELOAD_S - age, 0.5))


def invalidate(rt: Runtime) -> None:
    """Forget the last look, so the next one asks roko again (after a fix, or a refused run)."""
    with _CACHE_LOCK:
        _CACHE.get(rt.root, {}).pop(_slot(rt), None)


def remember(rt: Runtime, found: Problem) -> None:
    """Add a problem a refused call just showed to the cached look, so the page shows it at once."""
    with _CACHE_LOCK:
        hit = _CACHE.get(rt.root, {}).get(_slot(rt))
        if hit is not None and all(p["id"] != found["id"] for p in hit.problems):
            hit.problems = blocks_first([*hit.problems, found])


def install_problems(install: Callable[[], list[Problem]] | None = None) -> list[Problem]:
    """The install's own problems (a stale desktop copy, an old backend), when that module is here."""
    try:
        if install is None:
            from . import install_state  # type: ignore[attr-defined,unused-ignore]

            install = install_state.problems
        found = install()
    except Exception as exc:  # the module is newer than this one, or failed: say nothing
        logger.debug("roko: no install problems: %s", exc)
        return []
    return [p for p in found if isinstance(p, dict) and p.get("id")] if isinstance(found, list) else []


def install_status() -> dict[str, Any] | None:
    """`install_state.status()`, or None when this install has no such module."""
    try:
        from . import install_state  # type: ignore[attr-defined,unused-ignore]

        status = install_state.status()
    except Exception as exc:
        logger.debug("roko: no install status: %s", exc)
        return None
    return status if isinstance(status, dict) else None


def setup_view(rt: Runtime, roko: list[Problem] | None = None) -> dict[str, Any]:
    """`{"ok", "problems", "checked_at"}`: the install's problems, Hermes' (approvals off), then roko's.

    Blocking problems come first. Never raises.
    """
    checked_at = rundata.now_iso()
    if roko is None:
        try:
            facts, roko = look(rt)
            checked_at = facts.checked_at
        except Exception:  # never: look does not raise, but the page must render regardless
            logger.exception("roko: setup problems failed")
            roko = []
    found = blocks_first([*install_problems(), *hermes_problems(), *roko])
    return {
        "ok": not any(p.get("severity") == BLOCK for p in found),
        "problems": found,
        "checked_at": checked_at,
    }


# -- the fix: make the workspace accept runs started from Hermes -------------------------------------


@dataclass
class Plan:
    """What `workspace-chat-ready` would write, and why."""

    path: Path
    variant: str
    old: str
    new: str
    summary: str
    note: str | None = None  # what to know before applying it
    model: str | None = None
    already: bool = False  # nothing in roko.toml to change

    @property
    def changes(self) -> bool:
        return not self.already and self.new != self.old


_APPLY_LOCK = threading.Lock()


def editable_config(settings: Settings) -> tuple[Path | None, str | None]:
    """The roko.toml the fix may edit, or why it may not: roko serve must run on this machine, in a
    workspace the plugin knows and may write."""
    if not settings.is_loopback:
        return None, f"roko serve at {settings.display_url} is not on this machine"
    if settings.workdir is None:
        return (
            None,
            "the plugin does not know which workspace roko serve runs in (hermes roko setup --workdir)",
        )
    try:
        workdir = settings.workdir.expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        return None, f"{settings.workdir} is not a directory"
    if not workdir.is_dir():
        return None, f"{workdir} is not a directory"
    path = workdir / "roko.toml"
    if not path.is_file():
        return None, f"{workdir} has no roko.toml"
    target = path.resolve()
    if not os.access(target, os.W_OK) or not os.access(target.parent, os.W_OK):
        return None, f"Hermes may not write {target}"
    endpoint = read_serve_endpoint(workdir)
    url = endpoint.get("url") if endpoint else None
    if isinstance(url, str) and not _same_server(url, settings.url):
        elsewhere = clean(url, 200, one_line=True)
        return None, f"roko serve in {workdir} listens on {elsewhere}, not {settings.display_url}"
    return target, None


def fix_preview(rt: Runtime, action: str, variant: str | None = None) -> dict[str, Any]:
    """What the fix would change, for the person to read before applying it."""
    plan, variants = _plan(rt, action, variant)
    return {
        "action": action,
        "title": "Make this workspace accept runs started from Hermes",
        "variant": plan.variant,
        "variants": variants,
        "preview": _diff(plan),
        "path": str(plan.path),
        "summary": plan.summary,
        "digest": _digest(plan.old),
        "note": plan.note,
    }


def apply_fix(
    rt: Runtime, action: str, variant: str | None = None, digest: str | None = None
) -> dict[str, Any]:
    """Write the fix, ask roko again, and say what, if anything, is left to do.

    roko reads roko.toml for every run it is asked to start, so no restart is needed: the answer to
    the next run probe says whether the change took.
    """
    with _APPLY_LOCK:
        plan, _ = _plan(rt, action, variant)
        if digest and digest != _digest(plan.old):
            raise RokoError(
                Code.CONFLICT,
                f"{plan.path} changed since the preview",
                hint="look at the preview again, then apply it",
            )
        settings = rt.settings()
        backup = None
        if plan.changes:
            backup = _write(plan)
            try:
                _reload(rt.client(settings))
            except RokoError as exc:
                shutil.copy2(backup, plan.path)  # roko says the new file is not valid: put the old one back
                raise RokoError(
                    Code.INVALID,
                    f"roko could not read the changed roko.toml, so the old one is back: {exc.message}",
                ) from exc
        invalidate(rt)
        state, refusals = _settle(rt, settings)
    fixed = state == "accepted" or (state == "refused" and Refusal.NO_DATA_BOUNDARY not in refusals)
    steps = []
    if state == "unclear":
        steps.append("look again in a moment: roko serve did not answer the check (hermes roko doctor)")
    elif not fixed:
        steps.append(_not_read(settings, plan.path))
    elif Refusal.NO_TOOL_LOOP_MODEL in refusals:
        steps.append(f"give roko a model for runs started from Hermes (docs/{DOCS[NO_TOOL_LOOP_MODEL]})")
    elif Refusal.NO_PRICE in refusals:
        steps.append(f"give one of roko's models for these runs a price (docs/{DOCS[NO_PRICE]})")
    if plan.changes and _tracked(plan.path):
        steps.append(_commit_step(plan.path))
    if state == "accepted":
        outcome = "roko accepts runs started from Hermes now."
    elif fixed and state == "refused":
        outcome = (
            "The data-model boundary does not stop runs started from Hermes any more, but roko still "
            "refuses them."
        )
    elif state == "unclear":
        outcome = "roko serve did not say whether it accepts runs started from Hermes now."
    else:
        outcome = "roko serve still refuses runs started from Hermes."
    return {
        "action": action,
        "variant": plan.variant,
        "done": plan.changes,
        "ready": state == "accepted",
        "path": str(plan.path),
        "backup": str(backup) if backup else None,
        "summary": plan.summary,
        "next": "; then ".join(steps) or None,
        "message": ("Changed " if plan.changes else "Nothing to change in ") + f"{plan.path}. {outcome}",
    }


def _plan(rt: Runtime, action: str, variant: str | None) -> tuple[Plan, list[dict[str, Any]]]:
    if action not in ACTIONS:
        raise RokoError(Code.INVALID, f"there is no fix called {action!r}", hint=f"the fix is {CHAT_READY}")
    if variant is not None and variant not in VARIANTS:
        raise RokoError(Code.INVALID, f"variant must be {LOCAL} or {BOUNDARY}")
    settings = rt.settings()
    path, why_not = editable_config(settings)
    if path is None:
        raise RokoError(
            Code.FORBIDDEN,
            f"Hermes cannot make this workspace ready itself: {why_not}",
            hint="edit roko.toml where roko serve runs (see the problem's docs)",
        )
    try:
        old = path.read_text(encoding="utf-8")
        data = tomllib.loads(old)
    except (OSError, UnicodeDecodeError) as exc:
        raise RokoError(Code.CONFIG, f"could not read {path}: {exc}") from exc
    except tomllib.TOMLDecodeError as exc:
        raise RokoError(Code.CONFIG, f"{path} is not valid TOML: {exc}", hint="fix it by hand first") from exc
    boundary = _table(_table(data, "agent"), "data_llm") if "data_llm" in _table(data, "agent") else None
    allowed = _table(_table(data, "serve"), "mcp").get("allow_without_data_llm") is True
    # roko's own answer decides what is wrong; only when it gives none does the file.
    state, refusals, said, _ = probe_runs(rt.client(settings), settings.max_run_usd)
    if state == "unclear":
        refused = boundary is None and not allowed
    else:
        refused = state == "refused" and Refusal.NO_DATA_BOUNDARY in refusals
    if not refused:
        if state == "accepted":
            summary = "roko accepts runs started from Hermes in this workspace, so nothing needs changing."
        elif state == "refused":
            summary = (
                "The data-model boundary is not what stops runs started from Hermes here, so nothing in "
                "roko.toml needs changing for it."
            )
        else:
            summary = "roko.toml already allows runs started from Hermes, so nothing needs changing."
        return Plan(path, variant or LOCAL, old, old, summary, already=True), []
    if boundary is not None and DATA_MODEL_UNUSABLE in (said or ""):
        return _replace_data_model(rt, settings, path, old, data, variant, said or "")
    if boundary is not None or allowed:
        summary = (
            f"{path} already allows runs started from Hermes, but roko serve at {settings.display_url} "
            "still refuses them, so it does not read this file."
        )
        return Plan(
            path, variant or LOCAL, old, old, summary, note=_not_read(settings, path), already=True
        ), []
    choice, why = _data_model(rt, settings)
    variants = [
        {
            "id": LOCAL,
            "label": "run without the boundary (local use)",
            "recommended": True,
            "available": True,
            "why": "runs started from Hermes then run as runs started in a terminal do; nothing else changes",
        },
        {
            "id": BOUNDARY,
            "label": f"screen with {choice.key}" if choice else "screen with an API model",
            "recommended": False,
            "available": choice is not None,
            "why": why,
        },
    ]
    note = _change_note(path)
    if (variant or LOCAL) == BOUNDARY:
        if choice is None:
            raise RokoError(
                Code.INVALID,
                f"roko has no API model with a key to screen with ({why})",
                hint=f"use the {LOCAL} variant, or add an API key to ~/.roko/.env and restart roko serve",
            )
        new = _add_data_model(old, data, choice.key)
        return Plan(
            path, BOUNDARY, old, new, _boundary_summary(choice.key, why), note, model=choice.key
        ), variants
    new = _allow_without_boundary(old, data)
    summary = (
        "Lets runs you start from Hermes run as runs you start in a terminal do: without roko's data-model "
        "boundary, so what their agents fetch from the web or an MCP tool reaches them unscreened. Fine on "
        "your own machine, for your own requests. Only runs started from a chat change."
    )
    return Plan(path, LOCAL, old, new, summary, note), variants


def _replace_data_model(
    rt: Runtime,
    settings: Settings,
    path: Path,
    old: str,
    data: dict[str, Any],
    variant: str | None,
    said: str,
) -> tuple[Plan, list[dict[str, Any]]]:
    """roko.toml's `[agent.data_llm]` names a model roko cannot use (roko says so since 2026-10-15):
    name one it can. roko reads the table whenever it is set, so the local switch would not help."""
    current = _table(_table(data, "agent"), "data_llm").get("model")
    choice, why = _data_model(rt, settings, avoid=current if isinstance(current, str) else None)
    variants = [
        {
            "id": BOUNDARY,
            "label": f"screen with {choice.key}" if choice else "screen with an API model",
            "recommended": True,
            "available": choice is not None,
            "why": why,
        },
        {
            "id": LOCAL,
            "label": "run without the boundary (local use)",
            "recommended": False,
            "available": False,
            "why": "roko uses [agent.data_llm] whenever roko.toml sets it, so this switch changes nothing",
        },
    ]
    if variant == LOCAL:
        raise RokoError(
            Code.INVALID,
            "roko uses [agent.data_llm] whenever roko.toml sets it, so the local switch changes nothing",
            hint=f"use the {BOUNDARY} variant, or remove [agent.data_llm] by hand",
        )
    if choice is None:
        raise RokoError(
            Code.INVALID,
            "roko.toml's [agent.data_llm] names a model roko cannot use, and roko has no API model with "
            f"a key to name instead ({why})",
            hint="add an API key to ~/.roko/.env and restart roko serve, or remove [agent.data_llm] by hand",
        )
    new = _set_in_table(old, data, ("agent", "data_llm"), "model", choice.key)
    summary = (
        f"roko cannot use the model roko.toml's [agent.data_llm] names ({clean(said, 300, one_line=True)}), "
        f"so it refuses runs started from Hermes, and runs that use an API model stop before they start. "
        f"This names {choice.key} instead ({why})."
    )
    return Plan(path, BOUNDARY, old, new, summary, _change_note(path), model=choice.key), variants


def _boundary_summary(model: str, why: str) -> str:
    return (
        "Adds roko's data-model boundary: before an agent reads what it fetched from the web or an MCP "
        f"tool, {model} screens it ({why}). roko then screens in every run here that uses an API model, runs "
        "started in a terminal too: one more model call for each fetched result, and when that call does "
        "not go through (a rate limit, an outage), the agent does not get the result."
    )


def _change_note(path: Path) -> str:
    note = (
        f"A copy of roko.toml is kept in {_backup_dir(path)} first. roko reads the change at once, with no "
        "restart."
    )
    if _tracked(path):
        note += (
            " Commit roko.toml afterwards: the roko page merges a run's work only into a checkout without "
            "uncommitted changes."
        )
    return note


def _not_read(settings: Settings, path: Path) -> str:
    """What to do when roko serve still refuses although roko.toml allows runs from Hermes."""
    return (
        f"check that roko serve at {settings.display_url} runs in {path.parent} (hermes roko setup --workdir "
        "points Hermes at the right one) and can read its roko.toml (roko config validate there says why "
        "not)"
    )


def _commit_step(path: Path) -> str:
    return (
        "commit roko.toml before you merge a run, since the roko page merges only into a checkout without "
        f'uncommitted changes: git -C {_quote_arg(str(path.parent))} commit -m "roko: accept runs started '
        f'from Hermes" -- {_quote_arg(path.name)}'
    )


def _tracked(path: Path) -> bool:
    """Whether git tracks this roko.toml, so the fix leaves an uncommitted change behind."""
    return _git_ok(path.parent, "ls-files", "--error-unmatch", "--", path.name)


def _data_model(rt: Runtime, settings: Settings, avoid: str | None = None) -> tuple[Model | None, str]:
    """The model to screen with, and why: one roko calls over an API with its key set; a maker's own API
    first (a screening call that does not go through withholds what the agent fetched, so the provider
    must be dependable), a provider roko does not hold off first, then the cheapest."""
    models, problem_text = roko_models(rt.client(settings))
    if models is None:
        return None, f"roko did not list its models: {problem_text}"
    usable = [m for m in models if m.kind in DATA_MODEL_KINDS and m.has_key and m.key != avoid]
    if not usable:
        return None, "no model roko lists runs on an API provider whose key is set"
    best = min(
        usable,
        key=lambda m: (m.unhealthy, not m.first_party, m.cost_per_m is None, m.cost_per_m or 0.0, m.key),
    )
    where = f"on {best.provider}, its maker's own API" if best.first_party else f"on {best.provider}"
    if best.cost_per_m is not None:
        why = f"the cheapest model with its key set {where}, at ${best.cost_per_m:.2f} per million tokens"
    else:
        why = f"a model with its key set {where}"
    if best.unhealthy:
        why += "; roko holds its provider off for now"
    return best, why


# -- editing roko.toml without losing a comment ------------------------------------------------------

_TABLE = re.compile(r"^\s*\[(?!\[)\s*(?P<name>[^\]]+?)\s*\]\s*(?:#.*)?$")


def _added_by() -> str:
    return f"# Added by hermes roko fix {CHAT_READY} on {datetime.now(UTC).date().isoformat()}"


def _add_data_model(old: str, data: dict[str, Any], model: str) -> str:
    """`old` with an `[agent.data_llm]` table naming `model` at its end."""
    agent = data.get("agent")
    if isinstance(agent, dict) and "data_llm" in agent:
        raise RokoError(Code.CONFIG, "roko.toml already has [agent.data_llm]")
    block = (
        f"{_added_by()}: roko's data-model boundary.\n"
        "# Before a run's agent reads what it fetched from the web or an MCP tool, this model screens it.\n"
        "[agent.data_llm]\n"
        f'model = "{_toml_string(model)}"\n'
    )
    new = _append(old, block)
    expected = copy.deepcopy(data)
    expected.setdefault("agent", {})["data_llm"] = {"model": model}
    return _checked(new, expected)


def _allow_without_boundary(old: str, data: dict[str, Any]) -> str:
    """`old` with `[serve.mcp] allow_without_data_llm = true`: the line changed in place, added under
    the table's header, or a new table at the end."""
    return _set_in_table(
        old,
        data,
        ("serve", "mcp"),
        "allow_without_data_llm",
        True,
        f"{_added_by()}: run work Hermes starts without roko's\n# data-model boundary (local use).\n",
    )


def _set_in_table(
    old: str, data: dict[str, Any], table: tuple[str, ...], key: str, value: str | bool, comment: str = ""
) -> str:
    """`old` with `key = value` in `[table]`: the line changed in place (its comment kept), added under
    the table's header, or the table added at the end after `comment`."""
    literal = ("true" if value else "false") if isinstance(value, bool) else f'"{_toml_string(value)}"'
    lines = old.splitlines(keepends=True)
    start = next((i for i, line in enumerate(lines) if _table_name(line) == table), None)
    if start is None:
        new = _append(old, f"{comment}[{'.'.join(table)}]\n{key} = {literal}\n")
    else:
        end = next(
            (i for i in range(start + 1, len(lines)) if lines[i].lstrip().startswith("[")),
            len(lines),
        )
        pattern = re.compile(
            rf"^(?P<lead>\s*){re.escape(key)}\s*=\s*[^#\r\n]*(?P<rest>#[^\r\n]*)?(?P<eol>\r?\n?)$"
        )
        for i in range(start + 1, end):
            found = pattern.match(lines[i])
            if found:
                rest = f"  {found['rest']}" if found["rest"] else ""
                lines[i] = f"{found['lead']}{key} = {literal}{rest}{found['eol'] or ''}"
                break
        else:
            eol = "\r\n" if lines[start].endswith("\r\n") else "\n"
            if not lines[start].endswith(("\n", "\r")):
                lines[start] += eol
            lines.insert(start + 1, f"{key} = {literal}{eol}")
        new = "".join(lines)
    expected = copy.deepcopy(data)
    here = expected
    for part in table:
        here = here.setdefault(part, {})
    here[key] = value
    return _checked(new, expected)


def _table_name(line: str) -> tuple[str, ...] | None:
    found = _TABLE.match(line)
    if found is None:
        return None
    return tuple(part.strip().strip("\"'") for part in found["name"].split("."))


def _append(old: str, block: str) -> str:
    eol = "\r\n" if "\r\n" in old else "\n"
    text = old if not old or old.endswith(("\n", "\r")) else old + eol
    separator = "" if not text or text.endswith(eol * 2) else eol
    return text + separator + block.replace("\n", eol)


def _checked(new: str, expected: dict[str, Any]) -> str:
    """`new`, once it parses to exactly what the edit meant: else nothing is written."""
    try:
        parsed = tomllib.loads(new)
    except tomllib.TOMLDecodeError as exc:
        raise RokoError(
            Code.CONFIG, f"the edit would not be valid TOML ({exc})", hint="make the change by hand"
        ) from exc
    if parsed != expected:
        raise RokoError(
            Code.CONFIG,
            "roko.toml is laid out in a way this edit cannot change safely",
            hint="make the change by hand",
        )
    return new


def _toml_string(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"')


def _diff(plan: Plan) -> str:
    if not plan.changes:
        return ""
    name = plan.path.name
    return "".join(
        difflib.unified_diff(
            plan.old.splitlines(keepends=True),
            plan.new.splitlines(keepends=True),
            fromfile=f"{name} (now)",
            tofile=f"{name} (after)",
            n=2,
        )
    )


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _backup_dir(path: Path) -> Path:
    """Where the copy of roko.toml goes: the workspace's `.roko/backups` (most workspaces' git ignores
    `.roko`, and roko made it), else next to the file."""
    data_dir = path.parent / ".roko"
    return data_dir / "backups" if data_dir.is_dir() else path.parent


def _write(plan: Plan) -> Path:
    """Keep a copy of roko.toml, then replace it in one step. Returns the copy."""
    folder = _backup_dir(plan.path)
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    stem = f"{plan.path.name}.bak-{stamp}"
    backup = folder / stem
    n = 1
    while backup.exists():
        n += 1
        backup = folder / f"{stem}-{n}"
    shutil.copy2(plan.path, backup)
    mode = plan.path.stat().st_mode & 0o7777
    handle, temp = tempfile.mkstemp(prefix=".roko.toml.", dir=plan.path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as out:
            out.write(plan.new)
        os.chmod(temp, mode)
        os.replace(temp, plan.path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(temp)
        raise
    return backup


def _reload(client: RokoClient) -> None:
    """Ask roko serve to read roko.toml now (an admin route; roko reads it for each run anyway).

    Raises when roko says the new file is invalid; any other answer is fine.
    """
    try:
        client.post("/api/config/reload", {})
    except RokoError as exc:
        if exc.code is Code.INVALID:
            raise
        logger.debug("roko: config reload not available (%s): roko reads roko.toml for each run", exc.code)


def _settle(rt: Runtime, settings: Settings) -> tuple[str, list[str]]:
    """roko's answer to a run probe once the boundary no longer stops it, or after `SETTLE_S`."""
    client = rt.client(settings)
    deadline = time.monotonic() + SETTLE_S
    while True:
        state, refusals, _, _ = probe_runs(client, settings.max_run_usd)
        if state == "accepted" or (state == "refused" and Refusal.NO_DATA_BOUNDARY not in refusals):
            return state, refusals
        if time.monotonic() >= deadline:
            return state, refusals
        time.sleep(0.5)


# -- small helpers ----------------------------------------------------------------------------------


def _same_server(a: str, b: str) -> bool:
    """Whether two URLs name the same roko serve on this machine: loopback, same scheme and port."""
    try:
        one, two = urlsplit(a), urlsplit(b)
        ports = [part.port or (443 if part.scheme == "https" else 80) for part in (one, two)]
    except ValueError:
        return False
    if one.scheme != two.scheme or ports[0] != ports[1]:
        return False
    if is_loopback_url(a) and is_loopback_url(b):
        return True
    return (one.hostname or "") == (two.hostname or "")


def _quote_arg(text: str) -> str:
    return text if re.fullmatch(r"[\w@%+=:,./~-]+", text) else "'" + text.replace("'", "'\\''") + "'"


def _table(data: Any, key: str) -> dict[str, Any]:
    value = data.get(key) if isinstance(data, dict) else None
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _number(value: Any) -> TypeGuard[int | float]:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else None

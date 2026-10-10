"""`hermes roko doctor` and `/roko doctor`: is Hermes' link to roko usable, and if not, why."""

from __future__ import annotations

import secrets
from dataclasses import dataclass
from typing import Any

from . import _hermes
from .catalog import ROKO_MCP_TOOLS
from .client import RokoClient
from .errors import Code, RokoError
from .runtime import Runtime
from .version import __version__

OK, WARN, FAIL = "ok", "warn", "fail"
SETUP_STATE_KEY = "setup.v1"


@dataclass
class Check:
    name: str
    status: str
    detail: str
    hint: str | None = None

    def as_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"name": self.name, "status": self.status, "detail": self.detail}
        if self.hint:
            out["hint"] = self.hint
        return out


@dataclass
class Report:
    checks: list[Check]
    unreachable: bool = False

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


def run_doctor(rt: Runtime, *, offline: bool = False, probe_runs: bool = True) -> Report:
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
    for problem in settings.problems:
        checks.append(Check("settings", WARN, problem, "fix plugins.entries.roko.settings in config.yaml"))
    credential = settings.credential()
    checks.append(
        Check(
            "url",
            OK,
            f"{settings.display_url} (from {settings.url_source}); credential: {credential.source}",
        )
    )
    if credential.source.startswith("launch-token"):
        checks.append(
            Check(
                "credential",
                WARN,
                "using roko serve's launch token, an admin key that changes on every restart",
                "run `hermes roko setup --mint` for a durable write-scoped key",
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
    if offline:
        return Report(checks)

    try:
        client = rt.client(settings)
        health = client.health()
    except RokoError as exc:
        checks.append(Check("reachable", FAIL, exc.message, exc.hint))
        return Report(checks, unreachable=exc.code is Code.UNREACHABLE)
    checks.append(
        Check("reachable", OK, f"roko serve {health.get('version', '?')}, status {health.get('status', '?')}")
    )

    try:
        response = client.get_response("/api/health")
    except RokoError as exc:
        checks.append(Check("auth", FAIL, exc.message, exc.hint))
        return Report(checks)
    if response.status_code == 401:
        hint = (
            "run `hermes roko setup --mint`"
            if not credential.present
            else f"the key from {credential.source} was refused; run `hermes roko setup`"
        )
        checks.append(Check("auth", FAIL, "roko serve refused the request (401)", hint))
        return Report(checks)
    if response.status_code >= 400 and response.status_code != 503:
        checks.append(Check("auth", FAIL, f"GET /api/health answered HTTP {response.status_code}"))
        return Report(checks)
    method = response.headers.get("X-Auth-Method")
    if credential.present:
        checks.append(Check("auth", OK, f"key accepted ({method or 'auth off on the server'})"))
    else:
        checks.append(
            Check(
                "auth",
                OK if settings.is_loopback else WARN,
                "roko serve has auth off; no key is needed",
                None if settings.is_loopback else "a non-loopback roko serve should have auth on",
            )
        )
    checks.extend(_scope_check(client, credential.present))

    try:
        names = set(client.tool_names())
    except RokoError as exc:
        checks.append(Check("mcp", FAIL, f"roko's /mcp endpoint failed: {exc.message}", exc.hint))
        return Report(checks)
    missing = [name for name in ROKO_MCP_TOOLS if name not in names]
    if missing:
        checks.append(
            Check(
                "mcp",
                FAIL,
                f"roko serve lacks MCP tools the plugin needs: {', '.join(missing)}",
                "update roko to a build with the /mcp run tools (2026-10-03 or later)",
            )
        )
    else:
        extra = sorted(names - set(ROKO_MCP_TOOLS))
        detail = f"all {len(ROKO_MCP_TOOLS)} MCP tools the plugin uses are served"
        if extra:
            detail += f" (roko also offers {', '.join(extra)}, which this plugin does not use yet)"
        checks.append(Check("mcp", OK, detail))

    if probe_runs:
        checks.append(_boundary_check(client, rt.settings().max_run_usd))
    return Report(checks)


def _scope_check(client: RokoClient, credential_present: bool) -> list[Check]:
    """Can the key start and answer runs? Cancel a run that cannot exist: nothing changes.

    roko lists API keys only to admins, so a write key cannot read its own
    scope; the write-scoped tools say so instead when the scope is too small.
    """
    if not credential_present:
        return []
    probe = f"roko-doctor-probe-{secrets.token_hex(4)}"
    try:
        client.call_tool("run_cancel", {"run_id": probe})
    except RokoError as exc:
        if "write scope" in exc.message:
            return [
                Check(
                    "scope",
                    FAIL,
                    "the key is read-only: it cannot start, cancel or answer runs",
                    "run `hermes roko setup --workdir <workspace> --mint` for a write-scoped key",
                )
            ]
        if exc.code is Code.NOT_FOUND:
            return [Check("scope", OK, "the key can start, cancel and answer runs")]
        return [Check("scope", WARN, f"could not tell the key's scope: {exc.message}", exc.hint)]
    return [Check("scope", OK, "the key can start, cancel and answer runs")]


def _boundary_check(client: RokoClient, max_run_usd: float) -> Check:
    """Can Hermes start runs at all? Probe with a plan that cannot exist: nothing runs."""
    probe = f"roko-doctor-probe-{secrets.token_hex(4)}"
    try:
        client.call_tool("plan_run", {"plan_id": probe, "max_usd": min(0.01, max_run_usd)})
    except RokoError as exc:
        text = exc.message.lower()
        if exc.code is Code.NOT_FOUND or "not found" in text:
            return Check("runs", OK, "roko accepts runs started from Hermes")
        if "data-model boundary" in text:
            return Check(
                "runs",
                FAIL,
                "roko refuses runs started from Hermes: the workspace has no data-model boundary",
                "add an [agent.data_llm] table to the roko workspace's roko.toml, or for local use set "
                "[serve.mcp] allow_without_data_llm = true; then restart roko serve",
            )
        if "write scope" in text:
            return Check("runs", FAIL, "the key cannot start runs (read-only scope)", exc.hint)
        return Check("runs", WARN, f"could not tell whether roko accepts runs: {exc.message}", exc.hint)
    return Check("runs", WARN, "the run probe unexpectedly started something; check roko_status")


def _mcp_server_entry() -> str | None:
    """The name of an mcp_servers entry that points at roko, if Hermes has one."""
    for name, entry in _hermes.mcp_servers().items():
        if entry.get("enabled") is False:
            continue
        url = str(entry.get("url") or "").rstrip("/")
        if name == "roko" or (url.endswith("/mcp") and ":6677" in url):
            return name
    return None

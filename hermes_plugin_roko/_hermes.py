"""The only module that reaches into Hermes' own code.

Each import is guarded and made at call time, so the plugin loads on a Hermes
that has moved a name, and its tests run without Hermes installed. The
fallbacks are chosen to fail safe: no approval gate means "not approved".
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

logger = logging.getLogger(__name__)


def request_approval(tool_name: str, message: str, rule_key: str) -> tuple[bool, str | None]:
    """Ask the person, through Hermes' own approval gate, whether a call may run.

    Returns (approved, message). The gate is the one Hermes uses for dangerous
    shell commands: [o]nce / [s]ession / [a]lways / [d]eny in the CLI, buttons
    on messaging platforms, and a fail-closed refusal where nobody can answer
    (cron, `chat -q`) unless the person configured otherwise.
    """
    try:
        from tools.approval import request_tool_approval
    except Exception:  # pragma: no cover - depends on the Hermes build
        return (
            False,
            "BLOCKED: this Hermes has no approval gate the roko plugin can use. "
            "Set plugins.entries.roko.settings.approve_paid: false to run roko "
            "tools without asking.",
        )
    # No lock of our own: Hermes runs a session's plugin tools one at a time,
    # and a process-wide lock would make other gateway sessions wait on this
    # person's answer.
    try:
        result = request_tool_approval(tool_name, message, rule_key=rule_key)
    except Exception as exc:  # the gate itself failed: fail closed
        logger.warning("roko: approval gate failed for %s: %s", tool_name, exc)
        return False, f"BLOCKED: the approval gate failed ({exc}); nothing was run."
    if isinstance(result, dict) and result.get("approved"):
        return True, None
    text = result.get("message") if isinstance(result, dict) else None
    return False, str(text or f"BLOCKED: the person did not approve {tool_name}.")


def approval_gate_available() -> bool:
    try:
        from tools.approval import request_tool_approval  # noqa: F401
    except Exception:
        return False
    return True


def mcp_servers() -> dict[str, dict[str, object]]:
    """Hermes' configured `mcp_servers`, or {} when they cannot be read."""
    try:
        from hermes_cli.config import load_config

        config = load_config()
    except Exception:
        return {}
    servers = config.get("mcp_servers") if isinstance(config, dict) else None
    if not isinstance(servers, dict):
        return {}
    return {str(name): entry for name, entry in servers.items() if isinstance(entry, dict)}


def get_secret(name: str) -> str | None:
    """Read a credential by environment-variable name, honouring Hermes profiles."""
    try:
        from agent.secret_scope import UnscopedSecretError
        from agent.secret_scope import get_secret as _get_secret
    except Exception:
        value = os.environ.get(name)
        return value or None
    try:
        value = _get_secret(name, None)
    except UnscopedSecretError:
        # A multiplexed Hermes with no profile scope: os.environ may hold
        # another profile's value, so there is no key.
        return None
    except Exception:
        value = os.environ.get(name)
    return value or None


def hermes_home() -> Path:
    try:
        from hermes_constants import get_hermes_home

        return Path(get_hermes_home())
    except Exception:
        override = os.environ.get("HERMES_HOME")
        return Path(override).expanduser() if override else Path.home() / ".hermes"


def hermes_version() -> str | None:
    try:
        from hermes_cli import __version__

        return str(__version__)
    except Exception:
        return None


def save_env_value(key: str, value: str) -> Path:
    """Store a secret in Hermes' .env file (mode 0600) and the current process."""
    try:
        from hermes_cli.config import get_env_path
        from hermes_cli.config import save_env_value as _save
    except Exception:
        path = hermes_home() / ".env"
        _write_env_line(path, key, value)
    else:
        _save(key, value)
        path = Path(get_env_path())
    os.environ[key] = value
    return path


def _write_env_line(path: Path, key: str, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    lines = [line for line in lines if not line.startswith(f"{key}=")]
    lines.append(f"{key}={value}")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    path.chmod(0o600)


def is_interrupted() -> bool:
    """Whether the person interrupted the turn this tool call belongs to."""
    try:
        from tools.interrupt import is_interrupted as _is_interrupted

        return bool(_is_interrupted())
    except Exception:
        return False

"""One error type for everything that can go wrong between Hermes and roko.

Every surface (tools, `/roko`, `hermes roko`) turns a `RokoError` into its own
shape, but the codes and hints are shared, so the model and the person read
the same diagnosis.
"""

from __future__ import annotations

from enum import StrEnum

from .sanitize import clean


class Code(StrEnum):
    """What kind of failure, as a stable lowercase word."""

    UNREACHABLE = "unreachable"  # no answer from roko serve (refused, timeout, DNS)
    UNAUTHORIZED = "unauthorized"  # 401: missing, wrong or expired key
    FORBIDDEN = "forbidden"  # 403: the key's scope or role is too small
    NOT_FOUND = "not_found"  # 404, or roko says the run/plan/effect is unknown
    CONFLICT = "conflict"  # 409: e.g. a run is already active
    RATE_LIMITED = "rate_limited"  # 429
    INVALID = "invalid"  # the call's arguments are wrong (caught here or by roko)
    REFUSED = "refused"  # roko understood the call and declined it
    DENIED = "denied"  # the person did not approve the call
    SERVER = "server_error"  # 5xx
    PROTOCOL = "protocol"  # an answer roko should never give (bad JSON, wrong shape)
    CONFIG = "config"  # the plugin's own settings are unusable


class RokoError(Exception):
    """A failure with a code, a message for the model or person, and a hint."""

    def __init__(
        self,
        code: Code,
        message: str,
        *,
        hint: str | None = None,
        status: int | None = None,
        retry_after_s: float | None = None,
        timed_out: bool = False,
    ) -> None:
        # Messages often quote roko's own error text: clean it like any text from roko.
        message = clean(message, 2_000)
        super().__init__(message)
        self.code = code
        self.message = message
        self.hint = clean(hint, 1_000) if hint is not None else None
        self.status = status
        self.retry_after_s = retry_after_s
        # The request reached roko serve and no answer came in time: unlike a
        # refused connection, roko may have acted on it.
        self.timed_out = timed_out

    @property
    def retryable(self) -> bool:
        return self.code in (Code.UNREACHABLE, Code.RATE_LIMITED, Code.SERVER)

    def as_dict(self) -> dict[str, object]:
        out: dict[str, object] = {"error": self.message, "code": self.code.value, "success": False}
        if self.hint:
            out["hint"] = self.hint
        if self.status is not None:
            out["status"] = self.status
        if self.retry_after_s is not None:
            out["retry_after_s"] = self.retry_after_s
        return out

    def one_line(self) -> str:
        text = f"roko: {self.message} ({self.code.value})"
        if self.hint:
            text += f". {self.hint}"
        return text


def hint_for_refusal(message: str) -> str | None:
    """A next step for the refusals roko's MCP tools are known to give."""
    lowered = message.lower()
    if "data-model boundary" in lowered:
        return (
            "this is roko's own configuration, so retrying will not help: tell the person. They can add "
            "an [agent.data_llm] table to the roko workspace's roko.toml, or for local use set "
            "[serve.mcp] allow_without_data_llm = true, then restart roko serve"
        )
    if "plan run is active" in lowered:
        return "wait for the plan run to end (roko_status), or start this work as a plan instead"
    if "needs the write scope" in lowered:
        return "the API key is read-only; run `hermes roko setup --mint` for a write-scoped key"
    if "already queued" in lowered or "more are queued" in lowered:
        return "roko's run queue is full; wait for a run to end or cancel one"
    return None

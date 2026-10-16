"""One error type for everything that can go wrong between Hermes and roko.

Every surface (tools, `/roko`, `hermes roko`, the pages) turns a `RokoError` into its own shape from the
same codes. An error speaks to two audiences and keeps them apart:

- `message` (what happened) and `hint` (what the person can do next) are shown to the person as they are,
  by the pages, `/roko` and `hermes roko`. They never address the model.
- the model's guidance is for the model only: a tool answer carries it as its `hint` (`as_dict`), and
  nothing else shows it. For anything wrong in roko it says to report it and stop: never to repair roko's
  state, edit its config, or start paid work again on its own. Hermes may approve every tool without asking
  the person (its approvals off), and its background review saves what a turn did as skills, so these words
  are what stands between a refusal and a model that "fixes" roko.
"""

from __future__ import annotations

import re
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
    """A failure with a code, a message and a next step for the person, and guidance for the model."""

    def __init__(
        self,
        code: Code,
        message: str,
        *,
        hint: str | None = None,
        guidance: str | None = None,
        status: int | None = None,
        retry_after_s: float | None = None,
        timed_out: bool = False,
        refusal: str | None = None,
    ) -> None:
        # Messages often quote roko's own error text: clean it like any text from roko.
        message = clean(message, 2_000)
        super().__init__(message)
        self.code = code
        self.message = message
        # What the person can do: the pages, /roko and `hermes roko` show it next to the message.
        self.hint = clean(hint, 1_000) if hint is not None else None
        # What the model should do, when the default for the code (`guidance_for`) does not fit.
        self.guidance = clean(guidance, 1_500) if guidance is not None else None
        self.status = status
        self.retry_after_s = retry_after_s
        # The request reached roko serve and no answer came in time: unlike a
        # refused connection, roko may have acted on it.
        self.timed_out = timed_out
        # Why roko refused a run, as a stable word (`Refusal`), when it is one the person can fix,
        # and every such reason roko gave (a workspace can lack two things at once).
        self.refusal = refusal
        self.refusals: list[str] = [refusal] if refusal else []
        # The setup problem this failure is, for the UI's setup card (readiness.problem_for_error).
        self.problem: dict[str, object] | None = None

    @property
    def retryable(self) -> bool:
        return self.code in (Code.UNREACHABLE, Code.RATE_LIMITED, Code.SERVER)

    def model_hint(self) -> str | None:
        """What a tool answer tells the model to do about this failure: never shown to the person. Guidance
        ends with the S1 core (`hands_off`); a call the model got wrong keeps its own hint."""
        guidance = self.guidance or guidance_for(self)
        return hands_off(guidance) if guidance else self.hint

    def as_dict(self) -> dict[str, object]:
        """The failure as a tool answers it, for the model: its `hint` is the model's guidance."""
        out: dict[str, object] = {"error": self.message, "code": self.code.value, "success": False}
        hint = self.model_hint()
        if hint:
            out["hint"] = hint
        if self.status is not None:
            out["status"] = self.status
        if self.retry_after_s is not None:
            out["retry_after_s"] = self.retry_after_s
        if self.refusal:
            out["refusal"] = self.refusal
        return out

    def one_line(self) -> str:
        """The failure for the person, on one line (`/roko`, `hermes roko`)."""
        text = f"roko: {self.message} ({self.code.value})"
        if self.hint:
            text += f". {self.hint}"
        return text


class Refusal(StrEnum):
    """Why roko would not start a run, as a stable word, when the person can fix it.

    roko names the first three itself (`structuredContent.error.data.refusal` on a refused tool call);
    an older roko only says the first two in words, which `refusal_from_text` reads, and never refuses
    for want of a price (roko gap-8548e3).
    """

    NO_DATA_BOUNDARY = "no_data_boundary"  # the workspace's roko.toml has no data-model boundary
    NO_TOOL_LOOP_MODEL = "no_tool_loop_model"  # no model a run started from chat can use
    NO_PRICE = "no_price"  # none of the models such a run can use has a price its max_usd can count
    READ_ONLY_KEY = "read_only_key"  # the plugin's key lacks the write scope (the plugin's own word)


REFUSALS = frozenset(Refusal)


def refusal_from_text(message: str) -> str | None:
    """The refusal roko's words name, for a roko that gives no `refusal` word."""
    lowered = message.lower()
    if "data-model boundary" in lowered:
        return Refusal.NO_DATA_BOUNDARY.value
    if "count only the calls of a model with a price" in lowered:
        return Refusal.NO_PRICE.value
    if "needs the write scope" in lowered:
        return Refusal.READ_ONLY_KEY.value
    return None


# -- the person's next steps ---------------------------------------------------------------------

CHAT_READY_FIX = (
    "make the workspace ready with the make ready key on the roko page's setup card, or run `hermes roko "
    "fix workspace-chat-ready` in a terminal. It shows the change to roko.toml first, and roko reads it "
    "at once, with no restart"
)
MODEL_FIX = (
    "give roko.toml an API model and put its key in ~/.roko/.env, then restart roko serve (it reads keys "
    "only when it starts); the plugin's docs/troubleshooting.md shows how"
)
PRICE_FIX = (
    "give one of the models a run from Hermes can use its real rates in roko.toml (cost_input_per_m and "
    "cost_output_per_m on its [models.*] entry, 0 only for a free local model), or give roko another model "
    "that has a price (`hermes roko init` can add one); roko reads the rates within seconds, with no "
    "restart. The plugin's docs/using-roko.md shows how"
)
WRITE_KEY_FIX = (
    "make a write-scoped key: `hermes roko setup --workdir WORKSPACE --mint --key-name hermes-write`"
)


def hint_for_refusal(message: str, refusal: str | None = None) -> str | None:
    """What the person can do about a refusal roko's MCP tools are known to give."""
    refusal = refusal or refusal_from_text(message)
    if refusal == Refusal.NO_DATA_BOUNDARY:
        return CHAT_READY_FIX
    if refusal == Refusal.NO_TOOL_LOOP_MODEL:
        return MODEL_FIX
    if refusal == Refusal.NO_PRICE:
        return PRICE_FIX
    if refusal == Refusal.READ_ONLY_KEY:
        return WRITE_KEY_FIX
    lowered = message.lower()
    if "plan run is active" in lowered:
        return "wait for the plan run to end, or start this work as a plan instead"
    if "already queued" in lowered or "more are queued" in lowered:
        return "roko's run queue is full; wait for a run to end or cancel one"
    return None


# -- the model's guidance ------------------------------------------------------------------------

# The S1 core: every guidance about a problem, from a tool's failure to a run that did not simply
# succeed, ends with it, once (`hands_off`), so a new variant cannot leave it out. Merging a run's work, or
# another step the person asks for, is not repairing roko; the one exception to "not even when the person
# asks" is the command roko's own message gives for a checkout it left behind (`ROKO_STATE_GUIDANCE`).
REPORT_NOT_REPAIR = (
    "Never repair or clean up roko's state yourself (its worktrees, branches, .roko/, roko.toml or roko "
    "serve), not even when the person asks: report what roko said."
)


def hands_off(text: str) -> str:
    """`text`, ending with the S1 core (`REPORT_NOT_REPAIR`) unless it already carries it."""
    text = text.rstrip()
    if REPORT_NOT_REPAIR in text:
        return text
    return f"{text} {REPORT_NOT_REPAIR}" if text else REPORT_NOT_REPAIR


# How guidance about a failed call goes on: no paid work in its place (the S1 core follows it).
HANDS_OFF = "Do not retry it or start other paid work in its place: the person decides."

REFUSAL_GUIDANCE = {
    Refusal.NO_DATA_BOUNDARY: (
        "roko's own setup refuses every run started from a chat in this workspace, so retrying cannot "
        "help. Tell the person in a sentence, with their fix: the make ready key on the roko page's "
        "setup card, or `hermes roko fix workspace-chat-ready` in a terminal (it shows the change to "
        "roko.toml first; no restart). Do not edit roko.toml or apply the settings roko's message names "
        "yourself, even if they ask: point them to the fix. Then stop, and start nothing else."
    ),
    Refusal.NO_TOOL_LOOP_MODEL: (
        "roko has no model it can use for runs started from a chat, so retrying cannot help. Tell the "
        "person in a sentence: they give roko.toml an API model, put its key in ~/.roko/.env and restart "
        "roko serve; the plugin's docs/troubleshooting.md shows how. Do not edit roko.toml or ~/.roko/, "
        "or restart roko serve, yourself. Then stop, and start nothing else."
    ),
    Refusal.NO_PRICE: (
        "roko refuses runs started from a chat in this workspace: a run is held to its max_usd, and none of "
        "the models it can use has a price that cap can count, so retrying cannot help. Tell the person in "
        "a sentence, with their fix: give one of those models its real rates in roko.toml (cost_input_per_m "
        "and cost_output_per_m on its [models.*] entry), or give roko another model that has a price "
        "(`hermes roko init` can add one); the plugin's docs/using-roko.md shows how. Do not edit roko.toml "
        "or run hermes roko init yourself, even if they ask: the rates are theirs to set, and a wrong one (0 "
        "for a paid model) would let a run spend past its cap. Then stop, and start nothing else."
    ),
    Refusal.READ_ONLY_KEY: (
        "The plugin's roko key is read-only, so it cannot start, cancel or answer runs. Tell the person: "
        "they can make a write-scoped key with `hermes roko setup --mint --key-name hermes-write`. Do "
        "not run it for them. Then stop."
    ),
}

CODE_GUIDANCE = {
    Code.REFUSED: "roko declined this. Tell the person what roko said, then stop. " + HANDS_OFF,
    Code.CONFLICT: "roko is busy with work this conflicts with. Tell the person what roko said. " + HANDS_OFF,
    Code.UNREACHABLE: (
        "roko serve is not answering. Tell the person. Do not start, stop or restart roko serve, or run "
        "roko commands in a terminal, yourself; reading again later is fine."
    ),
    Code.UNAUTHORIZED: (
        "roko serve refused the plugin's key. Tell the person; making or storing a key is theirs to do "
        "(`hermes roko setup`), so do not run it for them."
    ),
    Code.FORBIDDEN: (
        "The plugin's roko key may not do this. Tell the person, and do not try another way around it."
    ),
    Code.SERVER: (
        "roko serve failed while answering. Tell the person what it said. Reading a run's status again "
        "later is fine; " + HANDS_OFF[0].lower() + HANDS_OFF[1:]
    ),
    Code.PROTOCOL: (
        "roko answered in a way the plugin does not understand: roko serve and the plugin may not match. "
        "Tell the person, and do not work around it with roko or git commands."
    ),
    Code.CONFIG: (
        "The roko plugin's own settings are unusable. Tell the person; `hermes roko doctor` shows what "
        "to fix. Do not edit Hermes' or roko's config yourself."
    ),
    Code.DENIED: (
        "The person did not approve this. Do not call it again, and do not start other paid work in its "
        "place, unless they ask."
    ),
}


def guidance_for(exc: RokoError) -> str | None:
    """The model's default guidance for a failure, with the person's next step.

    None leaves the call's own hint: an invalid call, an unknown id or a rate limit is the model's to correct.
    """
    if exc.refusal:
        try:
            return REFUSAL_GUIDANCE[Refusal(exc.refusal)]
        except (ValueError, KeyError):
            pass
    base = CODE_GUIDANCE.get(exc.code)
    if base is None:
        return None  # invalid, not_found, rate_limited: the hint says how to make the call right
    if exc.hint:
        return f"{base} What the person can do: {exc.hint.rstrip('.')}."
    return base


# -- what a tool answer says about an ended run ----------------------------------------------------

# roko's words when it could not set up its own workspace for a task (a leftover worktree or checkout).
_ROKO_STATE = re.compile(
    r"worktree-isolation|cannot safely reattach worktree|failed to acquire worktree"
    r"|already checked out in this repository|workspace I/O error",
    re.IGNORECASE,
)

FAILED_GUIDANCE = "Then stop: start it again, or a narrower run, only if the person asks."
# The S1 core comes before its one exception here, so `hands_off` leaves the exception last.
ROKO_STATE_GUIDANCE = (
    "roko could not set up its own workspace for the task (a worktree or checkout it left behind), so no "
    "work ran. That state is roko's: tell the person what roko said, and do not start the run again. "
    + REPORT_NOT_REPAIR
    + " Never run git surgery on its worktrees or branches, even if the person asks: no `git worktree "
    "remove`, no `git branch -D`, no `rm` of anything under `.roko/`. The one exception: if they explicitly "
    "ask in this turn for the checkout to be dealt with, run only the exact command roko's message gives for "
    "it (it moves the checkout aside and keeps its commits), and nothing else; if roko's message gives no "
    "command, tell them so and stop."
)
CANCELLED_GUIDANCE = "The run was cancelled. Tell the person; start it again only if they ask."


def names_roko_state(text: str) -> bool:
    """Whether roko's words say it failed on its own workspace state, not on the work."""
    return bool(_ROKO_STATE.search(text))

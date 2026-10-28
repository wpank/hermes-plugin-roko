"""What the person last said in each chat (round v7, P-64), for a tool whose call those words constrain.

Hermes' `pre_llm_call` hook passes each turn's own message (`user_message`). In phase 5.5's plan write the
person said "Cap the plan writing at $0.50", and the chat called roko_plan_generate without max_usd: roko
wrote under its own $2.00 limit. roko_plan_generate reads the turn's words back here and does not start
without the cap they name. Kept in memory, a few sessions deep: the hook and the tools run in the chat's
process.
"""

from __future__ import annotations

import re
import threading
from typing import Any

MAX_SESSIONS = 64
MAX_CHARS = 4_000

_last: dict[str, str] = {}
_lock = threading.Lock()

# A message that names a limit, and the sums of money in it: "$0.50", "$ 2", "0.4 USD", "3 dollars".
_LIMIT = re.compile(
    r"\b(?:cap|caps|capped|capping|limit|limits|limited|budget|at\s+most|no\s+more\s+than|up\s+to|max|maximum"
    r"|spend|spending)\b",
    re.IGNORECASE,
)
_MONEY = re.compile(r"\$\s?(\d+(?:\.\d+)?)|\b(\d+(?:\.\d+)?)\s?(?:usd|dollars?)\b", re.IGNORECASE)


def remember(session_id: Any, message: Any) -> None:
    """Keep the message the person sent in chat `session_id` this turn."""
    if not isinstance(session_id, str) or not session_id:
        return
    text = _text(message)[:MAX_CHARS]
    with _lock:
        _last.pop(session_id, None)
        _last[session_id] = text
        while len(_last) > MAX_SESSIONS:
            del _last[next(iter(_last))]


def last(session_id: Any) -> str | None:
    """The message the person sent in chat `session_id` this turn, when the hook saw it."""
    if not isinstance(session_id, str) or not session_id:
        return None
    with _lock:
        return _last.get(session_id)


def named_caps(text: str | None) -> list[float]:
    """The sums of money a message names as a limit, in order: none unless it says cap, limit, budget, at most
    and the like."""
    if not text or not _LIMIT.search(text):
        return []
    found: list[float] = []
    for match in _MONEY.finditer(text):
        value = float(match.group(1) or match.group(2))
        if value > 0 and value not in found:
            found.append(value)
    return found


def _text(message: Any) -> str:
    """A turn's message as text: Hermes passes a string, or a multimodal turn's parts."""
    if isinstance(message, str):
        return message
    if isinstance(message, list):
        parts = [
            part if isinstance(part, str) else part.get("text")
            for part in message
            if isinstance(part, str) or (isinstance(part, dict) and part.get("type") == "text")
        ]
        return " ".join(part for part in parts if isinstance(part, str))
    return ""

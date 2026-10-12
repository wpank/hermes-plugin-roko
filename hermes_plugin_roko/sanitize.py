"""Make text that came from roko safe to print.

Run labels, questions, summaries and gate output are written by agents and
tools roko ran, so they are untrusted. Before any of it reaches a terminal,
an approval prompt or a chat, escape sequences (which could recolour, retitle
or rewrite a terminal), other control characters and bidirectional overrides
(which can make text read differently from what it is) are removed.
"""

from __future__ import annotations

import re

# CSI, OSC (terminated by BEL or ST), and other two-byte ESC sequences.
_ESCAPES = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[@-Z\\-_])")
# C0 controls except tab and newline, DEL, and C1 controls.
_CONTROLS = re.compile(r"[\x00-\x08\x0b-\x1f\x7f-\x9f]")
# Bidirectional embeddings, overrides and isolates, plus the marks that hide text.
_BIDI = re.compile(r"[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]")


def clean(text: object, limit: int | None = None, *, one_line: bool = False) -> str:
    """`text` as a printable string: escapes and control characters removed, optionally clipped."""
    value = "" if text is None else str(text)
    value = _ESCAPES.sub("", value)
    value = _CONTROLS.sub("", value)
    value = _BIDI.sub("", value)
    if one_line:
        value = " ".join(value.split())
    if limit is not None and len(value) > limit:
        value = value[: max(0, limit - 1)] + "…"
    return value


def clean_tree(value: object, limit: int = 4000) -> object:
    """`clean` applied to every string inside a JSON-like value."""
    if isinstance(value, str):
        return clean(value, limit)
    if isinstance(value, list):
        return [clean_tree(item, limit) for item in value]
    if isinstance(value, dict):
        return {str(key): clean_tree(item, limit) for key, item in value.items()}
    return value

"""Make text that came from roko safe to print.

Run labels, questions, summaries and gate output are written by agents and
tools roko ran, so they are untrusted. Before any of it reaches a terminal,
an approval prompt or a chat, escape sequences (which could recolour, retitle
or rewrite a terminal), other control characters and bidirectional overrides
(which can make text read differently from what it is) are removed.
"""

from __future__ import annotations

import functools
import re
from pathlib import Path

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


def home_relative(text: str) -> str:
    """`text` with the person's home as `~`, so a page or a chat shows no account name: paths, commands,
    roko's words and a check's output alike (the lead's rule after hermes-pilot S-3). A quoted path keeps its
    quotes after the tilde, which the shell still expands; another account's folder stays as it is. Inside a
    longer path (CMake names an object after its source's absolute path) the home becomes `/~`."""
    home = str(Path.home()).rstrip("/")
    if len(home) < 2 or home not in text:
        return text
    return _home_pattern(home).sub(_tilde, text)


@functools.lru_cache(maxsize=4)
def _home_pattern(home: str) -> re.Pattern[str]:
    escaped = re.escape(home)
    return re.compile(
        rf"""(['"]){escaped}(?:/([^'"\n]*))?\1|(?<![\w.~/-]){escaped}(?=/|[^\w.-]|$)"""
        rf"""|(?P<inside>(?<=[\w.-]){escaped})(?=/|[^\w.-]|$)"""
    )


def _tilde(found: re.Match[str]) -> str:
    if found["inside"]:
        return "/~"
    if found[1] is None:
        return "~"
    return f"~/{found[1]}{found[2]}{found[1]}" if found[2] else "~"

"""Chat cards: the card line the model forgets (0.6.0).

On the desktop app a reply line holding only ``::roko-run{id="RUN_ID"}`` shows that run's card, and the
system prompt tells the model to write one after starting work (``prompt.DESKTOP``). A model that leaves it
out leaves the person with no card (dogfood-desktop's chat take). So the tools that start work note it here,
per Hermes session; Hermes' ``transform_llm_output`` hook adds the line a desktop reply leaves out, and
``on_session_end``, which Hermes fires once at every turn's end, forgets what the turn noted. A card line in
the turn's interim text (``on_interim_message``) names its run too. docs/ui-api.md, "Chat cards".
"""

from __future__ import annotations

import re
import threading
from collections.abc import Callable, Iterator
from typing import Any

from .prompt import DESKTOP_PLATFORMS

# What the desktop shows as a card, as Hermes 0.22's desktop reads it (hermes-update):
# - an id it accepts (desktop/plugin.js ID_RE); any other renders the raw line;
_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
# - a directive where a word starts (transcript-directives.ts SEGMENT_RE), with quoted attributes (ATTR_RE);
_DIRECTIVE = re.compile(r"(?<!\S)::roko-(?:run|plan)\{([^{}]{0,1024})\}")
_ATTR = re.compile(r"""([a-z][\w-]{0,63})=(?:"([^"]*)"|'([^']*)')""", re.IGNORECASE | re.ASCII)
# - in a paragraph of plain text: a code span, emphasis, a link, a URL or HTML makes it prose. A line
#   holding only a directive is shielded first (markdown-preprocess.ts shieldDirectiveLines), so its own
#   text never does;
_DIRECTIVE_LINE = re.compile(r"[ \t]*::[a-z][a-z0-9-]{0,63}\{[^{}\n]{0,1024}\}[ \t]*")
_INLINE_MARKDOWN = re.compile(
    r"`[^`]*`"
    r"|(?<![\w*])\*{1,3}(?=[^\s*])(?:[^*\n]*?[^\s*])?\*{1,3}"
    r"|(?<![\w_])_{1,3}(?=[^\s_])(?:[^_\n]*?[^\s_])?_{1,3}(?![\w_])"
    r"|!?\[[^\]\n]*\]\(|https?://|www\.|<[A-Za-z/!?]"
)
# - of at most this many characters, outside code fences.
PARAGRAPH_CHARS = 4800
_FENCE = re.compile(r" {0,3}(`{3,}|~{3,})")
# Backticks sit in classes: Hermes' install scanner reads an exclamation mark before a backtick as an inline
# shell snippet.
_CODE_SPAN = re.compile(r"(?<![`])(`+)(?![`]).*?(?<![`])\1(?![`])")
# `\$` before a digit: the desktop shows prices as text, so the backslash would stay on screen. Only in a turn
# where roko ran (plugin-review F13), and never inside `$…$` math.
_ESCAPED_PRICE = re.compile(r"(?<!\\)\\\$(?=\d)")
_MATH = re.compile(
    r"(?<![\\$])\$\$(?:[^$\\]|\\.|\$(?!\$))+?\$\$"
    r"|(?<![\\$])\$(?![\s$])(?:[^$\n\\]|\\.)+?(?<!\s)\$(?!\d)"
)
_ROKO_CARD = re.compile(r"::roko-(?:run|plan|pending)\{")
# Bounds, so a Hermes that never fires the hooks cannot grow the notes without end.
MAX_SESSIONS = 64
MAX_CARDS = 8

_lock = threading.Lock()
# Hermes session id -> what its turn started, in order: (run id, plan id or None).
_started: dict[str, list[tuple[str, str | None]]] = {}
# (session id, turn id) -> the ids the turn's interim text showed cards for.
_carded: dict[tuple[str, str], set[str]] = {}


def started(session_id: Any, run_id: str, *, plan_id: str | None = None) -> None:
    """Note a run, or a plan writing (`plan_id`), that a tool started in this session's turn."""
    if not isinstance(session_id, str) or not session_id or not _ID.fullmatch(run_id):
        return
    with _lock:
        starts = _started.pop(session_id, [])
        if len(starts) < MAX_CARDS and all(run != run_id for run, _ in starts):
            starts.append((run_id, plan_id))
        _started[session_id] = starts  # the newest session last, so the oldest goes first
        while len(_started) > MAX_SESSIONS:
            del _started[next(iter(_started))]


def transform_llm_output(
    response_text: Any = "", session_id: Any = "", platform: Any = "", turn_id: Any = "", **_: Any
) -> str | None:
    """Hermes' hook: on the desktop app, the reply with its card lines and plain prices; None if unchanged."""
    if not isinstance(response_text, str) or not response_text.strip():
        return None  # no text, no card; Hermes may still call again with the turn's text
    session = session_id if isinstance(session_id, str) else ""
    with _lock:
        starts = _started.pop(session, [])
        carded = _carded.pop((session, turn_id if isinstance(turn_id, str) else ""), set())
    if platform not in DESKTOP_PLATFORMS:
        return None
    roko_ran = bool(starts or carded or _ROKO_CARD.search(response_text))
    text = _outside_code(response_text, _plain_prices) if roko_ran else response_text
    named = _named(text) | carded
    lines = [f'::roko-run{{id="{run}"}}' for run, plan in starts if run not in named and plan not in named]
    if lines:
        text = text.rstrip() + "\n\n" + "\n".join(lines)
    return text if text != response_text else None


def on_interim_message(text: Any = "", session_id: Any = "", turn_id: Any = "", **_: Any) -> None:
    """Hermes' observer of what the model says beside a tool call: a card shown there names its run."""
    if not isinstance(text, str) or not isinstance(session_id, str) or not session_id:
        return
    ids = _named(text)
    if not ids:
        return
    key = (session_id, turn_id if isinstance(turn_id, str) else "")
    with _lock:
        _carded[key] = _carded.pop(key, set()) | ids
        while len(_carded) > MAX_SESSIONS:
            del _carded[next(iter(_carded))]


def on_session_end(session_id: Any = "", **_: Any) -> None:
    """Hermes' hook at every turn's end: forget what the turn started, whether or not its reply had text."""
    if isinstance(session_id, str):
        with _lock:
            _started.pop(session_id, None)
            for key in [key for key in _carded if key[0] == session_id]:
                del _carded[key]


def _named(text: str) -> set[str]:
    """The ids of the card lines in `text` that the desktop shows as cards."""
    ids: set[str] = set()
    for lines in _paragraphs(text):
        paragraph = "".join(lines)
        if "::" not in paragraph or len(paragraph) > PARAGRAPH_CHARS:
            continue
        prose = "".join(line for line in lines if not _DIRECTIVE_LINE.fullmatch(line.rstrip("\r\n")))
        if _INLINE_MARKDOWN.search(prose):
            continue
        for attrs in _DIRECTIVE.findall(paragraph):
            ident = _id_attribute(attrs)
            if ident and _ID.fullmatch(ident):
                ids.add(ident)
    return ids


def _id_attribute(attrs: str) -> str | None:
    """The directive's `id`, as the desktop reads it: the last quoted one."""
    found = None
    for name, double, single in _ATTR.findall(attrs):
        if name.lower() == "id":
            found = double or single
    return found


def _plain_prices(prose: str) -> str:
    """`prose` with `\\$` before a digit as `$`, outside `$…$` math."""
    out, last = [], 0
    for span in _MATH.finditer(prose):
        out += [_ESCAPED_PRICE.sub("$", prose[last : span.start()]), span.group(0)]
        last = span.end()
    out.append(_ESCAPED_PRICE.sub("$", prose[last:]))
    return "".join(out)


def _paragraphs(text: str) -> Iterator[list[str]]:
    """The lines of each paragraph outside code fences."""
    paragraph: list[str] = []
    for line, code in _lines(text):
        if code or not line.strip():
            if paragraph:
                yield paragraph
            paragraph = []
        else:
            paragraph.append(line)
    if paragraph:
        yield paragraph


def _outside_code(text: str, fix: Callable[[str], str]) -> str:
    """`text` with `fix` applied to everything but code fences and code spans."""
    out = []
    for line, code in _lines(text):
        if code:
            out.append(line)
            continue
        last = 0
        for span in _CODE_SPAN.finditer(line):
            out += [fix(line[last : span.start()]), span.group(0)]
            last = span.end()
        out.append(fix(line[last:]))
    return "".join(out)


def _lines(text: str) -> Iterator[tuple[str, bool]]:
    """Each line of `text` with its line end, and whether it belongs to a code fence (its fences included)."""
    fence = ""
    for line in text.splitlines(keepends=True):
        found = _FENCE.match(line)
        if fence:
            if found and found[1][0] == fence[0] and len(found[1]) >= len(fence) and line.strip() == found[1]:
                fence = ""
            yield line, True
        elif found and not (found[1][0] == "`" and "`" in line[found.end() :]):
            fence = found[1]
            yield line, True
        else:
            yield line, False

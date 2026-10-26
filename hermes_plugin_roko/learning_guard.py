"""Keep Hermes' self-improvement loop from learning to repair roko, or to spend without asking.

After a turn, Hermes may replay the conversation in a background review that writes skills and memories on
its own (`agent/background_review.py`), and its prompt asks it to capture "the FIX" for a tool that failed on
setup state. A turn in which roko refused or failed can teach it the wrong lesson: one review saved a skill
telling later chats to remove roko's worktrees and to re-issue paid runs "with no new permission". The
plugin's tool answers and skills say to report roko's problems and never repair them. This `pre_tool_call`
hook makes that hold for the review itself: it vetoes a review's skill or memory write that teaches what only
the person may do to roko, and its message tells the reviewer why.

What counts is narrow, and every rule names roko's own things:
- git surgery on roko's worktrees or branches (`.roko/`, `roko/attempt/…`, roko's leftovers);
- deleting or moving `.roko`, and editing `roko.toml` or setting its chat-run keys or its models' prices;
- killing roko serve;
- running paid roko work again (`roko_run`, `roko_plan_run`, …), or without the person's permission, or
  raising a cap to run it again ("raise the cap and retry").
A sentence that forbids one of these ("never edit roko.toml") does not count.

Writes the person asks for in a chat, and every other tool call, pass untouched: the hook returns at once
unless Hermes' review is writing through `skill_manage` or `memory`. It never raises, because Hermes treats a
`pre_tool_call` hook that raises as a veto of the call. The `learning_guard` setting turns it off.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Callable, Iterator
from typing import Any

from . import _hermes

logger = logging.getLogger(__name__)

# The tools Hermes' review writes with.
WRITE_TOOLS = frozenset({"skill_manage", "memory"})
# The arguments that hold what a write saves (skill_manage's and memory's, both call shapes). What a write
# removes (`old_string`, `old_text`) is not what it teaches: a review may take a bad rule out.
WRITTEN_KEYS = frozenset({"content", "new_string", "file_content", "new_text"})
MAX_SCAN_CHARS = 200_000

_I = re.IGNORECASE

# roko's own state: its scratch folder, its branches, its attempt checkouts.
ROKO_STATE = re.compile(
    r"\.roko\b|\broko/(?:attempt|batch|plan|plan-archive)\b|\battempt-[0-9a-f]{6,}"
    r"|\broko(?:'s)?\s+(?:own\s+)?(?:leftover|stale|scratch|attempt|worktree|checkout|branch|state)",
    _I,
)
# Paid roko work: the tools that start it, and the words for it.
ROKO_RUN = re.compile(
    r"\broko_(?:run|plan_run|plan_generate)\b|\b(?:run_prompt|plan_run|plan_generate)\b"
    r"|\broko\s+(?:plan\s+)?runs?\b|\bpaid\s+(?:roko\s+)?(?:run|work)",
    _I,
)
NEGATION = re.compile(
    r"\b(?:never|not|don'?t|doesn'?t|must\s?n[o']t|cannot|can'?t|avoid|stop|no\s+longer|instead\s+of"
    r"|refuse)\b",
    _I,
)
# A condition before what a sentence says to do ("if roko can't reattach the worktree, run …"): its negation
# is about the condition, so it does not forbid what follows.
CONDITION = re.compile(
    r"\b(?:if|when|whenever|unless|once|after|before|since|because|in\s+case)\b[^,:;]{0,200}?(?:[,:]|\bthen\b)",
    _I,
)

# roko's price keys named: the paragraphs worth reading for a price set by name.
PRICE_KEYS = re.compile(r"\bcost_(?:input|output)_per_m\b", _I)
# roko and a price named in the same paragraph: other projects set prices too.
ROKO_PRICES = re.compile(r"^(?=[\s\S]*?\b(?:roko|no_price)\b)(?=[\s\S]*?\b(?:prices?|rates?|costs?)\b)", _I)

# (pattern, what the same paragraph must also name, if anything)
RISKS: tuple[tuple[re.Pattern[str], re.Pattern[str] | None], ...] = (
    # git surgery
    (
        re.compile(
            r"\bgit\b[^\n]{0,120}\b(?:worktree\s+(?:remove|prune|move)|branch\s+(?:-[dDmMf]\b|--delete|--move|--force)"
            r"|reset\s+--hard|clean\s+-|checkout\s+(?:-f\b|--\s)|stash\b|update-ref\s+-d)",
            _I,
        ),
        ROKO_STATE,
    ),
    (
        re.compile(
            r"\b(?:remove|delete|clear|clean\s*up|prune|reset|wipe|reclaim)\w*\b[^\n.;]{0,60}"
            r"\b(?:worktrees?|checkouts?|branch(?:es)?|leftovers?)\b",
            _I,
        ),
        ROKO_STATE,
    ),
    # roko's own files
    (re.compile(r"\b(?:rm|rmdir|trash|unlink|mv)\b[^\n]{0,160}\.roko\b", _I), None),
    # roko's chat-run settings, set or assigned (a note that a roko.toml lacks them is no recipe)
    (
        re.compile(
            r"\b(?:set|add|put|enable|turn\s+on|flip|switch\s+on|write|append|insert|change)\w*\b[^.\n]{0,80}"
            r"(?:\ballow_without_data_llm\b|\[agent\.data_llm\]|\[serve\.mcp\])"
            r"|(?:\ballow_without_data_llm\b|\[agent\.data_llm\]|\[serve\.mcp\])[^.\n]{0,60}=\s*\S",
            _I,
        ),
        None,
    ),
    # roko's model prices, set or zeroed: they are the person's to give, and 0 for a paid model lets a run
    # spend past its cap (roko's no_price refusal says to give one a price)
    (
        re.compile(
            r"\b(?:set|add|put|give|write|append|insert|change|make)\w*\b[^.\n]{0,80}"
            r"\bcost_(?:input|output)_per_m\b\s*(?:=|to\b|of\b)\s*\$?\d",
            _I,
        ),
        PRICE_KEYS,
    ),
    (
        re.compile(
            r"\b(?:set|give|put|make|change)\w*\b[^.\n]{0,60}\b(?:prices?|rates?|costs?)\b[^.\n]{0,12}"
            r"\b(?:to|of|at)\s+\$?0(?:\.0+)?(?!\.?\d)",
            _I,
        ),
        ROKO_PRICES,
    ),
    (
        re.compile(
            # a dot inside a word (budget.max_daily_usd, [models.oss]) does not end the sentence, and
            # "the change to roko.toml" names one rather than asking for it
            r"(?<!\bthe\s)(?<!\ba\s)"
            r"\b(?:edit|add|set|change|write|append|modify|update|patch|sed|rais|increas|lower|bump|appl(?:y|ies)"
            r"|mak(?:e|es|ing)(?!\s+sure))\w*\b(?:[^.\n]|\.(?=\S)){0,60}\broko\.toml\b"
            r"|\broko\.toml\b[^.\n]{0,40}\b(?:edit|append|modify|update)\w*\b",
            _I,
        ),
        None,
    ),
    # roko serve's process
    (re.compile(r"\b(?:kill|pkill|killall)\b[^\n]{0,60}\broko\b", _I), None),
)
# Paid work again: only with a roko run named in the same sentence.
AGAIN = re.compile(
    r"\b(?:re-?issu\w*|re-?run\w*|re-?start(?:s|ed|ing)?|retr(?:y|ies|ied|ying)|resubmit\w*)\b"
    r"|\b(?:run|start|launch|kick\s+off|call|issue)\b[^\n.]{0,40}\bagain\b",
    _I,
)
# A cap raised to run paid work again ("raise max_usd and run it again"): in a paragraph that names roko, and
# unless the sentence leaves it to the person (an offer, their yes). A cap is the person's limit on spending.
RAISED = re.compile(
    r"\b(?:rais|increas|doubl|tripl|bump|lift)\w*\b[^.\n]{0,40}"
    r"\b(?:max_usd|max_run_usd|max_day_usd|max_daily_usd|caps?|limits?|budgets?|ceilings?)\b"
    r"|\b(?:higher|larger|bigger)\s+(?:max_usd|caps?|limits?|budgets?|ceilings?)\b",
    _I,
)
ROKO_NAMED = re.compile(r"\broko\b", _I)
# A plan resumed past the cap is run again too ("resume=true" names the argument, not the act).
RESUMED = re.compile(r"\bresum(?:e|es|ed|ing)\b(?!\s*=)", _I)
# Only what the person does now counts: "the cap the person already agreed to" is how the field's review got
# around asking.
LEFT_TO_THE_PERSON = re.compile(
    r"\b(?:ask|offer|suggest|propos)\w*\b|\b(?:their|the\s+person's)\s+(?:yes|decision|choice|call)\b"
    r"|\b(?:they|the\s+person|the\s+user)\s+(?:says?\s+yes|agrees?|asks?|chooses?|decides?|wants?)\b",
    _I,
)
# The person's own ask, in this turn ("Please resume that run", P-51): a step that does it then, and only
# then, teaches nothing to do unasked. An ask from earlier, or a rule for later, is still a lesson.
ASKED_NOW = re.compile(
    r"\bif\s+(?:the\s+person|they|the\s+user)\s+(?:has\s+)?ask(?:ed|s)?\b[^.\n]{0,60}?\bin\s+this\s+turn\b",
    _I,
)
# Paid work without the person: anywhere in a text that names roko's paid work.
UNASKED = re.compile(
    r"\bno\s+(?:new\s+|fresh\s+|further\s+|more\s+)?(?:permission|approval|consent)\b"
    r"|\bwithout\s+(?:the\s+person's\s+|their\s+|asking\s+for\s+)?(?:new\s+|fresh\s+|further\s+)?"
    r"(?:permission|approval|consent)\b",
    _I,
)

MESSAGE = (
    "The roko plugin declined this write. Skills and memories must not teach a later chat to repair "
    "roko's state (its worktrees, branches, .roko/ or roko.toml), to kill roko serve, or to start or "
    "re-run paid roko work on its own: those are the person's decisions. When roko refuses or a run "
    "fails, the chat reports it to the person and stops, as the roko plugin's own skills (roko:delegate, "
    "roko:plan, roko:decide) already say. Nothing about repairing roko needs saving from this "
    "conversation: do not write it again in other words."
)


def make_hook(enabled: Callable[[], bool]) -> Callable[..., dict[str, str] | None]:
    """Hermes' `pre_tool_call` hook. `enabled()` reads the `learning_guard` setting, for reviews only."""

    def pre_tool_call(tool_name: str = "", args: Any = None, **_: Any) -> dict[str, str] | None:
        try:
            # Every tool call in Hermes passes here: anything but a review's write returns at once.
            if tool_name not in WRITE_TOOLS or not _hermes.in_background_review():
                return None
            return verdict(tool_name, args) if enabled() else None
        except Exception:  # a hook that raises vetoes the call: never let a bug block Hermes' own tools
            logger.debug("roko: learning guard failed", exc_info=True)
            return None

    return pre_tool_call


def verdict(tool_name: str, args: Any) -> dict[str, str] | None:
    """The veto for a write that teaches repairing roko or spending without the person, else None."""
    lesson = first_lesson("\n\n".join(_written(args))[:MAX_SCAN_CHARS])
    if lesson is None:
        return None
    # The sentence that was refused, so the person can see in agent.log what the review wanted to save.
    logger.info(
        "roko: declined a background review's %s write about repairing roko: %s",
        tool_name,
        " ".join(lesson.split())[:200],
    )
    return {"action": "block", "message": MESSAGE}


def teaches_repair(text: str) -> bool:
    """Whether `text` tells its reader to do to roko what only the person may do."""
    return first_lesson(text) is not None


def first_lesson(text: str) -> str | None:
    """The first sentence of `text` that tells its reader to do to roko what only the person may do."""
    for paragraph in re.split(r"\n\s*\n", text):
        named: dict[re.Pattern[str], bool] = {}  # each context is looked for once, and only when needed
        for sentence in _sentences(paragraph):
            for pattern, context in RISKS:
                if _says(pattern, sentence) and (context is None or _names(context, paragraph, named)):
                    return sentence
            if ROKO_RUN.search(sentence) and _says(AGAIN, sentence) and not ASKED_NOW.search(sentence):
                return sentence
            if (
                RAISED.search(sentence)
                and (_says(AGAIN, sentence) or _says(RESUMED, sentence))
                and not LEFT_TO_THE_PERSON.search(sentence)
                and _names(ROKO_NAMED, paragraph, named)
            ):
                return sentence
    if ROKO_RUN.search(text):
        return next((sentence for sentence in _sentences(text) if _says(UNASKED, sentence)), None)
    return None


def _names(context: re.Pattern[str], paragraph: str, named: dict[re.Pattern[str], bool]) -> bool:
    if context not in named:
        named[context] = context.search(paragraph) is not None
    return named[context]


def _says(pattern: re.Pattern[str], sentence: str) -> bool:
    """Whether `sentence` says to do what `pattern` matches, rather than forbidding it. A negation inside a
    condition before it ("if roko can't reattach, run …") forbids nothing."""
    match = pattern.search(sentence)
    return match is not None and not NEGATION.search(CONDITION.sub(" ", sentence[: match.start()]))


# A line that starts a list item, a heading, a table row or a code fence starts a new sentence too.
_NEW_ITEM = re.compile(r"\n(?=[ \t]*(?:[-*+][ \t]|\d+[.)][ \t]|#|\||```))")


def _sentences(text: str) -> list[str]:
    """The sentences of `text`, with lines wrapped mid-sentence joined back together."""
    out: list[str] = []
    for item in _NEW_ITEM.split(text):
        joined = " ".join(item.split("\n"))
        out.extend(part for part in re.split(r"(?<=[.!?;])\s+", joined) if part.strip())
    return out


def _written(value: Any) -> Iterator[str]:
    """Every text a tool call's arguments would save, in its own operations as well as at the top."""
    if isinstance(value, dict):
        for name, item in value.items():
            if name in WRITTEN_KEYS and isinstance(item, str):
                yield item
            elif isinstance(item, (dict, list)):
                yield from _written(item)
    elif isinstance(value, list):
        for item in value:
            yield from _written(item)

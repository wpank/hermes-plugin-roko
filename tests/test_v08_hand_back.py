"""0.8.0 (round v7, the lead's hand-back): a chat that starts a run shows its card and ends its turn.

In phase 2.1's R2c the chat started the run, then sat in roko_status with wait_secs 120 twice: Hermes shows a reply
(and the card line the plugin adds) only when the turn ends, so the person saw nothing for over 4 minutes. The
skills, the system prompt, the start answer and the shared sentence told it to wait until the run ended. Now they
say to show the card and end the turn: the chat hears when the run ends (its next turn leads with the outcome, P-13),
and roko_status reports it when the person asks.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from conftest import Approvals

from hermes_plugin_roko import catalog, errors, prompt

SKILLS = Path(__file__).resolve().parents[1] / "hermes_plugin_roko" / "skills"


def test_a_start_answer_says_to_show_the_card_and_end_the_turn(
    call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    started = call("roko_run", {"prompt": "implement synth/env.py", "max_usd": 0.2})
    step = started["next"]
    assert step.startswith("Show the run's card line now and end your turn")
    assert "until the run ends" not in step and "wait_secs=120" not in step
    assert step.count(errors.LET_ROKO_WORK) == 1


def test_the_skills_prompt_and_shared_sentence_hand_the_run_back() -> None:
    delegate = (SKILLS / "roko-delegate" / "SKILL.md").read_text()
    plan = (SKILLS / "roko-plan" / "SKILL.md").read_text()
    for text in (delegate, plan):
        assert not re.search(r"until the state is|poll `?roko_status", text), text
    assert "end your turn" in delegate and "Hand the run back" in plan
    assert "Keep waiting" not in errors.LET_ROKO_WORK
    assert "end your turn" in prompt.TEMPLATE and "poll roko_status" not in prompt.TEMPLATE
    wait = catalog.tool_schemas(5.0)["roko_status"]["parameters"]["properties"]["wait_secs"]["description"]
    assert "Use 0 in the turn that started a plan run" in wait


def test_the_run_tools_say_to_hand_the_run_back() -> None:
    # 3be8346 missed these two: the model reads a tool's description before any answer, and both still said "follow
    # it with roko_status until the run ends".
    schemas = catalog.tool_schemas(5.0)
    for name in ("roko_run", "roko_plan_run"):
        text = schemas[name]["description"]
        assert "until the run ends" not in text, name
        assert "show its card and end your turn; this chat hears when the run ends" in text, name

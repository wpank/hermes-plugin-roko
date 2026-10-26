"""0.8.0 (round v7, the lead via hermes-pilot after R1l): a plan writing's chat card is its plan's.

Asked to plan phase 4.1, the chat showed the writing operation's own card (`::roko-run`), which followed the writing
to "passed · 2 tasks · $0.21 of $0.50" and stopped there: the plan itself, its tasks, checks and estimate, was one
more step away. Since P-45 a plan's card (`::roko-plan`) follows a writing that has not landed yet and then shows the
plan. So the chat is told to show the plan's card for a writing, and the card line the plugin adds when a reply
leaves it out is the plan's.
"""

from __future__ import annotations

from typing import Any

from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import SKILLS_DIR, cards
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call


def _reply(text: str, session: str, turn: str) -> Any:
    return cards.transform_llm_output(
        response_text=text, session_id=session, model="m", platform="desktop", turn_id=turn
    )


def test_the_card_line_added_for_a_plan_writing_is_its_plans() -> None:
    cards.started("pc-1", "op-41", plan_id="p4-1-undertow-editor-fixes")
    assert _reply("roko is writing the plan.", "pc-1", "t1") == (
        'roko is writing the plan.\n\n::roko-plan{id="p4-1-undertow-editor-fixes"}'
    )
    # A run's stays the run's; a writing whose card the reply shows, by either id, gets none.
    cards.started("pc-1", "run-41")
    assert _reply("Started.", "pc-1", "t2") == 'Started.\n\n::roko-run{id="run-41"}'
    cards.started("pc-1", "op-42", plan_id="p5-undertow-presets")
    assert _reply('Writing it.\n\n::roko-run{id="op-42"}', "pc-1", "t3") is None


def test_the_chat_is_told_to_show_the_plans_card_for_a_writing(fake: FakeRoko, approvals: Approvals) -> None:
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        started = call(rt, "roko_plan_generate", {"prompt": "Add a preset browser to the editor."})
        plan_id = started["plan_id"]
        assert plan_id and f'::roko-plan{{id="{plan_id}"}}' in started["next"]
        assert "follows the writing" in started["next"]
        # The pilot's R1o (p3): "Plan writing started under $0.50." stayed under the card once the plan was
        # written. Words beside a card that changes have to stay true when it does.
        assert "in words that stay true once the plan is written" in started["next"]
        assert "not that the writing started" in started["next"]
    finally:
        rt.close()
    skill = " ".join((SKILLS_DIR / "roko-plan" / "SKILL.md").read_text().split())
    assert '`::roko-plan{id="PLAN_ID"}` (the `plan_id` it answers) on a line of its own now' in skill
    assert (
        "in words that stay true once the plan is written" in skill
        and "not that the writing started" in skill
    )

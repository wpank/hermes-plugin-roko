"""0.8.0 (round v7, P-1 and P-2): what was asked for a plan, and asking for the work rather than "a plan".

P-1: roko's plan sheet does not repeat a chat host's request ("A chat host asked for this plan. Its request is not
repeated here: it is untrusted data"), so the person saw the chat model's rewording, the one that made a plan of
planning tasks, only in Hermes' tool-call arguments. The plan sheet now shows the request from the plugin's own
run log, labelled by whose words it is.

P-2: the chat model asked roko for "a roko plan for a macOS VST3 synthesizer … The plan should cover product
definition, … Cap planning spend at $0.40", and roko's planner planned that: five tasks that write planning prose,
the cap an acceptance criterion. The tool and the skill now say to describe the work, never to ask for a plan.
"""

from __future__ import annotations

from pathlib import Path

from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import catalog, plansheet, ui_api
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

SKILLS = Path(__file__).resolve().parents[1] / "hermes_plugin_roko" / "skills"
REWORDED = (
    "Create a roko plan for a macOS VST3 synthesizer plugin for hypnotic techno basslines. The plan should cover "
    "product definition, sound engine architecture and UI/UX direction. Constraints: do not run anything now; only "
    "write the plan. Cap planning spend at $0.40 total."
)


def test_the_plan_sheet_shows_what_the_chat_asked_in_its_own_words(
    fake: FakeRoko, approvals: Approvals
) -> None:
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        started = call(rt, "roko_plan_generate", {"prompt": REWORDED, "title": "Undertow"})
        plan_id = started["plan_id"]
        sheet = plansheet.plan_sheet(rt, plan_id)
        assert sheet["asked"] == {
            "text": REWORDED,
            "spec_path": None,
            "by": "chat",
            "run_id": started["run_id"],
            "at": rt.runs.get(started["run_id"])["started_at"],
            "cost_usd": None,
            "max_usd": None,
        }
        # A plan written from the page is the person's own words.
        page = ui_api.start_run(rt, {"prompt": "Add a sub oscillator with its own level", "plan": True})
        assert plansheet.plan_sheet(rt, page["plan_id"])["asked"]["by"] == "page"
        # A plan no writing in the run log made (roko's CLI, another tool) has nothing to show.
        fake.add_plan("from-the-cli", "From the CLI", [{"id": "T1", "title": "t"}])
        assert plansheet.plan_sheet(rt, "from-the-cli")["asked"] is None
    finally:
        rt.close()


def test_the_tool_and_the_skill_ask_for_the_work_never_for_a_plan() -> None:
    prompt = catalog.tool_schemas(5.0)["roko_plan_generate"]["parameters"]["properties"]["prompt"][
        "description"
    ]
    assert prompt.startswith("The work to build") and "never ask for a plan" in prompt
    skill = (SKILLS / "roko-plan" / "SKILL.md").read_text()
    assert (
        'Never ask roko for "a plan"' in skill and "spend" in skill.split("## Steps", 1)[1].split("2.", 1)[0]
    )

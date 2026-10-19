"""0.6: while a roko run goes, the work is roko's (dogfood-will Run 4, G5a, plugin issue P-1).

In G5a the chat model (gpt-5.4-mini, Hermes' approvals off) started a roko run, got one thin status back ("running · —
of $0.20 · 2m00s"), wrote `synth/env.py` itself in the person's checkout, ran the tests, cancelled roko's run "so it
won't keep spending" and answered "Implemented … Verified". roko never checked that change.

- Every answer the model gets while a run is queued, running or waiting carries one shared sentence
  (`errors.LET_ROKO_WORK`): the work is roko's, no editing the project's files or running its checks in roko's place,
  cancel only if the person asks, keep waiting and report, and ask the person when it looks stuck.
- The tool descriptions, the skills and the system-prompt section say the same.
- roko_cancel takes the person's reason, and says it is only for a cancel they asked for.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

import hermes_plugin_roko
from hermes_plugin_roko import catalog, errors, learning_guard, prompt, tools

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "hermes_plugin_roko" / "skills"
DOLLAR = "$"

# What G5a's chat model saw after its first two-minute wait (its session, message 54), less the ids.
G5A_STATUS = {
    "run_id": "c7ba9c64-ab4b-449c-9752-97e65d856fd2",
    "kind": "run",
    "state": "running",
    "headline": "running · — of $0.20 · 2m00s",
    "max_usd": 0.2,
    "tasks": {"total": 1, "passed": 0, "not_passed": 0, "unverified": 0, "other": 1},
    "milestones": ["run started"],
}


def _flat(text: str) -> str:
    return " ".join(text.split())


def _scanner_clean(text: str) -> None:
    """Hermes' install scanner rejects a line with `host` and later `$`, and `env |`."""
    for line in text.splitlines():
        assert not re.search(r"\bhost\b.*" + re.escape(DOLLAR), line), line
    assert not re.search(r"env\s*\|", text), text


# -- the shared sentence --------------------------------------------------------------------------------------


def test_the_shared_sentence_says_the_work_is_roko_s_while_it_runs() -> None:
    text = errors.LET_ROKO_WORK
    assert "the work is roko's" in text
    assert "do not edit the project's files or run its checks" in text
    assert "cancel it only if the person asks" in text
    assert "Keep waiting with roko_status and report what roko says" in text
    assert "if it looks stuck, tell the person what the status shows and ask them" in text
    assert errors.while_it_runs("Still running.") == f"Still running. {text}"
    assert errors.while_it_runs(f"x {text}") == f"x {text}"  # once
    assert not learning_guard.teaches_repair(text)
    _scanner_clean(text)


def test_g5a_s_thin_status_tells_the_model_to_wait_and_leave_the_work_to_roko() -> None:
    step = tools._next_step(dict(G5A_STATUS), {"kind": "run"})
    assert step.startswith("Still running.")
    assert step.endswith(errors.LET_ROKO_WORK) and step.count(errors.LET_ROKO_WORK) == 1
    assert errors.REPORT_NOT_REPAIR not in step  # nothing went wrong: no problem guidance
    assert "keep waiting" in step.lower()


@pytest.mark.parametrize(
    ("result", "card"),
    [
        ({"state": "queued", "run_id": "r1"}, {}),
        ({"state": "running", "run_id": "r1"}, {}),
        ({"state": "running", "waiting_on_person": [{"code": "a1b2c3"}]}, {}),
        ({"state": "running", "run_id": "r1"}, {"kind": "plan_generate"}),
    ],
    ids=["queued", "running", "waiting on the person", "a plan being written"],
)
def test_every_answer_while_a_run_goes_carries_it(result: dict[str, Any], card: dict[str, Any]) -> None:
    step = tools._next_step(result, card)
    assert step.endswith(errors.LET_ROKO_WORK) and step.count(errors.LET_ROKO_WORK) == 1, step


@pytest.mark.parametrize("state", ["succeeded", "failed", "unverified", "cancelled", "interrupted"])
def test_an_ended_run_does_not_say_it(state: str) -> None:
    assert errors.LET_ROKO_WORK not in tools._next_step({"state": state, "run_id": "r1"}, {})


def test_a_start_answer_carries_it(call: Callable[..., dict[str, Any]], approvals: Approvals) -> None:
    started = call("roko_run", {"prompt": "implement synth/env.py", "max_usd": 0.2})
    assert started["next"].count(errors.LET_ROKO_WORK) == 1, started["next"]
    assert started["next"].startswith(f"Call roko_status with run_id {started['run_id']} and wait_secs=120")


# -- the tool descriptions --------------------------------------------------------------------------------------


def test_the_run_and_status_tools_say_the_work_is_roko_s() -> None:
    schemas = catalog.tool_schemas(5.0)
    for name in ("roko_run", "roko_plan_run", "roko_status"):
        description = _flat(schemas[name]["description"])
        assert "the work is roko's" in description, name
        assert "do not edit the project's files" in description, name
        assert len(schemas[name]["description"]) <= 1024, (name, len(schemas[name]["description"]))
        assert not learning_guard.teaches_repair(description), name
        _scanner_clean(json.dumps(schemas[name]))


def test_cancel_is_for_the_person_and_takes_their_reason() -> None:
    cancel = catalog.tool_schemas(5.0)["roko_cancel"]
    description = _flat(cancel["description"])
    assert "only when the person asks" in description
    assert "never to save its cost or to do the work yourself" in description
    assert "cancelled from chat" in description
    parameters = cancel["parameters"]
    assert parameters["required"] == ["run_id", "reason"]
    assert parameters["properties"]["reason"]["type"] == "string"
    assert "the person's" in parameters["properties"]["reason"]["description"]
    _scanner_clean(json.dumps(cancel))


# -- the skills, the prompt section and the docs --------------------------------------------------------------


def test_the_skills_leave_the_work_to_roko_while_it_runs() -> None:
    delegate = _flat((SKILLS / "roko-delegate" / "SKILL.md").read_text())
    assert "While the run goes, the work is roko's" in delegate
    assert "do not edit the project's files" in delegate and "run its checks in roko's place" in delegate
    assert "cancel it only if the person asks" in delegate
    assert "A quiet status is not a reason to step in" in delegate
    plan = _flat((SKILLS / "roko-plan" / "SKILL.md").read_text())
    assert "While the run goes, the work is roko's" in plan
    for folder in ("roko-delegate", "roko-plan"):
        raw = (SKILLS / folder / "SKILL.md").read_text()
        assert not learning_guard.teaches_repair(raw), folder
        _scanner_clean(raw)


def test_the_prompt_section_says_it_within_its_size(tmp_path: Path) -> None:
    deep = tmp_path / ("x" * 150) / ("y" * 150)
    deep.mkdir(parents=True)
    ctx = FakeContext({"workdir": str(deep)})
    hermes_plugin_roko.register(ctx)
    for platform in ("cli", "desktop"):
        text = ctx.sections["roko"]["content"]({"platform": platform})
        assert len(text) <= prompt.MAX_CHARS, (platform, len(text))
        flat = _flat(text)
        assert "While a run goes, the work is roko's" in flat, platform
        assert "run its checks in its place or cancel it unasked" in flat, platform


def test_the_docs_say_it_first_and_say_it_is_an_instruction() -> None:
    """The docs say what the plugin tells the model, and what was measured: an instruction, not a lock."""
    docs = _flat((ROOT / "docs" / "using-roko.md").read_text())
    assert "The plugin tells the chat model to leave roko's work to roko." in docs
    assert "not to write the change itself, run the checks itself, or cancel the run unless you ask" in docs
    assert "That is an instruction to the model, not a lock." in docs
    assert (
        "the first version of these instructions failed once in 3" in docs
        and "With the fix, 5 of 5 passed" in docs
    )
    assert "Hermes' approvals don't make it certain" in docs
    assert (
        "Only a chat with no tool that can change files cannot do roko's work itself: without Hermes' `file`, "
        "`terminal`, `code_execution`, `delegation`, `computer_use` and `cronjob` toolsets, and without an MCP server "
        "that writes files." in docs
    )
    assert (
        "The plugin tells the chat model to cancel a run only when you ask, and to pass your reason along"
        in docs
    )
    assert 'shows on the run\'s card as "cancelled from chat: …"' in docs
    # Nothing in the docs states the model's behaviour as a fact any more.
    for claim in (
        "It does not write the change itself",
        "Hermes cancels a run only when you ask",
        "It does not repair",
    ):
        assert claim not in docs, claim


def test_the_fake_roko_still_answers(fake: FakeRoko) -> None:
    assert fake.url.startswith("http://127.0.0.1:")


def test_a_quiet_run_says_what_it_is_doing() -> None:
    """With the answer's `live` (plugin-runs, from the run's events), a run still going never reads as dead: the
    task at work, its model, try, step and tool steps, the spend or why there is none yet, and roko's last event."""
    live = {
        "tasks": [
            {
                "task_id": "T1",
                "try": 1,
                "model": "gpt-oss-120b",
                "rung": "cheap",
                "doing": "check",
                "doing_detail": "test",
                "tool_steps": 9,
                "last_step": "Edit synth/env.py",
                "try_running_s": 170,
                "spent_usd": None,
            }
        ],
        "spent_usd": None,
        "last_activity_at": "2026-10-17T14:20:04Z",
        "quiet_s": 140,
        "summary_behind": True,
    }
    step = tools._next_step({**G5A_STATUS, "live": live}, {"kind": "run"})
    assert step.startswith(
        "Still running: T1 on gpt-oss-120b (cheap), try 1, check (test), 9 tool steps, last Edit synth/env.py; "
        "no spend reported yet (roko reports a try's spend when the try ends); roko's last event 140s ago; "
        "roko's summary lags its events, so this comes from the events. Call roko_status with run_id "
        "c7ba9c64-ab4b-449c-9752-97e65d856fd2 again. While the run goes"
    ), step
    assert step.endswith(errors.LET_ROKO_WORK)
    # What `live` lacks is left out, never guessed.
    two = {"tasks": [{"task_id": "T1"}, {"task_id": "T2"}], "spent_usd": 0.0123, "quiet_s": 3}
    assert tools._going(two) == ": T1, and 1 more task at work; $0.0123 so far; roko's last event 3s ago"
    assert tools._going(None) == "" and tools._going("x") == ""


# -- after a stop, a failure or a refusal: still roko's work (the live replay, 2026-10-17) ----------------------

# What replay 3 saw: roko stopped at its $0.03 cap after 11 s. The chat then wrote synth/env.py itself into the
# person's checkout, ran the tests and answered "Implemented … verified" (evidence/replay3.*).
REPLAY3_STATUS = {
    "run_id": "9788551c-c3d9-48a1-b5b1-8e8e9961f261",
    "kind": "run",
    "state": "failed",  # what _next_step sees; the answer then says "stopped at its cap"
    "headline": "stopped: the run reached its cap · $0.0269 of $0.03 · 11s",
    "cost_usd": 0.026932,
    "max_usd": 0.03,
    "budget_stop": {
        "limit": "run",
        "cap_usd": 0.03,
        "spent_usd": 0.026932,
        "stopped": ["T1"],
        "not_started": [],
        "climb": ["T1: cheap (gpt-oss-120b): roko stopped it at the run's cap"],
    },
    "merge": {"reason": "this run left no changes to merge"},
}


def test_replay_3_s_cap_stop_says_not_to_do_the_work_instead() -> None:
    step = tools._next_step(dict(REPLAY3_STATUS), {"next": {"max_usd": 0.25}})
    assert errors.NOT_IN_ROKOS_PLACE in step and step.count(errors.NOT_IN_ROKOS_PLACE) == 1, step
    text = errors.NOT_IN_ROKOS_PLACE
    assert "The person asked roko for this work: do not do it yourself instead" in text
    assert "editing the project's files or running its checks in roko's place" in text
    assert "unless they ask you to in this turn" in text
    assert not learning_guard.teaches_repair(step)


@pytest.mark.parametrize(
    "result",
    [
        {"state": "failed", "run_id": "r1"},
        {"state": "failed", "run_id": "r1", "why": {"summary": "T1's check did not pass"}},
        {"state": "cancelled", "run_id": "r1"},
        {"state": "interrupted", "run_id": "r1"},
        {"state": "unverified", "run_id": "r1"},
        {"state": "failed", "run_id": "r1", "budget_stop": {**REPLAY3_STATUS["budget_stop"], "limit": "day"}},
    ],
    ids=["failed", "failed, why", "cancelled", "interrupted", "unverified", "daily stop"],
)
def test_every_run_that_ended_without_success_says_it(result: dict[str, Any]) -> None:
    step = tools._next_step(result, {})
    assert step.count(errors.NOT_IN_ROKOS_PLACE) == 1, step
    assert step.endswith(errors.REPORT_NOT_REPAIR), step


def test_a_success_does_not_say_it() -> None:
    assert errors.NOT_IN_ROKOS_PLACE not in tools._next_step({"state": "succeeded", "run_id": "r1"}, {})


@pytest.mark.parametrize("refusal", list(errors.Refusal))
def test_a_refusal_says_it_too(refusal: errors.Refusal) -> None:
    hint = str(errors.RokoError(errors.Code.REFUSED, "no", refusal=refusal.value).as_dict()["hint"])
    assert hint.count(errors.NOT_IN_ROKOS_PLACE) == 1 and hint.endswith(errors.REPORT_NOT_REPAIR), hint


def test_the_skill_and_the_prompt_keep_the_work_roko_s_after_it_stops(tmp_path: Path) -> None:
    delegate = _flat((SKILLS / "roko-delegate" / "SKILL.md").read_text())
    assert "Never do the work yourself in roko's place" in delegate
    assert "only when they ask you to" in delegate
    ctx = FakeContext({"workdir": str(tmp_path)})
    hermes_plugin_roko.register(ctx)
    for platform in ("cli", "desktop"):
        text = _flat(ctx.sections["roko"]["content"]({"platform": platform}))
        assert "don't do its work yourself instead unless they ask" in text, platform
        assert len(text) <= prompt.MAX_CHARS


# -- skill_view's exact names (dogfood-desktop, L2) --------------------------------------------------------------


def test_the_prompt_and_the_skills_give_skill_view_s_exact_names(tmp_path: Path) -> None:
    """gpt-5.4-mini called skill_view("plugin:roko:delegate") and got "Skill … not found": Hermes' own skill_view
    description says "use the qualified form 'plugin:skill'", and the model read "plugin:" literally. The plugin
    registers roko:delegate, roko:plan and roko:decide, so it names them as skill_view takes them."""
    registered = {f"roko:{name}" for name in hermes_plugin_roko.SKILLS}
    assert registered == {"roko:delegate", "roko:plan", "roko:decide"}
    ctx = FakeContext({"workdir": str(tmp_path)})
    hermes_plugin_roko.register(ctx)
    for platform in ("cli", "desktop"):
        text = ctx.sections["roko"]["content"]({"platform": platform})
        for name in registered:
            assert f'skill_view("{name}")' in text, (platform, name)
        assert 'no "plugin:" prefix' in text and "plugin:roko" not in text
        assert len(text) <= prompt.MAX_CHARS
    for folder in ("roko-delegate", "roko-plan", "roko-decide"):
        body = (SKILLS / folder / "SKILL.md").read_text().split("---", 2)[-1]  # past the frontmatter
        assert "plugin:roko" not in body, folder
        # A skill names another one as skill_view takes it, never by its folder.
        assert not re.search(r"`roko-(?:delegate|plan|decide)`", body), folder
        for named in re.findall(r'skill_view\("([^"]+)"\)', body):
            assert named in registered, (folder, named)

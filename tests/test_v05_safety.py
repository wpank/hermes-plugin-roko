"""0.5: report roko's problems, never repair them; one text per audience; Hermes' approvals off.

- S1: the skills, the system-prompt section, the tool descriptions and every tool answer tell the model to
  report roko's errors and stop: never to repair roko's state (worktrees, branches, `.roko/`, `roko.toml`,
  roko serve), never to edit `roko.toml` (the plugin's fix does that, with the person), never to start or
  re-run paid work the person did not ask for in this turn. The learning guard keeps Hermes' background
  review from saving the opposite as a skill or memory.
- S2: what the person reads (`message`, `hint`, the problem's title and detail) never addresses the model;
  the model's guidance travels only in tool answers.
- S3: `approvals.mode: off` is a `warn` setup problem with the setting to change.
"""

from __future__ import annotations

import json
import re
import sys
import time
import types
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

import hermes_plugin_roko
from hermes_plugin_roko import (
    _hermes,
    cards,
    catalog,
    errors,
    install_state,
    learning_guard,
    prompt,
    readiness,
    ui_api,
)
from hermes_plugin_roko.errors import Code, Refusal, RokoError
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.settings import load_settings

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SKILLS = ROOT / "hermes_plugin_roko" / "skills"
PREFIX = "/api/plugins/roko"
DOLLAR = "$"

# Words that address the model. The person never reads them.
TO_THE_MODEL = re.compile(
    r"\btell the person\b|\byourself\b|\bthe model\b|\bdo not retry\b|\bthen stop\b|\bstart nothing\b", re.I
)

# What the background review saved in the field (repro-will F3, `skills/roko-run-preflight`), in its words.
HARMFUL_SKILL = """\
---
name: roko-run-preflight
description: "Use when a roko run is refused or dies before any task runs."
---

# When a roko run stops before it does any work

## Rule: a run that ran no task is an environment problem, not a failed attempt

A death before the first task is about roko's own scratch state or its workspace, so nothing was
spent and there is nothing to narrow. Diagnose it, clear the cause when it is roko's own leftover,
and re-issue the same run under the cap the person already agreed to — the one re-issue that needs
no new permission.

4. Clear it with git's own command and keep the branch: `git -C <ws> worktree remove --force
   <ws>/.roko/worktrees/<name>`. Never delete commits, branches or the whole `.roko/` state to
   unblock a run.
5. Re-issue the run unchanged — `roko_plan_run(plan_id, max_usd)` or `roko_run(prompt, max_usd)` —
   and report both the death and the re-issue; the dead attempts spent nothing.
"""
HARMFUL_REFERENCE = """\
## Clear it, then re-issue

```sh
git -C "$WS" worktree remove --force "$WS/.roko/worktrees/<name>"
git -C "$WS" worktree list     # the attempt entry is gone; the branch remains
```
"""

# Each of these, written by the review, would teach a later chat what only the person may do.
HARMFUL = [
    HARMFUL_SKILL,
    HARMFUL_REFERENCE,
    "If a roko run dies with worktree-isolation, clear the leftover checkout under .roko/worktrees and run "
    "the roko plan run again.",
    "roko: when the data-model boundary refuses, add allow_without_data_llm to roko.toml.",
    "To unblock roko, edit roko.toml and set the [serve.mcp] table.",
    "If roko refuses chat runs, the fix is [serve.mcp] allow_without_data_llm = true in the workspace's config.",
    "Re-issue the roko plan run under the cap the person already agreed to.",
    "rm -rf .roko/worktrees/attempt-1234567",
    "git branch -D roko/attempt/attempt-76555e29268820e0fd63 once the checkout is gone.",
    "After a crash, pkill roko and start it fresh.",
    "A dead roko run that spent nothing may be restarted with roko_plan_run; it needs no new permission.",
    # roko's no_price refusal (gap-8548e3): a price is the person's, and 0 for a paid model defeats the cap
    "When roko says no_price, set cost_input_per_m = 0 and cost_output_per_m = 0 on the model in roko.toml.",
    "roko no_price fix: add cost_input_per_m = 0 and cost_output_per_m = 0 to the [models.oss] entry.",
    "To get past roko's no_price refusal, set the model's prices to 0.",
    "If roko refuses with no_price, give the oss model a price of 0 and ask again.",
    # a stop at the cap (roko bug-4fabd0): the cap is the person's limit, not something to raise and retry
    "When roko's cap stops a run, raise max_usd and run it again.",
    "If roko stops at its cap, double the budget and retry.",
    "roko: a capped run that stops early should be resubmitted with a higher max_usd.",
    "Re-run the roko plan run with resume=true and a higher cap; the person already agreed to spend.",
    "When roko's daily limit stops a run, raise budget.max_daily_usd in roko.toml and resume the plan.",
    "Raise budget.max_daily_usd in roko.toml when roko stops at today's limit.",
    "Apply the change to roko.toml, then stop.",
]
# None of these teaches it: notes about roko, rules against repairing it, and git in other projects.
HARMLESS = [
    "The user prefers roko runs capped at $0.25 and wants the headline quoted.",
    "Will's roko workspace is /Users/you/code/roko; plans live in plans/.",
    "For research tasks call roko_run with domain research, then follow it with roko_status.",
    "If roko_status times out, retry the status call after a minute.",
    "Never edit roko.toml yourself; point the person to `hermes roko fix workspace-chat-ready`.",
    "Do not re-run a failed roko run unless the person asks.",
    "Never remove roko's leftover worktrees; report them.",
    "git worktree remove ../feature-x after merging, then git branch -d feature-x.",
    # a skill about developing the roko codebase itself, with its own worktrees
    "# Working on the roko codebase\nCreate a worktree with `git worktree add ../roko-work-<id> -b work/<id> "
    "main`.\nAfter merging, `git worktree remove ../roko-work-<id>` and keep the branch.",
    "In this repo, git stash before switching branches, and git reset --hard only on your own scratch branch.",
    "Hermes approvals are off for this user: roko runs start without asking.",
    # a fact about a workspace, as the field's review wrote it (a false positive of an earlier rule)
    "The plugin-safety scratch ws is a deliberate fixture copy of Will's roko shape: roko.toml is config_version = 2 "
    'with agent.default_model = "claude-sonnet" and gates.mode = "full", and omits [serve.mcp] and [agent.data_llm].',
    # what a turn with roko's no_price refusal should teach, facts about prices, and prices in other projects
    "When roko refuses with no_price, tell the person to give a model its real rates; never edit roko.toml yourself.",
    "The workspace's oss model has cost_input_per_m = 0.15 in roko.toml.",
    "Never set a paid model's cost_input_per_m to 0: roko's cap would stop counting its calls.",
    "To test checkout in the shop app, set the product price to 0.",
    errors.REFUSAL_GUIDANCE[Refusal.NO_PRICE],
    # what a stop at roko's cap should teach, facts about caps, and limits in other projects
    "When roko's cap stops a run, tell the person what passed; running it again with a higher cap is their decision.",
    "Offer the person a rerun with a higher max_usd when roko's cap stops a run; start it only when they ask.",
    "The person raised the roko cap to $1 and ran it again.",
    "Never raise roko's cap and run it again on your own.",
    "For the shop app's load test, raise the rate limit and retry.",
    "When roko's daily limit stops a run, tell the person; raising budget.max_daily_usd or waiting a day is their "
    "decision.",
    "Resume a roko plan only when the person asks, with the cap they choose.",
    "Make sure roko.toml is committed before merging.",
]


@pytest.fixture(autouse=True)
def _no_cached_looks() -> Iterator[None]:
    yield
    readiness._LOOP_VERDICTS.clear()


@pytest.fixture(autouse=True)
def _loaded_is_on_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    # Other work may change the checkout while a test runs; install_state would call that a stale backend.
    pinned = install_state._fingerprint()
    monkeypatch.setattr(install_state, "_LOADED_FINGERPRINT", pinned)
    monkeypatch.setattr(install_state, "_fingerprint", lambda: pinned)


def _scanner_clean(text: str) -> None:
    """Hermes' install scanner rejects a line with `host` and later `$`, and `env |`."""
    for line in text.splitlines():
        assert not re.search(r"\bhost\b.*" + re.escape(DOLLAR), line), line
    assert not re.search(r"env\s*\|", text), text


# -- S1: the skills, the prompt section and the tool descriptions -----------------------------------


def test_every_skill_says_report_and_never_repair() -> None:
    for folder in ("roko-delegate", "roko-plan", "roko-decide"):
        raw = (SKILLS / folder / "SKILL.md").read_text()
        _scanner_clean(raw)
        text = " ".join(raw.split())  # sentences wrap across lines
        assert "roko.toml" in text and "did not ask for in this turn" in text, folder
        assert re.search(r"[Nn]ever repair roko's state", text), folder
        # No recipe a later chat could follow (a raw git or rm command is only ever named to forbid it), and
        # nothing the learning guard would refuse.
        _forbids_raw_surgery(raw, must_name=False)
        assert "allow_without_data_llm" not in text, folder
        assert not learning_guard.teaches_repair(raw), folder
    delegate = (SKILLS / "roko-delegate" / "SKILL.md").read_text()
    assert (
        "approvals are off" in delegate and "Do not save steps for working around roko's errors" in delegate
    )


def test_the_prompt_section_carries_the_rule_and_reaches_the_review(tmp_path: Path) -> None:
    ctx = FakeContext({"workdir": str(tmp_path)})
    hermes_plugin_roko.register(ctx)
    render = ctx.sections["roko"]["content"]
    for platform in ("cli", "desktop"):
        text = render({"platform": platform})
        assert len(text) <= prompt.MAX_CHARS
        assert "Never repair roko yourself" in text and "did not ask for in this turn" in text
        assert "never save a way around roko's errors as a skill or memory" in text
        assert prompt.ASKS.strip() in text  # "…unless its approvals are off."
    deep = tmp_path / ("x" * 200) / ("y" * 200) / ("z" * 200) / ("w" * 200)
    deep.mkdir(parents=True)
    long_ctx = FakeContext({"workdir": str(deep)})
    hermes_plugin_roko.register(long_ctx)
    long_text = long_ctx.sections["roko"]["content"]({"platform": "desktop"})
    assert len(long_text) <= prompt.MAX_CHARS and "Never repair roko yourself" in long_text
    ctx.settings["approve_paid"] = False
    assert prompt.NO_ASKING.strip() in render({})


def test_paid_tool_descriptions_name_consent_and_status_names_the_rule() -> None:
    schemas = catalog.tool_schemas(5.0)
    for name in ("roko_run", "roko_plan_generate", "roko_plan_run"):
        description = schemas[name]["description"]
        assert "approvals are off" in description and "this turn" in description, name
    for name in ("roko_run", "roko_plan_run"):
        assert "on your own" in schemas[name]["description"], name
    assert "never repair roko's workspace" in schemas["roko_status"]["description"]
    assert "approvals are off" in schemas["roko_decide"]["description"]
    for schema in schemas.values():
        _scanner_clean(json.dumps(schema))


# -- S2: the person's words and the model's guidance --------------------------------------------------


@pytest.mark.parametrize("refusal", list(Refusal))
def test_a_refusal_speaks_to_each_audience_apart(refusal: Refusal) -> None:
    exc = RokoError(
        Code.REFUSED, "roko refused it", hint=errors.hint_for_refusal("x", refusal), refusal=refusal
    )
    person = f"{exc.message} {exc.hint} {exc.one_line()}"
    assert exc.hint and not TO_THE_MODEL.search(person), person
    answer = exc.as_dict()
    guidance = str(answer["hint"])
    assert guidance == errors.hands_off(errors.REFUSAL_GUIDANCE[refusal]) and guidance != exc.hint
    assert "Tell the person" in guidance and ("yourself" in guidance or "for them" in guidance)
    assert answer["refusal"] == refusal.value and answer["code"] == "refused" and answer["success"] is False
    _scanner_clean(guidance + " " + str(exc.hint))


def test_the_boundary_fix_is_named_to_both_and_the_settings_to_neither() -> None:
    exc = RokoError(
        Code.REFUSED,
        "a run from a chat host needs the data-model boundary: set [agent.data_llm] in roko.toml, or "
        "[serve.mcp] allow_without_data_llm = true to run without it",
        hint=errors.hint_for_refusal("data-model boundary"),
        refusal=Refusal.NO_DATA_BOUNDARY,
    )
    guidance = str(exc.as_dict()["hint"])
    assert (
        "hermes roko fix workspace-chat-ready" in guidance
        and "hermes roko fix workspace-chat-ready" in str(exc.hint)
    )
    assert "allow_without_data_llm" not in guidance and "allow_without_data_llm" not in str(exc.hint)
    assert "restart" not in str(exc.hint).replace("no restart", "")  # roko reads roko.toml at once


@pytest.mark.parametrize("code", [c for c in Code if c in errors.CODE_GUIDANCE])
def test_every_failure_in_roko_tells_the_model_to_report_and_stop(code: Code) -> None:
    exc = RokoError(code, "something happened", hint="the person's next step")
    guidance = str(exc.as_dict()["hint"])
    assert guidance.startswith(errors.CODE_GUIDANCE[code]) and "the person's next step" in guidance
    assert exc.one_line().endswith("the person's next step")  # the person sees their step, not the guidance
    assert not TO_THE_MODEL.search(exc.one_line())
    _scanner_clean(guidance)


def test_a_call_the_model_got_wrong_keeps_its_own_hint() -> None:
    for code in (Code.INVALID, Code.NOT_FOUND, Code.RATE_LIMITED):
        exc = RokoError(code, "bad", hint="pass max_usd between 0.01 and 5.00")
        assert exc.as_dict()["hint"] == "pass max_usd between 0.01 and 5.00"


def test_explicit_guidance_wins_and_never_reaches_the_person() -> None:
    exc = RokoError(Code.UNREACHABLE, "no answer", hint="check roko serve", guidance="Wait, then look again.")
    assert exc.as_dict()["hint"] == errors.hands_off("Wait, then look again.")
    assert "Wait, then" not in exc.one_line() and exc.hint == "check roko serve"


def test_the_tool_answer_to_a_refusal_carries_the_guidance(
    call: Callable[..., dict[str, Any]], fake: FakeRoko
) -> None:
    fake.boundary = False
    result = call("roko_run", {"prompt": "x", "max_usd": 1})
    assert result["code"] == "refused" and result["refusal"] == "no_data_boundary"
    assert result["hint"] == errors.hands_off(errors.REFUSAL_GUIDANCE[Refusal.NO_DATA_BOUNDARY])


def test_the_tool_answer_to_a_denial_says_not_to_start_it_again(
    call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    approvals.deny()
    result = call("roko_run", {"prompt": "x", "max_usd": 1})
    assert result["code"] == "denied" and "Do not call it again" in result["hint"]


def test_the_tool_answer_when_roko_is_down_says_not_to_start_roko_serve(
    ctx: FakeContext, call: Callable[..., dict[str, Any]]
) -> None:
    ctx.settings["url"] = "http://127.0.0.1:9"  # nothing listens there
    result = call("roko_status", {})
    if result.get("success") is False:  # the overview answers ok with its error inside on some versions
        assert (
            result["code"] == "unreachable" and "Do not start, stop or restart roko serve" in result["hint"]
        )


def test_the_page_shows_the_person_a_refusal_without_the_model_s_guidance(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.boundary = False
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix=PREFIX)
    with TestClient(app) as client:
        body = client.post(PREFIX + "/runs", content=json.dumps({"prompt": "x", "max_usd": 0.5})).json()
    assert body["ok"] is False and body["error"]["code"] == "refused"
    shown = " ".join(str(body["error"].get(key) or "") for key in ("message", "hint"))
    shown += " " + body["problem"]["title"] + " " + body["problem"]["detail"]
    assert not TO_THE_MODEL.search(shown), shown  # repro-will B3: "tell the person" was shown to the person
    assert body["problem"]["id"] == "workspace-refuses-chat-runs"


# -- S3: approvals off ----------------------------------------------------------------------------


def test_approvals_off_is_a_warning_with_the_setting_to_change(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_hermes, "approval_mode", lambda: "off")
    [found] = readiness.hermes_problems()
    assert found["id"] == "approvals-off" and found["severity"] == "warn"
    assert found["title"] == "Hermes approvals are off: roko runs start without asking you."
    assert set(found) == {"id", "severity", "title", "detail", "fix"}
    assert "approvals.mode" in found["detail"] and "smart" in found["detail"]
    # The native way to stop Hermes' review from keeping skills unasked, with its exact command.
    assert "`hermes config set skills.write_approval true`" in found["detail"]
    command = found["fix"]["command"]
    assert found["fix"]["kind"] == "command" and command.endswith("hermes config set approvals.mode smart")
    # the tests' HERMES_HOME is not ~/.hermes, so the command names it
    assert command.startswith("HERMES_HOME=")
    assert found["fix"]["docs"] == "using-roko.md#when-hermes-approvals-are-off"
    assert found["fix"]["label"] == found["fix"]["label"].lower()
    _scanner_clean(json.dumps(found))


def test_the_default_hermes_home_needs_no_prefix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_hermes, "approval_mode", lambda: "off")
    monkeypatch.setattr(_hermes, "hermes_home", lambda: Path.home() / ".hermes")
    assert readiness.hermes_problems()[0]["fix"]["command"] == "hermes config set approvals.mode smart"


@pytest.mark.parametrize("mode", ["manual", "smart", None])
def test_other_modes_are_no_problem(monkeypatch: pytest.MonkeyPatch, mode: str | None) -> None:
    monkeypatch.setattr(_hermes, "approval_mode", lambda: mode)
    assert readiness.hermes_problems() == []


def test_a_broken_hermes_config_is_no_problem(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom() -> str:
        raise RuntimeError("config unreadable")

    monkeypatch.setattr(_hermes, "approval_mode", boom)
    assert readiness.hermes_problems() == []


def test_the_setup_card_shows_it_but_runs_still_work(rt: Runtime, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_hermes, "approval_mode", lambda: "off")
    view = readiness.setup_view(rt, roko=[])
    assert view["ok"] is True and [p["id"] for p in view["problems"]] == ["approvals-off"]


def _fake_hermes(monkeypatch: pytest.MonkeyPatch, **modules: dict[str, Any]) -> None:
    for name, attrs in modules.items():
        module = types.ModuleType(name)
        for key, value in attrs.items():
            setattr(module, key, value)
        monkeypatch.setitem(sys.modules, name, module)


def test_approval_mode_asks_hermes_then_reads_its_config(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_hermes(
        monkeypatch, **{"tools": {}, "tools.approval_context": {"_get_approval_mode": lambda: "off"}}
    )
    assert _hermes.approval_mode() == "off"
    # An older Hermes without the resolver: its config, where YAML reads a bare `off` as false.
    monkeypatch.setitem(sys.modules, "tools.approval_context", None)
    _fake_hermes(
        monkeypatch,
        **{
            "hermes_cli": {},
            "hermes_cli.config": {"load_config_readonly": lambda: {"approvals": {"mode": False}}},
        },
    )
    assert _hermes.approval_mode() == "off"
    _fake_hermes(monkeypatch, **{"hermes_cli.config": {"load_config_readonly": lambda: {}}})
    assert _hermes.approval_mode() == "smart"  # Hermes' default


def test_bypass_and_review_follow_hermes(monkeypatch: pytest.MonkeyPatch) -> None:
    assert _hermes.approvals_bypassed() is False and _hermes.in_background_review() is False
    _fake_hermes(
        monkeypatch,
        **{
            "tools": {},
            "tools.approval": {"is_approval_bypass_active": lambda: True},
            "tools.skill_provenance": {"is_background_review": lambda: True},
        },
    )
    assert _hermes.approvals_bypassed() is True and _hermes.in_background_review() is True


# -- the learning guard -----------------------------------------------------------------------------


@pytest.mark.parametrize("text", HARMFUL)
def test_the_guard_knows_a_repair_recipe(text: str) -> None:
    assert learning_guard.teaches_repair(text)


@pytest.mark.parametrize("text", HARMLESS)
def test_the_guard_lets_everything_else_through(text: str) -> None:
    assert not learning_guard.teaches_repair(text)


@pytest.fixture
def in_review(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(_hermes, "in_background_review", lambda: True)


def _skill_create(content: str) -> dict[str, Any]:
    return {"operations": [{"action": "create", "name": "roko-run-preflight", "content": content}]}


def test_the_review_cannot_save_the_field_s_skill(in_review: None) -> None:
    hook = learning_guard.make_hook(lambda: True)
    verdict = hook(tool_name="skill_manage", args=_skill_create(HARMFUL_SKILL), tool_call_id="c1")
    assert verdict is not None and verdict["action"] == "block"
    assert "roko:delegate" in verdict["message"] and "do not write it again" in verdict["message"]
    write_ref = {
        "operations": [
            {
                "action": "write_file",
                "name": "roko-run-preflight",
                "file_path": "references/worktree-isolation-recovery.md",
                "file_content": HARMFUL_REFERENCE,
            }
        ]
    }
    assert hook(tool_name="skill_manage", args=write_ref) is not None
    # the legacy flat shape, and memory's both shapes
    assert hook(tool_name="skill_manage", args={"action": "patch", "name": "x", "new_string": HARMFUL[5]})
    assert hook(tool_name="memory", args={"action": "add", "target": "memory", "content": HARMFUL[2]})
    assert hook(tool_name="memory", args={"operations": [{"action": "add", "content": HARMFUL[3]}]})


def test_the_review_may_save_notes_and_take_bad_rules_out(in_review: None) -> None:
    hook = learning_guard.make_hook(lambda: True)
    for text in HARMLESS:
        assert hook(tool_name="skill_manage", args=_skill_create(text)) is None, text
        assert hook(tool_name="memory", args={"action": "add", "content": text}) is None, text
    removal = {"action": "patch", "name": "roko-run-preflight", "old_string": HARMFUL[5], "new_string": ""}
    assert hook(tool_name="skill_manage", args=removal) is None
    assert hook(tool_name="memory", args={"action": "remove", "old_text": HARMFUL[2]}) is None
    assert hook(tool_name="skill_manage", args={"operations": [{"action": "delete", "name": "x"}]}) is None


def test_the_guard_leaves_the_chat_and_its_off_switch_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    hook = learning_guard.make_hook(lambda: True)
    # A write the person asked for in a chat is theirs.
    monkeypatch.setattr(_hermes, "in_background_review", lambda: False)
    assert hook(tool_name="skill_manage", args=_skill_create(HARMFUL_SKILL)) is None
    monkeypatch.setattr(_hermes, "in_background_review", lambda: True)
    off = learning_guard.make_hook(lambda: False)
    assert off(tool_name="skill_manage", args=_skill_create(HARMFUL_SKILL)) is None


def test_other_tools_return_at_once_without_asking_hermes(monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[str] = []

    def review() -> bool:
        asked.append("review")
        return True

    monkeypatch.setattr(_hermes, "in_background_review", review)
    hook = learning_guard.make_hook(lambda: True)
    args = {"command": "git -C ws worktree remove --force ws/.roko/worktrees/a"}
    calls = 20_000
    started = time.perf_counter()
    for _ in range(calls):
        assert hook(tool_name="terminal", args=args, tool_call_id="c", session_id="s") is None
    per_call = (time.perf_counter() - started) / calls
    assert asked == []  # the review check is never made for another tool
    assert per_call < 20e-6, f"{per_call * 1e6:.1f} µs per call"  # well under a microsecond in practice


def test_the_guard_never_raises(monkeypatch: pytest.MonkeyPatch, in_review: None) -> None:
    def boom(text: str) -> str | None:
        raise RuntimeError("a bug")

    monkeypatch.setattr(learning_guard, "first_lesson", boom)
    hook = learning_guard.make_hook(lambda: True)
    assert hook(tool_name="skill_manage", args=_skill_create(HARMFUL_SKILL)) is None
    broken = learning_guard.make_hook(lambda: 1 / 0 == 0)
    assert broken(tool_name="memory", args={"content": HARMFUL[3]}) is None
    assert hook() is None and hook(tool_name=None, args=None) is None
    _scanner_clean(learning_guard.MESSAGE)


# The desktop's three turn hooks (cards.py, 0.6.0): none is a tool-call hook.
CARD_HOOKS = [
    ("transform_llm_output", cards.transform_llm_output),
    ("on_interim_message", cards.on_interim_message),
    ("on_session_end", cards.on_session_end),
]


def test_no_tool_call_hook_unless_the_guard_is_turned_on(monkeypatch: pytest.MonkeyPatch) -> None:
    # Off by default: any registered pre_tool_call hook, even an idle one, lets Hermes refuse concurrent tool
    # calls that carry no call id (plugin-review R8), so with the guard off no tool-call hook is registered.
    monkeypatch.setattr(_hermes, "hooks_gated_per_call", lambda: True)
    default = FakeContext({})
    hermes_plugin_roko.register(default)
    assert default.hooks[:3] == CARD_HOOKS and [name for name, _ in default.hooks[3:]] == ["pre_llm_call"]
    off = FakeContext({"learning_guard": False})
    hermes_plugin_roko.register(off)
    assert off.hooks[:3] == CARD_HOOKS and [name for name, _ in off.hooks[3:]] == ["pre_llm_call"]


def test_the_guard_is_registered_when_on_and_hermes_gates_hooks_per_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_hermes, "hooks_gated_per_call", lambda: False)
    old = FakeContext({"learning_guard": True})
    hermes_plugin_roko.register(old)
    assert old.hooks == []  # Hermes 0.21.0: a hook of one session could block another's tools
    monkeypatch.setattr(_hermes, "hooks_gated_per_call", lambda: True)
    new = FakeContext({"learning_guard": True})
    hermes_plugin_roko.register(new)
    [(name, hook), *turn_hooks] = new.hooks
    assert name == "pre_tool_call" and turn_hooks[:3] == CARD_HOOKS and turn_hooks[3][0] == "pre_llm_call"
    monkeypatch.setattr(_hermes, "in_background_review", lambda: True)
    assert hook(tool_name="skill_manage", args=_skill_create(HARMFUL_SKILL)) is not None
    new.settings["learning_guard"] = False  # turned off without a restart: the hook stays, idle
    assert hook(tool_name="skill_manage", args=_skill_create(HARMFUL_SKILL)) is None


def test_the_setting_is_opt_in_and_a_bad_value_keeps_it_off() -> None:
    assert load_settings(None).learning_guard is False
    settings = load_settings(lambda key, default: "maybe" if key == "learning_guard" else default)
    assert settings.learning_guard is False and any("learning_guard" in p for p in settings.problems)
    assert (
        load_settings(lambda key, default: True if key == "learning_guard" else default).learning_guard
        is True
    )


# -- the tool answers' own words --------------------------------------------------------------------


def test_a_paid_start_that_asked_nobody_says_so(
    call: Callable[..., dict[str, Any]],
    approvals: Approvals,
    ctx: FakeContext,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = call("roko_run", {"prompt": "x", "max_usd": 1})
    assert "approval" not in started and "Nobody was asked" not in started["next"]
    monkeypatch.setattr(
        _hermes, "approvals_bypassed", lambda: True
    )  # approvals off: Hermes answers by itself
    started = call("roko_run", {"prompt": "x", "max_usd": 1})
    assert started["approval"] == "not asked: Hermes approvals are off"
    assert "Nobody was asked" in started["next"] and "tell the person it started" in started["next"]
    planned = call("roko_plan_generate", {"prompt": "plan it"})
    assert (
        planned["approval"] == "not asked: Hermes approvals are off" and "Nobody was asked" in planned["next"]
    )
    ctx.settings["approve_paid"] = False
    monkeypatch.setattr(_hermes, "approvals_bypassed", lambda: False)
    started = call("roko_run", {"prompt": "x", "max_usd": 1})
    assert started["approval"] == "not asked: the plugin's approve_paid setting is off"


def test_a_plan_run_that_asked_nobody_says_so(
    call: Callable[..., dict[str, Any]], fake: FakeRoko, approvals: Approvals, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake.add_plan("p1")
    monkeypatch.setattr(_hermes, "approvals_bypassed", lambda: True)
    result = call("roko_plan_run", {"plan_id": "p1", "max_usd": 1})
    assert (
        result["approval"] == "not asked: Hermes approvals are off" and "Nobody was asked" in result["next"]
    )


def test_a_cap_above_the_limit_is_the_person_s_to_lower(call: Callable[..., dict[str, Any]]) -> None:
    result = call("roko_run", {"prompt": "x", "max_usd": 50})
    assert result["code"] == "invalid" and "do not pick a smaller one for them" in result["hint"]


def test_the_daily_limit_asks_the_person_and_the_page_reads_plainly(
    call: Callable[..., dict[str, Any]], ctx: FakeContext, fake: FakeRoko, rt: Runtime
) -> None:
    from hermes_plugin_roko import tools

    fake.run_script = ["running"]
    ctx.settings["max_day_usd"] = 3
    call("roko_run", {"prompt": "x", "max_usd": 2})
    refused = call("roko_run", {"prompt": "x", "max_usd": 2})
    assert refused["code"] == "refused" and "ask whether to start it with a smaller cap" in refused["hint"]
    assert "start nothing until they answer" in refused["hint"]
    assert "The limit is theirs: do not raise it unless they ask." in refused["hint"]
    with pytest.raises(RokoError) as raised:
        tools.check_day(rt, rt.client(), rt.settings(), 2.0)
    assert not TO_THE_MODEL.search(f"{raised.value.message} {raised.value.hint}")


def test_a_start_that_timed_out_says_not_to_call_it_again(
    rt: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hermes_plugin_roko import tools

    def slow(*args: Any, **kwargs: Any) -> Any:
        raise RokoError(Code.UNREACHABLE, "did not answer in time", timed_out=True)

    monkeypatch.setattr(rt.client(), "call_tool", slow)
    with pytest.raises(RokoError) as raised:
        tools.start_paid(rt, rt.client(), "run_prompt", {"prompt": "x", "max_usd": 1})
    exc = raised.value
    assert "Do not call it again" in str(exc.as_dict()["hint"]) and "twice" in str(exc.as_dict()["hint"])
    assert "roko_status" not in str(exc.hint) and "/roko runs" in str(exc.hint)  # the person's words


def test_a_plugin_bug_tells_the_model_not_to_work_around_it(
    rt: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hermes_plugin_roko import tools, views

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise KeyError("a bug")

    monkeypatch.setattr(views, "overview", broken)
    result = json.loads(tools.make_handlers(rt)["roko_status"]({}))
    assert result["code"] == "internal" and "do not work around it" in result["hint"]


def test_a_chat_refusal_lights_the_setup_card(
    call: Callable[..., dict[str, Any]], fake: FakeRoko, rt: Runtime
) -> None:
    before = [p["id"] for p in readiness.setup_view(rt)["problems"]]  # a look taken while roko accepted runs
    assert "workspace-refuses-chat-runs" not in before
    fake.boundary = False
    assert call("roko_run", {"prompt": "x", "max_usd": 1})["code"] == "refused"
    after = [p["id"] for p in readiness.setup_view(rt)["problems"]]  # the same cached look, plus the refusal
    assert "workspace-refuses-chat-runs" in after


WORKTREE_ERROR = (
    "plan 'demo-hello-world': task 'HELLO-1' failed: agent error (worktree-isolation): failed to acquire worktree "
    "for demo-hello-world/HELLO-1/attempt-0: workspace I/O error: cannot safely reattach worktree "
    "`attempt-76555e29268820e0fd63`: branch `roko/attempt/attempt-76555e29268820e0fd63` is already checked out "
    "in this repository"
)


def _dies_on_its_own_worktree(fake: FakeRoko) -> None:
    """Every run fails before its task runs, as Will's did after the crash (repro-will F2)."""
    fake.add_plan("demo-hello-world", "Hello world demo")
    fake.run_script = ["failed"]
    make = fake._new_run

    def new_run(kind: str, **kwargs: Any) -> Any:
        run = make(kind, **kwargs)
        run.events = [
            {"type": "plan_started", "plan_id": "demo-hello-world", "tasks_total": 1},
            {"type": "task_started", "plan_id": "demo-hello-world", "task_id": "HELLO-1", "title": "hello"},
            {
                "type": "task_completed",
                "plan_id": "demo-hello-world",
                "task_id": "HELLO-1",
                "outcome": "failed",
            },
            {"type": "error", "message": WORKTREE_ERROR},
            {"type": "plan_completed", "plan_id": "demo-hello-world", "success": False},
            {"type": "run_completed", "run_id": run.run_id, "outcome": "failed"},
        ]
        return run

    fake._new_run = new_run


def test_a_run_that_died_on_roko_s_own_worktree_says_hands_off(
    call: Callable[..., dict[str, Any]], fake: FakeRoko, approvals: Approvals
) -> None:
    _dies_on_its_own_worktree(fake)
    run_id = call("roko_plan_run", {"plan_id": "demo-hello-world", "max_usd": 0.25})["run_id"]
    first = call("roko_status", {"run_id": run_id, "wait_secs": 0})
    assert first["state"] == "failed" and errors.FAILED_GUIDANCE in first["next"]
    why = call("roko_status", {"run_id": run_id, "detail": "why"})
    assert "worktree-isolation" in json.dumps(why["why"]) and why["next"] == errors.ROKO_STATE_GUIDANCE
    assert "no `git worktree remove`" in why["next"] and "do not start the run again" in why["next"]


def test_a_failed_and_a_cancelled_run_leave_the_next_run_to_the_person(
    call: Callable[..., dict[str, Any]], fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["failed"]
    failed = call("roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    why = call("roko_status", {"run_id": failed, "detail": "why"})
    assert why["state"] == "failed" and errors.FAILED_GUIDANCE in why["next"]
    assert why["next"].endswith(errors.REPORT_NOT_REPAIR)
    fake.run_script = ["running"]
    running = call("roko_run", {"prompt": "y", "max_usd": 1})["run_id"]
    call("roko_cancel", {"run_id": running})
    cancelled = call("roko_status", {"run_id": running, "wait_secs": 0})["next"]
    assert cancelled == errors.hands_off(errors.CANCELLED_GUIDANCE)


def test_the_guard_logs_the_sentence_it_refused(in_review: None, caplog: pytest.LogCaptureFixture) -> None:
    hook = learning_guard.make_hook(lambda: True)
    with caplog.at_level("INFO", logger="hermes_plugin_roko.learning_guard"):
        assert hook(tool_name="skill_manage", args=_skill_create(HARMFUL_SKILL)) is not None
    [record] = [r for r in caplog.records if "declined" in r.getMessage()]
    assert "worktree remove" in record.getMessage() or "re-issue" in record.getMessage()


def test_the_guard_stays_on_when_the_settings_cannot_be_read() -> None:
    class Broken:
        def settings(self) -> Any:
            raise RuntimeError("config unreadable")

    assert hermes_plugin_roko._guard_on(Broken()) is True  # type: ignore[arg-type]


# -- leftover checkouts: only the command roko gives ------------------------------------------------

RAW_SURGERY = re.compile(r"\bgit\s+(?:-C\s+\S+\s+)?(?:worktree|branch)\b|\brm\b", re.IGNORECASE)


def _forbids_raw_surgery(text: str, *, must_name: bool = True) -> None:
    """Every sentence that names a raw git worktree or branch command, or `rm`, forbids it."""
    named = 0
    for sentence in learning_guard._sentences(text):
        match = RAW_SURGERY.search(sentence)
        if match is None:
            continue
        named += 1
        assert learning_guard.NEGATION.search(sentence[: match.start()]), sentence
    assert named or not must_name, "the text should name the raw commands it forbids"


def test_the_guidance_forbids_raw_git_surgery_on_roko_s_checkouts(tmp_path: Path) -> None:
    guidance = errors.ROKO_STATE_GUIDANCE
    _forbids_raw_surgery(guidance)
    assert "git worktree remove" in guidance and "git branch -D" in guidance and "`.roko/`" in guidance
    assert "even if the person asks" in guidance and "--force" not in guidance
    # The one exception is roko's own command, run as given, only on the person's word in this turn.
    assert (
        "explicitly ask in this turn" in guidance
        and "run only the exact command roko's message gives" in guidance
    )
    assert "if roko's message gives no command, tell them so and stop" in guidance
    assert not learning_guard.teaches_repair(guidance)


def test_the_skills_and_the_prompt_say_the_same() -> None:
    delegate = (SKILLS / "roko-delegate" / "SKILL.md").read_text()
    _forbids_raw_surgery(delegate)
    flat = " ".join(delegate.split())
    assert "not even when the person asks" in flat and "run that exact command, and nothing else" in flat
    assert "If roko's message gives no command, tell the person what roko said and stop" in flat
    plan = " ".join((SKILLS / "roko-plan" / "SKILL.md").read_text().split())
    assert "not even when the person asks" in plan and "only the exact command roko's message gives" in plan
    ctx = FakeContext({})
    hermes_plugin_roko.register(ctx)
    section = ctx.sections["roko"]["content"]({"platform": "desktop"})
    assert "even if asked" in section and "only the exact command roko's message gives" in section


# -- P8: a markdown request is still code work --------------------------------------------------------


def test_the_skill_and_the_schema_keep_text_files_on_the_project_s_checks() -> None:
    delegate = " ".join((SKILLS / "roko-delegate" / "SKILL.md").read_text().split())
    assert "Leave `domain` out" in delegate and "even for a README, a CONTRIBUTING.md" in delegate
    assert "roko runs no project checks on that work unless roko.toml has a `[gates.packs.docs]`" in delegate
    domain = catalog.tool_schemas(5.0)["roko_run"]["parameters"]["properties"]["domain"]["description"]
    assert "Leave it out (code, the default" in domain and "unless the person asks for prose only" in domain
    assert "docs or research run no project checks unless roko.toml has a [gates.packs.docs]" in domain


def test_a_docs_run_says_nothing_will_check_it(
    call: Callable[..., dict[str, Any]], approvals: Approvals, fake: FakeRoko
) -> None:
    started = call("roko_run", {"prompt": "add CONTRIBUTING.md", "max_usd": 0.25, "domain": "docs"})
    [asked] = approvals.asked
    assert "one docs task (roko runs no project checks on docs work" in asked["message"]
    assert "nothing will check this run" in asked["message"]
    assert "This is docs work" in started["next"] and "nothing will check this run" in started["next"]
    assert fake.tool_calls("run_prompt")[-1]["domain"] == "docs"  # the person's choice still goes to roko


@pytest.mark.parametrize("domain", [None, "code", "Code"])
def test_a_code_run_promises_the_project_s_checks(
    call: Callable[..., dict[str, Any]], approvals: Approvals, domain: str | None
) -> None:
    args: dict[str, Any] = {"prompt": "add CONTRIBUTING.md", "max_usd": 0.25}
    if domain:
        args["domain"] = domain
    started = call("roko_run", args)
    assert "one gated task" in approvals.asked[-1]["message"]
    assert "nothing will check" not in approvals.asked[-1]["message"] and "work:" not in started["next"]


# -- demo output stays on its branch (dogfood-will bug 13) --------------------------------------------


def test_the_skills_never_offer_to_merge_demo_output_or_predict_a_refusal() -> None:
    delegate = " ".join((SKILLS / "roko-delegate" / "SKILL.md").read_text().split())
    plan = " ".join((SKILLS / "roko-plan" / "SKILL.md").read_text().split())
    assert "its output stays on its run branch: show what it did, and never offer to merge it" in delegate
    assert "A demo plan's output stays on its run branch: never offer to merge it" in plan
    assert "may end `already_satisfied`, and the run then succeeds" in delegate
    for text in (delegate, plan):
        assert "refuses a plan whose checks pass" not in text
    demo = (ROOT / "hermes_plugin_roko" / "demos" / "demo-hello-world" / "plan.md").read_text()
    assert "refuses a plan whose checks pass" not in " ".join(demo.split()) and "never merge it" in demo


def test_a_demo_run_answer_carries_no_merge_command() -> None:
    from hermes_plugin_roko import tools

    card: dict[str, Any] = {
        "run_id": "r1",
        "kind": "plan",
        "state": "succeeded",
        "demo": True,
        "delivered": {"branch": "roko/batch/r1", "files_changed": ["demo/hello-world/hello.sh"]},
        "review_command": "git -C ws diff main..roko/batch/r1",
        "merge_command": "git -C ws merge --ff-only roko/batch/r1",
    }
    answer = tools.for_model(card, {})
    assert "merge_command" not in answer and answer["review_command"].startswith("git -C ws diff")
    assert "never offer to merge it" in answer["demo"]
    ordinary = tools.for_model({**card, "demo": False}, {})
    assert ordinary["merge_command"] == "git -C ws merge --ff-only roko/batch/r1" and "demo" not in ordinary


# -- a plan roko's check rejects (roko bug-7a08a8) ----------------------------------------------------


def test_a_plan_that_cannot_run_goes_to_the_person_and_stays_theirs() -> None:
    from hermes_plugin_roko import tools

    for text in (tools.PLAN_WRITTEN_INVALID_GUIDANCE, tools.PLAN_INVALID_GUIDANCE):
        assert "Tell the person what roko found" in text and "validation.open_questions" in text
        assert "do not edit the plan" in text and "unless they ask you to in this turn" in text
        assert not learning_guard.teaches_repair(text)
        _scanner_clean(text)
    card = {"kind": "plan_generate", "validation": {"errors": [], "open_questions": [{"task_id": "T1"}]}}
    named = tools._next_step(
        {"state": "failed", "plan_id": "two-modules"}, {**card, "plan_id": "two-modules"}
    )
    assert named.startswith(
        "roko wrote the plan (roko_plans(plan_id=two-modules) shows it), but it cannot run yet"
    )
    unnamed = tools._next_step({"state": "failed"}, card)
    assert unnamed.startswith("roko wrote the plan, but it cannot run yet") and "None" not in unnamed


def test_a_refused_plan_speaks_to_the_person_and_the_model_apart() -> None:
    from hermes_plugin_roko import tools

    validation = {
        "summary": "PLAN_045: T2 has open questions",
        "errors": [{"rule": "PLAN_045", "task_id": "T2", "message": "T2 has open questions"}],
        "open_questions": [{"task_id": "T2", "question": "pad or raise?", "assumption": "pad."}],
    }
    refused = RokoError(Code.REFUSED, "plan two-modules failed validation with 1 error(s)")
    error = tools.PlanInvalid("two-modules", validation, refused)
    person = f"{error.message} {error.hint} {error.one_line()}"
    assert "open_questions" in str(error.hint) and not TO_THE_MODEL.search(person), person
    answer = error.as_dict()
    assert (
        answer["hint"] == errors.hands_off(tools.PLAN_INVALID_GUIDANCE) and answer["validation"] == validation
    )


# -- roko's no_price refusal (gap-8548e3): a run from chat needs a model with a price ------------------

# roko's words since gap-8548e3, as `ChatRunRefusal.message` gives them.
NO_PRICE_WORDS = (
    "a run from a chat host is held to its max_usd, and a cap can count only the calls of a model with a "
    "price; the models it can run on have none (oss, glm and 2 more). To fix it, set cost_input_per_m and "
    "cost_output_per_m on one's [models.*] entry in roko.toml (0 for a free local model)"
)


def test_a_run_with_no_priced_model_goes_to_the_person(
    call: Callable[..., dict[str, Any]], fake: FakeRoko, rt: Runtime
) -> None:
    fake.priced = False
    for name, args in (("roko_run", {"prompt": "x", "max_usd": 1}), ("roko_plan_run", {"plan_id": "p"})):
        result = call(name, {**args, "max_usd": 1})
        assert result["code"] == "refused" and result["refusal"] == "no_price", name
        guidance = result["hint"]
        assert guidance == errors.hands_off(errors.REFUSAL_GUIDANCE[Refusal.NO_PRICE])
        assert "Do not edit roko.toml or run hermes roko init yourself, even if they ask" in guidance
        assert "retrying cannot help" in guidance and "start nothing else" in guidance
    # The refusal lights the setup card at once, naming the models roko named.
    [card] = [p for p in readiness.setup_view(rt)["problems"] if p["id"] == readiness.NO_PRICE]
    assert card["severity"] == "block" and "(claude-haiku)" in card["detail"]
    assert card["fix"]["kind"] == "docs" and card["fix"]["docs"] == readiness.DOCS[readiness.NO_PRICE]


def test_the_setup_card_and_the_doctor_name_the_missing_price(fake: FakeRoko, rt: Runtime) -> None:
    from hermes_plugin_roko.diagnostics import run_doctor

    fake.priced = False
    [found] = readiness.problems(rt)
    assert found["id"] == "no-priced-model" and found["title"] == (
        "roko has no priced model for runs started from Hermes."
    )
    person = f"{found['title']} {found['detail']}"
    assert not TO_THE_MODEL.search(person), person
    assert "cost_input_per_m and cost_output_per_m" in found["detail"] and "0 only" in found["detail"]
    _scanner_clean(person)
    report = run_doctor(rt)
    [runs] = [check for check in report.checks if check.name == "runs"]
    assert runs.status == "fail" and runs.problem and runs.problem["id"] == "no-priced-model"
    assert not [check for check in report.checks if check.name == "models"]  # no "OK" next to it
    # Both reasons at once: the boundary on the runs line, the price on the models line.
    readiness.invalidate(rt)
    fake.boundary = False
    assert ids(readiness.problems(rt)) == ["workspace-refuses-chat-runs", "no-priced-model"]
    lines = {check.name: check for check in run_doctor(rt).checks}
    assert lines["runs"].problem and lines["runs"].problem["id"] == "workspace-refuses-chat-runs"
    assert lines["models"].problem and lines["models"].problem["id"] == "no-priced-model"


def ids(problems: list[dict[str, Any]]) -> list[str]:
    return [problem["id"] for problem in problems]


def test_the_page_shows_the_person_the_fix_and_not_the_guidance(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.priced = False
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix=PREFIX)
    with TestClient(app) as client:
        body = client.post(PREFIX + "/runs", content=json.dumps({"prompt": "x", "max_usd": 0.5})).json()
    assert body["ok"] is False and body["error"]["code"] == "refused"
    assert body["error"]["hint"] == errors.PRICE_FIX and body["problem"]["id"] == "no-priced-model"
    shown = f"{body['error']['message']} {body['error']['hint']} {body['problem']['detail']}"
    assert not TO_THE_MODEL.search(shown), shown


def test_roko_s_words_alone_name_it_and_the_models() -> None:
    assert errors.refusal_from_text(NO_PRICE_WORDS) == Refusal.NO_PRICE
    exc = RokoError(
        Code.REFUSED, NO_PRICE_WORDS, hint=errors.hint_for_refusal(NO_PRICE_WORDS), refusal="no_price"
    )
    assert exc.hint == errors.PRICE_FIX and "with no restart" in exc.hint
    found = readiness.problem_for_error(Runtime(FakeContext({})), exc)
    assert found is not None and "(oss, glm and 2 more)" in found["detail"]
    # Behind roko's other reason ("…; and a run from a chat host is held…"), and with no models named.
    both = "a run from a chat host needs the data-model boundary: …; and " + NO_PRICE_WORDS
    assert "(oss, glm and 2 more)" in readiness._no_price(both)["detail"]
    assert "()" not in readiness._no_price("roko refused it")["detail"]
    # A task that failed for its own model's missing price is no setup problem: another model has one.
    failed = "`api-model` on `mock_api`: has no price, and a budget cap can count only priced calls"
    assert errors.refusal_from_text(failed) is None


def test_an_older_roko_never_refuses_for_a_price(fake: FakeRoko, rt: Runtime) -> None:
    fake.priced, fake.refusal_words = False, False  # before gap-8548e3, roko ran unpriced models
    assert readiness.problems(rt) == []
    assert readiness.look(rt)[0].runs == "accepted"


def test_the_boundary_fix_says_the_price_is_still_missing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "roko.toml").write_text('config_version = 2\n\n[agent]\ndefault_model = "claude-haiku"\n')
    server = FakeRoko(config=workspace / "roko.toml", priced=False).start()
    monkeypatch.setattr(readiness, "SETTLE_S", 0.3)
    wrt = Runtime(FakeContext({"url": server.url, "workdir": str(workspace)}))
    try:
        result = readiness.apply_fix(wrt, "workspace-chat-ready", "local")
    finally:
        wrt.close()
        server.stop()
    assert result["done"] is True and result["ready"] is False
    assert "roko still refuses them" in result["message"]
    assert result["next"].startswith(
        f"give one of roko's models for these runs a price (docs/{readiness.DOCS[readiness.NO_PRICE]})"
    )


# -- a stop at the cap (roko bug-4fabd0): offered to the person, never raised or run again unasked -------------


def test_the_skills_leave_a_run_past_the_cap_to_the_person() -> None:
    delegate = " ".join((SKILLS / "roko-delegate" / "SKILL.md").read_text().split())
    assert "`failed` with `budget_stop`" in delegate and "a stop rather than a failed check" in delegate
    assert "The cap is the person's limit" in delegate
    assert "start it only when they ask, with the cap they choose" in delegate
    plan = " ".join((SKILLS / "roko-plan" / "SKILL.md").read_text().split())
    assert "counts what the plan already spent" in plan and "the person chooses it" in plan


def test_the_model_offers_a_run_past_the_cap_and_never_starts_or_raises_one() -> None:
    from hermes_plugin_roko import rundata, tools

    stop = {"cap_usd": 0.03, "spent_usd": 0.0264, "stopped": ["T2"], "not_started": []}
    parts = [{"trust": "verified", "branch": "roko/batch/r1"}]
    result = {"state": "failed", "run_id": "r1", "budget_stop": stop, "work": {"parts": parts}}
    guidance = tools._next_step(result, {"kind": "plan", "gates": {"passed": 1, "total": 1}})
    assert guidance.startswith("roko stopped the run when it reached its cap of $0.03 ($0.0264 spent)")
    assert "what passed (roko keeps it on roko/batch/r1)" in guidance and "resume=true" in guidance
    assert "start it only when they ask, with the cap they choose" in guidance
    assert "Do not raise a cap or limit yourself, and do not start other paid work in its place." in guidance
    assert not learning_guard.teaches_repair(guidance)  # nothing a review could save as "raise and retry"
    _scanner_clean(guidance)
    # The person's side of the same stop (the card's shape) never addresses the model.
    stopped = {"cap_usd": 0.03, "spent_usd": 0.0264, "stopped": [{"task_id": "T2", "before": "model_call"}]}
    card = {"state": "failed", "kind": "plan", "budget_stop": stopped, "work": {"kind": "partial"}}
    action = rundata.next_action(card)
    assert action is not None and action["action"] == "rerun"
    shown = f"{action['label']} {action['why']} {' '.join(rundata._cap_story(stopped, set()))}"
    assert not TO_THE_MODEL.search(shown) and guidance not in shown, shown


def test_the_plugin_s_own_guidance_passes_its_guard() -> None:
    """A review that saves what the plugin told the model is never refused for it."""
    from hermes_plugin_roko import tools

    texts = {f"refusal {key.value}": text for key, text in errors.REFUSAL_GUIDANCE.items()}
    texts.update({f"code {key.value}": text for key, text in errors.CODE_GUIDANCE.items()})
    for module in (errors, tools):
        for name in dir(module):
            value = getattr(module, name)
            if isinstance(value, str) and name.endswith(("_GUIDANCE", "_NEXT", "_FIX")):
                texts[name] = value
    stop = {
        "what": "a stop, not a failed check",
        "kept": ", and what passed before it, which roko keeps on x",
    }
    texts["budget stop"] = tools.BUDGET_STOP_GUIDANCE.format(
        line="reached its cap of $0.03",
        again=" (roko_plan_run with resume=true …)",
        climb=tools.STOP_CLIMB,
        offer=tools.BUDGET_STOP_OFFER.format(say="continue", cap="$0.25"),
        **stop,
    )
    texts["budget stop at the per-run limit"] = tools.BUDGET_STOP_GUIDANCE.format(
        line="reached its cap of $3.00",
        again="",
        climb="",
        offer=tools.BUDGET_STOP_OFFER_AT_LIMIT.format(say="run it again", cap="$5.00"),
        **stop,
    )
    for roko_s, limit in tools.DAILY_LIMITS.items():
        texts[f"daily stop {roko_s}"] = tools.DAILY_STOP_GUIDANCE.format(
            spent="", again=" (resume=true …)", limit=limit, climb=tools.STOP_CLIMB, **stop
        )
    flagged = {name: learning_guard.first_lesson(text) for name, text in texts.items()}
    assert {name: lesson for name, lesson in flagged.items() if lesson} == {}
    assert len(texts) > 20


# -- the S1 core in every guidance: report roko's state, never repair it ------------------------------------

STOP = {"cap_usd": 0.03, "spent_usd": 0.0264, "stopped": ["T2"], "not_started": []}
VERIFIED = {"trust": "verified", "branch": "roko/batch/r1", "tasks": ["T1"]}
WORKTREE_WHY = {"summary": "task 'T1' failed: agent error (worktree-isolation): failed to acquire worktree"}
# (what the run is, the tool answer's fields, the card's): every `_next_step` branch, calm or not.
NEXT_STEPS: list[tuple[str, dict[str, Any], dict[str, Any]]] = [
    ("waiting", {"state": "running", "waiting_on_person": [{"code": "a1b2c3"}]}, {}),
    ("plan written", {"state": "succeeded", "plan_id": "p"}, {"kind": "plan_generate"}),
    ("plan cannot run", {"state": "failed"}, {"kind": "plan_generate", "validation": {"valid": False}}),
    ("planner failed", {"state": "failed"}, {"kind": "plan_generate"}),
    ("queued", {"state": "queued", "run_id": "r1"}, {}),
    ("running", {"state": "running", "run_id": "r1"}, {}),
    ("interrupted", {"state": "interrupted", "interrupted": {"reason": "roko serve restarted"}}, {}),
    ("cap stop", {"state": "failed", "budget_stop": STOP, "work": {"parts": [VERIFIED]}}, {"kind": "plan"}),
    ("cap stop after a failed check", {"state": "failed", "budget_stop": STOP}, {"gates": {"failed": 1}}),
    ("daily stop", {"state": "failed", "budget_stop": {**STOP, "limit": "day"}}, {"kind": "plan"}),
    (
        "daily stop at roko's setting",
        {"state": "failed", "budget_stop": {**STOP, "limit": "day"}},
        {"budget_stop": {"said": "daily budget exhausted: … of budget.max_daily_usd = $1.0000"}},
    ),
    ("cap stop on roko's state", {"state": "failed", "budget_stop": STOP, "why": WORKTREE_WHY}, {}),
    ("demo succeeded", {"state": "succeeded"}, {"demo": True}),
    ("demo failed", {"state": "failed"}, {"demo": True}),
    ("demo unverified", {"state": "unverified"}, {"demo": True}),
    ("unverified, kept", {"state": "unverified", "work": {"parts": [{"branch": "roko/batch/r1"}]}}, {}),
    ("unverified", {"state": "unverified"}, {}),
    ("roko.toml uncommitted", {"state": "succeeded", "merge": {"fix_command": "git commit roko.toml"}}, {}),
    ("delivered", {"state": "succeeded", "delivered": {"branch": "roko/batch/r1"}}, {}),
    ("promoted", {"state": "succeeded", "delivered": {"branch": "b", "promoted_into": "main"}}, {}),
    ("succeeded", {"state": "succeeded"}, {}),
    ("failed", {"state": "failed"}, {}),
    ("failed, why", {"state": "failed", "why": {"summary": "Task 1's check did not pass"}}, {}),
    ("failed on roko's state", {"state": "failed", "why": WORKTREE_WHY}, {}),
    ("partial", {"state": "failed", "work": {"parts": [VERIFIED]}}, {}),
    ("cancelled", {"state": "cancelled"}, {}),
    ("a state roko adds later", {"state": "paused"}, {}),
]
CALM = {
    "waiting",
    "plan written",
    "queued",
    "running",
    "demo succeeded",
    "delivered",
    "promoted",
    "succeeded",
}


@pytest.mark.parametrize(("name", "result", "card"), NEXT_STEPS, ids=[step[0] for step in NEXT_STEPS])
def test_every_next_step_but_a_calm_one_carries_the_s1_core(
    name: str, result: dict[str, Any], card: dict[str, Any]
) -> None:
    from hermes_plugin_roko import tools

    step = tools._next_step(result, card)
    assert (errors.REPORT_NOT_REPAIR in step) is (name not in CALM), step
    assert step.count(errors.REPORT_NOT_REPAIR) <= 1 and not learning_guard.teaches_repair(step), step
    if name.startswith("demo") and name != "demo succeeded":
        assert not step.startswith("Done"), step  # a demo that did not succeed is not reported as done
    _scanner_clean(step)


def test_every_failure_answer_carries_the_s1_core_and_a_wrong_call_keeps_its_hint() -> None:
    from hermes_plugin_roko import tools

    errs = [RokoError(Code.REFUSED, "no", refusal=refusal.value) for refusal in Refusal]
    errs += [RokoError(code, "no", hint="the person's step") for code in errors.CODE_GUIDANCE]
    errs += [RokoError(Code.INVALID, "no", guidance="Ask the person for a smaller cap.")]
    errs += [tools.PlanInvalid("p", {"summary": "PLAN_045", "errors": [], "open_questions": []}, errs[0])]
    for exc in errs:
        hint = str(exc.as_dict()["hint"])
        assert hint.endswith(errors.REPORT_NOT_REPAIR) and hint.count(errors.REPORT_NOT_REPAIR) == 1, hint
        assert not learning_guard.teaches_repair(hint), hint
    for code in (Code.INVALID, Code.NOT_FOUND, Code.RATE_LIMITED):
        assert RokoError(code, "no", hint="pass a run_id").as_dict()["hint"] == "pass a run_id"
    # The checkout guidance keeps its one exception after the core, as its last word.
    assert errors.hands_off(errors.ROKO_STATE_GUIDANCE) == errors.ROKO_STATE_GUIDANCE
    assert errors.ROKO_STATE_GUIDANCE.index(errors.REPORT_NOT_REPAIR) < errors.ROKO_STATE_GUIDANCE.index(
        "The one exception"
    )


def test_a_plugin_bug_and_the_overview_s_setup_problems_carry_it_too(
    rt: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hermes_plugin_roko import tools, views

    def broken(*args: Any, **kwargs: Any) -> Any:
        raise KeyError("a bug")

    with monkeypatch.context() as patch:
        patch.setattr(views, "overview", broken)
        bug = json.loads(tools.make_handlers(rt)["roko_status"]({}))
    assert bug["code"] == "internal" and bug["hint"].endswith(errors.REPORT_NOT_REPAIR)
    monkeypatch.setattr(views, "overview", lambda rt: {"setup_problems": [{"id": "x", "title": "t"}]})
    view = json.loads(tools.make_handlers(rt)["roko_status"]({}))
    assert view["next"] == errors.hands_off(tools.SETUP_GUIDANCE)


def test_a_daily_stop_names_the_limit_that_stopped_it() -> None:
    from hermes_plugin_roko import tools

    day = {**STOP, "limit": "day", "cap_usd": 1.0, "spent_usd": 1.0}
    cases = (
        (
            "daily budget exhausted: $1.0123 spent today (UTC) of budget.max_daily_usd = $1.0000",
            "budget.max_daily_usd in the workspace's roko.toml",
        ),
        (
            "budget exhausted: daily $1.00 / $1.00 (lifetime $3.21)",
            "the daily budget of the agent that ran it",
        ),
    )
    for said, limit in cases:
        step = tools._next_step({"state": "failed", "budget_stop": day}, {"budget_stop": {"said": said}})
        assert f"until they raise {limit}, and both are theirs" in step, step
        assert "A higher max_usd does not help" in step
        assert "Do not edit roko.toml, or raise the limit another way, yourself, even if they ask" in step
        assert step.endswith(errors.REPORT_NOT_REPAIR) and not learning_guard.teaches_repair(step), step


def test_a_cap_stop_offers_words_to_say_back_and_says_how_far_it_got() -> None:
    """Dogfood U13: the model said "you'd need to approve a higher cap", with no figure and nothing on the
    climb. It now offers the card's cap in words the person can say back, and how far the run got."""
    from hermes_plugin_roko import tools

    climb = [
        "T2: cheap (gpt-oss-120b): it hit its turn cap (12 turns); mid: roko stopped it at the run's cap"
    ]
    stop = {**STOP, "climb": climb}
    plan = tools._next_step(
        {"state": "failed", "budget_stop": stop}, {"kind": "plan", "next": {"max_usd": 0.25}}
    )
    assert 'such as "continue with $0.25" (the card suggests $0.25' in plan
    assert "how far it got: what the cap stopped (budget_stop): for each stopped task" in plan  # none passed
    assert "with the line of its last failed check (budget_stop.climb), so they see how close it came" in plan
    assert "start it only when they ask, with the cap they choose" in plan  # an offer, never a start
    prompt = tools._next_step({"state": "failed", "budget_stop": STOP}, {"next": {"max_usd": 0.25}})
    assert 'such as "run it again with $0.25"' in prompt and "budget_stop.climb" not in prompt
    bare = tools._next_step({"state": "failed", "budget_stop": STOP}, {})
    assert "offer it, and start it only when they ask" in bare and "say back" not in bare
    for text in (plan, prompt, bare):
        assert not learning_guard.teaches_repair(text) and text.endswith(errors.REPORT_NOT_REPAIR), text
        _scanner_clean(text)


def test_dogfood_u13_the_cap_stop_answer_gives_a_way_forward() -> None:
    """dogfood-will's Run 3 (v6 U13): the model said "you'd need to approve a higher cap", with no figure, no
    climb and nothing on how close it came. With the card's data it now has all three, for both limits."""
    from hermes_plugin_roko import tools

    climb = [
        "T1: … 1 earlier; cheap (gpt-oss-120b): its check verify[0:test] failed: AssertionError: gain 1.02 at the "
        "cutoff; cheap: it hit its turn cap (12 turns); mid (gpt-5.4-mini): roko stopped it at the run's cap"
    ]
    stop = {"limit": "run", "cap_usd": 0.12, "spent_usd": 0.1189, "stopped": ["T1"], "not_started": []}
    step = tools._next_step(
        {"state": "failed", "budget_stop": {**stop, "climb": climb}}, {"next": {"max_usd": 0.25}}
    )
    assert 'such as "run it again with $0.25"' in step  # a figure, in words they can say back
    assert "the rungs it tried and how each try ended, with the line of its last failed check" in step
    assert "so they see how close it came" in step
    day = {**stop, "limit": "day", "climb": climb}
    daily = tools._next_step({"state": "failed", "budget_stop": day}, {})
    assert "how far it got: what the limit stopped (budget_stop): for each stopped task" in daily
    assert "offer it for after that, and start it only when they ask" in daily
    for text in (step, daily):
        assert "start it only when they ask" in text and text.endswith(errors.REPORT_NOT_REPAIR)
        assert not learning_guard.teaches_repair(text), text
        _scanner_clean(text)


def test_the_model_points_to_the_plugins_fixes_and_never_runs_them() -> None:
    """Turning roko's learning on (plugin-setup's init step, round v6) edits roko.toml: like the setup fix, the
    model points the person to it and never runs it."""
    delegate = " ".join((SKILLS / "roko-delegate" / "SKILL.md").read_text().split())
    assert "not even to lift a refusal or to turn roko's learning on" in delegate
    assert "(`hermes roko fix`, `hermes roko init`)" in delegate and "do not run it for them" in delegate
    docs = " ".join((ROOT / "docs" / "using-roko.md").read_text().split())
    assert "the plugin tells Hermes to point you to `hermes roko init` and to leave `roko.toml` alone" in docs

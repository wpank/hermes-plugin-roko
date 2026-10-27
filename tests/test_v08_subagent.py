"""0.8.0 (round v7, the pilot's R1s): roko's work starts only from the person's own chat (P-60).

Asked to write phase 5.3's plan, the chat handed roko_plan_generate to a Hermes `delegate_task` subagent. The
subagent got "running" back, ended its turn as the answer told it to, and returned that. The chat then told the
person "Plan created" at 02:11:46, while roko finished writing at 02:12:44, and no plan card ever showed: a
card, the person's approval and a run's end reach only the chat that called the tool. A delegated subagent's
approvals are Hermes' own (denied, or approved by `delegation.subagent_auto_approve`), never the person's.
So roko's tools that start work refuse in a delegated subagent and hand the call back; the read-only ones keep
working; and a plan still being written reads as not written, in the person's chat too.
"""

from __future__ import annotations

import json
import sys
import types
from collections.abc import Callable
from typing import Any

import pytest
from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import catalog, learning_guard, prompt
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import make_handlers

CHILD = "sa-0-c94981e9"
SPEC = "docs/specs/phase-5.3-presets.md"


def _delegating(monkeypatch: pytest.MonkeyPatch, *children: str) -> None:
    """Hermes' delegate registry, as a child's tool calls find it: their task_id is the child's subagent id."""
    registry = types.ModuleType("tools.delegate_tool_registry")
    registry.get_subagent_attribution = (  # type: ignore[attr-defined]
        lambda task_id: (
            {"subagent_id": task_id, "goal": "Generate a roko plan", "delegation_id": "deleg_c94981e9"}
            if task_id in children
            else None
        )
    )
    monkeypatch.setitem(sys.modules, "tools", types.ModuleType("tools"))
    monkeypatch.setitem(sys.modules, "tools.delegate_tool_registry", registry)


def _caller(rt: Runtime) -> Callable[..., dict[str, Any]]:
    handlers = make_handlers(rt)

    def invoke(name: str, args: dict[str, Any], task_id: str) -> dict[str, Any]:
        result = json.loads(handlers[name](dict(args), task_id=task_id, session_id="session-1"))
        assert isinstance(result, dict)
        return result

    return invoke


def test_p60_a_delegated_subagent_starts_no_roko_work_and_hands_the_call_back(
    fake: FakeRoko, rt: Runtime, approvals: Approvals, monkeypatch: pytest.MonkeyPatch
) -> None:
    _delegating(monkeypatch, CHILD)
    fake.tool_args = {"plan_generate": ["prompt", "spec_path", "title", "max_usd"]}
    fake.add_plan("p5-2", "P5.2 · the presets as named", [{"id": "T1"}])
    call = _caller(rt)
    asks = {
        "roko_plan_generate": {
            "prompt": "Plan phase 5.3",
            "title": "P5.3 · Low Pressure as named",
            "max_usd": 0.5,
        },
        "roko_run": {"prompt": "Retune Low Pressure", "max_usd": 0.25},
        "roko_plan_run": {"plan_id": "p5-2", "max_usd": 1.0},
    }
    for name, args in asks.items():
        refused = call(name, args, CHILD)
        assert refused["success"] is False and refused["code"] == "refused", name
        assert refused["hand_back"] == {"tool": name, "arguments": args}
        hint = refused["hint"]
        assert (
            f"the person's chat must call {name} itself" in hint
            and "Nothing ran and nothing was spent" in hint
        )
        assert not learning_guard.teaches_repair(hint), hint
    # Nothing was approved or sent to roko.
    assert approvals.asked == []
    assert [fake.tool_calls(tool) for tool in ("plan_generate", "run_prompt", "plan_run")] == [[], [], []]
    # What only reads keeps working in a subagent.
    assert call("roko_plans", {}, CHILD).get("success") is not False
    assert call("roko_status", {}, CHILD).get("success") is not False
    # The person's own chat starts it.
    fake.run_script = ["running"]
    started = call("roko_plan_generate", asks["roko_plan_generate"], "task-1")
    assert started["run_id"] and fake.tool_calls("plan_generate")


def test_p60_on_a_hermes_that_cannot_tell_a_subagent_nothing_changes(
    fake: FakeRoko, rt: Runtime, approvals: Approvals, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delitem(sys.modules, "tools.delegate_tool_registry", raising=False)
    fake.run_script = ["running"]
    started = _caller(rt)("roko_run", {"prompt": "Retune Low Pressure", "max_usd": 0.25}, CHILD)
    assert started["run_id"] and fake.tool_calls("run_prompt")


def test_p60_a_plan_still_being_written_never_reads_as_written(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    fake.tool_args = {"plan_generate": ["prompt", "spec_path", "title", "max_usd"]}
    fake.run_script = ["running", "succeeded"]
    started = call("roko_plan_generate", {"prompt": "Plan phase 5.3", "max_usd": 0.5})
    assert started["state"] == "running" and started["written"] is False
    assert started["next"].startswith("The plan is not written yet: roko's planner is still writing it.")
    assert "Until roko_status says succeeded, never say it is created, written or ready." in started["next"]
    # While roko writes it, roko_status says so, and gives no plan as its result.
    writing = call("roko_status", {"run_id": started["run_id"], "wait_secs": 0})
    assert writing["state"] == "running" and writing["written"] is False and "result" not in writing
    assert "The plan is not written yet" in writing["next"]
    # Once roko wrote it, the plan is the result.
    written = call("roko_status", {"run_id": started["run_id"], "wait_secs": 0})
    assert written["state"] == "succeeded" and written["written"] is True
    assert written["result"]["plan_id"] == started["plan_id"] and written["next"].startswith(
        "The plan is written"
    )
    for text in (started["next"], writing["next"], written["next"]):
        assert not learning_guard.teaches_repair(text), text


def test_p60_the_tool_text_says_to_call_roko_from_the_person_s_chat() -> None:
    schemas = catalog.tool_schemas(5.0)
    for name in ("roko_run", "roko_plan_generate", "roko_plan_run"):
        description = schemas[name]["description"]
        assert "never through delegate_task" in description and len(description) < 1024, name
        assert not learning_guard.teaches_repair(description), name
    assert "never through delegate_task" in prompt.TEMPLATE.replace("\\\n", "")

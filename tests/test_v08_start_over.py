"""0.8.0 (round v7, the pilot's P-51 window): "Run it again." never sets a resumable run aside unasked (P-57).

Asked "Run it again." after it had said the recov plan's run could be resumed (T1 passed, T2 left, $0.164 spent),
the chat called roko_plan_run with fresh: true and started over: no word that T1's passed work, the run's
checkpoint and its spend would be set aside (bug-cbdb6b's case, answered by the chat rather than by roko). A
fresh start over a run that can be resumed now needs `set_aside: true` too, which the tool text keeps for a
person who said "start over" or "from scratch" in this turn. Without it, nothing is approved or spent, and the
answer names what starting over sets aside and offers the resume.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import catalog, errors, learning_guard
from hermes_plugin_roko.errors import Refusal
from hermes_plugin_roko.runtime import Runtime

PLAN = "recov"
STOPPED = "0a7e3e7b-6580-4657-96cb-edc99d0faaf8"


def _resumable(fake: FakeRoko, *, spent: float | None = 0.164) -> None:
    fake.add_plan(PLAN, "recov", [{"id": "T1"}, {"id": "T2"}])
    fake.plans[PLAN]["resumable_run"] = {
        "run_id": STOPPED,
        "status": "interrupted",
        "passed_tasks": ["T1"],
        "tasks_left": ["T2"],
        "resumable": True,
        **({"spent_usd": spent} if spent is not None else {}),
    }


def test_p57_a_fresh_start_over_a_resumable_run_is_refused_until_the_person_chose_it(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _resumable(fake)
    refused = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "fresh": True})
    assert refused["success"] is False and refused["code"] == "refused" and refused["refusal"] == "start_over"
    # What starting over sets aside: the run, its passed tasks, its checkpoint and its spend.
    assert refused["error"] == (
        "Plan 'recov' has a run that can be resumed: 0a7e3e7b (interrupted) passed T1, and T2 is left. "
        "Starting over sets that run aside: T1 runs again and is paid for again, its checkpoint is set aside "
        "(it can be brought back), and the $0.16 it spent stays spent. Pass resume=true to continue it, so "
        "only T2 runs, or fresh=true with set_aside=true to start over anyway."
    )
    assert refused["resumable_run"] == {
        "run_id": STOPPED,
        "status": "interrupted",
        "passed_tasks": ["T1"],
        "tasks_left": ["T2"],
        "spent_usd": 0.164,
    }
    # The model offers the resume first, and starts over only on the person's word in this turn.
    hint = refused["hint"]
    assert "offer to resume it" in hint and "the default" in hint
    assert "set_aside: true only after the person said in this turn to start over or from scratch" in hint
    assert not learning_guard.teaches_repair(hint)
    assert approvals.asked == [] and fake.tool_calls("plan_run") == []  # nothing approved, nothing spent

    # Their word: it starts over, and roko is asked as before (set_aside is the plugin's own).
    fake.run_script = ["running"]
    started = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "fresh": True, "set_aside": True})
    assert started["run_id"] and approvals.asked[-1]["message"].startswith("Start over roko plan recov")
    assert fake.tool_calls("plan_run")[-1] == {
        "plan_id": PLAN,
        "resume": False,
        "max_usd": 1.0,
        "fresh": True,
    }


def test_p57_without_roko_s_figure_the_run_log_s_spend_is_named(
    fake: FakeRoko, rt: Runtime, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _resumable(fake, spent=None)
    rt.runs.add(STOPPED, "plan", "recov", plan_id=PLAN, state="interrupted")
    rt.runs.update(STOPPED, cost_usd=0.21)
    refused = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "fresh": True})
    assert refused["refusal"] == "start_over" and "the $0.21 it spent stays spent" in refused["error"]
    # Nothing spent known: the words leave the spend out rather than say $0.
    rt.runs.update(STOPPED, cost_usd=0.0)
    fake.plans[PLAN]["resumable_run"]["passed_tasks"] = []
    refused = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "fresh": True})
    assert refused["error"].startswith("Plan 'recov' has a run that can be resumed: 0a7e3e7b (interrupted)")
    assert (
        "Starting over sets that run aside: its checkpoint is set aside (it can be brought back). "
        in (refused["error"])
    )
    assert approvals.asked == [] and fake.tool_calls("plan_run") == []


def test_p57_a_plan_with_nothing_to_resume_starts_fresh_without_the_flag(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    fake.add_plan(PLAN, "recov", [{"id": "T1"}, {"id": "T2"}])
    fake.run_script = ["running"]
    started = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, "fresh": True})
    assert started.get("success") is not False and started["run_id"]
    assert fake.tool_calls("plan_run")[-1] == {
        "plan_id": PLAN,
        "resume": False,
        "max_usd": 1.0,
        "fresh": True,
    }
    plain = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0})
    assert plain.get("success") is not False and plain["run_id"]


def test_p57_set_aside_goes_with_fresh_only(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _resumable(fake)
    for extra in ({"set_aside": True}, {"set_aside": True, "resume": True}):
        refused = call("roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0, **extra})
        assert refused["code"] == "invalid" and "set_aside goes with fresh" in refused["error"], extra
    assert approvals.asked == [] and fake.tool_calls("plan_run") == []


def test_p57_the_tool_text_keeps_set_aside_for_the_person_s_own_start_over() -> None:
    schema = catalog.tool_schemas(5.0)["roko_plan_run"]
    flag = schema["parameters"]["properties"]["set_aside"]
    assert flag["type"] == "boolean"
    said = " ".join(flag["description"].split())
    assert 'only after the person said "start over" or "from scratch" in this turn' in said
    assert "passed tasks, its checkpoint and what it spent" in said
    assert "set_aside: true" in schema["description"] and len(schema["description"]) < 1024
    for text in (schema["description"], flag["description"], errors.REFUSAL_GUIDANCE[Refusal.START_OVER]):
        assert not learning_guard.teaches_repair(text), text

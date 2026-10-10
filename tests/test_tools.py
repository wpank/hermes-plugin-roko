from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import tools
from hermes_plugin_roko.decisions import confirmation_id, effect_decision_id
from hermes_plugin_roko.runtime import Runtime

Call = Callable[..., dict[str, Any]]


# -- roko_run ------------------------------------------------------------------


def test_run_asks_the_person_then_starts_a_capped_run(
    call: Call, fake: FakeRoko, approvals: Approvals
) -> None:
    result = call("roko_run", {"prompt": "Add a test for parse()", "max_usd": 0.75, "domain": "code"})

    assert result["state"] == "running" and result["run_id"] in fake.runs
    assert "roko_status" in result["next"]
    [asked] = approvals.asked
    assert asked["tool"] == "roko_run" and asked["rule_key"] == "roko:run_prompt:0.75"
    assert "$0.75" in asked["message"] and "Add a test for parse()" in asked["message"]
    assert fake.tool_calls("run_prompt") == [
        {"prompt": "Add a test for parse()", "max_usd": 0.75, "domain": "code"}
    ]


def test_run_denied_by_the_person_sends_nothing(call: Call, fake: FakeRoko, approvals: Approvals) -> None:
    approvals.deny()
    result = call("roko_run", {"prompt": "x", "max_usd": 1})
    assert result["code"] == "denied" and "Do NOT retry" in result["error"]
    assert fake.tool_calls("run_prompt") == []


@pytest.mark.parametrize(
    ("args", "fragment"),
    [
        ({"prompt": "x"}, "max_usd is required"),
        ({"prompt": "x", "max_usd": 0}, "at least 0.01"),
        ({"prompt": "x", "max_usd": -2}, "at least 0.01"),
        ({"prompt": "x", "max_usd": 0.004}, "at least 0.01"),
        ({"prompt": "x", "max_usd": "lots"}, "must be a number"),
        ({"prompt": "x", "max_usd": 9.5}, "above the 5.00 cap"),
        ({"prompt": "  ", "max_usd": 1}, "prompt is required"),
        ({"max_usd": 1}, "prompt is required"),
    ],
)
def test_run_checks_arguments_before_asking(
    call: Call, fake: FakeRoko, approvals: Approvals, args: dict[str, Any], fragment: str
) -> None:
    result = call("roko_run", args)
    assert result["code"] == "invalid" and fragment in result["error"]
    assert approvals.asked == [] and fake.tool_calls("run_prompt") == []


def test_run_cap_follows_the_setting(call: Call, ctx: FakeContext, approvals: Approvals) -> None:
    ctx.settings["max_run_usd"] = 0.5
    assert call("roko_run", {"prompt": "x", "max_usd": 0.6})["code"] == "invalid"
    assert call("roko_run", {"prompt": "x", "max_usd": 0.5})["state"] == "running"


def test_run_without_approval_when_the_person_turned_it_off(
    call: Call, ctx: FakeContext, approvals: Approvals
) -> None:
    ctx.settings["approve_paid"] = False
    assert call("roko_run", {"prompt": "x", "max_usd": 1})["state"] == "running"
    assert approvals.asked == []


def test_boundary_refusal_tells_the_model_to_stop(call: Call, fake: FakeRoko) -> None:
    fake.boundary = False
    result = call("roko_run", {"prompt": "x", "max_usd": 1})
    assert result["code"] == "refused"
    assert "data-model boundary" in result["error"]
    assert "retrying will not help" in result["hint"] and "allow_without_data_llm" in result["hint"]


def test_run_is_remembered_for_the_overview(call: Call, rt: Runtime) -> None:
    run_id = call("roko_run", {"prompt": "Add a test", "max_usd": 1})["run_id"]
    [entry] = rt.runs.recent()
    assert entry["run_id"] == run_id and entry["kind"] == "run" and entry["session_id"] == "session-1"


def test_server_cap_refusal_maps_to_invalid(call: Call, fake: FakeRoko, ctx: FakeContext) -> None:
    fake.max_run_usd = 1.0  # roko's own cap is lower than the plugin's
    result = call("roko_run", {"prompt": "x", "max_usd": 2})
    assert result["code"] == "invalid" and "max_run_usd" in result["error"]


# -- plans ------------------------------------------------------------------------


def test_plan_generate_returns_the_plan_id(
    call: Call, fake: FakeRoko, approvals: Approvals, rt: Runtime
) -> None:
    result = call("roko_plan_generate", {"prompt": "Split the parser into lexer and parser modules"})
    assert result["plan_id"] in fake.plans and result["run_id"] in fake.runs
    assert approvals.asked[0]["rule_key"] == "roko:plan_generate"
    assert rt.runs.get(result["run_id"])["kind"] == "plan_generate"


def test_plan_run_asks_per_plan_and_reports_queueing(
    call: Call, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan("p1")
    fake.add_plan("p2")
    fake.run_script = ["running"]
    first = call("roko_plan_run", {"plan_id": "p1", "max_usd": 2})
    second = call("roko_plan_run", {"plan_id": "p2", "max_usd": 2, "resume": True})
    assert first["state"] == "running" and "queue_position" not in first
    assert second["state"] == "queued" and second["queue_position"] == 1
    assert [a["rule_key"] for a in approvals.asked] == ["roko:plan_run:p1:2.00", "roko:plan_run:p2:2.00"]
    assert "resume plan 'p2'" in approvals.asked[1]["message"]
    assert fake.tool_calls("plan_run")[1] == {"plan_id": "p2", "resume": True, "max_usd": 2.0}


def test_plan_run_unknown_plan(call: Call) -> None:
    result = call("roko_plan_run", {"plan_id": "nope", "max_usd": 1})
    assert result["code"] == "not_found" and "nope" in result["error"]


def test_plans_lists_and_shows(call: Call, fake: FakeRoko) -> None:
    assert call("roko_plans")["note"].startswith("roko has no plans")
    fake.add_plan(
        "split parser",
        "Split the parser",
        [
            {
                "id": "T1",
                "title": "lexer",
                "depends_on": [],
                "description": "x" * 1000,
                "verify": [{"command": "cargo test -p lexer"}],
            },
            {"id": "T2", "title": "parser", "depends_on": ["T1"], "verify": []},
        ],
    )
    listed = call("roko_plans")
    assert listed["plans"] == [
        {
            "id": "split parser",
            "title": "Split the parser",
            "task_count": 2,
            "tasks_done": 0,
            "status": "ready",
        }
    ]
    detail = call("roko_plans", {"plan_id": "split parser"})  # the id is URL-encoded on the way
    assert [t["id"] for t in detail["tasks"]] == ["T1", "T2"]
    assert detail["tasks"][0]["checks"] == ["cargo test -p lexer"]
    assert len(detail["tasks"][0]["description"]) == 300
    assert detail["tasks"][1]["depends_on"] == ["T1"]
    assert call("roko_plans", {"plan_id": "missing"})["code"] == "not_found"


# -- status --------------------------------------------------------------------------


def test_status_follows_a_run_to_its_verdict(call: Call, fake: FakeRoko) -> None:
    run_id = call("roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    running = call("roko_status", {"run_id": run_id, "wait_secs": 0})
    done = call("roko_status", {"run_id": run_id, "wait_secs": 0})
    assert running["state"] == "running" and "again" in running["next"]
    assert done["state"] == "succeeded" and "verified" in done["next"]
    assert "links" not in done


@pytest.mark.parametrize(
    ("final", "phrase"),
    [("unverified", "unverified"), ("failed", "did not pass"), ("cancelled", "cancelled")],
)
def test_status_explains_each_ending(call: Call, fake: FakeRoko, final: str, phrase: str) -> None:
    fake.run_script = [final]
    run_id = call("roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    result = call("roko_status", {"run_id": run_id})
    assert result["state"] == final and phrase in result["next"]


def test_status_wait_is_clamped_and_sliced(call: Call, fake: FakeRoko) -> None:
    fake.run_script = ["running"]
    run_id = call("roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    call("roko_status", {"run_id": run_id, "wait_secs": 600})
    waits = [args["wait_secs"] for args in fake.tool_calls("run_status")]
    assert waits and all(0 <= w <= tools.WAIT_CHUNK_SECS for w in waits)


def test_status_lists_what_waits_on_the_person(call: Call, fake: FakeRoko) -> None:
    fake.run_script = ["running"]
    run_id = call("roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    fake.confirms[run_id] = [
        {
            "plan_id": "p",
            "task_id": "T1",
            "title": "Report",
            "attempt_key": "RUN:p:T1:1",
            "question": "Is the report what you asked for?",
            "summary": "report.md: …",
            "held_at": "now",
        }
    ]
    fake.effects.append(
        {
            "effect_id": "effect-1",
            "run_id": run_id,
            "task_id": "T1",
            "tool": "mail.send",
            "server": "mail",
            "arguments": {"to": "string (15 chars)"},
            "proposed_at": "now",
        }
    )
    result = call("roko_status", {"run_id": run_id, "wait_secs": 0})
    kinds = {item["kind"]: item for item in result["waiting_on_person"]}
    assert kinds["confirm"]["decision_id"] == confirmation_id(run_id, "T1", "RUN:p:T1:1")
    assert kinds["effect"]["decision_id"] == effect_decision_id("effect-1")
    assert "roko_decide" in result["next"]


def test_status_of_a_forgotten_plan_generation_reads_the_plan(
    call: Call, fake: FakeRoko, rt: Runtime
) -> None:
    generated = call("roko_plan_generate", {"prompt": "do the thing"})
    del fake.runs[generated["run_id"]]  # roko drops the operation a minute after it ends
    result = call("roko_status", {"run_id": generated["run_id"]})
    assert result["state"] == "succeeded" and result["plan_id"] == generated["plan_id"]
    assert "roko_plans" in result["next"]


def test_status_unknown_run(call: Call) -> None:
    assert call("roko_status", {"run_id": "nope"})["code"] == "not_found"


def test_overview_without_run_id(call: Call, fake: FakeRoko) -> None:
    empty = call("roko_status")
    assert empty["roko"]["status"] == "ok" and empty["note"] == "No runs started from Hermes yet."
    run_id = call("roko_run", {"prompt": "Add a test", "max_usd": 1})["run_id"]
    fake.effects.append({"effect_id": "e9", "run_id": "other", "tool": "post", "server": "x"})
    view = call("roko_status")
    assert view["recent_runs"][0].startswith(f"{run_id} · running")
    assert [item["decision_id"] for item in view["waiting_on_person"]] == ["e_e9"]


# -- cancel, recall, decide --------------------------------------------------------------


def test_cancel(call: Call, fake: FakeRoko, approvals: Approvals, rt: Runtime) -> None:
    fake.run_script = ["running"]
    run_id = call("roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    approvals.asked.clear()
    assert call("roko_cancel", {"run_id": run_id}) == {"run_id": run_id, "state": "cancelled"}
    assert approvals.asked == []  # stopping work needs no approval
    assert rt.runs.get(run_id)["state"] == "cancelled"
    assert call("roko_cancel", {"run_id": run_id})["code"] == "not_found"


def test_recall(call: Call, fake: FakeRoko) -> None:
    fake.knowledge.append(
        {
            "id": "k",
            "content": "parser " + "y" * 900,
            "kind": "Insight",
            "tier": "Working",
            "relevance": 0.7,
            "created_at": "2026",
        }
    )
    result = call("roko_recall", {"query": "parser", "limit": 99})
    assert fake.tool_calls("recall")[-1]["limit"] == 20
    [entry] = result["entries"]
    assert entry["kind"] == "Insight" and entry["confidence"] == 0.7 and len(entry["content"]) == 600
    assert call("roko_recall", {"query": "zebra"})["note"].startswith("roko's knowledge store")


def test_decide_confirmation_with_the_persons_consent(
    call: Call, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.confirms["r1"] = [{"task_id": "T1", "attempt_key": "RUN:p:T1:1", "question": "ok?"}]
    decision_id = confirmation_id("r1", "T1", "RUN:p:T1:1")
    result = call("roko_decide", {"decision_id": decision_id, "approve": True, "note": "looks right"})
    assert result["recorded"]["decision"] == "approved"
    assert approvals.asked[-1]["rule_key"] == f"roko:decide:{decision_id}:approve"
    assert "APPROVE" in approvals.asked[-1]["message"] and "looks right" in approvals.asked[-1]["message"]
    assert "ok?" in approvals.asked[-1]["message"]  # the person sees the question they are answering
    assert fake.tool_calls("confirm_answer")[-1] == {
        "run_id": "r1",
        "task_id": "T1",
        "attempt_key": "RUN:p:T1:1",
        "approve": True,
        "note": "looks right",
    }


def test_decide_effect_rejection(call: Call, fake: FakeRoko) -> None:
    fake.effects.append({"effect_id": "effect-7", "run_id": "r", "tool": "mail.send", "server": "mail"})
    result = call("roko_decide", {"decision_id": "e_effect-7", "approve": "false", "note": "wrong person"})
    assert result["approved"] is False and result["recorded"]["outcome"] == "rejected"


def test_decide_refusals(call: Call, fake: FakeRoko, approvals: Approvals, ctx: FakeContext) -> None:
    assert call("roko_decide", {"decision_id": "zzz", "approve": True})["code"] == "invalid"
    assert call("roko_decide", {"decision_id": "e_x"})["code"] == "invalid"  # approve is required
    approvals.deny()
    fake.effects.append({"effect_id": "e1", "run_id": "r", "tool": "t", "server": "s"})
    assert call("roko_decide", {"decision_id": "e_e1", "approve": True})["code"] == "denied"
    assert fake.tool_calls("effect_decide") == []
    ctx.settings["confirm_decisions"] = False
    assert call("roko_decide", {"decision_id": "e_e1", "approve": True})["recorded"]["outcome"] == "applied"


# -- the contract with Hermes ---------------------------------------------------------------


def test_handlers_never_raise(rt: Runtime, monkeypatch: pytest.MonkeyPatch) -> None:
    handlers = tools.make_handlers(rt)
    assert json.loads(handlers["roko_plans"]("not a dict"))["code"] == "invalid"  # type: ignore[arg-type]

    def broken(*_: Any, **__: Any) -> Any:
        raise RuntimeError("boom")

    monkeypatch.setattr(rt, "client", broken)
    result = json.loads(handlers["roko_plans"]({}))
    assert result["code"] == "internal" and "boom" in result["error"]


def test_unreachable_roko_is_a_clear_error(approvals: Approvals) -> None:
    from conftest import FakeContext

    runtime = Runtime(FakeContext({"url": "http://127.0.0.1:9"}))
    result = json.loads(tools.make_handlers(runtime)["roko_plans"]({}))
    assert result["code"] == "unreachable" and "roko serve" in result["hint"]


def test_results_stay_within_the_size_budget(call: Call, fake: FakeRoko) -> None:
    for index in range(200):
        fake.add_plan(f"plan-{index:03d}", "t" * 500)
    text = json.dumps(call("roko_plans"))
    assert len(text) <= tools.MAX_RESULT_CHARS + 200


def test_schemas_require_what_the_handlers_require() -> None:
    from hermes_plugin_roko.catalog import tool_schemas

    schemas = tool_schemas(5.0)
    assert set(schemas) == set(tools._TOOLS)
    assert schemas["roko_run"]["parameters"]["required"] == ["prompt", "max_usd"]
    assert schemas["roko_plan_run"]["parameters"]["required"] == ["plan_id", "max_usd"]
    assert schemas["roko_decide"]["parameters"]["required"] == ["decision_id", "approve"]
    assert "5.00" in schemas["roko_run"]["parameters"]["properties"]["max_usd"]["description"]
    for schema in schemas.values():
        assert len(schema["description"]) < 1024


def _hermes_calls_it_a_failure(raw: str) -> bool:
    """Hermes 0.21.0's heuristic (agent/display.py::_detect_tool_failure) for non-terminal tools."""
    data = json.loads(raw)
    if (
        isinstance(data, dict)
        and (data.get("error") or data.get("message"))
        and (data.get("success") is False or "error" in data)
    ):
        return True
    lower = raw[:500].lower()
    return '"error"' in lower or '"failed"' in lower or raw.startswith("Error")


def test_healthy_results_do_not_look_like_failures_to_hermes(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """Hermes halts a tool after 8 'failed' calls in a turn; polling a healthy run must never count."""
    handlers = tools.make_handlers(rt)
    fake.add_plan("p1", "Plan")
    fake.run_script = ["queued", "running", "running", "succeeded"]
    run_id = json.loads(handlers["roko_plan_run"]({"plan_id": "p1", "max_usd": 1}))["run_id"]
    for _ in range(4):
        raw = handlers["roko_status"]({"run_id": run_id, "wait_secs": 0})
        assert not _hermes_calls_it_a_failure(raw), raw
    for raw in (
        handlers["roko_status"]({}),
        handlers["roko_plans"]({}),
        handlers["roko_recall"]({"query": "x"}),
    ):
        assert not _hermes_calls_it_a_failure(raw), raw
    assert _hermes_calls_it_a_failure(
        handlers["roko_status"]({"run_id": "nope"})
    )  # a real failure still is one


# -- regressions from the 2026-10-09 review ---------------------------------------------


def test_polls_of_a_waiting_run_are_never_identical(call: Call, fake: FakeRoko) -> None:
    """Hermes halts a gateway turn after 5 identical calls with identical results."""
    fake.run_script = ["running"]
    run_id = call("roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    first = call("roko_status", {"run_id": run_id, "wait_secs": 0})
    second = call("roko_status", {"run_id": run_id, "wait_secs": 0})
    assert first["state"] == second["state"] == "running"
    assert first != second and first["checked_at"] != second["checked_at"]


def test_status_waits_across_slices_until_the_run_ends(
    call: Call, fake: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(tools, "WAIT_CHUNK_SECS", 1)
    fake.timeline = [(0.0, "running"), (2.3, "succeeded")]
    run_id = call("roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    result = call("roko_status", {"run_id": run_id, "wait_secs": 10})
    assert result["state"] == "succeeded" and 1.5 < result["waited_s"] < 8
    assert len(fake.tool_calls("run_status")) >= 3  # several short server-side waits
    assert all(args["wait_secs"] <= 1 for args in fake.tool_calls("run_status"))


def test_decide_refuses_what_roko_does_not_wait_on(call: Call, fake: FakeRoko, approvals: Approvals) -> None:
    from hermes_plugin_roko.decisions import confirmation_id

    result = call("roko_decide", {"decision_id": confirmation_id("r1", "T1", "k"), "approve": True})
    assert result["code"] == "not_found" and approvals.asked == []
    assert call("roko_decide", {"decision_id": "e_gone", "approve": True})["code"] == "not_found"


def test_decide_prompt_names_the_action_and_binds_the_verdict(
    call: Call, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.effects.append(
        {
            "effect_id": "effect-9",
            "run_id": "r",
            "task_id": "T1",
            "tool": "pay.transfer",
            "server": "bank",
            "arguments": {"amount": "number"},
        }
    )
    approvals.deny("BLOCKED: timed out")
    call("roko_decide", {"decision_id": "e_effect-9", "approve": False})
    approvals.answer = (True, None)
    call("roko_decide", {"decision_id": "e_effect-9", "approve": True})
    reject, approve = approvals.asked
    assert "pay.transfer on bank" in approve["message"] and "run r" in approve["message"]
    assert reject["rule_key"] != approve["rule_key"]  # "always" for one verdict never covers the other
    assert approve["rule_key"].endswith(":approve") and reject["rule_key"].endswith(":reject")


def test_a_slow_decision_may_still_have_been_recorded(
    call: Call, fake: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hermes_plugin_roko import decisions

    monkeypatch.setattr(decisions, "ANSWER_TIMEOUT_S", 0.3)
    fake.decide_delay_s = 1.0
    fake.effects.append({"effect_id": "e1", "run_id": "r", "tool": "mail.send", "server": "mail"})
    result = call("roko_decide", {"decision_id": "e_e1", "approve": True})
    assert result["code"] == "unreachable"
    assert "may still have been recorded and the action applied" in result["error"]


def test_a_paid_start_that_times_out_may_have_started(
    rt: Runtime, monkeypatch: pytest.MonkeyPatch, approvals: Approvals
) -> None:
    from hermes_plugin_roko.errors import Code, RokoError

    def slow(*args: Any, **kwargs: Any) -> Any:
        raise RokoError(Code.UNREACHABLE, "did not answer in time", timed_out=True)

    monkeypatch.setattr(rt.client(), "call_tool", slow)
    result = json.loads(tools.make_handlers(rt)["roko_run"]({"prompt": "x", "max_usd": 1}))
    assert "may have started anyway" in result["error"] and "twice" in result["hint"]


def test_lists_never_look_like_failures_to_hermes(call: Call, fake: FakeRoko, rt: Runtime) -> None:
    fake.run_script = ["failed"]
    run_id = call("roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    call("roko_status", {"run_id": run_id})  # the run failed; that status may count as a failure
    fake.add_plan("p", "Plan")
    fake.plans["p"]["status"] = "failed"
    fake.plans["p"]["tasks"] = [{"id": "T1", "title": "t", "status": "failed"}]
    handlers = tools.make_handlers(rt)
    for raw in (
        handlers["roko_status"]({}),
        handlers["roko_plans"]({}),
        handlers["roko_plans"]({"plan_id": "p"}),
    ):
        assert not _hermes_calls_it_a_failure(raw), raw

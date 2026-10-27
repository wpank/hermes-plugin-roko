from __future__ import annotations

import asyncio

from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko.commands import USAGE, make_command, run_command
from hermes_plugin_roko.runtime import Runtime


def test_help_and_unknown(rt: Runtime) -> None:
    assert run_command(rt, "") == USAGE
    assert run_command(rt, "help") == USAGE
    assert run_command(rt, "frobnicate").startswith("Unknown subcommand 'frobnicate'")


def test_handler_returns_a_coroutine_with_text(rt: Runtime) -> None:
    assert asyncio.run(make_command(rt)("help")) == USAGE


def test_status_overview_and_one_run(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    assert "No runs in this project yet." in run_command(rt, "status")
    from hermes_plugin_roko.tools import call

    run_id = call(rt, "roko_run", {"prompt": "Add a test", "max_usd": 1})["run_id"]
    fake.runs[run_id].cost_usd = 0.0123
    overview = run_command(rt, "status")
    assert f"⟳ {run_id[:8]} running" in overview and "Add a test" in overview
    assert "today $0.00 of $20.00" in overview
    one = run_command(rt, "status last")
    assert one.startswith(f"✓ roko run {run_id[:8]} · succeeded")
    assert "gates 1/1 · $0.01 of $1.00 · 42s" in one
    assert "✓ T1 do the work · fake-model · $0.01" in one and "✓ verify[0:test]" in one
    why = run_command(rt, f"status {run_id} why")
    assert "Why: Every gate that ran passed." in why


def test_plans(rt: Runtime, fake: FakeRoko) -> None:
    assert run_command(rt, "plans") == "roko has no plans yet; write one with roko_plan_generate"
    fake.add_plan(
        "p1",
        "Parser",
        [
            {"id": "T1", "title": "lexer", "depends_on": [], "verify": [{"command": "cargo test"}]},
            {"id": "T2", "title": "parser", "depends_on": ["T1"]},
        ],
    )
    assert "p1 · 0/2 tasks · ready" in run_command(rt, "plans")
    detail = run_command(rt, "plans p1")
    assert "2 task(s) in 2 waves" in detail and "estimate: $0.03, about 30s (low confidence)" in detail
    assert "wave 1:\n  · T1 lexer\n      check: cargo test\nwave 2:\n  · T2 parser (after T1)" in detail
    assert run_command(rt, "plans nope").startswith("roko: plan 'nope' not found (not_found)")


def test_pending_then_answer_by_code(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    from hermes_plugin_roko.decisions import confirmation_id, short_code
    from hermes_plugin_roko.tools import call

    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "write the report", "max_usd": 1})["run_id"]
    approvals.asked.clear()
    fake.confirms[run_id] = [
        {
            "plan_id": "p",
            "task_id": "T1",
            "title": "Report",
            "attempt_key": "RUN:p:T1:1",
            "question": "Is this the report you wanted?",
            "summary": "report.md: …",
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
        }
    )
    confirm_code = short_code(confirmation_id(run_id, "T1", "RUN:p:T1:1"))
    effect_code = short_code("e_effect-1")
    listing = run_command(rt, "pending")
    assert f"[{confirm_code}] the result of task T1 (Report)" in listing
    assert f"[{effect_code}] the held action mail.send on mail" in listing
    assert run_command(rt, f"approve {confirm_code} looks good").startswith(
        "Recorded: approved the result of task T1"
    )
    assert run_command(rt, f"reject {effect_code} not to that address").startswith(
        "Recorded: rejected the held action mail.send"
    )
    assert fake.tool_calls("effect_decide")[-1]["note"] == "not to that address"
    assert approvals.asked == []  # the person typed the command; no second prompt
    assert run_command(rt, "pending") == "Nothing waits on you."
    assert "nothing waiting on you has the code" in run_command(rt, f"approve {effect_code}")


def test_a_code_from_one_chat_cannot_approve_another_item(rt: Runtime, fake: FakeRoko) -> None:
    """Codes name the item, not its place in a list another chat may have refreshed."""
    fake.effects.append({"effect_id": "mail-1", "run_id": "r", "tool": "mail.send", "server": "mail"})
    first_listing = run_command(rt, "pending")  # chat 1 sees only mail.send
    code = first_listing.split("]")[0].lstrip("[")
    fake.effects.insert(0, {"effect_id": "pay-1", "run_id": "r", "tool": "pay.transfer", "server": "bank"})
    run_command(rt, "pending")  # chat 2 lists both, pay.transfer first
    assert "mail.send" in run_command(rt, f"approve {code}")
    assert [record["effect_id"] for record in fake.decided] == ["mail-1"]
    assert fake.effects[0]["effect_id"] == "pay-1"  # still waiting, untouched


def test_cancel_and_recall(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    from hermes_plugin_roko.tools import call

    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    assert run_command(rt, "cancel last") == f"⊘ run {run_id[:8]}: cancelled"
    assert run_command(rt, "cancel") == "Usage: /roko cancel RUN_ID (or last)"
    fake.knowledge.append({"content": "parser needs utf-8", "kind": "Insight", "tier": "Working"})
    assert run_command(rt, "recall parser") == "• [Insight/Working] parser needs utf-8"
    assert run_command(rt, "knowledge parser") == "• [Insight/Working] parser needs utf-8"


def test_errors_are_one_line(fake: FakeRoko) -> None:
    from conftest import FakeContext

    runtime = Runtime(FakeContext({"url": "http://127.0.0.1:9"}))
    reply = run_command(runtime, "plans")
    assert reply.startswith("roko: could not reach roko serve") and "\n" not in reply


def test_doctor_without_probe(rt: Runtime) -> None:
    report = run_command(rt, "doctor --no-probe")
    assert "✓ reachable: roko serve 0.1.0" in report and "✓ mcp: all 10" in report
    assert "runs:" not in report

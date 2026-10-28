"""0.8.1 (round v7, the pilot's R1u, phase 5.5's plan write on 0.8.0): a plan writing keeps the person's cap (P-64),
and a writing roko cannot stop is never reported as stopped (P-65).

Asked "… Cap the plan writing at $0.50. Don't run anything yet.", the chat called roko_plan_generate without
max_usd, so roko wrote under its own $2.00 limit (f43afc45). It then called roko_cancel on the writing: roko has no
cancel for a plan writing and answered not_found, and the plugin read that as a run whose serve had died ("roko
serve stopped while this run was going …", state interrupted), while the writing went on and finished. The chat
then wrote the same plan a second time with the cap (c281646c), and both writings spent.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import learning_guard, runend, turns
from hermes_plugin_roko.runtime import Runtime

ASKED = (
    'Use roko to write the plan for phase 5.5 from docs/specs/phase-5.5-auval.md, titled "P5.5 · auval clean". '
    "Cap the plan writing at $0.50. Don't run anything yet."
)
WRITE = {"prompt": "Plan phase 5.5: auval clean", "title": "P5.5 · auval clean"}


def _capped(fake: FakeRoko) -> None:
    fake.tool_args = {"plan_generate": ["prompt", "spec_path", "title", "max_usd"]}


def test_p64_a_writing_the_person_capped_in_words_never_starts_without_the_cap(
    fake: FakeRoko, rt: Runtime, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _capped(fake)
    runend.make_hook(rt)(session_id="session-1", user_message=ASKED, platform="desktop")
    refused = call("roko_plan_generate", WRITE)
    assert refused["success"] is False and refused["code"] == "invalid"
    assert "names a cap ($0.50)" in refused["error"]
    assert "pass the cap they named for writing this plan as max_usd" in refused["hint"]
    assert not learning_guard.teaches_repair(refused["hint"])
    assert approvals.asked == [] and fake.tool_calls("plan_generate") == []  # nothing approved, nothing spent
    fake.run_script = ["running"]
    started = call("roko_plan_generate", {**WRITE, "max_usd": 0.5})
    assert started["run_id"] and fake.tool_calls("plan_generate")[-1]["max_usd"] == 0.5


def test_p64_without_a_cap_in_the_person_s_words_roko_s_own_limit_applies(
    fake: FakeRoko, rt: Runtime, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _capped(fake)
    fake.run_script = ["running"]
    hook = runend.make_hook(rt)
    for n, said in enumerate(
        ("Write the plan for phase 5.5 from its spec.", "Write the plan for the $5 synth.")
    ):
        hook(session_id="session-1", user_message=said)
        started = call("roko_plan_generate", {**WRITE, "title": f"P5.5 · auval clean {n}"})
        assert started["run_id"], said
    # A message as Hermes passes a multimodal turn: its text parts are read.
    turns.remember(
        "s-2", [{"type": "text", "text": "Cap it at 0.4 USD."}, {"type": "image_url", "image_url": {}}]
    )
    assert turns.named_caps(turns.last("s-2")) == [0.4]


def test_p65_cancelling_a_plan_writing_says_roko_cannot_stop_it_and_never_calls_it_interrupted(
    fake: FakeRoko, rt: Runtime, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    _capped(fake)
    fake.run_script = ["running"]
    started = call("roko_plan_generate", WRITE)
    refused = call(
        "roko_cancel", {"run_id": started["run_id"], "reason": "the writing must be capped at $0.50"}
    )
    assert refused["success"] is False and refused["code"] == "refused"
    assert "roko cannot stop a plan writing once it started" in refused["error"]
    assert "it ends by itself" in refused["hint"] and "interrupted" not in refused["error"]
    assert not learning_guard.teaches_repair(refused["hint"])
    assert (rt.runs.get(started["run_id"]) or {}).get("state") == "running"  # not interrupted
    # A second writing of the same plan while the first still writes would spend again: refused, nothing spent.
    again = call("roko_plan_generate", {**WRITE, "max_usd": 0.5})
    assert again["success"] is False and again["code"] == "conflict"
    assert f"roko is still writing this plan ({started['run_id'][:8]})" in again["error"]
    assert len(fake.tool_calls("plan_generate")) == 1
    # Once it ended, the person may have it written again.
    fake.runs[started["run_id"]].states = ["succeeded"]
    assert call("roko_status", {"run_id": started["run_id"], "wait_secs": 0})["state"] == "succeeded"
    assert call("roko_plan_generate", WRITE)["run_id"]

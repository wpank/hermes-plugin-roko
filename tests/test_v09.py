"""Plugin 0.9 (round v8): the chat's words and its first answer.

- PW-1 (hermes-pilot-v8): after the person pressed Reject on Hermes' approval card, the chat said "Roko blocked the
  run". It was the person, in Hermes; roko never saw the call. The tool now says so, and the guidance asks the model
  to say it as the person's choice.
- A first answer's latency: the prompt names roko_plan_generate's spec route and says the arguments are exact, so a
  model can call it without searching for it or reading the spec first; and the plugin logs how long a paid call
  took to reach the person's approval prompt.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

import pytest
from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import prompt

Call = Callable[..., dict[str, Any]]


def test_a_declined_run_is_the_persons_choice_not_roko_blocking_it(
    call: Call, fake: FakeRoko, approvals: Approvals
) -> None:
    approvals.deny(
        "BLOCKED: Action denied by user. The user has NOT consented to this action. Do NOT retry it, do NOT "
        "rephrase it, and do NOT attempt the same outcome via a different path."
    )

    result = call("roko_run", {"prompt": "Add a test for parse()", "max_usd": 0.5})

    assert result["code"] == "denied"
    assert result["error"].startswith(
        "The person declined this in Hermes' approval prompt, so nothing started"
    )
    assert "roko never saw it" in result["error"] and "Do NOT retry" in result["error"]
    assert "BLOCKED" not in result["error"]
    assert "never as roko blocking it" in result["hint"]
    assert fake.tool_calls("run_prompt") == []


def test_an_unanswered_approval_says_nobody_answered(
    call: Call, fake: FakeRoko, approvals: Approvals
) -> None:
    approvals.deny(
        "BLOCKED: Action timed out without user response. The user has NOT consented to this action."
    )

    result = call("roko_plan_run", {"plan_id": "add-tests", "max_usd": 0.5})

    assert result["code"] == "denied"
    assert result["error"].startswith("Nobody answered Hermes' approval prompt in time, so nothing started")
    assert fake.tool_calls("plan_run") == []


def test_another_refusal_keeps_hermes_words(call: Call, approvals: Approvals) -> None:
    approvals.deny("BLOCKED: the approval gate failed (boom); nothing was run.")

    result = call("roko_run", {"prompt": "x", "max_usd": 0.5})

    assert result["error"] == "BLOCKED: the approval gate failed (boom); nothing was run."


def test_a_paid_call_logs_how_long_it_took_to_reach_the_person(
    call: Call, approvals: Approvals, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.INFO, logger="hermes_plugin_roko.tools"):
        call("roko_run", {"prompt": "Add a test for parse()", "max_usd": 0.5})

    [line] = [r.getMessage() for r in caplog.records if "asks the person" in r.getMessage()]
    assert line.startswith("roko: roko_run asks the person ") and line.endswith("s after its call")


def test_the_prompt_gives_the_plan_tools_exact_arguments_and_the_spec_route() -> None:
    fields = {
        "where": "",
        "cap": "$5.00",
        "day": "",
        "asks": prompt.ASKS,
        "desktop": prompt.DESKTOP.format(),
    }
    text = prompt.TEMPLATE.format(**fields)

    assert "roko_plan_generate(prompt or spec_path, title, max_usd)" in text
    assert "Exact arguments: no tool_search." in text

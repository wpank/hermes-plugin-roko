"""0.8.0 (round v7, hermes-pilot P-13): the chat that started a run hears when it ends.

The pilot's chat started phase 0, waited on roko_status for 8 minutes, replied "still running, no spend reported
yet" and ended; nothing told it the run ended an hour later. Now its next turn leads with the outcome (Hermes'
`pre_llm_call` hook), once per ended run and only in the chat that started it; opted in, the plugin sends that
chat one short turn when the run ends.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import pytest
from conftest import FakeContext
from fake_roko import FakeRoko, Run

from hermes_plugin_roko import runend, views
from hermes_plugin_roko.runtime import Runtime

RUN = "0bed5c58-8473-4120-acf4-1f568dca785b"


def _started(rt: Runtime, fake: FakeRoko, session: str, *, kind: str = "plan", **logged: Any) -> None:
    """A run the chat `session` started, logged as still running; roko's run has ended since."""
    fake.runs[RUN] = Run(
        RUN, kind if kind != "plan_generate" else "plan_generate:p2", ["succeeded"], plan_id="p1"
    )
    fake.runs[RUN].cost_usd, fake.runs[RUN].tasks = 1.0204, {"total": 5, "passed": 5, "failed": 0}
    rt.runs.add(RUN, kind, "P1 · Undertow voice", session_id=session, state="running", **logged)


def test_the_chat_that_started_a_run_hears_its_end_once_at_its_next_turn(rt: Runtime, fake: FakeRoko) -> None:
    _started(rt, fake, "s-1", plan_id="p1-undertow-voice")
    hook = runend.make_hook(rt)
    # The hook asks roko about the chat's runs the log says still run: no page needs to be open.
    said = hook(session_id="s-1", user_message="how is it going?", platform="desktop")
    assert said == {
        "context": "[roko] A roko run this chat started has ended since your last reply:\n"
        "- “P1 · Undertow voice” (0bed5c58): succeeded, 5/5 tasks passed, $1.02.\n"
        "Lead your reply with one short line saying so, then answer the person's message."
    }
    assert hook(session_id="s-1") is None  # once
    assert (rt.runs.get(RUN) or {})["told"] is True


def test_no_other_chat_hears_it(rt: Runtime, fake: FakeRoko) -> None:
    _started(rt, fake, "s-1")
    hook = runend.make_hook(rt)
    assert hook(session_id="s-2") is None and hook(session_id="") is None
    assert hook(session_id="s-1") is not None  # still the starting chat's to hear


def test_an_end_the_chat_saw_in_roko_status_is_not_told_again(
    rt: Runtime, fake: FakeRoko, call: Callable[..., dict[str, Any]]
) -> None:
    _started(rt, fake, "session-1")  # the session the test tool calls come from
    assert call("roko_status", {"run_id": RUN})["state"] == "succeeded"
    assert runend.make_hook(rt)(session_id="session-1") is None


def test_another_chat_asking_does_not_count_as_the_starting_chat_hearing_it(
    rt: Runtime, fake: FakeRoko, call: Callable[..., dict[str, Any]]
) -> None:
    _started(rt, fake, "s-1")
    call("roko_status", {"run_id": RUN})  # from session-1
    assert runend.make_hook(rt)(session_id="s-1") is not None


def test_runs_that_ended_before_the_plugin_saw_them_end_are_never_announced(
    rt: Runtime, fake: FakeRoko
) -> None:
    """After an update, a chat's old runs (ended, as an older plugin logged them) are not news."""
    _started(rt, fake, "s-1")
    rt.runs.update(RUN, state="succeeded", cost_usd=1.0204)
    assert runend.make_hook(rt)(session_id="s-1") is None


def test_a_page_that_sees_the_end_leaves_it_for_the_chat(rt: Runtime, fake: FakeRoko) -> None:
    _started(rt, fake, "s-1")
    assert views.card(rt, RUN)["state"] == "succeeded"
    logged = rt.runs.get(RUN) or {}
    assert logged["state"] == "succeeded" and logged["ended_seen_at"]
    said = runend.make_hook(rt)(session_id="s-1")
    assert said is not None and "“P1 · Undertow voice” (0bed5c58): succeeded" in said["context"]


def test_a_plan_writing_that_ended_is_told_as_the_plan_it_wrote(rt: Runtime, fake: FakeRoko) -> None:
    _started(rt, fake, "s-1", kind="plan_generate")
    said = runend.make_hook(rt)(session_id="s-1")
    assert said is not None
    assert "- roko wrote the plan “P1 · Undertow voice” (p1): review it, then run it." in said["context"]


def test_the_follow_up_is_opt_in_and_sends_the_chat_one_turn(fake: FakeRoko) -> None:
    sent: list[tuple[str, str, str | None]] = []

    def inject(
        content: str, role: str = "user", *, session_key: str | None = None, origin: Any = None
    ) -> bool:
        sent.append((content, role, session_key))
        return True

    ctx = FakeContext({"url": fake.url})
    rt = Runtime(ctx)
    try:
        _started(rt, fake, "s-1")
        rt.runs.update(
            RUN, state="succeeded", ended_seen_at="2026-10-20T13:00:00Z", progress={"total": 5, "passed": 5}
        )
        assert runend.follow_up(rt, RUN) is False  # off by default
        ctx.settings["run_end_follow_up"] = True
        assert runend.follow_up(rt, RUN) is False  # this Hermes cannot inject
        ctx.inject_message = inject  # type: ignore[attr-defined]
        assert runend.follow_up(rt, RUN) is True
        assert sent == [
            (
                "[roko] “P1 · Undertow voice” (0bed5c58): succeeded, 5/5 tasks passed. "
                "Tell the person in a line or two; nothing else needs doing.",
                "user",
                "s-1",
            )
        ]
        assert (
            runend.follow_up(rt, RUN) is False and runend.make_hook(rt)(session_id="s-1") is None
        )  # told once
    finally:
        rt.close()


@pytest.mark.parametrize(
    ("run_id", "short"),
    [
        ("6988f0b8-4199-4abf-9cfc-67713bc60e34", "6988f0b8"),
        ("graph-p0-undertow-foundation-ab1c1e59-1111-4222-8333-444455556666", "ab1c1e59"),
        ("r-1", "r-1"),
    ],
)
def test_a_runs_short_id_is_rokos(run_id: str, short: str) -> None:
    from hermes_plugin_roko import rundata

    assert rundata.short_run_id(run_id) == short

"""0.8.0 (round v7): a provider that cannot bill the account, on the card and in the chat (roko 7f20b9578, bug-390e4b).

In phase 3 z.ai's balance ran out: its 429s (code 1113) failed T2's tries, and the ladder climbed as though glm-4.7
had failed the task. roko now takes a provider's own can't-pay answer (z.ai's code 1113, any HTTP 402) as
exhaustion: no retry, no wait and no try spent; failover moves to the next model within the try, and routing skips
the provider until `[routing] exhaustion_cooldown_secs` pass. Its `provider_exhausted` event says why, once per
refusal, and the run's summary lists the providers the run went on without, the latest refusal of each. The card
carries them, the timeline says each in roko's words, and the chat passes roko's line on as it is: that is how the
person learns their credit ran out.
"""

from __future__ import annotations

from typing import Any

from conftest import FakeContext
from fake_roko import FakeRoko, Run

from hermes_plugin_roko import rundata, runend, tools, views
from hermes_plugin_roko.runtime import Runtime

T1 = {"plan_id": "p", "task_id": "T1"}
T2 = {"plan_id": "p", "task_id": "T2"}
ZAI_WORDS = "Insufficient balance or no resource package. Please recharge. (code 1113)"
ZAI_LINE = f"zai: {ZAI_WORDS}: recharge, or the ladder runs without it until 07:12"
PAY_WORDS = "Payment required to access this resource. Visit your billing tab. (code payment_required)"
PAY_LINE = f"cerebras: {PAY_WORDS}: recharge, or the run goes on without it until 07:42"
USAGE_LINE = "codex: You've hit your usage limit. (code usage_limit): skipped until 09:30"


def refusal(
    provider: str, model: str, words: str, line: str, *, billing: bool = True, until: int
) -> dict[str, Any]:
    """A `provider_exhausted` event's fields, as roko-speed's tests shape them (1113 from z.ai, a 402)."""
    return {
        "attempt": 1,
        "provider": provider,
        "model": model,
        "billing": billing,
        "reason": words,
        "until_ms": until,
        "detail": line,
    }


ZAI = refusal("zai", "glm-4.7", ZAI_WORDS, ZAI_LINE, until=1_761_023_520_000)
PAY = refusal("cerebras", "gpt-oss-120b", PAY_WORDS, PAY_LINE, until=1_761_025_320_000)


def _feed(tracker: Any, rows: list[tuple[str, dict[str, Any]]]) -> None:
    for cursor, (kind, event) in enumerate(rows, start=tracker.fold.rows + 1):
        tracker.fold.feed(
            cursor * 100, kind, {"type": kind, "run_id": "r1", "ts_millis": 1_000 + cursor, **event}
        )


def _phase(tracker: Any) -> None:
    """Two tasks on the ladder; z.ai refuses T1's call and, later, T2's; a 402 from Cerebras in between."""
    _feed(
        tracker,
        [
            ("plan_started", {"plan_id": "p", "tasks_total": 2}),
            ("task_started", {**T1, "title": "Scope"}),
            ("agent_spawned", {**T1, "attempt": 1, "model": "glm-4.7"}),
            ("provider_exhausted", {**T1, **ZAI, "until_ms": 1_761_023_000_000}),
            ("task_started", {**T2, "title": "Editor"}),
            ("provider_exhausted", {**T2, **PAY}),
            ("provider_exhausted", {**T2, **ZAI}),
        ],
    )


def test_a_live_card_keeps_each_providers_latest_refusal_in_rokos_words() -> None:
    tracker = rundata.RunTracker("r1")
    _phase(tracker)
    card = rundata._compose(tracker, "r1", "running", {"state": "running"}, {"kind": "plan"})
    gone = card["provider_exhausted"]
    # By provider, as roko's summary lists them; z.ai's latest refusal, with its own `until_ms`.
    assert [item["provider"] for item in gone] == ["cerebras", "zai"]
    assert gone[1] == {
        "provider": "zai",
        "model": "glm-4.7",
        "billing": True,
        "reason": ZAI_WORDS,
        "until_ms": 1_761_023_520_000,
        "detail": ZAI_LINE,
        "at": rundata._iso_ms(1_007),
    }
    assert gone[0]["detail"] == PAY_LINE and gone[0]["billing"] is True
    # The timeline says each refusal, in roko's words, under its task.
    line = rundata.timeline_entry(700, "provider_exhausted", {"type": "provider_exhausted", **T2, **ZAI})
    assert line is not None
    assert (line["text"], line["group"], line["provider"]) == (f"T2 {ZAI_LINE}", "error", "zai")


def test_an_ended_card_lists_what_rokos_summary_lists_and_an_older_roko_none() -> None:
    tracker = rundata.RunTracker("r1")
    _phase(tracker)
    listed = [{**ZAI, "at": "2026-10-21T05:02:11.000Z"}]
    summary = {"state": "succeeded", "cost_usd": 1.2, "provider_exhausted": listed}
    card = rundata._compose(tracker, "r1", "succeeded", summary, {"kind": "plan"})
    assert [(item["provider"], item["detail"], item["at"]) for item in card["provider_exhausted"]] == [
        ("zai", ZAI_LINE, "2026-10-21T05:02:11.000Z")
    ]
    # roko said nothing went without a provider; an older roko says nothing, and its events speak.
    quiet = rundata._compose(
        tracker, "r1", "succeeded", {**summary, "provider_exhausted": []}, {"kind": "plan"}
    )
    assert quiet["provider_exhausted"] == []
    older = rundata._compose(tracker, "r1", "succeeded", {"state": "succeeded"}, {"kind": "plan"})
    assert [item["provider"] for item in older["provider_exhausted"]] == ["cerebras", "zai"]
    # A provider's words are untrusted text: one line, cut short, never markup the page runs.
    odd = rundata.provider_refusal({"provider": "zai\nx", "detail": "a" * 900, "billing": "yes"})
    assert (
        odd is not None
        and odd["provider"] == "zai x"
        and len(odd["detail"]) <= 400
        and odd["billing"] is False
    )
    assert rundata.provider_refusal({"detail": "no provider"}) is None


def test_roko_status_hands_the_chat_rokos_line_to_pass_on() -> None:
    tracker = rundata.RunTracker("r1")
    _phase(tracker)
    card = rundata._compose(tracker, "r1", "running", {"state": "running"}, {"kind": "plan"})
    said = tools.for_model(card, {})
    assert said["provider_exhausted"] == [PAY_LINE, ZAI_LINE]
    assert "as it is" in said["provider_note"] and "recharge" in said["provider_note"]
    assert "provider_exhausted" not in tools.for_model({**card, "provider_exhausted": []}, {})


def _ended_run(fake: FakeRoko, run_id: str, listed: list[dict[str, Any]]) -> None:
    fake.runs[run_id] = Run(run_id, "plan", ["succeeded"], plan_id="p3")
    fake.runs[run_id].cost_usd, fake.runs[run_id].tasks = 0.9085, {"total": 2, "passed": 2, "failed": 0}
    fake.runs[run_id].summary_extra = {"provider_exhausted": listed}


def test_the_chat_that_started_the_run_hears_rokos_line_when_it_ends(fake: FakeRoko) -> None:
    run_id = "7b8cb121-0000-4000-8000-000000000001"
    _ended_run(fake, run_id, [{**ZAI, "at": "2026-10-21T05:02:11.000Z"}])
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        rt.runs.add(run_id, "plan", "P3 · Undertow hypnotic sequencer", session_id="s-1", state="running")
        news = runend.make_hook(rt)(session_id="s-1") or {}
        context = news.get("context") or ""
        assert f"“{ZAI_LINE}”" in context  # roko's own line, as it is
        assert "quote roko's words about the provider" in context and "recharge" in context
        kept = (rt.runs.get(run_id) or {})["provider_exhausted"]
        assert kept == [{"provider": "zai", "billing": True, "detail": ZAI_LINE}]
    finally:
        rt.close()


def test_a_page_that_saw_the_end_keeps_the_line_for_the_chat_and_a_usage_window_asks_nothing(
    fake: FakeRoko,
) -> None:
    run_id = "7b8cb121-0000-4000-8000-000000000002"
    usage = refusal(
        "codex",
        "gpt-5.4",
        "You've hit your usage limit. (code usage_limit)",
        USAGE_LINE,
        billing=False,
        until=1,
    )
    _ended_run(fake, run_id, [usage])
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        rt.runs.add(run_id, "plan", "P3 · Undertow hypnotic sequencer", session_id="s-1", state="running")
        views.card(rt, run_id)  # the page sees the end first
        assert (rt.runs.get(run_id) or {})["provider_exhausted"] == [
            {"provider": "codex", "billing": False, "detail": USAGE_LINE}
        ]
        context = (runend.make_hook(rt)(session_id="s-1") or {}).get("context") or ""
        # A usage window that resets on its own is news, not a chore: roko's line, no ask to recharge.
        assert f"“{USAGE_LINE}”" in context and "recharge" not in context.replace(USAGE_LINE, "")
    finally:
        rt.close()

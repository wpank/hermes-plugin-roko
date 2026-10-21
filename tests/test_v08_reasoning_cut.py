"""0.8.0 (round v7): replies roko stopped because they only reasoned (roko e43dfa53e, gap-f3f950).

glm-4.7 reasoned for minutes at a time with no text and no tool call. roko now stops a streamed reply that has
reasoned for 3/8 of the model's output limit (12,288 of glm-4.7's 32,768 tokens) and asks again in the same try; a
second such reply in a row ends the try. Each stop is a `reasoning_cut` event, and the run's summary lists them. The
card carries them and roko_status gives the chat roko's line for each; the page's stream row waits until glm-4.7 runs
again (phases 4 and 5 run on OpenAI, whose reasoning is not streamed, so no cut happens there).
"""

from __future__ import annotations

from typing import Any

from hermes_plugin_roko import rundata, tools

T1 = {"plan_id": "p", "task_id": "T1"}
ACTED = (
    "glm-4.7 reasoned 12288 tokens in 330 s with no tool call, past its limit of 12288: roko stopped it and asked "
    "again, about 550 s sooner; the re-ask made a tool call"
)
AGAIN = (
    "glm-4.7 reasoned 12301 tokens in 341 s with no tool call, past its limit of 12288: roko stopped it and asked "
    "again, about 566 s sooner; the re-ask was cut too, which ended the try"
)


def cut(turn: int, tokens: int, secs: float, saved: float, reask: str, line: str) -> dict[str, Any]:
    """A `reasoning_cut` event's fields, as roko-speed sent them."""
    return {
        **T1,
        "attempt": 1,
        "turn": turn,
        "model": "glm-4.7",
        "reasoning_tokens": tokens,
        "limit_tokens": 12_288,
        "secs": secs,
        "saved_secs": saved,
        "reask": reask,
        "detail": line,
    }


def _feed(tracker: Any, rows: list[tuple[str, dict[str, Any]]]) -> None:
    for cursor, (kind, event) in enumerate(rows, start=tracker.fold.rows + 1):
        tracker.fold.feed(
            cursor * 100, kind, {"type": kind, "run_id": "r1", "ts_millis": 1_000 + cursor, **event}
        )


def _run() -> Any:
    tracker = rundata.RunTracker("r1")
    _feed(
        tracker,
        [
            ("plan_started", {"plan_id": "p", "tasks_total": 1}),
            ("task_started", {**T1, "title": "Sequencer"}),
            ("agent_spawned", {**T1, "attempt": 1, "model": "glm-4.7"}),
            ("reasoning_cut", cut(3, 12_288, 330.0, 550.0, "acted", ACTED)),
            ("reasoning_cut", cut(5, 12_301, 341.2, 566.4, "cut_again", AGAIN)),
        ],
    )
    return tracker


def test_a_live_card_lists_each_reply_roko_stopped_in_rokos_words() -> None:
    card = rundata._compose(_run(), "r1", "running", {"state": "running"}, {"kind": "plan"})
    assert card["reasoning_cuts"] == [
        {
            "task_id": "T1",
            "attempt": 1,
            "turn": 3,
            "model": "glm-4.7",
            "reasoning_tokens": 12_288,
            "limit_tokens": 12_288,
            "secs": 330.0,
            "saved_secs": 550.0,
            "reask": "acted",
            "detail": ACTED,
            "at": rundata._iso_ms(1_004),
        },
        {
            "task_id": "T1",
            "attempt": 1,
            "turn": 5,
            "model": "glm-4.7",
            "reasoning_tokens": 12_301,
            "limit_tokens": 12_288,
            "secs": 341.2,
            "saved_secs": 566.4,
            "reask": "cut_again",
            "detail": AGAIN,
            "at": rundata._iso_ms(1_005),
        },
    ]
    # No stream line yet: the page draws its row once a cut can happen again (the lead, 2026-10-21).
    assert (
        rundata.timeline_entry(
            400, "reasoning_cut", {"type": "reasoning_cut", **cut(3, 1, 1, 1, "acted", ACTED)}
        )
        is None
    )


def test_an_ended_card_lists_what_rokos_summary_lists() -> None:
    listed = [{**cut(3, 12_288, 330.0, 550.0, "acted", ACTED), "at": "2026-10-21T05:02:11.000Z"}]
    card = rundata._compose(
        _run(), "r1", "failed", {"state": "failed", "reasoning_cuts": listed}, {"kind": "plan"}
    )
    assert [(one["turn"], one["detail"], one["at"]) for one in card["reasoning_cuts"]] == [
        (3, ACTED, "2026-10-21T05:02:11.000Z")
    ]
    # roko said none; an older roko says nothing, and the run's events speak.
    quiet = rundata._compose(
        _run(), "r1", "failed", {"state": "failed", "reasoning_cuts": []}, {"kind": "plan"}
    )
    assert quiet["reasoning_cuts"] == []
    older = rundata._compose(_run(), "r1", "failed", {"state": "failed"}, {"kind": "plan"})
    assert [one["reask"] for one in older["reasoning_cuts"]] == ["acted", "cut_again"]


def test_a_cut_is_untrusted_text_and_bounded() -> None:
    odd = rundata.reasoning_cut({**T1, "detail": "a\nb " + "x" * 900, "reask": "nonsense", "secs": "slow"})
    assert odd is not None
    assert "\n" not in odd["detail"] and len(odd["detail"]) <= 400
    assert odd["reask"] is None and odd["secs"] is None
    assert rundata.reasoning_cut({"detail": "no task"}) is None
    # A card keeps the newest MAX_CUTS.
    tracker = rundata.RunTracker("r1")
    rows = [
        ("reasoning_cut", cut(n, 12_288, 1.0, 1.0, "acted", f"cut {n}"))
        for n in range(1, rundata.MAX_CUTS + 4)
    ]
    _feed(tracker, rows)
    kept = rundata._compose(tracker, "r1", "running", {"state": "running"}, {"kind": "plan"})[
        "reasoning_cuts"
    ]
    assert len(kept) == rundata.MAX_CUTS and kept[-1]["detail"] == f"cut {rundata.MAX_CUTS + 3}"


def test_roko_status_gives_the_chat_rokos_line_for_each_cut() -> None:
    card = rundata._compose(_run(), "r1", "running", {"state": "running"}, {"kind": "plan"})
    assert tools.for_model(card, {})["reasoning_cuts"] == [ACTED, AGAIN]
    assert "reasoning_cuts" not in tools.for_model({**card, "reasoning_cuts": []}, {})

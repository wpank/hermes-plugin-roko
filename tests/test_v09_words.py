"""The backend's words for checks and model picks are the design system's (§6), on every page and in the chat.

Round v8's jargon sweep: a page said "picked by the model ladder (rung cheap)", "switched by a failover", a check's
own name (`verify[1:test]`), "gates 1/1" and "no gate ran". A check is "check 2 (test)" now, a model pick says where
the try runs ("started on the cheapest model", "moved up to a stronger model"), and the run's one line counts checks.
"""

from __future__ import annotations

import re

import pytest

from hermes_plugin_roko import loopevents, render, rundata


@pytest.mark.parametrize(
    ("name", "words"),
    [
        ("verify[0:test]", "check 1 (test)"),
        ("verify[1:compile]", "check 2 (compile)"),
        ("verify:2/lint", "check 3 (lint)"),
        ("lint[1:clippy]", "check 2 (clippy)"),
        ("rung[test]", "project check (test)"),
        ("custom:lint", "lint"),
        ("pre_verify:no_changes", "pre-check (no changes)"),
        ("spec_gate", "spec check"),
        ("clippy", "clippy"),
    ],
)
def test_a_check_reads_by_its_place_and_kind_not_its_name(name: str, words: str) -> None:
    assert loopevents.check_name(name) == words


def test_a_runs_lines_name_its_checks_in_words() -> None:
    started = rundata.timeline_entry(
        1, "gate_rung_started", {"plan_id": "p", "task_id": "T2", "rung_name": "verify[1:test]"}
    )
    ended = rundata.timeline_entry(
        2, "gate_result", {"plan_id": "p", "task_id": "T2", "gate": "rung[test]", "passed": False}
    )
    assert started is not None and started["text"] == "Task 2 · running check 2 (test)"
    assert ended is not None and ended["text"] == "Task 2 · project check (test) did not pass"
    # The check's own name stays on the line for the pages' tooltips and keys.
    assert started["gate"] == "verify[1:test]" and ended["gate"] == "rung[test]"


@pytest.mark.parametrize(
    ("route", "words"),
    [
        # roko's ladder_step counts rungs above the task's own start rung, never above the cheapest: without the
        # run's models a first try's place stays unsaid.
        (
            {"decided_by": "ladder", "ladder_reason": "start", "ladder_step": 0},
            "started where its kind of task starts",
        ),
        ({"decided_by": "ladder", "ladder_reason": "start", "ladder_step": 1}, "started on a stronger model"),
        (
            {"decided_by": "ladder", "ladder_reason": "climb", "ladder_step": 1},
            "moved up to a stronger model",
        ),
        (
            {"decided_by": "ladder", "ladder_reason": "retry", "ladder_step": 0},
            "tried again on the same model",
        ),
        ({"decided_by": "ladder", "ladder_reason": "failover"}, "switched to another provider"),
        ({"decided_by": "ladder", "rung": "cheap"}, "started where its kind of task starts"),
        ({"decided_by": "learned"}, "picked by what roko learned"),
    ],
)
def test_a_model_pick_says_where_the_try_runs_never_the_ladder(route: dict[str, object], words: str) -> None:
    assert loopevents.route_words(route) == words


def test_a_failover_switches_to_another_provider() -> None:
    ctx = loopevents.LoopContext()
    event = {
        "plan_id": "p",
        "task_id": "T1",
        "attempt": 1,
        "model": "glm-5.1",
        "source": "failover",
        "reason": "gpt-5.4-mini timed out",
    }
    [loop] = loopevents.loop_events("route_decided", event, ctx)
    assert loop["text"] == "Task 1 · try 1 switched to another provider: glm-5.1 (gpt-5.4-mini timed out)"


def test_the_runs_one_line_counts_checks() -> None:
    passed = {"state": "succeeded", "kind": "plan", "gates": {"passed": 1, "failed": 0, "total": 1}}
    assert rundata.headline(passed).startswith("succeeded · checks 1/1")
    assert (
        rundata.headline({"state": "failed", "kind": "plan", "gates": {}, "why": {}})
        == "failed · no check ran"
    )


def test_the_roko_commands_name_checks_in_words() -> None:
    task = {
        "task_id": "T1",
        "outcome": "running",
        "rung": "verify[1:test]",
        "gates": [{"gate": "verify[0:compile]", "passed": True}, {"gate": "rung[test]", "passed": False}],
    }
    head, marks = render._task_lines(task)
    assert head.endswith("Task 1 · running check 2 (test)")
    assert marks == "      ✓ check 1 (compile)  ✗ project check (test)"
    why = {
        "summary": "…",
        "gates_not_passed": [{"task_id": "T1", "gate": "verify[0:test]", "output": "boom"}],
    }
    assert "\n  Task 1 · check 1 (test):\n    boom" in render.card({"run_id": "r1", "state": "failed"}, why)
    assert render.gates([]) == "roko has recorded no check results yet."
    # roko's verdict on its tasks, beside the checks, is each task's result.
    assert "  ⚠ task result · 90% of 10" in render.gates(
        [{"gate": "task verdict", "pass_rate": 0.9, "total": 10}]
    )
    assert render.gates([{"gate": "verify[0:test]", "pass_rate": 1.0, "total": 4}]) == (
        "Checks across roko's workspace (pass rate, runs):\n  ✓ check 1 (test) · 100% of 4"
    )


# A project's models, cheapest first, as the plugin reads them (rundata.CardCache.ladder_view): integrative tasks
# start on mid, architectural ones on top (rundata.LADDER_STARTS).
MODELS = [
    {"rung": "cheap", "slug": "gpt-oss-120b", "model": "oss", "chat_ok": True},
    {"rung": "mid", "slug": "gpt-5.4-mini", "model": "mini", "chat_ok": True},
    {"rung": "top", "slug": "gpt-5.4", "model": "gpt-5.4", "chat_ok": True},
]


def _first_try(task: str, rung: str, model: str) -> dict[str, object]:
    return {
        "plan_id": "p",
        "task_id": task,
        "attempt": 1,
        "model": model,
        "rung": rung,
        "source": "ladder",
        "ladder_reason": "start",
        "ladder_step": 0,
    }


def test_a_first_try_says_its_models_level_in_the_run_never_the_cheapest_by_default() -> None:
    """plugin-wow-v8's find: a first try's ladder_step is 0 on its tier's start rung, so an integrative task's
    first try on mid and an architectural one's on top both read "started on the cheapest model"."""
    ctx = loopevents.LoopContext(ladder=MODELS)
    [mid] = loopevents.loop_events("route_decided", _first_try("T2", "mid", "gpt-5.4-mini"), ctx)
    [top] = loopevents.loop_events("route_decided", _first_try("T3", "top", "gpt-5.4"), ctx)
    [cheap] = loopevents.loop_events("route_decided", _first_try("T1", "cheap", "gpt-oss-120b"), ctx)
    assert mid["text"] == "Task 2 · try 1 → gpt-5.4-mini, started on the middle model"
    assert top["text"] == "Task 3 · try 1 → gpt-5.4, started on the strongest model"
    assert cheap["text"] == "Task 1 · try 1 → gpt-oss-120b, started on the cheapest model"
    # A rung runs from a chat cannot use is no place of theirs, unless the try ran on it.
    cli = [*MODELS[:2], {"rung": "strong", "slug": "claude", "chat_ok": False}, MODELS[2]]
    assert [loopevents.model_place(cli, rung) for rung in ("cheap", "mid", "top")] == [
        "the cheapest model",
        "the middle model",
        "the strongest model",
    ]
    assert loopevents.model_place(cli, "strong") == "a stronger model"
    # Without the run's models, never a guess.
    [unknown] = loopevents.loop_events(
        "route_decided", _first_try("T2", "mid", "gpt-5.4-mini"), loopevents.LoopContext()
    )
    assert unknown["text"] == "Task 2 · try 1 → gpt-5.4-mini, started where its kind of task starts"


# What the plugin's own words must never say again (design system §6.4): a task's raw id ("T1 wrote …"), roko's
# engine names, the ladder, a rung, a climb, a gate, a raw check name, or 0.8's Changes tab.
BANNED = re.compile(
    r"\bT\d+\b|homeostat|\bM1\b|tier_floor|model ladder|\brungs?\b|\bclimb|\bgates?\b|verify\[|"
    r"in Changes|Changes shows|false green",
    re.IGNORECASE,
)


def test_the_feed_the_why_and_the_next_step_say_what_happened_in_plain_words() -> None:
    ctx = loopevents.LoopContext(ladder=MODELS)
    said: list[str] = []
    for kind, event in (
        ("route_decided", _first_try("T2", "mid", "gpt-5.4-mini")),
        ("ev.update", {"ev": "pass_rate", "value": 0.62, "bound": 0.7, "state": "breached"}),
        ("ev.update", {"ev": "false_green", "value": 0.0, "bound": 0.05, "state": "ok"}),
        ("m1.episode", {"episode_id": "m1-8", "phase": "hold", "change": "tier_floor: cheap -> mid"}),
        ("m1.episode", {"episode_id": "m1-9", "phase": "idle"}),
        ("playbook_written", {"task_id": "T1", "plan_id": "p", "goal": "Slugify text in textkit"}),
    ):
        said += [loop["text"] for loop in loopevents.loop_events(kind, event, ctx)]
    assert said[1:] == [
        "pass rate 62% (kept at 70% or more) · out of bounds",
        "passed but wrong 0% (kept at 5% or less)",
        "roko changed the model tasks start on: gpt-oss-120b → gpt-5.4-mini",
        "roko is holding: nothing needs changing",
        "Task 1 wrote a playbook: Slugify text in textkit",
    ]
    refused = rundata.timeline_entry(
        3,
        "event_log_entry",
        {
            "event_type": "spec.gate.refused",
            "task_id": "T1",
            "message": "HF3: verify passes on the unchanged base",
        },
    )
    assert refused is not None and refused["text"].startswith("Task 1 was refused before it ran: ")
    said.append(refused["text"].split(": ")[0])
    step = rundata.next_action(
        {
            "state": "failed",
            "kind": "plan",
            "why": {
                "refused_request": {"task_id": "T1", "words": "the provider refuses tool results over 1 MB."}
            },
        }
    )
    assert step is not None and step["why"].startswith("Task 1 failed on a request its provider refuses: ")
    said.append(step["why"])
    found = [text for text in said if BANNED.search(text)]
    assert found == []

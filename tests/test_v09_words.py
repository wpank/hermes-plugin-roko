"""The backend's words for checks and model picks are the design system's (§6), on every page and in the chat.

Round v8's jargon sweep: a page said "picked by the model ladder (rung cheap)", "switched by a failover", a check's
own name (`verify[1:test]`), "gates 1/1" and "no gate ran". A check is "check 2 (test)" now, a model pick says where
the try runs ("started on the cheapest model", "moved up to a stronger model"), and the run's one line counts checks.
"""

from __future__ import annotations

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
        (
            {"decided_by": "ladder", "ladder_reason": "start", "ladder_step": 0},
            "started on the cheapest model",
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
        ({"decided_by": "ladder", "rung": "cheap"}, "started on the cheapest model"),
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

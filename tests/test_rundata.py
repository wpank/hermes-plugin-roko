from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import rundata, views
from hermes_plugin_roko.rundata import EventFold, fmt_duration, fmt_money, headline
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.sanitize import clean, clean_tree
from hermes_plugin_roko.tools import call

FIXTURE = Path(__file__).parent / "fixtures" / "roko_plan_run_events.json"


def real_rows() -> list[dict[str, Any]]:
    """The event index of a real plan run (roko serve 856ed7570, 2026-10-09), as /events served it."""
    return json.loads(FIXTURE.read_text())["events"]


# -- sanitize --------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("plain", "plain"),
        ("\x1b[31mred\x1b[0m", "red"),
        ("title\x1b]0;pwned\x07 here", "title here"),
        ("osc\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\", "osclink"),
        ("bell\x07 and nul\x00", "bell and nul"),
        ("c1\x9bcontrol", "c1control"),
        ("rtl ‮evil‬ ok", "rtl evil ok"),
        ("isolate⁦x⁩", "isolatex"),
        ("tab\tand\nnewline", "tab\tand\nnewline"),
    ],
)
def test_clean_strips_what_could_rewrite_a_terminal(raw: str, expected: str) -> None:
    assert clean(raw) == expected


def test_clean_one_line_and_limit() -> None:
    assert clean("a\n  b\tc", one_line=True) == "a b c"
    assert clean("x" * 10, 5) == "xxxx…"
    assert clean(None) == "" and clean(3) == "3"
    assert clean_tree({"a": ["\x1b[1mb", {"c": "‮d"}], "n": 1}) == {"a": ["b", {"c": "d"}], "n": 1}


# -- folding a real event index ---------------------------------------------------


def test_fold_of_a_real_plan_run() -> None:
    fold = EventFold()
    for row in real_rows():
        fold.feed(row["cursor"], row["type"], row["event"])
    # roko's own summary reports $0 and no gates for this run; the events say otherwise.
    assert fold.saw_cost and round(fold.cost_usd, 6) == 0.01027
    assert fold.tokens == {"input": 3352, "output": 655, "cache_read": 10368, "cache_write": 0}
    assert fold.gate_counts == {"passed": 1, "failed": 0, "total": 1}
    [(key, task)] = fold.tasks.items()
    assert key == ("add-two-new-functions-to-the-existing-src-lib-rs", "T1")
    assert task.title == "Add pow and abs_diff functions with tests to src/lib.rs"
    assert (task.outcome, task.model, task.provider, task.attempts) == ("passed", "glm-5.1", "zai", 1)
    assert (
        task.gates["verify[0:test]"].excerpt()
        == "$ cargo test 2>&1 | grep 'test result' | grep -q '3 passed'"
    )
    assert fold.completed == {"outcome": "succeeded", "duration_ms": 42210}
    texts = [line["text"] for line in fold.timeline]
    assert texts[0] == "loaded plan add-two-new-functions-to-the-existing-src-lib-rs"
    assert "T1 attempt 1 on glm-5.1 (zai)" in texts and "T1 gate verify[0:test] passed" in texts
    assert texts[-1] == "run succeeded in 42s"
    assert not any("heartbeat" in text or "efficiency" in text for text in texts)


def test_a_prompt_runs_own_plan_is_called_the_run() -> None:
    rid = "e15cd28a-678b-48c5-a85c-21c93e11e382"
    fold = EventFold()
    fold.feed(1, "plan_set_loaded", {"run_id": rid, "plans": [{"plan_id": rid, "tasks_total": 1}]})
    fold.feed(2, "plan_started", {"run_id": rid, "plan_id": rid, "tasks_total": 1})
    fold.feed(3, "plan_completed", {"run_id": rid, "plan_id": rid, "success": True})
    fold.feed(4, "run_completed", {"run_id": rid, "outcome": "succeeded", "duration_ms": 37_000})
    assert [line["text"] for line in fold.timeline] == [
        "run set up",
        "run started (1 task)",
        "run succeeded in 37s",
    ]
    milestones = rundata._milestones(
        {"milestones": [{"kind": "started", "text": f"plan {rid} started"}]}, rid
    )
    assert milestones[0]["text"] == "run started"


def test_fold_ignores_synthetic_and_phantom_rows() -> None:
    fold = EventFold()
    fold.feed(1, "task_started", {"plan_id": "run-e13f6327", "task_id": "In the repository…", "title": ""})
    fold.feed(2, "agent_spawned", {"plan_id": "run-e13f6327", "task_id": "x", "model": "claude"})
    fold.feed(3, "task_started", {"plan_id": "", "task_id": "", "title": "phantom"})
    assert fold.tasks == {} and list(fold.timeline) == []


def test_fold_keeps_the_latest_gate_verdict_and_counts_reruns() -> None:
    fold = EventFold()
    base = {"plan_id": "p", "task_id": "T1"}
    fold.feed(
        1, "gate_result", {**base, "gate": "verify[0:test]", "passed": False, "output_text": "$ t\nboom"}
    )
    fold.feed(2, "agent_spawned", {**base, "attempt": 1, "model": "m2"})
    fold.feed(3, "gate_result", {**base, "gate": "verify[0:test]", "passed": True, "output_text": "$ t\nok"})
    gate = fold.tasks[("p", "T1")].gates["verify[0:test]"]
    assert gate.passed and gate.runs == 2 and fold.tasks[("p", "T1")].attempts == 2
    assert fold.gate_counts == {"passed": 1, "failed": 0, "total": 1}


def test_a_failing_gate_excerpt_is_the_end_of_its_output() -> None:
    fold = EventFold()
    output = "$ cargo test\n" + "noise\n" * 100 + "error[E0308]: mismatched types"
    fold.feed(
        1,
        "gate_result",
        {"plan_id": "p", "task_id": "T1", "gate": "g", "passed": False, "output_text": output},
    )
    excerpt = fold.tasks[("p", "T1")].gates["g"].excerpt()
    assert excerpt.endswith("error[E0308]: mismatched types") and len(excerpt) <= 200


def test_fold_rejects_nonsense_measurements() -> None:
    fold = EventFold()
    for value in (float("nan"), -1.0, "lots"):
        fold.feed(
            1, "efficiency_event", {"plan_id": "p", "task_id": "T1", "metric": "cost_usd", "value": value}
        )
    assert fold.cost_usd == 0.0 and not fold.saw_cost


# -- cards from the fake roko --------------------------------------------------------


def test_card_of_a_finished_run(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "Add clamp()\x1b[2J with a test", "max_usd": 0.5})["run_id"]
    fake.runs[run_id].cost_usd = 0.0103
    card = views.card(rt, run_id)
    assert (
        card["state"] == "succeeded" and card["kind"] == "run" and card["label"] == "Add clamp() with a test"
    )
    assert card["cost_usd"] == 0.0103 and card["max_usd"] == 0.5
    assert card["tokens"] == {"input": 1000, "output": 200, "cache_read": 50, "cache_write": 0}
    started = fake.runs[run_id].created_at
    assert card["started_at"] == started.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    assert card["finished_at"] is not None and card["finished_at"] > card["started_at"]
    assert card["duration_ms"] == 42_000 and card["gates"] == {"passed": 1, "failed": 0, "total": 1}
    [task] = card["tasks"]
    assert task["task_id"] == "T1" and task["outcome"] == "passed" and task["model"] == "fake-model"
    assert "plan_id" not in task  # one plan: no need to say which
    assert card["headline"] == "succeeded · gates 1/1 · $0.01 of $0.50 · 42s"
    assert card["origin"] == "mcp:local" and card["session_id"] is None
    # The run log learned the real cost, and that it is final.
    logged = rt.runs.get(run_id)
    assert logged["cost_usd"] == 0.0103 and logged["cost_final"] is True


def test_a_finished_card_is_read_once(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    views.card(rt, run_id)
    before = len([r for r in fake.requests if r["path"].endswith("/events")])
    views.card(rt, run_id)
    views.card(rt, run_id)
    assert len([r for r in fake.requests if r["path"].endswith("/events")]) == before


def test_an_active_card_reads_only_new_rows(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["running", "running", "succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    first = views.card(rt, run_id)
    assert first["state"] == "running" and first["tasks"][0]["outcome"] == "running"
    assert first["cost_usd"] is None and "gates" not in first["headline"]
    cursor = rt.cards.tracker(fake.url, run_id).fold.cursor
    views.card(rt, run_id)
    cursors = [
        int(r["query"]["cursor"]) for r in fake.requests if r["path"].endswith("/events") and "query" in r
    ]
    assert cursors[-1] == cursor  # the second poll asked only for what came after
    final = views.card(rt, run_id)
    assert final["state"] == "succeeded" and final["tasks"][0]["outcome"] == "passed"


def test_card_of_a_queued_run_has_no_index_yet(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.add_plan("p1")
    fake.add_plan("p2")
    fake.run_script = ["running"]
    call(rt, "roko_plan_run", {"plan_id": "p1", "max_usd": 1})
    second = call(rt, "roko_plan_run", {"plan_id": "p2", "max_usd": 1})["run_id"]
    card = views.card(rt, second)
    assert card["state"] == "queued" and card["tasks"] == [] and card["headline"].startswith("queued")


def test_card_rereads_after_the_index_was_rewritten(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    views.card(rt, run_id)
    rt.cards.tracker(fake.url, run_id).fold.cursor = 7  # not a row boundary: roko answers 400
    card = views.card(rt, run_id)
    assert card["tasks"][0]["task_id"] == "T1" and card["events_read"] > 0


def test_plan_run_card_lists_tasks_that_have_not_started(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.add_plan(
        "p1",
        "two tasks",
        [
            {"id": "T1", "title": "first", "depends_on": []},
            {"id": "T2", "title": "second", "depends_on": ["T1"]},
        ],
    )
    fake.run_script = ["running"]
    run_id = call(rt, "roko_plan_run", {"plan_id": "p1", "max_usd": 1})["run_id"]
    fake.runs[run_id].plan_id = "p1"
    card = views.card(rt, run_id)
    assert card["kind"] == "plan" and card["plan_id"] == "p1"
    assert [(t["task_id"], t["outcome"]) for t in card["tasks"]] == [("T1", "running"), ("T2", "pending")]
    assert card["tasks"][1]["depends_on"] == ["T1"]


def test_explain_a_run_that_did_not_pass(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["failed"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    card = views.card(rt, run_id)
    why = rundata.explain(rt.cards, fake.url, card)
    assert why["summary"] == "Task T1's gate verify[0:test] did not pass."
    [gate] = why["gates_not_passed"]
    assert gate["output"].endswith("test result: 1 did not pass")


def test_explain_an_unverified_run(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["unverified"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    card = views.card(rt, run_id)
    assert card["headline"].startswith("unverified · no gate ran")
    assert "No gate checked T1" in rundata.explain(rt.cards, fake.url, card)["summary"]


# -- formatting ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("value", "text"),
    [(None, "—"), (0, "$0.00"), (0.004, "$0.004"), (0.0103, "$0.01"), (1.5, "$1.50"), (True, "—")],
)
def test_money(value: Any, text: str) -> None:
    assert fmt_money(value) == text


@pytest.mark.parametrize(
    ("ms", "text"), [(0, "0s"), (42_210, "42s"), (190_000, "3m10s"), (3_900_000, "1h05m")]
)
def test_duration(ms: int, text: str) -> None:
    assert fmt_duration(ms) == text


def test_headline_never_calls_unverified_a_pass() -> None:
    card = {"state": "unverified", "gates": {"total": 0}, "cost_usd": None, "max_usd": 1.0}
    assert headline(card) == "unverified · no gate ran · — of $1.00"
    waiting = {"state": "running", "gates": {}, "waiting": [{}], "elapsed_ms": 61_000}
    assert headline(waiting) == "running · 1m01s · 1 waiting on you"


def test_a_part_that_fails_leaves_a_gap_not_an_error(
    rt: Runtime, fake: FakeRoko, approvals: Approvals, monkeypatch: pytest.MonkeyPatch
) -> None:
    from hermes_plugin_roko.errors import Code, RokoError

    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]

    def broken(self: Any, client: Any, terminal: bool) -> None:
        raise RokoError(Code.SERVER, "bundle exploded \x1b[31m")

    monkeypatch.setattr(rundata.RunTracker, "refresh_bundle", broken)
    card = views.card(rt, run_id)
    assert card["state"] == "succeeded" and card["gates"]["total"] == 1
    assert card["problems"] == ["bundle exploded "] and card["started_at"] is None
    assert rt.cards.tracker(fake.url, run_id).final is None  # not kept: the next look tries again


def test_error_messages_from_roko_are_cleaned() -> None:
    from hermes_plugin_roko.errors import Code, RokoError

    exc = RokoError(Code.REFUSED, "no\x1b]0;title\x07 way \u202eevil", hint="try \x1b[1mthis")
    assert exc.message == "no way evil" and exc.hint == "try this" and str(exc) == "no way evil"

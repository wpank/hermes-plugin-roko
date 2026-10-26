"""0.8.0 (round v7, P-54, the pilot's R3i): a resumed run's receipt covers the whole Graph run.

Phase 5.1's run 814a7340 failed (T1 passed on mid, T3 climbed to strong, T2 failed on mid and then died at $0
four times), and serve run 4728d22e resumed it: only T2's fifth try ran, on mid, and passed. roko writes every
invocation's tries into the Graph run's folder (814a7340's attempts.jsonl, `inv` 1 and 2), and the resume's
summary says what it carried ($0.936718). Its receipt read "LADDER 3 passed on mid · nothing above … this cost 3.7×
less … 2 tasks didn't pass: not compared": T1 and T3 sat on their start rung with no try, and the $0.10 it spent
alone was set against the top rung. Now the resume's card reads the Graph run's folder, so its tasks carry every
invocation's tries and their rungs, and the receipt sets the whole run's spend (carried plus its own) against them.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from conftest import FakeContext

from hermes_plugin_roko import rundata, views
from hermes_plugin_roko.runtime import Runtime

PLAN = "p5-1-ship-fixes"
ROOT = "814a7340-a01c-42ed-a60c-349ab875eb1e"
RESUME = "4728d22e-268c-472f-8a2d-76447195e746"
LADDER = [
    {"rung": "cheap", "model": "gpt-oss-120b", "slug": "gpt-oss-120b", "price_in": 0.35, "price_out": 0.75},
    {"rung": "mid", "model": "gpt-5.4-mini", "slug": "gpt-5.4-mini", "price_in": 0.75, "price_out": 4.5},
    {"rung": "strong", "model": "gpt-5.4", "slug": "gpt-5.4", "price_in": 2.5, "price_out": 15.0},
    {
        "rung": "top",
        "model": "claude-sonnet-4-6",
        "slug": "claude-sonnet-4-6",
        "price_in": 3.0,
        "price_out": 15.0,
    },
]


def _verdict(
    task: str, attempt: int, outcome: str, rung: str | None, usd: float | None, inv: int
) -> dict[str, Any]:
    model = {"mid": "gpt-5.4-mini", "strong": "gpt-5.4"}.get(rung or "")
    return {
        "schema_version": "roko.verdict/1",
        "run_id": ROOT,
        "plan_id": PLAN,
        "task_id": task,
        "attempt": attempt,
        "inv": inv,
        "outcome": outcome,
        "blame": "agent" if outcome == "gate_failed" else "harness" if outcome == "harness_error" else None,
        "ladder": {"rung": rung, "reason": "escalated" if rung == "strong" else "start"} if rung else {},
        "executed": {"model_dispatched": model, "provider": "openai"} if model else {},
        "cost": {"billed_usd": usd} if usd is not None else {},
        "usage": {"tokens_in": 40_000, "tokens_out": 4_000} if model else {},
    }


# 814a7340's attempts.jsonl, as roko wrote it: the first invocation's eight tries and the resume's one.
RECORDS = [
    _verdict("T1", 1, "passed", "mid", 0.078069, 1),
    _verdict("T3", 1, "gate_failed", "mid", 0.190336, 1),
    _verdict("T2", 1, "gate_failed", "mid", 0.220196, 1),
    _verdict("T2", 2, "harness_error", None, None, 1),
    _verdict("T2", 3, "harness_error", None, None, 1),
    _verdict("T2", 4, "harness_error", None, None, 1),
    _verdict("T3", 2, "gate_failed", "mid", 0.199151, 1),
    _verdict("T3", 3, "passed", "strong", 0.241874, 1),
    _verdict("T2", 5, "passed", "mid", 0.103414, 2),
]


def _resume_tracker(workdir: Path) -> rundata.RunTracker:
    """4728d22e's tracker after its events: roko replays T1 and T3 as passed, and runs only T2's fifth try."""
    tracker = rundata.RunTracker(RESUME)
    rows = [
        ("plan_started", {"plan_id": PLAN, "tasks_total": 3}),
        ("task_completed", {"plan_id": PLAN, "task_id": "T1", "outcome": "passed"}),
        ("task_completed", {"plan_id": PLAN, "task_id": "T3", "outcome": "passed"}),
        ("task_started", {"plan_id": PLAN, "task_id": "T2", "title": "the shipped check"}),
        (
            "attempt_settled",
            {
                "plan_id": PLAN,
                "task_id": "T2",
                "attempt": 5,
                "verdict": "passed",
                "rung": "mid",
                "reason": "retry",
                "model": "gpt-5.4-mini",
                "provider": "openai",
                "cost_usd": 0.103414,
                "usage": {"input": 40_000, "output": 4_000},
            },
        ),
        ("task_completed", {"plan_id": PLAN, "task_id": "T2", "outcome": "passed"}),
    ]
    for cursor, (kind, event) in enumerate(rows, start=1):
        tracker.fold.feed(cursor, kind, {"type": kind, "run_id": RESUME, "ts_millis": cursor, **event})
    path = workdir / ".roko" / "runs" / ROOT / "attempts.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in RECORDS))
    return tracker


def _tries(task: dict[str, Any]) -> list[tuple[Any, ...]]:
    return [(one["attempt"], one["rung"], one["reason"], one["outcome"]) for one in task["climb"]]


def test_a_resumed_runs_tasks_carry_every_invocations_tries_from_the_graph_runs_folder(
    tmp_path: Path,
) -> None:
    tracker = _resume_tracker(tmp_path)
    tracker.refresh_attempts(tmp_path, graph=ROOT)
    t1, t3, t2 = (rundata._task_card(task, ladder=LADDER, ended=True) for task in tracker.task_rows())
    assert (t1["task_id"], _tries(t1)) == ("T1", [(1, "mid", "start", "passed")])
    assert (t3["task_id"], _tries(t3)) == (
        "T3",
        [(1, "mid", "start", "failed"), (2, "mid", "retry", "failed"), (3, "strong", "climb", "passed")],
    )
    assert [one[0] for one in _tries(t2)] == [1, 2, 3, 4, 5] and _tries(t2)[-1] == (
        5,
        "mid",
        "retry",
        "passed",
    )
    # The run that was resumed keeps its own tries: a later invocation's are not its own (P-51b).
    first = rundata.RunTracker(ROOT)
    first.fold.feed(
        1, "task_started", {"type": "task_started", "run_id": ROOT, "plan_id": PLAN, "task_id": "T2"}
    )
    for attempt in (1, 2, 3, 4):
        settled = {"plan_id": PLAN, "task_id": "T2", "attempt": attempt, "verdict": "gate_failed"}
        first.fold.feed(
            1 + attempt, "attempt_settled", {"type": "attempt_settled", "run_id": ROOT, **settled}
        )
    first.refresh_attempts(tmp_path)
    [own] = (rundata._task_card(task, ladder=LADDER, ended=True) for task in first.task_rows())
    assert [one[0] for one in _tries(own)] == [1, 2, 3, 4]


def test_a_resumed_runs_receipt_sets_the_whole_runs_spend_against_every_passing_try(tmp_path: Path) -> None:
    tracker = _resume_tracker(tmp_path)
    tracker.refresh_attempts(tmp_path, graph=ROOT)
    tasks = [rundata._task_card(task, ladder=LADDER, ended=True) for task in tracker.task_rows()]
    card = {"tasks": tasks, "ladder": LADDER, "cost_usd": 0.103414, "carried_usd": 0.936718, "progress": None}
    receipt = rundata.receipt(card)
    assert (receipt["cost_usd"], receipt["carried_usd"]) == (1.040132, 0.936718)
    assert {rung: row["passed"] for rung, row in (receipt["by_rung"] or {}).items()} == {
        "mid": 2,
        "strong": 1,
    }
    assert receipt["not_compared"] == 0 and receipt["climbs"] == 1
    # Three passing tries at the top rung's list prices, plus the run's helper calls (all it spent less its
    # tries), against all the run spent, carried and its own.
    tried = sum(record["cost"].get("billed_usd") or 0.0 for record in RECORDS)
    top = 3 * (40_000 * 3.0 + 4_000 * 15.0) / 1_000_000 + (1.040132 - tried)
    assert receipt["top_rung_usd"] == round(top, 6) and receipt["ratio"] == round(top / 1.040132, 1)
    assert "the whole run, its earlier invocation's tries included" in receipt["basis"]


def test_a_resumed_runs_graph_run_is_the_first_of_its_chain_of_resumes(tmp_path: Path) -> None:
    rt = Runtime(FakeContext({"workdir": str(tmp_path)}))
    try:
        rt.runs.add(ROOT, "plan", "P5.1", plan_id=PLAN)
        rt.runs.add("b" * 8 + ROOT[8:], "plan", "P5.1", plan_id=PLAN)
        rt.runs.update("b" * 8 + ROOT[8:], resumes=ROOT)
        rt.runs.add(RESUME, "plan", "P5.1", plan_id=PLAN)
        rt.runs.update(RESUME, resumes="b" * 8 + ROOT[8:])
        assert views.graph_run(rt, RESUME) == ROOT
        assert views.graph_run(rt, ROOT) is None
    finally:
        rt.close()

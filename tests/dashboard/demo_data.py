"""Workspace-wide numbers for the replay roko (gates, models, spend), derived from the dogfood recordings.

`seed_insights(server)` gives a `FakeRoko` the `/api/gates/summary`, `/api/learn/model-scorecard` and
`/api/learn/efficiency` answers roko serve would have after the recorded runs, so the Insights views have
real figures to draw. Used by make_fixtures.py and by the live screenshot session.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime, timedelta
from typing import Any

from replay_roko import FIXTURES


def seed_insights(server: Any) -> None:
    gates: dict[str, dict[str, Any]] = defaultdict(lambda: {"passed": 0, "failed": 0, "ms": []})
    tasks: dict[tuple[str, str], dict[str, Any]] = {}
    for name, fixture in FIXTURES.items():
        rung_started: dict[str, int] = {}
        for row in fixture["events"]:
            event = row["event"]
            kind = row["type"]
            key = (name, str(event.get("task_id")))
            ts = event.get("ts_millis")
            if kind == "gate_rung_started":
                rung_started[str(event.get("task_id"))] = ts if isinstance(ts, int) else 0
            elif kind == "gate_result":
                stats = gates[str(event.get("gate"))]
                stats["passed" if event.get("passed") else "failed"] += 1
                began = rung_started.get(str(event.get("task_id")))
                if isinstance(ts, int) and began:
                    stats["ms"].append(max(1, ts - began))
            elif kind == "efficiency_event" and event.get("metric") == "cost_usd":
                task = tasks.setdefault(key, {"cost": 0.0, "at": ts, "passed": None})
                task["cost"] += float(event.get("value") or 0.0)
                task["at"] = ts if isinstance(ts, int) else task["at"]
            elif kind == "task_completed":
                task = tasks.setdefault(key, {"cost": 0.0, "at": ts, "passed": None})
                task["passed"] = event.get("outcome") == "passed"
    now = datetime.now(UTC)
    summary = {}
    for gate, stats in gates.items():
        total = stats["passed"] + stats["failed"]
        summary[gate] = {
            "total_runs": total,
            "passed_runs": stats["passed"],
            "failed_runs": stats["failed"],
            "pass_rate": stats["passed"] / total if total else None,
            "avg_duration_ms": sum(stats["ms"]) / len(stats["ms"]) if stats["ms"] else None,
            "last_run": {"model": "glm-5.1", "timestamp": (now - timedelta(minutes=18)).isoformat()},
        }
    server.gates_summary = summary
    finished = [t for t in tasks.values() if t["passed"] is not None]
    passed = sum(1 for t in finished if t["passed"])
    total_cost = sum(t["cost"] for t in tasks.values())
    server.scorecard = [
        {
            "model_slug": "glm-5.1",
            "task_count": len(finished),
            "success_rate": passed / len(finished) if finished else None,
            "total_cost_usd": round(total_cost, 6),
            "avg_cost_usd": round(total_cost / max(1, len(finished)), 6),
            "total_tokens": 412_880,
        }
    ]
    # The recordings span an afternoon; spread the points over the last two hours, in their order.
    ordered = sorted(tasks.values(), key=lambda t: t["at"] or 0)
    first = ordered[0]["at"] if ordered else 0
    last = ordered[-1]["at"] if ordered else 1
    span = max(1, last - first)
    trend = []
    cumulative = 0.0
    for task in ordered:
        if task["cost"] <= 0:
            continue
        cumulative += task["cost"]
        at = (
            now
            - timedelta(minutes=120)
            + timedelta(milliseconds=(task["at"] - first) * (110 * 60_000) / span)
        )
        trend.append(
            {
                "timestamp": at.isoformat(timespec="seconds"),
                "cost_usd": round(task["cost"], 6),
                "cumulative_cost_usd": round(cumulative, 6),
            }
        )
    server.cost_trend = trend

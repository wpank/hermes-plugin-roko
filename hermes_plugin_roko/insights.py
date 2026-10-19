"""Read-only views of what roko has learned: gate pass rates, models, spend over time, effects.

Insights come in two scopes, each labelled with its period:

- `hermes` (the default): the runs Hermes started, from the plugin's run log and what each run's card
  recorded there (its checks, its models, its spend);
- `workspace`: every run in roko's workspace, from roko serve's own routes, which this module reshapes for
  `/roko` and the UIs.

A task no check ran on is unverified, never failed: the checks' pass rate counts only checks that ran.
"""

from __future__ import annotations

import re
import statistics
from collections import Counter
from datetime import UTC, datetime
from typing import Any

from . import loopevents
from .client import RokoClient
from .errors import RokoError
from .sanitize import clean

MAX_GATES = 30
MAX_MODELS = 20
MAX_TREND = 60
MAX_DECIDED = 30
SCOPES = ("hermes", "workspace")
HERMES_LABEL = "runs started from Hermes"
WORKSPACE_LABEL = "every run in roko's workspace"
# roko's name for a task's overall verdict, which counts a task no check ran on as not passed.
VERDICT = "task verdict"
# roko names one rung two ways: `verify[0:test]` in run events and
# `verify:0/test` in the ledger and efficiency log.
_LEDGER_RUNG = re.compile(r"^verify:(\d+)/(.+)$")


def gates(client: RokoClient) -> list[dict[str, Any]]:
    """Pass rate per gate across the workspace, most-run first."""
    body = client.get("/api/gates/summary")
    if not isinstance(body, dict):
        return []
    merged: dict[str, dict[str, Any]] = {}
    for name, stats in body.items():
        if name == "rungs" or not isinstance(stats, dict):
            continue
        gate = _gate_name(clean(name, 120, one_line=True))
        total = _int(stats.get("total_runs"))
        last = stats.get("last_run")
        last_run: dict[str, Any] = last if isinstance(last, dict) else {}
        row: dict[str, Any] = {
            "gate": gate,
            "pass_rate": _rate(stats.get("pass_rate")),
            "passed": _int(stats.get("passed_runs")),
            "failed": _int(stats.get("failed_runs")),
            "total": total,
            "avg_duration_ms": round(_float(stats.get("avg_duration_ms")) or 0) or None,
            "last_at": _last_at(last_run),
            "last_model": clean(last_run.get("model"), 80, one_line=True) or None,
        }
        # The two names count the same runs from two logs: keep the fuller one.
        if gate not in merged or total > merged[gate]["total"]:
            merged[gate] = row
    rows = sorted(merged.values(), key=lambda row: (-row["total"], row["gate"]))
    return rows[:MAX_GATES]


def models(client: RokoClient) -> list[dict[str, Any]]:
    body = client.get("/api/learn/model-scorecard")
    rows = body.get("models") if isinstance(body, dict) else None
    out: list[dict[str, Any]] = []
    for row in rows if isinstance(rows, list) else []:
        if not isinstance(row, dict):
            continue
        out.append(
            {
                "model": clean(row.get("model_slug"), 80, one_line=True),
                # roko's task_count counts its efficiency rows (attempts, or their calls), not tasks (dogfood
                # U6); `tasks` keeps the same number for older pages.
                "attempts": _int(row.get("task_count")),
                "tasks": _int(row.get("task_count")),
                "success_rate": _rate(row.get("success_rate")),
                "total_cost_usd": _float(row.get("total_cost_usd")),
                "avg_cost_usd": _float(row.get("avg_cost_usd")),
                "total_tokens": _int(row.get("total_tokens")),
            }
        )
    out.sort(key=lambda row: (-row["tasks"], row["model"]))
    return out[:MAX_MODELS]


def efficiency(client: RokoClient) -> dict[str, Any]:
    """Workspace spend: the totals and the cost of each recent task, oldest first."""
    body = client.get("/api/learn/efficiency")
    if not isinstance(body, dict):
        return {"cost_trend": []}
    trend = []
    for point in body.get("cost_trend") or []:
        if isinstance(point, dict):
            trend.append(
                {
                    "at": clean(point.get("timestamp"), 40, one_line=True) or None,
                    "cost_usd": _float(point.get("cost_usd")),
                    "cumulative_usd": _float(point.get("cumulative_cost_usd")),
                }
            )
    return {
        "total_cost_usd": _float(body.get("total_cost")),
        "cost_per_task_usd": _float(body.get("cost_per_task")),
        "avg_task_duration_ms": round(_float(body.get("avg_task_duration")) or 0) or None,
        "tasks_recorded": len(trend),
        "cost_trend": trend[-MAX_TREND:],
    }


def effects(client: RokoClient) -> dict[str, Any]:
    """Held actions still waiting, and the decisions already made, newest first."""
    body = client.call_tool("effects_pending", {})
    decided_rows = body.get("decided") if isinstance(body, dict) else None
    decided = []
    for record in decided_rows if isinstance(decided_rows, list) else []:
        if not isinstance(record, dict):
            continue
        receipts = [
            {
                "rung": clean(receipt.get("rung"), 60, one_line=True),
                "passed": bool(receipt.get("passed")),
                "output": clean(receipt.get("output"), 300),
            }
            for receipt in record.get("receipts") or []
            if isinstance(receipt, dict)
        ][:5]
        decided.append(
            {
                "effect_id": clean(record.get("effect_id"), 80, one_line=True),
                "run_id": clean(record.get("run_id"), 80, one_line=True),
                "task_id": clean(record.get("task_id"), 80, one_line=True) or None,
                "tool": clean(record.get("tool"), 80, one_line=True),
                "server": clean(record.get("server"), 80, one_line=True),
                "outcome": clean(record.get("outcome"), 40, one_line=True),
                "decided_by": clean(record.get("decided_by"), 80, one_line=True) or None,
                "note": clean(record.get("note"), 300) or None,
                "decided_at": clean(record.get("decided_at"), 40, one_line=True) or None,
                "receipts": receipts,
            }
        )
    waiting = body.get("waiting") if isinstance(body, dict) else None
    return {
        "waiting": len(waiting) if isinstance(waiting, list) else 0,
        "decided": decided[:MAX_DECIDED],
    }


def knowledge(client: RokoClient, query: str | None, limit: int) -> list[dict[str, Any]]:
    """Knowledge entries matching `query`, best first; without a query, the most cited."""
    if query:
        body = client.get("/api/knowledge/search", {"q": query, "k": limit})
        rows = body.get("results") if isinstance(body, dict) else None
        return [
            {
                "id": clean(row.get("id"), 80, one_line=True),
                "content": clean(row.get("content"), 1_200),
                "kind": clean(row.get("kind"), 40, one_line=True) or None,
                "tier": clean(row.get("tier"), 40, one_line=True) or None,
                "score": _float(row.get("score")),
                "confidence": _rate(row.get("confidence")),
                "confirmations": _int(row.get("confirmations")),
                "created_at": _unix_or_text(row.get("created_at")),
            }
            for row in (rows if isinstance(rows, list) else [])[:limit]
            if isinstance(row, dict)
        ]
    body = client.get("/api/knowledge/entries", {"limit": limit})
    items = body.get("items") if isinstance(body, dict) else None
    return [
        {
            "id": clean(row.get("id"), 80, one_line=True),
            "content": clean(row.get("label"), 1_200),
            "kind": clean(row.get("domain"), 40, one_line=True) or None,
            "tier": None,
            "score": None,
            "confidence": _rate(row.get("confidence")),
            "confirmations": _int(row.get("citations")),
            "created_at": None,
        }
        for row in (items if isinstance(items, list) else [])[:limit]
        if isinstance(row, dict)
    ]


def workspace_view(
    gates_rows: list[dict[str, Any]],
    model_rows: list[dict[str, Any]],
    spend: dict[str, Any],
    problems: list[str],
) -> dict[str, Any]:
    """`GET /insights?scope=workspace`: roko's own numbers for every run in its workspace."""
    rows = [{**row, "kind": "verdict" if row["gate"] == VERDICT else "check"} for row in gates_rows]
    ran = [row for row in rows if row["kind"] == "check"]
    passed = sum(row["passed"] for row in ran)
    failed = sum(row["failed"] for row in ran)
    verdict = next((row for row in rows if row["kind"] == "verdict"), None)
    trend = list(spend.get("cost_trend") or [])
    stamps = [point["at"] for point in trend if point.get("at")]
    efficiency = {key: value for key, value in spend.items() if key != "cost_trend"}
    tasks = (
        {
            "total": verdict["total"],
            "verified": verdict["passed"],
            # roko's verdict counts a task no check ran on with the failed ones: they cannot be told apart.
            "unverified": None,
            "failed": None,
            "not_verified": verdict["failed"],
        }
        if verdict
        else {"total": efficiency.get("tasks_recorded"), "verified": None, "unverified": None, "failed": None}
    )
    return {
        "scope": {
            "kind": "workspace",
            "label": WORKSPACE_LABEL,
            "since": min(stamps, default=None),
            "until": max(stamps, default=None),
        },
        "summary": {
            "runs": None,
            "tasks": tasks,
            "checks": {
                "passed": passed,
                "failed": failed,
                "ran": passed + failed,
                "pass_rate": round(passed / (passed + failed), 4) if passed + failed else None,
            },
            "spend_usd": efficiency.get("total_cost_usd"),
            "cost_per_task_usd": efficiency.get("cost_per_task_usd"),
            "typical_task_ms": efficiency.get("avg_task_duration_ms"),
        },
        "gates": rows,
        "models": model_rows,
        "cost_trend": trend,
        "efficiency": efficiency,
        "problems": problems,
    }


def hermes_view(runs: list[dict[str, Any]]) -> dict[str, Any]:
    """`GET /insights?scope=hermes`: the runs Hermes started, from the plugin's run log.

    Each finished run's card left its checks (each task's last verdict per check) and its models there;
    a task no check ran on counts as unverified, never as failed.
    """
    runs = [run for run in runs if run.get("kind") in ("run", "plan")]
    states = Counter(str(run.get("state") or "unknown") for run in runs)
    tasks = Counter[str]()
    checks: dict[str, list[int]] = {}
    models: dict[str, dict[str, Any]] = {}
    spent = 0.0
    trend: list[tuple[str, float]] = []
    per_task_ms: list[float] = []
    for run in runs:
        counts: dict[str, Any] = run["progress"] if isinstance(run.get("progress"), dict) else {}
        tasks["total"] += _int(counts.get("total"))
        tasks["verified"] += _int(counts.get("passed"))
        tasks["unverified"] += _int(counts.get("unverified"))
        tasks["failed"] += _int(counts.get("failed")) + _int(counts.get("blocked"))
        for name, tally in (run.get("checks") or {}).items() if isinstance(run.get("checks"), dict) else ():
            if isinstance(tally, list) and len(tally) == 2:
                total = checks.setdefault(str(name), [0, 0])
                total[0] += _int(tally[0])
                total[1] += _int(tally[1])
        for model, row in (run.get("models") or {}).items() if isinstance(run.get("models"), dict) else ():
            if not isinstance(row, dict):
                continue
            seen = models.setdefault(str(model), {"tasks": 0, "verified": 0, "unverified": 0, "cost": 0.0})
            seen["tasks"] += _int(row.get("tasks"))
            seen["verified"] += _int(row.get("verified"))
            seen["unverified"] += _int(row.get("unverified"))
            seen["cost"] += _float(row.get("cost_usd")) or 0.0
        cost = _float(run.get("cost_usd"))
        if cost is not None and (run.get("cost_final") or run.get("state") not in _ENDED):
            spent += cost
            trend.append((str(run.get("finished_at") or run.get("started_at") or ""), cost))
        took = _between(run.get("started_at"), run.get("finished_at"))
        if took and _int(counts.get("total")):
            per_task_ms.append(took / _int(counts.get("total")))
    trend.sort()
    cumulative = 0.0
    cost_trend = []
    for at, cost in trend[-MAX_TREND:]:
        cumulative += cost
        cost_trend.append(
            {"at": at or None, "cost_usd": round(cost, 6), "cumulative_usd": round(cumulative, 6)}
        )
    passed = sum(tally[0] for tally in checks.values())
    failed = sum(tally[1] for tally in checks.values())
    stamps = [str(run.get("started_at")) for run in runs if run.get("started_at")]
    ends = [str(run.get("finished_at") or run.get("started_at")) for run in runs if run.get("started_at")]
    ordered_checks = sorted(checks.items(), key=lambda item: (-sum(item[1]), item[0]))[:MAX_GATES]
    gate_rows: list[dict[str, Any]] = [
        {
            "gate": name,
            "kind": "check",
            "pass_rate": round(tally[0] / (tally[0] + tally[1]), 4) if sum(tally) else None,
            "passed": tally[0],
            "failed": tally[1],
            "total": tally[0] + tally[1],
            "avg_duration_ms": None,
            "last_at": None,
            "last_model": None,
        }
        for name, tally in ordered_checks
    ]
    ordered_models = sorted(models.items(), key=lambda item: (-int(item[1]["tasks"]), item[0]))[:MAX_MODELS]
    model_rows: list[dict[str, Any]] = [
        {
            "model": clean(model, 80, one_line=True),
            "tasks": entry["tasks"],
            "success_rate": round(entry["verified"] / entry["tasks"], 4) if entry["tasks"] else None,
            "unverified": entry["unverified"],
            "total_cost_usd": round(entry["cost"], 6),
            "avg_cost_usd": round(entry["cost"] / entry["tasks"], 6) if entry["tasks"] else None,
            "total_tokens": None,
        }
        for model, entry in ordered_models
    ]
    total_tasks = tasks["total"]
    typical = round(statistics.median(per_task_ms)) if per_task_ms else None
    return {
        "scope": {
            "kind": "hermes",
            "label": HERMES_LABEL,
            "since": min(stamps, default=None),
            "until": max(ends, default=None),
        },
        "summary": {
            "runs": {
                "total": len(runs),
                "succeeded": states["succeeded"],
                "unverified": states["unverified"],
                "failed": states["failed"],
                "cancelled": states["cancelled"],
                "interrupted": states["interrupted"],
                "missing": states["missing"],
                "running": sum(states[state] for state in ("running", "queued", "unknown")),
            },
            "tasks": {key: tasks[key] for key in ("total", "verified", "unverified", "failed")},
            "checks": {
                "passed": passed,
                "failed": failed,
                "ran": passed + failed,
                "pass_rate": round(passed / (passed + failed), 4) if passed + failed else None,
            },
            "spend_usd": round(spent, 6),
            "cost_per_task_usd": round(spent / total_tasks, 6) if total_tasks else None,
            "typical_task_ms": typical,
        },
        "gates": gate_rows,
        "models": model_rows,
        "cost_trend": cost_trend,
        "efficiency": {
            "total_cost_usd": round(spent, 6),
            "cost_per_task_usd": round(spent / total_tasks, 6) if total_tasks else None,
            "avg_task_duration_ms": typical,
            "tasks_recorded": total_tasks,
        },
        "problems": [],
    }


_ENDED = frozenset({"succeeded", "failed", "unverified", "cancelled", "interrupted", "missing"})


def _between(start: Any, end: Any) -> float | None:
    try:
        first = datetime.fromisoformat(str(start).replace("Z", "+00:00"))
        last = datetime.fromisoformat(str(end).replace("Z", "+00:00"))
    except ValueError:
        return None
    if first.tzinfo is None:
        first = first.replace(tzinfo=UTC)
    if last.tzinfo is None:
        last = last.replace(tzinfo=UTC)
    took = (last - first).total_seconds() * 1000
    return took if took > 0 else None


def safe(fn: Any, *args: Any) -> tuple[Any, str | None]:
    """`fn(*args)`, or (None, the reason) when roko could not answer: for views made of parts."""
    try:
        return fn(*args), None
    except RokoError as exc:
        return None, exc.message


def _gate_name(name: str) -> str:
    if name == "terminal":  # roko's name for a task's overall verdict
        return "task verdict"
    match = _LEDGER_RUNG.match(name)
    return f"verify[{match.group(1)}:{match.group(2)}]" if match else name


def _last_at(run: Any) -> str | None:
    if not isinstance(run, dict):
        return None
    if isinstance(run.get("timestamp"), str):
        return clean(run["timestamp"], 40, one_line=True)
    stamp = run.get("timestamp_ms")
    if isinstance(stamp, (int, float)) and stamp > 0:
        return datetime.fromtimestamp(stamp / 1000, UTC).isoformat(timespec="seconds")
    return None


def _unix_or_text(value: Any) -> str | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
        return datetime.fromtimestamp(value, UTC).isoformat(timespec="seconds")
    if isinstance(value, str):
        return clean(value, 40, one_line=True) or None
    return None


def _rate(value: Any) -> float | None:
    number = _float(value)
    if number is None:
        return None
    return round(min(1.0, max(0.0, number)), 4)


def _float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _int(value: Any) -> int:
    number = _float(value)
    return int(number) if number is not None else 0


# -- roko's five loops (GET /loops) -------------------------------------------------------

MAX_ROUTES = 10
MAX_DIAGNOSES = 10


def _rows(body: Any, *keys: str) -> list[Any]:
    """A route's rows: the body itself when it is a list, else the first list under one of `keys`."""
    if isinstance(body, list):
        return body
    if isinstance(body, dict):
        for key in keys:
            rows = body.get(key)
            if isinstance(rows, list):
                return rows
    return []


def loop_registry(client: RokoClient) -> list[dict[str, Any]]:
    """L4: every registered loop and its audit state (`GET /api/learn/loops`)."""
    rows = _rows(client.get("/api/learn/loops"), "loops", "rows")
    return [
        {
            "loop_id": clean(row.get("loop_id"), 40, one_line=True),
            "lifecycle": clean(row.get("lifecycle"), 40, one_line=True) or None,
            "state": clean(row.get("state"), 40, one_line=True) or None,
            "reason": clean(row.get("reason"), 120, one_line=True) or None,
            "h": _float(row.get("h")),
            "n_opp": _int(row.get("n_opp")) if row.get("n_opp") is not None else None,
            "eps": _float(row.get("eps")),
            "iota_net": _float(row.get("iota_net")),
            "beta": _float(row.get("beta")),
        }
        for row in rows
        if isinstance(row, dict) and row.get("loop_id")
    ][:40]


def route_decisions(client: RokoClient, limit: int = MAX_ROUTES) -> list[dict[str, Any]]:
    """L1: the router's latest picks, newest first (`GET /api/learn/loops/L-route/decisions`)."""
    from .loopevents import route_candidates

    rows = _rows(client.get("/api/learn/loops/L-route/decisions", {"limit": limit}), "decisions", "rows")
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        inner = row.get("record")
        record: dict[str, Any] = inner if isinstance(inner, dict) else row
        out.append(
            {
                "ts": clean(row.get("ts") or record.get("timestamp"), 40, one_line=True) or None,
                "task_id": clean(record.get("task_id"), 80, one_line=True) or None,
                "attempt_key": clean(record.get("attempt_key"), 200, one_line=True) or None,
                "model": clean(record.get("selected_model") or record.get("chosen"), 80, one_line=True)
                or None,
                "provider": clean(record.get("selected_provider"), 60, one_line=True) or None,
                "stage": clean(record.get("routing_stage"), 60, one_line=True) or None,
                "reason": clean(record.get("routing_reason"), 300, one_line=True) or None,
                "source": clean(record.get("source"), 40, one_line=True) or None,
                "p": _float(record.get("chosen_propensity", record.get("propensity"))),
                "candidates": route_candidates(record.get("candidates")),
                "outcome": record.get("outcome_success")
                if isinstance(record.get("outcome_success"), bool)
                else None,
                "cost_usd": _float(record.get("outcome_cost_usd")),
            }
        )
    return out[:limit]


def retry_budgets(client: RokoClient) -> list[dict[str, Any]]:
    """L1: what roko's adaptive thresholds say each rung deserves (`GET /api/learn/adaptive-thresholds`)."""
    rows = _rows(client.get("/api/learn/adaptive-thresholds"), "rungs")
    return [
        {
            "rung": clean(row.get("rung"), 60, one_line=True),
            "ema_pass_rate": _rate(row.get("ema_pass_rate")),
            "observations": _int(row.get("total_observations")),
            "consecutive_passes": _int(row.get("consecutive_passes")),
            "suggested_max_retries": _int(row.get("suggested_max_retries"))
            if row.get("suggested_max_retries") is not None
            else None,
            "should_skip": row.get("should_skip_rung") is True,
        }
        for row in rows
        if isinstance(row, dict) and row.get("rung") is not None
    ][:20]


def diagnoses(client: RokoClient) -> list[dict[str, Any]]:
    """L2: the conductor's and the watchdogs' latest interventions (`GET /api/diagnosis/recent`)."""
    rows = _rows(client.get("/api/diagnosis/recent"), "diagnoses", "items", "recent")
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        ident = clean(row.get("id"), 200, one_line=True)
        out.append(
            {
                "id": ident or None,
                "source": ident.split(":", 1)[0] or None if ident else None,
                "who": loopevents.diagnosis_source(ident) if ident else None,  # in words (dogfood U7)
                "ts": clean(row.get("ts"), 40, one_line=True) or None,
                "severity": clean(row.get("severity"), 20, one_line=True) or None,
                "subject": clean(row.get("subject"), 160, one_line=True) or None,
                "detail": clean(row.get("detail"), 400, one_line=True) or None,
                "suggested_action": clean(row.get("suggested_action"), 300, one_line=True) or None,
                "intervention_taken": clean(row.get("intervention_taken"), 200, one_line=True) or None,
            }
        )
    out.sort(key=lambda row: row["ts"] or "", reverse=True)
    return out[:MAX_DIAGNOSES]


def knowledge_summary(client: RokoClient) -> dict[str, Any]:
    """L3: how much roko knows about the project, and its newest entries."""
    body = client.get("/api/knowledge/entries", {"limit": 5})
    items = _rows(body, "items", "entries")
    total = body.get("total") if isinstance(body, dict) else None
    return {
        "total": _int(total) if total is not None else len(items),
        "recent": [
            {
                "id": clean(row.get("id"), 80, one_line=True),
                "text": clean(row.get("label") or row.get("content"), 300, one_line=True),
                "kind": clean(row.get("domain") or row.get("kind"), 40, one_line=True) or None,
                "confidence": _rate(row.get("confidence")),
                "citations": _int(row.get("citations")),
            }
            for row in items[:5]
            if isinstance(row, dict)
        ],
    }


def playbook_summary(client: RokoClient) -> dict[str, Any]:
    """L3: the playbooks roko keeps (`GET /api/learn/playbooks`)."""
    body = client.get("/api/learn/playbooks")
    rows = _rows(body, "playbooks")
    total = body.get("total") if isinstance(body, dict) else None
    return {"total": _int(total) if total is not None else len(rows)}


def withheld_count(client: RokoClient) -> int:
    """L0: tool results roko's immune boundary withheld (`GET /api/safety/incidents`)."""
    body = client.get("/api/safety/incidents")
    rows = _rows(body, "incidents", "items")
    total = body.get("total") if isinstance(body, dict) else None
    return _int(total) if total is not None else len(rows)


def held_count(client: RokoClient) -> int:
    """L0: outbound calls roko holds for the person right now."""
    body = client.call_tool("effects_pending", {})
    waiting = body.get("waiting") if isinstance(body, dict) else None
    return len(waiting) if isinstance(waiting, list) else 0

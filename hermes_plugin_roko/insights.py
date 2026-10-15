"""Read-only views of what roko has learned: gate pass rates, models, spend over time, effects.

Each reads one roko serve route and reshapes it for `/roko` and the UIs.
Workspace-wide: these cover every run in roko's workspace, not only Hermes'.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any

from .client import RokoClient
from .errors import RokoError
from .sanitize import clean

MAX_GATES = 30
MAX_MODELS = 20
MAX_TREND = 60
MAX_DECIDED = 30
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

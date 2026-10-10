"""Plain-text views for the person: `/roko` replies and `hermes roko` output.

Replies go to terminals and to messaging platforms alike, so they use plain
text with no markdown tables, and stay short enough for a Telegram message.
"""

from __future__ import annotations

from typing import Any

from .diagnostics import FAIL, OK, WARN, Report

MAX_REPLY_CHARS = 3_500
_MARK = {OK: "✓", WARN: "!", FAIL: "✗"}


def clip(text: str, limit: int = MAX_REPLY_CHARS) -> str:
    return text if len(text) <= limit else text[: limit - 2] + "\n…"


def money(value: Any) -> str:
    try:
        return f"${float(value):.2f}"
    except (TypeError, ValueError):
        return "$?"


def overview(view: dict[str, Any]) -> str:
    roko = view.get("roko", {})
    lines = [f"roko {roko.get('version', '?')} at {roko.get('url', '?')}: {roko.get('status', '?')}"]
    if roko.get("active_runs") is not None:
        lines.append(f"active runs: {roko.get('active_runs')}, active plans: {roko.get('active_plans', 0)}")
    if roko.get("api_problem"):
        lines.append(f"API: {roko['api_problem']}")
    runs = view.get("recent_runs") or []
    if runs:
        lines.append("")
        lines.append("Runs started from Hermes:")
        for run in runs:
            cost = f", {money(run['cost_usd'])}" if run.get("cost_usd") is not None else ""
            state = f"{run.get('state', '?')}{cost}"
            lines.append(f"  {run.get('run_id')}  {state}  [{run.get('kind')}] {run.get('label', '')}")
            if run.get("note"):
                lines.append(f"      {run['note']}")
    elif view.get("note"):
        lines.append(view["note"])
    waiting = view.get("waiting_on_person") or []
    if waiting:
        lines.append("")
        lines.append(f"{len(waiting)} item(s) wait on you: see /roko pending")
    return clip("\n".join(lines))


def run(summary: dict[str, Any]) -> str:
    lines = [f"run {summary.get('run_id')}: {summary.get('state', '?')}"]
    if summary.get("plan_id"):
        lines[0] += f" (plan {summary['plan_id']})"
    if summary.get("verdict") and summary.get("verdict") != summary.get("state"):
        lines.append(f"verdict: {summary['verdict']}")
    if summary.get("cost_usd") is not None:
        lines.append(f"cost: {money(summary['cost_usd'])}")
    tasks = summary.get("tasks")
    if isinstance(tasks, dict) and tasks.get("total"):
        passed, total = tasks.get("passed", 0), tasks.get("total")
        lines.append(
            f"tasks: {passed}/{total} passed, {tasks.get('not_passed', 0)} failed, "
            f"{tasks.get('unverified', 0)} unverified"
        )
    if summary.get("position") is not None:
        lines.append(f"queue position: {summary['position']}")
    for milestone in summary.get("milestones") or []:
        if isinstance(milestone, dict):
            lines.append(f"  · {milestone.get('text', milestone.get('kind'))}")
    if summary.get("error"):
        lines.append(f"error: {summary['error']}")
    delivered = summary.get("delivered")
    if isinstance(delivered, dict):
        merged = "merged" if delivered.get("merged") else "not merged yet"
        lines.append(f"result: branch {delivered.get('branch')} @ {delivered.get('commit')} ({merged})")
        if delivered.get("workspace"):
            lines.append(f"  in {delivered['workspace']}")
        if delivered.get("diffstat"):
            lines.append(f"  {delivered['diffstat']}")
        for path in delivered.get("files_changed") or []:
            lines.append(f"  {path}")
    waiting = summary.get("waiting_on_person") or []
    if waiting:
        lines.append(f"{len(waiting)} item(s) wait on you: see /roko pending")
    return clip("\n".join(lines))


def plans(view: dict[str, Any]) -> str:
    rows = view.get("plans") or []
    if not rows:
        return view.get("note") or "roko has no plans."
    lines = [f"{view.get('total', len(rows))} plan(s):"]
    for plan in rows:
        done = plan.get("tasks_done")
        progress = (
            f"{done}/{plan.get('task_count')}" if done is not None else f"{plan.get('task_count', '?')} tasks"
        )
        lines.append(
            f"  {plan.get('id')}  {plan.get('status', '')}  {progress}  {plan.get('title', '')}".rstrip()
        )
    if view.get("note"):
        lines.append(view["note"])
    return clip("\n".join(lines))


def plan(view: dict[str, Any]) -> str:
    lines = [f"plan {view.get('plan_id')}: {view.get('title') or ''}".rstrip(": ")]
    lines.append(
        f"{view.get('task_count', '?')} task(s), up to {view.get('max_parallel') or '?'} in parallel"
    )
    for task in view.get("tasks") or []:
        deps = task.get("depends_on") or []
        after = f" (after {', '.join(map(str, deps))})" if deps else ""
        status = f" [{task['status']}]" if task.get("status") else ""
        lines.append(f"  {task.get('id')}{status} {task.get('title', '')}{after}")
        for check in task.get("checks") or []:
            lines.append(f"      check: {check}")
    if view.get("note"):
        lines.append(view["note"])
    return clip("\n".join(lines))


def pending_title(item: dict[str, Any]) -> str:
    if item.get("kind") == "confirm":
        title = f" ({item['title']})" if item.get("title") else ""
        return f"the result of task {item.get('task_id')}{title} in run {item.get('run_id')}"
    return f"the held action {item.get('tool')} on {item.get('server')} (run {item.get('run_id')})"


def pending(items: list[dict[str, Any]]) -> str:
    if not items:
        return "Nothing waits on you."
    lines = []
    for item in items:
        lines.append(f"[{item.get('code')}] {pending_title(item)}")
        if item.get("kind") == "confirm":
            lines.append(f"    {item.get('question')}")
            if item.get("summary"):
                lines.append("    " + str(item["summary"])[:400].replace("\n", "\n    "))
        elif item.get("arguments"):
            lines.append(f"    arguments: {item['arguments']}")
    lines.append("")
    lines.append("Answer with /roko approve <code> [note] or /roko reject <code> [note].")
    return clip("\n".join(lines))


def recall(view: dict[str, Any]) -> str:
    entries = view.get("entries") or []
    if not entries:
        return view.get("note") or "Nothing found."
    lines = []
    for entry in entries:
        lines.append(f"- [{entry.get('kind')}/{entry.get('tier')}] {entry.get('content')}")
    return clip("\n".join(lines))


def doctor(report: Report) -> str:
    lines = []
    for check in report.checks:
        lines.append(f"{_MARK.get(check.status, '?')} {check.name}: {check.detail}")
        if check.hint and check.status != OK:
            lines.append(f"    → {check.hint}")
    return "\n".join(lines)

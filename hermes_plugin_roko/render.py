"""Plain-text views for the person: `/roko` replies, `hermes roko` output, `@roko:` references.

Replies go to terminals and to messaging platforms alike, so they are plain
text: no markdown tables, no colour, glyphs that read without colour (✓ ✗ ⟳ ·
⊘ ⚠), and short enough for one Discord message (2,000 characters). All roko
text in them was cleaned on the way in (`sanitize.clean`).
"""

from __future__ import annotations

from typing import Any

from .diagnostics import FAIL, OK, WARN, Report
from .rundata import fmt_duration, fmt_money

MAX_REPLY_CHARS = 1_900
_MARK = {OK: "✓", WARN: "!", FAIL: "✗"}
STATE_GLYPH = {
    "succeeded": "✓",
    "failed": "✗",
    "unverified": "⚠",
    "cancelled": "⊘",
    "running": "⟳",
    "queued": "·",
}
OUTCOME_GLYPH = {
    "passed": "✓",
    "already_satisfied": "✓",
    "failed": "✗",
    "unverified": "⚠",
    "accepted_with_failures": "⚠",
    "blocked": "⊘",
    "skipped": "⊘",
    "running": "⟳",
    "pending": "·",
}


def clip(text: str, limit: int = MAX_REPLY_CHARS) -> str:
    if len(text) <= limit:
        return text
    cut = text[: limit - 2]
    if "\n" in cut[limit // 2 :]:  # end on a whole line when one is near
        cut = cut[: cut.rfind("\n")]
    return cut + "\n…"


def money(value: Any) -> str:
    return fmt_money(value)


def glyph(state: Any) -> str:
    return STATE_GLYPH.get(str(state or ""), "?")


def short(run_id: Any) -> str:
    return str(run_id or "?")[:8]


# -- overview, runs, spend ------------------------------------------------------


def overview(view: dict[str, Any]) -> str:
    roko = view.get("roko", {})
    head = f"roko {roko.get('version') or '?'} at {roko.get('url', '?')} · {roko.get('status') or '?'}"
    if roko.get("active_runs"):
        head += f" · {roko['active_runs']} running"
    lines = [head]
    if roko.get("api_problem"):
        lines.append(f"⚠ API: {roko['api_problem']}")
    spend = view.get("spend")
    if isinstance(spend, dict):
        lines.append(spend_line(spend))
    runs = view.get("recent_runs") or []
    if runs:
        lines.append("")
        lines.append("Runs started from Hermes:")
        for run in runs:
            lines.append(run_line(run))
    elif view.get("note"):
        lines.append(view["note"])
    waiting = view.get("waiting_on_person") or []
    if waiting:
        lines.append("")
        lines.append(f"● {len(waiting)} waiting on you — /roko pending")
    return clip("\n".join(lines))


def spend_line(spend: dict[str, Any]) -> str:
    limit = spend.get("max_day_usd")
    text = f"today {money(spend.get('today_usd'))}"
    text += f" of {money(limit)}" if limit is not None else " (no daily limit)"
    if spend.get("committed_usd"):
        text += f" · {money(spend['committed_usd'])} committed to running runs"
    return text


def run_line(run: dict[str, Any]) -> str:
    state = run.get("state") or "unknown"
    cost = run.get("cost_usd")
    cap = run.get("max_usd")
    money_part = ""
    if cost is not None or cap is not None:
        money_part = f" · {money(cost)}" + (f" of {money(cap)}" if cap is not None else "")
    label = str(run.get("label") or "")
    if len(label) > 60:
        label = label[:59] + "…"
    line = f"  {glyph(state)} {short(run.get('run_id'))} {state}{money_part} · {label}"
    if run.get("note"):
        line += f"\n      {run['note']}"
    return line


def runs(rows: list[dict[str, Any]], spend: dict[str, Any] | None = None) -> str:
    if not rows:
        return "No runs were started from Hermes yet."
    lines = [f"{len(rows)} run(s) started from Hermes, newest first:"]
    for row in rows:
        when = str(row.get("started_at") or "")[:16].replace("T", " ")
        lines.append(run_line(row) + (f" · {when}" if when else ""))
    if spend:
        lines.append("")
        lines.append(spend_line(spend))
    lines.append("Details: /roko status RUN_ID (or last)")
    return clip("\n".join(lines))


def cost(spend: dict[str, Any], rows: list[dict[str, Any]]) -> str:
    lines = ["roko spend from Hermes", spend_line(spend)]
    if spend.get("left_usd") is not None:
        lines.append(f"left today: {money(spend['left_usd'])}")
    today = [row for row in rows if row.get("today")]
    if today:
        lines.append("")
        lines.append("Today's runs:")
        for row in today:
            lines.append(run_line(row))
    lines.append("")
    lines.append(
        "Each run is capped by its max_usd; the daily limit is plugins.entries.roko.settings.max_day_usd."
    )
    return clip("\n".join(lines))


# -- one run --------------------------------------------------------------------


def card(run: dict[str, Any], why: dict[str, Any] | None = None, *, limit: int = MAX_REPLY_CHARS) -> str:
    """A run card in plain text."""
    state = run.get("state") or "unknown"
    title = f"{glyph(state)} roko run {short(run.get('run_id'))} · {state}"
    if run.get("kind") == "plan" and run.get("plan_id"):
        title += f" · plan {run['plan_id']}"
    lines = [title]
    if run.get("label") and run.get("label") != run.get("plan_id"):
        lines.append(str(run["label"]))
    if run.get("headline"):
        lines.append(str(run["headline"]))
    if run.get("kind") == "plan_generate":
        if run.get("planner_error"):
            lines.append(f"planner: {run['planner_error']}")
        if run.get("plan_id") and state == "succeeded":
            lines.append(f"Show it with /roko plans {run['plan_id']}")
        return clip("\n".join(lines), limit)
    tasks = run.get("tasks") or []
    if tasks:
        lines.append("")
        lines.append("Tasks:")
        for task in tasks[:12]:
            lines.extend(_task_lines(task))
        if len(tasks) > 12:
            lines.append(f"  … {len(tasks) - 12} more")
    waiting = run.get("waiting") or []
    if waiting:
        lines.append("")
        lines.append("Waiting on you:")
        for item in waiting[:5]:
            lines.append(f"  [{item.get('code')}] {item.get('title')}")
            lines.append(f"      {item.get('question')}")
        lines.append("  Answer with /roko approve CODE or /roko reject CODE [NOTE].")
    delivered = run.get("delivered")
    if isinstance(delivered, dict):
        merged = "merged" if delivered.get("merged") else "not merged yet"
        lines.append("")
        lines.append(f"Result: branch {delivered.get('branch')} @ {delivered.get('commit')} ({merged})")
        if delivered.get("diffstat"):
            lines.append(f"  {delivered['diffstat']}")
        for path in (delivered.get("files_changed") or [])[:8]:
            lines.append(f"  {path}")
        if delivered.get("promoted_into"):
            into, tag = delivered["promoted_into"], delivered.get("promoted_tag")
            lines.append(f"  promoted into {into} (tag {tag})")
        if not delivered.get("merged"):
            lines.append(f"  review: {run.get('review_command')}")
            if run.get("merge_command"):
                lines.append(f"  merge:  {run.get('merge_command')}")
    if why:
        lines.append("")
        lines.append(f"Why: {why.get('summary')}")
        for gate in (why.get("gates_not_passed") or [])[:2]:
            output = str(gate.get("output") or "").strip()
            if output:
                tail = "\n".join(output.splitlines()[-8:])
                lines.append(f"  {gate.get('task_id')} {gate.get('gate')}:")
                lines.extend(f"    {line}" for line in tail.splitlines())
    elif run.get("errors"):
        lines.append(f"⚠ {run['errors'][-1]}")
    return clip("\n".join(lines), limit)


def _task_lines(task: dict[str, Any]) -> list[str]:
    outcome = str(task.get("outcome") or "pending")
    mark = OUTCOME_GLYPH.get(outcome, "?")
    head = f"  {mark} {task.get('task_id')} {task.get('title') or ''}".rstrip()
    facts = []
    if outcome not in ("passed", "pending", "running"):
        facts.append(outcome.replace("_", " "))
    if task.get("model"):
        facts.append(str(task["model"]))
    if (task.get("attempts") or 0) > 1:
        facts.append(f"{task['attempts']} attempts")
    if task.get("cost_usd") is not None:
        facts.append(money(task["cost_usd"]))
    if task.get("rung"):
        facts.append(f"checking {task['rung']}")
    lines = [head + (f" · {' · '.join(facts)}" if facts else "")]
    gates = task.get("gates") or []
    if gates:
        marks = "  ".join(f"{'✓' if gate.get('passed') else '✗'} {gate.get('gate')}" for gate in gates[:6])
        lines.append(f"      {marks}")
    if task.get("reason"):
        lines.append(f"      blocked: {task['reason']}")
    return lines


# -- plans ----------------------------------------------------------------------


def plans(view: dict[str, Any]) -> str:
    rows = view.get("plans") or []
    if not rows:
        return view.get("note") or "roko has no plans."
    lines = [f"{view.get('total', len(rows))} plan(s):"]
    for plan in rows[:25]:
        done = plan.get("tasks_done")
        progress = (
            f"{done}/{plan.get('task_count')}" if done is not None else f"{plan.get('task_count', '?')}"
        )
        status = f" · {plan['status']}" if plan.get("status") else ""
        lines.append(f"  {plan.get('id')} · {progress} tasks{status}")
    if len(rows) > 25:
        lines.append(f"  … {len(rows) - 25} more")
    lines.append("Details: /roko plans PLAN_ID")
    return clip("\n".join(lines))


def plan(view: dict[str, Any]) -> str:
    title = view.get("title")
    lines = [
        f"plan {view.get('plan_id')}" + (f" · {title}" if title and title != view.get("plan_id") else "")
    ]
    waves = view.get("waves") or []
    count = view.get("task_count", "?")
    shape = f"{count} task(s)"
    if len(waves) > 1:
        shape += f" in {len(waves)} waves"
    if view.get("max_parallel"):
        shape += f", up to {view['max_parallel']} at once"
    lines.append(shape)
    estimate = view.get("estimate")
    if isinstance(estimate, dict) and estimate.get("total_cost_usd") is not None:
        when = estimate.get("total_duration_secs")
        took = f", about {fmt_duration(int(when) * 1000)}" if when else ""
        confidence = f" ({estimate['confidence']} confidence)" if estimate.get("confidence") else ""
        lines.append(f"estimate: {money(estimate['total_cost_usd'])}{took}{confidence}")
    tasks = {task.get("id"): task for task in view.get("tasks") or []}
    for number, wave in enumerate(waves[:10], start=1):
        lines.append(f"wave {number}:")
        for task_id in wave[:12]:
            task = tasks.get(task_id, {})
            deps = task.get("depends_on") or []
            after = f" (after {', '.join(map(str, deps))})" if deps else ""
            lines.append(f"  · {task_id} {task.get('title', '')}{after}")
            for check in (task.get("checks") or [])[:2]:
                lines.append(f"      check: {check}")
    if view.get("note"):
        lines.append(view["note"])
    lines.append(f"Run it from chat (the model asks you first), or: roko run plans/{view.get('plan_id')}")
    return clip("\n".join(lines))


# -- what waits on the person -----------------------------------------------------


def pending_title(item: dict[str, Any]) -> str:
    return str(item.get("title") or "an item")


def pending(items: list[dict[str, Any]]) -> str:
    if not items:
        return "Nothing waits on you."
    lines = []
    for item in items[:8]:
        lines.append(f"[{item.get('code')}] {pending_title(item)}")
        if item.get("kind") == "confirm":
            lines.append(f"    {item.get('question')}")
            if item.get("summary"):
                summary = str(item["summary"])[:300]
                lines.append("    " + summary.replace("\n", "\n    "))
            if item.get("deadline_at"):
                lines.append(f"    answer by {item['deadline_at']} or the check is skipped")
        else:
            arguments = item.get("arguments") or {}
            if arguments:
                shown = ", ".join(f"{key}: {kind}" for key, kind in arguments.items())
                lines.append(f"    arguments: {shown}")
    if len(items) > 8:
        lines.append(f"… {len(items) - 8} more")
    lines.append("")
    lines.append("Answer with /roko approve CODE [NOTE] or /roko reject CODE [NOTE].")
    return clip("\n".join(lines))


def effects(view: dict[str, Any]) -> str:
    decided = view.get("decided") or []
    lines = [
        f"Held actions waiting: {view.get('waiting', 0)}"
        + (" — /roko pending" if view.get("waiting") else "")
    ]
    if not decided:
        lines.append("No held action was decided yet.")
        return "\n".join(lines)
    lines.append("Decided, newest first:")
    for record in decided[:10]:
        outcome = str(record.get("outcome") or "?")
        mark = {"applied": "✓", "rejected": "⊘", "failed": "✗", "ambiguous": "⚠"}.get(outcome, "?")
        who = f" by {record['decided_by']}" if record.get("decided_by") else ""
        when = str(record.get("decided_at") or "")[:16].replace("T", " ")
        lines.append(f"  {mark} {record.get('tool')} on {record.get('server')} · {outcome}{who} · {when}")
        for receipt in (record.get("receipts") or [])[:2]:
            lines.append(f"      {'✓' if receipt.get('passed') else '✗'} {receipt.get('rung')}")
    return clip("\n".join(lines))


# -- knowledge, gates, learning ---------------------------------------------------


def recall(view: dict[str, Any]) -> str:
    entries = view.get("entries") or []
    if not entries:
        return view.get("note") or "Nothing found."
    lines = []
    for entry in entries:
        tags = "/".join(str(tag) for tag in (entry.get("kind"), entry.get("tier")) if tag)
        lines.append(f"• [{tags}] {entry.get('content')}" if tags else f"• {entry.get('content')}")
    return clip("\n".join(lines))


def gates(rows: list[dict[str, Any]]) -> str:
    if not rows:
        return "roko has recorded no gate results yet."
    lines = ["Gates across roko's workspace (pass rate, runs):"]
    for row in rows[:15]:
        rate = row.get("pass_rate")
        percent = f"{round(rate * 100)}%" if isinstance(rate, (int, float)) else "?"
        mark = "✓" if rate == 1 else "⚠" if isinstance(rate, (int, float)) and rate >= 0.8 else "✗"
        took = f" · ~{fmt_duration(int(row['avg_duration_ms']))}" if row.get("avg_duration_ms") else ""
        lines.append(f"  {mark} {row.get('gate')} · {percent} of {row.get('total', 0)}{took}")
    return clip("\n".join(lines))


def learn(models: list[dict[str, Any]] | None, efficiency: dict[str, Any] | None) -> str:
    lines = []
    if efficiency:
        lines.append(
            f"roko workspace spend: {money(efficiency.get('total_cost_usd'))} over "
            f"{efficiency.get('tasks_recorded', 0)} recorded tasks, "
            f"{money(efficiency.get('cost_per_task_usd'))} per task"
        )
    if models:
        lines.append("Models (tasks, success, cost):")
        for row in models[:10]:
            rate = row.get("success_rate")
            percent = f"{round(rate * 100)}%" if isinstance(rate, (int, float)) else "?"
            lines.append(
                f"  · {row.get('model')} · {row.get('tasks')} tasks · {percent} · "
                f"{money(row.get('total_cost_usd'))}"
            )
    return clip("\n".join(lines)) if lines else "roko has no learning records yet."


def doctor(report: Report) -> str:
    lines = []
    for check in report.checks:
        lines.append(f"{_MARK.get(check.status, '?')} {check.name}: {check.detail}")
        if check.hint and check.status != OK:
            lines.append(f"    → {check.hint}")
    return "\n".join(lines)

"""What runs started from this Hermes have spent today, and may still spend.

roko caps each run (`max_usd`); this adds a daily limit across the runs Hermes
starts. Spend comes from the run log: each run's cost as last seen, and for a
run still going, the rest of its cap counts as committed, because roko may
still spend it. A paid start is refused when spent + committed + the new cap
would pass `max_day_usd`. "Today" is the local calendar day.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from typing import Any

from .catalog import TERMINAL_STATES
from .errors import Code, RokoError


def spend(runs: list[dict[str, Any]], max_day_usd: float | None, today: date | None = None) -> dict[str, Any]:
    """`{today_usd, committed_usd, max_day_usd, runs_today, left_usd}` for the run log `runs`."""
    day = today or local_today()
    spent = 0.0
    committed = 0.0
    count = 0
    for run in runs:
        started = local_day(run.get("started_at"))
        cost = _number(run.get("cost_usd"))
        if started == day:
            count += 1
            spent += cost
        if run.get("state") not in TERMINAL_STATES and run.get("kind") in ("run", "plan"):
            committed += max(0.0, _number(run.get("max_usd")) - cost)
    left = None if max_day_usd is None else max(0.0, max_day_usd - spent - committed)
    return {
        "today_usd": round(spent, 4),
        "committed_usd": round(committed, 4),
        "max_day_usd": max_day_usd,
        "left_usd": None if left is None else round(left, 4),
        "runs_today": count,
    }


def local_today() -> date:
    return datetime.now().astimezone().date()


def check_start(runs: list[dict[str, Any]], cap: float, max_day_usd: float | None) -> dict[str, Any]:
    """Refuse a paid start whose cap would take the day past `max_day_usd`; return the day's spend."""
    day = spend(runs, max_day_usd)
    if max_day_usd is None:
        return day
    worst = day["today_usd"] + day["committed_usd"] + cap
    if worst > max_day_usd + 1e-9:
        raise RokoError(
            Code.REFUSED,
            f"starting this run could take today's roko spend to ${worst:.2f}, over the "
            f"${max_day_usd:.2f} daily limit (spent ${day['today_usd']:.2f}, "
            f"${day['committed_usd']:.2f} still committed to running runs)",
            hint=f"choose a smaller cap (at most ${day['left_usd']:.2f} is left today), wait for a "
            "running run to end, or raise plugins.entries.roko.settings.max_day_usd",
            guidance=f"Starting it would pass today's spending limit. Tell the person that at most "
            f"${day['left_usd']:.2f} is left today and ask whether to start it with a smaller cap; start "
            "nothing until they answer. The limit is theirs: do not raise it unless they ask.",
        )
    return day


def local_day(stamp: Any) -> date | None:
    if not isinstance(stamp, str) or not stamp:
        return None
    try:
        when = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=UTC)
    return when.astimezone().date()


def _number(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0.0
    return float(value) if value == value and value > 0 else 0.0

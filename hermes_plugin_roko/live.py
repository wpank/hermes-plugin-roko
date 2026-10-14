"""`hermes roko watch` on a terminal: one run, live, full screen.

The screen is drawn about four times a second from what the last check found, so the spinner and the
elapsed clock move between checks; the run's card itself is re-read every `--interval` seconds through
`views.card`, as `hermes roko status RUN` reads it. Every string from roko was cleaned on the way in
(`sanitize.clean`) and is drawn as rich `Text`, never parsed as markup.

`q` or Ctrl-C stops watching (the run goes on) and `r` checks at once. When the run ends, its last frame
stays on screen with a summary under it: the verdict, what it cost, and how to review and take the work.
"""

from __future__ import annotations

import contextlib
import os
import re
import select
import sys
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from types import TracebackType
from typing import Any, Protocol

from rich import box
from rich.cells import cell_len
from rich.console import Console, Group, RenderableType
from rich.live import Live
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table
from rich.text import Text

from .catalog import TERMINAL_STATES
from .errors import RokoError
from .render import FAILED_OUTCOMES, FINISHED_OUTCOMES, OUTCOME_GLYPH, percent, ratio, waves
from .rundata import fmt_duration, fmt_money

Read = tuple[dict[str, Any], list[dict[str, Any]]]
Fetch = Callable[[], Read]

SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
FPS = 4
NARROW = 80
ACTIVITY_ROWS = 8
FRESH_S = 3.0
SEGMENTS = 20
QUIT_KEYS = frozenset({"q", "Q"})
CHECK_KEYS = frozenset({"r", "R"})

STATE_COLOR = {
    "succeeded": "green",
    "failed": "red",
    "unverified": "yellow",
    "cancelled": "magenta",
    "running": "cyan",
    "queued": "blue",
}
DONE_GLYPH = {"succeeded": "✓", "failed": "✗", "unverified": "◌", "cancelled": "⊘", "queued": "⏳"}
TASK_GLYPH = {**OUTCOME_GLYPH, "unverified": "◌", "accepted_with_failures": "◌"}
TASK_COLOR = {
    "passed": "green",
    "already_satisfied": "green",
    "failed": "red",
    "unverified": "yellow",
    "accepted_with_failures": "yellow",
    "blocked": "magenta",
    "skipped": "magenta",
    "running": "cyan",
    "pending": "dim",
}
EVENT_MARK = {
    "plan_set_loaded": ("·", "dim"),
    "plan_started": ("▸", "blue"),
    "task_started": ("⟳", "cyan"),
    "agent_spawned": ("◆", "cyan"),
    "gate_rung_started": ("↻", "cyan"),
    "task_blocked": ("⊘", "magenta"),
    "run_completed": ("■", "bold"),
    "error": ("⚠", "red"),
}
KIND_WORD = {"plan": "plan", "plan_generate": "planning", "run": "run"}
STEP_TYPES = frozenset({"task_started", "agent_spawned", "gate_rung_started"})
# xterm's title stack: keep the terminal's own title and put it back afterwards.
PUSH_TITLE, POP_TITLE = "\x1b[22;0t", "\x1b[23;0t"
NUMBERED_GATE = re.compile(r"^\w+\[\d+:(.+)\]$")
TALLY_WORD = {
    "passed": "passed",
    "already_satisfied": "passed",
    "failed": "failed",
    "blocked": "blocked",
    "unverified": "unverified",
    "accepted_with_failures": "unverified",
    "skipped": "skipped",
    "running": "running",
    "pending": "pending",
}
TALLY_ORDER = ("passed", "failed", "blocked", "unverified", "skipped", "running", "pending", "other")


class KeyWait(Protocol):
    def wait(self, timeout: float) -> str | None: ...


@dataclass
class Watch:
    """What the screen shows: the last card and timeline read, and when each timeline row first came."""

    run_id: str
    interval: float
    card: dict[str, Any] = field(default_factory=dict)
    timeline: list[dict[str, Any]] = field(default_factory=list)
    fetched_at: float = 0.0
    seen: dict[Any, float | None] = field(default_factory=dict)
    problem: str | None = None
    reads: int = 0
    keys: bool = True  # whether q and r reach the watch (stdin is a terminal)

    def take(self, card: dict[str, Any], timeline: list[dict[str, Any]], now: float) -> None:
        backlog = self.reads == 0  # rows already there when watching began have no arrival time
        for entry in timeline:
            key = entry.get("cursor") if isinstance(entry, dict) else None
            if key is not None and key not in self.seen:
                self.seen[key] = None if backlog else now
        self.card, self.timeline, self.fetched_at, self.problem = card, list(timeline), now, None
        self.reads += 1

    @property
    def state(self) -> str:
        return str(self.card.get("state") or "unknown")

    @property
    def ended(self) -> bool:
        return self.state in TERMINAL_STATES

    @property
    def tasks(self) -> list[dict[str, Any]]:
        return [task for task in self.card.get("tasks") or [] if isinstance(task, dict)]


# -- time and numbers ------------------------------------------------------------------------------


def epoch(value: Any) -> float | None:
    """Seconds since the epoch from an ISO time, or from seconds or milliseconds; None otherwise."""
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)) and value > 0:
        return float(value) / 1000 if value > 1e11 else float(value)
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def clock(seconds: float | None) -> str:
    return time.strftime("%H:%M:%S", time.localtime(seconds)) if seconds is not None else ""


def elapsed_ms(watch: Watch, now: float) -> int | None:
    """How long the run has taken: to its end once it ended, else until `now`."""
    card = watch.card
    duration = card.get("duration_ms")
    if watch.ended and isinstance(duration, (int, float)) and not isinstance(duration, bool):
        return max(0, int(duration))
    start = epoch(card.get("started_at"))
    if start is not None:
        end = epoch(card.get("finished_at")) if watch.ended else None
        return max(0, int(((end if end is not None else now) - start) * 1000))
    elapsed = card.get("elapsed_ms")
    if isinstance(elapsed, (int, float)) and not isinstance(elapsed, bool):
        extra = 0.0 if watch.ended else max(0.0, now - watch.fetched_at)
        return max(0, int(elapsed + extra * 1000))
    return None


def compact(value: Any) -> str:
    """1234 -> 1.2k, 1_500_000 -> 1.5M."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return "—"
    number = float(value)
    for limit, suffix in ((1e9, "B"), (1e6, "M"), (1e3, "k")):
        if abs(number) >= limit:
            return f"{number / limit:.1f}".rstrip("0").rstrip(".") + suffix
    return str(int(number))


def spent(value: Any, *, blank: bool = False) -> str:
    """What a run spent, to a tenth of a cent below a dollar: $0.011, $0.105, $1.71."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return "" if blank else "—"
    if value == 0:
        return "$0.00"
    return f"${value:.3f}" if abs(value) < 1 else f"${value:.2f}"


def outcome_of(task: dict[str, Any]) -> str:
    return str(task.get("outcome") or "pending")


# -- small pieces ----------------------------------------------------------------------------------


def spinner(now: float | None) -> str:
    """One step a frame, so the spinner turns smoothly at the screen's frame rate; `⟳` when `now` is
    None, for a frame that stays on screen after watching stops."""
    return OUTCOME_GLYPH["running"] if now is None else SPINNER[int(now * FPS) % len(SPINNER)]


def badge(state: str) -> Text:
    return Text(f" {state.upper()} ", style=f"bold reverse {STATE_COLOR.get(state, 'white')}")


def meter(fraction: float, cells: int) -> Text:
    """A thin meter: green below 60 %, yellow below 90 %, red from there."""
    fraction = min(max(fraction, 0.0), 1.0)
    filled = round(fraction * cells)
    if fraction > 0 and filled == 0:
        filled = 1
    color = "green" if fraction < 0.6 else "yellow" if fraction < 0.9 else "red"
    out = Text()
    out.append("━" * filled, style=color)
    out.append("─" * (cells - filled), style="dim")
    return out


def segments(tasks: list[dict[str, Any]]) -> Text:
    """A cell per task coloured by how it went; for a long plan, the same in proportion."""
    out = Text()
    if len(tasks) <= SEGMENTS:
        for task in tasks:
            outcome = outcome_of(task)
            out.append("▱" if outcome == "pending" else "▰", style=TASK_COLOR.get(outcome, "white"))
        return out
    outcomes = [outcome_of(task) for task in tasks]
    shares = (
        ("green", sum(1 for o in outcomes if o in FINISHED_OUTCOMES and o not in FAILED_OUTCOMES)),
        ("red", sum(1 for o in outcomes if o in FAILED_OUTCOMES)),
        ("cyan", outcomes.count("running")),
    )
    used = 0
    for color, count in shares:
        cells = min(round(count / len(tasks) * SEGMENTS), SEGMENTS - used)
        out.append("▰" * cells, style=color)
        used += cells
    out.append("▱" * (SEGMENTS - used), style="dim")
    return out


def task_mark(outcome: str, turn: float | None) -> Text:
    glyph = spinner(turn) if outcome == "running" else TASK_GLYPH.get(outcome, "?")
    return Text(glyph, style=f"bold {TASK_COLOR.get(outcome, 'white')}")


def gate_name(name: Any) -> str:
    """`verify[0:test]` -> `test`: roko numbers a plan's verify commands; the label is what reads."""
    text = str(name or "?")
    match = NUMBERED_GATE.match(text)
    return match.group(1) if match else text


def step_since(watch: Watch, task_id: Any) -> float | None:
    """When the task's current step began, as far as this watch knows: its latest start, attempt or check."""
    for entry in reversed(watch.timeline):
        if isinstance(entry, dict) and entry.get("task_id") == task_id and entry.get("type") in STEP_TYPES:
            return entry_time(watch, entry)
    return None


def gate_chips(task: dict[str, Any], narrow: bool, now: float, since: float | None = None) -> Text:
    """How the task's checks went; for a running task, what it is doing now and for how long."""
    out = Text(no_wrap=True, overflow="ellipsis")
    gates = [gate for gate in task.get("gates") or [] if isinstance(gate, dict)]
    if outcome_of(task) == "running":
        step = f"↻ {gate_name(task['rung'])}" if task.get("rung") else "working"
        if since is not None:
            step += " " + fmt_duration(int(max(0.0, now - since) * 1000))
        if narrow:
            return Text(step, style="cyan", no_wrap=True, overflow="ellipsis")
    else:
        step = ""
    if narrow:
        passed = sum(1 for gate in gates if gate.get("passed"))
        if passed:
            out.append(f"✓{passed}", style="green")
        if len(gates) > passed:
            out.append((" " if passed else "") + f"✗{len(gates) - passed}", style="red")
    else:
        for index, gate in enumerate(gates[:4]):
            ok = bool(gate.get("passed"))
            mark = f"{'✓' if ok else '✗'} {gate_name(gate.get('gate'))}"
            out.append(("  " if index else "") + mark, style="green" if ok else "red")
            runs = gate.get("runs")
            if isinstance(runs, int) and not isinstance(runs, bool) and runs > 1:
                out.append(f" ×{runs}", style="dim")
        if len(gates) > 4:
            out.append(f"  +{len(gates) - 4}", style="dim")
    if step:
        out.append(("  " if out.plain else "") + step, style="cyan")
    elif task.get("reason") and outcome_of(task) == "blocked" and not narrow:
        out.append(("  " if out.plain else "") + str(task["reason"]), style="magenta")
    return out


def event_mark(entry: dict[str, Any]) -> tuple[str, str]:
    kind = str(entry.get("type") or "")
    if kind in ("gate_result", "plan_completed"):
        return ("✓", "green") if entry.get("passed") else ("✗", "red")
    if kind == "task_completed":
        outcome = str(entry.get("outcome") or "")
        if outcome in ("passed", "already_satisfied", "skipped"):
            return "✓", "green"
        if outcome == "blocked":
            return "⊘", "magenta"
        if outcome in ("unverified", "accepted_with_failures"):
            return "◌", "yellow"
        return "✗", "red"
    return EVENT_MARK.get(kind, ("·", "dim"))


def entry_time(watch: Watch, entry: dict[str, Any]) -> float | None:
    """When a timeline row happened, if roko said, else when this watch first saw it."""
    for key in ("at", "ts", "timestamp", "ts_millis"):
        when = epoch(entry.get(key))
        if when is not None:
            return when
    return watch.seen.get(entry.get("cursor"))


def tally(tasks: list[dict[str, Any]]) -> str:
    """`3 passed, 1 failed, 8 pending`: how a group of tasks went."""
    counts = Counter(TALLY_WORD.get(outcome_of(task), "other") for task in tasks)
    return ", ".join(f"{counts[word]} {word}" for word in TALLY_ORDER if counts[word])


def visible_rows(count: int, focus: int, budget: int) -> tuple[int, int]:
    """Rows [start, end) of `count` to show in `budget` lines, keeping row `focus` in view.

    Hidden rows above and below take a line each to say so.
    """
    if count <= budget:
        return 0, count
    budget = max(budget, 3)
    start = focus - (budget - 2) // 3
    if start <= 0:
        return 0, budget - 1
    if start + budget - 1 >= count:
        return count - (budget - 1), count
    return start, start + budget - 2


# -- the frame -------------------------------------------------------------------------------------


@dataclass
class Part:
    """A piece of the screen and how many lines it takes."""

    renderable: RenderableType
    lines: int


def frame(
    watch: Watch, now: float, width: int, height: int | None = None, *, final: bool = False
) -> RenderableType:
    """The screen at `now` for a terminal `width` columns wide.

    With a `height`, the plan and the activity pane give up rows so that everything fits. `final` is the
    frame left on screen once watching stops: every task, and no key hints.
    """
    narrow = width < NARROW
    turn = None if final else now  # the spinners' clock: a frame left on screen does not spin
    top = header(watch, now, width, turn)
    asks = waiting_panel(watch, now, narrow)
    errors = errors_part(watch)
    bottom = None if final else footer(watch, now, narrow)
    planning = watch.card.get("kind") == "plan_generate"
    activity_rows = min(max(len(watch.timeline), 1), ACTIVITY_ROWS)
    plan_rows: int | None = None
    if height is not None and not final:
        fixed = sum(part.lines for part in (top, asks, errors, bottom) if part is not None)
        room = height - fixed - (0 if planning else 1 + activity_rows) - 1
        short = len(watch.tasks) - room
        if short > 0 and not planning:
            give = min(short, max(activity_rows - 2, 0))
            activity_rows -= give
            room += give
        plan_rows = max(room, 3)
    parts = [top, asks, plan_part(watch, now, narrow, plan_rows, turn), errors]
    if not planning:
        parts.append(activity_part(watch, now, activity_rows))
    parts.append(bottom)
    return Group(*(part.renderable for part in parts if part is not None))


def header(watch: Watch, now: float, width: int, turn: float | None) -> Part:
    card = watch.card
    state = watch.state
    color = STATE_COLOR.get(state, "white")
    moving = not watch.ended and state != "queued"

    title = Text(no_wrap=True, overflow="ellipsis")
    title.append(spinner(turn) if moving else DONE_GLYPH.get(state, "?"), style=f"bold {color}")
    title.append(" ")
    title.append_text(badge(state))
    kind = str(card.get("kind") or "run")
    title.append(f"  {KIND_WORD.get(kind, kind)} {watch.run_id[:8]}", style="bold")
    label = str(card.get("label") or "")
    named = label if label and label != f"run {watch.run_id[:8]}" else str(card.get("plan_id") or "")
    if named:
        title.append(" · ", style="dim")
        title.append(named)
    if card.get("resumed"):
        title.append("  resumed", style="dim italic")

    lines: list[Text] = [title]
    if kind == "plan_generate":
        lines.append(planner_line(watch, now))
    else:
        lines.append(money_line(watch, now, width))
        progress = progress_line(watch)
        if progress.plain:
            lines.append(progress)
    if watch.problem:
        lines.append(Text(f"⚠ {watch.problem} · retrying", style="yellow", no_wrap=True, overflow="ellipsis"))
    panel = Panel(
        Group(*lines),
        title=Text("roko", style="bold"),
        title_align="left",
        subtitle=Text(clock(now), style="dim"),
        subtitle_align="right",
        border_style=color,
        box=box.ROUNDED,
        padding=(0, 1),
    )
    return Part(panel, len(lines) + 2)


def money_line(watch: Watch, now: float, width: int) -> Text:
    card = watch.card
    out = Text(no_wrap=True, overflow="ellipsis")
    took = elapsed_ms(watch, now)
    out.append("elapsed ", style="dim")
    if took is not None:
        out.append(fmt_duration(took), style="bold")
    else:
        out.append("not started" if watch.state == "queued" else "—", style="dim")
    cost, cap = card.get("cost_usd"), card.get("max_usd")
    if cost is None and not watch.ended:
        cost = 0.0  # nothing reported yet
    part = ratio(cost, cap)
    out.append("   spend ", style="dim")
    if part is not None:
        out.append_text(meter(part, 12 if width < NARROW else 16 if width < 120 else 24))
        out.append(f" {spent(cost)}", style="bold")
        out.append(f" of {fmt_money(cap)} · {percent(part)}", style="dim")
    else:
        out.append(spent(cost), style="bold")
        if isinstance(cap, (int, float)) and not isinstance(cap, bool):
            out.append(f" of {fmt_money(cap)}", style="dim")
    tokens = card.get("tokens")
    if isinstance(tokens, dict) and width >= NARROW and (tokens.get("input") or tokens.get("output")):
        made, read = compact(tokens.get("output")), compact(tokens.get("input"))
        out.append(f"   tokens {read} in · {made} out", style="dim")
    return out


def progress_line(watch: Watch) -> Text:
    card = watch.card
    out = Text(no_wrap=True, overflow="ellipsis")
    tasks = watch.tasks
    if tasks:
        outcomes = [outcome_of(task) for task in tasks]
        done = sum(1 for outcome in outcomes if outcome in FINISHED_OUTCOMES)
        failed = sum(1 for outcome in outcomes if outcome in FAILED_OUTCOMES)
        out.append("tasks ", style="dim")
        out.append_text(segments(tasks))
        out.append(f" {done}/{len(tasks)}", style="bold")
        if failed:
            out.append(f" · {failed} failed", style="red")
    gates = card.get("gates")
    if isinstance(gates, dict) and gates.get("total"):
        out.append(("   " if out.plain else "") + "gates ", style="dim")
        counts = f"{gates.get('passed', 0)}/{gates.get('total')}"
        out.append(counts, style="red" if gates.get("failed") else "green")
    if watch.state == "queued" and isinstance(card.get("position"), int):
        out.append(("   " if out.plain else "") + f"place {card['position']} in roko's queue", style="blue")
    return out


def planner_line(watch: Watch, now: float) -> Text:
    card = watch.card
    out = Text(no_wrap=True, overflow="ellipsis")
    took = elapsed_ms(watch, now)
    if took is not None:
        out.append("elapsed ", style="dim")
        out.append(fmt_duration(took) + "   ", style="bold")
    if card.get("plan_id") and watch.state == "succeeded":
        out.append(f"plan {card['plan_id']} written", style="green")
        if card.get("task_count"):
            out.append(f" · {card['task_count']} tasks", style="dim")
    elif card.get("planner_error"):
        out.append(f"planner: {card['planner_error']}", style="red")
    elif not watch.ended:
        out.append("roko's planner is writing the plan…", style="dim")
    return out


def waiting_panel(watch: Watch, now: float, narrow: bool) -> Part | None:
    items = [item for item in watch.card.get("waiting") or [] if isinstance(item, dict)]
    if not items:
        return None
    shown = items[:4]
    rows = [
        [
            Text(f"[{item.get('code')}]", style="bold yellow"),
            Text(str(item.get("task_id") or ""), style="bold"),
            Text(str(item.get("question") or item.get("title") or "an item")),
        ]
        for item in shown
    ]
    if len(items) > len(shown):
        more = Text(f"… {len(items) - len(shown)} more: /roko pending", style="dim")
        rows.append([Text(""), Text(""), more])
    columns: list[dict[str, Any]] = [
        {"no_wrap": True},
        {"no_wrap": True},
        {"ratio": 1, "no_wrap": True, "overflow": "ellipsis"},
    ]
    code = str(shown[0].get("code") or "CODE")
    hint = Text(no_wrap=True, overflow="ellipsis")
    if not narrow:
        hint.append("answer in chat  ", style="dim")
    hint.append(f"/roko approve {code}", style="bold")
    hint.append("  or  ", style="dim")
    hint.append(f"/roko reject {code} NOTE", style="bold")
    pulse = "●" if int(now) % 2 == 0 else "○"
    panel = Panel(
        Group(grid(rows, columns), hint),
        title=Text(f"{pulse} waiting on you · {len(items)}", style="bold yellow"),
        title_align="left",
        border_style="yellow",
        box=box.ROUNDED,
        padding=(0, 1),
    )
    return Part(panel, len(rows) + 3)


def grid(rows: list[list[Text]], columns: list[dict[str, Any]]) -> Table:
    """A borderless table of `rows` without the columns that no row uses.

    rich measures an empty column as 0 cells but gives it 1, which overflows an expanding grid by one
    cell; it then shrinks the grid's `ratio` column to its text instead of stretching it.
    """
    keep = [i for i, spec in enumerate(columns) if spec.get("ratio") or any(row[i].plain for row in rows)]
    table = Table.grid(padding=(0, 1), expand=True)
    for i in keep:
        table.add_column(**columns[i])
    for row in rows:
        table.add_row(*(row[i] for i in keep))
    return table


def plan_part(watch: Watch, now: float, narrow: bool, budget: int | None, turn: float | None) -> Part | None:
    tasks = watch.tasks
    if not tasks:
        return None
    grouped = waves(tasks)
    order = [
        (number, task, index == 0)
        for number, wave in enumerate(grouped, start=1)
        for index, task in enumerate(wave)
    ]
    outcomes = [outcome_of(task) for _, task, _ in order]
    focus = next(
        (i for i, outcome in enumerate(outcomes) if outcome == "running"),
        next((i for i, outcome in enumerate(outcomes) if outcome == "pending"), len(order) - 1),
    )
    start, end = (0, len(order)) if budget is None else visible_rows(len(order), focus, budget)
    many_waves = len(grouped) > 1

    columns: list[dict[str, Any]] = [
        {"no_wrap": True},  # wave
        {"no_wrap": True},  # mark
        {"no_wrap": True},  # id
        {"ratio": 1, "no_wrap": True, "overflow": "ellipsis"},  # title
        {"no_wrap": True, "max_width": 22, "overflow": "ellipsis"},  # model
        {"no_wrap": True, "justify": "right"},  # attempts
        {"no_wrap": True, "justify": "right"},  # spend
        {"no_wrap": True, "max_width": 12 if narrow else 44, "overflow": "ellipsis"},  # gates
    ]
    blank = Text("")

    def note(hidden: list[dict[str, Any]], where: str) -> list[Text]:
        text = Text(f"{len(hidden)} more {where}: {tally(hidden)}", style="dim")
        return [blank, Text("⋮", style="dim"), blank, text, blank, blank, blank, blank]

    rows: list[list[Text]] = []
    if start:
        rows.append(note([task for _, task, _ in order[:start]], "above"))
    for position in range(start, end):
        number, task, first = order[position]
        outcome = outcomes[position]
        wave = f"wave {number}" if many_waves and (first or position == start) else ""
        title_style = "bold" if outcome == "running" else "dim" if outcome == "pending" else ""
        row = [
            Text(wave, style="dim"),
            task_mark(outcome, turn),
            Text(str(task.get("task_id") or "?"), style="bold"),
            Text(str(task.get("title") or ""), style=title_style),
            blank,
            blank,
            blank,
            gate_chips(task, narrow, now, step_since(watch, task.get("task_id"))),
        ]
        if not narrow:
            attempts = task.get("attempts")
            tries = attempts if isinstance(attempts, int) and not isinstance(attempts, bool) else 0
            row[4] = Text(str(task.get("model") or ""), style="dim")
            row[5] = Text(f"{tries}×" if tries else "", style="yellow" if tries > 1 else "dim")
            row[6] = Text(spent(task.get("cost_usd"), blank=True), style="dim")
        rows.append(row)
    if end < len(order):
        rows.append(note([task for _, task, _ in order[end:]], "below"))

    title = Text(no_wrap=True)
    if len(tasks) == 1:
        title.append("task", style="bold")
    else:
        title.append("plan", style="bold")
        shape = f" · {len(tasks)} tasks" + (f" in {len(grouped)} waves" if many_waves else "")
        title.append(shape, style="dim")
    return Part(Group(Rule(title, align="left", style="dim"), grid(rows, columns)), len(rows) + 1)


def errors_part(watch: Watch) -> Part | None:
    errors = [str(error) for error in watch.card.get("errors") or [] if error]
    if not errors:
        return None
    lines = [Text(f"⚠ {error}", style="red", no_wrap=True, overflow="ellipsis") for error in errors[-2:]]
    return Part(Group(*lines), len(lines))


def activity_part(watch: Watch, now: float, rows: int) -> Part:
    entries = [entry for entry in watch.timeline if isinstance(entry, dict)]
    entries = entries[-rows:] if rows > 0 else []
    rule = Rule(Text("activity", style="bold"), align="left", style="dim")
    if not entries:
        note = "no events were read" if watch.ended else "the run's events appear here as they happen"
        return Part(Group(rule, Text(note, style="dim")), 2)
    lines: list[list[Text]] = []
    for entry in entries:
        glyph, color = event_mark(entry)
        seen = watch.seen.get(entry.get("cursor"))
        fresh = seen is not None and now - seen < FRESH_S
        lines.append(
            [
                Text(clock(entry_time(watch, entry)), style="dim"),
                Text(glyph, style=color),
                Text(str(entry.get("text") or ""), style="bold" if fresh else ""),
            ]
        )
    columns: list[dict[str, Any]] = [
        {"no_wrap": True},
        {"no_wrap": True},
        {"ratio": 1, "no_wrap": True, "overflow": "ellipsis"},
    ]
    return Part(Group(rule, grid(lines, columns)), len(entries) + 1)


def footer(watch: Watch, now: float, narrow: bool) -> Part:
    out = Text(no_wrap=True, overflow="ellipsis")
    out.append("q" if watch.keys else "Ctrl-C", style="bold")
    out.append(" stop watching  " if narrow else " stop watching (the run goes on)   ", style="dim")
    if watch.keys:
        out.append("r", style="bold")
        out.append(" check now  " if narrow else " check now   ", style="dim")
    checked = f"checked {max(0, int(now - watch.fetched_at))}s ago" if watch.fetched_at else "not checked yet"
    out.append(f"{checked} · every {watch.interval:g}s", style="dim")
    return Part(out, 1)


# -- after the screen ------------------------------------------------------------------------------


def summary(watch: Watch, now: float, width: int = 100) -> Text:
    """The verdict and what to do next, under the last frame once the run has ended."""
    card = watch.card
    state = watch.state
    kind = str(card.get("kind") or "run")
    id8 = watch.run_id[:8]
    out = Text()
    head = f"{DONE_GLYPH.get(state, '?')} roko {KIND_WORD.get(kind, kind)} {id8} {state}"
    out.append(head, style=f"bold {STATE_COLOR.get(state, 'white')}")
    facts = []
    took = elapsed_ms(watch, now)
    if took is not None:
        facts.append(("in " if state == "succeeded" else "after ") + fmt_duration(took))
    cost, cap = card.get("cost_usd"), card.get("max_usd")
    if isinstance(cost, (int, float)) or isinstance(cap, (int, float)):
        facts.append(spent(cost) + (f" of {fmt_money(cap)}" if isinstance(cap, (int, float)) else ""))
    tasks = watch.tasks
    if tasks:
        passed = sum(1 for task in tasks if outcome_of(task) in ("passed", "already_satisfied"))
        facts.append(f"{passed}/{len(tasks)} tasks passed")
    gates = card.get("gates")
    if isinstance(gates, dict) and gates.get("total"):
        facts.append(f"gates {gates.get('passed', 0)}/{gates.get('total')}")
    if facts:
        line = " · ".join(facts)
        out.append((" " if cell_len(f"{head} {line}") <= width else "\n  ") + line)
    delivered = card.get("delivered")
    if isinstance(delivered, dict):
        delivered_lines(out, card, delivered)
    if kind == "plan_generate" and card.get("plan_id") and state == "succeeded":
        out.append("\n  plan    ", style="dim")
        out.append(str(card["plan_id"]), style="bold")
        out.append(f"   show it with /roko plans {card['plan_id']}", style="dim")
    if state in ("failed", "unverified"):
        unpassed = [
            f"{task.get('task_id')} {gate.get('gate')}"
            for task in tasks
            for gate in task.get("gates") or []
            if isinstance(gate, dict) and gate.get("passed") is False
        ]
        if unpassed:
            out.append("\n  checks  ", style="dim")
            out.append("✗ " + "  ✗ ".join(unpassed[:4]), style="red")
        errors = [str(error) for error in card.get("errors") or [] if error]
        if errors:
            out.append("\n  error   ", style="dim")
            out.append(errors[-1], style="red")
        if state == "unverified":
            out.append("\n          unverified is not success: no check confirmed the work", style="yellow")
        out.append("\n  why     ", style="dim")
        out.append(f"hermes roko status {id8} --why", style="bold")
    return out


def delivered_lines(out: Text, card: dict[str, Any], delivered: dict[str, Any]) -> None:
    merged = bool(delivered.get("merged"))
    out.append("\n  branch  ", style="dim")
    out.append(str(delivered.get("branch") or "?"), style="bold")
    if delivered.get("commit"):
        out.append(f" @ {delivered['commit']}", style="dim")
    out.append("  merged" if merged else "  not merged yet", style="green" if merged else "yellow")
    if delivered.get("diffstat"):
        out.append(f"\n          {delivered['diffstat']}", style="dim")
    files = [str(path) for path in delivered.get("files_changed") or []]
    for path in files[:4]:
        out.append(f"\n          {path}")
    if len(files) > 4:
        out.append(f"\n          … {len(files) - 4} more", style="dim")
    if delivered.get("promoted_into"):
        tag = f" (tag {delivered['promoted_tag']})" if delivered.get("promoted_tag") else ""
        out.append(f"\n          promoted into {delivered['promoted_into']}{tag}", style="dim")
    if merged:
        return
    for label, key in (("review", "review_command"), ("merge ", "merge_command")):
        if card.get(key):
            out.append(f"\n  {label}  ", style="dim")
            out.append(str(card[key]), style="bold")


def quit_note(watch: Watch) -> Text:
    out = Text()
    out.append(f"Stopped watching roko run {watch.run_id[:8]}", style="bold")
    out.append(f"; it is still {watch.state}. Watch again: ", style="dim")
    out.append(f"hermes roko watch {watch.run_id[:8]}", style="bold")
    return out


# -- the loop --------------------------------------------------------------------------------------


class Keys:
    """Single key presses, unechoed, while the screen is up.

    Where stdin is not a terminal, or termios is missing (Windows), `wait` only sleeps; Ctrl-C still
    stops the watch.
    """

    def __init__(self) -> None:
        self._fd: int | None = None
        self._saved: Any = None

    def __enter__(self) -> Keys:
        with contextlib.suppress(Exception):
            import termios
            import tty

            fd = sys.stdin.fileno()
            if os.isatty(fd):
                self._saved = termios.tcgetattr(fd)
                tty.setcbreak(fd)
                self._fd = fd
        return self

    def __exit__(
        self,
        kind: type[BaseException] | None,
        error: BaseException | None,
        trace: TracebackType | None,
    ) -> None:
        if self._fd is not None and self._saved is not None:
            with contextlib.suppress(Exception):
                import termios

                termios.tcsetattr(self._fd, termios.TCSADRAIN, self._saved)
        self._fd = None

    @property
    def interactive(self) -> bool:
        return self._fd is not None

    def wait(self, timeout: float) -> str | None:
        """The next key pressed within `timeout` seconds, or None."""
        if self._fd is None:
            time.sleep(timeout)
            return None
        ready, _, _ = select.select([self._fd], [], [], timeout)
        if not ready:
            return None
        return os.read(self._fd, 1).decode(errors="ignore") or None


def window_title(watch: Watch) -> str:
    """`⟳ roko 3f2a9c1e running · 2/5`: the run in a terminal tab's title."""
    tasks = watch.tasks
    done = sum(1 for task in tasks if outcome_of(task) in FINISHED_OUTCOMES)
    progress = f" · {done}/{len(tasks)}" if len(tasks) > 1 else ""
    return f"{DONE_GLYPH.get(watch.state, '⟳')} roko {watch.run_id[:8]} {watch.state}{progress}"


def draw(watch: Watch, now: float, console: Console) -> RenderableType:
    """`frame`, but a drawing problem shows as a line instead of stopping the screen."""
    try:
        return frame(watch, now, console.width, console.height)
    except Exception as exc:  # a card shape this version does not know
        return Text(f"roko: cannot draw run {watch.run_id[:8]}: {type(exc).__name__}: {exc}", style="red")


def watch(
    fetch: Fetch,
    *,
    run_id: str,
    interval: float,
    console: Console,
    first: Read | None = None,
    now: Callable[[], float] = time.time,
    keys: KeyWait | None = None,
    screen: bool = True,
) -> str:
    """Show run `run_id` until it ends ("ended") or the person stops watching ("quit").

    `fetch` returns the run's card and timeline and raises RokoError when roko cannot answer; the screen
    keeps the last answer and says it is retrying. `first` is a read already made, so a wrong run id
    fails before the screen opens.
    """
    state = Watch(run_id=run_id, interval=interval)
    if first is not None:
        state.take(first[0], first[1], now())
    else:
        check(state, fetch, now)
    outcome = "ended" if state.ended else follow(state, fetch, console, now, keys, screen)
    end = now()
    console.print(frame(state, end, console.width, final=True))
    # soft_wrap: the terminal wraps a long command, so it still copies as one line.
    after = summary(state, end, console.width) if outcome == "ended" else quit_note(state)
    console.print(after, soft_wrap=True)
    return outcome


def check(state: Watch, fetch: Fetch, now: Callable[[], float]) -> None:
    """Read the run again. When roko cannot answer, the screen keeps the last answer and says so."""
    try:
        card, timeline = fetch()
    except RokoError as exc:
        state.problem = exc.message
    else:
        state.take(card, timeline, now())


def follow(
    state: Watch,
    fetch: Fetch,
    console: Console,
    now: Callable[[], float],
    keys: KeyWait | None,
    screen: bool,
) -> str:
    """The live screen, until the run ends or the person stops watching."""
    with contextlib.ExitStack() as stack:
        reader: KeyWait = keys if keys is not None else stack.enter_context(Keys())
        state.keys = bool(getattr(reader, "interactive", True))
        if console.is_terminal:
            console.file.write(PUSH_TITLE)
            stack.callback(console.file.write, POP_TITLE)
            console.set_window_title(window_title(state))
        stack.enter_context(
            Live(
                get_renderable=lambda: draw(state, now(), console),
                console=console,
                screen=screen,
                transient=True,
                refresh_per_second=FPS,
                redirect_stdout=False,
                redirect_stderr=False,
            )
        )
        due = now() + state.interval
        try:
            while True:
                left = due - now()
                key = reader.wait(left) if left > 0 else None
                if key in QUIT_KEYS:
                    return "quit"
                if key in CHECK_KEYS or now() >= due:
                    check(state, fetch, now)
                    console.set_window_title(window_title(state))
                    due = now() + state.interval
                    if state.ended:
                        return "ended"
        except KeyboardInterrupt:
            return "quit"

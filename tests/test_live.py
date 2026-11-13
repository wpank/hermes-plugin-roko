"""`hermes roko watch` on a terminal (live.py) and the progress lines of the plain-text cards."""

from __future__ import annotations

import argparse
import io
import re
import sys
from datetime import UTC, datetime
from typing import Any

import pytest
from conftest import Approvals
from fake_roko import FakeRoko
from rich.cells import cell_len
from rich.console import Console

from hermes_plugin_roko import cli, live, render
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.runtime import Runtime

NOW = 1_760_000_000.0
RUN = "3f2a9c1e7b4d4e0f9a11"
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")


def iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, UTC).isoformat().replace("+00:00", "Z")


def task(task_id: str, outcome: str, *, deps: tuple[str, ...] = (), **extra: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "task_id": task_id,
        "title": f"the {task_id} work",
        "outcome": outcome,
        "model": "claude-haiku-4-5" if outcome != "pending" else None,
        "attempts": 0 if outcome == "pending" else 1,
        "cost_usd": None,
        "depends_on": list(deps),
        "gates": [],
    }
    row.update(extra)
    return row


def plan_card(state: str = "running", **extra: Any) -> dict[str, Any]:
    card: dict[str, Any] = {
        "run_id": RUN,
        "kind": "plan",
        "label": "stats-json-flag",
        "plan_id": "stats-json-flag",
        "state": state,
        "cost_usd": 0.105,
        "max_usd": 0.30,
        "tokens": {"input": 41_234, "output": 3_120, "cache_read": 0, "cache_write": 0},
        "started_at": iso(NOW - 72),
        "finished_at": None,
        "duration_ms": None,
        "gates": {"passed": 3, "failed": 0, "total": 3},
        "errors": [],
        "waiting": [],
        "tasks": [
            task(
                "T1",
                "passed",
                cost_usd=0.041,
                gates=[
                    {"gate": "verify[0:build]", "passed": True, "runs": 1},
                    {"gate": "verify[1:test]", "passed": True, "runs": 1},
                ],
            ),
            task(
                "T2",
                "running",
                deps=("T1",),
                attempts=2,
                rung="verify[1:test]",
                gates=[{"gate": "verify[0:build]", "passed": True, "runs": 2}],
            ),
            task("T3", "pending", deps=("T1",)),
            task("T4", "pending", deps=("T2", "T3")),
        ],
    }
    card.update(extra)
    return card


TIMELINE = [
    {"cursor": 1, "type": "plan_started", "task_id": None, "text": "plan stats-json-flag started (4 tasks)"},
    {"cursor": 2, "type": "task_started", "task_id": "T1", "text": "Task 1 · started: the T1 work"},
    {
        "cursor": 3,
        "type": "gate_result",
        "task_id": "T1",
        "passed": True,
        "text": "Task 1 · check verify[1:test] passed",
    },
    {"cursor": 4, "type": "task_completed", "task_id": "T1", "outcome": "passed", "text": "Task 1 · passed"},
    {
        "cursor": 5,
        "type": "gate_result",
        "task_id": "T2",
        "passed": False,
        "text": "Task 2 · check verify[1:test] did not pass",
    },
    {"cursor": 6, "type": "agent_spawned", "task_id": "T2", "text": "Task 2 · try 2 on claude-haiku-4-5"},
]


def watching(
    card: dict[str, Any], timeline: list[dict[str, Any]] = TIMELINE, *, at: float = NOW
) -> live.Watch:
    watch = live.Watch(run_id=RUN, interval=2.0)
    watch.take(card, timeline, at)
    return watch


def text_of(renderable: Any, width: int = 100) -> str:
    console = Console(record=True, width=width, color_system=None)
    console.print(renderable)
    return console.export_text()


def widest(text: str) -> int:
    return max(cell_len(line) for line in text.splitlines())


# -- the frame -------------------------------------------------------------------------------------


def test_a_wide_frame_shows_the_run_its_waves_and_activity() -> None:
    card = plan_card(waiting=[{"code": "a1b2c3", "task_id": "T2", "question": "May the run call gh once?"}])
    text = text_of(live.frame(watching(card), NOW, 100), 100)
    lines = text.splitlines()
    assert lines[0].startswith("╭─ roko ─") and lines[0].endswith("╮")
    assert "RUNNING   plan 3f2a9c1e · stats-json-flag" in lines[1]
    assert (
        "elapsed 1m12s   spend" in lines[2]
        and "$0.105 of $0.30 · 35%   tokens 41.2k in · 3.1k out" in lines[2]
    )
    assert "tasks ▰▰▱▱ 1/4   gates 3/3" in lines[3]
    assert "● waiting on you · 1" in text and "[a1b2c3] Task 2 May the run call gh once?" in text
    assert "answer in chat  /roko approve a1b2c3  or  /roko reject a1b2c3 NOTE" in text
    assert "plan · 4 tasks in 3 steps" in text
    row = next(line for line in lines if " 01 " in line and "step 1" in line)
    assert "✓ 01 the T1 work" in row and row.rstrip().endswith("claude-haiku-4-5 1× $0.041 ✓ build  ✓ test")
    row = next(line for line in lines if line.startswith("step 2 "))
    assert "⠋ 02 the T2 work" in row and row.rstrip().endswith(
        "claude-haiku-4-5 2×        ✓ build ×2  ↻ test"
    )
    assert next(line for line in lines if " 04 " in line).startswith("step 3 · 04")
    assert "✗ Task 2 · check verify[1:test] did not pass" in text
    assert lines[-1].startswith("q stop watching (the run goes on)   r check now   checked 0s ago · every 2s")
    assert widest(text) <= 100


def test_a_narrow_frame_keeps_the_layout_in_60_columns() -> None:
    card = plan_card(waiting=[{"code": "a1b2c3", "task_id": "T2", "question": "May the run call gh once?"}])
    text = text_of(live.frame(watching(card), NOW, 60), 60)
    assert widest(text) <= 60
    assert "tokens" not in text and "claude-haiku" not in text.split("activity")[0].split("plan ·")[1]
    row = next(line for line in text.splitlines() if " 01 " in line and "step 1" in line)
    assert row.rstrip().endswith("✓2")
    assert "/roko approve a1b2c3  or  /roko reject a1b2c3 NOTE" in text and "answer in chat" not in text
    assert text.splitlines()[-1].startswith("q stop watching  r check now  checked 0s ago")


def test_without_keys_the_footer_offers_only_ctrl_c() -> None:
    watch = watching(plan_card())
    watch.keys = False
    footer = text_of(live.frame(watch, NOW, 100)).splitlines()[-1]
    assert (
        footer.startswith("Ctrl-C stop watching (the run goes on)   checked 0s ago")
        and "r check" not in footer
    )
    with live.Keys() as keys:  # pytest's stdin is no terminal
        assert not keys.interactive


def test_the_clock_and_spinner_move_between_checks() -> None:
    watch = watching(plan_card())
    first = text_of(live.frame(watch, NOW, 100))
    later = text_of(live.frame(watch, NOW + 5.3, 100))
    assert "elapsed 1m12s" in first and "elapsed 1m17s" in later and "checked 5s ago" in later
    assert live.spinner(NOW) != live.spinner(NOW + 0.25)
    # a card with only roko's elapsed_ms counts on from when it was read
    watch = watching(plan_card(started_at=None, elapsed_ms=10_000))
    assert "elapsed 13s" in text_of(live.frame(watch, NOW + 3, 100))


def test_new_activity_is_marked_with_the_time_it_arrived() -> None:
    watch = watching(plan_card(), TIMELINE[:4], at=NOW - 10)
    watch.take(plan_card(), TIMELINE, NOW - 1)
    text = text_of(live.frame(watch, NOW, 100))
    arrived = live.clock(NOW - 1)
    assert f"{arrived} ✗ Task 2 · check verify[1:test] did not pass" in text
    assert f"{arrived} ✓ T1 passed" not in text  # it was there when watching began


def test_a_running_task_says_what_it_is_doing_and_for_how_long() -> None:
    watch = watching(plan_card(), TIMELINE[:5], at=NOW - 40)
    watch.take(plan_card(), TIMELINE, NOW - 34)  # attempt 2 began between these checks
    wide = text_of(live.frame(watch, NOW, 100)).splitlines()
    assert (
        next(line for line in wide if line.startswith("step 2 ")).rstrip().endswith("✓ build ×2  ↻ test 34s")
    )
    narrow = text_of(live.frame(watch, NOW, 60), 60).splitlines()
    assert next(line for line in narrow if line.startswith("step 2 ")).rstrip().endswith("↻ test 34s")
    one = plan_card(tasks=[task("T1", "running")])
    timeline = [{"cursor": 9, "type": "agent_spawned", "task_id": "T1", "text": "Task 1 · try 1 on m"}]
    watch = watching(one, [], at=NOW - 70)
    watch.take(one, timeline, NOW - 65)
    assert text_of(live.frame(watch, NOW, 100)).split("activity")[0].rstrip().endswith("working 1m05s")


def test_a_short_terminal_windows_a_long_plan_around_the_work_in_progress() -> None:
    tasks = [task(f"T{i}", "passed" if i < 20 else "running" if i == 20 else "pending") for i in range(1, 41)]
    card = plan_card(tasks=tasks, errors=["Task 7 · check verify[0:test] did not pass"])
    text = text_of(live.frame(watching(card), NOW, 100, 24))
    assert len(text.splitlines()) <= 24
    assert "more above: " in text and "passed" in text.split("more above: ")[1].splitlines()[0]
    assert "more below: 13 pending" in text and "⠋ 20 the T20 work" in text
    assert "⚠ Task 7 · check verify[0:test] did not pass" in text
    assert text.splitlines()[-1].startswith("q stop watching")
    final = text_of(live.frame(watching(card), NOW, 100, 24, final=True))
    assert " T1 " in final and " T40 " in final and "q stop watching" not in final
    assert "⟳  RUNNING" in final and "⟳ 20 the T20 work" in final  # a frame left on screen does not spin


def test_visible_rows_keep_the_focus_in_view() -> None:
    assert live.visible_rows(5, 4, 10) == (0, 5)
    assert live.visible_rows(30, 0, 10) == (0, 9)
    assert live.visible_rows(30, 29, 10) == (21, 30)
    start, end = live.visible_rows(30, 15, 10)
    assert start <= 15 < end and end - start == 8


def test_no_color_keeps_the_layout() -> None:
    out = io.StringIO()
    console = Console(file=out, width=100, force_terminal=True, color_system="truecolor", no_color=True)
    console.print(live.frame(watching(plan_card()), NOW, 100))
    codes = {
        int(code)
        for match in re.findall(r"\x1b\[([0-9;]*)m", out.getvalue())
        for code in match.split(";")
        if code
    }
    assert not codes & (set(range(30, 50)) | set(range(90, 108)))
    assert ANSI.sub("", out.getvalue()) == text_of(live.frame(watching(plan_card()), NOW, 100))


def test_planning_queued_and_odd_cards_still_draw() -> None:
    planning = {"run_id": RUN, "kind": "plan_generate", "label": "plan generation", "state": "running"}
    text = text_of(live.frame(watching(planning, []), NOW, 80))
    assert (
        "planning 3f2a9c1e" in text
        and "roko's planner is writing the plan…" in text
        and "activity" not in text
    )
    queued = plan_card(state="queued", position=2, started_at=None, cost_usd=None, tasks=[], gates={})
    text = text_of(live.frame(watching(queued, []), NOW, 80))
    assert "⏳  QUEUED" in text and "elapsed not started" in text and "$0.00 of $0.30 · 0%" in text
    assert "place 2 in roko's queue" in text and "the run's events appear here as they happen" in text
    odd = {
        "state": 7,
        "tasks": [None, {"task_id": 3, "gates": "x"}],
        "gates": [],
        "waiting": "no",
        "tokens": 5,
    }
    odd_text = text_of(live.draw(watching(odd), NOW, Console(width=80)))
    assert "cannot draw" not in odd_text and " 7 " in odd_text


# -- after the screen ------------------------------------------------------------------------------


def done_card(state: str = "succeeded", **extra: Any) -> dict[str, Any]:
    tasks = [task("T1", "passed", gates=[{"gate": "verify[0:test]", "passed": True}])]
    card = plan_card(state=state, kind="run", label="Add clamp()", plan_id=None, tasks=tasks)
    card.update(duration_ms=46_000, finished_at=iso(NOW - 26), cost_usd=0.0107, max_usd=0.4)
    card["gates"] = {"passed": 1, "failed": 0, "total": 1}
    card.update(extra)
    return card


def test_the_summary_of_a_run_that_succeeded_says_how_to_take_the_work() -> None:
    card = done_card(
        delivered={
            "branch": f"roko/batch/{RUN}",
            "commit": "9c1d2e3f4a5b",
            "merged": False,
            "diffstat": "2 files changed, 41 insertions(+), 3 deletions(-)",
            "files_changed": ["src/math.rs", "tests/math.rs"],
        },
        review_command=f"git -C ~/demo diff main..roko/batch/{RUN}",
        merge_command=f"git -C ~/demo merge --ff-only roko/batch/{RUN}",
    )
    console = Console(record=True, width=60, color_system=None)
    console.print(live.summary(watching(card), NOW), soft_wrap=True)  # as watch prints it
    text = console.export_text()
    assert text.splitlines() == [
        "✓ roko run 3f2a9c1e succeeded in 46s · $0.011 of $0.40 · 1/1 tasks passed · gates 1/1",
        f"  branch  roko/batch/{RUN} @ 9c1d2e3f4a5b  not merged yet",
        "          2 files changed, 41 insertions(+), 3 deletions(-)",
        "          src/math.rs",
        "          tests/math.rs",
        f"  review  git -C ~/demo diff main..roko/batch/{RUN}",
        f"  merge   git -C ~/demo merge --ff-only roko/batch/{RUN}",
    ]


def test_the_summary_of_a_run_that_failed_says_why() -> None:
    tasks = [task("T1", "failed", gates=[{"gate": "verify[0:test]", "passed": False, "runs": 3}])]
    card = done_card("failed", tasks=tasks, errors=["T1 failed after 3 attempts"])
    text = text_of(live.summary(watching(card), NOW, 72), 72)
    assert text.splitlines()[:2] == [
        "✗ roko run 3f2a9c1e failed",
        "  after 46s · $0.011 of $0.40 · 0/1 tasks passed · gates 1/1",
    ]
    assert "  checks  ✗ T1 verify[0:test]" in text and "  error   T1 failed after 3 attempts" in text
    assert "  why     hermes roko status 3f2a9c1e --why" in text
    unverified = text_of(live.summary(watching(done_card("unverified")), NOW))
    assert "unverified is not success" in unverified


# -- the loop --------------------------------------------------------------------------------------


class Clock:
    def __init__(self) -> None:
        self.at = NOW

    def __call__(self) -> float:
        return self.at


class Keys:
    """Scripted key presses. Waiting moves the fake clock on instead of sleeping."""

    def __init__(self, clock: Clock, script: list[Any] | None = None) -> None:
        self.clock, self.script, self.waits = clock, list(script or []), []

    def wait(self, timeout: float) -> str | None:
        self.waits.append(round(timeout, 3))
        if self.script:
            key = self.script.pop(0)
            if key is KeyboardInterrupt:
                raise KeyboardInterrupt
            if key is not None:
                self.clock.at += 0.1
                return str(key)
        self.clock.at += timeout
        return None


class Reads:
    """The answers roko gives, one per check; the last one repeats."""

    def __init__(self, *answers: Any) -> None:
        self.answers, self.calls = list(answers), 0

    def __call__(self) -> live.Read:
        self.calls += 1
        answer = self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]
        if isinstance(answer, Exception):
            raise answer
        return answer  # type: ignore[no-any-return]


def run_watch(reads: Reads, keys: Keys, clock: Clock, width: int = 100) -> tuple[str, str]:
    console = Console(record=True, width=width, color_system=None)
    outcome = live.watch(reads, run_id=RUN, interval=2.0, console=console, now=clock, keys=keys, screen=False)
    return outcome, console.export_text()


def test_watch_follows_the_run_until_it_ends_and_leaves_a_summary() -> None:
    clock = Clock()
    unreachable = RokoError(Code.UNREACHABLE, "roko serve is not reachable at http://127.0.0.1:6677")
    reads = Reads((plan_card(), TIMELINE[:2]), unreachable, (plan_card(), TIMELINE), (done_card(), TIMELINE))
    keys = Keys(clock)
    outcome, text = run_watch(reads, keys, clock)
    assert outcome == "ended" and reads.calls == 4 and keys.waits == [2.0, 2.0, 2.0]
    assert "✓  SUCCEEDED   run 3f2a9c1e" in text and "q stop watching" not in text
    assert text.rstrip().endswith(
        "✓ roko run 3f2a9c1e succeeded in 46s · $0.011 of $0.40 · 1/1 tasks passed · gates 1/1"
    )


def test_a_failed_check_keeps_the_last_card_and_says_it_retries() -> None:
    watch = watching(plan_card())
    live.check(watch, Reads(RokoError(Code.UNREACHABLE, "roko serve is not reachable")), lambda: NOW + 2)
    text = text_of(live.frame(watch, NOW + 2, 100))
    assert "⚠ roko serve is not reachable · retrying" in text and "plan · 4 tasks in 3 steps" in text
    live.check(watch, Reads((plan_card(), TIMELINE)), lambda: NOW + 4)
    assert watch.problem is None and "retrying" not in text_of(live.frame(watch, NOW + 4, 100))


def test_q_stops_watching_and_says_how_to_watch_again() -> None:
    clock = Clock()
    reads = Reads((plan_card(), TIMELINE))
    outcome, text = run_watch(reads, Keys(clock, ["x", "q"]), clock)
    assert outcome == "quit" and reads.calls == 1  # a stray key does not check early
    assert (
        "Stopped watching roko run 3f2a9c1e; it is still running. Watch again: hermes roko watch 3f2a9c1e"
        in text
    )


def test_the_terminal_title_follows_the_run_and_is_put_back() -> None:
    assert live.window_title(watching(plan_card())) == "⟳ roko 3f2a9c1e running · 1/4"
    assert live.window_title(watching(done_card())) == "✓ roko 3f2a9c1e succeeded"
    clock, out = Clock(), io.StringIO()
    console = Console(file=out, width=100, force_terminal=True, color_system=None)
    reads = Reads((plan_card(), TIMELINE), (done_card(), TIMELINE))
    live.watch(reads, run_id=RUN, interval=2.0, console=console, now=clock, keys=Keys(clock), screen=False)
    written = out.getvalue()
    assert written.index(live.PUSH_TITLE) < written.index("\x1b]0;✓ roko 3f2a9c1e succeeded\x07")
    assert written.index("\x1b]0;✓ roko 3f2a9c1e succeeded\x07") < written.index(live.POP_TITLE)


def test_r_checks_at_once_and_ctrl_c_stops_watching() -> None:
    clock = Clock()
    reads = Reads((plan_card(), TIMELINE))
    outcome, _ = run_watch(reads, Keys(clock, ["r", KeyboardInterrupt]), clock)
    assert outcome == "quit" and reads.calls == 2


def test_a_run_that_already_ended_prints_at_once() -> None:
    clock = Clock()
    keys = Keys(clock)
    outcome, text = run_watch(Reads((done_card(), TIMELINE)), keys, clock)
    assert outcome == "ended" and keys.waits == [] and "✓ roko run 3f2a9c1e succeeded" in text


# -- hermes roko watch / status ----------------------------------------------------------------------


def watch_args(run: str) -> argparse.Namespace:
    return argparse.Namespace(roko_command="watch", roko_watch_run=run, roko_interval=0.2, roko_once=False)


def test_watch_on_a_terminal_opens_the_live_view(
    rt: Runtime,
    fake: FakeRoko,
    approvals: Approvals,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from hermes_plugin_roko.tools import call as tool

    fake.run_script = ["running"]
    run_id = tool(rt, "roko_run", {"prompt": "Add clamp()", "max_usd": 1})["run_id"]
    seen: dict[str, Any] = {}

    def fake_watch(fetch: live.Fetch, **kwargs: Any) -> str:
        seen.update(kwargs, again=fetch())
        return "quit"

    monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
    monkeypatch.setattr(live, "watch", fake_watch)
    assert cli.make_main(rt)(watch_args(run_id[:8])) == 0
    assert seen["run_id"] == run_id and seen["interval"] == 1.0  # at most one check a second
    card, timeline = seen["first"]
    assert card["run_id"] == run_id and card["state"] == "running"
    assert any(entry["type"] == "task_started" for entry in timeline)
    seen.clear()
    assert cli.make_main(rt)(watch_args("nope")) == 1  # fails before any screen opens
    assert seen == {} and "not found" in capsys.readouterr().err


def test_watch_of_a_finished_run_on_a_terminal_prints_the_last_frame_and_summary(
    rt: Runtime,
    fake: FakeRoko,
    approvals: Approvals,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    from hermes_plugin_roko.tools import call as tool

    fake.run_script = ["succeeded"]
    run_id = tool(rt, "roko_run", {"prompt": "Add clamp()", "max_usd": 1})["run_id"]
    monkeypatch.setenv("NO_COLOR", "1")
    monkeypatch.setattr(sys.stdout, "isatty", lambda: True)
    assert cli.make_main(rt)(watch_args("last")) == 0
    out = ANSI.sub("", capsys.readouterr().out)
    assert f"SUCCEEDED   run {run_id[:8]} · Add clamp()" in out
    assert "✓ 01 do the work" in out and "✓ Task 1 · check verify[0:test] passed" in out
    assert f"✓ roko run {run_id[:8]} succeeded" in out and "1/1 tasks passed · gates 1/1" in out


def test_status_why_explains_a_run(
    rt: Runtime, fake: FakeRoko, approvals: Approvals, capsys: pytest.CaptureFixture[str]
) -> None:
    from hermes_plugin_roko.tools import call as tool

    fake.run_script = ["failed"]
    run_id = tool(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    args = argparse.Namespace(roko_command="status", roko_status_run=run_id, roko_json=False, roko_why=True)
    assert cli.make_main(rt)(args) == 0
    assert "Why: " in capsys.readouterr().out


# -- the plain-text cards ----------------------------------------------------------------------------


def test_the_card_text_has_progress_spend_and_waves() -> None:
    lines = render.card(plan_card()).splitlines()
    assert "tasks ▰▱▱▱ 1/4" in lines
    assert "spend ▰▰▰▰▱▱▱▱▱▱ $0.10 of $0.30 (35%)" in lines
    assert "plan  step 1 ✓ 01 → step 2 ⟳ 02 · 03 → step 3 · 04" in lines


def test_the_card_text_puts_what_waits_on_you_before_the_tasks() -> None:
    waiting = [{"code": "a1b2c3", "title": "T2 wants gh", "question": "May the run call gh once?"}]
    text = render.card(plan_card(waiting=waiting))
    assert text.index("Waiting on you:") < text.index("Tasks:")
    failed = render.card(plan_card(tasks=[task("T1", "failed"), task("T2", "blocked")]))
    assert "tasks ▰▰ 2/2 · 2 failed" in failed


def test_the_overview_leads_with_what_waits_and_has_a_spend_bar() -> None:
    view = {
        "roko": {"version": "0.9.0", "url": "http://127.0.0.1:6677"},
        "spend": {"today_usd": 3.2, "max_day_usd": 20.0},
        "recent_runs": [],
        "waiting_on_person": [{"code": "a1b2c3"}],
    }
    lines = render.overview(view).splitlines()
    assert lines[1] == "● 1 waiting on you — /roko pending"
    assert lines[2] == "today $3.20 of $20.00 ▰▰▱▱▱▱▱▱▱▱ 16%"


def test_a_long_plan_still_fits_one_chat_message() -> None:
    tasks = [
        task(f"T{i}", "pending", deps=(f"T{i - 1}",) if i > 1 else (), title="x" * 90) for i in range(1, 80)
    ]
    text = render.card(plan_card(tasks=tasks))
    assert len(text) <= render.MAX_REPLY_CHARS and "plan  step 1 · 01 → step 2 · 02" in text
    assert render.waves_line(tasks).endswith("…")


def test_bar_ratio_and_percent() -> None:
    assert render.bar(0.0, 5) == "▱▱▱▱▱" and render.bar(0.001, 5) == "▰▱▱▱▱" and render.bar(3.0, 5) == "▰▰▰▰▰"
    assert render.ratio(0.5, 2) == 0.25 and render.ratio(None, 2) is None and render.ratio(1, 0) is None
    assert render.percent(0.0) == "0%" and render.percent(0.0005) == "<1%" and render.percent(0.354) == "35%"


def test_run_waves_key_tasks_by_plan_and_keep_every_task() -> None:
    tasks = [
        {"plan_id": "a", "task_id": "T1", "depends_on": []},
        {"plan_id": "a", "task_id": "T2", "depends_on": ["T1"]},
        {"plan_id": "b", "task_id": "T1", "depends_on": []},
        {"plan_id": "b", "task_id": "T2", "depends_on": ["T3"]},
        {"plan_id": "b", "task_id": "T3", "depends_on": ["T2"]},
    ]
    shape = [[(t["plan_id"], t["task_id"]) for t in wave] for wave in render.waves(tasks)]
    assert shape == [[("a", "T1"), ("b", "T1")], [("a", "T2")], [("b", "T2"), ("b", "T3")]]
    chain = [{"task_id": f"T{i}", "depends_on": [f"T{i - 1}"] if i else []} for i in range(40)]
    assert sum(len(wave) for wave in render.waves(chain)) == 40

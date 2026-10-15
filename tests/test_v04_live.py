"""0.4.0: roko's five loops on the card, the live relay, the `/live` socket and `/loops`.

The relay tests run against the replay roko (tests/replay_roko.py): real recorded runs revealed over
time, with the live events a newer roko writes synthesized from them, streamed on its hub like roko's
own `GET /api/events`.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import live_relay, loopevents, rundata, ui_api, views
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

STREAM = loopevents.STREAM_PREFIX


def live_row(
    kind: str, payload: dict[str, Any], *, task: str = "T1", attempt: int = 1, **extra: Any
) -> dict[str, Any]:
    record = {
        "kind": kind,
        "plan_id": "p",
        "task_id": task,
        "attempt": attempt,
        "live": True,
        "payload": payload,
    }
    record.update(extra)
    return {
        "type": "agent_output",
        "plan_id": "p",
        "task_id": task,
        "attempt": attempt,
        "content": STREAM + json.dumps(record),
    }


def loops_of(
    kind: str, event: dict[str, Any], ctx: loopevents.LoopContext | None = None
) -> list[dict[str, Any]]:
    return loopevents.loop_events(
        kind, {"plan_id": "p", "task_id": "T1", "ts_millis": 1000, **event}, ctx or loopevents.LoopContext()
    )


# -- the loop vocabulary ---------------------------------------------------------------------------


def test_route_decided_is_an_l1_route_with_its_rival() -> None:
    [loop] = loops_of(
        "route_decided",
        {
            "attempt": 2,
            "model": "glm-5.1",
            "provider": "zai",
            "source": "router",
            "stage": "cascade",
            "candidates": [
                {"model": "glm-5.1", "provider": "zai", "score": 0.8, "p": 0.82, "eligible": True},
                {"model": "claude-sonnet-4-6", "score": 0.9, "eligible": False, "ineligible_reason": "cli"},
                {"model": "gpt-5.4-mini", "score": 0.7, "p": 0.71, "eligible": True},
            ],
        },
    )
    assert loop["ring"] == "L1" and loop["kind"] == "route"
    assert loop["text"] == "T1 attempt 2 → glm-5.1 (learned; p 0.82; over gpt-5.4-mini 0.71)"
    assert loop["data"]["candidates"][1]["eligible"] is False and loop["key"] == "route:p:T1:2:glm-5.1:router"


def test_failover_retry_and_waves() -> None:
    ctx = loopevents.LoopContext()
    [failover] = loops_of(
        "route_decided", {"attempt": 1, "model": "b", "source": "failover", "reason": "a timed out"}, ctx
    )
    assert (
        failover["kind"] == "failover"
        and failover["text"] == "T1 attempt 1 switched to b (failover): a timed out"
    )
    numbered = loopevents.LoopContext()  # a roko that numbers attempts but publishes no route_decided
    assert loops_of("agent_spawned", {"attempt": 1, "model": "a"}, numbered) == []
    [switch] = loops_of("agent_spawned", {"attempt": 1, "model": "b"}, numbered)
    assert switch["kind"] == "failover" and switch["text"] == "T1 switched to b (failover)"
    [retry] = loops_of("agent_spawned", {"attempt": 2, "model": "b"}, numbered)
    assert retry["kind"] == "retry" and retry["text"] == "T1 attempt 2 on b" and retry["ring"] == "L1"
    older = loopevents.LoopContext()  # an older roko numbers every attempt 0: spawns are counted
    assert loops_of("agent_spawned", {"attempt": 0, "model": "a"}, older) == []
    [again] = loops_of("agent_spawned", {"attempt": 0, "model": "a"}, older)
    assert again["text"] == "T1 attempt 2 on a"
    ctx.set_waves([["p/T1"], ["p/T2", "p/T4"]])
    [wave] = loopevents.loop_events("task_started", {"plan_id": "p", "task_id": "T2"}, ctx)
    assert wave["text"] == "wave 2 open: T2, T4 in parallel" and wave["key"] == "wave:1"
    assert loopevents.loop_events("task_started", {"plan_id": "p", "task_id": "T4"}, ctx) == []


@pytest.mark.parametrize(
    ("kind", "event", "ring", "loop_kind", "text"),
    [
        (
            "effect_staged",
            {"effect_id": "e1", "tool": "mail.send", "server": "mail", "attempt": 1},
            "L0",
            "tool_held",
            "T1 wants to call mail.send on mail: held for you",
        ),
        (
            "effect_decided",
            {"effect_id": "e1", "tool": "mail.send", "server": "mail", "outcome": "applied"},
            "L0",
            "tool_decided",
            "mail.send on mail: applied",
        ),
        (
            "event_log_entry",
            {"event_type": "gate_regression", "message": "verify[0:test] passed before and fails now"},
            "L1",
            "regression",
            "T1: verify[0:test] passed before and fails now",
        ),
        (
            "diagnosis",
            {
                "summary": {
                    "id": "conductor:k:restart",
                    "subject": "T3",
                    "detail": "silent 180 s",
                    "intervention_taken": "restarted",
                }
            },
            "L2",
            "diagnosis",
            "conductor: T3 · restarted",
        ),
        (
            "inbox_item_received",
            {"item_id": "b1", "category": "budget_alert", "urgency": "high", "summary": "spend passed 80%"},
            "L2",
            "budget",
            "spend passed 80%",
        ),
        (
            "inbox_item_received",
            {
                "item_id": "budget:p:80",
                "category": "budget_alert",
                "urgency": "high",
                "summary": "plan p has spent $0.8123 of $1.0000 (80%)",
            },
            "L2",
            "budget",
            "spend passed 80% of the cap: $0.81 of $1.00",
        ),
        (
            "confirm_waiting",
            {
                "attempt": 1,
                "attempt_key": "k",
                "rung": "rung[sign-off]",
                "question": "OK?",
                "timeout_secs": 1800,
                "deadline_at": "x",
            },
            "L2",
            "hold",
            "T1 waits for your sign-off (30 min)",
        ),
        (
            "confirm_resolved",
            {"attempt": 1, "attempt_key": "k", "rung": "rung[sign-off]", "outcome": "timed_out"},
            "L2",
            "hold",
            "T1 sign-off: timed out, the check was skipped",
        ),
        (
            "task_phase_changed",
            {"old_phase": "graph-executing", "new_phase": "awaiting_approval"},
            "L2",
            "hold",
            "T1 waits for your review",
        ),
        (
            "knowledge_written",
            {
                "admission": "full_admitted",
                "entry_id": "k1",
                "reinforced": 2,
                "promoted": 1,
                "lesson": "use python3",
            },
            "L3",
            "knowledge",
            "roko learned from T1: use python3 · reinforced 2 · promoted 1",
        ),
        (
            "knowledge_written",
            {"admission": "duplicate", "lesson": "x"},
            "L3",
            "knowledge",
            "T1 confirmed what roko knew: x",
        ),
        (
            "knowledge_written",
            {"admission": "full_deferred"},
            "L3",
            "knowledge",
            "T1's lesson waits for more evidence",
        ),
        (
            "gate_thresholds_updated",
            {
                "snapshot_json": json.dumps(
                    {
                        "rungs": {
                            "2": {"ema_pass_rate": 0.92, "total_observations": 30},
                            "0": {"ema_pass_rate": 1.0, "total_observations": 4},
                        }
                    }
                )
            },
            "L3",
            "thresholds",
            "gate thresholds updated: test 92% · compile 100%",
        ),
        (
            "loop_health",
            {"loop_id": "L-route", "state": "healthy", "h": 0.1, "ts": "t1"},
            "L4",
            "loop_health",
            "L-route: healthy · h 0.10",
        ),
        (
            "loop_transition",
            {
                "loop_id": "L-know",
                "from": "healthy",
                "to": "watch",
                "reason": "eps up",
                "rule": "r",
                "actor": "m2",
                "ts": "t2",
            },
            "L4",
            "loop_health",
            "L-know: healthy → watch (eps up)",
        ),
        (
            "event_log_entry",
            {"event_type": "learning.guarded_commit", "message": "router update", "timestamp_ms": 5},
            "L4",
            "guarded_commit",
            "a learning update was held back by its guard: router update",
        ),
    ],
)
def test_each_loop_event(kind: str, event: dict[str, Any], ring: str, loop_kind: str, text: str) -> None:
    [loop] = loops_of(kind, event)
    assert (loop["ring"], loop["kind"], loop["text"]) == (ring, loop_kind, text)
    assert loop["key"] and loop["ts"] == 1000 and loop["task_id"] == "T1"


def test_events_that_name_their_plan_elsewhere() -> None:
    # roko's diagnoses and budget alerts carry no plan_id; their subject or id names it.
    ladder = {"summary": {"id": "ladder_exhausted:plan-a/T2", "subject": "T2 exhausted the model ladder"}}
    assert loopevents.event_scope("diagnosis", ladder) == ("plan-a", "T2")
    watch = {
        "summary": {
            "id": "stall-watchdog:k:cancelled",
            "subject": "plan-a/T3",
            "detail": "agent stalled",
            "intervention_taken": "cancelled the stalled attempt",
        }
    }
    [loop] = loopevents.loop_events("diagnosis", watch, loopevents.LoopContext())
    assert loop["text"] == "stall watchdog: T3 · cancelled the stalled attempt"
    assert (loop["plan_id"], loop["task_id"]) == ("plan-a", "T3")
    alert = {"item_id": "budget:plan-a:50", "category": "budget_alert", "summary": "x"}
    assert loopevents.event_scope("inbox_item_received", alert) == ("plan-a", None)
    # A guard's notice names no plan at all: it belongs to whichever run is recording.
    guard = {
        "event_type": "learning.guarded_commit",
        "plan_id": "",
        "task_id": "",
        "message": "knowledge: held",
    }
    assert loopevents.unplanned("event_log_entry", guard)
    assert not loopevents.unplanned("event_log_entry", {**guard, "plan_id": "p"})
    assert not loopevents.unplanned("diagnosis", watch) and loopevents.unplanned("loop_health", {})


def test_rows_that_light_no_loop() -> None:
    assert loops_of("inbox_item_received", {"category": "mention", "summary": "x"}) == []
    assert loops_of("event_log_entry", {"event_type": "spec.gate", "message": "allow"}) == []
    assert loops_of("agent_heartbeat", {"elapsed_ms": 5000}) == []
    assert loops_of("something_new", {"x": 1}) == []


def test_live_records() -> None:
    tool = loopevents.live_record(
        live_row("tool_start", {"tool_id": "t1", "tool": "Write", "target": "a.py"})
    )
    assert tool == {
        "kind": "tool",
        "plan_id": "p",
        "task_id": "T1",
        "attempt": 1,
        "ts": None,
        "tool": "Write",
        "target": "a.py",
        "tool_id": "t1",
    }
    text = loopevents.live_record(live_row("text", {"text": "Writing the\x1b[31m tests"}, screened=False))
    assert text is not None and text["text"] == "Writing the tests" and text["screened"] is False
    result = loopevents.live_record(live_row("tool_result", {"tool_id": "t1", "output": "ok"}))
    assert result is not None and result["kind"] == "result" and result["text"] == "ok"
    transcript = {
        "type": "agent_output",
        "content": STREAM + json.dumps({"kind": "text", "payload": {"text": "done"}}),
    }
    assert loopevents.live_record(transcript) is None
    assert loopevents.heartbeat({"plan_id": "p", "task_id": "T1", "elapsed_ms": 5000})["kind"] == "beat"


# -- the card ------------------------------------------------------------------------------------


def test_fold_attaches_routes_steps_words_holds_effects_and_lessons() -> None:
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1"}
    rows: list[tuple[str, dict[str, Any]]] = [
        ("task_started", {**base, "title": "t"}),
        (
            "route_decided",
            {
                **base,
                "attempt": 1,
                "model": "m",
                "source": "ladder",
                "candidates": [{"model": "m", "p": 0.6}],
            },
        ),
        ("agent_spawned", {**base, "attempt": 1, "model": "m"}),
        *[
            (
                "agent_output",
                live_row("tool_start", {"tool_id": f"t{i}", "tool": "Read", "target": f"f{i}.py"}),
            )
            for i in range(10)
        ],
        (
            "agent_output",
            live_row("tool_start", {"tool_id": "t9", "tool": "Read", "target": "f9.py"}),
        ),  # a repeat
        ("agent_output", live_row("text", {"text": "first "})),
        ("agent_output", live_row("text", {"text": "second"})),
        (
            "confirm_waiting",
            {
                **base,
                "attempt": 1,
                "attempt_key": "k",
                "rung": "rung[x]",
                "question": "OK?",
                "timeout_secs": 60,
                "deadline_at": "d",
            },
        ),
        ("effect_staged", {**base, "effect_id": "e1", "tool": "mail.send", "server": "mail"}),
        ("effect_decided", {**base, "effect_id": "e1", "outcome": "rejected"}),
        ("knowledge_written", {**base, "admission": "light_admitted", "lesson": "l"}),
        (
            "gate_thresholds_updated",
            {"snapshot_json": json.dumps({"rungs": {"2": {"ema_pass_rate": 0.5, "total_observations": 3}}})},
        ),
    ]
    for cursor, (kind, event) in enumerate(rows, start=1):
        fold.feed(cursor, kind, event)
    task = fold.tasks[("p", "T1")]
    assert task.live_text == "first second" and task.note is None  # words as it works are not its transcript
    assert task.step == "waiting" and task.hold and task.hold["state"] == "waiting"
    card = rundata._task_card(task)
    assert [step["target"] for step in card["steps"]] == [f"f{i}.py" for i in range(2, 10)]
    assert card["attempt_log"][0]["route"]["model"] == "m" and card["attempt_log"][0]["route"]["p"] == 0.6
    assert card["effects"][0]["outcome"] == "rejected" and card["lessons"][0]["lesson"] == "l"
    assert fold.thresholds[0]["name"] == "test"
    fold.feed(
        99,
        "confirm_resolved",
        {**base, "attempt": 1, "attempt_key": "k", "rung": "rung[x]", "outcome": "approved"},
    )
    fold.feed(100, "agent_completed", {**base, "attempt": 1})
    assert task.hold["outcome"] == "approved" and task.live_text is None
    assert [loop["kind"] for loop in fold.loops] == [
        "route",
        "hold",
        "tool_held",
        "tool_decided",
        "knowledge",
        "thresholds",
        "hold",
    ]
    lines = [line for line in fold.timeline if line.get("ring")]
    assert {line["group"] for line in lines} == {"loop", "tool"} and any(
        line["type"] == "agent_output" for line in lines
    )


def test_a_failover_route_lands_on_its_attempt() -> None:
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1"}
    fold.feed(1, "route_decided", {**base, "attempt": 1, "model": "a", "source": "ladder"})
    fold.feed(2, "agent_spawned", {**base, "attempt": 1, "model": "a"})
    fold.feed(3, "route_decided", {**base, "attempt": 1, "model": "b", "source": "failover"})
    fold.feed(4, "agent_spawned", {**base, "attempt": 1, "model": "b"})
    [entry] = fold.tasks[("p", "T1")].attempt_log
    assert entry["route"]["source"] == "failover" and entry["model"] == "b"


def test_replay_writes_roko_shapes_and_the_tour() -> None:
    from replay_roko import FIXTURES, PLAN_RUN, synthesize

    raw = [dict(row["event"]) for row in FIXTURES[PLAN_RUN]["events"]]
    rows = synthesize(PLAN_RUN, raw, tour=True)
    routes = [row for row in rows if row["type"] == "route_decided"]
    assert routes and all(row.get("synthetic") is True for row in routes)
    for row in routes:  # the pick first, then by score, as roko lists them
        assert row["candidates"][0]["model"] == row["model"]
        scores = [candidate["score"] for candidate in row["candidates"][1:]]
        assert scores == sorted(scores, reverse=True)
    [failover] = [row for row in routes if row["source"] == "failover"]
    assert failover["stage"] == "failover"
    assert failover["reason"] == "gpt-5.4-mini on openai passed over (rate_limited): 429 Too Many Requests"
    fold = rundata.EventFold()
    for index, row in enumerate(rows):
        fold.feed(index + 1, row["type"], row)
    kinds = {loop["kind"] for loop in fold.loops}
    tour = {"tool_held", "tool_decided", "regression", "budget", "diagnosis", "guarded_commit"}
    assert {"route", "failover", "knowledge", "thresholds", "loop_health"} | tour <= kinds
    plain = synthesize(PLAN_RUN, [dict(row["event"]) for row in FIXTURES[PLAN_RUN]["events"]])
    assert not {row["type"] for row in plain} & {"effect_staged", "inbox_item_received"}


# -- the relay, against the replay roko ---------------------------------------------------------------


@pytest.fixture
def replay(tmp_path: Path) -> Iterator[Any]:
    from replay_roko import build

    server = build(150.0, tmp_path / "ws").start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def rrt(replay: Any, tmp_path: Path) -> Iterator[Runtime]:
    runtime = Runtime(FakeContext({"url": replay.url, "workdir": str(tmp_path / "ws")}))
    try:
        yield runtime
    finally:
        runtime.close()


@pytest.fixture
def broadcasts(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, dict[str, Any]]]:
    calls: list[tuple[str, dict[str, Any]]] = []
    monkeypatch.setattr(live_relay, "broadcast", lambda event, payload: calls.append((event, payload)))
    return calls


def collect(
    relay: live_relay.LiveRelay,
    until: Callable[[list[dict[str, Any]]], bool],
    *,
    timeout: float = 20.0,
    runs: tuple[str, ...] = (),
) -> list[dict[str, Any]]:
    async def run() -> list[dict[str, Any]]:
        sub = relay.subscribe(asyncio.get_running_loop(), runs)
        frames: list[dict[str, Any]] = []
        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline and not until(frames):
                frame = await sub.get(0.2)
                if frame is not None:
                    frames.append(frame)
        finally:
            relay.unsubscribe(sub)
        return frames

    return asyncio.run(run())


def ended(run_id: str) -> Callable[[list[dict[str, Any]]], bool]:
    return lambda frames: any(
        frame["type"] == "run"
        and frame["run"]["run_id"] == run_id
        and frame["run"]["state"] in ("succeeded", "failed")
        for frame in frames
    )


def test_relay_streams_a_run_live(rrt: Runtime, replay: Any, broadcasts: list[Any]) -> None:
    started = ui_api.start_run(rrt, {"prompt": "add a --json flag", "max_usd": 0.5, "title": "JSON"})
    run_id = started["run_id"]
    assert broadcasts[0][0] == "run.started" and broadcasts[0][1]["run_id"] == run_id
    frames = collect(rrt.live, ended(run_id))
    kinds = {frame["type"] for frame in frames}
    assert {"run", "live", "loop"} <= kinds
    tools = [frame for frame in frames if frame["type"] == "live" and frame["kind"] == "tool"]
    assert (
        tools and tools[0]["run_id"] == run_id and tools[0]["tool"] == "Read" and tools[0]["task_id"] == "T1"
    )
    loops = {frame["kind"] for frame in frames if frame["type"] == "loop"}
    assert {"route", "knowledge"} <= loops
    last = [frame["run"] for frame in frames if frame["type"] == "run"][-1]
    assert last["state"] == "succeeded" and any(loop["kind"] == "route" for loop in last["loops"])
    # A loop event on the card and on the socket share their key, so pages can merge them.
    socket_keys = {frame["key"] for frame in frames if frame["type"] == "loop"}
    assert socket_keys & {loop["key"] for loop in last["loops"]}
    assert ("run.ended", run_id) in [(event, payload.get("run_id")) for event, payload in broadcasts]


def test_relay_debounces_cards_and_sends_new_lines(rrt: Runtime, replay: Any, broadcasts: list[Any]) -> None:
    from replay_roko import FIXTURES

    plan = FIXTURES["multiwave_plan_run"]["plan_tasks"]["plan_id"]
    started = ui_api.start_plan(rrt, plan, {"max_usd": 1})
    run_id = started["run_id"]
    began = time.monotonic()
    frames = collect(rrt.live, ended(run_id), timeout=30)
    took = time.monotonic() - began
    cards = [frame for frame in frames if frame["type"] == "run" and frame["run"]["run_id"] == run_id]
    assert cards and len(cards) <= took / live_relay.REFRESH_GAP_S + 3
    lines = [line for frame in frames if frame["type"] == "lines" for line in frame["lines"]]
    cursors = [line["cursor"] for line in lines]
    assert lines and cursors == sorted(set(cursors))
    waves = [frame for frame in frames if frame["type"] == "loop" and frame["kind"] == "wave"]
    assert any("in parallel" in frame["text"] for frame in waves)


def test_relay_resumes_after_a_dropped_hub_and_refreshes_after_a_gap(
    rrt: Runtime, replay: Any, broadcasts: list[Any]
) -> None:
    replay.hub_drop_after = 3
    rebuilt: list[float] = []
    refresh_all = rrt.live._refresh_all

    def counting() -> None:
        rebuilt.append(time.monotonic())
        refresh_all()

    rrt.live._refresh_all = counting  # type: ignore[method-assign]
    started = ui_api.start_run(rrt, {"prompt": "add a --json flag", "max_usd": 0.5})
    done = ended(started["run_id"])
    frames = collect(rrt.live, lambda frames: done(frames) and len(replay.hub_connects) >= 2)
    assert done(frames)
    assert len(replay.hub_connects) >= 2 and replay.hub_connects[0] is None
    assert replay.hub_connects[1] is not None and int(replay.hub_connects[1]) >= 3  # resumed, not replayed
    # After the reconnect every followed card is rebuilt, whatever the hub missed meanwhile.
    deadline = time.monotonic() + 3
    while len(rebuilt) < len(replay.hub_connects) - 1 and time.monotonic() < deadline:
        time.sleep(0.05)
    assert len(rebuilt) == len(replay.hub_connects) - 1
    # A gap tells the relay it missed events: every followed run's card is rebuilt from its index.
    tracked = rrt.live._tracked[started["run_id"]]
    tracked.dirty_since = None
    rrt.live.on_sse("gap", '{"missed_events": 300}', None)
    assert tracked.dirty_since is not None


def test_relay_stops_when_nothing_needs_it(rrt: Runtime, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(live_relay, "IDLE_STOP_S", 0.3)
    frames = collect(rrt.live, lambda frames: bool(frames), timeout=0.5)
    assert rrt.live.running or frames == []
    deadline = time.monotonic() + 10
    while rrt.live.running and time.monotonic() < deadline:
        time.sleep(0.1)
    assert not rrt.live.running and rrt.live.hub_state == "stopped"


def test_relay_tells_the_desktop_when_a_sign_off_waits(
    rrt: Runtime, replay: Any, broadcasts: list[Any]
) -> None:
    started = ui_api.start_run(rrt, {"prompt": "write the report", "max_usd": 0.5})
    run_id = started["run_id"]
    frames = collect(
        rrt.live,
        lambda frames: any(frame["type"] == "loop" and frame["kind"] == "hold" for frame in frames),
        timeout=20,
    )
    [hold] = [frame for frame in frames if frame["type"] == "loop" and frame["kind"] == "hold"][:1]
    assert hold["ring"] == "L2" and hold["data"]["timeout_secs"] == 1800 and hold["data"]["deadline_at"]
    # The desktop hears of it once, from the card, with the code `/roko approve` takes.
    frames += collect(
        rrt.live,
        lambda _: any(event == "waiting" for event, _payload in broadcasts),
        timeout=10,
    )
    waiting = [payload for event, payload in broadcasts if event == "waiting"]
    assert len(waiting) == 1 and waiting[0]["run_id"] == run_id and waiting[0]["kind"] == "confirm"
    assert waiting[0]["code"] and waiting[0]["question"] and waiting[0]["task_id"] == "T1"


def test_relay_maps_unplanned_events_to_the_one_active_run(rrt: Runtime, replay: Any) -> None:
    relay = rrt.live
    with relay._lock:
        tracked = relay._follow("r-1", kind="run")
        tracked.state = "running"
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    relay.handle_event({"type": "loop_health", "loop_id": "L-route", "state": "healthy", "h": 0.1, "ts": "t"})
    assert seen and seen[0]["run_id"] == "r-1" and seen[0]["ring"] == "L4"
    relay.handle_event({"type": "task_started", "plan_id": "unknown-plan", "task_id": "T1"})
    assert len(seen) == 1  # a plan Hermes did not start is not Hermes' business
    guard = {
        "type": "event_log_entry",
        "event_type": "learning.guarded_commit",
        "plan_id": "",
        "message": "m",
    }
    relay.handle_event(guard)
    assert seen[-1]["run_id"] == "r-1" and seen[-1]["kind"] == "guarded_commit"
    watch = {
        "type": "diagnosis",
        "summary": {"id": "stall-watchdog:k:silent", "subject": "r-1/T1", "detail": "d"},
    }
    relay.handle_event(watch)
    assert seen[-1]["run_id"] == "r-1" and seen[-1]["kind"] == "diagnosis" and seen[-1]["task_id"] == "T1"


def test_relay_learns_a_followed_runs_plans_from_its_rows(rrt: Runtime) -> None:
    # A page follows a run Hermes did not start (`?runs=`): roko's card names no plan while it runs.
    relay = rrt.live
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    with relay._lock:
        tracked = relay._follow("r-9")
        tracked.state, tracked.dirty_since = "running", None
    assert not tracked.learned
    relay.handle_event({"type": "task_started", "plan_id": "smoke-code", "task_id": "T1"})
    assert seen == [] and tracked.dirty_since is not None  # an unknown plan: rebuild unlearned cards
    tracker = rrt.cards.tracker(rrt.settings().url, "r-9")
    with tracker.lock:
        tracker.fold.feed(1, "task_started", {"plan_id": "smoke-code", "task_id": "T1", "ts_millis": 1})
    with relay._lock:
        relay._seed(tracked, {"plan_ids": [], "tasks": []})
    assert tracked.learned and relay._plan_map["smoke-code"] == "r-9"
    relay.handle_event(
        {"type": "route_decided", "plan_id": "smoke-code", "task_id": "T1", "attempt": 1, "model": "m"}
    )
    assert [frame["kind"] for frame in seen] == ["route"] and seen[0]["run_id"] == "r-9"


def test_relay_keeps_replayed_history_off_the_socket(rrt: Runtime, replay: Any) -> None:
    relay = rrt.live
    with relay._lock:
        tracked = relay._follow("r-1", kind="run")
        tracked.state = "running"
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    old = tracked.since_ms - live_relay.BACKFILL_GRACE_MS - 60_000
    base = {"plan_id": "r-1", "task_id": "T1"}
    relay.handle_event({"type": "agent_spawned", **base, "attempt": 1, "model": "a", "ts_millis": old})
    relay.handle_event({"type": "loop_health", "loop_id": "L-route", "state": "healthy", "ts_millis": old})
    assert seen == []  # roko replays its ring to a new connection: the cards already show that
    # ...but the history still numbers what follows: the next spawn is attempt 2.
    relay.handle_event({"type": "agent_spawned", **base, "attempt": 2, "model": "a"})
    assert [frame["text"] for frame in seen] == ["T1 attempt 2 on a"]


def test_relay_sends_loop_events_the_hub_missed_once(rrt: Runtime) -> None:
    tracked = live_relay.Tracked("r-1")
    now = tracked.since_ms
    card = {
        "loops": [
            {"kind": "wave", "key": "wave:0", "ts": now - 600_000},  # before the relay followed the run
            {"kind": "wave", "key": "wave:1", "ts": now + 50},
            {"kind": "route", "key": "route:p:T2:1:a:learned", "ts": now + 80},
        ]
    }
    assert tracked.mark_sent("route:p:T2:1:a:learned")  # the hub already delivered this one
    missed = rrt.live._missed_loops(tracked, card)
    assert [loop["key"] for loop in missed] == ["wave:1"]
    assert rrt.live._missed_loops(tracked, card) == []


def test_relay_sends_what_an_agent_says_as_a_running_tail(rrt: Runtime) -> None:
    # roko streams an agent's words a token at a time: each words frame also carries the tail of what
    # the task's agent said in this stretch, so a page shows words, not the newest token.
    relay = rrt.live
    with relay._lock:
        relay._follow("r-1", kind="plan", plan_id="p").state = "running"
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    for token in ("Reading", " the", " parser", " first."):
        relay.handle_event(live_row("reasoning", {"text": token}))
    assert [frame["said"] for frame in seen] == [
        "Reading",
        "Reading the",
        "Reading the parser",
        "Reading the parser first.",
    ]
    assert seen[-1]["text"] == " first." and seen[-1]["kind"] == "reasoning"
    # The answer starts a new stretch, and so do the words after a tool call and a new attempt.
    relay.handle_event(live_row("text", {"text": "Done."}))
    relay.handle_event(live_row("text", {"text": "Other"}, task="T2"))
    relay.handle_event(live_row("tool_start", {"tool_id": "t1", "tool": "Read", "target": "a.rs"}))
    relay.handle_event(live_row("text", {"text": "Now"}))
    relay.handle_event(live_row("text", {"text": "Again"}, attempt=2))
    assert [frame.get("said") for frame in seen[4:]] == ["Done.", "Other", None, "Now", "Again"]
    relay.handle_event(live_row("text", {"text": "x" * 300}, attempt=2))
    relay.handle_event(live_row("text", {"text": "y" * 300}, attempt=2))
    assert seen[-1]["said"] == ("Again" + "x" * 300 + "y" * 300)[-loopevents.LIVE_TEXT_CHARS :]


def test_relay_holds_live_frames_over_the_rate_without_losing_words(rrt: Runtime) -> None:
    relay = rrt.live
    with relay._lock:
        tracked = relay._follow("r-1", kind="plan", plan_id="p")
        tracked.state = "running"
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    tokens = [f" w{index}" for index in range(live_relay.LIVE_PER_S + 15)]
    for token in tokens:
        relay.handle_event(live_row("text", {"text": token}))
    relay.handle_event(live_row("tool_start", {"tool_id": "t2", "tool": "Edit", "target": "b.rs"}, task="T2"))
    assert len(seen) == live_relay.LIVE_PER_S  # the rest wait for the next second
    tracked.live_times.clear()  # ...which has come
    relay._flush_live(tracked)
    late = seen[live_relay.LIVE_PER_S :]
    # The newest frame per task and kind: its words carry every token held back, and T2's step comes too.
    assert [(frame["task_id"], frame["kind"]) for frame in late] == [("T1", "text"), ("T2", "tool")]
    assert late[0]["said"] == "".join(tokens) and late[0]["text"] == tokens[-1]
    assert not tracked.pending_live
    relay.handle_event(live_row("text", {"text": " more"}))
    assert seen[-1]["said"] == "".join(tokens) + " more"


def test_relay_rebuilds_a_card_that_came_back_with_problems(
    rrt: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    # A run that has ended sends no event that would rebuild its card, so one built while roko was busy
    # (rate-limited halfway through the run's index) is rebuilt a little later, a few times at most.
    relay = rrt.live
    with relay._lock:
        tracked = relay._follow("r-1", kind="plan", plan_id="p")
    problems: list[list[str]] = [["per-caller rate limit exceeded"], []]
    base = {"run_id": "r-1", "state": "succeeded", "tasks": [], "loops": [], "timeline": []}
    monkeypatch.setattr(views, "card", lambda rt, run_id: {**base, "problems": problems[0]})
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    relay._refresh(tracked)
    assert tracked.problem_cards == 1 and tracked.retry_at is not None
    with relay._lock:
        assert relay._due(time.monotonic()) == []  # not yet
        assert relay._due(tracked.retry_at + 0.01) == [tracked]
    problems.pop(0)
    relay._refresh(tracked)
    assert tracked.retry_at is None and tracked.problem_cards == 0
    assert [frame["run"]["problems"] for frame in seen if frame["type"] == "run"] == [
        ["per-caller rate limit exceeded"],
        [],
    ]
    problems[0] = ["roko serve did not answer in time"]
    for _ in range(live_relay.PROBLEM_RETRIES + 1):
        relay._refresh(tracked)
    assert tracked.retry_at is None  # it gave up; the next event or page look tries again


# -- the socket ----------------------------------------------------------------------------------------

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

PREFIX = "/api/plugins/roko"


def web(rt: Runtime) -> TestClient:
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix=PREFIX)
    return TestClient(app)


def test_socket_refuses_a_bad_credential(rrt: Runtime, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(ui_api, "ws_authorized", lambda websocket: False)
    with (
        web(rrt) as client,
        pytest.raises(WebSocketDisconnect) as refused,
        client.websocket_connect(PREFIX + "/live"),
    ):
        pass
    assert refused.value.code == 4401


def test_socket_auth_fails_closed_inside_hermes(monkeypatch: pytest.MonkeyPatch) -> None:
    import types

    from hermes_plugin_roko import _hermes

    monkeypatch.setitem(sys.modules, "hermes_cli", types.ModuleType("hermes_cli"))
    monkeypatch.setitem(sys.modules, "hermes_cli.web_server_chat", None)  # Hermes without the check
    assert _hermes.ws_auth_ok(object()) is False
    chat = types.ModuleType("hermes_cli.web_server_chat")
    chat._ws_auth_ok = lambda websocket: websocket == "good"  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "hermes_cli.web_server_chat", chat)
    assert _hermes.ws_auth_ok("good") is True and _hermes.ws_auth_ok("bad") is False
    monkeypatch.delitem(sys.modules, "hermes_cli")
    monkeypatch.delitem(sys.modules, "hermes_cli.web_server_chat")
    monkeypatch.setattr(sys, "path", [entry for entry in sys.path if "hermes-agent" not in entry])
    assert _hermes.ws_auth_ok(object()) is None  # not inside Hermes: a bare app, as in these tests


def test_socket_says_hello_then_streams_a_run(rrt: Runtime, replay: Any, broadcasts: list[Any]) -> None:
    with web(rrt) as client, client.websocket_connect(PREFIX + "/live") as socket:
        hello = socket.receive_json()
        assert hello["type"] == "hello" and hello["version"] and hello["overview"]["connection"]["reachable"]
        started = client.post(PREFIX + "/runs", json={"prompt": "add a --json flag", "max_usd": 0.5}).json()
        seen: set[str] = set()
        state = None
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and state != "succeeded":
            frame = socket.receive_json()
            seen.add(frame["type"])
            if frame["type"] == "run" and frame["run"]["run_id"] == started["run_id"]:
                state = frame["run"]["state"]
        assert state == "succeeded" and {"run", "lines", "live", "loop"} <= seen


@pytest.fixture
def live_replay() -> Iterator[Any]:
    from replay_roko import build

    server = build(150.0, None, recording="live").start()
    try:
        yield server
    finally:
        server.stop()


def test_socket_streams_a_run_recorded_from_a_live_roko(
    live_replay: Any, tmp_path: Path, broadcasts: list[Any]
) -> None:
    # tests/fixtures/live_runs.json: a five-task plan run recorded from a live roko with real models,
    # replayed as it happened. Nothing in it is made up: the router's picks, the agents' words (roko's
    # token rows, each attempt's joined into rows of at most 250 ms) and what the knowledge store kept
    # are roko's own rows, and the socket carries them.
    from replay_roko import LIVE

    assert not any(row["event"].get("synthetic") for row in LIVE["live_plan_run"]["events"])
    rt = Runtime(FakeContext({"url": live_replay.url, "workdir": str(tmp_path / "ws")}))
    frames: list[dict[str, Any]] = []
    try:
        with web(rt) as client, client.websocket_connect(PREFIX + "/live") as socket:
            assert socket.receive_json()["type"] == "hello"
            started = client.post(PREFIX + "/plans/tally-budgets-2/run", json={"max_usd": 1.5}).json()
            run_id = started["run_id"]
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline and not ended(run_id)(frames):
                frames.append(socket.receive_json())
    finally:
        rt.close()
    loops = [frame for frame in frames if frame["type"] == "loop" and frame["run_id"] == run_id]
    routes = [frame["text"] for frame in loops if frame["kind"] == "route"]
    assert len(routes) == 5 and all("→ glm-5.1 (ladder; p 1.00" in text for text in routes)
    lessons = [frame for frame in loops if frame["kind"] == "knowledge"]
    assert len(lessons) == 5 and any("reinforced" in frame["text"] for frame in lessons)
    assert {"route", "wave", "knowledge", "thresholds", "loop_health"} <= {frame["kind"] for frame in loops}
    words = [frame for frame in frames if frame["type"] == "live" and frame["kind"] in ("text", "reasoning")]
    assert words and max(len(frame["said"]) for frame in words) > 100  # words, not a token each
    # A frame's `said` joins the rows of its stretch, not only its own.
    assert any(len(frame["said"]) > len(frame["text"]) for frame in words)
    card = [frame["run"] for frame in frames if frame["type"] == "run" and frame["run"]["run_id"] == run_id][
        -1
    ]
    assert card["state"] == "succeeded" and card["progress"]["passed"] == 5


def test_a_recorded_sign_off_waits_twice_as_it_did(live_replay: Any) -> None:
    # The recorded docs run: the person rejected the first REPORT.md with a note, roko retried, and
    # the person approved the second. Each wait lists what that attempt wrote, with roko's deadline.
    from replay_roko import LIVE

    run = live_replay.replay("live_signoff_run")
    holds = [row["event"] for row in LIVE["live_signoff_run"]["events"] if row["type"] == "confirm_waiting"]
    seen: dict[str, dict[str, Any]] = {}
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline and run.current() == "running":
        held = run.open_hold()
        if held:
            seen.setdefault(held["attempt_key"].rsplit(":", 1)[1], held)
        time.sleep(0.02)
    assert sorted(seen) == ["1", "2"] and len(holds) == 2
    assert seen["2"]["summary"].startswith("REPORT.md:\n**") and "# tally report" in seen["1"]["summary"]
    assert all(held["deadline_at"] > held["held_at"] for held in seen.values())
    resolved = [
        row["event"] for row in LIVE["live_signoff_run"]["events"] if row["type"] == "confirm_resolved"
    ]
    assert [(row["outcome"], bool(row.get("note"))) for row in resolved] == [
        ("rejected", True),
        ("approved", False),
    ]


# -- /loops --------------------------------------------------------------------------------------------


def loop_world(fake: FakeRoko) -> None:
    fake.loops = [{"loop_id": "L-route", "lifecycle": "active", "state": "healthy", "h": 0.1, "eps": 0.04}]
    fake.route_rows = [
        {
            "ts": "2026-10-14T10:00:00Z",
            "record": {
                "task_id": "T1",
                "selected_model": "glm-5.1",
                "selected_provider": "zai",
                "routing_stage": "ladder",
                "source": "ladder",
                "chosen_propensity": 0.55,
                "candidates": [{"model": "glm-5.1", "score": 0.8, "eligible": True}],
                "outcome_success": True,
            },
        }
    ]
    fake.adaptive = [
        {
            "rung": "verify[0:test]",
            "ema_pass_rate": 0.92,
            "total_observations": 30,
            "suggested_max_retries": 1,
        }
    ]
    fake.diagnoses = [
        {"id": "conductor:k:restart", "ts": "2026-10-14T10:01:00Z", "severity": "warn", "subject": "T3"}
    ]
    fake.playbooks = 4
    fake.incidents = [{"id": "i1"}]
    fake.knowledge = [{"id": "k1", "content": "use python3", "kind": "insight", "tier": "working"}]
    fake.scorecard = [{"model_slug": "glm-5.1", "task_count": 9, "success_rate": 0.9}]
    fake.effects = [{"effect_id": "e1", "run_id": "r", "tool": "mail.send", "server": "mail"}]


def test_loops_route_reads_every_ring(rt: Runtime, fake: FakeRoko) -> None:
    loop_world(fake)
    with web(rt) as client:
        body = client.get(PREFIX + "/loops").json()
    assert body["ok"] is True and body["problems"] == []
    rings = {ring["ring"]: ring for ring in body["rings"]}
    assert list(rings) == ["L0", "L1", "L2", "L3", "L4"] and rings["L1"]["name"] == "attempts"
    assert rings["L0"]["counts"] == {"held": 1, "withheld": 1}
    assert rings["L1"]["routes"][0]["model"] == "glm-5.1" and rings["L1"]["routes"][0]["p"] == 0.55
    assert rings["L1"]["retry_budgets"][0]["suggested_max_retries"] == 1
    assert rings["L2"]["diagnoses"][0]["source"] == "conductor"
    assert rings["L3"]["knowledge"]["total"] == 1 and rings["L3"]["playbooks"] == {"total": 4}
    assert rings["L3"]["models"][0]["model"] == "glm-5.1"
    assert rings["L4"]["loops"][0]["state"] == "healthy"
    assert body["live"]["running"] is False


def test_loops_route_answers_when_every_part_fails(rt: Runtime, fake: FakeRoko) -> None:
    fake.learn_broken = True
    with web(rt) as client:
        body = client.get(PREFIX + "/loops").json()
    assert body["ok"] is True and len(body["rings"]) == 5 and len(body["problems"]) >= 7
    assert all(isinstance(ring["recent"], list) for ring in body["rings"])


def test_loops_view_shows_recent_events_from_cards(rt: Runtime, fake: FakeRoko, approvals: Approvals) -> None:
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "x", "max_usd": 1})["run_id"]
    tracker = rt.cards.tracker(rt.settings().url, run_id)
    stamp = int(time.time() * 1000)
    with tracker.lock:
        tracker.fold.feed(
            1,
            "knowledge_written",
            {
                "plan_id": run_id,
                "task_id": "T1",
                "admission": "light_admitted",
                "lesson": "l",
                "ts_millis": stamp,
            },
        )
    rings = {ring["ring"]: ring for ring in views.loops_view(rt)["rings"]}
    assert rings["L3"]["state"] == "active" and rings["L3"]["recent"][0]["kind"] == "knowledge"
    assert rings["L4"]["state"] == "quiet"


def test_a_tool_call_roko_publishes_twice_is_one_step(rrt: Runtime) -> None:
    # In trusted mode roko publishes each call twice (roko-final7): its tool-steps record, with the
    # target, and the trusted record, with the arguments. The page sees one step.
    relay = rrt.live
    with relay._lock:
        relay._follow("r-1", kind="plan", plan_id="p").state = "running"
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    relay.handle_event(
        live_row("tool_start", {"tool_id": "c1", "tool": "bash", "target": "python3 -m unittest"})
    )
    relay.handle_event(
        live_row("tool_start", {"tool_id": "c1", "tool": "bash", "args": "{}"}, screened=False)
    )
    # The other order: a record without a target, then the one that names it.
    relay.handle_event(live_row("tool_start", {"tool_id": "c2", "tool": "read_file"}, screened=False))
    relay.handle_event(
        live_row("tool_start", {"tool_id": "c2", "tool": "read_file", "target": "tally/cli.py"})
    )
    relay.handle_event(live_row("tool_start", {"tool_id": "c2", "tool": "read_file"}, screened=False))
    tools = [(frame["tool_id"], frame.get("target")) for frame in seen if frame.get("kind") == "tool"]
    assert tools == [("c1", "python3 -m unittest"), ("c2", None), ("c2", "tally/cli.py")]


def test_the_card_keeps_one_step_per_call_and_takes_a_later_target() -> None:
    fold = rundata.EventFold()
    for row in (
        live_row("tool_start", {"tool_id": "c1", "tool": "edit_file"}, screened=False),
        live_row("tool_start", {"tool_id": "c1", "tool": "edit_file", "target": "tests/test_cli.py"}),
        live_row("tool_start", {"tool_id": "c2", "tool": "bash", "target": "python3 -m unittest"}),
        live_row("tool_start", {"tool_id": "c2", "tool": "bash"}, screened=False),
    ):
        fold.feed(1, "agent_output", row)
    [task] = fold.tasks.values()
    assert [(step["tool"], step["target"]) for step in task.steps] == [
        ("edit_file", "tests/test_cli.py"),
        ("bash", "python3 -m unittest"),
    ]

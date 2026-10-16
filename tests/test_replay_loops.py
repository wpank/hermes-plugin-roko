"""The replay roko's learning and control routes: roko's state after what its replays revealed.

They let `/loops` and the pages' Loops views be built and shown against the replay (tests/replay_roko.py),
so every ring has something to draw: the router's decisions and the retry budgets (L1), the diagnoses
(L2), the scorecard, thresholds, knowledge and playbooks (L3), the loop registry (L4), and a tour's held
call (L0) while it is held.
"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import replay_roko
from conftest import Approvals, FakeContext
from replay_roko import FIXTURES, PLAN_RUN, ManualClock, ReplayRoko, build

from hermes_plugin_roko import ui_api, views
from hermes_plugin_roko.runtime import Runtime

fastapi = pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402

PREFIX = "/api/plugins/roko"
SPAN_S = 433.212  # the five-task plan's recording, first row to last


@pytest.fixture
def replay(tmp_path: Path) -> Iterator[ReplayRoko]:
    server = build(400.0, tmp_path / "ws", tour=True).start()
    try:
        yield server
    finally:
        server.stop()


@pytest.fixture
def rrt(replay: ReplayRoko, tmp_path: Path) -> Iterator[Runtime]:
    runtime = Runtime(FakeContext({"url": replay.url, "workdir": str(tmp_path / "ws")}))
    try:
        yield runtime
    finally:
        runtime.close()


def get(server: ReplayRoko, path: str) -> Any:
    with urllib.request.urlopen(server.url + path, timeout=10) as answer:
        return json.loads(answer.read())


def settle(server: ReplayRoko, seconds: float = 8.0) -> None:
    """Wait until every replay has ended."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if all(run.current() != "running" for run in server.runs.values()):
            return
        time.sleep(0.05)
    raise AssertionError("the replays did not end")


def test_loops_through_the_plugin_has_every_ring_filled(
    replay: ReplayRoko, rrt: Runtime, approvals: Approvals
) -> None:
    ui_api.start_plan(rrt, next(iter(replay.plans)), {"max_usd": 1})
    settle(replay)
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rrt), prefix=PREFIX)
    with TestClient(app) as client:
        body = client.get(PREFIX + "/loops").json()
    assert body["ok"] is True and body["problems"] == []
    rings = {ring["ring"]: ring for ring in body["rings"]}
    assert rings["L0"]["counts"] == {"held": 0, "withheld": 0}  # the tour's call was decided
    routes = rings["L1"]["routes"]
    assert len(routes) == 10 and all(route["candidates"] for route in routes)
    assert {route["outcome"] for route in routes} <= {True, False, None} and routes[0]["outcome"] is True
    budgets = {budget["rung"]: budget for budget in rings["L1"]["retry_budgets"]}
    assert set(budgets) == {"0", "2"}  # compile and test; the sign-off is standalone
    assert budgets["0"]["suggested_max_retries"] == 3 and budgets["2"]["suggested_max_retries"] == 1
    sources = {diagnosis["source"] for diagnosis in rings["L2"]["diagnoses"]}
    assert {"ladder_exhausted", "stall-watchdog"} <= sources
    assert rings["L3"]["models"][0]["model"] == "glm-5.1" and rings["L3"]["thresholds"]
    assert rings["L3"]["knowledge"]["total"] >= 8 and len(rings["L3"]["knowledge"]["recent"]) == 5
    assert rings["L3"]["playbooks"] == {"total": 2}
    loops = {row["loop_id"]: row for row in rings["L4"]["loops"]}
    assert len(loops) == 14 and loops["L-route"]["state"] == "live" and loops["L-know"]["state"] == "live"
    assert (
        loops["L-linucb"]["reason"] == "dormant:mask" and loops["L-gate-thr"]["lifecycle"] == "observe_only"
    )


def test_the_registry_moves_as_a_replay_ends(tmp_path: Path) -> None:
    # The replays' clock stands still until the test moves it. At 400x the live replay's recording lasts
    # a second of wall time, which a busy machine can spend in build()'s git work alone.
    clock = ManualClock()
    server = build(400.0, tmp_path / "ws", clock=clock)  # not started: the clock is read directly
    [live] = [run for run in server.runs.values() if run.current() == "running"]
    assert live.clock_s() == 40.0  # where build() starts it
    before = {row["loop_id"]: row for row in server.learn_loops()}
    # The recordings that ended: 16 settled route decisions, 9 of them passed (56%).
    assert before["L-route"]["state"] == "probation" and before["L-route"]["n_opp"] == 16
    assert before["L-route"]["beta"] == pytest.approx(9 / 16 - 0.55, abs=1e-4)
    clock.advance(live.span_s / live.speed)  # and let it end
    assert live.current() == "succeeded"
    after = {row["loop_id"]: row for row in server.learn_loops()}
    assert after["L-route"]["n_opp"] > before["L-route"]["n_opp"] and after["L-route"]["state"] == "live"
    assert after["L-route"]["h"] == 0.05 and before["L-route"]["h"] == 0.2
    assert after["L-gate-thr"]["n_opp"] > before["L-gate-thr"]["n_opp"]


def test_a_replay_starts_its_recording_once_it_is_set_up(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    clock = ManualClock()
    deliver = replay_roko._deliver

    def slow_git(workdir: Path, run_id: str, fixture: str) -> str:
        clock.advance(5.0)  # a busy machine making the replay's batch branch
        return deliver(workdir, run_id, fixture)

    monkeypatch.setattr(replay_roko, "_deliver", slow_git)
    server = build(400.0, tmp_path / "ws", clock=clock)
    [live] = [run for run in server.runs.values() if run.current() == "running"]
    assert live.clock_s() == 40.0


def test_a_held_replay_stays_where_it_was_held() -> None:
    clock = ManualClock(tick=0.01)  # every reading 10 ms after the one before
    server = build(400.0, None, clock=clock)
    [live] = [run for run in server.runs.values() if run.current() == "running"]
    live.paused_at = live.started  # held from its start, 40 s into its recording
    assert [live.clock_s() for _ in range(3)] == [40.0, 40.0, 40.0]


def test_route_decisions_in_roko_shape(replay: ReplayRoko) -> None:
    settle(replay)
    rows = get(replay, "/api/learn/loops/L-route/decisions?limit=500")
    assert [row["ts"] for row in rows] == sorted((row["ts"] for row in rows), reverse=True)
    assert all(row["schema_version"] == "roko.decision/1" and row["loop_id"] == "L-route" for row in rows)
    assert all(row["synthetic"] is True and row["source"] != "failover" for row in rows)
    # The failed run: six attempts at T1, each followed by another until the ladder ran out.
    failed = FIXTURES["failed_run"]["run_id"]
    t1 = sorted(
        (row for row in rows if row["attempt_key"].startswith(failed) and row["task_id"] == "T1"),
        key=lambda row: row["seq"],
    )
    assert [row["outcome_success"] for row in t1] == [False] * 6
    # T3's first pick was the router's; its provider refused and the attempt ran on the failover model.
    t3 = [row for row in rows if row["task_id"] == "T3" and row["source"] == "router"]
    assert t3 and t3[0]["selected_model"] == "gpt-5.4-mini" and t3[0]["chosen_propensity"] == 0.62
    assert t3[0]["proposals"]["learned"] == "gpt-5.4-mini" and t3[0]["outcome_success"] is True
    assert all(isinstance(row["outcome_cost_usd"], float) for row in rows if row["outcome_success"])
    assert get(replay, "/api/learn/loops/L-know/decisions") == []
    assert len(get(replay, "/api/learn/loops/L-route/decisions?limit=3")) == 3


def test_thresholds_follow_roko_rules(replay: ReplayRoko) -> None:
    settle(replay)
    adaptive = get(replay, "/api/learn/adaptive-thresholds")
    assert adaptive["tracked_rungs"] == 2 and adaptive["source"].endswith(".roko/learn/gate-thresholds.json")
    compile_rung, test_rung = adaptive["rungs"]
    assert (
        compile_rung["rung"] == 0 and compile_rung["consecutive_passes"] < compile_rung["total_observations"]
    )
    assert test_rung["rung"] == 2 and test_rung["should_skip_rung"] is (test_rung["consecutive_passes"] >= 20)
    thresholds = get(replay, "/api/learn/gate-thresholds")
    assert thresholds["projection_state"] == "fresh" and thresholds["value"]["rungs"] == thresholds["rungs"]
    assert thresholds["rungs"]["2"]["ema_pass_rate"] == test_rung["ema_pass_rate"]
    assert thresholds["rungs"]["0"]["poisoning_defense"]["window"] == 10
    assert get(replay, "/api/learning/adaptive-thresholds") == adaptive  # roko's alias


def test_diagnoses_knowledge_playbooks_and_reflexes(replay: ReplayRoko) -> None:
    settle(replay)
    diagnoses = get(replay, "/api/diagnosis/recent")
    assert diagnoses == sorted(diagnoses, key=lambda row: row["ts"], reverse=True)
    assert len({row["id"] for row in diagnoses}) == len(diagnoses)
    assert any(row["id"].startswith("ladder_exhausted:") and row["severity"] == "alert" for row in diagnoses)
    entries = get(replay, "/api/knowledge/entries?limit=3")
    assert len(entries["items"]) == 3 and entries["has_more"] is True and entries["total"] > 3
    assert all(item["domain"] == "coding" and item["synthetic"] for item in entries["items"])
    books = get(replay, "/api/learn/playbooks")
    assert books["total"] == 2
    assert all(
        book["success_rate"]
        == pytest.approx(book["success_count"] / (book["success_count"] + book["failure_count"]), abs=1e-4)
        for book in books["playbooks"]
    )
    reflexes = get(replay, "/api/learn/reflexes")
    assert reflexes["total_rules"] == 2 and reflexes["max_rules"] == 200
    assert reflexes["top_rules"][0]["action"] == {"tool": "Bash", "args": "python3 -m"}
    assert reflexes["top_rules"][0]["last_fired_at"]


def test_loop_detail_and_unknown_loops(replay: ReplayRoko) -> None:
    settle(replay)
    detail = get(replay, "/api/learn/loops/L-know")
    assert detail["loop"]["state"] == "live" and detail["health"]["kind"] == "loop.health"
    assert detail["transitions"] and detail["transitions"][-1]["to"] == "live"
    assert detail["transitions"][-1]["actor"] == "auditor" and detail["canaries"] == []
    assert len(get(replay, "/api/showcase/m2/loops")) == 14
    with pytest.raises(urllib.error.HTTPError) as missing:
        get(replay, "/api/learn/loops/L-nope")
    assert missing.value.code == 404


def test_a_tour_holds_a_call_for_the_person(tmp_path: Path, approvals: Approvals) -> None:
    server = build(1.0, tmp_path / "ws").start()
    try:
        server.tour = True
        held = server.replay(
            PLAN_RUN, head_start_s=0.31 * SPAN_S
        )  # after the call is held, before it is decided
        runtime = Runtime(FakeContext({"url": server.url, "workdir": str(tmp_path / "ws")}))
        try:
            [item] = [
                entry
                for entry in views.collect_pending(runtime, runtime.client())
                if entry["kind"] == "effect"
            ]
            assert item["run_id"] == held.run_id and item["tool"] == "send" and item["server"] == "mail"
            assert views.loops_view(runtime)["rings"][0]["counts"]["held"] == 1
            answered = ui_api.decide(runtime, {"code": item["code"], "approve": True})
            assert answered["outcome"] == "applied"
            assert views.loops_view(runtime)["rings"][0]["counts"]["held"] == 0
            held.head_start_s = 0.4 * SPAN_S  # the decision's row comes due
            [decided] = [row for row in held.index() or [] if row["type"] == "effect_decided"]
            assert decided["outcome"] == "applied" and decided["effect_id"] == item["decision_id"][2:]
        finally:
            runtime.close()
    finally:
        server.stop()


def test_replay_run_status_waits_like_roko(tmp_path: Path) -> None:
    import time

    from replay_roko import Replay, build

    server = build(400.0, None).start()
    try:
        # The replay build() starts part way into its recording (the others are made ended), whether or not
        # it has ended by now.
        live = next(r for r in server.runs.values() if isinstance(r, Replay) and r.head_start_s < r.span_s)
        started = time.monotonic()
        with server.lock:  # as roko's HTTP handler calls it
            body = server.call_tool("run_status", {"run_id": live.run_id, "wait_secs": 2}, None)
        waited = time.monotonic() - started
        # At 400x the replay changes state or ends quickly; it must not answer before trying.
        assert body["structuredContent"]["run_id"] == live.run_id
        assert waited > 0.05 or live.current() != "running"
    finally:
        server.stop()

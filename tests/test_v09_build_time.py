"""A phase's TIME on the Plans pads is the run page's (design system §4.8): roko's own time for each of its runs.

Round v8's Plans pads read phase 2 as 1:45, phase 4 as 5:48 and phase 6 as 45:39, where roko's records say 1:46,
5:47 and 45:37 (run-analyst-v8): the pads took each run's start and end from the run log, the moments Hermes sent
the run and saw it end, where §4.8 counts each part's `run_completed.duration_ms`, summed for a resumed plan, then
whole seconds rounded down. A run's own time is now roko's, kept in the run log once the plugin read it (the run's
card, the runs list, or once from its events for a run that ended before), and the start and end only when roko
said none.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from conftest import FakeContext
from fake_roko import FakeRoko, Run

from hermes_plugin_roko import buildview, views
from hermes_plugin_roko.runtime import Runtime

PHASES = {
    2: ("p2-the-sources-and-the-ladder", "the sources and the ladder"),
    4: ("p4-the-sequencer", "the sequencer"),
    6: ("p6-the-window", "the window"),
}
# Undertow 2's runs of phases 2, 4 and 6 as the pilot's run log has them (Hermes' start, the end it saw) and as
# roko's events have them (each run's run_completed.duration_ms). Phase 6 ran three times, the last two resuming
# the first.
RUNS: list[dict[str, Any]] = [
    {
        "run_id": "180001cd-0000-4000-8000-000000000002",
        "phase": 2,
        "state": "succeeded",
        "started_at": "2026-11-12T16:32:22Z",
        "finished_at": "2026-11-12T16:34:07.922Z",
        "duration_ms": 106_058,
    },
    {
        "run_id": "42b154c5-0000-4000-8000-000000000004",
        "phase": 4,
        "state": "succeeded",
        "started_at": "2026-11-12T18:01:52Z",
        "finished_at": "2026-11-12T18:07:40.471Z",
        "duration_ms": 347_816,
    },
    {
        "run_id": "23837ede-0000-4000-8000-000000000006",
        "phase": 6,
        "state": "failed",
        "started_at": "2026-11-12T21:01:42Z",
        "finished_at": "2026-11-12T21:13:34.119Z",
        "duration_ms": 711_416,
    },
    {
        "run_id": "a677b2d9-0000-4000-8000-000000000006",
        "phase": 6,
        "state": "failed",
        "started_at": "2026-11-12T21:27:48Z",
        "finished_at": "2026-11-12T21:35:51.299Z",
        "duration_ms": 482_478,
        "resumes": "23837ede-0000-4000-8000-000000000006",
    },
    {
        "run_id": "ede1f9a7-0000-4000-8000-000000000006",
        "phase": 6,
        "state": "unverified",
        "started_at": "2026-11-12T21:47:24Z",
        "finished_at": "2026-11-12T22:13:08.333Z",
        "duration_ms": 1_543_382,
        "resumes": "23837ede-0000-4000-8000-000000000006",
    },
]


def _world(tmp_path: Path) -> tuple[FakeRoko, Runtime]:
    folder = tmp_path / "docs" / "specs"
    folder.mkdir(parents=True)
    fake = FakeRoko().start()
    for n, (plan_id, name) in PHASES.items():
        (folder / f"phase-{n}-{plan_id.split('-', 1)[1]}.md").write_text(
            f"# Phase {n}: {name}\n\n**Goal**: {name}.\n"
        )
        fake.add_plan(plan_id, f"P{n} · {name}", [{"id": "T1"}])
    for run in RUNS:
        plan_id = PHASES[run["phase"]][0]
        fake.runs[run["run_id"]] = Run(
            run_id=run["run_id"],
            kind="plan",
            states=[run["state"]],
            plan_id=plan_id,
            finished_at=run["finished_at"],
            events=[
                {
                    "type": "plan_set_loaded",
                    "run_id": run["run_id"],
                    "plans": [{"plan_id": plan_id, "title": plan_id, "tasks_total": 1}],
                },
                {
                    "type": "run_completed",
                    "run_id": run["run_id"],
                    "outcome": run["state"],
                    "duration_ms": run["duration_ms"],
                },
            ],
        )
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    for run in RUNS:
        n = run["phase"]
        rt.runs.add(run["run_id"], "plan", f"P{n} · {PHASES[n][1]}", plan_id=PHASES[n][0])
        rt.runs.update(
            run["run_id"],
            cost_final=True,
            checked=True,
            spend_checked=True,
            state=run["state"],
            started_at=run["started_at"],
            finished_at=run["finished_at"],
            **({"resumes": run["resumes"]} if "resumes" in run else {}),
        )
    return fake, rt


def _events_reads(fake: FakeRoko) -> int:
    return sum(
        1 for r in fake.requests if r["path"].startswith("/api/runs/") and r["path"].endswith("/events")
    )


def test_the_pads_time_is_rokos_own_time_for_each_run_summed_for_a_resumed_plan(tmp_path: Path) -> None:
    fake, rt = _world(tmp_path)
    try:
        build = buildview.build_view(rt)
        walls = {p["n"]: p["wall_ms"] for p in build["phases"]}
        # 1:46, 5:47 and 45:37 in whole seconds rounded down, where the run log's stamps made 1:45, 5:48 and 45:39.
        assert walls == {2: 106_058, 4: 347_816, 6: 711_416 + 482_478 + 1_543_382}
        assert [ms // 1000 for ms in walls.values()] == [106, 347, 2737]
        # The head's TIME adds the pads.
        assert build["totals"]["wall_ms"] == 106_058 + 347_816 + 2_737_276
        # Read once a run: the run log keeps roko's time, and a later look reads no events for it.
        assert {run["run_id"]: rt.runs.get(run["run_id"])["run_ms"] for run in RUNS} == {
            run["run_id"]: run["duration_ms"] for run in RUNS
        }
        reads = _events_reads(fake)
        assert buildview.build_view(rt)["totals"]["wall_ms"] == 3_191_150
        assert _events_reads(fake) == reads
    finally:
        rt.close()
        fake.stop()


def test_a_runs_card_keeps_rokos_time_in_the_run_log(tmp_path: Path) -> None:
    fake, rt = _world(tmp_path)
    try:
        run_id = RUNS[0]["run_id"]
        assert views.card(rt, run_id)["duration_ms"] == 106_058
        assert rt.runs.get(run_id)["run_ms"] == 106_058
    finally:
        rt.close()
        fake.stop()


def test_a_run_roko_has_no_time_for_still_counts_its_start_to_its_end(tmp_path: Path) -> None:
    fake, rt = _world(tmp_path)
    try:
        # roko's events end without a run_completed (a crash): the run log's start and end, as before.
        run = fake.runs[RUNS[0]["run_id"]]
        assert run.events is not None
        run.events = run.events[:1]
        phase = next(p for p in buildview.build_view(rt)["phases"] if p["n"] == 2)
        assert phase["wall_ms"] == 105_922  # 16:32:22 to 16:34:07.922
        assert "run_ms" not in rt.runs.get(RUNS[0]["run_id"])
    finally:
        rt.close()
        fake.stop()

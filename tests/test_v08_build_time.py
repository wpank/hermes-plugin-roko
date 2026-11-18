"""0.8.0 (round v7, guide-v7's R1r capture): a phase's time is its runs' own time, not the hours between them (P-58).

Phase 5.1's run 814a7340 failed at 17:20 after 12m 49s, sat failed for three and a half hours, and run 4728d22e
resumed it at 20:46 for 4m 33s. roko writes every invocation into the first run's manifest, so once the resume
closed it, the manifest of 814a7340 said it ended at 20:51:29. A plugin process that read it then took that for
814a7340's own end: the Build tab's P5.1 went from 17m 23s to 3h 48m, and TIME from 9h 31m to 13h 02m. A run's
end is now its own (roko's summary of its own events) when its manifest holds later invocations, the build asks
roko again for an end that runs past the start of the run that resumed it, and a run resumed under its own id
counts each invocation's span, not the hours between them.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from conftest import FakeContext
from fake_roko import FakeRoko, Run

from hermes_plugin_roko import buildview, views
from hermes_plugin_roko.runtime import Runtime

PLAN = "p5-1-the-renders-as-they-play"
ROOT = "814a7340-a01c-42ed-a60c-349ab875eb1e"
RESUME = "4728d22e-268c-472f-8a2d-76447195e746"
# 814a7340's manifest after the resume closed it: both invocations, and the resume's end.
GRAPH_MANIFEST = {
    "run_id": ROOT,
    "kind": "plan_run",
    "plan_ids": [PLAN],
    "origin": "mcp:local",
    "invocations": [
        {"inv": 1, "started_at": "2026-10-26T17:08:36.464Z", "resumed": False},
        {"inv": 2, "started_at": "2026-10-26T20:46:57.231Z", "resumed": True},
    ],
    "closed": {"ended_at": "2026-10-26T20:51:29.037Z", "status": "succeeded"},
}
OWN_END = "2026-10-26T17:20:47.733Z"  # 814a7340's own index: run_completed after 12m 49s


def _specs(workdir: Path) -> None:
    folder = workdir / "docs" / "specs"
    folder.mkdir(parents=True)
    (folder / "phase-5-ship.md").write_text("# Phase 5: ship\n\n**Goal**: ship it.\n")
    (folder / "phase-5.1-renders.md").write_text(
        "# Phase 5.1: the renders as they play\n\n**Goal**: renders.\n"
    )


def _logged(rt: Runtime, run_id: str, **fields: Any) -> None:
    rt.runs.add(run_id, "plan", "P5.1 · the renders as they play", plan_id=PLAN)
    rt.runs.update(run_id, cost_final=True, checked=True, **fields)


def _fake() -> FakeRoko:
    fake = FakeRoko().start()
    fake.add_plan(PLAN, "P5.1 · the renders as they play", [{"id": "T1"}, {"id": "T2"}, {"id": "T3"}])
    fake.runs[ROOT] = Run(
        run_id=ROOT,
        kind="plan",
        states=["failed"],
        plan_id=PLAN,
        finished_at=OWN_END,
        manifest=GRAPH_MANIFEST,
    )
    fake.runs[RESUME] = Run(
        run_id=RESUME, kind="plan", states=["succeeded"], plan_id=PLAN, finished_at="2026-10-26T20:51:29.313Z"
    )
    return fake


def test_p58_a_run_resumed_by_another_ends_where_its_own_events_end(tmp_path: Path) -> None:
    fake = _fake()
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        _logged(rt, ROOT, state="failed", started_at="2026-10-26T17:07:58Z")
        card = views.card(rt, ROOT)
        assert card["finished_at"] == OWN_END  # not the manifest's close, the resume's end
        assert rt.runs.get(ROOT)["finished_at"] == OWN_END
    finally:
        rt.close()
        fake.stop()


def test_p58_a_phases_time_leaves_out_the_hours_its_failed_run_sat_before_the_resume(tmp_path: Path) -> None:
    _specs(tmp_path)
    fake = _fake()
    # Their events end without a run_completed (a crash, say), so roko gives no time of its own: the phase's
    # time is each run's start to its own end (since 0.9 roko's time comes first: tests/test_v09_build_time.py).
    for run_id in (ROOT, RESUME):
        fake.runs[run_id].events = [
            {"type": "plan_set_loaded", "run_id": run_id, "plans": [{"plan_id": PLAN}]}
        ]
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        # The run log as the R1r capture had it: 814a7340's end is the resume's.
        _logged(
            rt,
            ROOT,
            state="failed",
            started_at="2026-10-26T17:07:58Z",
            finished_at="2026-10-26T20:51:29.037Z",
        )
        _logged(
            rt,
            RESUME,
            state="succeeded",
            started_at="2026-10-26T20:46:56Z",
            finished_at="2026-10-26T20:51:29.313Z",
            resumes=ROOT,
        )
        phase = next(p for p in buildview.build_view(rt)["phases"] if p["n"] == 5.1)
        own = 12 * 60_000 + 49_733  # 17:07:58 to 17:20:47.733
        resumed = 4 * 60_000 + 33_313  # 20:46:56 to 20:51:29.313
        assert phase["runs"] == 2 and phase["wall_ms"] == own + resumed  # 17m 23s, as R0q had it
        assert rt.runs.get(ROOT)["finished_at"] == OWN_END
        # Asked once: the end it has now is its own.
        fake.runs[ROOT].finished_at = "2026-10-26T23:59:59Z"
        buildview.build_view(rt)
        assert rt.runs.get(ROOT)["finished_at"] == OWN_END
    finally:
        rt.close()
        fake.stop()


def test_p58_a_run_resumed_under_its_own_id_counts_each_invocations_span(tmp_path: Path) -> None:
    """roko's checkpoint resume from a terminal (`roko resume <run>`) keeps the run's id: its events hold both
    invocations, each ending with its own run_completed, three hours apart."""
    _specs(tmp_path)
    fake = FakeRoko().start()
    fake.add_plan(PLAN, "P5.1 · the renders as they play", [{"id": "T1"}])
    started = {"type": "plan_set_loaded", "plans": [{"plan_id": PLAN, "title": PLAN, "tasks_total": 1}]}
    fake.runs[ROOT] = Run(
        run_id=ROOT,
        kind="plan",
        states=["succeeded"],
        plan_id=PLAN,
        finished_at="2026-10-26T20:22:00Z",
        events=[
            {**started, "run_id": ROOT},
            {"type": "run_completed", "run_id": ROOT, "outcome": "failed", "duration_ms": 600_000},
            {**started, "run_id": ROOT},
            {"type": "run_completed", "run_id": ROOT, "outcome": "succeeded", "duration_ms": 120_000},
        ],
    )
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        _logged(rt, ROOT, state="failed", started_at="2026-10-26T17:10:00Z")
        card = views.card(rt, ROOT)
        assert card["duration_ms"] == 720_000 and rt.runs.get(ROOT)["active_ms"] == 720_000
        phase = next(p for p in buildview.build_view(rt)["phases"] if p["n"] == 5.1)
        assert phase["wall_ms"] == 720_000  # not 17:10 to 20:22
    finally:
        rt.close()
        fake.stop()

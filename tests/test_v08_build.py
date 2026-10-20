"""0.8.0 (round v7, #3): the project's build, its phases in order (`GET /build`).

Metakosmia Undertow is six phases, each a spec (`docs/specs/phase-<n>-<slug>.md`), then a plan ("P<n> · …"),
then its runs. The build answers what a viewer asks first: how far along it is, what it cost and took, what runs
now, what comes next, and what the cheap rungs saved across all of it.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from conftest import FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import buildview
from hermes_plugin_roko.runtime import Runtime

SPECS = {
    0: ("foundation", "Phase 0: foundation", "the build system, the core library and a plugin skeleton."),
    1: ("voice", "Phase 1: the voice", "Undertow makes sound."),
    2: ("rumble", "Phase 2: rumble and modulation", "the hypnotic part of the sound."),
    3: ("sequencer", "Phase 3: the hypnotic sequencer", "a 16-step bassline sequencer."),
}


def _specs(workdir: Path) -> None:
    folder = workdir / "docs" / "specs"
    folder.mkdir(parents=True)
    for n, (slug, title, goal) in SPECS.items():
        (folder / f"phase-{n}-{slug}.md").write_text(f"# {title}\n\n**Goal**: {goal}\n\n## Scope\n")
    (folder / "notes.md").write_text("# Not a phase\n")


@pytest.mark.parametrize(
    ("plan_id", "title", "phase"),
    [
        ("p0-undertow-foundation", "P0 · Undertow foundation", (0, "Undertow foundation")),
        ("p2-undertow-rumble", "Title: P2 · Undertow rumble", (2, "Undertow rumble")),
        ("title-p0-undertow-foundation", "", (0, "undertow foundation")),
        ("p1-undertow-voice", None, (1, "undertow voice")),
        ("set-the-plan-title-field-to-exactly-p0-undertow", "Set the plan title field to exactly: P0", None),
        ("add-clamp", "Add clamp", None),
    ],
)
def test_a_plans_phase_comes_from_its_title_or_its_id(
    plan_id: str, title: str | None, phase: tuple[int, str] | None
) -> None:
    assert buildview.plan_phase(plan_id, title) == phase


def test_a_projects_specs_name_its_phases(tmp_path: Path) -> None:
    _specs(tmp_path)
    phases = buildview.spec_phases(tmp_path)
    assert sorted(phases) == [0, 1, 2, 3]
    assert phases[2] == {
        "name": "rumble and modulation",
        "goal": "the hypnotic part of the sound.",
        "spec": "docs/specs/phase-2-rumble.md",
    }
    assert buildview.spec_phases(tmp_path / "missing") == {} and buildview.spec_phases(None) == {}


def _logged(rt: Runtime, run_id: str, kind: str, label: str, **fields: Any) -> None:
    rt.runs.add(run_id, kind, label, plan_id=fields.pop("plan_id", None), project=fields.pop("project", None))
    rt.runs.update(run_id, **fields)


def test_the_build_is_its_phases_in_order_with_its_totals_and_what_comes_next(tmp_path: Path) -> None:
    """The pilot's build after phase 1: P0 failed once and passed on its resume, P1 passed, P2's plan is being
    written, P3 is only specified."""
    _specs(tmp_path)
    fake = FakeRoko().start()
    fake.add_plan("p0-undertow-foundation", "P0 · Undertow foundation", [{"id": f"T{n}"} for n in (1, 2, 3)])
    fake.plans["p0-undertow-foundation"]["tasks_done"] = 3
    fake.add_plan("p1-undertow-voice", "P1 · Undertow voice", [{"id": f"T{n}"} for n in range(1, 6)])
    fake.plans["p1-undertow-voice"]["tasks_done"] = 5
    fake.add_plan("title-p0-undertow-foundation", "Title: P0 · Undertow foundation", [{"id": "T1"}])
    fake.add_plan("add-clamp", "Add clamp", [{"id": "T1"}])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    project = str(tmp_path)
    receipt = {"cost_usd": 0.406198, "top_rung": "claude-sonnet-4-6", "top_rung_usd": 1.2, "not_compared": 0}
    try:
        _logged(
            rt, "r-p0a", "plan", "P0 · Undertow foundation", plan_id="p0-undertow-foundation",
            project=project, state="failed", cost_usd=0.647606, cost_final=True,
            started_at="2026-10-19T12:18:25Z", finished_at="2026-10-19T13:15:00Z",
            progress={"total": 3, "passed": 2, "failed": 1},
        )  # fmt: skip
        _logged(
            rt, "r-p0b", "plan", "P0 · Undertow foundation", plan_id="p0-undertow-foundation",
            project=project, state="succeeded", cost_usd=0.406198, cost_final=True, receipt=receipt,
            started_at="2026-10-19T15:06:24Z", finished_at="2026-10-19T15:40:00Z",
            progress={"total": 3, "passed": 3},
            rungs=[{"rung": "mid", "passed": 3, "running": 0, "failed": 0, "waiting": 0}],
        )  # fmt: skip
        _logged(
            rt, "r-p1", "plan", "P1 · Undertow voice", plan_id="p1-undertow-voice", project=project,
            state="succeeded", cost_usd=1.0204, cost_final=True,
            started_at="2026-10-19T15:47:48Z", finished_at="2026-10-19T17:04:00Z",
            progress={"total": 5, "passed": 5},
        )  # fmt: skip
        _logged(rt, "w-p2", "plan_generate", "P2 · Undertow rumble", plan_id="p2-undertow-rumble", project=project,
                state="running", started_at="2026-10-20T09:49:11Z")  # fmt: skip
        build = buildview.build_view(rt)
    finally:
        rt.close()
        fake.stop()
    phases = {phase["n"]: phase for phase in build["phases"]}
    assert [phase["n"] for phase in build["phases"]] == [0, 1, 2, 3]
    p0, p1, p2, p3 = phases[0], phases[1], phases[2], phases[3]
    assert (p0["state"], p0["plan_id"], p0["runs"], p0["run_id"]) == (
        "passed",
        "p0-undertow-foundation",
        2,
        "r-p0b",
    )
    assert p0["tasks"] == {"passed": 3, "total": 3} and p0["cost_usd"] == pytest.approx(1.053804)
    assert p0["name"] == "foundation" and p0["goal"].startswith("the build system")
    assert p0["wall_ms"] == (56 * 60 + 35) * 1000 + 33 * 60 * 1000 + 36 * 1000
    assert p0["rungs"][0]["passed"] == 3
    assert (p1["state"], p1["tasks"], p1["cost_usd"]) == ("passed", {"passed": 5, "total": 5}, 1.0204)
    assert (p2["state"], p2["plan_id"], p2["writing_id"]) == ("writing", None, "w-p2")
    assert (p3["state"], p3["spec"], p3["tasks"]) == ("specified", "docs/specs/phase-3-sequencer.md", None)
    totals = build["totals"]
    assert (totals["phases"], totals["passed"], totals["tasks_passed"], totals["tasks_total"]) == (4, 2, 8, 8)
    assert totals["cost_usd"] == pytest.approx(2.074204) and totals["runs"] == 3
    # The receipt counts the ended runs whose whole card was read: one so far, the other two not yet.
    assert build["receipt"] == {
        "cost_usd": 0.406198,
        "top_rung": "claude-sonnet-4-6",
        "top_rung_usd": 1.2,
        "ratio": 3.0,
        "runs": 1,
        "missing": 2,
        "unread": ["r-p0a", "r-p1"],
        "not_compared": 0,
    }
    assert build["next"] == {"n": 2, "do": "wait", "run_id": "w-p2"}
    assert build["project"]["path"] == project


def test_what_the_build_waits_on_says_what_moves_it(tmp_path: Path) -> None:
    _specs(tmp_path)
    fake = FakeRoko().start()
    fake.add_plan("p0-undertow-foundation", "P0 · Undertow foundation", [{"id": "T1"}])
    ctx = FakeContext({"url": fake.url, "workdir": str(tmp_path)})
    rt = Runtime(ctx)
    try:
        assert buildview.build_view(rt)["next"] == {"n": 0, "do": "run", "plan_id": "p0-undertow-foundation"}
        _logged(rt, "r-a", "plan", "P0", plan_id="p0-undertow-foundation", state="failed", cost_final=True)
        assert buildview.build_view(rt)["next"] == {
            "n": 0,
            "do": "resume",
            "plan_id": "p0-undertow-foundation",
            "run_id": "r-a",
        }
        _logged(rt, "r-b", "plan", "P0", plan_id="p0-undertow-foundation", state="succeeded", cost_final=True)
        rt.runs.update("r-b", started_at="2099-01-01T00:00:00Z")
        assert buildview.build_view(rt)["next"] == {
            "n": 1,
            "do": "write",
            "spec": "docs/specs/phase-1-voice.md",
        }
    finally:
        rt.close()
        fake.stop()
    # roko is down: the specs still make the build, and it says roko did not answer.
    later = Runtime(ctx)
    try:
        down = buildview.build_view(later)
    finally:
        later.close()
    assert down["reachable"] is False
    assert [p["state"] for p in down["phases"]] == ["passed"] + ["specified"] * 3  # P0 from the run log


def test_a_project_with_no_phases_has_an_empty_build(tmp_path: Path) -> None:
    fake = FakeRoko().start()
    fake.add_plan("add-clamp", "Add clamp", [{"id": "T1"}])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        build = buildview.build_view(rt)
    finally:
        rt.close()
        fake.stop()
    assert build["phases"] == [] and build["next"] is None and build["receipt"] is None
    assert build["totals"]["phases"] == 0


def test_the_build_route_shows_the_home_as_a_tilde_and_counts_each_runs_receipt(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`GET /build` over the plugin's API. A run's card read whole leaves its receipt in the run log (the build
    reads no run's events itself), and the build's receipt then counts it."""
    from fake_roko import Run
    from test_v07_projects import web

    from hermes_plugin_roko import views

    monkeypatch.setenv("HOME", str(tmp_path))
    project = tmp_path / "undertow"
    project.mkdir()
    _specs(project)
    fake = FakeRoko().start()
    fake.add_plan("p0-undertow-foundation", "P0 · Undertow foundation", [{"id": "T1"}])
    fake.runs["r-p0"] = Run("r-p0", "plan", ["succeeded"], plan_id="p0-undertow-foundation", cost_usd=0.25)
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(project)}))
    try:
        rt.runs.add(
            "r-p0",
            "plan",
            "P0 · Undertow foundation",
            plan_id="p0-undertow-foundation",
            project=str(project),
            state="succeeded",
        )
        with web(rt) as client:
            before = client.get("/api/plugins/roko/build").json()
            assert before["ok"] is True and before["project"]["path"] == "~/undertow"
            assert before["receipt"]["missing"] == 1
            card = views.card(rt, "r-p0")
            assert card["state"] == "succeeded" and isinstance(card["receipt"], dict)
            after = client.get("/api/plugins/roko/build").json()
        assert (after["receipt"]["runs"], after["receipt"]["missing"]) == (1, 0)
        assert after["phases"][0]["state"] == "passed" and after["next"]["do"] == "write"
    finally:
        rt.close()
        fake.stop()


def test_a_phases_tasks_are_rokos_plan_row_or_what_its_latest_run_passed_if_that_says_more(
    tmp_path: Path,
) -> None:
    fake = FakeRoko().start()
    fake.add_plan("p1-undertow-voice", "P1 · Undertow voice", [{"id": f"T{n}"} for n in range(1, 6)])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        _logged(
            rt,
            "r-1",
            "plan",
            "P1",
            plan_id="p1-undertow-voice",
            state="succeeded",
            progress={"total": 5, "passed": 5},
        )
        assert buildview.build_view(rt)["phases"][0]["tasks"] == {
            "passed": 5,
            "total": 5,
        }  # the row says 0 done
        fake.plans["p1-undertow-voice"]["tasks_done"] = 5
        rt.runs.update("r-1", progress={"total": 1, "passed": 1})  # a resume that ran the last task only
        assert buildview.build_view(rt)["phases"][0]["tasks"] == {"passed": 5, "total": 5}
    finally:
        rt.close()
        fake.stop()

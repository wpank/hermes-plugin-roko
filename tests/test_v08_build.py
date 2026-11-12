"""0.8.0 (round v7, #3): the project's build, its phases in order (`GET /build`).

Metakosmia Undertow is six phases, each a spec (`docs/specs/phase-<n>-<slug>.md`), then a plan ("P<n> · …"),
then its runs. The build answers what a viewer asks first: how far along it is, what it cost and took, what runs
now, what comes next, and what the cheap rungs saved across all of it.
"""

from __future__ import annotations

import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeContext
from fake_roko import FakeRoko, Run

from hermes_plugin_roko import buildview, rundata, views
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


@pytest.mark.parametrize(
    ("plan_id", "title", "known", "phase"),
    [
        # P-42: a sub-phase is its own phase, by its title or, when its spec exists, by its id.
        ("p2-1-undertow-voice-fixes-2", "P2.1 · Undertow voice fixes", (), (2.1, "Undertow voice fixes")),
        ("p2-1-undertow-voice-fixes-2", None, (2.1,), (2.1, "undertow voice fixes 2")),
        ("p2-1-undertow-voice-fixes-2", None, (), (2, "1 undertow voice fixes 2")),
        ("p2-undertow-rumble", "P2. Undertow rumble", (2.1,), (2, "Undertow rumble")),
    ],
)
def test_a_sub_phase_is_its_own_phase(
    plan_id: str, title: str | None, known: tuple[float, ...], phase: tuple[float, str]
) -> None:
    assert buildview.plan_phase(plan_id, title, frozenset(known)) == phase


def test_a_sub_phases_spec_its_plans_and_its_money_stand_between_its_neighbours(tmp_path: Path) -> None:
    """P-42 (the pilot's R1d still): phase 2.1 folded into P2 ("P2 PASSED 4/4 · $2.74 · incl. $0.57 plan writing",
    with 2.1's two writings in it) and NEXT said to plan P3 while P2.1's plan waited to run. A phase may be <n>.<m>,
    between n and n+1."""
    _specs(tmp_path)
    (tmp_path / "docs" / "specs" / "phase-2.1-voice-fixes.md").write_text(
        "# Phase 2.1: voice fixes\n\n**Goal**: the voice as audio-qa heard it.\n"
    )
    fake = FakeRoko().start()
    # P0 and P1 passed, by plans in the build (round v8: a run counts toward a phase only by its plan's exact id).
    for n in (0, 1):
        fake.add_plan(f"p{n}-x", f"P{n} · x", [{"id": "T1"}])
    fake.add_plan("p2-undertow-rumble", "P2 · Undertow rumble", [{"id": "T1"}])
    fake.add_plan("p2-1-undertow-voice-fixes-2", "P2.1 · Undertow voice fixes", [{"id": "T1"}, {"id": "T2"}])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        for n in (0, 1):
            _logged(rt, f"r-{n}", "plan", f"P{n}", plan_id=f"p{n}-x", state="succeeded", cost_final=True)
        _logged(rt, "r-2", "plan", "P2 · Undertow rumble", plan_id="p2-undertow-rumble", state="succeeded")
        rt.runs.update("r-2", cost_usd=2.17, cost_final=True)
        _logged(
            rt, "w-21", "plan_generate", "P2.1 · Undertow voice fixes", plan_id="p2-1-undertow-voice-fixes-2"
        )
        rt.runs.update("w-21", state="succeeded", cost_usd=0.044)
        assert buildview.spec_phases(tmp_path)[2.1]["name"] == "voice fixes"
        build = buildview.build_view(rt)
        assert [phase["n"] for phase in build["phases"]] == [0, 1, 2, 2.1, 3]
        two, sub = build["phases"][2], build["phases"][3]
        assert (two["plan_id"], sub["plan_id"]) == ("p2-undertow-rumble", "p2-1-undertow-voice-fixes-2")
        assert sub["state"] == "written" and sub["spec"] == "docs/specs/phase-2.1-voice-fixes.md"
        assert two["writing_usd"] is None and sub["writing_usd"] == 0.044
        assert build["next"]["n"] == 2.1 and build["next"]["do"] in ("run", "rewrite")
    finally:
        rt.close()
        fake.stop()


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
    # The receipt: the top-rung side is each passed phase's passing run (each task once: P0's failed run passed
    # T1 and T2, and its second run passed them again), and the spend side every run of every phase, P0's failed
    # one included. P1's passing run is not read yet.
    assert build["receipt"] == {
        "phases": 1,
        "cost_usd": 2.074204,
        "top_rung": "claude-sonnet-4-6",
        "top_rung_usd": 1.2,
        "ratio": 0.6,
        "basis": "≈ each passed phase's passing tries at claude-sonnet-4-6's list prices · roko's spend includes 1 "
        "run that didn't pass",
        "runs_not_passed": 1,
        "runs_running": 0,
        "missing": 1,
        "unread": ["r-p1"],
        "not_compared": 0,
        # Option 1 (the lead): the receipt in words is the backend's, as the ladder line is.
        "words": "1 phase built so far on claude-sonnet-4-6 ≈ $1.20 · roko spent $2.07: 1.7× more · 1 run still to "
        "read",
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
    # roko is down: the specs still make the build, and it says roko did not answer. Its plans are the folder's
    # (round v8: by exact id), so P0's run counts from the run log.
    (tmp_path / "plans" / "p0-undertow-foundation").mkdir(parents=True)
    (tmp_path / "plans" / "p0-undertow-foundation" / "tasks.toml").write_text(
        '[meta]\ntitle = "P0 · Undertow foundation"\n'
    )
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
        assert (after["receipt"]["phases"], after["receipt"]["missing"]) == (1, 0)
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


# -- the lead's fixes after the pilot's real-data shots ------------------------------------------------------------

SPEC_TWO = """# Phase 2: rumble and modulation

**Goal**: the hypnotic part of the sound. Two tempo-synced LFOs locked to the beat position, the rumble (a ghost
kick into a dark reverb, low-passed, saturated and ducked on the beat).

## Acceptance checks

| ID | Command | What it proves |
|----|---------|----------------|
| P2.01 | `tools/spec.sh 2 lfo 'P2.01*'` | The rate choices are the right cycle lengths |
| P2.02 | `tools/spec.sh 2 lfo 'P2.02*'` | The shapes have their values at quarter points |
| P2.04 | `tools/spec.sh 2 rumble 'P2.04*'` | The ghost kick and the duck follow the beat grid |
"""


def _plan_file(workdir: Path, plan_id: str, *commands: str) -> None:
    folder = workdir / "plans" / plan_id
    folder.mkdir(parents=True)
    steps = "".join(
        f'[[task]]\nid = "T{n}"\ntitle = "t"\n\n[[task.verify]]\nphase = "test"\ncommand = """{command}"""\n\n'
        for n, command in enumerate(commands, start=1)
    )
    (folder / "tasks.toml").write_text(
        f'[meta]\nplan = "{plan_id}"\ntitle = "P2 · Undertow rumble"\n\n{steps}'
    )


def test_a_plan_that_misses_its_specs_checks_is_written_again_never_run(tmp_path: Path) -> None:
    """hermes-pilot P-25: NEXT said "P2's plan is written: run it next · run P2" for two plans that ran cargo in a C++
    repo, so neither could ever pass. The build now counts the spec's acceptance checks a plan's verify steps run,
    picks the plan that runs the most, and a plan that misses any is written again, never run."""
    (tmp_path / "docs" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "specs" / "phase-2-rumble.md").write_text(SPEC_TWO)
    _plan_file(tmp_path, "p2-undertow-rumble", "test -f core/src/lfo.cpp && cargo test -p undertow_core lfo")
    _plan_file(
        tmp_path, "p2-undertow-rumble-2", "tools/spec.sh 2 lfo 'P2.01*'", "tools/spec.sh 2 lfo 'P2.02*'"
    )
    fake = FakeRoko().start()
    fake.add_plan("p2-undertow-rumble", "P2 · Undertow rumble", [{"id": "T1"}])
    fake.add_plan("p2-undertow-rumble-2", "P2 · Undertow rumble", [{"id": "T1"}])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        build = buildview.build_view(rt)
        [phase] = build["phases"]
        assert phase["plan_id"] == "p2-undertow-rumble-2"  # it runs 2 of the 3 checks exactly, the other none
        assert phase["coverage"] == {"total": 3, "covered": 2, "missing": ["P2.04"]}
        assert phase["goal"] == "the hypnotic part of the sound."  # P-26: its first sentence
        long = "the build system and a core library, " * 8 + "and a plugin skeleton. Then the rest."
        cut = long.index(" ", 70)  # a spec wraps its lines
        (tmp_path / "docs" / "specs" / "phase-3-long.md").write_text(
            f"# Phase 3: long\n\n**Goal**: {long[:cut]}\n{long[cut + 1 :]}\n\n## Scope\n"
        )
        goal = buildview.spec_phases(tmp_path)[3]["goal"]
        assert goal.endswith("…") and len(goal) <= buildview.GOAL_CHARS + 1 and "plugin skeleton" not in goal
        assert build["next"] == {
            "n": 2,
            "do": "rewrite",
            "plan_id": "p2-undertow-rumble-2",
            "spec": "docs/specs/phase-2-rumble.md",
            "covered": 2,
            "total": 3,
            "missing": ["P2.04"],
            "plans": 2,
            "newest": True,
        }
        (tmp_path / "plans" / "p2-undertow-rumble-2" / "tasks.toml").write_text(
            '[meta]\nplan = "p2-undertow-rumble-2"\n\n[[task]]\nid = "T1"\n\n'
            + "".join(
                f'[[task.verify]]\nphase = "test"\ncommand = "{command}"\n\n'
                for command in (
                    "tools/spec.sh 2 lfo 'P2.01*'",
                    "tools/spec.sh 2 lfo 'P2.02*'",
                    "tools/spec.sh 2 rumble 'P2.04*'",
                )
            )
        )
        assert buildview.build_view(rt)["next"] == {
            "n": 2,
            "do": "run",
            "plan_id": "p2-undertow-rumble-2",
            "covered": 3,
            "total": 3,
            "plans": 2,
            "newest": True,
        }
    finally:
        rt.close()
        fake.stop()


def test_of_two_plans_that_miss_as_many_checks_next_names_the_newest_and_says_so(tmp_path: Path) -> None:
    """hermes-pilot P-33: both P2 plans miss all 19 checks, and NEXT named the older one, p2-undertow-rumble, though
    p2-undertow-rumble-2 (op 87df1c1b) was written after it. A tie goes to the newest plan, and NEXT says how many
    plans the phase has and whether the one it names is the newest."""
    (tmp_path / "docs" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "specs" / "phase-2-rumble.md").write_text(SPEC_TWO)
    _plan_file(tmp_path, "p2-undertow-rumble", "cargo test -p undertow_core lfo")
    _plan_file(tmp_path, "p2-undertow-rumble-2", "cargo test -p undertow_core rumble")
    older, newer = (
        tmp_path / "plans" / name / "tasks.toml" for name in ("p2-undertow-rumble", "p2-undertow-rumble-2")
    )
    os.utime(older, (1_760_950_000, 1_760_950_000))
    os.utime(newer, (1_760_953_600, 1_760_953_600))
    fake = FakeRoko().start()
    fake.add_plan("p2-undertow-rumble", "P2 · Undertow rumble", [{"id": "T1"}])
    fake.add_plan("p2-undertow-rumble-2", "P2 · Undertow rumble", [{"id": "T1"}])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        build = buildview.build_view(rt)
        assert build["phases"][0]["plan_id"] == "p2-undertow-rumble-2"
        assert build["next"]["plan_id"] == "p2-undertow-rumble-2"
        assert (build["next"]["do"], build["next"]["plans"], build["next"]["newest"]) == ("rewrite", 2, True)
        # Rewritten by hand later, the first plan is the newest now: still a tie, so it is the one named.
        os.utime(older, (1_760_957_200, 1_760_957_200))
        assert buildview.build_view(rt)["next"]["plan_id"] == "p2-undertow-rumble"
        # A plan that runs more of the spec's checks wins over a newer one, and NEXT says it is not the newest.
        _plan_file(tmp_path, "p2-undertow-rumble-3", "tools/spec.sh 2 lfo 'P2.01*'")
        fake.add_plan("p2-undertow-rumble-3", "P2 · Undertow rumble", [{"id": "T1"}])
        os.utime(tmp_path / "plans" / "p2-undertow-rumble-3" / "tasks.toml", (1_760_940_000, 1_760_940_000))
        best = buildview.build_view(rt)["next"]
        assert (best["plan_id"], best["plans"], best["newest"]) == ("p2-undertow-rumble-3", 3, False)
    finally:
        rt.close()
        fake.stop()


def test_the_builds_money_is_rokos_own_ledger_by_plan_id(tmp_path: Path) -> None:
    """hermes-pilot P-24: the Build tab said $2.62 where roko's ledger said $2.79: it added the run log's runs and plan
    writings, and missed a plan writing whose title named no phase and roko's calls after a writing. The money is
    now roko's ledger, grouped by plan id: each phase's runs and plan writing, and what no phase's plan accounts
    for, so every number agrees with roko's."""
    import json

    _specs(tmp_path)
    ledger = tmp_path / ".roko" / "learn" / "costs.jsonl"
    ledger.parent.mkdir(parents=True)
    rows = [
        ("p0-undertow-foundation", "T1", 0.647606),  # the failed run
        ("p0-undertow-foundation", "T3", 0.025315),  # the cancelled one
        ("p0-undertow-foundation", "T2", 0.406198),
        ("p0-undertow-foundation", "summarise", 0.0037),  # a helper call
        ("p0-undertow-foundation", "generate", 0.0566),
        ("p0-undertow-foundation", "plan:generate:p0-undertow-foundation", 0.0093),
        ("title-p0-undertow-foundation", "generate", 0.0324),
        ("set-the-plan-title-field-to-exactly-p0-undertow", "generate", 0.096),  # no phase in its id
        ("p1-undertow-voice", "T1", 1.0204),
        ("p1-undertow-voice", "generate", 0.1519),
    ]
    ledger.write_text(
        "".join(json.dumps({"plan_id": p, "task_id": t, "cost_usd": c}) + "\n" for p, t, c in rows)
    )
    fake = FakeRoko().start()
    fake.add_plan("p0-undertow-foundation", "P0 · Undertow foundation", [{"id": "T1"}])
    fake.plans["p0-undertow-foundation"]["tasks_done"] = 1
    fake.add_plan("p1-undertow-voice", "P1 · Undertow voice", [{"id": "T1"}])
    fake.plans["p1-undertow-voice"]["tasks_done"] = 1
    # The two misnamed writings' plans are in plans/ too: they are the build's (round v8: by exact id).
    fake.add_plan("title-p0-undertow-foundation", "Title: P0 · Undertow foundation", [{"id": "T1"}])
    fake.add_plan(
        "set-the-plan-title-field-to-exactly-p0-undertow", "Set the plan title field", [{"id": "T1"}]
    )
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    receipt = {"cost_usd": 0.4, "top_rung": "claude-sonnet-4-6", "top_rung_usd": 1.5, "not_compared": 0}
    try:
        _logged(rt, "r-a", "plan", "P0", plan_id="p0-undertow-foundation", state="failed", cost_usd=0.647606)
        _logged(rt, "r-b", "plan", "P0", plan_id="p0-undertow-foundation", state="succeeded", receipt=receipt)
        rt.runs.update("r-b", started_at="2099-01-01T00:00:00Z")
        build = buildview.build_view(rt)
    finally:
        rt.close()
        fake.stop()
    p0, p1 = build["phases"][0], build["phases"][1]
    assert p0["cost_usd"] == pytest.approx(1.181119) and p0["writing_usd"] == pytest.approx(0.0983)
    assert p1["cost_usd"] == pytest.approx(1.1723) and p1["writing_usd"] == pytest.approx(0.1519)
    totals = build["totals"]
    assert (
        totals["cost_usd"] == pytest.approx(sum(c for _p, _t, c in rows))
        and totals["cost_source"] == "ledger"
    )
    assert totals["outside_usd"] == pytest.approx(0.096) and totals["writing_usd"] == pytest.approx(0.2502)
    assert totals["elsewhere_usd"] is None
    # The receipt's spend is the phases' runs as roko's ledger has them, helpers included: 1.082819 + 1.0204.
    assert build["receipt"]["cost_usd"] == pytest.approx(2.103219)


def test_an_earlier_builds_plans_in_rokos_ledger_and_run_log_never_count_toward_this_builds_phases(
    tmp_path: Path,
) -> None:
    """hermes-pilot-v8 (round v8): Undertow 2 starts in Undertow 1's workspace, whose .roko keeps all of v1's plans
    (about $18.65), and Will's run log keeps v1's runs. v1's `p1-undertow-voice` would map to phase 1 by its number.
    The build is the plans in plans/ by exact id: v1's money is one line apart, and none of it is a phase's."""
    import json

    (tmp_path / "docs" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "specs" / "phase-1-foundation.md").write_text(
        "# Phase 1: foundation\n\n**Goal**: a core.\n"
    )
    plan = tmp_path / "plans" / "p1-foundation"
    plan.mkdir(parents=True)
    (plan / "tasks.toml").write_text('[meta]\ntitle = "P1 · Foundation"\n')
    ledger = tmp_path / ".roko" / "learn" / "costs.jsonl"
    ledger.parent.mkdir(parents=True)
    rows = [
        ("p1-undertow-voice", "T1", 11.50),  # Undertow 1's phase 1, no longer in plans/
        ("p1-undertow-voice", "generate", 0.15),
        ("p2-undertow-rumble", "T1", 7.00),  # Undertow 1's phase 2
        ("p1-foundation", "generate", 0.07),  # Undertow 2's phase 1
        ("p1-foundation", "T1", 0.43),
    ]
    ledger.write_text(
        "".join(json.dumps({"plan_id": p, "task_id": t, "cost_usd": c}) + "\n" for p, t, c in rows)
    )
    fake = FakeRoko().start()
    fake.add_plan("p1-foundation", "P1 · Foundation", [{"id": "T1"}])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        # v1's runs in the run log: by their ids they would be phase 1 and phase 2.
        _logged(rt, "v1-r1", "plan", "P1 · Undertow voice", plan_id="p1-undertow-voice", state="succeeded")
        _logged(rt, "v1-r2", "plan", "P2 · Undertow rumble", plan_id="p2-undertow-rumble", state="failed")
        _logged(
            rt,
            "v1-w1",
            "plan_generate",
            "P1 · Undertow voice",
            plan_id="p1-undertow-voice",
            state="succeeded",
        )
        build = buildview.build_view(rt)
        # roko is down: the folder says which plans are the build's.
        fake.stop()
        down = buildview.build_view(rt)
    finally:
        rt.close()
        fake.stop()
    [one] = build["phases"]
    assert (one["n"], one["plan_id"], one["runs"], one["writing_id"]) == (1, "p1-foundation", 0, None)
    assert one["cost_usd"] == pytest.approx(0.50) and one["writing_usd"] == pytest.approx(0.07)
    totals = build["totals"]
    assert totals["cost_usd"] == pytest.approx(0.50) and totals["outside_usd"] == pytest.approx(0.0)
    assert totals["elsewhere_usd"] == pytest.approx(18.65)
    assert totals["runs"] == 0
    assert [phase["n"] for phase in down["phases"]] == [1]
    assert down["phases"][0]["runs"] == 0 and down["totals"]["elsewhere_usd"] == pytest.approx(18.65)


def test_rokos_own_kept_count_leads_and_the_plugins_count_cross_checks_it(tmp_path: Path) -> None:
    """bug-72dc0d (roko 9f0870e9a): a check counts as kept only by a step that runs its command, so roko's
    `source_checks.kept` is honest now. The build shows roko's count from the plan's newest plan writing, keeps its
    own count of what the plan's verify steps run as the cross-check, flags any disagreement, and offers to run a
    plan only when both say every check is kept."""
    (tmp_path / "docs" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "specs" / "phase-2-rumble.md").write_text(SPEC_TWO)
    _plan_file(
        tmp_path,
        "p2-undertow-rumble",
        "tools/spec.sh 2 lfo 'P2.01*'",
        "tools/spec.sh 2 lfo 'P2.02*'",
        "tools/spec.sh 2 rumble 'P2.04*'",
    )
    fake = FakeRoko().start()
    fake.add_plan("p2-undertow-rumble", "P2 · Undertow rumble", [{"id": "T1"}])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    project = str(tmp_path)
    counts = {"total": 3, "kept": 3, "shallow": 0, "cannot_run": 0, "dropped": 0, "missing": 0}
    try:
        _logged(
            rt,
            "w-old",
            "plan_generate",
            "P2 · Undertow rumble",
            plan_id="p2-undertow-rumble",
            project=project,
        )
        rt.runs.update("w-old", state="succeeded", started_at="2026-10-20T10:00:00Z")
        # No count kept yet: the newest writing is opened in the background, as a passing run's receipt is.
        build = buildview.build_view(rt)
        assert build["phases"][0]["roko_coverage"] is None
        assert build["unread_writings"] == ["w-old"]
        rt.runs.update("w-old", source_checks=counts)
        build = buildview.build_view(rt)
        [phase] = build["phases"]
        assert phase["roko_coverage"] == {**counts, "writing_id": "w-old"}
        assert phase["coverage_agrees"] is True
        assert build["next"]["do"] == "run" and build["unread_writings"] == []
        # A newer writing whose roko count says 2 of 3: roko's word stops the run, and the cross-check flags it.
        _logged(
            rt,
            "w-new",
            "plan_generate",
            "P2 · Undertow rumble",
            plan_id="p2-undertow-rumble",
            project=project,
        )
        rt.runs.update(
            "w-new",
            state="succeeded",
            started_at="2026-10-20T11:00:00Z",
            source_checks={**counts, "kept": 2, "missing": 1},
        )
        build = buildview.build_view(rt)
        [phase] = build["phases"]
        assert (phase["roko_coverage"]["kept"], phase["roko_coverage"]["writing_id"]) == (2, "w-new")
        assert phase["coverage_agrees"] is False
        assert build["next"]["do"] == "rewrite"
        assert (build["next"]["roko_kept"], build["next"]["roko_total"]) == (2, 3)
        # The real P2 plan: roko lifts 24 checks from the spec and keeps all 24; the plugin's table count is 23,
        # all run. Both say nothing is missing, so they agree: no flag over a different total.
        rt.runs.update("w-new", source_checks={**counts, "total": 4, "kept": 4})
        assert buildview.build_view(rt)["phases"][0]["coverage_agrees"] is True
    finally:
        rt.close()
        fake.stop()


def test_a_plan_writings_kept_counts_go_into_the_run_log(tmp_path: Path) -> None:
    from hermes_plugin_roko import views

    rt = Runtime(FakeContext({"workdir": str(tmp_path)}))
    try:
        rt.runs.add("w1", "plan_generate", "P2 · Undertow rumble", plan_id="p2-undertow-rumble")
        sc = {
            "total": 23,
            "kept": 20,
            "shallow": 1,
            "cannot_run": 0,
            "dropped": 1,
            "missing": 1,
            "checks": [],
        }
        views._remember(rt, "w1", {"kind": "plan_generate", "state": "succeeded", "source_checks": sc})
        assert rt.runs.get("w1")["source_checks"] == {
            "total": 23,
            "kept": 20,
            "shallow": 1,
            "cannot_run": 0,
            "dropped": 1,
            "missing": 1,
        }
    finally:
        rt.close()


def test_the_run_log_keeps_when_the_plugin_learned_a_writings_kept_count(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The pilot's P4.3 (p3): the moment the plugin first learned roko's count is kept, so a hand edit of the plan
    after it can be told apart; a later read of the same writing does not move it."""
    from hermes_plugin_roko import views

    rt = Runtime(FakeContext({"workdir": str(tmp_path)}))
    try:
        rt.runs.add("w1", "plan_generate", "P2 · Undertow rumble", plan_id="p2-undertow-rumble")
        view = {"kind": "plan_generate", "state": "succeeded", "source_checks": {"total": 3, "kept": 3}}
        monkeypatch.setattr(rundata, "now_iso", lambda: "2026-10-26T12:20:00Z")
        views._remember(rt, "w1", view)
        monkeypatch.setattr(rundata, "now_iso", lambda: "2026-10-26T14:30:00Z")
        views._remember(rt, "w1", view)
        assert rt.runs.get("w1")["source_checks_at"] == "2026-10-26T12:20:00Z"
    finally:
        rt.close()


def test_a_plan_edited_after_roko_counted_its_checks_goes_by_the_plugins_count(tmp_path: Path) -> None:
    """The pilot's P4.3 (p3): roko's count of the spec's checks a plan keeps comes from its writing, so a person's
    hand edits leave it stale: NEXT said "roko counts 12 of its spec's 17 checks kept, the plugin 16: write it
    again" for a plan that, edited, kept all 16. When the plan's tasks.toml is newer than the moment the plugin
    learned roko's count, the plugin's own count goes alone (the lead: no extra page words)."""
    (tmp_path / "docs" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "specs" / "phase-2-rumble.md").write_text(SPEC_TWO)
    _plan_file(
        tmp_path,
        "p2-undertow-rumble",
        "tools/spec.sh 2 lfo 'P2.01*'",
        "tools/spec.sh 2 lfo 'P2.02*'",
        "tools/spec.sh 2 rumble 'P2.04*'",
    )
    tasks = tmp_path / "plans" / "p2-undertow-rumble" / "tasks.toml"
    learned = datetime(2026, 10, 20, 10, 5, tzinfo=UTC).timestamp()
    fake = FakeRoko().start()
    fake.add_plan("p2-undertow-rumble", "P2 · Undertow rumble", [{"id": "T1"}])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    counts = {"total": 3, "kept": 2, "shallow": 0, "cannot_run": 0, "dropped": 0, "missing": 1}
    try:
        _logged(rt, "w", "plan_generate", "P2", plan_id="p2-undertow-rumble", project=str(tmp_path))
        rt.runs.update(
            "w",
            state="succeeded",
            started_at="2026-10-20T10:00:00Z",
            source_checks=counts,
            source_checks_at="2026-10-20T10:05:00Z",
        )
        # The plan as roko wrote it, before the plugin learned its count: roko's word stands.
        os.utime(tasks, (learned - 60, learned - 60))
        build = buildview.build_view(rt)
        assert build["phases"][0]["roko_coverage"]["kept"] == 2 and build["next"]["do"] == "rewrite"
        # Edited by hand after that: the plugin's own count, 3 of 3, goes alone, and NEXT runs it.
        os.utime(tasks, (learned + 3600, learned + 3600))
        build = buildview.build_view(rt)
        [phase] = build["phases"]
        assert phase["roko_coverage"] is None and phase["coverage_agrees"] is None
        assert (phase["coverage"]["covered"], phase["coverage"]["total"]) == (3, 3)
        assert build["next"]["do"] == "run" and build["unread_writings"] == []
        # A writing the run log does not say that moment for (before 0.8.0): roko's count stands.
        _logged(rt, "w2", "plan_generate", "P2", plan_id="p2-undertow-rumble", project=str(tmp_path))
        rt.runs.update("w2", state="succeeded", started_at="2026-10-20T11:00:00Z", source_checks=counts)
        assert buildview.build_view(rt)["next"]["do"] == "rewrite"
    finally:
        rt.close()
        fake.stop()


def test_a_step_runs_a_spec_check_only_when_it_is_exactly_the_specs_command(tmp_path: Path) -> None:
    """The lead, on phase 2's p2-undertow-rumble-3: every step was `grep -q '<name>' <file> && tools/spec.sh …`, and
    T4's guard `grep -q 'AllocationCounter' core/src/engine.cpp` can never pass on correct code (AllocationCounter
    is a spec test helper). roko counted it 24 of 24 kept, and a count that took a step containing the spec's
    command as running it said 23 of 23: the Build tab offered to run a plan that cannot pass. A step runs a spec
    check only when its command is exactly the spec's command: no guards, chains, changed filters or runners."""
    (tmp_path / "docs" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "specs" / "phase-2-rumble.md").write_text(SPEC_TWO)
    _plan_file(
        tmp_path,
        "p2-undertow-rumble-3",
        "grep -q 'LfoRate' core/src/lfo.h && tools/spec.sh 2 lfo 'P2.01*'",
        "grep -q 'AllocationCounter' core/src/engine.cpp && tools/spec.sh 2 lfo 'P2.02*'",
        "tools/spec.sh 2 rumble 'P2.04*' && echo done",
    )
    fake = FakeRoko().start()
    fake.add_plan("p2-undertow-rumble-3", "P2 · Undertow rumble", [{"id": f"T{n}"} for n in (1, 2, 3)])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        _logged(rt, "w-3", "plan_generate", "P2 · Undertow rumble", plan_id="p2-undertow-rumble-3")
        counts = {"total": 3, "kept": 3, "shallow": 0, "cannot_run": 0, "dropped": 0, "missing": 0}
        rt.runs.update("w-3", state="succeeded", started_at="2026-10-20T17:34:00Z", source_checks=counts)
        build = buildview.build_view(rt)
        [phase] = build["phases"]
        assert phase["coverage"] == {"total": 3, "covered": 0, "missing": ["P2.01", "P2.02", "P2.04"]}
        assert phase["roko_coverage"]["kept"] == 3 and phase["coverage_agrees"] is False
        assert build["next"]["do"] == "rewrite"
        # The same plan with the spec's commands as written: every check is run, and the two counts agree.
        (tmp_path / "plans" / "p2-undertow-rumble-3" / "tasks.toml").unlink()
        (tmp_path / "plans" / "p2-undertow-rumble-3").rmdir()
        _plan_file(
            tmp_path,
            "p2-undertow-rumble-3",
            "tools/spec.sh 2 lfo 'P2.01*'",
            "  tools/spec.sh 2 lfo 'P2.02*'  ",
            "tools/spec.sh 2 rumble 'P2.04*'",
        )
        build = buildview.build_view(rt)
        assert (
            build["phases"][0]["coverage"]["covered"] == 3 and build["phases"][0]["coverage_agrees"] is True
        )
        assert build["next"]["do"] == "run"
    finally:
        rt.close()
        fake.stop()


SPEC_FIVE = """# Phase 5: ship

## Acceptance checks

| ID | Command | What it proves |
|----|---------|----------------|
| P5.01-P5.03 | `tools/spec.sh 5 presets` | At least 12 presets in four categories, each clean |
| P5.04 | `tools/render-demos.sh && tools/spec.sh 5 demos` | The demo renders sound as specified |
| P5.05 | `tools/install.sh --dest build/install-test && tools/spec.sh 5 install` | The installer puts the bundles in place |
"""


def test_a_step_that_is_exactly_a_join_of_spec_commands_runs_each_of_them(tmp_path: Path) -> None:
    """The lead's rule in full: a step runs a spec check when its command is exactly the check's command, or exactly
    a ` && ` join of spec commands (as roko-exact's count has it). A join with anything else in it runs none of
    them. Phase 5's own commands hold ` && ` (`tools/render-demos.sh && tools/spec.sh 5 demos`), so a join is read
    as whole spec commands, and its table's id range (`P5.01-P5.03`) is one check."""
    specs = tmp_path / "docs" / "specs"
    specs.mkdir(parents=True)
    (specs / "phase-2-rumble.md").write_text(SPEC_TWO)
    (specs / "phase-5-ship.md").write_text(SPEC_FIVE)
    _plan_file(
        tmp_path,
        "p2-joined",
        "tools/spec.sh 2 lfo 'P2.01*' && tools/spec.sh 2 lfo 'P2.02*'",
        "tools/spec.sh 2 rumble 'P2.04*' && grep -q 'Duck' core/src/rumble.h",
    )
    assert buildview.coverage(tmp_path, "docs/specs/phase-2-rumble.md", "p2-joined") == {
        "total": 3,
        "covered": 2,
        "missing": ["P2.04"],
    }
    _plan_file(
        tmp_path,
        "p5-ship",
        "tools/spec.sh 5 presets && tools/render-demos.sh && tools/spec.sh 5 demos",
        "tools/spec.sh 5 install",
    )
    assert buildview.coverage(tmp_path, "docs/specs/phase-5-ship.md", "p5-ship") == {
        "total": 3,
        "covered": 2,
        "missing": ["P5.05"],
    }


def test_a_stopped_phase_whose_tasks_ran_out_of_rungs_says_so_before_the_resume(tmp_path: Path) -> None:
    """Phase 2's run (82b7e069) stopped with T2 and T3 out of rungs, and NEXT offered only the resume. roko's own
    advice for such a task is to split or replan it: the run log keeps which tasks ran out (from the run's card),
    and NEXT names them."""
    (tmp_path / "docs" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "specs" / "phase-2-rumble.md").write_text(SPEC_TWO)
    _plan_file(
        tmp_path,
        "p2-undertow-rumble-4",
        "tools/spec.sh 2 lfo 'P2.01*'",
        "tools/spec.sh 2 lfo 'P2.02*'",
        "tools/spec.sh 2 rumble 'P2.04*'",
    )
    fake = FakeRoko().start()
    fake.add_plan("p2-undertow-rumble-4", "P2 · Undertow rumble", [{"id": f"T{n}"} for n in (1, 2, 3, 4)])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        _logged(rt, "r-2", "plan", "P2 · Undertow rumble", plan_id="p2-undertow-rumble-4")
        out = {
            "attempt": 4,
            "rung": "strong",
            "model": "gpt-5.4-mini",
            "suggestion": "Split the task, or replan it.",
        }
        card = {
            "state": "failed",
            "kind": "plan",
            "tasks": [
                {"task_id": "T1", "outcome": "passed", "exhausted": None},
                {"task_id": "T2", "outcome": "failed", "exhausted": out},
                {"task_id": "T3", "outcome": "failed", "exhausted": out},
                {"task_id": "T4", "outcome": "blocked", "exhausted": None},
            ],
        }
        views._remember(rt, "r-2", card)
        assert rt.runs.get("r-2")["exhausted"] == ["T2", "T3"]
        build = buildview.build_view(rt)
        assert build["phases"][0]["exhausted"] == ["T2", "T3"]
        assert build["next"]["do"] == "resume" and build["next"]["exhausted"] == ["T2", "T3"]
        # A resume that passed them leaves nothing to name.
        views._remember(rt, "r-2", {**card, "tasks": card["tasks"][:1]})
        assert rt.runs.get("r-2")["exhausted"] == []
        assert "exhausted" not in buildview.build_view(rt)["next"]
    finally:
        rt.close()
        fake.stop()


EXACT = ("tools/spec.sh 2 lfo 'P2.01*'", "tools/spec.sh 2 lfo 'P2.02*'", "tools/spec.sh 2 rumble 'P2.04*'")
# Phase 3's runs, as the pilot's run log has them: the first run, then its resume, which the log has no end for.
FIRST_RUN = {"started_at": "2026-10-20T23:10:51Z", "finished_at": "2026-10-21T00:04:48.702Z"}
RESUME_STARTED = "2026-10-21T00:17:14Z"


def _stamp_plan(workdir: Path, plan_id: str, when: str) -> None:
    at = rundata._parse(when)
    assert at is not None
    os.utime(workdir / "plans" / plan_id / "tasks.toml", (at.timestamp(), at.timestamp()))


def test_a_plan_written_after_the_phases_last_run_and_never_run_is_what_next_runs(tmp_path: Path) -> None:
    """hermes-pilot P-44: P3's resume failed, and its newer plan was written, checked and rehearsed, yet NEXT said
    "then resume p3-undertow-hypnotic-sequencer (one of 2)". A plan of the phase written after its latest run and
    never run is the one NEXT runs, fresh. That rests on the plans' data, not on a "-2" in a name."""
    (tmp_path / "docs" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "specs" / "phase-2-rumble.md").write_text(SPEC_TWO)
    _plan_file(tmp_path, "p2-undertow-rumble", *EXACT)
    _plan_file(tmp_path, "p2-rumble-replanned", *EXACT)
    _stamp_plan(tmp_path, "p2-undertow-rumble", "2026-10-20T22:59:00Z")
    _stamp_plan(tmp_path, "p2-rumble-replanned", "2026-10-21T01:38:30Z")
    fake = FakeRoko().start()
    fake.add_plan("p2-undertow-rumble", "P2 · Undertow rumble", [{"id": "T1"}, {"id": "T2"}, {"id": "T3"}])
    fake.add_plan("p2-rumble-replanned", "P2 · Undertow rumble", [{"id": "T1"}, {"id": "T2"}, {"id": "T3"}])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        _logged(
            rt, "r-1", "plan", "P2 · Undertow rumble", plan_id="p2-undertow-rumble", state="failed",
            cost_usd=0.5, cost_final=True, checked=True, **FIRST_RUN,
        )  # fmt: skip
        build = buildview.build_view(rt)
        [phase] = build["phases"]
        # The pad stays the phase's history: its run stopped, on the plan it ran.
        assert (phase["state"], phase["plan_id"]) == ("stopped", "p2-undertow-rumble")
        assert build["next"] == {
            "n": 2, "do": "run", "plan_id": "p2-rumble-replanned", "covered": 3, "total": 3, "plans": 2,
            "newest": True,
        }  # fmt: skip
        # Written before the run started, the other plan is not the answer to it: resume the one that stopped.
        _stamp_plan(tmp_path, "p2-rumble-replanned", "2026-10-20T23:00:00Z")
        assert buildview.build_view(rt)["next"]["do"] == "resume"
        # Nor is a plan roko ran already (tasks done in its row: a run from outside Hermes).
        _stamp_plan(tmp_path, "p2-rumble-replanned", "2026-10-21T01:38:30Z")
        fake.plans["p2-rumble-replanned"]["tasks_done"] = 1
        assert buildview.build_view(rt)["next"]["do"] == "resume"
    finally:
        rt.close()
        fake.stop()


def test_a_phases_time_adds_up_all_its_runs(tmp_path: Path) -> None:
    """hermes-pilot P-44: P3 read 53m 58s, its first run alone: the run log had no end for its resume, whose card
    roko's manifest gave none. roko's summary says when a run ended: the build asks it once for a run the log has
    no end for, and the card reads it there too."""
    _specs(tmp_path)
    fake = FakeRoko().start()
    fake.add_plan("p3-undertow-sequencer", "P3 · Undertow sequencer", [{"id": "T1"}, {"id": "T2"}])
    fake.runs["r-2"] = Run(
        run_id="r-2", kind="plan", states=["failed"], plan_id="p3-undertow-sequencer",
        finished_at="2026-10-21T00:21:57.607Z",
    )  # fmt: skip
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        _logged(
            rt, "r-1", "plan", "P3 · Undertow sequencer", plan_id="p3-undertow-sequencer", state="failed",
            cost_final=True, checked=True, **FIRST_RUN,
        )  # fmt: skip
        _logged(
            rt, "r-2", "plan", "P3 · Undertow sequencer", plan_id="p3-undertow-sequencer", state="failed",
            cost_final=True, checked=True, started_at=RESUME_STARTED,
        )  # fmt: skip
        phase = next(p for p in buildview.build_view(rt)["phases"] if p["n"] == 3)
        first = 53 * 60_000 + 57_702  # 23:10:51 to 00:04:48.702
        assert phase["runs"] == 2 and phase["wall_ms"] == first + 4 * 60_000 + 43_607
        assert rt.runs.get("r-2")["finished_at"] == "2026-10-21T00:21:57.607Z"
        # Asked once: a run roko has no end for either is not asked again.
        _logged(
            rt, "r-3", "plan", "P3 · Undertow sequencer", plan_id="p3-undertow-sequencer", state="failed",
            started_at="2026-10-21T00:30:00Z",
        )  # fmt: skip
        buildview.build_view(rt)
        assert rt.runs.get("r-3").get("end_checked") is True and not rt.runs.get("r-3").get("finished_at")
    finally:
        rt.close()
        fake.stop()


def test_a_cards_end_is_rokos_summarys_when_the_manifest_has_none() -> None:
    tracker = rundata.RunTracker("r-2")
    summary = {"state": "failed", "finished_at": "2026-10-21T00:21:57.607Z"}
    card = rundata._compose(tracker, "r-2", "failed", summary, {"kind": "plan"})
    assert card["finished_at"] == "2026-10-21T00:21:57.607Z"
    assert rundata._compose(tracker, "r-2", "running", summary, {"kind": "plan"})["finished_at"] is None


SPEC_FOUR = "# Phase 4: the phosphor editor\n\n**Goal**: an editor that shows the voice.\n\n## Scope\n"
SPEC_FOUR_ONE = "# Phase 4.1: bone only for the one number\n\n**Goal**: one bone number.\n\n## Scope\n"
PLAN_FOUR = "p4-undertow-phosphor-editor"


def _git(workdir: Path, *argv: str) -> None:
    import subprocess

    command = ["git", "-C", str(workdir), "-c", "user.name=t", "-c", "user.email=t@example.invalid", *argv]
    subprocess.run(command, check=True, capture_output=True)


def test_a_stopped_phase_whose_plan_branch_is_on_main_was_merged_by_hand(tmp_path: Path) -> None:
    """hermes-pilot P-50 (plan B): phase 4's run c4fa953f was cancelled after its plan check, and Undertow's main was
    fast-forwarded by hand to the plan's branch, then moved on. NEXT offered a resume that would do nothing: the
    phase is built, merged by hand, and NEXT moves on to phase 4.1."""
    specs = tmp_path / "docs" / "specs"
    specs.mkdir(parents=True)
    (specs / "phase-4-ui.md").write_text(SPEC_FOUR)
    (specs / "phase-4.1-bone.md").write_text(SPEC_FOUR_ONE)
    _git(tmp_path, "init", "-q", "-b", "main")
    _git(tmp_path, "commit", "-q", "--allow-empty", "-m", "base")
    _git(tmp_path, "checkout", "-q", "-b", f"roko/plan/{PLAN_FOUR}")
    _git(tmp_path, "commit", "-q", "--allow-empty", "-m", "T1 to T7, accepted")
    _git(tmp_path, "checkout", "-q", "main")
    fake = FakeRoko().start()
    fake.add_plan(PLAN_FOUR, "P4 · Undertow phosphor editor", [{"id": f"T{n}"} for n in range(1, 8)])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        progress = {"total": 7, "passed": 5, "stopped": 1, "unverified": 1}
        _logged(rt, "c4fa953f", "plan", "P4 · Undertow phosphor editor", plan_id=PLAN_FOUR, state="cancelled")
        rt.runs.update("c4fa953f", progress=progress)
        # Before main has its plan branch: stopped, and a resume is what moves it.
        build = buildview.build_view(rt)
        assert (build["phases"][0]["state"], build["next"]["do"]) == ("stopped", "resume")
        # Fast-forwarded by hand to the plan's branch, then moved on (04f86ab).
        _git(tmp_path, "merge", "-q", "--ff-only", f"roko/plan/{PLAN_FOUR}")
        _git(tmp_path, "commit", "-q", "--allow-empty", "-m", "04f86ab")
        build = buildview.build_view(rt)
        four = build["phases"][0]
        assert (four["state"], four["ended"]) == ("merged", "run cancelled")
        assert build["next"]["n"] == 4.1 and build["next"]["do"] == "write"
        assert build["totals"]["passed"] == 1  # built, as the header counts it
    finally:
        rt.close()
        fake.stop()


def test_the_builds_ladder_line_counts_the_landed_work_by_the_rung_it_passed_on(tmp_path: Path) -> None:
    """The lead's wow 3: one line under the receipt, from roko's own records of the runs whose work landed (each
    passed phase's passing run, and a phase merged by hand): the tasks by the rung they passed on, how many passed
    on their first try, and the climbs. Nothing it does not count: no "never needed", no rung that passed none."""
    _specs(tmp_path)
    fake = FakeRoko().start()
    fake.add_plan("p0-undertow-foundation", "P0 · Undertow foundation", [{"id": f"T{n}"} for n in (1, 2, 3)])
    fake.add_plan("p1-undertow-voice", "P1 · Undertow voice", [{"id": f"T{n}"} for n in range(1, 6)])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))

    def rungs(**passed: int) -> list[dict[str, Any]]:
        return [
            {"rung": rung, "passed": passed.get(rung, 0), "running": 0, "failed": 0}
            for rung in ("cheap", "mid", "strong", "top")
        ]

    try:
        _logged(
            rt, "r-0", "plan", "P0 · Undertow foundation", plan_id="p0-undertow-foundation", state="succeeded"
        )
        rt.runs.update(
            "r-0", rungs=rungs(mid=3), learning={"tasks": 3, "passed": 3, "first_try": 3, "climbs": 0}
        )
        _logged(rt, "r-1", "plan", "P1 · Undertow voice", plan_id="p1-undertow-voice", state="succeeded")
        rt.runs.update(
            "r-1",
            rungs=rungs(mid=4, strong=1),
            learning={"tasks": 5, "passed": 5, "first_try": 4, "climbs": 1},
            started_at="2026-10-20T11:00:00Z",
        )
        # An earlier run of the phase that did not pass is not landed work.
        _logged(rt, "r-1a", "plan", "P1 · Undertow voice", plan_id="p1-undertow-voice", state="failed")
        rt.runs.update(
            "r-1a",
            rungs=rungs(strong=2),
            learning={"tasks": 2, "passed": 2, "first_try": 0, "climbs": 2},
            started_at="2026-10-20T10:00:00Z",
        )
        build = buildview.build_view(rt)
        assert (
            build["ladder_line"]
            == "landed work by the rung it passed on: mid 7, strong 1 · 7 of 8 passed on the first try · 1 climb"
        )
    finally:
        rt.close()
        fake.stop()
    # No passed phase, no line.
    assert buildview.ladder_line([]) is None


def test_the_receipt_in_words_says_the_build_against_the_top_rung_as_the_pages_did() -> None:
    """Option 1 (the lead, for room in plugin.js): the pages' buildReceiptWords, moved here so both pages show the
    backend's words as they are: the phases built so far on the top rung against all roko spent, "× more" when roko
    spent more, and the passing runs whose receipt is still to read."""
    words = buildview.receipt_words
    whole = {"phases": 4, "cost_usd": 2.0, "top_rung": "claude-sonnet-4-6", "top_rung_usd": 6.0, "ratio": 3.0}
    assert (
        words({**whole, "missing": 0}, 4)
        == "the whole build on claude-sonnet-4-6 ≈ $6.00 · roko spent $2.00: 3× less"
    )
    some = {"phases": 2, "cost_usd": 2.1, "top_rung": "claude-sonnet-4-6", "top_rung_usd": 5.69, "ratio": 2.7}
    assert (
        words({**some, "missing": 1}, 4)
        == "2 phases built so far on claude-sonnet-4-6 ≈ $5.69 · roko spent $2.10: 2.7× less · 1 run still to read"
    )
    more = {"phases": 1, "cost_usd": 3.0, "top_rung": "gpt-5.4", "top_rung_usd": 1.2, "ratio": 0.4}
    assert words({**more, "missing": 2}, 6) == (
        "1 phase built so far on gpt-5.4 ≈ $1.20 · roko spent $3.00: 2.5× more · 2 runs still to read"
    )
    # No receipt read yet: what it waits on, else nothing.
    unread = {"phases": 0, "cost_usd": 0.5, "top_rung": None, "top_rung_usd": None, "ratio": None}
    assert words({**unread, "missing": 2}, 4) == "reading 2 runs for the build's receipt…"
    assert words({**unread, "missing": 0}, 4) is None


def test_the_builds_chart_is_cost_per_verified_task_and_first_try_rate_by_phase(tmp_path: Path) -> None:
    """The lead's wow 2, under its honesty rules: two plain series by phase from roko's records, labelled "cost per
    verified task, by phase" and "first-try rate, by phase", with no trend claimed in words. A phase's cost is its
    whole spend as its pad has it, failed runs too, over the tasks roko verified; its first-try rate pools all its
    runs' tries, failed runs too, as the Learning tab counts them. Only built phases are in it; a series needs two."""
    _specs(tmp_path)
    fake = FakeRoko().start()
    fake.add_plan("p0-undertow-foundation", "P0 · Undertow foundation", [{"id": f"T{n}"} for n in (1, 2, 3)])
    fake.plans["p0-undertow-foundation"]["tasks_done"] = 3
    fake.add_plan("p1-undertow-voice", "P1 · Undertow voice", [{"id": f"T{n}"} for n in range(1, 6)])
    fake.plans["p1-undertow-voice"]["tasks_done"] = 5
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        _logged(rt, "r-0", "plan", "P0", plan_id="p0-undertow-foundation", state="succeeded", cost_usd=0.9)
        rt.runs.update(
            "r-0", learning={"tasks": 3, "passed": 3, "first_try": 3}, started_at="2026-10-20T09:00:00Z"
        )
        # P0's failed run counts: its spend in the cost, its tries in the rate.
        _logged(rt, "r-0a", "plan", "P0", plan_id="p0-undertow-foundation", state="failed", cost_usd=0.3)
        rt.runs.update(
            "r-0a", learning={"tasks": 1, "passed": 0, "first_try": 0}, started_at="2026-10-20T08:00:00Z"
        )
        _logged(rt, "r-1", "plan", "P1", plan_id="p1-undertow-voice", state="succeeded", cost_usd=1.0)
        rt.runs.update(
            "r-1", learning={"tasks": 5, "passed": 5, "first_try": 4}, started_at="2026-10-20T11:00:00Z"
        )
        build = buildview.build_view(rt)
    finally:
        rt.close()
        fake.stop()
    assert build["chart"] == [
        {
            "label": "cost per verified task, by phase",
            "values": [0.4, 0.2],
            "range": "$0.20 to $0.40",
            "words": "each phase's whole spend, failed runs and plan writing too, over the tasks roko verified: "
            "P0 $0.40 · P1 $0.20",
            "tone": "bone",
        },
        {
            "label": "first-try rate, by phase",
            "values": [0.75, 0.8],
            "range": "75% to 80%",
            "words": "of the tasks each phase's runs tried, failed runs too, those whose first try passed: "
            "P0 3 of 4 · P1 4 of 5",
            "tone": "pass",
        },
    ]
    # One built phase is no series; a phase not built is never in one.
    one = [{"code": "P0", "cost_usd": 1.2, "verified": 3, "first": 3, "tried": 4}]
    assert buildview.build_chart(one) is None
    assert (
        buildview.build_chart([*one, {"code": "P1", "cost_usd": None, "verified": 0, "first": 0, "tried": 0}])
        is None
    )


def test_a_phase_whose_run_roko_refused_with_every_rung_skipped_says_what_works_next(tmp_path: Path) -> None:
    """The lead after P-52's pin (b3cbd33): the Build tab's NEXT said "resume P2" for a run roko refused because
    every rung of its ladder is skipped, a resume that would be refused again unless every rung failed on billing.
    The run log keeps the refusal from the run's card (`all_skipped`), and NEXT's words come from the backend."""
    (tmp_path / "docs" / "specs").mkdir(parents=True)
    (tmp_path / "docs" / "specs" / "phase-2-rumble.md").write_text(SPEC_TWO)
    _plan_file(tmp_path, "p2-undertow-rumble-4", *EXACT)
    fake = FakeRoko().start()
    fake.add_plan("p2-undertow-rumble-4", "P2 · Undertow rumble", [{"id": f"T{n}"} for n in (1, 2, 3)])
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    lapse = 1_793_046_780_000
    skips = [
        {"rung": "cheap", "provider": "cerebras", "billing": True},
        {"rung": "mid", "provider": "zai", "billing": True},
    ]
    card = {
        "state": "failed",
        "kind": "plan",
        "tasks": [],
        "rungs_skipped": skips,
        "why": {"summary": "roko refused it", "all_rungs_skipped": True, "billing_only": True},
    }
    try:
        _logged(rt, "r-2", "plan", "P2 · Undertow rumble", plan_id="p2-undertow-rumble-4")
        views._remember(rt, "r-2", card)
        assert rt.runs.get("r-2")["all_skipped"] == {
            "billing_only": True,
            "providers": "cerebras and zai",
            "lapse_ms": None,
        }
        step = buildview.build_view(rt)["next"]
        assert step["do"] == "resume" and step["run_id"] == "r-2"
        assert step["words"] == (
            "P2's run was refused: every rung was skipped because its provider could not bill: recharge cerebras and "
            "zai, then resume it"
        )
        # A rung skipped for another reason: no resume now.
        other = [skips[0], {"rung": "mid", "provider": "openai", "billing": False, "until_ms": lapse}]
        views._remember(
            rt, "r-2", {**card, "rungs_skipped": other, "why": {**card["why"], "billing_only": False}}
        )
        when = time.strftime("%H:%M", time.localtime(lapse / 1000))
        assert buildview.build_view(rt)["next"]["words"] == (
            "P2's run was refused: every rung is skipped, and a resume now is refused again until roko's probe "
            f"verdict lapses (the first at {when}) or its model's entry leaves .roko/learn/rung-probes.json"
        )
        # A run roko refused otherwise keeps NEXT's own words.
        views._remember(rt, "r-2", {**card, "why": {"summary": "x", "all_rungs_skipped": False}})
        assert rt.runs.get("r-2")["all_skipped"] is False
        assert "words" not in buildview.build_view(rt)["next"]
    finally:
        rt.close()
        fake.stop()

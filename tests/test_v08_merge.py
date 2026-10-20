"""0.8.0 (round v7): what joins plugin-wow's pages to roko-aa's 0.7.0 projects."""

from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path

import pytest
from fake_roko import FakeRoko
from test_v07_projects import runtime, two, web  # noqa: F401  (fixtures)

from hermes_plugin_roko.runtime import Runtime


def test_a_project_the_page_shows_with_a_tilde_comes_back_as_itself(
    two: tuple[Path, FakeRoko, Path, FakeRoko],  # noqa: F811
    runtime: Callable[..., Runtime],  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Every path a page shows is home-relative (the lead's rule): the switcher sends the `~/…` it was shown
    back as `?project=`, and gets the same project."""
    alpha, _fake_alpha, beta, fake_beta = two
    monkeypatch.setenv("HOME", str(alpha.parent))
    fake_beta.add_plan("only-in-beta", "Beta's plan")
    rt = runtime({"workdir": str(alpha)})
    rt.projects.add(str(beta))
    with web(rt) as client:
        listed = client.get("/api/plugins/roko/projects").json()
        assert listed["default"] == "~/alpha"
        assert [row["path"] for row in listed["projects"]] == ["~/alpha", "~/beta"]
        for shown in ("~/alpha", "~/beta"):
            overview = client.get(f"/api/plugins/roko/overview?project={shown}").json()
            assert overview["ok"] is True and overview["project"]["path"] == shown
        plans = client.get("/api/plugins/roko/plans?project=~/beta").json()["plans"]
        assert [plan["id"] for plan in plans] == ["only-in-beta"]
        answer = client.post("/api/plugins/roko/projects", json={"action": "set_default", "path": "~/beta"})
        chosen = answer.json()
        assert chosen["default"] == "~/beta"


# -- hermes-pilot P-9: the run log mixes workspaces -----------------------------------------------------------------


def _old(rt: Runtime, run_id: str, kind: str, label: str, **fields: object) -> None:
    """A run logged an hour ago; without `project` and `url`, as 0.6.0 logged every run."""
    rt.runs.add(run_id, kind, label, **fields)  # type: ignore[arg-type]
    rt.runs.update(run_id, started_at="2026-10-19T10:46:03Z")


def test_a_plan_writing_in_another_project_is_read_from_its_own_serve(
    two: tuple[Path, FakeRoko, Path, FakeRoko],  # noqa: F811
    runtime: Callable[..., Runtime],  # noqa: F811
) -> None:
    """P-9: the pilot's run list showed a plan writing from another workspace's serve as "planning failed": the
    serve the page used did not know it. Since 0.7.0 a run is read from the serve of the project it ran in."""
    from hermes_plugin_roko import views

    alpha, fake_alpha, beta, fake_beta = two
    fake_beta.run_script = ["running"]
    rt = runtime({"workdir": str(alpha)})
    rt.projects.add(str(beta))
    writing = fake_beta._new_run("plan_generate:baseline", plan_id="baseline")
    rt.runs.add(writing.run_id, "plan_generate", "A baseline plan", plan_id="baseline", project=str(beta))
    rt.runs.update(writing.run_id, url=fake_beta.url, started_at="2026-10-19T10:46:03Z")
    row = next(row for row in views.ui_overview(rt)["runs"] if row["run_id"] == writing.run_id)
    assert row["state"] == "running" and row["note"] is None
    assert not [r for r in fake_alpha.requests if writing.run_id in r["path"] + json.dumps(r.get("body"))]


def test_a_run_from_before_projects_is_read_from_the_default_project_on_any_page(
    two: tuple[Path, FakeRoko, Path, FakeRoko],  # noqa: F811
    runtime: Callable[..., Runtime],  # noqa: F811
) -> None:
    """A run logged before 0.7.0 belongs to the default project (`Runtime.for_run`), but the overview of another
    project's page read it from that project's serve, which never had it: "roko has no record of this run"."""
    from hermes_plugin_roko import views

    alpha, fake_alpha, beta, fake_beta = two
    fake_alpha.run_script = ["running"]
    rt = runtime({"workdir": str(alpha)})
    rt.projects.add(str(beta))
    going = fake_alpha._new_run("plan", plan_id="p0")
    _old(rt, going.run_id, "plan", "P0 · Undertow foundation", plan_id="p0", state="running")
    row = next(row for row in views.ui_overview(rt.scoped(beta))["runs"] if row["run_id"] == going.run_id)
    assert row["state"] == "running" and row["note"] is None, row
    assert row["project"] == {"path": str(alpha), "name": "alpha"}
    assert not [r for r in fake_beta.requests if going.run_id in r["path"] + json.dumps(r.get("body"))]

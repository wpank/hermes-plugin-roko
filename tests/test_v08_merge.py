"""0.8.0 (round v7): what joins plugin-wow's pages to roko-aa's 0.7.0 projects."""

from __future__ import annotations

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

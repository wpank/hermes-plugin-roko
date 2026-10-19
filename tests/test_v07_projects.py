"""0.7.0: the projects Hermes uses roko in, each with its own roko serve.

`projects.v1` keeps them (seeded from the `workdir` setting); every route about one project takes `project`;
a run remembers its project and its roko serve's URL, and a single run's routes go to that serve. Two FakeRoko
servers play two projects' serves here, found through the serve.json each project holds.
"""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeContext, git_checkout
from fake_roko import FakeRoko

from hermes_plugin_roko import projects, tools, views
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.runtime import Runtime


def serve_json(project: Path, fake: FakeRoko) -> None:
    """The serve.json the project's roko serve writes (this test's process plays its pid)."""
    runtime = project / ".roko" / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "serve.json").write_text(
        json.dumps({"pid": os.getpid(), "url": fake.url, "workdir": str(project)})
    )


@pytest.fixture
def two(tmp_path: Path) -> Iterator[tuple[Path, FakeRoko, Path, FakeRoko]]:
    """Two projects, each with its own (fake) roko serve; the first is the `workdir` setting."""
    fakes = [FakeRoko().start(), FakeRoko().start()]
    first, second = git_checkout(tmp_path / "alpha"), git_checkout(tmp_path / "beta")
    for project, fake in ((first, fakes[0]), (second, fakes[1])):
        (project / "roko.toml").write_text("[serve.mcp]\nallow_without_data_llm = true\n")
        serve_json(project, fake)
    try:
        yield first, fakes[0], second, fakes[1]
    finally:
        for fake in fakes:
            fake.stop()


def web(rt: Runtime) -> Any:
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from hermes_plugin_roko import ui_api

    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: rt), prefix="/api/plugins/roko")
    return TestClient(app)


@pytest.fixture
def runtime() -> Iterator[Callable[..., Runtime]]:
    made: list[Runtime] = []

    def make(settings: dict[str, Any] | None = None) -> Runtime:
        rt = Runtime(FakeContext(settings or {}))
        made.append(rt)
        return rt

    try:
        yield make
    finally:
        for rt in made:
            rt.close()


# -- projects.v1 -----------------------------------------------------------------------------------------


def test_the_workdir_setting_is_the_default_project_without_writing(
    tmp_path: Path, runtime: Callable[..., Runtime]
) -> None:
    project = git_checkout(tmp_path / "alpha")
    rt = runtime({"workdir": str(project)})
    assert rt.projects.default() == project and rt.projects.paths() == [project]
    assert rt.settings().workdir == project
    assert (
        isinstance(rt.ctx, FakeContext) and "projects.v1" not in rt.ctx.state.data
    )  # reading writes nothing
    rt.projects.touch(project)
    stored = rt.ctx.state.data["projects.v1"]
    assert stored["default"] == str(project) and stored["workdir_setting"] == str(project)
    assert stored["items"][str(project)]["last_used"]


def test_adding_needs_a_git_checkout_and_names_projects_apart(
    tmp_path: Path, runtime: Callable[..., Runtime], monkeypatch: pytest.MonkeyPatch
) -> None:
    rt = runtime({})
    plain = tmp_path / "plain"
    plain.mkdir()
    with pytest.raises(RokoError) as refused:
        rt.projects.add(str(plain))
    assert refused.value.code is Code.INVALID and "not a git checkout" in refused.value.message
    with pytest.raises(RokoError) as relative:
        rt.projects.add("alpha")
    assert "not an absolute path" in relative.value.message
    hermes = Path(os.environ["HERMES_HOME"])
    git_checkout(hermes / "inside")
    with pytest.raises(RokoError) as inside:
        rt.projects.add(str(hermes / "inside"))
    assert "inside Hermes' own folder" in inside.value.message
    one = git_checkout(tmp_path / "a" / "proj")
    two = git_checkout(tmp_path / "b" / "proj")
    (one / "src").mkdir()
    assert rt.projects.add(str(one / "src")) == one  # a folder in a checkout: the checkout
    assert rt.projects.add(str(two)) == two
    assert rt.projects.default() == one  # the first one added
    assert [rt.projects.name(one), rt.projects.name(two)] == ["a/proj", "b/proj"]
    nested = git_checkout(tmp_path / "mono")
    (nested / "tools").mkdir()
    (nested / "tools" / "roko.toml").write_text("")
    assert rt.projects.add(str(nested / "tools")) == nested / "tools"  # its own roko.toml: that folder


def test_default_and_remove(tmp_path: Path, runtime: Callable[..., Runtime]) -> None:
    rt = runtime({})
    first, second, third = (git_checkout(tmp_path / name) for name in ("first", "second", "third"))
    for path in (first, second, third):
        rt.projects.add(str(path))
    rt.projects.touch(third)
    assert rt.projects.set_default(str(second)) == second
    assert rt.projects.paths() == [second, third, first]  # the default, then the most recently used
    rt.projects.remove(str(second))
    assert rt.projects.default() == third and second not in rt.projects.paths()
    with pytest.raises(RokoError):
        rt.projects.remove(str(second))


def test_a_changed_workdir_setting_is_the_default_again(
    tmp_path: Path, runtime: Callable[..., Runtime]
) -> None:
    first, second, third = (git_checkout(tmp_path / name) for name in ("first", "second", "third"))
    rt = runtime({"workdir": str(first)})
    rt.projects.set_default(str(second))
    assert rt.projects.default() == second  # the page's choice sticks while the setting stays
    assert isinstance(rt.ctx, FakeContext)
    rt.ctx.settings["workdir"] = str(third)
    assert rt.projects.default() == third
    assert set(rt.projects.paths()) == {first, second, third}


def test_find_by_path_or_name(tmp_path: Path, runtime: Callable[..., Runtime]) -> None:
    rt = runtime({})
    project = git_checkout(tmp_path / "pocket-synth")
    rt.projects.add(str(project))
    assert rt.projects.find(str(project)) == project
    assert rt.projects.find("pocket-synth") == project and rt.projects.find("POCKET-SYNTH") == project
    assert rt.projects.find("nope") is None and rt.projects.find("/no/such/dir") is None


def test_check_folder_refuses_what_is_no_project(tmp_path: Path) -> None:
    with pytest.raises(RokoError):
        projects.check_folder(str(tmp_path / "missing"))
    with pytest.raises(RokoError):
        projects.check_folder(42)


# -- the routes ----------------------------------------------------------------------------------------------


def test_get_and_post_projects(tmp_path: Path, runtime: Callable[..., Runtime]) -> None:
    ready = git_checkout(tmp_path / "ready")
    (ready / "roko.toml").write_text("")
    fresh = git_checkout(tmp_path / "fresh")
    plain = tmp_path / "plain"
    plain.mkdir()
    rt = runtime({"workdir": str(ready)})
    with web(rt) as client:
        listed = client.get("/api/plugins/roko/projects").json()
        assert listed["ok"] is True and listed["default"] == str(ready)
        [row] = listed["projects"]
        assert row["path"] == str(ready) and row["default"] is True and row["ready"] is True
        assert row["needs_setup"] is False and row["serve"]["state"] in ("stopped", "not_found", "failed")
        added = client.post("/api/plugins/roko/projects", json={"action": "add", "path": str(fresh)}).json()
        assert added["ok"] is True and added["project"]["path"] == str(fresh)
        assert added["project"]["needs_setup"] is True and added["project"]["ready"] is False
        assert [p["path"] for p in added["projects"]] == [str(ready), str(fresh)]
        bad = client.post("/api/plugins/roko/projects", json={"action": "add", "path": str(plain)}).json()
        assert bad["ok"] is False and bad["error"]["code"] == "invalid" and bad["error"]["hint"]
        chosen = client.post(
            "/api/plugins/roko/projects", json={"action": "set_default", "path": str(fresh)}
        ).json()
        assert chosen["default"] == str(fresh) and chosen["projects"][0]["path"] == str(fresh)
        gone = client.post("/api/plugins/roko/projects", json={"action": "remove", "path": str(fresh)}).json()
        assert gone["default"] == str(ready) and [p["path"] for p in gone["projects"]] == [str(ready)]
        assert (
            client.post("/api/plugins/roko/projects", json={"action": "x", "path": "/"}).json()["error"][
                "code"
            ]
            == "invalid"
        )
        assert isinstance(rt.ctx, FakeContext)
        rt.ctx.settings["ui_actions"] = False
        locked = client.post("/api/plugins/roko/projects", json={"action": "add", "path": str(fresh)}).json()
        assert locked["error"]["code"] == "forbidden"


def test_each_route_answers_about_the_project_it_names(
    two: tuple[Path, FakeRoko, Path, FakeRoko], runtime: Callable[..., Runtime]
) -> None:
    alpha, fake_alpha, beta, fake_beta = two
    fake_alpha.add_plan("only-in-alpha", "Alpha's plan")
    fake_beta.add_plan("only-in-beta", "Beta's plan")
    rt = runtime({"workdir": str(alpha)})
    rt.projects.add(str(beta))
    with web(rt) as client:

        def get(path: str) -> dict[str, Any]:
            got: dict[str, Any] = client.get("/api/plugins/roko" + path).json()
            return got

        assert [plan["id"] for plan in get("/plans")["plans"]] == ["only-in-alpha"]
        assert [plan["id"] for plan in get(f"/plans?project={beta}")["plans"]] == ["only-in-beta"]
        assert get(f"/plans/only-in-beta?project={beta}")["plan"]["plan_id"] == "only-in-beta"
        overview = get(f"/overview?project={beta}")
        assert overview["connection"]["url"] == fake_beta.url and overview["project"]["path"] == str(beta)
        assert overview["connection"]["serve"]["state"] == "running"
        assert {row["path"] for row in overview["projects"]} == {str(alpha), str(beta)}
        assert get("/overview")["connection"]["url"] == fake_alpha.url
        assert get("/plans?project=/no/such/project")["error"]["code"] == "invalid"
        assert get(f"/health?project={beta}")["ok"] is True


def test_a_run_remembers_its_project_and_its_routes_follow_it(
    two: tuple[Path, FakeRoko, Path, FakeRoko], runtime: Callable[..., Runtime]
) -> None:
    alpha, fake_alpha, beta, fake_beta = two
    rt = runtime({"workdir": str(alpha)})
    rt.projects.add(str(beta))
    fake_beta.run_script = ["running"]
    with web(rt) as client:
        started = client.post(
            "/api/plugins/roko/runs", json={"prompt": "add a test", "max_usd": 0.5, "project": str(beta)}
        ).json()
        assert started["ok"] is True, started
        run_id = started["run_id"]
        assert started["project"] == {"path": str(beta), "name": "beta"}
        assert run_id in fake_beta.runs and run_id not in fake_alpha.runs
        logged = rt.runs.get(run_id)
        assert logged is not None and logged["project"] == str(beta) and logged["url"] == fake_beta.url
        card = client.get(f"/api/plugins/roko/runs/{run_id}").json()["run"]  # no project named: the run's own
        assert card["run_id"] == run_id and card["project"] == {"path": str(beta), "name": "beta"}
        assert client.get(f"/api/plugins/roko/runs/{run_id}/events").json()["ok"] is True
        row = next(
            row for row in client.get("/api/plugins/roko/overview").json()["runs"] if row["run_id"] == run_id
        )
        assert row["project"] == {"path": str(beta), "name": "beta"}
        cancelled = client.post(f"/api/plugins/roko/runs/{run_id}/cancel", json={}).json()
        assert cancelled["ok"] is True and fake_beta.tool_calls("run_cancel")
        assert not fake_alpha.tool_calls("run_cancel")


def test_a_run_from_before_projects_belongs_to_the_default_project(
    two: tuple[Path, FakeRoko, Path, FakeRoko], runtime: Callable[..., Runtime]
) -> None:
    alpha, fake_alpha, _beta, _fake_beta = two
    rt = runtime({"workdir": str(alpha)})
    old = fake_alpha._new_run("run")
    rt.runs.add(old.run_id, "run", "an old run")  # logged by 0.6.0: no project, no url
    assert rt.for_run(old.run_id).settings().workdir == alpha
    [row] = views.run_rows(rt, rt.runs.recent())
    assert row["project"] == {"path": str(alpha), "name": "alpha"}
    assert views.card(rt, old.run_id)["project"]["path"] == str(alpha)


def test_what_waits_in_another_projects_serve_is_found_and_answered(
    two: tuple[Path, FakeRoko, Path, FakeRoko], runtime: Callable[..., Runtime]
) -> None:
    alpha, _fake_alpha, beta, fake_beta = two
    rt = runtime({"workdir": str(alpha)})
    going = fake_beta._new_run("run")
    going.states = ["running"]
    rt.runs.add(going.run_id, "run", "a run in beta", state="running", project=str(beta), url=fake_beta.url)
    fake_beta.effects.append(
        {"effect_id": "mail-1", "run_id": going.run_id, "tool": "mail.send", "server": "mail"}
    )
    items = views.collect_pending(rt, rt.client())
    [item] = [item for item in items if item["kind"] == "effect"]
    with web(rt) as client:
        answered = client.post(
            "/api/plugins/roko/decide", json={"code": item["code"], "approve": False}
        ).json()
    assert answered["ok"] is True, answered
    assert fake_beta.tool_calls("effect_decide")


def test_the_tools_take_a_project(
    two: tuple[Path, FakeRoko, Path, FakeRoko], runtime: Callable[..., Runtime], approvals: Any
) -> None:
    alpha, _fake_alpha, beta, fake_beta = two
    fake_beta.add_plan("beta-plan", "Beta's plan")
    rt = runtime({"workdir": str(alpha)})
    handlers = tools.make_handlers(rt)

    def tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = json.loads(handlers[name](args, task_id="t", session_id="s"))
        return result

    listed = tool("roko_plans", {"project": str(beta)})  # a path: it becomes a known project
    assert [plan["id"] for plan in listed["plans"]] == ["beta-plan"]
    assert listed["project"] == {"name": "beta", "path": str(beta)}
    assert rt.projects.known(beta)
    assert tool("roko_plans", {"project": "beta"})["project"]["path"] == str(beta)  # by name now
    assert tool("roko_plans", {})["project"]["path"] == str(alpha)  # the default
    recalled = tool("roko_recall", {"query": "parser", "project": "beta"})
    assert recalled["project"]["name"] == "beta" and fake_beta.tool_calls("recall")
    with pytest.raises(RokoError):
        tools.choose_project(rt, {"project": "gamma"})

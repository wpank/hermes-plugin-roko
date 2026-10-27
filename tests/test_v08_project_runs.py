"""0.8.0 (round v7, the pilot's P-51/P-53 windows): runs Hermes did not start, in the project the chat is in.

The pilot's second test project ran on roko-recovery's serve, its runs started over MCP by a harness: the chat's
roko_status of one went to the default project's serve and came back "not found" (P-55); its overview listed the
default project's runs and none of the test project's, so the chat took Undertow's 814a7340 for "my run of the
fails plan" (P-56); and "Run it again." set aside a resumable run with no word (P-57).
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import FakeContext, git_checkout
from fake_roko import FakeRoko

from hermes_plugin_roko import render, tools, views
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.runtime import Runtime


def _serve_json(project: Path, fake: FakeRoko) -> None:
    runtime = project / ".roko" / "runtime"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / "serve.json").write_text(
        json.dumps({"pid": os.getpid(), "url": fake.url, "workdir": str(project)})
    )


@pytest.fixture
def pair(tmp_path: Path) -> Iterator[tuple[Path, FakeRoko, Path, FakeRoko]]:
    """Two projects, each with its own (fake) roko serve; the first is the default (the `workdir` setting)."""
    fakes = [FakeRoko().start(), FakeRoko().start()]
    first, second = git_checkout(tmp_path / "undertow"), git_checkout(tmp_path / "ws")
    for project, fake in ((first, fakes[0]), (second, fakes[1])):
        (project / "roko.toml").write_text("[serve.mcp]\nallow_without_data_llm = true\n")
        _serve_json(project, fake)
    try:
        yield first, fakes[0], second, fakes[1]
    finally:
        for fake in fakes:
            fake.stop()


@pytest.fixture
def runtime() -> Iterator[Callable[..., Runtime]]:
    made: list[Runtime] = []

    def make(settings: dict[str, Any]) -> Runtime:
        made.append(Runtime(FakeContext(settings)))
        return made[-1]

    try:
        yield make
    finally:
        for rt in made:
            rt.close()


def test_p55_status_finds_a_run_hermes_did_not_start_in_the_project_whose_serve_has_it(
    pair: tuple[Path, FakeRoko, Path, FakeRoko], runtime: Callable[..., Runtime], approvals: Any
) -> None:
    undertow, fake_undertow, ws, fake_ws = pair
    rt = runtime({"workdir": str(undertow)})
    rt.projects.touch(ws)
    fake_ws.add_plan("recov", "recov", [{"id": "T1"}, {"id": "T2"}])
    fake_ws.run_script = ["failed"]
    outside = fake_ws._new_run("plan", plan_id="recov", max_usd=1.0)  # started over MCP, not by this Hermes
    status = tools.call(rt, "roko_status", {"run_id": outside.run_id, "wait_secs": 0})
    assert status["state"] == "failed" and status["project"]["path"] == str(ws)
    assert status["kind"] == "plan" and status["plan_id"] == "recov"
    # The chat's own project is asked first: from ws's folder, Undertow's serve is never asked.
    asked = len(fake_undertow.tool_calls("run_status"))
    status = tools.call(rt, "roko_status", {"run_id": outside.run_id, "wait_secs": 0, "project": "ws"})
    assert status["project"]["name"] == "ws" and len(fake_undertow.tool_calls("run_status")) == asked
    # One no serve Hermes knows has: not found, naming the projects searched and those whose serve is down.
    stopped = git_checkout(ws.parent / "gamma")
    (stopped / "roko.toml").write_text("[serve.mcp]\nallow_without_data_llm = true\n")
    rt.projects.touch(stopped)
    with pytest.raises(RokoError) as raised:
        tools.call(rt, "roko_status", {"run_id": "0a7e3e7b-6580-4657-96cb-edc99d0faaf8", "wait_secs": 0})
    assert raised.value.code is Code.NOT_FOUND
    assert "not found in any project Hermes knows: searched undertow and ws" in raised.value.message
    assert "not searched, as their roko serve is not running: gamma" in raised.value.message


def _manifest(
    project: Path, run_id: str, plan_id: str, origin: str | None, *, closed: str | None, later_s: int = 0
) -> None:
    """roko's record of a run in the project (`.roko/runs/<id>/manifest.json`), as roko writes it, started
    `later_s` from now."""
    folder = project / ".roko" / "runs" / run_id
    folder.mkdir(parents=True, exist_ok=True)
    started = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(time.time() + later_s))
    manifest: dict[str, Any] = {
        "schema_version": "roko.run_manifest/1",
        "run_id": run_id,
        "kind": "plan_run",
        "plan_ids": [plan_id],
        "invocations": [{"inv": 1, "started_at": started, "resumed": False}],
        "origin": origin,
    }
    if closed:
        manifest["closed"] = {"ended_at": started, "status": closed}
    (folder / "manifest.json").write_text(json.dumps(manifest))


def test_p56_the_overview_lists_the_projects_own_runs_those_started_outside_hermes_too(
    pair: tuple[Path, FakeRoko, Path, FakeRoko], runtime: Callable[..., Runtime], approvals: Any
) -> None:
    undertow, fake_undertow, ws, fake_ws = pair
    rt = runtime({"workdir": str(undertow)})
    rt.projects.touch(ws)
    # Hermes started one run in each project; the run log holds both.
    for project, fake, plan in ((undertow, fake_undertow, "p5-1"), (ws, fake_ws, "recov")):
        fake.run_script = ["failed"]
        run = fake._new_run("plan", plan_id=plan, max_usd=1.0)
        rt.runs.add(
            run.run_id, "plan", plan, plan_id=plan, state="failed", project=str(project), url=fake.url
        )
        _manifest(project, run.run_id, plan, "mcp:local", closed="failed")
    undertow_run = rt.runs.recent(2)[1]["run_id"]
    # Another client started one in ws over MCP, and roko's CLI another: the run log has neither.
    fake_ws.run_script = ["failed"]
    mcp = fake_ws._new_run("plan", plan_id="fails", max_usd=1.0)
    mcp.cost_usd = 0.451
    _manifest(ws, mcp.run_id, "fails", "mcp:local", closed="failed")
    fake_ws.run_script = ["running"]
    cli = fake_ws._new_run("plan", plan_id="recov", max_usd=1.0)
    _manifest(ws, cli.run_id, "recov", "cli", closed=None)

    view = tools.call(rt, "roko_status", {"project": "ws"})
    lines = "\n".join(view["recent_runs"])
    assert undertow_run not in lines  # Undertow's runs are not this project's (P-53's 814a7340)
    assert len(view["recent_runs"]) == 3
    by_id = {line.split(" · ")[0]: line for line in view["recent_runs"]}
    assert "failed · $0.45 · plan · plan fails" in by_id[mcp.run_id]
    assert "not started from this Hermes (another client over MCP)" in by_id[mcp.run_id]
    assert "running" in by_id[cli.run_id] and "not started from this Hermes (roko's CLI)" in by_id[cli.run_id]
    assert "not started from this Hermes" not in by_id[rt.runs.recent(1)[0]["run_id"]]
    # The answer says whose runs these are, and to keep to this project unless asked about another.
    assert view["about"].startswith("ws's runs, ")
    assert "unless the person asks about another" in view["about"]

    # `/roko status` says whose runs they are, and who started the others.
    text = render.overview(views.overview(rt.scoped(ws)))
    assert "Recent runs in ws:" in text and "not from Hermes: roko's CLI" in text

    # Without project, the chat's (here the default's): Undertow's runs only.
    view = tools.call(rt, "roko_status", {})
    assert [line.split(" · ")[0] for line in view["recent_runs"]] == [undertow_run]


def test_p56_the_overview_still_answers_when_roko_or_its_records_say_no_more(
    pair: tuple[Path, FakeRoko, Path, FakeRoko],
    runtime: Callable[..., Runtime],
    approvals: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _undertow, _fake, ws, fake_ws = pair
    rt = runtime({"workdir": str(ws)})
    fake_ws.run_script = ["failed"]
    mine = fake_ws._new_run("plan", plan_id="recov", max_usd=1.0)
    rt.runs.add(
        mine.run_id, "plan", "recov", plan_id="recov", state="failed", project=str(ws), url=fake_ws.url
    )
    # A folder whose manifest does not parse, one with none, and a run from roko's CLI.
    runs = ws / ".roko" / "runs"
    (runs / "broken").mkdir(parents=True)
    (runs / "broken" / "manifest.json").write_text("{")
    (runs / "empty").mkdir()
    cli = fake_ws._new_run("plan", plan_id="fails", max_usd=1.0)
    _manifest(ws, cli.run_id, "fails", "cli", closed="failed", later_s=60)
    # roko too slow to say more: the CLI run keeps what its manifest says.
    monkeypatch.setattr(views, "OUTSIDE_BUDGET_S", -1.0)
    lines = tools.call(rt, "roko_status", {})["recent_runs"]
    assert [line.split(" · ")[0] for line in lines] == [cli.run_id, mine.run_id]
    assert lines[0].startswith(f"{cli.run_id} · failed · plan · plan fails")
    assert "not started from this Hermes (roko's CLI)" in lines[0]
    # The records unreadable: the runs Hermes started answer on their own.
    monkeypatch.setattr(views.rundata, "other_runs", lambda *_: (_ for _ in ()).throw(OSError("gone")))
    lines = tools.call(rt, "roko_status", {})["recent_runs"]
    assert [line.split(" · ")[0] for line in lines] == [mine.run_id]

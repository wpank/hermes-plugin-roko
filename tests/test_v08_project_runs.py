"""0.8.0 (round v7, the pilot's P-51/P-53 windows): runs Hermes did not start, in the project the chat is in.

The pilot's second test project ran on roko-recovery's serve, its runs started over MCP by a harness: the chat's
roko_status of one went to the default project's serve and came back "not found" (P-55); its overview listed the
default project's runs and none of the test project's, so the chat took Undertow's 814a7340 for "my run of the
fails plan" (P-56); and "Run it again." set aside a resumable run with no word (P-57).
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

from hermes_plugin_roko import tools
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

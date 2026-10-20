"""0.8.0 (round v7, P-8): a plan's title goes to roko as its title, never as its request's first words.

`title` was described to the model as a run's name in the person's lists, so asked to title a plan, the model
wrote the title into the request instead: "Title: P0 · Undertow foundation" on its first line, then "Set the plan
title to …". The plugin named the plan from the request's first line, and roko made its id from that: twice
`title-p0-…`, then `set-the-plan-title-…`. The tool now says what the title is for, and a title the request states
is taken as the plan's title.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import catalog, ui_api
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call


class TitledRoko(FakeRoko):
    """roko since gap-c2efe7: `plan_generate` takes a `title`, and makes the plan's id from it."""

    def __post_init__(self) -> None:
        super().__post_init__()
        self.tool_args = {"plan_generate": ["prompt", "spec_path", "title"]}


@pytest.fixture
def titled() -> Iterator[TitledRoko]:
    server = TitledRoko().start()
    try:
        yield server
    finally:
        server.stop()


@pytest.mark.parametrize(
    ("prompt", "title"),
    [
        # The pilot's two: the title on the request's first line, and a sentence that sets it.
        (
            "Title: P0 · Undertow foundation\n\nBuild the CMake project, the core library and a plugin skeleton.",
            "P0 · Undertow foundation",
        ),
        (
            'Set the plan title to "P0 · Undertow foundation". Build the CMake project and the core library.',
            "P0 · Undertow foundation",
        ),
        (
            "Plan title: “P1 · The voice”\nWrite the oscillator, the filter and the envelope.",
            "P1 · The voice",
        ),
        # The Build tab's old request, which ended with its title.
        (
            "Write the plan for phase 2 from docs/specs/phase-2-rumble.md: each acceptance check in the spec becomes "
            'a task\'s verify step. Title the plan "P2 · Rumble and modulation".',
            "P2 · Rumble and modulation",
        ),
        # No title in it: the request's first sentence, as before.
        (
            "Add a --json flag to the balance command. Keep the output stable.",
            "Add a --json flag to the balance command",
        ),
        ('Add a "Title: …" header to the report. Keep it short.', 'Add a "Title: …" header to the report'),
    ],
)
def test_a_title_the_request_states_is_the_plans_title(
    titled: TitledRoko, approvals: Approvals, prompt: str, title: str
) -> None:
    rt = Runtime(FakeContext({"url": titled.url}))
    try:
        started = call(rt, "roko_plan_generate", {"prompt": prompt})
        [sent] = titled.tool_calls("plan_generate")
        assert sent["title"] == title and sent["prompt"] == prompt
        assert rt.runs.get(started["run_id"])["label"] == title
        assert started["title"] == title
    finally:
        rt.close()


def test_a_title_given_as_title_wins_and_the_page_reads_the_request_the_same_way(
    titled: TitledRoko, approvals: Approvals
) -> None:
    rt = Runtime(FakeContext({"url": titled.url}))
    try:
        call(
            rt,
            "roko_plan_generate",
            {"prompt": "Title: P0 · Old\n\nBuild it.", "title": "P0 · Undertow foundation"},
        )
        ui_api.start_run(
            rt, {"prompt": "Title: P3 · The hypnotic sequencer\n\nA 16-step sequencer.", "plan": True}
        )
        titles = [args["title"] for args in titled.tool_calls("plan_generate")]
        assert titles == ["P0 · Undertow foundation", "P3 · The hypnotic sequencer"]
    finally:
        rt.close()


def test_the_tool_says_the_title_is_the_plans_and_never_goes_in_the_request() -> None:
    schemas = catalog.tool_schemas(5.0)
    title = schemas["roko_plan_generate"]["parameters"]["properties"]["title"]["description"]
    assert "plan's title" in title and "never in prompt" in title
    # A run's title is still its name in the person's lists.
    assert "run lists" in schemas["roko_run"]["parameters"]["properties"]["title"]["description"]

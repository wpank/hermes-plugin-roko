"""0.8.0 (round v7, P-6): a plan written from a spec file in the project, which roko reads exactly.

Asked naturally, the chat model sent roko a summary of a spec, or copied a 14 KB spec by hand and mangled its
tables (every row of phase 2's checks arrived as `|| …`), so roko's spec check had nothing to keep. roko serve
since gap-fe4225 (1ae6cab88) takes a `spec_path` in the workspace and reads the file itself; an older roko gets
the file's exact text from the plugin, as roko would have read it.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import buildview, catalog, rundata, ui_api
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

SPEC = """# Phase 2: rumble and modulation

**Goal**: the hypnotic part of the sound.

## Acceptance checks

| ID | Command | What it proves |
|----|---------|----------------|
| P2.01 | `tools/spec.sh 2 lfo 'P2.01*'` | The rate choices are the right cycle lengths |
"""
PATH = "docs/specs/phase-2-rumble.md"


class SpecRoko(FakeRoko):
    """roko since gap-fe4225: `plan_generate` declares `spec_path` (and a `title`)."""

    def __post_init__(self) -> None:
        super().__post_init__()
        self.tool_args = {"plan_generate": ["prompt", "spec_path", "title"]}


@pytest.fixture
def project(tmp_path: Path) -> Path:
    folder = tmp_path / "undertow"
    (folder / "docs" / "specs").mkdir(parents=True)
    (folder / PATH).write_text(SPEC)
    (folder / "docs" / "notes.md").write_text("# Notes on the sound\n\nSub, bassline, rumble.\n")
    return folder


@pytest.fixture
def newer() -> Iterator[SpecRoko]:
    server = SpecRoko().start()
    try:
        yield server
    finally:
        server.stop()


def runtime_for(server: FakeRoko, project: Path) -> Runtime:
    return Runtime(FakeContext({"url": server.url, "workdir": str(project)}))


def test_a_plan_from_a_spec_sends_roko_its_path_and_never_its_text(
    newer: SpecRoko, project: Path, approvals: Approvals
) -> None:
    rt = runtime_for(newer, project)
    # Each writing has ended before the next: a second writing of a spec roko still writes is refused (P-65).
    newer.run_script = ["succeeded"]
    try:
        started = call(rt, "roko_plan_generate", {"spec_path": PATH})
        # A phase spec names its plan as the Build tab finds it: "P2 · …".
        assert newer.tool_calls("plan_generate") == [
            {"spec_path": PATH, "title": "P2 · Rumble and modulation"}
        ]
        assert started["spec_path"] == PATH
        assert PATH in approvals.asked[0]["message"]
        logged = rt.runs.get(started["run_id"])
        assert logged["spec_path"] == PATH and logged["label"] == "P2 · Rumble and modulation"
        # What the person adds goes as the prompt; their title wins; the path is the project's own spelling.
        call(
            rt,
            "roko_plan_generate",
            {
                "spec_path": " ./docs/specs/phase-2-rumble.md ",
                "prompt": "Keep T4 small.",
                "title": "P2 · Rumble",
            },
        )
        assert newer.tool_calls("plan_generate")[1] == {
            "spec_path": PATH,
            "prompt": "Keep T4 small.",
            "title": "P2 · Rumble",
        }
        # Another spec is called by its first heading.
        call(rt, "roko_plan_generate", {"spec_path": "docs/notes.md"})
        assert newer.tool_calls("plan_generate")[2]["title"] == "Notes on the sound"
    finally:
        rt.close()


def test_an_older_roko_gets_the_specs_exact_text_from_the_plugin(
    fake: FakeRoko, project: Path, approvals: Approvals
) -> None:
    """Its `plan_generate` takes only a prompt: the plugin reads the file and sends it as roko would have read
    it, with what the person adds after it."""
    rt = runtime_for(fake, project)
    fake.run_script = ["succeeded"]  # the first writing has ended before the second (P-65)
    try:
        call(rt, "roko_plan_generate", {"spec_path": PATH, "prompt": "Keep T4 small."})
        call(rt, "roko_plan_generate", {"spec_path": PATH})
        assert fake.tool_calls("plan_generate") == [
            {"prompt": f"{SPEC}\n\n---\n\nKeep T4 small.\n"},
            {"prompt": SPEC},
        ]
    finally:
        rt.close()


@pytest.mark.parametrize(
    ("spec_path", "why"),
    [
        ("/etc/hosts", "a path relative to the project"),
        ("../outside.md", "inside the project"),
        ("docs/specs/phase-9-missing.md", "is not a file in the project"),
        ("docs/specs", "is not a file in the project"),
        ("docs/specs/huge.md", "larger than 1 MiB"),
    ],
)
def test_a_spec_path_roko_could_not_read_is_refused_before_anything_is_asked(
    newer: SpecRoko, project: Path, approvals: Approvals, spec_path: str, why: str
) -> None:
    (project.parent / "outside.md").write_text("# Not the project's\n")
    (project / "docs" / "specs" / "huge.md").write_text("x" * (1024 * 1024 + 1))
    rt = runtime_for(newer, project)
    try:
        with pytest.raises(RokoError) as refused:
            call(rt, "roko_plan_generate", {"spec_path": spec_path})
        assert refused.value.code is Code.INVALID and why in refused.value.message
        with pytest.raises(RokoError, match="prompt or spec_path"):
            call(rt, "roko_plan_generate", {"prompt": " "})
        assert approvals.asked == [] and newer.tool_calls("plan_generate") == []
    finally:
        rt.close()


def test_the_tool_tells_the_model_to_pass_a_specs_path_and_never_copy_it() -> None:
    schema = catalog.tool_schemas(5.0)["roko_plan_generate"]
    parameters: dict[str, Any] = schema["parameters"]
    assert "spec_path" in parameters["properties"] and "prompt" not in parameters.get("required", [])
    assert "spec_path" in schema["description"] and "never copy" in schema["description"]
    assert "spec_path" in parameters["properties"]["prompt"]["description"]


def test_the_page_writes_a_plan_from_a_spec_and_its_card_says_where_the_checks_come_from(
    newer: SpecRoko, project: Path
) -> None:
    rt = runtime_for(newer, project)
    try:
        started = ui_api.start_run(
            rt, {"plan": True, "spec_path": PATH, "title": "P2 · Rumble and modulation"}
        )
        assert newer.tool_calls("plan_generate") == [
            {"spec_path": PATH, "title": "P2 · Rumble and modulation"}
        ]
        assert rt.runs.get(started["run_id"])["spec_path"] == PATH
        # The Build tab finds the writing's phase by its spec.
        assert buildview._phase_of({**rt.runs.get(started["run_id"]), "label": "a plan", "plan_id": "x"}) == 2
        with pytest.raises(RokoError, match="spec_path is for writing a plan"):
            ui_api.start_run(rt, {"prompt": "go", "max_usd": 0.5, "spec_path": PATH})
        # roko's report of the checks names the spec they come from: the plugin's spec_path, else roko's documents.
        summary = {"state": "succeeded", "result": {"slug": "p2", "source_checks": {"total": 1, "kept": 1}}}
        card = rundata.plan_generation_card(started["run_id"], summary, rt.runs.get(started["run_id"]))
        assert card["source_checks"]["from"] == [PATH]
        named = {"total": 1, "kept": 1, "documents": ["docs/specs/phase-0-foundation.md"]}
        card = rundata.plan_generation_card(
            "w-2", {"state": "succeeded", "result": {"source_checks": named}}, {}
        )
        assert card["source_checks"]["from"] == ["docs/specs/phase-0-foundation.md"]
    finally:
        rt.close()

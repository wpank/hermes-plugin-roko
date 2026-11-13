"""0.7 (round v7, plugin-wow): the pages for a long, multi-plan build, and the pilot's findings, each as the test
that shows it.

- hermes-pilot S-3: in a scratch Hermes home, the "approvals are off" card printed the home's absolute path, so the
  account name showed on every page shot.
- hermes-pilot P-3: the chat model put its plan card line in a code span. The desktop showed it raw, the hook added
  the plan writing's run card under it, and the plan's own card never showed.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any

import pytest

from hermes_plugin_roko import _hermes, cards, readiness
from hermes_plugin_roko.errors import RokoError

# -- S-3: no account name in the setup card's command -----------------------------------------------------------


def test_the_approvals_command_names_a_scratch_home_under_home_with_a_tilde(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(_hermes, "approval_mode", lambda: "off")
    home = Path.home() / "dev" / "scratch world" / "hh"
    monkeypatch.setattr(_hermes, "hermes_home", lambda: home)
    command = readiness.hermes_problems()[0]["fix"]["command"]
    assert str(Path.home()) not in command
    assert command == "HERMES_HOME=~/'dev/scratch world/hh' hermes config set approvals.mode smart"
    # The shell still reads it as the same folder: the tilde before the quoted rest expands.
    assignment = command.split(" hermes ", 1)[0]
    shown = subprocess.run(
        ["/bin/sh", "-c", f'{assignment}; printf %s "$HERMES_HOME"'],
        capture_output=True,
        text=True,
        env={"HOME": str(Path.home()), "PATH": "/usr/bin:/bin"},
        check=True,
    )
    assert shown.stdout == str(home)
    # A home outside the person's keeps its path, as before.
    monkeypatch.setattr(_hermes, "hermes_home", lambda: Path("/Users/Shared/hh"))
    assert readiness.hermes_problems()[0]["fix"]["command"] == (
        "HERMES_HOME=/Users/Shared/hh hermes config set approvals.mode smart"
    )


# -- P-3: a card line in a code span becomes its card ------------------------------------------------------------


def _reply(text: str, session: str, turn: str, platform: str = "desktop") -> Any:
    return cards.transform_llm_output(
        response_text=text, session_id=session, model="m", platform=platform, turn_id=turn
    )


def test_a_card_line_the_model_put_in_a_code_span_becomes_its_card() -> None:
    # The pilot's baseline: the plan's card line in a code span on its own line, and the writing noted as started.
    cards.started("p3-a", "op-1", plan_id="p0-undertow-foundation")
    said = 'The plan is written.\n\n`::roko-plan{id="p0-undertow-foundation"}`\n\nWant me to run it?'
    assert _reply(said, "p3-a", "t1") == (
        'The plan is written.\n\n::roko-plan{id="p0-undertow-foundation"}\n\nWant me to run it?'
    )
    # In a sentence, any quote style or none: the sentence closes up and the card follows it, as the desktop reads it.
    cards.started("p3-a", "op-2", plan_id="p1-dsp")
    assert _reply("Here is the plan `::roko-plan{id=p1-dsp}` for phase one.", "p3-a", "t2") == (
        'Here is the plan for phase one.\n\n::roko-plan{id="p1-dsp"}'
    )
    assert (
        _reply("Waiting: ``::roko-pending{run='r-9'}``", "p3-a", "t3")
        == 'Waiting:\n\n::roko-pending{run="r-9"}'
    )


def test_a_code_span_that_holds_more_than_a_card_line_stays_code() -> None:
    cards.started("p3-b", "run-7")
    # Code that mentions a card line, and a fence, are the model's code: the run still gets its proper line.
    said = 'Run `roko show ::roko-run{id="run-7"}` to see it.'
    assert _reply(said, "p3-b", "t1") == said + '\n\n::roko-run{id="run-7"}'
    fenced = '```\n`::roko-run{id="run-7"}`\n```'
    cards.started("p3-b", "run-7")
    assert _reply(fenced, "p3-b", "t2") == fenced + '\n\n::roko-run{id="run-7"}'
    # Another surface keeps the reply as it is.
    assert _reply('`::roko-run{id="run-7"}`', "p3-b", "t3", platform="tui") is None
    # An id the desktop would refuse stays as written.
    assert _reply('`::roko-run{id="../x"}`', "p3-b", "t4") is None


# -- the lead's rule after S-3: no page shows the person's home ------------------------------------------------


def test_every_answer_and_frame_shows_the_home_as_a_tilde(monkeypatch: pytest.MonkeyPatch) -> None:
    from hermes_plugin_roko import ui_api

    monkeypatch.setenv("HOME", "/Users/tester")
    said = {
        "workdir": "/Users/tester/dev/undertow",
        "review_command": "git -C /Users/tester/dev/undertow diff 1a2b3c..roko/batch/r1",
        "quoted": "git -C '/Users/tester/my synth' merge --ff-only roko/batch/r1",
        "double": 'cd "/Users/tester/my synth" && ctest',
        "line": "/Users/tester/dev/undertow/libs/core/src/RumbleTone.cpp:84:23: error: no member named 'tanhApprox'",
        "home": "/Users/tester",
        "colon": "made in:/Users/tester/dev/undertow",
        "others": ["/Users/testers/x", "/Users/Shared/undertow", "~/dev/undertow"],
        # CMake names an object of a source outside the build tree after its absolute path (the real P0 run's JUCE
        # modules): the home inside such a path goes too.
        "object": "[ 14%] Building CXX object plugin/CMakeFiles/Undertow.dir/Users/tester/Library/JUCE/juce_core.mm.o",
        "number": 1.5,
        "nan": float("nan"),
    }
    body = ui_api.guarded(lambda: None, lambda _rt: dict(said))  # type: ignore[arg-type,return-value]
    assert body["workdir"] == "~/dev/undertow"
    assert body["review_command"] == "git -C ~/dev/undertow diff 1a2b3c..roko/batch/r1"
    assert body["quoted"] == "git -C ~/'my synth' merge --ff-only roko/batch/r1"
    assert body["double"] == 'cd ~/"my synth" && ctest'
    assert body["line"].startswith("~/dev/undertow/libs/core/src/RumbleTone.cpp:84:23: error:")
    assert body["home"] == "~"
    assert body["colon"] == "made in:~/dev/undertow"
    # Another account's folder, a shared one and one already relative stay.
    assert body["others"] == said["others"]
    assert (
        body["object"]
        == "[ 14%] Building CXX object plugin/CMakeFiles/Undertow.dir/~/Library/JUCE/juce_core.mm.o"
    )
    assert body["number"] == 1.5 and body["nan"] is None
    # A socket frame goes through the same walk.
    assert ui_api.for_page({"type": "live", "line": "/Users/tester/dev/x.cpp:1:1: error"})["line"] == (
        "~/dev/x.cpp:1:1: error"
    )


def test_the_roko_command_in_chat_shows_the_home_as_a_tilde(monkeypatch: pytest.MonkeyPatch) -> None:
    import asyncio

    from hermes_plugin_roko import commands

    monkeypatch.setenv("HOME", "/Users/tester")
    monkeypatch.setattr(
        commands, "run_command", lambda _rt, _args: "  review: git -C /Users/tester/dev/undertow diff a..b"
    )
    said = asyncio.run(commands.make_command(None)("status last"))  # type: ignore[arg-type]
    assert said == "  review: git -C ~/dev/undertow diff a..b"


# -- item 1: honest tries on the ladder ---------------------------------------------------------------------------


def _feed(tracker: Any, rows: list[tuple[str, dict[str, Any]]]) -> None:
    for cursor, (kind, event) in enumerate(rows, start=1):
        tracker.fold.feed(
            cursor * 100, kind, {"type": kind, "run_id": "r1", "ts_millis": 1_000 + cursor, **event}
        )


def test_a_try_the_provider_refused_is_not_a_failed_try_on_the_ladder() -> None:
    from hermes_plugin_roko import rundata

    ladder = [
        {"rung": "cheap", "model": "gpt-oss-120b", "slug": "gpt-oss-120b", "starts": ["focused"]},
        {"rung": "mid", "model": "glm-4.7", "slug": "glm-4.7", "starts": []},
    ]
    route = {"plan_id": "p", "task_id": "T1", "model": "gpt-oss-120b", "rung": "cheap", "source": "ladder"}
    settled = {"plan_id": "p", "task_id": "T1", "rung": "cheap", "model": "gpt-oss-120b", "escalations": 0}
    tracker = rundata.RunTracker("r1")
    _feed(
        tracker,
        [
            ("plan_set_loaded", {"plans": [{"plan_id": "p", "tasks_total": 1}]}),
            ("plan_started", {"plan_id": "p", "tasks_total": 1}),
            ("task_started", {"plan_id": "p", "task_id": "T1", "title": "Sine sub oscillator"}),
            (
                "route_decided",
                {**route, "attempt": 1, "provider": "cerebras", "ladder_reason": "start", "stage": "ladder"},
            ),
            ("agent_spawned", {"plan_id": "p", "task_id": "T1", "attempt": 1, "model": "gpt-oss-120b"}),
            # The provider refused it (429): roko charges the try to infra, and it does not count toward a climb.
            (
                "attempt_settled",
                {**settled, "attempt": 1, "reason": "start", "verdict": "provider_error", "blame": "infra"},
            ),
            (
                "route_decided",
                {
                    **route,
                    "attempt": 2,
                    "provider": "openrouter",
                    "ladder_reason": "failover",
                    "stage": "failover",
                },
            ),
            ("agent_spawned", {"plan_id": "p", "task_id": "T1", "attempt": 2, "model": "gpt-oss-120b"}),
            (
                "attempt_settled",
                {**settled, "attempt": 2, "reason": "failover", "verdict": "passed", "blame": "none"},
            ),
            ("task_completed", {"plan_id": "p", "task_id": "T1", "outcome": "passed"}),
        ],
    )
    [cheap, mid] = rundata.rung_counts(tracker.task_rows(), ladder, ended=True) or []
    assert cheap == {"rung": "cheap", "passed": 1, "running": 0, "failed": 0, "refused": 1, "waiting": 0}
    assert mid["failed"] == mid["refused"] == 0


# -- item 8: a long run's history, newest first, then earlier on demand --------------------------------------------


def test_a_long_runs_timeline_opens_on_its_newest_lines_and_pages_back(tmp_path: Path) -> None:
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import ui_api
    from hermes_plugin_roko.runtime import Runtime

    fake = FakeRoko().start()
    rows: list[dict[str, Any]] = [{"type": "plan_set_loaded", "plans": [{"plan_id": "p", "tasks_total": 1}]}]
    rows += [{"type": "plan_started", "plan_id": "p", "tasks_total": 1}]
    rows += [{"type": "task_started", "plan_id": "p", "task_id": "T1", "title": "Build the core"}]
    for n in range(900):  # a long C++ task's gates: 900 readable lines
        rows.append(
            {"type": "gate_rung_started", "plan_id": "p", "task_id": "T1", "rung_name": f"verify[{n}:build]"}
        )
    fake.runs["r-long"] = Run("r-long", "plan", ["running"], plan_id="p", events=rows)
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        newest = ui_api.timeline(rt, "r-long", {"tail": "400"})
        assert len(newest["events"]) == 400 and newest["earlier"] is True
        assert newest["events"][-1]["text"].endswith("verify[899:build]")
        first = newest["events"][0]["cursor"]
        page = ui_api.timeline(rt, "r-long", {"before": str(first), "limit": "200"})
        assert len(page["events"]) == 200 and page["earlier"] is True
        assert page["events"][-1]["cursor"] < first and page["events"][-1]["text"].endswith(
            "verify[499:build]"
        )
        # Paging back to the start gives every line once, as a forward read does, and nothing is earlier than it.
        seen = page["events"] + newest["events"]
        while page["earlier"]:
            page = ui_api.timeline(rt, "r-long", {"before": str(page["events"][0]["cursor"]), "limit": "200"})
            seen = page["events"] + seen
        forward, cursor, more = [], 0, True
        while more:
            got = ui_api.timeline(rt, "r-long", {"cursor": str(cursor), "limit": "200"})
            forward += got["events"]
            cursor, more = got["next_cursor"], got["has_more"]
        assert [e["cursor"] for e in seen] == [e["cursor"] for e in forward] and len(seen) > 900
        with pytest.raises(RokoError):
            ui_api.timeline(rt, "r-long", {"before": "x"})
    finally:
        rt.close()
        fake.stop()


def _long_run(lines: int, *, ended: bool) -> list[dict[str, Any]]:
    """A run whose index is longer than one refresh reads: `lines` readable check lines on T1."""
    rows: list[dict[str, Any]] = [{"type": "plan_set_loaded", "plans": [{"plan_id": "p", "tasks_total": 1}]}]
    rows += [{"type": "plan_started", "plan_id": "p", "tasks_total": 1}]
    rows += [{"type": "task_started", "plan_id": "p", "task_id": "T1", "title": "Build the core"}]
    rows += [
        {"type": "gate_rung_started", "plan_id": "p", "task_id": "T1", "rung_name": f"verify[{n}:build]"}
        for n in range(lines)
    ]
    if ended:
        rows += [{"type": "task_completed", "plan_id": "p", "task_id": "T1", "outcome": "passed"}]
        rows += [{"type": "plan_completed", "plan_id": "p", "success": True}]
        rows += [{"type": "run_completed", "outcome": "succeeded", "duration_ms": 42_000}]
    return [{**row, "run_id": "r-long"} for row in rows]


def test_a_finished_long_runs_card_is_kept_only_once_its_whole_history_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real P0 run's index held 34,633 rows after three tasks (trusted live output: 97% agent words), and
    one refresh reads at most MAX_PAGES pages. A finished run's card was kept as final after the first one, so a
    long run opened cold showed its first 40,000 rows' state for good: T1 running, forever."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import rundata, views
    from hermes_plugin_roko.runtime import Runtime

    monkeypatch.setattr(
        rundata, "MAX_PAGES", 2
    )  # 400 rows a refresh, as 40,000 are for roko's real page size
    fake = FakeRoko().start()
    fake.runs["r-long"] = Run(
        "r-long", "plan", ["succeeded"], plan_id="p", events=_long_run(1_000, ended=True)
    )
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        first = views.card(rt, "r-long")
        assert first["reading"] is True and rt.cards.tracker(fake.url, "r-long").final is None
        cards = [first]
        while cards[-1]["reading"] and len(cards) < 10:
            cards.append(views.card(rt, "r-long"))
        last = cards[-1]
        assert (
            last["reading"] is False and len(cards) == 3
        )  # 1,006 rows: 400 a refresh, the third reads the rest
        assert last["tasks"][0]["outcome"] == "passed" and last["state"] == "succeeded"
        # Now it is final: read once, as before.
        reads = len([r for r in fake.requests if r["path"].endswith("/events")])
        views.card(rt, "r-long")
        assert len([r for r in fake.requests if r["path"].endswith("/events")]) == reads
    finally:
        rt.close()
        fake.stop()


def test_a_long_runs_newest_lines_are_never_a_partial_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`?tail=` read one refresh and answered its lines as the newest: on a long run opened cold, the run's
    first lines, with a cursor the page then followed from. Now it reads on, and while it has not reached the
    end it says so (`reading`, with the rows read) and sends no lines, so the page never shows old ones as new."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import rundata, ui_api
    from hermes_plugin_roko.runtime import Runtime

    monkeypatch.setattr(rundata, "MAX_PAGES", 2)
    monkeypatch.setattr(ui_api, "READ_S", 0.0)  # one refresh a request, as a long real run's would be
    fake = FakeRoko().start()
    fake.runs["r-long"] = Run(
        "r-long", "plan", ["running"], plan_id="p", events=_long_run(1_500, ended=False)
    )
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        answers = [ui_api.timeline(rt, "r-long", {"tail": "400"})]
        assert answers[0]["reading"] is True and answers[0]["events"] == [] and answers[0]["rows_read"] == 400
        while answers[-1]["reading"] and len(answers) < 10:
            answers.append(ui_api.timeline(rt, "r-long", {"tail": "400"}))
        newest = answers[-1]
        assert newest["reading"] is False and len(answers) == 4  # 1,503 rows
        assert len(newest["events"]) == 400 and newest["earlier"] is True
        assert newest["events"][-1]["text"].endswith("verify[1499:build]")
        # With time to read, one request reads it all.
        monkeypatch.setattr(ui_api, "READ_S", 30.0)
        cold = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
        try:
            whole = ui_api.timeline(cold, "r-long", {"tail": "400"})
            assert whole["reading"] is False and whole["events"] == newest["events"]
        finally:
            cold.close()
    finally:
        rt.close()
        fake.stop()


def test_earlier_pages_of_a_long_run_come_from_what_was_read_then_from_where_they_start(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`?before=` read roko's index from its start each time, for at most MAX_PAGES pages: past 40,000 rows (a
    phase at the real P0 rate) it answered lines from the run's start as the ones before the cursor. Now the lines
    the backend read come from it, and older ones from roko, read from the line before them, not from the start."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import rundata, ui_api
    from hermes_plugin_roko.runtime import Runtime

    monkeypatch.setattr(rundata, "MAX_PAGES", 2)
    monkeypatch.setattr(rundata, "MAX_HISTORY", 300)  # the backend keeps the newest 700 lines
    fake = FakeRoko().start()
    fake.runs["r-long"] = Run(
        "r-long", "plan", ["running"], plan_id="p", events=_long_run(1_500, ended=False)
    )
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        newest = ui_api.timeline(rt, "r-long", {"tail": "400"})
        assert newest["reading"] is False and newest["events"][-1]["text"].endswith("verify[1499:build]")
        reads = len([r for r in fake.requests if r["path"].endswith("/events")])
        page = ui_api.timeline(rt, "r-long", {"before": str(newest["events"][0]["cursor"]), "limit": "200"})
        assert [e["text"][-17:] for e in page["events"][:1]] == ["verify[900:build]"] and page[
            "earlier"
        ] is True
        assert len([r for r in fake.requests if r["path"].endswith("/events")]) == reads  # from memory
        seen = page["events"] + newest["events"]
        while page["earlier"]:
            before = len([r for r in fake.requests if r["path"].endswith("/events")])
            page = ui_api.timeline(rt, "r-long", {"before": str(page["events"][0]["cursor"]), "limit": "200"})
            asked = [r for r in fake.requests if r["path"].endswith("/events")][before:]
            if asked:  # older than the backend keeps: read from the line before the page, never from 0
                assert int(asked[0]["query"].get("cursor", "0")) > 0 or page["earlier"] is False
            seen = page["events"] + seen
        forward, cursor, more = [], 0, True
        while more:
            got = ui_api.timeline(rt, "r-long", {"cursor": str(cursor), "limit": "200"})
            forward += got["events"]
            cursor, more = got["next_cursor"], got["has_more"]
        assert [e["cursor"] for e in seen] == [e["cursor"] for e in forward] and len(seen) == 1_503
    finally:
        rt.close()
        fake.stop()


def test_a_tool_call_that_failed_is_a_line_of_its_run() -> None:
    """hermes-pilot P-12: the real P0 run's T3 hit `bash` timeouts ("error: timed out after 60001 ms", a tool
    result) again and again, its key evidence, and no page showed them: a tool's result made no line."""
    import json

    from hermes_plugin_roko import rundata

    def result(output: str) -> dict[str, Any]:
        record = {
            "agent_id": "p/T3",
            "attempt": 2,
            "kind": "tool_result",
            "live": True,
            "payload": {"output": output, "tool_id": "call_1"},
        }
        return {
            "type": "agent_output",
            "plan_id": "p",
            "task_id": "T3",
            "attempt": 2,
            "content": "\x1eroko.stream.v1 " + json.dumps(record),
        }

    line = rundata.timeline_entry(10, "agent_output", result("error: timed out after 60001 ms"))
    assert line is not None and line["tool_error"] == "timed out after 60001 ms" and line["passed"] is False
    assert line["group"] == "error"  # a problem, not one of its tool steps
    assert line["text"] == "Task 3 · tool error: timed out after 60001 ms" and line["attempt"] == 2
    # A result that is the tool's own output is no line, as before.
    assert rundata.timeline_entry(11, "agent_output", result("[100%] Built target undertow_core")) is None


# -- P-10: the line a failed check is known by, from the real P0 run's checks ---------------------------------------

_W = "/Users/someone/dev/undertow/.roko/worktrees/attempt-afa08b39d03a16f8ee04"


@pytest.mark.parametrize(
    ("output", "line"),
    [
        # Try 4: CMake could not read the presets; its last line was a line of JSON it quoted.
        (
            "spec: FAIL spec_p0_plugin: `cmake --preset plugin` failed (full log: build/spec-logs/x.log):\n"
            f"CMake Error: Could not read presets from {_W}:\n"
            'Error: @34,24: Invalid extra field "noTestsAction" in Preset\n'
            '      "noTestsAction": "error"\n'
            "                       ^\n"
            'Error: @33,26: Invalid extra field "outputOnFailure" in Preset\n'
            '      "outputOnFailure": true,\n'
            "✗ exit status 1",
            'CMakePresets.json:34:24: Invalid extra field "noTestsAction" in Preset',
        ),
        # Try 1: an error at a line of CMakeLists.txt, its message indented under it.
        (
            "spec: FAIL spec_p0_plugin: `cmake --preset plugin` failed (full log: build/spec-logs/x.log):\n"
            "CMake Error at CMakeLists.txt:19 (add_subdirectory):\n"
            '  add_subdirectory given source "plugin" which is not an existing directory.\n\n\n'
            "-- Configuring incomplete, errors occurred!\n✗ exit status 1",
            'CMakeLists.txt:19: add_subdirectory given source "plugin" which is not an existing directory.',
        ),
        # Try 3: doctest's first failed assertion, with the line the spec's test logged for exactly this.
        (
            f"{_W}/tests/spec/p0/plugin_test.cpp:147:\n"
            "TEST CASE:  P0.11 processBlock is finite, never allocates\n\n"
            f"{_W}/tests/spec/p0/plugin_test.cpp:183: ERROR: CHECK( allocations == 0 ) is NOT correct!\n"
            "  values: CHECK( 11400 == 0 )\n"
            "  logged: 11400 heap allocations inside processBlock: preallocate the MIDI event array\n\n"
            "[doctest] test cases:   6 |   5 passed | 1 failed | 0 skipped\n[doctest] Status: FAILURE!",
            "tests/spec/p0/plugin_test.cpp:183: CHECK( allocations == 0 ): 11400 heap allocations inside "
            "processBlock: preallocate the MIDI event array",
        ),
        # Try 2: clang's first error, its path from the repository's root, not roko's attempt checkout.
        (
            f"{_W}/plugin/PluginProcessor.cpp:104:53: error: no member named 'has_value' in 'juce::Optional<double>'\n"
            "  104 |             transport.valid = pos->getPpqPosition().has_value();\n✗ exit status 1",
            "plugin/PluginProcessor.cpp:104:53: error: no member named 'has_value' in 'juce::Optional<double>'",
        ),
    ],
)
def test_a_failed_checks_key_line_is_what_it_says_not_a_line_it_quotes(output: str, line: str) -> None:
    """hermes-pilot P-10: the P0 run's "why" quoted `"outputOnFailure": true,`, a line of JSON CMake printed under
    its error, as why T3's check failed."""
    from hermes_plugin_roko import rundata

    assert rundata.key_line(output) == line


def test_a_tasks_try_budget_is_rokos_not_a_guess_from_the_ladder(tmp_path: Path) -> None:
    """hermes-pilot P-11: T3's sheet said "try 4 of up to 6" (the page's guess: 2 tries a rung, 3 rungs) where
    roko's budget was max_retries 3, 4 tries, and the run ended at the 4th. roko writes the budget on each
    attempt-open line of the run's attempts.jsonl."""
    import json

    from hermes_plugin_roko import rundata

    tracker = rundata.RunTracker("r1")
    _feed(
        tracker,
        [
            ("plan_set_loaded", {"plans": [{"plan_id": "p", "tasks_total": 1}]}),
            ("plan_started", {"plan_id": "p", "tasks_total": 1}),
            ("task_started", {"plan_id": "p", "task_id": "T3", "title": "Plugin skeleton"}),
            ("agent_spawned", {"plan_id": "p", "task_id": "T3", "attempt": 1, "model": "glm-4.7"}),
        ],
    )
    # No record yet: the page keeps its estimate.
    assert rundata._task_card(tracker.task_rows()[0])["tries_allowed"] is None
    record = tmp_path / ".roko" / "runs" / "r1" / "attempts.jsonl"
    record.parent.mkdir(parents=True)
    opened = {"schema_version": "roko.attempt_open/1", "plan_id": "p", "task_id": "T3", "attempt": 1}
    record.write_text(json.dumps({**opened, "max_retries": 3, "role": "implementer"}) + "\n")
    tracker.refresh_attempts(tmp_path)
    assert rundata._task_card(tracker.task_rows()[0])["tries_allowed"] == 4


def test_a_long_runs_try_records_reach_the_tasks_read_after_its_first_card(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real P0 run read with every row (an older roko): its first card read 10,000 rows, before T3 started, and
    the run's attempts.jsonl was marked read then. T3's try budget and its check's exit code and time, which only
    the record has, never reached its card, while a read with `?skip=` (one card) had them."""
    import json

    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import rundata, views
    from hermes_plugin_roko.runtime import Runtime

    monkeypatch.setattr(rundata, "MAX_PAGES", 2)
    fake = FakeRoko(skip_names=None).start()
    rows = _long_run(1_000, ended=False)
    rows += [
        {"type": "task_started", "plan_id": "p", "task_id": "T2", "title": "Plugin skeleton"},
        {"type": "agent_spawned", "plan_id": "p", "task_id": "T2", "attempt": 1, "model": "glm-4.7"},
    ]
    fake.runs["r-long"] = Run(
        "r-long", "plan", ["running"], plan_id="p", events=[{**row, "run_id": "r-long"} for row in rows]
    )
    record = tmp_path / ".roko" / "runs" / "r-long" / "attempts.jsonl"
    record.parent.mkdir(parents=True)
    opened = {"schema_version": "roko.attempt_open/1", "plan_id": "p", "attempt": 1}
    record.write_text(
        "".join(
            json.dumps({**opened, "task_id": task, "max_retries": retries}) + "\n"
            for task, retries in (("T1", 1), ("T2", 3))
        )
    )
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        cards = [views.card(rt, "r-long")]
        assert cards[0]["reading"] is True and [t["task_id"] for t in cards[0]["tasks"]] == ["T1"]
        while cards[-1]["reading"] and len(cards) < 10:
            cards.append(views.card(rt, "r-long"))
        tries = {task["task_id"]: task["tries_allowed"] for task in cards[-1]["tasks"]}
        assert cards[-1]["reading"] is False and tries == {"T1": 2, "T2": 4}
    finally:
        rt.close()
        fake.stop()


# -- item 5: chat polish -------------------------------------------------------------------------------------------


def test_a_price_the_model_put_in_a_code_span_is_a_price_again() -> None:
    """v6 dogfood and round v7: gpt-5.4-mini wrote a run's spend as `\\$0.04` of `\\$0.25`, in code spans, which the
    price fix skipped. The desktop also escapes every currency `$` in a reply before rendering, inside code spans
    too (Hermes' markdown-preprocess), so even `$3.00` in a span reads `\\$3.00`. A span that is only a price becomes
    the price as text; code keeps its span (`echo \\$1`)."""
    run = "6988f0b8-4199-4abf-9cfc-67713bc60e34"
    text = (
        "It spent `\\$0.04` of its `\\$0.25 cap`, under `$3.00`; the hook was `echo \\$1`.\n\n"
        f'::roko-run{{id="{run}"}}'
    )
    out = cards.transform_llm_output(response_text=text, session_id="s1", platform="desktop", turn_id="t1")
    assert (
        out is not None and "It spent $0.04 of its $0.25 cap, under $3.00; the hook was `echo \\$1`." in out
    )


def test_the_desktop_prompt_asks_for_the_card_before_the_next_tool_call() -> None:
    """The run card arrived only with the model's last reply: a chat that waits on roko_status for minutes showed
    no card meanwhile. The desktop's prompt asks for it at once; the section still fits with a workspace named."""
    from conftest import FakeContext

    from hermes_plugin_roko import prompt
    from hermes_plugin_roko.runtime import Runtime

    with_workdir = Runtime(FakeContext({"workdir": "/Users/someone/dev/undertow"}))
    try:
        desktop = prompt.make_render(with_workdir)({"platform": "desktop"})
        assert "before your next tool call" in desktop and "/Users/someone/dev/undertow" in desktop
        assert len(desktop) <= prompt.MAX_CHARS
        assert "before your next tool call" not in prompt.make_render(with_workdir)({"platform": "telegram"})
    finally:
        with_workdir.close()


def test_the_merge_dialogs_workspace_and_command_reach_the_page_as_a_tilde(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """hermes-pilot P-15: on 0.6.0 the desktop's merge confirm printed "in /Users/<name>/dev/undertow". It prints the
    card's `delivered.workspace` as given, and every card reaches the page through the backend's boundary
    (`for_page`, REST and socket alike), which writes the home as `~`."""
    import json

    from hermes_plugin_roko import ui_api

    monkeypatch.setenv("HOME", "/Users/tester")
    card = {
        "run": {
            "delivered": {
                "workspace": "/Users/tester/dev/undertow",
                "branch": "roko/batch/r1",
                "merged": False,
            },
            "merge_command": "git -C /Users/tester/dev/undertow merge --ff-only roko/batch/r1",
        }
    }
    body = ui_api.guarded(lambda: None, lambda _rt: card)  # type: ignore[arg-type,return-value]
    assert body["run"]["delivered"]["workspace"] == "~/dev/undertow"
    assert body["run"]["merge_command"] == "git -C ~/dev/undertow merge --ff-only roko/batch/r1"
    assert "/Users/tester" not in json.dumps(body)
    frame = ui_api.for_page({"type": "run", "run": card["run"]})
    assert frame["run"]["delivered"]["workspace"] == "~/dev/undertow"


def test_a_long_runs_totals_are_rokos_while_its_history_is_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """hermes-pilot P-17: the real phase-1 run (165,638 index rows, 69 MB of agent words) read
    "succeeded · gates 4/4 · tasks 1/3 · $0.02" for good on 0.6.0, and the list row "1/5 · $0.02", while roko's own
    summary said 5 of 5 and $1.02. Until the backend has read the run to its end, its spend and task counts are
    roko's (its summary skips the words), the headline says it is reading, and no receipt is printed from half a run.
    """
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import rundata, views
    from hermes_plugin_roko.runtime import Runtime

    monkeypatch.setattr(rundata, "MAX_PAGES", 2)
    fake = FakeRoko().start()
    rows = _long_run(1_000, ended=True)
    spent = {"type": "efficiency_event", "plan_id": "p", "task_id": "T1", "metric": "cost_usd", "value": 0.02}
    rows.insert(3, spent)
    fake.runs["r-long"] = Run("r-long", "plan", ["succeeded"], plan_id="p", events=rows)
    fake.runs["r-long"].cost_usd = 1.0204
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        first = views.card(rt, "r-long")
        assert first["reading"] is True
        assert first["cost_usd"] == 1.0204 and first["progress"]["passed"] == first["progress"]["total"] == 1
        assert "reading its history" in first["headline"] and "$1.02" in first["headline"]
        assert first["receipt"] is None
        # The run list's row says the same.
        rt.runs.add("r-long", "plan", "Long run")
        rt.runs.update("r-long", state="running")
        client = rt.client()
        row = rundata.quick_totals(client, rt.cards, "r-long", rundata.run_status(client, "r-long"))
        assert row["cost_usd"] == 1.0204
        cards = [first]
        while cards[-1]["reading"] and len(cards) < 10:
            cards.append(views.card(rt, "r-long"))
        last = cards[-1]
        assert last["reading"] is False and "reading" not in last["headline"] and last["receipt"] is not None
    finally:
        rt.close()
        fake.stop()


# -- item 8 with roko gap-cb9044: a long run's history without its agents' words -------------------------------------


def _worded_run(words: int, *, ended: bool) -> list[dict[str, Any]]:
    """A run as roko's trusted live output writes it: agent words almost all of it (96% of the real P0 index, 99% of
    phase 1's), a tool step every 100 words, a heartbeat every 50, and while running a build the words wait on."""

    def said(kind: str, payload: dict[str, Any], *, live: bool = True) -> dict[str, Any]:
        record: dict[str, Any] = {
            "kind": kind,
            "plan_id": "p",
            "task_id": "T1",
            "attempt": 1,
            "payload": payload,
        }
        if live:
            record["live"] = True
        content = "\x1eroko.stream.v1 " + json.dumps(record)
        return {"type": "agent_output", "plan_id": "p", "task_id": "T1", "attempt": 1, "content": content}

    beat = {"type": "agent_heartbeat", "plan_id": "p", "task_id": "T1", "elapsed_ms": 1_000}
    rows: list[dict[str, Any]] = [{"type": "plan_set_loaded", "plans": [{"plan_id": "p", "tasks_total": 1}]}]
    rows += [{"type": "plan_started", "plan_id": "p", "tasks_total": 1}]
    rows += [{"type": "task_started", "plan_id": "p", "task_id": "T1", "title": "Build the core"}]
    rows += [{"type": "agent_spawned", "plan_id": "p", "task_id": "T1", "attempt": 1, "model": "glm-4.7"}]
    for n in range(words):
        rows.append(said("text" if n % 3 else "reasoning", {"text": f" w{n}"}))
        if n % 100 == 99:
            rows.append(
                said("tool_start", {"tool": "bash", "tool_id": f"c{n}", "target": f"cmake --build b{n}"})
            )
            rows.append(said("tool_result", {"tool_id": f"c{n}", "output": "built"}))
        if n % 50 == 49:
            rows.append(dict(beat))
    if ended:
        rows.append(said("text", {"text": "Done: the core builds."}, live=False))
        rows += [
            {"type": "gate_rung_started", "plan_id": "p", "task_id": "T1", "rung_name": "verify[0:build]"},
            {
                "type": "gate_result",
                "plan_id": "p",
                "task_id": "T1",
                "gate": "verify[0:build]",
                "passed": True,
            },
            {"type": "task_completed", "plan_id": "p", "task_id": "T1", "outcome": "passed"},
            {"type": "plan_completed", "plan_id": "p", "success": True},
            {"type": "run_completed", "outcome": "succeeded", "duration_ms": 42_000},
        ]
    else:  # a build the agent waits on: no words, a heartbeat every few seconds
        rows.append(
            said("tool_start", {"tool": "bash", "tool_id": "c-last", "target": "cmake --build build"})
        )
        rows += [dict(beat) for _ in range(5)]
    return [
        {**row, "run_id": "r-words", "ts_millis": 1_760_000_000_000 + 10 * n} for n, row in enumerate(rows)
    ]


def _index_reads(fake: Any) -> list[dict[str, str]]:
    return [r.get("query") or {} for r in fake.requests if r["path"].endswith("/events")]


def test_a_long_runs_history_is_read_without_its_agents_words_into_the_same_card(tmp_path: Path) -> None:
    """roko gap-cb9044 (`?skip=live_text`): the real P0 index reads in 6 requests, not 175. While the backend
    reads behind the index's end it leaves the agents' words out, and the card is the one a whole read makes."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import views
    from hermes_plugin_roko.runtime import Runtime

    def card_from(fake: Any) -> dict[str, Any]:
        rows = _worded_run(3_000, ended=True)
        fake.runs["r-words"] = Run("r-words", "plan", ["succeeded"], plan_id="p", events=rows)
        rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
        try:
            return views.card(rt, "r-words")
        finally:
            rt.close()

    # roko as it is, roko 8d02ac126 (its pages do not count what they passed over), and an older roko, which ignores
    # `skip`.
    new, first, old = (
        FakeRoko().start(),
        FakeRoko(counts_skipped=False).start(),
        FakeRoko(skip_names=None).start(),
    )
    try:
        skipped, uncounted, whole = card_from(new), card_from(first), card_from(old)
        assert [q.get("skip") for q in _index_reads(new)] == ["live_text"]  # 130 rows of 3,130: one page
        assert len(_index_reads(old)) == 16
    finally:
        new.stop()
        first.stop()
        old.stop()
    assert skipped["reading"] is False and skipped["state"] == "succeeded"
    assert skipped["tasks"][0]["note"] == "Done: the core builds."
    assert skipped["tasks"][0]["steps"][-1]["target"] == "cmake --build b2999"
    # The same card (but for the fakes' clocks): the rows it passed over count as read.
    assert skipped["events_read"] == whole["events_read"] == 3_130 and uncounted.pop("events_read") == 130
    for card in (skipped, uncounted, whole):
        for clock in ("started_at", "finished_at", "checked_at"):
            card.pop(clock)
    assert skipped == whole and {**uncounted, "events_read": 3_130} == whole


def test_a_running_runs_card_reads_its_backlog_without_words_then_follows_them(tmp_path: Path) -> None:
    """Behind the end the backend leaves the words out but keeps the heartbeats, so when roko last wrote is its
    last heartbeat, not the build's start minutes before (the chat's `quiet_s`). At the end it reads every row, so
    a running task's live words are its newest; words it skipped are never joined to them."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import rundata, views
    from hermes_plugin_roko.runtime import Runtime

    fake = FakeRoko().start()
    rows = _worded_run(3_000, ended=False)
    fake.runs["r-words"] = Run("r-words", "plan", ["running"], plan_id="p", events=rows)
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))

    def words(*said: str, at: int) -> list[dict[str, Any]]:
        return [
            {**rows[5], "content": rows[5]["content"].replace(" w1", text), "ts_millis": at + n}
            for n, text in enumerate(said)
        ]

    try:
        first = views.card(rt, "r-words")
        assert [q.get("skip") for q in _index_reads(fake)] == ["live_text"]
        assert first["last_event_at"] == rundata._iso_ms(rows[-1]["ts_millis"])
        assert first["tasks"][0]["live_text"] is None and first["tasks"][0]["steps"][-1]["target"] == (
            "cmake --build build"
        )
        # At the end: the next read takes every row.
        rows += words(" linking", " the", " plugin", at=rows[-1]["ts_millis"] + 1_000)
        second = views.card(rt, "r-words")
        assert "skip" not in _index_reads(fake)[-1]
        assert second["tasks"][0]["live_text"] == " linking the plugin"
        # Behind again (more than a page since): the words read before the skipped ones are not the newest.
        rows += words(*[f" x{n}" for n in range(500)], at=rows[-1]["ts_millis"] + 1_000)
        third = views.card(rt, "r-words")
        assert [q.get("skip") for q in _index_reads(fake)[-2:]] == [None, "live_text"]
        assert third["tasks"][0]["live_text"] is None
        rows += words(" done", at=rows[-1]["ts_millis"] + 1_000)
        assert views.card(rt, "r-words")["tasks"][0]["live_text"] == " done"
    finally:
        rt.close()
        fake.stop()


def test_the_timelines_own_reads_leave_out_words_and_heartbeats(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The timeline never shows an agent's live words or a heartbeat: its own reads of roko's index (a page
    following on, lines older than the backend keeps) leave both out, and give the lines a whole read gives."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import rundata, ui_api
    from hermes_plugin_roko.runtime import Runtime

    monkeypatch.setattr(rundata, "MAX_TIMELINE", 10)
    monkeypatch.setattr(rundata, "MAX_HISTORY", 10)  # the backend keeps the newest 20 of 40 lines

    def lines_from(fake: Any) -> tuple[list[str], list[str]]:
        fake.runs["r-words"] = Run(
            "r-words", "plan", ["succeeded"], plan_id="p", events=_worded_run(3_000, ended=True)
        )
        rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
        try:
            page = ui_api.timeline(rt, "r-words", {"tail": "10"})
            back = page["events"]
            while page["earlier"]:
                page = ui_api.timeline(rt, "r-words", {"before": str(back[0]["cursor"]), "limit": "8"})
                back = page["events"] + back
            ahead, cursor, more = [], 0, True
            while more:
                got = ui_api.timeline(rt, "r-words", {"cursor": str(cursor), "limit": "200"})
                ahead += got["events"]
                cursor, more = got["next_cursor"], got["has_more"]
            return [e["text"] for e in back], [e["text"] for e in ahead]
        finally:
            rt.close()

    new, old = FakeRoko().start(), FakeRoko(skip_names=None).start()
    try:
        (back, ahead), (back_all, ahead_all) = lines_from(new), lines_from(old)
        skips = [q.get("skip") for q in _index_reads(new)]
        assert set(skips) == {"live_text", "live_text,heartbeats"}  # the backend's, and the timeline's own
        assert skips.count("live_text,heartbeats") >= 2 and len(skips) < len(_index_reads(old)) / 5
    finally:
        new.stop()
        old.stop()
    assert back == ahead == back_all == ahead_all and len(back) == 40
    assert back[4:6] == ["Task 1 · bash cmake --build b99", "Task 1 · bash cmake --build b199"]
    assert back[-6:-4] == ["Task 1 · agent: Done: the core builds.", "Task 1 · checking verify[0:build]"]


def test_a_roko_that_refuses_a_skip_name_is_read_without_it(tmp_path: Path) -> None:
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import ui_api, views
    from hermes_plugin_roko.runtime import Runtime

    fake = FakeRoko(skip_names=("heartbeats",)).start()
    fake.runs["r-words"] = Run(
        "r-words", "plan", ["succeeded"], plan_id="p", events=_worded_run(1_000, ended=True)
    )
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        card = views.card(rt, "r-words")
        assert card["reading"] is False and card["tasks"][0]["outcome"] == "passed"
        skips = [q.get("skip") for q in _index_reads(fake)]
        assert skips[0] == "live_text" and set(skips[1:]) == {None}  # refused once, then every row
        got = ui_api.timeline(rt, "r-words", {"cursor": "0", "limit": "200"})
        assert got["events"] and [q.get("skip") for q in _index_reads(fake)[-2:]] == [
            "live_text,heartbeats",
            None,
        ]
    finally:
        rt.close()
        fake.stop()


# -- P-17, the run log: only what a whole read says is kept as final -------------------------------------------------


def _phase_run(tasks: int, *, cost: float) -> list[dict[str, Any]]:
    """A plan run that passed `tasks` tasks for `cost` in all, as roko's index has it."""
    ids = [f"T{n}" for n in range(1, tasks + 1)]
    rows: list[dict[str, Any]] = [
        {"type": "plan_set_loaded", "plans": [{"plan_id": "p1", "tasks_total": tasks}]}
    ]
    rows += [{"type": "plan_started", "plan_id": "p1", "tasks_total": tasks}]
    for task in ids:
        rows += [
            {"type": "task_started", "plan_id": "p1", "task_id": task, "title": f"Task {task}"},
            {"type": "agent_spawned", "plan_id": "p1", "task_id": task, "attempt": 1, "model": "glm-4.7"},
            {
                "type": "efficiency_event",
                "plan_id": "p1",
                "task_id": task,
                "metric": "cost_usd",
                "value": round(cost / tasks, 6),
            },
            {
                "type": "gate_result",
                "plan_id": "p1",
                "task_id": task,
                "gate": "verify[0:test]",
                "passed": True,
            },
            {"type": "task_completed", "plan_id": "p1", "task_id": task, "outcome": "passed"},
        ]
    rows += [{"type": "plan_completed", "plan_id": "p1", "success": True}]
    rows += [{"type": "run_completed", "outcome": "succeeded", "duration_ms": 4_560_000}]
    return [{**row, "run_id": "r-p1"} for row in rows]


def test_a_card_read_partway_keeps_nothing_final_in_the_run_log(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A card read partway was remembered as final: `cost_final`, with its ladder, checks and lessons from half a
    run, so the run list never read it again. Now the log keeps roko's totals then, and the rest once the whole
    history is read."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import rundata, views
    from hermes_plugin_roko.runtime import Runtime

    monkeypatch.setattr(rundata, "MAX_PAGES", 2)
    fake = FakeRoko().start()
    fake.runs["r-long"] = Run(
        "r-long", "plan", ["succeeded"], plan_id="p", events=_long_run(1_000, ended=True)
    )
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        rt.runs.add("r-long", "plan", "Long run", plan_id="p", state="running")
        assert views.card(rt, "r-long")["reading"] is True
        logged = rt.runs.get("r-long") or {}
        assert logged["state"] == "succeeded" and logged["progress"]["passed"] == 1
        assert not {"cost_final", "rungs", "learning", "checks", "models"} & set(logged), logged
        for _ in range(5):  # the run list reads it on, a refresh at a time
            views.ui_overview(rt)
            if (rt.runs.get("r-long") or {}).get("cost_final"):
                break
        logged = rt.runs.get("r-long") or {}
        assert (
            logged.get("cost_final") is True
            and logged["progress"]["passed"] == logged["progress"]["total"] == 1
        )
        # Opened again, its card is whole, and so is what the log keeps of it.
        assert views.card(rt, "r-long")["reading"] is False
        assert "learning" in (rt.runs.get("r-long") or {})
    finally:
        rt.close()
        fake.stop()


def test_totals_an_older_plugin_kept_from_a_partial_read_are_checked_once_against_rokos(
    tmp_path: Path,
) -> None:
    """The pilot's run log, written by 0.6.0: the real phase-1 run kept "succeeded, 2 of 5 tasks, $0.28" as final
    (a card read past 40,000 rows only), so its row and every total built on it said so for good, while roko's
    summary said 5 of 5 and $1.02. Each ended run is now checked once against roko's own summary, and read again
    when they disagree."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import views
    from hermes_plugin_roko.runtime import Runtime

    fake = FakeRoko().start()
    fake.runs["r-p1"] = Run("r-p1", "plan", ["succeeded"], plan_id="p1", events=_phase_run(5, cost=1.0204))
    fake.runs["r-p1"].cost_usd, fake.runs["r-p1"].tasks = 1.0204, {"total": 5, "passed": 5, "failed": 0}
    fake.runs["r-ok"] = Run("r-ok", "plan", ["succeeded"], plan_id="p1", events=_phase_run(1, cost=0.25))
    fake.runs["r-ok"].cost_usd = 0.25
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    partial = {"total": 5, "passed": 2, "failed": 0, "running": 1, "pending": 2}
    try:
        for run_id, progress, cost in (
            ("r-ok", {"total": 1, "passed": 1}, 0.25),
            ("r-p1", partial, 0.276086),
        ):
            rt.runs.add(run_id, "plan", "P1 · Undertow voice", plan_id="p1")
            rt.runs.update(run_id, state="succeeded", progress=progress, cost_usd=cost, cost_final=True)
        for _ in range(4):
            views.ui_overview(rt)

        def asked(run_id: str) -> int:
            return len(
                [r for r in fake.requests if r["method"] == "POST" and run_id in json.dumps(r.get("body"))]
            )

        row = rt.runs.get("r-p1") or {}
        assert row["progress"]["passed"] == row["progress"]["total"] == 5 and row["cost_usd"] == 1.0204
        assert row["checked"] is True and row["cost_final"] is True
        assert (rt.runs.get("r-ok") or {})["checked"] is True
        seen = asked("r-p1"), asked("r-ok")
        views.ui_overview(rt)
        assert (asked("r-p1"), asked("r-ok")) == seen  # checked once
    finally:
        rt.close()
        fake.stop()


def test_a_run_kept_with_no_spend_where_roko_reports_some_is_read_again(tmp_path: Path) -> None:
    """hermes-pilot P-23: the cancelled run 5ebd3310 cost $0.025, and the run list said "—": an older plugin kept it
    with no spend, as final. No kept spend where roko reports some is a disagreement too."""
    from conftest import FakeContext
    from fake_roko import FakeRoko, Run

    from hermes_plugin_roko import views
    from hermes_plugin_roko.runtime import Runtime

    fake = FakeRoko().start()
    fake.runs["r-c"] = Run("r-c", "plan", ["cancelled"], plan_id="p1", events=_phase_run(1, cost=0.025315))
    fake.runs["r-c"].cost_usd = 0.025315
    fake.runs["r-c"].tasks = {"total": 1, "passed": 1}  # the counts agree: only the spend is missing
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        rt.runs.add("r-c", "plan", "P0 · Undertow foundation", plan_id="p1")
        rt.runs.update("r-c", state="cancelled", progress={"total": 1, "passed": 1}, cost_final=True)
        for _ in range(3):
            views.ui_overview(rt)
        row = next(row for row in views.ui_overview(rt)["runs"] if row["run_id"] == "r-c")
        assert row["cost_usd"] == pytest.approx(0.025315)
    finally:
        rt.close()
        fake.stop()

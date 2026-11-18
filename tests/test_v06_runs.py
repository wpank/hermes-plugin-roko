"""0.6.0 (round v6): the data behind the Ladder, the climb, the stream and the Receipt.

The workspace's model ladder with its rungs' prices (P1), each task's tries as a climb up that ladder (P2), the
check output a task's checks print (P4), and the receipt of an ended run with what the same work would have cost
on the top rung (P3). Every field is null from an older roko that lacks the data.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import live_relay, loopevents, rundata, views
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

# The ladder and model entries `roko init` wrote in the v5 dogfood workspace (dogfood-desktop's my-project
# roko.toml): four rungs, cheapest first, the top one a Claude CLI agent.
LADDER_TOML = """
[routing.ladder]
enabled = true
roles = []
probe = true

[[routing.ladder.rungs]]
name = "cheap"
model = "gpt-oss-120b"

[[routing.ladder.rungs]]
name = "mid"
model = "glm-4-7"

[[routing.ladder.rungs]]
name = "strong"
model = "gpt-5-4-mini"

[[routing.ladder.rungs]]
name = "top"
model = "claude-sonnet-4-6"

[routing.ladder.start]
mechanical = "cheap"
focused = "cheap"
integrative = "mid"
architectural = "top"

[models.gpt-oss-120b]
provider = "cerebras"
slug = "gpt-oss-120b"
context_window = 128000
max_output = 8192
tool_format = "openai_json"
cost_input_per_m = 0.35
cost_output_per_m = 0.75
cost_cache_read_per_m = 0.35

[models.glm-4-7]
provider = "zai"
slug = "glm-4.7"
context_window = 128000
max_output = 16384
tool_format = "openai_json"
cost_input_per_m = 0.6
cost_output_per_m = 2.2
cost_cache_read_per_m = 0.11

[models.gpt-5-4-mini]
provider = "openai"
slug = "gpt-5.4-mini"
context_window = 200000
max_output = 16384
tool_format = "openai_json"
cost_input_per_m = 0.75
cost_output_per_m = 4.5
cost_cache_read_per_m = 0.075

[models.claude-sonnet-4-6]
provider = "claude_cli"
slug = "claude-sonnet-4-6"
context_window = 200000
tool_format = "anthropic_blocks"
max_tools = 32
"""
# What roko serve's GET /api/models and GET /api/providers say for that workspace (providers.rs: ModelInfo has
# no cache-read rate).
MODELS = [
    {
        "key": "claude-sonnet-4-6",
        "slug": "claude-sonnet-4-6",
        "provider": "claude_cli",
        "context_window": 200000,
    },
    {
        "key": "glm-4-7",
        "slug": "glm-4.7",
        "provider": "zai",
        "cost_input_per_m": 0.6,
        "cost_output_per_m": 2.2,
    },
    {
        "key": "gpt-5-4-mini",
        "slug": "gpt-5.4-mini",
        "provider": "openai",
        "cost_input_per_m": 0.75,
        "cost_output_per_m": 4.5,
    },
    {
        "key": "gpt-oss-120b",
        "slug": "gpt-oss-120b",
        "provider": "cerebras",
        "cost_input_per_m": 0.35,
        "cost_output_per_m": 0.75,
    },
]
PROVIDERS = [
    {"id": "cerebras", "kind": "openai_compat", "has_api_key": True, "model_count": 1},
    {"id": "claude_cli", "kind": "claude_cli", "has_api_key": False, "model_count": 1},
    {"id": "openai", "kind": "openai_compat", "has_api_key": True, "model_count": 1},
    {"id": "zai", "kind": "openai_compat", "has_api_key": True, "model_count": 1},
]
LADDER = [
    {
        "rung": "cheap",
        "model": "gpt-oss-120b",
        "slug": "gpt-oss-120b",
        "provider": "cerebras",
        "price_in": 0.35,
        "price_out": 0.75,
        "price_cache_read": 0.35,
        "priced_by": "roko.toml",
        "price_snapshot": None,
        "chat_ok": True,
        "why_not": None,
        "starts": ["mechanical", "focused"],
    },
    {
        "rung": "mid",
        "model": "glm-4-7",
        "slug": "glm-4.7",
        "provider": "zai",
        "price_in": 0.6,
        "price_out": 2.2,
        "price_cache_read": 0.11,
        "priced_by": "roko.toml",
        "price_snapshot": None,
        "chat_ok": True,
        "why_not": None,
        "starts": ["integrative"],
    },
    {
        "rung": "strong",
        "model": "gpt-5-4-mini",
        "slug": "gpt-5.4-mini",
        "provider": "openai",
        "price_in": 0.75,
        "price_out": 4.5,
        "price_cache_read": 0.075,
        "priced_by": "roko.toml",
        "price_snapshot": None,
        "chat_ok": True,
        "why_not": None,
        "starts": [],
    },
    {
        "rung": "top",
        "model": "claude-sonnet-4-6",
        "slug": "claude-sonnet-4-6",
        "provider": "claude_cli",
        "price_in": None,
        "price_out": None,
        "price_cache_read": None,
        "priced_by": None,
        "price_snapshot": None,
        "chat_ok": False,
        "why_not": "not for chat runs: its agent runs its own tools",
        "starts": ["architectural"],
    },
]


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    path = tmp_path / "ws"
    path.mkdir()
    (path / "roko.toml").write_text(LADDER_TOML)
    return path


@pytest.fixture
def laddered(fake: FakeRoko, workspace: Path) -> Iterator[Runtime]:
    fake.models = [dict(row) for row in MODELS]
    fake.providers = [dict(row) for row in PROVIDERS]
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    try:
        yield runtime
    finally:
        runtime.close()


# -- P1: the workspace's model ladder ----------------------------------------------------------------------


def test_the_overview_and_a_card_carry_the_workspaces_ladder(
    laddered: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    assert views.ui_overview(laddered)["ladder"] == LADDER
    run_id = call(laddered, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
    assert views.card(laddered, run_id)["ladder"] == LADDER


# roko's summary of phase 3's run 7b8cb121 (`rungs[]`): T1 on mid glm-4.7 (two tries), T2 on strong gpt-5.4-mini
# after a failover.
RAN_RUNGS = [
    {
        "rung": "strong",
        "index": 2,
        "model": "gpt-5.4-mini",
        "tries": 1,
        "verified_passes": 1,
        "cost_usd": 0.035439,
    },
    {"rung": "mid", "index": 1, "model": "glm-4.7", "tries": 2, "verified_passes": 1, "cost_usd": 0.665483},
]


def test_an_ended_runs_ladder_is_the_one_it_ran_on_never_todays_roko_toml(
    laddered: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """hermes-pilot P-46: after Undertow's phase 4 routing commit, phase 3's ended page drew today's ladder (mid
    gpt-5.4-mini, strong gpt-5.4) though the run ran mid glm-4.7 and strong gpt-5.4-mini. An ended run's ladder is
    what roko recorded of it (its summary's `rungs[]`), cheapest first, with what each rung spent; a live run's is
    roko.toml's now, and says so."""
    run_id = call(laddered, "roko_run", {"prompt": "x", "max_usd": 0.5})["run_id"]
    fake.runs[run_id].states = ["succeeded"]
    fake.runs[run_id].summary_extra = {"rungs": RAN_RUNGS}
    card = views.card(laddered, run_id)
    assert card["ladder_from"] == "run"
    assert [(r["rung"], r["model"], r["spent_usd"], r["price_in"]) for r in card["ladder"]] == [
        ("mid", "glm-4.7", 0.665483, None),
        ("strong", "gpt-5.4-mini", 0.035439, None),
    ]
    # A run that is still going draws roko.toml as it is now, and says so.
    live = call(laddered, "roko_run", {"prompt": "y", "max_usd": 0.5})["run_id"]
    fake.runs[live].states = ["running"]
    live_card = views.card(laddered, live)
    assert (live_card["ladder_from"], live_card["ladder"]) == ("config", LADDER)
    # An ended run roko recorded no rungs for (an older roko) keeps roko.toml's, said so too.
    fake.runs[run_id].summary_extra = {}
    older = call(laddered, "roko_run", {"prompt": "z", "max_usd": 0.5})["run_id"]
    fake.runs[older].states = ["succeeded"]
    assert views.card(laddered, older)["ladder_from"] == "config"


def test_with_roko_serve_down_the_ladder_still_reads_roko_toml(workspace: Path) -> None:
    ladder = rundata.CardCache().ladder_view(None, workspace)
    assert ladder is not None and [rung["rung"] for rung in ladder] == ["cheap", "mid", "strong", "top"]
    # The workspace's own [models.*] entries: the same rates; the CLI rung is still not for chat runs.
    assert ladder == LADDER


def test_a_roko_that_serves_its_rates_prices_the_top_rung_and_says_where_from(
    laddered: Runtime, fake: FakeRoko
) -> None:
    # roko 7a5dd6046 (gap-a5ebd4): /api/models serves the rates roko prices calls at (its price snapshot first,
    # then the [models.*] profile, then its built-in table), with the cache-read rate and their source. On the
    # pocket-synth ladder the snapshot prices the cheap rung and the built-in table the top one.
    fake.models = [
        {
            **row,
            "cost_input_per_m": 3.0,
            "cost_output_per_m": 15.0,
            "cost_cache_read_per_m": 0.3,
            "priced_by": "builtin",
        }
        if row["key"] == "claude-sonnet-4-6"
        else {**row, "priced_by": "snapshot", "price_snapshot": "prices-2026-09-28"}
        if row["key"] == "gpt-oss-120b"
        else row
        for row in MODELS
    ]
    ladder = rundata.CardCache().ladder_view(laddered.client(), laddered.settings().workdir)
    assert ladder is not None
    cheap, top = ladder[0], ladder[-1]
    assert (top["price_in"], top["price_out"], top["price_cache_read"]) == (3.0, 15.0, 0.3)
    assert (top["priced_by"], top["price_snapshot"]) == ("builtin", None)
    assert (cheap["priced_by"], cheap["price_snapshot"]) == ("snapshot", "prices-2026-09-28")


def test_no_ladder_an_off_ladder_or_no_workspace_is_null(tmp_path: Path, workspace: Path) -> None:
    cache = rundata.CardCache()
    assert cache.ladder_view(None, None) is None
    bare = tmp_path / "bare"
    bare.mkdir()
    (bare / "roko.toml").write_text("[agent]\ndefault_model = 'glm-4-7'\n")
    assert cache.ladder_view(None, bare) is None  # roko's built-in ladder is not guessed
    (workspace / "roko.toml").write_text(LADDER_TOML.replace("enabled = true", "enabled = false"))
    assert rundata.CardCache().ladder_view(None, workspace) is None


def test_a_rung_whose_provider_is_not_set_up_says_why_and_roko_serves_prices_first(
    laddered: Runtime, fake: FakeRoko
) -> None:
    fake.providers = [row for row in PROVIDERS if row["id"] != "zai"]
    fake.models = [
        {**row, "cost_input_per_m": 0.5} if row["key"] == "gpt-oss-120b" else row for row in MODELS
    ]
    ladder = rundata.CardCache().ladder_view(laddered.client(), laddered.settings().workdir)
    assert ladder is not None
    cheap, mid = ladder[0], ladder[1]
    assert cheap["price_in"] == 0.5  # roko's (merged) entry wins over the workspace's own
    assert cheap["priced_by"] == "roko.toml"  # an older roko does not say where its prices come from
    assert (mid["chat_ok"], mid["why_not"]) == (True, "its provider is not set up in this workspace")


def test_a_rungs_model_resolves_as_roko_resolves_it() -> None:
    models = {"glm-4-7": {"slug": "glm-4.7"}, "claude-opus": {"slug": "claude-opus-4-6"}}
    assert rundata.resolve_model("glm-4-7", models) == {"slug": "glm-4.7"}  # by key
    assert rundata.resolve_model("glm-4.7", models) == {"slug": "glm-4.7"}  # by slug
    assert rundata.resolve_model("claude-opus-4", models) == {"slug": "claude-opus-4-6"}  # a slug it starts
    assert rundata.resolve_model("glm-4", models) == {"slug": "glm-4.7"}  # a dot is a separator too
    assert rundata.resolve_model("claude-op", models) is None  # but only at a separator
    assert rundata.resolve_model("o3", {"o3-mini": {"slug": "o3-mini"}}) == {"slug": "o3-mini"}
    assert rundata.resolve_model("o3", {"o3": {"slug": "o3"}, "o3-mini": {"slug": "o3-mini"}}) == {
        "slug": "o3"
    }


# -- P2: each task's tries as a climb up the ladder ------------------------------------------------------------

# tests/fixtures/climb_runs.json: a real climb recorded at no cost from roko 47b3cdd20 (round v6), its ladder three
# fake models on loopback. T1's check fails twice on cheap, roko climbs it to mid and it passes there; T2 passes
# on cheap at its first try. `attempts` is the run's .roko/runs/<run>/attempts.jsonl, as roko wrote it.


def recording(name: str, file: str = "climb_runs.json") -> dict[str, Any]:
    out: dict[str, Any] = {"events": []}
    for line in (Path(__file__).parent / "fixtures" / file).read_text().splitlines():
        part = json.loads(line)
        if part["fixture"] != name:
            continue
        if part["part"] == "event":
            out["events"].append(part["row"])
        elif part["part"] == "meta":
            out["run_id"] = part["run_id"]
        else:
            out[part["part"]] = part[part["part"]]
    return out


CLIMB = recording("live_climb_run")
CLIMB_LADDER = [
    {"rung": "cheap", "model": "fake-cheap", "slug": "fake-cheap"},
    {"rung": "mid", "model": "fake-mid", "slug": "fake-mid"},
    {"rung": "strong", "model": "fake-strong", "slug": "fake-strong"},
]
CLIMB_LADDER_PRICED = [
    {"rung": "cheap", "model": "fake-cheap", "slug": "fake-cheap", "price_in": 0.35, "price_out": 0.75},
    {"rung": "mid", "model": "fake-mid", "slug": "fake-mid", "price_in": 0.6, "price_out": 2.2},
    {"rung": "strong", "model": "fake-strong", "slug": "fake-strong", "price_in": 0.75, "price_out": 4.5},
]
CLIMB_TOML = """
[routing.ladder]
enabled = true

[[routing.ladder.rungs]]
name = "cheap"
model = "fake-cheap"

[[routing.ladder.rungs]]
name = "mid"
model = "fake-mid"

[[routing.ladder.rungs]]
name = "strong"
model = "fake-strong"

[models.fake-cheap]
provider = "fakeapi"
slug = "fake-cheap"
cost_input_per_m = 0.35
cost_output_per_m = 0.75

[models.fake-mid]
provider = "fakeapi"
slug = "fake-mid"
cost_input_per_m = 0.6
cost_output_per_m = 2.2

[models.fake-strong]
provider = "fakeapi"
slug = "fake-strong"
cost_input_per_m = 0.75
cost_output_per_m = 4.5
"""


def climb_tracker(until: Any = None) -> rundata.RunTracker:
    """The recorded run's tracker, its rows folded up to (not including) the first that `until` matches."""
    tracker = rundata.RunTracker(CLIMB["run_id"])
    for row in CLIMB["events"]:
        if until is not None and until(row):
            break
        tracker.fold.feed(row["cursor"], row["type"], row["event"])
    return tracker


def tasks_of(
    tracker: rundata.RunTracker, ladder: Any = CLIMB_LADDER, *, ended: bool = True
) -> list[dict[str, Any]]:
    return [rundata._task_card(task, ladder=ladder, ended=ended) for task in tracker.task_rows()]


def tries(task: dict[str, Any], *keys: str) -> list[tuple[Any, ...]]:
    return [tuple(one[key] for key in keys) for one in task["climb"]]


def write_attempts(workdir: Path, run_id: str) -> Path:
    path = workdir / ".roko" / "runs" / run_id / "attempts.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in CLIMB["attempts"]))
    return path


def test_a_real_climb_reads_from_rokos_events_alone() -> None:
    t1, t2 = tasks_of(climb_tracker())
    assert tries(t1, "attempt", "rung", "model", "reason", "outcome", "failed_check") == [
        (1, "cheap", "fake-cheap", "start", "failed", "verify[0:runs]"),
        (2, "cheap", "fake-cheap", "retry", "failed", "verify[0:runs]"),
        (3, "mid", "fake-mid", "climb", "passed", None),
    ]
    # The line of the check's output that says why, and what roko counted for each try.
    assert t1["climb"][0]["key_line"] == "AssertionError: answer.txt says '41', not 42"
    assert [one["cost_usd"] for one in t1["climb"]] == [0.00144, 0.00144, 0.002688]
    assert all(one["duration_ms"] > 0 and one["started_at"].endswith("Z") for one in t1["climb"])
    assert {(one["source"], one["blame"], one["failover"]) for one in t1["climb"]} == {("events", None, None)}
    # T1 stands on mid with one of its two tries there used; T2 passed on cheap at its first.
    assert t1["lives"] == {"rung": "mid", "used": 1, "of": 2}
    assert tries(t2, "rung", "reason", "outcome") == [("cheap", "start", "passed")]
    assert t2["lives"] == {"rung": "cheap", "used": 1, "of": 2}


def test_rokos_attempt_records_state_each_try(tmp_path: Path) -> None:
    tracker = climb_tracker()
    write_attempts(tmp_path, CLIMB["run_id"])
    tracker.refresh_attempts(tmp_path)
    t1, t2 = tasks_of(tracker)
    assert tries(t1, "rung", "reason", "outcome", "blame", "source") == [
        ("cheap", "start", "failed", "agent", "roko"),
        ("cheap", "retry", "failed", "agent", "roko"),
        ("mid", "climb", "passed", "none", "roko"),
    ]
    # roko's own time for each try (attempt start to settled), and its billed cost.
    assert tries(t1, "duration_ms", "cost_usd") == [(444, 0.00144), (517, 0.00144), (471, 0.002688)]
    assert tries(t2, "rung", "reason", "outcome", "duration_ms") == [("cheap", "start", "passed", 389)]
    # Without a ladder the records still place each try: roko names the rung, and its count of the rungs the
    # task climbed tells the climb.
    t1, _ = tasks_of(tracker, ladder=None)
    assert tries(t1, "rung", "reason") == [("cheap", "start"), ("cheap", "retry"), ("mid", "climb")]
    assert t1["lives"] == {"rung": "mid", "used": 1, "of": 2}


def test_without_a_ladder_or_rokos_records_a_try_has_no_rung() -> None:
    t1, _ = tasks_of(climb_tracker(), ladder=None)
    assert tries(t1, "rung", "reason") == [(None, "start"), (None, "retry"), (None, "retry")]
    assert t1["lives"] is None


def test_the_records_are_read_from_the_runs_own_folder_and_again_only_when_they_change(
    tmp_path: Path,
) -> None:
    tracker = climb_tracker()
    tracker.refresh_attempts(None)
    tracker.refresh_attempts(tmp_path)  # no record yet
    assert {one["source"] for task in tasks_of(tracker) for one in task["climb"]} == {"events"}
    path = write_attempts(tmp_path, CLIMB["run_id"])
    tracker.refresh_attempts(tmp_path)
    stamp = tracker.attempts_stamp
    assert stamp is not None
    tracker.refresh_attempts(tmp_path)
    assert tracker.attempts_stamp == stamp
    path.write_text(path.read_text() + "not json\n")
    tracker.refresh_attempts(tmp_path)
    assert tracker.attempts_stamp != stamp  # read again; the line it cannot read is skipped
    assert rundata.attempts_path(tmp_path, "../elsewhere") is None
    assert rundata.attempts_path(tmp_path, CLIMB["run_id"]) == path


def test_a_try_runs_until_its_check_ends_and_a_failed_check_ends_it() -> None:
    # T1's third try has started on mid (cursor 10901 is its agent): it runs, and its clock is its start.
    [t1] = tasks_of(
        climb_tracker(until=lambda row: row["type"] == "agent_completed" and row["cursor"] > 10_901),
        ended=False,
    )
    assert tries(t1, "reason", "outcome") == [("start", "failed"), ("retry", "failed"), ("climb", "running")]
    assert (t1["climb"][2]["cost_usd"], t1["climb"][2]["duration_ms"]) == (None, None)
    assert t1["climb"][2]["started_at"] and t1["lives"] == {"rung": "mid", "used": 1, "of": 2}
    # Its first try's check failed and roko has not routed the next one yet: that try failed, on cheap.
    [t1] = tasks_of(climb_tracker(until=lambda row: row["cursor"] == 6214), ended=False)
    assert tries(t1, "reason", "outcome") == [("start", "failed")]
    assert t1["lives"] == {"rung": "cheap", "used": 1, "of": 2}
    # The run ended under a try still going (its agent had not finished): it was stopped, not failed.
    [t1] = tasks_of(climb_tracker(until=lambda row: row["cursor"] == 3317), ended=True)
    assert tries(t1, "outcome") == [("stopped",)]


def test_a_failover_is_never_a_climb_and_costs_the_task_no_try() -> None:
    plan, task = "p", "T1"

    def row(kind: str, **fields: Any) -> tuple[str, dict[str, Any]]:
        return kind, {
            "type": kind,
            "plan_id": plan,
            "task_id": task,
            "ts_millis": 1_792_000_000_000,
            **fields,
        }

    ladder_pick = {"source": "ladder", "stage": "static", "reason": "ladder", "provider": "fakeapi"}
    # roko's failover route, as graph_task_dispatch/failover.rs words it: the model that runs first, then the
    # models passed over, newest first.
    failover = {
        "source": "failover",
        "stage": "failover",
        "model": "fake-cheap",
        "provider": "backup",
        "reason": "fake-cheap on fakeapi passed over (circuit_open): 503 Service Unavailable",
        "candidates": [
            {"model": "fake-cheap", "provider": "backup", "score": 1.0, "p": 1.0, "eligible": True},
            {
                "model": "fake-cheap",
                "provider": "fakeapi",
                "score": 0.0,
                "eligible": False,
                "ineligible_reason": "circuit_open",
            },
        ],
    }
    rows = [
        row("task_started", title="Write the answer"),
        row("route_decided", attempt=1, model="fake-cheap", **ladder_pick),
        row("agent_spawned", attempt=1, model="fake-cheap", provider="fakeapi", role="implementer"),
        row("route_decided", attempt=1, **failover),
        row("agent_spawned", attempt=1, model="fake-cheap", provider="backup", role="implementer"),
        row("gate_result", gate="verify[0:runs]", passed=False, output_text="$ check\nAssertionError: 41"),
        row("route_decided", attempt=2, model="fake-cheap", **ladder_pick),
        row("agent_spawned", attempt=2, model="fake-cheap", provider="fakeapi", role="implementer"),
    ]
    fold = rundata.EventFold()
    for cursor, (kind, event) in enumerate(rows, start=1):
        fold.feed(cursor, kind, event)
    [view] = fold.tasks.values()
    card = rundata._task_card(view, ladder=CLIMB_LADDER)
    assert tries(card, "rung", "provider", "reason", "outcome") == [
        ("cheap", "backup", "failover", "failed"),
        ("cheap", "fakeapi", "retry", "running"),
    ]
    assert card["climb"][0]["failover"] == {
        "model": "fake-cheap",
        "provider": "fakeapi",
        "class": "circuit_open",
        "why": "failing, so roko paused it",
    }
    # roko does not hold a substitute's failure against the rung: the running try is the first that counts.
    assert card["lives"] == {"rung": "cheap", "used": 1, "of": 2}


def test_a_pinned_model_never_climbs_and_has_no_lives() -> None:
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000}
    for cursor, (kind, event) in enumerate(
        [
            (
                "route_decided",
                {"attempt": 1, "model": "fake-mid", "source": "task_hint", "reason": "task_hint"},
            ),
            ("agent_spawned", {"attempt": 1, "model": "fake-mid", "provider": "fakeapi"}),
            ("gate_result", {"gate": "verify[0:runs]", "passed": False, "output_text": "$ x\nerror: no"}),
            (
                "route_decided",
                {"attempt": 2, "model": "fake-mid", "source": "task_hint", "reason": "task_hint"},
            ),
            ("agent_spawned", {"attempt": 2, "model": "fake-mid", "provider": "fakeapi"}),
        ],
        start=1,
    ):
        fold.feed(cursor, kind, {"type": kind, **base, **event})
    card = rundata._task_card(next(iter(fold.tasks.values())), ladder=CLIMB_LADDER)
    assert tries(card, "rung", "reason", "outcome", "key_line") == [
        ("mid", "pinned", "failed", "error: no"),
        ("mid", "pinned", "running", None),
    ]
    assert card["lives"] is None


def test_rokos_attempt_settled_event_states_a_try_even_before_its_agents_row() -> None:
    """R1 as roko publishes it (37088dc12): the task's standing once the try counts, so the try that moved the
    task up (`climbed`) ran a rung below its `escalations`. Here the verdict on try 3 comes before its agent."""
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000}

    def settled(attempt: int, rung: str, **more: Any) -> dict[str, Any]:
        return {
            "attempt": attempt,
            "rung": rung,
            "escalations": 0,
            "failures_on_rung": 0,
            "climbed": False,
            "reason": "start",
            "verdict": "gate_failed",
            "blame": "agent",
            "model": f"fake-{rung}",
            "provider": "fakeapi",
            "usage": {"in": 3600, "out": 240, "cache_read": None, "reasoning": None},
            "cost_usd": 0.0014,
            "duration_ms": 900,
            "exhausted": False,
            **more,
        }

    rows: list[tuple[str, dict[str, Any]]] = [
        ("route_decided", {"attempt": 1, "model": "fake-cheap", "source": "ladder", "rung": "cheap"}),
        ("agent_spawned", {"attempt": 1, "model": "fake-cheap", "provider": "fakeapi"}),
        ("attempt_settled", settled(1, "cheap", failures_on_rung=1, failed_check="verify:0/test")),
        ("agent_spawned", {"attempt": 2, "model": "fake-cheap", "provider": "fakeapi"}),
        (
            "attempt_settled",
            settled(
                2,
                "cheap",
                escalations=1,
                climbed=True,
                reason="retry",
                verdict="turn_cap",
                detail="turn_cap: agent turn cap reached (turns=15, cap=15)",
            ),
        ),
        ("attempt_settled", settled(3, "mid", escalations=1, reason="climb", verdict="passed", blame="none")),
        ("agent_spawned", {"attempt": 3, "model": "fake-mid", "provider": "fakeapi"}),
    ]
    for cursor, (kind, event) in enumerate(rows, start=1):
        fold.feed(cursor, kind, {"type": kind, **base, **event})
    [view] = fold.tasks.values()
    assert [entry["attempt"] for entry in view.attempt_log] == [1, 2, 3]
    card = rundata._task_card(view, ladder=None, ended=True)
    assert tries(card, "attempt", "rung", "model", "reason", "cost_usd", "duration_ms", "source") == [
        (1, "cheap", "fake-cheap", "start", 0.0014, 900, "roko"),
        (2, "cheap", "fake-cheap", "retry", 0.0014, 900, "roko"),
        (3, "mid", "fake-mid", "climb", 0.0014, 900, "roko"),
    ]
    # Without a gate_result, the verdict names the check that failed it, as a run names it, and its why.
    assert tries(card, "failed_check", "why")[:2] == [
        ("verify[0:test]", "its check verify[0:test] failed"),
        (None, "it hit its turn cap (15 turns)"),
    ]
    assert card["climb"][2]["failover"] is None  # its agent's row was the try's own, not another model
    assert card["attempt_log"][0]["route"]["source"] == "ladder"
    assert card["exhausted"] is None


# tests/fixtures/climb2_runs.json: a real climb and an exhaustion recorded at no cost from roko 69361cb50, whose
# ladder events main merged at 37088dc12 (route_decided's ladder fields, attempt_settled, ladder_exhausted). T3
# wants 43, which no rung writes: ✕✕ on cheap, ✕✕ on mid, and on strong two tries that spend the rung's $0.0008
# allowance before their check. T1 fails twice on cheap and passes on mid.
CLIMB2_ROWS = [
    json.loads(line)
    for line in (Path(__file__).parent / "fixtures" / "climb2_runs.json").read_text().splitlines()
]


def climb2_tracker() -> rundata.RunTracker:
    tracker = rundata.RunTracker(next(row["run_id"] for row in CLIMB2_ROWS if row["part"] == "meta"))
    for row in CLIMB2_ROWS:
        if row["part"] == "event":
            tracker.fold.feed(row["row"]["cursor"], row["row"]["type"], row["row"]["event"])
    return tracker


@pytest.mark.parametrize("with_records", [False, True])
def test_a_real_climb_and_exhaustion_read_from_rokos_ladder_events(
    tmp_path: Path, with_records: bool
) -> None:
    tracker = climb2_tracker()
    if with_records:  # the run's attempts.jsonl as well, read after the events: the same tries
        run_id = next(row["run_id"] for row in CLIMB2_ROWS if row["part"] == "meta")
        attempts = next(row["attempts"] for row in CLIMB2_ROWS if row["part"] == "attempts")
        path = tmp_path / ".roko" / "runs" / run_id / "attempts.jsonl"
        path.parent.mkdir(parents=True)
        path.write_text("".join(json.dumps(record) + "\n" for record in attempts))
        tracker.refresh_attempts(tmp_path)
    t1, t3 = sorted(tasks_of(tracker), key=lambda task: task["task_id"])
    assert tries(t1, "rung", "reason", "outcome", "source") == [
        ("cheap", "start", "failed", "roko"),
        ("cheap", "retry", "failed", "roko"),
        ("mid", "climb", "passed", "roko"),
    ]
    assert (t1["lives"], t1["exhausted"]) == ({"rung": "mid", "used": 1, "of": 2}, None)
    spent = "it spent its allowance on strong ($0.0013 of $0.0008)"
    assert tries(t3, "rung", "reason", "verdict", "failed_check", "why") == [
        ("cheap", "start", "gate_failed", "verify[0:runs]", "its check verify[0:runs] failed"),
        ("cheap", "retry", "gate_failed", "verify[0:runs]", "its check verify[0:runs] failed"),
        ("mid", "climb", "gate_failed", "verify[0:runs]", "its check verify[0:runs] failed"),
        ("mid", "retry", "gate_failed", "verify[0:runs]", "its check verify[0:runs] failed"),
        ("strong", "climb", "turn_cap", None, spent),
        ("strong", "retry", "turn_cap", None, spent),
    ]
    assert t3["exhausted"] == {
        "attempt": 6,
        "rung": "strong",
        "model": "fake-strong",
        "suggestion": "Split the task into smaller tasks, or replan it.",
    }
    # Spending a rung's allowance is no stop at the run's cap.
    assert not [task for task in tracker.task_rows() if task.cap_stop]
    # The routes' loop events say where each climb went.
    ctx = loopevents.LoopContext()
    climbs = [
        loop["text"]
        for row in CLIMB2_ROWS
        if row["part"] == "event" and row["row"]["type"] == "route_decided"
        for loop in loopevents.loop_events("route_decided", row["row"]["event"], ctx)
    ]
    assert [text for text in climbs if "moved up" in text] == [
        "Task 3 · try 3 moved up to a stronger model: fake-mid",
        "Task 3 · try 5 moved up to a stronger model: fake-strong",
        "Task 1 · try 3 moved up to a stronger model: fake-mid",
    ]


def test_roko_says_where_a_route_runs_on_the_ladder_and_why() -> None:
    # roko 37088dc12: route_decided names the rung, the step and why (ladder_reason), and the self-model's
    # forecast; a try's reason is roko's own word while it runs, before any verdict.
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000}
    forecast = {
        "mode": "shadow",
        "action": "dispatch",
        "would_choose": "fake-mid",
        "candidates": [{"model": "fake-mid", "provider": "fakeapi", "p_vs": 0.62, "cost_q50": 0.0031}],
    }
    route = {
        "source": "ladder",
        "rung": "mid",
        "ladder_step": 1,
        "ladder_reason": "climb",
        "forecast": forecast,
    }
    fold.feed(
        1, "route_decided", {"type": "route_decided", **base, "attempt": 3, "model": "fake-mid", **route}
    )
    fold.feed(2, "agent_spawned", {"type": "agent_spawned", **base, "attempt": 3, "model": "fake-mid"})
    [view] = fold.tasks.values()
    [one] = rundata._task_card(view, ladder=CLIMB_LADDER)["climb"]
    assert (one["rung"], one["reason"], one["outcome"]) == ("mid", "climb", "running")
    data = rundata.route_of({**base, "attempt": 3, "model": "fake-mid", **route})
    assert (data["ladder_step"], data["ladder_reason"]) == (1, "climb")
    assert data["forecast"] == {
        "mode": "shadow",
        "action": "dispatch",
        "would_choose": "fake-mid",
        "candidates": [{"model": "fake-mid", "provider": "fakeapi", "p_vs": 0.62, "cost_q50": 0.0031}],
    }
    # The loop event says it climbed, from where when the relay saw the route before, and carries the same.
    ctx = loopevents.LoopContext()
    [first] = loopevents.loop_events(
        "route_decided", {"type": "route_decided", **base, "attempt": 3, "model": "fake-mid", **route}, ctx
    )
    assert (
        first["text"] == "Task 1 · try 3 moved up to a stronger model: fake-mid"
        and "climbed_from" not in first["data"]
    )
    assert (
        first["data"]["ladder_reason"] == "climb" and first["data"]["forecast"]["would_choose"] == "fake-mid"
    )
    ctx = loopevents.LoopContext()
    cheap = {"source": "ladder", "rung": "cheap", "ladder_step": 0, "ladder_reason": "start"}
    loopevents.loop_events(
        "route_decided", {"type": "route_decided", **base, "attempt": 1, "model": "fake-cheap", **cheap}, ctx
    )
    [climbed] = loopevents.loop_events(
        "route_decided", {"type": "route_decided", **base, "attempt": 3, "model": "fake-mid", **route}, ctx
    )
    assert climbed["text"] == "Task 1 · try 3 moved up to a stronger model: fake-mid"
    assert climbed["data"]["climbed_from"] == "cheap"
    # An older roko names none of it.
    assert rundata.route_of({**base, "attempt": 1, "model": "m"})["ladder_reason"] is None
    assert loopevents.route_ladder({}) == {"ladder_step": None, "ladder_reason": None, "forecast": None}


def test_a_task_that_exhausted_the_ladder_carries_the_split_or_replan_stamp() -> None:
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000}
    fold.feed(1, "agent_spawned", {"type": "agent_spawned", **base, "attempt": 6, "model": "fake-strong"})
    fold.feed(
        2,
        "attempt_settled",
        {
            "type": "attempt_settled",
            **base,
            "attempt": 6,
            "rung": "strong",
            "escalations": 2,
            "verdict": "gate_failed",
            "blame": "agent",
            "model": "fake-strong",
            "exhausted": True,
        },
    )
    [view] = fold.tasks.values()
    # The verdict says so first; roko's ladder_exhausted then adds its advice.
    assert rundata._task_card(view)["exhausted"] == {
        "attempt": 6,
        "rung": "strong",
        "model": "fake-strong",
        "suggestion": None,
    }
    exhausted = {
        "type": "ladder_exhausted",
        **base,
        "attempt": 6,
        "rung": "strong",
        "model": "fake-strong",
        "escalations": 2,
        "suggestion": "Split the task into smaller tasks, or replan it.",
    }
    fold.feed(3, "ladder_exhausted", exhausted)
    assert (
        rundata._task_card(view)["exhausted"]["suggestion"]
        == "Split the task into smaller tasks, or replan it."
    )
    # The diagnosis roko raises beside it makes the timeline line; the event makes none.
    assert rundata.timeline_entry(3, "ladder_exhausted", exhausted) is None


def test_a_try_that_spent_its_rungs_allowance_failed_there_and_is_no_stop_at_the_cap() -> None:
    # roko 37088dc12 bounds a try on a rung it can still climb from; spending that allowance is the agent's
    # failure there (turn_cap), which counts toward a climb, not roko stopping the run at its cap.
    said = "Budget exhausted: the try spent its allowance on rung `cheap`: $0.0151 of $0.0150 ([routing.ladder] max_usd)"
    assert rundata.harness_words(said) == "it spent its allowance on cheap ($0.0151 of $0.0150)"
    assert rundata.cap_stop(said) is None and rundata.cap_stop(f"rung_allowance: {said[19:]}") is None
    assert rundata.harness_words(
        "the try spent its allowance on rung `mid`: $0.0300 ([routing.ladder] max_usd)"
    ) == ("it spent its allowance on mid ($0.0300)")
    # The run's own cap still reads as a stop.
    assert rundata.cap_stop("plan budget exhausted: $0.03 spent of $0.03")["limit"] == "run"
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000}
    fold.feed(1, "agent_spawned", {"type": "agent_spawned", **base, "attempt": 1, "model": "fake-cheap"})
    detail = f"turn_cap: rung_allowance: {said[19:]}"
    fold.feed(
        2,
        "attempt_settled",
        {
            "type": "attempt_settled",
            **base,
            "attempt": 1,
            "rung": "cheap",
            "verdict": "turn_cap",
            "detail": detail,
        },
    )
    [view] = fold.tasks.values()
    [one] = rundata._task_card(view, ended=True)["climb"]
    assert one["why"] == "it spent its allowance on cheap ($0.0151 of $0.0150)"
    assert view.cap_stop is None


def test_a_card_from_roko_carries_the_climb(tmp_path: Path, fake: FakeRoko, approvals: Approvals) -> None:
    (tmp_path / "roko.toml").write_text(CLIMB_TOML)
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        fake.run_script = ["succeeded"]
        run_id = call(runtime, "roko_run", {"prompt": "write the answer", "max_usd": 0.5})["run_id"]
        fake.runs[run_id].events = [row["event"] for row in CLIMB["events"]]
        card = views.card(runtime, run_id)
        assert [rung["rung"] for rung in card["ladder"]] == ["cheap", "mid", "strong"]
        t1 = card["tasks"][0]
        assert tries(t1, "rung", "reason", "outcome", "source") == [
            ("cheap", "start", "failed", "events"),
            ("cheap", "retry", "failed", "events"),
            ("mid", "climb", "passed", "events"),
        ]
        assert t1["lives"] == {"rung": "mid", "used": 1, "of": 2}
    finally:
        runtime.close()


# -- P4: what a task's check prints ----------------------------------------------------------------------------


def test_a_card_keeps_the_end_of_each_checks_result_until_roko_streams_its_lines(tmp_path: Path) -> None:
    # A roko before gap-f45a6d publishes no gate_output_line: each check's tail is the end of its result.
    # T1's third try is working on mid; the check on show is the one that failed its second try.
    tracker = climb_tracker(until=lambda row: row["type"] == "agent_completed" and row["cursor"] > 10_901)
    [t1] = tasks_of(tracker, ended=False)
    assert t1["check_tail"] == {
        "attempt": 2,
        "gate": "verify[0:runs]",
        "passed": False,
        "command": 'python3 -c \'got = open("answer.txt").read().strip(); assert got == "42", '
        'f"answer.txt says {got!r}, not 42"\'',
        "exit_code": 1,  # roko's "✗ exit status 1" line
        "duration_ms": None,
        "lines": [
            "---stderr---",
            "Traceback (most recent call last):",
            '  File "<string>", line 1, in <module>',  # its indentation kept
            "AssertionError: answer.txt says '41', not 42",
            "✗ exit status 1",
        ],
        "live": False,
    }
    # With roko's verdict on the try, its exit code and time for the step come from roko.
    write_attempts(tmp_path, CLIMB["run_id"])
    tracker.refresh_attempts(tmp_path)
    [t1] = tasks_of(tracker, ended=False)
    assert (t1["check_tail"]["exit_code"], t1["check_tail"]["duration_ms"]) == (1, 141)
    # Once the run ends, the newest check is the third try's, which passed.
    tracker = climb_tracker()
    tracker.refresh_attempts(tmp_path)
    t1, t2 = tasks_of(tracker)
    assert {
        key: t1["check_tail"][key] for key in ("attempt", "passed", "exit_code", "duration_ms", "lines")
    } == {
        "attempt": 3,
        "passed": True,
        "exit_code": 0,
        "duration_ms": 116,
        "lines": [],
    }
    assert (t2["check_tail"]["command"], t2["check_tail"]["passed"]) == ("test -s answer.txt", True)


def test_a_check_that_streams_its_lines_keeps_its_last_40_and_then_its_verdict() -> None:
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000}
    rows: list[tuple[str, dict[str, Any]]] = [
        ("agent_spawned", {"attempt": 1, "model": "fake-cheap", "provider": "fakeapi"}),
        ("gate_rung_started", {"rung_name": "verify[0:test]"}),
        *[
            ("gate_output_line", {"gate": "verify[0:test]", "line": f"test {index} ... ok"})
            for index in range(44)
        ],
        ("gate_output_line", {"gate": "verify[0:test]", "line": "   "}),  # a blank line is not kept
        ("gate_output_line", {"gate": "verify[0:test]", "line": "    raise ValueError(\x1b[31mbad\x1b[0m)"}),
    ]
    for cursor, (kind, event) in enumerate(rows, start=1):
        fold.feed(cursor, kind, {"type": kind, **base, **event})
    [task] = fold.tasks.values()
    tail = rundata._task_card(task)["check_tail"]
    assert (tail["attempt"], tail["gate"], tail["passed"], tail["live"]) == (1, "verify[0:test]", None, True)
    assert len(tail["lines"]) == 40 and tail["lines"][0] == "test 5 ... ok"
    assert tail["lines"][-1] == "    raise ValueError(bad)"  # escapes gone, indentation kept
    fold.feed(99, "gate_result", {"type": "gate_result", **base, "gate": "verify[0:test]", "passed": False})
    tail = rundata._task_card(task)["check_tail"]
    assert (tail["passed"], tail["live"], len(tail["lines"])) == (False, True, 40)
    # The next try's first line starts the next check; until then the failed one stays on show.
    fold.feed(100, "agent_spawned", {"type": "agent_spawned", **base, "attempt": 2, "model": "fake-cheap"})
    assert rundata._task_card(task)["check_tail"]["attempt"] == 1
    fold.feed(
        101, "gate_output_line", {"type": "gate_output_line", **base, "gate": "verify[0:test]", "line": "ok"}
    )
    tail = rundata._task_card(task)["check_tail"]
    assert (tail["attempt"], tail["passed"], tail["lines"]) == (2, None, ["ok"])
    # Check lines are not timeline lines.
    assert not [line for line in fold.timeline if line["type"] == "gate_output_line"]


def test_check_lines_reach_the_socket_as_live_items_with_the_checks_tail(rt: Runtime) -> None:
    relay = rt.live
    with relay._lock:
        tracked = relay._follow("r-1", kind="plan", plan_id="p")
        tracked.state = "running"
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    base = {"type": "gate_output_line", "plan_id": "p", "task_id": "T1", "gate": "verify[0:test]"}
    for line in ("..F.", "", "AssertionError: 2 != 11", "FAILED (failures=1)"):
        relay.handle_event({**base, "line": line})
    assert seen[-1] == {
        "type": "live",
        "run_id": "r-1",
        "kind": "check",
        "plan_id": "p",
        "task_id": "T1",
        "attempt": None,
        "gate": "verify[0:test]",
        "line": "FAILED (failures=1)",
        "stream": None,
        "ts": None,
        "tail": ["..F.", "AssertionError: 2 != 11", "FAILED (failures=1)"],
    }
    assert len(seen) == 3  # the blank line sent nothing
    relay.handle_event({**base, "gate": "verify[1:test]", "line": "ok"})
    assert seen[-1]["tail"] == ["ok"]  # another check, its own tail
    # Over the rate the newest line waits, and carries the lines before it.
    seen.clear()
    tracked.live_times.clear()
    lines = [f"line {index}" for index in range(live_relay.LIVE_PER_S + 5)]
    for line in lines:
        relay.handle_event({**base, "gate": "verify[1:test]", "line": line})
    assert len(seen) == live_relay.LIVE_PER_S
    tracked.live_times.clear()
    relay._flush_live(tracked)
    assert seen[-1]["line"] == lines[-1] and seen[-1]["tail"] == lines[-live_relay.CHECK_TAIL :]


def test_roko_names_the_try_and_stream_of_each_check_line_and_its_note_on_skipped_lines() -> None:
    # roko since gap-f45a6d: each line names its try (from 1) and its stream; when the bounds skipped lines, a
    # last line from roko itself (stream roko) says so, and the check's result keeps the end of its output.
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000}
    line = {"type": "gate_output_line", **base, "gate": "verify[0:test]"}
    fold.feed(1, "agent_spawned", {"type": "agent_spawned", **base, "attempt": 1, "model": "fake-cheap"})
    fold.feed(2, "gate_output_line", {**line, "attempt": 1, "line": "test 1 ... ok", "stream": "stderr"})
    note = "… 120 more line(s) of this check were not streamed; its result keeps the end of its output"
    fold.feed(3, "gate_output_line", {**line, "attempt": 1, "line": note, "stream": "roko"})
    [task] = fold.tasks.values()
    assert rundata._task_card(task)["check_tail"]["lines"] == ["test 1 ... ok", note]
    output = "$ python3 -m unittest\n...\nAssertionError: 2 != 3\n✗ exit status 1"
    fold.feed(
        4,
        "gate_result",
        {"type": "gate_result", **base, "gate": "verify[0:test]", "passed": False, "output_text": output},
    )
    tail = rundata._task_card(task)["check_tail"]
    assert (tail["attempt"], tail["passed"], tail["live"], tail["command"]) == (
        1,
        False,
        False,
        "python3 -m unittest",
    )
    assert tail["lines"] == ["...", "AssertionError: 2 != 3", "✗ exit status 1"]
    # A check that streamed all its lines keeps them, and its result adds the command and the exit status; a
    # line of the next try starts that try's check.
    fold.feed(5, "agent_spawned", {"type": "agent_spawned", **base, "attempt": 2, "model": "fake-cheap"})
    fold.feed(6, "gate_output_line", {**line, "attempt": 2, "line": "AssertionError", "stream": "stderr"})
    fold.feed(
        7,
        "gate_result",
        {
            "type": "gate_result",
            **base,
            "gate": "verify[0:test]",
            "passed": False,
            "output_text": "$ python3 -m unittest\nAssertionError\n✗ exit status 1",
        },
    )
    tail = rundata._task_card(task)["check_tail"]
    assert (tail["attempt"], tail["passed"], tail["live"], tail["lines"]) == (
        2,
        False,
        True,
        ["AssertionError"],
    )
    assert (tail["command"], tail["exit_code"]) == ("python3 -m unittest", 1)


@pytest.mark.parametrize("named", ["by roko", "by the relay", "by the result alone"])
def test_a_new_trys_check_starts_clean_on_the_socket_and_the_card(rt: Runtime, named: str) -> None:
    """dogfood-desktop's on-camera bug: a new try's check block opened with the try before's lines, so
    "FAILED (failures=1)" sat above the passing "OK". Tails are kept per try: roko names the try on each line
    (since gap-f45a6d); else the relay places it on the try it saw start; else the check's result ends it."""
    base = {"plan_id": "p", "task_id": "T1"}

    def line(attempt: int, text: str) -> dict[str, Any]:
        out = {"type": "gate_output_line", **base, "gate": "verify[0:test]", "line": text, "stream": "stderr"}
        return {**out, "attempt": attempt} if named == "by roko" else out

    events: list[dict[str, Any]] = [
        {"type": "agent_spawned", **base, "model": "fake-cheap"}
        | ({"attempt": 1} if named != "by the result alone" else {}),
        line(1, "..F"),
        line(1, "FAILED (failures=1)"),
        {"type": "gate_result", **base, "gate": "verify[0:test]", "passed": False, "output_text": "FAILED"},
        {"type": "agent_spawned", **base, "model": "fake-mid"}
        | ({"attempt": 2} if named != "by the result alone" else {}),
        line(2, "..."),
        line(2, "OK"),
    ]
    relay = rt.live
    with relay._lock:
        tracked = relay._follow("r-1", kind="plan", plan_id="p")
        tracked.state = "running"
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    fold = rundata.EventFold()
    for cursor, event in enumerate(events, start=1):
        relay.handle_event(event)
        fold.feed(cursor, event["type"], event)
    checks = [frame for frame in seen if frame.get("kind") == "check"]
    assert [item["tail"] for item in checks] == [
        ["..F"],
        ["..F", "FAILED (failures=1)"],
        ["..."],
        ["...", "OK"],
    ]
    if named != "by the result alone":
        assert [item["attempt"] for item in checks] == [1, 1, 2, 2]
    # The card's check_tail is the second try's alone.
    [task] = fold.tasks.values()
    tail = rundata.check_tail_view(task) or {}
    assert (tail["lines"], tail["passed"], tail["live"]) == (["...", "OK"], None, True)
    assert tail["attempt"] == 2  # an unnumbered agent row starts the next try all the same


def test_a_real_streamed_check_keeps_its_lines_its_try_and_its_verdict(rt: Runtime) -> None:
    # tests/fixtures/stream_runs.json: the climb recorded from roko 5b59e6dca, which streams each failed check's
    # traceback as gate_output_line rows (gap-f45a6d) before the check's gate_result.
    rows = [
        json.loads(line)["row"]
        for line in (Path(__file__).parent / "fixtures" / "stream_runs.json").read_text().splitlines()
        if json.loads(line)["part"] == "event"
    ]
    fold = rundata.EventFold()
    tails = []
    for row in rows:
        fold.feed(row["cursor"], row["type"], row["event"])
        if row["type"] == "gate_result" and row["event"]["task_id"] == "T1":
            task = next(task for task in fold.tasks.values() if task.task_id == "T1")
            tail = rundata.check_tail_view(task) or {}
            tails.append(
                (tail["attempt"], tail["passed"], tail["live"], tail["exit_code"], tail["lines"][-1:])
            )
    assert tails == [
        (1, False, True, 1, ["AssertionError: answer.txt says '41', not 42"]),
        (2, False, True, 1, ["AssertionError: answer.txt says '41', not 42"]),
        (3, True, False, None, []),
    ]
    # Over the socket each line is a check item with its try and stream, and a new try starts a new tail.
    relay = rt.live
    with relay._lock:
        tracked = relay._follow("r-1", kind="plan", plan_id="climb")
        tracked.state = "running"
        tracked.since_ms = 0  # the recording's rows are older than this follow: not history here
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    for row in rows:
        if row["type"] == "gate_output_line":
            relay.handle_event(row["event"])
    items = [frame for frame in seen if frame.get("kind") == "check"]
    assert [(item["attempt"], item["stream"], len(item["tail"])) for item in items] == [
        (1, "stderr", 1),
        (1, "stderr", 2),
        (1, "stderr", 3),
        (2, "stderr", 1),
        (2, "stderr", 2),
        (2, "stderr", 3),
    ]


def test_a_check_items_try_and_stream_reach_the_socket_and_a_new_try_starts_its_tail(rt: Runtime) -> None:
    relay = rt.live
    with relay._lock:
        tracked = relay._follow("r-1", kind="plan", plan_id="p")
        tracked.state = "running"
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    base = {"type": "gate_output_line", "plan_id": "p", "task_id": "T1", "gate": "verify[0:test]"}
    relay.handle_event({**base, "attempt": 1, "line": "..F.", "stream": "stdout"})
    relay.handle_event({**base, "attempt": 1, "line": "AssertionError", "stream": "stderr"})
    assert {key: seen[-1][key] for key in ("attempt", "stream", "tail")} == {
        "attempt": 1,
        "stream": "stderr",
        "tail": ["..F.", "AssertionError"],
    }
    relay.handle_event({**base, "attempt": 2, "line": "....", "stream": "stdout"})
    assert (seen[-1]["attempt"], seen[-1]["tail"]) == (2, ["...."])
    relay.handle_event({**base, "attempt": 0, "line": "odd", "stream": "elsewhere"})
    assert (seen[-1]["attempt"], seen[-1]["stream"]) == (None, None)  # 0 and unknown streams say nothing


# -- P3: the receipt of an ended run ---------------------------------------------------------------------------


def test_an_ended_runs_card_prints_its_receipt(tmp_path: Path, fake: FakeRoko, approvals: Approvals) -> None:
    (tmp_path / "roko.toml").write_text(CLIMB_TOML)
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        fake.run_script = ["running"]
        run_id = call(runtime, "roko_run", {"prompt": "write the answer", "max_usd": 0.5})["run_id"]
        # While it runs (its events before its end; with its end, the events say it ended, P-1).
        fake.runs[run_id].events = [row["event"] for row in CLIMB["events"] if row["type"] != "run_completed"]
        assert views.card(runtime, run_id)["receipt"] is None
        fake.runs[run_id].events = [row["event"] for row in CLIMB["events"]]
        fake.runs[run_id].states = ["succeeded"]
        receipt = views.card(runtime, run_id)["receipt"]
    finally:
        runtime.close()
    # Where its work passed: T2 and T1's first two tries on cheap, T1's third on mid; one climb; T2 first time.
    assert receipt["by_rung"] == {
        "cheap": {"passed": 1, "tries": 3, "cost_usd": 0.00432},
        "mid": {"passed": 1, "tries": 1, "cost_usd": 0.002688},
    }
    assert (receipt["climbs"], receipt["first_try_passes"]) == (1, 1)
    assert receipt["cost_usd"] == 0.007008 and receipt["tasks"]["passed"] == 2
    # roko 47b3cdd20 gave no per-try usage: the run's own tokens on the top rung (strong, fake-strong at $0.75 /
    # $4.50), 14,400 in and 960 out, failed tries included, and the basis says so.
    assert receipt["top_rung"] == {"rung": "strong", "model": "fake-strong", "slug": "fake-strong"}
    assert receipt["top_rung_usd"] == 0.01512 and receipt["ratio"] == 2.2
    assert (receipt["top_rung_by"], receipt["not_compared"]) == ("run_totals", 0)
    assert receipt["basis"] == "≈ from run totals, failed tries included"
    assert receipt["basis_detail"] == (
        "14,400 input, 960 output, 0 cache-read tokens at fake-strong's list prices ($0.75 in, $4.50 out per million)"
    )
    assert (receipt["lessons_kept"], receipt["lessons_confirmed"], receipt["lessons_used"]) == (0, 0, None)


# tests/fixtures/receipt_runs.json: one task's real climb from roko 69361cb50, whose attempt_settled carries each
# try's usage: T1 fails twice on cheap and passes on mid, each try 3,600 tokens in and 240 out.
RECEIPT = recording("live_receipt_run", "receipt_runs.json")


def test_the_top_rung_line_prices_only_the_passing_tries_tokens(
    tmp_path: Path, fake: FakeRoko, approvals: Approvals
) -> None:
    """plugin-review's question 1: the conservative counterfactual. The two failed cheap tries are not priced at the
    top rung; only the passing try is, as if the top rung had passed at once with the same tokens."""
    (tmp_path / "roko.toml").write_text(CLIMB_TOML)
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        fake.run_script = ["succeeded"]
        run_id = call(runtime, "roko_run", {"prompt": "write the answer", "max_usd": 0.5})["run_id"]
        fake.runs[run_id].events = [row["event"] for row in RECEIPT["events"]]
        card = views.card(runtime, run_id)
    finally:
        runtime.close()
    receipt = card["receipt"]
    assert [one["tokens"] for one in card["tasks"][0]["climb"]] == [
        {"input": 3600, "output": 240, "cache_read": 0}
    ] * 3
    # The passing mid try alone at fake-strong's $0.75 / $4.50: 3,600 × 0.75 + 240 × 4.5 per million.
    assert (receipt["top_rung_by"], receipt["top_rung_usd"], receipt["not_compared"]) == (
        "passing_tries",
        0.00378,
        0,
    )
    assert receipt["basis"] == "≈ the passing try's tokens at fake-strong's list prices"
    assert receipt["basis_detail"] == (
        "3,600 input, 240 output and 0 cache-read tokens of the passing try at fake-strong's list prices "
        "($0.75 in, $4.50 out per million)"
    )
    # Against the run's $0.005568: the top rung's one try would have cost less than roko's three. Said as it is.
    assert receipt["cost_usd"] == 0.005568 and receipt["ratio"] == 0.7
    # The method before priced every try, the two failed ones included: three times as much.
    for one in card["tasks"][0]["climb"]:
        one["tokens"] = None
    before = rundata.receipt(card)
    assert (before["top_rung_by"], before["top_rung_usd"], before["ratio"]) == ("run_totals", 0.01134, 2.0)
    assert before["basis"] == "≈ from run totals, failed tries included"


def priced_try(outcome: str, cost: float, tokens: dict[str, int] | None) -> dict[str, Any]:
    return {"outcome": outcome, "rung": "cheap", "reason": "start", "cost_usd": cost, "tokens": tokens}


def test_the_top_rung_line_adds_helper_calls_and_counts_the_tasks_it_leaves_out() -> None:
    tokens = {"input": 1_000_000, "output": 100_000, "cache_read": 0}
    card = ended_card(
        ladder=CLIMB_LADDER_PRICED,
        cost_usd=0.012,
        tasks=[
            {"task_id": "T1", "outcome": "passed", "climb": [priced_try("passed", 0.004, tokens)]},
            {
                "task_id": "T2",
                "outcome": "passed",
                "climb": [priced_try("failed", 0.002, tokens), priced_try("passed", 0.002, tokens)],
            },
            {"task_id": "T3", "outcome": "failed", "climb": [priced_try("failed", 0.002, tokens)]},
            {"task_id": "T4", "outcome": "blocked", "climb": []},
        ],
    )
    receipt = rundata.receipt(card)
    # Two passing tries at $0.75 / $4.50: 2 × (0.75 + 0.45) = $2.40. The run's $0.012 less its tries' $0.010 is not
    # helper calls (PW-5: a try's doubled row read as such): with no side calls, there are none. T3 never passed and
    # T4 never ran: not compared.
    assert (receipt["top_rung_usd"], receipt["not_compared"]) == (2.4, 2)
    assert receipt["basis"] == "≈ the 2 passing tries' tokens at fake-strong's list prices"
    # Helper calls are roko's helper and audit side calls, to the cent.
    helped = rundata.receipt({**card, "side_call_usd": {"helper": 0.02, "failover_refused": 0.5}})
    assert helped["top_rung_usd"] == 2.42
    assert helped["basis"].endswith(", plus $0.02 helper calls")
    failed = rundata.receipt({**card, "tasks": [card["tasks"][2]]})
    assert (failed["top_rung_usd"], failed["basis"], failed["not_compared"]) == (
        None,
        "no task passed: nothing to compare",
        1,
    )
    # A passing try with no usage (an older roko) falls back to the run's totals, failed tries included.
    older = {**card, "tokens": {"input": 10, "output": 1, "cache_read": 0, "cache_write": 0}}
    older["tasks"] = [{**card["tasks"][0], "climb": [priced_try("passed", 0.004, None)]}]
    assert rundata.receipt(older)["basis"] == "≈ from run totals, failed tries included"


def ended_card(**fields: Any) -> dict[str, Any]:
    return {"kind": "run", "state": "succeeded", "tasks": [], "ladder": LADDER, "cost_usd": 0.1, **fields}


def test_the_top_rung_comparison_says_why_when_it_cannot_be_made() -> None:
    tokens = {"input": 1000, "output": 100, "cache_read": 0, "cache_write": 0}
    # The dogfood ladder's top rung is a Claude CLI agent that roko serves no price for.
    unpriced = rundata.receipt(ended_card(tokens=tokens))
    assert unpriced["top_rung"] == {"rung": "top", "model": "claude-sonnet-4-6", "slug": "claude-sonnet-4-6"}
    assert (unpriced["top_rung_usd"], unpriced["ratio"]) == (None, None)
    assert (unpriced["basis"], unpriced["basis_detail"]) == ("no list price for claude-sonnet-4-6", None)
    bare = rundata.receipt(ended_card(tokens=tokens, ladder=None))
    assert (bare["top_rung"], bare["top_rung_usd"], bare["basis"]) == (
        None,
        None,
        "no model ladder in roko.toml",
    )
    silent = rundata.receipt(ended_card(tokens=None, ladder=LADDER[:3]))
    assert (silent["top_rung_usd"], silent["basis"]) == (None, "the run counted no tokens")
    assert silent["by_rung"] is None  # no try on a rung


def test_cache_tokens_on_the_top_rung_cost_what_roko_would_charge_for_them() -> None:
    # gpt-5.4-mini: $0.75 in, $4.50 out, $0.075 a cache read; a cache write at 1.25 times the input price.
    tokens = {"input": 1_000_000, "output": 100_000, "cache_read": 2_000_000, "cache_write": 400_000}
    priced = rundata.receipt(ended_card(tokens=tokens, ladder=LADDER[:3], cost_usd=0.5))
    assert priced["top_rung_usd"] == round(0.75 + 0.45 + 0.15 + 0.375, 6)
    assert priced["ratio"] == 3.5  # $1.725 against the $0.50 it cost
    assert priced["basis_detail"] == (
        "1,000,000 input, 100,000 output, 2,000,000 cache-read, 400,000 cache-write tokens at gpt-5.4-mini's list "
        "prices ($0.75 in, $4.50 out per million)"
    )
    # A top rung that names no cache-read price: a tenth of its input price, as roko prices one.
    ladder = [{**LADDER[2], "price_cache_read": None}]
    assert rundata.receipt(ended_card(tokens=tokens, ladder=ladder))["top_rung_usd"] == round(
        0.75 + 0.45 + 0.15 + 0.375, 6
    )


def test_a_receipt_counts_lessons_and_adds_up_the_changes() -> None:
    lessons = [
        {"admission": "light_admitted"},
        {"admission": "full_admitted"},
        {"admission": "duplicate", "reinforced": 1},
        {"admission": "no_candidate"},
    ]
    work = {
        "kind": "partial",
        "parts": [
            {
                "branch": "roko/batch/r1",
                "merged": True,
                "counts": {"files": 9, "additions": 287, "deletions": 3},
            },
            {"branch": None, "merged": False, "counts": {"files": 1, "additions": 4, "deletions": 0}},
        ],
    }
    receipt = rundata.receipt(
        ended_card(tasks=[{"lessons": lessons[:3]}, {"lessons": lessons[3:]}], work=work)
    )
    assert (receipt["lessons_kept"], receipt["lessons_confirmed"]) == (2, 1)
    assert receipt["changes"] == {
        "kind": "partial",
        "files": 10,
        "additions": 291,
        "deletions": 3,
        "branch": "roko/batch/r1",
        "merged": False,
    }
    assert rundata.receipt(ended_card())["changes"] is None


def test_odd_attempt_records_change_nothing(tmp_path: Path) -> None:
    tracker = climb_tracker()
    path = write_attempts(tmp_path, CLIMB["run_id"])
    odd = [
        {"plan_id": "climb", "task_id": "T1", "attempt": "two", "outcome": "passed"},
        {"plan_id": "climb", "task_id": "T1", "attempt": 1e309, "outcome": "passed"},
        {"plan_id": "climb", "task_id": "T9", "attempt": 1, "outcome": "passed"},  # no such task
        ["not", "a", "record"],
    ]
    path.write_text(path.read_text() + "".join(json.dumps(line) + "\n" for line in odd))
    with path.open("a") as out:
        out.write(json.dumps({**CLIMB["attempts"][1], "steps": {"rung": "x"}, "ladder": "cheap"}) + "\n")
    tracker.refresh_attempts(tmp_path)
    t1, _ = tasks_of(tracker)
    # The last record for try 1 named no ladder: its rung comes from the card's ladder.
    assert tries(t1, "rung", "reason", "outcome", "source") == [
        ("cheap", "start", "failed", "roko"),
        ("cheap", "retry", "failed", "roko"),
        ("mid", "climb", "passed", "roko"),
    ]
    assert [task.task_id for task in tracker.task_rows()] == ["T1", "T2"]


# -- the mini ladder: a run's tasks on each rung, on its card and its run row ------------------------------------


def test_each_rung_names_the_tiers_that_start_there(tmp_path: Path) -> None:
    # A tier roko.toml leaves out starts where roko starts it (D11: mechanical and focused on cheap); a start
    # rung the ladder lacks is its first rung.
    (tmp_path / "roko.toml").write_text(
        CLIMB_TOML + '\n[routing.ladder.start]\narchitectural = "top"\nintegrative = "strong"\n'
    )
    ladder = rundata.CardCache().ladder_view(None, tmp_path)
    assert ladder is not None
    assert {rung["rung"]: rung["starts"] for rung in ladder} == {
        "cheap": ["mechanical", "focused", "architectural"],  # no "top" rung here
        "mid": [],
        "strong": ["integrative"],
    }


def climb_rows(tracker: rundata.RunTracker) -> rundata.RunTracker:
    tracker.plan_tasks["climb"] = [
        {"id": task["id"], "title": task["title"], "tier": task["tier"], "depends_on": task["depends_on"]}
        for task in CLIMB["plan_tasks"]["tasks"]
    ]
    return tracker


def test_a_runs_rung_counts_place_its_tasks_and_their_failed_tries() -> None:
    ladder = [
        {**rung, "starts": starts} for rung, starts in zip(CLIMB_LADDER, [["focused"], [], []], strict=True)
    ]
    # T1's third try runs on mid after two failed tries on cheap; T2 waits to start, on cheap.
    tracker = climb_rows(
        climb_tracker(until=lambda row: row["type"] == "agent_completed" and row["cursor"] > 10_901)
    )
    assert rundata.rung_counts(tracker.task_rows(), ladder) == [
        {"rung": "cheap", "passed": 0, "running": 0, "failed": 2, "refused": 0, "waiting": 1},
        {"rung": "mid", "passed": 0, "running": 1, "failed": 0, "refused": 0, "waiting": 0},
        {"rung": "strong", "passed": 0, "running": 0, "failed": 0, "refused": 0, "waiting": 0},
    ]
    tracker = climb_rows(climb_tracker())
    assert rundata.rung_counts(tracker.task_rows(), ladder, ended=True) == [
        {"rung": "cheap", "passed": 1, "running": 0, "failed": 2, "refused": 0, "waiting": 0},
        {"rung": "mid", "passed": 1, "running": 0, "failed": 0, "refused": 0, "waiting": 0},
        {"rung": "strong", "passed": 0, "running": 0, "failed": 0, "refused": 0, "waiting": 0},
    ]
    assert rundata.rung_counts(tracker.task_rows(), None) is None


def test_a_cards_tasks_carry_their_tier_for_the_ladder_to_place_a_waiting_one() -> None:
    """P-36 (round v7): the Ladder drew a task that had not started on the first chat rung; roko starts it on its
    tier's start rung ([routing.ladder.start]), as `rung_counts` already counts it. The card says each task's tier."""
    tracker = climb_rows(
        climb_tracker(until=lambda row: row["type"] == "agent_completed" and row["cursor"] > 10_901)
    )
    tiers = {task["task_id"]: task["tier"] for task in tasks_of(tracker, ended=False)}
    assert tiers == {task["id"]: task["tier"] for task in CLIMB["plan_tasks"]["tasks"]}


def test_the_run_row_carries_its_rung_counts(tmp_path: Path, fake: FakeRoko, approvals: Approvals) -> None:
    (tmp_path / "roko.toml").write_text(CLIMB_TOML)
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        fake.run_script = ["succeeded"]
        run_id = call(runtime, "roko_run", {"prompt": "write the answer", "max_usd": 0.5})["run_id"]
        fake.runs[run_id].events = [row["event"] for row in CLIMB["events"]]
        card = views.card(runtime, run_id)
        [row] = [row for row in views.ui_overview(runtime)["runs"] if row["run_id"] == run_id]
    finally:
        runtime.close()
    assert (
        card["rungs"]
        == row["rungs"]
        == [
            {"rung": "cheap", "passed": 1, "running": 0, "failed": 2, "refused": 0, "waiting": 0},
            {"rung": "mid", "passed": 1, "running": 0, "failed": 0, "refused": 0, "waiting": 0},
            {"rung": "strong", "passed": 0, "running": 0, "failed": 0, "refused": 0, "waiting": 0},
        ]
    )


# -- R3: the lessons in each try's prompt ------------------------------------------------------------------------


def test_the_lessons_in_each_tries_prompt_and_the_receipts_count_of_them() -> None:
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T2", "ts_millis": 1_792_000_000_000}
    # roko-delivery's shape (roko 8357603f0): right after the attempt's route, before its agent.
    prompt = {
        "type": "prompt_assembled",
        **base,
        "attempt": 1,
        "knowledge_ids": ["runtime_8338198bc7f35156", "runtime_aa"],
        "playbook_ids": [],
        "episode_ids": [],
        "included_sections": ["task", "knowledge"],
        "dropped_sections": [],
        "estimated_tokens": 2100,
    }
    for cursor, (kind, event) in enumerate(
        [
            (
                "route_decided",
                {"type": "route_decided", **base, "attempt": 1, "model": "fake-cheap", "source": "ladder"},
            ),
            ("prompt_assembled", prompt),
            ("agent_spawned", {"type": "agent_spawned", **base, "attempt": 1, "model": "fake-cheap"}),
            ("gate_result", {"type": "gate_result", **base, "gate": "verify[0:runs]", "passed": False}),
            (
                "route_decided",
                {"type": "route_decided", **base, "attempt": 2, "model": "fake-cheap", "source": "ladder"},
            ),
            ("prompt_assembled", {**prompt, "attempt": 2, "knowledge_ids": ["runtime_aa"]}),
            ("agent_spawned", {"type": "agent_spawned", **base, "attempt": 2, "model": "fake-cheap"}),
        ],
        start=1,
    ):
        fold.feed(cursor, kind, event)
    [task] = fold.tasks.values()
    row = rundata._task_card(task, ladder=CLIMB_LADDER)
    assert tries(row, "lesson_ids") == [(["runtime_8338198bc7f35156", "runtime_aa"],), (["runtime_aa"],)]
    receipt = rundata.receipt(ended_card(tasks=[row]))
    assert receipt["lessons_used"] == 2  # two different lessons across its prompts
    # A roko that does not say what its prompts carried: no count, not zero.
    t1, _ = tasks_of(climb_tracker())
    assert {one["lesson_ids"] for one in t1["climb"]} == {None}
    assert rundata.receipt(ended_card(tasks=[t1]))["lessons_used"] is None


def test_a_route_lines_loop_tells_a_failover_from_the_pick_it_passed_over() -> None:
    """The desktop tells a failover try's passed-over pick from the failover by its timeline line's `loop`."""
    fold = rundata.EventFold()
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000, "attempt": 1}
    fold.feed(
        1, "route_decided", {"type": "route_decided", **base, "model": "fake-cheap", "source": "ladder"}
    )
    fold.feed(
        2,
        "route_decided",
        {
            "type": "route_decided",
            **base,
            "model": "fake-cheap",
            "provider": "backup",
            "source": "failover",
            "stage": "failover",
            "reason": "fake-cheap on fakeapi passed over (circuit_open): 503",
        },
    )
    assert [(line["type"], line["loop"]) for line in fold.timeline] == [
        ("route_decided", "route"),
        ("route_decided", "failover"),
    ]


# -- P5: what each try's prompt carried, and what the check before told it ---------------------------------------

# tests/fixtures/learning_runs.json: roko-delivery's $0 showcase (roko ee09f6464's stack, a scripted model): p1
# fails twice on cheap, its checks leaving feedback, and passes on glm-4.7, keeping a lesson; p2 carries it.


def fixture_runs(path: str, name: str) -> dict[str, Any]:
    out: dict[str, Any] = {"events": []}
    for line in (Path(__file__).parent / "fixtures" / path).read_text().splitlines():
        part = json.loads(line)
        if part["fixture"] != name:
            continue
        if part["part"] == "event":
            out["events"].append(part["row"])
        elif part["part"] == "meta":
            out["run_id"] = part["run_id"]
        else:
            out[part["part"]] = part[part["part"]]
    return out


def folded(recorded: dict[str, Any]) -> rundata.RunTracker:
    tracker = rundata.RunTracker(recorded["run_id"])
    for row in recorded["events"]:
        tracker.fold.feed(row["cursor"], row["type"], row["event"])
    return tracker


SHOWCASE_P1 = fixture_runs("learning_runs.json", "showcase_p1")
SHOWCASE_P2 = fixture_runs("learning_runs.json", "showcase_p2")
POCKET_SYNTH = fixture_runs("dogfood_v6_runs.json", "dogfood_pocket_synth")
SECTIONS = [
    "role_identity",
    "conventions",
    "domain_context",
    "context_layer",
    "tool_instructions",
    "task_context",
    "anti_patterns",
]
DIAGNOSIS = (
    "The test expects every run of spaces and punctuation to become one hyphen with none at the ends; the function "
    "only replaces spaces."
)


def test_each_try_says_what_its_prompt_carried_and_what_the_check_before_told_it() -> None:
    [t1] = tasks_of(folded(SHOWCASE_P1), ladder=LADDER)
    assert tries(t1, "rung", "model", "reason", "outcome", "why") == [
        ("cheap", "gpt-oss-120b", "start", "failed", "its check verify[0:test] failed"),
        ("cheap", "gpt-oss-120b", "retry", "failed", "its check verify[0:test] failed"),
        ("mid", "glm-4.7", "climb", "passed", None),
    ]
    first, second, third = t1["climb"]
    assert first["prompt"] == {
        "lessons": [],
        "playbook_ids": [],
        "episodes": 0,
        "left_out": [],
        "sections": SECTIONS,
        "dropped_sections": [],
        "estimated_tokens": 1214,
    }
    assert first["feedback"] is None and first["lesson_ids"] == []
    # What try 1's check told try 2, and try 2's told try 3: the prompt grew with it.
    assert second["feedback"] == {
        "from_attempt": 1,
        "check": "verify",
        "failing_steps": ["verify[0:test] (`python3 -m unittest tests.test_slug -q`): exit code: 1"],
        "diagnosis": DIAGNOSIS,
        "errors": [],
    }
    assert third["feedback"]["from_attempt"] == 2
    assert (first["prompt"]["estimated_tokens"], second["prompt"]["estimated_tokens"]) == (1214, 1782)


def test_a_lesson_kept_before_is_named_in_the_prompt_that_carries_it(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    fake.knowledge = [
        {
            "id": "runtime_8a405674e2ed19da",
            "content": "textkit slug rules: lowercase, collapse each run of spaces and punctuation into a single "
            "hyphen, and strip hyphens at both ends",
        }
    ]
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "slug filenames", "max_usd": 0.5})["run_id"]
    fake.runs[run_id].events = [row["event"] for row in SHOWCASE_P2["events"]]
    card = views.card(rt, run_id)
    [t1] = card["tasks"]
    [first] = t1["climb"]
    assert first["lesson_ids"] == ["runtime_8a405674e2ed19da"]
    # p1 kept the lesson; this run's T1 confirmed it (admission duplicate) and wrote it out in full.
    assert first["prompt"]["lessons"] == [
        {
            "id": "runtime_8a405674e2ed19da",
            "text": "textkit slug rules: lowercase, collapse each run of spaces and punctuation into a single hyphen, "
            "and strip hyphens at both ends; replacing only spaces fails the",
            "confidence": 0.9,
            "citations": 3,
            "kept_by": None,  # an earlier run kept it
        }
    ]
    assert first["prompt"]["playbook_ids"] == ["ep-p1-slugify-T1-1792188308462"]
    assert first["prompt"]["episodes"] == 2
    assert card["receipt"]["lessons_used"] == 1


def test_a_lesson_this_run_kept_is_named_by_the_task_that_kept_it() -> None:
    lesson = {"id": "k1", "text": None, "confidence": None, "citations": None, "kept_by": None}
    card = {
        "tasks": [
            {
                "task_id": "T1",
                "lessons": [
                    {"entry_id": "k1", "lesson": "Amounts are integer cents.", "admission": "light_admitted"}
                ],
            },
            {"task_id": "T2", "lessons": [], "climb": [{"prompt": {"lessons": [lesson]}}]},
        ]
    }

    class Known(rundata.CardCache):
        def knowledge(self, client: Any) -> dict[str, dict[str, Any]]:
            return {"k1": {"text": "Amounts are integer cents…", "confidence": 0.71, "citations": 4}}

    rundata._name_the_lessons(card, Known(), None)  # type: ignore[arg-type]
    assert lesson == {
        "id": "k1",
        "text": "Amounts are integer cents.",
        "confidence": 0.71,
        "citations": 4,
        "kept_by": "T1",
    }


# -- dogfood Run 3 (U1, U2, U4, U5): what ended each try, and roko's own words kept apart from the agent's --------


def test_each_try_says_what_ended_it_and_roko_s_own_words_are_not_the_agents(tmp_path: Path) -> None:
    tracker = folded(POCKET_SYNTH)
    path = tmp_path / ".roko" / "runs" / POCKET_SYNTH["run_id"] / "attempts.jsonl"
    path.parent.mkdir(parents=True)
    path.write_text("".join(json.dumps(record) + "\n" for record in POCKET_SYNTH["attempts"]))
    tracker.refresh_attempts(tmp_path)
    svf = next(task for task in tasks_of(tracker, ladder=LADDER) if task["task_id"] == "SVF")
    stream = "roko stopped the model's stream: it ran past roko's limit"
    assert tries(svf, "attempt", "rung", "reason", "verdict", "why") == [
        (1, "cheap", "start", "gate_failed", "its check verify[0:acceptance] failed"),
        (2, "cheap", "retry", "turn_cap", "it hit its turn cap (12 turns)"),
        (3, "mid", "climb", "provider_error", stream),
        (4, "mid", "retry", "provider_error", stream),
        (
            5,
            "mid",
            "retry",
            "provider_error",
            "the network failed: read chunk failed: error decoding response body",
        ),
        (6, "mid", "retry", "provider_error", stream),
    ]  # the resume's try 7 is in the same records (invocation 2) but is another run's on the hub
    # roko's own messages are not what the agent said: not its note, and their timeline lines say it stopped.
    note = next(task.note for task in tracker.task_rows() if task.task_id == "SVF") or ""
    assert "immune boundary" not in note and not note.startswith("agent turn cap")
    lines = [line["text"] for line in tracker.fold.timeline if line.get("task_id") == "SVF"]
    assert f"SVF · stopped: {stream}" in lines and "SVF · stopped: it hit its turn cap (12 turns)" in lines
    assert not [
        line for line in lines if "agent: provider result denied" in line or "agent: agent turn cap" in line
    ]
    # In trusted mode roko publishes each tool call twice (its screened step, then the call): one line each.
    steps = [
        line for line in tracker.fold.timeline if line.get("group") == "tool" and line.get("task_id") == "SVF"
    ]
    calls = {
        record["payload"]["tool_id"]
        for row in POCKET_SYNTH["events"]
        if row["type"] == "agent_output" and row["event"].get("task_id") == "SVF"
        for record in loopevents.stream_records(row["event"].get("content"))
        if record.get("kind") == "tool_start"
    }
    assert len(steps) == len(calls) > 0
    assert "SVF read_file" not in [line["text"] for line in steps]  # the twin of "SVF read_file synth/svf.py"


def test_a_cap_stopped_runs_status_says_stopped_so_hermes_does_not_call_it_an_error(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """Dogfood U14: Hermes logged the status of a run roko stopped at its cap as a failed call."""
    from test_tools import _hermes_calls_it_a_failure
    from test_v05_runs import CAP_STOPPED_ROWS

    from hermes_plugin_roko import tools

    fake.add_plan("caps-check", "caps-check", [{"id": "T1", "title": "Add shout to wordy"}, {"id": "T2"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "caps-check", "max_usd": 0.03})["run_id"]
    run = fake.runs[run_id]
    run.states, run.events = ["failed"], [dict(row) for row in CAP_STOPPED_ROWS]
    raw = tools.make_handlers(rt)["roko_status"]({"run_id": run_id, "wait_secs": 0})
    status = json.loads(raw)
    assert status["state"] == "stopped at its cap" and status["budget_stop"]["limit"] == "run"
    assert not _hermes_calls_it_a_failure(raw), raw[:500]
    assert views.card(rt, run_id)["state"] == "failed"  # roko's word stays on the card


def test_a_failed_plan_offers_its_resume_and_says_why_in_words(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """Dogfood U2: the failure story mixed roko's own words in as the agent's, and offered no next step."""
    fake.add_plan("pocket-synth", "pocket-synth", [{"id": task} for task in ("OSC", "ENV", "SVF", "RENDER")])
    run_id = call(rt, "roko_plan_run", {"plan_id": "pocket-synth", "max_usd": 0.5})["run_id"]
    run = fake.runs[run_id]
    run.states, run.events = ["failed"], [row["event"] for row in POCKET_SYNTH["events"]]
    card = views.card(rt, run_id)
    assert card["next"] == {
        "action": "rerun",
        "label": "resume the plan",
        "why": "SVF and RENDER did not pass; a resume keeps what passed and runs the rest",
        "resume": True,
    }
    summary = card["why"]["summary"]
    assert "SVF did not finish: roko stopped the model's stream: it ran past roko's limit." in summary
    assert "immune boundary" not in summary


def test_the_loops_say_who_raised_a_diagnosis_and_count_attempts_not_tasks(
    rt: Runtime, fake: FakeRoko
) -> None:
    """Dogfood U6 and U7: "passes 33% of 6 tasks" counted attempts, and L2 printed `self_model_abandon` raw."""
    from hermes_plugin_roko import insights, loopevents

    fake.diagnoses = [
        {
            "id": "self_model_abandon:pocket-synth/SVF",
            "ts": "2026-10-16T20:45:40Z",
            "severity": "warn",
            "subject": "SVF is unlikely to pass on any rung",
            "detail": "The self-model forecasts at most 0.42 P(verified success) for task `SVF` on every rung.",
            "suggested_action": "Split the task, replan it, or drop it.",
            "intervention_taken": None,
        }
    ]
    [diagnosis] = insights.diagnoses(rt.client())
    assert (diagnosis["source"], diagnosis["who"]) == ("self_model_abandon", "self-model")
    # A new lesson roko filed above its first tier did not move up; one it had and confirmed did.
    new = {
        "admission": "light_admitted",
        "lesson": "slugs collapse punctuation",
        "promoted": 1,
        "reinforced": 0,
    }
    [(_, text, _, _)] = loopevents._knowledge(new, loopevents.LoopContext(), "p", "T1")
    assert text == "Task 1 · kept a new lesson: slugs collapse punctuation"
    confirmed = {"admission": "duplicate", "entry_id": "k1", "promoted": 1, "reinforced": 1}
    [(_, text, _, _)] = loopevents._knowledge(confirmed, loopevents.LoopContext(), "p", "T1")
    assert text == "Task 1 · confirmed 1 lesson it had · 1 moved up a tier"


def test_a_resume_is_joined_to_the_run_it_continues_with_the_plans_total(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """Dogfood U10: "Pocket synth resume succeeded 4/4 $0.12" sat beside "pocket-synth failed 2/4 $0.18", and the
    plan's total, $0.30, appeared nowhere."""
    fake.add_plan("pocket-synth", "pocket-synth", [{"id": task} for task in ("OSC", "ENV", "SVF", "RENDER")])
    fake.run_script = ["failed"]
    first = call(rt, "roko_plan_run", {"plan_id": "pocket-synth", "max_usd": 0.5})["run_id"]
    fake.run_script = ["succeeded"]
    second = call(rt, "roko_plan_run", {"plan_id": "pocket-synth", "max_usd": 0.5, "resume": True})["run_id"]
    rt.runs.update(first, cost_usd=0.18, cost_final=True)
    rt.runs.update(second, cost_usd=0.12, cost_final=True)
    rows = {row["run_id"]: row for row in views.run_rows(rt, rt.runs.recent(10))}
    assert rows[first]["resumes"] is None and rows[first]["chain"] is None
    assert rows[second]["resumes"] == first
    assert rows[second]["chain"]["run_ids"] == [first, second]
    assert rows[second]["chain"]["cost_usd"] == 0.3
    # A plain run of the plan resumes nothing.
    third = call(rt, "roko_plan_run", {"plan_id": "pocket-synth", "max_usd": 0.5})["run_id"]
    assert rt.runs.get(third).get("resumes") is None


def test_a_plans_runs_are_every_run_that_continued_the_same_run(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """hermes-pilot, phase 6: roko continues a run under its own id, so its second resume names the first run, as
    the first resume did. The third run's page read "this plan over 2 runs: $3.79" (the first and the third); the
    plan's runs were three, $5.77 together."""
    fake.add_plan("pocket-synth", "pocket-synth", [{"id": task} for task in ("OSC", "ENV", "SVF", "RENDER")])
    fake.run_script = ["failed"]
    first = call(rt, "roko_plan_run", {"plan_id": "pocket-synth", "max_usd": 0.5})["run_id"]
    second = call(rt, "roko_plan_run", {"plan_id": "pocket-synth", "max_usd": 0.5, "resume": True})["run_id"]
    fake.run_script = ["succeeded"]
    third = call(rt, "roko_plan_run", {"plan_id": "pocket-synth", "max_usd": 0.5, "resume": True})["run_id"]
    # What roko answers both resumes: they continue the first run (its CheckpointRun).
    rt.runs.update(second, resumes=first)
    rt.runs.update(third, resumes=first)
    for run_id, cost in ((first, 3.004796), (second, 1.985243), (third, 0.781974)):
        rt.runs.update(run_id, cost_usd=cost, cost_final=True)
    rows = {row["run_id"]: row for row in views.run_rows(rt, rt.runs.recent(10))}
    assert rows[third]["chain"]["run_ids"] == [first, second, third]
    assert rows[third]["chain"]["cost_usd"] == 5.772013
    # A run's page counts the plan's runs up to it.
    assert rows[second]["chain"]["run_ids"] == [first, second]
    assert rows[second]["chain"]["cost_usd"] == 4.990039
    assert rows[first]["chain"] is None


# -- P6: GET /learning, and roko's homeostat, controller and playbooks as loop events --------------------------


SHOWCASE_P3 = fixture_runs("learning_runs.json", "showcase_p3")


def test_the_homeostat_its_controller_and_playbooks_are_loop_events() -> None:
    from hermes_plugin_roko import loopevents

    ctx = loopevents.LoopContext()
    sample = {
        "type": "ev.update",
        "ev": "pass_rate",
        "value": 0.86,
        "bound": 0.7,
        "inner": 0.75,
        "state": "in_bounds",
    }
    [essential] = loopevents.loop_events("ev.update", sample, ctx)
    assert (essential["kind"], essential["ring"]) == ("essential", "L3")
    assert essential["text"] == "homeostat: pass rate 86% (≥ 70%)"
    breach = {**sample, "ev": "usd_per_verified_success", "value": 0.19, "bound": 0.12, "state": "breached"}
    [usd] = loopevents.loop_events("ev.update", breach, ctx)
    assert usd["text"] == "homeostat: $ per pass $0.190 (≤ $0.120) · out of bounds"
    moved = {
        "type": "m1.episode",
        "episode_id": "ep-0007",
        "phase": "search",
        "change": "tier_floor: cheap -> mid",
    }
    [controller] = loopevents.loop_events("m1.episode", moved, ctx)
    assert (controller["kind"], controller["text"]) == ("controller", "M1 moved tier_floor: cheap -> mid")
    held = {"type": "m1.episode", "episode_id": "relax", "phase": "idle"}
    assert loopevents.loop_events("m1.episode", held, ctx)[0]["text"] == "M1 holding: no knob moved"
    # The showcase's playbook, as roko published it.
    row = next(row["event"] for row in SHOWCASE_P1["events"] if row["type"] == "playbook_written")
    [playbook] = loopevents.loop_events("playbook_written", row, ctx)
    assert playbook["kind"] == "playbook" and playbook["text"].startswith(
        "T1 wrote a playbook: Slugify text in textkit"
    )
    # A run's card keeps the homeostat as the run last saw it.
    fold = rundata.EventFold()
    for cursor, event in enumerate([sample, breach, moved], start=1):
        fold.feed(cursor, event["type"], event)
    homeostat = rundata.homeostat_view(fold)
    assert homeostat is not None
    assert [view["ev"] for view in homeostat["variables"]] == ["pass_rate", "usd_per_verified_success"]
    assert homeostat["controller"] == {
        "episode_id": "ep-0007",
        "phase": "search",
        "change": "tier_floor: cheap -> mid",
    }
    assert not [line for line in fold.timeline if line["type"] == "ev.update"]  # the homeostat is no timeline


def test_learning_shows_the_lesson_one_run_kept_paying_off_in_the_next_two(
    laddered: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    run_ids = []
    for recorded, plan in (
        (SHOWCASE_P1, "p1-slugify"),
        (SHOWCASE_P2, "p2-slug-filenames"),
        (SHOWCASE_P3, "p3-heading-anchors"),
    ):
        fake.add_plan(plan, plan, [{"id": "T1"}])
        fake.run_script = ["succeeded"]
        run_id = call(laddered, "roko_plan_run", {"plan_id": plan, "max_usd": 0.5})["run_id"]
        fake.runs[run_id].events = [row["event"] for row in recorded["events"]]
        views.card(laddered, run_id)  # what each run taught goes into the run log
        run_ids.append(run_id)
    view = views.learning_view(laddered)
    assert (view["scope"], view["scope_label"], view["recorded_tasks"]) == (
        "hermes",
        "runs started from Hermes",
        None,
    )
    assert view["coverage"] == {"source": "run log", "runs": 3, "found": 3, "lessons_from": 3, "note": None}
    rows = view["runs"]
    assert [row["run_id"] for row in rows] == run_ids  # oldest first
    assert {(row["origin"], row["source"]) for row in rows} == {("hermes", "card")}
    assert [(row["tasks"], row["passed"], row["first_try"], row["climbs"]) for row in rows] == [
        (1, 1, 0, 1),  # p1 failed twice on cheap and passed on mid
        (1, 1, 1, 0),
        (1, 1, 1, 0),
    ]
    # roko's own cost per verified task, run by run (efficiency_trend_updated).
    assert [(row["cost_per_pass"], row["cost_per_pass_by"]) for row in rows] == [
        (0.013183, "roko"),
        (0.003542, "roko"),
        (0.003612, "roko"),
    ]
    assert view["kpis"]["cost_per_pass"] == {
        "value": 0.006779,
        "first": None,  # three runs: nothing earlier to compare with yet
        "series": [0.013183, 0.003542, 0.003612],
    }
    assert view["kpis"]["first_try_rate"]["value"] == 0.6667
    assert view["kpis"]["climbs_per_run"]["series"] == [1.0, 0.0, 0.0]
    # The lesson p1 kept paid off: p2 and p3 carried it and passed on their first try.
    [lesson] = view["lessons"]
    assert lesson["id"] == "runtime_8a405674e2ed19da" and lesson["text"].startswith("textkit slug rules")
    assert lesson["kept_by"]["run_id"] == run_ids[0] and lesson["kept_by"]["task_id"] == "T1"
    assert [(use["run_id"], use["first_try"], use["climbed"]) for use in lesson["uses"]] == [
        (run_ids[1], True, False),
        (run_ids[2], True, False),
    ]
    assert lesson["first_try"] == 2
    # Too few tasks a side to say which way it points; both n's are given (plugin-review's question 3).
    assert view["lessons_first_try"] == {
        "with": {"passed": 2, "of": 2, "rate": 1.0},
        "without": {"passed": 0, "of": 1, "rate": 0.0},
        "design": "observational",
        "comparable": False,
        "difference": None,
        "note": "too few tasks to compare yet (n = 2 and 1)",
    }
    # Where work passed: p1's task on mid, the next two on cheap.
    where = view["where_passed"]
    assert [rung["rung"] for rung in where["rungs"]] == ["cheap", "mid", "strong", "top"]
    assert [run["passed"] for run in where["runs"]] == [
        {"cheap": 0, "mid": 1, "strong": 0, "top": 0},
        {"cheap": 1, "mid": 0, "strong": 0, "top": 0},
        {"cheap": 1, "mid": 0, "strong": 0, "top": 0},
    ]
    assert where["cheapest_share"] == {"first": None, "last": 0.6667}
    assert view["homeostat"] is None  # no ev.update in these runs


def write_run(
    workdir: Path,
    run_id: str,
    attempts: list[dict[str, Any]],
    *,
    origin: str,
    ended_at: str,
    plans: list[str],
) -> None:
    """A run's records as roko keeps them: its manifest, closed, and its attempts."""
    folder = workdir / ".roko" / "runs" / run_id
    folder.mkdir(parents=True)
    (folder / "attempts.jsonl").write_text("".join(json.dumps(record) + "\n" for record in attempts))
    manifest = {
        "schema_version": "roko.run_manifest/1",
        "run_id": run_id,
        "kind": "plan_run",
        "plan_ids": plans,
        "origin": origin,
        "closed": {"ended_at": ended_at, "status": "failed" if plans == ["climb2"] else "succeeded"},
    }
    (folder / "manifest.json").write_text(json.dumps(manifest))


def test_learning_in_the_workspace_reads_every_plan_runs_records(laddered: Runtime, fake: FakeRoko) -> None:
    """The workspace scope (ui-dash): every plan run in roko's workspace, the ones started from a terminal too,
    from roko's run records; the lessons only for the runs Hermes started, and it says so."""
    workdir = laddered.settings().workdir
    assert workdir is not None
    climb2_id = next(row["run_id"] for row in CLIMB2_ROWS if row["part"] == "meta")
    climb2_attempts = next(row["attempts"] for row in CLIMB2_ROWS if row["part"] == "attempts")
    write_run(
        workdir,
        CLIMB["run_id"],
        CLIMB["attempts"],
        origin="mcp:local",
        ended_at="2026-10-17T09:00:00Z",
        plans=["climb"],
    )
    write_run(
        workdir, climb2_id, climb2_attempts, origin="cli", ended_at="2026-10-17T11:42:45Z", plans=["climb2"]
    )
    # The first one Hermes started: its card saw the lesson T1 kept, and roko's own cost per verified task.
    laddered.runs.add(CLIMB["run_id"], "plan", "Climb", plan_id="climb", state="succeeded")
    laddered.runs.update(
        CLIMB["run_id"],
        learning={
            "tasks": 2,
            "passed": 2,
            "first_try": 1,
            "climbs": 1,
            "kept": [{"id": "k1", "task": "T1", "text": "answer.txt holds 42"}],
            "used": [],
            "first_prompt": None,
            "roko_cost_per_pass": 0.0042,
        },
    )
    fake.cost_trend = [
        {"timestamp": "2026-10-17T09:00:00Z", "cost_usd": 0.01, "cumulative_cost_usd": 0.01},
        {"timestamp": "2026-10-17T11:00:00Z", "cost_usd": 0.03, "cumulative_cost_usd": 0.04},
    ]
    view = views.learning_view(laddered, {"scope": "workspace"})
    assert (view["scope"], view["scope_label"]) == ("workspace", "every plan run in roko's workspace")
    rows = view["runs"]
    assert [(row["label"], row["origin"], row["source"]) for row in rows] == [
        ("Climb", "hermes", "records"),
        ("climb2", "terminal", "records"),
    ]
    # The terminal run's tries count as fully as the Hermes run's: T1 climbed to mid, T3 climbed twice and failed.
    assert [(row["tasks"], row["passed"], row["first_try"], row["climbs"]) for row in rows] == [
        (2, 2, 1, 1),
        (2, 1, 0, 3),
    ]
    assert [(row["cost_usd"], row["cost_per_pass"], row["cost_per_pass_by"]) for row in rows] == [
        (0.007008, 0.0042, "roko"),
        (0.016344, 0.016344, "plugin"),
    ]
    assert [(row["lessons_kept"], row["lessons_used"]) for row in rows] == [(["k1"], []), (None, None)]
    assert view["coverage"] == {
        "source": "run records",
        "runs": 2,
        "found": 2,
        "lessons_from": 1,
        "note": "lessons and what prompts carried are known for 1 of 2 runs, the ones Hermes started",
    }
    assert view["kpis"]["first_try_rate"]["value"] == 0.25 and view["kpis"]["climbs_per_run"]["series"] == [
        1.0,
        3.0,
    ]
    assert [run["passed"] for run in view["where_passed"]["runs"]] == [
        {"cheap": 1, "mid": 1, "strong": 0, "top": 0},
        {"cheap": 0, "mid": 1, "strong": 0, "top": 0},
    ]
    # roko's spend over every task it recorded, passed or not.
    assert view["recorded_tasks"] == {
        "tasks": 2,
        "cost_usd": 0.04,
        "cost_per_task_usd": 0.02,
        "typical_task_ms": 30000,
    }


def test_learning_in_the_workspace_without_its_records_counts_rokos_runs(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    from hermes_plugin_roko.errors import RokoError

    fake.run_script = ["succeeded"]
    call(rt, "roko_run", {"prompt": "x", "max_usd": 0.5})
    view = views.learning_view(rt, {"scope": "workspace"})  # no workdir: no run records to read
    assert view["runs"] == [] and view["coverage"] == {
        "source": "run index",
        "runs": 0,
        "found": 1,
        "lessons_from": 0,
        "note": "the plugin does not share roko's workspace: no run records to read",
    }
    with pytest.raises(RokoError) as raised:
        views.learning_view(rt, {"scope": "everywhere"})
    assert raised.value.code.value == "invalid"


def test_the_learning_route_takes_its_scope(laddered: Runtime) -> None:
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from hermes_plugin_roko import ui_api

    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: laddered), prefix="/api/plugins/roko")
    with TestClient(app) as client:
        hermes = client.get("/api/plugins/roko/learning").json()
        workspace = client.get("/api/plugins/roko/learning", params={"scope": "workspace"}).json()
        refused = client.get("/api/plugins/roko/learning", params={"scope": "x"}).json()
    assert (hermes["scope"], workspace["scope"]) == ("hermes", "workspace")
    assert workspace["coverage"]["source"] == "run records" and workspace["runs"] == []
    assert refused["ok"] is False and refused["error"]["code"] == "invalid"


def test_the_relay_sends_the_homeostat_and_the_controller_as_they_move(rt: Runtime) -> None:
    relay = rt.live
    seen: list[dict[str, Any]] = []
    relay._publish = lambda frames: seen.extend(frames)  # type: ignore[method-assign]
    relay.handle_event(
        {
            "type": "ev.update",
            "ev": "false_green",
            "value": 0.0,
            "bound": 0.05,
            "inner": 0.03,
            "state": "in_bounds",
        }
    )
    relay.handle_event({"type": "m1.episode", "episode_id": "ep-0002", "phase": "hold", "change": None})
    assert [(frame["type"], frame["kind"], frame["run_id"]) for frame in seen] == [
        ("loop", "essential", None),  # no run is going: a frame for every page
        ("loop", "controller", None),
    ]
    assert seen[0]["text"] == "homeostat: false green 0% (≤ 5%)" and seen[1]["text"] == "M1 on hold"


# -- single-flight /overview ---------------------------------------------------------------------------------------


def test_overviews_asked_at_once_share_one_build_unless_a_run_started_meanwhile(
    rt: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    import threading
    import time

    started, release = threading.Event(), threading.Event()
    builds: list[int] = []

    def slow_build(runtime: Runtime) -> dict[str, Any]:
        builds.append(1)
        number = len(builds)
        started.set()
        release.wait(5)
        return {"ok": True, "build": number}

    asked = [0]
    recent = rt.runs.recent

    def counted(limit: int) -> list[dict[str, Any]]:
        asked[0] += 1
        return recent(limit)

    monkeypatch.setattr(views, "_build_overview", slow_build)
    monkeypatch.setattr(rt.runs, "recent", counted)

    def ask_twice(between: Any = None) -> list[dict[str, Any]]:
        results: list[dict[str, Any]] = []
        started.clear()
        release.clear()
        asked[0] = 0
        first = threading.Thread(target=lambda: results.append(views.ui_overview(rt)))
        first.start()
        assert started.wait(5)
        if between is not None:
            between()
        second = threading.Thread(target=lambda: results.append(views.ui_overview(rt)))
        second.start()
        deadline = time.monotonic() + 5
        while asked[0] < 2 and time.monotonic() < deadline:
            time.sleep(0.005)
        time.sleep(0.05)  # it has looked at the run log: it is joining the build, or building its own
        release.set()
        first.join(5)
        second.join(5)
        return results

    # The second caller shares the first one's build.
    assert ask_twice() == [{"ok": True, "build": 1}, {"ok": True, "build": 1}] and len(builds) == 1
    # A run that started while it built must be in the answer: the next caller builds its own.
    builds.clear()
    results = ask_twice(lambda: rt.runs.add("r-new", "run", "a run started meanwhile"))
    assert len(builds) == 2 and sorted(result["build"] for result in results) == [1, 2]


def test_a_route_that_climbs_says_so_once_roko_names_its_rung() -> None:
    """Dogfood U3: only the model name changed. Once route_decided names its rung (roko-caps), the line says it."""
    from hermes_plugin_roko import loopevents

    ctx = loopevents.LoopContext()
    base = {"type": "route_decided", "plan_id": "p", "task_id": "T3", "source": "ladder", "reason": "ladder"}
    texts = [
        loopevents.loop_events("route_decided", {**base, **route}, ctx)[0]["text"]
        for route in (
            {"attempt": 1, "model": "gpt-oss-120b", "rung": "cheap"},
            {"attempt": 2, "model": "gpt-oss-120b", "rung": "cheap"},
            {"attempt": 3, "model": "glm-4.7", "rung": "mid"},
        )
    ]
    assert texts == [
        "Task 3 · try 1 → gpt-oss-120b, started on the cheapest model",
        "Task 3 · try 2 → gpt-oss-120b, started on the cheapest model",
        "Task 3 · try 3 moved up to a stronger model: glm-4.7",
    ]
    # Without a rung (roko today) the line is as before.
    plain = loopevents.loop_events("route_decided", {**base, "attempt": 4, "model": "gpt-5.4-mini"}, ctx)
    assert plain[0]["text"] == "Task 3 · try 4 → gpt-5.4-mini, started on the cheapest model"


def test_a_cap_stops_status_tells_the_model_how_far_each_stopped_task_got(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """Dogfood U13: the answer after a cap stop said nothing of the climb or how close the run got."""
    from test_v05_runs import CAP_STOPPED_ROWS

    fake.add_plan("caps-check", "caps-check", [{"id": "T1", "title": "Add shout to wordy"}, {"id": "T2"}])
    run_id = call(rt, "roko_plan_run", {"plan_id": "caps-check", "max_usd": 0.03})["run_id"]
    run = fake.runs[run_id]
    run.states, run.events = ["failed"], [dict(row) for row in CAP_STOPPED_ROWS]
    card = views.card(rt, run_id)
    [t2] = [task for task in card["tasks"] if task["task_id"] == "T2"]
    status = call(rt, "roko_status", {"run_id": run_id, "wait_secs": 0})
    # No ladder in this workspace: each try is named by its model.
    assert len(t2["climb"]) <= 3
    tries = "; ".join(f"{one['model']}: {one['why']}" for one in t2["climb"])
    assert status["budget_stop"]["climb"] == [f"T2: {tries}"]
    assert status["budget_stop"]["climb"][0].endswith("roko stopped it at the run's cap")


def test_the_cap_stop_climb_names_each_rung_and_model_change_and_counts_what_it_leaves_out() -> None:
    from hermes_plugin_roko import tools

    def one(rung: str, model: str, why: str, **more: Any) -> dict[str, Any]:
        return {"rung": rung, "model": model, "why": why, "failed_check": None, "key_line": None, **more}

    card = {
        "tasks": [
            {
                "task_id": "T2",
                "climb": [
                    one("cheap", "gpt-oss-120b", "it hit its turn cap (12 turns)"),
                    one(
                        "cheap",
                        "gpt-oss-120b",
                        "its check verify[0:test] failed",
                        failed_check="verify[0:test]",
                        key_line="AssertionError: gain 1.02 at the cutoff",
                    ),
                    one("cheap", "gpt-oss-120b", "it hit its turn cap (12 turns)"),
                    one("mid", "gpt-5.4-mini", "roko stopped it at the run's cap"),
                ],
            },
            {"task_id": "T3", "climb": []},
        ]
    }
    stop = {"stopped": [{"task_id": "T2"}], "not_started": [{"task_id": "T3"}]}
    assert tools._stop_climb(card, stop) == [
        "T2: … 1 earlier; cheap (gpt-oss-120b): its check verify[0:test] failed: AssertionError: gain 1.02 at the "
        "cutoff; cheap: it hit its turn cap (12 turns); mid (gpt-5.4-mini): roko stopped it at the run's cap",
        "T3: not started",
    ]
    # No stopped task had a try: nothing to say.
    assert tools._stop_climb({"tasks": []}, {"stopped": [{"task_id": "T1"}], "not_started": []}) == []


# -- P8: a plan as a document ----------------------------------------------------------------------------------

# tests/fixtures/plans/pocket-sequencer: what roko's `plan import --mori` (roko-demos' gap-624658) wrote from
# plans-research's mori-format pocket-sequencer, its source path scrubbed.
SEQUENCER = Path(__file__).parent / "fixtures" / "plans" / "pocket-sequencer"


def sequencer_workspace(root: Path, fake: FakeRoko) -> Path:
    import shutil
    import tomllib

    workspace = root / "ws"
    shutil.copytree(SEQUENCER, workspace / "plans" / "pocket-sequencer")
    (workspace / "roko.toml").write_text(LADDER_TOML)
    source = (SEQUENCER / "tasks.toml").read_text()
    parsed = tomllib.loads(source)
    fake.add_plan(
        "pocket-sequencer",
        parsed["meta"]["title"],
        [
            {
                "id": task["id"],
                "title": task["title"],
                "tier": task["tier"],
                "depends_on": task.get("depends_on", []),
            }
            for task in parsed["task"]
        ],
    )
    fake.plan_sources["pocket-sequencer"] = source
    return workspace


def test_a_mori_import_reads_as_a_document(tmp_path: Path, fake: FakeRoko) -> None:
    from hermes_plugin_roko import plansheet

    workspace = sequencer_workspace(tmp_path, fake)
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    try:
        sheet = plansheet.plan_sheet(runtime, "pocket-sequencer")
    finally:
        runtime.close()
    assert sheet["imported_from"] == {"kind": "mori", "plan": "pocket-sequencer"}
    doc = sheet["doc"]
    assert doc["title"] == "Plan PQ-1 — pocket-sequencer: Turing Machine, quantizer, gates, pattern"
    assert doc["path"] == "plans/pocket-sequencer/plan.md" and doc["truncated"] is True
    assert [section["heading"] for section in doc["sections"]] == [
        "Plan PQ-1 — pocket-sequencer: Turing Machine, quantizer, gates, pattern",
        "What to build",
        "Verification",
        "Non-goals",
    ]
    # The title's first two paragraphs, a blank line between them; under each heading, its first paragraph.
    intro = doc["sections"][0]["text"]
    assert (
        intro.startswith("**Goal**: a melodic personality in a pocket.") and "\n\n**Adapted from**" in intro
    )
    assert doc["sections"][1]["text"].startswith("1. **`seq/turing.py`: `TuringMachine(")
    assert doc["markdown"].startswith("# Plan PQ-1") and len(doc["markdown"].encode()) <= plansheet.DOC_BYTES
    assert sheet["rubric"]["markdown"].startswith("## Shared Review Rubric — pocket-sequencer")
    t1 = sheet["tasks"][0]
    assert (t1["id"], t1["start_rung"], t1["section"]) == ("T1", "cheap", "What to build")
    assert [(item["id"], item["text"][:22]) for item in t1["acceptance"][:3]] == [
        ("AC1", "TuringMachine(length, "),
        ("AC2", "step() feeds back bit "),
        ("AC3", "INV-1: `test_locked_lo"),
    ]
    assert [(check["name"], check["command"]) for check in t1["verify"]] == [
        (
            "verify[0:invariant]",
            "python3 -m unittest tests.test_turing.TuringMachineTest.test_locked_loop_repeats",
        ),
        (
            "verify[1:invariant]",
            "python3 -m unittest tests.test_turing.TuringMachineTest.test_length_sets_the_loop",
        ),
        ("verify[2:checkpoint]", "python3 -m unittest tests.test_turing"),
    ]
    assert [check["name"] for check in sheet["plan_checks"]] == ["plan[0:compile]", "plan[1:unit_test]"]
    assert (t1["also_required"], t1["also_required_judged_in_review"], t1["also_required_more"]) == (
        [],
        False,
        0,
    )  # no block in this import
    # A mori import writes no `covers`: each criterion is linked to the checks whose command it quotes (ui-dash's
    # ask). INV-3 and INV-4 name tests no step runs on its own, so they link to nothing.
    assert [(item["checks"], item["linked_by"]) for item in t1["acceptance"]] == [
        ([], None),
        ([], None),
        (["verify[0:invariant]"], "quote"),
        (["verify[1:invariant]"], "quote"),
        ([], None),
        (["verify[2:checkpoint]"], "quote"),
    ]
    # The estimate by rung: the four implementers start on cheap, the integrative reviewer on mid.
    by_rung = {row["rung"]: row["tasks"] for row in sheet["estimate"]["by_rung"]}
    assert by_rung == {"cheap": ["T1", "T2", "T3", "T4"], "mid": ["REVIEW"], "strong": [], "top": []}
    assert sheet["estimate"]["start_rung"] == "cheap" and sheet["estimate"]["likely_usd"] is None


def test_a_checks_covers_name_the_criteria_it_checks(tmp_path: Path, fake: FakeRoko) -> None:
    """TSS v1: an acceptance item's own `ACn:` prefix is its id; a check's `covers` names the items it checks."""
    from hermes_plugin_roko import plansheet

    # roko's planner (gap-dc5d7c) writes each source check it keeps into a criterion: "AC1: SC2: …".
    task = {
        "acceptance": ["AC7: SC1: returns 42", "SC1, SC3: raises on a negative number", "logs nothing"],
        "verify": [
            {
                "phase": "test",
                "command": "python3 -m unittest tests.t",
                "covers": ["AC7", "AC2"],
                "expect": "fail_on_base",
            },
            {"phase": "lint", "command": "ruff check ."},
        ],
    }
    rows = plansheet.acceptance_rows(task)
    named = plansheet.checks(task["verify"], "verify")
    assert [(row["id"], row["text"], row["source_checks"]) for row in rows] == [
        ("AC7", "returns 42", ["SC1"]),
        ("AC2", "raises on a negative number", ["SC1", "SC3"]),
        ("AC3", "logs nothing", []),
    ]
    assert named[0]["covers"] == ["AC7", "AC2"] and named[0]["expect"] == "fail_on_base"
    assert named[1]["name"] == "verify[1:lint]" and named[1]["covers"] == []
    # The checks it drops, with why; an entry without a reason or an id is not one.
    meta = {"dropped_checks": ["SC4: needs a person to judge it", "SC5:", "no id here"]}
    assert plansheet.dropped_checks(meta) == [{"id": "SC4", "reason": "needs a person to judge it"}]
    # A task that declares `covers` is linked by them alone: a criterion's quote does not add a check.
    rows[2]["text"] = "logs nothing (`ruff check .` is clean)"
    plansheet.link_checks(rows, named)
    assert [(row["checks"], row["linked_by"]) for row in rows] == [
        (["verify[0:test]"], "covers"),
        (["verify[0:test]"], "covers"),
        ([], None),
    ]


def test_a_criterion_links_to_the_checks_whose_command_it_quotes() -> None:
    from hermes_plugin_roko import plansheet

    verify = [
        {
            "name": "verify[0:invariant]",
            "command": "python3 -m unittest tests.test_turing.T.test_locked_loop_repeats",
        },
        {"name": "verify[1:checkpoint]", "command": "python3   -m unittest  tests.test_turing"},
        {"name": "verify[2:test]", "command": "cargo test -p seq -- test_locked_loop_repeats"},
    ]

    def linked(text: str) -> list[str]:
        return plansheet.quoted_checks(text, verify)

    # A test name finds every check that runs it, whole dotted parts only.
    assert linked("`test_locked_loop_repeats` passes") == ["verify[0:invariant]", "verify[2:test]"]
    assert linked("`test_lock` passes") == [] and linked("`loop_repeats` passes") == []
    # A module finds the checks that run it or a test in it; a whole command, the one that is it.
    assert linked("`tests.test_turing` passes") == ["verify[0:invariant]", "verify[1:checkpoint]"]
    assert linked("Checkpoint: `python3 -m unittest tests.test_turing` exits 0") == ["verify[1:checkpoint]"]
    # A plain word, a short name, or no quote at all links nothing.
    assert (
        linked("`cargo` builds") == []
        and linked("`seq` exists") == []
        and linked("test_locked_loop_repeats") == []
    )


def test_the_plan_list_marks_the_plans_a_mori_import_wrote(tmp_path: Path, fake: FakeRoko) -> None:
    from hermes_plugin_roko import plansheet, ui_api

    workspace = sequencer_workspace(tmp_path, fake)
    mine = workspace / "plans" / "mine" / "add-flag"
    mine.mkdir(parents=True)
    (mine / "tasks.toml").write_text('[meta]\nplan = "add-flag"\n')
    fake.add_plan("add-flag", "Add a flag", [{"id": "T1", "title": "flag"}])
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    try:
        rows = {row["id"]: row for row in ui_api.plan_rows(runtime)["plans"]}
    finally:
        runtime.close()
    assert rows["pocket-sequencer"]["imported_from"] == {"kind": "mori", "plan": "pocket-sequencer"}
    assert rows["add-flag"]["imported_from"] is None  # roko lists it ungrouped, and it is no import anyway
    # Its plan set's folder, roko's older `.roko/plans/`, and nothing outside the plans folder.
    assert plansheet.listed_import(workspace, "mine", "add-flag") is None
    assert plansheet.listed_import(workspace, None, "../pocket-sequencer") is None
    assert plansheet.listed_import(None, None, "pocket-sequencer") is None
    old = tmp_path / "old"
    (old / ".roko" / "plans" / "pocket-sequencer").mkdir(parents=True)
    (old / ".roko" / "plans" / "pocket-sequencer" / "tasks.toml").write_text(
        (workspace / "plans" / "pocket-sequencer" / "tasks.toml").read_text()
    )
    assert plansheet.listed_import(old, None, "pocket-sequencer") == {
        "kind": "mori",
        "plan": "pocket-sequencer",
    }
    # A tasks.toml that links out of the workspace is not read (plugin-review's F4, for the plan list too); a
    # link inside it still is.
    outside = tmp_path / "outside.toml"
    outside.write_text((workspace / "plans" / "pocket-sequencer" / "tasks.toml").read_text())
    linked = workspace / "plans" / "linked"
    linked.mkdir()
    (linked / "tasks.toml").symlink_to(outside)
    assert plansheet.listed_import(workspace, None, "linked") is None
    (linked / "tasks.toml").unlink()
    (linked / "tasks.toml").symlink_to(workspace / "plans" / "pocket-sequencer" / "tasks.toml")
    assert plansheet.listed_import(workspace, None, "linked") == {"kind": "mori", "plan": "pocket-sequencer"}


def test_a_plan_whose_folder_the_plugin_cannot_read_has_no_doc(tmp_path: Path, fake: FakeRoko) -> None:
    from hermes_plugin_roko import plansheet

    sequencer_workspace(tmp_path, fake)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(elsewhere)}))
    try:
        sheet = plansheet.plan_sheet(runtime, "pocket-sequencer")
    finally:
        runtime.close()
    assert (sheet["doc"], sheet["rubric"]) == (None, None)
    assert sheet["tasks"][0]["acceptance"][0]["id"] == "AC1"  # from roko's source of the plan, as before
    # A path that leaves the workspace is not followed.
    assert plansheet._folder(elsewhere, "../ws/plans/pocket-sequencer/tasks.toml") is None


def test_the_plan_route_answers_the_plan_sheet(tmp_path: Path, fake: FakeRoko) -> None:
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from hermes_plugin_roko import ui_api

    workspace = sequencer_workspace(tmp_path, fake)
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: runtime), prefix="/api/plugins/roko")
    try:
        with TestClient(app) as client:
            body = client.get("/api/plugins/roko/plans/pocket-sequencer").json()
    finally:
        runtime.close()
    assert body["ok"] is True
    plan = body["plan"]
    assert plan["imported_from"]["kind"] == "mori" and plan["doc"]["title"].startswith("Plan PQ-1")
    assert plan["tasks"][0]["acceptance"][0]["id"] == "AC1" and plan["waves"]


# -- P7: what a request would cost before it starts -----------------------------------------------------------


def log_run(
    runtime: Runtime,
    run_id: str,
    *,
    cost: float,
    seconds: int,
    state: str = "succeeded",
    kind: str = "run",
    domain: str | None = None,
    first_try: bool = True,
) -> None:
    """A run Hermes started that ended `seconds` after it started, as the run log keeps it."""
    runtime.runs.add(run_id, kind, run_id, state=state, max_usd=0.5, request="add a flag")
    runtime.runs.update(
        run_id,
        started_at="2026-10-17T10:00:00Z",
        finished_at=f"2026-10-17T10:{seconds // 60:02d}:{seconds % 60:02d}Z",
        cost_usd=cost,
        domain=domain,
        learning={"tasks": 1, "passed": 1, "first_try": 1 if first_try else 0, "climbs": 0},
    )


def test_a_request_starts_on_its_tiers_rung_and_costs_about_what_similar_runs_did(laddered: Runtime) -> None:
    from hermes_plugin_roko import estimate

    for index, (cost, seconds, first) in enumerate(
        [(0.01, 30, True), (0.02, 60, True), (0.03, 90, False), (0.10, 300, True)]
    ):
        log_run(laddered, f"r{index}", cost=cost, seconds=seconds, first_try=first)
    # Not similar: a cancelled run, a research run and a plan run.
    log_run(laddered, "cancelled", cost=0.4, seconds=500, state="cancelled")
    log_run(laddered, "research", cost=0.4, seconds=500, domain="research")
    log_run(laddered, "plan", cost=0.4, seconds=500, kind="plan")
    found = estimate.estimate(laddered, "code", 0.5, reachable=True)
    # A focused task starts on cheap and may climb two rungs; top is a CLI agent a chat run never uses.
    assert (found["start_rung"], found["climb"]) == ("cheap", ["cheap", "mid", "strong"])
    assert [rung["rung"] for rung in found["ladder"]] == ["cheap", "mid", "strong", "top"]
    assert found["likely"] == {"usd": 0.025, "seconds": 75}
    assert found["similar"] == {"runs": 4, "tasks": 4, "first_try": 3, "first_try_rate": 0.75, "p90_usd": 0.1}
    assert found["basis"] == "≈ the median of 4 similar runs Hermes started here"
    assert found["confidence"] == "low"
    # Two failed tries on each rung, each scaled by the rung's prices against cheap's ($1.10 a million in and
    # out): 2 × $0.025 × (1.10 + 2.80 + 5.25) / 1.10.
    assert (found["worst_usd"], found["max_usd"], found["stops_at_cap"]) == (0.4159, 0.5, False)
    capped = estimate.estimate(laddered, "code", 0.3, reachable=True)
    assert (capped["worst_usd"], capped["stops_at_cap"]) == (0.3, True)
    # The research run is the one similar run of its domain.
    research = estimate.estimate(laddered, "research", 0.5, reachable=True)
    assert research["similar"]["runs"] == 1 and research["similar"]["p90_usd"] is None
    assert research["likely"] == {"usd": 0.4, "seconds": 500}


def test_without_similar_runs_the_estimate_rests_on_rokos_recorded_tasks_or_on_nothing(
    laddered: Runtime, fake: FakeRoko
) -> None:
    from hermes_plugin_roko import estimate

    fake.efficiency_tasks = [
        {"plan_id": "p", "task_id": "T1", "cost_usd": 0.04, "duration_ms": 20_000},
        {"plan_id": "p", "task_id": "T2", "cost_usd": 0.06, "duration_ms": 40_000},
        {"plan_id": "q", "task_id": "T1", "cost_usd": 0.05, "duration_ms": 30_000},
        {"plan_id": "q", "task_id": "T2", "cost_usd": "n/a"},  # not a cost
    ]
    found = estimate.estimate(laddered, "code", 0.5, reachable=True)
    assert found["likely"] == {"usd": 0.05, "seconds": 30} and found["similar"] is None
    # The basis says what it used: no similar run from Hermes, so roko's recorded tasks.
    assert found["basis"] == (
        "no similar one-task run from Hermes yet; ≈ the median of 3 tasks roko recorded here, of every kind"
    )
    # Two similar runs are too few while roko has more to go by; three are enough.
    log_run(laddered, "r1", cost=0.2, seconds=60)
    log_run(laddered, "r2", cost=0.3, seconds=60)
    two = estimate.estimate(laddered, "code", 0.5, reachable=True)
    assert two["likely"]["usd"] == 0.05
    assert (
        two["basis"]
        == "only 2 similar runs from Hermes; ≈ the median of 3 tasks roko recorded here, of every kind"
    )
    log_run(laddered, "r3", cost=0.4, seconds=60)
    assert estimate.estimate(laddered, "code", 0.5, reachable=True)["likely"]["usd"] == 0.3
    # With roko serve down and nothing similar, nothing to go by: only the cap bounds it. Runs did end here,
    # so the basis names them rather than saying none did.
    nothing = estimate.estimate(laddered, "docs", 0.5, reachable=False)
    assert (nothing["likely"], nothing["worst_usd"], nothing["stops_at_cap"]) == (None, None, True)
    assert (
        nothing["basis"]
        == "nothing to go by yet: no similar one-task run has ended here (3 runs in another domain have)"
    )
    assert nothing["climb"] == ["cheap", "mid", "strong"]  # the ladder from roko.toml


def test_with_nothing_to_go_by_the_basis_names_the_runs_that_did_end(rt: Runtime) -> None:
    """hermes-update's replay: two plan runs had ended, yet the basis said no run had. It names them now, and
    says "no run has ended here" only when none has."""
    from hermes_plugin_roko import estimate

    assert (
        estimate.estimate(rt, "code", 0.5, reachable=False)["basis"]
        == "nothing to go by yet: no run has ended here"
    )
    for run_id in ("plan-1", "plan-2"):
        rt.runs.add(run_id, "plan", run_id, plan_id="pocket-synth", state="succeeded")
    rt.runs.add("writing", "plan_generate", "writing", state="succeeded")  # a plan written is no run of tasks
    rt.runs.add("going", "run", "going", state="running")  # nor is a run still going
    basis = estimate.estimate(rt, "code", 0.5, reachable=False)["basis"]
    assert basis == "nothing to go by yet: no similar one-task run has ended here (2 plan runs have)"
    # One-task runs that ended but are no similar run, each named for why.
    log_run(rt, "cancelled", cost=0.1, seconds=10, state="cancelled")
    log_run(rt, "docs", cost=0.1, seconds=10, domain="docs")
    rt.runs.add("free", "run", "free", state="succeeded")  # no cost recorded
    assert estimate.ended_elsewhere(rt.runs.recent(200), "code") == [
        "2 plan runs",
        "1 run in another domain",
        "1 run that ended without a verdict",
        "1 run with no cost",
    ]
    assert estimate.estimate(rt, "code", 0.5, reachable=False)["basis"] == (
        "nothing to go by yet: no similar one-task run has ended here (2 plan runs, 1 run in another domain, "
        "1 run that ended without a verdict and 1 run with no cost have)"
    )
    assert estimate.ended_elsewhere([{"kind": "plan", "state": "failed"}], "code") == ["1 plan run"]
    assert estimate._likely([], [], ["1 plan run"])[1].endswith("(1 plan run has)")  # one run: "has"


def test_the_worst_case_needs_every_climb_rungs_prices() -> None:
    from hermes_plugin_roko import estimate

    ladder = [
        {
            "rung": "cheap",
            "price_in": 1.0,
            "price_out": 2.0,
            "chat_ok": True,
            "why_not": None,
            "starts": ["focused"],
        },
        {"rung": "mid", "price_in": None, "price_out": None, "chat_ok": True, "why_not": None, "starts": []},
    ]
    assert estimate.worst_usd(0.01, ["cheap"], ladder, 1.0) == 0.02
    assert estimate.worst_usd(0.01, ["cheap", "mid"], ladder, 1.0) is None  # mid's prices unknown
    assert estimate.worst_usd(None, ["cheap"], ladder, 1.0) is None
    # The start rung is the tier's, or the first above it a run from Hermes can use.
    ladder[0]["why_not"] = "its provider is not set up in this workspace"
    assert estimate.climb_path(ladder) == ["mid"]
    assert estimate.climb_path(None) == []


def test_the_checks_found_are_the_ones_roko_runs_on_a_request_of_that_domain(tmp_path: Path) -> None:
    from hermes_plugin_roko import estimate

    data = {
        "gates": {
            "rungs": [
                {"name": "test", "command": "python3 -m unittest -q"},
                {"name": "lint", "command": "ruff check .", "required": False},
                {"name": "review", "kind": "judge", "rubric": "rubric.md", "artefacts": ["*.py"]},
                {"name": "advice", "command": "true", "advisory": True},
                {"name": "blank", "command": "  "},
                {"name": "smoke", "command": "./smoke.sh"},
            ],
            "packs": {
                "research": {
                    "rungs": [
                        {"name": "cite", "kind": "citations", "artefacts": ["*.md"]},
                        {"name": "links", "command": "lychee ."},
                    ]
                }
            },
        }
    }
    assert estimate.request_checks(data, tmp_path, "code") == [
        {
            "name": "verify[0:test]",
            "phase": "test",
            "command": "python3 -m unittest -q",
            "source": "roko.toml",
        },
        {"name": "verify[1:smoke]", "phase": "smoke", "command": "./smoke.sh", "source": "roko.toml"},
    ]
    assert estimate.request_checks(data, tmp_path, "research") == [
        {"name": "verify[0:links]", "phase": "links", "command": "lychee .", "source": "roko.toml"}
    ]
    assert estimate.request_checks(data, tmp_path, "docs") == []  # no pack: roko runs it unchecked
    # A code request with no check in roko.toml: roko's compile check in a Rust or Go workspace, else none.
    assert estimate.request_checks({}, tmp_path, "code") == []
    (tmp_path / "go.mod").write_text("module x\n")
    assert estimate.request_checks({}, tmp_path, "code") == [
        {"name": "verify[0:compile]", "phase": "compile", "command": "go build ./...", "source": "roko"}
    ]
    (tmp_path / "Cargo.toml").write_text("[package]\n")
    assert estimate.request_checks({}, tmp_path, "code")[0]["command"] == "cargo check --workspace"
    assert estimate.request_checks(data, None, "code") is None  # no workspace to read


def test_the_estimate_route_checks_its_parameters_as_a_run_does(laddered: Runtime) -> None:
    from hermes_plugin_roko import ui_api
    from hermes_plugin_roko.errors import RokoError

    found = ui_api.estimate_request(laddered, {"prompt": "add a flag"})["estimate"]
    assert found["max_usd"] == laddered.settings().max_run_usd and found["start_rung"] == "cheap"
    assert (
        ui_api.estimate_request(laddered, {"max_usd": "0.25", "domain": "docs"})["estimate"]["max_usd"]
        == 0.25
    )
    for params in ({"prompt": "x" * 8_001}, {"domain": "chain"}, {"max_usd": "lots"}, {"max_usd": "500"}):
        with pytest.raises(RokoError) as raised:
            ui_api.estimate_request(laddered, params)
        assert raised.value.code.value == "invalid"


def test_a_run_from_the_ui_keeps_its_domain_for_the_estimate(laddered: Runtime, fake: FakeRoko) -> None:
    from hermes_plugin_roko import ui_api

    started = ui_api.start_run(
        laddered, {"prompt": "survey the parsers", "max_usd": 0.5, "domain": "research"}
    )
    assert (laddered.runs.get(started["run_id"]) or {}).get("domain") == "research"
    coded = ui_api.start_run(laddered, {"prompt": "add a flag", "max_usd": 0.5})
    assert "domain" not in (laddered.runs.get(coded["run_id"]) or {})  # code, the default


def test_the_estimate_route_answers_the_composer(laddered: Runtime) -> None:
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    from hermes_plugin_roko import ui_api

    app = fastapi.FastAPI()
    app.include_router(ui_api.build_router(lambda: laddered), prefix="/api/plugins/roko")
    with TestClient(app) as client:
        body = client.get("/api/plugins/roko/estimate", params={"chars": "10", "max_usd": "0.5"}).json()
        refused = client.get("/api/plugins/roko/estimate", params={"domain": "chain"}).json()
    assert body["ok"] is True and body["estimate"]["climb"] == ["cheap", "mid", "strong"]
    assert body["estimate"]["basis"] == "nothing to go by yet: no run has ended here"
    assert refused["ok"] is False and refused["error"]["code"] == "invalid"


def test_a_plan_writing_card_says_what_became_of_the_checks_its_request_states() -> None:
    """roko's planner (75a1a08bf, gap-dc5d7c) reports what became of each check the request's spec states: kept by
    a verify step, kept only shallowly, dropped with a reason, or missing."""
    report = {
        "total": 4,
        "kept": 1,
        "shallow": 1,
        "dropped": 1,
        "missing": 1,
        "regenerated": True,
        "checks": [
            {
                "id": "SC1",
                "check": "`slugify('A b')` returns 'a-b'",
                "status": "kept",
                "task": "T1",
                "criterion": "AC1",
            },
            {
                "id": "SC2",
                "check": "src/slug.py exists",
                "status": "shallow",
                "task": "T1",
                "reason": "test -f src/slug.py",
            },
            {
                "id": "SC3",
                "check": "a person enjoys the result",
                "status": "dropped",
                "reason": "needs a person to judge it",
            },
            {"id": "SC4", "check": "unicode titles keep their letters", "status": "missing"},
            {"id": "SC5", "check": "odd", "status": "lost"},  # not a status roko gives
        ],
    }
    summary = {
        "run_id": "op-1",
        "kind": "plan_generate:slugify",
        "state": "succeeded",
        "result": {"slug": "slugify", "task_count": 2, "cost_usd": 0.01, "source_checks": report},
    }
    card = rundata.plan_generation_card("op-1", summary, None)
    checks = card["source_checks"]
    assert {
        key: checks[key] for key in ("total", "kept", "shallow", "dropped", "missing", "regenerated")
    } == {
        "total": 4,
        "kept": 1,
        "shallow": 1,
        "dropped": 1,
        "missing": 1,
        "regenerated": True,
    }
    assert [
        (row["id"], row["status"], row["task"], row["criterion"], row["reason"]) for row in checks["checks"]
    ] == [
        ("SC1", "kept", "T1", "AC1", None),
        ("SC2", "shallow", "T1", None, "test -f src/slug.py"),
        ("SC3", "dropped", None, None, "needs a person to judge it"),
        ("SC4", "missing", None, None, None),
    ]
    # An older roko, or a request that states no check: no report.
    assert (
        rundata.plan_generation_card("op-2", {**summary, "result": {"slug": "x", "task_count": 1}}, None)[
            "source_checks"
        ]
        is None
    )


# -- plugin-review's questions 2, 3 and 5 (decided by the lead, 2026-10-17) ------------------------------------------


def log_learned(
    runtime: Runtime, run_id: str, *, cost: float | None, passed: int, tasks: int, first_prompt: Any = None
) -> None:
    """An ended run Hermes started, with what its card learned."""
    runtime.runs.add(run_id, "run", run_id, state="succeeded" if passed else "failed", max_usd=0.5)
    runtime.runs.update(
        run_id,
        cost_usd=cost,
        learning={
            "tasks": tasks,
            "passed": passed,
            "first_try": passed,
            "climbs": 0,
            "first_prompt": first_prompt,
        },
    )


def test_cost_per_verified_task_is_a_ratio_of_sums_failed_runs_included(rt: Runtime) -> None:
    """Question 2: the KPI is every ended run's cost over the verified tasks, not a mean of each run's ratio."""
    log_learned(rt, "a", cost=0.10, passed=1, tasks=1)
    log_learned(rt, "b", cost=0.30, passed=0, tasks=1)  # failed: its cost counts, it verified nothing
    log_learned(rt, "c", cost=0.02, passed=2, tasks=2)
    log_learned(rt, "d", cost=None, passed=1, tasks=1)  # its cost unknown: left out of both sums
    kpi = views.learning_view(rt)["kpis"]["cost_per_pass"]
    # The newest three (b, c, d): $0.32 over 2 verified tasks; a mean of the runs' ratios would have said $0.01.
    # The first three (a, b, c): $0.42 over 3.
    assert (kpi["value"], kpi["first"]) == (0.16, 0.14)
    assert kpi["series"] == [0.1, None, 0.01, None]


def test_the_first_try_line_shows_both_ns_its_design_and_either_direction(rt: Runtime) -> None:
    """Question 3: shown whichever way it points, only with 5 tasks a side, both n's always, and its design."""
    log_learned(rt, "a", cost=0.1, passed=1, tasks=5, first_prompt={"with": [2, 3], "without": [1, 2]})
    line = views.learning_view(rt)["lessons_first_try"]
    assert line == {
        "with": {"passed": 2, "of": 3, "rate": 0.6667},
        "without": {"passed": 1, "of": 2, "rate": 0.5},
        "design": "observational",
        "comparable": False,
        "difference": None,
        "note": "too few tasks to compare yet (n = 3 and 2)",
    }
    # Five a side, and the tasks without a lesson did better: said as it is.
    log_learned(rt, "b", cost=0.1, passed=1, tasks=6, first_prompt={"with": [1, 2], "without": [4, 4]})
    line = views.learning_view(rt)["lessons_first_try"]
    assert (line["with"], line["without"]) == (
        {"passed": 3, "of": 5, "rate": 0.6},
        {"passed": 5, "of": 6, "rate": 0.8333},
    )
    assert (line["comparable"], line["difference"], line["design"]) == (True, -0.2333, "observational")
    assert line["note"] == "observational: tasks without a lesson differ in other ways too"
    # When roko's control arm withheld the lessons at random, the comparison is with those tasks, and says so.
    log_learned(
        rt,
        "c",
        cost=0.1,
        passed=1,
        tasks=5,
        first_prompt={"with": [3, 3], "without": [0, 1], "withheld": [2, 5]},
    )
    line = views.learning_view(rt)["lessons_first_try"]
    assert line["design"] == "control_arm"
    assert (line["with"]["of"], line["without"]) == (8, {"passed": 2, "of": 5, "rate": 0.4})
    assert line["note"] == "randomised: roko's control arm withheld the lessons from the tasks without"


def test_a_tasks_first_prompt_counts_as_withheld_when_the_control_arm_held_its_lessons_back() -> None:
    def task(outcome: str, lesson_ids: list[str], left_out: list[dict[str, str]]) -> dict[str, Any]:
        first = {
            "outcome": outcome,
            "reason": "start",
            "lesson_ids": lesson_ids,
            "prompt": {"left_out": left_out},
        }
        return {"task_id": "T", "outcome": outcome, "climb": [first], "lessons": []}

    held = [{"kind": "knowledge", "id": "k1", "reason": "withheld_arm"}]
    card = {
        "tasks": [
            task("passed", ["k1"], []),
            task("failed", [], held),
            task("passed", [], [{"kind": "knowledge", "id": "k2", "reason": "token_budget"}]),
            task(
                "passed", [], [{"kind": "playbook", "id": "p1", "reason": "withheld_arm"}]
            ),  # a playbook, not a lesson
        ],
        "roko_cost": None,
    }
    assert rundata.learning_record(card)["first_prompt"] == {
        "with": [1, 1],
        "without": [2, 2],
        "withheld": [0, 1],
    }


def test_the_estimate_takes_the_requests_length_never_the_request(laddered: Runtime) -> None:
    """Question 5: a request in a URL ends up in logs and history, so callers send `chars`; an older caller's
    `prompt` is read for its length alone, this release only."""
    from hermes_plugin_roko import ui_api
    from hermes_plugin_roko.errors import RokoError

    assert ui_api.estimate_request(laddered, {"chars": "120"})["estimate"]["start_rung"] == "cheap"
    assert ui_api.estimate_request(laddered, {"chars": "8000"})["estimate"]["climb"]
    for params in (
        {"chars": "8001"},
        {"chars": "-1"},
        {"chars": "lots"},
        {"chars": "1.5"},
        {"prompt": "x" * 8_001},
    ):
        with pytest.raises(RokoError) as raised:
            ui_api.estimate_request(laddered, params)
        assert raised.value.code.value == "invalid", params
    told = ui_api.estimate_request(laddered, {"prompt": "add the secret flag"})
    assert "secret" not in json.dumps(told)


# -- P-1: while a run goes, the model sees roko at work (dogfood-will Run 4, G5a) ----------------------------------


def tool_start(tool: str, target: str, ident: str, attempt: int = 1) -> dict[str, Any]:
    record = {
        "kind": "tool_start",
        "live": True,
        "task_id": "T1",
        "plan_id": "p",
        "attempt": attempt,
        "payload": {"tool": tool, "target": target, "tool_id": ident},
    }
    return {
        "type": "agent_output",
        "plan_id": "p",
        "task_id": "T1",
        "attempt": attempt,
        "content": "\x1eroko.stream.v1 " + json.dumps(record),
        "ts_millis": int(time.time() * 1000),
    }


def test_a_running_runs_status_carries_what_roko_is_doing_now(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    """G5a's chat model saw "running · — of $0.20 · 2m00s" and did the work itself. The status now says what roko is
    doing: the model on its try, its tool steps so far, its last step, and how long ago roko last moved."""
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "implement synth/env.py", "max_usd": 0.2})["run_id"]
    now = int(time.time() * 1000)
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": now}
    fake.runs[run_id].events = [
        {"type": "task_started", **base, "title": "env"},
        {
            "type": "route_decided",
            **base,
            "attempt": 1,
            "model": "kimi-k2.6",
            "source": "ladder",
            "rung": "cheap",
        },
        {"type": "agent_spawned", **base, "attempt": 1, "model": "kimi-k2.6", "provider": "moonshot"},
        tool_start("Read", "synth/osc.py", "c1"),
        tool_start("Read", "synth/osc.py", "c1"),  # the same call again (trusted mode): one step
        tool_start("Write", "synth/env.py", "c2"),
        tool_start("Edit", "synth/env.py", "c3"),
    ]
    status = call(rt, "roko_status", {"run_id": run_id, "wait_secs": 0})
    live = status["live"]
    [task] = live["tasks"]
    assert {
        key: task[key] for key in ("task_id", "try", "model", "rung", "doing", "tool_steps", "last_step")
    } == {
        "task_id": "T1",
        "try": 1,
        "model": "kimi-k2.6",
        "rung": "cheap",
        "doing": "agent",
        "tool_steps": 3,
        "last_step": "Edit synth/env.py",
    }
    # roko reports a try's spend when the try ends: not yet, and the status says so rather than "—".
    assert task["spent_usd"] is None and live["spent_usd"] is None
    assert 0 <= live["quiet_s"] < 60 and live["summary_behind"] is False
    # plugin-safety's running step words it from `live` (their tests pin the words).
    assert "kimi-k2.6" in status["next"] and "Edit synth/env.py" in status["next"]
    # An ended run carries no live part.
    fake.runs[run_id].states = ["succeeded"]
    assert "live" not in call(rt, "roko_status", {"run_id": run_id, "wait_secs": 0})


def test_a_run_whose_events_say_it_ended_reads_ended_though_rokos_summary_lags(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    """bug-e529e3: roko's summary reads only the first 10,000 events, so a long run's summary says "running" after it
    ended. The card follows the events, and says the summary is behind."""
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "implement synth/env.py", "max_usd": 0.2})["run_id"]
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000}
    fake.runs[run_id].events = [
        {"type": "agent_spawned", **base, "attempt": 1, "model": "kimi-k2.6"},
        {"type": "run_completed", "run_id": run_id, "outcome": "cancelled", "duration_ms": 145_000},
    ]
    card = views.card(rt, run_id)
    assert (card["state"], card["summary_behind"]) == ("cancelled", True)
    assert "live" not in call(rt, "roko_status", {"run_id": run_id, "wait_secs": 0})


def test_a_chat_cancel_takes_the_persons_reason_onto_the_card(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    fake.run_script = ["running"]
    run_id = call(rt, "roko_run", {"prompt": "implement synth/env.py", "max_usd": 0.2})["run_id"]
    answer = call(rt, "roko_cancel", {"run_id": run_id, "reason": "the person said to stop: wrong file"})
    assert len(views.cancel_reason("x" * 500) or "") == 200  # the schema's 200 characters
    assert answer["state"] == "cancelled"
    assert answer["cancelled_by"]["by"] == "chat"
    card = views.card(rt, run_id)
    assert {key: card["cancelled_by"][key] for key in ("by", "reason")} == {
        "by": "chat",
        "reason": "the person said to stop: wrong file",
    }
    # From a page: the person's Cancel, with a reason when the page asks for one.
    fake.run_script = ["running"]
    other = call(rt, "roko_run", {"prompt": "again", "max_usd": 0.2})["run_id"]
    from hermes_plugin_roko import ui_api

    ui_api.cancel_run(rt, other, {"reason": "not now"})
    assert (views.card(rt, other)["cancelled_by"] or {}).get("by") == "page"
    # A run that had ended is not recorded as cancelled.
    fake.run_script = ["succeeded"]
    done = call(rt, "roko_run", {"prompt": "done", "max_usd": 0.2})["run_id"]
    call(rt, "roko_status", {"run_id": done, "wait_secs": 0})
    call(rt, "roko_cancel", {"run_id": done, "reason": "late"})
    assert views.card(rt, done)["cancelled_by"] is None


# -- P-2: the model each try ran on, named (dogfood-will Run 4, G5c) -------------------------------------------------


def test_the_status_names_the_model_each_try_ran_on(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    """G5c's chat could not say which model ran it. The status names each try's model, from roko's route and its
    verdict on the try, never from an agent row's name (roko's run-level row says "claude", bug-c7de28)."""
    fake.run_script = ["succeeded"]
    run_id = call(rt, "roko_run", {"prompt": "implement synth/env.py", "max_usd": 0.2})["run_id"]
    base = {"plan_id": "p", "task_id": "T1", "ts_millis": 1_792_000_000_000}
    fake.runs[run_id].events = [
        {
            "type": "route_decided",
            **base,
            "attempt": 1,
            "model": "gpt-oss-120b",
            "source": "ladder",
            "rung": "cheap",
        },
        {
            "type": "agent_spawned",
            **base,
            "attempt": 1,
            "model": "claude",
        },  # an agent row's name, not the model
        {
            "type": "attempt_settled",
            **base,
            "attempt": 1,
            "rung": "cheap",
            "verdict": "gate_failed",
            "blame": "agent",
            "model": "gpt-oss-120b",
            "climbed": False,
        },
        {
            "type": "route_decided",
            **base,
            "attempt": 2,
            "model": "kimi-k2.6",
            "source": "ladder",
            "rung": "cheap",
        },
        {"type": "agent_spawned", **base, "attempt": 2, "model": "claude"},
        {"type": "task_completed", **base, "outcome": "passed"},
    ]
    status = call(rt, "roko_status", {"run_id": run_id, "wait_secs": 0})
    assert status["models"] == ["gpt-oss-120b", "kimi-k2.6"]
    assert status["tries"] == [
        "T1: try 1 on gpt-oss-120b (cheap): failed; try 2 on kimi-k2.6 (cheap): passed"
    ]
    assert "claude" not in json.dumps(status)


# -- P-3: spend from a terminal counts somewhere (dogfood-will Run 4) ------------------------------------------------


def test_todays_spend_says_it_is_from_hermes_and_roko_s_ledger_gives_the_whole_day(laddered: Runtime) -> None:
    """Run 4: two terminal runs spent $0.36 that "today" ($0.20, from Hermes) left out. The counter says whose it is,
    and roko's own daily ledger gives the whole workspace's day (UTC)."""
    from datetime import UTC, datetime, timedelta

    workdir = laddered.settings().workdir
    assert workdir is not None
    now = datetime.now(UTC)
    today, yesterday = now.isoformat(), (now - timedelta(days=1)).isoformat()
    ledger = workdir / ".roko" / "learn" / "costs.jsonl"
    ledger.parent.mkdir(parents=True)
    rows = [
        {"attempt_key": "old-run:p:T1:1", "timestamp": yesterday, "cost_usd": 1.0},
        {"attempt_key": "graph-svf-g4-20cd2f9d:svf-g4:SVF:1", "timestamp": today, "cost_usd": 0.1413},
        {"attempt_key": "graph-svf-g4-4624823f:svf-g4:SVF:1", "timestamp": today, "cost_usd": 0.2165},
        {"attempt_key": "6a0a4818:env-g5:ENV:1", "timestamp": today, "cost_usd": 0.0854},
        {"attempt_key": "6a0a4818:env-g5:ENV:1", "timestamp": today, "role": "helper", "cost_usd": 0.1146},
        {"attempt_key": "x", "timestamp": today},  # no cost
    ]
    ledger.write_text("".join(json.dumps(row) + "\n" for row in rows) + "not json\n")
    spend = views.ui_overview(laddered)["spend"]
    assert (spend["from"], spend["roko_today_usd"]) == ("hermes", 0.5578)
    # Without roko's workspace there is no ledger to read.
    assert rundata.CardCache().roko_today(None) is None


# -- R7: roko's per-task plan estimate (roko-demos, gap-6605f7, c193d3516) ------------------------------------------


def test_the_plan_sheet_takes_rokos_per_task_estimate(tmp_path: Path, fake: FakeRoko) -> None:
    from hermes_plugin_roko import plansheet

    workspace = sequencer_workspace(tmp_path, fake)

    def task_estimate(task_id: str, rung: str, likely: float, worst: float) -> dict[str, Any]:
        return {
            "task_id": task_id,
            "start_rung": rung,
            "model": "gpt-oss-120b",
            "pinned": False,
            "start_cost_usd": likely,
            "likely_cost_usd": likely,
            "likely_duration_secs": 131.0,
            "worst_cost_usd": worst,
            "worst_duration_secs": 787.0,
            "worst_rungs": ["cheap", "cheap", "mid", "mid", "strong", "strong"],
            "first_try_rate": 1.0,
            "basis": "same_role_and_tier",
            "samples": 3,
        }

    fake.estimate = {
        "plan_id": "pocket-sequencer",
        "confidence": "medium",
        "note": "Based on 12 settled attempts of the same role and tier",
        "price_snapshot": "prices-2026-09-28",
        "estimate": {
            "total_cost_usd": 0.1948,
            "total_duration_secs": 524.0,
            "worst_cost_usd": 1.29,
            "worst_duration_secs": 3148.0,
            "cap_usd": 0.25,
            "unpriced_tasks": [],
        },
        "by_rung": [{"rung": "cheap", "model": "gpt-oss-120b", "tasks": 1, "likely_cost_usd": 0.0487}],
        "per_task": [task_estimate("T1", "cheap", 0.0487, 0.3225)],
    }
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    try:
        sheet = plansheet.plan_sheet(runtime, "pocket-sequencer")
    finally:
        runtime.close()
    estimate = sheet["estimate"]
    assert (estimate["likely_usd"], estimate["worst_usd"], estimate["cap_usd"]) == (0.1948, 1.29, 0.25)
    assert estimate["unpriced_tasks"] == [] and estimate["confidence"] == "medium"
    cheap = next(row for row in estimate["by_rung"] if row["rung"] == "cheap")
    assert cheap["likely_usd"] == 0.0487 and "T1" in cheap["tasks"]
    t1 = sheet["tasks"][0]
    assert t1["estimate"] == {
        "likely_usd": 0.0487,
        "likely_secs": 131,
        "worst_usd": 0.3225,
        "worst_rungs": ["cheap", "cheap", "mid", "mid", "strong", "strong"],
        "first_try_rate": 1.0,
        "basis": "same_role_and_tier",
        "samples": 3,
    }
    # A roko before R7: no per-task estimate, and the plan's figures by rung stay null.
    assert sheet["tasks"][1]["estimate"] is None


# -- the mori import's "Also required" block (the lead's option B for roko-demos' import) ---------------------------


def test_a_tasks_also_required_block_becomes_its_own_list() -> None:
    from hermes_plugin_roko import plansheet

    described = (
        "Implement the envelope.\n\nAlso required, not checked automatically:\n(the review task judges these)\n"
        "- The envelope never clicks at note-on\n- Release sounds natural, not cut\n"
    )
    assert plansheet.also_required(described) == (
        "Implement the envelope.",
        ["The envelope never clicks at note-on", "Release sounds natural, not cut"],
        True,
        0,
    )
    # Without a review task the block has no judge line; without the block, nothing changes.
    bare = "Do it.\n\nAlso required, not checked automatically:\n- Keep it small\n"
    assert plansheet.also_required(bare) == ("Do it.", ["Keep it small"], False, 0)
    assert plansheet.also_required("Just a task.") == ("Just a task.", [], False, 0)
    # A person's lines after the block stay in the description, below the ones before it (plugin-review's case).
    edited = (
        "Intro line.\nAlso required, not checked automatically:\n- a\n\n- b\n"
        "A closing note the person added.\nAnd one more."
    )
    assert plansheet.also_required(edited) == (
        "Intro line.\n\nA closing note the person added.\nAnd one more.",
        ["a", "b"],
        False,
        0,
    )
    # Escapes cleaned.
    many = "x\n\nAlso required, not checked automatically:\n" + "".join(
        f"- item \x1b[31m{n}\x1b[0m\n" for n in range(30)
    )
    _, items, _, more = plansheet.also_required(many)
    assert (len(items), items[0], more) == (20, "item 0", 10)


def test_a_long_also_required_block_never_loses_a_line() -> None:
    from hermes_plugin_roko import plansheet

    # Shaped like the corpus' largest block (59-policy-cage-risk-engine T3 at roko 537ac5411): 39 lines, then the
    # sentence naming the file that holds the lines past roko's own size limit. The pages show 20 items of 600
    # characters, so the other 19 lines stay in the description, where they show too: none is lost.
    sentence = (
        "3 more lines no check proves are in `mori-also-required-T3.txt` beside this plan; read them too."
    )
    bullets = [
        f"- test_risk_limit_{n} passes: the cage refuses an order past limit {n}" + "." * n for n in range(39)
    ]
    largest = "Build the risk engine.\n\n" + "\n".join(
        ["Also required, not checked automatically:", "(the review task judges these)", *bullets, sentence]
    )
    text, items, judged, more = plansheet.also_required(largest)
    assert (len(items), judged, more) == (20, True, 19)
    assert items == [bullet[2:] for bullet in bullets[:20]]
    assert text == "Build the risk engine.\n\n" + "\n".join(bullets[20:]) + f"\n\n{sentence}"
    # 41 lines: 20 items, and lines 21 to 41 in the description, after a blank line and above what follows.
    over = (
        "x\n\nAlso required, not checked automatically:\n"
        + "".join(f"- item {n}\n" for n in range(41))
        + "Closing."
    )
    text, items, _, more = plansheet.also_required(over)
    assert (len(items), items[-1], more) == (20, "item 19", 21)
    assert text == "x\n\n" + "\n".join(f"- item {n}" for n in range(20, 41)) + "\n\nClosing."
    # A line over 600 characters is cut with a visible "…"; the task text keeps it whole.
    long_line = "y" * 1726
    _, items, _, _ = plansheet.also_required(
        f"Do it.\n\nAlso required, not checked automatically:\n- {long_line}\n"
    )
    assert items == ["y" * 599 + "…"]


# -- chat cards: the line the model forgets (dogfood-desktop's chat take) ---------------------------------------------


def _reply(text: str, session: str, turn: str, platform: str = "desktop") -> str | None:
    from hermes_plugin_roko import cards

    return cards.transform_llm_output(
        response_text=text, session_id=session, model="m", platform=platform, turn_id=turn
    )


def test_a_started_run_gets_its_card_line_when_the_model_forgets_it(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    from hermes_plugin_roko import cards

    fake.run_script = ["running"]
    call = make_session_call(rt, "cards-1")
    run_id = call("roko_run", {"prompt": "add a flag", "max_usd": 0.2})["run_id"]
    # The model wrote no card line: the desktop reply gets one, and the next turn nothing.
    assert _reply("Started it.", "cards-1", "t1") == f'Started it.\n\n::roko-run{{id="{run_id}"}}'
    assert _reply("Hello.", "cards-1", "t2") is None
    # A line the model wrote counts, in another quote style and among other attributes: no second card.
    run_id = call("roko_run", {"prompt": "again", "max_usd": 0.2})["run_id"]
    assert _reply(f"Here it is:\n::roko-run{{title='x' id='{run_id}'}}", "cards-1", "t3") is None
    # Not on another surface, where the raw line would show.
    call("roko_run", {"prompt": "once more", "max_usd": 0.2})
    assert _reply("Started.", "cards-1", "t4", platform="tui") is None
    # Nothing without text; the turn's end forgets its start, so it never reaches the next turn.
    call("roko_run", {"prompt": "and again", "max_usd": 0.2})
    assert _reply("", "cards-1", "t5") is None
    cards.on_session_end(session_id="cards-1", turn_id="t5")
    assert _reply("Hi.", "cards-1", "t6") is None


def test_a_plan_writing_gets_its_plans_card_and_two_starts_get_two_lines(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    fake.run_script = ["running"]
    call = make_session_call(rt, "cards-2")
    writing = call("roko_plan_generate", {"prompt": "write a plan for the synth"})
    started = call("roko_run", {"prompt": "add a flag", "max_usd": 0.2})["run_id"]
    elsewhere = make_session_call(rt, "cards-3")("roko_run", {"prompt": "elsewhere", "max_usd": 0.2})
    # 0.8.0: the writing's card is its plan's, which follows the writing and then shows the plan (P-45, R1l).
    reply = _reply("On it.", "cards-2", "t1")
    assert reply == f'On it.\n\n::roko-plan{{id="{writing["plan_id"]}"}}\n::roko-run{{id="{started}"}}'
    assert elsewhere["run_id"] not in reply  # another session's start stays with it
    # The model's own plan card names the writing.
    writing = call("roko_plan_generate", {"prompt": "write another plan"})
    assert writing["plan_id"]
    assert _reply(f'The plan:\n\n::roko-plan{{id="{writing["plan_id"]}"}}', "cards-2", "t2") is None


def test_the_card_hooks_are_registered_where_hermes_gates_hooks_per_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import hermes_plugin_roko
    from hermes_plugin_roko import _hermes, cards

    monkeypatch.setattr(_hermes, "hooks_gated_per_call", lambda: True)
    ctx = FakeContext({})
    hermes_plugin_roko.register(ctx)
    assert ctx.hooks[:3] == [
        ("transform_llm_output", cards.transform_llm_output),
        ("on_interim_message", cards.on_interim_message),
        ("on_session_end", cards.on_session_end),
    ]
    assert [name for name, _ in ctx.hooks[3:]] == ["pre_llm_call"]  # the run-end hook (P-13)
    monkeypatch.setattr(_hermes, "hooks_gated_per_call", lambda: False)
    old = FakeContext({})
    hermes_plugin_roko.register(old)
    assert old.hooks == []  # Hermes 0.21.0 gated a hook per callback: one session's turn could skip another's


def test_only_a_card_line_the_desktop_shows_names_its_run(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    fake.run_script = ["running"]
    call = make_session_call(rt, "cards-4")

    def start() -> str:
        run_id: str = call("roko_run", {"prompt": "add a flag", "max_usd": 0.2})["run_id"]
        return run_id

    # Shown, so named: single quotes at the end of a plain sentence (hermes-update: Hermes renders it there).
    run_id = start()
    assert _reply(f"Started it ::roko-run{{id='{run_id}'}}", "cards-4", "t1") is None
    # Not shown, so the plugin still adds a proper line: an unquoted id, `#id`, a code fence, and a paragraph
    # holding inline markdown.
    unshown = [
        "Started ::roko-run{{id={run}}}",
        "Started ::roko-run{{#{run}}}",
        '```\n::roko-run{{id="{run}"}}\n```',
        '**Started** it ::roko-run{{id="{run}"}}',
    ]
    for turn, said in enumerate(unshown, start=2):
        run_id = start()
        reply = said.format(run=run_id)
        assert _reply(reply, "cards-4", f"t{turn}") == f'{reply}\n\n::roko-run{{id="{run_id}"}}'
    # Round v7 (hermes-pilot P-3): a code span holding only the card line becomes the card, and no second line.
    run_id = start()
    assert _reply(f'The line is `::roko-run{{id="{run_id}"}}`', "cards-4", "t9") == (
        f'The line is\n\n::roko-run{{id="{run_id}"}}'
    )


def test_a_card_line_in_the_turns_interim_text_names_its_run(
    fake: FakeRoko, rt: Runtime, approvals: Approvals
) -> None:
    from hermes_plugin_roko import cards

    # plugin-review F12: the model showed the card beside its next tool call, and its final reply has no line.
    fake.run_script = ["running"]
    run_id = make_session_call(rt, "cards-5")("roko_run", {"prompt": "add a flag", "max_usd": 0.2})["run_id"]
    cards.on_interim_message(
        text=f'Started. ::roko-run{{id="{run_id}"}}', session_id="cards-5", turn_id="t1", surface="desktop"
    )
    assert _reply("Done.", "cards-5", "t1") is None


def test_an_escaped_price_loses_its_backslash_in_a_roko_turn_on_the_desktop() -> None:
    from hermes_plugin_roko import cards

    # gpt-5.4-mini writes \$0.039, and the desktop shows prices as text: in a turn where roko ran, `\$` before a
    # digit is `$` outside code and math. Here the reply holds a roko card line.
    card = '\n\n::roko-run{id="run-1"}'
    said = "It cost \\$0.039 so far (`price=\\$5`), under the \\$0.50 cap." + card
    assert (
        _reply(said, "cards-6", "t1") == "It cost $0.039 so far (`price=\\$5`), under the $0.50 cap." + card
    )
    # A code span, a fence or `$…$` math keeps it, and so does every other backslash.
    assert _reply("Run `echo \\$5` to see it." + card, "cards-6", "t2") is None
    assert _reply("```\nprice=\\$5\n```" + card, "cards-6", "t3") is None
    assert _reply("A lone \\$ sign, \\$x, and C:\\\\$5." + card, "cards-6", "t4") is None
    assert _reply("So $a + \\$5 = b$ and \\$3." + card, "cards-6", "t5") == "So $a + \\$5 = b$ and $3." + card
    # Another surface keeps the reply as it is.
    assert _reply("It cost \\$0.039." + card, "cards-6", "t6", platform="tui") is None
    # F13: a chat with no roko in its turn is never touched.
    assert _reply("The lunch was \\$5.", "cards-6", "t7") is None
    # A start noted this turn, or a card in its interim text, makes it a roko turn.
    cards.started("cards-6", "run-2")
    assert _reply("Spent \\$0.02.", "cards-6", "t8") == 'Spent $0.02.\n\n::roko-run{id="run-2"}'
    cards.on_interim_message(text=card, session_id="cards-6", turn_id="t9")
    assert _reply("Spent \\$0.02.", "cards-6", "t9") == "Spent $0.02."


def make_session_call(rt: Runtime, session_id: str) -> Any:
    """Call a tool as Hermes would, in session `session_id`."""
    from hermes_plugin_roko.tools import make_handlers

    handlers = make_handlers(rt)

    def invoke(name: str, args: dict[str, Any]) -> dict[str, Any]:
        result: dict[str, Any] = json.loads(handlers[name](args, task_id="task-1", session_id=session_id))
        return result

    return invoke

"""0.8.0 (round v7, P-7): a cap for plan writing.

"Cap the plan writing at $0.60" ran under roko.toml's [authoring] max_generation_usd ($2.00 by default), and the chat
told the person nothing: roko_plan_generate had no cap. roko since 55d0acda8 (gap-33d458) takes plan_generate's
`max_usd` and answers with the cap that applies (`max_usd`, `max_usd_source`: request or config). The plugin sends a
cap only to a roko that declares it, refuses one an older roko could not keep, and names the cap that applies.
"""

from __future__ import annotations

import json
import types
from collections.abc import Iterator
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import catalog, rundata, ui_api, views
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

REQUEST = "Add a sub oscillator with its own level and octave switch."


class CappedRoko(FakeRoko):
    """roko since 55d0acda8: plan_generate declares `max_usd`."""

    def __post_init__(self) -> None:
        super().__post_init__()
        self.tool_args = {"plan_generate": ["prompt", "spec_path", "title", "max_usd"]}


@pytest.fixture
def capped() -> Iterator[CappedRoko]:
    server = CappedRoko().start()
    try:
        yield server
    finally:
        server.stop()


def test_a_cap_the_person_names_goes_to_roko_and_is_said_back(
    capped: CappedRoko, approvals: Approvals
) -> None:
    rt = Runtime(FakeContext({"url": capped.url}))
    try:
        started = call(rt, "roko_plan_generate", {"prompt": REQUEST, "max_usd": 0.6})
        assert capped.tool_calls("plan_generate")[0]["max_usd"] == 0.6
        assert "up to $0.60" in approvals.asked[0]["message"]
        assert (started["max_usd"], started["max_usd_source"]) == (0.6, "request")
        assert rt.runs.get(started["run_id"])["max_usd"] == 0.6
        # Without one, roko's own limit applies, and the answer names it.
        plain = call(rt, "roko_plan_generate", {"prompt": REQUEST})
        assert "max_usd" not in capped.tool_calls("plan_generate")[1]
        assert "roko's own limit" in approvals.asked[1]["message"]
        assert (plain["max_usd"], plain["max_usd_source"]) == (2.0, "config")
        assert "$2.00" in plain["next"] and "[authoring] max_generation_usd" in plain["next"]
    finally:
        rt.close()


@pytest.mark.parametrize("cap", [0, -1, "lots", 99.0])
def test_a_cap_roko_would_not_take_is_refused_before_anything_is_asked(
    capped: CappedRoko, approvals: Approvals, cap: Any
) -> None:
    rt = Runtime(FakeContext({"url": capped.url}))
    try:
        with pytest.raises(RokoError) as refused:
            call(rt, "roko_plan_generate", {"prompt": REQUEST, "max_usd": cap})
        assert refused.value.code is Code.INVALID
        assert approvals.asked == [] and capped.tool_calls("plan_generate") == []
    finally:
        rt.close()


def test_an_older_roko_cannot_keep_a_cap_so_one_is_refused_and_none_is_fine(
    fake: FakeRoko, approvals: Approvals
) -> None:
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        with pytest.raises(RokoError, match="cannot cap a plan writing") as refused:
            call(rt, "roko_plan_generate", {"prompt": REQUEST, "max_usd": 0.6})
        assert refused.value.code is Code.INVALID and fake.tool_calls("plan_generate") == []
        started = call(rt, "roko_plan_generate", {"prompt": REQUEST})
        assert "max_usd" not in fake.tool_calls("plan_generate")[0] and started["max_usd"] is None
    finally:
        rt.close()


def test_the_cap_shows_on_the_writing_line_on_the_card_and_on_the_overview(capped: CappedRoko) -> None:
    summary = {
        "state": "running",
        "elapsed_secs": 12,
        "progress": {"stage": "planning", "attempt": 1, "attempts": 1, "cost_usd": 0.04, "max_usd": 0.6},
    }
    card = rundata.plan_generation_card("w-1", summary, {"label": "P2.1", "max_usd": 0.6})
    assert card["writing"]["text"] == "writing the plan: planning · attempt 1 of 1 · 0:12 · $0.04 of $0.60"
    assert card["max_usd"] == 0.6
    rt = Runtime(FakeContext({"url": capped.url}))
    try:
        assert views.ui_overview(rt)["plan_writing_cap"] is True
        # The page's plan writing takes a cap too.
        started = ui_api.start_run(rt, {"prompt": REQUEST, "plan": True, "max_usd": 0.75})
        assert capped.tool_calls("plan_generate")[0]["max_usd"] == 0.75 and started["max_usd"] == 0.75
    finally:
        rt.close()


def test_the_tool_offers_a_cap_and_says_what_applies_without_one() -> None:
    cap = catalog.tool_schemas(5.0)["roko_plan_generate"]["parameters"]["properties"]["max_usd"]
    assert cap["type"] == "number" and "5.00" in cap["description"] and "own limit" in cap["description"]


def _ledger(folder: Any, rows: list[dict[str, Any]]) -> None:
    """roko's ledger, `.roko/learn/costs.jsonl`, with `rows`."""
    learn = folder / ".roko" / "learn"
    learn.mkdir(parents=True, exist_ok=True)
    (learn / "costs.jsonl").write_text("".join(json.dumps(row) + "\n" for row in rows))


def _call(plan: str, role: str, usd: float, at: str) -> dict[str, Any]:
    """A ledger row of a plan writing: the planner's (`generate`), or roko's episode distiller's after it."""
    task = "generate" if role == "strategist" else f"plan:generate:{plan}"
    return {"plan_id": plan, "task_id": task, "role": role, "cost_usd": usd, "timestamp": at}


def test_an_ended_plan_writings_spend_is_rokos_ledgers_with_what_ran_after_the_planner(tmp_path: Any) -> None:
    """hermes-pilot P-47: phase 4's plan writing read $0.17 on its page and in the run list, the operation's planner
    call alone, and $0.20 on the Build tab: roko's ledger also has its episode distiller's $0.032 call, which roko
    runs after the planner. An ended writing's spend is the ledger's; the distiller is its side call."""
    _ledger(
        tmp_path,
        [
            _call("p4-editor", "strategist", 0.17289, "2026-10-21T04:55:51.291+00:00"),
            _call("p4-editor", "episode-distiller", 0.032107, "2026-10-21T04:55:52.922+00:00"),
            {"plan_id": "p3-sequencer", "task_id": "T1", "role": "implementer", "cost_usd": 0.5},
        ],
    )
    summary = {
        "state": "succeeded",
        "kind": "plan_generate:p4-editor",
        "result": {"slug": "p4-editor", "task_count": 7, "cost_usd": 0.17289},
    }
    logged = {"max_usd": 0.5, "started_at": "2026-10-21T04:54:53Z"}
    cache = rundata.CardCache()
    card = rundata.plan_generation_card("w-4", summary, logged)
    rundata.writing_from_ledger(card, cache, tmp_path)
    assert (card["cost_usd"], card["side_call_usd"]) == (0.204997, {"episode-distiller": 0.032107})
    assert card["headline"].endswith("$0.20 of $0.50 (incl. $0.03 after the planner)")
    # The run list's figure, refreshed without a card, is the same.
    client = types.SimpleNamespace(
        settings=types.SimpleNamespace(workdir=tmp_path, url="http://roko.invalid")
    )
    row = rundata.quick_totals(client, cache, "w-4", summary, logged)  # type: ignore[arg-type]
    assert (row["cost_usd"], row["side_call_usd"]) == (0.204997, {"episode-distiller": 0.032107})
    # While it writes, or without the ledger (a remote roko), the operation's own figure.
    for state, folder in (("running", tmp_path), ("succeeded", tmp_path / "elsewhere")):
        bare = rundata.plan_generation_card("w-5", {**summary, "state": state}, logged)
        rundata.writing_from_ledger(bare, cache, folder)
        assert (bare["cost_usd"], bare.get("side_call_usd")) == (0.17289, None)


def test_a_plan_written_twice_shows_each_writings_own_spend_and_the_list_catches_up(
    tmp_path: Any, fake: FakeRoko
) -> None:
    """P-47: the ledger keeps a plan's writings under its id, and phase 2's plan was written twice under one: each
    writing's row has its own planner calls and the distiller call after them, and the two make the Build tab's
    figure. A row logged with the planner's figure as its writing ended catches up once the ledger has the
    distiller's call, which roko runs as the writing ends."""
    plan = "p2-rumble"
    first = [
        _call(plan, "strategist", 0.048862, "2026-10-20T09:49:35+00:00"),
        _call(plan, "strategist", 0.035484, "2026-10-20T09:50:00+00:00"),
        _call(plan, "strategist", 0.041644, "2026-10-20T09:50:24+00:00"),
        _call(plan, "episode-distiller", 0.009473, "2026-10-20T09:50:25+00:00"),
    ]
    second = [
        _call(plan, "strategist", 0.047015, "2026-10-20T10:14:49+00:00"),
        _call(plan, "strategist", 0.037631, "2026-10-20T10:15:11+00:00"),
    ]
    _ledger(tmp_path, first + second)
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(tmp_path)}))
    try:
        writings = (
            ("w-a", "failed", "2026-10-20T09:49:11Z", 0.12599, str(tmp_path)),
            ("w-b", "succeeded", "2026-10-20T10:14:30Z", 0.084646, None),  # logged before 0.7.0: no project
        )
        for run_id, state, started, cost, project in writings:
            rt.runs.add(run_id, "plan_generate", "P2", plan_id=plan, state=state, project=project)
            rt.runs.update(run_id, started_at=started, cost_usd=cost)
        views.refresh_runs(rt, rt.client(), rt.runs.recent(10))
        row_a, row_b = rt.runs.get("w-a") or {}, rt.runs.get("w-b") or {}
        assert (row_a["cost_usd"], row_a["side_call_usd"]) == (0.135463, {"episode-distiller": 0.009473})
        # The second writing's distiller has not answered yet: its row keeps the planner's figure for now.
        assert row_b["cost_usd"] == 0.084646 and "side_call_usd" not in row_b
        _ledger(
            tmp_path,
            [*first, *second, _call(plan, "episode-distiller", 0.009508, "2026-10-20T10:15:12+00:00")],
        )
        views.refresh_runs(rt, rt.client(), rt.runs.recent(10))
        row_b = rt.runs.get("w-b") or {}
        assert (row_b["cost_usd"], row_b["side_call_usd"]) == (0.094154, {"episode-distiller": 0.009508})
        # Together they are the Build tab's figure for the plan's writing.
        whole = (rt.cards.ledger_by_plan(tmp_path) or {})["plans"][plan]["writing"]
        assert round(row_a["cost_usd"] + row_b["cost_usd"], 6) == round(whole, 6) == 0.229617
    finally:
        rt.close()

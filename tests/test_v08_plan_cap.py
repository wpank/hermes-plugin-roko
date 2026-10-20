"""0.8.0 (round v7, P-7): a cap for plan writing.

"Cap the plan writing at $0.60" ran under roko.toml's [authoring] max_generation_usd ($2.00 by default), and the chat
told the person nothing: roko_plan_generate had no cap. roko since 55d0acda8 (gap-33d458) takes plan_generate's
`max_usd` and answers with the cap that applies (`max_usd`, `max_usd_source`: request or config). The plugin sends a
cap only to a roko that declares it, refuses one an older roko could not keep, and names the cap that applies.
"""

from __future__ import annotations

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

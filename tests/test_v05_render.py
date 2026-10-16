"""Every task outcome and run state a run card can carry has its own glyph, so `/roko status` and the other
plain-text views never print the "?" that stands for one render does not know."""

from __future__ import annotations

import re
from pathlib import Path

from hermes_plugin_roko import catalog, render

RUNDATA = Path(render.__file__).with_name("rundata.py")

# roko's task outcomes: `node_outcome` in crates/roko-cli/src/runner/graph_tui_bridge.rs (what a task_completed
# event says) and the TASK_OUTCOME_* words in crates/roko-core/src/dashboard_snapshot.rs.
ROKO_OUTCOMES = {
    "passed",
    "passed_with_preexisting_failures",
    "already_satisfied",
    "accepted_with_failures",
    "unverified",
    "failed",
    "skipped",
    "condition-skipped",
    "unknown",
    "blocked",
    "interrupted",
    "cancelled",
}


def plugin_outcomes() -> set[str]:
    """The outcomes rundata gives a task itself, read from its source so that a new one is never missed: each
    `outcome = "…"` it writes, and the words of its outcome sets."""
    text = RUNDATA.read_text(encoding="utf-8")
    found = set(re.findall(r'\boutcome(?:: str)?\s*=\s*"([a-z_-]+)"', text))
    found |= set(re.findall(r'\["outcome"\]\s*=\s*"([a-z_-]+)"', text))
    for name in ("_PASSED_OUTCOMES", "_FAILED_OUTCOMES", "_STOPPED_OUTCOMES"):
        words = re.search(rf"^{name} = frozenset\(\{{([^}}]*)\}}\)", text, re.MULTILINE)
        assert words is not None, f"rundata.{name} moved: update this test"
        found |= set(re.findall(r'"([a-z_-]+)"', words.group(1)))
    return found


def test_every_task_outcome_has_its_own_glyph() -> None:
    outcomes = ROKO_OUTCOMES | plugin_outcomes()
    assert {"stopped", "interrupted", "cancelled", "skipped", "unverified", "pending", "running"} <= outcomes
    missing = sorted(outcome for outcome in outcomes if outcome not in render.OUTCOME_GLYPH)
    assert not missing, (
        f"render.OUTCOME_GLYPH has no glyph for {missing}, so /roko status prints '?' for them"
    )


def test_every_run_state_has_its_own_glyph() -> None:
    states = set(catalog.TERMINAL_STATES) | {"running", "queued"}
    missing = sorted(state for state in states if state not in render.STATE_GLYPH)
    assert not missing, f"render.STATE_GLYPH has no glyph for {missing}, so /roko status prints '?' for them"


def test_a_task_stopped_at_the_cap_reads_as_a_stop_not_a_failure() -> None:
    stop = render.OUTCOME_GLYPH["stopped"]
    assert stop not in {render.OUTCOME_GLYPH["failed"], "?"}
    run = {
        "run_id": "r1",
        "state": "failed",
        "tasks": [{"task_id": "T1", "outcome": "passed"}, {"task_id": "T2", "outcome": "stopped"}],
    }
    text = render.card(run)
    assert f"wave 1 ✓ T1 {stop} T2" in text and f"  {stop} T2 · stopped" in text and "?" not in text


STOPPED = {
    "run_id": "ee120773-5b1c-4d55-9a43-1f0e2b7c9d10",
    "state": "failed",  # roko's word for a run its cap stopped
    "cost_usd": 0.0171,
    "max_usd": 0.02,
    "label": "add a hello script",
    "budget_stop": {"limit": "run", "cap_usd": 0.02, "spent_usd": 0.0171},
}


def test_a_run_its_cap_stopped_reads_stopped_not_failed() -> None:
    assert render.run_line(STOPPED) == "  ■ ee120773 stopped · cap · $0.0171 of $0.02 · add a hello script"
    # A run row's `budget_stop` without figures takes the run's own.
    bare = {**STOPPED, "budget_stop": {"limit": "run", "cap_usd": None, "spent_usd": None}}
    assert render.run_line(bare) == render.run_line(STOPPED)
    tasks = [{"task_id": "T1", "outcome": "passed"}, {"task_id": "T2", "outcome": "stopped"}]
    card = render.card({**STOPPED, "tasks": tasks})
    assert card.splitlines()[0] == "■ roko run ee120773 · stopped · cap · $0.0171 of $0.02"
    assert "$0.0171 of $0.02 (86%)" in card  # the spend line as precise as the title
    assert "✗" not in card and "failed" not in card


def test_a_run_roko_s_daily_limit_stopped_says_so() -> None:
    day = {**STOPPED, "budget_stop": {"limit": "day", "cap_usd": 20.0, "spent_usd": 19.98}}
    line = "  ■ ee120773 stopped · day limit · $19.98 of $20.00 today · add a hello script"
    assert render.run_line(day) == line
    assert (
        render.card(day).splitlines()[0]
        == "■ roko run ee120773 · stopped · day limit · $19.98 of $20.00 today"
    )
    # Without roko's figures for the day, the run's own never stand in for them.
    unknown = {**STOPPED, "budget_stop": {"limit": "day", "cap_usd": None, "spent_usd": None}}
    assert render.run_line(unknown) == "  ■ ee120773 stopped · day limit · add a hello script"


def test_a_failed_run_without_a_budget_stop_still_reads_failed() -> None:
    failed = {**STOPPED, "budget_stop": None}
    assert render.run_line(failed) == "  ✗ ee120773 failed · $0.02 of $0.02 · add a hello script"
    assert render.card(failed).splitlines()[0] == "✗ roko run ee120773 · failed"

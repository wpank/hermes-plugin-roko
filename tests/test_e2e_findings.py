"""What the live end-to-end run against roko serve (2026-10-13, roko 1e3419a51) found.

A plan generation whose planner timed out three times ended `failed`; a minute later roko forgot the
operation, and with no plan written the plugin called it `missing` and blamed a busy workspace.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import views
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call


def test_a_forgotten_plan_generation_without_a_plan_did_not_succeed(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    started = call(rt, "roko_plan_generate", {"prompt": "add csv import", "title": "CSV import"})
    run_id, plan_id = started["run_id"], started["plan_id"]
    # The planner gave up, roko forgot the operation, and no plan was written.
    del fake.runs[run_id]
    del fake.plans[plan_id]
    old = (datetime.now(UTC) - timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rt.runs.update(run_id, started_at=old)

    card = views.card(rt, run_id)
    assert card["kind"] == "plan_generate" and card["state"] == "failed" and card["active"] is False
    assert card["label"] == "CSV import" and card["plan_id"] == plan_id
    assert "did not write this plan" in card["planner_error"]
    assert "workspace" not in card["planner_error"]  # nothing held roko's workspace
    logged = rt.runs.get(run_id)
    assert logged is not None and logged["state"] == "failed" and logged["note"] == views.LOST_PLAN_NOTE


def test_the_overview_marks_a_forgotten_plan_generation_failed_not_missing(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    started = call(rt, "roko_plan_generate", {"prompt": "add csv import"})
    del fake.runs[started["run_id"]]
    del fake.plans[started["plan_id"]]
    old = (datetime.now(UTC) - timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ")
    rt.runs.update(started["run_id"], started_at=old)

    [row] = views.ui_overview(rt)["runs"]
    assert row["state"] == "failed" and row["note"] == views.LOST_PLAN_NOTE and row["active"] is False

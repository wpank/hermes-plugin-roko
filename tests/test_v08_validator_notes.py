"""0.8.0 (round v7, P-41): roko's validator notes on the plan sheet, in roko's own words.

The plan sheet showed roko's validator only when it would not run the plan (its errors). Its warnings (PLAN_058: a
check that needs a file only a later task writes; a step that runs another command) were nowhere, though they are
the hints that a plan may not pass. They come from the same `POST /api/plans/{id}/validate` call, shown with roko's
code and message, never reworded.
"""

from __future__ import annotations

from conftest import FakeContext
from fake_roko import FakeRoko

from hermes_plugin_roko import plansheet, rundata
from hermes_plugin_roko.runtime import Runtime

WARNING = {
    "severity": "warning",
    "rule_id": "PLAN_058",
    "task_id": "T2",
    "message": "T2's check `tools/spec.sh 2_2 gain 'P2.2.03*'` needs core/src/gain.cpp, which only T3 writes\nmore",
}


def test_the_plan_sheet_says_rokos_validator_notes_in_its_own_words(fake: FakeRoko) -> None:
    fake.add_plan("p2-2-undertow-gain-staging", "P2.2 · Undertow gain staging", [{"id": "T1"}, {"id": "T2"}])
    fake.plan_checks["p2-2-undertow-gain-staging"] = {
        "valid": True,
        "diagnostics": [WARNING, {"severity": "info", "rule_id": "PLAN_000", "message": "an aside"}],
    }
    rt = Runtime(FakeContext({"url": fake.url}))
    try:
        sheet = plansheet.plan_sheet(rt, "p2-2-undertow-gain-staging")
        assert sheet["validation"] is None
        assert sheet["validator_notes"] == [
            {
                "rule": "PLAN_058",
                "task_id": "T2",
                "message": "T2's check `tools/spec.sh 2_2 gain 'P2.2.03*'` needs core/src/gain.cpp, which only T3 writes",
            }
        ]
        # One call answers both: the errors that stop a run, and the notes beside them.
        answered, validation, notes = rundata.check_plan(rt.client(), "p2-2-undertow-gain-staging")
        assert answered and validation is None and [note["rule"] for note in notes] == ["PLAN_058"]
    finally:
        rt.close()

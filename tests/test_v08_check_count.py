"""0.8.0 (round v7, the pilot's R1r p3): a task's checks are counted whole, and a cut list says how many more (P-59).

Phase 5.2's T1 has five verify steps. roko_plans lists a task's first four, so the chat's plan card read "4 checks"
and the chat listed four commands as all of them; `check_count` said 5. The card counts `check_count` now, a cut
list says "and 1 more", and the tool's row says how many it leaves out (`checks_more`).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from conftest import Approvals
from fake_roko import FakeRoko

from hermes_plugin_roko import tools

STEPS = [
    "tools/spec.sh 5_2 presets",
    "tools/spec.sh 5 presets",
    "tools/spec.sh 5_1 render",
    "tools/render-demos.sh && tools/spec.sh 5_1 demos",
    "tools/render-demos.sh && tools/spec.sh 5 demos",
]


def test_p59_a_task_row_counts_every_check_and_says_how_many_it_leaves_out() -> None:
    row = tools._task_row({"id": "T1", "title": "Retune", "verify": [{"command": step} for step in STEPS]})
    assert row["checks"] == STEPS[:4] and row["check_count"] == 5 and row["checks_more"] == 1
    four = tools._task_row(
        {"id": "T1", "title": "Retune", "verify": [{"command": step} for step in STEPS[:4]]}
    )
    assert four["check_count"] == 4 and "checks_more" not in four


def test_p59_roko_plans_says_so_to_the_chat(
    fake: FakeRoko, call: Callable[..., dict[str, Any]], approvals: Approvals
) -> None:
    fake.add_plan(
        "p5-2", "P5.2 · the presets as named", [{"id": "T1", "verify": [{"command": s} for s in STEPS]}]
    )
    task = call("roko_plans", {"plan_id": "p5-2"})["tasks"][0]
    assert (len(task["checks"]), task["check_count"], task["checks_more"]) == (4, 5, 1)

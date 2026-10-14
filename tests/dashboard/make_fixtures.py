"""Write tests/dashboard/fixtures.json: the plugin backend's own answers about recorded runs.

    PYTHONDONTWRITEBYTECODE=1 .venv/bin/python tests/dashboard/make_fixtures.py

The runs are the Hermes dogfood recordings replayed by tests/replay_roko.py: the five-task plan
caught mid-flight and after it passed, the same plan failed and cancelled, a prompt run, a sign-off run
waiting on the person, and a run roko has no record of. Every answer is what the route itself returns
(`ui_api.guarded`), so the bundle's tests run against real shapes. `_generated_at_ms` lets a test move
every time in the file to "now".
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE))

from conftest import FakeContext  # noqa: E402
from demo_data import seed_insights  # noqa: E402
from replay_roko import LABELS, PLAN_RUN, Replay, build  # noqa: E402

from hermes_plugin_roko import review, tools, ui_api, views  # noqa: E402
from hermes_plugin_roko.runtime import Runtime  # noqa: E402

OUT = HERE / "fixtures.json"
MISSING = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"


def answer(rt: Runtime, work: Any) -> dict[str, Any]:
    return ui_api.guarded(lambda: rt, work)


def main() -> None:
    workdir = Path(tempfile.mkdtemp(prefix="roko-fixtures-")) / "tally"
    server = build(1.0, workdir)
    seed_insights(server)
    # The live plan, about 110 s into the recording: T1 passed, T2 and T4 at work.
    live = next(r for r in server.runs.values() if isinstance(r, Replay) and r.current() == "running")
    live.head_start_s = 108.0
    server.start()
    rt = Runtime(FakeContext({"url": server.url, "workdir": str(workdir), "max_day_usd": 20}))
    now = datetime.now(UTC)
    order = ["failed_run", "cancelled_plan_run", "prompt_run", PLAN_RUN]
    ended = {r.fixture: r for r in server.runs.values() if isinstance(r, Replay) and r is not live}
    for minutes, fixture in zip((95, 70, 41, 18), order, strict=True):
        replay = ended[fixture]
        rt.runs.add(
            replay.run_id,
            replay.kind,
            LABELS[fixture],
            plan_id=replay.plan_id,
            max_usd=1.0 if replay.kind == "plan" else 0.5,
            request=None if replay.kind == "plan" else "Add a --json flag to the balance command of tally",
        )
        rt.runs.update(
            replay.run_id, started_at=(now - timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%SZ")
        )
    rt.runs.add(
        MISSING, "run", "Summarise last week's commits", max_usd=0.25, request="Summarise last week's commits"
    )
    rt.runs.update(MISSING, started_at=(now - timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ"))
    rt.runs.add(live.run_id, "plan", "Add per-category budgets to tally", plan_id=live.plan_id, max_usd=1.0)
    # A sign-off run that waits on the person (started from the UI), and a held action.
    sign_off = server.replay("confirm_run", max_usd=0.5)
    assert sign_off.hold_at_s is not None
    sign_off.head_start_s = sign_off.hold_at_s - 0.2
    confirm_id = sign_off.run_id
    rt.runs.add(
        confirm_id,
        "run",
        "Write the ledger report",
        max_usd=0.5,
        source="ui",
        request="Write REPORT.md summarising the ledger module's public API, one paragraph per function.",
    )
    for _ in range(40):
        if views.card(rt, confirm_id)["waiting"]:
            break
        time.sleep(0.25)
    server.effects.append(
        {
            "effect_id": "effect-7",
            "run_id": confirm_id,
            "plan_id": confirm_id,
            "task_id": "T1",
            "tool": "mail.send",
            "server": "mail",
            "arguments": {"to": "string", "subject": "string", "body": "string"},
            "proposed_at": datetime.now(UTC).isoformat(timespec="seconds"),
        }
    )
    multiwave = ended[PLAN_RUN].run_id
    runs = {
        rid: answer(rt, lambda r, rid=rid: {"run": views.card(r, rid)})
        for rid in [live.run_id, confirm_id, MISSING] + [ended[f].run_id for f in order]
    }
    events = {
        rid: answer(rt, lambda r, rid=rid: ui_api.timeline(r, rid, {"tail": "400"}))
        for rid in [live.run_id, confirm_id] + [ended[f].run_id for f in order]
    }
    diffs = {
        rid: answer(rt, lambda r, rid=rid: {"diff": review.run_diff(r, rid, {})})
        for rid in (multiwave, ended["prompt_run"].run_id, ended["failed_run"].run_id, live.run_id)
    }
    merges = {
        rid: answer(rt, lambda r, rid=rid: {"merge": review.merge_check(r, rid)})
        for rid in (multiwave, ended["prompt_run"].run_id, ended["failed_run"].run_id)
    }
    plan_id = live.plan_id
    out = {
        "_comment": (
            "The plugin backend's own answers (ui_api routes) about the Hermes dogfood runs, replayed by "
            "tests/replay_roko.py. Written by tests/dashboard/make_fixtures.py; tests move every time to now "
            "with _generated_at_ms."
        ),
        "_generated_at_ms": int(time.time() * 1000),
        "ids": {
            "live": live.run_id,
            "confirm": confirm_id,
            "missing": MISSING,
            "multiwave": multiwave,
            "failed": ended["failed_run"].run_id,
            "cancelled": ended["cancelled_plan_run"].run_id,
            "prompt": ended["prompt_run"].run_id,
            "plan": plan_id,
        },
        "overview": answer(rt, views.ui_overview),
        "runs": runs,
        "events": events,
        "diffs": diffs,
        "merges": merges,
        "pending": answer(rt, lambda r: {"items": views.collect_pending(r, r.client())}),
        "plans": answer(rt, ui_api.plan_rows),
        "plan_details": {plan_id: answer(rt, lambda r: {"plan": tools.plan_detail(r.client(), plan_id)})},
        "knowledge": answer(rt, lambda r: ui_api.knowledge(r, {"q": "tests"})),
        "health": answer(rt, ui_api.health),
        "insights": answer(rt, ui_api.insight_view),
    }
    rt.close()
    server.stop()
    # The scratch checkout stands for a person's project.
    text = json.dumps(out, indent=1, ensure_ascii=False).replace(str(workdir), "/home/demo/code/tally")
    OUT.write_text(text + "\n")
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()

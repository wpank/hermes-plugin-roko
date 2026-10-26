"""0.8.0 (round v7, P-52): a rung roko skips, read plainly (roko gap-20301d, roko-ladder).

roko probes each rung of its ladder once a day and skips, at plan start, a rung whose probe failed: phase 4's cheap
rung (gpt-oss-120b on Cerebras, a 402) was skipped all of phase 4 and 4.1 without a word, and the ladder drew T2
waiting on CHEAP, where roko never starts it. roko now says so: a `rung_skipped` event once per plan and skipped rung
(plan_id, rung, model, provider, reason, until_ms, detail) and the run summary's `rungs_skipped`, the latest per
rung; and when every rung is skipped, it refuses the run before any model call. The plugin draws a skipped rung as
one this run cannot use, in roko's words; a task that would start on it waits on the next rung that runs; and the
all-skipped refusal reads plainly, with no resume that would be refused again. Field names are roko-ladder's draft
until its merge, so the reader takes the likely alternatives too.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from conftest import Approvals, FakeContext
from fake_roko import FakeRoko
from test_v06_runs import LADDER, LADDER_TOML, MODELS, PROVIDERS

from hermes_plugin_roko import learning_guard, rundata, tools, views
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.tools import call

PLAN = "p4-2-undertow-layout"
DETAIL = (
    "rung cheap (gpt-oss-120b on cerebras) is skipped until 20:33: its tool-use probe failed: insufficient_credits: "
    "http 402; a task that would start on it starts on the next rung that runs"
)
SKIP = {
    "plan_id": PLAN,
    "rung": "cheap",
    "model": "gpt-oss-120b",
    "provider": "cerebras",
    "reason": "insufficient_credits: http 402",
    "until_ms": 1_793_046_780_000,
    "detail": DETAIL,
}
SAID = (
    "skipped until 20:33: its tool-use probe failed: insufficient_credits: http 402; a task that would start on it "
    "starts on the next rung that runs"
)


@pytest.fixture
def rt(fake: FakeRoko, tmp_path: Path) -> Iterator[Runtime]:
    workspace = tmp_path / "ws"
    workspace.mkdir()
    (workspace / "roko.toml").write_text(LADDER_TOML)
    fake.models = [dict(row) for row in MODELS]
    fake.providers = [dict(row) for row in PROVIDERS]
    runtime = Runtime(FakeContext({"url": fake.url, "workdir": str(workspace)}))
    try:
        yield runtime
    finally:
        runtime.close()


def test_a_skipped_rung_reads_in_rokos_words_and_its_tasks_wait_on_the_next_rung_that_runs() -> None:
    """The ladder: the skipped rung is one this run cannot use, with roko's words (its subject, the rung and model
    the row already names, left off), and the tiers that start on it start on the next rung that runs."""
    marked = rundata.with_skipped(LADDER, [rundata.rung_skip(SKIP)])
    cheap, mid = marked[0], marked[1]
    assert (cheap["chat_ok"], cheap["skipped"], cheap["why_not"], cheap["starts"]) == (False, True, SAID, [])
    assert mid["starts"] == ["integrative", "mechanical", "focused"]
    assert LADDER[0]["chat_ok"] is True and LADDER[0]["starts"] == ["mechanical", "focused"]  # untouched
    # A rung roko does not name, or no skips, leave the ladder as it is.
    assert rundata.with_skipped(LADDER, []) == LADDER
    assert rundata.with_skipped(LADDER, [rundata.rung_skip({**SKIP, "rung": "tiny"})]) == LADDER


def test_the_reader_takes_the_likely_field_names_and_untrusted_words_stay_text() -> None:
    other = {"rung_name": "cheap", "model_slug": "gpt-oss-120b", "message": "probe failed", "until": 5}
    skip = rundata.rung_skip(other)
    assert skip is not None and (skip["rung"], skip["model"], skip["reason"], skip["until_ms"]) == (
        "cheap",
        "gpt-oss-120b",
        "probe failed",
        5,
    )
    assert skip["detail"] == "rung cheap (gpt-oss-120b) is skipped: probe failed"
    odd = rundata.rung_skip({**SKIP, "detail": "x\ny " + "z" * 900})
    assert odd is not None and "\n" not in odd["detail"] and len(odd["detail"]) <= 400
    assert rundata.rung_skip({"model": "m"}) is None


def _run(fake: FakeRoko, rt: Runtime, state: str, *, summary: dict[str, Any] | None = None) -> str:
    fake.add_plan(PLAN, "P4.2 · Undertow layout", [{"id": "T1"}, {"id": "T2"}])
    fake.run_script = [state]
    run_id = call(rt, "roko_plan_run", {"plan_id": PLAN, "max_usd": 1.0})["run_id"]
    fake.runs[run_id].events = [
        {"type": "plan_set_loaded", "plans": [{"plan_id": PLAN, "tasks_total": 2}], "ts_millis": 1},
        {"type": "rung_skipped", **SKIP, "ts_millis": 2},
        {"type": "plan_started", "plan_id": PLAN, "tasks_total": 2, "ts_millis": 3},
    ]
    fake.runs[run_id].summary_extra = summary or {}
    return run_id


def test_a_runs_card_lists_the_rungs_roko_skipped_and_its_ladder_says_so(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    card = views.card(rt, _run(fake, rt, "running"))
    assert [(skip["rung"], skip["detail"]) for skip in card["rungs_skipped"]] == [("cheap", DETAIL)]
    cheap = next(rung for rung in card["ladder"] if rung["rung"] == "cheap")
    assert (cheap["skipped"], cheap["chat_ok"], cheap["why_not"]) == (True, False, SAID)
    # roko's summary list, once it gives one, is what the card lists.
    later = {**SKIP, "until_ms": 1_793_050_000_000, "detail": DETAIL.replace("20:33", "21:30")}
    card = views.card(rt, _run(fake, rt, "running", summary={"rungs_skipped": [later]}))
    assert [skip["until_ms"] for skip in card["rungs_skipped"]] == [1_793_050_000_000]


def test_a_run_refused_because_every_rung_is_skipped_reads_plainly_and_offers_no_resume(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """When every rung is skipped roko refuses the run before any model call: the card says why in roko's words, and
    its next step is no resume (one now would be refused again), with the re-probe roko does on a resume."""
    refusal = {
        "stage": "start",
        "kind": "all_rungs_skipped",
        "reason": "every rung of the ladder is skipped: cheap (402), mid (402), strong (402)",
    }
    card = views.card(rt, _run(fake, rt, "failed", summary={"refused": refusal}))
    step = card["next"]
    assert step["action"] is None and "resume" not in step["label"]
    assert step["label"] == "every rung is skipped: nothing ran"
    assert refusal["reason"] in step["why"] and "a resume probes its rung again" in step["why"]
    said = tools._step({"state": "failed", "run_id": card["run_id"], "why": card["why"]}, card)
    assert refusal["reason"] in said and "do not resume it now" in said.lower()
    # The same refusal named only in words, by an older draft of roko's kind.
    words = {"stage": "start", "reason": "all rungs are skipped: cheap (402)"}
    assert views.card(rt, _run(fake, rt, "failed", summary={"refused": words}))["next"]["label"] == (
        "every rung is skipped: nothing ran"
    )


# roko-ladder's fields as merged (roko c8f9bff80: gap-b856d3 with bug-374384): a skip on billing says so and has no
# until_ms, since roko probes a cached billing failure again once a run; a skip for another reason stands a day.
BILLING = {
    "plan_id": PLAN,
    "rung": "cheap",
    "model": "gpt-oss-120b",
    "provider": "cerebras",
    "reason": "insufficient_credits: http 402",
    "billing": True,
    "detail": "rung cheap (gpt-oss-120b on cerebras) is skipped for this run: its tool-use probe failed: "
    "insufficient_credits: http 402; a task that would start on it starts on the next rung that runs; the next run "
    "probes it again, so recharge the account and run again",
}
ZAI = {
    **BILLING,
    "rung": "mid",
    "model": "glm-4.7",
    "provider": "zai",
    "detail": "rung mid (glm-4.7 on zai) is skipped",
}
REASON = (
    "task `T1` was not run: no rung of the routing ladder can run, as every rung's model failed its tool-use probe at "
    "plan start: cheap (gpt-oss-120b on cerebras): insufficient_credits: http 402; mid (glm-4.7 on zai): 1113"
)


def _all_skipped(
    fake: FakeRoko, rt: Runtime, skips: list[dict[str, Any]], billing_only: bool
) -> dict[str, Any]:
    refused = {"stage": "ladder", "kind": "all_rungs_skipped", "reason": REASON, "billing_only": billing_only}
    return views.card(rt, _run(fake, rt, "failed", summary={"refused": refused, "rungs_skipped": skips}))


def test_a_refusal_whose_every_rung_failed_on_billing_says_recharge_then_resume(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """The lead, pinning P-52 to roko's fields: `billing_only` true means every skipped rung failed on billing, and
    roko probes a billing failure again on the next run (bug-374384), so a recharge and a resume work. The next step
    says so and offers the resume; the chat tells the person to recharge first and resumes only when asked."""
    card = _all_skipped(fake, rt, [BILLING, ZAI], billing_only=True)
    assert card["why"]["all_rungs_skipped"] is True and card["why"]["billing_only"] is True
    assert [skip["billing"] for skip in card["rungs_skipped"]] == [True, True]
    step = card["next"]
    assert (step["action"], step["label"], step["resume"]) == (
        "rerun",
        "recharge cerebras and zai, then resume",
        True,
    )
    assert step["why"].startswith("task `T1` was not run: no rung of the routing ladder can run")
    assert "once cerebras and zai are recharged, a resume probes the skipped rungs again" in step["why"]
    said = tools._step({"state": "failed", "run_id": card["run_id"], "why": card["why"]}, card)
    assert "recharge cerebras and zai" in said and "If the person asked in this turn" in said
    assert not learning_guard.teaches_repair(said)
    # A skip whose line roko wrote before c8f9bff80 has no billing word.
    assert rundata.rung_skip(SKIP)["billing"] is None and rundata.rung_skip(BILLING)["billing"] is True


def test_a_refusal_with_a_rung_skipped_for_another_reason_says_a_resume_waits_on_the_probe_verdict(
    rt: Runtime, fake: FakeRoko, approvals: Approvals
) -> None:
    """`billing_only` false: a rung skipped for another reason keeps roko's probe verdict a day, so a resume now is
    refused again until it lapses or its model's entry leaves roko's probe file, which is the person's to do."""
    card = _all_skipped(fake, rt, [BILLING, SKIP], billing_only=False)
    step = card["next"]
    assert (step["action"], step["label"]) == (None, "every rung is skipped: nothing ran")
    lapse = time.strftime("%H:%M", time.localtime(SKIP["until_ms"] / 1000))
    assert f"roko's probe verdict on a rung stands for 24 hours (the first lapses at {lapse})" in step["why"]
    assert "or until its model's entry is removed from .roko/learn/rung-probes.json" in step["why"]
    said = tools._step({"state": "failed", "run_id": card["run_id"], "why": card["why"]}, card)
    assert "Removing that entry is theirs to do" in said
    assert "Do not edit roko's files yourself, and do not resume it now" in said
    assert not learning_guard.teaches_repair(said)
    # A try roko settled so reads plainly where roko left no line.
    assert (
        rundata.VERDICT_WORDS["all_rungs_skipped"]
        == "no rung of the ladder could run it: every rung was skipped"
    )

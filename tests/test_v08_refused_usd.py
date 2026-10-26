"""0.8.0 (round v7, roko bug-8bcd98 part 2 via roko-speed, eab74f5b2): spend a provider refused counts where roko counts it.

A try whose routed model worked part-way before its provider refused it (a 429 past the tool loop's retries, or an
out-of-usage answer) and failed over billed only the model that ran after: run 7b8cb121's T2#1 verdict said $0.0354
while its calls cost $0.2430, glm-4.7's $0.2076 before z.ai's 429 left out. roko's verdict now carries
`cost.refused_usd`, and attempt_settled's `cost_usd` adds it; its rung rows keep counting refused calls on the
refused model's row as `refused_usd` (gap-5cfa9c). The plugin's try and rung figures agree with roko's books
(billed plus refused), and the ladder keeps the refused part visible (the lead).
"""

from __future__ import annotations

import pytest

from hermes_plugin_roko import rundata


def test_a_tries_spend_from_its_verdict_record_counts_its_refused_calls_as_attempt_settled_does() -> None:
    """A try read from its verdict record (no attempt_settled event) counts as attempt_settled says it: the call
    that ran (a CLI agent's own figure, else the provider's charge, else the snapshot's price) plus its refused
    calls."""
    view = rundata.settled_view
    t2 = {"attempt": 1, "cost": {"billed_usd": 0.0354, "api_equiv_usd": 0.0354, "refused_usd": 0.2076}}
    assert view(t2)["cost_usd"] == pytest.approx(0.243)
    # The call that ran, as attempt_settled reads it: a CLI agent's own figure first (billed is 0 on a subscription).
    assert view({"attempt": 1, "cost": {"vendor_usd": 0.05, "billed_usd": 0.0}})["cost_usd"] == 0.05
    assert view({"attempt": 1, "cost": {"api_equiv_usd": 0.02}})["cost_usd"] == 0.02
    # Older rows lack refused_usd; a try whose only spend was refused calls says that much.
    assert view({"attempt": 1, "cost": {"billed_usd": 0.0354}})["cost_usd"] == 0.0354
    assert view({"attempt": 1, "cost": {"refused_usd": 0.1}})["cost_usd"] == 0.1
    assert view({"attempt": 1, "cost": {}})["cost_usd"] is None
    # attempt_settled's own figure already counts them.
    assert view({"attempt": 1, "cost_usd": 0.243})["cost_usd"] == 0.243


def test_a_rungs_spend_counts_what_a_provider_refused_of_its_calls_and_keeps_that_part_apart() -> None:
    """roko's rung rows count a call a provider refused on the refused model's row as `refused_usd`, beside the
    tries' `cost_usd` (gap-5cfa9c). A rung's spend is both, so the rungs add up to the run's cost, and the ladder
    keeps the refused part apart: spend that bought work against spend a provider refused (the lead). Run
    7b8cb121's rows: mid $0.67 of tries and $0.21 refused, strong $0.04; the run cost $0.91."""
    rows = [
        {
            "role": "implementer",
            "rung": "mid",
            "index": 1,
            "model": "glm-4.7",
            "cost_usd": 0.665483,
            "refused_usd": 0.207559,
        },
        {
            "role": "implementer",
            "rung": "strong",
            "index": 2,
            "model": "gpt-5.4-mini",
            "cost_usd": 0.035439,
            "refused_usd": 0.0,
        },
    ]
    mid, strong = rundata.ran_ladder({"rungs": rows})
    assert (mid["rung"], mid["model"], mid["spent_usd"], mid["refused_usd"]) == (
        "mid",
        "glm-4.7",
        0.873042,
        0.207559,
    )
    assert (strong["spent_usd"], strong["refused_usd"]) == (0.035439, None)
    # Two rows on one rung (another model, or another role) are its spend together; its model is the first's.
    other = {"rung": "mid", "index": 1, "model": "kimi-k2", "cost_usd": 0.1, "refused_usd": 0.01}
    [both] = rundata.ran_ladder({"rungs": [rows[0], other]})
    assert (both["model"], both["spent_usd"], both["refused_usd"]) == ("glm-4.7", 0.983042, 0.217559)
    # An older roko's rows have no refused_usd.
    [old] = rundata.ran_ladder({"rungs": [{"rung": "mid", "model": "glm-4.7", "cost_usd": 0.5}]})
    assert (old["spent_usd"], old["refused_usd"]) == (0.5, None)

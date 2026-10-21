"""0.8.0 (round v7): a provider's HTTP refusal is not a network failure (phase 4's run 16fc88ae).

Phase 4's first run failed in two minutes: OpenAI answered T1's first call with a 400 ("Function tools with
reasoning_effort are not supported …"). roko files a provider's 4xx as `network error: http 400: {body}`, and the
plugin said "the network failed", which sends the person to their connection; a 401 from a bad key would read the
same way. A provider that answered with an HTTP status refused the request: the plugin says so, with the provider's
own message, and for a 401 or 403 it points at the key or the account. A real transport error keeps "the network
failed". roko-speed is changing roko's own label for these; the plugin reads the status after either label.
"""

from __future__ import annotations

import json
from typing import Any

import pytest

from hermes_plugin_roko import rundata

OPENAI_SAID = (
    "Function tools with reasoning_effort are not supported for gpt-5.4-mini in /v1/chat/completions. To use "
    "function tools, use /v1/responses or set reasoning_effort to 'none'."
)
BODY = json.dumps(
    {
        "error": {
            "message": OPENAI_SAID,
            "type": "invalid_request_error",
            "param": "reasoning_effort",
            "code": None,
        }
    },
    indent=2,
)
# roko's words in T1's place, as phase 4's run 16fc88ae has them.
PHASE4 = f"network error: http 400: {BODY}"
REFUSED = f"the provider refused the request (HTTP 400): {OPENAI_SAID}"
KEY = "(check its API key or account)"


def test_phase_4s_400_is_the_provider_refusing_the_request_in_its_own_words() -> None:
    assert rundata.harness_words(PHASE4) == REFUSED


@pytest.mark.parametrize(
    ("said", "words"),
    [
        # roko today: a 401 is its AuthFailure, with no status.
        (
            "provider error: authentication failed",
            f"the provider refused the request: authentication failed {KEY}",
        ),
        (
            'network error: http 401: {"error": {"message": "Incorrect API key provided.", "type": "invalid_request_error"}}',
            f"the provider refused the request (HTTP 401): Incorrect API key provided. {KEY}",
        ),
        (
            'network error: http 403: {"error": {"message": "Project does not have access to model gpt-5.4."}}',
            f"the provider refused the request (HTTP 403): Project does not have access to model gpt-5.4. {KEY}",
        ),
    ],
)
def test_a_401_or_403_points_at_the_key_or_the_account(said: str, words: str) -> None:
    assert rundata.harness_words(said) == words


@pytest.mark.parametrize(
    "said",
    [
        # Labels roko-speed's fix may give a provider's 4xx: the status after any short label counts.
        f"provider error: http 400: {BODY}",
        f"provider error: request rejected (http 400): {BODY}",
        f"invalid request: HTTP 400: {BODY}",
    ],
)
def test_the_status_reads_the_same_after_rokos_new_label(said: str) -> None:
    assert rundata.harness_words(said) == REFUSED


def test_a_body_that_is_not_json_or_is_cut_short_still_gives_the_providers_words() -> None:
    assert rundata.harness_words("network error: http 404: model not found") == (
        "the provider refused the request (HTTP 404): model not found"
    )
    cut = PHASE4[: PHASE4.index("To use")]  # roko kept only the start of the body
    assert rundata.harness_words(cut) == (
        "the provider refused the request (HTTP 400): Function tools with reasoning_effort are not supported "
        "for gpt-5.4-mini in /v1/chat/completions."
    )
    # The provider's words are untrusted: one line, bounded.
    long = rundata.harness_words('network error: http 400: {"message": "a\\nb ' + "x" * 900 + '"}') or ""
    assert (
        "\n" not in long
        and len(long) <= 300
        and long.startswith("the provider refused the request (HTTP 400): a b x")
    )


@pytest.mark.parametrize(
    "said",
    [
        "network error: error sending request for url (https://api.openai.com/v1/chat/completions): connection reset",
        "network error: read chunk failed: error decoding response body",
        "network error: dns failed",
    ],
)
def test_a_real_transport_error_is_still_the_network(said: str) -> None:
    assert (rundata.harness_words(said) or "").startswith("the network failed: ")


def _feed(tracker: Any, rows: list[tuple[str, dict[str, Any]]]) -> None:
    for cursor, (kind, event) in enumerate(rows, start=tracker.fold.rows + 1):
        tracker.fold.feed(
            cursor * 100, kind, {"type": kind, "run_id": "r1", "ts_millis": 1_000 + cursor, **event}
        )


def test_the_runs_why_and_its_stream_say_the_provider_refused_it() -> None:
    plan, task = "p4-undertow-phosphor-editor", {"plan_id": "p4-undertow-phosphor-editor", "task_id": "T1"}
    stream = {"agent_id": f"{plan}/T1", "attempt": 1, "kind": "text", "payload": {"text": PHASE4}, **task}
    cache = rundata.CardCache()
    tracker = cache.tracker("http://roko.invalid", "r1")
    _feed(
        tracker,
        [
            ("plan_started", {"plan_id": plan, "tasks_total": 1}),
            ("task_started", {**task, "title": "Editor scope"}),
            ("agent_spawned", {**task, "attempt": 1, "model": "gpt-5.4-mini"}),
            ("agent_output", {**task, "content": "\x1eroko.stream.v1 " + json.dumps(stream)}),
            ("task_completed", {**task, "outcome": "failed"}),
            ("error", {"message": f"plan '{plan}': task 'T1' failed: agent error (openai): {PHASE4}"}),
        ],
    )
    card = rundata._compose(tracker, "r1", "failed", {"state": "failed"}, {"kind": "plan"})
    why = rundata.explain(cache, "http://roko.invalid", card)["summary"]
    assert f"T1 did not finish: {REFUSED}" in why and "network failed" not in why
    assert "'none'.. " not in why  # the provider's sentence ends the why's own
    line = rundata.timeline_entry(
        400,
        "agent_output",
        {"type": "agent_output", **task, "content": "\x1eroko.stream.v1 " + json.dumps(stream)},
    )
    assert line is not None and line["text"] == f"T1 stopped: {REFUSED}"

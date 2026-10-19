"""roko serve is called unreachable only when it is (round v6, plugin-setup).

The desktop page went OFFLINE for about 6 s right after a run started, while roko answered: the plugin sent 45
requests in one second, roko serve allows a key 30, answered the rest with 429 and dropped some connections, and the
page's one look at /health was among them. These tests script roko with a mock transport and a fake clock.
"""

from __future__ import annotations

from typing import Any

import httpx
import pytest
from conftest import FakeContext

from hermes_plugin_roko import client as client_mod
from hermes_plugin_roko import views
from hermes_plugin_roko.client import RokoClient
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.runtime import Runtime
from hermes_plugin_roko.settings import Credential, load_settings

URL = "http://127.0.0.1:6779"
HEALTH = {"status": "ok", "version": "0.1.0", "uptime_secs": 42}


class Clock:
    """The client's clock and sleeps, in fake seconds."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.slept: list[float] = []

    def sleep(self, seconds: float) -> None:
        self.slept.append(seconds)
        self.now += seconds


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Clock:
    fake = Clock()
    monkeypatch.setattr(client_mod, "_now", lambda: fake.now)
    monkeypatch.setattr(client_mod, "_sleep", fake.sleep)
    return fake


class Roko:
    """A scripted roko serve: `health` is what /health does next ("ok", "refused", "dropped", "slow", 429)."""

    def __init__(self, clock: Clock) -> None:
        self.clock = clock
        self.health = "ok"
        self.calls: list[tuple[float, str, str]] = []
        self.answers: dict[tuple[str, str], list[Any]] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        method, path = request.method, request.url.path
        self.calls.append((self.clock.now, method, path))
        scripted = self.answers.get((method, path))
        how = scripted.pop(0) if scripted else (self.health if path == "/health" else "ok")
        if how == "refused":
            raise httpx.ConnectError("[Errno 61] Connection refused", request=request)
        if how == "dropped":
            raise httpx.ReadError("[Errno 54] Connection reset by peer", request=request)
        if how == "slow":
            raise httpx.ReadTimeout("timed out", request=request)
        if how == 429:
            body = {"code": "rate_limited", "message": "per-caller rate limit exceeded"}
            return httpx.Response(429, json=body, headers={"Retry-After": "1"})
        if path == "/health":
            return httpx.Response(200, json=HEALTH)
        if path == "/api/health":
            return httpx.Response(200, json={"status": "ok", "active_runs": 0, "active_plans": 0})
        return httpx.Response(200, json={"ok": True})


@pytest.fixture
def roko(clock: Clock) -> Roko:
    return Roko(clock)


def runtime(roko: Roko) -> Runtime:
    return Runtime(FakeContext({"url": URL}), transport=httpx.MockTransport(roko.handler))


def look(rt: Runtime, roko: Roko, at: float, health: Any = None) -> dict[str, Any]:
    """The overview's connection, as the page gets it, `at` fake seconds after the clock's start."""
    roko.clock.now = 1000.0 + at
    if health is not None:
        roko.health = health
    return views.connection(rt)


def client(roko: Roko) -> RokoClient:
    settings = load_settings(lambda key, default=None: {"url": URL}.get(key, default))
    return RokoClient(
        settings, credential=Credential(None, "none"), transport=httpx.MockTransport(roko.handler)
    )


# -- one failed look is not roko down -----------------------------------------------------------------


@pytest.mark.parametrize("failure", ["refused", "dropped"])
def test_one_failed_look_between_good_ones_keeps_roko_reachable(roko: Roko, failure: str) -> None:
    rt = runtime(roko)
    assert look(rt, roko, 0)["reachable"] is True
    blip = look(rt, roko, 5, failure)  # the retry inside the look fails too: a blip of more than a moment
    assert blip["reachable"] is True and blip["version"] == "0.1.0", blip
    assert look(rt, roko, 7, "ok")["reachable"] is True


def test_two_failed_looks_in_a_row_mean_unreachable(roko: Roko) -> None:
    rt = runtime(roko)
    look(rt, roko, 0)
    assert look(rt, roko, 5, "refused")["reachable"] is True
    down = look(rt, roko, 6.5)
    assert down["reachable"] is False and down["error"]["code"] == "unreachable"
    # What the OS said, so a failure that is no outage can be told apart.
    assert "ConnectError: [Errno 61] Connection refused" in down["error"]["message"]


def test_looks_that_fail_at_the_same_moment_count_once(roko: Roko) -> None:
    # The live relay and the page's own poll often look at once: three looks within MISS_GAP_S are one miss.
    rt = runtime(roko)
    look(rt, roko, 0)
    for at in (5.0, 5.3, 5.6):
        assert look(rt, roko, at, "refused")["reachable"] is True
    assert look(rt, roko, 6.7)["reachable"] is False


def test_without_a_good_look_roko_is_unreachable_at_once(roko: Roko) -> None:
    rt = runtime(roko)
    assert look(rt, roko, 0, "refused")["reachable"] is False


def test_an_old_good_look_vouches_for_nothing(roko: Roko) -> None:
    rt = runtime(roko)
    look(rt, roko, 0)
    assert look(rt, roko, client_mod.VOUCH_S + 1, "refused")["reachable"] is False


def test_a_failed_live_stream_confirms_one_failed_look(roko: Roko) -> None:
    rt = runtime(roko)
    look(rt, roko, 0)
    roko.answers[("GET", "/api/events")] = ["dropped"]
    with pytest.raises(RokoError), rt.client().stream("/api/events") as response:
        for _ in response.iter_lines():
            pass
    assert look(rt, roko, 5, "refused")["reachable"] is False


def test_a_good_look_starts_the_count_again(roko: Roko) -> None:
    rt = runtime(roko)
    look(rt, roko, 0)
    assert look(rt, roko, 5, "refused")["reachable"] is True
    assert look(rt, roko, 6.5, "ok")["reachable"] is True
    assert look(rt, roko, 8, "refused")["reachable"] is True


# -- busy is not down ---------------------------------------------------------------------------------


@pytest.mark.parametrize("busy", [429, "slow"])
def test_a_rate_limited_or_late_look_is_busy_not_unreachable(roko: Roko, busy: Any) -> None:
    rt = runtime(roko)
    look(rt, roko, 0)
    seen = look(rt, roko, 5, busy)
    assert seen["reachable"] is True and seen["status"] == "slow" and seen["version"] == "0.1.0", seen
    # Busy without a good look before it: roko took the connection, so it is up all the same.
    fresh = runtime(roko)
    assert look(fresh, roko, 6, busy)["reachable"] is True


def test_roko_slow_for_a_minute_is_called_stuck(roko: Roko) -> None:
    rt = runtime(roko)
    look(rt, roko, 0)
    assert look(rt, roko, 5, "slow")["status"] == "slow"
    stuck = look(rt, roko, 5 + client_mod.STUCK_S, "slow")
    assert stuck["reachable"] is False and "did not answer in time" in stuck["error"]["message"]


def test_a_look_waits_seconds_not_the_twenty_of_other_calls() -> None:
    seen: list[dict[str, Any]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.extensions["timeout"]))
        return httpx.Response(200, json=HEALTH)

    settings = load_settings(lambda key, default=None: {"url": URL}.get(key, default))
    look_client = RokoClient(
        settings, credential=Credential(None, "none"), transport=httpx.MockTransport(handler)
    )
    look_client.health()
    assert seen[0]["read"] == client_mod.HEALTH_TIMEOUT_S == 5.0 and seen[0]["connect"] == 3.0


# -- what roko never ran is asked again ---------------------------------------------------------------


def test_a_429_is_waited_out_and_asked_again(roko: Roko, clock: Clock) -> None:
    roko.answers[("POST", "/mcp")] = [429]
    answer = client(roko).post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert answer == {"ok": True}
    assert clock.slept == [1.0] and [call[1:] for call in roko.calls] == [("POST", "/mcp")] * 2


def test_a_dropped_get_is_asked_again_and_a_dropped_post_is_not(roko: Roko) -> None:
    roko.answers[("GET", "/api/runs/r1/events")] = ["dropped"]
    assert client(roko).get("/api/runs/r1/events") == {"ok": True}
    roko.answers[("POST", "/mcp")] = ["dropped"]
    with pytest.raises(RokoError) as dropped:
        client(roko).post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/call"})
    assert dropped.value.code is Code.UNREACHABLE
    assert (
        sum(1 for call in roko.calls if call[1:] == ("POST", "/mcp")) == 1
    )  # it may have run: not sent twice


def test_a_connection_never_made_is_tried_once_more_for_any_request(roko: Roko) -> None:
    roko.answers[("POST", "/mcp")] = ["refused"]
    assert client(roko).post("/mcp", {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}) == {"ok": True}


# -- the pace roko allows -----------------------------------------------------------------------------


def gcra_accepts(times: list[float], per_s: float = 30.0, burst: float = 30.0) -> bool:
    """Whether roko serve's limiter (governor's GCRA, `per_second(30)`) lets every request at `times` through."""
    interval = 1.0 / per_s
    tat = times[0]
    for at in times:
        if at < tat - burst * interval + interval - 1e-9:
            return False
        tat = max(tat, at) + interval
    return True


def test_a_burst_keeps_under_rokos_rate_limit(roko: Roko) -> None:
    # A run start: 60 requests at once (round v6 saw 45 in one second). roko allows a key 30 a second.
    one = client(roko)
    for _ in range(60):
        one.get("/api/health")
    times = [call[0] for call in roko.calls]
    assert times[:25] == [times[0]] * 25  # the first ones go at once
    assert gcra_accepts(times), "roko serve would answer some of these with 429"
    assert times[-1] - times[0] == pytest.approx(35 / client_mod.PACE_PER_S)

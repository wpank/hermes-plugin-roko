from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
from fake_roko import FakeRoko

from hermes_plugin_roko.client import ClientCache, RokoClient
from hermes_plugin_roko.errors import Code, RokoError
from hermes_plugin_roko.settings import Credential, load_settings


def client_for(url: str, key: str | None = None, **settings: Any) -> RokoClient:
    values = {"url": url, **settings}
    s = load_settings(lambda k, d=None: values.get(k, d))
    return RokoClient(s, credential=Credential(key, "test") if key else Credential(None, "none"))


def test_health_and_tool_call(fake: FakeRoko) -> None:
    client = client_for(fake.url)
    assert client.health()["version"] == "0.1.0"
    fake.add_plan("p")
    started = client.call_tool("plan_run", {"plan_id": "p", "max_usd": 1})
    assert started["state"] == "running"
    assert sorted(client.tool_names()) == sorted(
        [
            "run_status",
            "recall",
            "run_prompt",
            "plan_run",
            "plan_generate",
            "run_cancel",
            "confirm_pending",
            "confirm_answer",
            "effects_pending",
            "effect_decide",
        ]
    )


def test_tool_failures_are_classified(fake: FakeRoko) -> None:
    client = client_for(fake.url)
    with pytest.raises(RokoError) as missing:
        client.call_tool("run_status", {"run_id": "x"})
    assert missing.value.code is Code.NOT_FOUND
    fake.boundary = False
    with pytest.raises(RokoError) as refused:
        client.call_tool("run_prompt", {"prompt": "x", "max_usd": 1})
    assert refused.value.code is Code.REFUSED and refused.value.hint


def test_jsonrpc_errors(fake: FakeRoko) -> None:
    client = client_for(fake.url)
    with pytest.raises(RokoError) as invalid:
        client.call_tool("run_prompt", {"prompt": "x"})
    assert invalid.value.code is Code.INVALID and "max_usd is required" in invalid.value.message
    with pytest.raises(RokoError) as unknown:
        client.rpc("resources/list")
    assert unknown.value.code is Code.PROTOCOL and "may be older" in (unknown.value.hint or "")


def test_auth(fake: FakeRoko) -> None:
    fake.auth = True
    with pytest.raises(RokoError) as anonymous:
        client_for(fake.url).get("/api/plans")
    assert anonymous.value.code is Code.UNAUTHORIZED and "--mint" in (anonymous.value.hint or "")
    with pytest.raises(RokoError) as wrong:
        client_for(fake.url, key="roko_wrong").get("/api/plans")
    assert "did not accept" in (wrong.value.hint or "")
    key = fake.add_key("hermes", "write")
    assert client_for(fake.url, key=key).get("/api/plans") == []
    assert fake.requests[-1]["headers"].get("X-Api-Key") == key
    read_key = fake.add_key("viewer", "read")
    with pytest.raises(RokoError) as scoped:
        client_for(fake.url, key=read_key).call_tool("run_cancel", {"run_id": "x"})
    assert scoped.value.code is Code.REFUSED and "write-scoped key" in (scoped.value.hint or "")


def test_unreachable() -> None:
    with pytest.raises(RokoError) as unreachable:
        client_for("http://127.0.0.1:9").health()
    assert unreachable.value.code is Code.UNREACHABLE and unreachable.value.retryable


def test_key_never_goes_over_plain_http_to_another_host() -> None:
    with pytest.raises(RokoError) as refused:
        client_for("http://10.0.0.2:6677", key="roko_k")
    assert refused.value.code is Code.CONFIG
    client_for("http://10.0.0.2:6677", key="roko_k", allow_insecure_remote=True).close()
    client_for("http://10.0.0.2:6677").close()  # no key, nothing to leak


def _client_with(handler: Any) -> RokoClient:
    s = load_settings(lambda k, d=None: {"url": "http://127.0.0.1:6677"}.get(k, d))
    return RokoClient(s, credential=Credential(None, "none"), transport=httpx.MockTransport(handler))


@pytest.mark.parametrize(
    ("status", "body", "headers", "code"),
    [
        (403, {"error": "forbidden", "permission": "config:edit", "role": "member"}, {}, Code.FORBIDDEN),
        (404, {"error": "not_found", "message": "No API route matches GET /api/x"}, {}, Code.NOT_FOUND),
        (409, {"code": "conflict", "message": "a plan run is active"}, {}, Code.CONFLICT),
        (422, {"code": "validation_error", "message": "bad"}, {}, Code.INVALID),
        (429, {"code": "rate_limited", "message": "slow down"}, {"Retry-After": "7"}, Code.RATE_LIMITED),
        (500, {"code": "internal_error", "message": "boom"}, {}, Code.SERVER),
        (401, {"code": "unauthorized", "message": "expired"}, {"X-Key-Expired": "true"}, Code.UNAUTHORIZED),
    ],
)
def test_http_statuses(status: int, body: Any, headers: dict[str, str], code: Code) -> None:
    client = _client_with(lambda request: httpx.Response(status, json=body, headers=headers))
    with pytest.raises(RokoError) as error:
        client.get("/api/x")
    assert error.value.code is code and error.value.status == status
    if status == 429:
        assert error.value.retry_after_s == 7.0
    if status == 403:
        assert "config:edit" in error.value.message
    if status == 401:
        assert "expired" in (error.value.hint or "")


def test_not_json_is_a_protocol_error() -> None:
    client = _client_with(lambda request: httpx.Response(200, text="<html>portal</html>"))
    with pytest.raises(RokoError) as error:
        client.get("/api/plans")
    assert error.value.code is Code.PROTOCOL and "not roko" not in error.value.message


def test_tool_text_without_structured_content() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        rid = json.loads(request.content)["id"]
        result = {"content": [{"type": "text", "text": json.dumps({"ok": 1})}], "isError": False}
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": rid, "result": result})

    assert _client_with(handler).call_tool("recall", {"query": "q"}) == {"ok": 1}


def test_cache_reuses_and_replaces(fake: FakeRoko, monkeypatch: pytest.MonkeyPatch) -> None:
    cache = ClientCache()
    values: dict[str, Any] = {"url": fake.url}
    s = load_settings(lambda k, d=None: values.get(k, d))
    first = cache.get(s)
    assert cache.get(s) is first
    monkeypatch.setenv("ROKO_API_KEY", "roko_new")
    second = cache.get(load_settings(lambda k, d=None: values.get(k, d)))
    assert second is not first
    cache.close()


def test_loopback_requests_ignore_proxy_settings() -> None:
    local = client_for("http://127.0.0.1:6677", key="roko_k")
    remote = client_for("https://roko.example", key="roko_k")
    assert local._http.trust_env is False and remote._http.trust_env is True
    local.close()
    remote.close()


def test_a_replaced_client_keeps_working_for_requests_in_flight(
    fake: FakeRoko, monkeypatch: pytest.MonkeyPatch
) -> None:
    cache = ClientCache()
    values: dict[str, Any] = {"url": fake.url}
    first = cache.get(load_settings(lambda k, d=None: values.get(k, d)))
    values["timeout_s"] = 9  # a live settings change replaces the client
    second = cache.get(load_settings(lambda k, d=None: values.get(k, d)))
    assert second is not first
    assert first.health()["status"] == "ok"  # not closed under a request still using it
    cache.close()
    with pytest.raises(RuntimeError):
        first._http.get("/health")  # closed once the plugin unloads

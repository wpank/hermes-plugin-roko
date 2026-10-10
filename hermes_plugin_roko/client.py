"""A small synchronous client for roko serve: its REST API and its `POST /mcp` endpoint.

Work that starts, stops or answers a run goes through `/mcp` rather than the
REST routes: only runs started there get roko's spending cap, their origin
recorded as `mcp:<key name>`, the request fenced as untrusted text, and
outbound actions held for the person's approval.
"""

from __future__ import annotations

import itertools
import json
import threading
from typing import Any

import httpx

from .errors import Code, RokoError, hint_for_refusal
from .settings import Credential, Settings
from .version import __version__

USER_AGENT = f"hermes-plugin-roko/{__version__}"
CONNECT_TIMEOUT_S = 3.0
# A tool that waits server-side (run_status) gets this much on top of its wait.
WAIT_SLACK_S = 15.0

_ids = itertools.count(1)


class RokoClient:
    """One pooled HTTP client for one roko serve URL and one credential.

    httpx clients are safe to share between threads, so Hermes' parallel
    tool workers can use one `RokoClient` at once.
    """

    def __init__(
        self,
        settings: Settings,
        *,
        credential: Credential | None = None,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        self.settings = settings
        credential = credential if credential is not None else settings.credential()
        self.credential_source = credential.source
        self._has_key = credential.present
        headers = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        if credential.present:
            if (
                httpx.URL(settings.url).scheme == "http"
                and not settings.is_loopback
                and not settings.allow_insecure_remote
            ):
                raise RokoError(
                    Code.CONFIG,
                    f"refusing to send the roko API key over plain http to {settings.display_url}",
                    hint="use an https URL, or set allow_insecure_remote: true if the network is trusted",
                )
            headers["X-Api-Key"] = credential.value or ""
        self._http = httpx.Client(
            base_url=settings.url,
            headers=headers,
            timeout=httpx.Timeout(settings.timeout_s, connect=CONNECT_TIMEOUT_S),
            transport=transport,
            follow_redirects=False,
            # A request to this machine never goes through HTTP(S)_PROXY: a proxy
            # would see the key in clear text.
            trust_env=not settings.is_loopback,
        )

    def close(self) -> None:
        self._http.close()

    # -- REST -------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        """`GET /health`: public, so it answers even when the key is wrong."""
        body = self._request("GET", "/health")
        if not isinstance(body, dict):
            raise RokoError(Code.PROTOCOL, "GET /health did not answer with a JSON object")
        return body

    def get(self, path: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        return self._request("GET", path, params=params, timeout=timeout)

    def post(self, path: str, body: dict[str, Any], *, timeout: float | None = None) -> Any:
        return self._request("POST", path, json_body=body, timeout=timeout)

    def get_response(self, path: str) -> httpx.Response:
        """A raw GET, for doctor checks that read headers or status codes."""
        try:
            return self._http.get(path)
        except httpx.HTTPError as exc:
            raise self._transport_error(exc) from exc

    # -- MCP --------------------------------------------------------------

    def rpc(self, method: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        """One JSON-RPC request to `POST /mcp`; returns its `result`."""
        request: dict[str, Any] = {"jsonrpc": "2.0", "id": next(_ids), "method": method}
        if params is not None:
            request["params"] = params
        body = self._request("POST", "/mcp", json_body=request, timeout=timeout)
        if not isinstance(body, dict):
            raise RokoError(Code.PROTOCOL, f"POST /mcp {method} did not answer with a JSON object")
        if "error" in body and body["error"] is not None:
            raise _rpc_error(method, body["error"])
        if "result" not in body:
            raise RokoError(Code.PROTOCOL, f"POST /mcp {method} answered with neither result nor error")
        return body["result"]

    def call_tool(self, name: str, arguments: dict[str, Any], *, timeout: float | None = None) -> Any:
        """Call one of roko's MCP tools and return its structured result."""
        result = self.rpc("tools/call", {"name": name, "arguments": arguments}, timeout=timeout)
        if not isinstance(result, dict):
            raise RokoError(Code.PROTOCOL, f"roko's {name} tool answered with a non-object result")
        text = _content_text(result)
        if result.get("isError"):
            message = text or f"roko's {name} tool failed"
            if "not found" in message.lower() or message.lower().startswith("no "):
                raise RokoError(Code.NOT_FOUND, message)
            raise RokoError(Code.REFUSED, message, hint=hint_for_refusal(message))
        if "structuredContent" in result:
            return result["structuredContent"]
        if text:
            try:
                return json.loads(text)
            except ValueError:
                return text
        return {}

    def tool_names(self) -> list[str]:
        result = self.rpc("tools/list")
        tools = result.get("tools") if isinstance(result, dict) else None
        if not isinstance(tools, list):
            raise RokoError(Code.PROTOCOL, "roko's tools/list did not return a list of tools")
        return [str(tool.get("name")) for tool in tools if isinstance(tool, dict)]

    # -- plumbing ---------------------------------------------------------

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> Any:
        try:
            response = self._http.request(
                method,
                path,
                params=params,
                json=json_body,
                timeout=httpx.Timeout(timeout, connect=CONNECT_TIMEOUT_S)
                if timeout
                else httpx.USE_CLIENT_DEFAULT,
            )
        except httpx.HTTPError as exc:
            raise self._transport_error(exc) from exc
        if response.status_code >= 400:
            raise self._status_error(method, path, response)
        if response.status_code == 202 and not response.content:
            return {}
        try:
            return response.json()
        except ValueError as exc:
            snippet = response.text[:120].replace("\n", " ")
            raise RokoError(
                Code.PROTOCOL,
                f"{method} {path} answered with something other than JSON: {snippet!r}",
                hint="check that the URL points at roko serve and not another server",
            ) from exc

    def _transport_error(self, exc: httpx.HTTPError) -> RokoError:
        url = self.settings.display_url
        if isinstance(exc, httpx.ConnectTimeout):
            return RokoError(
                Code.UNREACHABLE,
                f"could not connect to roko serve at {url} in time",
                hint="check that roko serve is running at that address",
            )
        if isinstance(exc, httpx.TimeoutException):
            return RokoError(
                Code.UNREACHABLE,
                f"roko serve at {url} did not answer in time",
                hint="check that roko serve is running and not stuck",
                timed_out=True,
            )
        return RokoError(
            Code.UNREACHABLE,
            f"could not reach roko serve at {url} ({type(exc).__name__})",
            hint="start it with `roko serve --workdir <workspace>`, or point the plugin at it "
            "with `hermes roko setup --url <url>`",
        )

    def _status_error(self, method: str, path: str, response: httpx.Response) -> RokoError:
        status = response.status_code
        message = _error_message(response) or f"{method} {path} failed with HTTP {status}"
        if status == 401:
            if response.headers.get("X-Key-Expired"):
                hint = "the API key expired; run `hermes roko setup --mint` for a new one"
            elif self._has_key:
                hint = (
                    f"roko serve did not accept the key from {self.credential_source}; "
                    "run `hermes roko setup` to store a working one"
                )
            else:
                hint = "roko serve has auth on; run `hermes roko setup --mint` to create a key"
            return RokoError(Code.UNAUTHORIZED, message, hint=hint, status=status)
        if status == 403:
            return RokoError(
                Code.FORBIDDEN,
                message,
                hint="the key's scope is too small for this; roko tools need a write-scoped key",
                status=status,
            )
        if status == 404:
            return RokoError(Code.NOT_FOUND, message, status=status)
        if status == 409:
            return RokoError(Code.CONFLICT, message, hint=hint_for_refusal(message), status=status)
        if status == 429:
            retry_after = _float_or_none(response.headers.get("Retry-After"))
            return RokoError(Code.RATE_LIMITED, message, status=status, retry_after_s=retry_after)
        if status in (400, 422):
            return RokoError(Code.INVALID, message, status=status)
        if status >= 500:
            return RokoError(Code.SERVER, message, status=status)
        return RokoError(Code.REFUSED, message, status=status)


class ClientCache:
    """Keeps one `RokoClient` per (url, credential, timeout), replacing it when settings change.

    A replaced client is not closed at once: another thread may still be in a
    request on it (a status wait, or a paid call roko has already accepted).
    Replaced clients are closed when the plugin unloads, or once several
    newer ones have replaced them.
    """

    MAX_RETIRED = 8

    def __init__(self, transport: httpx.BaseTransport | None = None) -> None:
        self._lock = threading.Lock()
        self._key: tuple[str, str | None, str, float, bool] | None = None
        self._client: RokoClient | None = None
        self._retired: list[RokoClient] = []
        self._transport = transport

    def get(self, settings: Settings) -> RokoClient:
        credential = settings.credential()
        key = (
            settings.url,
            credential.value,
            credential.source,
            settings.timeout_s,
            settings.allow_insecure_remote,
        )
        stale: list[RokoClient] = []
        with self._lock:
            if self._client is not None and self._key == key:
                return self._client
            if self._client is not None:
                self._retired.append(self._client)
            if len(self._retired) > self.MAX_RETIRED:
                stale = self._retired[: -self.MAX_RETIRED]
                self._retired = self._retired[-self.MAX_RETIRED :]
            client = RokoClient(settings, credential=credential, transport=self._transport)
            self._client, self._key = client, key
        for old in stale:
            old.close()
        return client

    def close(self) -> None:
        with self._lock:
            clients = [*self._retired, *([self._client] if self._client else [])]
            self._client, self._key, self._retired = None, None, []
        for client in clients:
            client.close()


def _rpc_error(method: str, error: Any) -> RokoError:
    if not isinstance(error, dict):
        return RokoError(Code.PROTOCOL, f"POST /mcp {method} returned a malformed error")
    code = error.get("code")
    message = str(error.get("message") or "unknown JSON-RPC error")
    if code == -32601:
        return RokoError(
            Code.PROTOCOL,
            f"roko serve does not support {method!r}: {message}",
            hint="roko serve may be older than this plugin; update roko",
        )
    if code in (-32600, -32602):
        return RokoError(Code.INVALID, message, hint=hint_for_refusal(message))
    return RokoError(Code.PROTOCOL, f"{method}: {message} (JSON-RPC {code})")


def _content_text(result: dict[str, Any]) -> str:
    content = result.get("content")
    if not isinstance(content, list):
        return ""
    parts = [
        str(item.get("text"))
        for item in content
        if isinstance(item, dict) and item.get("type") == "text" and item.get("text") is not None
    ]
    return "\n".join(parts).strip()


def _error_message(response: httpx.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        text = response.text.strip()
        return text[:300] if text else None
    if isinstance(body, dict):
        for key in ("message", "error"):
            value = body.get(key)
            if isinstance(value, str) and value:
                extra = body.get("permission")
                return f"{value} (needs {extra})" if key == "error" and extra else value
    return None


def _float_or_none(value: str | None) -> float | None:
    try:
        return float(value) if value is not None else None
    except ValueError:
        return None

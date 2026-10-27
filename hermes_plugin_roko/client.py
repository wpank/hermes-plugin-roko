"""A small synchronous client for roko serve: its REST API and its `POST /mcp` endpoint.

Work that starts, stops or answers a run goes through `/mcp` rather than the
REST routes: only runs started there get roko's spending cap, their origin
recorded as `mcp:<key name>`, the request fenced as untrusted text, and
outbound actions held for the person's approval.
"""

from __future__ import annotations

import contextlib
import itertools
import json
import logging
import shlex
import threading
import time
from collections.abc import Iterator
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import _hermes
from .errors import REFUSALS, Code, RokoError, hint_for_refusal, refusal_from_text
from .sanitize import clean
from .settings import Credential, Settings
from .version import __version__

USER_AGENT = f"hermes-plugin-roko/{__version__}"
CONNECT_TIMEOUT_S = 3.0
# A tool that waits server-side (run_status) gets this much on top of its wait.
WAIT_SLACK_S = 15.0

# In round v6 the desktop page went OFFLINE for about 6 s right after a run started, while roko answered:
# the plugin sent 45 requests in that second, roko serve allows a key 30 ([server] rate_limit_per_key_per_sec)
# and answered the rest with 429, dropping the connections of some, and the page's look at /health was one
# of them. So:
# - Requests keep to PACE_PER_S a second, PACE_BURST at once, under roko's default limit. A 429 (roko ran
#   nothing) waits as roko asks, at most RETRY_AFTER_MAX_S, and is sent once more; so is a request whose
#   connection could not be made, or, for a GET, was dropped, after RETRY_PAUSE_S.
# - `health()` calls roko unreachable only after UNREACHABLE_AFTER failed looks in a row, counted once per
#   MISS_GAP_S (the page and the live relay often look at once), or after one when the live stream to roko
#   failed too. Until then it answers what the last good look said, if that is at most VOUCH_S old.
# - /health answered in at most 0.05 s in round v6's takes, also while roko launched runs: HEALTH_TIMEOUT_S
#   is 100 times that. A look that times out, or that roko answers with 429, means roko took the connection:
#   it is busy, not gone, and `status` reads "slow" until it has been slow for STUCK_S.
PACE_PER_S = 25.0
PACE_BURST = 25.0
RETRY_AFTER_MAX_S = 2.0
RETRY_PAUSE_S = 0.25
UNREACHABLE_AFTER = 2
MISS_GAP_S = 1.0
VOUCH_S = 30.0
HEALTH_TIMEOUT_S = 5.0
STUCK_S = 60.0

_ids = itertools.count(1)
logger = logging.getLogger(__name__)


def _now() -> float:
    return time.monotonic()


def _sleep(seconds: float) -> None:
    time.sleep(seconds)


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
        # The name Hermes keeps this key under, when it is the key from Hermes' settings: see `_newer_key`.
        self._key_name = settings.api_key_env if credential.source == f"env:{settings.api_key_env}" else None
        # A project's launch token comes first (0.7.0); when roko refuses it, the configured key, once.
        self._fallback: Credential | None = None
        if credential.source.startswith("launch-token:"):
            configured = settings.configured_key()
            if configured.present and configured.value != credential.value:
                self._fallback = configured
        self._keys = threading.Lock()
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
        # The pace of requests (a token bucket), and what the looks at /health found, for `health()`.
        self._pace_lock = threading.Lock()
        self._tokens = PACE_BURST
        self._paced_at = _now()
        self._looks = threading.Lock()
        self._good: tuple[float, dict[str, Any]] | None = None
        self._misses = 0
        self._missed_at = 0.0
        self._slow_since: float | None = None
        self._stream_lost_at: float | None = None

    def close(self) -> None:
        self._http.close()

    # -- REST -------------------------------------------------------------

    def health(self) -> dict[str, Any]:
        """`GET /health`: public, so it answers even when the key is wrong.

        One failed look is not "roko serve is down": until a second one confirms it (UNREACHABLE_AFTER), this
        answers what the last good look said. A late answer, or a 429, is roko busy: `status` reads "slow".
        """
        try:
            body = self._request("GET", "/health", timeout=HEALTH_TIMEOUT_S)
        except RokoError as exc:
            return self._failed_look(exc)
        if not isinstance(body, dict):
            raise RokoError(Code.PROTOCOL, "GET /health did not answer with a JSON object")
        with self._looks:
            self._good = (_now(), dict(body))
            self._misses, self._slow_since = 0, None
        return body

    def _failed_look(self, exc: RokoError) -> dict[str, Any]:
        """What a look at /health that failed with `exc` says: roko is busy, or this is a blip the last good
        look vouches for, or (raised) roko serve is out of reach."""
        now = _now()
        with self._looks:
            last = dict(self._good[1]) if self._good is not None else {}
            if exc.timed_out or exc.code is Code.RATE_LIMITED:
                if self._slow_since is None:
                    self._slow_since = now
                if now - self._slow_since < STUCK_S:
                    return {**last, "status": "slow"}
                raise exc
            if exc.code is not Code.UNREACHABLE:
                raise exc
            if self._misses == 0 or now - self._missed_at >= MISS_GAP_S:
                self._misses += 1
                self._missed_at = now
            vouched = (
                self._good is not None
                and now - self._good[0] <= VOUCH_S
                and self._misses < UNREACHABLE_AFTER
                and (self._stream_lost_at is None or now - self._stream_lost_at > VOUCH_S)
            )
        if not vouched:
            raise exc
        logger.warning("roko: a look at roko serve failed, not yet called unreachable: %s", exc.message)
        return last

    def get(self, path: str, params: dict[str, Any] | None = None, *, timeout: float | None = None) -> Any:
        return self._request("GET", path, params=params, timeout=timeout)

    def post(self, path: str, body: dict[str, Any], *, timeout: float | None = None) -> Any:
        return self._request("POST", path, json_body=body, timeout=timeout)

    def get_response(self, path: str) -> httpx.Response:
        """A raw GET, for doctor checks that read headers or status codes."""
        return self._send("GET", path, params=None, json_body=None, timeout=None)

    @contextlib.contextmanager
    def stream(
        self, path: str, *, headers: dict[str, str] | None = None, read_timeout_s: float = 30.0
    ) -> Iterator[httpx.Response]:
        """A streaming GET (server-sent events): the open response, closed when the block ends.

        roko sends a keepalive every 8 s, so `read_timeout_s` without a byte means the stream died.
        """
        timeout = httpx.Timeout(self.settings.timeout_s, connect=CONNECT_TIMEOUT_S, read=read_timeout_s)
        self._require_url()
        try:
            for attempt in (1, 2):
                self._pace()
                with self._http.stream(
                    "GET", path, headers={"Accept": "text/event-stream", **(headers or {})}, timeout=timeout
                ) as response:
                    if response.status_code == 401 and attempt == 1 and self._newer_key():
                        response.read()
                        continue
                    if response.status_code >= 400:
                        response.read()
                        raise self._status_error("GET", path, response)
                    with self._looks:
                        self._stream_lost_at = None
                    yield response
                    return
        except httpx.HTTPError as exc:
            # A live stream that broke tells `health()` that a failed look is no blip.
            with self._looks:
                self._stream_lost_at = _now()
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
            error = _tool_error(result)
            # roko's own word for a refusal the person can fix comes first: its text may say "no ...".
            data = error.get("data")
            refusal = _known_refusal(data) or refusal_from_text(message)
            if refusal:
                hint = hint_for_refusal(message, refusal)
                exc = RokoError(Code.REFUSED, message, hint=hint, refusal=refusal, resumable=_resumable(data))
                exc.refusals = _known_refusals(data, refusal)
                if refusal == "cannot_resume":
                    exc.cannot_resume = _cannot_resume(data)
                raise exc
            # roko names the failure (`not_found`, `forbidden`, `conflict`, ...) since 2026-10-15; an
            # older roko only says it in words.
            code = error.get("code")
            if isinstance(code, str):
                missing = code == "not_found"
            else:
                missing = "not found" in message.lower() or message.lower().startswith("no ")
            if missing:
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
        response = self._send(method, path, params=params, json_body=json_body, timeout=timeout)
        if response.status_code == 429:
            # roko ran nothing: wait as long as it asks (or a second), and ask once more.
            pause = _float_or_none(response.headers.get("Retry-After"))
            _sleep(min(max(pause if pause is not None else 1.0, 0.0), RETRY_AFTER_MAX_S))
            response = self._send(method, path, params=params, json_body=json_body, timeout=timeout)
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

    def _send(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None,
        json_body: dict[str, Any] | None,
        timeout: float | None,
    ) -> httpx.Response:
        """One request, paced; refused with 401 (roko ran nothing), it is sent once more when Hermes' .env
        holds a newer key (`_newer_key`)."""
        response = self._exchange(method, path, params=params, json_body=json_body, timeout=timeout)
        if response.status_code == 401 and self._newer_key():
            response = self._exchange(method, path, params=params, json_body=json_body, timeout=timeout)
        return response

    def _newer_key(self) -> bool:
        """Whether Hermes' .env holds another key than the one this client sends, which it sends from then on.

        A Hermes process reads its .env into its environment when it starts, and reads the environment first:
        after `hermes roko init` or `setup` saved a new key, a Hermes app that started before kept sending the
        old one, and the page said the key was refused (round v6). Neither key is ever logged. A refused
        launch token gives way to the configured key, once.
        """
        with self._keys:
            fallback, self._fallback = self._fallback, None
            if fallback is not None and fallback.value:
                self._http.headers["X-Api-Key"] = fallback.value
                self.credential_source = fallback.source
                self._key_name = self.settings.api_key_env
                return True
        if self._key_name is None:
            return False
        saved = _hermes.saved_secret(self._key_name)
        with self._keys:
            if not saved or saved == self._http.headers.get("X-Api-Key"):
                return False
            self._http.headers["X-Api-Key"] = saved
            self.credential_source = f"{self._key_name} in Hermes' .env"
        logger.warning(
            "roko: roko serve refused the key this Hermes started with; it now sends the saved one"
        )
        return True

    def _exchange(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None,
        json_body: dict[str, Any] | None,
        timeout: float | None,
    ) -> httpx.Response:
        """One request, paced. A connection that could not be made (roko never saw the request), or for a GET
        one roko dropped (reading twice is harmless), is tried once more after RETRY_PAUSE_S."""
        try:
            return self._attempt(method, path, params, json_body, timeout)
        except httpx.HTTPError as exc:
            dropped = isinstance(exc, (httpx.ReadError, httpx.WriteError, httpx.RemoteProtocolError))
            if not (isinstance(exc, httpx.ConnectError) or (method == "GET" and dropped)):
                raise self._transport_error(exc) from exc
        _sleep(RETRY_PAUSE_S)
        try:
            return self._attempt(method, path, params, json_body, timeout)
        except httpx.HTTPError as exc:
            raise self._transport_error(exc) from exc

    def _attempt(
        self,
        method: str,
        path: str,
        params: dict[str, Any] | None,
        json_body: dict[str, Any] | None,
        timeout: float | None,
    ) -> httpx.Response:
        self._require_url()
        self._pace()
        return self._http.request(
            method,
            path,
            params=params,
            json=json_body,
            timeout=httpx.Timeout(timeout, connect=CONNECT_TIMEOUT_S)
            if timeout
            else httpx.USE_CLIENT_DEFAULT,
        )

    def _require_url(self) -> None:
        """No URL: no roko serve runs for the project (0.7.0), and nothing is asked anywhere else."""
        if self.settings.url:
            return
        workdir = self.settings.workdir
        if workdir is None:
            raise RokoError(
                Code.UNREACHABLE,
                "no project is chosen for roko, so there is no roko serve to ask",
                hint="pick a project on the roko page, or run `hermes roko init` in your project",
            )
        project = shlex.quote(str(workdir))
        raise RokoError(
            Code.UNREACHABLE,
            f"roko serve is not running for {workdir}",
            hint=f"start it from the roko page, or with `hermes roko serve start --project {project}`",
        )

    def _pace(self) -> None:
        """Wait for this request's turn: at most PACE_PER_S a second, PACE_BURST at once."""
        with self._pace_lock:
            now = _now()
            self._tokens = min(PACE_BURST, self._tokens + (now - self._paced_at) * PACE_PER_S) - 1.0
            self._paced_at = now
            wait = -self._tokens / PACE_PER_S if self._tokens < 0 else 0.0
        if wait > 0:
            _sleep(wait)

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
        # What the OS said ("[Errno 61] Connection refused"): a failure that is no outage can be told apart.
        said = str(exc).strip().splitlines()[0][:120] if str(exc).strip() else ""
        return RokoError(
            Code.UNREACHABLE,
            f"could not reach roko serve at {url} ({type(exc).__name__}{f': {said}' if said else ''})",
            hint=_start_hint(self.settings),
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
    """Keeps one `RokoClient` per project (0.7.0: each has its own roko serve), for its (url, credential,
    timeout), replacing it when those change.

    A replaced client is not closed at once: another thread may still be in a
    request on it (a status wait, or a paid call roko has already accepted).
    Replaced clients are closed when the plugin unloads, or once several
    newer ones have replaced them.
    """

    MAX_RETIRED = 8
    MAX_PROJECTS = 16

    def __init__(self, transport: httpx.BaseTransport | None = None) -> None:
        self._lock = threading.Lock()
        # By project (its path, or the URL without one): the key the client was made for, and the client.
        self._clients: dict[str, tuple[tuple[str, str | None, str, float, bool], RokoClient]] = {}
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
        slot = str(settings.workdir) if settings.workdir is not None else f"url:{settings.url}"
        stale: list[RokoClient] = []
        with self._lock:
            held = self._clients.pop(slot, None)
            if held is not None and held[0] == key:
                self._clients[slot] = held  # the most recently used last
                return held[1]
            if held is not None:
                self._retired.append(held[1])
            client = RokoClient(settings, credential=credential, transport=self._transport)
            self._clients[slot] = (key, client)
            while len(self._clients) > self.MAX_PROJECTS:
                oldest = next(iter(self._clients))
                self._retired.append(self._clients.pop(oldest)[1])
            if len(self._retired) > self.MAX_RETIRED:
                stale = self._retired[: -self.MAX_RETIRED]
                self._retired = self._retired[-self.MAX_RETIRED :]
        for old in stale:
            old.close()
        return client

    def close(self) -> None:
        with self._lock:
            clients = [*self._retired, *(client for _, client in self._clients.values())]
            self._clients, self._retired = {}, []
        for client in clients:
            client.close()


def _rpc_error(method: str, error: Any) -> RokoError:
    if not isinstance(error, dict):
        return RokoError(Code.PROTOCOL, f"POST /mcp {method} returned a malformed error")
    code = error.get("code")
    message = str(error.get("message") or "unknown JSON-RPC error")
    refusal = _known_refusal(error.get("data"))
    if refusal:
        exc = RokoError(Code.REFUSED, message, hint=hint_for_refusal(message, refusal), refusal=refusal)
        exc.refusals = _known_refusals(error.get("data"), refusal)
        return exc
    if code == -32601:
        return RokoError(
            Code.PROTOCOL,
            f"roko serve does not support {method!r}: {message}",
            hint="roko serve may be older than this plugin; update roko",
        )
    if code in (-32600, -32602):
        return RokoError(Code.INVALID, message, hint=hint_for_refusal(message))
    return RokoError(Code.PROTOCOL, f"{method}: {message} (JSON-RPC {code})")


def _start_hint(settings: Settings) -> str:
    """How to start roko serve, with the workspace the plugin knows (else a placeholder)."""
    if settings.workdir is not None and not settings.remote:
        project = shlex.quote(str(settings.workdir))
        return f"the roko page starts it, as does `hermes roko serve start --project {project}`"
    if settings.workdir is None:
        return (
            "start it with `roko serve --workdir WORKSPACE` in your project, or point the plugin at it with "
            "`hermes roko setup --url URL`"
        )
    workdir = shlex.quote(str(settings.workdir))
    command = f"roko serve --workdir {workdir}"
    port = urlsplit(settings.url).port
    if settings.is_loopback and port and port != 6677:
        command += f" --port {port}"
    return (
        f"start it with `{command}`, or let `hermes roko init --workdir {workdir}` start it in the background"
    )


def _tool_error(result: dict[str, Any]) -> dict[str, Any]:
    """`structuredContent.error` of a failed tool call: `{"code", "message", "data"?}`, or `{}`.

    roko answers a failed call as a tool result with `isError` (MCP puts errors the model should read
    there). Since 2026-10-15 it also names the failure there, and a refused run's `data` holds
    `{"refusal", "refusals"}`; an older roko says it only in the text.
    """
    structured = result.get("structuredContent")
    error = structured.get("error") if isinstance(structured, dict) else None
    return error if isinstance(error, dict) else {}


def _known_refusal(data: Any) -> str | None:
    """`data.refusal` when it is a refusal this plugin knows how to explain."""
    refusal = data.get("refusal") if isinstance(data, dict) else None
    return refusal if isinstance(refusal, str) and refusal in REFUSALS else None


def _resumable(data: Any) -> dict[str, Any] | None:
    """The run a `resumable_run` refusal names (roko bug-cbdb6b): its id, status, and the tasks it passed and
    left."""
    if not isinstance(data, dict) or data.get("refusal") != "resumable_run":
        return None
    return resumable_view(data)


def _cannot_resume(data: Any) -> dict[str, Any] | None:
    """The run a `cannot_resume` refusal names (roko bug-b7f6a8): its id, status, why roko cannot continue it,
    the tasks it passed (which a start over runs again) and what it spent."""
    view = resumable_view(data)
    if view is None:
        return None
    named = {key: view.get(key) for key in ("run_id", "status", "reason", "passed_tasks", "spent_usd")}
    return {key: value for key, value in named.items() if value is not None}


def resumable_view(raw: Any) -> dict[str, Any] | None:
    """`{run_id, status, passed_tasks, tasks_left}` of roko's CheckpointRun (a plan row's `resumable_run`, a
    plan run's `resumes` or `set_aside`, or a refusal's data), or None. Since roko bug-b7f6a8 also, when
    roko says them: `continues` (whether a resume continues it), `reason` (why it cannot), `spent_usd` (what
    the run spent before it stopped, which a resume counts against its cap) and a plan run's `left_usd`; since
    bug-4fadf8, `delivery_pending` when every task passed and only the delivery is left."""
    if not isinstance(raw, dict) or not isinstance(raw.get("run_id"), str) or not raw.get("run_id"):
        return None
    view: dict[str, Any] = {
        "run_id": clean(raw["run_id"], 160, one_line=True),
        "status": clean(raw.get("status"), 40, one_line=True) or None,
        "passed_tasks": _task_ids(raw.get("passed_tasks")),
        "tasks_left": _task_ids(raw.get("tasks_left")),
    }
    if isinstance(raw.get("continues"), bool):
        view["continues"] = raw["continues"]
    if raw.get("reason"):
        view["reason"] = clean(raw["reason"], 400, one_line=True)
    for key in ("spent_usd", "left_usd"):
        value = raw.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0:
            view[key] = round(float(value), 6)
    if raw.get("delivery_pending") is True:
        # Since roko bug-4fadf8: every task passed and a crash cut the delivery; a resume only delivers
        # (P-61).
        view["delivery_pending"] = True
    return view


def _task_ids(value: Any) -> list[str]:
    return (
        [clean(task, 80, one_line=True) for task in value if isinstance(task, str)][:200]
        if isinstance(value, list)
        else []
    )


def _known_refusals(data: Any, first: str) -> list[str]:
    """Every refusal `data.refusals` names that the plugin knows, `first` first."""
    listed = data.get("refusals") if isinstance(data, dict) else None
    words = [first, *(listed if isinstance(listed, list) else [])]
    return list(dict.fromkeys(word for word in words if isinstance(word, str) and word in REFUSALS))


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

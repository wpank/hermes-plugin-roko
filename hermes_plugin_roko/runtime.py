"""State shared by the plugin's tools, `/roko` and `hermes roko`: settings, client, run log."""

from __future__ import annotations

import threading
from typing import TYPE_CHECKING, Any

import httpx

from .client import ClientCache, RokoClient
from .rundata import CardCache
from .runlog import RunLog
from .settings import Settings, load_settings

if TYPE_CHECKING:
    from .live_relay import LiveRelay


class Runtime:
    """Everything a handler needs, built once in `register()` without touching the network."""

    def __init__(self, ctx: Any | None, *, transport: httpx.BaseTransport | None = None) -> None:
        self.ctx = ctx
        self._clients = ClientCache(transport)
        self.runs = RunLog(lambda: _state_store(ctx))
        self.cards = CardCache()
        self._live: LiveRelay | None = None
        self._live_lock = threading.Lock()

    @property
    def live(self) -> LiveRelay:
        """The live relay of this process, made on first use (it starts no thread until asked)."""
        with self._live_lock:
            if self._live is None:
                from .live_relay import LiveRelay

                self._live = LiveRelay(self)
            return self._live

    def settings(self) -> Settings:
        getter = getattr(self.ctx, "get_config", None) if self.ctx is not None else None
        return load_settings(getter)

    def client(self, settings: Settings | None = None) -> RokoClient:
        return self._clients.get(settings or self.settings())

    def set_config(self, key: str, value: Any) -> None:
        if self.ctx is None or not hasattr(self.ctx, "set_config"):
            raise RuntimeError("this Hermes cannot save plugin settings")
        self.ctx.set_config(key, value)

    def close(self) -> None:
        if self._live is not None:
            self._live.stop()
        self._clients.close()


def _state_store(ctx: Any | None) -> Any | None:
    if ctx is None:
        return None
    try:
        return ctx.state
    except Exception:
        return None

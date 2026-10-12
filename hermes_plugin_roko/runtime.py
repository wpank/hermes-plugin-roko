"""State shared by the plugin's tools, `/roko` and `hermes roko`: settings, client, run log."""

from __future__ import annotations

from typing import Any

import httpx

from .client import ClientCache, RokoClient
from .rundata import CardCache
from .runlog import RunLog
from .settings import Settings, load_settings


class Runtime:
    """Everything a handler needs, built once in `register()` without touching the network."""

    def __init__(self, ctx: Any | None, *, transport: httpx.BaseTransport | None = None) -> None:
        self.ctx = ctx
        self._clients = ClientCache(transport)
        self.runs = RunLog(lambda: _state_store(ctx))
        self.cards = CardCache()

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
        self._clients.close()


def _state_store(ctx: Any | None) -> Any | None:
    if ctx is None:
        return None
    try:
        return ctx.state
    except Exception:
        return None

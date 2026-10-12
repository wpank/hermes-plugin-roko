"""The plugin's runtime for code Hermes runs without a plugin context.

Hermes mounts `dashboard/plugin_api.py` in its two web backends, `hermes serve`
(behind the desktop app) and `hermes dashboard`, by importing the file on its
own: no `register(ctx)`, no PluginContext. `runtime()` gives those routes the
same settings and run log the tools use, read from the same places:
`plugins.entries.roko.settings` in config.yaml, and the plugin's PluginState
file under `$HERMES_HOME/plugin-data/`.
"""

from __future__ import annotations

import threading
from typing import Any

from . import _hermes
from .runtime import Runtime

_lock = threading.Lock()
_runtime: Runtime | None = None


class HostContext:
    """The two parts of Hermes' PluginContext the Runtime reads."""

    def __init__(self) -> None:
        self._state: Any | None = None
        self._state_lock = threading.Lock()

    def get_config(self, key: str, default: Any = None) -> Any:
        return _hermes.plugin_setting(key, default)

    @property
    def state(self) -> Any | None:
        with self._state_lock:
            if self._state is None:
                self._state = _hermes.plugin_state()
            return self._state


def runtime() -> Runtime:
    """The one Runtime this process's UI routes share."""
    global _runtime
    with _lock:
        if _runtime is None:
            _runtime = Runtime(HostContext())
        return _runtime

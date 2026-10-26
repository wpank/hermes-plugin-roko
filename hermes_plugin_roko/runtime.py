"""State shared by the plugin's tools, `/roko` and `hermes roko`: settings, clients, run log, projects.

Since 0.7.0 each project has its own roko serve. `rt.scoped(project)` is a view of the same runtime whose
`settings()` and `client()` are that project's (the run log, the card cache, the clients and the live relay
stay shared), so everything that takes a runtime works for any project; without a project, the default one.
`rt.for_run(run_id)` is the view of the project a run ran in.
"""

from __future__ import annotations

import copy
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from . import _hermes
from .client import ClientCache, RokoClient
from .projects import Projects
from .rundata import CardCache
from .runlog import RunLog
from .settings import Settings, load_settings

if TYPE_CHECKING:
    from .live_relay import LiveRelay

# Where the plugin keeps its own files when Hermes gives it no state directory (tests, a bare runtime).
FALLBACK_DATA_DIR = "roko"


class Runtime:
    """Everything a handler needs, built once in `register()` without touching the network."""

    def __init__(self, ctx: Any | None, *, transport: httpx.BaseTransport | None = None) -> None:
        self.ctx = ctx
        # The project this view is about (`scoped`); None: the default project.
        self.project: Path | None = None
        self._root: Runtime = self
        self._clients = ClientCache(transport)
        self.runs = RunLog(lambda: _state_store(ctx))
        self.cards = CardCache()
        self.projects = Projects(lambda: _state_store(ctx), self._workdir_setting, self.data_dir)
        # serve.py's last look at each project's roko serve, by project path.
        self.serve_states: dict[str, Any] = {}
        self._live: LiveRelay | None = None
        self._live_lock = threading.Lock()

    @property
    def root(self) -> Runtime:
        """The runtime this view was made from (itself when it is no view)."""
        return self._root

    def scoped(self, project: Path | None) -> Runtime:
        """This runtime, about `project` (None: the default project)."""
        view = copy.copy(self._root)
        view.project = project
        return view

    def for_run(self, run_id: str) -> Runtime:
        """The view of the project run `run_id` ran in, as the run log says; runs logged before 0.7.0 belong
        to the default project, and a run the log does not have (one Hermes did not start) to this view's
        project (P-55)."""
        logged = self.runs.get(run_id)
        if logged is None:
            return self.scoped(self.project)
        project = logged.get("project")
        if isinstance(project, str) and project.startswith("/"):
            return self.scoped(Path(project))
        return self.scoped(None)

    @property
    def live(self) -> LiveRelay:
        """The live relay of this process, made on first use (it starts no thread until asked)."""
        root = self._root
        with root._live_lock:
            if root._live is None:
                from .live_relay import LiveRelay

                root._live = LiveRelay(root)
            return root._live

    def settings(self, project: Path | None = None) -> Settings:
        """The settings, about `project`, else this view's project, else the default project."""
        base = load_settings(self._getter())
        if base.remote:
            return base
        target = project if project is not None else self.project
        if target is None:
            target = self.projects.default()
        if target is None:
            return base
        return base.for_project(target)

    def client(self, settings: Settings | None = None, *, project: Path | None = None) -> RokoClient:
        return self._clients.get(settings or self.settings(project))

    def data_dir(self) -> Path:
        """The plugin's own folder under Hermes' home (`plugin-data/<plugin>`): locks and markers."""
        store = _state_store(self.ctx)
        try:
            directory = getattr(store, "data_dir", None) if store is not None else None
        except Exception:
            directory = None
        if directory:
            return Path(directory)
        return _hermes.hermes_home() / "plugin-data" / FALLBACK_DATA_DIR

    def set_config(self, key: str, value: Any) -> None:
        if self.ctx is None or not hasattr(self.ctx, "set_config"):
            raise RuntimeError("this Hermes cannot save plugin settings")
        self.ctx.set_config(key, value)

    def close(self) -> None:
        root = self._root
        if root._live is not None:
            root._live.stop()
        root._clients.close()

    def _getter(self) -> Any:
        return getattr(self.ctx, "get_config", None) if self.ctx is not None else None

    def _workdir_setting(self) -> Path | None:
        return load_settings(self._getter()).workdir_setting


def _state_store(ctx: Any | None) -> Any | None:
    if ctx is None:
        return None
    try:
        return ctx.state
    except Exception:
        return None

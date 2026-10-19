"""The runs this Hermes started, so a later turn or session can find them by name.

Kept in Hermes' per-plugin state file (`ctx.state`), which survives restarts
and is shared by the CLI, the gateway, and the desktop and dashboard backends.
If that store is unavailable the log lives in memory for the process. It holds
ids, labels and the person's own request, never output.

Several processes change the log (a chat starts a run while a UI backend
records its state), and the store's `get` and `set` are only atomic one at a
time, so every change takes a lock file next to the store first: otherwise one
process could write back a list read before another added a run, and drop it.
"""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any, Protocol

from .sanitize import clean

logger = logging.getLogger(__name__)

STATE_KEY = "runs.v1"
LOCK_NAME = "runs.lock"
# Enough for a busy day: the daily spend limit reads today's runs from here.
MAX_RUNS = 100
# The start of what the person asked for, shown on the run's page when a title names the run.
REQUEST_CHARS = 600


class StateStore(Protocol):
    def get(self, key: str, default: Any = None) -> Any: ...

    def set(self, key: str, value: Any) -> None: ...


class RunLog:
    def __init__(self, store: Callable[[], StateStore | None] | StateStore | None) -> None:
        # A callable is resolved on first use, so building the log touches no files.
        self._store_source = store
        self._store_resolved = not callable(store)
        self._store: StateStore | None = None if callable(store) else store
        self._memory: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def _resolve_store(self) -> StateStore | None:
        if not self._store_resolved:
            self._store_resolved = True
            try:
                factory = self._store_source
                self._store = factory() if callable(factory) else None
            except Exception as exc:
                logger.debug("roko: plugin state unavailable, using memory: %s", exc)
                self._store = None
        return self._store

    def add(
        self,
        run_id: str,
        kind: str,
        label: str,
        *,
        plan_id: str | None = None,
        session_id: str | None = None,
        state: str | None = None,
        max_usd: float | None = None,
        source: str | None = None,
        request: str | None = None,
        project: str | None = None,
        url: str | None = None,
    ) -> None:
        """Log a run Hermes started. `project` (an absolute path) and `url` say which project's roko serve ran
        it (0.7.0); an entry without them belongs to the default project."""
        entry: dict[str, Any] = {
            "run_id": run_id,
            "kind": kind,
            "label": clean(label, 120, one_line=True),
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        for key, value in (
            ("plan_id", plan_id),
            ("session_id", session_id),
            ("state", state),
            ("max_usd", max_usd),
            ("source", source),
            ("request", clean(request, REQUEST_CHARS) if request else None),
            ("project", project),
            ("url", url or None),
        ):
            if value is not None:
                entry[key] = value
        with self._transaction():
            runs = [run for run in self._load() if run.get("run_id") != run_id]
            runs.insert(0, entry)
            self._save(runs[:MAX_RUNS])

    def update(self, run_id: str, **fields: Any) -> None:
        """Merge non-None `fields` into the run's entry; writes only when something changed."""
        with self._transaction():
            runs = self._load()
            for run in runs:
                if run.get("run_id") == run_id:
                    changes = {k: v for k, v in fields.items() if v is not None and run.get(k) != v}
                    if changes:
                        run.update(changes)
                        self._save(runs)
                    return

    def get(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            for run in self._load():
                if run.get("run_id") == run_id:
                    return dict(run)
        return None

    def recent(self, limit: int = 10) -> list[dict[str, Any]]:
        with self._lock:
            return [dict(run) for run in self._load()[:limit]]

    @contextlib.contextmanager
    def _transaction(self) -> Iterator[None]:
        """Hold this process's lock and, when the store has a directory, the cross-process lock file."""
        with self._lock:
            path = self._lock_path()
            if path is None:
                yield
                return
            try:
                import fcntl
            except ImportError:  # pragma: no cover - Windows: the thread lock is all there is
                yield
                return
            try:
                path.parent.mkdir(parents=True, exist_ok=True)
                handle = path.open("a+b")
            except OSError as exc:
                logger.debug("roko: run log lock unavailable: %s", exc)
                yield
                return
            with handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)

    def _lock_path(self) -> Path | None:
        store = self._resolve_store()
        try:
            directory = getattr(store, "data_dir", None)
        except Exception:
            return None
        return Path(directory) / LOCK_NAME if directory else None

    def _load(self) -> list[dict[str, Any]]:
        store = self._resolve_store()
        if store is not None:
            try:
                value = store.get(STATE_KEY, [])
            except Exception as exc:
                logger.debug("roko: plugin state unreadable, using memory: %s", exc)
            else:
                if isinstance(value, list):
                    return [run for run in value if isinstance(run, dict)]
                return []
        return [dict(run) for run in self._memory]

    def _save(self, runs: list[dict[str, Any]]) -> None:
        store = self._resolve_store()
        if store is not None:
            try:
                store.set(STATE_KEY, runs)
                return
            except Exception as exc:
                logger.debug("roko: plugin state unwritable, using memory: %s", exc)
        self._memory = [dict(run) for run in runs]

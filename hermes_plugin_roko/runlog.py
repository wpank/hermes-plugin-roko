"""The runs this Hermes started, so a later turn or session can find them by name.

Kept in Hermes' per-plugin state file (`ctx.state`), which survives restarts
and is shared by the CLI and the gateway. If that store is unavailable the log
lives in memory for the process. It holds ids and labels only, never output.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from typing import Any, Protocol

logger = logging.getLogger(__name__)

STATE_KEY = "runs.v1"
MAX_RUNS = 50


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
    ) -> None:
        entry: dict[str, Any] = {
            "run_id": run_id,
            "kind": kind,
            "label": label[:120],
            "started_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        for key, value in (
            ("plan_id", plan_id),
            ("session_id", session_id),
            ("state", state),
            ("max_usd", max_usd),
        ):
            if value is not None:
                entry[key] = value
        with self._lock:
            runs = [run for run in self._load() if run.get("run_id") != run_id]
            runs.insert(0, entry)
            self._save(runs[:MAX_RUNS])

    def update(self, run_id: str, **fields: Any) -> None:
        with self._lock:
            runs = self._load()
            for run in runs:
                if run.get("run_id") == run_id:
                    run.update({k: v for k, v in fields.items() if v is not None})
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

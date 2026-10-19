"""The projects Hermes uses roko in: the default one, and those the person or a chat picked (0.7.0).

A project is a git checkout roko works in; each has its own roko serve (serve.py). They are kept in the
plugin's state next to the run log, under `projects.v1`:

    {"default": "/abs", "items": {"/abs": {"added_at", "last_used"}}, "workdir_setting": "/abs" | null}

The `workdir` setting is the default project until the person picks another; a setting that changed since
it was last seen (`workdir_setting`) is the default again. Seeding from the setting happens in memory, so
reading never writes (`register()` reads settings in every Hermes process); the next change writes it.

Several processes change the state (the desktop backend, a chat, the CLI), and the store's `get` and `set`
are only atomic one at a time, so a change takes `projects.lock` next to the store first, as the run log
does with its own.
"""

from __future__ import annotations

import contextlib
import logging
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from . import _hermes
from .errors import Code, RokoError
from .runlog import StateStore
from .sanitize import clean
from .workspace import _git

logger = logging.getLogger(__name__)

STATE_KEY = "projects.v1"
LOCK_NAME = "projects.lock"
# A read of the state is reused this long (settings() asks for the default project on every call).
CACHE_S = 1.0
MAX_PROJECTS = 50

State = dict[str, Any]


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def canonical(path: str | Path) -> Path:
    """An absolute, resolved path (`~` expanded)."""
    return Path(path).expanduser().resolve()


def inside_hermes(path: Path) -> bool:
    """Whether `path` is Hermes' home or inside it (a project never is: Hermes' own files are not roko's)."""
    homes = {canonical(_hermes.hermes_home()), canonical(Path.home() / ".hermes")}
    return any(path == home or home in path.parents for home in homes)


def check_folder(value: Any) -> Path:
    """The project a folder names: the folder itself when it holds a roko.toml, else the top of its git
    checkout. Raises `invalid` for anything else: not an absolute path, not a folder, inside Hermes' home,
    not in a git checkout."""
    if not isinstance(value, str) or not value.strip():
        raise RokoError(Code.INVALID, "name the project's folder (an absolute path)")
    raw = Path(value.strip()).expanduser()
    if not raw.is_absolute():
        raise RokoError(
            Code.INVALID,
            f"{clean(value, 300, one_line=True)} is not an absolute path",
            hint="name the project's folder by its full path, such as /Users/you/src/app",
        )
    try:
        folder = raw.resolve()
        is_dir = folder.is_dir()
    except (OSError, RuntimeError):
        is_dir = False
        folder = raw
    if not is_dir:
        raise RokoError(Code.INVALID, f"{folder} is not a folder", hint="pick an existing folder")
    if inside_hermes(folder):
        raise RokoError(
            Code.INVALID,
            f"{folder} is inside Hermes' own folder, which is not a project",
            hint="pick the folder of a project roko should work in",
        )
    if (folder / "roko.toml").is_file():
        return folder
    top = _git(folder, "rev-parse", "--show-toplevel")
    if not top:
        raise RokoError(
            Code.INVALID,
            f"{folder} is not a git checkout, and roko works on branches of one",
            hint=f"make it one first: git -C '{folder}' init, then commit what you have",
        )
    project = canonical(top)
    if inside_hermes(project):
        raise RokoError(
            Code.INVALID,
            f"{project} is inside Hermes' own folder, which is not a project",
            hint="pick the folder of a project roko should work in",
        )
    return project


class Projects:
    """The known projects, read from and written to the plugin's state (module docstring)."""

    def __init__(
        self,
        store: Callable[[], StateStore | None],
        setting: Callable[[], Path | None],
        data_dir: Callable[[], Path | None],
    ) -> None:
        self._store_source = store
        self._store: StateStore | None = None
        self._store_resolved = False
        self._setting = setting
        self._data_dir = data_dir
        self._memory: State = {}
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._cached: tuple[float, Path | None, State] | None = None

    # -- reading ----------------------------------------------------------------------------------

    def state(self) -> State:
        """The effective state: what is stored, with the `workdir` setting seeded in."""
        setting = self._workdir_setting()
        with self._lock:
            hit = self._cached
            if hit is not None and hit[1] == setting and time.monotonic() - hit[0] < CACHE_S:
                return _copy(hit[2])
            state = _effective(self._load(), setting)
            self._cached = (time.monotonic(), setting, state)
            return _copy(state)

    def default(self) -> Path | None:
        value = self.state().get("default")
        return Path(value) if isinstance(value, str) and value else None

    def paths(self) -> list[Path]:
        """Every known project: the default first, then the most recently used, then in the order added."""
        state = self.state()
        items: dict[str, dict[str, Any]] = state["items"]
        # Newest use first; a stable sort keeps the order added among the never used.
        ordered = sorted(items, key=lambda path: str(items[path].get("last_used") or ""), reverse=True)
        default = state.get("default")
        if default in items:
            ordered.remove(default)
            ordered.insert(0, default)
        return [Path(path) for path in ordered]

    def known(self, path: Path) -> bool:
        return str(path) in self.state()["items"]

    def find(self, value: str) -> Path | None:
        """A known project by its path or its name (or the folder name at the end of its name)."""
        wanted = value.strip()
        if not wanted:
            return None
        items = self.state()["items"]
        if wanted.startswith(("/", "~")):
            with contextlib.suppress(OSError, RuntimeError):
                path = canonical(wanted)
                if str(path) in items:
                    return path
            return None
        names = {path: self.name(Path(path)) for path in items}
        exact = [path for path, name in names.items() if name.lower() == wanted.lower()]
        if len(exact) == 1:
            return Path(exact[0])
        tail = [path for path in items if Path(path).name.lower() == wanted.lower()]
        return Path(tail[0]) if len(tail) == 1 else None

    def name(self, path: Path) -> str:
        """The folder's name; "parent/name" when another known project's folder has the same name."""
        items = self.state()["items"]
        same = [other for other in items if Path(other).name == path.name and Path(other) != path]
        if same:
            return f"{path.parent.name}/{path.name}" if path.parent.name else path.name
        return path.name or str(path)

    # -- changing -----------------------------------------------------------------------------------

    def add(self, value: str | Path) -> Path:
        """Know the project a folder names (check_folder); the first project becomes the default."""
        project = check_folder(str(value))

        def change(state: State) -> None:
            items = state["items"]
            if str(project) not in items:
                items[str(project)] = {"added_at": now_iso(), "last_used": None}
                _trim(state)
            if not state.get("default"):
                state["default"] = str(project)

        self._update(change)
        return project

    def remove(self, value: str | Path) -> Path:
        path = self._resolve(value)

        def change(state: State) -> None:
            items = state["items"]
            if str(path) not in items:
                raise RokoError(Code.INVALID, f"{path} is not a project Hermes knows")
            del items[str(path)]
            if state.get("default") == str(path):
                rest = sorted(items, key=lambda key: str(items[key].get("last_used") or ""), reverse=True)
                state["default"] = rest[0] if rest else None

        self._update(change)
        return path

    def set_default(self, value: str | Path) -> Path:
        path = self._resolve(value, add=True)

        def change(state: State) -> None:
            state["items"].setdefault(str(path), {"added_at": now_iso(), "last_used": None})
            state["default"] = str(path)
            _trim(state)

        self._update(change)
        return path

    def touch(self, path: Path) -> None:
        """A run or a page used `path` now (it becomes known when it was not)."""

        def change(state: State) -> None:
            item = state["items"].setdefault(str(path), {"added_at": now_iso(), "last_used": None})
            item["last_used"] = now_iso()
            if not state.get("default"):
                state["default"] = str(path)
            _trim(state)

        try:
            self._update(change)
        except Exception:  # a page or a run must not fail for its bookkeeping
            logger.debug("roko: could not note that %s was used", path, exc_info=True)

    def _resolve(self, value: str | Path, *, add: bool = False) -> Path:
        found = self.find(str(value))
        if found is not None:
            return found
        if add:
            return check_folder(str(value))
        with contextlib.suppress(OSError, RuntimeError):
            return canonical(value)
        raise RokoError(Code.INVALID, f"{clean(value, 300, one_line=True)} is not a project Hermes knows")

    def _update(self, change: Callable[[State], None]) -> None:
        setting = self._workdir_setting()
        with self._transaction():
            state = _effective(self._load(), setting)
            change(state)
            self._save(state)
        with self._lock:
            self._cached = None

    # -- the store ----------------------------------------------------------------------------------

    def _workdir_setting(self) -> Path | None:
        try:
            value = self._setting()
        except Exception:
            return None
        if value is None:
            return None
        try:
            return canonical(value)
        except (OSError, RuntimeError):
            return None

    def _resolve_store(self) -> StateStore | None:
        if not self._store_resolved:
            self._store_resolved = True
            try:
                self._store = self._store_source()
            except Exception as exc:
                logger.debug("roko: plugin state unavailable for projects, using memory: %s", exc)
                self._store = None
        return self._store

    def _load(self) -> State:
        store = self._resolve_store()
        if store is not None:
            try:
                value = store.get(STATE_KEY, {})
            except Exception as exc:
                logger.debug("roko: projects unreadable, using memory: %s", exc)
            else:
                return value if isinstance(value, dict) else {}
        return _copy(self._memory)

    def _save(self, state: State) -> None:
        store = self._resolve_store()
        if store is not None:
            try:
                store.set(STATE_KEY, state)
                return
            except Exception as exc:
                logger.debug("roko: projects unwritable, using memory: %s", exc)
        self._memory = _copy(state)

    @contextlib.contextmanager
    def _transaction(self) -> Iterator[None]:
        """This process's lock and, when the store has a directory, the cross-process lock file."""
        with self._write_lock:
            directory = self._data_dir()
            if directory is None:
                yield
                return
            try:
                import fcntl
            except ImportError:  # pragma: no cover - Windows: the thread lock is all there is
                yield
                return
            try:
                directory.mkdir(parents=True, exist_ok=True)
                handle = (directory / LOCK_NAME).open("a+b")
            except OSError as exc:
                logger.debug("roko: projects lock unavailable: %s", exc)
                yield
                return
            with handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                try:
                    yield
                finally:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _effective(stored: Any, setting: Path | None) -> State:
    """The stored state with the `workdir` setting seeded in (module docstring)."""
    stored = stored if isinstance(stored, dict) else {}
    raw_items = stored.get("items")
    items: dict[str, dict[str, Any]] = {}
    for key, value in raw_items.items() if isinstance(raw_items, dict) else []:
        if isinstance(key, str) and key.startswith("/"):
            items[key] = dict(value) if isinstance(value, dict) else {}
    default = stored.get("default") if isinstance(stored.get("default"), str) else None
    seen = stored.get("workdir_setting") if isinstance(stored.get("workdir_setting"), str) else None
    if setting is not None and str(setting) != seen:
        items.setdefault(str(setting), {"added_at": now_iso(), "last_used": None})
        default, seen = str(setting), str(setting)
    if default is not None and default not in items:
        default = None
    return {"default": default, "items": items, "workdir_setting": seen}


def _trim(state: State) -> None:
    """At most MAX_PROJECTS: the least recently used go first (never the default)."""
    items = state["items"]
    while len(items) > MAX_PROJECTS:
        oldest = min(
            (key for key in items if key != state.get("default")),
            key=lambda key: str(items[key].get("last_used") or items[key].get("added_at") or ""),
        )
        del items[oldest]


def _copy(state: State) -> State:
    return {
        "default": state.get("default"),
        "items": {key: dict(value) for key, value in (state.get("items") or {}).items()},
        "workdir_setting": state.get("workdir_setting"),
    }

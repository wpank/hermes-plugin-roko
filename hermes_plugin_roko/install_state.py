"""Is the roko plugin this Hermes runs the one installed on disk?

Hermes loads a plugin once per process, and `hermes plugins update roko` reloads nothing (docs/updating.md):

- this package, behind the desktop app's backend and `hermes dashboard`, is imported when that process
  starts; the update rewrites the files under it and nothing imports them again;
- the desktop app runs a copy of `desktop/plugin.js` from `<root>/desktop-plugins/roko/`. It refreshes the
  copy when it starts or rescans, and only when the source is newer than the copy's
  `.hermes-package.json` marker says (apps/desktop/electron/desktop-plugins-root.ts).

`status()` compares what this process loaded, what is on disk now, and the desktop copy. `problems()` turns
a difference into the `restart-hermes` Problem that the pages and the doctor show. Both only stat and read
small files, and never raise.
"""

from __future__ import annotations

import json
import logging
import re
import shlex
from pathlib import Path
from typing import Any

from . import _hermes
from .version import __version__

logger = logging.getLogger(__name__)

PACKAGE_DIR = Path(__file__).resolve().parent
PLUGIN_ROOT = PACKAGE_DIR.parent
PLUGIN_ID = "roko"
DESKTOP_PLUGINS_DIR = "desktop-plugins"
MARKER = ".hermes-package.json"
# Where the restart is explained, relative to the plugin's docs/ (as readiness.DOCS).
DOCS = "updating.md#2-restart-what-you-use"
# Hermes compares mtimes in milliseconds as floats; this absorbs the rounding between Node and Python.
MTIME_SLACK_MS = 1.0
# The page's version sits near its top; old pages only name it in the header comment.
JS_HEAD_BYTES = 65_536
_JS_VERSION = re.compile(r"""^\s*const VERSION = ['"]([^'"\s]+)['"]""", re.MULTILINE)
_JS_HEADER_VERSION = re.compile(r"hermes-plugin-roko \((\d[^)\s]*)\)")
_PY_VERSION = re.compile(r"""^__version__\s*=\s*['"]([^'"]+)['"]""", re.MULTILINE)
_YAML_VERSION = re.compile(r"""^version:\s*['"]?([^\s'"#]+)""", re.MULTILINE)

STEPS = {
    "desktop": [
        "Quit Hermes with ⌘Q. Closing the window is not enough: the app keeps running.",
        "Open Hermes again.",
    ],
    "dashboard": [
        "Stop `hermes dashboard` (Ctrl-C where it runs) and start it again.",
        "Reload this page.",
    ],
    "terminal": [
        "Desktop app: quit Hermes with ⌘Q and open it again.",
        "Web dashboard: stop `hermes dashboard` and start it again.",
        "Messaging gateway: `hermes gateway restart`.",
    ],
}


def _code_files() -> list[Path]:
    """The Python that a running Hermes holds in memory: this package and the files that load it."""
    files = sorted(PACKAGE_DIR.glob("*.py"))
    files += [PLUGIN_ROOT / "__init__.py", PLUGIN_ROOT / "dashboard" / "plugin_api.py"]
    return files


def _fingerprint() -> tuple[tuple[str, int, int], ...] | None:
    """Name, size and mtime of each code file. An update rewrites the files it changes, so this moves."""
    try:
        rows = []
        for path in _code_files():
            try:
                info = path.stat()
            except OSError:
                continue
            name = path.name if path.parent == PACKAGE_DIR else str(path)
            rows.append((name, info.st_size, info.st_mtime_ns))
        return tuple(rows)
    except Exception:
        logger.debug("roko: could not fingerprint the plugin's files", exc_info=True)
        return None


# Taken when this module is imported: register() imports every module of the package at load, and
# ui_api imports this one when the backend mounts its routes, so this is the code the process runs.
LOADED_VERSION = __version__
_LOADED_FINGERPRINT = _fingerprint()


def status(home: str | Path | None = None) -> dict[str, Any]:
    """What this process loaded, what is on disk, and the desktop app's copy of the page.

    `backend_stale`: the files on disk are not the ones this process imported (a new version, or the same
    version with other code). `desktop_copy_stale`: the desktop app would replace its copy of the page on its
    next start or rescan, or it never will (a copy without Hermes' marker) and the copy is not the installed
    page. Unknown is never stale.
    """
    try:
        return _status(Path(home).expanduser() if home is not None else _hermes.hermes_home())
    except Exception:
        logger.debug("roko: install state unavailable", exc_info=True)
        return {
            "loaded_version": LOADED_VERSION,
            "disk_version": None,
            "desktop_copy_version": None,
            "desktop_copy_stale": False,
            "backend_stale": False,
            "desktop_copy": None,
            "desktop_copy_marker": None,
        }


def problems(home: str | Path | None = None) -> list[dict[str, Any]]:
    """The `restart-hermes` Problem when this Hermes runs an older roko than the one installed, else []."""
    try:
        return _problems(status(home))
    except Exception:
        logger.debug("roko: install problems unavailable", exc_info=True)
        return []


def _status(home: Path) -> dict[str, Any]:
    disk = disk_version()
    fingerprint = _fingerprint()
    backend_stale = bool(disk and disk != LOADED_VERSION) or (
        fingerprint is not None and _LOADED_FINGERPRINT is not None and fingerprint != _LOADED_FINGERPRINT
    )
    copy = _desktop_copy(home)
    return {
        "loaded_version": LOADED_VERSION,
        "disk_version": disk,
        "desktop_copy_version": copy["version"],
        "desktop_copy_stale": copy["stale"],
        "backend_stale": backend_stale,
        "desktop_copy": copy["path"],
        "desktop_copy_marker": copy["marker"],
    }


def disk_version() -> str | None:
    """The installed version, read from the files without importing them."""
    found = _read_match(PACKAGE_DIR / "version.py", _PY_VERSION)
    return found or _read_match(PLUGIN_ROOT / "plugin.yaml", _YAML_VERSION)


def js_version(path: Path) -> str | None:
    """A desktop page's version: its `const VERSION = '…'`, else the one in its header comment."""
    try:
        with path.open("rb") as handle:
            head = handle.read(JS_HEAD_BYTES).decode("utf-8", errors="replace")
    except OSError:
        return None
    for pattern in (_JS_VERSION, _JS_HEADER_VERSION):
        match = pattern.search(head)
        if match:
            return match.group(1)
    return None


def desktop_root(home: Path) -> Path:
    """The desktop app's plugin folder. It belongs to the app, never to a profile, so a profile's home
    (`<root>/profiles/<name>`) shares the root's."""
    root = home.parent.parent if home.parent.name == "profiles" else home
    return root / DESKTOP_PLUGINS_DIR


def _desktop_copy(home: Path) -> dict[str, Any]:
    none: dict[str, Any] = {"path": None, "version": None, "stale": False, "marker": None}
    root = desktop_root(home)
    names = list(dict.fromkeys([PLUGIN_ID, PLUGIN_ROOT.name]))
    found = [(name, root / name) for name in names if (root / name / "plugin.js").is_file()]
    if not found:
        return none
    own_source = (PLUGIN_ROOT / "desktop").resolve()
    copies = [(name, folder, _read_marker(folder)) for name, folder in found]
    # The copy made from this package, if there is one; else the first (an install elsewhere, a hand copy).
    ours = [c for c in copies if c[2] is not None and _same_path(c[2].get("source"), own_source)]
    name, folder, marker = (ours or copies)[0]
    copy_js = folder / "plugin.js"
    source_dir = _hermes_source(home, name, marker)
    return {
        "path": str(folder),
        "version": js_version(copy_js),
        "stale": _copy_stale(copy_js, marker, source_dir),
        "marker": marker is not None,
    }


def _hermes_source(home: Path, name: str, marker: dict[str, Any] | None) -> Path:
    """The `desktop/` folder Hermes copies the page from: the package of the copy's name in the root
    home's plugins, then in this profile's (Hermes walks the root first), else the one the marker names,
    else this package's own."""
    for base in dict.fromkeys([desktop_root(home).parent, home]):
        package = base / "plugins" / name / "desktop"
        if (package / "plugin.js").is_file():
            return package
    source = marker.get("source") if marker else None
    if isinstance(source, str) and source:
        return Path(source)
    return PLUGIN_ROOT / "desktop"


def _copy_stale(copy_js: Path, marker: dict[str, Any] | None, source_dir: Path) -> bool:
    source_js = source_dir / "plugin.js"
    try:
        source_mtime_ms = source_js.stat().st_mtime_ns / 1e6
    except OSError:
        return False  # no source: Hermes drops the copy on its next scan, and nothing here can say more
    if marker is None:
        # Hermes adopts a marker-less copy only if it matches the source byte for byte, and otherwise
        # never touches it (#112450): different bytes stay stale until the folder is deleted.
        return not _same_bytes(copy_js, source_js)
    if not _same_path(marker.get("source"), source_dir.resolve()):
        return True  # Hermes copies from another package next time
    if marker.get("linked"):
        return not _same_bytes(copy_js, source_js)
    copied = marker.get("sourceMtimeMs")
    if not isinstance(copied, int | float):
        return True
    return source_mtime_ms - float(copied) > MTIME_SLACK_MS


def _problems(state: dict[str, Any]) -> list[dict[str, Any]]:
    backend, desktop = bool(state.get("backend_stale")), bool(state.get("desktop_copy_stale"))
    if not backend and not desktop:
        return []
    disk = state.get("disk_version")
    loaded = state.get("loaded_version")
    copy_version = state.get("desktop_copy_version")
    if backend and disk and loaded and disk != loaded:
        title = f"roko {disk} is installed, but Hermes is still running {loaded}."
    elif backend:
        title = "roko was updated on disk, but Hermes is still running the code it started with."
    elif copy_version and disk and copy_version != disk:
        title = f"The desktop app still shows roko {copy_version}; {disk} is installed."
    else:
        title = "The desktop app still shows an older roko page than the one installed."
    steps = {surface: list(lines) for surface, lines in STEPS.items()}
    if desktop and state.get("desktop_copy_marker") is False and state.get("desktop_copy"):
        folder = state["desktop_copy"]
        steps["desktop"] = [
            f"Delete the folder {folder}. Hermes never replaces a copy it did not make.",
            *steps["desktop"],
        ]
        steps["terminal"] = [f"rm -r {shlex.quote(str(folder))}", *steps["terminal"]]
    return [
        {
            "id": "restart-hermes",
            "severity": "warn",
            "title": title,
            "detail": (
                "Hermes loads plugins when it starts, so an update takes effect after a restart. "
                "Until then you see the old roko, and its newer keys may not work."
            ),
            "fix": {
                "kind": "restart-hermes",
                "label": "restart hermes",
                "action": None,
                "command": None,
                "docs": DOCS,
            },
            "steps": steps,
            "parts": {"backend": backend, "desktop_copy": desktop},
        }
    ]


def _read_match(path: Path, pattern: re.Pattern[str]) -> str | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")[:JS_HEAD_BYTES]
    except OSError:
        return None
    match = pattern.search(text)
    return match.group(1) if match else None


def _read_marker(folder: Path) -> dict[str, Any] | None:
    """Hermes' marker, when it is one Hermes itself would accept (`package` and `source` set)."""
    try:
        data = json.loads((folder / MARKER).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if isinstance(data, dict) and data.get("package") and data.get("source"):
        return data
    return None


def _same_path(value: Any, resolved: Path) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        return Path(value).expanduser().resolve() == resolved
    except OSError:
        return False


def _same_bytes(a: Path, b: Path) -> bool:
    """Same content on both paths; a file that can't be read is never a match."""
    try:
        if a.stat().st_size != b.stat().st_size:
            return False
        return a.read_bytes() == b.read_bytes()
    except OSError:
        return False

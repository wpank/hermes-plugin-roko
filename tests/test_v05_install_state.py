"""install_state: is the roko this Hermes runs the one installed on disk (docs/updating.md)?

Also the plan rows' `group`, which the same pages need to tell roko's demos apart (tools._plan_row).
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

import pytest

from hermes_plugin_roko import install_state, tools
from hermes_plugin_roko.version import __version__

ROOT = Path(__file__).resolve().parents[1]
PAGE = "/**\n * roko for Hermes Desktop: the desktop half of hermes-plugin-roko ({v}).\n */\nconst VERSION = '{v}'\n"


def _plugin(base: Path, version: str, name: str = "roko") -> Path:
    """A directory install as Hermes lays it out: <base>/<name>/{hermes_plugin_roko,desktop,dashboard}."""
    root = base / name
    (root / "hermes_plugin_roko").mkdir(parents=True)
    (root / "hermes_plugin_roko" / "version.py").write_text(f'__version__ = "{version}"\n')
    (root / "hermes_plugin_roko" / "views.py").write_text("X = 1\n")
    (root / "desktop").mkdir()
    (root / "desktop" / "plugin.js").write_text(PAGE.format(v=version))
    (root / "dashboard").mkdir()
    (root / "dashboard" / "plugin_api.py").write_text("router = None\n")
    (root / "plugin.yaml").write_text(f"name: roko\nversion: {version}\n")
    return root


def _copy(
    home: Path, version: str, *, source: Path | None, mtime_ms: float | None = None, linked: bool = False
) -> Path:
    """The desktop app's copy of the page, with Hermes' marker when `source` is given."""
    folder = home / "desktop-plugins" / "roko"
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "plugin.js").write_text(PAGE.format(v=version))
    if source is not None:
        marker: dict[str, Any] = {
            "package": "roko",
            "source": str(source),
            "sourceMtimeMs": mtime_ms
            if mtime_ms is not None
            else (source / "plugin.js").stat().st_mtime_ns / 1e6,
        }
        if linked:
            marker["linked"] = True
        (folder / ".hermes-package.json").write_text(json.dumps(marker))
    return folder


@pytest.fixture()
def installed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[Path, Path]:
    """A Hermes home with roko 1.0.0 installed in plugins/roko, loaded by this process."""
    home = tmp_path / "hermes"
    root = _plugin(home / "plugins", "1.0.0")
    _point_at(monkeypatch, root, loaded="1.0.0")
    return home, root


def _point_at(monkeypatch: pytest.MonkeyPatch, root: Path, *, loaded: str) -> None:
    """Make install_state look at `root` as the package this process imported at version `loaded`."""
    monkeypatch.setattr(install_state, "PACKAGE_DIR", root / "hermes_plugin_roko")
    monkeypatch.setattr(install_state, "PLUGIN_ROOT", root)
    monkeypatch.setattr(install_state, "LOADED_VERSION", loaded)
    monkeypatch.setattr(install_state, "_LOADED_FINGERPRINT", install_state._fingerprint())


def _bump(path: Path, text: str) -> None:
    """Rewrite a file the way `git pull` does: new bytes, a later mtime."""
    path.write_text(text)
    later = time.time() + 5
    os.utime(path, (later, later))


# -- the backend ------------------------------------------------------------------


def test_fresh_install_has_no_problems(installed: tuple[Path, Path]) -> None:
    home, root = installed
    _copy(home, "1.0.0", source=root / "desktop")
    state = install_state.status(home)
    assert state["loaded_version"] == state["disk_version"] == state["desktop_copy_version"] == "1.0.0"
    assert state["backend_stale"] is False and state["desktop_copy_stale"] is False
    assert state["desktop_copy"] == str(home / "desktop-plugins" / "roko")
    assert state["desktop_copy_marker"] is True
    assert install_state.problems(home) == []


def test_a_newer_version_on_disk_means_the_backend_is_stale(installed: tuple[Path, Path]) -> None:
    home, root = installed
    _copy(home, "1.0.0", source=root / "desktop")
    _bump(root / "hermes_plugin_roko" / "version.py", '__version__ = "1.1.0"\n')
    state = install_state.status(home)
    assert state["disk_version"] == "1.1.0" and state["loaded_version"] == "1.0.0"
    assert state["backend_stale"] is True
    [problem] = install_state.problems(home)
    assert problem["id"] == "restart-hermes" and problem["severity"] == "warn"
    assert problem["title"] == "roko 1.1.0 is installed, but Hermes is still running 1.0.0."
    assert problem["fix"] == {
        "kind": "restart-hermes",
        "label": "restart hermes",
        "action": None,
        "command": None,
        "docs": install_state.DOCS,
    }
    assert problem["parts"] == {"backend": True, "desktop_copy": False}
    assert any("⌘Q" in step for step in problem["steps"]["desktop"])
    assert any("hermes dashboard" in step for step in problem["steps"]["dashboard"])
    assert any("hermes gateway restart" in step for step in problem["steps"]["terminal"])


def test_same_version_with_other_code_is_still_stale(installed: tuple[Path, Path]) -> None:
    """The version stays put between releases (0.4.0 working trees); the code fingerprint catches that."""
    home, root = installed
    _bump(root / "hermes_plugin_roko" / "views.py", "X = 2  # changed\n")
    state = install_state.status(home)
    assert state["disk_version"] == state["loaded_version"] == "1.0.0"
    assert state["backend_stale"] is True
    [problem] = install_state.problems(home)
    assert (
        problem["title"] == "roko was updated on disk, but Hermes is still running the code it started with."
    )


def test_a_new_module_file_is_new_code(installed: tuple[Path, Path]) -> None:
    home, root = installed
    (root / "hermes_plugin_roko" / "readiness.py").write_text("Y = 1\n")
    assert install_state.status(home)["backend_stale"] is True


def test_the_route_loader_counts_as_code(installed: tuple[Path, Path]) -> None:
    home, root = installed
    _bump(root / "dashboard" / "plugin_api.py", "router = 1\n")
    assert install_state.status(home)["backend_stale"] is True


def test_version_from_plugin_yaml_when_version_py_is_missing(installed: tuple[Path, Path]) -> None:
    home, root = installed
    (root / "hermes_plugin_roko" / "version.py").unlink()
    _bump(root / "plugin.yaml", "name: roko\nversion: '2.0.0'  # bumped\n")
    assert install_state.disk_version() == "2.0.0"
    assert install_state.status(home)["backend_stale"] is True


# -- the desktop copy -------------------------------------------------------------


def test_a_copy_older_than_its_source_is_stale(installed: tuple[Path, Path]) -> None:
    """Will's case: the marker remembers an older source mtime than the plugin's page now has."""
    home, root = installed
    source = root / "desktop"
    _copy(home, "0.2.0", source=source, mtime_ms=(source / "plugin.js").stat().st_mtime_ns / 1e6 - 60_000)
    state = install_state.status(home)
    assert state["desktop_copy_version"] == "0.2.0"
    assert state["desktop_copy_stale"] is True and state["backend_stale"] is False
    [problem] = install_state.problems(home)
    assert problem["title"] == "The desktop app still shows roko 0.2.0; 1.0.0 is installed."
    assert problem["parts"] == {"backend": False, "desktop_copy": True}


def test_mtime_rounding_is_not_staleness(installed: tuple[Path, Path]) -> None:
    home, root = installed
    source = root / "desktop"
    _copy(home, "1.0.0", source=source, mtime_ms=(source / "plugin.js").stat().st_mtime_ns / 1e6 - 0.4)
    assert install_state.status(home)["desktop_copy_stale"] is False


def test_a_copy_from_another_source_is_stale(installed: tuple[Path, Path], tmp_path: Path) -> None:
    home, _ = installed
    elsewhere = _plugin(tmp_path / "elsewhere", "1.0.0")
    _copy(home, "1.0.0", source=elsewhere / "desktop")
    assert install_state.status(home)["desktop_copy_stale"] is True


def test_a_linked_checkout_compares_bytes(installed: tuple[Path, Path]) -> None:
    home, root = installed
    source = root / "desktop"
    folder = _copy(home, "1.0.0", source=source, mtime_ms=0, linked=True)
    assert install_state.status(home)["desktop_copy_stale"] is False  # same bytes: mtime does not matter
    (folder / "plugin.js").write_text(PAGE.format(v="0.9.0"))
    assert install_state.status(home)["desktop_copy_stale"] is True


def test_a_copy_without_a_marker(installed: tuple[Path, Path]) -> None:
    """Hermes adopts a marker-less copy that matches its source, and never replaces one that doesn't."""
    home, _ = installed
    folder = _copy(home, "1.0.0", source=None)
    state = install_state.status(home)
    assert state["desktop_copy_marker"] is False and state["desktop_copy_stale"] is False
    assert install_state.problems(home) == []

    (folder / "plugin.js").write_text(PAGE.format(v="0.3.0"))
    state = install_state.status(home)
    assert state["desktop_copy_stale"] is True and state["desktop_copy_version"] == "0.3.0"
    [problem] = install_state.problems(home)
    assert problem["steps"]["desktop"][0].startswith(f"Delete the folder {folder}.")
    assert problem["steps"]["terminal"][0] == f"rm -r {folder}"


def test_a_marker_hermes_would_reject_counts_as_none(installed: tuple[Path, Path]) -> None:
    home, _ = installed
    folder = _copy(home, "0.3.0", source=None)
    (folder / ".hermes-package.json").write_text(json.dumps({"package": "roko"}))  # no source
    state = install_state.status(home)
    assert state["desktop_copy_marker"] is False and state["desktop_copy_stale"] is True


def test_no_desktop_folder(installed: tuple[Path, Path]) -> None:
    home, _ = installed
    state = install_state.status(home)
    assert state["desktop_copy"] is None and state["desktop_copy_version"] is None
    assert state["desktop_copy_stale"] is False and state["desktop_copy_marker"] is None
    assert install_state.problems(home) == []


def test_a_profile_shares_the_apps_desktop_folder(installed: tuple[Path, Path]) -> None:
    home, root = installed
    source = root / "desktop"
    _copy(home, "0.2.0", source=source, mtime_ms=0)
    profile = home / "profiles" / "work"
    profile.mkdir(parents=True)
    assert install_state.desktop_root(profile) == home / "desktop-plugins"
    assert install_state.status(profile)["desktop_copy_stale"] is True


def test_both_stale(installed: tuple[Path, Path]) -> None:
    home, root = installed
    _copy(home, "1.0.0", source=root / "desktop", mtime_ms=0)
    _bump(root / "hermes_plugin_roko" / "version.py", '__version__ = "1.2.0"\n')
    [problem] = install_state.problems(home)
    assert problem["parts"] == {"backend": True, "desktop_copy": True}
    assert problem["title"] == "roko 1.2.0 is installed, but Hermes is still running 1.0.0."


# -- where it runs ----------------------------------------------------------------


def test_dev_checkout(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """From this repository (tests, a pip -e install): nothing is stale, and there is no desktop copy."""
    assert install_state.PLUGIN_ROOT == ROOT
    # Someone editing the checkout while the suite runs is a real code change; start from what is there now.
    monkeypatch.setattr(install_state, "_LOADED_FINGERPRINT", install_state._fingerprint())
    state = install_state.status(tmp_path / "empty-home")
    assert state["loaded_version"] == state["disk_version"] == __version__
    assert state["backend_stale"] is False
    assert state["desktop_copy"] is None and state["desktop_copy_stale"] is False


def test_dev_checkout_reports_the_installed_copy(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Running from a checkout while Hermes has its own install: the copy is judged against that install."""
    monkeypatch.setattr(install_state, "_LOADED_FINGERPRINT", install_state._fingerprint())
    home = tmp_path / "hermes"
    installed_root = _plugin(home / "plugins", "1.0.0")
    _copy(home, "0.2.0", source=installed_root / "desktop", mtime_ms=0)
    state = install_state.status(home)
    assert state["backend_stale"] is False
    assert state["desktop_copy_version"] == "0.2.0" and state["desktop_copy_stale"] is True


def test_hermes_home_unset_means_dot_hermes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("HERMES_HOME", raising=False)
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setitem(sys.modules, "hermes_constants", None)  # no Hermes: the plugin's own fallback
    installed_root = _plugin(tmp_path / ".hermes" / "plugins", "1.0.0")
    _copy(tmp_path / ".hermes", "0.2.0", source=installed_root / "desktop", mtime_ms=0)
    state = install_state.status()
    assert state["desktop_copy"] == str(tmp_path / ".hermes" / "desktop-plugins" / "roko")
    assert state["desktop_copy_stale"] is True


def test_never_raises(installed: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch) -> None:
    home, _ = installed

    def boom(*args: Any) -> Any:
        raise RuntimeError("disk on fire")

    monkeypatch.setattr(install_state, "_desktop_copy", boom)
    state = install_state.status(home)
    assert state["loaded_version"] == "1.0.0" and state["backend_stale"] is False
    monkeypatch.setattr(install_state, "_problems", boom)
    assert install_state.problems(home) == []
    monkeypatch.setattr(install_state, "_code_files", boom)
    assert install_state._fingerprint() is None


def test_unreadable_files_are_unknown_not_stale(installed: tuple[Path, Path]) -> None:
    home, root = installed
    folder = _copy(home, "1.0.0", source=root / "desktop")
    (folder / "plugin.js").unlink()
    (folder / "plugin.js").mkdir()  # a folder where the page should be
    state = install_state.status(home)
    assert state["desktop_copy"] is None and state["desktop_copy_stale"] is False


def test_status_is_cheap(installed: tuple[Path, Path]) -> None:
    home, root = installed
    _copy(home, "1.0.0", source=root / "desktop")
    started = time.monotonic()
    for _ in range(50):
        install_state.status(home)
    assert time.monotonic() - started < 1.0


# -- the shipped files agree on the version ---------------------------------------


def test_every_shipped_part_names_the_same_version() -> None:
    """The pages compare their own VERSION with the backend's: a release must bump all of them."""
    assert install_state.js_version(ROOT / "desktop" / "plugin.js") == __version__
    assert install_state.js_version(ROOT / "dashboard" / "dist" / "index.js") == __version__
    assert install_state.disk_version() == __version__
    yaml_version = re.search(r"^version:\s*(\S+)", (ROOT / "plugin.yaml").read_text(), re.MULTILINE)
    assert yaml_version and yaml_version.group(1) == __version__
    assert json.loads((ROOT / "dashboard" / "manifest.json").read_text())["version"] == __version__


def test_js_version_reads_old_pages(tmp_path: Path) -> None:
    page = tmp_path / "plugin.js"
    page.write_text("/**\n * roko for Hermes Desktop: the desktop half of hermes-plugin-roko (0.4.0).\n */\n")
    assert install_state.js_version(page) == "0.4.0"
    page.write_text("/**\n * roko for Hermes Desktop: the desktop half of hermes-plugin-roko.\n */\n")
    assert install_state.js_version(page) is None
    assert install_state.js_version(tmp_path / "missing.js") is None


# -- register() loads every module ------------------------------------------------


def test_register_imports_every_module_of_the_package() -> None:
    """An update rewrites the files under a running Hermes; a module it imported later would be the new
    version in an old process. register() imports them all up front (in a fresh interpreter, so nothing
    another test imported counts)."""
    script = """
import json, pkgutil, sys
sys.path.insert(0, sys.argv[1])
from conftest import FakeContext
import hermes_plugin_roko as package
before = sorted(name for name in sys.modules if name.startswith("hermes_plugin_roko."))
package.register(FakeContext({}))
names = [m.name for m in pkgutil.iter_modules(package.__path__)]
print(json.dumps({"before": before, "names": names,
                  "missing": [n for n in names if f"hermes_plugin_roko.{n}" not in sys.modules]}))
"""
    proc = subprocess.run(
        [sys.executable, "-c", script, str(ROOT / "tests")],
        capture_output=True,
        text=True,
        timeout=60,
        cwd=ROOT,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert proc.returncode == 0, proc.stderr[-2000:]
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    assert "install_state" in result["names"] and "ui_api" in result["names"] and "live" in result["names"]
    assert result["missing"] == []
    imported = {name.rsplit(".", 1)[1] for name in result["before"]}
    # install_state comes with the package itself: the UI routes import the package without register(), and
    # what it notes as loaded must be what the process imported first.
    assert "install_state" in imported
    # Some modules are only reached lazily from the package's own imports: register() is what loads them.
    assert {"live", "live_relay", "ui_api"} - imported, "nothing was left for register()"


# -- plan rows keep roko's plan set ------------------------------------------------


def test_a_plan_row_keeps_rokos_group() -> None:
    """The pages list roko's demos apart, and keep a demo run's output off the person's branch, by `group`: roko
    says `fixture` only until a demo's first run (gap-8f84d1)."""
    after_a_run = {
        "id": "demo-hello-world",
        "title": "Start here: hello world demo",
        "status": "done",
        "group": "demos/parallel-plans",
        "task_count": 1,
    }
    assert tools._plan_row(after_a_run)["group"] == "demos/parallel-plans"
    # Cleaned like the other text fields: one line, no control or bidi characters.
    assert tools._plan_row({"id": "p", "title": "P", "group": "a\nb\u202ec"})["group"] == "a bc"
    # roko leaves it out for a plan at the top of plans/.
    assert "group" not in tools._plan_row({"id": "top", "title": "Top level"})
    assert "group" not in tools._plan_row({"id": "top", "title": "Top level", "group": ""})

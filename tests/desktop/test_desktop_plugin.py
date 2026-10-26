"""Run the desktop half's vitest suite (tests/desktop) with Hermes' own node and node_modules.

The suite loads desktop/plugin.js through the real Hermes desktop runtime loader, SDK and
React from a Hermes checkout (only the Electron bridge and the gateway socket are faked).
It skips when there is no checkout with node_modules, or no node to run it with.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.compat

HERE = Path(__file__).resolve().parent
HERMES_SRC = Path(os.environ.get("HERMES_AGENT_SRC", Path.home() / ".hermes" / "hermes-agent")).expanduser()
DESKTOP_SRC = HERMES_SRC / "apps" / "desktop" / "src" / "contrib" / "runtime-loader.ts"
VITEST = HERMES_SRC / "node_modules" / "vitest" / "vitest.mjs"
REPORT = HERE / ".harness" / "vitest-report.json"
MIN_TESTS = 292
PLUGIN_JS = HERE.parent.parent / "desktop" / "plugin.js"
HERMES_PY = Path(os.environ.get("HERMES_PYTHON", HERMES_SRC / "venv" / "bin" / "python"))
# Hermes' install scanner flags any file over 1 MB (plugin_guard.MAX_PLUGIN_SINGLE_FILE_KB); the desktop half must
# stay one file, so this guard fails well before that (spec v3 §9).
MAX_PLUGIN_JS_BYTES = 900 * 1024


def test_the_desktop_half_is_one_file_under_900_kb() -> None:
    files = sorted(p.name for p in PLUGIN_JS.parent.iterdir() if not p.name.startswith("."))
    assert files == ["plugin.js"], files
    size = PLUGIN_JS.stat().st_size
    assert size < MAX_PLUGIN_JS_BYTES, (
        f"desktop/plugin.js is {size // 1024} KB (the guard is 900 KB; Hermes flags 1 MB)"
    )


@pytest.mark.timeout(120)
def test_hermes_install_scanner_finds_nothing_in_the_desktop_half(tmp_path: Path) -> None:
    """The scanner's line rules (a line with "host" and a later `$`, `env` and a later `|`, hostile strings,
    bidirectional controls) and its size limit, on desktop/plugin.js alone: any finding at all fails here, not only a
    blocking one, so the redesign never drifts towards one."""
    if not HERMES_PY.is_file() or not (HERMES_SRC / "tools" / "plugin_guard.py").is_file():
        pytest.skip(f"no Hermes checkout with a venv at {HERMES_SRC} (set HERMES_AGENT_SRC / HERMES_PYTHON)")
    export = tmp_path / "roko" / "desktop"
    export.mkdir(parents=True)
    shutil.copy2(PLUGIN_JS, export / "plugin.js")
    script = (
        "import json, sys\n"
        "from pathlib import Path\n"
        "sys.path.insert(0, sys.argv[2])\n"
        "from tools.plugin_guard import scan_plugin\n"
        "r = scan_plugin(Path(sys.argv[1]), source='roko')\n"
        "print(json.dumps({'verdict': r.verdict, 'findings': [[f.severity, f.file, f.pattern_id] for f in r.findings]}))\n"
    )
    proc = subprocess.run(
        [str(HERMES_PY), "-c", script, str(tmp_path / "roko"), str(HERMES_SRC)],
        capture_output=True,
        text=True,
        timeout=110,
        env={**os.environ, "HOME": str(tmp_path / "home"), "PYTHONDONTWRITEBYTECODE": "1"},
    )
    assert proc.returncode == 0, proc.stderr[-3000:]
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    assert result == {"verdict": "safe", "findings": []}, result


def _node() -> tuple[str, int] | None:
    """Hermes' bundled node first, then HERMES_NODE, then PATH; with its major version."""
    candidates = [
        os.environ.get("HERMES_NODE"),
        str(Path.home() / ".hermes" / "node" / "bin" / "node"),
        shutil.which("node"),
    ]
    for candidate in candidates:
        if not candidate or not os.access(candidate, os.X_OK):
            continue
        try:
            version = subprocess.run(
                [candidate, "--version"], capture_output=True, text=True, timeout=20
            ).stdout
        except (OSError, subprocess.SubprocessError):
            continue
        match = re.match(r"v(\d+)\.", version.strip())
        if match:
            return candidate, int(match.group(1))
    return None


@pytest.mark.timeout(600)
def test_desktop_plugin_vitest_suite() -> None:
    if not DESKTOP_SRC.is_file():
        pytest.skip(f"no Hermes desktop sources at {HERMES_SRC} (set HERMES_AGENT_SRC)")
    if not VITEST.is_file():
        pytest.skip(
            f"{HERMES_SRC} has no node_modules with vitest (run `npm install` in the Hermes checkout)"
        )
    found = _node()
    if found is None:
        pytest.skip(
            "no node to run vitest with (Hermes installs one at ~/.hermes/node/bin/node; or set HERMES_NODE)"
        )
    node, major = found
    if major < 20:
        pytest.skip(f"{node} is node {major}; vitest needs node 20 or newer")

    env = {**os.environ, "HERMES_AGENT_SRC": str(HERMES_SRC)}
    setup = subprocess.run(
        ["bash", str(HERE / "setup.sh")], cwd=HERE, env=env, capture_output=True, text=True, timeout=120
    )
    assert setup.returncode == 0, f"setup.sh failed:\n{setup.stdout}{setup.stderr}"

    REPORT.unlink(missing_ok=True)
    proc = subprocess.run(
        [
            node,
            str(HERE / "node_modules" / "vitest" / "vitest.mjs"),
            "run",
            "--config",
            str(HERE / "vitest.config.mts"),
            "--reporter=default",
            "--reporter=json",
            f"--outputFile.json={REPORT}",
        ],
        cwd=HERE,
        env=env,
        capture_output=True,
        text=True,
        timeout=540,
    )
    output = f"{proc.stdout}\n{proc.stderr}"[-8000:]
    assert proc.returncode == 0, f"vitest failed (exit {proc.returncode}):\n{output}"

    report = json.loads(REPORT.read_text(encoding="utf-8"))
    assert report["numFailedTests"] == 0, output
    assert report["numPassedTests"] >= MIN_TESTS, f"only {report['numPassedTests']} tests passed:\n{output}"

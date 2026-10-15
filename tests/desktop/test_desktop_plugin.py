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
MIN_TESTS = 64


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

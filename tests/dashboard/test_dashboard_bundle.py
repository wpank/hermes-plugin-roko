"""The web dashboard half: dashboard/manifest.json and dashboard/dist/ (hand-written, no build step).

- The manifest is checked against what Hermes 0.21's dashboard reads
  (hermes_cli/web_server.py `_discover_dashboard_plugins`, web/src/App.tsx, web/src/plugins/slots.ts).
- The bundle must be plain, reviewable JavaScript: Hermes' install scanner reads every file, and
  `node --check` must accept it.
- roko-dashboard.test.mjs loads the bundle into jsdom with a fake plugin SDK on the real React of a
  Hermes checkout, and drives the page and its slots against contract-shaped answers. It skips when
  there is no node, or no checkout with react, react-dom and jsdom in its node_modules.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DASHBOARD = REPO / "dashboard"
MANIFEST = DASHBOARD / "manifest.json"
BUNDLE = DASHBOARD / "dist" / "index.js"
JS_TEST = HERE / "roko-dashboard.test.mjs"
HERMES_SRC = Path(
    os.environ.get("HERMES_AGENT_SRC", str(Path.home() / ".hermes" / "hermes-agent"))
).expanduser()
MIN_JS_TESTS = 20

# The Lucide icons Hermes 0.21's sidebar maps by name (web/src/App.tsx ICON_MAP); others become Puzzle.
DASHBOARD_ICONS = {
    "Activity",
    "BarChart3",
    "Clock",
    "Cpu",
    "FileText",
    "FolderOpen",
    "KeyRound",
    "MessageSquare",
    "Package",
    "Settings",
    "Puzzle",
    "Sparkles",
    "Terminal",
    "Globe",
    "Database",
    "Shield",
    "Users",
    "Wrench",
    "Zap",
    "Heart",
    "Star",
    "Code",
    "Eye",
}
# Slot names the 0.21 shell renders (web/src/plugins/slots.ts KNOWN_SLOT_NAMES).
KNOWN_SLOTS = {
    "backdrop",
    "header-left",
    "header-right",
    "header-banner",
    "sidebar",
    "pre-main",
    "post-main",
    "footer-left",
    "footer-right",
    "overlay",
    "sessions:top",
    "sessions:bottom",
    "analytics:top",
    "analytics:bottom",
    "logs:top",
    "logs:bottom",
    "cron:top",
    "cron:bottom",
    "skills:top",
    "skills:bottom",
    "plugins:top",
    "plugins:bottom",
    "config:top",
    "config:bottom",
    "env:top",
    "env:bottom",
    "docs:top",
    "docs:bottom",
    "chat:top",
    "chat:bottom",
    # ModelsPage renders these although KNOWN_SLOT_NAMES leaves them out.
    "models:top",
    "models:bottom",
}
# The fields discovery reads; anything else is ignored by 0.21 and probably a typo.
MANIFEST_FIELDS = {"name", "label", "description", "icon", "version", "tab", "slots", "entry", "css", "api"}


def _node() -> str | None:
    """Hermes' bundled node first, then HERMES_NODE, then PATH."""
    for candidate in (
        os.environ.get("HERMES_NODE"),
        str(Path.home() / ".hermes" / "node" / "bin" / "node"),
        shutil.which("node"),
    ):
        if candidate and os.access(candidate, os.X_OK):
            return candidate
    return None


def _plugin_name() -> str:
    match = re.search(r"^name:\s*([\w.-]+)\s*$", (REPO / "plugin.yaml").read_text(encoding="utf-8"), re.M)
    assert match, "plugin.yaml has no name"
    return match.group(1)


def test_manifest_matches_dashboard_discovery() -> None:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    assert set(manifest) <= MANIFEST_FIELDS, f"unknown manifest fields: {set(manifest) - MANIFEST_FIELDS}"
    # The dashboard serves a user plugin's assets and routes only when this name is in plugins.enabled.
    assert manifest["name"] == _plugin_name() == "roko"
    assert isinstance(manifest["label"], str) and manifest["label"]
    assert isinstance(manifest["description"], str) and manifest["description"]
    assert manifest["icon"] in DASHBOARD_ICONS
    assert re.fullmatch(r"\d+\.\d+\.\d+", manifest["version"])
    tab = manifest["tab"]
    assert tab == {"path": "/roko", "position": "after:sessions"}, "a plain tab after Sessions, no override"
    assert set(manifest["slots"]) == {
        "header-right",
        "sessions:top",
        "chat:top",
        "analytics:top",
        "models:top",
    }
    assert set(manifest["slots"]) <= KNOWN_SLOTS
    for key in ("entry", "css"):
        target = (DASHBOARD / manifest[key]).resolve()
        assert target.is_file(), f"{key} {manifest[key]} does not exist"
        assert target.is_relative_to(DASHBOARD.resolve())
    # The api file is imported by the dashboard process: a relative .py inside dashboard/.
    api = manifest["api"]
    assert api == "plugin_api.py"
    assert not Path(api).is_absolute() and "/" not in api and "\\" not in api


def test_bundle_is_plain_reviewable_javascript() -> None:
    source = BUNDLE.read_text(encoding="utf-8")
    assert "\n" in source and len(source.splitlines()) > 200, "the bundle stays unminified"
    # Built from fragments so this file does not trip the same scanner rules it checks for.
    forbidden = [
        "ev" + "al(",
        "new " + "Function",
        "at" + "ob(",
        "bt" + "oa(",
        "String.from" + "CharCode",
        "inner" + "HTML",
        "dangerously" + "SetInnerHTML",
        "document." + "write",
    ]
    for needle in forbidden:
        assert needle not in source, f"dist/index.js contains {needle}"
    assert not re.search(r"[A-Za-z0-9+/=]{200,}", source), "no embedded base64 blobs"
    # Only the plugin's own backend is called.
    api_paths = set(re.findall(r'"(/api/[^"]*)"', source))
    assert api_paths == {"/api/plugins/roko"}, api_paths
    # Hermes 0.21's registerSlot takes (plugin, slot, component), whatever sdk.d.ts says.
    assert 'const PLUGIN = "roko";' in source
    assert 'registerSlot(PLUGIN, "header-right", ' in source
    assert 'registerSlot(PLUGIN, "sessions:top", ' in source
    for slot in ("chat:top", "analytics:top", "models:top"):
        assert f'registerSlot(PLUGIN, "{slot}", ' in source
    assert "PLUGINS.register(PLUGIN, " in source


def test_bundle_passes_node_check() -> None:
    node = _node()
    if node is None:
        pytest.skip("no node found (set HERMES_NODE, or install Hermes' bundled node)")
    result = subprocess.run([node, "--check", str(BUNDLE)], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr


@pytest.mark.compat
@pytest.mark.timeout(300)
def test_dashboard_behaviour_in_jsdom() -> None:
    node = _node()
    if node is None:
        pytest.skip("no node found (set HERMES_NODE, or install Hermes' bundled node)")
    missing = [
        pkg for pkg in ("react", "react-dom", "jsdom") if not (HERMES_SRC / "node_modules" / pkg).is_dir()
    ]
    if missing:
        pytest.skip(f"{HERMES_SRC} has no node_modules with {', '.join(missing)} (set HERMES_AGENT_SRC)")
    result = subprocess.run(
        [node, "--test-reporter=tap", str(JS_TEST), str(HERMES_SRC)],
        capture_output=True,
        text=True,
        timeout=240,
        cwd=REPO,
    )
    output = result.stdout + result.stderr
    passed = re.search(r"^# pass (\d+)$", output, re.M)
    failed = re.search(r"^# fail (\d+)$", output, re.M)
    assert passed and failed, output[-4000:]
    assert result.returncode == 0 and int(failed.group(1)) == 0, output[-4000:]
    assert int(passed.group(1)) >= MIN_JS_TESTS, output[-4000:]

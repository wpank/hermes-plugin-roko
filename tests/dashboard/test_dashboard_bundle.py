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
MIN_JS_TESTS = 213

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
    # 0.9 (roko's design system §4.9): the chip, and one line above the sessions and the chat while a run goes.
    assert set(manifest["slots"]) == {
        "header-right",
        "sessions:top",
        "chat:top",
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
    assert 'registerSlot(PLUGIN, "chat:top", ' in source
    for slot in ("analytics:top", "models:top"):
        assert f'registerSlot(PLUGIN, "{slot}", ' not in source
    assert "PLUGINS.register(PLUGIN, " in source


def test_bundle_passes_node_check() -> None:
    node = _node()
    if node is None:
        pytest.skip("no node found (set HERMES_NODE, or install Hermes' bundled node)")
    result = subprocess.run([node, "--check", str(BUNDLE)], capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr


STYLE = DASHBOARD / "dist" / "style.css"


def _luminance(hex_colour: str) -> float:
    channels = [int(hex_colour[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _contrast(a: str, b: str) -> float:
    hi, lo = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def _tokens(css: str, selector: str) -> dict[str, str]:
    """The custom properties set by every rule whose selector list is exactly `selector` (the last one wins)."""
    blocks = re.findall(r"(?:^|\n)" + re.escape(selector) + r"\s*\{([^}]*)\}", css)
    assert blocks, f"style.css has no rule {selector!r}"
    return {name: value for block in blocks for name, value in re.findall(r"(--[\w-]+):\s*([^;]+);", block)}


def test_files_stay_under_the_size_guard() -> None:
    # Hermes' install scanner flags any file over 1 MB; spec v3 §9 guards at 900 KB.
    for path in (BUNDLE, STYLE):
        assert path.stat().st_size < 900_000, f"{path.name} is {path.stat().st_size} bytes"


def test_style_has_the_design_systems_glass_and_four_signals() -> None:
    css = STYLE.read_text(encoding="utf-8")
    tokens = _tokens(css, ".roko,\n.roko-tone-scope")
    # The glass is the same in every theme and byte for byte the desktop's (roko's design system §3.2): black, with
    # the four signals' phosphors. Learning has no colour of its own.
    glass = {
        "--ph-void": "#0b0c0d",
        "--ph-glass": "#0e0f10",
        "--ph-glass-2": "#151618",
        "--ph-rule": "#1f2022",
        "--ph-rule-2": "#2c2d30",
        "--ph-phantom": "#1d1e1f",
        "--ph-ghost": "#3b3c3e",
        "--ph-dim": "#a29f97",
        "--ph-ink": "#cdcac2",
        "--ph-bright": "#f2f0e9",
        "--ph-bone": "#f2f0e9",
        "--ph-live": "#7aa6ff",
        "--ph-pass": "#4be092",
        "--ph-fail": "#ff5c52",
        "--ph-you": "#ff7a3d",
        "--ph-learn": "#cdcac2",
    }
    for name, value in glass.items():
        assert tokens.get(name) == value, (name, tokens.get(name))
    for name in ("--ph-dim", "--ph-ink", "--ph-bright", "--ph-live", "--ph-pass", "--ph-fail", "--ph-you"):
        assert _contrast(glass[name], glass["--ph-void"]) >= 4.5, name
    # One rule per channel; orange as text is --rk-you-text. Blue "agent" stays gone: live is the one word for it.
    for channel in ("live", "pass", "fail", "you", "learn"):
        text = "you-text" if channel == "you" else channel
        assert f'[data-ch="{channel}"] {{ --ch: var(--rk-{text});' in css, channel
    for gone in ("--rk-agent", "--rk-px-agent", '[data-ch="agent"]'):
        assert gone not in css, f"{gone} is left"
    # Dark dashboard themes take the night panel's signals, at least 4.5:1 on the Nous teal; learning is ink.
    for name in ("--rk-live", "--rk-pass", "--rk-fail", "--rk-you-text"):
        assert _contrast(tokens[name], "#041c1c") >= 4.5, (name, tokens[name])
    assert tokens["--rk-learn"] == "var(--rk-ink-2)"
    # Light themes: the aluminium values, at least 4.5:1 for text on the aluminium module (§3.3).
    light = _tokens(css, ".roko.roko--light,\n.roko-tone-scope.roko--light")
    for channel in ("live", "pass", "fail", "you-text"):
        assert _contrast(light[f"--rk-{channel}"], "#f1f1ee") >= 4.5, (channel, light[f"--rk-{channel}"])
    assert light["--rk-you"] == "#ff5f1f", "orange stays the key's fill"
    # Motion off: no scanline and no bloom (spec v3 §8).
    reduced = css[css.index("@media (prefers-reduced-motion: reduce) {\n  /* No scanline") :]
    assert "--rk-glass-scan: linear-gradient(transparent, transparent);" in reduced.split("\n}\n")[0]


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

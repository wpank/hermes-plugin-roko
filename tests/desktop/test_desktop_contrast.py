"""The roko page's text reads at least 4.5:1 (roko's design system §3) on Hermes desktop's themes, light and dark.

The page's inks are Hermes' own text steps, --ui-text-primary, -secondary and -tertiary (94, 74 and 54% of the
theme's ink, --ui-base, over its ground), unless the plugin's `hostTone()` says otherwise: a light ground takes the
design system's day inks for the second and third, and a host whose own ink reads under 4.5:1 (or, on a dark ground,
any of its steps) takes the panel's inks for all three. Here each theme's ink and surfaces, as Hermes paints them,
go through the tone the plugin picks for them, and every ink is checked on the page and on a module.

Round v8 (plugin-dash-v8): on every light theme the dim step read 2.2-3.9:1 (3.5:1 on Nous, Hermes' default), and
on Solarized's dark the body step read 3.6:1 and the dim one 2.5:1.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

PLUGIN_JS = Path(__file__).resolve().parent.parent.parent / "desktop" / "plugin.js"

# Hermes 0.22.2's desktop themes as it paints them: the ink (--ui-base), the page (--ui-surface-background) and a
# module (--ui-widget-surface-background). Read in Chromium from its styles.css, with each theme's tokens set as its
# applyTheme() sets them (themes/context.tsx), in light and in dark; GitHub paints as Nous, and the dark-only skins
# (Midnight, Ember, Mono, Cyberpunk, Slate) all paint one synthesized palette in light. roko's own theme
# (ROKO_THEME) is painted the same way.
HOSTS: dict[str, tuple[str, str, str]] = {
    "Nous light": ("#1f2328", "#fbfbfc", "#fbfbfc"),
    "Nous dark": ("#e6edf3", "#0e0f12", "#0c0d10"),
    "Catppuccin light": ("#4c4f69", "#f7f8f9", "#f7f8f9"),
    "Catppuccin dark": ("#cdd6f4", "#17171d", "#141419"),
    "Everforest light": ("#5c6a72", "#fcfbf7", "#fcfbf7"),
    "Everforest dark": ("#d3c6aa", "#1f2225", "#1b1e21"),
    "Solarized light": ("#1f1f1f", "#f3f1ed", "#f3f1ed"),
    "Solarized dark": ("#839496", "#0e1e23", "#0c1a1f"),
    "Nous Alt light": ("#17171a", "#fdfdfd", "#fdfdfd"),
    "Nous Alt dark": ("#ffe6cb", "#142345", "#121e3d"),
    "Classic Hermes light": ("#2b2109", "#f9f9f9", "#f9f9f9"),
    "Classic Hermes dark": ("#fff8dc", "#1b1b23", "#18181f"),
    "a dark-only skin in light": ("#161616", "#fdfdfd", "#fdfdfd"),
    "Midnight dark": ("#ddd6ff", "#13131e", "#10101a"),
    "Ember dark": ("#ffd8b0", "#191310", "#16110e"),
    "Mono dark": ("#eaeaea", "#151516", "#131314"),
    "Cyberpunk dark": ("#00ff41", "#0e140f", "#0c120d"),
    "Slate dark": ("#c9d1d9", "#16181c", "#131518"),
    "roko light": ("#111213", "#fafaf9", "#fafaf9"),
    "roko dark": ("#ecebe6", "#18191b", "#151617"),
}
# Hermes' text steps (apps/desktop/src/styles.css: --ui-text-primary, -secondary, -tertiary).
HERMES_STEPS = [0.94, 0.74, 0.54]
# The design system's inks (§3.1): day and night.
DAY = ["#111213", "#45484a", "#606366"]
NIGHT = ["#ecebe6", "#a9aba7", "#8a8c8b"]
# The three inks, and the fourth, which paints labels, table heads, chart axes and times: §3 has three inks, so it is
# the third.
INKS = ["--rk-ink", "--rk-ink-2", "--rk-ink-3", "--rk-ink-4"]

Rgb = tuple[float, float, float]


def _hex(value: str) -> Rgb:
    value = value.strip().lstrip("#")
    if len(value) == 3:
        value = "".join(ch * 2 for ch in value)
    return (int(value[0:2], 16), int(value[2:4], 16), int(value[4:6], 16))


def _luminance(rgb: Rgb) -> float:
    def channel(v: float) -> float:
        x = v / 255
        return x / 12.92 if x <= 0.03928 else ((x + 0.055) / 1.055) ** 2.4

    r, g, b = (channel(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def _contrast(a: Rgb, b: Rgb) -> float:
    hi, lo = sorted((_luminance(a), _luminance(b)), reverse=True)
    return (hi + 0.05) / (lo + 0.05)


def _step(ink: Rgb, part: float, ground: Rgb) -> Rgb:
    """One of Hermes' text steps (`part` of its ink over transparent), as it reads on `ground`."""
    return tuple(part * c + (1 - part) * g for c, g in zip(ink, ground, strict=True))  # type: ignore[return-value]


def _plugin() -> tuple[list[float], dict[str, dict[str, str]], dict[str, str]]:
    """hostTone()'s steps, the tone's inks, and the page's ink tokens, as desktop/plugin.js says them."""
    source = PLUGIN_JS.read_text(encoding="utf-8")
    steps = re.search(r"const HOST_STEPS = \[([\d., ]+)\]", source)
    table = re.search(r"const TONE_INKS = \{\n(.*?)\n\}", source, re.S)
    assert steps and table, "desktop/plugin.js names HOST_STEPS and TONE_INKS"
    tones = {
        name.strip("'"): dict(re.findall(r"'(--[\w-]+)': '(#[0-9a-f]{6})'", body))
        for name, body in re.findall(r"^\s*('[\w ]+'|\w+): \{([^}]*)\}", table[1], re.M)
    }
    sheet = re.search(r"const CSS = `\n\.roko\{([^}]*)\}", source)
    assert sheet, "the style sheet starts with the .roko rule"
    tokens = dict(re.findall(r"(--rk-ink(?:-\d)?):([^;]+);", sheet[1]))
    return [float(v) for v in steps[1].split(",")], tones, tokens


def _tone(ink: str, page: str, module: str) -> str:
    """hostTone()'s reading of a host, as the plugin computes it: 'light', 'ink', 'light ink' or ''."""
    steps, _, _ = _plugin()
    fg, grounds = _hex(ink), [_hex(page), _hex(module)]
    bg = grounds[0]
    light = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 > 0.6
    weak = any(
        _contrast(_step(fg, part, ground), ground) < 4.5
        for part in (steps[:1] if light else steps)
        for ground in grounds
    )
    return " ".join(word for word, on in (("light", light), ("ink", weak)) if on)


def _inks(ink: str, tone: str, ground: Rgb) -> list[Rgb]:
    """--rk-ink to -4 as they read on `ground`: the tone's ink where it sets one, else Hermes' step; an ink that names
    another (the fourth) reads as that one."""
    steps, tones, tokens = _plugin()
    out: dict[str, Rgb] = {}
    for name, part in zip(INKS, [*steps, None], strict=True):
        alias = re.fullmatch(r"var\((--rk-ink(?:-\d)?)\)", tokens[name])
        if alias:
            out[name] = out[alias[1]]
            continue
        found = re.fullmatch(r"var\((--roko-ink(?:-\d)?),var\(--ui-text-\w+\)\)", tokens[name])
        assert found and part is not None, (name, tokens[name])
        given = tones.get(tone, {}).get(found[1])
        out[name] = _hex(given) if given else _step(_hex(ink), part, ground)
    return [out[name] for name in INKS]


def test_the_page_reads_hermes_text_steps_unless_the_tone_gives_an_ink() -> None:
    steps, _, tokens = _plugin()
    assert steps == HERMES_STEPS
    assert {name: tokens[name] for name in INKS} == {
        "--rk-ink": "var(--roko-ink,var(--ui-text-primary))",
        "--rk-ink-2": "var(--roko-ink-2,var(--ui-text-secondary))",
        "--rk-ink-3": "var(--roko-ink-3,var(--ui-text-tertiary))",
        "--rk-ink-4": "var(--rk-ink-3)",
    }


def test_no_rule_paints_with_hermes_faintest_step() -> None:
    # --ui-text-quaternary is 36% of the ink: 2.2:1 on Nous by day. Nothing on the page reads in it, and what the fourth
    # ink painted (16 rules: labels, table heads, chart axes, times, line numbers) reads in ink-3.
    source = PLUGIN_JS.read_text(encoding="utf-8")
    sheet = source[source.index("const CSS = `") : source.index("`", source.index("const CSS = `") + 13)]
    assert "--ui-text-quaternary" not in sheet
    assert sheet.count("color:var(--rk-ink-4)") >= 12


def test_the_tones_inks_are_the_design_systems() -> None:
    _, tones, _ = _plugin()
    names = ["--roko-ink", "--roko-ink-2", "--roko-ink-3"]
    assert tones == {
        "ink": dict(zip(names, NIGHT, strict=True)),
        "light": dict(zip(names[1:], DAY[1:], strict=True)),
        "light ink": dict(zip(names, DAY, strict=True)),
    }


@pytest.mark.parametrize("host", list(HOSTS))
def test_body_and_dim_text_read_at_least_4_5_to_1_on_every_theme(host: str) -> None:
    ink, page, module = HOSTS[host]
    tone = _tone(ink, page, module)
    assert tone.startswith("light") == host.endswith("light"), f"{host} read as {tone or 'dark'}"
    for surface, ground in (("the page", _hex(page)), ("a module", _hex(module))):
        for name, rgb in zip(INKS, _inks(ink, tone, ground), strict=True):
            ratio = _contrast(rgb, ground)
            assert ratio >= 4.5, f"{host} ({tone or 'its own inks'}): {name} on {surface} reads {ratio:.2f}:1"


def test_a_host_ink_that_fails_gives_way_to_the_panels_inks() -> None:
    # A dark ground with a dim ink of its own (2.6:1), and a light one with a pale ink (1.6:1): the panel's night and
    # day inks stand in, and every one reads.
    for ink, page, tone in (("#4a5560", "#101418", "ink"), ("#b8bcc0", "#f4f4f2", "light ink")):
        assert _tone(ink, page, page) == tone, (ink, page)
        ground = _hex(page)
        for name, rgb in zip(INKS, _inks(ink, tone, ground), strict=True):
            assert _contrast(rgb, ground) >= 4.5, (ink, page, name)

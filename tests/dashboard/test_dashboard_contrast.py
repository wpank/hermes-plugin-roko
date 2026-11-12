"""The roko tab's text reads at least 4.5:1 (roko's design system §3) on Hermes' dashboard themes, light and dark.

The tab takes its panel from the host theme's own tokens (`--background-base`, `--midground-base`), and its inks are
steps of the host's ink unless the bundle's `hostTone()` says otherwise: a light ground (`.roko--light`) takes the
design system's day inks for the second and third, and a host ink that reads under 4.5:1 (`.roko--ink`) gives way to
the panel's own. Here style.css's tokens are resolved as a browser would, for each theme's ground and ink, with the
classes the bundle picks for it, and every ink is checked on the page's ground, on a module and on a module's sunk
area.

Round v8 (plugin-dash-v8): on Nous Blue, body text read 2.9:1 and dim text 1.9:1; on Hermes Teal dim text read 3.5:1.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

STYLE = Path(__file__).resolve().parent.parent.parent / "dashboard" / "dist" / "style.css"
BUNDLE = STYLE.parent / "index.js"

# Hermes 0.22.2's dashboard themes: their own ground and ink, read in the dashboard (computed `--background-base` and
# `--midground-base` on the document, theme by theme through its menu; Hermes Teal (Large) reads as Hermes Teal).
HOSTS: dict[str, tuple[str, str]] = {
    "Hermes Teal": ("#041c1c", "#ffe6cb"),
    "Nous Blue": ("#e8f2fd", "#0053fd"),
    "Midnight": ("#08081c", "#ddd6ff"),
    "Ember": ("#160800", "#ffd8b0"),
    "Rosé": ("#1a0f15", "#ffd4e1"),
}
# The tone hostTone() picks for each, which the dashboard's jsdom suite checks against the bundle.
LIGHT = {"Nous Blue"}

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


def _over(ink: tuple[Rgb, float], ground: Rgb) -> Rgb:
    """A colour with alpha, as it reads on `ground`."""
    rgb, alpha = ink
    return tuple(alpha * c + (1 - alpha) * g for c, g in zip(rgb, ground, strict=True))  # type: ignore[return-value]


def _blocks(css: str, selector: str) -> dict[str, str]:
    """The custom properties every rule whose selector list is exactly `selector` sets (the last one wins)."""
    found = re.findall(r"(?:^|\n)" + re.escape(selector) + r"\s*\{([^}]*)\}", css)
    assert found, f"style.css has no rule {selector!r}"
    bare = [re.sub(r"/\*.*?\*/", "", block, flags=re.S) for block in found]
    return {
        name: value.strip() for block in bare for name, value in re.findall(r"(--[\w-]+):\s*([^;]+);", block)
    }


class Panel:
    """style.css's tokens for one host and tone, resolved as a browser resolves custom properties."""

    def __init__(self, css: str, ground: str, ink: str, *, light: bool, weak: bool) -> None:
        tokens = dict(_blocks(css, ".roko,\n.roko-tone-scope"))
        if light:
            tokens.update(_blocks(css, ".roko.roko--light,\n.roko-tone-scope.roko--light"))
        if weak:
            tokens.update(_blocks(css, ".roko.roko--ink,\n.roko-tone-scope.roko--ink"))
        if light and weak:
            tokens.update(
                _blocks(css, ".roko.roko--light.roko--ink,\n.roko-tone-scope.roko--light.roko--ink")
            )
        self.tokens = tokens
        self.host = {"--background-base": ground, "--midground-base": ink}

    def value(self, expr: str) -> tuple[Rgb, float]:
        expr = expr.strip()
        if expr.startswith("#"):
            return _hex(expr), 1.0
        found = re.fullmatch(r"var\((--[\w-]+)(?:,\s*(.+))?\)", expr)
        if found:
            name, fallback = found[1], found[2]
            if name in self.tokens:
                return self.value(self.tokens[name])
            if name in self.host:
                return self.value(self.host[name])
            assert fallback, f"{name} has no value and no fallback"
            return self.value(fallback)
        found = re.fullmatch(r"color-mix\(in srgb,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)", expr)
        if found:
            first, part, second = self.value(found[1]), float(found[2]) / 100, found[3].strip()
            if second == "transparent":
                return first[0], first[1] * part
            other = self.value(second)
            mixed = tuple(part * a + (1 - part) * b for a, b in zip(first[0], other[0], strict=True))
            return mixed, 1.0  # type: ignore[return-value]
        raise AssertionError(f"an expression this test does not read: {expr!r}")

    def solid(self, name: str) -> Rgb:
        rgb, alpha = self.value(f"var({name})")
        assert alpha == 1.0, f"{name} is not opaque"
        return rgb

    def ink(self, name: str, ground: Rgb) -> Rgb:
        return _over(self.value(f"var({name})"), ground)


def _bundle_steps() -> tuple[list[float], float]:
    """hostTone()'s ink steps and a module's tint, as the bundle says them."""
    source = BUNDLE.read_text(encoding="utf-8")
    steps = re.search(r"const INK_STEPS = \[([\d., ]+)\];", source)
    tint = re.search(r"const MODULE_TINT = ([\d.]+);", source)
    assert steps and tint, "the bundle names INK_STEPS and MODULE_TINT"
    return [float(v) for v in steps[1].split(",")], float(tint[1])


def _tone(ground: str, ink: str) -> tuple[bool, bool]:
    """hostTone()'s reading of a host: (light ground, weak ink), as the bundle computes it."""
    steps, tint = _bundle_steps()
    bg, fg = _hex(ground), _hex(ink)
    light = (0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2]) / 255 > 0.6
    module = _over((fg, tint), bg)
    inks = [fg] + ([] if light else [_over((fg, part), bg) for part in steps])
    weak = any(_contrast(x, bg) < 4.5 or _contrast(x, module) < 4.5 for x in inks)
    return light, weak


def test_the_bundle_and_the_style_sheet_agree_on_the_inks_steps() -> None:
    css = STYLE.read_text(encoding="utf-8")
    base = _blocks(css, ".roko,\n.roko-tone-scope")
    steps, tint = _bundle_steps()
    step = re.compile(r"color-mix\(in srgb, var\(--roko-fg\) ([\d.]+)%, transparent\)")
    said = []
    for name in ("--roko-dim", "--roko-faint"):
        found = step.fullmatch(base[name])
        assert found, (name, base[name])
        said.append(float(found[1]) / 100)
    assert said == steps
    assert base["--rk-module"] == f"color-mix(in srgb, var(--roko-fg) {round(tint * 100)}%, var(--roko-bg))"


@pytest.mark.parametrize("host", sorted(HOSTS))
def test_body_and_dim_text_read_at_least_4_5_to_1_on_every_theme(host: str) -> None:
    ground, ink = HOSTS[host]
    light, weak = _tone(ground, ink)
    assert light == (host in LIGHT), f"{host} read as {'light' if light else 'dark'}"
    panel = Panel(STYLE.read_text(encoding="utf-8"), ground, ink, light=light, weak=weak)
    surfaces = {
        "the page": panel.solid("--roko-bg"),
        "a module": panel.solid("--rk-module"),
        "a sunk area": panel.solid("--rk-module-2"),
    }
    for surface, rgb in surfaces.items():
        for name, role in (("--rk-ink", "titles"), ("--rk-ink-2", "body text"), ("--rk-ink-3", "dim text")):
            ratio = _contrast(panel.ink(name, rgb), rgb)
            assert ratio >= 4.5, f"{host}: {role} ({name}) on {surface} reads {ratio:.2f}:1"


def test_a_host_ink_that_fails_gives_way_to_the_panels_inks() -> None:
    # A dark ground with a dim ink of its own (2.6:1), and a light one with a pale ink (1.6:1): the panel's night and
    # day inks stand in, and every step reads.
    for ground, ink, light in (("#101418", "#4a5560", False), ("#f4f4f2", "#b8bcc0", True)):
        reads_light, weak = _tone(ground, ink)
        assert (reads_light, weak) == (light, True), (ground, ink)
        panel = Panel(STYLE.read_text(encoding="utf-8"), ground, ink, light=light, weak=weak)
        page = panel.solid("--roko-bg")
        for name in ("--rk-ink", "--rk-ink-2", "--rk-ink-3"):
            assert _contrast(panel.ink(name, page), page) >= 4.5, (ground, ink, name)

"""`hermes roko init`'s "Turn on roko's learning" (round v6): what it writes into roko.toml, what it leaves, and how
`hermes roko doctor` and the page say it (learning-research, section 2)."""

from __future__ import annotations

import tomllib
from pathlib import Path

import pytest
from conftest import FakeContext
from fake_roko_cli import INIT_TOML

from hermes_plugin_roko import diagnostics, install_state, onboard, render, ui_api
from hermes_plugin_roko.onboard import learning_state, turn_on_learning
from hermes_plugin_roko.runtime import Runtime


@pytest.fixture(autouse=True)
def _loaded_is_on_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    # Other work may change the checkout while a test runs; install_state would call that a stale backend.
    pinned = install_state._fingerprint()
    monkeypatch.setattr(install_state, "_LOADED_FINGERPRINT", pinned)
    monkeypatch.setattr(install_state, "_fingerprint", lambda: pinned)


# The tables `roko init` writes for these settings (roko 47b3cdd20), with a comment on one line.
ROKO_INIT_TOML = """\
[self_model]
mode = "shadow"
policy = "cascade"

[learning]
auto_playbook_refresh = true
dream_on_completion = false
gate_threshold_flush_interval = 10  # roko's default
frozen = false
guarded_commit = "observe"

[learning.dreams]
trigger_on_plan_complete = false

[experiments]
maximize = false

[sections]
pinned = []
"""


def changed_lines(old: str, new: str) -> list[tuple[str, str]]:
    return [(a, b) for a, b in zip(old.splitlines(), new.splitlines(), strict=True) if a != b]


def test_on_a_roko_init_file_it_changes_two_lines_and_nothing_else() -> None:
    new = turn_on_learning(ROKO_INIT_TOML)
    assert new is not None
    assert changed_lines(ROKO_INIT_TOML, new) == [
        (
            "gate_threshold_flush_interval = 10  # roko's default",
            "gate_threshold_flush_interval = 1  # roko's default",
        ),
        ("pinned = []", 'pinned = ["domain_context"]'),
    ]
    assert learning_state(tomllib.loads(new)) == "on"
    assert turn_on_learning(new) is None  # on already: nothing to do


def test_tables_it_lacks_are_added_with_rokos_safe_defaults() -> None:
    new = turn_on_learning(INIT_TOML)
    assert new is not None and new.startswith(INIT_TOML)
    data = tomllib.loads(new)
    assert data["learning"] == {"gate_threshold_flush_interval": 1, "guarded_commit": "observe"}
    assert data["sections"] == {"pinned": ["domain_context"]}
    assert data["self_model"] == {"mode": "shadow"} and data["experiments"] == {"maximize": False}
    # Dreams, the daimon, M1 and M4 are not turned on, nor even written.
    assert not {"daimon", "audit", "homeostasis"} & data.keys() and "dreams" not in data["learning"]


def test_what_the_person_chose_stays() -> None:
    mine = (
        ROKO_INIT_TOML.replace('mode = "shadow"', 'mode = "active"')
        .replace("maximize = false", "maximize = true")
        .replace("pinned = []", 'pinned = ["conventions"]')
    )
    data = tomllib.loads(turn_on_learning(mine) or "")
    assert data["self_model"]["mode"] == "active" and data["experiments"]["maximize"] is True
    assert data["sections"]["pinned"] == ["conventions", "domain_context"]


def test_line_endings_are_kept() -> None:
    crlf = ROKO_INIT_TOML.replace("\n", "\r\n")
    new = turn_on_learning(crlf) or ""
    assert "\n" not in new.replace("\r\n", "") and learning_state(tomllib.loads(new)) == "on"


def test_frozen_learning_is_left_frozen() -> None:
    frozen = ROKO_INIT_TOML.replace("frozen = false", "frozen = true")
    assert learning_state(tomllib.loads(frozen)) == "frozen" and turn_on_learning(frozen) is None


@pytest.mark.parametrize(
    "toml",
    [
        "learning = { frozen = false }\n[sections]\npinned = []\n",  # an inline table
        "learning.gate_threshold_flush_interval = 10\n",  # a dotted key at the top
        '[sections]\npinned = [\n  "conventions",\n]\n',  # an array over several lines
        '[sections]\npinned = "domain_context"\n',  # not a list
        "learning = 3\n",  # not a table
    ],
)
def test_a_layout_it_cannot_change_safely_is_refused(toml: str) -> None:
    with pytest.raises(ValueError):
        turn_on_learning(toml)


def test_learning_state_reads_on_off_and_frozen() -> None:
    assert learning_state(tomllib.loads(ROKO_INIT_TOML)) == "off"
    assert learning_state(tomllib.loads(turn_on_learning(ROKO_INIT_TOML) or "")) == "on"
    assert learning_state({}) == "off"
    assert learning_state({"learning": {"frozen": True, "gate_threshold_flush_interval": 1}}) == "frozen"


# -- what the doctor and the page say -----------------------------------------------------------------


def test_the_doctor_says_learning_on_or_off(tmp_path: Path) -> None:
    (tmp_path / "roko.toml").write_text(ROKO_INIT_TOML)
    off = diagnostics.learning_check(tmp_path)
    assert off is not None and off.status == diagnostics.OK
    line = render.doctor(diagnostics.Report([off]))
    assert line.startswith(
        "✓ learning: off: roko keeps lessons from verified work, but a prompt may leave them out"
    )
    assert line.endswith("; `hermes roko init` turns it on") and off.hint == onboard.LEARNING_DOCS
    (tmp_path / "roko.toml").write_text(turn_on_learning(ROKO_INIT_TOML) or "")
    on = diagnostics.learning_check(tmp_path)
    assert on is not None and on.detail.startswith(
        "on: the prompt section that carries lessons from verified work is never dropped"
    )
    (tmp_path / "roko.toml").write_text(ROKO_INIT_TOML.replace("frozen = false", "frozen = true"))
    frozen = diagnostics.learning_check(tmp_path)
    assert frozen is not None and frozen.detail.startswith("frozen:")
    # No workspace known, or no roko.toml: no line, rather than a guess.
    assert diagnostics.learning_check(None) is None
    assert diagnostics.learning_check(tmp_path / "nowhere") is None


def test_the_page_and_the_offline_doctor_get_the_line(tmp_path: Path) -> None:
    (tmp_path / "roko.toml").write_text(ROKO_INIT_TOML)
    rt = Runtime(FakeContext({"url": "http://127.0.0.1:9", "workdir": str(tmp_path)}))
    try:
        offline = diagnostics.run_doctor(rt, offline=True)
        assert [check.detail[:4] for check in offline.checks if check.name == "learning"] == ["off:"]
        # Learning off is not a problem: its line is OK. (The report as a whole may warn for other reasons, such
        # as plugin files that changed while the suite ran.)
        assert [check.status for check in offline.checks if check.name == "learning"] == [diagnostics.OK]
        page = ui_api.health(rt)
        assert [check["detail"][:4] for check in page["checks"] if check["name"] == "learning"] == ["off:"]
    finally:
        rt.close()

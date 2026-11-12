"""0.9 (round v8): the suite never writes into this machine's ~/.hermes, and a session fails if a test does.

Round v8 found 46 serve markers from test runs in a real ~/.hermes/plugin-data/roko/serves: a serve start's thread
outlived its test and wrote after the test's own HERMES_HOME was undone.
"""

from __future__ import annotations

import os
from pathlib import Path

import conftest
import pytest


def test_the_session_has_its_own_hermes_home() -> None:
    session = Path(conftest.SESSION_HERMES_HOME).resolve()
    assert session.is_dir()
    assert not session.is_relative_to((Path.home() / ".hermes").resolve())


def test_a_file_a_test_left_in_the_real_plugin_data_is_found(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    data = tmp_path / "plugin-data"
    serves = data / "roko" / "serves"
    serves.mkdir(parents=True)
    hermes_own = serves / "hermes-own.json"
    hermes_own.write_text('{"project": "/home/someone/code/app"}')
    untouched = serves / "untouched.json"
    temp = str(tmp_path / "pytest-of-someone" / "pytest-1")
    untouched.write_text('{"project": "' + temp + '/an-earlier-session/proj"}')
    monkeypatch.setattr(conftest, "REAL_PLUGIN_DATA", data)
    before = conftest._plugin_data_files()
    # Hermes writes for its own project while the suite runs: not the suite's doing.
    hermes_own.write_text('{"project": "/home/someone/code/app", "state": "running"}')
    os.utime(hermes_own, (1, 1))
    # A test's start thread writes its marker after the test: it names the session's temp folder.
    leaked = serves / "leaked.json"
    leaked.write_text('{"project": "' + temp + '/test_x0/proj", "state": "failed"}')
    assert conftest.tests_wrote_plugin_data(before, {temp}) == [leaked]
    # Nothing new: nothing found.
    assert conftest.tests_wrote_plugin_data(conftest._plugin_data_files(), {temp}) == []

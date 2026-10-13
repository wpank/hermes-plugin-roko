"""Run the plugin inside the installed Hermes (see hermes_harness.py), and through Plugin Doctor."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.compat

REPO = Path(__file__).resolve().parents[2]
HERMES_SRC = Path(os.environ.get("HERMES_AGENT_SRC", Path.home() / ".hermes" / "hermes-agent")).expanduser()
HERMES_PY = HERMES_SRC / "venv" / "bin" / "python"


def _need_hermes() -> None:
    if not (HERMES_SRC / "hermes_cli" / "plugins.py").is_file() or not HERMES_PY.is_file():
        pytest.skip(f"no Hermes install at {HERMES_SRC} (set HERMES_AGENT_SRC)")


def _env(home: Path) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("ROKO_", "HERMES_"))}
    env.update(
        {"HERMES_HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1", "HERMES_AGENT_SRC": str(HERMES_SRC)}
    )
    return env


def test_plugin_works_inside_hermes(tmp_path: Path) -> None:
    _need_hermes()
    proc = subprocess.run(
        [str(HERMES_PY), str(REPO / "tests" / "compat" / "hermes_harness.py")],
        capture_output=True,
        text=True,
        timeout=180,
        env=_env(tmp_path),
        cwd=REPO,
    )
    lines = [json.loads(line) for line in proc.stdout.splitlines() if line.startswith("{")]
    failed = [line for line in lines if line.get("ok") is False]
    assert proc.returncode == 0 and not failed, (failed, proc.stderr[-3000:])
    assert lines[-1] == {"summary": "ok", "checks": len(lines) - 1}


def test_install_scanner_allows_the_plugin(tmp_path: Path) -> None:
    """Hermes scans a plugin before it installs or updates it, and a high or critical finding blocks it.

    Literal bidirectional controls once did, and so nearly did a doc line with the word "host" and a later
    `$` (Hermes' DNS exfiltration pattern). This scans what an install would copy: the files git tracks,
    and new ones it does not ignore.
    """
    _need_hermes()
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=REPO,
        capture_output=True,
        check=True,
    ).stdout.split(b"\0")
    export = tmp_path / "roko"
    for raw in filter(None, listed):
        source = REPO / raw.decode()
        if source.is_file() and not source.is_symlink():
            target = export / raw.decode()
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    script = (
        "import json, sys\n"
        "from pathlib import Path\n"
        "sys.path.insert(0, sys.argv[2])\n"
        "from tools.plugin_guard import scan_plugin, should_allow_plugin_install\n"
        "r = scan_plugin(Path(sys.argv[1]), source='roko')\n"
        "print(json.dumps({'verdict': r.verdict, 'allowed': should_allow_plugin_install(r)[0], 'blocking': "
        "[[f.severity, f.file, f.pattern_id] for f in r.findings if f.severity in ('high', 'critical')]}))\n"
    )
    proc = subprocess.run(
        [str(HERMES_PY), "-c", script, str(export), str(HERMES_SRC)],
        capture_output=True,
        text=True,
        timeout=180,
        env=_env(tmp_path / "home"),
    )
    assert proc.returncode == 0, proc.stderr[-3000:]
    result = json.loads(proc.stdout.strip().splitlines()[-1])
    assert result["verdict"] == "safe" and result["allowed"] is True, result


def test_plugin_doctor_is_clean(tmp_path: Path) -> None:
    _need_hermes()
    export = tmp_path / "export" / "roko"
    shutil.copytree(
        REPO,
        export,
        ignore=shutil.ignore_patterns(
            ".venv", ".git", "tests", "__pycache__", "*.pyc", ".*_cache", "*.egg-info"
        ),
    )
    hermes = HERMES_SRC / "hermes"
    proc = subprocess.run(
        [str(HERMES_PY), str(hermes), "plugins", "doctor", str(export), "--ci"],
        capture_output=True,
        text=True,
        timeout=180,
        env=_env(tmp_path / "home"),
    )
    output = proc.stdout + proc.stderr
    assert proc.returncode == 0, output
    assert "OK: runtime discovery" in output and "8 tool(s), 0 hook(s)" in output
    assert "WARN" not in output and "ERROR" not in output, output


def test_harness_runs_under_this_interpreter_too() -> None:
    # The harness imports only the standard library and the fake server at module level.
    compile((REPO / "tests" / "compat" / "hermes_harness.py").read_text(), "hermes_harness.py", "exec")
    assert sys.version_info >= (3, 11)

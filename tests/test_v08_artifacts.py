"""0.8.0 (round v7, #7): what a run made: its UI shots, audio renders and reports, read from git.

Undertow's phase 4 commits `artifacts/ui/*.png`, phase 5 `artifacts/audio/*.wav` and
`artifacts/reports/pluginval-strict.txt`, and the person's own step at the end `artifacts/reports/auval.txt`. The
plugin reads them from the run's delivered commit only: an allow-list of extensions, size caps, the bytes checked
against the extension, never SVG or HTML.
"""

from __future__ import annotations

import base64
import math
import struct
import subprocess
import zlib
from pathlib import Path

import pytest

from hermes_plugin_roko import artifacts


def _png(width: int, height: int) -> bytes:
    def chunk(tag: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))

    rows = b"".join(b"\x00" + b"\x10\x10\x10" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def _wav(seconds: float, rate: int = 48_000, bits: int = 24, channels: int = 2) -> bytes:
    """A sine at 55 Hz, half scale, then silence for its second half."""
    frames = int(seconds * rate)
    width = bits // 8
    body = bytearray()
    for n in range(frames):
        value = 0.5 * math.sin(2 * math.pi * 55 * n / rate) if n < frames // 2 else 0.0
        sample = int(value * ((1 << (bits - 1)) - 1)).to_bytes(width, "little", signed=True)
        body += sample * channels
    fmt = struct.pack("<HHIIHH", 1, channels, rate, rate * width * channels, width * channels, bits)
    chunks = (
        b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(body)) + bytes(body)
    )
    return b"RIFF" + struct.pack("<I", 4 + len(chunks)) + b"WAVE" + chunks


def _repo(tmp_path: Path, files: dict[str, bytes]) -> tuple[Path, str]:
    repo = tmp_path / "undertow"
    repo.mkdir()
    git = ["git", "-C", str(repo), "-c", "user.name=t", "-c", "user.email=t@example.invalid"]
    subprocess.run([*git, "init", "-q", "-b", "main"], check=True)
    for name, data in files.items():
        path = repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    subprocess.run([*git, "add", "-A"], check=True)
    subprocess.run([*git, "commit", "-qm", "phase 5"], check=True)
    head = subprocess.run(
        [*git, "rev-parse", "HEAD"], check=True, capture_output=True, text=True
    ).stdout.strip()
    return repo, head


FILES = {
    "artifacts/ui/editor-idle.png": _png(12, 8),
    "artifacts/audio/init.wav": _wav(0.25),
    "artifacts/reports/pluginval-strict.txt": b"Starting tests in: pluginval / Plugin state...\nAll tests completed successfully\nSUCCESS\n",
    "artifacts/reports/auval.txt": b"VALIDATING AUDIO UNIT\n* * FAIL\nAU VALIDATION FAILED: 1 test failed\n",
    # Not what it says it is, not an allowed kind, and outside artifacts/: none of these reach a page.
    "artifacts/ui/trick.png": b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
    "artifacts/ui/logo.svg": b"<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "core/src/engine.cpp": b"int main() {}\n",
}


def test_a_runs_artifacts_are_its_allowed_files_under_artifacts_with_a_waveform_and_a_verdict(
    tmp_path: Path,
) -> None:
    repo, head = _repo(tmp_path, FILES)
    delivered = {"commit": head, "branch": "roko/batch/x", "files_changed": sorted(FILES)}
    made = artifacts.run_artifacts(delivered, repo)
    assert made["commit"] == head
    by_path = {item["path"]: item for item in made["items"]}
    assert sorted(by_path) == [
        "artifacts/audio/init.wav",
        "artifacts/reports/auval.txt",
        "artifacts/reports/pluginval-strict.txt",
        "artifacts/ui/editor-idle.png",
    ]
    image = by_path["artifacts/ui/editor-idle.png"]
    assert (image["kind"], image["width"], image["height"]) == ("image", 12, 8)
    audio = by_path["artifacts/audio/init.wav"]["audio"]
    assert (audio["seconds"], audio["rate"], audio["bits"], audio["channels"]) == (0.25, 48_000, 24, 2)
    assert len(audio["peaks"]) == artifacts.PEAKS
    # The sine's half is loud (about half scale), its silent half is 0.
    assert 0.4 < max(audio["peaks"][:100]) <= 0.51 and max(audio["peaks"][-100:]) == 0.0
    assert by_path["artifacts/reports/pluginval-strict.txt"]["verdict"] == "passed"
    assert by_path["artifacts/reports/auval.txt"]["verdict"] == "failed"
    assert by_path["artifacts/reports/auval.txt"]["line"] == "AU VALIDATION FAILED: 1 test failed"


def test_a_file_a_page_gets_is_one_the_run_changed_and_whose_bytes_match_its_kind(tmp_path: Path) -> None:
    repo, head = _repo(tmp_path, FILES)
    delivered = {"commit": head, "files_changed": sorted(FILES)}
    image = artifacts.artifact_file(delivered, repo, "artifacts/ui/editor-idle.png")
    assert image is not None and image["mime"] == "image/png"
    assert base64.urlsafe_b64decode(image["data"]) == FILES["artifacts/ui/editor-idle.png"]
    assert artifacts.artifact_file(delivered, repo, "artifacts/audio/init.wav")["mime"] == "audio/wav"
    assert artifacts.artifact_file(delivered, repo, "artifacts/ui/trick.png") is None  # an SVG named .png
    assert artifacts.artifact_file(delivered, repo, "artifacts/ui/logo.svg") is None
    assert (
        artifacts.artifact_file(delivered, repo, "artifacts/reports/auval.txt") is None
    )  # reports say themselves
    assert artifacts.artifact_file(delivered, repo, "core/src/engine.cpp") is None
    assert artifacts.artifact_file(delivered, repo, "artifacts/../core/src/engine.cpp") is None
    # Only what the run changed: a file at the commit that the run did not touch is not its own.
    assert (
        artifacts.artifact_file({"commit": head, "files_changed": []}, repo, "artifacts/ui/editor-idle.png")
        is None
    )


def test_a_file_over_its_cap_and_a_run_without_delivered_work_make_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    repo, head = _repo(tmp_path, FILES)
    monkeypatch.setitem(artifacts.CAPS, "audio", 1_000)
    made = artifacts.run_artifacts({"commit": head, "files_changed": sorted(FILES)}, repo)
    assert "artifacts/audio/init.wav" not in [item["path"] for item in made["items"]]
    assert artifacts.run_artifacts(None, repo) == {"commit": None, "items": []}
    assert artifacts.run_artifacts({"commit": head, "files_changed": sorted(FILES)}, None) == {
        "commit": None,
        "items": [],
    }


def test_the_routes_read_the_runs_delivered_work_and_send_bytes_that_no_page_rewrite_can_touch(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """GET /runs/{id}/artifacts and /artifact?path= find the run's delivered work as Merge does (`work_view`).
    The file's bytes go as URL-safe base64, which has no `/`: the pages' rewrite of the home path to `~` can
    never change them."""
    from conftest import FakeContext
    from fake_roko import FakeRoko

    from hermes_plugin_roko import rundata, ui_api
    from hermes_plugin_roko.errors import RokoError
    from hermes_plugin_roko.runtime import Runtime

    repo, head = _repo(tmp_path, FILES)
    delivered = {
        "commit": head,
        "branch": "roko/batch/r1",
        "files_changed": sorted(FILES),
        "workspace": str(repo),
    }
    monkeypatch.setattr(rundata, "run_status", lambda client, run_id: {"state": "succeeded"})
    monkeypatch.setattr(rundata, "work_view", lambda *a, **k: {"delivered": delivered, "work": None})
    fake = FakeRoko().start()
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(repo)}))
    try:
        run_id = "e13f6327-8c2d-4a7b-b1e4-6f0a9d3c2e11"
        made = ui_api.for_page(artifacts.run_made(rt, run_id))
        assert made["items"][0]["path"] == "artifacts/audio/init.wav"
        image = ui_api.for_page(artifacts.run_made_file(rt, run_id, {"path": "artifacts/ui/editor-idle.png"}))
        assert "/" not in image["data"]
        assert base64.urlsafe_b64decode(image["data"]) == FILES["artifacts/ui/editor-idle.png"]
        try:
            artifacts.run_made_file(rt, run_id, {"path": "artifacts/ui/trick.png"})
        except RokoError as exc:
            assert exc.code.value == "not_found"
        else:
            raise AssertionError("an SVG named .png was sent")
    finally:
        rt.close()
        fake.stop()

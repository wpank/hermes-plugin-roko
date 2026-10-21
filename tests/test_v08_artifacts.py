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


def test_shots_past_the_cards_first_30_files_are_found_in_git(tmp_path: Path) -> None:
    """Phase 4 prep E: a delivery's `files_changed` is cut at 30 ("… 15 more"), and the shots were found only in
    that list: a delivery of 45 files whose shots sort after the first 30 showed none. When the list was cut, the
    artifacts come from git, between the delivery's base and its commit."""
    repo, base = _repo(tmp_path, {"README.md": b"# Undertow\n"})
    files = {f"aaa/f{n:02}.txt": b"x\n" for n in range(42)} | {
        "artifacts/ui/editor-idle.png": _png(1200, 760),
        "artifacts/ui/editor-playing.png": _png(1200, 760),
        "artifacts/ui/gone.png": _png(4, 4),
    }
    for name, data in files.items():
        (repo / name).parent.mkdir(parents=True, exist_ok=True)
        (repo / name).write_bytes(data)
    who = ("-c", "user.name=t", "-c", "user.email=t@example.invalid")
    # gone.png is deleted in a later commit: never listed.
    for argv in (
        ("add", "-A"),
        ("commit", "-qm", "4"),
        ("rm", "-q", "artifacts/ui/gone.png"),
        ("commit", "-qm", "5"),
    ):
        assert artifacts._git(repo, *who, *argv) is not None, argv
    commit = (artifacts._git(repo, "rev-parse", "HEAD") or b"").decode().strip()
    listed = [*sorted(files)[:30], f"… {len(files) - 30} more"]
    assert not any(path.startswith("artifacts/") for path in listed)  # the card's list misses every shot
    delivered = {"commit": commit[:12], "base": base[:12], "files_changed": listed}
    made = artifacts.run_artifacts(delivered, repo)
    assert [(item["path"], item["width"], item["height"]) for item in made["items"]] == [
        ("artifacts/ui/editor-idle.png", 1200, 760),
        ("artifacts/ui/editor-playing.png", 1200, 760),
    ]
    shot = artifacts.artifact_file(delivered, repo, "artifacts/ui/editor-playing.png")
    assert shot is not None and base64.urlsafe_b64decode(shot["data"]).startswith(b"\x89PNG")
    # A list that was not cut is the list, as before.
    whole = {**delivered, "files_changed": ["artifacts/ui/editor-idle.png"]}
    assert [item["path"] for item in artifacts.run_artifacts(whole, repo)["items"]] == [
        "artifacts/ui/editor-idle.png"
    ]
    assert artifacts.artifact_file(whole, repo, "artifacts/ui/editor-playing.png") is None


def test_a_passed_phases_pad_names_its_first_ui_shot_with_no_bytes_read(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Phase 4 prep C: the Build tab's pad of a passed phase shows its passing run's first UI shot. GET /build names
    it ({run_id, path, bytes}) from `git cat-file -s` alone, once a run (the run log keeps it), and never one over
    1 MB: the pad loads it as a thumbnail."""
    import os

    from conftest import FakeContext
    from fake_roko import FakeRoko

    from hermes_plugin_roko import buildview, rundata
    from hermes_plugin_roko.runtime import Runtime

    files = {
        "docs/specs/phase-4-face.md": b"# Phase 4: the face\n\n**Goal**: the editor.\n",
        "artifacts/ui/a-huge.png": b"\x89PNG\r\n\x1a\n" + os.urandom(1_100_000),  # sorts first, over 1 MB
        "artifacts/ui/editor-idle.png": _png(1200, 760),
        "artifacts/audio/init.wav": _wav(0.05),
    }
    repo, head = _repo(tmp_path, files)
    delivered = {
        "commit": head,
        "branch": "roko/batch/r-p4",
        "files_changed": sorted(files),
        "workspace": str(repo),
    }
    asked: list[str] = []
    monkeypatch.setattr(rundata, "run_status", lambda client, run_id: {"state": "succeeded"})
    monkeypatch.setattr(
        rundata,
        "work_view",
        lambda client, cards, run_id, *a, **k: asked.append(run_id) or {"delivered": delivered},
    )
    fake = FakeRoko().start()
    fake.add_plan("p4-undertow-face", "P4 · Undertow face", [{"id": "T1"}])
    fake.plans["p4-undertow-face"]["tasks_done"] = 1
    rt = Runtime(FakeContext({"url": fake.url, "workdir": str(repo)}))
    try:
        rt.runs.add("r-p4", "plan", "P4 · Undertow face", plan_id="p4-undertow-face")
        rt.runs.update(
            "r-p4", state="succeeded", cost_final=True, started_at="2026-10-21T07:00:00Z",
            finished_at="2026-10-21T08:00:00Z",
        )  # fmt: skip
        [phase] = [p for p in buildview.build_view(rt)["phases"] if p["n"] == 4]
        size = len(files["artifacts/ui/editor-idle.png"])
        assert phase["state"] == "passed"
        assert phase["shot"] == {"run_id": "r-p4", "path": "artifacts/ui/editor-idle.png", "bytes": size}
        buildview.build_view(rt)
        assert asked == ["r-p4"]  # found once a run: the run log keeps it
        assert rt.runs.get("r-p4")["shot"]["path"] == "artifacts/ui/editor-idle.png"
    finally:
        rt.close()
        fake.stop()

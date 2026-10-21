"""What a run made (round v7, #7): the images, audio renders and reports its work adds under `artifacts/`.

Read from git only, at the run's delivered commit (`git cat-file`): the files the run changed (its card's
`delivered.files_changed`) under `artifacts/`, by an allow-list of extensions, each within its size cap, its
magic bytes checked before a page gets its bytes, never SVG or HTML. A WAV's waveform is worked out here (its
peaks), so a page draws it without the audio; the audio goes to a page only when the person asks to play it.
"""

from __future__ import annotations

import base64
import logging
import struct
import subprocess
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any

from .errors import Code, RokoError
from .sanitize import clean

if TYPE_CHECKING:
    from .runtime import Runtime

logger = logging.getLogger(__name__)

ARTIFACT_DIR = "artifacts/"
KINDS = {
    ".png": "image",
    ".jpg": "image",
    ".jpeg": "image",
    ".wav": "audio",
    ".txt": "report",
    ".log": "report",
}
MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".wav": "audio/wav"}
# The largest file of each kind a page gets: Undertow's UI shots are under 2 MB, its renders under 5 MB.
CAPS = {"image": 4 * 1024 * 1024, "audio": 8 * 1024 * 1024, "report": 256 * 1024}
MAX_ITEMS = 24
# A Build pad's thumbnail is the shot's own bytes, scaled by the page (no image library here): none past this.
THUMB_CAP = 1024 * 1024
PEAKS = 240
# At most this many samples are read for each peak: a strided look is enough for a waveform's outline.
PEAK_SAMPLES = 512
GIT_TIMEOUT_S = 10
# Waveforms worked out, by (commit, path): a commit's file never changes.
_WAVES: dict[tuple[str, str], dict[str, Any] | None] = {}
MAX_WAVES = 48


def kind_of(path: str) -> str | None:
    """`image`, `audio` or `report` for a path under artifacts/ with an allowed extension, else None."""
    if not path.startswith(ARTIFACT_DIR) or ".." in PurePosixPath(path).parts:
        return None
    return KINDS.get(PurePosixPath(path).suffix.lower())


def _git(workdir: Path, *argv: str) -> bytes | None:
    """`git -C workdir argv…`'s output, or None when it failed."""
    try:
        done = subprocess.run(
            ["git", "-C", str(workdir), *argv],
            capture_output=True,
            timeout=GIT_TIMEOUT_S,
            check=False,
            stdin=subprocess.DEVNULL,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("roko: git %s failed: %s", " ".join(argv[:2]), exc)
        return None
    return done.stdout if done.returncode == 0 else None


def _blob(workdir: Path, commit: str, path: str, cap: int) -> bytes | None:
    """The bytes of `path` at `commit`, or None (missing, over `cap`, or git failed)."""
    spec = f"{commit}:{path}"
    size = _git(workdir, "cat-file", "-s", spec)
    if size is None or not size.strip().isdigit() or int(size.strip()) > cap:
        return None
    blob = _git(workdir, "cat-file", "blob", spec)
    return blob if blob is not None and len(blob) <= cap else None


def magic_ok(path: str, data: bytes) -> bool:
    """Whether the bytes are what the extension says: PNG, JPEG or a RIFF WAVE."""
    suffix = PurePosixPath(path).suffix.lower()
    if suffix == ".png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if suffix in (".jpg", ".jpeg"):
        return data.startswith(b"\xff\xd8\xff")
    if suffix == ".wav":
        return len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"
    return False


def wav_view(data: bytes) -> dict[str, Any] | None:
    """A PCM (16, 24 or 32-bit) or float WAV's length, format and waveform: `PEAKS` peaks between 0 and 1,
    each the largest |sample| a strided look finds in its slice. None when it is not a WAV this reads."""
    if not (len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WAVE"):
        return None
    at, fmt, body, code = 12, None, None, 0
    while at + 8 <= len(data):
        tag, size = data[at : at + 4], struct.unpack_from("<I", data, at + 4)[0]
        start = at + 8
        if tag == b"fmt " and size >= 16 and start + 16 <= len(data):
            fmt = struct.unpack_from("<HHIIHH", data, start)
            code = fmt[0]
            if code == 0xFFFE and size >= 26 and start + 26 <= len(data):
                code = struct.unpack_from("<H", data, start + 24)[0]  # WAVE_FORMAT_EXTENSIBLE: its sub-format
        elif tag == b"data":
            body = (start, min(len(data), start + size))
        at = start + size + (size & 1)
    if fmt is None or body is None:
        return None
    _, channels, rate, _, align, bits = fmt
    width = bits // 8
    if code not in (1, 3) or channels < 1 or rate <= 0 or width not in (2, 3, 4) or align != width * channels:
        return None
    frames = (body[1] - body[0]) // align
    if frames <= 0:
        return None
    floats = code == 3
    full = float(1 << (bits - 1))

    def sample(offset: int) -> float:
        if width == 2:
            return float(struct.unpack_from("<h", data, offset)[0]) / full
        if width == 3:
            raw = data[offset : offset + 3]
            return int.from_bytes(raw, "little", signed=True) / full
        if floats:
            return float(struct.unpack_from("<f", data, offset)[0])
        return float(struct.unpack_from("<i", data, offset)[0]) / full

    peaks = []
    for bucket in range(PEAKS):
        first, last = (
            bucket * frames // PEAKS,
            max(bucket * frames // PEAKS + 1, (bucket + 1) * frames // PEAKS),
        )
        step = max(1, (last - first) // PEAK_SAMPLES)
        top = 0.0
        for frame in range(first, min(last, frames), step):
            base = body[0] + frame * align
            for channel in range(channels):
                top = max(top, abs(sample(base + channel * width)))
        peaks.append(round(min(1.0, top), 3))
    return {
        "seconds": round(frames / rate, 2),
        "rate": rate,
        "bits": bits,
        "channels": channels,
        "peaks": peaks,
    }


def report_view(path: str, text: str) -> dict[str, Any]:
    """A report's verdict as its tool says it (pluginval's SUCCESS or FAILURE, auval's AU VALIDATION
    SUCCEEDED or FAILED), else none, and the line that says it."""
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    upper = text.upper()
    if (
        "AU VALIDATION SUCCEEDED" in upper
        or "ALL TESTS COMPLETED SUCCESSFULLY" in upper
        or any(line == "SUCCESS" for line in lines)
    ):
        verdict = "passed"
    elif (
        "AU VALIDATION FAILED" in upper
        or any(line in ("FAILURE", "FAILED") for line in lines)
        or "*** FAILED" in upper
    ):
        verdict = "failed"
    else:
        verdict = None
    said = next(
        (
            line
            for line in reversed(lines)
            if any(word in line.upper() for word in ("SUCCESS", "FAIL", "VALIDATION"))
        ),
        lines[0] if lines else "",
    )
    return {"verdict": verdict, "line": clean(said, 200, one_line=True) or None}


def _changed(delivered: dict[str, Any], workdir: Path) -> list[str]:
    """The files the run's delivered work changed under artifacts/, of an allowed kind: its card's
    `files_changed`, or, when the card cut that list at 30 ("… 15 more"), git's, between the delivery's base
    and its commit (phase 4 prep E: a delivery's shots may sort after its first 30 files)."""
    listed = [str(path) for path in delivered.get("files_changed") or [] if isinstance(path, str)]
    base, commit = str(delivered.get("base") or ""), str(delivered.get("commit") or "")
    if base and commit and any(path.startswith("… ") for path in listed):
        found = _git(workdir, "diff", "--name-only", "--diff-filter=d", base, commit, "--", ARTIFACT_DIR)
        listed = found.decode("utf-8", errors="replace").splitlines() if found is not None else []
    return [path for path in listed if kind_of(path)]


def run_artifacts(delivered: dict[str, Any] | None, workdir: Path | None) -> dict[str, Any]:
    """`GET /runs/{id}/artifacts`: what the run's delivered work adds under artifacts/, at its commit: each
    item's path, kind and size, a WAV's waveform, a report's verdict. Empty without work on this machine."""
    if not isinstance(delivered, dict) or workdir is None:
        return {"commit": None, "items": []}
    commit = str(delivered.get("commit") or delivered.get("branch") or "")
    paths = _changed(delivered, workdir)
    items: list[dict[str, Any]] = []
    for path in sorted(paths)[:MAX_ITEMS]:
        kind = kind_of(path)
        data = _blob(workdir, commit, path, CAPS[kind]) if kind is not None else None
        if kind is None or data is None:
            continue
        item: dict[str, Any] = {
            "path": path,
            "name": PurePosixPath(path).name,
            "kind": kind,
            "bytes": len(data),
        }
        if kind == "audio":
            if not magic_ok(path, data):
                continue
            key = (commit, path)
            if key not in _WAVES:  # a waveform reads a few MB: once per file and commit
                _WAVES[key] = wav_view(data)
                while len(_WAVES) > MAX_WAVES:
                    _WAVES.pop(next(iter(_WAVES)))
            item["audio"] = _WAVES[key]
        elif kind == "image":
            if not magic_ok(path, data):
                continue
            if data.startswith(b"\x89PNG") and len(data) >= 24:
                item["width"], item["height"] = struct.unpack_from(">II", data, 16)
        else:
            item.update(report_view(path, data.decode("utf-8", errors="replace")))
        items.append(item)
    return {"commit": commit or None, "items": items}


def artifact_file(delivered: dict[str, Any] | None, workdir: Path | None, path: str) -> dict[str, Any] | None:
    """`GET /runs/{id}/artifact?path=`: one image or audio file of the run's, as `{path, mime, data}`
    (base64), when the run changed it, its kind is allowed, it fits its cap and its bytes match its kind."""
    kind = kind_of(path)
    if kind not in ("image", "audio") or not isinstance(delivered, dict) or workdir is None:
        return None
    if path not in _changed(delivered, workdir):
        return None
    data = _blob(workdir, str(delivered.get("commit") or delivered.get("branch") or ""), path, CAPS[kind])
    if data is None or not magic_ok(path, data):
        return None
    return {
        "path": path,
        "mime": MIME[PurePosixPath(path).suffix.lower()],
        # URL-safe base64 has no "/": the pages' rewrite of the home path to "~" can never touch it.
        "data": base64.urlsafe_b64encode(data).decode("ascii"),
    }


def _delivered(rt: Runtime, run_id: str) -> tuple[dict[str, Any] | None, Path | None]:
    """A run's delivered work and the checkout it is in, as Merge finds them (`rundata.work_view`)."""
    from . import rundata, views

    run_id = views.resolve_run_id(rt, run_id)
    rt = rt.for_run(run_id)  # the checkout and roko serve of the project the run ran in
    settings = rt.settings()
    client = rt.client(settings)
    summary = rundata.run_status(client, run_id)
    view = rundata.work_view(
        client, rt.cards, run_id, summary, workdir=settings.workdir, logged=rt.runs.get(run_id)
    )
    delivered = view.get("delivered") if isinstance(view.get("delivered"), dict) else None
    where = (delivered or {}).get("workspace") or settings.workdir
    return delivered, Path(where) if where else None


def first_ui_shot(delivered: dict[str, Any] | None, workdir: Path | None) -> dict[str, Any] | None:
    """The first UI shot (an image under artifacts/ui/) a run's delivered work made that fits a thumbnail:
    `{path, bytes}`, from `git cat-file -s` alone, no bytes read (phase 4 prep C). None without one."""
    if not isinstance(delivered, dict) or workdir is None:
        return None
    commit = str(delivered.get("commit") or delivered.get("branch") or "")
    shots = [path for path in _changed(delivered, workdir) if path.startswith(f"{ARTIFACT_DIR}ui/")]
    for path in sorted(shots)[:8]:
        size = (_git(workdir, "cat-file", "-s", f"{commit}:{path}") or b"").strip()
        if kind_of(path) == "image" and size.isdigit() and int(size) <= THUMB_CAP:
            return {"path": path, "bytes": int(size)}
    return None


def run_shot(rt: Runtime, run_id: str) -> dict[str, Any] | None:
    """A run's first UI shot that fits a thumbnail (`first_ui_shot`), from its delivered work."""
    return first_ui_shot(*_delivered(rt, run_id))


def run_made(rt: Runtime, run_id: str) -> dict[str, Any]:
    """`GET /runs/{id}/artifacts` (docs/ui-api.md)."""
    return run_artifacts(*_delivered(rt, run_id))


def run_made_file(rt: Runtime, run_id: str, params: dict[str, str]) -> dict[str, Any]:
    """`GET /runs/{id}/artifact?path=` (docs/ui-api.md); not_found for anything it will not send."""
    path = clean(params.get("path"), 300, one_line=True)
    found = artifact_file(*_delivered(rt, run_id), path)
    if found is None:
        raise RokoError(Code.NOT_FOUND, f"{path or 'that path'} is not an image or a sound this run made")
    return found

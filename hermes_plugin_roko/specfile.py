"""A spec file in the project that roko's planner writes a plan from (round v7, P-6).

Asked naturally, a chat model sent roko a summary of a spec, or copied a 14 KB spec by hand and mangled its
tables, so roko's spec check had nothing to keep. roko serve since gap-fe4225 takes the spec's path
(`plan_generate`'s `spec_path`) and reads the file exactly; for an older roko, which takes only a prompt, the
plugin reads it, as roko would have. A phase's spec (`docs/specs/phase-<n>-<slug>.md`, "# Phase <n>: <name>")
names its plan "P<n> · <Name>", which is how the Build tab finds a phase's plans.
"""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath
from typing import Any

from .errors import Code, RokoError
from .sanitize import clean

SPEC_DIR = Path("docs") / "specs"
SPEC_FILE = re.compile(r"^phase-(\d{1,2})-([a-z0-9][a-z0-9-]{0,60})\.md$")
SPEC_TITLE = re.compile(r"^#\s*phase\s+\d{1,2}\s*[:·.\-–—]\s*(.+?)\s*$", re.I)
# The largest spec roko reads (gap-fe4225's MAX_SPEC_BYTES).
SPEC_BYTES = 1024 * 1024
_HEAD_BYTES = 8 * 1024


def checked(workdir: Path | None, value: Any) -> str | None:
    """`spec_path` as roko takes it: a path relative to the project, its parts joined by `/`; None when not
    given. With the project's folder known, it must name a file of at most 1 MiB inside it, as roko checks."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    if not isinstance(value, str) or len(value) > 400 or "\x00" in value:
        raise RokoError(Code.INVALID, "spec_path must be a path in the project, as text")
    given = value.strip().replace("\\", "/")
    path = PurePosixPath(given)
    if path.is_absolute() or re.match(r"^[A-Za-z]:", given) or given.startswith("~"):
        raise RokoError(Code.INVALID, f"spec_path {given} must be a path relative to the project")
    if ".." in path.parts:
        raise RokoError(Code.INVALID, f"spec_path {given} must name a file inside the project")
    relative = path.as_posix()
    if workdir is None:
        return relative
    root = Path(workdir).resolve()
    file = (root / relative).resolve()
    if not file.is_relative_to(root):
        raise RokoError(Code.INVALID, f"spec_path {relative} must name a file inside the project")
    if not file.is_file():
        raise RokoError(Code.INVALID, f"spec_path {relative} is not a file in the project")
    if file.stat().st_size > SPEC_BYTES:
        raise RokoError(Code.INVALID, f"spec_path {relative} is larger than 1 MiB, the most roko reads")
    return relative


def text(workdir: Path | None, path: str) -> str:
    """The spec's exact text, for a roko that cannot read it itself (before gap-fe4225)."""
    if workdir is None:
        raise RokoError(
            Code.INVALID,
            "this roko cannot read a spec itself, and the plugin does not know the project's folder",
            hint="update roko, or put the spec's text in prompt as it is written",
        )
    try:
        return (Path(workdir) / path).read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        raise RokoError(Code.INVALID, f"spec_path {path} cannot be read: {exc}") from exc


def request(workdir: Path | None, path: str, prompt: str | None) -> str:
    """What an older roko is sent for a plan from a spec: the spec, then what the person adds (roko's own
    `plan_request_text`)."""
    spec = text(workdir, path)
    return f"{spec}\n\n---\n\n{prompt}\n" if prompt else spec


def phase(path: str | None) -> int | None:
    """The phase a spec is for, from its file name (`docs/specs/phase-2-rumble.md` is phase 2)."""
    found = SPEC_FILE.match(PurePosixPath(path).name) if path else None
    return int(found[1]) if found else None


def plan_name(workdir: Path | None, path: str) -> str:
    """What a plan written from a spec is called: "P2 · Rumble and modulation" for a phase's spec, else the
    spec's first heading, else its file name."""
    head = ""
    if workdir is not None:
        try:
            with (Path(workdir) / path).open("rb") as handle:
                head = handle.read(_HEAD_BYTES).decode("utf-8", errors="replace")
        except OSError:
            head = ""
    heading = next((line.strip() for line in head.splitlines() if line.startswith("# ")), "")
    n = phase(path)
    named = SPEC_TITLE.match(heading) if n is not None else None
    if n is not None:
        name = named[1] if named else PurePosixPath(path).stem.split("-", 2)[-1].replace("-", " ")
        return clean(f"P{n} · {name[:1].upper()}{name[1:]}", 80, one_line=True)
    return clean(heading.lstrip("# ").strip() or PurePosixPath(path).name, 80, one_line=True)

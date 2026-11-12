"""A project's build (round v7, #3): its phases in order, as one piece of work.

A long build (Metakosmia Undertow: six phases, each a spec, then a plan, then its runs) reads here as one
thing: which phases passed, which one runs, what is written and what is only specified, what the build cost
and took, and what roko's cheap rungs saved across the whole of it. A phase is found from

- a spec, `docs/specs/phase-<n>-<slug>.md` in the project, whose first lines say "# Phase <n>: <name>" and
  "**Goal**: …";
- a plan titled "P<n> · <name>" ("Title: P<n> · …" too: a planner may keep the request's word) or named
  `p<n>-<slug>` (`title-p<n>-…`).

Its runs are the ones Hermes started (the run log); its task counts are roko's plan row (`tasks_done` of
`task_count`), which hold across a resume. Nothing here starts work or reads a run's events: a run's receipt
is the one the run log kept when its whole card was read.

The build is the plans in the workspace's `plans/` folder (roko's plan list, or the folder itself while roko
is down), each by its exact id. roko's ledger and the run log can hold an earlier build's plans (Undertow 1's
in Undertow 2's `.roko`, round v8): a plan outside that set never counts toward a phase, by a number guessed
from its id or otherwise; what it spent is one line apart (`elsewhere_usd`).
"""

from __future__ import annotations

import logging
import re
import time
import tomllib
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from . import artifacts, rundata, specfile, tools, views
from .catalog import TERMINAL_STATES
from .errors import Code, RokoError
from .runtime import Runtime
from .runwork import PLAN_PREFIX
from .sanitize import clean
from .specfile import SPEC_DIR, SPEC_FILE, SPEC_TITLE

logger = logging.getLogger(__name__)

_SPEC_GOAL = re.compile(r"^\*\*goal\*\*\s*:?\s*(.+)$", re.I)
_PLAN_TITLE = re.compile(r"^(?:title:\s*)?p(\d{1,2}(?:\.\d{1,2})?)\s*[·:.\-–—]\s*(.+?)\s*$", re.I)
# A plan id `p2-1-…` is sub-phase 2.1 only when a phase-2.1 spec exists, else phase 2 whose slug starts "1-".
_SUB_SLUG = re.compile(r"^(\d{1,2})-([a-z0-9][a-z0-9-]*)$")
_PLAN_ID = re.compile(r"^(?:title-)?p(\d{1,2})-([a-z0-9][a-z0-9-]*)$")
MAX_PHASES = 24
# Ended runs the run log has no end for, whose end roko's summary is asked for: at most this many a build,
# once a run. Likewise the passing runs whose first UI shot is looked for (phase 4 prep C).
END_LOOKUPS = 4
# A spec's head is read for its name and goal: at most this much of it.
SPEC_HEAD_BYTES = 8 * 1024
GOAL_CHARS = 240
# The ended runs whose receipt the run log lacks, listed so a page can open them (and so read it) one by one.
UNREAD_LISTED = 8
# A plan's tasks.toml written this long after the plugin learned roko's count of it was edited since (P4.3).
EDITED_SLACK_S = 2.0
# A spec's acceptance checks: a table row "| P2.04 | `tools/spec.sh 2 rumble 'P2.04*'` | … |" under a heading
# that says "acceptance" (undertow-spec's phase specs). Read from at most this much of the spec.
# A check's row: its id (an id range, `P5.01-P5.03`, is one check sharing one command) and its command.
_CHECK_ROW = re.compile(
    r"^\|\s*([A-Za-z]+\d+(?:\.\d+)*(?:\s*[-\u2013]\s*[A-Za-z]*\d+(?:\.\d+)*)?)\s*\|\s*`([^`]{1,400})`\s*\|"
)
SPEC_BYTES = 256 * 1024
PLAN_BYTES = 512 * 1024
MISSING_LISTED = 20
# A shell command's separators, between the commands a verify step runs.
# How a phase's latest run ended, as the build says it.
_STOPPED = {"failed": "failed", "cancelled": "cancelled", "interrupted": "interrupted", "missing": "missing"}


def plan_phase(
    plan_id: str, title: str | None, known: frozenset[int | float] = frozenset()
) -> tuple[int | float, str] | None:
    """The phase a plan is, and its name, from its title ("P2 · Undertow rumble", "P2.1 · Undertow voice
    fixes") or its id (`p2-undertow-rumble`; `p2-1-…` is 2.1 when `known` names that phase's spec, P-42)."""
    found = _PLAN_TITLE.match(clean(title, 200, one_line=True))
    if found:
        return specfile.number(found[1]), found[2]
    found = _PLAN_ID.match(plan_id or "")
    if not found:
        return None
    sub = _SUB_SLUG.match(found[2])
    if sub and specfile.number(f"{found[1]}.{sub[1]}") in known:
        return specfile.number(f"{found[1]}.{sub[1]}"), sub[2].replace("-", " ")
    return int(found[1]), found[2].replace("-", " ")


def spec_phases(workdir: Path | None) -> dict[int | float, dict[str, Any]]:
    """The phases the project's specs name, by number: `{name, goal, spec}` (its path in the project)."""
    folder = workdir / SPEC_DIR if workdir is not None else None
    try:
        names = (
            sorted(path.name for path in folder.iterdir()) if folder is not None and folder.is_dir() else []
        )
    except OSError:
        return {}
    phases: dict[int | float, dict[str, Any]] = {}
    for name in names:
        found = SPEC_FILE.match(name)
        if found is None or len(phases) >= MAX_PHASES or specfile.number(found[1]) in phases:
            continue
        title: str | None = None
        goal: str | None = None
        try:
            with (folder / name).open("rb") as handle:  # type: ignore[operator]
                head = handle.read(SPEC_HEAD_BYTES).decode("utf-8", errors="replace")
        except OSError:
            head = ""
        reading_goal = False
        for line in head.splitlines()[:60]:
            if reading_goal and line.strip() and not line.lstrip().startswith(("#", "|", "- ", "* ")):
                goal = f"{goal} {line.strip()}"  # the goal's paragraph goes on: a spec wraps its lines
                continue
            reading_goal = False
            if title is None and (named := SPEC_TITLE.match(line.strip())):
                title = named[1]
            elif goal is None and (said := _SPEC_GOAL.match(line.strip())):
                goal, reading_goal = said[1], True
        phases[specfile.number(found[1])] = {
            "name": clean(title or found[2].replace("-", " "), 80, one_line=True),
            "goal": first_sentence(goal),
            "spec": f"{SPEC_DIR.as_posix()}/{name}",
        }
    return phases


def first_sentence(text: str | None) -> str | None:
    """A spec's goal, short: its first sentence, cut at a word with "…" when even that is long (P-26)."""
    words = clean(text, 4_000, one_line=True)
    if not words:
        return None
    end = re.search(r"[.!?](?=\s|$)", words)
    sentence = words[: end.end()] if end else words
    if len(sentence) <= GOAL_CHARS:
        return sentence
    return sentence[:GOAL_CHARS].rsplit(" ", 1)[0].rstrip(",;:") + "…"


def spec_checks(workdir: Path | None, spec: str | None) -> list[tuple[str, str]]:
    """The acceptance checks a phase's spec states, in order: `(id, command)`."""
    if workdir is None or not spec:
        return []
    try:
        with (Path(workdir) / spec).open("rb") as handle:
            text = handle.read(SPEC_BYTES).decode("utf-8", errors="replace")
    except OSError:
        return []
    checks: list[tuple[str, str]] = []
    inside = False
    for line in text.splitlines():
        if line.startswith("#"):
            inside = "acceptance" in line.lower()
        elif inside and (row := _CHECK_ROW.match(line.strip())):
            checks.append(("".join(row[1].split()), row[2].strip()))
    return checks[:200]


def _plan_file(workdir: Path | None, plan_id: str) -> Path | None:
    """A plan's tasks.toml in the workspace (`plans/<id>/`, or one group folder down); None without one."""
    if workdir is None or not re.match(r"^[A-Za-z0-9][\w.-]{0,119}$", plan_id):
        return None
    root = Path(workdir) / "plans"
    found = [root / plan_id / "tasks.toml", *root.glob(f"*/{plan_id}/tasks.toml")]
    return next((one for one in found if one.is_file()), None)


def plans_present(workdir: Path | None) -> set[str]:
    """The plans in the workspace's `plans/` folder (or one group folder down), by id: each folder with a
    tasks.toml."""
    if workdir is None:
        return set()
    root = Path(workdir) / "plans"
    try:
        found = [*root.glob("*/tasks.toml"), *root.glob("*/*/tasks.toml")]
    except OSError:
        return set()
    return {path.parent.name for path in found if re.match(r"^[A-Za-z0-9][\w.-]{0,119}$", path.parent.name)}


def written_at(workdir: Path | None, plan_id: str) -> float:
    """When a plan was last written (its tasks.toml's mtime, so a hand edit counts); 0 without one."""
    path = _plan_file(workdir, plan_id)
    try:
        return path.stat().st_mtime if path is not None else 0.0
    except OSError:
        return 0.0


def plan_commands(workdir: Path | None, plan_id: str) -> list[str] | None:
    """Every verify command a plan runs (its tasks' and its own), from its tasks.toml in the workspace; None
    without one."""
    path = _plan_file(workdir, plan_id)
    try:
        with path.open("rb") as handle:  # type: ignore[union-attr]
            data = tomllib.loads(handle.read(PLAN_BYTES).decode("utf-8", errors="replace"))
    except (AttributeError, OSError, tomllib.TOMLDecodeError):
        return None
    steps = [*((data.get("meta") or {}).get("verify") or [])]
    for task in data.get("task") or []:
        if isinstance(task, dict):
            steps += task.get("verify") or []
    return [
        str(step["command"])
        for step in steps
        if isinstance(step, dict) and isinstance(step.get("command"), str)
    ]


def spec_runs(step: str, commands: set[str]) -> set[str]:
    """The spec commands one verify step runs: the step itself when it is exactly one of them, or each of them
    when it is exactly a ` && ` join of them (a spec command may hold ` && ` itself: phase 5's
    `tools/render-demos.sh && tools/spec.sh 5 demos`). None when anything else is in it: a guard in front
    (`grep -q 'AllocationCounter' core/src/engine.cpp && …`, which can fail correct work), a changed filter or
    another runner is not the spec's check (phase 2's plan -3)."""
    parts = step.split(" && ")
    longest = max((command.count(" && ") + 1 for command in commands), default=1)
    pieces = {
        (start, end): joined
        for start in range(len(parts))
        for end in range(start + 1, min(start + longest, len(parts)) + 1)
        if (joined := " && ".join(parts[start:end]).strip()) in commands
    }
    # Where a join of spec commands can reach from the step's start, and where one can go on to its end.
    starts, ends = {0}, {len(parts)}
    for start, end in sorted(pieces):
        if start in starts:
            starts.add(end)
    for start, end in sorted(pieces, reverse=True):
        if end in ends:
            ends.add(start)
    if len(parts) not in starts:
        return set()
    return {joined for (start, end), joined in pieces.items() if start in starts and end in ends}


def coverage(workdir: Path | None, spec: str | None, plan_id: str) -> dict[str, Any] | None:
    """How much of its phase's spec a plan checks: the spec's acceptance checks its verify steps run exactly,
    and the ones they miss (hermes-pilot P-25: both P2 plans ran cargo in a C++ repo). None without both."""
    checks = spec_checks(workdir, spec)
    lines = plan_commands(workdir, plan_id) if checks else None
    if not checks or lines is None:
        return None
    commands = {command for _, command in checks}
    ran = {command for line in lines for command in spec_runs(line, commands)}
    missing = [ident for ident, command in checks if command not in ran]
    return {"total": len(checks), "covered": len(checks) - len(missing), "missing": missing[:MISSING_LISTED]}


def _when(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        when = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return when if when.tzinfo else when.replace(tzinfo=UTC)


def _wall_ms(run: dict[str, Any], now: datetime) -> int | None:
    """A run's own time: its start to its end, or, for a run resumed under its own id, its invocations' spans
    together, never the hours between them (P-58)."""
    if isinstance(run.get("active_ms"), int) and run.get("state") in TERMINAL_STATES:
        return int(run["active_ms"])
    started = _when(run.get("started_at"))
    ended = _when(run.get("finished_at")) or (now if run.get("state") not in TERMINAL_STATES else None)
    if started is None or ended is None or ended < started:
        return None
    return int((ended - started).total_seconds() * 1000)


def _cost(runs: list[dict[str, Any]]) -> float | None:
    costs = [float(run["cost_usd"]) for run in runs if isinstance(run.get("cost_usd"), (int, float))]
    return round(sum(costs), 6) if costs else None


def _phase_state(
    runs: list[dict[str, Any]], writing: list[dict[str, Any]], plan: dict[str, Any] | None, spec: bool
) -> tuple[str, str | None]:
    """Where a phase stands, and the state of its latest run when that says more ("failed")."""
    going = [run for run in runs if run.get("state") not in TERMINAL_STATES]
    if going:
        return ("queued" if all(run.get("state") == "queued" for run in going) else "running"), None
    if any(run.get("state") not in TERMINAL_STATES for run in writing):
        return "writing", None
    if runs:
        latest = str(runs[0].get("state") or "")
        if latest == "succeeded":
            return "passed", None
        if latest == "unverified":
            return "unverified", None
        return "stopped", _STOPPED.get(latest, latest or None)
    if plan is not None:
        total, done = plan.get("task_count"), plan.get("tasks_done")
        if isinstance(total, int) and total > 0 and done == total:
            return "passed", None  # roko's own word: run outside Hermes
        return "written", None
    return ("specified", None) if spec else ("written", None)


def build_view(rt: Runtime) -> dict[str, Any]:
    """`GET /build`: the project's phases in order and the build's totals (docs/ui-api.md)."""
    settings = rt.settings()
    specs = spec_phases(settings.workdir)
    client = None
    try:
        client = rt.client(settings)
        plans = [row for row in tools.plan_list(client) if not row.get("demo")]
        reachable = True
    except RokoError as exc:
        logger.debug("roko: no plan list for the build: %s", exc)
        plans, reachable = [], False
    phases: dict[int | float, dict[str, Any]] = {
        n: {"n": n, "name": spec["name"], "goal": spec["goal"], "spec": spec["spec"], "plans": []}
        for n, spec in specs.items()
    }
    known = frozenset(specs)
    # The build's plans, by exact id: roko's list (it reads plans/), and the folder's own while roko is down.
    scope = {str(row.get("id")) for row in plans if row.get("id")} | plans_present(settings.workdir)
    for row in plans:
        found = plan_phase(str(row.get("id") or ""), row.get("title"), known)
        if found is not None and (found[0] in phases or len(phases) < MAX_PHASES):
            phase = phases.setdefault(
                found[0],
                {"n": found[0], "name": clean(found[1], 80, one_line=True), "goal": None, "spec": None},
            )
            phase.setdefault("plans", []).append(row)
    logged = [run for run in rt.runs.recent(200) if run.get("kind") in ("plan", "plan_generate")]
    # The money is roko's own ledger, by plan id (the run log's sums when the plugin cannot read it).
    ledger = rt.cards.ledger_by_plan(settings.workdir)
    by_plan: dict[str, dict[str, float]] = (ledger or {}).get("plans") or {}
    here = str(settings.workdir) if settings.workdir is not None else None
    default = rt.root.settings().workdir
    mine = [run for run in logged if views.in_project(run, here, default)]
    now = datetime.now(UTC)
    out: list[dict[str, Any]] = []
    # For the build's receipt: every phase's runs (and what roko's ledger says they cost), and the passing run
    # of each phase that passed.
    every: list[dict[str, Any]] = []
    passing: list[dict[str, Any]] = []
    run_spend = 0.0
    # Plan writings whose roko count the run log does not hold yet: the page opens them, one at a time.
    unread_writings: list[str] = []
    shot_lookups = [0]
    # Wow 2's points: each built phase's spend, its verified tasks, and its runs' first tries.
    points: list[dict[str, Any]] = []
    for n in sorted(phases):
        phase = phases[n]
        candidates: list[dict[str, Any]] = phase.pop("plans", [])
        # Its plans: roko's, and those its runs name (the run log places them while roko is down).
        ids = {str(row.get("id")) for row in candidates} | {
            str(run["plan_id"])
            for run in mine
            if run.get("kind") == "plan"
            and str(run.get("plan_id") or "") in scope
            and _phase_of(run, known) == n
        }
        runs = [run for run in mine if run.get("kind") == "plan" and run.get("plan_id") in ids]
        # Its plan writings: those of its plans, and one still writing (no plan in plans/ yet) by its spec or
        # its title.
        writing = [
            run
            for run in mine
            if run.get("kind") == "plan_generate"
            and (
                run.get("plan_id") in ids
                or (
                    (run.get("state") not in TERMINAL_STATES or not run.get("plan_id"))
                    and _phase_of(run, known) == n
                )
            )
        ]
        runs.sort(key=lambda run: str(run.get("started_at") or ""), reverse=True)
        if reachable:
            _backfill_ends(rt, client, runs)
        # Its plans by id, for the money: roko's, its runs', and its plan writings' that are in the build.
        spent_on = ids | {str(run["plan_id"]) for run in writing if str(run.get("plan_id") or "") in scope}
        covers = {
            str(row.get("id")): coverage(settings.workdir, phase["spec"], str(row.get("id") or ""))
            for row in candidates
        }
        written = {
            str(row.get("id")): written_at(settings.workdir, str(row.get("id") or "")) for row in candidates
        }
        plan = _chosen(candidates, runs, n, covers, written)
        plan_id = str(plan["id"]) if plan else (str(runs[0]["plan_id"]) if runs else None)
        # roko's own count of the spec's checks the plan keeps, from its newest plan writing that ended.
        roko_cover = _roko_cover(writing, plan_id, unread_writings, settings.workdir)
        # P-44: a plan written after the phase's latest run and never run is what the phase runs next.
        fresh = _fresh(candidates, runs, written)
        fresh_id = str(fresh["id"]) if fresh else None
        mine_cover = covers.get(plan_id) if plan_id else None
        # They agree when they miss as many checks: roko may lift one more from the spec than its table holds.
        agrees = (
            roko_cover["total"] - roko_cover["kept"] == mine_cover["total"] - mine_cover["covered"]
            if roko_cover is not None and mine_cover is not None
            else None
        )
        state, ended = _phase_state(runs, writing, plan, phase["spec"] is not None)
        if state == "stopped" and plan_id and artifacts.landed(settings.workdir, PLAN_PREFIX + plan_id):
            # P-50: its plan's branch is on the project's trunk, merged by hand (Undertow's plan B): the phase
            # is built, and how its run ended says why roko did not deliver it.
            state, ended = "merged", f"run {ended}" if ended else None
        every += runs
        won = next((run for run in runs if run.get("state") == "succeeded"), None)
        if state == "merged" and runs:
            won = runs[0]  # its run's tries are the work on the trunk: the receipt counts them
        if state in ("passed", "merged") and won is not None:
            passing.append(won)
        shot = _shot(rt, won, shot_lookups) if state == "passed" and won is not None and reachable else None
        latest = runs[0] if runs else None
        progress = latest.get("progress") if latest and isinstance(latest.get("progress"), dict) else None
        # roko's plan row (`tasks_done` holds across a resume), or what the latest run passed if more.
        total = plan.get("task_count") if plan else None
        done = plan.get("tasks_done") if plan else None
        ran = (progress or {}).get("passed") if latest and latest.get("plan_id") == plan_id else None
        if not isinstance(total, int) or total <= 0:
            total, done = (progress or {}).get("total"), ran
        elif isinstance(ran, int):
            done = min(total, max(ran, done if isinstance(done, int) else 0))
        walls = [ms for ms in (_wall_ms(run, now) for run in runs) if ms is not None]
        if ledger is not None:
            spent = [by_plan[pid] for pid in sorted(spent_on) if pid in by_plan]
            phase_runs = sum(row["runs"] for row in spent)
            phase_writing = sum(row["writing"] for row in spent)
            run_spend += phase_runs
            cost: float | None = round(phase_runs + phase_writing, 6) if spent else None
            writing_cost: float | None = round(phase_writing, 6) if spent else None
        else:
            cost, writing_cost = _cost(runs + writing), _cost(writing)
        if state in ("passed", "merged"):
            learned = [run["learning"] for run in runs if isinstance(run.get("learning"), dict)]
            points.append(
                {
                    "code": f"P{n:g}",
                    "cost_usd": cost,
                    "verified": int(done or 0) if isinstance(total, int) and total else 0,
                    "first": sum(int(one.get("first_try") or 0) for one in learned),
                    "tried": sum(int(one.get("tasks") or 0) for one in learned),
                }
            )
        out.append(
            {
                **phase,
                "plan_id": plan_id,
                "title": plan.get("title") if plan else None,
                "state": state,
                "ended": ended,
                "coverage": mine_cover,
                # roko's own count (bug-72dc0d); the plugin's count above is its cross-check.
                "roko_coverage": roko_cover,
                "coverage_agrees": agrees,
                # P-33: how many plans the phase has, and whether the one it names is the newest of them.
                "plans": len(candidates),
                "newest": plan_id is not None
                and written.get(plan_id, 0.0) >= max(written.values(), default=0.0),
                "fresh": {
                    "plan_id": fresh_id,
                    "coverage": covers.get(fresh_id),
                    "roko_coverage": _roko_cover(writing, fresh_id, unread_writings, settings.workdir),
                    "newest": written.get(fresh_id, 0.0) >= max(written.values(), default=0.0),
                }
                if fresh_id
                else None,
                "tasks": {"passed": int(done or 0), "total": int(total)}
                if isinstance(total, int) and total
                else None,
                "runs": len(runs),
                "run_id": latest.get("run_id") if latest else None,
                "writing_id": writing[0].get("run_id") if writing else None,
                "cost_usd": cost,
                "writing_usd": writing_cost,
                "wall_ms": sum(walls) if walls else None,
                "rungs": latest.get("rungs") if latest and isinstance(latest.get("rungs"), list) else None,
                # Its passing run's first UI shot, for the pad's thumbnail (phase 4 prep C).
                "shot": shot,
                # Its latest run's tasks that ran out of rungs: roko says split or replan them.
                "exhausted": latest["exhausted"]
                if latest and isinstance(latest.get("exhausted"), list)
                else [],
                # Its latest run, refused because every rung is skipped (P-52): what a resume would do.
                "all_skipped": latest["all_skipped"]
                if latest and isinstance(latest.get("all_skipped"), dict)
                else None,
            }
        )
    return {
        "project": views.project_ref(rt, {"project": here} if here else None),
        "reachable": reachable,
        "phases": out,
        "totals": _totals(out, ledger, scope),
        "receipt": _receipt(every, passing, run_spend if ledger is not None else None, len(out)),
        # The lead's wow 3: the landed work on the ladder, in one line, from roko's records of those runs.
        "ladder_line": ladder_line(passing),
        "chart": build_chart(points),
        "next": _next(out),
        "unread_writings": unread_writings,
    }


def _chosen(
    candidates: list[dict[str, Any]],
    runs: list[dict[str, Any]],
    n: int | float,
    covers: dict[str, dict[str, Any] | None],
    written: dict[str, float] | None = None,
) -> dict[str, Any] | None:
    """A phase's plan: the one its latest run ran; else the one that runs the most of its spec's checks, then
    the newest (hermes-pilot P-33), then the one named `p<n>-…`, then roko's order."""
    if runs:
        for row in candidates:
            if row.get("id") == runs[0].get("plan_id"):
                return row

    def rank(item: tuple[int, dict[str, Any]]) -> tuple[int, float, int, int]:
        place, row = item
        covered = (covers.get(str(row.get("id"))) or {}).get("covered", -1)
        when = (written or {}).get(str(row.get("id")), 0.0)
        named = str(row.get("id") or "").startswith(f"p{str(n).replace('.', '-')}-")  # p2-…, p2-1-… for 2.1
        return (-int(covered), -when, 0 if named else 1, place)

    ranked = sorted(enumerate(candidates), key=rank)
    return ranked[0][1] if ranked else None


def _fresh(
    candidates: list[dict[str, Any]], runs: list[dict[str, Any]], written: dict[str, float]
) -> dict[str, Any] | None:
    """The newest of a phase's plans written after its latest run started and never run (no run in the run
    log, no task done in roko's row): the answer to a run that stopped, which NEXT runs fresh rather than
    resume the plan that stopped (hermes-pilot P-44). None without one."""
    started = _when(runs[0].get("started_at")) if runs else None
    if started is None:
        return None
    ran = {str(run.get("plan_id")) for run in runs}
    after = [
        row
        for row in candidates
        if str(row.get("id")) not in ran
        and not row.get("tasks_done")
        and written.get(str(row.get("id")), 0.0) > started.timestamp()
    ]
    return max(after, key=lambda row: written.get(str(row.get("id")), 0.0), default=None)


def _roko_cover(
    writing: list[dict[str, Any]], plan_id: str | None, unread: list[str], workdir: Path | None
) -> dict[str, Any] | None:
    """roko's own count of the spec's checks plan `plan_id` keeps, from its newest plan writing that ended; a
    writing whose count the run log lacks goes on `unread`, for the page to open. None once the plan's
    tasks.toml was written after the plugin learned the count (a hand edit, the pilot's P4.3): the plugin's
    own count then goes alone."""
    wrote = sorted(
        (run for run in writing if run.get("plan_id") == plan_id and run.get("state") in TERMINAL_STATES),
        key=lambda run: str(run.get("started_at") or ""),
        reverse=True,
    )
    kept = wrote[0].get("source_checks") if wrote else None
    if isinstance(kept, dict):
        learned = _when(wrote[0].get("source_checks_at"))
        if (
            learned is not None
            and plan_id
            and written_at(workdir, plan_id) > learned.timestamp() + EDITED_SLACK_S
        ):
            return None
        return {**kept, "writing_id": wrote[0]["run_id"]}
    if wrote and len(unread) < UNREAD_LISTED and str(wrote[0]["run_id"]) not in unread:
        unread.append(str(wrote[0]["run_id"]))
    return None


def _shot(rt: Runtime, run: dict[str, Any], lookups: list[int]) -> dict[str, Any] | None:
    """A passed phase's first UI shot (phase 4 prep C): `{run_id, path, bytes}`, looked for once a run in its
    delivered work (no bytes read) and kept in the run log; at most END_LOOKUPS looked for a build."""
    run_id = str(run["run_id"])
    if not isinstance(run.get("shot"), dict):
        if lookups[0] >= END_LOOKUPS:
            return None
        lookups[0] += 1
        try:
            found = artifacts.run_shot(rt, run_id)
        except RokoError as exc:
            if exc.code is not Code.NOT_FOUND:
                return None  # roko is down: looked for again on a later look
            found = None  # roko forgot the run
        run["shot"] = found or {}
        rt.runs.update(run_id, shot=run["shot"])
    return {"run_id": run_id, **run["shot"]} if run["shot"] else None


def _backfill_ends(rt: Runtime, client: Any, runs: list[dict[str, Any]]) -> None:
    """An ended run's end from roko's summary, when the run log has none (a resume's card may have none): a
    phase's time adds up all its runs (hermes-pilot P-44: P3 left out its resume's 4 min 42 s). Also, once,
    for an end past the start of the run that resumed it, which is that run's: the plugin took the first run's
    manifest's close for its own before P-58. Asked once a run."""
    resumed_at = {
        str(run["resumes"]): _when(run.get("started_at"))
        for run in runs
        if isinstance(run.get("resumes"), str)
    }

    def overrun(run: dict[str, Any]) -> bool:
        later, ended = resumed_at.get(str(run.get("run_id"))), _when(run.get("finished_at"))
        return later is not None and ended is not None and ended > later and not run.get("own_end_checked")

    lacking = [
        run
        for run in runs
        if run.get("state") in TERMINAL_STATES
        and ((not run.get("finished_at") and not run.get("end_checked")) or overrun(run))
    ]
    for run in lacking[:END_LOOKUPS]:
        own = views.run_client(rt, client, run)
        if own is None:
            continue  # its serve is down: asked again on a later look
        try:
            end = rundata.run_end(rundata.run_status(own, str(run["run_id"])))
        except RokoError as exc:
            if exc.code is not Code.NOT_FOUND:
                continue
            end = None  # roko forgot it
        fields: dict[str, Any] = {"end_checked": True, **({"finished_at": end} if end else {})}
        if overrun(run):
            fields["own_end_checked"] = True
        run.update(fields)
        rt.runs.update(str(run["run_id"]), **fields)


def _phase_of(run: dict[str, Any], known: frozenset[int | float] = frozenset()) -> int | float | None:
    """The phase a logged plan writing is for: the phase spec it was written from (P-6), else the plan it
    names or its label."""
    n = specfile.phase(run.get("spec_path"))
    found = plan_phase(str(run.get("plan_id") or ""), run.get("label"), known) if n is None else (n, "")
    return found[0] if found else None


def _totals(phases: list[dict[str, Any]], ledger: dict[str, Any] | None, scope: set[str]) -> dict[str, Any]:
    """The build's totals. With roko's ledger, what it spent is what the ledger has for the build's plans
    (P-24), with what its phases' plan writing took and what a plan of the build outside the phases spent; and
    apart, what roko spent on plans outside the build (`elsewhere_usd`: an earlier build's, a deleted plan's),
    so the three add up to roko's whole."""
    tasks = [phase["tasks"] for phase in phases if phase["tasks"]]
    costs = [phase["cost_usd"] for phase in phases if phase["cost_usd"] is not None]
    writing = [phase["writing_usd"] for phase in phases if phase.get("writing_usd") is not None]
    walls = [phase["wall_ms"] for phase in phases if phase["wall_ms"] is not None]
    in_phases = round(sum(costs), 6) if costs else None
    by_plan: dict[str, dict[str, float]] = (ledger or {}).get("plans") or {}
    whole = (
        sum(row["runs"] + row["writing"] for pid, row in by_plan.items() if pid in scope)
        if ledger is not None
        else in_phases
    )
    elsewhere = (
        round(max(0.0, float(ledger["total"]) - whole), 6)
        if ledger is not None and whole is not None
        else None
    )
    return {
        "phases": len(phases),
        "passed": sum(1 for phase in phases if phase["state"] in ("passed", "merged")),
        "tasks_passed": sum(task["passed"] for task in tasks),
        "tasks_total": sum(task["total"] for task in tasks),
        "runs": sum(phase["runs"] for phase in phases),
        "cost_usd": round(whole, 6) if whole is not None else None,
        "writing_usd": round(sum(writing), 6) if writing else None,
        "outside_usd": round(max(0.0, whole - (in_phases or 0.0)), 6)
        if ledger is not None and whole
        else None,
        "elsewhere_usd": elsewhere or None,
        "cost_source": "ledger" if ledger is not None else "runs",
        "wall_ms": sum(walls) if walls else None,
    }


def _receipt(
    every: list[dict[str, Any]], passing: list[dict[str, Any]], ledger_runs: float | None, phases: int
) -> dict[str, Any] | None:
    """The build so far on the ladder's top rung, against all roko spent on it. The top-rung side is each
    passed phase's passing run's receipt (each task once, its passing try at the top rung's list prices; a
    run that resumed another counts only what it ran, so it errs low), as the run log kept it when that run's
    whole card was read. The spend side is every run of every phase, failed and cancelled ones included: what
    did not pass counts against roko. `unread` names the passing runs whose receipt the log does not hold yet
    (opening a run reads it), `missing` counts them."""
    if not passing:
        return None
    kept = [run["receipt"] for run in passing if isinstance(run.get("receipt"), dict)]
    unread = [str(run.get("run_id")) for run in passing if not isinstance(run.get("receipt"), dict)]
    # roko's ledger for the phases' runs (their helpers too), else the run log's costs of every run.
    spend = (
        ledger_runs
        if ledger_runs is not None
        else sum(float(run["cost_usd"]) for run in every if isinstance(run.get("cost_usd"), (int, float)))
    )
    priced = [one for one in kept if isinstance(one.get("top_rung_usd"), (int, float))]
    top = round(sum(float(one["top_rung_usd"]) for one in priced), 6) if priced else None
    models = [
        str(one["top_rung"]) for one in priced if isinstance(one.get("top_rung"), str) and one["top_rung"]
    ]
    model = max(set(models), key=models.count) if models else None
    lost = sum(1 for run in every if run.get("state") in TERMINAL_STATES and run.get("state") != "succeeded")
    going = sum(1 for run in every if run.get("state") not in TERMINAL_STATES)
    basis = (
        f"≈ each passed phase's passing tries at {model}'s list prices · roko's spend includes "
        f"{lost} run{'' if lost == 1 else 's'} that didn't pass"
        + (f" and {going} still running" if going else "")
        if model
        else None
    )
    receipt: dict[str, Any] = {
        "phases": len(kept),
        "cost_usd": round(spend, 6),
        "top_rung": model,
        "top_rung_usd": top,
        "ratio": round(top / spend, 1) if top and spend > 0 else None,
        "basis": basis,
        "runs_not_passed": lost,
        "runs_running": going,
        "missing": len(unread),
        "unread": unread[:UNREAD_LISTED],
        "not_compared": sum(int(one.get("not_compared") or 0) for one in kept),
    }
    receipt["words"] = receipt_words(receipt, phases)
    return receipt


def receipt_words(receipt: dict[str, Any], phases: int) -> str | None:
    """The build's receipt in words, as both pages show it (option 1: moved here from their
    buildReceiptWords): the phases built so far on the top rung against all roko spent on the build, "× more"
    when roko spent more, and the passing runs whose receipt is still to read. None before there is either."""
    missing = int(receipt.get("missing") or 0)
    runs = f"{missing} run{'' if missing == 1 else 's'}"
    ratio, model = receipt.get("ratio"), receipt.get("top_rung")
    if isinstance(ratio, (int, float)) and ratio > 0 and model:
        built = int(receipt.get("phases") or 0)
        what = (
            "the whole build" if built == phases else f"{built} phase{'' if built == 1 else 's'} built so far"
        )
        than = f"{ratio:g}× less" if ratio >= 1 else f"{1 / ratio:.1f}× more"
        left = f" · {runs} still to read" if missing else ""
        return (
            f"{what} on {model} ≈ {rundata.fmt_money(receipt.get('top_rung_usd'))} · roko spent "
            f"{rundata.fmt_money(receipt.get('cost_usd'))}: {than}{left}"
        )
    return f"reading {runs} for the build's receipt…" if missing else None


def ladder_line(passing: list[dict[str, Any]]) -> str | None:
    """The build's ladder in one line, from roko's own records of the runs whose work landed (each passed
    phase's passing run, a phase merged by hand's last): its tasks by the rung they passed on (each run's
    `rungs`), how many passed on their first try, and the climbs (its `learning`). Says only what it counts.
    None without such a run, or a rung that passed a task."""
    order: list[str] = []
    passed: dict[str, int] = {}
    first = climbs = 0
    for run in passing:
        for row in run.get("rungs") or []:
            if not isinstance(row, dict) or not row.get("rung"):
                continue
            name = str(row["rung"])
            if name not in order:
                order.append(name)
            count = row.get("passed")
            passed[name] = passed.get(name, 0) + (int(count) if isinstance(count, int) and count > 0 else 0)
        learned: dict[str, Any] = run["learning"] if isinstance(run.get("learning"), dict) else {}
        first += int(learned.get("first_try") or 0) if isinstance(learned.get("first_try"), int) else 0
        climbs += int(learned.get("climbs") or 0) if isinstance(learned.get("climbs"), int) else 0
    total = sum(passed.values())
    if not total:
        return None
    rungs = ", ".join(f"{name} {passed[name]}" for name in order if passed.get(name))
    climbed = f"{climbs} climb{'' if climbs == 1 else 's'}"
    first_try = f"{min(first, total)} of {total} passed on the first try"
    return f"landed work by the rung it passed on: {rungs} · {first_try} · {climbed}"


def build_chart(points: list[dict[str, Any]]) -> list[dict[str, Any]] | None:
    """The lead's wow 2: two plain series by built phase, from roko's records, with no trend claimed in
    words. Cost per verified task is a phase's whole spend as its pad has it (failed runs and plan writing
    too) over the tasks roko verified; the first-try rate pools all its runs' tries, failed runs too, as the
    Learning tab counts them (`learning`: tasks whose first try passed, of those tried). A series needs two
    phases; None without one."""
    costs = [
        (one["code"], one["cost_usd"] / one["verified"])
        for one in points
        if isinstance(one.get("cost_usd"), (int, float)) and one["verified"] > 0
    ]
    firsts = [(one["code"], one["first"], one["tried"]) for one in points if one["tried"] > 0]
    series = []
    if len(costs) > 1:
        values = [round(value, 6) for _, value in costs]
        series.append(
            {
                "label": "cost per verified task, by phase",
                "values": values,
                "range": f"{rundata.fmt_money(min(values))} to {rundata.fmt_money(max(values))}",
                "words": "each phase's whole spend, failed runs and plan writing too, over the tasks roko "
                "verified: " + " · ".join(f"{code} {rundata.fmt_money(value)}" for code, value in costs),
                "tone": "bone",
            }
        )
    if len(firsts) > 1:
        rates = [round(first / tried, 4) for _, first, tried in firsts]
        series.append(
            {
                "label": "first-try rate, by phase",
                "values": rates,
                "range": f"{round(min(rates) * 100)}% to {round(max(rates) * 100)}%",
                "words": "of the tasks each phase's runs tried, failed runs too, those whose first try "
                "passed: " + " · ".join(f"{code} {first} of {tried}" for code, first, tried in firsts),
                "tone": "pass",
            }
        )
    return series or None


def refused_words(phase: dict[str, Any]) -> str:
    """NEXT's words for a phase whose latest run roko refused because every rung is skipped (P-52, roko
    gap-b856d3): recharge and resume when every rung failed on billing; else a resume now is refused again,
    until the first probe verdict lapses or its model's entry leaves roko's probe file."""
    refused, code = phase["all_skipped"], f"P{phase['n']:g}"
    if refused.get("billing_only") is True:
        return (
            f"{code}'s run was refused: every rung was skipped because its provider could not bill: recharge "
            f"{refused.get('providers') or 'the provider'}, then resume it"
        )
    if refused.get("billing_only") is False:
        lapse = refused.get("lapse_ms")
        when = f" (the first at {time.strftime('%H:%M', time.localtime(lapse / 1000))})" if lapse else ""
        return (
            f"{code}'s run was refused: every rung is skipped, and a resume now is refused again until "
            f"roko's probe verdict lapses{when} or its model's entry leaves .roko/learn/rung-probes.json"
        )
    return (
        f"{code}'s run was refused: every rung is skipped; after the provider is recharged, a resume probes "
        "its rung again"
    )


def _next(phases: list[dict[str, Any]]) -> dict[str, Any] | None:
    """What the build waits on: the first phase that has not passed, and what moves it. A plan that misses any
    of its spec's checks is never offered to run or resume: it is written again (hermes-pilot P-25)."""
    for phase in phases:
        state = phase["state"]
        if state in ("passed", "merged", "unverified"):
            continue
        if state in ("running", "queued", "writing"):
            return {"n": phase["n"], "do": "wait", "run_id": phase["run_id"] or phase["writing_id"]}
        fresh = phase.get("fresh") if state == "stopped" else None
        if fresh:  # P-44: the plan written after its run stopped, never run, is what moves the phase
            phase = {**phase, **fresh, "state": "written"}
            state = "written"
        cover = phase.get("coverage")
        counts = {"covered": cover["covered"], "total": cover["total"]} if cover else {}
        roko = phase.get("roko_coverage")
        if roko is not None:
            counts = {**counts, "roko_kept": roko["kept"], "roko_total": roko["total"]}
        # Never offered to run while either count says a check is not kept: roko's own, or the plugin's.
        short = bool(cover and cover["covered"] < cover["total"])
        short = short or bool(roko and roko["kept"] < roko["total"])
        # P-33: with several plans for a phase, how many, and whether the one named is the newest.
        if phase.get("plans", 0) > 1:
            counts = {**counts, "plans": phase["plans"], "newest": phase["newest"]}
        if state in ("stopped", "written") and short:
            return {
                "n": phase["n"],
                "do": "rewrite",
                "plan_id": phase["plan_id"],
                "spec": phase["spec"],
                **counts,
                "missing": cover["missing"] if cover else [],
            }
        if state == "stopped":
            return {
                "n": phase["n"],
                "do": "resume",
                "plan_id": phase["plan_id"],
                "run_id": phase["run_id"],
                **counts,
                **({"exhausted": phase["exhausted"]} if phase.get("exhausted") else {}),
                # P-52: a run roko refused with every rung skipped; the page shows these words as they are.
                **({"words": refused_words(phase)} if phase.get("all_skipped") else {}),
            }
        if state == "written":
            return {"n": phase["n"], "do": "run", "plan_id": phase["plan_id"], **counts}
        return {"n": phase["n"], "do": "write", "spec": phase["spec"]}
    return None

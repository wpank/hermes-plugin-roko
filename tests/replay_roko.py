"""A roko serve that replays real runs, for building and showing the UIs without spending anything.

    python tests/replay_roko.py [--port 6720] [--speed 6] [--seed HERMES_HOME] [--workdir DIR]

It serves everything `FakeRoko` serves (the REST routes and `/mcp` tools the plugin uses), and its runs
are the runs recorded in the Hermes dogfood (tests/fixtures/dogfood_runs.json): their event indexes are
revealed over time, `--speed` times faster than they happened, with each row's time moved to now, so a
UI sees a run move exactly as it did.

At start it has, already ended: the five-task plan that passed (with its diff), the same plan cancelled
half way, the plan failing on a check whose command was missing, and a prompt run. One more replay of the
five-task plan is running. Asking it for work starts a replay too: `run_prompt` replays the prompt run
(or the sign-off run when the prompt mentions a report), `plan_run` replays the five-task plan, and
`plan_generate` writes a copy of that plan. The sign-off run stops at its confirm rung and waits for an
answer through `confirm_pending` / `confirm_answer`, as roko does.

`--seed HERMES_HOME` writes the runs into that Hermes home's roko run log, so the plugin lists them.
`--workdir DIR` makes DIR a git checkout holding each finished replay's batch branch, so Merge works.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

from fake_roko import TERMINAL, FakeRoko, Run, tool_error, tool_ok

FIXTURES = json.loads((Path(__file__).parent / "fixtures" / "dogfood_runs.json").read_text())
PLAN_RUN = "multiwave_plan_run"
LABELS = {
    "multiwave_plan_run": "Add per-category budgets to tally",
    "cancelled_plan_run": "Add per-category budgets to tally (cancelled)",
    "failed_run": "Add per-category budgets to tally (first try)",
    "prompt_run": "Add a --json flag to tally",
    "confirm_run": "Write REPORT.md on the ledger API",
}


@dataclass
class Replay(Run):
    """A recorded run revealed over time."""

    fixture: str = ""
    rows: list[dict[str, Any]] = field(default_factory=list)
    final: dict[str, Any] = field(default_factory=dict)
    speed: float = 6.0
    # Seconds of the recording already shown when the replay was made (a finished run starts at its end).
    head_start_s: float = 0.0
    # Where a confirm rung holds the run (recording seconds), and whether the person answered.
    hold_at_s: float | None = None
    answered: bool = False
    paused_at: float | None = None
    paused_total: float = 0.0
    cancelled_at_s: float | None = None
    cancelled_ms: int = 0
    # The recording's own plan id, which a replay of a copied plan renames.
    recorded_plan: str | None = None
    t0: int = 0
    span_s: float = 0.0
    wall_start: datetime = field(default_factory=lambda: datetime.now(UTC))

    def __post_init__(self) -> None:
        stamps = [row["ts_millis"] for row in self.rows if isinstance(row.get("ts_millis"), int)]
        self.t0 = min(stamps) if stamps else 0
        self.span_s = ((max(stamps) - self.t0) / 1000) if stamps else 0.0

    def clock_s(self) -> float:
        """How far into the recording the replay is, in recording seconds."""
        paused = self.paused_total + ((time.monotonic() - self.paused_at) if self.paused_at else 0.0)
        at = self.head_start_s + (time.monotonic() - self.started - paused) * self.speed
        if self.hold_at_s is not None and not self.answered and at >= self.hold_at_s:
            if self.paused_at is None:
                self.paused_at = time.monotonic()
            return self.hold_at_s
        if self.cancelled_at_s is not None:
            return min(at, self.cancelled_at_s)
        return at

    def waiting(self) -> bool:
        return self.hold_at_s is not None and not self.answered and self.clock_s() >= self.hold_at_s

    def answer(self) -> None:
        if self.paused_at is not None:
            self.paused_total += time.monotonic() - self.paused_at
            self.paused_at = None
        self.answered = True

    def current(self) -> str:
        if self.cancelled_at_s is not None:
            return "cancelled"
        return str(self.final.get("state") or "succeeded") if self.clock_s() >= self.span_s else "running"

    def advance(self) -> str:
        self.reported = self.current()
        return self.reported

    def shift(self, ts: int) -> int:
        """A recorded time as replay time: the run started at `wall_start`, sped up."""
        start = self.wall_start.timestamp() * 1000 - self.head_start_s * 1000 / self.speed
        return int(start + (ts - self.t0) / self.speed)

    def index(self) -> list[dict[str, Any]] | None:
        cut = self.t0 + self.clock_s() * 1000
        hold_ms = self.t0 + self.hold_at_s * 1000 if self.hold_at_s is not None else None
        out = []
        started: list[tuple[str, str]] = []
        ended: set[tuple[str, str]] = set()
        for row in self.rows:
            ts = row.get("ts_millis")
            if isinstance(ts, int) and ts > cut:
                break
            event = copy.deepcopy(row)
            event["run_id"] = self.run_id
            self._rename(event)
            if isinstance(ts, int):
                # Rows after a confirm hold happened once the person answered.
                late = self.paused_total * 1000 if hold_ms is not None and ts > hold_ms else 0
                event["ts_millis"] = self.shift(ts) + int(late)
            if event.get("type") == "run_completed" and isinstance(event.get("duration_ms"), int):
                event["duration_ms"] = int(event["duration_ms"] / self.speed)
            key = (str(event.get("plan_id")), str(event.get("task_id")))
            if event.get("type") == "task_started":
                started.append(key)
            elif event.get("type") in ("task_completed", "task_blocked"):
                ended.add(key)
            out.append(event)
        if self.cancelled_at_s is not None:
            # What roko writes when a plan run stops: the running tasks end, the rest never start.
            at = self.cancelled_ms
            for plan_id, task_id in started:
                if (plan_id, task_id) not in ended:
                    out.append(
                        {
                            "type": "task_completed",
                            "run_id": self.run_id,
                            "plan_id": plan_id,
                            "task_id": task_id,
                            "outcome": "cancelled",
                            "ts_millis": at,
                        }
                    )
            out.append(
                {"type": "run_completed", "run_id": self.run_id, "outcome": "cancelled", "ts_millis": at}
            )
        return out

    def _rename(self, event: dict[str, Any]) -> None:
        """Give the recording's plan the replay's names: a prompt run's plan is named after its run."""
        own = self.final.get("run_id")
        names = {own: self.run_id} if self.kind == "run" else {}
        if self.recorded_plan and self.plan_id and self.recorded_plan != self.plan_id:
            names[self.recorded_plan] = self.plan_id
        if event.get("plan_id") in names:
            event["plan_id"] = names[event["plan_id"]]
        for plan in event.get("plans") or []:
            if isinstance(plan, dict) and plan.get("plan_id") in names:
                plan["plan_id"] = names[plan["plan_id"]]
                plan["title"] = plan["plan_id"]

    def bundle(self) -> dict[str, Any]:
        state = self.current()
        ended = state in TERMINAL
        started = datetime.fromtimestamp(self.shift(self.t0) / 1000, UTC)
        last = datetime.fromtimestamp(self.shift(self.t0 + int(self.span_s * 1000)) / 1000, UTC)
        return {
            "manifest": {
                "run_id": self.run_id,
                "kind": "plan_run" if self.kind == "plan" else "prompt",
                "origin": self.origin,
                "plan_ids": [self.event_plan],
                "invocations": [{"inv": 1, "started_at": _iso(started)}],
                "closed": {"status": state, "ended_at": _iso(last)} if ended else None,
            },
            "files": [],
        }

    @property
    def event_plan(self) -> str:
        return self.plan_id if self.kind == "plan" and self.plan_id else self.run_id


class ReplayRoko(FakeRoko):
    """FakeRoko whose runs are replays."""

    speed: float = 6.0
    workdir: Path | None = None

    def replay(
        self,
        fixture: str,
        *,
        run_id: str | None = None,
        ended: bool = False,
        head_start_s: float = 0.0,
        max_usd: float | None = None,
    ) -> Replay:
        fx = FIXTURES[fixture]
        rows = [copy.deepcopy(row["event"]) for row in fx["events"]]
        plan_id = (fx.get("plan_tasks") or {}).get("plan_id")
        replay = Replay(
            run_id or str(uuid.uuid4()),
            "plan" if plan_id else "run",
            ["running"],
            plan_id=plan_id,
            max_usd=max_usd,
            origin="mcp:hermes",
            fixture=fixture,
            rows=rows,
            final=fx["summary"],
            speed=self.speed,
            recorded_plan=plan_id,
        )
        replay.head_start_s = replay.span_s + 1 if ended else head_start_s
        if fixture == "confirm_run":
            gates = [r for r in rows if r.get("type") == "gate_result"]
            replay.hold_at_s = ((gates[0]["ts_millis"] - replay.t0) / 1000 - 0.5) if gates else None
        self.runs[replay.run_id] = replay
        if plan_id and plan_id not in self.plans:
            self.plans[plan_id] = {
                "title": "Per-category budgets for tally",
                "tasks": fx["plan_tasks"]["tasks"],
                "status": "ready",
            }
        if self.workdir is not None and fixture in (PLAN_RUN, "prompt_run", "confirm_run"):
            base = _deliver(self.workdir, replay.run_id, fixture)
            if self.diffs is not None:
                self.diffs[replay.run_id] = _diff_body(self.workdir, base, f"roko/batch/{replay.run_id}")
        elif fixture == PLAN_RUN and self.diffs is not None:
            self.diffs[replay.run_id] = {k: v for k, v in fx["diff"].items() if k != "run_id"}
        return replay

    # -- what a replay answers --------------------------------------------------

    def _tool_run_status(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run = self.runs.get(str(args.get("run_id")))
        if not isinstance(run, Replay):
            answer = super()._tool_run_status(args, who)
            body = answer.get("structuredContent")
            if run is not None and isinstance(body, dict) and isinstance(body.get("result"), dict):
                # The planner wrote the recorded plan's tasks, not FakeRoko's one.
                body["result"]["task_count"] = len(self.plans.get(run.plan_id or "", {}).get("tasks", []))
                answer["content"] = [{"type": "text", "text": json.dumps(body)}]
            return answer
        state = run.advance()
        done = state in TERMINAL
        summary = copy.deepcopy(run.final) if done else {}
        summary.update(
            {
                "run_id": run.run_id,
                "state": state,
                "verdict": state if done else None,
                "active": not done,
                "position": None,
                "cost_usd": summary.get("cost_usd", 0.0),
            }
        )
        if done and isinstance(summary.get("result"), dict):
            result = summary["result"]
            result["branch"] = f"roko/batch/{run.run_id}"
            if self.workdir is not None:
                result.update(_result(self.workdir, run.run_id) or {})
        elif not done:
            summary.pop("result", None)
            summary["milestones"] = []
        return tool_ok(summary)

    def _tool_run_prompt(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        if not isinstance(args.get("prompt"), str):
            return tool_error("missing string argument prompt")
        cap = self._cap(args)
        fixture = "confirm_run" if "report" in args["prompt"].lower() else "prompt_run"
        run = self.replay(fixture, max_usd=cap)
        return tool_ok({"run_id": run.run_id, "state": "running"})

    def _tool_plan_run(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        cap = self._cap(args)
        plan_id = str(args.get("plan_id") or "")
        if plan_id not in self.plans:
            return tool_error(f"plan '{plan_id}' not found")
        run = self.replay(PLAN_RUN, max_usd=cap)
        run.plan_id = plan_id
        return tool_ok({"run_id": run.run_id, "state": "running", "position": None})

    def _tool_plan_generate(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        prompt = args.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            return tool_error("missing string argument prompt")
        words = [w for w in "".join(c if c.isalnum() else " " for c in prompt.lower()).split() if w]
        slug = "-".join(words[:6]) or "plan"
        while slug in self.plans:
            slug += "-2"
        run = self._new_run(f"plan_generate:{slug}", plan_id=slug, who=who)
        run.timeline = [(0.0, "running"), (max(2.0, 30.0 / self.speed), "succeeded")]
        self.plans[slug] = {
            "title": prompt.strip()[:80],
            "tasks": copy.deepcopy(FIXTURES[PLAN_RUN]["plan_tasks"]["tasks"]),
            "status": "ready",
        }
        return tool_ok({"run_id": run.run_id, "plan_id": slug, "state": "running"})

    def _tool_run_cancel(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run = self.runs.get(str(args.get("run_id")))
        if not isinstance(run, Replay):
            return super()._tool_run_cancel(args, who)
        if run.current() in TERMINAL:
            return tool_error("no active execution for this plan")
        run.cancelled_at_s = run.clock_s()
        run.cancelled_ms = int(time.time() * 1000)
        return tool_ok({"run_id": run.run_id, "state": "cancelled"})

    def _tool_confirm_pending(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run = self.runs.get(str(args.get("run_id")))
        if isinstance(run, Replay) and run.waiting():
            raw = copy.deepcopy(FIXTURES["confirm_run"]["pending_raw"]["pending"][0])
            held = datetime.fromtimestamp(run.shift(run.t0 + int(run.hold_at_s * 1000)) / 1000, UTC)
            raw.update(
                {
                    "plan_id": run.run_id,
                    "attempt_key": f"{run.run_id}:{run.run_id}:T1:1",
                    "held_at": held.isoformat(),
                    "timeout_secs": 1800,
                    "deadline_at": (held + timedelta(seconds=1800)).isoformat(),
                }
            )
            return tool_ok({"pending": [raw]})
        return super()._tool_confirm_pending(args, who)

    def _tool_confirm_answer(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        run = self.runs.get(str(args.get("run_id")))
        if isinstance(run, Replay) and run.waiting():
            run.answer()
            decision = "approved" if args.get("approve") else "rejected"
            return tool_ok(
                {**{k: args.get(k) for k in ("run_id", "task_id", "attempt_key")}, "decision": decision}
            )
        return super()._tool_confirm_answer(args, who)


# -- the workspace, so Merge has something to merge ------------------------------


def _git(workdir: Path, *args: str) -> str:
    who = {"GIT_AUTHOR_NAME": "roko", "GIT_AUTHOR_EMAIL": "roko@localhost"}
    committer = {"GIT_COMMITTER_NAME": "roko", "GIT_COMMITTER_EMAIL": "roko@localhost"}
    environment = {**who, **committer, "PATH": "/usr/bin:/bin"}
    return subprocess.run(
        ["git", "-C", str(workdir), *args], check=True, capture_output=True, text=True, env=environment
    ).stdout.strip()


def init_workdir(workdir: Path) -> None:
    """A small tally project at its base commit."""
    if (workdir / ".git").exists():
        return
    workdir.mkdir(parents=True, exist_ok=True)
    _git(workdir, "init", "-q", "-b", "main")
    (workdir / "tally").mkdir(exist_ok=True)
    (workdir / "tally" / "__init__.py").write_text('"""tally: a small expense ledger."""\n')
    (workdir / "tally" / "cli.py").write_text(
        "import argparse\n\n\ndef build_parser():\n    return argparse.ArgumentParser(prog='tally')\n"
    )
    (workdir / ".gitignore").write_text(".roko/\n__pycache__/\n")
    _git(workdir, "add", "-A")
    _git(workdir, "commit", "-q", "-m", "tally: start")


def _deliver(workdir: Path, run_id: str, fixture: str) -> str:
    """What roko does once a run's checks pass: a batch branch off HEAD with the change; returns the base."""
    head = _git(workdir, "rev-parse", "HEAD")
    branch = f"roko/batch/{run_id}"
    files: dict[str, str] = {}
    if fixture == PLAN_RUN:
        for entry in FIXTURES[PLAN_RUN]["diff"]["files"]:
            added = [
                line[1:]
                for line in (entry.get("patch") or "").splitlines()
                if line.startswith("+") and not line.startswith("+++")
            ]
            files[entry["path"]] = "\n".join(added) + "\n"
    elif fixture == "confirm_run":
        report = FIXTURES["confirm_run"]["pending_raw"]["pending"][0]["summary"]
        files["REPORT.md"] = report.removeprefix("REPORT.md:\n") + "\n"
    else:
        files["tally/cli.py"] = (
            "import argparse\nimport json\n\n\ndef build_parser():\n"
            "    parser = argparse.ArgumentParser(prog='tally')\n"
            "    parser.add_argument('--json', action='store_true', help='print JSON')\n"
            "    return parser\n"
        )
    _git(workdir, "checkout", "-q", "-b", branch, head)
    try:
        for path, text in files.items():
            target = workdir / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        _git(workdir, "add", "-A")
        # The checkout may already have this change (an earlier replay was merged): commit anyway.
        _git(workdir, "commit", "-q", "--allow-empty", "-m", f"roko run {run_id[:8]}: verified work")
    finally:
        _git(workdir, "checkout", "-q", "main")
    return head


def _diff_body(workdir: Path, base: str, branch: str) -> dict[str, Any]:
    """`GET /api/runs/{id}/diff` as roko serve answers it, for a branch in the replay's workspace."""
    commit = _git(workdir, "rev-parse", branch)
    statuses = dict(
        reversed(line.split("\t", 1))
        for line in _git(workdir, "diff", "--name-status", "--no-renames", base, commit).splitlines()
        if "\t" in line
    )
    files = []
    for line in _git(workdir, "diff", "--numstat", "--no-renames", base, commit).splitlines():
        added, deleted, path = line.split("\t", 2)
        binary = added == "-"
        files.append(
            {
                "path": path,
                "status": {"A": "added", "D": "deleted"}.get(statuses.get(path, "M"), "modified"),
                "additions": 0 if binary else int(added),
                "deletions": 0 if binary else int(deleted),
                "binary": binary,
                "patch": None
                if binary
                else _git(workdir, "diff", "--no-color", base, commit, "--", path) + "\n",
                "truncated": False,
            }
        )
    return {
        "branch": branch,
        "base": base,
        "commit": commit,
        "files": files,
        "totals": {
            "files": len(files),
            "additions": sum(f["additions"] for f in files),
            "deletions": sum(f["deletions"] for f in files),
        },
        "truncated": False,
    }


def _result(workdir: Path, run_id: str) -> dict[str, Any] | None:
    branch = f"roko/batch/{run_id}"
    try:
        commit = _git(workdir, "rev-parse", branch)
        base = _git(workdir, "merge-base", "main", commit)
        names = _git(workdir, "diff", "--name-only", base, commit).splitlines()
        merged = (
            subprocess.run(
                ["git", "-C", str(workdir), "merge-base", "--is-ancestor", commit, "HEAD"], check=False
            ).returncode
            == 0
        )
    except subprocess.CalledProcessError:
        return None
    out: dict[str, Any] = {
        "branch": branch,
        "commit": commit,
        "base": base,
        "files_changed": names,
        "merged": merged,
    }
    if not merged:
        out["merge_command"] = f"git merge --ff-only {branch}"
    return out


# -- the Hermes side ----------------------------------------------------------------


def plugin_data_dir(hermes_home: Path, plugin_id: str = "roko") -> Path:
    """Where Hermes keeps a plugin's state (hermes_cli/plugins.py `_portable_skill_namespace`)."""
    slug = "".join(ch if ch.isascii() and (ch.isalnum() or ch in "_-") else "-" for ch in plugin_id.lower())
    digest = hashlib.sha256(plugin_id.encode("utf-8")).hexdigest()[:8]
    return hermes_home / "plugin-data" / f"agent-plugin-{slug.strip('-_') or 'plugin'}-{digest}"


def seed(hermes_home: Path, server: ReplayRoko) -> None:
    """Write the replays into the Hermes home's roko run log, newest first, as the plugin would."""
    path = plugin_data_dir(hermes_home) / "state.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    state = json.loads(path.read_text()) if path.exists() else {}
    runs = []
    now = datetime.now(UTC)
    for index, replay in enumerate(sorted(server.runs.values(), key=lambda r: r.head_start_s)):
        if not isinstance(replay, Replay):
            continue
        now_state = replay.current()
        live = now_state not in TERMINAL
        lead = timedelta(seconds=replay.head_start_s / replay.speed)
        started = now - lead if live else now - timedelta(minutes=12 * index + 1)
        entry: dict[str, Any] = {
            "run_id": replay.run_id,
            "kind": replay.kind,
            "label": LABELS[replay.fixture],
            "started_at": started.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "state": now_state,
            "max_usd": 1.0 if replay.kind == "plan" else 0.5,
            "session_id": "20261013_140000_demo",
        }
        if replay.plan_id:
            entry["plan_id"] = replay.plan_id
        if replay.kind == "run":
            entry["request"] = LABELS[replay.fixture]
        runs.append(entry)
    state["runs.v1"] = sorted(runs, key=lambda r: r["started_at"], reverse=True)
    path.write_text(json.dumps(state, indent=1))


def build(speed: float, workdir: Path | None) -> ReplayRoko:
    server = ReplayRoko()
    server.speed = speed
    if workdir is not None:
        init_workdir(workdir)
        server.workdir = workdir
    server.knowledge = [
        {
            "id": "k-1",
            "content": "tally's tests run with `python3 -m unittest discover`; plain `python` is not on PATH.",
            "kind": "insight",
            "tier": "working",
        },
        {
            "id": "k-2",
            "content": "Budgets are stored as integer cents per category; never floats.",
            "kind": "strategy_fragment",
            "tier": "working",
        },
    ]
    for fixture in ("failed_run", "cancelled_plan_run", "prompt_run", PLAN_RUN):
        server.replay(fixture, run_id=FIXTURES[fixture]["run_id"], ended=True)
    server.replay(PLAN_RUN, head_start_s=40.0)
    # Gates, models and spend as roko would report them after the recorded runs (tests/dashboard/demo_data.py).
    sys.path.insert(0, str(Path(__file__).parent / "dashboard"))
    from demo_data import seed_insights

    seed_insights(server)
    return server


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--port", type=int, default=6720)
    parser.add_argument("--speed", type=float, default=6.0)
    parser.add_argument("--seed", type=Path, help="a Hermes home whose roko run log gets the replays")
    parser.add_argument("--workdir", type=Path, help="a git checkout for the replays' batch branches")
    args = parser.parse_args()
    server = build(args.speed, args.workdir)
    if args.seed:
        seed(args.seed, server)
    server.start(port=args.port)
    print(f"replay roko on {server.url} (speed {args.speed}×); Ctrl-C stops it", flush=True)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        server.stop()


def _iso(when: datetime) -> str:
    return when.isoformat(timespec="milliseconds").replace("+00:00", "Z")


if __name__ == "__main__":
    main()

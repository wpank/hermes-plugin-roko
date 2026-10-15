"""A roko serve that replays real runs, for building and showing the UIs without spending anything.

    python tests/replay_roko.py [--port 6720] [--speed 6] [--seed HERMES_HOME] [--workdir DIR] [--tour]

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

The recordings predate several of roko's live events, so each replay also carries the ones a newer roko
writes, in roko's shapes, made up from the recording and marked `"synthetic": true`: the router's pick
before each attempt (`route_decided`; in the five-task plan, T3's first pick fails over to another model),
the agent's tool steps and words as it works (live `agent_output` records), what a passed task taught the
knowledge store (`knowledge_written`), the adaptive gate thresholds (`gate_thresholds_updated`), loop
health when a plan closes (`loop_health`), the model ladder running out on the failed run (`diagnosis`),
and the sign-off's wait (`confirm_waiting` / `confirm_resolved`). Like roko's own hub, `GET /api/events`
streams every run's rows as they are revealed.

`--tour` adds, to each five-task plan run started while it serves, one of each loop event the recordings
never show: a held tool call and its decision, a check regressing, a budget alert, a stall diagnosis, a
guard holding a learning update back, and a learning loop changing health.

roko's learning and control routes answer from what the replays have revealed so far, in roko's shapes,
so they move as replays run and end: the loop registry and each loop's health and transitions
(`/api/learn/loops[/{id}]`), the router's decisions with their outcomes (`…/L-route/decisions`), the
adaptive gate thresholds (`/api/learn/adaptive-thresholds`, `/api/learn/gate-thresholds`), the
conductor's and watchdogs' diagnoses (`/api/diagnosis/recent`), the lessons the knowledge store kept
(`/api/knowledge/entries`), and the playbooks and reflexes their outcomes credit (`/api/learn/playbooks`,
`/api/learn/reflexes`). A tour's held call waits in `effects_pending` while it is held, and the person's
answer through `effect_decide` becomes its decision.

`--seed HERMES_HOME` writes the runs into that Hermes home's roko run log, so the plugin lists them.
`--workdir DIR` makes DIR a git checkout holding each finished replay's batch branch, so Merge works.

`--recording live` replays instead the runs recorded from a live roko (roko-final6, real models) in
tests/fixtures/live_runs.json, as they were: nothing is made up, so the router's picks, the agents' words,
the sign-off's two holds (rejected with a note, then approved after a retry), the lessons and loop health
are roko's own rows. roko wrote the words a token a row; to keep the file small, each row in the fixture
holds what one attempt said over at most 250 ms (the tokens' text joined, with the first token's cursor
and time), so the words still arrive as the agent wrote them, a burst at a time. A recorded sign-off waits
as long as it did; an answer is taken, but the recording goes on as the person answered then.
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
from collections import defaultdict
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
    "live_plan_run": "Per-category budgets for tally",
    "live_failed_run": "Per-category budgets for tally (first try)",
    "live_prompt_run": "Add a --version flag to the tally CLI",
    "live_signoff_run": "Write REPORT.md on what tally report prints",
}


def load_recordings(path: Path) -> dict[str, dict[str, Any]]:
    """Runs recorded from a live roko: one JSON object per line, each fixture's parts (`meta`, `summary`,
    `plan_tasks`, `diff`, `pending`: what each sign-off showed) and then its index rows in cursor order."""
    out: dict[str, dict[str, Any]] = {}
    if not path.is_file():
        return out
    for line in path.read_text().splitlines():
        if not line.strip():
            continue
        part = json.loads(line)
        fx = out.setdefault(part["fixture"], {"events": [], "live": True})
        kind = part["part"]
        if kind == "meta":
            fx["run_id"] = part["run_id"]
        elif kind == "event":
            fx["events"].append(part["row"])
        elif kind == "pending":
            fx["pending_summaries"] = part["summaries"]
        else:
            fx[kind] = part[kind]
    return out


LIVE = load_recordings(Path(__file__).parent / "fixtures" / "live_runs.json")
# What each kind of request replays: the dogfood recordings, with the live events a newer roko writes
# made up from them, or the runs recorded from a live roko, as they were.
RECORDINGS: dict[str, dict[str, Any]] = {
    "dogfood": {
        "plan": PLAN_RUN,
        "prompt": "prompt_run",
        "confirm": "confirm_run",
        "ended": ("failed_run", "cancelled_plan_run", "prompt_run", PLAN_RUN),
    },
    "live": {
        "plan": "live_plan_run",
        "prompt": "live_prompt_run",
        "confirm": "live_signoff_run",
        "ended": ("live_failed_run", "live_prompt_run", "live_signoff_run", "live_plan_run"),
    },
}


def fixture_data(name: str) -> dict[str, Any]:
    return FIXTURES[name] if name in FIXTURES else LIVE[name]


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
    # How the person answered the sign-off.
    answer_outcome: str = "approved"
    # The recording's own plan id, which a replay of a copied plan renames.
    recorded_plan: str | None = None
    # The person's answers to the run's held tool calls, by effect id: the decision row they become.
    effect_answers: dict[str, dict[str, Any]] = field(default_factory=dict)
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

    def open_hold(self) -> dict[str, Any] | None:
        """A recorded sign-off that waits at this point of a live recording, as `confirm_pending` lists it."""
        holds: dict[int, dict[str, Any]] = {}
        for event in self.index() or []:
            if event.get("type") == "confirm_waiting":
                holds[_int(event.get("attempt"))] = event
            elif event.get("type") == "confirm_resolved":
                holds.pop(_int(event.get("attempt")), None)
        if not holds:
            return None
        attempt = max(holds)
        event = holds[attempt]
        summaries = fixture_data(self.fixture).get("pending_summaries") or {}
        plan, task = str(event.get("plan_id") or ""), str(event.get("task_id") or "")
        return {
            "attempt_key": f"{self.run_id}:{plan}:{task}:{attempt}",
            "held_at": datetime.fromtimestamp(event["ts_millis"] / 1000, UTC).isoformat(),
            "plan_id": plan,
            "question": event.get("question") or "Is this what you asked for?",
            "summary": summaries.get(str(attempt)) or "",
            "task_id": task,
            "title": LABELS.get(self.fixture, task),
            "timeout_secs": event.get("timeout_secs"),
            "deadline_at": event.get("deadline_at"),
        }

    def answer(self, outcome: str = "approved") -> None:
        self.answer_outcome = outcome
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
            effect = str(event.get("effect_id") or "")
            if effect.startswith(TOUR_EFFECT):  # each run holds its own call
                event["effect_id"] = f"effect-{self.run_id[:8]}-{effect[len(TOUR_EFFECT) :]}"
            if isinstance(ts, int):
                # Rows after a confirm hold happened once the person answered.
                late = self.paused_total * 1000 if hold_ms is not None and ts > hold_ms else 0
                event["ts_millis"] = self.shift(ts) + int(late)
            if event.get("type") == "run_completed" and isinstance(event.get("duration_ms"), int):
                event["duration_ms"] = int(event["duration_ms"] / self.speed)
            if event.pop("_hold_wait", None):
                held = datetime.fromtimestamp(event["ts_millis"] / 1000, UTC)
                event["deadline_at"] = (held + timedelta(seconds=event["timeout_secs"])).isoformat()
            if event.pop("_hold_answer", None):
                event["outcome"] = self.answer_outcome
            if event.get("type") == "effect_decided" and event.get("effect_id") in self.effect_answers:
                event.update(self.effect_answers[event["effect_id"]])
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
        if names and event.get("type") in ("inbox_item_received", "diagnosis"):
            text = json.dumps(event)  # these name their plan inside their ids and words
            for old, new in names.items():
                if old:
                    text = text.replace(old, new)
            event.clear()
            event.update(json.loads(text))
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
    # Whether new five-task plan runs carry the tour of loop events (`--tour`).
    tour: bool = False
    # Which recordings requests replay (`RECORDINGS`).
    recording: str = "dogfood"

    def role(self, kind: str) -> str:
        return str(RECORDINGS[self.recording][kind])

    def replay(
        self,
        fixture: str,
        *,
        run_id: str | None = None,
        ended: bool = False,
        head_start_s: float = 0.0,
        max_usd: float | None = None,
    ) -> Replay:
        fx = fixture_data(fixture)
        plan_id = (fx.get("plan_tasks") or {}).get("plan_id")
        raw = [copy.deepcopy(row["event"]) for row in fx["events"]]
        rows = synthesize(fixture, raw, tour=self.tour and not ended)
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
                "title": LABELS[fixture] if fx.get("live") else "Per-category budgets for tally",
                "tasks": fx["plan_tasks"]["tasks"],
                "status": "ready",
            }
        if self.workdir is not None and fixture in (PLAN_RUN, "prompt_run", "confirm_run"):
            base = _deliver(self.workdir, replay.run_id, fixture)
            if self.diffs is not None:
                self.diffs[replay.run_id] = _diff_body(self.workdir, base, f"roko/batch/{replay.run_id}")
        elif (fixture == PLAN_RUN or fx.get("live")) and fx.get("diff") and self.diffs is not None:
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
        # roko's run_status waits up to wait_secs for the state to change (or the run to wait on the
        # person) before it answers; a replay does the same, so a chat follows it the way it would.
        wait = min(float(args.get("wait_secs") or 0), 30.0)
        if wait > 0 and run.current() not in TERMINAL and not run.waiting():
            first = run.current()
            deadline = time.monotonic() + wait
            self.lock.release()
            try:
                while time.monotonic() < deadline and run.current() == first and not run.waiting():
                    time.sleep(0.1)
            finally:
                self.lock.acquire()
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
        fixture = self.role("confirm") if "report" in args["prompt"].lower() else self.role("prompt")
        run = self.replay(fixture, max_usd=cap)
        return tool_ok({"run_id": run.run_id, "state": "running"})

    def _tool_plan_run(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        cap = self._cap(args)
        plan_id = str(args.get("plan_id") or "")
        if plan_id not in self.plans:
            return tool_error(f"plan '{plan_id}' not found")
        run = self.replay(self.role("plan"), max_usd=cap)
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
        if isinstance(run, Replay) and fixture_data(run.fixture).get("live"):
            held = run.open_hold()
            return tool_ok({"pending": [held] if held else []})
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
        if isinstance(run, Replay) and fixture_data(run.fixture).get("live") and run.open_hold():
            # A recording goes on as the person answered then; the answer is taken all the same.
            decision = "approved" if args.get("approve") else "rejected"
            return tool_ok(
                {**{k: args.get(k) for k in ("run_id", "task_id", "attempt_key")}, "decision": decision}
            )
        if isinstance(run, Replay) and run.waiting():
            decision = "approved" if args.get("approve") else "rejected"
            run.answer(decision)
            return tool_ok(
                {**{k: args.get(k) for k in ("run_id", "task_id", "attempt_key")}, "decision": decision}
            )
        return super()._tool_confirm_answer(args, who)

    def _tool_effects_pending(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        answer = super()._tool_effects_pending(args, who)
        body = answer["structuredContent"]
        wanted = args.get("run_id")
        for run in list(self.runs.values()):
            if not isinstance(run, Replay) or (wanted and run.run_id != wanted):
                continue
            waiting, decided = held_calls(run)
            body["waiting"].extend(waiting)
            body["decided"][:0] = decided
        answer["content"] = [{"type": "text", "text": json.dumps(body)}]
        return answer

    def _tool_effect_decide(self, args: dict[str, Any], who: Any) -> dict[str, Any]:
        effect_id = str(args.get("effect_id") or "")
        for run in list(self.runs.values()):
            if not isinstance(run, Replay):
                continue
            waiting, _ = held_calls(run)
            held = next((item for item in waiting if item["effect_id"] == effect_id), None)
            if held is None:
                continue
            outcome = "applied" if args.get("approve") else "rejected"
            run.effect_answers[effect_id] = {"outcome": outcome, "decided_by": who[0] if who else "local-mcp"}
            record = {
                **held,
                "outcome": outcome,
                "decided_by": who[0] if who else "local-mcp",
                "note": args.get("note"),
                "receipts": [],
                "decided_at": _iso(datetime.now(UTC)),
            }
            return tool_ok(record)
        return super()._tool_effect_decide(args, who)

    # -- roko's learning and control state, as the replays' revealed rows have left it ------

    def revealed(self) -> list[tuple[Replay, dict[str, Any]]]:
        """Every replay's rows revealed so far, oldest first across runs."""
        pairs = [
            (run, row)
            for run in list(self.runs.values())
            if isinstance(run, Replay)
            for row in run.index() or []
        ]
        pairs.sort(key=lambda pair: _ms(pair[1]))
        return pairs

    def learn_loops(self) -> list[dict[str, Any]]:
        return loop_rows(self.revealed())

    def learn_loop(self, loop_id: str) -> dict[str, Any] | None:
        revealed = self.revealed()
        row = next((row for row in loop_rows(revealed) if row["loop_id"] == loop_id), None)
        if row is None:
            return None
        health = next(
            (
                (run, event)
                for run, event in reversed(revealed)
                if event.get("type") == "loop_health" and event.get("loop_id") == loop_id
            ),
            None,
        )
        transitions = [
            _audit_record(run, event, "loop.transition")
            for run, event in revealed
            if event.get("type") == "loop_transition" and event.get("loop_id") == loop_id
        ]
        return {
            "loop": row,
            "health": _health_record(health[0], health[1], row) if health else None,
            "transitions": transitions,
            "canaries": [],
        }

    def learn_decisions(self, loop_id: str, limit: int) -> list[dict[str, Any]]:
        if loop_id != "L-route":
            return []
        return route_decision_rows(self.revealed())[:limit]

    def learn_adaptive(self) -> dict[str, Any]:
        stats = rung_stats(self.revealed())
        rungs = [
            {
                "rung": rung,
                "ema_pass_rate": round(stat["ema"], 4),
                "total_observations": stat["n"],
                "consecutive_passes": stat["streak"],
                "suggested_max_retries": suggested_retries(stat),
                "should_skip_rung": stat["streak"] >= SKIP_STREAK,
            }
            for rung, stat in sorted(stats.items())
        ]
        return {
            "source": self._learn_file("gate-thresholds.json"),
            "tracked_rungs": len(rungs),
            "rungs": rungs,
        }

    def learn_gate_thresholds(self) -> dict[str, Any]:
        raw = thresholds_file(rung_stats(self.revealed()))
        path = self._learn_file("gate-thresholds.json")
        return {
            **raw,
            "projection_state": "fresh",
            "source": path,
            "value": raw,
            "evidence": {
                "files": [{"path": path, "observed_at": _iso(datetime.now(UTC))}],
                "synthetic": True,
            },
        }

    def learn_diagnoses(self) -> list[dict[str, Any]]:
        latest: dict[str, dict[str, Any]] = {}
        for _, event in self.revealed():
            summary = event.get("summary")
            if event.get("type") == "diagnosis" and isinstance(summary, dict):
                latest[str(summary.get("id") or len(latest))] = {**summary, "synthetic": True}
        return sorted(latest.values(), key=lambda row: str(row.get("ts") or ""), reverse=True)

    def knowledge_entries(self, limit: int) -> dict[str, Any]:
        lessons: dict[str, dict[str, Any]] = {}
        for _, event in self.revealed():
            if event.get("type") == "knowledge_written" and event.get("entry_id") and event.get("lesson"):
                entry = lessons.setdefault(str(event["entry_id"]), {"seen": 0, "event": event})
                entry["seen"] += 1
                entry["event"] = event
        items = [
            {
                "id": entry_id,
                "domain": "coding",
                "citations": entry["seen"] + int(entry["event"].get("reinforced") or 0),
                "label": _label(str(entry["event"]["lesson"])),
                "confidence": round(min(0.95, 0.55 + 0.1 * entry["seen"]), 2),
                "synthetic": True,
            }
            for entry_id, entry in sorted(lessons.items(), key=lambda pair: -_ms(pair[1]["event"]))
        ]
        items += super().knowledge_entries(len(self.knowledge))["items"]
        return {
            "items": items[:limit],
            "total": len(items),
            "offset": 0,
            "limit": min(limit, len(items)),
            "has_more": limit < len(items),
        }

    def learn_playbooks(self) -> dict[str, Any]:
        books = playbooks(self.revealed())
        return {"total": len(books), "playbooks": books}

    def learn_reflexes(self) -> dict[str, Any]:
        rules = reflexes(self.revealed())
        return {"total_rules": len(rules), "max_rules": 200, "top_rules": rules[:5], "recent_demotions": []}

    def _learn_file(self, name: str) -> str:
        return f"{self.workdir or '.'}/.roko/learn/{name}"


# -- the live events a newer roko writes, made up from a recording -----------------------

LESSONS = {
    "Add BudgetStore persistence module": "Budgets persist as integer cents per category, in a JSON file.",
    "Extend render_summary to show budget vs spent and flag over-budget categories": (
        "render_summary flags a category over budget only when spent exceeds the limit."
    ),
    "Add CLI budget subcommands and wire budget data into the report command": (
        "tally's subcommands are argparse subparsers wired in build_parser()."
    ),
    "Write unit tests for BudgetStore persistence": (
        "tally's tests run with python3 -m unittest discover; plain python is not on PATH."
    ),
    "Add over-budget report and CLI budget command tests to existing test suites": (
        "CLI tests drive build_parser() with a temporary ledger file."
    ),
}
# The other models a route weighed, as roko lists them after the pick: by score.
RIVALS = [
    {
        "model": "claude-sonnet-4-6",
        "provider": "claude_cli",
        "score": 0.91,
        "eligible": False,
        "ineligible_reason": "runs its own tools, so it cannot honour the stage policy",
    },
    {"model": "gpt-5.4-mini", "provider": "openai", "score": 0.66, "p": 0.24, "eligible": True},
    {"model": "gpt-oss-120b", "provider": "cerebras", "score": 0.58, "p": 0.21, "eligible": True},
]
# The five-task plan's task whose first pick fails over (its provider refuses), and to what.
FAILOVER_TASK = "T3"
# The tour's held call; each replay renames it after its run.
TOUR_EFFECT = "effect-tour-"
# roko's canonical rungs (roko-gate rung_selector.rs `Rung::as_index`) for the checks a replay runs.
RUNGS = {"compile": 0, "clippy": 1, "lint": 1, "test": 2}
STREAM = "\x1eroko.stream.v1 "


def synthesize(fixture: str, rows: list[dict[str, Any]], *, tour: bool = False) -> list[dict[str, Any]]:
    """`rows` (a recording) with the live events a newer roko writes inserted, each marked synthetic;
    `tour` adds the loop events no recording shows (five-task plan only)."""
    fx = fixture_data(fixture)
    if fx.get("live"):
        # roko wrote these rows itself: replayed as recorded, in time order (a row without a time keeps
        # its place), with each sign-off's deadline moving with the replay's clock.
        at = 0
        keyed = []
        for index, row in enumerate(rows):
            at = row["ts_millis"] if isinstance(row.get("ts_millis"), int) else at
            if row.get("type") == "confirm_waiting" and isinstance(row.get("timeout_secs"), int):
                row["_hold_wait"] = True
            keyed.append((at, index, row))
        return [row for _at, _index, row in sorted(keyed, key=lambda item: item[:2])]
    tasks = {task["id"]: task for task in (fx.get("plan_tasks") or {}).get("tasks", [])}
    made: list[dict[str, Any]] = []
    spawns: dict[tuple[str, str], int] = {}
    gates: dict[int, dict[str, Any]] = {}
    last_gate_ts = 0
    for index, row in enumerate(rows):
        kind, ts = row.get("type"), row.get("ts_millis")
        plan, task = row.get("plan_id") or "", row.get("task_id") or ""
        if not isinstance(ts, int):
            continue
        if kind == "agent_spawned" and task:
            number = spawns[(plan, task)] = spawns.get((plan, task), 0) + 1
            model, provider = row.get("model") or "glm-5.1", row.get("provider") or ""
            if fixture == PLAN_RUN and task == FAILOVER_TASK and number == 1:
                made.extend(_failover(plan, task, number, model, provider, ts - 6))
            else:
                made.append(_route(plan, task, number, model, provider, ts - 3))
            end, note = _attempt_end(rows, index, plan, task)
            made.extend(_steps(plan, task, number, ts, end, tasks.get(task) or {}, note))
        elif kind == "task_completed" and task:
            if row.get("outcome") == "passed":
                lesson = LESSONS.get((tasks.get(task) or {}).get("title", ""), _lesson_for(fixture))
                made.append(
                    {
                        "type": "knowledge_written",
                        "plan_id": plan,
                        "task_id": task,
                        "admission": "light_admitted" if spawns.get((plan, task), 1) == 1 else "duplicate",
                        "entry_id": "k-" + hashlib.sha256(f"{fixture}/{task}".encode()).hexdigest()[:8],
                        "reinforced": 1,
                        "promoted": 0,
                        "lesson": lesson,
                        "ts_millis": ts + 40,
                    }
                )
            elif row.get("outcome") == "failed" and spawns.get((plan, task), 0) >= 3:
                made.append(_ladder_exhausted(plan, task, spawns[(plan, task)], ts))
        elif kind == "gate_result":
            rung = gate_rung(str(row.get("gate") or ""))
            if rung is not None:  # a standalone check (a sign-off) has no adaptive threshold
                observe(gates, rung, bool(row.get("passed")))
                last_gate_ts = max(last_gate_ts, ts)
        elif kind == "plan_completed" and plan:
            made.extend(_loop_health(ts - 10))
    if gates:
        made.append(
            {
                "type": "gate_thresholds_updated",
                "snapshot_json": json.dumps(thresholds_file(gates)),
                "ts_millis": last_gate_ts + 20,
            }
        )
    if fixture == "confirm_run":
        made.extend(_hold(rows))
    if tour and fixture == PLAN_RUN:
        made.extend(_tour(rows))
    for event in made:
        event["synthetic"] = True
    return _merge(rows, made)


def _route(plan: str, task: str, number: int, model: str, provider: str, ts: int) -> dict[str, Any]:
    first = number == 1
    return {
        "type": "route_decided",
        "plan_id": plan,
        "task_id": task,
        "attempt": number,
        "model": model,
        "provider": provider,
        "stage": "ladder" if first else "ladder_retry",
        "reason": "the ladder's top rung for this workspace"
        if first
        else "a retry stays on its rung while the agent is to blame",
        "source": "ladder",
        "candidates": [
            {"model": model, "provider": provider, "score": 0.83, "p": 0.55, "eligible": True},
            *(rival for rival in RIVALS if rival["model"] != model),
        ],
        "ts_millis": ts,
    }


def _failover(plan: str, task: str, number: int, model: str, provider: str, ts: int) -> list[dict[str, Any]]:
    """The router's pick, and roko passing it over when its provider refuses: a second `route_decided`
    with stage and source `failover`, then the attempt starts on the new model."""
    first, first_provider = "gpt-5.4-mini", "openai"
    picked = {"model": first, "provider": first_provider, "score": 0.86, "p": 0.62, "eligible": True}
    rivals = [
        {"model": model, "provider": provider, "score": 0.83, "p": 0.31, "eligible": True},
        RIVALS[0],
        RIVALS[2],
    ]
    base = {"type": "route_decided", "plan_id": plan, "task_id": task, "attempt": number}
    return [
        {
            **base,
            "model": first,
            "provider": first_provider,
            "stage": "router",
            "reason": "learned: the best expected pass rate per dollar for this task's tier",
            "source": "router",
            "candidates": [picked, *sorted(rivals, key=lambda c: -float(c["score"]))],
            "ts_millis": ts,
        },
        {
            **base,
            "model": model,
            "provider": provider,
            "stage": "failover",
            "reason": f"{first} on {first_provider} passed over (rate_limited): 429 Too Many Requests",
            "source": "failover",
            "candidates": [
                {"model": model, "provider": provider, "score": 0.83, "eligible": True},
                RIVALS[0],
                {
                    "model": first,
                    "provider": first_provider,
                    "score": 0.86,
                    "eligible": False,
                    "ineligible_reason": "rate_limited",
                },
                {key: value for key, value in RIVALS[2].items() if key != "p"},
            ],
            "ts_millis": ts + 3,
        },
    ]


def _tour(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """One of each loop event the recordings never show, spread over the run (`--tour`)."""
    stamps = [row["ts_millis"] for row in rows if isinstance(row.get("ts_millis"), int)]
    plan = next(
        (row["plan_id"] for row in rows if row.get("type") == "task_started" and row.get("plan_id")), ""
    )
    if not stamps or not plan:
        return []
    start, span = min(stamps), max(stamps) - min(stamps)

    def at(share: float) -> int:
        return start + int(span * share)

    def iso(ms: int) -> str:
        return datetime.fromtimestamp(ms / 1000, UTC).isoformat()

    return [
        {
            "type": "effect_staged",
            "effect_id": "effect-tour-1",
            "plan_id": plan,
            "task_id": "T2",
            "attempt": 1,
            "tool": "send",
            "server": "mail",
            "proposed_at": iso(at(0.3)),
            "ts_millis": at(0.3),
        },
        {
            "type": "effect_decided",
            "effect_id": "effect-tour-1",
            "plan_id": plan,
            "task_id": "T2",
            "tool": "send",
            "server": "mail",
            "outcome": "rejected",
            "decided_by": "replay",
            "ts_millis": at(0.33),
        },
        {
            "type": "event_log_entry",
            "event_type": "gate_regression",
            "plan_id": plan,
            "task_id": "T4",
            "timestamp_ms": at(0.45),
            "message": "verify[0:test] passed on an earlier attempt and fails now",
            "ts_millis": at(0.45),
        },
        {
            "type": "inbox_item_received",
            "item_id": f"budget:{plan}:50",
            "category": "budget_alert",
            "urgency": "normal",
            "summary": f"plan {plan} has spent $0.1000 of $0.2000 (50%)",
            "ts_millis": at(0.5),
        },
        {
            "type": "diagnosis",
            "summary": {
                "id": f"stall-watchdog:{plan}:{plan}:T5:1:silent",
                "ts": iso(at(0.7)),
                "severity": "warn",
                "subject": f"{plan}/T5",
                "detail": "agent silent: no progress for 120s ([conductor] silence_timeout_secs = 120)",
                "suggested_action": "the attempt is cancelled and retried after 300s of silence",
                "intervention_taken": None,
            },
            "ts_millis": at(0.7),
        },
        {
            "type": "event_log_entry",
            "event_type": "learning.guarded_commit",
            "plan_id": "",
            "task_id": "",
            "timestamp_ms": at(0.97),
            "message": "knowledge: 1 entry held back until a second run confirms it",
            "ts_millis": at(0.97),
        },
        {
            "type": "loop_transition",
            "loop_id": "L-know",
            "from": "probation",
            "to": "live",
            "reason": None,
            "rule": "beta_lcb > 0 over at least 20 opportunities",
            "actor": "auditor",
            "ts": iso(at(0.98)),
            "ts_millis": at(0.98),
        },
    ]


def _attempt_end(rows: list[dict[str, Any]], start: int, plan: str, task: str) -> tuple[int, str]:
    """When the attempt that starts at `rows[start]` ends, and the transcript its agent left."""
    begin = rows[start]["ts_millis"]
    for row in rows[start + 1 :]:
        if (
            row.get("plan_id") != plan
            or row.get("task_id") != task
            or not isinstance(row.get("ts_millis"), int)
        ):
            continue
        if row.get("type") in ("agent_output", "agent_completed", "gate_rung_started", "task_completed"):
            return row["ts_millis"], _transcript(row) if row.get("type") == "agent_output" else ""
    return begin + 30_000, ""


def _transcript(row: dict[str, Any]) -> str:
    texts = []
    for line in str(row.get("content") or "").split("\n"):
        if line.startswith(STREAM):
            try:
                record = json.loads(line[len(STREAM) :])
            except ValueError:
                continue
            if record.get("kind") == "text":
                texts.append(str((record.get("payload") or {}).get("text") or ""))
    return " ".join(texts).strip()


def _steps(
    plan: str, task: str, number: int, start: int, end: int, spec: dict[str, Any], note: str
) -> list[dict[str, Any]]:
    """The agent's tool steps and words over one attempt, as roko's live records."""
    files = spec.get("files") or ["tally/cli.py"]
    checks = [step.get("command") for step in spec.get("verify") or [] if isinstance(step, dict)]
    check = (checks[0] if checks else "python3 -m unittest discover")[:120]
    plan_steps = [("Read", files[0]), ("Grep", "def build_parser"), ("Write", files[0]), ("Bash", check)]
    if len(files) > 1:
        plan_steps.insert(3, ("Edit", files[1]))
    if number > 1:
        plan_steps = [("Read", files[0]), ("Edit", files[0]), ("Bash", check)]
    span = max(end - start, 4_000)
    out = []
    for at, (tool, target) in enumerate(plan_steps):
        ts = start + int(span * (0.12 + 0.7 * at / max(1, len(plan_steps))))
        out.append(
            _live(
                plan,
                task,
                number,
                "tool_start",
                {"tool_id": f"{task}-{number}-{at}", "tool": tool, "target": target},
                ts,
            )
        )
    words = [part.strip() for part in (note or "").replace("\n", " ").split(". ") if part.strip()][:2]
    for at, sentence in enumerate(words):
        ts = start + int(span * (0.86 + 0.05 * at))
        out.append(
            _live(
                plan,
                task,
                number,
                "text",
                {"text": sentence[:180] + (". " if not sentence.endswith(".") else " ")},
                ts,
                screened=False,
            )
        )
    return out


def _live(
    plan: str, task: str, number: int, kind: str, payload: dict[str, Any], ts: int, *, screened: bool = True
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "kind": kind,
        "agent_id": f"{plan}/{task}",
        "plan_id": plan,
        "task_id": task,
        "attempt": number,
        "live": True,
        "payload": payload,
    }
    if not screened:
        record["screened"] = False
    return {
        "type": "agent_output",
        "agent_id": f"{plan}/{task}",
        "plan_id": plan,
        "task_id": task,
        "attempt": number,
        "content": STREAM + json.dumps(record),
        "ts_millis": ts,
    }


def _ladder_exhausted(plan: str, task: str, attempts: int, ts: int) -> dict[str, Any]:
    stamp = datetime.fromtimestamp((ts + 20) / 1000, UTC).isoformat()
    return {
        "type": "diagnosis",
        "summary": {
            "id": f"ladder_exhausted:{plan}/{task}",
            "ts": stamp,
            "severity": "alert",
            "subject": task,
            "detail": f"{attempts} attempts did not pass the same check; the model ladder has no rung left",
            "suggested_action": "the check itself fails (python is not on PATH): fix the plan's check",
            "intervention_taken": "failed the task",
        },
        "ts_millis": ts + 20,
    }


def _loop_health(ts: int) -> list[dict[str, Any]]:
    """The loop audit's health rows at a plan's close (roko's `loop_health`, audit states)."""
    stamp = datetime.fromtimestamp(ts / 1000, UTC).isoformat()
    loops = [
        ("L-route", "probation", 0.2, 0.04, 0.12, None),
        ("L-know", "probation", 0.2, 0.02, 0.06, None),
        ("L-gate-thr", "probation", 0.0, 0.01, 0.0, None),
    ]
    return [
        {
            "type": "loop_health",
            "loop_id": loop_id,
            "state": state,
            "reason": None,
            "qualifiers": [],
            "h": h,
            "eps": eps,
            "iota_net": iota,
            "beta": beta,
            "ts": stamp,
            "ts_millis": ts,
        }
        for loop_id, state, h, eps, iota, beta in loops
    ]


def _hold(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The sign-off's wait: published when the hold starts, answered when the person answers."""
    gate = next((row for row in rows if row.get("type") == "gate_result"), None)
    if gate is None:
        return []
    plan, task, ts = gate.get("plan_id") or "", gate.get("task_id") or "T1", gate["ts_millis"]
    key = f"{plan}:{plan}:{task}:1"
    base = {"plan_id": plan, "task_id": task, "attempt": 1, "attempt_key": key, "rung": "rung[sign-off]"}
    question = (
        FIXTURES["confirm_run"]["pending_raw"]["pending"][0].get("question") or "Is this what you asked for?"
    )
    return [
        {
            "type": "confirm_waiting",
            **base,
            "question": question,
            "timeout_secs": 1800,
            "_hold_wait": True,
            "ts_millis": ts - 600,
        },
        {
            "type": "confirm_resolved",
            **base,
            "outcome": "approved",
            "_hold_answer": True,
            "ts_millis": ts - 400,
        },
    ]


def _lesson_for(fixture: str) -> str:
    return {
        "prompt_run": "--json output uses json.dumps with sort_keys, so tests can compare it.",
        "confirm_run": "REPORT.md documents each public function with its errors and sign conventions.",
    }.get(fixture, "What a passed task teaches is kept for the next run.")


def _merge(rows: list[dict[str, Any]], made: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`made` placed among `rows` by time, keeping the recording's own order."""
    slots: dict[int, list[dict[str, Any]]] = {}
    for event in sorted(made, key=lambda event: event["ts_millis"]):
        position = -1
        for index, row in enumerate(rows):
            if isinstance(row.get("ts_millis"), int) and row["ts_millis"] <= event["ts_millis"]:
                position = index
        slots.setdefault(position, []).append(event)
    out = list(slots.get(-1, []))
    for index, row in enumerate(rows):
        out.append(row)
        out.extend(slots.get(index, []))
    return out


# -- roko's learning and control state, derived from what the replays have revealed -----------------

DEFAULT_MODEL = "glm-5.1"
# roko-gate adaptive_threshold.rs: EMA weight, retry bounds, the pass streak that skips a rung, CUSUM.
EMA_ALPHA = 0.1
MIN_RETRIES, MAX_RETRIES = 1, 5
SKIP_STREAK = 20
CUSUM_K, CUSUM_H = 0.25, 4.0
POISONING_WINDOW = 10
# loops.toml, in registry order (retired loops left out), and what a loop no replay exercises reports.
REGISTRY = (
    ("L-route", "active"),
    ("L-linucb", "active"),
    ("L-know", "active"),
    ("L-play", "active"),
    ("L-err", "observe_only"),
    ("L-dream", "active"),
    ("L-prompt-exp", "active"),
    ("L-sec", "active"),
    ("L-gate-thr", "observe_only"),
    ("L-retry-budget", "observe_only"),
    ("L-M1", "active"),
    ("L-M3", "active"),
    ("L-M4", "active"),
    ("L-placebo", "active"),
)
QUIET = {
    # the ladder picks, so the bandit's choice only shadows it
    "L-linucb": ("flagged", "dormant:mask"),
    # playbooks are credited, but only dreams write new ones
    "L-play": ("flagged", "dormant:no_learning"),
    "L-err": ("flagged", "dormant:unlogged"),
    "L-dream": ("flagged", "dormant:no_opportunity"),
    "L-prompt-exp": ("flagged", "dormant:no_opportunity"),
    # the section bandit is saved but no executed decision reads it
    "L-sec": ("flagged", "dormant:write_only"),
    "L-retry-budget": ("probation", None),
    # no viability policy file, so M1 never moves a setting
    "L-M1": ("flagged", "dormant:no_opportunity"),
    # the self-model is off by default
    "L-M3": ("flagged", "dormant:no_opportunity"),
    "L-M4": ("flagged", "dormant:no_opportunity"),
    # the placebo loop exists to show no benefit
    "L-placebo": ("flagged", "null"),
}
# The holdout rate a randomized loop runs at in each audit state.
HOLDOUT = {"probation": 0.2, "live": 0.05, "flagged": 0.2, "demoted": 1.0}
# roko lists a held call's argument types and sizes, never their values.
HELD_ARGUMENTS = {"to": "string (15 chars)", "subject": "string (38 chars)", "body": "string (412 chars)"}
PLAYBOOKS = (
    {
        "id": "pb-python-cli-feature",
        "name": "python CLI feature",
        "goal": "Add a flag or subcommand to a Python argparse CLI, with unit tests",
        "when_pattern": "cli|flag|subcommand|argparse",
        "steps": [
            {
                "index": 0,
                "description": "Read build_parser() and the command's handler",
                "action_kind": "read_file",
                "expected_signals": ["build_parser"],
            },
            {
                "index": 1,
                "description": "Add the flag or subparser and its handler",
                "action_kind": "edit_file",
                "expected_signals": ["add_argument"],
            },
            {
                "index": 2,
                "description": "Drive build_parser() from a unittest case with a temporary ledger",
                "action_kind": "edit_file",
                "expected_signals": ["unittest"],
            },
            {
                "index": 3,
                "description": "Run python3 -m unittest discover",
                "action_kind": "run_command",
                "expected_signals": ["OK"],
            },
        ],
        "success_count": 4,
        "failure_count": 1,
    },
    {
        "id": "pb-python-module-tests",
        "name": "python module with tests",
        "goal": "Add a stdlib-only module and its unit tests",
        "when_pattern": "module|store|persist|report",
        "steps": [
            {
                "index": 0,
                "description": "Write the module with type hints and docstrings",
                "action_kind": "edit_file",
                "expected_signals": ["class ", "def "],
            },
            {
                "index": 1,
                "description": "Write a unittest module covering its public API",
                "action_kind": "edit_file",
                "expected_signals": ["unittest.TestCase"],
            },
            {
                "index": 2,
                "description": "Run python3 -m unittest discover",
                "action_kind": "run_command",
                "expected_signals": ["OK"],
            },
        ],
        "success_count": 6,
        "failure_count": 2,
    },
)
# A week before the replays: when the playbooks and reflexes were first written.
SEEDED_AT = datetime.now(UTC) - timedelta(days=7)


def gate_rung(name: str) -> int | None:
    """The canonical rung of a check named `verify[<i>:<phase>]` or `rung[<phase>]`; None when standalone."""
    phase = name
    if name.startswith("verify[") and ":" in name and name.endswith("]"):
        phase = name.rsplit(":", 1)[-1][:-1]
    elif name.startswith("rung[") and name.endswith("]"):
        phase = name[5:-1]
    return RUNGS.get(phase)


def observe(stats: dict[int, dict[str, Any]], rung: int, passed: bool) -> None:
    """One verdict on `rung`, as roko's adaptive thresholds record it: CUSUM, then the EMA and the streak."""
    stat = stats.setdefault(rung, {"ema": 0.5, "n": 0, "streak": 0, "hi": 0.0, "lo": 0.0, "dirs": []})
    x = 1.0 if passed else 0.0
    stat["hi"] = max(0.0, stat["hi"] + (x - stat["ema"] - CUSUM_K))
    stat["lo"] = max(0.0, stat["lo"] + (stat["ema"] - x - CUSUM_K))
    stat["ema"] = EMA_ALPHA * x + (1 - EMA_ALPHA) * stat["ema"]
    stat["n"] += 1
    stat["streak"] = stat["streak"] + 1 if passed else 0
    stat["dirs"] = [*stat["dirs"], 1 if passed else -1][-POISONING_WINDOW:]


def rung_stats(revealed: list[tuple[Replay, dict[str, Any]]]) -> dict[int, dict[str, Any]]:
    """The adaptive thresholds after every check the replays have revealed, oldest first."""
    stats: dict[int, dict[str, Any]] = {}
    for _, event in revealed:
        if event.get("type") == "gate_result":
            rung = gate_rung(str(event.get("gate") or ""))
            if rung is not None:
                observe(stats, rung, bool(event.get("passed")))
    return stats


def suggested_retries(stat: dict[str, Any]) -> int:
    """roko's retry budget for a rung: the midpoint until 5 observations, then fewer as it passes more."""
    if stat["n"] < 5:
        return (MIN_RETRIES + MAX_RETRIES) // 2
    retries = round(MAX_RETRIES - stat["ema"] * (MAX_RETRIES - MIN_RETRIES))
    return max(MIN_RETRIES, min(MAX_RETRIES, retries))


def thresholds_file(stats: dict[int, dict[str, Any]]) -> dict[str, Any]:
    """`.roko/learn/gate-thresholds.json` as roko writes it."""
    return {
        "rungs": {
            str(rung): {
                "ema_pass_rate": round(stat["ema"], 4),
                "total_observations": stat["n"],
                "consecutive_passes": stat["streak"],
                "cusum_high": round(stat["hi"], 4),
                "cusum_low": round(stat["lo"], 4),
                "cusum_shift_detected": stat["hi"] > CUSUM_H or stat["lo"] > CUSUM_H,
                "poisoning_defense": {
                    "recent_directions": stat["dirs"],
                    "frozen": False,
                    "frozen_value": None,
                    "diverse_since_freeze": 0,
                    "window": POISONING_WINDOW,
                },
            }
            for rung, stat in sorted(stats.items())
        },
        "cusum_sensitivity": CUSUM_K,
        "cusum_threshold": CUSUM_H,
    }


def route_decision_rows(revealed: list[tuple[Replay, dict[str, Any]]]) -> list[dict[str, Any]]:
    """The router's decision rows (`.roko/runs/<run>/decisions.jsonl`, L-route), newest first: one per
    attempt the router routed, with its outcome once the attempt settled. A failover is not a decision."""
    by_run: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for run, event in revealed:
        by_run[run.run_id].append(event)
    rows = []
    for run_id, events in by_run.items():
        seq = 0
        for index, event in enumerate(events):
            if event.get("type") != "route_decided" or event.get("source") == "failover":
                continue
            seq += 1
            outcome, cost, latency = _attempt_outcome(events[index + 1 :], event)
            rows.append(_decision(run_id, event, seq, outcome, cost, latency))
    rows.sort(key=lambda row: row["ts"], reverse=True)
    return rows


def _attempt_outcome(
    later: list[dict[str, Any]], route: dict[str, Any]
) -> tuple[bool | None, float | None, int | None]:
    """Whether the attempt `route` started passed (None while it runs), what it cost, how long it took."""
    plan, task, attempt = route.get("plan_id"), route.get("task_id"), _int(route.get("attempt")) or 1
    cost, saw_cost, latency = 0.0, False, None
    for event in later:
        if event.get("plan_id") != plan or event.get("task_id") != task:
            continue
        kind = event.get("type")
        spent = round(cost, 6) if saw_cost else None
        if kind == "route_decided" and _int(event.get("attempt")) > attempt:
            return False, spent, latency  # another attempt followed: this one did not pass
        if kind == "efficiency_event" and event.get("metric") == "cost_usd":
            cost += float(event.get("value") or 0.0)
            saw_cost = True
        elif kind == "agent_completed" and latency is None:
            latency = max(0, _ms(event) - _ms(route))
        elif kind == "task_completed":
            return event.get("outcome") in ("passed", "already_satisfied"), spent, latency
        elif kind == "task_blocked":
            return False, spent, latency
    return None, (round(cost, 6) if saw_cost else None), latency


def _decision(
    run_id: str,
    route: dict[str, Any],
    seq: int,
    outcome: bool | None,
    cost: float | None,
    latency: int | None,
) -> dict[str, Any]:
    plan, task, attempt = (
        str(route.get("plan_id") or ""),
        str(route.get("task_id") or ""),
        _int(route.get("attempt")) or 1,
    )
    key = f"{run_id}:{plan}:{task}:{attempt}"
    model = str(route.get("model") or "")
    source = str(route.get("source") or "ladder")
    candidates = [candidate for candidate in route.get("candidates") or [] if isinstance(candidate, dict)]
    chosen = next((candidate for candidate in candidates if candidate.get("model") == model), {})
    learned = next(
        (str(candidate.get("model")) for candidate in candidates if candidate.get("eligible") is not False),
        None,
    )
    stamp = _iso(datetime.fromtimestamp(_ms(route) / 1000, UTC))
    return {
        "schema_version": "roko.decision/1",
        "record_id": "dec-" + hashlib.sha256(f"{key}:{seq}".encode()).hexdigest()[:16],
        "seq": seq,
        "ts": stamp,
        "timestamp": stamp,
        "trace_id": key,
        "task_id": task,
        "requested_model": DEFAULT_MODEL,
        "role": "implementer",
        "task_complexity": "focused",
        "task_category": "coding",
        "selected_provider": str(route.get("provider") or ""),
        "selected_model": model,
        "routing_stage": str(route.get("stage") or ""),
        "routing_reason": str(route.get("reason") or ""),
        "candidates": candidates,
        "outcome_success": outcome,
        "outcome_cost_usd": cost,
        "outcome_latency_ms": latency,
        "attempt_key": key,
        "source": source,
        "default_model": DEFAULT_MODEL,
        "chosen_propensity": chosen.get("p"),
        "decision_point": "route",
        "proposals": {
            "learned": learned,
            "default": DEFAULT_MODEL,
            "ladder": model if source == "ladder" else None,
            "aa": None,
        },
        "fallback_reason": None,
        "influences": [],
        "state": None,
        "loop_id": "L-route",
        "synthetic": True,
    }


def loop_rows(revealed: list[tuple[Replay, dict[str, Any]]]) -> list[dict[str, Any]]:
    """`GET /api/learn/loops`: each registered loop's audit state, from what the replays revealed. The
    measured loops' numbers grow as replays run, and a revealed transition moves a loop's state."""
    routes = [row for row in route_decision_rows(revealed) if row["outcome_success"] is not None]
    passed = sum(1 for row in routes if row["outcome_success"])
    lessons = [event for _, event in revealed if event.get("type") == "knowledge_written"]
    repeats = sum(1 for event in lessons if event.get("admission") == "duplicate")
    checks = sum(stat["n"] for stat in rung_stats(revealed).values())
    retries = sum(
        1
        for _, event in revealed
        if event.get("type") == "route_decided"
        and event.get("source") != "failover"
        and _int(event.get("attempt")) > 1
    )
    closed = sum(1 for _, event in revealed if event.get("type") == "plan_completed")
    moved = {
        str(event["loop_id"]): event
        for _, event in revealed
        if event.get("type") == "loop_transition" and event.get("loop_id")
    }
    rows = []
    for loop_id, lifecycle in REGISTRY:
        measured: tuple[str, str | None, int, float, float, float | None] | None = None
        if loop_id == "L-route" and routes:
            rate = passed / len(routes)
            state = "live" if closed >= 3 and len(routes) >= 8 and rate >= 0.6 else "probation"
            beta = rate - 0.55 if len(routes) >= 8 else None
            measured = (
                state,
                None,
                len(routes),
                0.01 + 0.06 * (1 - rate),
                min(0.42, 0.04 + 0.02 * len(routes)),
                beta,
            )
        elif loop_id == "L-know" and lessons:
            share = repeats / len(lessons)
            beta = 0.12 - 0.2 * share if len(lessons) >= 6 else None
            state = "live" if len(lessons) >= 6 else "probation"
            measured = (
                state,
                None,
                len(lessons),
                0.01 + 0.05 * share,
                min(0.3, 0.03 + 0.015 * len(lessons)),
                beta,
            )
        elif loop_id == "L-gate-thr" and checks:
            measured = ("probation", None, checks, 0.01, 0.0, None)
        elif loop_id == "L-retry-budget" and retries:
            measured = ("probation", None, retries, 0.02, 0.0, None)
        n_opp: int | None
        eps: float | None
        iota: float | None
        if measured is not None:
            state, reason, n_opp, eps, iota, beta = measured
        else:
            state, reason = QUIET.get(loop_id, ("probation", None))
            n_opp = eps = iota = beta = None
        if loop_id in moved:
            state, reason = str(moved[loop_id].get("to") or state), moved[loop_id].get("reason") or None
        rows.append(
            {
                "loop_id": loop_id,
                "lifecycle": lifecycle,
                "state": state,
                "reason": reason,
                "qualifiers": [],
                "h": 0.0 if lifecycle == "observe_only" else HOLDOUT.get(state, 0.2),
                "n_opp": n_opp,
                "eps": None if eps is None else round(eps, 4),
                "iota_net": None if iota is None else round(iota, 4),
                "beta": None if beta is None else round(beta, 4),
            }
        )
    return rows


def held_calls(run: Replay) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The run's held tool calls as `effects_pending` lists them: still waiting, and decided."""
    staged: dict[str, dict[str, Any]] = {}
    decided: dict[str, dict[str, Any]] = {}
    for event in run.index() or []:
        if event.get("type") == "effect_staged" and event.get("effect_id"):
            staged[str(event["effect_id"])] = event
        elif event.get("type") == "effect_decided" and event.get("effect_id"):
            decided[str(event["effect_id"])] = event
    waiting, done = [], []
    for effect_id, event in staged.items():
        item = {
            "effect_id": effect_id,
            "run_id": run.run_id,
            "plan_id": event.get("plan_id"),
            "task_id": event.get("task_id"),
            "attempt": event.get("attempt"),
            "tool": event.get("tool"),
            "server": event.get("server"),
            "arguments": HELD_ARGUMENTS,
            "proposed_at": event.get("proposed_at"),
        }
        answer = decided.get(effect_id) or run.effect_answers.get(effect_id)
        if answer is None:
            waiting.append(item)
            continue
        at = _ms(answer) or int(time.time() * 1000)
        done.append(
            {
                **item,
                "outcome": answer.get("outcome"),
                "decided_by": answer.get("decided_by"),
                "note": None,
                "receipts": [],
                "decided_at": _iso(datetime.fromtimestamp(at / 1000, UTC)),
            }
        )
    return waiting, done


def playbooks(revealed: list[tuple[Replay, dict[str, Any]]]) -> list[dict[str, Any]]:
    """`GET /api/learn/playbooks`: the playbooks roko kept, credited with the replays' task outcomes."""
    credit = {book["id"]: {"success": 0, "failure": 0, "last": None} for book in PLAYBOOKS}
    titles: dict[tuple[str, str], str] = {}
    for run, event in revealed:
        task = str(event.get("task_id") or "")
        if event.get("type") == "task_started":
            titles[(run.run_id, task)] = str(event.get("title") or "")
        elif event.get("type") == "task_completed" and event.get("outcome") in ("passed", "failed"):
            words = f"{titles.get((run.run_id, task), '')} {LABELS.get(run.fixture, '')}".lower()
            book = (
                "pb-python-cli-feature"
                if any(w in words for w in ("cli", "flag", "command"))
                else ("pb-python-module-tests")
            )
            credit[book]["success" if event["outcome"] == "passed" else "failure"] += 1
            credit[book]["last"] = _ms(event)
    out = []
    created = int(SEEDED_AT.timestamp() * 1000)
    for book in PLAYBOOKS:
        tally = credit[book["id"]]
        success = int(book["success_count"]) + tally["success"]
        failure = int(book["failure_count"]) + tally["failure"]
        out.append(
            {
                **book,
                "success_count": success,
                "failure_count": failure,
                "created_at_ms": created,
                "last_used_ms": tally["last"] or created + 86_400_000,
                "success_rate": round(success / (success + failure), 4) if success + failure else None,
                "synthetic": True,
            }
        )
    out.sort(key=lambda book: -int(book["success_count"]))
    return out


def reflexes(revealed: list[tuple[Replay, dict[str, Any]]]) -> list[dict[str, Any]]:
    """`GET /api/learn/reflexes`'s rules: the T0 reflexes the failed run's lesson promoted, firing on the
    replays' tool steps that use them."""
    fired = {"python3": [], "unittest": []}
    for _, event in revealed:
        record = _live_record(event)
        if not record or record.get("kind") != "tool_start":
            continue
        payload = record.get("payload") or {}
        target = str(payload.get("target") or "")
        if payload.get("tool") == "Bash" and target.startswith("python3"):
            fired["python3"].append(_ms(event))
            if "unittest" in target:
                fired["unittest"].append(_ms(event))
    rules = [
        ("python3", {"tool": "Bash", "args_pattern": "^python -m", "file_ext": ".py"}, "python3 -m", 0.94, 5),
        (
            "unittest",
            {"tool": "Bash", "args_pattern": "unittest$", "file_ext": ".py"},
            "python3 -m unittest discover",
            0.91,
            3,
        ),
    ]
    out = []
    for name, condition, args, confidence, base in rules:
        hits = fired[name]
        out.append(
            {
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"roko-replay-reflex/{name}")),
                "condition": {"context": None, "message_type": None, **condition},
                "action": {"tool": "Bash", "args": args},
                "confidence": confidence,
                "source_episode": "ep-e7fef800-T1-6",
                "promoted_at": _iso(SEEDED_AT),
                "last_fired_at": _iso(datetime.fromtimestamp(max(hits) / 1000, UTC)) if hits else None,
                "hit_count": base + len(hits),
                "success_count": base + len(hits),
                "synthetic": True,
            }
        )
    out.sort(key=lambda rule: -int(rule["hit_count"]))
    return out


def _live_record(event: dict[str, Any]) -> dict[str, Any] | None:
    content = event.get("content")
    if event.get("type") != "agent_output" or not isinstance(content, str) or not content.startswith(STREAM):
        return None
    try:
        record = json.loads(content[len(STREAM) :])
    except ValueError:
        return None
    return record if isinstance(record, dict) and record.get("live") else None


def _audit_record(run: Replay, event: dict[str, Any], kind: str) -> dict[str, Any]:
    """A revealed `loop_transition` as the loop-audit ledger keeps it."""
    return {
        "schema_version": "roko.loop_audit/1",
        "record_id": "la-" + hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()[:16],
        "ts": event.get("ts") or _iso(datetime.fromtimestamp(_ms(event) / 1000, UTC)),
        "loop_id": event.get("loop_id"),
        "run_id": run.run_id,
        "kind": kind,
        "from": event.get("from"),
        "to": event.get("to"),
        **({"reason": event["reason"]} if event.get("reason") else {}),
        "rule": event.get("rule") or "",
        "evidence": event.get("evidence") or "",
        "actor": event.get("actor") or "auditor",
        "synthetic": True,
    }


def _health_record(run: Replay, event: dict[str, Any], row: dict[str, Any]) -> dict[str, Any]:
    """A loop's latest health row (`loop.health`), its numbers the registry's."""
    n_opp = int(row["n_opp"] or 0)
    eps = float(row["eps"] or 0.0)
    iota = float(row["iota_net"] or 0.0)
    return {
        "schema_version": "roko.loop_audit/1",
        "record_id": "la-"
        + hashlib.sha256(f"{run.run_id}:{row['loop_id']}:{_ms(event)}".encode()).hexdigest()[:16],
        "ts": event.get("ts") or _iso(datetime.fromtimestamp(_ms(event) / 1000, UTC)),
        "loop_id": row["loop_id"],
        "run_id": run.run_id,
        "kind": "loop.health",
        "state": row["state"],
        **({"reason": row["reason"]} if row["reason"] else {}),
        "h": row["h"],
        "n_opp": n_opp,
        "n_L": round(n_opp * (1 - row["h"])),
        "n_D": n_opp - round(n_opp * (1 - row["h"])),
        "eps": {
            "est": eps,
            "ucb": round(eps * 1.8, 4),
            "read": 0.0,
            "reach": 0.0,
            "honest": 0.0,
            "receipt": 0.0,
        },
        "iota": {"act": round(iota + 0.05, 4), "aa": 0.05, "net": iota, "lcb": round(iota * 0.6, 4)},
        "beta": {"est": row["beta"]},
        "srm_evalue": 1.0,
        "synthetic": True,
    }


def _label(content: str) -> str:
    """roko's knowledge label: the content, cut after 80 characters."""
    return content if len(content) <= 80 else content[:80] + "…"


def _ms(event: dict[str, Any]) -> int:
    stamp = event.get("ts_millis")
    return stamp if isinstance(stamp, int) else 0


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


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


def build(
    speed: float, workdir: Path | None, *, tour: bool = False, recording: str = "dogfood"
) -> ReplayRoko:
    server = ReplayRoko()
    server.speed = speed
    server.tour = tour
    server.recording = recording
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
    for fixture in RECORDINGS[recording]["ended"]:
        server.replay(fixture, run_id=fixture_data(fixture)["run_id"], ended=True)
    server.replay(server.role("plan"), head_start_s=40.0)
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
    parser.add_argument("--tour", action="store_true", help="add every loop event to new plan runs")
    parser.add_argument(
        "--recording",
        choices=sorted(RECORDINGS),
        default="dogfood",
        help="replay the dogfood recordings (default) or the runs recorded from a live roko, as they were",
    )
    args = parser.parse_args()
    server = build(args.speed, args.workdir, tour=args.tour, recording=args.recording)
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

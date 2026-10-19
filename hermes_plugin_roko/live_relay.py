"""The live channel: roko's events pushed to the pages as they happen.

roko publishes every event of a Graph run on its StateHub at once (`GET /api/events`, server-sent
events, sub-second) and writes the durable copy into each run's index. The relay follows the hub in a
background thread and, for the runs Hermes started (and any a page asks for):

- pushes what an agent is doing right now (`live`: tool steps, words, heartbeats) and each of roko's
  loop events (`loop`, rings L0 to L4) the moment the hub has them;
- refreshes the run's card from its index soon after (debounced) and pushes the new card (`run`) and
  its new timeline lines (`lines`);
- refreshes the overview (`overview`) when a state, the spend or what waits on the person changes;
- tells the desktop app's global listeners through Hermes' plugin events (`plugin.roko.run.started`,
  `plugin.roko.run.ended`, `plugin.roko.waiting`), where this process has a gateway to tell.

One relay per process, started lazily (a page opens the `/live` socket; under the desktop app's
backend, a tool or a page starts a run or an overview finds one active) and stopped a minute after
nothing needs it. Each socket is a `Subscriber` with a bounded queue: the oldest `live` frames are
dropped first, and only the newest `run` frame per run is kept.

Since 0.7.0 each project has its own roko serve. The relay follows the hub of the default project's
serve; a run Hermes started in another project gets its card re-read every few seconds instead. A
socket names the project its page shows (`?project=`), whose overview its `hello` and `overview`
frames carry, and every socket hears when a project's roko serve changes state (`serve` frames,
from every Hermes process's starts and stops, seen through the files they leave).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import os
import socket
import threading
import time
from collections import OrderedDict, deque
from collections.abc import Iterable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import _hermes, loopevents, rundata, views
from .catalog import TERMINAL_STATES
from .errors import Code, RokoError
from .sanitize import clean
from .version import __version__

if TYPE_CHECKING:
    from .runtime import Runtime

logger = logging.getLogger(__name__)

PING_S = 15.0
IDLE_STOP_S = 60.0
# A run's card is rebuilt at most this often, and this long after the first event that changed it.
REFRESH_GAP_S = 0.6
REFRESH_SETTLE_S = 0.12
OVERVIEW_GAP_S = 1.5
# Without the hub (roko down, or an older roko), active runs are re-read this often instead.
POLL_FALLBACK_S = 3.0
MAP_TTL_S = 3.0
LIVE_PER_S = 20
# The lines a `check` live item's `tail` carries, at most.
CHECK_TAIL = 12
BEAT_GAP_S = 4.0
QUEUE_CAP = 400
RECENT_LOOPS = 120
ENDED_KEEP_S = 30.0
# A card built with problems (roko busy or rate-limited halfway through the run's index) is rebuilt
# after this long, doubling, this many times: a run that has ended sends no event that would.
PROBLEM_RETRY_S = 2.0
PROBLEM_RETRIES = 5
# The wait before reconnecting to the hub: short after a stream that was open, longer while roko is away.
BACKOFF_S = (0.3, 1.0, 2.0, 4.0, 8.0, 15.0)
# Loop events from a card that the hub did not deliver (before the graph was known, during a gap)
# are sent once, by key, when they happened after the relay began following the run (less this).
BACKFILL_GRACE_MS = 2000
SENT_KEYS_CAP = 2000
# A run's first events can reach the relay before the tool or page that started the run has said so (a fast
# run, a busy backend): events of no followed run are kept this long, and played again when one is followed.
UNMAPPED_KEEP_S = 10.0
UNMAPPED_CAP = 400
# How often the relay looks at the projects' roko serves for a `serve` frame (files only).
SERVE_WATCH_S = 2.0


def broadcast(event: str, payload: dict[str, Any]) -> None:
    """Emit `plugin.roko.<event>` to the desktop app's windows, when this process can (no-op otherwise)."""
    _hermes.broadcast_plugin_event(event, payload)


def desktop_backend() -> bool:
    """Whether this process is the desktop app's backend (`hermes serve`), whose windows want pushes
    even when no roko page is open (the status chip, notifications, the pet)."""
    return os.environ.get("HERMES_DESKTOP") == "1" or os.environ.get("HERMES_SERVE_HEADLESS") == "1"


class Subscriber:
    """One `/live` socket's queue, filled from the relay's threads and drained on its event loop."""

    def __init__(
        self, loop: asyncio.AbstractEventLoop, runs: Iterable[str] = (), project: Path | None = None
    ) -> None:
        self.loop = loop
        self.runs = set(runs)
        # The project the socket's page shows (its overview frames); None: the default project.
        self.project = project
        self._items: deque[dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._ready = asyncio.Event()
        self.closed = False
        self.dropped = 0

    def put(self, frame: dict[str, Any]) -> None:
        if self.closed:
            return
        with self._lock:
            kind = frame.get("type")
            if kind in ("run", "overview"):
                # Only the newest card of a run, and the newest overview, are worth sending.
                same = _run_id_of(frame) if kind == "run" else None
                self._items = deque(
                    item
                    for item in self._items
                    if not (item.get("type") == kind and (kind == "overview" or _run_id_of(item) == same))
                )
            self._items.append(frame)
            while len(self._items) > QUEUE_CAP:
                self._drop_one()
        try:
            self.loop.call_soon_threadsafe(self._ready.set)
        except RuntimeError:  # the socket's loop is gone
            self.closed = True

    def _drop_one(self) -> None:
        for kinds in (("live", "ping"), ("lines", "loop")):
            for index, item in enumerate(self._items):
                if item.get("type") in kinds:
                    del self._items[index]
                    self.dropped += 1
                    return
        self._items.popleft()
        self.dropped += 1

    def pending(self) -> int:
        with self._lock:
            return len(self._items)

    async def get(self, timeout: float) -> dict[str, Any] | None:
        """The next frame, or None after `timeout` seconds without one."""
        deadline = self.loop.time() + timeout
        while True:
            with self._lock:
                if self._items:
                    return self._items.popleft()
            self._ready.clear()
            remaining = deadline - self.loop.time()
            if remaining <= 0:
                return None
            try:
                await asyncio.wait_for(self._ready.wait(), remaining)
            except TimeoutError:
                return None


def _task_key(event: dict[str, Any]) -> str:
    """A task's key in a run the relay follows: its plan and its id (two plans may each have a T1)."""
    return f"{event.get('plan_id') or ''}/{event.get('task_id') or ''}"


@dataclass
class Tracked:
    """A run the relay follows."""

    run_id: str
    kind: str | None = None
    label: str | None = None
    # The project the run ran in (0.7.0), when the run log says; None: the default project.
    project: str | None = None
    plans: set[str] = field(default_factory=set)
    ctx: loopevents.LoopContext = field(default_factory=loopevents.LoopContext)
    seeded: bool = False
    dirty_since: float | None = None
    last_refresh: float = 0.0
    state: str | None = None
    cost: float | None = None
    waiting: set[str] = field(default_factory=set)
    line_cursor: int | None = None
    ended_at: float | None = None
    explicit: int = 0
    live_times: deque[float] = field(default_factory=lambda: deque(maxlen=LIVE_PER_S))
    # Live frames over the rate, waiting for the next window: the newest per task and kind (a newer
    # words frame carries the older words in `said`, so none are lost).
    pending_live: dict[str, dict[str, Any]] = field(default_factory=dict)
    # Per task: the stretch its agent is speaking in (attempt and kind) and the tail of what it said.
    said: dict[str, tuple[str, str]] = field(default_factory=dict)
    # Per task (`plan/task`): the latest try the relay saw start, so a check line that names no try is
    # placed on it; and the check printing now on that try and its last lines (a `check` item's `tail`).
    tries: dict[str, int] = field(default_factory=dict)
    checks: dict[str, tuple[str, deque[str]]] = field(default_factory=dict)
    # Tool calls already sent, by tool id, and whether that frame named a target: in trusted mode roko
    # publishes a call twice (its tool-steps record, with the target, and the trusted one, with the
    # arguments), and a page should see one step.
    tool_ids: OrderedDict[str, bool] = field(default_factory=OrderedDict)
    beats: dict[str, float] = field(default_factory=dict)
    # Cards in a row that came back with problems, and when the next is rebuilt (see PROBLEM_RETRY_S).
    problem_cards: int = 0
    retry_at: float | None = None
    # Whether this process saw the run start (so whatever waits on its first card is news).
    announce: bool = False
    # Whether the run's own plan ids are known (beyond the ids named after the run itself).
    learned: bool = False
    # When the relay began following the run (ms since the epoch), and the loop keys already sent.
    since_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    sent_loops: set[str] = field(default_factory=set)

    def mark_sent(self, key: Any) -> bool:
        """Remember a loop event's key; False when it was sent before."""
        if not isinstance(key, str) or not key:
            return True
        if key in self.sent_loops:
            return False
        if len(self.sent_loops) >= SENT_KEYS_CAP:
            self.sent_loops.clear()
        self.sent_loops.add(key)
        return True

    @property
    def active(self) -> bool:
        return self.ended_at is None and self.state not in TERMINAL_STATES


class LiveRelay:
    """Follows roko's hub for this process and pushes frames to every subscriber."""

    def __init__(self, rt: Runtime) -> None:
        self.rt = rt
        self._lock = threading.RLock()
        self._subs: set[Subscriber] = set()
        self._tracked: dict[str, Tracked] = {}
        self._plan_map: dict[str, str] = {}
        self._map_at = 0.0
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._response: Any = None
        self._last_event_id: str | None = None
        self._overview_wanted = False
        self._overview_at = 0.0
        self._ping_at = time.monotonic()
        self._idle_since: float | None = None
        self._started_ms = int(time.time() * 1000)
        self._global_ctx = loopevents.LoopContext()
        self._unmapped: deque[tuple[float, dict[str, Any]]] = deque(maxlen=UNMAPPED_CAP)
        # Events of a run just followed, taken from `_unmapped` to be handled again (`_drain_replays`).
        self._replays: list[dict[str, Any]] = []
        self.recent_loops: deque[dict[str, Any]] = deque(maxlen=RECENT_LOOPS)
        self.hub_state = "stopped"
        self.events_seen = 0
        # The project whose roko serve's hub the relay follows, and how each project's serve last looked.
        self._hub_project: str | None = None
        self._serves: dict[str, tuple[Any, ...]] = {}
        self._serves_at = 0.0

    # -- life cycle ---------------------------------------------------------------------

    @property
    def running(self) -> bool:
        return any(thread.is_alive() for thread in self._threads)

    def ensure_running(self) -> None:
        with self._lock:
            if self.running:
                return
            self._stop = threading.Event()
            self._idle_since = None
            self._started_ms = int(time.time() * 1000)
            self._threads = [
                threading.Thread(target=self._hub_loop, name="roko-live-hub", daemon=True),
                threading.Thread(target=self._work_loop, name="roko-live-work", daemon=True),
            ]
            for thread in self._threads:
                thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._interrupt_hub()
        for thread in list(self._threads):
            if thread is not threading.current_thread():
                thread.join(timeout=3)
        self.hub_state = "stopped"

    # -- what the rest of the plugin calls ---------------------------------------------

    def subscribe(
        self, loop: asyncio.AbstractEventLoop, runs: Iterable[str] = (), project: Path | None = None
    ) -> Subscriber:
        sub = Subscriber(loop, runs, project)
        with self._lock:
            self._subs.add(sub)
            for run_id in sub.runs:
                self._follow(run_id).explicit += 1
        self._drain_replays()
        self.ensure_running()
        return sub

    def unsubscribe(self, sub: Subscriber) -> None:
        sub.closed = True
        with self._lock:
            self._subs.discard(sub)
            for run_id in sub.runs:
                tracked = self._tracked.get(run_id)
                if tracked is not None:
                    tracked.explicit = max(0, tracked.explicit - 1)

    def subscribers(self) -> int:
        with self._lock:
            return len(self._subs)

    def hello(self, project: Path | None = None) -> dict[str, Any]:
        """The first frame of a socket: the overview of the project its page shows, as `GET /overview`
        answers it."""
        try:
            overview: dict[str, Any] | None = views.ui_overview(self.rt.scoped(project))
            problem = None
        except RokoError as exc:
            overview, problem = None, {"code": exc.code.value, "message": exc.message, "hint": exc.hint}
        frame: dict[str, Any] = {
            "type": "hello",
            "version": __version__,
            "overview": overview,
            "server_time": rundata.now_iso(),
            "hub": self.hub_state,
        }
        if problem:
            frame["error"] = problem
        return frame

    def track(
        self,
        run_id: str,
        *,
        kind: str,
        label: str | None = None,
        state: str | None = None,
        plan_id: str | None = None,
        max_usd: float | None = None,
        source: str | None = None,
        project: str | None = None,
    ) -> None:
        """A tool or a page started `run_id`: tell the desktop app, and follow it while anyone listens."""
        try:
            broadcast(
                "run.started",
                {
                    "run_id": run_id,
                    "kind": kind,
                    "label": clean(label, 120, one_line=True) or None,
                    "state": state,
                    "plan_id": plan_id,
                    "max_usd": max_usd,
                    "source": source,
                },
            )
            with self._lock:
                tracked = self._follow(run_id, kind=kind, plan_id=plan_id, label=label, project=project)
                tracked.announce = True
                tracked.state = state or tracked.state
                tracked.dirty_since = time.monotonic()
                self._overview_wanted = True
                wanted = bool(self._subs)
            self._drain_replays()
            if wanted or desktop_backend():
                self.ensure_running()
        except Exception:
            logger.debug("roko: could not follow run %s", run_id, exc_info=True)

    def notice(self, rows: list[dict[str, Any]]) -> None:
        """An overview was built: under the desktop app, follow its active runs."""
        if desktop_backend() and any(row.get("active") for row in rows):
            self.ensure_running()

    def serve_changed(self, project: Path) -> None:
        """A project's roko serve may have changed state (serve.py started, stopped or restarted it): send a
        `serve` frame to every socket when it did. Files only: this never waits on the network."""
        from . import serve as serving

        try:
            state = serving.serve_state(self.rt, project, look=False)
        except Exception:
            logger.debug("roko: could not look at roko serve for %s", project, exc_info=True)
            return
        if state is None:
            return
        key = str(project)
        with self._lock:
            if self._serves.get(key) == state.signature():
                return
            self._serves[key] = state.signature()
            self._overview_wanted = True
        self._publish([{"type": "serve", "serve": state.as_dict()}])

    def _watch_serves(self) -> None:
        """Every SERVE_WATCH_S: the serves of the known projects and the pages' projects (another Hermes
        process may have started one; one may have stopped itself when idle)."""
        try:
            projects = {str(path) for path in self.rt.projects.paths()}
        except Exception:
            projects = set()
        with self._lock:
            projects |= {str(sub.project) for sub in self._subs if sub.project is not None}
        for project in sorted(projects):
            self.serve_changed(Path(project))

    def poke(self, run_id: str | None) -> None:
        """Something changed a run from this side (an answer, a cancel): rebuild its card soon."""
        with self._lock:
            tracked = self._tracked.get(run_id or "")
            if tracked is not None:
                tracked.dirty_since = time.monotonic()
            self._overview_wanted = True

    # -- the hub ------------------------------------------------------------------------

    def _hub_loop(self) -> None:
        failures = 0
        opened = False
        while not self._stop.is_set():
            try:
                self.hub_state = "connecting"
                client = self.rt.client()
                self._hub_project = str(client.settings.workdir) if client.settings.workdir else None
                headers = {"Last-Event-ID": self._last_event_id} if self._last_event_id else None
                with client.stream("/api/events", headers=headers) as response:
                    self._response = response
                    if self._stop.is_set():
                        break
                    self.hub_state = "open"
                    failures = 0
                    if opened:
                        self._refresh_all()  # whatever happened while the hub was away is on the cards
                    opened = True
                    for name, data, ident in sse_events(response.iter_lines()):
                        if self._stop.is_set():
                            break
                        self.on_sse(name, data, ident)
            except RokoError as exc:
                logger.debug("roko: live hub: %s", exc.message)
            except Exception:
                if not self._stop.is_set():
                    logger.debug("roko: live hub stopped", exc_info=True)
            finally:
                self._response = None
            if self._stop.is_set():
                break
            self.hub_state = "backoff"
            self._stop.wait(BACKOFF_S[min(failures, len(BACKOFF_S) - 1)])
            failures += 1
        self.hub_state = "stopped"

    def _refresh_all(self) -> None:
        with self._lock:
            now = time.monotonic()
            for tracked in self._tracked.values():
                tracked.dirty_since = now
            self._overview_wanted = True

    def _interrupt_hub(self) -> None:
        """Wake the hub thread from its blocking read so it sees the stop at once.

        Shutting the socket down ends the read (closing the response from this thread would not, and
        would race the reading thread); the hub thread then closes its own response.
        """
        response = self._response
        if response is None:
            return
        try:
            stream = response.extensions.get("network_stream")
            sock = stream.get_extra_info("socket") if stream is not None else None
        except Exception:
            sock = None
        if isinstance(sock, socket.socket):
            with contextlib.suppress(OSError):
                sock.shutdown(socket.SHUT_RDWR)
            return
        with contextlib.suppress(Exception):
            response.close()

    def on_sse(self, name: str, data: str, ident: str | None) -> None:
        """One server-sent event from roko's hub."""
        self.events_seen += 1
        if name == "keepalive":
            return
        if ident:
            self._last_event_id = ident
        if name == "gap":
            # roko dropped events this relay missed: every card is rebuilt from the run's index.
            self._refresh_all()
            return
        if name not in ("message", "") or not data:
            return
        try:
            event = json.loads(data)
        except ValueError:
            return
        if isinstance(event, dict):
            self.handle_event(event)

    def handle_event(self, event: dict[str, Any]) -> None:
        """One roko event: push what it shows now, and schedule its run's card. Then the earlier events of
        a run this one made the relay follow, if any (`_claim_unmapped`)."""
        try:
            self._handle_event(event)
        finally:
            self._drain_replays()

    def _handle_event(self, event: dict[str, Any]) -> None:
        kind = str(event.get("type") or "")
        if not kind:
            return
        frames: list[dict[str, Any]] = []
        now = time.monotonic()
        if kind == "error" and self._start_failed(event):
            return
        with self._lock:
            run_id = self._run_for(kind, event)
            unplanned = loopevents.unplanned(kind, event)
            if run_id is None and unplanned:
                active = [tracked for tracked in self._tracked.values() if tracked.active]
                run_id = active[0].run_id if len(active) == 1 else None
            tracked = self._tracked.get(run_id) if run_id else None
            if tracked is None and not unplanned:
                stamp = event.get("ts_millis")
                if not (isinstance(stamp, int) and stamp < self._started_ms - BACKFILL_GRACE_MS):
                    self._unmapped.append((now, event))
                self._nudge_unlearned(now)
                return
            # roko replays its recent events to a new connection: what happened before the relay
            # followed the run (or, for events of no run, before it started) is history, which the
            # cards already show. It still feeds the loop context, so later events number right.
            stamp = event.get("ts_millis")
            floor = tracked.since_ms if tracked is not None else self._started_ms
            history = isinstance(stamp, int) and stamp < floor - BACKFILL_GRACE_MS
            if kind == "agent_heartbeat":
                if tracked is not None and not history:
                    task = str(event.get("task_id") or "")
                    if now - tracked.beats.get(task, 0.0) >= BEAT_GAP_S:
                        tracked.beats[task] = now
                        frames.append({"type": "live", "run_id": run_id, **loopevents.heartbeat(event)})
            else:
                urgent = False
                if tracked is not None:
                    self._check_bounds(tracked, kind, event)
                if kind == "gate_output_line" and tracked is not None and not history:
                    line = loopevents.check_line(event)
                    if line is not None:
                        self._queue_live(tracked, self._with_tail(tracked, line), frames, now)
                if kind == "agent_output" and tracked is not None and not history:
                    item = loopevents.live_record(event)
                    if item is not None and not self._seen_tool(tracked, item):
                        said = self._with_said(tracked, item)
                        # A chunk that is only the space between two words joins `said`; the next
                        # word's frame carries it.
                        if (
                            said.get("kind") not in ("text", "reasoning")
                            or str(said.get("text") or "").strip()
                        ):
                            self._queue_live(tracked, said, frames, now)
                ctx = tracked.ctx if tracked is not None else self._global_ctx
                for loop in loopevents.loop_events(kind, event, ctx):
                    if history or (tracked is not None and not tracked.mark_sent(loop.get("key"))):
                        continue
                    if loop["kind"] in ("route", "failover") and tracked is not None:
                        # A run Hermes started cannot use a model whose agent runs its own tools.
                        chat_run = tracked.kind is not None
                        loop = {**loop, "data": loopevents.route_view(loop["data"], chat_run=chat_run)}
                    frame = {"type": "loop", "run_id": run_id, **loop}
                    frames.append(frame)
                    self.recent_loops.append(frame)
                    if loop["kind"] in ("hold", "tool_held"):
                        # Something waits on the person (or stopped waiting): the card says what,
                        # with its code, and the desktop hears of it from there (`waiting`).
                        urgent = True
                        self._overview_wanted = True
                if tracked is not None:
                    if kind == "run_completed" or urgent:
                        tracked.dirty_since = 0.0  # now, not after the debounce
                    elif tracked.dirty_since is None:
                        tracked.dirty_since = now
        self._publish(frames)

    def _claim_unmapped(self, tracked: Tracked) -> None:
        """`tracked` was just followed: take its events that came before (see UNMAPPED_KEEP_S) for handling
        again, as this run's own first moments rather than history. Called with the lock held."""
        now = time.monotonic()
        kept: deque[tuple[float, dict[str, Any]]] = deque(maxlen=UNMAPPED_CAP)
        mine: list[dict[str, Any]] = []
        for seen, event in self._unmapped:
            if now - seen > UNMAPPED_KEEP_S:
                continue
            plan = loopevents.event_scope(str(event.get("type") or ""), event)[0]
            if event.get("run_id") == tracked.run_id or (plan and plan in tracked.plans):
                mine.append(event)
            else:
                kept.append((seen, event))
        self._unmapped = kept
        if not mine:
            return
        stamps = [event["ts_millis"] for event in mine if isinstance(event.get("ts_millis"), int)]
        if stamps:
            tracked.since_ms = min(tracked.since_ms, min(stamps))
        self._replays.extend(mine)

    def _drain_replays(self) -> None:
        """Handle again the events claimed for runs just followed, oldest first."""
        while True:
            with self._lock:
                if not self._replays:
                    return
                events, self._replays = self._replays, []
            for event in events:
                self.handle_event(event)

    def _start_failed(self, event: dict[str, Any]) -> bool:
        """An unscoped hub error saying roko could not start a plan: put the reason on the card of the run
        Hermes follows for that plan. True when it was one."""
        found = rundata.start_failure(event.get("message"))
        if found is None or event.get("run_id") or event.get("plan_id"):
            return False
        plan, why = found
        with self._lock:
            if time.monotonic() - self._map_at > 1.0:
                self._refresh_map()
            run_id = self._plan_map.get(plan)
            tracked = self._tracked.get(run_id) if run_id else None
            stamp = event.get("ts_millis")
            if tracked is None or (isinstance(stamp, int) and stamp < tracked.since_ms - BACKFILL_GRACE_MS):
                return True  # no run of ours, or an earlier run's (roko replays recent events on connect)
            tracked.dirty_since = 0.0
        tracker = self.rt.cards.tracker(self._run_url(tracked.run_id), tracked.run_id)
        with tracker.lock:
            tracker.start_error = why or None
            tracker.final = None
        return True

    def _nudge_unlearned(self, now: float) -> None:
        """An event of a plan no followed run is known to hold: a run a page follows by its id may not
        have said which plans it runs yet (roko names them in its rows), so rebuild those runs' cards,
        which learns their plans from the rows (`_seed`), and the next events map."""
        for tracked in self._tracked.values():
            if tracked.active and not tracked.learned and tracked.dirty_since is None:
                tracked.dirty_since = now

    @staticmethod
    def _seen_tool(tracked: Tracked, item: dict[str, Any]) -> bool:
        """Whether this tool step was already sent: a second record of the same call is dropped,
        unless it names the target the first one did not."""
        if item.get("kind") != "tool" or not item.get("tool_id"):
            return False
        ident = str(item["tool_id"])
        named = bool(item.get("target"))
        if ident in tracked.tool_ids and (tracked.tool_ids[ident] or not named):
            return True
        tracked.tool_ids[ident] = named
        while len(tracked.tool_ids) > 400:
            tracked.tool_ids.popitem(last=False)
        return False

    @staticmethod
    def _with_said(tracked: Tracked, item: dict[str, Any]) -> dict[str, Any]:
        """roko streams an agent's words a token at a time: a words frame also carries `said`, the tail
        of what the task's agent has said in this stretch (since its last tool call, in this attempt
        and kind), so a page shows what it is saying rather than its newest token."""
        task = str(item.get("task_id") or "")
        kind = item.get("kind")
        if kind in ("text", "reasoning"):
            stretch = f"{item.get('attempt')}:{kind}"
            before, tail = tracked.said.get(task, ("", ""))
            joined = (tail if before == stretch else "") + str(item.get("text") or "")
            tracked.said[task] = (stretch, joined[-loopevents.LIVE_TEXT_CHARS :])
            return {**item, "said": tracked.said[task][1]}
        if kind == "tool":
            tracked.said.pop(task, None)
        return item

    @staticmethod
    def _with_tail(tracked: Tracked, item: dict[str, Any]) -> dict[str, Any]:
        """A check's line also carries `tail`, the check's last lines so far on this try, so a page that
        missed lines over the rate still shows the check as it stands. The line's try is roko's `attempt`,
        else the latest the relay saw the task start; another check, or the same one on a new try, starts a
        new tail (as does a line after the check's result, `_check_bounds`)."""
        key = _task_key(item)
        attempt = item.get("attempt") or tracked.tries.get(key)
        check = f"{item.get('gate') or ''}#{attempt or ''}"
        printing, lines = tracked.checks.get(key, ("", deque()))
        if printing != check:
            lines = deque(maxlen=CHECK_TAIL)
        lines.append(str(item["line"]))
        tracked.checks[key] = (check, lines)
        return {**item, "attempt": attempt, "tail": list(lines)}

    @staticmethod
    def _check_bounds(tracked: Tracked, kind: str, event: dict[str, Any]) -> None:
        """Where a task's check output starts and ends on the socket: a try that starts (its route or its
        agent, with a higher attempt) and a check's result each end the tail, so the next line starts a new
        one and a try never shows an earlier try's lines."""
        key = _task_key(event)
        if kind in ("route_decided", "agent_spawned"):
            attempt = event.get("attempt")
            if (
                isinstance(attempt, int)
                and not isinstance(attempt, bool)
                and attempt > tracked.tries.get(key, 0)
            ):
                tracked.tries[key] = attempt
                tracked.checks.pop(key, None)
        elif kind == "gate_result":
            tracked.checks.pop(key, None)

    def _queue_live(
        self, tracked: Tracked, item: dict[str, Any], frames: list[dict[str, Any]], now: float
    ) -> None:
        times = tracked.live_times
        if tracked.pending_live or (len(times) == LIVE_PER_S and now - times[0] < 1.0):
            # Over the rate (or behind frames that are): the newest per task and kind waits for the
            # next window, after what waited before it.
            key = f"{item.get('task_id')}:{item.get('kind')}"
            tracked.pending_live.pop(key, None)
            tracked.pending_live[key] = item
            return
        times.append(now)
        frames.append({"type": "live", "run_id": tracked.run_id, **item})

    def _flush_live(self, tracked: Tracked) -> None:
        """Send the live frames that waited for the rate, as far as it allows now."""
        frames: list[dict[str, Any]] = []
        with self._lock:
            waiting, tracked.pending_live = tracked.pending_live, {}
            for item in waiting.values():
                self._queue_live(tracked, item, frames, time.monotonic())
        self._publish(frames)

    # -- which run an event belongs to -----------------------------------------------------

    def _follow(
        self,
        run_id: str,
        *,
        kind: str | None = None,
        plan_id: str | None = None,
        label: str | None = None,
        project: str | None = None,
    ) -> Tracked:
        tracked = self._tracked.get(run_id)
        new = tracked is None
        if tracked is None:
            tracked = self._tracked[run_id] = Tracked(run_id, dirty_since=time.monotonic())
        if kind:
            tracked.kind = kind
        if project:
            tracked.project = project
        if label:
            tracked.label = clean(label, 160, one_line=True)
        known = set(tracked.plans)
        tracked.plans |= plan_keys(run_id, plan_id)
        # A prompt run's plan is named after the run; a plan run's plan is given.
        tracked.learned = tracked.learned or kind == "run" or bool(plan_id)
        for plan in tracked.plans:
            self._plan_map[plan] = run_id
        if new or tracked.plans != known:
            self._claim_unmapped(tracked)
        return tracked

    def _run_for(self, kind: str, event: dict[str, Any]) -> str | None:
        run_id = event.get("run_id")
        if isinstance(run_id, str) and run_id in self._tracked:
            return run_id
        plan = loopevents.event_scope(kind, event)[0]
        if not plan:
            return None
        found = self._plan_map.get(plan)
        if found is None and time.monotonic() - self._map_at > 1.0:
            self._refresh_map()
            found = self._plan_map.get(plan)
        return found

    def _refresh_map(self) -> None:
        """Follow the runs the run log says are active, and forget runs that ended a while ago."""
        self._map_at = time.monotonic()
        try:
            runs = self.rt.runs.recent(50)
        except Exception:
            runs = []
        for run in runs:
            if run.get("kind") not in ("run", "plan") or run.get("state") in TERMINAL_STATES:
                continue
            run_id = str(run.get("run_id") or "")
            if run_id:
                self._follow(
                    run_id,
                    kind=run.get("kind"),
                    plan_id=run.get("plan_id"),
                    label=run.get("label"),
                    project=run.get("project") if isinstance(run.get("project"), str) else None,
                )
        now = time.monotonic()
        for run_id, tracked in list(self._tracked.items()):
            if (
                tracked.ended_at is not None
                and not tracked.explicit
                and now - tracked.ended_at > ENDED_KEEP_S
            ):
                del self._tracked[run_id]
        self._plan_map = {
            plan: run_id
            for run_id, tracked in sorted(self._tracked.items(), key=lambda item: not item[1].active)
            for plan in tracked.plans
        }
        # An active run wins a plan id over an ended one (a plan run again reuses its plan's id).
        for run_id, tracked in self._tracked.items():
            if tracked.active:
                for plan in tracked.plans:
                    self._plan_map[plan] = run_id

    # -- the worker: cards, overviews, pings, idling ------------------------------------------

    def _work_loop(self) -> None:
        last_map = 0.0
        while not self._stop.wait(0.1):
            now = time.monotonic()
            if now - self._serves_at >= SERVE_WATCH_S:
                self._serves_at = now
                self._watch_serves()
            with self._lock:
                if now - last_map >= MAP_TTL_S:
                    last_map = now
                    self._refresh_map()
                    for tracked in self._tracked.values():
                        if self._polled(tracked) and now - tracked.last_refresh >= POLL_FALLBACK_S:
                            tracked.dirty_since = tracked.dirty_since or now
                due = self._due(now)
                waiting_live = [tracked for tracked in self._tracked.values() if tracked.pending_live]
            # A run the map just found may have early events waiting: they go out before its card.
            self._drain_replays()
            for tracked in due:
                self._refresh(tracked)
            for tracked in waiting_live:
                self._flush_live(tracked)
            if self._overview_wanted and now - self._overview_at >= OVERVIEW_GAP_S:
                self._push_overview()
            if now - self._ping_at >= PING_S:
                self._ping_at = now
                self._publish([{"type": "ping", "server_time": rundata.now_iso(), "hub": self.hub_state}])
            if self._idle(now):
                self._stop.set()
                self._interrupt_hub()
                return

    def _polled(self, tracked: Tracked) -> bool:
        """Whether an active run's card is read again every few seconds, not only when the hub says it
        changed: with the hub away, for a plan writing, whose stages roko publishes on no hub event
        (gap-11d870: its run_status says them), and for a run in another project than the hub's (0.7.0)."""
        elsewhere = tracked.project is not None and tracked.project != self._hub_project
        return tracked.active and (self.hub_state != "open" or tracked.kind == "plan_generate" or elsewhere)

    def _due(self, now: float) -> list[Tracked]:
        """The runs whose cards are rebuilt now: changed a moment ago, or due to be tried again."""
        return [
            tracked
            for tracked in self._tracked.values()
            if (
                (tracked.dirty_since is not None and now - tracked.dirty_since >= REFRESH_SETTLE_S)
                or (tracked.retry_at is not None and now >= tracked.retry_at)
            )
            and now - tracked.last_refresh >= REFRESH_GAP_S
        ]

    def _idle(self, now: float) -> bool:
        with self._lock:
            followed = any(tracked.active for tracked in self._tracked.values())
            busy = bool(self._subs) or (followed and desktop_backend())
        if busy:
            self._idle_since = None
            return False
        if self._idle_since is None:
            self._idle_since = now
        return now - self._idle_since >= IDLE_STOP_S

    def _refresh(self, tracked: Tracked) -> None:
        tracked.dirty_since = tracked.retry_at = None
        tracked.last_refresh = time.monotonic()
        try:
            card = views.card(self.rt, tracked.run_id)
        except RokoError as exc:
            if exc.code is Code.NOT_FOUND and tracked.ended_at is None and not tracked.explicit:
                tracked.ended_at = time.monotonic()
            logger.debug("roko: live card for %s: %s", tracked.run_id, exc.message)
            return
        except Exception:
            logger.exception("roko: could not build the live card of %s", tracked.run_id)
            return
        # The deltas first (new lines, loop events the hub missed), then the card they add up to.
        frames: list[dict[str, Any]] = []
        notices: list[tuple[str, dict[str, Any]]] = []
        with self._lock:
            lines = self._new_lines(tracked, card)
            if lines:
                frames.append({"type": "lines", "run_id": tracked.run_id, "lines": lines})
            for loop in self._missed_loops(tracked, card):
                frame = {"type": "loop", "run_id": tracked.run_id, **loop}
                frames.append(frame)
                self.recent_loops.append(frame)
            state = str(card.get("state") or "")
            was = tracked.state
            tracked.state = state
            if state in TERMINAL_STATES:
                if tracked.ended_at is None:
                    tracked.ended_at = time.monotonic()
                if was is not None and was not in TERMINAL_STATES:
                    notices.append(
                        (
                            "run.ended",
                            {
                                "run_id": tracked.run_id,
                                "state": state,
                                "label": card.get("label"),
                                "cost_usd": card.get("cost_usd"),
                                "headline": card.get("headline"),
                                "interrupted": card.get("interrupted"),
                            },
                        )
                    )
            if was != state:
                self._overview_wanted = True
            cost = card.get("cost_usd") if isinstance(card.get("cost_usd"), (int, float)) else None
            if cost != tracked.cost:
                tracked.cost = cost
                self._overview_wanted = True
            codes = {str(item.get("code")) for item in card.get("waiting") or [] if item.get("code")}
            # What already waited when the relay began following a run it did not see start is old news.
            fresh = codes - tracked.waiting if tracked.seeded or tracked.announce else set()
            tracked.waiting = codes
            for item in card.get("waiting") or []:
                if str(item.get("code")) in fresh:
                    payload = {
                        "run_id": tracked.run_id,
                        "code": item.get("code"),
                        "kind": item.get("kind"),
                        "title": item.get("title"),
                        "question": item.get("question"),
                        "task_id": item.get("task_id"),
                    }
                    notices.append(("waiting", payload))
                    self._overview_wanted = True
            self._seed(tracked, card)
            if not card.get("problems"):
                tracked.problem_cards = 0
            elif tracked.problem_cards < PROBLEM_RETRIES:
                tracked.retry_at = time.monotonic() + PROBLEM_RETRY_S * 2**tracked.problem_cards
                tracked.problem_cards += 1
        frames.append({"type": "run", "run": card})
        self._publish(frames)
        for name, payload in notices:
            broadcast(name, payload)

    def _seed(self, tracked: Tracked, card: dict[str, Any]) -> None:
        """What classifying the run's next events needs, from its card: plans, waves, attempts so far.

        A running run's card may not name its plans yet (roko lists them when the run closes); the
        plans its rows name are on the fold, so a run followed by its id is mapped from its first rows.
        """
        tracker = self.rt.cards.tracker(self._run_url(tracked.run_id), tracked.run_id)
        with tracker.lock:
            seen = sorted(set(tracker.fold.plans) | {plan for plan, _task in tracker.fold.tasks})
        for plan in [*(card.get("plan_ids") or []), *seen]:
            if isinstance(plan, str) and plan:
                tracked.plans.add(plan)
                if tracked.active or self._plan_map.get(plan) is None:
                    self._plan_map[plan] = tracked.run_id
        tracked.learned = tracked.learned or bool(tracked.plans - plan_keys(tracked.run_id))
        waves = (card.get("graph") or {}).get("waves") or []
        if waves:
            tracked.ctx.set_waves([list(wave) for wave in waves])
        if tracked.seeded:
            return
        tracked.seeded = True
        tracked.label = tracked.label or card.get("label")
        for task in card.get("tasks") or []:
            task_id = str(task.get("task_id") or "")
            plan = str(task.get("plan_id") or (card.get("plan_ids") or [tracked.run_id])[0])
            attempts = task.get("attempts") or 0
            if task_id and attempts:
                tracked.ctx.attempts[(plan, task_id)] = (int(attempts), str(task.get("model") or "?"))
                tracked.ctx.spawns[(plan, task_id)] = int(attempts)
            if task_id and task.get("started_at") and task_id in tracked.ctx.wave_of:
                tracked.ctx.waves_open.add(tracked.ctx.wave_of[task_id])

    def _missed_loops(self, tracked: Tracked, card: dict[str, Any]) -> list[dict[str, Any]]:
        """The card's loop events the hub path did not send: a wave that opened before the plan's
        graph was known, or anything published while the hub was away. History from before the
        relay followed the run stays on the card."""
        floor = tracked.since_ms - BACKFILL_GRACE_MS
        missed = []
        for loop in card.get("loops") or []:
            ts = loop.get("ts")
            if not isinstance(ts, int) or ts < floor:
                continue
            if tracked.mark_sent(loop.get("key")):
                missed.append(loop)
        return missed

    def _new_lines(self, tracked: Tracked, card: dict[str, Any]) -> list[dict[str, Any]]:
        """Timeline lines written since the last card. The first time, only those written after the
        relay began following the run: older ones are history, which a page reads with `/events`."""
        tracker = self.rt.cards.tracker(self._run_url(tracked.run_id), tracked.run_id)
        with tracker.lock:
            entries = list(tracker.fold.timeline)
        top = max((int(entry.get("cursor") or 0) for entry in entries), default=0)
        if tracked.line_cursor is None:
            tracked.line_cursor = top
            floor = tracked.since_ms - BACKFILL_GRACE_MS
            recent = [
                entry
                for entry in entries
                if isinstance(entry.get("ts_millis"), int) and entry["ts_millis"] >= floor
            ]
            return rundata.retitle(recent, card.get("label"))
        fresh = [entry for entry in entries if int(entry.get("cursor") or 0) > tracked.line_cursor]
        tracked.line_cursor = max(tracked.line_cursor, top)
        return rundata.retitle(fresh, card.get("label"))

    def _push_overview(self) -> None:
        """The overview of each project a socket's page shows, to those sockets."""
        self._overview_wanted = False
        self._overview_at = time.monotonic()
        with self._lock:
            by_project: dict[Path | None, list[Subscriber]] = {}
            for sub in self._subs:
                by_project.setdefault(sub.project, []).append(sub)
        for project, subs in by_project.items():
            try:
                overview = views.ui_overview(self.rt.scoped(project))
            except Exception:
                logger.debug("roko: live overview failed", exc_info=True)
                continue
            self._publish([{"type": "overview", "overview": overview}], subs)

    def _run_url(self, run_id: str) -> str:
        """The URL of the roko serve of the project a run ran in (the cards' trackers are kept by it)."""
        return self.rt.for_run(run_id).settings().url

    def _publish(self, frames: list[dict[str, Any]], subs: list[Subscriber] | None = None) -> None:
        if not frames:
            return
        if subs is None:
            with self._lock:
                subs = list(self._subs)
        for frame in frames:
            clean_frame = finite(frame)
            for sub in subs:
                sub.put(clean_frame)


def plan_keys(run_id: str, plan_id: Any = None) -> set[str]:
    """The plan ids a run's events can carry: a prompt run's plan is named after the run, roko serve's
    wrapper plan is `run-<first 8>`, and a plan run's is its plan."""
    keys = {run_id, f"run-{run_id[:8]}"}
    if isinstance(plan_id, str) and plan_id:
        keys.add(plan_id)
    return keys


def sse_events(lines: Iterable[str]) -> Iterator[tuple[str, str, str | None]]:
    """(event name, data, id) for each server-sent event in `lines`; comments are skipped."""
    name: str | None = None
    data: list[str] = []
    ident: str | None = None
    for raw in lines:
        line = raw.rstrip("\r")
        if line == "":
            if data or name:
                yield (name or "message", "\n".join(data), ident)
            name, data, ident = None, [], None
            continue
        if line.startswith(":"):
            continue
        key, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if key == "event":
            name = value
        elif key == "data":
            data.append(value)
        elif key == "id":
            ident = value


def finite(value: Any) -> Any:
    """`value` with NaN and infinities as null: JSON has neither."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [finite(item) for item in value]
    return value


def _run_id_of(frame: dict[str, Any]) -> str | None:
    run = frame.get("run")
    return str(run.get("run_id")) if isinstance(run, dict) else None

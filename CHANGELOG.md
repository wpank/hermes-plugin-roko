# Changelog

## 0.4.0 — unreleased

The control surface: roko's work and its five loops, live, in every Hermes surface.

- **Design**: each run is one instrument. A black display bar with dot-matrix readouts (`01 TASKS`, `02 TIME`,
  `03 SPEND`, `04 CHECKS`, `05 MODEL`, `06 PULSE`), a ticker with what is happening this second, a scope that blips on
  each event, and the tasks as pads on a sequencer with a playhead, one column per wave. Four colours carry meaning
  and nothing else (blue: an agent works; green: a check passed; orange: you; red: a check did not pass). Keys,
  switches, LEDs, a 20-segment spend meter and a cap knob with detents bounded by your limits. Numbered module labels
  in the same order on every surface. Reduced motion respected throughout.
- **Live**: a WebSocket, `WS /api/plugins/roko/live`, behind which one relay per Hermes backend follows roko's event
  hub (`GET /api/events`) and pushes cards, timeline lines, the agents' tool steps and words, and roko's loop events as
  they happen. In the end-to-end test against roko with real models the median delay was 4 ms for a route, 15 to 20 ms
  for an agent's words and 0.3 s for an activity line. While the socket is up, pages poll only every 15 s as a
  backstop; while it is down, they poll as before. The desktop half reads it with `ctx.socket`, the dashboard
  with `buildWsUrl`; the socket checks Hermes' own credential.
  An agent's words arrive with `said`, the tail of what it has said since its last tool call, so a page shows sentences,
  not tokens.
- **roko's five loops**: L0 tool calls, L1 attempts, L2 the plan, L3 learning, L4 audit. A Loops tab per run and per
  page with a five-ring dial (a sweep hand, a tick per event), each ring's events, and roko's own state from the new
  `GET /loops` (route decisions and retry budgets, diagnoses, model scores, gate thresholds, lessons, playbooks, the
  learning loops' health). Built on roko's new events (roko 2026-10-14): `route_decided`, `confirm_waiting` and
  `confirm_resolved`, `effect_staged` and `effect_decided`, `knowledge_written`, live records numbered by attempt, and
  live rows flushed at once.
- **Run cards** gain the run's loop events (`loops`), roko's gate thresholds, and per task: the last tool steps, the
  agent's live words, a sign-off's hold with roko's deadline, held calls, lessons, and each attempt's route (model,
  source, probability and the candidates roko weighed).
- **Desktop app**, to the fullest of Hermes' plugin SDK:
  - a **monitor pane** in the right sidebar that follows the newest run beside the chat (hidden, never closed);
  - a **delegate to roko** card on an empty chat, whose example requests fill the composer;
  - a **`→ roko`** key in the chat composer that opens new run with the chat's draft;
  - a **`roko` theme** for the whole app, aluminium by day and graphite by night, TE orange;
  - a **settings page** under Settings ▸ Plugins ▸ roko: the connection, limits, sounds, the theme, the doctor;
  - a light on the sidebar row of a chat whose run is going (blue) or waits on you (orange);
  - Hermes' pet says when a run ends or needs you; opt-in sounds (off by default);
  - palette entries for new run, Loops, the monitor pane, what's waiting and the health check; ⌘⌥R anywhere;
  - a run started from a chat arrives with a toast at once, through Hermes plugin events (`plugin.roko.run.started`,
    `run.ended`, `waiting`).
- **Web dashboard**: the same instruments, plus roko on the dashboard's other pages: a strip above the chat
  (`chat:top`) and on Sessions while a run is going, a summary card on Analytics (`analytics:top`), a model scorecard
  on Models (`models:top`), and the sidebar chip; number keys 1–6 switch sections.
- **Fixes found by dogfooding**: a long run's final card could stay stale when roko rate-limited the reads (the card now
  waits as roko asks, and the relay rebuilds a card that came back with problems); live words came one token per
  frame; the chat and sessions strips cut off the newest words; a decision said "Approved · approved".
- **Tests**: the replay roko streams its hub, answers roko's learning routes from what it replayed, and with
  `--recording live` replays runs recorded from a live roko with real models (`tests/fixtures/live_runs.json`, the
  agents' words included); `--tour` adds one of each loop event the recordings never show. The compat lane keeps
  Hermes from building a dependency runtime per test home (`HERMES_DISABLE_LAZY_INSTALLS=1`).

## 0.3.0 — unreleased

Mission control: follow, review and merge roko's checked work without leaving Hermes.

- **Desktop app**: the roko page is rebuilt around the run.
  - A header with live instruments: a progress ring, a ticking clock, spend against the cap with a
    projection, checks passed, roko's estimate of the time left, and the models used.
  - The run as a graph: one column per wave, each task moving through its agent and its checks, with
    retries and blocks marked. Click a task for every attempt, its checks, the key line of a check that did
    not pass, and what its agent said.
  - A "now" line while the run goes, an activity feed with filters, and a replay of a finished run.
  - **Changes**: the run's diff, file by file. **Merge**: a guarded merge of exactly the commit you reviewed,
    as a fast-forward or a clean merge commit, with the command that undoes it.
  - **New run** (⌘⌥R, `n`, or the palette): ask roko for work from the app, as one checked task or as a
    plan first, under the run cap and the daily limit.
  - Waiting cards with a document preview, plans as graphs, Insights with charts, a first-run page with
    example requests, chat cards with a small graph and Review & merge, and a status chip with a progress
    ring.
- **Web dashboard**: the same mission control in the dashboard's own look, down to phone width.
- **`hermes roko watch [RUN]`** follows a run live, full screen, on a terminal: its state with a spinner,
  an elapsed clock, spend against the cap, the plan wave by wave (each task's model, attempts, cost and
  gates), what waits on you, and the run's latest events. `q` stops watching while the run goes on and `r`
  checks at once; when the run ends, the last frame stays with a summary: verdict, cost, branch, and the
  review and merge commands. Piped, or with `--once`, it prints the card as text. Also
  `hermes roko status RUN [--why]`, and run cards in `/roko` gain task and spend bars, the plan's waves on
  one line, and what waits on you first.
- **Backend** (docs/ui-api.md): run cards gain progress, the task graph, each task's timing, step,
  attempts and its agent's latest note, roko's estimate of the time left, and a "why" paragraph for runs
  that did not succeed. Timeline lines gain a group, a time, and the fields a replay needs. New routes: the
  diff (`GET /runs/{id}/diff`), the merge check and merge (`GET` and `POST /runs/{id}/merge`), and new work
  (`POST /runs`).
- **Tools**: a `title` names a run in every list; a run that waits behind another in roko's workspace
  reports its `queue_position`.
- **Why** reads better: the line of a failing check that says why, blocked tasks grouped under what
  blocked them, what a cancelled run had done, and no engine tally.
- **Confirmations** show roko's own deadline (roko gap-25d9cc), never a guessed one.
- **Newer roko**: numbered attempts (roko bug-369c21; an older roko's are still counted), queued prompt
  runs (roko bug-09e21e), and a run roko has no record of shows as `missing` rather than as an error.
- **Tests**: a replay roko (`tests/replay_roko.py`) that plays recorded runs back over time, for building
  and showing the UIs without spending anything; fixtures recorded in the Hermes dogfood.

## 0.2.0 — unreleased

roko becomes visible in every Hermes interface.

- **Desktop app** (`desktop/plugin.js`): a roko page (Runs, Waiting, Plans, Knowledge, Health), a
  status-bar chip, palette entries, notifications, a `hermes://open/roko?run=<id>` deep link, and live
  chat cards the model places with `::roko-run{id}`, `::roko-plan{id}` and `::roko-pending{run}`.
- **Web dashboard** (`dashboard/`): a roko tab, a header chip and a Sessions-page banner.
- **Backend for both** (`dashboard/plugin_api.py`, `hermes_plugin_roko/ui_api.py`): the
  `/api/plugins/roko/*` routes in docs/ui-api.md, mounted by Hermes' web server. roko's key stays in
  Hermes' backend. Every route answers 200 with `ok`, so a page can tell "roko said no" from "the route
  is missing".
- **Run cards** (`rundata.py`): cost and tokens summed from roko's efficiency events (roko's summary
  says $0 for plan runs), tasks with model, attempts and gates, start and end from the run's manifest,
  a readable timeline, a one-line headline, and the delivered branch with review and merge commands.
  Event indexes are read incrementally, and a finished run's only once.
- **Spend**: a daily limit, `max_day_usd` (default $20), across the runs Hermes starts, counting what
  running runs may still spend. Over-limit starts are refused before anyone is asked.
- **Tools**: `roko_status` gains a headline, `detail: "tasks" | "why"`, `run_id: "last"`, today's spend
  in the overview, and returns as soon as something waits on the person (with a 6-character code per
  item); `roko_plans` shows waves and roko's estimate; `roko_decide` accepts a code; approval prompts are
  one clean line and show the estimate and today's spend; errors carry `"success": false`; long waits
  tell Hermes they are still working; one emoji per tool.
- **`/roko`**: run cards for `status RUN [why]`, plans wave by wave, and new `runs`, `cost`, `gates`,
  `learn`, `effects` and `knowledge`; replies fit one message (1,900 characters).
- **`hermes roko watch [RUN]`** redraws a run's card until it ends; `hermes roko status RUN`.
- **Skills** `roko:delegate`, `roko:plan`, `roko:decide`; an **`@roko:` context reference**; roko API
  keys **redacted** in Hermes' logs and transcripts.
- **Prompt**: teaches the desktop cards in the desktop app only, the `/roko approve CODE` note, and
  that unverified is not success.
- **Safety**: all text from roko is cleaned of escape sequences, control characters and bidirectional
  overrides before it reaches a terminal, an approval prompt, a chat or a page; `ui_actions: false`
  makes the UIs read-only.
- **Doctor**: reports which UI halves are installed and what to do to see them.
- **Where the work is**: a finished run's card takes roko serve's own answer, the summary's `result`
  (roko gap-8409d0): the batch branch, its commit and base, the changed files, whether the checkout has
  the work, and roko's merge command, or the branch it was promoted into. It works for a remote roko
  serve too, and still names the files after the merge. Against an older roko serve the plugin reads the
  branch with git as before, which needs the workspace on this machine.
- **Docs** (`docs/`): getting started, everyday use with examples, a reference of commands and settings,
  and troubleshooting, each checked against a fresh install.
- **Short run ids**: the first characters of a run id (at least 4; the lists show 8) name the run Hermes
  started, in `/roko`, `hermes roko` and the tools.
- **Install scanner in the tests**: the compat lane runs Hermes' own install scanner over what an install
  would copy, so a finding that would block installing or updating the plugin fails the tests.
- **Fixes**:
  - The doctor's desktop hint says to reload the window (⌘R) after turning roko on: "Reload desktop
    plugins" adds the sidebar entry but does not load the page.
  - A paid start that timed out now finds the run roko started anyway, instead of pointing at an
    overview that could not list it.
  - The run log takes a lock file around each change, so a chat and a UI backend writing at once
    cannot drop each other's runs.
  - The run log is written only when something changed.
  - Bare `hermes roko` prints its usage and exits 0.
  - Internal errors reach the model and chat cleaned.

## 0.1.0 — unreleased

First version.

- Eight tools for Hermes' model over roko serve's `/mcp` contract and two REST reads: `roko_run`,
  `roko_plan_generate`, `roko_plan_run`, `roko_status`, `roko_cancel`, `roko_plans`, `roko_recall`,
  `roko_decide`. Paid tools and decisions ask the person through Hermes' approval gate; every run names
  a `max_usd` cap, checked here before roko sees it.
- `roko_status` follows a run in short server-side waits (so an interrupt is noticed), lists what the
  run waits on the person for, reports the `roko/batch/<run_id>` branch its verified work is on when the
  workspace is local, and recovers a finished plan generation that roko has already forgotten.
- `/roko` slash command: `status`, `plans`, `pending`, `approve`, `reject`, `cancel`, `recall`, `doctor`.
- `hermes roko setup | doctor | status`: setup finds roko serve, mints a write-scoped key with its
  launch token (`--mint`), stores it in Hermes' `.env`, and runs the doctor. The doctor checks reach,
  auth, key scope, the `/mcp` tool set, and whether roko accepts chat-started runs, using a probe that
  starts nothing.
- A `roko` system-prompt section teaching the delegation protocol.
- No hooks.
- Built for Hermes' tool guardrails:
  - Status results carry `checked_at`, so polling a long run is never a byte-identical repeat. Hermes
    halts a gateway turn on the fifth identical call.
  - Results avoid bare `"failed"` and `"error"` tokens. The one exception is the status of a run that
    did fail. Polls of a healthy run therefore never count as failed calls.
- Safety details:
  - Approval rule keys carry the cap.
  - `roko_decide` binds the item and the verdict, and refuses items roko no longer waits on.
  - `/roko` names items by stable codes.
  - Slow answers and paid starts report that the work may already have happened.
  - The loopback check accepts only `localhost` or loopback IP literals, and loopback requests skip
    proxies.

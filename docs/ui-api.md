# roko UI API: the backend the desktop and dashboard halves share

`dashboard/plugin_api.py` exports a FastAPI `router` that Hermes mounts at **`/api/plugins/roko`**, in both
`hermes serve` (the desktop app's backend; the desktop half calls it with `ctx.rest('/overview')`) and
`hermes dashboard` (the web dashboard calls it with `SDK.fetchJSON('/api/plugins/roko/overview')`). Hermes
authenticates every request (desktop session token, dashboard session); the routes add none of their own.

The router is the only thing that talks to roko serve. The roko API key never reaches a renderer.

0.4.0 adds a push channel: **`WS /api/plugins/roko/live`** relays roko's own event stream as it happens
(agent tool steps and words, the cybernetic loop events, fresh cards and timeline lines), and
**`GET /loops`** answers the Loops view in one call. Under `hermes serve` the backend also tells the desktop
app's windows about runs starting, ending and waiting through Hermes' plugin events. See
[The live channel](#the-live-channel-ws-live), [`GET /loops`](#get-loops) and
[Desktop plugin events](#desktop-plugin-events) below.

0.5.0 makes the run data say what actually happened (see [What 0.5.0 adds to a card](#what-050-adds-to-a-card)):
a run whose roko stopped under it is `interrupted`; a card says where the run's changes are and how far they
are verified (`work`), whether Merge can take them now and what stands in its way (`merge`), what roko is
checking right now (`checking`), why the model it runs on was picked (`route`), and the one thing to do next
(`next`). Insights default to the runs Hermes started (`GET /insights?scope=`).

Hermes mounts plugin routers once, when the backend process starts: after installing or updating the
plugin, the desktop app (or `hermes dashboard`) must be restarted before these routes exist. Until then
`ctx.rest` fails with a 404, and the UI should say "restart Hermes to load roko's backend".

## Conventions

- Every route answers **HTTP 200** with a JSON object that has `ok`:
  - success: `{"ok": true, …fields…}`
  - failure: `{"ok": false, "error": {"code": "unreachable", "message": "…", "hint": "…"}}`
  - `code` is one of `unreachable, unauthorized, forbidden, not_found, conflict, rate_limited, invalid,
    refused, denied, server_error, protocol, config, internal`.
  - A non-200 means the route itself is missing or crashed, not that roko failed.
- A failure's `error.hint` is the person's next step, worded for them; it never addresses the model (a model's
  guidance exists only in tool answers), so a page may show it as it is.
- All text that came from roko (labels, questions, summaries, gate output, milestone text) has terminal
  control characters stripped, and is **untrusted**: render it as text nodes only, never as HTML or markdown.
- Times are ISO-8601 strings (UTC) or `null`. Money is a number of US dollars or `null` when unknown
  (render `—`, never `$0.00`, for `null`).
- Run states: `queued | running | succeeded | failed | unverified | cancelled | interrupted`, plus the plugin's
  own `missing` (Hermes started the run, but roko keeps no record of it: roko refuses a prompt run that starts
  while another run holds the workspace, roko bug-09e21e). `unverified` means no check ran: never show it as
  green, and never as failed. `interrupted` (0.5.0) means roko stopped while the run was going (a restart, a
  crash): its own outcome, neither failed nor running; what had passed is kept. Task outcomes add `pending,
  running, passed, skipped, already_satisfied, accepted_with_failures, blocked`, and (0.5.0) `stopped`: a task
  roko stopped at the run's cap, before a model call, before another attempt or before it started. A run roko
  stopped at its cap keeps roko's `failed` in `state` and carries `budget_stop`: show it as stopped, not failed
  (see below). roko's `passed_with_preexisting_failures` (its check passed apart from failures that were there
  before the task) reads `passed`, and its `condition-skipped` (no route of the plan chose the task) reads
  `skipped`, each with a `reason` that says so; `progress` counts the first as passed and the second as skipped.
- Live views open the `/live` socket and render what it pushes. Poll only while the socket is down (no faster
  than every 3 s for a single run and every 10 s for the overview), and tick clocks (elapsed, a task's step
  time) on the client between frames.
- Times on cards and timeline lines are ISO-8601 strings, except the fields named `ts` on loop events and live
  items and `ts_millis` on timeline lines, which are milliseconds since the epoch (integers) or `null`.

## Shared shapes

```ts
type RunRow = {
  run_id: string
  kind: 'run' | 'plan' | 'plan_generate'
  label: string                 // the run's title when one was given; else a short title made from the request
                                // (its first sentence, ≤60 chars) for a run or a plan generation, and the
                                // plan's title for a plan run (0.5.0; before: the whole request, the plan id)
  plan_id: string | null        // plan runs and plan generations only
  progress: Progress | null     // where the run's tasks are, once known
  source: 'ui' | null           // 'ui': started from a Hermes UI (POST /runs or /plans/{id}/run)
  state: string | null          // last known state
  active: boolean               // state is queued, running or unknown
  cost_usd: number | null       // read from the run's events; null until known (render —)
  max_usd: number | null        // the run's cap
  started_at: string            // when Hermes started it
  finished_at: string | null    // when roko says it ended, once known
  session_id: string | null     // the Hermes session that started it (null when started from a UI)
  note: string | null           // why the last refresh of this row did not work, if it did not
  interrupted: Interrupted | null  // 0.5.0: state `interrupted`, why and when
  budget_stop: {limit: 'run' | 'day', cap_usd: number | null, spent_usd: number | null} | null
                                // 0.5.0: roko stopped it at its cap (or its daily limit): show a stop, though
                                // `state` says failed; from the first refresh that sees the run ended (its
                                // events, or the card built for it), so a finished row never comes bare
  work: 'verified' | 'unverified' | 'partial' | 'none' | null  // 0.5.0: Work.kind, once a card was built
}

type Progress = {               // every task counted once, by where it is now
  total: number, passed: number, failed: number, running: number, pending: number,
  blocked: number, stopped: number, unverified: number,
  skipped: number               // 0.5.0: roko skipped it by design (no route of its plan chose it): not failed,
                                // not stopped
}

type PendingItem = {
  code: string                  // 6-char code, stable across chats and restarts; `/roko approve CODE`
  decision_id: string           // the full id roko_decide and POST /decide take
  kind: 'confirm' | 'effect'
  title: string                 // one line: "the result of task T1 (Report) in run e13f6327" /
                                //           "the held action mail.send on mail (run e13f6327)"
  question: string              // what the person is asked
  summary?: string | null       // confirm: ≤2 KiB summary of the work (untrusted)
  run_id: string
  plan_id?: string | null
  task_id?: string | null
  task_title?: string | null    // confirm
  tool?: string | null          // effect only
  server?: string | null        // effect only
  arguments?: Record<string, string> | null   // effect only: argument TYPES, never values
  held_at?: string | null       // confirm
  proposed_at?: string | null   // effect
  timeout_secs?: number | null  // confirm: how long the confirm rung waits, as roko reports it
  deadline_at?: string | null   // confirm: when roko stops waiting and the task ends unverified; null when roko does not say
}

type LoopEvent = {             // one of roko's cybernetic events, worded for people
  ring: 'L0' | 'L1' | 'L2' | 'L3' | 'L4'  // L0 tool calls (seconds) · L1 attempts (minutes) · L2 the plan (hours)
                                          // · L3 learning (days) · L4 audit (weeks)
  kind: LoopKind
  text: string                  // one line, ≤220 chars (untrusted)
  data: object                  // small, per kind (below)
  task_id: string | null
  plan_id: string | null
  ts: number | null             // ms since the epoch
  key: string                   // stable id: the same event on a card and on the socket has the same key;
                                // merge by it, never show two lines with one key
}

type LoopKind =
  | 'tool_held' | 'tool_decided' | 'withheld'                        // L0
  | 'route' | 'failover' | 'retry' | 'regression'                    // L1
  | 'wave' | 'diagnosis' | 'budget' | 'hold'                         // L2
  | 'thresholds' | 'knowledge'                                       // L3
  | 'loop_health' | 'guarded_commit'                                 // L4

type LiveItem = {               // what an agent is doing now; not stored anywhere
  kind: 'tool' | 'text' | 'reasoning' | 'result' | 'beat'
  plan_id: string | null
  task_id: string | null
  attempt: number | null        // from 1; null on beats
  ts: number | null             // ms since the epoch
  tool?: string                 // tool: the tool's name ("Read", "Bash", "mail.send")
  target?: string | null        // tool: what it works on (a path, a command), ≤200 chars
  tool_id?: string | null       // tool, result: pairs a result with its call
  text?: string                 // text, reasoning, result: ≤400 chars (untrusted); roko streams words a token
                                // at a time, so a words item's `text` may be a single token
  said?: string                 // text, reasoning: the tail (≤400 chars) of what the task's agent has said in
                                // this stretch (same attempt and kind, since its last tool call), this item's
                                // words included; show `said`, not `text`. A `tool` item ends the stretch.
                                // 0.5.0: a chunk that is only the space between two words gets no frame of
                                // its own, but joins `said` (the next word's frame carries it), so words keep
                                // their spaces ("wordy 0.1.0", not "wordy0.1.0")
  screened?: false              // present when roko streamed these words before its output screening;
                                // the card's `note` is the screened transcript
  elapsed_ms?: number | null    // beat: how long the agent has been at it
}

type Problem = {                // one thing that stands between the person and a run that works
  id: string                    // see "Setup problems" below
  severity: 'block' | 'warn'    // block: new runs cannot work until it is fixed
  title: string                 // one short sentence: what is wrong
  detail: string                // one or two sentences: why it matters
  fix: {
    kind: 'action' | 'command' | 'docs' | 'restart-hermes'
    label: string               // lowercase key label, e.g. "make ready"
    action: string | null       // kind action: the id for GET/POST /setup/fix
    command: string | null      // a shell command the person can copy (for an action, the CLI that does the same)
    docs: string | null         // a docs anchor, relative to the plugin's docs/
  }
}

type Setup = {
  ok: boolean                   // no problem blocks new runs
  problems: Problem[]           // the install's own first (restart-hermes), then roko's; blocking ones first
  checked_at: string            // when roko was last asked (at most 30 s ago; a refused start or a fix asks again)
}

type Connection = {
  url: string                   // roko serve, without credentials
  reachable: boolean
  version: string | null
  status: string | null         // "ok" | "degraded" | …
  credential: string            // "env:ROKO_API_KEY" | "launch-token:…" | "none" (never the key)
  workdir: string | null        // 0.5.0: the plugin's `workdir` setting (roko's workspace), when set
  error: { code: string; message: string; hint?: string } | null  // an unreachable roko's hint names
                                // the real workdir (`roko serve --workdir <path>`), not a placeholder
}

type Interrupted = {            // 0.5.0: why a run ended because roko stopped under it
  reason: string                // one sentence, e.g. "roko stopped while this run was going (machine restart
                                // or crash)" (roko's own, bug-dceafd) or the plugin's for an older roko
  at: string | null             // the run's last sign of life
  source: 'roko' | 'plugin'     // plugin: an older roko kept calling it running; the plugin found that its
                                // roko serve started after the run's last invocation, or that a cancel found
                                // nothing running it
}

type Work = {                   // 0.5.0: where an ended run's changes are, and how far they are verified
  kind: 'verified'              // all of it passed its checks and is on the run's batch branch (`delivered`)
      | 'unverified'            // only work no check ran on
      | 'partial'               // some verified, some not; or the tasks that passed in a plan that failed
      | 'none'                  // no changes
  parts: WorkPart[]             // the delivered work first, then what the run kept on plan branches (≤8)
  source: 'roko' | 'git' | null // roko's summary (result.unverified, bug-db89d4), or the plan branches read with
                                // git (an older roko; the workspace on this machine)
}

type WorkPart = {
  trust: 'verified' | 'unverified'  // its checks passed / no check ran on it
  delivered: boolean            // true: on roko/batch/<run> (Merge takes it); false: kept on roko/plan/<plan>
  plan_id: string | null        // the plan whose branch keeps it (null for delivered work)
  branch: string | null         // the branch, while it still points at `commit`
  commit: string                // 12 hex
  base: string | null           // 12 hex: what the part's changes are relative to
  files_changed: string[]       // ≤30, then "… N more"
  diffstat: string | null       // "2 files changed, 12 insertions(+)"
  counts: {files: number, additions: number, deletions: number} | null  // the same as numbers
  tasks: {task_id: string, verdict: string | null}[]  // kept parts: whose work it is
  merged: boolean               // the checkout already has it
  review_command: string | null // git diff that shows it
  checks_finished?: boolean     // delivered parts: false when the run was interrupted, so roko may have
                                // stopped before the checks it runs on the delivered whole finished (each
                                // task's own check passed); the work then counts as `partial`
  partial?: boolean             // delivered parts: roko delivered only the verified tasks of a plan that did not
                                // finish (its summary's `result.partial`, roko-delivery's item 2); `tasks` holds
                                // them, `missing` the rest: [{task_id, why, plan_id}] ("failed", "ran no check",
                                // "not started", …). Merge then asks for a yes (`merge.confirm`)
  stopped?: string              // kept verified parts: what stopped roko's check of the plan's merged work ("a
                                // cancel request"; roko 2359ba4ec cancels such a delivery and takes its merge
                                // back out of the batch), with `checks_finished: false`. Each task's own check
                                // passed; Merge asks for a yes, and `next.why` says what stopped the check
}

type MergeState = {             // 0.5.0: whether Merge can take the run's work now (the card's `merge`)
  available: boolean            // Merge would work now
  merged: boolean               // the checkout already has it
  reason: string | null         // why not, one sentence for the person
  demo: boolean                 // a demo plan's output: show "Demo output: it stays on its run branch", no Merge
  work: 'verified' | 'partial' | 'unverified' | null  // what Merge would take
  confirm: string | null        // non-null for partial or unverified work: show it, and merge only after the
                                // person says yes (POST /runs/{id}/merge with "confirm": true)
  dirty: string[]               // uncommitted tracked files that block Merge (≤10)
  fix: Problem.fix | null       // when the only one is roko.toml (the setup fix changes it): {kind: "action",
                                // label: "commit roko.toml", action: "commit-roko-toml", command, docs: null}
  mode: 'fast-forward' | 'merge' | null
  into: string | null           // the checkout's branch
  branch: string | null
  commit: string | null
  plan_id: string | null        // the plan whose kept work Merge would take
  command: string | null        // the same merge, to run by hand
}

type Checking = {               // 0.5.0: what roko is checking right now, while the run goes
  what: string                  // the command or the rung ("cargo clippy --workspace …", "verify[0:compile]")
  label: string                 // short: "clippy", "tests", "compile", "the plan's checks before delivery"
  scope: 'task' | 'plan' | 'workspace'
  task_id: string | null        // scope task: whose check
  since: string | null          // tick the elapsed time on the client from this
  elapsed_s: number | null      // at the card's checked_at
  source: 'roko' | 'plugin'     // plugin: an older roko says nothing between the last task and the run's end,
                                // so every task ended and the run still goes means its own checks run
  packages?: string[] | null    // roko's whole-plan check (gap-6b6ec1): the packages it checks, when not all
  step?: number | null          // … and which step of how many ("step 2 of 3")
  steps?: number | null
}

type NextAction = {             // 0.5.0: the one control to offer on a run that ended
  action: 'merge' | 'review' | 'commit-roko-toml' | 'rerun' | null  // null: nothing to press (read `label`)
  label: string                 // "merge", "review the unverified changes", "review what passed",
                                // "commit roko.toml", "run the plan again", "start it again",
                                // "raise the cap and run it again", …
  why: string | null
  max_usd?: number | null       // 0.5.0, `rerun` after a stop at the run's cap: the cap to fill the composer with
                                // (the same one would stop it again); nothing starts until the person presses Run
  over_limit?: true             // that cap is the plugin's max_run_usd, though the run needs more (`why` says so)
}

type PlanValidation = {         // 0.5.0: why roko will not run a plan (its validator, POST /api/plans/{id}/validate)
  valid: false
  errors: {rule: string | null, task_id: string | null, message: string}[]  // roko's own words, first line each
  open_questions: {task_id: string | null, question: string, assumption: string | null}[]
                                // PLAN_045: what a task still asks; `assumption` is what the planner suggested
  summary: string               // "PLAN_045: task 'T2' has open questions, so its plan cannot run; …"
}
```

## Routes

### `GET /overview`
Everything the status chip, the sidebar badge and the landing page need, in one call.
```json
{
  "ok": true,
  "plugin_version": "0.4.0",
  "connection": {"url": "http://127.0.0.1:6677", "reachable": true, "version": "0.1.0", "status": "ok",
                 "credential": "env:ROKO_API_KEY", "error": null},
  "counts": {"running": 1, "queued": 0, "waiting": 2},
  "spend": {"today_usd": 0.42, "committed_usd": 1.0, "max_day_usd": 10.0, "left_usd": 8.58, "runs_today": 3},
  "limits": {"max_run_usd": 5.0, "max_day_usd": 10.0},   // max_day_usd null: no daily limit
  "permissions": {"write": true},   // false: hide Run / Approve / Reject / Cancel (ui_actions: false)
  "setup": Setup,               // what stands between the person and a run that works; see Setup problems
  "runs": [RunRow, …],          // newest first, at most 20; states refreshed for active ones
  "pending": [PendingItem, …],
  "checked_at": "2026-10-11T12:00:00.000+00:00"
}
```
`connection` also carries `active_runs` and `active_plans` (workspace-wide, from roko's `/api/health`). A
refused key is `reachable: true` with `error.code: "unauthorized"`. `spend` counts runs started from this
Hermes: `today_usd` is what they spent today (local day), `committed_usd` what running ones may still spend
(cap minus spent), `left_usd` what a new run may still cap itself at.
If roko serve is unreachable: `ok: true`, `connection.reachable: false` with `connection.error`, the cached
`runs` (last known states), `pending: []`, and `counts` from the cached states.

### `GET /runs/{run_id}`
A full run card.
```json
{
  "ok": true,
  "run": {
    "run_id": "e13f6327-…", "kind": "run", "label": "Add clamp() with a test", "plan_id": "e13f6327-…",
    "plan_ids": ["e13f6327-…"],
    "state": "succeeded", "verdict": "succeeded", "active": false, "position": null,
    "cost_usd": 0.0103, "max_usd": 0.5,
    "tokens": {"input": 3352, "output": 655, "cache_read": 10368, "cache_write": 0},
    "started_at": "2026-10-09T13:00:09.314Z", "finished_at": "2026-10-09T13:00:50.893Z", "duration_ms": 42210,
    "elapsed_ms": null,          // running runs: time since start
    "tasks": [
      {"task_id": "T1", "title": "Add clamp", "outcome": "passed", "model": "glm-5.1", "provider": "zai",
       "attempts": 1, "cost_usd": 0.0103, "rung": null, "depends_on": [],
       "gates": [{"gate": "verify[0:test]", "passed": true, "excerpt": "$ cargo test …", "runs": 1}]}
    ],
    "task_counts": {"total": 1, "passed": 1, "failed": 0, "unverified": 0, "other": 0},
    "progress": {"total": 1, "passed": 1, "failed": 0, "running": 0, "pending": 0, "blocked": 0,
                 "stopped": 0, "unverified": 0},
    "graph": {"waves": [["T1"]], "edges": []},
    "eta_minutes": null, "last_event_at": "2026-10-09T13:00:50.880Z",
    "request": "Add clamp() to src/lib.rs with a unit test",
    "gates": {"passed": 1, "failed": 0, "total": 1, "retried": 0},
    "milestones": [{"kind": "started", "text": "plan … started", "at": null}],
    "errors": [],
    "origin": "mcp:hermes", "session_id": "20261009_153614_15a71b", "hermes_started_at": "…", "resumed": false,
    "waiting": [PendingItem, …],
    "delivered": {"workspace": "/path/ws", "branch": "roko/batch/e13f6327-…", "commit": "d66293e36e22",
                  "base": "3cfff55c8a68…", "files_changed": ["src/lib.rs"],
                  "diffstat": "1 file changed, 30 insertions(+)", "merged": false, "source": "roko"},
    "review_command": "git -C /path/ws diff 3cfff55c8a68…..roko/batch/e13f6327-…",
    "merge_command": "git -C /path/ws merge --ff-only roko/batch/e13f6327-…",
    "headline": "succeeded · gates 1/1 · $0.01 of $0.50 · 42s · branch roko/batch/e13f… (not merged)",
    "checked_at": "…"
  }
}
```
`cost_usd`/`tokens` are summed from the run's efficiency events (roko's summary reports 0 for plan runs);
`null` when nothing was recorded yet. 0.5.0: show `tokens.cache_read` as "N cached" in a token line ("47,484 in
· 17,402 out · 411,392 cached"): cache reads are billed too, often most of a run's tokens, so a line without them
makes the cost look wrong. 0.5.0: `gates` counts each task's checks as its **final attempt** left them, and
`retried` the check runs of earlier attempts that did not pass (roko tried the task again): a run whose check
failed once and passed on the retry reads "1/1 · 1 retried", not "1 did not pass". Each `tasks[].gates[]`
adds `superseded: true` when its verdict is from an earlier attempt (the final attempt ran checks, but not this
one); `why.gates_not_passed` leaves those out. 0.5.0: `tasks`, `progress` and `graph` hold the plan's own tasks
(its tasks.toml, in order, with `depends_on`) from the run's start, beside the ones roko's events name: a
4-task plan reads "0/4" in 3 waves at once, and a task a re-run skips keeps its title. `delivered` is roko serve's own answer, the run summary's `result`
(`source: "roko"`; a promoted run adds `promoted_into` and `promoted_tag`, and `merge_command` is `null` once the
checkout has the work or the run was promoted). From an older roko serve the plugin reads the branch with git
instead, which needs the workspace on this machine. `workspace` and the `git -C` prefix appear when the plugin's
`workdir` is set; `delivered` is absent when the run left no changes. `tasks[].gates[].excerpt` is ≤200 chars of the gate's output (untrusted): a passing gate's
command line, or the end of a failing gate's output. `tasks[].outcome` adds `pending` (not started) and
`running`; a plan run lists the plan's tasks that have not started too. `plan_id` is set for plan runs only.
`run_id` may be `last` (the run Hermes started most recently).

What 0.3.0 adds to a card, for live views:

- `request`: what the person asked for, ≤600 chars (null for runs Hermes did not start, and for plan runs).
- `source`: `ui` when the run was started from a Hermes UI, else null.
- `progress`: the `Progress` of the run's tasks. `task_counts` stays, as roko reports it.
- `graph`: the tasks as `waves` (each wave depends only on earlier ones) and `edges` (`[from, to]`, a
  dependency to the task that needs it). Node ids are task ids, or `plan/task` when the run has several plans.
- `eta_minutes`: roko's estimate of the minutes left on the critical path, while running; else null.
- `last_event_at`: when roko last wrote an event for the run.
- each task adds `started_at`, `finished_at`, `duration_ms`; `step` (`starting`, `agent`, `agent done`,
  `check`, or null when idle or ended), `step_detail` (the model, or the check's name) and `step_since`;
  `attempt_log` (`[{attempt, model, provider, started_at, gates: [{gate, passed}]}]`, one per agent attempt,
  numbered from 1 as roko numbers them; an older roko numbered every attempt 0, and the plugin counts those); and
  `note`, the last thing the task's agent said (≤1,200 chars, untrusted).
- `why` on a run that ended without success: `{summary, gates_not_passed: [{task_id, title, gate, runs,
  output, key_line}], blocked: [{task_id, blocked_by, reason}], unverified_tasks, errors}`. `summary` is one
  paragraph ("T1's check verify[0:compile] did not pass, all 6 times it ran: bash: line 1: python: command not
  found. T2, T3, T4 and T5 were blocked because T1 did not pass."); `key_line` is the line of the check's
  output most likely to say why.

What 0.4.0 adds to a card, for the live views:

- `loops`: the run's `LoopEvent`s so far, oldest first, at most 60: what roko published for it (routes,
  retries, failovers, holds, held calls and their decisions, lessons, diagnoses, budget alerts, regressions,
  threshold and loop-health updates) plus each wave's opening (`wave`, derived from the plan's graph and when
  the wave's first task started). The socket's `loop` frames carry the same `key`s.
- `thresholds`: roko's adaptive gate thresholds as the run last saw them, or null:
  `[{rung: 2, name: "test", ema_pass_rate: 0.92, observations: 30, consecutive_passes: 4, shift: false}]`
  (rungs 0 compile, 1 clippy, 2 test, 3 diff, 4 fmt, 5 shell, 6 judge; most observed first, ≤8).
- each task adds:
  - `steps`: its agent's last 8 tool calls this attempt, `[{tool, target, ts}]` (`ts` ISO), so a page opened
    mid-attempt sees what the socket's `live` items showed;
  - `live_text`: the words its agent is writing right now (≤600 chars, untrusted), null between attempts;
  - `hold`: a sign-off wait, or null: `{state: "waiting" | "resolved", rung, question, timeout_secs,
    deadline_at, since, outcome: null | "approved" | "rejected" | "timed_out" | "stopped", note}`;
  - `effects`: held tool calls, `[{effect_id, tool, server, state: "held" | "decided", outcome, since}]`;
  - `lessons`: what roko's knowledge store took from the task, `[{admission, entry_id, lesson, reinforced,
    promoted}]` (≤5; `admission` is roko's word: `light_admitted`, `full_admitted`, `duplicate`,
    `full_deferred`, `full_rejected`, `full_suppressed`, `deferred` or `no_candidate`);
  - `attempt_log[].route`: why the attempt runs on its model, from roko's router, or null (older roko):
    `{attempt, model, provider, source, stage, reason, p, candidates: [{model, provider, score, p, eligible,
    ineligible_reason}]}`. `source` is the router's (`router`, `ladder`, `task_hint`, `override`, `fallback`,
    `default`, `explore`, `control`, `self_model`, `failover`); `p` is the pick's probability when the router
    sampled. Candidates are as roko lists them, at most 5: the pick first, then by score; a candidate's `p`
    and `ineligible_reason` are null when roko gives none. When the picked provider refuses, roko publishes a
    second decision for the same attempt with `stage` and `source` `failover` and a `reason` like
    `gpt-5.4-mini on openai passed over (rate_limited): 429 Too Many Requests`; the attempt's `route` is
    then that one.
- `step` gains `waiting` (step_detail `your sign-off`) while a sign-off holds the task.

#### What 0.5.0 adds to a card

Every field below is absent on a card from an older backend, and null (or false) when it does not apply.

- `label`: roko's own title for the run when it gives one (its summary's `title`, since roko gap-c2efe7; a title
  that is only the run's or a plan's id does not count), else the run's title, else a short title from the request
  (first sentence, ≤60 chars); a plan run is named by its plan's title. `request` keeps the whole request.
- `interrupted`: an `Interrupted`, or null. With it, `state` and `verdict` are `interrupted`, `active` is
  false and `finished_at` is the run's last sign of life. Its cap no longer counts as committed, the relay stops
  following it, and `why.summary` tells what had passed ("The run was interrupted: … T2 was running then. T1 had
  passed before that; what passed is kept on its branch.").
- `work`: a `Work` (ended runs; null when nothing says where the run's work is, e.g. an older roko whose
  workspace is not on this machine). `delivered`, `review_command` and `merge_command` stay as before, for
  the verified work.
- `deliveries`: how each plan's delivery into the run's batch branch went, from roko's `delivery_started` /
  `delivery_finished` (roko gap-4f6cbe; `[]` from an older roko, where `work` still reads the branches):
  `[{plan_id, partial, state, target, reason, stopped}]`. `state` is `delivering`, `delivered`, `conflict`,
  `regression_failed`, `cancelled` (a stop cut its check short: it stopped, it did not fail; `stopped` says what
  stopped it, and the kept work carries it) or `terminal_failed`. A delivery that did not deliver is named in
  `why.summary` ("plan speed was not delivered: its merge into … conflicted.") unless a check line already says
  it, and the timeline reads "delivering plan speed into …", "plan speed delivered into …", "plan speed: its
  delivery was stopped by a cancel request" or "plan speed was not delivered: …".
- `merge`: a `MergeState` (ended runs whose `work` is known), read from the checkout without asking roko, at
  most 5 s old. `GET /runs/{id}/merge` answers the same fields.
- `checking`: a `Checking` while roko checks something, else null: a task's check (from its
  `gate_rung_started`), a step of the whole-plan check roko announces (`plan_check_started` / `_heartbeat` /
  `_finished`, roko gap-6b6ec1: `label` is roko's `name` such as "cargo clippy", `what` its command, `scope`
  `workspace` or `plan`, with `packages` and `step`/`steps`), or (`source: "plugin"`) on an older roko, when every
  task has ended and the run still goes. Show "checking <task | the plan | the workspace>: <label> · <elapsed
  from since>". 0.5.0: a check step a stop request ended (roko's `stopped_by`, since roko 2359ba4ec: `cancel`,
  `SIGINT`, …) did not fail: its timeline line reads "<where>: <label> stopped by a cancel request after 1m02s"
  with `passed: null` and `stopped_by`, and `why` says the check was stopped, not that it did not pass. An older
  roko names no stop, and its line reads as before.
- `demo`: whether the run ran one of roko's demo plans. roko says so since gap-8f84d1: an ended run's
  `result.fixture` (every plan it ran is a demo or test plan), else its plan's `fixture` in the plan listing,
  which stays set once the plan has run. From an older roko, the plan's `group` `demos…` or a status still
  `fixture`. A demo's output is never merged: `merge.available` is false with `merge.demo` true.
- `budget_stop`: roko stopped the run at its cap (roko bug-4fabd0), or null. A stop, not a failure: `state`
  stays roko's `failed`, but the headline starts "stopped: the run reached its cap", `next` is `rerun` "raise
  the cap and run it again" (offered, never started for the person), and what passed is kept as for any run.
  That `next` has `max_usd`, the cap to offer (dogfood R2-3): the composer's next detent ($0.25, $0.50, $1, $2,
  $5, then $10, $20, $50, …) at or above twice the cap, or above what was spent plus the call (or the attempt)
  that did not fit, whichever is more; past $1,000, whole dollars. It stays within the plugin's `max_run_usd`:
  when the detent is above it, `max_usd` is that limit, and when even the cap the run needs is above it,
  `over_limit` is true and `why` adds "the cap this needs is above your per-run limit of $5.00, which you can raise
  in the plugin's settings". The model's guidance names the figure, and that limit, as an offer only.
  `limit` is `run` for the run's cap and `day` for roko's daily limit (`budget.max_daily_usd`: "daily budget
  exhausted: $X spent today (UTC) of budget.max_daily_usd = $Y", or an attempt refused with "budget exceeded:
  daily spend in micro-USD …"). A `day` stop's `cap_usd` is the daily limit and `spent_usd` what roko spent today
  (UTC); its headline starts "stopped: today's limit was reached", its `why.summary` "The run stopped: it reached
  roko's daily limit of $1.00 (budget.max_daily_usd), with $1.01 spent today (UTC).", and its `next` is `{action:
  null, label: "raise the daily limit or run it after the day turns (UTC)"}`: nothing to press, as a run started
  now stops at once. A tool loop's own daily budget ("budget
  exhausted: daily $X / $Y", roko gap-e14344) is a `day` stop too, without the setting's name. Since gap-e14344
  a capped Claude CLI attempt can also stop itself at the limit the attempt gave it ("Budget exhausted: the
  Claude CLI stopped at its spend limit (--max-budget-usd $X) after $Y"): the same `run` stop, its `stopped`
  entry carrying `agent_limit_usd` and `agent_spent_usd`, and `cap_usd` the cap the run was started with. roko's
  words are matched in any case.
  `{limit, cap_usd, spent_usd, plan_id, stopped: [{task_id, before, next_call_usd, left_usd, attempt_needs_usd}],
  not_started: [{task_id, left_usd, attempt_needs_usd}], said}`: the cap and what was spent (roko's figure when
  it gives one, else the run's events'); the tasks roko stopped, `before` a `model_call` the rest of the cap
  could not pay for (`next_call_usd`) or before another `attempt`; the tasks it did not start because less was
  left than an attempt needs (or the cap was spent); and roko's words ("plan budget exhausted: …", untrusted).
  Numbers roko does not give are null; `plan_id` names the plan when the run has several (each entry then has
  its `plan_id`). Those tasks' `outcome` is `stopped` and their `reason` says why ("stopped at the run's cap:
  its next model call would cost about $0.0049, and only $0.0036 of the $0.03 cap was left"); `progress` counts
  them as `stopped`. `why.summary` begins "The run stopped: it reached its cap of $0.03, with $0.0264 spent. T2
  was stopped before its next model call, which would have cost about $0.0049 with only $0.0036 of the cap
  left; it did not fail." An older roko's budget stop said only "plan budget exhausted: $A spent of $B" for the
  tasks it did not start; those read the same way.
- `next`: a `NextAction`, or null while the run goes.
- each task adds `route` (its latest attempt's, as `attempt_log[].route`), and every route adds:
  - `decided_by`: `ladder` (a ladder rung), `router` (roko's fixed table for the task's role: its `static`
    stage), `learned` (the router's learned stages), `pinned` (the task named its model, or an override),
    `fallback`, `failover`, `explore`, or null when roko does not say;
  - `rung`: the ladder rung of a `ladder` pick: roko's word when it gives one, else the rung of the workspace's own
    ladder (`roko.toml` `[[routing.ladder.rungs]]`, by model key or slug) when exactly one names the model; else
    null;
  - `scored`: whether the candidates' scores decided the pick (only `learned` and `explore`). When false,
    draw no score bars: the scores roko lists did not choose this model;
  - each candidate adds `why_not` (one line, or null) and, in a run started from Hermes, `excluded_by_policy:
    true` (with `eligible: false`) for a model whose agent runs its own tools (a CLI agent): such a run carries
    roko's `stage` outbound policy, which those agents cannot honour.
- `why` (runs that ended without success) adds `refusals` (what roko's spec gate refused before any agent ran,
  e.g. `"T1: HF3: verify passes on the unchanged base"`) and `start_error` (why roko did not start a run it had
  handed out an id for, e.g. another plan runner held the workspace; roko's own advice after the reason, such as
  killing the other runner, is left out). Both are in `why.summary`. Since roko bug-9a5970 they come from the
  run's summary (`refused: {stage: "start" | "spec_gate", reason}`) and its own events, which survive a restart;
  from an older roko, from its hub error when the live relay heard it, else from the run's plan status (`GET
  /api/plans/{run_id}/status` `error`, kept until roko restarts). Such a run's `next` is "read why roko did not
  start it" or "read why roko's spec gate refused it", its headline says the same, and its timeline has roko's
  error without that advice ("error: plan execution failed for <plan>: …"), then "run refused: …". A run whose
  tasks got going has no `start_error`, whatever error ended it: roko's conductor stopping it fails it in the same
  words, which `why.summary` gives as what roko reported. A failed whole-plan check is named in `why.summary` too.
  0.5.0: `validation` (a `PlanValidation`, or null) when the run did not start because its plan failed roko's
  validator. `no_price` (or null): `{tasks, models, docs}` when a run under a cap found no model with a price
  for a task (roko gap-8548e3): `why.summary` says "No model with a price could take T1 under the cap: roko
  counts only priced calls against a cap, and local-unpriced has no price.", and `docs` is the plugin's docs
  anchor on giving a model its price (`using-roko.md#roko-has-no-priced-model-for-runs-from-hermes`). The card
  attaches no setup problem for it. A cap roko cannot count because a call had no price ("plan budget cannot be
  enforced: …", or "budget.max_daily_usd = $Y cannot be enforced: …") is said the same way, with what roko
  needs: "T1 did not finish: a model call had no price, so roko cannot count it against the run's cap of $0.05.
  roko needs a price for every model it calls under a cap: …"; its tasks (and their models) join `no_price`.
- `headline` adds "unverified changes kept" / "some changes kept unverified" when `work` says so; an interrupted
  run's headline does not say "no gate ran".

A run roko has no record of (state `missing`) has a short card: `problems` says why, and `tasks` is empty.
0.5.0: a run that ended before roko forgot it (a start roko refused, then a roko serve restart) keeps the end the
plugin saw (`state`, `progress`, `interrupted`) and its `why.summary`, with `problems` saying roko no longer has
its record; it is not turned into `missing`.

A plan generation's card is shorter: `kind: "plan_generate"`, `plan_id`, `task_count`, `planner_error`.
0.5.0 adds `writing`, what roko's planner is doing (roko gap-11d870), or null from an older roko and in the
second before its first stage: `{stage, attempt, attempts, calls, cost_usd, model, reason, elapsed_s, text}`.
`stage` is roko's: `planning` (its first planner call), `retrying` (a call failed or ran into roko's 300 s limit
for one call, and runs again), `fixing` (the reply held no valid plan; asked again), `regenerating` (rewriting a
valid plan once), `writing` (its files) or `recording` (the last). `attempt` of `attempts` is this stage's,
`calls` counts the planner calls so far (a running one included), `cost_usd` what the returned ones cost,
`reason` why a `retrying`, `fixing` or `regenerating` stage tries again, and `elapsed_s` how long the writing has
run (while it runs; the card's `elapsed_ms` too). `text` is the line for a ticker: "writing the plan: planning ·
attempt 1 of 1 · 0:12 · $0.00", or "retrying: the planner call ran into roko's 300 s limit for one call and was
stopped · attempt 2 of 2 · 0:03 · $0.00". A running plan writing's headline is "running · " and that line. roko
keeps the last stage after the end, so a failed writing still says how far it got and what it spent: its
`cost_usd` falls back to `writing.cost_usd`. roko publishes the stages on no hub event, so the live relay reads a
running plan writing's card every 3 s.

### `GET /runs/{run_id}/events?cursor=&limit=` · `?tail=N`
A readable timeline, newest last. `tail=N` (≤400) returns the last N lines instead, with `next_cursor` to
continue from.
```json
{"ok": true, "events": [{"cursor": 1177, "type": "task_started", "task_id": "T1", "text": "T1 started: Add clamp"},
                        {"cursor": 4703, "type": "gate_result", "task_id": "T1", "passed": true,
                         "text": "T1 gate verify[0:test] passed"}],
 "next_cursor": 6795, "has_more": false}
```
Pass `next_cursor` back as `cursor` to get only newer rows. `limit` ≤ 200 (default 100). Types shown:
`plan_set_loaded, plan_started, task_started, agent_spawned, agent_output, gate_rung_started, gate_result,
task_completed, task_blocked, plan_completed, run_completed, error`. Every line has `group` (`run`, `task`,
`agent`, `gate` or `error`, for icons and filters) and `ts_millis` (when roko wrote it, or null).
`gate_result` and `plan_completed` lines carry `passed`; `task_completed` lines carry `outcome`; an
`agent_output` line is the first line of what the agent said ("T1 agent: The implementation is complete…").
For replays, lines also carry what their text says: `gate` on `gate_rung_started` and `gate_result`,
`model`, `provider` and `attempt` (from 1) on `agent_spawned`, and `blocked_by` on `task_blocked`. Read those
fields rather than parsing `text`, which is worded for people.
A queued run has no events yet: `events: []`.

0.4.0 adds lines for the loop events (`group: "loop"`) and for an agent's live tool calls (`group: "tool"`):

- a loop line's `type` is roko's (`route_decided`, `confirm_waiting`, `confirm_resolved`, `effect_staged`,
  `effect_decided`, `knowledge_written`, `diagnosis`, `gate_thresholds_updated`, `loop_health`,
  `loop_transition`, `inbox_item_received`, `task_phase_changed`, `event_log_entry`); it carries `ring`,
  `loop` (the `LoopKind`), `key` and `text` as the `LoopEvent` words it; `route_decided` adds `model` and
  `attempt`. Rows that light no loop (an inbox item that is not a budget alert, a log entry of another kind)
  make no line.
- a tool line (`type: "agent_output"`) carries `ring: "L0"`, `tool`, `target` and `attempt`
  ("T1 Read tally/budgets.py"). Live words make no line: the transcript does, as before.

0.5.0 adds:

- a check of the whole plan or workspace (roko's `gate_rung_started`/`gate_result` with no task, or its
  `check_started`/`check_finished`): `group: "gate"`, `gate` (the command or rung), `scope` (`plan`,
  `workspace`, `task`) and, on its end, `passed`: "checking the workspace: clippy" · "the workspace: clippy
  passed in 3m12s";
- a spec-gate refusal (`type: "event_log_entry"`, roko's `spec.gate.refused`): `group: "error"`, "T1 was refused
  before it ran: HF3: verify passes on the unchanged base";
- `run_completed` of an interrupted run: "run interrupted: roko stopped while this run was going …".
- a run roko stopped at its cap (roko bug-4fabd0): the stopped task's `task_completed` line reads "T2 stopped"
  (`outcome: "stopped"`), roko's error for it becomes "T2 stopped at the run's cap: its next model call would
  cost about $0.0049, and only $0.0036 of the $0.03 cap was left" (`group: "task"`, `task_id`, `outcome:
  "stopped"`), a task it did not start reads "T3 did not start at the run's cap: …" (`outcome: "stopped"`), the
  plan's end "plan caps-check stopped at its cap" (`passed: null`, `outcome: "stopped"`) and the run's "run
  stopped at its cap after 13s"; roko's closing tally ("Graph Engine: 1 plan(s): 1 failed") makes no line. At
  roko's daily limit the lines read "T1 stopped: roko's daily limit was reached ($1.01 of $1.00 spent today,
  UTC)", "T2 did not start: …" and "run stopped at roko's daily limit after 2s".
- roko's `passed_with_preexisting_failures` and `condition-skipped` task ends read "T1 passed: the failures its
  check found were already there before the task" (`outcome: "passed"`) and "T2 skipped: no route of the plan
  chose it, so it did not need to run" (`outcome: "skipped"`).

The route reads every row type and filters on the plugin's side, so lines of a newer roko's event types
appear without a plugin change once the plugin words them.

### `GET /runs/{run_id}/diff?max_files=100&max_patch_bytes=65536&work=&plan_id=`
What an ended run changes, file by file. Its verified work comes from roko serve (`GET /api/runs/{id}/diff`),
or, against an older roko serve, from the run's batch branch read with git when the workspace is on this
machine. 0.5.0: without `work`, the verified work, else the first part the run kept on a plan branch (verified
before unverified). `work=verified|unverified` (and `plan_id`) names a part of the card's `work`; unverified
work comes from roko (`?work=unverified`, bug-db89d4) when it has it, else from the plan branch with git. The
answer adds `work` (`verified` | `unverified`), `delivered` (false for kept work) and `plan_id`; show an
unverified diff under an "unverified: no check ran on this" banner. `why: "elsewhere"` (with the `git diff` to
run where roko runs) when the work is kept on a plan branch of a workspace that is not on this machine.
```json
{"ok": true, "diff": {
  "run_id": "…", "available": true, "source": "roko",
  "branch": "roko/batch/…", "base": "92297be3…", "commit": "8e20cced…",
  "files": [{"path": "tally/budgets.py", "old_path": null, "status": "added", "additions": 50, "deletions": 0,
             "binary": false, "language": "python", "truncated": false,
             "hunks": [{"header": "@@ -0,0 +1,50 @@", "old_start": 0, "new_start": 1, "context": null,
                        "lines": [["+", null, 1, "\"\"\"Per-category budget persistence backed by JSON.\"\"\""]]}]}],
  "totals": {"files": 5, "additions": 212, "deletions": 3},
  "truncated": false, "checked_at": "…"}}
```
Each hunk line is `[tag, old line, new line, text]`: tag `+`, `-`, ` ` (context) or `\` (git's "No newline at end
of file"). A file is `truncated` when roko clipped its patch, or its patch did not fit (`max_patch_bytes`, 1,024
to 262,144 per file; at most 1.5 MB of patches per answer); its counts stay. `language` is a highlighting hint
from the extension, or null. While the run is going, or when it left no work: `available: false` with `why`
(`running` or `none`) and a `message`.

### `GET /runs/{run_id}/merge?work=&plan_id=`
Whether Merge would work now, without changing anything. 0.5.0: the answer also carries every `MergeState`
field (`available` is `can_merge`), and `work`/`plan_id` name the part of the card's `work` to check (default:
the delivered work, else the first kept part).
```json
{"ok": true, "merge": {"run_id": "…", "state": "succeeded", "can_merge": true, "merged": false,
  "mode": "fast-forward", "into": "main", "branch": "roko/batch/…", "commit": "8e20ccedc448",
  "reason": null, "command": "git -C /path/ws merge --ff-only roko/batch/…", "label": "Add budgets"}}
```
`mode` is `fast-forward`, or `merge` when the checkout's branch moved on and the run's work merges into it
without a conflict (checked with `git merge-tree`, which writes nothing). `can_merge: false` comes with a
`reason` (still running; no work; already merged or promoted; the workspace is not on this machine; not a git
checkout; detached HEAD; a merge, rebase, cherry-pick or revert in progress; uncommitted changes to tracked
files; a conflict) and the `command` to run by hand.

### `POST /runs/{run_id}/merge`  body `{"commit": "8e20ccedc448"}`
Takes the run's verified work into the checkout's current branch, as the person. It merges only the run's own
batch branch, and only the commit the person reviewed: pass the diff's `commit` (a prefix of 7 or more hex
digits); if the branch moved since, nothing is merged (`code: conflict`). Refusals are `code: refused` with the
reason and the command to run by hand (`hint`). A merge that git stops half way is aborted, so the checkout is
left as it was.
```json
{"ok": true, "merge": {"run_id": "…", "merged": true, "already": false, "mode": "fast-forward",
  "into": "main", "branch": "roko/batch/…", "commit": "8e20ccedc448", "previous_head": "92297be3709e",
  "head": "8e20ccedc448", "undo_command": "git -C /path/ws reset --keep 92297be3709e…"}}
```
`forbidden` when `permissions.write` is false.

0.5.0: `{"commit", "confirm": true, "work"?, "plan_id"?}` merges a part the run kept on a plan branch (work no
check ran on, or the tasks that passed in a plan that failed). Such a merge is refused (`code: refused`) without
`"confirm": true`: send it only after the person read `merge.confirm` and agreed. Its merge commit says so
("Merge roko run e13f6327 (unverified work): …"). A demo plan's output is refused. After any merge every card
reads the checkout again.

### `POST /runs`  body `{"prompt": "…", "max_usd": 0.5, "domain": "code", "title": "Add budgets"}`
The person asks roko for work from the UI. Without `plan`, roko runs the request as one checked task, under the
same caps as a run Hermes' model starts (`max_usd` is required; `max_run_usd` and `max_day_usd` apply).
`domain` is `code` (default), `research` or `docs`; `title` (≤80 chars) names the run in lists. With
`"plan": true`, roko's planner writes a plan for the request instead (model spend, no cap; nothing runs until the
person starts the plan). 0.5.0: the run's name (the `title`, else the request's short title) goes to roko as its
`title` when roko's `run_prompt` / `plan_generate` take one (roko gap-c2efe7, read from its `tools/list`): roko
then uses it for the plan's title, the batch branch's description and the commit's subject. An older roko is
sent none.
```json
{"ok": true, "run_id": "…", "kind": "run", "state": "running", "max_usd": 0.5, "queue_position": null}
{"ok": true, "run_id": "…", "kind": "plan_generate", "plan_id": "add-budgets", "state": "running"}
```
A newer roko queues a run that starts while another holds its workspace: `state: "queued"` with its
`queue_position` (1 = next). Refusals: `invalid` (no prompt, a prompt over 8,000 characters, a bad cap or
domain), `refused` (over the daily limit, or roko refused), `forbidden` when `permissions.write` is false.
When the refusal is a setup problem the person can fix (roko refuses runs from a chat, has no model for them, or
the key is read-only), the answer also carries it, and `/overview`'s `setup` lists it from then on:
```json
{"ok": false, "error": {"code": "refused", "message": "a run from a chat host needs the data-model boundary: …",
                        "hint": "…"},
 "problem": {"id": "workspace-refuses-chat-runs", "severity": "block", "title": "…", "detail": "…",
             "fix": {"kind": "action", "label": "make ready", "action": "workspace-chat-ready",
                     "command": "hermes roko fix workspace-chat-ready", "docs": "…"}}}
```
Show the problem's card (and its fix) instead of the raw error.

### `GET /plans`
```json
{"ok": true, "plans": [{"id": "add-tests", "title": "Add tests", "task_count": 3, "tasks_done": 1,
                        "tasks_not_passed": 0, "status": "ready", "group": "my-plans",
                        "demo": false, "start_here": false}], "total": 1}
```
`status` is roko's own text (`ready`, `done (1d ago)`, `last run did not pass (2h ago)`). `group` is roko's plan
set (`demos/parallel-plans`). 0.5.0: `demo` (roko's `fixture` flag since gap-8f84d1, kept once the plan has
run, and `fixture` itself when roko gives it; from an older roko, group `demos…` or status `fixture`) and
`start_here` (its title starts "Start here": the demo to try first).

### `GET /plans/{plan_id}`
```json
{"ok": true, "plan": {"plan_id": "add-tests", "title": "Add tests", "group": "my-plans", "status": "ready",
  "demo": false, "start_here": false, "task_count": 3, "max_parallel": 2,
  "tasks": [{"id": "T1", "title": "lexer", "depends_on": [], "checks": ["cargo test -p lexer"],
             "role": "implementer", "tier": "focused", "files": ["src/lexer.rs"], "description": "…"}],
  "waves": [["T1", "T2"], ["T3"]],
  "estimate": {"total_cost_usd": 0.0267, "total_duration_secs": 30, "confidence": "low",
               "basis": "Based on historical efficiency events"}}}
```
`waves` groups tasks that can run together (by `depends_on`). `estimate` is `null` if roko can't estimate.
0.5.0: `title` is the plan's own title, from roko's `/tasks` since bug-e0624e, else (an older roko gives the plan's
id there) from the plan's row, with its
`group`, `status`, `demo` and `start_here`. 0.5.0: `validation` is a `PlanValidation` when roko would not run the
plan now (its list says `ready` all the same), else null; a task with open questions has them as
`tasks[].open_questions` (the same rows). Show them on the plan card before the person presses Run plan.

### `POST /plans/{plan_id}/run`  body `{"max_usd": 1.0, "resume": false, "title": "…"}`
Starts a paid plan run as the person (a click in the UI is the person's approval). Refused with
`code: invalid` when `max_usd` is missing, < 0.01 or above the plugin's `max_run_usd`, with
`code: refused` when it would take today's spend over `max_day_usd` (the hint says how much is left), and
with `code: forbidden` when `permissions.write` is false. A refusal that is a setup problem carries `problem`, as
for `POST /runs`. 0.5.0: when roko refuses because the plan fails its validator ("failed validation with 1
error(s)"; an older roko names only the count, a newer one lists the errors after it, roko bug-7a08a8), the
answer is `code: refused` with roko's own reasons in `error.message`, read from its validator, else from that list
("roko will not run plan two-modules: PLAN_045: task 'T2' has open questions … Open questions: (1) … (suggested:
…)"), the person's step in `error.hint`, and `validation`, a `PlanValidation`:
```json
{"ok": false, "error": {"code": "refused", "message": "roko will not run plan two-modules: …", "hint": "answer …"},
 "validation": {"valid": false, "errors": [{"rule": "PLAN_045", "task_id": "T2", "message": "…"}],
                "open_questions": [{"task_id": "T2", "question": "…or raise?", "assumption": "return only …"}],
                "summary": "PLAN_045: task 'T2' has open questions, so its plan cannot run; …"}}
```
A plan-writing card (`kind: plan_generate`) whose plan roko's validator rejects adds the same `validation`, `why:
{summary: "roko wrote the plan, but it cannot run yet: …", validation}`, `next` ("answer the plan's open
questions", or "fix what roko found in the plan") and "cannot run yet" in its headline. An older roko reports
such a plan written (`state: succeeded`); since roko bug-7a08a8 its generation ends `failed`, with the plan written
anyway and the reasons in `planner_error` ("plan generation failed for <slug>: the plan was written to
plans/<slug>, but it cannot run: 1 error(s)" and a "- RULE message" line per error): the card says the same
things then, from roko's validator, or from those lines when roko cannot say now. `roko_status` gives the model
the same `validation`. A plan run that failed validation after it waited in roko's queue has `why.validation` and
the words in `why.summary`.
0.5.0: a plan-writing card's `cost_usd` is what roko's planner spent writing the plan (roko bug-a0432b: the
completed result's `cost_usd`, or the "Writing the plan cost $0.0115." line of a failed generation that wrote it
anyway, else what its returned planner calls cost so far, `writing.cost_usd`); its headline shows it, and
Hermes' spend for the day counts it. It is null from an older roko, and when roko says no cost. A plan writing that failed because no model roko's own tool loop runs is
set up ("…needs a model that runs in roko's own tool loop…") carries `problem`, the same setup `Problem` as a run
refused for it (`no-tool-loop-model`), and `/overview`'s `setup` lists it from then on.
```json
{"ok": true, "run_id": "…", "state": "running", "queue_position": null}
```

### `GET /pending`
```json
{"ok": true, "items": [PendingItem, …]}
```

### `POST /decide`  body `{"code": "a1b2c3", "approve": true, "note": "looks right"}`
The person's own answer (or `"decision_id"` instead of `"code"`). The item is looked up again first, so a
stale code is refused with `code: not_found`. Applying a held action can take minutes; a timeout returns
`code: unreachable` with "may still have been recorded".
```json
{"ok": true, "decision_id": "e_effect-1", "code": "a1b2c3", "approved": true, "outcome": "applied",
 "title": "the held action …"}
```
`outcome` is roko's word for what happened: a confirmation records `approved` or `rejected`; a held action
is `applied`, `rejected`, `failed` (the call ran and its checks did not pass) or `ambiguous` (it may have
run). Codes are matched case-insensitively. `forbidden` when `permissions.write` is false.

### `POST /runs/{run_id}/cancel`
```json
{"ok": true, "run_id": "…", "state": "cancelled"}
{"ok": true, "run_id": "…", "state": "interrupted", "reason": "…", "interrupted": Interrupted,
 "already_ended": true}
{"ok": true, "run_id": "…", "state": "succeeded", "already_ended": true}
```
0.5.0: a run nothing runs any more is `interrupted` rather than an error: roko answers so since bug-dceafd, and
an older roko's "no active execution for this plan", for a run it still calls running, means the same (its
roko serve stopped under it). A run that had already ended, an interrupted one included, answers its state
with `already_ended: true`. An id roko has no run for is still `not_found`.

### `GET /knowledge?q=parser&limit=10`
```json
{"ok": true, "query": "parser", "entries": [{"id": "k-1", "content": "…", "kind": "strategy_fragment",
             "tier": "working", "score": 3.97, "confidence": 0.7, "confirmations": 2,
             "created_at": "2026-10-09T13:00:50+00:00"}],
 "provenance": "recorded by roko's runs in its workspace"}
```
Without `q`: the most-cited entries (`score` and `tier` are null). `limit` ≤ 50.

### `GET /health`
The doctor's checks, from the same look at roko as `setup` (so a page that polls this asks roko nothing new), the
plugin's install state, and the setup problems.
```json
{"ok": true, "status": "fail",
 "checks": [{"name": "reachable", "status": "ok", "detail": "roko serve 0.1.0, status ok"},
            {"name": "runs", "status": "fail", "detail": "roko refuses runs started from Hermes in this workspace.",
             "hint": "make ready: hermes roko fix workspace-chat-ready", "problem": Problem}],
 "install": {"loaded_version": "0.4.0", "disk_version": "0.4.0", "desktop_copy_version": "0.4.0",
             "desktop_copy_stale": false, "backend_stale": false},
 "setup": Setup}
```
`status` (overall and per check) is `ok | warn | fail`. A check that fails because of a setup problem carries it as
`problem`. `install` is `null` when this install cannot tell; a backend older than 0.5 sends neither `install` nor
`setup`, which is how a newer page knows the backend must be restarted.

### `GET /setup/fix?action=workspace-chat-ready&variant=local`
What a fix would change, for the person to read before applying it. It changes nothing.
```json
{"ok": true, "action": "workspace-chat-ready", "title": "Make this workspace accept runs started from Hermes",
 "variant": "local",
 "variants": [{"id": "local", "label": "run without the boundary (local use)", "recommended": true,
               "available": true, "why": "…"},
              {"id": "boundary", "label": "screen with gpt-4o-mini", "recommended": false, "available": true,
               "why": "the cheapest model with its key set on openai, its maker's own API, at $0.75 per million tokens"}],
 "preview": "--- roko.toml (now)\n+++ roko.toml (after)\n@@ … @@\n…", "path": "/path/ws/roko.toml",
 "summary": "Lets runs you start from Hermes run as runs you start in a terminal do: …",
 "digest": "cffd5d887b90f846", "note": "A copy of roko.toml is kept in /path/ws/.roko/backups first. …"}
```
- `variant` is optional; without it the backend picks the recommended way. `variants` is empty when there is nothing
  to choose (nothing needs changing, or only one way works). A way with `available: false` says why in `why`.
- `preview` is a unified diff (untrusted text; show it in a monospace well). It is `""` when nothing in the file
  changes; `summary` and `note` then say why (roko already accepts runs, or roko serve does not read this file).
- Refused with `forbidden` when the plugin may not edit that `roko.toml` (roko serve is not on this machine, the
  workspace is unknown, or roko serve says it runs elsewhere), and with `invalid` for an unknown action or variant.

### `POST /setup/fix`  body `{"action": "workspace-chat-ready", "variant": "local", "digest": "cffd5d887b90f846"}`
Applies exactly the preview the person read: with `digest`, a `roko.toml` that changed since is refused with
`code: conflict` (show the preview again). It keeps a copy of the old file, writes the new one in one step, asks
roko again, and answers:
```json
{"ok": true, "action": "workspace-chat-ready", "variant": "local", "done": true, "ready": true,
 "path": "/path/ws/roko.toml", "backup": "/path/ws/.roko/backups/roko.toml.bak-20261015-173526",
 "summary": "…", "message": "Changed /path/ws/roko.toml. roko accepts runs started from Hermes now.",
 "next": "commit roko.toml before you merge a run, …: git -C /path/ws commit -m \"…\" -- roko.toml"}
```
`done` says whether the file changed, `ready` whether roko accepts runs started from Hermes now, and `next` what is
left for the person, or `null`. roko reads `roko.toml` for every run, so no restart is needed; `next` names one only
when roko still refuses after the change. `invalid` when roko rejects the changed file (the old one is put back);
`forbidden` when `permissions.write` is false.

#### `action=commit-roko-toml` (0.5.0)

Merge refuses a checkout with uncommitted changes to tracked files, and the setup fix changes `roko.toml`. When
`roko.toml` is the only such file, the card's `merge.fix` is this action, previewed and applied like the others:
`GET /setup/fix?action=commit-roko-toml` answers `{action, title: "Commit roko.toml", variant: null, variants: [],
preview (its diff against HEAD), path, summary, digest, note}`, and `POST /setup/fix {"action":
"commit-roko-toml", "digest"}` commits `roko.toml` alone (nothing else, with the person's git name and the
checkout's own hooks) and answers `{action, done, ready: true, commit, path, summary, message, next: null}`. A
`roko.toml` that changed since the preview is refused with `conflict`; no change: `done: false`. `forbidden`
when the workspace is not on this machine.

### `GET /insights?scope=hermes|workspace`
Gates, models and spend, for a dashboard panel. 0.5.0: in one of two scopes, each labelled with its period:

- `scope=hermes` (the default): the runs Hermes started, from the plugin's run log (≤200 runs) and what each
  ended run's card recorded there (each task's last verdict per check, its models, its spend). No request to
  roko. A task roko stopped at the run's cap (`stopped`, 0.5.0) is no verdict on its model: its spend counts
  in the model's row, the task does not; and `summary.tasks.failed` leaves it out.
- `scope=workspace`: every run in roko's whole workspace, from roko's own routes (before 0.5.0, the only scope).

Take CHECKS PASSING from `summary.checks`: it counts the checks that ran. A task no check ran on is
unverified, never failed; roko's own `task verdict` row (`kind: "verdict"`) counts it as not passed, so it is
left out of `summary.checks` (in the workspace scope `summary.tasks.not_verified` holds that count, since roko
cannot tell unverified from failed there).
```json
{"ok": true,
 "scope": {"kind": "hermes", "label": "runs started from Hermes", "since": "2026-10-15T14:20:01Z",
           "until": "2026-10-15T16:52:40Z"},
 "summary": {"runs": {"total": 6, "succeeded": 3, "unverified": 1, "failed": 1, "cancelled": 0,
                      "interrupted": 1, "missing": 0, "running": 0},
             "tasks": {"total": 9, "verified": 6, "unverified": 1, "failed": 2},
             "checks": {"passed": 7, "failed": 2, "ran": 9, "pass_rate": 0.7778},
             "spend_usd": 0.12, "cost_per_task_usd": 0.0133, "typical_task_ms": 21000},
 "gates": [{"gate": "verify[0:test]", "kind": "check", "pass_rate": 0.83, "passed": 5, "failed": 1, "total": 6,
            "avg_duration_ms": 601, "last_at": "…", "last_model": "glm-5.1"}],
 "models": [{"model": "glm-5.1", "tasks": 5, "success_rate": 1.0, "total_cost_usd": 0.05,
             "avg_cost_usd": 0.01, "total_tokens": 17456}],
 "cost_trend": [{"at": "…", "cost_usd": 0.01, "cumulative_usd": 0.32}],
 "efficiency": {"total_cost_usd": 0.32, "cost_per_task_usd": 0.036, "avg_task_duration_ms": 45670,
                "tasks_recorded": 9},
 "problems": []}
```
roko names one rung two ways (`verify[0:test]` and `verify:0/test`); the plugin shows one. `problems` lists the
parts roko could not answer; when none answered, the route answers `ok: false` (workspace scope). In the hermes
scope `summary.runs` counts the runs by state (`running` includes queued), `models[].unverified` counts the
tasks no check ran on, and `avg_duration_ms`, `last_at`, `last_model` and `total_tokens` are null; in the
workspace scope `summary.runs` is null. `invalid` for another scope.

### `GET /effects`
Held actions: how many still wait (see `/pending` for them), and the decisions made, newest first.
```json
{"ok": true, "waiting": 0,
 "decided": [{"effect_id": "…", "run_id": "…", "task_id": "T1", "tool": "mail.send", "server": "mail",
              "outcome": "applied", "decided_by": "hermes", "note": "go ahead", "decided_at": "…",
              "receipts": [{"rung": "delivered", "passed": true, "output": "250 OK"}]}]}
```

### `GET /loops`
roko's five loops for the Loops view, in one answer. Each part comes from one of roko's own routes and is
read on its own: a part roko cannot answer goes into `problems`, and its ring shows what it has.
```json
{"ok": true,
 "rings": [
   {"ring": "L0", "name": "tool calls", "clock": "seconds", "state": "active", "recent": [LoopEvent, …],
    "counts": {"held": 1, "withheld": 0}},
   {"ring": "L1", "name": "attempts", "clock": "minutes", "state": "quiet", "recent": [],
    "routes": [{"ts": "2026-10-14T15:51:13.970Z", "task_id": "T1", "attempt_key": "…:T1:1", "model": "glm-5.1",
                "provider": "zai", "stage": "static", "reason": "ladder", "source": "ladder", "p": 1.0,
                "candidates": [{"model": "claude-sonnet-4-6", "provider": "claude_cli", "score": 1.0, "p": 0.0,
                                "eligible": true, "ineligible_reason": null}, …],
                "outcome": true, "cost_usd": 0.01}],
    "retry_budgets": [{"rung": "verify[0:test]", "ema_pass_rate": 0.92, "observations": 30,
                       "consecutive_passes": 4, "suggested_max_retries": 1, "should_skip": false}]},
   {"ring": "L2", "name": "the plan", "clock": "hours", "state": "quiet", "recent": [],
    "diagnoses": [{"id": "stall-watchdog:…:silent", "source": "stall-watchdog", "ts": "…", "severity": "warn",
                   "subject": "plan/T2", "detail": "agent silent: no progress for 180s",
                   "suggested_action": "…", "intervention_taken": null}]},
   {"ring": "L3", "name": "learning", "clock": "days", "state": "active", "recent": [LoopEvent, …],
    "models": [{"model": "glm-5.1", "tasks": 9, "success_rate": 0.9, "total_cost_usd": 0.09,
                "avg_cost_usd": 0.01, "total_tokens": 17456}],
    "thresholds": [same rows as L1's retry_budgets],
    "knowledge": {"total": 12, "recent": [{"id": "k-1", "text": "…", "kind": "insight", "confidence": 0.7,
                                           "citations": 2}]},
    "playbooks": {"total": 4}},
   {"ring": "L4", "name": "audit", "clock": "weeks", "state": "quiet", "recent": [],
    "loops": [{"loop_id": "L-route", "lifecycle": "active", "state": "healthy", "reason": null, "h": 0.1,
               "n_opp": 40, "eps": 0.04, "iota_net": 0.2, "beta": 0.9}]}
 ],
 "live": {"running": true, "hub": "open", "subscribers": 1},
 "problems": [],
 "checked_at": "2026-10-14T12:00:00.000+00:00"}
```
- `recent`: the ring's latest `LoopEvent`s this backend saw (from the live relay, and the cards of the runs
  Hermes started recently), newest first, ≤12; each also has `run_id`. `state` is `active` when one is less
  than 10 minutes old, else `quiet`. 0.5.0: L2 has each recent run's wave openings ("wave 2 open: T2, T3 in
  parallel", as on its card), also for a run whose waves opened before any page followed it. A threshold's rung
  is named as roko numbers them: compile, lint, test, symbol, gen-test, prop-test, integration, and 1000/1001
  whole-plan/post-merge ("gate thresholds updated: test 92% · lint 80%"), the pages' `RUNG_NAMES`.
- the parts: L0 `counts` (held calls waiting, from `/api/effects/pending`; withheld tool results, from
  `/api/safety/incidents`), L1 `routes` (`/api/learn/loops/L-route/decisions?limit=10`, newest first; 0.5.0:
  each with a route's `decided_by`, `rung`, `scored` and candidates' `why_not`, as on a card) and
  `retry_budgets` (`/api/learn/adaptive-thresholds`), L2 `diagnoses` (`/api/diagnosis/recent`, newest first,
  ≤10; `source` is who raised it: `conductor`, `stall-watchdog`, `ladder_exhausted`, `self_model_refine`, …),
  L3 `models` (`/api/learn/model-scorecard`), `knowledge` (`/api/knowledge/entries`), `playbooks`
  (`/api/learn/playbooks`), L4 `loops` (`/api/learn/loops`: each learning loop's lifecycle, health `state`
  and its numbers `h`, `n_opp`, `eps`, `iota_net`, `beta`, any of which may be null).
- `live`: the relay's state (`hub` is `stopped`, `connecting`, `open` or `backoff`) and how many sockets
  are open.

## Setup problems

| `id` | `severity` | `fix.kind` | When |
|---|---|---|---|
| `restart-hermes` | block | `restart-hermes` | Hermes runs an older copy of the plugin than the one installed (the desktop copy or the backend) |
| `roko-unreachable` | block | `command` | roko serve does not answer at the plugin's URL, or something else does |
| `roko-key-refused` | block | `command` | roko serve has auth on, and the plugin has no key or one roko refuses |
| `plugin-settings` | block | `docs` | the plugin's own settings stop it from using roko serve |
| `key-read-only` | block | `command` | the key cannot start, cancel or answer runs |
| `workspace-refuses-chat-runs` | block | `action` (`workspace-chat-ready`) on this machine, else `docs` | roko refuses runs started from a chat in this workspace |
| `no-tool-loop-model` | block | `docs` | roko has no model a run started from a chat can use (only CLI agents, or no key) |
| `no-priced-model` | block | `docs` | roko refuses runs started from a chat because none of the models they can use has a price their cap can count (roko since gap-8548e3) |
| `roko-serve-outdated` | block or warn | `docs` | roko serve lacks the run tools (block), or the diff route or its loop events (warn) |
| `approvals-off` | warn | `command` | Hermes' `approvals.mode` is off: Hermes approves every tool call by itself, so paid roko runs start without a question (from `readiness.hermes_problems()`, on `/overview` and `/health`) |

Every problem comes from roko's own answers: a run probe that names a plan which cannot exist (nothing starts, nothing
is paid), roko's model and provider lists, and the runs Hermes started on this roko serve. When roko does not say,
the problem is left out rather than guessed.

## The live channel: `WS /live`

`WS /api/plugins/roko/live` pushes what roko does as it happens. Behind it, one relay per Hermes backend
process follows roko's event hub (`GET /api/events`, server-sent events) and, for the runs Hermes started
(and any a page names), pushes agent activity and loop events at once, and the run's rebuilt card and new
timeline lines soon after.

- **Open it** from the desktop half with `ctx.socket('/live', onMessage)` (receive-only); from the dashboard
  with `new WebSocket(SDK.buildWsUrl('/api/plugins/roko/live'))`, building a fresh URL for every reconnect.
  `?runs=a,b` (≤8 ids) also follows runs Hermes did not start, while the socket is open.
- **Auth** is Hermes' own WebSocket check (`_ws_auth_ok`: the session token, a ticket, or an internal
  credential), made before the upgrade is accepted, as Hermes' chat sockets do. A refused credential fails
  the handshake: browsers and `websockets` see HTTP 403 (close code 1006 in a browser); Starlette's test
  client sees close code 4401. If a Hermes version lacks that check, the socket is refused (fail closed);
  pages then poll.
- **The client sends nothing.** Every frame is one JSON object with a `type`; all text in them is cleaned
  like everything else here and untrusted.
- The relay starts when a socket opens (and, under `hermes serve`, when a run starts or an overview finds an
  active one), and stops a minute after nothing needs it. Without roko's hub (roko down, or an older roko)
  it re-reads active runs every 3 s instead, and the frames keep their shape.

| `type` | when | fields |
|---|---|---|
| `hello` | first, on connect | `version` (the plugin's), `overview` (as `GET /overview` answers it, or null with `error`), `server_time`, `hub` |
| `overview` | the runs' states, spend or waiting items changed (≤ one per 1.5 s) | `overview` |
| `run` | a run's card changed (≤ one per 0.6 s per run, about 0.12 s after the event that changed it; at once when the run ends or something starts or stops waiting) | `run`: the full card, as `GET /runs/{id}` |
| `lines` | the run's timeline grew | `run_id`, `lines`: timeline lines as `GET /runs/{id}/events` gives them, in `cursor` order |
| `live` | an agent did something | `run_id`, and the `LiveItem` fields |
| `loop` | one of roko's loop events | `run_id` (null when it names no run Hermes follows), and the `LoopEvent` fields |
| `ping` | every 15 s | `server_time`, `hub` |

```json
{"type": "hello", "version": "0.4.0", "overview": {"ok": true, …}, "server_time": "2026-10-14T11:51:23.844+00:00", "hub": "open"}
{"type": "live", "run_id": "fe8a46ed-…", "kind": "tool", "plan_id": "budgets", "task_id": "T1", "attempt": 1,
 "ts": 1791978686458, "tool": "Read", "target": "tally/budgets.py", "tool_id": "T1-1-0"}
{"type": "live", "run_id": "fe8a46ed-…", "kind": "text", "plan_id": "budgets", "task_id": "T1", "attempt": 1,
 "ts": 1791978688766, "text": " complete.", "said": "The implementation is complete.", "screened": false}
{"type": "loop", "run_id": "fe8a46ed-…", "ring": "L1", "kind": "route",
 "text": "T1 attempt 1 → glm-5.1, picked by the model ladder (rung mid)",
 "data": {"attempt": 1, "model": "glm-5.1", "provider": "zai", "source": "ladder", "stage": "static",
          "reason": "ladder", "p": 1.0, "candidates": [{…}]},
 "task_id": "T1", "plan_id": "budgets", "ts": 1791978686050, "key": "route:budgets:T1:1:glm-5.1:ladder"}
{"type": "loop", "run_id": "fe8a46ed-…", "ring": "L2", "kind": "wave", "text": "wave 2 open: T2, T4 in parallel",
 "data": {"wave": 2, "tasks": ["T2", "T4"]}, "task_id": null, "plan_id": "budgets", "ts": 1791978690112, "key": "wave:1"}
{"type": "lines", "run_id": "fe8a46ed-…", "lines": [{"cursor": 4703, "type": "gate_result", "group": "gate", …}]}
{"type": "run", "run": {"run_id": "fe8a46ed-…", "state": "running", "loops": [LoopEvent, …], "tasks": [{…, "steps": […]}], …}}
{"type": "ping", "server_time": "2026-10-14T11:51:38.764+00:00", "hub": "open"}
```

How to use them:

- Merge `lines` into the run's timeline by `cursor` and `loop` events by `key` (a page that also read
  `/events` or a card's `loops` sees some twice). A socket's first `lines` for a run Hermes started holds the
  lines written since it started; for other runs, read `/events` for what came before.
- A `run` frame replaces the card. Frames that led to it (`lines`, loop events the hub did not deliver)
  arrive just before it. A card that came back with `problems` (roko rate-limited the reads of a long run's index,
  say) is rebuilt and sent again after 2 s, doubling each time, up to 5 times.
- `live` items are ephemeral: show the newest per task (a ticker, a "now" line), and fall back to the card's
  `tasks[].steps` and `live_text` when the page opens mid-attempt. For words, show `said`: roko streams them a
  token at a time, and `said` is the running tail of the stretch. At most 20 items per second per run reach a
  socket; items over that wait for the next window, the newest per task and kind, so a words item that waited
  carries every word in its `said`. A heartbeat (`beat`) arrives at most every 4 s per task. With roko's default
  `[serve] live_agent_output = "tool_steps"` only `tool` items arrive during an attempt; `"trusted"` (loopback
  binds only) streams `text`, `reasoning` and `result` too. roko streams words for plan runs; a prompt run's words
  and an API model's tool steps arrive with the attempt's transcript, when it ends.
- A slow socket drops `live` and `ping` frames first, then `lines` and `loop`, and keeps only the newest
  `run` per run and the newest `overview`; a reconnect re-reads what it needs.
- When the hub reconnects (roko restarted) or roko reports a gap, every followed run's card is rebuilt and
  sent; a reconnecting page gets `hello` again.
- A run a page follows by its id (`?runs=`) is mapped to its plans from its first rows (roko names a
  running run's plans only once it closes), so the first second or so of its events reaches the socket
  through the card's deltas rather than as they happen.
- 0.5.0: a run Hermes started whose first events reach the relay before the start itself has returned (a fast run,
  a busy backend) gets them anyway: events of no followed run are kept for 10 s and played again when the run is
  followed, as `live` and `loop` frames. Its sign-offs are not in `/pending`, which lists
  what waits in the runs Hermes started.

The loop kinds:

| `kind` | ring | from roko's | `data` | text, for example |
|---|---|---|---|---|
| `tool_held` | L0 | `effect_staged` | `effect_id, tool, server, attempt` | "T2 wants to call mail.send on mail: held for you" |
| `tool_decided` | L0 | `effect_decided` | `effect_id, tool, server, outcome, decided_by` | "mail.send on mail: applied" |
| `withheld` | L0 | (no event yet: counted in `/loops`) | | |
| `route` | L1 | `route_decided` | `attempt, model, provider, source, stage, reason, p, candidates`; 0.5.0 adds `decided_by, rung, scored` and candidates' `why_not` | "T1 attempt 2 → glm-5.1, picked by what roko learned (p 0.82; over gpt-5.4-mini 0.71)" · "T1 attempt 1 → gpt-oss-120b, picked by the model ladder" (0.5.0: the scores only for a learned pick) |
| `failover` | L1 | `route_decided` with `source: failover`, or (an older roko) a second `agent_spawned` for one attempt on a new model | as `route` | "T3 attempt 1 switched to glm-5.1 (failover): gpt-5.4-mini on openai passed over (rate_limited): 429 Too Many Requests" |
| `retry` | L1 | a later `agent_spawned` for a task | `attempt, model, provider` | "T3 attempt 3 on glm-5.1" |
| `regression` | L1 | `event_log_entry` `gate_regression` | `message` | "T2: verify[0:test] passed on an earlier attempt and fails now" |
| `wave` | L2 | the first `task_started` of a wave | `wave` (from 1), `tasks` | "wave 2 open: T2, T4 in parallel" |
| `diagnosis` | L2 | `diagnosis` | `id, severity, subject, detail, suggested_action, intervention_taken` | "stall watchdog: T2 · agent silent: no progress for 180s" |
| `budget` | L2 | `inbox_item_received` `budget_alert`, `event_log_entry` `graph.plan_budget_raised` | an alert: `item_id, urgency`, and `percent, spent_usd, cap_usd` when roko's summary states them; a raise: `message` | "spend passed 80% of the cap: $0.80 of $1.00" |
| `hold` | L2 | `confirm_waiting`, `confirm_resolved`, `task_phase_changed` to `awaiting_approval` | `state` (`waiting`, `resolved`), `attempt, attempt_key, rung, question, timeout_secs, deadline_at`; resolved adds `outcome, note` | "T1 waits for your sign-off (30 min)" · "T1 sign-off: approved" |
| `thresholds` | L3 | `gate_thresholds_updated` | `rungs: [{rung, name, ema_pass_rate, observations, consecutive_passes, shift}]` | "gate thresholds updated: test 92% · compile 100%" |
| `knowledge` | L3 | `knowledge_written` | `admission, entry_id, reinforced, promoted, lesson` | "T1: kept a new lesson: Budgets persist as integer cents per category · confirmed 1 lesson it had" · "HELLO-1: nothing new to learn from this task · confirmed 3 lessons it had · 3 moved up a tier" (`no_candidate`; the pages' words, ui-notes D7) |
| `loop_health` | L4 | `loop_health`, `loop_transition` | `loop_id, state, reason, h, eps, …`; a transition adds `from, to, rule, actor` | "model routing: on probation · holdout 20% · reach 4%" · "lessons in prompts: on probation → proven: its learning is in use" (0.5.0: the loop's name, states and figures in the pages' words, ui-notes D8) |
| `guarded_commit` | L4 | `event_log_entry` `learning.guarded_commit` | `message` | "a learning update was held back by its guard: knowledge: 2 entries held back" |

An event of a type the plugin does not know is ignored, and an older roko that publishes none of the newer
events simply never lights those kinds. roko publishes `knowledge_written` only when the knowledge store
changed, and `withheld` has no event yet (`/loops` counts withheld results).

For building the pages without roko: `python tests/replay_roko.py --seed <HERMES_HOME> --tour` replays real
runs with the newer events made up in roko's shapes (marked `"synthetic": true` on the raw rows; frames do
not carry the mark), and `--tour` adds one of each loop event the recordings never show to every five-task
plan run it starts. Events that name no plan (threshold and loop-health updates, a
guard's notice) belong to the one run Hermes follows when there is one, else `run_id` is null; a diagnosis
or a budget alert names its plan in its subject or item id.

## Desktop plugin events

Under `hermes serve` (the desktop app's backend, where the plugin's tools and router share one process) the
backend emits Hermes plugin events, which the desktop half hears with `host.onEvent('plugin.roko.<name>', …)`
even when no roko page is open. Elsewhere (`hermes dashboard`, a terminal chat) they are not emitted.

| event | when | payload |
|---|---|---|
| `plugin.roko.run.started` | a tool (`roko_run`, `roko_plan_generate`, `roko_plan_run`) or a page started a run, at once | `{run_id, kind: "run" \| "plan" \| "plan_generate", label, state, plan_id, max_usd, source: "chat" \| "ui" \| null}` |
| `plugin.roko.run.ended` | a followed run reached `succeeded`, `failed`, `unverified`, `cancelled` or `interrupted` | `{run_id, state, label, cost_usd, headline, interrupted}` (`interrupted`: an `Interrupted` or null, 0.5.0) |
| `plugin.roko.waiting` | something new waits on the person (a sign-off, a held call), once per item | `{run_id, code, kind: "confirm" \| "effect", title, question, task_id}` |

`code` is the 6-character code `/roko approve` and `POST /decide` take.

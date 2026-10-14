# roko UI API: the backend the desktop and dashboard halves share

`dashboard/plugin_api.py` exports a FastAPI `router` that Hermes mounts at **`/api/plugins/roko`**, in both
`hermes serve` (the desktop app's backend; the desktop half calls it with `ctx.rest('/overview')`) and
`hermes dashboard` (the web dashboard calls it with `SDK.fetchJSON('/api/plugins/roko/overview')`). Hermes
authenticates every request (desktop session token, dashboard session); the routes add none of their own.

The router is the only thing that talks to roko serve. The roko API key never reaches a renderer.

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
- All text that came from roko (labels, questions, summaries, gate output, milestone text) has terminal
  control characters stripped, and is **untrusted**: render it as text nodes only, never as HTML or markdown.
- Times are ISO-8601 strings (UTC) or `null`. Money is a number of US dollars or `null` when unknown
  (render `—`, never `$0.00`, for `null`).
- Run states: `queued | running | succeeded | failed | unverified | cancelled`, plus the plugin's own
  `missing` (Hermes started the run, but roko keeps no record of it: roko refuses a prompt run that starts
  while another run holds the workspace, roko bug-09e21e). `unverified` means no check ran: never show it as
  green. Task outcomes add `pending, running, passed, skipped, already_satisfied, accepted_with_failures,
  blocked`.
- Poll no faster than every 3 s for a single run and every 10 s for the overview. Nothing here pushes: tick
  clocks (elapsed, a task's step time) on the client between polls.

## Shared shapes

```ts
type RunRow = {
  run_id: string
  kind: 'run' | 'plan' | 'plan_generate'
  label: string                 // the run's title when one was given, else the prompt (run), the plan id (plan)
                                // or the request (plan_generate); ≤120 chars, one line
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
}

type Progress = {               // every task counted once, by where it is now
  total: number, passed: number, failed: number, running: number, pending: number,
  blocked: number, stopped: number, unverified: number
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

type Connection = {
  url: string                   // roko serve, without credentials
  reachable: boolean
  version: string | null
  status: string | null         // "ok" | "degraded" | …
  credential: string            // "env:ROKO_API_KEY" | "launch-token:…" | "none" (never the key)
  error: { code: string; message: string; hint?: string } | null
}
```

## Routes

### `GET /overview`
Everything the status chip, the sidebar badge and the landing page need, in one call.
```json
{
  "ok": true,
  "plugin_version": "0.3.0",
  "connection": {"url": "http://127.0.0.1:6677", "reachable": true, "version": "0.1.0", "status": "ok",
                 "credential": "env:ROKO_API_KEY", "error": null},
  "counts": {"running": 1, "queued": 0, "waiting": 2},
  "spend": {"today_usd": 0.42, "committed_usd": 1.0, "max_day_usd": 10.0, "left_usd": 8.58, "runs_today": 3},
  "limits": {"max_run_usd": 5.0, "max_day_usd": 10.0},   // max_day_usd null: no daily limit
  "permissions": {"write": true},   // false: hide Run / Approve / Reject / Cancel (ui_actions: false)
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
    "gates": {"passed": 1, "failed": 0, "total": 1},
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
`null` when nothing was recorded yet. `delivered` is roko serve's own answer, the run summary's `result`
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
  numbered by the plugin since roko numbers every attempt 0, roko bug-369c21); and `note`, the last thing the
  task's agent said (≤1,200 chars, untrusted).
- `why` on a run that ended without success: `{summary, gates_not_passed: [{task_id, title, gate, runs,
  output, key_line}], blocked: [{task_id, blocked_by, reason}], unverified_tasks, errors}`. `summary` is one
  paragraph ("T1's check verify[0:compile] did not pass after 6 attempts: bash: line 1: python: command not
  found. T2, T3, T4 and T5 were blocked because T1 did not pass."); `key_line` is the line of the check's
  output most likely to say why.

A run roko has no record of (state `missing`) has a short card: `problems` says why, and `tasks` is empty.

A plan generation's card is shorter: `kind: "plan_generate"`, `plan_id`, `task_count`, `planner_error`.

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

### `GET /runs/{run_id}/diff?max_files=100&max_patch_bytes=65536`
What an ended run's verified work changes, file by file, from roko serve (`GET /api/runs/{id}/diff`), or,
against an older roko serve, read from the run's batch branch with git when the workspace is on this machine.
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

### `GET /runs/{run_id}/merge`
Whether Merge would work now, without changing anything.
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

### `POST /runs`  body `{"prompt": "…", "max_usd": 0.5, "domain": "code", "title": "Add budgets"}`
The person asks roko for work from the UI. Without `plan`, roko runs the request as one checked task, under the
same caps as a run Hermes' model starts (`max_usd` is required; `max_run_usd` and `max_day_usd` apply).
`domain` is `code` (default), `research` or `docs`; `title` (≤80 chars) names the run in lists. With
`"plan": true`, roko's planner writes a plan for the request instead (model spend, no cap; nothing runs until the
person starts the plan).
```json
{"ok": true, "run_id": "…", "kind": "run", "state": "running", "max_usd": 0.5, "queue_position": null}
{"ok": true, "run_id": "…", "kind": "plan_generate", "plan_id": "add-budgets", "state": "running"}
```
A newer roko queues a run that starts while another holds its workspace: `state: "queued"` with its
`queue_position` (1 = next). Refusals: `invalid` (no prompt, a prompt over 8,000 characters, a bad cap or
domain), `refused` (over the daily limit, or roko refused), `forbidden` when `permissions.write` is false.

### `GET /plans`
```json
{"ok": true, "plans": [{"id": "add-tests", "title": "Add tests", "task_count": 3, "tasks_done": 1,
                        "tasks_not_passed": 0, "status": "ready"}], "total": 1}
```
`status` is roko's own text (`ready`, `done (1d ago)`, `last run did not pass (2h ago)`).

### `GET /plans/{plan_id}`
```json
{"ok": true, "plan": {"plan_id": "add-tests", "title": "Add tests", "task_count": 3, "max_parallel": 2,
  "tasks": [{"id": "T1", "title": "lexer", "depends_on": [], "checks": ["cargo test -p lexer"],
             "role": "implementer", "tier": "focused", "files": ["src/lexer.rs"], "description": "…"}],
  "waves": [["T1", "T2"], ["T3"]],
  "estimate": {"total_cost_usd": 0.0267, "total_duration_secs": 30, "confidence": "low",
               "basis": "Based on historical efficiency events"}}}
```
`waves` groups tasks that can run together (by `depends_on`). `estimate` is `null` if roko can't estimate.

### `POST /plans/{plan_id}/run`  body `{"max_usd": 1.0, "resume": false, "title": "…"}`
Starts a paid plan run as the person (a click in the UI is the person's approval). Refused with
`code: invalid` when `max_usd` is missing, < 0.01 or above the plugin's `max_run_usd`, with
`code: refused` when it would take today's spend over `max_day_usd` (the hint says how much is left), and
with `code: forbidden` when `permissions.write` is false.
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
```

### `GET /knowledge?q=parser&limit=10`
```json
{"ok": true, "query": "parser", "entries": [{"id": "k-1", "content": "…", "kind": "strategy_fragment",
             "tier": "working", "score": 3.97, "confidence": 0.7, "confirmations": 2,
             "created_at": "2026-10-09T13:00:50+00:00"}],
 "provenance": "recorded by roko's runs in its workspace"}
```
Without `q`: the most-cited entries (`score` and `tier` are null). `limit` ≤ 50.

### `GET /health`
The doctor's checks, without the run probe.
```json
{"ok": true, "status": "fail",
 "checks": [{"name": "reachable", "status": "ok", "detail": "roko serve 0.1.0, status ok"},
            {"name": "auth", "status": "fail", "detail": "…", "hint": "…"}]}
```
`status` (overall and per check) is `ok | warn | fail`.

### `GET /insights`
Gates, models and spend across roko's whole workspace (not only Hermes' runs), for a dashboard panel.
```json
{"ok": true,
 "gates": [{"gate": "verify[0:test]", "pass_rate": 0.83, "passed": 5, "failed": 1, "total": 6,
            "avg_duration_ms": 601, "last_at": "…", "last_model": "glm-5.1"}],
 "models": [{"model": "glm-5.1", "tasks": 5, "success_rate": 1.0, "total_cost_usd": 0.05,
             "avg_cost_usd": 0.01, "total_tokens": 17456}],
 "cost_trend": [{"at": "…", "cost_usd": 0.01, "cumulative_usd": 0.32}],
 "efficiency": {"total_cost_usd": 0.32, "cost_per_task_usd": 0.036, "avg_task_duration_ms": 45670,
                "tasks_recorded": 9},
 "problems": []}
```
roko names one rung two ways (`verify[0:test]` and `verify:0/test`); the plugin shows one. `problems` lists the
parts roko could not answer; when none answered, the route answers `ok: false`.

### `GET /effects`
Held actions: how many still wait (see `/pending` for them), and the decisions made, newest first.
```json
{"ok": true, "waiting": 0,
 "decided": [{"effect_id": "…", "run_id": "…", "task_id": "T1", "tool": "mail.send", "server": "mail",
              "outcome": "applied", "decided_by": "hermes", "note": "go ahead", "decided_at": "…",
              "receipts": [{"rung": "delivered", "passed": true, "output": "250 OK"}]}]}
```

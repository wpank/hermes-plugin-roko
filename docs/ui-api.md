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

0.7.0 starts roko by itself, one `roko serve` per project: the plugin starts a project's serve when the app opens
(`POST /serve {"action": "ensure"}`), when an overview finds it stopped, or when a chat first uses roko, and the
page and chats pick the project per run. See [Projects and roko serve (0.7.0)](#projects-and-roko-serve-070).

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
  cost_usd: number | null       // read from the run's events; null until known (render —). 0.8.0: while it runs,
                                // with its running tries' spend so far (`call_cost`), the figure the run's card says;
                                // and its side calls (roko de778b612), as roko's summary counts them. Once the run
                                // ended: roko's summary's `cost_usd` (the ledger's total), when roko gives one.
                                // A plan generation, which has no events, once ended: what writing it cost, its
                                // ledger's figure (P-47); before 0.8.0 its row read null once it ended
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
  rungs: RungCount[] | null     // 0.6.0: the run's tasks on its ladder, for the mini ladder; null when the card has
                                // no `ladder`. Set like `progress`, whenever a refresh reads the run
  resumes: string | null        // 0.6.0: the run this one resumed (a plan run Hermes started with resume on): the
                                // newest earlier run of the same plan in the run log; null otherwise (dogfood U10)
  chain: Chain | null           // 0.6.0, a run that resumed another: the plan's runs so far and their total
  project: {path: string, name: string} | null  // 0.7.0: the project it ran in (runs from before 0.7.0: the
                                // default project); show it once more than one project is known
}

type Chain = {                  // 0.6.0: a plan's runs, joined by resumes (dogfood U10: the total appeared nowhere)
  run_ids: string[]             // oldest first, this run last: the run they continue and every run that continued
                                // it up to this one (0.9: each resume of a run names that run, so a second resume
                                // is the first's sibling, not its child)
  cost_usd: number | null       // what they spent together; null while any of them has no figure yet
  progress: Progress | null     // where the plan's tasks are now: this run's (a resume counts the tasks that
                                // passed before it)
}

type RungCount = {              // 0.6.0: one ladder rung in a run, cheapest first, every rung listed
  rung: string
  passed: number                // tasks that passed on this rung (their last try ran here)
  running: number               // tasks whose running try is on this rung
  failed: number                // tries that failed here (the ✕ ghosts): a task that climbed counts here, and
                                // as running or passed on the rung above. 0.7.0: the agent's failures only
                                // (`Try.blame` agent, or none named), the ones that count toward a climb
  refused?: number              // 0.7.0: tries a provider or roko itself failed here (`Try.blame` infra or harness,
                                // such as a 429): not the agent's, so never a ✕ and never toward a climb (∿)
  waiting: number               // tasks not started yet, on the rung their tier starts on (`Rung.starts`)
}

type Progress = {               // every task counted once, by where it is now
  total: number, passed: number, failed: number, running: number, pending: number,
  blocked: number, stopped: number, unverified: number,
  skipped: number               // 0.5.0: roko skipped it by design (no route of its plan chose it): not failed,
                                // not stopped
}

type PendingItem = {
  project?: {path: string, name: string} | null  // 0.7.0: the project whose roko serve holds it
  code: string                  // 6-char code, stable across chats and restarts; `/roko approve CODE`
  decision_id: string           // the full id roko_decide and POST /decide take
  kind: 'confirm' | 'effect'
  title: string                 // one line: "the result of task T1 (Report) in run e13f6327" /
                                //           "the held action mail.send on mail (run e13f6327)"
  words?: string                // 0.9.0: the title as the pages say it, without the run's id:
                                //        "the result of Task 1 (Report) in “Ledger report”"
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
  | 'essential' | 'controller' | 'playbook'                          // L3, 0.6.0: an essential variable of M1's
                                    // homeostat moved (roko's ev.update), its controller acted (m1.episode), a
                                    // playbook was written or credited (playbook_written)
  | 'loop_health' | 'guarded_commit'                                 // L4

type LiveItem = {               // what an agent is doing now; not stored anywhere
  kind: 'tool' | 'text' | 'reasoning' | 'result' | 'beat'
      | 'check'                 // 0.6.0: a line a task's check printed, as roko streams it (gate_output_line)
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
  gate?: string | null          // check: the check printing ("verify[0:test]"); `attempt` is the try it checks:
                                // roko's, else the latest try the relay saw the task start (null when neither says)
  line?: string                 // check: the newest line, ≤300 chars (untrusted)
  stream?: 'stdout' | 'stderr' | 'roko' | null  // check: where the line came from; 'roko' is roko's own note
                                // that it skipped lines of a chatty check ("… 120 more line(s) of this check
                                // were not streamed; its result keeps the end of its output"): show it as a note
  tail?: string[]               // check: that check's last lines so far on this try, newest last (≤12, `line`
                                // included); show `tail`: a check item that waited for the rate carries the lines
                                // before it. A new try, another check or the check's result ends it, so a try's
                                // tail never holds an earlier try's lines
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
    project?: string | null     // 0.7.0: the project the fix is for (actions start-serve, restart-serve,
                                // setup-project, workspace-chat-ready): pass it back as `project` to /setup/fix
  }
}

type Setup = {
  ok: boolean                   // no problem blocks new runs
  problems: Problem[]           // the install's own first (restart-hermes), then roko's; blocking ones first
  checked_at: string            // when roko was last asked (at most 30 s ago; a refused start or a fix asks again)
}

type Connection = {
  url: string | null            // roko serve, without credentials; 0.7.0: null while no serve runs for the
                                // project (its URL comes from the serve.json the serve writes)
  reachable: boolean            // 0.6.0: one failed look between good ones does not make it false; a second, a
                                // second or more later (or one while the live stream to roko broke), does
  version: string | null
  status: string | null         // "ok" | "degraded" | …; 0.6.0: "slow" while roko answers the look late or turns
                                // it away for its rate limit (429): roko is up and busy, so show busy, not offline.
                                // After a minute of that it reads unreachable
  credential: string            // "env:ROKO_API_KEY" | "launch-token:…" | "none" (never the key)
  workdir: string | null        // 0.5.0: the plugin's `workdir` setting (roko's workspace), when set; 0.7.0: the
                                // project this answer is about
  error: { code: string; message: string; hint?: string } | null  // an unreachable roko's hint names
                                // the real workdir (`roko serve --workdir <path>`), not a placeholder
  serve: ServeState | null      // 0.7.0: the project's roko serve (null with no project and no remote url)
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
  delivered: boolean            // true: on the run's batch, roko/work/<slug> (roko/batch/<run> for older runs; Merge
                                //   takes it); false: kept on roko/plan/<plan>
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
                                // "raise the cap and run it again", "resume the plan" (0.6.0), …
  why: string | null
  max_usd?: number | null       // 0.5.0, `rerun` after a stop at the run's cap: the cap to fill the composer with
                                // (the same one would stop it again); nothing starts until the person presses Run
  over_limit?: true             // that cap is the plugin's max_run_usd, though the run needs more (`why` says so)
  resume?: true                 // 0.6.0, `rerun` of a plan run whose tasks did not all pass ("resume the plan"): run
                                // it as a resume (POST /plans/{id}/run with "resume": true), which keeps what
                                // passed and runs the rest (dogfood U2); `why` names the tasks that did not pass
}

type PlanValidation = {         // 0.5.0: why roko will not run a plan (its validator, POST /api/plans/{id}/validate)
  valid: false
  errors: {rule: string | null, task_id: string | null, message: string}[]  // roko's own words, first line each
  open_questions: {task_id: string | null, question: string, assumption: string | null}[]
                                // PLAN_045: what a task still asks; `assumption` is what the planner suggested
  summary: string               // "PLAN_045: task 'T2' has open questions, so its plan cannot run; …"
}

type Rung = {                   // 0.6.0: one rung of the workspace's model ladder (roko.toml [routing.ladder])
  rung: string                  // its name in roko.toml: "cheap", "mid", "strong", "top"
  model: string                 // the model the rung names, as roko.toml names it (a [models.*] key, or a slug)
  slug: string | null           // what the provider calls it ("glm-4.7"), from roko's GET /api/models, else the
                                // workspace roko.toml's [models.*] entry; null when neither names the model
  provider: string | null       // its provider ("cerebras", "claude_cli"), from the same
  price_in: number | null       // USD per million input tokens, from the model's [models.*] entry (roko's
                                // /api/models, else roko.toml); null when it names none: roko may still price
                                // the model from its own price table, which it does not serve
  price_out: number | null      // USD per million output tokens
  price_cache_read: number | null  // USD per million cache-read tokens: roko's /api/models rate (roko 7a5dd6046),
                                // else roko.toml's cost_cache_read_per_m; null when neither names one (roko then
                                // prices a cache read at a tenth of the input price)
  priced_by: 'snapshot' | 'profile' | 'builtin' | 'roko.toml' | null
                                // where the prices come from: roko's word since its /api/models serves the rates it
                                // prices calls at (7a5dd6046: its dated price snapshot, the model's [models.*] entry,
                                // or its built-in table, in that order); 'roko.toml' for a model's [models.*] prices
                                // from an older roko or with roko serve down; null when nothing prices the model
  price_snapshot: string | null // the price snapshot's id ("prices-2026-09-28") when the snapshot priced it
  chat_ok: boolean              // false for a model whose agent runs its own tools (a CLI agent such as
                                // claude_cli): a run started from Hermes never uses that rung
  why_not: string | null        // why a run from Hermes cannot use it, in the pages' words: "not for chat runs:
                                // its agent runs its own tools", "its provider is not set up in this workspace"
  starts: string[]              // the task tiers that start on this rung: roko.toml's [routing.ladder.start], else
                                // roko's defaults (mechanical and focused on cheap, integrative on mid,
                                // architectural on top); a tier whose rung the ladder lacks starts on the first
}

type Try = {                    // 0.6.0: one try at a task (roko's attempt), placed on the model ladder
  attempt: number               // roko's attempt number, from 1
  rung: string | null           // the ladder rung it ran on: the one roko names (attempt_settled), else the one
                                // rung of the card's `ladder` whose model (or slug) it ran; null when it ran on no
                                // rung's model, or there is no ladder
  model: string | null          // the model it ran on, as roko's attempt_settled names it, else its route_decided,
                                // else its agent's row (P-2; never the hub's run-level agent name, which roko gives
                                // as "claude" for a run serve starts, bug-c7de28); after a failover, the one that
                                // ran in place of the pick
  provider: string | null
  reason: 'start' | 'retry' | 'climb' | 'failover' | 'pinned'
                                // start: the task's first try; retry: a later try on the same rung (or, off the
                                // ladder, any later try); climb: a higher rung than the try before (roko climbs
                                // one rung after 2 failed tries on a rung, at most 2 rungs); failover: the picked
                                // model's provider refused it, so roko ran it elsewhere (another provider, or a
                                // rung above): never a climb; pinned: the task or --model names the model, which
                                // the ladder never moves. roko names it since 37088dc12 (route_decided's
                                // `ladder_reason`, attempt_settled's `reason`); from an older roko the plugin
                                // works it out from the rungs
  outcome: 'running' | 'passed' | 'failed' | 'stopped' | 'unverified'
                                // running: the task's latest try, still going; passed: its checks passed and the
                                // task ended on it; failed: a check did not pass, roko tried again after it, or
                                // the task failed on it; stopped: roko stopped it at the run's cap, or the run
                                // ended under it; unverified: the task ended on it and no check ran
  failed_check: string | null   // the first check that did not pass on this try ("verify[0:test]"): from its
                                // gate_result, else from roko's attempt_settled (`custom:test`, named as the run
                                // names that check)
  key_line: string | null       // the line of that check's output most likely to say why (≤200 chars, untrusted)
  cost_usd: number | null       // what roko counted for the try (its efficiency events; roko's own figure once
                                // it sends attempt_settled); while it runs, what its model calls cost so far
                                // (0.8.0: roko f2ee9a0d3's `call_cost`, `attempt_cost_usd`); null until then.
                                // 0.8.0 (roko bug-8bcd98): with its calls a provider refused before failover,
                                // as attempt_settled counts them; from a verdict record, the call that ran
                                // (`vendor_usd`, else `billed_usd`, else `api_equiv_usd`) plus `refused_usd`
  tool_steps: number | null     // the tool calls the try made, as roko streamed them (live, or in its transcript);
                                // null when roko streamed none. roko publishes no turn count while a try runs
  tokens: {input: number, output: number, cache_read: number | null} | null
                                // the try's tokens as roko counted them (attempt_settled `usage`, or its verdict
                                // record); null when roko does not say. The Receipt prices a passing try's tokens
                                // at the top rung (`top_rung_usd`)
  duration_ms: number | null    // from its agent's start to the try's last event; null while it runs
  timing: TryTiming | null      // 0.8.0: where its time went; null while it runs and without a duration
  started_at: string | null     // ISO; when its agent started (a running try's clock)
  lesson_ids: string[] | null   // the lessons (knowledge entries) roko put in the try's prompt, as its
                                // prompt_assembled says (their text: GET /api/knowledge/entries); a task's
                                // `lessons[].entry_id` that shows up here later is a lesson kept, then used.
                                // null when roko does not say (before roko 8357603f0, "prompt_events")
  failover: {                   // failover only, else null: the model roko passed over, and why
    model: string | null, provider: string | null,
    class: string | null,       // roko's word: provider_exhausted, billing, circuit_open, disabled,
                                // no_credentials, not_configured, not_dispatchable, contract_unsupported, …
    why: string | null          // the same for people: "out of usage", "failing, so roko paused it", …
  } | null
  blame: 'agent' | 'infra' | 'harness' | 'none' | null
                                // who the try's outcome is charged to, as roko's verdict says: only the agent's
                                // failures move a task up the ladder; 'none' for a pass. Null without roko's verdict
  source: 'roko' | 'events'     // roko: roko's verdict on the attempt gave its rung, reason, outcome, blame, cost
                                // and time; events: the plugin worked them out from the route, agent and check
                                // events (a try still running, or no verdict the plugin can read; see below)
  why: string | null            // what ended it, in words, for a try that did not pass: "its check verify[0:test]
                                // failed", "it hit its turn cap (12 turns)", "roko stopped the model's stream: it
                                // ran past roko's limit", "the model hit its output limit", "roko stopped it at the
                                // run's cap", "the provider failed", "it spent its allowance on cheap ($0.0150 of
                                // $0.0150)"; null while it runs and when it passed. Since 37088dc12 roko bounds a
                                // try on a rung it can still climb from (`[routing.ladder]` max_turns, max_usd): a
                                // try that spends its rung's allowance fails there (verdict turn_cap, the agent's
                                // blame) and counts toward a climb; it is not a stop at the run's cap
  verdict: string | null        // roko's own word for how it ended (passed, gate_failed, turn_cap, provider_error,
                                // budget_exhausted, timeout, …), from its verdict; null without one
  prompt: TryPrompt | null      // what roko put in its prompt (roko's prompt_assembled); null when roko does not say
  feedback: TryFeedback | null  // what the check of the try before told it (roko's retry_feedback); null on a first
                                // try, after a try that left none, and when roko does not say
}

type TryTiming = {              // 0.8.0 (#4): where a try's time went
  basis: 'roko' | 'events'      // roko: roko's own split (roko 22de26a8c: attempt_settled's `phases`, the verdict
                                // record's `timing.phases`); events: only its checks' times (roko's verdict
                                // steps), the rest as the agent's
  split: boolean                // false when model and tools are one span: `basis` events, or a roko before
                                // f407b62e9 that counted a tool's time as model time (bug-15ba19: tool calls with
                                // no tool time). Never draw such a run as "the model took 13 s"
  // basis roko: each in ms, null when roko does not know it (never 0 for unknown). prompt + model + tools + checks
  // + other make the try's duration; queue and workspace come before it
  queue_ms?, workspace_ms?, prompt_ms?, ttft_ms?, model_ms?, tools_ms?, checks_ms?, other_ms?: number | null
  model_calls?, tool_calls?: number | null
  tools?: {tool: string, calls: number | null, ms: number | null}[]
                                // ≤8, each summed per call (parallel calls can add up past tools_ms)
  checks?: {name: string, ms: number | null, passed: boolean}[]  // ≤8, by the gate's own name
  // basis events
  agent_ms?: number             // the duration less its checks'
}

type TryPrompt = {              // 0.6.0 (P5): what roko put in a try's prompt, as its prompt_assembled says
  lessons: TryLesson[]          // the stored lessons it carried, in roko's order (their ids are `Try.lesson_ids`)
  playbook_ids: string[]        // the playbooks it carried
  episodes: number              // the past attempts it quoted
  left_out: {kind: 'knowledge' | 'playbook' | 'episode' | 'section', id: string, reason: string}[]
                                // what roko found for it and left out, and why: withheld_arm (the audit's control
                                // arm), bandit_excluded, token_budget, role_filter, screened
  sections: string[]            // its sections, in order ("role_identity", "task_context", "anti_patterns", …)
  dropped_sections: string[]    // the sections that did not make it, whatever the reason
  estimated_tokens: number | null
}

type TryLesson = {              // 0.6.0 (P5): one stored lesson in a try's prompt
  id: string
  text: string | null           // the lesson: as the task of this run that kept it wrote it (≤160 chars), else
                                // roko's label for it (GET /api/knowledge/entries, ≤80 chars); null when neither
                                // says (untrusted)
  confidence: number | null     // roko's, 0–1
  citations: number | null      // the episodes and confirmations behind it
  kept_by: string | null        // the task of this run that kept it; null when an earlier run kept it
}

type TryFeedback = {            // 0.6.0 (P5): what a failed try's check left the next try (roko's retry_feedback)
  from_attempt: number          // the try it came from
  check: string                 // what failed: verify (the task's checks), pre_verify:<check> (the screen before
                                // them, e.g. pre_verify:no_changes), plan-branch, scratch-copy-back, review
  failing_steps: string[]       // one line each: "verify[0:test] (`python3 -m unittest …`): exit code: 1"
  diagnosis: string | null      // what the next prompt leads with: a reading of the failure (untrusted)
  errors: string[]              // ≤5 key lines the next prompt lists: compile errors, failed tests, warnings
}

type Lives = {                  // 0.6.0: a task's tries on the rung it stands on
  rung: string                  // the rung of its latest try
  used: number                  // its tries on that rung since it got there, the running one included; a failover
                                // try, and (once roko says) a failure not charged to the agent, does not count. It
                                // passes `of` when the task cannot climb: its top rung, or no runnable rung above
  of: number                    // 2: the tries a rung gives a task before it climbs (roko's FAILURES_PER_RUNG)
}

type Receipt = {                // 0.6.0: an ended run in one strip: where its work passed and what it cost
  cost_usd: number | null       // what the run cost (the card's cost_usd)
  tasks: Progress               // its tasks, as the card's `progress`
  checks: {passed: number, failed: number, total: number, retried: number}  // as the card's `gates`
  by_rung: {[rung: string]: {passed: number, tries: number, cost_usd: number | null}} | null
                                // per ladder rung, cheapest first: the tasks that passed there, the tries that ran
                                // there and what those cost; null when no try is on a rung
  climbs: number                // tries that ran a rung higher than the try before (`reason: "climb"`)
  first_try_passes: number      // tasks that passed on their first try
  top_rung: {rung: string, model: string, slug: string | null} | null  // the ladder's top rung, priced below
  top_rung_usd: number | null   // ≈ the conservative counterfactual (spec §4.6): each passed task's *passing* try's
                                // tokens (attempt_settled `usage`: input, output, cache read) at the top rung's list
                                // prices, plus the run's helper calls at their real cost (the run's cost less its
                                // tries' cost, never below 0). It never credits roko with the failed tries of
                                // cheaper rungs; tasks that never passed add nothing. From an older roko with no
                                // per-try usage: the run's own tokens, failed tries included. null when the ladder
                                // or the top rung's price is unknown, or there are no tokens to price
  top_rung_by: 'passing_tries' | 'run_totals' | null  // which of the two worked it out
  not_compared: number          // the tasks with no passing try, which the line leaves out ("1 task did not pass:
                                // not compared")
  ratio: number | null          // top_rung_usd / cost_usd, one decimal ("this cost 8× less"); null without both
  basis: string | null          // how top_rung_usd was worked out, printed in full as its own line: "≈ the 5
                                // passing tries' tokens at claude-sonnet-4-6's list prices, plus $0.01 helper
                                // calls", or "≈ from run totals, failed tries included"; or, when it is null, why
                                // ("no list price for claude-sonnet-4-6")
  basis_detail: string | null   // the same with the counts: "3,600 input, 240 output and 0 cache-read tokens of the
                                // passing try at fake-strong's list prices ($0.75 in, $4.50 out per million), plus
                                // $0.0014 of helper calls at their cost"
  lessons_kept: number          // lessons roko's knowledge store admitted from the run (`tasks[].lessons`)
  lessons_confirmed: number     // lessons it already had, which the run confirmed (admission `duplicate`)
  lessons_used: number | null   // the different lessons roko put in the run's prompts (`Try.lesson_ids`); null
                                // when roko does not say (prompt_assembled, roko 8357603f0)
  changes: {kind: Work['kind'], files: number, additions: number, deletions: number,
            branch: string | null, merged: boolean} | null  // from the card's `work`: every part's counts
                                // added up, the first part's branch (delivered work first); null without `work`
}
```

`LoopEvent`, 0.6.0: a `route` that climbs says so ("T3 attempt 3 climbed cheap → mid on glm-4.7", dogfood U3) and
its `data.climbed_from` names the rung it left (absent when the relay did not see the route before). roko names each
route's `rung`, its step on the ladder and why it runs there since 37088dc12: `data.ladder_reason` (`start`, `retry`,
`climb`, `failover`, `pinned`, or null from an older roko, whose route is a climb when its rung differs from the
task's route before), `data.ladder_step` (rungs climbed above the start rung) and `data.forecast`, the self-model's
forecast when it made one: `{mode: 'shadow' | 'active', action, would_choose, candidates: [{model, provider, p_vs,
cost_q50}]}` (at most 5, likeliest first; `p_vs` is its chance that every check passes for real, `cost_q50` its
median cost of a try in USD). In shadow mode the forecast never changes the route.

## Projects and roko serve (0.7.0)

Each project (a git checkout roko works in) gets its own `roko serve`, on its own port. The plugin starts it with
`roko serve --detach` (it keeps running after Hermes quits, so runs in flight finish, and stops itself after
`idle_exit_minutes` without work), never kills one, and stops or restarts one only through `roko serve stop|restart`.
A project's URL always comes from the `.roko/runtime/serve.json` its serve writes; the pages never need it.

```ts
type ServeState = {
  project: string | null        // absolute path of the project; null only for `remote` without a `workdir` setting
  name: string                  // display name: the folder's name ("parent/name" when two projects share one); the
                                // URL's host for `remote` without a project
  state: 'running'              // it answers, and it is this project's serve (roko's identity: instance_id, workdir)
       | 'starting'             // a start by this plugin is in flight (any Hermes process: the desktop, a chat, the CLI)
       | 'stopped'              // no serve runs for the project
       | 'failed'               // the last start failed: `error` and `log_tail` say why. An automatic start waits 60 s
                                // after that; Start (`POST /serve {"action": "start"}`) does not
       | 'outdated'             // the roko there cannot serve Hermes: the running serve lacks /mcp, or the roko binary
                                // cannot start a serve in the background (no `serve --detach`): `error` says which
       | 'not_found'            // no roko binary on this machine
       | 'remote'               // the plugin's `url` (or ROKO_URL) names a roko serve elsewhere: the plugin starts and
                                // stops nothing
  url: string | null            // running: its URL (loopback); remote: the configured URL; else null
  pid: number | null            // running: its process id
  version: string | null        // running: the serve's roko version; otherwise the roko binary's, when known
  git_sha: string | null        // likewise: the commit roko was built from
  started_by: 'hermes' | 'other' | null  // running: 'hermes' when this plugin started it; null when not running
  since: string | null          // when the current state began: running: its started_at; starting: when the start
                                // began; failed: when it failed; null when unknown
  idle_exit_minutes: number | null  // running: the serve's own idle exit (null: never, or a roko that does not say);
                                // otherwise what a serve the plugin starts gets (the setting; null when 0: never)
  error: {code: string, message: string, hint: string} | null  // failed | outdated | not_found (below)
  log_tail: string[] | null     // failed: the last lines of <project>/.roko/logs/serve.log (untrusted text: show it
                                // in a monospace well, as text nodes)
  actions: ('start' | 'restart' | 'stop')[]  // the buttons the page may offer now (empty when none applies, and for
                                // `remote`, `starting` and `not_found`)
  busy: {active_runs: number} | null  // running: the runs and plans roko serve has going, when it has any; restart or
                                // stop would interrupt them. null when none, or unknown
}

type Project = {
  path: string                  // absolute path
  name: string                  // as ServeState.name
  default: boolean              // the project Hermes uses when nothing names one
  last_used: string | null      // when a run or a page last used it (ISO)
  ready: boolean                // roko.toml is there and roko accepts runs started from Hermes (as last seen)
  needs_setup: boolean          // a git checkout roko is not set up in yet (no roko.toml), or whose roko refuses runs
                                // started from Hermes: offer "Set up roko here" (`setup-project`, below)
  serve: ServeState             // from the plugin's last look; reading it never waits on the network
}
```

`ServeState.error.code` is one of:
- `failed`: roko's own code for the failed start: `start_failed`, `timeout`, `locked` (another roko process, a plan
  run say, holds the workspace), `not_initialized` (roko found no LLM provider: no roko.toml that names one and no
  key in ~/.roko/.env; the fix is a model key), `not_a_workspace`,
  or `spawn_failed` (the plugin could not run roko at all); after a restart that did not go through, also `busy`
  (runs started meanwhile) or `unresponsive` (the old serve did not answer, so roko left it alone);
- `outdated`: `no_mcp` (the running serve lacks the `/mcp` endpoint: restart it from a newer roko) or `too_old` (the
  roko binary has no `serve --detach`: update roko);
- `not_found`: `not_found`.

`hint` is the person's next step, in their words (for `too_old` and `not_found`, the command or page that installs
roko).

**Which project.** The default project is the plugin's `workdir` setting until the person picks another
(`POST /projects {"action": "set_default"}`; changing the setting makes it the default again). Every route that is
about one project takes `project` (a query parameter for GETs, a body field for POSTs), an absolute path, and answers
about the default project without it:

- `GET /overview`, `/plans`, `/plans/{plan_id}`, `/learning`, `/insights`, `/loops`, `/knowledge`, `/estimate`,
  `/pending`, `/effects`, `/health`, `/setup/fix`, and `WS /live` take `?project=`;
- `POST /runs`, `POST /plans/{plan_id}/run`, `POST /setup/fix` and `POST /serve` take `"project"` in the body;
- single-run routes (`/runs/{run_id}`, its `events`, `diff`, `merge`, `cancel`, and `POST /decide`) find the run's
  project themselves.

A `project` that is not a known project is refused with `invalid`. A project is known once it was added
(`POST /projects`, `hermes roko projects add`, a chat that named it) or is the `workdir` setting. Work that needs the
project's roko serve (`POST /runs`, `POST /plans/{id}/run`) starts it first when it is stopped, as `ensure` does, and
waits for it; when it cannot run there the answer is `{ok: false, error, problem, serve}` with the setup problem that
says why (`roko-not-found`, `roko-too-old`, `no-model-provider`, `project-needs-setup`, `roko-unreachable`) and the
project's `ServeState`. A project with no roko.toml can still have a roko serve (roko runs on its defaults when it has a
model provider), but roko refuses runs started from Hermes there until it is set up (`project-needs-setup`).

A `RunRow` and a card gain `project: {path: string, name: string} | null`: the project the run ran in (runs from
before 0.7.0 belong to the default project; null when there is none). Show it once more than one project is known.

With no project at all (no `workdir` setting, nothing added, no remote `url`), `GET /overview` answers `project: null`,
`projects: []` and `connection.serve: null`, and its setup card says to pick a folder.

### `GET /projects`
```json
{"ok": true, "default": "/Users/x/src/pocket-synth",
 "projects": [{"path": "/Users/x/src/pocket-synth", "name": "pocket-synth", "default": true,
               "last_used": "2026-10-19T10:02:11Z", "ready": true, "needs_setup": false, "serve": ServeState}, …]}
```
The default project first, then the most recently used. Fast: it reads files only.

### `POST /projects`  body `{"action": "add" | "remove" | "set_default", "path": "/abs/folder"}`
Answers `{ok, default, projects}` as `GET /projects`, and `add` also `project: Project` (the one it added).
- `add` takes an existing folder in a git checkout (the checkout's top folder becomes the project, unless the folder
  itself holds a roko.toml); a folder inside Hermes' home is refused. Not a git checkout: `{ok: false, error: {code:
  "invalid", message, hint}}`. A checkout roko is not set up in is added with `needs_setup: true`. Adding a known
  project changes nothing.
- `remove` forgets it (its runs keep their project; its roko serve keeps running until its idle exit). Removing the
  default makes the most recently used project the default, or none.
- `set_default` adds the folder when it is not known yet, then makes it the default.
- `invalid` for an unknown action or a missing path; `forbidden` when `permissions.write` is false.

### `POST /serve`  body `{"action": "ensure" | "start" | "restart" | "stop", "project"?: "/abs", "force"?: false}`
Answers `{"ok": true, "serve": ServeState}` (the project's state after the action began).
- `ensure` (the app opening, a page loading) starts the project's serve when it is stopped and `auto_start` is on,
  and never one that `failed` less than 60 s ago, is `outdated` or `remote`. It returns at once: `starting` while a
  start runs. Always allowed, also with `permissions.write` false.
- `start` starts it whatever `auto_start` says and however recently a start failed, and returns at once with
  `starting`. A start that cannot happen (`not_found`, a binary without `--detach`) answers `ok: true` with that
  state; its `error` says why.
- `restart` (a newer roko binary, roko.toml keys roko reads only at start) returns at once with `starting`; `stop`
  waits for roko serve to stop (at most about 25 s) and answers its new state.
- While a start runs, poll `GET /overview?project=` every 2 s (at most 90 s), or take the live channel's `serve`
  frames.
- A `restart` or `stop` of a busy serve without `force: true` is refused, nothing done:
  `{ok: false, error: {code: "conflict", message: "2 runs are going in pocket-synth; restarting roko serve stops
  them.", hint: "…"}, serve: ServeState}`. Ask the person, listing what it interrupts, then send `force: true`.
- `forbidden` for `remote` (the plugin starts and stops nothing there), and for `start`, `restart` and `stop` when
  `permissions.write` is false; `invalid` for an unknown action or project.

### App open
The desktop `register(ctx)` calls `POST /serve {"action": "ensure"}` once and ignores failures; a 404 means an older
backend (the existing "restart Hermes" path). The dashboard makes the same call on page load. Neither waits for the
answer before drawing the page.

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
  "spend": {"today_usd": 0.42, "committed_usd": 1.0, "max_day_usd": 10.0, "left_usd": 8.58, "runs_today": 3,
            "from": "hermes", "roko_today_usd": 0.98},
  "limits": {"max_run_usd": 5.0, "max_day_usd": 10.0},   // max_day_usd null: no daily limit
  "permissions": {"write": true},   // false: hide Run / Approve / Reject / Cancel (ui_actions: false)
  "setup": Setup,               // what stands between the person and a run that works; see Setup problems
  "runs": [RunRow, …],          // newest first, at most 20; states refreshed for active ones
  "pending": [PendingItem, …],
  "ladder": [Rung, …] | null,   // 0.6.0: the workspace's model ladder, cheapest first (below)
  "checked_at": "2026-10-11T12:00:00.000+00:00"
}
```
0.6.0: `ladder` is the workspace's model ladder, cheapest first as roko.toml lists its `[[routing.ladder.rungs]]`:
each rung's model, with its slug, provider and prices from roko's `/api/models`, and whether a run from Hermes can
use it. It is null when roko.toml names no rungs (roko then uses its built-in ladder, which the plugin does not
guess) or turns the ladder off (`[routing.ladder] enabled = false`), and when the plugin has no `workdir`. With
roko serve down, all of it comes from roko.toml: its `[models.*]` entries give each rung's slug, provider and prices
(null for a model it does not define), and `why_not` cannot say that a provider is not set up.
0.6.0: overviews asked at once (the relay's push, the pages' polls, the health route) share one build, unless a run
joined the run log since that build began, so a run just started is always in the answer.
`connection` also carries `active_runs` and `active_plans` (workspace-wide, from roko's `/api/health`). A
refused key is `reachable: true` with `error.code: "unauthorized"`. `spend` counts runs started from this
Hermes: `today_usd` is what they spent today (local day), `committed_usd` what running ones may still spend
(cap minus spent), `left_usd` what a new run may still cap itself at.
0.6.0 (P-3): `spend.from` is `"hermes"`: its counters count the runs started from this Hermes, so label them "from
Hermes". `spend.roko_today_usd` is everything roko recorded today (the UTC day) across its workspace: runs started
from a terminal, other hosts' runs and helper calls included. It comes from roko's own daily ledger
(`.roko/learn/costs.jsonl`, which `budget.max_daily_usd` reads too) and is null when the plugin does not share roko's
workdir. Runs started from a terminal are not listed in `runs`: roko serve lists them only by an event id that
differs from their record id (roko bug-c872f6), with no start time or cost.
If roko serve is unreachable: `ok: true`, `connection.reachable: false` with `connection.error`, the cached
`runs` (last known states), `pending: []`, and `counts` from the cached states.

0.7.0: `GET /overview?project=/abs/path` answers about that project (without `project`, the default one). It adds:
```json
{"project": Project, "projects": [Project, …],
 "connection": {…, "serve": ServeState}}
```
- `project` is the project this answer is about and `projects` every known one, the default first, then the most
  recently used; with no project at all both are empty (`null`, `[]`) and `connection.serve` is null.
- `runs`, `counts` and `spend` cover every project Hermes started runs in: `runs` are every run Hermes started, each
  with its `project`; `counts` count them; `spend.roko_today_usd` adds up roko's daily ledgers of those projects and
  the one shown.
- `pending` covers every project whose roko serve runs, each item with its `project` (a sign-off waiting in another
  project needs the person whichever project the page shows). A serve that is down is skipped, and never started to
  read what waits in it. `counts.waiting` counts these.
- `connection`, `setup` and `ladder` stay the chosen project's.
- When the project's serve is `stopped` and `auto_start` is on, the overview starts it in the background and says
  `starting` (it never starts one that `failed` less than 60 s ago, is `outdated` or `remote`). While it starts, poll
  every 2 s (at most 90 s) or take the live `serve` frames.

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
    "active_ms": null,           // P-58: a run roko resumed under its own id: its invocations' spans together
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
- `eta_minutes`: roko's estimate of the minutes left on the critical path, while running; else null. 0.8.0 (P-38):
  `eta_at`, when roko made it (its `critical_path_eta_updated` time). roko sends one only when a task completes, so
  the pages count the estimate down from `eta_at` and say from when ("~7 min left · est. 21:15"); past it, "past
  roko's estimate from 21:15", never a stale number. 0.8.0, from roko bcce6c05c (gap-c1045f), which sends the
  estimate at each task's start and end and every 60 s while tasks run: `eta_minutes` is a median,
  `eta_p90_minutes` its 90th percentile (null from an older roko), `eta_basis` what it rests on (`{source: history |
  scaled | guess, tasks, runs}`, or null), and `eta_at` roko's `computed_at_ms`. The pages say "~28 min left, up to
  75 · est. 21:15 · from 12 runs" ("· a guess" for a guess), and once the median passes, "past roko's likely time ·
  up to 47 min left".
- `side_call_usd`: the run's side calls by role, in `cost_usd` (roko de778b612, bug-11e54b): calls a provider
  refused before a failover (`failover_refused`), helper calls, audit checks; `{}` from an older roko. A refused
  call counts once: inside its try's live figure while the try runs, then as a side call once roko states the try.
  It needs the try's number on the event (roko 9334ba4a9); one without it is left out of the events' sum. Once
  the run ended, `side_call_usd` is roko's summary's own, and `cost_usd` is roko's summary's `cost_usd`.
- `cost_check`: `{events_usd, roko_usd}` when an ended run's events add up to other than roko's figure (beyond a
  cent or 2%: a refused call that named no try, say); null otherwise. A detail: the receipt and every figure use
  roko's.
- `provider_exhausted`: the providers the run went on without because they refused a call for want of usage or
  credit (roko 7f20b9578, bug-390e4b), the latest refusal of each, by provider: `{provider, model, billing,
  reason, until_ms, detail, at}[]`, roko's summary's list once the run ended, else its events'; `[]` when none.
  `billing` says the provider cannot bill the account (z.ai's code 1113, an HTTP 402), not a usage window that
  resets on its own; `until_ms` is when roko calls it again. `detail` is roko's line, shown as it is, as plain
  text (the provider's words are untrusted): "zai: Insufficient balance or no resource package. Please recharge.
  (code 1113): recharge, or the ladder runs without it until 07:12". Each refusal is a timeline line (type
  `provider_exhausted`, group `error`, with `provider` and `model`). `roko_status` gives the model roko's lines
  (`provider_exhausted`) and `provider_note`, and the chat that started the run hears them when it ends. The pages
  show each `detail` under the run's headline, and the Ladder rung of its provider (else of its model) says
  "⊘ no credit · until 07:12" (`billing`) or "⊘ out of usage", with `detail` as its title.
- `reasoning_cuts`: the replies roko stopped because they only reasoned, past 3/8 of the model's output limit,
  before it asked again in the same try (roko e43dfa53e, gap-f3f950), the newest 20 in order: `{task_id, attempt,
  turn, model, reasoning_tokens, limit_tokens, secs, saved_secs, reask, detail, at}[]`, roko's summary's list once
  the run ended, else its events'; `[]` when none. `reask` is what asking again did: `acted` (a tool call),
  `answered` (text), `cut_again` (stopped too, which ends the try) or `ended`; `saved_secs` is roko's estimate of
  the time the stop saved. `detail` is roko's line, to show as it is ("glm-4.7 reasoned 12288 tokens in 330 s
  with no tool call, past its limit of 12288: roko stopped it and asked again, about 550 s sooner; the re-ask made
  a tool call"); roko_status gives the chat the newest five. No timeline line yet: a cut needs a model whose
  reasoning streams (glm-4.7, not OpenAI's).
- `last_event_at`: when roko last wrote an event for the run.
- each task adds `started_at`, `finished_at`, `duration_ms`; `step` (`starting`, `agent`, `agent done`,
  `check`, or null when idle or ended), `step_detail` (the model, or the check's name) and `step_since`;
  `attempt_log` (`[{attempt, model, provider, started_at, gates: [{gate, passed}]}]`, one per agent attempt,
  numbered from 1 as roko numbers them; an older roko numbered every attempt 0, and the plugin counts those); and
  `note`, the last thing the task's agent said (≤1,200 chars, untrusted). 0.6.0: the messages roko ends an
  attempt with in the agent's place ("agent turn cap reached (turns=12, cap=12)", "provider result denied by immune
  boundary (…)", "model hit output token limit", "network error: …", a budget stop) are roko's, not the agent's: they
  go to that try's `why` (`tasks[].climb`), their timeline line says the task stopped, and `note` keeps what the
  agent last said. 0.8.0: a provider that answered with an HTTP 4xx refused the request. roko since 3d3d00d57
  (bug-35b190) says so itself, "provider error: openai refused the request (HTTP 400): <its words> (param …)",
  which reads as it is, from the provider's name on ("openai refused the request (HTTP 400): …"), after a try's
  verdict class ("request_refused: …") too. An older roko filed it as "network error: http 400: <body>": that reads
  "the provider refused the request (HTTP 400): <the provider's own message>", the message taken from the error
  body. One line and bounded either way; a 401 or 403, and roko's "authentication failed", add "(check its API key
  or account)". A transport error (no status) still reads "the network failed: …".
- `why` on a run that ended without success: `{summary, gates_not_passed: [{task_id, title, gate, runs,
  output, key_line}], blocked: [{task_id, blocked_by, reason}], unverified_tasks, errors}`. `summary` is one
  paragraph ("T1's check verify[0:compile] did not pass, all 6 times it ran; the last time: bash: line 1: python:
  command not found. T2, T3, T4 and T5 were blocked because T1 did not pass."); `key_line` is the line of the check's
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
  passed before that; what passed is kept on its branch."). 0.8.0 (P-51, the reboot of 2026-10-26): a task still
  running when its run ended reads `stopped`, with no `step` or `live_text`, so no page draws it live; a plan
  run's `next` is `{action: "rerun", label: "resume the plan", resume: true, why: "<reason>; <note, lower
  case>", note}`, and the pages show `note` and promise nothing of their own. Since roko bug-b7f6a8 (5e9af6682)
  a resume continues the run, or roko refuses it with `cannot_resume` and its reason, never starting over
  unasked: when the plan's row names this run as the one a resume continues (`resumable_run` with `continues`;
  the card's `checkpoint`), `note` is "A resume continues where it stopped: only T2 runs, and the $0.02 it spent
  before it stopped counts against its cap."; from such a roko otherwise (its summary says `carried_usd`), "A
  resume continues where it stopped, or roko refuses it and says why: it never starts over unasked."; from an
  older roko, on which a resume after a crash mid-call could start over, "A resume continues where roko can, but
  if a task was stopped mid-call roko may start the run over and run passed tasks again (a known roko defect,
  being fixed).". roko_status tells the chat the same, and to resume it when the person asks in this turn, at
  the cap they name, else the run's own, saying which and what the run already spent (which roko counts against
  that cap), and otherwise only to tell them. Once a later
  run resumed it (its `resumes` in the run log), the card has `resumed_by: {run_id, state, merged}` (`merged`:
  that run's batch branch, else its plan's, is on the project's trunk), its `next` is `{action: null, label:
  "resumed as 92b8071f · passed · merged", why: "a later run picked up where this one stopped: …"}`, and the
  chat is told to report that run instead (P-51b). Its ladder is its own tries' (roko's `rungs[]` covers the
  plan's attempts, the resume's too), and its spend roko's summary's for it alone. Its `receipt.changes` keeps
  the shared plan branch's counts, which are the later run's work, with `branch` "its work continued in
  92b8071f" and, once that run passed, its `kind` (`verified`) and `merged`: the pages read "+5 −5 in 5 files ·
  its work continued in 92b8071f · merged".
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
- 0.8.0 (hermes-pilot P-49): `why.refused_request` is `{task_id, words}` for the first task whose error is a
  provider refusing its request (an HTTP 4xx other than 429, or roko's "authentication failed"), `words` as the
  why says it ("openai refused the request (HTTP 400): …"); null otherwise. Such a run's `next` is not a resume,
  which would send the same request: `{action: null, label: "the provider refuses its request: a resume would
  fail the same way", why: "T1 failed on a request its provider refuses: openai refused the request (HTTP 400):
  …. A resume would fail the same way until roko or its config changes."}`, and roko_status tells the chat not to
  offer one.
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
0.6.0 adds `source_checks`, what became of the checks the request (its spec) states, as roko's planner reports
them once it wrote the plan (roko 75a1a08bf, gap-dc5d7c), or null from an older roko and when it reports none:
```ts
type SourceChecks = {
  total: number                 // the checks the source states, numbered SC1, SC2, …
  kept: number                  // a verify step checks it (the criterion that keeps it names it: "AC1: SC2: …")
  cannot_run: number            // a step covers it but cannot pass as written ("`pytest` is not installed", a test
                                // id its file does not define): say so, the plan cannot prove it (roko gap-ecafde,
                                // 08d4fe558; 0 from an older roko)
  shallow: number               // only a grep, a file test or a build covers it
  dropped: number               // the plan says why it does not keep it ([meta] dropped_checks)
  missing: number               // neither kept nor dropped: say so, the plan may not prove it
  regenerated: boolean          // the planner was asked once more for the missing ones
  from: string[]                // 0.8.0: the files the checks come from: the spec the plan was written from
                                // (`spec_path`, P-6), else the documents its request names, which roko read
                                // (roko gap-ac6b9b `documents`, at most 5); [] when the request states them itself
  checks: {id: string, check: string, status: 'kept' | 'cannot_run' | 'shallow' | 'dropped' | 'missing',
           task: string | null, criterion: string | null, reason: string | null}[]
                                // each, in source order, at most 40; `check` as the source states it (≤ 300 chars,
                                // untrusted); `reason` why it was dropped, why its step cannot run, or the one command
                                // that covers a shallow one
}
```
0.5.0 adds `writing`, what roko's planner is doing (roko gap-11d870), or null from an older roko and in the
second before its first stage: `{stage, attempt, attempts, calls, cost_usd, model, reason, elapsed_s, text}`.
`stage` is roko's: `planning` (its first planner call), `retrying` (a call failed or ran into roko's 300 s limit
for one call, and runs again), `fixing` (the reply held no valid plan; asked again), `regenerating` (rewriting a
valid plan once), `writing` (its files) or `recording` (the last). `attempt` of `attempts` is this stage's,
`calls` counts the planner calls so far (a running one included), `cost_usd` what the returned ones cost,
`reason` why a `retrying`, `fixing` or `regenerating` stage tries again, and `elapsed_s` how long the writing has
run (while it runs; the card's `elapsed_ms` too). `text` is the line for a ticker: "writing the plan: planning ·
try 1 of 1 · 0:12 · $0.00", or "retrying: the planner call ran into roko's 300 s limit for one call and was
stopped · try 2 of 2 · 0:03 · $0.00". A running plan writing's headline is "running · " and that line. roko
keeps the last stage after the end, so a failed writing still says how far it got and what it spent: its
`cost_usd` falls back to `writing.cost_usd`. roko publishes the stages on no hub event, so the live relay reads a
running plan writing's card every 3 s.

0.8.0 (P-47): once a writing ended, its `cost_usd` is roko's ledger's (`.roko/learn/costs.jsonl`), as the Build tab
counts it, and `side_call_usd` what roko ran after the planner, by role, in `cost_usd`: its episode distiller
(`{"episode-distiller": 0.032}`). roko's own figure is the planner's calls alone. The ledger keeps a plan's writings
under its id, so a writing is the first from its start whose planner calls cost what roko said; a plan written twice
under one id shows each writing's own share. Until the ledger has the distiller's call (it runs as the writing ends),
or without the ledger (a remote roko), it is roko's figure, and the run list reads the ledger again for its row. The
headline says it: "… · $0.20 of $0.50 (incl. $0.03 after the planner)".

#### What 0.6.0 adds to a card (round v6)

Every field below is absent on a card from an older backend, and null when roko gives no data for it.

- `ladder`: the workspace's model ladder (`Rung[]` or null), as `/overview` gives it: the ladder the run's tasks
  climb. Tasks place themselves on it by their tries (`tasks[].climb`, below); a task not started yet, by its tier
  (`tasks[].tier`, 0.8.0 P-36: "integrative") on the rung whose `starts` name it, else the first a chat run can use.
  0.8.0 (P-46): once the run ended, `ladder` is the one it ran on, as roko recorded it (its summary's `rungs[]`):
  each rung with the model that ran there and `spent_usd`, what it spent there, and no list prices; never
  roko.toml as it is now. 0.8.0 (roko bug-8bcd98): a rung's `spent_usd` adds up its rows (another model, another
  role) and the calls a provider refused of them, which roko counts on the refused model's row; `refused_usd` is
  that part (null when none), which the pages show under the spend ("incl. $0.21 refused"). `ladder_from` says
  which: `run`, or `config` (a live run, or an ended one roko recorded no rungs for). The pages label it "as it
  ran" or "roko.toml now". The receipt's top rung is today's list price.
  0.8.0 (P-51): an interrupted run, which roko records no rungs for because it settled no try (its roko died
  mid-try), draws the rungs its own tries' routes name, with the model each ran there and what they spent
  (`ladder_from: run`). 0.8.0 (P-52, roko gap-20301d): a rung roko skips for the run, its probe having failed,
  is one this run cannot use (`chat_ok: false`, `skipped: true`), `why_not` roko's line less the rung and model
  the row names ("skipped until 20:33: its tool-use probe failed: …; a task that would start on it starts on the
  next rung that runs"), and the tiers that start on it start on the next rung that runs, where roko starts them.
  The pages draw it dashed, with those words (in full as its title); the strip says "skipped".
- `rungs_skipped`: the rungs roko skips for the run (roko gap-20301d, P-52): `{rung, model, provider, reason,
  until_ms, billing, detail, at}[]`, roko's summary's `rungs_skipped` when it gives one, else its `rung_skipped`
  events, the latest per rung; `[]` when none. `billing` (roko c8f9bff80, bug-374384) is true for a rung skipped
  for want of billing, which has no `until_ms` because roko probes it again when the next run starts; null from a
  roko that does not say. The reader also takes the draft names `rung_name`, `model_slug`, `message` and `until`.
  When every rung is skipped roko refuses the run before any model call (its try settles `all_rungs_skipped`,
  charged to the harness): its summary's `refused` is `{stage: "ladder", kind: "all_rungs_skipped", reason,
  billing_only}`, `why.all_rungs_skipped` is true (the kind says so, else its words), `why.start_error` holds
  roko's words and `why.billing_only` roko's flag. With `billing_only` true, `next` is `{action: "rerun", label:
  "recharge cerebras and zai, then resume", resume: true, why: "<roko's words>. Every rung was skipped because its
  provider could not bill: once cerebras and zai are recharged, a resume probes the skipped rungs again …"}`;
  with false, `{action: null, label: "every rung is skipped: nothing ran", why: "<roko's words>. A resume now is
  refused again: roko's probe verdict on a rung stands for 24 hours (the first lapses at 21:33), or until its
  model's entry is removed from .roko/learn/rung-probes.json."}`; from a roko that does not say, the 0.8.0 draft's
  words. roko_status tells the chat the same: to have the person recharge and resume only when they ask, or not
  to resume now and that the probe file is the person's to edit, never the chat's.
- `carried_usd` (0.8.0, roko bug-b7f6a8): what earlier processes of the run spent before a restart, which a
  resumed plan's budget counts beside `cost_usd` (roko's summary; 0 for a run that resumed nothing, null from an
  older roko). `cost_usd` stays the run's own spend, so a plan's runs still add up once; the headline counts both
  against the cap ("$0.06 of $1.00 · $0.02 spent before it resumed, $0.94 left": a failed run's resume carries
  its spend too), and the timeline shows roko's
  `budget_carried` line ("Resumed with $0.0221 spent before the restart …; $0.9779 of its $1.0000 budget is
  left").
- `checkout_written` (0.8.0, roko bug-b7d9ad): the run's tries whose checks, run in their own worktree, changed the
  person's own checkout: `{plan_id, task_id, attempt, paths, more}[]`, from roko's summary (at most 20 tries and 20
  paths each, `more` counting the rest); `[]` from an older roko or when none did. roko left those changes in the
  checkout and did not deliver them; its `checkout_written:<plan>/<task>` warning diagnosis, in the run's timeline,
  says how to drop or keep them. roko_status gives the chat each try as a line ("while T2's checks ran (try 1):
  artifacts/ui/editor-idle.png, …") and `checkout_note`: tell the person, naming the paths and the task; keeping or
  dropping them is theirs to decide, and the chat runs no git on their checkout unless they ask in that turn.
- `rungs`: the run's tasks on that ladder (`RungCount[]` or null), as its RunRow carries them: the mini ladder.
- `resumes` and `chain`: the run this one resumed and the plan's runs together, as its RunRow carries them.
- `homeostat`: M1's homeostat as the run last saw it (`Homeostat`, see `GET /learning`), or null when the run saw no
  `ev.update`.
- `roko_cost`: roko's own figures for the run as it ended, `{cost_usd, tasks, verified_tasks, cost_per_verified_usd}`
  (its `efficiency_trend_updated`, roko ee09f6464, model and helper calls together), or null.
- `spec_gate` (0.8.0): roko's spec gate before any agent runs (roko 97d9b1819), `{state: running|done, steps_total,
  steps_done, cached, passed, ms, elapsed_ms, blocked, started_at}`: each red-on-base step as it ends (a cache hit
  too), how many were cached or passed (a step should fail on the unchanged base, so `passed` is the odd one),
  their time, and once it ended its `elapsed_ms` and how many tasks it blocked; null before it starts.
- While the run goes, `cost_usd` adds what its running tries' model calls cost so far (`call_cost`), so the spend
  moves during a try; each try's own figure replaces that once roko states it. Its RunRow says the same figure, so
  the run's header, its row and the status chip agree (phase 2's S2 stills: $0.732 against $0.61).
- each task adds:
  - `climb`: its tries, oldest first (`Try[]`, one per attempt, at most 12; `[]` before its first). roko's
    verdict on each attempt states its try exactly (`source: "roko"`): the plugin reads it from the run's record
    in the workspace (`.roko/runs/<run>/attempts.jsonl`, which roko writes as each attempt settles) when it
    shares roko's `workdir`, and from roko's `attempt_settled` event once roko publishes one (backlog R1).
    Without a verdict (roko serve on another machine, or a try still running) the route, agent and check events
    tell (`source: "events"`): there a model that two rungs name has no rung. The pad's lives row (`✕✕●`) is
    `climb` read left to right: ✕ for a failed try, ● for the running one.
  - `lives`: its tries on the rung it stands on (`Lives`), or null: before its first try, when its latest try is
    pinned or was picked by something other than the ladder (roko's router, a fallback, exploring), and when that
    try is on no rung.
  - `tries_allowed` (0.8.0): roko's budget for the task's tries (its `max_retries` + 1, from the attempt-open lines
    of the run's attempts.jsonl), or null where the plugin cannot read that record: the sheet's "try N of up to M".
  - `exhausted`: `{attempt, rung, model, suggestion}` when the task failed on the top rung it can climb with no
    try left (roko's `ladder_exhausted` since 37088dc12, or `exhausted` in its verdict on the try), else null.
    Nothing retries it: show the `⌈SPLIT OR REPLAN⌋` stamp. `suggestion` is roko's advice (untrusted), null
    when only the verdict says so.
  - Note that a task's `rung` (0.3.0) is still the check it runs now (`verify[0:test]`), not a ladder rung.
  - `check_tail`: what the task's newest check printed, or null before its first check:
    `{attempt, gate, passed, command, exit_code, duration_ms, lines, live}`. `attempt` is the try it checked;
    `passed` is null while the check runs; `command` is the command it ran (roko's `$ …` line; for a streamed
    check, from its result once it ends), or null;
    `exit_code` and `duration_ms` are roko's, from its verdict on the try (a failed check's exit code also from
    the `✗ exit status N` line roko ends its output with), null while it runs and when roko does not say;
    `lines` is the last 40 lines it printed, newest last (each ≤300 chars, untrusted); `live` is true when the
    lines came from roko's `gate_output_line` as the check printed them, false when they are the end of its
    result (`gate_result`'s output). A newer check of the task replaces it when it prints its first line or
    ends, so between tries it still shows the check that failed. roko streams a check's lines since
    gap-f45a6d, bounded (a burst of 80 lines, then 40 a second, at most 1,000 a check): when it skipped some,
    its own last line says how many, and once the check ends its result's output replaces the streamed lines
    (`live` false), since that output keeps the end, where a failure shows. An older roko streams nothing:
    `check_tail` then fills when each check ends, and the socket sends no `check` items.
- `cancelled_by` (P-1): who in Hermes cancelled the run and why, `{by: 'chat' | 'page', reason: string | null,
  at: string}`, else null. `chat` is Hermes' model (roko_cancel, with the person's reason, ≤200 chars, untrusted);
  `page` is the person's Cancel on a page. roko keeps no reason for a cancel, so the plugin records it; show it with
  the cancel ("cancelled from chat: the person asked to stop").
- `summary_behind` (P-1): true when roko's own summary of the run lags its event index (the summary reads only the
  first 10,000 events, bug-e529e3): the card's state, spend and tasks then come from the events, and a run whose
  events say it ended reads ended even while roko's summary still says running.
- `reading` (0.8.0): true while the backend has not yet read the run's whole event index (a long run opened for the
  first time, from a roko without `?skip=`, takes several reads of 40,000 rows each): the card is what it read so far
  (`events_read` rows: those roko sent, and those it passed over for `?skip=` when it counts them, `skipped_rows`;
  roko 8d02ac126 does not, and there the agents' words are not among them), and a run that ended is kept as final
  only once it is read to its end.
- `receipt` (`Receipt`) on a run that ended, else null: the strip printed at its end. Its top-rung line is an
  estimate, always shown with `≈` and with its `basis` as its own line: the conservative counterfactual (spec §4.6,
  plugin-review's question 1). Each passed task's passing try's tokens are priced at the list prices of the ladder's
  top rung (`ladder[-1]`), a cache read at its cache-read price (a tenth of its input price when it names none, as
  roko prices one), and the run's helper calls are added at what they really cost. It assumes the top rung would have
  passed every task at its first try with the same tokens, so it never credits roko with the cheap rungs' failed
  tries. Tasks that never passed are left out and counted (`not_compared`). From an older roko, whose tries carry no
  `usage`, the run's own tokens (the card's `tokens`) are priced instead, a cache write at 1.25 times the input price,
  and the basis says "failed tries included". 0.8.0 (P-54): a run that resumed another covers the whole Graph run.
  roko writes every invocation's tries into the Graph run's folder (the first run of the chain of `resumes`, its
  attempts.jsonl with `inv` 1, 2, …), and the card reads that folder too, so its `tasks[].climb` carry the earlier
  invocations' tries and their rungs (the run that was resumed keeps only its own). The receipt's `cost_usd` is then
  what the run carried from before it resumed plus its own (`carried_usd`, roko bug-b7f6a8), its ratio sets that
  against every passing try, and its basis adds "· the whole run, its earlier invocation's tries included".

### `GET /runs/{run_id}/events?cursor=&limit=` · `?tail=N` · `?before=C&limit=N`
A readable timeline, newest last. `tail=N` (≤400) returns the last N lines instead, with `next_cursor` to
continue from. 0.8.0 (round v7): the `tail` answer adds `earlier`, true when the run has lines before them, and
`before=C` (a cursor, with `limit` ≤200) returns the `limit` lines just before cursor C, oldest first, with `earlier`
saying whether there are more before those. A page opens a long run on its `tail` and follows it with `cursor`, and
asks `before` only when the person asks for earlier lines, never to poll.

Both read the run's whole index first. roko's index pages only forward, 200 rows a request, and a caller gets 30
requests a second: a real phase's run (100,000 rows and more with trusted live output, 97% of them agent words that
make no line) takes 20 s or more the first time. A roko with `?skip=` (gap-cb9044) leaves the agents' words out
of every read behind the index's end (the timeline's own reads leave out the heartbeats too), and the same run reads
in under a second (the real phase-1 run: 25 requests for its card, from 835). Each request reads for at most 10 s;
until the backend has read far enough it answers `"reading": true`, `"rows_read": N` (counted as `events_read` is)
and no lines (never the run's first lines as its newest), and the page asks again. The backend keeps a run's newest 400 lines whole, 4,000 more as JSON, and where every line
starts, so `before` answers from what it read, and reads older lines from the line before them, not from the start.
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

### `GET /runs/{run_id}/artifacts` (0.8.0)
What the run made: the files its delivered work changed under `artifacts/` (Undertow's `artifacts/ui/*.png`,
`artifacts/audio/*.wav`, `artifacts/reports/*.txt`), read from git at its delivered commit, as Merge finds the work.
```
{"ok": true, "commit": "8e20cced…", "items": [
  {"path": "artifacts/audio/init.wav", "name": "init.wav", "kind": "audio", "bytes": 4300000,
   "audio": {"seconds": 15.0, "rate": 48000, "bits": 24, "channels": 2, "peaks": [0.0, 0.31, …]}},
  {"path": "artifacts/ui/editor-idle.png", "name": "editor-idle.png", "kind": "image", "bytes": 812000,
   "width": 1200, "height": 760},
  {"path": "artifacts/reports/pluginval-strict.txt", "name": "pluginval-strict.txt", "kind": "report",
   "bytes": 9100, "verdict": "passed", "line": "SUCCESS"}]}
```
- Only `.png`, `.jpg`/`.jpeg` (image), `.wav` (audio), `.txt`/`.log` (report); never SVG or HTML. Caps: images 4 MB,
  audio 8 MB, reports 256 KB; a file over its cap is left out. An image or audio file whose first bytes are not
  what its extension says (PNG, JPEG, RIFF WAVE) is left out. At most 24 items.
- `audio.peaks`: 240 values in 0..1, the waveform's outline (a strided look at the samples), so a page draws it
  without the sound. `verdict` (`passed`, `failed` or null) is the report's tool's own word: pluginval's
  SUCCESS/FAILURE, auval's "AU VALIDATION SUCCEEDED/FAILED".
- `items` is empty for a run without delivered work on this machine.
- The files come from the delivery's `files_changed`, which the card cuts at 30 entries ("… 15 more"). When it
  was cut, they come from git, between the delivery's `base` and its commit, deleted files left out, so a shot
  that sorts after a big delivery's first 30 files still shows (phase 4 prep E). The same goes for `/artifact`.
- The pages: the strip under the receipt; a shot opens large in a dialog with its name, size and place, ←/→ to
  the run's other shots and Esc to close (A); and in Changes, an image the delivered work added under artifacts/
  shows as itself, not as a binary file (B). The desktop's chat card of an ended run shows its first shot under
  1 MB, about 240 px wide, captioned "what roko built · <name>", which opens the same dialog (D).

### `GET /runs/{run_id}/artifact?path=artifacts/ui/editor-idle.png` (0.8.0)
One image or audio file the run made, `{"ok": true, "path", "mime": "image/png" | "image/jpeg" | "audio/wav",
"data"}`: `data` is URL-safe base64 (no `/`, so no page rewrite can touch it). `not_found` for anything else: a file
the run did not change, a report, another kind, one over its cap, or bytes that are not what the extension says.
A page asks for audio only when the person presses play.

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

0.8.0 (P-6): with `"plan": true`, `"spec_path": "docs/specs/phase-2-rumble.md"` writes the plan from a spec file in
the project, a path relative to it; the `prompt` is then optional and only adds to the spec. roko reads the file
exactly (`plan_generate`'s `spec_path`, roko gap-fe4225); an older roko is sent the file's exact text as the
prompt, the spec first, then `---` and the prompt, as roko itself joins them. The path must name a file of at most
1 MiB inside the project (`invalid` otherwise, before anything is sent), and `spec_path` without `"plan": true` is
`invalid`. Without a `title`, a phase's spec names the plan as the Build tab finds it ("P2 · Rumble and
modulation", from `docs/specs/phase-2-rumble.md`'s "# Phase 2: rumble and modulation"), any other spec by its
first heading. The run log keeps the `spec_path`; the plan writing's `source_checks.from` names it.

0.8.0 (P-7): with `"plan": true`, `"max_usd": 0.6` caps the plan writing (above 0, at most `max_run_usd`), passed to
roko's `plan_generate` when it declares `max_usd` (roko 55d0acda8). An older roko could not keep a cap, so one is
refused (`invalid`, "cannot cap a plan writing") rather than dropped. The answer adds `max_usd` and `max_usd_source`
(`request`, or `config`: roko's `[authoring] max_generation_usd`, $2.00 by default), as roko answers them; the run
log keeps the cap, the plan writing's card shows it (`max_usd`, and `writing.text` "… · $0.04 of $0.60"), and
`/overview`'s `plan_writing_cap` says whether this roko takes one, so the composer offers a cap for plan writing.
A title the
request states for its plan comes before the spec's name and the request's first sentence (P-8): its first line
"Title: P0 · …" ("Plan title: …"), or a sentence that sets it ("Set the plan title to "…"", "Title the plan "…"").
A model asked to title a plan wrote it there, and roko made the plan's id from it (`title-p0-…`).
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

### `GET /estimate?chars=120&domain=code&max_usd=0.5`
0.6.0 (P7): what the composer's "where it starts" panel shows before the person presses Start: where a request
would start on the model ladder and how far it may climb, about what it will cost and take, the most it can spend
within the cap, how similar runs went, and the checks roko will run on it. It reads only (nothing is spent). Every
parameter is optional: `domain` and `max_usd` are checked as `POST /runs` checks them. `chars` is the request's
length in characters (≤ 8,000; `invalid` over that). Callers send `chars`, never the request itself: a request in a
URL ends up in access logs and history. For this release only, an older caller's `prompt` is still accepted and
read for its length alone, never for its words; it is going away. Today's estimate does not depend on the request:
roko runs every request from Hermes as one `focused` task.
```json
{"ok": true, "estimate": {
  "start_rung": "cheap", "climb": ["cheap", "mid", "strong"], "ladder": [Rung, …],
  "likely": {"usd": 0.021, "seconds": 74}, "worst_usd": 0.31, "max_usd": 0.5, "stops_at_cap": false,
  "similar": {"runs": 12, "tasks": 12, "first_try": 9, "first_try_rate": 0.75, "p90_usd": 0.06},
  "checks": [{"name": "verify[0:test]", "phase": "test", "command": "python3 -m unittest -q",
              "source": "roko.toml"}],
  "basis": "≈ the median of 12 similar runs Hermes started here", "confidence": "medium"}}
```
```ts
type Estimate = {
  start_rung: string | null     // the rung it starts on: the one `Rung.starts` names for `focused`, or the first
                                // above it a run from Hermes can use; null without a ladder (or a usable rung)
  climb: string[]               // the rungs it may run on, in order: the start rung and at most two above it that a
                                // run from Hermes can use (roko climbs one after two failed tries on a rung, at
                                // most twice); [] without a ladder
  ladder: Rung[] | null         // the workspace's ladder, as /overview gives it
  likely: {usd: number | null, seconds: number | null} | null
                                // ≈ what it will cost and take: the median of the similar runs, else of the tasks
                                // roko recorded in this workspace (roko's /api/learn/efficiency, every kind of
                                // task), else null (nothing to go by). Always show it with ≈ and `basis`
  worst_usd: number | null      // ≈ the most it would spend if every try failed: two tries on each rung of
                                // `climb`, each costing `likely.usd` scaled by that rung's list prices (input plus
                                // output per million) against the start rung's; never above `max_usd`. null when
                                // `likely.usd` or a rung's prices are unknown: then only the cap bounds it
  max_usd: number               // the cap it is estimated under: `max_usd` as asked, else the plugin's max_run_usd
  stops_at_cap: boolean         // the cap would stop it before every try ran: the worst case reaches the cap, or
                                // is unknown ("the $0.50 cap stops it before it spends past it")
  similar: {runs: number, tasks: number, first_try: number, first_try_rate: number | null,
            p90_usd: number | null} | null
                                // the newest 20 one-task runs Hermes started in this workspace, in the same domain,
                                // that ended with a verdict (succeeded, failed or unverified): their tasks and how
                                // many passed on the first try ("12 similar tasks: 75% passed on the first try"),
                                // and the 90th percentile of their cost (null under 3 runs; the composer's default
                                // cap is the smallest detent at or above it). null when there are none
  checks: EstimateCheck[] | null  // the checks roko will run on the work, in order, as roko picks them for a
                                // request of this domain: its `[gates.packs.<domain>]` rungs, else (code) its
                                // `[[gates.rungs]]`, the required ones that run a command; with none, a code
                                // request in a Rust or Go workspace gets roko's compile check. [] when roko will
                                // run none (the run then ends `unverified`); null when the plugin cannot read the
                                // workspace's roko.toml (no `workdir`)
  basis: string                 // what the numbers rest on, in words that say what was used:
                                //   "≈ the median of 12 similar runs Hermes started here";
                                //   "no similar one-task run from Hermes yet; ≈ the median of 40 tasks roko
                                //   recorded here, of every kind" (or "only 2 similar runs from Hermes; …");
                                //   "nothing to go by yet: no similar one-task run has ended here (2 plan runs
                                //   have)", naming the runs that did end and why they do not count (plan runs,
                                //   runs in another domain, runs that ended without a verdict or a cost);
                                //   "nothing to go by yet: no run has ended here" only when none has
  confidence: 'low' | 'medium'  // medium from 10 similar runs on, else low
}

type EstimateCheck = {
  name: string                  // as a run names it: "verify[0:test]"
  phase: string                 // the rung's name in roko.toml ("test"), or "compile" for roko's compile check
  command: string               // ≤ 400 chars (untrusted)
  source: 'roko.toml' | 'roko'  // roko.toml's rung, or roko's own compile check
}
```
The estimate is the plugin's, from history, until roko estimates a request itself (round v6's R7 estimates the
tasks of a plan): show `likely` and `worst_usd` with `≈`, and `confidence: "low"` as such. With roko serve down
it still answers: the ladder from roko.toml (as `/overview` does), `similar` from the run log, and `likely` from the
similar runs only. Refusals: `invalid` for `chars` that is not a whole number from 0 to 8,000 (or an older
caller's `prompt` over 8,000 characters), an unknown domain or a bad `max_usd`.
0.6.0 runs keep their domain in the run log; one logged before counts as `code`.

### `GET /plans`
```json
{"ok": true, "plans": [{"id": "add-tests", "title": "Add tests", "task_count": 3, "tasks_done": 1,
                        "tasks_not_passed": 0, "status": "ready", "group": "my-plans",
                        "demo": false, "start_here": false}], "total": 1}
```
`status` is roko's own text (`ready`, `done (1d ago)`, `last run did not pass (2h ago)`). `group` is roko's plan
set (`demos/parallel-plans`). 0.5.0: `demo` (roko's `fixture` flag since gap-8f84d1, kept once the plan has
run, and `fixture` itself when roko gives it; from an older roko, group `demos…` or status `fixture`) and
`start_here` (its title starts "Start here": the demo to try first). 0.6.0: `imported_from` (`{kind: 'mori', plan}`
or null), as the plan sheet gives it, for the list's FROM DOCS group: read from the head of the plan's tasks.toml
in the workspace's plans folder, so it is null when the plugin does not share roko's workdir.

### `GET /build?project=`
0.8.0 (round v7): the project's build, its phases in order, for a long build made of several plans (Metakosmia
Undertow: six phases, each a spec, then a plan, then its runs). A phase is found from a spec at
`docs/specs/phase-<n>-<slug>.md` in the project (its "# Phase <n>: <name>" and "**Goal**:" lines) and from a plan
titled "P<n> · <name>" ("Title: P<n> · …" too) or named `p<n>-<slug>` (`title-p<n>-…`). roko's demo plans are left
out. Nothing here starts work or reads a run's events. 0.8.0 (P-42): a phase may be a sub-phase `<n>.<m>` (Undertow's
2.1, 2.2), ordered between n and n+1, with `n` the number 2.1: from `docs/specs/phase-2.1-<slug>.md` ("# Phase 2.1:
…") and from a plan titled "P2.1 · …"; a plan named `p2-1-<slug>` is 2.1 only when a phase-2.1 spec exists (else
it is phase 2, its slug starting "1-").
```json
{"ok": true, "project": {"path": "~/dev/undertow", "name": "undertow"}, "reachable": true,
 "phases": [{"n": 0, "name": "foundation", "goal": "the build system, …", "spec": "docs/specs/phase-0-foundation.md",
             "plan_id": "p0-undertow-foundation", "title": "P0 · Undertow foundation", "state": "passed",
             "ended": null, "coverage": {"total": 9, "covered": 9, "missing": []},
             "tasks": {"passed": 3, "total": 3}, "runs": 3, "run_id": "e578cf71-…", "writing_id": null,
             "cost_usd": 1.181119, "writing_usd": 0.0983, "wall_ms": 5471000, "rungs": [ … ]}],
 "totals": {"phases": 6, "passed": 2, "tasks_passed": 8, "tasks_total": 12, "runs": 4, "cost_usd": 2.7902,
            "writing_usd": 0.5838, "outside_usd": 0.1053, "cost_source": "ledger", "wall_ms": 9322990},
 "receipt": {"phases": 2, "cost_usd": 2.1, "top_rung": "claude-sonnet-4-6", "top_rung_usd": 4.2, "ratio": 2.0,
             "basis": "≈ each passed phase's passing tries at claude-sonnet-4-6's list prices · roko's spend includes
                       2 runs that didn't pass", "runs_not_passed": 2, "runs_running": 0, "missing": 0,
             "unread": [], "not_compared": 0},
 "next": {"n": 2, "do": "wait", "run_id": "c31152b2-…"}}
```
- `state`: `passed` (its latest run succeeded, or roko's plan row says every task is done), `unverified`,
  `running`, `queued`, `writing` (a plan writing for it runs), `stopped` (its latest run ended otherwise; `ended`
  says how: `failed`, `cancelled`, `interrupted`, `missing`), `written` (a plan, no run yet), `specified` (only a
  spec). 0.8.0 (hermes-pilot P-50): `merged` is a phase that would read `stopped` whose plan's branch
  (`roko/plan/<plan_id>`) is on the project's trunk (`main`, else `master`; `git merge-base --is-ancestor`, read
  only): its work was merged by hand, as Undertow's main was fast-forwarded to phase 4's plan branch. `ended` then
  says how its run ended ("run cancelled"); it counts as built in `totals.passed` and the receipt, and `next` moves
  on past it, never offering a resume. The pages say "merged by hand · run cancelled".
- A phase's plan is the one its latest run ran; else the one that runs the most of its spec's checks, then the
  newest (its tasks.toml written last, so a hand edit counts), then the one named `p<n>-…`, then the first listed.
  `plans` counts the phase's plans and `newest` says whether the one named is the newest of them. Its runs are the runs of the phase's plans Hermes started in this
  project (the run log; a run logged before 0.7.0 counts for the default project). `tasks` is roko's plan row
  (`tasks_done` of `task_count`, which holds across a resume), else the latest run's progress. `wall_ms` adds the
  runs' times, a resume's too: for an ended run the run log has no end for, roko's summary is asked once (P-44).
  Each run counts its own time, never the hours between a run and its resume (P-58): its start to its own end
  (roko's summary of its own events, not its manifest's close once a resume's invocation is in it; an end past
  the start of the run that resumed it is asked again once), and for a run resumed under its own id its
  invocations' spans together (`active_ms`). `rungs` is the latest run's mini ladder.
- `shot` (0.8.0, phase 4 prep C): a passed phase's first UI shot, `{run_id, path, bytes}`: an image under
  artifacts/ui/ its passing run's delivered work made, at most 1 MB, found with `git cat-file -s` (no bytes read)
  once a run and kept in the run log (at most 4 looked for a build); else null. The pad loads it with
  `GET /runs/{run_id}/artifact?path=` and shows it as a thumbnail. When two or more phases have one, the page
  shows them in a reel above the pads instead (the lead's wow 1), each captioned with its phase's `name`,
  `cost_usd` and `wall_ms`.
- `fresh` (0.8.0, P-44): for a phase whose latest run stopped, the newest of its plans written after that run
  started (its tasks.toml's time) and never run (no run in the run log, no task done in roko's row):
  `{plan_id, coverage, roko_coverage, newest}`, the answer to the run that stopped; else null. `next` then runs it
  (or writes it again, should it miss a check) rather than resume the plan that stopped.
- `roko_coverage` (0.8.0): roko's own count of the spec's checks the plan keeps, from the plan's newest plan writing
  that ended (its `source_checks`: `{total, kept, shallow, cannot_run, dropped, missing, writing_id}`), honest since
  roko bug-72dc0d (9f0870e9a: a check is kept only by a step that runs its command); null until the run log holds it.
  The page opens the writings in `unread_writings` (≤8) in the background, as it does a receipt's runs, and the
  run log keeps their counts. `coverage_agrees`: whether roko's count and the plugin's `coverage` agree (kept =
  covered, the same total); null when either is missing. The page shows roko's count and flags a disagreement.
  0.8.0 (the pilot's P4.3): the run log keeps when the plugin first learned a writing's count
  (`source_checks_at`); once the plan's tasks.toml was written after that (a hand edit), roko's count is stale and
  `roko_coverage` is null, so the pad and `next` go by the plugin's own count.
- `coverage` (null without a spec table or the plan's tasks.toml in the workspace): how many of the spec's
  acceptance checks (its "Acceptance checks" table, `| P2.04 | \`tools/spec.sh 2 rumble 'P2.04*'\` | … |`; an id
  range, `P5.01-P5.03`, is one check) the plan's verify steps run exactly: a step runs a check only when its command
  is exactly the spec's command for it, or exactly a ` && ` join of spec commands. A guard in front of it
  (`grep -q 'AllocationCounter' core/src/engine.cpp && …`, which can fail correct work), anything else chained to
  it, a changed filter or another runner does not count. `missing` names up to 20 it does not run.
- The money is roko's own ledger (`.roko/learn/costs.jsonl`), grouped by plan id, so it agrees with roko's:
  a phase's `cost_usd` is its plans' runs (helper calls included) and plan writing (the planner's calls and what
  roko ran after them), `writing_usd` that writing; `totals.cost_usd` is the ledger's whole, `writing_usd` the
  phases' plan writing and `outside_usd` what no phase's plan accounts for (a plan id with no phase in it).
  `cost_source` says `ledger`, or `runs` when the plugin cannot read it (a remote roko): then the money is the
  run log's runs and plan writings.
- `receipt`: the phases built so far on the ladder's top rung, against all roko spent on the build. A passed
  phase's top-rung estimate is its passing run's receipt (each task once, its passing try at the top rung's list
  prices; a run that resumed another counts only what it ran, so the estimate errs low), as the run log kept it
  when that run's whole card was read. `cost_usd` is every run of every phase, failed, cancelled and running
  ones included: what did not pass counts against roko (`runs_not_passed`, `runs_running`), and `basis` says
  so in words. `phases` counts the phases compared; `missing` counts passing runs whose receipt the log does not
  hold yet, and `unread` names up to 8: opening a run (`GET /runs/{id}`) reads it, so a page opens them one by
  one. A `ratio` under 1 means roko spent more than the top rung would have. `words` (0.8.0, option 1) is the
  receipt as both pages print it: "2 phases built so far on claude-sonnet-4-6 ≈ $5.69 · roko spent $2.10: 2.7×
  less" ("the whole build" once every phase is compared, "× more" when roko spent more, " · 1 run still to read"
  while `missing`), or "reading 2 runs for the build's receipt…" before any is read; null when neither. Null
  before any phase passed.
- `ladder_line` (0.8.0, the lead's wow 3): the landed work on the ladder in one line, from roko's own records of
  the runs whose work landed (each passed phase's passing run, a phase merged by hand's last): its tasks by the rung
  they passed on (each run's `rungs`), how many passed on their first try and the climbs (its `learning`): "landed
  work by the rung it passed on: mid 26, strong 7 · 27 of 33 passed on the first try · 1 climb". It says only what it
  counts; null without such a run. The pages print it under the receipt.
- `chart` (0.8.0, the lead's wow 2): two plain series by built phase (passed or merged by hand), from roko's records,
  with no trend claimed in words: `[{label, values, range, words, tone}]`. "cost per verified task, by phase" is a
  phase's whole spend as its pad has it (`cost_usd`: failed runs and plan writing too) over the tasks roko verified;
  "first-try rate, by phase" pools all its runs' tries, failed runs too, as the Learning tab counts them (tasks
  whose first try passed, of those tried). `values` are in phase order, `range` their least and most ("$0.07 to
  $1.05"), `words` every phase's figure and the basis ("… P0 $0.40 · P1 $0.24 · …"). A series needs two phases;
  null without one. The pages draw each as a spark in the head's cells, with its range, and `words` on hover.
- `next`: what the build waits on, the first phase that has not passed: `wait` (`run_id` of the run or plan
  writing), `resume` (`plan_id`, `run_id` of the stopped run), `run` (`plan_id`), `write` (`spec`), or `rewrite`
  (`plan_id`, `spec`, `missing`): a plan that misses any of its spec's checks is never offered to run or resume,
  since it cannot pass the phase (hermes-pilot P-25). `run`, `resume` and `rewrite` carry `covered` and `total`
  when the plan's coverage is known, `roko_kept` and `roko_total` when roko's count is, and `plans` and `newest`
  when the phase has more than one plan (P-33). A plan is rewritten, never run or resumed, while either count says
  a check is not kept. 0.8.0 (P-52): a `resume` whose stopped run roko refused because every rung of its ladder is
  skipped (the phase's `all_skipped`, `{billing_only, providers, lapse_ms}`, which the run log keeps from the run's
  card) carries `words`, which the pages show in place of their own: "P2's run was refused: every rung was skipped
  because its provider could not bill: recharge cerebras and zai, then resume it", or, when a rung failed for
  another reason, that a resume now is refused again until roko's probe verdict lapses or its model's entry leaves
  .roko/learn/rung-probes.json. Null when every phase passed, or there are none.
- `reachable`: false when roko did not list its plans; the specs and the run log still make the build.

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

0.8.0 (P-1): `asked` is what was asked for the plan, from the run log's newest writing of it, or null when no writing
of it is logged (roko's CLI, another tool): `{text, spec_path, by: "chat" | "page", run_id, at}`. roko's plan sheet
does not repeat a chat's request ("it is untrusted data"), so this is the only place the person sees the chat
model's words (its rewording once made a plan of planning tasks). `text` is the request as the run log keeps it
(≤ 600 characters), `spec_path` the spec it named (P-6); show both as text, labelled by whose words they are.
0.8.0 (P-43): `asked` also has `cost_usd` and `max_usd`, what writing the plan cost and the cap it ran under, as the
run log has them (null when unknown). The pages say "writing it cost $0.04 of its $0.50 cap": that cap was the
writing's, never a run's. An ended plan writing's `headline` says it too ("… · $0.04 of $0.50").

0.8.0 (P-41): `validator_notes` is roko's validator's warnings on the plan, from the same `POST /api/plans/{id}/validate`
call as `validation`: `{rule, task_id, message}[]` (at most 10; `message` is the first line, ≤ 300 characters, as
roko words it), or `[]`. The pages list them under the plan's checks as "roko's validator notes", the code and the
words, never reworded: a warning (PLAN_058, a check that needs a file only a later task writes) is a hint that a plan
may not pass.

0.8.0, from roko 7c3b523a8 (gap-0fb7d9): `repairs` is what roko changed in its planner's draft before it validated it,
one line a change in roko's words (`string[]`, at most 20, `[]` when it changed nothing), from the "## Repairs" section
roko writes in plan.md (the document leaves that section out). The pages list them under the validator's notes as
"roko repaired the draft", with roko's `code` as code. A plan writing's card carries the same lines as `repairs`,
from its result.

0.6.0 (P8): the plan reads as a document first. `plan` gains:
```ts
doc: PlanDoc | null             // plan.md, condensed; null when the plugin cannot read the plan's folder (it reads
                                // the workspace, as roko serves no plan.md) or the plan has no plan.md
rubric: {markdown: string, truncated: boolean, path: string} | null  // rubric.md as written (≤ 4 KB, untrusted)
imported_from: {kind: 'mori', plan: string} | null  // `roko plan import --mori` wrote it, from mori plan `plan`
plan_checks: Check[]            // the whole-plan check ([[meta.verify]]), run once the tasks passed
dropped_checks: {id: string, reason: string}[]  // the source's checks the plan does not keep, and why
                                // (`[meta] dropped_checks`, "SC3: needs a person to judge it"); [] when it names none
tasks[].acceptance: Acceptance[]  // its acceptance criteria, in order, with the checks that cover each
tasks[].verify: Check[]         // its checks, named as a run names them, with what each covers
tasks[].start_rung: string | null  // the rung its tier starts on (the ladder's `Rung.starts`); null without a ladder
tasks[].section: string | null  // the section of the plan document it implements (`plan_section`, mori), or null
tasks[].goal: string | null     // TSS v1 `goal`; `non_goals: string[]` beside it
tasks[].also_required: string[] // what the task must also do that no check proves: a mori import keeps a task's
                                // checked criteria in `acceptance` and moves the rest to the end of its description,
                                // in the block "Also required, not checked automatically:" with one "- " line each
                                // (the lead's option B); ≤ 20, each ≤ 600 chars, cut with a visible "…" (the task
                                // text has it whole; untrusted), as the pages show them. Show them in dim ink under
                                // the checked criteria, labelled "also required · not checked automatically". The
                                // block is taken out of `description`. [] without one
tasks[].also_required_judged_in_review: boolean  // the block says "(the review task judges these)": the plan's
                                // review task judges them
tasks[].also_required_more: number  // the block's lines past the 20: never dropped, they stay in `description`,
                                // after a blank line, where the pages show them. 0 for most tasks (37 of the bardo
                                // corpus' 1,732 blocks hold more, up to 39). For a later "and n more"
estimate.by_rung: {rung: string, model: string | null, tasks: string[], likely_usd: number | null}[] | null
                                // the tasks that start on each rung, cheapest first; `likely_usd` is roko's likely
                                // cost of them there (its per-task estimate, R7, roko c193d3516), else null
estimate.likely_usd: number | null  // roko's likely cost, each task on its rung with its retries (R7), else null
estimate.worst_usd: number | null   // roko's worst case: every task fails its way up the ladder (R7), else null
estimate.cap_usd: number | null     // the plan's cap, `[budget] max_plan_usd` (R7); show the worst case against it
estimate.unpriced_tasks: string[]   // tasks whose model has no price, left out of the totals (R7); [] before R7
estimate.start_rung: string | null  // the rung most tasks start on
tasks[].estimate: {likely_usd: number | null, likely_secs: number | null, worst_usd: number | null,
                   worst_rungs: string[], first_try_rate: number | null, basis: string | null,
                   samples: number | null} | null
                                // roko's estimate of the task (R7): likely (each try weighted by the chance the ones
                                // before it failed) and worst (every try fails and climbs, `worst_rungs` in order),
                                // its rate of passing first time, and what that rests on (`basis`:
                                // same_role_and_tier, same_tier, any_task or defaults, over `samples` tasks);
                                // null from a roko before R7. With R7, `start_rung` is roko's own for the task
```
```ts
type PlanDoc = {
  title: string | null          // its first heading
  sections: {heading: string | null, level: number, text: string}[]
                                // each heading with the first paragraph (or list) under it, ≤1,200 chars each;
                                // the text before the first heading has heading null (untrusted)
  markdown: string              // the same as one document, ≤ 8 KB: headings and their first paragraphs
  truncated: boolean            // plan.md holds more than this
  path: string                  // the file, relative to the workspace ("plans/<id>/plan.md")
}

type Acceptance = {
  id: string                    // "AC1": the item's own `ACn:` prefix, else its place (roko's rule, TSS v1)
  text: string                  // the criterion as the plan writes it, without that prefix and the source-check
                                // ids that open it (untrusted)
  checks: string[]              // the names of the task's checks that prove it: those whose `covers` names it or
                                // one of its source checks; or, when none of the task's checks declares `covers`
                                // (a plan `roko plan import --mori` wrote, or one written by hand), those whose
                                // command the criterion quotes in backticks, the whole command or a test or module
                                // name ("`test_locked_loop_repeats` passes" → the check that runs
                                // tests.test_turing.TuringMachineTest.test_locked_loop_repeats); [] when none
  linked_by: 'covers' | 'quote' | null  // how `checks` was found: the plan's `covers`, or the criterion's own quote;
                                // null when it has none
  source_checks: string[]       // the checks of the plan's source (its spec) it keeps ("SC2"): roko's planner
                                // writes a kept check into a criterion as "AC1: SC2: …" (roko-planner,
                                // gap-dc5d7c); [] when it names none
}

type Check = {
  name: string                  // as a run names it: "verify[0:unit_test]" for a task's, "plan[0:compile]" for a
                                // whole-plan check
  phase: string | null
  command: string               // ≤ 400 chars (untrusted)
  fail_msg: string | null       // what a failure means, as the plan says
  covers: string[]              // the acceptance criteria it checks ("AC1"), as the plan says; [] when it does not
  expect: string | null         // TSS v1: what it does on the unchanged base, "fail_on_base" or "pass_on_base"
}
```
Everything here comes from the plan's own files: `tasks.toml` (roko's `GET /api/plans/{id}/source`), and `plan.md` and
`rubric.md` beside it in the workspace. A plan `roko plan import --mori` wrote keeps mori's acceptance criteria, its
checks (from `verify-tasks.toml`, the acceptance "Checkpoint" lines and `verify.sh`) and its rubric.

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
0.8.0 (round v7, P-14): the body also takes `fresh: true` (start the plan over, setting its last run's progress
aside) and `from_run` (continue that earlier run of the plan: its id, or its first 8 characters); `fresh` with
`resume` or `from_run` is refused (`code: invalid`). When the plan's last run stopped part way (failed,
interrupted or cancelled, with tasks passed and tasks left) and the body says neither `resume` nor `fresh`, the run
is refused before anything starts, in roko's words (roko bug-cbdb6b; from an older roko, the plugin reads the plan's
last run in its run log), with the run in `resumable_run`:
```json
{"ok": false, "error": {"code": "refused", "message": "Plan 'p0-undertow-foundation' has a run that can be resumed:
 6988f0b8 (failed) passed T1 and T2, and T3 is left. Pass resume=true to continue it, so only T3 runs, or fresh=true
 to start over and set its progress aside.", "hint": "continue it, so only what is left runs, or start the plan over
 and set its progress aside"},
 "resumable_run": {"run_id": "6988f0b8-…", "status": "failed", "passed_tasks": ["T1", "T2"], "tasks_left": ["T3"]}}
```
`GET /plans/{plan_id}` names the same run (`resumable_run`, or null) before anything is asked, so the page offers
continue or start over in its Run plan form. A run that started over has `set_aside` on its card (that run, in the
same shape), and its timeline a line in roko's words with the command that brings it back (`roko resume 6988f0b8`).

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

### `POST /runs/{run_id}/cancel`  body `{"reason": "…"}` (optional)
0.6.0 (P-1): the person's reason, if the page asks for one (≤200 chars), goes on the run's card as
`cancelled_by` (`by: "page"`).
```json
{"ok": true, "run_id": "…", "state": "cancelled",
 "cancelled_by": {"by": "page", "reason": "not now", "at": "2026-10-17T12:00:00.000+00:00"}}
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

#### `action=setup-project`, `start-serve`, `restart-serve` (0.7.0)

Each takes `project` (GET query, POST body; the problem's `fix.project`), previewed and applied like the others.
- `setup-project`: `GET /setup/fix?action=setup-project&project=/abs` answers `{action, title: "Set up roko in
  pocket-synth", variant: null, variants: [], preview: "", path (the project), summary, digest, note}`: `summary` says
  what `roko init` writes there (roko.toml with the project's checks and model ladder, and its `.roko/` folder) and the
  change that lets roko accept runs started from Hermes (roko's `config preset chat-host`, or the plugin's own fix);
  `note` that nothing is committed. `POST /setup/fix {"action": "setup-project", "project", "digest"}` runs `roko
  init`, makes the change, starts the project's roko serve and answers `{action, done, ready, path, message, next,
  serve}`: `done` whether anything changed, `ready` whether roko accepts runs started from Hermes there now, `next`
  what is left for the person (a model key, say) or null. `conflict` when the project changed since the preview
  (someone ran `roko init`); `invalid` when it is not a git checkout.
- `start-serve` and `restart-serve`: the preview has only `summary` (and, for a restart, `note`: the runs it would
  interrupt, or null), with `preview: ""` and `digest: null`. Applying answers `{action, done, ready, message, next:
  null, serve}` at once: the serve `starting`, as `POST /serve` does. A busy restart without `"force": true` is
  refused with `conflict` as `POST /serve` refuses it. The setup card's existing buttons work unchanged.

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
    "diagnoses": [{"id": "stall-watchdog:…:silent", "source": "stall-watchdog", "who": "stall watchdog",
                   "ts": "…", "severity": "warn",
                   "subject": "plan/T2", "detail": "agent silent: no progress for 180s",
                   "suggested_action": "…", "intervention_taken": null}]},
   {"ring": "L3", "name": "learning", "clock": "days", "state": "active", "recent": [LoopEvent, …],
    "models": [{"model": "glm-5.1", "attempts": 9, "tasks": 9, "success_rate": 0.9, "total_cost_usd": 0.09,
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
  ≤10; `source` is who raised it: `conductor`, `stall-watchdog`, `ladder_exhausted`, `self_model_refine`, …;
  0.6.0: `who` says it in words, "self-model" for `self_model_refine` and `self_model_abandon`: show `who`, never
  `source`), L3 `models` (`/api/learn/model-scorecard`; 0.6.0: `attempts` is what roko counts per model, its
  efficiency rows, one or more per attempt and never a count of tasks; `tasks` keeps that number for older pages
  and is deprecated: "passes 33% of 6 attempts", not "of 6 tasks"), `knowledge` (`/api/knowledge/entries`), `playbooks`
  (`/api/learn/playbooks`), L4 `loops` (`/api/learn/loops`: each learning loop's lifecycle, health `state`
  and its numbers `h`, `n_opp`, `eps`, `iota_net`, `beta`, any of which may be null).
- `live`: the relay's state (`hub` is `stopped`, `connecting`, `open` or `backoff`) and how many sockets
  are open.

### `GET /learning?scope=hermes|workspace`
0.6.0 (spec §5.6, P6): what roko has learned, in numbers that move, for the Learning view: the hero KPIs, where work
passed on the ladder, the lessons that paid off and what the KPIs owe to them; and, from roko, its cost per verified
task run by run and M1's homeostat. Nothing here is a guess: a number roko and the runs do not give is null. Two
scopes, as `GET /insights` has:

- `scope=hermes` (the default): the runs Hermes started that ended and whose card this plugin built (0.6.0 or later
  keeps what each one learned in the run log).
- `scope=workspace`: every plan run in roko's workspace, from the terminal (`roko run`, `roko plan run`), a chat host,
  the HTTP API or Hermes: the newest 20 that closed, from roko's run records (`.roko/runs/<run>/manifest.json` and
  `attempts.jsonl`, one folder per run, its resumes included), plus `recorded_tasks`, roko's spend over every task it
  recorded. The records give each try's rung, verdict and cost, so the KPIs and where work passed are as full as in the
  hermes scope; what a run's prompts carried and the lessons its tasks kept come from its card, so only the runs
  Hermes started have them (`coverage` says how many). Without a shared `workdir` the plugin reads no records:
  `runs` is empty and `coverage` counts the runs roko's run index lists (`GET /api/dashboard/runs`).

Another scope is `invalid`. Show `coverage.note` beside the numbers when it is set: it says where they rest on less.
```json
{"ok": true,
 "scope": "hermes",
 "scope_label": "runs started from Hermes",
 "coverage": {"source": "run log", "runs": 12, "found": 12, "lessons_from": 12, "note": null},
 "recorded_tasks": null,
 "runs": [LearningRun, …],
 "kpis": {"cost_per_pass": Kpi, "first_try_rate": Kpi, "climbs_per_run": Kpi},
 "lessons_first_try": {"with": {"passed": 7, "of": 8, "rate": 0.875}, "without": {"passed": 3, "of": 7, "rate": 0.4286},
                       "design": "observational", "comparable": true, "difference": 0.4464,
                       "note": "observational: tasks without a lesson differ in other ways too"},
 "where_passed": {"rungs": [Rung, …], "runs": [{"run_id": "…", "passed": {"cheap": 3, "mid": 1}}, …],
                  "cheapest_share": {"first": 0.41, "last": 0.78}},
 "lessons": [PaidOff, …],
 "homeostat": Homeostat,
 "checked_at": "2026-10-17T12:00:00.000+00:00"}
```
```ts
type LearningRun = {            // one ended run, oldest first, at most 20
  run_id: string
  label: string
  state: string
  finished_at: string | null
  cost_usd: number | null
  tasks: number                 // its tasks that ran (had a try)
  passed: number                // its tasks that passed
  first_try: number             // its tasks that passed on their first try
  climbs: number                // its tries that climbed a rung (`Try.reason` climb)
  cost_per_pass: number | null  // USD per passed task: roko's own (its cost per verified task for the run,
                                // efficiency_trend_updated, roko ee09f6464) when it gave one, else cost_usd / passed
  cost_per_pass_by: 'roko' | 'plugin' | null
  rungs: RungCount[] | null     // its tasks on the ladder (as its RunRow)
  lessons_kept: string[] | null // ids of the lessons its tasks kept; null when unknown (a run read from records)
  lessons_used: string[] | null // ids of the lessons its prompts carried; null when unknown
  origin: 'hermes' | 'terminal' | 'chat' | 'http' | null
                                // who started it: Hermes (its run log), a terminal (roko's `cli`), another chat
                                // host (`mcp:<client>`), the HTTP API; null when roko's record does not say
  source: 'card' | 'records'    // card: what the plugin's card of the run saw (the hermes scope); records: roko's
                                // run records (the workspace scope), with the lessons of its card when Hermes
                                // started it
}

type Coverage = {               // how much the numbers rest on
  source: 'run log' | 'run records' | 'run index'
  runs: number                  // the runs in `runs`
  found: number | null          // the runs there are to read: ended runs in the run log, closed plan runs in roko's
                                // records (workspace), or complete runs in roko's run index; null when unknown
  lessons_from: number          // of `runs`, those whose prompts and lessons are known
  note: string | null           // where the data is thinner, in the pages' words: "lessons and what prompts carried
                                // are known for 3 of 20 runs, the ones Hermes started", "the plugin does not share
                                // roko's workspace: no run records to read"
}

type RecordedTasks = {          // workspace: every task roko recorded (GET /api/learn/efficiency), passed or not
  tasks: number
  cost_usd: number | null
  cost_per_task_usd: number | null   // their average spend
  typical_task_ms: number | null     // their average time
}

type Kpi = {                    // one hero number
  value: number | null          // the newest 3 runs together, as one ratio of sums: cost per verified task is their
                                // cost (every ended run's, failed and stopped ones included) over their verified
                                // tasks, never a mean of each run's ratio; first-try rate is first-try passes over
                                // tasks that ran; climbs are per run
  first: number | null          // the same for the first 3 runs; null with fewer than 4 runs ("was … on your first runs")
  series: (number | null)[]     // per run, oldest first: the trend line (cost per verified task: the run's cost over
                                // its verified tasks, null for a run that verified none or whose cost is unknown)
}
```
`kpis.cost_per_pass` is the cost per **verified** task: say "per verified task" wherever it shows. Its numbers are
each run's cost and verified tasks, summed: roko's own figures for the run when it gave them (its
`efficiency_trend_updated`: model and helper calls together, verified tasks), else the run's `cost_usd` and its tasks
that passed. A run whose cost is unknown is left out of both sums; a run that verified nothing adds its cost.
```ts
```
- `lessons_first_try`: what the KPIs' "what drove it" line may quote, never a guess (plugin-review's question 3).
  null until a run's prompts were seen (roko 8357603f0, `prompt_events`).
```ts
type LessonsFirstTry = {
  with: {passed: number, of: number, rate: number | null}     // tasks whose first try's prompt carried a lesson
  without: {passed: number, of: number, rate: number | null}  // the tasks compared with them (below); show both `of`s
  design: 'control_arm' | 'observational'
                                // control_arm: `without` is the tasks whose lessons roko's control arm withheld at
                                // random (prompt_assembled `left_out` reason `withheld_arm`), so the comparison is
                                // randomised; observational: `without` is every task whose first prompt carried no
                                // lesson, which differ from the others in other ways too
  comparable: boolean           // each group has at least 5 tasks; until then show only `note`
  difference: number | null     // with.rate − without.rate when comparable, whichever way it points: show it as it is,
                                // never only when lessons come out ahead
  note: string                  // the line to show with it: "too few tasks to compare yet (n = 3 and 2)",
                                // "observational: tasks without a lesson differ in other ways too", or "randomised:
                                // roko's control arm withheld the lessons from the tasks without"
}
```
- `where_passed`: the ladder's rungs, cheapest first (`Rung`, with `chat_ok`: hatch the rungs runs from Hermes cannot
  use), each run's passes per rung (from `RunRow.rungs`), and the cheapest rung's share of all passes in the first 3
  runs and the last 3 ("cheap ↑ 41% → 78% of passes"); null without a ladder.
- `lessons`: the lessons a run kept that later tries carried, most first-try passes first, at most 10:
```ts
type PaidOff = {
  id: string
  text: string | null           // as the task that kept it wrote it, else roko's label (≤80 chars)
  kept_by: {run_id: string, task_id: string, at: string | null} | null  // null: kept before these runs
  uses: {run_id: string, task_id: string, first_try: boolean, climbed: boolean, passed: boolean}[]
                                // each later task that had it in a prompt, oldest first: the payoff squares (sage
                                // when it passed first try, a rose outline when it climbed)
  first_try: number             // of `uses`, the first-try passes ("4/4 first try")
  confidence: number | null     // roko's, 0–1
}
```
- `homeostat`: M1's four essential variables as the newest run saw them, and its controller, or null when no run saw
  roko's `ev.update`; a live page updates it from `loop` frames of kind `essential` and `controller`:
```ts
type Homeostat = {
  variables: {ev: string, value: number | null, bound: number, inner: number | null,
              state: 'in_bounds' | 'breached' | string}[]  // pass_rate, usd_per_verified_success, false_green,
                                // latency_p90_s; `value` is null before M1 has data
  controller: {episode_id: string, phase: string, change: string | null} | null
                                // its last act: phase idle | search | hold, and `change` as "knob: from -> to"
}
```

## Setup problems

| `id` | `severity` | `fix.kind` | When |
|---|---|---|---|
| `restart-hermes` | block | `restart-hermes` | Hermes runs an older copy of the plugin than the one installed (the desktop copy or the backend) |
| `roko-unreachable` | block | `action` (`start-serve`) when the plugin can start roko (a local project and a roko with `serve --detach`), else `command` | roko serve does not run for the project (0.7.0: also while it starts, then titled so), does not answer, or something else answers at its address |
| `roko-not-found` | block | `docs` | 0.7.0: there is no roko binary on this machine (the `roko_bin` setting, `ROKO_BIN`, `~/.roko/bin`, `PATH`, `~/.cargo/bin`) |
| `roko-too-old` | block | `command` (the update line) | 0.7.0: the roko binary cannot start a serve in the background (no `serve --detach`) |
| `project-needs-setup` | block | `action` (`setup-project`) | 0.7.0: roko isn't set up for runs from Hermes in the project: it has no roko.toml (its roko serve may run on roko's defaults, but refuses runs started from Hermes) |
| `no-model-provider` | block | `command` (`hermes roko init --workdir …`, which offers the key Hermes has) | 0.7.0: roko serve did not start because roko found no LLM provider (roko's `not_initialized`): no roko.toml that names one, no key in `~/.roko/.env` |
| `roko-key-refused` | block | `command` | roko serve has auth on, and the plugin has no key or one roko refuses |
| `plugin-settings` | block | `docs` | the plugin's own settings stop it from using roko serve |
| `key-read-only` | block | `command` | the key cannot start, cancel or answer runs |
| `workspace-refuses-chat-runs` | block | `action` (`workspace-chat-ready`) on this machine, else `docs` | roko refuses runs started from a chat in this workspace |
| `no-tool-loop-model` | block | `docs` | roko has no model a run started from a chat can use (only CLI agents, or no key) |
| `no-priced-model` | block | `docs` | roko refuses runs started from a chat because none of the models they can use has a price their cap can count (roko since gap-8548e3) |
| `roko-serve-outdated` | block or warn | `docs`; 0.7.0: `action` (`restart-serve`) when the roko binary is newer than the running serve | roko serve lacks the run tools (block; 0.7.0: also when it has no `/mcp` at all), or the diff route or its loop events (warn) |
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
  `?runs=a,b` (≤8 ids) also follows runs Hermes did not start, while the socket is open. 0.7.0: `?project=/abs`
  picks the project whose overview the socket's `hello` and `overview` frames carry (the default project
  without it); `serve` frames come for every project.
- 0.7.0: the relay follows the event hub of the default project's roko serve. A run Hermes started in another project
  gets its card and timeline lines re-read every 3 s (`run` and `lines` frames, no `live` items).
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
| `serve` | 0.7.0: a project's roko serve changed state (a start began or ended, it stopped, it idled out), seen within about 2 s whichever Hermes process changed it | `serve`: a `ServeState` |

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
  binds only) streams `text`, `reasoning` and `result` too. An API model's tool steps are live as well (roko since
  gap-5fda00); without trusted mode its words arrive with the attempt's transcript, when it ends. In trusted mode the
  attempt's end also brings its whole text once more, which makes no `live` item (the card's `note` holds it).
- 0.6.0: a `check` item is one line a task's check printed (roko's `gate_output_line`), each line once. Show
  its `tail` as the check's block, the newest line (`line`) highlighted: over the rate, the items of one task wait
  as words do, and the newest carries the lines before it. Tails are kept per try: a new try's check starts a new
  `tail`, and so does a line after its check's result, so a failed try's "FAILED (failures=1)" never sits above
  the next try's "OK". An item with `stream: 'roko'` is roko's note that it skipped lines; it ends the check's
  lines. The card's
  `tasks[].check_tail` holds the same check's last 40 lines, and its verdict once it ends.
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
| `route` | L1 | `route_decided` | `attempt, model, provider, source, stage, reason, p, candidates`; 0.5.0 adds `decided_by, rung, scored` and candidates' `why_not`; 0.6.0 adds `ladder_reason, ladder_step, forecast`, and `climbed_from` on a climb | "T1 attempt 2 → glm-5.1, picked by what roko learned (p 0.82; over gpt-5.4-mini 0.71)" · "T1 attempt 1 → gpt-oss-120b, picked by the model ladder" (0.5.0: the scores only for a learned pick) |
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

## Chat cards: the line the model forgets

On the desktop app a reply line holding only `::roko-run{id="RUN_ID"}` shows that run's card; Hermes 0.22 renders no
card from a tool call alone, and a model told to write the line can still leave it out. 0.6.0: the plugin adds it,
through Hermes' `transform_llm_output` hook (once per turn, before the reply is stored):
- `roko_run`, `roko_plan_run` and `roko_plan_generate` note the run they started for the Hermes session that called
  them;
- the turn's reply gets one line per noted start it does not already name, in start order:
  `::roko-run{id="RUN_ID"}`. 0.8.0 (the lead, after R1l): a plan writing gets its plan's card,
  `::roko-plan{id="PLAN_ID"}` with the plan id roko answered, which since P-45 follows the writing and then shows
  the plan (before, `::roko-run` with the writing's run id, which stops at "passed · 2 tasks"). roko_plan_generate's
  answer and the plan skill tell the chat to show it at once;
- a card line names its id only where the desktop shows it as a card: `::roko-run{…}` or `::roko-plan{…}` where a
  word starts, the id quoted either way (`id="…"` or `id='…'`, other attributes beside it), outside code fences, in
  a paragraph of plain text (no code span, emphasis, link, URL or HTML outside a line holding only a directive) of
  at most 4,800 characters. A writing is also named by its plan's `::roko-plan` line. An unquoted id, `#id` or a
  line in code shows no card, so the plugin still adds one; a line that shows a card never gets a second;
- a card line in the turn's interim text (what the model says beside a tool call, Hermes' `on_interim_message`
  observer) names its id too. Hermes runs that observer on its own thread, so this is best effort;
- on the desktop, in a turn where roko ran (the turn started work, its interim text showed a roko card, or the reply
  holds a roko card line), the reply's `\$` before a digit becomes `$` (`\$0.039` → `$0.039`): the app shows prices
  as text, so an escaped dollar sign would keep its backslash. Other chats are never touched; `$…$` math, code
  spans, code fences and every other backslash stay as written;
- only on the desktop platform (`desktop`): other surfaces would show the raw line, and they keep the reply as it
  is. A turn with no text gets nothing;
- Hermes' `on_session_end` hook, which it fires once at every turn's end, forgets what the turn noted, so a start
  never reaches the next turn's reply;
- the three hooks are registered only on a Hermes that gates hooks per call (0.22+); none is a tool-call hook.

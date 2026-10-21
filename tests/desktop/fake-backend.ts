/**
 * A fake of dashboard/plugin_api.py as docs/ui-api.md describes it, served
 * through the desktop's ctx.rest door (window.hermesDesktop.api). Every route
 * answers {ok:true,…} or {ok:false,error:{code,message,hint}}; an unmounted
 * router rejects like Hermes does ("404: …").
 */

import fs from 'node:fs'

/**
 * The page's own version (`VERSION` in desktop/plugin.js): what a current backend answers. Older and newer versions
 * are relative to it, so a release bump needs no test edits.
 */
export const PAGE_VERSION = /^const VERSION = '([^']+)'/m.exec(fs.readFileSync(process.env.ROKO_PLUGIN_SOURCE!, 'utf8'))?.[1] ?? '0.0.0'

/** The version before the page's: one minor back (0.5.0 → 0.4.0). */
export const OLDER_VERSION = (() => {
  const [major, minor, patch] = PAGE_VERSION.split('.').map(part => Number.parseInt(part, 10) || 0)

  return minor > 0 ? `${major}.${minor - 1}.0` : patch > 0 ? `${major}.${minor}.${patch - 1}` : `${Math.max(0, major - 1)}.9.0`
})()

/** A version newer than any release: an update on disk, or a backend newer than the page. */
export const NEWER_VERSION = '9.9.0'

export const RUN_ACTIVE = 'a1c4e8f0-5b1a-4c55-9d0e-2a7f0c1d9b10'
export const RUN_DONE = 'e13f6327-8c2d-4a7b-b1e4-6f0a9d3c2e11'
export const RUN_UNVERIFIED = 'f0d2b7aa-3e4f-4d21-8a9b-1c2d3e4f5a62'
export const RUN_NEW = 'b7e2c9d1-0f3a-4b8c-9d2e-5a6b7c8d9e03'
export const RUN_FAILED = 'c4a1f9e2-7d3b-4e6a-8f1c-2b3d4e5f6a74'
export const RUN_PLANGEN = 'd9b8c7a6-5e4f-4d3c-9b2a-1f0e9d8c7b85'
export const DONE_COMMIT = 'd66293e36e22aa11bb22cc33dd44ee55ff660011'
/** Untrusted code the diff viewer must print literally. */
export const HOSTILE_LINE = '<img src=x onerror="alert(1)"> // **not bold**'

const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString()

export type ApiRequest = { path: string; method?: string; body?: unknown }

type Json = Record<string, unknown>

/** Untrusted text the UI must print literally (never as HTML or markdown). */
export const HOSTILE_SUMMARY = 'Wrote docs/report.md.\n<img src=x onerror="alert(1)"> **not bold**\nline 3\nline 4\nline 5\nline 6'

function pendingConfirm(): Json {
  return {
    code: 'a1b2c3',
    decision_id: 'c_T2-1',
    kind: 'confirm',
    title: 'the result of task T2 (Report) in run add-tests',
    question: 'Accept the report T2 wrote?',
    summary: HOSTILE_SUMMARY,
    run_id: RUN_ACTIVE,
    task_id: 'T2',
    held_at: iso(-20_000),
    deadline_at: iso(100_000)
  }
}

function pendingEffect(): Json {
  return {
    code: 'd4e5f6',
    decision_id: 'e_effect-1',
    kind: 'effect',
    title: 'the held action mail.send on mail (run add-tests)',
    question: 'Send the summary email to the team?',
    summary: null,
    run_id: RUN_ACTIVE,
    task_id: 'T3',
    tool: 'mail.send',
    server: 'mail',
    arguments: { to: 'string', subject: 'string', body: 'string' },
    proposed_at: iso(-60_000)
  }
}

function runRows(): Json[] {
  return [
    {
      run_id: RUN_ACTIVE,
      kind: 'plan',
      label: 'add-tests',
      plan_id: 'add-tests',
      state: 'running',
      cost_usd: 0.42,
      max_usd: 0.5,
      started_at: iso(-65_000),
      session_id: 'sess-1',
      progress: { total: 3, passed: 1, failed: 0, running: 1, pending: 1, blocked: 0, stopped: 0, unverified: 0 }
    },
    {
      run_id: RUN_DONE,
      kind: 'run',
      label: 'Add clamp() with a test',
      plan_id: RUN_DONE,
      state: 'succeeded',
      cost_usd: 0.0103,
      max_usd: 0.5,
      started_at: iso(-3_600_000),
      session_id: 'sess-1'
    },
    {
      run_id: RUN_UNVERIFIED,
      kind: 'run',
      label: 'Plan the parser rewrite',
      state: 'unverified',
      cost_usd: null,
      max_usd: null,
      started_at: iso(-7_200_000)
    },
    {
      run_id: RUN_FAILED,
      kind: 'plan',
      label: 'Budgets for tally',
      plan_id: 'tally-budgets',
      state: 'failed',
      cost_usd: 0.17,
      max_usd: 1.0,
      started_at: iso(-90_000_000),
      progress: { total: 2, passed: 0, failed: 1, running: 0, pending: 0, blocked: 1, stopped: 0, unverified: 0 }
    }
  ]
}

function runDetail(row: Json, extra: Json): Json {
  return {
    ...row,
    verdict: null,
    active: false,
    position: null,
    tokens: { input: 3352, output: 655, cache_read: 10368 },
    finished_at: null,
    duration_ms: 65_000,
    tasks: [],
    gates: { passed: 0, failed: 0 },
    milestones: [],
    waiting: [],
    review_command: null,
    merge_command: null,
    headline: '',
    checked_at: iso(0),
    ...extra
  }
}

/** As roko lists them in its own repository: real plans first, the demos last, the one to start with among them. */
function planRows(): Json[] {
  return [
    { id: 'add-tests', title: 'Add tests', task_count: 3, tasks_done: 1, status: 'ready' },
    { id: 'parser-rewrite', title: 'Parser rewrite', task_count: 5, tasks_done: 0, status: 'draft', group: 'parser-programme' },
    { id: 'demo-hello', title: 'Roko plan-runner demo', task_count: 1, tasks_done: 1, status: 'done', group: 'demos', demo: true },
    { id: 'demo-hello-world', title: 'Start here: hello world demo', task_count: 1, tasks_done: 0, status: 'fixture', group: 'demos/parallel-plans', demo: true, start_here: true }
  ]
}

function defaultMergeCheck(): Json {
  return {
    run_id: RUN_DONE,
    state: 'succeeded',
    can_merge: true,
    merged: false,
    mode: 'fast-forward',
    into: 'main',
    branch: `roko/batch/${RUN_DONE}`,
    commit: DONE_COMMIT.slice(0, 12),
    reason: null,
    command: `git -C /work/ws merge --ff-only roko/batch/${RUN_DONE}`,
    label: 'Add clamp() with a test'
  }
}

/**
 * The router's pick for T1 (the ladder's mid rung, as a newer backend says it: `decided_by`, `rung`, `scored`, and
 * a CLI agent this run cannot use) and for T2's retry (learned, over two others, as an older backend says it).
 */
const ROUTE_T1 = {
  attempt: 1,
  model: 'glm-5.1',
  provider: 'zai',
  source: 'ladder',
  stage: 'ladder',
  decided_by: 'ladder',
  rung: 'mid',
  scored: false,
  reason: "the ladder's mid rung for focused tasks",
  p: 0.55,
  candidates: [
    { model: 'glm-5.1', provider: 'zai', score: 0.11, p: 0.55, eligible: true, ineligible_reason: null, why_not: null },
    { model: 'gpt-oss-120b', provider: 'cerebras', score: 0.11, p: 0.21, eligible: true, ineligible_reason: null, why_not: null },
    { model: 'claude-sonnet-4-6', provider: 'claude_cli', score: 0.11, p: null, eligible: false, ineligible_reason: null, why_not: 'a CLI agent: a run from Hermes needs an API model' }
  ]
}

const ROUTE_T2 = {
  attempt: 2,
  model: 'glm-5.1',
  provider: 'zai',
  source: 'router',
  stage: 'retry',
  reason: 'highest expected pass rate for a retry of verify[0:test]',
  p: 0.82,
  candidates: [
    { model: 'glm-5.1', provider: 'zai', score: 0.86, p: 0.82, eligible: true, ineligible_reason: null },
    { model: 'gpt-5.4-mini', provider: 'openai', score: 0.71, p: 0.18, eligible: true, ineligible_reason: null },
    { model: 'claude-sonnet-4-6', provider: 'anthropic', score: 0.64, p: null, eligible: false, ineligible_reason: 'over the per-task cap' }
  ]
}

// -- setup problems and the install state (docs/ui-api.md "setup", install_state.py) ------------

/** roko refuses chat-started runs here: blocks new runs; its fix is an action with a preview. */
export const PROBLEM_BOUNDARY: Json = {
  id: 'workspace-refuses-chat-runs',
  severity: 'block',
  title: 'roko refuses runs started from Hermes in this workspace.',
  detail: 'Its roko.toml has no data-model boundary, so roko turns down every run a chat starts.',
  fix: { kind: 'action', label: 'make ready', action: 'workspace-chat-ready', command: 'hermes roko fix workspace-chat-ready', docs: 'troubleshooting.md#roko-refuses-runs-started-from-hermes' }
}

/** No API model for chat runs: worth fixing; its fix is a command to copy. */
export const PROBLEM_MODEL: Json = {
  id: 'no-tool-loop-model',
  severity: 'warn',
  title: 'No model a chat-started run can use.',
  detail: 'Chat runs need a model roko calls through an API; this workspace only has CLI agents.',
  fix: { kind: 'command', label: 'copy command', action: null, command: 'roko config models list', docs: null }
}

/** install_state.problems() when the files on disk are newer than the backend. */
export const PROBLEM_RESTART: Json = {
  id: 'restart-hermes',
  severity: 'warn',
  title: `roko ${NEWER_VERSION} is installed, but Hermes is still running ${PAGE_VERSION}.`,
  detail: 'Hermes loads plugins when it starts, so an update takes effect after a restart.',
  fix: { kind: 'restart-hermes', label: 'restart hermes', action: null, command: null, docs: 'updating.md#2-restart-what-you-use' },
  steps: {
    desktop: ['Quit Hermes with ⌘Q. Closing the window is not enough: the app keeps running.', 'Open Hermes again.'],
    dashboard: ['Stop `hermes dashboard` (Ctrl-C where it runs) and start it again.', 'Reload this page.'],
    terminal: ['Desktop app: quit Hermes with ⌘Q and open it again.']
  },
  parts: { backend: true, desktop_copy: false }
}

/**
 * What GET /setup/fix?action=workspace-chat-ready previews (readiness.fix_preview): a diff of roko.toml. As
 * plugin-setup has it since 18:20: `local` first and recommended, `boundary` ("screen with <model>") second.
 */
export function fixPreview(variant: string | null): Json {
  const local = variant !== 'boundary'

  return {
    ok: true,
    action: 'workspace-chat-ready',
    title: 'Make this workspace accept runs started from Hermes',
    variant: local ? 'local' : 'boundary',
    variants: [
      { id: 'local', label: 'run without the boundary (local use)', recommended: true, available: true, why: 'fine on your own machine, for your own requests' },
      { id: 'boundary', label: 'screen with glm-4-7', recommended: false, available: true, why: 'the mid rung of your model ladder, and its key is set' }
    ],
    preview: local
      ? '--- a/roko.toml\n+++ b/roko.toml\n@@ -40,2 +40,2 @@\n [serve.mcp]\n-allow_without_data_llm = false\n+allow_without_data_llm = true'
      : '--- a/roko.toml\n+++ b/roko.toml\n@@ -88,0 +89,4 @@\n+# Added by hermes roko fix workspace-chat-ready on 2026-10-15: roko\'s data-model boundary.\n+[agent.data_llm]\n+model = "glm-4-7"',
    path: '/work/ws/roko.toml',
    summary: local
      ? 'Lets runs started from Hermes run without roko\'s data-model boundary.'
      : 'Adds roko\'s data-model boundary: glm-4-7 screens what a run fetched before its agent reads it.',
    digest: local ? 'digest-local' : 'digest-boundary',
    note: 'A copy of roko.toml is kept next to it first. roko reads the change at once, with no restart. Commit roko.toml afterwards.'
  }
}

export function currentInstall(): Json {
  return {
    loaded_version: PAGE_VERSION,
    disk_version: PAGE_VERSION,
    desktop_copy_version: PAGE_VERSION,
    desktop_copy_stale: false,
    backend_stale: false,
    desktop_copy: '/home/.hermes/desktop-plugins/roko',
    desktop_copy_marker: true
  }
}

/** The run's loop events, as the card carries them (oldest first). */
export function activeLoops(): Json[] {
  const t = Date.now()

  return [
    { ring: 'L2', kind: 'wave', text: 'wave 1 open: T1, T2 in parallel', data: { wave: 1, tasks: ['T1', 'T2'] }, task_id: null, plan_id: 'add-tests', ts: t - 60_000, key: 'wave:0' },
    { ring: 'L1', kind: 'route', text: 'T1 attempt 1 → glm-5.1, picked by the model ladder (rung mid)', data: ROUTE_T1, task_id: 'T1', plan_id: 'add-tests', ts: t - 59_000, key: 'route:add-tests:T1:1:glm-5.1:ladder' },
    { ring: 'L1', kind: 'retry', text: 'T2 attempt 2 on glm-5.1', data: { attempt: 2, model: 'glm-5.1', provider: 'zai' }, task_id: 'T2', plan_id: 'add-tests', ts: t - 30_500, key: 'retry:add-tests:T2:2' },
    { ring: 'L1', kind: 'route', text: 'T2 attempt 2 → glm-5.1, picked by what roko learned (p 0.82; over gpt-5.4-mini 0.71)', data: ROUTE_T2, task_id: 'T2', plan_id: 'add-tests', ts: t - 30_000, key: 'route:add-tests:T2:2:glm-5.1:router' },
    { ring: 'L3', kind: 'knowledge', text: 'roko learned from T1: Lexer tests live in tests/lexer.rs · reinforced 1', data: { admission: 'full_admitted', entry_id: 'k-7', reinforced: 1, promoted: false }, task_id: 'T1', plan_id: 'add-tests', ts: t - 47_000, key: 'knowledge:k-7' },
    { ring: 'L0', kind: 'tool_held', text: 'T3 wants to call mail.send on mail: held for you', data: { effect_id: 'effect-1', tool: 'mail.send', server: 'mail', attempt: 1 }, task_id: 'T3', plan_id: 'add-tests', ts: t - 60_000, key: 'effect:effect-1' },
    { ring: 'L2', kind: 'hold', text: 'T2 waits for your sign-off (30 min)', data: { state: 'waiting', attempt: 2, rung: 6, timeout_secs: 1800 }, task_id: 'T2', plan_id: 'add-tests', ts: t - 20_000, key: 'hold:add-tests:T2:2' }
  ]
}

/** GET /loops: what roko reports for each ring. */
export function loopsAnswer(): Json {
  const recent = activeLoops().map(e => ({ ...e, run_id: RUN_ACTIVE }))
  const ring = (id: string) => recent.filter(e => e.ring === id).reverse()

  return {
    ok: true,
    rings: [
      { ring: 'L0', name: 'tool calls', clock: 'seconds', state: 'active', recent: ring('L0'), counts: { held: 1, withheld: 0 } },
      {
        ring: 'L1',
        name: 'attempts',
        clock: 'minutes',
        state: 'active',
        recent: ring('L1'),
        routes: [{ ts: iso(-30_000), task_id: 'T2', attempt_key: null, model: 'glm-5.1', provider: 'zai', stage: 'retry', reason: 'retry', source: 'router', p: 0.82, candidates: [], outcome: null, cost_usd: 0.01 }],
        retry_budgets: [{ rung: 'verify[0:test]', ema_pass_rate: 0.92, observations: 30, consecutive_passes: 4, suggested_max_retries: 1, should_skip: false }]
      },
      {
        ring: 'L2',
        name: 'the plan',
        clock: 'hours',
        state: 'active',
        recent: ring('L2'),
        diagnoses: [{ id: 'stall-watchdog:1', source: 'stall-watchdog', ts: iso(-3_600_000), severity: 'warn', subject: 'tally/T2', detail: 'agent silent: no progress for 180s', suggested_action: 'restart', intervention_taken: null }]
      },
      {
        ring: 'L3',
        name: 'learning',
        clock: 'days',
        state: 'active',
        recent: ring('L3'),
        models: [{ model: 'glm-5.1', tasks: 9, success_rate: 0.9, total_cost_usd: 0.09, avg_cost_usd: 0.01, total_tokens: 17456 }],
        thresholds: [{ rung: 'verify[0:test]', ema_pass_rate: 0.92, observations: 30, consecutive_passes: 4, suggested_max_retries: 1, should_skip: false }],
        knowledge: { total: 12, recent: [{ id: 'k-7', text: 'Lexer tests live in tests/lexer.rs', kind: 'insight', confidence: 0.7, citations: 2 }] },
        playbooks: { total: 4 }
      },
      {
        ring: 'L4',
        name: 'audit',
        clock: 'weeks',
        state: 'quiet',
        recent: [],
        loops: [{ loop_id: 'L-route', lifecycle: 'active', state: 'healthy', reason: null, h: 0.1, n_opp: 40, eps: 0.04, iota_net: 0.2, beta: 0.9 }]
      }
    ],
    live: { running: true, hub: 'open', subscribers: 1 },
    problems: [],
    checked_at: iso(0)
  }
}

// -- 0.7: projects and their roko serves (BRIEF §C; plugin-core's serve.py, projects.py, fixes.py, ui_api.py) -----

/** The default project (the 0.6 workspace) and a second one. */
export const PROJECT_WS = '/work/ws'
export const PROJECT_SYNTH = '/work/pocket-synth'

const nameOf = (project: string) => String(project.split('/').pop())

/**
 * A ServeState as serve.py words it, with the keys it allows in that state. `outdated` is a running serve without
 * /mcp (`no_mcp`); one whose binary cannot start a serve (`too_old`) passes `url: null` and no actions.
 */
export function serveState(project: string, state: string, extra: Json = {}): Json {
  const up = state === 'running' || state === 'outdated'

  return {
    project,
    name: nameOf(project),
    state,
    url: up ? 'http://127.0.0.1:6912' : null,
    pid: up ? 4242 : null,
    version: up ? '0.1.0' : null,
    git_sha: up ? 'e31f4d52c' : null,
    started_by: up ? 'hermes' : null,
    since: state === 'stopped' ? null : iso(-5_000),
    idle_exit_minutes: 60,
    error: null,
    log_tail: null,
    actions: state === 'running' ? ['restart', 'stop'] : state === 'stopped' || state === 'failed' ? ['start'] : state === 'outdated' ? ['restart'] : [],
    busy: null,
    ...extra
  }
}

/** A ServeState's `error` in serve.py's words (its message, and its hint: the person's next step). */
export function serveError(code: string, project: string = PROJECT_WS): Json {
  const name = nameOf(project)
  const words: Record<string, [string, string]> = {
    start_failed: ['roko serve exited before it answered (exit code 1)', `the log's last lines say why; \`roko serve --workdir ${project}\` in a terminal shows the whole error`],
    // roko's own words for a serve with no LLM provider (roko serve --detach: not_initialized), and the plugin's hint.
    not_initialized: [`${project} is not set up for roko: no LLM provider configured. Run \`roko init\` there, or put a provider's API key in ~/.roko/.env`, `give roko a model key: a line such as OPENAI_API_KEY=… in ~/.roko/.env, or run \`hermes roko init --workdir ${project}\`, which offers the key Hermes has`],
    no_mcp: [`roko serve for ${name} runs a roko from before its /mcp endpoint, which Hermes needs`, 'update roko, then restart roko serve (Restart on the roko page)'],
    too_old: ['the roko at /usr/local/bin/roko is from before `roko serve --detach`, so Hermes cannot start roko serve with it', 'update roko: in your roko clone, `git pull && cargo install --path crates/roko-cli`'],
    not_found: ['roko is not installed on this machine', "install roko: in a clone of roko's repository, `cargo install --path crates/roko-cli` (Rust 1.91 or later); or set the plugin's roko_bin setting to a roko binary"]
  }
  const [message, hint] = words[code]

  return { code, message, hint }
}

/** A serve whose start failed for want of a model key: roko's `not_initialized` (no LLM provider; round 1). */
export function noProvider(project: string): Json {
  return serveState(project, 'failed', { error: serveError('not_initialized', project), log_tail: ['error: no LLM provider configured.', 'roko serve: exiting (2)'] })
}

const FORBIDDEN = { code: 'forbidden', message: 'actions from the Hermes UI are turned off for roko', hint: 'set plugins.entries.roko.settings.ui_actions: true to allow them' }

/** A Project as GET /projects lists it (its `serve` is filled in from the backend's serves). */
export function projectRow(path: string, extra: Json = {}): Json {
  return { path, name: nameOf(path), default: path === PROJECT_WS, last_used: iso(-60_000), ready: true, needs_setup: false, ...extra }
}

export class FakeBackend {
  mounted = true
  /** 0.7: the projects this Hermes knows; null is a backend from before projects (no /serve, no /projects). */
  projects: Json[] | null = null
  /** 0.7: each project's serve, by path (a project without one has a running serve). */
  serves: Record<string, Json> = {}
  /** POST /serve and POST /projects bodies, in order. */
  servePosts: Json[] = []
  projectPosts: Json[] = []
  /** Runs a restart or stop would stop: POST /serve (and restart-serve) without `force` answer conflict while above 0. */
  serveBusy = 0
  /** 0.7: the plugin's `url` names a roko serve elsewhere and no `workdir`: no project, and a `remote` serve. */
  remoteUrl: string | null = null
  reachable = true
  /** P-3: roko's whole-workspace spend today (`spend.roko_today_usd`); null without a shared workdir. */
  rokoTodayUsd: number | null = null
  /** roko still lists an answered item for a moment (it settles the answer a little later). */
  listsAnswered = false
  /** What GET /loops answers instead of `loopsAnswer()`, when a test sets it. */
  loops: Json | null = null
  /** What GET /build answers (round v7, #3); null is a project with no phases. */
  build: Json | null = null
  /** Plans roko would not run yet: plan id → its `validation` (a PlanValidation). */
  validation: Record<string, Json> = {}
  /** POST /plans/{id}/run finds the plan fails roko's validator (it read valid before): plan id → the PlanValidation. */
  refuseRunFor: Record<string, Json> = {}
  /** P-14: a plan whose last run stopped part way (plan id → its `resumable_run`): a run saying neither resume nor fresh is refused. */
  resumableFor: Record<string, Json> = {}
  /** The overview's rows do not carry `budget_stop` yet (they learn it a refresh after the card does). */
  rowsWithoutBudgetStop = false
  /** A run's whole timeline, when a test gives one (GET /runs/{id}/events answers it once, then nothing newer). */
  eventsFor: Record<string, Json[]> = {}
  /** A long run's timeline, paged as the backend pages it (round v7): `tail`, `cursor` forward, `before` back. */
  eventsLong: Record<string, Json[]> = {}
  /** How many `?tail=` asks of a long run answer `reading` first (the backend still reading its index, round v7). */
  eventsReading: Record<string, number> = {}
  /** RUN_DONE's `delivered.workspace`, as the backend's boundary writes it (home-relative since 0.8.0). */
  doneWorkspace = '/work/ws'
  /** The overview's `ladder` (0.6.0): the workspace's model ladder, cheapest first, when a test gives one. */
  ladder: Json[] | null = null
  /** connection.error.hint while roko is down; an older backend (or no workdir) names `--workdir WORKSPACE`. */
  unreachableHint = 'Start it with `roko serve`.'
  connectionStatus = 'ok'
  /** permissions.write: false makes the UI read-only (ui_actions: false). */
  canWrite = true
  // P-7: whether this roko caps a plan writing (roko 55d0acda8).
  planWritingCap = false
  runs: Json[] = runRows()
  pending: Json[] = [pendingConfirm(), pendingEffect()]
  /** Per-path error overrides: path -> {code, message, hint}. */
  failures = new Map<string, Json>()
  calls: ApiRequest[] = []
  /** What GET /runs/{id}/merge answers for RUN_DONE; merged once POST /merge succeeds. */
  mergeCheck: Json = defaultMergeCheck()
  /** The bodies POST /runs/{id}/merge got. */
  mergePosts: Json[] = []
  merged = false
  /** The merge itself is refused as if the branch moved after the review. */
  mergeConflict = false
  /** The diff route has nothing (as a local-git diff does once the work is merged). */
  diffGone = false
  /** What is left of today's limit: the New run knob's ceiling is the lower of this and the per-run cap. */
  leftUsd = 8.58
  /** T2 works (tool steps and words on the card) instead of waiting on a sign-off. */
  liveSteps = false
  /** The backend's version (`plugin_version`). */
  pluginVersion = PAGE_VERSION
  /** install_state.status(); null is a backend from before setup existed: no `install`, no `setup`, no /setup routes. */
  install: Json | null = currentInstall()
  /** What `setup.problems` lists on /overview and /health. */
  problems: Json[] = []
  /** The overview carries `install` (else the pages ask /health for it). */
  installOnOverview = true
  /** GET /plans: the person's plans, then roko's demos (roko's `group`, or a plan still marked `fixture`). */
  plans: Json[] = planRows()
  /** POST /runs and /plans/{id}/run refuse, naming this problem. */
  refuseWith: Json | null = null
  /** /setup/fix is missing although the overview has `setup` (a half-updated backend). */
  fixRouteMissing = false
  /** POST /setup/fix bodies, in order. */
  applied: Json[] = []
  /** What is left after the fix (`next`), or null. */
  fixNext: string | null = null
  /** GET /insights answers as a 0.5.0 backend (scope, summary, gate kinds). */
  insightsScoped = false
  /** GET /learning (0.6.0 P6); null answers 404, as an older backend. */
  learning: Json | null = null
  /** GET /plans/{id} extras (0.6.0 P8), by plan id: `doc`, `rubric`, `estimate`, and per task id its fields. */
  planExtra: Record<string, Json> = {}
  /** GET /runs/{id}/artifacts by run id, and GET /runs/{id}/artifact by path (0.8.0, #7). */
  artifacts: Record<string, Json> = {}
  artifactFiles: Record<string, Json> = {}
  /** Files the finished run's diff adds after its usual three (phase 4 prep B). */
  diffExtra: Json[] = []
  /** GET /estimate (0.6.0 P7); null answers 404, as an older backend. */
  estimate: Json | null = null
  /** RUN_DONE's T1: what its agent said, and what roko did with its lesson (knowledge_written rows). */
  doneNote: string | null = null
  doneLessons: Json[] | null = null
  /** What GET /runs/{id}/merge answers once the commit-roko-toml fix ran. */
  afterCommit: Json = {}
  /** POST /setup/fix's `ready`: roko accepts runs started from Hermes after the fix. */
  fixReady = true
  /** The next POST /setup/fix finds roko.toml changed since the preview. */
  fixConflict = false
  /** setup-project's preview carries its summary (false: a backend that sends none). */
  setupSummary = true

  reset(): void {
    this.mounted = true
    this.build = null
    this.projects = null
    this.serves = {}
    this.servePosts = []
    this.projectPosts = []
    this.serveBusy = 0
    this.remoteUrl = null
    this.reachable = true
    this.rokoTodayUsd = null
    this.listsAnswered = false
    this.loops = null
    this.validation = {}
    this.refuseRunFor = {}
    this.resumableFor = {}
    this.rowsWithoutBudgetStop = false
    this.eventsFor = {}
    this.eventsLong = {}
    this.eventsReading = {}
    this.doneWorkspace = '/work/ws'
    this.ladder = null
    this.unreachableHint = 'Start it with `roko serve`.'
    this.connectionStatus = 'ok'
    this.canWrite = true
    this.planWritingCap = false
    this.runs = runRows()
    this.plans = planRows()
    this.pending = [pendingConfirm(), pendingEffect()]
    this.failures.clear()
    this.calls = []
    this.mergeCheck = defaultMergeCheck()
    this.mergePosts = []
    this.merged = false
    this.mergeConflict = false
    this.diffGone = false
    this.leftUsd = 8.58
    this.liveSteps = false
    this.pluginVersion = PAGE_VERSION
    this.install = currentInstall()
    this.problems = []
    this.installOnOverview = true
    this.refuseWith = null
    this.fixRouteMissing = false
    this.applied = []
    this.fixNext = null
    this.fixReady = true
    this.afterCommit = {}
    this.doneNote = null
    this.doneLessons = null
    this.insightsScoped = false
    this.learning = null
    this.planExtra = {}
    this.artifacts = {}
    this.artifactFiles = {}
    this.diffExtra = []
    this.estimate = null
    this.fixConflict = false
    this.setupSummary = true
  }

  /** `setup` as the overview and /health carry it, with (0.7) why the asked project's serve does not answer; nothing on an old backend. */
  private setup(url?: URL): Json {
    const own = url ? this.serveProblem(url) : null
    const problems = own ? [own, ...this.problems] : this.problems

    return this.install ? { setup: { ok: !problems.some(p => p.severity === 'block'), problems } } : {}
  }

  /** 0.7: readiness.not_running's row for the asked project, while its serve does not answer (none with no project yet). */
  private serveProblem(url: URL, body: Json = {}): Json | null {
    if (!this.projects) {
      return null
    }

    if (!this.projects.length) {
      return this.remoteUrl
        ? null
        : {
            id: 'roko-unreachable',
            severity: 'block',
            title: 'No project is chosen for roko yet.',
            detail: "Hermes starts a roko serve for each project roko works in. Pick your project's folder on the roko page (Choose folder…), or run `hermes roko init` in it.",
            fix: { kind: 'command', label: 'set up a project', action: null, command: 'hermes roko init', docs: 'getting-started.md#set-roko-up-in-a-project' }
          }
    }

    const path = this.projectPath(url, body)
    const serve = this.serveFor(path)
    const name = nameOf(path)
    const error = (serve.error ?? {}) as Json
    // A checkout without roko.toml (its row's `needs_setup`): roko serve may run there on roko's defaults, but it
    // refuses runs started from Hermes (readiness.needs_setup).
    const noToml = Boolean(this.projects.find(p => p.path === path)?.needs_setup)
    const needsSetup = {
      id: 'project-needs-setup',
      severity: 'block',
      title: `roko isn't set up for runs from Hermes in ${name}.`,
      detail: `${path} has no roko.toml, so roko refuses runs started from Hermes there and knows none of the project's checks. Setting roko up runs \`roko init\` and lets roko accept runs started from Hermes; nothing is committed.`,
      fix: { kind: 'action', label: 'set up roko here', action: 'setup-project', command: `hermes roko init --workdir ${path}`, docs: 'getting-started.md#set-roko-up-in-a-project', project: path }
    }

    if (serve.state === 'remote') {
      return null
    }

    if (this.answers(path)) {
      return noToml ? needsSetup : null
    }

    if (serve.state === 'not_found') {
      return {
        id: 'roko-not-found',
        severity: 'block',
        title: 'roko is not installed on this machine.',
        detail: `Hermes starts roko serve for ${name} by itself, but it needs the roko command: install it (in a clone of roko's repository, \`cargo install --path crates/roko-cli\`), or set the plugin's roko_bin setting to a roko binary.`,
        fix: { kind: 'docs', label: 'install roko', action: null, command: 'cargo install --path crates/roko-cli', docs: 'getting-started.md#install-roko' }
      }
    }

    if (serve.state === 'outdated') {
      return {
        id: 'roko-too-old',
        severity: 'block',
        title: 'roko is too old to start roko serve in the background.',
        detail: `The roko at /usr/local/bin/roko is from before \`roko serve --detach\`, so Hermes cannot start roko serve for ${name}. Update roko: in your roko clone, \`git pull && cargo install --path crates/roko-cli\`.`,
        fix: { kind: 'command', label: 'update roko', action: null, command: 'git pull && cargo install --path crates/roko-cli', docs: 'troubleshooting.md#roko-is-too-old-to-start-roko-serve' }
      }
    }

    if (serve.state === 'failed' && error.code === 'not_initialized') {
      return {
        id: 'no-model-provider',
        severity: 'block',
        title: `roko has no model provider for ${name}, so its roko serve did not start.`,
        detail: 'roko serve needs a model it can call: a key in ~/.roko/.env (OpenAI, Anthropic, OpenRouter, …), or a roko.toml that names a provider. `hermes roko init` in the project offers the key Hermes has.',
        fix: { kind: 'command', label: 'give roko a model key', action: null, command: `hermes roko init --workdir ${path}`, docs: 'troubleshooting.md#roko-has-no-model-provider', project: path }
      }
    }

    if (noToml) {
      return needsSetup
    }

    const start = { kind: 'action', label: 'start roko serve', action: 'start-serve', command: `hermes roko serve start --project ${path}`, docs: 'troubleshooting.md#roko-serve-is-not-reachable', project: path }

    if (serve.state === 'failed') {
      const hint = String(error.hint)

      return { id: 'roko-unreachable', severity: 'block', title: `roko serve did not start for ${name}.`, detail: `${String(error.message)}. ${hint.charAt(0).toUpperCase()}${hint.slice(1)}.`, fix: start }
    }

    return {
      id: 'roko-unreachable',
      severity: 'block',
      title: serve.state === 'starting' ? `roko serve is starting for ${name}.` : `roko serve is not running for ${name}.`,
      detail:
        serve.state === 'starting'
          ? 'Hermes started it a moment ago; this clears once it answers.'
          : 'Nothing roko does works from Hermes until roko serve runs. Hermes starts it in the background, and it keeps running after Hermes quits until it has had no work for a while.',
      fix: start
    }
  }

  private refusal(): Json | null {
    const problem = this.refuseWith

    return problem ? { ok: false, error: { code: 'refused', message: String(problem.title), hint: '' }, problem } : null
  }

  /** 0.7: the project a request is about: its `?project=` (or body `project`), else the default. */
  private projectPath(url: URL, body: Json = {}): string {
    const asked = url.searchParams.get('project') ?? (typeof body.project === 'string' ? body.project : null)
    const all = this.projects ?? []

    return String((all.find(p => p.path === asked) ?? all.find(p => p.default === true) ?? all[0] ?? { path: PROJECT_WS }).path)
  }

  private serveFor(path: string): Json {
    return this.serves[path] ?? serveState(path, 'running')
  }

  private projectList(): Json[] {
    return (this.projects ?? []).map(p => ({ ...p, serve: this.serveFor(String(p.path)) }))
  }

  /** The default project's path (the first project added becomes it), or null with none. */
  private defaultPath(): string | null {
    const all = this.projects ?? []

    return all.length ? String((all.find(p => p.default === true) ?? all[0]).path) : null
  }

  /** A project's serve answers: it runs (an outdated one runs too, without /mcp). */
  private answers(path: string): boolean {
    const serve = this.serveFor(path)

    return this.reachable && (serve.state === 'running' || (serve.state === 'outdated' && Boolean(serve.url)))
  }

  /** roko answers for this request's project: the backend reaches it, and its serve runs (or is old, or elsewhere). */
  private up(url: URL, body: Json = {}): boolean {
    if (this.projects && !this.projects.length) {
      return this.reachable && Boolean(this.remoteUrl)
    }

    if (!this.projects) {
      return this.reachable
    }

    const path = this.projectPath(url, body)

    return this.answers(path) || (this.reachable && this.serveFor(path).state === 'remote')
  }

  /** A waiting item's project: the one it names, else its run's; the default project's for a run it does not list. */
  private itemProject(item: Json): string {
    const own = (item.project ?? this.runs.find(row => row.run_id === item.run_id)?.project) as Json | null | undefined

    return own && typeof own === 'object' ? String(own.path) : (this.defaultPath() ?? PROJECT_WS)
  }

  /**
   * What waits on the person (views.collect_pending, round 1): in every project whose serve answers, whichever project
   * is shown, each item with the project whose serve holds it.
   */
  private waiting(): Json[] {
    return this.pending
      .filter(item => this.answers(this.itemProject(item)))
      .map(item => {
        const path = this.itemProject(item)

        return { ...item, project: { path, name: nameOf(path) } }
      })
  }

  /** `{path, name}` of the project a start is for (views.project_ref), from 0.7 on. */
  private projectRef(url: URL, body: Json): Json {
    if (!this.projects?.length) {
      return {}
    }

    const path = this.projectPath(url, body)

    return { project: { path, name: nameOf(path) } }
  }

  /**
   * What serve.py does to a project's serve (POST /serve, and the start-serve and restart-serve fixes): ensure starts a
   * stopped one (a failed start waits a minute), start starts a stopped or failed one, restart starts one that does not
   * run, and a restart or stop of a busy one wants `force`.
   */
  private serveChange(path: string, action: string, force: boolean): Json {
    const now = this.serveFor(path)
    const runs = now.state === 'running' || (now.state === 'outdated' && Boolean(now.url))

    if (action === 'ensure' || action === 'start' || (action === 'restart' && !runs)) {
      if (now.state === 'stopped' || (now.state === 'failed' && action !== 'ensure')) {
        this.serves[path] = serveState(path, 'starting')
      }

      return { ok: true, serve: this.serveFor(path) }
    }

    if (!runs) {
      return { ok: true, serve: now }
    }

    if (this.serveBusy > 0 && !force) {
      const n = this.serveBusy

      return {
        ok: false,
        error: { code: 'conflict', message: `${n} run${n === 1 ? ' is' : 's are'} going in ${String(now.name)}; ${action === 'stop' ? 'stopping' : 'restarting'} roko serve stops them.`, hint: 'wait for them to end, or confirm to stop them (their work so far is kept)' },
        serve: { ...now, busy: { active_runs: n } }
      }
    }

    this.serves[path] = serveState(path, action === 'stop' ? 'stopped' : 'starting')

    return { ok: true, serve: this.serves[path] }
  }

  /**
   * 0.7: a start (POST /runs, a plan's run) starts the project's stopped serve first and waits for it (ui_api.running_in);
   * where it cannot run, the refusal names the setup problem and carries the serve.
   */
  private startServeFor(url: URL, body: Json): Json | null {
    if (!this.projects?.length) {
      return null
    }

    const path = this.projectPath(url, body)
    const serve = this.serveFor(path)
    const error = (serve.error ?? {}) as Json

    if (error.code === 'not_initialized') {
      return { ok: false, error: { code: 'unreachable', message: `roko serve did not start for ${nameOf(path)}: ${String(error.message)}`, hint: String(error.hint) }, problem: this.serveProblem(url, body), serve }
    }

    if (serve.state === 'stopped' || serve.state === 'failed') {
      this.serves[path] = serveState(path, 'running')
    }

    return null
  }

  setRunState(runId: string, state: string): void {
    this.runs = this.runs.map(row => (row.run_id === runId ? { ...row, state } : row))
  }

  addPending(item: Json): void {
    this.pending = [...this.pending, item]
  }

  /** Paths (with query) the UI asked for, newest last. */
  paths(): string[] {
    return this.calls.map(call => `${call.method ?? 'GET'} ${call.path}`)
  }

  handle = async (req: ApiRequest): Promise<unknown> => {
    this.calls.push(req)

    const prefix = '/api/plugins/roko'

    if (!this.mounted || !req.path.startsWith(prefix)) {
      throw new Error('404: {"detail":"Not Found"}')
    }

    const url = new URL(req.path.slice(prefix.length) || '/', 'http://roko.test')
    const method = (req.method ?? 'GET').toUpperCase()
    const route = `${method} ${url.pathname}`
    const failure = this.failures.get(url.pathname)

    if (failure) {
      return { ok: false, error: failure }
    }

    const body = (req.body ?? {}) as Json
    const fix = url.searchParams.get('action') ?? body.action
    // 0.7: starting, stopping and setting up need no roko serve; a backend from before projects has none of it.
    const own = route === 'POST /serve' || url.pathname === '/projects' || (url.pathname === '/setup/fix' && ['setup-project', 'start-serve', 'restart-serve'].includes(String(fix)))

    if (own && !this.projects) {
      throw new Error('404: {"detail":"Not Found"}')
    }

    // 0.7: a project Hermes does not know is refused (ui_api.scoped). /health reads files only, and /pending asks every
    // serve that runs (round 1), so both answer while the shown project's serve is down.
    const asked = url.searchParams.get('project') ?? (typeof body.project === 'string' ? body.project : null)

    if (this.projects && asked && !this.projects.some(p => p.path === asked)) {
      return { ok: false, error: { code: 'invalid', message: `${asked} is not a project Hermes knows`, hint: 'add it first (Choose folder… on the roko page)' } }
    }

    if ((route === 'POST /runs' || (route.startsWith('POST /plans/') && url.pathname.endsWith('/run'))) && this.canWrite) {
      const refused = this.startServeFor(url, body)

      if (refused) {
        return refused
      }
    }

    if (!own && !this.up(url, body) && url.pathname !== '/overview' && !(this.projects && (route === 'GET /health' || route === 'GET /pending'))) {
      return {
        ok: false,
        error: { code: 'unreachable', message: 'roko serve is not answering at http://127.0.0.1:6677', hint: this.unreachableHint }
      }
    }

    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    if (route === 'GET /overview') {
      return this.overview(url)
    }

    if (route === 'POST /serve') {
      this.servePosts.push(body)

      const action = String(body.action)

      if (!['ensure', 'start', 'restart', 'stop'].includes(action)) {
        return { ok: false, error: { code: 'invalid', message: 'action must be one of ensure, start, restart, stop', hint: '' } }
      }

      if (action !== 'ensure' && !this.canWrite) {
        return { ok: false, error: FORBIDDEN }
      }

      const path = this.projectPath(url, body)

      if (!this.projects!.length) {
        return { ok: false, error: { code: 'invalid', message: 'no project is chosen', hint: 'pick a project on the roko page' } }
      }

      if (this.serveFor(path).state === 'remote') {
        return { ok: false, error: { code: 'forbidden', message: 'roko serve at https://roko.example.net is not on this machine, so the plugin starts and stops nothing there', hint: 'manage that roko serve where it runs' } }
      }

      return this.serveChange(path, action, body.force === true)
    }

    if (route === 'GET /projects') {
      return { ok: true, default: this.defaultPath(), projects: this.projectList() }
    }

    if (route === 'POST /projects') {
      this.projectPosts.push(body)

      if (!this.canWrite) {
        return { ok: false, error: FORBIDDEN }
      }

      const path = String(body.path ?? '').trim()

      if (!['add', 'remove', 'set_default'].includes(String(body.action))) {
        return { ok: false, error: { code: 'invalid', message: 'action must be add, remove or set_default', hint: '' } }
      }

      if (!path) {
        return { ok: false, error: { code: 'invalid', message: "name the project's folder (path)", hint: '' } }
      }

      if (body.action === 'remove') {
        this.projects = this.projects!.filter(p => p.path !== path)

        if (!this.projects.some(p => p.default === true) && this.projects.length) {
          this.projects[0] = { ...this.projects[0], default: true }
        }

        return { ok: true, default: this.defaultPath(), projects: this.projectList() }
      }

      if (!path.startsWith('/work/')) {
        return { ok: false, error: { code: 'invalid', message: `${path} is not a git checkout, and roko works on branches of one`, hint: `make it one first: git -C '${path}' init, then commit what you have` } }
      }

      // The checkout's top folder, as `git rev-parse --show-toplevel` names it.
      const top = path.replace(/^(\/work\/[^/]+).*$/, '$1')

      if (!this.projects!.some(p => p.path === top)) {
        // The first project this Hermes knows is its default; a checkout without roko.toml needs setting up, while its
        // roko serve runs on roko's defaults (round 1: roko has a provider here).
        const first = !this.projects!.length

        this.projects!.push(projectRow(top, first ? { default: true, last_used: null } : { default: false, needs_setup: true, ready: false, last_used: null }))
        this.serves[top] = serveState(top, 'running')
      }

      if (body.action === 'set_default') {
        this.projects = this.projects!.map(p => ({ ...p, default: p.path === top }))
      }

      // `add` names the project it added (round-1 amendment 6).
      return { ok: true, default: this.defaultPath(), projects: this.projectList(), ...(body.action === 'add' ? { project: this.projectList().find(p => p.path === top) } : {}) }
    }

    if (route === 'GET /loops') {
      return this.loops ?? loopsAnswer()
    }

    if (route === 'GET /build') {
      return { ok: true, ...(this.build ?? { phases: [], totals: { phases: 0 }, receipt: null, next: null, reachable: true }) }
    }

    if (route === 'GET /pending') {
      // 0.7: what waits in every project whose serve answers (views.collect_pending), each item with its project.
      return { ok: true, items: this.projects ? this.waiting() : this.pending }
    }

    if (route === 'POST /decide') {
      const item = this.pending.find(p => p.code === body.code || p.decision_id === body.decision_id)

      if (!item) {
        return { ok: false, error: { code: 'not_found', message: `No waiting item ${String(body.code)}.`, hint: 'It may have been answered already.' } }
      }

      // roko settles an answer a moment later; until then it still lists the item.
      if (!this.listsAnswered) {
        this.pending = this.pending.filter(p => p !== item)
      }

      return {
        ok: true,
        decision_id: item.decision_id,
        approved: body.approve === true,
        outcome: body.approve === true ? 'applied' : 'rejected',
        title: item.title
      }
    }

    if (segments[0] === 'runs' && segments.length === 2 && method === 'GET') {
      return this.run(segments[1])
    }

    if (segments[0] === 'runs' && segments[2] === 'events' && method === 'GET') {
      const long = this.eventsLong[segments[1]]

      if (long) {
        return this.longEvents(segments[1], long, url.searchParams)
      }

      return this.events(segments[1], url.searchParams.get('cursor'))
    }

    if (segments[0] === 'runs' && segments[2] === 'artifacts' && method === 'GET') {
      return this.artifacts[segments[1]] ?? { ok: true, commit: null, items: [] }
    }

    if (segments[0] === 'runs' && segments[2] === 'artifact' && method === 'GET') {
      const file = this.artifactFiles[String(url.searchParams.get('path'))]

      return file ?? { ok: false, error: { code: 'not_found', message: 'not an image or a sound this run made', hint: '' } }
    }

    if (segments[0] === 'runs' && segments[2] === 'diff' && method === 'GET') {
      return this.diff(segments[1])
    }

    if (segments[0] === 'runs' && segments[2] === 'merge' && method === 'GET') {
      return { ok: true, merge: this.merged ? { ...this.mergeCheck, merged: true, can_merge: false } : { ...this.mergeCheck, run_id: segments[1] } }
    }

    if (segments[0] === 'runs' && segments[2] === 'merge' && method === 'POST') {
      if (!this.canWrite) {
        return { ok: false, error: { code: 'forbidden', message: 'actions from the Hermes UI are turned off for roko', hint: '' } }
      }

      this.mergePosts.push(body)

      if ((this.mergeCheck.available ?? this.mergeCheck.can_merge) !== true) {
        return { ok: false, error: { code: 'refused', message: String(this.mergeCheck.reason), hint: `merge it in a terminal: ${String(this.mergeCheck.command)}` } }
      }

      if (this.mergeConflict || (body.commit !== undefined && !DONE_COMMIT.startsWith(String(body.commit)))) {
        return { ok: false, error: { code: 'conflict', message: "the run's branch moved since you reviewed it, so nothing was merged", hint: 'review the changes again, then merge' } }
      }

      this.merged = true

      return {
        ok: true,
        merge: {
          run_id: segments[1],
          merged: true,
          already: false,
          mode: 'fast-forward',
          into: 'main',
          branch: `roko/batch/${RUN_DONE}`,
          commit: DONE_COMMIT.slice(0, 12),
          previous_head: '3cfff55c8a68',
          head: DONE_COMMIT.slice(0, 12),
          undo_command: 'git -C /work/ws reset --keep 3cfff55c8a68aa'
        }
      }
    }

    if (route === 'POST /runs') {
      if (this.refusal()) {
        return this.refusal()
      }

      if (!this.canWrite) {
        return { ok: false, error: { code: 'forbidden', message: 'actions from the Hermes UI are turned off for roko', hint: '' } }
      }

      // P-6: a plan from a spec file, which roko reads itself, needs no request.
      if ((typeof body.prompt !== 'string' || !body.prompt.trim()) && !(body.plan === true && typeof body.spec_path === 'string')) {
        return { ok: false, error: { code: 'invalid', message: 'say what roko should do', hint: '' } }
      }

      if (body.plan === true) {
        this.runs = [
          { run_id: RUN_PLANGEN, kind: 'plan_generate', label: String(body.title ?? body.prompt ?? body.spec_path), plan_id: 'add-tests', state: 'running', cost_usd: null, max_usd: null, started_at: iso(0), source: 'ui', ...this.projectRef(url, body) },
          ...this.runs
        ]

        return { ok: true, run_id: RUN_PLANGEN, kind: 'plan_generate', plan_id: 'add-tests', state: 'running', ...this.projectRef(url, body) }
      }

      const cap = body.max_usd

      if (typeof cap !== 'number' || cap < 0.01 || cap > 5) {
        return { ok: false, error: { code: 'invalid', message: 'max_usd must be between $0.01 and $5.00.', hint: 'Pick a smaller cap.' } }
      }

      this.runs = [
        { run_id: RUN_NEW, kind: 'run', label: String(body.title ?? body.prompt), state: 'running', cost_usd: 0, max_usd: cap, started_at: iso(0), source: 'ui', ...this.projectRef(url, body) },
        ...this.runs
      ]

      return { ok: true, run_id: RUN_NEW, kind: 'run', state: 'running', max_usd: cap, ...this.projectRef(url, body) }
    }

    if (segments[0] === 'runs' && segments[2] === 'cancel' && method === 'POST') {
      this.setRunState(segments[1], 'cancelled')

      return { ok: true, run_id: segments[1], state: 'cancelled' }
    }

    if (route === 'GET /plans') {
      return { ok: true, plans: this.plans, total: this.plans.length }
    }

    if (segments[0] === 'plans' && segments.length === 2 && method === 'GET') {
      let answer = this.plan(segments[1])
      const extra = this.planExtra[segments[1]]

      if (extra && answer.ok) {
        const plan = answer.plan as Json
        const perTask = (extra.tasks ?? {}) as Record<string, Json>

        answer = { ...answer, plan: { ...plan, ...extra, tasks: (plan.tasks as Json[]).map(task => ({ ...task, ...(perTask[String(task.id)] ?? {}) })) } }
      }

      const validation = this.validation[segments[1]]

      if (!validation || !answer.ok) {
        return answer
      }

      // A plan roko would not run yet (0.5.0 `validation`), when a test names one; its tasks carry their own questions.
      const plan = answer.plan as Json
      const asked = (validation.open_questions as Json[]) ?? []
      const tasks = (plan.tasks as Json[]).map(task => {
        const own = asked.filter(q => q.task_id === task.id)

        return own.length ? { ...task, open_questions: own } : task
      })

      return { ...answer, plan: { ...plan, tasks, validation } }
    }

    if (segments[0] === 'plans' && segments[2] === 'run' && method === 'POST') {
      if (this.refusal()) {
        return this.refusal()
      }

      const invalid = this.refuseRunFor[segments[1]]

      if (invalid) {
        // From now on the plan's own detail says so too, as roko's validator does.
        this.validation[segments[1]] = invalid

        return {
          ok: false,
          error: {
            code: 'refused',
            message: `roko will not run plan ${segments[1]}: ${String(invalid.summary)}`,
            hint: "answer the plan's open questions in its tasks.toml, then run it again"
          },
          validation: invalid
        }
      }

      const stopped = this.resumableFor[segments[1]]

      if (stopped && body.resume !== true && body.fresh !== true) {
        return {
          ok: false,
          error: {
            code: 'refused',
            message: `Plan '${segments[1]}' has a run that can be resumed: ${String(stopped.run_id).slice(0, 8)} (${String(stopped.status)}) passed T1, and T2 is left. Pass resume=true to continue it, so only T2 runs, or fresh=true to start over and set its progress aside.`,
            hint: 'continue it, so only what is left runs, or start the plan over and set its progress aside'
          },
          resumable_run: stopped
        }
      }

      const cap = body.max_usd

      if (typeof cap !== 'number' || cap < 0.01 || cap > 5) {
        return { ok: false, error: { code: 'invalid', message: 'max_usd must be between $0.01 and $5.00.', hint: 'Pick a smaller cap.' } }
      }

      this.runs = [
        { run_id: RUN_NEW, kind: 'plan', label: segments[1], plan_id: segments[1], state: 'running', cost_usd: 0, max_usd: cap, started_at: iso(0), ...this.projectRef(url, body) },
        ...this.runs
      ]

      return { ok: true, run_id: RUN_NEW, state: 'running', queue_position: null, ...this.projectRef(url, body) }
    }

    if (route === 'GET /knowledge') {
      const q = url.searchParams.get('q') ?? ''

      return {
        ok: true,
        query: q,
        entries: q.toLowerCase().includes('parser')
          ? [
              { id: 'k-1', content: 'The parser rejects trailing commas; T3 needed a fix.', kind: 'insight', tier: 'working', score: 3.97, confidence: 0.7 },
              { id: 'k-2', content: 'Run `cargo test -p parser` before the gate.', kind: 'pattern', tier: 'stable', score: 2.1, confidence: 0.9 }
            ]
          : []
      }
    }

    if ((route === 'GET /setup/fix' || route === 'POST /setup/fix') && (!this.install || this.fixRouteMissing)) {
      throw new Error('404: {"detail":"Not Found"}')
    }

    if (route === 'GET /setup/fix') {
      const action = url.searchParams.get('action')

      if (action === 'setup-project' || action === 'start-serve' || action === 'restart-serve') {
        // 0.7 (fixes.preview): a summary of what it does, no diff; the path is the project's.
        const project = this.projectPath(url)
        const name = nameOf(project)
        const busy = this.serveBusy

        return {
          ok: true,
          action,
          title: action === 'setup-project' ? `Set up roko in ${name}` : `${action === 'start-serve' ? 'Start' : 'Restart'} roko serve for ${name}`,
          variant: null,
          variants: [],
          preview: '',
          path: project,
          summary:
            action === 'setup-project'
              ? !this.setupSummary
                ? ''
                : `Runs \`roko init\` in ${project}: it writes roko.toml (the project's checks and its model ladder) and roko's \`.roko/\` folder. Then it lets roko accept runs started from Hermes there (roko's own \`config preset chat-host\`, or [serve.mcp] allow_without_data_llm = true on an older roko), and starts the project's roko serve.`
              : action === 'start-serve'
                ? `Starts roko serve for ${name} in the background (\`roko serve --detach\`) on a port of its own. It keeps running after Hermes quits, so runs finish, and stops itself after 60 minutes without work.`
                : `Stops roko serve for ${name} and starts it again with the roko at /usr/local/bin/roko (0.1.0, git e31f4d52c), with the arguments it started with: it reads roko.toml and ~/.roko/.env again.`,
          digest: action === 'setup-project' ? 'a3f1c2d4e5b6a7c8' : null,
          note:
            action === 'setup-project'
              ? 'Nothing is committed: commit roko.toml yourself when you are happy with it.'
              : action === 'restart-serve' && busy
                ? `${busy} run${busy === 1 ? ' is' : 's are'} going in ${name}: restarting stops ${busy === 1 ? 'it' : 'them'} (their work so far is kept).`
                : null
        }
      }

      if (action === 'commit-roko-toml') {
        // plugin-runs' fix for Merge when roko.toml is the only uncommitted tracked file (runwork.commit_preview).
        return {
          ok: true,
          action,
          title: 'Commit roko.toml',
          variant: null,
          variants: [],
          preview: 'git -C /work/ws commit -m "roko: accept runs started from Hermes" -- roko.toml',
          path: '/work/ws/roko.toml',
          summary: 'Commits roko.toml alone, so Merge can take the run’s work.',
          digest: 'digest-commit',
          note: null
        }
      }

      return action === 'workspace-chat-ready'
        ? fixPreview(url.searchParams.get('variant'))
        : { ok: false, error: { code: 'invalid', message: `there is no fix called '${String(action)}'`, hint: '' } }
    }

    if (route === 'POST /setup/fix') {
      if (this.fixConflict) {
        this.fixConflict = false

        return { ok: false, error: { code: 'conflict', message: '/work/ws/roko.toml changed since the preview', hint: 'look at the preview again, then apply it' } }
      }

      this.applied.push(body)

      if (body.action === 'start-serve' || body.action === 'restart-serve') {
        if (!this.canWrite) {
          return { ok: false, error: FORBIDDEN }
        }

        const project = this.projectPath(url, body)
        const answer = this.serveChange(project, body.action === 'start-serve' ? 'start' : 'restart', body.force === true)

        if (answer.ok !== true) {
          // A busy restart is refused with nothing done: its setup row stays.
          return answer
        }

        const serve = answer.serve as Json

        this.problems = this.problems.filter(p => (p.fix as Json | undefined)?.action !== body.action)

        return {
          ok: true,
          action: body.action,
          done: serve.state === 'starting' || serve.state === 'running',
          ready: serve.state === 'running',
          path: project,
          message: serve.state === 'starting' ? `roko serve is starting for ${nameOf(project)}.` : `roko serve for ${nameOf(project)}: ${String(serve.state)}.`,
          next: null,
          serve
        }
      }

      this.problems = this.problems.filter(p => (p.fix as Json | undefined)?.action !== body.action)

      if (body.action === 'setup-project') {
        // fixes.setup_project: roko init, the chat-host preset, then the serve (restarted when it ran on roko's
        // defaults, so it reads the new roko.toml), waited for.
        const project = this.projectPath(url, body)
        const ranWithout = this.answers(project)

        this.projects = (this.projects ?? []).map(p => (p.path === project ? { ...p, needs_setup: false, ready: true } : p))
        this.serves[project] = serveState(project, 'running')

        return {
          ok: true,
          action: body.action,
          done: true,
          ready: true,
          path: project,
          message: `roko init wrote roko.toml; roko's chat-host preset changed roko.toml${ranWithout ? '; roko serve restarted on the new roko.toml' : ''}. roko accepts runs started from Hermes in ${nameOf(project)} now.`,
          next: null,
          serve: this.serves[project]
        }
      }

      if (body.action === 'commit-roko-toml') {
        this.mergeCheck = { ...defaultMergeCheck(), ...this.afterCommit }

        return { ok: true, action: body.action, done: true, ready: true, next: null, message: 'Committed roko.toml (a1b2c3d4).' }
      }

      return {
        ok: true,
        action: body.action,
        variant: body.variant,
        done: true,
        path: '/work/ws/roko.toml',
        backup: '/work/ws/roko.toml.bak',
        summary: '',
        ready: this.fixReady,
        next: this.fixNext,
        message: this.fixReady
          ? 'Changed /work/ws/roko.toml. roko accepts runs started from Hermes now.'
          : 'Changed /work/ws/roko.toml. roko no longer asks for the data-model boundary, but it still refuses runs started from Hermes.'
      }
    }

    if (route === 'GET /health') {
      return {
        ok: true,
        ...(this.install ? { plugin_version: this.pluginVersion, install: this.install, ...this.setup(url) } : {}),
        checks: [
          { name: 'reachable', status: 'ok', detail: 'roko serve 0.1.0, status ok' },
          { name: 'auth', status: 'warn', detail: 'API key from the launch token', hint: 'Mint a key with `hermes roko setup --mint`.' },
          { name: 'workspace', status: 'fail', detail: 'workdir is not a git repository', hint: 'Point workdir at a git checkout.' }
        ]
      }
    }

    if (route === 'GET /estimate' && this.estimate) {
      return { ok: true, estimate: this.estimate }
    }

    if (route === 'GET /learning' && this.learning) {
      return { ok: true, scope: url.searchParams.get('scope') ?? 'hermes', ...this.learning }
    }

    if (route === 'GET /insights' && this.insightsScoped) {
      // 0.5.0: whose numbers (`scope`), a summary that keeps checks apart from task verdicts, gate rows' `kind`.
      const hermes = (url.searchParams.get('scope') ?? 'hermes') === 'hermes'

      return {
        ok: true,
        scope: { kind: hermes ? 'hermes' : 'workspace', label: hermes ? 'runs started from Hermes' : 'this workspace', since: '2026-10-12T09:00:00Z', until: '2026-10-15T18:00:00Z' },
        summary: hermes
          ? { runs: { total: 3, succeeded: 1, unverified: 1, failed: 1, cancelled: 0, interrupted: 0 }, tasks: { total: 4, verified: 2, unverified: 1, failed: 1 }, checks: { passed: 2, failed: 1, ran: 3, pass_rate: 0.67 }, spend_usd: 0.42, cost_per_task_usd: 0.105, typical_task_ms: 42_000 }
          : { runs: null, tasks: { total: 446, verified: 300, unverified: 40, failed: 106 }, checks: { passed: 900, failed: 100, ran: 1000, pass_rate: 0.9 }, spend_usd: 176.59, cost_per_task_usd: 0.4, typical_task_ms: 61_000 },
        gates: [
          { gate: 'verify[0:test]', pass_rate: 0.67, passed: 2, failed: 1, avg_duration_ms: 601, kind: 'check' },
          { gate: 'task verdict', pass_rate: 0, passed: 0, failed: 1, avg_duration_ms: null, kind: 'verdict' }
        ],
        models: [{ model: 'glm-5.1', tasks: 4, success_rate: 0.75, total_cost_usd: 0.42 }],
        cost_trend: []
      }
    }

    if (route === 'GET /insights') {
      return {
        ok: true,
        gates: [
          { gate: 'verify[0:test]', pass_rate: 0.83, passed: 5, failed: 1, avg_duration_ms: 601 },
          { gate: 'lint[1:clippy]', pass_rate: 0.4, passed: 2, failed: 3, avg_duration_ms: 1840 }
        ],
        models: [{ model: 'glm-5.1', tasks: 5, success_rate: 1.0, total_cost_usd: 0.05 }],
        cost_trend: [
          { at: iso(-300_000), cost_usd: 0.01, cumulative_usd: 0.12 },
          { at: iso(-200_000), cost_usd: 0.1, cumulative_usd: 0.22 },
          { at: iso(-100_000), cost_usd: 0.1, cumulative_usd: 0.32 }
        ]
      }
    }

    throw new Error(`404: no route ${route}`)
  }

  private overview(url: URL): Json {
    const running = this.runs.filter(r => r.state === 'running').length
    const queued = this.runs.filter(r => r.state === 'queued').length
    const reachable = this.up(url)
    // 0.7 (views.collect_pending, round 1): what waits in every project whose serve answers, whichever project is shown;
    // each item with its project. 0.6: the one roko serve's.
    const waiting = this.projects ? this.waiting() : reachable ? this.pending : []
    // 0.7: the project this answer is about, every project, and its serve on the connection; with no project yet,
    // `project: null`, `projects: []` and no serve (round-1 amendment 1). Its URL is its serve's: none while it is down.
    const none = Boolean(this.projects) && !this.projects!.length
    const path = this.projectPath(url)
    const projects = this.projects ? this.projectList() : null
    const remote = none && this.remoteUrl ? { ...serveState('', 'remote'), project: null, name: new URL(this.remoteUrl).host, url: this.remoteUrl, since: null } : null
    const serve = projects && !none ? this.serveFor(path) : remote
    const error = reachable
      ? null
      : none && !remote
        ? { code: 'unreachable', message: 'no project is chosen for roko, so there is no roko serve to ask', hint: 'pick a project on the roko page, or run `hermes roko init` in your project' }
        : serve
          ? { code: 'unreachable', message: `roko serve is not running for ${path}`, hint: `start it from the roko page, or with \`hermes roko serve start --project ${path}\`` }
          : { code: 'unreachable', message: 'roko serve is not answering at http://127.0.0.1:6677', hint: this.unreachableHint }

    return {
      ok: true,
      plugin_version: this.pluginVersion,
      ...(this.install && this.installOnOverview ? { install: this.install } : {}),
      ...this.setup(url),
      ...(projects ? { project: none ? null : projects.find(p => p.path === path), projects } : {}),
      connection: {
        url: projects ? (serve?.url ?? null) : 'http://127.0.0.1:6677',
        reachable,
        version: reachable ? '0.1.0' : null,
        status: reachable ? this.connectionStatus : null,
        credential: 'env:ROKO_API_KEY',
        error,
        ...(projects ? { workdir: none ? null : path, serve } : {})
      },
      counts: { running, queued, waiting: waiting.length },
      spend: { today_usd: 0.42, committed_usd: 1.0, max_day_usd: 10.0, left_usd: this.leftUsd, runs_today: 3, from: 'hermes', roko_today_usd: this.rokoTodayUsd },
      limits: { max_run_usd: 5.0, max_day_usd: 10.0 },
      plan_writing_cap: this.planWritingCap,
      permissions: { write: this.canWrite },
      ...(this.ladder ? { ladder: this.ladder } : {}),
      runs: this.rowsWithoutBudgetStop
        ? this.runs.map(row => {
            const { budget_stop: _stop, ...rest } = row

            return rest
          })
        : this.runs,
      pending: waiting,
      checked_at: iso(0)
    }
  }

  private run(runId: string): Json {
    const row = this.runs.find(r => r.run_id === runId)

    if (!row) {
      return { ok: false, error: { code: 'not_found', message: `roko has no run ${runId}.`, hint: '' } }
    }

    const active = row.state === 'running' || row.state === 'queued'

    if (runId === RUN_ACTIVE) {
      const waitingT2 = this.pending.some(p => p.task_id === 'T2')

      return {
        ok: true,
        run: runDetail(row, {
          active,
          request: 'Add tests for the lexer and the parser, and write up what they cover.',
          eta_minutes: active ? 4 : null,
          tasks: [
            {
              task_id: 'T1',
              title: 'lexer',
              outcome: 'passed',
              model: 'glm-5.1',
              provider: 'zai',
              attempts: 1,
              depends_on: [],
              duration_ms: 12_000,
              started_at: iso(-60_000),
              finished_at: iso(-48_000),
              gates: [{ gate: 'verify[0:test]', passed: true, excerpt: '$ cargo test -p lexer\ntest result: ok. 12 passed' }],
              attempt_log: [{ attempt: 1, model: 'glm-5.1', provider: 'zai', started_at: iso(-59_000), gates: [{ gate: 'verify[0:test]', passed: true }], route: ROUTE_T1 }],
              note: 'The lexer handles **all** token kinds; 12 tests pass.',
              lessons: [{ admission: 'full_admitted', entry_id: 'k-7', lesson: 'Lexer tests live in tests/lexer.rs and run with cargo test -p lexer', reinforced: 1, promoted: false }]
            },
            {
              task_id: 'T2',
              title: 'Report',
              outcome: active ? 'running' : 'passed',
              model: 'glm-5.1',
              provider: 'zai',
              attempts: 2,
              depends_on: [],
              started_at: iso(-58_000),
              step: active ? (this.liveSteps ? 'agent' : 'check') : null,
              step_detail: active ? (this.liveSteps ? 'glm-5.1' : 'verify[0:test]') : null,
              step_since: active ? iso(-7_000) : null,
              gates: [{ gate: 'verify[0:test]', passed: false, excerpt: 'test parser::commas ... FAILED' }],
              attempt_log: [
                { attempt: 1, model: 'glm-5.1', provider: 'zai', started_at: iso(-57_000), gates: [{ gate: 'verify[0:test]', passed: false }], route: null },
                { attempt: 2, model: 'glm-5.1', provider: 'zai', started_at: iso(-30_000), gates: [], route: ROUTE_T2 }
              ],
              note: 'Fixing the trailing-comma case before the report.',
              hold: waitingT2
                ? { state: 'waiting', rung: 6, question: 'Accept the report T2 wrote?', timeout_secs: 1800, deadline_at: iso(100_000), since: iso(-20_000), outcome: null, note: null }
                : null,
              steps: this.liveSteps
                ? [
                    { tool: 'Read', target: 'src/parser.rs', ts: iso(-9_000) },
                    { tool: 'Edit', target: 'src/parser.rs', ts: iso(-6_000) },
                    { tool: 'Bash', target: 'cargo test -p parser', ts: iso(-2_000) }
                  ]
                : [],
              live_text: this.liveSteps ? 'The trailing comma case now parses; running the tests.' : null
            },
            {
              task_id: 'T3',
              title: 'parser',
              outcome: 'pending',
              model: null,
              attempts: 0,
              depends_on: ['T1'],
              gates: [],
              attempt_log: [],
              effects: this.pending.some(p => p.code === 'd4e5f6')
                ? [{ effect_id: 'effect-1', tool: 'mail.send', server: 'mail', state: 'held', outcome: null, since: iso(-60_000) }]
                : []
            }
          ],
          loops: activeLoops(),
          thresholds: [
            { rung: 2, name: 'test', ema_pass_rate: 0.92, observations: 30, consecutive_passes: 4, shift: false },
            { rung: 0, name: 'compile', ema_pass_rate: 1, observations: 41, consecutive_passes: 12, shift: false }
          ],
          progress: active
            ? { total: 3, passed: 1, failed: 0, running: 1, pending: 1, blocked: 0, stopped: 0, unverified: 0 }
            : { total: 3, passed: 2, failed: 0, running: 0, pending: 1, blocked: 0, stopped: 0, unverified: 0 },
          graph: { waves: [['T1', 'T2'], ['T3']], edges: [['T1', 'T3']] },
          gates: { passed: 1, failed: 1, total: 2 },
          waiting: this.pending.filter(p => p.run_id === runId),
          headline: `${String(row.state)} · gates 1/2 · $0.42 of $0.50 · 1m 05s`
        })
      }
    }

    if (runId === RUN_FAILED) {
      return {
        ok: true,
        run: runDetail(row, {
          verdict: 'failed',
          finished_at: iso(-89_400_000),
          duration_ms: 553_340,
          tasks: [
            {
              task_id: 'T1',
              title: 'Add BudgetStore persistence module',
              outcome: 'failed',
              model: 'glm-5.1',
              provider: 'zai',
              attempts: 3,
              depends_on: [],
              duration_ms: 553_000,
              gates: [{ gate: 'verify[0:compile]', passed: false, excerpt: 'bash: line 1: python: command not found', runs: 3 }],
              attempt_log: [1, 2, 3].map(n => ({ attempt: n, model: 'glm-5.1', provider: 'zai', started_at: iso(-90_000_000 + n * 60_000), gates: [{ gate: 'verify[0:compile]', passed: false }] })),
              note: 'Both files are complete and correct.'
            },
            { task_id: 'T2', title: 'Wire budgets into the CLI', outcome: 'blocked', blocked_by: 'T1', reason: 'dependency T1 did not pass', model: null, attempts: 0, depends_on: ['T1'], gates: [], attempt_log: [] }
          ],
          progress: { total: 2, passed: 0, failed: 1, running: 0, pending: 0, blocked: 1, stopped: 0, unverified: 0 },
          graph: { waves: [['T1'], ['T2']], edges: [['T1', 'T2']] },
          gates: { passed: 0, failed: 3, total: 3 },
          why: {
            summary: "T1's check verify[0:compile] did not pass after 3 attempts: bash: line 1: python: command not found. T2 was blocked because T1 did not pass.",
            gates_not_passed: [{ task_id: 'T1', title: 'Add BudgetStore persistence module', gate: 'verify[0:compile]', runs: 3, output: '$ python -m py_compile tally/budgets.py\nbash: line 1: python: command not found', key_line: 'bash: line 1: python: command not found' }],
            blocked: [{ task_id: 'T2', blocked_by: 'T1', reason: 'dependency T1 did not pass' }],
            unverified_tasks: [],
            errors: []
          },
          headline: 'failed · gates 0/3 · tasks 0/2 · $0.17 of $1.00 · 9m13s'
        })
      }
    }

    if (runId === RUN_PLANGEN) {
      return {
        ok: true,
        run: {
          run_id: RUN_PLANGEN,
          kind: 'plan_generate',
          label: String(row.label),
          plan_id: 'add-tests',
          state: row.state,
          verdict: null,
          active,
          task_count: 3,
          planner_error: null,
          tasks: [],
          gates: { passed: 0, failed: 0, total: 0 },
          milestones: [],
          waiting: [],
          headline: active ? 'running' : 'succeeded · plan add-tests · 3 tasks',
          checked_at: iso(0)
        }
      }
    }

    if (runId === RUN_DONE) {
      return {
        ok: true,
        run: runDetail(row, {
          verdict: 'succeeded',
          finished_at: iso(-3_558_000),
          duration_ms: 42_210,
          tasks: [
            {
              task_id: 'T1',
              // roko names a prompt run's only task after the chat host that asked.
              title: 'Request from chat host hermes',
              outcome: 'passed',
              model: 'glm-5.1',
              provider: 'zai',
              attempts: 1,
              duration_ms: 40_000,
              gates: [{ gate: 'verify[0:test]', passed: true, excerpt: '$ cargo test' }],
              attempt_log: [{ attempt: 1, model: 'glm-5.1', provider: 'zai', started_at: iso(-3_600_000), gates: [{ gate: 'verify[0:test]', passed: true }] }],
              note: this.doneNote ?? 'Added clamp() and a test for the edges.',
              ...(this.doneLessons ? { lessons: this.doneLessons } : {})
            }
          ],
          progress: { total: 1, passed: 1, failed: 0, running: 0, pending: 0, blocked: 0, stopped: 0, unverified: 0 },
          graph: { waves: [['T1']], edges: [] },
          gates: { passed: 1, failed: 0, total: 1 },
          delivered: {
            workspace: this.doneWorkspace,
            branch: `roko/batch/${RUN_DONE}`,
            commit: 'd66293e36e22',
            files_changed: ['src/lib.rs'],
            diffstat: '1 file changed, 30 insertions(+)',
            merged: this.merged
          },
          review_command: `git -C /work/ws diff HEAD...roko/batch/${RUN_DONE}`,
          merge_command: `git -C /work/ws merge roko/batch/${RUN_DONE}`,
          headline: 'succeeded · gates 1/1 · $0.01 of $0.50 · 42s · branch roko/batch/e13f… (not merged)'
        })
      }
    }

    // A row a test gives its own tasks, gates or tokens keeps them (the card's other defaults stay).
    return {
      ok: true,
      run: runDetail(row, {
        active,
        headline: typeof row.headline === 'string' ? row.headline : `${String(row.state)} · no gates ran`,
        ...(Array.isArray(row.tasks) ? { tasks: row.tasks } : {}),
        ...(row.gates && typeof row.gates === 'object' ? { gates: row.gates } : {}),
        ...(row.tokens && typeof row.tokens === 'object' ? { tokens: row.tokens } : {}),
        ...('duration_ms' in row ? { duration_ms: row.duration_ms } : {}),
        ...('finished_at' in row ? { finished_at: row.finished_at } : {})
      })
    }
  }

  private longEvents(runId: string, all: Json[], params: URLSearchParams): Json {
    const at = (e: Json) => Number(e.cursor)
    const limit = Number(params.get('limit') ?? 100)

    if (params.get('tail') && (this.eventsReading[runId] ?? 0) > 0) {
      this.eventsReading[runId] -= 1

      return { ok: true, events: [], next_cursor: 0, has_more: false, earlier: false, reading: true, rows_read: (2 - this.eventsReading[runId]) * 40_000 }
    }

    if (params.get('tail')) {
      const n = Number(params.get('tail'))

      return { ok: true, events: all.slice(-n), next_cursor: at(all[all.length - 1]), has_more: false, earlier: all.length > n }
    }

    if (params.get('before')) {
      const before = all.filter(e => at(e) < Number(params.get('before')))

      return { ok: true, events: before.slice(-limit), next_cursor: Number(params.get('before')), has_more: false, earlier: before.length > limit }
    }

    const after = all.filter(e => at(e) > Number(params.get('cursor') ?? 0))
    const page = after.slice(0, limit)

    return { ok: true, events: page, next_cursor: page.length ? at(page[page.length - 1]) : Number(params.get('cursor') ?? 0), has_more: after.length > limit }
  }

  private events(runId: string, cursor: string | null): Json {
    const given = this.eventsFor[runId]

    if (given) {
      const last = Number(given.at(-1)?.cursor ?? 0)

      return cursor ? { ok: true, events: [], next_cursor: Number(cursor), has_more: false } : { ok: true, events: given, next_cursor: last, has_more: false }
    }

    if (runId === RUN_FAILED) {
      const t0 = Date.now() - 90_000_000
      const at = (s: number) => t0 + s * 1000

      return {
        ok: true,
        events: [
          { cursor: 10, type: 'plan_started', group: 'run', task_id: null, ts_millis: at(0), text: 'plan tally-budgets started (2 tasks)' },
          { cursor: 20, type: 'task_started', group: 'task', task_id: 'T1', ts_millis: at(1), text: 'T1 started: Add BudgetStore persistence module' },
          { cursor: 30, type: 'agent_spawned', group: 'agent', task_id: 'T1', attempt: 1, model: 'glm-5.1', provider: 'zai', ts_millis: at(2), text: 'T1 attempt 1 on glm-5.1 (zai)' },
          { cursor: 40, type: 'agent_output', group: 'agent', task_id: 'T1', ts_millis: at(60), text: 'T1 agent: Both files are complete and correct.' },
          { cursor: 50, type: 'gate_rung_started', group: 'gate', task_id: 'T1', ts_millis: at(61), text: 'T1 checking verify[0:compile]' },
          { cursor: 60, type: 'gate_result', group: 'gate', task_id: 'T1', ts_millis: at(62), passed: false, text: 'T1 gate verify[0:compile] did not pass' },
          { cursor: 70, type: 'task_completed', group: 'task', task_id: 'T1', ts_millis: at(550), outcome: 'failed', text: 'T1 ended: failed' },
          { cursor: 80, type: 'task_blocked', group: 'task', task_id: 'T2', ts_millis: at(551), text: 'T2 blocked: dependency T1 did not pass' },
          { cursor: 90, type: 'run_completed', group: 'run', task_id: null, ts_millis: at(553), text: 'run failed in 9m13s' }
        ],
        next_cursor: 90,
        has_more: false
      }
    }

    if (runId !== RUN_ACTIVE) {
      return { ok: true, events: [], next_cursor: null, has_more: false }
    }

    if (!cursor) {
      return {
        ok: true,
        events: [
          { cursor: 1177, type: 'task_started', group: 'task', task_id: 'T1', ts_millis: Date.now() - 60_000, text: 'T1 started: lexer' },
          { cursor: 2300, type: 'agent_output', group: 'agent', task_id: 'T1', ts_millis: Date.now() - 50_000, text: 'T1 agent: <b>done</b> with the **lexer**' },
          { cursor: 4703, type: 'gate_result', group: 'gate', task_id: 'T1', ts_millis: Date.now() - 48_000, passed: true, text: 'T1 gate verify[0:test] passed' }
        ],
        next_cursor: 4703,
        has_more: true
      }
    }

    if (cursor === '4703') {
      return {
        ok: true,
        events: [{ cursor: 6795, type: 'gate_result', group: 'gate', task_id: 'T2', ts_millis: Date.now() - 20_000, passed: false, text: 'T2 gate verify[0:test] failed' }],
        next_cursor: 6795,
        has_more: false
      }
    }

    return { ok: true, events: [], next_cursor: Number(cursor), has_more: false }
  }

  private diff(runId: string): Json {
    if (runId === RUN_ACTIVE) {
      return { ok: true, diff: { run_id: runId, available: false, why: 'running', message: 'the run is still going: its changes show once it ends', files: [], totals: { files: 0, additions: 0, deletions: 0 } } }
    }

    if (runId !== RUN_DONE || this.diffGone) {
      return { ok: true, diff: { run_id: runId, available: false, why: 'none', message: 'this run left no changes to review: no batch branch with verified work', files: [], totals: { files: 0, additions: 0, deletions: 0 } } }
    }

    return {
      ok: true,
      diff: {
        run_id: runId,
        available: true,
        source: 'roko',
        branch: `roko/batch/${RUN_DONE}`,
        base: '3cfff55c8a68aa',
        commit: DONE_COMMIT,
        files: [
          {
            path: 'src/lib.rs',
            old_path: null,
            status: 'modified',
            additions: 3,
            deletions: 1,
            binary: false,
            language: 'rust',
            truncated: false,
            hunks: [
              {
                header: '@@ -10,4 +10,6 @@ pub fn sub',
                old_start: 10,
                new_start: 10,
                context: 'pub fn sub',
                lines: [
                  [' ', 10, 10, '/// Subtract two numbers.'],
                  ['-', 11, null, 'pub fn old() -> i32 { 0 }'],
                  ['+', null, 11, 'pub fn clamp(v: i32, lo: i32, hi: i32) -> i32 { v.max(lo).min(hi) }'],
                  ['+', null, 12, HOSTILE_LINE],
                  ['+', null, 13, 'let name = "clamp"; // 42'],
                  ['\\', null, null, 'No newline at end of file']
                ]
              }
            ]
          },
          { path: 'assets/logo.png', old_path: null, status: 'added', additions: 0, deletions: 0, binary: true, language: null, truncated: false, hunks: [] },
          { path: 'docs/huge.md', old_path: null, status: 'added', additions: 4000, deletions: 0, binary: false, language: 'markdown', truncated: true, hunks: [] },
          ...this.diffExtra
        ],
        totals: { files: 3, additions: 4003, deletions: 1 },
        truncated: false
      }
    }
  }

  private plan(planId: string): Json {
    if (planId === 'demo-hello-world' || planId === 'demo-hello') {
      return {
        ok: true,
        plan: {
          plan_id: planId,
          title: planId === 'demo-hello' ? 'Roko plan-runner demo' : 'Start here: hello world demo',
          task_count: 1,
          max_parallel: 1,
          tasks: [{ id: 'HELLO-1', title: 'Write a Rust program that prints hello world', depends_on: [], checks: ['rustc demo/hello-world/main.rs'], role: 'implementer' }],
          waves: [['HELLO-1']],
          estimate: null
        }
      }
    }

    if (planId !== 'add-tests' && planId !== 'parser-rewrite') {
      return { ok: false, error: { code: 'not_found', message: `No plan ${planId}.`, hint: '' } }
    }

    return {
      ok: true,
      plan: {
        plan_id: planId,
        title: planId === 'add-tests' ? 'Add tests' : 'Parser rewrite',
        task_count: 3,
        max_parallel: 2,
        tasks: [
          { id: 'T1', title: 'lexer', depends_on: [], checks: ['cargo test -p lexer'], role: 'implementer', description: 'Tokenize.' },
          { id: 'T2', title: 'Report', depends_on: [], checks: [], role: 'writer', description: 'Write it up.' },
          { id: 'T3', title: 'parser', depends_on: ['T1'], checks: ['cargo test -p parser', 'cargo clippy'], role: 'implementer', description: 'Parse.' }
        ],
        waves: [['T1', 'T2'], ['T3']],
        estimate: planId === 'add-tests' ? { total_cost_usd: 0.0267, total_duration_secs: 30, confidence: 'low' } : null
      }
    }
  }
}

/** Metakosmia Undertow's build after phase 1, as GET /build answers it (round v7, #3): the pilot's real numbers. */
export function undertowBuild(): Json {
  const phase = (n: number, name: string, state: string, more: Json = {}): Json => ({
    n,
    name,
    goal: null,
    spec: `docs/specs/phase-${n}-${name.split(' ')[0]}.md`,
    plan_id: null,
    title: null,
    state,
    ended: null,
    tasks: null,
    runs: 0,
    run_id: null,
    writing_id: null,
    cost_usd: null,
    wall_ms: null,
    rungs: null,
    ...more
  })

  return {
    project: { path: '~/dev/undertow', name: 'undertow' },
    reachable: true,
    phases: [
      phase(0, 'foundation', 'passed', { plan_id: 'p0-undertow-foundation', title: 'P0 · Undertow foundation', tasks: { passed: 3, total: 3 }, runs: 3, run_id: RUN_DONE, cost_usd: 1.053804, wall_ms: 5_471_000, rungs: [{ rung: 'cheap', passed: 0, running: 0, failed: 0, waiting: 0 }, { rung: 'mid', passed: 3, running: 0, failed: 0, waiting: 0 }] }),
      phase(1, 'voice', 'passed', { plan_id: 'p1-undertow-voice', title: 'P1 · Undertow voice', tasks: { passed: 5, total: 5 }, runs: 1, run_id: RUN_FAILED, cost_usd: 1.1723, writing_usd: 0.1519, wall_ms: 4_560_000 }),
      phase(2, 'rumble and modulation', 'writing', { goal: 'the hypnotic part of the sound: two tempo-synced LFOs, the rumble, saturation', writing_id: RUN_PLANGEN, cost_usd: 0.0123 }),
      phase(3, 'the hypnotic sequencer', 'specified', { goal: 'a 16-step bassline sequencer locked to the host transport' }),
      phase(4, 'the ROSEDUST phosphor editor', 'specified'),
      phase(5, 'ship', 'specified')
    ],
    totals: { phases: 6, passed: 2, tasks_passed: 8, tasks_total: 8, runs: 4, cost_usd: 2.7902, writing_usd: 0.25, outside_usd: 0.105, cost_source: 'ledger', wall_ms: 10_031_000 },
    receipt: {
      phases: 1,
      cost_usd: 1.0204,
      top_rung: 'claude-sonnet-4-6',
      top_rung_usd: 2.96,
      ratio: 2.9,
      basis: "≈ each passed phase's passing tries at claude-sonnet-4-6's list prices · roko's spend includes 2 runs that didn't pass",
      runs_not_passed: 2,
      runs_running: 0,
      missing: 1,
      unread: [RUN_DONE],
      not_compared: 0
    },
    next: { n: 2, do: 'wait', run_id: RUN_PLANGEN }
  }
}

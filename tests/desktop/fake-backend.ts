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
    { id: 'demo-hello', title: 'Roko plan-runner demo', task_count: 1, tasks_done: 1, status: 'done', group: 'demos' },
    { id: 'demo-hello-world', title: 'Start here: hello world demo', task_count: 1, tasks_done: 0, status: 'fixture', group: 'demos/parallel-plans' }
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
    { ring: 'L1', kind: 'route', text: 'T1 attempt 1 → glm-5.1 (ladder; p 0.55; over gpt-oss-120b 0.21)', data: ROUTE_T1, task_id: 'T1', plan_id: 'add-tests', ts: t - 59_000, key: 'route:add-tests:T1:1:glm-5.1:ladder' },
    { ring: 'L1', kind: 'retry', text: 'T2 attempt 2 on glm-5.1', data: { attempt: 2, model: 'glm-5.1', provider: 'zai' }, task_id: 'T2', plan_id: 'add-tests', ts: t - 30_500, key: 'retry:add-tests:T2:2' },
    { ring: 'L1', kind: 'route', text: 'T2 attempt 2 → glm-5.1 (learned; p 0.82; over gpt-5.4-mini 0.71)', data: ROUTE_T2, task_id: 'T2', plan_id: 'add-tests', ts: t - 30_000, key: 'route:add-tests:T2:2:glm-5.1:router' },
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

export class FakeBackend {
  mounted = true
  reachable = true
  /** P-3: roko's whole-workspace spend today (`spend.roko_today_usd`); null without a shared workdir. */
  rokoTodayUsd: number | null = null
  /** roko still lists an answered item for a moment (it settles the answer a little later). */
  listsAnswered = false
  /** What GET /loops answers instead of `loopsAnswer()`, when a test sets it. */
  loops: Json | null = null
  /** Plans roko would not run yet: plan id → its `validation` (a PlanValidation). */
  validation: Record<string, Json> = {}
  /** POST /plans/{id}/run finds the plan fails roko's validator (it read valid before): plan id → the PlanValidation. */
  refuseRunFor: Record<string, Json> = {}
  /** The overview's rows do not carry `budget_stop` yet (they learn it a refresh after the card does). */
  rowsWithoutBudgetStop = false
  /** A run's whole timeline, when a test gives one (GET /runs/{id}/events answers it once, then nothing newer). */
  eventsFor: Record<string, Json[]> = {}
  /** The overview's `ladder` (0.6.0): the workspace's model ladder, cheapest first, when a test gives one. */
  ladder: Json[] | null = null
  /** connection.error.hint while roko is down; an older backend (or no workdir) names `--workdir WORKSPACE`. */
  unreachableHint = 'Start it with `roko serve`.'
  connectionStatus = 'ok'
  /** permissions.write: false makes the UI read-only (ui_actions: false). */
  canWrite = true
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

  reset(): void {
    this.mounted = true
    this.reachable = true
    this.rokoTodayUsd = null
    this.listsAnswered = false
    this.loops = null
    this.validation = {}
    this.refuseRunFor = {}
    this.rowsWithoutBudgetStop = false
    this.eventsFor = {}
    this.ladder = null
    this.unreachableHint = 'Start it with `roko serve`.'
    this.connectionStatus = 'ok'
    this.canWrite = true
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
    this.estimate = null
    this.fixConflict = false
  }

  /** `setup` as the overview and /health carry it; nothing on an old backend. */
  private setup(): Json {
    return this.install ? { setup: { ok: !this.problems.some(p => p.severity === 'block'), problems: this.problems } } : {}
  }

  private refusal(): Json | null {
    const problem = this.refuseWith

    return problem ? { ok: false, error: { code: 'refused', message: String(problem.title), hint: '' }, problem } : null
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

    if (!this.reachable && url.pathname !== '/overview') {
      return {
        ok: false,
        error: { code: 'unreachable', message: 'roko serve is not answering at http://127.0.0.1:6677', hint: this.unreachableHint }
      }
    }

    const body = (req.body ?? {}) as Json
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    if (route === 'GET /overview') {
      return this.overview()
    }

    if (route === 'GET /loops') {
      return this.loops ?? loopsAnswer()
    }

    if (route === 'GET /pending') {
      return { ok: true, items: this.pending }
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
      return this.events(segments[1], url.searchParams.get('cursor'))
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

      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        return { ok: false, error: { code: 'invalid', message: 'say what roko should do', hint: '' } }
      }

      if (body.plan === true) {
        this.runs = [
          { run_id: RUN_PLANGEN, kind: 'plan_generate', label: String(body.title ?? body.prompt), plan_id: 'add-tests', state: 'running', cost_usd: null, max_usd: null, started_at: iso(0), source: 'ui' },
          ...this.runs
        ]

        return { ok: true, run_id: RUN_PLANGEN, kind: 'plan_generate', plan_id: 'add-tests', state: 'running' }
      }

      const cap = body.max_usd

      if (typeof cap !== 'number' || cap < 0.01 || cap > 5) {
        return { ok: false, error: { code: 'invalid', message: 'max_usd must be between $0.01 and $5.00.', hint: 'Pick a smaller cap.' } }
      }

      this.runs = [
        { run_id: RUN_NEW, kind: 'run', label: String(body.title ?? body.prompt), state: 'running', cost_usd: 0, max_usd: cap, started_at: iso(0), source: 'ui' },
        ...this.runs
      ]

      return { ok: true, run_id: RUN_NEW, kind: 'run', state: 'running', max_usd: cap }
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

      const cap = body.max_usd

      if (typeof cap !== 'number' || cap < 0.01 || cap > 5) {
        return { ok: false, error: { code: 'invalid', message: 'max_usd must be between $0.01 and $5.00.', hint: 'Pick a smaller cap.' } }
      }

      this.runs = [
        { run_id: RUN_NEW, kind: 'plan', label: segments[1], plan_id: segments[1], state: 'running', cost_usd: 0, max_usd: cap, started_at: iso(0) },
        ...this.runs
      ]

      return { ok: true, run_id: RUN_NEW, state: 'running', queue_position: null }
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
      this.problems = this.problems.filter(p => (p.fix as Json | undefined)?.action !== body.action)

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
        ...(this.install ? { plugin_version: this.pluginVersion, install: this.install, ...this.setup() } : {}),
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

  private overview(): Json {
    const running = this.runs.filter(r => r.state === 'running').length
    const queued = this.runs.filter(r => r.state === 'queued').length
    const error = this.reachable
      ? null
      : { code: 'unreachable', message: 'roko serve is not answering at http://127.0.0.1:6677', hint: this.unreachableHint }

    return {
      ok: true,
      plugin_version: this.pluginVersion,
      ...(this.install && this.installOnOverview ? { install: this.install } : {}),
      ...this.setup(),
      connection: {
        url: 'http://127.0.0.1:6677',
        reachable: this.reachable,
        version: this.reachable ? '0.1.0' : null,
        status: this.reachable ? this.connectionStatus : null,
        credential: 'env:ROKO_API_KEY',
        error
      },
      counts: { running, queued, waiting: this.reachable ? this.pending.length : 0 },
      spend: { today_usd: 0.42, committed_usd: 1.0, max_day_usd: 10.0, left_usd: this.leftUsd, runs_today: 3, from: 'hermes', roko_today_usd: this.rokoTodayUsd },
      limits: { max_run_usd: 5.0, max_day_usd: 10.0 },
      permissions: { write: this.canWrite },
      ...(this.ladder ? { ladder: this.ladder } : {}),
      runs: this.rowsWithoutBudgetStop
        ? this.runs.map(row => {
            const { budget_stop: _stop, ...rest } = row

            return rest
          })
        : this.runs,
      pending: this.reachable ? this.pending : [],
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
            workspace: '/work/ws',
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
        ...(row.tokens && typeof row.tokens === 'object' ? { tokens: row.tokens } : {})
      })
    }
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
          { cursor: 30, type: 'agent_spawned', group: 'agent', task_id: 'T1', ts_millis: at(2), text: 'T1 attempt 1 on glm-5.1 (zai)' },
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
          { path: 'docs/huge.md', old_path: null, status: 'added', additions: 4000, deletions: 0, binary: false, language: 'markdown', truncated: true, hunks: [] }
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

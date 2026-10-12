/**
 * A fake of dashboard/plugin_api.py as docs/ui-api.md describes it, served
 * through the desktop's ctx.rest door (window.hermesDesktop.api). Every route
 * answers {ok:true,…} or {ok:false,error:{code,message,hint}}; an unmounted
 * router rejects like Hermes does ("404: …").
 */

export const RUN_ACTIVE = 'a1c4e8f0-5b1a-4c55-9d0e-2a7f0c1d9b10'
export const RUN_DONE = 'e13f6327-8c2d-4a7b-b1e4-6f0a9d3c2e11'
export const RUN_UNVERIFIED = 'f0d2b7aa-3e4f-4d21-8a9b-1c2d3e4f5a62'
export const RUN_NEW = 'b7e2c9d1-0f3a-4b8c-9d2e-5a6b7c8d9e03'

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
      session_id: 'sess-1'
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
      kind: 'plan_generate',
      label: 'Plan the parser rewrite',
      state: 'unverified',
      cost_usd: null,
      max_usd: null,
      started_at: iso(-7_200_000)
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

export class FakeBackend {
  mounted = true
  reachable = true
  connectionStatus = 'ok'
  /** permissions.write: false makes the UI read-only (ui_actions: false). */
  canWrite = true
  runs: Json[] = runRows()
  pending: Json[] = [pendingConfirm(), pendingEffect()]
  /** Per-path error overrides: path -> {code, message, hint}. */
  failures = new Map<string, Json>()
  calls: ApiRequest[] = []

  reset(): void {
    this.mounted = true
    this.reachable = true
    this.connectionStatus = 'ok'
    this.canWrite = true
    this.runs = runRows()
    this.pending = [pendingConfirm(), pendingEffect()]
    this.failures.clear()
    this.calls = []
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
        error: { code: 'unreachable', message: 'roko serve is not answering at http://127.0.0.1:6677', hint: 'Start it with `roko serve`.' }
      }
    }

    const body = (req.body ?? {}) as Json
    const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

    if (route === 'GET /overview') {
      return this.overview()
    }

    if (route === 'GET /pending') {
      return { ok: true, items: this.pending }
    }

    if (route === 'POST /decide') {
      const item = this.pending.find(p => p.code === body.code || p.decision_id === body.decision_id)

      if (!item) {
        return { ok: false, error: { code: 'not_found', message: `No waiting item ${String(body.code)}.`, hint: 'It may have been answered already.' } }
      }

      this.pending = this.pending.filter(p => p !== item)

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

    if (segments[0] === 'runs' && segments[2] === 'cancel' && method === 'POST') {
      this.setRunState(segments[1], 'cancelled')

      return { ok: true, run_id: segments[1], state: 'cancelled' }
    }

    if (route === 'GET /plans') {
      return {
        ok: true,
        plans: [
          { id: 'add-tests', title: 'Add tests', task_count: 3, tasks_done: 1, status: 'ready' },
          { id: 'parser-rewrite', title: 'Parser rewrite', task_count: 5, tasks_done: 0, status: 'draft' }
        ],
        total: 2
      }
    }

    if (segments[0] === 'plans' && segments.length === 2 && method === 'GET') {
      return this.plan(segments[1])
    }

    if (segments[0] === 'plans' && segments[2] === 'run' && method === 'POST') {
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

    if (route === 'GET /health') {
      return {
        ok: true,
        checks: [
          { name: 'reachable', status: 'ok', detail: 'roko serve 0.1.0, status ok' },
          { name: 'auth', status: 'warn', detail: 'API key from the launch token', hint: 'Mint a key with `hermes roko setup --mint`.' },
          { name: 'workspace', status: 'fail', detail: 'workdir is not a git repository', hint: 'Point workdir at a git checkout.' }
        ]
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
      : { code: 'unreachable', message: 'roko serve is not answering at http://127.0.0.1:6677', hint: 'Start it with `roko serve`.' }

    return {
      ok: true,
      plugin_version: '0.2.0',
      connection: {
        url: 'http://127.0.0.1:6677',
        reachable: this.reachable,
        version: this.reachable ? '0.1.0' : null,
        status: this.reachable ? this.connectionStatus : null,
        credential: 'env:ROKO_API_KEY',
        error
      },
      counts: { running, queued, waiting: this.reachable ? this.pending.length : 0 },
      spend: { today_usd: 0.42, committed_usd: 1.0, max_day_usd: 10.0, left_usd: 8.58, runs_today: 3 },
      limits: { max_run_usd: 5.0, max_day_usd: 10.0 },
      permissions: { write: this.canWrite },
      runs: this.runs,
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
      return {
        ok: true,
        run: runDetail(row, {
          active,
          tasks: [
            { task_id: 'T1', title: 'lexer', outcome: 'passed', model: 'glm-5.1', attempts: 1, gates: [{ gate: 'verify[0:test]', passed: true, excerpt: '$ cargo test -p lexer\ntest result: ok. 12 passed' }] },
            { task_id: 'T2', title: 'Report', outcome: active ? 'running' : 'passed', model: 'glm-5.1', attempts: 2, gates: [{ gate: 'verify[0:test]', passed: false, excerpt: 'test parser::commas ... FAILED' }] },
            { task_id: 'T3', title: 'parser', outcome: null, model: null, attempts: 0, gates: [] }
          ],
          gates: { passed: 1, failed: 1 },
          waiting: this.pending.filter(p => p.run_id === runId),
          headline: `${String(row.state)} · gates 1/2 · $0.42 of $0.50 · 1m 05s`
        })
      }
    }

    if (runId === RUN_DONE) {
      return {
        ok: true,
        run: runDetail(row, {
          verdict: 'succeeded',
          finished_at: iso(-3_558_000),
          duration_ms: 42_210,
          tasks: [{ task_id: 'T1', title: 'Add clamp', outcome: 'passed', model: 'glm-5.1', attempts: 1, gates: [{ gate: 'verify[0:test]', passed: true, excerpt: '$ cargo test' }] }],
          gates: { passed: 1, failed: 0 },
          delivered: {
            workspace: '/work/ws',
            branch: `roko/batch/${RUN_DONE}`,
            commit: 'd66293e36e22',
            files_changed: ['src/lib.rs'],
            diffstat: '1 file changed, 30 insertions(+)',
            merged: false
          },
          review_command: `git -C /work/ws diff HEAD...roko/batch/${RUN_DONE}`,
          merge_command: `git -C /work/ws merge roko/batch/${RUN_DONE}`,
          headline: 'succeeded · gates 1/1 · $0.01 of $0.50 · 42s · branch roko/batch/e13f… (not merged)'
        })
      }
    }

    return { ok: true, run: runDetail(row, { active, headline: `${String(row.state)} · no gates ran` }) }
  }

  private events(runId: string, cursor: string | null): Json {
    if (runId !== RUN_ACTIVE) {
      return { ok: true, events: [], next_cursor: null, has_more: false }
    }

    if (!cursor) {
      return {
        ok: true,
        events: [
          { cursor: 1177, type: 'task_started', task_id: 'T1', text: 'T1 started: lexer' },
          { cursor: 4703, type: 'gate_result', task_id: 'T1', passed: true, text: 'T1 gate verify[0:test] passed' }
        ],
        next_cursor: 4703,
        has_more: true
      }
    }

    if (cursor === '4703') {
      return {
        ok: true,
        events: [{ cursor: 6795, type: 'gate_result', task_id: 'T2', passed: false, text: 'T2 gate verify[0:test] failed' }],
        next_cursor: 6795,
        has_more: false
      }
    }

    return { ok: true, events: [], next_cursor: Number(cursor), has_more: false }
  }

  private plan(planId: string): Json {
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

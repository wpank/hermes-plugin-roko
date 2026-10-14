/**
 * roko for Hermes Desktop: the desktop half of hermes-plugin-roko.
 *
 * Installed as <hermes home>/plugins/roko/desktop/plugin.js next to the Python
 * half. Hermes loads it uncompiled: plain ESM, jsx() calls instead of JSX, and
 * the only imports are '@hermes/plugin-sdk', 'react' and 'react/jsx-runtime'.
 * This door is opt-in: enable "roko" in Settings > Plugins > Desktop plugins.
 *
 * Everything here talks to the plugin's own backend through ctx.rest
 * (/api/plugins/roko/*, see docs/ui-api.md). That router is the only thing
 * that talks to roko serve; the roko API key never reaches this renderer.
 * Every route answers HTTP 200 {ok:true,…} or {ok:false,error:{code,message,
 * hint}}. A rejected ctx.rest means the router is not mounted: Hermes mounts
 * plugin routers when it starts, so the fix is a restart.
 *
 * Text that came from roko is untrusted. It is only ever rendered as React
 * text nodes: no HTML, no markdown, no dangerouslySetInnerHTML, no links built
 * from it. Diff lines and gate output are tinted by splitting them into text
 * spans, never by parsing them as markup.
 *
 * Contributes:
 *   - the /roko page: mission control for one run at a time (hero with its
 *     instruments, the live task graph and a task inspector, the activity feed,
 *     a replay of finished runs, the run's changes with a guarded Merge), plus
 *     Waiting, Plans, Insights and Knowledge, and a composer for new work;
 *   - a sidebar row, a status-bar chip with a live progress ring, palette rows,
 *     a "roko: New run" keybind (⌘⌥R), notifications, and a deep link
 *     (hermes://open/roko?run=<id>);
 *   - live chat cards for ::roko-run{id}, ::roko-plan{id} and ::roko-pending{run}.
 */

import {
  atom,
  Badge,
  Button,
  Codicon,
  coarseElapsed,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  formatModifierToken,
  GlyphSpinner,
  haptic,
  host,
  Input,
  KEYBINDS_AREA,
  Kbd,
  PALETTE_AREA,
  queryClient,
  ROUTES_AREA,
  SegmentedControl,
  SIDEBAR_NAV_AREA,
  Skeleton,
  STATUSBAR_AREAS,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  Tip,
  TRANSCRIPT_DIRECTIVE_AREA,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Plugin id == dashboard manifest name, so ctx.rest('/x') -> /api/plugins/roko/x. */
const ID = 'roko'
const PAGE = '/roko'
/** Run and plan ids from directives, deep links and untrusted data. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TABS = ['runs', 'waiting', 'plans', 'knowledge', 'health']
/** A run's own views: the graph, everything that happened, and what it changed. */
const RUN_VIEWS = ['overview', 'activity', 'changes']
const ACTIVE_STATES = new Set(['queued', 'running'])
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'unverified', 'cancelled', 'missing'])
/** Contract: no faster than 10 s for the overview and 3 s for one run. */
const OVERVIEW_MS = 10_000
const OVERVIEW_HIDDEN_MS = 30_000
const RUN_MS = 3_000
/** roko_* tool calls finishing within this window share one refresh. */
const TOOL_REFRESH_MS = 1_500
const RESTART_HINT = "Restart Hermes to load roko's backend."
/** The composer's keybind: "r" for run. Free in Hermes 0.21 (⌘⌥digits are profiles, ⌘⌥T the tab strip). */
const NEW_RUN_COMBO = 'mod+alt+r'
const MAX_PROMPT = 8_000
const CAP_PRESETS = [0.25, 0.5, 1, 2, 5]
const EXAMPLES = [
  'Add a --json flag to the CLI that prints the report as JSON, with a test for it.',
  'Write REPORT.md: a one-page summary of the public API with an example for each function.',
  'Find the test that fails on a clean checkout, fix the cause, and keep every other test green.'
]

const KEYS = {
  all: [ID],
  overview: [ID, 'overview'],
  pending: [ID, 'pending'],
  plans: [ID, 'plans'],
  plan: id => [ID, 'plan', id],
  run: id => [ID, 'run', id],
  diff: id => [ID, 'diff', id],
  merge: id => [ID, 'merge', id],
  knowledge: q => [ID, 'knowledge', q],
  health: [ID, 'health'],
  insights: [ID, 'insights'],
  statusText: [ID, 'status-text']
}

const STATES = {
  queued: { glyph: '·', tone: 'muted', word: 'queued' },
  running: { glyph: '⟳', tone: 'live', word: 'running' },
  succeeded: { glyph: '✓', tone: 'good', word: 'succeeded' },
  failed: { glyph: '✗', tone: 'bad', word: 'failed' },
  // No check ran: never green.
  unverified: { glyph: '?', tone: 'warn', word: 'unverified' },
  cancelled: { glyph: '⊘', tone: 'muted', word: 'cancelled' },
  // Hermes started it; roko kept no record (it refused it at once).
  missing: { glyph: '?', tone: 'warn', word: 'missing' }
}

const OUTCOMES = {
  ...STATES,
  pending: { glyph: '○', tone: 'muted', word: 'pending' },
  passed: { glyph: '✓', tone: 'good', word: 'passed' },
  already_satisfied: { glyph: '✓', tone: 'good', word: 'already satisfied' },
  accepted_with_failures: { glyph: '✓', tone: 'warn', word: 'accepted with failures' },
  skipped: { glyph: '·', tone: 'muted', word: 'skipped' },
  interrupted: { glyph: '·', tone: 'muted', word: 'interrupted' },
  error: { glyph: '✗', tone: 'bad', word: 'error' },
  crashed: { glyph: '✗', tone: 'bad', word: 'crashed' },
  timeout: { glyph: '✗', tone: 'bad', word: 'timed out' },
  timed_out: { glyph: '✗', tone: 'bad', word: 'timed out' },
  rejected: { glyph: '✗', tone: 'bad', word: 'rejected' },
  blocked: { glyph: '✗', tone: 'warn', word: 'blocked' }
}

/** Graph node states, from task outcomes. */
const PASSED = new Set(['passed', 'already_satisfied', 'accepted_with_failures', 'succeeded'])
const FAILED = new Set(['failed', 'error', 'crashed', 'timeout', 'timed_out', 'rejected'])
const STOPPED = new Set(['cancelled', 'interrupted', 'skipped'])

/** Activity groups: icon, word, and the filter each belongs to. */
const GROUPS = {
  run: { icon: 'rocket', word: 'run' },
  task: { icon: 'checklist', word: 'task' },
  agent: { icon: 'hubot', word: 'agent' },
  gate: { icon: 'beaker', word: 'check' },
  error: { icon: 'error', word: 'problem' }
}

const FEED_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'agent', label: 'Agents' },
  { id: 'gate', label: 'Checks' },
  { id: 'problem', label: 'Problems' }
]

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** jsx() with createElement's call shape: h(type, props, ...children). */
function h(type, props, ...children) {
  const p = props ? { ...props } : {}
  let key

  if (p.key !== undefined) {
    key = p.key
    delete p.key
  }

  if (children.length === 1) {
    p.children = children[0]
  } else if (children.length > 1) {
    p.children = children
  }

  return children.length > 1 ? jsxs(type, p, key) : jsx(type, p, key)
}

const cx = (...names) => names.filter(Boolean).join(' ')
const isRecord = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const list = v => (Array.isArray(v) ? v : [])
const enc = v => encodeURIComponent(String(v))
const validId = v => typeof v === 'string' && ID_RE.test(v)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** Untrusted value -> plain string for a text node (objects never print). */
function text(v) {
  if (typeof v === 'string') {
    return v
  }

  if (typeof v === 'number' && Number.isFinite(v)) {
    return String(v)
  }

  return ''
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function clip(v, max) {
  const s = text(v).replace(/\s+/g, ' ').trim()

  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/** Money: '—' for null/unknown (never $0.00 for null), '<$0.01' for crumbs. */
function money(v) {
  const n = num(v)

  if (n === null) {
    return '—'
  }

  if (n === 0) {
    return '$0.00'
  }

  if (Math.abs(n) < 0.01) {
    return '<$0.01'
  }

  return `$${n.toFixed(2)}`
}

function duration(ms) {
  const n = num(ms)

  if (n === null || n < 0) {
    return '—'
  }

  if (n < 10_000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}s`
  }

  const s = Math.round(n / 1000)

  if (s < 60) {
    return `${s}s`
  }

  const m = Math.floor(s / 60)

  if (m < 60) {
    return `${m}m ${String(s % 60).padStart(2, '0')}s`
  }

  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** A ticking clock face: 0:07, 4:12, 1:02:09. */
function clockFace(ms) {
  const n = num(ms)

  if (n === null || n < 0) {
    return '0:00'
  }

  const s = Math.floor(n / 1000)
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')

  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

function parseTime(v) {
  const t = typeof v === 'string' ? Date.parse(v) : NaN

  return Number.isFinite(t) ? t : null
}

/** Compact age: now, 42s, 5m, 3h, 2d. */
function ago(v, now = Date.now()) {
  const t = typeof v === 'number' ? v : parseTime(v)

  if (t === null) {
    return ''
  }

  const { unit, value } = coarseElapsed(now - t)

  if (unit === 'second') {
    return value < 5 ? 'now' : `${value}s`
  }

  return `${value}${unit[0]}`
}

function clock(ms) {
  if (num(ms) === null || ms <= 0) {
    return ''
  }

  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: '2-digit',
      hour12: false,
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return ''
  }
}

function stateInfo(state) {
  return STATES[state] ?? { glyph: '·', tone: 'muted', word: text(state) || 'unknown' }
}

function outcomeInfo(outcome, attempts) {
  if (outcome === 'running' && num(attempts) > 1) {
    return { glyph: '↻', tone: 'live', word: 'retrying' }
  }

  return OUTCOMES[outcome] ?? { glyph: '·', tone: 'muted', word: text(outcome) || 'pending' }
}

/** A task outcome as a graph node state. */
function nodeState(outcome) {
  const o = text(outcome) || 'pending'

  if (o === 'running') {
    return 'running'
  }

  if (PASSED.has(o)) {
    return 'passed'
  }

  if (FAILED.has(o)) {
    return 'failed'
  }

  if (o === 'blocked') {
    return 'blocked'
  }

  if (STOPPED.has(o)) {
    return 'stopped'
  }

  if (o === 'unverified') {
    return 'unverified'
  }

  return 'pending'
}

function isActiveRun(run) {
  return isRecord(run) && (run.active === true || ACTIVE_STATES.has(run.state))
}

function isHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden'
}

function errorText(error) {
  if (error instanceof Error) {
    return error.message
  }

  return typeof error === 'string' ? error : ''
}

function reducedMotion() {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  } catch {
    return false
  }
}

/** The modifier glyphs for a combo: mod+alt+r -> ⌘⌥R (Ctrl+Alt+R off macOS). */
function comboLabel(combo) {
  const parts = combo.split('+')
  const key = parts.pop() ?? ''
  const base = key === 'enter' ? '↵' : key === 'escape' ? 'Esc' : key.toUpperCase()
  const mods = parts.map(part => formatModifierToken(part))
  const joined = mods.every(m => m.length === 1) ? mods.join('') : mods.join('+') + (mods.length ? '+' : '')

  return `${joined}${base}`
}

/** roko titles a prompt run's one task "Request from chat host <host>": the run's own name says more. */
function taskTitle(task, run) {
  const title = text(task?.title)

  return /^Request from chat host\b/.test(title) ? text(run?.label) || 'The request' : title
}

/** A task's node id in the run graph: `plan/task` when the card names plans (docs/ui-api.md). */
function nodeIdOf(task) {
  return task.plan_id ? `${text(task.plan_id)}/${text(task.task_id)}` : text(task.task_id)
}

/** Waves and edges from depends_on, for cards from an older backend (no `graph`). */
function deriveGraph(tasks) {
  const ids = tasks.map(nodeIdOf).filter(Boolean)
  const known = new Set(ids)
  const needs = new Map(
    tasks.map(task => [
      nodeIdOf(task),
      new Set(
        list(task.depends_on)
          .map(dep => (task.plan_id ? `${text(task.plan_id)}/${text(dep)}` : text(dep)))
          .filter(dep => known.has(dep))
      )
    ])
  )
  const done = new Set()
  const waves = []

  while (done.size < ids.length && waves.length < 200) {
    const wave = ids.filter(id => !done.has(id) && [...(needs.get(id) ?? [])].every(dep => done.has(dep)))

    if (!wave.length) {
      waves.push(ids.filter(id => !done.has(id)))
      break
    }

    waves.push(wave)
    wave.forEach(id => done.add(id))
  }

  const edges = []

  ids.forEach(id => (needs.get(id) ?? new Set()).forEach(dep => edges.push([dep, id])))

  return { edges, waves }
}

/** The card's graph, checked: only waves of known node ids, only edges between them. */
function graphOf(run) {
  const tasks = list(run?.tasks).filter(isRecord)
  const raw = isRecord(run?.graph) ? run.graph : null
  const ids = new Set(tasks.map(nodeIdOf))

  if (raw && list(raw.waves).length) {
    const waves = list(raw.waves)
      .map(wave => list(wave).map(text).filter(id => ids.has(id)))
      .filter(wave => wave.length)
    const edges = list(raw.edges)
      .filter(edge => Array.isArray(edge) && ids.has(text(edge[0])) && ids.has(text(edge[1])))
      .map(edge => [text(edge[0]), text(edge[1])])

    if (waves.length) {
      return { edges, waves }
    }
  }

  return deriveGraph(tasks)
}

const EMPTY_PROGRESS = { blocked: 0, failed: 0, passed: 0, pending: 0, running: 0, stopped: 0, total: 0, unverified: 0 }

/** Where the run's tasks are: the card's `progress`, or counted from its tasks. */
function progressOf(run) {
  const p = isRecord(run?.progress) ? run.progress : null

  if (p && num(p.total) !== null) {
    return { ...EMPTY_PROGRESS, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, num(v) ?? 0])) }
  }

  const out = { ...EMPTY_PROGRESS }

  list(run?.tasks)
    .filter(isRecord)
    .forEach(task => {
      const state = nodeState(task.outcome)

      out.total += 1
      out[state === 'stopped' ? 'stopped' : state] = (out[state === 'stopped' ? 'stopped' : state] ?? 0) + 1
    })

  return out
}

/** The share of the run's tasks that ended (or half-ended while running), 0..1. */
function doneFraction(p) {
  if (!p.total) {
    return 0
  }

  return clamp((p.passed + p.failed + p.blocked + p.stopped + p.unverified + p.running * 0.5) / p.total, 0, 1)
}

/**
 * An agent line's attempt, model and provider: the line's own fields (0.3.0 backends), else parsed back
 * out of its text ("T1 attempt 2 on glm-5.1 (zai)").
 */
function parseAgentLine(event) {
  if (isRecord(event) && text(event.model)) {
    return { attempt: num(event.attempt), model: text(event.model), provider: text(event.provider) || null }
  }

  const m = /attempt (\d+) on (.+?)(?: \(([^)]*)\))?$/.exec(text(isRecord(event) ? event.text : event))

  return m ? { attempt: Number(m[1]), model: m[2], provider: m[3] ?? null } : null
}

/** A check line's gate (and verdict): the line's own fields, else parsed out of its text. */
function parseCheckLine(event, type) {
  if (isRecord(event) && text(event.gate)) {
    return { gate: text(event.gate), passed: type === 'gate_result' ? event.passed === true : null }
  }

  const s = text(isRecord(event) ? event.text : event)

  if (type === 'gate_rung_started') {
    const m = /checking (.+)$/.exec(s)

    return m ? { gate: m[1], passed: null } : null
  }

  const m = /gate (.+) (passed|did not pass)$/.exec(s)

  return m ? { gate: m[1], passed: m[2] === 'passed' } : null
}

// ---------------------------------------------------------------------------
// The backend: ctx.rest to /api/plugins/roko (docs/ui-api.md)
// ---------------------------------------------------------------------------

/** Doors bound in register(); null when the plugin is disabled. */
let doors = null

class RokoError extends Error {
  constructor({ kind, code, message, hint }) {
    super(message)
    this.name = 'RokoError'
    /** 'backend': ctx.rest rejected (router missing or crashed); 'roko': the route said ok:false. */
    this.kind = kind
    this.code = code
    this.hint = hint || ''
  }
}

async function call(path, options) {
  const rest = doors?.rest

  if (typeof rest !== 'function') {
    throw new RokoError({ code: 'inactive', kind: 'backend', message: 'The roko plugin is not active.' })
  }

  let reply

  try {
    reply = await rest(path, options)
  } catch (error) {
    const raw = errorText(error)
    const missing = /\b404\b/.test(raw) || !raw

    throw new RokoError({
      code: missing ? 'not_mounted' : 'backend',
      hint: RESTART_HINT,
      kind: 'backend',
      message: missing ? "roko's backend isn't loaded in Hermes." : `roko's backend failed: ${clip(raw, 200)}`
    })
  }

  if (!isRecord(reply)) {
    throw new RokoError({
      code: 'protocol',
      hint: RESTART_HINT,
      kind: 'backend',
      message: "roko's backend sent an unexpected reply."
    })
  }

  if (reply.ok !== true) {
    const e = isRecord(reply.error) ? reply.error : {}

    throw new RokoError({
      code: text(e.code) || 'internal',
      hint: text(e.hint),
      kind: 'roko',
      message: text(e.message) || 'roko reported an error.'
    })
  }

  return reply
}

const post = (path, body) => call(path, { body, method: 'POST' })

/** {title, message, hint} for any error a query or action produced. */
function describe(error) {
  if (error instanceof RokoError) {
    if (error.kind === 'backend') {
      return { hint: error.hint || RESTART_HINT, message: error.message, title: "roko's backend isn't available" }
    }

    return {
      hint: error.hint,
      message: error.message,
      title: error.code === 'unreachable' ? "Can't reach roko" : `roko: ${error.code.replace(/_/g, ' ')}`
    }
  }

  return { hint: '', message: errorText(error) || 'Something went wrong.', title: 'Something went wrong' }
}

/** An action's failure as one sentence for a dialog's inline error. */
function failureLine(error) {
  const d = describe(error)
  const message = /[.!?]$/.test(d.message) ? d.message : `${d.message}.`

  return d.hint ? `${message} ${d.hint.charAt(0).toUpperCase()}${d.hint.slice(1)}${/[.!?]$/.test(d.hint) ? '' : '.'}` : d.message
}

function refreshAll() {
  void queryClient.invalidateQueries({ queryKey: KEYS.all })
}

function afterChange(runId) {
  void queryClient.invalidateQueries({ queryKey: KEYS.overview })
  void queryClient.invalidateQueries({ queryKey: KEYS.pending })

  if (validId(runId)) {
    void queryClient.invalidateQueries({ queryKey: KEYS.run(runId) })
    void queryClient.invalidateQueries({ queryKey: KEYS.diff(runId) })
    void queryClient.invalidateQueries({ queryKey: KEYS.merge(runId) })
  }
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

const fetchOverview = () => call('/overview')

/** The ONE overview key: chip, page, sidebar label and notifications share it. */
function useOverview() {
  return useQuery({ queryFn: fetchOverview, queryKey: KEYS.overview, retry: false, staleTime: OVERVIEW_MS - 1_000 })
}

/**
 * What the backend lets this UI do, from the shared overview. Unknown means allowed: the backend checks
 * every action again, so this only hides buttons that would be refused.
 */
function useLimits() {
  const overview = useOverview()
  const data = isRecord(overview.data) ? overview.data : {}
  const permissions = isRecord(data.permissions) ? data.permissions : {}
  const limits = isRecord(data.limits) ? data.limits : {}
  const spend = isRecord(data.spend) ? data.spend : {}

  return {
    canAct: permissions.write !== false,
    left: num(spend.left_usd),
    maxDay: num(limits.max_day_usd),
    maxRun: num(limits.max_run_usd),
    today: num(spend.today_usd)
  }
}

/** The most a new run may cap itself at: the per-run cap and what is left today, whichever is lower. */
function capCeiling({ left, maxRun }) {
  return maxRun !== null && left !== null ? Math.min(maxRun, left) : (maxRun ?? left)
}

function usePending() {
  return useQuery({
    queryFn: () => call('/pending').then(r => list(r.items)),
    queryKey: KEYS.pending,
    refetchInterval: () => (isHidden() ? OVERVIEW_HIDDEN_MS : OVERVIEW_MS),
    retry: false,
    staleTime: 5_000
  })
}

/** A fresh run card updates the run's row in the shared overview at once, not at the next 10 s poll. */
function patchOverviewRow(run) {
  if (!isRecord(run) || !validId(run.run_id)) {
    return run
  }

  queryClient.setQueryData(KEYS.overview, old => {
    if (!isRecord(old) || !Array.isArray(old.runs)) {
      return old
    }

    let changed = false
    const runs = old.runs.map(row => {
      if (!isRecord(row) || row.run_id !== run.run_id) {
        return row
      }

      const next = {
        ...row,
        active: typeof run.active === 'boolean' ? run.active : row.active,
        cost_usd: num(run.cost_usd) ?? row.cost_usd,
        finished_at: text(run.finished_at) || row.finished_at,
        progress: isRecord(run.progress) ? run.progress : row.progress,
        state: text(run.state) || row.state
      }

      changed =
        changed ||
        ['active', 'cost_usd', 'finished_at', 'state'].some(key => next[key] !== row[key]) ||
        JSON.stringify(next.progress) !== JSON.stringify(row.progress)

      return next
    })

    return changed ? { ...old, runs } : old
  })

  return run
}

function useRun(runId, enabled = true) {
  return useQuery({
    enabled: enabled && validId(runId),
    queryFn: () => call(`/runs/${enc(runId)}`).then(r => patchOverviewRow(isRecord(r.run) ? r.run : null)),
    queryKey: KEYS.run(runId),
    // Poll every 3 s while the run is active (or roko is writing a plan); stop once it ends.
    refetchInterval: query => (isActiveRun(query.state.data) ? RUN_MS : false),
    retry: false,
    staleTime: 2_000
  })
}

/** What an ended run changed (GET /runs/{id}/diff): files with parsed hunks. */
function useDiff(runId, enabled) {
  return useQuery({
    enabled: enabled && validId(runId),
    queryFn: () => call(`/runs/${enc(runId)}/diff?max_files=150`).then(r => (isRecord(r.diff) ? r.diff : null)),
    queryKey: KEYS.diff(runId),
    retry: false,
    staleTime: 60_000
  })
}

/** Whether Merge would work now (GET /runs/{id}/merge): changes nothing. */
function useMergeCheck(runId, enabled) {
  return useQuery({
    enabled: enabled && validId(runId),
    queryFn: () => call(`/runs/${enc(runId)}/merge`).then(r => (isRecord(r.merge) ? r.merge : null)),
    queryKey: KEYS.merge(runId),
    retry: false,
    staleTime: 5_000
  })
}

function usePlans() {
  return useQuery({
    queryFn: () => call('/plans').then(r => list(r.plans)),
    queryKey: KEYS.plans,
    retry: false,
    staleTime: 30_000
  })
}

function usePlan(planId) {
  return useQuery({
    enabled: validId(planId),
    queryFn: () => call(`/plans/${enc(planId)}`).then(r => (isRecord(r.plan) ? r.plan : null)),
    queryKey: KEYS.plan(planId),
    retry: false,
    staleTime: 30_000
  })
}

function useKnowledge(q) {
  return useQuery({
    enabled: q.length >= 2,
    placeholderData: previous => previous,
    queryFn: () => call(`/knowledge?q=${enc(q)}&limit=20`).then(r => list(r.entries)),
    queryKey: KEYS.knowledge(q),
    retry: false,
    staleTime: 60_000
  })
}

function useHealth() {
  return useQuery({
    queryFn: () => call('/health').then(r => list(r.checks)),
    queryKey: KEYS.health,
    retry: false,
    staleTime: 30_000
  })
}

function useInsights() {
  return useQuery({ queryFn: () => call('/insights'), queryKey: KEYS.insights, retry: false, staleTime: 60_000 })
}

/** When the backend is missing, the Python half's /roko slash command may still answer. */
function useStatusText(enabled) {
  return useQuery({
    enabled,
    queryFn: async () => {
      const out = await host.request('command.dispatch', { arg: 'status', name: 'roko' })

      return isRecord(out) && typeof out.output === 'string' ? out.output : ''
    },
    queryKey: KEYS.statusText,
    retry: false,
    staleTime: 30_000
  })
}

function useDebounced(value, ms) {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms)

    return () => clearTimeout(timer)
  }, [value, ms])

  return settled
}

/** Re-render every `ms` (ages, countdowns). */
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)

    return () => clearInterval(timer)
  }, [ms])

  return now
}

/**
 * One shared 1 s tick for every live clock on screen: only the components that read it re-render, and the
 * interval exists only while something reads it.
 */
const $tick = atom(Date.now())
let tickUsers = 0
let tickTimer = null

function useTick(enabled = true) {
  useEffect(() => {
    if (!enabled) {
      return undefined
    }

    tickUsers += 1

    if (!tickTimer) {
      $tick.set(Date.now())
      tickTimer = setInterval(() => $tick.set(Date.now()), 1_000)
    }

    return () => {
      tickUsers -= 1

      if (tickUsers <= 0 && tickTimer) {
        clearInterval(tickTimer)
        tickTimer = null
        tickUsers = 0
      }
    }
  }, [enabled])

  const now = useValue($tick)

  return enabled ? now : Date.now()
}

/** An element's width, kept up to date (jsdom has no layout: then `fallback`). */
function useWidth(ref, fallback) {
  const [width, setWidth] = useState(fallback)

  useEffect(() => {
    const el = ref.current

    if (!el) {
      return undefined
    }

    const measure = () => {
      const w = el.clientWidth || el.getBoundingClientRect?.().width || 0

      if (w > 0) {
        setWidth(prev => (Math.abs(prev - w) >= 2 ? Math.round(w) : prev))
      }
    }

    measure()

    if (typeof ResizeObserver === 'undefined') {
      return undefined
    }

    const observer = new ResizeObserver(measure)

    observer.observe(el)

    return () => observer.disconnect()
  }, [ref])

  return width
}

// ---------------------------------------------------------------------------
// Navigation: the selection lives in location.hash (#/roko#run=<id>); the
// app's hash router keeps routing on /roko. hermes://open/roko?run=<id> lands
// as #/roko?run=<id>, which reads the same way. `&view=changes` opens a run on
// its changes (the chat card's "Review changes").
// ---------------------------------------------------------------------------

const $tab = atom('runs')
const $run = atom(null)
const $plan = atom(null)
const $runView = atom('overview')
/** The task the inspector shows, per run: {runId, nodeId}. */
const $inspect = atom(null)
/** The composer: closed, or open with a draft. */
const $composer = atom({ mode: 'run', open: false, prompt: '' })

function readView(hash) {
  const raw = typeof hash === 'string' ? hash : ''
  const view = {}

  for (const [key, re] of [
    ['tab', /[?#&]tab=([^&#]+)/],
    ['run', /[?#&]run=([^&#]+)/],
    ['plan', /[?#&]plan=([^&#]+)/],
    ['view', /[?#&]view=([^&#]+)/]
  ]) {
    const match = re.exec(raw.slice(1))

    if (!match) {
      continue
    }

    let value = ''

    try {
      value = decodeURIComponent(match[1])
    } catch {
      continue
    }

    const ok = key === 'tab' ? TABS.includes(value) : key === 'view' ? RUN_VIEWS.includes(value) : validId(value)

    if (ok) {
      view[key] = value
    }
  }

  return view
}

function applyView(view) {
  if (view.run) {
    $run.set(view.run)
    $runView.set(view.view ?? 'overview')
  }

  if (view.plan) {
    $plan.set(view.plan)
  }

  const tab = view.tab ?? (view.run ? 'runs' : view.plan ? 'plans' : null)

  if (tab) {
    $tab.set(tab)
  }
}

function pathFor(view = {}) {
  if (validId(view.run)) {
    const sub = view.view && view.view !== 'overview' && RUN_VIEWS.includes(view.view) ? `&view=${view.view}` : ''

    return `${PAGE}#run=${enc(view.run)}${sub}`
  }

  if (validId(view.plan)) {
    return `${PAGE}#plan=${enc(view.plan)}`
  }

  return view.tab && view.tab !== 'runs' ? `${PAGE}#tab=${view.tab}` : PAGE
}

/** Mirror the selection into the URL without adding history entries. */
function replaceView(view) {
  try {
    if (typeof window === 'undefined' || !window.location.hash.startsWith(`#${PAGE}`)) {
      return
    }

    window.history.replaceState(window.history.state, '', `#${pathFor(view)}`)
  } catch {
    // The URL is a convenience; the atoms are the source of truth.
  }
}

/** Navigate to the page (optionally a tab, a run, or a run's view) from anywhere. */
function openRoko(view = {}) {
  applyView({ ...view, tab: view.tab ?? (view.run ? 'runs' : view.plan ? 'plans' : 'runs') })
  host.navigate(pathFor(view))
}

function selectRun(runId, view = 'overview') {
  if (validId(runId)) {
    $run.set(runId)
    $runView.set(view)
    $tab.set('runs')
    replaceView({ run: runId, view })
  }
}

function setRunView(runId, view) {
  if (RUN_VIEWS.includes(view)) {
    $runView.set(view)
    replaceView({ run: runId, view })
  }
}

function useLocationSync() {
  useEffect(() => {
    const sync = () => applyView(readView(window.location.hash))

    sync()
    window.addEventListener('hashchange', sync)
    window.addEventListener('popstate', sync)

    return () => {
      window.removeEventListener('hashchange', sync)
      window.removeEventListener('popstate', sync)
    }
  }, [])
}

function openComposer(draft = {}) {
  const current = $composer.get()

  $composer.set({ ...current, ...draft, open: true })
}

function closeComposer() {
  $composer.set({ ...$composer.get(), open: false })
}

/** True when a keystroke should go to a text field, not to the page's shortcuts. */
function typingIn(event) {
  const el = event.target

  if (!el || typeof el.closest !== 'function') {
    return false
  }

  return Boolean(el.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"]'))
}

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------

function Dot({ tone, label, pulse }) {
  return h('span', {
    'aria-label': label,
    className: 'roko-dot',
    'data-pulse': pulse ? 'true' : undefined,
    'data-tone': tone,
    role: label ? 'img' : undefined
  })
}

function Glyph({ info, title }) {
  return h(
    'span',
    { 'aria-label': title ?? info.word, className: 'roko-glyph', 'data-tone': info.tone, role: 'img' },
    info.glyph
  )
}

function StatePill({ state }) {
  const info = stateInfo(state)

  return h(
    'span',
    { className: 'roko-pill', 'data-state': text(state), 'data-tone': info.tone },
    h('span', { 'aria-hidden': 'true', className: 'roko-pill-glyph' }, info.glyph),
    ' ',
    info.word
  )
}

function KindBadge({ kind }) {
  const word = kind === 'plan_generate' ? 'plan writing' : kind === 'plan' ? 'plan run' : kind === 'run' ? 'task' : text(kind)

  return word ? h('span', { className: 'roko-kind' }, word) : null
}

function SectionLabel({ children, right }) {
  return h('div', { className: 'roko-section-label' }, h('span', null, children), right ?? null)
}

function Spinner({ label }) {
  return h(
    'span',
    { className: 'roko-loading' },
    h(GlyphSpinner, { ariaLabel: label || 'Loading', className: 'roko-spinner' }),
    label ? h('span', null, label) : null
  )
}

function Empty({ icon = 'inbox', title, children }) {
  return h(
    'div',
    { className: 'roko-empty' },
    h('span', { className: 'roko-empty-icon' }, h(Codicon, { name: icon, size: '1.15rem' })),
    h('div', { className: 'roko-empty-title' }, title),
    children ? h('div', { className: 'roko-empty-text' }, children) : null
  )
}

/** Per-section error with Retry; keeps whatever data the section still shows. */
function ErrorNote({ error, onRetry, lastChecked, compact }) {
  const d = describe(error)

  return h(
    'div',
    { className: 'roko-error', 'data-compact': compact ? 'true' : undefined, role: 'alert' },
    h(Codicon, { className: 'roko-error-icon', name: 'warning', size: '0.9rem' }),
    h(
      'div',
      { className: 'roko-error-body' },
      h('div', { className: 'roko-error-title' }, d.title),
      h('div', { className: 'roko-error-text' }, d.message),
      d.hint ? h('div', { className: 'roko-error-hint' }, d.hint) : null,
      lastChecked ? h('div', { className: 'roko-error-hint' }, `Showing the last data · last checked ${clock(lastChecked)}`) : null
    ),
    onRetry
      ? h(Button, { onClick: () => onRetry(), size: 'xs', type: 'button', variant: 'outline' }, 'Retry')
      : null
  )
}

/**
 * Cost meter: spent against the cap, amber at 80 %, red at 95 %, '—' when unknown. While a run is going,
 * `projected` (spent ÷ share of the work done) draws as a ghost segment, so a run heading past its cap shows it.
 */
function CostMeter({ spent, cap, compact, projected }) {
  const s = num(spent)
  const c = num(cap)
  const ratio = s !== null && c !== null && c > 0 ? Math.min(1, s / c) : null
  const ghost = ratio !== null && num(projected) !== null && projected > s ? Math.min(1, projected / c) : null
  const level = ratio === null ? 'none' : ratio >= 0.95 ? 'bad' : ratio >= 0.8 ? 'warn' : 'ok'
  const meter = h(
    'span',
    { className: 'roko-meter', 'data-compact': compact ? 'true' : undefined, 'data-level': level },
    h('span', { className: 'roko-meter-text' }, h('span', { className: 'roko-strong' }, money(s)), ' / ', money(c)),
    h(
      'span',
      { 'aria-hidden': 'true', className: 'roko-meter-track' },
      ghost !== null ? h('span', { className: 'roko-meter-ghost', style: { width: `${Math.round(ghost * 100)}%` } }) : null,
      h('span', { className: 'roko-meter-fill', style: { width: `${Math.round((ratio ?? 0) * 100)}%` } }),
      c !== null ? h('span', { className: 'roko-meter-tick' }) : null
    )
  )

  return ghost !== null ? h(Tip, { label: `≈ ${money(projected)} at this rate, cap ${money(c)}` }, meter) : meter
}

/** Clamped untrusted text with a Show more toggle. */
function Clamp({ value, lines = 4, mono }) {
  const content = text(value)
  const [open, setOpen] = useState(false)
  const long = content.length > 240 || content.split('\n').length > lines

  if (!content) {
    return null
  }

  return h(
    'div',
    { className: 'roko-clamp' },
    h(
      'div',
      {
        className: cx('roko-clamp-text', mono && 'roko-mono'),
        'data-open': open || !long ? 'true' : 'false',
        style: { '--roko-lines': String(lines) }
      },
      content
    ),
    long
      ? h(
          'button',
          { className: 'roko-link', onClick: () => setOpen(v => !v), type: 'button' },
          open ? 'Show less' : 'Show more'
        )
      : null
  )
}

async function writeClipboard(value) {
  try {
    return Boolean(await doors?.os?.writeClipboard?.(value))
  } catch {
    return false
  }
}

function CopyCommand({ label, command, variant = 'outline' }) {
  const [state, setState] = useState('idle')
  const timer = useRef(null)
  const cmd = text(command)

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!cmd) {
    return null
  }

  const copy = async () => {
    const ok = await writeClipboard(cmd)

    setState(ok ? 'copied' : 'failed')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1_600)
  }

  return h(
    Tip,
    { label: cmd },
    h(
      Button,
      { onClick: () => void copy(), size: 'xs', type: 'button', variant },
      h(Codicon, { name: state === 'copied' ? 'check' : 'copy', size: '0.75rem' }),
      state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label
    )
  )
}

/** A mono id that copies itself. */
function CopyId({ value, shown, label = 'Copy id' }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!text(value)) {
    return null
  }

  return h(
    Tip,
    { label: copied ? 'Copied' : `${label}: ${text(value)}` },
    h(
      'button',
      {
        'aria-label': `${label} ${text(value)}`,
        className: 'roko-copyid',
        onClick: async () => {
          if (await writeClipboard(text(value))) {
            setCopied(true)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1_400)
          }
        },
        type: 'button'
      },
      text(shown ?? value),
      h(Codicon, { name: copied ? 'check' : 'copy', size: '0.7rem' })
    )
  )
}

/** Deadline for a held confirm: only when roko says when it stops waiting. */
function Countdown({ deadline }) {
  const at = parseTime(deadline)
  const now = useNow(1_000)

  if (at === null) {
    return null
  }

  const left = Math.round((at - now) / 1000)

  if (left <= 0) {
    return h('span', { className: 'roko-countdown', 'data-tone': 'bad' }, 'deadline passed')
  }

  const m = Math.floor(left / 60)
  const s = String(left % 60).padStart(2, '0')

  return h(
    Tip,
    { label: `roko stops waiting at ${clock(at)}; the task then ends unverified` },
    h(
      'span',
      { className: 'roko-countdown', 'data-tone': left <= 60 ? 'bad' : left <= 300 ? 'warn' : 'muted' },
      h(Codicon, { name: 'clock', size: '0.75rem' }),
      `${m}:${s} left`
    )
  )
}

/** Segments for a progress shape, in drawing order. */
function segmentsOf(p) {
  return [
    ['passed', p.passed],
    ['failed', p.failed],
    ['blocked', p.blocked],
    ['unverified', p.unverified],
    ['stopped', p.stopped],
    ['running', p.running]
  ].filter(([, n]) => n > 0)
}

/** A ring of the run's tasks: passed, failed, blocked, running (spinning), pending track. */
function ProgressRing({ progress, size = 44, stroke = 5, label = true }) {
  const p = progress ?? EMPTY_PROGRESS
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const total = Math.max(1, p.total)
  let offset = 0
  const gap = segmentsOf(p).length > 1 ? Math.min(2.5, c / (total * 6)) : 0
  const arcs = segmentsOf(p).map(([kind, n]) => {
    const len = (n / total) * c
    const arc = h('circle', {
      className: 'roko-ring-arc',
      cx: size / 2,
      cy: size / 2,
      'data-kind': kind,
      fill: 'none',
      key: kind,
      r,
      strokeDasharray: `${Math.max(0, len - gap)} ${c}`,
      strokeDashoffset: -offset,
      strokeWidth: stroke
    })

    offset += len

    return arc
  })
  const aria = p.total ? `${p.passed} of ${plural(p.total, 'task')} passed${p.running ? `, ${p.running} running` : ''}` : 'no tasks yet'

  return h(
    'span',
    { 'aria-label': aria, className: 'roko-ring', role: 'img', style: { height: size, width: size } },
    h(
      'svg',
      { 'aria-hidden': 'true', height: size, viewBox: `0 0 ${size} ${size}`, width: size },
      h('circle', { className: 'roko-ring-track', cx: size / 2, cy: size / 2, fill: 'none', r, strokeWidth: stroke }),
      h('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` }, arcs)
    ),
    label && p.total
      ? h('span', { className: 'roko-ring-label' }, h('b', null, String(p.passed)), h('i', null, `/${p.total}`))
      : null
  )
}

/** The same, flat: a segmented bar for lists and chat cards. */
function SegBar({ progress, height = 4 }) {
  const p = progress ?? EMPTY_PROGRESS

  if (!p.total) {
    return null
  }

  return h(
    'span',
    { 'aria-hidden': 'true', className: 'roko-segbar', style: { height } },
    segmentsOf(p).map(([kind, n]) =>
      h('span', { className: 'roko-segbar-seg', 'data-kind': kind, key: kind, style: { flexGrow: n } })
    ),
    p.pending ? h('span', { className: 'roko-segbar-seg', 'data-kind': 'pending', style: { flexGrow: p.pending } }) : null
  )
}

/** A live clock from `startMs` (or a fixed duration once ended). */
function Clock({ startMs, endMs, fixedMs, live }) {
  const now = useTick(Boolean(live))
  let ms = num(fixedMs)

  if (live && num(startMs) !== null) {
    ms = Math.max(0, now - startMs)
  } else if (ms === null && num(startMs) !== null && num(endMs) !== null) {
    ms = Math.max(0, endMs - startMs)
  }

  return h('span', { className: 'roko-clock', 'data-live': live ? 'true' : undefined }, ms === null ? '—' : clockFace(ms))
}

/** How long a task has been on its current step, ticking. */
function StepClock({ since }) {
  const at = parseTime(since)
  const now = useTick(at !== null)

  return at === null ? null : h('span', { className: 'roko-stepclock' }, clockFace(Math.max(0, now - at)))
}

/** One pip per check: filled when it passed or did not, hollow while it waits, pulsing while it runs. */
function GatePips({ gates, max = 8 }) {
  const shown = gates.slice(0, max)

  if (!shown.length) {
    return null
  }

  return h(
    'span',
    { className: 'roko-pips' },
    shown.map((gate, index) =>
      h('span', {
        'aria-label': `${text(gate.gate)}: ${gate.passed === true ? 'passed' : gate.passed === false ? 'did not pass' : gate.running ? 'running' : 'waiting'}`,
        className: 'roko-pip',
        'data-state': gate.passed === true ? 'pass' : gate.passed === false ? 'fail' : gate.running ? 'run' : 'wait',
        key: `${text(gate.gate)}:${index}`,
        role: 'img',
        title: text(gate.gate)
      })
    ),
    gates.length > max ? h('span', { className: 'roko-pips-more' }, `+${gates.length - max}`) : null
  )
}

function Instrument({ label, children, testId, wide }) {
  return h(
    'div',
    { className: 'roko-instrument', 'data-testid': testId, 'data-wide': wide ? 'true' : undefined },
    h('span', { className: 'roko-instrument-label' }, label),
    h('span', { className: 'roko-instrument-value' }, children)
  )
}

function ModelChip({ model, provider }) {
  if (!text(model)) {
    return null
  }

  const chip = h('span', { className: 'roko-model' }, h(Codicon, { name: 'hubot', size: '0.7rem' }), clip(model, 28))

  return provider ? h(Tip, { label: `${text(model)} via ${text(provider)}` }, chip) : chip
}

/** ⌘⌥R as keycaps. */
function Keys({ combo }) {
  return h('span', { 'aria-hidden': 'true', className: 'roko-keys' }, h(Kbd, { size: 'sm', variant: 'ghost' }, comboLabel(combo)))
}

/** A git path: the directory quiet, the file name bright. */
function PathText({ path }) {
  const p = text(path)
  const cut = p.lastIndexOf('/')

  return h(
    'span',
    { className: 'roko-path' },
    cut >= 0 ? h('span', { className: 'roko-path-dir' }, p.slice(0, cut + 1)) : null,
    h('span', { className: 'roko-path-base' }, cut >= 0 ? p.slice(cut + 1) : p)
  )
}

/** +A −D with a 5-cell bar, as git's --stat draws it. */
function DiffStat({ additions, deletions, cells = 5 }) {
  const a = num(additions) ?? 0
  const d = num(deletions) ?? 0
  const total = a + d
  const adds = total ? Math.round((a / total) * cells) : 0
  const dels = total ? Math.min(cells - adds, Math.round((d / total) * cells)) : 0

  return h(
    'span',
    { className: 'roko-diffstat' },
    h('span', { className: 'roko-add' }, `+${a}`),
    h('span', { className: 'roko-del' }, `−${d}`),
    h(
      'span',
      { 'aria-hidden': 'true', className: 'roko-statcells' },
      Array.from({ length: cells }, (_, i) =>
        h('span', { 'data-kind': i < adds ? 'add' : i < adds + dels ? 'del' : 'none', key: i })
      )
    )
  )
}

// ---------------------------------------------------------------------------
// The run graph: waves of tasks, their dependencies, and where each one is
// ---------------------------------------------------------------------------

const GRAPH = { gapMax: 64, gapMin: 28, gapY: 12, maxW: 236, minW: 150, nodeH: 78, padBottom: 10, padTop: 26, padX: 10 }

/**
 * The checks of a task's latest attempt as pips, plus the one running now. An attempt that has not reached
 * its checks has none: the task's `gates` hold earlier attempts' verdicts, so they stand in only for a
 * backend that sends no `attempt_log` (0.2.0).
 */
function taskGates(task) {
  const log = list(task.attempt_log).filter(isRecord)
  const latest = log.length ? log[log.length - 1] : null
  const gates = latest
    ? list(latest.gates).filter(isRecord).map(g => ({ gate: text(g.gate), passed: g.passed === true ? true : g.passed === false ? false : null }))
    : list(task.gates).filter(isRecord).map(g => ({ gate: text(g.gate), passed: g.passed === true }))

  if (task.step === 'check' && text(task.step_detail) && !gates.some(g => g.gate === text(task.step_detail) && g.passed !== null)) {
    gates.push({ gate: text(task.step_detail), passed: null, running: true })
  }

  return gates
}

/** A card task as a graph node, optionally overridden by a replay's state at some moment. */
function taskNode(task, replay, run) {
  const base = {
    attempts: num(task.attempts) ?? 0,
    blockedBy: text(task.blocked_by),
    cost: num(task.cost_usd),
    durationMs: num(task.duration_ms),
    gates: taskGates(task),
    id: nodeIdOf(task),
    model: text(task.model),
    outcome: text(task.outcome) || 'pending',
    provider: text(task.provider),
    step: text(task.step) || null,
    stepDetail: text(task.step_detail) || null,
    stepSince: text(task.step_since) || null,
    taskId: text(task.task_id),
    title: taskTitle(task, run),
    waiting: list(run?.waiting).some(item => isRecord(item) && text(item.task_id) === text(task.task_id))
  }

  if (replay) {
    const r = replay.get(base.taskId)

    return withState({
      ...base,
      attempts: r?.attempts ?? 0,
      durationMs: null,
      gates: r ? r.gates : [],
      model: r?.model ?? '',
      outcome: r?.outcome ?? 'pending',
      replay: true,
      step: r?.step ?? null,
      stepDetail: r?.detail ?? null,
      stepSince: null
    })
  }

  return withState(base)
}

function withState(node) {
  return { ...node, state: nodeState(node.outcome) }
}

/** What a node is doing now, as a few words: "checking verify[0:test]", "agent · glm-5.1". */
function stepWords(node) {
  if (node.waiting && node.state === 'running') {
    return 'waiting on you'
  }

  if (node.step === 'check') {
    return `checking ${node.stepDetail || '…'}`
  }

  if (node.step === 'agent') {
    return node.attempts > 1 ? `attempt ${node.attempts} · ${node.stepDetail || node.model || 'agent'}` : `agent · ${node.stepDetail || node.model || 'working'}`
  }

  if (node.step === 'agent done') {
    return 'agent finished · checking next'
  }

  if (node.step === 'starting') {
    return 'starting'
  }

  return node.state === 'running' ? 'working' : ''
}

function layoutGraph(waves, width) {
  const cols = Math.max(1, waves.length)
  const avail = Math.max(240, width - GRAPH.padX * 2)
  const gap = cols > 1 ? clamp(avail * 0.07, GRAPH.gapMin, GRAPH.gapMax) : 0
  const nodeW = clamp((avail - gap * (cols - 1)) / cols, GRAPH.minW, GRAPH.maxW)
  const contentW = cols * nodeW + (cols - 1) * gap
  const offsetX = GRAPH.padX + Math.max(0, (avail - contentW) / 2)
  const rows = Math.max(1, ...waves.map(wave => wave.length))
  const colH = n => n * GRAPH.nodeH + Math.max(0, n - 1) * GRAPH.gapY
  const positions = new Map()

  waves.forEach((wave, i) => {
    const x = offsetX + i * (nodeW + gap)
    const top = GRAPH.padTop + (colH(rows) - colH(wave.length)) / 2

    wave.forEach((id, j) => positions.set(id, { h: GRAPH.nodeH, w: nodeW, wave: i, x, y: top + j * (GRAPH.nodeH + GRAPH.gapY) }))
  })

  return {
    height: GRAPH.padTop + colH(rows) + GRAPH.padBottom,
    nodeW,
    positions,
    waveX: waves.map((_, i) => offsetX + i * (nodeW + gap)),
    width: Math.max(width, Math.ceil(offsetX + contentW + GRAPH.padX))
  }
}

function edgePath(a, b) {
  const x1 = a.x + a.w
  const y1 = a.y + a.h / 2
  const x2 = b.x
  const y2 = b.y + b.h / 2
  const dx = Math.max(18, (x2 - x1) * 0.5)

  return { d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 4} ${y2}`, x2, y2 }
}

function edgeState(from, to) {
  if (to?.state === 'running') {
    return 'live'
  }

  if (to?.state === 'blocked') {
    return 'blocked'
  }

  if (from?.state === 'passed') {
    return 'done'
  }

  if (from?.state === 'failed') {
    return 'broken'
  }

  return 'idle'
}

const NodeMark = memo(function NodeMark({ node }) {
  if (node.state === 'running') {
    return h('span', { 'aria-hidden': 'true', className: 'roko-node-spin' })
  }

  if (node.state === 'blocked' || node.state === 'stopped') {
    return h('span', { 'aria-hidden': 'true', className: 'roko-node-mark', 'data-tone': node.state === 'blocked' ? 'warn' : 'muted' }, h(Codicon, { name: 'circle-slash', size: '0.72rem' }))
  }

  const info = outcomeInfo(node.outcome, node.attempts)

  return node.state === 'pending' ? null : h('span', { 'aria-hidden': 'true', className: 'roko-node-mark', 'data-tone': info.tone }, info.glyph)
})

function GraphNode({ node, pos, selected, onSelect, planOnly }) {
  const info = outcomeInfo(node.outcome, node.attempts)
  const words = node.state === 'running' ? stepWords(node) : ''
  const label = [`${node.taskId} ${node.title}`, planOnly ? '' : info.word, words].filter(Boolean).join(', ')
  let foot

  if (planOnly) {
    foot = h(
      'span',
      { className: 'roko-node-foot' },
      node.checks ? h('span', { className: 'roko-node-meta' }, h(Codicon, { name: 'beaker', size: '0.7rem' }), plural(node.checks, 'check')) : h('span', { className: 'roko-node-meta' }, 'no checks'),
      node.deps ? h('span', { className: 'roko-node-meta' }, `after ${node.deps}`) : null
    )
  } else if (node.state === 'running') {
    foot = h(
      'span',
      { className: 'roko-node-foot' },
      h('span', { className: 'roko-node-step' }, words),
      node.replay ? null : h(StepClock, { since: node.stepSince })
    )
  } else if (node.state === 'blocked') {
    foot = h('span', { className: 'roko-node-foot' }, h('span', { className: 'roko-node-meta' }, node.blockedBy ? `blocked by ${clip(node.blockedBy, 24)}` : 'blocked'))
  } else {
    foot = h(
      'span',
      { className: 'roko-node-foot' },
      node.model ? h('span', { className: 'roko-node-meta roko-node-model' }, clip(node.model, 18)) : h('span', { className: 'roko-node-meta' }, node.state === 'pending' ? 'waiting' : info.word),
      num(node.durationMs) !== null ? h('span', { className: 'roko-node-meta' }, duration(node.durationMs)) : null,
      h(GatePips, { gates: node.gates, max: 6 })
    )
  }

  return h(
    'button',
    {
      'aria-label': label,
      'aria-pressed': selected ? 'true' : 'false',
      className: 'roko-node',
      'data-node': node.id,
      'data-selected': selected ? 'true' : 'false',
      'data-state': planOnly ? 'plan' : node.state,
      onClick: () => onSelect?.(node.id),
      style: { height: pos.h, left: pos.x, top: pos.y, width: pos.w },
      type: 'button'
    },
    h(
      'span',
      { className: 'roko-node-corner' },
      node.attempts > 1 && !planOnly ? h('span', { className: 'roko-node-attempts', title: plural(node.attempts, 'attempt') }, `×${node.attempts}`) : null,
      planOnly ? null : h(NodeMark, { node })
    ),
    h(
      'span',
      { className: 'roko-node-top', title: node.title || node.taskId },
      h('span', { className: 'roko-node-id' }, clip(node.taskId, 14)),
      ' ',
      h('span', { className: 'roko-node-title' }, node.title || node.taskId)
    ),
    foot
  )
}

/**
 * The graph itself. `nodes` maps node ids to node view models; `waves` and `edges` come from the card
 * (or a plan). Nodes are buttons over an SVG layer of edges, so they keep focus rings, ellipsis and
 * transitions; the canvas scrolls sideways inside its own frame when it is wider than the panel.
 */
function RunGraph({ nodes, waves, edges, selected, onSelect, planOnly, testId }) {
  const frame = useRef(null)
  const width = useWidth(frame, 860)
  const layout = useMemo(() => layoutGraph(waves, width), [JSON.stringify(waves), width])

  if (!waves.length) {
    return null
  }

  return h(
    'div',
    { className: 'roko-graph-frame', 'data-testid': testId, ref: frame },
    h(
      'div',
      { className: 'roko-graph', style: { height: layout.height, width: layout.width } },
      h(
        'svg',
        { 'aria-hidden': 'true', className: 'roko-graph-edges', height: layout.height, width: layout.width },
        waves.length > 1
          ? layout.waveX.map((x, i) =>
              h('text', { className: 'roko-wave-label', key: `w${i}`, x: x + 2, y: 14 }, `W${i + 1}`)
            )
          : null,
        edges.map(([from, to]) => {
          const a = layout.positions.get(from)
          const b = layout.positions.get(to)

          if (!a || !b) {
            return null
          }

          const state = planOnly ? 'idle' : edgeState(nodes.get(from), nodes.get(to))
          const path = edgePath(a, b)

          return h(
            'g',
            { 'data-state': state, key: `${from}>${to}` },
            h('path', { className: 'roko-edge', d: path.d, 'data-state': state }),
            h('circle', { className: 'roko-edge-end', cx: path.x2 - 3, cy: path.y2, 'data-state': state, r: 2.6 })
          )
        })
      ),
      waves.length === 1
        ? h('span', { className: 'roko-wave-label roko-wave-label-html', style: { left: layout.waveX[0] + 2 } }, planOnly ? 'one wave' : 'one task')
        : null,
      waves.flat().map(id => {
        const node = nodes.get(id)
        const pos = layout.positions.get(id)

        return node && pos ? h(GraphNode, { key: id, node, onSelect, planOnly, pos, selected: selected === id }) : null
      })
    )
  )
}

/** The graph in miniature for chat cards and lists: a dot per task, wave columns, hairline edges. */
function MiniGraph({ run, max = 14 }) {
  const tasks = list(run?.tasks).filter(isRecord)
  const graph = graphOf(run)
  const waves = graph.waves.slice(0, max)

  if (tasks.length < 2 || !waves.length) {
    return null
  }

  const states = new Map(tasks.map(task => [nodeIdOf(task), nodeState(task.outcome)]))
  const rows = Math.max(...waves.map(wave => wave.length))
  const sx = 18
  const sy = 12
  const pad = 6
  const width = pad * 2 + (waves.length - 1) * sx
  const height = pad * 2 + (rows - 1) * sy
  const pos = new Map()

  waves.forEach((wave, i) => wave.forEach((id, j) => pos.set(id, [pad + i * sx, pad + ((rows - wave.length) * sy) / 2 + j * sy])))

  return h(
    'svg',
    { 'aria-label': `${plural(tasks.length, 'task')} in ${plural(graph.waves.length, 'wave')}`, className: 'roko-mini', height, role: 'img', viewBox: `0 0 ${width} ${height}`, width },
    graph.edges.map(([from, to]) => {
      const a = pos.get(from)
      const b = pos.get(to)

      return a && b ? h('line', { className: 'roko-mini-edge', key: `${from}>${to}`, x1: a[0], x2: b[0], y1: a[1], y2: b[1] }) : null
    }),
    [...pos.entries()].map(([id, [x, y]]) => h('circle', { className: 'roko-mini-dot', cx: x, cy: y, 'data-state': states.get(id) ?? 'pending', key: id, r: 3.6 }))
  )
}

/** Every attempt of a task as a row of stages: the agent, then each check. */
function TaskPipeline({ task, node }) {
  const log = list(task.attempt_log).filter(isRecord)
  const rows = log.length
    ? log
    : node.attempts
      ? [{ attempt: node.attempts, gates: node.gates, model: node.model, provider: node.provider }]
      : []

  if (!rows.length) {
    return h('div', { className: 'roko-muted' }, node.state === 'blocked' ? 'This task never ran.' : 'No attempt yet.')
  }

  return h(
    'div',
    { className: 'roko-pipe' },
    rows.map((attempt, index) => {
      const latest = index === rows.length - 1
      const gates = latest ? node.gates : list(attempt.gates).filter(isRecord)
      const agentLive = latest && node.state === 'running' && (node.step === 'agent' || node.step === 'starting')
      const outcome = latest ? node.state : gates.some(g => g.passed === false) ? 'failed' : 'retried'

      return h(
        'div',
        { className: 'roko-pipe-row', key: `a${index}` },
        h('span', { className: 'roko-pipe-label' }, `#${num(attempt.attempt) ?? index + 1}`),
        h(
          'span',
          { className: 'roko-pipe-stage', 'data-state': agentLive ? 'run' : 'done' },
          h(Codicon, { name: 'hubot', size: '0.72rem' }),
          clip(attempt.model || node.model || 'agent', 22)
        ),
        gates.map((gate, gi) =>
          h(
            Fragment,
            { key: `${text(gate.gate)}:${gi}` },
            h('span', { 'aria-hidden': 'true', className: 'roko-pipe-link' }),
            h(
              'span',
              { className: 'roko-pipe-stage', 'data-state': gate.passed === true ? 'pass' : gate.passed === false ? 'fail' : 'run' },
              h('span', { 'aria-hidden': 'true' }, gate.passed === true ? '✓' : gate.passed === false ? '✗' : '◌'),
              clip(gate.gate, 26)
            )
          )
        ),
        h('span', { 'aria-hidden': 'true', className: 'roko-pipe-link roko-pipe-link-end' }),
        h(
          'span',
          { className: 'roko-pipe-end', 'data-state': outcome },
          latest ? outcomeInfo(node.outcome, node.attempts).word : outcome === 'failed' ? 'retried' : 'retried'
        ),
        attempt.started_at ? h('span', { className: 'roko-pipe-time' }, clock(parseTime(attempt.started_at))) : null
      )
    })
  )
}

/** Everything about one task: its attempts and their checks, what the check said, what the agent said. */
function TaskInspector({ run, task, node, onClose, onSelect }) {
  const box = useRef(null)
  const why = isRecord(run.why) ? run.why : null
  const failing = list(why?.gates_not_passed).filter(g => isRecord(g) && text(g.task_id) === node.taskId)
  const excerpt = list(task.gates).filter(isRecord).find(g => g.passed === false)
  const [showOutput, setShowOutput] = useState(false)
  const deps = list(task.depends_on).map(text).filter(Boolean)
  const info = outcomeInfo(node.outcome, node.attempts)
  const note = text(task.note)

  // Opened from a click below the fold (the why callout, the now strip): bring it into view.
  useEffect(() => {
    if (onClose) {
      box.current?.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' })
    }
  }, [node.id])

  return h(
    'section',
    { 'aria-label': `Task ${node.taskId}`, className: 'roko-inspector', 'data-testid': `inspector-${node.taskId}`, ref: box },
    h(
      'div',
      { className: 'roko-inspector-head' },
      h('span', { className: 'roko-node-id' }, node.taskId),
      h('span', { className: 'roko-inspector-title' }, node.title || node.taskId),
      h('span', { className: 'roko-pill', 'data-tone': info.tone }, h('span', { 'aria-hidden': 'true', className: 'roko-pill-glyph' }, info.glyph), ' ', info.word),
      onClose ? h(Button, { 'aria-label': 'Close the task', onClick: onClose, size: 'icon-xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'close', size: '0.8rem' })) : null
    ),
    h(
      'div',
      { className: 'roko-inspector-meta' },
      h(ModelChip, { model: node.model, provider: node.provider }),
      node.attempts ? h('span', null, plural(node.attempts, 'attempt')) : null,
      num(node.durationMs) !== null ? h('span', null, duration(node.durationMs)) : node.state === 'running' && node.stepSince ? h('span', null, 'on this step ', h(StepClock, { since: node.stepSince })) : null,
      node.cost !== null ? h('span', null, money(node.cost)) : null,
      task.started_at ? h('span', null, `started ${clock(parseTime(task.started_at))}`) : null,
      task.finished_at ? h('span', null, `ended ${clock(parseTime(task.finished_at))}`) : null
    ),
    node.state === 'blocked'
      ? h('div', { className: 'roko-callout', 'data-tone': 'warn' }, h(Codicon, { name: 'debug-pause', size: '0.85rem' }), h('span', null, node.blockedBy ? `Blocked: ${clip(node.blockedBy, 60)} did not pass, so this task never started.` : 'Blocked.', task.reason ? ` ${clip(task.reason, 200)}` : ''))
      : null,
    h(SectionLabel, null, 'Attempts'),
    h(TaskPipeline, { node, task }),
    failing.length || excerpt
      ? h(
          'div',
          { className: 'roko-checkout' },
          h(SectionLabel, { right: failing[0]?.output ? h('button', { className: 'roko-link', onClick: () => setShowOutput(v => !v), type: 'button' }, showOutput ? 'Hide output' : 'Show output') : null }, `What ${text(failing[0]?.gate ?? excerpt?.gate) || 'the check'} said`),
          failing[0]?.key_line || excerpt?.excerpt
            ? h('div', { className: 'roko-keyline' }, h(Codicon, { name: 'error', size: '0.8rem' }), h('span', null, text(failing[0]?.key_line) || text(excerpt?.excerpt)))
            : null,
          showOutput && failing[0]?.output ? h('pre', { className: 'roko-pre' }, text(failing[0].output)) : null
        )
      : null,
    note
      ? h(
          'div',
          { className: 'roko-note-block' },
          h(SectionLabel, null, 'The agent said'),
          h('blockquote', { className: 'roko-quote' }, h(Clamp, { lines: 5, value: note }))
        )
      : null,
    deps.length
      ? h(
          'div',
          { className: 'roko-deps' },
          h('span', { className: 'roko-muted' }, 'after'),
          deps.map(dep =>
            h('button', { className: 'roko-chip roko-chip-btn', key: dep, onClick: () => onSelect?.(task.plan_id ? `${text(task.plan_id)}/${dep}` : dep), type: 'button' }, dep)
          )
        )
      : null
  )
}

// ---------------------------------------------------------------------------
// Activity: the run's timeline, live, filterable, and replayable
// ---------------------------------------------------------------------------

/** Run events cached per run id, so reopening a run only fetches newer rows. */
const eventCache = new Map()

function useRunEvents(runId, open, active) {
  const [state, setState] = useState(() => eventCache.get(runId) ?? { cursor: null, events: [] })
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const stateRef = useRef(state)
  const activeRef = useRef(active)

  activeRef.current = active

  useEffect(() => {
    if (!open || !validId(runId)) {
      return undefined
    }

    let cancelled = false
    let timer = null

    const pull = async () => {
      setLoading(true)

      try {
        let current = stateRef.current
        let more = true
        let rounds = 0

        while (more && rounds < 10) {
          rounds += 1
          const cursor = current.cursor !== null && current.cursor !== undefined ? `&cursor=${enc(current.cursor)}` : ''
          const reply = await call(`/runs/${enc(runId)}/events?limit=200${cursor}`)

          if (cancelled) {
            return
          }

          const last = current.events.length ? num(current.events[current.events.length - 1].cursor) : null
          const fresh = list(reply.events)
            .filter(isRecord)
            .filter(event => last === null || num(event.cursor) === null || event.cursor > last)

          current = {
            cursor: reply.next_cursor ?? current.cursor,
            events: [...current.events, ...fresh].slice(-500)
          }
          more = reply.has_more === true && fresh.length > 0
        }

        stateRef.current = current
        eventCache.set(runId, current)

        if (eventCache.size > 30) {
          eventCache.delete(eventCache.keys().next().value)
        }

        setState(current)
        setError(null)
      } catch (err) {
        if (!cancelled) {
          setError(err)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)

          if (activeRef.current) {
            timer = setTimeout(() => void pull(), RUN_MS)
          }
        }
      }
    }

    void pull()

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [runId, open, active])

  return { error, events: state.events, loading }
}

/** How a timeline line reads: its group, tone, and (for agent lines) the quote. */
function lineInfo(event) {
  const type = text(event.type)
  const group = GROUPS[text(event.group)] ? text(event.group) : type === 'error' ? 'error' : type.startsWith('gate') ? 'gate' : type.startsWith('agent') ? 'agent' : type.startsWith('task') ? 'task' : 'run'
  const outcome = text(event.outcome)
  let tone = 'muted'

  if (type === 'error' || event.passed === false || FAILED.has(outcome)) {
    tone = 'bad'
  } else if (type === 'task_blocked' || outcome === 'blocked' || outcome === 'unverified') {
    tone = 'warn'
  } else if (event.passed === true || PASSED.has(outcome) || /run succeeded/.test(text(event.text))) {
    tone = 'good'
  } else if (type === 'agent_spawned' || type === 'gate_rung_started' || type === 'task_started') {
    tone = 'live'
  }

  const raw = text(event.text) || type
  const quote = type === 'agent_output' ? /^(\S+) agent: (.*)$/.exec(raw) : null

  return { group, quote: quote ? { task: quote[1], text: quote[2] } : null, raw, tone, type }
}

function matchesFilter(event, filter) {
  const info = lineInfo(event)

  if (filter === 'agent') {
    return info.group === 'agent'
  }

  if (filter === 'gate') {
    return info.group === 'gate'
  }

  if (filter === 'problem') {
    return info.tone === 'bad' || info.tone === 'warn'
  }

  return true
}

/** +1:04 from the run's start, or the wall clock when the line has no time. */
function relStamp(event, startMs) {
  const ts = num(event.ts_millis)

  if (ts === null) {
    return ''
  }

  return startMs !== null ? `+${clockFace(Math.max(0, ts - startMs))}` : clock(ts)
}

const FeedRow = memo(function FeedRow({ event, startMs, future, current }) {
  const info = lineInfo(event)

  return h(
    'div',
    {
      className: 'roko-feed-row',
      'data-current': current ? 'true' : undefined,
      'data-future': future ? 'true' : undefined,
      'data-group': info.group,
      'data-tone': info.tone
    },
    h('span', { className: 'roko-feed-time' }, relStamp(event, startMs)),
    h('span', { 'aria-label': GROUPS[info.group].word, className: 'roko-feed-icon', role: 'img' }, h(Codicon, { name: GROUPS[info.group].icon, size: '0.78rem' })),
    info.quote
      ? h(
          'span',
          { className: 'roko-feed-text roko-feed-quote' },
          h('span', { className: 'roko-feed-task' }, info.quote.task),
          h('span', { className: 'roko-feed-said' }, `“${info.quote.text}”`)
        )
      : h('span', { className: 'roko-feed-text' }, info.raw)
  )
})

/**
 * Every line of the run, with filters. While the run is live it follows the newest line, unless the person
 * scrolled up: then a pill offers to jump back. During a replay, lines after the playhead are dimmed and the
 * one at the playhead is marked.
 */
function ActivityFeed({ events, startMs, error, loading, active, replayT, compact, onAll }) {
  const [filter, setFilter] = useState('all')
  const box = useRef(null)
  const [pinned, setPinned] = useState(true)
  const [seen, setSeen] = useState(events.length)
  const shown = useMemo(() => events.filter(e => matchesFilter(e, filter)), [events, filter])
  const lines = compact ? shown.slice(-5) : shown
  const counts = useMemo(
    () => Object.fromEntries(FEED_FILTERS.map(f => [f.id, events.filter(e => matchesFilter(e, f.id)).length])),
    [events]
  )
  let currentIndex = -1

  if (replayT !== null && replayT !== undefined) {
    lines.forEach((event, index) => {
      if ((num(event.ts_millis) ?? Infinity) <= replayT) {
        currentIndex = index
      }
    })
  }

  useEffect(() => {
    const el = box.current

    if (!el || compact) {
      return
    }

    if (replayT !== null && replayT !== undefined && currentIndex >= 0) {
      const row = el.children[currentIndex]

      row?.scrollIntoView?.({ block: 'nearest' })

      return
    }

    if (pinned) {
      el.scrollTop = el.scrollHeight
      setSeen(events.length)
    }
  }, [events.length, pinned, filter, compact, currentIndex, replayT])

  const onScroll = () => {
    const el = box.current

    if (!el) {
      return
    }

    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24

    setPinned(atBottom)

    if (atBottom) {
      setSeen(events.length)
    }
  }

  const fresh = Math.max(0, events.length - seen)

  return h(
    'div',
    { className: 'roko-feed', 'data-compact': compact ? 'true' : undefined },
    compact
      ? null
      : h(
          'div',
          { className: 'roko-feed-head' },
          h(
            'div',
            { 'aria-label': 'Show', className: 'roko-filters', role: 'group' },
            FEED_FILTERS.map(f =>
              h(
                'button',
                { 'aria-pressed': filter === f.id ? 'true' : 'false', className: 'roko-filter', key: f.id, onClick: () => setFilter(f.id), type: 'button' },
                f.label,
                h('span', { className: 'roko-filter-count' }, String(counts[f.id] ?? 0))
              )
            )
          ),
          loading ? h(Spinner, null) : active ? h('span', { className: 'roko-live-tag' }, h(Dot, { pulse: true, tone: 'live' }), 'live') : null
        ),
    error ? h(ErrorNote, { compact: true, error }) : null,
    !lines.length && !loading && !error
      ? h('div', { className: 'roko-muted roko-feed-empty' }, events.length ? 'Nothing matches this filter.' : 'No events yet.')
      : null,
    h(
      'div',
      { 'aria-live': active && !compact ? 'polite' : undefined, className: 'roko-feed-list', onScroll, ref: box },
      lines.map((event, index) =>
        h(FeedRow, {
          current: index === currentIndex,
          event,
          future: replayT !== null && replayT !== undefined && (num(event.ts_millis) ?? 0) > replayT,
          key: `${text(event.cursor)}:${index}`,
          startMs
        })
      )
    ),
    !compact && !pinned && fresh > 0
      ? h(
          'button',
          {
            className: 'roko-feed-jump',
            onClick: () => {
              setPinned(true)
              box.current && (box.current.scrollTop = box.current.scrollHeight)
            },
            type: 'button'
          },
          h(Codicon, { name: 'arrow-down', size: '0.75rem' }),
          `${fresh} new`
        )
      : null,
    compact && onAll && events.length > lines.length
      ? h('button', { className: 'roko-link roko-feed-all', onClick: onAll, type: 'button' }, `All ${events.length} events →`)
      : null
  )
}

/** Each task's state at moment `t`, rebuilt from the timeline (the replay's graph). */
function replayStates(events, t) {
  const states = new Map()
  const get = id => {
    if (!states.has(id)) {
      states.set(id, { attempts: 0, detail: null, gates: [], model: '', outcome: 'pending', step: null })
    }

    return states.get(id)
  }

  for (const event of events) {
    const ts = num(event.ts_millis)
    const id = text(event.task_id)

    if (ts === null || ts > t || !id) {
      continue
    }

    const s = get(id)

    switch (text(event.type)) {
      case 'task_started':
        s.outcome = 'running'
        s.step = s.step ?? 'starting'
        break
      case 'agent_spawned': {
        const a = parseAgentLine(event)

        s.outcome = 'running'
        // A numbered attempt (roko since bug-369c21) may repeat when roko fails over to another model.
        s.attempts = num(event.attempt) > 0 ? Math.max(s.attempts, event.attempt) : s.attempts + 1
        s.model = a?.model ?? s.model
        s.step = 'agent'
        s.detail = s.model
        s.gates = []
        break
      }
      case 'gate_rung_started': {
        const g = parseCheckLine(event, 'gate_rung_started')

        s.step = 'check'
        s.detail = g?.gate ?? null

        if (g && !s.gates.some(x => x.gate === g.gate)) {
          s.gates = [...s.gates, { gate: g.gate, passed: null, running: true }]
        }

        break
      }
      case 'gate_result': {
        const g = parseCheckLine(event, 'gate_result')
        const name = g?.gate ?? 'check'
        const verdict = { gate: name, passed: event.passed === true }
        const at = s.gates.findIndex(x => x.gate === name)

        s.gates = at >= 0 ? s.gates.map((x, i) => (i === at ? verdict : x)) : [...s.gates, verdict]
        s.detail = null
        break
      }
      case 'task_completed':
        s.outcome = text(event.outcome) || 'passed'
        s.step = null
        break
      case 'task_blocked':
        s.outcome = 'blocked'
        s.step = null
        break
      default:
        break
    }
  }

  return states
}

/** The run's span on the timeline: first and last event times. */
function eventSpan(events) {
  const times = events.map(e => num(e.ts_millis)).filter(t => t !== null)

  if (times.length < 2) {
    return null
  }

  const start = Math.min(...times)
  const end = Math.max(...times)

  return end > start ? { end, start } : null
}

/**
 * The replay scrubber: ▶/❚❚, a track spanning the run with a tick per event (colored by kind), and the
 * time. Dragging or arrow keys move the playhead; play runs the whole run in 6–18 s.
 */
function ReplayBar({ events, span, t, onChange, onExit }) {
  const [playing, setPlaying] = useState(false)
  const track = useRef(null)
  const dragging = useRef(false)
  const total = span.end - span.start
  const at = clamp(t ?? span.start, span.start, span.end)
  const ratio = total ? (at - span.start) / total : 0
  const tRef = useRef(at)

  tRef.current = at

  useEffect(() => {
    if (!playing) {
      return undefined
    }

    const wall = clamp(total / 20, 6_000, 18_000)
    const speed = total / wall
    let frame = null
    let timer = null
    let last = performance.now()

    if (tRef.current >= span.end) {
      onChange(span.start)
    }

    const step = now => {
      const next = Math.min(span.end, tRef.current + (now - last) * speed)

      last = now
      onChange(next)

      if (next >= span.end) {
        setPlaying(false)

        return
      }

      frame = requestAnimationFrame(step)
    }

    if (reducedMotion()) {
      timer = setInterval(() => {
        const next = Math.min(span.end, tRef.current + total / 24)

        onChange(next)

        if (next >= span.end) {
          setPlaying(false)
        }
      }, 500)
    } else {
      frame = requestAnimationFrame(step)
    }

    return () => {
      cancelAnimationFrame(frame)
      clearInterval(timer)
    }
  }, [playing, span.start, span.end])

  const seek = clientX => {
    const rect = track.current?.getBoundingClientRect?.()

    if (!rect || rect.width <= 0) {
      return
    }

    onChange(span.start + clamp((clientX - rect.left) / rect.width, 0, 1) * total)
  }

  return h(
    'div',
    { className: 'roko-replay', 'data-testid': 'replay' },
    h(
      Tip,
      { label: playing ? 'Pause' : 'Play the run again' },
      h(
        'button',
        { 'aria-label': playing ? 'Pause the replay' : 'Play the replay', className: 'roko-replay-play', onClick: () => setPlaying(v => !v), type: 'button' },
        h(Codicon, { name: playing ? 'debug-pause' : 'play', size: '0.85rem' })
      )
    ),
    h(
      'div',
      {
        'aria-label': 'Replay position',
        'aria-valuemax': Math.round(total / 1000),
        'aria-valuemin': 0,
        'aria-valuenow': Math.round((at - span.start) / 1000),
        'aria-valuetext': `${clockFace(at - span.start)} of ${clockFace(total)}`,
        className: 'roko-replay-track',
        onKeyDown: event => {
          const stepMs = Math.max(500, total / 50)

          if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
            event.preventDefault()
            setPlaying(false)
            onChange(clamp(at + (event.key === 'ArrowRight' ? stepMs : -stepMs), span.start, span.end))
          } else if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            setPlaying(false)
            onChange(event.key === 'Home' ? span.start : span.end)
          } else if (event.key === ' ') {
            event.preventDefault()
            setPlaying(v => !v)
          }
        },
        onPointerDown: event => {
          dragging.current = true
          setPlaying(false)
          event.currentTarget.setPointerCapture?.(event.pointerId)
          seek(event.clientX)
        },
        onPointerMove: event => dragging.current && seek(event.clientX),
        onPointerUp: () => {
          dragging.current = false
        },
        ref: track,
        role: 'slider',
        tabIndex: 0
      },
      h('span', { className: 'roko-replay-fill', style: { width: `${ratio * 100}%` } }),
      events.map((event, index) => {
        const ts = num(event.ts_millis)

        return ts === null
          ? null
          : h('span', {
              className: 'roko-replay-tick',
              'data-group': lineInfo(event).group,
              'data-tone': lineInfo(event).tone,
              key: `${text(event.cursor)}:${index}`,
              style: { left: `${((ts - span.start) / total) * 100}%` }
            })
      }),
      h('span', { className: 'roko-replay-head', style: { left: `${ratio * 100}%` } })
    ),
    h('span', { className: 'roko-replay-time' }, `${clockFace(at - span.start)} / ${clockFace(total)}`),
    h(Button, { onClick: onExit, size: 'xs', type: 'button', variant: 'ghost' }, 'Done')
  )
}

// ---------------------------------------------------------------------------
// Changes: the run's diff, and a guarded Merge
// ---------------------------------------------------------------------------

const WORDS = {
  go: 'break case chan const continue default defer else fallthrough false for func go goto if import interface map nil package range return select struct switch true type var',
  javascript:
    'as async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null of return static super switch this throw true try typeof undefined var void while yield',
  python:
    'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield',
  rust: 'as async await break const continue crate dyn else enum Err extern false fn for if impl in let loop match mod move mut None Ok pub ref return Self self Some static struct super trait true type unsafe use where while',
  shell: 'case do done elif else esac export fi for function if in local return then until while',
  sql: 'and as by create delete from group insert into join limit not null on or order select set table update values where',
  data: 'false null true'
}
const KEYWORDS = Object.fromEntries(Object.entries(WORDS).map(([lang, words]) => [lang, new Set(words.split(' '))]))
const LANG_KEYWORDS = { css: null, go: 'go', javascript: 'javascript', json: 'data', markdown: null, python: 'python', rust: 'rust', shell: 'shell', sql: 'sql', toml: 'data', typescript: 'javascript', yaml: 'data' }
const HASH_COMMENTS = new Set(['python', 'shell', 'toml', 'yaml'])
const SLASH_COMMENTS = new Set(['css', 'go', 'javascript', 'rust', 'typescript'])
const TOKEN_RE =
  /(\/\/.*$|#.*$|--.*$)|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/g

/**
 * A line of code as [kind, text] segments: comments, strings, numbers and keywords, by a few regular
 * expressions. Only ever rendered as text spans: tinting never interprets the line.
 */
function tint(line, language) {
  const lang = text(language)
  const s = text(line)

  if (!lang || s.length > 400 || lang === 'markdown') {
    return lang === 'markdown' && /^\s*#/.test(s) ? [['kw', s]] : [[null, s]]
  }

  const keywords = LANG_KEYWORDS[lang] ? KEYWORDS[LANG_KEYWORDS[lang]] : null
  const out = []
  let last = 0
  let m

  TOKEN_RE.lastIndex = 0

  while ((m = TOKEN_RE.exec(s)) !== null) {
    if (m[0] === '') {
      TOKEN_RE.lastIndex += 1
      continue
    }

    let kind = null

    if (m[1]) {
      const c = m[1]
      const ok = (c.startsWith('#') && HASH_COMMENTS.has(lang)) || (c.startsWith('//') && SLASH_COMMENTS.has(lang)) || (c.startsWith('--') && lang === 'sql')

      if (!ok) {
        // Not a comment in this language: tint nothing from here, but keep scanning after the marker.
        TOKEN_RE.lastIndex = m.index + 1
        continue
      }

      kind = 'com'
    } else if (m[2]) {
      kind = 'str'
    } else if (m[3]) {
      kind = 'num'
    } else if (m[4]) {
      kind = keywords?.has(m[4]) ? 'kw' : null
    }

    if (!kind) {
      continue
    }

    if (m.index > last) {
      out.push([null, s.slice(last, m.index)])
    }

    out.push([kind, m[0]])
    last = m.index + m[0].length
  }

  if (last < s.length) {
    out.push([null, s.slice(last)])
  }

  return out.length ? out : [[null, s]]
}

const STATUS_LETTERS = { added: 'A', copied: 'C', deleted: 'D', modified: 'M', renamed: 'R' }

/** A file as editors list it: the name first, its folder after it, quiet. */
function FileName({ path }) {
  const p = text(path)
  const cut = p.lastIndexOf('/')

  return h(
    'span',
    { className: 'roko-filename', title: p },
    h('span', { className: 'roko-filename-base' }, cut >= 0 ? p.slice(cut + 1) : p),
    cut >= 0 ? h('span', { className: 'roko-filename-dir' }, p.slice(0, cut)) : null
  )
}

const DiffLine = memo(function DiffLine({ line, language }) {
  const [tag, oldNo, newNo, body] = line
  const kind = tag === '+' ? 'add' : tag === '-' ? 'del' : tag === '\\' ? 'meta' : 'ctx'

  return h(
    'div',
    { className: 'roko-dl', 'data-tag': kind },
    h('span', { className: 'roko-ln' }, num(oldNo) !== null ? String(oldNo) : ''),
    h('span', { className: 'roko-ln' }, num(newNo) !== null ? String(newNo) : ''),
    h('span', { 'aria-hidden': 'true', className: 'roko-sign' }, kind === 'add' ? '+' : kind === 'del' ? '−' : ''),
    h(
      'code',
      { className: 'roko-dcode' },
      kind === 'meta'
        ? text(body) || 'No newline at end of file'
        : tint(body, language).map(([k, part], i) => (k ? h('span', { className: `roko-t-${k}`, key: i }, part) : part))
    )
  )
})

function FileDiff({ file, index, open, onToggle, reviewCommand }) {
  const status = text(file.status) || 'modified'
  const hunks = list(file.hunks).filter(isRecord)

  return h(
    'section',
    { 'aria-label': text(file.path), className: 'roko-filediff', 'data-status': status, id: `roko-file-${index}` },
    h(
      'div',
      { className: 'roko-filediff-head' },
      h(
        'button',
        { 'aria-expanded': open ? 'true' : 'false', className: 'roko-filediff-toggle', onClick: onToggle, type: 'button' },
        h(Codicon, { className: 'roko-caret', name: open ? 'chevron-down' : 'chevron-right', size: '0.8rem' }),
        h('span', { className: 'roko-status-letter', 'data-status': status, title: status }, STATUS_LETTERS[status] ?? '•'),
        h(PathText, { path: file.path }),
        file.old_path ? h('span', { className: 'roko-muted' }, `from ${clip(file.old_path, 60)}`) : null
      ),
      h(DiffStat, { additions: file.additions, deletions: file.deletions }),
      h(CopyId, { label: 'Copy path', shown: '', value: text(file.path) })
    ),
    open
      ? h(
          'div',
          { className: 'roko-filediff-body' },
          file.binary
            ? h('div', { className: 'roko-diff-note' }, h(Codicon, { name: 'file-binary', size: '0.85rem' }), 'Binary file: no line changes to show.')
            : null,
          !file.binary && !hunks.length
            ? h(
                'div',
                { className: 'roko-diff-note' },
                h(Codicon, { name: 'fold', size: '0.85rem' }),
                file.truncated ? 'This change is too large to show here.' : 'No line changes (mode or rename only).',
                file.truncated && reviewCommand ? h(CopyCommand, { command: reviewCommand, label: 'Copy review command', variant: 'ghost' }) : null
              )
            : null,
          hunks.map((hunk, hi) =>
            h(
              Fragment,
              { key: `h${hi}` },
              h(
                'div',
                { className: 'roko-hunk-head' },
                h('span', { className: 'roko-hunk-range' }, /^@@[^@]*@@/.exec(text(hunk.header))?.[0] ?? text(hunk.header)),
                hunk.context ? h('span', { className: 'roko-hunk-ctx' }, text(hunk.context)) : null
              ),
              list(hunk.lines)
                .filter(Array.isArray)
                .map((line, li) => h(DiffLine, { key: li, language: file.language, line }))
            )
          ),
          file.truncated && hunks.length ? h('div', { className: 'roko-diff-note' }, 'The rest of this file’s change was cut short.') : null
        )
      : null
  )
}

/** The run's changes, file by file: a file list beside a unified diff. */
function DiffViewer({ run }) {
  const ended = !isActiveRun(run)
  const query = useDiff(run.run_id, ended)
  const diff = query.data
  const files = list(diff?.files).filter(isRecord)
  const lineCount = files.reduce((n, f) => n + list(f.hunks).reduce((m, hk) => m + list(hk.lines).length, 0), 0)
  const [closed, setClosed] = useState(() => new Set())
  const [focus, setFocus] = useState(0)
  const reviewCommand = text(run.review_command)

  // Very large diffs start folded past the first few files.
  useEffect(() => {
    if (files.length && lineCount > 1_200) {
      setClosed(new Set(files.map((_, i) => i).filter(i => i >= 3)))
    }
  }, [files.length, lineCount])

  if (!ended) {
    return h(Empty, { icon: 'git-compare', title: 'Changes show once the run ends' }, 'roko keeps each task’s verified work on the run’s own branch; the diff appears here when the run is done.')
  }

  if (query.isLoading) {
    return h(
      'div',
      { className: 'roko-stack' },
      h(Skeleton, { className: 'roko-skel', style: { height: 28 } }),
      h(Skeleton, { className: 'roko-skel', style: { height: 160 } })
    )
  }

  if (query.error) {
    return h(ErrorNote, { error: query.error, onRetry: () => void query.refetch() })
  }

  if (!diff || diff.available === false || !files.length) {
    const delivered = isRecord(run.delivered) ? run.delivered : null
    const done = mergeResults.get(run.run_id)

    // Merged: the work is in the checkout now, so a diff against HEAD is empty.
    if (done || delivered?.merged === true) {
      return h(
        'div',
        { className: 'roko-stack', 'data-testid': 'changes-merged' },
        done ? h(MergedNote, { result: done }) : null,
        h(
          Empty,
          { icon: 'git-merge', title: 'This run’s work is merged' },
          `Its changes${text(delivered?.diffstat) ? ` (${text(delivered.diffstat)})` : ''} ${done ? 'went into' : 'are in'} ${text(done?.into) || 'your checkout'}.`,
          run.review_command ? h('span', { className: 'roko-empty-cmd' }, h(CopyCommand, { command: run.review_command, label: 'Copy review command', variant: 'ghost' })) : null
        )
      )
    }

    return h(
      Empty,
      { icon: 'git-compare', title: 'No changes to review' },
      text(diff?.message) || 'This run left no verified work on its branch.'
    )
  }

  const totals = isRecord(diff.totals) ? diff.totals : {}
  const toggle = index =>
    setClosed(prev => {
      const next = new Set(prev)

      next.has(index) ? next.delete(index) : next.add(index)

      return next
    })

  return h(
    'div',
    { className: 'roko-changes', 'data-testid': 'changes' },
    h(
      'div',
      { className: 'roko-changes-head' },
      h(
        'div',
        { className: 'roko-changes-summary' },
        h('span', { className: 'roko-strong' }, plural(num(totals.files) ?? files.length, 'file')),
        h(DiffStat, { additions: totals.additions, deletions: totals.deletions, cells: 8 }),
        diff.branch ? h('span', { className: 'roko-branch' }, h(Codicon, { name: 'git-branch', size: '0.75rem' }), clip(diff.branch, 48)) : null,
        diff.commit ? h(CopyId, { label: 'Copy commit', shown: text(diff.commit).slice(0, 8), value: text(diff.commit) }) : null,
        diff.source === 'git' ? h(Tip, { label: 'Read from the run’s branch with git: this roko serve has no diff route' }, h('span', { className: 'roko-kind' }, 'git')) : null
      ),
      h(MergeControls, { diff, run })
    ),
    diff.truncated ? h('div', { className: 'roko-diff-note' }, h(Codicon, { name: 'info', size: '0.8rem' }), `Showing ${files.length} of ${num(totals.files) ?? files.length} files.`) : null,
    h(
      'div',
      { className: 'roko-changes-body' },
      h(
        'nav',
        { 'aria-label': 'Changed files', className: 'roko-filelist' },
        files.map((file, index) =>
          h(
            'button',
            {
              'aria-current': focus === index ? 'true' : undefined,
              className: 'roko-filelist-row',
              key: `${text(file.path)}:${index}`,
              onClick: () => {
                setFocus(index)
                setClosed(prev => {
                  const next = new Set(prev)

                  next.delete(index)

                  return next
                })
                setTimeout(() => document.getElementById(`roko-file-${index}`)?.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }), 0)
              },
              type: 'button'
            },
            h('span', { className: 'roko-status-letter', 'data-status': text(file.status) }, STATUS_LETTERS[text(file.status)] ?? '•'),
            h(FileName, { path: file.path }),
            h('span', { className: 'roko-filelist-stat' }, h('span', { className: 'roko-add' }, `+${num(file.additions) ?? 0}`), h('span', { className: 'roko-del' }, `−${num(file.deletions) ?? 0}`))
          )
        )
      ),
      h(
        'div',
        { className: 'roko-diffs' },
        files.map((file, index) =>
          h(FileDiff, { file, index, key: `${text(file.path)}:${index}`, onToggle: () => toggle(index), open: !closed.has(index), reviewCommand })
        )
      )
    )
  )
}

/** Merges done from this window, by run id, so the undo command stays on screen. */
const mergeResults = new Map()

function MergedNote({ result, into }) {
  return h(
    'div',
    { className: 'roko-merged', 'data-testid': 'merged', role: 'status' },
    h(
      'span',
      { 'aria-hidden': 'true', className: 'roko-merged-check' },
      h('svg', { height: 18, viewBox: '0 0 18 18', width: 18 }, h('circle', { cx: 9, cy: 9, r: 8 }), h('path', { d: 'M5 9.4 7.7 12 13 6.4' }))
    ),
    h(
      'span',
      { className: 'roko-merged-text' },
      'Merged into ',
      h('b', null, text(result?.into || into) || 'the checkout'),
      result?.mode ? ` · ${result.mode === 'merge' ? 'merge commit' : 'fast-forward'}` : '',
      result?.head ? h('span', { className: 'roko-mono' }, ` · ${text(result.head).slice(0, 8)}`) : null
    ),
    result?.undo_command ? h(CopyCommand, { command: result.undo_command, label: 'Copy undo command', variant: 'ghost' }) : null
  )
}

/**
 * Merge, guarded: the backend checks the checkout first (on a branch, nothing uncommitted, no merge in
 * progress, and a fast-forward or a conflict-free merge), and merges only the commit the person reviewed.
 */
function MergeControls({ run, diff, compact }) {
  const { canAct } = useLimits()
  const [open, setOpen] = useState(false)
  const [, bump] = useState(0)
  const delivered = isRecord(run.delivered) ? run.delivered : null
  const ended = !isActiveRun(run)
  const done = mergeResults.get(run.run_id)
  const wanted = canAct && ended && Boolean(delivered) && delivered?.merged !== true && !done
  const check = useMergeCheck(run.run_id, wanted)
  const data = check.data

  if (done) {
    return h(MergedNote, { into: data?.into, result: done })
  }

  if (!delivered) {
    return null
  }

  if (delivered.merged === true || data?.merged) {
    return h(
      'span',
      { className: 'roko-merge-state', 'data-tone': 'good' },
      h(Codicon, { name: 'pass-filled', size: '0.8rem' }),
      delivered.promoted_into ? `Promoted into ${clip(delivered.promoted_into, 40)}` : data?.into ? `In ${clip(data.into, 40)}` : 'Merged'
    )
  }

  if (!canAct) {
    return null
  }

  if (check.isLoading) {
    return h(Button, { disabled: true, size: compact ? 'xs' : 'sm', type: 'button' }, h(Spinner, null), 'Checking…')
  }

  if (check.error || !data) {
    return compact ? null : h(CopyCommand, { command: run.merge_command, label: 'Copy merge command' })
  }

  if (!data.can_merge) {
    return h(
      'span',
      { className: 'roko-merge-blocked' },
      h(
        Tip,
        { label: text(data.reason) || 'Merge is not available here' },
        h('span', { className: 'roko-merge-why', tabIndex: 0 }, h(Codicon, { name: 'circle-slash', size: '0.75rem' }), compact ? 'Merge unavailable' : clip(data.reason, 70) || 'Merge unavailable')
      ),
      compact ? null : h(CopyCommand, { command: data.command || run.merge_command, label: 'Copy merge command' })
    )
  }

  const into = text(data.into) || 'the checkout'
  const mode = data.mode === 'merge' ? 'merge commit' : 'fast-forward'
  const commit = text(diff?.commit) || text(data.commit)
  const totals = isRecord(diff?.totals) ? diff.totals : null

  return h(
    Fragment,
    null,
    h(
      Button,
      { className: 'roko-merge-btn', 'data-testid': 'merge-button', onClick: () => setOpen(true), size: compact ? 'xs' : 'sm', type: 'button' },
      h(Codicon, { name: 'git-merge', size: '0.8rem' }),
      h('span', null, `Merge into ${clip(into, 24)}`),
      compact ? null : h('span', { className: 'roko-merge-mode' }, mode)
    ),
    h(ConfirmDialog, {
      confirmLabel: 'Merge',
      description: h(
        'span',
        { className: 'roko roko-merge-confirm' },
        h(
          'span',
          { className: 'roko-merge-line' },
          totals ? `${plural(num(totals.files) ?? 0, 'file')}, ` : '',
          totals ? h('span', { className: 'roko-add' }, `+${num(totals.additions) ?? 0}`) : null,
          totals ? ' ' : '',
          totals ? h('span', { className: 'roko-del' }, `−${num(totals.deletions) ?? 0}`) : null
        ),
        h('span', { className: 'roko-merge-line roko-mono' }, `${commit.slice(0, 8) || 'the run’s commit'} → ${into} · ${mode}`),
        delivered.workspace ? h('span', { className: 'roko-merge-line roko-muted' }, `in ${clip(delivered.workspace, 80)}`) : null,
        h('span', { className: 'roko-merge-line roko-muted' }, 'Only the commit you reviewed is merged. You get the command to undo it.')
      ),
      onClose: () => setOpen(false),
      onConfirm: async () => {
        let reply

        try {
          reply = await post(`/runs/${enc(run.run_id)}/merge`, commit ? { commit } : {})
        } catch (error) {
          throw new Error(failureLine(error))
        }

        const result = isRecord(reply.merge) ? reply.merge : {}

        mergeResults.set(run.run_id, result)

        try {
          haptic('success')
        } catch {
          // Haptics are a nicety.
        }

        host.notify({ kind: 'success', message: `${clip(run.label, 80)} · ${mode}`, title: `roko: merged into ${into}` })
        afterChange(run.run_id)
        bump(n => n + 1)
      },
      open,
      title: `Merge this run’s work into ${into}?`
    })
  )
}

// ---------------------------------------------------------------------------
// A run: hero, why, now, the graph and its inspector, activity, changes
// ---------------------------------------------------------------------------

function CancelRun({ run, size = 'sm' }) {
  const { canAct } = useLimits()
  const [open, setOpen] = useState(false)

  if (!canAct) {
    return null
  }

  return h(
    Fragment,
    null,
    h(
      Button,
      { onClick: () => setOpen(true), size, type: 'button', variant: 'outline' },
      h(Codicon, { name: 'stop-circle', size: '0.8rem' }),
      'Cancel run'
    ),
    h(ConfirmDialog, {
      confirmLabel: 'Cancel run',
      description: `roko stops “${clip(run.label, 80)}”. Work already verified stays on its branch.`,
      destructive: true,
      onClose: () => setOpen(false),
      onConfirm: async () => {
        try {
          await post(`/runs/${enc(run.run_id)}/cancel`, {})
        } catch (error) {
          throw new Error(failureLine(error))
        }

        afterChange(run.run_id)
      },
      open,
      title: 'Cancel this roko run?'
    })
  )
}

/** The models a run's tasks used, most used first. */
function modelsOf(run) {
  const counts = new Map()

  list(run.tasks)
    .filter(isRecord)
    .forEach(task => {
      const model = text(task.model)

      if (model) {
        counts.set(model, (counts.get(model) ?? 0) + 1)
      }
    })

  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([model]) => model)
}

function RunHero({ run, actions }) {
  // A plan run started without a title is named by its plan's slug: show the plan's own title.
  const slugOnly = run.kind === 'plan' && text(run.label) === text(run.plan_id)
  const plan = usePlan(slugOnly ? text(run.plan_id) : null)
  const title = slugOnly && text(plan.data?.title) ? text(plan.data.title) : text(run.label) || text(run.run_id)
  const active = isActiveRun(run)
  const progress = progressOf(run)
  const startMs = parseTime(run.started_at) ?? parseTime(run.hermes_started_at)
  const endMs = parseTime(run.finished_at)
  const cost = num(run.cost_usd)
  const fraction = doneFraction(progress)
  const projected = active && cost !== null && fraction >= 0.15 ? cost / fraction : null
  const gates = isRecord(run.gates) ? run.gates : null
  const gateTotal = gates ? (num(gates.total) ?? (num(gates.passed) ?? 0) + (num(gates.failed) ?? 0)) : 0
  const models = modelsOf(run)
  const request = text(run.request)
  const showRequest = request && clip(request, 118) !== clip(run.label, 118)
  const eta = num(run.eta_minutes)

  return h(
    'header',
    { className: 'roko-hero', 'data-state': text(run.state) },
    h(
      'div',
      { className: 'roko-hero-top' },
      h(StatePill, { state: run.state }),
      h(KindBadge, { kind: run.kind }),
      h(CopyId, { label: 'Copy run id', shown: text(run.run_id).slice(0, 8), value: run.run_id }),
      run.started_at || run.hermes_started_at ? h('span', { className: 'roko-muted' }, `started ${ago(run.started_at || run.hermes_started_at)} ago`) : null,
      run.resumed ? h('span', { className: 'roko-kind' }, 'resumed') : null,
      h('span', { className: 'roko-flex' }),
      actions ?? null
    ),
    h('h2', { className: 'roko-hero-title' }, title),
    slugOnly ? h('div', { className: 'roko-hero-slug' }, h(Codicon, { name: 'list-tree', size: '0.72rem' }), text(run.plan_id)) : null,
    showRequest ? h('p', { className: 'roko-hero-request' }, h(Codicon, { name: 'quote', size: '0.75rem' }), clip(request, 280)) : null,
    h(
      'div',
      { className: 'roko-instruments' },
      progress.total
        ? h(
            Instrument,
            { label: 'Tasks', testId: 'instrument-tasks' },
            h(ProgressRing, { progress, size: 38, stroke: 4.5 }),
            h(
              'span',
              { className: 'roko-instrument-sub' },
              h('b', null, `${progress.passed}`),
              ` passed`,
              progress.running ? h('span', { className: 'roko-tone-live' }, ` · ${progress.running} running`) : null,
              progress.failed ? h('span', { className: 'roko-tone-bad' }, ` · ${progress.failed} failed`) : null,
              progress.blocked ? h('span', { className: 'roko-tone-warn' }, ` · ${progress.blocked} blocked`) : null
            )
          )
        : null,
      h(
        Instrument,
        { label: active ? 'Elapsed' : 'Took', testId: 'instrument-time' },
        h(Clock, { endMs, fixedMs: active ? null : run.duration_ms, live: active && run.state === 'running', startMs })
      ),
      h(Instrument, { label: 'Spend', testId: 'instrument-spend', wide: true }, h(CostMeter, { cap: run.max_usd, projected, spent: cost })),
      gateTotal
        ? h(
            Instrument,
            { label: 'Checks', testId: 'instrument-checks' },
            h('span', { className: cx('roko-strong', (num(gates.failed) ?? 0) > 0 && 'roko-tone-bad') }, `${num(gates.passed) ?? 0}/${gateTotal}`),
            h('span', { className: 'roko-instrument-sub' }, 'passed')
          )
        : null,
      active && eta !== null ? h(Instrument, { label: 'ETA', testId: 'instrument-eta' }, eta < 1 ? '<1 min' : `~${Math.round(eta)} min`) : null,
      models.length
        ? h(Instrument, { label: models.length > 1 ? 'Models' : 'Model' }, models.slice(0, 3).map(model => h(ModelChip, { key: model, model })))
        : null
    ),
    run.headline ? h('div', { className: 'roko-headline' }, text(run.headline)) : null
  )
}

const WHY_TITLES = {
  cancelled: 'Why it stopped',
  failed: 'Why it did not pass',
  missing: 'roko has no record of this run',
  unverified: 'Why it is unverified'
}

/** For a run that ended without success: roko's reason in one paragraph, and the task to look at. */
function WhyCallout({ run, onInspect }) {
  const state = text(run.state)
  const why = isRecord(run.why) ? run.why : null
  const problems = list(run.problems).map(text).filter(Boolean)
  const summary = text(why?.summary) || (state === 'missing' ? problems[0] : '')

  if (isActiveRun(run) || state === 'succeeded' || !summary) {
    return null
  }

  const failing = list(why?.gates_not_passed).filter(isRecord)
  const target = text(failing[0]?.task_id) || text(list(why?.blocked).filter(isRecord)[0]?.blocked_by)
  const tone = state === 'failed' ? 'bad' : state === 'cancelled' ? 'muted' : 'warn'

  return h(
    'div',
    { className: 'roko-why', 'data-testid': 'why', 'data-tone': tone, role: 'note' },
    h(Codicon, { className: 'roko-why-icon', name: state === 'failed' ? 'error' : state === 'cancelled' ? 'debug-stop' : 'warning', size: '0.95rem' }),
    h(
      'div',
      { className: 'roko-why-body' },
      h('div', { className: 'roko-why-title' }, WHY_TITLES[state] ?? 'What happened'),
      h('p', { className: 'roko-why-text' }, summary),
      target && onInspect
        ? h(Button, { onClick: () => onInspect(target), size: 'xs', type: 'button', variant: 'outline' }, h(Codicon, { name: 'search', size: '0.75rem' }), `Inspect ${clip(target, 20)}`)
        : null
    )
  )
}

/** While a run goes: what each running task is doing, with a ticking clock. */
function NowStrip({ run, nodes, onInspect }) {
  const running = [...nodes.values()].filter(node => node.state === 'running')

  if (!isActiveRun(run)) {
    return null
  }

  return h(
    'div',
    { 'aria-live': 'polite', className: 'roko-now', 'data-testid': 'now-strip' },
    h('span', { className: 'roko-now-label' }, h(Dot, { pulse: true, tone: 'live' }), 'Now'),
    running.length
      ? running.slice(0, 3).map(node =>
          h(
            'button',
            { className: 'roko-now-item', key: node.id, onClick: () => onInspect?.(node.id), type: 'button' },
            h('span', { className: 'roko-node-id' }, clip(node.taskId, 12)),
            h('span', { className: 'roko-now-title' }, clip(node.title, 38)),
            h('span', { className: 'roko-now-step' }, stepWords(node)),
            h(StepClock, { since: node.stepSince })
          )
        )
      : h(
          'span',
          { className: 'roko-now-idle' },
          run.state === 'queued'
            ? `queued${num(run.position) !== null ? ` · position ${run.position}` : ''}`
            : list(run.waiting).length
              ? 'waiting on you'
              : 'between tasks…'
        ),
    running.length > 3 ? h('span', { className: 'roko-muted' }, `+${running.length - 3} more`) : null
  )
}

function Delivered({ run, onReview }) {
  const d = isRecord(run.delivered) ? run.delivered : null

  if (!d) {
    return null
  }

  const files = list(d.files_changed).map(text).filter(Boolean)

  return h(
    'div',
    { className: 'roko-delivered', 'data-testid': 'delivered' },
    h(SectionLabel, { right: d.merged === true ? h('span', { className: 'roko-tone-good' }, '✓ merged') : h('span', { className: 'roko-muted' }, 'not merged yet') }, 'Delivered'),
    h(
      'div',
      { className: 'roko-delivered-line' },
      h(Codicon, { name: 'git-branch', size: '0.85rem' }),
      h('span', { className: 'roko-mono roko-wrap' }, text(d.branch) || '—'),
      d.commit ? h('span', { className: 'roko-mono roko-muted' }, `@ ${clip(d.commit, 12)}`) : null
    ),
    d.diffstat ? h('div', { className: 'roko-delivered-stat' }, text(d.diffstat)) : null,
    d.promoted_into ? h('div', { className: 'roko-muted' }, `promoted into ${text(d.promoted_into)}${d.promoted_tag ? ` (${text(d.promoted_tag)})` : ''}`) : null,
    files.length
      ? h(
          'div',
          { className: 'roko-files' },
          files.slice(0, 8).map(file => h('span', { className: 'roko-chip roko-mono', key: file }, clip(file, 80))),
          files.length > 8 ? h('span', { className: 'roko-muted' }, `+${files.length - 8} more`) : null
        )
      : null,
    h(
      'div',
      { className: 'roko-actions roko-actions-start' },
      onReview ? h(Button, { onClick: onReview, size: 'xs', type: 'button', variant: 'secondary' }, h(Codicon, { name: 'git-compare', size: '0.75rem' }), 'Review changes') : null,
      h(CopyCommand, { command: run.review_command, label: 'Copy review command', variant: 'ghost' }),
      d.merged === true ? null : h(CopyCommand, { command: run.merge_command, label: 'Copy merge command', variant: 'ghost' })
    )
  )
}

/** The legend under the graph. */
function GraphLegend({ progress }) {
  const items = [
    ['passed', progress.passed],
    ['running', progress.running],
    ['failed', progress.failed],
    ['blocked', progress.blocked],
    ['pending', progress.pending]
  ].filter(([, n]) => n > 0)

  return h(
    'span',
    { className: 'roko-legend' },
    items.map(([kind, n]) => h('span', { className: 'roko-legend-item', 'data-kind': kind, key: kind }, h('i', null), `${n} ${kind}`))
  )
}

/** The Overview of a run: its graph (or, for one task, that task), replay, inspector, the latest lines. */
function RunOverview({ run, events, eventsError, eventsLoading, inspect, setInspect, onView }) {
  const active = isActiveRun(run)
  const tasks = list(run.tasks).filter(isRecord)
  const graph = useMemo(() => graphOf(run), [run])
  const span = useMemo(() => (active ? null : eventSpan(events)), [active, events])
  const [replayT, setReplayT] = useState(null)
  const replay = useMemo(() => (replayT !== null ? replayStates(events, replayT) : null), [events, replayT])
  const nodes = useMemo(() => new Map(tasks.map(task => [nodeIdOf(task), taskNode(task, replay, run)])), [tasks, replay, run])
  const progress = progressOf(run)
  const single = tasks.length === 1
  const selectedId = single ? nodeIdOf(tasks[0]) : inspect
  const selectedTask = tasks.find(task => nodeIdOf(task) === selectedId)
  const startMs = span?.start ?? parseTime(run.started_at)

  useEffect(() => {
    if (active) {
      setReplayT(null)
    }
  }, [active])

  return h(
    'div',
    { className: 'roko-overview' },
    tasks.length
      ? h(
          'div',
          { className: 'roko-graph-card' },
          h(
            'div',
            { className: 'roko-graph-head' },
            h('span', { className: 'roko-graph-title' }, single ? 'The task' : `${plural(tasks.length, 'task')} · ${plural(graph.waves.length, 'wave')}`),
            single ? null : h(GraphLegend, { progress }),
            h('span', { className: 'roko-flex' }),
            span && replayT === null
              ? h(Button, { 'data-testid': 'replay-start', onClick: () => setReplayT(span.start), size: 'xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'history', size: '0.75rem' }), 'Replay')
              : null
          ),
          single
            ? null
            : h(RunGraph, { edges: graph.edges, nodes, onSelect: id => setInspect(selectedId === id ? null : id), selected: selectedId, testId: 'run-graph', waves: graph.waves }),
          span && replayT !== null ? h(ReplayBar, { events, onChange: setReplayT, onExit: () => setReplayT(null), span, t: replayT }) : null,
          selectedTask
            ? h(TaskInspector, {
                node: nodes.get(nodeIdOf(selectedTask)),
                onClose: single ? null : () => setInspect(null),
                onSelect: id => setInspect(id),
                run,
                task: selectedTask
              })
            : single
              ? null
              : h('div', { className: 'roko-graph-hint' }, h(Codicon, { name: 'info', size: '0.75rem' }), 'Select a task to see its attempts, checks and what its agent said.')
        )
      : h(
          'div',
          { className: 'roko-graph-card roko-graph-empty' },
          run.state === 'queued' ? 'Waiting in roko’s queue…' : active ? 'roko is setting the run up…' : 'This run recorded no tasks.'
        ),
    h(
      'div',
      { className: 'roko-overview-cols' },
      h(
        'div',
        { className: 'roko-overview-col' },
        h(SectionLabel, { right: replayT !== null ? h('span', { className: 'roko-muted' }, 'replaying') : null }, 'Latest'),
        h(ActivityFeed, { active, compact: true, error: eventsError, events, loading: eventsLoading, onAll: () => onView('activity'), replayT, startMs })
      ),
      run.delivered ? h('div', { className: 'roko-overview-col' }, h(Delivered, { onReview: () => onView('changes'), run })) : null
    )
  )
}

function RunTabs({ view, onView, run, eventCount }) {
  const d = isRecord(run.delivered) ? run.delivered : null
  const tabs = [
    ['overview', 'Overview', null],
    ['activity', 'Activity', eventCount ? String(eventCount) : null],
    ['changes', 'Changes', d && !isActiveRun(run) ? text(d.diffstat).match(/(\d+) file/)?.[1] ?? '' : null]
  ]

  return h(
    'div',
    { 'aria-label': 'Run views', className: 'roko-runtabs', role: 'tablist' },
    tabs.map(([id, label, count]) =>
      h(
        'button',
        {
          'aria-selected': view === id ? 'true' : 'false',
          className: 'roko-runtab',
          key: id,
          onClick: () => onView(id),
          role: 'tab',
          type: 'button'
        },
        label,
        count ? h('span', { className: 'roko-runtab-count' }, count) : null
      )
    ),
    h('span', { className: 'roko-flex' }),
    h('span', { className: 'roko-runtabs-hint' }, h(Kbd, { size: 'sm', variant: 'ghost' }, '['), h(Kbd, { size: 'sm', variant: 'ghost' }, ']'))
  )
}

/** What the overview row knows, when the run itself can't be loaded (roko unreachable). */
function RowCard({ row, error, onRetry, compact }) {
  const d = describe(error)

  return h(
    'div',
    { className: 'roko roko-card roko-run', 'data-compact': compact ? 'true' : undefined, 'data-testid': `run-card-${text(row.run_id)}` },
    h(
      'div',
      { className: 'roko-run-head' },
      h(StatePill, { state: row.state }),
      h('span', { className: 'roko-run-title' }, text(row.label) || text(row.run_id)),
      h(KindBadge, { kind: row.kind })
    ),
    h(
      'div',
      { className: 'roko-stats' },
      h('span', { className: 'roko-stat' }, h('span', { className: 'roko-stat-label' }, 'cost'), h(CostMeter, { cap: row.max_usd, compact, spent: row.cost_usd })),
      row.started_at ? h('span', { className: 'roko-stat' }, h('span', { className: 'roko-stat-label' }, 'started'), `${ago(row.started_at)} ago`) : null
    ),
    h(
      'div',
      { className: 'roko-quiet' },
      h(Codicon, { name: 'info', size: '0.8rem' }),
      h('span', null, `Last known state. ${d.message}`),
      h(Button, { onClick: onRetry, size: 'xs', type: 'button', variant: 'ghost' }, 'Retry')
    )
  )
}

/** A plan generation: the planner at work, then the plan it wrote. */
function PlanGenView({ run }) {
  const active = isActiveRun(run)
  const planId = text(run.plan_id)

  return h(
    'div',
    { className: 'roko roko-card roko-run roko-plangen', 'data-testid': `run-card-${text(run.run_id)}` },
    h(
      'div',
      { className: 'roko-hero-top' },
      h(StatePill, { state: run.state }),
      h(KindBadge, { kind: 'plan_generate' }),
      h(CopyId, { label: 'Copy run id', shown: text(run.run_id).slice(0, 8), value: run.run_id })
    ),
    h('h2', { className: 'roko-hero-title' }, text(run.label) || 'A plan'),
    run.headline ? h('div', { className: 'roko-headline' }, text(run.headline)) : null,
    active
      ? h(
          'div',
          { className: 'roko-plangen-live' },
          h('div', { className: 'roko-plangen-ghosts', 'aria-hidden': 'true' }, [0, 1, 2].map(i => h('span', { className: 'roko-ghostcol', key: i }, h('i', null), h('i', null), i === 1 ? h('i', null) : null))),
          h('div', { className: 'roko-muted' }, 'roko’s planner is breaking the request into tasks, each with its own checks. Nothing runs until you start the plan.')
        )
      : null,
    !active && text(run.planner_error) ? h('div', { className: 'roko-why', 'data-tone': 'bad' }, h(Codicon, { className: 'roko-why-icon', name: 'error', size: '0.95rem' }), h('div', { className: 'roko-why-body' }, h('div', { className: 'roko-why-title' }, 'The planner did not finish'), h('p', { className: 'roko-why-text' }, clip(run.planner_error, 600)))) : null,
    !active && validId(planId) && run.state === 'succeeded' ? h(PlanDetail, { planId }) : null
  )
}

/**
 * Mission control for one run. `standalone` (a chat card expanded) keeps its own view and selection;
 * the page shares them through atoms (deep links, keyboard).
 */
function RunView({ runId, fallback, standalone }) {
  const query = useRun(runId)
  const run = query.data
  const pageView = useValue($runView)
  const pageInspect = useValue($inspect)
  const [localView, setLocalView] = useState('overview')
  const [localInspect, setLocalInspect] = useState(null)
  const view = standalone ? localView : pageView
  const onView = standalone ? setLocalView : next => setRunView(runId, next)
  const inspect = standalone ? localInspect : pageInspect?.runId === runId ? pageInspect.nodeId : null
  const setInspect = standalone ? setLocalInspect : nodeId => $inspect.set(nodeId ? { nodeId, runId } : null)
  const active = isActiveRun(run)
  const events = useRunEvents(runId, Boolean(run) && run.kind !== 'plan_generate', active)

  if (query.isLoading) {
    return h(
      'div',
      { className: 'roko roko-card roko-run', 'data-loading': 'true' },
      h(Skeleton, { className: 'roko-skel', style: { height: 18, width: '40%' } }),
      h(Skeleton, { className: 'roko-skel', style: { height: 26, width: '70%' } }),
      h(Skeleton, { className: 'roko-skel', style: { height: 54 } }),
      h(Skeleton, { className: 'roko-skel', style: { height: 180 } }),
      h(Spinner, { label: 'Loading run…' })
    )
  }

  if (!run) {
    if (query.error && isRecord(fallback)) {
      return h(RowCard, { error: query.error, onRetry: () => void query.refetch(), row: fallback })
    }

    return query.error
      ? h(ErrorNote, { error: query.error, onRetry: () => void query.refetch() })
      : h(Empty, { icon: 'rocket', title: 'Run not found' })
  }

  if (run.kind === 'plan_generate') {
    return h(PlanGenView, { run })
  }

  const waiting = list(run.waiting).filter(isRecord)
  const tasks = list(run.tasks).filter(isRecord)
  const nodes = new Map(tasks.map(task => [nodeIdOf(task), taskNode(task, null, run)]))
  const tokens = isRecord(run.tokens) ? run.tokens : null

  return h(
    'div',
    { className: 'roko roko-card roko-run roko-mission', 'data-state': text(run.state), 'data-testid': `run-card-${text(run.run_id)}` },
    h(RunHero, {
      actions: active
        ? h(CancelRun, { run, size: 'xs' })
        : isRecord(run.delivered) && run.delivered.merged !== true && view !== 'changes'
          ? h(MergeControls, { compact: true, run })
          : null,
      run
    }),
    query.error ? h(ErrorNote, { compact: true, error: query.error, lastChecked: query.dataUpdatedAt, onRetry: () => void query.refetch() }) : null,
    h(WhyCallout, {
      onInspect: id => {
        const node = [...nodes.values()].find(n => n.taskId === id || n.id === id)

        onView('overview')
        setInspect(node ? node.id : id)
      },
      run
    }),
    h(NowStrip, {
      nodes,
      onInspect: id => {
        onView('overview')
        setInspect(id)
      },
      run
    }),
    waiting.length
      ? h(
          'div',
          { className: 'roko-waiting-block' },
          h(SectionLabel, null, `Waiting on you (${waiting.length})`),
          waiting.map(item => h(PendingCard, { compact: true, item, key: text(item.code) || text(item.decision_id) }))
        )
      : null,
    h(RunTabs, { eventCount: events.events.length, onView, run, view }),
    h(
      'div',
      { className: 'roko-runbody', role: 'tabpanel' },
      view === 'activity'
        ? h(ActivityFeed, { active, error: events.error, events: events.events, loading: events.loading, startMs: parseTime(run.started_at) ?? eventSpan(events.events)?.start ?? null })
        : view === 'changes'
          ? h(DiffViewer, { run })
          : h(RunOverview, { events: events.events, eventsError: events.error, eventsLoading: events.loading, inspect, onView, run, setInspect })
    ),
    h(
      'div',
      { className: 'roko-run-foot' },
      h('span', { className: 'roko-muted roko-mono' }, text(run.run_id)),
      run.origin ? h('span', { className: 'roko-muted' }, `from ${text(run.origin)}`) : null,
      tokens ? h('span', { className: 'roko-muted' }, `${(num(tokens.input) ?? 0).toLocaleString()} in · ${(num(tokens.output) ?? 0).toLocaleString()} out tokens`) : null,
      num(run.events_read) ? h('span', { className: 'roko-muted' }, `${plural(run.events_read, 'event')} read`) : null
    )
  )
}

/** The compact run card for chat: state, title, cost, the graph in miniature, and what to do next. */
function RunCardCompact({ runId, onExpand, fallback }) {
  const query = useRun(runId)
  const run = query.data
  const { canAct } = useLimits()

  if (query.isLoading) {
    return h('div', { className: 'roko-card', 'data-compact': 'true' }, h(Spinner, { label: 'Loading run…' }))
  }

  if (!run) {
    if (query.error && isRecord(fallback)) {
      return h(RowCard, { compact: true, error: query.error, onRetry: () => void query.refetch(), row: fallback })
    }

    return query.error
      ? h(ErrorNote, { compact: true, error: query.error, onRetry: () => void query.refetch() })
      : h(Empty, { icon: 'rocket', title: 'Run not found' })
  }

  const active = isActiveRun(run)
  const waiting = list(run.waiting).filter(isRecord)
  const progress = progressOf(run)
  const tasks = list(run.tasks).filter(isRecord)
  const nodes = tasks.map(task => taskNode(task, null, run))
  const runningNode = nodes.find(node => node.state === 'running')
  const d = isRecord(run.delivered) ? run.delivered : null
  const why = isRecord(run.why) ? text(run.why.summary) : ''
  const startMs = parseTime(run.started_at)

  return h(
    'div',
    { className: 'roko roko-card roko-run roko-cc', 'data-compact': 'true', 'data-state': text(run.state), 'data-testid': `run-card-${text(run.run_id)}` },
    h(
      'div',
      { className: 'roko-cc-head' },
      h(StatePill, { state: run.state }),
      h('span', { className: 'roko-run-title' }, text(run.label) || text(run.run_id)),
      h(CostMeter, { cap: run.max_usd, compact: true, spent: run.cost_usd })
    ),
    run.kind === 'plan_generate'
      ? h('div', { className: 'roko-headline' }, text(run.headline))
      : h(
          'div',
          { className: 'roko-cc-body' },
          h(MiniGraph, { run }),
          h(
            'div',
            { className: 'roko-cc-progress' },
            h(SegBar, { height: 5, progress }),
            h(
              'span',
              { className: 'roko-cc-stats' },
              progress.total ? `${progress.passed}/${plural(progress.total, 'task')} passed` : 'no tasks yet',
              ' · ',
              h(Clock, { fixedMs: active ? null : run.duration_ms, live: active && run.state === 'running', startMs })
            )
          )
        ),
    active && runningNode
      ? h(
          'div',
          { className: 'roko-cc-now' },
          h(Dot, { pulse: true, tone: 'live' }),
          h('span', { className: 'roko-node-id' }, clip(runningNode.taskId, 12)),
          h('span', { className: 'roko-now-step' }, stepWords(runningNode)),
          h(StepClock, { since: runningNode.stepSince })
        )
      : null,
    !active && d ? h('div', { className: 'roko-cc-delivered' }, h(Codicon, { name: 'git-branch', size: '0.75rem' }), text(d.diffstat) || clip(d.branch, 60), h('span', { className: d.merged ? 'roko-tone-good' : 'roko-muted' }, d.merged ? ' · merged' : ' · not merged')) : null,
    !active && why && run.state !== 'succeeded' ? h('div', { className: 'roko-cc-why' }, clip(why, 220)) : null,
    h(
      'div',
      { className: 'roko-actions roko-actions-start' },
      waiting.length ? h(Badge, { size: 'xs', variant: 'warn' }, `${waiting.length} waiting on you`) : null,
      onExpand ? h(Button, { onClick: onExpand, size: 'xs', type: 'button', variant: 'outline' }, 'Details') : null,
      !active && d && run.kind !== 'plan_generate'
        ? h(Button, { onClick: () => openRoko({ run: run.run_id, view: 'changes' }), size: 'xs', type: 'button', variant: 'secondary' }, h(Codicon, { name: 'git-compare', size: '0.75rem' }), d.merged || !canAct ? 'Review changes' : 'Review & merge')
        : null,
      h(Button, { onClick: () => openRoko({ run: run.run_id }), size: 'xs', type: 'button', variant: 'ghost' }, 'Open in roko')
    )
  )
}

/** Page and chat both call this: compact for chat, mission control otherwise. */
function RunCard({ runId, compact, onExpand, fallback, standalone }) {
  return compact ? h(RunCardCompact, { fallback, onExpand, runId }) : h(RunView, { fallback, runId, standalone })
}

// ---------------------------------------------------------------------------
// Waiting items: Approve / Reject (POST /decide)
// ---------------------------------------------------------------------------

/** "REPORT.md:\n…" summaries name the file they show: split that off as the document's tab. */
function documentOf(summary) {
  const s = text(summary)
  const m = /^([\w./-]{1,80}\.[A-Za-z0-9]{1,8}):\n/.exec(s)

  return m ? { body: s.slice(m[0].length), name: m[1] } : { body: s, name: null }
}

function PendingCard({ item, showRun, compact }) {
  const { canAct } = useLimits()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  const code = text(item.code)
  const effect = item.kind === 'effect'
  const args = isRecord(item.arguments) ? Object.entries(item.arguments) : []
  const since = item.held_at || item.proposed_at
  const doc = documentOf(item.summary)

  const decide = async approve => {
    if (busy || !code) {
      return
    }

    setBusy(approve ? 'approve' : 'reject')
    setResult(null)
    const trimmed = note.trim()

    try {
      const reply = await post('/decide', { approve, code, ...(trimmed ? { note: trimmed } : {}) })
      const outcome = text(reply.outcome)
      const verb = approve ? 'Approved' : 'Rejected'
      const line = outcome ? `${verb} · ${outcome}` : verb

      setResult({ text: line, tone: approve ? 'good' : 'muted' })

      try {
        haptic(approve ? 'success' : 'cancel')
      } catch {
        // Haptics are a nicety.
      }

      host.notify({ kind: 'success', message: clip(item.title || item.question, 120), title: `roko: ${line}` })
      afterChange(item.run_id)
    } catch (error) {
      const d = describe(error)

      setResult({ hint: d.hint, text: d.message, tone: 'bad' })

      if (error instanceof RokoError && error.code === 'not_found') {
        afterChange(item.run_id)
      }
    } finally {
      setBusy(null)
    }
  }

  const decided = result && result.tone !== 'bad'

  return h(
    'div',
    {
      className: 'roko-card roko-pending',
      'data-compact': compact ? 'true' : undefined,
      'data-decided': decided ? 'true' : undefined,
      'data-kind': effect ? 'effect' : 'confirm',
      'data-testid': `pending-${code}`
    },
    h(
      'div',
      { className: 'roko-pending-head' },
      h(
        'span',
        { className: 'roko-pending-kind', 'data-kind': effect ? 'effect' : 'confirm' },
        h(Codicon, { name: effect ? 'shield' : 'eye', size: '0.72rem' }),
        effect ? 'held action' : 'sign-off'
      ),
      h('span', { className: 'roko-pending-title' }, text(item.title)),
      h(Tip, { label: `In any chat: /roko approve ${code}` }, h('span', { className: 'roko-code' }, code))
    ),
    h('div', { className: 'roko-question' }, text(item.question)),
    effect && (item.tool || item.server)
      ? h(
          'div',
          { className: 'roko-effect' },
          h('span', { className: 'roko-effect-call' }, h(Codicon, { name: 'symbol-method', size: '0.75rem' }), h('span', { className: 'roko-mono' }, `${text(item.tool) || '?'}@${text(item.server) || '?'}`)),
          args.length
            ? h(
                'span',
                { className: 'roko-args' },
                args.map(([name, type]) => h('span', { className: 'roko-chip', key: name }, `${clip(name, 40)}: ${clip(type, 40)}`))
              )
            : null,
          h('span', { className: 'roko-muted' }, 'roko shows the argument types, never their values.')
        )
      : null,
    doc.body
      ? h(
          'div',
          { className: 'roko-doc' },
          doc.name ? h('div', { className: 'roko-doc-tab' }, h(Codicon, { name: 'file', size: '0.72rem' }), doc.name) : null,
          h('div', { className: 'roko-doc-body' }, h(Clamp, { lines: compact ? 3 : 5, mono: true, value: doc.body }))
        )
      : null,
    h(
      'div',
      { className: 'roko-pending-meta' },
      since ? h('span', null, h(Codicon, { name: 'watch', size: '0.72rem' }), `waiting ${ago(since)}`) : null,
      !effect ? h(Countdown, { deadline: item.deadline_at }) : null,
      showRun && validId(item.run_id)
        ? h('button', { className: 'roko-link', onClick: () => openRoko({ run: item.run_id, tab: 'runs' }), type: 'button' }, 'Open run')
        : null
    ),
    decided
      ? null
      : !canAct
        ? h(
            'div',
            { className: 'roko-muted', 'data-testid': 'actions-off' },
            `Answering from the app is turned off; answer in chat with /roko approve ${code} or /roko reject ${code}.`
          )
        : h(
            'div',
            { className: 'roko-decide' },
            h(Input, {
              'aria-label': 'Note for roko (optional)',
              className: 'roko-note',
              disabled: Boolean(busy),
              maxLength: 500,
              onChange: event => setNote(event.target.value),
              placeholder: effect ? 'Note (optional)' : 'Note for the agent (optional)',
              value: note
            }),
            h(
              Button,
              { disabled: Boolean(busy), onClick: () => void decide(false), size: 'sm', type: 'button', variant: 'outline' },
              busy === 'reject' ? h(Spinner, null) : h(Codicon, { name: 'close', size: '0.75rem' }),
              'Reject'
            ),
            h(
              Button,
              { className: 'roko-approve', disabled: Boolean(busy), onClick: () => void decide(true), size: 'sm', type: 'button' },
              busy === 'approve' ? h(Spinner, null) : h(Codicon, { name: 'check', size: '0.75rem' }),
              'Approve'
            )
          ),
    result
      ? h(
          'div',
          { className: 'roko-result', 'data-tone': result.tone, role: 'status' },
          result.tone === 'good' ? h(Codicon, { name: 'pass-filled', size: '0.8rem' }) : null,
          result.text,
          result.hint ? h('span', { className: 'roko-result-hint' }, ` ${result.hint}`) : null
        )
      : null
  )
}

// ---------------------------------------------------------------------------
// Plans: the task graph before it runs, roko's estimate, Run plan…
// ---------------------------------------------------------------------------

function estimateLine(estimate) {
  if (!isRecord(estimate)) {
    return 'no estimate'
  }

  const parts = [`est ${money(estimate.total_cost_usd)}`]
  const secs = num(estimate.total_duration_secs)

  if (secs !== null) {
    parts.push(`~${duration(secs * 1000)}`)
  }

  if (estimate.confidence) {
    parts.push(`confidence ${clip(estimate.confidence, 20)}`)
  }

  return parts.join(' · ')
}

/** Cap presets as chips; the input stays the source of truth. */
function CapChips({ value, onPick, ceiling }) {
  const amount = Number.parseFloat(value)

  return h(
    'div',
    { 'aria-label': 'Spend cap presets', className: 'roko-capchips', role: 'group' },
    CAP_PRESETS.map(cap => {
      const over = ceiling !== null && cap > ceiling + 1e-9

      return h(
        'button',
        {
          'aria-pressed': Math.abs(amount - cap) < 1e-9 ? 'true' : 'false',
          className: 'roko-capchip',
          disabled: over,
          key: cap,
          onClick: () => onPick(cap.toFixed(2)),
          title: over ? `Above the ${money(ceiling)} you can cap a run at now` : undefined,
          type: 'button'
        },
        money(cap)
      )
    })
  )
}

function RunPlan({ plan, size = 'sm' }) {
  const limits = useLimits()
  const { canAct, left, maxRun } = limits
  const [step, setStep] = useState(null)
  const [cap, setCap] = useState('1.00')
  const [resume, setResume] = useState(false)
  const amount = Number.parseFloat(cap)
  const ceiling = capCeiling(limits)
  const tooMuch = ceiling !== null && Number.isFinite(amount) && amount > ceiling + 1e-9
  const valid = Number.isFinite(amount) && amount >= 0.01 && !tooMuch
  const planId = text(plan.plan_id) || text(plan.id)
  const title = text(plan.title) || planId

  if (!canAct) {
    return null
  }

  return h(
    Fragment,
    null,
    h(
      Button,
      { onClick: () => setStep('form'), size, type: 'button' },
      h(Codicon, { name: 'play', size: '0.8rem' }),
      'Run plan…'
    ),
    h(
      Dialog,
      { onOpenChange: open => !open && setStep(null), open: step === 'form' },
      h(
        DialogContent,
        { className: 'roko max-w-md' },
        h(DialogHeader, null, h(DialogTitle, null, `Run plan “${clip(title, 60)}”`), h(DialogDescription, null, 'roko runs every task in the plan, checks each one, and stops when it reaches the cap.')),
        h(
          'div',
          { className: 'roko-form' },
          h(
            'div',
            { className: 'roko-field' },
            h('label', { htmlFor: 'roko-run-cap' }, 'Spend cap (max_usd)'),
            h(CapChips, { ceiling, onPick: setCap, value: cap }),
            h(Input, {
              'aria-invalid': !valid,
              id: 'roko-run-cap',
              inputMode: 'decimal',
              max: ceiling !== null ? ceiling.toFixed(2) : undefined,
              min: '0.01',
              onChange: event => setCap(event.target.value),
              prefix: '$',
              step: '0.01',
              type: 'number',
              value: cap
            })
          ),
          h(
            'div',
            { className: 'roko-field roko-field-row' },
            h(Switch, { checked: resume, id: 'roko-run-resume', onCheckedChange: value => setResume(Boolean(value)) }),
            h('label', { htmlFor: 'roko-run-resume' }, 'Resume the last run of this plan')
          ),
          plan.estimate ? h('div', { className: 'roko-muted' }, estimateLine(plan.estimate)) : null,
          maxRun !== null || left !== null
            ? h(
                'div',
                { className: 'roko-muted', 'data-testid': 'run-limits' },
                [maxRun !== null ? `at most ${money(maxRun)} per run` : null, left !== null ? `${money(left)} left today` : null].filter(Boolean).join(' · ')
              )
            : null,
          valid
            ? null
            : h('div', { className: 'roko-result', 'data-tone': 'bad' }, tooMuch ? `Enter a cap of at most ${money(ceiling)}.` : 'Enter a cap of at least $0.01.')
        ),
        h(
          DialogFooter,
          null,
          h(Button, { onClick: () => setStep(null), type: 'button', variant: 'ghost' }, 'Cancel'),
          h(Button, { disabled: !valid, onClick: () => setStep('confirm'), type: 'button' }, 'Continue…')
        )
      )
    ),
    h(ConfirmDialog, {
      confirmLabel: 'Run plan',
      description: `roko will run “${clip(title, 80)}” (${planId}) and may spend up to $${valid ? amount.toFixed(2) : '?'} on model calls${resume ? ', resuming its last run' : ''}. This spends real money.`,
      onClose: () => setStep(null),
      onConfirm: async () => {
        let reply

        try {
          reply = await post(`/plans/${enc(planId)}/run`, { max_usd: Math.round(amount * 100) / 100, resume, ...(text(plan.title) ? { title: clip(plan.title, 80) } : {}) })
        } catch (error) {
          throw new Error(failureLine(error))
        }

        afterChange(reply.run_id)

        if (validId(reply.run_id)) {
          openRoko({ run: reply.run_id })
        }
      },
      open: step === 'confirm',
      title: 'Start a paid roko run?'
    })
  )
}

/** A plan's waves as columns: the compact view for chat. */
function Waves({ plan }) {
  const tasks = new Map(list(plan.tasks).filter(isRecord).map(task => [text(task.id), task]))
  const waves = list(plan.waves).map(wave => list(wave).map(text).filter(Boolean))

  if (!waves.length) {
    return h('div', { className: 'roko-muted' }, 'No tasks.')
  }

  return h(
    'div',
    { className: 'roko-waves', 'data-compact': 'true' },
    waves.map((wave, index) =>
      h(
        'div',
        { className: 'roko-wave', key: `w${index}` },
        h('div', { className: 'roko-wave-head' }, `W${index + 1}`),
        wave.map(taskId => {
          const task = tasks.get(taskId) ?? {}
          const deps = list(task.depends_on).map(text).filter(Boolean)
          const checks = list(task.checks).map(text).filter(Boolean)

          return h(
            'div',
            { className: 'roko-taskchip', key: taskId },
            h('div', { className: 'roko-taskchip-head' }, h('span', { className: 'roko-mono roko-strong' }, clip(taskId, 24)), h('span', { className: 'roko-taskchip-title' }, text(task.title))),
            deps.length ? h('div', { className: 'roko-muted' }, `after ${deps.join(', ')}`) : null,
            checks.length ? h(Tip, { label: clip(checks.join(' · '), 200) }, h('div', { className: 'roko-muted' }, plural(checks.length, 'check'))) : null
          )
        })
      )
    )
  )
}

/** One planned task: what it is for, how roko will check it, what it touches. */
function PlanTaskDetail({ task, onClose }) {
  const checks = list(task.checks).map(text).filter(Boolean)
  const files = list(task.files).map(text).filter(Boolean)

  return h(
    'section',
    { 'aria-label': `Task ${text(task.id)}`, className: 'roko-inspector' },
    h(
      'div',
      { className: 'roko-inspector-head' },
      h('span', { className: 'roko-node-id' }, text(task.id)),
      h('span', { className: 'roko-inspector-title' }, text(task.title)),
      task.role ? h('span', { className: 'roko-kind' }, text(task.role)) : null,
      task.tier ? h('span', { className: 'roko-kind' }, text(task.tier)) : null,
      h(Button, { 'aria-label': 'Close the task', onClick: onClose, size: 'icon-xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'close', size: '0.8rem' }))
    ),
    task.description ? h('p', { className: 'roko-plan-desc' }, text(task.description)) : null,
    h(SectionLabel, null, checks.length ? `How roko checks it (${checks.length})` : 'How roko checks it'),
    checks.length
      ? h('div', { className: 'roko-checklist' }, checks.map((check, i) => h('code', { className: 'roko-checkcmd', key: i }, h('span', { 'aria-hidden': 'true' }, '$ '), check)))
      : h('div', { className: 'roko-muted' }, 'No checks of its own: the workspace’s gates apply.'),
    files.length ? h('div', { className: 'roko-files' }, files.map(file => h('span', { className: 'roko-chip roko-mono', key: file }, clip(file, 60)))) : null
  )
}

function PlanDetail({ planId, compact }) {
  const query = usePlan(planId)
  const plan = query.data
  const [selected, setSelected] = useState(null)

  if (query.isLoading) {
    return h('div', { className: 'roko-card' }, h(Spinner, { label: 'Loading plan…' }))
  }

  if (!plan) {
    return query.error ? h(ErrorNote, { compact, error: query.error, onRetry: () => void query.refetch() }) : h(Empty, { icon: 'list-tree', title: 'Plan not found' })
  }

  const tasks = list(plan.tasks).filter(isRecord)
  const taskCount = num(plan.task_count) ?? tasks.length
  const waves = list(plan.waves).map(wave => list(wave).map(text).filter(Boolean)).filter(wave => wave.length)
  const known = new Set(tasks.map(task => text(task.id)))
  const edges = []

  tasks.forEach(task => list(task.depends_on).map(text).filter(dep => known.has(dep)).forEach(dep => edges.push([dep, text(task.id)])))

  const nodes = new Map(
    tasks.map(task => {
      const deps = list(task.depends_on).map(text).filter(Boolean)

      return [
        text(task.id),
        {
          attempts: 0,
          checks: list(task.checks).length,
          deps: deps.join(', '),
          gates: [],
          id: text(task.id),
          outcome: 'pending',
          state: 'pending',
          taskId: text(task.id),
          title: text(task.title)
        }
      ]
    })
  )
  const selectedTask = tasks.find(task => text(task.id) === selected)

  return h(
    'div',
    { className: 'roko roko-card roko-plan', 'data-compact': compact ? 'true' : undefined, 'data-testid': `plan-card-${text(plan.plan_id)}` },
    h(
      'div',
      { className: 'roko-run-head' },
      h('span', { className: 'roko-plan-icon' }, h(Codicon, { name: 'list-tree', size: '0.9rem' })),
      h('span', { className: 'roko-run-title' }, text(plan.title) || text(plan.plan_id)),
      h(CopyId, { label: 'Copy plan id', value: text(plan.plan_id) })
    ),
    h(
      'div',
      { className: 'roko-stats' },
      h('span', { className: 'roko-stat' }, h('span', { className: 'roko-strong' }, String(taskCount)), taskCount === 1 ? ' task' : ' tasks'),
      waves.length ? h('span', { className: 'roko-stat' }, h('span', { className: 'roko-strong' }, String(waves.length)), waves.length === 1 ? ' wave' : ' waves') : null,
      num(plan.max_parallel) !== null ? h('span', { className: 'roko-stat' }, `${plan.max_parallel} in parallel`) : null,
      h('span', { className: 'roko-stat roko-estimate', 'data-testid': 'plan-estimate' }, estimateLine(plan.estimate))
    ),
    compact
      ? h(Waves, { plan })
      : h(
          Fragment,
          null,
          h(RunGraph, { edges, nodes, onSelect: id => setSelected(prev => (prev === id ? null : id)), planOnly: true, selected, testId: 'plan-graph', waves }),
          selectedTask
            ? h(PlanTaskDetail, { onClose: () => setSelected(null), task: selectedTask })
            : h('div', { className: 'roko-graph-hint' }, h(Codicon, { name: 'info', size: '0.75rem' }), 'Select a task to see how roko will check it.')
        ),
    h(
      'div',
      { className: 'roko-actions roko-actions-start' },
      h(RunPlan, { plan, size: compact ? 'xs' : 'sm' }),
      compact ? h(Button, { onClick: () => openRoko({ plan: plan.plan_id }), size: 'xs', type: 'button', variant: 'ghost' }, 'Open in roko') : null
    )
  )
}

// ---------------------------------------------------------------------------
// Insights (health, gates, models, spend) and Knowledge
// ---------------------------------------------------------------------------

function Bar({ ratio, tone }) {
  const r = num(ratio)

  return h('span', { className: 'roko-bar', 'data-tone': tone }, h('span', { className: 'roko-bar-fill', style: { width: `${Math.round(Math.max(0, Math.min(1, r ?? 0)) * 100)}%` } }))
}

const rateTone = rate => (rate === null ? 'muted' : rate >= 0.8 ? 'good' : rate >= 0.5 ? 'warn' : 'bad')

/** Cumulative spend as an area chart, with its scale and a hover read-out. */
function SpendChart({ points }) {
  const values = points.map(p => num(p.cumulative_usd) ?? num(p.cost_usd)).filter(v => v !== null)
  const times = points.map(p => parseTime(p.at))
  const [hover, setHover] = useState(null)
  const box = useRef(null)

  if (values.length < 2) {
    return null
  }

  const W = 600
  const H = 150
  const max = Math.max(...values) || 1
  const coords = values.map((v, i) => [(i / (values.length - 1)) * W, H - 6 - (v / max) * (H - 18)])
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `0,${H} ${line} ${W},${H}`
  const total = values[values.length - 1]
  const at = hover !== null ? coords[hover] : null
  const first = times[0]
  const last = times[times.length - 1]
  const sameDay = first !== null && last !== null && new Date(first).toDateString() === new Date(last).toDateString()
  const axis = t => (sameDay ? clock(t).slice(0, 5) : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }))

  return h(
    'div',
    {
      className: 'roko-chart',
      onMouseLeave: () => setHover(null),
      onMouseMove: event => {
        const rect = box.current?.getBoundingClientRect?.()

        if (rect && rect.width > 0) {
          setHover(Math.round(clamp((event.clientX - rect.left) / rect.width, 0, 1) * (values.length - 1)))
        }
      },
      ref: box
    },
    h(
      'svg',
      { 'aria-label': `Cumulative cost, ${money(total)} total`, className: 'roko-spark', preserveAspectRatio: 'none', role: 'img', viewBox: `0 0 ${W} ${H}` },
      [0.25, 0.5, 0.75].map(f => h('line', { className: 'roko-chart-grid', key: f, x1: 0, x2: W, y1: H - 6 - f * (H - 18), y2: H - 6 - f * (H - 18) })),
      h('polygon', { className: 'roko-spark-area', points: area }),
      h('polyline', { className: 'roko-spark-line', fill: 'none', points: line }),
      at ? h('line', { className: 'roko-chart-cursor', x1: at[0], x2: at[0], y1: 0, y2: H }) : null
    ),
    h('span', { className: 'roko-chart-y roko-chart-ymax' }, money(max)),
    h('span', { className: 'roko-chart-y roko-chart-y0' }, '$0'),
    first !== null ? h('span', { className: 'roko-chart-x roko-chart-x0' }, axis(first)) : null,
    last !== null ? h('span', { className: 'roko-chart-x roko-chart-x1' }, axis(last)) : null,
    at
      ? h(
          'span',
          { className: 'roko-chart-tip', style: { left: `calc(42px + (100% - 50px) * ${at[0] / W})`, top: `${8 + (150 * at[1]) / H}px` } },
          h('b', null, money(values[hover])),
          times[hover] !== null ? ` · ${new Date(times[hover]).toLocaleString(undefined, { day: 'numeric', hour: '2-digit', minute: '2-digit', month: 'short' })}` : ''
        )
      : null
  )
}

function Kpi({ label, value, sub, tone }) {
  return h(
    'div',
    { className: 'roko-kpi', 'data-tone': tone },
    h('span', { className: 'roko-kpi-label' }, label),
    h('span', { className: 'roko-kpi-value' }, value),
    sub ? h('span', { className: 'roko-kpi-sub' }, sub) : null
  )
}

function HealthTab() {
  const health = useHealth()
  const insights = useInsights()
  const checks = list(health.data).filter(isRecord)
  const data = isRecord(insights.data) ? insights.data : {}
  const gates = list(data.gates).filter(isRecord)
  const models = list(data.models).filter(isRecord)
  const trend = list(data.cost_trend).filter(isRecord)
  const eff = isRecord(data.efficiency) ? data.efficiency : {}
  const TONE = { fail: 'bad', ok: 'good', warn: 'warn' }
  const GLYPH = { fail: '✗', ok: '✓', warn: '!' }
  const passed = gates.reduce((n, g) => n + (num(g.passed) ?? 0), 0)
  const ran = gates.reduce((n, g) => n + (num(g.passed) ?? 0) + (num(g.failed) ?? 0), 0)
  const passRate = ran ? passed / ran : null
  const totalSpend = num(eff.total_cost_usd) ?? (trend.length ? num(trend[trend.length - 1].cumulative_usd) : null)
  const failing = checks.filter(c => c.status === 'fail').length
  const warning = checks.filter(c => c.status === 'warn').length

  return h(
    'div',
    { className: 'roko-stack roko-narrow' },
    insights.data
      ? h(
          'div',
          { className: 'roko-kpis' },
          h(Kpi, { label: 'Checks passing', sub: ran ? `${passed} of ${ran} gate runs` : 'no gate runs yet', tone: rateTone(passRate), value: passRate === null ? '—' : `${Math.round(passRate * 100)}%` }),
          h(Kpi, { label: 'Spend recorded', sub: 'roko’s whole workspace', value: money(totalSpend) }),
          h(Kpi, { label: 'Tasks recorded', sub: num(eff.cost_per_task_usd) !== null ? `${money(eff.cost_per_task_usd)} a task` : null, value: num(eff.tasks_recorded) !== null ? String(eff.tasks_recorded) : '—' }),
          h(Kpi, { label: 'Typical task', sub: 'average duration', value: duration(eff.avg_task_duration_ms) })
        )
      : null,
    trend.length >= 2
      ? h(
          Fragment,
          null,
          h(SectionLabel, { right: h('span', { className: 'roko-muted' }, `${money(num(trend[trend.length - 1].cumulative_usd))} total`) }, 'Spend over time'),
          h('div', { className: 'roko-card roko-chart-card' }, h(SpendChart, { points: trend }))
        )
      : null,
    h(SectionLabel, null, 'Gates'),
    insights.isLoading ? h(Spinner, { label: 'Loading…' }) : null,
    insights.error ? h(ErrorNote, { error: insights.error, onRetry: () => void insights.refetch() }) : null,
    gates.length
      ? h(
          'div',
          { className: 'roko-card roko-table' },
          h('div', { className: 'roko-table-row roko-table-head' }, h('span', null, 'check'), h('span', null, 'pass rate'), h('span', { className: 'roko-cell-num' }, ''), h('span', { className: 'roko-cell-num' }, 'runs'), h('span', { className: 'roko-cell-num' }, 'avg')),
          gates.map((gate, index) => {
            const rate = num(gate.pass_rate)

            return h(
              'div',
              { className: 'roko-table-row', key: `${text(gate.gate)}:${index}` },
              h('span', { className: 'roko-mono roko-cell-name' }, text(gate.gate)),
              h(Bar, { ratio: rate, tone: rateTone(rate) }),
              h('span', { className: 'roko-cell-num' }, rate === null ? '—' : `${Math.round(rate * 100)}%`),
              h('span', { className: 'roko-cell-num roko-muted' }, `${num(gate.passed) ?? 0}/${(num(gate.passed) ?? 0) + (num(gate.failed) ?? 0)}`),
              h('span', { className: 'roko-cell-num roko-muted' }, duration(gate.avg_duration_ms))
            )
          })
        )
      : insights.data
        ? h('div', { className: 'roko-muted' }, 'No gate results yet.')
        : null,
    h(SectionLabel, null, 'Models'),
    models.length
      ? h(
          'div',
          { className: 'roko-card roko-table' },
          h('div', { className: 'roko-table-row roko-table-head' }, h('span', null, 'model'), h('span', null, 'success'), h('span', { className: 'roko-cell-num' }, ''), h('span', { className: 'roko-cell-num' }, 'tasks'), h('span', { className: 'roko-cell-num' }, 'spend')),
          models.map((model, index) => {
            const rate = num(model.success_rate)

            return h(
              'div',
              { className: 'roko-table-row', key: `${text(model.model)}:${index}` },
              h('span', { className: 'roko-mono roko-cell-name' }, text(model.model)),
              h(Bar, { ratio: rate, tone: rateTone(rate) }),
              h('span', { className: 'roko-cell-num' }, rate === null ? '—' : `${Math.round(rate * 100)}%`),
              h('span', { className: 'roko-cell-num roko-muted' }, plural(num(model.tasks) ?? 0, 'task')),
              h('span', { className: 'roko-cell-num roko-muted' }, money(model.total_cost_usd))
            )
          })
        )
      : insights.data
        ? h('div', { className: 'roko-muted' }, 'No model results yet.')
        : null,
    h(
      SectionLabel,
      {
        right: h(
          Button,
          {
            onClick: () => {
              void health.refetch()
              void insights.refetch()
            },
            size: 'xs',
            type: 'button',
            variant: 'ghost'
          },
          h(Codicon, { name: 'refresh', size: '0.75rem' }),
          'Check again'
        )
      },
      checks.length ? `Connection${failing ? ` · ${failing} failing` : warning ? ` · ${warning} to look at` : ' · all good'}` : 'Connection'
    ),
    health.isLoading ? h(Spinner, { label: 'Checking…' }) : null,
    health.error ? h(ErrorNote, { error: health.error, onRetry: () => void health.refetch() }) : null,
    checks.length
      ? h(
          'div',
          { className: 'roko-card roko-checks' },
          checks.map((check, index) =>
            h(
              'div',
              { className: 'roko-check', 'data-status': text(check.status), key: `${text(check.name)}:${index}` },
              h('span', { className: 'roko-glyph', 'data-tone': TONE[check.status] ?? 'muted' }, GLYPH[check.status] ?? '·'),
              h(
                'div',
                { className: 'roko-check-main' },
                h('span', { className: 'roko-strong' }, text(check.name)),
                check.detail ? h('span', { className: 'roko-muted' }, text(check.detail)) : null,
                check.hint ? h('span', { className: 'roko-check-hint' }, text(check.hint)) : null
              )
            )
          )
        )
      : null
  )
}

function KnowledgeTab() {
  const [value, setValue] = useState('')
  const q = useDebounced(value.trim(), 300)
  const query = useKnowledge(q)
  const entries = list(query.data).filter(isRecord)

  return h(
    'div',
    { className: 'roko-stack roko-narrow' },
    h(Input, {
      'aria-label': 'Search roko knowledge',
      containerClassName: 'roko-search',
      onChange: event => setValue(event.target.value),
      placeholder: 'Search what roko learned in this workspace',
      prefix: h(Codicon, { name: 'search', size: '0.85rem' }),
      suffix: query.isFetching ? h(Spinner, null) : null,
      type: 'search',
      value
    }),
    q.length < 2
      ? h(Empty, { icon: 'lightbulb', title: 'Search roko’s knowledge' }, 'Insights, patterns and facts roko kept from past runs: what broke, what fixed it, how this workspace checks its work.')
      : null,
    q.length >= 2 && query.error ? h(ErrorNote, { error: query.error, onRetry: () => void query.refetch() }) : null,
    q.length >= 2 && !query.isFetching && !query.error && !entries.length ? h(Empty, { icon: 'search', title: `Nothing for “${clip(q, 60)}”` }) : null,
    q.length >= 2
      ? entries.map((entry, index) => {
          const confidence = num(entry.confidence)

          return h(
            'div',
            { className: 'roko-card roko-knowledge', key: `${text(entry.id)}:${index}` },
            h(
              'div',
              { className: 'roko-knowledge-head' },
              entry.kind ? h(Badge, { size: 'xs', variant: 'default' }, text(entry.kind)) : null,
              entry.tier ? h(Badge, { size: 'xs', variant: 'muted' }, text(entry.tier)) : null,
              h('span', { className: 'roko-flex' }),
              num(entry.score) !== null ? h('span', { className: 'roko-muted' }, `score ${entry.score.toFixed(2)}`) : null,
              confidence !== null
                ? h('span', { className: 'roko-confidence' }, h(Bar, { ratio: confidence, tone: rateTone(confidence) }), h('span', { className: 'roko-muted' }, `${Math.round(confidence * 100)}% confident`))
                : null
            ),
            h(Clamp, { lines: 6, value: entry.content })
          )
        })
      : null
  )
}

// ---------------------------------------------------------------------------
// The composer: ask roko for work from the app (POST /runs)
// ---------------------------------------------------------------------------

const MODES = [
  { id: 'run', label: 'Run it' },
  { id: 'plan', label: 'Plan it first' }
]
const DOMAINS = [
  { id: 'code', label: 'Code' },
  { id: 'research', label: 'Research' },
  { id: 'docs', label: 'Docs' }
]

function Composer() {
  const state = useValue($composer)
  const limits = useLimits()
  const { canAct, left, maxRun, maxDay, today } = limits
  const ceiling = capCeiling(limits)
  const [title, setTitle] = useState('')
  const [cap, setCap] = useState('0.50')
  const [domain, setDomain] = useState('code')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const mode = state.mode === 'plan' ? 'plan' : 'run'
  const prompt = state.prompt ?? ''
  const amount = Number.parseFloat(cap)
  const tooMuch = ceiling !== null && Number.isFinite(amount) && amount > ceiling + 1e-9
  const capOk = mode === 'plan' || (Number.isFinite(amount) && amount >= 0.01 && !tooMuch)
  const promptOk = prompt.trim().length > 0 && prompt.length <= MAX_PROMPT
  const valid = promptOk && capOk && !busy

  useEffect(() => {
    if (state.open) {
      setError(null)
      setBusy(false)

      if (ceiling !== null && Number.parseFloat(cap) > ceiling) {
        setCap(Math.max(0.01, Math.floor(ceiling * 100) / 100).toFixed(2))
      }
    }
  }, [state.open])

  if (!canAct) {
    return null
  }

  const setDraft = patch => $composer.set({ ...$composer.get(), ...patch })

  const submit = async () => {
    if (!valid) {
      return
    }

    setBusy(true)
    setError(null)

    const body = { prompt: prompt.trim() }

    if (title.trim()) {
      body.title = title.trim()
    }

    if (mode === 'plan') {
      body.plan = true
    } else {
      body.max_usd = Math.round(amount * 100) / 100

      if (domain !== 'code') {
        body.domain = domain
      }
    }

    try {
      const reply = await post('/runs', body)

      try {
        haptic('submit')
      } catch {
        // Haptics are a nicety.
      }

      host.notify({
        kind: 'success',
        message: clip(title.trim() || prompt, 100),
        title: mode === 'plan' ? 'roko: writing a plan' : `roko: run started · cap ${money(body.max_usd)}`
      })
      $composer.set({ mode, open: false, prompt: '' })
      setTitle('')
      afterChange(reply.run_id)

      if (validId(reply.run_id)) {
        openRoko({ run: reply.run_id })
      }
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  return h(
    Dialog,
    { onOpenChange: open => !open && closeComposer(), open: state.open },
    h(
      DialogContent,
      {
        className: 'roko roko-composer',
        onKeyDown: event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            void submit()
          }
        }
      },
      h(
        DialogHeader,
        null,
        h(DialogTitle, null, h('span', { className: 'roko-composer-mark' }, h(LogoMark, { size: 16 })), 'New roko run'),
        h(
          DialogDescription,
          null,
          mode === 'plan'
            ? 'roko’s planner turns the request into a graph of small tasks, each with its own checks. You review the plan, then run it.'
            : 'roko’s agent does the work on its own branch, and your project’s checks must pass before roko calls it done.'
        )
      ),
      h(
        'div',
        { className: 'roko-form' },
        h(SegmentedControl, { className: 'roko-modes', onChange: value => setDraft({ mode: value }), options: MODES, value: mode }),
        h(
          'div',
          { className: 'roko-field' },
          h('label', { htmlFor: 'roko-composer-prompt' }, 'What should roko do?'),
          h(Textarea, {
            'aria-invalid': prompt.length > MAX_PROMPT,
            autoFocus: true,
            className: 'roko-prompt',
            id: 'roko-composer-prompt',
            maxLength: MAX_PROMPT + 200,
            onChange: event => setDraft({ prompt: event.target.value }),
            placeholder: 'Say what to change, where, and how to check it. roko’s agent sees only this text.',
            rows: 6,
            value: prompt
          }),
          h(
            'div',
            { className: 'roko-prompt-foot' },
            prompt.trim()
              ? h('span', { className: cx('roko-muted', prompt.length > MAX_PROMPT && 'roko-tone-bad') }, `${prompt.length.toLocaleString()} / ${MAX_PROMPT.toLocaleString()}`)
              : h(
                  'span',
                  { className: 'roko-examples' },
                  h('span', { className: 'roko-examples-label' }, 'Try'),
                  EXAMPLES.map((example, i) =>
                    h('button', { className: 'roko-example', key: i, onClick: () => setDraft({ prompt: example }), type: 'button' }, clip(example, 46))
                  )
                )
          )
        ),
        h(
          'div',
          { className: 'roko-field' },
          h('label', { htmlFor: 'roko-composer-title' }, 'Name it ', h('span', { className: 'roko-muted' }, '(optional, shown in your run lists)')),
          h(Input, { id: 'roko-composer-title', maxLength: 80, onChange: event => setTitle(event.target.value), placeholder: 'e.g. JSON output for the report', value: title })
        ),
        mode === 'run'
          ? h(
              'div',
              { className: 'roko-field-grid' },
              h(
                'div',
                { className: 'roko-field' },
                h('label', { htmlFor: 'roko-composer-cap' }, 'Spend cap'),
                h(CapChips, { ceiling, onPick: setCap, value: cap }),
                h(Input, {
                  'aria-invalid': !capOk,
                  id: 'roko-composer-cap',
                  inputMode: 'decimal',
                  min: '0.01',
                  onChange: event => setCap(event.target.value),
                  prefix: '$',
                  step: '0.01',
                  type: 'number',
                  value: cap
                })
              ),
              h(
                'div',
                { className: 'roko-field' },
                h('span', { className: 'roko-field-label' }, 'Kind of work'),
                h(SegmentedControl, { onChange: setDomain, options: DOMAINS, value: domain }),
                h('span', { className: 'roko-muted' }, domain === 'code' ? 'Checked by your build, tests and lint.' : domain === 'research' ? 'Checked for sources and coverage.' : 'Checked for structure and accuracy.')
              )
            )
          : h('div', { className: 'roko-callout', 'data-tone': 'muted' }, h(Codicon, { name: 'info', size: '0.8rem' }), h('span', null, 'Planning spends a little model budget (no cap) and runs nothing. You choose the cap when you run the plan.')),
        h(
          'div',
          { className: 'roko-composer-limits', 'data-testid': 'composer-limits' },
          maxRun !== null ? h('span', null, `at most ${money(maxRun)} per run`) : null,
          maxDay !== null ? h('span', null, `today ${money(today)} of ${money(maxDay)}`) : null,
          left !== null ? h('span', null, `${money(left)} left today`) : null
        ),
        mode === 'run' && !capOk ? h('div', { className: 'roko-result', 'data-tone': 'bad' }, tooMuch ? `Enter a cap of at most ${money(ceiling)}.` : 'Enter a cap of at least $0.01.') : null,
        error ? h('div', { className: 'roko-result', 'data-tone': 'bad', role: 'alert' }, describe(error).message, describe(error).hint ? h('span', { className: 'roko-result-hint' }, ` ${describe(error).hint}`) : null) : null
      ),
      h(
        DialogFooter,
        null,
        h('span', { className: 'roko-composer-hint' }, h(Kbd, { size: 'sm', variant: 'ghost' }, comboLabel('mod+enter'))),
        h(Button, { onClick: closeComposer, type: 'button', variant: 'ghost' }, 'Cancel'),
        h(
          Button,
          { 'data-testid': 'composer-submit', disabled: !valid, onClick: () => void submit(), type: 'button' },
          busy ? h(Spinner, null) : h(Codicon, { name: mode === 'plan' ? 'list-tree' : 'play', size: '0.8rem' }),
          mode === 'plan' ? 'Write the plan' : `Start · cap ${Number.isFinite(amount) ? money(amount) : '—'}`
        )
      )
    )
  )
}

/**
 * Several surfaces mount a composer host (the status chip is always there; the page too, for when the
 * status bar is hidden). Only the first one renders the dialog.
 */
const composerHosts = []
const $composerLeader = atom(null)

function ComposerHost() {
  const id = useRef(Symbol('composer'))
  const leader = useValue($composerLeader)

  useEffect(() => {
    composerHosts.push(id.current)
    $composerLeader.set(composerHosts[0])

    return () => {
      const at = composerHosts.indexOf(id.current)

      if (at >= 0) {
        composerHosts.splice(at, 1)
      }

      $composerLeader.set(composerHosts[0] ?? null)
    }
  }, [])

  return leader === id.current ? h(Composer, null) : null
}

/** The logo: three tasks joined by two checks. */
function LogoMark({ size = 18 }) {
  return h(
    'svg',
    { 'aria-hidden': 'true', className: 'roko-logo', height: size, viewBox: '0 0 24 24', width: size },
    h('path', { className: 'roko-logo-edge', d: 'M7 12 C 10 12, 10 6, 13 6 M7 12 C 10 12, 10 18, 13 18 M15 6 C 17.5 6, 17.5 12, 19 12 M15 18 C 17.5 18, 17.5 12, 19 12' }),
    h('circle', { className: 'roko-logo-node', cx: 5, cy: 12, r: 2.6 }),
    h('circle', { className: 'roko-logo-node', cx: 14, cy: 6, r: 2.6 }),
    h('circle', { className: 'roko-logo-node', cx: 14, cy: 18, r: 2.6 }),
    h('circle', { className: 'roko-logo-node roko-logo-end', cx: 20.5, cy: 12, r: 2.6 })
  )
}

// ---------------------------------------------------------------------------
// Page tabs
// ---------------------------------------------------------------------------

/** A selectable row: the listitem holds a real button, so it stays a button for assistive tech. */
function ListRow({ active, onSelect, children, live }) {
  return h(
    'div',
    { className: 'roko-row-wrap', role: 'listitem' },
    h(
      'button',
      {
        'aria-current': active ? 'true' : undefined,
        className: 'roko-row',
        'data-active': active ? 'true' : 'false',
        'data-live': live ? 'true' : undefined,
        onClick: onSelect,
        type: 'button'
      },
      ...(Array.isArray(children) ? children : [children])
    )
  )
}

/** A run row's lead: a live ring while it runs, the state glyph once it ended. */
function RowLead({ row }) {
  const info = stateInfo(row.state)
  const p = isRecord(row.progress) ? { ...EMPTY_PROGRESS, ...row.progress } : null

  if (isActiveRun(row) && p && p.total) {
    return h('span', { className: 'roko-row-lead' }, h(ProgressRing, { label: false, progress: p, size: 18, stroke: 3 }))
  }

  if (isActiveRun(row)) {
    return h('span', { className: 'roko-row-lead' }, h('span', { 'aria-label': info.word, className: 'roko-row-spin', role: 'img' }))
  }

  return h('span', { className: 'roko-row-lead' }, h(Glyph, { info }))
}

function dayKey(ms) {
  const d = new Date(ms)

  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/** Live, Today, Earlier: the run list's sections, in display order. */
function sectionRuns(runs, now) {
  const today = dayKey(now)
  const live = []
  const todays = []
  const earlier = []

  runs.forEach(row => {
    if (isActiveRun(row)) {
      live.push(row)
    } else if (parseTime(row.started_at) !== null && dayKey(parseTime(row.started_at)) === today) {
      todays.push(row)
    } else {
      earlier.push(row)
    }
  })

  return [
    ['Live', live],
    ['Today', todays],
    ['Earlier', earlier]
  ].filter(([, rows]) => rows.length)
}

function Onboarding() {
  const { canAct } = useLimits()

  return h(
    'div',
    { className: 'roko-onboard', 'data-testid': 'onboarding' },
    h(
      'svg',
      { 'aria-hidden': 'true', className: 'roko-onboard-art', viewBox: '0 0 220 92' },
      h('path', { className: 'roko-art-edge', d: 'M34 46 C 70 46, 70 20, 104 20' }),
      h('path', { className: 'roko-art-edge', d: 'M34 46 C 70 46, 70 72, 104 72' }),
      h('path', { className: 'roko-art-edge roko-art-live', d: 'M128 20 C 160 20, 160 46, 184 46' }),
      h('path', { className: 'roko-art-edge', d: 'M128 72 C 160 72, 160 46, 184 46' }),
      h('rect', { className: 'roko-art-node', 'data-state': 'passed', height: 24, rx: 7, width: 30, x: 6, y: 34 }),
      h('rect', { className: 'roko-art-node', 'data-state': 'passed', height: 24, rx: 7, width: 30, x: 100, y: 8 }),
      h('rect', { className: 'roko-art-node', 'data-state': 'running', height: 24, rx: 7, width: 30, x: 100, y: 60 }),
      h('rect', { className: 'roko-art-node', 'data-state': 'pending', height: 24, rx: 7, width: 30, x: 182, y: 34 })
    ),
    h('h2', { className: 'roko-onboard-title' }, 'Delegate checked work to roko'),
    h(
      'p',
      { className: 'roko-onboard-text' },
      'roko turns a request into small tasks, runs each with an agent on its own branch, and calls a task done only when your project’s checks pass. You watch it here, then review the diff and merge.'
    ),
    h(
      'ol',
      { className: 'roko-steps' },
      h('li', null, h('b', null, 'Ask'), h('span', null, 'In any chat: “Use roko to … Cap it at $1.” Or start one here.')),
      h('li', null, h('b', null, 'Watch'), h('span', null, 'Every task, attempt and check, live, with the spend against its cap.')),
      h('li', null, h('b', null, 'Review & merge'), h('span', null, 'Read the diff, then merge the verified work in one click.'))
    ),
    canAct
      ? h(
          'div',
          { className: 'roko-onboard-actions' },
          h(Button, { onClick: () => openComposer({ mode: 'run' }), type: 'button' }, h(Codicon, { name: 'add', size: '0.8rem' }), 'New run', h(Keys, { combo: NEW_RUN_COMBO })),
          h(
            'div',
            { className: 'roko-examples' },
            EXAMPLES.map((example, i) =>
              h('button', { className: 'roko-example', key: i, onClick: () => openComposer({ mode: 'run', prompt: example }), type: 'button' }, clip(example, 60))
            )
          )
        )
      : null
  )
}

function RunsTab({ overview }) {
  const selected = useValue($run)
  const now = useNow(30_000)
  const runs = list(overview.data?.runs).filter(row => isRecord(row) && validId(row.run_id))
  const current = validId(selected) ? selected : runs[0]?.run_id ?? null
  const sections = sectionRuns(runs, now)

  if (!runs.length && !current) {
    return h(Onboarding, null)
  }

  return h(
    'div',
    { className: 'roko-split' },
    h(
      'div',
      { className: 'roko-listcol' },
      h(
        'div',
        { 'aria-label': 'roko runs', className: 'roko-list', role: 'list' },
        sections.flatMap(([name, rows]) => [
          h('div', { className: 'roko-list-section', key: `s:${name}`, role: 'presentation' }, name, h('span', null, String(rows.length))),
          ...rows.map(row => {
            const info = stateInfo(row.state)
            const p = isRecord(row.progress) ? { ...EMPTY_PROGRESS, ...row.progress } : null

            return h(
              ListRow,
              { active: row.run_id === current, key: row.run_id, live: isActiveRun(row), onSelect: () => selectRun(row.run_id) },
              h(RowLead, { row }),
              h(
                'span',
                { className: 'roko-row-main' },
                h('span', { className: 'roko-row-title' }, text(row.label) || row.run_id),
                h(
                  'span',
                  { className: 'roko-row-meta' },
                  h('span', { 'data-tone': info.tone }, info.word),
                  p && p.total > 1 ? h('span', null, `${p.passed}/${p.total}`) : null,
                  h('span', null, row.kind === 'plan_generate' ? 'plan' : row.kind === 'plan' ? 'plan run' : 'task'),
                  h('span', null, money(row.cost_usd)),
                  row.started_at ? h('span', null, ago(row.started_at, now)) : null
                ),
                p && p.total > 1 ? h(SegBar, { height: 3, progress: p }) : null
              )
            )
          })
        ])
      ),
      h(
        'div',
        { className: 'roko-list-keys' },
        h(Kbd, { size: 'sm', variant: 'ghost' }, 'j'),
        h(Kbd, { size: 'sm', variant: 'ghost' }, 'k'),
        h('span', null, 'move'),
        h(Kbd, { size: 'sm', variant: 'ghost' }, 'n'),
        h('span', null, 'new run')
      )
    ),
    h('div', { className: 'roko-detail' }, current ? h(RunCard, { fallback: runs.find(row => row.run_id === current), key: current, runId: current }) : null)
  )
}

function WaitingTab() {
  const query = usePending()
  const items = list(query.data).filter(isRecord)
  const oldest = items.map(item => parseTime(item.held_at || item.proposed_at)).filter(t => t !== null).sort((a, b) => a - b)[0]

  if (query.isLoading) {
    return h(Spinner, { label: 'Loading…' })
  }

  return h(
    'div',
    { className: 'roko-stack roko-narrow' },
    query.error ? h(ErrorNote, { error: query.error, lastChecked: query.data ? query.dataUpdatedAt : 0, onRetry: () => void query.refetch() }) : null,
    items.length
      ? h(
          'div',
          { className: 'roko-waiting-head' },
          h('span', { className: 'roko-strong' }, items.length === 1 ? 'One thing waits on you' : `${items.length} things wait on you`),
          oldest ? h('span', { className: 'roko-muted' }, ` · the oldest for ${ago(oldest)}`) : null,
          h('span', { className: 'roko-muted' }, ' · runs keep going on other tasks while they wait')
        )
      : null,
    !items.length && !query.error
      ? h(Empty, { icon: 'pass', title: 'Nothing waits on you' }, 'When a run needs your sign-off on a result, or wants to act on the world (send, post, pay), it waits here.')
      : null,
    items.map(item => h(PendingCard, { item, key: text(item.code) || text(item.decision_id), showRun: true }))
  )
}

function PlansTab() {
  const query = usePlans()
  const selected = useValue($plan)
  const { canAct } = useLimits()
  const plans = list(query.data).filter(plan => isRecord(plan) && validId(plan.id))
  const current = validId(selected) ? selected : plans[0]?.id ?? null

  if (query.isLoading) {
    return h(Spinner, { label: 'Loading plans…' })
  }

  if (!plans.length) {
    return query.error
      ? h(ErrorNote, { error: query.error, onRetry: () => void query.refetch() })
      : h(
          'div',
          { className: 'roko-stack' },
          h(Empty, { icon: 'list-tree', title: 'No plans yet' }, 'A plan breaks a larger request into checked tasks you can review before anything runs.'),
          canAct ? h('div', { className: 'roko-center' }, h(Button, { onClick: () => openComposer({ mode: 'plan' }), size: 'sm', type: 'button' }, h(Codicon, { name: 'list-tree', size: '0.8rem' }), 'Plan something')) : null
        )
  }

  return h(
    'div',
    { className: 'roko-split' },
    h(
      'div',
      { 'aria-label': 'roko plans', className: 'roko-list', role: 'list' },
      query.error ? h(ErrorNote, { compact: true, error: query.error, onRetry: () => void query.refetch() }) : null,
      plans.map(plan => {
        const total = num(plan.task_count) ?? 0
        const done = num(plan.tasks_done) ?? 0

        return h(
          ListRow,
          {
            active: plan.id === current,
            key: plan.id,
            onSelect: () => {
              $plan.set(plan.id)
              replaceView({ plan: plan.id })
            }
          },
          h('span', { className: 'roko-row-lead' }, h(Codicon, { className: 'roko-row-icon', name: 'list-tree', size: '0.85rem' })),
          h(
            'span',
            { className: 'roko-row-main' },
            h('span', { className: 'roko-row-title' }, text(plan.title) || plan.id),
            h('span', { className: 'roko-row-meta' }, h('span', { className: 'roko-mono' }, plan.id), h('span', null, `${done}/${total} done`), plan.status ? h('span', null, text(plan.status)) : null),
            total ? h(SegBar, { height: 3, progress: { ...EMPTY_PROGRESS, passed: done, pending: Math.max(0, total - done), total } }) : null
          )
        )
      })
    ),
    h('div', { className: 'roko-detail' }, current ? h(PlanDetail, { key: current, planId: current }) : null)
  )
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

function connectionTone(query) {
  const data = query.data

  if (!data) {
    return query.error ? 'bad' : 'muted'
  }

  const conn = isRecord(data.connection) ? data.connection : {}

  if (conn.reachable !== true) {
    return 'bad'
  }

  return conn.status === 'ok' && !query.error ? 'good' : 'warn'
}

function spendLine(spend) {
  if (!isRecord(spend)) {
    return ''
  }

  const parts = []
  const max = num(spend.max_day_usd)

  parts.push(max !== null ? `today ${money(spend.today_usd)} of ${money(max)}` : `today ${money(spend.today_usd)}`)

  if ((num(spend.committed_usd) ?? 0) > 0) {
    parts.push(`${money(spend.committed_usd)} committed`)
  }

  if (max !== null && num(spend.left_usd) !== null) {
    parts.push(`${money(spend.left_usd)} left`)
  }

  return parts.join(' · ')
}

/** Today's spend against the daily limit: spent, and what running runs may still spend. */
function SpendGauge({ spend }) {
  if (!isRecord(spend) || num(spend.max_day_usd) === null || !spend.max_day_usd) {
    return null
  }

  const max = spend.max_day_usd
  const spent = clamp((num(spend.today_usd) ?? 0) / max, 0, 1)
  const committed = clamp((num(spend.committed_usd) ?? 0) / max, 0, 1 - spent)

  return h(
    Tip,
    { label: spendLine(spend) },
    h(
      'span',
      { 'aria-hidden': 'true', className: 'roko-gauge' },
      h('span', { className: 'roko-gauge-spent', style: { width: `${spent * 100}%` } }),
      h('span', { className: 'roko-gauge-committed', style: { left: `${spent * 100}%`, width: `${committed * 100}%` } })
    )
  )
}

function BackendBanner({ error, onRetry }) {
  const status = useStatusText(true)
  const d = describe(error)

  return h(
    'div',
    { className: 'roko-stack roko-narrow' },
    h(
      'div',
      { className: 'roko-banner', 'data-tone': 'warn', role: 'alert' },
      h(Codicon, { className: 'roko-banner-icon', name: 'plug', size: '1rem' }),
      h(
        'div',
        { className: 'roko-banner-body' },
        h('div', { className: 'roko-banner-title' }, d.message),
        h('div', null, 'Hermes loads plugin backends when it starts, so roko’s routes appear after a restart. ', RESTART_HINT),
        h('div', { className: 'roko-actions roko-actions-start' }, h(Button, { onClick: onRetry, size: 'xs', type: 'button', variant: 'outline' }, 'Retry'))
      )
    ),
    h(SectionLabel, null, '/roko status'),
    status.isLoading ? h(Spinner, { label: 'Asking roko…' }) : null,
    status.data ? h('pre', { className: 'roko-pre', 'data-testid': 'roko-status-text' }, status.data) : null,
    status.error ? h('div', { className: 'roko-muted' }, `The /roko command isn't available either: ${clip(errorText(status.error), 200)}`) : null
  )
}

function PageHeader({ overview }) {
  const data = overview.data
  const conn = isRecord(data?.connection) ? data.connection : null
  const tone = connectionTone(overview)
  const checked = parseTime(data?.checked_at) ?? overview.dataUpdatedAt
  const { canAct } = useLimits()
  let line

  if (!data) {
    // The banner below carries the details.
    line = !overview.error ? 'connecting…' : overview.error.kind === 'backend' ? 'backend not loaded' : 'not connected'
  } else if (conn?.reachable) {
    line = [text(conn.url), conn.version ? `v${text(conn.version)}` : '', text(conn.status)].filter(Boolean).join(' · ')
  } else {
    line = `unreachable${conn?.url ? ` · ${text(conn.url)}` : ''}`
  }

  return h(
    'div',
    { className: 'roko-page-head' },
    h(
      'div',
      { className: 'roko-head-main' },
      h(
        'div',
        { className: 'roko-title-row' },
        h(LogoMark, { size: 20 }),
        h('h1', { className: 'roko-title' }, 'roko'),
        h(Dot, { label: `connection ${tone}`, pulse: tone === 'good' && num(data?.counts?.running) > 0, tone }),
        h('span', { className: 'roko-conn', 'data-testid': 'roko-connection' }, line)
      ),
      h(
        'div',
        { className: 'roko-sub' },
        data?.spend ? h('span', { className: 'roko-spendline' }, h(SpendGauge, { spend: data.spend }), h('span', { 'data-testid': 'roko-spend' }, spendLine(data.spend))) : null,
        checked ? h('span', null, `checked ${clock(checked)}`) : null
      )
    ),
    h(
      'div',
      { className: 'roko-head-actions' },
      canAct && data
        ? h(
            Tip,
            { label: `New run (${comboLabel(NEW_RUN_COMBO)}, or n on this page)` },
            h(Button, { 'data-testid': 'new-run', onClick: () => openComposer(), size: 'sm', type: 'button' }, h(Codicon, { name: 'add', size: '0.8rem' }), 'New run')
          )
        : null,
      h(Button, { 'aria-label': 'Refresh', onClick: refreshAll, size: 'sm', type: 'button', variant: 'ghost' }, overview.isFetching ? h(Spinner, null) : h(Codicon, { name: 'refresh', size: '0.85rem' }), 'Refresh')
    )
  )
}

function OfflineNotes({ overview }) {
  const data = overview.data
  const conn = isRecord(data?.connection) ? data.connection : null
  const notes = []

  if (data && conn && conn.reachable !== true) {
    const err = isRecord(conn.error) ? conn.error : {}

    notes.push(
      h(
        'div',
        { className: 'roko-banner', 'data-tone': 'bad', key: 'unreachable', role: 'alert' },
        h(Codicon, { className: 'roko-banner-icon', name: 'debug-disconnect', size: '1rem' }),
        h(
          'div',
          { className: 'roko-banner-body' },
          h('div', { className: 'roko-banner-title' }, text(err.message) || "Can't reach roko serve."),
          err.hint ? h('div', null, text(err.hint)) : null,
          h('div', { className: 'roko-muted' }, `Showing the last known runs · checked ${clock(parseTime(data.checked_at) ?? overview.dataUpdatedAt)}`)
        )
      )
    )
  }

  if (data && overview.error) {
    notes.push(h(ErrorNote, { compact: true, error: overview.error, key: 'stale', lastChecked: overview.dataUpdatedAt, onRetry: () => void overview.refetch() }))
  }

  return notes.length ? h('div', { className: 'roko-notes' }, notes) : null
}

/** j/k, n, [ ], r and Esc on the page; never while typing or in a dialog. */
function usePageKeys(overview) {
  useEffect(() => {
    const onKey = event => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typingIn(event)) {
        return
      }

      const tab = $tab.get()
      const key = event.key

      if (key === 'n') {
        const permissions = overview.data?.permissions

        if (!isRecord(permissions) || permissions.write !== false) {
          event.preventDefault()
          openComposer()
        }

        return
      }

      if (key === 'r') {
        refreshAll()

        return
      }

      if (tab !== 'runs') {
        return
      }

      if (key === 'Escape' && $inspect.get()) {
        $inspect.set(null)

        return
      }

      if (key === '[' || key === ']') {
        const runId = $run.get()
        const at = RUN_VIEWS.indexOf($runView.get())
        const next = RUN_VIEWS[(at + (key === ']' ? 1 : RUN_VIEWS.length - 1)) % RUN_VIEWS.length]

        if (validId(runId)) {
          event.preventDefault()
          setRunView(runId, next)
        }

        return
      }

      if (key === 'j' || key === 'k' || key === 'ArrowDown' || key === 'ArrowUp') {
        const rows = sectionRuns(list(overview.data?.runs).filter(row => isRecord(row) && validId(row.run_id)), Date.now()).flatMap(([, r]) => r)

        if (!rows.length) {
          return
        }

        const current = rows.findIndex(row => row.run_id === $run.get())
        const down = key === 'j' || key === 'ArrowDown'
        const next = rows[clamp((current < 0 ? (down ? -1 : 1) : current) + (down ? 1 : -1), 0, rows.length - 1)]

        event.preventDefault()
        selectRun(next.run_id)
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [overview.data])
}

function RokoPage() {
  useLocationSync()
  const tab = useValue($tab)
  const overview = useOverview()
  const data = overview.data
  const waiting = num(data?.counts?.waiting) ?? list(data?.pending).length
  const backendDown = !data && overview.error instanceof RokoError && overview.error.kind === 'backend'
  const setTab = value => {
    if (TABS.includes(value)) {
      $tab.set(value)
      replaceView(value === 'runs' ? { run: $run.get(), view: $runView.get() } : value === 'plans' ? { plan: $plan.get(), tab: 'plans' } : { tab: value })
    }
  }

  usePageKeys(overview)

  let body

  if (backendDown) {
    body = h(BackendBanner, { error: overview.error, onRetry: refreshAll })
  } else if (!data && overview.isLoading) {
    body = h(Spinner, { label: 'Connecting to roko…' })
  } else if (!data && overview.error) {
    body = h(ErrorNote, { error: overview.error, onRetry: () => void overview.refetch() })
  } else if (tab === 'waiting') {
    body = h(WaitingTab, null)
  } else if (tab === 'plans') {
    body = h(PlansTab, null)
  } else if (tab === 'knowledge') {
    body = h(KnowledgeTab, null)
  } else if (tab === 'health') {
    body = h(HealthTab, null)
  } else {
    body = h(RunsTab, { overview })
  }

  return h(
    'div',
    { className: 'roko roko-page', 'data-testid': 'roko-page' },
    h(PageHeader, { overview }),
    backendDown
      ? null
      : h(
          'div',
          { className: 'roko-tabs' },
          h(
            Tabs,
            { onValueChange: setTab, value: tab },
            h(
              TabsList,
              { 'aria-label': 'roko sections' },
              h(TabsTrigger, { value: 'runs' }, 'Runs', num(data?.counts?.running) ? h('span', { className: 'roko-tab-live' }, h(Dot, { pulse: true, tone: 'live' })) : null),
              h(TabsTrigger, { value: 'waiting' }, 'Waiting', waiting > 0 ? h(Badge, { className: 'roko-tab-count', size: 'xs', variant: 'warn' }, String(waiting)) : null),
              h(TabsTrigger, { value: 'plans' }, 'Plans'),
              h(TabsTrigger, { value: 'health' }, 'Insights'),
              h(TabsTrigger, { value: 'knowledge' }, 'Knowledge')
            )
          )
        ),
    h('div', { className: 'roko-body' }, backendDown ? null : h(OfflineNotes, { overview }), body),
    h(ComposerHost, null)
  )
}

// ---------------------------------------------------------------------------
// Status bar chip
// ---------------------------------------------------------------------------

function countsLine(counts) {
  if (!isRecord(counts)) {
    return ''
  }

  const parts = []

  for (const [key, word] of [
    ['running', 'running'],
    ['queued', 'queued'],
    ['waiting', 'waiting']
  ]) {
    const n = num(counts[key]) ?? 0

    if (n > 0) {
      parts.push(`${n} ${word}`)
    }
  }

  return parts.join(' · ')
}

function StatusChip() {
  const overview = useOverview()
  const data = overview.data
  const tone = connectionTone(overview)
  const conn = isRecord(data?.connection) ? data.connection : null
  const counts = countsLine(data?.counts)
  const waiting = num(data?.counts?.waiting) ?? 0
  const err = conn && isRecord(conn.error) ? conn.error : null
  const live = list(data?.runs).find(row => isRecord(row) && isActiveRun(row) && isRecord(row.progress) && num(row.progress.total))
  const tipLines = []

  if (!data) {
    tipLines.push(overview.error ? describe(overview.error).message : 'Connecting to roko…')

    if (overview.error) {
      tipLines.push(describe(overview.error).hint)
    }
  } else if (conn?.reachable) {
    tipLines.push(`roko ${conn.version ? `v${text(conn.version)} ` : ''}at ${text(conn.url)} · ${text(conn.status) || 'ok'}`)
  } else {
    tipLines.push(err ? text(err.message) : "Can't reach roko serve.")

    if (err?.hint) {
      tipLines.push(text(err.hint))
    }
  }

  if (live) {
    const p = { ...EMPTY_PROGRESS, ...live.progress }

    tipLines.push(`${clip(live.label, 40)}: ${p.passed}/${p.total} tasks`)
  }

  if (counts) {
    tipLines.push(counts)
  }

  if (data?.spend) {
    tipLines.push(spendLine(data.spend))
  }

  if (data) {
    tipLines.push(`checked ${clock(parseTime(data.checked_at) ?? overview.dataUpdatedAt)}`)
  }

  return h(
    Fragment,
    null,
    h(
      Tip,
      { label: tipLines.filter(Boolean).join(' · ') },
      h(
        'button',
        {
          'aria-label': `roko: ${counts || (tone === 'good' ? 'connected' : 'not connected')}`,
          className: 'roko roko-statuschip',
          'data-testid': 'roko-status-chip',
          onClick: () => openRoko(waiting > 0 ? { tab: 'waiting' } : live ? { run: live.run_id } : {}),
          type: 'button'
        },
        h(Dot, { tone }),
        h('span', null, 'roko'),
        live ? h(ProgressRing, { label: false, progress: { ...EMPTY_PROGRESS, ...live.progress }, size: 12, stroke: 2.2 }) : null,
        counts ? h('span', { className: 'roko-statuschip-counts', 'data-waiting': waiting > 0 ? 'true' : undefined }, counts) : null
      )
    ),
    h(ComposerHost, null)
  )
}

// ---------------------------------------------------------------------------
// Transcript directives: ::roko-run{id="…"} ::roko-plan{id="…"} ::roko-pending{run="…"}
// ---------------------------------------------------------------------------

function DirectivePlaceholder({ label }) {
  return h('div', { className: 'roko roko-card roko-directive', 'data-compact': 'true' }, h(Spinner, { label }))
}

function RunDirective({ runId }) {
  const [expanded, setExpanded] = useState(false)

  return h(
    'div',
    { className: 'roko roko-directive' },
    expanded
      ? h(
          Fragment,
          null,
          h(RunCard, { runId, standalone: true }),
          h('button', { className: 'roko-link', onClick: () => setExpanded(false), type: 'button' }, 'Show less')
        )
      : h(RunCard, { compact: true, onExpand: () => setExpanded(true), runId })
  )
}

function PendingDirective({ runId }) {
  const query = usePending()
  const items = list(query.data).filter(item => isRecord(item) && item.run_id === runId)

  if (query.isLoading) {
    return h(DirectivePlaceholder, { label: 'Loading what waits on you…' })
  }

  return h(
    'div',
    { className: 'roko roko-directive roko-stack' },
    query.error ? h(ErrorNote, { compact: true, error: query.error, onRetry: () => void query.refetch() }) : null,
    !items.length && !query.error ? h('div', { className: 'roko-card roko-muted', 'data-compact': 'true' }, 'Nothing from this run waits on you.') : null,
    items.map(item => h(PendingCard, { compact: true, item, key: text(item.code) || text(item.decision_id) }))
  )
}

/** Bad attrs render the raw directive as code; streaming renders a placeholder and fetches nothing. */
function directive(name, attr, view, placeholder) {
  return {
    name,
    render: ({ attrs, source, streaming }) => {
      const value = isRecord(attrs) ? attrs[attr] : undefined

      if (!validId(value)) {
        return h('code', { className: 'roko-directive-raw' }, text(source))
      }

      if (streaming) {
        return h(DirectivePlaceholder, { label: placeholder })
      }

      return view(value)
    }
  }
}
// ---------------------------------------------------------------------------
// Background: one overview poll, change notifications, sidebar label
// ---------------------------------------------------------------------------

const seen = { pending: new Set(), seeded: false, states: new Map() }
let navRegister = null
let navLabel = 'roko'

function resetSeen() {
  seen.pending.clear()
  seen.states.clear()
  seen.seeded = false
  navLabel = 'roko'
}

function setNavLabel(waiting) {
  const label = waiting > 0 ? `roko (${waiting})` : 'roko'

  if (label !== navLabel && navRegister) {
    navLabel = label
    navRegister(label)
  }
}

/** Runs once per successful overview fetch, whoever fetched it. */
function onOverview(data) {
  if (!isRecord(data)) {
    return
  }

  const runs = list(data.runs).filter(row => isRecord(row) && validId(row.run_id))
  const pending = list(data.pending).filter(item => isRecord(item) && typeof item.code === 'string')

  setNavLabel(num(data.counts?.waiting) ?? pending.length)

  if (!seen.seeded) {
    // First load: remember what exists, announce nothing.
    seen.seeded = true
    runs.forEach(row => seen.states.set(row.run_id, row.state))
    pending.forEach(item => seen.pending.add(item.code))

    return
  }

  const finished = runs.filter(row => TERMINAL_STATES.has(row.state) && seen.states.has(row.run_id) && !TERMINAL_STATES.has(seen.states.get(row.run_id)))
  const fresh = pending.filter(item => !seen.pending.has(item.code))

  runs.forEach(row => seen.states.set(row.run_id, row.state))
  fresh.forEach(item => seen.pending.add(item.code))

  if (seen.states.size > 400) {
    seen.states.delete(seen.states.keys().next().value)
  }

  if (finished.length || fresh.length) {
    announce(finished, fresh)
  }
}

/** One aggregated toast + one native notification per poll. */
function announce(finished, fresh) {
  const parts = []

  if (finished.length === 1) {
    parts.push(`run ${stateInfo(finished[0].state).word}`)
  } else if (finished.length > 1) {
    parts.push(`${finished.length} runs finished`)
  }

  if (fresh.length) {
    parts.push(fresh.length === 1 ? '1 item waits on you' : `${fresh.length} items wait on you`)
  }

  const lines = [
    ...finished.map(row => `${stateInfo(row.state).word}: ${clip(row.label || row.run_id, 80)}`),
    ...fresh.map(item => `waiting: ${clip(item.title || item.question || item.code, 80)}`)
  ]
  const shown = lines.slice(0, 3)

  if (lines.length > shown.length) {
    shown.push(`and ${lines.length - shown.length} more`)
  }

  // One finished run opens that run; anything waiting opens the inbox.
  const target = finished.length === 1 && !fresh.length ? { run: finished[0].run_id } : { tab: fresh.length ? 'waiting' : 'runs' }
  const title = `roko: ${parts.join(' · ')}`
  const bad = finished.some(row => row.state === 'failed' || row.state === 'unverified')

  host.notify({
    action: { label: 'Open roko', onClick: () => openRoko(target) },
    detail: shown.slice(1).join(' · ') || undefined,
    kind: fresh.length || bad ? 'warning' : 'success',
    message: shown[0] ?? '',
    title
  })

  try {
    doors?.os?.notify?.({ activate: pathFor(target), body: shown.join('\n'), onActivate: () => applyView(target), title })
  } catch {
    // A missing desktop bridge must not break the toast above.
  }
}

function startPolling() {
  let timer = null
  let stopped = false

  const tick = async () => {
    if (stopped) {
      return
    }

    try {
      await queryClient.fetchQuery({ queryFn: fetchOverview, queryKey: KEYS.overview, retry: false, staleTime: OVERVIEW_MS - 1_000 })
    } catch {
      // The error lands in the query; observers show it.
    }

    if (!stopped) {
      timer = setTimeout(() => void tick(), isHidden() ? OVERVIEW_HIDDEN_MS : OVERVIEW_MS)
    }
  }

  timer = setTimeout(() => void tick(), 0)

  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

function watchOverview() {
  return queryClient.getQueryCache().subscribe(event => {
    try {
      const key = event?.query?.queryKey

      if (event?.type !== 'updated' || event.action?.type !== 'success' || key?.[0] !== ID || key?.[1] !== 'overview') {
        return
      }

      onOverview(event.query.state.data)
    } catch (error) {
      console.error('[roko] overview watcher failed', error)
    }
  })
}

/** roko_* tool calls finished in any chat: refresh what they touched. */
function findRunId(value) {
  let v = value

  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }

  if (!isRecord(v)) {
    return null
  }

  const candidate = v.run_id ?? (isRecord(v.run) ? v.run.run_id : undefined)

  return validId(candidate) ? candidate : null
}

/** Tool calls come in bursts; refresh once per burst, not once per call. */
const toolRefresh = { plans: false, runs: new Set(), timer: null }

function scheduleRefresh(runId, plans) {
  if (runId) {
    toolRefresh.runs.add(runId)
  }

  toolRefresh.plans = toolRefresh.plans || plans

  if (toolRefresh.timer) {
    return
  }

  toolRefresh.timer = setTimeout(() => {
    const runs = [...toolRefresh.runs]
    const withPlans = toolRefresh.plans

    toolRefresh.timer = null
    toolRefresh.runs.clear()
    toolRefresh.plans = false
    void queryClient.invalidateQueries({ queryKey: KEYS.overview })
    void queryClient.invalidateQueries({ queryKey: KEYS.pending })

    if (withPlans) {
      void queryClient.invalidateQueries({ queryKey: KEYS.plans })
    }

    runs.forEach(id => void queryClient.refetchQueries({ queryKey: KEYS.run(id) }))
  }, TOOL_REFRESH_MS)
}

function cancelScheduledRefresh() {
  clearTimeout(toolRefresh.timer)
  toolRefresh.timer = null
  toolRefresh.runs.clear()
  toolRefresh.plans = false
}

function onToolComplete(event) {
  const payload = isRecord(event) && isRecord(event.payload) ? event.payload : null

  if (!payload || typeof payload.name !== 'string' || !payload.name.startsWith('roko_')) {
    return
  }

  scheduleRefresh(findRunId(payload.result) ?? findRunId(payload.args), payload.name.startsWith('roko_plan'))
}


// ---------------------------------------------------------------------------
// Styles: Tailwind only knows the classes the app itself uses, so the bespoke
// look lives here, on the app's theme tokens (light and dark follow them; no
// literal colors). Motion stops under prefers-reduced-motion.
// ---------------------------------------------------------------------------

const CSS = `
.roko{--roko-good:var(--ui-green);--roko-bad:var(--ui-red);--roko-warn:var(--ui-yellow);--roko-live:var(--ui-accent);--roko-muted:var(--ui-text-tertiary);--roko-line:var(--ui-stroke-tertiary);--roko-line-soft:var(--ui-stroke-quaternary);--roko-surface:var(--ui-widget-surface-background,var(--ui-bg-editor));--roko-sunk:var(--ui-bg-quinary);--roko-mono:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);--roko-ease:cubic-bezier(.2,.75,.25,1)}
.roko-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--ui-surface-background);color:var(--ui-text-primary);font-size:13px;container-type:inline-size}
.roko-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:16px 22px 8px}
.roko-head-main{display:flex;flex-direction:column;gap:5px;min-width:0}
.roko-head-actions{display:flex;align-items:center;gap:6px;flex:none}
.roko-title-row{display:flex;align-items:center;gap:9px;min-width:0}
.roko-title{margin:0;font-size:17px;font-weight:700;letter-spacing:-.02em;color:var(--ui-text-primary)}
.roko-logo{flex:none;overflow:visible}
.roko-logo-edge{fill:none;stroke:color-mix(in srgb,var(--ui-accent) 55%,transparent);stroke-width:1.5;stroke-linecap:round}
.roko-logo-node{fill:var(--ui-surface-background,var(--roko-surface));stroke:var(--ui-accent);stroke-width:1.7}
.roko-logo-end{fill:var(--ui-accent)}
.roko-conn{font-size:12px;color:var(--ui-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-sub{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;font-size:12px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.roko-spendline{display:inline-flex;align-items:center;gap:8px}
.roko-gauge{position:relative;display:inline-block;width:64px;height:5px;overflow:hidden;border-radius:999px;background:var(--ui-bg-tertiary)}
.roko-gauge-spent{position:absolute;left:0;top:0;bottom:0;border-radius:inherit;background:var(--roko-live)}
.roko-gauge-committed{position:absolute;top:0;bottom:0;background:repeating-linear-gradient(-45deg,color-mix(in srgb,var(--roko-live) 55%,transparent) 0 2px,transparent 2px 4px)}
.roko-tabs{padding:2px 22px 6px}
.roko-tabs [data-slot=tabs-list]{align-self:flex-start}
.roko-tab-count{margin-left:4px}
.roko-tab-live{display:inline-flex;margin-left:6px}
.roko-body{flex:1;min-height:0;overflow:auto;padding:10px 22px 32px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
.roko-notes{display:flex;flex-direction:column;gap:8px}
.roko-stack{display:flex;flex-direction:column;gap:10px;min-width:0}
.roko-narrow{width:100%;max-width:1000px}
.roko-center{display:flex;justify-content:center}
.roko-quiet{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ui-text-tertiary)}
.roko-split{display:grid;grid-template-columns:minmax(230px,290px) minmax(0,1fr);gap:20px;align-items:start}
@container (max-width:860px){.roko-split{grid-template-columns:minmax(0,1fr)}.roko-listcol{position:static}}
.roko-listcol{position:sticky;top:0;display:flex;flex-direction:column;gap:6px;min-width:0}
.roko-list{display:flex;flex-direction:column;gap:1px;min-width:0}
.roko-list-section{display:flex;align-items:center;justify-content:space-between;padding:10px 10px 4px;font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-list-section:first-child{padding-top:2px}
.roko-list-section span{font-variant-numeric:tabular-nums;letter-spacing:0}
.roko-list-keys{display:flex;align-items:center;gap:4px;padding:8px 10px 0;font-size:11px;color:var(--ui-text-quaternary)}
.roko-list-keys span{margin-right:8px}
.roko-detail{min-width:0}
.roko-row-wrap{display:block}
.roko-row{position:relative;display:flex;align-items:flex-start;gap:10px;width:100%;padding:8px 10px;border:0;border-radius:8px;background:transparent;color:var(--ui-text-secondary);font:inherit;text-align:left;cursor:pointer;transition:background-color .15s var(--roko-ease)}
.roko-row:hover{background:var(--ui-row-hover-background);color:var(--ui-text-primary)}
.roko-row[data-active=true]{background:var(--ui-row-active-background);color:var(--ui-text-primary)}
.roko-row[data-active=true]::before{content:"";position:absolute;left:0;top:9px;bottom:9px;width:2px;border-radius:2px;background:var(--ui-accent)}
.roko-row:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px}
.roko-row-lead{flex:none;display:inline-grid;place-items:center;width:18px;height:18px}
.roko-row-icon{color:var(--ui-text-tertiary)}
.roko-row-spin{display:block;width:12px;height:12px;border-radius:50%;border:1.6px solid color-mix(in srgb,var(--roko-live) 22%,transparent);border-top-color:var(--roko-live);animation:roko-spin .9s linear infinite}
.roko-row-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.roko-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550;color:var(--ui-text-primary)}
.roko-row-meta{display:flex;gap:7px;font-size:11px;color:var(--ui-text-tertiary);white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}
.roko-row-meta [data-tone=good]{color:var(--roko-good)}.roko-row-meta [data-tone=bad]{color:var(--roko-bad)}.roko-row-meta [data-tone=warn]{color:var(--roko-warn)}.roko-row-meta [data-tone=live]{color:var(--roko-live)}
.roko-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:14px 16px;border:1px solid var(--roko-line);border-radius:12px;background:var(--roko-surface);color:var(--ui-text-primary)}
.roko-card[data-compact=true]{gap:8px;padding:11px 13px;border-radius:10px}
.roko-run-head{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.roko-run-title{flex:1;min-width:0;font-weight:600;font-size:13.5px;line-height:1.35;overflow-wrap:anywhere}
.roko-card[data-compact=true] .roko-run-title{font-size:13px}
.roko-headline{font-size:11.5px;color:var(--ui-text-tertiary);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.roko-pill{display:inline-flex;align-items:center;gap:3px;height:20px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:650;white-space:nowrap;background:color-mix(in srgb,var(--ui-text-tertiary) 14%,transparent);color:var(--ui-text-secondary)}
.roko-pill[data-tone=good]{background:color-mix(in srgb,var(--roko-good) 15%,transparent);color:var(--roko-good)}
.roko-pill[data-tone=bad]{background:color-mix(in srgb,var(--roko-bad) 14%,transparent);color:var(--roko-bad)}
.roko-pill[data-tone=warn]{background:color-mix(in srgb,var(--roko-warn) 17%,transparent);color:var(--roko-warn)}
.roko-pill[data-tone=live]{background:color-mix(in srgb,var(--roko-live) 14%,transparent);color:var(--roko-live)}
.roko-pill-glyph{display:inline-block}
.roko-pill[data-state=running] .roko-pill-glyph{animation:roko-spin 1.6s linear infinite}
.roko-kind{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;background:var(--ui-bg-quaternary);color:var(--ui-text-tertiary);font-size:10.5px;font-weight:600;letter-spacing:.01em;white-space:nowrap}
.roko-glyph{display:inline-flex;justify-content:center;width:14px;flex:none;font-weight:700;color:var(--roko-muted)}
.roko-glyph[data-tone=good]{color:var(--roko-good)}.roko-glyph[data-tone=bad]{color:var(--roko-bad)}.roko-glyph[data-tone=warn]{color:var(--roko-warn)}.roko-glyph[data-tone=live]{color:var(--roko-live)}
.roko-dot{position:relative;display:inline-block;width:7px;height:7px;flex:none;border-radius:999px;background:var(--roko-muted)}
.roko-dot[data-tone=good]{background:var(--roko-good)}.roko-dot[data-tone=bad]{background:var(--roko-bad)}.roko-dot[data-tone=warn]{background:var(--roko-warn)}.roko-dot[data-tone=live]{background:var(--roko-live)}
.roko-dot[data-pulse=true]::after{content:"";position:absolute;inset:0;border-radius:inherit;background:inherit;animation:roko-ping 1.8s cubic-bezier(0,0,.2,1) infinite}
.roko-tone-good{color:var(--roko-good)}.roko-tone-bad{color:var(--roko-bad)}.roko-tone-warn{color:var(--roko-warn)}.roko-tone-live{color:var(--roko-live)}
.roko-stats{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;font-size:12px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.roko-stat{display:inline-flex;align-items:center;gap:4px}
.roko-stat-label{font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-estimate{padding:2px 8px;border-radius:6px;background:var(--ui-bg-quaternary)}
.roko-meter{display:inline-flex;align-items:center;gap:9px;font-variant-numeric:tabular-nums}
.roko-meter-text{white-space:nowrap}
.roko-meter-track{position:relative;width:96px;height:6px;overflow:hidden;border-radius:999px;background:var(--ui-bg-tertiary)}
.roko-meter[data-compact=true] .roko-meter-track{width:54px;height:5px}
.roko-meter-fill{position:absolute;left:0;top:0;bottom:0;border-radius:inherit;background:var(--roko-live);transition:width .6s var(--roko-ease)}
.roko-meter-ghost{position:absolute;left:0;top:0;bottom:0;border-radius:inherit;background:repeating-linear-gradient(-45deg,color-mix(in srgb,var(--roko-live) 40%,transparent) 0 2px,transparent 2px 4px);transition:width .6s var(--roko-ease)}
.roko-meter-tick{position:absolute;left:80%;top:0;bottom:0;width:1px;background:color-mix(in srgb,var(--ui-text-primary) 25%,transparent)}
.roko-meter[data-level=warn] .roko-meter-fill{background:var(--roko-warn)}.roko-meter[data-level=warn] .roko-strong{color:var(--roko-warn)}
.roko-meter[data-level=bad] .roko-meter-fill{background:var(--roko-bad)}.roko-meter[data-level=bad] .roko-strong{color:var(--roko-bad)}
.roko-meter[data-level=none] .roko-meter-track{opacity:.5}
.roko-strong{font-weight:600;color:var(--ui-text-primary)}
.roko-muted{color:var(--ui-text-tertiary);font-size:12px}
.roko-mono{font-family:var(--roko-mono);font-size:11.5px}
.roko-wrap{overflow-wrap:anywhere}
.roko-flex{flex:1}
.roko-section-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px;font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-section-label>:nth-child(2){font-size:11.5px;font-weight:500;letter-spacing:0;text-transform:none}
.roko-chip{display:inline-flex;align-items:center;gap:3px;max-width:100%;padding:1px 6px;border-radius:5px;background:var(--ui-bg-quaternary);color:var(--ui-text-secondary);font-family:var(--roko-mono);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.roko-chip[data-tone=good]{color:var(--roko-good)}.roko-chip[data-tone=bad]{color:var(--roko-bad);background:color-mix(in srgb,var(--roko-bad) 10%,transparent)}
.roko-chip-btn{border:0;cursor:pointer}.roko-chip-btn:hover{color:var(--ui-text-primary);background:var(--ui-bg-tertiary)}
.roko-copyid{display:inline-flex;align-items:center;gap:4px;padding:1px 4px;border:0;border-radius:5px;background:none;color:var(--ui-text-tertiary);font-family:var(--roko-mono);font-size:11px;cursor:pointer}
.roko-copyid:hover{background:var(--ui-row-hover-background);color:var(--ui-text-primary)}
.roko-copyid .codicon{opacity:0;transition:opacity .12s}.roko-copyid:hover .codicon,.roko-copyid:focus-visible .codicon{opacity:.8}
.roko-model{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:6px;background:color-mix(in srgb,var(--ui-purple) 13%,transparent);color:var(--ui-text-primary);font-family:var(--roko-mono);font-size:11px;white-space:nowrap}
.roko-model .codicon{color:var(--ui-purple)}
.roko-keys{display:inline-flex;margin-left:4px;opacity:.85}
.roko-branch{display:inline-flex;align-items:center;gap:4px;font-family:var(--roko-mono);font-size:11.5px;color:var(--ui-text-secondary)}
.roko-path{display:inline-flex;min-width:0;overflow:hidden;white-space:nowrap;font-family:var(--roko-mono);font-size:11.5px}
.roko-path-dir{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--ui-text-tertiary)}
.roko-path-base{flex:none;color:var(--ui-text-primary);font-weight:550}
.roko-diffstat{display:inline-flex;align-items:center;gap:6px;font-family:var(--roko-mono);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.roko-add{color:var(--roko-good)}.roko-del{color:var(--roko-bad)}
.roko-statcells{display:inline-flex;gap:1.5px}
.roko-statcells span{width:6px;height:6px;border-radius:1.5px;background:var(--ui-bg-tertiary)}
.roko-statcells span[data-kind=add]{background:var(--roko-good)}.roko-statcells span[data-kind=del]{background:var(--roko-bad)}
.roko-mission{gap:14px;padding:18px 20px 14px}
.roko-hero{display:flex;flex-direction:column;gap:9px}
.roko-hero-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:26px}
.roko-hero-title{margin:2px 0 0;font-size:19px;line-height:1.28;font-weight:650;letter-spacing:-.015em;color:var(--ui-text-primary);overflow-wrap:anywhere;text-wrap:balance}
.roko-hero-slug{display:inline-flex;align-items:center;gap:5px;margin-top:-4px;font-family:var(--roko-mono);font-size:11px;color:var(--ui-text-tertiary)}
.roko-hero-request{display:flex;gap:7px;align-items:flex-start;margin:0;max-width:78ch;font-size:12.5px;line-height:1.55;color:var(--ui-text-secondary);overflow-wrap:anywhere}
.roko-hero-request .codicon{flex:none;margin-top:3px;color:var(--ui-text-quaternary)}
.roko-instruments{display:flex;flex-wrap:wrap;gap:12px 28px;padding:12px 16px;border-radius:11px;background:var(--roko-sunk);border:1px solid var(--roko-line-soft)}
.roko-instrument{display:flex;flex-direction:column;gap:6px;min-width:0}
.roko-instrument-label{font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-instrument-value{display:flex;align-items:center;gap:8px;min-height:38px;font-size:13px;color:var(--ui-text-primary);font-variant-numeric:tabular-nums}
.roko-instrument-sub{font-size:12px;color:var(--ui-text-secondary)}
.roko-instrument-sub b{font-weight:650;color:var(--ui-text-primary)}
.roko-clock{font-family:var(--roko-mono);font-size:20px;font-weight:500;letter-spacing:-.02em;font-variant-numeric:tabular-nums;color:var(--ui-text-primary)}
.roko-clock[data-live=true]{color:var(--roko-live)}
.roko-cc .roko-clock{font-size:inherit;font-weight:inherit;letter-spacing:0;color:inherit}
.roko-stepclock{font-family:var(--roko-mono);font-size:10.5px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.roko-ring{position:relative;display:inline-grid;place-items:center;flex:none}
.roko-ring svg{display:block;overflow:visible}
.roko-ring-track{stroke:var(--ui-bg-tertiary)}
.roko-ring-arc{transition:stroke-dasharray .6s var(--roko-ease),stroke-dashoffset .6s var(--roko-ease);stroke:var(--ui-text-tertiary)}
.roko-ring-arc[data-kind=passed]{stroke:var(--roko-good)}.roko-ring-arc[data-kind=failed]{stroke:var(--roko-bad)}.roko-ring-arc[data-kind=blocked],.roko-ring-arc[data-kind=unverified]{stroke:var(--roko-warn)}.roko-ring-arc[data-kind=stopped]{stroke:var(--ui-text-quaternary)}
.roko-ring-arc[data-kind=running]{stroke:var(--roko-live);animation:roko-pulse 1.6s ease-in-out infinite}
.roko-ring-label{position:absolute;font-size:11px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.roko-ring-label i{font-style:normal;font-weight:500;color:var(--ui-text-tertiary)}
.roko-segbar{display:flex;gap:2px;width:100%;overflow:hidden}
.roko-segbar-seg{min-width:3px;border-radius:2px;background:var(--ui-bg-tertiary);transition:flex-grow .6s var(--roko-ease)}
.roko-segbar-seg[data-kind=passed]{background:var(--roko-good)}.roko-segbar-seg[data-kind=failed]{background:var(--roko-bad)}.roko-segbar-seg[data-kind=blocked],.roko-segbar-seg[data-kind=unverified]{background:var(--roko-warn)}.roko-segbar-seg[data-kind=stopped]{background:var(--ui-text-quaternary)}
.roko-segbar-seg[data-kind=running]{background:repeating-linear-gradient(-45deg,var(--roko-live) 0 3px,color-mix(in srgb,var(--roko-live) 55%,transparent) 3px 6px);background-size:8.5px 8.5px;animation:roko-stripes .8s linear infinite}
.roko-why{display:flex;gap:11px;align-items:flex-start;padding:12px 14px;border-radius:11px;border:1px solid color-mix(in srgb,var(--roko-why) 30%,transparent);background:color-mix(in srgb,var(--roko-why) 7%,transparent);--roko-why:var(--ui-text-tertiary)}
.roko-why[data-tone=bad]{--roko-why:var(--roko-bad)}.roko-why[data-tone=warn]{--roko-why:var(--roko-warn)}
.roko-why-icon{flex:none;margin-top:1px;color:var(--roko-why)}
.roko-why-body{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0}
.roko-why-title{font-weight:650;font-size:12.5px;color:var(--ui-text-primary)}
.roko-why-text{margin:0;font-size:12.5px;line-height:1.6;color:var(--ui-text-secondary);overflow-wrap:anywhere}
.roko-now{position:relative;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 10px;overflow:hidden;border-radius:10px;border:1px solid color-mix(in srgb,var(--roko-live) 22%,transparent);background:linear-gradient(90deg,color-mix(in srgb,var(--roko-live) 9%,transparent),transparent 75%)}
.roko-now::after{content:"";position:absolute;inset:0;pointer-events:none;background:linear-gradient(100deg,transparent 35%,color-mix(in srgb,var(--roko-live) 10%,transparent) 50%,transparent 65%);transform:translateX(-100%);animation:roko-shimmer 3.2s ease-in-out infinite}
.roko-now-label{display:inline-flex;align-items:center;gap:7px;padding-right:4px;font-size:10px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--roko-live)}
.roko-now-item{position:relative;z-index:1;display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;padding:3px 9px;border:1px solid color-mix(in srgb,var(--roko-live) 22%,transparent);border-radius:999px;background:var(--roko-surface);color:var(--ui-text-secondary);font:inherit;font-size:12px;cursor:pointer}
.roko-now-item:hover{border-color:color-mix(in srgb,var(--roko-live) 45%,transparent);color:var(--ui-text-primary)}
.roko-now-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ui-text-primary)}
.roko-now-step{color:var(--roko-live);font-weight:550;white-space:nowrap}
.roko-now-idle{font-size:12px;color:var(--ui-text-secondary)}
.roko-waiting-block{display:flex;flex-direction:column;gap:8px}
.roko-runtabs{display:flex;align-items:center;gap:2px;margin-top:2px;border-bottom:1px solid var(--roko-line-soft)}
.roko-runtab{position:relative;display:inline-flex;align-items:center;gap:6px;padding:8px 11px 9px;border:0;background:none;color:var(--ui-text-tertiary);font:inherit;font-size:12.5px;font-weight:550;cursor:pointer;transition:color .15s}
.roko-runtab:hover{color:var(--ui-text-primary)}
.roko-runtab[aria-selected=true]{color:var(--ui-text-primary)}
.roko-runtab[aria-selected=true]::after{content:"";position:absolute;left:9px;right:9px;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--ui-accent)}
.roko-runtab:focus-visible{outline:2px solid var(--ui-accent);outline-offset:-2px;border-radius:6px}
.roko-runtab-count{min-width:18px;padding:0 5px;border-radius:999px;background:var(--ui-bg-tertiary);color:var(--ui-text-secondary);font-size:10.5px;text-align:center;font-variant-numeric:tabular-nums}
.roko-runtabs-hint{display:inline-flex;gap:3px;opacity:.7}
.roko-runbody{min-width:0;animation:roko-rise .2s var(--roko-ease)}
.roko-run-foot{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;padding-top:6px;border-top:1px solid var(--roko-line-soft)}
.roko-overview{display:flex;flex-direction:column;gap:14px}
.roko-overview-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.roko-overview-col{display:flex;flex-direction:column;gap:8px;min-width:0}
.roko-graph-card{display:flex;flex-direction:column;gap:10px;min-width:0}
.roko-graph-empty{align-items:center;justify-content:center;min-height:120px;border-radius:11px;border:1px dashed var(--roko-line);color:var(--ui-text-tertiary);font-size:12.5px}
.roko-graph-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:24px}
.roko-graph-title{font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-graph-hint{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ui-text-tertiary)}
.roko-legend{display:inline-flex;flex-wrap:wrap;gap:4px 11px;font-size:11px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.roko-legend-item{display:inline-flex;align-items:center;gap:5px}
.roko-legend-item i{width:7px;height:7px;border-radius:2px;background:var(--ui-bg-tertiary);border:1px solid var(--ui-stroke-secondary)}
.roko-legend-item[data-kind=passed] i{background:var(--roko-good);border-color:transparent}.roko-legend-item[data-kind=failed] i{background:var(--roko-bad);border-color:transparent}.roko-legend-item[data-kind=running] i{background:var(--roko-live);border-color:transparent}.roko-legend-item[data-kind=blocked] i{border-style:dashed;border-color:var(--roko-warn)}
.roko-graph-frame{position:relative;overflow-x:auto;overflow-y:hidden;padding:6px 0 4px;border-radius:12px;border:1px solid var(--roko-line-soft);background:radial-gradient(color-mix(in srgb,var(--ui-text-primary) 8%,transparent) 1px,transparent 1.3px) 0 0/16px 16px,var(--roko-sunk)}
.roko-graph{position:relative;margin:0 auto}
.roko-graph-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.roko-wave-label{font-family:var(--roko-mono);font-size:9.5px;font-weight:650;letter-spacing:.12em;fill:var(--ui-text-quaternary)}
.roko-wave-label-html{position:absolute;top:4px;color:var(--ui-text-quaternary)}
.roko-edge{fill:none;stroke:var(--ui-stroke-secondary);stroke-width:1.4;transition:stroke .3s}
.roko-edge-end{fill:var(--ui-stroke-secondary);transition:fill .3s}
.roko-edge[data-state=done]{stroke:color-mix(in srgb,var(--roko-good) 55%,var(--ui-stroke-secondary))}.roko-edge-end[data-state=done]{fill:color-mix(in srgb,var(--roko-good) 65%,transparent)}
.roko-edge[data-state=live]{stroke:var(--roko-live);stroke-width:1.6;stroke-dasharray:4 5;animation:roko-flow .9s linear infinite}.roko-edge-end[data-state=live]{fill:var(--roko-live)}
.roko-edge[data-state=blocked],.roko-edge[data-state=broken]{stroke:color-mix(in srgb,var(--roko-bad) 45%,transparent);stroke-dasharray:2 4}.roko-edge-end[data-state=blocked],.roko-edge-end[data-state=broken]{fill:color-mix(in srgb,var(--roko-bad) 45%,transparent)}
.roko-node{position:absolute;display:flex;flex-direction:column;justify-content:center;gap:5px;padding:0 10px 0 13px;overflow:hidden;border:1px solid var(--roko-line);border-radius:10px;background:var(--roko-surface);color:var(--ui-text-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;box-shadow:0 1px 2px color-mix(in srgb,var(--ui-base) 6%,transparent);transition:border-color .25s var(--roko-ease),background-color .25s var(--roko-ease),opacity .25s,transform .15s var(--roko-ease),box-shadow .25s}
.roko-node::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--roko-node-accent,transparent);transition:background-color .25s}
.roko-node:hover{transform:translateY(-1px);box-shadow:0 6px 16px -10px color-mix(in srgb,var(--ui-base) 45%,transparent)}
.roko-node:focus-visible,.roko-node[data-selected=true]{outline:2px solid color-mix(in srgb,var(--ui-accent) 70%,transparent);outline-offset:2px}
.roko-node[data-state=pending]{background:color-mix(in srgb,var(--roko-surface) 55%,transparent);border-color:var(--roko-line-soft);color:var(--ui-text-secondary)}
.roko-node[data-state=pending] .roko-node-title{font-weight:500}
.roko-node[data-state=running]{--roko-node-accent:var(--roko-live);border-color:color-mix(in srgb,var(--roko-live) 55%,transparent);background:color-mix(in srgb,var(--roko-live) 7%,var(--roko-surface));animation:roko-breathe 2.4s ease-in-out infinite}
.roko-node[data-state=passed]{--roko-node-accent:var(--roko-good);border-color:color-mix(in srgb,var(--roko-good) 32%,var(--roko-line));background:color-mix(in srgb,var(--roko-good) 5%,var(--roko-surface))}
.roko-node[data-state=failed]{--roko-node-accent:var(--roko-bad);border-color:color-mix(in srgb,var(--roko-bad) 45%,var(--roko-line));background:color-mix(in srgb,var(--roko-bad) 7%,var(--roko-surface))}
.roko-node[data-state=unverified]{--roko-node-accent:var(--roko-warn);border-color:color-mix(in srgb,var(--roko-warn) 40%,var(--roko-line))}
.roko-node[data-state=blocked]{border-style:dashed;border-color:color-mix(in srgb,var(--roko-warn) 45%,var(--roko-line));background:transparent;color:var(--ui-text-tertiary)}
.roko-node[data-state=stopped]{border-style:dashed;background:transparent;color:var(--ui-text-tertiary);opacity:.8}
.roko-node[data-state=plan]{--roko-node-accent:color-mix(in srgb,var(--ui-accent) 55%,transparent)}
.roko-node-top{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;padding-right:30px;line-height:1.38;min-width:0}
.roko-node-corner{position:absolute;top:8px;right:9px;display:inline-flex;align-items:center;gap:5px}
.roko-node-id{display:inline-block;flex:none;padding:0 5px;border-radius:4px;background:var(--ui-bg-quaternary);color:var(--ui-text-tertiary);font-family:var(--roko-mono);font-size:10px;font-weight:650;line-height:16px;letter-spacing:.02em;vertical-align:1px}
.roko-node-title{font-weight:600}
.roko-node-mark{display:inline-flex;flex:none;font-weight:800;font-size:12px;color:var(--roko-muted)}
.roko-node-mark .codicon{color:inherit}
.roko-node-mark[data-tone=good]{color:var(--roko-good)}.roko-node-mark[data-tone=bad]{color:var(--roko-bad)}.roko-node-mark[data-tone=warn]{color:var(--roko-warn)}
.roko-node-spin{flex:none;width:11px;height:11px;border-radius:50%;border:1.6px solid color-mix(in srgb,var(--roko-live) 22%,transparent);border-top-color:var(--roko-live);animation:roko-spin .9s linear infinite}
.roko-node-attempts{flex:none;padding:0 4px;border-radius:4px;background:color-mix(in srgb,var(--roko-warn) 16%,transparent);color:var(--roko-warn);font-family:var(--roko-mono);font-size:10px;font-weight:650}
.roko-node-foot{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.roko-node-meta{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-node-model{font-family:var(--roko-mono);font-size:10.5px}
.roko-node-step{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--roko-live);font-weight:550}
.roko-pips{display:inline-flex;align-items:center;gap:3px;margin-left:auto;flex:none}
.roko-pip{width:7px;height:7px;border-radius:50%;border:1.3px solid var(--ui-stroke-secondary);background:transparent}
.roko-pip[data-state=pass]{background:var(--roko-good);border-color:transparent}.roko-pip[data-state=fail]{background:var(--roko-bad);border-color:transparent}
.roko-pip[data-state=run]{border-color:var(--roko-live);background:color-mix(in srgb,var(--roko-live) 35%,transparent);animation:roko-pulse 1.2s ease-in-out infinite}
.roko-pips-more{font-size:10px;color:var(--ui-text-tertiary)}
.roko-mini{display:block;flex:none;overflow:visible}
.roko-mini-edge{stroke:var(--ui-stroke-secondary);stroke-width:1}
.roko-mini-dot{fill:var(--ui-bg-tertiary);stroke:var(--ui-stroke-secondary);stroke-width:1;transition:fill .3s}
.roko-mini-dot[data-state=passed]{fill:var(--roko-good);stroke:transparent}.roko-mini-dot[data-state=failed]{fill:var(--roko-bad);stroke:transparent}.roko-mini-dot[data-state=running]{fill:var(--roko-live);stroke:transparent;animation:roko-pulse 1.4s ease-in-out infinite}.roko-mini-dot[data-state=blocked]{fill:transparent;stroke:var(--roko-warn);stroke-dasharray:2 1.5}.roko-mini-dot[data-state=stopped]{fill:var(--ui-text-quaternary);stroke:transparent}
.roko-inspector{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:11px;border:1px solid var(--roko-line);background:var(--roko-surface);animation:roko-rise .22s var(--roko-ease)}
.roko-inspector-head{display:flex;align-items:center;gap:8px;min-width:0}
.roko-inspector-title{flex:1;min-width:0;font-weight:600;font-size:13.5px;overflow-wrap:anywhere}
.roko-inspector-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:12px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.roko-plan-desc{margin:0;font-size:12.5px;line-height:1.6;color:var(--ui-text-secondary);overflow-wrap:anywhere}
.roko-checklist{display:flex;flex-direction:column;gap:4px}
.roko-checkcmd{display:block;padding:5px 9px;border-radius:7px;background:var(--roko-sunk);border:1px solid var(--roko-line-soft);font-family:var(--roko-mono);font-size:11.5px;color:var(--ui-text-primary);overflow-wrap:anywhere}
.roko-checkcmd span{color:var(--ui-text-quaternary)}
.roko-pipe{display:flex;flex-direction:column;gap:7px}
.roko-pipe-row{display:flex;align-items:center;flex-wrap:wrap;row-gap:6px;font-size:11.5px}
.roko-pipe-label{width:30px;flex:none;font-family:var(--roko-mono);font-size:10.5px;color:var(--ui-text-quaternary)}
.roko-pipe-stage{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:7px;border:1px solid var(--roko-line);background:var(--roko-surface);color:var(--ui-text-secondary);font-family:var(--roko-mono);font-size:11px;white-space:nowrap}
.roko-pipe-stage .codicon{color:var(--ui-purple)}
.roko-pipe-stage[data-state=pass]{border-color:color-mix(in srgb,var(--roko-good) 40%,var(--roko-line));color:var(--ui-text-primary)}.roko-pipe-stage[data-state=pass] span{color:var(--roko-good)}
.roko-pipe-stage[data-state=fail]{border-color:color-mix(in srgb,var(--roko-bad) 50%,var(--roko-line));background:color-mix(in srgb,var(--roko-bad) 7%,var(--roko-surface));color:var(--ui-text-primary)}.roko-pipe-stage[data-state=fail] span{color:var(--roko-bad)}
.roko-pipe-stage[data-state=run]{border-color:color-mix(in srgb,var(--roko-live) 60%,transparent);color:var(--ui-text-primary);animation:roko-breathe 2.4s ease-in-out infinite}.roko-pipe-stage[data-state=run] span{color:var(--roko-live)}
.roko-pipe-link{width:14px;height:1px;flex:none;background:var(--ui-stroke-secondary)}
.roko-pipe-end{padding:0 6px;font-size:11px;font-weight:650;color:var(--ui-text-tertiary)}
.roko-pipe-end[data-state=passed]{color:var(--roko-good)}.roko-pipe-end[data-state=failed]{color:var(--roko-bad)}.roko-pipe-end[data-state=running]{color:var(--roko-live)}.roko-pipe-end[data-state=blocked],.roko-pipe-end[data-state=unverified]{color:var(--roko-warn)}
.roko-pipe-time{margin-left:auto;padding-left:10px;font-family:var(--roko-mono);font-size:10.5px;color:var(--ui-text-quaternary)}
.roko-checkout{display:flex;flex-direction:column;gap:7px}
.roko-keyline{display:flex;gap:8px;align-items:flex-start;padding:8px 11px;border-radius:8px;border:1px solid color-mix(in srgb,var(--roko-bad) 26%,transparent);background:color-mix(in srgb,var(--roko-bad) 7%,transparent);font-family:var(--roko-mono);font-size:11.5px;line-height:1.5;color:var(--ui-text-primary);overflow-wrap:anywhere}
.roko-keyline .codicon{flex:none;margin-top:2px;color:var(--roko-bad)}
.roko-note-block{display:flex;flex-direction:column;gap:7px}
.roko-quote{margin:0;padding:9px 13px;border-left:2px solid color-mix(in srgb,var(--ui-purple) 60%,transparent);border-radius:0 9px 9px 0;background:var(--roko-sunk)}
.roko-quote .roko-clamp-text{font-style:italic;color:var(--ui-text-secondary)}
.roko-deps{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.roko-callout{display:flex;align-items:flex-start;gap:8px;padding:8px 11px;border-radius:9px;background:var(--roko-sunk);font-size:12px;color:var(--ui-text-secondary)}
.roko-callout .codicon{flex:none;margin-top:2px}
.roko-callout[data-tone=warn]{background:color-mix(in srgb,var(--roko-warn) 9%,transparent);color:var(--ui-text-primary)}.roko-callout[data-tone=warn] .codicon{color:var(--roko-warn)}
.roko-feed{position:relative;display:flex;flex-direction:column;gap:8px;min-width:0}
.roko-feed-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.roko-filters{display:inline-flex;flex-wrap:wrap;gap:4px}
.roko-filter{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:999px;border:1px solid var(--roko-line);background:transparent;color:var(--ui-text-secondary);font:inherit;font-size:11.5px;cursor:pointer;transition:background-color .15s,border-color .15s}
.roko-filter:hover{color:var(--ui-text-primary)}
.roko-filter[aria-pressed=true]{border-color:color-mix(in srgb,var(--ui-accent) 45%,transparent);background:color-mix(in srgb,var(--ui-accent) 12%,transparent);color:var(--ui-text-primary)}
.roko-filter-count{font-size:10.5px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.roko-live-tag{display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--roko-live)}
.roko-feed-list{display:flex;flex-direction:column;max-height:480px;overflow:auto;padding:6px 0;border-radius:10px;border:1px solid var(--roko-line-soft);background:var(--roko-sunk);font-size:12px}
.roko-feed[data-compact=true] .roko-feed-list{max-height:none;overflow:visible}
.roko-feed-empty{padding:4px 2px}
.roko-feed-row{display:grid;grid-template-columns:50px 16px minmax(0,1fr);gap:7px;align-items:baseline;padding:3px 12px 3px 6px;line-height:1.5;transition:opacity .2s,background-color .2s;animation:roko-rise .3s var(--roko-ease) both}
.roko-feed-row:hover{background:var(--ui-row-hover-background)}
.roko-feed-time{font-family:var(--roko-mono);font-size:10.5px;color:var(--ui-text-quaternary);text-align:right;font-variant-numeric:tabular-nums}
.roko-feed-icon{display:inline-flex;justify-content:center;color:var(--ui-text-tertiary);transform:translateY(2px)}
.roko-feed-row[data-tone=good] .roko-feed-icon{color:var(--roko-good)}.roko-feed-row[data-tone=bad] .roko-feed-icon{color:var(--roko-bad)}.roko-feed-row[data-tone=warn] .roko-feed-icon{color:var(--roko-warn)}.roko-feed-row[data-tone=live] .roko-feed-icon{color:var(--roko-live)}
.roko-feed-row[data-group=agent] .roko-feed-icon{color:color-mix(in srgb,var(--ui-purple) 85%,var(--ui-text-primary))}
.roko-feed-text{min-width:0;color:var(--ui-text-secondary);overflow-wrap:anywhere}
.roko-feed-row[data-tone=bad] .roko-feed-text{color:var(--ui-text-primary)}
.roko-feed-quote{display:flex;gap:7px;min-width:0}
.roko-feed-task{flex:none;font-family:var(--roko-mono);font-size:10.5px;color:var(--ui-text-tertiary)}
.roko-feed-said{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic;color:var(--ui-text-tertiary)}
.roko-feed-row[data-future=true]{opacity:.28}
.roko-feed-row[data-current=true]{background:color-mix(in srgb,var(--ui-accent) 11%,transparent)}
.roko-feed-jump{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 12px;border-radius:999px;border:1px solid color-mix(in srgb,var(--ui-accent) 40%,transparent);background:var(--ui-bg-elevated);color:var(--ui-text-primary);font:inherit;font-size:11.5px;cursor:pointer;box-shadow:0 6px 18px -8px color-mix(in srgb,var(--ui-base) 50%,transparent);animation:roko-rise .2s var(--roko-ease)}
.roko-feed-all{align-self:flex-start;margin-left:6px}
.roko-replay{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:10px;border:1px solid var(--roko-line-soft);background:var(--roko-sunk);animation:roko-rise .2s var(--roko-ease)}
.roko-replay-play{display:inline-grid;place-items:center;flex:none;width:28px;height:28px;border:0;border-radius:50%;background:var(--ui-accent);color:var(--ui-bg-editor);cursor:pointer;box-shadow:0 2px 8px -3px color-mix(in srgb,var(--ui-accent) 70%,transparent)}
.roko-replay-play:focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}
.roko-replay-track{position:relative;flex:1;height:24px;cursor:pointer;touch-action:none;border-radius:6px}
.roko-replay-track:focus-visible{outline:2px solid color-mix(in srgb,var(--ui-accent) 60%,transparent);outline-offset:2px}
.roko-replay-track::before{content:"";position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;border-radius:2px;background:var(--ui-bg-tertiary)}
.roko-replay-fill{position:absolute;left:0;top:50%;height:4px;margin-top:-2px;border-radius:2px;background:color-mix(in srgb,var(--ui-accent) 75%,transparent)}
.roko-replay-tick{position:absolute;top:5px;width:2px;height:14px;margin-left:-1px;border-radius:1px;background:var(--ui-stroke-secondary);opacity:.85;pointer-events:none}
.roko-replay-tick[data-group=agent]{background:color-mix(in srgb,var(--ui-purple) 75%,transparent)}.roko-replay-tick[data-group=gate]{background:color-mix(in srgb,var(--ui-cyan) 80%,transparent)}.roko-replay-tick[data-tone=good]{background:var(--roko-good)}.roko-replay-tick[data-tone=bad]{background:var(--roko-bad);height:18px;top:3px}
.roko-replay-head{position:absolute;top:50%;width:13px;height:13px;margin:-6.5px 0 0 -6.5px;border-radius:50%;border:2px solid var(--ui-accent);background:var(--roko-surface);box-shadow:0 1px 5px color-mix(in srgb,var(--ui-base) 30%,transparent);pointer-events:none}
.roko-replay-time{min-width:92px;font-family:var(--roko-mono);font-size:11px;color:var(--ui-text-secondary);text-align:right;font-variant-numeric:tabular-nums}
.roko-changes{display:flex;flex-direction:column;gap:10px;min-width:0;container-type:inline-size}
.roko-changes-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.roko-changes-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px}
.roko-changes-body{display:grid;grid-template-columns:minmax(170px,230px) minmax(0,1fr);gap:12px;align-items:start}
@container (max-width:700px){.roko-changes-body{grid-template-columns:minmax(0,1fr)}.roko-filelist{position:static;max-height:220px}}
.roko-filelist{position:sticky;top:0;display:flex;flex-direction:column;gap:1px;max-height:72vh;overflow:auto;padding:4px;border-radius:10px;border:1px solid var(--roko-line-soft);background:var(--roko-sunk)}
.roko-filename{display:flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}
.roko-filename-base{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--roko-mono);font-size:11.5px;color:var(--ui-text-primary)}
.roko-filename-dir{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:10.5px;color:var(--ui-text-tertiary)}
.roko-filelist-stat{display:inline-flex;gap:5px;font-family:var(--roko-mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.roko-filelist-row{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:7px;align-items:center;padding:5px 7px;border:0;border-radius:6px;background:none;color:var(--ui-text-secondary);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.roko-filelist-row:hover,.roko-filelist-row[aria-current=true]{background:var(--ui-row-hover-background);color:var(--ui-text-primary)}
.roko-status-letter{font-family:var(--roko-mono);font-size:10.5px;font-weight:800;text-align:center;color:var(--ui-text-tertiary)}
.roko-status-letter[data-status=added]{color:var(--roko-good)}.roko-status-letter[data-status=deleted]{color:var(--roko-bad)}.roko-status-letter[data-status=modified]{color:var(--ui-orange)}.roko-status-letter[data-status=renamed]{color:var(--ui-purple)}
.roko-diffs{display:flex;flex-direction:column;gap:12px;min-width:0}
.roko-filediff{min-width:0;overflow:clip;border:1px solid var(--roko-line);border-radius:10px;background:var(--roko-surface)}
.roko-filediff-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;min-width:0;padding:5px 8px 5px 6px;border-bottom:1px solid var(--roko-line-soft);background:var(--ui-bg-elevated)}
.roko-filediff-toggle{display:flex;flex:1;align-items:center;gap:7px;min-width:0;padding:2px 4px;border:0;border-radius:6px;background:none;color:var(--ui-text-primary);font:inherit;text-align:left;cursor:pointer}
.roko-filediff-toggle:hover{background:var(--ui-row-hover-background)}
.roko-caret{flex:none;color:var(--ui-text-tertiary)}
.roko-filediff-body{overflow-x:auto;font-family:var(--roko-mono);font-size:11.5px;line-height:1.6}
.roko-dl{display:grid;grid-template-columns:42px 42px 18px minmax(0,1fr);min-width:max-content}
.roko-ln{padding:0 8px;text-align:right;color:var(--ui-text-quaternary);user-select:none;font-variant-numeric:tabular-nums}
.roko-ln+.roko-ln{border-right:1px solid var(--roko-line-soft)}
.roko-sign{text-align:center;user-select:none;color:var(--ui-text-quaternary)}
.roko-dcode{padding-right:18px;white-space:pre;color:var(--ui-text-primary);font:inherit;background:none}
.roko-dl[data-tag=add]{background:var(--ui-diff-add-background);box-shadow:inset 2px 0 0 var(--ui-diff-add-border)}.roko-dl[data-tag=add] .roko-sign{color:var(--ui-diff-add-foreground);font-weight:700}
.roko-dl[data-tag=del]{background:var(--ui-diff-remove-background);box-shadow:inset 2px 0 0 var(--ui-diff-remove-border)}.roko-dl[data-tag=del] .roko-sign{color:var(--ui-diff-remove-foreground);font-weight:700}
.roko-dl[data-tag=meta] .roko-dcode{font-style:italic;color:var(--ui-text-tertiary)}
.roko-t-kw{color:color-mix(in srgb,var(--ui-purple) 72%,var(--ui-text-primary));font-weight:500}.roko-t-str{color:color-mix(in srgb,var(--ui-orange) 78%,var(--ui-text-primary))}.roko-t-num{color:color-mix(in srgb,var(--ui-cyan) 80%,var(--ui-text-primary))}.roko-t-com{color:var(--ui-text-tertiary);font-style:italic}
.roko-hunk-head{display:flex;gap:10px;min-width:max-content;padding:2px 10px 2px 102px;border-block:1px solid var(--roko-line-soft);background:color-mix(in srgb,var(--ui-accent) 6%,var(--roko-sunk));color:var(--ui-text-tertiary);font-size:11px}
.roko-hunk-head:first-child{border-top:0}
.roko-hunk-range{color:color-mix(in srgb,var(--ui-accent) 70%,var(--ui-text-tertiary))}
.roko-diff-note{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;font-family:var(--font-sans,inherit);font-size:12px;color:var(--ui-text-tertiary)}
.roko-merge-btn .roko-merge-mode{margin-left:2px;padding-left:7px;border-left:1px solid color-mix(in srgb,currentColor 35%,transparent);font-weight:400;opacity:.8}
.roko-merge-state{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600}
.roko-merge-state[data-tone=good]{color:var(--roko-good)}
.roko-merge-blocked{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.roko-merge-why{display:inline-flex;align-items:center;gap:5px;max-width:420px;padding:3px 8px;border-radius:7px;background:var(--ui-bg-quaternary);color:var(--ui-text-secondary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-merge-confirm{display:flex;flex-direction:column;gap:5px}
.roko-merge-line{display:block}
.roko-merged{display:inline-flex;align-items:center;gap:9px;flex-wrap:wrap;padding:5px 6px 5px 10px;border-radius:9px;border:1px solid color-mix(in srgb,var(--roko-good) 32%,transparent);background:color-mix(in srgb,var(--roko-good) 9%,transparent);font-size:12px}
.roko-merged-check{display:inline-flex}
.roko-merged-check circle{fill:none;stroke:var(--roko-good);stroke-width:1.6;stroke-dasharray:51;stroke-dashoffset:51;animation:roko-draw .5s var(--roko-ease) forwards}
.roko-merged-check path{fill:none;stroke:var(--roko-good);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:14;stroke-dashoffset:14;animation:roko-draw .35s .35s var(--roko-ease) forwards}
.roko-merged-text b{font-weight:650}
.roko-delivered{display:flex;flex-direction:column;gap:8px;min-width:0}
.roko-delivered-line{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--ui-text-secondary)}
.roko-delivered-stat{font-size:12px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.roko-files{display:flex;flex-wrap:wrap;gap:4px}
.roko-pending{position:relative;gap:9px;padding-left:19px;overflow:hidden}
.roko-pending::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--roko-kind-accent,var(--ui-accent))}
.roko-pending[data-kind=effect]{--roko-kind-accent:var(--roko-warn)}
.roko-pending[data-decided=true]{opacity:.82}
.roko-pending-head{display:flex;align-items:center;gap:8px;min-width:0}
.roko-pending-kind{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 7px;border-radius:999px;font-size:10.5px;font-weight:650;letter-spacing:.02em;white-space:nowrap;background:color-mix(in srgb,var(--ui-accent) 13%,transparent);color:var(--ui-accent)}
.roko-pending-kind[data-kind=effect]{background:color-mix(in srgb,var(--roko-warn) 16%,transparent);color:var(--roko-warn)}
.roko-pending-title{flex:1;min-width:0;font-size:12px;color:var(--ui-text-tertiary);overflow-wrap:anywhere}
.roko-pending-head .roko-code{padding:1px 6px;border-radius:5px;border:1px dashed var(--ui-stroke-secondary);font-size:11px;color:var(--ui-text-secondary)}
.roko-question{font-size:14px;font-weight:600;line-height:1.45;overflow-wrap:anywhere}
.roko-effect{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
.roko-effect-call{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:7px;background:color-mix(in srgb,var(--roko-warn) 10%,transparent)}
.roko-args{display:inline-flex;flex-wrap:wrap;gap:4px}
.roko-doc{overflow:clip;border:1px solid var(--roko-line);border-radius:9px;background:var(--roko-sunk)}
.roko-doc-tab{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-right:1px solid var(--roko-line-soft);border-bottom:1px solid var(--roko-line-soft);border-bottom-right-radius:7px;background:var(--roko-surface);font-family:var(--roko-mono);font-size:11px;color:var(--ui-text-secondary)}
.roko-doc-body{padding:9px 12px}
.roko-pending-meta{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:11.5px;color:var(--ui-text-tertiary)}
.roko-pending-meta>span{display:inline-flex;align-items:center;gap:4px}
.roko-countdown{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}
.roko-countdown[data-tone=warn]{color:var(--roko-warn)}.roko-countdown[data-tone=bad]{color:var(--roko-bad)}
.roko-decide{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.roko-note{flex:1;min-width:180px}
.roko-result{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ui-text-secondary)}
.roko-result[data-tone=good]{color:var(--roko-good)}.roko-result[data-tone=bad]{color:var(--roko-bad)}
.roko-result-hint{color:var(--ui-text-tertiary)}
.roko-waiting-head{font-size:12.5px;color:var(--ui-text-secondary)}
.roko-clamp{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0}
.roko-clamp-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55;color:var(--ui-text-secondary)}
.roko-clamp-text.roko-mono{font-size:11.5px}
.roko-clamp-text[data-open=false]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--roko-lines,4);overflow:hidden}
.roko-link{padding:0;border:0;background:none;color:var(--ui-text-tertiary);font:inherit;font-size:11.5px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.roko-link:hover{color:var(--ui-text-primary)}
.roko-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}
.roko-actions-start{justify-content:flex-start}
.roko-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;font-size:12px}
.roko-waves{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(150px,240px);gap:8px;overflow-x:auto;padding-bottom:2px}
.roko-wave{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px dashed var(--roko-line);border-radius:9px}
.roko-wave-head{font-family:var(--roko-mono);font-size:10px;font-weight:650;letter-spacing:.1em;color:var(--ui-text-quaternary)}
.roko-taskchip{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:7px;background:var(--ui-bg-quaternary);font-size:12px}
.roko-taskchip-head{display:flex;gap:6px;align-items:baseline;min-width:0}
.roko-taskchip-title{min-width:0;overflow-wrap:anywhere}
.roko-plan-icon{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:7px;background:color-mix(in srgb,var(--ui-accent) 12%,transparent);color:var(--ui-accent)}
.roko-form{display:flex;flex-direction:column;gap:13px;padding:4px 0}
.roko-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;color:var(--ui-text-secondary)}
.roko-field>label,.roko-field-label{font-weight:600;color:var(--ui-text-primary)}
.roko-field-row{flex-direction:row;align-items:center;gap:10px}
.roko-field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.roko-capchips{display:flex;flex-wrap:wrap;gap:5px}
.roko-capchip{height:24px;padding:0 9px;border-radius:7px;border:1px solid var(--roko-line);background:transparent;color:var(--ui-text-secondary);font:inherit;font-size:12px;font-variant-numeric:tabular-nums;cursor:pointer;transition:background-color .15s,border-color .15s}
.roko-capchip:hover:not(:disabled){color:var(--ui-text-primary);border-color:var(--ui-stroke-secondary)}
.roko-capchip[aria-pressed=true]{border-color:color-mix(in srgb,var(--ui-accent) 55%,transparent);background:color-mix(in srgb,var(--ui-accent) 13%,transparent);color:var(--ui-text-primary)}
.roko-capchip:disabled{opacity:.38;cursor:default}
.roko.roko-composer{max-width:min(600px,94vw);width:100%}
.roko-composer [data-slot=dialog-title]{display:flex;align-items:center;gap:8px}
.roko-composer-mark{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:7px;background:color-mix(in srgb,var(--ui-accent) 11%,transparent)}
.roko-modes{align-self:flex-start}
.roko-prompt{min-height:128px;font-size:13px;line-height:1.55;resize:vertical}
.roko-prompt-foot{display:flex;justify-content:flex-end;min-height:24px}
.roko-prompt-foot .roko-examples{width:100%;align-items:center}
.roko-examples-label{font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-examples{display:flex;flex-wrap:wrap;gap:6px}
.roko-example{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:999px;border:1px dashed var(--ui-stroke-secondary);background:transparent;color:var(--ui-text-secondary);font:inherit;font-size:11.5px;cursor:pointer;transition:background-color .15s,color .15s}
.roko-example:hover{border-style:solid;background:var(--ui-row-hover-background);color:var(--ui-text-primary)}
.roko-composer-limits{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:11.5px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.roko-composer-hint{margin-right:auto;display:inline-flex;align-items:center}
.roko-onboard{display:flex;flex-direction:column;align-items:center;gap:12px;width:100%;max-width:660px;margin:22px auto;padding:30px 28px 26px;text-align:center;border-radius:18px;border:1px solid var(--roko-line);background:radial-gradient(120% 85% at 50% 0%,color-mix(in srgb,var(--ui-accent) 9%,transparent),transparent 62%),var(--roko-surface)}
.roko-onboard-art{width:230px;height:96px;overflow:visible}
.roko-art-edge{fill:none;stroke:var(--ui-stroke-secondary);stroke-width:1.5}
.roko-art-live{stroke:var(--roko-live);stroke-dasharray:4 5;animation:roko-flow .9s linear infinite}
.roko-art-node{fill:var(--roko-surface);stroke:var(--ui-stroke-secondary);stroke-width:1.3}
.roko-art-node[data-state=passed]{fill:color-mix(in srgb,var(--roko-good) 16%,var(--roko-surface));stroke:color-mix(in srgb,var(--roko-good) 65%,transparent)}
.roko-art-node[data-state=running]{fill:color-mix(in srgb,var(--roko-live) 14%,var(--roko-surface));stroke:var(--roko-live);animation:roko-pulse 1.8s ease-in-out infinite}
.roko-art-node[data-state=pending]{stroke-dasharray:3 3}
.roko-onboard-title{margin:4px 0 0;font-size:20px;font-weight:650;letter-spacing:-.018em;text-wrap:balance}
.roko-onboard-text{margin:0;max-width:56ch;font-size:13px;line-height:1.6;color:var(--ui-text-secondary)}
.roko-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;width:100%;margin:8px 0 2px;padding:0;list-style:none;counter-reset:roko}
.roko-steps li{display:flex;flex-direction:column;gap:4px;padding:12px 13px;border-radius:11px;background:var(--roko-sunk);border:1px solid var(--roko-line-soft);font-size:12px;line-height:1.5;color:var(--ui-text-secondary);text-align:left;counter-increment:roko}
.roko-steps b{font-size:12.5px;color:var(--ui-text-primary)}
.roko-steps b::before{content:counter(roko);display:inline-grid;place-items:center;width:17px;height:17px;margin-right:7px;border-radius:50%;background:color-mix(in srgb,var(--ui-accent) 14%,transparent);color:var(--ui-accent);font-size:10.5px;font-weight:700}
.roko-onboard-actions{display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:6px}
.roko-onboard-actions .roko-examples{justify-content:center}
.roko-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}
.roko-kpi{display:flex;flex-direction:column;gap:3px;padding:12px 14px;border-radius:12px;border:1px solid var(--roko-line);background:var(--roko-surface)}
.roko-kpi-label{font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-kpi-value{font-size:23px;font-weight:650;letter-spacing:-.025em;color:var(--ui-text-primary);font-variant-numeric:tabular-nums}
.roko-kpi[data-tone=good] .roko-kpi-value{color:var(--roko-good)}.roko-kpi[data-tone=warn] .roko-kpi-value{color:var(--roko-warn)}.roko-kpi[data-tone=bad] .roko-kpi-value{color:var(--roko-bad)}
.roko-kpi-sub{font-size:11.5px;color:var(--ui-text-tertiary)}
.roko-chart-card{padding:10px 12px}
.roko-chart{position:relative;padding:8px 8px 22px 42px}
.roko-spark{display:block;width:100%;height:150px;color:var(--roko-live);overflow:visible}
.roko-spark-line{stroke:currentColor;stroke-width:1.8;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.roko-spark-area{fill:currentColor;opacity:.12}
.roko-chart-grid{stroke:var(--roko-line-soft);stroke-width:1;vector-effect:non-scaling-stroke}
.roko-chart-cursor{stroke:var(--ui-text-tertiary);stroke-dasharray:3 3;stroke-width:1;vector-effect:non-scaling-stroke}
.roko-chart-y{position:absolute;left:0;width:36px;text-align:right;font-size:10px;color:var(--ui-text-quaternary);font-variant-numeric:tabular-nums}
.roko-chart-ymax{top:6px}.roko-chart-y0{bottom:20px}
.roko-chart-x{position:absolute;bottom:2px;font-size:10px;color:var(--ui-text-quaternary)}
.roko-chart-x0{left:42px}.roko-chart-x1{right:8px}
.roko-chart-tip{position:absolute;z-index:2;transform:translate(-50%,-135%);padding:3px 8px;border-radius:7px;border:1px solid var(--roko-line);background:var(--ui-bg-elevated);font-size:11px;white-space:nowrap;pointer-events:none;box-shadow:0 6px 16px -8px color-mix(in srgb,var(--ui-base) 40%,transparent);font-variant-numeric:tabular-nums}
.roko-checks,.roko-table{gap:0;padding:4px 14px}
.roko-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));column-gap:22px}
.roko-checks .roko-check:nth-child(2){border-top:0}
.roko-check{display:grid;grid-template-columns:16px minmax(0,1fr);gap:9px;padding:9px 0;border-top:1px solid var(--roko-line-soft)}
.roko-check:first-child,.roko-table-row:first-child{border-top:0}
.roko-check-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.roko-check-hint{font-size:12px;color:var(--roko-warn)}
.roko-table-row{display:grid;grid-template-columns:minmax(120px,1.3fr) minmax(60px,1fr) 46px 70px 70px;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--roko-line-soft);font-size:12px}
.roko-table-head{font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-cell-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-cell-num{text-align:right;font-variant-numeric:tabular-nums}
.roko-bar{display:block;height:6px;overflow:hidden;border-radius:999px;background:var(--ui-bg-tertiary)}
.roko-bar-fill{display:block;height:100%;border-radius:inherit;background:var(--roko-muted);transition:width .6s var(--roko-ease)}
.roko-bar[data-tone=good] .roko-bar-fill{background:var(--roko-good)}.roko-bar[data-tone=warn] .roko-bar-fill{background:var(--roko-warn)}.roko-bar[data-tone=bad] .roko-bar-fill{background:var(--roko-bad)}
.roko-bar[data-tone=bad] .roko-bar-fill{min-width:4px}
.roko-confidence{display:inline-flex;align-items:center;gap:6px}
.roko-confidence .roko-bar{width:44px}
.roko-search{width:100%;height:34px}
.roko-knowledge{gap:7px}
.roko-knowledge-head{display:flex;align-items:center;gap:6px}
.roko-banner{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:10px;border:1px solid color-mix(in srgb,var(--roko-warn) 40%,transparent);background:color-mix(in srgb,var(--roko-warn) 8%,transparent);font-size:12.5px;color:var(--ui-text-secondary)}
.roko-banner[data-tone=bad]{border-color:color-mix(in srgb,var(--roko-bad) 35%,transparent);background:color-mix(in srgb,var(--roko-bad) 7%,transparent)}
.roko-banner-icon{margin-top:1px;color:var(--roko-warn)}.roko-banner[data-tone=bad] .roko-banner-icon{color:var(--roko-bad)}
.roko-banner-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.roko-banner-title{font-weight:600;color:var(--ui-text-primary)}
.roko-error{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:10px;border:1px solid color-mix(in srgb,var(--roko-bad) 30%,transparent);background:color-mix(in srgb,var(--roko-bad) 6%,transparent);font-size:12px}
.roko-error[data-compact=true]{padding:7px 10px}
.roko-error-icon{margin-top:1px;color:var(--roko-bad)}
.roko-error-body{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.roko-error-title{font-weight:600;color:var(--ui-text-primary)}
.roko-error-text{color:var(--ui-text-secondary);overflow-wrap:anywhere}
.roko-error-hint{color:var(--ui-text-tertiary)}
.roko-pre{margin:0;max-height:320px;overflow:auto;padding:10px 12px;border-radius:9px;background:var(--roko-sunk);border:1px solid var(--roko-line-soft);color:var(--ui-text-secondary);font-family:var(--roko-mono);font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.roko-empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:38px 16px;text-align:center}
.roko-empty-icon{display:inline-grid;place-items:center;width:38px;height:38px;border-radius:12px;background:var(--ui-bg-quaternary);color:var(--ui-text-tertiary)}
.roko-empty-title{font-weight:600;color:var(--ui-text-secondary)}
.roko-empty-text{max-width:380px;font-size:12px;line-height:1.55;color:var(--ui-text-tertiary)}
.roko-empty-cmd{display:flex;justify-content:center;margin-top:8px}
.roko-loading{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ui-text-tertiary)}
.roko-spinner{width:12px}
.roko-skel{border-radius:8px}
.roko-plangen-live{display:flex;align-items:center;gap:16px;padding:14px;border-radius:11px;border:1px dashed var(--roko-line);background:var(--roko-sunk)}
.roko-plangen-ghosts{display:flex;gap:10px;flex:none}
.roko-ghostcol{display:flex;flex-direction:column;justify-content:center;gap:6px}
.roko-ghostcol i{display:block;width:44px;height:14px;border-radius:5px;background:color-mix(in srgb,var(--roko-live) 18%,transparent);animation:roko-pulse 1.4s ease-in-out infinite}
.roko-ghostcol:nth-child(2) i{animation-delay:.2s}.roko-ghostcol:nth-child(3) i{animation-delay:.4s}
.roko-statuschip{display:inline-flex;align-items:center;gap:6px;height:100%;padding:0 7px;border:0;border-radius:0;background:transparent;color:var(--ui-text-tertiary);font:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer}
.roko-statuschip:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.roko-statuschip-counts{color:var(--ui-text-secondary)}
.roko-statuschip-counts[data-waiting=true]{color:var(--roko-warn)}
.roko-directive{display:flex;flex-direction:column;gap:6px;margin:6px 0;max-width:680px}
.roko-directive-raw{font-family:var(--roko-mono)}
.roko-cc{gap:9px}
.roko-cc-head{display:flex;align-items:center;gap:8px;min-width:0}
.roko-cc-head .roko-run-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-cc-body{display:flex;align-items:center;gap:14px;min-width:0;padding:8px 10px;border-radius:9px;background:var(--roko-sunk)}
.roko-cc-progress{display:flex;flex:1;flex-direction:column;gap:6px;min-width:0}
.roko-cc-stats{font-size:11.5px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.roko-cc-now{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px;color:var(--ui-text-secondary)}
.roko-cc-delivered{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.roko-cc-why{font-size:12px;line-height:1.5;color:var(--ui-text-secondary);overflow-wrap:anywhere}
@keyframes roko-spin{to{transform:rotate(360deg)}}
@keyframes roko-flow{to{stroke-dashoffset:-18}}
@keyframes roko-pulse{0%,100%{opacity:1}50%{opacity:.42}}
@keyframes roko-ping{0%{transform:scale(1);opacity:.55}80%,100%{transform:scale(2.6);opacity:0}}
@keyframes roko-breathe{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--roko-live) 0%,transparent)}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--roko-live) 15%,transparent)}}
@keyframes roko-shimmer{0%{transform:translateX(-100%)}55%,100%{transform:translateX(100%)}}
@keyframes roko-rise{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes roko-draw{to{stroke-dashoffset:0}}
@keyframes roko-stripes{to{background-position:8.5px 0}}
@media (prefers-reduced-motion:reduce){.roko *,.roko *::before,.roko *::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;scroll-behavior:auto!important}.roko-merged-check circle,.roko-merged-check path{stroke-dashoffset:0}}
`

function installStyles() {
  if (typeof document === 'undefined') {
    return () => undefined
  }

  const el = document.createElement('style')

  el.dataset.hermesPlugin = ID
  el.textContent = CSS
  document.head.appendChild(el)

  return () => el.remove()
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

function safe(label, step) {
  try {
    return step()
  } catch (error) {
    console.error(`[roko] could not set up ${label}`, error)

    return undefined
  }
}

/** Open the composer from anywhere: the status chip's host renders it without leaving the current view. */
function newRunAnywhere() {
  const permissions = queryClient.getQueryData(KEYS.overview)?.permissions

  if (isRecord(permissions) && permissions.write === false) {
    openRoko({ tab: 'runs' })

    return
  }

  if (!$composerLeader.get()) {
    openRoko({ tab: 'runs' })
  }

  openComposer()
}

export default {
  id: ID,
  name: 'roko',
  description: 'Mission control for roko: live run graphs, checks and spend, approvals, diffs with a guarded merge, plans, insights, a composer, and live run cards in chat.',
  register(ctx) {
    try {
      doors = { os: ctx.os, rest: ctx.rest }
      resetSeen()
      ctx.onDispose(() => {
        doors = null
        navRegister = null
        resetSeen()
        cancelScheduledRefresh()
        eventCache.clear()
        mergeResults.clear()
        $composer.set({ mode: 'run', open: false, prompt: '' })
        $inspect.set(null)
        void queryClient.cancelQueries({ queryKey: KEYS.all })
        queryClient.removeQueries({ queryKey: KEYS.all })
      })

      safe('styles', () => ctx.onDispose(installStyles()))

      safe('the page', () =>
        ctx.registerMany([
          { area: ROUTES_AREA, data: { path: PAGE }, id: 'page', render: () => h(RokoPage, null) },
          { area: STATUSBAR_AREAS.right, id: 'chip', order: 85, render: () => h(StatusChip, null) },
          {
            area: PALETTE_AREA,
            data: { id: 'roko.open', keywords: ['roko', 'runs', 'plans'], label: 'roko: Open', run: () => openRoko({ tab: 'runs' }) },
            id: 'open'
          },
          {
            area: PALETTE_AREA,
            data: { id: 'roko.new', keywords: ['roko', 'new', 'run', 'delegate', 'task', 'plan'], label: 'roko: New run…', run: newRunAnywhere },
            id: 'new'
          },
          {
            area: PALETTE_AREA,
            data: { id: 'roko.waiting', keywords: ['roko', 'approve', 'approvals', 'waiting', 'pending'], label: "roko: What's waiting on me", run: () => openRoko({ tab: 'waiting' }) },
            id: 'waiting'
          },
          {
            area: PALETTE_AREA,
            data: { id: 'roko.health', keywords: ['roko', 'health', 'doctor', 'connection', 'insights'], label: 'roko: Health check', run: () => openRoko({ tab: 'health' }) },
            id: 'health'
          },
          {
            area: KEYBINDS_AREA,
            data: { category: 'navigation', defaults: [NEW_RUN_COMBO], id: 'roko.newRun', label: 'roko: New run', run: newRunAnywhere },
            id: 'keybind-new-run'
          },
          {
            area: TRANSCRIPT_DIRECTIVE_AREA,
            data: directive('roko-run', 'id', id => h(RunDirective, { runId: id }), 'roko run · waiting for the message to finish'),
            id: 'directive-run'
          },
          {
            area: TRANSCRIPT_DIRECTIVE_AREA,
            data: directive('roko-plan', 'id', id => h('div', { className: 'roko roko-directive' }, h(PlanDetail, { compact: true, planId: id })), 'roko plan · waiting for the message to finish'),
            id: 'directive-plan'
          },
          {
            area: TRANSCRIPT_DIRECTIVE_AREA,
            data: directive('roko-pending', 'run', id => h(PendingDirective, { runId: id }), 'roko · waiting for the message to finish'),
            id: 'directive-pending'
          }
        ])
      )

      safe('the sidebar row', () => {
        navRegister = label =>
          safe('the sidebar row', () => ctx.register({ area: SIDEBAR_NAV_AREA, data: { codicon: 'rocket', label, path: PAGE }, id: 'nav', order: 60 }))
        navRegister(navLabel)
      })

      safe('live updates', () => ctx.onDispose(host.onEvent('tool.complete', event => safe('a tool event', () => onToolComplete(event)))))
      safe('notifications', () => ctx.onDispose(watchOverview()))
      safe('polling', () => ctx.onDispose(startPolling()))
    } catch (error) {
      console.error('[roko] desktop plugin failed to register', error)
    }
  }
}

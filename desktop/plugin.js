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
 * text nodes: no HTML, no markdown, no dangerouslySetInnerHTML.
 *
 * Contributes: the /roko page (Runs, Waiting, Plans, Knowledge, Health), a
 * sidebar row, a status-bar chip, three palette rows, the transcript
 * directives ::roko-run{id}, ::roko-plan{id} and ::roko-pending{run}, live
 * refresh on roko_* tool calls, and a notification when runs finish or new
 * items wait on the person.
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
  DisclosureCaret,
  GlyphSpinner,
  host,
  Input,
  PALETTE_AREA,
  queryClient,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Tip,
  TRANSCRIPT_DIRECTIVE_AREA,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { Fragment, useEffect, useRef, useState } from 'react'
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
const ACTIVE_STATES = new Set(['queued', 'running'])
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'unverified', 'cancelled'])
/** Contract: no faster than 10 s for the overview and 3 s for one run. */
const OVERVIEW_MS = 10_000
const OVERVIEW_HIDDEN_MS = 30_000
const RUN_MS = 3_000
/** roko_* tool calls finishing within this window share one refresh. */
const TOOL_REFRESH_MS = 1_500
const RESTART_HINT = "Restart Hermes to load roko's backend."

const KEYS = {
  all: [ID],
  overview: [ID, 'overview'],
  pending: [ID, 'pending'],
  plans: [ID, 'plans'],
  plan: id => [ID, 'plan', id],
  run: id => [ID, 'run', id],
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
  cancelled: { glyph: '·', tone: 'muted', word: 'cancelled' }
}

const OUTCOMES = {
  ...STATES,
  passed: { glyph: '✓', tone: 'good', word: 'passed' },
  already_satisfied: { glyph: '✓', tone: 'good', word: 'already satisfied' },
  accepted_with_failures: { glyph: '✓', tone: 'warn', word: 'accepted with failures' },
  skipped: { glyph: '·', tone: 'muted', word: 'skipped' },
  blocked: { glyph: '✗', tone: 'warn', word: 'blocked' }
}

const EVENT_GLYPHS = {
  plan_started: '▸',
  task_started: '▸',
  agent_spawned: '◦',
  gate_rung_started: '◦',
  task_completed: '✓',
  plan_completed: '✓',
  run_completed: '✓',
  task_blocked: '✗',
  error: '✗'
}

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

function refreshAll() {
  void queryClient.invalidateQueries({ queryKey: KEYS.all })
}

function afterChange(runId) {
  void queryClient.invalidateQueries({ queryKey: KEYS.overview })
  void queryClient.invalidateQueries({ queryKey: KEYS.pending })

  if (validId(runId)) {
    void queryClient.invalidateQueries({ queryKey: KEYS.run(runId) })
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

  return { canAct: permissions.write !== false, left: num(spend.left_usd), maxRun: num(limits.max_run_usd) }
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

function useRun(runId, enabled = true) {
  return useQuery({
    enabled: enabled && validId(runId),
    queryFn: () => call(`/runs/${enc(runId)}`).then(r => (isRecord(r.run) ? r.run : null)),
    queryKey: KEYS.run(runId),
    // Poll every 3 s while the run is active; stop once it is terminal.
    refetchInterval: query => (isActiveRun(query.state.data) ? RUN_MS : false),
    retry: false,
    staleTime: 2_000
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

// ---------------------------------------------------------------------------
// Navigation: the selection lives in location.hash (#/roko#run=<id>); the
// app's hash router keeps routing on /roko. hermes://open/roko?run=<id> lands
// as #/roko?run=<id>, which reads the same way.
// ---------------------------------------------------------------------------

const $tab = atom('runs')
const $run = atom(null)
const $plan = atom(null)

function readView(hash) {
  const raw = typeof hash === 'string' ? hash : ''
  const view = {}

  for (const [key, re] of [
    ['tab', /[?#&]tab=([^&#]+)/],
    ['run', /[?#&]run=([^&#]+)/],
    ['plan', /[?#&]plan=([^&#]+)/]
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

    if (key === 'tab' ? TABS.includes(value) : validId(value)) {
      view[key] = value
    }
  }

  return view
}

function applyView(view) {
  if (view.run) {
    $run.set(view.run)
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
    return `${PAGE}#run=${enc(view.run)}`
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

/** Navigate to the page (optionally a tab or a run) from anywhere. */
function openRoko(view = {}) {
  applyView({ ...view, tab: view.tab ?? (view.run ? 'runs' : view.plan ? 'plans' : 'runs') })
  host.navigate(pathFor(view))
}

function selectRun(runId) {
  if (validId(runId)) {
    $run.set(runId)
    $tab.set('runs')
    replaceView({ run: runId })
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

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------

function Dot({ tone, label }) {
  return h('span', { 'aria-label': label, className: 'roko-dot', 'data-tone': tone, role: label ? 'img' : undefined })
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

  return h('span', { className: 'roko-pill', 'data-tone': info.tone }, info.glyph, ' ', info.word)
}

function KindBadge({ kind }) {
  const word = kind === 'plan_generate' ? 'plan generate' : text(kind)

  return word ? h(Badge, { className: 'roko-kind', size: 'xs', variant: 'muted' }, word) : null
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
    h(Codicon, { className: 'roko-empty-icon', name: icon, size: '1.1rem' }),
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

/** Cost meter: amber at 80 % of the cap, red at 95 %, '—' when unknown. */
function CostMeter({ spent, cap, compact }) {
  const s = num(spent)
  const c = num(cap)
  const ratio = s !== null && c !== null && c > 0 ? Math.min(1, s / c) : null
  const level = ratio === null ? 'none' : ratio >= 0.95 ? 'bad' : ratio >= 0.8 ? 'warn' : 'ok'

  return h(
    'span',
    { className: 'roko-meter', 'data-compact': compact ? 'true' : undefined, 'data-level': level },
    h(
      'span',
      { className: 'roko-meter-text' },
      h('span', { className: 'roko-strong' }, money(s)),
      ' / ',
      money(c)
    ),
    h(
      'span',
      { 'aria-hidden': 'true', className: 'roko-meter-track' },
      h('span', { className: 'roko-meter-fill', style: { width: `${Math.round((ratio ?? 0) * 100)}%` } })
    )
  )
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

function CopyCommand({ label, command }) {
  const [state, setState] = useState('idle')
  const timer = useRef(null)
  const cmd = text(command)

  useEffect(() => () => clearTimeout(timer.current), [])

  if (!cmd) {
    return null
  }

  const copy = async () => {
    let ok = false

    try {
      ok = Boolean(await doors?.os?.writeClipboard?.(cmd))
    } catch {
      ok = false
    }

    setState(ok ? 'copied' : 'failed')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1_600)
  }

  return h(
    Tip,
    { label: cmd },
    h(
      Button,
      { onClick: () => void copy(), size: 'xs', type: 'button', variant: 'outline' },
      h(Codicon, { name: state === 'copied' ? 'check' : 'copy', size: '0.75rem' }),
      state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : label
    )
  )
}

/** Deadline for a held confirm (contract: held_at + 120 s when known). */
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
    'span',
    { className: 'roko-countdown', 'data-tone': left <= 30 ? 'bad' : 'warn' },
    h(Codicon, { name: 'clock', size: '0.75rem' }),
    `${m}:${s} left`
  )
}

// ---------------------------------------------------------------------------
// Waiting items: Approve / Reject (POST /decide)
// ---------------------------------------------------------------------------

function PendingCard({ item, showRun, compact }) {
  const { canAct } = useLimits()
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  const code = text(item.code)
  const effect = item.kind === 'effect'
  const args = isRecord(item.arguments) ? Object.entries(item.arguments) : []
  const since = item.held_at || item.proposed_at

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
    { className: 'roko-card roko-pending', 'data-compact': compact ? 'true' : undefined, 'data-testid': `pending-${code}` },
    h(
      'div',
      { className: 'roko-pending-head' },
      h(Badge, { size: 'xs', variant: effect ? 'warn' : 'default' }, effect ? 'held action' : 'confirm'),
      h('span', { className: 'roko-pending-title' }, text(item.title)),
      h(Tip, { label: `/roko approve ${code}` }, h('span', { className: 'roko-code' }, code))
    ),
    h('div', { className: 'roko-question' }, text(item.question)),
    effect && (item.tool || item.server)
      ? h(
          'div',
          { className: 'roko-effect' },
          h('span', { className: 'roko-mono' }, `${text(item.tool) || '?'}@${text(item.server) || '?'}`),
          args.length
            ? h(
                'span',
                { className: 'roko-args' },
                args.map(([name, type]) =>
                  h('span', { className: 'roko-chip', key: name }, `${clip(name, 40)}: ${clip(type, 40)}`)
                )
              )
            : null
        )
      : null,
    h(Clamp, { lines: compact ? 3 : 5, value: item.summary }),
    h(
      'div',
      { className: 'roko-pending-meta' },
      since ? h('span', null, `waiting ${ago(since)}`) : null,
      !effect ? h(Countdown, { deadline: item.deadline_at }) : null,
      showRun && validId(item.run_id)
        ? h(
            'button',
            { className: 'roko-link', onClick: () => openRoko({ run: item.run_id, tab: 'runs' }), type: 'button' },
            'Open run'
          )
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
            placeholder: 'Note (optional)',
            value: note
          }),
          h(
            Button,
            { disabled: Boolean(busy), onClick: () => void decide(false), size: 'sm', type: 'button', variant: 'outline' },
            busy === 'reject' ? h(Spinner, null) : null,
            'Reject'
          ),
          h(
            Button,
            { disabled: Boolean(busy), onClick: () => void decide(true), size: 'sm', type: 'button' },
            busy === 'approve' ? h(Spinner, null) : null,
            'Approve'
          )
        ),
    result
      ? h(
          'div',
          { className: 'roko-result', 'data-tone': result.tone, role: 'status' },
          result.text,
          result.hint ? h('span', { className: 'roko-result-hint' }, ` ${result.hint}`) : null
        )
      : null
  )
}

// ---------------------------------------------------------------------------
// Run card (page + ::roko-run directive)
// ---------------------------------------------------------------------------

function GateChip({ gate }) {
  const passed = gate.passed === true
  const chip = h(
    'span',
    { className: 'roko-chip', 'data-tone': passed ? 'good' : 'bad' },
    passed ? '✓' : '✗',
    ' ',
    clip(gate.gate, 48) || 'gate'
  )
  const excerpt = clip(gate.excerpt, 200)

  return excerpt ? h(Tip, { label: excerpt }, chip) : chip
}

function TaskRow({ task }) {
  const info = outcomeInfo(task.outcome, task.attempts)
  const attempts = num(task.attempts)

  return h(
    'div',
    { className: 'roko-task' },
    h(Glyph, { info }),
    h('span', { className: 'roko-mono roko-task-id' }, clip(task.task_id, 24)),
    h(
      'div',
      { className: 'roko-task-main' },
      h('span', { className: 'roko-task-title' }, text(task.title)),
      h(
        'span',
        { className: 'roko-task-meta' },
        h('span', null, info.word),
        task.model ? h('span', { className: 'roko-mono' }, clip(task.model, 40)) : null,
        attempts !== null && attempts > 1 ? h('span', null, plural(attempts, 'attempt')) : null
      )
    ),
    list(task.gates).length
      ? h(
          'span',
          { className: 'roko-gates' },
          list(task.gates)
            .filter(isRecord)
            .map((gate, index) => h(GateChip, { gate, key: `${text(gate.gate)}:${index}` }))
        )
      : null
  )
}

function Delivered({ run }) {
  const d = isRecord(run.delivered) ? run.delivered : null

  if (!d) {
    return null
  }

  const files = list(d.files_changed).map(text).filter(Boolean)

  return h(
    'div',
    { className: 'roko-delivered' },
    h(SectionLabel, null, 'Delivered'),
    h(
      'div',
      { className: 'roko-kv' },
      h('span', null, 'branch'),
      h('span', { className: 'roko-mono roko-wrap' }, text(d.branch) || '—'),
      h('span', null, 'commit'),
      h('span', { className: 'roko-mono' }, clip(d.commit, 12) || '—'),
      h('span', null, 'changes'),
      h('span', null, text(d.diffstat) || '—'),
      h('span', null, 'merged'),
      h('span', null, d.merged === true ? 'yes' : 'not merged'),
      d.promoted_into ? h('span', null, 'promoted') : null,
      d.promoted_into
        ? h('span', { className: 'roko-mono roko-wrap' }, `${text(d.promoted_into)}${d.promoted_tag ? ` (${text(d.promoted_tag)})` : ''}`)
        : null
    ),
    files.length
      ? h(
          'div',
          { className: 'roko-files' },
          files.slice(0, 12).map(file => h('span', { className: 'roko-chip roko-mono', key: file }, clip(file, 80))),
          files.length > 12 ? h('span', { className: 'roko-muted' }, `+${files.length - 12} more`) : null
        )
      : null,
    h(
      'div',
      { className: 'roko-actions' },
      h(CopyCommand, { command: run.review_command, label: 'Copy review command' }),
      d.merged === true ? null : h(CopyCommand, { command: run.merge_command, label: 'Copy merge command' })
    )
  )
}

function CancelRun({ run }) {
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
      { onClick: () => setOpen(true), size: 'sm', type: 'button', variant: 'outline' },
      h(Codicon, { name: 'stop-circle', size: '0.8rem' }),
      'Cancel run'
    ),
    h(ConfirmDialog, {
      confirmLabel: 'Cancel run',
      description: `roko stops “${clip(run.label, 80)}”. Work already done stays on its branch.`,
      destructive: true,
      onClose: () => setOpen(false),
      onConfirm: async () => {
        try {
          await post(`/runs/${enc(run.run_id)}/cancel`, {})
        } catch (error) {
          const d = describe(error)

          throw new Error(d.hint ? `${d.message} ${d.hint}` : d.message)
        }

        afterChange(run.run_id)
      },
      open,
      title: 'Cancel this roko run?'
    })
  )
}

/** Run events cached per run id, so reopening the timeline only fetches newer rows. */
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
  }, [runId, open])

  return { error, events: state.events, loading }
}

function Timeline({ runId, active }) {
  const [open, setOpen] = useState(false)
  const { error, events, loading } = useRunEvents(runId, open, active)

  return h(
    'div',
    { className: 'roko-timeline-wrap' },
    h(
      'button',
      { 'aria-expanded': open, className: 'roko-disclosure', onClick: () => setOpen(v => !v), type: 'button' },
      h(DisclosureCaret, { open }),
      'Timeline',
      open && events.length ? h('span', { className: 'roko-muted' }, ` · ${events.length}`) : null,
      open && loading ? h(Spinner, null) : null
    ),
    open
      ? h(
          'div',
          { className: 'roko-timeline' },
          error ? h(ErrorNote, { compact: true, error }) : null,
          !events.length && !loading && !error ? h('div', { className: 'roko-muted' }, 'No events yet.') : null,
          events.map((event, index) => {
            const type = text(event.type)
            const glyph = type === 'gate_result' ? (event.passed === false ? '✗' : '✓') : (EVENT_GLYPHS[type] ?? '·')
            const tone =
              type === 'error' || type === 'task_blocked' || event.passed === false
                ? 'bad'
                : type === 'gate_result' || type.endsWith('completed')
                  ? 'good'
                  : 'muted'

            return h(
              'div',
              { className: 'roko-event', key: `${text(event.cursor)}:${index}` },
              h('span', { className: 'roko-glyph', 'data-tone': tone }, glyph),
              h('span', { className: 'roko-event-text' }, text(event.text) || type)
            )
          })
        )
      : null
  )
}

function RunStats({ run, compact }) {
  const tasks = list(run.tasks).filter(isRecord)
  const done = tasks.filter(task => ['passed', 'succeeded', 'already_satisfied', 'accepted_with_failures'].includes(task.outcome)).length
  const tokens = isRecord(run.tokens) ? run.tokens : null
  const gates = isRecord(run.gates) ? run.gates : null

  return h(
    'div',
    { className: 'roko-stats' },
    h('span', { className: 'roko-stat' }, h('span', { className: 'roko-stat-label' }, 'cost'), h(CostMeter, { cap: run.max_usd, compact, spent: run.cost_usd })),
    h('span', { className: 'roko-stat' }, h('span', { className: 'roko-stat-label' }, 'time'), duration(run.duration_ms)),
    tasks.length ? h('span', { className: 'roko-stat' }, h('span', { className: 'roko-stat-label' }, 'tasks'), `${done}/${tasks.length}`) : null,
    gates && !compact
      ? h('span', { className: 'roko-stat' }, h('span', { className: 'roko-stat-label' }, 'gates'), `${num(gates.passed) ?? 0} passed · ${num(gates.failed) ?? 0} failed`)
      : null,
    tokens && !compact
      ? h(
          'span',
          { className: 'roko-stat' },
          h('span', { className: 'roko-stat-label' }, 'tokens'),
          `${num(tokens.input) ?? 0} in · ${num(tokens.output) ?? 0} out`
        )
      : null,
    num(run.position) !== null ? h('span', { className: 'roko-stat' }, h('span', { className: 'roko-stat-label' }, 'queue'), `#${run.position}`) : null
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

function RunCard({ runId, compact, onExpand, fallback }) {
  const query = useRun(runId)
  const run = query.data

  if (query.isLoading) {
    return h('div', { className: 'roko-card', 'data-compact': compact ? 'true' : undefined }, h(Spinner, { label: 'Loading run…' }))
  }

  if (!run) {
    if (query.error && isRecord(fallback)) {
      return h(RowCard, { compact, error: query.error, onRetry: () => void query.refetch(), row: fallback })
    }

    return query.error
      ? h(ErrorNote, { compact, error: query.error, onRetry: () => void query.refetch() })
      : h(Empty, { icon: 'rocket', title: 'Run not found' })
  }

  const active = isActiveRun(run)
  const waiting = list(run.waiting).filter(isRecord)
  const tasks = list(run.tasks).filter(isRecord)

  return h(
    'div',
    { className: 'roko roko-card roko-run', 'data-compact': compact ? 'true' : undefined, 'data-testid': `run-card-${text(run.run_id)}` },
    h(
      'div',
      { className: 'roko-run-head' },
      h(StatePill, { state: run.state }),
      h('span', { className: 'roko-run-title' }, text(run.label) || text(run.run_id)),
      h(KindBadge, { kind: run.kind })
    ),
    run.headline ? h('div', { className: 'roko-headline' }, text(run.headline)) : null,
    query.error ? h(ErrorNote, { compact: true, error: query.error, lastChecked: query.dataUpdatedAt, onRetry: () => void query.refetch() }) : null,
    h(RunStats, { compact, run }),
    compact
      ? h(
          'div',
          { className: 'roko-actions roko-actions-start' },
          waiting.length ? h(Badge, { size: 'xs', variant: 'warn' }, `${waiting.length} waiting on you`) : null,
          onExpand ? h(Button, { onClick: onExpand, size: 'xs', type: 'button', variant: 'outline' }, 'Details') : null,
          h(Button, { onClick: () => openRoko({ run: run.run_id }), size: 'xs', type: 'button', variant: 'ghost' }, 'Open in roko')
        )
      : h(
          Fragment,
          null,
          tasks.length ? h(SectionLabel, null, 'Tasks') : null,
          tasks.length ? h('div', { className: 'roko-tasks' }, tasks.map((task, index) => h(TaskRow, { key: `${text(task.task_id)}:${index}`, task }))) : null,
          waiting.length ? h(SectionLabel, null, `Waiting on you (${waiting.length})`) : null,
          waiting.map(item => h(PendingCard, { compact: true, item, key: text(item.code) || text(item.decision_id) })),
          h(Delivered, { run }),
          h(
            'div',
            { className: 'roko-run-foot' },
            h('span', { className: 'roko-muted roko-mono' }, text(run.run_id)),
            run.started_at ? h('span', { className: 'roko-muted' }, `started ${ago(run.started_at)} ago`) : null,
            active ? h(CancelRun, { run }) : null
          ),
          h(Timeline, { active, runId: run.run_id })
        )
  )
}

// ---------------------------------------------------------------------------
// Plans: waves, estimate, Run plan…
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

function RunPlan({ plan, size = 'sm' }) {
  const { canAct, left, maxRun } = useLimits()
  const [step, setStep] = useState(null)
  const [cap, setCap] = useState('1.00')
  const [resume, setResume] = useState(false)
  const amount = Number.parseFloat(cap)
  const ceiling = maxRun !== null && left !== null ? Math.min(maxRun, left) : (maxRun ?? left)
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
        h(DialogHeader, null, h(DialogTitle, null, `Run plan “${clip(title, 60)}”`), h(DialogDescription, null, 'roko runs every task in the plan and stops when it reaches the cap.')),
        h(
          'div',
          { className: 'roko-form' },
          h(
            'div',
            { className: 'roko-field' },
            h('label', { htmlFor: 'roko-run-cap' }, 'Spend cap (max_usd)'),
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
                [
                  maxRun !== null ? `at most ${money(maxRun)} per run` : null,
                  left !== null ? `${money(left)} left today` : null
                ]
                  .filter(Boolean)
                  .join(' · ')
              )
            : null,
          valid
            ? null
            : h(
                'div',
                { className: 'roko-result', 'data-tone': 'bad' },
                tooMuch ? `Enter a cap of at most ${money(ceiling)}.` : 'Enter a cap of at least $0.01.'
              )
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
          reply = await post(`/plans/${enc(planId)}/run`, { max_usd: Math.round(amount * 100) / 100, resume })
        } catch (error) {
          const d = describe(error)

          throw new Error(d.hint ? `${d.message} ${d.hint}` : d.message)
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

function Waves({ plan, compact }) {
  const tasks = new Map(list(plan.tasks).filter(isRecord).map(task => [text(task.id), task]))
  const waves = list(plan.waves).map(wave => list(wave).map(text).filter(Boolean))

  if (!waves.length) {
    return h('div', { className: 'roko-muted' }, 'No tasks.')
  }

  return h(
    'div',
    { className: 'roko-waves', 'data-compact': compact ? 'true' : undefined },
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
            !compact && deps.length ? h('div', { className: 'roko-muted' }, `after ${deps.join(', ')}`) : null,
            !compact && checks.length
              ? h(Tip, { label: clip(checks.join(' · '), 200) }, h('div', { className: 'roko-muted' }, plural(checks.length, 'check')))
              : null
          )
        })
      )
    )
  )
}

function PlanDetail({ planId, compact }) {
  const query = usePlan(planId)
  const plan = query.data

  if (query.isLoading) {
    return h('div', { className: 'roko-card' }, h(Spinner, { label: 'Loading plan…' }))
  }

  if (!plan) {
    return query.error ? h(ErrorNote, { compact, error: query.error, onRetry: () => void query.refetch() }) : h(Empty, { icon: 'list-tree', title: 'Plan not found' })
  }

  const taskCount = num(plan.task_count) ?? list(plan.tasks).length

  return h(
    'div',
    { className: 'roko roko-card roko-plan', 'data-compact': compact ? 'true' : undefined, 'data-testid': `plan-card-${text(plan.plan_id)}` },
    h(
      'div',
      { className: 'roko-run-head' },
      h(Codicon, { name: 'list-tree', size: '0.9rem' }),
      h('span', { className: 'roko-run-title' }, text(plan.title) || text(plan.plan_id)),
      h('span', { className: 'roko-muted roko-mono' }, text(plan.plan_id))
    ),
    h(
      'div',
      { className: 'roko-stats' },
      h('span', { className: 'roko-stat' }, plural(taskCount, 'task')),
      num(plan.max_parallel) !== null ? h('span', { className: 'roko-stat' }, `${plan.max_parallel} in parallel`) : null,
      h('span', { className: 'roko-stat', 'data-testid': 'plan-estimate' }, estimateLine(plan.estimate))
    ),
    h(Waves, { compact, plan }),
    h('div', { className: 'roko-actions roko-actions-start' }, h(RunPlan, { plan, size: compact ? 'xs' : 'sm' }), compact ? h(Button, { onClick: () => openRoko({ plan: plan.plan_id }), size: 'xs', type: 'button', variant: 'ghost' }, 'Open in roko') : null)
  )
}

// ---------------------------------------------------------------------------
// Page tabs
// ---------------------------------------------------------------------------

/** A selectable row: the listitem holds a real button, so it stays a button for assistive tech. */
function ListRow({ active, onSelect, children }) {
  return h(
    'div',
    { className: 'roko-row-wrap', role: 'listitem' },
    h(
      'button',
      { 'aria-current': active ? 'true' : undefined, className: 'roko-row', 'data-active': active ? 'true' : 'false', onClick: onSelect, type: 'button' },
      ...(Array.isArray(children) ? children : [children])
    )
  )
}

function RunsTab({ overview }) {
  const selected = useValue($run)
  const now = useNow(30_000)
  const runs = list(overview.data?.runs).filter(row => isRecord(row) && validId(row.run_id))
  const current = validId(selected) ? selected : runs[0]?.run_id ?? null

  if (!runs.length && !current) {
    return h(Empty, { icon: 'rocket', title: 'No roko runs from Hermes yet' }, 'Ask Hermes to use roko, or start a plan from the Plans tab.')
  }

  return h(
    'div',
    { className: 'roko-split' },
    h(
      'div',
      { 'aria-label': 'roko runs', className: 'roko-list', role: 'list' },
      runs.map(row => {
        const info = stateInfo(row.state)

        return h(
          ListRow,
          { active: row.run_id === current, key: row.run_id, onSelect: () => selectRun(row.run_id) },
          h(Glyph, { info }),
          h(
            'span',
            { className: 'roko-row-main' },
            h('span', { className: 'roko-row-title' }, text(row.label) || row.run_id),
            h(
              'span',
              { className: 'roko-row-meta' },
              h('span', null, info.word),
              h('span', null, row.kind === 'plan_generate' ? 'plan generate' : text(row.kind)),
              h('span', null, money(row.cost_usd)),
              row.started_at ? h('span', null, ago(row.started_at, now)) : null
            )
          )
        )
      })
    ),
    h('div', { className: 'roko-detail' }, current ? h(RunCard, { fallback: runs.find(row => row.run_id === current), key: current, runId: current }) : null)
  )
}

function WaitingTab() {
  const query = usePending()
  const items = list(query.data).filter(isRecord)

  if (query.isLoading) {
    return h(Spinner, { label: 'Loading…' })
  }

  return h(
    'div',
    { className: 'roko-stack roko-narrow' },
    query.error ? h(ErrorNote, { error: query.error, lastChecked: query.data ? query.dataUpdatedAt : 0, onRetry: () => void query.refetch() }) : null,
    !items.length && !query.error ? h(Empty, { icon: 'pass', title: 'Nothing waits on you' }, 'Approvals for held actions and task results appear here.') : null,
    items.map(item => h(PendingCard, { item, key: text(item.code) || text(item.decision_id), showRun: true }))
  )
}

function PlansTab() {
  const query = usePlans()
  const selected = useValue($plan)
  const plans = list(query.data).filter(plan => isRecord(plan) && validId(plan.id))
  const current = validId(selected) ? selected : plans[0]?.id ?? null

  if (query.isLoading) {
    return h(Spinner, { label: 'Loading plans…' })
  }

  if (!plans.length) {
    return query.error ? h(ErrorNote, { error: query.error, onRetry: () => void query.refetch() }) : h(Empty, { icon: 'list-tree', title: 'No plans yet' }, 'Ask Hermes to plan work with roko; plans show up here.')
  }

  return h(
    'div',
    { className: 'roko-split' },
    h(
      'div',
      { 'aria-label': 'roko plans', className: 'roko-list', role: 'list' },
      query.error ? h(ErrorNote, { compact: true, error: query.error, onRetry: () => void query.refetch() }) : null,
      plans.map(plan =>
        h(
          ListRow,
          {
            active: plan.id === current,
            key: plan.id,
            onSelect: () => {
              $plan.set(plan.id)
              replaceView({ plan: plan.id })
            }
          },
          h(Codicon, { className: 'roko-row-icon', name: 'list-tree', size: '0.85rem' }),
          h(
            'span',
            { className: 'roko-row-main' },
            h('span', { className: 'roko-row-title' }, text(plan.title) || plan.id),
            h('span', { className: 'roko-row-meta' }, h('span', { className: 'roko-mono' }, plan.id), h('span', null, `${num(plan.tasks_done) ?? 0}/${num(plan.task_count) ?? 0} done`), plan.status ? h('span', null, text(plan.status)) : null)
          )
        )
      )
    ),
    h('div', { className: 'roko-detail' }, current ? h(PlanDetail, { key: current, planId: current }) : null)
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
    q.length < 2 ? h(Empty, { icon: 'lightbulb', title: 'Search roko’s knowledge' }, 'Insights, patterns and facts roko kept from past runs.') : null,
    q.length >= 2 && query.error ? h(ErrorNote, { error: query.error, onRetry: () => void query.refetch() }) : null,
    q.length >= 2 && !query.isFetching && !query.error && !entries.length ? h(Empty, { icon: 'search', title: `Nothing for “${clip(q, 60)}”` }) : null,
    q.length >= 2
      ? entries.map((entry, index) =>
          h(
            'div',
            { className: 'roko-card roko-knowledge', key: `${text(entry.id)}:${index}` },
            h(
              'div',
              { className: 'roko-knowledge-head' },
              entry.kind ? h(Badge, { size: 'xs', variant: 'default' }, text(entry.kind)) : null,
              entry.tier ? h(Badge, { size: 'xs', variant: 'muted' }, text(entry.tier)) : null,
              h('span', { className: 'roko-flex' }),
              num(entry.score) !== null ? h('span', { className: 'roko-muted' }, `score ${entry.score.toFixed(2)}`) : null,
              num(entry.confidence) !== null ? h('span', { className: 'roko-muted' }, `${Math.round(entry.confidence * 100)}% confident`) : null
            ),
            h(Clamp, { lines: 6, value: entry.content })
          )
        )
      : null
  )
}

function Bar({ ratio, tone }) {
  const r = num(ratio)

  return h('span', { className: 'roko-bar', 'data-tone': tone }, h('span', { className: 'roko-bar-fill', style: { width: `${Math.round(Math.max(0, Math.min(1, r ?? 0)) * 100)}%` } }))
}

function Sparkline({ points }) {
  const values = points.map(p => num(p.cumulative_usd) ?? num(p.cost_usd)).filter(v => v !== null)

  if (values.length < 2) {
    return null
  }

  const width = 240
  const height = 48
  const max = Math.max(...values)
  const min = Math.min(...values)
  const span = max - min || 1
  const coords = values.map((v, i) => [(i / (values.length - 1)) * width, height - 4 - ((v - min) / span) * (height - 8)])
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `0,${height} ${line} ${width},${height}`

  return h(
    'svg',
    { 'aria-label': `Cumulative cost, ${money(values[values.length - 1])} total`, className: 'roko-spark', preserveAspectRatio: 'none', role: 'img', viewBox: `0 0 ${width} ${height}` },
    h('polygon', { className: 'roko-spark-area', points: area }),
    h('polyline', { className: 'roko-spark-line', fill: 'none', points: line })
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
  const TONE = { fail: 'bad', ok: 'good', warn: 'warn' }
  const GLYPH = { fail: '✗', ok: '✓', warn: '!' }

  return h(
    'div',
    { className: 'roko-stack roko-narrow' },
    h(SectionLabel, { right: h(Button, { onClick: () => { void health.refetch(); void insights.refetch() }, size: 'xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'refresh', size: '0.75rem' }), 'Check again') }, 'Checks'),
    health.isLoading ? h(Spinner, { label: 'Checking…' }) : null,
    health.error ? h(ErrorNote, { error: health.error, onRetry: () => void health.refetch() }) : null,
    checks.length
      ? h(
          'div',
          { className: 'roko-card roko-checks' },
          checks.map((check, index) =>
            h(
              'div',
              { className: 'roko-check', key: `${text(check.name)}:${index}` },
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
      : null,
    h(SectionLabel, null, 'Gates'),
    insights.isLoading ? h(Spinner, { label: 'Loading…' }) : null,
    insights.error ? h(ErrorNote, { error: insights.error, onRetry: () => void insights.refetch() }) : null,
    gates.length
      ? h(
          'div',
          { className: 'roko-card roko-table' },
          gates.map((gate, index) => {
            const rate = num(gate.pass_rate)

            return h(
              'div',
              { className: 'roko-table-row', key: `${text(gate.gate)}:${index}` },
              h('span', { className: 'roko-mono roko-cell-name' }, text(gate.gate)),
              h(Bar, { ratio: rate, tone: rate === null ? 'muted' : rate >= 0.8 ? 'good' : rate >= 0.5 ? 'warn' : 'bad' }),
              h('span', { className: 'roko-cell-num' }, rate === null ? '—' : `${Math.round(rate * 100)}%`),
              h('span', { className: 'roko-cell-num roko-muted' }, `${num(gate.passed) ?? 0}/${(num(gate.passed) ?? 0) + (num(gate.failed) ?? 0)}`),
              h('span', { className: 'roko-cell-num roko-muted' }, duration(gate.avg_duration_ms))
            )
          })
        )
      : insights.data ? h('div', { className: 'roko-muted' }, 'No gate results yet.') : null,
    h(SectionLabel, null, 'Models'),
    models.length
      ? h(
          'div',
          { className: 'roko-card roko-table' },
          models.map((model, index) => {
            const rate = num(model.success_rate)

            return h(
              'div',
              { className: 'roko-table-row', key: `${text(model.model)}:${index}` },
              h('span', { className: 'roko-mono roko-cell-name' }, text(model.model)),
              h(Bar, { ratio: rate, tone: rate === null ? 'muted' : rate >= 0.8 ? 'good' : rate >= 0.5 ? 'warn' : 'bad' }),
              h('span', { className: 'roko-cell-num' }, rate === null ? '—' : `${Math.round(rate * 100)}%`),
              h('span', { className: 'roko-cell-num roko-muted' }, plural(num(model.tasks) ?? 0, 'task')),
              h('span', { className: 'roko-cell-num roko-muted' }, money(model.total_cost_usd))
            )
          })
        )
      : insights.data ? h('div', { className: 'roko-muted' }, 'No model results yet.') : null,
    trend.length >= 2
      ? h(
          Fragment,
          null,
          h(SectionLabel, { right: h('span', { className: 'roko-muted' }, `${money(num(trend[trend.length - 1].cumulative_usd))} total`) }, 'Spend'),
          h('div', { className: 'roko-card' }, h(Sparkline, { points: trend }))
        )
      : null
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
      h('div', { className: 'roko-title-row' }, h('h1', { className: 'roko-title' }, 'roko'), h(Dot, { label: `connection ${tone}`, tone }), h('span', { className: 'roko-conn', 'data-testid': 'roko-connection' }, line)),
      h(
        'div',
        { className: 'roko-sub' },
        data?.spend ? h('span', { 'data-testid': 'roko-spend' }, spendLine(data.spend)) : null,
        checked ? h('span', null, `checked ${clock(checked)}`) : null
      )
    ),
    h(Button, { 'aria-label': 'Refresh', onClick: refreshAll, size: 'sm', type: 'button', variant: 'ghost' }, overview.isFetching ? h(Spinner, null) : h(Codicon, { name: 'refresh', size: '0.85rem' }), 'Refresh')
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
      replaceView(value === 'runs' ? { run: $run.get() } : value === 'plans' ? { plan: $plan.get(), tab: 'plans' } : { tab: value })
    }
  }

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
              h(TabsTrigger, { value: 'runs' }, 'Runs'),
              h(TabsTrigger, { value: 'waiting' }, 'Waiting', waiting > 0 ? h(Badge, { className: 'roko-tab-count', size: 'xs', variant: 'warn' }, String(waiting)) : null),
              h(TabsTrigger, { value: 'plans' }, 'Plans'),
              h(TabsTrigger, { value: 'knowledge' }, 'Knowledge'),
              h(TabsTrigger, { value: 'health' }, 'Health')
            )
          )
        ),
    h('div', { className: 'roko-body' }, backendDown ? null : h(OfflineNotes, { overview }), body)
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
    Tip,
    { label: tipLines.filter(Boolean).join(' · ') },
    h(
      'button',
      {
        'aria-label': `roko: ${counts || (tone === 'good' ? 'connected' : 'not connected')}`,
        className: 'roko roko-statuschip',
        'data-testid': 'roko-status-chip',
        onClick: () => openRoko(waiting > 0 ? { tab: 'waiting' } : {}),
        type: 'button'
      },
      h(Dot, { tone }),
      h('span', null, 'roko'),
      counts ? h('span', { className: 'roko-statuschip-counts' }, counts) : null
    )
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
          h(RunCard, { runId }),
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
// look lives here, on the app's theme tokens (light and dark follow them).
// ---------------------------------------------------------------------------

const CSS = `
.roko{--roko-good:var(--ui-green);--roko-bad:var(--ui-red);--roko-warn:var(--ui-yellow);--roko-live:color-mix(in srgb,var(--ui-blue) 62%,var(--ui-base));--roko-muted:var(--ui-text-tertiary);--roko-line:var(--ui-stroke-tertiary)}
.roko-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--ui-surface-background);color:var(--ui-text-primary);font-size:13px;container-type:inline-size}
.roko-page-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:18px 22px 10px}
.roko-head-main{display:flex;flex-direction:column;gap:4px;min-width:0}
.roko-title-row{display:flex;align-items:center;gap:8px;min-width:0}
.roko-title{margin:0;font-size:16px;font-weight:650;letter-spacing:-.01em;color:var(--ui-text-primary)}
.roko-conn{font-size:12px;color:var(--ui-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-sub{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}
.roko-tabs{padding:2px 22px 6px}
.roko-tabs [data-slot=tabs-list]{align-self:flex-start}
.roko-tab-count{margin-left:4px}
.roko-body{flex:1;min-height:0;overflow:auto;padding:10px 22px 28px;display:flex;flex-direction:column;gap:12px}
.roko-notes{display:flex;flex-direction:column;gap:8px}
.roko-stack{display:flex;flex-direction:column;gap:10px;min-width:0}
.roko-narrow{width:100%;max-width:980px}
.roko-quiet{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--ui-text-tertiary)}
.roko-split{display:grid;grid-template-columns:minmax(220px,300px) minmax(0,1fr);gap:18px;align-items:start}
@container (max-width:760px){.roko-split{grid-template-columns:minmax(0,1fr)}}
.roko-list{display:flex;flex-direction:column;gap:2px;min-width:0}
.roko-detail{min-width:0}
.roko-row-wrap{display:block}
.roko-row{display:flex;align-items:center;gap:9px;width:100%;padding:7px 9px;border:0;border-radius:7px;background:transparent;color:var(--ui-text-secondary);font:inherit;text-align:left;cursor:pointer}
.roko-row:hover{background:var(--ui-row-hover-background);color:var(--ui-text-primary)}
.roko-row[data-active=true]{background:var(--ui-row-active-background);color:var(--ui-text-primary)}
.roko-row-icon{color:var(--ui-text-tertiary)}
.roko-row-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.roko-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550;color:var(--ui-text-primary)}
.roko-row-meta{display:flex;gap:8px;font-size:11px;color:var(--ui-text-tertiary);white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}
.roko-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:13px 15px;border:1px solid var(--roko-line);border-radius:11px;background:var(--ui-widget-surface-background,var(--ui-bg-editor));color:var(--ui-text-primary)}
.roko-card[data-compact=true]{gap:8px;padding:10px 12px;border-radius:9px}
.roko-run-head{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.roko-run-title{flex:1;min-width:0;font-weight:600;font-size:13.5px;line-height:1.35;overflow-wrap:anywhere}
.roko-card[data-compact=true] .roko-run-title{font-size:13px}
.roko-headline{font-size:12px;color:var(--ui-text-secondary);overflow-wrap:anywhere}
.roko-pill{display:inline-flex;align-items:center;gap:3px;height:19px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:600;white-space:nowrap;background:color-mix(in srgb,var(--ui-text-tertiary) 14%,transparent);color:var(--ui-text-secondary)}
.roko-pill[data-tone=good]{background:color-mix(in srgb,var(--roko-good) 15%,transparent);color:var(--roko-good)}
.roko-pill[data-tone=bad]{background:color-mix(in srgb,var(--roko-bad) 14%,transparent);color:var(--roko-bad)}
.roko-pill[data-tone=warn]{background:color-mix(in srgb,var(--roko-warn) 17%,transparent);color:var(--roko-warn)}
.roko-pill[data-tone=live]{background:color-mix(in srgb,var(--roko-live) 15%,transparent);color:var(--roko-live)}
.roko-glyph{display:inline-flex;justify-content:center;width:14px;flex:none;font-weight:700;color:var(--roko-muted)}
.roko-glyph[data-tone=good]{color:var(--roko-good)}.roko-glyph[data-tone=bad]{color:var(--roko-bad)}.roko-glyph[data-tone=warn]{color:var(--roko-warn)}.roko-glyph[data-tone=live]{color:var(--roko-live)}
.roko-dot{display:inline-block;width:7px;height:7px;flex:none;border-radius:999px;background:var(--roko-muted)}
.roko-dot[data-tone=good]{background:var(--roko-good)}.roko-dot[data-tone=bad]{background:var(--roko-bad)}.roko-dot[data-tone=warn]{background:var(--roko-warn)}.roko-dot[data-tone=live]{background:var(--roko-live)}
.roko-stats{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;font-size:12px;color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}
.roko-stat{display:inline-flex;align-items:center;gap:6px}
.roko-stat-label{font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-meter{display:inline-flex;align-items:center;gap:8px}
.roko-meter-track{position:relative;width:92px;height:5px;overflow:hidden;border-radius:999px;background:var(--ui-bg-tertiary)}
.roko-meter[data-compact=true] .roko-meter-track{width:56px}
.roko-meter-fill{display:block;height:100%;border-radius:inherit;background:var(--roko-live)}
.roko-meter[data-level=warn] .roko-meter-fill{background:var(--roko-warn)}.roko-meter[data-level=warn] .roko-strong{color:var(--roko-warn)}
.roko-meter[data-level=bad] .roko-meter-fill{background:var(--roko-bad)}.roko-meter[data-level=bad] .roko-strong{color:var(--roko-bad)}
.roko-meter[data-level=none] .roko-meter-track{opacity:.5}
.roko-strong{font-weight:600;color:var(--ui-text-primary)}
.roko-muted{color:var(--ui-text-tertiary);font-size:12px}
.roko-mono{font-family:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}
.roko-wrap{overflow-wrap:anywhere}
.roko-flex{flex:1}
.roko-section-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px;font-size:10.5px;font-weight:650;letter-spacing:.07em;text-transform:uppercase;color:var(--ui-text-quaternary)}
.roko-section-label>:nth-child(2){font-size:12px;font-weight:500;letter-spacing:0;text-transform:none}
.roko-tasks{display:flex;flex-direction:column}
.roko-task{display:grid;grid-template-columns:16px minmax(34px,auto) minmax(0,1fr) auto;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--ui-stroke-quaternary)}
.roko-task:first-child{border-top:0}
.roko-task-id{color:var(--ui-text-tertiary)}
.roko-task-main{display:flex;flex-direction:column;gap:1px;min-width:0}
.roko-task-title{overflow-wrap:anywhere}
.roko-task-meta{display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--ui-text-tertiary)}
.roko-gates{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:4px}
.roko-chip{display:inline-flex;align-items:center;gap:3px;max-width:100%;padding:1px 6px;border-radius:5px;background:var(--ui-bg-quaternary);color:var(--ui-text-secondary);font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.roko-chip[data-tone=good]{color:var(--roko-good)}.roko-chip[data-tone=bad]{color:var(--roko-bad);background:color-mix(in srgb,var(--roko-bad) 10%,transparent)}
.roko-pending{gap:8px}
.roko-pending-head{display:flex;align-items:center;gap:8px;min-width:0}
.roko-pending-title{flex:1;min-width:0;font-size:12px;color:var(--ui-text-secondary);overflow-wrap:anywhere}
.roko-code{padding:1px 6px;border-radius:5px;border:1px dashed var(--ui-stroke-secondary);font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;color:var(--ui-text-secondary)}
.roko-question{font-weight:600;line-height:1.4;overflow-wrap:anywhere}
.roko-effect{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.roko-args{display:inline-flex;flex-wrap:wrap;gap:4px}
.roko-pending-meta{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:11.5px;color:var(--ui-text-tertiary)}
.roko-countdown{display:inline-flex;align-items:center;gap:4px;font-variant-numeric:tabular-nums}
.roko-countdown[data-tone=warn]{color:var(--roko-warn)}.roko-countdown[data-tone=bad]{color:var(--roko-bad)}
.roko-decide{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.roko-note{flex:1;min-width:160px}
.roko-result{font-size:12px;color:var(--ui-text-secondary)}
.roko-result[data-tone=good]{color:var(--roko-good)}.roko-result[data-tone=bad]{color:var(--roko-bad)}
.roko-result-hint{color:var(--ui-text-tertiary)}
.roko-clamp{display:flex;flex-direction:column;align-items:flex-start;gap:4px}
.roko-clamp-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.5;color:var(--ui-text-secondary)}
.roko-clamp-text[data-open=false]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--roko-lines,4);overflow:hidden}
.roko-link{padding:0;border:0;background:none;color:var(--ui-text-tertiary);font:inherit;font-size:11.5px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.roko-link:hover{color:var(--ui-text-primary)}
.roko-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}
.roko-actions-start{justify-content:flex-start}
.roko-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;font-size:12px}
.roko-kv>span:nth-child(odd){color:var(--ui-text-tertiary)}
.roko-files{display:flex;flex-wrap:wrap;gap:4px}
.roko-delivered{display:flex;flex-direction:column;gap:8px}
.roko-run-foot{display:flex;flex-wrap:wrap;align-items:center;gap:12px}
.roko-run-foot>:last-child{margin-left:auto}
.roko-disclosure{display:inline-flex;align-items:center;gap:6px;padding:0;border:0;background:none;color:var(--ui-text-secondary);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.roko-timeline{display:flex;flex-direction:column;gap:3px;margin-top:8px;max-height:280px;overflow:auto;font-size:12px}
.roko-event{display:grid;grid-template-columns:14px minmax(0,1fr);gap:6px;align-items:baseline}
.roko-event-text{color:var(--ui-text-secondary);overflow-wrap:anywhere}
.roko-waves{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(170px,280px);gap:10px;overflow-x:auto;padding-bottom:2px}
.roko-wave{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px dashed var(--roko-line);border-radius:9px}
.roko-wave-head{font-size:10.5px;font-weight:650;letter-spacing:.07em;color:var(--ui-text-quaternary)}
.roko-taskchip{display:flex;flex-direction:column;gap:2px;padding:7px 9px;border-radius:7px;background:var(--ui-bg-quaternary);font-size:12px}
.roko-taskchip-head{display:flex;gap:6px;align-items:baseline;min-width:0}
.roko-taskchip-title{min-width:0;overflow-wrap:anywhere}
.roko-waves[data-compact=true] .roko-taskchip{padding:5px 7px}
.roko-form{display:flex;flex-direction:column;gap:12px;padding:4px 0}
.roko-field{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--ui-text-secondary)}
.roko-field-row{flex-direction:row;align-items:center;gap:10px}
.roko-search{width:100%;height:34px}
.roko-knowledge{gap:6px}
.roko-knowledge-head{display:flex;align-items:center;gap:6px}
.roko-checks,.roko-table{gap:0;padding:4px 14px}
.roko-check{display:grid;grid-template-columns:16px minmax(0,1fr);gap:8px;padding:8px 0;border-top:1px solid var(--ui-stroke-quaternary)}
.roko-check:first-child,.roko-table-row:first-child{border-top:0}
.roko-check-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.roko-check-hint{font-size:12px;color:var(--roko-warn)}
.roko-table-row{display:grid;grid-template-columns:minmax(120px,1.3fr) minmax(60px,1fr) 46px 64px 64px;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--ui-stroke-quaternary);font-size:12px}
.roko-cell-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-cell-num{text-align:right;font-variant-numeric:tabular-nums}
.roko-bar{display:block;height:6px;overflow:hidden;border-radius:999px;background:var(--ui-bg-tertiary)}
.roko-bar-fill{display:block;height:100%;border-radius:inherit;background:var(--roko-muted)}
.roko-bar[data-tone=good] .roko-bar-fill{background:var(--roko-good)}.roko-bar[data-tone=warn] .roko-bar-fill{background:var(--roko-warn)}.roko-bar[data-tone=bad] .roko-bar-fill{background:var(--roko-bad)}
.roko-spark{display:block;width:100%;height:48px;color:var(--roko-live)}
.roko-spark-line{stroke:currentColor;stroke-width:1.6;vector-effect:non-scaling-stroke}
.roko-spark-area{fill:currentColor;opacity:.12}
.roko-banner{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:9px;border:1px solid color-mix(in srgb,var(--roko-warn) 40%,transparent);background:color-mix(in srgb,var(--roko-warn) 8%,transparent);font-size:12.5px;color:var(--ui-text-secondary)}
.roko-banner[data-tone=bad]{border-color:color-mix(in srgb,var(--roko-bad) 35%,transparent);background:color-mix(in srgb,var(--roko-bad) 7%,transparent)}
.roko-banner-icon{margin-top:1px;color:var(--roko-warn)}.roko-banner[data-tone=bad] .roko-banner-icon{color:var(--roko-bad)}
.roko-banner-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.roko-banner-title{font-weight:600;color:var(--ui-text-primary)}
.roko-error{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:9px;border:1px solid color-mix(in srgb,var(--roko-bad) 30%,transparent);background:color-mix(in srgb,var(--roko-bad) 6%,transparent);font-size:12px}
.roko-error[data-compact=true]{padding:7px 10px}
.roko-error-icon{margin-top:1px;color:var(--roko-bad)}
.roko-error-body{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.roko-error-title{font-weight:600;color:var(--ui-text-primary)}
.roko-error-text{color:var(--ui-text-secondary);overflow-wrap:anywhere}
.roko-error-hint{color:var(--ui-text-tertiary)}
.roko-pre{margin:0;max-height:320px;overflow:auto;padding:10px 12px;border-radius:8px;background:var(--ui-bg-quinary);color:var(--ui-text-secondary);font-family:var(--font-mono,ui-monospace,monospace);font-size:11.5px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}
.roko-empty{display:flex;flex-direction:column;align-items:center;gap:6px;padding:36px 16px;text-align:center}
.roko-empty-icon{color:var(--ui-text-quaternary)}
.roko-empty-title{font-weight:600;color:var(--ui-text-secondary)}
.roko-empty-text{max-width:340px;font-size:12px;color:var(--ui-text-tertiary)}
.roko-loading{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--ui-text-tertiary)}
.roko-spinner{width:12px}
.roko-statuschip{display:inline-flex;align-items:center;gap:5px;height:100%;padding:0 6px;border:0;border-radius:0;background:transparent;color:var(--ui-text-tertiary);font:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer}
.roko-statuschip:hover{background:var(--chrome-action-hover);color:var(--ui-text-primary)}
.roko-statuschip-counts{color:var(--ui-text-secondary)}
.roko-directive{display:flex;flex-direction:column;gap:6px;margin:6px 0;max-width:640px}
.roko-directive-raw{font-family:var(--font-mono,ui-monospace,monospace)}
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

export default {
  id: ID,
  name: 'roko',
  description: 'roko runs, approvals, plans, knowledge and health: a /roko page, a status chip and live run cards in chat.',
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
            data: { id: 'roko.waiting', keywords: ['roko', 'approve', 'approvals', 'waiting', 'pending'], label: "roko: What's waiting on me", run: () => openRoko({ tab: 'waiting' }) },
            id: 'waiting'
          },
          {
            area: PALETTE_AREA,
            data: { id: 'roko.health', keywords: ['roko', 'health', 'doctor', 'connection'], label: 'roko: Health check', run: () => openRoko({ tab: 'health' }) },
            id: 'health'
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

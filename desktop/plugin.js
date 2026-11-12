/**
 * roko for Hermes Desktop: the desktop half of hermes-plugin-roko (0.8.1).
 *
 * Installed as <hermes home>/plugins/roko/desktop/plugin.js next to the Python half. Hermes loads it uncompiled:
 * plain ESM, h() calls instead of JSX, and only '@hermes/plugin-sdk', 'react' and 'react/jsx-runtime' imports.
 *
 * It talks only to the plugin's own backend (ctx.rest on /api/plugins/roko/*, ctx.socket('/live'); docs/ui-api.md),
 * so roko's API key never reaches this renderer. A rejected ctx.rest means the router is not mounted: Hermes mounts
 * plugin routers when it starts, so the fix is a restart.
 *
 * Text from roko is untrusted: it is rendered only as React text and elements, never as HTML, and no link is built
 * from it.
 */

import {
  atom,
  Badge,
  Button,
  CHAT_EMPTY_AREA,
  Codicon,
  coarseElapsed,
  COMPOSER_AREAS,
  ConfirmDialog,
  createBudgetedLoop,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  FadeScroll,
  formatModifierToken,
  GlyphSpinner,
  haptic,
  host,
  Input,
  KEYBINDS_AREA,
  Kbd,
  Loader,
  PALETTE_AREA,
  PANES_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  queryClient,
  requestTheme,
  ROUTES_AREA,
  SESSION_ROW_AREAS,
  SIDEBAR_NAV_AREA,
  Skeleton,
  STATUSBAR_AREAS,
  Switch,
  Textarea,
  THEMES_AREA,
  Tip,
  TRANSCRIPT_DIRECTIVE_AREA,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// --- Constants

/**
 * This page's version. The backend reports its own (`plugin_version`); a difference means Hermes still runs one of
 * the two from before an update (docs/updating.md).
 */
const VERSION = '0.8.1'
/** Plugin id == dashboard manifest name, so ctx.rest('/x') -> /api/plugins/roko/x. */
const ID = 'roko'
const PAGE = '/roko'
/** The monitor pane, as the layout tree knows it (contribution ids are `<plugin>:<id>`). */
const PANE_ID = `${ID}:monitor`
/** Run and plan ids from directives, deep links and untrusted data. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TABS = ['build', 'runs', 'waiting', 'plans', 'learning', 'loops', 'knowledge', 'health']
/** A run's own views: the sequencer, everything that happened, its five loops, and what it changed. */
const RUN_VIEWS = ['overview', 'activity', 'time', 'loops', 'changes']
const ACTIVE_STATES = new Set(['queued', 'running'])
// `interrupted`: roko's process stopped while the run went (a restart or a crash); roko ends it as that.
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'unverified', 'cancelled', 'missing', 'interrupted'])
/** Contract: no faster than 10 s for the overview and 3 s for one run. */
const OVERVIEW_MS = 10_000
const OVERVIEW_HIDDEN_MS = 30_000
/** How soon the page looks again while roko serve is out of reach (its first minute). */
const OFFLINE_RECHECK_MS = 2_500
const RUN_MS = 3_000
/** While the live socket is healthy, polling only backs it up. */
const FALLBACK_MS = 15_000
/** The socket pings every 15 s: this long without a frame and it no longer counts as live. */
const LIVE_STALE_MS = 40_000
/** roko_* tool calls finishing within this window share one refresh. */
const TOOL_REFRESH_MS = 1_500
/** 0.7: while a project's roko serve is starting, the page looks every 2 s, for 90 s at most (BRIEF §C). */
const SERVE_POLL_MS = 2_000
const SERVE_WAIT_MS = 90_000
/** The project this window shows, kept in its localStorage. */
const PROJECT_KEY = 'roko.project'
const RESTART_HINT = "Restart Hermes to load roko's backend: quit it with ⌘Q and open it again."
/** What finishes an update in the desktop app; closing the window leaves the old backend running. */
const RESTART_STEPS = ['Quit Hermes with ⌘Q. Closing the window is not enough: the app keeps running.', 'Open Hermes again.']
/** The composer's keybind: "r" for run. Free in Hermes 0.21 (⌘⌥digits are profiles, ⌘⌥T the tab strip). */
const NEW_RUN_COMBO = 'mod+alt+r'
const MAX_PROMPT = 8_000
const CAP_PRESETS = [0.25, 0.5, 1, 2, 5]
const EXAMPLES = [
  'Add a --json flag to the CLI that prints the report as JSON, with a test for it.',
  'Write REPORT.md: a one-page summary of the public API with an example for each function.',
  'Find the test that fails on a clean checkout, fix the cause, and keep every other test green.'
]
/** The same three, as chips: a word or two each. */
const EXAMPLE_CHIPS = ['--json flag + test', 'REPORT.md', 'fix the failing test']

const KEYS = {
  all: [ID],
  overview: [ID, 'overview'],
  pending: [ID, 'pending'],
  plans: [ID, 'plans'],
  build: [ID, 'build'],
  plan: id => [ID, 'plan', id],
  run: id => [ID, 'run', id],
  diff: id => [ID, 'diff', id],
  merge: id => [ID, 'merge', id],
  knowledge: q => [ID, 'knowledge', q],
  health: [ID, 'health'],
  insights: [ID, 'insights'],
  learning: [ID, 'learning'],
  loops: [ID, 'loops'],
  statusText: [ID, 'status-text']
}

const STATES = {
  queued: { glyph: '·', tone: 'muted', word: 'queued' },
  running: { glyph: '⟳', tone: 'live', word: 'running' },
  succeeded: { glyph: '✓', stamp: 'passed', tone: 'good', word: 'passed' },
  failed: { glyph: '✗', tone: 'bad', word: 'failed' },
  // No check ran: never green.
  unverified: { glyph: '?', tone: 'warn', word: 'not checked' },
  cancelled: { glyph: '■', tone: 'muted', word: 'stopped' },
  // Hermes started it; roko kept no record (it refused it at once).
  missing: { glyph: '?', tone: 'warn', word: 'missing' },
  // roko stopped while it went (a restart or a crash): not a verdict on the work, which is kept.
  interrupted: { glyph: '‖', tone: 'warn', word: 'interrupted' },
  // The page's own: roko serve is down, so a run it last called running is only its last known state.
  last_seen: { glyph: '·', tone: 'muted', word: 'last seen running' }
}

/**
 * While roko serve is down, a run it last called running is only its last known state: it may still be going, or it
 * stopped when roko did. Shown as "last seen running", with its clock stopped at its last sign of life and nothing
 * to cancel.
 */
function lastKnown(run, reachable) {
  if (reachable !== false || !isRecord(run) || !isActiveRun(run)) {
    return run
  }

  const start = parseTime(run.started_at)
  const lastAt = text(run.last_event_at) || text(run.checked_at) || null
  const last = parseTime(lastAt)

  return {
    ...run,
    active: false,
    duration_ms: start !== null && last !== null ? Math.max(0, last - start) : run.duration_ms,
    // roko's headline starts with the state it last said ("running · gates 11/11 · …").
    headline: text(run.headline).replace(/^(running|queued)\b/i, 'last seen running') || run.headline,
    last_seen_at: lastAt,
    state: 'last_seen'
  }
}

/** Whether the overview found roko serve answering: true, false, or null before it knows. */
function useReachable() {
  const data = useOverview().data
  const conn = isRecord(data?.connection) ? data.connection : null

  return conn ? conn.reachable === true : null
}

/** roko's line for an interrupted run (`interrupted.reason`), or the same words from an older card. */
function interruptedReason(run) {
  return text(isRecord(run?.interrupted) ? run.interrupted.reason : '') || 'roko stopped while this run was going (machine restart or crash).'
}

const OUTCOMES = {
  ...STATES,
  pending: { glyph: '○', tone: 'muted', word: 'pending' },
  passed: { glyph: '✓', tone: 'good', word: 'passed' },
  // roko: every check passed, or failed only on tests that also failed on the run's start commit (render.py's ✓).
  passed_with_preexisting_failures: { glyph: '✓', note: 'failures were there before', tone: 'good', word: 'passed' },
  already_satisfied: { glyph: '✓', tone: 'good', word: 'already satisfied' },
  accepted_with_failures: { glyph: '✓', tone: 'warn', word: 'accepted with failures' },
  skipped: { glyph: '⊘', tone: 'muted', word: 'skipped' },
  // roko: no conditional route in the plan chose the task (render.py's ⊘).
  'condition-skipped': { glyph: '⊘', note: 'the plan’s conditions did not call for it', tone: 'muted', word: 'skipped' },
  interrupted: { glyph: '·', tone: 'muted', word: 'interrupted' },
  stopped: { glyph: '·', tone: 'muted', word: 'stopped' },
  error: { glyph: '✗', tone: 'bad', word: 'error' },
  crashed: { glyph: '✗', tone: 'bad', word: 'crashed' },
  timeout: { glyph: '✗', tone: 'bad', word: 'timed out' },
  timed_out: { glyph: '✗', tone: 'bad', word: 'timed out' },
  rejected: { glyph: '✗', tone: 'bad', word: 'rejected' },
  blocked: { glyph: '✗', tone: 'warn', word: 'blocked' }
}

/** What a task's inspector says about an outcome that reads as another (roko's words, for a person). */
const OUTCOME_NOTES = {
  'condition-skipped': 'Skipped: the plan’s conditions did not call for this task.',
  passed_with_preexisting_failures: 'Passed. The tests that failed also failed on the commit this run started from, so this task did not cause them.'
}

/** Graph node states, from task outcomes. */
const PASSED = new Set(['passed', 'passed_with_preexisting_failures', 'already_satisfied', 'accepted_with_failures', 'succeeded'])
const FAILED = new Set(['failed', 'error', 'crashed', 'timeout', 'timed_out', 'rejected'])
const STOPPED = new Set(['cancelled', 'interrupted', 'skipped', 'condition-skipped', 'stopped'])

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

/** roko's five nested loops, inner to outer, named the same way everywhere. */
const RINGS = [
  { clock: 'seconds', name: 'tool calls', ring: 'L0' },
  { clock: 'minutes', name: 'attempts', ring: 'L1' },
  { clock: 'hours', name: 'the plan', ring: 'L2' },
  { clock: 'days', name: 'learning', ring: 'L3' },
  { clock: 'weeks', name: 'audit', ring: 'L4' }
]
const RING_IDS = RINGS.map(r => r.ring)

/** Each loop kind's ring, for events that arrive without one. */
const KIND_RING = {
  budget: 'L2',
  controller: 'L3',
  essential: 'L3',
  playbook: 'L3',
  diagnosis: 'L2',
  failover: 'L1',
  guarded_commit: 'L4',
  hold: 'L2',
  knowledge: 'L3',
  loop_health: 'L4',
  regression: 'L1',
  retry: 'L1',
  route: 'L1',
  thresholds: 'L3',
  tool_decided: 'L0',
  tool_held: 'L0',
  wave: 'L2',
  withheld: 'L0'
}

/** A loop kind as a few words for its tag. */
const KIND_WORDS = {
  budget: 'budget',
  controller: 'M1',
  essential: 'homeostat',
  playbook: 'playbook',
  diagnosis: 'diagnosis',
  failover: 'failover',
  guarded_commit: 'guard',
  hold: 'sign-off',
  knowledge: 'learned',
  loop_health: 'health',
  regression: 'regression',
  retry: 'retry',
  route: 'route',
  thresholds: 'thresholds',
  tool_decided: 'decided',
  tool_held: 'held',
  wave: 'wave',
  withheld: 'withheld'
}

/** Who picked an attempt's model (roko's `decided_by`, else its `source`), as people say it. */
const DECIDERS = {
  control: 'control',
  default: 'default',
  explore: 'exploring',
  failover: 'failover',
  fallback: 'fallback',
  ladder: 'ladder',
  learned: 'learned',
  override: 'override',
  pinned: 'pinned',
  router: 'router',
  self_model: 'self-model',
  task_hint: 'task hint'
}

/** Who picked a model, in a sentence's words ("picked by the model ladder"); the same words as the dashboard. */
const ROUTE_SOURCE_WORDS = {
  control: 'the router\u2019s control arm',
  default: 'the default model',
  explore: 'the router, exploring',
  failover: 'a failover',
  fallback: 'the fallback',
  ladder: 'the model ladder',
  learned: 'what roko learned',
  override: 'an override',
  pinned: 'the task\u2019s model hint',
  router: 'the router',
  self_model: 'the self-model',
  task_hint: 'the task\u2019s model hint'
}

/**
 * Who picked an attempt's model and whether scores did it: `{decider, word, words, rung, scored}`. roko's
 * `decided_by`, `rung` and `scored` come from a newer backend; from an older one the decider is read off the
 * router's `source` / `stage`, and the scores decided only when they differ and no rule (a ladder, a pin) did.
 */
function routeView(route) {
  const source = text(route?.source)
  const stage = text(route?.stage)
  const decider =
    text(route?.decided_by) ||
    (source === 'ladder' || stage === 'ladder'
      ? 'ladder'
      : source === 'task_hint' || source === 'override'
        ? 'pinned'
        : source === 'control' || source === 'self_model' || source === 'router'
          ? 'router'
          : source)
  const scores = list(route?.candidates)
    .filter(isRecord)
    .filter(c => c.eligible !== false)
    .map(c => num(c.score))
    .filter(v => v !== null)
  const distinct = scores.some(v => Math.abs(v - scores[0]) > 1e-9)
  const scored = route?.scored === true || (route?.scored !== false && decider !== 'ladder' && decider !== 'pinned' && distinct)

  return {
    decider,
    rung: text(route?.rung),
    scored,
    word: DECIDERS[decider] ?? clip(decider, 16),
    words: decider === 'failover' ? 'switched by a failover' : `picked by ${ROUTE_SOURCE_WORDS[decider] ?? (decider.replace(/_/g, ' ') || 'roko')}`
  }
}

/** A model a run from Hermes cannot use: one that runs its own tools (a CLI or ACP agent), on an older backend. */
function fromHermes(c) {
  if (c.eligible === false || 'why_not' in c) {
    return c
  }

  return /(^|[_-])(cli|acp)$/i.test(text(c.provider)) ? { ...c, eligible: false, why_not: 'runs its own tools: a run started from Hermes needs a model in roko\u2019s own tool loop' } : c
}

// --- Small helpers

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

/** `v` with a capital first letter: the backend's words that begin mid-sentence, as a sentence of their own. */
function sentenceCase(v) {
  const s = text(v)

  return s ? `${s.charAt(0).toUpperCase()}${s.slice(1)}` : s
}

/** The end of `v` in at most `max` characters: what an agent is saying now is at the end. */
function clipEnd(v, max) {
  const s = text(v).replace(/\s+/g, ' ').trim()

  return s.length > max ? `…${s.slice(s.length - max + 1)}` : s
}

/** A folder's own name, the last part of its path: "undertow" for /Users/you/dev/undertow. */
function folderName(path) {
  return clip(text(path).replace(/\/+$/, '').split('/').pop() || text(path), 60)
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

/**
 * The moment `elapsedS` seconds before `at`, as an ISO string, when the elapsed time is sane (0 to a day); else
 * null, and the page shows no clock. A Date out of range would throw in toISOString and blank the page.
 */
function sinceIso(at, elapsedS) {
  const s = num(elapsedS)
  const t = s !== null && s >= 0 && s <= 86_400 && num(at) !== null ? at - s * 1000 : NaN

  return Number.isFinite(t) ? new Date(t).toISOString() : null
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

/** "just now", or "3m ago": a moment in the past, in words (ago() alone is the short form for lists). */
function agoText(v, now = Date.now()) {
  const short = ago(v, now)

  return !short ? '' : short === 'now' ? 'just now' : `${short} ago`
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

/** How a card, a row or a run.ended event says roko stopped the run at its cap (when the run has no `budget_stop`). */
const CAP_HEADLINE = /^stopped: the run reached its cap\b/
/** The same for roko's daily limit (`budget.max_daily_usd`). */
const DAY_HEADLINE = /^stopped: today's limit was reached\b/

/**
 * roko stopped the run at its cap, or at its daily limit (0.5.0 `budget_stop`, roko bug-4fabd0): roko's state stays
 * `failed`, but it is a stop, not a failure. A card and a row have `budget_stop`; a run.ended event has the
 * headline.
 */
function capStopped(run) {
  return isRecord(run) && run.state === 'failed' && (Boolean(run.budget_stop) || CAP_HEADLINE.test(text(run.headline)) || DAY_HEADLINE.test(text(run.headline)))
}

/** Which limit stopped the run: roko's daily limit (`budget_stop.limit: "day"`), else the run's own cap. */
function dayStopped(run) {
  return (isRecord(run.budget_stop) && text(run.budget_stop.limit) === 'day') || DAY_HEADLINE.test(text(run.headline))
}

/** A stop at a limit as the pages show it: a stop's colour, never red. */
const CAP_STOP = { glyph: '■', stamp: 'stopped at cap', tone: 'muted', word: 'stopped · cap' }
const DAY_STOP = { glyph: '■', stamp: 'stopped at limit', tone: 'muted', word: 'stopped · day limit' }

/**
 * The stop in a sentence (the same words as the dashboard): "roko stopped the run at its cap of $0.05 ($0.032
 * spent)", or "… at today’s limit of $20.00 ($20.04 spent)".
 */
function capWords(run) {
  const stop = isRecord(run.budget_stop) ? run.budget_stop : {}
  const cap = num(stop.cap_usd)
  const spent = num(stop.spent_usd)

  return `roko stopped the run at ${dayStopped(run) ? 'today’s limit' : 'its cap'}${cap !== null ? ` of ${money(cap)}` : ''}${cap !== null && spent !== null ? ` (${money(spent)} spent)` : ''}`
}

/** A run's state as the pages show it. */
function runInfo(run) {
  return capStopped(run) ? (dayStopped(run) ? DAY_STOP : CAP_STOP) : stateInfo(run?.state)
}

/** How a run ended, in a word, for rows and toasts. */
function runWord(run) {
  return capStopped(run) ? runInfo(run).word : endWord(run?.state, run?.kind)
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

/** A run with a verdict: not going, and not merely last seen going while roko serve is down. */
function hasEnded(run) {
  return isRecord(run) && !isActiveRun(run) && run.state !== 'last_seen'
}

/**
 * Hermes started the run, but roko has not yet (a fresh roko serve checks its model ladder first, about 18 s): the
 * card has Hermes' start (`hermes_started_at`) and not roko's (`started_at`). The page says "starting…" with no clock,
 * so the clock never runs from the click and then jumps back when roko's start arrives.
 */
function notStarted(run) {
  return isActiveRun(run) && run.state !== 'queued' && 'hermes_started_at' in run && !text(run.started_at)
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

const EMPTY_PROGRESS = { blocked: 0, failed: 0, passed: 0, pending: 0, running: 0, skipped: 0, stopped: 0, total: 0, unverified: 0 }

/** Where the run's tasks are: the card's `progress`, or counted from its tasks. */
function progressOf(run) {
  const p = isRecord(run?.progress) ? run.progress : null

  if (p && num(p.total) !== null) {
    const out = { ...EMPTY_PROGRESS, ...Object.fromEntries(Object.entries(p).map(([k, v]) => [k, num(v) ?? 0])) }

    // A run that ended (interrupted, cancelled…) runs nothing: what it was running stopped with it.
    return out.running && hasEnded(run) ? { ...out, running: 0, stopped: out.stopped + out.running } : out
  }

  const out = { ...EMPTY_PROGRESS }

  list(run?.tasks)
    .filter(isRecord)
    .forEach(task => {
      const raw = nodeState(task.outcome)
      const state = raw === 'running' && hasEnded(run) ? 'stopped' : raw

      out.total += 1
      out[state === 'stopped' ? 'stopped' : state] = (out[state === 'stopped' ? 'stopped' : state] ?? 0) + 1
    })

  return out
}

/** An agent line's attempt, model and provider: the line's own fields (the backend's since 0.3.0). */
function parseAgentLine(event) {
  return isRecord(event) && text(event.model) ? { attempt: num(event.attempt), model: text(event.model), provider: text(event.provider) || null } : null
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

// --- The backend: ctx.rest to /api/plugins/roko (docs/ui-api.md)

/** Doors bound in register(); null when the plugin is disabled. */
let doors = null

class RokoError extends Error {
  constructor({ kind, code, message, hint, problem, validation, serve, resumable }) {
    super(message)
    this.name = 'RokoError'
    /** 'backend': ctx.rest rejected (router missing or crashed); 'roko': the route said ok:false. */
    this.kind = kind
    this.code = code
    this.hint = hint || ''
    /** A refusal that names a setup problem (`{ok:false, problem}`): shown as that problem with its fix. */
    this.problem = problem ?? null
    /** A plan run roko refused because the plan fails its validator (0.5.0): the PlanValidation. */
    this.validation = isRecord(validation) ? validation : null
    /** 0.7 POST /serve refused (a busy restart or stop): the serve as it is now, with what it would stop. */
    this.serve = isRecord(serve) ? serve : null
    /** P-14: a plan run refused until it says continue or start over: the run it would continue. */
    this.resumable = isRecord(resumable) ? resumable : null
  }
}

/** A run's id as roko shows it: its UUID's first 8 characters (a CLI run's `graph-<plan>-<uuid>` too). */
function shortRunId(id) {
  const s = text(id)
  const found = /^graph-.+-([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.exec(s)

  return found ? found[1] : s.slice(0, 8)
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
    const problem = readProblem(reply.problem)

    // 0.7: a refused action that says how the project's serve stands (a busy restart, a run whose serve could not start
    // there): the page says it at once. (Only actions: applying it asks the overview again.)
    if (options?.method === 'POST') {
      applyServe(reply.serve)
    }

    throw new RokoError({
      code: text(e.code) || 'internal',
      hint: text(e.hint),
      kind: 'roko',
      message: text(e.message) || problem?.title || 'roko reported an error.',
      problem,
      resumable: reply.resumable_run,
      serve: reply.serve,
      validation: reply.validation
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

// --- Queries

/**
 * 0.7: the project this window shows (its overview, plans, loops, insights, learning and lessons): the path the
 * person picked, or null for the backend's default. The default keeps 0.6's URLs and cache keys; a picked one
 * adds `?project=` to them and one part to each key.
 */
const $project = atom(null)

function storedProject() {
  try {
    const value = window.localStorage.getItem(PROJECT_KEY)

    return typeof value === 'string' && value && value.length < 4096 ? value : null
  } catch {
    return null
  }
}

/** Show `path` here (null: the default project) and keep it for this window. */
function setProject(path) {
  const next = typeof path === 'string' && path ? path : null

  if (next === $project.get()) {
    return
  }

  $project.set(next)
  // Another project's first overview only seeds what the notices compare against: its runs are not news.
  seen.seeded = false
  $plan.set(null)

  // The socket's overview frames are about one project: dial again for this one (openLive keeps a socket whose path
  // did not change).
  if (socketState.dispose) {
    openLive()
  }

  try {
    if (next) {
      window.localStorage.setItem(PROJECT_KEY, next)
    } else {
      window.localStorage.removeItem(PROJECT_KEY)
    }
  } catch {
    // Kept for this page only.
  }
}

/** `path` for the project shown here: `?project=…` (or `&…`) for a picked one, nothing for the default. */
function forProject(path, project = $project.get()) {
  return project ? `${path}${path.includes('?') ? '&' : '?'}project=${enc(project)}` : path
}

/** A query key for the project shown here: the default project's is 0.6's. */
function projectKey(key, project = $project.get()) {
  return project ? [...key, project] : key
}

const fetchOverview = (project = $project.get()) => call(forProject('/overview', project))

/** The ONE overview key per project: chip, page, sidebar label and notifications share it. */
function useOverview() {
  const project = useValue($project)

  // A project just picked shows the last one's overview until its own arrives, rather than a blank page.
  return useQuery({ placeholderData: previous => previous, queryFn: () => fetchOverview(project), queryKey: projectKey(KEYS.overview, project), retry: false, staleTime: OVERVIEW_MS - 1_000 })
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

// -- 0.7: projects and their roko serves (BRIEF §C) ------------------------------------

/** Each state of a project's roko serve: its word, its light, and the word on the glass. */
const SERVE_LOOK = {
  failed: { dots: 'FAILED', tone: 'fail', word: 'failed to start' },
  not_found: { dots: 'NO ROKO', tone: 'you', word: 'not found' },
  outdated: { dots: 'UPDATE', tone: 'you', word: 'outdated' },
  remote: { dots: 'REMOTE', tone: 'ink', word: 'remote' },
  running: { dots: 'ON', tone: 'pass', word: 'running' },
  starting: { blink: 'slow', dots: 'STARTING', tone: 'live', word: 'starting' },
  stopped: { dots: 'STOPPED', tone: 'off', word: 'stopped' }
}
/** The states the page shows as the serve banner: everything but running and remote (which it never starts). */
const SERVE_BANNER = new Set(['starting', 'stopped', 'failed', 'outdated', 'not_found'])

/** A ServeState from the backend, checked; null from an older backend (no `connection.serve`). */
function readServe(value) {
  if (!isRecord(value) || !SERVE_LOOK[text(value.state)]) {
    return null
  }

  const err = isRecord(value.error) ? value.error : null

  return {
    actions: list(value.actions).map(text).filter(a => a === 'start' || a === 'restart' || a === 'stop'),
    busy: num(isRecord(value.busy) ? value.busy.active_runs : null) ?? 0,
    error: err ? { code: text(err.code), hint: text(err.hint), message: text(err.message) } : null,
    idle: num(value.idle_exit_minutes),
    // The last lines of the project's serve.log: untrusted, text nodes only.
    log: list(value.log_tail).map(line => text(line).slice(0, 400)).slice(-40),
    name: text(value.name),
    pid: num(value.pid),
    project: text(value.project),
    since: text(value.since),
    startedBy: text(value.started_by),
    state: text(value.state),
    url: text(value.url),
    version: text(value.version)
  }
}

const serveOf = data => readServe(isRecord(data?.connection) ? data.connection.serve : null)

/** A serve's state as the header and its live region say it. */
const serveWords = serve => `roko serve ${SERVE_LOOK[serve.state].word}`

/** A Project from the backend, checked, or null. */
function readProject(value) {
  const path = isRecord(value) ? text(value.path) : ''

  return path
    ? { default: value.default === true, name: text(value.name) || path.split(/[\\/]/).filter(Boolean).pop() || path, needsSetup: value.needs_setup === true, path, serve: readServe(value.serve) }
    : null
}

/**
 * The overview's projects (default first, then the most recently used) and the one it is about; none from 0.6.
 * `none`: a 0.7 backend that knows no project yet (`projects: []`, `project: null`, no serve): the page asks for one. A
 * remote roko serve without a `workdir` has no project either, but its serve is there: nothing to pick.
 */
function projectsOf(data) {
  const all = list(data?.projects).map(readProject).filter(Boolean)
  const current = readProject(data?.project) ?? all.find(p => p.default) ?? null

  return { all: all.length || !current ? all : [current], current, none: Array.isArray(data?.projects) && !all.length && !current && !serveOf(data) }
}

/** `{project}` for a start's body when this window shows a project the person picked; the default needs none. */
function projectBody() {
  return $project.get() ? { project: $project.get() } : {}
}

/** POST /projects's reply: every cached overview lists the projects as it says them now. */
function takeProjects(reply) {
  if (Array.isArray(reply?.projects)) {
    queryClient.setQueriesData({ queryKey: KEYS.overview }, old => (isRecord(old) ? { ...old, projects: reply.projects } : old))
  }
}

/**
 * A serve's new state (POST /serve's reply, or the socket's `serve` frame): the overviews of its project say it at
 * once, and every list of projects; then the overview is asked again.
 */
function applyServe(value) {
  const serve = readServe(value)

  if (!serve) {
    return
  }

  queryClient.setQueriesData({ queryKey: KEYS.overview }, old => {
    if (!isRecord(old)) {
      return old
    }

    // A serve without a project is a remote one without a `workdir`, whose overview names no project either.
    const here = serve.project ? text(old.project?.path) === serve.project : !isRecord(old.project) || old.project.default === true
    const projects = Array.isArray(old.projects) ? old.projects.map(p => (isRecord(p) && text(p.path) === serve.project ? { ...p, serve: value } : p)) : old.projects

    return here && isRecord(old.connection) ? { ...old, connection: { ...old.connection, serve: value }, projects } : { ...old, projects }
  })
  void queryClient.invalidateQueries({ queryKey: KEYS.overview })
}

/** Start, restart or stop a project's roko serve (POST /serve; `force` stops its runs). */
async function serveAction(action, project, force = false) {
  const reply = await call('/serve', { body: { action, ...(project ? { project } : {}), ...(force ? { force: true } : {}) }, method: 'POST', timeoutMs: 60_000 })

  applyServe(reply.serve)

  return reply
}

/** The runs a restart or stop of this serve would stop: the overview's live rows in its project. */
function busyRuns(serve, data) {
  return list(data?.runs).filter(row => isRecord(row) && isActiveRun(row) && (!isRecord(row.project) || !serve.project || text(row.project.path) === serve.project))
}

// What the person answered on this page: roko may list it a moment longer, the page lets it go at once.
const answeredCodes = new Map()

function answered(item) {
  const at = answeredCodes.get(text(item?.code))

  return at !== undefined && Date.now() - at < 60_000
}

/** After an answer: the item leaves the waiting list, the overview's count and its run's card before roko says so. */
function dropAnswered(code, runId) {
  const keep = item => text(item?.code) !== code

  answeredCodes.set(code, Date.now())
  queryClient.setQueriesData({ queryKey: KEYS.pending }, old => (Array.isArray(old) ? old.filter(keep) : old))
  queryClient.setQueriesData({ queryKey: KEYS.overview }, old =>
    isRecord(old)
      ? {
          ...old,
          counts: isRecord(old.counts) && list(old.pending).some(item => !keep(item)) ? { ...old.counts, waiting: Math.max(0, (num(old.counts.waiting) ?? 1) - 1) } : old.counts,
          pending: list(old.pending).filter(keep)
        }
      : old
  )

  if (validId(runId)) {
    queryClient.setQueryData(KEYS.run(runId), old => (isRecord(old) ? { ...old, waiting: list(old.waiting).filter(keep) } : old))
  }
}

/** roko's list without an answered item: it settled the answer, so the page stops keeping it apart. */
function settleAnswered(items) {
  const listed = new Set(items.map(item => text(item?.code)))

  for (const [code, at] of answeredCodes) {
    if (!listed.has(code) || Date.now() - at >= 60_000) {
      answeredCodes.delete(code)
    }
  }

  return items
}

function usePending() {
  const project = useValue($project)

  return useQuery({
    queryFn: () => call(forProject('/pending', project)).then(r => settleAnswered(list(r.items))),
    queryKey: projectKey(KEYS.pending, project),
    refetchInterval: () => (isHidden() ? OVERVIEW_HIDDEN_MS : pollMs(OVERVIEW_MS)),
    retry: false,
    staleTime: 5_000
  })
}

/** A fresh run card updates the run's row in the shared overview at once, not at the next 10 s poll. */
function patchOverviewRow(run) {
  if (!isRecord(run) || !validId(run.run_id)) {
    return run
  }

  queryClient.setQueriesData({ queryKey: KEYS.overview }, old => {
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
        state: text(run.state) || row.state,
        // A stop at a limit (0.5.0): the row says it as soon as a card did.
        ...(isRecord(run.budget_stop) ? { budget_stop: run.budget_stop } : {})
      }

      changed =
        changed ||
        ['active', 'cost_usd', 'finished_at', 'state'].some(key => next[key] !== row[key]) ||
        JSON.stringify(next.progress) !== JSON.stringify(row.progress) ||
        JSON.stringify(next.budget_stop) !== JSON.stringify(row.budget_stop)

      return next
    })

    return changed ? { ...old, runs } : old
  })

  return run
}

/** A run's card (GET /runs/{id}), its loop events kept and its overview row brought up to date. */
function fetchRunCard(runId) {
  return call(`/runs/${enc(runId)}`).then(r => patchOverviewRow(absorbCard(isRecord(r.run) ? r.run : null)))
}

function useRun(runId, enabled = true) {
  return useQuery({
    enabled: enabled && validId(runId),
    queryFn: () => fetchRunCard(runId),
    queryKey: KEYS.run(runId),
    // Poll every 3 s while the run is active (or roko is writing a plan), every 15 s while the live socket
    // pushes its cards; stop once it ends. A card still `reading` its history: every 3 s (no socket says when).
    refetchInterval: query => (isActiveRun(query.state.data) ? pollMs(RUN_MS) : query.state.data?.reading === true ? RUN_MS : false),
    retry: false,
    staleTime: 2_000
  })
}

/** What an ended run changed (GET /runs/{id}/diff): files with parsed hunks. */
/** `&work=…&plan_id=…` for one part of a run's work (see workParts); nothing for the default part. */
function partQuery(part) {
  return part ? `&work=${enc(part.trust)}${part.planId ? `&plan_id=${enc(part.planId)}` : ''}` : ''
}

function useDiff(runId, enabled, part = null) {
  return useQuery({
    enabled: enabled && validId(runId),
    queryFn: () => call(`/runs/${enc(runId)}/diff?max_files=150${partQuery(part)}`).then(r => (isRecord(r.diff) ? r.diff : null)),
    queryKey: [...KEYS.diff(runId), part?.key ?? ''],
    retry: false,
    staleTime: 60_000
  })
}

/** Whether Merge would work now (GET /runs/{id}/merge, for one part of the work): changes nothing. */
function useMergeCheck(runId, enabled, part = null) {
  return useQuery({
    enabled: enabled && validId(runId),
    queryFn: () => call(`/runs/${enc(runId)}/merge${part ? `?${partQuery(part).slice(1)}` : ''}`).then(r => (isRecord(r.merge) ? r.merge : null)),
    queryKey: [...KEYS.merge(runId), part?.key ?? ''],
    retry: false,
    staleTime: 5_000
  })
}

/**
 * Where a run's work is and how far it can be trusted (the card's `work.parts`): the verified work roko delivered
 * to the run's branch, and work it kept on a plan's branch, verified (the passed tasks of a plan that failed) or
 * not (no check ran). [] from an older backend, which knows only `delivered`.
 */
function workParts(run) {
  const work = isRecord(run?.work) ? run.work : null

  return list(work?.parts)
    .filter(isRecord)
    .map((part, i) => ({
      branch: text(part.branch),
      delivered: part.delivered === true,
      // `counts` from a newer backend; else the diffstat sentence, else the file list.
      files: num(part.counts?.files) ?? num(/(\d+) files? changed/.exec(text(part.diffstat))?.[1]) ?? list(part.files_changed).length,
      merged: part.merged === true,
      diffstat: text(part.diffstat),
      key: `${text(part.trust)}:${text(part.plan_id)}:${i}`,
      planId: text(part.plan_id),
      tasks: list(part.tasks).filter(isRecord),
      trust: part.trust === 'unverified' ? 'unverified' : 'verified'
    }))
}

/** A part's name on its key, as the dashboard says it: "verified · 1 file", "unverified · add-tests · 2 files". */
function partLabel(part, many) {
  return [part.trust, many && part.planId && !part.delivered ? clip(part.planId, 28) : '', part.files ? plural(part.files, 'file') : '', part.merged ? 'merged' : ''].filter(Boolean).join(' · ')
}

function usePlans(enabled = true) {
  const project = useValue($project)

  return useQuery({
    enabled,
    queryFn: () => call(forProject('/plans', project)).then(r => list(r.plans)),
    queryKey: projectKey(KEYS.plans, project),
    retry: false,
    staleTime: 30_000
  })
}

/** A plan's set (its folder under plans/) from the plans list, when it is wanted and roko lists the plan. */
function usePlanGroup(planId) {
  const plans = usePlans(validId(planId))

  return validId(planId) ? text(list(plans.data).find(plan => isRecord(plan) && plan.id === planId)?.group) : ''
}

function usePlan(planId, writing = false) {
  const project = useValue($project)
  // P-63: the minute of looks for a plan not there yet counts from when its writing ended: a writing past a
  // dozen 3 s looks used to leave none (phase 5.4's card kept the writing's card for good).
  const since = useRef(Date.now())
  const wrote = useRef(writing)

  if (wrote.current !== writing) {
    since.current = Date.now()
  }

  const query = useQuery({
    enabled: validId(planId),
    queryFn: () => call(forProject(`/plans/${enc(planId)}`, project)).then(r => (isRecord(r.plan) ? r.plan : null)),
    queryKey: projectKey(KEYS.plan(planId), project),
    // P-45: a plan not there yet is looked for again: every 3 s while roko writes it, else for a minute.
    refetchInterval: q => (q.state.data ? false : writing ? 3_000 : Date.now() - since.current < 60_000 ? 5_000 : false),
    retry: false,
    staleTime: 30_000
  })

  // P-63: and once more the moment the writing ends.
  useEffect(() => {
    if (wrote.current && !writing && !query.data && validId(planId)) {
      void query.refetch()
    }

    wrote.current = writing
  }, [writing])

  return query
}

function useKnowledge(q) {
  const project = useValue($project)

  return useQuery({
    enabled: q.length >= 2,
    placeholderData: previous => previous,
    queryFn: () => call(forProject(`/knowledge?q=${enc(q)}&limit=20`, project)).then(r => list(r.entries)),
    queryKey: projectKey(KEYS.knowledge(q), project),
    retry: false,
    staleTime: 60_000
  })
}

/** The doctor's checks. The cache keeps /health whole: the setup module reads its `install` and `setup`. */
function useHealth() {
  const project = useValue($project)

  return useQuery({
    queryFn: () => call(forProject('/health', project)),
    queryKey: projectKey(KEYS.health, project),
    retry: false,
    select: reply => list(reply?.checks),
    staleTime: 30_000
  })
}

/** Whose numbers Insights shows: the runs Hermes started (the default), or roko's whole workspace. */
const $insightsScope = atom('hermes')

function useInsights(scope = 'hermes') {
  const project = useValue($project)

  // An older backend ignores `scope` and answers for the whole workspace (its reply has no `scope` then).
  return useQuery({ queryFn: () => call(forProject(`/insights?scope=${enc(scope)}`, project)), queryKey: projectKey([...KEYS.insights, scope], project), retry: false, staleTime: 60_000 })
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
/**
 * `value` at most once every `ms`, the newest winning (spec v3 §8: a live region speaks once every 2 s): a change
 * after a quiet spell shows at once; changes within the window wait for its end, and only the last of them shows.
 */
function useThrottled(value, ms) {
  const [shown, setShown] = useState(value ?? '')
  const latest = useRef(value)
  const last = useRef(0)
  const timer = useRef(null)

  latest.current = value

  useEffect(() => {
    // `undefined`: hold what was said (a replay moves the playhead).
    if (value === undefined || value === shown || timer.current) {
      return
    }

    const wait = last.current + ms - Date.now()

    if (wait <= 0) {
      last.current = Date.now()
      setShown(value)

      return
    }

    timer.current = setTimeout(() => {
      timer.current = null
      last.current = Date.now()

      if (latest.current !== undefined) {
        setShown(latest.current)
      }
    }, wait)
  }, [value, shown, ms])

  useEffect(() => () => clearTimeout(timer.current), [])

  return shown
}

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

// --- Live: one socket to /live (docs/ui-api.md, "The live channel") feeds the
// query cache and the live views. Polling stays, slowed to a fallback while
// the socket is healthy, and takes over whenever it is not.

/** The socket as the header LED and the settings page see it: off · connecting · open · stale. */
const $live = atom({ hub: null, lastAt: 0, state: 'off' })

function liveHealthy() {
  const s = $live.get()

  return s.state === 'open' && Date.now() - s.lastAt < LIVE_STALE_MS
}

/** How often to poll something the socket also pushes. */
function pollMs(fastMs) {
  return liveHealthy() ? FALLBACK_MS : fastMs
}

/**
 * Per run: what its agents did last (ephemeral `live` items: the newest few, and the newest per task) and
 * its loop events (from cards and frames, merged by `key`). One atom per run, so a frame for one run
 * re-renders only that run's views.
 */
const EMPTY_LIVE = Object.freeze({ at: 0, byTask: Object.freeze({}), items: Object.freeze([]), loops: Object.freeze([]), tools: Object.freeze([]) })
const liveAtoms = new Map()
/** Every loop event this window saw, newest last: the Loops tab and the monitor's dial. */
const $loopFeed = atom([])

function liveAtom(runId) {
  const key = validId(runId) ? runId : '-'
  let a = liveAtoms.get(key)

  if (!a) {
    a = atom(EMPTY_LIVE)
    liveAtoms.set(key, a)

    if (liveAtoms.size > 60) {
      liveAtoms.delete(liveAtoms.keys().next().value)
    }
  }

  return a
}

function useLive(runId) {
  return useValue(liveAtom(runId))
}

/** Runs this window just saw start: their titles decode in once. */
const freshRuns = new Map()

function markFresh(runId) {
  if (validId(runId)) {
    freshRuns.set(runId, Date.now())

    if (freshRuns.size > 20) {
      freshRuns.delete(freshRuns.keys().next().value)
    }
  }
}

function isFresh(runId) {
  const at = freshRuns.get(runId)

  return at !== undefined && Date.now() - at < 6_000
}

// -- blips: one event bus for the scope, the dial and the sounds ------------------

const blipListeners = new Set()

/** {runId, ring, channel: agent|pass|you|fail|ink, ts} */
function blip(event) {
  markActivity = Date.now()

  for (const listener of blipListeners) {
    try {
      listener(event)
    } catch {
      // A broken listener must not stop the others.
    }
  }
}

function onBlip(listener) {
  blipListeners.add(listener)

  return () => blipListeners.delete(listener)
}

/**
 * A loop event's channel (spec v3 §2.2): rose while agents work, orange when it needs the person, red when something
 * broke, indigo when roko changed itself (a lesson, a threshold, a loop's state).
 */
function loopChannel(event) {
  const kind = text(event?.kind)
  const data = isRecord(event?.data) ? event.data : {}

  if (kind === 'hold') {
    return data.state === 'resolved' ? (data.outcome === 'approved' ? 'pass' : 'ink') : 'you'
  }

  if (kind === 'tool_held' || kind === 'budget') {
    return 'you'
  }

  if (kind === 'regression' || kind === 'failover' || kind === 'withheld' || kind === 'guarded_commit') {
    return 'fail'
  }

  if (kind === 'diagnosis') {
    return /warn|error|crit|high/i.test(text(data.severity)) ? 'fail' : 'ink'
  }

  if (kind === 'loop_health') {
    return healthChannel(text(data.to) || text(data.state))
  }

  if (kind === 'knowledge' || kind === 'thresholds') {
    return 'learn'
  }

  if (kind === 'tool_decided') {
    return /applied|approved/i.test(text(data.outcome)) ? 'pass' : 'ink'
  }

  return 'agent'
}

/** A learning loop's health as a channel: working as it should is indigo (learning), watch orange, broken red. */
function healthChannel(state) {
  if (/^(healthy|ok|active|stable)$/i.test(state)) {
    return 'learn'
  }

  if (/watch|degrad|drift|warn/i.test(state)) {
    return 'you'
  }

  return /fail|broken|unhealthy|trip|halt|rollback/i.test(state) ? 'fail' : 'ink'
}

/** A loop event, checked: a known ring (or the kind's), a key to merge by, untrusted text clipped. */
function normLoop(event, runId) {
  if (!isRecord(event)) {
    return null
  }

  const kind = text(event.kind)
  const ring = RING_IDS.includes(text(event.ring)) ? text(event.ring) : KIND_RING[kind]

  if (!ring) {
    return null
  }

  const ts = num(event.ts)
  const data = isRecord(event.data) ? event.data : {}

  return {
    data,
    key: text(event.key) || `${kind}:${text(event.task_id)}:${ts ?? ''}:${text(event.text).slice(0, 48)}`,
    kind,
    plan_id: text(event.plan_id) || null,
    ring,
    run_id: validId(event.run_id) ? event.run_id : validId(runId) ? runId : null,
    task_id: text(event.task_id) || null,
    text: clip(loopText(event, kind, data), 220),
    ts
  }
}

/** A loop event's words: the backend's own (in words since 0.5.0); a loop's health with none is said from its data. */
function loopText(event, kind, data) {
  const said = text(event.text)

  return !said && kind === 'loop_health' && text(data.loop_id) ? `${LOOP_NAMES[text(data.loop_id)] ?? text(data.loop_id)}: ${loopHealthWords(data)}` : said
}

const byTs = (a, b) => (a.ts ?? 0) - (b.ts ?? 0)

/** Merge loop events by key into their run and into the window's feed; frames also blip. */
function mergeLoops(runId, events, fromSocket) {
  const fresh = list(events)
    .map(event => normLoop(event, runId))
    .filter(Boolean)

  if (!fresh.length) {
    return
  }

  const perRun = new Map()

  fresh.forEach(l => {
    if (l.run_id) {
      perRun.set(l.run_id, [...(perRun.get(l.run_id) ?? []), l])
    }
  })

  perRun.forEach((items, id) => {
    const a = liveAtom(id)
    const cur = a.get()
    const known = new Set(cur.loops.map(l => l.key))
    const add = items.filter(l => !known.has(l.key))

    if (add.length) {
      a.set({ ...cur, loops: [...cur.loops, ...add].sort(byTs).slice(-120) })
    }
  })

  const feed = $loopFeed.get()
  const known = new Set(feed.map(l => l.key))
  const add = fresh.filter(l => !known.has(l.key))

  if (!add.length) {
    return
  }

  $loopFeed.set([...feed, ...add].sort(byTs).slice(-240))

  if (fromSocket) {
    add.forEach(l => blip({ channel: loopChannel(l), ring: l.ring, runId: l.run_id, ts: l.ts ?? Date.now() }))
  }

  // A lesson kept just now (spec v3 §6): a glass chime, the mark's eyes a star for a beat, and a ◇ flies to LEARNING;
  // seen first on the socket or in the card's poll, whichever wins, but never for a lesson of a page's history.
  const kept = add.find(l => l.kind === 'knowledge' && /_admitted$/.test(text(l.data?.admission)) && Date.now() - (num(l.ts) ?? 0) < 15_000)

  if (kept) {
    play('lesson')
    markLook('star', 3_000)
    flyLesson(kept.task_id)
  }
}

/** The ◇ of a lesson just kept, from its task's pad to the Learning tab's count, 900 ms, lux; none with reduced motion. */
function flyLesson(taskId) {
  if (typeof document === 'undefined' || typeof document.body?.animate !== 'function' || reducedMotion() || !taskId) {
    return
  }

  const pad = document.querySelector(`.roko-node[data-node="${text(taskId).replace(/["\\]/g, '')}"]`)
  const tab = document.querySelector('.rk-tab[data-tab="learning"]')

  if (!pad || !tab) {
    return
  }

  const from = pad.getBoundingClientRect()
  const to = tab.getBoundingClientRect()

  if (!from.width || !to.width) {
    return
  }

  const glyph = document.createElement('span')

  glyph.textContent = '◇'
  glyph.setAttribute('aria-hidden', 'true')
  glyph.style.cssText = `position:fixed;left:${from.left + from.width / 2 - 6}px;top:${from.top + from.height / 2 - 8}px;z-index:9999;pointer-events:none;font:700 14px/1 ui-monospace,monospace;color:${getComputedStyle(tab).getPropertyValue('--rk-learn') || '#ab9fff'};text-shadow:0 0 8px currentColor`
  document.body.appendChild(glyph)

  const dx = to.left + to.width - 18 - (from.left + from.width / 2)
  const dy = to.top + to.height / 2 - (from.top + from.height / 2)
  const flight = glyph.animate(
    [
      { opacity: 0, transform: 'translate(0,0) scale(.6)' },
      { offset: 0.15, opacity: 1, transform: 'translate(0,-12px) scale(1.2)' },
      { opacity: 0.9, transform: `translate(${dx}px,${dy}px) scale(.8)` }
    ],
    { duration: 900, easing: 'cubic-bezier(.22,1,.36,1)' }
  )

  flight.onfinish = () => glyph.remove()
  setTimeout(() => glyph.remove(), 1_400)
}

/** A card from REST or the socket: its loop events join the live state. */
function absorbCard(run) {
  if (isRecord(run) && validId(run.run_id)) {
    mergeLoops(run.run_id, list(run.loops), false)
  }

  return run
}

/** One `live` item: what an agent is doing this second. */
function pushLive(frame) {
  const runId = text(frame.run_id)

  if (!validId(runId)) {
    return
  }

  const kind = text(frame.kind)
  const words = kind === 'text' || kind === 'reasoning'
  const item = {
    attempt: num(frame.attempt),
    kind,
    target: clip(frame.target, 200),
    task_id: text(frame.task_id) || null,
    text: text(frame.text).slice(0, 400),
    tool: clip(frame.tool, 60),
    ts: num(frame.ts) ?? Date.now(),
    // A check's output, a line at a time (0.6.0 `kind: "check"`); `tail` carries the lines before it.
    gate: clip(frame.gate, 80),
    line: kind === 'check' ? text(frame.line).slice(0, 300) : '',
    tail: kind === 'check' ? list(frame.tail).map(l => text(l).slice(0, 300)).slice(-12) : null,
    // stdout, stderr, or 'roko': roko's own note that it skipped lines of a chatty check (gap-f45a6d).
    stream: kind === 'check' ? text(frame.stream) || null : null
  }
  if (kind === 'check' && item.task_id && (item.line || item.tail?.length)) {
    absorbCheck(runId, item)
  }

  const a = liveAtom(runId)
  const cur = a.get()
  const prev = item.task_id ? cur.byTask[item.task_id] : null
  // Words stream a token at a time. The relay sends the tail of what the task's agent has said since
  // its last tool call (`said`); without it, keep that tail here.
  const stretch = words ? `${item.attempt}:${kind}` : kind === 'tool' ? '' : (prev?.stretch ?? '')
  const own = words && prev?.stretch === stretch ? (prev?.said ?? '') : ''
  const said = words ? (typeof frame.said === 'string' ? frame.said : `${own}${item.text}`).slice(-400) : kind === 'tool' ? '' : (prev?.said ?? '')
  let items = cur.items
  let last = items.length - 1

  while (last >= 0 && items[last].task_id !== item.task_id) {
    last -= 1
  }

  // One entry per stretch of words, updated in place: a frame that continues the task's newest entry
  // replaces it, so the ticker holds still while the words grow.
  const continues = words && last >= 0 && items[last].kind === kind && items[last].stretch === stretch
  const entry = { ...item, said, since: continues ? items[last].since : item.ts, stretch }

  if (kind !== 'beat') {
    items = continues ? items.map((old, i) => (i === last ? entry : old)) : [...items, entry].slice(-120)
  }

  a.set({
    ...cur,
    at: Date.now(),
    byTask: item.task_id ? { ...cur.byTask, [item.task_id]: entry } : cur.byTask,
    items,
    // When each tool call came, for the instrument's scope (the last 240).
    tools: kind === 'tool' ? [...(cur.tools ?? []), item.ts].slice(-240) : (cur.tools ?? [])
  })

  if (kind !== 'beat') {
    blip({ channel: kind === 'result' ? 'ink' : 'agent', ring: 'L0', runId, ts: item.ts })
  }

  if (kind === 'tool') {
    play('tick')
  }
}

/** Timeline lines pushed by the socket: merged into the run's activity, and heard. */
function pushLines(runId, lines) {
  if (!validId(runId) || !lines.length) {
    return
  }

  const cached = eventCache.get(runId) ?? { cursor: null, events: [] }
  const events = mergeEvents(cached.events, lines, cached.keep)

  if (events === cached.events) {
    return
  }

  cacheEvents(runId, { ...cached, events })
  lines.filter(isRecord).forEach(line => {
    const type = text(line.type)

    if (type === 'gate_result') {
      blip({ channel: line.passed === true ? 'pass' : 'fail', ring: 'L1', runId, ts: num(line.ts_millis) ?? Date.now() })
      play(line.passed === true ? 'check' : 'fail')

      if (line.passed === false) {
        markLook('wary', 6_000)
      }
    } else if (type === 'task_completed') {
      const passed = PASSED.has(text(line.outcome))

      blip({ channel: passed ? 'pass' : 'fail', ring: 'L2', runId, ts: num(line.ts_millis) ?? Date.now() })

      if (passed) {
        play('task', false, { rung: rungPlace(runId, line.task_id) })
      }
    } else if (type === 'agent_spawned' || type === 'task_started') {
      blip({ channel: 'agent', ring: type === 'task_started' ? 'L2' : 'L1', runId, ts: num(line.ts_millis) ?? Date.now() })
    }
  })
}

function onFrame(frame) {
  if (!isRecord(frame)) {
    return
  }

  const prev = $live.get()

  $live.set({ hub: text(frame.hub) || prev.hub, lastAt: Date.now(), state: 'open' })

  switch (frame.type) {
    case 'hello':
    case 'overview':
      if (isRecord(frame.overview) && frame.overview.ok === true) {
        takeOverview(frame.overview)
      }

      break
    case 'serve':
      applyServe(frame.serve)
      break
    case 'run':
      if (isRecord(frame.run) && validId(frame.run.run_id)) {
        queryClient.setQueryData(KEYS.run(frame.run.run_id), patchOverviewRow(absorbCard(frame.run)))
      }

      break
    case 'lines':
      pushLines(text(frame.run_id), list(frame.lines))
      break
    case 'live':
      pushLive(frame)
      break
    case 'loop':
      mergeLoops(text(frame.run_id), [frame], true)
      break
    default:
      break
  }
}

/**
 * An overview the socket pushed, for the project it is about (0.7 `project`): kept when this window shows that
 * project. A 0.6 overview names none, and is this window's.
 */
function takeOverview(overview) {
  const about = isRecord(overview.project) ? overview.project : null
  const shown = $project.get()

  if (!about || (shown ? text(about.path) === shown : about.default === true)) {
    queryClient.setQueryData(projectKey(KEYS.overview, shown), overview)
  }
}

// -- the socket ----------------------------------------------------------------

const socketState = { dispose: null, path: null }
/** Runs a page follows that Hermes did not start (`?runs=`, at most 8). */
const followed = new Set()

function livePath() {
  const runs = [...followed].slice(-8)
  // 0.7: whose overview the socket's hello and overview frames carry (round-1 amendment 5).
  const query = [runs.length ? `runs=${runs.map(enc).join(',')}` : '', $project.get() ? `project=${enc($project.get())}` : ''].filter(Boolean).join('&')

  return query ? `/live?${query}` : '/live'
}

function openLive() {
  const socket = doors?.socket

  if (typeof socket !== 'function') {
    return
  }

  const path = livePath()

  if (socketState.dispose && socketState.path === path) {
    return
  }

  closeLive()
  socketState.path = path
  $live.set({ ...$live.get(), state: 'connecting' })

  try {
    socketState.dispose = socket(path, frame => safe('a live frame', () => onFrame(frame)))
  } catch (error) {
    console.error('[roko] could not open the live socket', error)
    socketState.dispose = null
    $live.set({ hub: null, lastAt: 0, state: 'off' })
  }
}

function closeLive() {
  const dispose = socketState.dispose

  socketState.dispose = null
  socketState.path = null

  try {
    dispose?.()
  } catch {
    // Already closed.
  }

  $live.set({ hub: null, lastAt: 0, state: 'off' })
}

/** A page shows a live run Hermes did not start: follow it on the socket while it runs. */
function useFollow(run, overviewRuns) {
  const runId = text(run?.run_id)
  const active = isActiveRun(run)
  const known = list(overviewRuns).some(row => isRecord(row) && row.run_id === runId)

  useEffect(() => {
    if (!validId(runId) || !active || known || !socketState.dispose) {
      return undefined
    }

    followed.add(runId)
    openLive()

    return () => {
      followed.delete(runId)
    }
  }, [runId, active, known])
}

/** The socket goes quiet without closing (a sleeping laptop): mark it stale so polling speeds up again. */
function checkLive() {
  const s = $live.get()

  if (s.state === 'open' && Date.now() - s.lastAt >= LIVE_STALE_MS) {
    $live.set({ ...s, state: 'stale' })
  }
}

// -- the loops route ---------------------------------------------------------

// --- Navigation: the selection lives in location.hash (#/roko#run=<id>); the
// app's hash router keeps routing on /roko. hermes://open/roko?run=<id> lands
// as #/roko?run=<id>, which reads the same way. `&view=changes` opens a run on
// its changes (the chat card's "Review changes").

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

  // Runs with no run named is the home (0.9), and Plans with no plan named: an earlier pick does not stay open.
  if (!view.run && (tab === 'runs' || tab === 'waiting')) {
    $run.set(null)
  }

  if (!view.plan && (tab === 'plans' || tab === 'build')) {
    $plan.set(null)
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

  // A typed request stays as a draft; a plan to run (and a rerun's cap), a spec and a title only when this caller names one.
  $composer.set({ ...current, cap: null, plan: null, resume: false, spec: null, title: null, ...draft, open: true })
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

// --- Small UI pieces

function Dot({ tone, label, pulse }) {
  return h('span', {
    'aria-label': label,
    className: 'roko-dot',
    'data-pulse': pulse ? 'true' : undefined,
    'data-tone': tone,
    role: label ? 'img' : undefined
  })
}


/**
 * A run's state in a word: a pill in lists and cards, or with `stamp` the system declaring it, ⌈PASSED⌋ (spec v3
 * §4.7), in the run's head.
 */
function StatePill({ state, word, tone, glyph, run, stamp }) {
  const info = run ? runInfo(run) : stateInfo(state)
  const stop = run && capStopped(run)

  return h(
    'span',
    {
      className: stamp ? 'roko-pill rk-stamp' : 'roko-pill',
      'data-stamp': stamp ? 'true' : undefined,
      'data-state': text(state ?? run?.state),
      'data-stop': stop ? 'cap' : undefined,
      'data-tone': tone || info.tone,
      title: stop ? capWords(run) : undefined
    },
    h('span', { 'aria-hidden': 'true', className: 'roko-pill-glyph' }, glyph || info.glyph),
    ' ',
    // A plan writing's stamp is its row's word (R1l).
    word || (stamp ? (run?.kind === 'plan_generate' ? endWord(run.state, run.kind) : (info.stamp ?? info.word)) : info.word)
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
        'aria-label': `${text(gate.gate)}: ${gate.passed === true ? 'passed' : gate.passed === false ? 'did not pass' : gate.running ? 'running' : 'waiting'}${gate.superseded ? ', an earlier attempt' : ''}`,
        className: 'roko-pip',
        'data-state': gate.passed === true ? 'pass' : gate.passed === false ? 'fail' : gate.running ? 'run' : 'wait',
        'data-superseded': gate.superseded ? 'true' : undefined,
        key: `${text(gate.gate)}:${index}`,
        role: 'img',
        title: text(gate.gate)
      })
    ),
    gates.length > max ? h('span', { className: 'roko-pips-more' }, `+${gates.length - max}`) : null
  )
}


function ModelChip({ model, provider }) {
  if (!text(model)) {
    return null
  }

  const chip = h('span', { className: 'roko-model' }, h(Codicon, { name: 'hubot', size: '0.7rem' }), clip(model, 28))

  return provider ? h(Tip, { label: `${text(model)} via ${text(provider)}` }, chip) : chip
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

// --- The control surface: dot-matrix displays, wells, LEDs, keys, a knob, a
// slide switch, the agent ticker, the scope, and the five-loop dial

/**
 * A 5×7 dot-matrix face: each glyph is seven rows of five bits (bit 4 is the left column), as hex pairs.
 * Lowercase prints as uppercase; anything else prints as a middle dot.
 */
const FONT = {
  ' ': '00000000000000',
  '!': '04040404040004',
  '"': '0A0A0000000000',
  '#': '0A0A1F0A1F0A0A',
  $: '040F140E051E04',
  '%': '18190204081303',
  '&': '0C12140815120D',
  "'": '0C040800000000',
  '(': '02040808080402',
  ')': '08040202020408',
  '*': '0004150E150400',
  '+': '0004041F040400',
  ',': '000000000C0408',
  '-': '0000001F000000',
  '.': '00000000000C0C',
  '/': '00010204081000',
  0: '0E11131519110E',
  1: '040C040404040E',
  2: '0E11010204081F',
  3: '1F02040201110E',
  4: '02060A121F0202',
  5: '1F101E0101110E',
  6: '0608101E11110E',
  7: '1F010204080808',
  8: '0E11110E11110E',
  9: '0E11110F01020C',
  ':': '000C0C000C0C00',
  '<': '02040810080402',
  '=': '00001F001F0000',
  '>': '08040201020408',
  '?': '0E110102040004',
  '@': '0E11171517100F',
  A: '0E1111111F1111',
  B: '1E11111E11111E',
  C: '0E11101010110E',
  D: '1C12111111121C',
  E: '1F10101E10101F',
  F: '1F10101E101010',
  G: '0E11101711110F',
  H: '1111111F111111',
  I: '0E04040404040E',
  J: '0702020202120C',
  K: '11121418141211',
  L: '1010101010101F',
  M: '111B1515111111',
  N: '11111915131111',
  O: '0E11111111110E',
  P: '1E11111E101010',
  Q: '0E11111115120D',
  R: '1E11111E141211',
  S: '0F10100E01011E',
  T: '1F040404040404',
  U: '1111111111110E',
  V: '11111111110A04',
  W: '1111111515150A',
  X: '11110A040A1111',
  Y: '1111110A040404',
  Z: '1F01020408101F',
  '[': '0E08080808080E',
  ']': '0E02020202020E',
  _: '0000000000001F',
  '|': '04040404040404',
  '~': '00000815020000',
  '·': '00000004000000',
  '×': '00110A040A1100',
  '—': '0000001F000000',
  '−': '0000001F000000',
  '→': '0004021F020400'
}
/** Punctuation takes only the columns it lights; digits and letters keep five (numbers never jitter). */
const NARROW = new Set([' ', '!', "'", '(', ')', ',', '.', ':', '[', ']', '|', '·', '"'])
/** Dot and pitch in px for each size of the face (spec v3 §3.4). */
const DOT_SIZES = {
  XS: { dot: 1.15, pitch: 1.6 },
  S: { dot: 1.55, pitch: 2.15 },
  M: { dot: 2.15, pitch: 2.95 },
  L: { dot: 2.9, pitch: 3.85 },
  XL: { dot: 3.9, pitch: 5.1 },
  XXL: { dot: 5.2, pitch: 6.6 }
}
const glyphs = new Map()

function glyph(ch) {
  const key = FONT[ch] ? ch : FONT[ch.toUpperCase()] ? ch.toUpperCase() : '·'
  let g = glyphs.get(key)

  if (!g) {
    const rows = Array.from({ length: 7 }, (_, i) => Number.parseInt(FONT[key].slice(i * 2, i * 2 + 2), 16))
    let lo = 5
    let hi = -1

    rows.forEach(row => {
      for (let c = 0; c < 5; c += 1) {
        if ((row >> (4 - c)) & 1) {
          lo = Math.min(lo, c)
          hi = Math.max(hi, c)
        }
      }
    })

    const narrow = NARROW.has(key)

    g = narrow ? (hi < 0 ? { rows, w: 2, x0: 0 } : { rows, w: hi - lo + 1, x0: lo }) : { rows, w: 5, x0: 0 }
    glyphs.set(key, g)
  }

  return g
}

/** Lit dots as one path of zero-length strokes: with round caps each becomes a dot. */
function glyphPath(g, col, pitch, dot) {
  let d = ''

  g.rows.forEach((row, r) => {
    for (let c = 0; c < g.w; c += 1) {
      if ((row >> (4 - (g.x0 + c))) & 1) {
        d += `M${((col + c) * pitch + dot / 2).toFixed(2)} ${(r * pitch + dot / 2).toFixed(2)}h0`
      }
    }
  })

  return d
}

const gridPaths = new Map()

/** The unlit glass: a dim dot at every cell. */
function gridPath(cols, pitch, dot) {
  const key = `${cols}:${pitch}:${dot}`
  let d = gridPaths.get(key)

  if (d === undefined) {
    d = ''

    for (let r = 0; r < 7; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        d += `M${(c * pitch + dot / 2).toFixed(2)} ${(r * pitch + dot / 2).toFixed(2)}h0`
      }
    }

    gridPaths.set(key, d)

    if (gridPaths.size > 200) {
      gridPaths.delete(gridPaths.keys().next().value)
    }
  }

  return d
}

/**
 * Text on the display: dot-matrix in a channel tone. A glyph that changed since the last render rolls in;
 * the first render is still. `label` is what assistive tech reads (the plain value); `hidden` drops it when
 * something beside it says the same.
 */
const Dots = memo(function Dots({ value, size = 'M', tone, label, hidden, grid = true, pad = 0, className, sweep }) {
  const str = text(value).toUpperCase().padStart(pad)
  const prev = useRef(null)
  const { dot, pitch } = DOT_SIZES[size] ?? DOT_SIZES.M
  let col = 0
  const laid = [...str].map(ch => {
    const g = glyph(ch)
    const at = col

    col += g.w + 1

    return { at, ch, g }
  })
  const cols = Math.max(1, col - 1)
  const width = cols * pitch - (pitch - dot)
  const height = 7 * pitch - (pitch - dot)
  const before = prev.current

  useEffect(() => {
    prev.current = str
  }, [str])

  return h(
    'svg',
    {
      'aria-hidden': hidden ? 'true' : undefined,
      'aria-label': hidden ? undefined : (label ?? text(value)),
      'data-value': text(value) || undefined,
      className: cx('rk-dots', className),
      'data-size': size,
      // A light that runs along the word while something is under way (0.7: a serve starting).
      'data-sweep': sweep ? 'true' : undefined,
      'data-tone': tone,
      height: height.toFixed(1),
      role: hidden ? undefined : 'img',
      viewBox: `0 0 ${width.toFixed(2)} ${height.toFixed(2)}`,
      width: width.toFixed(1)
    },
    grid ? h('path', { className: 'rk-dots-off', d: gridPath(cols, pitch, dot), strokeWidth: dot }) : null,
    laid.map((item, i) =>
      h('path', {
        className: 'rk-dots-on',
        d: glyphPath(item.g, item.at, pitch, dot),
        'data-roll': before !== null && before[i] !== item.ch ? 'true' : undefined,
        key: `${i}:${item.ch}`,
        strokeWidth: dot,
        style: sweep ? { '--rk-i': i } : undefined
      })
    )
  )
})

/** The black display glass: the one material that is the same in every theme. */
function Well({ children, className, tone, testId, label, role, live }) {
  return h(
    'div',
    { 'aria-label': label, 'aria-live': live, className: cx('rk-well', className), 'data-testid': testId, 'data-tone': tone, role },
    ...(Array.isArray(children) ? children : [children])
  )
}

/**
 * A pane of the glass (spec v3 §3.2): void black with depth, a static scanline, and with `grid` a crosshair every
 * 32px. Live data lives on it; the body around it follows the host.
 */
function Glass({ children, className, grid, testId, label, role, as = 'div', ...rest }) {
  return h(
    as,
    { 'aria-label': label, className: cx('rk-glass', className), 'data-grid': grid ? 'true' : undefined, 'data-testid': testId, role, ...rest },
    ...(Array.isArray(children) ? children : [children])
  )
}

/** The system declaring a state, in brackets: ⌈RUNNING⌋ (spec v3 §4.7). Words first, colour second. */
function Stamp({ tone, children, testId, title }) {
  return h('span', { className: 'rk-stamp', 'data-testid': testId, 'data-tone': tone, title }, children)
}

/** A look the mark's eyes hold for a beat after an event: wary after a failed check, a star after a pass or a lesson. */
const $markLook = atom({ mood: null, until: 0 })
/** When roko last did anything this window saw (a blip); 0 before the first. After 10 quiet minutes the mark sleeps. */
let markActivity = 0
function markLook(mood, ms) {
  $markLook.set({ mood, until: Date.now() + ms })
}

/** A numbered module label: `01 TASKS`. */
/** A module's label (design system §3.2): its words, a note beside them, something on the right. */
function ModLabel({ children, right, note }) {
  return h(
    'div',
    { className: 'rk-mod' },
    h('span', { className: 'rk-mod-label' }, children),
    note ? h('span', { className: 'rk-mod-note' }, note) : null,
    right ? h('span', { className: 'rk-mod-right' }, right) : null
  )
}

/** A status light: solid when done, slow blink while working, fast blink when it needs the person. */
function LED({ tone = 'off', blink, label, size }) {
  return h('span', {
    'aria-label': label,
    className: 'rk-led',
    'data-blink': blink || undefined,
    'data-size': size,
    'data-tone': tone,
    role: label ? 'img' : undefined
  })
}

/** A key: a 1px body with a travel shadow, pressed it drops 1px. `kbd` is engraved, and not part of its name. */
function Key({ children, kbd, tone, size, className, testId, ...rest }) {
  const kids = Array.isArray(children) ? children : [children]

  return h(
    'button',
    { className: cx('rk-key', className), 'data-size': size, 'data-testid': testId, 'data-tone': tone, type: 'button', ...rest },
    ...kids,
    kbd ? h('span', { 'aria-hidden': 'true', className: 'rk-key-kbd' }, kbd) : null
  )
}

/** A two-position slide switch with both labels visible: `run it ◀▶ plan first`. */
function Slide({ value, options, onChange, label, disabled }) {
  const index = Math.max(0, options.findIndex(o => o.id === value))
  const pick = i => !disabled && onChange(options[i].id)

  return h(
    'div',
    { 'aria-label': label, className: 'rk-slide', 'data-pos': String(index), role: 'group' },
    h('button', { 'aria-pressed': index === 0 ? 'true' : 'false', className: 'rk-slide-label', disabled, onClick: () => pick(0), type: 'button' }, options[0].label),
    h(
      'span',
      { 'aria-hidden': 'true', className: 'rk-slide-track', onClick: () => pick(index === 0 ? 1 : 0) },
      h('span', { className: 'rk-slide-thumb' })
    ),
    h('button', { 'aria-pressed': index === 1 ? 'true' : 'false', className: 'rk-slide-label', disabled, onClick: () => pick(1), type: 'button' }, options[1].label)
  )
}

/** A run that is going and waits on the person (a sign-off or a held call): its colour is orange, "you". */
function waitsOnYou(run) {
  return isActiveRun(run) && list(run?.waiting).some(isRecord)
}

/**
 * What the run's agents are doing this second: the newest tool step or words from the socket, else the
 * card's last step, else what each running task is on. Older moves trail off to the left.
 */
function tickerItems(run, live) {
  const active = isActiveRun(run)
  const items = []
  const cards = new Map(list(run?.tasks).filter(isRecord).map(t => [text(t.task_id), t]))
  const titleOf = id => text(cards.get(text(id))?.task_id) || text(id)
  // Only what is happening now: a try's steps can arrive after the next try began, or after its task ended (a
  // relay catching up, a replay), and an older try's words are not the running try's.
  const newest = new Map()

  live.items.forEach(item => {
    if (item.task_id && item.attempt !== null) {
      newest.set(item.task_id, Math.max(newest.get(item.task_id) ?? item.attempt, item.attempt))
    }
  })
  // A running task's latest try on the card (roko's attempt number, as the socket's): once roko routed a new try,
  // the last try's steps are history, before the new one makes its first move.
  cards.forEach((card, id) => {
    const at = text(card.outcome) === 'running' ? num(list(card.climb).filter(isRecord).at(-1)?.attempt) : null

    if (at !== null && newest.has(id)) {
      newest.set(id, Math.max(newest.get(id), at))
    }
  })

  const now = item => {
    const card = cards.get(text(item.task_id))

    if (card && ['passed', 'failed', 'stopped', 'unverified', 'blocked'].includes(nodeState(card.outcome))) {
      return false
    }

    return item.attempt === null || !newest.has(item.task_id) || item.attempt >= newest.get(item.task_id)
  }

  if (active) {
    // A running check: one item a task, in the glass's words ("building 66% · Oversampler.cpp").
    const checks = new Map()

    live.items.forEach((item, i) => {
      if (item.kind === 'check' && item.task_id && now(item)) {
        checks.set(item.task_id, { i, item })
      }
    })

    live.items
      .map((item, i) => [item, i])
      .filter(([item, i]) => ((item.kind === 'tool' || item.kind === 'text' || item.kind === 'reasoning') && now(item)) || (item.kind === 'check' && checks.get(item.task_id)?.i === i))
      .slice(-6)
      .forEach(([item, i]) => {
        if (item.kind === 'check') {
          const read = readCheck(checkLinesOf(run?.run_id, item.task_id, item.gate, item.attempt, item.tail ?? []))

          items.push({ attempt: item.attempt, channel: read.error ? 'fail' : undefined, kind: 'check', key: `c${item.task_id}:${item.gate}:${item.attempt ?? ''}`, since: item.ts, task: titleOf(item.task_id), words: checkWords(read, item.gate) })

          return
        }

        items.push({
          attempt: item.attempt,
          kind: item.kind,
          key: item.kind === 'tool' ? `l${item.ts}:${i}` : `w${item.task_id}:${item.since}`,
          since: item.kind === 'tool' ? item.ts : item.since,
          task: titleOf(item.task_id),
          words: item.kind === 'tool' ? [item.tool, item.target].filter(Boolean).join(' ') : item.said || item.text
        })
      })

    if (!items.length) {
      list(run?.tasks)
        .filter(isRecord)
        .filter(task => text(task.outcome) === 'running')
        .forEach(task => {
          const steps = list(task.steps).filter(isRecord)
          const tail = isRecord(task.check_tail) && task.check_tail.passed === null ? task.check_tail : null

          // A check it runs now, read from the card's tail (a page opened mid-check).
          if (task.step === 'check' && tail && list(tail.lines).length) {
            const read = readCheck(checkLinesOf(run?.run_id, task.task_id, tail.gate, num(tail.attempt), list(tail.lines).map(text)))

            items.push({ channel: read.error ? 'fail' : undefined, kind: 'check', key: `c${text(task.task_id)}:${text(tail.gate)}`, since: parseTime(task.step_since), task: text(task.task_id), words: checkWords(read, tail.gate) })

            return
          }

          steps.slice(-3).forEach((step, i) =>
            items.push({ kind: 'tool', key: `s${text(task.task_id)}:${text(step.ts)}:${i}`, since: parseTime(step.ts), task: text(task.task_id), words: [text(step.tool), text(step.target)].filter(Boolean).join(' ') })
          )

          if (text(task.live_text)) {
            items.push({ kind: 'text', key: `t${text(task.task_id)}`, task: text(task.task_id), words: text(task.live_text) })
          } else if (!steps.length) {
            const node = taskNode(task, null, run)

            items.push({ channel: node.waiting ? 'you' : undefined, kind: 'step', key: `n${node.id}:${node.step}`, task: node.taskId, words: stepWords(node) || 'working' })
          }
        })
    }
  }

  return items.slice(-4)
}

/**
 * What roko is checking while a run goes (the card's `checking`, from roko's check events): a task's check, the
 * plan's whole-plan check, or the delivery's check of the workspace. `{text, since}` or null.
 */
function checkingOf(run) {
  const c = isRecord(run?.checking) ? run.checking : null
  const what = c ? text(c.label) || text(c.name) || text(c.what) : ''

  if (!c || !what || !isActiveRun(run)) {
    return null
  }

  const scope = text(c.scope)
  const packages = list(c.packages).map(text).filter(Boolean)
  const where =
    scope === 'workspace'
      ? ' the workspace'
      : scope === 'plan'
        ? ' the plan'
        : scope === 'packages' && packages.length
          ? ` ${clip(packages.join(', '), 40)}`
          : scope === 'task' && text(c.task_id)
            ? ` ${clip(text(c.task_id), 14)}`
            : ''
  const step = num(c.step) !== null && (num(c.steps) ?? 0) > 1 ? ` (${num(c.step)} of ${num(c.steps)})` : ''
  const since = parseTime(c.since) ?? parseTime(sinceIso(Date.now(), c.elapsed_s))

  // The plugin's guess for an older roko (every task ended, the run still goes): roko is finishing the plan.
  const words = text(c.source) === 'plugin' ? `finishing: ${clip(what, 60)}` : `checking${where}: ${clip(what, 60)}${step}`

  return { since: since === null ? null : new Date(since).toISOString(), task: scope === 'task', text: words }
}

/**
 * The machine's pulse: a trace on the glass that kicks on every event of the run (a tool step, a check, a
 * pass) and settles back to a flat line. 30 fps through the app's budgeted loop, asleep when flat.
 */
function Scope({ runId, width = 120, height = 36 }) {
  const trace = useRef(null)
  const [tone, setTone] = useState('agent')

  useEffect(() => {
    const el = trace.current
    const flat = `M0 ${height / 2}H${width}`

    if (!el) {
      return undefined
    }

    el.setAttribute('d', flat)

    if (reducedMotion()) {
      return onBlip(b => {
        if (!runId || !b.runId || b.runId === runId) {
          setTone(b.channel)
        }
      })
    }

    const n = 60
    const samples = new Float32Array(n)
    let energy = 0
    let phase = 0
    let last = 0
    let loop = null

    const draw = now => {
      const dt = last ? Math.min(120, now - last) : 16

      last = now
      energy *= Math.exp(-dt / 480)
      phase += dt * 0.05

      const shift = Math.max(1, Math.round(dt / 18))

      samples.copyWithin(0, shift)

      for (let i = n - shift; i < n; i += 1) {
        samples[i] = energy * Math.sin(phase + i * 1.1) * (0.7 + 0.3 * Math.sin(phase * 0.37 + i * 0.5))
      }

      let d = ''

      for (let i = 0; i < n; i += 1) {
        d += `${i ? 'L' : 'M'}${((i / (n - 1)) * width).toFixed(1)} ${(height / 2 - samples[i] * height * 0.42).toFixed(1)}`
      }

      el.setAttribute('d', d)
    }

    try {
      loop = createBudgetedLoop(draw, {
        fps: 30,
        idleWhen: () => energy < 0.003 && samples.every(v => Math.abs(v) < 0.003)
      })
    } catch {
      loop = null
    }

    const off = onBlip(b => {
      if (runId && b.runId && b.runId !== runId) {
        return
      }

      energy = Math.min(1.15, energy + (b.channel === 'agent' ? 0.32 : 0.75))
      setTone(b.channel)
      loop?.wake()
    })

    return () => {
      off()
      loop?.dispose()
    }
  }, [runId, width, height])

  return h(
    Well,
    { className: 'rk-scope', tone },
    h(
      'svg',
      { 'aria-hidden': 'true', className: 'rk-scope-svg', height, preserveAspectRatio: 'none', viewBox: `0 0 ${width} ${height}`, width },
      [0.25, 0.5, 0.75].map(f => h('line', { className: 'rk-scope-grid', key: `x${f}`, x1: width * f, x2: width * f, y1: 0, y2: height })),
      h('line', { className: 'rk-scope-grid rk-scope-axis', x1: 0, x2: width, y1: height / 2, y2: height / 2 }),
      h('path', { className: 'rk-scope-trace', ref: trace })
    )
  )
}

// --- The sequencer: the run's tasks as pads in wave columns, their dependencies,
// a playhead, and the inspector for one task

// Four waves fit the sequencer beside the stream at 1440 wide (pads down to 104 px, as mockup 01's); more scroll.
const GRAPH = { gapMax: 56, gapMin: 14, gapY: 12, maxW: 240, minW: 128, nodeH: 92, padBottom: 10, padTop: 34, padX: 10 }

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
    : // `superseded`: the verdict of an earlier attempt, which roko retried (0.5.0); shown dim.
      list(task.gates).filter(isRecord).map(g => ({ gate: text(g.gate), passed: g.passed === true, superseded: g.superseded === true }))

  if (task.step === 'check' && text(task.step_detail) && !gates.some(g => g.gate === text(task.step_detail) && g.passed !== null)) {
    gates.push({ gate: text(task.step_detail), passed: null, running: true })
  }

  return gates
}

/** A card task as a graph node, optionally overridden by a replay's state at some moment. */
function taskNode(task, replay, run) {
  const hold = isRecord(task.hold) ? task.hold : null
  const outcome = text(task.outcome) || 'pending'
  // A run that ended has no live task: one still marked running stopped with the run (roko's restart, a cancel).
  // A run only last seen running keeps its tasks as roko last said, without a clock.
  const ended = hasEnded(run)
  const still = Boolean(run) && !isActiveRun(run)
  const tries = list(task.climb).filter(isRecord)
  const last = tries[tries.length - 1]
  const standing = text(isRecord(task.lives) ? task.lives.rung : '')
  // An ended task's pad says where it ran last, as the Ladder does, even when a failover moved it off its rung (P-29).
  const done = ended || !['running', 'pending', ''].includes(text(task.outcome))
  const movedFrom = done && last?.reason === 'failover' && standing && text(last.rung) && text(last.rung) !== standing ? standing : ''
  const base = {
    attempts: num(task.attempts) ?? 0,
    // Where the glass finds a running check's lines; the card's tail stands in for a page opened mid-check.
    runId: text(run?.run_id),
    tryNo: num(tries[tries.length - 1]?.attempt),
    checkTail: isRecord(task.check_tail) && task.check_tail.passed === null ? list(task.check_tail.lines).map(l => text(l).slice(0, 300)) : [],
    blockedBy: text(task.blocked_by),
    // Its tries on the model ladder (0.6.0 `climb`): the rung it stands on, whether it climbed, its lives (✕✕●).
    climbed: tries.some(t => t.reason === 'climb'),
    lives: tries.map(tryMark),
    rung: (done ? text(last?.rung) : '') || standing || text(last?.rung),
    movedFrom,
    movedWhy: movedFrom && isRecord(last.failover) ? clip(last.failover.why, 60) : '',
    // The lessons roko put in its latest try's prompt (0.6.0 `lesson_ids`, from roko's prompt_assembled).
    lessons: new Set(list(tries[tries.length - 1]?.lesson_ids).map(text).filter(Boolean)).size,
    cost: num(task.cost_usd),
    durationMs: num(task.duration_ms),
    gates: taskGates(task),
    id: nodeIdOf(task),
    model: text(task.model),
    outcome: ended && outcome === 'running' ? (run.state === 'interrupted' || run.state === 'cancelled' ? run.state : 'stopped') : outcome,
    provider: text(task.provider),
    step: ended ? null : text(task.step) || null,
    stepDetail: ended ? null : text(task.step_detail) || null,
    stepSince: still ? null : text(task.step_since) || null,
    taskId: text(task.task_id),
    title: taskTitle(task, run),
    waiting:
      !still &&
      (task.step === 'waiting' ||
        hold?.state === 'waiting' ||
        list(run?.waiting).some(item => isRecord(item) && text(item.task_id) === text(task.task_id)))
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
      stepSince: null,
      waiting: false
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
    return node.attempts > 1 ? `try ${node.attempts} · ${node.stepDetail || node.model || 'agent'}` : `agent · ${node.stepDetail || node.model || 'working'}`
  }

  if (node.step === 'agent done') {
    return 'agent finished · checking next'
  }

  if (node.step === 'starting') {
    return 'starting'
  }

  return node.state === 'running' ? 'working' : ''
}

/** A node's state as a channel: blue working, green passed, orange needs you, red failed, outline pending. */
function nodeChannel(node) {
  if (node.state === 'running') {
    return node.waiting ? 'you' : 'agent'
  }

  return node.state === 'passed' ? 'pass' : node.state === 'failed' ? 'fail' : node.state === 'blocked' || node.state === 'unverified' ? 'you' : 'off'
}

function layoutGraph(waves, width) {
  const cols = Math.max(1, waves.length)
  const avail = Math.max(240, width - GRAPH.padX * 2)
  // The gaps give way before the pads do: pads at their narrowest, the gaps shrink (to gapMin) so the waves still fit.
  const wide = cols > 1 ? clamp(avail * 0.05, GRAPH.gapMin, GRAPH.gapMax) : 0
  const gap = cols > 1 && (avail - wide * (cols - 1)) / cols < GRAPH.minW ? Math.max(GRAPH.gapMin, (avail - cols * GRAPH.minW) / (cols - 1)) : wide
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
    gap,
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

/**
 * How far a row gives way to fit its box (P-22): 0 as drawn, then a step more each time it overflows after layout,
 * up to `most`. A new `key` (another width, other content) starts from 0 again.
 */
function useGiveWay(most, key) {
  const ref = useRef(null)
  const [step, setStep] = useState({ key, n: 0 })
  const n = step.key === key ? step.n : 0

  useLayoutEffect(() => {
    const el = ref.current

    if (el && n < most && el.scrollWidth > el.clientWidth + 1) {
      setStep({ key, n: n + 1 })
    }
  }, [key, n, most])

  return [ref, n]
}

/** A pad's time without its seconds ("33m"), for a pad too narrow for "33m 23s". */
function padTime(ms) {
  return duration(ms).replace(/^(\d+m) \d+s$/, '$1')
}

/** A task's number on its pad (design system §4.7): "T3" is 03; any other id stays itself. */
function padNo(id) {
  const m = /^T(\d+)$/.exec(text(id))

  return m ? m[1].padStart(2, '0') : clip(text(id), 12)
}

/** A task as a pad (design system §4.7): its number and its light, its title, then its tries and its time. */
function GraphNode({ node, pos, selected, onSelect, planOnly, live }) {
  const info = outcomeInfo(node.outcome, node.attempts)
  const words = node.state === 'running' ? stepWords(node) : ''
  const label = [`${taskName(node.taskId)}: ${node.title}`, planOnly ? '' : info.word, planOnly ? '' : info.note, words].filter(Boolean).join(', ')
  const channel = planOnly ? 'off' : nodeChannel(node)
  const move = live && node.state === 'running' && !node.waiting ? live : null
  const before = useRef(node.state)
  const [flash, setFlash] = useState(false)
  // An ended pad's foot at the pad's width (P-22): its time drops its seconds, then its tries go; never the time.
  const [footRef, giveWay] = useGiveWay(2, [pos.w, node.state, node.durationMs, list(node.lives).join(''), list(node.gates).length, node.lessons].join('|'))
  const skipped = /skipped$/.test(text(node.outcome))
  // Its tries: the card's climb, else as many as roko counted (each failed but the last, which is its state).
  const lives = list(node.lives).length ? node.lives : node.attempts > 1 && node.state !== 'pending' ? [...Array(node.attempts - 1).fill('x'), node.state === 'running' ? 'r' : node.state === 'passed' ? 'p' : 'x'] : []

  // The completion moment: a pad that just passed (or failed) flashes its channel once.
  useEffect(() => {
    const was = before.current

    before.current = node.state

    if (was !== node.state && (node.state === 'passed' || node.state === 'failed') && !node.replay) {
      setFlash(true)

      const timer = setTimeout(() => setFlash(false), 700)

      return () => clearTimeout(timer)
    }

    return undefined
  }, [node.state])
  let foot

  if (planOnly) {
    foot = h(
      'span',
      { className: 'roko-node-foot' },
      h('span', { className: 'roko-node-meta' }, node.checks ? plural(node.checks, 'check') : 'no checks'),
      node.deps ? h('span', { className: 'roko-node-meta' }, `after ${node.deps.split(', ').map(padNo).join(', ')}`) : null,
      node.questions ? h('span', { className: 'rk-tag', 'data-channel': 'you', 'data-testid': `open-question-${node.id}` }, node.questions === 1 ? 'open question' : `${node.questions} open questions`) : null
    )
  } else if (node.state === 'running') {
    foot = h(
      'span',
      { className: 'roko-node-foot' },
      h(Lives, { lives }),
      // While its check runs, how far the check is; else what its agent does now.
      node.step === 'check' && !node.replay
        ? h(PadCheck, { node, otherwise: h('span', { className: 'roko-node-step' }, words) })
        : h('span', { className: 'roko-node-step', title: move ? [move.tool, move.target].filter(Boolean).join(' ') : undefined }, move && move.kind === 'tool' ? clip([move.tool, move.target].filter(Boolean).join(' '), 40) : words),
      h(PadLessons, { node }),
      node.replay ? null : h(StepClock, { since: node.stepSince })
    )
  } else if (node.state === 'blocked') {
    foot = h('span', { className: 'roko-node-foot' }, h('span', { className: 'roko-node-meta' }, node.blockedBy ? `blocked by ${padNo(node.blockedBy)}` : 'blocked'))
  } else if (node.state === 'pending') {
    foot = h('span', { className: 'roko-node-foot' }, h('span', { className: 'roko-node-meta' }, 'waiting'))
  } else if (skipped) {
    foot = h('span', { className: 'roko-node-foot' }, h('span', { className: 'roko-node-meta' }, '⊘ skipped'))
  } else {
    const took = num(node.durationMs) !== null ? duration(node.durationMs) : ''

    foot = h(
      'span',
      { className: 'roko-node-foot', ref: footRef },
      // Its tries when one did not pass (✕, a refused one ∿), else its checks. Too narrow, they go; never the time.
      giveWay > 1 ? null : lives.some(l => l === 'x' || l === 'i') || !list(node.gates).length ? h(Lives, { lives }) : h(GatePips, { gates: node.gates, max: 6 }),
      h(PadLessons, { node }),
      h('span', { className: 'roko-flex' }),
      took ? h('span', { className: 'roko-node-meta roko-node-time', title: giveWay ? took : undefined }, giveWay ? padTime(node.durationMs) : took) : null
    )
  }

  return h(
    'button',
    {
      'aria-label': label,
      'aria-pressed': selected ? 'true' : 'false',
      className: 'roko-node',
      'data-channel': channel,
      'data-flash': flash ? 'true' : undefined,
      'data-node': node.id,
      'data-selected': selected ? 'true' : 'false',
      'data-skipped': skipped ? 'true' : undefined,
      'data-state': planOnly ? 'plan' : node.state,
      'data-waiting': node.waiting && !planOnly ? 'true' : undefined,
      onClick: () => onSelect?.(node.id),
      style: { height: pos.h, left: pos.x, top: pos.y, width: pos.w },
      type: 'button'
    },
    h(
      'span',
      { className: 'roko-node-head' },
      h('span', { className: 'roko-node-id' }, padNo(node.taskId)),
      h('span', { className: 'roko-flex' }),
      planOnly ? null : h(LED, { blink: node.state === 'running' ? (node.waiting ? 'fast' : 'slow') : undefined, size: 's', tone: channel })
    ),
    h('span', { className: 'roko-node-top', title: node.title || node.taskId }, h('span', { className: 'roko-node-title' }, node.title || taskName(node.taskId))),
    foot
  )
}

/** A pad's running check: a build's bar and percent, or tests passed of all; `otherwise` when neither. */
function PadCheck({ node, otherwise = null }) {
  const lines = checkLinesOf(node.runId, node.taskId, node.stepDetail, node.tryNo, node.checkTail)
  const read = useMemo(() => readCheck(lines), [lines])

  if (read.tests?.total) {
    return h('span', { className: 'rk-padcheck', 'data-failed': read.tests.failed ? 'true' : undefined, 'data-testid': `pad-check-${node.taskId}`, title: checkWords(read, node.stepDetail) }, `${read.tests.passed}/${read.tests.total}`)
  }

  if (read.build) {
    return h('span', { className: 'rk-padcheck', 'data-testid': `pad-check-${node.taskId}`, title: checkWords(read, node.stepDetail) }, h('i', { 'aria-hidden': 'true' }, h('b', { style: { width: `${read.build.percent}%` } })), `${read.build.percent}%`)
  }

  return otherwise
}

/** ◇n on a pad: the lessons roko put in the task's latest prompt (indigo, the learn channel). */
function PadLessons({ node }) {
  return node.lessons ? h('span', { className: 'rk-pad-lessons', title: `${plural(node.lessons, 'lesson')} in its prompt` }, `◇${node.lessons}`) : null
}

/** A task's tries left to right (spec v3 §4.3): ✕ failed, ∿ a provider refused (not counted), ● running, ● passed. */
function Lives({ lives }) {
  const refused = lives.filter(l => l === 'i').length

  return lives.length
    ? h(
        'span',
        { 'aria-label': `${plural(lives.length, 'try', 'tries')}: ${lives.filter(l => l === 'x').length} failed${refused ? `, ${refused} refused by a provider` : ''}`, className: 'rk-lives', role: 'img' },
        lives.slice(-6).map((l, i) => h('i', { 'data-life': l, key: i }))
      )
    : null
}

/**
 * The sequencer: a step column per wave (from the card or a plan), the playhead on the wave the run is on or the
 * replay's moment. Pads are buttons over an SVG layer of edges, so they keep focus rings; a wide one scrolls sideways.
 */
function RunGraph({ nodes, waves, edges, selected, onSelect, planOnly, testId, playhead, live }) {
  const frame = useRef(null)
  const width = useWidth(frame, 860)
  const layout = useMemo(() => layoutGraph(waves, width), [JSON.stringify(waves), width])

  if (!waves.length) {
    return null
  }

  const head = playhead && playhead.wave !== null && playhead.wave >= 0 && playhead.wave < waves.length ? playhead : null

  return h(
    'div',
    { className: 'roko-graph-frame', 'data-testid': testId, ref: frame },
    h(
      'div',
      { className: 'roko-graph', style: { height: layout.height, width: layout.width } },
      waves.map((wave, i) =>
        h('span', {
          'aria-hidden': 'true',
          className: 'rk-step-col',
          'data-active': head && head.wave === i ? 'true' : undefined,
          'data-done': planOnly ? undefined : wave.every(id => ['passed', 'failed', 'blocked', 'stopped', 'unverified'].includes(nodes.get(id)?.state)) ? 'true' : undefined,
          key: `c${i}`,
          style: { left: layout.waveX[i] - Math.min(10, layout.gap / 2), top: 0, width: layout.nodeW + Math.min(20, layout.gap) }
        })
      ),
      h(
        'svg',
        { 'aria-hidden': 'true', className: 'roko-graph-edges', height: layout.height, width: layout.width },
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
      // Each step's number (design system §4.7): lit while it runs, green once its tasks passed, red if one failed.
      waves.map((wave, i) => {
        const states = wave.map(id => nodes.get(id)?.state)
        const ended = states.every(st => ['passed', 'failed', 'blocked', 'stopped', 'unverified'].includes(st))
        const state = planOnly ? undefined : head && head.wave === i && head.mode !== 'replay-done' ? 'live' : ended && states.every(st => st === 'passed') ? 'pass' : ended && states.includes('failed') ? 'fail' : undefined

        return h('span', { 'aria-hidden': 'true', className: 'rk-step-n', 'data-state': state, key: `n${i}`, style: { left: layout.waveX[i] } }, String(i + 1).padStart(2, '0'))
      }),
      head
        ? h('span', {
            'aria-hidden': 'true',
            className: 'rk-playhead',
            'data-mode': head.mode,
            style: { height: layout.height - 6, left: layout.waveX[head.wave] - Math.min(6, layout.gap / 2) - 1, top: 3 }
          })
        : null,
      waves.flat().map(id => {
        const node = nodes.get(id)
        const pos = layout.positions.get(id)

        return node && pos ? h(GraphNode, { key: id, live: live?.byTask?.[node.taskId] ?? null, node, onSelect, planOnly, pos, selected: selected === id }) : null
      })
    )
  )
}

/** Where the playhead stands: the first wave with work going, else the last wave that started. */
function playheadOf(waves, nodes, mode) {
  if (!waves.length) {
    return null
  }

  const running = waves.findIndex(wave => wave.some(id => nodes.get(id)?.state === 'running'))

  if (running >= 0) {
    return { mode, wave: running }
  }

  let last = -1

  waves.forEach((wave, i) => {
    if (wave.some(id => nodes.get(id) && nodes.get(id).state !== 'pending')) {
      last = i
    }
  })

  return last >= 0 ? { mode, wave: last } : mode === 'replay' ? { mode, wave: 0 } : null
}

/** The graph in miniature for chat cards and lists: a dot per task, wave columns, hairline edges. */
function MiniGraph({ run, max = 14 }) {
  const tasks = list(run?.tasks).filter(isRecord)
  const graph = graphOf(run)
  const waves = graph.waves.slice(0, max)

  if (tasks.length < 2 || !waves.length) {
    return null
  }

  // A running task that waits on the person is orange, like every other "you".
  const asks = new Set(list(run?.waiting).filter(isRecord).map(item => text(item.task_id)))
  const states = new Map(
    tasks.map(task => {
      const state = nodeState(task.outcome)

      return [nodeIdOf(task), state === 'running' && asks.has(text(task.task_id)) ? 'waiting' : state]
    })
  )
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

/** Every attempt of a task as a row of stages: the agent (and why it got that model), then each check. */
function TaskPipeline({ task, node }) {
  const log = list(task.attempt_log).filter(isRecord)
  const tries = list(task.climb).filter(isRecord)
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
      const route = isRecord(attempt.route) ? attempt.route : null
      // What ended the try, in roko's words (0.6.0 `Try.why`; dogfood U1), and a climb named as one (U3).
      const t = tries.find(x => num(x.attempt) === num(attempt.attempt)) ?? null
      const from = t?.reason === 'climb' ? text(tries[tries.indexOf(t) - 1]?.rung) : ''

      return h(
        'div',
        { className: 'roko-pipe-row', key: `a${index}` },
        h('span', { className: 'roko-pipe-label' }, `#${num(attempt.attempt) ?? index + 1}`),
        h(
          'span',
          { className: 'roko-pipe-stage', 'data-state': agentLive ? 'run' : 'done' },
          h(Codicon, { name: 'hubot', size: '0.72rem' }),
          clip(attempt.model || node.model || 'agent', 22),
          t?.reason === 'climb'
            ? h('span', { className: 'rk-tag', 'data-channel': 'live', title: `climbed ${from || 'a rung'} → ${text(t.rung)} after 2 failed tries` }, `▲ ${clip(t.rung, 10)}`)
            : route && routeView(route).word
              ? h('span', { className: 'rk-tag', 'data-channel': routeView(route).decider === 'failover' ? 'fail' : 'agent' }, routeView(route).word)
              : null
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
          { className: 'roko-pipe-end', 'data-state': outcome, title: text(t?.why) || undefined },
          latest ? outcomeInfo(node.outcome, node.attempts).word : (tryEnd(t) ?? 'retried')
        ),
        attempt.started_at ? h('span', { className: 'roko-pipe-time' }, clock(parseTime(attempt.started_at))) : null
      )
    })
  )
}

/**
 * Why an attempt runs on its model: who picked it, and the other models it could have used. Score bars only when
 * scores decided; models this run cannot use (a CLI agent, a provider with no key) fold away behind their count.
 */
function RouteCard({ route }) {
  const [showAll, setShowAll] = useState(false)

  if (!isRecord(route) || !text(route.model)) {
    return null
  }

  const view = routeView(route)
  const all = list(route.candidates).filter(isRecord).map(fromHermes)
  const usable = all.filter(c => c.eligible !== false).slice(0, 6)
  const unusable = all.filter(c => c.eligible === false)
  const top = Math.max(0.0001, ...usable.map(c => num(c.score) ?? 0))
  const isPick = c => text(c.model) === text(route.model) && text(c.provider || route.provider) === text(route.provider || c.provider)
  const reason = text(route.reason)
  // A reason that is just the source's own word again ("ladder") adds nothing.
  const said = reason && reason !== view.decider && reason !== text(route.source) && reason !== text(route.stage) ? clip(reason, 200) : ''
  const odds = view.scored && num(route.p) !== null && route.p < 1 ? `p ${route.p.toFixed(2)}` : null
  const row = (c, i) => {
    const score = num(c.score)
    const out = c.eligible === false

    return h(
      'div',
      { className: 'rk-cand', 'data-eligible': out ? 'false' : 'true', 'data-pick': isPick(c) ? 'true' : undefined, key: `${text(c.model)}:${i}`, role: 'listitem' },
      h('span', { className: 'rk-cand-model', title: [text(c.model), text(c.provider)].filter(Boolean).join(' · ') }, clip(c.model, 26)),
      view.scored && !out ? h('span', { 'aria-hidden': 'true', className: 'rk-cand-bar' }, h('i', { style: { width: `${Math.round(Math.max(0.04, (score ?? 0) / top) * 100)}%` } })) : h('span', { 'aria-hidden': 'true', className: 'rk-cand-bar', 'data-empty': 'true' }),
      h('span', { className: 'rk-cand-score' }, view.scored && !out ? (score !== null ? score.toFixed(2) : '—') : ''),
      h(
        'span',
        { className: 'rk-cand-note' },
        out
          ? clip(text(c.why_not) || text(c.ineligible_reason), 200) || 'this run cannot use it'
          : isPick(c)
            ? 'picked'
            : view.scored
              ? num(c.p) !== null
                ? `p ${c.p.toFixed(2)}`
                : ''
              : 'could have run it'
      )
    )
  }

  return h(
    'div',
    { className: 'rk-route', 'data-decided-by': view.decider || undefined, 'data-scored': view.scored ? 'true' : 'false', 'data-testid': 'route' },
    h(
      'div',
      { className: 'rk-route-head' },
      h(Codicon, { name: 'git-compare', size: '0.8rem' }),
      h('span', { className: 'rk-route-model' }, text(route.model)),
      text(route.provider) ? h('span', { className: 'roko-muted' }, `via ${text(route.provider)}`) : null,
      num(route.attempt) !== null ? h('span', { className: 'roko-muted' }, `attempt ${route.attempt}`) : null
    ),
    h(
      'div',
      { className: 'rk-route-by' },
      h('span', { className: 'rk-tag', 'data-channel': view.decider === 'failover' ? 'fail' : 'agent', 'data-testid': 'route-decider' }, view.words),
      view.rung ? h('span', { className: 'rk-tag', 'data-channel': 'ink' }, `rung ${clip(view.rung, 12)}`) : null,
      odds ? h('span', { className: 'rk-route-p', title: 'the chance the router gave this pick' }, odds) : null
    ),
    said ? h('div', { className: 'rk-route-reason' }, said) : null,
    usable.length ? h('div', { 'aria-label': view.scored ? 'Models the router weighed' : 'Models this run could use', className: 'rk-cands', role: 'list' }, usable.map(row)) : null,
    unusable.length
      ? h(
          'div',
          { className: 'rk-cands-more' },
          h(
            'button',
            { 'aria-expanded': showAll ? 'true' : 'false', className: 'rk-cands-toggle', 'data-testid': 'route-unusable', onClick: () => setShowAll(v => !v), type: 'button' },
            `${plural(unusable.length, 'model')} this run cannot use${showAll ? '' : ' ›'}`
          ),
          showAll ? h('div', { 'aria-label': 'Models this run cannot use', className: 'rk-cands', role: 'list' }, unusable.map(row)) : null
        )
      : null
  )
}

/** The task's agent, live: its last tool steps (socket first, else the card's) and what it is writing. */
function TaskLive({ task, node, live }) {
  const id = node.taskId
  const fromSocket = live.items.filter(item => item.task_id === id && item.kind === 'tool').slice(-8)
  const steps = fromSocket.length
    ? fromSocket.map(item => ({ target: item.target, tool: item.tool, ts: item.ts }))
    : list(task.steps)
        .filter(isRecord)
        .slice(-8)
        .map(step => ({ target: text(step.target), tool: text(step.tool), ts: parseTime(step.ts) }))
  const said = live.byTask[id]?.said || text(task.live_text)

  if (node.state !== 'running' || (!steps.length && !said)) {
    return null
  }

  return h(
    'div',
    { className: 'rk-tasklive', 'data-testid': 'task-live' },
    h(SectionLabel, null, 'Now'),
    steps.length
      ? h(
          Well,
          { className: 'rk-steps' },
          steps.map((step, i) =>
            h(
              'div',
              { className: 'rk-steps-row', 'data-newest': i === steps.length - 1 ? 'true' : undefined, key: `${step.ts}:${i}` },
              h('span', { className: 'rk-steps-time' }, step.ts ? clock(step.ts) : ''),
              h('span', { className: 'rk-steps-tool' }, clip(step.tool, 24)),
              h('span', { className: 'rk-steps-target' }, clip(step.target, 120))
            )
          )
        )
      : null,
    said ? h('blockquote', { className: 'roko-quote rk-said' }, mdWords(clip(said, 600), 'said')) : null
  )
}

/** A sign-off hold, held calls, and what roko's knowledge store took from the task. */
function TaskLoops({ task }) {
  const hold = isRecord(task.hold) ? task.hold : null
  const effects = list(task.effects).filter(isRecord)
  const lessons = list(task.lessons).filter(isRecord)

  if (!hold && !effects.length && !lessons.length) {
    return null
  }

  return h(
    'div',
    { className: 'rk-taskloops' },
    hold
      ? h(
          'div',
          { className: 'roko-callout', 'data-tone': hold.state === 'waiting' ? 'you' : 'muted' },
          h(LED, { blink: hold.state === 'waiting' ? 'fast' : undefined, tone: hold.state === 'waiting' ? 'you' : hold.outcome === 'approved' ? 'pass' : 'off' }),
          h(
            'span',
            null,
            hold.state === 'waiting' ? 'Waits for your sign-off' : `Sign-off: ${clip(hold.outcome, 20) || 'resolved'}`,
            text(hold.question) ? ` · ${clip(hold.question, 160)}` : '',
            text(hold.note) ? ` · “${clip(hold.note, 120)}”` : ''
          ),
          hold.state === 'waiting' ? h(Countdown, { deadline: hold.deadline_at }) : null
        )
      : null,
    effects.length
      ? h(
          'div',
          { className: 'rk-effects' },
          h(SectionLabel, null, 'Held calls'),
          effects.slice(0, 6).map((effect, i) =>
            h(
              'div',
              { className: 'rk-effect', 'data-state': text(effect.state), key: `${text(effect.effect_id)}:${i}` },
              h(LED, { blink: effect.state === 'held' ? 'fast' : undefined, tone: effect.state === 'held' ? 'you' : /applied|approved/.test(text(effect.outcome)) ? 'pass' : 'off' }),
              h('span', { className: 'roko-mono' }, `${clip(effect.tool, 40) || '?'}@${clip(effect.server, 30) || '?'}`),
              h('span', { className: 'roko-muted' }, effect.state === 'held' ? 'held for you' : clip(effect.outcome, 30) || 'decided')
            )
          )
        )
      : null,
    lessons.length
      ? h(
          'div',
          { className: 'rk-lessons' },
          h(SectionLabel, null, 'What roko learned'),
          lessons.slice(0, 5).map((lesson, i) => {
            const words = lessonWords(lesson)

            return h(
              'div',
              { className: 'rk-lesson', 'data-testid': 'lesson', key: `${text(lesson.entry_id)}:${i}` },
              h(LED, { size: 's', tone: words.channel }),
              words.lesson ? h('span', { className: 'rk-lesson-text' }, words.lesson) : null,
              words.meta ? h('span', { className: words.lesson ? 'roko-muted' : 'rk-lesson-text' }, words.meta) : null
            )
          })
        )
      : null
  )
}

/** What roko's knowledge store did with a task's outcome (`admission`), in words; the same as the dashboard. */
const ADMISSION_WORDS = {
  deferred: 'a lesson waits for more evidence',
  duplicate: 'confirmed a lesson it had',
  full_admitted: 'kept a new lesson',
  full_deferred: 'a lesson waits for more evidence',
  full_rejected: 'a lesson was not kept',
  full_suppressed: 'a lesson was not kept',
  light_admitted: 'kept a new lesson',
  no_candidate: 'nothing new to learn from this task'
}

/**
 * One `lessons` row as a person reads it: the lesson (never a stand-in like "none") and one line of what
 * happened: "nothing new to learn from this task · confirmed 3 lessons it had · 3 moved up a tier".
 */
function lessonWords(lesson) {
  const said = clip(lesson.lesson, 300)
  const kept = said && !/^(none|null|n\/a|-)$/i.test(said) ? said : ''
  const admission = text(lesson.admission)
  const confirmed = (num(lesson.reinforced) ?? 0) > 0
  // A duplicate is a confirmation: the count says it once.
  const what = admission === 'duplicate' && confirmed ? '' : ADMISSION_WORDS[admission] ?? (admission ? admission.replace(/_/g, ' ') : kept ? 'kept' : '')
  const parts = [what]

  if (confirmed) {
    parts.push(`confirmed ${plural(num(lesson.reinforced), 'lesson')} it had`)
  }

  // A lesson just admitted with nothing confirmed enters its first tier: nothing moved up (dogfood U6).
  if (/_admitted$/.test(admission) && !confirmed) {
    // Nothing moved.
  } else if ((num(lesson.promoted) ?? 0) > 0) {
    parts.push(`${num(lesson.promoted)} moved up a tier`)
  } else if (lesson.promoted === true) {
    parts.push('moved up a tier')
  }

  return { channel: /admitted|duplicate/.test(admission) || confirmed ? 'learn' : 'ink', lesson: kept, meta: parts.filter(Boolean).join(' · ') }
}

/** A try's end in a word or two for its attempt row (dogfood U1): roko's verdict, else its outcome. */
const VERDICT_WORDS = {
  budget_exhausted: 'budget',
  gate_failed: 'check failed',
  no_changes: 'no changes',
  passed: 'passed',
  provider_error: 'provider error',
  stream_limit: 'stream stopped',
  timeout: 'timed out',
  turn_cap: 'turn cap'
}

/**
 * Why a task climbed, from the tries on the rung below that did not pass (plugin-review Q4): "2 failed checks on cheap"
 * only when every one of them ended on its check; else what ended each ("2 tries on cheap didn’t pass: 1 check failed,
 * 1 turn cap"); a single try by its own why ("turn cap (15 turns) on cheap").
 */
function climbWhy(below) {
  const rung = text(below[0]?.rung)
  // roko's verdict; an older roko's try says only which check failed.
  const checkFailed = t => text(t.verdict) === 'gate_failed' || (!text(t.verdict) && Boolean(text(t.failed_check)))

  if (!below.length || !rung) {
    return ''
  }

  if (below.every(checkFailed)) {
    return `${plural(below.length, 'failed check')} on ${rung}`
  }

  if (below.length === 1) {
    return `${clip(text(below[0].why).replace(/^(it hit its|it|its)\s+/i, '') || tryEnd(below[0]) || 'did not pass', 80)} on ${rung}`
  }

  const ends = new Map()

  below.forEach(t => {
    const word = checkFailed(t) ? 'check failed' : tryEnd(t) || 'other'

    ends.set(word, (ends.get(word) ?? 0) + 1)
  })

  return `${below.length} tries on ${rung} didn’t pass: ${[...ends].map(([word, n]) => `${n} ${word}`).join(', ')}`
}

function tryEnd(t) {
  if (!isRecord(t) || t.outcome === 'running') {
    return null
  }

  return VERDICT_WORDS[text(t.verdict)] ?? (t.outcome === 'failed' ? (text(t.failed_check) ? 'check failed' : 'failed') : text(t.outcome) || null)
}

/** "try 2 ✕ · 38s · $0.014": a try's card on its rung (the route sheet's CLIMB, spec v3 §5.3). */
function TryCard({ t, index, chosen, onPick, from }) {
  const running = t.outcome === 'running'
  const failed = t.outcome === 'failed'
  // A provider (or roko itself) failed it: never the agent's ✕, and it does not count toward a climb.
  const refused = tryMark(t) === 'i'

  return h(
    'button',
    {
      'aria-pressed': chosen ? 'true' : 'false',
      className: 'rk-trycard',
      'data-outcome': text(t.outcome),
      'data-testid': `try-${num(t.attempt) ?? index + 1}`,
      onClick: onPick,
      title: text(t.why) || undefined,
      type: 'button'
    },
    h(
      'span',
      { className: 'rk-trycard-head' },
      h('b', null, `try ${num(t.attempt) ?? index + 1}`),
      refused ? h('span', { className: 'rk-trycard-refused', title: 'a provider refused it: not counted toward a climb' }, '∿') : failed ? h('span', { className: 'rk-trycard-x' }, '✕') : t.outcome === 'passed' ? h('span', { className: 'rk-trycard-ok' }, '✓') : null,
      h('span', { className: 'roko-flex' }),
      running
        ? h('span', { className: 'rk-trycard-live' }, '● running ', t.started_at ? h(StepClock, { since: text(t.started_at) }) : null)
        : h(Fragment, null, num(t.duration_ms) !== null ? h('span', null, duration(t.duration_ms)) : null, num(t.cost_usd) !== null ? h('span', null, money(t.cost_usd)) : null)
    ),
    t.reason === 'climb' && from
      ? h('span', { className: 'rk-trycard-line', 'data-tone': 'live' }, `▲ up from ${from}${num(t.cost_usd) !== null && running ? ` · ${money(t.cost_usd)} so far` : ''}`)
      : t.reason === 'failover'
        ? h('span', { className: 'rk-trycard-line', 'data-tone': 'fail' }, `⇄ failover${isRecord(t.failover) && text(t.failover.why) ? ` · ${clip(t.failover.why, 40)}` : ''}`)
        : null,
    refused
      ? h('span', { className: 'rk-trycard-line' }, `${clip(t.why, 44) || 'a provider refused it'} · not counted`)
      : failed && text(t.failed_check)
        ? h('span', { className: 'rk-trycard-line' }, `${clip(t.failed_check, 26)} did not pass`)
        : failed && text(t.why)
          ? h('span', { className: 'rk-trycard-line' }, clip(t.why, 60))
          : null,
    failed && text(t.key_line) ? h('span', { className: 'rk-trycard-key' }, clip(text(t.key_line).replace(/[\r\n]+/g, ' '), 80)) : null
  )
}

/**
 * The task's own ladder (spec v3 §5.3, `01 CLIMB`): each rung, its model and price, and the task's tries as cards on
 * the rung each ran on; the rung above says what happens next; a rung a chat's run cannot use says so. The rule
 * roko climbs by is stated under it.
 */
function ClimbView({ run, task, chosen, onPick }) {
  const rungs = list(run.ladder).filter(r => isRecord(r) && text(r.rung))
  const tries = list(task.climb).filter(isRecord)
  const lives = isRecord(task.lives) ? task.lives : null
  const standing = text(lives?.rung) || text(tries.at(-1)?.rung)
  const at = rungs.findIndex(r => text(r.rung) === standing)
  const next = at >= 0 ? rungs.slice(at + 1).find(r => r.chat_ok !== false) : null
  const ended = !['running', 'pending'].includes(nodeState(task.outcome))

  return h(
    'div',
    { className: 'rk-climb', 'data-testid': 'climb' },
    h(
      'div',
      { 'aria-label': 'The task’s tries, top rung first', className: 'rk-climb-rungs', role: 'list' },
      rungs
        .slice()
        .reverse()
        .map(rung => {
          const name = text(rung.rung)
          const mine = tries.map((t, i) => [t, i]).filter(([t]) => text(t.rung) === name)
          const below = rungs.slice(0, rungs.findIndex(r => text(r.rung) === name)).map(r => text(r.rung))

          return h(
            'div',
            { className: 'rk-climb-rung', 'data-off': rung.chat_ok === false ? 'true' : undefined, 'data-rung': name, key: name, role: 'listitem' },
            h('span', { className: 'rk-climb-name' }, h('b', null, name), h('span', null, text(rung.slug) || text(rung.model)), h('small', null, rungPrice(rung) ? `${rungPrice(rung).replace('·', ' · ')}${rungPrice(rung) === 'no list price' ? '' : ' /M'}` : '')),
            h(
              'span',
              { className: 'rk-climb-tries' },
              mine.length
                ? mine.map(([t, i]) => h(TryCard, { chosen: chosen === i, from: below.length ? text(tries[i - 1]?.rung) || below.at(-1) : '', index: i, key: i, onPick: () => onPick(i), t }))
                : rung.chat_ok === false
                  ? h('span', { className: 'rk-climb-note' }, `— ${clip(rung.why_not, 70) || 'not for chat runs'}`)
                  : next && text(next.rung) === name && !ended
                    ? h('span', { className: 'rk-climb-note' }, `○○ next, if ${standing} fails its check twice`)
                    : null
            )
          )
        })
    ),
    h('p', { className: 'rk-climb-rule' }, 'roko moves a task up one rung after 2 tries on it did not pass (a failed check, or a try that spent its rung’s allowance), at most 2 rungs. A provider error is a failover on the same rung, never a climb.')
  )
}

/** What roko put in a try's prompt (0.6.0 `Try.prompt`, roko's prompt_assembled) and what the check before told it. */
function PromptView({ t, previous }) {
  const prompt = isRecord(t?.prompt) ? t.prompt : null
  const feedback = isRecord(t?.feedback) ? t.feedback : null
  const lessons = list(prompt?.lessons).filter(isRecord)

  return h(
    'div',
    { className: 'rk-inprompt', 'data-testid': 'in-its-prompt' },
    lessons.length
      ? h(
          'div',
          { 'aria-label': 'Lessons in its prompt', role: 'list' },
          lessons.slice(0, 6).map(lesson =>
            h(
              'div',
              { className: 'rk-inprompt-lesson', key: text(lesson.id), role: 'listitem' },
              h('span', { 'aria-hidden': 'true', className: 'rk-chain-g' }, '◇'),
              h(
                'div',
                null,
                h('p', null, clip(lesson.text, 200) || text(lesson.id)),
                h('small', null, [text(lesson.kept_by) ? `kept by ${clip(lesson.kept_by, 12)} of this run` : 'kept by an earlier run', num(lesson.citations) ? `confirmed ${plural(num(lesson.citations), 'time')}` : ''].filter(Boolean).join(' · '))
              ),
              h(Confidence, { value: lesson.confidence })
            )
          )
        )
      : h('p', { className: 'rk-lempty' }, prompt ? 'No stored lesson was in its prompt.' : 'roko did not say what this try’s prompt carried (it says so from roko 8357603f0, prompt_assembled).'),
    feedback
      ? h(
          'div',
          { className: 'rk-feedback', 'data-testid': 'retry-feedback' },
          h('span', { className: 'rk-feedback-k' }, `◆ what try ${num(feedback.from_attempt) ?? previous ?? '?'}’s check told try ${num(t.attempt) ?? '?'}`),
          // roko's words carry markdown (**a path**, `code`): shown as type, never as asterisks (P-20).
          text(feedback.diagnosis) ? h('p', null, mdWords(clip(feedback.diagnosis, 600), 'fb')) : null,
          list(feedback.errors).length ? h('ul', null, list(feedback.errors).slice(0, 5).map((e, i) => h('li', { key: i }, mdWords(clip(e, 200), `fe${i}`)))) : null
        )
      : null
  )
}

/** What each try cost (spec v3 §5.3, `04 COST`): a bar a try (red failed, rose running), and the task's total in bone. */
function TryCost({ tries, taskId }) {
  const costs = tries.map(t => num(t.cost_usd))
  const total = costs.reduce((a, b) => a + (b ?? 0), 0)
  const max = Math.max(0.000001, ...costs.map(c => c ?? 0))

  if (!costs.some(c => c !== null)) {
    return h('p', { className: 'rk-lempty' }, 'roko reports a try’s cost as its checks end.')
  }

  return h(
    'div',
    { className: 'rk-trycost', 'data-testid': 'try-cost' },
    tries.map((t, i) =>
      h(
        'div',
        { className: 'rk-trycost-row', 'data-outcome': text(t.outcome), key: i },
        h('span', null, `try ${num(t.attempt) ?? i + 1}`),
        h('span', { className: 'rk-trycost-rung' }, text(t.rung)),
        h('span', { 'aria-hidden': 'true', className: 'rk-trycost-bar' }, h('i', { style: { width: `${Math.round(((costs[i] ?? 0) / max) * 100)}%` } })),
        h('span', { className: 'rk-trycost-usd' }, costs[i] === null ? '—' : `${money(costs[i])}${t.outcome === 'running' ? '…' : ''}`)
      )
    ),
    h('div', { className: 'rk-trycost-total' }, h('span', null, taskId), h(Well, { className: 'rk-trycost-well' }, h(Dots, { label: `${taskId} cost ${money(total)} so far`, size: 'M', tone: 'bone', value: money(total) })))
  )
}

/**
 * Everything about one task (spec v3 §5.3, mockup 02), a sheet over the run: its climb or attempts, its prompt, what
 * its agent does and said; why its try runs on its model, each try's cost, its check's output. ↑↓ pick a try, C copies
 * the key line, O shows all output, Esc closes. A one-task run shows it in place.
 */
function TaskInspector({ run, task, node, onClose, onSelect, live }) {
  const box = useRef(null)
  const why = isRecord(run.why) ? run.why : null
  const failing = list(why?.gates_not_passed).filter(g => isRecord(g) && text(g.task_id) === node.taskId)
  const excerpt = list(task.gates).filter(isRecord).find(g => g.passed === false)
  const [showOutput, setShowOutput] = useState(false)
  const [copied, setCopied] = useState(false)
  const deps = list(task.depends_on).map(text).filter(Boolean)
  const info = outcomeInfo(node.outcome, node.attempts)
  // roko asks each agent to end with "Lesson: …"; "Lesson: none" is protocol, not words for the person.
  const note = text(task.note).replace(/\n*\s*Lesson:\s*(none|n\/a|-|—)?\.?\s*$/i, '').trim()
  const log = list(task.attempt_log).filter(isRecord)
  const tries = list(task.climb).filter(isRecord)
  const [sel, setSel] = useState(null)
  const at = tries.length ? (sel === null ? tries.length - 1 : clamp(sel, 0, tries.length - 1)) : -1
  const chosen = at >= 0 ? tries[at] : null
  const chosenLog = chosen ? log.find(a => num(a.attempt) === num(chosen.attempt)) : null
  const route = (isRecord(chosenLog?.route) ? chosenLog.route : null) ?? [...log].reverse().find(a => isRecord(a.route))?.route ?? null
  const sheet = Boolean(onClose)
  const climbView = list(run.ladder).length > 0 && tries.length > 0
  // The check output belongs to the try that ran the check, never to another one (dogfood U2). The card's check_tail
  // names its try; the run's why and the task's failed gate tell of the check's newest run, so they belong to the
  // newest try that ran a check, never to a later try that ran none (one stopped at the run's cap: the climb take).
  const tail = isRecord(task.check_tail) ? task.check_tail : null
  const tailFits = tail && (!chosen || num(tail.attempt) === num(chosen.attempt))
  const newestChecked = num(tail?.attempt) ?? num([...tries].reverse().find(t => text(t.failed_check))?.attempt)
  const whyFits = !chosen || (newestChecked !== null && newestChecked === num(chosen.attempt))
  const gate = text(chosen?.failed_check) || (tailFits ? text(tail.gate) : '') || (whyFits ? text(failing[0]?.gate) || text(excerpt?.gate) : '')
  const keyLine = text(chosen?.key_line).replace(/[\r\n]+/g, ' ') || (whyFits ? text(failing[0]?.key_line) || text(excerpt?.excerpt) : '')
  const output = tailFits && list(tail.lines).length ? list(tail.lines).map(text).join('\n') : whyFits ? text(failing[0]?.output) : ''
  const glassLines = tailFits && list(tail.lines).length ? checkLinesOf(run.run_id, node.taskId, text(tail.gate), num(tail.attempt), list(tail.lines).map(text)) : []
  const glassError = glassLines.length > 0 && readCheck(glassLines).error !== null
  const lives = isRecord(task.lives) ? task.lives : null
  const usable = list(run.ladder).filter(r => isRecord(r) && r.chat_ok !== false).length
  const upTo = num(task.tries_allowed) ?? (num(lives?.of) ?? 2) * Math.min(3, Math.max(1, usable))

  // The sheet covers the roko page, not Hermes' sidebar (spec v3 §5.3): its frame is the page's box.
  const [frame, setFrame] = useState(null)

  useLayoutEffect(() => {
    if (!sheet) {
      return undefined
    }

    const page = box.current?.closest?.('.roko-page')
    const measure = () => {
      const r = page?.getBoundingClientRect?.()

      if (r && r.width > 0 && r.height > 0) {
        setFrame({ height: r.height, left: r.left, top: r.top, width: r.width })
      }
    }

    measure()
    window.addEventListener('resize', measure)

    return () => window.removeEventListener('resize', measure)
  }, [sheet])

  const sheetBox = frame
    ? (() => {
        const width = Math.min(1120, frame.width * 0.94)

        return { bottom: 'auto', height: frame.height * 0.92, left: frame.left + (frame.width - width) / 2, margin: 0, right: 'auto', top: frame.top + frame.height * 0.04, width }
      })()
    : undefined

  // The sheet's keys: ↑↓ tries, C copy the key line, O all of the output (Esc is the page's).
  useEffect(() => {
    if (!sheet) {
      return undefined
    }

    const onKey = event => {
      const target = event.target

      if (event.metaKey || event.ctrlKey || event.altKey || (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)))) {
        return
      }

      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && tries.length > 1) {
        event.preventDefault()
        setSel(i => clamp((i ?? tries.length - 1) + (event.key === 'ArrowUp' ? -1 : 1), 0, tries.length - 1))
      } else if (event.key === 'c' && keyLine) {
        void writeClipboard(keyLine).then(ok => setCopied(ok))
      } else if (event.key === 'o' && output) {
        setShowOutput(v => !v)
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [sheet, tries.length, keyLine, output])

  const module = (n, label, note, ...children) => h('div', { className: 'rk-sheet-mod' }, h(ModLabel, { n, note }, label), ...children)
  const left = h(
    'div',
    { className: 'rk-sheet-col' },
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
      : text(task.reason) || OUTCOME_NOTES[node.outcome]
        ? // Why it ended so, in the backend's words, for any outcome ("stopped at the run's cap: …", "passed: the
          // failures its check found were already there before the task", "skipped: no route of the plan chose it…");
          // else the outcome's own note.
          h(
            'div',
            { className: 'roko-callout', 'data-testid': node.outcome === 'stopped' ? 'task-stopped' : 'task-outcome-note', 'data-tone': 'muted' },
            h(Codicon, { name: node.state === 'stopped' ? 'debug-stop' : 'info', size: '0.85rem' }),
            h('span', null, text(task.reason) ? sentenceCase(clip(task.reason, 240)) : OUTCOME_NOTES[node.outcome])
          )
        : null,
    climbView
      ? module(1, 'climb', 'each try on the rung it ran on', h(ClimbView, { chosen: at, onPick: setSel, run, task }))
      : h(Fragment, null, h(SectionLabel, null, 'Attempts'), h(TaskPipeline, { node, task })),
    tries.length ? module(2, 'in its prompt', chosen ? `what roko knew before try ${num(chosen.attempt) ?? at + 1}` : '', h(PromptView, { previous: num(tries[at - 1]?.attempt), t: chosen })) : null,
    h(TaskLoops, { task }),
    h(TaskLive, { live, node, task }),
    note ? h('div', { className: 'roko-note-block' }, h(SectionLabel, null, 'The agent said'), h('blockquote', { className: 'roko-quote' }, h(Clamp, { lines: 5, value: note }))) : null,
    deps.length
      ? h(
          'div',
          { className: 'roko-deps' },
          h('span', { className: 'roko-muted' }, 'after'),
          deps.map(dep => h('button', { className: 'roko-chip roko-chip-btn', key: dep, onClick: () => onSelect?.(task.plan_id ? `${text(task.plan_id)}/${dep}` : dep), type: 'button' }, dep))
        )
      : null
  )
  const right = h(
    'div',
    { className: 'rk-sheet-col' },
    // Keyed by the task and attempt: another task's route starts folded again.
    route ? module(3, 'route', `try ${num(route.attempt) ?? (chosen ? num(chosen.attempt) : '')}${route.source === 'failover' ? ' · a failover' : ' · published as it happened'}`, h(RouteCard, { key: `${text(task.task_id)}:${num(route.attempt) ?? ''}`, route })) : null,
    tries.length ? module(4, 'cost', `${node.taskId} so far`, h(TryCost, { taskId: node.taskId, tries })) : null,
    keyLine || output
      ? module(
          5,
          'check output',
          [chosen ? `try ${num(chosen.attempt) ?? at + 1}` : '', gate, tailFits && num(tail.exit_code) !== null ? `exit ${num(tail.exit_code)}` : '', tailFits && num(tail.duration_ms) !== null ? duration(tail.duration_ms) : ''].filter(Boolean).join(' · '),
          h(
            'div',
            { className: 'roko-checkout' },
            // The check's own lines, read: its build, its error with the source line, its tests.
            glassLines.length ? h(BuildGlass, { lines: glassLines, live: tail.passed === null, testId: 'inspector-glass' }) : null,
            // The key line, unless the glass already shows that error.
            keyLine && !glassError ? h('div', { className: 'roko-keyline' }, h(Codicon, { name: 'error', size: '0.8rem' }), h('span', null, keyLine)) : null,
            output && (showOutput || !keyLine) ? h('pre', { className: 'roko-pre rk-sheet-out' }, output) : null,
            output && keyLine ? h('button', { className: 'roko-link', onClick: () => setShowOutput(v => !v), type: 'button' }, showOutput ? 'hide the output' : 'all of the output') : null
          )
        )
      : null
  )
  const head = h(
    'div',
    { className: 'roko-inspector-head' },
    h(LED, { blink: node.state === 'running' ? (node.waiting ? 'fast' : 'slow') : undefined, tone: nodeChannel(node) }),
    h('span', { className: 'roko-node-id' }, node.taskId),
    h('span', { className: 'roko-inspector-title' }, node.title || node.taskId),
    h('span', { className: 'roko-pill', 'data-tone': info.tone }, h('span', { 'aria-hidden': 'true', className: 'roko-pill-glyph' }, info.glyph), ' ', info.word),
    node.climbed ? h(Stamp, { tone: 'live' }, 'climbed') : null,
    h('span', { className: 'roko-flex' }),
    sheet && chosen ? h('span', { className: 'rk-sheet-count' }, `try ${num(chosen.attempt) ?? at + 1} of up to ${upTo}`, node.state === 'running' && node.stepSince ? h(Fragment, null, ' · ', h(StepClock, { since: node.stepSince })) : null) : null,
    onClose ? h(Button, { 'aria-label': 'Close the task', onClick: onClose, size: 'icon-xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'close', size: '0.8rem' })) : null
  )
  const section = h(
    'section',
    { 'aria-label': `Task ${node.taskId}`, className: cx('roko-inspector', sheet && 'rk-sheet'), 'data-channel': nodeChannel(node), 'data-testid': `inspector-${node.taskId}`, ref: box, style: sheetBox },
    head,
    h('div', { className: 'rk-sheet-body' }, left, right),
    sheet
      ? h(
          'div',
          { className: 'rk-sheet-foot' },
          h('span', null, h(Kbd, { size: 'sm', variant: 'ghost' }, 'esc'), ' back'),
          tries.length > 1 ? h('span', null, h(Kbd, { size: 'sm', variant: 'ghost' }, '↑'), h(Kbd, { size: 'sm', variant: 'ghost' }, '↓'), ' tries') : null,
          keyLine ? h('span', null, h(Kbd, { size: 'sm', variant: 'ghost' }, 'C'), copied ? ' copied' : ' copy the key line') : null,
          output ? h('span', null, h(Kbd, { size: 'sm', variant: 'ghost' }, 'O'), ' all of the output') : null,
          h('span', { className: 'roko-flex' }),
          h('span', { className: 'rk-sheet-src' }, `from roko: ${['route_decided', 'gate_result', tries.some(t => isRecord(t.feedback)) ? 'retry feedback' : '', tries.some(t => isRecord(t.prompt)) ? 'knowledge used' : ''].filter(Boolean).join(' · ')}`)
        )
      : null
  )

  return sheet
    ? h(Fragment, null, h('div', { 'aria-hidden': 'true', className: 'rk-sheet-scrim', onClick: onClose, style: frame ? { bottom: 'auto', height: frame.height, left: frame.left, right: 'auto', top: frame.top, width: frame.width } : undefined }), section)
    : section
}

// --- Activity: the run's timeline, live, filterable, and replayable

/** Run events cached per run id, so reopening a run only fetches newer rows; the socket's `lines` merge in. */
const eventCache = new Map()
/** Mounted activity views per run, told when the socket pushes lines. */
const eventListeners = new Map()

/** Lines merged by cursor (a line the socket and a page both brought shows once), in cursor order. */
function mergeEvents(events, more, keep = EVENTS_KEPT) {
  const seen = new Set(events.map(e => num(e.cursor)).filter(c => c !== null))
  const fresh = list(more)
    .filter(isRecord)
    .filter(e => num(e.cursor) === null || !seen.has(e.cursor))

  if (!fresh.length) {
    return events
  }

  return [...events, ...fresh].sort((a, b) => (num(a.cursor) ?? Infinity) - (num(b.cursor) ?? Infinity)).slice(-keep)
}

/** A run's lines this window keeps (it was 500), at most once paged back, and how many newest it opens on. */
const EVENTS_KEPT = 1_200
const EVENTS_MOST = 20_000
const EVENTS_TAIL = 400
/** How many lines Activity draws at first, and how many more each earlier ↑ shows. */
const FEED_WINDOW = 300
const FEED_STEP = 200

function cacheEvents(runId, next) {
  eventCache.set(runId, next)

  if (eventCache.size > 30) {
    eventCache.delete(eventCache.keys().next().value)
  }

  eventListeners.get(runId)?.forEach(listener => listener(next))
}

function useRunEvents(runId, open, active) {
  const [state, setState] = useState(() => eventCache.get(runId) ?? { cursor: null, earlier: false, events: [] })
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const earlierBusy = useRef(false)
  const stateRef = useRef(state)
  const activeRef = useRef(active)
  // roko serve answering again: an ended run's events are read once more, so a failure from while it was down goes.
  const reachable = useReachable()
  const [back, setBack] = useState(0)
  const wasDown = useRef(false)

  useEffect(() => {
    if (reachable === false) {
      wasDown.current = true
    } else if (reachable === true && wasDown.current) {
      wasDown.current = false
      setBack(n => n + 1)
    }
  }, [reachable])

  activeRef.current = active

  // Lines the socket pushes for this run.
  useEffect(() => {
    if (!validId(runId)) {
      return undefined
    }

    const set = eventListeners.get(runId) ?? new Set()
    const listener = next => {
      stateRef.current = next
      setState(next)
    }

    set.add(listener)
    eventListeners.set(runId, set)

    return () => {
      set.delete(listener)

      if (!set.size) {
        eventListeners.delete(runId)
      }
    }
  }, [runId])

  useEffect(() => {
    if (!open || !validId(runId)) {
      return undefined
    }

    let cancelled = false
    let timer = null

    const pull = async () => {
      setLoading(true)
      let reading = false

      try {
        let current = stateRef.current

        // A run not read yet opens on its newest lines, then follows; while the backend is `reading`, ask again.
        if (current.cursor === null || current.cursor === undefined || current.reading) {
          const reply = await call(`/runs/${enc(runId)}/events?tail=${EVENTS_TAIL}`)

          if (cancelled) {
            return
          }

          reading = reply.reading === true
          current = reading
            ? { cursor: null, earlier: false, events: [], reading, rowsRead: num(reply.rows_read) }
            : { cursor: reply.next_cursor ?? null, earlier: reply.earlier === true, events: mergeEvents([], list(reply.events)), reading }
        }

        const keep = current.keep ?? EVENTS_KEPT
        let more = !reading
        let rounds = 0

        while (more && rounds < 10) {
          rounds += 1
          const cursor = current.cursor !== null && current.cursor !== undefined ? `&cursor=${enc(current.cursor)}` : ''
          const reply = await call(`/runs/${enc(runId)}/events?limit=200${cursor}`)

          if (cancelled) {
            return
          }

          const events = mergeEvents(current.events, list(reply.events), keep)

          more = reply.has_more === true && events !== current.events
          current = { ...current, cursor: reply.next_cursor ?? current.cursor, events }
        }

        // Lines the socket pushed while this pull was out stay.
        const merged = { ...current, earlier: current.earlier ?? stateRef.current.earlier ?? false, events: mergeEvents(current.events, stateRef.current.events, keep), keep: stateRef.current.keep ?? current.keep }

        stateRef.current = merged
        cacheEvents(runId, merged)
        setState(merged)
        setError(null)
      } catch (err) {
        if (!cancelled) {
          setError(err)
        }
      } finally {
        if (!cancelled) {
          setLoading(false)

          if (reading || activeRef.current) {
            timer = setTimeout(() => void pull(), reading ? READ_AGAIN_MS : pollMs(RUN_MS))
          }
        }
      }
    }

    void pull()

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [runId, open, active, back])

  // The lines before the oldest held (`?before=`), a page at a time, at the person's ask.
  const loadEarlier = async () => {
    const oldest = num(stateRef.current.events[0]?.cursor)

    if (oldest === null || earlierBusy.current) {
      return
    }

    earlierBusy.current = true
    setLoadingEarlier(true)

    try {
      let reply = await call(`/runs/${enc(runId)}/events?before=${oldest}&limit=200`)

      for (let i = 0; reply.reading === true && i < 6; i += 1) {
        reply = await call(`/runs/${enc(runId)}/events?before=${oldest}&limit=200`)
      }

      const held = stateRef.current.events.length + list(reply.events).length
      const keep = Math.min(EVENTS_MOST, Math.max(stateRef.current.keep ?? EVENTS_KEPT, held))
      const next = { ...stateRef.current, earlier: reply.earlier === true, events: mergeEvents(stateRef.current.events, list(reply.events), keep), keep }

      stateRef.current = next
      cacheEvents(runId, next)
      setState(next)
    } catch (err) {
      setError(err)
    } finally {
      earlierBusy.current = false
      setLoadingEarlier(false)
    }
  }

  return { earlier: state.earlier === true, error, events: state.events, loadEarlier, loading, loadingEarlier, reading: state.reading === true, rowsRead: num(state.rowsRead) }
}

const READ_AGAIN_MS = 300

function readingWords(rows) {
  return `Reading this run's history${num(rows) ? ` · ${num(rows).toLocaleString()} events so far` : '…'}`
}

/** A long run the backend is still reading: the page shows what it read so far. */
function ReadingNote({ run }) {
  return h('div', { className: 'roko-reading', 'data-testid': 'run-reading', role: 'status' }, h(Dot, { pulse: true, tone: 'live' }), `${readingWords(run.events_read)} · the page fills in as it reads`)
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
 * Every line of the run, with filters. While the run is live it follows the newest line, unless the person scrolled
 * up: then a pill offers to jump back.
 */
function ActivityFeed({ events: raw, startMs, error, loading, active, replayT, compact, onAll, earlier = false, onEarlier, loadingEarlier = false, reading = false, rowsRead = null }) {
  const events = useMemo(() => dedupeTools(raw), [raw])
  const [filter, setFilter] = useState('all')
  const box = useRef(null)
  const [pinned, setPinned] = useState(true)
  const [seen, setSeen] = useState(events.length)
  const shown = useMemo(() => events.filter(e => matchesFilter(e, filter)), [events, filter])
  // The newest 300 lines; earlier ↑ shows more, then reads more.
  const [span, setSpan] = useState(FEED_WINDOW)
  const lines = compact ? shown.slice(-5) : shown.slice(-span)
  const hidden = compact ? 0 : shown.length - lines.length
  const showEarlier = () => {
    if (hidden >= FEED_STEP) {
      setSpan(n => n + FEED_STEP)

      return
    }

    setSpan(n => n + hidden + FEED_STEP)
    onEarlier?.()
  }
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
      el.querySelector('[data-current="true"]')?.scrollIntoView?.({ block: 'nearest' })

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
    reading ? h('div', { className: 'roko-feed-reading', 'data-testid': 'feed-reading', role: 'status' }, h(Dot, { pulse: true, tone: 'live' }), readingWords(rowsRead)) : null,
    !lines.length && !loading && !error && !reading
      ? h('div', { className: 'roko-muted roko-feed-empty' }, events.length ? 'Nothing matches this filter.' : 'No events yet.')
      : null,
    h(
      'div',
      { 'aria-live': active && !compact ? 'polite' : undefined, className: 'roko-feed-list', onScroll, ref: box },
      !compact && (hidden > 0 || (earlier && onEarlier))
        ? h('button', { className: 'roko-feed-earlier', 'data-testid': 'feed-earlier', disabled: loadingEarlier, onClick: showEarlier, type: 'button' }, loadingEarlier ? 'reading earlier lines…' : hidden ? `earlier ↑ · ${hidden} more here` : 'earlier ↑')
        : null,
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

// --- Changes: the run's diff, and a guarded Merge

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

/** An image the run's work added under artifacts/, in Changes (phase 4 prep B); else the binary note. */
function ChangedShot({ path, runId }) {
  const shot = useShot(runId, path, Boolean(runId) && SHOT_PATH.test(path))

  return isRecord(shot.data)
    ? h('img', { alt: path, className: 'rk-diff-shot', src: dataUrl(shot.data) })
    : h('div', { className: 'roko-diff-note' }, h(Codicon, { name: 'file-binary', size: '0.85rem' }), shot.isLoading ? '…' : 'Binary file: no line changes to show.')
}

const SHOT_PATH = /^artifacts\/.+\.(png|jpe?g)$/i

function FileDiff({ file, index, open, onToggle, reviewCommand, runId }) {
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
          file.binary ? h(ChangedShot, { path: text(file.path), runId }) : null,
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
  const parts = workParts(run)
  const [picked, setPicked] = useState(null)
  // The verified work first, else the first part kept.
  const part = parts.length ? (parts.find(p => p.key === picked) ?? parts.find(p => p.trust === 'verified') ?? parts[0]) : null
  const query = useDiff(run.run_id, ended, part)
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

  const picker =
    parts.length > 1
      ? h(
          'div',
          { 'aria-label': 'Which work', className: 'rk-keyrow rk-work-parts', 'data-testid': 'work-parts', role: 'group' },
          parts.map(p =>
            h(
              Key,
              { 'aria-pressed': p.key === part?.key ? 'true' : 'false', key: p.key, onClick: () => setPicked(p.key), size: 's', testId: `work-part-${p.trust}` },
              h(LED, { size: 's', tone: p.trust === 'unverified' ? 'you' : 'pass' }),
              partLabel(p, parts.length > 1)
            )
          )
        )
      : null
  const unverified = part?.trust === 'unverified' || diff?.work === 'unverified'
  const banner = unverified
    ? h(
        'div',
        { className: 'rk-unverified', 'data-testid': 'unverified-banner', role: 'note' },
        h(LED, { tone: 'you' }),
        h(
          'span',
          null,
          h('b', null, 'Unverified: no check ran on this work. '),
          part && !part.delivered ? 'roko did not deliver it: it stays on its plan branch. ' : '',
          'Read it before you take it',
          part?.tasks.length ? ` (${part.tasks.map(t => text(t.task_id)).filter(Boolean).join(', ')})` : '',
          '.'
        )
      )
    : null

  if (query.isLoading) {
    return h(
      'div',
      { className: 'roko-stack' },
      picker,
      h(Skeleton, { className: 'roko-skel', style: { height: 28 } }),
      h(Skeleton, { className: 'roko-skel', style: { height: 160 } })
    )
  }

  if (query.error) {
    return h('div', { className: 'roko-stack' }, picker, h(ErrorNote, { error: query.error, onRetry: () => void query.refetch() }))
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
      'div',
      { className: 'roko-stack' },
      picker,
      diff?.why === 'elsewhere'
        ? h(
            Empty,
            { icon: 'remote', title: 'The changes are where roko runs' },
            text(diff.message) || 'This run kept its work on a plan branch of a workspace on another machine.',
            text(diff.command) ? h('span', { className: 'roko-empty-cmd' }, h(CopyCommand, { command: text(diff.command), label: 'Copy git diff', variant: 'ghost' })) : null
          )
        : h(
            Empty,
            { icon: 'git-compare', title: 'No changes to review' },
            text(diff?.message) ||
              (text(run.work?.kind) === 'none'
                ? 'This run left no changes.'
                : run.state === 'succeeded'
                  ? 'Its checks passed without it changing a file.'
                  : 'This run left no verified work on its branch.')
          )
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
    { className: 'roko-changes', 'data-testid': 'changes', 'data-trust': unverified ? 'unverified' : undefined },
    picker,
    banner,
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
      h(MergeControls, { diff, part, run })
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
          h(FileDiff, { file, index, key: `${text(file.path)}:${index}`, onToggle: () => toggle(index), open: !closed.has(index), reviewCommand, runId: part?.delivered === false ? null : run.run_id })
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
function MergeControls({ run, diff, part, compact }) {
  const { canAct } = useLimits()
  const [open, setOpen] = useState(false)
  const [, bump] = useState(0)
  // Work kept on a plan's branch (a part the run did not deliver) can be merged too, after a second yes.
  const delivered = isRecord(run.delivered) ? run.delivered : part && !part.delivered ? { merged: false } : null
  const ended = !isActiveRun(run)
  const done = mergeResults.get(run.run_id)
  const lookedUp = useDemoRun(run, Boolean(delivered) && run.demo === undefined)
  const demo = run.demo === true ? true : run.demo === false ? false : lookedUp
  // An older backend says nothing about an interrupted run's work, so it is left alone; a newer one says in `merge`
  // whether it can be merged (a yes asks for a second one: roko did not finish checking it).
  const holdBack = run.state === 'interrupted' && !isRecord(run.merge)
  const wanted = canAct && ended && Boolean(delivered) && delivered?.merged !== true && !done && demo === false && !holdBack
  const check = useMergeCheck(run.run_id, wanted, part)
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

  if (demo || data?.demo === true) {
    return h(DemoOutputNote, { compact })
  }

  if (holdBack) {
    // The why callout says what is kept and what to do.
    return null
  }

  if (!canAct) {
    return null
  }

  if (check.isLoading || demo === null) {
    return h(Button, { disabled: true, size: compact ? 'xs' : 'sm', type: 'button' }, h(Spinner, null), 'Checking…')
  }

  if (check.error || !data) {
    return compact ? null : h(CopyCommand, { command: run.merge_command, label: 'Copy merge command' })
  }

  // `available` from a newer backend; `can_merge` from every one.
  if (!(data.available ?? data.can_merge)) {
    const dirty = list(data.dirty).map(text).filter(Boolean)
    // The checkout's uncommitted tracked files stop Merge; when that is only roko.toml (the setup fix changed it),
    // the backend offers to commit it, previewed and applied like any other fix.
    const fix = compact || !isRecord(data.fix) ? null : readProblem({ fix: data.fix, id: 'merge-dirty', severity: 'warn', title: dirty.length ? `uncommitted: ${dirty.join(', ')}` : 'commit first' })

    return h(
      'span',
      { className: 'roko-merge-blocked', 'data-testid': 'merge-blocked' },
      h(
        Tip,
        { label: text(data.reason) || 'Merge is not available here' },
        h(
          'span',
          { className: 'roko-merge-why', tabIndex: 0 },
          h(Codicon, { name: 'circle-slash', size: '0.75rem' }),
          compact ? 'Merge unavailable' : dirty.length ? 'Commit your changes first' : clip(data.reason, 70) || 'Merge unavailable'
        )
      ),
      !compact && dirty.length ? h('span', { className: 'roko-muted' }, `uncommitted: ${clip(dirty.join(', '), 80)}`) : null,
      fix ? h('span', { className: 'rk-merge-fix', 'data-testid': 'merge-fix' }, h(FixControl, { onDone: () => afterChange(run.run_id), problem: fix })) : null,
      compact || fix ? null : h(CopyCommand, { command: data.command || run.merge_command, label: 'Copy merge command' })
    )
  }

  const into = text(data.into) || 'the checkout'
  const mode = data.mode === 'merge' ? 'merge commit' : 'fast-forward'
  const commit = text(diff?.commit) || text(data.commit)
  const totals = isRecord(diff?.totals) ? diff.totals : null
  // Unverified or partly verified work: the backend's sentence, and a second yes the POST carries. Partial work
  // (some of it unchecked, or checks roko never finished) is "not fully checked"; work no check ran on, "unverified".
  const confirm = text(data.confirm)
  const partly = text(data.work) === 'partial'

  return h(
    Fragment,
    null,
    h(
      Key,
      { className: 'roko-merge-btn', onClick: () => setOpen(true), size: compact ? 's' : 'l', testId: 'merge-button', tone: 'primary' },
      h(Codicon, { name: 'git-merge', size: '0.8rem' }),
      h('span', null, confirm ? 'Merge anyway…' : `Merge into ${clip(into, 24)}`),
      confirm ? h('span', { className: 'rk-tag', 'data-channel': 'you' }, partly ? 'not fully checked' : 'unverified') : null,
      compact ? null : h('span', { className: 'roko-merge-mode' }, mode)
    ),
    h(ConfirmDialog, {
      confirmLabel: confirm ? (partly ? 'Merge anyway' : 'Merge unverified work') : 'Merge',
      description: h(
        'span',
        { className: 'roko roko-merge-confirm' },
        confirm ? h('span', { className: 'roko-merge-line rk-merge-confirm-why', 'data-testid': 'merge-confirm-why' }, confirm) : null,
        h(
          'span',
          { className: 'roko-merge-line' },
          totals ? `${plural(num(totals.files) ?? 0, 'file')}, ` : '',
          totals ? h('span', { className: 'roko-add' }, `+${num(totals.additions) ?? 0}`) : null,
          totals ? ' ' : '',
          totals ? h('span', { className: 'roko-del' }, `−${num(totals.deletions) ?? 0}`) : null
        ),
        h('span', { className: 'roko-merge-line roko-mono' }, `${commit.slice(0, 8) || 'the run’s commit'} → ${into} · ${mode}`),
        // The project by its folder's name; its full path (an account name, often) only on hover (hermes-pilot PW-3).
        delivered.workspace ? h('span', { className: 'roko-merge-line roko-muted', title: text(delivered.workspace) }, `in ${folderName(delivered.workspace)}`) : null,
        h('span', { className: 'roko-merge-line roko-muted' }, 'Only the commit you reviewed is merged. You get the command to undo it.')
      ),
      onClose: () => setOpen(false),
      onConfirm: async () => {
        let reply

        try {
          reply = await post(`/runs/${enc(run.run_id)}/merge`, {
            ...(commit ? { commit } : {}),
            ...(confirm ? { confirm: true } : {}),
            // A part the run kept on a plan branch is named; the delivered work is the default.
            ...(part && !part.delivered ? { work: part.trust, ...(part.planId ? { plan_id: part.planId } : {}) } : {})
          })
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
      title: confirm ? (partly ? `Merge work roko did not fully check into ${into}?` : `Merge this unverified work into ${into}?`) : `Merge this run’s work into ${into}?`
    })
  )
}

// --- A run: hero, why, now, the graph and its inspector, activity, changes

/** What a `next` action is called when the backend gives no label. */
const NEXT_LABELS = { 'commit-roko-toml': 'commit roko.toml', merge: 'review & merge', rerun: 'run it again', review: 'review the work' }

/**
 * The one thing to do next with an ended run (the card's `next`): review or merge its work, commit roko.toml so
 * Merge can work, or run it again (an interrupted run, a failed one). Nothing from an older backend.
 */
function NextKey({ run, view, onView }) {
  const { canAct } = useLimits()
  const next = isRecord(run.next) ? run.next : {}
  const action = text(next.action)
  const label = text(next.label) || NEXT_LABELS[action] || ''
  const why = text(next.why)

  if (!label || (view === 'changes' && action !== 'rerun')) {
    return null
  }

  if (!action) {
    // Nothing to press: the backend's words say what is next.
    return h('span', { className: 'rk-next roko-muted', 'data-action': 'none', 'data-testid': 'next' }, why ? h(Tip, { label: why }, h('span', null, label)) : label)
  }

  let key = null

  if (action === 'merge' || action === 'review' || action === 'commit-roko-toml') {
    key = h(Key, { onClick: () => onView('changes'), size: 's', testId: 'next-key', tone: 'primary' }, h(Codicon, { name: action === 'review' ? 'git-compare' : action === 'merge' ? 'git-merge' : 'check', size: '0.75rem' }), label)
  } else if (action === 'rerun' && canAct) {
    // The composer, on the run's plan with "skip tasks that already passed" ticked (or on its request), at its cap;
    // after a stop at its cap, at the higher cap the backend suggests (`next.max_usd`), snapped up to the knob's
    // detents (dogfood R2-3). The composer holds it to what may be spent; nothing starts until the person presses.
    const raised = num(next.max_usd)
    const cap = raised !== null && raised > 0 ? (CAP_PRESETS.find(c => c >= raised - 1e-9) ?? raised) : num(run.max_usd)
    const again =
      run.kind === 'plan' && validId(run.plan_id)
        ? { cap, plan: run.plan_id, resume: true }
        : text(run.request)
          ? { cap, mode: 'run', plan: null, prompt: text(run.request), resume: false }
          : null

    key = again
      ? h(Key, { onClick: () => openComposer(again), size: 's', testId: 'next-key', tone: 'primary' }, h(Codicon, { name: 'debug-restart', size: '0.75rem' }), label)
      : null
  }

  return key ? h('span', { className: 'rk-next', 'data-action': action, 'data-testid': 'next' }, why ? h(Tip, { label: why }, key) : key) : null
}

function CancelRun({ run, size = 'sm', keyed = false }) {
  const { canAct } = useLimits()
  const [open, setOpen] = useState(false)

  // On the run page, ⌘. asks to cancel, as a Mac app's Cancel does (spec v3 §5.2).
  useEffect(() => {
    if (!keyed || !canAct) {
      return undefined
    }

    const onKey = event => {
      if (event.key === '.' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        setOpen(true)
      }
    }

    window.addEventListener('keydown', onKey)

    return () => window.removeEventListener('keydown', onKey)
  }, [keyed, canAct])

  if (!canAct) {
    return null
  }

  return h(
    Fragment,
    null,
    h(Key, { 'aria-label': 'Stop run', kbd: keyed ? '⌘.' : undefined, onClick: () => setOpen(true), size: size === 'xs' ? 's' : undefined, tone: 'ghost' }, 'stop'),
    h(ConfirmDialog, {
      confirmLabel: 'Stop run',
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
      title: 'Stop this roko run?'
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

/** The router's latest pick for a running task, from the card (attempt_log) or the run's loop events. */
function latestRoute(run, live) {
  const tasks = list(run.tasks).filter(isRecord)
  // The try running now: a running task's route first, since a task waiting its turn can be routed later.
  const running = new Set(tasks.filter(t => t.outcome === 'running').map(t => text(t.task_id)))
  const ours = id => !running.size || running.has(text(id))
  const fromLoops = [...list(live?.loops)].reverse().find(l => (l.kind === 'route' || l.kind === 'failover') && text(l.data?.model) && ours(l.task_id))

  if (fromLoops) {
    return { ...fromLoops.data, task_id: fromLoops.task_id }
  }

  // Else the newest route on the card, by when its try started (not the last task's).
  const routes = tasks.filter(t => ours(t.task_id)).flatMap(t => list(t.attempt_log).filter(a => isRecord(a) && isRecord(a.route)).map(a => ({ at: parseTime(a.started_at) ?? 0, route: a.route, task: text(t.task_id) })))
  const newest = routes.reduce((best, r) => (!best || r.at >= best.at ? r : best), null)

  return newest ? { ...newest.route, task_id: newest.task } : null
}

// --- Ceremony (spec v3 §2.10, §6): the novelty store, the transition tiers, the end of a run

/**
 * How many times this workspace has seen each first: a run ended, a climb, a lesson, a lesson that paid off, a merge,
 * a plan. Kept in ctx.storage per roko serve, so the first climb plays as a Moment and the hundredth as a Gesture.
 */
let noveltyCounts = null

function noveltyScope() {
  const data = queryClient.getQueryData(projectKey(KEYS.overview))

  // 0.7: a project's serve may come up on another port each time; the project is what stays.
  return text(data?.project?.path) || text(data?.connection?.url) || 'roko'
}

/** Count one more of `event` here and say how many times it has now been seen (1 the first time). */
function noteNovelty(event) {
  if (!noveltyCounts) {
    try {
      noveltyCounts = doors?.storage?.get?.('novelty', {}) ?? {}
    } catch {
      noveltyCounts = {}
    }
  }

  const scope = noveltyScope()
  const seen = isRecord(noveltyCounts[scope]) ? noveltyCounts[scope] : {}
  const count = (num(seen[event]) ?? 0) + 1

  noveltyCounts = { ...noveltyCounts, [scope]: { ...seen, [event]: count } }

  try {
    doors?.storage?.set?.('novelty', noveltyCounts)
  } catch {
    // Firsts are a nicety.
  }

  return count
}

/**
 * The tier an event plays at (bardo's novelty, spec v3 §6): its top tier the first time, one lower the 2nd to the
 * 5th, two lower (never below T1) up to the 20th, then T1 at most. T0 ambient … T4 cinematic.
 */
function ceremonyTier(top, count) {
  if (count <= 1) {
    return top
  }

  if (count <= 5) {
    return Math.max(1, top - 1)
  }

  return count <= 20 ? Math.max(1, top - 2) : Math.min(1, top)
}

/** The stamp a run's end declares, with its tone (spec v3 §4.7, §6). */
function endStamp(run) {
  if (capStopped(run)) {
    return { tone: 'you', word: dayStopped(run) ? 'stopped at limit' : 'stopped at cap' }
  }

  return (
    {
      cancelled: { tone: 'ink', word: 'cancelled' },
      failed: { tone: 'fail', word: 'failed' },
      interrupted: { tone: 'you', word: 'signal lost' },
      succeeded: { tone: 'pass', word: 'passed' },
      unverified: { tone: 'you', word: 'unverified' }
    }[text(run.state)] ?? null
  )
}

/**
 * The end of a run seen as it happens (spec v3 §6): a scanline when it passed, its stamp held for a Moment, and the
 * workspace's first ever end prints its receipt line by line. {tier, stamp, at} while it plays, or null.
 */
function useEndMoment(run) {
  const was = useRef(isActiveRun(run) ? 'active' : 'ended')
  const [moment, setMoment] = useState(null)

  useEffect(() => {
    const active = isActiveRun(run)
    const before = was.current

    was.current = active ? 'active' : 'ended'

    if (active || before !== 'active' || !endStamp(run)) {
      return undefined
    }

    const tier = ceremonyTier(run.state === 'succeeded' ? 4 : 3, noteNovelty('run_ended'))
    // The first failure this workspace sees types its why out (spec v3 §5.2); later ones just say it.
    const first = run.state === 'failed' && !capStopped(run) && noteNovelty('run_failed') <= 1

    setMoment({ at: Date.now(), first, stamp: endStamp(run), tier })

    const timer = setTimeout(() => setMoment(null), tier >= 4 ? 3_200 : 1_200)

    return () => clearTimeout(timer)
  }, [run?.state])

  return moment
}

/**
 * Text that types itself out once (the why of a failed run the first time, spec v3 §5.2), 30 ms a character, with
 * the rose cursor while it types. Assistive tech gets the whole text at once; with reduced motion so does the eye.
 */
function TypeOut({ value }) {
  const full = text(value)
  const [n, setN] = useState(reducedMotion() ? full.length : 0)

  useEffect(() => {
    if (n >= full.length) {
      return undefined
    }

    const timer = setTimeout(() => setN(m => Math.min(full.length, m + 3)), 90)

    return () => clearTimeout(timer)
  }, [n, full])

  return h(
    Fragment,
    null,
    h('span', { className: 'rk-sr' }, full),
    h('span', { 'aria-hidden': 'true', 'data-testid': 'type-out' }, full.slice(0, n), n < full.length ? h('span', { className: 'rk-cursor' }) : null)
  )
}

/** A batch branch by its run's short id, as roko's headline says it: roko/batch/ddf4e5b1. */
function shortBranch(branch) {
  return text(branch).replace(/\/([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, '/$1')
}

/** "+287 −3 in 9 files" from a part's counts or a diffstat sentence. */
function changesWords(work, delivered) {
  const parts = workParts({ work })
  const counts = isRecord(work?.parts?.[0]?.counts) ? work.parts[0].counts : null
  const stat = text(delivered?.diffstat) || text(parts[0]?.diffstat)
  const said = re => {
    const m = re.exec(stat)

    return m ? Number.parseInt(m[1], 10) : null
  }
  const add = num(counts?.additions) ?? said(/(\d+) insertions?/)
  const del = num(counts?.deletions) ?? said(/(\d+) deletions?/)
  const files = num(counts?.files) ?? said(/(\d+) files? changed/) ?? list(delivered?.files_changed).length

  return [add !== null || del !== null ? `+${add ?? 0} −${del ?? 0}` : '', files ? `in ${plural(files, 'file')}` : ''].filter(Boolean).join(' ')
}

/**
 * What the run's work would have cost on the ladder's top rung (≈): its tokens at that rung's list prices (spec v3
 * §4.6, ShadowComparison). From the backend's `receipt` when it gives one, else from the card's tokens and ladder.
 */
function topRungCost(run) {
  const receipt = isRecord(run.receipt) ? run.receipt : null
  const ladderTop = list(run.ladder).filter(isRecord).at(-1)

  if (receipt && 'top_rung_usd' in receipt) {
    const top = isRecord(receipt.top_rung) ? receipt.top_rung : ladderTop
    const model = text(top?.slug) || text(top?.model) || text(top?.rung)

    // The backend's conservative counterfactual (0.6.0 `receipt`: the passing tries' tokens at the top rung's prices),
    // or why it has none ("no task passed: nothing to compare", "no list price for …"); the tasks it leaves out.
    return {
      backend: true,
      basis: text(receipt.basis),
      detail: text(receipt.basis_detail),
      model,
      notCompared: num(receipt.not_compared) ?? 0,
      ratio: num(receipt.ratio),
      usd: num(receipt.top_rung_usd)
    }
  }

  const tokens = isRecord(run.tokens) ? run.tokens : null

  if (!ladderTop || !tokens || num(ladderTop.price_in) === null || num(ladderTop.price_out) === null) {
    return null
  }

  const usd = ((num(tokens.input) ?? 0) * num(ladderTop.price_in) + (num(tokens.output) ?? 0) * num(ladderTop.price_out) + (num(tokens.cache_read) ?? 0) * (num(ladderTop.price_cache_read) ?? num(ladderTop.price_in) * 0.1)) / 1e6

  return usd > 0 ? { backend: false, basis: '≈ from run totals, failed tries included', detail: 'the run’s tokens at the top rung’s list prices; a stronger model might use fewer', model: text(ladderTop.slug) || text(ladderTop.model), notCompared: 0, ratio: null, usd } : null
}

/**
 * The top rung's ≈ against what the run cost, in words (spec v3 §4.6, the lead's rule): 1.25 or more "this cost 8× less"
 * (one decimal below 10), 0.8 to 1.25 "about the same", below 0.8 "the climb cost more this time" (neutral: information).
 */
function timesWords(times) {
  const n = v => (v >= 10 ? String(Math.round(v)) : String(Number(v.toFixed(1))))

  return times >= 1.25 ? `this cost ${n(times)}× less` : times >= 0.8 ? 'about the same' : 'the climb cost more this time'
}

/**
 * The Receipt (spec v3 §4.6): mono lines as a teenage engineering device prints them: where the work passed, its
 * top-rung cost (≈), what changed, what roko learned; then review and the backend's next step. Unverified work says
 * no check ran, in orange. `print` types it out line by line (the first ever).
 */
function Receipt({ run, onView, print = false, compact = false }) {
  const receipt = isRecord(run.receipt) ? run.receipt : null
  const laid = ladderRows(run)
  const cost = num(run.cost_usd)
  const top = topRungCost(run)
  const delivered = isRecord(run.delivered) ? run.delivered : null
  const work = isRecord(run.work) ? run.work : null
  const kind = text(work?.kind)
  const lines = []
  const [shown, setShown] = useState(print && !reducedMotion() ? 0 : 99)

  useEffect(() => {
    if (shown >= 99) {
      return undefined
    }

    const timer = setTimeout(() => setShown(n => n + 1), 500)

    return () => clearTimeout(timer)
  }, [shown])

  if (laid) {
    const rows = laid.rows.slice().reverse()
    // A task that climbed is said once, as a climb; the others by the rung they passed on; then the ones that did
    // not pass, where they stopped. "Nothing above" only when the run passed below a rung it could still have used.
    const passedOn = rows
      .map(r => [r, r.tokens.filter(t => t.state === 'passed' && !t.climbed)])
      .filter(([, ts]) => ts.length)
      .map(([r, ts]) => {
        const via = ts.filter(t => t.failover).length

        return `${ts.length} passed on ${text(r.rung.rung)}${via ? (via === ts.length ? ' via failover' : ` (${via} via failover)`) : ''}`
      })
    const climbed = rows.filter(r => r.tokens.some(t => t.climbed && t.state === 'passed')).map(r => `${r.tokens.filter(t => t.climbed && t.state === 'passed').length} climbed to ${text(r.rung.rung)}`)
    const failedOn = rows
      .map(r => [r, r.tokens.filter(t => t.state === 'failed')])
      .filter(([, ts]) => ts.length)
      .map(([r, ts]) => `${ts.length > 2 ? `${ts.length} tasks` : ts.map(t => t.id).join(', ')} failed on ${text(r.rung.rung)}${ts.some(t => t.exhausted) ? `, the ladder’s last rung for ${ts.length > 1 ? 'them' : 'it'}` : ''}`)
    const stoppedOn = rows
      .map(r => [r, r.tokens.filter(t => t.state === 'stopped' && list(run.tasks).some(task => isRecord(task) && text(task.task_id) === t.id && list(task.climb).length))])
      .filter(([, ts]) => ts.length)
      .map(([r, ts]) => `${ts.length > 2 ? `${ts.length} tasks` : ts.map(t => t.id).join(', ')} stopped on ${text(r.rung.rung)}`)
    const usable = rows.map((r, i) => (r.rung.chat_ok !== false ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    const highest = rows.map((r, i) => (r.tokens.some(t => t.state !== 'waiting') ? i : -1)).reduce((a, b) => Math.max(a, b), -1)
    const words = [...passedOn, ...climbed, ...failedOn, ...stoppedOn]

    lines.push(['ladder', [...(passedOn.length || climbed.length ? [] : ['no task passed']), ...words, run.state === 'succeeded' && highest >= 0 && highest < usable ? 'nothing above' : ''].filter(Boolean).join(' · '), null])
  } else if (modelsOf(run).length) {
    lines.push(['models', modelsOf(run).slice(0, 3).join(' · '), null])
  }

  // The top-rung comparison (spec v3 §4.6): the backend's prices only the passing tries, so it stands for any run
  // that ended, with the tasks it leaves out counted; worked out here from a run's totals, only for a run that passed.
  if (top && (top.backend ? !isActiveRun(run) : run.state === 'succeeded')) {
    const times = top.usd === null ? null : (top.ratio ?? (cost ? top.usd / cost : null))
    const basis = top.basis ? `≈ ${top.basis.replace(/^≈\s*/, '')}` : ''

    if (top.usd === null) {
      // No ratio (no task passed, or no price): the backend's own words, and nothing else.
      lines.push(['top rung', top.basis || `${top.model}: no estimate`, top.detail || null, 'dim'])
    } else {
      lines.push([
        'top rung',
        h(Fragment, null, `≈ ${money(top.usd)} on ${top.model}`, times !== null ? h('span', { className: times >= 1.25 ? 'rk-receipt-good' : undefined }, ` · ${timesWords(times)}`) : null),
        top.detail || null
      ])

      // Its basis, in full, on a mono line of its own (not only in a hover).
      if (basis) {
        lines.push(['', basis, top.detail || null, 'basis'])
      }
    }

    if (top.notCompared > 0) {
      lines.push(['', `${plural(top.notCompared, 'task')} didn’t pass: not compared`, null, 'basis'])
    }
  }

  lines.push(['rule'])

  // The backend's counts (0.6.0 `receipt.changes`), else the card's work and delivery.
  const counted = isRecord(receipt?.changes) ? receipt.changes : null
  const changes = counted
    ? [num(counted.additions) !== null || num(counted.deletions) !== null ? `+${num(counted.additions) ?? 0} −${num(counted.deletions) ?? 0}` : '', num(counted.files) ? `in ${plural(num(counted.files), 'file')}` : ''].filter(Boolean).join(' ')
    : changesWords(work, delivered)
  const branch = text(counted?.branch) || text(delivered?.branch) || text(work?.parts?.[0]?.branch)
  const kindNow = text(counted?.kind) || kind
  const nothing = kindNow === 'none' || (counted && !num(counted.files) && !num(counted.additions) && !num(counted.deletions))

  if (nothing) {
    lines.push(['changes', 'no changes', null])
  } else if (changes || branch) {
    // A run that did not pass keeps only its passed tasks' work: say whose, not a bare "verified" beside FAILED.
    const passed = hasEnded(run) && run.state !== 'succeeded' ? list(run.tasks).filter(t => isRecord(t) && t.outcome === 'passed').map(t => text(t.task_id)) : []
    const verified = passed.length ? `verified: ${passed.length > 3 ? plural(passed.length, 'passed task') : passed.join(', ')}` : 'verified'
    const trust = kindNow === 'unverified' ? 'unverified: no check ran' : kindNow === 'partial' ? 'partly verified' : counted?.merged || delivered?.merged ? 'merged' : verified

    lines.push(['changes', [changes, branch ? clip(shortBranch(branch), 40) : '', trust].filter(Boolean).join(' · '), branch || null, kindNow === 'unverified' ? 'you' : null])
  } else if (!isActiveRun(run)) {
    lines.push(['changes', kindNow === 'none' || !delivered ? 'no changes' : '—', null])
  }

  const lessons = list(run.tasks)
    .filter(isRecord)
    .flatMap(t => list(t.lessons).filter(isRecord))
  const kept = num(receipt?.lessons_kept) ?? lessons.filter(l => /admitted/.test(text(l.admission))).length
  const confirmed = num(receipt?.lessons_confirmed) ?? lessons.reduce((n, l) => n + (num(l.reinforced) ?? 0), 0)
  const used = num(receipt?.lessons_used)

  if (kept || confirmed || used) {
    lines.push(['learned', ['◇', kept ? `kept ${plural(kept, 'lesson')}` : '', confirmed ? `confirmed ${confirmed} it had` : '', used ? `${plural(used, 'lesson')} in its prompts` : ''].filter(Boolean).join(' · ').replace('◇ · ', '◇ '), null, 'learn'])
  }

  const demo = run.demo === true || run.merge?.demo === true

  return h(
    Glass,
    { className: 'rk-receipt', testId: 'receipt' },
    h(
      'div',
      { className: 'rk-receipt-lines' },
      lines.slice(0, shown).map((line, i) =>
        line[0] === 'rule'
          ? h('div', { 'aria-hidden': 'true', className: 'rk-receipt-rule', key: i })
          : h(
              'div',
              { className: 'rk-receipt-line', 'data-tone': line[3] ?? undefined, key: `${line[0]}:${i}`, title: line[2] ?? undefined },
              h('span', { className: 'rk-receipt-k' }, line[0]),
              h('span', { className: 'rk-receipt-v' }, line[1])
            )
      )
    ),
    compact
      ? demo
        ? h('span', { className: 'rk-receipt-note' }, 'demo output: stays on its branch')
        : null
      : h(
          'div',
          { className: 'rk-receipt-keys' },
          demo ? h('span', { className: 'rk-receipt-note' }, 'demo output: stays on its branch') : null,
          (delivered || workParts(run).length) && onView ? h(Key, { onClick: () => onView('changes'), size: 's' }, 'review changes') : null,
          isRecord(run.next) && (text(run.next.action) || text(run.next.label)) ? h(NextKey, { onView: onView ?? (() => undefined), run, view: null }) : null
        )
  )
}

// -- Build glass: what a check prints, read as an instrument --

// cmake (Unix Makefiles) and ninja progress, a compile unit's object, a link and a finished target.
const CHECK_PCT = /^\[\s*(\d{1,3})%\]\s+(.*)$/
const CHECK_NINJA = /^\[(\d{1,6})\/(\d{1,6})\]\s+(.*)$/
const CHECK_UNIT = /\b(?:Building|Compiling) (?:CXX|C|OBJCXX|OBJC|ASM) object (\S+?)(?:\.(?:o|obj))?$/
const CHECK_LINK = /\bLinking (?:CXX|C|OBJCXX) (?:static library|shared library|shared module|executable|module library|CFBundle shared module)\s+(\S+)/
const CHECK_TARGET = /\bBuilt target (\S+)/
// A compiler's diagnostic (clang, gcc: path:line[:col]: severity: message), the source line and the caret under it.
const CHECK_DIAG = /^(\S(?:.*?\S)?):(\d{1,7}):(?:(\d{1,5}):)?\s+(fatal error|error|warning):\s+(.+)$/
const CHECK_CODE = /^\s*(\d{1,7})\s*\|\s?(.*)$/
const CHECK_CARET = /^\s*\|(\s*[~^ ]*\^[~^ ]*)\s*$/
const CHECK_LINKER = /^(?:Undefined symbols for architecture \S+:|ld: .+|clang(?:\+\+)?: error: linker command failed.*)$/
// ctest, doctest and Catch2: the tests a check ran, the first that failed, and what it saw.
const CHECK_CTEST = /^\s*\d+\/\d+\s+Test\s+#\d+:\s+(\S+)\s+\.*\s*(?:\*{3})?(Passed|Failed|Not Run|Timeout|Exception\S*|Subprocess aborted|SEGFAULT)\s+([\d.]+)\s+sec/i
const CHECK_CTEST_SUM = /(\d{1,3})% tests passed, (\d+) tests? failed out of (\d+)/
const CHECK_DOCTEST_SUM = /^\[doctest\] test cases:\s*(\d+)\s*\|\s*(\d+) passed\s*\|\s*(\d+) failed/
const CHECK_DOCTEST_ERR = /^(\S(?:.*?\S)?):(\d{1,7}):\s+(?:FATAL ERROR|ERROR):\s+(.+)$/
const CHECK_DOCTEST_CASE = /^TEST CASE:\s+(.+)$/
const CHECK_CATCH = /^(\S(?:.*?\S)?):(\d{1,7}): FAILED:$/
const CHECK_VALUES = /^\s*values:\s+(.+)$/
const CHECK_LOGGED = /^\s*logged:\s+(.+)$/
// CMake's own errors: at a line of a CMakeLists file (its message indented under it), or in the presets file.
const CHECK_CMAKE_AT = /^CMake (Error|Warning)(?: \(dev\))? at (\S+?):(\d{1,7}) \([^)]{1,80}\):$/
const CHECK_CMAKE = /^CMake Error: (.+)$/
const CHECK_PRESET = /^Error: @(\d{1,7}),(\d{1,5}): (.+)$/
// A harness's own verdict line (Undertow's tools/spec.sh), and pluginval's sections and end.
const CHECK_SPEC_FAIL = /^spec: FAIL (\S+): (.+)$/
const CHECK_PLUGINVAL = /^Starting tests? in:\s+(.+?)(?:\.\.\.)?$/
const CHECK_PLUGINVAL_END = /^(SUCCESS|FAILURE)$|All tests completed successfully|\*{3} FAILED/

/** The last `n` segments of a path: where something is, without the folders above the project. */
function lastSegments(path, n = 3) {
  return text(path).split('/').filter(Boolean).slice(-n).join('/')
}

/**
 * What a check printed: build progress, the first error (compiler, linker, CMake) with its source line and caret,
 * the tests and the first failure, pluginval's sections, a harness's verdict. Untrusted: only matched and cut.
 */
function readCheck(lines) {
  const out = { build: null, error: null, errors: 0, failure: null, pluginval: null, tests: null, verdict: null, warnings: 0 }
  const tests = []
  let sum = null
  let lastCase = null

  for (let i = 0; i < lines.length; i++) {
    const line = text(lines[i]).replace(/\s+$/, '')
    const pct = CHECK_PCT.exec(line)
    const ninja = pct ? null : CHECK_NINJA.exec(line)
    let m

    if (pct || ninja) {
      const b = out.build ?? (out.build = { dir: '', linking: null, percent: 0, recent: [], targets: [], unit: null, units: 0 })
      const rest = pct ? pct[2] : ninja[3]
      const unit = CHECK_UNIT.exec(rest)
      const link = CHECK_LINK.exec(rest)
      const done = CHECK_TARGET.exec(rest)

      b.percent = Math.min(100, Math.max(b.percent, pct ? Number(pct[1]) : Math.round((Number(ninja[1]) / Math.max(1, Number(ninja[2]))) * 100)))

      if (unit) {
        // libs/core/CMakeFiles/core.dir/src/X.cpp.o is libs/core/src/X.cpp.
        const object = unit[1].replace(/\.(o|obj)$/, '')
        const parts = (object.includes('/CMakeFiles/') ? `${object.split('/CMakeFiles/')[0]}/${object.split('.dir/').pop()}` : object).split('/').filter(Boolean)

        b.units += 1
        b.unit = parts.at(-1) ?? null
        b.dir = parts.slice(-3, -1).join('/')
        b.linking = null
      } else if (link) {
        b.linking = lastSegments(link[1], 1)
      } else if (done) {
        b.targets = [...b.targets, done[1]].slice(-8)
        b.linking = null
      }

      b.recent = [...b.recent, line].slice(-3)
    } else if ((m = CHECK_DIAG.exec(line))) {
      if (m[4] === 'warning') {
        out.warnings += 1
      } else {
        out.errors += 1

        if (!out.error) {
          const code = CHECK_CODE.exec(text(lines[i + 1]))
          const caret = code ? CHECK_CARET.exec(text(lines[i + 2])) : null

          out.error = {
            caret: caret ? caret[1].replace(/\s+$/, '') : null,
            code: code ? code[2].slice(0, 200) : null,
            col: m[3] ? Number(m[3]) : null,
            file: lastSegments(m[1]),
            kind: m[4],
            line: Number(m[2]),
            lineNo: code ? code[1] : null,
            message: m[5].slice(0, 240)
          }
        }
      }
    } else if (CHECK_LINKER.test(line)) {
      if (!/linker command failed/.test(line)) {
        out.errors += 1
        out.error = out.error ?? { caret: null, code: null, col: null, file: null, kind: 'linker', line: null, lineNo: null, message: line.slice(0, 240) }
      }
    } else if ((m = CHECK_CTEST.exec(line))) {
      tests.push({ name: m[1], passed: /^passed$/i.test(m[2]), seconds: Number(m[3]) })
    } else if ((m = CHECK_CTEST_SUM.exec(line))) {
      sum = { failed: Number(m[2]), passed: Number(m[3]) - Number(m[2]), total: Number(m[3]) }
    } else if ((m = CHECK_DOCTEST_SUM.exec(line))) {
      sum = { failed: Number(m[3]), passed: Number(m[2]), total: Number(m[1]) }
    } else if ((m = CHECK_DOCTEST_CASE.exec(line))) {
      lastCase = m[1].trim().slice(0, 120)
    } else if ((m = CHECK_DOCTEST_ERR.exec(line) ?? CHECK_CATCH.exec(line))) {
      if (!out.failure) {
        // doctest says `values: …` under its assertion; Catch2 says "with expansion:" and then what it saw.
        const values = CHECK_VALUES.exec(text(lines[i + 1])) ?? CHECK_VALUES.exec(text(lines[i + 2]))
        const expansion = /^\s*with expansion:\s*$/.test(text(lines[i + 2])) ? text(lines[i + 3]).trim() : ''
        const expr = m[3] ?? text(lines[i + 1]).trim()

        const logged = [1, 2, 3].map(k => CHECK_LOGGED.exec(text(lines[i + k]))).find(Boolean)

        out.failure = { case: lastCase, expr: expr.replace(/ is NOT correct!$/, '').slice(0, 200), logged: logged ? logged[1].slice(0, 240) : null, values: values ? values[1].slice(0, 200) : expansion.slice(0, 200) || null, where: `${lastSegments(m[1], 2)}:${m[2]}` }
      }
    } else if ((m = CHECK_CMAKE_AT.exec(line))) {
      if (m[1] === 'Warning') {
        out.warnings += 1
      } else {
        const said = []

        for (let j = i + 1; j < lines.length && said.length < 3 && /^\s+\S/.test(text(lines[j])); j++) {
          said.push(text(lines[j]).trim())
        }

        out.errors += 1
        out.error = out.error ?? { caret: null, code: null, col: null, file: lastSegments(m[2]), kind: 'CMake error', line: Number(m[3]), lineNo: null, message: (said.join(' ') || line).slice(0, 240) }
      }
    } else if ((m = CHECK_CMAKE.exec(line))) {
      out.errors += 1
      out.error = out.error ?? { caret: null, code: null, col: null, file: null, kind: 'CMake error', line: null, lineNo: null, message: m[1].replace(/\s+from\s+\S*\/\.roko\/worktrees\/\S+$/, '').replace(/:$/, '').slice(0, 240) }
    } else if ((m = CHECK_PRESET.exec(line))) {
      // Under "could not read presets": the presets file's line and column, the line it quotes, its caret.
      if (!out.error || (out.error.kind === 'CMake error' && !out.error.file)) {
        const caret = /^\s*\^\s*$/.test(text(lines[i + 2])) ? ` ${text(lines[i + 2]).replace(/\s+$/, '')}` : null

        out.error = { caret, code: text(lines[i + 1]).trim() ? text(lines[i + 1]).slice(0, 200) : null, col: Number(m[2]), file: 'CMakePresets.json', kind: 'CMake error', line: Number(m[1]), lineNo: m[1], message: m[3].slice(0, 240) }
      }
    } else if ((m = CHECK_SPEC_FAIL.exec(line))) {
      out.verdict = { target: m[1], words: m[2].slice(0, 240) }
    } else if ((m = CHECK_PLUGINVAL.exec(line))) {
      const pv = out.pluginval ?? (out.pluginval = { current: null, result: null, sections: 0 })

      pv.sections += 1
      pv.current = m[1].replace(/^pluginval\s*\/\s*/, '').slice(0, 80)
    } else if (out.pluginval && CHECK_PLUGINVAL_END.test(line)) {
      out.pluginval.result = /SUCCESS|completed successfully/.test(line) ? 'passed' : 'failed'
    }
  }

  if (tests.length || sum) {
    const first = tests.find(t => !t.passed)

    out.tests = { failed: sum?.failed ?? tests.filter(t => !t.passed).length, list: tests.slice(-48), passed: sum?.passed ?? tests.filter(t => t.passed).length, total: sum?.total ?? tests.length }
    out.failure = out.failure ? { ...out.failure, case: out.failure.case ?? first?.name ?? null } : first ? { case: first.name, expr: null, logged: null, values: null, where: null } : null
  }

  return out
}

/** Whether a read check has anything the glass can show beyond its lines. */
function hasGlass(read) {
  return Boolean(read.build || read.error || read.tests || read.pluginval || read.verdict)
}

/** A check's state in a few words, for the horizon and a pad: "building 66% · Oversampler.cpp". */
function checkWords(read, gate) {
  if (read.error) {
    return `✕ ${read.error.file ? `${lastSegments(read.error.file, 1)}${read.error.line ? `:${read.error.line}` : ''} ` : ''}${clip(read.error.message, 70)}`
  }

  if (read.tests && read.tests.total) {
    return `tests ${read.tests.passed}/${read.tests.total}${read.tests.failed ? ` · ✕ ${clip(read.failure?.case, 40)}` : ''}`
  }

  if (read.build) {
    return read.build.linking ? `linking ${read.build.linking} · ${read.build.percent}%` : `building ${read.build.percent}%${read.build.unit ? ` · ${read.build.unit}` : ''}`
  }

  if (read.pluginval) {
    return `pluginval · ${read.pluginval.current ?? 'starting'}`
  }

  return `checking ${clip(gate, 40)}`
}

/** How many lines of one check this window keeps, and how many checks. */
const CHECK_KEEP = 300
const CHECK_LOGS = 60
/** Each check's lines as the socket brought them, by run, task, check and try: `{lines, notes}`. */
const checkLog = new Map()

function checkKey(runId, task, gate, attempt) {
  return `${text(runId)}|${text(task)}|${text(gate)}|${attempt ?? ''}`
}

/** A socket's check item joined to its check's lines so far (a `tail` overlaps them: only new lines join). */
function absorbCheck(runId, item) {
  const key = checkKey(runId, item.task_id, item.gate, item.attempt)
  const had = checkLog.get(key) ?? { lines: [], notes: new Set() }
  const incoming = item.tail?.length ? item.tail : item.line ? [item.line] : []
  let k = Math.min(had.lines.length, incoming.length)

  while (k > 0 && !incoming.slice(0, k).every((line, j) => line === had.lines[had.lines.length - k + j])) {
    k -= 1
  }

  if (item.stream === 'roko' && item.line) {
    had.notes.add(item.line)
  }

  checkLog.delete(key)
  checkLog.set(key, { lines: [...had.lines, ...incoming.slice(k)].slice(-CHECK_KEEP), notes: had.notes })

  while (checkLog.size > CHECK_LOGS) {
    checkLog.delete(checkLog.keys().next().value)
  }
}

/** The lines this window holds for a check: the socket's, or the card's tail when it has more (a page opened mid-check). */
function checkLinesOf(runId, task, gate, attempt, tail = []) {
  const got = checkLog.get(checkKey(runId, task, gate, attempt))

  return got && got.lines.length >= tail.length ? got.lines : tail
}

/** A compiler error, as a hazard card (NERV B4/B6: one static hazard edge, a stamp; spec v3 §2.1's contrast event). */
function HazardCard({ read, compact = false }) {
  const e = read.error
  const stage = e.kind === 'linker' ? 'link' : e.kind === 'CMake error' ? 'configure' : 'build'
  const more = read.errors > 1 ? `+${read.errors - 1} more` : ''

  return h(
    'div',
    { className: 'rk-hz', 'data-compact': compact ? 'true' : undefined, 'data-testid': 'build-hazard', role: 'group', 'aria-label': `The ${stage} failed${e.file ? ` at ${e.file} line ${e.line}` : ''}: ${e.message}` },
    h(
      'div',
      { className: 'rk-hz-head' },
      h(Stamp, { tone: 'fail' }, `${stage} failed`),
      h('span', { className: 'roko-flex' }),
      [more, read.warnings ? plural(read.warnings, 'warning') : ''].filter(Boolean).join(' · ') || null
    ),
    e.file ? h('div', { className: 'rk-hz-loc' }, e.file, h('i', null, `:${e.line}${e.col ? `:${e.col}` : ''}`)) : null,
    h('div', { className: 'rk-hz-msg' }, `${e.kind === 'linker' ? '' : `${e.kind}: `}${e.message}`),
    !compact && e.code !== null ? h(HazardCode, { e }) : null,
    !compact && read.verdict ? h('div', { className: 'rk-hz-verdict' }, clip(read.verdict.words, 140)) : null
  )
}

/** A Ladder token's failover tag (P-18): in the past once its task passed; its short words when the rail is too narrow (P-31). */
function FailoverTag({ t, style }) {
  const passed = t.state === 'passed'
  const [ref, short] = useGiveWay(2, `${t.id}|${t.state}|${t.failover}|${style.maxWidth}`)

  return h(
    'span',
    {
      className: 'rk-tag rk-lad-failover',
      'data-channel': passed ? undefined : 'fail',
      'data-testid': `ladder-failover-${t.id}`,
      ref,
      style,
      title: passed ? `its first pick was passed over (${t.failover}); it passed on the model it moved to` : `failover: ${t.failover}`
    },
    // Its words give way to the rail's end: the shortest is "⇄ failover" (phase 2.1's still cut "⇄ via failov…").
    passed ? ['⇄ passed after a failover', '⇄ via failover', '⇄ failover'][short] : short ? '⇄ failover' : `failover: ${clip(t.failover, 24)}`
  )
}

/** How many characters of a source line a narrow glass shows around the caret (P-21: the stream at 1440 px). */
const HZ_WINDOW = 16

/**
 * A hazard card's source line and caret line without the indent they share, and the window a narrow glass keeps
 * around the caret (P-21). The caret line is a character ahead: its first is the gutter's space.
 */
function hzLines(code, caret) {
  const lead = s => s.length - s.trimStart().length
  const cut = Math.max(0, Math.min(lead(code), caret ? lead(caret) - 1 : lead(code)))
  const line = code.slice(cut)
  const mark = caret ? caret.slice(cut) : null
  const at = mark ? Math.max(0, mark.indexOf('^') - 1) : 0
  const start = line.length > HZ_WINDOW ? Math.max(0, Math.min(at - 6, line.length - HZ_WINDOW)) : 0

  return { caret: mark, code: line, end: Math.min(line.length, start + HZ_WINDOW), start }
}

/**
 * The source line under a hazard card and its caret: whole on a wide glass; on a narrow one (a container query) only
 * the window around the caret, its cut ends marked "…", so the caret is never off the edge.
 */
function HazardCode({ e }) {
  const { caret, code, end, start } = hzLines(e.code, e.caret)
  const left = start > 0 ? 'true' : undefined
  const right = end < code.length ? 'true' : undefined
  const pieces = (s, shift) => [
    start > 0 ? h('span', { className: 'rk-hz-cut', key: 'l' }, s.slice(shift, start + shift)) : null,
    h('span', { className: 'rk-hz-win', 'data-l': left, 'data-r': right, key: 'w' }, s.slice(start + shift, end + shift)),
    s.length > end + shift ? h('span', { className: 'rk-hz-cut', key: 'r' }, s.slice(end + shift)) : null
  ]

  return h(
    'div',
    { className: 'rk-hz-code', 'aria-hidden': 'true' },
    h('span', { className: 'rk-hz-n' }, e.lineNo),
    ' │ ',
    pieces(code, 0),
    caret ? h(Fragment, null, '\n', h('span', { className: 'rk-hz-n' }, ' '.repeat(text(e.lineNo).length)), ' │', h('span', { className: 'rk-hz-caret' }, caret.slice(0, 1), pieces(caret, 1))) : null
  )
}

/** A build in progress: how far, what compiles now, how many units, warnings and errors. */
function BuildMeter({ read, live }) {
  const b = read.build
  const lit = Math.round((b.percent / 100) * 24)

  return h(
    'div',
    { className: 'rk-bm', 'data-live': live ? 'true' : undefined, 'data-testid': 'build-meter' },
    h(Dots, { label: `built ${b.percent}%`, size: 'M', tone: live ? 'live' : 'ink', value: `${b.percent}%` }),
    h(
      'div',
      { className: 'rk-bm-body' },
      h('span', { 'aria-hidden': 'true', className: 'rk-bm-cells' }, Array.from({ length: 24 }, (_, i) => h('i', { 'data-on': i < lit ? (live && i === lit - 1 ? 'now' : 'true') : undefined, key: i }))),
      h(
        'span',
        { className: 'rk-bm-now' },
        b.linking ? h(Fragment, null, h('b', null, 'linking'), ` ${b.linking}`) : b.unit ? h(Fragment, null, h('b', null, live ? 'compiling' : 'compiled'), ` ${b.unit}`, b.dir ? h('small', null, ` ${b.dir}`) : null) : h('b', null, b.percent >= 100 ? 'built' : 'building')
      ),
      h('span', { className: 'rk-bm-meta' }, [plural(b.units, 'unit'), plural(read.warnings, 'warning'), read.errors ? plural(read.errors, 'error') : '', b.targets.length ? `built ${clip(b.targets.at(-1), 28)}` : ''].filter(Boolean).join(' · '))
    )
  )
}

/** The tests a check ran: one pip each (ctest) or by count (doctest), and the first that failed with what it saw. */
function TestPips({ read }) {
  const t = read.tests
  const pips = t.list.length ? t.list.map(x => (x.passed ? 'p' : 'f')) : [...Array(Math.min(48, t.passed)).fill('p'), ...Array(Math.min(16, t.failed)).fill('f')]
  const f = read.failure

  return h(
    'div',
    { className: 'rk-tp', 'data-testid': 'test-pips' },
    h(
      'div',
      { className: 'rk-tp-head' },
      h('span', { 'aria-label': `${t.passed} of ${t.total} tests passed`, className: 'rk-tp-pips', role: 'img' }, pips.map((pip, i) => h('i', { 'data-pip': pip, key: i }))),
      h('span', { className: 'rk-tp-count', 'data-failed': t.failed ? 'true' : undefined }, t.failed ? `✕ ${t.passed} of ${t.total} passed` : `✓ ${t.total} of ${t.total} passed`)
    ),
    f && t.failed
      ? h(
          'div',
          { className: 'rk-tp-fail' },
          h('b', null, `✕ ${clip(f.case || f.where || 'a test', 80)}`),
          f.case && f.where ? h('small', null, ` ${f.where}`) : null,
          f.expr ? h('div', { className: 'rk-tp-expr' }, f.expr, f.values ? h('span', null, ` · saw ${f.values}`) : null) : null,
          f.logged ? h('div', { className: 'rk-tp-logged' }, f.logged) : null
        )
      : null
  )
}

/** Build glass: a build meter, a hazard card for an error, test pips, pluginval's section; null for none. */
function BuildGlass({ lines, live = false, compact = false, testId = 'build-glass' }) {
  const read = useMemo(() => readCheck(lines), [lines])

  if (!hasGlass(read)) {
    return null
  }

  return h(
    'div',
    { className: 'rk-bglass', 'data-compact': compact ? 'true' : undefined, 'data-live': live ? 'true' : undefined, 'data-testid': testId },
    read.error ? h(HazardCard, { compact, read }) : read.build ? h(BuildMeter, { live, read }) : null,
    read.tests ? h(TestPips, { read }) : null,
    read.pluginval ? h('div', { className: 'rk-pv', 'data-result': read.pluginval.result ?? undefined }, h('b', null, 'pluginval'), ` · ${plural(read.pluginval.sections, 'section')}`, read.pluginval.result ? ` · ${read.pluginval.result}` : read.pluginval.current ? ` · now ${read.pluginval.current}` : '') : null,
    !read.error && read.verdict ? h('div', { className: 'rk-hz-verdict' }, clip(read.verdict.words, 160)) : null
  )
}

// --- The stream (spec v3 §4.5): what the agents do, as a phosphor log, newest at the bottom

/**
 * A timeline without the doubled tool steps of a trusted run (dogfood U5): roko writes the screened step ("read_file
 * synth/svf.py") and then the call's end ("read_file", no target) a moment later. The second goes.
 */
function dedupeTools(events) {
  const last = new Map()

  return events.filter(e => {
    if (text(e.type) !== 'agent_output' || !text(e.tool)) {
      return true
    }

    const key = `${text(e.task_id)}|${text(e.tool)}`
    const prev = last.get(key)
    const ts = num(e.ts_millis)

    last.set(key, { target: text(e.target), ts })

    return !(prev && !text(e.target) && prev.target && (ts === null || prev.ts === null || Math.abs(ts - prev.ts) <= 3_000))
  })
}

/** How many rows the stream keeps: 200 a task, 1 000 a run (a ring buffer, spec v3 §4.5). */
const STREAM_PER_TASK = 200
const STREAM_PER_RUN = 1_000

/**
 * The run's stream rows, oldest first: tool calls, checks (with the line that says why a failed one failed), route
 * decisions (a climb says from where and why), lessons, and the agents' words, from the run's timeline and, between
 * its frames, the live socket. Each row: {key, ts, task, kind, text, detail, tone, lines}.
 */
function streamRows(run, events, live) {
  const tasks = new Map(list(run.tasks).filter(isRecord).map(t => [text(t.task_id), t]))
  const tryOf = (taskId, attempt) => list(tasks.get(taskId)?.climb).filter(isRecord).find(t => num(t.attempt) === num(attempt))
  const rows = []
  const seenTools = new Set()
  // The try each task is on as the timeline goes (its agent and route lines name it), and how many times each of
  // its checks failed so far: a failed check's key line is its own try's, not the first try that failed it.
  const tryNow = new Map()
  const failures = new Map()

  events.forEach(e => {
    const type = text(e.type)
    const task = text(e.task_id)
    const ts = num(e.ts_millis)
    const key = `e${num(e.cursor) ?? rows.length}`

    if (task && num(e.attempt) !== null && (type === 'agent_spawned' || type === 'route_decided' || type === 'agent_output')) {
      tryNow.set(task, num(e.attempt))
    }

    if (type === 'agent_output' && text(e.tool_error)) {
      rows.push({ detail: clip(e.tool_error, 120), key, kind: 'tool', task, text: '✕ tool error', tone: 'fail', ts })
    } else if (type === 'agent_output' && text(e.tool)) {
      seenTools.add(`${task}|${text(e.tool)}|${text(e.target)}`)
      rows.push({ detail: clip(e.target, 120), key, kind: 'tool', task, text: clip(e.tool, 40), ts })
    } else if (type === 'agent_output' && e.stopped === true) {
      // roko ended the try in the agent's place (a turn cap, its stream limit, the cap): roko's words, not the agent's.
      const said = text(e.text)

      rows.push({ key, kind: 'stopped', task, text: `■ ${clip(task && said.startsWith(`${task} `) ? said.slice(task.length + 1) : said, 200)}`, tone: 'fail', ts })
    } else if (type === 'gate_result') {
      const failed = e.passed === false
      const gate = text(e.gate)
      const n = failed ? (failures.get(`${task}|${gate}`) ?? 0) + 1 : 0
      const tries = list(tasks.get(task)?.climb).filter(isRecord)
      // The try the timeline is on; else (a timeline without agent lines) the n-th try that failed this check.
      const t = !failed
        ? null
        : tryNow.has(task)
          ? tries.find(x => num(x.attempt) === tryNow.get(task) && text(x.failed_check) === gate)
          : tries.filter(x => text(x.failed_check) === gate)[n - 1]

      if (failed) {
        failures.set(`${task}|${gate}`, n)
      }

      // The task's newest check output, when it is this try's failure: the build glass reads it.
      const tail = failed && isRecord(tasks.get(task)?.check_tail) ? tasks.get(task).check_tail : null
      const tailIsThis = tail && tail.passed === false && text(tail.gate) === gate && (t ? num(tail.attempt) === num(t.attempt) : true)

      rows.push({
        detail: failed ? text(t?.key_line).replace(/[\r\n]+/g, ' ').slice(0, 200) : '',
        glass: tailIsThis ? list(tail.lines).map(l => text(l).slice(0, 300)) : null,
        key,
        kind: 'check',
        task,
        text: `${failed ? '✕' : '✓'} ${clip(e.gate, 40)} ${failed ? 'did not pass' : 'passed'}`,
        tone: failed ? 'fail' : 'pass',
        ts
      })
    } else if (type === 'route_decided' && text(e.model)) {
      const t = tryOf(task, e.attempt)
      // A failover try has two decisions: the pick roko passed over, then the model that ran (its loop says which).
      const passedOver = text(t?.reason) === 'failover' && text(e.loop) !== 'failover' && text(e.source) !== 'failover'
      const reason = passedOver ? 'pick' : text(t?.reason)
      // The tries that did not pass on the rung it climbed from (the latest try before this one stood there).
      const earlier = reason === 'climb' ? list(tasks.get(task)?.climb).filter(x => isRecord(x) && num(x.attempt) < num(e.attempt)) : []
      const from = text(earlier[earlier.length - 1]?.rung)
      const below = earlier.filter(x => tryMark(x) === 'x' && text(x.rung) === from && from !== text(t?.rung))

      rows.push({
        key,
        kind: 'route',
        task,
        text:
          reason === 'climb'
            ? `▲ up to ${text(t.rung)} · ${clip(e.model, 30)}${below.length ? ` · ${climbWhy(below)}` : ''}`
            : reason === 'failover'
              ? `⇄ failover → ${clip(e.model, 30)}${isRecord(t.failover) && text(t.failover.why) ? ` · ${clip(t.failover.model, 30) || 'its pick'} ${clip(t.failover.why, 60)}` : ''}`
              : reason === 'pick'
                ? `→ ${clip(e.model, 30)}`
                : `→ ${clip(e.model, 30)}${t?.rung ? ` on ${text(t.rung)}` : ''}${num(e.attempt) > 1 ? ` · try ${num(e.attempt)}` : ''}`,
        tone: reason === 'climb' ? 'live' : reason === 'failover' ? 'fail' : null,
        ts
      })

      const used = new Set(list(t?.lesson_ids).map(text).filter(Boolean)).size

      if (used && reason !== 'pick') {
        rows.push({ key: `${key}L`, kind: 'lesson', task, text: `◇ ${plural(used, 'lesson')} in its prompt`, tone: 'learn', ts: (ts ?? 0) + 1 })
      }
    } else if (type === 'knowledge_written') {
      rows.push({ key, kind: 'lesson', task, text: `◇ ${clip(e.text, 140)}`, tone: 'learn', ts })
    } else if (type === 'task_completed') {
      const outcome = text(e.outcome)

      rows.push({ key, kind: 'task', task, text: outcome === 'passed' ? `✓ ${task} passed` : `${task} ${clip(outcome, 30) || 'ended'}`, tone: outcome === 'passed' ? 'pass' : outcome === 'failed' ? 'fail' : null, ts })
    } else if (type === 'error' || e.group === 'error') {
      rows.push({ key, kind: 'error', task, text: clip(e.text, 200), tone: 'fail', ts })
    }
  })

  // Between the timeline's frames: the socket's tool calls, check lines and words.
  const lines = new Map()

  live.items.forEach((item, i) => {
    const task = text(item.task_id)

    if (item.kind === 'tool' && !seenTools.has(`${task}|${item.tool}|${item.target}`)) {
      rows.push({ detail: clip(item.target, 120), key: `l${item.ts}:${i}`, kind: 'tool', task, text: clip(item.tool, 40), ts: item.ts })
    } else if (item.kind === 'check' && item.line) {
      // One block a try: a new try's check starts clean, not under the last try's lines.
      const at = `${task}|${item.gate}|${item.attempt ?? ''}`
      const block = lines.get(at) ?? { attempt: item.attempt, gate: item.gate, key: `c${task}:${item.gate}:${item.attempt ?? ''}`, kind: 'output', lines: [], notes: new Set(), task, text: `checking ${clip(item.gate, 40)}`, ts: item.ts }
      // The whole check as this window heard it (an item that waited for the rate carries its `tail`).
      const logged = checkLog.get(checkKey(run.run_id, task, item.gate, item.attempt))

      block.lines = logged?.lines.length ? logged.lines : (item.tail?.length ? item.tail : [...block.lines, item.line]).slice(-CHECK_KEEP)

      // roko's own line ("… lines skipped"), as roko says it, never as the check's output.
      if (item.stream === 'roko') {
        block.notes.add(item.line)
      }

      logged?.notes.forEach(note => block.notes.add(note))
      block.ts = item.ts
      lines.set(at, block)
    }
  })

  // A page opened mid-check: what the running check printed so far (the card's `check_tail`).
  tasks.forEach((t, id) => {
    const tail = isRecord(t.check_tail) ? t.check_tail : null
    const at = tail ? `${id}|${clip(tail.gate, 80)}|${num(tail.attempt) ?? ''}` : ''

    // The socket's lines of the same try (or of a try it does not number) already show it.
    const tries = [...lines.keys()].filter(k => k.startsWith(`${id}|${clip(tail?.gate, 80)}|`)).map(k => k.split('|').pop())
    const shown = tries.some(a => a === '' || num(tail?.attempt) === null || a === String(num(tail.attempt)))

    if (tail && tail.passed === null && list(tail.lines).length && !shown) {
      const had = list(tail.lines).map(l => text(l).slice(0, 300))

      lines.set(at, { attempt: num(tail.attempt), gate: text(tail.gate), key: `c${id}:${text(tail.gate)}:${num(tail.attempt) ?? ''}`, kind: 'output', lines: checkLinesOf(run.run_id, id, text(tail.gate), num(tail.attempt), had), notes: new Set(), task: id, text: `checking ${clip(tail.gate, 40)}`, ts: Date.now() })
    }
  })
  lines.forEach(block => rows.push(block))

  const sorted = rows.filter(r => r.text || r.lines?.length).sort((a, b) => (num(a.ts) ?? 0) - (num(b.ts) ?? 0))
  const perTask = new Map()

  // The ring buffer: the newest 200 a task, 1 000 a run.
  return sorted
    .reverse()
    .filter(r => {
      const n = (perTask.get(r.task) ?? 0) + 1

      perTask.set(r.task, n)

      return n <= STREAM_PER_TASK
    })
    .slice(0, STREAM_PER_RUN)
    .reverse()
}

/** A check's output in the stream: the glass over its newest lines, else its last 40 lines. */
function CheckOutput({ row, opacity, live }) {
  const read = useMemo(() => readCheck(row.lines), [row.lines])
  const glass = hasGlass(read)
  const shown = (glass ? row.lines.filter(l => !CHECK_PCT.test(text(l)) && !CHECK_NINJA.test(text(l))) : row.lines).slice(glass ? -3 : -40)

  return h(
    Fragment,
    null,
    glass ? h('div', { className: 'rk-ln-glass', style: { opacity: Math.min(1, opacity + 0.2) } }, h(BuildGlass, { lines: row.lines, live })) : null,
    h(
      'pre',
      { className: 'rk-ln-out', 'data-glass': glass ? 'true' : undefined, 'data-testid': 'stream-check', style: { opacity } },
      shown.map((l, j) =>
        h(
          'span',
          { className: cx(j === shown.length - 1 && 'rk-ln-new', row.notes?.has(l) && 'rk-ln-note') || undefined, key: j },
          l,
          j < shown.length - 1 ? '\n' : null
        )
      )
    )
  )
}

/**
 * The stream (spec v3 §4.5): a phosphor log, newest at the bottom. Rows dim with age (a failed check slowest); a
 * task's latest words sit at the bottom with a rose rule and a cursor.
 */
/**
 * The words the stream shows (P-37): the stretch that grew last, not the newest made. A stretch is one entry, updated in
 * place, so words that grow keep their first place in the list, and T3's thinking hid behind T2's older words. The task
 * shown (`held`) stays while its words grew within 2 s of the newest, so two tasks at work do not flicker.
 */
function wordsShown(items, task, held) {
  const all = items.filter(item => (item.kind === 'text' || item.kind === 'reasoning') && (!task || text(item.task_id) === task) && (item.said || item.text))
  const last = rows => rows.reduce((a, b) => (!a || (num(b.ts) ?? 0) >= (num(a.ts) ?? 0) ? b : a), null)
  const grew = last(all)
  const kept = held ? last(all.filter(item => item.task_id === held)) : null

  return kept && grew && (num(grew.ts) ?? 0) - (num(kept.ts) ?? 0) < 2_000 ? kept : grew
}

function Stream({ run, events, live, focus, replayT = null }) {
  const active = isActiveRun(run)
  const [only, setOnly] = useState(null)
  // Held: the person scrolled the log away from its foot by their own hand (a wheel, a touch, a key, a drag of its
  // scrollbar). Lines that grow under it never hold it; back at the foot, it follows again.
  const [held, setHeld] = useState(false)
  const heldNow = useRef(false)
  const byHand = useRef({ at: 0, dragging: false })
  const box = useRef(null)
  const wordsHeld = useRef(null)
  const startMs = parseTime(run.started_at) ?? parseTime(run.hermes_started_at)
  const now = useNow(active ? 1_000 : 600_000)
  const all = useMemo(() => streamRows(run, dedupeTools(events), live), [run, events, live])
  const task = only ?? null
  const rows = task ? all.filter(r => r.task === task) : all
  const words = wordsShown(live.items, task, wordsHeld.current)

  wordsHeld.current = words ? words.task_id : null
  // Words whose try is over (its task ended, or a newer try of it moved): what it said, without a live cursor.
  const wordsCard = words ? list(run.tasks).find(t => isRecord(t) && text(t.task_id) === text(words.task_id)) : null
  const newerTry = words && words.attempt !== null && live.items.some(item => item.task_id === words.task_id && item.attempt !== null && item.attempt > words.attempt)
  const wordsPast = Boolean(words) && (newerTry || (isRecord(wordsCard) && ['passed', 'failed', 'stopped', 'unverified', 'blocked'].includes(nodeState(wordsCard.outcome))))
  const toolsOnly = active && !words && live.items.some(item => item.kind === 'tool')
  const pick = focus && text(focus) !== task ? text(focus) : null
  const reduced = reducedMotion()

  const hold = value => {
    heldNow.current = value
    setHeld(value)
  }
  const touched = () => {
    byHand.current.at = Date.now()
  }
  const handBusy = () => byHand.current.dragging || Date.now() - byHand.current.at < 800

  // Follow the newest line unless the person holds the log: after every redraw, a check's growing lines included;
  // never under a hand that is scrolling it.
  useLayoutEffect(() => {
    const el = box.current

    if (el && !held && !handBusy()) {
      el.scrollTop = el.scrollHeight
    }
  })

  // The newest row sits at the stream's foot, so the foot stays on screen: its height fits what is left of the
  // window under its top (260 to 440 px), as the page scrolls and the window resizes.
  useLayoutEffect(() => {
    const glass = box.current?.parentElement

    if (!glass || typeof window === 'undefined') {
      return undefined
    }

    let scroller = glass.parentElement

    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement
    }

    const fit = () => {
      const lines = box.current
      const room = Math.round(window.innerHeight - Math.max(0, glass.getBoundingClientRect().top) - 16)

      glass.style.maxHeight = `${Math.max(260, Math.min(440, room))}px`

      if (lines && !heldNow.current && !handBusy()) {
        lines.scrollTop = lines.scrollHeight
      }
    }

    fit()
    window.addEventListener('resize', fit)
    scroller?.addEventListener('scroll', fit, { passive: true })

    return () => {
      window.removeEventListener('resize', fit)
      scroller?.removeEventListener('scroll', fit)
    }
  }, [])

  const shown = rows.slice(-60)
  // What a screen reader hears (spec v3 §8): the newest row as it reads on screen ("T2 Read tally/cli.py", "T2 ✕
  // verify[0:test] did not pass: <key line>", "T2 checking verify[0:test]: <its newest line>"), at most once every 2 s,
  // never the log's every line, never the words as they stream, and nothing while a replay moves the playhead.
  const newestRow = shown[shown.length - 1]
  const rowSaid = !newestRow
    ? ''
    : `${newestRow.task ? `${newestRow.task} ` : ''}${newestRow.text}${
        newestRow.kind === 'output' ? `: ${newestRow.lines?.at(-1) ?? ''}` : newestRow.detail ? `${newestRow.kind === 'tool' ? ' ' : ': '}${newestRow.detail}` : ''
      }`
  const said = useThrottled(replayT === null ? rowSaid : undefined, 2_000)

  return h(
    Glass,
    { className: 'rk-stream', testId: 'stream' },
    h(
      'div',
      { className: 'rk-stream-head' },
      h(ModLabel, { right: `${task ?? 'all tasks'}${active ? ' · live' : ''}` }, 'stream'),
      h(
        'span',
        { className: 'rk-seg', role: 'group', 'aria-label': 'Show' },
        h('button', { 'aria-pressed': task ? 'false' : 'true', onClick: () => setOnly(null), type: 'button' }, 'ALL'),
        task ? h('button', { 'aria-pressed': 'true', onClick: () => setOnly(null), title: 'Show every task', type: 'button' }, clip(task, 8)) : null,
        pick ? h('button', { 'aria-pressed': 'false', onClick: () => setOnly(pick), type: 'button' }, clip(pick, 8)) : null
      )
    ),
    h(
      'div',
      {
        'aria-label': `What ${task ?? 'the run'}’s agents do, newest last`,
        // Read on demand; the status beside it says the newest row (a log announced line by line floods a reader).
        'aria-live': 'off',
        className: 'rk-stream-lines',
        'data-testid': 'stream-lines',
        // The person's own hand: only a gesture of theirs may hold the log (a scroll event alone may be lines that grew).
        onKeyDown: event => {
          if (['ArrowDown', 'ArrowUp', 'End', 'Home', 'PageDown', 'PageUp', ' '].includes(event.key)) {
            touched()
          }
        },
        onPointerDown: () => {
          // Either end of the press takes both listeners off ("once" would leave the other one behind).
          const up = () => {
            byHand.current.dragging = false
            window.removeEventListener('pointerup', up)
            window.removeEventListener('pointercancel', up)
          }

          byHand.current.dragging = true
          window.addEventListener('pointerup', up)
          window.addEventListener('pointercancel', up)
        },
        onScroll: event => {
          const el = event.currentTarget
          const atFoot = el.scrollHeight - el.scrollTop - el.clientHeight <= 24

          if (atFoot && heldNow.current) {
            hold(false)
          } else if (!atFoot && !heldNow.current && handBusy()) {
            hold(true)
          }
        },
        onTouchMove: touched,
        onWheel: touched,
        ref: box,
        role: 'log',
        // A scrolling log takes the keyboard too.
        tabIndex: 0
      },
      !shown.length && !words
        ? h('div', { className: 'rk-stream-empty' }, active ? 'roko’s agents start here as soon as they move' : run.reading === true ? readingWords(run.events_read) : 'Nothing was recorded for this run.')
        : null,
      shown.map((row, i) => {
        const fromEnd = shown.length - 1 - i
        // A replay: what had not happened yet at the playhead waits, faint.
        const future = replayT !== null && num(row.ts) !== null && row.ts > replayT
        // The phosphor chain, by place from the newest: bright, then ink, then down to dim. Failed checks hold.
        const opacity = future ? 0.16 : Math.max(row.tone === 'fail' ? 0.72 : 0.42, 1 - fromEnd * 0.06)
        const fresh = !reduced && active && num(row.ts) !== null && now - row.ts < 5_000
        const at = num(row.ts) !== null && startMs !== null ? clockFace(Math.max(0, row.ts - startMs)) : ''

        return h(
          Fragment,
          { key: row.key },
          h(
            'div',
            { className: 'rk-ln', 'data-fresh': fresh ? 'true' : undefined, 'data-future': future ? 'true' : undefined, 'data-kind': row.kind, 'data-tone': row.tone ?? undefined, style: { opacity } },
            h('span', { className: 'rk-ln-t' }, at),
            h('span', { className: 'rk-ln-k' }, clip(row.task, 5)),
            h('span', { className: 'rk-ln-x' }, row.text, row.detail && row.kind === 'tool' ? h('span', { className: 'rk-ln-d' }, ` ${row.detail}`) : null)
          ),
          row.detail && row.kind !== 'tool' ? h('div', { className: 'rk-ln rk-ln-sub', 'data-tone': row.tone ?? undefined, style: { opacity: Math.min(1, opacity + 0.08) } }, h('span', { className: 'rk-ln-x' }, row.detail)) : null,
          row.glass?.length && hasGlass(readCheck(row.glass)) ? h('div', { className: 'rk-ln-glass', style: { opacity: Math.min(1, opacity + 0.2) } }, h(BuildGlass, { lines: row.glass })) : null,
          row.lines?.length ? h(CheckOutput, { live: active, opacity, row }) : null
        )
      }),
      words
        ? h(
            'div',
            { className: 'rk-words', 'data-kind': words.kind, 'data-past': wordsPast ? 'true' : undefined, 'data-testid': 'stream-words' },
            h('span', { className: 'rk-words-who' }, `${clip(text(words.task_id), 6)} ${wordsPast ? 'said' : words.kind === 'reasoning' ? 'thinks' : 'says'}`),
            mdWords(clipEnd(words.said || words.text, 600), 'words'),
            active && !wordsPast ? h('span', { 'aria-hidden': 'true', className: 'rk-cursor' }) : null
          )
        : toolsOnly
          ? h('div', { className: 'rk-stream-empty' }, 'words arrive when the try ends')
          : null
    ),
    held ? h('button', { className: 'rk-stream-jump', onClick: () => hold(false), type: 'button' }, 'jump to latest ↓') : null,
    h('span', { 'aria-live': 'polite', className: 'rk-sr', 'data-testid': 'stream-said', role: 'status' }, said)
  )
}

// --- The Ladder (spec v3 §4.3): cheap to top rungs, tasks climbing when their checks fail

/** Where a rung's prices come from (0.6.0 `priced_by`), for the price's title; '' when nothing says. */
function pricedBy(rung) {
  const by = text(rung?.priced_by)

  return by === 'snapshot'
    ? `priced by roko's price snapshot${text(rung.price_snapshot) ? ` ${clip(rung.price_snapshot, 40)}` : ''}`
    : by === 'profile'
      ? 'priced by the model’s [models] entry'
      : by === 'builtin'
        ? 'priced by roko’s built-in table'
        : by === 'roko.toml'
          ? 'priced by roko.toml'
          : ''
}

/** A rung's price per million tokens, in and out: "$0.35·$0.75" (from the workspace's [models.*] or roko's list). */
function rungPrice(rung) {
  const p = (v, digits) => (num(v) === null ? '?' : `$${num(v) < 10 ? num(v).toFixed(digits) : Math.round(num(v))}`)

  if (num(rung.spent_usd) !== null) {
    return `${money(rung.spent_usd)} spent` // a rung an ended run ran on (P-46): what it spent there
  }

  return num(rung.price_in) === null && num(rung.price_out) === null ? 'no list price' : `${p(rung.price_in, 2)}·${p(rung.price_out, 2)}`
}

/**
 * A try as a mark: `p` passed, `r` running, `x` the agent's failure (counts toward a climb), `i` a provider's or
 * roko's (blame infra/harness, a 429: ∿, never ✕), `o` else. No blame (an older roko) is the agent's.
 */
function tryMark(t) {
  if (!isRecord(t)) {
    return 'o'
  }

  if (t.outcome === 'failed') {
    const blame = text(t.blame)

    return (blame ? blame === 'agent' : text(t.verdict) !== 'provider_error') ? 'x' : 'i'
  }

  return t.outcome === 'passed' ? 'p' : t.outcome === 'running' ? 'r' : 'o'
}

/** Where a task stands now, as a token: its latest try's state. */
function tokenState(task) {
  const state = nodeState(task.outcome)

  return state === 'pending' ? 'waiting' : state
}

/**
 * The run's ladder as rows, top rung first (spec v3 §4.3): each rung's tasks (by their latest try), the ghosts of
 * tries that failed there before a climb, and the tasks not started yet on their tier's start rung, else the first a
 * run from Hermes can use. Null without a ladder.
 */
function ladderRows(run) {
  const rungs = list(run?.ladder).filter(r => isRecord(r) && text(r.rung))

  if (!rungs.length) {
    return null
  }

  const index = new Map(rungs.map((r, i) => [text(r.rung), i]))
  const start = Math.max(0, rungs.findIndex(r => r.chat_ok !== false))
  // P-36: a task not started yet waits on its tier's start rung ([routing.ladder.start]), where roko starts it.
  const startOf = task => {
    const i = rungs.findIndex(r => r.chat_ok !== false && list(r.starts).includes(text(task.tier)))

    return i >= 0 ? i : start
  }
  const rows = rungs.map(rung => ({ ghosts: [], passed: 0, refused: [], rung, tokens: [] }))
  const tasks = list(run.tasks).filter(isRecord)

  tasks.forEach((task, col) => {
    const id = text(task.task_id)
    const tries = list(task.climb).filter(isRecord)
    const last = tries[tries.length - 1]
    const at = last ? index.get(text(last.rung)) : tries.length ? undefined : startOf(task)

    // Its climb's footprints: the agent's failed tries on other rungs (✕), a provider's refusals (∿), and failed
    // tries on its own rung beside its token.
    const below = new Map()
    const refused = new Map()
    const marks = []

    tries.forEach((t, k) => {
      const i = index.get(text(t.rung))
      const mark = tryMark(t)

      if (i === undefined || (mark !== 'x' && mark !== 'i')) {
        return
      }

      if (i === at) {
        if (k < tries.length - 1) {
          marks.push(mark)
        }

        return
      }

      const into = mark === 'x' ? below : refused

      into.set(i, (into.get(i) ?? 0) + 1)
    })
    below.forEach((n, i) => rows[i].ghosts.push({ col, id, n }))
    refused.forEach((n, i) => rows[i].refused.push({ col, id, n }))

    if (at === undefined) {
      return
    }

    const lower = [...below.keys()].filter(i => i < at).sort((a, b) => b - a)[0]
    // A task with no tries on the card yet waits on the start rung; one that ended without them (an older card) says how.
    const state = tries.length || !['pending', 'running'].includes(nodeState(task.outcome)) ? tokenState(task) : 'waiting'
    const lives = isRecord(task.lives) ? task.lives : null
    const top = !rungs.slice(at + 1).some(r => r.chat_ok !== false)

    rows[at].tokens.push({
      climbed: tries.some(t => t.reason === 'climb'),
      col,
      // roko says so since 37088dc12 (`tasks[].exhausted`, with its advice); an older card, by its lives on the top rung.
      exhausted: isRecord(task.exhausted) || (state === 'failed' && top && Boolean(lives) && num(lives.used) >= (num(lives.of) ?? 2)),
      advice: isRecord(task.exhausted) ? clip(task.exhausted.suggestion, 160) : '',
      failover: last?.reason === 'failover' ? (isRecord(last.failover) ? text(last.failover.why) || text(last.failover.class) || 'failover' : 'failover') : '',
      from: lower,
      fromWord: lower !== undefined ? `▲ after ${plural(below.get(lower), 'failed try', 'failed tries')}` : '',
      id,
      marks,
      state
    })

    if (state === 'passed') {
      rows[at].passed += 1
    }
  })

  return { columns: tasks.length, rows: rows.reverse(), top: rows.length - 1 }
}

/** Each task's rung the last time the ladder drew, so a climb or a failover is seen once, as it happens. */
const ladderSeen = new Map()

/**
 * The Ladder (spec v3 §4.3): rung rows, top first, with name, model, price, a rail and the tasks passed there. A
 * token per task on the rung of its latest try, a ✕✕ ghost where it failed before it climbed; a climb rises along a
 * trail with the ⌈CLIMBED⌋ stamp; a task out of rungs says ⌈SPLIT OR REPLAN⌋.
 */
function Ladder({ run }) {
  const laid = ladderRows(run)
  const [stamps, setStamps] = useState({})
  const [playing, setPlaying] = useState({})
  const stampTimer = useRef(null)
  const moveTimer = useRef(null)

  useEffect(
    () => () => {
      clearTimeout(stampTimer.current)
      clearTimeout(moveTimer.current)
    },
    []
  )

  // What moved since the last draw: a token on a higher rung climbed; one on the same rung after a failover slid.
  const moves = {}

  if (laid) {
    laid.rows.forEach((row, r) => {
      row.tokens.forEach(token => {
        const key = `${text(run.run_id)}:${token.id}`
        const was = ladderSeen.get(key)
        const at = laid.top - r

        if (was && was.at < at && token.climbed) {
          moves[token.id] = { dy: (at - was.at) * 40, kind: 'climb' }
        } else if (was && was.at === at && token.failover && !was.failover) {
          moves[token.id] = { kind: 'failover' }
        }
      })
    })
  }

  useEffect(() => {
    if (!laid) {
      return undefined
    }

    const fresh = {}

    laid.rows.forEach((row, r) => {
      row.tokens.forEach(token => {
        const key = `${text(run.run_id)}:${token.id}`

        if (moves[token.id]?.kind === 'climb') {
          fresh[token.id] = 'climbed'
        }

        ladderSeen.set(key, { at: laid.top - r, failover: Boolean(token.failover) })
      })
    })

    if (ladderSeen.size > 600) {
      ladderSeen.delete(ladderSeen.keys().next().value)
    }

    if (Object.keys(fresh).length) {
      setStamps(fresh)
      // The stamp holds for a Moment, then the ladder is still again (spec v3 §6).
      clearTimeout(stampTimer.current)
      stampTimer.current = setTimeout(() => setStamps({}), 1_200)
    }

    if (Object.keys(moves).length) {
      // A climb sounds the old rung's note, then the new one's (spec v3 §3.8).
      Object.entries(moves).forEach(([id, move]) => {
        if (move.kind === 'climb') {
          const r = laid.rows.findIndex(row => row.tokens.some(t => t.id === id))
          const to = laid.top - r

          play('climb', false, { from: to - Math.round(move.dy / 40), to })
        }
      })
      // The move keeps playing through the redraws that follow, for its passage (600 ms), then the token rests.
      setPlaying(was => ({ ...was, ...moves }))
      clearTimeout(moveTimer.current)
      moveTimer.current = setTimeout(() => setPlaying({}), 700)
    }

    return undefined
  })

  if (!laid) {
    return null
  }

  const n1 = Math.max(1, laid.columns - 1)
  // A long phase: past 8 tasks the tokens go dense, past 24 they are dots; every task keeps its column.
  const density = laid.columns > 24 ? 'dots' : laid.columns > 8 ? 'dense' : null
  const x =
    density === 'dots'
      ? col => `calc((100% - 8px) / ${n1} * ${col})`
      : density === 'dense'
        ? col => `calc(min(20px, (100% - 14px) / ${n1}) * ${col})`
        : col => `calc(min(38px, (100% - 32px) / ${n1}) * ${col})`
  // Half a token's width: where a trail rises, and how far right of its token a note starts.
  const half = density === 'dots' ? 4 : density === 'dense' ? 7 : 16
  const after = t => {
    const failed = t.marks.filter(m => m === 'x').length
    const turned = t.marks.length - failed
    const parts = [failed ? `${plural(failed, 'failed try', 'failed tries')} here` : '', turned ? `a provider refused ${plural(turned, 'try', 'tries')}` : ''].filter(Boolean)

    return parts.length ? `, after ${parts.join(' and ')}` : ''
  }
  const stateWords = t => (t.state === 'waiting' ? 'waiting to start' : t.state)
  const anyRefused = laid.rows.some(row => row.refused.length || row.tokens.some(t => t.marks.includes('i')))
  const words = row => {
    const parts = row.tokens.map(t => `${t.id} ${stateWords(t)}${after(t)}${t.climbed ? ', climbed here' : ''}`)

    row.ghosts.forEach(g => parts.push(`${g.id} failed ${g.n === 1 ? 'once' : `${g.n} times`} here and climbed`))
    row.refused.forEach(r => parts.push(`${r.id}: a provider refused ${plural(r.n, 'try', 'tries')} here, not counted`))

    return `${text(row.rung.slug) || text(row.rung.model)}, ${rungWord(laid, row, run)}${row.rung.skipped ? `, ${text(row.rung.why_not)}` : row.rung.chat_ok === false ? ', not for runs from a chat' : ''}${parts.length ? `: ${parts.join('; ')}` : ''}`
  }

  return h(
    'div',
    { className: 'rk-lad', 'data-density': density ?? undefined, 'data-testid': 'ladder' },
    h(
      'div',
      { 'aria-label': 'The models, strongest first', className: 'rk-lad-rungs', role: 'list' },
      laid.rows.map((row, r) => {
        const off = row.rung.chat_ok === false
        const live = row.tokens.some(t => t.state === 'running')
        // A note sits beside its token only when no token stands to its right on the rung; otherwise the token
        // carries a mark and the words go in its title (the stream and the NOW corner say them too).
        const last = Math.max(-1, ...row.tokens.map(t => t.col))
        // Its tasks out of rungs get one stamp, beside the rung's last token (phase 2: a stamp each covered both).
        const spent = row.tokens.filter(t => t.exhausted)
        const besideLast = spent.find(t => t.col === last)
        // A provider roko went on without (bug-390e4b): a climb past this rung was for want of credit or usage.
        const out = list(run.provider_exhausted).find(p => isRecord(p) && (row.rung.provider ? p.provider === row.rung.provider : p.model === (row.rung.slug || row.rung.model)))

        return h(
          'div',
          { 'aria-label': words(row), className: 'rk-rung', 'data-live': live ? 'true' : undefined, 'data-off': off ? 'true' : undefined, 'data-rung': text(row.rung.rung), key: text(row.rung.rung), role: 'listitem' },
          h(
            'div',
            { 'aria-hidden': 'true', className: 'rk-rung-name' },
            // The model by its name, then its place in words (design system §6.4: no rung ids); its list price on hover.
            h('span', { className: 'rk-rung-m', title: [text(row.rung.model), num(row.rung.spent_usd) === null ? listPrice(row.rung) : '', pricedBy(row.rung)].filter(Boolean).join(' · ') }, text(row.rung.slug) || text(row.rung.model)),
            h('span', { className: 'rk-rung-w' }, rungWord(laid, row, run)),
            // P-46: what an ended run spent on it; roko bug-8bcd98: the part a provider refused.
            num(row.rung.spent_usd) !== null ? h('span', { className: 'rk-rung-p' }, rungPrice(row.rung)) : null,
            num(row.rung.refused_usd) ? h('span', { className: 'rk-rung-p' }, `incl. ${money(row.rung.refused_usd)} refused`) : null
          ),
          h(
            'div',
            { 'aria-hidden': 'true', className: 'rk-rail' },
            off ? h('span', { className: 'rk-rail-note', title: text(row.rung.why_not) || undefined }, text(row.rung.why_not) || 'not for chat runs') : null,
            out ? h('span', { className: 'rk-rail-note', 'data-out': 'true', 'data-testid': `ladder-out-${text(row.rung.rung)}`, title: text(out.detail) }, `⊘ ${out.billing ? 'no credit' : 'out of usage'}${out.until_ms ? ` · until ${clock(out.until_ms).slice(0, 5)}` : ''}`) : null,
            row.ghosts.map(g => h('span', { className: 'rk-tok', 'data-state': 'ghost', key: `g${g.id}`, style: { left: x(g.col) }, title: `${g.id} failed ${g.n === 1 ? 'once' : `${g.n} times`} here` }, density ? '' : '✕'.repeat(Math.min(2, g.n)))),
            row.refused.map(r =>
              h('span', { className: 'rk-tok-ref', 'data-testid': `ladder-refused-${r.id}`, key: `r${r.id}`, style: { left: `calc(${x(r.col)} + ${half - 4}px)` }, title: `${r.id}: a provider refused ${plural(r.n, 'try', 'tries')} here, not counted toward a climb` }, '∿')
            ),
            row.tokens.map(t => {
              const move = moves[t.id] ?? playing[t.id]
              // Rows run top first: this one is rung `laid.top - r`; the trail reaches down to the rung it climbed from.
              const trail = t.from !== undefined ? laid.top - r - t.from : 0

              return h(
                Fragment,
                { key: t.id },
                trail > 0 ? h('span', { className: 'rk-trail', style: { height: `${trail * 40 - 20}px`, left: `calc(${x(t.col)} + ${half - 1}px)` } }) : null,
                move?.kind === 'climb' && !reducedMotion() ? h('span', { className: 'rk-tok rk-tok-echo', style: { left: x(t.col), '--rk-dy': `${move.dy}px` } }) : null,
                h(
                  'span',
                  {
                    className: 'rk-tok',
                    'data-exhausted': t.exhausted ? 'true' : undefined,
                    'data-failover': t.failover ? 'true' : undefined,
                    // Dense: its failed tries on this rung (✕ beside a roomy token) are a corner mark, red for the agent's.
                    'data-marked': density && t.marks.length ? (t.marks.includes('x') ? 'x' : 'i') : undefined,
                    'data-move': move && !reducedMotion() ? move.kind : undefined,
                    'data-state': t.state,
                    'data-testid': `ladder-token-${t.id}`,
                    style: { left: x(t.col), '--rk-dy': move?.dy ? `${move.dy}px` : undefined },
                    title:
                      [density ? `${t.id} ${stateWords(t)}${after(t)}` : '', t.exhausted ? 'out of rungs: split or replan' : '', t.failover ? `failover: ${t.failover}` : '', t.fromWord && t.col !== last ? t.fromWord : ''].filter(Boolean).join(' · ') ||
                      undefined
                  },
                  density && t.state !== 'running' ? '' : padNo(t.id)
                ),
                !density && t.marks.length
                  ? h(
                      'span',
                      { 'aria-hidden': 'true', className: 'rk-tok-marks', 'data-testid': `ladder-marks-${t.id}`, style: { left: x(t.col) } },
                      t.marks.map((m, k) => h('i', { 'data-mark': m, key: k, title: m === 'x' ? 'a failed try on this rung' : 'a provider refused this try: not counted' }, m === 'x' ? '✕' : '∿'))
                    )
                  : null,
                t.fromWord && t.state === 'running' && t.col === last ? h('span', { className: 'rk-climbnote', style: { left: `calc(${x(t.col)} + ${half * 2 + 8}px)` } }, t.fromWord) : null,
                // A stamp is a declaration: beside its token, or (with tokens to its right) over the rail's end.
                stamps[t.id] ? h('span', { className: 'rk-lad-stamp', style: t.col === last ? { left: `calc(${x(t.col)} + ${half * 2 + 8}px)` } : { right: 0 } }, h(Stamp, { testId: 'stamp-climbed', tone: 'live' }, 'moved up')) : null,
                // P-18: within its rail, never over the rung's count; once the task passed, past and short.
                t.failover && t.col === last ? h(FailoverTag, { style: { left: `calc(${x(t.col)} + ${half * 2 + 8}px)`, maxWidth: `calc(100% - ${x(t.col)} - ${half * 2 + 8}px)` }, t }) : null
              )
            }),
            besideLast
              ? h(
                  'span',
                  { className: 'rk-lad-stamp', 'data-beside': besideLast.id, style: { left: `calc(${x(last)} + ${half * 2 + 8}px)` } },
                  h(
                    Stamp,
                    { testId: 'stamp-exhausted', tone: 'you', title: `${spent.length > 1 ? `${spent.map(t => t.id).join(', ')}: ` : ''}${spent[0].advice || 'It failed its checks on the top rung a run from here can use: split it or replan it'}` },
                    h('span', { className: 'rk-stamp-2' }, 'split or', h('br'), 'replan')
                  )
                )
              : null
          ),
          h('span', { 'aria-hidden': 'true', className: 'rk-rcount', 'data-passed': row.passed ? 'true' : undefined }, row.passed ? `${row.passed}✓` : off ? '' : '·')
        )
      })
    ),
    h(
      'div',
      { 'aria-hidden': 'true', className: 'rk-lad-foot' },
      h('span', null, h('b', { 'data-channel': 'pass' }, '✓'), ' passed'),
      h('span', null, h('b', { 'data-channel': 'fail' }, '✕'), ' failed try'),
      anyRefused ? h('span', null, h('b', null, '∿'), ' provider refused') : null,
      h('span', null, h('b', { 'data-channel': 'live' }, '▲'), ' moved up'),
      h('span', null, h('b', null, '◌'), ' waiting')
    )
  )
}

/** A rung's list price, for its tooltip: "$0.35 in · $0.75 out per million tokens", or that it has none. */
function listPrice(rung) {
  const p = v => (num(v) === null ? '?' : `$${num(v) < 10 ? num(v).toFixed(2) : Math.round(num(v))}`)

  return num(rung.price_in) === null && num(rung.price_out) === null ? 'no list price' : `${p(rung.price_in)} in · ${p(rung.price_out)} out per million tokens`
}

/**
 * A model's place on the ladder in words (design system §6.4): strongest at the top, cheapest at the bottom, and
 * where the run's tasks start (roko's start rung) between them.
 */
function rungWord(laid, row, run) {
  const rows = laid.rows
  const i = rows.indexOf(row)
  // Rows run strongest first; the start rung is the cheapest one a run from here may use.
  const usable = rows.filter(r => r.rung.chat_ok !== false)
  const start = usable[usable.length - 1]

  if (row === start && rows.length > 1) {
    return isActiveRun(run) ? 'where it starts' : 'where it started'
  }

  return i === 0 ? 'strongest' : i === rows.length - 1 ? 'cheapest' : rows.indexOf(start) > i ? 'stronger' : 'cheaper'
}

/**
 * The Ladder, strip form (chat cards, spec v3 §4.3): the rungs left to right, cheapest first, each with its name and
 * model, and a square for each task there: rose running, sage passed, red where a try failed. A rung a chat's run
 * cannot use is hatched and says so.
 */
function LadderStrip({ run }) {
  const laid = ladderRows(run)

  if (!laid) {
    return null
  }

  return h(
    Glass,
    { 'aria-label': `The model ladder: ${laid.rows.slice().reverse().map(r => `${text(r.rung.rung)} ${text(r.rung.slug) || text(r.rung.model)}`).join(', ')}`, className: 'rk-lstrip', role: 'img', testId: 'ladder-strip' },
    laid.rows
      .slice()
      .reverse()
      .map(row => {
        const live = row.tokens.some(t => t.state === 'running')

        return h(
          'div',
          { className: 'rk-lstrip-seg', 'data-live': live ? 'true' : undefined, 'data-off': row.rung.chat_ok === false ? 'true' : undefined, key: text(row.rung.rung) },
          h('span', { className: 'rk-lstrip-top' }, h('span', { className: 'rk-rung-r' }, text(row.rung.rung)), h('span', { className: 'rk-lstrip-m' }, row.rung.chat_ok === false ? (row.rung.skipped ? 'skipped' : 'chat: no') : clip(text(row.rung.slug) || text(row.rung.model), 18))),
          h(
            'span',
            { className: 'rk-lstrip-toks' },
            row.ghosts.map(g => h('i', { 'data-state': 'ghost', key: `g${g.id}`, title: `${g.id} failed here` })),
            row.tokens.map(t => h('i', { 'data-state': t.state, key: t.id, title: `${t.id} ${t.state}` }))
          )
        )
      })
  )
}

/** The names of the run's checks, for the chat card's foot: "checks: test · lint · not run yet". */
function checksLine(run) {
  const gates = [...new Set(list(run.tasks).filter(isRecord).flatMap(task => list(task.gates).filter(isRecord).map(g => text(g.gate).replace(/^verify\[\d+:([^\]]+)\]$/, '$1'))))].filter(Boolean)
  const g = isRecord(run.gates) ? run.gates : null
  const ran = num(g?.total) ?? 0

  return gates.length ? `checks: ${gates.slice(0, 3).join(' · ')}${ran ? '' : ' · not run yet'}` : ran ? `${num(g.passed) ?? 0}/${ran} checks passed` : 'checks: not run yet'
}

/**
 * The instrument (CHEST, spec v3 §4.2): corners around the one bone number (the run's spend with its erosion meter):
 * 01 tasks, 02 time, 04 checks, 05 now, and L0 along the bottom edge.
 */
/** roko's time-left estimate, counted down from when roko made it (P-38), with its 90th percentile (bcce6c05c). */
function etaWords(run, now) {
  const at = parseTime(run.eta_at)
  const gone = at !== null ? (now - at) / 60_000 : 0
  const left = num(run.eta_minutes) - gone
  const p90 = num(run.eta_p90_minutes)
  const upTo = p90 !== null && p90 - gone > 0 ? Math.max(1, Math.round(p90 - gone)) : null
  const from = at !== null ? clock(at).slice(0, 5) : ''
  const basis = isRecord(run.eta_basis) ? run.eta_basis : {}
  const rests = basis.source === 'guess' ? ' · a guess' : num(basis.runs) ? ` · from ${plural(basis.runs, 'run')}` : ''

  if (from && left <= 0) {
    return upTo ? `past roko’s likely time · up to ${upTo} min left` : `past roko’s estimate from ${from}`
  }

  return `${left < 1 ? '<1 min' : `~${Math.round(left)} min`} left${upTo ? `, up to ${upTo}` : ''}${from ? ` · est. ${from}` : ''}${rests}`
}

/** The estimate in the time corner, 195 px wide at 1440: a range takes two lines, the minutes, then from when. */
function etaNote(run, now, testId = 'instrument-eta', className = 'rk-cnote') {
  const words = etaWords(run, now)
  const [head, ...rest] = num(run.eta_p90_minutes) === null ? [words] : words.split(' · ')

  return h('span', { className, 'data-testid': testId, title: words }, head, rest.length ? h('span', { className: 'rk-cnote-2' }, rest.join(' · ')) : null)
}

/**
 * The horizon (spec v3 §4.8): one glass line between what is decided (above) and what happens (below): the live
 * step, with its task, its model and try, the newest words or tool call with a cursor, and its clock; or roko's
 * check of the plan; or what waits on the person. Older moves trail off to the left, dimmer.
 */
const Horizon = memo(function Horizon({ run, live }) {
  const forYou = waitsOnYou(run)
  const checking = checkingOf(run)
  // roko's spec gate (97d9b1819) runs each task's checks on the unchanged base before any agent: its progress.
  const gate = isRecord(run.spec_gate) && run.spec_gate.state === 'running' ? run.spec_gate : null
  // A check of the plan or the workspace runs after the tasks: their last steps are old news by then.
  const items = checking && !checking.task ? [] : tickerItems(run, live)
  const newest = items[items.length - 1]
  const task = newest ? list(run.tasks).find(t => isRecord(t) && text(t.task_id) === newest.task) : null
  // Who is speaking: the try the newest item came from (its model and number), else the task's latest.
  const who = task ? tryModel(task, newest.attempt) : ''
  const tryNo = newest?.attempt ?? num(task?.attempts)
  const words = newest && (newest.kind === 'text' || newest.kind === 'reasoning')
  let idle = ''

  if (!isActiveRun(run)) {
    return null
  }

  if (!newest) {
    idle =
      run.state === 'queued'
        ? `queued${num(run.position) !== null ? ` · position ${run.position}` : ''} · waiting for a slot`
        : gate
          ? `spec gate · ${num(gate.steps_done) ?? 0}/${num(gate.steps_total) ?? '?'} steps${num(gate.cached) ? ` · ${num(gate.cached)} cached` : ''}`
          : notStarted(run)
          ? 'starting… roko gets the run ready'
          : forYou
            ? 'waiting on you'
            : checking
              ? checking.text
              : 'between tasks…'
  }

  return h(
    Glass,
    {
      className: 'rk-horizon rk-ticker',
      'data-testid': 'horizon',
      'data-tone': forYou ? 'you' : 'agent',
      label: newest ? `${newest.task} ${words ? mdPlain(clipEnd(newest.words, 160)) : newest.words}` : idle,
      role: 'marquee'
    },
    h(LED, { blink: forYou ? 'fast' : 'slow', tone: forYou ? 'you' : 'live' }),
    newest && who ? h('span', { className: 'rk-horizon-who' }, `${clip(who, 22)}${tryNo > 1 ? ` · try ${tryNo}` : ''}`) : null,
    h(
      'span',
      { className: 'rk-ticker-lane' },
      newest
        ? items.map((item, i) =>
            h(
              'span',
              { className: 'rk-ticker-item', 'data-age': String(items.length - 1 - i), 'data-channel': item.channel, 'data-kind': item.kind, key: item.key },
              h('b', null, clip(item.task, 14)),
              ' ',
              // Words keep their newest end in view: a long line is cut on the left, never the right.
              item.kind === 'text' || item.kind === 'reasoning' ? h('span', { className: 'rk-said' }, h('span', null, '“', mdWords(clipEnd(item.words, 118), item.key), '”')) : clip(item.words, 120),
              i === items.length - 1 && !forYou ? h('span', { 'aria-hidden': 'true', className: 'rk-cursor' }) : null
            )
          )
        : h(
            'span',
            { className: 'rk-ticker-item', 'data-age': '0', 'data-channel': forYou ? 'you' : undefined, 'data-kind': checking && idle === checking.text ? 'check' : 'idle', 'data-testid': gate ? 'spec-gate' : checking && idle === checking.text ? 'ticker-checking' : undefined },
            idle,
            gate && num(gate.steps_total) ? h('span', { 'aria-hidden': 'true', className: 'rk-sg-bar' }, h('i', { style: { width: `${(Math.min(num(gate.steps_done) ?? 0, gate.steps_total) / gate.steps_total) * 100}%` } })) : null,
            checking && idle === checking.text && checking.since ? h(Fragment, null, ' · ', h(StepClock, { since: checking.since })) : null
          )
    ),
    newest && newest.since ? h('span', { className: 'rk-horizon-clock' }, h(StepClock, { since: new Date(newest.since).toISOString() })) : null
  )
})

const WHY_TITLES = {
  cancelled: 'Why it stopped',
  failed: 'Why it did not pass',
  interrupted: 'roko stopped mid-run',
  missing: 'roko has no record of this run',
  unverified: 'Why it is unverified'
}
/** A run Hermes cancelled (0.6.0 P-1 `cancelled_by`): "cancelled from chat: <reason>", or from this page; '' else. */
function cancelWords(run) {
  const c = isRecord(run?.cancelled_by) ? run.cancelled_by : null

  return c ? `cancelled from ${text(c.by) === 'chat' ? 'chat' : 'this page'}${clip(c.reason, 300) ? `: ${clip(c.reason, 300)}` : ''}` : ''
}

/** For a run that ended without success: roko's reason in one paragraph, and the task to look at. */
function WhyCallout({ run, onInspect, typeOut = false }) {
  const state = text(run.state)
  const planGroup = usePlanGroup(isRecord(run.why) && isRecord(run.why.validation) ? text(run.plan_id) : '')
  const why = isRecord(run.why) ? run.why : null
  const problems = list(run.problems).map(text).filter(Boolean)
  const summary = state === 'interrupted' ? interruptedReason(run) : text(why?.summary) || (state === 'missing' ? problems[0] : '')
  // A run Hermes cancelled says who did it and why first (the chat's model can cancel: the person always sees it),
  // and keeps roko's summary under it: what roko had done before the cancel.
  const cancel = state === 'cancelled' ? cancelWords(run) : ''

  if (isActiveRun(run) || state === 'succeeded' || !(summary || cancel)) {
    return null
  }

  const failing = list(why?.gates_not_passed).filter(isRecord)
  // roko stopped the run at its cap (0.5.0 `budget_stop`): a stop, said as one, with the task it stopped to inspect.
  const stop = capStopped(run)
  const capped = stop && isRecord(run.budget_stop) ? [...list(run.budget_stop.stopped), ...list(run.budget_stop.not_started)].filter(isRecord) : []
  const target = text(failing[0]?.task_id) || text(list(why?.blocked).filter(isRecord)[0]?.blocked_by) || text(capped[0]?.task_id)
  const tone = stop ? 'muted' : state === 'failed' ? 'bad' : state === 'cancelled' ? 'muted' : 'warn'
  // The plan failed roko's validator while the run waited (0.5.0 `why.validation`): its findings as a list, not
  // as the summary's run-on sentence.
  const validation = isRecord(why?.validation) ? why.validation : null
  const said = validation ? summary.split(/\s*roko[’']s check of the plan says:/)[0].trim() : summary

  return h(
    'div',
    { className: 'roko-why', 'data-testid': 'why', 'data-tone': tone, role: 'note' },
    h(Codicon, { className: 'roko-why-icon', name: stop || state === 'cancelled' ? 'debug-stop' : state === 'failed' ? 'error' : state === 'interrupted' ? 'debug-pause' : 'warning', size: '0.95rem' }),
    h(
      'div',
      { className: 'roko-why-body' },
      h('div', { className: 'roko-why-title' }, stop ? WHY_TITLES.cancelled : (WHY_TITLES[state] ?? 'What happened')),
      cancel ? h('p', { className: 'roko-why-text roko-why-cancel', 'data-testid': 'why-cancel' }, cancel) : null,
      said ? h('p', { className: 'roko-why-text' }, typeOut ? h(TypeOut, { value: said }) : said) : null,
      validation ? h(ValidationItems, { validation }) : null,
      validation ? h(ValidationStep, { group: planGroup, planId: text(run.plan_id), validation }) : null,
      // What its resume may do (P-51), in the backend's words: the page promises nothing of its own.
      text(run.next?.note) ? h('p', { className: 'roko-why-text', 'data-testid': 'why-next' }, text(run.next.note)) : null,
      target && onInspect
        ? h(Button, { onClick: () => onInspect(target), size: 'xs', type: 'button', variant: 'outline' }, h(Codicon, { name: 'search', size: '0.75rem' }), `Inspect ${clip(target, 20)}`)
        : null
    )
  )
}

function Delivered({ run, onReview }) {
  const d = isRecord(run.delivered) ? run.delivered : null
  const demo = useDemoRun(run, Boolean(d))

  if (!d) {
    return null
  }

  const files = list(d.files_changed).map(text).filter(Boolean)

  return h(
    'div',
    { className: 'roko-delivered', 'data-testid': 'delivered' },
    h(
      SectionLabel,
      {
        right:
          d.merged === true
            ? h('span', { className: 'roko-tone-good' }, '✓ merged')
            : h('span', { className: 'roko-muted' }, demo ? 'demo output, stays on its branch' : 'not merged yet')
      },
      'Delivered'
    ),
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
      d.merged === true || demo !== false || run.state === 'interrupted' ? null : h(CopyCommand, { command: run.merge_command, label: 'Copy merge command', variant: 'ghost' })
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

/** The Overview of a run: its sequencer (one pad per task, one pad for one task), replay, inspector, the latest lines. */
function RunOverview({ run, events, eventsError, eventsLoading, inspect, setInspect, onView, live, bare = false }) {
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
  const playhead = playheadOf(graph.waves, nodes, replayT !== null ? 'replay' : active ? 'live' : null)

  useEffect(() => {
    if (active) {
      setReplayT(null)
    }
  }, [active])

  return h(
    'div',
    { className: bare ? 'roko-overview' : 'roko-overview rk-gut' },
    tasks.length
      ? h(
          'div',
          { className: 'roko-graph-card' },
          h(
            'div',
            { className: 'roko-graph-head' },
            bare ? null : h(ModLabel, null, 'sequencer'),
            bare ? null : h('span', { className: 'roko-graph-title' }, single ? 'one task' : `${plural(tasks.length, 'task')} · ${plural(graph.waves.length, 'wave')}`),
            single ? null : h(GraphLegend, { progress }),
            h('span', { className: 'roko-flex' }),
            span && replayT === null
              ? h(Button, { 'data-testid': 'replay-start', onClick: () => setReplayT(span.start), size: 'xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'history', size: '0.75rem' }), 'Replay')
              : null
          ),
          // One task is one pad: its inspector stays open below it.
          h(RunGraph, {
            edges: graph.edges,
            live: replayT === null ? live : null,
            nodes,
            onSelect: id => (single ? undefined : setInspect(selectedId === id ? null : id)),
            playhead: playhead && (playhead.mode === 'live' || playhead.mode === 'replay') ? playhead : null,
            selected: selectedId,
            testId: 'run-graph',
            waves: graph.waves
          }),
          span && replayT !== null ? h(ReplayBar, { events, onChange: setReplayT, onExit: () => setReplayT(null), span, t: replayT }) : null,
          selectedTask
            ? h(TaskInspector, {
                live,
                node: nodes.get(nodeIdOf(selectedTask)),
                onClose: single ? null : () => setInspect(null),
                onSelect: id => setInspect(id),
                run,
                task: selectedTask
              })
            : single
              ? null
              : h('div', { className: 'roko-graph-hint' }, h(Codicon, { name: 'info', size: '0.75rem' }), 'Pick a task to see its tries, the model each used, what its agent is doing and what it said.')
        )
      : h(
          'div',
          { className: 'roko-graph-card roko-graph-empty' },
          active ? h(Loader, { className: 'rk-loader', label: 'Setting the run up', type: 'rose-curve' }) : null,
          run.state === 'queued' ? 'Waiting in roko’s queue…' : active ? 'roko is setting the run up…' : 'This run recorded no tasks.'
        ),
    // On a run's page the stream is a fold of its own; a replay shows it here, at the playhead.
    bare && replayT === null ? null : h(Stream, { events, focus: selectedTask ? text(selectedTask.task_id) : null, live, replayT, run }),
    eventsError ? h('div', { className: 'rk-gut-note' }, h(ErrorNote, { compact: true, error: eventsError })) : null,
    run.delivered && !bare ? h('div', { className: 'rk-gut-note' }, h(Delivered, { onReview: () => onView('changes'), run })) : null
  )
}

/** A try's phases as the time view says them. */
const TIME_WORDS = { agent: 'model and tools', checks: 'checks', model: 'model', other: 'prompt and other', tools: 'tools' }

/**
 * A try's time as [kind, ms] segments that make its duration (#4): roko's split (22de26a8c), model and tools as one
 * span when an older roko did not measure them apart (bug-15ba19); else the agent's span and its checks'.
 */
function trySegments(t, ms) {
  const tm = isRecord(t.timing) ? t.timing : {}
  const n = key => num(tm[key]) ?? 0
  const rest = ['other', n('prompt_ms') + n('other_ms')]
  const parts =
    tm.basis === 'roko'
      ? tm.split === false
        ? [['agent', n('model_ms') + n('tools_ms')], ['checks', n('checks_ms')], rest]
        : [['model', n('model_ms')], ['tools', n('tools_ms')], ['checks', n('checks_ms')], rest]
      : [['agent', num(tm.agent_ms) ?? ms], ['checks', n('checks_ms')]]

  return parts.filter(([, v]) => v > 0)
}

/**
 * Where a run's time went (#4, mockup m3): its tasks as lanes on the run's clock, each try a run of its phases, the
 * critical path outlined (back from the task that ended last, through its latest dependency); then each phase's
 * share of the tries' time. Exact when roko split every try, else "≈ from event times".
 */
function TimeView({ run, onInspect }) {
  const now = Date.now()
  const lanes = list(run.tasks)
    .filter(isRecord)
    .map(task => ({
      deps: list(task.depends_on).map(text),
      id: text(task.task_id),
      title: taskTitle(task, run),
      tries: list(task.climb)
        .filter(isRecord)
        .map(t => {
          const start = parseTime(t.started_at)
          const ms = num(t.duration_ms) ?? (start !== null && t.outcome === 'running' ? Math.max(0, now - start) : null)

          return start === null || ms === null ? null : { end: start + ms, ms, segs: trySegments(t, ms), start, t }
        })
        .filter(Boolean)
    }))
    .filter(lane => lane.tries.length)

  if (!lanes.length) {
    return h(Empty, { icon: 'clock', title: 'No try has a time yet' }, 'Each try shows here once its agent starts.')
  }

  const tries = lanes.flatMap(lane => lane.tries)
  const t0 = Math.min(parseTime(run.started_at) ?? Infinity, ...tries.map(x => x.start))
  const span = Math.max(1, Math.max(parseTime(run.finished_at) ?? 0, ...tries.map(x => x.end)) - t0)
  const ends = new Map(lanes.map(lane => [lane.id, Math.max(...lane.tries.map(x => x.end))]))
  const path = []

  for (let at = [...ends].sort((a, b) => b[1] - a[1])[0][0]; at && !path.includes(at); ) {
    path.unshift(at)
    at = lanes.find(lane => lane.id === at).deps.filter(d => ends.has(d)).sort((a, b) => ends.get(b) - ends.get(a))[0]
  }

  const sums = {}

  tries.forEach(x => x.segs.forEach(([k, v]) => (sums[k] = (sums[k] ?? 0) + v)))

  const total = Object.values(sums).reduce((a, b) => a + b, 0) || 1
  const calls = key => tries.reduce((n, x) => n + (num(x.t.timing?.[key]) ?? 0), 0)
  const unsplit = tries.filter(x => x.t.timing?.basis === 'roko' && x.t.timing.split === false).length
  const exact = tries.every(x => x.t.timing?.basis === 'roko')
  const pathMs = lanes.filter(lane => path.includes(lane.id)).reduce((n, lane) => n + ends.get(lane.id) - Math.min(...lane.tries.map(x => x.start)), 0)
  const gate = isRecord(run.spec_gate) && run.spec_gate.state === 'done' ? run.spec_gate : null
  const row = (k, b, words, extra = {}) => h('div', { className: 'rk-tsplit-row', key: k, ...extra }, h('span', null, k), h('b', null, b), h('span', null, words))

  return h(
    'div',
    { className: 'rk-time', 'data-testid': 'time-view' },
    h(
      Glass,
      { className: 'rk-tl' },
      h(ModLabel, { note: 'tasks as lanes · each try a run of its phases', right: exact ? 'roko’s own split of each try' : '≈ from event times' }, 'where the time went'),
      h('div', { 'aria-hidden': 'true', className: 'rk-tl-key' }, Object.keys(sums).map(k => h('span', { key: k }, h('i', { 'data-kind': k }), TIME_WORDS[k]))),
      h(
        'div',
        { 'aria-label': 'Tasks as lanes', role: 'list' },
        lanes.map(lane =>
          h(
            'div',
            { className: 'rk-tl-lane', 'data-critical': path.includes(lane.id) ? 'true' : undefined, key: lane.id, role: 'listitem' },
            h('button', { className: 'rk-tl-name', onClick: () => onInspect(lane.id), type: 'button' }, h('b', null, clip(lane.id, 14)), h('small', null, clip(lane.title, 40))),
            h(
              'span',
              { className: 'rk-tl-rail' },
              lane.tries.map(x =>
                h(
                  'span',
                  {
                    className: 'rk-tl-try',
                    'data-outcome': text(x.t.outcome),
                    key: x.start,
                    style: { left: `${((x.start - t0) / span) * 100}%`, width: `${Math.max(0.5, (x.ms / span) * 100)}%` },
                    title: [`try ${num(x.t.attempt) ?? ''}`, text(x.t.rung) || text(x.t.model), duration(x.ms), ...x.segs.map(([k, v]) => `${TIME_WORDS[k]} ${duration(v)}`)].filter(Boolean).join(' · ')
                  },
                  x.segs.map(([k, v]) => h('i', { 'data-kind': k, key: k, style: { flexGrow: v } }))
                )
              )
            )
          )
        )
      ),
      h('div', { 'aria-hidden': 'true', className: 'rk-tl-axis' }, [0, 0.5, 1].map(f => h('span', { key: f, style: { left: `${f * 100}%` } }, clockFace(span * f))))
    ),
    h(
      Glass,
      { className: 'rk-tsplit', testId: 'time-split' },
      h(ModLabel, { note: `${plural(tries.length, 'try', 'tries')} · ${duration(total)} of try time in ${duration(span)}` }, 'what roko waited on'),
      h('span', { 'aria-hidden': 'true', className: 'rk-tl-try rk-tsplit-bar' }, Object.entries(sums).map(([k, v]) => h('i', { 'data-kind': k, key: k, style: { flexGrow: v } }))),
      Object.entries(sums).map(([k, v]) => row(TIME_WORDS[k], `${Math.round((v / total) * 100)}%`, [duration(v), k === 'model' && calls('model_calls') ? plural(calls('model_calls'), 'call') : '', k === 'tools' && calls('tool_calls') ? plural(calls('tool_calls'), 'call') : ''].filter(Boolean).join(' · '))),
      row('critical path', path.join(' → '), `${duration(pathMs)} of ${duration(span)}`, { 'data-path': 'true' }),
      gate ? row('spec gate', duration(num(gate.elapsed_ms) ?? num(gate.ms)), `${plural(num(gate.steps_done) ?? 0, 'step')}${num(gate.cached) ? ` · ${num(gate.cached)} cached` : ''}`) : null,
      unsplit ? h('p', { className: 'rk-tsplit-note' }, `${plural(unsplit, 'try', 'tries')} did not split model from tools (a roko before f407b62e9)`) : null
    )
  )
}

/** A run's file as a data URL: the backend's URL-safe base64 made standard. */
const dataUrl = file => `data:${text(file.mime)};base64,${text(file.data).replace(/-/g, '+').replace(/_/g, '/')}`
const madeFile = (runId, path) => call(`/runs/${enc(runId)}/artifact?path=${enc(path)}`)
const useMade = runId => useQuery({ queryFn: () => call(`/runs/${enc(runId)}/artifacts`), queryKey: [...KEYS.run(runId), 'made'], retry: false, staleTime: 300_000 })
const useShot = (runId, path, enabled = true) => useQuery({ enabled, queryFn: () => madeFile(runId, path), queryKey: [...KEYS.run(runId), 'made', path], retry: false, staleTime: Infinity })


/**
 * What a run made (#7): the UI shots, sounds and reports its delivered work added under artifacts/, read from git
 * by the backend and their bytes checked there (GET /runs/{id}/artifacts). A sound draws its waveform from its
 * peaks and plays only when its key is pressed.
 */
function RunMade({ run }) {
  const runId = text(run.run_id)
  const query = useMade(runId)
  const items = list(query.data?.items).filter(isRecord)
  const shots = items.filter(item => item.kind === 'image')
  const [at, setAt] = useState(null)

  return items.length
    ? h(Glass, { className: 'rk-made', testId: 'run-made' }, h(ModLabel, { right: plural(items.length, 'file') }, 'what it made'), h('div', { className: 'rk-made-items' }, items.map(item => h(MadeItem, { item, key: text(item.path), onOpen: () => setAt(shots.indexOf(item)), runId }))), h(ShotDialog, { at, onAt: setAt, runId, shots }))
    : null
}

/** A run's shot large (phase 4 prep A): ←/→ go to its other shots, Esc closes. */
function ShotDialog({ runId, shots, at, onAt }) {
  const item = shots[at]
  const shot = useShot(runId, text(item?.path), Boolean(item))
  const move = e => /^Arrow(Left|Right)$/.test(e.key) && onAt((at + (e.key === 'ArrowRight' ? 1 : shots.length - 1)) % shots.length)
  const size = item && `${num(item.width)} × ${num(item.height)} · ${Math.round((num(item.bytes) ?? 0) / 1024)} KB${shots.length > 1 ? ` · ${at + 1} of ${shots.length}` : ''}`

  return h(Dialog, { onOpenChange: open => !open && onAt(null), open: Boolean(item) }, item ? h(DialogContent, { className: 'roko rk-shot-dialog', onKeyDown: move }, h(DialogHeader, null, h(DialogTitle, null, text(item.name)), h(DialogDescription, null, size)), isRecord(shot.data) ? h('img', { alt: text(item.name), className: 'rk-shot-big', src: dataUrl(shot.data) }) : h('span', { className: 'rk-made-wait' }, shot.error ? 'not shown' : '…')) : null)
}

/** One file a run made: a shot shown whole, a sound with its waveform and play key, a report with its tool's verdict. */
function MadeItem({ item, runId, onOpen }) {
  const name = text(item.name)
  const path = text(item.path)
  const shot = useShot(runId, path, item.kind === 'image')
  const [state, setState] = useState(null)
  const playing = useRef(null)

  useEffect(() => () => playing.current?.pause(), [])

  if (item.kind === 'image') {
    return h(
      'figure',
      { className: 'rk-made-shot', 'data-testid': `made-${name}` },
      isRecord(shot.data)
        ? h('button', { 'aria-label': `Open ${name} large`, className: 'rk-made-open', onClick: onOpen, type: 'button' }, h('img', { alt: `${name}, ${num(item.width)} × ${num(item.height)}`, src: dataUrl(shot.data) }))
        : h('span', { className: 'rk-made-wait' }, shot.error ? 'not shown' : '…'),
      h('figcaption', null, name)
    )
  }

  if (item.kind === 'audio') {
    const a = isRecord(item.audio) ? item.audio : {}
    const peaks = list(a.peaks).map(v => num(v) ?? 0)
    const bars = Array.from({ length: 60 }, (_, i) => Math.max(0, ...peaks.slice(Math.floor((i * peaks.length) / 60), Math.floor(((i + 1) * peaks.length) / 60))))
    // Never on its own: the bytes are asked for on the press, and a second press stops it. The browser decodes the
    // sound from its data URL (the plugin decodes no base64 itself).
    const play = async () => {
      if (playing.current) {
        playing.current.pause()
        playing.current = null
        setState(null)

        return
      }

      setState('loading')

      try {
        const audio = new window.Audio(dataUrl(await madeFile(runId, path)))

        audio.onended = () => {
          playing.current = null
          setState(null)
        }
        playing.current = audio
        await audio.play()
        setState('playing')
      } catch {
        playing.current = null
        setState('could not play it')
      }
    }

    return h(
      'div',
      { className: 'rk-made-sound', 'data-playing': state === 'playing' ? 'true' : undefined, 'data-testid': `made-${name}` },
      h(Key, { 'aria-label': `${state === 'playing' ? 'stop' : 'play'} ${name}`, onClick: () => void play(), size: 's' }, state === 'playing' ? '■' : '▶'),
      h('span', { className: 'rk-made-name' }, h('b', null, name), h('small', null, [duration((num(a.seconds) ?? 0) * 1000), num(a.rate) ? `${num(a.rate) / 1000} kHz` : '', num(a.bits) ? `${num(a.bits)}-bit` : '', state && state !== 'playing' ? state : ''].filter(Boolean).join(' · '))),
      h('span', { 'aria-hidden': 'true', className: 'rk-made-wave' }, bars.map((v, i) => h('i', { key: i, style: { height: `${Math.round(v * 100)}%` } })))
    )
  }

  return h(
    'div',
    { className: 'rk-made-report', 'data-testid': `made-${name}`, 'data-verdict': text(item.verdict) || undefined },
    h('b', null, name),
    item.verdict ? h('span', null, item.verdict === 'passed' ? '✓ passed' : '✕ failed') : null,
    text(item.line) ? h('small', null, clip(item.line, 120)) : null
  )
}

/** What the overview row knows, when the run itself can't be loaded (roko unreachable). */
/** The words for a run shown as its last known state while roko serve is down (`lastKnown`). */
function LastKnownNote({ run }) {
  const at = clock(parseTime(run.last_seen_at))

  return h(
    'div',
    { className: 'rk-last-known', 'data-testid': 'last-known', role: 'note' },
    `roko serve is not answering: this is the run’s last known state${at ? `, from ${at}` : ''}. It may still be going, or it stopped when roko did.`
  )
}

function RowCard({ row, error, onRetry, compact }) {
  const d = describe(error)
  const seen = row.state === 'last_seen'
  // roko serve not answering is said once, in the setup card; this card says only what it shows.
  const down = error instanceof RokoError && error.code === 'unreachable'
  const look = cardLook(row)

  return h(
    'div',
    { className: 'roko roko-card roko-run rk-rc', 'data-compact': compact ? 'true' : undefined, 'data-look': look.state, 'data-state': text(row.state), 'data-testid': `run-card-${text(row.run_id)}` },
    h('div', { className: 'rk-rc-head' }, h(CardPill, { look }), h('span', { className: 'rk-rc-title roko-run-title' }, text(row.label) || 'a roko run'), h('span', { className: 'rk-rc-when' }, cardWhen(row))),
    h(CardGlass, { look, run: row, size: compact ? 'M' : 'L' }),
    seen ? h(LastKnownNote, { run: row }) : null,
    h(
      'div',
      { className: 'roko-quiet' },
      h(Codicon, { name: 'info', size: '0.8rem' }),
      h('span', null, seen ? text(d.hint) || 'Retry once roko serve is back.' : down ? 'Last known state.' : `Last known state. ${d.message}`),
      h(Button, { onClick: onRetry, size: 'xs', type: 'button', variant: 'ghost' }, 'Retry')
    )
  )
}

const PLANNER_WORDS = 'roko’s planner is breaking the request into tasks, each with its own checks. Nothing runs until you start the plan.'

/** roko's planner stages (`writing.stage`) in words: the backend's own (rundata.WRITING_STAGES). */
const WRITING_STAGES = { fixing: 'fixing the plan', planning: 'planning', recording: 'recording it', regenerating: 'rewriting the plan', retrying: 'retrying', writing: 'writing its files' }
/** The stages that try again, and say why. */
const WRITING_WHY = new Set(['fixing', 'regenerating', 'retrying'])

/**
 * Where roko's planner is: "writing the plan: planning · attempt 1 of 1 · 0:12 · $0.00 · glm-5.1", or for a stage
 * that tries again, why ("retrying: the planner call ran into roko's 300 s limit … · attempt 2 of 2 · …"). The
 * clock ticks here from the card's `elapsed_s`.
 */
function WritingLine({ run, writing }) {
  const stage = text(writing.stage)
  const words = WRITING_STAGES[stage] ?? stage
  const reason = WRITING_WHY.has(stage) ? text(writing.reason) : ''
  // A clock only from a sane elapsed time (0 to a day); otherwise the line has none.
  const since = sinceIso(parseTime(run.checked_at) ?? Date.now(), writing.elapsed_s)

  return h(
    'div',
    { className: 'roko-plangen-stage', 'data-stage': stage, 'data-testid': 'plangen-stage' },
    reason ? `${words}: ${clip(reason, 200)}` : `writing the plan: ${words}`,
    num(writing.attempt) && num(writing.attempts) ? ` · attempt ${writing.attempt} of ${writing.attempts}` : '',
    since ? h(Fragment, null, ' · ', h(StepClock, { since })) : null,
    num(writing.cost_usd) !== null ? ` · ${money(writing.cost_usd)}` : '',
    text(writing.model) ? h('span', { className: 'roko-muted' }, ` · ${clip(writing.model, 40)}`) : null
  )
}

/**
 * The coverage line of `source_checks` (worded as the dashboard does): "Your spec states 8 checks · 8 kept", else
 * "3 of 7 kept · 1 cannot run · 1 shallow · …" (the counts that are not zero), and "· asked again".
 */
function coverageLine(sc) {
  const total = num(sc?.total) ?? 0
  const kept = num(sc?.kept) ?? 0
  const parts =
    kept === total
      ? [`Your spec states ${plural(total, 'check')}`, `${kept} kept`]
      : [`${kept} of ${total} kept`, ...['cannot_run', 'shallow', 'dropped', 'missing'].filter(k => (num(sc[k]) ?? 0) > 0).map(k => `${num(sc[k])} ${k.replace('_', ' ')}`)]

  return [...parts, sc?.regenerated === true ? 'asked again' : ''].filter(Boolean).join(' · ')
}

/**
 * The chat card's sentence: "1 of 6 checks your spec states is not in this plan" ("2 of 6 … are not"), and "1 of 6 …
 * cannot run as written" (F11); '' when neither.
 */
function missingChecksLine(sc) {
  const missing = num(sc?.missing) ?? 0
  const blocked = num(sc?.cannot_run) ?? 0
  const total = num(sc?.total) ?? 0

  return total > 0
    ? [
        missing > 0 ? `${missing} of ${plural(total, 'check')} your spec states ${missing === 1 ? 'is' : 'are'} not in this plan` : '',
        blocked > 0 ? `${blocked} of ${plural(total, 'check')} your spec states cannot run as written` : ''
      ]
        .filter(Boolean)
        .join('; ')
    : ''
}

/** roko's validator notes on the plan (P-41): its warnings, each with roko's code and roko's message, not reworded. */
function ValidatorNotes({ notes }) {
  const rows = list(notes).filter(n => isRecord(n) && text(n.message)).slice(0, 10)

  return rows.length
    ? h(
        'div',
        { className: 'rk-vnotes', 'data-testid': 'validator-notes' },
        h(ModLabel, null, 'roko’s validator notes'),
        h('ul', null, ...rows.map((n, i) => h('li', { key: i }, h('code', null, text(n.rule) || 'note'), text(n.task_id) ? ` ${text(n.task_id)}: ` : ' ', text(n.message))))
      )
    : null
}

/** roko's repairs to its planner's draft (roko 7c3b523a8), in roko's words, its `code` as code. */
function PlanRepairs({ repairs }) {
  const rows = list(repairs).filter(r => text(r)).slice(0, 20)

  return rows.length ? h('div', { className: 'rk-vnotes', 'data-testid': 'plan-repairs' }, h(ModLabel, null, 'roko repaired the draft'), h('ul', null, ...rows.map((r, i) => h('li', { key: i }, mdWords(r, `r${i}`))))) : null
}

/**
 * What was asked for the plan (P-1), from the plugin's run log: roko's plan sheet does not repeat a chat's request, so
 * the person saw the chat model's rewording only in Hermes' tool-call arguments. Untrusted text, shown as text.
 */
function PlanAsked({ asked }) {
  const said = text(asked?.text)
  const spec = text(asked?.spec_path)

  if (!said && !spec) {
    return null
  }

  const chat = text(asked.by) !== 'page'
  // What writing it cost of its cap (P-43): that cap was the writing's, never a run's.
  const cost = num(asked.cost_usd)
  const cap = num(asked.max_usd)

  return h(
    'div',
    { className: 'rk-asked', 'data-testid': 'plan-asked' },
    h(ModLabel, { right: chat ? 'the chat model’s words, as Hermes sent them' : 'from this page' }, chat ? 'what the chat asked roko' : 'what you asked roko'),
    spec ? h('p', { className: 'rk-asked-spec' }, 'the spec ', h('code', null, spec), ', which roko read itself') : null,
    // The run log keeps at most 600 characters: a few lines, shown whole.
    said ? h('p', { className: 'rk-asked-text' }, said) : null,
    cost !== null || cap !== null
      ? h('p', { className: 'rk-asked-spec', 'data-testid': 'plan-asked-cap' }, cost === null ? `writing it was capped at ${money(cap)}` : `writing it cost ${money(cost)}${cap === null ? '' : ` of its ${money(cap)} cap`}`)
      : null
  )
}

/**
 * What became of each check the request's spec states (0.6.0 `source_checks`, roko's planner's report): the coverage
 * line (orange when one is missing), then each check with its status, the task and criterion that keep it, and the
 * command that covers a shallow one. Open when one is missing; folded in a chat card. Untrusted text, shown as text.
 */
function SourceChecks({ sc, compact = false }) {
  const total = num(sc?.total) ?? 0

  if (!isRecord(sc) || !total) {
    return null
  }

  // Missing, or covered but unable to pass as written (F11): the plan may not prove it, so it is the person's to see.
  const missing = (num(sc.missing) ?? 0) > 0 || (num(sc.cannot_run) ?? 0) > 0
  const checks = list(sc.checks).filter(c => isRecord(c) && text(c.id)).slice(0, 40)

  return h(
    'details',
    { className: 'rk-sc', 'data-compact': compact ? 'true' : undefined, 'data-testid': 'source-checks', open: missing && !compact ? true : undefined },
    h(
      'summary',
      null,
      h(ModLabel, null, 'your spec’s checks'),
      h('span', { className: 'rk-sc-line', 'data-missing': missing ? 'true' : undefined, 'data-testid': 'source-checks-line' }, coverageLine(sc)),
      list(sc.from).length ? h('span', { className: 'rk-sc-from', 'data-testid': 'source-checks-from' }, `from ${list(sc.from).map(text).filter(Boolean).join(', ')}`) : null
    ),
    checks.length
      ? h(
          'ul',
          { 'aria-label': 'The checks your spec states', className: 'rk-sc-list' },
          checks.map((c, i) => {
            const status = ['kept', 'shallow', 'dropped', 'missing', 'cannot_run'].includes(text(c.status)) ? text(c.status) : ''
            const where = [clip(c.task, 16), clip(c.criterion, 16)].filter(Boolean).join(' ')
            const reason = clip(c.reason, 200)

            return h(
              'li',
              { 'data-status': status || undefined, key: i },
              h('span', { className: 'rk-sc-id' }, clip(c.id, 10)),
              h('span', { className: 'rk-sc-chip', 'data-status': status || undefined }, status.replace('_', ' ') || clip(c.status, 12) || '?'),
              h('span', { className: 'rk-sc-check', title: clip(c.check, 300) }, clip(c.check, 300)),
              where ? h('span', { className: 'rk-sc-where' }, where) : null,
              reason && (status === 'dropped' || status === 'cannot_run') ? h('span', { className: 'rk-sc-why' }, `why: ${reason}`) : null,
              reason && status === 'shallow' ? h('span', { className: 'rk-sc-why' }, `only: ${reason}`) : null
            )
          })
        )
      : null
  )
}

/** A plan generation: the planner at work, then the plan it wrote. */
function PlanGenView({ run }) {
  const active = isActiveRun(run)
  const planId = text(run.plan_id)
  // Where roko's planner is (0.5.0, roko gap-11d870); null from an older roko and before its first stage.
  const writing = isRecord(run.writing) && text(run.writing.stage) ? run.writing : null
  // roko wrote the plan, but its validator will not run it yet (0.5.0 `validation`): the person's turn, in orange.
  const blocked = !active && isRecord(run.validation)

  return h(
    'div',
    { className: 'roko roko-card roko-run roko-plangen', 'data-testid': `run-card-${text(run.run_id)}` },
    h(
      'div',
      { className: 'roko-hero-top' },
      h(Dot, { pulse: active, tone: blocked ? 'warn' : stateInfo(run.state).tone }),
      h(StatePill, {
        // Not a check mark: the plan is written, but it is the person's turn (a question to answer, or a finding).
        glyph: blocked ? (list(run.validation.open_questions).some(isRecord) ? '?' : '!') : null,
        state: run.state,
        tone: blocked ? 'warn' : null,
        word: active ? null : blocked ? 'cannot run yet' : endWord(run.state, 'plan_generate')
      }),
      active ? h(KindBadge, { kind: 'plan_generate' }) : null,
      h(CopyId, { label: 'Copy run id', shown: shortRunId(run.run_id), value: run.run_id }),
      blocked && isRecord(run.next) && text(run.next.label) ? h('span', { className: 'roko-flex' }) : null,
      blocked && isRecord(run.next) && text(run.next.label) ? h(NextKey, { onView: () => undefined, run, view: null }) : null
    ),
    h('h2', { className: 'roko-hero-title', 'data-fresh': isFresh(run.run_id) && !reducedMotion() ? 'true' : undefined }, text(run.label) || 'A plan'),
    // roko's headline starts with the state word; a plan generation's end is "plan written" (or "planning failed").
    // While roko's planner says its stage (0.5.0 `writing`), the stage line below says it with a ticking clock.
    run.headline && !(active && writing)
      ? h('div', { className: 'roko-headline' }, text(run.headline).replace(/^(succeeded|failed)\b/, word => endWord(word, 'plan_generate')))
      : null,
    active
      ? h(
          'div',
          { className: 'roko-plangen-live' },
          h(Well, { className: 'rk-plangen-well' }, h(Loader, { className: 'rk-loader', label: 'Writing the plan', type: 'lemniscate-bloom' }), h(Dots, { label: 'planning', size: 'M', tone: 'agent', value: 'PLANNING' })),
          writing
            ? h('div', { className: 'roko-plangen-words' }, h(WritingLine, { run, writing }), h('div', { className: 'roko-muted' }, PLANNER_WORDS))
            : h('div', { className: 'roko-muted' }, PLANNER_WORDS)
        )
      : null,
    !active && text(run.planner_error) ? h('div', { className: 'roko-why', 'data-tone': 'bad' }, h(Codicon, { className: 'roko-why-icon', name: 'error', size: '0.95rem' }), h('div', { className: 'roko-why-body' }, h('div', { className: 'roko-why-title' }, 'The planner did not finish'), h('p', { className: 'roko-why-text' }, clip(run.planner_error, 600)))) : null,
    !active && !(validId(planId) && run.state === 'succeeded') ? h(SourceChecks, { sc: run.source_checks }) : null,
    !active && validId(planId) && run.state === 'succeeded' ? h(PlanDetail, { planId, sourceChecks: run.source_checks ?? null }) : null
  )
}

/** The run's loop events: the card's and the socket's, merged by key, oldest first. */
function runLoops(run, live) {
  const seen = new Set()
  const out = []

  for (const event of [...list(run?.loops).map(e => normLoop(e, run?.run_id)), ...live.loops]) {
    if (event && !seen.has(event.key)) {
      seen.add(event.key)
      out.push(event)
    }
  }

  return out.sort(byTs)
}

/**
 * One instrument per run. `standalone` (a chat card expanded) keeps its own view and selection; the page
 * shares them through atoms (deep links, keyboard).
 */
function RunView({ runId, fallback, standalone }) {
  const query = useRun(runId)
  const overview = useOverview()
  const reachable = isRecord(overview.data?.connection) ? overview.data.connection.reachable === true : null
  const run = lastKnown(query.data, reachable)
  const live = useLive(runId)
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
  const loops = useMemo(() => runLoops(run, live), [run, live])
  const moment = useEndMoment(run)
  // The first failure's why types out once, and stays typed (the moment itself ends after a beat).
  const [typed, setTyped] = useState(false)

  useEffect(() => {
    if (moment?.first) {
      setTyped(true)
    }
  }, [moment?.at])

  useFollow(run, overview.data?.runs)

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
      return h(RowCard, { error: query.error, onRetry: () => void query.refetch(), row: lastKnown(fallback, reachable) })
    }

    return query.error
      ? h(ErrorNote, { error: query.error, onRetry: () => void query.refetch() })
      : h(Empty, { icon: 'rocket', title: 'Run not found' })
  }

  if (run.kind === 'plan_generate') {
    return h(PlanGenView, { run })
  }

  const waiting = list(run.waiting).filter(item => isRecord(item) && !answered(item))
  const tasks = list(run.tasks).filter(isRecord)
  const nodes = new Map(tasks.map(task => [nodeIdOf(task), taskNode(task, null, run)]))
  const tokens = isRecord(run.tokens) ? run.tokens : null
  // A last-seen run's note already says roko is not answering; its events' failing fetch says nothing more.
  const eventsError = run.state === 'last_seen' ? null : events.error
  const foldOf = { activity: 'steps', changes: 'changes', time: 'time' }[view] ?? null
  const openFold = name => onView({ changes: 'changes', steps: 'activity', time: 'time' }[name] ?? 'overview')
  // The head's one next step; with the changes open, their own keys are the ones to press.
  const keys = active
    ? h(CancelRun, { keyed: true, run, size: 'xs' })
    : isRecord(run.next) && (text(run.next.action) || text(run.next.label))
      ? h(NextKey, { onView: next => onView(next), run, view: foldOf === 'changes' ? 'changes' : null })
      : isRecord(run.delivered) && run.delivered.merged !== true && foldOf !== 'changes'
        ? h(MergeControls, { compact: true, run })
        : null

  return h(
    'div',
    { className: 'roko roko-run rk-runpage', 'data-state': text(run.state), 'data-testid': `run-card-${text(run.run_id)}` },
    h(RunHead, { keys, live, moment, run }),
    run.reading === true ? h(ReadingNote, { run }) : null,
    run.state === 'last_seen' ? h(LastKnownNote, { run }) : null,
    query.error && run.state !== 'last_seen' ? h(ErrorNote, { compact: true, error: query.error, lastChecked: query.dataUpdatedAt, onRetry: () => void query.refetch() }) : null,
    h(WhyCallout, {
      onInspect: id => {
        const node = [...nodes.values()].find(n => n.taskId === id || n.id === id)

        setInspect(node ? node.id : id)
      },
      run,
      typeOut: typed
    }),
    // A last-seen run's sign-offs are only what roko last said: an answer needs roko, so they wait with it.
    waiting.length && run.state !== 'last_seen'
      ? h('section', { className: 'rk-runsec', 'data-testid': 'run-waiting' }, h('h3', { className: 'rk-home-h' }, 'Needs you'), waiting.map(item => h(PendingCard, { compact: true, item, key: text(item.code) || text(item.decision_id) })))
      : null,
    h(
      'div',
      { className: 'rk-runcols' },
      h('section', { className: 'rk-runsec rk-panel', 'data-testid': 'run-plan' }, h('h3', { className: 'rk-panel-h' }, 'The plan', h('span', null, tasks.length > 1 ? `${plural(tasks.length, 'task')} in ${plural(graphOf(run).waves.length, 'step')}` : tasks.length ? 'one task' : '')), h(RunOverview, { bare: true, events: events.events, eventsError, eventsLoading: events.loading, inspect, live, onView, run, setInspect })),
      // P-46: an ended run's models are the ones roko recorded it ran on; else the project's as they are now.
      list(run.ladder).length ? h('section', { className: 'rk-runsec rk-panel', 'data-testid': 'run-models' }, h('h3', { className: 'rk-panel-h' }, 'Models', h('span', null, `${run.ladder_from === 'run' ? 'as it ran: ' : ''}cheapest first; a stronger one only after failed checks`)), h(Ladder, { run })) : null
    ),
    // What its work added under artifacts/ (#7): shots, sounds, reports.
    !active && isRecord(run.delivered) ? h('section', { className: 'rk-runsec rk-panel' }, h('h3', { className: 'rk-panel-h' }, 'What it made'), h(RunMade, { run })) : null,
    h(RunLessons, { run }),
    h(
      'div',
      { className: 'rk-folds' },
      // While it runs, what its agents do is the thing to watch: open; once it ended, folded.
      h(Fold, { key: active ? 'agents-live' : 'agents', name: 'agents', open: active, title: active ? 'what the agents are doing' : 'what the agents did' }, h(Horizon, { live, run }), h(Stream, { events: events.events, focus: null, live, replayT: null, run })),
      h(Fold, { lazy: true, name: 'steps', onOpen: openFold, open: foldOf === 'steps', title: `every step${events.events.length ? ` · ${events.events.length}` : ''}` }, h(ActivityFeed, { active, earlier: events.earlier, error: eventsError, events: events.events, loading: events.loading, loadingEarlier: events.loadingEarlier, onEarlier: events.loadEarlier, reading: events.reading, rowsRead: events.rowsRead, startMs: parseTime(run.started_at) ?? eventSpan(events.events)?.start ?? null })),
      h(Fold, { name: 'time', onOpen: openFold, open: foldOf === 'time', title: 'where the time went' }, h(TimeView, { onInspect: id => setInspect(id), run })),
      run.delivered || workParts(run).length ? h(Fold, { lazy: true, name: 'changes', onOpen: openFold, open: foldOf === 'changes', title: 'the changes' }, run.delivered ? h(Delivered, { onReview: () => undefined, run }) : null, h(DiffViewer, { run })) : null,
      !active && run.state !== 'last_seen' && run.reading !== true ? h(Fold, { name: 'receipt', open: false, title: 'the receipt' }, h(Receipt, { compact: true, key: moment?.tier >= 4 ? `print${moment.at}` : 'receipt', onView, print: moment?.tier >= 4, run })) : null,
      h(
        Fold,
        { name: 'about', open: false, title: 'about this run' },
        h(
          'div',
          { className: 'roko-run-foot' },
          h('span', { className: 'roko-muted roko-mono', 'data-testid': 'run-id', title: text(run.run_id) }, `run ${shortRunId(run.run_id)}`),
          run.origin ? h('span', { className: 'roko-muted' }, `from ${text(run.origin)}`) : null,
          // Cache reads cost money too (often most of it), so the line counts them.
          tokens
            ? h(
                'span',
                { className: 'roko-muted', 'data-testid': 'run-tokens' },
                `${(num(tokens.input) ?? 0).toLocaleString()} in · ${(num(tokens.output) ?? 0).toLocaleString()} out${num(tokens.cache_read) ? ` · ${num(tokens.cache_read).toLocaleString()} cached` : ''} tokens`
              )
            : null,
          num(run.events_read) ? h('span', { className: 'roko-muted' }, `${plural(run.events_read, 'event')} read`) : null
        )
      )
    )
  )
}

/**
 * A fold of a run's page (design system §4.11). A `lazy` one (every step, the changes: each fetches more) renders its
 * body only once opened; the others are there, folded, so a search of the page finds them.
 */
function Fold({ name, title, open = false, onOpen, lazy = false, children }) {
  const [shown, setShown] = useState(open)

  useEffect(() => {
    if (open) {
      setShown(true)
    }
  }, [open])

  return h(
    'details',
    {
      className: 'rk-fold2',
      'data-fold': name,
      'data-testid': `fold-${name}`,
      onToggle: event => {
        const now = event.currentTarget.open

        setShown(now)

        if (now && onOpen) {
          onOpen(name)
        }
      },
      open: shown
    },
    h('summary', null, title),
    shown || !lazy ? h('div', { className: 'rk-fold2-body' }, children) : null
  )
}

/** A run's title: a plan run started without one is named by its plan's slug, so it shows the plan's own title. */
function useRunTitle(run) {
  const slugOnly = isRecord(run) && run.kind === 'plan' && text(run.label) === text(run.plan_id)
  const plan = usePlan(slugOnly ? text(run.plan_id) : null)

  return slugOnly && text(plan.data?.title) ? text(plan.data.title) : text(run?.label) || 'a roko run'
}

/** The head of a run's page (design system §4.8, at full width): the pill, the title, the glass, one sentence, the keys. */
function RunHead({ run, live, keys, moment }) {
  const title = useRunTitle(run)
  const request = text(run.request)
  const showRequest = request && clip(request, 118) !== clip(run.label, 118)
  const look = cardLook(run)

  return h(
    'header',
    { className: 'rk-runhead', 'data-look': look.state },
    h(
      'div',
      { className: 'rk-rc-head' },
      h(CardPill, { look }),
      // The end, as it happens: its word flashes once beside the pill (design system §3.6).
      moment ? h('span', { className: 'rk-moment2', 'data-testid': 'end-moment', 'data-tier': String(moment.tier), key: `m${moment.at}` }, moment.stamp.word) : null,
      h('h2', { className: 'rk-runhead-title', 'data-fresh': isFresh(run.run_id) && !reducedMotion() ? 'true' : undefined }, title),
      h(ProjectTag, { run }),
      h('span', { className: 'rk-rc-when' }, [cardWhen(run), run.source === 'ui' ? 'from this page' : run.session_id ? 'from a Hermes chat' : ''].filter(Boolean).join(' · '))
    ),
    showRequest ? h('p', { className: 'roko-hero-request' }, clip(request, 280)) : null,
    h(CardGlass, { look, run, size: 'L' }),
    h('div', { className: 'rk-rc-line' }, h('p', { className: 'rk-rc-status', 'data-state': look.state, 'data-testid': 'card-status' }, cardSentence(run, live)), keys ? h('div', { className: 'rk-rc-keys' }, keys) : null),
    // A provider roko went on without (bug-390e4b): roko's line, as it is.
    list(run.provider_exhausted).filter(isRecord).map(p => h('div', { className: 'roko-headline', 'data-testid': 'provider-out', 'data-tone': 'warn', key: text(p.provider) }, `⊘ ${text(p.detail)}`)),
    // A resume: the plan's runs together, what they spent and where its tasks are (dogfood U10).
    validId(run.resumes) || (isRecord(run.chain) && list(run.chain.run_ids).length > 1) || isRecord(run.set_aside)
      ? h(
          'div',
          { className: 'rk-runhead-more' },
          validId(run.resumes) ? h('button', { className: 'roko-link', 'data-testid': 'resumes', onClick: () => openRoko({ run: run.resumes }), type: 'button' }, 'it carries on an earlier run') : null,
          isRecord(run.chain) && list(run.chain.run_ids).length > 1
            ? h('span', { 'data-testid': 'plan-chain' }, `this plan over ${plural(list(run.chain.run_ids).length, 'run')}: `, [num(run.chain.cost_usd) !== null ? money(run.chain.cost_usd) : '', isRecord(run.chain.progress) && num(run.chain.progress.total) ? `${num(run.chain.progress.passed) ?? 0}/${num(run.chain.progress.total)} tasks passed` : ''].filter(Boolean).join(' · '))
            : null,
          isRecord(run.set_aside) ? h(SetAside, { aside: run.set_aside }) : null
        )
      : null
  )
}

/** What roko learned from a run (design system §6.1, "lesson"): each lesson its tasks kept, a line each. */
function RunLessons({ run }) {
  const lessons = list(run.tasks)
    .filter(isRecord)
    .flatMap(task => list(task.lessons).filter(l => isRecord(l) && text(l.lesson)).map(l => ({ ...l, task: text(task.task_id) })))
  const seen = new Set()
  const shown = lessons.filter(l => (seen.has(text(l.lesson)) ? false : (seen.add(text(l.lesson)), true))).slice(0, 4)

  return shown.length
    ? h(
        'section',
        { className: 'rk-runsec rk-panel', 'data-testid': 'run-lessons' },
        h('h3', { className: 'rk-panel-h' }, 'What roko learned', h('span', null, 'kept for later runs')),
        shown.map((l, i) =>
          h(
            'div',
            { className: 'rk-lesson', key: i },
            h('span', { 'aria-hidden': 'true' }, '◇'),
            h('span', null, clip(l.lesson, 240)),
            h('span', { className: 'rk-lesson-use' }, [/admitted/.test(text(l.admission)) ? 'kept' : 'offered', num(l.reinforced) ? `confirmed ${plural(num(l.reinforced), 'time')}` : '', taskName(l.task)].filter(Boolean).join(' · '))
          )
        )
      )
    : null
}

/** The run's plan in a run card on Runs (design system §4.7), read-only: a pad opens that task on the run's page. */
function CardPlan({ run, live }) {
  const tasks = list(run.tasks).filter(isRecord)
  const graph = useMemo(() => graphOf(run), [run])
  const nodes = useMemo(() => new Map(tasks.map(task => [nodeIdOf(task), taskNode(task, null, run)])), [tasks, run])
  const playhead = playheadOf(graph.waves, nodes, isActiveRun(run) ? 'live' : null)

  return tasks.length > 1
    ? h(RunGraph, {
        edges: graph.edges,
        live,
        nodes,
        onSelect: id => {
          selectRun(run.run_id)
          $inspect.set({ nodeId: id, runId: run.run_id })
        },
        playhead: playhead && playhead.mode === 'live' ? playhead : null,
        testId: 'card-plan',
        waves: graph.waves
      })
    : null
}

// --- The run card (roko's design system §4.8): the one shape a run takes in the chat and the side pane

/** A run's state as the design system says it (§6.2): its signal, its pill's word, and how its light blinks. */
function cardLook(run) {
  if (waitsOnYou(run)) {
    return { blink: 'fast', state: 'you', word: 'needs you' }
  }

  if (run.state === 'last_seen') {
    return { state: 'stop', word: 'last seen running' }
  }

  if (isActiveRun(run)) {
    if (run.state === 'queued') {
      return { state: 'wait', word: 'waiting' }
    }

    return { blink: 'slow', state: 'live', word: run.kind === 'plan_generate' ? 'writing the plan' : 'running' }
  }

  if (capStopped(run)) {
    return { state: 'stop', word: dayStopped(run) ? 'stopped at limit' : 'stopped at cap' }
  }

  switch (run.state) {
    case 'succeeded':
      return run.kind === 'plan_generate' && run.validation?.valid === false ? { state: 'you', word: 'cannot run yet' } : { state: 'pass', word: run.kind === 'plan_generate' ? 'plan written' : 'passed' }
    case 'failed':
      return { state: 'fail', word: run.kind === 'plan_generate' ? 'not written' : 'failed' }
    case 'interrupted':
      return { state: 'you', word: 'interrupted' }
    case 'unverified':
      return { state: 'stop', word: 'not checked' }
    case 'missing':
      return { state: 'stop', word: 'not started' }
    default:
      return { state: 'stop', word: 'stopped' }
  }
}

/** The state in a word, with its light: `● RUNNING`, `✓ PASSED` (§4.4). */
function CardPill({ look }) {
  const glyph = { fail: '✗', pass: '✓', stop: '■' }[look.state]

  return h(
    'span',
    { className: 'rk-pill', 'data-blink': look.blink, 'data-state': look.state, 'data-testid': 'card-pill' },
    glyph ? h('span', { 'aria-hidden': 'true', className: 'rk-pill-glyph' }, glyph) : h('i', { 'aria-hidden': 'true', className: 'rk-pill-led' }),
    look.word
  )
}

/** The plan as a strip (§4.7): a square a task, in plan order, a gap between steps. */
function PlanStrip({ run }) {
  const tasks = list(run.tasks).filter(isRecord)
  const asks = new Set(list(run.waiting).filter(isRecord).map(item => text(item.task_id)))
  const states = new Map(
    tasks.map(task => {
      // A skipped task did not need to run: grey like a stop, but its own square.
      const state = /skipped$/.test(text(task.outcome)) ? 'skipped' : nodeState(task.outcome)
      const shown = state === 'running' && hasEnded(run) ? 'stopped' : state

      return [nodeIdOf(task), shown === 'running' && asks.has(text(task.task_id)) ? 'you' : shown]
    })
  )
  const steps = graphOf(run).waves.slice(0, 12)
  const SIGNAL = { failed: 'fail', passed: 'pass', running: 'live', you: 'you' }

  if (!steps.length) {
    return h(CountStrip, { progress: progressOf(run) })
  }

  return steps.length
    ? h(
        'span',
        { 'aria-hidden': 'true', className: 'rk-rc-strip' },
        steps.map((step, i) => h('span', { key: i }, step.slice(0, 8).map(id => h('i', { 'data-state': SIGNAL[states.get(id)] ?? states.get(id) ?? 'pending', key: id }))))
      )
    : null
}

/** A run's tasks as squares by their counts, when only its counts are known (a row of the overview): passed first. */
function CountStrip({ progress: p }) {
  const order = [['pass', p.passed], ['fail', p.failed], ['live', p.running], ['you', p.blocked], ['stopped', p.stopped], ['skipped', p.skipped], ['pending', p.pending + (p.unverified ?? 0)]]
  const squares = order.flatMap(([state, n]) => Array.from({ length: Math.max(0, num(n) ?? 0) }, () => state)).slice(0, 24)

  return squares.length ? h('span', { 'aria-hidden': 'true', className: 'rk-rc-strip' }, h('span', null, squares.map((state, i) => h('i', { 'data-state': state, key: i })))) : null
}

/** One pip a check (§4.6): passed, failed, then what has not run. */
function CheckPips({ gates }) {
  const total = Math.min(24, num(gates?.total) ?? 0)
  const passed = Math.min(total, num(gates?.passed) ?? 0)
  const failed = Math.min(total - passed, num(gates?.failed) ?? 0)

  return total
    ? h(
        'span',
        { 'aria-hidden': 'true', className: 'rk-pips' },
        Array.from({ length: total }, (_, i) => h('i', { 'data-state': i < passed ? 'pass' : i < passed + failed ? 'fail' : undefined, key: i }))
      )
    : null
}

/** The glass's clock (§6.3): 0:42, 4:05; an hour or more, 1H 12M. */
function glassTime(ms) {
  const s = Math.floor(Math.max(0, ms) / 1000)

  return s < 3600 ? clockFace(ms) : `${Math.floor(s / 3600)}H ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}M`
}

/** TIME: ticking while the run goes, its length once it ended. */
function CardTime({ run, size }) {
  const live = isActiveRun(run) && run.state === 'running' && !notStarted(run)
  const startMs = parseTime(run.started_at)
  const now = useTick(live)
  const ms = live && startMs !== null ? now - startMs : num(run.duration_ms)

  return h(Dots, { label: ms === null ? 'time unknown' : live ? `${duration(ms)} so far` : duration(ms), size, tone: live ? 'live' : undefined, value: ms === null ? '-:--' : glassTime(ms) })
}

/** roko's estimate of the time left (P-38), under TIME: "about 5 min left", up to its range. */
function CardEta({ run }) {
  const now = useTick(true)

  // The time left on the glass, a range on two lines; when roko made the estimate, and from what, on hover.
  return etaNote(run, now, 'card-eta', 'rk-rc-note rk-rc-eta')
}

/** The run's four readings on the glass (§4.2): TASKS with the plan's strip, TIME, SPENT, CHECKS. */
function CardGlass({ run, look, size = 'M' }) {
  const p = progressOf(run)
  const writing = run.kind === 'plan_generate'
  const gates = isRecord(run.gates) ? run.gates : null
  const total = num(gates?.total) ?? 0
  const passed = num(gates?.passed) ?? 0
  const failed = num(gates?.failed) ?? 0
  const tone = { fail: 'fail', live: 'live', pass: 'pass', you: 'you' }[look.state]
  const cost = num(run.cost_usd) === null ? null : num(run.cost_usd) + (num(run.carried_usd) ?? 0)
  const cap = num(run.max_usd)
  const sc = isRecord(run.source_checks) ? run.source_checks : null
  const tasks = writing ? num(run.task_count) : null
  const cell = (label, reading, note, testId) => h('div', { className: 'rk-rc-cell', 'data-testid': testId }, h('span', { className: 'rk-rc-label' }, label), reading, note ?? null)

  return h(
    Well,
    { className: 'rk-rc-glass', testId: 'card-glass' },
    writing
      ? cell('tasks', h(Dots, { label: tasks === null ? 'tasks: not written yet' : plural(tasks, 'task'), size, tone, value: tasks === null ? '-' : String(tasks) }), null, 'card-tasks')
      : cell('tasks', h(Dots, { label: progressWords(p), size, tone, value: p.total ? `${p.passed}/${p.total}` : '-/-' }), h(Fragment, null, h(PlanStrip, { run }), tasksNote(run, p) ? h('span', { className: 'rk-rc-note' }, tasksNote(run, p)) : null), 'card-tasks'),
    cell(
      'time',
      h(CardTime, { run, size }),
      notStarted(run)
        ? h('span', { className: 'rk-rc-note', 'data-testid': 'card-starting' }, 'starting…')
        : isActiveRun(run)
          ? num(run.eta_minutes) !== null
            ? h(CardEta, { run })
            : null
          : timeFrom(run)
            ? h('span', { className: 'rk-rc-note' }, timeFrom(run))
            : null,
      'card-time'
    ),
    cell('spent', h(Dots, { label: `spent ${money(cost)}${cap !== null ? ` of ${money(cap)}` : ''}`, size, value: money(cost) }), cap !== null ? h(Fragment, null, h(CapMeter, { cap, cost, run }), h('span', { className: 'rk-rc-note' }, `of ${money(cap)}`)) : null, 'card-spent'),
    writing
      ? cell('checks', h(Dots, { label: sc ? `${num(sc.kept) ?? 0} of ${num(sc.stated) ?? 0} of the spec’s checks kept` : 'checks: written with each task', size, tone: sc && num(sc.kept) < num(sc.stated) ? 'you' : tone, value: sc && num(sc.stated) ? `${num(sc.kept) ?? 0}/${num(sc.stated)}` : '-' }), sc ? h('span', { className: 'rk-rc-note' }, 'from your spec') : null, 'card-checks')
      : run.reading === true
        ? cell('checks', h(Dots, { label: 'checks: reading the run’s history', size, tone: 'dim', value: '-/-' }), h('span', { className: 'rk-rc-note' }, 'reading…'), 'card-checks')
        : cell('checks', h(Dots, { label: total ? `${passed} of ${total} checks passed` : 'no check ran yet', size, tone: failed ? 'fail' : total && passed === total ? 'pass' : total ? 'live' : 'dim', value: total ? `${passed}/${total}` : '-/-' }), h(Fragment, null, h(CheckPips, { gates }), checksNote(gates) ? h('span', { className: 'rk-rc-note' }, checksNote(gates)) : null), 'card-checks')
  )
}

/** Spend against the cap (design system §4.6): live under 80% of it, orange from 80%; all orange once stopped at it. */
function CapMeter({ run, cost, cap }) {
  const stopped = capStopped(run) && !dayStopped(run)
  const ratio = cap > 0 ? (cost ?? 0) / cap : 0

  return h(Meter, { max: cap, segments: 20, testId: 'spend-meter', tone: stopped || ratio >= 0.8 ? 'you' : 'live', value: stopped ? cap : cost ?? 0 })
}

/** When an ended run's clock started, as roko counted it (P-19): "from 11:16". */
function timeFrom(run) {
  const ms = num(run.duration_ms)
  const end = parseTime(run.finished_at)
  // roko's clock ends when the run did: it started that long before, whatever the record's later start says.
  const from = ms === null ? null : end !== null ? end - ms : parseTime(run.started_at)

  return from !== null ? `from ${clock(from).slice(0, 5)}` : ''
}

/** What TASKS says beside its strip, only when it is more than "all passed": failed, stopped, skipped, who it waits on. */
function tasksNote(run, p) {
  const parts = [
    waitsOnYou(run) ? 'waiting on you' : '',
    p.running && !waitsOnYou(run) ? (run.state === 'last_seen' ? `${p.running} was running` : `${p.running} running`) : '',
    p.failed ? `${p.failed} failed` : '',
    p.blocked ? `${p.blocked} blocked` : '',
    p.stopped && hasEnded(run) ? `${p.stopped} stopped` : '',
    p.skipped ? `${p.skipped} skipped` : ''
  ].filter(Boolean)

  return parts.join(' · ')
}

/** What CHECKS says under its pips, only when it adds something: what did not pass, or what passed after a retry. */
function checksNote(gates) {
  const failed = num(gates?.failed) ?? 0
  const retried = num(gates?.retried) ?? 0

  return failed ? `${failed} did not pass` : retried ? `passed · ${retried} retried` : ''
}

/** "T3" as the design system says it: "Task 3"; any other id stays itself. */
function taskName(id) {
  const m = /^T(\d+)$/.exec(text(id))

  return m ? `Task ${m[1]}` : text(id)
}

/** The card's one sentence (§4.8): what is happening, where the work is, the reason, or the question. */
function cardSentence(run, live) {
  if (waitsOnYou(run)) {
    const item = list(run.waiting).find(isRecord)

    return `roko asks: ${clip(text(item?.question) || text(item?.title) || 'a decision', 160)}`
  }

  if (isActiveRun(run)) {
    if (run.kind === 'plan_generate') {
      const writer = isRecord(run.writing) ? text(run.writing.model) : ''

      return clip(text(run.writing?.text), 160) || `roko’s planner${writer ? ` (${clip(writer, 30)})` : ''} is writing the tasks and their checks. Nothing runs until you start the plan.`
    }

    const items = tickerItems(run, live)
    const newest = items[items.length - 1]

    // Nothing from its agent yet (the card's step alone, unless it is a check): what runs, on which model.
    if (!newest || (newest.kind === 'step' && !/^checking/.test(newest.words))) {
      return run.state === 'queued' ? 'Waiting for a free slot.' : notStarted(run) ? 'Starting: roko gets the run ready.' : runningNow(run, live)
    }

    const task = list(run.tasks).find(t => isRecord(t) && text(t.task_id) === newest.task)
    const model = tryModel(task, newest.attempt)
    const tryNo = newest.attempt ?? num(task?.attempts)
    const words = newest.kind === 'text' || newest.kind === 'reasoning' ? `“${mdPlain(clipEnd(newest.words, 90))}”` : clip(newest.words, 90)

    return [taskName(newest.task), words, model ? clip(model, 24) : '', tryNo > 1 ? `try ${tryNo}` : ''].filter(Boolean).join(' · ')
  }

  if (capStopped(run)) {
    return `${capWords(run)}.`
  }

  if (run.state === 'succeeded') {
    if (run.kind === 'plan_generate') {
      const n = num(run.task_count)
      const by = isRecord(run.writing) && text(run.writing.model) ? `, written by ${clip(text(run.writing.model), 30)}` : ''

      return run.validation?.valid === false ? 'roko can’t run this plan yet: open it to see why.' : `${n ? `${plural(n, 'task')}, each with its checks` : 'Each task has its checks'}${by}. Nothing runs until you start it.`
    }

    const files = num(run.receipt?.changes?.files)
    const d = isRecord(run.delivered) ? run.delivered : null

    return d?.merged ? `Merged${files ? `: ${plural(files, 'file')} changed` : ''}.` : d ? `Ready to merge${files ? `: ${plural(files, 'file')} changed` : ''} on its own branch.` : 'Every check passed.'
  }

  if (run.state === 'interrupted') {
    return interruptedReason(run)
  }

  if (run.state === 'cancelled') {
    return cancelWords(run) || 'Stopped.'
  }

  if (run.state === 'unverified') {
    return 'It finished, but no check ran, so it isn’t a pass.'
  }

  return clip(isRecord(run.why) ? text(run.why.summary) : '', 200) || (run.kind === 'plan_generate' ? 'roko’s planner stopped before the plan was written.' : 'A check still failed after the last try.')
}

/** The model a task's try runs on: that try's own, else its latest try's route (P-16), else the task's last known. */
function tryModel(task, attempt) {
  const climb = list(task?.climb).filter(isRecord)
  const own = attempt != null ? climb.find(t => num(t.attempt) === attempt) : null
  const latest = list(task?.attempt_log)
    .filter(isRecord)
    .reduce((best, a) => (!best || (parseTime(a.started_at) ?? 0) >= (parseTime(best.started_at) ?? 0) ? a : best), null)

  return text(own?.model) || text(latest?.route?.model) || text(latest?.model) || text(climb.at(-1)?.model) || text(task?.model)
}

/**
 * What runs now, before its agent has said anything: the task, and the model its try runs on (hermes-pilot P-16: the
 * try running now, never a task's newer route while it waits its turn).
 */
function runningNow(run, live) {
  const running = list(run.tasks).filter(t => isRecord(t) && t.outcome === 'running')
  const route = running.length ? latestRoute(run, live) : null
  const task = route ? running.find(t => text(t.task_id) === text(route.task_id)) : running[0]

  if (!task) {
    return 'Between tasks.'
  }

  const tries = num(task.attempts) ?? 0
  const model = text(route?.model) || tryModel(task, null)
  const on = `${model ? ` on ${clip(model, 24)}` : ''}${tries > 1 ? `, try ${tries}` : ''}`

  return running.length > 1 ? `${running.length} tasks are running; ${taskName(task.task_id)} started last${on}.` : `${taskName(task.task_id)} is running${on}.`
}

/** When, in the card's corner: "started 3m ago" while it runs; "today 14:05", "yesterday 09:12" or "12 Nov" once ended. */
function cardWhen(run) {
  const start = parseTime(run.started_at) ?? parseTime(run.hermes_started_at)

  if (notStarted(run)) {
    return 'starting…'
  }

  if (isActiveRun(run)) {
    return start !== null ? `started ${agoText(start)}` : ''
  }

  const end = start !== null && num(run.duration_ms) !== null ? start + run.duration_ms : start

  if (end === null) {
    return ''
  }

  const day = new Date(end)
  const today = new Date()
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const hm = clock(end).slice(0, 5)

  if (day.toDateString() === today.toDateString()) {
    return `today ${hm}`
  }

  return day.toDateString() === yesterday.toDateString() ? `yesterday ${hm}` : day.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** The card's keys (§4.8): actions only, the orange one the next step; the title opens the run's page. */
function CardKeys({ run }) {
  if (waitsOnYou(run)) {
    return h(Key, { onClick: () => openRoko({ tab: 'waiting' }), size: 's', testId: 'card-answer', tone: 'primary' }, 'answer')
  }

  if (isActiveRun(run)) {
    return run.kind === 'plan_generate' ? null : h(CancelRun, { run, size: 'xs' })
  }

  if (run.kind === 'plan_generate') {
    return text(run.plan_id) && run.state === 'succeeded' ? h(Key, { onClick: () => openRoko({ plan: run.plan_id }), size: 's', testId: 'card-plan' }, 'open the plan') : null
  }

  return h(ChatNext, { run })
}

function RunCardCompact({ runId, fallback, size = 'M', plan = false }) {
  const query = useRun(runId)
  const reachable = useReachable()
  const run = lastKnown(query.data, reachable)
  const live = useLive(runId)
  const [open, setOpen] = useState(false)

  if (query.isLoading) {
    return h('div', { className: 'roko-card', 'data-compact': 'true' }, h(Spinner, { label: 'Loading run…' }))
  }

  if (!run) {
    if (query.error && isRecord(fallback)) {
      return h(RowCard, { compact: true, error: query.error, onRetry: () => void query.refetch(), row: lastKnown(fallback, reachable) })
    }

    return query.error
      ? h(ErrorNote, { compact: true, error: query.error, onRetry: () => void query.refetch() })
      : h(Empty, { icon: 'rocket', title: 'Run not found' })
  }

  const look = cardLook(run)
  const active = isActiveRun(run)
  const why = !active && run.state !== 'succeeded' && isRecord(run.why) ? text(run.why.summary) : ''
  // An ended plan writing that left some of the spec's checks out says so instead (the plan's card has the report).
  const missing = run.kind === 'plan_generate' && !active ? missingChecksLine(run.source_checks) : ''

  return h(
    'div',
    { className: 'roko roko-card roko-run rk-rc', 'data-compact': 'true', 'data-look': look.state, 'data-state': text(run.state), 'data-testid': `run-card-${text(run.run_id)}` },
    h(
      'div',
      { className: 'rk-rc-head' },
      h(CardPill, { look }),
      h('button', { className: 'rk-rc-title roko-run-title', onClick: () => openRoko({ run: run.run_id }), title: 'Open its page in roko', type: 'button' }, text(run.label) || 'a roko run'),
      h(ProjectTag, { run }),
      h('span', { className: 'rk-rc-when' }, cardWhen(run))
    ),
    h(CardGlass, { look, run, size }),
    plan ? h(CardPlan, { live, run }) : null,
    h(
      'div',
      { className: 'rk-rc-line' },
      h('p', { className: 'rk-rc-status', 'data-state': missing ? 'you' : look.state, 'data-testid': missing ? 'source-checks-missing' : 'card-status' }, missing || cardSentence(run, live)),
      h('div', { className: 'rk-rc-keys' }, h(CardKeys, { run }))
    ),
    // What it made, seen at once: its first UI shot (the rest is on the run's page).
    !active && isRecord(run.delivered) ? h(ChatShot, { run }) : null,
    h(
      'details',
      { className: 'rk-rc-fold', 'data-testid': 'card-fold', onToggle: event => setOpen(event.currentTarget.open) },
      h('summary', null, 'details'),
      open
        ? h(
            'div',
            { className: 'rk-rc-more' },
            active && run.kind !== 'plan_generate' ? h(Fragment, null, list(run.ladder).length ? h(LadderStrip, { run }) : h(MiniGraph, { run }), h(Horizon, { live, run })) : null,
            !active && run.kind !== 'plan_generate' && run.reading !== true ? h(Receipt, { compact: true, run }) : null,
            why && why !== cardSentence(run, live) ? h('div', { className: 'roko-cc-why' }, clip(why, 400)) : null,
            run.kind !== 'plan_generate' ? h('div', { className: 'rk-cc-checks' }, checksLine(run)) : null
          )
        : null
    )
  )
}

/** What roko built, in an ended run's chat card (phase 4 prep D): its first shot under 1 MB, which opens large. */
function ChatShot({ run }) {
  const runId = text(run.run_id)
  const query = useMade(runId)
  const shots = list(query.data?.items).filter(item => isRecord(item) && item.kind === 'image')
  const first = shots.find(item => num(item.bytes) <= 1_048_576)
  const shot = useShot(runId, text(first?.path), Boolean(first))
  const [at, setAt] = useState(null)

  return isRecord(shot.data)
    ? h('figure', { className: 'rk-made-shot rk-cc-shot', 'data-testid': 'cc-shot' }, h('button', { 'aria-label': `Open ${text(first.name)} large`, className: 'rk-made-open', onClick: () => setAt(shots.indexOf(first)), type: 'button' }, h('img', { alt: text(first.name), src: dataUrl(shot.data) })), h('figcaption', null, `what roko built · ${text(first.name)}`), h(ShotDialog, { at, onAt: setAt, runId, shots }))
    : null
}

/** An ended chat card's one key: the backend's next step (merge in orange), else review the changes. */
function ChatNext({ run }) {
  const { canAct } = useLimits()
  const d = isRecord(run.delivered) ? run.delivered : null
  const demo = useDemoRun(run, Boolean(d))

  if (isRecord(run.next) && text(run.next.action)) {
    return h(
      Key,
      {
        onClick: () => openRoko({ run: run.run_id, view: ['merge', 'review', 'commit-roko-toml'].includes(text(run.next.action)) ? 'changes' : 'overview' }),
        size: 's',
        testId: 'cc-next',
        title: text(run.next.why) || undefined,
        tone: 'primary'
      },
      text(run.next.label) || NEXT_LABELS[text(run.next.action)] || 'open'
    )
  }

  return d
    ? h(
        Key,
        { onClick: () => openRoko({ run: run.run_id, view: 'changes' }), size: 's', tone: 'primary' },
        d.merged || !canAct || demo || run.state === 'interrupted' || run.merge?.available === false || run.merge?.demo === true ? 'Review changes' : 'Review & merge'
      )
    : null
}

/** Page and chat both call this: compact for chat, mission control otherwise. */
function RunCard({ runId, compact, onExpand, fallback, standalone }) {
  return compact ? h(RunCardCompact, { fallback, runId }) : h(RunView, { fallback, runId, standalone })
}

// --- Waiting items: a decision with two keys, Approve and Reject (POST /decide)

/** "REPORT.md:\n…" summaries name the file they show: split that off as the document's tab. */
function documentOf(summary) {
  const s = text(summary)
  const m = /^([\w./-]{1,80}\.[A-Za-z0-9]{1,8}):\n/.exec(s)

  return m ? { body: s.slice(m[0].length), name: m[1] } : { body: s, name: null }
}

/**
 * How long a waiting item has, as a segmented orange bar that breathes, and what happens when it runs out: a sign-off
 * ends unverified, a held call is not sent (spec v3 §5.4: "so the owner always knows what happens if they walk away").
 */
function PendingCountdown({ deadline, since, effect }) {
  const at = parseTime(deadline)
  const from = parseTime(since)
  const now = useNow(1_000)

  if (at === null) {
    return null
  }

  const left = Math.max(0, Math.round((at - now) / 1000))
  const face = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
  const total = from !== null && at > from ? at - from : null
  const then = effect ? 'then it is not sent' : 'then unverified'

  return h(
    'div',
    { className: 'rk-pend-clock', 'data-testid': 'pending-countdown', 'data-urgent': left <= 60 ? 'true' : undefined, title: `roko stops waiting at ${clock(at)}; ${then.replace(/^then /, 'then ')}` },
    total !== null ? h(Well, { className: 'rk-pend-well' }, h(Meter, { label: `${face} left`, max: 1, segments: 24, tone: left <= 60 ? 'fail' : 'you', value: Math.max(0, (at - now) / total) })) : null,
    left > 0 ? h('span', { className: 'rk-deadline-text' }, `${face} left`) : null,
    h('span', { 'aria-hidden': 'true', className: 'rk-pend-clock-label' }, left > 0 ? `${face} left · ${then}` : `time is up · ${then.replace(/^then /, '')}`)
  )
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
      // roko's outcome when it adds something (an action applied, released); not the verb again.
      const line = outcome && outcome.toLowerCase() !== verb.toLowerCase() ? `${verb} · ${outcome}` : verb

      setResult({ text: line, tone: approve ? 'good' : 'muted' })
      dropAnswered(code, item.run_id)

      try {
        haptic(approve ? 'success' : 'cancel')
      } catch {
        // Haptics are a nicety.
      }

      play(approve ? 'task' : 'check', true)
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
      'data-testid': `pending-${code}`,
      // a approves, r rejects, from anywhere on the card but its note (spec v3 §5.4).
      onKeyDown: event => {
        const target = event.target

        if (!canAct || decided || event.metaKey || event.ctrlKey || event.altKey || (target instanceof HTMLElement && /^(INPUT|TEXTAREA)$/.test(target.tagName))) {
          return
        }

        if (event.key === 'a' || event.key === 'r') {
          event.preventDefault()
          void decide(event.key === 'a')
        }
      },
      tabIndex: canAct && !decided ? 0 : undefined
    },
    h(
      'div',
      { className: 'roko-pending-head' },
      h(CardPill, { look: decided ? (result.tone === 'good' ? { state: 'pass', word: 'approved' } : { state: 'stop', word: 'declined' }) : { blink: 'fast', state: 'you', word: effect ? 'held call' : 'needs you' } }),
      // Its code is for answering in a chat (/roko approve <code>): kept in the title's tooltip, not on the card.
      h('span', { className: 'roko-pending-title', title: `In any chat: /roko approve ${code}` }, text(item.title))
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
    // What checked it: nothing, for a sign-off (the answer decides); a held call goes nowhere until answered.
    h('div', { className: 'rk-pend-checked' }, effect ? 'roko holds the call: nothing is sent until you answer' : 'no check ran on this: your answer decides'),
    h(PendingCountdown, { deadline: item.deadline_at, effect, since }),
    h(
      'div',
      { className: 'roko-pending-meta' },
      since ? h('span', null, h(Codicon, { name: 'watch', size: '0.72rem' }), `waiting ${ago(since)}`) : null,
      // In a list of every run's items, each says its run's project; on its run's card, the card says it.
      showRun ? h(ProjectTag, { run: item }) : null,
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
              Key,
              { className: 'rk-decide-key', disabled: Boolean(busy), kbd: 'R', onClick: () => void decide(false), size: 'l' },
              busy === 'reject' ? h(Spinner, null) : h(Codicon, { name: 'close', size: '0.8rem' }),
              'decline'
            ),
            h(
              Key,
              { className: 'rk-decide-key roko-approve', disabled: Boolean(busy), kbd: 'A', onClick: () => void decide(true), size: 'l', tone: 'primary' },
              busy === 'approve' ? h(Spinner, null) : h(Codicon, { name: 'check', size: '0.8rem' }),
              'approve'
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

// --- Plans: the task graph before it runs, roko's estimate, Run plan…

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

/** "T3", "T1 and T2", "T1, T2 and T3". */
const listWords = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`)

/** A run that started over (P-14): whose progress it set aside, and the command that brings it back. */
function SetAside({ aside }) {
  const short = shortRunId(aside.run_id)
  const passed = list(aside.passed_tasks).map(text).filter(Boolean)

  return h(Tip, { label: `${short} (${text(aside.status) || 'stopped'})${passed.length ? ` had passed ${listWords(passed)}` : ''}; roko resume ${short} brings it back` }, h('span', { className: 'roko-kind', 'data-testid': 'set-aside' }, 'it started over: the earlier run’s progress is set aside'))
}

/** A plan whose last run stopped part way (P-14): continue it, so only what is left runs, or start over. */
function ResumeChoice({ left, choice, onChange }) {
  const short = shortRunId(left.run_id)
  const passed = list(left.passed_tasks).map(text).filter(Boolean)
  const rest = list(left.tasks_left).map(text).filter(Boolean)
  const what = rest.length ? listWords(rest) : 'the tasks left'
  // P-61 (roko bug-4fadf8): every task passed and a crash cut the delivery, so a resume only delivers.
  const deliver = left.delivery_pending === true

  return h(
    'div',
    { className: 'roko-field', 'data-testid': 'resume-choice' },
    h('div', { className: 'roko-muted' }, `Its last run, ${short} (${text(left.status) || 'stopped'}), passed ${passed.length ? listWords(passed) : 'some of its tasks'}${deliver ? ', and its delivery didn’t finish' : rest.length ? `, and ${what} ${rest.length === 1 ? 'is' : 'are'} left` : ''}.`),
    h(Slide, { label: 'Continue or start over', onChange, options: [{ id: 'resume', label: `continue ${short}` }, { id: 'fresh', label: 'start over' }], value: choice }),
    h('div', { className: 'roko-muted', 'data-testid': 'resume-what' }, choice === 'fresh' ? `Every task runs again, and ${short}’s progress is set aside (roko resume ${short} brings it back).` : deliver ? 'No task runs again: only its delivery (the merge, the plan check and the batch).' : `Only ${what} ${rest.length === 1 ? 'runs' : 'run'}; what passed is kept.`)
  )
}

function RunPlan({ plan, size = 'sm', label = 'run plan' }) {
  const limits = useLimits()
  const { blocking, problems: setupProblems } = useSetup()
  const { canAct, left, maxRun } = limits
  const [step, setStep] = useState(null)
  const [refusal, setRefusal] = useState(null)
  // roko refused the run because the plan fails its validator (0.5.0): why, until the plan's own card says it.
  const [rejected, setRejected] = useState(null)
  const ceiling = capCeiling(limits)
  // The composer's starting cap, or the detent that covers roko's estimate for this plan when that is more.
  const estimate = num(plan.estimate?.total_cost_usd)
  const [cap, setCap] = useState(() => {
    const detent = estimate !== null && estimate > 0.5 ? CAP_PRESETS.find(c => c >= estimate && (ceiling === null || c <= ceiling + 1e-9)) : null

    return (detent ?? 0.5).toFixed(2)
  })
  const [resume, setResume] = useState(false)
  // P-14: the run a plan run would continue or set aside, from the plan's sheet (or a refusal that named it).
  const [found, setFound] = useState(null)
  const [choice, setChoice] = useState('resume')
  const stopped = isRecord(found) ? found : isRecord(plan.resumable_run) ? plan.resumable_run : null
  const how = stopped ? (choice === 'fresh' ? { fresh: true } : { resume: true }) : { resume }
  const amount = Number.parseFloat(cap)
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
      Key,
      {
        disabled: Boolean(blocking) || isRecord(plan.validation),
        onClick: () => setStep('form'),
        size: size === 'xs' ? 's' : 'l',
        testId: 'run-plan',
        title: blocking ? blocking.title : isRecord(plan.validation) ? 'roko won’t run this plan yet: see why above' : undefined,
        tone: 'primary'
      },
      label
    ),
    blocking
      ? h('div', { className: 'rk-blocked' }, h(Blocking, { compact: size === 'xs', lead: 'Plans can’t run from Hermes until this is fixed:', problem: blocking }))
      : rejected && !isRecord(plan.validation)
        ? h(PlanValidationNote, { plan, validation: rejected })
        : size === 'xs'
        ? // A plan card in a chat: the page's setup area, which shows a fix's outcome, is not in view.
          h(FixDoneNote, { problems: setupProblems })
        : null,
    refusal
      ? h(
          Dialog,
          { onOpenChange: open => !open && setRefusal(null), open: true },
          h(
            DialogContent,
            { className: 'roko max-w-md' },
            h(DialogHeader, null, h(DialogTitle, null, 'roko did not start the plan'), h(DialogDescription, null, 'It refused the run before spending anything. Fix this, then run the plan again.')),
            h(ProblemCard, { problem: refusal })
          )
        )
      : null,
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
          stopped
            ? h(ResumeChoice, { choice, left: stopped, onChange: setChoice })
            : plan.resumable_run === null
              ? null // P-34: nothing to resume (a sheet without the field, from an older backend, keeps the switch)
              : h(
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
      description: `roko will run “${clip(title, 80)}” (${planId}) and may spend up to $${valid ? amount.toFixed(2) : '?'} on model calls${stopped ? (how.fresh ? `, starting over (${shortRunId(stopped.run_id)}’s progress is set aside)` : `, continuing run ${shortRunId(stopped.run_id)}`) : resume ? ', resuming its last run' : ''}. This spends real money.`,
      onClose: () => setStep(null),
      onConfirm: async () => {
        let reply

        try {
          reply = await post(`/plans/${enc(planId)}/run`, { max_usd: Math.round(amount * 100) / 100, ...how, ...projectBody(), ...(text(plan.title) ? { title: clip(plan.title, 80) } : {}) })
        } catch (error) {
          if (error instanceof RokoError && error.resumable) {
            // Its last run stopped part way since the sheet was read: the form now asks which, as roko does.
            setFound(error.resumable)
            void queryClient.invalidateQueries({ queryKey: KEYS.plan(planId) })

            throw new Error('Its last run stopped part way: cancel, then choose under run plan whether to continue it or start over.')
          }

          if (error instanceof RokoError && error.problem) {
            // A refusal that names its cause: close the confirm, show the problem with its fix.
            setStep(null)
            setRefusal(error.problem)
          }

          if (error instanceof RokoError && error.validation) {
            // roko will not run the plan as it is: close the confirm, say why (its questions, its words), and read the
            // plan again so its card says so too and Run plan… goes off.
            setStep(null)
            setRejected(error.validation)
            void queryClient.invalidateQueries({ queryKey: KEYS.plan(planId) })

            return
          }

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

/**
 * A planned task's checks (P-59): every command its plan names (`verify`), else roko_plans' first four (`checks`), and
 * how many it has (`check_count`), so a cut list says how many more.
 */
function taskChecks(task) {
  const named = list(task.verify).filter(isRecord).map(v => text(v.command)).filter(Boolean)
  const commands = named.length ? named : list(task.checks).map(text).filter(Boolean)

  return { commands, count: Math.max(num(task.check_count) ?? 0, commands.length) }
}

/** "and 2 more" after a cut list of a task's checks, else ''. */
const moreChecks = ({ commands, count }) => (count > commands.length ? `and ${count - commands.length} more` : '')

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
          const checks = taskChecks(task)

          return h(
            'div',
            { className: 'roko-taskchip', key: taskId },
            h('div', { className: 'roko-taskchip-head' }, h('span', { className: 'roko-mono roko-strong' }, clip(taskId, 24)), h('span', { className: 'roko-taskchip-title' }, text(task.title))),
            deps.length ? h('div', { className: 'roko-muted' }, `after ${deps.join(', ')}`) : null,
            checks.count ? h(Tip, { label: clip([...checks.commands, moreChecks(checks)].filter(Boolean).join(' · '), 200) }, h('div', { className: 'roko-muted', 'data-testid': `checks-${taskId}` }, plural(checks.count, 'check'))) : null
          )
        })
      )
    )
  )
}

/** One planned task: what it is for, how roko will check it, what it touches. */
/**
 * What a task must also do that no check proves (0.6.0 `also_required`: a mori import's "Also required, not checked
 * automatically"), in dim ink, as text; nothing when there is none.
 */
function AlsoRequired({ task, testId }) {
  const items = list(task.also_required).map(text).filter(Boolean)

  return items.length
    ? h(
        'div',
        { className: 'rk-also', 'data-testid': testId },
        h('span', { className: 'rk-also-k' }, `also required · not checked automatically${task.also_required_judged_in_review === true ? ' · the review task judges these' : ''}`),
        h('ul', null, items.slice(0, 20).map((item, i) => h('li', { key: i }, clip(item, 600))))
      )
    : null
}

function PlanTaskDetail({ task, onClose }) {
  const all = taskChecks(task)
  const checks = all.commands
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
    list(task.open_questions).filter(isRecord).length
      ? h(
          Fragment,
          null,
          h(SectionLabel, null, 'Open questions'),
          h(
            'ul',
            { className: 'rk-plan-questions', 'data-testid': 'task-open-questions' },
            list(task.open_questions)
              .filter(isRecord)
              .map((q, i) => h('li', { key: i }, clip(q.question, 300), text(q.assumption) ? h('span', { className: 'roko-muted' }, ` · suggested: ${clip(q.assumption, 300)}`) : null))
          )
        )
      : null,
    h(SectionLabel, null, all.count ? `How roko checks it (${all.count})` : 'How roko checks it'),
    checks.length
      ? h('div', { className: 'roko-checklist' }, checks.map((check, i) => h('code', { className: 'roko-checkcmd', key: i }, h('span', { 'aria-hidden': 'true' }, '$ '), check)), moreChecks(all) ? h('div', { className: 'roko-muted', 'data-testid': 'checks-more' }, moreChecks(all)) : null)
      : h('div', { className: 'roko-muted' }, 'No checks of its own: the workspace’s gates apply.'),
    // roko takes the block out of the description: the panel says it here.
    h(AlsoRequired, { task, testId: 'task-also-required' }),
    files.length ? h('div', { className: 'roko-files' }, files.map(file => h('span', { className: 'roko-chip roko-mono', key: file }, clip(file, 60)))) : null
  )
}

/** Inline markdown as text: `code`, **strong**, and [a link](…) as its words; never HTML. */
function mdInline(line, keyBase) {
  const out = []
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]*\))/g
  let at = 0
  let m

  while ((m = re.exec(line))) {
    if (m.index > at) {
      out.push(line.slice(at, m.index))
    }

    const tok = m[0]

    out.push(
      tok.startsWith('`')
        ? h('code', { key: `${keyBase}:${m.index}` }, tok.slice(1, -1))
        : tok.startsWith('**')
          ? h('b', { key: `${keyBase}:${m.index}` }, mdInline(tok.slice(2, -2), `${keyBase}:${m.index}b`))
          : tok.slice(1, tok.indexOf(']'))
    )
    at = m.index + tok.length
  }

  if (at < line.length) {
    out.push(line.slice(at))
  }

  return out
}

/** An agent's words as plain text (for a label): markdown's markers go. */
function mdPlain(words) {
  return text(words).replace(/\*\*|`/g, '')
}

/** An agent's words, with their inline markdown (`code`, **strong**) shown, never as HTML; a marker a clip cut off goes. */
function mdWords(words, keyBase = 'w') {
  return mdInline(text(words), keyBase).map(part => (typeof part === 'string' ? part.replace(/\*\*|`/g, '') : part))
}

/**
 * A plan's own document, read (spec v3 §5.5: a PRD-style plan reads as a document first): headings, paragraphs,
 * lists, code and tables as text, from untrusted markdown, never as HTML. `blocks` caps what shows before "read on".
 */
const LIST_ITEM = /^\s*([-*+]|\d+[.)])\s+/

function MiniMarkdown({ source, blocks: cap = 0 }) {
  const lines = text(source).replace(/\r\n?/g, '\n').split('\n')
  const blocks = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (/^```/.test(line)) {
      const body = []

      i += 1

      while (i < lines.length && !/^```/.test(lines[i])) {
        body.push(lines[i])
        i += 1
      }

      i += 1
      blocks.push(h('pre', { className: 'rk-doc-code', key: blocks.length }, body.join('\n')))
    } else if (/^#{1,6}\s/.test(line)) {
      const level = Math.min(4, /^#+/.exec(line)[0].length)

      blocks.push(h(`h${level + 2}`, { className: `rk-doc-h rk-doc-h${level}`, key: blocks.length }, mdInline(line.replace(/^#+\s*/, ''), blocks.length)))
      i += 1
    } else if (LIST_ITEM.test(line)) {
      // A list, two levels deep: its items, their wrapped lines, and the items nested under each (a blank line
      // between items keeps the list going, as a mori plan's "1. … - … 2. …" does).
      const base = /^\s*/.exec(line)[0].length
      const items = []

      while (i < lines.length) {
        const l = lines[i]

        if (LIST_ITEM.test(l)) {
          items.push({ deep: /^\s*/.exec(l)[0].length > base + 1, n: num(Number.parseInt(/^\s*(\d+)/.exec(l)?.[1] ?? '', 10)), ordered: /^\s*\d/.test(l), text: l.replace(LIST_ITEM, '').replace(/^\[[ xX]\]\s*/, '') })
        } else if (l.trim() && /^\s{2,}/.test(l) && items.length) {
          items[items.length - 1].text += ` ${l.trim()}`
        } else if (!(!l.trim() && items.length && i + 1 < lines.length && (LIST_ITEM.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1])))) {
          break
        }

        i += 1
      }

      const top = []

      items.forEach(item => (item.deep && top.length ? top[top.length - 1].sub.push(item) : top.push({ ...item, sub: [] })))

      const key = blocks.length

      blocks.push(
        h(
          top[0]?.ordered ? 'ol' : 'ul',
          // A list keeps its own numbers: one that starts at 3 says 3.
          { className: 'rk-doc-list', key, start: top[0]?.ordered && top[0].n !== null && top[0].n !== 1 ? top[0].n : undefined },
          top.map((item, j) =>
            h(
              'li',
              { key: j },
              mdInline(item.text, `${key}:${j}`),
              item.sub.length
                ? h(item.sub[0].ordered ? 'ol' : 'ul', { className: 'rk-doc-list rk-doc-sub' }, item.sub.map((sub, k) => h('li', { key: k }, mdInline(sub.text, `${key}:${j}:${k}`))))
                : null
            )
          )
        )
      )
    } else if (/^\s*\|/.test(line)) {
      const rows = []

      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) {
          rows.push(lines[i].trim())
        }

        i += 1
      }

      blocks.push(h('pre', { className: 'rk-doc-table', key: blocks.length }, rows.join('\n')))
    } else if (!line.trim() || /^(---|\*\*\*|___)\s*$/.test(line)) {
      i += 1
    } else {
      const para = []

      while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*([-*+]|\d+[.)])\s+|\s*\|)/.test(lines[i])) {
        para.push(lines[i].replace(/^>\s?/, '').trim())
        i += 1
      }

      blocks.push(h('p', { className: 'rk-doc-p', key: blocks.length }, mdInline(para.join(' '), blocks.length)))
    }
  }

  return h(Fragment, null, cap ? blocks.slice(0, cap) : blocks)
}

/** The plan's own summary (0.6.0 P8 `doc`): its plan.md, the headings and first paragraphs, folded after a screenful. */
function PlanDoc({ plan }) {
  const doc = isRecord(plan.doc) ? plan.doc : null
  const [open, setOpen] = useState(false)
  // The document's own title repeats the plan's: it goes.
  const source = text(doc?.markdown).replace(/^\s*#\s+(.+)\n/, (whole, title) => (title.trim() === text(plan.title).trim() ? '' : whole))

  if (!source.trim()) {
    return null
  }

  const blocks = source.split(/\n{2,}/).length

  return h(
    'div',
    { className: 'rk-plandoc', 'data-open': open ? 'true' : undefined, 'data-testid': 'plan-doc' },
    h(MiniMarkdown, { blocks: open ? 0 : 6, source }),
    blocks > 6 ? h('button', { className: 'roko-link', onClick: () => setOpen(v => !v), type: 'button' }, open ? 'fold the summary' : 'read on') : null,
    open && doc?.truncated ? h('p', { className: 'roko-muted' }, 'The plan’s plan.md goes on; this is its start.') : null
  )
}

/** A plan's check, as a run names it ("verify[0:unit_test]"), its command and what a failure means (0.6.0 P8). */
function CheckChip({ check, quoted = false }) {
  const name = text(check.name)
  const command = text(check.command)

  return h(
    'code',
    {
      className: 'roko-checkcmd',
      title: [
        // Linked by the criterion's own quote, not by the plan's `covers` (a mori import): say so (0.6.0 `linked_by`).
        quoted ? 'the criterion names this check (the plan declares no coverage)' : '',
        command,
        text(check.fail_msg) ? `if it fails: ${text(check.fail_msg)}` : '',
        text(check.expect) === 'fail_on_base' ? 'it fails on the unchanged base' : ''
      ]
        .filter(Boolean)
        .join('\n')
    },
    name ? h('b', null, `${clip(name, 40)} `) : null,
    clip(command, 90)
  )
}

/**
 * The plan's tasks as its document states them (spec v3 §5.5): goal, acceptance criteria with the checks that cover
 * each, role, start rung and section. Only for a plan whose tasks carry acceptance or `also_required`.
 */
function PlanTasks({ plan }) {
  const tasks = list(plan.tasks).filter(isRecord)

  if (!tasks.some(t => list(t.acceptance).length || list(t.also_required).map(text).some(Boolean))) {
    return null
  }

  return h(
    'div',
    { 'aria-label': 'The plan’s tasks', className: 'rk-plantasks', 'data-testid': 'plan-tasks', role: 'list' },
    tasks.map(task => {
      const acceptance = list(task.acceptance)
        .filter(isRecord)
        .map((a, i) => ({ checks: list(a.checks).map(text).filter(Boolean), id: text(a.id) || `AC${i + 1}`, linked: text(a.linked_by), source: list(a.source_checks).map(text).filter(Boolean), text: text(a.text) }))
        .filter(a => a.text)
      const verify = list(task.verify).filter(isRecord).length ? list(task.verify).filter(isRecord) : list(task.checks).map(c => ({ command: text(c), name: '' }))
      const byName = new Map(verify.map(v => [text(v.name), v]))
      const covering = new Set(acceptance.flatMap(a => a.checks))
      const loose = verify.filter(v => !covering.has(text(v.name)))
      const files = list(task.files).map(text).filter(Boolean)
      const deps = list(task.depends_on).map(text).filter(Boolean)
      const nonGoals = list(task.non_goals).map(text).filter(Boolean)

      return h(
        'section',
        { 'aria-label': `${text(task.id)} ${text(task.title)}`, className: 'rk-plantask', 'data-task': text(task.id), key: text(task.id), role: 'listitem' },
        h(
          'div',
          { className: 'rk-plantask-head' },
          h('span', { className: 'rk-plantask-title' }, `${text(task.id)} · ${text(task.title)}`),
          // roko's estimate of the task (R7), else the rung it starts on.
          taskEstimateWords(task)
            ? h('span', { className: 'rk-plantask-est', 'data-testid': `task-estimate-${text(task.id)}` }, taskEstimateWords(task))
            : text(task.start_rung)
              ? h('span', { className: 'rk-rchip', title: `It starts on the ${text(task.start_rung)} rung` }, text(task.start_rung))
              : null,
          task.role ? h('span', { className: 'roko-kind' }, text(task.role)) : null,
          text(task.section) ? h('span', { className: 'roko-muted', title: 'The section of the plan it implements' }, `§ ${clip(task.section, 60)}`) : null,
          deps.length ? h('span', { className: 'roko-muted' }, `needs ${deps.join(', ')}`) : null
        ),
        text(task.goal) ? h('p', { className: 'rk-plantask-goal' }, mdInline(clip(task.goal, 600), 'goal')) : null,
        acceptance.length
          ? h(
              'ul',
              { 'aria-label': `What ${text(task.id)} must do`, className: 'rk-accept' },
              acceptance.map((a, i) =>
                h(
                  'li',
                  { key: i },
                  h('span', { 'aria-hidden': 'true', className: 'rk-accept-box' }),
                  h(
                    'span',
                    null,
                    h('span', { className: 'rk-accept-id' }, a.id),
                    // The checks of the plan's source (its spec) this criterion keeps ("SC2").
                    a.source.length ? h('span', { className: 'rk-accept-src', title: 'from the plan’s source: its success checks' }, a.source.map(id => clip(id, 12)).join(' ')) : null,
                    ' ',
                    mdInline(a.text, i),
                    a.checks.length
                      ? h('span', { className: 'rk-accept-by', 'data-linked': a.linked || undefined }, a.checks.map(name => h(CheckChip, { check: byName.get(name) ?? { name }, key: name, quoted: a.linked === 'quote' })))
                      : null
                  )
                )
              )
            )
          : null,
        h(AlsoRequired, { task, testId: `also-required-${text(task.id)}` }),
        nonGoals.length ? h('p', { className: 'rk-plantask-nongoals roko-muted' }, `not in scope: ${nonGoals.map(n => clip(n, 80)).join(' · ')}`) : null,
        loose.length
          ? h('div', { className: 'rk-plantask-checks' }, h('span', { className: 'roko-muted' }, acceptance.some(a => a.checks.length) ? 'also checked by' : 'proved by'), loose.map((v, i) => h(CheckChip, { check: v, key: i })))
          : !verify.length
            ? h('div', { className: 'rk-plantask-checks roko-muted' }, 'no check of its own: the workspace’s gates apply')
            : null,
        files.length ? h('div', { className: 'roko-files' }, files.slice(0, 8).map(file => h('span', { className: 'roko-chip roko-mono', key: file }, clip(file, 60)))) : null
      )
    }),
    list(plan.plan_checks).filter(isRecord).length
      ? h(
          'div',
          { className: 'rk-plantask rk-planchecks', 'data-testid': 'plan-checks', role: 'listitem' },
          h('span', { className: 'rk-plantask-title' }, 'the whole plan, once its tasks passed'),
          h('div', { className: 'rk-plantask-checks' }, list(plan.plan_checks).filter(isRecord).map((c, i) => h(CheckChip, { check: c, key: i })))
        )
      : null
  )
}

/** What the plan's source asked for that no check here proves, and why (0.6.0 P8 `dropped_checks`). */
function PlanDropped({ plan }) {
  const dropped = list(plan.dropped_checks).filter(d => isRecord(d) && text(d.id))

  if (!dropped.length) {
    return null
  }

  return h(
    'div',
    { className: 'rk-plantask rk-planchecks', 'data-testid': 'plan-dropped' },
    h('span', { className: 'rk-plantask-title' }, 'not kept from its source'),
    h(
      'ul',
      { className: 'rk-dropped' },
      dropped.slice(0, 12).map((d, i) => h('li', { key: i }, h('span', { className: 'rk-accept-id' }, clip(d.id, 12)), ' ', clip(d.reason, 200) || 'no reason given'))
    )
  )
}

/** The plan's review rubric (0.6.0 P8 `rubric`, a mori plan's rubric.md), folded: what reviewers raise. */
function PlanRubric({ plan }) {
  const rubric = isRecord(plan.rubric) ? plan.rubric : null

  if (!text(rubric?.markdown).trim()) {
    return null
  }

  return h(
    'details',
    { className: 'rk-rubric', 'data-testid': 'plan-rubric' },
    h('summary', null, h(ModLabel, { note: text(rubric.path) || 'rubric.md' }, 'review rubric')),
    h('div', { className: 'rk-plandoc' }, h(MiniMarkdown, { source: rubric.markdown }), rubric.truncated ? h('p', { className: 'roko-muted' }, `${text(rubric.path) || 'rubric.md'} goes on; this is its start.`) : null)
  )
}

/**
 * The plan's estimate (roko's own since R7): "likely $0.19 · worst $1.29 · cap $0.25", in orange when the worst case
 * is over the cap, and what it rests on; from a roko before R7, its rough total and where the tasks start.
 */
function PlanEstimate({ plan }) {
  const estimate = isRecord(plan.estimate) ? plan.estimate : null
  const likely = num(estimate?.likely_usd)

  if (likely === null) {
    const starts = list(estimate?.by_rung)
      .filter(r => isRecord(r) && list(r.tasks).length)
      .map(r => `${plural(list(r.tasks).length, 'task')} on ${text(r.rung)}`)

    return [estimateLine(estimate), starts.length ? `starts ${starts.join(', ')}` : ''].filter(Boolean).join(' · ')
  }

  const worst = num(estimate.worst_usd)
  const cap = num(estimate.cap_usd)
  const unpriced = list(estimate.unpriced_tasks).map(text).filter(Boolean)
  const bases = list(plan.tasks).filter(t => isRecord(t) && isRecord(t.estimate)).map(t => text(t.estimate.basis))

  // What it rests on, as roko gives it (F10): similar tasks' tries, other tasks' tries, or its defaults.
  const from = !bases.length
    ? ''
    : bases.every(b => b === 'defaults')
      ? 'from its defaults'
      : bases.includes('defaults')
        ? 'partly from its defaults'
        : bases.includes('any_task')
          ? 'from past tries of other tasks'
          : bases.every(b => b === 'same_role_and_tier' || b === 'same_tier')
            ? 'from similar past tries'
            : 'from past tries'

  return h(
    Fragment,
    null,
    // The worst case leaves unpriced tasks out: it is the priced tasks', never "at most", and the ones it leaves out
    // follow it.
    [`likely ${money(likely)}`, worst !== null ? `worst ${money(worst)}${unpriced.length ? ' for the priced tasks' : ''}` : '', unpriced.length ? `${plural(unpriced.length, 'task')} unpriced` : '', cap !== null ? `cap ${money(cap)}` : ''].filter(Boolean).join(' · '),
    worst !== null && cap !== null && worst > cap + 1e-9 ? h('span', { className: 'rk-est-over' }, ` · the worst case is over the cap: roko stops at ${money(cap)}`) : null,
    from || text(estimate.confidence) === 'low'
      ? h('span', { className: 'roko-muted' }, ` · roko’s estimate${from ? `, ${from}` : ''}${text(estimate.confidence) === 'low' ? ' · low confidence' : ''}`)
      : null
  )
}

/** A task's estimate (R7): "starts on cheap · likely $0.05 · worst $0.32". */
function taskEstimateWords(task) {
  const e = isRecord(task.estimate) ? task.estimate : null

  return e ? [text(task.start_rung) ? `starts on ${text(task.start_rung)}` : '', num(e.likely_usd) !== null ? `likely ${money(e.likely_usd)}` : '', num(e.worst_usd) !== null ? `worst ${money(e.worst_usd)}` : ''].filter(Boolean).join(' · ') : ''
}

/**
 * A written plan in the chat (roko's design system §4.8, for a plan): what roko will do and how it is checked, on
 * the glass; one sentence; the one key that starts it; the steps folded.
 */
function PlanCardCompact({ plan, sc }) {
  const [open, setOpen] = useState(false)
  const missing = missingChecksLine(sc)
  const look = planLook(plan)

  return h(
    'div',
    { className: 'roko roko-card roko-plan rk-rc', 'data-compact': 'true', 'data-look': look.state, 'data-testid': `plan-card-${text(plan.plan_id)}` },
    h(
      'div',
      { className: 'rk-rc-head' },
      h(CardPill, { look }),
      h('button', { className: 'rk-rc-title roko-run-title', onClick: () => openRoko({ plan: plan.plan_id }), title: 'Open the plan in roko', type: 'button' }, text(plan.title) || text(plan.plan_id))
    ),
    h(PlanGlass, { plan, sc }),
    h(
      'div',
      { className: 'rk-rc-line' },
      h('p', { className: 'rk-rc-status', 'data-state': isRecord(plan.validation) || missing ? 'you' : undefined, 'data-testid': missing ? 'plan-checks-missing' : 'plan-status' }, planSentence(plan, sc)),
      h('div', { className: 'rk-rc-keys' }, h(RunPlan, { label: 'run plan', plan, size: 'xs' }))
    ),
    h(
      'details',
      { className: 'rk-rc-fold', 'data-testid': 'card-fold', onToggle: event => setOpen(event.currentTarget.open) },
      h('summary', null, 'details'),
      open ? h('div', { className: 'rk-rc-more' }, h(SourceChecks, { compact: true, sc }), h(Waves, { plan }), h(PlanValidationNote, { plan })) : null
    )
  )
}

/** A plan's state as its pill says it: ready to run, or that roko can't run it yet (design system §6.2). */
function planLook(plan) {
  return isRecord(plan.validation) ? { state: 'you', word: 'cannot run yet' } : { state: 'wait', word: 'ready to run' }
}

/** The plan's one sentence: why it can't run, what its spec's checks lack, or that nothing runs until the person starts it. */
function planSentence(plan, sc) {
  const estimate = isRecord(plan.estimate) ? plan.estimate : null
  // roko's likely cost, or an older backend's one total.
  const likely = num(estimate?.likely_usd) ?? num(estimate?.total_cost_usd)

  return isRecord(plan.validation)
    ? 'roko won’t run this plan yet: its details say why.'
    : missingChecksLine(sc) || `Each task has its checks. Nothing runs until you start it${likely !== null ? `; roko estimates ${money(likely)}${text(estimate.confidence) === 'low' ? ', with low confidence' : ''}` : ''}.`
}

/** A plan's readings on the glass (design system §4.2): TASKS with its steps as a strip, STEPS, CHECKS, ESTIMATE. */
function PlanGlass({ plan, sc, size = 'M', ids = 'plan' }) {
  const tasks = list(plan.tasks).filter(isRecord)
  const taskCount = num(plan.task_count) ?? tasks.length
  const waves = list(plan.waves).map(wave => list(wave).map(text).filter(Boolean)).filter(wave => wave.length)
  const checks = tasks.reduce((n, task) => n + taskChecks(task).count, 0)
  const estimate = isRecord(plan.estimate) ? plan.estimate : null
  const likely = num(estimate?.likely_usd) ?? num(estimate?.total_cost_usd)
  const kept = sc ? num(sc.kept) : null
  const stated = sc ? num(sc.stated) ?? num(sc.total) : null
  const n = atOnce(waves, plan.max_parallel)
  const cell = (label, reading, note, testId) => h('div', { className: 'rk-rc-cell', 'data-testid': testId }, h('span', { className: 'rk-rc-label' }, label), reading, note ? h('span', { className: 'rk-rc-note' }, note) : null)

  return h(
    Well,
    { className: 'rk-rc-glass', testId: `${ids}-glass` },
    cell('tasks', h(Dots, { label: plural(taskCount, 'task'), size, value: String(taskCount) }), waves.length ? h('span', { 'aria-hidden': 'true', className: 'rk-rc-strip' }, waves.slice(0, 12).map((wave, i) => h('span', { key: i }, wave.slice(0, 8).map(id => h('i', { key: id }))))) : null, `${ids}-tasks`),
    cell('steps', h(Dots, { label: plural(waves.length, 'step'), size, value: waves.length ? String(waves.length) : '-' }), waves.length ? (n > 1 ? `up to ${n} at once` : 'one at a time') : null, `${ids}-steps`),
    kept !== null && stated
      ? cell('checks', h(Dots, { label: `${kept} of ${stated} of your spec’s checks kept`, size, tone: kept < stated ? 'you' : 'pass', value: `${kept}/${stated}` }), 'from your spec', `${ids}-checks`)
      : cell('checks', h(Dots, { label: plural(checks, 'check'), size, value: checks ? String(checks) : '-' }), checks ? 'in its tasks' : null, `${ids}-checks`),
    cell('estimate', h(Dots, { label: likely !== null ? `roko estimates ${money(likely)}` : 'no estimate yet', size, value: likely !== null ? money(likely) : '-' }), likely !== null && num(estimate.worst_usd) !== null ? `worst ${money(estimate.worst_usd)}` : null, `${ids}-estimate`)
  )
}

function PlanDetail({ planId, compact, sourceChecks }) {
  // How the plan kept the checks its spec states (0.6.0): the plan writing that shows this sheet says it; else the
  // newest plan writing of this plan in the run log does (its card), when there is one.
  const overview = useOverview()
  const writer = sourceChecks === undefined ? list(overview.data?.runs).find(r => isRecord(r) && r.kind === 'plan_generate' && text(r.plan_id) === text(planId)) : null
  const writing = useRun(writer ? text(writer.run_id) : null, Boolean(writer))
  const busy = Boolean(writer) && isActiveRun(writing.data ?? writer)
  const query = usePlan(planId, busy)
  const plan = query.data
  const [selected, setSelected] = useState(null)
  const sc = sourceChecks !== undefined ? sourceChecks : isRecord(writing.data?.source_checks) ? writing.data.source_checks : null

  if (query.isLoading) {
    return h('div', { className: 'roko-card' }, h(Spinner, { label: 'Loading plan…' }))
  }

  if (!plan) {
    // P-45: a plan its writing has not written yet (or never will): the writing's card, never "not found".
    return writer
      ? h('div', { className: 'roko-stack', 'data-testid': 'plan-writing' }, busy ? h('div', { className: 'roko-muted' }, 'roko is still writing this plan: it shows here once written') : null, h(RunCardCompact, { runId: text(writer.run_id) }))
      : query.error
        ? h(ErrorNote, { compact, error: query.error, onRetry: () => void query.refetch() })
        : h(Empty, { icon: 'list-tree', title: 'Plan not found' })
  }

  if (compact) {
    return h(PlanCardCompact, { plan, sc })
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
          checks: taskChecks(task).count,
          deps: deps.join(', '),
          gates: [],
          id: text(task.id),
          // Questions roko's planner left open on the task (0.5.0): roko runs the plan only once they are answered.
          questions: list(task.open_questions).filter(isRecord).length,
          rung: text(task.start_rung),
          climbed: false,
          outcome: 'pending',
          state: 'pending',
          taskId: text(task.id),
          title: text(task.title)
        }
      ]
    })
  )
  const selectedTask = tasks.find(task => text(task.id) === selected)
  const look = planLook(plan)
  const notes = list(plan.validator_notes).length || list(plan.repairs).length

  // A plan's page (design system §5.1): its head as a run's (pill, title, the glass, one sentence, run plan), what was
  // asked, how its tasks are checked, the plan drawn; the rest folded.
  return h(
    'div',
    { className: 'roko roko-plan rk-runpage', 'data-testid': `plan-card-${text(plan.plan_id)}` },
    h(
      'header',
      { className: 'rk-runhead', 'data-look': look.state },
      h(
        'div',
        { className: 'rk-rc-head' },
        h(CardPill, { look }),
        h('h2', { className: 'rk-runhead-title' }, text(plan.title) || 'a plan'),
        isRecord(plan.imported_from) ? h('span', { className: 'roko-kind', 'data-testid': 'plan-imported', title: `roko plan import --${text(plan.imported_from.kind)} wrote it from ${text(plan.imported_from.plan)}` }, `from ${clip(plan.imported_from.kind, 12)}`) : null
      ),
      h(PlanGlass, { ids: 'planhead', plan, sc, size: 'L' }),
      h(
        'div',
        { className: 'rk-rc-line' },
        h('p', { className: 'rk-rc-status', 'data-state': isRecord(plan.validation) || missingChecksLine(sc) ? 'you' : undefined, 'data-testid': 'planhead-status' }, planSentence(plan, sc)),
        h('div', { className: 'rk-rc-keys' }, h(RunPlan, { plan, size: 'sm' }))
      )
    ),
    h(PlanValidationNote, { cards: true, plan }),
    h(PlanAsked, { asked: plan.asked }),
    h(SourceChecks, { sc }),
    h(TaskChecks, { plan }),
    h(PlanDropped, { plan }),
    h(
      'section',
      { className: 'rk-runsec rk-panel', 'data-testid': 'plan-panel' },
      h('h3', { className: 'rk-panel-h' }, 'The plan', h('span', null, [plural(taskCount, 'task'), waves.length ? plural(waves.length, 'step') : '', waves.length ? parallelWords(waves, plan.max_parallel) : ''].filter(Boolean).join(' · '))),
      h(RunGraph, { edges, nodes, onSelect: id => setSelected(prev => (prev === id ? null : id)), planOnly: true, selected, testId: 'plan-graph', waves }),
      selectedTask ? h(PlanTaskDetail, { onClose: () => setSelected(null), task: selectedTask }) : h('div', { className: 'roko-graph-hint' }, h(Codicon, { name: 'info', size: '0.75rem' }), 'Pick a task to see how roko will check it.')
    ),
    h(
      'div',
      { className: 'rk-folds' },
      text(plan.doc?.markdown).trim() ? h(Fold, { name: 'doc', title: 'the plan as roko wrote it' }, h(PlanDoc, { plan })) : null,
      tasks.some(t => list(t.acceptance).length || list(t.also_required).map(text).some(Boolean)) ? h(Fold, { name: 'tasks', title: 'each task in full' }, h(PlanTasks, { plan })) : null,
      notes ? h(Fold, { name: 'notes', title: 'what roko fixed and noted as it wrote the plan' }, h(PlanRepairs, { repairs: plan.repairs }), h(ValidatorNotes, { notes: plan.validator_notes })) : null,
      h(PlanRubric, { plan }),
      h(
        Fold,
        { name: 'about', title: 'about this plan' },
        h(
          'div',
          { className: 'roko-run-foot' },
          h('span', { className: 'roko-muted roko-mono' }, `plan ${text(plan.plan_id)}`),
          h(CopyId, { label: 'Copy plan id', value: text(plan.plan_id) }),
          waves.length ? h('span', { className: 'roko-muted', 'data-testid': 'plan-parallel' }, parallelWords(waves, plan.max_parallel)) : null,
          h('span', { className: 'roko-muted roko-estimate', 'data-testid': 'plan-estimate' }, h(PlanEstimate, { plan }))
        )
      )
    )
  )
}

/** A command cut in its middle, not at its end: an && chain's runner is its last command (P-35). */
function clipMiddle(v, max) {
  const s = clip(v, 2000)

  return s.length > max ? `${s.slice(0, 44)}… ${s.slice(46 - max)}` : s
}

/**
 * Each task's check at a glance, above the plan's document (P-28): a line a task with the first command that proves
 * it ("+1" for more, all of them in its tip), so a check that can't fit the project (`cargo` in a C++ one) shows at once.
 */
function TaskChecks({ plan }) {
  const rows = list(plan.tasks)
    .filter(isRecord)
    .map(task => ({ ...taskChecks(task), id: text(task.id) }))

  if (!rows.some(row => row.commands.length)) {
    return null
  }

  return h(
    'div',
    { className: 'rk-taskchecks', 'data-testid': 'task-checks' },
    h(ModLabel, null, 'how each task is checked'),
    h(
      'div',
      { 'aria-label': 'How each task is checked', role: 'list' },
      rows.map(row =>
        h(
          'div',
          { className: 'rk-taskcheck', key: row.id, role: 'listitem', title: [...row.commands, moreChecks(row)].filter(Boolean).join('\n') || undefined },
          h('b', null, clip(row.id, 14)),
          row.commands.length ? h('code', null, h('span', { 'aria-hidden': 'true' }, '$ '), clipMiddle(row.commands[0], 110)) : h('span', { className: 'roko-muted' }, 'no checks of its own'),
          row.count > 1 ? h('span', { className: 'rk-taskcheck-more' }, `+${row.count - 1}`) : null
        )
      )
    )
  )
}

/**
 * Why roko will not run this plan yet (`validation`, 0.5.0): roko's words, and the questions its planner left open
 * on a task with the answer it suggested. They are answered in the plan's tasks.toml; `roko plan validate` says what
 * is left.
 */
function PlanValidationNote({ plan, validation = null, cards = false }) {
  const v = isRecord(validation) ? validation : isRecord(plan.validation) ? plan.validation : null

  if (!v) {
    return null
  }

  return h(
    'div',
    { className: 'roko-why', 'data-testid': 'plan-validation', 'data-tone': 'warn', role: 'note' },
    h(Codicon, { className: 'roko-why-icon', name: 'warning', size: '0.95rem' }),
    h(
      'div',
      { className: 'roko-why-body' },
      h('div', { className: 'roko-why-title' }, 'roko won’t run this plan yet'),
      h(ValidationItems, { cards, validation: v }),
      h(ValidationStep, { group: text(plan.group), planId: text(plan.plan_id) || text(plan.id), validation: v })
    )
  )
}

/**
 * What roko's validator found, one line each: roko's own words for each error (the open-questions rule is said by
 * the questions themselves), then each open question with the answer the planner suggested.
 */
function ValidationItems({ validation, cards = false }) {
  const questions = list(validation.open_questions).filter(isRecord)
  const errors = list(validation.errors).filter(e => isRecord(e) && text(e.message) && !(questions.length && text(e.rule) === 'PLAN_045'))

  if (!questions.length && !errors.length) {
    return h('p', { className: 'roko-why-text' }, clip(validation.summary, 600))
  }

  // On the plan's sheet each open question is a card that asks (spec v3 §5.5, Nooscopy): the question large, the
  // planner's suggestion, and what happens while it stays open.
  if (cards && questions.length) {
    return h(
      'div',
      { className: 'rk-oq-list', 'data-testid': 'validation-items' },
      errors.length ? h('ul', { className: 'rk-plan-questions' }, errors.slice(0, 6).map((e, i) => h('li', { 'data-kind': 'error', key: `e${i}` }, validationError(e)))) : null,
      questions.slice(0, 8).map((q, i) =>
        h(
          'div',
          { className: 'rk-oq', 'data-testid': 'open-question-card', key: `q${i}` },
          h(Stamp, { tone: 'you' }, 'open question'),
          h('p', { className: 'rk-oq-q' }, text(q.task_id) ? h('b', null, `${clip(q.task_id, 16)} `) : null, clip(q.question, 300)),
          text(q.assumption) ? h('p', { className: 'rk-oq-s' }, ' · suggested: ', h('span', null, clip(q.assumption, 300))) : null,
          h('p', { className: 'rk-oq-then' }, 'unanswered, roko won’t run the plan')
        )
      )
    )
  }

  return h(
    'ul',
    { className: 'rk-plan-questions', 'data-testid': 'validation-items' },
    errors.slice(0, 6).map((e, i) => h('li', { 'data-kind': 'error', key: `e${i}` }, validationError(e))),
    questions.slice(0, 8).map((q, i) =>
      h(
        'li',
        { 'data-kind': 'question', key: `q${i}` },
        text(q.task_id) ? h('b', null, `${clip(q.task_id, 16)} `) : null,
        clip(q.question, 300),
        text(q.assumption) ? h('span', { className: 'roko-muted' }, ` · suggested: ${clip(q.assumption, 300)}`) : null
      )
    )
  )
}

/** One of roko's validator errors: its task, roko's words, its rule. */
function validationError(e) {
  return [
    text(e.task_id) ? h('b', { key: 't' }, `${clip(e.task_id, 16)} `) : null,
    clip(e.message, 300),
    text(e.rule) ? h('span', { className: 'roko-muted', key: 'r' }, ` · ${clip(e.rule, 24)}`) : null
  ]
}

/** The person's step: answer the questions in tasks.toml; `roko plan validate <dir>` says what is left. */
function ValidationStep({ validation, planId, group }) {
  // roko's plans live in plans/<group>/<id> (the listing's `group` is that folder).
  const dir = planId ? `plans/${group ? `${group}/` : ''}${planId}` : ''

  return h(
    'p',
    { className: 'roko-why-text roko-muted' },
    list(validation.open_questions).some(isRecord) ? 'Answer each in the plan’s tasks.toml, then delete it from open_questions. ' : '',
    dir ? h('code', null, `roko plan validate ${dir}`) : 'roko plan validate',
    ' says what is left.'
  )
}

// --- The five loops: the dial, each ring's latest events and state, the feed

const pct = v => (num(v) === null ? '—' : `${Math.round(v * 100)}%`)

/** roko's learning loops by name (roko-learn's loop_audit/loops.toml); the same names as the dashboard. */
const LOOP_NAMES = {
  'L-bid': 'attention bidders',
  'L-dream': 'dream consolidation',
  'L-err': 'error patterns',
  'L-gate-thr': 'check thresholds',
  'L-hdc': 'episode recall',
  'L-holdout': 'holdout experiment',
  'L-know': 'lessons in prompts',
  'L-linucb': 'model routing (LinUCB stage)',
  'L-M1': 'M1 controller',
  'L-M3': 'M3 self-model',
  'L-M4': 'M4 audit feedback',
  'L-model-exp': 'model experiments',
  'L-placebo': 'placebo (checks the audit)',
  'L-play': 'playbooks in prompts',
  'L-prompt-exp': 'prompt experiments',
  'L-rag11': 'retrieval experiment',
  'L-retry-budget': 'retry budgets',
  'L-route': 'model routing',
  'L-routing-log': 'routing decision log',
  'L-sec': 'prompt sections'
}

// roko-learn's reason codes (loop_audit/spec.rs ReasonCode), in words.
const LOOP_REASONS = {
  'dormant:cut': 'what it reads is empty',
  'dormant:degenerate': 'it has nothing to vary',
  'dormant:label_only': 'it only labels decisions',
  'dormant:mask': 'something else overrides what it picks',
  'dormant:no_learning': 'it learns nothing',
  'dormant:no_opportunity': 'no chance to act yet',
  'dormant:stale': 'it reads an old state',
  'dormant:unlogged': 'its effect is not recorded',
  'dormant:write_only': 'what it learns is never read',
  harm: 'it made things worse',
  inert: 'it changes nothing',
  null: 'no measurable benefit'
}

/**
 * One learning loop's audit, worded: its state ("on probation", "proven: its learning is in use", …), the holdout
 * (`h`: decisions kept on roko's default, to measure what the loop adds), its reach (`eps`: decisions its learning
 * changed) and how many decisions it saw.
 */
function loopHealthWords(loop) {
  const st = text(loop.state)
  const reason = text(loop.reason)
  const why = LOOP_REASONS[reason] ?? reason.replace(/^dormant:/, '').replace(/_/g, ' ')
  const state =
    st === 'probation'
      ? 'on probation'
      : st === 'live'
        ? 'proven: its learning is in use'
        : st === 'flagged'
          ? `flagged${why ? `: ${why}` : ''}`
          : st === 'demoted'
            ? `demoted: roko uses its default${why ? ` (${why})` : ''}`
            : st.replace(/_/g, ' ') || 'not checked yet'

  return [state, num(loop.h) !== null ? `holdout ${pct(loop.h)}` : null, num(loop.eps) !== null ? `reach ${pct(loop.eps)}` : null, num(loop.n_opp) !== null ? plural(num(loop.n_opp), 'decision') : null]
    .filter(Boolean)
    .join(' · ')
}

// --- Learning (spec v3 §5.6, mockup 03): is roko getting better? The overview's hero, where work passed on the
// ladder, the five loops as an orrery, the lessons that paid off, and the homeostat

/** The backend's learning view (0.6.0 `GET /learning`); an older backend has no such route. */
function useLearning(scope = 'hermes') {
  const project = useValue($project)

  // An older backend has no /learning: once it said so, a part mounting later does not ask again (and flip the page).
  return useQuery({ queryFn: () => call(forProject(`/learning?scope=${enc(scope)}`, project)), queryKey: projectKey([...KEYS.learning, scope], project), retry: false, retryOnMount: false, staleTime: 60_000 })
}

/**
 * A trend as braille dots (the kit's spark): a column a value, its height between the series' least and most,
 * older columns dimmer, the newest with a glowing head; `grid` lights the unlit dots faintly.
 */
function Spark({ values, width = 110, height = 30, tone = 'ink', grid = false, label }) {
  const vals = values.filter(v => num(v) !== null)

  if (vals.length < 2) {
    return null
  }

  const pitch = 3.2
  const cols = Math.max(2, Math.floor(width / pitch))
  const rows = Math.max(2, Math.floor(height / pitch))
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const top = v => rows - 1 - Math.round(max === min ? rows / 2 : ((v - min) / (max - min)) * (rows - 1))
  const at = i => vals[Math.min(vals.length - 1, Math.round((i / (cols - 1)) * (vals.length - 1)))]
  const dots = []

  for (let c = 0; c < cols; c += 1) {
    const row = top(at(c))
    const cx = (c * pitch + pitch / 2).toFixed(1)

    for (let r = 0; r < rows; r += 1) {
      if (r === row) {
        dots.push(h('circle', { cx, cy: (r * pitch + pitch / 2).toFixed(1), key: `${c}:${r}`, opacity: (0.28 + 0.72 * (c / (cols - 1))).toFixed(2), r: 1.05 }))
      } else if (grid) {
        dots.push(h('circle', { className: 'rk-spark-grid', cx, cy: (r * pitch + pitch / 2).toFixed(1), key: `${c}:${r}`, r: 0.55 }))
      }
    }
  }

  return h(
    'svg',
    { 'aria-hidden': label ? undefined : 'true', 'aria-label': label, className: 'rk-spark2', 'data-tone': tone, height, role: label ? 'img' : undefined, viewBox: `0 0 ${width} ${height}`, width },
    dots,
    h('circle', { className: 'rk-spark2-head', cx: ((cols - 1) * pitch + pitch / 2).toFixed(1), cy: (top(vals[vals.length - 1]) * pitch + pitch / 2).toFixed(1), r: 2 })
  )
}

/** A value per run: cost per passed task, the first-try rate, climbs. Null where a run cannot say. */
const runRate = {
  climbs: r => num(r.climbs),
  first: r => (num(r.first_try) !== null && num(r.tasks) ? num(r.first_try) / num(r.tasks) : null),
  usd: r => num(r.per_pass) ?? (num(r.cost_usd) !== null && num(r.passed) ? num(r.cost_usd) / num(r.passed) : null)
}

/** The mean of the numbers among `values`, or null. */
function mean(values) {
  const vals = values.filter(v => num(v) !== null)

  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
}

/** The mean of a series' first or last third (at least 2 runs); null with too few runs to compare (under 4). */
function third(series, pick, which) {
  const n = Math.max(2, Math.ceil(series.length / 3))

  return series.length >= 4 ? mean((which === 'first' ? series.slice(0, n) : series.slice(-n)).map(pick)) : null
}

/**
 * The learning view worked out from what this page has (an older backend has no `/learning`): each ended run's
 * spend, passes and, once the backend sends them (0.6.0 rows' `rungs`), where they passed. First tries and climbs
 * need the backend's view.
 */
function learningFromRows(rows) {
  const series = rows
    .filter(r => isRecord(r) && TERMINAL_STATES.has(text(r.state)) && r.state !== 'missing')
    .slice(0, 30)
    .reverse()
    .map(r => {
      const progress = isRecord(r.progress) ? r.progress : {}
      const rungs = list(r.rungs).filter(isRecord)

      return {
        by_rung: rungs.length ? Object.fromEntries(rungs.map(x => [text(x.rung), num(x.passed) ?? 0])) : null,
        climbs: null,
        cost_usd: num(r.cost_usd),
        first_try: null,
        label: text(r.label),
        passed: num(progress.passed),
        run_id: text(r.run_id),
        started_at: r.started_at,
        state: text(r.state),
        tasks: num(progress.total)
      }
    })
  const first = parseTime(series[0]?.started_at)

  return {
    derived: true,
    homeostat: null,
    kpis: {},
    lessons_paid: [],
    series,
    window: { days: first === null ? null : Math.max(1, Math.ceil((Date.now() - first) / 86_400_000)), runs: series.length }
  }
}

/** One of M1's essential variables as the gauges draw it: pass_rate's bound is a floor, the others' a ceiling. */
function essentialOf(v) {
  const name = text(v.ev)
  const floor = name === 'pass_rate'

  return { bound: num(v.bound) === null ? {} : floor ? { min: num(v.bound) } : { max: num(v.bound) }, inner: num(v.inner) === null ? null : floor ? [num(v.inner), 1] : [0, num(v.inner)], name, state: text(v.state) === 'breached' ? 'out' : 'ok', value: num(v.value) }
}

/**
 * The backend's learning view (0.6.0 `GET /learning`) as the overview draws it: each run's numbers and passes per
 * rung, the hero's numbers with their trends, the lessons that paid off, the homeostat. Only what the backend says.
 */
function readLearning(raw) {
  const wp = isRecord(raw.where_passed) ? raw.where_passed : null
  const passedBy = new Map(list(wp?.runs).filter(isRecord).map(r => [text(r.run_id), isRecord(r.passed) ? r.passed : null]))
  const series = list(raw.runs)
    .filter(isRecord)
    .map(r => {
      const rungs = list(r.rungs).filter(isRecord)

      return {
        by_rung: passedBy.get(text(r.run_id)) ?? (rungs.length ? Object.fromEntries(rungs.map(x => [text(x.rung), num(x.passed) ?? 0])) : null),
        climbs: num(r.climbs),
        cost_usd: num(r.cost_usd),
        first_try: num(r.first_try),
        label: text(r.label),
        passed: num(r.passed),
        per_pass: num(r.cost_per_pass),
        per_pass_by: text(r.cost_per_pass_by),
        run_id: text(r.run_id),
        started_at: r.finished_at,
        state: text(r.state),
        tasks: num(r.tasks)
      }
    })
  const kpi = key => {
    const k = isRecord(raw.kpis?.[key]) ? raw.kpis[key] : {}

    return { trend: list(k.series).map(num), value: num(k.value), was: num(k.first) }
  }
  // "What drove it" only from what the runs show (plugin-review Q3): first tries with a lesson in the prompt against
  // those without, both n's always, the difference whichever way it points once each side has 5 tasks (else the
  // backend's note), and how the two sides were drawn: roko's control arm (randomised) or observational.
  const lft = isRecord(raw.lessons_first_try) ? raw.lessons_first_try : null
  const withL = isRecord(lft?.with) ? lft.with : null
  const without = isRecord(lft?.without) ? lft.without : null
  const diff = lft?.comparable === true ? num(lft.difference) : null
  const points = diff === null ? '' : `${diff >= 0 ? '+' : '−'}${Math.abs(Math.round(diff * 100))} points`
  const design = text(lft?.design) === 'control_arm' ? 'roko’s control arm (randomised)' : 'observational'
  const note = clip(lft?.note, 160)
  const firstDriver =
    withL && without && (num(withL.of) || num(without.of))
      ? [
          `with a lesson ${num(withL.passed) ?? 0}/${num(withL.of) ?? 0} passed first try, without ${num(without.passed) ?? 0}/${num(without.of) ?? 0}`,
          points,
          // The backend's note as given ("randomised: …", "observational: …", "too few tasks to compare yet …"); the
          // design said too when the note does not say it.
          note,
          /^(randomised|observational)\b/i.test(note) ? '' : design
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
  const homeostat = isRecord(raw.homeostat) ? raw.homeostat : null
  const controller = isRecord(homeostat?.controller) ? homeostat.controller : null
  const first = parseTime(series[0]?.started_at)
  const cov = isRecord(raw.coverage) ? raw.coverage : null
  const rec = isRecord(raw.recorded_tasks) ? raw.recorded_tasks : null

  return {
    // What the numbers rest on (0.6.0: the workspace scope reads roko's run records; prompts and lessons are known
    // only for the runs Hermes started), and roko's own tally of every task it recorded.
    coverage: cov ? { found: num(cov.found), note: text(cov.note), runs: num(cov.runs) ?? series.length, source: text(cov.source) } : null,
    recorded: rec && num(rec.tasks) ? { costPerTask: num(rec.cost_per_task_usd), tasks: num(rec.tasks), typicalMs: num(rec.typical_task_ms) } : null,
    scopeLabel: text(raw.scope_label),
    homeostat: homeostat
      ? {
          controller: controller ? { change: text(controller.change), phase: text(controller.phase) } : null,
          variables: list(homeostat.variables).filter(isRecord).map(essentialOf)
        }
      : null,
    kpis: {
      climbs_per_run: kpi('climbs_per_run'),
      first_try_rate: { ...kpi('first_try_rate'), driver: firstDriver },
      usd_per_pass: { ...kpi('cost_per_pass'), source: series.length && series.slice(-3).every(r => r.per_pass_by === 'roko') ? 'roko' : '' }
    },
    lessons_paid: list(raw.lessons)
      .filter(isRecord)
      .map(l => ({
        confidence: l.confidence,
        entry_id: text(l.id),
        kept_at: isRecord(l.kept_by) ? l.kept_by.at : null,
        kept_by: isRecord(l.kept_by) ? l.kept_by : null,
        text: text(l.text) || text(l.id),
        uses: list(l.uses).filter(isRecord).map(u => ({ outcome: u.first_try ? 'first_try' : u.climbed ? 'climbed' : u.passed ? 'passed' : 'failed' }))
      })),
    ladder: list(wp?.rungs).filter(isRecord),
    series,
    share: isRecord(wp?.cheapest_share) ? { from: num(wp.cheapest_share.first), to: num(wp.cheapest_share.last) } : null,
    window: { days: first === null ? null : Math.max(1, Math.ceil((Date.now() - first) / 86_400_000)), runs: series.length }
  }
}

/** One KPI: its value now, what the first runs showed, its trend per run, and the one line on what drove it. */
function kpiOf(data, key, pick) {
  const given = isRecord(data.kpis?.[key]) ? data.kpis[key] : {}
  const series = list(data.series).filter(isRecord)
  const trend = list(given.trend).length ? list(given.trend) : series.map(pick)

  return {
    driver: text(given.driver),
    source: text(given.source),
    trend,
    value: num(given.value) ?? third(series, pick, 'last') ?? mean(series.map(pick)),
    was: num(given.was) ?? third(series, pick, 'first')
  }
}

/** "↓ 38% · was $0.050 on your first runs": the change against the first runs, in the channel of better or worse. */
function kpiDelta(kpi, lowerIsBetter, show) {
  if (kpi.value === null || kpi.was === null || kpi.was === 0) {
    return null
  }

  const change = (kpi.value - kpi.was) / Math.abs(kpi.was)
  const better = lowerIsBetter ? change < -0.02 : change > 0.02
  const worse = lowerIsBetter ? change > 0.02 : change < -0.02

  return { arrow: change < 0 ? '↓' : '↑', better, change, tone: better ? 'pass' : worse ? 'you' : 'dim', was: show(kpi.was) }
}

/** A loop event's glyph in the learning log: ◇ a lesson, ▮ a threshold, ◆ the rest. */
const logGlyph = e => (e.kind === 'knowledge' ? '◇' : e.kind === 'thresholds' ? '▮' : '◆')

/** The five loops, in plain words: what each does, how often it turned lately, and the newest learning. */
const LOOP_WORDS = {
  L0: ['tool calls', 'Each tool call an agent makes is checked against the safety rules as it happens.', 'two minutes'],
  L1: ['tries', 'A task that fails its checks tries again; after two failed tries, on a stronger model.', 'hour'],
  L2: ['the plan', 'The plan runs step by step, under its cap.', 'day'],
  L3: ['lessons', 'What a run learns becomes a lesson that later runs get in their prompts.', 'two weeks'],
  L4: ['spot checks', 'Now and then roko checks passed work again, to keep its checks honest.', 'twelve weeks']
}
const LOOP_WINDOW = { L0: 120_000, L1: 3_600_000, L2: 86_400_000, L3: 14 * 86_400_000, L4: 84 * 86_400_000 }

function FiveLoops({ events, now }) {
  const shown = events.filter(e => RING_IDS.includes(e.ring))
  // The log is learning's events; the homeostat's readings (`essential`) have their own lines.
  const log = shown.filter(e => ['L2', 'L3', 'L4'].includes(e.ring) && e.kind !== 'essential').slice(-4).reverse()

  return h(
    'div',
    { className: 'rk-loops', 'data-testid': 'five-loops' },
    h(
      'div',
      { 'aria-label': 'roko’s five loops', className: 'rk-loops-list', role: 'list' },
      RINGS.map(meta => {
        const [name, words, window] = LOOP_WORDS[meta.ring]
        const mine = shown.filter(e => e.ring === meta.ring && now - (e.ts ?? 0) <= LOOP_WINDOW[meta.ring])
        const last = mine[mine.length - 1]

        return h(
          'div',
          { className: 'rk-loop', 'data-testid': `loop-${meta.ring}`, key: meta.ring, role: 'listitem' },
          h(LED, { size: 's', tone: last ? loopChannel(last) : 'off' }),
          h('b', null, name),
          h('span', null, words),
          h('span', { className: 'rk-loop-n' }, `${mine.length} in the last ${window}`)
        )
      })
    ),
    log.length
      ? h(
          'div',
          { className: 'rk-loops-log', 'data-testid': 'learning-log' },
          log.map(e => h('div', { className: 'rk-loops-ev', key: e.key }, h('span', { 'aria-hidden': 'true' }, logGlyph(e)), h('span', { className: 'rk-loops-t' }, e.ts ? ago(e.ts, now) : ''), h('span', null, e.text || KIND_WORDS[e.kind] || e.kind)))
        )
      : h('p', { className: 'rk-lempty' }, 'Lessons, and what roko changed about how it checks and picks models, show here as they happen.')
  )
}

/** A confidence as five bars, solid, eroding (bardo's decay zones █▓▒░), then empty. */
function Confidence({ value }) {
  const v = num(value)

  if (v === null) {
    return null
  }

  const filled = clamp(v, 0, 1) * 5

  return h(
    'span',
    { 'aria-label': `confidence ${pct(v)}`, className: 'rk-conf', role: 'img' },
    Array.from({ length: 5 }, (_, i) => h('i', { 'data-z': filled >= i + 1 ? 'on' : filled > i + 0.5 ? 'e1' : filled > i ? 'e2' : 'o', key: i }))
  )
}

/** One lesson that paid off (spec v3 §4.11): ◇, the lesson, who kept it, and its chain of later tasks. */
function LessonChain({ lesson, now }) {
  const uses = list(lesson.uses).filter(isRecord)
  const firstTry = uses.filter(u => u.outcome === 'first_try').length
  const climbed = uses.filter(u => u.outcome === 'climbed').length
  const kept = isRecord(lesson.kept_by) ? lesson.kept_by : {}
  const keptAt = parseTime(lesson.kept_at)

  return h(
    'div',
    { className: 'rk-chain', 'data-testid': `lesson-paid-${text(lesson.entry_id)}`, role: 'listitem' },
    h('span', { 'aria-hidden': 'true', className: 'rk-chain-g' }, '◇'),
    h(
      'div',
      { className: 'rk-chain-body' },
      h('p', { title: text(lesson.text) }, clip(lesson.text, 240)),
      h(
        'small',
        null,
        'kept ',
        keptAt !== null && now - keptAt > 3_600_000 ? `${sinceWords(keptAt, now)} ago ` : '',
        // The run that kept it opens from its words (design system §6.4: no ids on screen).
        validId(kept.run_id) ? h(Fragment, null, 'by ', h('button', { className: 'rk-chain-run', onClick: () => openRoko({ run: kept.run_id }), title: 'Open the run that kept it', type: 'button' }, 'a run')) : null,
        ` · in ${plural(uses.length, 'prompt')} since`,
        num(lesson.confidence) !== null ? h(Fragment, null, ' · confidence ', h(Confidence, { value: lesson.confidence })) : null
      )
    ),
    h(
      'div',
      { className: 'rk-payoff' },
      h('span', { 'aria-hidden': 'true', className: 'rk-payoff-seq' }, h('span', { className: 'rk-payoff-arrow' }, '→'), uses.slice(-12).map((u, i) => h('i', { 'data-outcome': text(u.outcome), key: i }))),
      h('span', { className: 'rk-payoff-n', 'data-tone': uses.length && firstTry === uses.length ? 'pass' : undefined }, uses.length ? `${firstTry}/${uses.length}${firstTry === uses.length ? ' first try' : climbed ? ` · ${climbed} moved up` : ' first try'}` : 'not used yet')
    )
  )
}

/** Lessons that paid off (spec v3 §5.6): the three whose later tasks passed first try most. */
function LessonsPaid({ data, now }) {
  const lessons = list(data.lessons_paid).filter(isRecord).slice(0, 3)

  return h(
    'section',
    { className: 'rk-runsec rk-panel', 'data-testid': 'lessons-paid' },
    h('h3', { className: 'rk-panel-h' }, 'Lessons that paid off', h('span', null, 'kept by one run, used by later ones')),
    lessons.length
      ? h('div', { 'aria-label': 'Lessons that paid off', className: 'rk-paid', role: 'list' }, lessons.map(lesson => h(LessonChain, { key: text(lesson.entry_id) || text(lesson.text), lesson, now })))
      : h('p', { className: 'rk-lempty' }, data.derived ? 'Which lessons paid off needs the plugin’s learning view (0.6.0).' : 'No lesson has paid off yet: one does when a later task has it in its prompt and passes on the first try.')
  )
}

/** roko's essential variables (M1's homeostat, `homeostasis.rs`): their names in words and how to show them. */
const ESSENTIALS = {
  false_green: { label: 'passed but wrong', show: v => pct(v), unit: 'ratio' },
  // A stopwatch ("3:02"), not "182s": in the dot-matrix font a small s reads as a 5 ("1825").
  latency_p90_s: { label: 'slowest waits (p90)', say: v => `${Math.round(v)} seconds`, show: v => clockFace(Math.round(v) * 1000), unit: 's' },
  pass_rate: { label: 'pass rate', show: v => pct(v), unit: 'ratio' },
  usd_per_verified_success: { label: 'cost per passed task', show: v => money(v), unit: 'usd' }
}
/** How long since `t`, in words: "6 days", "3 hours", "a minute". */
function sinceWords(t, now = Date.now()) {
  const { unit, value } = coarseElapsed(Math.max(0, now - t))

  return unit === 'second' ? 'a minute' : plural(value, unit)
}

/** The knobs roko's controller turns, in words. */
const KNOB_WORDS = { tier_floor: 'the model tasks start on' }

/** What the controller did last, and what is out of bounds, in words. */
function controllerWords(homeostat) {
  const variables = list(homeostat.variables).filter(isRecord)
  const out = variables.filter(v => text(v.state) === 'out')
  const controller = isRecord(homeostat.controller) ? homeostat.controller : {}
  // roko's M1 says its last act as "knob: from -> to".
  const change = /^\s*([^:]+):\s*(.+?)\s*->\s*(.+?)\s*$/.exec(text(controller.change))
  const phase = text(controller.phase)
  const head = change
    ? `It last changed ${KNOB_WORDS[change[1].trim()] ?? clip(change[1], 30)}: ${clip(change[2], 20)} → ${clip(change[3], 20)}`
    : phase === 'search'
      ? 'It is trying a change now'
      : 'It is holding: nothing needs changing'
  const tail = !variables.length ? '' : out.length ? `${out.map(v => ESSENTIALS[text(v.name)]?.label ?? text(v.name)).join(', ')} out of bounds` : variables.length === 4 ? 'all four in bounds' : 'all in bounds'

  return { out: out.length > 0, text: [head, tail].filter(Boolean).join(' · ') }
}

/**
 * How roko keeps itself steady (the homeostat, spec v3 §4.10), in words: four numbers its controller keeps inside
 * their bounds, a line each, and what the controller did last.
 */
function Homeostat({ data }) {
  const homeostat = isRecord(data.homeostat) ? data.homeostat : null
  const variables = list(homeostat?.variables).filter(isRecord)
  const words = homeostat ? controllerWords(homeostat) : null

  return h(
    'div',
    { className: 'rk-steady', 'data-testid': 'homeostat' },
    h('p', { className: 'rk-steady-lead' }, 'roko keeps four numbers inside set bounds, and changes how it picks models when one strays.'),
    variables.length
      ? h(
          'div',
          { className: 'rk-steady-list', role: 'list' },
          variables.slice(0, 4).map(v => {
            const meta = ESSENTIALS[text(v.name)] ?? { label: text(v.name).replace(/_/g, ' '), show: x => String(x) }
            const value = num(v.value)
            const bound = isRecord(v.bound) ? v.bound : {}
            const lo = num(bound.min)
            const hi = num(bound.max)
            const out = text(v.state) === 'out' || (value !== null && ((lo !== null && value < lo) || (hi !== null && value > hi)))
            const say = meta.say ?? meta.show
            const boundSaid = lo !== null ? `≥ ${say(lo)}` : hi !== null ? `≤ ${say(hi)}` : ''

            return h(
              'div',
              { 'aria-label': `${meta.label}: ${value === null ? 'unknown' : say(value)}${boundSaid ? `, bound ${boundSaid}` : ''}${out ? ', out of bounds' : ''}`, className: 'rk-steady-row', 'data-out': out ? 'true' : undefined, 'data-testid': `gauge-${text(v.name)}`, key: text(v.name), role: 'img' },
              h(LED, { size: 's', tone: out ? 'fail' : 'pass' }),
              h('span', null, meta.label),
              h('b', null, value === null ? '—' : meta.show(value)),
              h('span', { className: 'rk-steady-bound' }, lo !== null ? `kept at ${meta.show(lo)} or more` : hi !== null ? `kept at ${meta.show(hi)} or less` : '')
            )
          })
        )
      : h('p', { className: 'rk-lempty' }, data.derived ? 'This needs the plugin’s learning view (0.6.0).' : 'roko has reported none of these yet: its controller publishes them while it runs.'),
    words ? h('div', { className: 'rk-m1', 'data-testid': 'm1-line' }, h(LED, { size: 's', tone: words.out ? 'fail' : 'pass' }), h('span', null, words.text)) : null
  )
}

/** What Learning is, in two sentences, above its numbers. */
const LEARN_INTRO = 'roko keeps score of every try. Cheap models go first; a task moves up only when its checks fail, and what one run learns goes into the next run’s prompts.'
/** The fold an older link names (#tab=knowledge, health, loops): Learning opens with it open. */
const LEARN_FOLD = { health: 'checks', knowledge: 'lessons', loops: 'loops' }

/**
 * Learning (mockup after-learning): three readings on the glass, which models passed the work and the lessons that
 * paid off; the five loops, how roko keeps itself steady, every lesson and the checks' figures, folded.
 */
function LearningPage({ tab }) {
  const scope = useValue($insightsScope)
  const learning = useLearning(scope)
  const overview = useOverview()
  const feed = useValue($loopFeed)
  const now = useNow(5_000)
  const base = useMemo(() => (isRecord(learning.data) ? readLearning(learning.data) : learning.isLoading ? null : learningFromRows(list(overview.data?.runs))), [learning.data, learning.isLoading, overview.data?.runs])
  const data = useMemo(() => {
    const vars = new Map()
    let controller = null

    feed.forEach(e => {
      if (e.kind === 'essential' && isRecord(e.data) && text(e.data.ev)) {
        vars.set(text(e.data.ev), essentialOf(e.data))
      } else if (e.kind === 'controller' && isRecord(e.data)) {
        controller = { change: text(e.data.change), phase: text(e.data.phase) }
      }
    })

    // Only a 0.6.0 backend relays them; a view worked out from the rows stays as it is.
    if (!base || base.derived || (!vars.size && !controller)) {
      return base
    }

    const had = list(base.homeostat?.variables).filter(isRecord)
    const variables = [...had.map(v => vars.get(v.name) ?? v), ...[...vars.values()].filter(v => !had.some(old => old.name === v.name))]

    return { ...base, homeostat: { controller: controller ?? base.homeostat?.controller ?? null, variables } }
  }, [base, feed])
  const open = LEARN_FOLD[tab] ?? null
  // What the page last showed stays while its view is asked for again: the page never drops back to a spinner.
  const shown = useRef(null)

  if (data) {
    shown.current = data
  }

  if (!shown.current) {
    return h('div', { className: 'rk-boot' }, h(Spinner, { label: 'Reading what roko learned…' }))
  }

  const view = shown.current

  return h(
    'div',
    { className: 'rk-home rk-learn', 'data-testid': 'learning-overview' },
    h('div', { className: 'rk-learn-intro' }, h('p', null, LEARN_INTRO), h(LearningScope, null)),
    h(LearningGlass, { data: view }),
    view.coverage?.note || view.recorded
      ? h(
          'p',
          { className: 'rk-learn-foot', 'data-testid': 'learning-coverage' },
          view.coverage?.note ? h('span', null, `◌ ${clip(view.coverage.note, 200)}`) : null,
          view.recorded
            ? h(
                'span',
                null,
                `roko recorded ${plural(view.recorded.tasks, 'task')} here`,
                view.recorded.costPerTask !== null ? ` · about ${money(view.recorded.costPerTask)} a task` : '',
                view.recorded.typicalMs !== null ? ` · ${clockFace(view.recorded.typicalMs)} each` : ''
              )
            : null
        )
      : null,
    h('div', { className: 'rk-runcols' }, h(ModelsPassed, { data: view, ladder: overview.data?.ladder }), h(LessonsPaid, { data: view, now })),
    h(
      'div',
      { className: 'rk-folds' },
      h(Fold, { key: `loops${open === 'loops'}`, name: 'loops', open: open === 'loops', title: 'the five loops, in plain words' }, h(FiveLoops, { events: feed, now })),
      h(Fold, { name: 'steady', title: 'how roko keeps itself steady' }, h(Homeostat, { data: view, now })),
      h(Fold, { key: `lessons${open === 'lessons'}`, name: 'lessons', open: open === 'lessons', title: 'every lesson' }, h(KnowledgeTab, null)),
      h(Fold, { key: `checks${open === 'checks'}`, name: 'checks', open: open === 'checks', title: 'checks, models and spend in detail' }, h(HealthTab, null))
    )
  )
}

/** Learning's three readings on the glass (mockup after-learning): cost per passed task, first tries, moves up. */
function LearningGlass({ data }) {
  const runs = list(data.series).length
  const usd = kpiOf(data, 'usd_per_pass', runRate.usd)
  const first = kpiOf(data, 'first_try_rate', runRate.first)
  const climbs = kpiOf(data, 'climbs_per_run', runRate.climbs)
  const usdDelta = kpiDelta(usd, true, v => money(v))
  const firstDelta = kpiDelta(first, false, v => pct(v))
  const climbDelta = kpiDelta(climbs, true, v => v.toFixed(1))
  // Why a number is missing: an older backend has no learning view; a current one has no ended run to count yet.
  const missing = data.derived ? 'needs the plugin’s learning view (0.6.0)' : 'no ended run has said yet'
  const note = (delta, words) => h('span', { className: 'rk-rc-note rk-kpi-note', 'data-tone': delta?.tone }, delta ? `${delta.arrow} from ${delta.was}` : words)
  const cell = (label, reading, notes, testId) => h('div', { className: 'rk-rc-cell', 'data-testid': testId }, h('span', { className: 'rk-rc-label' }, label), reading, ...notes)

  return h(
    Fragment,
    null,
    h(
      Well,
      { className: 'rk-rc-glass rk-learn-glass', label: 'Is roko getting better', role: 'group', testId: 'learning-hero' },
      cell(
        'cost per passed task',
        h(Dots, { label: usd.value === null ? 'no passed task yet' : `${money(usd.value)} per passed task`, size: 'L', value: money(usd.value) }),
        [
          usdDelta
            ? h('span', { className: 'rk-rc-note rk-kpi-note', 'data-tone': usdDelta.tone }, Math.round(Math.abs(usdDelta.change) * 100) === 0 ? `about the same as your first runs (${usdDelta.was})` : `${usdDelta.arrow} ${Math.round(Math.abs(usdDelta.change) * 100)}% · was ${usdDelta.was} on your first runs`)
            : h('span', { className: 'rk-rc-note' }, runs < 4 ? 'the trend shows after 4 runs' : ''),
          h('span', { className: 'rk-rc-note' }, `${usd.source === 'roko' ? 'roko’s own figures · ' : ''}last ${plural(runs, 'run')}`)
        ],
        'kpi-usd'
      ),
      cell('passed on the first try', h(Dots, { label: first.value === null ? 'no first try yet' : `${pct(first.value)} passed on the first try`, size: 'L', tone: first.value === null ? 'dim' : 'pass', value: first.value === null ? '-' : pct(first.value) }), [note(firstDelta, first.value === null ? missing : '')], 'kpi-first'),
      cell('moved up a model, per run', h(Dots, { label: climbs.value === null ? 'no move up yet' : `${climbs.value.toFixed(1)} moves up a run`, size: 'L', value: climbs.value === null ? '-' : climbs.value.toFixed(1) }), [note(climbDelta, climbs.value === null ? missing : '')], 'kpi-climbs')
    ),
    // What drove them, only from what the runs show (plugin-review Q3), in a sentence under the glass.
    usd.driver || first.driver || climbs.driver
      ? h('p', { className: 'rk-learn-why', 'data-testid': 'kpi-why' }, [first.driver ? `First tries: ${first.driver}.` : '', usd.driver ? `Cost: ${usd.driver}.` : '', climbs.driver ? `Moves up: ${climbs.driver}.` : ''].filter(Boolean).join(' '))
      : null
  )
}

/**
 * Which models passed the work (mockup after-learning): a bar a model, cheapest first, by its passing tries over the
 * runs Learning counts, and what that adds up to in a sentence.
 */
function ModelsPassed({ data, ladder }) {
  const runs = list(data.series).filter(r => isRecord(r) && isRecord(r.by_rung))
  const rungs = (list(data.ladder).length ? list(data.ladder) : list(ladder)).filter(r => isRecord(r) && text(r.rung))
  const names = rungs.length ? rungs.map(r => text(r.rung)) : [...new Set(runs.flatMap(r => Object.keys(r.by_rung)))]
  const rows = names
    .map(name => {
      const rung = rungs.find(r => text(r.rung) === name)

      return { model: text(rung?.slug) || text(rung?.model) || name, n: runs.reduce((sum, r) => sum + (num(r.by_rung[name]) ?? 0), 0), name, off: rung?.chat_ok === false }
    })
    .filter(row => row.n > 0 || !row.off)
  const total = rows.reduce((sum, row) => sum + row.n, 0)
  const most = Math.max(1, ...rows.map(row => row.n))
  const top = [...rows].reverse().find(row => row.n > 0)
  const below = rows.filter(row => row.n > 0 && row !== top)
  // The backend's measure when it gives one: the cheapest model's share of passes, the first runs against the last.
  const share = isRecord(data.share) && num(data.share.from) !== null && num(data.share.to) !== null ? data.share : null
  const head = h('h3', { className: 'rk-panel-h' }, 'Which models passed the work', h('span', null, 'passing tries'))

  if (!runs.length || !names.length) {
    return h(
      'section',
      { className: 'rk-runsec rk-panel', 'data-testid': 'models-passed' },
      head,
      h('p', { className: 'rk-lempty' }, names.length ? 'Each run that ends adds its passing tries here.' : 'This project names no models to move up through (its roko.toml has no ladder).')
    )
  }

  return h(
    'section',
    { className: 'rk-runsec rk-panel', 'data-testid': 'models-passed' },
    head,
    h(
      'div',
      { 'aria-label': 'Passing tries by model, cheapest first', className: 'rk-bars', role: 'list' },
      rows.map(row =>
        h(
          'div',
          { 'aria-label': `${row.model}: ${plural(row.n, 'passing try', 'passing tries')}${row.off ? ', not for chat runs' : ''}`, className: 'rk-bars-row', 'data-off': row.off ? 'true' : undefined, 'data-rung': row.name, key: row.name, role: 'listitem' },
          h('b', null, row.model),
          h('span', { 'aria-hidden': 'true', className: 'rk-bars-track' }, h('i', { style: { width: `${Math.round((row.n / most) * 100)}%` } })),
          h('span', { className: 'rk-bars-n' }, String(row.n))
        )
      )
    ),
    h(
      'p',
      { className: 'rk-bars-said', 'data-testid': 'models-said' },
      `${plural(total, 'passing try', 'passing tries')}. `,
      top && below.length
        ? `The ${below.length === 1 ? 'cheaper model' : `${below.length} cheaper models`} passed ${below.reduce((sum, row) => sum + row.n, 0)} of them, and ${top.model} the other ${top.n}.`
        : top
          ? `All of them on ${top.model}.`
          : '',
      share ? h('span', { 'data-testid': 'models-moved' }, ` The cheapest model’s share went from ${pct(share.from)} to ${pct(share.to)} of passes.`) : null
    )
  )
}

/** The scope of Learning's numbers, beside its intro: whose runs, how many, over how long. */
function LearningScope() {
  const scope = useValue($insightsScope)
  const learning = useLearning(scope)
  const overview = useOverview()
  const data = isRecord(learning.data) ? readLearning(learning.data) : learningFromRows(list(overview.data?.runs))
  const window = isRecord(data.window) ? data.window : {}
  const runs = num(window.runs) ?? list(data.series).length
  const days = num(window.days)
  const found = num(data.coverage?.found)

  return h(
    'span',
    { className: 'rk-lscope' },
    h(
      'span',
      { 'aria-label': 'Whose runs', className: 'rk-seg', role: 'group' },
      [
        ['hermes', 'runs from hermes'],
        ['workspace', 'workspace']
      ].map(([id, word]) => h('button', { 'aria-pressed': scope === id ? 'true' : 'false', 'data-testid': `learning-scope-${id}`, key: id, onClick: () => $insightsScope.set(id), type: 'button' }, word))
    ),
    h('span', { 'data-testid': 'learning-window', title: data.scopeLabel || undefined }, [found !== null && found > runs ? `${runs} of ${plural(found, 'run')}` : plural(runs, 'run'), days ? plural(days, 'day') : ''].filter(Boolean).join(' · '))
  )
}

// --- Insights (health, gates, models, spend) and Knowledge

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

/** "since 21 Sep", "21 Sep – 15 Oct": a scope's period, from its ISO bounds. */
function periodWords(scope) {
  const day = v => {
    const t = parseTime(v)

    return t === null ? '' : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
  }
  const since = day(scope?.since)
  const until = day(scope?.until)

  return since && until && since !== until ? `${since} – ${until}` : since ? `since ${since}` : ''
}

function HealthTab() {
  const health = useHealth()
  const scopeKind = useValue($insightsScope)
  const insights = useInsights(scopeKind)
  const checks = list(health.data).filter(isRecord)
  const data = isRecord(insights.data) ? insights.data : {}
  // A 0.5.0 backend says whose numbers these are and gives checks apart from task verdicts: "no check ran"
  // is not a failed check. An older one answers for the whole workspace, from the gate rows.
  const scope = isRecord(data.scope) ? data.scope : null
  const summary = isRecord(data.summary) ? data.summary : null
  const gates = list(data.gates).filter(isRecord).filter(g => text(g.kind) !== 'verdict')
  const models = list(data.models).filter(isRecord)
  const trend = list(data.cost_trend).filter(isRecord)
  const eff = isRecord(data.efficiency) ? data.efficiency : {}
  const TONE = { fail: 'bad', ok: 'good', warn: 'warn' }
  const GLYPH = { fail: '✗', ok: '✓', warn: '!' }
  const sumChecks = isRecord(summary?.checks) ? summary.checks : null
  const passed = sumChecks ? (num(sumChecks.passed) ?? 0) : gates.reduce((n, g) => n + (num(g.passed) ?? 0), 0)
  const ran = sumChecks ? (num(sumChecks.ran) ?? (num(sumChecks.passed) ?? 0) + (num(sumChecks.failed) ?? 0)) : gates.reduce((n, g) => n + (num(g.passed) ?? 0) + (num(g.failed) ?? 0), 0)
  const passRate = sumChecks && num(sumChecks.pass_rate) !== null ? num(sumChecks.pass_rate) : ran ? passed / ran : null
  const totalSpend = num(summary?.spend_usd) ?? num(eff.total_cost_usd) ?? (trend.length ? num(trend[trend.length - 1].cumulative_usd) : null)
  const tasks = isRecord(summary?.tasks) ? summary.tasks : null
  const runs = isRecord(summary?.runs) ? summary.runs : null
  const scopeLine = scope ? [`numbers for ${text(scope.label) || 'this workspace'}`, periodWords(scope)].filter(Boolean).join(' · ') : 'the whole workspace'
  const failing = checks.filter(c => c.status === 'fail').length
  const warning = checks.filter(c => c.status === 'warn').length

  return h(
    'div',
    { className: 'roko-stack roko-narrow' },
    h(
      'div',
      { className: 'rk-scope', 'data-testid': 'insights-scope' },
      h('span', { className: 'rk-scope-line' }, h(Codicon, { name: 'graph', size: '0.8rem' }), scopeLine),
      // The switch only where the backend knows scopes (an older one answers for the workspace, always).
      scope || scopeKind !== 'hermes'
        ? h(
            'div',
            { 'aria-label': 'Whose numbers', className: 'rk-keyrow', role: 'group' },
            [
              ['hermes', 'from Hermes'],
              ['workspace', 'whole workspace']
            ].map(([id, label]) => h(Key, { 'aria-pressed': scopeKind === id ? 'true' : 'false', key: id, onClick: () => $insightsScope.set(id), size: 's', testId: `scope-${id}` }, label))
          )
        : null
    ),
    insights.data
      ? h(
          'div',
          { className: 'roko-kpis' },
          h(Kpi, { label: 'Checks passing', sub: ran ? `${passed} of ${plural(ran, 'check')} that ran` : 'no check has run yet', tone: rateTone(passRate), value: passRate === null ? '—' : `${Math.round(passRate * 100)}%` }),
          runs
            ? h(Kpi, {
                label: 'Runs',
                sub: [
                  num(runs.succeeded) ? `${runs.succeeded} passed` : '',
                  num(runs.unverified) ? `${runs.unverified} unverified` : '',
                  num(runs.failed) ? `${runs.failed} failed` : '',
                  num(runs.interrupted) ? `${runs.interrupted} interrupted` : '',
                  num(runs.cancelled) ? `${runs.cancelled} cancelled` : ''
                ]
                  .filter(Boolean)
                  .join(' · ') || null,
                value: String(num(runs.total) ?? 0)
              })
            : null,
          h(Kpi, { label: 'Spend recorded', sub: scope ? text(scope.label) || null : 'the whole workspace', value: money(totalSpend) }),
          h(Kpi, {
            label: 'Tasks recorded',
            sub: num(summary?.cost_per_task_usd ?? eff.cost_per_task_usd) !== null ? `${money(summary?.cost_per_task_usd ?? eff.cost_per_task_usd)} a task` : null,
            value: num(tasks?.total ?? eff.tasks_recorded) !== null ? String(num(tasks?.total ?? eff.tasks_recorded)) : '—'
          }),
          h(Kpi, { label: 'Typical task', sub: 'average duration', value: duration(summary?.typical_task_ms ?? eff.avg_task_duration_ms) })
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
  // The wall's head: every lesson that paid off (0.6.0 /learning), each with its chain of later tasks.
  const scope = useValue($insightsScope)
  const learning = useLearning(scope)
  const paid = isRecord(learning.data) ? readLearning(learning.data).lessons_paid : []
  const now = useNow(60_000)

  return h(
    'div',
    { className: 'roko-stack roko-narrow' },
    paid.length
      ? h(
          Glass,
          { className: 'rk-lpanel rk-wall', grid: true, testId: 'lesson-wall' },
          h(ModLabel, { note: 'kept by one run, used by later ones' }, 'lessons that paid off'),
          h('div', { 'aria-label': 'Lessons that paid off', className: 'rk-paid', role: 'list' }, paid.slice(0, 10).map(lesson => h(LessonChain, { key: text(lesson.entry_id) || text(lesson.text), lesson, now })))
        )
      : null,
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

// --- The New run device: ask roko for work from the app (POST /runs)

const DOMAINS = [
  { hint: 'Checked by your build, tests and lint.', id: 'code', label: 'code' },
  { hint: 'Checked for sources and coverage.', id: 'research', label: 'research' },
  { hint: 'Checked for structure and accuracy.', id: 'docs', label: 'docs' }
]

/**
 * roko's estimate for a request before it runs (0.6.0 P7 `GET /estimate`, read-only): asked when the composer opens,
 * so the panel and the default cap are there before the person reaches the knob. An older backend has none.
 */
function useEstimate(prompt, domain, enabled) {
  const q = useDebounced(text(prompt).trim(), 600)
  const project = useValue($project)

  return useQuery({
    enabled: Boolean(enabled),
    placeholderData: previous => previous,
    // Its length, never its words: a URL ends up in logs and history (plugin-review Q5).
    queryFn: () => call(forProject(`/estimate?chars=${q.length}&domain=${enc(domain)}`, project)).then(r => (isRecord(r.estimate) ? r.estimate : null)),
    queryKey: projectKey([ID, 'estimate', q.length, domain], project),
    retry: false,
    staleTime: 60_000
  })
}

/** The minutes a likely run takes, in words. */
function aboutSecs(secs) {
  return secs === null ? '' : secs < 45 ? 'under a minute' : secs < 90 ? 'about a minute' : `about ${Math.round(secs / 60)} minutes`
}

/**
 * Where a run starts (spec v3 §5.7): the ladder with prices and the start rung, what roko expects it to cost, how far
 * it can climb before the cap stops it, how similar tasks went, and the checks roko found (when the backend estimates).
 */
function WhereItStarts({ ladder, cap, estimate }) {
  const e = isRecord(estimate) ? estimate : null
  const rungs = list(list(e?.ladder).length ? e.ladder : ladder).filter(r => isRecord(r) && text(r.rung))

  if (!rungs.length) {
    return null
  }

  const named = rungs.findIndex(r => text(r.rung) === text(e?.start_rung))
  const at = named >= 0 ? named : Math.max(0, rungs.findIndex(r => r.chat_ok !== false))
  // How far it may climb: roko's `climb` when it estimates, else the two usable rungs above the start.
  const climb = list(e?.climb).map(text).filter(Boolean)
  const above = rungs.slice(at + 1).filter(r => r.chat_ok !== false)
  const highest = climb.length ? (climb.length > 1 ? climb[climb.length - 1] : '') : text(above[Math.min(1, above.length - 1)]?.rung)
  const likely = isRecord(e?.likely) ? e.likely : null
  const usd = num(likely?.usd)
  const secs = num(likely?.seconds)
  const worst = num(e?.worst_usd)
  const capped = Number.isFinite(cap) && cap > 0
  const similar = isRecord(e?.similar) ? e.similar : null
  const tasks = num(similar?.tasks)
  const rate = num(similar?.first_try_rate) ?? (tasks ? num(similar?.first_try) / tasks : null)
  // null: roko.toml could not be read (say nothing); []: roko runs no check, so the run ends unverified.
  const checks = Array.isArray(e?.checks) ? e.checks.filter(isRecord) : null
  const basis = [text(e?.basis), text(e?.confidence) === 'low' && usd !== null ? 'low confidence' : ''].filter(Boolean).join(' · ')

  return h(
    Glass,
    { className: 'rk-starts', grid: true, testId: 'where-it-starts' },
    h(ModLabel, { note: 'the ladder in roko.toml · cheapest first' }, 'where it starts'),
    h(
      'div',
      { className: 'rk-starts-body' },
      h(
        'div',
        { 'aria-label': 'The model ladder, top rung first', className: 'rk-starts-ladder', role: 'list' },
        rungs
          .slice()
          .reverse()
          .map(r => {
            const start = r === rungs[at]

            return h(
              'div',
              { className: 'rk-starts-rung', 'data-off': r.chat_ok === false ? 'true' : undefined, 'data-start': start ? 'true' : undefined, key: text(r.rung), role: 'listitem' },
              h('span', { className: 'rk-starts-name' }, start ? '▸ ' : '', text(r.rung)),
              h('span', { className: 'rk-starts-model' }, text(r.slug) || text(r.model)),
              h('span', { className: 'rk-starts-price', title: r.chat_ok === false ? undefined : pricedBy(r) || undefined }, r.chat_ok === false ? 'not for chat runs' : rungPrice(r))
            )
          })
      ),
      h(
        'div',
        { className: 'rk-starts-side' },
        usd !== null
          ? h(
              'div',
              { className: 'rk-starts-likely', 'data-testid': 'starts-likely' },
              h('span', { className: 'rk-starts-k' }, 'likely ≈'),
              h(Dots, { label: `likely about ${money(usd)}`, size: 'M', tone: 'ink', value: money(usd) }),
              h('span', null, [aboutSecs(secs), `${text(rungs[at].rung)} rung`].filter(Boolean).join(' · '))
            )
          : null,
        basis ? h('p', { className: 'rk-starts-basis', 'data-testid': 'starts-basis' }, basis) : null,
        h(
          'p',
          { className: 'rk-starts-rule', 'data-testid': 'starts-rule' },
          checks && !checks.length
            ? 'roko found no check to run, so it never climbs: the run ends unverified.'
            : highest
              ? `2 failed tries → a rung up, at most to ${highest}.`
              : 'It stays on its rung: no rung above it can run work from a chat.',
          capped
            ? worst !== null && worst < cap - 1e-9
              ? ` At worst ≈ ${money(worst)}, under the ${money(cap)} cap.`
              : ` The ${money(cap)} cap stops it before it spends past it.`
            : ''
        ),
        tasks
          ? h(
              'p',
              { className: 'rk-starts-similar', 'data-testid': 'starts-similar' },
              `${plural(tasks, 'similar task')}: `,
              rate !== null ? h('b', null, `${pct(rate)} passed on the first try`) : 'none said yet',
              num(similar.climbed) ? `, ${num(similar.climbed)} climbed.` : '.'
            )
          : null,
        checks && checks.length
          ? h(
              'div',
              { 'aria-label': 'The checks roko will run', className: 'rk-starts-checks', role: 'list' },
              checks.slice(0, 3).map((c, i) =>
                h(
                  'div',
                  { className: 'rk-starts-check', key: i, role: 'listitem', title: text(c.name) || undefined },
                  h('i', { 'aria-hidden': 'true' }),
                  h('b', null, clip(text(c.phase) || text(c.name), 16)),
                  h('span', null, clip(c.command, 60)),
                  text(c.source) ? h('small', null, clip(c.source, 24)) : null
                )
              ),
              checks.length > 3 ? h('small', { className: 'rk-starts-more' }, `and ${plural(checks.length - 3, 'more check')}`) : null
            )
          : null
      )
    )
  )
}

/**
 * The composer (mockup after-composer): one text box, the project, a switch to write a plan first, the cap as presets,
 * a sentence on what happens, and one orange key; where it starts, the kind of work, the exact cap and a name, folded.
 */
function Composer() {
  const state = useValue($composer)
  const limits = useLimits()
  const { blocking, problems: setupProblems } = useSetup()
  const { canAct, left, maxRun, maxDay, today } = limits
  const ceiling = capCeiling(limits)
  const [title, setTitle] = useState('')
  const [cap, setCap] = useState('0.50')
  const [domain, setDomain] = useState('code')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  // A plan the person already has (`$composer.plan`): the composer runs it, as Plans ▸ Run plan… does.
  const plans = usePlans(Boolean(state.open))
  const planList = list(plans.data).filter(plan => isRecord(plan) && validId(plan.id))
  const chosenPlan = validId(state.plan) ? planList.find(plan => plan.id === state.plan) ?? { id: state.plan } : null
  const planDetail = usePlan(chosenPlan ? chosenPlan.id : null)
  const estimate = num(planDetail.data?.estimate?.total_cost_usd)
  const mode = chosenPlan ? 'existing' : state.mode === 'plan' ? 'plan' : 'run'
  const prompt = state.prompt ?? ''
  // P-6: a plan from a spec file in the project, which roko reads exactly: the request only adds to it.
  const spec = mode === 'plan' ? text(state.spec) : ''
  const amount = Number.parseFloat(cap)
  const tooMuch = ceiling !== null && Number.isFinite(amount) && amount > ceiling + 1e-9
  // Examples about this workspace, when the backend sends some (`overview.examples`); else roko's generic ones.
  const overviewData = useOverview().data
  // P-7: a roko that caps plan writing (55d0acda8) gets a cap for it too; an older one keeps its own limit.
  const planCap = mode === 'plan' && overviewData?.plan_writing_cap === true
  const capOk = (mode === 'plan' && !planCap) || (Number.isFinite(amount) && amount >= 0.01 && !tooMuch)
  const promptOk = mode === 'existing' || ((prompt.trim().length > 0 || Boolean(spec)) && prompt.length <= MAX_PROMPT)
  // roko will not run the chosen plan as it is (0.5.0 `validation`, or a refusal that says so): why, and no Run.
  const invalid =
    mode !== 'existing' ? null : isRecord(planDetail.data?.validation) ? planDetail.data.validation : error instanceof RokoError ? error.validation : null
  const valid = promptOk && capOk && !busy && !blocking && !invalid
  const kind = DOMAINS.find(d => d.id === domain) ?? DOMAINS[0]
  const refusal = error instanceof RokoError ? error.problem : null
  const ownExamples = list(overviewData?.examples).map(text).filter(Boolean).slice(0, 3)
  // 0.7: which project the run is for. Picking one here switches the page too, so its plans, ladder and setup match.
  const projects = projectsOf(overviewData)
  // What roko expects the request to cost, where it starts, and the checks it found (0.6.0 P7; older: none).
  const estimateQuery = useEstimate(prompt, domain, Boolean(state.open) && mode === 'run')
  const p90 = num(estimateQuery.data?.similar?.p90_usd)
  // The person turned the knob or typed a cap since the composer opened: roko's default no longer moves it.
  const capTouched = useRef(false)
  const chooseCap = value => {
    capTouched.current = true
    setCap(value)
  }

  useEffect(() => {
    if (state.open) {
      capTouched.current = false
      setError(null)
      setBusy(false)

      if (text(state.title)) {
        setTitle(text(state.title))
      }

      // A run the person starts again keeps its cap (`$composer.cap`).
      const wanted = num(state.cap)

      if (wanted !== null && wanted >= 0.01) {
        setCap((ceiling !== null ? Math.min(wanted, ceiling) : wanted).toFixed(2))
      } else if (ceiling !== null && Number.parseFloat(cap) > ceiling) {
        setCap(Math.max(0.01, Math.floor(ceiling * 100) / 100).toFixed(2))
      }
    }
  }, [state.open])

  // A plan's cap starts at the detent that covers roko's estimate for it (never below what is set).
  useEffect(() => {
    if (mode === 'existing' && estimate !== null && estimate > Number.parseFloat(cap) && num(state.cap) === null) {
      const detent = CAP_PRESETS.find(c => c >= estimate && (ceiling === null || c <= ceiling + 1e-9))

      if (detent) {
        setCap(detent.toFixed(2))
      }
    }
  }, [mode, estimate])

  // A run's cap starts at the smallest detent at or above what 9 in 10 similar runs cost (P7 `similar.p90_usd`).
  useEffect(() => {
    if (state.open && mode === 'run' && p90 !== null && !capTouched.current && num(state.cap) === null) {
      const detent = CAP_PRESETS.find(c => c >= p90 - 1e-9 && (ceiling === null || c <= ceiling + 1e-9))

      if (detent) {
        setCap(detent.toFixed(2))
      }
    }
  }, [state.open, mode, p90])

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

    if (mode === 'existing') {
      const body = {
        max_usd: Math.round(amount * 100) / 100,
        ...projectBody(),
        ...(state.resume ? { resume: true } : {}),
        ...(text(chosenPlan.title) || title.trim() ? { title: clip(title.trim() || text(chosenPlan.title), 80) } : {})
      }

      try {
        const reply = await post(`/plans/${enc(chosenPlan.id)}/run`, body)

        play('start', true)
        markFresh(reply.run_id)
        host.notify({ kind: 'success', message: clip(text(chosenPlan.title) || chosenPlan.id, 100), title: `roko: plan started · cap ${money(body.max_usd)}` })
        $composer.set({ cap: null, mode: 'run', open: false, plan: null, prompt: '', resume: false })
        setTitle('')
        afterChange(reply.run_id)

        if (validId(reply.run_id)) {
          openRoko({ run: reply.run_id })
        }
      } catch (err) {
        setError(err)

        if (err instanceof RokoError && err.validation) {
          void queryClient.invalidateQueries({ queryKey: KEYS.plan(chosenPlan.id) })
        }
      } finally {
        setBusy(false)
      }

      return
    }

    const body = { ...(prompt.trim() ? { prompt: prompt.trim() } : {}), ...projectBody() }

    if (title.trim()) {
      body.title = title.trim()
    }

    if (mode === 'plan') {
      body.plan = true

      if (spec) {
        body.spec_path = spec
      }

      if (planCap) {
        body.max_usd = Math.round(amount * 100) / 100
      }
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

      play('start', true)
      markFresh(reply.run_id)
      host.notify({
        kind: 'success',
        message: clip(title.trim() || prompt || spec, 100),
        title: mode === 'plan' ? 'roko: writing a plan' : `roko: run started · cap ${money(body.max_usd)}`
      })
      $composer.set({ mode, open: false, prompt: '', spec: null })
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

  // What happens when the person presses the key, in a sentence (mockup after-composer).
  const est = isRecord(estimateQuery.data) ? estimateQuery.data : null
  const likelyUsd = num(est?.likely?.usd)
  const likelySecs = num(est?.likely?.seconds)
  const note =
    mode === 'plan'
      ? planCap
        ? `Writing the plan spends at most ${Number.isFinite(amount) ? money(amount) : 'its cap'} and runs nothing. You start it when it looks right.`
        : 'Writing the plan spends a little, up to roko’s own limit for plan writing, and runs nothing. You start it when it looks right.'
      : mode === 'existing'
        ? `roko runs the plan’s tasks, each checked, and stops at the ${Number.isFinite(amount) ? money(amount) : ''} cap.`.replace(' the  cap', ' its cap')
        : likelyUsd !== null
          ? `roko expects about ${money(likelyUsd)}${likelySecs !== null ? ` and ${aboutSecs(likelySecs).replace(/^about /, '')}` : ''}; the cap stops it before it spends past ${Number.isFinite(amount) ? money(amount) : 'it'}.`
          : 'roko’s agent works on its own branch; your project’s checks must pass before roko calls it done.'
  const keyWord = mode === 'plan' ? (planCap ? `write plan · cap ${Number.isFinite(amount) ? money(amount) : '—'}` : 'write plan') : `${mode === 'existing' ? 'run plan' : 'start'} · cap ${Number.isFinite(amount) ? money(amount) : '—'}`

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
        h(DialogTitle, null, 'New run'),
        h(
          DialogDescription,
          null,
          mode === 'existing' ? 'Run a plan roko already has: its tasks and their checks are set.' : 'Say what you want done. roko splits it into tasks, each with a check that must pass.'
        )
      ),
      h(
        'div',
        { className: 'roko-form rk-composer-body' },
        mode === 'existing'
          ? h(
              'div',
              { className: 'rk-composer-plans', 'data-testid': 'composer-plan' },
              h(
                'div',
                { 'aria-label': 'Which plan', className: 'rk-planpick', role: 'radiogroup' },
                // The plan this composer was opened on shows even before (or without) the list.
                sectionPlans(planList.some(plan => plan.id === chosenPlan.id) ? planList : [...planList, chosenPlan]).map(([name, rows]) =>
                  h(
                    'div',
                    { className: 'rk-planpick-group', key: name },
                    h('div', { className: 'rk-planpick-head' }, name),
                    rows.map(plan =>
                      h(
                        'button',
                        {
                          'aria-checked': plan.id === chosenPlan.id ? 'true' : 'false',
                          className: 'rk-planpick-item',
                          'data-on': plan.id === chosenPlan.id ? 'true' : undefined,
                          'data-pick': plan.id,
                          key: plan.id,
                          onClick: () => setDraft({ plan: plan.id }),
                          role: 'radio',
                          type: 'button'
                        },
                        h(LED, { size: 's', tone: plan.id === chosenPlan.id ? 'you' : 'off' }),
                        h('span', { className: 'rk-planpick-title' }, text(plan.title) || plan.id),
                        // Two plans with one title: their ids tell them apart, by their ends ("…-ledger-2").
                        text(plan.title) && planList.filter(other => text(other.title) === text(plan.title)).length > 1
                          ? h('span', { className: 'roko-muted roko-mono rk-planpick-id', title: plan.id }, plan.id.length > 24 ? `…${plan.id.slice(-23)}` : plan.id)
                          : null,
                        isStartHere(plan) ? h('span', { className: 'rk-tag', 'data-channel': 'you' }, 'start here') : null,
                        num(plan.task_count) !== null ? h('span', { className: 'roko-muted' }, plural(num(plan.task_count), 'task')) : null
                      )
                    )
                  )
                )
              ),
              h(
                'div',
                { className: 'rk-planpick-foot' },
                h(
                  'span',
                  { className: 'roko-muted', 'data-testid': 'composer-plan-facts' },
                  [
                    num(chosenPlan.task_count ?? planDetail.data?.task_count) !== null ? plural(num(chosenPlan.task_count ?? planDetail.data?.task_count), 'task') : null,
                    planDetail.data ? plural(list(planDetail.data.waves).length || 1, 'wave') : null,
                    estimate !== null ? `roko estimates ${money(estimate)}` : null,
                    isDemoPlan(chosenPlan) ? 'a demo: its output stays on its run branch' : null
                  ]
                    .filter(Boolean)
                    .join(' · ')
                ),
                h(
                  'label',
                  { className: 'rk-check' },
                  h('input', { checked: Boolean(state.resume), 'data-testid': 'composer-resume', onChange: event => setDraft({ resume: event.target.checked }), type: 'checkbox' }),
                  h('span', null, 'skip tasks that already passed')
                )
              )
            )
          : null,
        spec
          ? h(
              'div',
              { className: 'rk-spec', 'data-testid': 'composer-spec' },
              h(Codicon, { name: 'file', size: '0.75rem' }),
              h('span', null, 'from ', h('code', null, spec), ' · roko reads it exactly'),
              h(Key, { 'aria-label': 'Plan from the request alone', onClick: () => setDraft({ spec: null }), size: 's', title: 'Plan from the request alone' }, '×')
            )
          : null,
        mode === 'existing' ? null : h('label', { className: spec ? 'rk-field-label' : 'rk-sr', htmlFor: 'roko-composer-prompt' }, spec ? 'Anything to add to the spec? (optional)' : 'What should roko do?'),
        mode === 'existing'
          ? null
          : h(Textarea, {
              'aria-invalid': prompt.length > MAX_PROMPT,
              autoFocus: true,
              className: 'roko-prompt',
              id: 'roko-composer-prompt',
              maxLength: MAX_PROMPT + 200,
              onChange: event => setDraft({ prompt: event.target.value }),
              placeholder: spec ? 'roko plans from the spec as it is written: add only what it leaves out.' : 'Say what to change, where, and how to check it. roko’s agent sees only this text.',
              rows: 5,
              value: prompt
            }),
        mode !== 'existing' && prompt.length > MAX_PROMPT * 0.8 ? h('span', { className: cx('rk-composer-count', prompt.length > MAX_PROMPT && 'roko-tone-bad') }, `${prompt.length.toLocaleString()} / ${MAX_PROMPT.toLocaleString()}`) : null,
        prompt.trim() || spec || mode === 'existing'
          ? null
          : h(
              'div',
              { className: 'roko-examples' },
              h('span', { className: 'roko-examples-label' }, 'try'),
              // This workspace's own demo first, when it has one: a real run in about a minute, for under a cent.
              planList
                .filter(isStartHere)
                .slice(0, 1)
                .map(plan =>
                  h('button', { className: 'roko-example', 'data-testid': 'example-start-here', key: `plan:${plan.id}`, onClick: () => setDraft({ plan: plan.id }), title: text(plan.title) || plan.id, type: 'button' }, `▶ ${clip(text(plan.title).replace(/^start here:\s*/i, '') || plan.id, 32)}`)
                ),
              ownExamples.length
                ? ownExamples.map((example, i) => h('button', { className: 'roko-example', key: `own:${i}`, onClick: () => setDraft({ prompt: example }), title: example, type: 'button' }, clip(example, 40)))
                : EXAMPLES.map((example, i) => h('button', { className: 'roko-example', key: i, onClick: () => setDraft({ prompt: example }), title: example, type: 'button' }, EXAMPLE_CHIPS[i] ?? clip(example, 40)))
            ),
        // The project: picked here when there is a choice to make (none yet, or several); else said in a word.
        projects.none || list(projects.all).length > 1 ? h(ProjectModule, { projects }) : null,
        h(
          'div',
          { className: 'rk-composer-row' },
          projects.current && !projects.none && list(projects.all).length <= 1 ? h('span', { className: 'rk-composer-in', title: projects.current.path }, 'in ', h('b', null, projects.current.name)) : null,
          mode === 'existing'
            ? h(Key, { onClick: () => setDraft({ plan: null, resume: false }), size: 's', testId: 'composer-request' }, 'a new request instead')
            : h(
                'label',
                { className: 'rk-composer-mode', htmlFor: 'roko-composer-plan' },
                h(Switch, { checked: mode === 'plan', id: 'roko-composer-plan', onCheckedChange: value => setDraft({ mode: value ? 'plan' : 'run' }) }),
                h('span', null, 'write a plan first')
              ),
          mode === 'run' || mode === 'existing' || planCap ? h(CapPresets, { amount, ceiling, onPick: value => chooseCap(value.toFixed(2)) }) : null
        ),
        h('p', { className: 'rk-composer-note', 'data-testid': 'composer-note' }, note),
        h(
          'details',
          { className: 'rk-rc-fold rk-composer-more', 'data-testid': 'composer-more' },
          h('summary', null, 'more'),
          h(
            'div',
            { className: 'rk-composer-more-body' },
            mode === 'run' ? h(WhereItStarts, { cap: amount, estimate: estimateQuery.data, ladder: overviewData?.ladder }) : null,
            mode === 'run'
              ? h(
                  'div',
                  { className: 'rk-composer-field' },
                  h('span', { className: 'rk-field-label' }, 'kind of work'),
                  h('div', { 'aria-label': 'Kind of work', className: 'rk-keyrow', role: 'group' }, DOMAINS.map(d => h(Key, { 'aria-pressed': domain === d.id ? 'true' : 'false', key: d.id, onClick: () => setDomain(d.id), size: 's' }, d.label))),
                  h('span', { className: 'rk-hint' }, kind.hint)
                )
              : null,
            mode === 'run' || mode === 'existing' || planCap
              ? h(
                  'div',
                  { className: 'rk-composer-field roko-field' },
                  h('label', { className: 'rk-field-label', htmlFor: 'roko-composer-cap' }, 'Spend cap'),
                  planCap ? h('span', { className: 'rk-hint' }, 'the most writing the plan may spend') : null,
                  h(Input, { 'aria-invalid': !capOk, id: 'roko-composer-cap', inputMode: 'decimal', min: '0.01', onChange: event => chooseCap(event.target.value), prefix: '$', step: '0.01', type: 'number', value: cap })
                )
              : null,
            h(
              'div',
              { className: 'rk-composer-field' },
              h('label', { className: 'rk-field-label', htmlFor: 'roko-composer-title' }, 'Name it ', h('span', { className: 'roko-muted' }, '(optional, shown in your run lists)')),
              h(Input, { id: 'roko-composer-title', maxLength: 80, onChange: event => setTitle(event.target.value), placeholder: 'e.g. JSON output for the report', value: title })
            ),
            mode !== 'existing' && planList.length
              ? h(
                  Key,
                  { onClick: () => setDraft({ plan: (planList.find(isStartHere) ?? planList[0]).id }), size: 's', testId: 'composer-plan-key', title: 'Run a plan roko already has, such as the hello world demo' },
                  'run a plan roko already has'
                )
              : null,
            h(
              'div',
              { className: 'roko-composer-limits', 'data-testid': 'composer-limits' },
              maxRun !== null ? h('span', null, `at most ${money(maxRun)} per run`) : null,
              maxDay !== null ? h('span', null, `today ${money(today)} of ${money(maxDay)}`) : null,
              left !== null ? h('span', null, `${money(left)} left today`) : null
            )
          )
        ),
        !capOk ? h('div', { className: 'roko-result', 'data-tone': 'bad' }, tooMuch ? `Enter a cap of at most ${money(ceiling)}.` : 'Enter a cap of at least $0.01.') : null,
        h(FixDoneNote, { problems: setupProblems }),
        // The page's status is behind the dialog: the serve's changes are said here too (starting, then running).
        h('span', { 'aria-live': 'polite', className: 'rk-sr', 'data-testid': 'composer-serve-said', role: 'status' }, serveOf(overviewData) ? serveWords(serveOf(overviewData)) : ''),
        blocking && !refusal && !blocking.pick ? h(Blocking, { lead: 'roko can’t start work from Hermes until this is fixed:', problem: blocking }) : null,
        refusal ? h(ProblemCard, { lead: 'roko did not start it:', problem: refusal }) : null,
        invalid ? h(PlanValidationNote, { plan: { ...(planDetail.data ?? {}), group: text(planDetail.data?.group) || text(chosenPlan.group), id: chosenPlan.id }, validation: invalid }) : null,
        error && !refusal && !(error instanceof RokoError && error.validation)
          ? h('div', { className: 'roko-result', 'data-tone': 'bad', role: 'alert' }, describe(error).message, describe(error).hint ? h('span', { className: 'roko-result-hint' }, ` ${describe(error).hint}`) : null)
          : null
      ),
      h(
        DialogFooter,
        { className: 'rk-composer-foot' },
        h(Key, { onClick: closeComposer, size: 's' }, 'cancel'),
        h(
          'button',
          {
            className: 'rk-key rk-start',
            'data-size': 'xl',
            'data-testid': 'composer-submit',
            'data-tone': 'primary',
            disabled: !valid,
            onClick: () => void submit(),
            title: blocking ? blocking.title : invalid ? 'roko won’t run this plan yet: see why above' : `${keyWord} (${comboLabel('mod+enter')})`,
            type: 'button'
          },
          busy ? h(Spinner, null) : null,
          keyWord
        )
      )
    )
  )
}

/** The cap as presets (mockup after-composer): a key a detent up to the ceiling, the one set lit; the exact field is in "more". */
function CapPresets({ amount, ceiling, onPick }) {
  const detents = CAP_PRESETS.filter(c => ceiling === null || c <= ceiling + 1e-9)

  return h(
    'div',
    { 'aria-label': 'Spend cap presets', className: 'rk-capset', role: 'group' },
    h('span', { className: 'rk-capset-label' }, 'cap'),
    detents.map(c =>
      h('button', { 'aria-pressed': Number.isFinite(amount) && Math.abs(amount - c) < 1e-9 ? 'true' : 'false', className: 'rk-capset-key', key: c, onClick: () => onPick(c), type: 'button' }, c < 1 ? money(c) : `$${c}`)
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

// --- Page tabs

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

/** A run's light: blue blinking while it works, orange fast when it waits on the person, then its verdict. */
function runChannel(row, waiting) {
  if (isActiveRun(row)) {
    return waiting ? 'you' : 'agent'
  }

  return row.state === 'succeeded' ? 'pass' : row.state === 'failed' && !capStopped(row) ? 'fail' : ['unverified', 'missing', 'interrupted'].includes(row.state) ? 'you' : 'off'
}

/**
 * The empty page already shows the pitch (spec v3 §7, 0:00): the mark asleep and, in the glass, this workspace's ladder,
 * four rungs with prices, the rung a run starts on, and the one line that says how it works.
 */
function LadderGlass({ ladder, serve }) {
  const rungs = list(ladder).filter(r => isRecord(r) && text(r.rung))
  const start = rungs.findIndex(r => r.chat_ok !== false)
  // 0.7: a serve that does not run says so on the glass; the banner above has its keys.
  const look = serve ? SERVE_LOOK[serve.state] : null

  return h(
    Glass,
    { className: 'rk-ladderglass', grid: true, testId: 'ladder-glass' },
    // roko's wordmark (design system §5.1), dim while nothing has run here, lit as its serve starts.
    h('span', { className: 'rk-ladderglass-mark' }, h(Dots, { label: serve?.state === 'starting' ? 'roko, starting' : 'roko', size: 'L', sweep: serve?.state === 'starting', tone: serve?.state === 'starting' ? 'live' : 'dim', value: 'ROKO' })),
    h(
      'div',
      { className: 'rk-ladderglass-body' },
      h(ModLabel, { note: look ? h('span', { 'data-testid': 'onboard-serve' }, h(LED, { blink: look.blink, size: 's', tone: look.tone }), ` roko serve ${look.word}`) : 'roko.toml' }, 'this workspace’s ladder'),
      h(
        'div',
        { 'aria-label': 'The model ladder, top rung first', className: 'rk-starts-ladder', role: 'list' },
        rungs
          .slice()
          .reverse()
          .map(r =>
            h(
              'div',
              { className: 'rk-starts-rung', 'data-off': r.chat_ok === false ? 'true' : undefined, 'data-start': r === rungs[start] ? 'true' : undefined, key: text(r.rung), role: 'listitem' },
              h('span', { className: 'rk-starts-name' }, r === rungs[start] ? '▸ ' : '', text(r.rung)),
              h('span', { className: 'rk-starts-model' }, text(r.slug) || text(r.model)),
              h('span', { className: 'rk-starts-price', title: r.chat_ok === false ? undefined : pricedBy(r) || undefined }, r.chat_ok === false ? 'not for chat runs' : rungPrice(r))
            )
          )
      ),
      h('p', { className: 'rk-ladderglass-line' }, 'cheapest model first · your checks decide when it is done')
    )
  )
}

function Onboarding() {
  const { canAct } = useLimits()
  const data = useOverview().data
  const ladder = list(data?.ladder).filter(isRecord)
  const serve = serveOf(data)
  const down = serve && SERVE_BANNER.has(serve.state) ? serve : null

  return h(
    'div',
    { className: 'roko-onboard', 'data-testid': 'onboarding' },
    ladder.length
      ? h(LadderGlass, { ladder, serve: down })
      : down
        ? h(Well, { className: 'rk-onboard-well', testId: 'onboard-serve' }, h(LED, { blink: SERVE_LOOK[down.state].blink, tone: SERVE_LOOK[down.state].tone }), h(Dots, { label: serveWords(down), size: 'XL', sweep: down.state === 'starting', tone: SERVE_LOOK[down.state].tone === 'off' ? 'dim' : SERVE_LOOK[down.state].tone, value: SERVE_LOOK[down.state].dots }))
        : h(Well, { className: 'rk-onboard-well' }, h(Dots, { label: 'roko', size: 'XL', tone: 'you', value: 'ROKO' }), h(Scope, { height: 34, runId: null, width: 140 })),
    h('h2', { className: 'roko-onboard-title' }, 'Delegate checked work to roko'),
    h(
      'p',
      { className: 'roko-onboard-text' },
      'roko turns a request into small tasks, runs each with an agent on its own branch, and calls a task done only when your project’s checks pass. You watch it here, then review the diff and merge.'
    ),
    h(
      'ol',
      { className: 'roko-steps' },
      h('li', null, h(ModLabel, null, 'ask'), h('span', null, 'In any chat: “Use roko to … Cap it at $1.” Or start one here.')),
      h('li', null, h(ModLabel, null, 'watch'), h('span', null, 'Every task, try and check, live, with what it spent against its cap.')),
      h('li', null, h(ModLabel, null, 'review & merge'), h('span', null, 'Read the changes, then merge the checked work with one key.'))
    ),
    canAct
      ? h(
          'div',
          { className: 'roko-onboard-actions' },
          // One orange key a screen: while the banner above offers to start roko serve, that is the one.
          h(Key, { kbd: 'N', onClick: () => openComposer({ mode: 'run' }), size: 'l', testId: 'onboard-new-run', tone: down?.actions.includes('start') ? undefined : 'primary' }, h(Codicon, { name: 'add', size: '0.8rem' }), 'new run'),
          h(
            'div',
            { className: 'roko-examples' },
            EXAMPLES.map((example, i) =>
              h('button', { className: 'roko-example', key: i, onClick: () => openComposer({ mode: 'run', prompt: example }), title: example, type: 'button' }, EXAMPLE_CHIPS[i] ?? clip(example, 60))
            )
          )
        )
      : null
  )
}

/**
 * One of roko's demos (the backend's `demo`): a showcase, not the person's work. Its output belongs on its run's
 * branch: merged, it clutters the person's branch, and a later run of the demo finds its check already passing.
 */
function isDemoPlan(plan) {
  return plan?.demo === true
}

/** The demo roko says to run first: its title starts with "Start here" (the backend's `start_here`). */
function isStartHere(plan) {
  return plan?.start_here === true
}

/**
 * The Plans tab's sections: the demos first (the one to start with on top), then the person's plans by set, then the
 * plans written from documents (0.6.0 `imported_from`: `roko plan import --mori`), which read as documents first.
 */
function sectionPlans(plans) {
  const demos = plans.filter(isDemoPlan)
  const imported = plans.filter(plan => !isDemoPlan(plan) && isRecord(plan.imported_from))
  const own = plans.filter(plan => !isDemoPlan(plan) && !isRecord(plan.imported_from))
  // Top-level plans first, then each set in roko's order.
  const sets = [...new Set(own.map(plan => text(plan.group)))].sort((a, b) => Number(Boolean(a)) - Number(Boolean(b)))
  // Imports by where they came from: `roko plan import --mori` gives "From mori".
  const kinds = [...new Set(imported.map(plan => clip(plan.imported_from.kind, 16) || 'docs'))]

  return [
    ['Demos', [...demos.filter(isStartHere), ...demos.filter(plan => !isStartHere(plan))]],
    ...sets.map(set => [set || (demos.length || imported.length ? 'Your plans' : 'Plans'), own.filter(plan => text(plan.group) === set)]),
    ...kinds.map(kind => [`From ${kind}`, imported.filter(plan => (clip(plan.imported_from.kind, 16) || 'docs') === kind)])
  ].filter(([, rows]) => rows.length)
}

/**
 * Whether a run ran one of roko's demos, from the plan list (a run's card does not say): true, false, or null
 * while the list loads. A list that fails to load counts as no demo.
 */
function useDemoRun(run, enabled = true) {
  const planId = run?.kind === 'plan' ? text(run.plan_id) : ''
  const plans = usePlans(enabled && validId(planId))

  if (!validId(planId)) {
    return false
  }

  if (!plans.data) {
    return plans.isError || !enabled ? false : null
  }

  const rows = list(plans.data).filter(isRecord)

  return rows.some(plan => plan.id === planId && isDemoPlan(plan))
}

/** Where a demo run's Merge key would be: its output stays on the run's branch. */
function DemoOutputNote({ compact }) {
  return h(
    'span',
    { className: 'roko-merge-blocked', 'data-testid': 'demo-output' },
    h(
      Tip,
      { label: 'A demo’s output is a showcase. Merged into your branch it is clutter, and a later run of the demo would find its check already passing and have nothing new to show.' },
      h('span', { className: 'roko-merge-why', tabIndex: 0 }, h(Codicon, { name: 'beaker', size: '0.75rem' }), compact ? 'demo output' : 'Demo output: it stays on its run branch')
    )
  )
}

// -- 0.8: the build, a long piece of work's phases in order (round v7, #3) ------------------------------------

const MOVING = new Set(['running', 'queued', 'writing'])
/** The build's phases (GET /build): two or more make a build, and its tab. */
function buildPhases(build) {
  return list(build?.phases).filter(p => isRecord(p) && num(p.n) !== null)
}

/** GET /build: polled every 3 s while a phase moves or a receipt or a kept count is still to read, else each minute. */
function useBuild() {
  const project = useValue($project)

  return useQuery({
    queryFn: () => call(forProject('/build', project)),
    queryKey: projectKey(KEYS.build, project),
    refetchInterval: query => (buildPhases(query.state.data).some(p => MOVING.has(p.state)) || list(query.state.data?.receipt?.unread).length || list(query.state.data?.unread_writings).length ? pollMs(RUN_MS) : 60_000),
    retry: false,
    staleTime: 2_000
  })
}

/**
 * The project's build: the glass head (its cost in bone, phases, tasks, runs, time, the top-rung comparison), a pad a
 * phase in order, and what it waits on. Runs whose receipt it lacks are opened in the background, one at a time.
 */
// --- Plans (design system §5.1, mockup after-plans): the build's head and its phases, then every plan, a line each

/** Plans: the plan picked, on its own page; else the build (when the project's plans are its phases) and every plan. */
function PlansPage() {
  const selected = useValue($plan)
  const plans = usePlans()
  const row = validId(selected) ? list(plans.data).find(p => isRecord(p) && p.id === selected) : null

  if (validId(selected)) {
    return h(
      'div',
      { className: 'rk-runpage-wrap' },
      h('nav', { 'aria-label': 'Where you are', className: 'rk-crumb' }, h('button', { 'data-testid': 'crumb-plans', onClick: () => goPlans(), type: 'button' }, 'Plans'), ' › ', h('b', null, clip(text(row?.title) || 'this plan', 80))),
      h(PlanDetail, { key: selected, planId: selected })
    )
  }

  return h('div', { className: 'rk-home', 'data-testid': 'plans-home' }, h(BuildHead, null), h(PlanLines, { query: plans }))
}

/** Back to Plans: no plan picked. */
function goPlans() {
  $plan.set(null)
  $tab.set('plans')
  replaceView({ tab: 'plans' })
}

/** Every plan, a line each, in their sections (demos last); a line opens the plan's page. */
function PlanLines({ query }) {
  const { canAct } = useLimits()
  const plans = list(query.data).filter(plan => isRecord(plan) && validId(plan.id))

  if (query.isLoading) {
    return h(Spinner, { label: 'Loading plans…' })
  }

  if (!plans.length) {
    return query.error
      ? h(ErrorNote, { error: query.error, onRetry: () => void query.refetch() })
      : h(
          'div',
          { className: 'roko-stack' },
          h(Empty, { icon: 'list-tree', title: 'No plans yet' }, 'A plan breaks a larger request into checked tasks you can read before anything runs.'),
          canAct ? h('div', { className: 'roko-center' }, h(Key, { onClick: () => openComposer({ mode: 'plan' }), size: 's', tone: 'primary' }, 'plan something')) : null
        )
  }

  return h(
    'section',
    { 'aria-label': 'Plans', className: 'rk-home-sec' },
    h('h3', { className: 'rk-home-h' }, 'Plans'),
    query.error ? h(ErrorNote, { compact: true, error: query.error, onRetry: () => void query.refetch() }) : null,
    h(
      'div',
      { 'aria-label': 'roko plans', className: 'rk-lines', role: 'list' },
      sectionPlans(plans).flatMap(([name, rows], i, all) => [
        all.length > 1 ? h('div', { className: 'rk-lines-sec', key: `s:${name}`, role: 'presentation' }, name) : null,
        ...rows.map(plan => h(PlanLine, { key: plan.id, plan }))
      ])
    )
  )
}

/** A plan as a line: its title, its state in a word, its tasks done as a strip and a count, and the demo to start with. */
function PlanLine({ plan }) {
  const total = num(plan.task_count) ?? 0
  const done = Math.min(total, num(plan.tasks_done) ?? 0)
  const demo = isDemoPlan(plan)
  // roko's states for a plan, in the design system's words; a demo's `fixture` is roko's marker, not news.
  const word = { done: 'done', draft: 'draft', fixture: '', ready: 'ready to run', running: 'running' }[text(plan.status)] ?? text(plan.status)
  const state = plan.status === 'done' ? 'pass' : plan.status === 'running' ? 'live' : 'wait'

  return h(
    'button',
    {
      'aria-label': `${text(plan.title) || 'a plan'}${word && !(demo && plan.status === 'fixture') ? `: ${word}` : ''}`,
      className: 'rk-line rk-planline',
      'data-state': state,
      'data-testid': `plan-line-${plan.id}`,
      onClick: () => {
        $plan.set(plan.id)
        replaceView({ plan: plan.id })
      },
      role: 'listitem',
      type: 'button'
    },
    h('span', { 'aria-hidden': 'true', className: 'rk-line-glyph' }, plan.status === 'done' ? '✓' : demo ? '◇' : '▤'),
    h(
      'span',
      { className: 'rk-line-title' },
      text(plan.title) || 'a plan',
      word && !(demo && plan.status === 'fixture') && plan.status !== 'done' ? h('small', null, word) : null,
      isStartHere(plan) ? h('span', { className: 'rk-tag', 'data-channel': 'you' }, 'start here') : null
    ),
    total ? h('span', { 'aria-hidden': 'true', className: 'rk-rc-strip' }, h('span', null, Array.from({ length: Math.min(total, 24) }, (_, i) => h('i', { 'data-state': i < done ? 'pass' : 'pending', key: i })))) : h('span', null),
    h('span', { className: 'rk-line-fig' }, total ? `${done}/${total} tasks` : ''),
    h('span', { className: 'rk-line-when' }, '')
  )
}

/** A phase's number as the design system says it: 0, 2.1; "Phase 2" in a sentence. */
const phaseNo = p => String(num(p?.n) ?? '?')
const phaseName = p => `Phase ${phaseNo(p)}`
/** A phase's state in words, and its light (design system §6.2). */
const PHASE_WORD = {
  merged: ['merged by hand', 'pass'],
  passed: ['passed', 'pass'],
  queued: ['waiting', 'live'],
  running: ['running', 'live'],
  specified: ['not planned yet', 'off'],
  stopped: ['stopped', 'stop'],
  unverified: ['not checked', 'stop'],
  writing: ['writing the plan', 'live'],
  written: ['plan written', 'off']
}

/**
 * A long piece of work's head (mockup after-plans): its name, its phases' readings on the glass, the one thing to do
 * next, a pad a phase; what it saved and its figures by phase folded. Nothing when the project has no phases.
 */
function BuildHead() {
  const query = useBuild()
  const build = isRecord(query.data) ? query.data : null
  const phases = buildPhases(build)
  // Runs whose receipt the build lacks, then plan writings whose kept count it lacks: one at a time, in the background.
  const unread = text(list(build?.receipt?.unread)[0]) || text(list(build?.unread_writings)[0])

  useEffect(() => {
    if (validId(unread)) {
      void queryClient.fetchQuery({ queryFn: () => fetchRunCard(unread), queryKey: KEYS.run(unread), staleTime: 0 }).catch(() => null)
    }
  }, [unread, query.dataUpdatedAt])

  if (phases.length < 2) {
    return null
  }

  const t = isRecord(build.totals) ? build.totals : {}
  const live = phases.find(p => MOVING.has(p.state))
  const passed = num(t.passed) ?? phases.filter(p => p.state === 'passed' || p.state === 'merged').length
  const total = num(t.phases) ?? phases.length
  const name = text(build.project?.name) || 'this project'
  const receipt = isRecord(build.receipt) ? build.receipt : null
  // The receipt in a few words: what the passed phases would have cost on the strongest model.
  const saved = receipt && num(receipt.ratio) > 1 && text(receipt.top_rung) ? `≈ ${num(receipt.ratio).toFixed(1)}× less than ${clip(receipt.top_rung, 24)}` : ''
  const cell = (label, reading, note, testId) => h('div', { className: 'rk-rc-cell', 'data-testid': testId }, h('span', { className: 'rk-rc-label' }, label), reading, note ?? null)
  const chart = list(build.chart).filter(isRecord)
  // Wow 1, the reel: each passed phase's own UI shot, when 2 or more (then not on its pad).
  const reel = phases.filter(p => isRecord(p.shot))

  return h(
    'div',
    { className: 'rk-build', 'data-testid': 'build' },
    h(
      'header',
      { className: 'rk-build-title', 'data-testid': 'build-head' },
      h('h2', null, `${name.charAt(0).toUpperCase()}${name.slice(1)}`),
      h('p', null, `${plural(total, 'phase')}, built one at a time. Each phase is a plan: tasks with checks, run under a cap.`),
      build.reachable === false ? h('p', { className: 'rk-build-note' }, 'roko did not answer: the phases come from the specs and the runs Hermes logged.') : null
    ),
    h(
      Well,
      { className: 'rk-rc-glass', testId: 'build-glass' },
      cell(
        'phases',
        h(Dots, { label: `${passed} of ${plural(total, 'phase')} passed`, size: 'L', tone: passed === total ? 'pass' : live ? 'live' : undefined, value: `${passed}/${total}` }),
        h('span', { 'aria-hidden': 'true', className: 'rk-rc-strip' }, h('span', null, phases.slice(0, 24).map(p => h('i', { 'data-state': { live: 'live', pass: 'pass', stop: 'stopped' }[(PHASE_WORD[p.state] ?? [])[1]] ?? 'pending', key: p.n })))),
        'build-phases'
      ),
      cell('tasks', h(Dots, { label: `${num(t.tasks_passed) ?? 0} of ${plural(num(t.tasks_total) ?? 0, 'task')} passed`, size: 'L', value: `${num(t.tasks_passed) ?? 0}/${num(t.tasks_total) ?? 0}` }), null, 'build-tasks'),
      cell('time', h(Dots, { label: `${duration(t.wall_ms ?? 0)} in all`, size: 'L', value: glassTime(num(t.wall_ms) ?? 0) }), h('span', { className: 'rk-rc-note' }, plural(num(t.runs) ?? 0, 'run')), 'build-time'),
      cell('spent', h(Dots, { label: `${money(t.cost_usd)} spent on the build`, size: 'L', value: money(num(t.cost_usd) ?? 0) }), saved ? h('span', { className: 'rk-rc-note', title: text(receipt.words) || undefined }, saved) : null, 'build-spend')
    ),
    h(BuildNext, { next: isRecord(build.next) ? build.next : null, phases }),
    h('h3', { className: 'rk-home-h' }, 'Phases'),
    h('div', { 'aria-label': 'phases in order', className: 'rk-song', 'data-testid': 'build-song', role: 'list' }, phases.map(p => h(PhasePad, { key: p.n, next: build.next?.n === p.n, phase: p, shot: reel.length < 2 }))),
    reel.length > 1 ? h('div', { className: 'rk-reel', 'data-testid': 'build-reel' }, reel.map(p => h('figure', { key: p.n }, h(PadShot, { phase: p }), h('figcaption', { className: 'rk-phase-meta' }, `${phaseName(p)} · ${text(p.name)}`, h('br'), `${money(p.cost_usd)} · ${duration(p.wall_ms)}`)))) : null,
    h(
      'div',
      { className: 'rk-folds' },
      receipt || num(t.writing_usd) || num(t.outside_usd)
        ? h(
            Fold,
            { name: 'build-cost', title: 'what the build cost' },
            num(t.writing_usd) || num(t.outside_usd)
              ? h('p', { className: 'rk-build-incl', 'data-testid': 'build-incl' }, [`${money(t.cost_usd)} in all`, num(t.writing_usd) ? `incl. ${money(t.writing_usd)} plan writing` : '', num(t.outside_usd) ? `${money(t.outside_usd)} outside the phases` : ''].filter(Boolean).join(' · '))
              : null,
            text(receipt?.words) ? h('p', { className: 'rk-build-receipt', 'data-testid': 'build-receipt' }, text(receipt.words)) : null,
            text(receipt?.words) && text(receipt.basis) ? h('p', { className: 'rk-build-basis', 'data-testid': 'build-basis' }, text(receipt.basis)) : null,
            text(build.ladder_line) ? h('p', { className: 'rk-build-basis', 'data-testid': 'build-ladder' }, text(build.ladder_line)) : null
          )
        : null,
      chart.length
        ? h(
            Fold,
            { name: 'build-chart', title: 'phase by phase' },
            // Wow 2: the backend's series by phase, a spark and its range each, every phase's figure in its words.
            h('div', { className: 'rk-build-cells' }, chart.map((s, i) => h('span', { className: 'rk-build-cell', key: i }, h('i', null, text(s.label)), h('span', { title: text(s.words) }, h(Spark, { grid: true, height: 20, label: text(s.words), tone: text(s.tone), values: list(s.values), width: 100 }), h('small', null, text(s.range))))))
          )
        : null
    )
  )
}

/** A phase's pad (design system §4.7, mockup after-plans): its number and light, its name, its tasks, time and spend. */
function PhasePad({ phase, next, shot }) {
  const [word, tone] = PHASE_WORD[phase.state] ?? [text(phase.state), 'off']
  const total = num(phase.tasks?.total) ?? 0
  const passed = num(phase.tasks?.passed) ?? 0
  const target = validId(phase.run_id) ? { run: phase.run_id } : validId(phase.writing_id) ? { run: phase.writing_id } : validId(phase.plan_id) ? { plan: phase.plan_id, tab: 'plans' } : null
  const writing = num(phase.writing_usd)
  const spent = num(phase.cost_usd) === null ? '' : writing && writing >= phase.cost_usd - 0.005 ? `${money(phase.cost_usd)} plan writing` : `${money(phase.cost_usd)}${writing ? ` · incl. ${money(writing)} plan writing` : ''}`
  const tasks = total ? (passed === total || !MOVING.has(phase.state) ? (passed === total ? plural(total, 'task') : `${passed} of ${plural(total, 'task')}`) : `${passed} of ${plural(total, 'task')}`) : ''
  const meta = [tasks, num(phase.wall_ms) ? duration(phase.wall_ms) : '', spent, num(phase.runs) > 1 ? plural(phase.runs, 'run') : ''].filter(Boolean)
  const cover = isRecord(phase.coverage) ? phase.coverage : null
  const roko = isRecord(phase.roko_coverage) ? phase.roko_coverage : null

  return h(
    target ? 'button' : 'div',
    {
      'aria-label': `${phaseName(phase)} ${text(phase.name)}: ${word}${total ? `, ${passed} of ${total} tasks` : ''}`,
      className: 'rk-phase',
      'data-next': next ? 'true' : undefined,
      'data-state': phase.state,
      'data-testid': `phase-${phase.n}`,
      onClick: target ? () => openRoko(target) : undefined,
      role: 'listitem',
      title: text(phase.goal) || undefined,
      type: target ? 'button' : undefined
    },
    h('span', { className: 'rk-phase-top' }, h('b', null, phaseNo(phase)), h(LED, { blink: MOVING.has(phase.state) ? 'slow' : undefined, size: 's', tone: tone === 'stop' ? 'off' : tone })),
    h('span', { className: 'rk-phase-name' }, clip(text(phase.name), 40)),
    h('span', { className: 'rk-phase-word', 'data-tone': tone }, phase.ended ? `${word} · ${text(phase.ended)}` : word),
    meta.length ? h('span', { className: 'rk-phase-meta' }, meta.join(' · ')) : null,
    (cover || roko) && tone !== 'pass' ? h(PhaseCover, { cover, cross: phase.coverage_agrees === false, n: phase.n, roko }) : null,
    shot && isRecord(phase.shot) ? h(PadShot, { phase }) : null
  )
}

/** A passed phase's first UI shot (phase 4 prep C), for its pad or the reel: the backend's bytes, scaled here. */
function PadShot({ phase }) {
  const shot = useShot(text(phase.shot.run_id), text(phase.shot.path))

  return isRecord(shot.data) ? h('img', { alt: `${phaseName(phase)}: ${text(phase.shot.path).split('/').pop()}`, className: 'rk-phase-shot', src: dataUrl(shot.data) }) : null
}

/**
 * How many of a phase's spec checks its plan keeps: roko's own count (honest since bug-72dc0d) when its plan writing
 * said, else the plugin's count of the spec's commands in the plan's checks, and "≠ N/M run" in orange where the two
 * disagree. It breaks only between its parts (P-32).
 */
function PhaseCover({ cover, roko, cross, n }) {
  const words = roko ? [`checks ${num(roko.kept)}/${num(roko.total)} kept`, 'by roko'] : [`checks ${num(cover.covered)}/${num(cover.total)}`, 'of its spec']
  const short = (cover && num(cover.covered) < num(cover.total)) || (roko && num(roko.kept) < num(roko.total))
  const notRun = cover && list(cover.missing).length ? `not run: ${list(cover.missing).map(text).join(', ')}` : ''

  return h(
    'span',
    {
      className: 'rk-phase-cover',
      'data-cross': cross ? 'true' : undefined,
      'data-short': short ? 'true' : undefined,
      'data-testid': `phase-cover-${n}`,
      title: [cross ? `roko counts ${num(roko.kept)} of ${num(roko.total)} kept; the plugin finds ${num(cover.covered)} of the spec’s ${num(cover.total)} commands in the plan’s checks` : '', notRun].filter(Boolean).join(' · ') || undefined
    },
    h('span', null, words[0]),
    ' ',
    h('span', null, words[1]),
    cross ? h(Fragment, null, ' ', h('span', null, `≠ ${num(cover.covered)}/${num(cover.total)} run`)) : null
  )
}

/**
 * What the build waits on, in a sentence, and the one key that moves it (mockup after-plans: NEXT): plan a phase that
 * has only its spec, run a written one, write a short one again, resume a stopped one, or watch the one going.
 */
function BuildNext({ next, phases }) {
  const { canAct } = useLimits()
  const phase = next ? phases.find(p => p.n === next.n) : null

  if (!phase) {
    return phases.every(p => p.state === 'passed' || p.state === 'merged') ? h('div', { className: 'rk-build-next', 'data-testid': 'build-next' }, h('b', null, 'DONE'), h('span', null, 'Every phase passed.')) : null
  }

  const code = phaseName(phase)
  const name = text(phase.name)
  // P-33: with several plans for the phase, which one this is (its title says).
  const which = num(next.plans) > 1 ? ` (${next.newest ? 'the newest' : 'one'} of ${num(next.plans)} plans)` : ''
  // roko's own count leads; the plugin's is its cross-check (bug-72dc0d).
  const rk = num(next.roko_total) ? [num(next.roko_kept), num(next.roko_total)] : null
  const stated = rk ? rk[1] : num(next.total)
  const kept = rk ? rk[0] : num(next.covered)
  const agree = rk && num(next.total) && rk[1] - rk[0] === num(next.total) - num(next.covered)
  const missing = list(next.missing).map(text).filter(Boolean)
  // Phase 2's stills: its tasks that failed even on the strongest model, which roko says to split or replan.
  const out = list(next.exhausted).map(text).filter(Boolean)
  const outNames = out.length > 4 ? `${out.length} tasks` : listWords(out.map(taskName))
  const them = out.length > 1 ? 'them' : 'it'
  const what = {
    resume: `${code} stopped${phase.ended ? ` (${text(phase.ended)})` : ''}. ${out.length ? `${outNames} failed even on the strongest model, so roko says to split or replan ${them}; then resume` : 'Resume'} it, and only what is left runs.`,
    rewrite: `${code}’s plan leaves out ${stated - kept} of its spec’s ${stated} checks: write it again.`,
    run: `${code} · ${name} is written${stated ? `: its tasks keep ${kept === stated ? `all ${stated}` : `${kept} of ${stated}`} of its spec’s checks` : ''}.`,
    wait: phase.state === 'writing' ? `roko is writing ${code}’s plan.` : `${code} runs now.`,
    write: `${code} · ${name} has its spec and no plan yet.`
  }[next.do]
  // The details behind the sentence, on hover: the plan's id, both counts, the spec's path.
  const detail = [text(next.plan_id) ? `plan ${text(next.plan_id)}${which}` : '', rk && num(next.total) && !agree ? `roko counts ${rk[0]} of ${rk[1]} kept; the plugin ${num(next.covered)} of ${num(next.total)}` : '', text(phase.spec) ? `spec ${text(phase.spec)}` : '', missing.length ? `not run: ${missing.join(', ')}` : ''].filter(Boolean).join(' · ')
  // The plan's own title says its phase as roko's build reads it: "P2 · Name".
  const title = `P${phaseNo(phase)} · ${name.charAt(0).toUpperCase()}${name.slice(1)}`
  // P-6: roko reads the spec by its path; the request adds only what the last plan missed (the build names 20 at most).
  const more = num(next.total) - num(next.covered) - missing.length
  const added =
    next.do === 'rewrite'
      ? `The plan ${text(next.plan_id)} ran ${num(next.covered)} of this spec’s ${num(next.total)} acceptance checks${missing.length ? ` (${missing.join(', ')}${more > 0 ? ` and ${more} more` : ''} not run)` : ''}. Make each one a verify step whose command is exactly the spec’s command, with nothing around it.`
      : ''
  const key =
    (next.do === 'write' || next.do === 'rewrite') && canAct
      ? h(Key, { onClick: () => openComposer({ mode: 'plan', prompt: added, spec: text(phase.spec) || null, title }), size: 's', testId: 'build-write', tone: 'primary' }, next.do === 'rewrite' ? `plan ${code.toLowerCase()} again` : `plan ${code.toLowerCase()}`)
      : next.do === 'run' && canAct && validId(next.plan_id)
        ? h(Key, { onClick: () => openRoko({ plan: next.plan_id, tab: 'plans' }), size: 's', testId: 'build-run', tone: 'primary' }, `run ${code.toLowerCase()}`)
        : validId(next.run_id)
          ? h(Key, { onClick: () => openRoko({ run: next.run_id }), size: 's', testId: 'build-open' }, next.do === 'resume' ? 'open its run' : 'watch it')
          : null
  const again =
    next.do === 'resume' && out.length && canAct
      ? h(
          Key,
          {
            onClick: () => openComposer({ mode: 'plan', prompt: `The plan ${text(next.plan_id)} stopped: ${listWords(out)} failed ${out.length > 1 ? 'their' : 'its'} checks on the ladder’s last rung. Split ${them} into smaller tasks, or plan ${them} another way.`, spec: text(phase.spec) || null, title }),
            size: 's',
            testId: 'build-write'
          },
          `plan ${code.toLowerCase()} again`
        )
      : null

  return h(
    'div',
    { className: 'rk-build-next', 'data-testid': 'build-next' },
    h('b', null, 'NEXT'),
    h('span', { className: 'rk-build-next-words', title: detail || undefined }, text(next.words) || what || '', phase.goal ? h('small', { className: 'rk-build-goal' }, clip(text(phase.goal), 180)) : null),
    key || again ? h('span', { className: 'rk-rc-keys' }, again, key) : null
  )
}

// --- Setup and updates: what keeps roko from working here, each with its one fix
// (`setup.problems` on /overview and /health), and the restart Hermes needs
// after an update (docs/updating.md)

const SEVERITY_RANK = { block: 0, warn: 1 }
/** When only this page is old: a window reload (⌘R) makes Hermes copy the installed page and load it. */
const PAGE_STEPS = ['Reload the window: press ⌘R, or the key here.', 'If this stays, quit Hermes with ⌘Q and open it again.']
/** Without the install state on the overview (an older backend), /health is asked this often instead. */
const HEALTH_POLL_MS = 60_000

/** Where a fix is explained: the backend names a page of the plugin's docs/ folder (or a full link). */
function docsPath(value) {
  const docs = text(value)

  return !docs ? null : docs.startsWith('docs/') || /^https?:/.test(docs) ? docs : `docs/${docs}`
}

/** A setup problem from the backend, checked: `{id, severity, title, detail, fix, steps, parts}`, or null. */
function readProblem(value) {
  if (!isRecord(value) || !text(value.id) || !text(value.title)) {
    return null
  }

  const fix = isRecord(value.fix) ? value.fix : {}
  const parts = isRecord(value.parts) ? value.parts : null

  return {
    detail: text(value.detail),
    fix: {
      action: text(fix.action) || null,
      command: text(fix.command) || null,
      docs: docsPath(fix.docs),
      kind: text(fix.kind) || 'docs',
      label: text(fix.label) || 'fix',
      // 0.7: the project an action fix is for (`setup-project`), sent with its preview and its apply.
      project: text(fix.project) || null
    },
    id: text(value.id),
    parts: parts ? { backend: parts.backend === true, desktop_copy: parts.desktop_copy === true } : null,
    severity: value.severity === 'block' ? 'block' : 'warn',
    // The backend words a restart for each surface; this is the desktop app.
    steps: list(isRecord(value.steps) ? value.steps.desktop : null).map(step => text(step)).filter(Boolean),
    title: text(value.title)
  }
}

/** Every problem the sources report, the ones that stop new runs first, each id once. */
function problemsOf(...sources) {
  const byId = new Map()

  for (const source of sources) {
    for (const raw of list(isRecord(source) ? source.problems : null)) {
      const problem = readProblem(raw)

      if (problem && !byId.has(problem.id)) {
        byId.set(problem.id, problem)
      }
    }
  }

  return [...byId.values()].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
}

/** -1, 0 or 1 for two dotted versions ('0.4.0' < '0.10.0'), or null when either is not one. */
function compareVersions(a, b) {
  const parse = v => /^(\d+)\.(\d+)\.(\d+)/.exec(text(v))?.slice(1).map(Number) ?? null
  const x = parse(a)
  const y = parse(b)

  if (!x || !y) {
    return null
  }

  const at = x.findIndex((part, i) => part !== y[i])

  return at < 0 ? 0 : x[at] < y[at] ? -1 : 1
}

/**
 * Whether this window runs two versions of roko, and what finishes the update: Hermes imports the backend and copies
 * this page only when it starts or rescans (docs/updating.md). Strongest sign first: the backend's files changed
 * under it (`install.backend_stale`); another `plugin_version`; no `setup` or `install` (an older backend); the app's
 * copy of this page is older (`install.desktop_copy_stale`). Null, or `{key, title, steps, pageOnly}`: `pageOnly`
 * means a rescan fixes it; anything else needs Hermes to quit and start again.
 */
function restartOf(data, health) {
  if (!isRecord(data)) {
    return null
  }

  const healthReply = isRecord(health) ? health : null
  const install = isRecord(data.install) ? data.install : isRecord(healthReply?.install) ? healthReply.install : null
  const backend = text(data.plugin_version) || text(install?.loaded_version)
  const disk = text(install?.disk_version)
  const problem = problemsOf(data.setup, healthReply?.setup).find(p => p.id === 'restart-hermes')
  const steps = problem?.steps.length ? problem.steps : RESTART_STEPS
  const order = compareVersions(backend, VERSION)

  if (install?.backend_stale === true) {
    const title =
      problem?.title ||
      (disk && backend && disk !== backend
        ? `roko ${disk} is installed, but Hermes is still running ${backend}.`
        : 'roko was updated on disk, but Hermes is still running the code it started with.')

    return { key: `backend:${backend}:${disk}`, pageOnly: false, steps, title }
  }

  if (order === -1) {
    return { key: `older:${backend}`, pageOnly: false, steps, title: `roko ${VERSION} is installed, but Hermes is still running ${backend}.` }
  }

  if (order === 1) {
    return {
      key: `page:${backend}`,
      pageOnly: true,
      steps: PAGE_STEPS,
      title: `Hermes runs roko ${backend}, but this page is still ${VERSION}.`
    }
  }

  if (!isRecord(data.setup) && !install && (!healthReply || !isRecord(healthReply.install))) {
    return { key: `predates:${backend}`, pageOnly: false, steps, title: 'Hermes is still running the roko backend it started with, from before this update.' }
  }

  if (install?.desktop_copy_stale === true && disk && disk !== VERSION) {
    return {
      key: `copy:${disk}`,
      pageOnly: true,
      steps: PAGE_STEPS,
      title: problem?.title || `The desktop app still shows roko ${VERSION}; ${disk} is installed.`
    }
  }

  return null
}

/** /health as it came: the doctor's checks, and on a newer backend `install` and `setup` too. */
function useHealthReply(enabled = true, poll = false) {
  const project = useValue($project)

  return useQuery({
    enabled,
    queryFn: () => call(forProject('/health', project)),
    queryKey: projectKey(KEYS.health, project),
    refetchInterval: poll ? HEALTH_POLL_MS : false,
    retry: false,
    staleTime: 30_000
  })
}

/** The setup problems and the restart this window needs, from the overview (and /health when it must). */
function useSetup() {
  const overview = useOverview()
  const data = isRecord(overview.data) ? overview.data : null
  const needHealth = Boolean(data) && !isRecord(data.install)
  const health = useHealthReply(needHealth, needHealth)
  const reply = needHealth && isRecord(health.data) ? health.data : null

  return useMemo(() => {
    const conn = isRecord(data?.connection) ? data.connection : null
    const { none } = projectsOf(data)
    // 0.7: the serve banner says what the serve's rows would, as the restart banner does for restart-hermes. A
    // project roko is not set up in (the backend's project-needs-setup row: no roko.toml) shows that row instead:
    // setting roko up there starts its serve too.
    const serve = serveOf(data)
    const listed = data ? problemsOf(data.setup, reply?.setup) : []
    const needsSetup = listed.some(p => p.id === 'project-needs-setup')
    const banner = serve && SERVE_BANNER.has(serve.state) && !needsSetup && !none ? serve : null
    const quiet = Boolean(banner) || needsSetup || none
    const covered = id => quiet && (SERVE_ROWS.has(id) || (id === 'roko-serve-outdated' && banner?.state === 'outdated'))
    // The overview asks roko every time; the backend's own look at setup can lag by up to 30 s (and an older backend
    // has none). So roko-unreachable follows the overview both ways: added at once when roko stops answering, and
    // gone at once when it answers again.
    const problems = listed.filter(p => !(conn?.reachable === true && p.id === 'roko-unreachable') && !covered(p.id))

    if (conn && conn.reachable === false && !quiet && !problems.some(p => p.id === 'roko-unreachable')) {
      problems.unshift(unreachableProblem(conn))
    }

    return {
      blocking: none ? pickProblem() : (problems.find(p => p.severity === 'block') ?? (banner ? serveProblem(banner) : null)),
      pick: none,
      problems,
      restart: restartOf(data, reply),
      serve: banner
    }
  }, [data, reply])
}

/** What "no project yet" stands for where a start waits on it (Run plan…, the chip): a blocking problem. */
function pickProblem() {
  return { ...readProblem({ fix: { kind: 'pick', label: 'pick a project' }, id: 'pick-project', severity: 'block', title: 'Pick the project roko works in first.' }), pick: true }
}

/**
 * The backend's rows about a serve that does not run; the serve banner says them instead (BRIEF B7). A start that
 * failed for want of a model key (roko's `not_initialized`: no-model-provider) is the failed banner, with the hint's
 * command to copy.
 */
const SERVE_ROWS = new Set(['roko-unreachable', 'roko-not-found', 'roko-too-old', 'no-model-provider'])

/** A serve's state in a sentence. */
function serveTitle(serve) {
  const name = serve.name || 'this project'

  return {
    failed: `roko serve did not start for ${name}.`,
    not_found: 'Hermes cannot find roko on this machine.',
    outdated: `The roko for ${name} is too old for Hermes.`,
    remote: `roko serve for ${name} runs on another machine.`,
    running: `roko serve runs for ${name}.`,
    starting: `roko serve is starting for ${name}…`,
    stopped: `roko serve is not running for ${name}.`
  }[serve.state]
}

/** What a serve banner stands for where a start waits on it (the composer, Run plan…): a blocking problem. */
function serveProblem(serve) {
  return { ...readProblem({ fix: { kind: 'serve', label: 'roko serve' }, id: 'roko-serve', severity: 'block', title: serveTitle(serve) }), serve }
}

/**
 * roko serve does not answer: the problem a newer backend names `roko-unreachable`, from the overview alone, in the
 * backend's words. Its fix is the start command from the connection's hint (which names the real workspace), else
 * the docs.
 */
function unreachableProblem(conn) {
  const err = isRecord(conn.error) ? conn.error : {}
  // An older backend, or no workdir set, says `--workdir WORKSPACE`: a copy key for a placeholder would mislead.
  const said = /`(roko serve\b[^`]*)`/.exec(text(err.hint))?.[1] ?? null
  const command = said && !/\bWORKSPACE\b/.test(said) ? said : null
  const docs = 'troubleshooting.md#roko-serve-is-not-reachable'

  return readProblem({
    detail: 'Nothing roko does works from Hermes until roko serve answers. Start it in your roko workspace.',
    fix: command ? { action: null, command, docs, kind: 'command', label: 'start roko serve' } : { action: null, command: null, docs, kind: 'docs', label: 'how to start it' },
    id: 'roko-unreachable',
    severity: 'block',
    title: `Hermes cannot reach roko serve${text(conn.url) ? ` at ${text(conn.url)}` : ''}.`
  })
}

function refreshSetup() {
  void queryClient.invalidateQueries({ queryKey: KEYS.overview })
  void queryClient.invalidateQueries({ queryKey: KEYS.health })
}

/**
 * Hermes' own relaunch, the one its About page's "Restart Hermes" key uses: it stops the backend, quits and
 * opens the app again. It is not part of the plugin SDK (whose actions leave app lifecycle to the person), so
 * the key that calls it is the person's own click, behind a confirm, and only where the bridge has it.
 */
function relaunchDoor() {
  const bridge = typeof window === 'undefined' ? null : window.hermesDesktop
  const relaunch = bridge?.relaunchApp

  return typeof relaunch === 'function' ? () => relaunch.call(bridge) : null
}

/** The window reload ⌘R does: Hermes copies this page again on the way back, then loads the copy. */
function reloadWindow() {
  window.location.reload()
}

/** The one key that finishes an update here: reload the window when only this page is old, else restart. */
function RestartKey({ pageOnly }) {
  const [confirming, setConfirming] = useState(false)
  const relaunch = relaunchDoor()

  if (pageOnly) {
    return h(Key, { onClick: reloadWindow, size: 's', testId: 'reload-window', tone: 'primary' }, h(Codicon, { name: 'refresh', size: '0.75rem' }), 'reload window')
  }

  if (!relaunch) {
    return null
  }

  return h(
    Fragment,
    null,
    h(Key, { onClick: () => setConfirming(true), size: 's', testId: 'restart-hermes', tone: 'primary' }, h(Codicon, { name: 'debug-restart', size: '0.75rem' }), 'restart hermes'),
    h(ConfirmDialog, {
      confirmLabel: 'Restart Hermes',
      description: 'Hermes quits and opens again with the roko that is installed. A chat that is answering right now stops there; your chats and roko’s runs are kept.',
      onClose: () => setConfirming(false),
      onConfirm: async () => {
        await relaunch()
      },
      open: confirming,
      title: 'Restart Hermes now?'
    })
  )
}

/** A key that copies a command; the command itself is shown beside it. */
function CopyKey({ value, label = 'copy', testId }) {
  const [state, setState] = useState('idle')
  const timer = useRef(null)

  useEffect(() => () => clearTimeout(timer.current), [])

  const copy = async () => {
    const ok = await writeClipboard(value)

    setState(ok ? 'copied' : 'failed')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1_600)
  }

  return h(
    Key,
    { 'aria-label': `${label}: ${value}`, onClick: () => void copy(), size: 's', testId },
    h(Codicon, { name: state === 'copied' ? 'check' : 'copy', size: '0.75rem' }),
    state === 'copied' ? 'copied' : state === 'failed' ? 'copy failed' : label
  )
}

/** A line of a fix's preview: a diff's added and removed lines get their channel colours. */
function previewKind(line) {
  if (line.startsWith('+++') || line.startsWith('---')) {
    return 'file'
  }

  if (line.startsWith('@@')) {
    return 'hunk'
  }

  return line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : undefined
}

/** What a fix would change, on the glass. Untrusted text: text nodes only. */
function PreviewText({ value }) {
  return h(
    'pre',
    { className: 'roko-pre rk-fix-preview', 'data-testid': 'fix-preview' },
    text(value)
      .split('\n')
      .map((line, i) => h('span', { 'data-line': previewKind(line), key: i }, `${line}\n`))
  )
}

/** A fix the backend could not even look at: an older backend has no fix route at all. */
function FixFailed({ error }) {
  if (error instanceof RokoError && error.kind === 'backend') {
    return h(
      'div',
      { className: 'rk-fix-note', role: 'alert' },
      'This Hermes still runs the roko backend from before your update, which cannot do this. ',
      RESTART_STEPS.join(' '),
      ' Then try again.'
    )
  }

  return h(ErrorNote, { compact: true, error })
}

/** How long the outcome of an applied fix stays on the page once its problem has gone from the list. */
const FIX_DONE_MS = 15 * 60_000
/**
 * The last fix the person applied: `{id, reply, at}`. Applying it usually clears its problem, and the row with
 * it, at the next look; the outcome (what changed, what is left, such as committing roko.toml) stays here.
 */
const $fixDone = atom(null)

/**
 * What an applied fix did and what is left to do (POST /setup/fix's reply). Green when roko now accepts runs from
 * Hermes; orange when the change took but roko still refuses them (`ready: false`): the next step says why.
 */
function FixOutcome({ reply, testId, onClose }) {
  const next = text(reply.next)
  const said = text(reply.message) || (typeof reply.done === 'string' ? reply.done : '') || 'Done.'
  const ready = reply.ready !== false
  // make ready changed a roko.toml git tracks: committing it comes next, and the note offers the key Merge has
  // (the same commit-roko-toml fix, previewed, then applied), since a demo run has no Merge to offer it.
  const commit =
    onClose && text(reply.action) === 'workspace-chat-ready' && /\bcommit roko\.toml\b/.test(next)
      ? readProblem({ fix: { action: 'commit-roko-toml', command: null, docs: null, kind: 'action', label: 'commit roko.toml', project: text(reply.project) || null }, id: 'commit-roko-toml', severity: 'warn', title: 'commit roko.toml' })
      : null

  return h(
    'div',
    { className: onClose ? 'rk-fix-done rk-fix-done-note' : 'rk-fix-done', 'data-ready': ready ? 'true' : 'false', 'data-testid': testId, role: 'status' },
    h(LED, { label: ready ? 'done' : 'done, but not ready yet', tone: ready ? 'pass' : 'you' }),
    h(
      'span',
      { className: 'rk-fix-done-text' },
      h('span', null, said),
      next && !said.includes(next) ? h('span', { className: 'rk-fix-next' }, h('b', null, 'next'), ` ${next}`) : null,
      commit ? h('span', { className: 'rk-fix-commit' }, h(FixControl, { onDone: () => void queryClient.invalidateQueries({ queryKey: [ID, 'merge'] }), problem: commit })) : null
    ),
    onClose ? h(Key, { 'aria-label': 'Dismiss', onClick: onClose, size: 's', testId: `${testId}-close` }, h(Codicon, { name: 'close', size: '0.7rem' })) : null
  )
}

/** The outcome of the fix just applied, once its problem has left `problems` (else its row says it). */
function FixDoneNote({ problems }) {
  const done = useValue($fixDone)

  if (!done || Date.now() - done.at > FIX_DONE_MS || problems.some(p => p.id === done.id)) {
    return null
  }

  return h(FixOutcome, { onClose: () => $fixDone.set(null), reply: done.reply, testId: 'fix-done-note' })
}

/** The fix's ways to do it (`variants`): each with its label, whether it is recommended, and why it is off. */
function fixVariants(reply) {
  return list(reply?.variants)
    .filter(v => isRecord(v) && text(v.id))
    .map(v => ({ available: v.available !== false, id: text(v.id), label: text(v.label) || text(v.id), recommended: v.recommended === true, why: text(v.why) }))
}

/** 0.7's fixes for a project and its roko serve: a summary of what they do, not a diff of a file. */
const SERVE_FIXES = new Set(['setup-project', 'start-serve', 'restart-serve'])
/**
 * How long an applied fix may take: setting a project up runs `roko init` and waits for its serve to answer (minutes,
 * at worst); a start or restart answers once it began.
 */
const FIX_WAIT_MS = { 'restart-serve': 60_000, 'setup-project': 300_000, 'start-serve': 60_000 }

/**
 * An `action` fix: its key asks the backend what the fix would change (GET /setup/fix) and shows that on the
 * glass, with its way of doing it when there is a choice; a second key applies exactly that preview (POST
 * /setup/fix with its `variant` and `digest`), and the row then says what was done and what is next.
 */
function FixAction({ problem, onDone }) {
  const [state, setState] = useState({ step: 'idle' })
  const action = problem.fix.action
  const project = problem.fix.project
  const serveFix = SERVE_FIXES.has(action)

  const preview = async variant => {
    setState(current => ({ ...current, error: null, step: current.reply ? 'switching' : 'loading' }))

    try {
      const reply = await call(`/setup/fix?action=${enc(action)}${project ? `&project=${enc(project)}` : ''}${variant ? `&variant=${enc(variant)}` : ''}`)

      setState({ reply, step: 'preview' })
    } catch (error) {
      setState(current => (current.reply ? { ...current, error, step: 'preview' } : { error, step: 'failed' }))
    }
  }

  // Apply exactly the preview shown; `force` restarts a serve whose runs it stops, once the person said so.
  const send = async force => {
    const shown = isRecord(state.reply) ? state.reply : {}
    const body = project ? { action, project } : { action }

    if (text(shown.variant)) {
      body.variant = text(shown.variant)
    }

    if (text(shown.digest)) {
      body.digest = text(shown.digest)
    }

    if (force) {
      body.force = true
    }

    // The outcome keeps the project the fix was about (the reply's own, else the card's).
    const reply = { ...(project ? { project } : {}), ...(await call('/setup/fix', { body, method: 'POST', timeoutMs: FIX_WAIT_MS[action] ?? 30_000 })) }

    // 0.7: setting a project up, starting or restarting its serve says how the serve stands now.
    applyServe(reply.serve)
    setState({ reply, step: 'done' })
    $fixDone.set({ at: Date.now(), id: problem.id, reply })
    play('check', true)
    refreshSetup()
    onDone?.(reply)
  }

  const apply = async () => {
    setState(current => ({ ...current, error: null, step: 'applying' }))

    try {
      await send(false)
    } catch (error) {
      // A restart that would stop runs: the backend did nothing; ask, naming them, as the serve keys do.
      const busy = error instanceof RokoError && error.code === 'conflict' ? readServe(error.serve) : null

      setState(current => ({ ...current, confirm: busy ? { action: 'restart', message: error.message, serve: busy } : null, error: busy ? null : error, step: 'preview' }))
    }
  }

  if (state.step === 'done') {
    return h(FixOutcome, { reply: isRecord(state.reply) ? state.reply : {}, testId: `fix-done-${problem.id}` })
  }

  if (state.step === 'preview' || state.step === 'applying' || state.step === 'switching') {
    const reply = isRecord(state.reply) ? state.reply : {}
    const busy = state.step !== 'preview'
    const variants = fixVariants(reply)
    const chosen = text(reply.variant)
    // What the fix does, in the backend's words; setting a project up says what roko init creates even without them
    // (its preview is empty: roko.toml does not exist yet).
    const folder = text(reply.path) || text(project)
    const summary = text(reply.summary) || (action === 'setup-project' ? `roko init writes roko.toml and .roko/ in ${folder.split(/[\\/]/).filter(Boolean).pop() || folder || 'the project'}.` : '')

    return h(
      'div',
      { className: 'rk-fix-panel', 'data-testid': `fix-panel-${problem.id}` },
      text(reply.title) ? h('div', { className: 'rk-fix-title' }, text(reply.title)) : null,
      variants.length > 1
        ? h(
            'div',
            { 'aria-label': 'How to fix it', className: 'rk-keyrow rk-fix-variants', role: 'group' },
            variants.map(v =>
              h(
                Key,
                {
                  'aria-pressed': v.id === chosen ? 'true' : 'false',
                  disabled: busy || !v.available,
                  key: v.id,
                  onClick: () => v.id !== chosen && void preview(v.id),
                  size: 's',
                  testId: `fix-variant-${v.id}`,
                  title: v.available ? v.why || undefined : v.why || 'not available here'
                },
                v.label,
                v.recommended ? h('span', { className: 'rk-tag', 'data-channel': 'pass' }, 'recommended') : null
              )
            )
          )
        : null,
      summary ? h('div', { className: 'rk-fix-summary' }, summary) : null,
      // 0.7's project and serve fixes say what they do in their summary: no file diff, and the path is the project's.
      text(reply.path) ? h('div', { className: 'rk-fix-path' }, serveFix ? 'in ' : 'changes ', h('span', { className: 'roko-mono' }, text(reply.path))) : null,
      text(reply.preview) ? h(PreviewText, { value: reply.preview }) : serveFix ? null : h('div', { className: 'roko-muted' }, 'Nothing in the file changes.'),
      text(reply.note) ? h('div', { className: 'rk-fix-path' }, text(reply.note)) : null,
      state.error ? h(FixFailed, { error: state.error }) : null,
      h(BusyConfirm, { confirm: state.confirm ?? null, onClose: () => setState(current => ({ ...current, confirm: null })), onConfirm: () => send(true) }),
      h(
        'div',
        { className: 'roko-actions roko-actions-start' },
        h(
          Key,
          { disabled: busy, onClick: () => void apply(), size: 's', testId: `fix-apply-${problem.id}`, tone: 'primary' },
          state.step === 'applying' ? h(Spinner, null) : h(Codicon, { name: 'check', size: '0.75rem' }),
          'apply'
        ),
        state.error instanceof RokoError && state.error.code === 'conflict'
          ? h(Key, { disabled: busy, onClick: () => void preview(chosen || null), size: 's' }, 'look again')
          : null,
        h(Key, { disabled: busy, onClick: () => setState({ step: 'idle' }), size: 's' }, 'cancel')
      )
    )
  }

  return h(
    Fragment,
    null,
    h(
      Key,
      { disabled: state.step === 'loading', onClick: () => void preview(null), size: 's', testId: `fix-${problem.id}`, tone: problem.severity === 'block' ? 'primary' : undefined },
      state.step === 'loading' ? h(Spinner, null) : h(Codicon, { name: 'wrench', size: '0.75rem' }),
      problem.fix.label
    ),
    state.step === 'failed' ? h(FixFailed, { error: state.error }) : null
  )
}

/** The steps that finish an update, and the key to the plugins page when a rescan is enough. */
function RestartSteps({ steps, pageOnly }) {
  return h(
    'div',
    { className: 'rk-fix-restart' },
    h('ol', { className: 'rk-fix-steps' }, steps.map((step, i) => h('li', { key: i }, step))),
    h(RestartKey, { pageOnly })
  )
}

/** A problem's one fix: preview then apply, a command to copy, the restart steps, or where the docs say how. */
function FixControl({ problem, onDone }) {
  const fix = problem.fix

  if (fix.kind === 'action' && fix.action) {
    return h(FixAction, { onDone, problem })
  }

  if (fix.kind === 'command' && fix.command) {
    return h(
      'div',
      { className: 'rk-fix-command' },
      h('code', { className: 'rk-fix-cmd' }, fix.command),
      h(CopyKey, { label: fix.label, testId: `fix-copy-${problem.id}`, value: fix.command })
    )
  }

  if (fix.kind === 'restart-hermes') {
    return h(RestartSteps, { pageOnly: problem.parts ? problem.parts.desktop_copy && !problem.parts.backend : false, steps: problem.steps.length ? problem.steps : RESTART_STEPS })
  }

  return fix.docs ? h('span', { className: 'rk-fix-docs' }, 'how: ', h('span', { className: 'roko-mono' }, fix.docs)) : null
}

/** One problem: its light (red when it stops new runs), what is wrong, why it matters, and its fix. */
function ProblemRow({ problem, index, compact }) {
  const block = problem.severity === 'block'

  return h(
    'li',
    { className: 'rk-problem', 'data-severity': problem.severity, 'data-testid': `problem-${problem.id}` },
    index !== undefined ? h('span', { 'aria-hidden': 'true', className: 'rk-problem-n' }, String(index + 1).padStart(2, '0')) : null,
    h(LED, { label: block ? 'stops new runs' : 'worth fixing', tone: block ? 'fail' : 'you' }),
    h(
      'div',
      { className: 'rk-problem-main' },
      h('div', { className: 'rk-problem-title' }, problem.title),
      problem.detail && !compact ? h('div', { className: 'rk-problem-detail' }, problem.detail) : null,
      h('div', { className: 'rk-problem-fix' }, h(FixControl, { problem }))
    )
  )
}

/** One problem on its own, where it stops something: the composer, a plan's run key, a refused start. */
function ProblemCard({ problem, lead, compact }) {
  return h(
    'div',
    { className: 'rk-problem-card', 'data-severity': problem.severity, 'data-testid': `problem-card-${problem.id}`, role: 'alert' },
    lead ? h('div', { className: 'rk-problem-lead' }, lead) : null,
    h('ul', { className: 'rk-problems' }, h(ProblemRow, { compact, problem }))
  )
}

/**
 * The setup problems this person has seen (P-30): this window's memory, kept in its localStorage when it has one.
 * A problem seen once folds to a line; a new one, or one that stops runs, shows whole.
 */
const SEEN_KEY = 'roko.setup.seen'
const seenProblems = (() => {
  try {
    return new Set(JSON.parse(window.localStorage.getItem(SEEN_KEY) || '[]'))
  } catch {
    return new Set()
  }
})()

function markSeen(ids) {
  ids.forEach(id => seenProblems.add(id))

  try {
    window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seenProblems].slice(-40)))
  } catch {
    // no storage here: this window remembers until it closes
  }
}

/** `00 SETUP`: everything that keeps roko from working here, numbered, each with its one fix. */
function SetupModule({ problems }) {
  const ids = problems.map(p => text(p.id)).join(',')
  // Whole the first time, whenever a problem is new, and while one stops runs; else one line until clicked.
  const whole = problems.some(p => p.severity === 'block' || !seenProblems.has(text(p.id)))
  const [open, setOpen] = useState(whole)
  const tab = useValue($tab)
  const shownOn = useRef(tab)

  useEffect(() => {
    if (whole) {
      setOpen(true)
    }

    markSeen(problems.map(p => text(p.id)))
  }, [ids])

  // Seen once, it folds on the next tab (P-30), unless a problem stops runs.
  useEffect(() => {
    if (shownOn.current !== tab) {
      shownOn.current = tab
      setOpen(problems.some(p => p.severity === 'block'))
    }
  }, [tab])

  if (!problems.length) {
    return null
  }

  const blocking = problems.filter(p => p.severity === 'block').length

  if (!open) {
    const first = problems[0]

    return h(
      'button',
      { 'aria-expanded': 'false', className: 'rk-setup-line', 'data-testid': 'setup-line', onClick: () => setOpen(true), title: text(first.detail) || text(first.title), type: 'button' },
      h(LED, { tone: 'you' }),
      h('span', { className: 'rk-setup-line-title' }, text(first.title)),
      problems.length > 1 ? h('span', { className: 'rk-setupstrip-more' }, `+${problems.length - 1}`) : null,
      isRecord(first.fix) && text(first.fix.label) ? h('span', { className: 'rk-tag', 'data-channel': 'you' }, text(first.fix.label)) : null
    )
  }

  return h(
    'section',
    { 'aria-label': 'Setup', className: 'rk-module rk-setup', 'data-blocking': blocking ? 'true' : undefined, 'data-testid': 'setup-module' },
    h(ModLabel, { right: blocking ? `${blocking} blocking new runs` : `${problems.length} to look at` }, 'setup'),
    h('ol', { className: 'rk-problems' }, problems.map((problem, i) => h(ProblemRow, { index: i, key: problem.id, problem })))
  )
}

/** Calm but unmistakable: this window runs an older roko than the one installed, and what finishes it. */
function RestartBanner({ restart, compact }) {
  return h(
    'div',
    { className: 'rk-restart', 'data-compact': compact ? 'true' : undefined, 'data-testid': 'restart-banner', role: 'alert' },
    h(Well, { className: 'rk-restart-well' }, h(LED, { blink: 'fast', tone: 'you' }), h(Dots, { label: 'restart', size: compact ? 'S' : 'M', tone: 'you', value: 'RESTART' })),
    h(
      'div',
      { className: 'rk-restart-body' },
      h('div', { className: 'rk-restart-title' }, restart.title),
      h(RestartSteps, { pageOnly: restart.pageOnly, steps: restart.steps }),
      compact ? null : h('div', { className: 'rk-restart-why' }, 'Hermes loads roko when it starts, so an update waits for a restart (docs/updating.md).')
    )
  )
}

/** A serve's state on the glass: its light, and its word in dot-matrix, which sweeps while it starts. */
function ServeLight({ serve, size = 'M' }) {
  const look = SERVE_LOOK[serve.state]

  return h(Well, { className: 'rk-serve-well' }, h(LED, { blink: look.blink, tone: look.tone }), h(Dots, { hidden: true, size, sweep: serve.state === 'starting', tone: look.tone === 'off' ? 'dim' : look.tone, value: look.dots }))
}

/** The backend's words for a serve (lowercase fragments, such as "install roko: …") as a sentence; "roko" stays lowercase. */
function serveSentence(v) {
  const s = /^roko\b/.test(v) ? v : sentenceCase(v)

  return s && !/[.!?…]$/.test(s) ? `${s}.` : s
}

/**
 * The project's roko serve while it does not run (0.7): its state, how long it has been starting, why it failed and
 * its log's last lines, the command to copy, and the keys the backend allows. Its clock is never read out.
 */
function ServeBanner({ serve, compact, lead }) {
  const [open, setOpen] = useState(false)
  const hint = serve.error?.hint ?? ''
  // The command to copy: the one the hint quotes (`cargo install …`); a hint in words only ("restart roko serve") has none.
  const fix = /`([^`]+)`/.exec(hint)?.[1] ?? ''
  const said = serve.state === 'starting' ? '' : serve.error?.message ? serveSentence(serve.error.message) : serve.state === 'stopped' ? 'Nothing roko does works from Hermes until it runs.' : ''

  return h(
    'section',
    { 'aria-label': 'roko serve', className: 'rk-serve', 'data-compact': compact ? 'true' : undefined, 'data-state': serve.state, 'data-testid': 'serve-banner' },
    h(ServeLight, { serve, size: compact ? 'S' : 'M' }),
    h(
      'div',
      { className: 'rk-serve-body' },
      lead ? h('div', { className: 'rk-problem-lead' }, lead) : null,
      h('div', { className: 'rk-serve-title' }, serveTitle(serve)),
      serve.state === 'starting'
        ? h('div', { className: 'rk-serve-line', 'data-testid': 'serve-starting' }, parseTime(serve.since) !== null ? h(Fragment, null, h(StepClock, { since: serve.since }), ' · ') : null, 'usually ready within a minute')
        : said
          ? h('div', { className: 'rk-serve-line' }, said)
          : null,
      hint ? h('div', { className: 'rk-serve-hint' }, serveSentence(hint)) : null,
      fix ? h('div', { className: 'rk-fix-command' }, h('code', { className: 'rk-fix-cmd' }, fix), h(CopyKey, { label: 'copy', testId: 'serve-fix-copy', value: fix })) : null,
      h(
        'div',
        { className: 'rk-keyrow' },
        h(ServeKeys, { serve }),
        serve.log.length
          ? h(Key, { 'aria-expanded': open ? 'true' : 'false', onClick: () => setOpen(!open), size: 's', testId: 'serve-log-key' }, h(Codicon, { name: open ? 'chevron-down' : 'chevron-right', size: '0.7rem' }), `log · last ${plural(serve.log.length, 'line')}`)
          : null
      ),
      open ? h(Glass, { as: 'pre', className: 'rk-serve-log', label: 'The last lines of roko serve’s log', testId: 'serve-log' }, serve.log.map((line, i) => h('span', { key: i }, `${line}\n`))) : null
    )
  )
}

/** A serve's keys, in words. */
const SERVE_KEYS = {
  restart: { icon: 'debug-restart', word: 'restart roko serve' },
  start: { icon: 'play', word: 'start roko serve' },
  stop: { icon: 'debug-stop', word: 'stop roko serve' }
}

/**
 * The keys the backend allows for a serve now (`actions`), each a POST /serve. A restart or stop that would stop runs
 * asks first and names them, then sends `force`; so does one the backend turns away as busy (`conflict`).
 */
function ServeKeys({ serve }) {
  const { canAct } = useLimits()
  const [pending, setPending] = useState(null)
  const [error, setError] = useState(null)
  const [confirm, setConfirm] = useState(null)

  if (!canAct || !serve.actions.length) {
    return null
  }

  const send = async action => {
    setPending(action)
    setError(null)

    try {
      await serveAction(action, serve.project)
    } catch (err) {
      if (err instanceof RokoError && err.code === 'conflict') {
        setConfirm({ action, message: err.message, serve: readServe(err.serve) ?? serve })
      } else {
        setError(err)
      }
    } finally {
      setPending(null)
    }
  }

  return h(
    Fragment,
    null,
    serve.actions.map(action =>
      h(
        Key,
        {
          disabled: Boolean(pending),
          key: action,
          onClick: () => ((action === 'restart' || action === 'stop') && serve.busy > 0 ? setConfirm({ action, message: '', serve }) : void send(action)),
          size: 's',
          testId: `serve-${action}`,
          tone: action === 'start' ? 'primary' : undefined
        },
        pending === action ? h(Spinner, null) : h(Codicon, { name: SERVE_KEYS[action].icon, size: '0.75rem' }),
        action === 'start' && serve.state === 'failed' ? 'start again' : SERVE_KEYS[action].word
      )
    ),
    error ? h('span', { className: 'rk-serve-error', role: 'alert' }, failureLine(error)) : null,
    h(BusyConfirm, { confirm, onClose: () => setConfirm(null), onConfirm: () => serveAction(confirm.action, confirm.serve.project, true) })
  )
}

/**
 * Asks before a restart or stop that stops runs (`confirm`: `{action, message, serve}`), naming them: the overview's
 * live rows in that project. The backend's words when it turned the action away as busy; `onConfirm` sends `force`.
 */
function BusyConfirm({ confirm, onClose, onConfirm }) {
  const data = useOverview().data
  const going = confirm ? busyRuns(confirm.serve, data) : []
  const n = confirm ? Math.max(confirm.serve.busy, going.length) : 0
  const stop = confirm?.action === 'stop'

  return h(
    ConfirmDialog,
    {
      confirmLabel: stop ? 'Stop roko serve' : 'Restart roko serve',
      description: confirm?.message || `${plural(n, 'run')} ${n === 1 ? 'is' : 'are'} going in ${confirm?.serve.name || 'this project'}: ${stop ? 'stopping' : 'restarting'} roko serve stops ${n === 1 ? 'it' : 'them'}. What passed is kept.`,
      destructive: true,
      onClose,
      onConfirm: async () => {
        try {
          await onConfirm()
        } catch (err) {
          throw new Error(failureLine(err))
        }
      },
      open: Boolean(confirm),
      title: stop ? 'Stop roko serve while runs are going?' : 'Restart roko serve while runs are going?'
    },
    going.length
      ? h('ul', { className: 'rk-serve-runs', 'data-testid': 'serve-busy-runs' }, going.slice(0, 5).map(row => h('li', { key: row.run_id }, h(LED, { blink: 'slow', size: 's', tone: 'live' }), clip(text(row.label) || row.run_id, 60))))
      : null
  )
}

/** What stops a start, where it stops it (the composer, Run plan…): the serve banner while the serve is why. */
function Blocking({ problem, lead, compact }) {
  return problem.pick
    ? h(PickProject, { compact: true, lead })
    : problem.serve
      ? h(ServeBanner, { compact: true, lead, serve: problem.serve })
      : h(ProblemCard, { compact, lead, problem })
}

/**
 * No project yet (0.7 `projects: []`): roko works in a git checkout the person picks. The glass says so, and
 * "choose folder…" adds one; where this Hermes has no folder dialog, or actions from the app are off, the CLI line does.
 */
function PickProject({ compact, lead }) {
  const adder = useAddProject([])

  return h(
    'section',
    { 'aria-label': 'Pick a project', className: 'rk-serve', 'data-compact': compact ? 'true' : undefined, 'data-state': 'pick', 'data-testid': 'pick-project' },
    h(Well, { className: 'rk-serve-well' }, h(LED, { blink: 'fast', tone: 'you' }), h(Dots, { hidden: true, size: compact ? 'S' : 'M', tone: 'you', value: 'NO PROJECT' })),
    h(
      'div',
      { className: 'rk-serve-body' },
      lead ? h('div', { className: 'rk-problem-lead' }, lead) : null,
      h('div', { className: 'rk-serve-title' }, 'Pick the project roko works in.'),
      h('div', { className: 'rk-serve-line' }, 'A git checkout: roko runs its tasks there, on branches of its own, and starts a roko serve for it.'),
      adder.add
        ? h('div', { className: 'rk-keyrow' }, h(AddProject, { adder, primary: true }))
        : h('div', { className: 'rk-serve-hint' }, 'In a terminal: hermes roko projects add <path>')
    )
  )
}

/** Show a project on this page; the default one keeps 0.6's routes. */
const pickProject = p => setProject(p.default ? null : p.path)

/**
 * "choose folder…" (0.7): the native folder dialog (Hermes 0.22's `pickOpenPath` passes `directories` on), then POST
 * /projects add. `add` is null without a folder dialog, or with actions from the app off.
 */
function useAddProject(known) {
  const [state, setState] = useState({ busy: false, error: null })
  const { canAct } = useLimits()
  const pick = doors?.os?.pickOpenPath

  if (typeof pick !== 'function' || !canAct) {
    return { ...state, add: null }
  }

  const add = async () => {
    let path = ''

    try {
      path = text(await pick({ directories: true, title: 'Choose a project folder' }))
    } catch {
      path = ''
    }

    if (!path) {
      return false
    }

    setState({ busy: true, error: null })

    try {
      const reply = await post('/projects', { action: 'add', path })
      const before = new Set(known.map(p => p.path))
      const now = list(reply.projects).map(readProject).filter(Boolean)
      // The backend names the project it added; an earlier one only lists them all.
      const added = readProject(reply.project) ?? now.find(p => !before.has(p.path)) ?? now.find(p => path === p.path || path.startsWith(`${p.path}/`))

      takeProjects(reply)
      pickProject(added ?? { path })
      setState({ busy: false, error: null })

      return true
    } catch (error) {
      setState({ busy: false, error })

      return false
    }
  }

  return { ...state, add }
}

/** The projects as a pick list, each lit by its serve, the one shown checked. */
function ProjectList({ projects, onPick, testId }) {
  return h(
    'div',
    { 'aria-label': 'Projects', className: 'rk-projlist', 'data-testid': testId, role: 'radiogroup' },
    projects.all.map(p => {
      const on = p.path === projects.current?.path
      const look = SERVE_LOOK[p.serve?.state]

      return h(
        'button',
        {
          'aria-checked': on ? 'true' : 'false',
          'aria-label': [p.name, look ? `roko serve ${look.word}` : '', p.needsSetup ? 'needs setup' : p.default ? 'default' : ''].filter(Boolean).join(', '),
          className: 'rk-proj',
          'data-on': on ? 'true' : undefined,
          key: p.path,
          onClick: () => onPick(p),
          role: 'radio',
          title: p.path,
          type: 'button'
        },
        h(LED, { blink: look?.blink, size: 's', tone: look?.tone ?? 'off' }),
        h('span', { className: 'rk-proj-name' }, p.name),
        p.needsSetup ? h('span', { className: 'rk-tag', 'data-channel': 'you' }, 'needs setup') : p.default ? h('span', { className: 'rk-tag' }, 'default') : null
      )
    })
  )
}

/** "choose folder…" as a key, with why it did not take. */
function AddProject({ adder, onAdded, label = 'choose folder…', primary = false }) {
  return adder.add
    ? h(
        Fragment,
        null,
        h(Key, { disabled: adder.busy, onClick: () => void adder.add().then(ok => ok && onAdded?.()), size: 's', testId: 'choose-folder', tone: primary ? 'primary' : undefined }, adder.busy ? h(Spinner, null) : h(Codicon, { name: 'folder-opened', size: '0.75rem' }), label),
        adder.error ? h('div', { className: 'roko-result', 'data-tone': 'bad', role: 'alert' }, failureLine(adder.error)) : null
      )
    : null
}

/** The composer's `00 PROJECT`: which project the run is for. Picking one shows it on the page as well. */
function ProjectModule({ projects }) {
  const adder = useAddProject(projects.all)

  return h(
    'div',
    { className: 'rk-module rk-module-project', 'data-testid': 'composer-project' },
    h(ModLabel, { note: projects.current ? h('span', { title: projects.current.path }, projects.current.name) : 'none yet: pick the git checkout roko works in' }, 'project'),
    h('div', { className: 'rk-keyrow' }, h(ProjectList, { onPick: pickProject, projects, testId: 'composer-projects' }), h(AddProject, { adder, primary: projects.none }))
  )
}

/**
 * The header's project (0.7): which project this page shows, lit by its serve. It opens the projects this Hermes
 * knows; picking one switches the page (overview, plans, loops, insights, learning, lessons) and is kept for this
 * window.
 */
function ProjectSwitch({ data }) {
  const projects = projectsOf(data)
  const [open, setOpen] = useState(false)
  const adder = useAddProject(projects.all)
  const current = projects.current

  if (!current && !projects.none) {
    return null
  }

  const look = SERVE_LOOK[current?.serve?.state]

  return h(
    Popover,
    { onOpenChange: setOpen, open },
    h(
      PopoverTrigger,
      { asChild: true },
      h(
        'button',
        { 'aria-label': current ? `Project ${current.name}: switch the project this page shows` : 'Pick a project', className: 'rk-projkey', 'data-testid': 'project-switch', title: current?.path, type: 'button' },
        h(LED, { blink: look?.blink, size: 's', tone: look?.tone ?? 'off' }),
        h('span', { className: 'rk-projkey-name' }, current ? current.name : 'pick a project'),
        h(Codicon, { name: 'chevron-down', size: '0.7rem' })
      )
    ),
    h(
      PopoverContent,
      { align: 'start', className: 'roko rk-projmenu', 'data-testid': 'project-menu' },
      h(ModLabel, { note: 'the page shows one at a time' }, 'projects'),
      h(ProjectList, {
        onPick: p => {
          pickProject(p)
          setOpen(false)
        },
        projects
      }),
      h(AddProject, { adder, label: 'add a project…', onAdded: () => setOpen(false) })
    )
  )
}

/**
 * The project a run belongs to (0.7 `project`), once this Hermes knows more than one. A waiting item names none: its
 * run's row in the overview does.
 */
function ProjectTag({ run }) {
  const data = useOverview().data
  const many = list(data?.projects).length > 1
  const own = run?.project ?? list(data?.runs).find(row => isRecord(row) && validId(row.run_id) && row.run_id === run?.run_id)?.project
  // A run row's `{path, name}`, or a path alone.
  const p = isRecord(own) ? own : text(own) ? { name: text(own).split(/[\\/]/).filter(Boolean).pop(), path: own } : null

  return many && p && text(p.name) ? h('span', { className: 'rk-runproj', 'data-testid': 'run-project', title: text(p.path) || undefined }, h(Codicon, { name: 'folder', size: '0.65rem' }), clip(p.name, 28)) : null
}

/**
 * The top of the page: the restart banner, the serve banner (0.7), then the setup module (its restart and serve lines
 * are the banners).
 */
function SetupArea() {
  const setup = useSetup()
  const done = useValue($fixDone)
  const problems = setup.restart ? setup.problems.filter(p => p.id !== 'restart-hermes') : setup.problems

  if (!setup.restart && !setup.serve && !setup.pick && !problems.length && !done) {
    return null
  }

  return h(
    'div',
    { className: 'rk-setup-area' },
    setup.restart ? h(RestartBanner, { restart: setup.restart }) : null,
    setup.pick ? h(PickProject, null) : null,
    setup.serve ? h(ServeBanner, { serve: setup.serve }) : null,
    h(FixDoneNote, { problems: setup.problems }),
    h(SetupModule, { problems })
  )
}

/** The monitor pane's line for it: the restart, the serve, or the first problem and a key to its fix on the page. */
function SetupStrip() {
  const setup = useSetup()
  const first = setup.problems.find(p => p.id !== 'restart-hermes')

  if (setup.restart) {
    return h(RestartBanner, { compact: true, restart: setup.restart })
  }

  if (setup.pick) {
    return h(PickProject, { compact: true })
  }

  if (setup.serve) {
    return h(ServeBanner, { compact: true, serve: setup.serve })
  }

  if (!first) {
    return null
  }

  const channel = first.severity === 'block' ? 'fail' : 'you'
  const more = setup.problems.length - 1

  return h(
    'button',
    { className: 'rk-setupstrip', 'data-severity': first.severity, 'data-testid': 'setup-strip', onClick: () => openRoko({}), title: first.detail || first.title, type: 'button' },
    h(LED, { tone: channel }),
    h('span', { className: 'rk-setupstrip-title' }, first.title),
    more > 0 ? h('span', { className: 'rk-setupstrip-more' }, `+${more}`) : null,
    h('span', { className: 'rk-tag', 'data-channel': channel }, first.fix.label)
  )
}

let restartNoticed = ''
/** Whether the last overview found roko serve answering (null: not known yet). */
let wasReachable = null

/** One toast the first time this window finds it runs an old roko; the banner stays on the page. */
function noticeRestart(data) {
  const restart = restartOf(data, queryClient.getQueryData(projectKey(KEYS.health)))

  if (!restart || restart.key === restartNoticed) {
    return
  }

  restartNoticed = restart.key
  host.notify({
    action: { label: 'Open roko', onClick: () => openRoko({}) },
    detail: restart.steps.join(' '),
    kind: 'warning',
    message: restart.title,
    title: restart.pageOnly ? 'roko: reload its page to finish the update' : 'roko: restart Hermes to finish the update'
  })
}

// --- The page

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


function OfflineNotes({ overview }) {
  const data = overview.data
  const conn = isRecord(data?.connection) ? data.connection : null
  const setup = useSetup()
  const notes = []

  if (data && conn && conn.reachable !== true && !setup.pick) {
    // The setup module already says roko serve is not answering, and how to start it, with this workspace's path (0.7:
    // the serve banner does). Here only what it does not say: the hint when the module has no command for it, and that
    // the runs below are the last known.
    const shown = setup.serve ?? setup.problems.find(p => p.id === 'roko-unreachable')
    const fixShown = Boolean(setup.serve) || (Boolean(shown) && shown.fix.kind !== 'docs')
    const err = isRecord(conn.error) ? { ...conn.error, hint: fixShown ? '' : conn.error.hint } : {}
    // The time of the last look changes with every look: a timer, so the status around it is not re-read (F9).
    const lastKnownLine = h(
      Fragment,
      null,
      'Showing the last known runs · checked ',
      h('span', { 'aria-live': 'off', role: 'timer' }, clock(parseTime(data.checked_at) ?? overview.dataUpdatedAt)),
      '; the page asks again every few seconds'
    )

    // No runs to show and no hint to add: the setup module (or the serve banner) says it all.
    const nothing = shown && !err.hint && !list(data.runs).some(isRecord)

    if (!nothing) {
      notes.push(
        shown
          ? h(
              'div',
              { className: 'roko-quiet roko-offline-note', 'data-testid': 'offline-note', key: 'unreachable', role: 'status' },
              h(Codicon, { name: 'debug-disconnect', size: '0.8rem' }),
              h('span', null, err.hint ? h('span', { className: 'roko-offline-hint' }, text(err.hint), ' ') : null, lastKnownLine)
            )
          : h(
              'div',
              { className: 'roko-banner', 'data-tone': 'bad', key: 'unreachable', role: 'alert' },
              h(Codicon, { className: 'roko-banner-icon', name: 'debug-disconnect', size: '1rem' }),
              h(
                'div',
                { className: 'roko-banner-body' },
                h('div', { className: 'roko-banner-title' }, text(err.message) || "Can't reach roko serve."),
                err.hint ? h('div', null, text(err.hint)) : null,
                h('div', { className: 'roko-muted' }, lastKnownLine)
              )
            )
      )
    }
  }

  if (data && overview.error) {
    notes.push(h(ErrorNote, { compact: true, error: overview.error, key: 'stale', lastChecked: overview.dataUpdatedAt, onRetry: () => void overview.refetch() }))
  }

  return notes.length ? h('div', { className: 'roko-notes' }, notes) : null
}

/** j/k, n, [ ], r and Esc on the page; never while typing or in a dialog. */
/** Focus mode (spec v3 §7, `f`): the run alone on the page, full width, for a recording; `f` or Esc leaves it. */
const $focus = atom(false)

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

      // 1 2 3: the tabs; w: what waits on you, at the top of Runs (design system §5.1).
      const go = { 1: 'runs', 2: 'plans', 3: 'learning', w: 'runs' }[key]

      if (go) {
        event.preventDefault()

        if (go === 'runs') {
          goHome()
        } else {
          $tab.set(go)
          replaceView(go === 'plans' ? { plan: $plan.get(), tab: 'plans' } : { tab: go })
        }

        return
      }

      if (tab !== 'runs') {
        return
      }

      if (key === 'Escape' && $inspect.get()) {
        $inspect.set(null)

        return
      }

      if (key === 'f' || (key === 'Escape' && $focus.get())) {
        event.preventDefault()
        $focus.set(key === 'f' ? !$focus.get() : false)

        return
      }

      // An open route sheet has the arrows: they pick its tries.
      if ($inspect.get() && (key === 'ArrowDown' || key === 'ArrowUp')) {
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

/**
 * The erosion meter (bardo's MortalityGauge, █ → ▓ → ▒ → ░): lit segments for what is spent, the segment it is in
 * partly lit, and a dashed ghost up to what is held or projected (spec v3 §4.2). It sits on the glass.
 */
function Meter({ value, max, segments = 24, ghost = null, tone = 'ink', label, className, testId }) {
  const m = num(max)

  if (m === null || m <= 0) {
    return null
  }

  const v = Math.max(0, num(value) ?? 0)
  const lit = clamp(v / m, 0, 1) * segments
  const full = Math.floor(lit)
  const held = num(ghost) !== null ? Math.round(clamp(num(ghost) / m, 0, 1) * segments) : 0

  return h(
    'span',
    {
      'aria-hidden': label ? undefined : 'true',
      'aria-label': label,
      'aria-valuemax': label ? m : undefined,
      'aria-valuemin': label ? 0 : undefined,
      'aria-valuenow': label ? v : undefined,
      className: cx('rk-meter', className),
      'data-testid': testId,
      'data-tone': tone,
      role: label ? 'meter' : undefined
    },
    Array.from({ length: segments }, (_, i) =>
      h('i', {
        'data-seg': i < full ? 'on' : i === full && lit - full > 0.5 ? 'e1' : i === full && lit - full > 0.05 ? 'e2' : i < held ? 'ghost' : undefined,
        key: i
      })
    )
  )
}

/** Today's spend, its limit, what live runs still hold, and what is left: the line under the header's meter. */
/** The today counter's label (P-3): "$0.20 from Hermes · $0.56 in roko today", or "$0.20 from Hermes". */
function todayCounter(spend) {
  const roko = num(spend?.roko_today_usd)

  return `${money(spend?.today_usd ?? 0)} from Hermes${roko !== null ? ` · ${money(roko)} in roko today` : ''}`
}

/**
 * The header's line, as [whose spend, the rest]: the counter (P-3), then Hermes' daily limit, or what live runs hold and
 * what is left when that says more ("$2.39 held · $15.64 left": at 1440 px the longer words were cut, phase 2's S2
 * stills). With `all`, the limit too, for its title.
 */
function todayLine(spend, all = false) {
  const max = num(spend.max_day_usd)
  const held = num(spend.committed_usd) ?? 0
  const left = num(spend.left_usd)
  const says = max !== null && left !== null && Math.abs(left - (max - (num(spend.today_usd) ?? 0))) > 0.005
  const rest = [max !== null && (all || !says) ? `limit ${money(max)} a day` : '', held > 0 ? `${money(held)} held` : '', says ? `${money(left)} left` : '']

  return [todayCounter(spend), rest.filter(Boolean).join(' · ')]
}

/**
 * The header (HEAD, spec v3 §2.5): the mark and the wordmark; LIVE while roko works and its events stream, IDLE when
 * nothing runs, OFFLINE when roko serve is down; the connection; today's spend; sound; the one orange key.
 */
function PageHeader({ overview }) {
  const data = overview.data
  const conn = isRecord(data?.connection) ? data.connection : null
  const checked = parseTime(data?.checked_at) ?? overview.dataUpdatedAt
  const { canAct } = useLimits()
  const live = useValue($live)
  // The plugin's socket can be open while roko serve is down: live only when roko's events can flow.
  const offline = Boolean(data) && conn?.reachable !== true
  const on = live.state === 'open' && !offline && (!live.hub || live.hub === 'open')
  const running = num(data?.counts?.running) ?? 0
  // 0.7: a serve that does not run says its own state in place of offline: starting, stopped, failed…
  const serve = serveOf(data)
  const look = serve ? SERVE_LOOK[serve.state] : null
  const serveDown = Boolean(serve) && SERVE_BANNER.has(serve.state)
  const none = projectsOf(data).none
  const tab = useValue($tab)
  const selected = useValue($run)
  const waits = useWaiting().items.length
  // One orange key a screen (design system §2): new run is it on Runs, the home, when nothing there needs the
  // person; the empty page's own key, an answer, or starting roko serve comes first.
  const runsShown = list(data?.runs).some(row => isRecord(row) && validId(row.run_id))
  const lead = (tab === 'runs' || tab === 'waiting') && !validId(selected) && !waits && !serveDown && !none && runsShown
  // The header says roko's state only when it isn't fine (design system §5.1); the rest is in its tooltip.
  const trouble = none
    ? { state: 'you', word: 'no project' }
    : serveDown
      ? { blink: look.blink, state: look.tone === 'fail' ? 'fail' : look.tone === 'live' ? 'live' : look.tone === 'you' ? 'you' : 'stop', word: look.word }
      : offline
        ? { state: 'fail', word: 'offline' }
        : null
  const liveTip = none
    ? 'Pick the project roko works in: a git checkout.'
    : serveDown
      ? serveTitle(serve)
      : offline
        ? 'roko serve isn’t answering: nothing streams. The page asks again every few seconds.'
        : on
          ? running > 0
            ? 'roko is working, and its events stream in as they happen'
            : 'Nothing runs now; roko’s events stream in as soon as something does'
          : 'No live stream: checking every few seconds'
  let line

  if (!data) {
    // The banner below carries the details.
    line = !overview.error ? 'connecting…' : overview.error.kind === 'backend' ? 'backend not loaded' : 'not connected'
  } else if (conn?.reachable) {
    line = [text(conn.status) === 'slow' ? 'busy' : text(conn.status), serve?.state === 'remote' ? 'remote' : '', shortUrl(conn.url), conn.version ? `v${text(conn.version)}` : ''].filter(Boolean).join(' · ')
  } else {
    line = none ? 'no project yet' : serveDown ? `${serveWords(serve)}${serve.project ? ` · ${serve.project}` : ''}` : `unreachable${conn?.url ? ` · ${shortUrl(conn.url)}` : ''}`
  }

  return h(
    'header',
    { className: 'rk-head' },
    h(
      Tip,
      { label: [liveTip, line, checked ? `checked ${clock(checked)}` : ''].filter(Boolean).join(' · ') },
      h(
        'span',
        { className: 'rk-wordmark', 'data-testid': 'live-state', 'data-state': none ? 'pick' : serveDown ? serve.state : offline ? 'offline' : on ? (running > 0 ? 'open' : 'idle') : live.state },
        h(Dots, { hidden: true, size: 'S', value: 'ROKO' }),
        h('span', { className: 'rk-sr' }, none ? 'no project' : serveDown ? look.word : offline ? 'offline' : on ? (running > 0 ? 'live' : 'idle') : live.state === 'connecting' || live.hub === 'connecting' ? 'connecting' : 'polling')
      )
    ),
    h(ProjectSwitch, { data }),
    trouble ? h(CardPill, { look: trouble }) : null,
    // For assistive tech (and the tests' wait): where roko is and how it answers.
    h('span', { className: 'rk-sr', 'data-testid': 'roko-connection' }, line),
    // Each change of the serve's state, said once (the banner's clock is not).
    h('span', { 'aria-live': 'polite', className: 'rk-sr', 'data-testid': 'serve-said', role: 'status' }, serve ? serveWords(serve) : ''),
    h('span', { className: 'roko-flex' }),
    data?.spend ? h(TodayGlass, { spend: data.spend }) : null,
    canAct && data
      ? h(
          Tip,
          { label: `New run (${comboLabel(NEW_RUN_COMBO)}, or n on this page)` },
          h(Key, { kbd: 'N', onClick: () => openComposer(), size: 'l', testId: 'new-run', tone: lead ? 'primary' : undefined }, 'new run')
        )
      : null
  )
}

/** Today's spend on a small glass (design system §4.2): its counter on hover, red near roko's daily limit. */
function TodayGlass({ spend }) {
  const max = num(spend.max_day_usd)
  const today = num(spend.today_usd) ?? 0
  const ratio = max ? today / max : null
  const tone = ratio === null ? undefined : ratio >= 0.95 ? 'fail' : ratio >= 0.8 ? 'you' : undefined

  return h(
    Tip,
    { label: todayLine(spend, true).filter(Boolean).join(' · ') },
    h(
      'span',
      { className: 'rk-well rk-today', 'data-testid': 'roko-today' },
      h('span', { className: 'rk-rc-label' }, 'today'),
      h(Dots, { label: todayCounter(spend), size: 'S', tone, value: money(today) }),
      h('span', { className: 'rk-sr', 'data-testid': 'roko-spend', title: todayLine(spend, true).filter(Boolean).join(' · ') }, todayLine(spend).filter(Boolean).join(' · '))
    )
  )
}

/** A serve's address without its scheme or a trailing slash (host and port): the tooltip's short form. */
function shortUrl(url) {
  return text(url).replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '')
}

/** Learning's old sub-views (#tab=loops, knowledge, health): each is Learning now, with its fold open. */
const LEARNING_TABS = new Set(['learning', 'loops', 'knowledge', 'health'])

/**
 * Three tabs (design system §5.1): Runs, the home, where what needs the person comes first; Plans, which opens on a
 * build's phases when the project's plans are one; Learning.
 */
function PageTabs({ tab, setTab, data }) {
  const running = num(data?.counts?.running) ?? 0
  const waits = useWaiting().items.length
  const learning = LEARNING_TABS.has(tab)
  // roko learns from runs that ended: until one has, Learning has nothing of this workspace's to show.
  const ended = list(data?.runs).some(row => isRecord(row) && TERMINAL_STATES.has(row.state))
  const on = id => (id === 'learning' ? learning : id === 'plans' ? tab === 'plans' || tab === 'build' : tab === 'runs' || tab === 'waiting')
  const tabKey = (id, word, extra, props = {}) =>
    h('button', { 'aria-label': word, 'aria-selected': on(id) ? 'true' : 'false', className: 'rk-tab', 'data-tab': id, key: id, onClick: () => setTab(id), role: 'tab', type: 'button', ...props }, word, extra)

  return h(
    'nav',
    { 'aria-label': 'roko sections', className: 'rk-tabs', role: 'tablist' },
    // What needs the person shows from any tab: orange, its count (design system §2: orange is your turn).
    waits
      ? tabKey('runs', 'Runs', h('span', { className: 'rk-tab-you', 'data-testid': 'waiting-badge' }, h(LED, { blink: 'fast', size: 's', tone: 'you' }), h('b', { 'data-testid': 'waiting-count' }, String(waits))), { 'aria-label': `Runs, ${waits} ${waits === 1 ? 'needs' : 'need'} you` })
      : tabKey('runs', 'Runs', running ? h(LED, { blink: 'slow', size: 's', tone: 'live' }) : null),
    tabKey('plans', 'Plans', null),
    h(Tip, { key: 'learning', label: ended ? 'What roko learned: what passed where, and the lessons that paid off' : 'roko starts learning when your first run ends' }, tabKey('learning', 'Learning', null, { 'data-ghost': ended ? undefined : 'true' }))
  )
}

// --- Runs, the home (design system §5.1): what needs the person, what runs, what ran

/** One line a run that ended: its glyph, its title, its plan's strip, its time, its spend, when. */
function RunLine({ row, now }) {
  const look = cardLook(row)
  const glyph = { fail: '✗', pass: '✓', you: '‖' }[look.state] ?? '■'
  const startMs = parseTime(row.started_at)
  const end = startMs !== null && num(row.duration_ms) !== null ? startMs + row.duration_ms : startMs

  return h(
    'button',
    { 'aria-label': `${text(row.label) || 'a roko run'}: ${look.word}`, className: 'rk-line', 'data-state': look.state, 'data-testid': `run-line-${text(row.run_id)}`, onClick: () => selectRun(row.run_id), role: 'listitem', type: 'button' },
    h('span', { 'aria-hidden': 'true', className: 'rk-line-glyph' }, glyph),
    h('span', { className: 'rk-line-title' }, text(row.label) || 'a roko run', look.state === 'pass' ? null : h('small', null, look.word), h(ProjectTag, { run: row })),
    h(PlanStrip, { run: row }),
    h('span', { className: 'rk-line-fig' }, lineTime(row)),
    h('span', { className: 'rk-line-fig rk-row-spend' }, money(row.cost_usd)),
    h('span', { className: 'rk-line-when' }, end !== null ? ago(end, now) : '')
  )
}

/** How long a run that ended took, from its record, or from its start and its end; else nothing. */
function lineTime(row) {
  const start = parseTime(row.started_at)
  const end = parseTime(row.finished_at)
  const ms = num(row.duration_ms) ?? (start !== null && end !== null && end > start ? end - start : null)

  return ms !== null ? duration(ms) : ''
}

/**
 * Runs (design system §5.1, mockup after-runs): what needs the person first, each as its card; then what runs, each
 * as its run card with the plan drawn; then what ran, a line each. A run opens its page; Runs comes back here.
 */
function RunsHome({ overview }) {
  const selected = useValue($run)
  const now = useNow(30_000)
  const reachable = isRecord(overview.data?.connection) ? overview.data.connection.reachable === true : null
  const runs = list(overview.data?.runs)
    .filter(row => isRecord(row) && validId(row.run_id))
    .map(row => lastKnown(row, reachable))
  const waits = useWaiting()
  const pending = waits.items
  const row = validId(selected) ? runs.find(r => r.run_id === selected) : null
  const title = useRunTitle(row)

  if (validId(selected)) {
    return h(
      'div',
      { className: 'rk-runpage-wrap' },
      h('nav', { 'aria-label': 'Where you are', className: 'rk-crumb' }, h('button', { 'data-testid': 'crumb-runs', onClick: () => goHome(), type: 'button' }, 'Runs'), ' › ', h('b', null, clip(row ? title : 'this run', 80))),
      h(RunCard, { fallback: row, key: selected, runId: selected })
    )
  }

  if (!runs.length && !pending.length) {
    return h(Onboarding, null)
  }

  const going = runs.filter(isActiveRun)
  // A plan writing that ended is its plan's (Plans has it); a run is a line here.
  const ended = runs.filter(row => !isActiveRun(row) && row.kind !== 'plan_generate')

  return h(
    'div',
    { className: 'rk-home', 'data-testid': 'runs-home' },
    waits.error && reachable !== false ? h(ErrorNote, { error: waits.error, lastChecked: waits.checkedAt, onRetry: waits.retry }) : null,
    pending.length
      ? h(
          'section',
          { 'aria-label': 'Needs you', className: 'rk-home-sec', 'data-testid': 'needs-you' },
          h('h3', { className: 'rk-home-h' }, pending.length === 1 ? 'Needs you' : `Needs you · ${pending.length}`),
          pending.map(item => h(PendingCard, { item, key: text(item.code) || text(item.decision_id), showRun: true }))
        )
      : null,
    going.length
      ? h(
          'section',
          { 'aria-label': 'Running', className: 'rk-home-sec' },
          h('h3', { className: 'rk-home-h' }, 'Running'),
          going.map(row => h(RunCardCompact, { fallback: row, key: row.run_id, plan: true, runId: row.run_id, size: 'L' }))
        )
      : null,
    ended.length
      ? h(
          'section',
          { 'aria-label': 'Earlier', className: 'rk-home-sec' },
          h('h3', { className: 'rk-home-h' }, 'Earlier'),
          h('div', { 'aria-label': 'roko runs', className: 'rk-lines', role: 'list' }, ended.slice(0, 40).map(row => h(RunLine, { key: row.run_id, now, row })))
        )
      : null
  )
}

/** What waits on the person: in the project shown (/pending), then in every project whose serve runs (the overview). */
function useWaiting() {
  const query = usePending()
  const everywhere = list(useOverview().data?.pending).filter(isRecord)
  const listed = list(query.data).filter(isRecord)
  const codes = new Set(listed.map(item => text(item.code)))
  const items = [...listed, ...everywhere.filter(item => !codes.has(text(item.code)))].filter(item => !answered(item))

  return { checkedAt: query.data ? query.dataUpdatedAt : 0, error: query.error, items, retry: () => void query.refetch() }
}

/** Back to Runs, the home: no run picked. */
function goHome() {
  $run.set(null)
  $inspect.set(null)
  $tab.set('runs')
  replaceView({ tab: 'runs' })
}

/** How many roko pages are on screen (the run's own end moment speaks for it there). */
let pagesShown = 0

/** The person is looking at this run: the window is visible, a roko page shows Runs, and that run is the one open. */
function watching(runId) {
  if (pagesShown < 1 || $tab.get() !== 'runs' || isHidden()) {
    return false
  }

  const open = validId($run.get()) ? $run.get() : text(list(queryClient.getQueryData(projectKey(KEYS.overview))?.runs).find(r => isRecord(r) && validId(r.run_id))?.run_id)

  return open === runId
}

function RokoPage() {
  useLocationSync()
  const tab = useValue($tab)

  useEffect(() => {
    pagesShown += 1

    return () => {
      pagesShown -= 1
    }
  }, [])
  const overview = useOverview()
  const build = useBuild()
  const data = overview.data
  const backendDown = !data && overview.error instanceof RokoError && overview.error.kind === 'backend'
  const setTab = value => {
    if (TABS.includes(value)) {

      // Runs is the home, and Plans has its own: each tab comes back to it, whatever was open.
      if (value === 'runs' || value === 'waiting') {
        goHome()

        return
      }

      if (value === 'plans' || value === 'build') {
        goPlans()

        return
      }

      $tab.set(value)
      replaceView(value === 'plans' ? { plan: $plan.get(), tab: 'plans' } : { tab: value })
    }
  }

  usePageKeys(overview)

  let body

  if (backendDown) {
    body = h(BackendBanner, { error: overview.error, onRetry: refreshAll })
  } else if (!data && overview.isLoading) {
    body = h('div', { className: 'rk-boot' }, h(Loader, { className: 'rk-loader', label: 'Connecting to roko', type: 'rose-curve' }), h(Spinner, { label: 'Connecting to roko…' }))
  } else if (!data && overview.error) {
    body = h(ErrorNote, { error: overview.error, onRetry: () => void overview.refetch() })
  } else if (tab === 'build' || tab === 'plans') {
    // A build's phases head the plans (design system §5.1: Build is Plans now).
    body = h(PlansPage, null)
  } else if (tab === 'loops') {
    body = h(LearningPage, { tab })
  } else if (tab === 'knowledge') {
    body = h(LearningPage, { tab })
  } else if (tab === 'health') {
    body = h(LearningPage, { tab })
  } else if (tab === 'learning') {
    body = h(LearningPage, { tab })
  } else {
    body = h(RunsHome, { overview })
  }

  const focus = useValue($focus) && tab === 'runs'

  return h(
    'div',
    { className: 'roko roko-page', 'data-focus': focus ? 'true' : undefined, 'data-testid': 'roko-page' },
    focus ? h('button', { className: 'rk-focus-exit', 'data-testid': 'focus-exit', onClick: () => $focus.set(false), type: 'button' }, 'focus · ', h(Kbd, { size: 'sm', variant: 'ghost' }, 'f'), ' to leave') : null,
    h(PageHeader, { overview }),
    backendDown ? null : h(PageTabs, { data, setTab, tab }),
    h('div', { className: 'roko-body' }, backendDown ? null : h(SetupArea, null), backendDown ? null : h(OfflineNotes, { overview }), backendDown ? null : h(ThemeOffer, null), body),
    h(ComposerHost, null)
  )
}

// --- Status bar chip

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

/** The progress of a run's tasks, as a sentence for assistive tech. */
function progressWords(p) {
  return p.total ? `${p.passed} of ${plural(p.total, 'task')} passed${p.running ? `, ${p.running} running` : ''}` : 'no tasks yet'
}

/** How many runs are going now, from the overview's counts. */
function runningCount(data) {
  return (num(data?.counts?.running) ?? 0) + (num(data?.counts?.queued) ?? 0)
}

function StatusChip() {
  const overview = useOverview()
  const setup = useSetup()
  const data = overview.data
  const tone = connectionTone(overview)
  const conn = isRecord(data?.connection) ? data.connection : null
  // While roko serve is down the counts and the running run are only what it last said: the chip says offline.
  const down = conn?.reachable === false
  const counts = down ? '' : countsLine(data?.counts)
  const waiting = down ? 0 : (num(data?.counts?.waiting) ?? 0)
  const err = conn && isRecord(conn.error) ? conn.error : null
  const live = down ? null : list(data?.runs).find(row => isRecord(row) && isActiveRun(row) && isRecord(row.progress) && num(row.progress.total))
  const progress = live ? { ...EMPTY_PROGRESS, ...live.progress } : null
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

  if (setup.restart) {
    tipLines.unshift(setup.restart.title)
  } else if (setup.pick) {
    tipLines.unshift('Pick the project roko works in.')
  } else if (setup.serve) {
    tipLines.unshift(serveTitle(setup.serve))
  } else if (setup.blocking) {
    tipLines.unshift(`setup: ${setup.blocking.title}`)
  }

  if (live) {
    tipLines.push(`${clip(live.label, 40)}: ${progress.passed}/${progress.total} tasks${num(live.cost_usd) !== null ? `, ${money(live.cost_usd)} spent` : ''}`)
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
          'data-live': live ? 'true' : undefined,
          'data-testid': 'roko-status-chip',
          'data-waiting': waiting > 0 ? 'true' : undefined,
          onClick: () => openRoko(waiting > 0 ? { tab: 'waiting' } : live ? { run: live.run_id } : {}),
          type: 'button'
        },
        // roko's design system §4.9: the wordmark, then the most urgent state with at most one reading on the glass.
        h('span', { 'aria-hidden': 'true', className: 'rk-chip-mark' }, h(Dots, { hidden: true, size: 'XS', value: 'ROKO' })),
        setup.restart
          ? h('span', { className: 'rk-tag', 'data-channel': 'you', 'data-testid': 'chip-restart' }, 'restart')
          : setup.pick
            ? h('span', { className: 'rk-tag', 'data-channel': 'you', 'data-testid': 'chip-pick' }, 'no project')
            : setup.serve
            ? h('span', { className: 'rk-tag', 'data-channel': SERVE_LOOK[setup.serve.state].tone === 'off' ? 'ink' : SERVE_LOOK[setup.serve.state].tone, 'data-testid': 'chip-serve' }, SERVE_LOOK[setup.serve.state].word)
            : setup.blocking?.id === 'roko-unreachable'
              ? h(Fragment, null, h('i', { className: 'rk-chip-led', 'data-state': 'off' }), h('span', { className: 'rk-chip-word', 'data-testid': 'chip-offline' }, 'off'))
              : setup.blocking
                ? h('span', { className: 'rk-tag', 'data-channel': 'fail', 'data-testid': 'chip-setup' }, 'setup')
                : tone === 'warn'
                  ? h('span', { className: 'rk-tag', 'data-channel': 'you', 'data-testid': 'chip-degraded' }, 'degraded')
                  : waiting > 0
                  ? h('span', { className: 'rk-chip-glass', 'data-testid': 'chip-waiting' }, h('i', { className: 'rk-chip-led', 'data-state': 'you' }), h(Dots, { hidden: true, size: 'XS', tone: 'you', value: String(waiting) }), h('span', { className: 'rk-chip-word' }, 'waiting'))
                  : live
                    ? h('span', { className: 'rk-chip-glass', 'data-testid': 'chip-live' }, h('i', { className: 'rk-chip-led', 'data-state': 'live' }), h(CardTime, { run: live, size: 'XS' }), runningCount(data) > 1 ? h('span', { className: 'rk-chip-word' }, `${runningCount(data)} running`) : null)
                    : h('i', { className: 'rk-chip-led', 'data-state': 'idle', 'data-testid': 'chip-idle' })
      )
    ),
    h(ComposerHost, null)
  )
}

// --- Transcript directives: ::roko-run{id="…"} ::roko-plan{id="…"} ::roko-pending{run="…"}

function DirectivePlaceholder({ label }) {
  return h('div', { className: 'roko roko-card roko-directive', 'data-compact': 'true' }, h(Spinner, { label }))
}

function RunDirective({ runId }) {
  return h('div', { className: 'roko roko-directive' }, h(RunCardCompact, { runId }))
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
// --- Background: the overview poll (a fallback while the socket is live),
// change notifications, pet lines, sounds, the sidebar label, run events

const seen = { ended: new Set(), pending: new Set(), seeded: false, states: new Map(), waiting: new Set() }
let navRegister = null
let navLabel = 'roko'

function resetSeen() {
  seen.pending.clear()
  seen.states.clear()
  seen.ended.clear()
  seen.waiting.clear()
  seen.seeded = false
  navLabel = 'roko'
  restartNoticed = ''
  wasReachable = null
}

/** The sidebar row: what waits on the person, else (0.7) no project yet, or a serve that does not run: "roko · starting". */
function setNavLabel(waiting, serve = null, none = false) {
  const label = waiting > 0 ? `roko (${waiting})` : none ? 'roko · no project' : serve && SERVE_BANNER.has(serve.state) ? `roko · ${SERVE_LOOK[serve.state].word}` : 'roko'

  if (label !== navLabel && navRegister) {
    navLabel = label
    navRegister(label)
  }
}

/** roko came back: views that failed while it was down (Plans, a run, Insights) ask again, without a Retry. */
function noticeReconnect(data) {
  const reachable = isRecord(data.connection) ? data.connection.reachable === true : null

  if (reachable === true && wasReachable === false) {
    void queryClient.refetchQueries({ predicate: query => query.queryKey[0] === ID && query.state.status === 'error' })
  }

  if (reachable !== null) {
    wasReachable = reachable
  }
}

/** Runs once per successful overview (a poll, or a socket frame), whoever fetched it. */
function onOverview(data) {
  if (!isRecord(data)) {
    return
  }

  noticeReconnect(data)
  const runs = list(data.runs).filter(row => isRecord(row) && validId(row.run_id))
  const pending = list(data.pending).filter(item => isRecord(item) && typeof item.code === 'string')
  const shown = $project.get()

  // A project this Hermes no longer lists (or a backend with no projects at all): the page goes back to the default.
  if (shown && !list(data.projects).some(p => isRecord(p) && p.path === shown)) {
    setProject(null)
  }

  setNavLabel(num(data.counts?.waiting) ?? pending.length, serveOf(data), projectsOf(data).none)
  noticeRestart(data)

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
    void announceKnown(finished, fresh)
  }
}

/**
 * A run that ended `failed` may be a stop at a limit its row does not say yet (roko's state stays failed; the row
 * learns `budget_stop` a refresh later, dogfood R2-2): read its card first (at most 4 s), so the notice says how
 * the run really ended.
 */
async function announceKnown(finished, fresh) {
  const known = await Promise.all(
    finished.map(async row => {
      if (row.state !== 'failed' || row.budget_stop) {
        return row
      }

      try {
        const card = await Promise.race([
          // Always asked afresh: a card cached a moment ago may still say running.
          queryClient.fetchQuery({ queryFn: () => fetchRunCard(row.run_id), queryKey: KEYS.run(row.run_id), staleTime: 0 }),
          new Promise(resolve => setTimeout(() => resolve(null), 4_000))
        ])

        return isRecord(card) && capStopped(card) ? { ...row, budget_stop: card.budget_stop ?? true, headline: text(card.headline) } : row
      } catch {
        return row
      }
    })
  )

  announce(known, fresh)
}

/** How many of a plan's tasks run at once: its widest wave, within the plan's own limit. */
function atOnce(waves, maxParallel) {
  const widest = Math.max(0, ...waves.map(wave => list(wave).length))
  const limit = num(maxParallel)

  return limit !== null && limit > 0 ? Math.min(widest, limit) : widest
}

function parallelWords(waves, maxParallel) {
  const n = atOnce(waves, maxParallel)

  return n > 1 ? `${n} at once` : 'one task at a time'
}

/** How a run ended, in a word: a plan generation writes a plan, it does not "succeed". */
function endWord(state, kind) {
  if (kind === 'plan_generate') {
    return state === 'succeeded' ? 'plan written' : state === 'failed' ? 'planning failed' : stateInfo(state).word
  }

  return stateInfo(state).word
}

/** One aggregated toast + one native notification per change; a pet line and a sound per run and item. */
function announce(finished, fresh) {
  const parts = []

  if (finished.length === 1) {
    parts.push(
      finished[0].kind === 'plan_generate'
        ? endWord(finished[0].state, 'plan_generate')
        : capStopped(finished[0])
          ? `run stopped at ${dayStopped(finished[0]) ? 'today’s limit' : 'its cap'}`
          : `run ${stateInfo(finished[0].state).word}`
    )
  } else if (finished.length > 1) {
    parts.push(`${finished.length} runs finished`)
  }

  if (fresh.length) {
    parts.push(fresh.length === 1 ? '1 item waits on you' : `${fresh.length} items wait on you`)
  }

  const lines = [
    ...finished.map(row => (finished.length === 1 ? clip(row.label || row.run_id, 80) : `${runWord(row)}: ${clip(row.label || row.run_id, 80)}`)),
    ...fresh.map(item => `waiting: ${clip(item.title || item.question || item.code, 80)}`)
  ]
  const shown = lines.slice(0, 3)

  if (lines.length > shown.length) {
    shown.push(`and ${lines.length - shown.length} more`)
  }

  // One finished run opens that run; anything waiting opens the inbox.
  const target = finished.length === 1 && !fresh.length ? { run: finished[0].run_id } : { tab: fresh.length ? 'waiting' : 'runs' }
  const title = `roko: ${parts.join(' · ')}`
  const bad = finished.some(row => ['failed', 'unverified', 'interrupted'].includes(row.state) && !capStopped(row))

  // The person watched it end on its page: the stamp, the sweep and the receipt said it; no toast over the stream.
  if (finished.length === 1 && !fresh.length && watching(text(finished[0].run_id))) {
    sayRunEnded(finished[0])

    return
  }

  host.notify({
    action: { label: 'Open roko', onClick: () => openRoko(target) },
    detail: shown.slice(1).join(' · ') || undefined,
    kind: fresh.length || bad ? 'warning' : 'success',
    message: shown[0] ?? '',
    title,
    // A run's end is news, not an interruption: Hermes would put a warning with a key at the top, over the
    // chat's answer, until dismissed. Bottom right, gone by itself; what waits on the person stays on top.
    ...(fresh.length ? {} : { durationMs: 8_000, placement: 'bottom-right' })
  })

  try {
    doors?.os?.notify?.({ activate: pathFor(target), body: shown.join('\n'), onActivate: () => applyView(target), title })
  } catch {
    // A missing desktop bridge must not break the toast above.
  }

  finished.forEach(row => sayRunEnded(row))
  fresh.forEach(item => sayWaiting(text(item.code), item.title || item.question))
}

// -- the pet and the sounds -----------------------------------------------------

function petSay(line, options) {
  try {
    doors?.pet?.say?.(clip(line, 120), options)
  } catch {
    // The pet is a nicety.
  }
}

/** A run ended (a row, or a run.ended event): one pet line (replaced, never stacked, whoever heard it first) and one sound. */
function sayRunEnded(run) {
  const runId = text(run.run_id)
  const state = text(run.state)

  if (!validId(runId) || seen.ended.has(runId)) {
    return
  }

  seen.ended.add(runId)

  const p = isRecord(run.progress) && num(run.progress.total) ? { ...EMPTY_PROGRESS, ...run.progress } : null
  const stop = capStopped(run)
  const word = run.kind === 'plan_generate' ? endWord(state, run.kind) : state === 'succeeded' ? 'passed' : runInfo(run).word

  petSay(`roko · ${word}: ${clip(text(run.label) || runId, 56)}${p ? ` · ${p.passed}/${p.total}` : ''}${num(run.cost_usd) !== null ? ` · ${money(run.cost_usd)}` : ''}`, {
    id: `run:${runId}`,
    tone: ['failed', 'unverified', 'interrupted'].includes(state) && !stop ? 'error' : 'info',
    ttlMs: 9_000
  })
  if (state === 'succeeded') {
    play('run', false, { rungs: passedPlaces(queryClient.getQueryData(KEYS.run(runId)) ?? run) })
    markLook('star', 5_000)
  } else {
    play(state === 'failed' || stop ? 'down' : 'check')
  }
}

/** Something new waits on the person: one pet line per item, and two pips. */
function sayWaiting(code, title) {
  if (!code || seen.waiting.has(code)) {
    return
  }

  seen.waiting.add(code)
  petSay(`roko needs you: ${clip(title || code, 90)}`, { id: `wait:${code}`, tone: 'wait', ttlMs: 12_000 })
  play('you')
}

/** Off until the person turns them on (ctx.storage), never while the window is hidden. */
const $sound = atom(false)
/** Studio: a soft tick for every tool call too (spec v3 §3.8), for recordings. Off by default. */
const $studio = atom(false)
const audio = { ctx: null, last: new Map() }
/**
 * The ladder is a scale (spec v3 §3.8): cheap C4, mid F4, strong B♭4, top E♭5, a rung's place in its ladder; a fifth
 * rung goes on in fourths. A run's sounds are its route.
 */
const RUNG_HZ = [261.63, 349.23, 466.16, 622.25]
const rungHz = i => RUNG_HZ[clamp(Math.round(num(i) ?? 0), 0, 99)] ?? RUNG_HZ[3] * (4 / 3) ** (Math.round(i) - 3)

/** Each sound as notes `[Hz, seconds, waveform, start s, level dB]`; some take where on the ladder it happened. */
function soundNotes(name, at = {}) {
  switch (name) {
    case 'check':
      return [[2400, 0.018, 'sine', 0, -24]]
    case 'fail':
      return [[110, 0.12, 'square', 0, -20]]
    case 'climb':
      // the old rung's pitch, then the new one's
      return [
        [rungHz(at.from), 0.07, 'triangle', 0, -20],
        [rungHz(at.to), 0.07, 'triangle', 0.07, -20]
      ]
    case 'task':
      // its rung's pitch, then a fifth above
      return [
        [rungHz(at.rung), 0.06, 'triangle', 0, -22],
        [rungHz(at.rung) * 1.5, 0.06, 'triangle', 0.06, -22]
      ]
    case 'run': {
      // an arpeggio of the rungs the run passed on, up to the octave: a run that passed on cheap is low and short
      const used = [...new Set(list(at.rungs).map(r => Math.round(num(r) ?? 0)))].sort((x, y) => x - y)
      const steps = [...(used.length ? used : [0]).map(rungHz), rungHz(used.length ? used[used.length - 1] : 0) * 2].slice(-4)

      return steps.map((hz, i) => [hz, 0.07, 'triangle', i * 0.07, -20])
    }
    case 'down':
      // two notes down: a run failed, or stopped at its cap
      return [
        [392, 0.09, 'triangle', 0, -20],
        [293.66, 0.12, 'triangle', 0.09, -20]
      ]
    case 'you':
      return [
        [880, 0.05, 'sine', 0, -18],
        [880, 0.05, 'sine', 0.12, -18]
      ]
    case 'lesson':
      // a glass chime: two partials, a long decay
      return [
        [1600, 0.3, 'sine', 0, -24],
        [2400, 0.3, 'sine', 0, -27]
      ]
    case 'tick':
      return [[3200, 0.006, 'square', 0, -32]]
    case 'detent':
      return [[1800, 0.008, 'square', 0, -30]]
    case 'start':
      return [
        [1568, 0.04, 'triangle', 0, -24],
        [2093, 0.05, 'triangle', 0.05, -24]
      ]
    default:
      return null
  }
}

/** The theme offer is shown once per window profile: answered either way, it does not come back. */
const $themeOffered = atom(false)

function answerThemeOffer(use) {
  $themeOffered.set(true)

  try {
    doors?.storage?.set?.('theme-offered', true)
  } catch {
    // Kept for this window only.
  }

  if (use) {
    requestTheme(ROKO_THEME.name)
  }
}

/**
 * The first time the page opens, roko offers its own theme (the one every picture of it shows), once. Nothing
 * when the roko theme is on already, or on a Hermes without themes for plugins.
 */
function ThemeOffer() {
  const offered = useValue($themeOffered)
  // The skin Hermes wears now (its root element says it; older shells say nothing, and get no offer).
  const current = typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-hermes-theme')

  if (offered || !current || current === ROKO_THEME.name) {
    return null
  }

  return h(
    'div',
    { className: 'rk-theme-offer', 'data-testid': 'theme-offer', role: 'note' },
    h('span', { 'aria-hidden': 'true', className: 'rk-swatches' }, h('i', { 'data-swatch': 'alu' }), h('i', { 'data-swatch': 'graphite' }), h('i', { 'data-swatch': 'live' }), h('i', { 'data-swatch': 'orange' })),
    h('span', { className: 'rk-theme-offer-text' }, 'roko has its own theme: aluminium by day, graphite by night. Use it? You can change it any time in Settings ▸ Plugins ▸ roko.'),
    h(Key, { onClick: () => answerThemeOffer(true), size: 's', testId: 'theme-offer-use', tone: 'primary' }, 'use the roko theme'),
    h(Key, { onClick: () => answerThemeOffer(false), size: 's', testId: 'theme-offer-no' }, 'not now')
  )
}

function setSound(on) {
  $sound.set(Boolean(on))

  try {
    doors?.storage?.set?.('sound', Boolean(on))
  } catch {
    // Kept for this window only.
  }

  if (on) {
    play('check', true)
  } else {
    // Off is off: the audio device is let go until the person turns sounds on again.
    closeAudio()
  }
}

function setStudio(on) {
  $studio.set(Boolean(on))

  try {
    doors?.storage?.set?.('sound-studio', Boolean(on))
  } catch {
    // Kept for this window only.
  }
}

/** Where a task stands on its run's ladder, as a place (0 the cheapest), from the cached card; 0 when unknown. */
function rungPlace(runId, taskId) {
  const card = queryClient.getQueryData(KEYS.run(runId))
  const rungs = list(card?.ladder).filter(isRecord).map(r => text(r.rung))
  const task = list(card?.tasks).find(t => isRecord(t) && text(t.task_id) === text(taskId))
  const tries = list(task?.climb).filter(isRecord)

  return Math.max(0, rungs.indexOf(text(tries[tries.length - 1]?.rung)))
}

/** The rungs a run's tasks passed on, as places, from its card: the notes of its arpeggio. */
function passedPlaces(run) {
  const rungs = list(run?.ladder).filter(isRecord).map(r => text(r.rung))

  return list(run?.tasks)
    .filter(t => isRecord(t) && PASSED.has(text(t.outcome)))
    .map(t => {
      const tries = list(t.climb).filter(isRecord)

      return rungs.indexOf(text(tries[tries.length - 1]?.rung))
    })
    .filter(i => i >= 0)
}

/**
 * A short sound (spec v3 §3.8). `explicit`: the person just pressed something, so it plays even under reduced
 * motion. `at`: where on the ladder it happened (`rung`, `from`/`to`, the run's `rungs`).
 */
function play(name, explicit = false, at = {}) {
  if (!$sound.get() || !doors || isHidden() || (reducedMotion() && !explicit) || (name === 'tick' && !$studio.get())) {
    return
  }

  const notes = soundNotes(name, at)
  const now = Date.now()

  if (!notes || now - (audio.last.get(name) ?? 0) < (name === 'tick' ? 40 : 90)) {
    return
  }

  audio.last.set(name, now)

  try {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext

    if (!Ctx) {
      return
    }

    audio.ctx = audio.ctx ?? new Ctx()

    const ctx = audio.ctx

    if (ctx.state === 'suspended') {
      void ctx.resume?.()
    }

    const t0 = ctx.currentTime + 0.01

    notes.forEach(([freq, secs, type, at, level]) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      // The spec's level in dB, under one quiet master (0.6): never louder than a click.
      const peak = Math.max(0.0002, 10 ** (level / 20) * 0.6)

      osc.type = type
      osc.frequency.setValueAtTime(freq, t0 + at)
      gain.gain.setValueAtTime(0.0001, t0 + at)
      gain.gain.exponentialRampToValueAtTime(peak, t0 + at + 0.004)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + secs)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(t0 + at)
      osc.stop(t0 + at + secs + 0.02)
    })
  } catch {
    // No audio device: silence is fine.
  }
}

function closeAudio() {
  try {
    void audio.ctx?.close?.()
  } catch {
    // Already closed.
  }

  audio.ctx = null
  audio.last.clear()
}

// -- Hermes plugin events: plugin.roko.run.started · run.ended · waiting --------------

function eventPayload(event) {
  return isRecord(event) && event.replayed !== true && isRecord(event.payload) ? event.payload : null
}

function onRunStarted(event) {
  const p = eventPayload(event)

  if (!p || !validId(p.run_id)) {
    return
  }

  markFresh(p.run_id)
  void queryClient.invalidateQueries({ queryKey: KEYS.overview })
  openLive()

  // The New run device says so itself; a run a chat started gets one toast with a way to watch it.
  if (p.source !== 'ui') {
    host.notify({
      action: { label: 'Watch', onClick: () => openRoko({ run: p.run_id }) },
      kind: 'info',
      message: clip(p.label, 100),
      title: p.kind === 'plan_generate' ? 'roko: writing a plan' : `roko: run started${num(p.max_usd) !== null ? ` · cap ${money(p.max_usd)}` : ''}`
    })
    play('start')
  }
}

function onRunEnded(event) {
  const p = eventPayload(event)

  if (!p || !validId(p.run_id)) {
    return
  }

  void queryClient.invalidateQueries({ queryKey: KEYS.overview })
  void queryClient.invalidateQueries({ queryKey: KEYS.run(p.run_id) })
  sayRunEnded(p)
}

function onWaiting(event) {
  const p = eventPayload(event)

  if (!p) {
    return
  }

  void queryClient.invalidateQueries({ queryKey: KEYS.overview })
  void queryClient.invalidateQueries({ queryKey: KEYS.pending })
  sayWaiting(text(p.code), text(p.title) || text(p.question))
}

// -- polling ----------------------------------------------------------------

function startPolling() {
  let timer = null
  let stopped = false
  let nextAt = 0
  let downSince = null
  let startingSince = null
  // The overview says roko serve is out of reach (the backend calls it so only after two missed looks).
  const down = data => isRecord(data) && isRecord(data.connection) && data.connection.reachable !== true
  // 0.7: the shown project's serve is starting: look every 2 s until it answers (90 s at most).
  const starting = data => serveOf(data)?.state === 'starting'
  // While it is down, look again every 2.5 s for its first minute, so a serve just started is seen within seconds
  // (`hermes roko init` starts one); then at the usual pace.
  const delay = () => {
    const data = queryClient.getQueryData(projectKey(KEYS.overview))

    downSince = down(data) ? (downSince ?? Date.now()) : null
    startingSince = starting(data) ? (startingSince ?? Date.now()) : null

    if (isHidden()) {
      return OVERVIEW_HIDDEN_MS
    }

    if (startingSince !== null && Date.now() - startingSince < SERVE_WAIT_MS) {
      return SERVE_POLL_MS
    }

    return downSince !== null && Date.now() - downSince < 60_000 ? OFFLINE_RECHECK_MS : pollMs(OVERVIEW_MS)
  }
  const schedule = ms => {
    clearTimeout(timer)
    nextAt = Date.now() + ms
    timer = setTimeout(() => void tick(), ms)
  }
  // An overview from any fetch (a page's own) that says roko is down, or starting, brings the next look forward.
  const unwatch = queryClient.getQueryCache().subscribe(event => {
    const key = event?.query?.queryKey
    const data = event?.query?.state?.data
    const soon = starting(data) ? SERVE_POLL_MS : down(data) ? OFFLINE_RECHECK_MS : null

    if (!stopped && event?.type === 'updated' && key?.[0] === ID && key?.[1] === 'overview' && soon !== null && nextAt - Date.now() > soon) {
      schedule(soon)
    }
  })

  const tick = async () => {
    if (stopped) {
      return
    }

    let mounted = false
    const project = $project.get()

    try {
      // While roko serve is down, every look asks again (a fresh answer, not the cached one of a moment ago).
      const staleTime = down(queryClient.getQueryData(projectKey(KEYS.overview, project))) ? 0 : OVERVIEW_MS - 1_000

      mounted = isRecord(await queryClient.fetchQuery({ queryFn: () => fetchOverview(project), queryKey: projectKey(KEYS.overview, project), retry: false, staleTime }))
    } catch (error) {
      // The error lands in the query; observers show it. A picked project the backend does not know: the default.
      if (project && error instanceof RokoError && (error.code === 'not_found' || error.code === 'invalid')) {
        setProject(null)
      }
    }

    // The backend answers: open the live socket (once; it reconnects on its own).
    if (mounted && !stopped) {
      openLive()
    }

    checkLive()

    if (!stopped) {
      schedule(delay())
    }
  }

  schedule(0)

  return () => {
    stopped = true
    clearTimeout(timer)
    unwatch()
  }
}

function watchOverview() {
  return queryClient.getQueryCache().subscribe(event => {
    try {
      const key = event?.query?.queryKey

      // Only the project this window shows: another one's cached overview is not news here.
      if (event?.type !== 'updated' || event.action?.type !== 'success' || key?.[0] !== ID || key?.[1] !== 'overview' || (key[2] ?? null) !== $project.get()) {
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

// --- Around the chat: the monitor pane, the empty-chat card, the composer key,
// session lights, the theme, the settings page

/** The newest active run as a compact live instrument: display, ticker, sequencer in miniature, now. */
function MonitorRun({ row }) {
  const runId = row.run_id
  const query = useRun(runId)
  const run = lastKnown(isRecord(query.data) ? query.data : row, useReachable())
  const waiting = list(run.waiting).filter(item => isRecord(item) && !answered(item))

  return h(
    'div',
    { className: 'rk-monitor-run', 'data-state': text(run.state) },
    // The run card, as in the chat, narrow: its glass goes two by two (roko's design system §4.8).
    h(RunCardCompact, { fallback: row, runId, size: 'S' }),
    waiting.length && run.state !== 'last_seen' ? waiting.slice(0, 2).map(item => h(PendingCard, { compact: true, item, key: text(item.code) || text(item.decision_id) })) : null
  )
}

/** Nothing running: the mark asleep, the last verdict, and the key for a new run (spec v3 §5.9). */
function MonitorIdle({ last, canAct }) {
  return h(
    'div',
    { className: 'rk-monitor-idle' },
    h(Well, { className: 'rk-monitor-sleep' }, h(Dots, { label: 'no run going', size: 'M', tone: 'dim', value: 'NO RUN' })),
    last
      ? h(
          'button',
          { className: 'rk-monitor-last', onClick: () => openRoko({ run: last.run_id }), type: 'button' },
          h(LED, { tone: runChannel(last, false) }),
          h('span', null, clip(last.label || last.run_id, 48)),
          h('span', { className: 'roko-muted' }, `${runInfo(last).word} · ${agoText(last.started_at)}`)
        )
      : null,
    canAct ? h(Key, { kbd: comboLabel(NEW_RUN_COMBO), onClick: () => openComposer({ mode: 'run' }), size: 'l', tone: 'primary' }, 'new run') : null
  )
}

/** The monitor pane beside the chat (PANES_AREA, right side): roko's newest live run at a glance (spec v3 §5.9). */
function MonitorPane() {
  const overview = useOverview()
  const { canAct } = useLimits()
  const data = overview.data
  const runs = list(data?.runs).filter(row => isRecord(row) && validId(row.run_id))
  const row = runs.find(isActiveRun) ?? null
  const live = runs.filter(isActiveRun).length
  const waiting = num(data?.counts?.waiting) ?? 0

  return h(
    'div',
    { className: 'roko roko-monitor', 'data-testid': 'monitor' },
    h(
      'div',
      { className: 'rk-monitor-head' },
      h('span', { className: 'rk-chip-mark' }, h(Dots, { label: 'roko', size: 'XS', value: 'ROKO' })),
      h(Dot, { label: `connection ${connectionTone(overview)}`, tone: connectionTone(overview) }),
      h('span', { className: 'roko-flex' }),
      live ? h('span', { className: 'rk-monitor-count' }, `${live} live`) : null,
      waiting ? h(Key, { onClick: () => openRoko({ tab: 'waiting' }), size: 's', tone: 'primary' }, `${waiting} waiting`) : null,
      h(Button, { 'aria-label': 'Open roko', onClick: () => openRoko(row ? { run: row.run_id } : { tab: 'runs' }), size: 'icon-xs', type: 'button', variant: 'ghost' }, h(Codicon, { name: 'link-external', size: '0.8rem' }))
    ),
    data ? h(SetupStrip, null) : null,
    !data && overview.error
      ? h(ErrorNote, { compact: true, error: overview.error, onRetry: () => void overview.refetch() })
      : row
        ? h(MonitorRun, { key: row.run_id, row })
        : h(MonitorIdle, { canAct: canAct && Boolean(data), last: runs[0] ?? null })
  )
}

/** The workspace's ladder in a line (spec v3 §5.10): "starts on gpt-oss-120b · climbs to glm-4.7, gpt-5.4-mini". */
function ladderLine(ladder) {
  const rungs = list(ladder).filter(r => isRecord(r) && r.chat_ok !== false)
  const name = r => text(r.slug) || text(r.model)

  return rungs.length ? `starts on ${name(rungs[0])}${rungs.length > 1 ? ` · moves up to ${rungs.slice(1).map(name).join(', ')} only after failed checks` : ''}` : ''
}

/** An empty chat: hand the work to roko. The chips fill this chat's composer; the person sends it. */
function DelegateCard({ sessionId }) {
  const overview = useOverview()
  const conn = isRecord(overview.data?.connection) ? overview.data.connection : null

  if (!conn?.reachable) {
    return null
  }

  const fill = async example => {
    const draft = `Use roko to ${example.charAt(0).toLowerCase()}${example.slice(1)} Cap it at $1.`

    try {
      await host.composer?.setDraft?.(sessionId || null, draft)
      host.composer?.focus?.(sessionId || null)
    } catch {
      // The composer is the host's: nothing to undo here.
    }
  }

  return h(
    'div',
    { className: 'roko roko-delegate', 'data-testid': 'delegate' },
    h('span', { className: 'rk-wordmark rk-delegate-mark' }, h(Dots, { label: 'roko', size: 'S', value: 'ROKO' })),
    h(
      'div',
      { className: 'rk-delegate-body' },
      h(ModLabel, null, 'delegate checked work to roko'),
      h('p', { className: 'rk-delegate-text' }, 'Hand checked work to roko: it plans, runs each task on its own branch, and calls it done only when your checks pass.'),
      ladderLine(overview.data?.ladder) ? h('p', { className: 'rk-delegate-ladder', 'data-testid': 'delegate-ladder' }, ladderLine(overview.data?.ladder)) : null,
      h(
        'div',
        { className: 'roko-examples' },
        EXAMPLES.map((example, i) =>
          h('button', { className: 'roko-example', key: i, onClick: () => void fill(example), title: example, type: 'button' }, EXAMPLE_CHIPS[i] ?? clip(example, 40))
        )
      )
    )
  )
}

/** "→ roko" beside the model pill: the chat draft becomes a New run, prefilled. */
function ComposerKey() {
  const { canAct } = useLimits()
  const overview = useOverview()

  if (!canAct || !overview.data) {
    return null
  }

  const send = async () => {
    let draft = ''

    try {
      draft = text(await host.composer?.getDraft?.(null))
    } catch {
      draft = ''
    }

    if (!$composerLeader.get()) {
      openRoko({ tab: 'runs' })
    }

    openComposer({ mode: 'run', prompt: draft.slice(0, MAX_PROMPT) })
  }

  return h(
    Tip,
    { label: 'Send this draft to roko as a new run' },
    h('button', { 'aria-label': 'Send to roko', className: 'roko rk-composerkey', 'data-testid': 'composer-key', onClick: () => void send(), type: 'button' }, h('span', { 'aria-hidden': 'true' }, '→'), 'roko')
  )
}

/** A light on the sidebar row of a chat whose roko run is going (blue) or waits on the person (orange). */
function SessionLed({ sessionId }) {
  const overview = useOverview()
  const data = overview.data
  const run = list(data?.runs).find(row => isRecord(row) && isActiveRun(row) && text(row.session_id) === sessionId && validId(row.run_id))

  if (!run) {
    return null
  }

  const waiting = list(data?.pending).some(item => isRecord(item) && item.run_id === run.run_id)
  const words = `roko: ${clip(run.label, 40)} · ${waiting ? 'waiting on you' : 'running'}`

  return h(Tip, { label: words }, h('span', { 'aria-label': words, className: 'roko rk-sessionled', 'data-testid': 'session-led', role: 'img' }, h(LED, { blink: waiting ? 'fast' : 'slow', size: 's', tone: waiting ? 'you' : 'agent' })))
}

/**
 * roko's Hermes theme (roko's design system §3): aluminium by day, graphite by night, and the four signals.
 * Hermes has no rose token, so it sets `--roko-live`; under another theme live mixes that theme's red and purple.
 */
const ROKO_THEME = {
  colors: {
    accent: '#e9eae6',
    accentForeground: '#111213',
    background: '#e3e4e1',
    border: '#c9cac6',
    card: '#f1f1ee',
    cardForeground: '#111213',
    composerRing: '#ff5f1f',
    destructive: '#bb2622',
    destructiveForeground: '#ffffff',
    foreground: '#111213',
    input: '#a5a7a3',
    midground: '#ff5f1f',
    midgroundForeground: '#1a0b04',
    muted: '#e9eae6',
    mutedForeground: '#606366',
    popover: '#f8f8f5',
    popoverForeground: '#111213',
    primary: '#ff5f1f',
    primaryForeground: '#1a0b04',
    ring: '#ff5f1f',
    secondary: '#e9eae6',
    secondaryForeground: '#111213',
    sidebarBackground: '#dcddda',
    sidebarBorder: '#c9cac6',
    userBubble: '#f1f1ee',
    userBubbleBorder: '#c9cac6'
  },
  customCSS:
    ':root{--ui-orange:#ff5f1f;--ui-blue:#2252e8;--ui-green:#0a7038;--ui-red:#bb2622;--ui-purple:#5546c9;--ui-yellow:#b7790b;--roko-live:#2252e8;--roko-you-text:#b23a08}' +
    ':root.dark{--ui-orange:#ff6a2b;--ui-blue:#6b95ff;--ui-green:#3fcf7f;--ui-red:#ff5a50;--ui-purple:#aca3ff;--ui-yellow:#f2b632;--roko-live:#6b95ff;--roko-you-text:#ff7f45}',
  darkColors: {
    accent: '#232427',
    accentForeground: '#ecebe6',
    background: '#141516',
    border: '#2c2e31',
    card: '#1c1d1f',
    cardForeground: '#ecebe6',
    composerRing: '#ff6a2b',
    destructive: '#ff5a50',
    destructiveForeground: '#141516',
    foreground: '#ecebe6',
    input: '#3e4043',
    midground: '#ff6a2b',
    midgroundForeground: '#1a0b04',
    muted: '#232427',
    mutedForeground: '#8a8c8b',
    popover: '#1c1d1f',
    popoverForeground: '#ecebe6',
    primary: '#ff6a2b',
    primaryForeground: '#1a0b04',
    ring: '#ff6a2b',
    secondary: '#232427',
    secondaryForeground: '#ecebe6',
    sidebarBackground: '#0f1011',
    sidebarBorder: '#2c2e31',
    userBubble: '#1c1d1f',
    userBubbleBorder: '#2c2e31'
  },
  description: 'roko’s control surface: aluminium by day, graphite by night, black glass for every number that changes; blue while it works, orange when it needs you.',
  label: 'roko',
  name: 'roko',
  // Archivo for words; Martian Mono at width 87.5% for the roko page's labels and figures (its --rk-mono). Hermes
  // injects the stylesheet while this theme is on; without it every face falls back to Hermes' own.
  typography: {
    fontMono:
      '"JetBrains Mono", "Cascadia Code", "Cascadia Mono", "DejaVu Sans Mono", "Liberation Mono", "Noto Sans Mono", "Noto Mono", "SF Mono", ui-monospace, Menlo, Monaco, Consolas, monospace, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji',
    fontSans:
      '"Archivo", "Segoe WPC", "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", emoji',
    fontUrl: 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Martian+Mono:wdth,wght@87.5,100..800&display=swap'
  }
}

/** Settings ▸ Plugins ▸ roko: the connection, the limits, sounds, the theme, and the doctor's checks. */
function SettingsPage() {
  const overview = useOverview()
  const health = useHealth()
  const live = useValue($live)
  const sound = useValue($sound)
  const studio = useValue($studio)
  const limits = useLimits()
  const data = overview.data
  const conn = isRecord(data?.connection) ? data.connection : null
  const checks = list(health.data).filter(isRecord)
  // 0.7: the shown project's serve: its state, who started it and when it stops by itself, and its keys.
  const serve = serveOf(data)
  const look = serve ? SERVE_LOOK[serve.state] : null
  const TONE = { fail: 'bad', ok: 'good', warn: 'warn' }
  const GLYPH = { fail: '✗', ok: '✓', warn: '!' }
  const row = (label, value) => h('div', { className: 'rk-set-row' }, h('span', { className: 'rk-set-key' }, label), h('span', { className: 'rk-set-value' }, value))

  return h(
    'div',
    { className: 'roko roko-settings', 'data-testid': 'roko-settings' },
    h('div', { className: 'rk-set-head' }, h(Well, { className: 'rk-set-well' }, h(Dots, { label: 'roko', size: 'XL', value: 'ROKO' })), h('div', null, h('h2', { className: 'rk-set-title' }, 'roko'), h('p', { className: 'roko-muted' }, 'Checked work, delegated: plans, runs and their checks, live.'))),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, null, 'connection'),
      row('roko serve', conn ? h('span', null, h(Dot, { tone: connectionTone(overview) }), ` ${text(conn.url) || '—'}${conn.version ? ` · v${text(conn.version)}` : ''}${conn.status ? ` · ${text(conn.status)}` : ''}`) : overview.error ? describe(overview.error).message : 'connecting…'),
      serve
        ? row(
            'serve',
            h(
              'span',
              { 'data-testid': 'settings-serve' },
              h(LED, { blink: look.blink, size: 's', tone: look.tone }),
              ` ${[look.word, serve.name, serve.pid ? `pid ${serve.pid}` : '', serve.startedBy === 'hermes' ? 'started by Hermes' : serve.startedBy === 'other' ? 'started outside Hermes' : '', serve.idle ? `stops after ${plural(serve.idle, 'idle minute')}` : ''].filter(Boolean).join(' · ')}`
            )
          )
        : null,
      serve?.actions.length ? h('div', { className: 'rk-keyrow' }, h(ServeKeys, { serve })) : null,
      row('credential', text(conn?.credential) || '—'),
      row('live stream', h('span', null, h(LED, { blink: live.state === 'open' ? 'slow' : undefined, size: 's', tone: live.state === 'open' ? 'agent' : 'off' }), ` ${live.state === 'open' ? 'live: roko’s events stream in' : live.state === 'connecting' ? 'connecting' : live.state === 'stale' ? 'quiet: asking every few seconds meanwhile' : 'off: asking every few seconds'}`))
    ),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, null, 'limits'),
      row('per run', limits.maxRun !== null ? `at most ${money(limits.maxRun)}` : 'no cap'),
      row('per day', limits.maxDay !== null ? `${money(limits.today)} of ${money(limits.maxDay)} · ${money(limits.left)} left` : money(limits.today)),
      row('actions from the app', limits.canAct ? 'on: start, approve, cancel and merge from here' : 'off: answer in chat with /roko'),
      h('p', { className: 'roko-muted' }, 'The caps live in the plugin’s config (hermes roko setup). The app never spends past them.')
    ),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, null, 'sound'),
      h(
        'div',
        { className: 'roko-field roko-field-row' },
        h(Switch, { checked: sound, id: 'roko-set-sound', onCheckedChange: value => setSound(Boolean(value)) }),
        h('label', { htmlFor: 'roko-set-sound' }, 'Play short blips: a check passes, a task passes, a run ends, roko needs you')
      ),
      h(
        'div',
        { className: 'roko-field roko-field-row' },
        h(Switch, { checked: studio, disabled: !sound, id: 'roko-set-studio', onCheckedChange: value => setStudio(Boolean(value)) }),
        h('label', { htmlFor: 'roko-set-studio' }, 'Studio: a soft tick for every tool call too (for recordings)')
      ),
      h('p', { className: 'roko-muted' }, 'Off by default. Each model has its note: a task that moves up a model steps up the scale, and a run that passed plays the models it passed on. Never while the window is hidden; with reduced motion, only when you press a key.')
    ),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, null, 'theme'),
      h(
        'div',
        { className: 'rk-set-theme' },
        h('span', { 'aria-hidden': 'true', className: 'rk-swatches' }, h('i', { 'data-swatch': 'alu' }), h('i', { 'data-swatch': 'graphite' }), h('i', { 'data-swatch': 'live' }), h('i', { 'data-swatch': 'orange' })),
        h('span', null, 'Aluminium by day, graphite by night, blue while roko works, orange for what needs you.'),
        h(Key, { onClick: () => requestTheme(ROKO_THEME.name), size: 's' }, 'use the roko theme')
      )
    ),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, { right: h(Key, { onClick: () => void health.refetch(), size: 's' }, health.isFetching ? h(Spinner, null) : null, 'check again') }, 'health'),
      health.error ? h(ErrorNote, { compact: true, error: health.error }) : null,
      checks.length
        ? h(
            'div',
            { className: 'roko-checks' },
            checks.map((check, index) =>
              h(
                'div',
                { className: 'roko-check', 'data-status': text(check.status), key: `${text(check.name)}:${index}` },
                h('span', { className: 'roko-glyph', 'data-tone': TONE[check.status] ?? 'muted' }, GLYPH[check.status] ?? '·'),
                h('div', { className: 'roko-check-main' }, h('span', { className: 'roko-strong' }, text(check.name)), check.detail ? h('span', { className: 'roko-muted' }, text(check.detail)) : null, check.hint ? h('span', { className: 'roko-check-hint' }, text(check.hint)) : null)
              )
            )
          )
        : health.isLoading
          ? h(Spinner, { label: 'Checking…' })
          : null
    ),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, null, 'keys'),
      row('new run', h(Kbd, { size: 'sm', variant: 'ghost' }, comboLabel(NEW_RUN_COMBO))),
      row('on the roko page', 'n new run · j k move · [ ] views · Esc close · r refresh')
    )
  )
}

/** Show the monitor pane: an explicit action, so it reveals the pane and its zone. Older hosts open the page. */
function showMonitor() {
  if (typeof host.revealPane === 'function') {
    host.revealPane(PANE_ID)
  } else {
    openRoko({ tab: 'runs' })
  }
}

// --- Styles: Tailwind only knows the classes the app itself uses, so the control
// surface lives here. Page colours come only from the app's --ui-* tokens
// (through the --rk-* aliases); the display glass and its lit pixels are the
// one deliberate exception, built from black and white so they read the same
// in every theme. No literal colours. Motion stops under
// prefers-reduced-motion.

const CSS = `
.roko{--rk-body:var(--ui-surface-background);--rk-module:var(--ui-widget-surface-background,var(--ui-bg-editor));--rk-module-2:color-mix(in oklab,var(--rk-module) 94%,var(--rk-ink));--rk-sunk:color-mix(in oklab,var(--rk-body) 95%,var(--rk-ink));--rk-ink:var(--ui-text-primary);--rk-ink-2:var(--ui-text-secondary);--rk-ink-3:var(--ui-text-tertiary);--rk-ink-4:var(--ui-text-quaternary);--rk-stroke:var(--ui-stroke-tertiary);--rk-stroke-2:var(--ui-stroke-secondary);--rk-stroke-soft:var(--ui-stroke-quaternary);--rk-hover:color-mix(in oklab,var(--rk-ink) 5%,transparent);--rk-select:color-mix(in oklab,var(--rk-ink) 8%,transparent);--rk-live:var(--roko-live,var(--ui-blue));--rk-pass:var(--ui-green);--rk-fail:var(--ui-red);--rk-you:var(--ui-orange);--rk-learn:var(--rk-ink-2);--rk-you-text:var(--roko-you-text,color-mix(in oklab,var(--rk-you) 76%,var(--rk-ink)));--ph-void:#0b0c0d;--ph-glass:#0e0f10;--ph-glass-2:#151618;--ph-rule:#1f2022;--ph-rule-2:#2c2d30;--ph-phantom:#1d1e1f;--ph-ghost:#3b3c3e;--ph-dim:#a29f97;--ph-ink:#cdcac2;--ph-bright:#f2f0e9;--ph-bone:#f2f0e9;--ph-live:#7aa6ff;--ph-pass:#4be092;--ph-fail:#ff5c52;--ph-you:#ff7a3d;--ph-learn:#cdcac2;--ph-black:#000;--ph-seg:#18191b;--ph-label:#55534e;--ph-glow-1:#131415;--ph-glow-1-0:rgba(19,20,21,0);--ph-glow-2:#0d0e0f;--ph-glow-2-0:rgba(13,14,15,0);--ph-scan:rgba(255,255,255,.016);--ph-sheen:rgba(255,255,255,.06);--ph-sheen-2:rgba(255,255,255,.07);--ph-drop:rgba(0,0,0,.9);--ph-swatch-alu:#e3e4e1;--ph-swatch-graphite:#141516;--rk-well:var(--ph-void);--rk-well-2:var(--ph-glass-2);--rk-px-off:var(--ph-phantom);--rk-px-on:var(--ph-bright);--rk-px-dim:var(--ph-dim);--rk-px-agent:var(--ph-live);--rk-px-live:var(--ph-live);--rk-px-pass:var(--ph-pass);--rk-px-you:var(--ph-you);--rk-px-fail:var(--ph-fail);--rk-px-learn:var(--ph-learn);--rk-radius:3px;--rk-radius-m:5px;--rk-radius-l:8px;--rk-mono:"Martian Mono",var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);--t-blip:80ms;--t-quick:140ms;--t-gesture:240ms;--t-passage:600ms;--t-moment:1.2s;--rk-ease:cubic-bezier(.2,.75,.25,1);--rk-ease-lux:cubic-bezier(.22,1,.36,1);--rk-ease-expo:cubic-bezier(.16,1,.3,1);--rk-ease-in:cubic-bezier(.55,.085,.68,.53);--rk-ease-spring:cubic-bezier(.34,1.36,.64,1)}
.roko-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--rk-body);color:var(--rk-ink);font-size:13px;container-type:inline-size}

/* -- the control surface: module labels, wells, dots, lights, keys -------------- */
.rk-mod{display:flex;align-items:baseline;gap:6px;min-width:0;font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;line-height:1;color:var(--rk-ink-3);white-space:nowrap}
.rk-mod-label{overflow:hidden;text-overflow:ellipsis}
.rk-mod-right{margin-left:auto;letter-spacing:.02em;text-transform:none;font-weight:500}
/* the glass: void black with depth, a scanline at the edge of perception, an optional measurement grid (spec v3 §3.2) */
.rk-glass{position:relative;isolation:isolate;overflow:hidden;border-radius:var(--rk-radius-m);color:var(--ph-ink);background:radial-gradient(130% 120% at 30% -10%,var(--ph-glow-1) 0%,var(--ph-glow-1-0) 55%),radial-gradient(90% 90% at 100% 110%,var(--ph-glow-2) 0%,var(--ph-glow-2-0) 60%),var(--ph-void);box-shadow:inset 0 0 0 1px var(--ph-black),inset 0 1px 0 0 var(--ph-sheen),0 1px 0 0 color-mix(in oklab,var(--rk-ink) 6%,transparent),0 18px 40px -26px var(--ph-drop)}
.rk-glass::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;background:repeating-linear-gradient(180deg,var(--ph-scan) 0 1px,transparent 1px 3px)}
.rk-glass[data-grid=true]::after{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;opacity:.9;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='32' height='32'%3E%3Cpath d='M16 13.5v5M13.5 16h5' stroke='%23222325' stroke-width='1'/%3E%3C/svg%3E");background-position:-16px -16px}
.rk-glass .rk-mod{color:var(--ph-dim)}.rk-glass .rk-mod-right{color:var(--ph-dim)}
.rk-well{position:relative;display:flex;align-items:center;gap:10px;min-width:0;padding:6px 9px;border-radius:var(--rk-radius-m);background:var(--ph-void);box-shadow:inset 0 0 0 1px var(--ph-black),inset 0 1px 0 0 var(--ph-sheen-2),0 1px 0 0 color-mix(in oklab,var(--rk-ink) 7%,transparent);color:var(--ph-bright)}
.rk-well .rk-mod{color:var(--ph-dim)}
.rk-dots{display:block;flex:none;overflow:visible;--rk-px:var(--ph-bright)}
.rk-dots[data-tone=bone]{--rk-px:var(--ph-bone)}.rk-dots[data-tone=agent],.rk-dots[data-tone=live]{--rk-px:var(--ph-live)}.rk-dots[data-tone=pass]{--rk-px:var(--ph-pass)}.rk-dots[data-tone=you]{--rk-px:var(--ph-you)}.rk-dots[data-tone=fail]{--rk-px:var(--ph-fail)}.rk-dots[data-tone=learn]{--rk-px:var(--ph-learn)}.rk-dots[data-tone=ink]{--rk-px:var(--ph-ink)}.rk-dots[data-tone=off],.rk-dots[data-tone=dim]{--rk-px:var(--ph-dim)}
.rk-dots-off{fill:none;stroke:var(--ph-phantom);stroke-linecap:round}
.rk-dots-on{fill:none;stroke:var(--rk-px);stroke-linecap:round;filter:drop-shadow(0 0 1.6px color-mix(in oklab,var(--rk-px) 70%,transparent))}
.rk-dots-on[data-roll=true]{animation:rk-roll .16s var(--rk-ease)}
.rk-led{position:relative;display:inline-block;flex:none;width:8px;height:8px;border-radius:999px;background:color-mix(in oklab,var(--rk-ink) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--rk-ink) 22%,transparent);--rk-led:var(--rk-ink-3)}
.rk-led[data-size=s]{width:6px;height:6px}
.rk-led[data-tone=agent],.rk-led[data-tone=live]{--rk-led:var(--rk-live)}.rk-led[data-tone=pass]{--rk-led:var(--rk-pass)}.rk-led[data-tone=you]{--rk-led:var(--rk-you)}.rk-led[data-tone=fail]{--rk-led:var(--rk-fail)}.rk-led[data-tone=learn]{--rk-led:var(--rk-learn)}.rk-led[data-tone=ink]{--rk-led:var(--rk-ink-2)}.rk-glass .rk-led[data-tone=agent],.rk-glass .rk-led[data-tone=live],.rk-well .rk-led[data-tone=live]{--rk-led:var(--ph-live)}.rk-glass .rk-led[data-tone=pass]{--rk-led:var(--ph-pass)}.rk-glass .rk-led[data-tone=you]{--rk-led:var(--ph-you)}.rk-glass .rk-led[data-tone=fail]{--rk-led:var(--ph-fail)}.rk-glass .rk-led[data-tone=learn]{--rk-led:var(--ph-learn)}.rk-glass .rk-led[data-tone=ink]{--rk-led:var(--ph-ink)}
.rk-led:not([data-tone=off]){background:var(--rk-led);box-shadow:0 0 0 1px color-mix(in oklab,var(--rk-led) 35%,transparent),0 0 7px 1px color-mix(in oklab,var(--rk-led) 55%,transparent)}
.rk-led[data-blink=slow]{animation:rk-blink 1.2s steps(1,end) infinite}.rk-led[data-blink=fast]{animation:rk-blink .5s steps(1,end) infinite}
.rk-key{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border:var(--rk-hair,1px) solid var(--rk-stroke-2);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12px;font-weight:600;letter-spacing:.01em;white-space:nowrap;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);transition:transform 80ms var(--rk-ease),box-shadow 80ms var(--rk-ease),background-color .14s}
.rk-key:hover:not(:disabled){background:color-mix(in oklab,var(--rk-module) 90%,var(--rk-ink))}
.rk-key:active:not(:disabled){transform:translateY(2px);box-shadow:0 0 0 0 var(--rk-stroke-2)}
.rk-key:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.rk-key:disabled{opacity:.42;cursor:default;box-shadow:0 1px 0 0 var(--rk-stroke)}
.rk-key[aria-pressed=true]{transform:translateY(1px);box-shadow:inset 0 2px 0 0 color-mix(in oklab,var(--rk-ink) 10%,transparent),0 1px 0 0 var(--rk-stroke-2);background:color-mix(in oklab,var(--rk-module) 82%,var(--rk-ink));border-color:var(--rk-ink-3)}
.rk-key[aria-pressed=true]::before{content:"";position:absolute;top:3px;right:3px;width:4px;height:4px;border-radius:50%;background:var(--rk-you);box-shadow:0 0 5px var(--rk-you)}
.rk-key[data-tone=primary]{border-color:color-mix(in oklab,var(--rk-you) 72%,black);background:var(--rk-you);color:color-mix(in oklab,black 88%,var(--rk-you));box-shadow:0 2px 0 0 color-mix(in oklab,var(--rk-you) 52%,black)}
.rk-key[data-tone=primary]:hover:not(:disabled){background:color-mix(in oklab,var(--rk-you) 90%,white)}
.rk-key[data-tone=primary]:active:not(:disabled){box-shadow:0 0 0 0 transparent}
.rk-key[data-tone=ghost]{background:transparent;border-color:var(--rk-stroke);box-shadow:none;color:var(--rk-ink-2)}.rk-key[data-tone=ghost]:hover:not(:disabled){background:var(--rk-hover);color:var(--rk-ink)}
.rk-glass .rk-key:not([data-tone=primary]){border-color:var(--ph-rule-2);background:var(--ph-glass-2);color:var(--ph-ink);box-shadow:0 2px 0 0 var(--ph-black)}.rk-glass .rk-key:not([data-tone=primary]):hover:not(:disabled){background:var(--ph-rule);color:var(--ph-bright)}
.rk-glass .rk-key[data-tone=ghost]{background:transparent;box-shadow:none}.rk-glass .rk-next.roko-muted,.rk-glass .roko-muted{color:var(--ph-dim)}
.rk-key[data-size=s]{height:24px;padding:0 9px;font-size:11.5px}.rk-key[data-size=l]{height:32px;padding:0 14px;font-size:12.5px}.rk-key[data-size=xl]{height:40px;padding:0 20px;font-size:13.5px}
.rk-key-kbd{display:inline-flex;align-items:center;height:15px;padding:0 4px;border:var(--rk-hair,1px) solid color-mix(in oklab,currentColor 32%,transparent);border-radius:2px;font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.04em;opacity:.78}
.rk-tag{display:inline-flex;align-items:center;flex:none;height:16px;padding:0 5px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-tag,var(--rk-ink-3)) 45%,transparent);color:var(--rk-tag,var(--rk-ink-3));font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.rk-tag[data-channel=agent],.rk-tag[data-channel=live]{--rk-tag:var(--rk-live)}.rk-tag[data-channel=pass]{--rk-tag:var(--rk-pass)}.rk-tag[data-channel=you]{--rk-tag:var(--rk-you-text)}.rk-tag[data-channel=fail]{--rk-tag:var(--rk-fail)}.rk-tag[data-channel=learn]{--rk-tag:var(--rk-learn)}.rk-tag[data-channel=ink]{--rk-tag:var(--rk-ink-3)}.rk-tag[data-fill=true]{background:color-mix(in oklab,var(--rk-tag) 14%,transparent)}.rk-glass .rk-tag{--rk-tag:var(--ph-dim)}.rk-glass .rk-tag[data-channel=agent],.rk-glass .rk-tag[data-channel=live]{--rk-tag:var(--ph-live)}.rk-glass .rk-tag[data-channel=pass]{--rk-tag:var(--ph-pass)}.rk-glass .rk-tag[data-channel=you]{--rk-tag:var(--ph-you)}.rk-glass .rk-tag[data-channel=fail]{--rk-tag:var(--ph-fail)}.rk-glass .rk-tag[data-channel=learn]{--rk-tag:var(--ph-learn)}
.rk-stamp{--rk-st:var(--rk-ink-2);display:inline-flex;align-items:center;gap:7px;color:var(--rk-st);font:700 10.5px/1 var(--rk-mono);letter-spacing:.24em;text-transform:uppercase;white-space:nowrap}.rk-stamp::before{content:"⌈";letter-spacing:0;opacity:.7;font-weight:400}.rk-stamp::after{content:"⌋";letter-spacing:0;opacity:.7;font-weight:400;margin-left:-.24em}.rk-stamp[data-tone=live]{--rk-st:var(--rk-live)}.rk-stamp[data-tone=pass]{--rk-st:var(--rk-pass)}.rk-stamp[data-tone=fail]{--rk-st:var(--rk-fail)}.rk-stamp[data-tone=you]{--rk-st:var(--rk-you-text)}.rk-stamp[data-tone=learn]{--rk-st:var(--rk-learn)}.rk-stamp[data-tone=ink]{--rk-st:var(--rk-ink-3)}.rk-glass .rk-stamp{--rk-st:var(--ph-ink)}.rk-glass .rk-stamp[data-tone=live]{--rk-st:var(--ph-live)}.rk-glass .rk-stamp[data-tone=pass]{--rk-st:var(--ph-pass)}.rk-glass .rk-stamp[data-tone=fail]{--rk-st:var(--ph-fail)}.rk-glass .rk-stamp[data-tone=you]{--rk-st:var(--ph-you)}.rk-glass .rk-stamp[data-tone=learn]{--rk-st:var(--ph-learn)}
.rk-key[data-tone=primary] .rk-tag{color:inherit;border-color:currentColor;background:color-mix(in oklab,currentColor 14%,transparent)}
.rk-module{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module)}
.rk-module[data-off=true]{opacity:.55}
.rk-hint{font-size:11px;color:var(--rk-ink-3)}
.rk-loader{width:28px;height:28px;color:var(--ph-live)}
/* the mark: its eyes report events (spec v3 §4.12) */
@keyframes rk-breath{0%,100%{transform:scale(1)}50%{transform:scale(1.045)}}
.roko-page[data-focus=true] .rk-head,.roko-page[data-focus=true] .rk-tabs,.roko-page[data-focus=true] .rk-setup{display:none}
.rk-focus-exit{position:absolute;top:8px;right:14px;z-index:20;display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-module);font:11px/1 var(--rk-mono);color:var(--rk-ink-3);cursor:pointer}

/* -- HEAD: the mark, LIVE or IDLE, the connection, today's spend, the one orange key (spec v3 §2.5) -- */
.rk-head{display:flex;align-items:center;gap:18px;min-height:62px;padding:10px 24px;border-bottom:var(--rk-hair,1px) solid var(--rk-stroke)}
.rk-today{display:flex;align-items:center;gap:12px;min-width:0}
@container (max-width:760px){.rk-today{display:none}}
/* the erosion meter (bardo MortalityGauge): on the glass, lit, eroding, a dashed ghost for what is held or projected */
.rk-meter{display:flex;gap:2px;height:10px;align-items:stretch;--rk-mtr:var(--ph-ink)}
.rk-meter i{flex:1;min-width:2px;border-radius:1px;background:var(--ph-seg)}
.rk-meter i[data-seg=on]{background:var(--rk-mtr);box-shadow:0 0 6px -2px var(--rk-mtr)}
.rk-meter i[data-seg=e1]{background:color-mix(in oklab,var(--rk-mtr) 62%,var(--ph-seg))}.rk-meter i[data-seg=e2]{background:color-mix(in oklab,var(--rk-mtr) 34%,var(--ph-seg))}
.rk-meter i[data-seg=ghost]{background:repeating-linear-gradient(90deg,color-mix(in oklab,var(--rk-mtr) 40%,transparent) 0 1px,transparent 1px 3px)}
.rk-meter[data-tone=bone]{--rk-mtr:var(--ph-bone)}.rk-meter[data-tone=you]{--rk-mtr:var(--ph-you)}.rk-meter[data-tone=fail]{--rk-mtr:var(--ph-fail)}.rk-meter[data-tone=live]{--rk-mtr:var(--ph-live)}.rk-meter[data-tone=pass]{--rk-mtr:var(--ph-pass)}.rk-meter[data-tone=learn]{--rk-mtr:var(--ph-learn)}
/* -- tabs: three destinations, and the inbox as a badge (spec v3 §5.1) -- */
.rk-tabs{display:flex;align-items:center;gap:4px;min-height:44px;padding:4px 18px}
.rk-tab{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 10px;border:0;border-radius:var(--rk-radius);background:transparent;font:600 11px/1 var(--rk-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-3);cursor:pointer;transition:color var(--t-quick)}
.rk-tab b{font-weight:600;color:var(--rk-ink-4);letter-spacing:.04em}
.rk-tab:hover{color:var(--rk-ink-2)}.rk-tab[aria-selected=true]{color:var(--rk-ink)}
.rk-tab[aria-selected=true]::before{content:"⌈";color:var(--rk-ink-3);font-weight:400;margin-right:-2px}.rk-tab[aria-selected=true]::after{content:"⌋";color:var(--rk-ink-3);font-weight:400;margin-left:-4px}
.rk-tab[data-ghost=true]{opacity:.45}
.rk-tab:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.roko-body{flex:1;min-height:0;overflow:auto;padding:10px 22px 36px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
.rk-boot{display:flex;align-items:center;gap:12px;padding:30px;justify-content:center}
.roko-notes{display:flex;flex-direction:column;gap:8px}
.roko-stack{display:flex;flex-direction:column;gap:10px;min-width:0}
.roko-narrow{width:100%;max-width:1000px}
.roko-center{display:flex;justify-content:center}
.roko-quiet{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--rk-ink-3)}
.roko-offline-hint{display:block;margin-bottom:2px;color:var(--rk-ink-2)}

/* -- LIMB: the track list, flat{display:grid;grid-template-columns:minmax(232px,272px) minmax(0,1fr);gap:24px;align-items:start}
.rk-row-spend{font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-2);font-variant-numeric:tabular-nums}

/* -- cards, pills, small parts ------------------------------------------------- */
.roko-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:14px 16px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module);color:var(--rk-ink)}
.roko-card[data-compact=true]{gap:8px;padding:11px 13px}
.roko-run-title{flex:1;min-width:0;font-weight:650;font-size:13.5px;line-height:1.35;overflow-wrap:anywhere}
.roko-card[data-compact=true] .roko-run-title{font-size:13px}
.roko-headline{font-family:var(--rk-mono);font-size:10.5px;letter-spacing:.02em;color:var(--rk-ink-3);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.roko-pill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-pill,var(--rk-ink-3)) 40%,transparent);font-family:var(--rk-mono);font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;color:var(--rk-pill,var(--rk-ink-2));--rk-pill:var(--rk-ink-3)}
.roko-pill[data-tone=good]{--rk-pill:var(--rk-pass)}.roko-pill[data-tone=bad]{--rk-pill:var(--rk-fail)}.roko-pill[data-tone=warn]{--rk-pill:var(--rk-you-text)}.roko-pill[data-tone=live]{--rk-pill:var(--rk-live)}
.roko-pill-glyph{display:inline-block}
.roko-pill.rk-stamp{height:auto;padding:0;border:0;background:none;gap:7px;font:700 10.5px/1 var(--rk-mono);letter-spacing:.24em;color:var(--rk-pill)}
.roko-pill.rk-stamp .roko-pill-glyph{display:none}
.roko-pill.rk-stamp[data-tone=muted]{--rk-pill:var(--rk-ink-3)}
.roko-pill[data-state=running] .roko-pill-glyph{animation:roko-spin 1.6s linear infinite}
.roko-kind{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-ink) 7%,transparent);color:var(--rk-ink-3);font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}
.roko-glyph{display:inline-flex;justify-content:center;width:14px;flex:none;font-weight:700;color:var(--rk-ink-3)}
.roko-glyph[data-tone=good]{color:var(--rk-pass)}.roko-glyph[data-tone=bad]{color:var(--rk-fail)}.roko-glyph[data-tone=warn]{color:var(--rk-you-text)}.roko-glyph[data-tone=live]{color:var(--rk-live)}
.roko-dot{position:relative;display:inline-block;width:8px;height:8px;flex:none;border-radius:999px;background:color-mix(in oklab,var(--rk-ink) 22%,transparent);--rk-led:var(--rk-ink-3)}
.roko-dot[data-tone=good]{--rk-led:var(--rk-pass)}.roko-dot[data-tone=bad]{--rk-led:var(--rk-fail)}.roko-dot[data-tone=warn]{--rk-led:var(--rk-you)}.roko-dot[data-tone=live]{--rk-led:var(--rk-live)}
.roko-dot:not([data-tone=muted]){background:var(--rk-led);box-shadow:0 0 0 1px color-mix(in oklab,var(--rk-led) 35%,transparent),0 0 7px 1px color-mix(in oklab,var(--rk-led) 50%,transparent)}
.roko-dot[data-pulse=true]{animation:rk-blink 1.2s steps(1,end) infinite}
.roko-tone-good{color:var(--rk-pass)}.roko-tone-bad{color:var(--rk-fail)}
.roko-estimate{padding:2px 8px;border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-ink) 6%,transparent);font-family:var(--rk-mono);font-size:11px}
.roko-strong{font-weight:650;color:var(--rk-ink)}
.roko-muted{color:var(--rk-ink-3);font-size:12px}
.roko-mono{font-family:var(--rk-mono);font-size:11.5px}
.roko-wrap{overflow-wrap:anywhere}
.roko-flex{flex:1}
.roko-section-label{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:2px;font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-3)}
.roko-section-label>:nth-child(2){font-family:inherit;font-size:11.5px;font-weight:500;letter-spacing:0;text-transform:none}
.roko-chip{display:inline-flex;align-items:center;gap:3px;max-width:100%;padding:1px 6px;border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-ink) 6%,transparent);color:var(--rk-ink-2);font-family:var(--rk-mono);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.roko-chip[data-tone=good]{color:var(--rk-pass)}.roko-chip[data-tone=bad]{color:var(--rk-fail);background:color-mix(in oklab,var(--rk-fail) 10%,transparent)}
.roko-chip-btn{border:0;cursor:pointer}.roko-chip-btn:hover{color:var(--rk-ink);background:color-mix(in oklab,var(--rk-ink) 11%,transparent)}
.roko-copyid{display:inline-flex;align-items:center;gap:4px;padding:1px 4px;border:0;border-radius:var(--rk-radius);background:none;color:var(--rk-ink-3);font-family:var(--rk-mono);font-size:11px;cursor:pointer}
.roko-copyid:hover{background:var(--ui-row-hover-background);color:var(--rk-ink)}
.roko-copyid .codicon{opacity:0;transition:opacity .12s}.roko-copyid:hover .codicon,.roko-copyid:focus-visible .codicon{opacity:.8}
.roko-model{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-live) 30%,transparent);color:var(--rk-ink);font-family:var(--rk-mono);font-size:11px;white-space:nowrap}
.roko-model .codicon{color:var(--rk-live)}

.roko-branch{display:inline-flex;align-items:center;gap:4px;font-family:var(--rk-mono);font-size:11.5px;color:var(--rk-ink-2)}
.roko-path{display:inline-flex;min-width:0;overflow:hidden;white-space:nowrap;font-family:var(--rk-mono);font-size:11.5px}
.roko-path-dir{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--rk-ink-3)}
.roko-path-base{flex:none;color:var(--rk-ink);font-weight:550}
.roko-diffstat{display:inline-flex;align-items:center;gap:6px;font-family:var(--rk-mono);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.roko-add{color:var(--rk-pass)}.roko-del{color:var(--rk-fail)}
.roko-statcells{display:inline-flex;gap:1.5px}
.roko-statcells span{width:6px;height:6px;border-radius:1px;background:color-mix(in oklab,var(--rk-ink) 10%,transparent)}
.roko-statcells span[data-kind=add]{background:var(--rk-pass)}.roko-statcells span[data-kind=del]{background:var(--rk-fail)}

/* -- the run instrument: hero, display bar, ticker{gap:12px;padding:16px 18px 12px}
.roko-hero-top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:26px;font-size:11.5px;color:var(--rk-ink-3)}
.roko-hero-top .roko-kind{background:none;box-shadow:inset 0 0 0 1px var(--rk-stroke-2);color:var(--rk-ink-2)}
.roko-hero-title{margin:2px 0 0;font-size:21px;line-height:1.2;font-weight:650;letter-spacing:-.02em;color:var(--rk-ink);overflow-wrap:anywhere;text-wrap:balance}
.roko-hero-title[data-fresh=true]{animation:rk-title-in 520ms var(--rk-ease-expo) both}
@keyframes rk-title-in{from{opacity:0;filter:blur(3px);transform:translateY(3px)}to{opacity:1;filter:none;transform:none}}
.roko-hero-request{margin:0 0 4px;max-width:96ch;font-size:12.5px;line-height:1.5;color:var(--rk-ink-3);overflow-wrap:anywhere}
.roko-hero-request::before{content:"“"}.roko-hero-request::after{content:"”"}
/* -- chat cards, the monitor{gap:10px}
.rk-cc-checks{font:11px/1.3 var(--rk-mono);color:var(--rk-ink-3)}
.rk-lstrip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:2px;padding:6px}
.rk-lstrip-seg{display:flex;flex-direction:column;gap:6px;min-width:0;padding:6px 8px;border-radius:3px;box-shadow:inset 0 0 0 1px var(--ph-rule)}
.rk-lstrip-seg[data-live=true]{box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--ph-live) 55%,transparent)}
.rk-lstrip-seg[data-off=true]{background:repeating-linear-gradient(135deg,var(--ph-rule) 0 1px,transparent 1px 6px);opacity:.75}
.rk-lstrip-top{display:flex;align-items:baseline;justify-content:space-between;gap:6px;min-width:0}.rk-lstrip-top .rk-rung-r{flex:none;white-space:nowrap}
.rk-lstrip-m{overflow:hidden;font:10px/1 var(--rk-mono);color:var(--ph-dim);white-space:nowrap;text-overflow:ellipsis}
.rk-lstrip-toks{display:flex;gap:3px;min-height:9px;align-items:center}
.rk-lstrip-toks i{display:block;width:9px;height:9px;border-radius:2px;box-shadow:inset 0 0 0 1px var(--ph-ghost)}
.rk-lstrip-toks i[data-state=running]{background:var(--ph-live);box-shadow:0 0 7px var(--ph-live)}
.rk-lstrip-toks i[data-state=passed]{background:var(--ph-pass);box-shadow:none}
.rk-lstrip-toks i[data-state=ghost],.rk-lstrip-toks i[data-state=failed]{box-shadow:inset 0 0 0 1.2px var(--ph-fail)}
.rk-monitor-sleep{display:flex;align-items:center;gap:12px;padding:16px}
.rk-monitor-count{font:11px/1 var(--rk-mono);color:var(--rk-ink-3)}
.rk-delegate-ladder{margin:0;font:11px/1.4 var(--rk-mono);color:var(--rk-ink-3)}
/* -- the Receipt and the end of a run (spec v3 §4.6, §6) -- */
.rk-receipt{display:flex;flex-direction:column;gap:10px;padding:12px 16px}
.rk-receipt-lines{display:flex;flex-direction:column;gap:6px;font:12px/1.5 var(--rk-mono)}
.rk-receipt-line{display:grid;grid-template-columns:96px minmax(0,1fr);gap:14px;animation:rk-print var(--t-gesture) var(--rk-ease)}
.rk-receipt-k{font:600 9.5px/1.9 var(--rk-mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ph-dim)}
.rk-receipt-v{color:var(--ph-ink);overflow-wrap:anywhere}
.rk-receipt-line[data-tone=you] .rk-receipt-v{color:var(--ph-you)}.rk-receipt-line[data-tone=learn] .rk-receipt-v{color:var(--ph-learn)}.rk-receipt-line[data-tone=dim] .rk-receipt-v{color:var(--ph-dim)}.rk-receipt-line[data-tone=basis]{margin-top:-4px}.rk-receipt-line[data-tone=basis] .rk-receipt-v{font-size:11px;color:var(--ph-dim)}.rk-receipt-good{color:var(--ph-pass)}
.rk-receipt-rule{height:0;border-top:1px dashed var(--ph-rule-2)}
.rk-receipt-keys{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.rk-receipt-note{margin-right:auto;font:11px/1.3 var(--rk-mono);color:var(--ph-dim)}
/* Composer v3 (spec v3 §5.7): where it starts */
.rk-starts{padding:12px 16px}
.rk-ladderglass{display:grid;grid-template-columns:auto minmax(0,1fr);gap:18px;align-items:center;width:min(100%,560px);padding:16px 20px}
.rk-ladderglass-mark{display:grid;place-items:center;width:64px;height:64px}.rk-ladderglass-body{display:flex;flex-direction:column;gap:10px;min-width:0}
.rk-ladderglass-line{margin:0;font:11px/1.4 var(--rk-mono);color:var(--ph-dim)}
.rk-starts-body{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:18px;margin-top:10px}
.rk-starts-ladder{display:flex;flex-direction:column;gap:6px;font:11px/1.2 var(--rk-mono);color:var(--ph-ink)}
.rk-starts-rung{display:grid;grid-template-columns:70px minmax(0,1fr) auto;gap:10px;align-items:baseline}
.rk-starts-name{font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--ph-dim)}
.rk-starts-rung[data-start=true] .rk-starts-name{color:var(--ph-live)}.rk-starts-rung[data-start=true] .rk-starts-model{color:var(--ph-bright)}
.rk-starts-rung[data-off=true]{opacity:.55}
.rk-starts-model{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rk-starts-price{color:var(--ph-dim);white-space:nowrap}
.rk-starts-side{display:flex;flex-direction:column;gap:8px;min-width:0;font:11px/1.5 var(--rk-mono);color:var(--ph-ink)}
.rk-starts-likely{display:flex;align-items:center;flex-wrap:wrap;gap:8px;color:var(--ph-dim)}
.rk-starts-k{font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase}
.rk-starts-rule,.rk-starts-similar,.rk-starts-basis{margin:0}.rk-starts-similar b{font-weight:600;color:var(--ph-pass)}.rk-starts-basis{margin-top:-4px;font-size:10px;color:var(--ph-dim)}.rk-starts-more{color:var(--ph-dim)}
.rk-starts-checks{display:flex;flex-direction:column;gap:4px;padding-top:6px;border-top:var(--rk-hair,1px) solid var(--ph-rule)}
.rk-starts-check{display:grid;grid-template-columns:4px auto minmax(0,1fr) auto;gap:8px;align-items:center;white-space:nowrap}
.rk-starts-check i{width:4px;height:10px;border-radius:1px;background:var(--ph-pass)}.rk-starts-check span{overflow:hidden;text-overflow:ellipsis;color:var(--ph-dim)}.rk-starts-check small{color:var(--ph-dim)}
@container (max-width:620px){.rk-starts-body{grid-template-columns:minmax(0,1fr)}}
/* Waiting v3 (spec v3 §5.4): one card in a void pool{max-width:640px;margin-left:auto;margin-right:auto;padding-top:28px;padding-bottom:48px}
.roko-pending[data-compact=true] .roko-pending-head{flex-wrap:wrap}.roko-pending[data-compact=true] .roko-pending-title{order:3;flex-basis:100%}
.roko-pending:focus-visible{outline:2px solid var(--rk-you);outline-offset:3px}
.roko-pending .roko-question{font-size:15px;line-height:1.45;font-weight:600;color:var(--rk-ink)}
.rk-pend-checked{font:11.5px/1.4 var(--rk-mono);color:var(--rk-ink-3)}
.rk-pend-clock{display:flex;flex-direction:column;gap:6px}
.rk-pend-well{padding:5px 7px}.rk-pend-clock .rk-meter{width:100%;height:8px;animation:rk-breathe 1.2s ease-in-out infinite}
.rk-pend-clock-label{font:600 11px/1 var(--rk-mono);color:var(--rk-you-text)}.rk-pend-clock[data-urgent=true] .rk-pend-clock-label{color:var(--rk-fail)}
@keyframes rk-breathe{0%,100%{opacity:1}50%{opacity:.72}}
@media (prefers-reduced-motion:reduce){.rk-pend-clock .rk-meter{animation:none}}
/* Plans v3 (spec v3 §5.5): a plan reads as a document first */
.rk-plandoc{max-width:72ch;font-size:13px;line-height:1.6;color:var(--rk-ink-2)}
.rk-plandoc .rk-doc-h{margin:14px 0 6px;color:var(--rk-ink);letter-spacing:-.01em;line-height:1.3}.rk-plandoc .rk-doc-h:first-child{margin-top:0}
.rk-doc-h1{font-size:16px;font-weight:700}.rk-doc-h2{font-size:14px;font-weight:650}.rk-doc-h3,.rk-doc-h4{font:600 10px/1.3 var(--rk-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-3)}
.rk-doc-p{margin:0 0 8px}.rk-doc-list{margin:0 0 8px;padding-left:20px;list-style:disc}ol.rk-doc-list{list-style:decimal}.rk-doc-list li::marker{color:var(--rk-ink-4)}.rk-doc-sub{margin:2px 0 4px;list-style:circle}.rk-doc-list li{margin:2px 0}
.rk-plandoc code{padding:0 4px;border-radius:3px;background:var(--rk-sunk);font:12px var(--rk-mono);color:var(--rk-ink)}
.rk-doc-code,.rk-doc-table{margin:0 0 8px;padding:8px 10px;border-radius:var(--rk-radius);background:var(--rk-sunk);font:11.5px/1.5 var(--rk-mono);color:var(--rk-ink-2);white-space:pre-wrap;overflow-wrap:anywhere}
.rk-plantasks{display:flex;flex-direction:column;gap:10px}
.rk-plantask{display:flex;flex-direction:column;gap:8px;padding:12px 14px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module)}
.rk-plantask-head{display:flex;align-items:center;flex-wrap:wrap;gap:8px}
.rk-plantask-title{font-weight:650;color:var(--rk-ink)}
.rk-accept{display:flex;flex-direction:column;gap:5px;margin:0;padding:0;list-style:none}
.rk-accept li{display:grid;grid-template-columns:14px minmax(0,1fr);gap:8px;align-items:start;font-size:12.5px;line-height:1.45;color:var(--rk-ink)}
.rk-accept li code{padding:0 3px;border-radius:2px;background:var(--rk-sunk);font:11.5px var(--rk-mono)}
.rk-accept-box{width:11px;height:11px;margin-top:3px;border:1.4px solid var(--rk-ink-4);border-radius:2px}
.rk-taskchecks{display:flex;flex-direction:column;gap:5px;margin:2px 0 10px;font-size:12px}.rk-taskchecks>[role=list]{display:flex;flex-direction:column;gap:3px}.rk-taskcheck{display:flex;align-items:baseline;gap:8px;min-width:0}.rk-taskcheck b{flex:none;min-width:2.6em;font:600 11px/1.4 var(--rk-mono);color:var(--rk-ink-2)}.rk-taskcheck code{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11.5px/1.4 var(--rk-mono);color:var(--rk-ink)}.rk-taskcheck code span{color:var(--rk-ink-3)}.rk-taskcheck-more{flex:none;font:10.5px var(--rk-mono);color:var(--rk-ink-3)}
.rk-accept-id{font:600 10px/1 var(--rk-mono);color:var(--rk-ink-3)}.rk-est-over{color:var(--rk-you-text)}.rk-also{margin:4px 0 0 22px;font-size:12px;color:var(--rk-ink-3)}.rk-also-k{font:600 9.5px/1.4 var(--rk-mono);letter-spacing:.06em;text-transform:uppercase}.rk-also ul{margin:2px 0 0;padding-left:16px}.roko-inspector>.rk-also{margin:0}.rk-plantask-est{font:11px/1.4 var(--rk-mono);color:var(--rk-ink-3)}.rk-accept-src{margin-left:6px;padding:1px 4px;border-radius:2px;box-shadow:inset 0 0 0 1px var(--rk-stroke);font:600 9px/1 var(--rk-mono);color:var(--rk-ink-3)}.rk-sc{margin:8px 0;padding:8px 12px;border-radius:var(--rk-radius-m);background:var(--rk-module);box-shadow:inset 0 0 0 1px var(--rk-stroke)}.rk-sc[data-compact=true]{margin:6px 0 2px;padding:6px 10px}.rk-sc summary{cursor:pointer}.rk-sc-line{font:600 11.5px/1.4 var(--rk-mono);color:var(--rk-ink)}.rk-sc-line[data-missing=true]{color:var(--rk-you-text)}.rk-sc-list{display:flex;flex-direction:column;gap:5px;margin:8px 0 0;padding:0;list-style:none;font-size:12px;color:var(--rk-ink-2)}.rk-sc-list li{display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:2px 8px;align-items:baseline}.rk-sc-id,.rk-sc-where{font:600 10px/1.4 var(--rk-mono);color:var(--rk-ink-3)}.rk-sc-where,.rk-sc-why{grid-column:3}.rk-sc-chip{padding:1px 5px;border-radius:2px;font:600 9px/1.3 var(--rk-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--rk-ink-3);box-shadow:inset 0 0 0 1px var(--rk-stroke-2)}.rk-sc-chip[data-status=kept]{color:var(--rk-pass);background:color-mix(in oklab,var(--rk-pass) 16%,transparent);box-shadow:none}.rk-sc-chip[data-status=shallow]{color:var(--rk-pass);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--rk-pass) 60%,transparent)}.rk-sc-chip[data-status=cannot_run]{color:var(--rk-you-text);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--rk-you) 70%,transparent)}.rk-sc-chip[data-status=missing]{color:var(--rk-you-text);background:color-mix(in oklab,var(--rk-you) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--rk-you) 55%,transparent)}.rk-sc-check{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;color:var(--rk-ink);overflow-wrap:anywhere}.rk-sc-why{font-size:11.5px;color:var(--rk-ink-3)}.rk-sc-list li[data-status=missing] .rk-sc-check{color:var(--rk-you-text)}.rk-sc summary .rk-mod{margin-bottom:4px}.rk-vnotes{margin:8px 0;padding:8px 12px;border-radius:var(--rk-radius-m);box-shadow:inset 0 0 0 1px var(--rk-stroke)}.rk-vnotes ul{display:flex;flex-direction:column;gap:4px;margin:4px 0 0;padding:0;list-style:none;font-size:12px;line-height:1.45;color:var(--rk-ink-2);overflow-wrap:anywhere}.rk-vnotes code{font:600 10.5px/1.4 var(--rk-mono);color:var(--rk-you-text)}.rk-asked{margin:8px 0;padding:8px 12px;border-radius:var(--rk-radius-m);background:var(--rk-module);box-shadow:inset 0 0 0 1px var(--rk-stroke)}.rk-asked-spec{margin:2px 0 0;font-size:12px;color:var(--rk-ink-2)}.rk-asked-spec code{font:600 11.5px/1.4 var(--rk-mono);color:var(--rk-ink)}.rk-asked-text{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12.5px;line-height:1.5;color:var(--rk-ink-2)}.rk-sc-from{display:block;margin-top:2px;font:10.5px/1.4 var(--rk-mono);color:var(--rk-ink-3);overflow-wrap:anywhere}.roko-cc-why[data-tone=you]{color:var(--rk-you-text)}
.rk-dropped{display:flex;flex-direction:column;gap:4px;margin:4px 0 0;padding:0;list-style:none;font-size:12px;color:var(--rk-ink-2)}.rk-accept-by{display:inline-flex;flex-wrap:wrap;gap:4px;margin-left:6px;vertical-align:middle}.rk-accept-by[data-linked=quote] .roko-checkcmd{border-style:dashed}
.rk-plantask-goal{margin:0;font-size:12.5px;line-height:1.5;color:var(--rk-ink-2)}.rk-plantask-nongoals{margin:0;font-size:11.5px}
.roko-checkcmd b{font-weight:600;color:var(--rk-ink-2)}
.rk-plantask-checks{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:11.5px}
.rk-rubric summary{list-style:none;cursor:pointer}.rk-rubric summary::-webkit-details-marker{display:none}.rk-rubric[open] summary{margin-bottom:8px}
/* The route and escalation sheet (spec v3 §5.3, mockup 02) */
.rk-sheet-scrim{position:fixed;inset:0;z-index:30;background:color-mix(in oklab,var(--rk-body) 60%,transparent)}
.roko-inspector.rk-sheet{position:fixed;top:5%;bottom:4%;left:0;right:0;z-index:31;width:min(1120px,94%);margin:0 auto;gap:0;padding:0;border:0;border-radius:var(--rk-radius-l);box-shadow:0 0 0 1px var(--rk-stroke-2),0 0 0 3px var(--rk-module),0 0 0 4px var(--rk-stroke-2),0 24px 60px -24px var(--ph-drop);animation:rk-sheet-in var(--t-gesture) var(--rk-ease-lux)}
.rk-sheet .rk-sheet-body{flex:1;min-height:0;overflow:auto}
.rk-sheet .roko-inspector-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@keyframes rk-sheet-in{from{opacity:0;transform:translateY(8px) scale(.985)}to{opacity:1;transform:none}}
.rk-sheet>.roko-inspector-head{padding:14px 18px;border-bottom:var(--rk-hair,1px) solid var(--rk-stroke)}
.rk-sheet-count{font:11px/1 var(--rk-mono);color:var(--rk-ink-3);white-space:nowrap}
.rk-sheet-body{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px 18px}
.rk-sheet .rk-sheet-body{grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0}
.rk-sheet-col{display:flex;flex-direction:column;gap:12px;min-width:0}
.rk-sheet .rk-sheet-col{padding:14px 18px}.rk-sheet .rk-sheet-col+.rk-sheet-col{border-left:var(--rk-hair,1px) solid var(--rk-stroke)}
.rk-sheet-mod{display:flex;flex-direction:column;gap:10px;min-width:0}
.rk-sheet-foot{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;padding:10px 18px;border-top:var(--rk-hair,1px) solid var(--rk-stroke);font:11px/1 var(--rk-mono);color:var(--rk-ink-3)}
.rk-sheet-foot>span{display:inline-flex;align-items:center;gap:4px}.rk-sheet-src{white-space:nowrap}
.rk-sheet-out{max-height:260px;overflow:auto}
.rk-climb{display:flex;flex-direction:column;gap:8px}
.rk-climb-rung{display:grid;grid-template-columns:132px minmax(0,1fr);gap:12px;align-items:center;min-height:44px;padding:6px 0;border-bottom:1px dashed var(--rk-stroke)}
.rk-climb-name{display:flex;flex-direction:column;gap:2px;font:12px/1.2 var(--rk-mono);color:var(--rk-ink)}
.rk-climb-name b{font-size:9.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--rk-ink-3)}
.rk-climb-name small{font-size:10px;color:var(--rk-ink-3)}
.rk-climb-rung[data-off=true] .rk-climb-name{opacity:.6}
.rk-climb-tries{display:flex;flex-wrap:wrap;gap:8px;min-width:0}
.rk-climb-note{font:11px/1.4 var(--rk-mono);color:var(--rk-ink-3)}
.rk-climb-rule{margin:2px 0 0;font:11px/1.5 var(--rk-mono);color:var(--rk-ink-3)}
.rk-trycard{display:flex;flex-direction:column;gap:3px;min-width:132px;max-width:230px;padding:6px 8px;border:var(--rk-hair,1px) solid var(--rk-stroke-2);border-radius:var(--rk-radius);background:var(--rk-sunk);font:10.5px/1.35 var(--rk-mono);color:var(--rk-ink-2);text-align:left;cursor:pointer}
.rk-trycard[data-outcome=running]{border-color:var(--rk-live);box-shadow:0 0 0 3px color-mix(in oklab,var(--rk-live) 16%,transparent)}
.rk-trycard[data-outcome=failed]{border-color:color-mix(in oklab,var(--rk-fail) 45%,var(--rk-stroke-2))}
.rk-trycard[data-outcome=passed]{border-color:color-mix(in oklab,var(--rk-pass) 50%,var(--rk-stroke-2))}
.rk-trycard[aria-pressed=true]{outline:var(--rk-hair,1px) solid var(--rk-ink-3);outline-offset:1px}
.rk-trycard:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.rk-trycard-head{display:flex;align-items:center;gap:6px;color:var(--rk-ink)}
.rk-trycard-x{color:var(--rk-fail)}.rk-trycard-ok{color:var(--rk-pass)}.rk-trycard-live{color:var(--rk-live)}.rk-trycard-refused{color:var(--rk-ink-3)}
.rk-trycard-line{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rk-trycard-line[data-tone=live]{color:var(--rk-live)}.rk-trycard-line[data-tone=fail]{color:var(--rk-fail)}
.rk-trycard-key{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rk-fail)}
.rk-inprompt{display:flex;flex-direction:column;gap:8px}
.rk-inprompt-lesson{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:10px;align-items:start;padding:6px 0;border-top:var(--rk-hair,1px) solid var(--rk-stroke-soft)}.rk-inprompt-lesson:first-child{border-top:0}
.rk-inprompt-lesson p{margin:0;font-size:12.5px;line-height:1.4;color:var(--rk-ink)}
.rk-inprompt-lesson small{display:block;margin-top:3px;font:10px/1.3 var(--rk-mono);color:var(--rk-ink-3)}
.rk-inprompt .rk-chain-g{color:var(--rk-learn)}
.rk-inprompt .rk-lempty,.rk-trycost .rk-lempty{color:var(--rk-ink-3)}
.rk-feedback{padding:10px 12px;border-left:2px solid var(--rk-you);border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-you) 8%,transparent)}
.rk-feedback-k{font:700 9.5px/1 var(--rk-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--rk-you-text)}
.rk-feedback p{margin:6px 0 0;font-size:12.5px;line-height:1.5;color:var(--rk-ink)}
.rk-feedback ul{margin:6px 0 0;padding-left:16px;font:11px/1.45 var(--rk-mono);color:var(--rk-ink-2)}
/* #4: where the time went: tasks as lanes on the run's clock, a try a run of its phases, the critical path in bone */
.rk-time{display:flex;flex-direction:column;gap:12px}.rk-tl,.rk-tsplit{padding:14px 16px}
.rk-tl-key{display:flex;flex-wrap:wrap;gap:4px 14px;margin:6px 0 10px;font:10.5px/1 var(--rk-mono);color:var(--ph-dim)}.rk-tl-key span{display:inline-flex;align-items:center;gap:6px}.rk-tl-key i{width:14px;height:8px;border-radius:1px}
.rk-tl-lane{display:grid;grid-template-columns:minmax(0,180px) minmax(0,1fr);gap:12px;align-items:center;min-height:30px;border-top:var(--rk-hair,1px) solid var(--ph-rule)}
.rk-tl-name{display:flex;flex-direction:column;gap:2px;min-width:0;padding:4px 0;border:0;background:none;color:var(--ph-bright);font:inherit;text-align:left;cursor:pointer}.rk-tl-name b{font:600 11px/1.2 var(--rk-mono)}.rk-tl-name small{overflow:hidden;color:var(--ph-dim);font-size:11px;white-space:nowrap;text-overflow:ellipsis}
.rk-tl-rail{position:relative;height:16px}.rk-tl-try{position:absolute;top:2px;bottom:2px;display:flex;gap:1px;min-width:3px;border-radius:2px;overflow:hidden}.rk-tl-try i{display:block;min-width:1px;height:100%}
.rk-time [data-kind=model]{background:var(--ph-live)}.rk-time [data-kind=tools]{background:repeating-linear-gradient(135deg,var(--ph-live) 0 2px,transparent 2px 5px)}.rk-time [data-kind=checks]{background:color-mix(in oklab,var(--ph-ink) 55%,transparent)}.rk-time [data-kind=other]{background:color-mix(in oklab,var(--ph-ink) 22%,transparent)}.rk-time [data-kind=agent]{background:repeating-linear-gradient(135deg,var(--ph-live) 0 4px,color-mix(in oklab,var(--ph-ink) 40%,transparent) 4px 7px)}
.rk-tl-try{outline:var(--rk-hair,1px) solid transparent;outline-offset:1px}.rk-tl-try[data-outcome=passed]{outline-color:color-mix(in oklab,var(--ph-pass) 75%,transparent)}.rk-tl-try[data-outcome=failed]{outline-color:var(--ph-fail)}.rk-tl-try[data-outcome=running]{outline-color:var(--ph-live)}
.rk-tl-lane[data-critical=true] .rk-tl-rail::before{content:"";position:absolute;left:0;right:0;top:50%;height:1px;background:color-mix(in oklab,var(--ph-bone) 45%,transparent)}.rk-tl-lane[data-critical=true] .rk-tl-name b{color:var(--ph-bone)}
.rk-tl-axis{position:relative;height:14px;margin:4px 0 0 192px;font:10px/1 var(--rk-mono);color:var(--ph-dim)}.rk-tl-axis span{position:absolute;transform:translateX(-50%)}.rk-tl-axis span:first-child{transform:none}.rk-tl-axis span:last-child{transform:translateX(-100%)}
.rk-tsplit-bar{position:relative;top:auto;bottom:auto;height:10px;margin:8px 0 10px}.rk-tsplit-row{display:grid;grid-template-columns:130px 70px minmax(0,1fr);gap:10px;padding:3px 0;font:11px/1.3 var(--rk-mono);color:var(--ph-ink)}.rk-tsplit-row span:first-child{color:var(--ph-dim);font-size:10px;letter-spacing:.08em;text-transform:uppercase}.rk-tsplit-row b{color:var(--ph-bright)}.rk-tsplit-row[data-path=true]{grid-template-columns:130px auto minmax(0,1fr)}.rk-tsplit-row[data-path=true] b{color:var(--ph-bone);white-space:nowrap}.rk-tsplit-note{margin:6px 0 0;color:var(--ph-dim);font-size:11px}
.rk-sg-bar{display:inline-block;width:80px;height:5px;margin-left:10px;vertical-align:middle;border-radius:1px;background:var(--ph-rule-2)}.rk-sg-bar i{display:block;height:100%;background:var(--ph-live)}
/* #7: what a run made: its UI shots, its sounds (a waveform from their peaks, a play key) and its reports */
.rk-cc-shot{display:block;width:240px;max-width:100%;margin-top:8px}.rk-cc-shot figcaption{margin-top:4px}.roko .rk-made-open img{display:block;margin:0}.rk-phase-shot{display:block;width:100%;height:auto;margin-top:6px;border-radius:2px;box-shadow:0 0 0 1px var(--ph-rule-2)}.rk-made-open{display:block;width:100%;padding:0;border:0;background:none;cursor:zoom-in}.roko.rk-shot-dialog{max-width:min(92vw,1240px);width:min(92vw,1240px)}.rk-shot-big,.rk-diff-shot{display:block;max-width:100%;height:auto;border-radius:3px}.rk-diff-shot{margin:6px 0}
.rk-made{padding:14px 16px}.rk-made-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:8px}
.rk-made-shot{display:flex;flex-direction:column;gap:6px;margin:0}.rk-made-shot img{width:100%;height:auto;border-radius:3px;box-shadow:0 0 0 1px var(--ph-rule-2)}.rk-made-shot figcaption,.rk-made-wait{font:10.5px/1 var(--rk-mono);color:var(--ph-dim)}
.rk-made-sound{grid-column:span 2;display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 10px;align-items:center}.rk-made-name{display:flex;flex-direction:column;gap:3px;font:11px/1.2 var(--rk-mono);color:var(--ph-bright)}.rk-made-name small,.rk-made-report small{font-size:10.5px;color:var(--ph-dim)}
.rk-made-wave{grid-column:1/-1;display:flex;align-items:center;gap:1px;height:34px}.rk-made-wave i{flex:1;min-height:1px;border-radius:1px;background:var(--ph-live)}.rk-made-sound[data-playing=true] .rk-made-wave i{background:var(--ph-bone)}
.rk-made-report{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:3px;box-shadow:inset 0 0 0 1px var(--ph-rule-2);font:11px/1.3 var(--rk-mono);color:var(--ph-ink)}.rk-made-report[data-verdict=passed] span{color:var(--ph-pass)}.rk-made-report[data-verdict=failed] span{color:var(--ph-fail)}
.rk-trycost{display:flex;flex-direction:column;gap:7px}
.rk-trycost-row{display:grid;grid-template-columns:44px 56px minmax(0,1fr) 70px;gap:10px;align-items:center;font:11px/1 var(--rk-mono);color:var(--rk-ink-2)}
.rk-trycost-rung{color:var(--rk-ink-3)}.rk-trycost-usd{text-align:right;color:var(--rk-ink)}
.rk-trycost-bar{height:8px;border-radius:1px;background:color-mix(in oklab,var(--rk-ink) 8%,transparent)}.rk-trycost-bar i{display:block;height:100%;border-radius:1px;background:var(--rk-ink-3)}
.rk-trycost-row[data-outcome=failed] .rk-trycost-bar i{background:var(--rk-fail)}.rk-trycost-row[data-outcome=running] .rk-trycost-bar i{background:var(--rk-live)}.rk-trycost-row[data-outcome=passed] .rk-trycost-bar i{background:var(--rk-pass)}
.rk-trycost-row[data-outcome=running]{color:var(--rk-live)}
.rk-trycost-total{display:flex;align-items:center;gap:12px;padding-top:8px;border-top:var(--rk-hair,1px) solid var(--rk-stroke-soft);font:11px/1 var(--rk-mono);color:var(--rk-ink-3)}.rk-trycost-well{padding:6px 9px}
@container (max-width:760px){.rk-sheet .rk-sheet-body{grid-template-columns:minmax(0,1fr)}.rk-sheet .rk-sheet-col+.rk-sheet-col{border-left:0;border-top:var(--rk-hair,1px) solid var(--rk-stroke)}}
@media (prefers-reduced-motion:reduce){.roko-inspector.rk-sheet{animation:none}}
/* Learning (spec v3 §5.6, mockup 03) */
.rk-mod-note{flex:1 1 0;min-width:0;margin-left:8px;overflow:hidden;font-weight:500;letter-spacing:.04em;text-transform:none;text-overflow:ellipsis;color:var(--rk-ink-4)}.rk-glass .rk-mod-note{color:var(--ph-dim)}
.rk-learn{display:grid;gap:14px}
.rk-learn .rk-panel,.rk-learn .rk-folds,.rk-learn-intro{--ph-dim:var(--rk-ink-3);--ph-bright:var(--rk-ink);--ph-ink:var(--rk-ink);--ph-rule:var(--rk-stroke);--ph-rule-2:var(--rk-stroke-2);--ph-learn:var(--rk-ink-2);--ph-pass:var(--rk-pass);--ph-live:var(--rk-live);--ph-fail:var(--rk-fail);--ph-you:var(--rk-you-text);--ph-glass:var(--rk-module);--ph-void:var(--rk-module)}
.rk-learn-intro{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 24px}
.rk-learn-intro p{margin:0;max-width:640px;font-size:14px;line-height:1.5;color:var(--rk-ink-2)}
.rk-well.rk-learn-glass{grid-template-columns:repeat(3,minmax(0,1fr))}.rk-learn-glass .rk-rc-note{white-space:normal}
.rk-kpi-note[data-tone=pass]{color:var(--ph-pass)}.rk-kpi-note[data-tone=you]{color:var(--ph-you)}
.rk-learn-why,.rk-learn-foot{margin:0;font:11.5px/1.5 var(--rk-mono);color:var(--rk-ink-3)}.rk-learn-foot span+span::before{content:" · "}
.rk-bars{display:grid;gap:8px;margin-top:4px}
.rk-bars-row{display:grid;grid-template-columns:minmax(90px,140px) minmax(0,1fr) 36px;gap:12px;align-items:center}.rk-bars-row[data-off=true]{opacity:.6}
.rk-bars-row b{overflow:hidden;font:600 12px/1.2 var(--rk-mono);text-overflow:ellipsis;white-space:nowrap}
.rk-bars-track{height:8px;overflow:hidden;border-radius:2px;background:color-mix(in oklab,var(--rk-ink) 8%,transparent)}.rk-bars-track i{display:block;height:100%;background:var(--rk-ink-3)}
.rk-bars-n{font:12px/1 var(--rk-mono);text-align:right;color:var(--rk-ink-2)}
.rk-bars-said{margin:6px 0 0;font-size:12.5px;line-height:1.5;color:var(--rk-ink-2)}
.rk-loops,.rk-steady{display:grid;gap:12px}.rk-loops-list,.rk-steady-list{display:grid;gap:8px}
.rk-loop{display:grid;grid-template-columns:12px 92px minmax(0,1fr) auto;gap:10px;align-items:baseline;font-size:12.5px;line-height:1.4;color:var(--rk-ink-2)}
.rk-loop b{font:600 11px/1.4 var(--rk-mono);color:var(--rk-ink)}.rk-loop-n{font:10.5px/1.4 var(--rk-mono);color:var(--rk-ink-3);white-space:nowrap}
.rk-loops-log{display:grid;gap:4px;padding-top:8px;border-top:var(--rk-hair,1px) solid var(--rk-stroke)}
.rk-loops-ev{display:grid;grid-template-columns:14px 64px minmax(0,1fr);gap:8px;font-size:12px;color:var(--rk-ink-2)}.rk-loops-t{font:10.5px/1.6 var(--rk-mono);color:var(--rk-ink-3)}
.rk-steady-lead{margin:0;font-size:12.5px;color:var(--rk-ink-2)}
.rk-steady-row{display:grid;grid-template-columns:12px minmax(120px,180px) 70px minmax(0,1fr);gap:10px;align-items:center;font-size:12.5px}
.rk-steady-row b{font:600 12px/1 var(--rk-mono)}.rk-steady-row[data-out=true] b{color:var(--rk-fail)}.rk-steady-bound{font:10.5px/1.3 var(--rk-mono);color:var(--rk-ink-3)}
.rk-spark2{flex:none;overflow:visible}.rk-spark2 circle{fill:var(--rk-spark,var(--ph-ink))}.rk-spark2 .rk-spark-grid{fill:var(--ph-phantom)}
.rk-spark2[data-tone=bone]{--rk-spark:var(--ph-bone)}.rk-spark2[data-tone=pass]{--rk-spark:var(--ph-pass)}.rk-spark2[data-tone=live]{--rk-spark:var(--ph-live)}.rk-spark2[data-tone=learn]{--rk-spark:var(--ph-learn)}
.rk-spark2-head{filter:drop-shadow(0 0 3px var(--rk-spark,var(--ph-ink)))}
.rk-lpanel{display:flex;flex-direction:column;min-width:0;min-height:236px;padding:14px 18px}
.rk-lempty{margin:auto 0;font:11px/1.5 var(--rk-mono);color:var(--ph-dim)}.rk-wall{min-height:0}
.rk-paid{display:flex;flex-direction:column;margin-top:8px}
.rk-chain{display:grid;grid-template-columns:16px minmax(0,1fr) 118px;gap:12px;align-items:center;padding:9px 0;border-top:var(--rk-hair,1px) solid var(--ph-rule)}.rk-chain:first-child{border-top:0}
.rk-chain-g{font-size:13px;color:var(--ph-learn)}
.rk-chain-body p{margin:0;overflow:hidden;font-size:12.5px;line-height:1.35;text-overflow:ellipsis;white-space:nowrap;color:var(--ph-bright)}
.rk-chain-body small{display:flex;align-items:center;flex-wrap:wrap;gap:0 4px;margin-top:4px;font:10px/1.3 var(--rk-mono);color:var(--ph-dim)}
.rk-chain-run{padding:0;border:0;background:none;font:inherit;color:var(--ph-learn);cursor:pointer}.rk-chain-run:hover{text-decoration:underline}
.rk-payoff{display:flex;flex-direction:column;align-items:flex-end;gap:5px}
.rk-payoff-seq{display:flex;align-items:center;gap:3px;font:10px/1 var(--rk-mono);color:var(--ph-dim)}
.rk-payoff-seq i{width:7px;height:7px;border-radius:1.5px;background:var(--ph-pass)}
.rk-payoff-seq i[data-outcome=climbed]{background:none;box-shadow:inset 0 0 0 1.2px var(--ph-live)}.rk-payoff-seq i[data-outcome=failed]{background:none;box-shadow:inset 0 0 0 1.2px var(--ph-fail)}.rk-payoff-seq i[data-outcome=passed]{background:color-mix(in oklab,var(--ph-pass) 50%,var(--ph-seg))}
.rk-payoff-arrow{margin-right:3px;color:var(--ph-learn)}
.rk-payoff-n{font:10.5px/1 var(--rk-mono);color:var(--ph-dim)}.rk-payoff-n[data-tone=pass]{color:var(--ph-pass)}
.rk-conf{display:inline-flex;gap:1.5px}.rk-conf i{width:4px;height:8px;border-radius:1px;background:var(--ph-learn)}
.rk-conf i[data-z=e1]{background:color-mix(in oklab,var(--ph-learn) 55%,var(--ph-seg))}.rk-conf i[data-z=e2]{background:color-mix(in oklab,var(--ph-learn) 28%,var(--ph-seg))}.rk-conf i[data-z=o]{background:var(--ph-phantom)}
.rk-m1{display:flex;align-items:center;gap:10px;margin-top:auto;padding-top:10px;border-top:var(--rk-hair,1px) solid var(--ph-rule);font:10.5px/1.4 var(--rk-mono);color:var(--ph-dim)}
@media (prefers-reduced-motion:reduce){.rk-receipt-line{animation:none}}
/* -- GUT: the sequencer beside the stream; the stream as a phosphor log (spec v3 §2.5, §4.5) -- */
.rk-gut{position:relative;display:grid;grid-template-columns:minmax(0,1fr) 316px;gap:16px;align-items:start}
@container (max-width:1000px){.rk-gut{grid-template-columns:minmax(0,1fr)}}
.rk-gut-note{grid-column:1/-1}
.rk-stream{display:flex;flex-direction:column;min-height:260px;max-height:440px;padding:12px 0 0}
.rk-stream-head{display:flex;align-items:center;gap:8px;padding:0 14px 8px;border-bottom:var(--rk-hair,1px) solid var(--ph-rule)}
.rk-seg{margin-left:auto;display:inline-flex;border-radius:3px;box-shadow:inset 0 0 0 1px var(--ph-rule-2);font:600 9.5px/1 var(--rk-mono)}
.rk-seg button{padding:4px 7px;border:0;border-radius:3px;background:none;color:var(--ph-dim);font:inherit;letter-spacing:.06em;cursor:pointer}
.rk-seg button[aria-pressed=true]{color:var(--ph-bright);background:var(--ph-rule-2)}
.rk-seg button:focus-visible{outline:2px solid var(--ph-you);outline-offset:1px}
.rk-stream-lines{display:flex;flex-direction:column;gap:1px;flex:1;min-height:0;overflow-y:auto;padding:8px 14px 12px;font:11px/1.5 var(--rk-mono);scrollbar-width:thin}
.rk-stream-lines>:first-child{margin-top:auto}
.rk-ln{display:grid;grid-template-columns:34px 32px minmax(0,1fr);gap:6px;color:var(--ph-ink);white-space:nowrap;transition:opacity var(--t-passage) var(--rk-ease),color var(--t-passage) var(--rk-ease)}
.rk-ln-x{overflow:hidden;text-overflow:ellipsis}.rk-ln-t,.rk-ln-k,.rk-ln-d{color:var(--ph-dim)}
.rk-ln[data-fresh=true]{color:var(--ph-bright)}
.rk-ln[data-tone=fail] .rk-ln-x{color:var(--ph-fail)}.rk-ln[data-tone=pass] .rk-ln-x{color:var(--ph-pass)}.rk-ln[data-tone=live] .rk-ln-x{color:var(--ph-live)}.rk-ln[data-tone=learn] .rk-ln-x{color:var(--ph-learn)}
.rk-ln-sub{grid-template-columns:72px minmax(0,1fr)}.rk-ln-sub .rk-ln-x{grid-column:2}
.rk-ln-out{margin:2px 0 4px 72px;padding:4px 8px;border-left:var(--rk-hair,1px) solid var(--ph-rule-2);font:10.5px/1.45 var(--rk-mono);color:var(--ph-dim);white-space:pre-wrap;overflow-wrap:anywhere}.rk-ln-new{color:var(--ph-ink)}.rk-ln-out .rk-ln-note{font-style:italic;color:var(--ph-dim)}
.rk-words{margin-top:6px;padding:8px 10px;border-radius:4px;background:color-mix(in oklab,var(--ph-live) 5%,transparent);box-shadow:inset 2px 0 0 0 var(--ph-live);color:var(--ph-bright);font:11.5px/1.55 var(--rk-mono);white-space:normal;overflow-wrap:anywhere}
.rk-words[data-kind=reasoning]{background:none;box-shadow:inset 2px 0 0 0 var(--ph-ghost);color:var(--ph-dim)}.rk-words[data-past=true]{background:none;box-shadow:inset 2px 0 0 0 var(--ph-rule-2);color:var(--ph-ink)}
.rk-words-who{display:block;margin-bottom:3px;font-size:9.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ph-dim)}
.rk-stream-empty{padding:6px 0;color:var(--ph-dim)}
.rk-stream-jump{position:absolute;right:14px;bottom:10px;padding:4px 8px;border:var(--rk-hair,1px) solid var(--ph-rule-2);border-radius:3px;background:var(--ph-glass-2);color:var(--ph-bright);font:600 10px/1 var(--rk-mono);cursor:pointer}
/* -- the Ladder: cheap to top, tasks climbing when their checks fail (spec v3 §4.3) -- */
.rk-lad{position:relative;display:flex;flex-direction:column;min-width:0;padding:14px 14px 10px 16px}
.rk-lad-rungs{position:relative;display:flex;flex-direction:column;margin-top:10px}
.rk-rung{position:relative;display:grid;grid-template-columns:140px minmax(0,1fr) 26px;gap:8px;align-items:center;height:40px}
.rk-rung-name{display:flex;flex-direction:column;gap:3px;min-width:0}
.rk-rung-r{font:600 9px/1 var(--rk-mono);letter-spacing:.18em;text-transform:uppercase;color:var(--ph-dim)}
.rk-rung-p{font:9.5px/1 var(--rk-mono);color:var(--ph-dim);white-space:nowrap}
.rk-rung-m{font:600 11.5px/1.15 var(--rk-mono);color:var(--ph-ink);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rk-rung-w{font:400 10px/1.1 var(--rk-mono);color:var(--ph-dim);white-space:nowrap}
/* On a run's page the ladder sits on the panel, not the glass (design system §2): its glass tokens map to the panel's. */
.rk-panel .rk-lad{--ph-dim:var(--rk-ink-3);--ph-ink:var(--rk-ink);--ph-bright:var(--rk-ink);--ph-rule-2:var(--rk-stroke-2);--ph-ghost:var(--rk-stroke-2);--ph-glass:var(--rk-module);--ph-void:var(--rk-module);--ph-live:var(--rk-live);--ph-pass:var(--rk-pass);--ph-fail:var(--rk-fail);--ph-you:var(--rk-you-text);padding:6px 0 0}
.rk-rung[data-live=true] .rk-rung-m{color:var(--ph-bright)}
.rk-rung[data-off=true] .rk-rung-m{color:var(--ph-dim)}
.rk-rail{position:relative;height:100%;overflow:visible}
.rk-rail::before{content:"";position:absolute;left:0;right:0;top:50%;border-top:var(--rk-hair,1px) solid var(--ph-rule-2)}
.rk-rail::after{content:"";position:absolute;left:0;right:0;top:calc(50% - 3px);height:7px;background:repeating-linear-gradient(90deg,var(--ph-rule-2) 0 1px,transparent 1px 18px);opacity:.7}
.rk-rung[data-live=true] .rk-rail::before{border-top-color:color-mix(in oklab,var(--ph-live) 45%,transparent);box-shadow:0 0 10px 0 color-mix(in oklab,var(--ph-live) 30%,transparent)}
.rk-rung[data-off=true] .rk-rail::before{border-top:1px dashed var(--ph-ghost)}.rk-rung[data-off=true] .rk-rail::after{display:none}
.rk-rail-note{position:absolute;left:6px;right:0;top:50%;transform:translateY(-150%);font:9.5px/1 var(--rk-mono);color:var(--ph-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rk-rail-note[data-out]{color:var(--ph-you)}
.roko-headline[data-tone=warn]{color:var(--rk-you-text)}
.rk-rcount{font:600 10.5px/1 var(--rk-mono);color:var(--ph-dim);text-align:right}.rk-rcount[data-passed=true]{color:var(--ph-pass)}
.rk-tok{position:absolute;top:50%;transform:translateY(-50%);z-index:2;display:flex;align-items:center;justify-content:center;width:32px;height:20px;border:var(--rk-hair,1px) solid var(--ph-rule-2);border-radius:3px;background:var(--ph-glass);font:600 10px/1 var(--rk-mono);color:var(--ph-dim);transition:left var(--t-gesture) var(--rk-ease)}
.rk-tok[data-state=passed]{color:var(--ph-pass);border-color:color-mix(in oklab,var(--ph-pass) 50%,transparent);background:color-mix(in oklab,var(--ph-pass) 9%,var(--ph-glass))}
.rk-tok[data-state=running]{color:var(--ph-void);background:var(--ph-live);border-color:var(--ph-live);box-shadow:0 0 0 4px color-mix(in oklab,var(--ph-live) 14%,transparent),0 0 22px -2px var(--ph-live)}
.rk-tok[data-state=failed]{color:var(--ph-fail);border-color:var(--ph-fail)}
.rk-tok[data-state=ghost]{color:var(--ph-fail);border-color:color-mix(in oklab,var(--ph-fail) 55%,transparent);border-style:dashed;background:color-mix(in oklab,var(--ph-fail) 6%,var(--ph-glass))}
.rk-tok[data-state=waiting],.rk-tok[data-state=blocked],.rk-tok[data-state=stopped]{border-style:dashed;border-color:var(--ph-ghost)}.rk-tok[data-state=blocked]{opacity:.45}
.rk-tok[data-state=unverified]{color:var(--ph-you);border-color:color-mix(in oklab,var(--ph-you) 55%,transparent)}
.rk-tok-echo{background:none;border-color:color-mix(in oklab,var(--ph-live) 50%,transparent);color:transparent;box-shadow:none;opacity:0;animation:rk-echo var(--t-passage) var(--rk-ease-lux)}
.rk-tok[data-move=climb]{animation:rk-climb var(--t-passage) var(--rk-ease-spring)}.rk-tok[data-move=failover]{animation:rk-failover var(--t-gesture) var(--rk-ease)}
.rk-trail{position:absolute;top:calc(50% + 10px);z-index:1;width:0;border-left:1.5px dashed var(--ph-live)}
.rk-trail::before{content:"";position:absolute;left:-5px;top:-2px;border:4.5px solid transparent;border-bottom:6px solid var(--ph-live);border-top:0}
.rk-lad[data-density] .rk-tok{width:12px;height:12px}.rk-lad[data-density] .rk-tok[data-state=running]{width:auto;min-width:12px;height:16px;padding:0 4px;z-index:4;font-size:9.5px}
.rk-lad[data-density] .rk-tok[data-marked]::before{content:"";position:absolute;top:-3px;right:-3px;width:5px;height:5px;border-radius:50%;background:var(--ph-fail);box-shadow:0 0 0 1px var(--ph-void)}.rk-lad[data-density] .rk-tok[data-marked=i]::before{background:var(--ph-dim)}
.rk-lad[data-density=dots] .rk-tok{width:7px;height:7px;border-radius:50%}.rk-lad[data-density=dots] .rk-tok[data-state=running]{height:14px;border-radius:3px}
.rk-tok-marks{position:absolute;top:calc(50% + 12px);display:flex;gap:2px;padding-left:3px;font:700 8.5px/1 var(--rk-mono);pointer-events:auto}.rk-tok-marks i{font-style:normal;color:var(--ph-fail)}.rk-tok-marks i[data-mark=i]{color:var(--ph-dim)}
.rk-tok-ref{position:absolute;top:calc(50% - 22px);z-index:2;font:700 10px/1 var(--rk-mono);color:var(--ph-dim)}
.rk-bglass{display:flex;flex-direction:column;gap:7px;margin:4px 0 2px;padding:9px 10px;border-radius:5px;background:var(--ph-void);box-shadow:inset 0 0 0 var(--rk-hair,1px) var(--ph-rule-2);color:var(--ph-ink);font:11px/1.45 var(--rk-mono)}
.rk-bglass[data-live=true]{box-shadow:inset 0 0 0 var(--rk-hair,1px) color-mix(in oklab,var(--ph-live) 45%,var(--ph-rule-2)),0 0 22px -12px var(--ph-live)}
.rk-bm{display:grid;grid-template-columns:auto minmax(0,1fr);gap:12px;align-items:center}.rk-bm-body{display:flex;flex-direction:column;gap:5px;min-width:0}
.rk-bm-cells{display:grid;grid-template-columns:repeat(24,1fr);gap:2px;height:9px}.rk-bm-cells i{border-radius:1px;background:var(--ph-phantom)}
.rk-bm-cells i[data-on=true]{background:var(--ph-ink);box-shadow:0 0 5px -2px var(--ph-ink)}.rk-bm-cells i[data-on=now]{background:var(--ph-live);box-shadow:0 0 8px var(--ph-live)}
.rk-bm-now{overflow:hidden;color:var(--ph-bright);white-space:nowrap;text-overflow:ellipsis}.rk-bm-now b{margin-right:4px;font:600 9px/1 var(--rk-mono);letter-spacing:.16em;text-transform:uppercase;color:var(--ph-live)}.rk-bm-now small{color:var(--ph-dim);font-size:10px}
.rk-bm-meta{color:var(--ph-dim);font-size:10.5px}
.rk-hz{position:relative;display:flex;flex-direction:column;gap:5px;padding:12px 10px 8px;border-radius:4px;overflow:hidden;container-type:inline-size;background:color-mix(in oklab,var(--ph-fail) 7%,var(--ph-void));box-shadow:inset 0 0 0 var(--rk-hair,1px) color-mix(in oklab,var(--ph-fail) 55%,transparent)}
.rk-hz::before{content:"";position:absolute;left:0;right:0;top:0;height:4px;background:repeating-linear-gradient(135deg,var(--ph-fail) 0 6px,transparent 6px 12px);opacity:.85}
.rk-hz-head{display:flex;align-items:center;gap:8px;color:var(--ph-dim);font-size:10.5px}.rk-hz-loc{color:var(--ph-bright);font-weight:600;overflow-wrap:anywhere}.rk-hz-loc i{font-style:normal;color:var(--ph-fail)}
.rk-hz-msg{color:color-mix(in oklab,var(--ph-fail) 55%,var(--ph-bright));overflow-wrap:anywhere}
.rk-hz-code{margin:0;padding:5px 8px;border-left:2px solid var(--ph-fail);border-radius:2px;background:var(--ph-glass);white-space:pre;overflow-x:auto;color:var(--ph-ink)}.rk-hz-n{color:var(--ph-dim)}.rk-hz-caret{color:var(--ph-fail);font-weight:700}
/* P-21: a narrow glass (the stream) keeps the window around the caret, its cut ends marked; the caret line's marks hold the same room unseen. */
@container (max-width:360px){.rk-hz-cut{display:none}.rk-hz-win[data-l=true]::before{content:"…"}.rk-hz-win[data-r=true]::after{content:"…"}.rk-hz-caret .rk-hz-win::before,.rk-hz-caret .rk-hz-win::after{visibility:hidden}}
.rk-hz-verdict{color:var(--ph-dim);font-size:10.5px;overflow-wrap:anywhere}.rk-hz[data-compact=true]{padding-top:10px}
.rk-tp{display:flex;flex-direction:column;gap:5px}.rk-tp-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.rk-tp-pips{display:inline-flex;flex-wrap:wrap;gap:2px;max-width:100%}.rk-tp-pips i{width:6px;height:12px;border-radius:1px;background:var(--ph-pass);box-shadow:0 0 5px -2px var(--ph-pass)}.rk-tp-pips i[data-pip=f]{background:none;box-shadow:inset 0 0 0 1.2px var(--ph-fail)}
.rk-tp-count{color:var(--ph-pass);font-size:10.5px}.rk-tp-count[data-failed=true]{color:var(--ph-fail)}
.rk-tp-fail b{color:var(--ph-fail);font-weight:600}.rk-tp-fail small{color:var(--ph-dim)}.rk-tp-expr{color:var(--ph-ink);overflow-wrap:anywhere}.rk-tp-expr span{color:var(--ph-dim)}.rk-tp-logged{color:var(--ph-dim);font-style:italic;overflow-wrap:anywhere}
.rk-pv{color:var(--ph-ink)}.rk-pv b{color:var(--ph-bright)}.rk-pv[data-result=passed]{color:var(--ph-pass)}.rk-pv[data-result=failed]{color:var(--ph-fail)}
.rk-ln-glass{padding-left:62px}.rk-ln-out[data-glass=true]{color:var(--ph-dim)}
.rk-padcheck{display:inline-flex;align-items:center;gap:5px;font:10px/1 var(--rk-mono);color:var(--rk-live);white-space:nowrap}.rk-padcheck[data-failed=true]{color:var(--rk-fail)}
.rk-padcheck i{display:block;width:22px;height:3px;border-radius:2px;background:color-mix(in oklab,var(--rk-live) 18%,transparent);overflow:hidden}.rk-padcheck i b{display:block;height:100%;background:var(--rk-live)}
.roko-feed-earlier{display:block;width:100%;padding:6px 0;border:0;border-bottom:var(--rk-hair,1px) dashed var(--rk-stroke-2);background:none;font:600 10.5px/1 var(--rk-mono);letter-spacing:.08em;color:var(--rk-ink-3);cursor:pointer}.roko-feed-earlier:hover{color:var(--rk-ink-1)}.roko-feed-earlier[disabled]{cursor:progress}
.roko-feed-reading,.roko-reading{display:flex;align-items:center;gap:8px;padding:6px 2px;font:600 10.5px/1.3 var(--rk-mono);letter-spacing:.06em;color:var(--ph-live,var(--rk-live))}
.roko-reading{margin:6px 0;padding:6px 10px;border:var(--rk-hair,1px) dashed var(--rk-stroke-2);border-radius:6px}
.rk-climbnote,.rk-lad-stamp,.rk-lad-failover{position:absolute;top:50%;z-index:3;transform:translateY(-50%);white-space:nowrap}.rk-lad-failover{overflow:hidden;text-overflow:ellipsis;letter-spacing:.06em}
.rk-climbnote{font:9.5px/1 var(--rk-mono);color:var(--ph-live)}
.rk-tok[data-failover=true]::after{content:"⇄";position:absolute;top:-7px;right:-7px;padding:0 2px;border-radius:2px;background:var(--ph-void);font:9px/1.3 var(--rk-mono);color:var(--ph-fail)}
.rk-lad-stamp{padding:2px 4px;border-radius:2px;background:var(--ph-void)}.rk-lad-stamp .rk-stamp{gap:5px;letter-spacing:.16em}.rk-stamp-2{display:block;line-height:1.2}.rk-tok[data-exhausted=true]{box-shadow:0 0 0 2px color-mix(in oklab,var(--ph-you) 50%,transparent)}
.rk-lad-foot{display:flex;flex-wrap:wrap;gap:4px 12px;margin-top:auto;padding-top:6px;font:9.5px/1 var(--rk-mono);color:var(--ph-dim)}
.rk-lad-foot b{font-weight:600}.rk-lad-foot [data-channel=pass]{color:var(--ph-pass)}.rk-lad-foot [data-channel=fail]{color:var(--ph-fail)}.rk-lad-foot [data-channel=live]{color:var(--ph-live)}
/* the mini ladder in a track row: four rails{display:grid;grid-template-rows:repeat(4,3px);gap:3px;width:40px}
/* -- CHEST: the instrument{display:grid;grid-template-columns:minmax(0,1fr);min-height:236px}
.rk-cnote{display:inline-flex;flex-wrap:wrap;gap:0 8px;font:10px/1.35 var(--rk-mono);color:var(--ph-dim)}
.rk-cnote-2{display:block;overflow:hidden;text-overflow:ellipsis}
.rk-cnote [data-channel=live]{color:var(--ph-live)}.rk-cnote [data-channel=fail]{color:var(--ph-fail)}.rk-cnote [data-channel=you]{color:var(--ph-you)}.rk-cnote [data-channel=pass]{color:var(--ph-pass)}
/* -- the horizon: one glass line, the live step (spec v3 §4.8) -- */
.rk-horizon{display:flex;align-items:center;gap:10px;min-height:34px;padding:0 14px;border-radius:var(--rk-radius-m);font:12px/1.2 var(--rk-mono)}
.rk-horizon-who{flex:none;color:var(--ph-dim);white-space:nowrap}
.rk-horizon-clock{flex:none;margin-left:auto;color:var(--ph-dim);font-variant-numeric:tabular-nums}
.rk-ticker-lane{display:flex;align-items:center;justify-content:flex-start;gap:16px;flex:1;min-width:0;overflow:hidden;white-space:nowrap}
.rk-ticker-item{flex:none;color:var(--ph-dim)}
.rk-ticker-item b{margin-right:3px;font-weight:700;color:inherit}
.rk-ticker-item[data-age="0"]{order:9;flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--ph-bright);animation:rk-tick-in var(--t-gesture) var(--rk-ease)}
.rk-ticker-item[data-age="0"] b{color:var(--ph-live)}
.rk-ticker-item[data-age="1"]{order:8;color:var(--ph-ink)}.rk-ticker-item[data-age="2"]{order:7}
.rk-ticker-item[data-kind=text],.rk-ticker-item[data-kind=reasoning]{font-style:italic}
.rk-ticker-item[data-kind=idle]{color:var(--ph-ink)}
.rk-ticker-item[data-channel=you],.rk-ticker-item[data-channel=you] b{color:var(--ph-you)}
.rk-ticker-item:has(>.rk-said){display:inline-flex;align-items:baseline}
.rk-ticker-item>b{flex:none}
.rk-said{display:inline-flex;justify-content:flex-end;min-width:0;overflow:hidden}
.rk-said>span{flex:none;white-space:nowrap}
.rk-said b,.rk-words b{font-weight:650;color:var(--ph-bright)}.rk-said code,.rk-words code{padding:0;border:0;background:none;font:inherit;color:var(--ph-bright)}
.rk-cursor{display:inline-block;width:7px;height:13px;margin-left:3px;vertical-align:-2px;background:var(--ph-live);box-shadow:0 0 8px var(--ph-live);animation:rk-cursor 1.2s steps(1,end) infinite}
.rk-well.rk-ticker{gap:10px;min-height:34px;padding:7px 12px;font-family:var(--rk-mono);font-size:11.5px;overflow:hidden}

.rk-scope{padding:3px 5px}
.rk-scope-svg{display:block;overflow:visible}
.rk-scope-grid{stroke:color-mix(in oklab,white 6%,transparent);stroke-width:1;vector-effect:non-scaling-stroke}
.rk-scope-axis{stroke:color-mix(in oklab,white 12%,transparent)}
.rk-scope-trace{fill:none;stroke:var(--rk-scope,var(--rk-px-agent));stroke-width:1.5;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round;filter:drop-shadow(0 0 2.5px var(--rk-scope,var(--rk-px-agent)))}
.rk-scope[data-tone=pass]{--rk-scope:var(--rk-px-pass)}.rk-scope[data-tone=fail]{--rk-scope:var(--rk-px-fail)}.rk-scope[data-tone=you]{--rk-scope:var(--rk-px-you)}.rk-scope[data-tone=ink]{--rk-scope:var(--rk-px-on)}
.roko-stepclock{font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.roko-why{display:flex;gap:11px;align-items:flex-start;padding:12px 14px;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid color-mix(in oklab,var(--roko-why) 40%,transparent);border-left-width:3px;background:color-mix(in oklab,var(--roko-why) 6%,transparent);--roko-why:var(--rk-ink-3)}
.roko-why[data-tone=bad]{--roko-why:var(--rk-fail)}.roko-why[data-tone=warn]{--roko-why:var(--rk-you)}
.roko-why-icon{flex:none;margin-top:1px;color:var(--roko-why)}
.roko-why-body{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0}
.roko-why-title{font-family:var(--rk-mono);font-size:10px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--roko-why)}
.roko-why-text{margin:0;font-size:12.5px;line-height:1.6;color:var(--rk-ink);overflow-wrap:anywhere}
.roko-run-foot{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;padding-top:6px;border-top:var(--rk-hair,1px) solid var(--rk-stroke-soft)}
.roko-run-foot .roko-muted{font-size:11px}

/* -- the sequencer ------------------------------------------------------------- */

.roko-graph-card{display:flex;flex-direction:column;gap:10px;min-width:0}
.roko-graph-empty{flex-direction:row;align-items:center;justify-content:center;gap:12px;min-height:120px;border-radius:var(--rk-radius-m);border:1px dashed var(--rk-stroke);color:var(--rk-ink-3);font-size:12.5px}
.roko-graph-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:24px}
.roko-graph-title{font-family:var(--rk-mono);font-size:10px;font-weight:600;letter-spacing:.1em;color:var(--rk-ink-3)}
.roko-graph-hint{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--rk-ink-3)}
.roko-legend{display:inline-flex;flex-wrap:wrap;gap:4px 11px;font-size:11px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.roko-legend-item{display:inline-flex;align-items:center;gap:5px}
.roko-legend-item i{width:7px;height:7px;border-radius:1px;border:var(--rk-hair,1px) solid var(--rk-stroke-2)}
.roko-legend-item[data-kind=passed] i{background:var(--rk-pass);border-color:transparent}.roko-legend-item[data-kind=failed] i{background:var(--rk-fail);border-color:transparent}.roko-legend-item[data-kind=running] i{background:var(--rk-live);border-color:transparent}.roko-legend-item[data-kind=blocked] i{border-style:dashed;border-color:var(--rk-fail)}
.roko-graph-frame{position:relative;overflow-x:auto;overflow-y:hidden;padding:4px 0;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid var(--rk-stroke);background:radial-gradient(color-mix(in oklab,var(--rk-ink) 9%,transparent) .9px,transparent 1.2px) 0 0/12px 12px,var(--rk-sunk)}
.roko-graph{position:relative;margin:0 auto}
.rk-step-col{position:absolute;bottom:0;border-radius:var(--rk-radius);transition:background-color .3s}
.rk-step-col[data-active=true]{background:color-mix(in oklab,var(--rk-live) 6%,transparent)}
.rk-step-col[data-done=true]{background:color-mix(in oklab,var(--rk-ink) 2.5%,transparent)}
.roko-graph-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.rk-step-n{position:absolute;top:8px;display:grid;place-items:center;width:18px;height:18px;border-radius:3px;background:var(--rk-module-2);box-shadow:inset 0 0 0 1px var(--rk-stroke-2);font:700 9.5px/1 var(--rk-mono);letter-spacing:0;color:var(--rk-ink-3)}
.rk-step-n[data-state]{box-shadow:none;color:var(--ph-bright)}.rk-step-n[data-state=live]{background:var(--rk-live)}.rk-step-n[data-state=pass]{background:var(--rk-pass)}.rk-step-n[data-state=fail]{background:var(--rk-fail)}
.rk-playhead{position:absolute;z-index:1;width:1.5px;border-radius:2px;background:var(--rk-live);box-shadow:0 0 10px var(--rk-live);pointer-events:none;transition:left var(--t-passage) var(--rk-ease-lux)}
.rk-playhead::before{content:"";position:absolute;top:0;left:-4px;border:5px solid transparent;border-top:6px solid var(--rk-live)}
.rk-playhead[data-mode=live]{animation:rk-scan 2.4s ease-in-out infinite}
.rk-playhead[data-mode=replay]{transition:left .12s linear}
.roko-edge{fill:none;stroke:var(--rk-stroke-2);stroke-width:1.3;transition:stroke .3s}
.roko-edge-end{fill:var(--rk-stroke-2);transition:fill .3s}
.roko-edge[data-state=done]{stroke:color-mix(in oklab,var(--rk-pass) 60%,var(--rk-stroke-2))}.roko-edge-end[data-state=done]{fill:color-mix(in oklab,var(--rk-pass) 70%,transparent)}
.roko-edge[data-state=live]{stroke:var(--rk-live);stroke-width:1.5;stroke-dasharray:3 4;animation:roko-flow .9s linear infinite}.roko-edge-end[data-state=live]{fill:var(--rk-live)}
.roko-edge[data-state=blocked],.roko-edge[data-state=broken]{stroke:color-mix(in oklab,var(--rk-fail) 50%,transparent);stroke-dasharray:2 4}.roko-edge-end[data-state=blocked],.roko-edge-end[data-state=broken]{fill:color-mix(in oklab,var(--rk-fail) 50%,transparent)}
.roko-node{position:absolute;z-index:2;display:flex;flex-direction:column;justify-content:space-between;gap:4px;padding:9px 10px 8px 11px;overflow:hidden;border:var(--rk-hair,1px) solid var(--rk-stroke-2);border-radius:var(--rk-radius-m);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);transition:border-color .2s var(--rk-ease),background-color .2s var(--rk-ease),box-shadow .14s var(--rk-ease),transform 80ms var(--rk-ease);--rk-node:transparent}
.rk-rchip{display:inline-flex;align-items:center;flex:none;height:14px;padding:0 4px;border-radius:2px;font:600 9px/1 var(--rk-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--rk-ink-3);box-shadow:inset 0 0 0 1px var(--rk-stroke-2);white-space:nowrap}
.rk-rchip[data-climbed=true]{color:var(--rk-live);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--rk-live) 55%,transparent)}
.rk-lives{display:inline-flex;gap:3px;align-items:center}
.rk-pad-lessons{font:600 9.5px/1 var(--rk-mono);color:var(--rk-learn)}
.rk-lives i{position:relative;display:block;width:7px;height:7px;border-radius:50%;box-shadow:inset 0 0 0 1px var(--rk-ink-4)}
.rk-lives i[data-life=x]{border-radius:0;box-shadow:none}
.rk-lives i[data-life=x]::before,.rk-lives i[data-life=x]::after{content:"";position:absolute;left:3px;top:-1px;width:1.4px;height:9px;background:var(--rk-fail);transform:rotate(45deg)}.rk-lives i[data-life=x]::after{transform:rotate(-45deg)}
.rk-lives i[data-life=r]{background:var(--rk-live);box-shadow:0 0 6px var(--rk-live)}.rk-lives i[data-life=p]{background:var(--rk-pass);box-shadow:none}
.rk-lives i[data-life=i]{width:auto;height:auto;border-radius:0;box-shadow:none;font:700 10px/7px var(--rk-mono);color:var(--rk-ink-3)}.rk-lives i[data-life=i]::before{content:"∿"}
.roko-node[data-channel=agent]{--rk-node:var(--rk-live)}.roko-node[data-channel=pass]{--rk-node:var(--rk-pass)}.roko-node[data-channel=you]{--rk-node:var(--rk-you)}.roko-node[data-channel=fail]{--rk-node:var(--rk-fail)}
.roko-node:hover{background:color-mix(in oklab,var(--rk-module) 94%,var(--rk-ink))}
.roko-node:active{transform:translateY(2px);box-shadow:0 0 0 0 var(--rk-stroke-2)}
.roko-node:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.roko-node[data-selected=true]{transform:translateY(1px);box-shadow:0 1px 0 0 var(--rk-stroke-2),0 0 0 2px color-mix(in oklab,var(--rk-ink) 70%,transparent)}
.roko-node[data-state=pending]{background:transparent;border-style:dashed;box-shadow:none;color:var(--rk-ink-2)}
.roko-node[data-state=pending] .roko-node-title{font-weight:500}
.roko-node[data-state=running]{border-color:var(--rk-node);box-shadow:0 0 0 1px color-mix(in oklab,var(--rk-node) 40%,transparent),0 2px 0 0 var(--rk-stroke)}
.roko-node[data-state=running] .roko-node-id{color:var(--rk-node)}
.roko-node[data-state=passed]{border-color:var(--rk-stroke-2)}
.roko-node[data-state=failed]{border-color:var(--rk-fail)}
.roko-node[data-state=unverified]{border-color:var(--rk-stroke-2)}
.roko-node[data-state=blocked]{border-style:dashed;background:transparent;box-shadow:none;color:var(--rk-ink-3)}
.roko-node[data-state=stopped]{box-shadow:none;color:var(--rk-ink-3)}.roko-node[data-state=stopped] .roko-node-title,.roko-node[data-state=blocked] .roko-node-title{color:var(--rk-ink-3)}
.roko-node[data-flash=true]{animation:rk-pad-flash .5s ease-out 1}
.roko-node[data-state=plan]{--rk-node:color-mix(in oklab,var(--rk-ink) 25%,transparent)}
.roko-node-top{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;line-height:1.4;min-width:0;padding-bottom:1px}
.roko-node-head{display:flex;align-items:center;gap:6px;min-width:0}
.roko-node-id{display:inline-block;flex:none;color:var(--rk-ink);font-family:var(--rk-mono);font-size:12px;font-weight:750;letter-spacing:.02em}
.roko-node-title{font-weight:550;color:var(--rk-ink-2)}
.roko-node-foot{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.roko-node-meta{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.roko-node-time{flex:none}
.roko-node-step{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-node);font-weight:600}
.roko-pips{display:inline-flex;align-items:center;gap:3px;margin-left:auto;flex:none}
.roko-pip{width:7px;height:7px;border-radius:1px;border:1.3px solid var(--rk-stroke-2);background:transparent}
.roko-pip[data-state=pass]{background:var(--rk-pass);border-color:transparent}.roko-pip[data-state=fail]{background:var(--rk-fail);border-color:transparent}
.roko-pip[data-superseded=true]{opacity:.35}
.rk-plan-questions{margin:4px 0;padding-left:18px;display:grid;gap:4px;font-size:12.5px;color:var(--rk-ink)}
.rk-oq-list{display:grid;gap:8px;margin:6px 0}
.rk-oq{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:10px 12px;border-radius:var(--rk-radius-m);background:var(--rk-module);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--rk-you) 45%,transparent)}
.rk-oq-q{margin:2px 0 0;font-size:15px;line-height:1.4;font-weight:550;color:var(--rk-ink)}.rk-oq-q b{font:600 11px/1 var(--rk-mono);color:var(--rk-ink-3)}
.rk-oq-s{margin:0;font-size:12.5px;color:var(--rk-ink-2)}.rk-oq-then{margin:2px 0 0;font:10.5px/1.4 var(--rk-mono);color:var(--rk-you-text)}
.roko-pip[data-state=run]{border-color:var(--rk-live);background:color-mix(in oklab,var(--rk-live) 40%,transparent);animation:rk-blink 1.2s steps(1,end) infinite}
.roko-pips-more{font-size:10px;color:var(--rk-ink-3)}
.roko-mini{display:block;flex:none;overflow:visible}
.roko-mini-edge{stroke:var(--rk-stroke-2);stroke-width:1}
.roko-mini-dot{fill:transparent;stroke:var(--rk-stroke-2);stroke-width:1;transition:fill .3s}
.roko-mini-dot[data-state=passed]{fill:var(--rk-pass);stroke:transparent}.roko-mini-dot[data-state=failed]{fill:var(--rk-fail);stroke:transparent}.roko-mini-dot[data-state=running]{fill:var(--rk-live);stroke:transparent;animation:rk-blink 1.2s steps(1,end) infinite}.roko-mini-dot[data-state=blocked]{fill:transparent;stroke:var(--rk-fail);stroke-dasharray:2 1.5}.roko-mini-dot[data-state=stopped]{fill:var(--rk-ink-4);stroke:transparent}.roko-mini-dot[data-state=waiting]{fill:var(--rk-you);stroke:transparent;animation:rk-blink .5s steps(1,end) infinite}

/* -- the inspector ------------------------------------------------------------- */
.roko-inspector{display:flex;flex-direction:column;gap:11px;padding:14px 16px;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid var(--rk-stroke-2);border-top:2px solid var(--rk-insp,var(--rk-stroke-2));background:var(--rk-module);animation:rk-slide .22s var(--rk-ease)}
.roko-inspector[data-channel=agent]{--rk-insp:var(--rk-live)}.roko-inspector[data-channel=pass]{--rk-insp:var(--rk-pass)}.roko-inspector[data-channel=you]{--rk-insp:var(--rk-you)}.roko-inspector[data-channel=fail]{--rk-insp:var(--rk-fail)}
.roko-inspector-head{display:flex;align-items:center;gap:8px;min-width:0}
.roko-inspector-title{flex:1;min-width:0;font-weight:650;font-size:14px;overflow-wrap:anywhere}
.roko-inspector-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:12px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}


.rk-route{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-sunk)}
.rk-route-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rk-route-head .codicon{color:var(--rk-live)}
.rk-route-model{font-family:var(--rk-mono);font-size:12.5px;font-weight:700}
.rk-route-p{font-family:var(--rk-mono);font-size:11px;color:var(--rk-live)}
.rk-route-reason{font-size:12px;line-height:1.5;color:var(--rk-ink-2);overflow-wrap:anywhere}
.rk-cands{display:flex;flex-direction:column;gap:4px}
.rk-cand{display:grid;grid-template-columns:minmax(90px,150px) minmax(60px,1fr) 38px minmax(0,120px);align-items:center;gap:8px;font-size:11px}
.rk-cand-model{font-family:var(--rk-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rk-ink-2)}
.rk-cand[data-pick=true] .rk-cand-model{color:var(--rk-ink);font-weight:700}
.rk-cand-bar{display:block;height:6px;background:color-mix(in oklab,var(--rk-ink) 8%,transparent);-webkit-mask:repeating-linear-gradient(90deg,black 0 3px,transparent 3px 4px);mask:repeating-linear-gradient(90deg,black 0 3px,transparent 3px 4px)}
.rk-cand-bar i{display:block;height:100%;background:color-mix(in oklab,var(--rk-live) 45%,var(--rk-ink-3))}
.rk-cand[data-pick=true] .rk-cand-bar i{background:var(--rk-live)}
.rk-cand[data-eligible=false]{opacity:.55}.rk-cand[data-eligible=false] .rk-cand-bar i{background:var(--rk-fail)}
.rk-cand[data-eligible=false]{grid-template-columns:minmax(90px,150px) minmax(0,1fr);align-items:baseline}
.rk-cand[data-eligible=false] .rk-cand-bar,.rk-cand[data-eligible=false] .rk-cand-score{display:none}
.rk-cand[data-eligible=false] .rk-cand-note{white-space:normal;overflow:visible;text-overflow:clip;line-height:1.35}
.rk-cand-score{font-family:var(--rk-mono);text-align:right;font-variant-numeric:tabular-nums}
.rk-cand-note{font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-tasklive{display:flex;flex-direction:column;gap:7px}
.rk-steps{flex-direction:column;align-items:stretch;gap:2px;padding:7px 10px;font-family:var(--rk-mono);font-size:11px}
.rk-steps-row{display:grid;grid-template-columns:62px 82px minmax(0,1fr);gap:8px;color:color-mix(in oklab,white 45%,transparent);white-space:nowrap}
.rk-steps-row[data-newest=true]{color:var(--rk-px-on);animation:rk-tick-in .24s var(--rk-ease)}
.rk-steps-row[data-newest=true] .rk-steps-tool{color:var(--rk-px-agent)}
.rk-steps-target{overflow:hidden;text-overflow:ellipsis}
.rk-said{font-style:italic}
.rk-taskloops{display:flex;flex-direction:column;gap:9px}
.rk-effects,.rk-lessons{display:flex;flex-direction:column;gap:5px}
.rk-effect{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px}
.rk-lesson{display:grid;grid-template-columns:auto minmax(0,1fr);column-gap:8px;row-gap:2px;align-items:baseline;font-size:12px}
.rk-lesson>:not(:first-child){grid-column:2}
.rk-lesson-text{min-width:0;flex:1;color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-plan-desc{margin:0;font-size:12.5px;line-height:1.6;color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-checklist{display:flex;flex-direction:column;gap:4px}
.roko-checkcmd{display:block;padding:5px 9px;border-radius:var(--rk-radius);background:var(--rk-sunk);border:var(--rk-hair,1px) solid var(--rk-stroke-soft);font-family:var(--rk-mono);font-size:11.5px;color:var(--rk-ink);overflow-wrap:anywhere}
.roko-checkcmd span{color:var(--rk-ink-4)}
.roko-pipe{display:flex;flex-direction:column;gap:7px}
.roko-pipe-row{display:flex;align-items:center;flex-wrap:wrap;row-gap:6px;font-size:11.5px}
.roko-pipe-label{width:30px;flex:none;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-4)}
.roko-pipe-stage{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid var(--rk-stroke);background:var(--rk-module);color:var(--rk-ink-2);font-family:var(--rk-mono);font-size:11px;white-space:nowrap}
.roko-pipe-stage .codicon{color:var(--rk-live)}
.roko-pipe-stage .rk-tag{margin-left:2px;height:15px;font-size:9px}
.roko-pipe-stage[data-state=pass]{border-color:color-mix(in oklab,var(--rk-pass) 45%,var(--rk-stroke));color:var(--rk-ink)}.roko-pipe-stage[data-state=pass] span{color:var(--rk-pass)}
.roko-pipe-stage[data-state=fail]{border-color:color-mix(in oklab,var(--rk-fail) 55%,var(--rk-stroke));background:color-mix(in oklab,var(--rk-fail) 6%,var(--rk-module));color:var(--rk-ink)}.roko-pipe-stage[data-state=fail] span{color:var(--rk-fail)}
.roko-pipe-stage[data-state=run]{border-color:var(--rk-live);color:var(--rk-ink);box-shadow:0 0 0 1px color-mix(in oklab,var(--rk-live) 35%,transparent)}.roko-pipe-stage[data-state=run] span{color:var(--rk-live)}
.roko-pipe-link{width:14px;height:1px;flex:none;background:var(--rk-stroke-2)}
.roko-pipe-end{padding:0 6px;font-family:var(--rk-mono);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--rk-ink-3)}
.roko-pipe-end[data-state=passed]{color:var(--rk-pass)}.roko-pipe-end[data-state=failed]{color:var(--rk-fail)}.roko-pipe-end[data-state=running]{color:var(--rk-live)}.roko-pipe-end[data-state=blocked],.roko-pipe-end[data-state=unverified]{color:var(--rk-you-text)}
.roko-pipe-time{margin-left:auto;padding-left:10px;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-4)}
.roko-checkout{display:flex;flex-direction:column;gap:7px}
.roko-keyline{display:flex;gap:8px;align-items:flex-start;padding:8px 11px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-fail) 30%,transparent);border-left:3px solid var(--rk-fail);background:color-mix(in oklab,var(--rk-fail) 6%,transparent);font-family:var(--rk-mono);font-size:11.5px;line-height:1.5;color:var(--rk-ink);overflow-wrap:anywhere}
.roko-keyline .codicon{flex:none;margin-top:2px;color:var(--rk-fail)}
.roko-note-block{display:flex;flex-direction:column;gap:7px}
.roko-quote{margin:0;padding:9px 13px;border-left:2px solid var(--rk-ink-3);background:var(--rk-sunk);font-size:12.5px;line-height:1.55;color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-quote .roko-clamp-text{font-style:italic;color:var(--rk-ink-2)}
.roko-deps{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.roko-callout{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:8px 11px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid var(--rk-stroke);background:var(--rk-sunk);font-size:12px;color:var(--rk-ink-2)}
.roko-callout .codicon{flex:none}
.roko-callout[data-tone=warn],.roko-callout[data-tone=you]{border-color:color-mix(in oklab,var(--rk-you) 45%,transparent);border-left:3px solid var(--rk-you);background:color-mix(in oklab,var(--rk-you) 6%,transparent);color:var(--rk-ink)}.roko-callout[data-tone=warn] .codicon{color:var(--rk-you-text)}

/* -- activity, replay ---------------------------------------------------------- */
.roko-feed{position:relative;display:flex;flex-direction:column;gap:8px;min-width:0}
.roko-feed-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.roko-filters{display:inline-flex;flex-wrap:wrap;gap:4px}
.roko-filter{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid var(--rk-stroke);background:transparent;color:var(--rk-ink-2);font:inherit;font-size:11.5px;cursor:pointer;box-shadow:0 1px 0 0 var(--rk-stroke);transition:background-color .14s,border-color .14s}
.roko-filter:hover{color:var(--rk-ink)}
.roko-filter[aria-pressed=true]{border-color:var(--rk-ink-3);background:color-mix(in oklab,var(--rk-ink) 8%,transparent);color:var(--rk-ink);box-shadow:none;transform:translateY(1px)}
.roko-filter-count{font-family:var(--rk-mono);font-size:10px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.roko-live-tag{display:inline-flex;align-items:center;gap:6px;font-family:var(--rk-mono);font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--rk-live)}
.roko-feed-list{display:flex;flex-direction:column;max-height:480px;overflow:auto;padding:6px 0;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid var(--rk-stroke);background:var(--rk-sunk);font-size:12px}
.roko-feed[data-compact=true] .roko-feed-list{max-height:none;overflow:visible}
.roko-feed-empty{padding:4px 2px}
.roko-feed-row{display:grid;grid-template-columns:50px 16px minmax(0,1fr);gap:7px;align-items:baseline;padding:3px 12px 3px 6px;line-height:1.5;transition:opacity .2s,background-color .2s;animation:roko-rise .3s var(--rk-ease) both}
.roko-feed-row:hover{background:var(--ui-row-hover-background)}
.roko-feed-time{font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-4);text-align:right;font-variant-numeric:tabular-nums}
.roko-feed-icon{display:inline-flex;justify-content:center;color:var(--rk-ink-3);transform:translateY(2px)}
.roko-feed-row[data-tone=good] .roko-feed-icon{color:var(--rk-pass)}.roko-feed-row[data-tone=bad] .roko-feed-icon{color:var(--rk-fail)}.roko-feed-row[data-tone=warn] .roko-feed-icon{color:var(--rk-you-text)}.roko-feed-row[data-tone=live] .roko-feed-icon{color:var(--rk-live)}
.roko-feed-text{min-width:0;color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-feed-row[data-tone=bad] .roko-feed-text{color:var(--rk-ink)}
.roko-feed-quote{display:flex;gap:7px;min-width:0}
.roko-feed-task{flex:none;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3)}
.roko-feed-said{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic;color:var(--rk-ink-3)}
.roko-feed-row[data-future=true]{opacity:.28}
.roko-feed-row[data-current=true]{background:color-mix(in oklab,var(--rk-you) 12%,transparent)}
.roko-feed-jump{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 12px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid var(--rk-stroke-2);background:var(--ui-bg-elevated);color:var(--rk-ink);font:inherit;font-size:11.5px;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);animation:roko-rise .2s var(--rk-ease)}
.roko-feed-all{align-self:flex-start;margin-left:6px}
.roko-replay{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid var(--rk-stroke);background:var(--rk-sunk);animation:roko-rise .2s var(--rk-ease)}
.roko-replay-play{display:inline-grid;place-items:center;flex:none;width:30px;height:28px;border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-you) 72%,black);border-radius:var(--rk-radius);background:var(--rk-you);color:color-mix(in oklab,black 88%,var(--rk-you));cursor:pointer;box-shadow:0 2px 0 0 color-mix(in oklab,var(--rk-you) 52%,black)}
.roko-replay-play:active{transform:translateY(2px);box-shadow:none}
.roko-replay-play:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.roko-replay-track{position:relative;flex:1;height:24px;cursor:pointer;touch-action:none;border-radius:var(--rk-radius)}
.roko-replay-track:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.roko-replay-track::before{content:"";position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;background:color-mix(in oklab,var(--rk-ink) 10%,transparent)}
.roko-replay-fill{position:absolute;left:0;top:50%;height:4px;margin-top:-2px;background:var(--rk-you)}
.roko-replay-tick{position:absolute;top:5px;width:2px;height:14px;margin-left:-1px;background:var(--rk-stroke-2);opacity:.85;pointer-events:none}
.roko-replay-tick[data-group=agent]{background:color-mix(in oklab,var(--rk-live) 70%,transparent)}.roko-replay-tick[data-tone=good]{background:var(--rk-pass)}.roko-replay-tick[data-tone=bad]{background:var(--rk-fail);height:18px;top:3px}
.roko-replay-head{position:absolute;top:2px;width:3px;height:20px;margin-left:-1.5px;background:var(--rk-you);box-shadow:0 0 6px var(--rk-you);pointer-events:none}
.roko-replay-time{min-width:92px;font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-2);text-align:right;font-variant-numeric:tabular-nums}

/* -- changes and merge --------------------------------------------------------- */
.roko-changes{display:flex;flex-direction:column;gap:10px;min-width:0;container-type:inline-size}
.roko-changes-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.roko-changes-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px}
.roko-changes-body{display:grid;grid-template-columns:minmax(170px,230px) minmax(0,1fr);gap:12px;align-items:start}
@container (max-width:700px){.roko-changes-body{grid-template-columns:minmax(0,1fr)}.roko-filelist{position:static;max-height:220px}}
.roko-filelist{position:sticky;top:0;display:flex;flex-direction:column;gap:1px;max-height:72vh;overflow:auto;padding:4px;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid var(--rk-stroke);background:var(--rk-sunk)}
.roko-filename{display:flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}
.roko-filename-base{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--rk-mono);font-size:11.5px;color:var(--rk-ink)}
.roko-filename-dir{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:10.5px;color:var(--rk-ink-3)}
.roko-filelist-stat{display:inline-flex;gap:5px;font-family:var(--rk-mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.roko-filelist-row{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:7px;align-items:center;padding:5px 7px;border:0;border-radius:var(--rk-radius);background:none;color:var(--rk-ink-2);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.roko-filelist-row:hover,.roko-filelist-row[aria-current=true]{background:var(--ui-row-hover-background);color:var(--rk-ink)}
.roko-filelist-row[aria-current=true]{box-shadow:inset 2px 0 0 var(--rk-you)}
.roko-status-letter{font-family:var(--rk-mono);font-size:10.5px;font-weight:800;text-align:center;color:var(--rk-ink-3)}
.roko-status-letter[data-status=added]{color:var(--rk-pass)}.roko-status-letter[data-status=deleted]{color:var(--rk-fail)}.roko-status-letter[data-status=modified]{color:var(--rk-you-text)}.roko-status-letter[data-status=renamed]{color:var(--rk-live)}
.roko-diffs{display:flex;flex-direction:column;gap:12px;min-width:0}
.roko-filediff{min-width:0;overflow:clip;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module)}
.roko-filediff-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;min-width:0;padding:5px 8px 5px 6px;border-bottom:var(--rk-hair,1px) solid var(--rk-stroke-soft);background:var(--ui-bg-elevated)}
.roko-filediff-toggle{display:flex;flex:1;align-items:center;gap:7px;min-width:0;padding:2px 4px;border:0;border-radius:var(--rk-radius);background:none;color:var(--rk-ink);font:inherit;text-align:left;cursor:pointer}
.roko-filediff-toggle:hover{background:var(--ui-row-hover-background)}
.roko-caret{flex:none;color:var(--rk-ink-3)}
.roko-filediff-body{overflow-x:auto;font-family:var(--rk-mono);font-size:11.5px;line-height:1.6}
.roko-dl{display:grid;grid-template-columns:42px 42px 18px minmax(0,1fr);min-width:max-content}
.roko-ln{padding:0 8px;text-align:right;color:var(--rk-ink-4);user-select:none;font-variant-numeric:tabular-nums}
.roko-ln+.roko-ln{border-right:var(--rk-hair,1px) solid var(--rk-stroke-soft)}
.roko-sign{text-align:center;user-select:none;color:var(--rk-ink-4)}
.roko-dcode{padding-right:18px;white-space:pre;color:var(--rk-ink);font:inherit;background:none}
.roko-dl[data-tag=add]{background:var(--ui-diff-add-background);box-shadow:inset 2px 0 0 var(--ui-diff-add-border)}.roko-dl[data-tag=add] .roko-sign{color:var(--ui-diff-add-foreground);font-weight:700}
.roko-dl[data-tag=del]{background:var(--ui-diff-remove-background);box-shadow:inset 2px 0 0 var(--ui-diff-remove-border)}.roko-dl[data-tag=del] .roko-sign{color:var(--ui-diff-remove-foreground);font-weight:700}
.roko-dl[data-tag=meta] .roko-dcode{font-style:italic;color:var(--rk-ink-3)}
.roko-t-kw{color:color-mix(in oklab,var(--rk-live) 70%,var(--rk-ink));font-weight:550}.roko-t-str{color:color-mix(in oklab,var(--rk-you) 78%,var(--rk-ink))}.roko-t-num{color:color-mix(in oklab,var(--rk-pass) 70%,var(--rk-ink))}.roko-t-com{color:var(--rk-ink-3);font-style:italic}
.roko-hunk-head{display:flex;gap:10px;min-width:max-content;padding:2px 10px 2px 102px;border-block:var(--rk-hair,1px) solid var(--rk-stroke-soft);background:var(--rk-sunk);color:var(--rk-ink-3);font-size:11px}
.roko-hunk-head:first-child{border-top:0}
.roko-hunk-range{color:var(--rk-live)}
.roko-diff-note{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;font-family:var(--font-sans,inherit);font-size:12px;color:var(--rk-ink-3)}
.roko-merge-btn .roko-merge-mode{margin-left:2px;padding-left:7px;border-left:var(--rk-hair,1px) solid color-mix(in oklab,currentColor 35%,transparent);font-weight:400;opacity:.8}
.roko-merge-state{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600}
.roko-merge-state[data-tone=good]{color:var(--rk-pass)}
.roko-merge-blocked{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.roko-merge-why{display:inline-flex;align-items:center;gap:5px;max-width:420px;padding:3px 8px;border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-ink) 6%,transparent);color:var(--rk-ink-2);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-merge-confirm{display:flex;flex-direction:column;gap:5px}
.roko-merge-line{display:block}
.roko-merged{display:inline-flex;align-items:center;gap:9px;flex-wrap:wrap;padding:5px 6px 5px 10px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-pass) 40%,transparent);border-left:3px solid var(--rk-pass);background:color-mix(in oklab,var(--rk-pass) 8%,transparent);font-size:12px}
.roko-merged-check{display:inline-flex}
.roko-merged-check circle{fill:none;stroke:var(--rk-pass);stroke-width:1.6;stroke-dasharray:51;stroke-dashoffset:51;animation:roko-draw .5s var(--rk-ease) forwards}
.roko-merged-check path{fill:none;stroke:var(--rk-pass);stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:14;stroke-dashoffset:14;animation:roko-draw .35s .35s var(--rk-ease) forwards}
.roko-merged-text b{font-weight:650}
.roko-delivered{display:flex;flex-direction:column;gap:8px;min-width:0}
.roko-delivered-line{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--rk-ink-2)}
.roko-delivered-stat{font-family:var(--rk-mono);font-size:11.5px;color:var(--rk-ink-2);font-variant-numeric:tabular-nums}
.roko-files{display:flex;flex-wrap:wrap;gap:4px}

/* -- waiting: a decision with two keys ------------------------------------------ */
.roko-pending{position:relative;gap:10px;padding-left:18px;overflow:hidden;border-color:color-mix(in oklab,var(--rk-you) 35%,var(--rk-stroke))}
.roko-pending::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--rk-you)}
.roko-pending[data-decided=true]{opacity:.8;border-color:var(--rk-stroke)}.roko-pending[data-decided=true]::before{background:var(--rk-pass)}
.roko-pending-head{display:flex;align-items:center;gap:8px;min-width:0}

.roko-pending-title{flex:1;min-width:0;font-size:12px;color:var(--rk-ink-3);overflow-wrap:anywhere}
.roko-question{font-size:16px;font-weight:650;line-height:1.4;letter-spacing:-.01em;overflow-wrap:anywhere}
.roko-pending[data-compact=true] .roko-question{font-size:14px}
.roko-effect{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
.roko-effect-call{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-you) 40%,transparent)}
.roko-args{display:inline-flex;flex-wrap:wrap;gap:4px}
.roko-doc{overflow:clip;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-sunk)}
.roko-doc-tab{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-right:var(--rk-hair,1px) solid var(--rk-stroke-soft);border-bottom:var(--rk-hair,1px) solid var(--rk-stroke-soft);background:var(--rk-module);font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-2)}
.roko-doc-body{padding:9px 12px}
.roko-pending-meta{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:11.5px;color:var(--rk-ink-3)}
.roko-pending-meta>span{display:inline-flex;align-items:center;gap:4px}
.roko-countdown{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.roko-countdown[data-tone=warn]{color:var(--rk-you-text)}.roko-countdown[data-tone=bad]{color:var(--rk-fail)}
.rk-deadline-text,.rk-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
/* spec v3 §8: under prefers-contrast: more, content never uses the dim ramp, and hairlines become 1.5 px */
@media (prefers-contrast:more){.roko{--ph-dim:var(--ph-ink);--ph-label:var(--ph-ink);--rk-ink-3:var(--rk-ink-2);--rk-ink-4:var(--rk-ink-2);--ph-rule:#3d3646;--ph-rule-2:#5d5566}:root{--rk-hair:1.5px}}
.roko-decide{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.roko-note{flex:1;min-width:180px}
.rk-decide-key{min-width:104px}
.roko-result{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--rk-ink-2)}
.roko-result[data-tone=good]{color:var(--rk-pass)}.roko-result[data-tone=bad]{color:var(--rk-fail)}
.roko-result-hint{color:var(--rk-ink-3)}
.roko-clamp{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0}
.roko-clamp-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55;color:var(--rk-ink-2)}
.roko-clamp-text.roko-mono{font-size:11.5px}
.roko-clamp-text[data-open=false]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--roko-lines,4);overflow:hidden}
.roko-link{padding:0;border:0;background:none;color:var(--rk-ink-3);font:inherit;font-size:11.5px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.roko-link:hover{color:var(--rk-ink)}
.roko-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}
.roko-actions-start{justify-content:flex-start}

/* -- plans --------------------------------------------------------------------- */
.roko-waves{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(150px,240px);gap:8px;overflow-x:auto;padding-bottom:2px}
.roko-wave{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px dashed var(--rk-stroke);border-radius:var(--rk-radius-m)}
.roko-wave-head{font-family:var(--rk-mono);font-size:10px;font-weight:650;letter-spacing:.14em;color:var(--rk-ink-4)}
.roko-taskchip{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid var(--rk-stroke);background:var(--rk-module);font-size:12px;box-shadow:0 1px 0 0 var(--rk-stroke)}
.roko-taskchip-head{display:flex;gap:6px;align-items:baseline;min-width:0}.roko-taskchip-head>.roko-mono{flex:none;white-space:nowrap}
.roko-taskchip-title{min-width:0;overflow-wrap:anywhere}
/* -- the New run device -------------------------------------------------------- */
.roko-form{display:flex;flex-direction:column;gap:12px;padding:4px 0}
.roko-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;color:var(--rk-ink-2)}
.roko-field>label,.rk-field-label{font-weight:600;font-size:12px;color:var(--rk-ink)}
.roko-field-row{flex-direction:row;align-items:center;gap:10px}

.roko-capchips{display:flex;flex-wrap:wrap;gap:5px}
.roko-capchip{height:24px;padding:0 9px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid var(--rk-stroke-2);background:transparent;color:var(--rk-ink-2);font-family:var(--rk-mono);font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer;box-shadow:0 1px 0 0 var(--rk-stroke-2);transition:background-color .14s,border-color .14s}
.roko-capchip:hover:not(:disabled){color:var(--rk-ink)}
.roko-capchip[aria-pressed=true]{border-color:var(--rk-you);color:var(--rk-ink);box-shadow:inset 3px 0 0 var(--rk-you)}
.roko-capchip:disabled{opacity:.36;cursor:default}
.roko.roko-composer{max-width:min(640px,94vw);width:100%;max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;overflow:hidden}
.roko-composer>.rk-composer-body{display:grid;gap:12px;flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.roko.roko-composer{background:var(--rk-module);border-color:var(--rk-stroke-2)}
.rk-composer-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px 18px}
.rk-composer-in{font-size:12.5px;color:var(--rk-ink-3)}.rk-composer-in b{font-weight:600;color:var(--rk-ink)}
.rk-composer-mode{display:inline-flex;align-items:center;gap:8px;font-size:13px;color:var(--rk-ink-2);cursor:pointer}
.rk-capset{display:inline-flex;align-items:center;overflow:hidden;border-radius:var(--rk-radius);box-shadow:inset 0 0 0 1px var(--rk-stroke-2)}
.rk-capset-label{padding:0 10px;font:500 11px/1 var(--rk-mono);color:var(--rk-ink-3)}
.rk-capset-key{height:30px;padding:0 11px;border:0;border-left:var(--rk-hair,1px) solid var(--rk-stroke-2);background:transparent;font:600 12px/1 var(--rk-mono);color:var(--rk-ink-2);cursor:pointer}
.rk-capset-key:hover{background:var(--rk-hover)}.rk-capset-key[aria-pressed=true]{background:var(--rk-ink);color:var(--rk-module)}.rk-capset-key:focus-visible{outline:2px solid var(--rk-you);outline-offset:-2px}
.rk-composer-note{margin:0;font-size:12.5px;line-height:1.5;color:var(--rk-ink-3)}
.rk-composer-count{justify-self:end;margin-top:-6px;font:11px/1 var(--rk-mono);color:var(--rk-ink-3)}
.rk-composer-more-body{display:grid;gap:14px;padding-top:10px}.rk-composer-field{display:grid;gap:6px}
.rk-composer-foot{display:flex;flex:none;justify-content:flex-end;align-items:center;gap:10px}
.roko-composer>[data-slot=dialog-header]{flex:none}
.roko-composer [data-slot=dialog-title]{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:-.01em}
.rk-spec{display:flex;align-items:center;gap:7px;margin-bottom:8px;padding:6px 6px 6px 10px;border-radius:var(--rk-radius-m);background:var(--rk-module);box-shadow:inset 0 0 0 1px var(--rk-stroke);font-size:12px;color:var(--rk-ink-2)}.rk-spec>span{flex:1;min-width:0;overflow-wrap:anywhere}.rk-spec code{font:600 11.5px/1.4 var(--rk-mono);color:var(--rk-ink)}
.rk-keyrow{display:flex;flex-wrap:wrap;gap:6px}
.rk-start{min-width:180px}
.rk-slide{display:inline-flex;align-items:center;gap:9px}
.rk-slide-label{padding:2px 0;border:0;background:none;color:var(--rk-ink-3);font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;transition:color .14s}
.rk-slide-label[aria-pressed=true]{color:var(--rk-ink)}
.rk-slide-label:focus-visible{outline:2px solid var(--rk-you);outline-offset:3px;border-radius:2px}
.rk-slide-track{position:relative;display:inline-block;width:44px;height:22px;border-radius:var(--rk-radius);background:var(--rk-well);box-shadow:inset 0 0 0 1px black,inset 0 2px 3px black;cursor:pointer}
.rk-slide-thumb{position:absolute;top:2px;left:2px;width:20px;height:18px;border-radius:1px;background:linear-gradient(180deg,color-mix(in oklab,white 82%,var(--rk-ink)),color-mix(in oklab,white 60%,var(--rk-ink)));box-shadow:0 1px 0 black;transition:left .14s var(--rk-ease)}
.rk-slide-thumb::after{content:"";position:absolute;left:50%;top:5px;bottom:5px;width:2px;margin-left:-1px;background:var(--rk-you)}
.rk-slide[data-pos="1"] .rk-slide-thumb{left:22px}
.roko-prompt{min-height:128px;font-size:13px;line-height:1.55;resize:vertical}

.roko-examples-label{font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-4)}
.roko-examples{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.roko-example{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid var(--rk-stroke-2);background:var(--rk-module);color:var(--rk-ink-2);font:inherit;font-size:11.5px;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);transition:background-color .14s,color .14s,transform 80ms,box-shadow 80ms}
.roko-example:hover{color:var(--rk-ink);border-color:var(--rk-ink-3)}
.roko-example:active{transform:translateY(2px);box-shadow:none}
.roko-composer-limits{display:flex;flex-wrap:wrap;gap:4px 16px;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}

/* -- onboarding ---------------------------------------------------------------- */
.roko-onboard{display:flex;flex-direction:column;align-items:center;gap:12px;width:100%;max-width:680px;margin:20px auto;padding:28px 28px 24px;text-align:center;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid var(--rk-stroke);background:var(--rk-module)}
.rk-onboard-well{padding:14px 20px;gap:18px}
.roko-onboard-title{margin:6px 0 0;font-size:21px;font-weight:700;letter-spacing:-.025em;text-wrap:balance}
.roko-onboard-text{margin:0;max-width:56ch;font-size:13px;line-height:1.6;color:var(--rk-ink-2)}
.roko-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;width:100%;margin:8px 0 2px;padding:0;list-style:none}
.roko-steps li{display:flex;flex-direction:column;gap:7px;padding:11px 12px;border-radius:var(--rk-radius);background:var(--rk-sunk);border:var(--rk-hair,1px) solid var(--rk-stroke);font-size:12px;line-height:1.5;color:var(--rk-ink-2);text-align:left}
.roko-onboard-actions{display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:6px}
.roko-onboard-actions .roko-examples{justify-content:center}

/* -- loops ------------------------------------------------------------------- */
.rk-loops{display:flex;flex-direction:column;gap:12px;min-width:0}
/* -- insights, knowledge, banners, empties -------------------------------------- */
.roko-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}
.roko-kpi{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid var(--rk-stroke);background:var(--rk-module)}
.roko-kpi-label{font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-3)}
.roko-kpi-value{font-family:var(--rk-mono);font-size:24px;font-weight:600;letter-spacing:-.03em;color:var(--rk-ink);font-variant-numeric:tabular-nums}
.roko-kpi[data-tone=good] .roko-kpi-value{color:var(--rk-pass)}.roko-kpi[data-tone=warn] .roko-kpi-value{color:var(--rk-you-text)}.roko-kpi[data-tone=bad] .roko-kpi-value{color:var(--rk-fail)}
.roko-kpi-sub{font-size:11.5px;color:var(--rk-ink-3)}
.roko-chart-card{padding:10px 12px}
.roko-chart{position:relative;padding:8px 8px 22px 42px}
.roko-spark{display:block;width:100%;height:150px;color:var(--rk-live);overflow:visible}
.roko-spark-line{stroke:currentColor;stroke-width:1.8;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.roko-spark-area{fill:currentColor;opacity:.1}
.roko-chart-grid{stroke:var(--rk-stroke-soft);stroke-width:1;vector-effect:non-scaling-stroke}
.roko-chart-cursor{stroke:var(--rk-you);stroke-dasharray:3 3;stroke-width:1;vector-effect:non-scaling-stroke}
.roko-chart-y{position:absolute;left:0;width:36px;text-align:right;font-family:var(--rk-mono);font-size:10px;color:var(--rk-ink-4);font-variant-numeric:tabular-nums}
.roko-chart-ymax{top:6px}.roko-chart-y0{bottom:20px}
.roko-chart-x{position:absolute;bottom:2px;font-family:var(--rk-mono);font-size:10px;color:var(--rk-ink-4)}
.roko-chart-x0{left:42px}.roko-chart-x1{right:8px}
.roko-chart-tip{position:absolute;z-index:2;transform:translate(-50%,-135%);padding:3px 8px;border-radius:var(--rk-radius);border:var(--rk-hair,1px) solid var(--rk-stroke-2);background:var(--ui-bg-elevated);font-family:var(--rk-mono);font-size:11px;white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums}
.roko-checks,.roko-table{gap:0;padding:4px 14px}
.roko-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));column-gap:22px}
.roko-checks .roko-check:nth-child(2){border-top:0}
.roko-check{display:grid;grid-template-columns:16px minmax(0,1fr);gap:9px;padding:9px 0;border-top:var(--rk-hair,1px) solid var(--rk-stroke-soft)}
.roko-check:first-child,.roko-table-row:first-child{border-top:0}
.roko-check-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.roko-check-hint{font-size:12px;color:var(--rk-you-text)}
.roko-table-row{display:grid;grid-template-columns:minmax(120px,1.3fr) minmax(60px,1fr) 46px 70px 70px;gap:10px;align-items:center;padding:7px 0;border-top:var(--rk-hair,1px) solid var(--rk-stroke-soft);font-size:12px}
.roko-table-head{font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-4)}
.roko-cell-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-cell-num{text-align:right;font-family:var(--rk-mono);font-size:11.5px;font-variant-numeric:tabular-nums}
.roko-bar{display:block;height:8px;overflow:hidden;background:color-mix(in oklab,var(--rk-ink) 9%,transparent);-webkit-mask:repeating-linear-gradient(90deg,black 0 4px,transparent 4px 5px);mask:repeating-linear-gradient(90deg,black 0 4px,transparent 4px 5px)}
.roko-bar-fill{display:block;height:100%;background:var(--rk-ink-3);transition:width .6s var(--rk-ease)}
.roko-bar[data-tone=good] .roko-bar-fill{background:var(--rk-pass)}.roko-bar[data-tone=warn] .roko-bar-fill{background:var(--rk-you)}.roko-bar[data-tone=bad] .roko-bar-fill{background:var(--rk-fail);min-width:4px}
.roko-confidence{display:inline-flex;align-items:center;gap:6px}
.roko-confidence .roko-bar{width:44px}
.roko-search{width:100%;height:34px}
.roko-knowledge{gap:7px}
.roko-knowledge-head{display:flex;align-items:center;gap:6px}
.roko-banner{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-you) 45%,transparent);border-left:3px solid var(--rk-you);background:color-mix(in oklab,var(--rk-you) 6%,transparent);font-size:12.5px;color:var(--rk-ink-2)}
.roko-banner[data-tone=bad]{border-color:color-mix(in oklab,var(--rk-fail) 40%,transparent);border-left-color:var(--rk-fail);background:color-mix(in oklab,var(--rk-fail) 6%,transparent)}
.roko-banner-icon{margin-top:1px;color:var(--rk-you-text)}.roko-banner[data-tone=bad] .roko-banner-icon{color:var(--rk-fail)}
.roko-banner-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.roko-banner-title{font-weight:650;color:var(--rk-ink)}
.roko-error{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:var(--rk-radius-m);border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-fail) 35%,transparent);border-left:3px solid var(--rk-fail);background:color-mix(in oklab,var(--rk-fail) 5%,transparent);font-size:12px}
.roko-error[data-compact=true]{padding:7px 10px}
.roko-error-icon{margin-top:1px;color:var(--rk-fail)}
.roko-error-body{display:flex;flex:1;flex-direction:column;gap:2px;min-width:0}
.roko-error-title{font-weight:650;color:var(--rk-ink)}
.roko-error-text{color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-error-hint{color:var(--rk-ink-3)}
.roko-pre{margin:0;max-height:320px;overflow:auto;padding:10px 12px;border-radius:var(--rk-radius);background:var(--rk-well);box-shadow:inset 0 0 0 1px black;color:var(--rk-px-on);font-family:var(--rk-mono);font-size:11.5px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}
.roko-empty{display:flex;flex-direction:column;align-items:center;gap:7px;padding:36px 16px;text-align:center}
.roko-empty-icon{display:inline-grid;place-items:center;width:38px;height:38px;border-radius:var(--rk-radius-m);background:var(--rk-well);color:var(--rk-px-dim);box-shadow:inset 0 0 0 1px black}
.roko-empty-title{font-weight:650;color:var(--rk-ink-2)}
.roko-empty-text{max-width:420px;font-size:12px;line-height:1.55;color:var(--rk-ink-3)}
.roko-empty-cmd{display:flex;justify-content:center;margin-top:8px}
.roko-loading{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--rk-ink-3)}
.roko-spinner{width:12px}
.roko-skel{border-radius:var(--rk-radius)}
.roko-plangen-live{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px;border-radius:var(--rk-radius-m);border:1px dashed var(--rk-stroke);background:var(--rk-sunk)}
.roko-plangen-words{display:grid;gap:4px;flex:1 1 240px;min-width:0}
.roko-plangen-stage{font-family:var(--rk-mono);font-size:12px;color:var(--rk-ink);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.rk-plangen-well{padding:10px 14px;gap:14px}

/* -- chat cards, chip, monitor, delegate, composer key, settings ------------------ */
.roko-statuschip{display:inline-flex;align-items:center;gap:6px;height:100%;padding:0 8px;border:0;border-radius:0;background:transparent;color:var(--rk-ink-3);font:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer}
.rk-chip-mark{display:inline-flex;align-items:center;height:16px;padding:0 5px;border-radius:2px;background:var(--ph-void);box-shadow:inset 0 0 0 1px var(--ph-black)}
.rk-chip-glass{display:inline-flex;align-items:center;gap:5px;height:16px;padding:0 6px;border-radius:2px;background:var(--ph-void);box-shadow:inset 0 0 0 1px var(--ph-black);color:var(--ph-dim)}
.rk-chip-glass .rk-chip-word{font:600 9px/1 var(--rk-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ph-dim)}
.rk-chip-led{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;background:transparent;box-shadow:inset 0 0 0 1.5px var(--rk-ink-3)}
.rk-chip-led[data-state=live]{background:var(--ph-live);box-shadow:0 0 6px var(--ph-live);animation:rk-blink 1.2s steps(1,end) infinite}
.rk-chip-led[data-state=you]{background:var(--ph-you);box-shadow:0 0 6px var(--ph-you);animation:rk-blink .6s steps(1,end) infinite}
.rk-chip-led[data-state=fail]{background:var(--rk-fail);box-shadow:none}
.roko-statuschip:hover{background:var(--chrome-action-hover);color:var(--rk-ink)}
.rk-chip-word{font-weight:700;letter-spacing:-.01em}
.roko-directive{display:flex;flex-direction:column;gap:6px;margin:6px 0;max-width:680px}
.roko-directive-raw{font-family:var(--rk-mono)}
.roko-cc-why{font-size:12px;line-height:1.5;color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-monitor{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;overflow:auto;padding:12px;background:var(--rk-body);color:var(--rk-ink);font-size:12.5px}
.rk-monitor-head{display:flex;align-items:center;gap:7px}
.rk-monitor-run,.rk-monitor-idle{display:flex;flex-direction:column;gap:9px;min-width:0}
.rk-monitor-idle{align-items:stretch}
.rk-monitor-last{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 9px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.roko-delegate{display:flex;align-items:center;gap:16px;flex-wrap:wrap;width:min(560px,92%);margin:0 auto;padding:14px 16px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module);color:var(--rk-ink);animation:roko-rise .3s var(--rk-ease)}

.rk-delegate-body{display:flex;flex:1;flex-direction:column;gap:8px;min-width:220px}
.rk-delegate-text{margin:0;font-size:12.5px;line-height:1.5;color:var(--rk-ink-2)}
.rk-composerkey{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:var(--rk-hair,1px) solid var(--rk-stroke-2);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink-2);font:inherit;font-size:11.5px;font-weight:700;letter-spacing:-.01em;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);transition:transform 80ms,box-shadow 80ms,color .14s}
.rk-composerkey span{color:var(--rk-you-text);font-weight:800}
.rk-composerkey:hover{color:var(--rk-ink)}
.rk-composerkey:active{transform:translateY(2px);box-shadow:none}
.rk-sessionled{display:inline-grid;place-items:center;width:12px;height:12px}
.roko-settings{display:flex;flex-direction:column;gap:12px;max-width:760px;color:var(--rk-ink);font-size:13px}
.rk-set-head{display:flex;align-items:center;gap:16px}
.rk-set-well{padding:12px 16px}
.rk-set-title{margin:0 0 3px;font-size:18px;font-weight:750;letter-spacing:-.025em}
.rk-set-row{display:grid;grid-template-columns:150px minmax(0,1fr);gap:12px;align-items:center;padding:4px 0;font-size:12.5px}
.rk-set-key{font-family:var(--rk-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--rk-ink-3)}
.rk-set-value{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0;overflow-wrap:anywhere}
.rk-set-theme{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--rk-ink-2)}
.rk-swatches{display:inline-flex;gap:0;overflow:hidden;border-radius:var(--rk-radius);box-shadow:inset 0 0 0 1px var(--rk-stroke-2)}
.rk-swatches i{display:block;width:22px;height:22px}
.rk-swatches [data-swatch=alu]{background:var(--ph-swatch-alu)}.rk-swatches [data-swatch=graphite]{background:var(--ph-swatch-graphite)}.rk-swatches [data-swatch=live]{background:var(--ph-live)}.rk-swatches [data-swatch=orange]{background:var(--ph-you)}

@keyframes roko-spin{to{transform:rotate(360deg)}}
@keyframes roko-flow{to{stroke-dashoffset:-14}}
@keyframes roko-pulse{0%,100%{opacity:1}50%{opacity:.42}}
@keyframes roko-rise{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes roko-draw{to{stroke-dashoffset:0}}
@keyframes rk-blink{0%,55%{opacity:1}56%,100%{opacity:.28}}
@keyframes rk-roll{from{transform:translateY(-4px);opacity:.1}to{transform:none;opacity:1}}
@keyframes rk-tick-in{from{transform:translateX(14px);opacity:0}to{transform:none;opacity:1}}
@keyframes rk-cursor{0%,55%{opacity:1}56%,100%{opacity:0}}
@keyframes rk-sweep-x{from{left:0;opacity:1}to{left:100%;opacity:0}}
@keyframes rk-stamp-hold{0%{opacity:0;transform:translate(-50%,-4px)}12%{opacity:1;transform:translate(-50%,0)}80%{opacity:1}100%{opacity:0}}
@keyframes rk-print{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
@keyframes rk-climb{from{transform:translateY(calc(-50% + var(--rk-dy,40px)))}to{transform:translateY(-50%)}}
@keyframes rk-echo{0%{opacity:.55;transform:translateY(calc(-50% + var(--rk-dy,40px)))}100%{opacity:0;transform:translateY(calc(-50% + var(--rk-dy,40px) / 3))}}
@keyframes rk-failover{from{opacity:.4;transform:translate(-14px,-50%)}to{opacity:1;transform:translateY(-50%)}}
@keyframes rk-sweep{to{transform:rotate(360deg)}}
@keyframes rk-tick-flash{0%{stroke-width:5;opacity:1}100%{stroke-width:2.4}}
@keyframes rk-scan{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes rk-pad-flash{0%{background-color:color-mix(in oklab,var(--rk-node) 34%,var(--rk-module))}100%{background-color:var(--rk-module)}}
@keyframes rk-slide{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
/* -- setup and updates: the restart banner, the setup module, each problem's fix ------------- */
.rk-setup-area{display:flex;flex-direction:column;gap:10px}
.rk-restart{display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-you) 45%,var(--rk-stroke));border-left:3px solid var(--rk-you);border-radius:var(--rk-radius-m);background:color-mix(in oklab,var(--rk-you) 5%,var(--rk-module))}
.rk-restart[data-compact=true]{flex-direction:column;gap:8px;padding:9px 10px}
.rk-restart-well{flex:none;gap:8px;padding:7px 10px}
.rk-restart-body{display:flex;flex:1;flex-direction:column;gap:6px;min-width:0}
.rk-restart-title{font-weight:650;color:var(--rk-ink)}
.rk-restart-why{font-size:11.5px;color:var(--rk-ink-3)}
.rk-fix-steps{margin:0;padding-left:20px;list-style:decimal;font-size:12.5px;line-height:1.55;color:var(--rk-ink-2)}
.rk-fix-steps li::marker{font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-3)}
.rk-steps li::marker{font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3)}
.rk-fix-restart{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 12px}
.rk-setup{gap:4px}
.rk-setup[data-blocking=true]{border-color:color-mix(in oklab,var(--rk-fail) 40%,var(--rk-stroke))}
.rk-problems{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.rk-problem{display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-top:var(--rk-hair,1px) solid var(--rk-stroke-soft)}
.rk-problems>.rk-problem:first-child{padding-top:4px;border-top:0}
.rk-problem>.rk-led{margin-top:5px}
.rk-problem-n{flex:none;width:16px;margin-top:2px;font-family:var(--rk-mono);font-size:10px;font-weight:600;color:var(--rk-ink-4);font-variant-numeric:tabular-nums}
.rk-problem-main{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
.rk-problem-title{font-weight:650;color:var(--rk-ink)}
.rk-problem-detail{font-size:12px;color:var(--rk-ink-2)}
.rk-problem-fix{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:2px;min-width:0;max-width:100%}
.rk-problem-card{display:flex;flex-direction:column;gap:2px;padding:8px 11px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-left:3px solid var(--rk-you);border-radius:var(--rk-radius-m);background:var(--rk-module)}
.rk-problem-card[data-severity=block]{border-left-color:var(--rk-fail)}
.rk-problem-lead{font-size:11.5px;color:var(--rk-ink-3)}
.rk-blocked{flex-basis:100%;min-width:0}
.rk-fix-command{display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:100%}
.rk-fix-cmd{max-width:100%;overflow-x:auto;padding:3px 7px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-sunk);color:var(--rk-ink);font-family:var(--rk-mono);font-size:11.5px;white-space:pre}
.rk-fix-panel{display:flex;flex-direction:column;gap:7px;width:100%;min-width:0}
.rk-fix-title{font-size:12.5px;font-weight:600;color:var(--rk-ink)}
.rk-fix-path{font-size:11.5px;color:var(--rk-ink-3)}
.rk-fix-summary{font-size:12px;color:var(--rk-ink-2)}
.rk-fix-variants{flex-wrap:wrap}
.rk-fix-variants .rk-tag{margin-left:2px}
.rk-fix-preview{max-height:260px}
.rk-fix-preview span[data-line=add]{color:var(--rk-px-pass)}.rk-fix-preview span[data-line=del]{color:var(--rk-px-fail)}
.rk-fix-preview span[data-line=hunk],.rk-fix-preview span[data-line=file]{color:var(--rk-px-dim)}
.rk-fix-done{display:flex;flex-wrap:wrap;align-items:center;gap:8px;font-size:12.5px;color:var(--rk-ink)}
.rk-fix-next{color:var(--rk-ink-2)}
.rk-scope{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.rk-scope-line{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--rk-ink-2)}
.rk-last-known{padding:8px 12px;border:1px dashed var(--rk-stroke-2);border-radius:var(--rk-radius);font-size:12.5px;color:var(--rk-ink-2)}
.roko-run[data-state=last_seen] *,.rk-monitor-run[data-state=last_seen] *{animation:none!important}
.rk-theme-offer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-sunk);font-size:12.5px;color:var(--rk-ink-2)}
.rk-theme-offer-text{flex:1;min-width:200px}

.rk-composer-plans{display:flex;flex-direction:column;gap:8px}
.rk-planpick{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto}
.rk-planpick-head{padding:2px 2px;font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-4)}
.rk-planpick-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:var(--rk-hair,1px) solid var(--rk-stroke-soft);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.rk-planpick-item[data-on=true]{border-color:color-mix(in oklab,var(--rk-you) 55%,var(--rk-stroke))}
.rk-planpick-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-planpick-id{flex:0 1 auto;max-width:40%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.rk-planpick-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px}
.rk-check{display:inline-flex;align-items:center;gap:6px;color:var(--rk-ink-2);cursor:pointer}

.rk-cand-bar[data-empty=true]{visibility:hidden}
.rk-cands-more{margin-top:4px}
.rk-route-by{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0}
.rk-cands-toggle{padding:2px 0;border:0;background:none;color:var(--rk-ink-3);font:inherit;font-size:11.5px;cursor:pointer;text-decoration:underline dotted}
.rk-cands-toggle:hover{color:var(--rk-ink-2)}
.rk-unverified{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-you) 45%,var(--rk-stroke));border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-you) 7%,transparent);font-size:12.5px;line-height:1.5;color:var(--rk-ink)}
.rk-unverified b{color:var(--rk-you-text)}
.rk-work-parts{flex-wrap:wrap;gap:6px;margin-bottom:8px}
.rk-merge-fix{display:inline-flex;align-items:center;gap:6px;margin-left:8px}
.rk-merge-confirm-why{color:var(--rk-you-text);font-weight:600}
.rk-fix-done-text{display:flex;flex-direction:column;gap:4px;min-width:0;overflow-wrap:anywhere}
.rk-fix-done-note[data-ready=false]{border-color:color-mix(in oklab,var(--rk-you) 45%,var(--rk-stroke));background:color-mix(in oklab,var(--rk-you) 6%,transparent)}
.rk-fix-done-note{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:10px;padding:10px 12px;border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-pass) 45%,var(--rk-stroke));border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-pass) 6%,transparent)}
.rk-fix-next b{margin-right:2px;font-family:var(--rk-mono);font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-you-text)}
.rk-fix-note,.rk-fix-docs{font-size:12px;color:var(--rk-ink-2)}
.rk-fix-docs{color:var(--rk-ink-3)}
.rk-setupstrip{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 9px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-left:3px solid var(--rk-you);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.rk-setupstrip[data-severity=block]{border-left-color:var(--rk-fail)}
.rk-setupstrip:hover{background:color-mix(in oklab,var(--rk-module) 90%,var(--rk-ink))}
.rk-setupstrip-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-setupstrip-more{font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3)}
.roko-statuschip .rk-tag{height:14px;padding:0 4px;font-size:9px}
/* -- 0.7: the serve banner (its border says its state: rose starting, red failed, orange for the person, dashed stopped), the project switch and pick list -- */
.rk-serve{--rk-ch:var(--rk-stroke-2);display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:var(--rk-hair,1px) solid color-mix(in oklab,var(--rk-ch) 45%,var(--rk-stroke));border-left:3px solid var(--rk-ch);border-radius:var(--rk-radius-m);background:color-mix(in oklab,var(--rk-ch) 5%,var(--rk-module))}
.rk-serve[data-state=starting]{--rk-ch:var(--rk-live)}.rk-serve[data-state=pick]{--rk-ch:var(--rk-you)}.rk-serve[data-state=failed]{--rk-ch:var(--rk-fail)}.rk-serve[data-state=outdated],.rk-serve[data-state=not_found]{--rk-ch:var(--rk-you)}.rk-serve[data-state=stopped]{border-left-style:dashed}
.rk-serve[data-compact=true]{flex-direction:column;gap:8px;padding:9px 10px}
.rk-serve-well{flex:none;gap:8px;padding:7px 10px}
.rk-serve-body{display:flex;flex:1;flex-direction:column;align-items:flex-start;gap:6px;min-width:0;max-width:100%}
.rk-serve-title{font-weight:650;color:var(--rk-ink)}
.rk-serve-line{font-size:12px;color:var(--rk-ink-2);overflow-wrap:anywhere}.rk-serve-line .roko-stepclock{font-family:var(--rk-mono);color:var(--rk-live)}
.rk-serve-hint{font-size:11.5px;color:var(--rk-ink-3);overflow-wrap:anywhere}
.rk-serve-error{font-size:12px;color:var(--rk-fail)}
.rk-serve-log{align-self:stretch;margin:0;max-height:220px;overflow:auto;padding:10px 12px;font-family:var(--rk-mono);font-size:11px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ph-ink)}
.rk-serve-runs{display:flex;flex-direction:column;gap:4px;margin:8px 0 0;padding:0;list-style:none;font-size:12.5px}.rk-serve-runs li{display:flex;align-items:center;gap:8px}
.rk-dots[data-sweep=true] .rk-dots-on{animation:rk-scan 1.4s ease-in-out infinite;animation-delay:calc(var(--rk-i,0) * 120ms)}
.rk-projkey{display:inline-flex;align-items:center;gap:6px;max-width:220px;height:24px;padding:0 8px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink-2);font:inherit;font-size:12px;font-weight:600;cursor:pointer}
.rk-projkey:hover{border-color:var(--rk-stroke-2);color:var(--rk-ink)}
.rk-projkey-name,.rk-proj-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-projmenu{display:flex;flex-direction:column;align-items:flex-start;gap:8px;width:300px;max-width:calc(100vw - 32px)}
.rk-projlist{display:flex;flex-wrap:wrap;gap:6px;min-width:0}
.rk-projmenu .rk-projlist{flex-direction:column;flex-wrap:nowrap;align-self:stretch;max-height:260px;overflow:auto}
.rk-proj{display:flex;align-items:center;gap:8px;min-width:0;max-width:100%;padding:5px 9px;border:var(--rk-hair,1px) solid var(--rk-stroke-soft);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.rk-proj:hover{background:color-mix(in oklab,var(--rk-module) 92%,var(--rk-ink))}
.rk-proj[data-on=true]{border-color:color-mix(in oklab,var(--rk-you) 60%,var(--rk-stroke))}
.rk-proj-name{flex:1}
.rk-projkey:focus-visible,.rk-proj:focus-visible{outline:2px solid var(--rk-you);outline-offset:1px}
.rk-runproj{display:inline-flex;align-items:center;gap:3px;color:var(--rk-ink-2)}
.rk-setup-line{display:flex;align-items:center;gap:10px;width:100%;min-width:0;margin:0;padding:7px 12px;border:var(--rk-hair,1px) solid var(--rk-stroke-soft);border-radius:var(--rk-radius-m);background:transparent;color:var(--rk-ink-2);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}.rk-setup-line:hover{border-color:var(--rk-stroke-2);color:var(--rk-ink)}.rk-setup-line-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-build{display:grid;gap:14px}
.rk-build-title h2{margin:0;font-weight:800;font-size:34px;line-height:1.05;letter-spacing:-.01em;color:var(--rk-ink)}
.rk-build-title p{margin:8px 0 0;max-width:720px;font-size:13.5px;line-height:1.45;color:var(--rk-ink-2)}
.rk-build-note{margin:6px 0 0;font:11px/1.4 var(--rk-mono);color:var(--rk-you-text)}
.rk-build-cells{display:flex;flex-wrap:wrap;gap:12px 28px}
.rk-build-cell{display:flex;flex-direction:column;gap:6px}.rk-build-cell i{font:500 9.5px/1 var(--rk-mono);font-style:normal;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-3)}.rk-build-cell span{display:flex;align-items:center;gap:8px}.rk-build-cell small{font:500 10.5px var(--rk-mono);color:var(--rk-ink-3)}
.rk-build-receipt{margin:0;font:12px/1.45 var(--rk-mono);color:var(--rk-ink)}.rk-build-basis{margin:6px 0 0;font:10.5px/1.45 var(--rk-mono);color:var(--rk-ink-3)}.rk-build-incl{margin:0 0 6px;font:11px/1.4 var(--rk-mono);color:var(--rk-ink-2)}
.rk-reel{display:flex;gap:12px;overflow-x:auto}.rk-reel figure{display:grid;gap:4px;margin:0;flex:0 0 max(31%,200px)}
.rk-song{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px}
.rk-phase{position:relative;display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0;padding:12px 13px 11px;border:var(--rk-hair,1px) solid var(--rk-stroke-2);border-radius:var(--rk-radius-m);background:var(--rk-module);color:var(--rk-ink);font:inherit;text-align:left;box-shadow:0 2px 0 0 var(--rk-stroke)}
button.rk-phase{cursor:pointer}button.rk-phase:hover{background:var(--rk-module-2)}button.rk-phase:active{transform:translateY(2px);box-shadow:none}button.rk-phase:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.rk-phase[data-state=specified]{border-style:dashed;background:transparent;box-shadow:none}.rk-phase[data-next=true]{border-color:var(--rk-you);box-shadow:0 0 0 1px color-mix(in oklab,var(--rk-you) 35%,transparent)}
.rk-phase[data-state=running],.rk-phase[data-state=writing]{border-color:var(--rk-live)}.rk-phase[data-state=stopped]{border-color:var(--rk-fail)}
.rk-phase-top{display:flex;align-items:center;justify-content:space-between;align-self:stretch;font:700 15px/1 var(--rk-mono)}
.rk-phase-name{max-width:100%;overflow:hidden;font-size:13px;font-weight:600;line-height:1.3;text-overflow:ellipsis;white-space:nowrap}
.rk-phase-word{font:500 10.5px/1 var(--rk-mono);color:var(--rk-ink-3)}
.rk-phase[data-state=passed] .rk-phase-word{display:none}.rk-phase-word[data-tone=live]{color:var(--rk-live)}
.rk-phase-meta{font:10.5px/1.35 var(--rk-mono);color:var(--rk-ink-3)}.rk-phase-cover{font:600 9.5px/1 var(--rk-mono);letter-spacing:.08em;color:var(--rk-pass)}.rk-phase-cover[data-short=true]{color:var(--rk-fail)}.rk-phase-cover span{white-space:nowrap}.rk-phase-cover[data-cross=true]{color:var(--rk-you-text)}
.rk-build-next{display:flex;flex-wrap:wrap;align-items:center;gap:8px 16px;margin:0;padding:14px 18px;border:var(--rk-hair,1px) solid var(--rk-you);border-radius:var(--rk-radius-m);background:color-mix(in oklab,var(--rk-you) 4%,var(--rk-module));font-size:13.5px;line-height:1.45}
.rk-build-next>b{font:700 10.5px/1 var(--rk-mono);letter-spacing:.2em;color:var(--rk-you-text)}.rk-build-next-words{flex:1 1 320px;min-width:0}.rk-build-goal{display:block;margin-top:2px;font-size:12px;color:var(--rk-ink-3)}
/* -- the run card (roko's design system §4.8): a pill, the title, the glass's four readings, one sentence, the keys -- */
.rk-rc{container-type:inline-size;display:grid;gap:10px;padding:12px 14px 8px;border:var(--rk-hair,1px) solid var(--rk-stroke-2);border-radius:var(--rk-radius-l);background:var(--rk-module);box-shadow:inset 0 1px 0 var(--ph-sheen)}
.rk-rc[data-look=you]{border-color:var(--rk-you)}
.roko-pending:not([data-decided=true]){border-color:var(--rk-you)}
.roko-pending-head{display:flex;align-items:center;gap:10px;min-width:0}
.rk-rc-head{display:flex;align-items:center;gap:10px;min-width:0}
.rk-rc-title{flex:1 1 auto;min-width:0;margin:0;padding:0;border:0;background:none;color:var(--rk-ink);font:inherit;font-size:14px;font-weight:650;line-height:1.3;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer}
.rk-rc-title:hover{text-decoration:underline;text-decoration-color:var(--rk-ink-3);text-underline-offset:3px}
.rk-rc-title:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.rk-rc-when{flex:none;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3);white-space:nowrap}
.rk-pill{display:inline-flex;align-items:center;gap:6px;flex:none;height:22px;padding:0 7px;border:var(--rk-hair,1px) solid currentColor;border-radius:2px;color:var(--rk-ink-3);font:600 9.5px/1 var(--rk-mono);letter-spacing:.14em;text-transform:uppercase;white-space:nowrap}
.rk-pill[data-state=live]{color:var(--rk-live)}.rk-pill[data-state=pass]{color:var(--rk-pass)}.rk-pill[data-state=fail]{color:var(--rk-fail)}.rk-pill[data-state=you]{color:var(--rk-you-text)}
.rk-pill-led{width:6px;height:6px;border-radius:50%;background:currentColor}
.rk-pill[data-state=wait] .rk-pill-led{background:transparent;box-shadow:inset 0 0 0 1.5px currentColor}
.rk-pill[data-blink=slow] .rk-pill-led{animation:rk-blink 1.2s steps(1,end) infinite}.rk-pill[data-blink=fast] .rk-pill-led{animation:rk-blink .6s steps(1,end) infinite}
.rk-pill-glyph{letter-spacing:0;font-size:10px}
.rk-well.rk-rc-glass{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));align-items:stretch;gap:0;padding:0}
.rk-rc-cell{display:grid;gap:6px;align-content:start;min-width:0;padding:9px 12px 10px;border-left:1px solid var(--ph-rule)}
.rk-rc-cell:first-child{border-left:0}
.rk-rc-label{font:500 9px/1 var(--rk-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ph-dim)}
.rk-rc-note{font:400 10px/1.2 var(--rk-mono);color:var(--ph-dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rk-rc-cell .rk-meter{height:7px;max-width:132px}
.rk-rc-eta .rk-cnote-2{display:block;margin-top:2px}
.rk-rc-strip{display:flex;flex-wrap:wrap;gap:4px}.rk-rc-strip>span{display:flex;gap:2px}
.rk-rc-strip i{width:7px;height:7px;border-radius:1px;box-shadow:inset 0 0 0 1px var(--ph-rule-2)}
.rk-rc-strip i[data-state=pass]{background:var(--ph-pass);box-shadow:none}.rk-rc-strip i[data-state=fail]{background:var(--ph-fail);box-shadow:none}.rk-rc-strip i[data-state=you]{background:var(--ph-you);box-shadow:none}
.rk-rc-strip i[data-state=live]{background:var(--ph-live);box-shadow:none;animation:rk-blink 1.2s steps(1,end) infinite}
.rk-rc-strip i[data-state=stopped],.rk-rc-strip i[data-state=skipped],.rk-rc-strip i[data-state=blocked]{background:var(--ph-ghost);box-shadow:none}
.rk-pips{display:flex;flex-wrap:wrap;gap:2px}.rk-pips i{width:5px;height:7px;border-radius:1px;background:var(--ph-rule-2)}.rk-pips i[data-state=pass]{background:var(--ph-pass)}.rk-pips i[data-state=fail]{background:var(--ph-fail)}
.rk-rc-line{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px 14px}
.rk-rc-status{flex:1 1 240px;min-width:0;margin:0;color:var(--rk-ink-2);font-size:13px;line-height:1.45}
.rk-rc-status[data-state=live]::before{content:"";display:inline-block;width:6px;height:6px;margin-right:8px;border-radius:50%;background:var(--rk-live);vertical-align:1px;animation:rk-blink 1.2s steps(1,end) infinite}
.rk-rc-status[data-state=you]{color:var(--rk-ink)}
.rk-rc-keys{display:flex;align-items:center;gap:8px;flex:none}
.rk-rc-keys:empty{display:none}
.rk-rc-fold{border-top:var(--rk-hair,1px) solid var(--rk-stroke);padding-top:6px}
.rk-rc-fold>summary{list-style:none;cursor:pointer;padding:2px 0;color:var(--rk-ink-3);font:500 9.5px/1.2 var(--rk-mono);letter-spacing:.12em;text-transform:uppercase}
.rk-rc-fold>summary::-webkit-details-marker{display:none}
.rk-rc-fold>summary::before{content:"▸";display:inline-block;width:12px;transition:transform .24s var(--rk-ease)}
.rk-rc-fold[open]>summary::before{transform:rotate(90deg)}
.rk-rc-more{display:grid;gap:8px;margin-top:8px}
@container (max-width:460px){.rk-well.rk-rc-glass{grid-template-columns:repeat(2,minmax(0,1fr))}.rk-rc-cell:nth-child(3){border-left:0}.rk-rc-cell:nth-child(n+3){border-top:1px solid var(--ph-rule)}.rk-rc-head{flex-wrap:wrap;row-gap:6px}.rk-rc-title{order:3;flex-basis:100%;white-space:normal}.rk-rc-when{margin-left:auto}}
/* -- the page (roko's design system §5.1): the header, three tabs, Runs as home, a run's page ------------------ */
.rk-head{gap:12px;min-height:56px;padding:10px 24px}
.rk-wordmark{display:inline-flex;align-items:center;height:26px;padding:0 8px;border-radius:var(--rk-radius);background:var(--ph-void);box-shadow:inset 0 0 0 1px var(--ph-black),inset 0 1px 0 var(--ph-sheen);line-height:0;cursor:default}
.rk-head .rk-pill{height:24px}
.rk-today{display:inline-flex;align-items:center;gap:10px;height:32px;padding:0 10px}
.rk-today .rk-rc-label{font-size:8.5px}
.rk-tabs{gap:24px;min-height:0;padding:0 24px;border-bottom:var(--rk-hair,1px) solid var(--rk-stroke)}
.rk-tab-you{display:inline-flex;align-items:center;gap:5px}.rk-tab .rk-tab-you b{color:var(--rk-you-text);letter-spacing:0}
.rk-tab{position:relative;height:40px;padding:0;border-radius:0;font-family:inherit;font-size:13.5px;font-weight:600;line-height:1;letter-spacing:0;text-transform:none;color:var(--rk-ink-3)}
.rk-tab[aria-selected=true]{color:var(--rk-ink)}
.rk-tab[aria-selected=true]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;background:var(--rk-ink)}
.rk-tab .rk-led{margin-left:2px}
.rk-home{display:grid;gap:14px;max-width:1080px;width:100%}
.rk-home-sec{display:grid;gap:10px}
.rk-home-h{margin:6px 0 0;font:500 10px/1 var(--rk-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--rk-ink-3)}
.rk-lines{display:grid;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius-l);background:var(--rk-module);overflow:hidden}
.rk-line{display:grid;grid-template-columns:20px minmax(0,1fr) auto 76px 64px 64px;gap:14px;align-items:center;min-height:42px;padding:0 14px;border:0;border-top:var(--rk-hair,1px) solid var(--rk-stroke);background:transparent;color:var(--rk-ink);font:inherit;font-size:13.5px;text-align:left;cursor:pointer}
.rk-line:first-child{border-top:0}
.rk-lines-sec{padding:10px 14px 6px;border-top:var(--rk-hair,1px) solid var(--rk-stroke);font:500 9.5px/1 var(--rk-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-3)}.rk-lines-sec:first-child{border-top:0}
.rk-line .rk-tag{margin-left:8px;vertical-align:1px}
.rk-line:hover{background:var(--rk-hover)}
.rk-line:focus-visible{outline:2px solid var(--rk-you);outline-offset:-2px}
.rk-line-glyph{font:700 13px/1 var(--rk-mono);text-align:center;color:var(--rk-ink-3)}
.rk-line[data-state=pass] .rk-line-glyph{color:var(--rk-pass)}.rk-line[data-state=fail] .rk-line-glyph{color:var(--rk-fail)}.rk-line[data-state=you] .rk-line-glyph{color:var(--rk-you-text)}
.rk-line-title{min-width:0;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rk-line-title small{margin-left:8px;font-weight:400;font-size:12.5px;color:var(--rk-ink-3)}
.rk-line[data-state=fail] .rk-line-title small{color:var(--rk-fail)}
.rk-line-fig{font:400 12px/1 var(--rk-mono);text-align:right;color:var(--rk-ink-2);font-variant-numeric:tabular-nums}
.rk-line-when{font:400 11px/1 var(--rk-mono);text-align:right;color:var(--rk-ink-3)}
.rk-line .rk-rc-strip i{box-shadow:inset 0 0 0 1px var(--rk-stroke-2)}
.rk-line .rk-rc-strip i[data-state=pass]{background:var(--rk-pass)}.rk-line .rk-rc-strip i[data-state=fail]{background:var(--rk-fail)}.rk-line .rk-rc-strip i[data-state=live]{background:var(--rk-live)}.rk-line .rk-rc-strip i[data-state=you]{background:var(--rk-you)}
.rk-crumb{font-size:12.5px;color:var(--rk-ink-3)}
.rk-crumb button{padding:0;border:0;background:none;color:var(--rk-ink-2);font:inherit;cursor:pointer}
.rk-crumb button:hover{color:var(--rk-ink);text-decoration:underline;text-underline-offset:3px}
.rk-crumb b{font-weight:500;color:var(--rk-ink-2)}
.rk-runpage-wrap{display:grid;gap:10px;max-width:1180px;width:100%}
.rk-runpage{display:grid;gap:14px}
.rk-runhead{display:grid;gap:12px;padding:14px 16px 12px;border:var(--rk-hair,1px) solid var(--rk-stroke-2);border-radius:var(--rk-radius-l);background:var(--rk-module);box-shadow:inset 0 1px 0 var(--ph-sheen);container-type:inline-size}
.rk-runhead[data-look=you]{border-color:var(--rk-you)}
.rk-runhead-title{flex:1 1 auto;min-width:0;margin:0;font-size:19px;font-weight:700;line-height:1.25;letter-spacing:-.01em}
.rk-runhead-more{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;color:var(--rk-ink-3)}
.rk-runcols{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:14px;align-items:start}
@container (max-width:900px){.rk-runcols{grid-template-columns:minmax(0,1fr)}}
.rk-runsec{display:grid;grid-template-columns:minmax(0,1fr);gap:10px;min-width:0}
.rk-panel{padding:12px 14px;border:var(--rk-hair,1px) solid var(--rk-stroke);border-radius:var(--rk-radius-l);background:var(--rk-module)}
.rk-panel-h{display:flex;align-items:baseline;justify-content:space-between;gap:12px;margin:0;font:500 10px/1.3 var(--rk-mono);letter-spacing:.12em;text-transform:uppercase;color:var(--rk-ink-2)}
.rk-panel-h span{font-family:inherit;font-size:12px;font-weight:400;line-height:1.3;letter-spacing:0;text-transform:none;color:var(--rk-ink-3);text-align:right}
.rk-lesson{display:grid;grid-template-columns:16px minmax(0,1fr) auto;gap:10px;align-items:baseline;padding:8px 0;border-top:var(--rk-hair,1px) solid var(--rk-stroke);font-size:13.5px}
.rk-lesson:nth-child(2){border-top:0}
.rk-lesson>span:first-child{color:var(--rk-ink-3)}
.rk-lesson-use{font:400 11px/1.3 var(--rk-mono);color:var(--rk-ink-3);white-space:nowrap}
.rk-folds{display:grid}
.rk-fold2{border-top:var(--rk-hair,1px) solid var(--rk-stroke);padding:10px 0}
.rk-fold2>summary{list-style:none;cursor:pointer;color:var(--rk-ink-3);font:500 10px/1.2 var(--rk-mono);letter-spacing:.12em;text-transform:uppercase}
.rk-fold2>summary::-webkit-details-marker{display:none}
.rk-fold2>summary::before{content:"▸";display:inline-block;width:14px;transition:transform .24s var(--rk-ease)}
.rk-fold2[open]>summary::before{transform:rotate(90deg)}
.rk-fold2>summary:hover{color:var(--rk-ink)}
.rk-fold2-body{display:grid;gap:10px;margin-top:10px}
.rk-moment2{flex:none;padding:3px 7px;border-radius:2px;background:var(--rk-ink);color:var(--rk-body);font:700 10px/1 var(--rk-mono);letter-spacing:.16em;text-transform:uppercase;animation:rk-moment2 3.2s var(--rk-ease) both}
@keyframes rk-moment2{0%{opacity:0;transform:translateY(-3px)}8%,80%{opacity:1;transform:none}100%{opacity:0}}
@media (prefers-reduced-motion:reduce){.roko *,.roko *::before,.roko *::after{animation-duration:0s!important;animation-delay:0s!important;animation-iteration-count:1!important;transition-duration:0s!important;scroll-behavior:auto!important}.roko-merged-check circle,.roko-merged-check path{stroke-dashoffset:0}.rk-led[data-blink],.roko-dot[data-pulse=true]{opacity:1}}
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

// --- Registration

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
  const permissions = queryClient.getQueryData(projectKey(KEYS.overview))?.permissions

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
  description:
    'roko’s control surface: live runs on a dot-matrix display, the task sequencer, the five loops, approvals with two keys, diffs with a guarded merge, a monitor pane, a theme, and live run cards in chat.',
  register(ctx) {
    try {
      doors = { os: ctx.os, pet: ctx.pet, rest: ctx.rest, socket: ctx.socket, storage: ctx.storage }
      resetSeen()
      $sound.set(safe('the sound setting', () => ctx.storage?.get?.('sound', false) === true) ?? false)
      $studio.set(safe('the studio setting', () => ctx.storage?.get?.('sound-studio', false) === true) ?? false)
      $themeOffered.set(safe('the theme offer', () => ctx.storage?.get?.('theme-offered', false) === true) ?? false)
      $project.set(storedProject())
      // 0.7: the app opened, so roko serve should be up (BRIEF B6). The backend answers at once and starts it in the
      // background; a failure, or a 404 from an older backend (the page's restart path covers that), changes nothing.
      safe('roko serve', () => void post('/serve', { action: 'ensure' }).then(reply => applyServe(reply.serve), () => undefined))
      ctx.onDispose(() => {
        closeLive()
        closeAudio()
        doors = null
        navRegister = null
        resetSeen()
        cancelScheduledRefresh()
        eventCache.clear()
        eventListeners.clear()
        mergeResults.clear()
        $fixDone.set(null)
        liveAtoms.clear()
        followed.clear()
        freshRuns.clear()
        $loopFeed.set([])
        $sound.set(false)
        $composer.set({ mode: 'run', open: false, prompt: '' })
        $inspect.set(null)
        // The page opens fresh when the plugin comes back: no run or plan picked, no focus mode, no look held.
        $run.set(null)
        $plan.set(null)
        $project.set(null)
        $runView.set('overview')
        $focus.set(false)
        $markLook.set({ mood: null, until: 0 })
        markActivity = 0
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
            data: { id: 'roko.loops', keywords: ['roko', 'loops', 'cybernetic', 'learning', 'router', 'dial'], label: 'roko: Loops', run: () => openRoko({ tab: 'loops' }) },
            id: 'loops'
          },
          {
            area: PALETTE_AREA,
            data: { id: 'roko.monitor', keywords: ['roko', 'monitor', 'pane', 'live', 'sidebar'], label: 'roko: Monitor pane', run: showMonitor },
            id: 'monitor'
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

      // A tab in the right sidebar beside Files: hidden or shown, never closed (closing a plugin's only
      // pane would turn the plugin off).
      safe('the monitor pane', () =>
        ctx.register({
          area: PANES_AREA,
          data: { collapsible: true, hideOnly: true, maxWidth: '460px', minWidth: '260px', placement: 'right', tabTitleText: () => 'roko', width: '310px' },
          id: 'monitor',
          render: () => h(MonitorPane, null),
          title: 'roko'
        })
      )
      safe('the empty-chat card', () => ctx.register({ area: CHAT_EMPTY_AREA, data: { render: ({ sessionId }) => h(DelegateCard, { sessionId }) }, id: 'delegate' }))
      safe('the composer key', () => ctx.register({ area: COMPOSER_AREAS.actions, id: 'composer-key', order: 40, render: () => h(ComposerKey, null) }))
      safe('session lights', () => ctx.register({ area: SESSION_ROW_AREAS.trailing, data: { render: ({ sessionId }) => h(SessionLed, { sessionId }) }, id: 'session-led' }))
      safe('the theme', () => ctx.register({ area: THEMES_AREA, data: ROKO_THEME, id: 'theme' }))
      safe('the settings page', () => ctx.registerSettingsPage?.({ icon: 'rocket', id: 'settings', order: 40, render: () => h(SettingsPage, null), title: 'roko' }))

      safe('the sidebar row', () => {
        navRegister = label =>
          safe('the sidebar row', () => ctx.register({ area: SIDEBAR_NAV_AREA, data: { codicon: 'rocket', label, path: PAGE }, id: 'nav', order: 60 }))
        navRegister(navLabel)
      })

      safe('live updates', () => ctx.onEvent('tool.complete', event => safe('a tool event', () => onToolComplete(event))))
      safe('run events', () => {
        ctx.onEvent('plugin.roko.run.started', event => safe('run.started', () => onRunStarted(event)))
        ctx.onEvent('plugin.roko.run.ended', event => safe('run.ended', () => onRunEnded(event)))
        ctx.onEvent('plugin.roko.waiting', event => safe('waiting', () => onWaiting(event)))
      })
      safe('the live socket', () => {
        ctx.setInterval(checkLive, 5_000)

        // The socket belongs to one connection: a switch to another gateway dials again.
        const connection = host.state?.connectionId

        if (connection && typeof connection.listen === 'function') {
          ctx.onDispose(
            connection.listen(() => {
              if (socketState.dispose) {
                closeLive()
                openLive()
              }
            })
          )
        }
      })
      safe('notifications', () => ctx.onDispose(watchOverview()))
      safe('polling', () => ctx.onDispose(startPolling()))
    } catch (error) {
      console.error('[roko] desktop plugin failed to register', error)
    }
  }
}

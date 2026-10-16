/**
 * roko for Hermes Desktop: the desktop half of hermes-plugin-roko (0.5.0).
 *
 * Installed as <hermes home>/plugins/roko/desktop/plugin.js next to the Python
 * half. Hermes loads it uncompiled: plain ESM, jsx() calls instead of JSX, and
 * the only imports are '@hermes/plugin-sdk', 'react' and 'react/jsx-runtime'.
 * This door is opt-in: turn on roko's Desktop switch in Capabilities > Plugins.
 *
 * Everything here talks to the plugin's own backend: ctx.rest for the routes
 * (/api/plugins/roko/*) and ctx.socket('/live') for the push channel, both in
 * docs/ui-api.md. That router is the only thing that talks to roko serve; the
 * roko API key never reaches this renderer. Every route answers HTTP 200
 * {ok:true,…} or {ok:false,error:{code,message,hint}}. A rejected ctx.rest
 * means the router is not mounted: Hermes mounts plugin routers when it starts,
 * so the fix is a restart.
 *
 * Text that came from roko is untrusted. It is only ever rendered as React
 * text nodes: no HTML, no markdown, no dangerouslySetInnerHTML, no links built
 * from it. Diff lines and gate output are tinted by splitting them into text
 * spans, never by parsing them as markup.
 *
 * The look is a control surface (docs: design system v2): numbered modules,
 * live numbers in a 5×7 dot-matrix on a black display well, four channel
 * colours (agent blue, pass green, you orange, fail red) and nothing else
 * coloured, keys and a knob for controls, calm until something happens.
 *
 * Contributes:
 *   - the /roko page: one instrument per run (a display bar, the agent ticker,
 *     the task sequencer with its inspector, the activity feed, the five loops,
 *     the changes with a guarded Merge), plus Waiting, Plans, Loops, Insights
 *     and Knowledge, and a New run device;
 *   - a live socket (ctx.socket('/live')) that feeds every view as roko works,
 *     with polling as the fallback;
 *   - a monitor pane beside the chat, a "delegate to roko" card for empty
 *     chats, a "→ roko" key in the chat composer, a roko theme, a settings
 *     page, an LED on the sidebar rows of chats that started a run;
 *   - a sidebar row, a status-bar chip, palette rows, a "roko: New run" keybind
 *     (⌘⌥R), toasts, native notifications, pet lines, opt-in sounds, and a deep
 *     link (hermes://open/roko?run=<id>);
 *   - live chat cards for ::roko-run{id}, ::roko-plan{id} and ::roko-pending{run}.
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
  DecodeText,
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
  queryClient,
  requestTheme,
  ROUTES_AREA,
  SESSION_ROW_AREAS,
  SIDEBAR_NAV_AREA,
  Skeleton,
  STATUSBAR_AREAS,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
  Textarea,
  THEMES_AREA,
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

/** This page's version. The backend reports its own (`plugin_version`); a difference means Hermes still runs
 *  one of the two from before an update (docs/updating.md). A release bumps it with version.py. */
const VERSION = '0.5.0'
/** Plugin id == dashboard manifest name, so ctx.rest('/x') -> /api/plugins/roko/x. */
const ID = 'roko'
const PAGE = '/roko'
/** The monitor pane, as the layout tree knows it (contribution ids are `<plugin>:<id>`). */
const PANE_ID = `${ID}:monitor`
/** Run and plan ids from directives, deep links and untrusted data. */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const TABS = ['runs', 'waiting', 'plans', 'loops', 'knowledge', 'health']
/** A run's own views: the sequencer, everything that happened, its five loops, and what it changed. */
const RUN_VIEWS = ['overview', 'activity', 'loops', 'changes']
const ACTIVE_STATES = new Set(['queued', 'running'])
// `interrupted`: roko's process stopped while the run went (a restart or a crash); roko ends it as that.
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'unverified', 'cancelled', 'missing', 'interrupted'])
/** Contract: no faster than 10 s for the overview and 3 s for one run. */
const OVERVIEW_MS = 10_000
const OVERVIEW_HIDDEN_MS = 30_000
const RUN_MS = 3_000
/** While the live socket is healthy, polling only backs it up. */
const FALLBACK_MS = 15_000
/** The socket pings every 15 s: this long without a frame and it no longer counts as live. */
const LIVE_STALE_MS = 40_000
/** roko_* tool calls finishing within this window share one refresh. */
const TOOL_REFRESH_MS = 1_500
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
  plan: id => [ID, 'plan', id],
  run: id => [ID, 'run', id],
  diff: id => [ID, 'diff', id],
  merge: id => [ID, 'merge', id],
  knowledge: q => [ID, 'knowledge', q],
  health: [ID, 'health'],
  insights: [ID, 'insights'],
  loops: [ID, 'loops'],
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
  missing: { glyph: '?', tone: 'warn', word: 'missing' },
  // roko stopped while it went (a restart or a crash): not a verdict on the work, which is kept.
  interrupted: { glyph: '‖', tone: 'warn', word: 'interrupted' },
  // The page's own: roko serve is down, so a run it last called running is only its last known state.
  last_seen: { glyph: '·', tone: 'muted', word: 'last seen running' }
}

/**
 * While roko serve is down, a run it last called running is only its last known state: it may still be going,
 * or it stopped when roko did. Shown as "last seen running", with its clock stopped at its last sign of life and
 * nothing to cancel. Only for showing: the overview's own rows keep roko's word for it.
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

/** One of the router's past picks: "picked by the model ladder · passed" (p only for a scored pick under 1). */
function routeRowWords(route) {
  const view = routeView(route)
  const odds = view.scored && num(route.p) !== null && route.p < 1 ? `p ${route.p.toFixed(2)}` : null

  return [view.words, odds, route.outcome === true ? 'passed' : route.outcome === false ? 'did not pass' : null].filter(Boolean).join(' · ')
}

/** A model a run from Hermes cannot use: one that runs its own tools (a CLI or ACP agent), on an older backend. */
function fromHermes(c) {
  if (c.eligible === false || 'why_not' in c) {
    return c
  }

  return /(^|[_-])(cli|acp)$/i.test(text(c.provider)) ? { ...c, eligible: false, why_not: 'runs its own tools: a run started from Hermes needs a model in roko\u2019s own tool loop' } : c
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

/** Money as roko gives it: to a hundredth of a cent below ten cents ($0.032, $0.0036), else as `money`. */
function fineMoney(v) {
  const n = num(v)

  if (n === null || Math.abs(n) >= 0.1) {
    return money(n)
  }

  let s = n.toFixed(4)

  while (s.endsWith('0') && s.split('.')[1].length > 2) {
    s = s.slice(0, -1)
  }

  return `$${s}`
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
 * headline. An older roko never says it.
 */
function capStopped(run) {
  return isRecord(run) && run.state === 'failed' && (Boolean(run.budget_stop) || CAP_HEADLINE.test(text(run.headline)) || DAY_HEADLINE.test(text(run.headline)))
}

/** Which limit stopped the run: roko's daily limit (`budget_stop.limit: "day"`), else the run's own cap. */
function dayStopped(run) {
  return (isRecord(run.budget_stop) && text(run.budget_stop.limit) === 'day') || DAY_HEADLINE.test(text(run.headline))
}

/** A stop at a limit as the pages show it: a stop's colour, never red. */
const CAP_STOP = { glyph: '■', tone: 'muted', word: 'stopped · cap' }
const DAY_STOP = { glyph: '■', tone: 'muted', word: 'stopped · day limit' }

/**
 * The stop in a sentence (the same words as the dashboard): "roko stopped the run at its cap of $0.05 ($0.032
 * spent)", or "… at today’s limit of $20.00 ($20.04 spent)".
 */
function capWords(run) {
  const stop = isRecord(run.budget_stop) ? run.budget_stop : {}
  const cap = num(stop.cap_usd)
  const spent = num(stop.spent_usd)

  return `roko stopped the run at ${dayStopped(run) ? 'today’s limit' : 'its cap'}${cap !== null ? ` of ${fineMoney(cap)}` : ''}${cap !== null && spent !== null ? ` (${fineMoney(spent)} spent)` : ''}`
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

/** The share of the run's tasks that ended (or half-ended while running), 0..1. */
function doneFraction(p) {
  if (!p.total) {
    return 0
  }

  return clamp((p.passed + p.failed + p.blocked + p.stopped + (p.skipped ?? 0) + p.unverified + p.running * 0.5) / p.total, 0, 1)
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
  constructor({ kind, code, message, hint, problem, validation }) {
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
    const problem = readProblem(reply.problem)

    throw new RokoError({
      code: text(e.code) || 'internal',
      hint: text(e.hint),
      kind: 'roko',
      message: text(e.message) || problem?.title || 'roko reported an error.',
      problem,
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
  queryClient.setQueryData(KEYS.pending, old => (Array.isArray(old) ? old.filter(keep) : old))
  queryClient.setQueryData(KEYS.overview, old =>
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
  return useQuery({
    queryFn: () => call('/pending').then(r => settleAnswered(list(r.items))),
    queryKey: KEYS.pending,
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
    // pushes its cards; stop once it ends.
    refetchInterval: query => (isActiveRun(query.state.data) ? pollMs(RUN_MS) : false),
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
  return useQuery({
    enabled,
    queryFn: () => call('/plans').then(r => list(r.plans)),
    queryKey: KEYS.plans,
    retry: false,
    staleTime: 30_000
  })
}

/** A plan's set (its folder under plans/) from the plans list, when it is wanted and roko lists the plan. */
function usePlanGroup(planId) {
  const plans = usePlans(validId(planId))

  return validId(planId) ? text(list(plans.data).find(plan => isRecord(plan) && plan.id === planId)?.group) : ''
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

/** The doctor's checks. The cache keeps /health whole: the setup module reads its `install` and `setup`. */
function useHealth() {
  return useQuery({
    queryFn: () => call('/health'),
    queryKey: KEYS.health,
    retry: false,
    select: reply => list(reply?.checks),
    staleTime: 30_000
  })
}

/** Whose numbers Insights shows: the runs Hermes started (the default), or roko's whole workspace. */
const $insightsScope = atom('hermes')

function useInsights(scope = 'hermes') {
  // An older backend ignores `scope` and answers for the whole workspace (its reply has no `scope` then).
  return useQuery({ queryFn: () => call(`/insights?scope=${enc(scope)}`), queryKey: [...KEYS.insights, scope], retry: false, staleTime: 60_000 })
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
// Live: one socket to /live (docs/ui-api.md, "The live channel") feeds the
// query cache and the live views. Polling stays, slowed to a fallback while
// the socket is healthy, and takes over whenever it is not.
// ---------------------------------------------------------------------------

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
const EMPTY_LIVE = Object.freeze({ at: 0, byTask: Object.freeze({}), items: Object.freeze([]), loops: Object.freeze([]) })
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

/** A loop event's channel: blue while agents work, orange when it needs the person, red when something broke. */
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
    return 'pass'
  }

  if (kind === 'tool_decided') {
    return /applied|approved/i.test(text(data.outcome)) ? 'pass' : 'ink'
  }

  return 'agent'
}

/** A learning loop's health as a channel: healthy is green, watch orange, broken red, anything else ink. */
function healthChannel(state) {
  if (/^(healthy|ok|active|stable)$/i.test(state)) {
    return 'pass'
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

/**
 * A loop event's words: the backend's own. An older backend wrote bare numbers for a learning loop's health
 * ("L-route: probation · h 0.20") and a route ("T1 attempt 1 → glm-5.1 (ladder; p 1.00; over …)"); those are said
 * from the event's `data` the way a newer backend says them, as the dashboard does.
 */
function loopText(event, kind, data) {
  const said = text(event.text)

  if (kind === 'loop_health' && text(data.loop_id) && (!said || /· h \d/.test(said))) {
    return `${LOOP_NAMES[text(data.loop_id)] ?? text(data.loop_id)}: ${loopHealthWords(data)}`
  }

  if (kind === 'route' && text(data.model) && !/, (picked by|switched by|roko's default)/.test(said)) {
    const view = routeView(data)
    const odds = view.scored && num(data.p) !== null && data.p < 1 ? `p ${data.p.toFixed(2)}` : null
    const who = [text(event.task_id), num(data.attempt) !== null ? `attempt ${num(data.attempt)}` : ''].filter(Boolean).join(' ')

    return `${who ? `${who} ` : ''}→ ${text(data.model)}, ${view.words}${view.rung ? ` (rung ${view.rung})` : odds ? ` (${odds})` : ''}`
  }

  return said
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
    ts: num(frame.ts) ?? Date.now()
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
    items = continues ? items.map((old, i) => (i === last ? entry : old)) : [...items, entry].slice(-40)
  }

  a.set({
    ...cur,
    at: Date.now(),
    byTask: item.task_id ? { ...cur.byTask, [item.task_id]: entry } : cur.byTask,
    items
  })

  if (kind !== 'beat') {
    blip({ channel: kind === 'result' ? 'ink' : 'agent', ring: 'L0', runId, ts: item.ts })
  }
}

/** Timeline lines pushed by the socket: merged into the run's activity, and heard. */
function pushLines(runId, lines) {
  if (!validId(runId) || !lines.length) {
    return
  }

  const cached = eventCache.get(runId) ?? { cursor: null, events: [] }
  const events = mergeEvents(cached.events, lines)

  if (events === cached.events) {
    return
  }

  cacheEvents(runId, { ...cached, events })
  lines.filter(isRecord).forEach(line => {
    const type = text(line.type)

    if (type === 'gate_result') {
      blip({ channel: line.passed === true ? 'pass' : 'fail', ring: 'L1', runId, ts: num(line.ts_millis) ?? Date.now() })
      play(line.passed === true ? 'check' : 'fail')
    } else if (type === 'task_completed') {
      const passed = PASSED.has(text(line.outcome))

      blip({ channel: passed ? 'pass' : 'fail', ring: 'L2', runId, ts: num(line.ts_millis) ?? Date.now() })

      if (passed) {
        play('task')
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
        queryClient.setQueryData(KEYS.overview, frame.overview)
      }

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

// -- the socket ----------------------------------------------------------------

const socketState = { dispose: null, path: null }
/** Runs a page follows that Hermes did not start (`?runs=`, at most 8). */
const followed = new Set()

function livePath() {
  const runs = [...followed].slice(-8)

  return runs.length ? `/live?runs=${runs.map(enc).join(',')}` : '/live'
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

function useLoops(enabled = true) {
  return useQuery({
    enabled,
    // Each ring's recent events (from the relay and recent cards) join this window's feed.
    queryFn: () =>
      call('/loops').then(reply => {
        list(reply.rings)
          .filter(isRecord)
          .forEach(ring => mergeLoops(null, list(ring.recent).map(e => (isRecord(e) ? { ring: ring.ring, ...e } : e)), false))

        return reply
      }),
    queryKey: KEYS.loops,
    refetchInterval: () => (isHidden() ? false : 30_000),
    retry: false,
    staleTime: 15_000
  })
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

  // A typed request stays as a draft; a plan to run (and a rerun's cap) only when this caller names one.
  $composer.set({ ...current, cap: null, plan: null, resume: false, ...draft, open: true })
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


function StatePill({ state, word, tone, glyph, run }) {
  const info = run ? runInfo(run) : stateInfo(state)
  const stop = run && capStopped(run)

  return h(
    'span',
    { className: 'roko-pill', 'data-state': text(state ?? run?.state), 'data-stop': stop ? 'cap' : undefined, 'data-tone': tone || info.tone, title: stop ? capWords(run) : undefined },
    h('span', { 'aria-hidden': 'true', className: 'roko-pill-glyph' }, glyph || info.glyph),
    ' ',
    word || info.word
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
    // 0.5.0: tasks the plan's conditions did not call for (neither failed nor stopped), drawn as stopped ones are.
    ['skipped', p.skipped ?? 0],
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

// ---------------------------------------------------------------------------
// The control surface: dot-matrix displays, wells, LEDs, keys, a knob, a
// slide switch, the agent ticker, the scope, and the five-loop dial
// ---------------------------------------------------------------------------

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
const DOT_SIZES = { L: { dot: 3, pitch: 4.1 }, M: { dot: 2.4, pitch: 3.3 }, S: { dot: 1.7, pitch: 2.4 }, XL: { dot: 4.2, pitch: 5.6 } }
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
const Dots = memo(function Dots({ value, size = 'M', tone, label, hidden, grid = true, pad = 0, className }) {
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
      className: cx('rk-dots', className),
      'data-size': size,
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
        strokeWidth: dot
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

/** A numbered module label: `01 TASKS`. */
function ModLabel({ n, children, right }) {
  return h(
    'div',
    { className: 'rk-mod' },
    h('span', { className: 'rk-mod-n' }, String(n).padStart(2, '0')),
    h('span', { className: 'rk-mod-label' }, children),
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

/** Where a value sits on the knob's 270° travel: detents evenly spaced, values between them in log scale. */
function knobAngle(value, detents) {
  const v = num(value)

  if (v === null || !detents.length) {
    return -135
  }

  const step = 270 / Math.max(1, detents.length - 1)

  if (v <= detents[0]) {
    return -135
  }

  for (let i = 1; i < detents.length; i += 1) {
    if (v <= detents[i]) {
      const f = Math.log(v / detents[i - 1]) / Math.log(detents[i] / detents[i - 1])

      return -135 + step * (i - 1 + f)
    }
  }

  return 135
}

/**
 * The cap knob: detents bounded by what may be spent (`ceiling`); drag up or down, scroll, or use the arrow
 * keys; the detents are also keys under it. The value shows in a well.
 */
function Knob({ value, detents, ceiling, onChange, label, disabled }) {
  const allowed = detents.filter(d => ceiling === null || d <= ceiling + 1e-9)
  const v = num(value)
  const drag = useRef(null)
  const angle = knobAngle(v, detents)
  // One detent up or down from wherever the value is (a typed value sits between two).
  const step = dir => {
    if (disabled || !allowed.length) {
      return
    }

    const next =
      v === null
        ? allowed[0]
        : dir > 0
          ? (allowed.find(d => d > v + 1e-9) ?? allowed[allowed.length - 1])
          : ([...allowed].reverse().find(d => d < v - 1e-9) ?? allowed[0])

    if (next !== v) {
      onChange(next)

      try {
        haptic('selection')
      } catch {
        // Haptics are a nicety.
      }
    }
  }
  const rad = deg => ((deg - 90) * Math.PI) / 180
  const point = (deg, r) => [36 + r * Math.cos(rad(deg)), 36 + r * Math.sin(rad(deg))]
  const arc = (from, to, r) => {
    const [x1, y1] = point(from, r)
    const [x2, y2] = point(to, r)

    return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`
  }
  const [px, py] = point(angle, 19)
  const [qx, qy] = point(angle, 8)

  return h(
    'div',
    { className: 'rk-knob', 'data-disabled': disabled ? 'true' : undefined },
    h(
      'div',
      {
        'aria-disabled': disabled ? 'true' : undefined,
        'aria-label': label,
        'aria-valuemax': allowed.length ? allowed[allowed.length - 1] : 0,
        'aria-valuemin': allowed.length ? allowed[0] : 0,
        'aria-valuenow': v ?? 0,
        'aria-valuetext': money(v),
        className: 'rk-knob-dial',
        onKeyDown: event => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault()
            step(1)
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault()
            step(-1)
          } else if ((event.key === 'Home' || event.key === 'End') && allowed.length) {
            event.preventDefault()
            onChange(event.key === 'Home' ? allowed[0] : allowed[allowed.length - 1])
          }
        },
        onPointerDown: event => {
          if (disabled) {
            return
          }

          drag.current = { y: event.clientY }
          event.currentTarget.setPointerCapture?.(event.pointerId)
        },
        onPointerMove: event => {
          if (!drag.current) {
            return
          }

          const dy = drag.current.y - event.clientY

          if (Math.abs(dy) >= 16) {
            step(dy > 0 ? 1 : -1)
            drag.current.y = event.clientY
          }
        },
        onPointerUp: () => {
          drag.current = null
        },
        onWheel: event => {
          if (Math.abs(event.deltaY) > 2) {
            step(event.deltaY < 0 ? 1 : -1)
          }
        },
        role: 'slider',
        tabIndex: disabled ? -1 : 0
      },
      h(
        'svg',
        { 'aria-hidden': 'true', className: 'rk-knob-svg', viewBox: '0 0 72 72' },
        h('path', { className: 'rk-knob-travel', d: arc(-135, 135, 31) }),
        angle > -134 ? h('path', { className: 'rk-knob-value', d: arc(-135, angle, 31) }) : null,
        detents.map((d, i) => {
          const a = -135 + (270 * i) / Math.max(1, detents.length - 1)
          const [x1, y1] = point(a, 33.5)
          const [x2, y2] = point(a, 35.5)

          return h('line', { className: 'rk-knob-detent-mark', 'data-over': allowed.includes(d) ? undefined : 'true', key: d, x1, x2, y1, y2 })
        }),
        h('circle', { className: 'rk-knob-body', cx: 36, cy: 36, r: 24 }),
        h('circle', { className: 'rk-knob-cap', cx: 36, cy: 36, r: 19 }),
        h('line', { className: 'rk-knob-pointer', x1: qx, x2: px, y1: qy, y2: py })
      )
    ),
    h(
      'div',
      { 'aria-label': 'Spend cap presets', className: 'rk-knob-scale', role: 'group' },
      detents.map(d => {
        const over = !allowed.includes(d)

        return h(
          'button',
          {
            'aria-pressed': v !== null && Math.abs(v - d) < 1e-9 ? 'true' : 'false',
            className: 'rk-knob-detent',
            disabled: disabled || over,
            key: d,
            onClick: () => onChange(d),
            title: over && ceiling !== null ? `Above the ${money(ceiling)} you can cap a run at now` : undefined,
            type: 'button'
          },
          money(d)
        )
      })
    )
  )
}

/** A run that is going and waits on the person (a sign-off or a held call): its colour is orange, "you". */
function waitsOnYou(run) {
  return isActiveRun(run) && list(run?.waiting).some(isRecord)
}

/** Task states in drawing order for strips: what passed first, what waits last. */
function stripCells(progress, max) {
  const p = progress ?? EMPTY_PROGRESS
  const order = ['passed', 'failed', 'blocked', 'unverified', 'stopped', 'skipped', 'running', 'pending']
  const cells = []

  order.forEach(state => {
    for (let i = 0; i < (p[state] ?? 0); i += 1) {
      cells.push(state)
    }
  })

  if (cells.length <= max) {
    return cells
  }

  // More tasks than cells: sample evenly, never dropping a state that has a task.
  return Array.from({ length: max }, (_, i) => cells[Math.floor(((i + 0.5) * cells.length) / max)])
}

/**
 * One small square per task in its channel colour: the track list's step strip. While the run waits on the
 * person, its running tasks are what waits, so they turn orange and blink fast.
 */
function StepStrip({ progress, max = 16, label, className, waiting }) {
  const cells = stripCells(progress, max).map(state => (waiting && state === 'running' ? 'waiting' : state))

  if (!cells.length) {
    return null
  }

  return h(
    'span',
    { 'aria-hidden': label ? undefined : 'true', 'aria-label': label, className: cx('rk-strip', className), role: label ? 'img' : undefined },
    cells.map((state, i) => h('i', { 'data-state': state, key: i }))
  )
}

/**
 * What the run's agents are doing this second: the newest tool step or words from the socket, else the
 * card's last step, else what each running task is on. Older moves trail off to the left.
 */
function tickerItems(run, live) {
  const active = isActiveRun(run)
  const items = []
  const titleOf = id => text(list(run?.tasks).find(t => isRecord(t) && text(t.task_id) === id)?.task_id) || text(id)

  if (active) {
    live.items
      .filter(item => item.kind === 'tool' || item.kind === 'text' || item.kind === 'reasoning')
      .slice(-6)
      .forEach((item, i) => {
        items.push({
          kind: item.kind,
          key: item.kind === 'tool' ? `l${item.ts}:${i}` : `w${item.task_id}:${item.since}`,
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

          steps.slice(-3).forEach((step, i) =>
            items.push({ kind: 'tool', key: `s${text(task.task_id)}:${text(step.ts)}:${i}`, task: text(task.task_id), words: [text(step.tool), text(step.target)].filter(Boolean).join(' ') })
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
 * plan's whole-plan check, or the delivery's check of the workspace. `{text, since}` or null. A check of the
 * plan or the workspace runs when no task does, and can take minutes: it is the run's news then.
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

const Ticker = memo(function Ticker({ run, live, compact }) {
  const active = isActiveRun(run)
  const forYou = waitsOnYou(run)
  const checking = checkingOf(run)
  // A check of the plan or the workspace runs after the tasks: their last steps are old news by then.
  const items = checking && !checking.task ? [] : tickerItems(run, live)
  const newest = items[items.length - 1]
  let idle = ''

  if (!newest) {
    idle = active
      ? run?.state === 'queued'
        ? 'queued · waiting for a slot'
        : notStarted(run)
          ? 'starting… roko gets the run ready'
          : forYou
          ? 'waiting on you'
          : checking
            ? checking.text
            : 'between steps'
      : clip(run?.headline, 160) || runInfo(run).word
  }

  return h(
    Well,
    {
      className: 'rk-ticker',
      label: newest ? `${newest.task} ${newest.kind === 'text' || newest.kind === 'reasoning' ? clipEnd(newest.words, 160) : newest.words}` : idle,
      role: 'status',
      tone: forYou ? 'you' : active ? 'agent' : 'ink'
    },
    h(LED, { blink: forYou ? 'fast' : active ? 'slow' : undefined, tone: forYou ? 'you' : active ? 'agent' : 'off' }),
    h(
      'span',
      { className: 'rk-ticker-lane', 'data-compact': compact ? 'true' : undefined },
      newest
        ? items.map((item, i) =>
            h(
              'span',
              { className: 'rk-ticker-item', 'data-age': String(items.length - 1 - i), 'data-channel': item.channel, 'data-kind': item.kind, key: item.key },
              h('b', null, clip(item.task, 14)),
              ' ',
              // Words keep their newest end in view: a long line is cut on the left, never the right.
              item.kind === 'text' || item.kind === 'reasoning'
                ? h('span', { className: 'rk-said' }, h('span', null, `“${clipEnd(item.words, compact ? 62 : 118)}”`))
                : clip(item.words, compact ? 64 : 120)
            )
          )
        : h(
            'span',
            { className: 'rk-ticker-item', 'data-age': '0', 'data-channel': forYou ? 'you' : undefined, 'data-kind': checking && idle === checking.text ? 'check' : 'idle', 'data-testid': checking && idle === checking.text ? 'ticker-checking' : undefined },
            idle,
            checking && idle === checking.text && checking.since ? h(Fragment, null, ' · ', h(StepClock, { since: checking.since })) : null
          )
    )
  )
})

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

const DIAL_R = [36, 52, 68, 84, 100]

/**
 * The five loops as five rings, L0 inside to L4 outside. A hand sweeps once a minute; every loop event is a
 * tick on its ring where the hand was when it happened, in its channel colour, fading over ten minutes.
 */
const Dial = memo(function Dial({ events, size = 232, label, now }) {
  const phase = useRef(-((Date.now() % 60_000) / 1_000))
  const reduced = reducedMotion()
  const at = now ?? Date.now()
  const recent = events.slice(-160)
  const busy = new Set(recent.filter(e => at - (e.ts ?? 0) < 600_000).map(e => e.ring))

  return h(
    'div',
    { 'aria-label': label, className: 'rk-dial', role: 'img', style: { height: size, width: size } },
    h(
      'svg',
      { 'aria-hidden': 'true', className: 'rk-dial-svg', viewBox: '0 0 220 220' },
      h('circle', { className: 'rk-dial-face', cx: 110, cy: 110, r: 109 }),
      Array.from({ length: 60 }, (_, i) =>
        h('line', { className: 'rk-dial-minute', 'data-major': i % 5 === 0 ? 'true' : undefined, key: `m${i}`, transform: `rotate(${i * 6} 110 110)`, x1: 110, x2: 110, y1: 2.5, y2: i % 5 === 0 ? 7.5 : 5 })
      ),
      DIAL_R.map((r, i) => h('circle', { className: 'rk-dial-ring', cx: 110, cy: 110, 'data-busy': busy.has(RING_IDS[i]) ? 'true' : undefined, key: RING_IDS[i], r })),
      recent.map(e => {
        const r = DIAL_R[RING_IDS.indexOf(e.ring)]
        const ts = e.ts ?? at
        const age = Math.max(0, at - ts)

        return r
          ? h('line', {
              className: 'rk-dial-tick',
              'data-channel': loopChannel(e),
              'data-fresh': age < 3_000 ? 'true' : undefined,
              key: e.key,
              style: { opacity: clamp(1 - age / 600_000, 0.22, 1) },
              transform: `rotate(${(((ts % 60_000) / 60_000) * 360).toFixed(2)} 110 110)`,
              x1: 110,
              x2: 110,
              y1: 110 - r - 5,
              y2: 110 - r + 5
            })
          : null
      }),
      DIAL_R.map((r, i) => h('text', { className: 'rk-dial-label', key: `t${i}`, x: 113, y: 110 - r + 3.4 }, RING_IDS[i])),
      h(
        'g',
        {
          className: 'rk-dial-hand',
          'data-still': reduced ? 'true' : undefined,
          style: reduced ? { transform: `rotate(${(((at % 60_000) / 60_000) * 360).toFixed(1)}deg)` } : { animationDelay: `${phase.current}s` }
        },
        h('line', { x1: 110, x2: 110, y1: 112, y2: 4 }),
        h('circle', { cx: 110, cy: 4, r: 2.2 })
      ),
      h('circle', { className: 'rk-dial-hub', cx: 110, cy: 110, r: 4.5 })
    )
  )
})

// ---------------------------------------------------------------------------
// The sequencer: the run's tasks as pads in wave columns, their dependencies,
// a playhead, and the inspector for one task
// ---------------------------------------------------------------------------

const GRAPH = { gapMax: 56, gapMin: 20, gapY: 12, maxW: 240, minW: 150, nodeH: 96, padBottom: 10, padTop: 28, padX: 10 }

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
  const base = {
    attempts: num(task.attempts) ?? 0,
    blockedBy: text(task.blocked_by),
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
  const gap = cols > 1 ? clamp(avail * 0.05, GRAPH.gapMin, GRAPH.gapMax) : 0
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

/** A task as a pad: its id big, its title small, a ring of light in its state's channel. */
function GraphNode({ node, pos, selected, onSelect, planOnly, live }) {
  const info = outcomeInfo(node.outcome, node.attempts)
  const words = node.state === 'running' ? stepWords(node) : ''
  const label = [`${node.taskId} ${node.title}`, planOnly ? '' : info.word, planOnly ? '' : info.note, words].filter(Boolean).join(', ')
  const channel = planOnly ? 'off' : nodeChannel(node)
  const move = live && node.state === 'running' && !node.waiting ? live : null
  const before = useRef(node.state)
  const [flash, setFlash] = useState(false)

  // The completion moment: a pad that just passed (or failed) flashes its channel twice.
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
      node.checks ? h('span', { className: 'roko-node-meta' }, h(Codicon, { name: 'beaker', size: '0.7rem' }), plural(node.checks, 'check')) : h('span', { className: 'roko-node-meta' }, 'no checks'),
      node.deps ? h('span', { className: 'roko-node-meta' }, `after ${node.deps}`) : null,
      node.questions ? h('span', { className: 'rk-tag', 'data-channel': 'you', 'data-testid': `open-question-${node.id}` }, node.questions === 1 ? 'open question' : `${node.questions} open questions`) : null
    )
  } else if (node.state === 'running') {
    foot = h(
      'span',
      { className: 'roko-node-foot' },
      h('span', { className: 'roko-node-step', title: move ? [move.tool, move.target].filter(Boolean).join(' ') : undefined }, move && move.kind === 'tool' ? clip([move.tool, move.target].filter(Boolean).join(' '), 40) : words),
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
      'data-channel': channel,
      'data-flash': flash ? 'true' : undefined,
      'data-node': node.id,
      'data-selected': selected ? 'true' : 'false',
      'data-state': planOnly ? 'plan' : node.state,
      'data-waiting': node.waiting && !planOnly ? 'true' : undefined,
      onClick: () => onSelect?.(node.id),
      style: { height: pos.h, left: pos.x, top: pos.y, width: pos.w },
      type: 'button'
    },
    h(
      'span',
      { className: 'roko-node-head' },
      h('span', { className: 'roko-node-id' }, clip(node.taskId, 14)),
      h('span', { className: 'roko-flex' }),
      node.attempts > 1 && !planOnly ? h('span', { className: 'roko-node-attempts', title: plural(node.attempts, 'attempt') }, `×${node.attempts}`) : null,
      planOnly ? null : h(NodeMark, { node }),
      planOnly ? null : h(LED, { blink: node.state === 'running' ? (node.waiting ? 'fast' : 'slow') : undefined, size: 's', tone: channel })
    ),
    h('span', { className: 'roko-node-top', title: node.title || node.taskId }, h('span', { className: 'roko-node-title' }, node.title || node.taskId)),
    foot
  )
}

/**
 * The sequencer. `nodes` maps node ids to node view models; `waves` and `edges` come from the card (or a
 * plan). Each wave is a step column, numbered on top like a sequencer's steps; the playhead marks the wave
 * the run is on (or the replay's moment). Pads are buttons over an SVG layer of edges, so they keep focus
 * rings, ellipsis and transitions; the canvas scrolls sideways inside its own frame when it is wide.
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
        waves.length > 1
          ? layout.waveX.map((x, i) =>
              h('text', { className: 'roko-wave-label', 'data-active': head && head.wave === i ? 'true' : undefined, key: `w${i}`, x: x + 2, y: 15 }, `W${i + 1}`)
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

      return h(
        'div',
        { className: 'roko-pipe-row', key: `a${index}` },
        h('span', { className: 'roko-pipe-label' }, `#${num(attempt.attempt) ?? index + 1}`),
        h(
          'span',
          { className: 'roko-pipe-stage', 'data-state': agentLive ? 'run' : 'done' },
          h(Codicon, { name: 'hubot', size: '0.72rem' }),
          clip(attempt.model || node.model || 'agent', 22),
          route && routeView(route).word ? h('span', { className: 'rk-tag', 'data-channel': routeView(route).decider === 'failover' ? 'fail' : 'agent' }, routeView(route).word) : null
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
          latest ? outcomeInfo(node.outcome, node.attempts).word : 'retried'
        ),
        attempt.started_at ? h('span', { className: 'roko-pipe-time' }, clock(parseTime(attempt.started_at))) : null
      )
    })
  )
}

/**
 * Why an attempt runs on its model: who picked it ("picked by the model ladder", "rung mid", or the router's learned
 * scores), and the other models it could have used. Score bars only when scores decided the pick; models this run
 * cannot use (a CLI agent for a run from Hermes, a provider with no key) fold away behind their count.
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
    said ? h('blockquote', { className: 'roko-quote rk-said' }, clip(said, 600)) : null
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

  if ((num(lesson.promoted) ?? 0) > 0) {
    parts.push(`${num(lesson.promoted)} moved up a tier`)
  } else if (lesson.promoted === true) {
    parts.push('moved up a tier')
  }

  return { channel: /admitted|duplicate/.test(admission) || confirmed ? 'pass' : 'ink', lesson: kept, meta: parts.filter(Boolean).join(' · ') }
}

/** Everything about one task: its attempts and their checks, the route, what the agent does now and said. */
function TaskInspector({ run, task, node, onClose, onSelect, live }) {
  const box = useRef(null)
  const why = isRecord(run.why) ? run.why : null
  const failing = list(why?.gates_not_passed).filter(g => isRecord(g) && text(g.task_id) === node.taskId)
  const excerpt = list(task.gates).filter(isRecord).find(g => g.passed === false)
  const [showOutput, setShowOutput] = useState(false)
  const deps = list(task.depends_on).map(text).filter(Boolean)
  const info = outcomeInfo(node.outcome, node.attempts)
  // roko asks each agent to end with "Lesson: …"; "Lesson: none" is protocol, not words for the person.
  const note = text(task.note).replace(/\n*\s*Lesson:\s*(none|n\/a|-|—)?\.?\s*$/i, '').trim()
  const log = list(task.attempt_log).filter(isRecord)
  const route = [...log].reverse().find(a => isRecord(a.route))?.route ?? null

  // Opened from a click below the fold (the why callout, the now strip): bring it into view.
  useEffect(() => {
    if (onClose) {
      box.current?.scrollIntoView?.({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'nearest' })
    }
  }, [node.id])

  return h(
    'section',
    { 'aria-label': `Task ${node.taskId}`, className: 'roko-inspector', 'data-channel': nodeChannel(node), 'data-testid': `inspector-${node.taskId}`, ref: box },
    h(
      'div',
      { className: 'roko-inspector-head' },
      h(LED, { blink: node.state === 'running' ? (node.waiting ? 'fast' : 'slow') : undefined, tone: nodeChannel(node) }),
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
    h(TaskLoops, { task }),
    h(TaskLive, { live, node, task }),
    h('div', { className: 'rk-inspector-grid' },
      h(
        'div',
        { className: 'rk-inspector-col' },
        h(SectionLabel, null, 'Attempts'),
        h(TaskPipeline, { node, task })
      ),
      // Keyed by the task and attempt: another task's route starts folded again.
      route ? h('div', { className: 'rk-inspector-col' }, h(SectionLabel, null, 'Route'), h(RouteCard, { key: `${text(task.task_id)}:${num(route.attempt) ?? ''}`, route })) : null
    ),
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

/** Run events cached per run id, so reopening a run only fetches newer rows; the socket's `lines` merge in. */
const eventCache = new Map()
/** Mounted activity views per run, told when the socket pushes lines. */
const eventListeners = new Map()

/** Lines merged by cursor (a line the socket and a page both brought shows once), in cursor order. */
function mergeEvents(events, more) {
  const seen = new Set(events.map(e => num(e.cursor)).filter(c => c !== null))
  const fresh = list(more)
    .filter(isRecord)
    .filter(e => num(e.cursor) === null || !seen.has(e.cursor))

  if (!fresh.length) {
    return events
  }

  return [...events, ...fresh].sort((a, b) => (num(a.cursor) ?? Infinity) - (num(b.cursor) ?? Infinity)).slice(-500)
}

function cacheEvents(runId, next) {
  eventCache.set(runId, next)

  if (eventCache.size > 30) {
    eventCache.delete(eventCache.keys().next().value)
  }

  eventListeners.get(runId)?.forEach(listener => listener(next))
}

function useRunEvents(runId, open, active) {
  const [state, setState] = useState(() => eventCache.get(runId) ?? { cursor: null, events: [] })
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
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

          const events = mergeEvents(current.events, list(reply.events))

          more = reply.has_more === true && events !== current.events
          current = { cursor: reply.next_cursor ?? current.cursor, events }
        }

        // Lines the socket pushed while this pull was out stay.
        const merged = { cursor: current.cursor, events: mergeEvents(current.events, stateRef.current.events) }

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

          if (activeRef.current) {
            timer = setTimeout(() => void pull(), pollMs(RUN_MS))
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
        delivered.workspace ? h('span', { className: 'roko-merge-line roko-muted' }, `in ${clip(delivered.workspace, 80)}`) : null,
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

// ---------------------------------------------------------------------------
// A run: hero, why, now, the graph and its inspector, activity, changes
// ---------------------------------------------------------------------------

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

/** A live clock as a display: ticking while the run goes, fixed once it ended. */
function ClockDots({ startMs, endMs, fixedMs, live, size = 'L', label }) {
  const now = useTick(Boolean(live))
  let ms = num(fixedMs)

  if (live && num(startMs) !== null) {
    ms = Math.max(0, now - startMs)
  } else if (ms === null && num(startMs) !== null && num(endMs) !== null) {
    ms = Math.max(0, endMs - startMs)
  }

  return h(Dots, { label: `${label ?? 'elapsed'} ${ms === null ? 'unknown' : clockFace(ms)}`, size, tone: live ? 'agent' : 'on', value: ms === null ? '-:--' : clockFace(ms) })
}

/** The router's latest pick for a running task, from the card (attempt_log) or the run's loop events. */
function latestRoute(run, live) {
  const fromLoops = [...live.loops].reverse().find(l => (l.kind === 'route' || l.kind === 'failover') && text(l.data?.model))

  if (fromLoops) {
    return { ...fromLoops.data, task_id: fromLoops.task_id }
  }

  for (const task of list(run.tasks).filter(isRecord).reverse()) {
    const route = [...list(task.attempt_log).filter(isRecord)].reverse().find(a => isRecord(a.route))?.route

    if (route) {
      return { ...route, task_id: text(task.task_id) }
    }
  }

  return null
}

/**
 * The run's display bar: one strip of glass with its numbered modules in dot-matrix (01 tasks, 02 time,
 * 03 spend, 04 checks, 05 model) and the scope on the right.
 */
function DisplayBar({ run, live }) {
  const active = isActiveRun(run)
  const progress = progressOf(run)
  const startMs = parseTime(run.started_at) ?? parseTime(run.hermes_started_at)
  const endMs = parseTime(run.finished_at)
  const cost = num(run.cost_usd)
  const cap = num(run.max_usd)
  const fraction = doneFraction(progress)
  const projected = active && cost !== null && fraction >= 0.15 ? cost / fraction : null
  const gates = isRecord(run.gates) ? run.gates : null
  const passed = num(gates?.passed) ?? 0
  const failed = num(gates?.failed) ?? 0
  const gateTotal = gates ? (num(gates.total) ?? passed + failed) : 0
  const models = modelsOf(run)
  const eta = num(run.eta_minutes)
  const route = latestRoute(run, live)
  const ratio = cost !== null && cap ? cost / cap : null
  const spendTone = ratio === null ? 'on' : ratio >= 0.95 ? 'fail' : ratio >= 0.8 ? 'you' : 'on'

  return h(
    'div',
    { className: 'rk-display', 'data-state': text(run.state), 'data-testid': 'display' },
    h(
      Well,
      { className: 'rk-display-well' },
      progress.total
        ? h(
            'div',
            { className: 'rk-cell', 'data-testid': 'instrument-tasks' },
            h(ModLabel, { n: 1 }, 'tasks'),
            h('div', { className: 'rk-cell-row' }, h(ProgressRing, { label: false, progress, size: 30, stroke: 4 }), h(Dots, { hidden: true, size: 'L', value: `${progress.passed}/${progress.total}` })),
            h(
              'span',
              { className: 'rk-cell-sub' },
              waitsOnYou(run) ? h('span', { 'data-channel': 'you', 'data-testid': 'instrument-waiting' }, 'waiting on you') : null,
              progress.running && !waitsOnYou(run)
                ? run.state === 'last_seen'
                  ? h('span', null, `${progress.running} was running`)
                  : h('span', { 'data-channel': 'agent' }, `${progress.running} running`)
                : null,
              progress.failed ? h('span', { 'data-channel': 'fail' }, `${progress.failed} failed`) : null,
              progress.blocked ? h('span', { 'data-channel': 'you' }, `${progress.blocked} blocked`) : null,
              !progress.running && !progress.failed && !progress.blocked ? h('span', null, `${progress.passed} passed`) : null,
              progress.stopped && hasEnded(run) ? h('span', null, `${progress.stopped} stopped`) : null,
              progress.skipped ? h('span', null, `${progress.skipped} skipped`) : null
            )
          )
        : null,
      h(
        'div',
        { className: 'rk-cell', 'data-testid': 'instrument-time' },
        h(ModLabel, { n: 2 }, active ? 'time' : 'took'),
        notStarted(run)
          ? h(Dots, { label: 'starting', size: 'L', tone: 'agent', value: '-:--' })
          : h(ClockDots, { endMs, fixedMs: active ? null : run.duration_ms, label: active ? 'elapsed' : 'took', live: active && run.state === 'running', startMs }),
        notStarted(run)
          ? h('span', { className: 'rk-cell-sub', 'data-testid': 'instrument-starting' }, 'starting…')
          : active && eta !== null
            ? h('span', { className: 'rk-cell-sub', 'data-testid': 'instrument-eta' }, eta < 1 ? '<1 min left' : `~${Math.round(eta)} min left`)
            : h('span', { className: 'rk-cell-sub' }, startMs ? `from ${clock(startMs).slice(0, 5)}` : '')
      ),
      h(
        'div',
        { className: 'rk-cell rk-cell-spend', 'data-testid': 'instrument-spend' },
        h(ModLabel, { n: 3 }, 'spend'),
        h(Dots, { label: `spent ${money(cost)}`, size: 'L', tone: spendTone, value: money(cost) }),
        h(CostMeter, { cap: run.max_usd, projected, spent: cost })
      ),
      gateTotal
        ? h(
            'div',
            { className: 'rk-cell', 'data-testid': 'instrument-checks' },
            h(ModLabel, { n: 4 }, 'checks'),
            h(Dots, { label: `${passed} of ${gateTotal} checks passed`, size: 'L', tone: failed ? 'fail' : passed ? 'pass' : 'on', value: `${passed}/${gateTotal}` }),
            // `gates` counts each task's final attempt; `retried` the earlier attempts' checks that did not pass, so
            // roko tried again (0.5.0): a retry that passed is not a failure.
            h(
              'span',
              { className: 'rk-cell-sub' },
              failed ? `${failed} did not pass` : 'passed',
              num(gates?.retried) ? h('span', { 'data-testid': 'checks-retried' }, ` · ${num(gates.retried)} retried`) : null
            )
          )
        : null,
      models.length || route
        ? h(
            'div',
            { className: 'rk-cell rk-cell-model', 'data-testid': 'instrument-model' },
            h(ModLabel, { n: 5 }, models.length > 1 ? 'models' : 'model'),
            h('span', { className: 'rk-cell-model-name', title: models.join(' · ') }, clip(text(route?.model) || models[0], 24)),
            route
              ? h(
                  'span',
                  { className: 'rk-cell-sub' },
                  h('span', { 'data-channel': routeView(route).decider === 'failover' ? 'fail' : 'agent' }, routeView(route).word || 'router'),
                  routeView(route).scored && num(route.p) !== null && route.p < 1 ? ` · p ${route.p.toFixed(2)}` : '',
                  models.length > 1 ? ` · +${models.length - 1}` : ''
                )
              : models.length > 1
                ? h('span', { className: 'rk-cell-sub' }, `+${models.length - 1} more`)
                : null
          )
        : null,
      h('div', { className: 'rk-cell rk-cell-scope' }, h(ModLabel, { n: 6 }, 'pulse'), h(Scope, { height: 34, runId: run.run_id, width: 100 }))
    )
  )
}

function RunHero({ run, actions, live }) {
  // A plan run started without a title is named by its plan's slug: show the plan's own title.
  const slugOnly = run.kind === 'plan' && text(run.label) === text(run.plan_id)
  const plan = usePlan(slugOnly ? text(run.plan_id) : null)
  const title = slugOnly && text(plan.data?.title) ? text(plan.data.title) : text(run.label) || text(run.run_id)
  const active = isActiveRun(run)
  const request = text(run.request)
  const showRequest = request && clip(request, 118) !== clip(run.label, 118)
  const fresh = isFresh(run.run_id)
  const info = runInfo(run)
  const forYou = waitsOnYou(run)

  return h(
    'header',
    { className: 'roko-hero', 'data-state': text(run.state), 'data-waiting': forYou ? 'true' : undefined },
    h(
      'div',
      { className: 'roko-hero-top' },
      h(Dot, { pulse: active, tone: forYou ? 'warn' : info.tone }),
      h(StatePill, { run }),
      forYou ? h('span', { className: 'rk-tag', 'data-channel': 'you', 'data-testid': 'hero-waiting' }, 'waiting on you') : null,
      h(KindBadge, { kind: run.kind }),
      h(CopyId, { label: 'Copy run id', shown: text(run.run_id).slice(0, 8), value: run.run_id }),
      notStarted(run)
        ? h('span', { className: 'roko-muted' }, 'starting…')
        : run.started_at || run.hermes_started_at
          ? h('span', { className: 'roko-muted' }, `started ${agoText(run.started_at || run.hermes_started_at)}`)
          : null,
      run.resumed ? h('span', { className: 'roko-kind' }, 'resumed') : null,
      h('span', { className: 'roko-flex' }),
      actions ?? null
    ),
    h('h2', { className: 'roko-hero-title' }, fresh && !reducedMotion() ? h(DecodeText, { 'aria-label': title, text: title }) : title),
    slugOnly ? h('div', { className: 'roko-hero-slug' }, h(Codicon, { name: 'list-tree', size: '0.72rem' }), text(run.plan_id)) : null,
    showRequest ? h('p', { className: 'roko-hero-request' }, h(Codicon, { name: 'quote', size: '0.75rem' }), clip(request, 280)) : null,
    h(DisplayBar, { live, run }),
    run.headline ? h('div', { className: 'roko-headline' }, text(run.headline)) : null
  )
}

const WHY_TITLES = {
  cancelled: 'Why it stopped',
  failed: 'Why it did not pass',
  interrupted: 'roko stopped mid-run',
  missing: 'roko has no record of this run',
  unverified: 'Why it is unverified'
}
/** What an interrupted run leaves: roko sets its checkout aside, and a new run starts clean. */
const INTERRUPTED_NEXT = 'What it did so far is kept on its own branch. Run it again to start from a clean checkout.'

/** For a run that ended without success: roko's reason in one paragraph, and the task to look at. */
function WhyCallout({ run, onInspect }) {
  const state = text(run.state)
  const planGroup = usePlanGroup(isRecord(run.why) && isRecord(run.why.validation) ? text(run.plan_id) : '')
  const why = isRecord(run.why) ? run.why : null
  const problems = list(run.problems).map(text).filter(Boolean)
  const summary = state === 'interrupted' ? interruptedReason(run) : text(why?.summary) || (state === 'missing' ? problems[0] : '')

  if (isActiveRun(run) || state === 'succeeded' || !summary) {
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
      said ? h('p', { className: 'roko-why-text' }, said) : null,
      validation ? h(ValidationItems, { validation }) : null,
      validation ? h(ValidationStep, { group: planGroup, planId: text(run.plan_id), validation }) : null,
      state === 'interrupted' ? h('p', { className: 'roko-why-text', 'data-testid': 'why-next' }, INTERRUPTED_NEXT) : null,
      target && onInspect
        ? h(Button, { onClick: () => onInspect(target), size: 'xs', type: 'button', variant: 'outline' }, h(Codicon, { name: 'search', size: '0.75rem' }), `Inspect ${clip(target, 20)}`)
        : null
    )
  )
}

/** While a run goes: what each running task is doing, with a ticking clock. */
function NowStrip({ run, nodes, onInspect }) {
  const running = [...nodes.values()].filter(node => node.state === 'running')
  const forYou = waitsOnYou(run) || running.some(node => node.waiting)
  const checking = checkingOf(run)

  if (!isActiveRun(run)) {
    return null
  }

  return h(
    'div',
    { 'aria-live': 'polite', className: 'roko-now', 'data-testid': 'now-strip' },
    h('span', { className: 'roko-now-label', 'data-channel': forYou ? 'you' : undefined }, h(Dot, { pulse: true, tone: forYou ? 'warn' : 'live' }), 'Now'),
    running.length
      ? running.slice(0, 3).map(node =>
          h(
            'button',
            { className: 'roko-now-item', 'data-channel': node.waiting ? 'you' : 'agent', key: node.id, onClick: () => onInspect?.(node.id), type: 'button' },
            h('span', { className: 'roko-node-id' }, clip(node.taskId, 12)),
            h('span', { className: 'roko-now-title' }, clip(node.title, 38)),
            h('span', { className: 'roko-now-step' }, stepWords(node)),
            h(StepClock, { since: node.stepSince })
          )
        )
      : checking && !list(run.waiting).length
        ? h(
            'span',
            { className: 'roko-now-idle', 'data-channel': 'agent', 'data-testid': 'now-checking' },
            checking.text,
            checking.since ? h(Fragment, null, ' · ', h(StepClock, { since: checking.since })) : null
          )
        : h(
            'span',
            { className: 'roko-now-idle', 'data-channel': forYou && run.state !== 'queued' ? 'you' : undefined },
            run.state === 'queued'
              ? `queued${num(run.position) !== null ? ` · position ${run.position}` : ''}`
              : notStarted(run)
                ? 'starting… roko gets the run ready'
                : list(run.waiting).length
                  ? 'waiting on you'
                  : 'between tasks…'
          ),
    running.length > 3 ? h('span', { className: 'roko-muted' }, `+${running.length - 3} more`) : null
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
function RunOverview({ run, events, eventsError, eventsLoading, inspect, setInspect, onView, live }) {
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
    { className: 'roko-overview' },
    tasks.length
      ? h(
          'div',
          { className: 'roko-graph-card' },
          h(
            'div',
            { className: 'roko-graph-head' },
            h(ModLabel, { n: 7 }, 'sequencer'),
            h('span', { className: 'roko-graph-title' }, single ? 'one task' : `${plural(tasks.length, 'task')} · ${plural(graph.waves.length, 'wave')}`),
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
              : h('div', { className: 'roko-graph-hint' }, h(Codicon, { name: 'info', size: '0.75rem' }), 'Select a pad to see its attempts, its route, what its agent is doing and what it said.')
        )
      : h(
          'div',
          { className: 'roko-graph-card roko-graph-empty' },
          active ? h(Loader, { className: 'rk-loader', label: 'Setting the run up', type: 'rose-curve' }) : null,
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

function RunTabs({ view, onView, run, eventCount, loopCount }) {
  const d = isRecord(run.delivered) ? run.delivered : null
  const tabs = [
    ['overview', 'Overview', null],
    ['activity', 'Activity', eventCount ? String(eventCount) : null],
    ['loops', 'Loops', loopCount ? String(loopCount) : null],
    ['changes', 'Changes', d && !isActiveRun(run) ? text(d.diffstat).match(/(\d+) file/)?.[1] ?? '' : null]
  ]

  return h(
    'div',
    { 'aria-label': 'Run views', className: 'roko-runtabs', role: 'tablist' },
    tabs.map(([id, label, count], i) =>
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
        h('span', { 'aria-hidden': 'true', className: 'roko-runtab-n' }, `0${i + 1}`),
        label,
        count ? h('span', { className: 'roko-runtab-count' }, count) : null
      )
    ),
    h('span', { className: 'roko-flex' }),
    h('span', { className: 'roko-runtabs-hint' }, h(Kbd, { size: 'sm', variant: 'ghost' }, '['), h(Kbd, { size: 'sm', variant: 'ghost' }, ']'))
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

  return h(
    'div',
    { className: 'roko roko-card roko-run', 'data-compact': compact ? 'true' : undefined, 'data-testid': `run-card-${text(row.run_id)}` },
    h(
      'div',
      { className: 'roko-run-head' },
      h(StatePill, { run: row }),
      h('span', { className: 'roko-run-title' }, text(row.label) || text(row.run_id)),
      h(KindBadge, { kind: row.kind })
    ),
    h(
      'div',
      { className: 'roko-stats' },
      h('span', { className: 'roko-stat' }, h('span', { className: 'roko-stat-label' }, 'cost'), h(CostMeter, { cap: row.max_usd, compact, spent: row.cost_usd })),
      row.started_at ? h('span', { className: 'roko-stat' }, h('span', { className: 'roko-stat-label' }, 'started'), agoText(row.started_at)) : null
    ),
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
      h(CopyId, { label: 'Copy run id', shown: text(run.run_id).slice(0, 8), value: run.run_id }),
      blocked && isRecord(run.next) && text(run.next.label) ? h('span', { className: 'roko-flex' }) : null,
      blocked && isRecord(run.next) && text(run.next.label) ? h(NextKey, { onView: () => undefined, run, view: null }) : null
    ),
    h('h2', { className: 'roko-hero-title' }, isFresh(run.run_id) && !reducedMotion() ? h(DecodeText, { 'aria-label': text(run.label) || 'A plan', text: text(run.label) || 'A plan' }) : text(run.label) || 'A plan'),
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
    !active && validId(planId) && run.state === 'succeeded' ? h(PlanDetail, { planId }) : null
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
  let body

  if (view === 'activity') {
    body = h(ActivityFeed, { active, error: eventsError, events: events.events, loading: events.loading, startMs: parseTime(run.started_at) ?? eventSpan(events.events)?.start ?? null })
  } else if (view === 'changes') {
    body = h(DiffViewer, { run })
  } else if (view === 'loops') {
    body = h(LoopsPanel, { events: loops, run, scope: 'run' })
  } else {
    body = h(RunOverview, { events: events.events, eventsError, eventsLoading: events.loading, inspect, live, onView, run, setInspect })
  }

  return h(
    'div',
    { className: 'roko roko-card roko-run roko-mission', 'data-state': text(run.state), 'data-testid': `run-card-${text(run.run_id)}` },
    h(RunHero, {
      actions: active
        ? h(CancelRun, { run, size: 'xs' })
        : isRecord(run.next) && (text(run.next.action) || text(run.next.label))
          ? h(NextKey, { onView, run, view })
          : isRecord(run.delivered) && run.delivered.merged !== true && view !== 'changes'
            ? h(MergeControls, { compact: true, run })
            : null,
      live,
      run
    }),
    active ? h(Ticker, { live, run }) : null,
    run.state === 'last_seen' ? h(LastKnownNote, { run }) : null,
    query.error && run.state !== 'last_seen' ? h(ErrorNote, { compact: true, error: query.error, lastChecked: query.dataUpdatedAt, onRetry: () => void query.refetch() }) : null,
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
    // A last-seen run's sign-offs are only what roko last said: an answer needs roko, so they wait with it.
    waiting.length && run.state !== 'last_seen'
      ? h(
          'div',
          { className: 'roko-waiting-block' },
          h(SectionLabel, null, `Waiting on you (${waiting.length})`),
          waiting.map(item => h(PendingCard, { compact: true, item, key: text(item.code) || text(item.decision_id) }))
        )
      : null,
    h(RunTabs, { eventCount: events.events.length, loopCount: loops.length, onView, run, view }),
    h('div', { className: 'roko-runbody', 'data-view': view, role: 'tabpanel' }, body),
    h(
      'div',
      { className: 'roko-run-foot' },
      h('span', { className: 'roko-muted roko-mono' }, text(run.run_id)),
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
}

/**
 * The run as a strip-sized instrument for chat: a light, the title, the sequencer in miniature, spend on the
 * glass, and the agent's ticker; once it ends, the verdict, what changed, and the review key.
 */
function RunCardCompact({ runId, onExpand, fallback }) {
  const query = useRun(runId)
  const reachable = useReachable()
  const run = lastKnown(query.data, reachable)
  const live = useLive(runId)
  const { canAct } = useLimits()
  const demo = useDemoRun(run, Boolean(run) && !isActiveRun(run) && isRecord(run.delivered))

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

  const active = isActiveRun(run)
  const waiting = list(run.waiting).filter(isRecord)
  const progress = progressOf(run)
  const d = isRecord(run.delivered) ? run.delivered : null
  const why = run.state === 'interrupted' ? interruptedReason(run) : isRecord(run.why) ? text(run.why.summary) : ''
  const startMs = parseTime(run.started_at)
  const info = runInfo(run)
  const forYou = waitsOnYou(run)

  return h(
    'div',
    { className: 'roko roko-card roko-run roko-cc', 'data-compact': 'true', 'data-state': text(run.state), 'data-testid': `run-card-${text(run.run_id)}` },
    h(
      'div',
      { className: 'roko-cc-head' },
      h(Dot, { pulse: active, tone: forYou ? 'warn' : info.tone }),
      h(StatePill, { run }),
      h('span', { className: 'roko-run-title' }, text(run.label) || text(run.run_id)),
      h(Well, { className: 'rk-cc-spend' }, h(Dots, { hidden: true, size: 'M', tone: 'on', value: money(run.cost_usd) }), h(CostMeter, { cap: run.max_usd, compact: true, spent: run.cost_usd }))
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
            h(StepStrip, { max: 24, progress, waiting: forYou }),
            h(
              'span',
              { className: 'roko-cc-stats' },
              progress.total ? `${progress.passed}/${plural(progress.total, 'task')} passed` : 'no tasks yet',
              ' · ',
              h(Clock, { fixedMs: active ? null : run.duration_ms, live: active && run.state === 'running', startMs })
            )
          )
        ),
    active && run.kind !== 'plan_generate' ? h(Ticker, { compact: true, live, run }) : null,
    !active && d
      ? h(
          'div',
          { className: 'roko-cc-delivered' },
          h(Codicon, { name: 'git-branch', size: '0.75rem' }),
          text(d.diffstat) || clip(d.branch, 60),
          h('span', { className: d.merged ? 'roko-tone-good' : 'roko-muted' }, d.merged ? ' · merged' : demo ? ' · demo output, stays on its branch' : ' · not merged')
        )
      : null,
    !active && why && run.state !== 'succeeded' ? h('div', { className: 'roko-cc-why' }, clip(why, 220)) : null,
    h(
      'div',
      { className: 'roko-actions roko-actions-start' },
      waiting.length
        ? h('span', { className: 'rk-tag rk-tag-you', 'data-channel': 'you', 'data-testid': 'cc-waiting' }, h(LED, { blink: active ? 'fast' : undefined, size: 's', tone: 'you' }), `${waiting.length} waiting on you`)
        : null,
      onExpand ? h(Button, { onClick: onExpand, size: 'xs', type: 'button', variant: 'outline' }, 'Details') : null,
      // The backend's one next step when it sends one (0.5.0); else the review key as before.
      !active && run.kind !== 'plan_generate' && isRecord(run.next) && text(run.next.action)
        ? h(
            Key,
            {
              onClick: () => openRoko({ run: run.run_id, view: ['merge', 'review', 'commit-roko-toml'].includes(text(run.next.action)) ? 'changes' : 'overview' }),
              size: 's',
              testId: 'cc-next',
              title: text(run.next.why) || undefined,
              tone: 'primary'
            },
            h(Codicon, { name: text(run.next.action) === 'rerun' ? 'debug-restart' : 'git-compare', size: '0.75rem' }),
            text(run.next.label) || NEXT_LABELS[text(run.next.action)] || 'open'
          )
        : !active && d && run.kind !== 'plan_generate'
          ? h(
              Key,
              { onClick: () => openRoko({ run: run.run_id, view: 'changes' }), size: 's', tone: 'primary' },
              h(Codicon, { name: 'git-compare', size: '0.75rem' }),
              d.merged || !canAct || demo || run.state === 'interrupted' || run.merge?.available === false || run.merge?.demo === true ? 'Review changes' : 'Review & merge'
            )
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
// Waiting items: a decision with two keys, Approve and Reject (POST /decide)
// ---------------------------------------------------------------------------

/** "REPORT.md:\n…" summaries name the file they show: split that off as the document's tab. */
function documentOf(summary) {
  const s = text(summary)
  const m = /^([\w./-]{1,80}\.[A-Za-z0-9]{1,8}):\n/.exec(s)

  return m ? { body: s.slice(m[0].length), name: m[1] } : { body: s, name: null }
}

/** roko's deadline for a held sign-off, on the glass: when it passes, the task ends unverified. */
function DeadlineWell({ deadline }) {
  const at = parseTime(deadline)
  const now = useNow(1_000)

  if (at === null) {
    return null
  }

  const left = Math.round((at - now) / 1000)

  if (left <= 0) {
    return h('span', { className: 'roko-countdown', 'data-tone': 'bad' }, 'deadline passed')
  }

  const face = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`

  return h(
    Tip,
    { label: `roko stops waiting at ${clock(at)}; the task then ends unverified` },
    h(
      'span',
      { className: 'roko-countdown rk-deadline', 'data-tone': left <= 60 ? 'bad' : left <= 300 ? 'warn' : 'muted' },
      h(Well, { className: 'rk-deadline-well' }, h(Dots, { hidden: true, size: 'M', tone: left <= 60 ? 'fail' : 'you', value: face })),
      h('span', { className: 'rk-deadline-text' }, `${face} left`)
    )
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
      'data-testid': `pending-${code}`
    },
    h(
      'div',
      { className: 'roko-pending-head' },
      h(LED, { blink: decided ? undefined : 'fast', tone: decided ? (result.tone === 'good' ? 'pass' : 'off') : 'you' }),
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
      !effect ? h(DeadlineWell, { deadline: item.deadline_at }) : null,
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
              { className: 'rk-decide-key', disabled: Boolean(busy), onClick: () => void decide(false), size: 'l' },
              busy === 'reject' ? h(Spinner, null) : h(Codicon, { name: 'close', size: '0.8rem' }),
              'Reject'
            ),
            h(
              Key,
              { className: 'rk-decide-key roko-approve', disabled: Boolean(busy), onClick: () => void decide(true), size: 'l', tone: 'primary' },
              busy === 'approve' ? h(Spinner, null) : h(Codicon, { name: 'check', size: '0.8rem' }),
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

function RunPlan({ plan, size = 'sm', label = 'Run plan…' }) {
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
      h(Codicon, { name: 'play', size: '0.8rem' }),
      label
    ),
    blocking
      ? h('div', { className: 'rk-blocked' }, h(ProblemCard, { compact: size === 'xs', lead: 'Plans can’t run from Hermes until this is fixed:', problem: blocking }))
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
          // Questions roko's planner left open on the task (0.5.0): roko runs the plan only once they are answered.
          questions: list(task.open_questions).filter(isRecord).length,
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
      waves.length
        ? h(
            'span',
            { className: 'roko-stat', title: waves.length > 1 ? 'each wave waits for the one before' : undefined },
            h('span', { className: 'roko-strong' }, String(waves.length)),
            waves.length === 1 ? ' wave' : ' waves',
            waves.length > 1 && !compact ? h('span', { className: 'roko-muted' }, ' · each wave waits for the one before') : null
          )
        : null,
      waves.length
        ? h(
            'span',
            { className: 'roko-stat', 'data-testid': 'plan-parallel', title: atOnce(waves, plan.max_parallel) > 1 ? `${atOnce(waves, plan.max_parallel)} tasks side by side at most` : undefined },
            parallelWords(waves, plan.max_parallel)
          )
        : null,
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
    h(PlanValidationNote, { plan }),
    h(
      'div',
      { className: 'roko-actions roko-actions-start' },
      h(RunPlan, { plan, size: compact ? 'xs' : 'sm' }),
      compact ? h(Button, { onClick: () => openRoko({ plan: plan.plan_id }), size: 'xs', type: 'button', variant: 'ghost' }, 'Open in roko') : null
    )
  )
}

/**
 * Why roko will not run this plan yet (`validation`, 0.5.0): roko's words, and the questions its planner left open
 * on a task with the answer it suggested. They are answered in the plan's tasks.toml; `roko plan validate` says what
 * is left.
 */
function PlanValidationNote({ plan, validation = null }) {
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
      h(ValidationItems, { validation: v }),
      h(ValidationStep, { group: text(plan.group), planId: text(plan.plan_id) || text(plan.id), validation: v })
    )
  )
}

/**
 * What roko's validator found, one line each: roko's own words for each error (the open-questions rule is said by
 * the questions themselves), then each open question with the answer the planner suggested.
 */
function ValidationItems({ validation }) {
  const questions = list(validation.open_questions).filter(isRecord)
  const errors = list(validation.errors).filter(e => isRecord(e) && text(e.message) && !(questions.length && text(e.rule) === 'PLAN_045'))

  if (!questions.length && !errors.length) {
    return h('p', { className: 'roko-why-text' }, clip(validation.summary, 600))
  }

  return h(
    'ul',
    { className: 'rk-plan-questions', 'data-testid': 'validation-items' },
    errors.slice(0, 6).map((e, i) =>
      h(
        'li',
        { 'data-kind': 'error', key: `e${i}` },
        text(e.task_id) ? h('b', null, `${clip(e.task_id, 16)} `) : null,
        clip(e.message, 300),
        text(e.rule) ? h('span', { className: 'roko-muted' }, ` · ${clip(e.rule, 24)}`) : null
      )
    ),
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

// ---------------------------------------------------------------------------
// The five loops: the dial, each ring's latest events and state, the feed
// ---------------------------------------------------------------------------

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
 * One learning loop's audit, worded: its name, its state ("on probation", "proven: its learning is in use",
 * "flagged: no chance to act yet", "demoted: roko uses its default"), the holdout (`h`: the share of decisions kept
 * on roko's default, to measure what the loop adds), its reach (`eps`: the share of decisions its learning changed)
 * and how many decisions it saw.
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

// roko's check rungs by number, as roko numbers them (roko_gate::Rung::as_index; 1000 is the plan's own check and
// 1001 the post-merge regression check): adaptive thresholds and retry budgets name them so. The same as the dashboard.
const RUNG_NAMES = { 0: 'compile', 1: 'lint', 2: 'test', 3: 'symbol', 4: 'gen-test', 5: 'prop-test', 6: 'integration', 1000: 'whole-plan', 1001: 'post-merge' }

/** A check rung's name: roko's own, else from its number. */
const rungName = r => {
  const name = text(r?.name)
  const rung = r?.rung

  return name || (num(rung) !== null ? RUNG_NAMES[num(rung)] ?? `rung ${rung}` : /^\d+$/.test(text(rung)) ? RUNG_NAMES[Number(rung)] ?? `rung ${text(rung)}` : clip(rung, 22) || 'a check')
}

/** A check's retry budget: "up to 1 retry · passes 92%", or that roko skips retrying it. */
function retryBudgetWords(budget) {
  const n = num(budget.suggested_max_retries)

  return (
    [
      budget.should_skip === true ? 'no retries: it rarely passes on a retry' : n === null ? null : n === 0 ? 'no retries' : `up to ${plural(n, 'retry', 'retries')}`,
      num(budget.ema_pass_rate) !== null ? `passes ${pct(budget.ema_pass_rate)}` : null
    ]
      .filter(Boolean)
      .join(' · ') || '—'
  )
}

/** What roko reports for a ring (GET /loops), as a few short facts; a run's own thresholds stand in for L3's. */
function ringFacts(ring, run) {
  const id = text(ring?.ring)
  const facts = []

  if (!isRecord(ring)) {
    return facts
  }

  if (id === 'L0') {
    const counts = isRecord(ring.counts) ? ring.counts : {}

    facts.push({ channel: num(counts.held) ? 'you' : 'ink', text: `${num(counts.held) ?? 0} held for you` })
    facts.push({ channel: num(counts.withheld) ? 'fail' : 'ink', text: `${plural(num(counts.withheld) ?? 0, 'result')} withheld` })
  } else if (id === 'L1') {
    list(ring.routes)
      .filter(isRecord)
      .slice(0, 3)
      .forEach(route =>
        facts.push({
          channel: route.outcome === false ? 'fail' : route.outcome === true ? 'pass' : 'agent',
          ratio: num(route.p),
          text: `${clip(route.task_id, 10) || '·'} → ${clip(route.model, 22)} · ${routeRowWords(route)}`
        })
      )
    list(ring.retry_budgets)
      .filter(isRecord)
      .slice(0, 2)
      .forEach(budget =>
        facts.push({ channel: 'ink', ratio: num(budget.ema_pass_rate), text: `${rungName(budget)} ${retryBudgetWords(budget)}` })
      )
  } else if (id === 'L2') {
    list(ring.diagnoses)
      .filter(isRecord)
      .slice(0, 3)
      .forEach(d => facts.push({ channel: /warn|error|crit/i.test(text(d.severity)) ? 'fail' : 'ink', text: `${clip(d.source, 18)} · ${clip(d.subject, 24)} · ${clip(d.detail, 90)}` }))
  } else if (id === 'L3') {
    const thresholds = list(run?.thresholds).filter(isRecord).length ? list(run.thresholds) : list(ring.thresholds)

    list(ring.models)
      .filter(isRecord)
      .slice(0, 3)
      .forEach(m => facts.push({ channel: 'pass', ratio: num(m.success_rate), text: `${clip(m.model, 22)} · passes ${pct(m.success_rate)} of ${plural(num(m.tasks) ?? 0, 'task')}` }))
    thresholds
      .filter(isRecord)
      .slice(0, 3)
      .forEach(t =>
        facts.push({
          channel: 'ink',
          ratio: num(t.ema_pass_rate),
          text: `${rungName(t)} check · passes ${pct(t.ema_pass_rate)}${num(t.observations) !== null ? ` · ${plural(num(t.observations), 'run')} seen` : ''}${t.shift ? ' · moved' : ''}`
        })
      )

    const knowledge = isRecord(ring.knowledge) ? ring.knowledge : {}
    const playbooks = isRecord(ring.playbooks) ? ring.playbooks : {}

    facts.push({ channel: 'ink', text: `${plural(num(knowledge.total) ?? 0, 'knowledge entry', 'knowledge entries')} · ${plural(num(playbooks.total) ?? 0, 'playbook')}` })
  } else if (id === 'L4') {
    list(ring.loops)
      .filter(isRecord)
      .slice(0, 4)
      .forEach(loop =>
        facts.push({
          channel: healthChannel(text(loop.state)),
          text: `${LOOP_NAMES[text(loop.loop_id)] ?? (clip(loop.loop_id, 18) || 'a loop')} ${loopHealthWords(loop)}`
        })
      )
  }

  return facts
}

/** One loop: its light, name and clock, its count on the glass, its latest events, and roko's numbers. */
function RingRow({ meta, events, ring, run, now }) {
  const mine = events.filter(e => e.ring === meta.ring)
  const latest = mine[mine.length - 1]
  const age = latest ? now - (latest.ts ?? 0) : Infinity
  const facts = ringFacts(ring, run)
  const active = age < 600_000 || ring?.state === 'active'

  return h(
    'div',
    { className: 'rk-ring', 'data-active': active ? 'true' : undefined, 'data-ring': meta.ring, 'data-testid': `ring-${meta.ring}` },
    h(
      'div',
      { className: 'rk-ring-head' },
      h(LED, { blink: age < 8_000 ? 'slow' : undefined, tone: latest && active ? loopChannel(latest) : 'off' }),
      h('span', { className: 'rk-ring-id' }, meta.ring),
      h('span', { className: 'rk-ring-name' }, meta.name),
      h('span', { className: 'rk-ring-clock' }, meta.clock),
      h('span', { className: 'roko-flex' }),
      h(Well, { className: 'rk-ring-count' }, h(Dots, { label: `${plural(mine.length, 'event')} on ${meta.ring}`, size: 'S', tone: mine.length ? 'on' : 'off', value: String(mine.length).padStart(2, '0') }))
    ),
    mine.length
      ? h(
          'div',
          { className: 'rk-ring-events' },
          mine
            .slice(-2)
            .reverse()
            .map(event =>
              h(
                'div',
                { className: 'rk-ring-event', 'data-channel': loopChannel(event), key: event.key },
                h('span', { className: 'rk-tag', 'data-channel': loopChannel(event) }, KIND_WORDS[event.kind] ?? clip(event.kind, 12)),
                h('span', { className: 'rk-ring-text' }, event.text || KIND_WORDS[event.kind] || event.kind),
                h('span', { className: 'rk-ring-age' }, event.ts ? ago(event.ts, now) : '')
              )
            )
        )
      : h('div', { className: 'rk-ring-quiet' }, 'quiet'),
    facts.length
      ? h(
          'div',
          { className: 'rk-ring-facts' },
          facts.map((fact, i) =>
            h(
              'div',
              { className: 'rk-fact', 'data-channel': fact.channel, key: i },
              num(fact.ratio) !== null ? h('span', { 'aria-hidden': 'true', className: 'rk-fact-bar' }, h('i', { style: { width: `${Math.round(clamp(fact.ratio, 0, 1) * 100)}%` } })) : h('span', { 'aria-hidden': 'true', className: 'rk-fact-dot' }),
              h('span', { className: 'rk-fact-text' }, fact.text)
            )
          )
        )
      : null
  )
}

/** Every loop event, newest first, with its ring and kind; on the Loops tab each links to its run. */
function LoopFeed({ events, max = 40, withRuns }) {
  const rows = events.slice(-max).reverse()

  if (!rows.length) {
    return null
  }

  return h(
    FadeScroll,
    { className: 'rk-loopfeed', maxHeight: '360px' },
    h(
      'div',
      { 'aria-label': 'Loop events', role: 'list' },
      rows.map(event =>
        h(
          'div',
          { className: 'rk-loopfeed-row', 'data-channel': loopChannel(event), key: event.key, role: 'listitem' },
          h('span', { className: 'rk-loopfeed-time' }, event.ts ? clock(event.ts) : ''),
          h('span', { className: 'rk-tag rk-tag-ring', 'data-channel': loopChannel(event) }, event.ring),
          h('span', { className: 'rk-tag', 'data-channel': 'ink' }, KIND_WORDS[event.kind] ?? clip(event.kind, 12)),
          h('span', { className: 'rk-loopfeed-text' }, event.text || event.kind),
          withRuns && validId(event.run_id)
            ? h('button', { className: 'roko-link', onClick: () => openRoko({ run: event.run_id, view: 'loops' }), type: 'button' }, 'run')
            : null
        )
      )
    )
  )
}

/**
 * The Loops instrument: the dial on the left, the five rings on the right, the feed under them. `scope` is
 * 'run' (a run's own events) or 'all' (everything this window heard, and what roko reports for each ring).
 */
function LoopsPanel({ events, run, scope }) {
  const loops = useLoops(true)
  const now = useNow(5_000)
  const rings = list(loops.data?.rings).filter(isRecord)
  const ringOf = id => rings.find(r => r.ring === id) ?? null
  const shown = events.filter(e => RING_IDS.includes(e.ring))

  return h(
    'div',
    { className: 'rk-loops', 'data-scope': scope, 'data-testid': 'loops' },
    h(
      'div',
      { className: 'rk-loops-top' },
      h(
        'div',
        { className: 'rk-loops-dialcol' },
        h(Dial, { events: shown, label: `${plural(shown.length, 'loop event')} on five rings`, now }),
        h(
          'div',
          { className: 'rk-dial-legend' },
          [
            ['agent', 'working'],
            ['you', 'needs you'],
            ['pass', 'learned · passed'],
            ['fail', 'went wrong']
          ].map(([channel, word]) => h('span', { 'data-channel': channel, key: channel }, h('i', null), word))
        )
      ),
      h(
        'div',
        { className: 'rk-loops-rings' },
        RINGS.map(meta => h(RingRow, { events: shown, key: meta.ring, meta, now, ring: ringOf(meta.ring), run }))
      )
    ),
    loops.error ? h(ErrorNote, { compact: true, error: loops.error, onRetry: () => void loops.refetch() }) : null,
    list(loops.data?.problems).length
      ? h('div', { className: 'roko-muted rk-loops-problems' }, `roko could not answer: ${list(loops.data.problems).map(p => clip(isRecord(p) ? p.part || p.message : p, 40)).join(' · ')}`)
      : null,
    shown.length
      ? h(Fragment, null, h(SectionLabel, null, scope === 'run' ? 'This run’s loop events' : 'Every loop event'), h(LoopFeed, { events: shown, withRuns: scope === 'all' }))
      : h(
          Empty,
          { icon: 'pulse', title: scope === 'run' ? 'No loop events for this run yet' : 'The loops are quiet' },
          'Each ring lights when roko regulates itself: a tool call held (L0), a route or retry (L1), a wave or a diagnosis (L2), a lesson learned (L3), a loop’s health (L4).'
        )
  )
}

/** The Loops tab: every loop event this window heard, and roko's own numbers for each ring. */
function LoopsTab() {
  const feed = useValue($loopFeed)
  const live = useValue($live)
  const loops = useLoops(true)
  const relay = isRecord(loops.data?.live) ? loops.data.live : null
  const on = live.state === 'open'

  return h(
    'div',
    { className: 'roko-stack' },
    h(
      'div',
      { className: 'rk-loops-strip' },
      h(LED, { blink: on ? 'slow' : undefined, tone: on ? 'agent' : 'off' }),
      h('span', { className: 'roko-strong' }, on ? 'live' : live.state === 'connecting' ? 'connecting…' : 'polling'),
      relay ? h('span', { className: 'roko-muted' }, `relay ${clip(relay.hub, 12) || '?'} · ${plural(num(relay.subscribers) ?? 0, 'socket')}`) : null,
      loops.data?.checked_at ? h('span', { className: 'roko-muted' }, `checked ${clock(parseTime(loops.data.checked_at))}`) : null,
      h('span', { className: 'roko-flex' }),
      h(Button, { onClick: () => void loops.refetch(), size: 'xs', type: 'button', variant: 'ghost' }, loops.isFetching ? h(Spinner, null) : h(Codicon, { name: 'refresh', size: '0.75rem' }), 'Check again')
    ),
    h(LoopsPanel, { events: feed, scope: 'all' })
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
// The New run device: ask roko for work from the app (POST /runs)
// ---------------------------------------------------------------------------

const MODES = [
  { id: 'run', label: 'run it' },
  { id: 'plan', label: 'plan first' }
]
const DOMAINS = [
  { hint: 'Checked by your build, tests and lint.', id: 'code', label: 'code' },
  { hint: 'Checked for sources and coverage.', id: 'research', label: 'research' },
  { hint: 'Checked for structure and accuracy.', id: 'docs', label: 'docs' }
]

/**
 * A device with one job: a field for the request, a switch for run-it or plan-first, a knob for the cap
 * (detents bounded by today's limits), three keys for the kind of work, and one big start key (⌘↵).
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
  const known = groupsKnown(planList)
  const chosenPlan = validId(state.plan) ? planList.find(plan => plan.id === state.plan) ?? { id: state.plan } : null
  const planDetail = usePlan(chosenPlan ? chosenPlan.id : null)
  const estimate = num(planDetail.data?.estimate?.total_cost_usd)
  const mode = chosenPlan ? 'existing' : state.mode === 'plan' ? 'plan' : 'run'
  const prompt = state.prompt ?? ''
  const amount = Number.parseFloat(cap)
  const tooMuch = ceiling !== null && Number.isFinite(amount) && amount > ceiling + 1e-9
  const capOk = mode === 'plan' || (Number.isFinite(amount) && amount >= 0.01 && !tooMuch)
  const promptOk = mode === 'existing' || (prompt.trim().length > 0 && prompt.length <= MAX_PROMPT)
  // roko will not run the chosen plan as it is (0.5.0 `validation`, or a refusal that says so): why, and no Run.
  const invalid =
    mode !== 'existing' ? null : isRecord(planDetail.data?.validation) ? planDetail.data.validation : error instanceof RokoError ? error.validation : null
  const valid = promptOk && capOk && !busy && !blocking && !invalid
  const kind = DOMAINS.find(d => d.id === domain) ?? DOMAINS[0]
  const refusal = error instanceof RokoError ? error.problem : null
  // Examples about this workspace, when the backend sends some (`overview.examples`); else roko's generic ones.
  const overviewData = useOverview().data
  const ownExamples = list(overviewData?.examples).map(text).filter(Boolean).slice(0, 3)

  useEffect(() => {
    if (state.open) {
      setError(null)
      setBusy(false)

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

      play('start', true)
      markFresh(reply.run_id)
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
        className: 'roko roko-composer rk-device',
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
            ? 'roko’s planner turns the request into small tasks, each with its own checks. You review the plan, then run it.'
            : mode === 'existing'
              ? 'roko runs the plan’s tasks, each on its own branch, and calls one done only when its checks pass.'
              : 'roko’s agent works on its own branch, and your project’s checks must pass before roko calls it done.'
        )
      ),
      h(
        'div',
        { className: 'roko-form rk-device-body' },
        h(
          'div',
          { className: 'rk-module rk-module-request' },
          h(ModLabel, { n: 1, right: mode !== 'existing' && prompt.trim() ? h('span', { className: cx(prompt.length > MAX_PROMPT && 'roko-tone-bad') }, `${prompt.length.toLocaleString()} / ${MAX_PROMPT.toLocaleString()}`) : null }, mode === 'existing' ? 'which plan?' : 'request'),
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
                          isStartHere(plan, known) ? h('span', { className: 'rk-tag', 'data-channel': 'you' }, 'start here') : null,
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
                      isDemoPlan(chosenPlan, known) ? 'a demo: its output stays on its run branch' : null
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
          mode === 'existing' ? null : h('label', { className: 'rk-field-label', htmlFor: 'roko-composer-prompt' }, 'What should roko do?'),
          mode === 'existing' ? null : h(Textarea, {
            'aria-invalid': prompt.length > MAX_PROMPT,
            autoFocus: true,
            className: 'roko-prompt',
            id: 'roko-composer-prompt',
            maxLength: MAX_PROMPT + 200,
            onChange: event => setDraft({ prompt: event.target.value }),
            placeholder: 'Say what to change, where, and how to check it. roko’s agent sees only this text.',
            rows: 5,
            value: prompt
          }),
          prompt.trim() || mode === 'existing'
            ? null
            : h(
                'div',
                { className: 'roko-examples' },
                h('span', { className: 'roko-examples-label' }, 'try'),
                // This workspace's own demo first, when it has one: a real run in about a minute, for under a cent.
                planList
                  .filter(plan => isStartHere(plan, known))
                  .slice(0, 1)
                  .map(plan =>
                    h('button', { className: 'roko-example', 'data-testid': 'example-start-here', key: `plan:${plan.id}`, onClick: () => setDraft({ plan: plan.id }), title: text(plan.title) || plan.id, type: 'button' }, `▶ ${clip(text(plan.title).replace(/^start here:\s*/i, '') || plan.id, 32)}`)
                  ),
                ownExamples.length
                  ? ownExamples.map((example, i) => h('button', { className: 'roko-example', key: `own:${i}`, onClick: () => setDraft({ prompt: example }), title: example, type: 'button' }, clip(example, 40)))
                  : EXAMPLES.map((example, i) =>
                      h('button', { className: 'roko-example', key: i, onClick: () => setDraft({ prompt: example }), title: example, type: 'button' }, EXAMPLE_CHIPS[i] ?? clip(example, 40))
                    )
              ),
        ),
        h(
          'div',
          { className: 'rk-device-row' },
          h(
            'div',
            { className: 'rk-module' },
            h(ModLabel, { n: 2 }, 'mode'),
            mode === 'existing'
              ? h(
                  'div',
                  { className: 'rk-keyrow' },
                  h('span', { className: 'rk-hint' }, 'a plan roko already has: its tasks and checks are set'),
                  h(Key, { onClick: () => setDraft({ plan: null, resume: false }), size: 's', testId: 'composer-request' }, h(Codicon, { name: 'add', size: '0.7rem' }), 'a new request')
                )
              : h(
                  'div',
                  { className: 'rk-keyrow' },
                  h(Slide, { label: 'Run or plan first', onChange: value => setDraft({ mode: value }), options: MODES, value: mode }),
                  planList.length
                    ? h(
                        Key,
                        {
                          onClick: () => setDraft({ plan: (planList.find(plan => isStartHere(plan, known)) ?? planList[0]).id }),
                          size: 's',
                          testId: 'composer-plan-key',
                          title: 'Run a plan roko already has, such as the hello world demo'
                        },
                        h(Codicon, { name: 'list-tree', size: '0.7rem' }),
                        'run a plan'
                      )
                    : null
                )
          ),
          h(
            'div',
            { className: 'rk-module', 'data-off': mode !== 'run' ? 'true' : undefined },
            h(ModLabel, { n: 3 }, 'kind'),
            h(
              'div',
              { 'aria-label': 'Kind of work', className: 'rk-keyrow', role: 'group' },
              DOMAINS.map(d => h(Key, { 'aria-pressed': domain === d.id ? 'true' : 'false', disabled: mode !== 'run', key: d.id, onClick: () => setDomain(d.id), size: 's' }, d.label))
            ),
            h('span', { className: 'rk-hint' }, mode === 'plan' ? 'the planner picks per task' : mode === 'existing' ? 'each task has its own checks' : kind.hint)
          )
        ),
        mode === 'run' || mode === 'existing'
          ? h(
              'div',
              { className: 'rk-module rk-module-cap' },
              h(ModLabel, { n: 4 }, 'cap'),
              h(
                'div',
                { className: 'rk-cap' },
                h(Knob, { ceiling, detents: CAP_PRESETS, label: 'Spend cap knob', onChange: value => setCap(value.toFixed(2)), value: Number.isFinite(amount) ? amount : null }),
                h(
                  'div',
                  { className: 'rk-cap-side' },
                  h(Well, { className: 'rk-cap-well' }, h(Dots, { label: `cap ${Number.isFinite(amount) ? money(amount) : 'not set'}`, size: 'XL', tone: capOk ? 'you' : 'fail', value: Number.isFinite(amount) ? money(amount) : '$-.--' })),
                  h(
                    'div',
                    { className: 'roko-field rk-cap-exact' },
                    h('label', { htmlFor: 'roko-composer-cap' }, 'Spend cap'),
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
                  )
                )
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
        h(
          'div',
          { className: 'rk-module rk-module-name' },
          h(ModLabel, { n: 5 }, 'name'),
          h('label', { className: 'rk-field-label', htmlFor: 'roko-composer-title' }, 'Name it ', h('span', { className: 'roko-muted' }, '(optional, shown in your run lists)')),
          h(Input, { id: 'roko-composer-title', maxLength: 80, onChange: event => setTitle(event.target.value), placeholder: 'e.g. JSON output for the report', value: title })
        ),
        mode !== 'plan' && !capOk ? h('div', { className: 'roko-result', 'data-tone': 'bad' }, tooMuch ? `Enter a cap of at most ${money(ceiling)}.` : 'Enter a cap of at least $0.01.') : null,
        h(FixDoneNote, { problems: setupProblems }),
        blocking && !refusal ? h(ProblemCard, { lead: 'roko can’t start work from Hermes until this is fixed:', problem: blocking }) : null,
        refusal ? h(ProblemCard, { lead: 'roko did not start it:', problem: refusal }) : null,
        invalid ? h(PlanValidationNote, { plan: { ...(planDetail.data ?? {}), group: text(planDetail.data?.group) || text(chosenPlan.group), id: chosenPlan.id }, validation: invalid }) : null,
        error && !refusal && !(error instanceof RokoError && error.validation)
          ? h('div', { className: 'roko-result', 'data-tone': 'bad', role: 'alert' }, describe(error).message, describe(error).hint ? h('span', { className: 'roko-result-hint' }, ` ${describe(error).hint}`) : null)
          : null
      ),
      h(
        DialogFooter,
        { className: 'rk-device-foot' },
        h(Button, { onClick: closeComposer, type: 'button', variant: 'ghost' }, 'Cancel'),
        h('span', { 'aria-hidden': 'true', className: 'rk-key-engrave' }, comboLabel('mod+enter')),
        h(
          'button',
          {
            className: 'rk-key rk-start',
            'data-size': 'xl',
            'data-testid': 'composer-submit',
            'data-tone': 'primary',
            disabled: !valid,
            onClick: () => void submit(),
            title: blocking ? blocking.title : invalid ? 'roko won’t run this plan yet: see why above' : undefined,
            type: 'button'
          },
          busy ? h(Spinner, null) : h(Codicon, { name: mode === 'plan' ? 'list-tree' : 'play', size: '0.85rem' }),
          mode === 'plan' ? 'Write the plan' : `${mode === 'existing' ? 'Run plan' : 'Start'} · cap ${Number.isFinite(amount) ? money(amount) : '—'}`
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

/** A run row's lead: its light. */
function RowLead({ row, waiting }) {
  const channel = runChannel(row, waiting)

  return h(
    'span',
    { className: 'roko-row-lead' },
    h(LED, { blink: isActiveRun(row) ? (waiting ? 'fast' : 'slow') : undefined, label: `${runInfo(row).word}${waiting ? ', waiting on you' : ''}`, tone: channel })
  )
}

function Onboarding() {
  const { canAct } = useLimits()

  return h(
    'div',
    { className: 'roko-onboard', 'data-testid': 'onboarding' },
    h(Well, { className: 'rk-onboard-well' }, h(Dots, { label: 'roko', size: 'XL', tone: 'you', value: 'ROKO' }), h(Scope, { height: 34, runId: null, width: 140 })),
    h('h2', { className: 'roko-onboard-title' }, 'Delegate checked work to roko'),
    h(
      'p',
      { className: 'roko-onboard-text' },
      'roko turns a request into small tasks, runs each with an agent on its own branch, and calls a task done only when your project’s checks pass. You watch it here, then review the diff and merge.'
    ),
    h(
      'ol',
      { className: 'roko-steps' },
      h('li', null, h(ModLabel, { n: 1 }, 'ask'), h('span', null, 'In any chat: “Use roko to … Cap it at $1.” Or start one here.')),
      h('li', null, h(ModLabel, { n: 2 }, 'watch'), h('span', null, 'Every task, attempt, check and loop, live, with the spend against its cap.')),
      h('li', null, h(ModLabel, { n: 3 }, 'review & merge'), h('span', null, 'Read the diff, then merge the verified work with one key.'))
    ),
    canAct
      ? h(
          'div',
          { className: 'roko-onboard-actions' },
          h(Key, { kbd: 'N', onClick: () => openComposer({ mode: 'run' }), size: 'l', tone: 'primary' }, h(Codicon, { name: 'add', size: '0.8rem' }), 'new run'),
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

function RunsTab({ overview }) {
  const selected = useValue($run)
  const now = useNow(30_000)
  const reachable = isRecord(overview.data?.connection) ? overview.data.connection.reachable === true : null
  const runs = list(overview.data?.runs)
    .filter(row => isRecord(row) && validId(row.run_id))
    .map(row => lastKnown(row, reachable))
  const current = validId(selected) ? selected : runs[0]?.run_id ?? null
  const sections = sectionRuns(runs, now)
  const waitingRuns = new Set(list(overview.data?.pending).filter(isRecord).map(item => text(item.run_id)))

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
        { 'aria-label': 'roko runs', className: 'roko-list rk-tracks', role: 'list' },
        sections.flatMap(([name, rows]) => [
          h('div', { className: 'roko-list-section', key: `s:${name}`, role: 'presentation' }, name, h('span', null, String(rows.length).padStart(2, '0'))),
          ...rows.map(row => {
            const info = runInfo(row)
            const p = isRecord(row.progress) ? { ...EMPTY_PROGRESS, ...row.progress } : null
            const waiting = waitingRuns.has(row.run_id)

            return h(
              ListRow,
              { active: row.run_id === current, key: row.run_id, live: isActiveRun(row), onSelect: () => selectRun(row.run_id) },
              h(RowLead, { row, waiting }),
              h(
                'span',
                { className: 'roko-row-main' },
                h('span', { className: 'roko-row-title' }, text(row.label) || row.run_id),
                h(
                  'span',
                  { className: 'roko-row-meta' },
                  h('span', { 'data-tone': waiting && isActiveRun(row) ? 'warn' : info.tone }, waiting && isActiveRun(row) ? 'waiting on you' : runWord(row)),
                  p && p.total > 1 ? h('span', null, `${p.passed}/${p.total}`) : null,
                  h('span', null, row.kind === 'plan_generate' ? 'plan' : row.kind === 'plan' ? 'plan run' : 'task'),
                  row.started_at ? h('span', null, ago(row.started_at, now)) : null
                )
              ),
              h(
                'span',
                { className: 'rk-row-side' },
                p && p.total ? h(StepStrip, { max: 12, progress: p, waiting: waiting && isActiveRun(row) }) : null,
                h('span', { className: 'rk-row-spend' }, money(row.cost_usd))
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
        h('span', null, 'new run'),
        h(Kbd, { size: 'sm', variant: 'ghost' }, '['),
        h(Kbd, { size: 'sm', variant: 'ghost' }, ']'),
        h('span', null, 'views')
      )
    ),
    h('div', { className: 'roko-detail' }, current ? h(RunCard, { fallback: runs.find(row => row.run_id === current), key: current, runId: current }) : null)
  )
}

function WaitingTab() {
  const query = usePending()
  const items = list(query.data).filter(item => isRecord(item) && !answered(item))
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

/**
 * One of roko's demos (`plans/demos/…`, or a plan still marked `fixture`): a showcase, not the person's work.
 * Its output belongs on its run's branch: merged, it clutters the person's branch, and a later run of the demo would
 * find its check already passing and have nothing new to show. Never merge demo output.
 */
function isDemoPlan(plan, groupsKnown = true) {
  const group = text(plan?.group)

  if (typeof plan?.demo === 'boolean') {
    // A 0.5.0 backend says so itself.
    return plan.demo
  }

  return (
    group === 'demos' ||
    group.startsWith('demos/') ||
    // roko says `fixture` only until a demo's first run (gap-8f84d1); `group` stays.
    text(plan?.status) === 'fixture' ||
    // An older roko or plugin sends no `group` at all: a `demo-` id is the sign left.
    (!groupsKnown && text(plan?.id).startsWith('demo-'))
  )
}

/** Whether roko said which set each plan is in (a plan at the top of plans/ has none; an older roko sends none). */
function groupsKnown(plans) {
  return plans.some(plan => Boolean(text(plan?.group)))
}

/** The demo roko says to run first: its title starts with "Start here". */
function isStartHere(plan, known = true) {
  return typeof plan?.start_here === 'boolean' ? plan.start_here : isDemoPlan(plan, known) && /^start here\b/i.test(text(plan?.title))
}

/** The Plans tab's sections: the demos first (the one to start with on top), then the person's plans by set. */
function sectionPlans(plans) {
  const known = groupsKnown(plans)
  const demos = plans.filter(plan => isDemoPlan(plan, known))
  const own = plans.filter(plan => !isDemoPlan(plan, known))
  // Top-level plans first, then each set in roko's order.
  const sets = [...new Set(own.map(plan => text(plan.group)))].sort((a, b) => Number(Boolean(a)) - Number(Boolean(b)))

  return [
    ['Demos', [...demos.filter(plan => isStartHere(plan, known)), ...demos.filter(plan => !isStartHere(plan, known))]],
    ...sets.map(set => [set || (demos.length ? 'Your plans' : 'Plans'), own.filter(plan => text(plan.group) === set)])
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
  const known = groupsKnown(rows)

  return rows.some(plan => plan.id === planId && isDemoPlan(plan, known))
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

function PlansTab() {
  const query = usePlans()
  const selected = useValue($plan)
  const { canAct } = useLimits()
  const plans = list(query.data).filter(plan => isRecord(plan) && validId(plan.id))
  const sections = sectionPlans(plans)
  const known = groupsKnown(plans)
  // Nothing is chosen for the person except the demo roko says to start with: a real plan waits to be picked.
  const current = validId(selected) ? selected : plans.find(plan => isStartHere(plan, known))?.id ?? null

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
      sections.flatMap(([name, rows]) => [
        h('div', { className: 'roko-list-section', key: `s:${name}`, role: 'presentation' }, name, h('span', null, String(rows.length).padStart(2, '0'))),
        ...rows.map(plan => {
          const total = num(plan.task_count) ?? 0
          const done = num(plan.tasks_done) ?? 0
          const demo = isDemoPlan(plan, known)

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
            h('span', { className: 'roko-row-lead' }, h(Codicon, { className: 'roko-row-icon', name: demo ? 'beaker' : 'list-tree', size: '0.85rem' })),
            h(
              'span',
              { className: 'roko-row-main' },
              h('span', { className: 'roko-row-title' }, text(plan.title) || plan.id),
              h(
                'span',
                { className: 'roko-row-meta' },
                h('span', { className: 'roko-mono' }, plan.id),
                h('span', null, `${done}/${total} done`),
                // A demo's `fixture` is roko's marker, not news for the person.
                plan.status && !(demo && plan.status === 'fixture') ? h('span', null, text(plan.status)) : null,
                isStartHere(plan, known) ? h('span', { className: 'rk-tag', 'data-channel': 'you' }, 'start here') : null
              ),
              total ? h(SegBar, { height: 3, progress: { ...EMPTY_PROGRESS, passed: done, pending: Math.max(0, total - done), total } }) : null
            )
          )
        })
      ])
    ),
    h(
      'div',
      { className: 'roko-detail' },
      current
        ? h(PlanDetail, { key: current, planId: current })
        : h(Empty, { icon: 'list-tree', title: 'Pick a plan' }, 'Its tasks, checks and estimate show here. Nothing runs until you press Run plan and say yes.')
    )
  )
}

// ---------------------------------------------------------------------------
// Setup and updates: what keeps roko from working here, each with its one fix
// (`setup.problems` on /overview and /health), and the restart Hermes needs
// after an update (docs/updating.md)
// ---------------------------------------------------------------------------

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
      label: text(fix.label) || 'fix'
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
 * Whether this window runs two versions of roko, and what finishes the update. Hermes imports roko's backend
 * once, when it starts, and runs a copy of this page that it refreshes only on a start or a rescan, so an
 * update on disk reaches neither by itself (docs/updating.md). The signs, strongest first:
 *   - the backend says its files changed under it (`install.backend_stale`);
 *   - the backend is another version than this page (`plugin_version`, which every backend since 0.2.0 sends);
 *   - the backend answers without `setup` or `install`: it predates this page;
 *   - the desktop app's copy of this page is older than the installed one (`install.desktop_copy_stale`).
 * Returns null, or `{key, title, steps, pageOnly}`. `pageOnly`: only this page is old, and a rescan of the
 * desktop plugins fixes it; anything else needs Hermes to quit and start again.
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
  return useQuery({
    enabled,
    queryFn: () => call('/health'),
    queryKey: KEYS.health,
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
    // The overview asks roko every time; the backend's own look at setup can lag by up to 30 s (and an older backend
    // has none). So roko-unreachable follows the overview both ways: added at once when roko stops answering, and
    // gone at once when it answers again.
    const problems = (data ? problemsOf(data.setup, reply?.setup) : []).filter(p => !(conn?.reachable === true && p.id === 'roko-unreachable'))

    if (conn && conn.reachable === false && !problems.some(p => p.id === 'roko-unreachable')) {
      problems.unshift(unreachableProblem(conn))
    }

    return { blocking: problems.find(p => p.severity === 'block') ?? null, problems, restart: restartOf(data, reply) }
  }, [data, reply])
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
      ? readProblem({ fix: { action: 'commit-roko-toml', command: null, docs: null, kind: 'action', label: 'commit roko.toml' }, id: 'commit-roko-toml', severity: 'warn', title: 'commit roko.toml' })
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

/**
 * An `action` fix: its key asks the backend what the fix would change (GET /setup/fix) and shows that on the
 * glass, with its way of doing it when there is a choice; a second key applies exactly that preview (POST
 * /setup/fix with its `variant` and `digest`), and the row then says what was done and what is next.
 */
function FixAction({ problem, onDone }) {
  const [state, setState] = useState({ step: 'idle' })
  const action = problem.fix.action

  const preview = async variant => {
    setState(current => ({ ...current, error: null, step: current.reply ? 'switching' : 'loading' }))

    try {
      const reply = await call(`/setup/fix?action=${enc(action)}${variant ? `&variant=${enc(variant)}` : ''}`)

      setState({ reply, step: 'preview' })
    } catch (error) {
      setState(current => (current.reply ? { ...current, error, step: 'preview' } : { error, step: 'failed' }))
    }
  }

  const apply = async () => {
    const shown = isRecord(state.reply) ? state.reply : {}
    const body = { action }

    if (text(shown.variant)) {
      body.variant = text(shown.variant)
    }

    if (text(shown.digest)) {
      body.digest = text(shown.digest)
    }

    setState(current => ({ ...current, error: null, step: 'applying' }))

    try {
      const reply = await post('/setup/fix', body)

      setState({ reply, step: 'done' })
      $fixDone.set({ at: Date.now(), id: problem.id, reply: isRecord(reply) ? reply : {} })
      play('check', true)
      refreshSetup()
      onDone?.(reply)
    } catch (error) {
      setState(current => ({ ...current, error, step: 'preview' }))
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
      text(reply.summary) ? h('div', { className: 'rk-fix-summary' }, text(reply.summary)) : null,
      text(reply.path) ? h('div', { className: 'rk-fix-path' }, 'changes ', h('span', { className: 'roko-mono' }, text(reply.path))) : null,
      text(reply.preview) ? h(PreviewText, { value: reply.preview }) : h('div', { className: 'roko-muted' }, 'Nothing in the file changes.'),
      text(reply.note) ? h('div', { className: 'rk-fix-path' }, text(reply.note)) : null,
      state.error ? h(FixFailed, { error: state.error }) : null,
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

/** `00 SETUP`: everything that keeps roko from working here, numbered, each with its one fix. */
function SetupModule({ problems }) {
  if (!problems.length) {
    return null
  }

  const blocking = problems.filter(p => p.severity === 'block').length

  return h(
    'section',
    { 'aria-label': 'Setup', className: 'rk-module rk-setup', 'data-blocking': blocking ? 'true' : undefined, 'data-testid': 'setup-module' },
    h(ModLabel, { n: 0, right: blocking ? `${blocking} blocking new runs` : `${problems.length} to look at` }, 'setup'),
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

/** The top of the page: the restart banner, then the setup module (its restart line is the banner). */
function SetupArea() {
  const setup = useSetup()
  const done = useValue($fixDone)
  const problems = setup.restart ? setup.problems.filter(p => p.id !== 'restart-hermes') : setup.problems

  if (!setup.restart && !problems.length && !done) {
    return null
  }

  return h(
    'div',
    { className: 'rk-setup-area' },
    setup.restart ? h(RestartBanner, { restart: setup.restart }) : null,
    h(FixDoneNote, { problems: setup.problems }),
    h(SetupModule, { problems })
  )
}

/** The monitor pane's line for it: the restart, or the first problem and a key to its fix on the page. */
function SetupStrip() {
  const setup = useSetup()
  const first = setup.problems.find(p => p.id !== 'restart-hermes')

  if (setup.restart) {
    return h(RestartBanner, { compact: true, restart: setup.restart })
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
  const restart = restartOf(data, queryClient.getQueryData(KEYS.health))

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


function OfflineNotes({ overview }) {
  const data = overview.data
  const conn = isRecord(data?.connection) ? data.connection : null
  const setup = useSetup()
  const notes = []

  if (data && conn && conn.reachable !== true) {
    // The setup module already says roko serve is not answering, and how to start it, with this workspace's path.
    // Here only what it does not say: the hint when the module has no command for it, and that the runs below are
    // the last known.
    const shown = setup.problems.find(p => p.id === 'roko-unreachable')
    const fixShown = Boolean(shown) && shown.fix.kind !== 'docs'
    const err = isRecord(conn.error) ? { ...conn.error, hint: fixShown ? '' : conn.error.hint } : {}
    const lastKnownLine = `Showing the last known runs · checked ${clock(parseTime(data.checked_at) ?? overview.dataUpdatedAt)}; the page asks again every few seconds`

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

/**
 * Today's spend as a 20-segment meter: lit for what was spent (green, orange past 80 %, red past 95 %),
 * dim for what running runs may still spend, dark for what is left.
 */
function SegMeter({ spent, committed = 0, max, segments = 20 }) {
  const s = clamp((num(spent) ?? 0) / max, 0, 1)
  const c = clamp((num(committed) ?? 0) / max, 0, 1 - s)
  const level = s >= 0.95 ? 'fail' : s >= 0.8 ? 'you' : 'pass'

  return h(
    'span',
    { 'aria-hidden': 'true', className: 'rk-segmeter', 'data-level': level },
    Array.from({ length: segments }, (_, i) => {
      const at = (i + 0.5) / segments

      return h('i', { 'data-seg': at <= s ? 'spent' : at <= s + c ? 'committed' : 'left', key: i })
    })
  )
}

/** The header's spend module: today's spend on the glass, the meter, and the plain line. */
function SpendModule({ spend }) {
  const max = num(spend.max_day_usd)
  const today = num(spend.today_usd) ?? 0
  const ratio = max ? today / max : null

  return h(
    'div',
    { className: 'rk-spendmod' },
    h(ModLabel, { n: 0 }, 'today'),
    h(
      'div',
      { className: 'rk-spendmod-row' },
      h(Well, { className: 'rk-spendmod-well' }, h(Dots, { label: `spent today ${money(today)}`, size: 'L', tone: ratio === null ? 'on' : ratio >= 0.95 ? 'fail' : ratio >= 0.8 ? 'you' : 'on', value: money(today) })),
      max ? h(Tip, { label: spendLine(spend) }, h('span', { className: 'rk-spendmod-meter' }, h(SegMeter, { committed: spend.committed_usd, max, spent: today }))) : null
    ),
    h('span', { className: 'rk-spendmod-line', 'data-testid': 'roko-spend' }, spendLine(spend))
  )
}

/** Sounds are off until the person turns them on; the choice is kept per window profile. */
function SoundKey() {
  const on = useValue($sound)

  return h(
    Tip,
    { label: on ? 'Sounds on: blips for checks, passes and what needs you' : 'Sounds off (turn on for blips when checks pass or roko needs you)' },
    h(
      'button',
      {
        'aria-label': 'Sounds',
        'aria-pressed': on ? 'true' : 'false',
        className: 'rk-soundkey',
        'data-testid': 'sound-key',
        onClick: () => setSound(!on),
        type: 'button'
      },
      h(Codicon, { name: on ? 'unmute' : 'mute', size: '0.85rem' })
    )
  )
}

/** The header strip: the wordmark and connection light, today's spend, the live light, and the one key. */
function PageHeader({ overview }) {
  const data = overview.data
  const conn = isRecord(data?.connection) ? data.connection : null
  const tone = connectionTone(overview)
  const checked = parseTime(data?.checked_at) ?? overview.dataUpdatedAt
  const { canAct } = useLimits()
  const live = useValue($live)
  // The plugin's socket can be open while roko serve is down: LIVE only when roko's events can flow.
  const offline = Boolean(data) && conn?.reachable !== true
  const on = live.state === 'open' && !offline && (!live.hub || live.hub === 'open')
  const liveWord = offline ? 'offline' : on ? 'live' : live.state === 'connecting' || live.hub === 'connecting' ? 'connecting' : 'polling'
  const liveTip = offline
    ? 'roko serve isn’t answering: nothing streams. The page asks again every few seconds.'
    : on
      ? 'roko’s events stream in as they happen'
      : 'No live stream: checking every few seconds'
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
        h(
          Tip,
          { label: liveTip },
          h(
            'span',
            { className: 'rk-livetag', 'data-state': offline ? 'offline' : on ? 'open' : live.state, 'data-testid': 'live-state' },
            h(LED, { blink: on ? 'slow' : undefined, size: 's', tone: offline ? 'fail' : on ? 'agent' : 'off' }),
            liveWord
          )
        ),
        checked ? h('span', null, `checked ${clock(checked)}`) : null
      )
    ),
    data?.spend ? h(SpendModule, { spend: data.spend }) : null,
    h(
      'div',
      { className: 'roko-head-actions' },
      h(SoundKey, null),
      h(Button, { 'aria-label': 'Refresh', onClick: refreshAll, size: 'sm', type: 'button', variant: 'ghost' }, overview.isFetching ? h(Spinner, null) : h(Codicon, { name: 'refresh', size: '0.85rem' })),
      canAct && data
        ? h(
            Tip,
            { label: `New run (${comboLabel(NEW_RUN_COMBO)}, or n on this page)` },
            h(Key, { kbd: 'N', onClick: () => openComposer(), size: 'l', testId: 'new-run', tone: 'primary' }, h(Codicon, { name: 'add', size: '0.8rem' }), 'new run')
          )
        : null
    )
  )
}

function RokoPage() {
  useLocationSync()
  const tab = useValue($tab)
  const overview = useOverview()
  const feed = useValue($loopFeed)
  const data = overview.data
  const waiting = num(data?.counts?.waiting) ?? list(data?.pending).length
  const backendDown = !data && overview.error instanceof RokoError && overview.error.kind === 'backend'
  const setTab = value => {
    if (TABS.includes(value)) {
      $tab.set(value)
      replaceView(value === 'runs' ? { run: $run.get(), view: $runView.get() } : value === 'plans' ? { plan: $plan.get(), tab: 'plans' } : { tab: value })
    }
  }
  const freshLoops = feed.filter(e => Date.now() - (e.ts ?? 0) < 600_000).length

  usePageKeys(overview)

  let body

  if (backendDown) {
    body = h(BackendBanner, { error: overview.error, onRetry: refreshAll })
  } else if (!data && overview.isLoading) {
    body = h('div', { className: 'rk-boot' }, h(Loader, { className: 'rk-loader', label: 'Connecting to roko', type: 'rose-curve' }), h(Spinner, { label: 'Connecting to roko…' }))
  } else if (!data && overview.error) {
    body = h(ErrorNote, { error: overview.error, onRetry: () => void overview.refetch() })
  } else if (tab === 'waiting') {
    body = h(WaitingTab, null)
  } else if (tab === 'plans') {
    body = h(PlansTab, null)
  } else if (tab === 'loops') {
    body = h(LoopsTab, null)
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
              h(TabsTrigger, { value: 'runs' }, 'Runs', num(data?.counts?.running) ? h('span', { className: 'roko-tab-live' }, h(LED, { blink: 'slow', size: 's', tone: 'agent' })) : null),
              h(TabsTrigger, { value: 'waiting' }, 'Waiting', waiting > 0 ? h('span', { className: 'roko-tab-count rk-count-you', 'data-testid': 'waiting-count' }, String(waiting)) : null),
              h(TabsTrigger, { value: 'plans' }, 'Plans'),
              h(TabsTrigger, { value: 'loops' }, 'Loops', freshLoops ? h('span', { className: 'roko-tab-n' }, String(freshLoops)) : null),
              h(TabsTrigger, { value: 'health' }, 'Insights'),
              h(TabsTrigger, { value: 'knowledge' }, 'Knowledge')
            )
          )
        ),
    h('div', { className: 'roko-body' }, backendDown ? null : h(SetupArea, null), backendDown ? null : h(OfflineNotes, { overview }), backendDown ? null : h(ThemeOffer, null), body),
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

/** The progress of a run's tasks, as a sentence for assistive tech. */
function progressWords(p) {
  return p.total ? `${p.passed} of ${plural(p.total, 'task')} passed${p.running ? `, ${p.running} running` : ''}` : 'no tasks yet'
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
  const liveWaits = Boolean(live) && list(data?.pending).some(item => isRecord(item) && text(item.run_id) === live.run_id)
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
  } else if (setup.blocking) {
    tipLines.unshift(`setup: ${setup.blocking.title}`)
  }

  if (live) {
    tipLines.push(`${clip(live.label, 40)}: ${progress.passed}/${progress.total} tasks`)
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
        h(Dot, { pulse: Boolean(live), tone }),
        h('span', { className: 'rk-chip-word' }, 'roko'),
        setup.restart
          ? h('span', { className: 'rk-tag', 'data-channel': 'you', 'data-testid': 'chip-restart' }, 'restart')
          : setup.blocking?.id === 'roko-unreachable'
            ? h('span', { className: 'rk-tag', 'data-channel': 'fail', 'data-testid': 'chip-offline' }, 'offline')
            : setup.blocking
              ? h('span', { className: 'rk-tag', 'data-channel': 'fail', 'data-testid': 'chip-setup' }, 'setup')
              : null,
        progress ? h(StepStrip, { className: 'rk-chip-strip', label: progressWords(progress), max: 5, progress, waiting: liveWaits }) : null,
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
// Background: the overview poll (a fallback while the socket is live),
// change notifications, pet lines, sounds, the sidebar label, run events
// ---------------------------------------------------------------------------

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

function setNavLabel(waiting) {
  const label = waiting > 0 ? `roko (${waiting})` : 'roko'

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

  setNavLabel(num(data.counts?.waiting) ?? pending.length)
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
  play(state === 'succeeded' ? 'run' : state === 'failed' && !stop ? 'fail' : 'check')
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
const audio = { ctx: null, last: new Map() }
/** [frequency Hz, seconds, waveform, start offset s] */
const SOUNDS = {
  check: [[2000, 0.03, 'sine', 0]],
  fail: [[110, 0.12, 'sawtooth', 0]],
  run: [
    [1046.5, 0.07, 'square', 0],
    [1318.5, 0.07, 'square', 0.07],
    [1568, 0.07, 'square', 0.14],
    [2093, 0.1, 'square', 0.21]
  ],
  start: [
    [1568, 0.04, 'square', 0],
    [2093, 0.05, 'square', 0.05]
  ],
  task: [[1046.5, 0.06, 'square', 0]],
  you: [
    [880, 0.06, 'sine', 0],
    [880, 0.06, 'sine', 0.12]
  ]
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
    h('span', { 'aria-hidden': 'true', className: 'rk-swatches' }, h('i', { 'data-swatch': 'alu' }), h('i', { 'data-swatch': 'graphite' }), h('i', { 'data-swatch': 'orange' })),
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
  }
}

/** A short blip. `explicit`: the person just pressed something, so it plays even under reduced motion. */
function play(name, explicit = false) {
  if (!$sound.get() || !doors || isHidden() || (reducedMotion() && !explicit)) {
    return
  }

  const notes = SOUNDS[name]
  const now = Date.now()

  if (!notes || now - (audio.last.get(name) ?? 0) < 90) {
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

    notes.forEach(([freq, secs, type, at]) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      const peak = type === 'sine' ? 0.05 : 0.018

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

  const tick = async () => {
    if (stopped) {
      return
    }

    let mounted = false

    try {
      mounted = isRecord(await queryClient.fetchQuery({ queryFn: fetchOverview, queryKey: KEYS.overview, retry: false, staleTime: OVERVIEW_MS - 1_000 }))
    } catch {
      // The error lands in the query; observers show it.
    }

    // The backend answers: open the live socket (once; it reconnects on its own).
    if (mounted && !stopped) {
      openLive()
    }

    checkLive()

    if (!stopped) {
      timer = setTimeout(() => void tick(), isHidden() ? OVERVIEW_HIDDEN_MS : pollMs(OVERVIEW_MS))
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
// Around the chat: the monitor pane, the empty-chat card, the composer key,
// session lights, the theme, the settings page
// ---------------------------------------------------------------------------

/** The newest active run as a compact live instrument: display, ticker, sequencer in miniature, now. */
function MonitorRun({ row }) {
  const runId = row.run_id
  const query = useRun(runId)
  const run = lastKnown(isRecord(query.data) ? query.data : row, useReachable())
  const live = useLive(runId)
  const progress = progressOf(run)
  const active = isActiveRun(run)
  const startMs = parseTime(run.started_at) ?? parseTime(run.hermes_started_at)
  const tasks = list(run.tasks).filter(isRecord)
  const running = active ? tasks.map(task => taskNode(task, null, run)).filter(node => node.state === 'running') : []
  const loops = runLoops(run, live)

  return h(
    'div',
    { className: 'rk-monitor-run', 'data-state': text(run.state) },
    h(
      'button',
      { className: 'rk-monitor-title', onClick: () => openRoko({ run: runId }), title: 'Open in roko', type: 'button' },
      h(LED, { blink: active ? (list(run.waiting).length ? 'fast' : 'slow') : undefined, tone: runChannel(run, list(run.waiting).length > 0) }),
      h('span', null, text(run.label) || runId)
    ),
    h(
      Well,
      { className: 'rk-monitor-display' },
      h('div', { className: 'rk-cell' }, h(ModLabel, { n: 1 }, 'tasks'), h(Dots, { label: progressWords(progress), size: 'M', tone: progress.failed ? 'fail' : 'on', value: progress.total ? `${progress.passed}/${progress.total}` : '-' })),
      h(
        'div',
        { className: 'rk-cell' },
        h(ModLabel, { n: 2 }, 'time'),
        notStarted(run) ? h(Dots, { label: 'starting', size: 'M', tone: 'agent', value: '-:--' }) : h(ClockDots, { fixedMs: active ? null : run.duration_ms, live: active && run.state === 'running', size: 'M', startMs })
      ),
      h(
        'div',
        { className: 'rk-cell' },
        h(ModLabel, { n: 3 }, 'spend'),
        h('div', { className: 'rk-cell-row' }, h(Dots, { label: `spent ${money(run.cost_usd)}`, size: 'M', tone: 'on', value: money(run.cost_usd) }), h(CostMeter, { cap: run.max_usd, compact: true, spent: run.cost_usd }))
      ),
      h('div', { className: 'rk-cell rk-cell-scope' }, h(Scope, { height: 28, runId, width: 260 }))
    ),
    h(Ticker, { compact: true, live, run }),
    tasks.length > 1 ? h('div', { className: 'rk-monitor-seq' }, h(MiniGraph, { max: 10, run })) : null,
    running.length
      ? h(
          'div',
          { className: 'rk-monitor-now' },
          running.slice(0, 4).map(node =>
            h(
              'button',
              { className: 'rk-monitor-task', key: node.id, onClick: () => openRoko({ run: runId }), type: 'button' },
              h(LED, { blink: node.waiting ? 'fast' : 'slow', size: 's', tone: nodeChannel(node) }),
              h('b', null, clip(node.taskId, 10)),
              h('span', null, clip(stepWords(node), 40)),
              h(StepClock, { since: node.stepSince })
            )
          )
        )
      : null,
    h('div', { className: 'rk-monitor-dial' }, h(Dial, { events: loops, label: `${plural(loops.length, 'loop event')} for this run`, size: 156 }), h('span', { className: 'rk-monitor-dial-caption' }, h(ModLabel, { n: 4 }, 'loops'), loops.length ? clip(loops[loops.length - 1].text, 90) : 'quiet'))
  )
}

/** Nothing running: a calm display, the last verdict, and the key for a new run. */
function MonitorIdle({ last, canAct }) {
  return h(
    'div',
    { className: 'rk-monitor-idle' },
    h(Well, { className: 'rk-monitor-display' }, h(Dots, { label: 'no run', size: 'L', tone: 'off', value: 'NO RUN' }), h(Scope, { height: 26, runId: null, width: 96 })),
    last
      ? h(
          'button',
          { className: 'rk-monitor-last', onClick: () => openRoko({ run: last.run_id }), type: 'button' },
          h(LED, { tone: runChannel(last, false) }),
          h('span', null, clip(last.label || last.run_id, 48)),
          h('span', { className: 'roko-muted' }, `${runInfo(last).word} · ${agoText(last.started_at)}`)
        )
      : null,
    canAct ? h(Key, { kbd: comboLabel(NEW_RUN_COMBO), onClick: () => openComposer({ mode: 'run' }), size: 'l', tone: 'primary' }, h(Codicon, { name: 'add', size: '0.8rem' }), 'new run') : null
  )
}

/** The monitor pane beside the chat (PANES_AREA, right side): roko's newest live run at a glance. */
function MonitorPane() {
  const overview = useOverview()
  const { canAct } = useLimits()
  const data = overview.data
  const runs = list(data?.runs).filter(row => isRecord(row) && validId(row.run_id))
  const row = runs.find(isActiveRun) ?? null
  const waiting = num(data?.counts?.waiting) ?? 0

  return h(
    'div',
    { className: 'roko roko-monitor', 'data-testid': 'monitor' },
    h(
      'div',
      { className: 'rk-monitor-head' },
      h(LogoMark, { size: 15 }),
      h('span', { className: 'rk-monitor-word' }, 'roko'),
      h(Dot, { label: `connection ${connectionTone(overview)}`, tone: connectionTone(overview) }),
      h('span', { className: 'roko-flex' }),
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
    h(Well, { className: 'rk-delegate-well' }, h(Dots, { label: 'roko', size: 'L', tone: 'you', value: 'ROKO' }), h(Scope, { height: 24, runId: null, width: 84 })),
    h(
      'div',
      { className: 'rk-delegate-body' },
      h(ModLabel, { n: 1 }, 'delegate to roko'),
      h('p', { className: 'rk-delegate-text' }, 'Hand checked work to roko: it plans, runs each task on its own branch, and calls it done only when your checks pass.'),
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

/** roko's own Hermes theme: aluminium and graphite, TE orange, four channel colours. */
const ROKO_THEME = {
  colors: {
    accent: '#d9d9d5',
    accentForeground: '#141414',
    background: '#e8e8e6',
    border: '#c8c8c3',
    card: '#f4f4f2',
    cardForeground: '#141414',
    composerRing: '#ff5f1f',
    destructive: '#e0352b',
    destructiveForeground: '#ffffff',
    foreground: '#141414',
    input: '#c8c8c3',
    midground: '#ff5f1f',
    midgroundForeground: '#141414',
    muted: '#e0e0dd',
    mutedForeground: '#5e5e59',
    popover: '#f7f7f5',
    popoverForeground: '#141414',
    primary: '#ff5f1f',
    primaryForeground: '#141414',
    ring: '#ff5f1f',
    secondary: '#dededb',
    secondaryForeground: '#141414',
    sidebarBackground: '#dfdfdc',
    sidebarBorder: '#cbcbc6',
    userBubble: '#f4f4f2',
    userBubbleBorder: '#cbcbc6'
  },
  customCSS:
    ':root{--ui-orange:#ff5f1f;--ui-blue:#2f6fff;--ui-green:#17a35c;--ui-red:#e5372b;--ui-yellow:#e8a317}' +
    ':root.dark{--ui-orange:#ff6a2b;--ui-blue:#4d8dff;--ui-green:#2fd27a;--ui-red:#ff4b4b;--ui-yellow:#f2b632}',
  darkColors: {
    accent: '#2a2c30',
    accentForeground: '#ecebe6',
    background: '#121314',
    border: '#2f3135',
    card: '#1b1c1e',
    cardForeground: '#ecebe6',
    composerRing: '#ff5f1f',
    destructive: '#ff3b3b',
    destructiveForeground: '#141414',
    foreground: '#ecebe6',
    input: '#2f3135',
    midground: '#ff5f1f',
    midgroundForeground: '#141414',
    muted: '#202225',
    mutedForeground: '#9b9a93',
    popover: '#1e1f22',
    popoverForeground: '#ecebe6',
    primary: '#ff5f1f',
    primaryForeground: '#141414',
    ring: '#ff5f1f',
    secondary: '#26282b',
    secondaryForeground: '#ecebe6',
    sidebarBackground: '#0e0f10',
    sidebarBorder: '#232528',
    userBubble: '#1b1c1e',
    userBubbleBorder: '#2f3135'
  },
  description: 'roko’s control surface: aluminium by day, graphite by night, TE orange for what needs you.',
  label: 'roko',
  name: 'roko'
}

/** Settings ▸ Plugins ▸ roko: the connection, the limits, sounds, the theme, and the doctor's checks. */
function SettingsPage() {
  const overview = useOverview()
  const health = useHealth()
  const live = useValue($live)
  const sound = useValue($sound)
  const limits = useLimits()
  const data = overview.data
  const conn = isRecord(data?.connection) ? data.connection : null
  const checks = list(health.data).filter(isRecord)
  const TONE = { fail: 'bad', ok: 'good', warn: 'warn' }
  const GLYPH = { fail: '✗', ok: '✓', warn: '!' }
  const row = (label, value) => h('div', { className: 'rk-set-row' }, h('span', { className: 'rk-set-key' }, label), h('span', { className: 'rk-set-value' }, value))

  return h(
    'div',
    { className: 'roko roko-settings', 'data-testid': 'roko-settings' },
    h('div', { className: 'rk-set-head' }, h(Well, { className: 'rk-set-well' }, h(Dots, { label: 'roko', size: 'XL', tone: 'you', value: 'ROKO' })), h('div', null, h('h2', { className: 'rk-set-title' }, 'roko'), h('p', { className: 'roko-muted' }, 'Checked work, delegated: plans, runs, checks and the five loops, live.'))),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, { n: 1 }, 'connection'),
      row('roko serve', conn ? h('span', null, h(Dot, { tone: connectionTone(overview) }), ` ${text(conn.url) || '—'}${conn.version ? ` · v${text(conn.version)}` : ''}${conn.status ? ` · ${text(conn.status)}` : ''}`) : overview.error ? describe(overview.error).message : 'connecting…'),
      row('credential', text(conn?.credential) || '—'),
      row('live stream', h('span', null, h(LED, { blink: live.state === 'open' ? 'slow' : undefined, size: 's', tone: live.state === 'open' ? 'agent' : 'off' }), ` ${live.state === 'open' ? `live · hub ${text(live.hub) || 'open'}` : live.state === 'connecting' ? 'connecting' : live.state === 'stale' ? 'quiet: polling meanwhile' : 'off: polling'}`))
    ),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, { n: 2 }, 'limits'),
      row('per run', limits.maxRun !== null ? `at most ${money(limits.maxRun)}` : 'no cap'),
      row('per day', limits.maxDay !== null ? `${money(limits.today)} of ${money(limits.maxDay)} · ${money(limits.left)} left` : money(limits.today)),
      row('actions from the app', limits.canAct ? 'on: start, approve, cancel and merge from here' : 'off: answer in chat with /roko'),
      h('p', { className: 'roko-muted' }, 'The caps live in the plugin’s config (hermes roko setup). The app never spends past them.')
    ),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, { n: 3 }, 'sound'),
      h(
        'div',
        { className: 'roko-field roko-field-row' },
        h(Switch, { checked: sound, id: 'roko-set-sound', onCheckedChange: value => setSound(Boolean(value)) }),
        h('label', { htmlFor: 'roko-set-sound' }, 'Play short blips: a check passes, a task passes, a run ends, roko needs you')
      ),
      h('p', { className: 'roko-muted' }, 'Off by default. Never while the window is hidden; with reduced motion, only when you press a key.')
    ),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, { n: 4 }, 'theme'),
      h(
        'div',
        { className: 'rk-set-theme' },
        h('span', { 'aria-hidden': 'true', className: 'rk-swatches' }, h('i', { 'data-swatch': 'alu' }), h('i', { 'data-swatch': 'graphite' }), h('i', { 'data-swatch': 'orange' })),
        h('span', null, 'Aluminium by day, graphite by night, TE orange for what needs you.'),
        h(Key, { onClick: () => requestTheme(ROKO_THEME.name), size: 's' }, 'use the roko theme')
      )
    ),
    h(
      'section',
      { className: 'rk-module' },
      h(ModLabel, { n: 5, right: h(Button, { onClick: () => void health.refetch(), size: 'xs', type: 'button', variant: 'ghost' }, health.isFetching ? h(Spinner, null) : h(Codicon, { name: 'refresh', size: '0.75rem' }), 'Check again') }, 'doctor'),
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
      h(ModLabel, { n: 6 }, 'keys'),
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

// ---------------------------------------------------------------------------
// Styles: Tailwind only knows the classes the app itself uses, so the control
// surface lives here. Page colours come only from the app's --ui-* tokens
// (through the --rk-* aliases); the display glass and its lit pixels are the
// one deliberate exception, built from black and white so they read the same
// in every theme. No literal colours. Motion stops under
// prefers-reduced-motion.
// ---------------------------------------------------------------------------

const CSS = `
.roko{--rk-body:var(--ui-surface-background);--rk-module:var(--ui-widget-surface-background,var(--ui-bg-editor));--rk-sunk:color-mix(in oklab,var(--rk-body) 95%,var(--rk-ink));--rk-ink:var(--ui-text-primary);--rk-ink-2:var(--ui-text-secondary);--rk-ink-3:var(--ui-text-tertiary);--rk-ink-4:var(--ui-text-quaternary);--rk-stroke:var(--ui-stroke-tertiary);--rk-stroke-2:var(--ui-stroke-secondary);--rk-stroke-soft:var(--ui-stroke-quaternary);--rk-agent:var(--ui-blue);--rk-pass:var(--ui-green);--rk-you:var(--ui-orange);--rk-fail:var(--ui-red);--rk-well:color-mix(in oklab,black 93%,white);--rk-well-2:color-mix(in oklab,black 84%,white);--rk-px-off:color-mix(in oklab,white 8%,transparent);--rk-px-on:color-mix(in oklab,white 88%,var(--ui-orange));--rk-px-dim:color-mix(in oklab,white 34%,transparent);--rk-px-agent:color-mix(in oklab,var(--ui-blue) 70%,white);--rk-px-pass:color-mix(in oklab,var(--ui-green) 72%,white);--rk-px-you:color-mix(in oklab,var(--ui-orange) 86%,white);--rk-px-fail:color-mix(in oklab,var(--ui-red) 78%,white);--rk-radius:2px;--rk-radius-m:4px;--rk-mono:var(--font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);--rk-ease:cubic-bezier(.2,.75,.25,1);--roko-good:var(--rk-pass);--roko-bad:var(--rk-fail);--roko-warn:var(--rk-you);--roko-live:var(--rk-agent);--roko-muted:var(--rk-ink-3);--roko-line:var(--rk-stroke);--roko-line-soft:var(--rk-stroke-soft);--roko-surface:var(--rk-module);--roko-sunk:var(--rk-sunk);--roko-mono:var(--rk-mono);--roko-ease:var(--rk-ease)}
.roko-page{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;background:var(--rk-body);color:var(--rk-ink);font-size:13px;container-type:inline-size}

/* -- the control surface: module labels, wells, dots, lights, keys -------------- */
.rk-mod{display:flex;align-items:baseline;gap:6px;min-width:0;font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;line-height:1;color:var(--rk-ink-3);white-space:nowrap}
.rk-mod-n{color:var(--rk-ink-4);font-variant-numeric:tabular-nums}
.rk-mod-label{overflow:hidden;text-overflow:ellipsis}
.rk-mod-right{margin-left:auto;letter-spacing:.02em;text-transform:none;font-weight:500}
.rk-well{position:relative;display:flex;align-items:center;gap:10px;min-width:0;padding:7px 10px;border-radius:var(--rk-radius);background:linear-gradient(180deg,var(--rk-well-2),var(--rk-well) 46%);box-shadow:inset 0 0 0 1px black,inset 0 1px 0 0 color-mix(in oklab,white 9%,transparent),0 1px 0 0 color-mix(in oklab,var(--rk-ink) 7%,transparent);color:var(--rk-px-on)}
.rk-well .rk-mod{color:var(--rk-px-dim)}.rk-well .rk-mod-n{color:color-mix(in oklab,white 22%,transparent)}
.rk-dots{display:block;flex:none;overflow:visible;--rk-px:var(--rk-px-on)}
.rk-dots[data-tone=agent]{--rk-px:var(--rk-px-agent)}.rk-dots[data-tone=pass]{--rk-px:var(--rk-px-pass)}.rk-dots[data-tone=you]{--rk-px:var(--rk-px-you)}.rk-dots[data-tone=fail]{--rk-px:var(--rk-px-fail)}.rk-dots[data-tone=off]{--rk-px:var(--rk-px-dim)}
.rk-dots-off{fill:none;stroke:var(--rk-px-off);stroke-linecap:round}
.rk-dots-on{fill:none;stroke:var(--rk-px);stroke-linecap:round;filter:drop-shadow(0 0 1.6px color-mix(in oklab,var(--rk-px) 70%,transparent))}
.rk-dots-on[data-roll=true]{animation:rk-roll .16s var(--rk-ease)}
.rk-led{position:relative;display:inline-block;flex:none;width:8px;height:8px;border-radius:999px;background:color-mix(in oklab,var(--rk-ink) 12%,transparent);box-shadow:inset 0 0 0 1px color-mix(in oklab,var(--rk-ink) 22%,transparent);--rk-led:var(--rk-ink-3)}
.rk-led[data-size=s]{width:6px;height:6px}
.rk-led[data-tone=agent]{--rk-led:var(--rk-agent)}.rk-led[data-tone=pass]{--rk-led:var(--rk-pass)}.rk-led[data-tone=you]{--rk-led:var(--rk-you)}.rk-led[data-tone=fail]{--rk-led:var(--rk-fail)}.rk-led[data-tone=ink]{--rk-led:var(--rk-ink-2)}
.rk-led:not([data-tone=off]){background:var(--rk-led);box-shadow:0 0 0 1px color-mix(in oklab,var(--rk-led) 35%,transparent),0 0 7px 1px color-mix(in oklab,var(--rk-led) 55%,transparent)}
.rk-led[data-blink=slow]{animation:rk-blink 1.2s steps(1,end) infinite}.rk-led[data-blink=fast]{animation:rk-blink .5s steps(1,end) infinite}
.rk-key{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 12px;border:1px solid var(--rk-stroke-2);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12px;font-weight:600;letter-spacing:.01em;white-space:nowrap;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);transition:transform 80ms var(--rk-ease),box-shadow 80ms var(--rk-ease),background-color .14s}
.rk-key:hover:not(:disabled){background:color-mix(in oklab,var(--rk-module) 90%,var(--rk-ink))}
.rk-key:active:not(:disabled){transform:translateY(2px);box-shadow:0 0 0 0 var(--rk-stroke-2)}
.rk-key:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.rk-key:disabled{opacity:.42;cursor:default;box-shadow:0 1px 0 0 var(--rk-stroke)}
.rk-key[aria-pressed=true]{transform:translateY(1px);box-shadow:inset 0 2px 0 0 color-mix(in oklab,var(--rk-ink) 10%,transparent),0 1px 0 0 var(--rk-stroke-2);background:color-mix(in oklab,var(--rk-module) 82%,var(--rk-ink));border-color:var(--rk-ink-3)}
.rk-key[aria-pressed=true]::before{content:"";position:absolute;top:3px;right:3px;width:4px;height:4px;border-radius:50%;background:var(--rk-you);box-shadow:0 0 5px var(--rk-you)}
.rk-key[data-tone=primary]{border-color:color-mix(in oklab,var(--rk-you) 72%,black);background:var(--rk-you);color:color-mix(in oklab,black 88%,var(--rk-you));box-shadow:0 2px 0 0 color-mix(in oklab,var(--rk-you) 52%,black)}
.rk-key[data-tone=primary]:hover:not(:disabled){background:color-mix(in oklab,var(--rk-you) 90%,white)}
.rk-key[data-tone=primary]:active:not(:disabled){box-shadow:0 0 0 0 transparent}
.rk-key[data-size=s]{height:24px;padding:0 9px;font-size:11.5px}.rk-key[data-size=l]{height:32px;padding:0 14px;font-size:12.5px}.rk-key[data-size=xl]{height:40px;padding:0 20px;font-size:13.5px}
.rk-key-kbd,.rk-key-engrave{display:inline-flex;align-items:center;height:15px;padding:0 4px;border:1px solid color-mix(in oklab,currentColor 32%,transparent);border-radius:2px;font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.04em;opacity:.78}
.rk-key-engrave{color:var(--rk-ink-3)}
.rk-tag{display:inline-flex;align-items:center;flex:none;height:16px;padding:0 5px;border-radius:var(--rk-radius);border:1px solid color-mix(in oklab,var(--rk-tag,var(--rk-ink-3)) 45%,transparent);color:var(--rk-tag,var(--rk-ink-3));font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.rk-tag[data-channel=agent]{--rk-tag:var(--rk-agent)}.rk-tag[data-channel=pass]{--rk-tag:var(--rk-pass)}.rk-tag[data-channel=you]{--rk-tag:var(--rk-you)}.rk-tag[data-channel=fail]{--rk-tag:var(--rk-fail)}.rk-tag[data-channel=ink]{--rk-tag:var(--rk-ink-3)}
.rk-key[data-tone=primary] .rk-tag{color:inherit;border-color:currentColor;background:color-mix(in oklab,currentColor 14%,transparent)}
.rk-strip{display:inline-flex;align-items:center;gap:2px;flex:none}
.rk-strip i{display:block;width:6px;height:6px;border-radius:1px;border:1px solid var(--rk-stroke-2)}
.rk-strip i[data-state=skipped]{background:var(--rk-ink-4);border-color:transparent}.rk-strip i[data-state=passed]{background:var(--rk-pass);border-color:transparent}.rk-strip i[data-state=failed]{background:var(--rk-fail);border-color:transparent}.rk-strip i[data-state=running]{background:var(--rk-agent);border-color:transparent;animation:rk-blink 1.2s steps(1,end) infinite}.rk-strip i[data-state=blocked]{border-color:var(--rk-fail);border-style:dashed}.rk-strip i[data-state=unverified]{border-color:var(--rk-you)}.rk-strip i[data-state=stopped]{background:var(--rk-ink-4);border-color:transparent}.rk-strip i[data-state=waiting]{background:var(--rk-you);border-color:transparent;box-shadow:0 0 5px -1px var(--rk-you);animation:rk-blink .5s steps(1,end) infinite}
.rk-module{display:flex;flex-direction:column;gap:8px;min-width:0;padding:10px 12px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module)}
.rk-module[data-off=true]{opacity:.55}
.rk-hint{font-size:11px;color:var(--rk-ink-3)}
.rk-loader{width:28px;height:28px;color:var(--rk-px-agent)}

/* -- header strip -------------------------------------------------------------- */
.roko-page-head{display:flex;align-items:center;justify-content:space-between;gap:18px;padding:14px 22px 12px;border-bottom:1px solid var(--rk-stroke)}
.roko-head-main{display:flex;flex-direction:column;gap:6px;min-width:0}
.roko-head-actions{display:flex;align-items:center;gap:8px;flex:none}
.roko-title-row{display:flex;align-items:center;gap:9px;min-width:0}
.roko-title{margin:0;font-size:19px;font-weight:700;letter-spacing:-.035em;color:var(--rk-ink);line-height:1}
.roko-logo{flex:none;overflow:visible}
.roko-logo-edge{fill:none;stroke:color-mix(in oklab,var(--rk-ink) 45%,transparent);stroke-width:1.5;stroke-linecap:round}
.roko-logo-node{fill:var(--rk-body);stroke:var(--rk-ink);stroke-width:1.7}
.roko-logo-end{fill:var(--rk-you);stroke:var(--rk-you)}
.roko-conn{font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-sub{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;font-size:11.5px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.rk-livetag{display:inline-flex;align-items:center;gap:6px;font-family:var(--rk-mono);font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-3)}
.rk-livetag[data-state=open]{color:var(--rk-agent)}
.rk-spendmod{display:flex;flex:0 1 auto;flex-direction:column;gap:5px;min-width:0}
.rk-spendmod-row{display:flex;align-items:center;gap:10px}
.rk-spendmod-well{padding:6px 9px}
.rk-spendmod-line{overflow:hidden;font-size:11px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap;text-overflow:ellipsis}
@container (max-width:1000px){.rk-spendmod-meter{display:none}}
@container (max-width:760px){.rk-spendmod,.roko-conn{display:none}}
.rk-segmeter{display:inline-flex;align-items:stretch;gap:2px;height:16px}
.rk-segmeter i{display:block;width:5px;border-radius:1px;background:color-mix(in oklab,var(--rk-ink) 9%,transparent)}
.rk-segmeter i[data-seg=spent]{background:var(--rk-pass);box-shadow:0 0 5px -1px var(--rk-pass)}
.rk-segmeter[data-level=you] i[data-seg=spent]{background:var(--rk-you);box-shadow:0 0 5px -1px var(--rk-you)}.rk-segmeter[data-level=fail] i[data-seg=spent]{background:var(--rk-fail);box-shadow:0 0 5px -1px var(--rk-fail)}
.rk-segmeter i[data-seg=committed]{background:repeating-linear-gradient(0deg,color-mix(in oklab,var(--rk-pass) 55%,transparent) 0 2px,transparent 2px 4px)}
.rk-soundkey{display:inline-grid;place-items:center;width:30px;height:30px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius);background:transparent;color:var(--rk-ink-3);cursor:pointer;transition:color .14s,border-color .14s}
.rk-soundkey:hover{color:var(--rk-ink)}.rk-soundkey[aria-pressed=true]{color:var(--rk-you);border-color:color-mix(in oklab,var(--rk-you) 50%,transparent)}
.roko-tabs{padding:8px 22px 4px}
.roko-tabs [data-slot=tabs-list]{align-self:flex-start}
.roko-tab-count{margin-left:4px}
.rk-count-you{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:16px;padding:0 4px;border-radius:var(--rk-radius);background:var(--rk-you);color:color-mix(in oklab,black 88%,var(--rk-you));font-family:var(--rk-mono);font-size:10px;font-weight:700;font-variant-numeric:tabular-nums;box-shadow:0 0 6px -1px var(--rk-you)}
.roko-tab-live{display:inline-flex;margin-left:6px}
.roko-tab-n{margin-left:5px;font-family:var(--rk-mono);font-size:10px;color:var(--rk-agent)}
.roko-body{flex:1;min-height:0;overflow:auto;padding:10px 22px 36px;display:flex;flex-direction:column;gap:12px;scroll-behavior:smooth}
.rk-boot{display:flex;align-items:center;gap:12px;padding:30px;justify-content:center}
.roko-notes{display:flex;flex-direction:column;gap:8px}
.roko-stack{display:flex;flex-direction:column;gap:10px;min-width:0}
.roko-narrow{width:100%;max-width:1000px}
.roko-center{display:flex;justify-content:center}
.roko-quiet{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--rk-ink-3)}
.roko-offline-hint{display:block;margin-bottom:2px;color:var(--rk-ink-2)}

/* -- the track list ------------------------------------------------------------ */
.roko-split{display:grid;grid-template-columns:minmax(240px,300px) minmax(0,1fr);gap:20px;align-items:start}
@container (max-width:860px){.roko-split{grid-template-columns:minmax(0,1fr)}.roko-listcol{position:static}}
.roko-listcol{position:sticky;top:0;display:flex;flex-direction:column;gap:6px;min-width:0}
.roko-list{display:flex;flex-direction:column;gap:0;min-width:0;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module);overflow:hidden}
.roko-list-section{display:flex;align-items:center;justify-content:space-between;padding:9px 12px 5px;font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.16em;text-transform:uppercase;color:var(--rk-ink-4);border-top:1px solid var(--rk-stroke-soft)}
.roko-list-section:first-child{border-top:0}
.roko-list-section span{font-variant-numeric:tabular-nums;letter-spacing:.04em}
.roko-list-keys{display:flex;align-items:center;flex-wrap:wrap;gap:4px;padding:8px 4px 0;font-size:11px;color:var(--rk-ink-4)}
.roko-list-keys span{margin-right:8px}
.roko-detail{min-width:0}
.roko-row-wrap{display:block;border-top:1px solid var(--rk-stroke-soft)}
.roko-list-section+.roko-row-wrap{border-top:0}
.roko-row{position:relative;display:flex;align-items:center;gap:10px;width:100%;padding:9px 12px;border:0;background:transparent;color:var(--rk-ink-2);font:inherit;text-align:left;cursor:pointer;transition:background-color .14s var(--rk-ease)}
.roko-row:hover{background:var(--ui-row-hover-background);color:var(--rk-ink)}
.roko-row[data-active=true]{background:color-mix(in oklab,var(--rk-ink) 6%,transparent);color:var(--rk-ink)}
.roko-row[data-active=true]::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--rk-you)}
.roko-row:focus-visible{outline:2px solid var(--rk-you);outline-offset:-2px}
.roko-row-lead{flex:none;display:inline-grid;place-items:center;width:14px;height:18px}
.roko-row-icon{color:var(--rk-ink-3)}
.roko-row-main{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1}
.roko-row-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;color:var(--rk-ink)}
.roko-row-meta{display:flex;gap:7px;font-size:11px;color:var(--rk-ink-3);white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}
.roko-row-meta [data-tone=good]{color:var(--rk-pass)}.roko-row-meta [data-tone=bad]{color:var(--rk-fail)}.roko-row-meta [data-tone=warn]{color:var(--rk-you)}.roko-row-meta [data-tone=live]{color:var(--rk-agent)}
.rk-row-side{display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex:none}
.rk-row-spend{font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}

/* -- cards, pills, small parts ------------------------------------------------- */
.roko-card{display:flex;flex-direction:column;gap:10px;min-width:0;padding:14px 16px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module);color:var(--rk-ink)}
.roko-card[data-compact=true]{gap:8px;padding:11px 13px}
.roko-run-head{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}
.roko-run-title{flex:1;min-width:0;font-weight:650;font-size:13.5px;line-height:1.35;overflow-wrap:anywhere}
.roko-card[data-compact=true] .roko-run-title{font-size:13px}
.roko-headline{font-family:var(--rk-mono);font-size:10.5px;letter-spacing:.02em;color:var(--rk-ink-3);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}
.roko-pill{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:var(--rk-radius);border:1px solid color-mix(in oklab,var(--rk-pill,var(--rk-ink-3)) 40%,transparent);font-family:var(--rk-mono);font-size:10px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;white-space:nowrap;color:var(--rk-pill,var(--rk-ink-2));--rk-pill:var(--rk-ink-3)}
.roko-pill[data-tone=good]{--rk-pill:var(--rk-pass)}.roko-pill[data-tone=bad]{--rk-pill:var(--rk-fail)}.roko-pill[data-tone=warn]{--rk-pill:var(--rk-you)}.roko-pill[data-tone=live]{--rk-pill:var(--rk-agent)}
.roko-pill-glyph{display:inline-block}
.roko-pill[data-state=running] .roko-pill-glyph{animation:roko-spin 1.6s linear infinite}
.roko-kind{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-ink) 7%,transparent);color:var(--rk-ink-3);font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}
.roko-glyph{display:inline-flex;justify-content:center;width:14px;flex:none;font-weight:700;color:var(--rk-ink-3)}
.roko-glyph[data-tone=good]{color:var(--rk-pass)}.roko-glyph[data-tone=bad]{color:var(--rk-fail)}.roko-glyph[data-tone=warn]{color:var(--rk-you)}.roko-glyph[data-tone=live]{color:var(--rk-agent)}
.roko-dot{position:relative;display:inline-block;width:8px;height:8px;flex:none;border-radius:999px;background:color-mix(in oklab,var(--rk-ink) 22%,transparent);--rk-led:var(--rk-ink-3)}
.roko-dot[data-tone=good]{--rk-led:var(--rk-pass)}.roko-dot[data-tone=bad]{--rk-led:var(--rk-fail)}.roko-dot[data-tone=warn]{--rk-led:var(--rk-you)}.roko-dot[data-tone=live]{--rk-led:var(--rk-agent)}
.roko-dot:not([data-tone=muted]){background:var(--rk-led);box-shadow:0 0 0 1px color-mix(in oklab,var(--rk-led) 35%,transparent),0 0 7px 1px color-mix(in oklab,var(--rk-led) 50%,transparent)}
.roko-dot[data-pulse=true]{animation:rk-blink 1.2s steps(1,end) infinite}
.roko-tone-good{color:var(--rk-pass)}.roko-tone-bad{color:var(--rk-fail)}.roko-tone-warn{color:var(--rk-you)}.roko-tone-live{color:var(--rk-agent)}
.roko-stats{display:flex;flex-wrap:wrap;align-items:center;gap:6px 18px;font-size:12px;color:var(--rk-ink-2);font-variant-numeric:tabular-nums}
.roko-stat{display:inline-flex;align-items:center;gap:4px}
.roko-stat-label{font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;color:var(--rk-ink-4)}
.roko-estimate{padding:2px 8px;border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-ink) 6%,transparent);font-family:var(--rk-mono);font-size:11px}
.roko-meter{display:inline-flex;align-items:center;gap:9px;font-variant-numeric:tabular-nums}
.roko-meter-text{white-space:nowrap;font-family:var(--rk-mono);font-size:11px}
.roko-meter-track{position:relative;width:100px;height:10px;overflow:hidden;background:color-mix(in oklab,var(--rk-ink) 9%,transparent);-webkit-mask:repeating-linear-gradient(90deg,black 0 4px,transparent 4px 5px);mask:repeating-linear-gradient(90deg,black 0 4px,transparent 4px 5px)}
.roko-meter[data-compact=true] .roko-meter-track{width:55px;height:8px}
.roko-meter-fill{position:absolute;left:0;top:0;bottom:0;background:var(--rk-pass);transition:width .6s var(--rk-ease)}
.roko-meter-ghost{position:absolute;left:0;top:0;bottom:0;background:color-mix(in oklab,var(--rk-pass) 40%,transparent);transition:width .6s var(--rk-ease)}
.roko-meter-tick{position:absolute;left:80%;top:0;bottom:0;width:4px;background:color-mix(in oklab,var(--rk-you) 35%,transparent)}
.roko-meter[data-level=warn] .roko-meter-fill{background:var(--rk-you)}.roko-meter[data-level=warn] .roko-strong{color:var(--rk-you)}
.roko-meter[data-level=bad] .roko-meter-fill{background:var(--rk-fail)}.roko-meter[data-level=bad] .roko-strong{color:var(--rk-fail)}
.roko-meter[data-level=none] .roko-meter-track{opacity:.5}
.rk-well .roko-meter-text{color:var(--rk-px-dim)}.rk-well .roko-meter-text .roko-strong{color:var(--rk-px-on)}
.rk-well .roko-meter-track{background:color-mix(in oklab,white 10%,transparent)}
.rk-well .roko-meter-fill{background:var(--rk-px-pass);box-shadow:0 0 6px var(--rk-px-pass)}.rk-well .roko-meter-ghost{background:color-mix(in oklab,var(--rk-px-pass) 35%,transparent)}
.rk-well .roko-meter[data-level=warn] .roko-meter-fill{background:var(--rk-px-you)}.rk-well .roko-meter[data-level=bad] .roko-meter-fill{background:var(--rk-px-fail)}
.rk-well .roko-meter[data-level=warn] .roko-strong{color:var(--rk-px-you)}.rk-well .roko-meter[data-level=bad] .roko-strong{color:var(--rk-px-fail)}
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
.roko-model{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:var(--rk-radius);border:1px solid color-mix(in oklab,var(--rk-agent) 30%,transparent);color:var(--rk-ink);font-family:var(--rk-mono);font-size:11px;white-space:nowrap}
.roko-model .codicon{color:var(--rk-agent)}
.roko-keys{display:inline-flex;margin-left:4px;opacity:.85}
.roko-branch{display:inline-flex;align-items:center;gap:4px;font-family:var(--rk-mono);font-size:11.5px;color:var(--rk-ink-2)}
.roko-path{display:inline-flex;min-width:0;overflow:hidden;white-space:nowrap;font-family:var(--rk-mono);font-size:11.5px}
.roko-path-dir{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--rk-ink-3)}
.roko-path-base{flex:none;color:var(--rk-ink);font-weight:550}
.roko-diffstat{display:inline-flex;align-items:center;gap:6px;font-family:var(--rk-mono);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.roko-add{color:var(--rk-pass)}.roko-del{color:var(--rk-fail)}
.roko-statcells{display:inline-flex;gap:1.5px}
.roko-statcells span{width:6px;height:6px;border-radius:1px;background:color-mix(in oklab,var(--rk-ink) 10%,transparent)}
.roko-statcells span[data-kind=add]{background:var(--rk-pass)}.roko-statcells span[data-kind=del]{background:var(--rk-fail)}

/* -- the run instrument: hero, display bar, ticker, scope ---------------------- */
.roko-mission{gap:12px;padding:16px 18px 12px}
.roko-hero{display:flex;flex-direction:column;gap:9px}
.roko-hero-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-height:26px}
.roko-hero-title{margin:2px 0 0;font-size:20px;line-height:1.2;font-weight:650;letter-spacing:-.022em;color:var(--rk-ink);overflow-wrap:anywhere;text-wrap:balance}
.roko-hero-slug{display:inline-flex;align-items:center;gap:5px;margin-top:-4px;font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-3)}
.roko-hero-request{display:flex;gap:7px;align-items:flex-start;margin:0;max-width:78ch;font-size:12.5px;line-height:1.55;color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-hero-request .codicon{flex:none;margin-top:3px;color:var(--rk-ink-4)}
.rk-display{min-width:0}
.rk-display-well{display:flex;align-items:stretch;flex-wrap:wrap;gap:0;padding:0}
.rk-cell{display:flex;flex:1 1 auto;flex-direction:column;justify-content:flex-start;gap:7px;min-width:0;padding:10px 14px 10px 12px;border-right:1px solid color-mix(in oklab,white 7%,transparent)}
.rk-cell:last-child{border-right:0}
.rk-cell-row{display:flex;align-items:center;gap:9px}
.rk-cell-sub{display:inline-flex;gap:8px;font-family:var(--rk-mono);font-size:9.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--rk-px-dim);white-space:nowrap}
.rk-cell-sub [data-channel=agent]{color:var(--rk-px-agent)}.rk-cell-sub [data-channel=fail]{color:var(--rk-px-fail)}.rk-cell-sub [data-channel=you]{color:var(--rk-px-you)}.rk-cell-sub [data-channel=pass]{color:var(--rk-px-pass)}
.rk-cell-spend .roko-meter{margin-top:1px}
.rk-cell-model{max-width:260px}
.rk-cell-model-name{font-family:var(--rk-mono);font-size:13px;font-weight:600;letter-spacing:.02em;color:var(--rk-px-on);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:20px}
.rk-cell-scope{flex:1 0 110px;max-width:100%;border-left:1px solid color-mix(in oklab,white 7%,transparent);border-right:0}
.rk-cell-scope .rk-scope-svg{width:100%}
.rk-cell-spend .roko-meter-track{width:72px}
.rk-cell-scope .rk-scope,.rk-monitor-display .rk-scope{padding:0;background:none;box-shadow:none}
.rk-well .roko-ring-track{stroke:color-mix(in oklab,white 11%,transparent)}
.rk-well .roko-ring-arc[data-kind=passed]{stroke:var(--rk-px-pass)}.rk-well .roko-ring-arc[data-kind=failed]{stroke:var(--rk-px-fail)}.rk-well .roko-ring-arc[data-kind=running]{stroke:var(--rk-px-agent)}.rk-well .roko-ring-arc[data-kind=blocked],.rk-well .roko-ring-arc[data-kind=unverified]{stroke:var(--rk-px-you)}
.rk-ticker{gap:10px;min-height:34px;padding:7px 12px;font-family:var(--rk-mono);font-size:11.5px;overflow:hidden}
.rk-ticker-lane{display:flex;align-items:center;justify-content:flex-end;gap:16px;flex:1;min-width:0;overflow:hidden;white-space:nowrap;-webkit-mask:linear-gradient(90deg,transparent,black 22%);mask:linear-gradient(90deg,transparent,black 22%)}
.rk-ticker-item{flex:none;color:color-mix(in oklab,white 30%,transparent)}
.rk-ticker-item b{margin-right:3px;font-weight:700;color:inherit}
.rk-ticker-item[data-age="0"]{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--rk-px-on);animation:rk-tick-in .24s var(--rk-ease)}
.rk-ticker-item[data-age="0"] b{color:var(--rk-px-agent)}
.rk-ticker-item[data-age="1"]{color:color-mix(in oklab,white 52%,transparent)}
.rk-ticker-item[data-kind=text],.rk-ticker-item[data-kind=reasoning]{font-style:italic}
.rk-ticker-item[data-kind=idle]{color:var(--rk-px-dim)}
.rk-ticker-item[data-channel=you],.rk-ticker-item[data-channel=you] b{color:var(--rk-px-you)}
.rk-ticker-item:has(>.rk-said){display:inline-flex;align-items:baseline}
.rk-ticker-item>b{flex:none}
.rk-said{display:inline-flex;justify-content:flex-end;min-width:0;overflow:hidden}
.rk-said>span{flex:none;white-space:nowrap}
.rk-scope{padding:3px 5px}
.rk-scope-svg{display:block;overflow:visible}
.rk-scope-grid{stroke:color-mix(in oklab,white 6%,transparent);stroke-width:1;vector-effect:non-scaling-stroke}
.rk-scope-axis{stroke:color-mix(in oklab,white 12%,transparent)}
.rk-scope-trace{fill:none;stroke:var(--rk-scope,var(--rk-px-agent));stroke-width:1.5;vector-effect:non-scaling-stroke;stroke-linejoin:round;stroke-linecap:round;filter:drop-shadow(0 0 2.5px var(--rk-scope,var(--rk-px-agent)))}
.rk-scope[data-tone=pass]{--rk-scope:var(--rk-px-pass)}.rk-scope[data-tone=fail]{--rk-scope:var(--rk-px-fail)}.rk-scope[data-tone=you]{--rk-scope:var(--rk-px-you)}.rk-scope[data-tone=ink]{--rk-scope:var(--rk-px-on)}
.roko-clock{font-family:var(--rk-mono);font-size:inherit;font-variant-numeric:tabular-nums;color:inherit}
.roko-stepclock{font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.roko-ring{position:relative;display:inline-grid;place-items:center;flex:none}
.roko-ring svg{display:block;overflow:visible}
.roko-ring-track{stroke:color-mix(in oklab,var(--rk-ink) 10%,transparent)}
.roko-ring-arc{transition:stroke-dasharray .6s var(--rk-ease),stroke-dashoffset .6s var(--rk-ease);stroke:var(--rk-ink-3)}
.roko-ring-arc[data-kind=skipped]{stroke:var(--rk-ink-4)}.roko-ring-arc[data-kind=passed]{stroke:var(--rk-pass)}.roko-ring-arc[data-kind=failed]{stroke:var(--rk-fail)}.roko-ring-arc[data-kind=blocked],.roko-ring-arc[data-kind=unverified]{stroke:var(--rk-you)}.roko-ring-arc[data-kind=stopped]{stroke:var(--rk-ink-4)}
.roko-ring-arc[data-kind=running]{stroke:var(--rk-agent);animation:roko-pulse 1.6s ease-in-out infinite}
.roko-ring-label{position:absolute;font-size:11px;font-weight:650;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.roko-ring-label i{font-style:normal;font-weight:500;color:var(--rk-ink-3)}
.roko-segbar{display:flex;gap:2px;width:100%;overflow:hidden}
.roko-segbar-seg{min-width:3px;border-radius:1px;background:color-mix(in oklab,var(--rk-ink) 10%,transparent)}
.roko-segbar-seg[data-kind=passed]{background:var(--rk-pass)}.roko-segbar-seg[data-kind=failed]{background:var(--rk-fail)}.roko-segbar-seg[data-kind=blocked],.roko-segbar-seg[data-kind=unverified]{background:var(--rk-you)}.roko-segbar-seg[data-kind=running]{background:var(--rk-agent)}
.roko-why{display:flex;gap:11px;align-items:flex-start;padding:12px 14px;border-radius:var(--rk-radius-m);border:1px solid color-mix(in oklab,var(--roko-why) 40%,transparent);border-left-width:3px;background:color-mix(in oklab,var(--roko-why) 6%,transparent);--roko-why:var(--rk-ink-3)}
.roko-why[data-tone=bad]{--roko-why:var(--rk-fail)}.roko-why[data-tone=warn]{--roko-why:var(--rk-you)}
.roko-why-icon{flex:none;margin-top:1px;color:var(--roko-why)}
.roko-why-body{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0}
.roko-why-title{font-family:var(--rk-mono);font-size:10px;font-weight:650;letter-spacing:.12em;text-transform:uppercase;color:var(--roko-why)}
.roko-why-text{margin:0;font-size:12.5px;line-height:1.6;color:var(--rk-ink);overflow-wrap:anywhere}
.roko-now{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.roko-now-label{display:inline-flex;align-items:center;gap:7px;padding-right:2px;font-family:var(--rk-mono);font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--rk-agent)}
.roko-now-item{display:inline-flex;align-items:center;gap:7px;min-width:0;max-width:100%;height:24px;padding:0 9px;border:1px solid color-mix(in oklab,var(--rk-agent) 30%,transparent);border-radius:var(--rk-radius);background:transparent;color:var(--rk-ink-2);font:inherit;font-size:12px;cursor:pointer}
.roko-now-item:hover{border-color:var(--rk-agent);color:var(--rk-ink)}
.roko-now-title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rk-ink)}
.roko-now-step{color:var(--rk-agent);font-weight:550;white-space:nowrap}
.roko-now-idle{font-size:12px;color:var(--rk-ink-2)}
.roko-now-label[data-channel=you]{color:var(--rk-you)}
.roko-now-item[data-channel=you]{border-color:color-mix(in oklab,var(--rk-you) 45%,transparent)}.roko-now-item[data-channel=you]:hover{border-color:var(--rk-you)}.roko-now-item[data-channel=you] .roko-now-step{color:var(--rk-you)}
.roko-now-idle[data-channel=you]{color:var(--rk-you);font-weight:600}
.rk-tag-you{gap:5px}
.roko-waiting-block{display:flex;flex-direction:column;gap:8px}
.roko-runtabs{display:flex;align-items:center;gap:2px;margin-top:2px;border-bottom:1px solid var(--rk-stroke)}
.roko-runtab{position:relative;display:inline-flex;align-items:center;gap:7px;padding:8px 12px 9px;border:0;background:none;color:var(--rk-ink-3);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer;transition:color .14s}
.roko-runtab:hover{color:var(--rk-ink)}
.roko-runtab[aria-selected=true]{color:var(--rk-ink)}
.roko-runtab[aria-selected=true]::after{content:"";position:absolute;left:8px;right:8px;bottom:-1px;height:2px;background:var(--rk-you)}
.roko-runtab:focus-visible{outline:2px solid var(--rk-you);outline-offset:-2px}
.roko-runtab-n{font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.06em;color:var(--rk-ink-4)}
.roko-runtab[aria-selected=true] .roko-runtab-n{color:var(--rk-you)}
.roko-runtab-count{min-width:18px;padding:0 5px;border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-ink) 8%,transparent);color:var(--rk-ink-2);font-family:var(--rk-mono);font-size:10px;text-align:center;font-variant-numeric:tabular-nums}
.roko-runtabs-hint{display:inline-flex;gap:3px;opacity:.7}
.roko-runbody{min-width:0;animation:roko-rise .2s var(--rk-ease)}
.roko-run-foot{display:flex;flex-wrap:wrap;align-items:center;gap:4px 14px;padding-top:6px;border-top:1px solid var(--rk-stroke-soft)}
.roko-run-foot .roko-muted{font-size:11px}

/* -- the sequencer ------------------------------------------------------------- */
.roko-overview{display:flex;flex-direction:column;gap:14px}
.roko-overview-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
.roko-overview-col{display:flex;flex-direction:column;gap:8px;min-width:0}
.roko-graph-card{display:flex;flex-direction:column;gap:10px;min-width:0}
.roko-graph-empty{flex-direction:row;align-items:center;justify-content:center;gap:12px;min-height:120px;border-radius:var(--rk-radius-m);border:1px dashed var(--rk-stroke);color:var(--rk-ink-3);font-size:12.5px}
.roko-graph-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:24px}
.roko-graph-title{font-family:var(--rk-mono);font-size:10px;font-weight:600;letter-spacing:.1em;color:var(--rk-ink-3)}
.roko-graph-hint{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--rk-ink-3)}
.roko-legend{display:inline-flex;flex-wrap:wrap;gap:4px 11px;font-size:11px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.roko-legend-item{display:inline-flex;align-items:center;gap:5px}
.roko-legend-item i{width:7px;height:7px;border-radius:1px;border:1px solid var(--rk-stroke-2)}
.roko-legend-item[data-kind=passed] i{background:var(--rk-pass);border-color:transparent}.roko-legend-item[data-kind=failed] i{background:var(--rk-fail);border-color:transparent}.roko-legend-item[data-kind=running] i{background:var(--rk-agent);border-color:transparent}.roko-legend-item[data-kind=blocked] i{border-style:dashed;border-color:var(--rk-fail)}
.roko-graph-frame{position:relative;overflow-x:auto;overflow-y:hidden;padding:4px 0;border-radius:var(--rk-radius-m);border:1px solid var(--rk-stroke);background:radial-gradient(color-mix(in oklab,var(--rk-ink) 9%,transparent) .9px,transparent 1.2px) 0 0/12px 12px,var(--rk-sunk)}
.roko-graph{position:relative;margin:0 auto}
.rk-step-col{position:absolute;bottom:0;border-radius:var(--rk-radius);transition:background-color .3s}
.rk-step-col[data-active=true]{background:color-mix(in oklab,var(--rk-agent) 6%,transparent)}
.rk-step-col[data-done=true]{background:color-mix(in oklab,var(--rk-ink) 2.5%,transparent)}
.roko-graph-edges{position:absolute;left:0;top:0;overflow:visible;pointer-events:none}
.roko-wave-label{font-family:var(--rk-mono);font-size:9.5px;font-weight:650;letter-spacing:.16em;fill:var(--rk-ink-4)}
.roko-wave-label[data-active=true]{fill:var(--rk-agent)}
.roko-wave-label-html{position:absolute;top:6px;color:var(--rk-ink-4)}
.rk-playhead{position:absolute;z-index:1;width:2px;border-radius:1px;background:var(--rk-you);box-shadow:0 0 8px 0 var(--rk-you);pointer-events:none;transition:left .45s var(--rk-ease)}
.rk-playhead[data-mode=live]{animation:rk-scan 2.4s ease-in-out infinite}
.rk-playhead[data-mode=replay]{transition:left .12s linear}
.roko-edge{fill:none;stroke:var(--rk-stroke-2);stroke-width:1.3;transition:stroke .3s}
.roko-edge-end{fill:var(--rk-stroke-2);transition:fill .3s}
.roko-edge[data-state=done]{stroke:color-mix(in oklab,var(--rk-pass) 60%,var(--rk-stroke-2))}.roko-edge-end[data-state=done]{fill:color-mix(in oklab,var(--rk-pass) 70%,transparent)}
.roko-edge[data-state=live]{stroke:var(--rk-agent);stroke-width:1.5;stroke-dasharray:3 4;animation:roko-flow .9s linear infinite}.roko-edge-end[data-state=live]{fill:var(--rk-agent)}
.roko-edge[data-state=blocked],.roko-edge[data-state=broken]{stroke:color-mix(in oklab,var(--rk-fail) 50%,transparent);stroke-dasharray:2 4}.roko-edge-end[data-state=blocked],.roko-edge-end[data-state=broken]{fill:color-mix(in oklab,var(--rk-fail) 50%,transparent)}
.roko-node{position:absolute;z-index:2;display:flex;flex-direction:column;justify-content:space-between;gap:4px;padding:9px 10px 8px 11px;overflow:hidden;border:1px solid var(--rk-stroke-2);border-radius:var(--rk-radius-m);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);transition:border-color .2s var(--rk-ease),background-color .2s var(--rk-ease),box-shadow .14s var(--rk-ease),transform 80ms var(--rk-ease);--rk-node:transparent}
.roko-node::before{content:"";position:absolute;left:0;right:0;top:0;height:2px;background:var(--rk-node);transition:background-color .2s}
.roko-node[data-channel=agent]{--rk-node:var(--rk-agent)}.roko-node[data-channel=pass]{--rk-node:var(--rk-pass)}.roko-node[data-channel=you]{--rk-node:var(--rk-you)}.roko-node[data-channel=fail]{--rk-node:var(--rk-fail)}
.roko-node:hover{background:color-mix(in oklab,var(--rk-module) 94%,var(--rk-ink))}
.roko-node:active{transform:translateY(2px);box-shadow:0 0 0 0 var(--rk-stroke-2)}
.roko-node:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.roko-node[data-selected=true]{transform:translateY(1px);box-shadow:0 1px 0 0 var(--rk-stroke-2),0 0 0 2px color-mix(in oklab,var(--rk-ink) 70%,transparent)}
.roko-node[data-state=pending]{background:transparent;border-style:dashed;box-shadow:none;color:var(--rk-ink-2)}
.roko-node[data-state=pending] .roko-node-title{font-weight:500}
.roko-node[data-state=running]{border-color:var(--rk-node);box-shadow:0 2px 0 0 color-mix(in oklab,var(--rk-node) 55%,var(--rk-stroke-2)),0 0 0 1px var(--rk-node),0 0 18px -4px var(--rk-node)}
.roko-node[data-state=passed]{border-color:color-mix(in oklab,var(--rk-pass) 45%,var(--rk-stroke-2))}
.roko-node[data-state=failed]{border-color:color-mix(in oklab,var(--rk-fail) 55%,var(--rk-stroke-2));background:color-mix(in oklab,var(--rk-fail) 5%,var(--rk-module))}
.roko-node[data-state=unverified]{border-color:color-mix(in oklab,var(--rk-you) 45%,var(--rk-stroke-2))}
.roko-node[data-state=blocked]{border-style:dashed;border-color:color-mix(in oklab,var(--rk-fail) 45%,var(--rk-stroke));background:transparent;box-shadow:none;color:var(--rk-ink-3)}
.roko-node[data-state=stopped]{border-style:dashed;background:transparent;box-shadow:none;color:var(--rk-ink-3);opacity:.8}
.roko-node[data-flash=true]{animation:rk-pad-flash .32s ease-out 2}
.roko-node[data-state=plan]{--rk-node:color-mix(in oklab,var(--rk-ink) 25%,transparent)}
.roko-node-top{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;line-height:1.4;min-width:0;padding-bottom:1px}
.roko-node-head{display:flex;align-items:center;gap:6px;min-width:0}
.roko-node-id{display:inline-block;flex:none;color:var(--rk-ink);font-family:var(--rk-mono);font-size:12px;font-weight:750;letter-spacing:.02em}
.roko-node-title{font-weight:550;color:var(--rk-ink-2)}
.roko-node-mark{display:inline-flex;flex:none;font-weight:800;font-size:12px;color:var(--rk-ink-3)}
.roko-node-mark .codicon{color:inherit}
.roko-node-mark[data-tone=good]{color:var(--rk-pass)}.roko-node-mark[data-tone=bad]{color:var(--rk-fail)}.roko-node-mark[data-tone=warn]{color:var(--rk-you)}
.roko-node-spin{display:none}
.roko-node-attempts{flex:none;padding:0 4px;border-radius:var(--rk-radius);border:1px solid color-mix(in oklab,var(--rk-you) 45%,transparent);color:var(--rk-you);font-family:var(--rk-mono);font-size:10px;font-weight:700}
.roko-node-foot{display:flex;align-items:center;gap:8px;min-width:0;font-size:11px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.roko-node-meta{display:inline-flex;align-items:center;gap:4px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-node-model{font-family:var(--rk-mono);font-size:10.5px}
.roko-node-step{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-node);font-weight:600}
.roko-pips{display:inline-flex;align-items:center;gap:3px;margin-left:auto;flex:none}
.roko-pip{width:7px;height:7px;border-radius:1px;border:1.3px solid var(--rk-stroke-2);background:transparent}
.roko-pip[data-state=pass]{background:var(--rk-pass);border-color:transparent}.roko-pip[data-state=fail]{background:var(--rk-fail);border-color:transparent}
.roko-pip[data-superseded=true]{opacity:.35}
.rk-plan-questions{margin:4px 0;padding-left:18px;display:grid;gap:4px;font-size:12.5px;color:var(--rk-ink)}
.roko-pip[data-state=run]{border-color:var(--rk-agent);background:color-mix(in oklab,var(--rk-agent) 40%,transparent);animation:rk-blink 1.2s steps(1,end) infinite}
.roko-pips-more{font-size:10px;color:var(--rk-ink-3)}
.roko-mini{display:block;flex:none;overflow:visible}
.roko-mini-edge{stroke:var(--rk-stroke-2);stroke-width:1}
.roko-mini-dot{fill:transparent;stroke:var(--rk-stroke-2);stroke-width:1;transition:fill .3s}
.roko-mini-dot[data-state=passed]{fill:var(--rk-pass);stroke:transparent}.roko-mini-dot[data-state=failed]{fill:var(--rk-fail);stroke:transparent}.roko-mini-dot[data-state=running]{fill:var(--rk-agent);stroke:transparent;animation:rk-blink 1.2s steps(1,end) infinite}.roko-mini-dot[data-state=blocked]{fill:transparent;stroke:var(--rk-fail);stroke-dasharray:2 1.5}.roko-mini-dot[data-state=stopped]{fill:var(--rk-ink-4);stroke:transparent}.roko-mini-dot[data-state=waiting]{fill:var(--rk-you);stroke:transparent;animation:rk-blink .5s steps(1,end) infinite}

/* -- the inspector ------------------------------------------------------------- */
.roko-inspector{display:flex;flex-direction:column;gap:11px;padding:14px 16px;border-radius:var(--rk-radius-m);border:1px solid var(--rk-stroke-2);border-top:2px solid var(--rk-insp,var(--rk-stroke-2));background:var(--rk-module);animation:rk-slide .22s var(--rk-ease)}
.roko-inspector[data-channel=agent]{--rk-insp:var(--rk-agent)}.roko-inspector[data-channel=pass]{--rk-insp:var(--rk-pass)}.roko-inspector[data-channel=you]{--rk-insp:var(--rk-you)}.roko-inspector[data-channel=fail]{--rk-insp:var(--rk-fail)}
.roko-inspector-head{display:flex;align-items:center;gap:8px;min-width:0}
.roko-inspector-title{flex:1;min-width:0;font-weight:650;font-size:14px;overflow-wrap:anywhere}
.roko-inspector-meta{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font-size:12px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.rk-inspector-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px 18px}
.rk-inspector-col{display:flex;flex-direction:column;gap:8px;min-width:0}
.rk-route{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-sunk)}
.rk-route-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap}
.rk-route-head .codicon{color:var(--rk-agent)}
.rk-route-model{font-family:var(--rk-mono);font-size:12.5px;font-weight:700}
.rk-route-p{font-family:var(--rk-mono);font-size:11px;color:var(--rk-agent)}
.rk-route-reason{font-size:12px;line-height:1.5;color:var(--rk-ink-2);overflow-wrap:anywhere}
.rk-cands{display:flex;flex-direction:column;gap:4px}
.rk-cand{display:grid;grid-template-columns:minmax(90px,150px) minmax(60px,1fr) 38px minmax(0,120px);align-items:center;gap:8px;font-size:11px}
.rk-cand-model{font-family:var(--rk-mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rk-ink-2)}
.rk-cand[data-pick=true] .rk-cand-model{color:var(--rk-ink);font-weight:700}
.rk-cand-bar{display:block;height:6px;background:color-mix(in oklab,var(--rk-ink) 8%,transparent);-webkit-mask:repeating-linear-gradient(90deg,black 0 3px,transparent 3px 4px);mask:repeating-linear-gradient(90deg,black 0 3px,transparent 3px 4px)}
.rk-cand-bar i{display:block;height:100%;background:color-mix(in oklab,var(--rk-agent) 45%,var(--rk-ink-3))}
.rk-cand[data-pick=true] .rk-cand-bar i{background:var(--rk-agent)}
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
.roko-checkcmd{display:block;padding:5px 9px;border-radius:var(--rk-radius);background:var(--rk-sunk);border:1px solid var(--rk-stroke-soft);font-family:var(--rk-mono);font-size:11.5px;color:var(--rk-ink);overflow-wrap:anywhere}
.roko-checkcmd span{color:var(--rk-ink-4)}
.roko-pipe{display:flex;flex-direction:column;gap:7px}
.roko-pipe-row{display:flex;align-items:center;flex-wrap:wrap;row-gap:6px;font-size:11.5px}
.roko-pipe-label{width:30px;flex:none;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-4)}
.roko-pipe-stage{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 8px;border-radius:var(--rk-radius);border:1px solid var(--rk-stroke);background:var(--rk-module);color:var(--rk-ink-2);font-family:var(--rk-mono);font-size:11px;white-space:nowrap}
.roko-pipe-stage .codicon{color:var(--rk-agent)}
.roko-pipe-stage .rk-tag{margin-left:2px;height:15px;font-size:9px}
.roko-pipe-stage[data-state=pass]{border-color:color-mix(in oklab,var(--rk-pass) 45%,var(--rk-stroke));color:var(--rk-ink)}.roko-pipe-stage[data-state=pass] span{color:var(--rk-pass)}
.roko-pipe-stage[data-state=fail]{border-color:color-mix(in oklab,var(--rk-fail) 55%,var(--rk-stroke));background:color-mix(in oklab,var(--rk-fail) 6%,var(--rk-module));color:var(--rk-ink)}.roko-pipe-stage[data-state=fail] span{color:var(--rk-fail)}
.roko-pipe-stage[data-state=run]{border-color:var(--rk-agent);color:var(--rk-ink);box-shadow:0 0 0 1px color-mix(in oklab,var(--rk-agent) 35%,transparent)}.roko-pipe-stage[data-state=run] span{color:var(--rk-agent)}
.roko-pipe-link{width:14px;height:1px;flex:none;background:var(--rk-stroke-2)}
.roko-pipe-end{padding:0 6px;font-family:var(--rk-mono);font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--rk-ink-3)}
.roko-pipe-end[data-state=passed]{color:var(--rk-pass)}.roko-pipe-end[data-state=failed]{color:var(--rk-fail)}.roko-pipe-end[data-state=running]{color:var(--rk-agent)}.roko-pipe-end[data-state=blocked],.roko-pipe-end[data-state=unverified]{color:var(--rk-you)}
.roko-pipe-time{margin-left:auto;padding-left:10px;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-4)}
.roko-checkout{display:flex;flex-direction:column;gap:7px}
.roko-keyline{display:flex;gap:8px;align-items:flex-start;padding:8px 11px;border-radius:var(--rk-radius);border:1px solid color-mix(in oklab,var(--rk-fail) 30%,transparent);border-left:3px solid var(--rk-fail);background:color-mix(in oklab,var(--rk-fail) 6%,transparent);font-family:var(--rk-mono);font-size:11.5px;line-height:1.5;color:var(--rk-ink);overflow-wrap:anywhere}
.roko-keyline .codicon{flex:none;margin-top:2px;color:var(--rk-fail)}
.roko-note-block{display:flex;flex-direction:column;gap:7px}
.roko-quote{margin:0;padding:9px 13px;border-left:2px solid var(--rk-ink-3);background:var(--rk-sunk);font-size:12.5px;line-height:1.55;color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-quote .roko-clamp-text{font-style:italic;color:var(--rk-ink-2)}
.roko-deps{display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.roko-callout{display:flex;align-items:center;gap:9px;flex-wrap:wrap;padding:8px 11px;border-radius:var(--rk-radius);border:1px solid var(--rk-stroke);background:var(--rk-sunk);font-size:12px;color:var(--rk-ink-2)}
.roko-callout .codicon{flex:none}
.roko-callout[data-tone=warn],.roko-callout[data-tone=you]{border-color:color-mix(in oklab,var(--rk-you) 45%,transparent);border-left:3px solid var(--rk-you);background:color-mix(in oklab,var(--rk-you) 6%,transparent);color:var(--rk-ink)}.roko-callout[data-tone=warn] .codicon{color:var(--rk-you)}

/* -- activity, replay ---------------------------------------------------------- */
.roko-feed{position:relative;display:flex;flex-direction:column;gap:8px;min-width:0}
.roko-feed-head{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.roko-filters{display:inline-flex;flex-wrap:wrap;gap:4px}
.roko-filter{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:var(--rk-radius);border:1px solid var(--rk-stroke);background:transparent;color:var(--rk-ink-2);font:inherit;font-size:11.5px;cursor:pointer;box-shadow:0 1px 0 0 var(--rk-stroke);transition:background-color .14s,border-color .14s}
.roko-filter:hover{color:var(--rk-ink)}
.roko-filter[aria-pressed=true]{border-color:var(--rk-ink-3);background:color-mix(in oklab,var(--rk-ink) 8%,transparent);color:var(--rk-ink);box-shadow:none;transform:translateY(1px)}
.roko-filter-count{font-family:var(--rk-mono);font-size:10px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.roko-live-tag{display:inline-flex;align-items:center;gap:6px;font-family:var(--rk-mono);font-size:9.5px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--rk-agent)}
.roko-feed-list{display:flex;flex-direction:column;max-height:480px;overflow:auto;padding:6px 0;border-radius:var(--rk-radius-m);border:1px solid var(--rk-stroke);background:var(--rk-sunk);font-size:12px}
.roko-feed[data-compact=true] .roko-feed-list{max-height:none;overflow:visible}
.roko-feed-empty{padding:4px 2px}
.roko-feed-row{display:grid;grid-template-columns:50px 16px minmax(0,1fr);gap:7px;align-items:baseline;padding:3px 12px 3px 6px;line-height:1.5;transition:opacity .2s,background-color .2s;animation:roko-rise .3s var(--rk-ease) both}
.roko-feed-row:hover{background:var(--ui-row-hover-background)}
.roko-feed-time{font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-4);text-align:right;font-variant-numeric:tabular-nums}
.roko-feed-icon{display:inline-flex;justify-content:center;color:var(--rk-ink-3);transform:translateY(2px)}
.roko-feed-row[data-tone=good] .roko-feed-icon{color:var(--rk-pass)}.roko-feed-row[data-tone=bad] .roko-feed-icon{color:var(--rk-fail)}.roko-feed-row[data-tone=warn] .roko-feed-icon{color:var(--rk-you)}.roko-feed-row[data-tone=live] .roko-feed-icon{color:var(--rk-agent)}
.roko-feed-text{min-width:0;color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-feed-row[data-tone=bad] .roko-feed-text{color:var(--rk-ink)}
.roko-feed-quote{display:flex;gap:7px;min-width:0}
.roko-feed-task{flex:none;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3)}
.roko-feed-said{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-style:italic;color:var(--rk-ink-3)}
.roko-feed-row[data-future=true]{opacity:.28}
.roko-feed-row[data-current=true]{background:color-mix(in oklab,var(--rk-you) 12%,transparent)}
.roko-feed-jump{position:absolute;bottom:12px;left:50%;transform:translateX(-50%);display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 12px;border-radius:var(--rk-radius);border:1px solid var(--rk-stroke-2);background:var(--ui-bg-elevated);color:var(--rk-ink);font:inherit;font-size:11.5px;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);animation:roko-rise .2s var(--rk-ease)}
.roko-feed-all{align-self:flex-start;margin-left:6px}
.roko-replay{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:var(--rk-radius-m);border:1px solid var(--rk-stroke);background:var(--rk-sunk);animation:roko-rise .2s var(--rk-ease)}
.roko-replay-play{display:inline-grid;place-items:center;flex:none;width:30px;height:28px;border:1px solid color-mix(in oklab,var(--rk-you) 72%,black);border-radius:var(--rk-radius);background:var(--rk-you);color:color-mix(in oklab,black 88%,var(--rk-you));cursor:pointer;box-shadow:0 2px 0 0 color-mix(in oklab,var(--rk-you) 52%,black)}
.roko-replay-play:active{transform:translateY(2px);box-shadow:none}
.roko-replay-play:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.roko-replay-track{position:relative;flex:1;height:24px;cursor:pointer;touch-action:none;border-radius:var(--rk-radius)}
.roko-replay-track:focus-visible{outline:2px solid var(--rk-you);outline-offset:2px}
.roko-replay-track::before{content:"";position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;background:color-mix(in oklab,var(--rk-ink) 10%,transparent)}
.roko-replay-fill{position:absolute;left:0;top:50%;height:4px;margin-top:-2px;background:var(--rk-you)}
.roko-replay-tick{position:absolute;top:5px;width:2px;height:14px;margin-left:-1px;background:var(--rk-stroke-2);opacity:.85;pointer-events:none}
.roko-replay-tick[data-group=agent]{background:color-mix(in oklab,var(--rk-agent) 70%,transparent)}.roko-replay-tick[data-tone=good]{background:var(--rk-pass)}.roko-replay-tick[data-tone=bad]{background:var(--rk-fail);height:18px;top:3px}
.roko-replay-head{position:absolute;top:2px;width:3px;height:20px;margin-left:-1.5px;background:var(--rk-you);box-shadow:0 0 6px var(--rk-you);pointer-events:none}
.roko-replay-time{min-width:92px;font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-2);text-align:right;font-variant-numeric:tabular-nums}

/* -- changes and merge --------------------------------------------------------- */
.roko-changes{display:flex;flex-direction:column;gap:10px;min-width:0;container-type:inline-size}
.roko-changes-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.roko-changes-summary{display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px}
.roko-changes-body{display:grid;grid-template-columns:minmax(170px,230px) minmax(0,1fr);gap:12px;align-items:start}
@container (max-width:700px){.roko-changes-body{grid-template-columns:minmax(0,1fr)}.roko-filelist{position:static;max-height:220px}}
.roko-filelist{position:sticky;top:0;display:flex;flex-direction:column;gap:1px;max-height:72vh;overflow:auto;padding:4px;border-radius:var(--rk-radius-m);border:1px solid var(--rk-stroke);background:var(--rk-sunk)}
.roko-filename{display:flex;align-items:baseline;gap:6px;min-width:0;overflow:hidden;white-space:nowrap}
.roko-filename-base{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-family:var(--rk-mono);font-size:11.5px;color:var(--rk-ink)}
.roko-filename-dir{flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;font-size:10.5px;color:var(--rk-ink-3)}
.roko-filelist-stat{display:inline-flex;gap:5px;font-family:var(--rk-mono);font-size:10.5px;font-variant-numeric:tabular-nums}
.roko-filelist-row{display:grid;grid-template-columns:14px minmax(0,1fr) auto;gap:7px;align-items:center;padding:5px 7px;border:0;border-radius:var(--rk-radius);background:none;color:var(--rk-ink-2);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.roko-filelist-row:hover,.roko-filelist-row[aria-current=true]{background:var(--ui-row-hover-background);color:var(--rk-ink)}
.roko-filelist-row[aria-current=true]{box-shadow:inset 2px 0 0 var(--rk-you)}
.roko-status-letter{font-family:var(--rk-mono);font-size:10.5px;font-weight:800;text-align:center;color:var(--rk-ink-3)}
.roko-status-letter[data-status=added]{color:var(--rk-pass)}.roko-status-letter[data-status=deleted]{color:var(--rk-fail)}.roko-status-letter[data-status=modified]{color:var(--rk-you)}.roko-status-letter[data-status=renamed]{color:var(--rk-agent)}
.roko-diffs{display:flex;flex-direction:column;gap:12px;min-width:0}
.roko-filediff{min-width:0;overflow:clip;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module)}
.roko-filediff-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;min-width:0;padding:5px 8px 5px 6px;border-bottom:1px solid var(--rk-stroke-soft);background:var(--ui-bg-elevated)}
.roko-filediff-toggle{display:flex;flex:1;align-items:center;gap:7px;min-width:0;padding:2px 4px;border:0;border-radius:var(--rk-radius);background:none;color:var(--rk-ink);font:inherit;text-align:left;cursor:pointer}
.roko-filediff-toggle:hover{background:var(--ui-row-hover-background)}
.roko-caret{flex:none;color:var(--rk-ink-3)}
.roko-filediff-body{overflow-x:auto;font-family:var(--rk-mono);font-size:11.5px;line-height:1.6}
.roko-dl{display:grid;grid-template-columns:42px 42px 18px minmax(0,1fr);min-width:max-content}
.roko-ln{padding:0 8px;text-align:right;color:var(--rk-ink-4);user-select:none;font-variant-numeric:tabular-nums}
.roko-ln+.roko-ln{border-right:1px solid var(--rk-stroke-soft)}
.roko-sign{text-align:center;user-select:none;color:var(--rk-ink-4)}
.roko-dcode{padding-right:18px;white-space:pre;color:var(--rk-ink);font:inherit;background:none}
.roko-dl[data-tag=add]{background:var(--ui-diff-add-background);box-shadow:inset 2px 0 0 var(--ui-diff-add-border)}.roko-dl[data-tag=add] .roko-sign{color:var(--ui-diff-add-foreground);font-weight:700}
.roko-dl[data-tag=del]{background:var(--ui-diff-remove-background);box-shadow:inset 2px 0 0 var(--ui-diff-remove-border)}.roko-dl[data-tag=del] .roko-sign{color:var(--ui-diff-remove-foreground);font-weight:700}
.roko-dl[data-tag=meta] .roko-dcode{font-style:italic;color:var(--rk-ink-3)}
.roko-t-kw{color:color-mix(in oklab,var(--rk-agent) 70%,var(--rk-ink));font-weight:550}.roko-t-str{color:color-mix(in oklab,var(--rk-you) 78%,var(--rk-ink))}.roko-t-num{color:color-mix(in oklab,var(--rk-pass) 70%,var(--rk-ink))}.roko-t-com{color:var(--rk-ink-3);font-style:italic}
.roko-hunk-head{display:flex;gap:10px;min-width:max-content;padding:2px 10px 2px 102px;border-block:1px solid var(--rk-stroke-soft);background:var(--rk-sunk);color:var(--rk-ink-3);font-size:11px}
.roko-hunk-head:first-child{border-top:0}
.roko-hunk-range{color:var(--rk-agent)}
.roko-diff-note{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:9px 12px;font-family:var(--font-sans,inherit);font-size:12px;color:var(--rk-ink-3)}
.roko-merge-btn .roko-merge-mode{margin-left:2px;padding-left:7px;border-left:1px solid color-mix(in oklab,currentColor 35%,transparent);font-weight:400;opacity:.8}
.roko-merge-state{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600}
.roko-merge-state[data-tone=good]{color:var(--rk-pass)}
.roko-merge-blocked{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap}
.roko-merge-why{display:inline-flex;align-items:center;gap:5px;max-width:420px;padding:3px 8px;border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-ink) 6%,transparent);color:var(--rk-ink-2);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.roko-merge-confirm{display:flex;flex-direction:column;gap:5px}
.roko-merge-line{display:block}
.roko-merged{display:inline-flex;align-items:center;gap:9px;flex-wrap:wrap;padding:5px 6px 5px 10px;border-radius:var(--rk-radius);border:1px solid color-mix(in oklab,var(--rk-pass) 40%,transparent);border-left:3px solid var(--rk-pass);background:color-mix(in oklab,var(--rk-pass) 8%,transparent);font-size:12px}
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
.roko-pending-kind{display:inline-flex;align-items:center;gap:4px;height:18px;padding:0 6px;border-radius:var(--rk-radius);border:1px solid color-mix(in oklab,var(--rk-you) 50%,transparent);font-family:var(--rk-mono);font-size:9.5px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;white-space:nowrap;color:var(--rk-you)}
.roko-pending-title{flex:1;min-width:0;font-size:12px;color:var(--rk-ink-3);overflow-wrap:anywhere}
.roko-pending-head .roko-code{padding:1px 6px;border-radius:var(--rk-radius);border:1px dashed var(--rk-stroke-2);font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-2)}
.roko-question{font-size:16px;font-weight:650;line-height:1.4;letter-spacing:-.01em;overflow-wrap:anywhere}
.roko-pending[data-compact=true] .roko-question{font-size:14px}
.roko-effect{display:flex;flex-wrap:wrap;align-items:center;gap:7px}
.roko-effect-call{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:var(--rk-radius);border:1px solid color-mix(in oklab,var(--rk-you) 40%,transparent)}
.roko-args{display:inline-flex;flex-wrap:wrap;gap:4px}
.roko-doc{overflow:clip;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-sunk)}
.roko-doc-tab{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-right:1px solid var(--rk-stroke-soft);border-bottom:1px solid var(--rk-stroke-soft);background:var(--rk-module);font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-2)}
.roko-doc-body{padding:9px 12px}
.roko-pending-meta{display:flex;flex-wrap:wrap;align-items:center;gap:12px;font-size:11.5px;color:var(--rk-ink-3)}
.roko-pending-meta>span{display:inline-flex;align-items:center;gap:4px}
.roko-countdown{display:inline-flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums}
.roko-countdown[data-tone=warn]{color:var(--rk-you)}.roko-countdown[data-tone=bad]{color:var(--rk-fail)}
.rk-deadline-well{padding:4px 7px}
.rk-deadline-text{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.rk-deadline::after{content:"left";font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-3)}
.roko-decide{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.roko-note{flex:1;min-width:180px}
.rk-decide-key{min-width:104px}
.roko-result{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--rk-ink-2)}
.roko-result[data-tone=good]{color:var(--rk-pass)}.roko-result[data-tone=bad]{color:var(--rk-fail)}
.roko-result-hint{color:var(--rk-ink-3)}
.roko-waiting-head{font-size:12.5px;color:var(--rk-ink-2)}
.roko-clamp{display:flex;flex-direction:column;align-items:flex-start;gap:4px;min-width:0}
.roko-clamp-text{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;line-height:1.55;color:var(--rk-ink-2)}
.roko-clamp-text.roko-mono{font-size:11.5px}
.roko-clamp-text[data-open=false]{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:var(--roko-lines,4);overflow:hidden}
.roko-link{padding:0;border:0;background:none;color:var(--rk-ink-3);font:inherit;font-size:11.5px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.roko-link:hover{color:var(--rk-ink)}
.roko-actions{display:flex;flex-wrap:wrap;align-items:center;justify-content:flex-end;gap:6px}
.roko-actions-start{justify-content:flex-start}
.roko-kv{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:4px 14px;font-size:12px}

/* -- plans --------------------------------------------------------------------- */
.roko-waves{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(150px,240px);gap:8px;overflow-x:auto;padding-bottom:2px}
.roko-wave{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px dashed var(--rk-stroke);border-radius:var(--rk-radius-m)}
.roko-wave-head{font-family:var(--rk-mono);font-size:10px;font-weight:650;letter-spacing:.14em;color:var(--rk-ink-4)}
.roko-taskchip{display:flex;flex-direction:column;gap:2px;padding:6px 8px;border-radius:var(--rk-radius);border:1px solid var(--rk-stroke);background:var(--rk-module);font-size:12px;box-shadow:0 1px 0 0 var(--rk-stroke)}
.roko-taskchip-head{display:flex;gap:6px;align-items:baseline;min-width:0}
.roko-taskchip-title{min-width:0;overflow-wrap:anywhere}
.roko-plan-icon{display:inline-grid;place-items:center;width:24px;height:24px;border-radius:var(--rk-radius);background:var(--rk-well);color:var(--rk-px-you)}

/* -- the New run device -------------------------------------------------------- */
.roko-form{display:flex;flex-direction:column;gap:12px;padding:4px 0}
.roko-field{display:flex;flex-direction:column;gap:6px;min-width:0;font-size:12px;color:var(--rk-ink-2)}
.roko-field>label,.roko-field-label,.rk-field-label{font-weight:600;font-size:12px;color:var(--rk-ink)}
.roko-field-row{flex-direction:row;align-items:center;gap:10px}
.roko-field-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
.roko-capchips{display:flex;flex-wrap:wrap;gap:5px}
.roko-capchip{height:24px;padding:0 9px;border-radius:var(--rk-radius);border:1px solid var(--rk-stroke-2);background:transparent;color:var(--rk-ink-2);font-family:var(--rk-mono);font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer;box-shadow:0 1px 0 0 var(--rk-stroke-2);transition:background-color .14s,border-color .14s}
.roko-capchip:hover:not(:disabled){color:var(--rk-ink)}
.roko-capchip[aria-pressed=true]{border-color:var(--rk-you);color:var(--rk-ink);box-shadow:inset 3px 0 0 var(--rk-you)}
.roko-capchip:disabled{opacity:.36;cursor:default}
.roko.roko-composer{max-width:min(640px,94vw);width:100%;max-height:calc(100vh - 24px);max-height:calc(100dvh - 24px);display:flex;flex-direction:column;overflow:hidden}
.roko-composer>.rk-device-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain}
.roko-composer>.rk-device-foot,.roko-composer>[data-slot=dialog-header]{flex:none}
.rk-device{background:var(--rk-body);border-color:var(--rk-stroke-2)}
.roko-composer [data-slot=dialog-title]{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:-.01em}
.roko-composer-mark{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:var(--rk-radius);background:var(--rk-well);box-shadow:inset 0 0 0 1px black}
.roko-composer-mark .roko-logo-node{fill:var(--rk-well);stroke:var(--rk-px-on)}.roko-composer-mark .roko-logo-edge{stroke:var(--rk-px-dim)}.roko-composer-mark .roko-logo-end{fill:var(--rk-px-you);stroke:var(--rk-px-you)}
.rk-device-body{gap:10px}
.rk-device-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:10px}
.rk-module-request .roko-prompt{min-height:112px;font-size:13px;line-height:1.55;resize:vertical}
.rk-keyrow{display:flex;flex-wrap:wrap;gap:6px}
.rk-cap{display:flex;align-items:center;gap:18px;flex-wrap:wrap}
.rk-cap-side{display:flex;flex-direction:column;gap:8px;min-width:0}
.rk-cap-well{padding:9px 12px;justify-content:center}
.rk-cap-exact{max-width:150px}
.rk-device-foot{align-items:center;gap:10px}
.rk-start{min-width:180px}
.rk-slide{display:inline-flex;align-items:center;gap:9px}
.rk-slide-label{padding:2px 0;border:0;background:none;color:var(--rk-ink-3);font:inherit;font-size:12.5px;font-weight:650;cursor:pointer;transition:color .14s}
.rk-slide-label[aria-pressed=true]{color:var(--rk-ink)}
.rk-slide-label:focus-visible{outline:2px solid var(--rk-you);outline-offset:3px;border-radius:2px}
.rk-slide-track{position:relative;display:inline-block;width:44px;height:22px;border-radius:var(--rk-radius);background:var(--rk-well);box-shadow:inset 0 0 0 1px black,inset 0 2px 3px black;cursor:pointer}
.rk-slide-thumb{position:absolute;top:2px;left:2px;width:20px;height:18px;border-radius:1px;background:linear-gradient(180deg,color-mix(in oklab,white 82%,var(--rk-ink)),color-mix(in oklab,white 60%,var(--rk-ink)));box-shadow:0 1px 0 black;transition:left .14s var(--rk-ease)}
.rk-slide-thumb::after{content:"";position:absolute;left:50%;top:5px;bottom:5px;width:2px;margin-left:-1px;background:var(--rk-you)}
.rk-slide[data-pos="1"] .rk-slide-thumb{left:22px}
.rk-knob{display:flex;align-items:center;gap:12px}
.rk-knob-dial{width:84px;height:84px;flex:none;border-radius:50%;cursor:ns-resize;touch-action:none}
.rk-knob-dial:focus-visible{outline:2px solid var(--rk-you);outline-offset:3px}
.rk-knob[data-disabled=true] .rk-knob-dial{opacity:.45;cursor:default}
.rk-knob-svg{display:block;width:100%;height:100%;overflow:visible}
.rk-knob-travel{fill:none;stroke:color-mix(in oklab,var(--rk-ink) 14%,transparent);stroke-width:2.2;stroke-linecap:round}
.rk-knob-value{fill:none;stroke:var(--rk-you);stroke-width:2.6;stroke-linecap:round;filter:drop-shadow(0 0 3px color-mix(in oklab,var(--rk-you) 60%,transparent))}
.rk-knob-detent-mark{stroke:var(--rk-ink-2);stroke-width:1.6;stroke-linecap:round}
.rk-knob-detent-mark[data-over=true]{stroke:color-mix(in oklab,var(--rk-ink) 18%,transparent)}
.rk-knob-body{fill:var(--rk-well-2);stroke:black;stroke-width:1;filter:drop-shadow(0 2px 0 var(--rk-stroke-2))}
.rk-knob-cap{fill:var(--rk-well);stroke:color-mix(in oklab,white 10%,transparent);stroke-width:1}
.rk-knob-pointer{stroke:var(--rk-you);stroke-width:3;stroke-linecap:round}
.rk-knob-scale{display:flex;flex-direction:column;gap:3px}
.rk-knob-detent{height:20px;padding:0 8px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius);background:transparent;color:var(--rk-ink-2);font-family:var(--rk-mono);font-size:10.5px;font-variant-numeric:tabular-nums;text-align:left;cursor:pointer;transition:border-color .14s,color .14s}
.rk-knob-detent:hover:not(:disabled){color:var(--rk-ink);border-color:var(--rk-stroke-2)}
.rk-knob-detent[aria-pressed=true]{border-color:var(--rk-you);color:var(--rk-ink);box-shadow:inset 3px 0 0 var(--rk-you)}
.rk-knob-detent:disabled{opacity:.32;cursor:default;text-decoration:line-through}
.roko-modes{align-self:flex-start}
.roko-prompt{min-height:128px;font-size:13px;line-height:1.55;resize:vertical}
.roko-prompt-foot{display:flex;justify-content:flex-end;min-height:24px}
.roko-examples-label{font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-4)}
.roko-examples{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.roko-example{display:inline-flex;align-items:center;height:24px;padding:0 10px;border-radius:var(--rk-radius);border:1px solid var(--rk-stroke-2);background:var(--rk-module);color:var(--rk-ink-2);font:inherit;font-size:11.5px;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);transition:background-color .14s,color .14s,transform 80ms,box-shadow 80ms}
.roko-example:hover{color:var(--rk-ink);border-color:var(--rk-ink-3)}
.roko-example:active{transform:translateY(2px);box-shadow:none}
.roko-composer-limits{display:flex;flex-wrap:wrap;gap:4px 16px;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3);font-variant-numeric:tabular-nums}
.roko-composer-hint{margin-right:auto;display:inline-flex;align-items:center}

/* -- onboarding ---------------------------------------------------------------- */
.roko-onboard{display:flex;flex-direction:column;align-items:center;gap:12px;width:100%;max-width:680px;margin:20px auto;padding:28px 28px 24px;text-align:center;border-radius:var(--rk-radius-m);border:1px solid var(--rk-stroke);background:var(--rk-module)}
.rk-onboard-well{padding:14px 20px;gap:18px}
.roko-onboard-title{margin:6px 0 0;font-size:21px;font-weight:700;letter-spacing:-.025em;text-wrap:balance}
.roko-onboard-text{margin:0;max-width:56ch;font-size:13px;line-height:1.6;color:var(--rk-ink-2)}
.roko-steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px;width:100%;margin:8px 0 2px;padding:0;list-style:none}
.roko-steps li{display:flex;flex-direction:column;gap:7px;padding:11px 12px;border-radius:var(--rk-radius);background:var(--rk-sunk);border:1px solid var(--rk-stroke);font-size:12px;line-height:1.5;color:var(--rk-ink-2);text-align:left}
.roko-onboard-actions{display:flex;flex-direction:column;align-items:center;gap:12px;margin-top:6px}
.roko-onboard-actions .roko-examples{justify-content:center}

/* -- loops ------------------------------------------------------------------- */
.rk-loops{display:flex;flex-direction:column;gap:12px;min-width:0}
.rk-loops-top{display:grid;grid-template-columns:auto minmax(0,1fr);gap:18px;align-items:start}
@container (max-width:760px){.rk-loops-top{grid-template-columns:minmax(0,1fr)}.rk-loops-dialcol{align-items:center}}
.rk-loops-dialcol{display:flex;flex-direction:column;gap:10px}
.rk-loops-rings{display:flex;flex-direction:column;gap:6px;min-width:0}
.rk-loops-strip{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module)}
.rk-loops-problems{font-size:11.5px}
.rk-dial{position:relative;flex:none}
.rk-dial-svg{display:block;width:100%;height:100%;overflow:visible}
.rk-dial-face{fill:var(--rk-well);stroke:black;stroke-width:1.5}
.rk-dial-minute{stroke:color-mix(in oklab,white 14%,transparent);stroke-width:1}
.rk-dial-minute[data-major=true]{stroke:color-mix(in oklab,white 38%,transparent);stroke-width:1.5}
.rk-dial-ring{fill:none;stroke:color-mix(in oklab,white 9%,transparent);stroke-width:1;stroke-dasharray:1 3}
.rk-dial-ring[data-busy=true]{stroke:color-mix(in oklab,white 17%,transparent);stroke-dasharray:none}
.rk-dial-tick{stroke:var(--rk-px-on);stroke-width:2.4;stroke-linecap:round}
.rk-dial-tick[data-channel=agent]{stroke:var(--rk-px-agent)}.rk-dial-tick[data-channel=pass]{stroke:var(--rk-px-pass)}.rk-dial-tick[data-channel=you]{stroke:var(--rk-px-you)}.rk-dial-tick[data-channel=fail]{stroke:var(--rk-px-fail)}.rk-dial-tick[data-channel=ink]{stroke:var(--rk-px-dim)}
.rk-dial-tick[data-fresh=true]{animation:rk-tick-flash 1s ease-out}
.rk-dial-label{font-family:var(--rk-mono);font-size:6.5px;font-weight:600;letter-spacing:.06em;fill:color-mix(in oklab,white 38%,transparent)}
.rk-dial-hand{transform-origin:110px 110px;animation:rk-sweep 60s linear infinite}
.rk-dial-hand[data-still=true]{animation:none}
.rk-dial-hand line{stroke:var(--rk-px-you);stroke-width:1.3}
.rk-dial-hand circle{fill:var(--rk-px-you);filter:drop-shadow(0 0 3px var(--rk-px-you))}
.rk-dial-hub{fill:var(--rk-px-you);stroke:black;stroke-width:1.5}
.rk-dial-legend{display:flex;flex-wrap:wrap;gap:4px 12px;max-width:232px;font-size:10.5px;color:var(--rk-ink-3)}
.rk-dial-legend span{display:inline-flex;align-items:center;gap:5px}
.rk-dial-legend i{width:8px;height:3px;border-radius:1px;background:var(--rk-ink-3)}
.rk-dial-legend [data-channel=agent] i{background:var(--rk-agent)}.rk-dial-legend [data-channel=you] i{background:var(--rk-you)}.rk-dial-legend [data-channel=pass] i{background:var(--rk-pass)}.rk-dial-legend [data-channel=fail] i{background:var(--rk-fail)}
.rk-ring{display:flex;flex-direction:column;gap:6px;padding:9px 12px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module);transition:border-color .2s}
.rk-ring[data-active=true]{border-color:var(--rk-stroke-2)}
.rk-ring-head{display:flex;align-items:center;gap:8px;min-width:0}
.rk-ring-id{font-family:var(--rk-mono);font-size:11px;font-weight:800;letter-spacing:.04em}
.rk-ring-name{font-weight:650;font-size:12.5px}
.rk-ring-clock{font-family:var(--rk-mono);font-size:9.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-4)}
.rk-ring-count{padding:4px 6px}
.rk-ring-events{display:flex;flex-direction:column;gap:3px}
.rk-ring-event{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px}
.rk-ring-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rk-ink-2)}
.rk-ring-age{flex:none;font-family:var(--rk-mono);font-size:10px;color:var(--rk-ink-4)}
.rk-ring-quiet{font-family:var(--rk-mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--rk-ink-4)}
.rk-ring-facts{display:flex;flex-direction:column;gap:3px;padding-top:5px;border-top:1px dashed var(--rk-stroke-soft)}
.rk-fact{display:flex;align-items:center;gap:7px;min-width:0;font-size:11px;color:var(--rk-ink-3)}
.rk-fact-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--rk-mono);font-size:10.5px}
.rk-fact-bar{display:block;flex:none;width:34px;height:5px;background:color-mix(in oklab,var(--rk-ink) 9%,transparent);-webkit-mask:repeating-linear-gradient(90deg,black 0 3px,transparent 3px 4px);mask:repeating-linear-gradient(90deg,black 0 3px,transparent 3px 4px)}
.rk-fact-bar i{display:block;height:100%;background:var(--rk-fact,var(--rk-ink-3))}
.rk-fact-dot{flex:none;width:5px;height:5px;margin:0 14.5px;border-radius:50%;background:var(--rk-fact,var(--rk-ink-4))}
.rk-fact[data-channel=agent]{--rk-fact:var(--rk-agent)}.rk-fact[data-channel=pass]{--rk-fact:var(--rk-pass)}.rk-fact[data-channel=you]{--rk-fact:var(--rk-you)}.rk-fact[data-channel=fail]{--rk-fact:var(--rk-fail)}
.rk-loopfeed{display:flex;flex-direction:column;max-height:360px;overflow:auto;padding:4px 0;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-sunk)}
.rk-loopfeed-row{display:flex;align-items:center;gap:8px;min-width:0;padding:3px 12px;font-size:12px;animation:roko-rise .3s var(--rk-ease) both}
.rk-loopfeed-row:hover{background:var(--ui-row-hover-background)}
.rk-loopfeed-time{flex:none;width:60px;font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-4);font-variant-numeric:tabular-nums}
.rk-tag-ring{min-width:24px;justify-content:center}
.rk-loopfeed-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--rk-ink-2)}

/* -- insights, knowledge, banners, empties -------------------------------------- */
.roko-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:8px}
.roko-kpi{display:flex;flex-direction:column;gap:4px;padding:12px 14px;border-radius:var(--rk-radius-m);border:1px solid var(--rk-stroke);background:var(--rk-module)}
.roko-kpi-label{font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-3)}
.roko-kpi-value{font-family:var(--rk-mono);font-size:24px;font-weight:600;letter-spacing:-.03em;color:var(--rk-ink);font-variant-numeric:tabular-nums}
.roko-kpi[data-tone=good] .roko-kpi-value{color:var(--rk-pass)}.roko-kpi[data-tone=warn] .roko-kpi-value{color:var(--rk-you)}.roko-kpi[data-tone=bad] .roko-kpi-value{color:var(--rk-fail)}
.roko-kpi-sub{font-size:11.5px;color:var(--rk-ink-3)}
.roko-chart-card{padding:10px 12px}
.roko-chart{position:relative;padding:8px 8px 22px 42px}
.roko-spark{display:block;width:100%;height:150px;color:var(--rk-agent);overflow:visible}
.roko-spark-line{stroke:currentColor;stroke-width:1.8;stroke-linejoin:round;vector-effect:non-scaling-stroke}
.roko-spark-area{fill:currentColor;opacity:.1}
.roko-chart-grid{stroke:var(--rk-stroke-soft);stroke-width:1;vector-effect:non-scaling-stroke}
.roko-chart-cursor{stroke:var(--rk-you);stroke-dasharray:3 3;stroke-width:1;vector-effect:non-scaling-stroke}
.roko-chart-y{position:absolute;left:0;width:36px;text-align:right;font-family:var(--rk-mono);font-size:10px;color:var(--rk-ink-4);font-variant-numeric:tabular-nums}
.roko-chart-ymax{top:6px}.roko-chart-y0{bottom:20px}
.roko-chart-x{position:absolute;bottom:2px;font-family:var(--rk-mono);font-size:10px;color:var(--rk-ink-4)}
.roko-chart-x0{left:42px}.roko-chart-x1{right:8px}
.roko-chart-tip{position:absolute;z-index:2;transform:translate(-50%,-135%);padding:3px 8px;border-radius:var(--rk-radius);border:1px solid var(--rk-stroke-2);background:var(--ui-bg-elevated);font-family:var(--rk-mono);font-size:11px;white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums}
.roko-checks,.roko-table{gap:0;padding:4px 14px}
.roko-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));column-gap:22px}
.roko-checks .roko-check:nth-child(2){border-top:0}
.roko-check{display:grid;grid-template-columns:16px minmax(0,1fr);gap:9px;padding:9px 0;border-top:1px solid var(--rk-stroke-soft)}
.roko-check:first-child,.roko-table-row:first-child{border-top:0}
.roko-check-main{display:flex;flex-direction:column;gap:2px;min-width:0}
.roko-check-hint{font-size:12px;color:var(--rk-you)}
.roko-table-row{display:grid;grid-template-columns:minmax(120px,1.3fr) minmax(60px,1fr) 46px 70px 70px;gap:10px;align-items:center;padding:7px 0;border-top:1px solid var(--rk-stroke-soft);font-size:12px}
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
.roko-banner{display:flex;gap:10px;align-items:flex-start;padding:11px 13px;border-radius:var(--rk-radius-m);border:1px solid color-mix(in oklab,var(--rk-you) 45%,transparent);border-left:3px solid var(--rk-you);background:color-mix(in oklab,var(--rk-you) 6%,transparent);font-size:12.5px;color:var(--rk-ink-2)}
.roko-banner[data-tone=bad]{border-color:color-mix(in oklab,var(--rk-fail) 40%,transparent);border-left-color:var(--rk-fail);background:color-mix(in oklab,var(--rk-fail) 6%,transparent)}
.roko-banner-icon{margin-top:1px;color:var(--rk-you)}.roko-banner[data-tone=bad] .roko-banner-icon{color:var(--rk-fail)}
.roko-banner-body{display:flex;flex-direction:column;gap:4px;min-width:0}
.roko-banner-title{font-weight:650;color:var(--rk-ink)}
.roko-error{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:var(--rk-radius-m);border:1px solid color-mix(in oklab,var(--rk-fail) 35%,transparent);border-left:3px solid var(--rk-fail);background:color-mix(in oklab,var(--rk-fail) 5%,transparent);font-size:12px}
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
.roko-statuschip:hover{background:var(--chrome-action-hover);color:var(--rk-ink)}
.rk-chip-word{font-weight:700;letter-spacing:-.01em}
.rk-chip-strip i{width:5px;height:5px}
.roko-statuschip-counts{color:var(--rk-ink-2)}
.roko-statuschip-counts[data-waiting=true]{color:var(--rk-you)}
.roko-directive{display:flex;flex-direction:column;gap:6px;margin:6px 0;max-width:680px}
.roko-directive-raw{font-family:var(--rk-mono)}
.roko-cc{gap:9px}
.roko-cc-head{display:flex;align-items:center;gap:8px;min-width:0}
.roko-cc-head .roko-run-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-cc-spend{gap:8px;padding:5px 8px}
.roko-cc-body{display:flex;align-items:center;gap:14px;min-width:0;padding:8px 10px;border-radius:var(--rk-radius);border:1px solid var(--rk-stroke-soft);background:var(--rk-sunk)}
.roko-cc-progress{display:flex;flex:1;flex-direction:column;gap:6px;min-width:0}
.roko-cc-stats{font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink-2);font-variant-numeric:tabular-nums}
.roko-cc-delivered{display:flex;align-items:center;gap:6px;font-family:var(--rk-mono);font-size:11.5px;color:var(--rk-ink-2);font-variant-numeric:tabular-nums}
.roko-cc-why{font-size:12px;line-height:1.5;color:var(--rk-ink-2);overflow-wrap:anywhere}
.roko-monitor{display:flex;flex-direction:column;gap:10px;height:100%;min-height:0;overflow:auto;padding:12px;background:var(--rk-body);color:var(--rk-ink);font-size:12.5px}
.rk-monitor-head{display:flex;align-items:center;gap:7px}
.rk-monitor-word{font-weight:750;letter-spacing:-.02em}
.rk-monitor-run,.rk-monitor-idle{display:flex;flex-direction:column;gap:9px;min-width:0}
.rk-monitor-idle{align-items:stretch}
.rk-monitor-title{display:flex;align-items:center;gap:8px;min-width:0;padding:0;border:0;background:none;color:var(--rk-ink);font:inherit;font-weight:650;text-align:left;cursor:pointer}
.rk-monitor-title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-monitor-display{display:grid;grid-template-columns:1fr 1fr;align-items:stretch;gap:0;padding:0}
.rk-monitor-display .rk-cell{padding:8px 10px;border-right:0;border-bottom:1px solid color-mix(in oklab,white 7%,transparent)}
.rk-monitor-display .rk-cell:nth-child(odd){border-right:1px solid color-mix(in oklab,white 7%,transparent)}
.rk-monitor-display .rk-cell:nth-child(3){grid-column:span 2;border-right:0}
.rk-monitor-display .rk-cell-row{justify-content:space-between;gap:12px}
.rk-monitor-display .rk-cell-scope{grid-column:span 2;margin:0;border:0;align-items:stretch}
.rk-monitor-display .rk-cell-scope .rk-scope-svg{width:100%}
.rk-monitor-idle .rk-monitor-display{justify-content:space-between;padding:12px 14px;align-items:center}
.rk-monitor-seq{display:flex;justify-content:center;padding:8px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-sunk)}
.rk-monitor-seq .roko-mini{transform:scale(1.35);transform-origin:center;margin:6px 0}
.rk-monitor-now{display:flex;flex-direction:column;gap:4px}
.rk-monitor-task{display:grid;grid-template-columns:8px 34px minmax(0,1fr) auto;align-items:center;gap:7px;padding:5px 8px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink-2);font:inherit;font-size:11.5px;text-align:left;cursor:pointer}
.rk-monitor-task b{font-family:var(--rk-mono);font-size:11px;color:var(--rk-ink)}
.rk-monitor-task span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-monitor-dial{display:flex;align-items:center;gap:10px}
.rk-monitor-dial-caption{display:flex;flex-direction:column;gap:5px;min-width:0;font-size:11.5px;color:var(--rk-ink-2);overflow-wrap:anywhere}
.rk-monitor-last{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:7px 9px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.roko-delegate{display:flex;align-items:center;gap:16px;flex-wrap:wrap;width:min(560px,92%);margin:0 auto;padding:14px 16px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius-m);background:var(--rk-module);color:var(--rk-ink);animation:roko-rise .3s var(--rk-ease)}
.rk-delegate-well{flex-direction:column;align-items:flex-start;gap:8px;padding:10px 12px}
.rk-delegate-body{display:flex;flex:1;flex-direction:column;gap:8px;min-width:220px}
.rk-delegate-text{margin:0;font-size:12.5px;line-height:1.5;color:var(--rk-ink-2)}
.rk-composerkey{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:1px solid var(--rk-stroke-2);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink-2);font:inherit;font-size:11.5px;font-weight:700;letter-spacing:-.01em;cursor:pointer;box-shadow:0 2px 0 0 var(--rk-stroke-2);transition:transform 80ms,box-shadow 80ms,color .14s}
.rk-composerkey span{color:var(--rk-you);font-weight:800}
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
.rk-swatches [data-swatch=alu]{background:color-mix(in oklab,white 88%,black)}.rk-swatches [data-swatch=graphite]{background:color-mix(in oklab,black 88%,white)}.rk-swatches [data-swatch=orange]{background:color-mix(in oklab,var(--ui-orange) 70%,var(--ui-red))}

@keyframes roko-spin{to{transform:rotate(360deg)}}
@keyframes roko-flow{to{stroke-dashoffset:-14}}
@keyframes roko-pulse{0%,100%{opacity:1}50%{opacity:.42}}
@keyframes roko-rise{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
@keyframes roko-draw{to{stroke-dashoffset:0}}
@keyframes rk-blink{0%,55%{opacity:1}56%,100%{opacity:.28}}
@keyframes rk-roll{from{transform:translateY(-4px);opacity:.1}to{transform:none;opacity:1}}
@keyframes rk-tick-in{from{transform:translateX(14px);opacity:0}to{transform:none;opacity:1}}
@keyframes rk-sweep{to{transform:rotate(360deg)}}
@keyframes rk-tick-flash{0%{stroke-width:5;opacity:1}100%{stroke-width:2.4}}
@keyframes rk-scan{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes rk-pad-flash{0%{background-color:color-mix(in oklab,var(--rk-node) 34%,var(--rk-module))}100%{background-color:var(--rk-module)}}
@keyframes rk-slide{from{opacity:0;transform:translateX(10px)}to{opacity:1;transform:none}}
/* -- setup and updates: the restart banner, the setup module, each problem's fix ------------- */
.rk-setup-area{display:flex;flex-direction:column;gap:10px}
.rk-restart{display:flex;align-items:flex-start;gap:12px;padding:10px 12px;border:1px solid color-mix(in oklab,var(--rk-you) 45%,var(--rk-stroke));border-left:3px solid var(--rk-you);border-radius:var(--rk-radius-m);background:color-mix(in oklab,var(--rk-you) 5%,var(--rk-module))}
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
.rk-problem{display:flex;align-items:flex-start;gap:10px;padding:9px 0;border-top:1px solid var(--rk-stroke-soft)}
.rk-problems>.rk-problem:first-child{padding-top:4px;border-top:0}
.rk-problem>.rk-led{margin-top:5px}
.rk-problem-n{flex:none;width:16px;margin-top:2px;font-family:var(--rk-mono);font-size:10px;font-weight:600;color:var(--rk-ink-4);font-variant-numeric:tabular-nums}
.rk-problem-main{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
.rk-problem-title{font-weight:650;color:var(--rk-ink)}
.rk-problem-detail{font-size:12px;color:var(--rk-ink-2)}
.rk-problem-fix{display:flex;flex-direction:column;align-items:flex-start;gap:6px;margin-top:2px;min-width:0;max-width:100%}
.rk-problem-card{display:flex;flex-direction:column;gap:2px;padding:8px 11px;border:1px solid var(--rk-stroke);border-left:3px solid var(--rk-you);border-radius:var(--rk-radius-m);background:var(--rk-module)}
.rk-problem-card[data-severity=block]{border-left-color:var(--rk-fail)}
.rk-problem-lead{font-size:11.5px;color:var(--rk-ink-3)}
.rk-blocked{flex-basis:100%;min-width:0}
.rk-fix-command{display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:100%}
.rk-fix-cmd{max-width:100%;overflow-x:auto;padding:3px 7px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-sunk);color:var(--rk-ink);font-family:var(--rk-mono);font-size:11.5px;white-space:pre}
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
.rk-theme-offer{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:8px 12px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-sunk);font-size:12.5px;color:var(--rk-ink-2)}
.rk-theme-offer-text{flex:1;min-width:200px}
.rk-composer-plan{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-sunk)}
.rk-composer-plan-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.rk-composer-pick{display:flex;align-items:center;gap:8px;margin-top:8px;font-size:12px}
.rk-composer-plans{display:flex;flex-direction:column;gap:8px}
.rk-planpick{display:flex;flex-direction:column;gap:6px;max-height:220px;overflow:auto}
.rk-planpick-head{padding:2px 2px;font-family:var(--rk-mono);font-size:9.5px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-ink-4)}
.rk-planpick-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:1px solid var(--rk-stroke-soft);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12.5px;text-align:left;cursor:pointer}
.rk-planpick-item[data-on=true]{border-color:color-mix(in oklab,var(--rk-you) 55%,var(--rk-stroke))}
.rk-planpick-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-planpick-id{flex:0 1 auto;max-width:40%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.rk-planpick-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;font-size:12px}
.rk-check{display:inline-flex;align-items:center;gap:6px;color:var(--rk-ink-2);cursor:pointer}
.rk-select{min-width:0;max-width:100%;padding:3px 6px;border:1px solid var(--rk-stroke);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12px}
.rk-cand-bar[data-empty=true]{visibility:hidden}
.rk-cands-more{margin-top:4px}
.rk-route-by{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:2px 0}
.rk-cands-toggle{padding:2px 0;border:0;background:none;color:var(--rk-ink-3);font:inherit;font-size:11.5px;cursor:pointer;text-decoration:underline dotted}
.rk-cands-toggle:hover{color:var(--rk-ink-2)}
.rk-unverified{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border:1px solid color-mix(in oklab,var(--rk-you) 45%,var(--rk-stroke));border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-you) 7%,transparent);font-size:12.5px;line-height:1.5;color:var(--rk-ink)}
.rk-unverified b{color:var(--rk-you)}
.rk-work-parts{flex-wrap:wrap;gap:6px;margin-bottom:8px}
.rk-merge-fix{display:inline-flex;align-items:center;gap:6px;margin-left:8px}
.rk-merge-confirm-why{color:var(--rk-you);font-weight:600}
.rk-fix-done-text{display:flex;flex-direction:column;gap:4px;min-width:0;overflow-wrap:anywhere}
.rk-fix-done-note[data-ready=false]{border-color:color-mix(in oklab,var(--rk-you) 45%,var(--rk-stroke));background:color-mix(in oklab,var(--rk-you) 6%,transparent)}
.rk-fix-done-note{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:10px;padding:10px 12px;border:1px solid color-mix(in oklab,var(--rk-pass) 45%,var(--rk-stroke));border-radius:var(--rk-radius);background:color-mix(in oklab,var(--rk-pass) 6%,transparent)}
.rk-fix-next b{margin-right:2px;font-family:var(--rk-mono);font-size:10px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--rk-you)}
.rk-fix-note,.rk-fix-docs{font-size:12px;color:var(--rk-ink-2)}
.rk-fix-docs{color:var(--rk-ink-3)}
.rk-setupstrip{display:flex;align-items:center;gap:8px;min-width:0;padding:7px 9px;border:1px solid var(--rk-stroke);border-left:3px solid var(--rk-you);border-radius:var(--rk-radius);background:var(--rk-module);color:var(--rk-ink);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.rk-setupstrip[data-severity=block]{border-left-color:var(--rk-fail)}
.rk-setupstrip:hover{background:color-mix(in oklab,var(--rk-module) 90%,var(--rk-ink))}
.rk-setupstrip-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.rk-setupstrip-more{font-family:var(--rk-mono);font-size:10.5px;color:var(--rk-ink-3)}
.roko-statuschip .rk-tag{height:14px;padding:0 4px;font-size:9px}
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
  description:
    'roko’s control surface: live runs on a dot-matrix display, the task sequencer, the five loops, approvals with two keys, diffs with a guarded merge, a monitor pane, a theme, and live run cards in chat.',
  register(ctx) {
    try {
      doors = { os: ctx.os, pet: ctx.pet, rest: ctx.rest, socket: ctx.socket, storage: ctx.storage }
      resetSeen()
      $sound.set(safe('the sound setting', () => ctx.storage?.get?.('sound', false) === true) ?? false)
      $themeOffered.set(safe('the theme offer', () => ctx.storage?.get?.('theme-offered', false) === true) ?? false)
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

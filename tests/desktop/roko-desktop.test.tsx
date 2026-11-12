/**
 * desktop/plugin.js through the REAL Hermes desktop pipeline: the unified
 * package door (<home>/plugins/roko/desktop/plugin.js) -> runtime loader ->
 * contribution registry -> React. Faked: the Electron bridge
 * (window.hermesDesktop, whose `api` is ctx.rest's transport and serves the
 * contract in docs/ui-api.md via ./fake-backend) and the gateway socket.
 */
import fs from 'node:fs'
import path from 'node:path'

import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { TranscriptDirectiveLeaf } from '@/components/assistant-ui/transcript-directive'
import { emitGatewayEvent } from '@/contrib/events'
import { $pluginRecords, setPluginEnabled } from '@/contrib/plugins-store'
import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { registry } from '@/contrib/registry'
import { watchRuntimePlugins } from '@/contrib/runtime-loader'
import { queryClient } from '@/lib/query-client'
import { host } from '@/sdk'
import { $gateway } from '@/store/gateway'
import { $notifications } from '@/store/notifications'
import { $petPluginMessages } from '@/store/pet-plugin-messages'
import { resolveTheme } from '@/themes/user-themes'

import {
  activeLoops,
  type ApiRequest,
  DONE_COMMIT,
  FakeBackend,
  HOSTILE_LINE,
  PROBLEM_BOUNDARY,
  PROBLEM_MODEL,
  PROBLEM_RESTART,
  RUN_ACTIVE,
  RUN_DONE,
  RUN_FAILED,
  RUN_NEW,
  RUN_PLANGEN,
  RUN_UNVERIFIED,
  loopsAnswer,
  NEWER_VERSION,
  OLDER_VERSION,
  PAGE_VERSION,
  PROJECT_SYNTH,
  PROJECT_WS,
  noProvider,
  projectRow,
  serveError,
  serveState,
  undertowBuild
} from './fake-backend'

const HARNESS = process.env.ROKO_HARNESS_DIR!
const SOURCE = process.env.ROKO_PLUGIN_SOURCE!
const HOME = path.join(HARNESS, 'home')
// Hermes 0.21+ (0e427d788) scans only the app-level desktop-plugins root: Electron copies a unified
// package's desktop half to <root>/roko/plugin.js beside a .hermes-package.json marker (opt-in posture).
const PLUGIN_FILE = path.join(HOME, 'desktop-plugins', 'roko', 'plugin.js')

// Radix measures with ResizeObserver, which jsdom lacks.
if (!('ResizeObserver' in globalThis)) {
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// -- fakes -----------------------------------------------------------------------

const backend = new FakeBackend()
const api = vi.fn((req: ApiRequest) => backend.handle(req))

/**
 * The live channel (ctx.socket('/live')): Hermes dials a WebSocket to /api/plugins/roko/live; this stands in
 * for it and lets a test push the frames docs/ui-api.md describes.
 */
class FakeSocket {
  static all: FakeSocket[] = []
  url: string
  readyState = 1
  onmessage: ((event: { data: string }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeSocket.all.push(this)
  }

  send() {}

  close() {
    this.readyState = 3
    this.onclose?.()
  }

  push(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
}

const liveSocket = () => FakeSocket.all.filter(s => s.readyState === 1 && s.url.includes('/api/plugins/roko/live')).at(-1)

async function openSocket() {
  await waitFor(() => expect(liveSocket()).toBeTruthy())

  return liveSocket()!
}

function push(socket: FakeSocket, frame: Record<string, unknown>) {
  act(() => socket.push(frame))
}

/** The backend changed under a cached overview: read it again. */
async function refreshOverview() {
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
  })
}

/** Set a browser global on the window and the global object alike (jsdom keeps both). */
function setGlobal(name: string, value: unknown) {
  for (const target of [globalThis, window] as unknown as Array<Record<string, unknown>>) {
    Object.defineProperty(target, name, { configurable: true, value, writable: true })
  }
}
const nativeNotify = vi.fn(async () => true)
const writeClipboard = vi.fn(async () => true)
/** Hermes' app relaunch (its About page's "Restart Hermes"); not in the plugin SDK. */
const relaunchApp = vi.fn(async () => undefined)
/** The native open dialog behind ctx.os.pickOpenPath (0.7 "choose folder…"): the folder the person picks. */
const selectPaths = vi.fn(async (_options?: unknown): Promise<string[]> => [])

const bridge = {
  agentPluginsRoot: async () => path.join(HOME, 'plugins'),
  api,
  desktopPluginsRoot: async () => path.join(HOME, 'desktop-plugins'),
  getConnection: async () => ({ authMode: 'token', baseUrl: 'http://127.0.0.1:9119', token: 'fake-token' }),
  notify: nativeNotify,
  onPreviewFileChanged: () => () => undefined,
  readDir: async (dir: string) => ({
    entries: fs
      .readdirSync(dir, { withFileTypes: true })
      .map(d => ({ isDirectory: d.isDirectory(), name: d.name, path: path.join(dir, d.name) }))
  }),
  readFileText: async (file: string) => ({ text: fs.readFileSync(file, 'utf8'), truncated: false }),
  readPluginSource: async (file: string) => ({ text: fs.readFileSync(file, 'utf8'), truncated: false }),
  relaunchApp,
  selectPaths,
  stopPreviewFileWatch: vi.fn(async () => true),
  watchDirectory: vi.fn(async (dir: string) => ({ id: `dir:${dir}` })),
  watchPreviewFile: vi.fn(async (file: string) => ({ id: `file:${file}` })),
  writeClipboard
}

const gatewayRequest = vi.fn(async (method: string, params: Record<string, unknown>) => {
  if (method === 'command.dispatch' && params.name === 'roko') {
    return { output: 'roko: 1 run active (fake /roko status)', type: 'plugin' }
  }

  throw new Error(`unexpected RPC ${method}`)
})

// -- helpers ---------------------------------------------------------------------

const contribution = (area: string, id: string) => registry.getArea(area).find(c => c.id === id)

function mount(node: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>)
}

/** Mount a contribution's render() the way the app does (surfaces.tsx / slot.tsx). */
function mountContribution(area: string, id: string) {
  const c = contribution(area, id)

  if (!c?.render) {
    throw new Error(`no render contribution ${area}/${id}`)
  }

  return mount(
    <ContribBoundary id={c.id}>
      <ContribRender render={c.render} />
    </ContribBoundary>
  )
}

/** The page keeps its tab and selection across visits (module state), so each test says where it starts. */
async function mountPage(view: { run?: string; tab?: string } = {}) {
  window.location.hash = view.run ? `#/roko#run=${view.run}` : `#/roko#tab=${view.tab ?? 'runs'}`
  mountContribution('routes', 'roko:page')
  // Wait for the overview (or its failure) so the tabs have data.
  await waitFor(() => expect(screen.getByTestId('roko-connection').textContent).not.toBe('connecting…'))
}

/** Radix tabs switch on mousedown, not click. */
/**
 * Open a part of the page by its 0.5.0 tab name. v3 (spec §5.1) has three tabs: Waiting is the ◆ badge (and the `w`
 * key), and Learning, Loops, Knowledge and Insights are Learning's sub-views (overview, loops, lessons, models).
 */
function openTab(name: RegExp) {
  if (name.test('Waiting')) {
    fireEvent.keyDown(window, { key: 'w' })

    return
  }

  const learning: Array<[string, RegExp]> = [
    ['Learning', /^overview$/],
    ['Loops', /^loops$/],
    ['Insights', /^models$/],
    ['Knowledge', /^lessons$/]
  ]
  const sub = learning.find(([old]) => name.test(old))

  if (sub) {
    fireEvent.click(screen.getByRole('tab', { name: /^Learning$/ }))
    fireEvent.click(screen.getByRole('tab', { name: sub[1] }))

    return
  }

  fireEvent.click(screen.getByRole('tab', { name }))
}

/** Sounds on or off as the person does it: the switch on roko's settings page (design system §5.6). */
async function turnSounds(on: boolean) {
  const view = mountContribution('settings.plugins', 'roko:settings')
  const sw = within(await screen.findByTestId('roko-settings')).getByRole('switch', { name: /Play short blips/ })

  if ((sw.getAttribute('aria-checked') === 'true') !== on) {
    fireEvent.click(sw)
  }

  await waitFor(() => expect(sw.getAttribute('aria-checked')).toBe(String(on)))
  view.unmount()
}

/** POST /setup/fix's `next` when git tracks roko.toml (readiness._commit_step). */
const COMMIT_NEXT = 'commit roko.toml before you merge a run, since the roko page merges only into a checkout without uncommitted changes: git -C /work/ws commit -m "roko: accept runs started from Hermes" -- roko.toml'

/** The Plans tab picks nothing but the start-here demo for the person: open a plan by its row. */
async function openPlan(id: string) {
  openTab(/^Plans/)

  const rows = await screen.findByRole('list', { name: 'roko plans' })
  const row = (await within(rows).findByText(id)).closest('button') as HTMLButtonElement

  fireEvent.click(row)

  return screen.findByTestId(`plan-card-${id}`)
}

const called = (method: string, pathWithQuery: string) =>
  api.mock.calls.some(([req]) => (req.method ?? 'GET') === method && req.path === `/api/plugins/roko${pathWithQuery}`)

const toastTitles = () => $notifications.get().map(n => n.title ?? '')

async function reloadPlugin() {
  await setPluginEnabled('roko', false)
  await setPluginEnabled('roko', true)
  await waitFor(() => expect(called('GET', '/overview')).toBe(true))
}

// -- lifecycle -------------------------------------------------------------------

const restores: Array<() => void> = []

beforeAll(async () => {
  fs.rmSync(HOME, { force: true, recursive: true })
  fs.mkdirSync(path.dirname(PLUGIN_FILE), { recursive: true })
  fs.mkdirSync(path.join(HOME, 'plugins', 'roko'), { recursive: true })
  fs.copyFileSync(SOURCE, PLUGIN_FILE)
  fs.writeFileSync(path.join(path.dirname(PLUGIN_FILE), '.hermes-package.json'), JSON.stringify({ package: 'roko' }))
  fs.writeFileSync(path.join(HOME, 'plugins', 'roko', 'plugin.yaml'), 'name: roko\n')

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = bridge
  $gateway.set({ request: gatewayRequest } as never)
  vi.stubGlobal('WebSocket', FakeSocket)

  // The loader imports plugins from blob: URLs, which vitest's module runner
  // can't load; reroute to data: URLs (as apps/desktop's own loader tests do).
  const RealBlob = globalThis.Blob

  vi.stubGlobal(
    'Blob',
    class {
      parts: string[]

      constructor(parts: string[]) {
        this.parts = parts
      }
    }
  )

  const create = vi
    .spyOn(URL, 'createObjectURL')
    .mockImplementation(
      blob =>
        `data:text/javascript;base64,${Buffer.from((blob as unknown as { parts: string[] }).parts.join('')).toString('base64')}`
    )

  const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  // ctx.os.notify only fires while the user is away from Hermes.
  const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)

  restores.push(() => {
    create.mockRestore()
    revoke.mockRestore()
    focus.mockRestore()
    vi.stubGlobal('Blob', RealBlob)
  })

  watchRuntimePlugins()
  await waitFor(() => expect($pluginRecords.get().roko).toBeDefined())
  // The unified package door is opt-in.
  expect($pluginRecords.get().roko.status).toBe('disabled')
  await setPluginEnabled('roko', true)
})

beforeEach(() => {
  backend.reset()
  api.mockClear()
  gatewayRequest.mockClear()
  nativeNotify.mockClear()
  writeClipboard.mockClear()
  relaunchApp.mockClear()
  selectPaths.mockReset()
  selectPaths.mockResolvedValue([])
  queryClient.removeQueries({ queryKey: ['roko'] })
  window.location.hash = '#/'
})

afterEach(() => {
  cleanup()
})

afterAll(() => {
  restores.forEach(restore => restore())
  delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
})

// -- tests -----------------------------------------------------------------------



/** Opens a fold of a run's page by its name (agents, steps, time, changes, receipt, about), as a click on it does. */
function openRunFold(card: HTMLElement, name: string) {
  const fold = card.querySelector(`[data-fold="${name}"]`) as HTMLDetailsElement | null

  if (!fold) {
    throw new Error(`the run's page has no ${name} fold`)
  }

  fold.open = true
  fireEvent(fold, new Event('toggle'))
}

/** Opens a run card's fold, as a click on its summary does (jsdom does not toggle <details> on its own). */
function openFold(card: HTMLElement) {
  const fold = card.querySelector('[data-testid="card-fold"]') as HTMLDetailsElement

  fold.open = true
  fireEvent(fold, new Event('toggle'))
}

describe('loading', () => {
  it('loads from <home>/plugins/roko/desktop/plugin.js and registers every contribution', () => {
    expect($pluginRecords.get().roko).toMatchObject({ file: PLUGIN_FILE, kind: 'disk', status: 'loaded' })

    expect(contribution('routes', 'roko:page')).toMatchObject({ data: { path: '/roko' }, source: 'plugin:roko' })
    expect(contribution('sidebar.nav', 'roko:nav')?.data).toMatchObject({ codicon: 'rocket', path: '/roko' })
    expect(contribution('statusBar.right', 'roko:chip')?.render).toBeTypeOf('function')

    const palette = registry.getArea('palette').filter(c => c.source === 'plugin:roko').map(c => (c.data as { label: string }).label)

    expect(palette).toEqual(['roko: Open', 'roko: New run…', "roko: What's waiting on me", 'roko: Loops', 'roko: Monitor pane', 'roko: Health check'])
    expect(contribution('keybinds', 'roko:keybind-new-run')?.data).toMatchObject({
      category: 'navigation',
      defaults: ['mod+alt+r'],
      id: 'roko.newRun',
      label: 'roko: New run'
    })

    const directives = registry
      .getArea('transcript.directives')
      .filter(c => c.source === 'plugin:roko')
      .map(c => (c.data as { name: string }).name)

    expect(directives).toEqual(['roko-run', 'roko-plan', 'roko-pending'])
    expect(document.head.querySelectorAll('style[data-hermes-plugin="roko"]')).toHaveLength(1)

    // 0.4.0: the surfaces around the chat.
    expect(contribution('panes', 'roko:monitor')?.data).toMatchObject({ hideOnly: true, placement: 'right' })
    expect((contribution('chat.empty', 'roko:delegate')?.data as { render: unknown }).render).toBeTypeOf('function')
    expect(contribution('composer.actions', 'roko:composer-key')?.render).toBeTypeOf('function')
    expect((contribution('sessionRow.trailing', 'roko:session-led')?.data as { render: unknown }).render).toBeTypeOf('function')
    expect(contribution('themes', 'roko:theme')?.data).toMatchObject({ label: 'roko', name: 'roko' })
    expect(contribution('settings.plugins', 'roko:settings')).toMatchObject({ title: 'roko' })
  })

  it('the sidebar row carries the waiting count once the overview loads', async () => {
    await reloadPlugin()
    await waitFor(() => expect((contribution('sidebar.nav', 'roko:nav')?.data as { label: string }).label).toBe('roko (2)'))
  })
})

describe('status bar chip', () => {
  it('shows the connection dot and the counts, and opens the Waiting tab', async () => {
    mountContribution('statusBar.right', 'roko:chip')

    const chip = await screen.findByTestId('roko-status-chip')

    // The most urgent state first (design system §4.9): 2 wait on the person; the counts are in its name.
    await waitFor(() => expect(within(chip).getByTestId('chip-waiting').textContent).toBe('waiting'))
    expect(chip.getAttribute('aria-label')).toBe('roko: 1 running · 2 waiting')
    expect(chip.querySelector('.rk-chip-glass .rk-dots')?.getAttribute('data-value')).toBe('2')

    fireEvent.click(chip)
    expect(window.location.hash).toBe('#/roko#tab=waiting')
  })

  it('says off when roko is unreachable, and degraded when it is', async () => {
    backend.reachable = false
    mountContribution('statusBar.right', 'roko:chip')

    const chip = await screen.findByTestId('roko-status-chip')

    await waitFor(() => expect(within(chip).getByTestId('chip-offline').textContent).toBe('off'))

    cleanup()
    backend.reachable = true
    backend.connectionStatus = 'degraded'
    queryClient.removeQueries({ queryKey: ['roko'] })
    mountContribution('statusBar.right', 'roko:chip')

    const again = await screen.findByTestId('roko-status-chip')

    await waitFor(() => expect(within(again).getByTestId('chip-degraded').textContent).toBe('degraded'))
  })
})

describe('the /roko page', () => {
  it('header: connection, spend, the selected run’s page, and Runs, the home', async () => {
    await mountPage({ run: RUN_ACTIVE })

    await waitFor(() => expect(screen.getByTestId('roko-connection').textContent).toBe('ok · 127.0.0.1:6677 · v0.1.0'))
    // Phase 2's S2 stills: at 1440 px "… limit $20.00 a day · $2.39 …" was cut; the line keeps what live runs hold and what
    // is left, and its title the limit too.
    expect(screen.getByTestId('roko-spend').textContent).toBe('$0.42 from Hermes · $1.00 held · $8.58 left')
    expect(screen.getByTestId('roko-spend').getAttribute('title')).toBe('$0.42 from Hermes · limit $10.00 a day · $1.00 held · $8.58 left')

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(within(card).getByText('lexer')).toBeTruthy())
    // T2 holds a sign-off for the person: the run needs them (design system §6.2).
    const pill = card.querySelector('.rk-runhead [data-testid="card-pill"]') as HTMLElement

    expect(pill.textContent).toBe('needs you')
    expect(pill.getAttribute('data-state')).toBe('you')
    // The glass (design system §4.2): its spend against its cap, on a meter that turns orange from 80 %.
    expect(within(card).getByRole('img', { name: 'spent $0.42 of $0.50' })).toBeTruthy()
    expect(within(card).getByTestId('spend-meter').getAttribute('data-tone')).toBe('you')
    // The graph: one node per task, in waves, each with its state.
    const node = (id: string) => card.querySelector(`.roko-node[data-node="${id}"]`) as HTMLElement
    expect(node('T1').getAttribute('data-state')).toBe('passed')
    expect(node('T2').getAttribute('data-state')).toBe('running')
    expect(node('T3').getAttribute('data-state')).toBe('pending')
    // T2 holds a sign-off for the person: the graph says so.
    expect(node('T2').getAttribute('aria-label')).toBe('T2 Report, retrying, waiting on you')
    expect(within(node('T2')).getByText('×2')).toBeTruthy()
    expect(card.querySelector('.roko-edge[data-state="done"]')).toBeTruthy()
    expect(within(card).getByText('W1')).toBeTruthy()
    // The head's readings, and the request the person typed.
    expect(within(card).getByText('Add tests for the lexer and the parser, and write up what they cover.')).toBeTruthy()
    expect(within(card).getByTestId('card-eta').textContent).toContain('~4 min')
    expect(within(card).getByRole('img', { name: '1 of 3 tasks passed, 1 running' })).toBeTruthy()
    // What runs now: the horizon (spec v3 §4.8) says the run waits on the person, and its asks come first.
    expect(within(card).getByTestId('horizon').textContent).toContain('waiting on you')
    expect(within(within(card).getByTestId('run-waiting')).getAllByTestId(/^pending-[0-9a-f]{6}$/)).toHaveLength(2)
    expect(within(card).getByRole('button', { name: 'Stop run' })).toBeTruthy()

    // Runs, the home (design system §5.1): what needs the person, what runs, then what ran, a line each.
    fireEvent.click(screen.getByTestId('crumb-runs'))

    const home = await screen.findByTestId('runs-home')

    expect(within(home).getByRole('region', { name: 'Running' }).textContent).toContain('add-tests')

    const list = within(home).getByRole('list', { name: 'roko runs' })

    expect(within(list).getByText('Add clamp() with a test')).toBeTruthy()
    expect(within(list).getByText('Plan the parser rewrite')).toBeTruthy()
    expect(window.location.hash).toBe('#/roko')

    // roko answered late or asked to wait (the backend's "slow"): busy, not down.
    backend.connectionStatus = 'slow'
    await refreshOverview()
    await waitFor(() => expect(screen.getByTestId('roko-connection').textContent).toBe('busy · 127.0.0.1:6677 · v0.1.0'))
  })

  it('selecting a run shows its delivery and copies the review command; the selection lives in the hash', async () => {
    await mountPage()

    fireEvent.click(within(screen.getByRole('list', { name: 'roko runs' })).getByText('Add clamp() with a test'))

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    expect(window.location.hash).toBe(`#/roko#run=${RUN_DONE}`)
    // Its changes are a fold of its page (design system §4.11): the branch, the diff, and the commands.
    openRunFold(card, 'changes')
    await waitFor(() => expect(within(card).getByText(`roko/batch/${RUN_DONE}`)).toBeTruthy())
    expect(window.location.hash).toBe(`#/roko#run=${RUN_DONE}&view=changes`)
    expect(within(card).getByText('1 file changed, 30 insertions(+)')).toBeTruthy()
    expect(within(card).getByText('src/lib.rs')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Stop run' })).toBeNull()

    fireEvent.click(within(card).getByRole('button', { name: /Copy review command/ }))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(`git -C /work/ws diff HEAD...roko/batch/${RUN_DONE}`))
    expect(await within(card).findByText('Copied')).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: /Copy merge command/ }))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(`git -C /work/ws merge roko/batch/${RUN_DONE}`))
  })

  it('an unverified run is amber, never green, and unknown money is a dash', async () => {
    await mountPage()

    fireEvent.click(within(screen.getByRole('list', { name: 'roko runs' })).getByText('Plan the parser rewrite'))

    const card = await screen.findByTestId(`run-card-${RUN_UNVERIFIED}`)

    await waitFor(() => expect(card.querySelector('[data-testid="card-pill"]')?.getAttribute('data-state')).toBe('stop'))
    expect(card.querySelector('[data-testid="card-pill"]')?.textContent).toContain('not checked')
    // The instrument's one number says it does not know (spec v3 §9: null money is "—").
    expect(within(card).getByTestId('card-spent').querySelector('svg')?.getAttribute('aria-label')).toMatch(/^spent —/)
  })

  it('honours #/roko?run=<id> (hermes://open/roko?run=…) on load', async () => {
    window.location.hash = `#/roko?run=${RUN_DONE}`
    mountContribution('routes', 'roko:page')

    expect(await screen.findByTestId(`run-card-${RUN_DONE}`)).toBeTruthy()
  })

  it('Activity loads incrementally with next_cursor, filters, and prints agent notes literally', async () => {
    // Earlier tests cached this run's events; start from an empty cache.
    await reloadPlugin()
    api.mockClear()
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    openRunFold(card, 'steps')

    expect(await within(card).findByText('T1 started: lexer')).toBeTruthy()
    expect(await within(card).findByText('T2 gate verify[0:test] failed')).toBeTruthy()
    // Round v7: a run this window has not read opens on its newest lines, then follows from there.
    expect(called('GET', `/runs/${RUN_ACTIVE}/events?tail=400`)).toBe(true)
    expect(called('GET', `/runs/${RUN_ACTIVE}/events?limit=200&cursor=4703`)).toBe(true)
    // An agent's words are a quote, and stay text.
    expect(within(card).getByText('“<b>done</b> with the **lexer**”')).toBeTruthy()
    expect(card.querySelector('.roko-feed b')).toBeNull()
    // Times are relative to the run's start.
    expect(card.querySelector('.roko-feed-time')?.textContent).toMatch(/^\+\d+:\d{2}$/)
    // Problems only.
    fireEvent.click(within(card).getByRole('button', { name: /^Problems/ }))
    expect(within(card).queryByText('T1 started: lexer')).toBeNull()
    expect(within(card).getByText('T2 gate verify[0:test] failed')).toBeTruthy()
  })

  it('Stop asks first, then POSTs /runs/{id}/cancel', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    fireEvent.click(await within(card).findByRole('button', { name: 'Stop run' }))

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('Stop this roko run?')).toBeTruthy()
    expect(called('POST', `/runs/${RUN_ACTIVE}/cancel`)).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop run' }))
    await waitFor(() => expect(called('POST', `/runs/${RUN_ACTIVE}/cancel`)).toBe(true))
  })
})

describe('Waiting tab', () => {
  it('lists what waits on the person, with untrusted text printed literally', async () => {
    await mountPage()
    openTab(/^Waiting/)

    const confirm = await screen.findByTestId('pending-a1b2c3')
    const effect = await screen.findByTestId('pending-d4e5f6')

    expect(within(confirm).getByText('Accept the report T2 wrote?')).toBeTruthy()
    expect(within(confirm).getByText('the result of task T2 (Report) in run add-tests')).toBeTruthy()
    // The summary is text: the <img> markup and the markdown stay literal.
    expect(within(confirm).getByText(/<img src=x onerror="alert\(1\)"> \*\*not bold\*\*/)).toBeTruthy()
    expect(confirm.querySelector('img')).toBeNull()
    expect(confirm.querySelector('strong')).toBeNull()
    expect(within(confirm).getByRole('button', { name: 'Show more' })).toBeTruthy()
    expect(within(confirm).getByText(/^\d+:\d{2} left$/)).toBeTruthy()

    expect(within(effect).getByText('mail.send@mail')).toBeTruthy()
    expect(within(effect).getByText('to: string')).toBeTruthy()
    // The stamp says what it is; the countdown says what happens at 0:00 (spec v3 §5.4).
    expect(within(effect).getByText('held call')).toBeTruthy()
    expect(within(effect).getByText('roko holds the call: nothing is sent until you answer')).toBeTruthy()
    expect(within(confirm).getByText('no check ran on this: your answer decides')).toBeTruthy()
    expect(within(confirm).getByTestId('pending-countdown').textContent).toMatch(/\d+:\d{2} left · then unverified$/)
  })

  it('a approves and r rejects from the card; typing in its note does neither (spec v3 §5.4)', async () => {
    await mountPage()
    openTab(/^Waiting/)

    const confirm = await screen.findByTestId('pending-a1b2c3')

    fireEvent.keyDown(within(confirm).getByRole('textbox', { name: 'Note for roko (optional)' }), { key: 'a' })
    expect(called('POST', '/decide')).toBe(false)
    fireEvent.keyDown(confirm, { key: 'a' })
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ body: { approve: true, code: 'a1b2c3' }, method: 'POST', path: '/api/plugins/roko/decide' })))
  })

  it('Approve sends POST /decide with the code and the note, shows the outcome and refreshes', async () => {
    await mountPage()
    openTab(/^Waiting/)

    const confirm = await screen.findByTestId('pending-a1b2c3')

    fireEvent.change(within(confirm).getByRole('textbox', { name: 'Note for roko (optional)' }), { target: { value: 'looks right' } })
    fireEvent.click(within(confirm).getByRole('button', { name: 'approve' }))

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({ body: { approve: true, code: 'a1b2c3', note: 'looks right' }, method: 'POST', path: '/api/plugins/roko/decide' })
      )
    )
    await waitFor(() => expect(toastTitles()).toContain('roko: Approved · applied'))
    // Refreshed: the answered item is gone.
    await waitFor(() => expect(screen.queryByTestId('pending-a1b2c3')).toBeNull())
  })

  it('an answered item leaves Waiting at once, while roko still lists it for a moment', async () => {
    backend.listsAnswered = true
    await mountPage()
    openTab(/^Waiting/)

    const confirm = await screen.findByTestId('pending-a1b2c3')

    fireEvent.click(within(confirm).getByRole('button', { name: 'approve' }))
    await waitFor(() => expect(toastTitles()).toContain('roko: Approved · applied'))
    await waitFor(() => expect(screen.queryByTestId('pending-a1b2c3')).toBeNull())
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'pending'] })
    })
    expect(screen.queryByTestId('pending-a1b2c3')).toBeNull()
    // roko settles it: once its list drops the item, the page forgets the answer.
    backend.pending = backend.pending.filter(item => item.code !== 'a1b2c3')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'pending'] })
    })
  })

  it('Reject without a note sends no note; a refused decision shows the error and hint', async () => {
    await mountPage()
    openTab(/^Waiting/)

    const effect = await screen.findByTestId('pending-d4e5f6')

    fireEvent.click(within(effect).getByRole('button', { name: 'decline' }))
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.objectContaining({ body: { approve: false, code: 'd4e5f6' }, path: '/api/plugins/roko/decide' }))
    )
    // roko's outcome only when it adds to the verb: not "Rejected · rejected".
    await waitFor(() => expect(toastTitles()).toContain('roko: Rejected'))
    expect(toastTitles()).not.toContain('roko: Rejected · rejected')

    backend.failures.set('/decide', { code: 'not_found', hint: 'It may have been answered already.', message: 'No waiting item a1b2c3.' })

    const confirm = await screen.findByTestId('pending-a1b2c3')

    fireEvent.click(within(confirm).getByRole('button', { name: 'approve' }))
    expect(await within(confirm).findByText('No waiting item a1b2c3.')).toBeTruthy()
    expect(within(confirm).getByText(/It may have been answered already\./)).toBeTruthy()
  })
})

describe('Plans tab', () => {
  it('lists the demos first, the one to start with on top, opens on it, and picks no real plan', async () => {
    // A fresh plugin: no plan picked in an earlier test.
    await reloadPlugin()
    await mountPage()
    openTab(/^Plans/)

    const rows = await screen.findByRole('list', { name: 'roko plans' })

    expect([...rows.querySelectorAll('.roko-list-section')].map(el => el.firstChild?.textContent)).toEqual(['Demos', 'Your plans', 'parser-programme'])
    expect([...rows.querySelectorAll('.roko-row-title')].map(el => el.textContent)).toEqual([
      'Start here: hello world demo',
      'Roko plan-runner demo',
      'Add tests',
      'Parser rewrite'
    ])
    expect(within(rows).getByText('start here')).toBeTruthy()
    // roko's `fixture` marker is not shown as the demo's status.
    expect(within(rows).queryByText('fixture')).toBeNull()
    expect(await screen.findByTestId('plan-card-demo-hello-world')).toBeTruthy()
    expect(screen.queryByTestId('plan-card-add-tests')).toBeNull()
  })

  it('without a demo to start with, nothing is picked until the person picks', async () => {
    await reloadPlugin()
    backend.plans = backend.plans.filter(plan => !String(plan.group ?? '').startsWith('demos'))
    await mountPage()
    openTab(/^Plans/)

    expect(await screen.findByText('Pick a plan')).toBeTruthy()

    const rows = screen.getByRole('list', { name: 'roko plans' })

    expect([...rows.querySelectorAll('.roko-list-section')].map(el => el.firstChild?.textContent)).toEqual(['Plans', 'parser-programme'])
    expect(screen.queryByTestId('plan-card-add-tests')).toBeNull()
    expect(called('GET', '/plans/add-tests')).toBe(false)
  })

  it('a plan the backend marks as a demo is listed under Demos; a demo- id it does not mark is the person’s', async () => {
    await reloadPlugin()
    // The backend says which plans are roko's demos (`demo`: roko's demos set, or its fixture flag), after a run too.
    backend.plans = [
      { id: 'add-tests', title: 'Add tests', task_count: 3, tasks_done: 1, status: 'ready', group: 'work' },
      { id: 'demo-mine', title: 'My own demo plan', task_count: 1, tasks_done: 0, status: 'ready' },
      { id: 'demo-hello', title: 'Roko plan-runner demo', task_count: 1, tasks_done: 1, status: 'done', group: 'demos', demo: true }
    ]
    await mountPage()
    openTab(/^Plans/)

    const rows = await screen.findByRole('list', { name: 'roko plans' })
    const titles = () => [...rows.querySelectorAll('.roko-row-title')].map(el => el.textContent)
    const sections = () => [...rows.querySelectorAll('.roko-list-section')].map(el => el.firstChild?.textContent)

    expect(sections()).toEqual(['Demos', 'Your plans', 'work'])
    expect(titles()).toEqual(['Roko plan-runner demo', 'My own demo plan', 'Add tests'])
  })

  it('shows waves, task chips, checks and the estimate', async () => {
    await mountPage()
    const card = await openPlan('add-tests')

    expect(within(card).getByText('W1')).toBeTruthy()
    expect(within(card).getByText('W2')).toBeTruthy()
    expect(within(card).getByText('lexer')).toBeTruthy()
    expect(within(card).getByText('Report')).toBeTruthy()
    expect(within(card).getByText('after T1')).toBeTruthy()
    expect(within(card).getByText('2 checks')).toBeTruthy()
    expect(within(card).getByTestId('plan-estimate').textContent).toBe('est $0.03 · ~30s · confidence low')
  })

  it('P-1: the plan sheet shows what the chat asked roko for, labelled as the chat model’s words', async () => {
    const reworded = 'Create a roko plan for a macOS VST3 synthesizer plugin for hypnotic techno basslines. The plan should cover product definition, sound engine architecture and UI/UX direction. Constraints: do not run anything now; only write the plan. Cap planning spend at $0.40 total.'

    backend.planExtra['add-tests'] = { asked: { text: reworded, spec_path: null, by: 'chat', run_id: 'w-1', at: new Date().toISOString() } }
    await mountPage()

    const card = await openPlan('add-tests')
    const asked = within(card).getByTestId('plan-asked')

    expect(asked.textContent).toContain('what the chat asked roko')
    expect(asked.textContent).toContain('the chat model’s words, as Hermes sent them')
    expect(asked.querySelector('.rk-asked-text')?.textContent).toBe(reworded)
  })

  it('roko 7c3b523a8: the plan sheet lists roko’s repairs to its planner’s draft, in roko’s words, code as code', async () => {
    const line = 'T1: `core/src/envelope.h` became `core/include/undertow/envelope.h` in its files and its text'

    backend.planExtra['add-tests'] = { repairs: [line, 'dropped context files that do not exist: `docs/old.md`'] }
    await mountPage()

    const repairs = within(await openPlan('add-tests')).getByTestId('plan-repairs')

    expect(repairs.textContent).toContain('roko repaired the draft')
    expect([...repairs.querySelectorAll('li')].map(li => li.textContent)).toEqual([
      'T1: core/src/envelope.h became core/include/undertow/envelope.h in its files and its text',
      'dropped context files that do not exist: docs/old.md'
    ])
    expect(repairs.querySelectorAll('li code')).toHaveLength(3)
  })

  it('P-41: the plan sheet shows roko’s validator notes, its code and its words', async () => {
    const message = "T2's check `tools/spec.sh 2_2 gain 'P2.2.03*'` needs core/src/gain.cpp, which only T3 writes"

    backend.planExtra['add-tests'] = { validator_notes: [{ rule: 'PLAN_058', task_id: 'T2', message }] }
    await mountPage()

    const notes = within(await openPlan('add-tests')).getByTestId('validator-notes')

    expect(notes.textContent).toBe(`roko’s validator notesPLAN_058 T2: ${message}`)
  })

  it('P-1: a plan written from a spec on this page says so, with the spec roko read', async () => {
    backend.planExtra['add-tests'] = { asked: { text: null, spec_path: 'docs/specs/phase-2-rumble.md', by: 'page', run_id: 'w-2', at: new Date().toISOString() } }
    await mountPage()

    const asked = within(await openPlan('add-tests')).getByTestId('plan-asked')

    expect(asked.textContent).toContain('what you asked roko')
    expect(asked.textContent).toContain('the spec docs/specs/phase-2-rumble.md, which roko read itself')
    expect(asked.querySelector('.rk-asked-text')).toBeNull()
    expect(within(asked).queryByTestId('plan-asked-cap')).toBeNull()
  })

  it('P-43: the plan sheet says what writing the plan cost of its cap, after the writing ended', async () => {
    backend.planExtra['add-tests'] = {
      asked: { text: null, spec_path: 'docs/specs/phase-3-sequencer.md', by: 'chat', run_id: 'w-3', at: new Date().toISOString(), cost_usd: 0.04, max_usd: 0.5 }
    }
    await mountPage()

    const asked = within(await openPlan('add-tests')).getByTestId('plan-asked')

    expect(within(asked).getByTestId('plan-asked-cap').textContent).toBe('writing it cost $0.04 of its $0.50 cap')
  })

  it('Run plan… asks for the cap, confirms the spend, POSTs /plans/{id}/run and opens the run', async () => {
    await mountPage()
    const card = await openPlan('add-tests')

    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))

    const form = await screen.findByRole('dialog')
    const cap = within(form).getByLabelText('Spend cap (max_usd)') as HTMLInputElement

    // The same starting cap as the composer's.
    expect(cap.value).toBe('0.50')
    fireEvent.change(cap, { target: { value: '0' } })
    expect(within(form).getByText('Enter a cap of at least $0.01.')).toBeTruthy()
    expect((within(form).getByRole('button', { name: 'Continue…' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(cap, { target: { value: '2.5' } })
    fireEvent.click(within(form).getByRole('switch'))
    fireEvent.click(within(form).getByRole('button', { name: 'Continue…' }))

    const confirm = await screen.findByRole('dialog', { name: 'Start a paid roko run?' })

    expect(within(confirm).getByText(/may spend up to \$2\.50 on model calls, resuming its last run\. This spends real money\./)).toBeTruthy()
    expect(called('POST', '/plans/add-tests/run')).toBe(false)

    fireEvent.click(within(confirm).getByRole('button', { name: 'Run plan' }))

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({ body: { max_usd: 2.5, resume: true, title: 'Add tests' }, method: 'POST', path: '/api/plugins/roko/plans/add-tests/run' })
      )
    )
    expect(await screen.findByTestId(`run-card-${RUN_NEW}`)).toBeTruthy()
    expect(window.location.hash).toBe(`#/roko#run=${RUN_NEW}`)
  })
})

describe('interrupted runs', () => {
  it('a run roko ended as interrupted reads as its own outcome: its reason, what a resume may do, no Merge', async () => {
    const id = '5b0c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4'
    const reason = 'roko stopped while this run was going (machine restart or crash)'
    const note = 'A resume continues where roko can, but if a task was stopped mid-call roko may start the run over and run passed tasks again (a known roko defect, being fixed).'

    backend.runs = [
      {
        run_id: id,
        kind: 'plan',
        label: 'crash-demo',
        plan_id: 'crash-demo',
        state: 'interrupted',
        active: false,
        cost_usd: 0.12,
        max_usd: 0.5,
        started_at: new Date(Date.now() - 600_000).toISOString(),
        interrupted: { reason, at: new Date(Date.now() - 300_000).toISOString() },
        next: { action: 'rerun', label: 'resume the plan', resume: true, why: reason, note },
        delivered: { workspace: '/work/ws', branch: 'roko/batch/crash-demo', commit: 'abc1234', merged: false },
        merge_command: 'git -C /work/ws merge roko/batch/crash-demo'
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const why = await within(card).findByTestId('why')

    expect(why.textContent).toContain('roko stopped mid-run')
    expect(why.textContent).toContain(reason)
    // P-51, softened by the lead from roko-recovery's kill matrix: what a resume may do, in the backend's words.
    expect(within(why).getByTestId('why-next').textContent).toBe(note)
    expect(within(card).queryByTestId('merge-button')).toBeNull()
    expect(within(card).queryByRole('button', { name: /Copy merge command/ })).toBeNull()
    expect(called('GET', `/runs/${id}/merge`)).toBe(false)

    // On Runs it is its own outcome, orange: not a failure, not a pass.
    fireEvent.click(screen.getByTestId('crumb-runs'))

    const row = (await screen.findByTestId(`run-line-${id}`)) as HTMLElement

    expect(row.textContent).toContain('interrupted')
    expect(row.getAttribute('data-state')).toBe('you')
  })
})

describe('interrupted runs: nothing looks alive (P4)', () => {
  it('a task roko last had running shows stopped, with no step or clock, and the TASKS cell says stopped, not running', async () => {
    const id = '5b0c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c5'

    backend.runs = [
      {
        run_id: id,
        kind: 'plan',
        label: 'docs-plan',
        plan_id: 'docs-plan',
        state: 'interrupted',
        active: false,
        cost_usd: 0.02,
        max_usd: 0.25,
        started_at: new Date(Date.now() - 120_000).toISOString(),
        interrupted: { reason: 'roko stopped while this run was going (machine restart or crash)', at: new Date(Date.now() - 60_000).toISOString() },
        progress: { total: 3, passed: 1, failed: 0, running: 1, pending: 1, blocked: 0, stopped: 0, unverified: 0 },
        tasks: [
          { task_id: 'T1', title: 'readme', outcome: 'passed', attempts: 1, depends_on: [] },
          { task_id: 'T2', title: 'changelog', outcome: 'running', attempts: 1, step: 'tool', step_detail: 'write_file CHANGELOG.md', step_since: new Date(Date.now() - 55_000).toISOString(), depends_on: ['T1'] },
          { task_id: 'T3', title: 'guide', outcome: 'pending', attempts: 0, depends_on: ['T2'] }
        ]
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const graph = await within(card).findByTestId('run-graph')

    expect(graph.querySelector('.roko-node[data-node="T2"]')?.getAttribute('data-state')).toBe('stopped')
    expect(graph.querySelector('.roko-node[data-state="running"]')).toBeNull()
    expect(card.textContent).not.toContain('write_file CHANGELOG.md')

    const tasks = within(card).getByTestId('card-tasks')

    expect(tasks.textContent).not.toMatch(/running/)
    expect(tasks.textContent).toContain('1 stopped')
    // Without the backend's note the page makes no promise of its own about a resume.
    expect(within(card).queryByTestId('why-next')).toBeNull()
  })
})

describe('check names', () => {
  it('names checks by roko’s own rung numbers: lint, gen-test, whole-plan (1000), post-merge (1001)', async () => {
    const answer = loopsAnswer() as { rings: Array<Record<string, unknown>> }
    const ring = (id: string) => answer.rings.find(r => r.ring === id) as Record<string, unknown>

    ring('L1').retry_budgets = [{ rung: 1, ema_pass_rate: 0.8, observations: 10, suggested_max_retries: 2, should_skip: false }]
    ring('L3').thresholds = [
      { rung: '1000', ema_pass_rate: 0.94, observations: 80 },
      { rung: 1001, ema_pass_rate: 0.72, observations: 13 },
      { rung: 4, ema_pass_rate: 1, observations: 2 }
    ]
    backend.loops = answer
    await mountPage({ tab: 'loops' })

    const l1 = await screen.findByTestId('ring-L1')
    const l3 = screen.getByTestId('ring-L3')

    expect(await within(l1).findByText('lint up to 2 retries · passes 80%')).toBeTruthy()
    expect(await within(l3).findByText('whole-plan check · passes 94% · 80 runs seen')).toBeTruthy()
    expect(within(l3).getByText('post-merge check · passes 72% · 13 runs seen')).toBeTruthy()
    expect(within(l3).getByText('gen-test check · passes 100% · 2 runs seen')).toBeTruthy()
  })
})

/** roko's validator on a plan: one question its planner left open (PLAN_045), and one other finding in roko's words. */
const PLAN_INVALID = {
  valid: false,
  errors: [
    { rule: 'PLAN_045', task_id: 'T2', message: "task 'T2' has open questions, so its plan cannot run" },
    { rule: 'PLAN_012', task_id: 'T3', message: "task 'T3' depends on 'T9', which the plan does not have" }
  ],
  open_questions: [{ task_id: 'T2', question: 'Should top_words raise on n < 1?', assumption: 'return an empty list' }],
  summary: "PLAN_045: task 'T2' has open questions, so its plan cannot run; PLAN_012: task 'T3' depends on 'T9'"
}

describe('checks, tokens and plans roko will not run (0.5.0 fields)', () => {
  it('a retry that passed is not a failure: CHECKS reads 10/10 · 1 retried, not red; cache reads count in the token line', async () => {
    const id = '8d06bbba-0000-4000-8000-000000000001'

    backend.runs = [
      { run_id: id, kind: 'plan', label: 'four tasks', plan_id: 'add-tests', state: 'succeeded', active: false, cost_usd: 0.07, max_usd: 0.5, started_at: new Date(Date.now() - 300_000).toISOString(), gates: { passed: 10, failed: 0, total: 10, retried: 1 } },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const checks = await within(card).findByTestId('card-checks')

    expect(within(checks).getByLabelText('10 of 10 checks passed')).toBeTruthy()
    expect(checks.textContent).toContain('passed · 1 retried')
    expect(checks.textContent).not.toContain('did not pass')
    expect(within(card).getByTestId('run-tokens').textContent).toBe('3,352 in · 655 out · 10,368 cached tokens')
  })

  it('a plan roko will not run yet says why on its card, with the questions its planner left, and Run plan… is off', async () => {
    backend.validation['add-tests'] = {
      valid: false,
      errors: [{ rule: 'PLAN_045', task_id: 'T2', message: "task 'T2' has open questions, so its plan cannot run" }],
      open_questions: [{ task_id: 'T2', question: 'Should top_words raise on n < 1?', assumption: 'return an empty list' }],
      summary: "PLAN_045: task 'T2' has open questions, so its plan cannot run; answer each in the spec, then delete it from open_questions"
    }
    await mountPage()

    const card = await openPlan('add-tests')
    const note = await within(card).findByTestId('plan-validation')

    expect(note.textContent).toContain('roko won’t run this plan yet')
    expect(note.textContent).toContain('T2 Should top_words raise on n < 1? · suggested: return an empty list')
    // On the plan's sheet a question is a card that asks (spec v3 §5.5): ⌈OPEN QUESTION⌋, the question, the planner's
    // suggestion, and what happens while it stays open.
    const asked = within(note).getByTestId('open-question-card')

    expect(asked.querySelector('.rk-stamp')?.textContent).toBe('open question')
    expect(asked.querySelector('.rk-oq-q')?.textContent).toBe('T2 Should top_words raise on n < 1?')
    expect(asked.textContent).toContain('unanswered, roko won’t run the plan')
    expect(note.textContent).toContain('roko plan validate plans/add-tests')
    // The open-questions rule is said by the questions themselves.
    expect(note.textContent).not.toContain('has open questions, so its plan cannot run')
    expect((within(card).getByTestId('run-plan') as HTMLButtonElement).disabled).toBe(true)

    // The task that asks: a tag on its pad, and its questions in its inspector.
    expect(within(card).getByTestId('open-question-T2').textContent).toBe('open question')
    expect(within(card).queryByTestId('open-question-T1')).toBeNull()
    fireEvent.click(card.querySelector('.roko-node[data-node="T2"]') as HTMLElement)
    expect((await within(card).findByTestId('task-open-questions')).textContent).toBe('Should top_words raise on n < 1? · suggested: return an empty list')
  })

  it('a plan run roko refuses for its plan says why beside the plan, in roko’s words and its questions, and Run plan… goes off', async () => {
    backend.refuseRunFor['add-tests'] = PLAN_INVALID
    await mountPage()

    const card = await openPlan('add-tests')

    expect(within(card).queryByTestId('plan-validation')).toBeNull()
    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue…' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Start a paid roko run?' })).getByRole('button', { name: 'Run plan' }))

    const note = await within(card).findByTestId('plan-validation')

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a paid roko run?' })).toBeNull())
    expect(note.textContent).toContain("T3 task 'T3' depends on 'T9', which the plan does not have · PLAN_012")
    expect(note.textContent).toContain('T2 Should top_words raise on n < 1? · suggested: return an empty list')
    expect(note.textContent).not.toContain('has open questions, so its plan cannot run')
    await waitFor(() => expect((within(card).getByTestId('run-plan') as HTMLButtonElement).disabled).toBe(true))
    expect(within(card).getAllByTestId('plan-validation')).toHaveLength(1)
    expect(document.querySelector('.roko-result[data-tone=bad]')).toBeNull()
  })

  it('the composer says why roko refused the plan, and Run plan goes off', async () => {
    backend.refuseRunFor['add-tests'] = PLAN_INVALID
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const dialog = await screen.findByRole('dialog')

    fireEvent.click(await within(dialog).findByTestId('composer-plan-key'))
    fireEvent.click((await within(dialog).findByTestId('composer-plan')).querySelector('[data-pick="add-tests"]') as HTMLElement)
    await waitFor(() => expect(within(dialog).getByTestId('composer-plan-facts').textContent).toBe('3 tasks · 2 waves · roko estimates $0.03'))
    fireEvent.click(within(dialog).getByTestId('composer-submit'))

    const note = await within(dialog).findByTestId('plan-validation')

    expect(note.textContent).toContain('T2 Should top_words raise on n < 1? · suggested: return an empty list')
    expect(note.textContent).toContain('roko plan validate plans/add-tests')
    expect(dialog.querySelector('.roko-result[data-tone=bad]')).toBeNull()
    expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('a plan-writing card whose plan roko will not run: “cannot run yet” in orange, the next step in words, the plan’s note under it', async () => {
    const id = '3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f'

    backend.validation['add-tests'] = PLAN_INVALID
    backend.runs = [
      {
        run_id: id,
        kind: 'plan_generate',
        label: 'Add two small modules to wordy',
        plan_id: 'add-tests',
        state: 'succeeded',
        active: false,
        cost_usd: 0.01,
        max_usd: null,
        started_at: new Date(Date.now() - 60_000).toISOString(),
        task_count: 3,
        validation: PLAN_INVALID,
        why: { summary: `roko wrote the plan, but it cannot run yet: ${String(PLAN_INVALID.summary)}`, validation: PLAN_INVALID },
        next: { action: null, label: "answer the plan's open questions", why: PLAN_INVALID.summary },
        headline: 'succeeded · plan add-tests · 3 tasks · cannot run yet'
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const top = card.querySelector('.roko-hero-top') as HTMLElement

    expect(top.textContent).toContain('cannot run yet')
    expect(top.textContent).not.toContain('plan written')
    expect(top.querySelector('.roko-pill[data-tone="warn"] .roko-pill-glyph')?.textContent).toBe('?')
    expect(within(top).getByTestId('next').textContent).toBe("answer the plan's open questions")
    expect(within(top).getByTestId('next').getAttribute('data-action')).toBe('none')
    expect((card.querySelector('.roko-headline') as HTMLElement).textContent).toBe('plan written · plan add-tests · 3 tasks · cannot run yet')
    expect((await within(card).findByTestId('plan-validation')).textContent).toContain('T2 Should top_words raise on n < 1? · suggested: return an empty list')
  })

  it('a plan run whose plan failed roko’s check while it waited lists what roko found, not one long sentence', async () => {
    const id = '4d5e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a'

    backend.runs = [
      {
        run_id: id,
        kind: 'plan',
        label: 'Parser rewrite',
        plan_id: 'parser-rewrite',
        state: 'failed',
        active: false,
        cost_usd: 0,
        max_usd: 0.5,
        started_at: new Date(Date.now() - 120_000).toISOString(),
        why: {
          summary:
            "roko did not start the run: its plans failed validation with 1 error(s) while it was queued. roko's check of the plan says: PLAN_045: task 'T2' has open questions. Open questions: (1) Should top_words raise on n < 1? (suggested: return an empty list).",
          start_error: 'its plans failed validation with 1 error(s) while it was queued',
          validation: PLAN_INVALID
        }
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const why = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('why')

    expect(why.textContent).toContain('roko did not start the run: its plans failed validation with 1 error(s) while it was queued.')
    expect(why.textContent).not.toContain('roko’s check of the plan says')
    expect(why.textContent).not.toContain("roko's check of the plan says")
    expect(within(why).getByTestId('validation-items').textContent).toContain('T2 Should top_words raise on n < 1? · suggested: return an empty list')
    // Its plan's folder, from the plans list.
    await waitFor(() => expect(why.textContent).toContain('roko plan validate plans/parser-programme/parser-rewrite'))
  })
})

/** plugin-runs' real card for a plan run roko stopped at its cap (out/plan-9f468701-card.json, roko bug-4fabd0). */
const CAP_RUN = '9f468701-fa29-421a-bcb1-369377c12c6d'
const capStopRow = () => ({
  run_id: CAP_RUN,
  kind: 'plan',
  label: 'Cap stop',
  plan_id: 'cap-stop',
  state: 'failed',
  active: false,
  cost_usd: 0.032,
  max_usd: 0.05,
  started_at: new Date(Date.now() - 120_000).toISOString(),
  headline: 'stopped: the run reached its cap · tasks 0/2 · $0.032 of $0.05 · 3s',
  budget_stop: {
    cap_usd: 0.05,
    spent_usd: 0.032,
    plan_id: null,
    stopped: [{ task_id: 'T2', before: 'model_call', next_call_usd: 0.021, left_usd: 0.018, attempt_needs_usd: null }],
    not_started: [{ task_id: 'T1', left_usd: 0.018, attempt_needs_usd: 0.05 }],
    said: "plan budget exhausted: the attempt's next model call would cost about $0.0210, as much as its last, and only $0.0180 of the plan's $0.0500 cap is left"
  },
  next: { action: 'rerun', label: 'raise the cap and run it again', why: 'it reached its cap of $0.05 ($0.032 spent)' },
  progress: { total: 2, passed: 0, failed: 0, running: 0, pending: 0, blocked: 0, stopped: 2, unverified: 0 },
  why: {
    summary:
      'The run stopped: it reached its cap of $0.05, with $0.032 spent. T2 was stopped before its next model call, which would have cost about $0.021 with only $0.018 of the cap left; it did not fail. T1 did not start: only $0.018 of the cap was left, less than an attempt needs ($0.05).',
    gates_not_passed: [],
    blocked: [],
    unverified_tasks: [],
    errors: []
  },
  graph: { waves: [['T1', 'T2']], edges: [] },
  gates: { passed: 0, failed: 0, total: 0, retried: 0 },
  tasks: [
    { task_id: 'T1', title: 'Read the README', outcome: 'stopped', reason: "did not start at the run's cap: only $0.018 of the $0.05 cap was left, less than an attempt needs ($0.05)", model: null, provider: null, attempts: 0, cost_usd: null, depends_on: [], gates: [] },
    { task_id: 'T2', title: 'Add shout to wordy', outcome: 'stopped', reason: "stopped at the run's cap: its next model call would cost about $0.021, and only $0.018 of the $0.05 cap was left", model: 'fake-model-1', provider: 'fakeapi', attempts: 1, cost_usd: 0.032, depends_on: [], gates: [] }
  ]
})

describe('a run roko stopped at its cap (0.5.0 budget_stop)', () => {
  it('reads as a stop, not a failure: STOPPED · CAP, why it stopped, the tasks it stopped, and raise the cap', async () => {
    backend.runs = [capStopRow(), ...backend.runs]
    await mountPage({ run: CAP_RUN })

    const card = await screen.findByTestId(`run-card-${CAP_RUN}`)
    const pill = within(card).getByTestId('card-pill')

    // The head says it as a stop, in the stop's grey (design system §6.2), and its sentence says the cap and the spend.
    expect(pill.textContent).toBe('■stopped at cap')
    expect(pill.getAttribute('data-state')).toBe('stop')
    expect(within(card).getByTestId('card-status').textContent).toBe('roko stopped the run at its cap of $0.05 ($0.03 spent).')

    const why = within(card).getByTestId('why')

    expect(why.getAttribute('data-tone')).toBe('muted')
    expect(why.textContent).toContain('Why it stopped')
    expect(why.textContent).toContain('The run stopped: it reached its cap of $0.05, with $0.032 spent.')
    expect(why.textContent).not.toContain('did not pass')
    expect(within(card).getByTestId('next').textContent).toBe('raise the cap and run it again')
    expect(within(card).getByTestId('card-tasks').textContent).toContain('2 stopped')

    // The task the cap stopped says why in its inspector.
    fireEvent.click(within(why).getByRole('button', { name: 'Inspect T2' }))
    expect((await within(card).findByTestId('task-stopped')).textContent).toBe(
      "Stopped at the run's cap: its next model call would cost about $0.021, and only $0.018 of the $0.05 cap was left"
    )

    // On Runs too; a run that failed (an older card, no budget_stop) still says so.
    fireEvent.click(screen.getByTestId('crumb-runs'))

    const rows = await screen.findByRole('list', { name: 'roko runs' })
    const capRow = within(rows).getByText('Cap stop').closest('[role="listitem"]') as HTMLElement

    expect(capRow.textContent).toContain('stopped at cap')
    expect(capRow.textContent).not.toContain('failed')
    expect(rows.textContent).toContain('failed')
  })

  it('a stop its row does not say yet is still announced as a stop: the card is read first (dogfood R2-2)', async () => {
    const id = '4e5f6a7b-8c9d-4e0f-9a1b-2c3d4e5f6a7b'

    await new Promise(resolve => setTimeout(resolve, 1_100))
    await reloadPlugin()
    backend.pending = []
    // The first ended row has neither budget_stop nor a headline; only the run's card says it stopped at its cap.
    backend.rowsWithoutBudgetStop = true
    backend.runs = [{ ...capStopRow(), run_id: id, label: 'word-count-demo', headline: undefined, state: 'running', active: true }, ...backend.runs]
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })
    await waitFor(() => expect(queryClient.getQueryData(['roko', 'overview'])).toBeDefined())

    backend.setRunState(id, 'failed')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })

    await waitFor(() => expect(toastTitles()).toContain('roko: run stopped at its cap'))
    expect(toastTitles()).not.toContain('roko: run failed')
    expect($notifications.get().find(n => n.title === 'roko: run stopped at its cap')?.kind).toBe('success')
    expect(called('GET', `/runs/${id}`)).toBe(true)
  })

  it('“raise the cap and run it again” opens the composer at the higher cap the backend suggests, on a detent (dogfood R2-3)', async () => {
    backend.runs = [
      {
        ...capStopRow(),
        plan_id: 'add-tests',
        max_usd: 0.02,
        next: { action: 'rerun', label: 'raise the cap and run it again', why: 'it reached its cap of $0.02 ($0.0264 spent)', max_usd: 0.07 }
      },
      ...backend.runs
    ]
    await mountPage({ run: CAP_RUN })

    const card = await screen.findByTestId(`run-card-${CAP_RUN}`)

    fireEvent.click(within(card).getByTestId('next-key'))

    const dialog = await screen.findByRole('dialog')

    await waitFor(() => expect(within(dialog).getByTestId('composer-plan').querySelector('[data-pick="add-tests"]')?.getAttribute('aria-checked')).toBe('true'))
    // $0.07 snaps up to the knob's next detent; nothing starts until the person presses.
    expect(within(dialog).getByTestId('composer-submit').textContent).toContain('Run plan · cap $0.25')
    expect((within(dialog).getByTestId('composer-resume') as HTMLInputElement).checked).toBe(true)
    expect(called('POST', '/plans/add-tests/run')).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('a stop at roko’s daily limit says so: STOPPED · DAY LIMIT, today’s limit, nothing to press', async () => {
    const day = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d'
    const row = {
      ...capStopRow(),
      run_id: day,
      label: 'Day stop',
      max_usd: 1,
      headline: "stopped: today's limit was reached · tasks 0/2 · $0.40 of $1.00 · 9s",
      budget_stop: { ...capStopRow().budget_stop, limit: 'day', cap_usd: 20, spent_usd: 20.04 },
      next: { action: null, label: 'raise the daily limit or run it tomorrow', why: "it reached roko's daily limit of $20.00 ($20.04 spent)" }
    }

    backend.runs = [row, ...backend.runs]
    await mountPage({ run: day })

    const card = await screen.findByTestId(`run-card-${day}`)
    const pill = within(card).getByTestId('card-pill')

    expect(pill.textContent).toBe('■stopped at limit')
    expect(pill.getAttribute('data-state')).toBe('stop')
    expect(within(card).getByTestId('card-status').textContent).toBe('roko stopped the run at today’s limit of $20.00 ($20.04 spent).')
    expect(within(card).getByTestId('why').textContent).toContain('Why it stopped')
    // Nothing to press: a run started now would stop at once.
    expect(within(card).getByTestId('next').getAttribute('data-action')).toBe('none')
    expect(within(card).getByTestId('next').textContent).toBe('raise the daily limit or run it tomorrow')

    fireEvent.click(screen.getByTestId('crumb-runs'))

    const rows = await screen.findByRole('list', { name: 'roko runs' })

    expect((within(rows).getByText('Day stop').closest('[role="listitem"]') as HTMLElement).textContent).toContain('stopped at limit')

    // The toast when such a run ends.
    const ending = '3d4e5f6a-7b8c-4d9e-8f0a-1b2c3d4e5f6a'

    cleanup()
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await reloadPlugin()
    backend.pending = []
    backend.runs = [{ ...row, run_id: ending, state: 'running', active: true }, ...backend.runs.filter(r => r.run_id !== day)]
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })
    await waitFor(() => expect(queryClient.getQueryData(['roko', 'overview'])).toBeDefined())
    backend.setRunState(ending, 'failed')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })
    await waitFor(() => expect(toastTitles()).toContain('roko: run stopped at today’s limit'))
  })

  it('its end is news, not an error: “roko: run stopped at its cap”', async () => {
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await reloadPlugin()
    backend.pending = []
    backend.runs = [{ ...capStopRow(), state: 'running', active: true }, ...backend.runs]
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })
    await waitFor(() => expect(queryClient.getQueryData(['roko', 'overview'])).toBeDefined())

    backend.setRunState(CAP_RUN, 'failed')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })

    await waitFor(() => expect(toastTitles()).toContain('roko: run stopped at its cap'))

    const toast = $notifications.get().find(n => n.title === 'roko: run stopped at its cap')

    expect(toast?.kind).toBe('success')
    expect(toast?.message).toBe('Cap stop')
    expect(toastTitles()).not.toContain('roko: run failed')
  })
})

describe('roko’s other task outcomes', () => {
  it('passed with failures that were there before reads as passed, with a note; condition-skipped reads as skipped', async () => {
    const id = '6f7a8b9c-0d1e-4f2a-8b3c-4d5e6f7a8b9c'

    backend.runs = [
      {
        run_id: id,
        kind: 'plan',
        label: 'Two outcomes',
        plan_id: 'two-outcomes',
        state: 'succeeded',
        active: false,
        cost_usd: 0.02,
        max_usd: 0.5,
        started_at: new Date(Date.now() - 300_000).toISOString(),
        tasks: [
          { task_id: 'T1', title: 'Fix the parser', outcome: 'passed_with_preexisting_failures', attempts: 1, model: 'glm-5.1', gates: [{ gate: 'verify[0:test]', passed: false }], depends_on: [] },
          { task_id: 'T2', title: 'Docs only when asked', outcome: 'condition-skipped', attempts: 0, gates: [], depends_on: [] },
          { task_id: 'T3', title: 'The other branch', outcome: 'condition-skipped', reason: 'the route chose T2’s branch', attempts: 0, gates: [], depends_on: [] }
        ],
        gates: { passed: 0, failed: 1, total: 1 }
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const t1 = card.querySelector('.roko-node[data-node="T1"]') as HTMLElement
    const t2 = card.querySelector('.roko-node[data-node="T2"]') as HTMLElement

    expect(t1.getAttribute('data-state')).toBe('passed')
    expect(t1.getAttribute('aria-label')).toBe('T1 Fix the parser, passed, failures were there before')
    expect(t2.getAttribute('data-state')).toBe('stopped')
    expect(t2.getAttribute('aria-label')).toBe('T2 Docs only when asked, skipped, the plan’s conditions did not call for it')

    fireEvent.click(t1)

    const first = await within(card).findByTestId('inspector-T1')

    expect((first.querySelector('.roko-inspector-head .roko-pill') as HTMLElement).textContent).toBe('✓ passed')
    expect(within(first).getByTestId('task-outcome-note').textContent).toBe(
      'Passed. The tests that failed also failed on the commit this run started from, so this task did not cause them.'
    )

    fireEvent.click(t2)

    const second = await within(card).findByTestId('inspector-T2')

    expect((second.querySelector('.roko-inspector-head .roko-pill') as HTMLElement).textContent).toBe('⊘ skipped')
    expect(within(second).getByTestId('task-outcome-note').textContent).toBe('Skipped: the plan’s conditions did not call for this task.')

    // roko's own reason for a skip wins when it gives one.
    fireEvent.click(card.querySelector('.roko-node[data-node="T3"]') as HTMLElement)
    expect(within(await within(card).findByTestId('inspector-T3')).getByTestId('task-outcome-note').textContent).toBe('The route chose T2’s branch')
  })
})

describe('roko’s other task outcomes, as the backend now gives them', () => {
  it('a task’s reason shows in its inspector whatever its outcome', async () => {
    const id = '1b2c3d4e-5f6a-4b7c-8d8e-9f0a1b2c3d4e'

    backend.runs = [
      {
        run_id: id,
        kind: 'plan',
        label: 'Reasons',
        plan_id: 'reasons',
        state: 'succeeded',
        active: false,
        cost_usd: 0.02,
        max_usd: 0.5,
        started_at: new Date(Date.now() - 300_000).toISOString(),
        tasks: [
          { task_id: 'T1', title: 'Fix the parser', outcome: 'passed', reason: 'passed: the failures its check found were already there before the task', attempts: 1, gates: [], depends_on: [] },
          { task_id: 'T2', title: 'Docs only when asked', outcome: 'skipped', reason: 'skipped: no route of the plan chose it, so it did not need to run', attempts: 0, gates: [], depends_on: [] }
        ]
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    fireEvent.click(card.querySelector('.roko-node[data-node="T1"]') as HTMLElement)
    expect(within(await within(card).findByTestId('inspector-T1')).getByTestId('task-outcome-note').textContent).toBe(
      'Passed: the failures its check found were already there before the task'
    )
    fireEvent.click(card.querySelector('.roko-node[data-node="T2"]') as HTMLElement)
    expect(within(await within(card).findByTestId('inspector-T2')).getByTestId('task-outcome-note').textContent).toBe(
      'Skipped: no route of the plan chose it, so it did not need to run'
    )
  })

  it('skipped tasks count as ended, in grey: the ring, the strip and TASKS (“1 skipped”)', async () => {
    const id = '2c3d4e5f-6a7b-4c8d-9e0f-1a2b3c4d5e6f'

    backend.runs = [
      {
        run_id: id,
        kind: 'plan',
        label: 'One skipped',
        plan_id: 'one-skipped',
        state: 'succeeded',
        active: false,
        cost_usd: 0.02,
        max_usd: 0.5,
        started_at: new Date(Date.now() - 300_000).toISOString(),
        progress: { total: 3, passed: 2, failed: 0, running: 0, pending: 0, blocked: 0, stopped: 0, unverified: 0, skipped: 1 },
        tasks: [
          { task_id: 'T1', title: 'One', outcome: 'passed', attempts: 1, gates: [], depends_on: [] },
          { task_id: 'T2', title: 'Two', outcome: 'passed', attempts: 1, gates: [], depends_on: [] },
          { task_id: 'T3', title: 'Three', outcome: 'skipped', reason: 'skipped: no route of the plan chose it, so it did not need to run', attempts: 0, gates: [], depends_on: [] }
        ]
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const tasks = within(card).getByTestId('card-tasks')

    expect(tasks.textContent).toContain('1 skipped')
    expect(tasks.querySelector('.rk-rc-strip i[data-state="skipped"]')).toBeTruthy()

    fireEvent.click(screen.getByTestId('crumb-runs'))

    const row = within(await screen.findByRole('list', { name: 'roko runs' })).getByText('One skipped').closest('[role="listitem"]') as HTMLElement

    expect(row.querySelectorAll('.rk-rc-strip i[data-state="skipped"]')).toHaveLength(1)
    expect(row.querySelectorAll('.rk-rc-strip i[data-state="pending"]')).toHaveLength(0)
  })
})

describe('a plan writing says where roko’s planner is (0.5.0 writing)', () => {
  it('shows the stage, the attempt, a ticking clock and the spend in place of a bare “running”', async () => {
    const id = '5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b'
    const writing = {
      stage: 'retrying',
      attempt: 2,
      attempts: 2,
      calls: 2,
      cost_usd: 0,
      model: 'glm-5.1',
      reason: "the planner call ran into roko's 300 s limit for one call and was stopped",
      elapsed_s: 312,
      text: "retrying: the planner call ran into roko's 300 s limit for one call and was stopped · attempt 2 of 2 · 5:12 · $0.00"
    }

    backend.runs = [
      {
        run_id: id,
        kind: 'plan_generate',
        label: 'Split the ledger',
        plan_id: 'split-the-ledger',
        state: 'running',
        active: true,
        cost_usd: null,
        max_usd: null,
        started_at: new Date(Date.now() - 312_000).toISOString(),
        writing,
        elapsed_ms: 312_000,
        headline: `running · ${writing.text}`
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const stage = await within(card).findByTestId('plangen-stage')

    expect(stage.textContent).toMatch(/^retrying: the planner call ran into roko's 300 s limit for one call and was stopped · attempt 2 of 2 · 5:1\d · \$0\.00 · glm-5\.1$/)
    expect(stage.getAttribute('data-stage')).toBe('retrying')
    // The stage line replaces the backend's headline, so its clock is said once, and ticks.
    expect(card.querySelector('.roko-headline')).toBeNull()

    // An older roko (no `writing`): as before, the headline and the planner's words.
    backend.runs = backend.runs.map(row => (row.run_id === id ? { ...row, writing: null, headline: 'running' } : row))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'run', id] })
    })
    await waitFor(() => expect(within(card).queryByTestId('plangen-stage')).toBeNull())
    expect((card.querySelector('.roko-headline') as HTMLElement).textContent).toBe('running')
    expect(card.textContent).toContain('roko’s planner is breaking the request into tasks')
  })

  it('a plan writing says how its plan kept the checks the spec states, at the top of the plan’s sheet, and its chat card says what is missing: open and orange when one is', async () => {
    const id = 'de4f5a6b-7c8d-4e9f-8a0b-3c4d5e6f7a8b'
    const sc = {
      total: 5,
      kept: 2,
      shallow: 1,
      dropped: 1,
      missing: 1,
      regenerated: true,
      checks: [
        { id: 'SC1', check: 'tally report --since 2026-10-01 counts only later expenses', status: 'kept', task: 'T1', criterion: 'AC1', reason: null },
        { id: 'SC2', check: 'the summary prints totals in cents', status: 'kept', task: 'T2', criterion: 'AC2', reason: null },
        { id: 'SC3', check: 'the CLI documents --since', status: 'shallow', task: 'T1', criterion: null, reason: 'grep -q since tally/cli.py' },
        { id: 'SC4', check: 'the report reads well', status: 'dropped', task: null, criterion: null, reason: 'needs a person to judge it' },
        { id: 'SC5', check: 'a bad date exits 2 <img src=x onerror="alert(1)"> **loudly**', status: 'missing', task: null, criterion: null, reason: null }
      ]
    }

    backend.runs = [
      { run_id: id, kind: 'plan_generate', label: 'Add --since', plan_id: 'add-tests', state: 'succeeded', active: false, cost_usd: 0.01, max_usd: null, started_at: new Date(Date.now() - 60_000).toISOString(), headline: 'succeeded · plan written', source_checks: sc },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const sheet = await within(card).findByTestId('plan-card-add-tests')
    const report = await within(sheet).findByTestId('source-checks')

    // At the top of the plan's sheet, right under its title row; open, since one check is missing.
    expect(report.previousElementSibling?.classList.contains('roko-run-head')).toBe(true)
    expect(report.hasAttribute('open')).toBe(true)
    expect(report.querySelector('summary .rk-mod-label')?.textContent).toBe('your spec’s checks')
    expect(within(report).getByTestId('source-checks-line').textContent).toBe('2 of 5 kept · 1 shallow · 1 dropped · 1 missing · asked again')
    expect(within(report).getByTestId('source-checks-line').getAttribute('data-missing')).toBe('true')

    // Each check in the spec's order: its status (a coloured chip), the check, what keeps it, and why.
    const rows = [...report.querySelectorAll('li')]

    expect(rows.map(r => r.getAttribute('data-status'))).toEqual(['kept', 'kept', 'shallow', 'dropped', 'missing'])
    expect(rows[0].textContent).toBe('SC1kepttally report --since 2026-10-01 counts only later expensesT1 AC1')
    expect(rows[2].textContent).toBe('SC3shallowthe CLI documents --sinceT1only: grep -q since tally/cli.py')
    expect(rows[3].textContent).toBe('SC4droppedthe report reads wellwhy: needs a person to judge it')
    expect(rows[4].querySelector('.rk-sc-chip')?.getAttribute('data-status')).toBe('missing')
    // The spec's words are text: never markup, never markdown.
    expect(report.querySelector('img, b, strong')).toBeNull()
    expect(rows[4].textContent).toContain('<img src=x onerror="alert(1)"> **loudly**')

    // The plan writing's chat card: one sentence on what is missing (the plan's own card carries the report).
    cleanup()
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${id}"}`} />)

    expect((await screen.findByTestId('source-checks-missing')).textContent).toBe('1 of 5 checks your spec states is not in this plan')
    expect(screen.queryByTestId('source-checks')).toBeNull()
  })

  it('F11: a check that cannot run as written is counted, in orange, its chip says so and its reason shows; the chat card says it too; the counts in roko’s order', async () => {
    const id = 'd4bf2a3b-4c5d-4e6f-9a7b-0c1d2e3f4a5b'
    const sc = {
      total: 5,
      kept: 1,
      shallow: 1,
      dropped: 1,
      missing: 1,
      cannot_run: 1,
      regenerated: false,
      checks: [
        { id: 'SC1', check: 'the report counts later expenses', status: 'kept', task: 'T1', criterion: 'AC1', reason: null },
        { id: 'SC2', check: 'the suite passes under pytest', status: 'cannot_run', task: 'T2', criterion: null, reason: '`pytest` is not installed' },
        { id: 'SC3', check: 'a bad date exits 2', status: 'missing', task: null, criterion: null, reason: null },
        { id: 'SC4', check: 'the CLI documents --since', status: 'shallow', task: 'T1', criterion: null, reason: 'grep -q since tally/cli.py' },
        { id: 'SC5', check: 'the report reads well', status: 'dropped', task: null, criterion: null, reason: 'needs a person to judge it' }
      ]
    }

    backend.runs = [
      { run_id: id, kind: 'plan_generate', label: 'Add --since', plan_id: 'add-tests', state: 'succeeded', active: false, cost_usd: 0.01, max_usd: null, started_at: new Date(Date.now() - 60_000).toISOString(), headline: 'succeeded · plan written', source_checks: sc },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const report = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('source-checks')

    // roko's order, as its contract and the dashboard give it: cannot run, shallow, dropped, missing.
    expect(within(report).getByTestId('source-checks-line').textContent).toBe('1 of 5 kept · 1 cannot run · 1 shallow · 1 dropped · 1 missing')
    expect(within(report).getByTestId('source-checks-line').getAttribute('data-missing')).toBe('true')

    const row = report.querySelector('li[data-status="cannot_run"]') as HTMLElement

    expect(row.querySelector('.rk-sc-chip')?.textContent).toBe('cannot run')
    expect(row.textContent).toContain('why: `pytest` is not installed')

    cleanup()
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${id}"}`} />)
    expect((await screen.findByTestId('source-checks-missing')).textContent).toBe('1 of 5 checks your spec states is not in this plan; 1 of 5 checks your spec states cannot run as written')
  })

  it('every check kept reads “Your spec states N checks · N kept”, folded; a plan’s sheet finds its plan writing in the run log; an older roko shows nothing', async () => {
    const kept = 'ef5a6b7c-8d9e-4f0a-9b1c-4d5e6f7a8b9c'
    const older = 'fa6b7c8d-9e0f-4a1b-8c2d-5e6f7a8b9c0d'
    const all = {
      total: 8,
      kept: 8,
      shallow: 0,
      dropped: 0,
      missing: 0,
      regenerated: false,
      checks: Array.from({ length: 8 }, (_, i) => ({ id: `SC${i + 1}`, check: `check ${i + 1}`, status: 'kept', task: 'T1', criterion: `AC${i + 1}`, reason: null }))
    }
    const row = (runId: string, extra: Record<string, unknown>) => ({ run_id: runId, kind: 'plan_generate', label: 'Add tests', plan_id: 'add-tests', state: 'succeeded', active: false, cost_usd: 0.01, max_usd: null, started_at: new Date(Date.now() - 30_000).toISOString(), headline: 'succeeded · plan written', ...extra })

    backend.runs = [row(kept, { source_checks: all }), ...backend.runs]
    await refreshOverview()
    // Opened from Plans: the sheet finds the newest plan writing of its plan in the run log and says what it kept.
    await mountPage()

    const card = await openPlan('add-tests')
    const report = await within(card).findByTestId('source-checks')

    expect(within(report).getByTestId('source-checks-line').textContent).toBe('Your spec states 8 checks · 8 kept')
    expect(within(report).getByTestId('source-checks-line').getAttribute('data-missing')).toBeNull()
    expect(report.hasAttribute('open')).toBe(false)
    expect(report.querySelectorAll('li[data-status="kept"]')).toHaveLength(8)

    // An older roko (no `source_checks`): nothing at all.
    cleanup()
    backend.runs = [row(older, { source_checks: null }), ...backend.runs.filter(r => r.run_id !== kept)]
    await refreshOverview()
    await mountPage({ run: older })
    await within(await screen.findByTestId(`run-card-${older}`)).findByTestId('plan-card-add-tests')
    expect(screen.queryByTestId('source-checks')).toBeNull()
  })

  it('an absurd elapsed time from roko shows no clock, and the page stands', async () => {
    const check = '8b9c0d1e-2f3a-4b4c-9d5e-6f7a8b9c0d1e'

    // Huge (a Date out of range would throw in toISOString and blank the page), far too huge, and negative.
    for (const [i, elapsed] of [1e13, 1e300, -5].entries()) {
      const id = `7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0${i}`

      cleanup()
      backend.runs = [
        {
          run_id: id,
          kind: 'plan_generate',
          label: 'Huge clock',
          plan_id: 'huge-clock',
          state: 'running',
          active: true,
          cost_usd: null,
          max_usd: null,
          started_at: new Date(Date.now() - 10_000).toISOString(),
          writing: { stage: 'planning', attempt: 1, attempts: 1, calls: 1, cost_usd: 0, model: null, reason: null, elapsed_s: elapsed, text: 'writing the plan: planning' },
          headline: 'running · writing the plan: planning'
        },
        ...backend.runs
      ]
      await mountPage({ run: id })

      const stage = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('plangen-stage')

      expect(stage.textContent).toBe('writing the plan: planning · attempt 1 of 1 · $0.00')
    }

    // A check's elapsed time goes through the same guard.
    cleanup()
    backend.runs = [
      {
        run_id: check,
        kind: 'plan',
        label: 'Huge check clock',
        plan_id: 'speed-test',
        state: 'running',
        active: true,
        cost_usd: 0.01,
        max_usd: 0.5,
        started_at: new Date(Date.now() - 60_000).toISOString(),
        checking: { what: 'cargo test', label: 'cargo test', scope: 'workspace', task_id: null, since: null, elapsed_s: 1e300, source: 'roko' }
      },
      ...backend.runs
    ]
    await mountPage({ run: check })

    const card = await screen.findByTestId(`run-card-${check}`)

    expect(card.textContent).toContain('checking the workspace: cargo test')
    expect(within(card).getByTestId('ticker-checking').textContent).toBe('checking the workspace: cargo test')
  })
})

describe('before roko starts a run', () => {
  it('says starting… with no clock until roko’s own start arrives, then counts from it (no clock that jumps back)', async () => {
    const id = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b'

    backend.runs = [
      { run_id: id, kind: 'plan', label: 'fresh-serve', plan_id: 'add-tests', state: 'running', active: true, cost_usd: 0, max_usd: 0.25, started_at: null, hermes_started_at: new Date(Date.now() - 16_000).toISOString() },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    expect((await within(card).findByTestId('card-starting')).textContent).toBe('starting…')
    expect(card.textContent).not.toMatch(/started \d+s ago/)

    // roko's start arrives: the clock counts from it, not from the click.
    backend.runs = backend.runs.map(row => (row.run_id === id ? { ...row, started_at: new Date(Date.now() - 2_000).toISOString() } : row))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'run', id] })
    })
    await waitFor(() => expect(within(card).queryByTestId('card-starting')).toBeNull())
    expect(card.textContent).toMatch(/started (just now|\ds ago)/)
  })
})

describe('long checks', () => {
  it('a check of the workspace after the tasks: the ticker and the now strip say what runs and for how long', async () => {
    const id = '6c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5'

    backend.runs = [
      {
        run_id: id,
        kind: 'plan',
        label: 'speed-test',
        plan_id: 'speed-test',
        state: 'running',
        active: true,
        cost_usd: 0.02,
        max_usd: 0.5,
        started_at: new Date(Date.now() - 400_000).toISOString(),
        // plugin-runs' card field, from roko-gates' plan_check_* events.
        checking: {
          what: 'cargo clippy --workspace -- -D warnings',
          label: 'cargo clippy',
          scope: 'workspace',
          task_id: null,
          step: 2,
          steps: 3,
          since: new Date(Date.now() - 185_000).toISOString(),
          elapsed_s: 185,
          source: 'roko'
        }
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    // The horizon (spec v3 §4.8) says what roko checks, and for how long.
    expect((await within(card).findByTestId('ticker-checking')).textContent).toMatch(/^checking the workspace: cargo clippy \(2 of 3\) · 3:0\d$/)
    expect(within(card).getByTestId('horizon').textContent).toMatch(/checking the workspace: cargo clippy \(2 of 3\) · 3:0\d$/)
  })

  it('on an older roko the plugin guesses the plan\'s checks: "finishing: …"', async () => {
    const id = '6c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d7'

    backend.runs = [
      {
        run_id: id,
        kind: 'plan',
        label: 'speed-test',
        plan_id: 'speed-test',
        state: 'running',
        active: true,
        cost_usd: 0.02,
        max_usd: 0.5,
        started_at: new Date(Date.now() - 400_000).toISOString(),
        checking: { what: 'the plan\'s checks before delivery', label: 'the plan\'s checks before delivery', scope: 'plan', task_id: null, since: new Date(Date.now() - 20_000).toISOString(), elapsed_s: 20, source: 'plugin' }
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    expect((await within(card).findByTestId('ticker-checking')).textContent).toMatch(/^finishing: the plan's checks before delivery · 0:2\d$/)
  })

  it('an older card without `checking` keeps the plain idle words', async () => {
    const id = '6c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d6'

    backend.runs = [{ run_id: id, kind: 'plan', label: 'speed-test', plan_id: 'speed-test', state: 'running', active: true, cost_usd: 0, max_usd: 0.5, started_at: new Date().toISOString() }, ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(within(card).getByTestId('horizon').textContent).toContain('between tasks…'))
    expect(within(card).queryByTestId('ticker-checking')).toBeNull()
  })
})

describe('unverified and partial work, and the merge states', () => {
  const withWork = (extra: Record<string, unknown> = {}) => {
    backend.runs = backend.runs.map(row =>
      row.run_id === RUN_DONE
        ? {
            ...row,
            work: {
              kind: 'partial',
              source: 'roko',
              parts: [
                { trust: 'verified', delivered: true, plan_id: null, branch: `roko/batch/${RUN_DONE}`, commit: DONE_COMMIT, diffstat: '1 file changed, 30 insertions(+)', tasks: [{ task_id: 'T1', verdict: 'passed' }] },
                { trust: 'unverified', delivered: false, plan_id: 'add-tests', branch: 'roko/plan/add-tests', commit: 'f00dfeed', diffstat: '2 files changed, 12 insertions(+)', tasks: [{ task_id: 'T2', verdict: 'unverified' }] }
              ]
            },
            ...extra
          }
        : row
    )
  }

  it('a run with verified and unverified work: one key per part, the unverified diff under its banner', async () => {
    await reloadPlugin()
    withWork()
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')

    const parts = await within(card).findByTestId('work-parts')

    expect(within(parts).getByTestId('work-part-verified').getAttribute('aria-pressed')).toBe('true')
    expect(within(card).queryByTestId('unverified-banner')).toBeNull()
    fireEvent.click(within(parts).getByTestId('work-part-unverified'))
    await waitFor(() => expect(called('GET', `/runs/${RUN_DONE}/diff?max_files=150&work=unverified&plan_id=add-tests`)).toBe(true))

    const banner = await within(card).findByTestId('unverified-banner')

    expect(banner.textContent).toContain('Unverified: no check ran on this work')
    expect(banner.textContent).toContain('(T2)')
    await waitFor(() => expect(called('GET', `/runs/${RUN_DONE}/merge?work=unverified&plan_id=add-tests`)).toBe(true))
  })

  it('unverified work merges only after a second yes, and the POST says so', async () => {
    await reloadPlugin()
    backend.mergeCheck = { ...backend.mergeCheck, available: true, confirm: 'No check ran on this work, so roko cannot say it is right. Merge it anyway?' }
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')

    const key = await within(card).findByTestId('merge-button')

    expect(key.textContent).toContain('unverified')
    fireEvent.click(key)

    const dialog = await screen.findByRole('dialog', { name: 'Merge this unverified work into main?' })

    expect(within(dialog).getByTestId('merge-confirm-why').textContent).toContain('Merge it anyway?')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge unverified work' }))
    await waitFor(() => expect(backend.mergePosts).toEqual([{ commit: DONE_COMMIT, confirm: true }]))
  })

  it('an uncommitted roko.toml stops Merge; its fix commits it, and Merge comes back', async () => {
    await reloadPlugin()
    backend.mergeCheck = {
      ...backend.mergeCheck,
      can_merge: false,
      available: false,
      reason: 'the checkout has uncommitted changes to 1 tracked file: roko.toml',
      dirty: ['roko.toml'],
      fix: { kind: 'action', label: 'commit roko.toml', action: 'commit-roko-toml', command: 'git -C /work/ws commit -m "roko: accept runs started from Hermes" -- roko.toml', docs: null }
    }
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')

    const blocked = await within(card).findByTestId('merge-blocked')

    expect(blocked.textContent).toContain('Commit your changes first')
    expect(blocked.textContent).toContain('uncommitted: roko.toml')
    fireEvent.click(within(blocked).getByTestId('fix-merge-dirty'))

    const panel = await within(blocked).findByTestId('fix-panel-merge-dirty')

    expect(within(panel).getByTestId('fix-preview').textContent).toContain('commit -m')
    fireEvent.click(within(panel).getByTestId('fix-apply-merge-dirty'))
    await waitFor(() => expect(backend.applied).toEqual([{ action: 'commit-roko-toml', digest: 'digest-commit' }]))
    expect(await within(card).findByTestId('merge-button')).toBeTruthy()
    // The outcome note of a fix applied here is not a setup problem's: dismiss it for the next tests.
    const note = screen.queryByTestId('fix-done-note')

    if (note) fireEvent.click(within(note).getByTestId('fix-done-note-close'))
  })

  it('merging a part the run kept on a plan branch names it in the POST, after the second yes', async () => {
    await reloadPlugin()
    withWork()
    backend.mergeCheck = { ...backend.mergeCheck, available: true, confirm: 'No check ran on this work. Merge it anyway?' }
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')
    fireEvent.click(within(await within(card).findByTestId('work-parts')).getByTestId('work-part-unverified'))
    await within(card).findByTestId('unverified-banner')
    fireEvent.click(await within(card).findByTestId('merge-button'))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Merge this unverified work into main?' })).getByRole('button', { name: 'Merge unverified work' }))
    await waitFor(() => expect(backend.mergePosts).toEqual([{ commit: DONE_COMMIT, confirm: true, plan_id: 'add-tests', work: 'unverified' }]))
  })

  it('a next step with nothing to press is said, not offered as a key', async () => {
    await reloadPlugin()
    withWork({ next: { action: null, label: 'nothing to merge: no task passed', why: 'every task failed its checks' } })
    await mountPage({ run: RUN_DONE })

    const next = await within(await screen.findByTestId(`run-card-${RUN_DONE}`)).findByTestId('next')

    expect(next.textContent).toBe('nothing to merge: no task passed')
    expect(within(next).queryByRole('button')).toBeNull()
  })

  it('the one next action: review & merge opens Changes; run it again offers Run plan… for the plan', async () => {
    await reloadPlugin()
    withWork({ next: { action: 'merge', label: 'review & merge', why: 'the verified work is ready; T2 is unverified' } })
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)
    const next = await within(card).findByTestId('next')

    expect(next.getAttribute('data-action')).toBe('merge')
    fireEvent.click(within(next).getByTestId('next-key'))
    expect(await within(card).findByTestId('work-parts')).toBeTruthy()
    cleanup()

    const id = '7d2e3f4a-5b6c-4d7e-8f90-a1b2c3d4e5f6'

    backend.runs = [
      { run_id: id, kind: 'plan', label: 'Add tests', plan_id: 'add-tests', state: 'interrupted', active: false, cost_usd: 0.1, max_usd: 0.5, started_at: new Date(Date.now() - 900_000).toISOString(), interrupted: { reason: 'roko stopped while this run was going (machine restart or crash)' }, next: { action: 'rerun', label: 'run it again', why: 'roko stopped mid-run; its work so far is kept' } },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const again = await screen.findByTestId(`run-card-${id}`)
    const rerun = await within(again).findByTestId('next-key')

    // Run it again: the composer on its plan, with the tasks that passed skipped and its own cap.
    expect(rerun.textContent).toContain('run it again')
    fireEvent.click(rerun)

    const dialog = await screen.findByRole('dialog')

    await waitFor(() => expect(within(dialog).getByTestId('composer-plan').querySelector('[data-pick="add-tests"]')?.getAttribute('aria-checked')).toBe('true'))
    expect((within(dialog).getByTestId('composer-resume') as HTMLInputElement).checked).toBe(true)
    expect(within(dialog).getByTestId('composer-submit').textContent).toContain('Run plan · cap $0.50')
    fireEvent.keyDown(dialog, { key: 'Escape' })
  })
})

// The new fields as plugin-runs' backend wrote them for real runs (2026-10-15 20:48-20:55,
// $V/plugin-runs/out/*-card.json; the project path shortened to /work/proj). Its slow-checking card's `checking`
// is the one the long-checks test uses.
const REAL_UNVERIFIED = {
  state: 'unverified',
  active: false,
  demo: false,
  work: {
    kind: 'unverified',
    parts: [
      {
        trust: 'unverified',
        delivered: false,
        plan_id: '490831bd-68cd-4830-9574-57157be01f67',
        branch: 'roko/plan/490831bd-68cd-4830-9574-57157be01f67',
        commit: '93cec8fe37fc',
        base: '26c9cd988814',
        files_changed: ['README.md'],
        diffstat: '1 file changed, 1 insertion(+)',
        tasks: [{ task_id: 'T1', verdict: 'unverified' }],
        merged: false,
        review_command: 'git -C /work/proj diff 26c9cd988814..roko/plan/490831bd-68cd-4830-9574-57157be01f67'
      }
    ],
    source: 'git'
  },
  merge: {
    available: true,
    merged: false,
    reason: null,
    demo: false,
    work: 'unverified',
    confirm: 'No check ran on this work (T1), so roko could not verify it. Read the changes first. Merge it anyway?',
    dirty: [],
    fix: null,
    mode: 'fast-forward',
    into: 'main',
    branch: 'roko/plan/490831bd-68cd-4830-9574-57157be01f67',
    commit: '93cec8fe37fc',
    plan_id: '490831bd-68cd-4830-9574-57157be01f67',
    command: 'git -C /work/proj merge --ff-only roko/plan/490831bd-68cd-4830-9574-57157be01f67'
  },
  next: { action: 'review', label: 'review the unverified changes', why: 'no check ran on them' },
  why: {
    summary: 'No gate checked T1, so the result is unverified: its changes are kept on roko/plan/490831bd-68cd-4830-9574-57157be01f67, not merged; read them in Changes.',
    gates_not_passed: [],
    blocked: [],
    unverified_tasks: ['T1'],
    errors: ['Graph Engine: 1 plan(s), 0 succeeded, 1 failed'],
    refusals: [],
    start_error: null
  },
  interrupted: null,
  checking: null
}

const REAL_INTERRUPTED = {
  state: 'interrupted',
  active: false,
  kind: 'plan',
  plan_id: 'slow-check',
  max_usd: 0.1,
  demo: false,
  work: {
    kind: 'partial',
    parts: [
      {
        trust: 'verified',
        delivered: true,
        plan_id: null,
        branch: 'roko/batch/6043fc25-01f9-46fc-ac1d-a390af41400b',
        commit: 'ef085652eea1',
        base: null,
        files_changed: ['notes/hello.txt'],
        diffstat: '1 file changed, 1 insertion(+)',
        tasks: [],
        merged: false,
        review_command: 'git -C /work/proj diff HEAD...roko/batch/6043fc25-01f9-46fc-ac1d-a390af41400b',
        checks_finished: false
      }
    ],
    source: 'git'
  },
  merge: {
    available: true,
    merged: false,
    reason: null,
    demo: false,
    work: 'partial',
    confirm: "roko stopped before it finished checking this run: each task's own check passed, but the checks roko runs on the delivered work may not have finished. Merge it anyway?",
    dirty: [],
    fix: null,
    mode: 'fast-forward',
    into: 'main',
    branch: 'roko/batch/6043fc25-01f9-46fc-ac1d-a390af41400b',
    commit: 'ef085652eea1',
    plan_id: null,
    command: 'git -C /work/proj merge --ff-only roko/batch/6043fc25-01f9-46fc-ac1d-a390af41400b'
  },
  next: { action: 'rerun', label: 'run the plan again', why: 'roko serve stopped while this run was going (a restart or a crash), so nothing runs it any more; what it finished is kept on its branch' },
  why: {
    summary: 'The run was interrupted: roko serve stopped while this run was going (a restart or a crash), so nothing runs it any more. NOTE-1 had passed before that; what passed is kept on its branch.',
    gates_not_passed: [],
    blocked: [],
    unverified_tasks: [],
    errors: [],
    refusals: [],
    start_error: null
  },
  interrupted: { reason: 'roko serve stopped while this run was going (a restart or a crash), so nothing runs it any more', at: null, source: 'plugin' },
  checking: null
}

const REAL_REFUSED_START = {
  state: 'failed',
  active: false,
  kind: 'plan',
  plan_id: 'demo-hello-world',
  demo: true,
  work: { kind: 'none', parts: [], source: 'git' },
  merge: { available: false, merged: false, reason: 'demo output: it stays on its run branch', demo: true, work: null, confirm: null, dirty: [], fix: null, mode: null, into: null, branch: null, commit: null, plan_id: null, command: null },
  next: { action: null, label: 'nothing to merge', why: 'demo output stays on its run branch' },
  why: {
    summary: 'roko did not start the run: A roko plan runner is already active in this workspace (PID 4066). hint: wait for it to finish, or kill it with `kill 4066`.',
    gates_not_passed: [],
    blocked: [],
    unverified_tasks: [],
    errors: [],
    refusals: [],
    start_error: 'A roko plan runner is already active in this workspace (PID 4066). hint: wait for it to finish, or kill it with `kill 4066`'
  },
  interrupted: null,
  checking: null
}

describe("real cards (plugin-runs' runs)", () => {
  const asCard = (runId: string, fields: Record<string, unknown>) => {
    backend.runs = backend.runs.map(row => (row.run_id === runId ? { ...row, ...fields } : row))
  }

  it('an unverified run: its one next key opens the work under its banner, and Merge asks again', async () => {
    await reloadPlugin()
    asCard(RUN_DONE, REAL_UNVERIFIED)
    backend.mergeCheck = { ...backend.mergeCheck, ...REAL_UNVERIFIED.merge }
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    expect(card.querySelector('[data-testid="card-pill"]')?.textContent).toContain('not checked')
    expect(within(card).getByTestId('why').textContent).toContain('No gate checked T1')

    const key = await within(card).findByTestId('next-key')

    expect(key.textContent).toContain('review the unverified changes')
    fireEvent.click(key)

    const banner = await within(card).findByTestId('unverified-banner')

    expect(banner.textContent).toBe('Unverified: no check ran on this work. roko did not deliver it: it stays on its plan branch. Read it before you take it (T1).')
    await waitFor(() => expect(called('GET', `/runs/${RUN_DONE}/merge?work=unverified&plan_id=490831bd-68cd-4830-9574-57157be01f67`)).toBe(true))

    const merge = await within(card).findByTestId('merge-button')

    expect(merge.textContent).toContain('Merge anyway…')
    expect(merge.textContent).toContain('unverified')
  })

  it('an interrupted run whose checks did not finish: run the plan again, or merge it as not fully checked', async () => {
    await reloadPlugin()
    asCard(RUN_DONE, REAL_INTERRUPTED)
    backend.mergeCheck = { ...backend.mergeCheck, ...REAL_INTERRUPTED.merge }
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    expect(card.querySelector('[data-testid="card-pill"]')?.textContent).toContain('interrupted')
    expect(within(card).getByTestId('why').textContent).toContain('nothing runs it any more')
    expect((await within(card).findByTestId('next-key')).textContent).toContain('run the plan again')

    openRunFold(card, 'changes')

    const merge = await within(card).findByTestId('merge-button')

    expect(merge.textContent).toContain('Merge anyway…')
    expect(merge.textContent).toContain('not fully checked')
    expect(within(card).queryByTestId('unverified-banner')).toBeNull()
    fireEvent.click(merge)

    const dialog = await screen.findByRole('dialog', { name: 'Merge work roko did not fully check into main?' })

    expect(within(dialog).getByTestId('merge-confirm-why').textContent).toContain('roko stopped before it finished checking this run')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge anyway' }))
    await waitFor(() => expect(backend.mergePosts).toEqual([{ commit: DONE_COMMIT, confirm: true }]))
  })

  it('a start roko refused: the reason, and the next step said, not offered', async () => {
    await reloadPlugin()
    asCard(RUN_DONE, REAL_REFUSED_START)
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    expect(card.querySelector('[data-testid="card-pill"]')?.textContent).toContain('failed')
    expect(within(card).getByTestId('why').textContent).toContain('A roko plan runner is already active in this workspace (PID 4066)')

    const next = await within(card).findByTestId('next')

    expect(next.textContent).toBe('nothing to merge')
    expect(within(next).queryByRole('button')).toBeNull()
    expect(within(card).queryByTestId('merge-button')).toBeNull()
  })
})

describe('what roko learned, in words', () => {
  it('no new lesson reads "nothing new to learn", with what it confirmed and moved up; "Lesson: none" is not shown', async () => {
    backend.doneNote = 'The file now prints exactly hello world.\n\nLesson: none'
    backend.doneLessons = [{ admission: 'no_candidate', entry_id: null, lesson: null, reinforced: 3, promoted: 3 }]
    await mountPage({ run: RUN_DONE })

    // A one-task run shows its task's inspector in place.
    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)
    const lesson = await within(card).findByTestId('lesson')

    expect(lesson.textContent).toBe('nothing new to learn from this task · confirmed 3 lessons it had · 3 moved up a tier')
    expect(lesson.textContent).not.toMatch(/no candidate|an entry|promoted/i)
    expect(card.textContent).toContain('The file now prints exactly hello world.')
    expect(card.textContent).not.toContain('Lesson: none')
  })
})

describe('smaller things (phase 2)', () => {
  it('a one-task run has one pad in the sequencer, its task open below it', async () => {
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)
    const graph = await within(card).findByTestId('run-graph')

    expect(graph.querySelectorAll('.roko-node')).toHaveLength(1)
    expect(graph.querySelector('.roko-node[data-node="T1"]')).toBeTruthy()
    expect(card.textContent).toContain('one task')
    expect(card.textContent).toContain('Added clamp() and a test for the edges.')
  })

  it('the composer runs a plan the workspace already has: which plan, its facts, skip what passed, the cap', async () => {
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const dialog = await screen.findByRole('dialog')

    fireEvent.click(await within(dialog).findByTestId('composer-plan-key'))

    const plans = await within(dialog).findByTestId('composer-plan')

    // Demos first, the one to start with picked.
    expect([...plans.querySelectorAll('.rk-planpick-head')].map(el => el.textContent)).toEqual(['Demos', 'Your plans', 'parser-programme'])
    expect(plans.querySelector('[data-pick="demo-hello-world"]')?.getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(within(dialog).getByTestId('composer-plan-facts').textContent).toBe('1 task · 1 wave · a demo: its output stays on its run branch'))

    // Another plan, its tasks that passed skipped.
    fireEvent.click(plans.querySelector('[data-pick="add-tests"]') as HTMLElement)
    await waitFor(() => expect(within(dialog).getByTestId('composer-plan-facts').textContent).toBe('3 tasks · 2 waves · roko estimates $0.03'))
    fireEvent.click(within(dialog).getByTestId('composer-resume'))

    const start = within(dialog).getByTestId('composer-submit') as HTMLButtonElement

    expect(start.textContent).toContain('Run plan · cap $0.50')
    fireEvent.click(start)
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({ body: { max_usd: 0.5, resume: true, title: 'Add tests' }, method: 'POST', path: '/api/plugins/roko/plans/add-tests/run' })
      )
    )
    expect(await screen.findByTestId(`run-card-${RUN_NEW}`)).toBeTruthy()
  })

  it('the composer offers the workspace\'s start-here demo first among its examples', async () => {
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const dialog = await screen.findByRole('dialog')
    const chip = await within(dialog).findByTestId('example-start-here')

    expect(chip.textContent).toBe('▶ hello world demo')
    fireEvent.click(chip)
    expect((await within(dialog).findByTestId('composer-plan')).textContent).toContain('Start here: hello world demo')
    fireEvent.click(within(dialog).getByTestId('composer-request'))
    expect(within(dialog).queryByTestId('composer-plan')).toBeNull()
    fireEvent.keyDown(dialog, { key: 'Escape' })
  })

  it('the roko theme is offered once, on the first open, and the answer is kept', async () => {
    await reloadPlugin()
    await mountPage()

    const offer = await screen.findByTestId('theme-offer')

    expect(offer.textContent).toContain('roko has its own theme')
    fireEvent.click(within(offer).getByTestId('theme-offer-no'))
    await waitFor(() => expect(screen.queryByTestId('theme-offer')).toBeNull())
    cleanup()
    await reloadPlugin()
    await mountPage()
    await screen.findByTestId('roko-connection')
    expect(screen.queryByTestId('theme-offer')).toBeNull()
  })
})

describe('the rest (phase 2)', () => {
  it('a plan says how many tasks run at once from its widest wave, not its setting', async () => {
    await mountPage()

    // demo-hello-world: one task. add-tests: T1 and T2 together, then T3 (and max_parallel 2).
    expect(within(await openPlan('demo-hello-world')).getByTestId('plan-parallel').textContent).toBe('one task at a time')
    expect(within(await openPlan('add-tests')).getByTestId('plan-parallel').textContent).toBe('2 at once')
  })

  it('a run that ends is news at the bottom right, gone by itself; a written plan says "plan written"', async () => {
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await reloadPlugin()
    backend.pending = []
    backend.runs = [
      { run_id: RUN_PLANGEN, kind: 'plan_generate', label: 'Split the ledger', plan_id: 'add-tests', state: 'running', cost_usd: null, max_usd: null, started_at: new Date().toISOString(), source: 'ui' },
      ...backend.runs
    ]
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })
    await waitFor(() => expect(queryClient.getQueryData(['roko', 'overview'])).toBeDefined())

    backend.setRunState(RUN_PLANGEN, 'succeeded')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })

    await waitFor(() => expect(toastTitles()).toContain('roko: plan written'))

    const toast = $notifications.get().find(n => n.title === 'roko: plan written')

    expect(toast?.placement).toBe('bottom-right')
    // The title says how it ended; the line names it (not "plan written: …" again).
    expect(toast?.message).toBe('Split the ledger')
    expect(toastTitles()).not.toContain('roko: run succeeded')

    // Its card says the same: "plan written", not "succeeded · plan writing".
    await mountPage({ run: RUN_PLANGEN })

    const card = await screen.findByTestId(`run-card-${RUN_PLANGEN}`)

    expect(card.querySelector('.roko-pill')?.textContent).toContain('plan written')
    expect(card.querySelector('.roko-hero-top')?.textContent).not.toMatch(/succeeded|plan writing/i)
    expect(card.querySelector('.roko-headline')?.textContent).toMatch(/^plan written · /)
  })
})

describe('Insights: whose numbers (R4)', () => {
  it('an older backend: the whole workspace, said so, checks from its gate rows, no switch', async () => {
    await mountPage()
    openTab(/^Insights/)

    const scope = await screen.findByTestId('insights-scope')

    expect(scope.textContent).toBe('the whole workspace')
    expect(within(scope).queryByTestId('scope-hermes')).toBeNull()
    expect(await screen.findByText('7 of 11 checks that ran')).toBeTruthy()
  })

  it('a 0.5.0 backend: the runs from Hermes by default, their period, checks apart from verdicts, and a switch', async () => {
    backend.insightsScoped = true
    await mountPage()
    openTab(/^Insights/)

    const scope = await screen.findByTestId('insights-scope')

    await waitFor(() => expect(scope.textContent).toContain('numbers for runs started from Hermes · '))
    expect(called('GET', '/insights?scope=hermes')).toBe(true)
    // 2 of 3 checks passed; the run that no check ran on is not a failed check.
    expect(await screen.findByText('2 of 3 checks that ran')).toBeTruthy()
    expect(document.querySelector('.roko-kpi-value')?.textContent).toBe('67%')
    expect(screen.getByText('1 passed · 1 unverified · 1 failed')).toBeTruthy()
    expect(screen.queryByText('task verdict')).toBeNull()

    fireEvent.click(within(scope).getByTestId('scope-workspace'))
    await waitFor(() => expect(called('GET', '/insights?scope=workspace')).toBe(true))
    await waitFor(() => expect(screen.getByTestId('insights-scope').textContent).toContain('this workspace'))
    fireEvent.click(within(screen.getByTestId('insights-scope')).getByTestId('scope-hermes'))
  })
})

describe('limits and permissions', () => {
  it('the cap cannot pass the per-run cap or what is left today', async () => {
    await mountPage()
    const card = await openPlan('add-tests')

    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))

    const form = await screen.findByRole('dialog')

    expect(within(form).getByTestId('run-limits').textContent).toBe('at most $5.00 per run · $8.58 left today')
    fireEvent.change(within(form).getByLabelText('Spend cap (max_usd)'), { target: { value: '6' } })
    expect(within(form).getByText('Enter a cap of at most $5.00.')).toBeTruthy()
    expect((within(form).getByRole('button', { name: 'Continue…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('with actions turned off, the app shows no Run, Approve, Reject or Cancel', async () => {
    backend.canWrite = false
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(within(card).getByText('lexer')).toBeTruthy())
    expect(within(card).queryByRole('button', { name: 'Stop run' })).toBeNull()
    expect(screen.queryByTestId('new-run')).toBeNull()
    openTab(/^Waiting/)

    const notes = await screen.findAllByTestId('actions-off')

    expect(notes[0].textContent).toContain('/roko approve a1b2c3')
    expect(screen.queryByRole('button', { name: 'approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'decline' })).toBeNull()
    await openPlan('add-tests')
    expect(screen.queryByRole('button', { name: 'Run plan…' })).toBeNull()
  })
})

describe('Knowledge and Health tabs', () => {
  it('searches /knowledge and shows content, kind and tier badges and the score', async () => {
    await mountPage()
    openTab(/^Knowledge/)

    fireEvent.change(screen.getByPlaceholderText('Search what roko learned in this workspace'), { target: { value: 'parser' } })

    expect(await screen.findByText('The parser rejects trailing commas; T3 needed a fix.')).toBeTruthy()
    expect(screen.getByText('insight')).toBeTruthy()
    expect(screen.getByText('working')).toBeTruthy()
    expect(screen.getByText('score 3.97')).toBeTruthy()
    expect(screen.getByText('70% confident')).toBeTruthy()
    expect(called('GET', '/knowledge?q=parser&limit=20')).toBe(true)
  })

  it('shows the checks with hints, gate pass rates, model rows and a cost sparkline', async () => {
    await mountPage()
    openTab(/^Insights/)

    expect(await screen.findByText('roko serve 0.1.0, status ok')).toBeTruthy()
    expect(screen.getByText('Mint a key with `hermes roko setup --mint`.')).toBeTruthy()
    expect(screen.getByText('Point workdir at a git checkout.')).toBeTruthy()
    expect(await screen.findByText('verify[0:test]')).toBeTruthy()
    expect(screen.getByText('83%')).toBeTruthy()
    expect(screen.getByText('40%')).toBeTruthy()
    expect(screen.getByText('glm-5.1')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Cumulative cost, $0.32 total' })).toBeTruthy()
  })
})

describe('transcript directives', () => {
  it('::roko-run renders the run card: the glass’s four readings, one sentence, the one key, and its details folded', async () => {
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${RUN_ACTIVE}"}`} />)

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    // The glass (design system §4.2): tasks with the plan's strip, time, spent of its cap, checks.
    await waitFor(() => expect(within(card).getByTestId('card-spent').textContent).toContain('of $0.50'))
    expect(card.getAttribute('data-compact')).toBe('true')
    expect([...card.querySelectorAll('.rk-rc-label')].map(l => l.textContent)).toEqual(['tasks', 'time', 'spent', 'checks'])
    // It waits on the person: the pill says so, the sentence asks, and the one orange key answers.
    expect(within(card).getByTestId('card-pill').textContent).toContain('needs you')
    expect(within(card).getByTestId('card-status').textContent).toMatch(/^roko asks: /)
    expect(within(card).getByTestId('card-answer').getAttribute('data-tone')).toBe('primary')
    // The details are folded: the plan in miniature shows once the fold opens.
    expect(within(card).queryByRole('img', { name: '3 tasks in 2 waves' })).toBeNull()
    openFold(card)
    expect(await within(card).findByRole('img', { name: '3 tasks in 2 waves' })).toBeTruthy()
  })

  it('phase 4 prep D: an ended run’s chat card shows what roko built, its first UI shot, and it opens large', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGMQQAIMODkALAcCQaqvfAkAAAAASUVORK5CYII='
    const shots = [
      { path: 'artifacts/ui/editor-big.png', name: 'editor-big.png', kind: 'image', bytes: 1_500_000, width: 2400, height: 1520 },
      { path: 'artifacts/ui/editor-idle.png', name: 'editor-idle.png', kind: 'image', bytes: 119_209, width: 1200, height: 760 }
    ]

    backend.artifacts[RUN_DONE] = { ok: true, commit: 'd66293e36e22', items: shots }
    backend.artifactFiles['artifacts/ui/editor-idle.png'] = { ok: true, path: 'artifacts/ui/editor-idle.png', mime: 'image/png', data: PNG }
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${RUN_DONE}"}`} />)

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)
    const shot = await within(card).findByTestId('cc-shot')

    // The first shot that fits a thumbnail (1 MB): the bigger one is left to the run's page.
    expect(shot.textContent).toBe('what roko built · editor-idle.png')
    expect(within(shot).getByRole('img', { name: 'editor-idle.png' }).getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    fireEvent.click(within(shot).getByRole('button', { name: 'Open editor-idle.png large' }))
    expect(within(await screen.findByRole('dialog')).getByText('editor-idle.png')).toBeTruthy()
  })

  it('renders a placeholder and fetches nothing while the message streams; bad ids stay code', async () => {
    mount(<TranscriptDirectiveLeaf streaming={true} text={`::roko-run{id="${RUN_DONE}"}`} />)

    expect(await screen.findByText('roko run · waiting for the message to finish')).toBeTruthy()
    expect(called('GET', `/runs/${RUN_DONE}`)).toBe(false)

    cleanup()
    mount(<TranscriptDirectiveLeaf streaming={false} text={'::roko-run{id="../../etc/passwd"}'} />)

    const code = await screen.findByText('::roko-run{id="../../etc/passwd"}')

    expect(code.tagName).toBe('CODE')
  })

  it('P-45: a plan card shown while roko still writes the plan follows the writing, then shows the plan once it is there', async () => {
    backend.plansMissing.add('add-tests')
    backend.runs = [
      { run_id: RUN_PLANGEN, kind: 'plan_generate', label: 'P4 · Undertow phosphor editor', plan_id: 'add-tests', state: 'running', cost_usd: null, max_usd: 0.5, started_at: new Date().toISOString(), source: 'chat' },
      ...backend.runs
    ]
    mount(<TranscriptDirectiveLeaf streaming={false} text={'::roko-plan{id="add-tests"}'} />)

    // Never "not found": roko is still writing it, and the card says so with the writing's own card.
    const still = await screen.findByTestId('plan-writing')

    expect(still.textContent).toContain('roko is still writing this plan')
    expect(await within(still).findByTestId(`run-card-${RUN_PLANGEN}`)).toBeTruthy()
    expect(screen.queryByText(/not found/i)).toBeNull()
    // The plan lands: the card shows it, without a reload.
    backend.plansMissing.delete('add-tests')
    backend.runs = backend.runs.map(row => (row.run_id === RUN_PLANGEN ? { ...row, state: 'succeeded' } : row))
    const card = await screen.findByTestId('plan-card-add-tests', {}, { timeout: 8_000 })

    expect(screen.queryByTestId('plan-writing')).toBeNull()
    openFold(card)
    expect(await within(card).findByText('lexer')).toBeTruthy()
  })

  it('P-63: a plan whose writing outlasts a dozen looks still shows once the writing ends', async () => {
    // Phase 5.4's card (R1t): roko wrote for over a minute, every look missed, and the card stopped looking just as
    // the writing ended, so it kept the writing's card for good. Only the timers are fake: a faked clock would leave
    // the page's notification times in the future for the tests after this one.
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })

    try {
      backend.plansMissing.add('add-tests')
      backend.runs = [
        { run_id: RUN_PLANGEN, kind: 'plan_generate', label: 'P5.4 · Kick Companion as named', plan_id: 'add-tests', state: 'running', cost_usd: null, max_usd: 0.5, started_at: new Date().toISOString(), source: 'chat' },
        ...backend.runs
      ]
      mount(<TranscriptDirectiveLeaf streaming={false} text={'::roko-plan{id="add-tests"}'} />)
      expect(await screen.findByTestId('plan-writing')).toBeTruthy()
      // A minute of writing: twenty looks at 3 s, every one a miss.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(screen.getByTestId('plan-writing')).toBeTruthy()
      // The writing ended, and the card sees it before it sees the plan (a look that came first found it by luck).
      backend.runs = backend.runs.map(row => (row.run_id === RUN_PLANGEN ? { ...row, state: 'succeeded' } : row))
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_000)
      })
      backend.plansMissing.delete('add-tests')
      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })
      expect(await screen.findByTestId('plan-card-add-tests')).toBeTruthy()
      expect(screen.queryByTestId('plan-writing')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('::roko-plan shows the plan on the glass, roko’s estimate, the one key that runs it, and its steps folded', async () => {
    mount(<TranscriptDirectiveLeaf streaming={false} text={'::roko-plan{id="add-tests"}'} />)

    const card = await screen.findByTestId('plan-card-add-tests')

    expect([...card.querySelectorAll('.rk-rc-label')].map(l => l.textContent)).toEqual(['tasks', 'steps', 'checks', 'estimate'])
    expect(within(card).getByTestId('plan-estimate').querySelector('svg')?.getAttribute('data-value')).toBe('$0.03')
    expect(within(card).getByTestId('plan-status').textContent).toBe('Each task has its checks. Nothing runs until you start it; roko estimates $0.03, with low confidence.')
    expect(within(card).getByRole('button', { name: 'run plan' })).toBeTruthy()
    expect(within(card).queryByText('W2')).toBeNull()
    openFold(card)
    expect(await within(card).findByText('W2')).toBeTruthy()
  })

  it('P-59: a task’s checks are counted whole, and a cut list says how many more', async () => {
    const cut = ['tools/spec.sh 5_2 presets', 'tools/spec.sh 5 presets', 'tools/spec.sh 5_1 render', 'tools/render-demos.sh && tools/spec.sh 5_1 demos']

    // roko_plans' first four, and roko's count of five: the plan sheet could not read the task's own list.
    backend.planExtra['add-tests'] = { tasks: { T1: { checks: cut, check_count: 5, verify: [] } } }
    mount(<TranscriptDirectiveLeaf streaming={false} text={'::roko-plan{id="add-tests"}'} />)
    openFold(await screen.findByTestId('plan-card-add-tests'))

    expect((await screen.findByTestId('checks-T1')).textContent).toBe('5 checks')
    cleanup()
    await mountPage()

    const card = await openPlan('add-tests')

    expect((card.querySelector('.roko-node[data-node="T1"]') as HTMLElement).textContent).toContain('5 checks')
    fireEvent.click(card.querySelector('.roko-node[data-node="T1"]') as HTMLElement)
    expect(card.textContent).toContain('How roko checks it (5)')
    expect(card.querySelectorAll('.roko-checklist .roko-checkcmd')).toHaveLength(4)
    expect(within(card).getByTestId('checks-more').textContent).toBe('and 1 more')
    expect(within(card).getByTestId('task-checks').querySelector('.rk-taskcheck-more')?.textContent).toBe('+4')
  })

  it('::roko-pending lists that run’s waiting items with Approve and Reject', async () => {
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-pending{run="${RUN_ACTIVE}"}`} />)

    const item = await screen.findByTestId('pending-a1b2c3')

    expect(screen.getByTestId('pending-d4e5f6')).toBeTruthy()
    fireEvent.click(within(item).getByRole('button', { name: 'approve' }))
    await waitFor(() => expect(called('POST', '/decide')).toBe(true))
  })
})

describe('live updates and notifications', () => {
  it('a roko_* tool.complete refreshes the overview and refetches the run it names', async () => {
    await mountPage({ run: RUN_DONE })
    await screen.findByTestId(`run-card-${RUN_DONE}`)
    await waitFor(() => expect(called('GET', `/runs/${RUN_DONE}`)).toBe(true))
    api.mockClear()

    act(() => {
      emitGatewayEvent({ payload: { name: 'terminal', tool_id: 't0' }, session_id: 's1', type: 'tool.complete' })
    })
    expect(api).not.toHaveBeenCalled()

    act(() => {
      emitGatewayEvent({
        payload: { args: {}, name: 'roko_status', result: JSON.stringify({ ok: true, run_id: RUN_DONE }), tool_id: 't1' },
        session_id: 's1',
        type: 'tool.complete'
      })
    })

    await waitFor(() => expect(called('GET', '/overview')).toBe(true))
    await waitFor(() => expect(called('GET', `/runs/${RUN_DONE}`)).toBe(true))
  })

  it('a run that ends on its own open page makes no toast over it: its end moment says it there', async () => {
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await reloadPlugin()
    backend.pending = []

    const id = 'cd3e4f5a-6b7c-4d8e-9f0a-2b3c4d5e6f7a'

    backend.runs = [ladderRow({ run_id: id }), ...backend.runs]
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })
    await mountPage({ run: id })
    await screen.findByTestId(`run-card-${id}`)
    nativeNotify.mockClear()

    // (Older toasts may time out meanwhile: only a new one would count.)
    const before = new Set($notifications.get().map(n => n.id))

    backend.runs = backend.runs.map(r => (r.run_id === id ? { ...r, state: 'succeeded', active: false } : r))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
      await queryClient.refetchQueries({ queryKey: ['roko', 'run', id] })
    })
    await screen.findByTestId('end-moment')
    await new Promise(resolve => setTimeout(resolve, 250))
    expect($notifications.get().filter(n => !before.has(n.id)).map(n => n.title)).toEqual([])
    expect(nativeNotify).not.toHaveBeenCalled()
  })

  it('one aggregated toast and one native notification per poll; nothing on the first load', async () => {
    // Hermes throttles a plugin's native notifications to one a second; earlier
    // tests (Cancel run) may have just used it.
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await reloadPlugin()
    await waitFor(() => expect(queryClient.getQueryData(['roko', 'overview'])).toBeDefined())

    // First load: seeded, nothing announced.
    expect(toastTitles()).not.toContain('roko: run passed · 1 item waits on you')
    expect(nativeNotify).not.toHaveBeenCalled()

    backend.setRunState(RUN_ACTIVE, 'succeeded')
    backend.addPending({
      code: 'g7h8i9',
      decision_id: 'c_T3-1',
      kind: 'confirm',
      title: 'the result of task T3 (parser) in run add-tests',
      question: 'Accept the parser?',
      run_id: RUN_ACTIVE
    })

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })

    await waitFor(() => expect(nativeNotify).toHaveBeenCalledTimes(1))
    expect(nativeNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        activate: '/roko#tab=waiting',
        kind: 'plugin',
        tag: 'roko',
        title: 'roko: run passed · 1 item waits on you'
      })
    )
    expect(toastTitles().filter(t => t === 'roko: run passed · 1 item waits on you')).toHaveLength(1)
    expect(toastTitles()[0]).toBe('roko: run passed · 1 item waits on you')

    // The same state again: no new notification.
    const newest = $notifications.get()[0]?.id

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })
    expect(nativeNotify).toHaveBeenCalledTimes(1)
    expect($notifications.get()[0]?.id).toBe(newest)

    // One run finishing on its own links straight to it (after the 1 s native throttle).
    await new Promise(resolve => setTimeout(resolve, 1_100))
    backend.runs = [{ ...backend.runs[0], run_id: RUN_NEW, label: 'fix the lexer', state: 'running' }, ...backend.runs]
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })
    backend.setRunState(RUN_NEW, 'failed')
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })

    await waitFor(() => expect(nativeNotify).toHaveBeenCalledTimes(2))
    expect(nativeNotify).toHaveBeenLastCalledWith(expect.objectContaining({ activate: `/roko#run=${RUN_NEW}`, title: 'roko: run failed' }))
  })
})

describe('failure states', () => {
  it('a missing backend (404) shows the restart banner and the /roko status text', async () => {
    backend.mounted = false
    await mountPage()

    expect(await screen.findByText("roko's backend isn't loaded in Hermes.")).toBeTruthy()
    expect(screen.getByText(/Restart Hermes to load roko's backend: quit it with ⌘Q and open it again\./)).toBeTruthy()
    expect((await screen.findByTestId('roko-status-text')).textContent).toBe('roko: 1 run active (fake /roko status)')
    expect(gatewayRequest).toHaveBeenCalledWith('command.dispatch', { arg: 'status', name: 'roko' })
    expect(screen.queryByRole('tab', { name: /^Runs/ })).toBeNull()
  })

  it('roko unreachable: said once, in the setup card with the start command; a quiet note that the runs are the last known', async () => {
    backend.reachable = false
    await mountPage()

    const problem = within(await screen.findByTestId('setup-module')).getByTestId('problem-roko-unreachable')

    expect(problem.textContent).toContain('Hermes cannot reach roko serve at http://127.0.0.1:6677.')
    expect(within(problem).getByTestId('fix-copy-roko-unreachable')).toBeTruthy()
    expect(problem.querySelector('.rk-fix-cmd')?.textContent).toBe('roko serve')

    // No red box saying it again: a quiet note, without the hint the card's command replaces.
    const note = await screen.findByTestId('offline-note')

    expect(note.textContent).toMatch(/^Showing the last known runs · checked \d{2}:\d{2}:\d{2}; the page asks again every few seconds$/)
    expect(document.querySelector('.roko-banner')).toBeNull()
    expect(screen.queryAllByText(/not answering at http/)).toHaveLength(0)
    expect(screen.getByTestId('roko-connection').textContent).toBe('unreachable · 127.0.0.1:6677')
    expect(within(screen.getByRole('list', { name: 'roko runs' })).getByText('add-tests')).toBeTruthy()
  })

  it('roko down on an older backend: a hint that says WORKSPACE stays a hint, with no copy key for a placeholder', async () => {
    backend.reachable = false
    backend.unreachableHint = 'start it with `roko serve --workdir WORKSPACE`, or let `hermes roko init --workdir WORKSPACE` start it in the background'
    await mountPage()

    const problem = within(await screen.findByTestId('setup-module')).getByTestId('problem-roko-unreachable')

    expect(problem.textContent).toContain('how: docs/troubleshooting.md#roko-serve-is-not-reachable')
    expect(within(problem).queryByTestId('fix-copy-roko-unreachable')).toBeNull()
    expect(screen.getByTestId('offline-note').textContent).toContain('--workdir WORKSPACE')
  })

  it('roko down: the live light says offline, and a request cannot be started before the backend names the problem', async () => {
    // The backend's own look at setup lags (or an older backend has none): the overview alone says roko is down.
    backend.reachable = false
    await mountPage()

    await waitFor(() => expect(screen.getByTestId('live-state').textContent).toBe('offline'))
    // The header says roko's state only when it isn't fine, as a pill (design system §5.1).
    expect(document.querySelector('.rk-head [data-testid="card-pill"]')?.getAttribute('data-state')).toBe('fail')
    expect(within(await screen.findByTestId('setup-module')).getByTestId('problem-roko-unreachable')).toBeTruthy()

    fireEvent.click(screen.getByTestId('new-run'))

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByTestId('problem-card-roko-unreachable')).toBeTruthy()
    expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(dialog, { key: 'Escape' })
  })

  it('P-3: the today counter says whose spend it counts, and roko’s whole day beside it when roko says', async () => {
    backend.rokoTodayUsd = 0.98
    await mountPage()

    await waitFor(() => expect(screen.getByTestId('roko-spend').textContent).toBe('$0.42 from Hermes · $0.98 in roko today · $1.00 held · $8.58 left'))
    // Today's figure on the glass says whose spend it counts.
    expect(screen.getByRole('img', { name: '$0.42 from Hermes · $0.98 in roko today' })).toBeTruthy()
  })

  it('roko down, then up: while offline the page looks again every 2–3 s, so it is ready within seconds of serve starting', async () => {
    backend.reachable = false
    await mountPage()
    await waitFor(() => expect(screen.getByTestId('live-state').textContent).toBe('offline'))

    // roko serve starts. Nothing refetches by hand: the page's own look finds it (the 10 s poll took up to 14 s).
    backend.reachable = true
    await waitFor(() => expect(screen.getByTestId('live-state').textContent).not.toBe('offline'), { timeout: 4_000 })
  })

  it('roko down: a running run is only its last known state, its clock stopped, nothing to cancel; the chip says offline', async () => {
    backend.reachable = false
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)
    const note = await within(card).findByTestId('last-known')

    expect(note.textContent).toMatch(/^roko serve is not answering: this is the run’s last known state(, from \d{2}:\d{2}(:\d{2})?)?\. It may still be going, or it stopped when roko did\.$/)
    expect(card.querySelector('[data-testid="card-pill"]')?.textContent).toContain('last seen running')
    expect(within(card).queryByRole('button', { name: 'Stop run' })).toBeNull()

    fireEvent.click(screen.getByTestId('crumb-runs'))

    // On Runs it is a line that says what roko last said of it.
    expect((await screen.findByTestId(`run-line-${RUN_ACTIVE}`)).textContent).toContain('last seen running')
    cleanup()
    mountContribution('statusBar.right', 'roko:chip')
    expect(await screen.findByTestId('chip-offline')).toBeTruthy()
    // What roko last said is not news: no "1 running" beside "offline".
    expect(screen.getByTestId('roko-status-chip').textContent).not.toMatch(/running|waiting/)
  })

  it('roko stops while a run is open: the card turns into its last known state, with one note and no second error', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    // It waits on the person's sign-off.
    await waitFor(() => expect(card.querySelector('[data-testid="card-pill"]')?.textContent).toContain('needs you'))
    expect(within(card).getAllByRole('button', { name: 'approve' }).length).toBeGreaterThan(0)
    backend.reachable = false
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko'] })
    })

    const note = await within(card).findByTestId('last-known')

    // Its sign-offs are only what roko last said: an answer needs roko.
    expect(within(card).queryByRole('button', { name: 'approve' })).toBeNull()

    expect(note.textContent).toContain('It may still be going, or it stopped when roko did.')
    expect(card.getAttribute('data-state')).toBe('last_seen')
    expect(card.querySelector('[data-testid="card-pill"]')?.textContent).toContain('last seen running')
    expect(within(card).queryByRole('button', { name: 'Stop run' })).toBeNull()
    expect(card.querySelector('.roko-error')).toBeNull()
  })

  it('roko back: Plans, which failed while it was down, loads again without Retry', async () => {
    backend.reachable = false
    await mountPage()
    openTab(/^Plans/)
    // Plans' own error, beside the banner and the setup module's problem.
    await waitFor(() => expect(document.querySelector('.roko-error-text')?.textContent).toContain('roko serve is not answering'))
    expect(screen.queryByRole('list', { name: 'roko plans' })).toBeNull()

    backend.reachable = true
    // The backend's own look at setup can still name roko-unreachable for up to 30 s after roko answers again.
    backend.problems = [
      {
        id: 'roko-unreachable',
        severity: 'block',
        title: 'Hermes cannot reach roko serve at http://127.0.0.1:6677.',
        detail: 'Nothing roko does works from Hermes until roko serve runs.',
        fix: { kind: 'command', label: 'start roko serve', command: 'roko serve --workdir /work/ws', action: null, docs: null }
      }
    ]
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })

    const rows = await screen.findByRole('list', { name: 'roko plans' })

    expect(await within(rows).findByText('Add tests')).toBeTruthy()
    expect(screen.getByTestId('live-state').textContent).not.toBe('offline')
    expect(screen.queryByTestId('problem-card-roko-unreachable')).toBeNull()
  })

  it('a run started moments ago says "started just now", never "now ago"', async () => {
    backend.runs = backend.runs.map(row => (row.run_id === RUN_ACTIVE ? { ...row, started_at: new Date().toISOString() } : row))
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(card.textContent).toContain('started just now'))
    expect(card.textContent).not.toContain('now ago')
  })

  it('a section error offers Retry and recovers', async () => {
    backend.failures.set('/health', { code: 'server_error', hint: 'Check roko serve logs.', message: 'roko answered 500.' })
    await mountPage()
    openTab(/^Insights/)

    expect(await screen.findByText('roko answered 500.')).toBeTruthy()
    backend.failures.delete('/health')
    fireEvent.click(screen.getAllByRole('button', { name: 'Retry' })[0])
    expect(await screen.findByText('roko serve 0.1.0, status ok')).toBeTruthy()
  })
})

/** WCAG 2 relative luminance and contrast ratio of two #rrggbb colours. */
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(i => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))

  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)

  return (hi + 0.05) / (lo + 0.05)
}

/** Run `fn` as a person who asked for less motion (prefers-reduced-motion: reduce). */
async function withReducedMotion(fn: () => Promise<void>) {
  const before = window.matchMedia

  setGlobal('matchMedia', (query: string) => ({ addEventListener() {}, addListener() {}, matches: /prefers-reduced-motion:\s*reduce/.test(query), media: query, removeEventListener() {}, removeListener() {} }))

  try {
    await fn()
  } finally {
    setGlobal('matchMedia', before)
  }
}

describe('v3 guards (spec §8, §9)', () => {
  it('contrast: on the glass and in the phosphor theme, content text is at least 4.5:1 (WCAG AA)', () => {
    const css = document.head.querySelector('style[data-hermes-plugin="roko"]')?.textContent ?? ''
    const glass = (name: string) => css.match(new RegExp(`--ph-${name}:(#[0-9a-f]{6})\\b`))?.[1] as string
    const voidBlack = glass('void')

    expect(voidBlack).toBe('#0b0c0d')
    for (const name of ['dim', 'ink', 'bright', 'bone', 'live', 'pass', 'fail', 'you', 'learn']) {
      expect(contrast(glass(name), voidBlack), `--ph-${name} on the glass`).toBeGreaterThanOrEqual(4.5)
    }

    // Decoration only (spec §8): unlit pixels, empty pips, module numbers. They must stay below text, never above.
    for (const name of ['phantom', 'ghost', 'label']) {
      expect(contrast(glass(name), voidBlack), `--ph-${name} is decoration`).toBeLessThan(3)
    }

    // The body channels of the phosphor theme, as text on its cards and on its page, light and dark.
    const theme = contribution('themes', 'roko:theme')?.data as { colors: Record<string, string>; darkColors: Record<string, string>; customCSS: string }
    const [light, dark] = theme.customCSS.split(':root.dark')
    const value = (block: string, name: string) => block.match(new RegExp(`${name}:(#[0-9a-f]{6})\\b`))?.[1] as string

    for (const [palette, block] of [
      [theme.colors, light],
      [theme.darkColors, dark]
    ] as const) {
      for (const surface of [palette.card, palette.background]) {
        for (const name of ['--roko-live', '--ui-green', '--ui-red', '--ui-purple', '--roko-you-text']) {
          expect(contrast(value(block, name), surface), `${name} on ${surface}`).toBeGreaterThanOrEqual(4.5)
        }

        for (const ink of [palette.foreground, palette.mutedForeground]) {
          expect(contrast(ink, surface), `${ink} on ${surface}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it('reduced motion: a fresh run’s title appears as it is, without the decode', async () => {
    await withReducedMotion(async () => {
      await mountPage()
      fireEvent.click(await screen.findByTestId('new-run'))

      const dialog = await screen.findByRole('dialog', { name: 'New roko run' })

      fireEvent.change(within(dialog).getByLabelText('What should roko do?'), { target: { value: 'Add a --json flag' } })
      fireEvent.click(within(dialog).getByTestId('composer-submit'))

      const card = await screen.findByTestId(`run-card-${RUN_NEW}`)
      const title = card.querySelector('.rk-runhead-title') as HTMLElement

      expect(title.textContent).toBe('Add a --json flag')
      expect(title.children).toHaveLength(0)
    })
  })
})

/** Will's workspace ladder with roko's prices (spec v3 §4.3); the top rung is a CLI agent a chat's run cannot use. */
const LADDER = [
  { rung: 'cheap', model: 'gpt-oss-120b', slug: 'gpt-oss-120b', provider: 'cerebras', price_in: 0.35, price_out: 0.75, price_cache_read: null, chat_ok: true, why_not: null },
  { rung: 'mid', model: 'glm-4.7', slug: 'glm-4.7', provider: 'zai', price_in: 0.6, price_out: 2.2, price_cache_read: null, chat_ok: true, why_not: null },
  { rung: 'strong', model: 'gpt-5.4-mini', slug: 'gpt-5.4-mini', provider: 'openai', price_in: 0.75, price_out: 4.5, price_cache_read: null, chat_ok: true, why_not: null },
  { rung: 'top', model: 'claude-sonnet-4-6', slug: 'claude-sonnet-4-6', provider: 'claude_cli', price_in: 3, price_out: 15, price_cache_read: null, chat_ok: false, why_not: 'not for chat runs: its agent runs its own tools' }
]
const LADDER_RUN = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f'
const tryOf = (attempt: number, rung: string, reason: string, outcome: string, extra: Record<string, unknown> = {}) => ({
  attempt,
  rung,
  model: LADDER.find(r => r.rung === rung)?.model,
  provider: LADDER.find(r => r.rung === rung)?.provider,
  reason,
  outcome,
  failed_check: outcome === 'failed' ? 'verify[0:test]' : null,
  key_line: outcome === 'failed' ? "AssertionError: 'food  50.00' != 'food  $50.00'" : null,
  cost_usd: 0.01,
  duration_ms: outcome === 'running' ? null : 40_000,
  started_at: null,
  failover: null,
  blame: null,
  source: 'events',
  ...extra
})
/** Mockup 01's run: T1, T2, T4 passed on cheap; T3 failed twice on cheap and climbed to mid, where it runs; T5 waits. */
const ladderRow = (overrides: Record<string, unknown> = {}) => ({
  run_id: LADDER_RUN,
  kind: 'plan',
  label: 'Add per-category budgets to tally',
  plan_id: 'tally-budgets',
  state: 'running',
  active: true,
  cost_usd: 0.071,
  max_usd: 1,
  started_at: new Date(Date.now() - 72_000).toISOString(),
  ladder: LADDER,
  gates: { passed: 6, failed: 0, total: 6, retried: 2 },
  tasks: [
    { task_id: 'T1', title: 'BudgetStore persistence', outcome: 'passed', attempts: 1, model: 'gpt-oss-120b', gates: [{ gate: 'verify[0:test]', passed: true }], depends_on: [], climb: [tryOf(1, 'cheap', 'start', 'passed')], lives: { rung: 'cheap', used: 1, of: 2 } },
    { task_id: 'T2', title: 'render_summary: budget vs spent', outcome: 'passed', attempts: 1, model: 'gpt-oss-120b', gates: [{ gate: 'verify[0:test]', passed: true }], depends_on: ['T1'], climb: [tryOf(1, 'cheap', 'start', 'passed')], lives: { rung: 'cheap', used: 1, of: 2 } },
    { task_id: 'T3', title: 'CLI budget subcommands in report', outcome: 'running', attempts: 3, model: 'glm-4.7', step: 'agent', step_since: new Date(Date.now() - 14_000).toISOString(), gates: [], depends_on: ['T1'], climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'failed'), tryOf(3, 'mid', 'climb', 'running')], lives: { rung: 'mid', used: 1, of: 2 } },
    { task_id: 'T4', title: 'Unit tests for BudgetStore', outcome: 'passed', attempts: 1, model: 'gpt-oss-120b', gates: [{ gate: 'verify[0:test]', passed: true }], depends_on: ['T1'], climb: [tryOf(1, 'cheap', 'start', 'passed')], lives: { rung: 'cheap', used: 1, of: 2 } },
    { task_id: 'T5', title: 'Over-budget report + CLI tests', outcome: 'pending', attempts: 0, gates: [], depends_on: ['T2', 'T3'], climb: [], lives: null }
  ],
  ...overrides
})

describe('v3: the Ladder, the stream, the receipt (spec §4.3–4.6)', () => {
  it('the Ladder draws where each task stands: passed on cheap, a climb to mid with its trail, the waiting one, the rung chats cannot use', async () => {
    backend.runs = [ladderRow(), ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)
    const ladder = await within(card).findByTestId('ladder')
    const rung = (name: string) => ladder.querySelector(`.rk-rung[data-rung="${name}"]`) as HTMLElement

    // Top rung first; the CLI rung is dashed and says why it is never used.
    expect([...ladder.querySelectorAll('.rk-rung')].map(r => r.getAttribute('data-rung'))).toEqual(['top', 'strong', 'mid', 'cheap'])
    expect(rung('top').getAttribute('data-off')).toBe('true')
    expect(rung('top').textContent).toContain('not for chat runs: its agent runs its own tools')
    expect(rung('cheap').textContent).toContain('$0.35·$0.75')
    // T3 runs on mid, rose, after its two failed tries on cheap (the ✕✕ ghost) and a trail up.
    expect(within(ladder).getByTestId('ladder-token-T3').getAttribute('data-state')).toBe('running')
    expect(rung('mid').getAttribute('data-live')).toBe('true')
    expect(rung('cheap').querySelector('.rk-tok[data-state="ghost"]')?.textContent).toBe('✕✕')
    expect(rung('mid').querySelector('.rk-trail')).toBeTruthy()
    expect(rung('mid').textContent).toContain('▲ 2✕ on cheap')
    // Three passed on cheap; T5 waits there, dashed.
    expect(rung('cheap').querySelector('.rk-rcount')?.textContent).toBe('3✓')
    expect(within(ladder).getByTestId('ladder-token-T5').getAttribute('data-state')).toBe('waiting')
    // For assistive tech the ladder is a list that says the same.
    expect(within(ladder).getByRole('list', { name: 'The model ladder, top rung first' })).toBeTruthy()
    expect(rung('cheap').getAttribute('aria-label')).toBe('cheap rung, gpt-oss-120b: T1 passed; T2 passed; T4 passed; T5 waiting to start; T3 failed 2 times here and climbed')
    // The pads say the same: T3's chip is MID ▲ in rose, its lives ✕✕●.
    const pad = card.querySelector('.roko-node[data-node="T3"]') as HTMLElement

    expect(pad.querySelector('.rk-rchip')?.textContent).toBe('mid ▲')
    expect(pad.querySelector('.rk-rchip')?.getAttribute('data-climbed')).toBe('true')
    expect([...pad.querySelectorAll('.rk-lives i')].map(i => i.getAttribute('data-life'))).toEqual(['x', 'x', 'r'])
    // The ladder is the run's page's Models panel (design system §4.8).
    expect(within(card).getByTestId('run-models').contains(ladder)).toBe(true)
  })

  it('a climb seen as it happens rises with its echo and declares ⌈CLIMBED⌋; with reduced motion only the stamp', async () => {
    const before = ladderRow({
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
        t.task_id === 'T3' ? { ...t, attempts: 2, model: 'gpt-oss-120b', climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'running')], lives: { rung: 'cheap', used: 2, of: 2 } } : t
      )
    })

    backend.runs = [before, ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)

    await waitFor(() => expect(card.querySelector('.rk-rung[data-rung="cheap"] [data-testid="ladder-token-T3"]')).toBeTruthy())
    backend.runs = backend.runs.map(row => (row.run_id === LADDER_RUN ? ladderRow() : row))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'run', LADDER_RUN] })
    })

    const token = await within(card).findByTestId('ladder-token-T3')

    await waitFor(() => expect(card.querySelector('.rk-rung[data-rung="mid"] [data-testid="ladder-token-T3"]')).toBeTruthy())
    expect(card.querySelector('.rk-rung[data-rung="mid"] [data-testid="ladder-token-T3"]')?.getAttribute('data-move')).toBe('climb')
    expect(token).toBeTruthy()
    expect(await within(card).findByTestId('stamp-climbed')).toBeTruthy()
  })

  it('the stream: tool calls, a failed check with its key line, the climb and the agent’s words, newest last', async () => {
    const t0 = Date.now() - 60_000

    backend.runs = [ladderRow({ started_at: new Date(t0).toISOString() }), ...backend.runs]
    backend.eventsFor[LADDER_RUN] = [
      { cursor: 10, type: 'agent_output', group: 'tool', ring: 'L0', task_id: 'T3', tool: 'Read', target: 'tally/cli.py', ts_millis: t0 + 5_000, text: 'T3 Read tally/cli.py' },
      { cursor: 20, type: 'gate_result', group: 'gate', task_id: 'T3', gate: 'verify[0:test]', passed: false, ts_millis: t0 + 41_000, text: 'T3 gate verify[0:test] failed' },
      { cursor: 30, type: 'route_decided', group: 'loop', ring: 'L1', task_id: 'T3', model: 'glm-4.7', attempt: 3, ts_millis: t0 + 44_000, text: 'T3 attempt 3 → glm-4.7' },
      { cursor: 40, type: 'agent_output', group: 'tool', ring: 'L0', task_id: 'T3', tool: 'Edit', target: 'tally/cli.py', ts_millis: t0 + 58_000, text: 'T3 Edit tally/cli.py' }
    ]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)
    const stream = await within(card).findByTestId('stream')

    await waitFor(() => expect(stream.textContent).toContain('Edit tally/cli.py'))

    const lines = [...stream.querySelectorAll('.rk-ln .rk-ln-x')].map(l => l.textContent)

    expect(lines).toEqual(['Read tally/cli.py', '✕ verify[0:test] did not pass', "AssertionError: 'food  50.00' != 'food  $50.00'", '▲ up to mid · glm-4.7 · 2 failed checks on cheap', 'Edit tally/cli.py'])
    expect(stream.querySelector('.rk-ln[data-tone="fail"] .rk-ln-t')?.textContent).toBe('0:41')
    // The newest row is the brightest; older ones dim.
    const rows = [...stream.querySelectorAll('.rk-ln:not(.rk-ln-sub)')] as HTMLElement[]

    expect(Number(rows.at(-1)!.style.opacity)).toBeGreaterThan(Number(rows[0].style.opacity))
    expect(within(stream).getByRole('log')).toBeTruthy()
  })

  it('the receipt once it ended: where on the ladder it passed, the top rung ≈, what changed; the first end ever is a Tier 4 moment', async () => {
    const done = ladderRow({
      state: 'running',
      tokens: { input: 120_000, output: 40_000, cache_read: 0 },
      delivered: { workspace: '/work/ws', branch: 'roko/batch/ddf4e5b1', commit: 'abc', files_changed: ['tally/cli.py'], diffstat: '9 files changed, 287 insertions(+), 3 deletions(-)', merged: false }
    })

    backend.runs = [done, ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)

    await within(card).findByTestId('ladder')
    backend.runs = backend.runs.map(row =>
      row.run_id === LADDER_RUN
        ? { ...done, state: 'succeeded', active: false, tasks: (done.tasks as Array<Record<string, unknown>>).map(t => ({ ...t, outcome: 'passed', climb: (t.climb as Array<Record<string, unknown>>).map(c => (c.outcome === 'running' ? { ...c, outcome: 'passed' } : c)) })) }
        : row
    )
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'run', LADDER_RUN] })
    })

    // The end, as it happens, is declared with a stamp that holds a Moment (Tier 4 the first time a workspace sees it).
    const moment = await within(card).findByTestId('end-moment')

    expect(moment.textContent).toBe('passed')
    expect(['1', '2', '3', '4']).toContain(moment.getAttribute('data-tier'))
    // It flashes beside the head's pill (design system §3.6), over no reading.
    expect(moment.parentElement?.classList.contains('rk-rc-head')).toBe(true)
    // The first run a workspace ends prints its receipt a line at a time (Tier 4): wait for the last line.
    await waitFor(() => expect(within(card).getByTestId('receipt').textContent).toContain('+287 −3'), { timeout: 5_000 })

    const receipt = within(card).getByTestId('receipt')

    expect(receipt.textContent).toContain('4 passed on cheap · 1 climbed to mid · nothing above')
    // 120k in and 40k out on claude-sonnet-4-6 at $3 / $15 a million: ≈ $0.96, against $0.071.
    expect(receipt.textContent).toContain('≈ $0.96 on claude-sonnet-4-6 · this cost 14× less')
    // An older backend's receipt is worked out from the run's totals, and says so on its own line.
    expect(receipt.textContent).toContain('≈ from run totals, failed tries included')
    expect(receipt.textContent).toContain('+287 −3 in 9 files · roko/batch/ddf4e5b1 · verified')
  })

  it('chat and the monitor: the ladder strip while it runs, the receipt once it ended, the column in the pane; the delegate card names the ladder', async () => {
    backend.runs = [ladderRow(), ...backend.runs]
    backend.ladder = LADDER
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${LADDER_RUN}"}`} />)

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)

    openFold(card)
    const strip = await within(card).findByTestId('ladder-strip')

    expect([...strip.querySelectorAll('.rk-lstrip-seg')].map(seg => seg.querySelector('.rk-rung-r')?.textContent)).toEqual(['cheap', 'mid', 'strong', 'top'])
    expect(strip.querySelector('.rk-lstrip-seg[data-off="true"]')?.textContent).toContain('chat: no')
    expect(strip.querySelectorAll('.rk-lstrip-seg[data-live="true"] i[data-state="running"]')).toHaveLength(1)
    expect(within(card).getByText('checks: test')).toBeTruthy()

    cleanup()

    const c = contribution('chat.empty', 'roko:delegate')!

    mount(
      <ContribBoundary id={c.id}>
        <ContribRender render={() => (c.data as { render: (p: { sessionId: string }) => ReactNode }).render({ sessionId: 's-7' })} />
      </ContribBoundary>
    )
    await waitFor(() => expect(screen.getByTestId('delegate-ladder').textContent).toBe('starts on gpt-oss-120b · climbs to glm-4.7, gpt-5.4-mini'))
  })

  it('the receipt reads the backend’s (0.6.0): the top rung ≈ worded by its ratio, its basis on a line of its own, the tasks not compared; no ratio says why (spec §4.6)', async () => {
    const passed = (ladderRow().tasks as Array<Record<string, unknown>>).map(t => ({ ...t, outcome: 'passed', climb: (t.climb as Array<Record<string, unknown>>).map(c => (c.outcome === 'running' ? { ...c, outcome: 'passed' } : c)) }))
    const receipt = {
      cost_usd: 0.15,
      by_rung: { cheap: { passed: 4, tries: 6, cost_usd: 0.09 }, mid: { passed: 1, tries: 1, cost_usd: 0.06 } },
      climbs: 1,
      first_try_passes: 3,
      top_rung: { rung: 'top', model: 'claude-sonnet-4-6', slug: 'claude-sonnet-4-6' },
      top_rung_usd: 1.21,
      top_rung_by: 'passing_tries',
      not_compared: 0,
      ratio: 8.1,
      basis: "≈ the 5 passing tries' tokens at claude-sonnet-4-6's list prices, plus $0.01 helper calls",
      basis_detail: "14,400 input, 960 output and 0 cache-read tokens of the passing tries at claude-sonnet-4-6's list prices ($3.00 in, $15.00 out per million), plus $0.0100 of helper calls at their cost",
      lessons_kept: 3,
      lessons_confirmed: 2,
      lessons_used: null,
      changes: { kind: 'verified', files: 9, additions: 287, deletions: 3, branch: 'roko/batch/ddf4e5b1', merged: false }
    }
    const set = async (patch: Record<string, unknown>) => {
      backend.runs = backend.runs.map(row => (row.run_id === LADDER_RUN ? { ...row, ...patch, receipt: { ...receipt, ...((patch.receipt as Record<string, unknown>) ?? {}) } } : row))
      await act(async () => {
        await queryClient.refetchQueries({ queryKey: ['roko', 'run', LADDER_RUN] })
      })
    }

    backend.runs = [ladderRow({ state: 'succeeded', active: false, cost_usd: 0.15, tasks: passed, receipt }), ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)
    const strip = await within(card).findByTestId('receipt')
    const values = () => [...strip.querySelectorAll('.rk-receipt-line')].map(l => [l.querySelector('.rk-receipt-k')?.textContent, l.querySelector('.rk-receipt-v')?.textContent])
    const after = (key: string) => values().slice(values().findIndex(([k]) => k === key))

    // 8.1× (one decimal below 10), then its basis in full on a mono line of its own, not only in a hover.
    expect(after('top rung').slice(0, 2)).toEqual([
      ['top rung', '≈ $1.21 on claude-sonnet-4-6 · this cost 8.1× less'],
      ['', "≈ the 5 passing tries' tokens at claude-sonnet-4-6's list prices, plus $0.01 helper calls"]
    ])
    expect(values().find(([k]) => k === 'changes')?.[1]).toContain('+287 −3 in 9 files · roko/batch/ddf4e5b1 · verified')
    expect(values().find(([k]) => k === 'learned')?.[1]).toContain('◇ kept 3 lessons · confirmed 2 it had')
    expect(values().find(([k]) => k === 'ladder')?.[1]).toContain('4 passed on cheap · 1 climbed to mid · nothing above')

    // About the same (0.8 to 1.25), and a climb that cost more (below 0.8): said plainly, in neutral ink.
    await set({ receipt: { ratio: 1.1, top_rung_usd: 0.166 } })
    await waitFor(() => expect(after('top rung')[0]).toEqual(['top rung', '≈ $0.17 on claude-sonnet-4-6 · about the same']))
    await set({ receipt: { ratio: 0.7, top_rung_usd: 0.104, not_compared: 1 } })
    await waitFor(() => expect(after('top rung')[0]).toEqual(['top rung', '≈ $0.10 on claude-sonnet-4-6 · the climb cost more this time']))
    expect(strip.querySelector('.rk-receipt-good')).toBeNull()
    // The tasks with no passing try are left out, and counted.
    expect(after('top rung')[2]).toEqual(['', '1 task didn’t pass: not compared'])

    // No ratio (no task passed, or no price): the backend's words alone, and the run that ended without passing too.
    await set({ state: 'failed', receipt: { top_rung_usd: null, ratio: null, not_compared: 5, basis: 'no task passed: nothing to compare', basis_detail: null } })
    await waitFor(() => expect(after('top rung')[0]).toEqual(['top rung', 'no task passed: nothing to compare']))
    expect(after('top rung')[1]).toEqual(['', '5 tasks didn’t pass: not compared'])
  })

  it('the first failure seen live types its why out, once, with the rose cursor; assistive tech reads it whole', async () => {
    const why = 'T3 did not pass verify[0:test] after 4 tries, and the ladder has no rung left above mid.'

    backend.runs = [ladderRow(), ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)

    await within(card).findByTestId('ladder')
    backend.runs = backend.runs.map(row => (row.run_id === LADDER_RUN ? { ...ladderRow(), state: 'failed', active: false, why: { summary: why } } : row))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'run', LADDER_RUN] })
    })

    const callout = await within(card).findByTestId('why')
    const typed = await within(callout).findByTestId('type-out')

    expect(typed.textContent!.length).toBeLessThan(why.length)
    expect(typed.querySelector('.rk-cursor')).toBeTruthy()
    expect(callout.querySelector('.rk-sr')?.textContent).toBe(why)
    await waitFor(() => expect(typed.textContent).toBe(why), { timeout: 6_000 })
    expect(typed.querySelector('.rk-cursor')).toBeNull()
  })

  it('a run that did not pass gets an honest receipt: where its tasks stopped, no changes, and no top-rung comparison', async () => {
    const failed = ladderRow({
      state: 'failed',
      active: false,
      cost_usd: 0.17,
      tokens: { input: 120_000, output: 40_000, cache_read: 0 },
      work: { kind: 'none', parts: [] },
      tasks: [
        { task_id: 'T1', title: 'BudgetStore persistence', outcome: 'failed', attempts: 6, gates: [{ gate: 'verify[0:compile]', passed: false }], depends_on: [], climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'failed'), tryOf(3, 'mid', 'climb', 'failed'), tryOf(4, 'mid', 'retry', 'failed'), tryOf(5, 'strong', 'climb', 'failed'), tryOf(6, 'strong', 'retry', 'failed')], lives: { rung: 'strong', used: 2, of: 2 } },
        { task_id: 'T2', title: 'render_summary', outcome: 'blocked', attempts: 0, gates: [], depends_on: ['T1'], climb: [], lives: null }
      ]
    })

    backend.runs = [failed, ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)
    const strip = await within(card).findByTestId('receipt')

    expect(strip.textContent).toContain('no task passed · T1 failed on strong, the ladder’s last rung for it')
    expect(strip.textContent).toContain('no changes')
    expect(strip.textContent).not.toContain('top rung')
    expect(strip.textContent).not.toContain('nothing above')
    expect(within(card).getByTestId('stamp-exhausted')).toBeTruthy()

    // roko says it itself since 37088dc12 (`tasks[].exhausted`): the stamp carries its advice.
    cleanup()
    backend.runs = [
      { ...failed, tasks: (failed.tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T1' ? { ...t, lives: null, exhausted: { attempt: 6, rung: 'strong', model: 'gpt-5.4-mini', suggestion: 'Split the task into smaller tasks, or replan it.' } } : t)) },
      ...backend.runs.filter(r => r.run_id !== LADDER_RUN)
    ]
    queryClient.removeQueries({ queryKey: ['roko', 'run', LADDER_RUN] })
    await mountPage({ run: LADDER_RUN })
    await waitFor(() => expect(screen.getByTestId('stamp-exhausted').getAttribute('title')).toBe('Split the task into smaller tasks, or replan it.'))
  })

  it('P-36: a task not started yet waits on its tier’s start rung, not on the first rung', async () => {
    const starts: Record<string, string[]> = { cheap: ['mechanical', 'focused'], mid: ['integrative'], strong: [], top: ['architectural'] }
    const row = ladderRow({
      ladder: LADDER.map(r => ({ ...r, starts: starts[r.rung] })),
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T5' ? { ...t, tier: 'integrative' } : t))
    })

    backend.runs = [row, ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const ladder = await within(await screen.findByTestId(`run-card-${LADDER_RUN}`)).findByTestId('ladder')
    const on = (rung: string) => ladder.querySelector(`.rk-rung[data-rung="${rung}"]`) as HTMLElement

    expect(within(on('mid')).getByTestId('ladder-token-T5').getAttribute('data-state')).toBe('waiting')
    expect(within(on('cheap')).queryByTestId('ladder-token-T5')).toBeNull()
  })

  it('phase 2’s stills: two tasks out of rungs on one rung get one stamp beside the last, and neither token is covered', async () => {
    const out = { attempt: 4, rung: 'strong', model: 'gpt-5.4-mini', suggestion: 'Split the task into smaller tasks, or replan it.' }
    const failedOn = (rung: string) => [tryOf(1, rung, 'start', 'failed'), tryOf(2, rung, 'retry', 'failed'), tryOf(3, rung, 'retry', 'failed')]
    const failed = ladderRow({
      state: 'failed',
      active: false,
      cost_usd: 0.93,
      tasks: [
        { task_id: 'T1', title: 'LFO module', outcome: 'passed', attempts: 1, model: 'glm-4.7', gates: [{ gate: 'verify[0:test]', passed: true }], depends_on: [], climb: [tryOf(1, 'mid', 'start', 'passed')], lives: { rung: 'mid', used: 1, of: 2 } },
        { task_id: 'T2', title: 'rumble generator', outcome: 'failed', attempts: 3, gates: [{ gate: 'verify[2:test]', passed: false }], depends_on: ['T1'], climb: failedOn('strong'), lives: null, exhausted: out },
        { task_id: 'T3', title: 'output stage', outcome: 'failed', attempts: 3, gates: [{ gate: 'verify[0:test]', passed: false }], depends_on: ['T1'], climb: failedOn('strong'), lives: null, exhausted: out },
        { task_id: 'T4', title: 'engine wiring', outcome: 'blocked', attempts: 0, gates: [], depends_on: ['T2', 'T3'], climb: [], lives: null }
      ]
    })

    backend.runs = [failed, ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)
    const ladder = await within(card).findByTestId('ladder')
    const strong = ladder.querySelector('.rk-rung[data-rung="strong"]') as HTMLElement
    const stamps = within(strong).getAllByTestId('stamp-exhausted')

    expect(stamps).toHaveLength(1)
    expect(stamps[0].getAttribute('title')).toBe('T2, T3: Split the task into smaller tasks, or replan it.')
    // Beside T3, the rung’s last token: never at the rail’s end over the tokens.
    expect((stamps[0].parentElement as HTMLElement).getAttribute('data-beside')).toBe('T3')
    expect((stamps[0].parentElement as HTMLElement).style.right).toBe('')
    expect(within(strong).getByTestId('ladder-token-T2').getAttribute('data-exhausted')).toBe('true')
    expect((await within(card).findByTestId('receipt')).textContent).toContain('T2, T3 failed on strong, the ladder’s last rung for them')
  })

  it('phase 2.1’s receipt: passes on a rung that were failover substitutes say so', async () => {
    const failover = { model: 'gpt-5.4-mini', provider: 'openai', class: 'rate_limited', why: 'rate limited' }
    const id = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
    const row = ladderRow({
      run_id: id,
      state: 'succeeded',
      active: false,
      tasks: [
        { task_id: 'T1', title: 'a', outcome: 'passed', attempts: 1, gates: [], depends_on: [], climb: [tryOf(1, 'strong', 'failover', 'passed', { failover })], lives: null },
        { task_id: 'T2', title: 'b', outcome: 'passed', attempts: 1, gates: [], depends_on: [], climb: [tryOf(1, 'mid', 'start', 'passed')], lives: null },
        { task_id: 'T3', title: 'c', outcome: 'passed', attempts: 1, gates: [], depends_on: [], climb: [tryOf(1, 'strong', 'failover', 'passed', { failover })], lives: null }
      ]
    })

    backend.runs = [row, ...backend.runs]
    await mountPage({ run: id })

    const strip = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('receipt')

    expect(strip.textContent).toContain('1 passed on mid · 2 passed on strong via failover')
  })

  it('a token with others to its right carries its failover as a mark, not words over them; the stream tells the pick from the failover', async () => {
    const t0 = Date.now() - 60_000
    const failover = { model: 'gpt-5.4-mini', provider: 'openai', class: 'rate_limited', why: 'rate limited' }
    // A run of its own: the page keeps each run's timeline between tests.
    const id = '8f9a0b1c-2d3e-4f5a-9b6c-7d8e9f0a1b2c'
    const row = ladderRow({
      run_id: id,
      started_at: new Date(t0).toISOString(),
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T2' ? { ...t, outcome: 'running', climb: [tryOf(1, 'cheap', 'failover', 'running', { failover })] } : t))
    })

    backend.runs = [row, ...backend.runs]
    backend.eventsFor[id] = [
      { cursor: 10, type: 'route_decided', group: 'loop', ring: 'L1', loop: 'route', task_id: 'T2', model: 'gpt-5.4-mini', attempt: 1, ts_millis: t0 + 5_000, text: 'T2 attempt 1 → gpt-5.4-mini' },
      { cursor: 11, type: 'route_decided', group: 'loop', ring: 'L1', loop: 'failover', task_id: 'T2', model: 'gpt-oss-120b', attempt: 1, ts_millis: t0 + 5_100, text: 'T2 attempt 1 switched to gpt-oss-120b (failover)' }
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const token = await within(card).findByTestId('ladder-token-T2')

    // T4 stands to its right on cheap: no words over it, a ⇄ mark and the words in the title.
    expect(token.getAttribute('data-failover')).toBe('true')
    expect(token.getAttribute('title')).toBe('failover: rate limited')
    expect(card.querySelector('.rk-lad-failover')).toBeNull()

    const stream = await within(card).findByTestId('stream')

    await waitFor(() => expect(stream.textContent).toContain('⇄ failover → gpt-oss-120b · gpt-5.4-mini rate limited'))
    expect([...stream.querySelectorAll('.rk-ln .rk-ln-x')].map(l => l.textContent)).toContain('→ gpt-5.4-mini')
  })

  it('the lessons in a try’s prompt show as ◇n on its pad and a line in the stream; a rung without a list price says so', async () => {
    const t0 = Date.now() - 60_000
    // A run of its own: the page keeps each run's timeline between tests.
    const id = '9a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d'
    const unpriced = LADDER.map(r => (r.rung === 'top' ? { ...r, price_in: null, price_out: null } : r))
    const row = ladderRow({
      run_id: id,
      ladder: unpriced,
      started_at: new Date(t0).toISOString(),
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
        t.task_id === 'T3' ? { ...t, climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'failed'), tryOf(3, 'mid', 'climb', 'running', { lesson_ids: ['k-1', 'k-2', 'k-1'] })] } : t
      )
    })

    backend.runs = [row, ...backend.runs]
    backend.eventsFor[id] = [{ cursor: 30, type: 'route_decided', group: 'loop', ring: 'L1', loop: 'route', task_id: 'T3', model: 'glm-4.7', attempt: 3, ts_millis: t0 + 44_000, text: 'T3 attempt 3 → glm-4.7' }]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    await waitFor(() => expect(card.querySelector('.roko-node[data-node="T3"] .rk-pad-lessons')).toBeTruthy())
    expect(card.querySelector('.roko-node[data-node="T3"] .rk-pad-lessons')?.textContent).toBe('◇2')
    await waitFor(() => expect(within(card).getByTestId('stream').textContent).toContain('◇ 2 lessons in its prompt'))
    expect((card.querySelector('.rk-rung[data-rung="top"] .rk-rung-p') as HTMLElement).textContent).toBe('no list price')
  })

  it('P-52: a rung roko skips reads skipped in roko’s words, and a task that would start on it waits on the next rung', async () => {
    const id = '7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0c'
    const said = 'skipped until 20:33: its tool-use probe failed: insufficient_credits: http 402; a task that would start on it starts on the next rung that runs'
    // The backend's marking (rundata.with_skipped): one this run cannot use, why in roko's words, its tiers on mid.
    const ladder = [{ ...LADDER[0], chat_ok: false, skipped: true, why_not: said, starts: [] }, { ...LADDER[1], starts: ['integrative', 'mechanical'] }, LADDER[2], LADDER[3]]
    const waiting = { task_id: 'T2', title: 'Layout', outcome: 'pending', attempts: 0, gates: [], depends_on: ['T1'], climb: [], lives: null, tier: 'mechanical' }

    backend.runs = [ladderRow({ run_id: id, ladder, tasks: [(ladderRow().tasks as Array<Record<string, unknown>>)[2], waiting] }), ...backend.runs]
    await mountPage({ run: id })

    const lad = within(await screen.findByTestId(`run-card-${id}`)).getByTestId('ladder')
    const cheap = lad.querySelector('.rk-rung[data-rung="cheap"]') as HTMLElement

    expect(cheap.getAttribute('data-off')).toBe('true')
    expect(cheap.querySelector('.rk-rail-note')?.textContent).toBe(said)
    expect(cheap.querySelector('.rk-rail-note')?.getAttribute('title')).toBe(said)
    expect(cheap.getAttribute('aria-label')).toContain(said)
    expect(cheap.getAttribute('aria-label')).not.toContain('not for runs from a chat')
    // T2 waits where roko starts it: on mid, not on the rung it skips.
    expect(lad.querySelector('.rk-rung[data-rung="mid"] [data-testid="ladder-token-T2"]')).toBeTruthy()
    expect(cheap.querySelector('[data-testid="ladder-token-T2"]')).toBeNull()
  })

  it('P-46: an ended run’s ladder is the one it ran on, each rung with what it spent; a live run’s is roko.toml now', async () => {
    const id = '5c6d7e8f-9a0b-4c1d-8e2f-3a4b5c6d7e8f'
    const rung = (name: string, model: string, spent: number, refused: number | null = null) => ({ rung: name, model, slug: model, provider: null, price_in: null, price_out: null, chat_ok: true, why_not: null, starts: [], spent_usd: spent, refused_usd: refused })

    backend.runs = [
      ladderRow({ run_id: id, state: 'succeeded', active: false, finished_at: new Date().toISOString(), ladder: [rung('mid', 'glm-4.7', 0.873042, 0.207559), rung('strong', 'gpt-5.4-mini', 0.035439)], ladder_from: 'run' }),
      ladderRow({ ladder_from: 'config' }),
      ...backend.runs
    ]
    await mountPage({ run: id })

    const ended = within(await screen.findByTestId(`run-card-${id}`)).getByTestId('ladder')

    expect(ended.querySelector('.rk-mod-right')?.textContent).toBe('as it ran · cheapest first')
    expect((ended.querySelector('.rk-rung[data-rung="mid"] .rk-rung-p') as HTMLElement).textContent).toBe('$0.87 spent')
    // roko bug-8bcd98: what a provider refused of the rung's calls, apart under its spend (the lead).
    expect([...ended.querySelectorAll('.rk-rung[data-rung="mid"] .rk-rung-p')].map(p => p.textContent)).toEqual(['$0.87 spent', 'incl. $0.21 refused'])
    expect(ended.querySelectorAll('.rk-rung[data-rung="strong"] .rk-rung-p')).toHaveLength(1)
    expect(ended.textContent).toContain('glm-4.7')
    expect(ended.textContent).not.toContain('claude-sonnet-4-6')
    cleanup()
    await mountPage({ run: LADDER_RUN })

    const live = within(await screen.findByTestId(`run-card-${LADDER_RUN}`)).getByTestId('ladder')

    expect(live.querySelector('.rk-mod-right')?.textContent).toBe('roko.toml now · a rung up after 2 failed tries')
  })

  it('bug-390e4b: a provider roko went on without says so in roko’s words under the headline and on its rung', async () => {
    const id = '6d7e8f9a-0b1c-4d2e-8f3a-4b5c6d7e8f9a'
    const zai = 'zai: Insufficient balance or no resource package. Please recharge. (code 1113): recharge, or the ladder runs without it until 07:12'
    const usage = '<b>codex</b>: You’ve hit your usage limit. (code usage_limit): skipped until 09:30'
    const until = Date.now() + 30 * 60_000
    const hhmm = new Date(until).toLocaleTimeString(undefined, { hour: '2-digit', hour12: false, minute: '2-digit', second: '2-digit' }).slice(0, 5)
    const rung = (name: string, model: string, provider: string) => ({ rung: name, model, slug: model, provider, price_in: null, price_out: null, chat_ok: true, why_not: null, starts: [] })

    backend.runs = [
      ladderRow({
        run_id: id,
        state: 'succeeded',
        active: false,
        finished_at: new Date().toISOString(),
        ladder: [rung('mid', 'glm-4.7', 'zai'), rung('strong', 'gpt-5.4-mini', 'openai')],
        provider_exhausted: [
          { provider: 'codex', model: 'gpt-5.4', billing: false, reason: null, until_ms: null, detail: usage, at: null },
          { provider: 'zai', model: 'glm-4.7', billing: true, reason: 'Insufficient balance', until_ms: until, detail: zai, at: null }
        ]
      }),
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const lines = within(card).getAllByTestId('provider-out')

    // roko’s line as it is, as plain text: a provider’s words never become markup.
    expect(lines.map(line => line.textContent)).toEqual([`⊘ ${usage}`, `⊘ ${zai}`])
    expect(lines[0].innerHTML).not.toContain('<b>')
    // Its rung says the climb above it was for want of credit, not the model failing; roko’s line in its title.
    const note = within(card).getByTestId('ladder-out-mid')

    expect(note.textContent).toBe(`⊘ no credit · until ${hhmm}`)
    expect(note.getAttribute('title')).toBe(zai)
    expect(card.querySelector('[data-testid="ladder-out-strong"]')).toBeNull()
  })

  it('⌘. on a live run’s page asks to cancel it, as the cancel key does', async () => {
    backend.runs = [ladderRow(), ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)

    expect(within(card).getByRole('button', { name: 'Stop run' }).textContent).toContain('⌘.')
    act(() => {
      fireEvent.keyDown(window, { key: '.', metaKey: true })
    })
    expect(within(await screen.findByRole('dialog')).getByText('Stop this roko run?')).toBeTruthy()
  })

  it('a check prints into the stream as it runs, its newest line bright; a page opened mid-check shows what it printed so far', async () => {
    const tail = { attempt: 3, gate: 'verify[0:test]', passed: null, command: 'python -m pytest -q', exit_code: null, duration_ms: null, lines: ['$ python -m pytest -q', 'tests/test_cli.py ..'], live: true }

    backend.runs = [ladderRow({ tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T3' ? { ...t, step: 'check', step_detail: 'verify[0:test]', check_tail: tail } : t)) }), ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)
    const stream = await within(card).findByTestId('stream')
    const block = await within(stream).findByTestId('stream-check')

    expect(block.textContent).toBe('$ python -m pytest -q\ntests/test_cli.py ..')
    expect(block.querySelector('.rk-ln-new')?.textContent).toBe('tests/test_cli.py ..')

    // Over the socket, an item that waited for the rate carries the lines before it.
    const socket = await openSocket()

    push(socket, { attempt: null, gate: 'verify[0:test]', kind: 'check', line: 'tests/test_cli.py ...F', plan_id: 'tally-budgets', run_id: LADDER_RUN, tail: ['$ python -m pytest -q', 'tests/test_cli.py ..', 'tests/test_budget.py .', 'tests/test_cli.py ...F'], task_id: 'T3', ts: Date.now(), type: 'live' })
    await waitFor(() => expect(within(stream).getByTestId('stream-check').querySelector('.rk-ln-new')?.textContent).toBe('tests/test_cli.py ...F'))
    expect(within(stream).getAllByTestId('stream-check')).toHaveLength(1)
    expect(within(stream).getByTestId('stream-check').textContent).toContain('tests/test_budget.py .')
    expect(stream.textContent).toContain('checking verify[0:test]')
  })
})

describe('v3: on camera (dogfood-desktop’s test takes, round v6)', () => {
  it('the gut keeps the stream beside the sequencer: no later rule turns it back into a column', async () => {
    await mountPage()

    const css = document.head.querySelector('style[data-hermes-plugin="roko"]')?.textContent ?? ''
    // Every top-level rule for the run's overview: the last word on its display is the gut's grid.
    const rules = [...css.replace(/@container[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)]
      .filter(([, sel, body]) => /\.(roko-overview|rk-gut)(?![\w-])/.test(sel) && /(^|;)display:/.test(body))
      .map(([, sel, body]) => `${sel.trim()}{${body}}`)

    expect(rules.at(-1)).toContain('display:grid')
    expect(rules.at(-1)).toContain('grid-template-columns:minmax(0,1fr) 316px')
    expect(rules.some(r => /display:flex/.test(r))).toBe(false)
  })

  it('a climb’s row says what ended the tries below it: failed checks only when each ended on its check; else each one’s end; one try by its own why (plugin-review Q4)', async () => {
    const t0 = Date.now() - 90_000
    const id = 'a18c9d0e-1f2a-4b3c-8d4e-7f8a9b0c1d2e'
    const turnCap = { failed_check: null, key_line: null, verdict: 'turn_cap', why: 'it hit its turn cap (15 turns)' }
    const row = ladderRow({
      run_id: id,
      started_at: new Date(t0).toISOString(),
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
        t.task_id === 'T3'
          ? { ...t, climb: [tryOf(1, 'cheap', 'start', 'failed', { verdict: 'gate_failed' }), tryOf(2, 'cheap', 'retry', 'failed', turnCap), tryOf(3, 'mid', 'climb', 'running')] }
          : t.task_id === 'T5'
            ? { ...t, outcome: 'running', attempts: 2, model: 'glm-4.7', climb: [tryOf(1, 'cheap', 'start', 'failed', turnCap), tryOf(2, 'mid', 'climb', 'running')] }
            : t
      )
    })
    const route = (cursor: number, task: string, attempt: number, at: number) => ({ cursor, type: 'route_decided', group: 'loop', ring: 'L1', task_id: task, model: 'glm-4.7', attempt, ts_millis: t0 + at, text: `${task} attempt ${attempt} → glm-4.7` })

    backend.runs = [row, ...backend.runs]
    backend.eventsFor[id] = [route(10, 'T3', 3, 44_000), route(11, 'T5', 2, 60_000)]
    await mountPage({ run: id })

    const stream = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('stream')

    await waitFor(() => expect(stream.textContent).toContain('▲ up to mid · glm-4.7 · 2 tries on cheap didn’t pass: 1 check failed, 1 turn cap'))
    expect(stream.textContent).toContain('▲ up to mid · glm-4.7 · turn cap (15 turns) on cheap')
    expect(stream.textContent).not.toContain('failed checks on cheap')
  })

  it('a failed check’s row says its own try’s key line; each try’s live check starts clean, and roko’s skipped-lines note reads as a note', async () => {
    const t0 = Date.now() - 90_000
    const id = 'ab1c2d3e-4f5a-4b6c-8d7e-0f1a2b3c4d5e'
    const row = ladderRow({
      run_id: id,
      started_at: new Date(t0).toISOString(),
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
        t.task_id === 'T3'
          ? {
              ...t,
              climb: [
                tryOf(1, 'cheap', 'start', 'failed', { key_line: 'AssertionError: 2 != 0' }),
                tryOf(2, 'cheap', 'retry', 'failed', { key_line: "AssertionError: 'over budget' not found" }),
                tryOf(3, 'mid', 'climb', 'running')
              ]
            }
          : t
      )
    })
    const spawn = (cursor: number, attempt: number, model: string, at: number) => ({ cursor, type: 'agent_spawned', group: 'agent', task_id: 'T3', attempt, model, ts_millis: t0 + at, text: `T3 attempt ${attempt} on ${model}` })
    const failed = (cursor: number, at: number) => ({ cursor, type: 'gate_result', group: 'gate', task_id: 'T3', gate: 'verify[0:test]', passed: false, ts_millis: t0 + at, text: 'T3 gate verify[0:test] did not pass' })

    backend.runs = [row, ...backend.runs]
    backend.eventsFor[id] = [spawn(10, 1, 'gpt-oss-120b', 1_000), failed(11, 30_000), spawn(12, 2, 'gpt-oss-120b', 31_000), failed(13, 60_000), spawn(14, 3, 'glm-4.7', 61_000)]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const stream = await within(card).findByTestId('stream')

    await waitFor(() => expect([...stream.querySelectorAll('.rk-ln-sub')].map(l => l.textContent)).toEqual(['AssertionError: 2 != 0', "AssertionError: 'over budget' not found"]))

    // Try 2's check printed its failure; try 3's check opens on its own lines, not under try 2's.
    const socket = await openSocket()
    const line = (attempt: number, text: string, stream?: string) =>
      push(socket, { attempt, gate: 'verify[0:test]', kind: 'check', line: text, plan_id: 'tally-budgets', run_id: id, stream: stream ?? 'stdout', task_id: 'T3', ts: Date.now(), type: 'live' })

    line(2, 'Ran 3 tests')
    line(2, 'FAILED (failures=1)')
    line(3, 'Ran 3 tests')
    line(3, 'roko skipped 120 lines of this check’s output', 'roko')
    line(3, 'OK')
    await waitFor(() => expect(within(stream).getAllByTestId('stream-check')).toHaveLength(2))

    const [older, newer] = within(stream).getAllByTestId('stream-check')

    expect(older.textContent).toBe('Ran 3 tests\nFAILED (failures=1)')
    expect(newer.textContent).toBe('Ran 3 tests\nroko skipped 120 lines of this check’s output\nOK')
    expect(newer.querySelector('.rk-ln-note')?.textContent).toBe('roko skipped 120 lines of this check’s output\n')
    expect(newer.querySelector('.rk-ln-new')?.textContent).toBe('OK')
  })

  it('the ticker says only what runs now, under the model of the try it came from; words show their inline markdown, never as HTML', async () => {
    const id = 'bc2d3e4f-5a6b-4c7d-8e9f-1a2b3c4d5e6f'
    // T3 passed on mid; T5 runs on cheap.
    const row = ladderRow({
      run_id: id,
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
        t.task_id === 'T3'
          ? { ...t, outcome: 'passed', climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'failed'), tryOf(3, 'mid', 'climb', 'passed')] }
          : t.task_id === 'T5'
            ? { ...t, outcome: 'running', attempts: 1, model: 'gpt-oss-120b', climb: [tryOf(1, 'cheap', 'start', 'running')] }
            : t
      )
    })

    backend.runs = [row, ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const socket = await openSocket()
    const now = Date.now()

    push(socket, { attempt: 1, kind: 'tool', plan_id: 'tally-budgets', run_id: id, target: 'tally/report.py', task_id: 'T5', tool: 'Read', ts: now - 2_000, type: 'live' })
    // T3's steps arrive late, after T3 passed: not news.
    push(socket, { attempt: 3, kind: 'tool', plan_id: 'tally-budgets', run_id: id, target: 'tally/cli.py', task_id: 'T3', tool: 'Edit', ts: now - 1_000, type: 'live' })

    const horizon = await within(card).findByTestId('horizon')

    await waitFor(() => expect(horizon.textContent).toContain('T5 Read tally/report.py'))
    expect(horizon.textContent).not.toContain('tally/cli.py')
    expect(horizon.querySelector('.rk-horizon-who')?.textContent).toBe('gpt-oss-120b')

    // The agent's words: bold and code as such, the markers gone, no HTML.
    push(socket, { attempt: 1, kind: 'text', plan_id: 'tally-budgets', run_id: id, said: 'All requirements are met: 1. **Import**: `from tally import report` <b>x</b>', task_id: 'T5', text: '', ts: now, type: 'live' })

    const words = await within(card).findByTestId('stream-words')

    await waitFor(() => expect(words.querySelector('b')?.textContent).toBe('Import'))
    expect(words.querySelector('code')?.textContent).toBe('from tally import report')
    expect(words.textContent).not.toContain('**')
    expect(words.textContent).toContain('<b>x</b>')
    expect(horizon.querySelector('.rk-said b')?.textContent).toBe('Import')

    // A newer try's first step: the older try's words are no longer the news.
    push(socket, { attempt: 2, kind: 'tool', plan_id: 'tally-budgets', run_id: id, target: 'tests/test_report.py', task_id: 'T5', tool: 'Read', ts: now + 1_000, type: 'live' })
    await waitFor(() => expect(horizon.textContent).toContain('T5 Read tests/test_report.py'))
    expect(horizon.textContent).not.toContain('Import')
    // The stream keeps what try 1 said, in the past tense and without a live cursor.
    await waitFor(() => expect(within(card).getByTestId('stream-words').getAttribute('data-past')).toBe('true'))
    expect(within(card).getByTestId('stream-words').textContent).toContain('T5 said')
    expect(within(card).getByTestId('stream-words').querySelector('.rk-cursor')).toBeNull()
  })

  it('P-37: with two tasks at work the words show the stretch that grew last, held 2 s so they do not flicker', async () => {
    const id = 'cd3e4f5a-6b7c-4d8e-9f0a-2b3c4d5e6f70'
    const row = ladderRow({
      run_id: id,
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
        t.task_id === 'T2' ? { ...t, outcome: 'running', attempts: 1, climb: [tryOf(1, 'cheap', 'start', 'running')] } : t
      )
    })

    backend.runs = [row, ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const socket = await openSocket()
    const now = Date.now()
    const frame = (task: string, attempt: number, kind: string, ago: number, said = '') => ({ attempt, kind, plan_id: 'tally-budgets', run_id: id, said, target: '', task_id: task, text: '', tool: kind === 'tool' ? 'Read' : '', ts: now - ago, type: 'live' })
    const shown = () => within(card).getByTestId('stream-words').textContent ?? ''

    push(socket, frame('T3', 3, 'reasoning', 12_000, 'T3 starts on the CLI'))
    push(socket, frame('T2', 1, 'reasoning', 9_000, 'T2 reads the summary'))
    await waitFor(() => expect(shown()).toContain('T2 reads the summary'))
    // T2 calls a tool; T3 thinks on, its words growing in the entry it began 12 s ago.
    push(socket, frame('T2', 1, 'tool', 8_000))
    push(socket, frame('T3', 3, 'reasoning', 5_000, 'T3 starts on the CLI, then the flags'))
    await waitFor(() => expect(shown()).toContain('T3 starts on the CLI, then the flags'))
    // T2 speaks again half a second later: T3, still growing, holds the strip.
    push(socket, frame('T2', 1, 'reasoning', 4_500, 'T2 again'))
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(shown()).toContain('T3 starts on the CLI, then the flags')
    // T3 has said nothing for 3 s while T2 goes on: the strip follows T2.
    push(socket, frame('T2', 1, 'reasoning', 2_000, 'T2 again, about budgets'))
    await waitFor(() => expect(shown()).toContain('T2 again, about budgets'))
  })

  it('P-40: the head keeps its facts on their own lines; the stop key keeps its place by the sentence', async () => {
    const id = 'fa6b7c8d-9eaf-40b1-82c3-5e6f7a8b9ca3'
    const aside = { run_id: '82b7e069-7878-411c-b220-a3ccf08a6b86', status: 'failed', passed_tasks: ['T1'], tasks_left: ['T2', 'T3', 'T4'], resumable: false }

    backend.runs = [ladderRow({ run_id: id, session_id: 's-1', set_aside: aside }), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const head = card.querySelector('.rk-runhead') as HTMLElement

    // The head's top row is the pill, the title and when; where it came from is with when, and what it set aside
    // under it; its key sits with its sentence (design system §4.8).
    expect((head.querySelector('.rk-rc-when') as HTMLElement).textContent).toContain('from a Hermes chat')
    expect(within(head).getByTestId('set-aside').textContent).toBe('it started over: the earlier run’s progress is set aside')
    expect(within(head.querySelector('.rk-rc-keys') as HTMLElement).getByRole('button', { name: 'Stop run' })).toBeTruthy()
  })

  it('P-38: roko’s estimate counts down from when roko made it, says from when, and never goes stale', async () => {
    const id = 'ef5a6b7c-8d9e-4fa0-b1c2-4d5e6f7a8b92'
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
    const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5)
    const eta = () => within(screen.getByTestId(`run-card-${id}`)).getByTestId('card-eta').textContent

    backend.runs = [ladderRow({ run_id: id, eta_minutes: 12, eta_at: at(5) }), ...backend.runs]
    await mountPage({ run: id })
    await screen.findByTestId(`run-card-${id}`)
    expect(eta()).toBe(`~7 min left · est. ${hhmm(at(5))}`)
    cleanup()
    // 18 minutes on from roko's 12-minute estimate: past it, never a stale number.
    const old = at(18)

    backend.runs = [ladderRow({ run_id: id, eta_minutes: 12, eta_at: old }), ...backend.runs.filter(r => r.run_id !== id)]
    queryClient.removeQueries({ queryKey: ['roko', 'run', id] })
    await mountPage({ run: id })
    await screen.findByTestId(`run-card-${id}`)
    expect(eta()).toBe(`past roko’s estimate from ${hhmm(old)}`)
  })

  it('roko’s estimate as a range (roko bcce6c05c): likely and up to, from when, what it rests on, and past the likely time', async () => {
    const id = 'ef5a6b7c-8d9e-4fa0-b1c2-4d5e6f7a8b92'
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
    const hhmm = (iso: string) => new Date(iso).toTimeString().slice(0, 5)
    const note = () => within(screen.getByTestId(`run-card-${id}`)).getByTestId('card-eta')
    const show = async (fields: Record<string, unknown>) => {
      cleanup()
      backend.runs = [ladderRow({ run_id: id, ...fields }), ...backend.runs.filter(r => r.run_id !== id)]
      queryClient.removeQueries({ queryKey: ['roko', 'run', id] })
      await mountPage({ run: id })
      await screen.findByTestId(`run-card-${id}`)
    }
    const made = at(5)

    await show({ eta_minutes: 33, eta_p90_minutes: 80, eta_at: made, eta_basis: { source: 'history', tasks: 9, runs: 12 } })
    expect(note().getAttribute('title')).toBe(`~28 min left, up to 75 · est. ${hhmm(made)} · from 12 runs`)
    // The time corner is 195 px wide at 1440: a range takes two lines there, the minutes, then from when.
    expect(note().firstChild?.textContent).toBe('~28 min left, up to 75')
    expect(note().querySelector('.rk-cnote-2')?.textContent).toBe(`est. ${hhmm(made)} · from 12 runs`)
    await show({ eta_minutes: 33, eta_p90_minutes: 80, eta_at: made, eta_basis: { source: 'guess', tasks: 0, runs: 0 } })
    expect(note().getAttribute('title')).toBe(`~28 min left, up to 75 · est. ${hhmm(made)} · a guess`)
    // Past the likely time, the 90th percentile counts on.
    await show({ eta_minutes: 33, eta_p90_minutes: 87, eta_at: at(40), eta_basis: { source: 'history', tasks: 9, runs: 12 } })
    expect(note().getAttribute('title')).toBe('past roko’s likely time · up to 47 min left')
    expect(note().querySelector('.rk-cnote-2')?.textContent).toBe('up to 47 min left')
  })

  it('phase 2’s S2 stills: a running run’s spend is one figure in its row and its header', async () => {
    const id = 'de4f5a6b-7c8d-4e9f-a0b1-3c4d5e6f7a81'

    backend.runs = [ladderRow({ run_id: id, cost_usd: 0.732, max_usd: 3, progress: { total: 5, passed: 3, running: 1 } }), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(within(card).getByTestId('card-spent').querySelector('svg')?.getAttribute('data-value')).toBe('$0.73'))
    // On Runs, its card reads the same figure.
    fireEvent.click(screen.getByTestId('crumb-runs'))

    const home = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(within(home).getByTestId('card-spent').querySelector('svg')?.getAttribute('data-value')).toBe('$0.73'))
  })

  it('the chat plan card keeps a task id on one line', async () => {
    await mountPage()

    const css = document.head.querySelector('style[data-hermes-plugin="roko"]')?.textContent ?? ''

    expect(css).toContain('.roko-taskchip-head>.roko-mono{flex:none;white-space:nowrap}')
    // The instrument's notes stay on one line at 1440: the NOW corner is cut with …, never wrapped.
    expect(css).toContain('.rk-disp .rk-cnote{flex-wrap:nowrap')
    expect(css).toContain('.rk-disp-scope>.rk-mod,.rk-disp-scope>.rk-cnote{flex:none}')
  })

  it('the stream keeps following when a check prints many lines at once; only the person’s own gesture holds it, and back at the foot it follows again', async () => {
    // A run of its own: an earlier test's live lines for the ladder run stay in the plugin's live store.
    const id = 'e7f8a9b0-c1d2-4e3f-9a4b-5c6d7e8f9a0b'
    const tail = { attempt: 3, gate: 'verify[0:test]', passed: null, command: 'python -m pytest -q', exit_code: null, duration_ms: null, lines: ['$ python -m pytest -q'], live: true }

    backend.runs = [ladderRow({ run_id: id, tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T3' ? { ...t, step: 'check', step_detail: 'verify[0:test]', check_tail: tail } : t)) }), ...backend.runs]
    await mountPage({ run: id })

    const stream = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('stream')
    const log = within(stream).getByTestId('stream-lines')
    // jsdom lays nothing out: the log's window is 100 px tall, and each line in it 20 px.
    let top = 0
    const height = () => Math.max(100, log.querySelectorAll('.rk-ln, .rk-ln-out > span').length * 20)
    const foot = () => height() - 100 - top
    const jump = () => within(stream).queryByRole('button', { name: 'jump to latest ↓' })

    Object.defineProperty(log, 'clientHeight', { configurable: true, get: () => 100 })
    Object.defineProperty(log, 'scrollHeight', { configurable: true, get: height })
    Object.defineProperty(log, 'scrollTop', {
      configurable: true,
      get: () => top,
      set: (v: number) => {
        top = Math.max(0, Math.min(v, height() - 100))
      }
    })

    const socket = await openSocket()
    const print = (n: number) =>
      push(socket, { attempt: 3, gate: 'verify[0:test]', kind: 'check', line: `line ${n}`, plan_id: 'tally-budgets', run_id: id, tail: ['$ python -m pytest -q', ...Array.from({ length: n }, (_, i) => `line ${i + 1}`)], task_id: 'T3', ts: Date.now(), type: 'live' })

    // A check prints many lines at once: the log grows under its window, and the scroll that comes with it finds the
    // foot far away. Lines that grew never hold the log: it follows them.
    print(40)
    await waitFor(() => expect(within(stream).getByTestId('stream-check').querySelector('.rk-ln-new')?.textContent).toBe('line 40'))
    fireEvent.scroll(log)
    await waitFor(() => expect(foot()).toBe(0))
    expect(jump()).toBeNull()

    // The person turns the wheel up: the log holds where they put it as lines arrive, and offers the way back.
    fireEvent.wheel(log, { deltaY: -400 })
    log.scrollTop = 0
    fireEvent.scroll(log)
    await waitFor(() => expect(jump()).toBeTruthy())
    print(60)
    await waitFor(() => expect(within(stream).getByTestId('stream-check').querySelector('.rk-ln-new')?.textContent).toBe('line 60'))
    expect(top).toBe(0)

    // Back at the foot by their own hand: it follows again, once the hand rests (a gesture's scroll is never fought).
    fireEvent.wheel(log, { deltaY: 4_000 })
    log.scrollTop = 1e6
    fireEvent.scroll(log)
    await waitFor(() => expect(jump()).toBeNull())
    await act(() => new Promise(resolve => setTimeout(resolve, 850)))
    push(socket, { attempt: 3, kind: 'tool', plan_id: 'tally-budgets', run_id: id, target: 'tally/cli.py', task_id: 'T3', tool: 'Read', ts: Date.now(), type: 'live' })
    await waitFor(() => expect(stream.textContent).toContain('Read tally/cli.py'))
    await waitFor(() => expect(foot()).toBe(0))

    // A press on the log listens for its end on the window, and takes every such listener off when it ends: none is
    // left behind, press after press (plugin-review's nit).
    const added = vi.spyOn(window, 'addEventListener')
    const removed = vi.spyOn(window, 'removeEventListener')
    const ends = (spy: typeof added) => spy.mock.calls.filter(([type]) => type === 'pointerup' || type === 'pointercancel').length

    for (let i = 0; i < 3; i += 1) {
      fireEvent.pointerDown(log)
      fireEvent.pointerUp(window)
    }

    expect(ends(added)).toBeGreaterThanOrEqual(3)
    expect(ends(added) - ends(removed)).toBe(0)
    added.mockRestore()
    removed.mockRestore()
  })
})

describe('P-1: a run the chat cancelled (dogfood Run 4)', () => {
  it('says who cancelled it and why, on its page and on its chat card: “cancelled from chat: <reason>”, as text', async () => {
    const id = 'c3ae1f2a-3b4c-4d5e-8f6a-9b0c1d2e3f4a'

    backend.runs = [
      {
        ...ladderRow({ run_id: id }),
        state: 'cancelled',
        active: false,
        cancelled_by: { by: 'chat', reason: 'the person asked to stop it <b>now</b>', at: new Date().toISOString() },
        why: { summary: 'The run was cancelled while T3 ran. T1, T2 and T4 had passed.' }
      },
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    const why = await within(card).findByTestId('why')

    // Who cancelled it and why first; roko's own summary kept under it: what roko had done before the cancel.
    expect(within(why).getByTestId('why-cancel').textContent).toBe('cancelled from chat: the person asked to stop it <b>now</b>')
    expect(why.textContent).toContain('The run was cancelled while T3 ran. T1, T2 and T4 had passed.')
    expect(why.textContent.indexOf('cancelled from chat')).toBeLessThan(why.textContent.indexOf('The run was cancelled while T3 ran'))
    expect(why.querySelector('b')).toBeNull()

    cleanup()
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${id}"}`} />)
    expect((await screen.findByText(/cancelled from chat: the person asked to stop it/)).textContent).toContain('cancelled from chat: the person asked to stop it <b>now</b>')
  })
})

describe('v3: accessibility (spec §8)', () => {
  it('F5: the stream is a quiet log; a hidden status says its newest row at most once every 2 s, the newest winning', async () => {
    const id = 'f07b8c9d-0e1f-4a2b-9c3d-6e7f8a9b0c1d'

    backend.eventsFor[id] = []
    backend.runs = [ladderRow({ run_id: id }), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const stream = await within(card).findByTestId('stream')

    // The log is read on demand, never announced as it grows.
    expect(within(stream).getByRole('log').getAttribute('aria-live')).toBe('off')

    const said = within(stream).getByTestId('stream-said')

    expect(said.getAttribute('role')).toBe('status')

    // Every change of what the status says, with its time.
    const changes: number[] = []
    const watch = new MutationObserver(() => changes.push(Date.now()))

    watch.observe(said, { characterData: true, childList: true, subtree: true })

    const socket = await openSocket()
    const read = (n: number) => push(socket, { attempt: 3, kind: 'tool', plan_id: 'tally-budgets', run_id: id, target: `tally/file${n}.py`, task_id: 'T3', tool: 'Read', ts: Date.now(), type: 'live' })

    read(1)
    await waitFor(() => expect(said.textContent).toBe('T3 Read tally/file1.py'))
    read(2)
    read(3)
    await new Promise(resolve => setTimeout(resolve, 300))
    // Within its 2 s it still says the first; then the newest, never the one in between.
    expect(said.textContent).toBe('T3 Read tally/file1.py')
    await waitFor(() => expect(said.textContent).toBe('T3 Read tally/file3.py'), { timeout: 3_000 })
    watch.disconnect()
    expect(changes.length).toBeGreaterThanOrEqual(2)
    changes.slice(1).forEach((at, i) => expect(at - changes[i]).toBeGreaterThanOrEqual(1_900))
  })

  it('F5: the status says a row as it reads on screen: a failed check with its key line after a colon', async () => {
    const t0 = Date.now() - 60_000
    const id = 'b29d0e1f-2a3b-4c4d-9e5f-8a9b0c1d2e3f'

    backend.runs = [ladderRow({ run_id: id, started_at: new Date(t0).toISOString() }), ...backend.runs]
    backend.eventsFor[id] = [{ cursor: 20, type: 'gate_result', group: 'gate', task_id: 'T3', gate: 'verify[0:test]', passed: false, ts_millis: t0 + 41_000, text: 'T3 gate verify[0:test] failed' }]
    await mountPage({ run: id })

    const stream = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('stream')

    await waitFor(() => expect(within(stream).getByTestId('stream-said').textContent).toBe("T3 ✕ verify[0:test] did not pass: AssertionError: 'food  50.00' != 'food  $50.00'"))
  })

  it('F9: with no new data, no text a screen reader is told about changes: clocks sit in marquees and timers', async () => {
    const id = 'e5c03b4c-5d6e-4f7a-8b8c-1d2e3f4a5b6c'

    backend.eventsFor[id] = []
    backend.runs = [ladderRow({ run_id: id }), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const socket = await openSocket()

    // A move five seconds ago: the horizon shows it with its clock ticking.
    push(socket, { attempt: 3, kind: 'tool', plan_id: 'tally-budgets', run_id: id, target: 'tally/cli.py', task_id: 'T3', tool: 'Read', ts: Date.now() - 5_000, type: 'live' })
    await waitFor(() => expect(within(card).getByTestId('horizon').textContent).toContain('Read tally/cli.py'))
    // Let the stream's status say it, once.
    await new Promise(resolve => setTimeout(resolve, 2_100))

    const quiet = '[aria-live="off"],[role="marquee"],[role="timer"]'
    const told = () =>
      [...document.querySelectorAll('[role="status"],[role="alert"],[role="log"],[aria-live="polite"],[aria-live="assertive"]')]
        .filter(el => !el.closest(quiet))
        .map(el => {
          const copy = el.cloneNode(true) as HTMLElement

          copy.querySelectorAll(quiet).forEach(node => node.remove())

          return copy.textContent
        })
    const before = told()

    await new Promise(resolve => setTimeout(resolve, 3_000))
    expect(told()).toEqual(before)
  })

  it('F6: under prefers-contrast: more, content leaves the dim ramp and hairlines become 1.5 px', async () => {
    await mountPage()

    const css = document.head.querySelector('style[data-hermes-plugin="roko"]')?.textContent ?? ''
    const at = css.search(/@media \(prefers-contrast: ?more\)/)

    expect(at).toBeGreaterThanOrEqual(0)

    const rules = css.slice(at, at + 900)

    expect(rules).toContain('--ph-dim:var(--ph-ink)')
    expect(rules).toContain('--ph-label:var(--ph-ink)')
    expect(rules).toContain('--rk-ink-3:var(--rk-ink-2)')
    expect(rules).toContain('--rk-ink-4:var(--rk-ink-2)')
    expect(rules).toContain('1.5px')
  })
})

describe('v3: Plans (spec §5.5)', () => {
  it('a mori import gathers in a group of its own, “From mori”; a row’s tags never truncate: its long id gives way first', async () => {
    await reloadPlugin()
    backend.plans = [
      ...backend.plans,
      { id: 'pocket-sequencer', title: 'Plan PQ-1 — pocket-sequencer', task_count: 5, tasks_done: 0, status: 'ready', imported_from: { kind: 'mori', plan: 'PQ-1' } }
    ]
    await mountPage()
    openTab(/^Plans/)

    const rows = await screen.findByRole('list', { name: 'roko plans' })

    expect([...rows.querySelectorAll('.roko-list-section')].map(section => section.firstChild?.textContent).at(-1)).toBe('From mori')

    // Its group says where it came from: its row needs no tag to be cut.
    const row = within(rows).getByText('Plan PQ-1 — pocket-sequencer').closest('[role="listitem"]') as HTMLElement

    expect(within(row).queryByText('from mori')).toBeNull()

    // A tag in a row's meta line never shrinks; the mono id is what gives way, with an ellipsis.
    const css = document.head.querySelector('style[data-hermes-plugin="roko"]')?.textContent ?? ''

    expect(css).toContain('.roko-row-meta>span{flex:none}')
    expect(css).toContain('.roko-row-meta>.roko-mono{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}')
  })

  it('R7: roko’s estimate in the sheet’s estimate block: per task, the plan’s likely, worst and cap, the worst over the cap in orange, unpriced tasks, what it rests on', async () => {
    backend.planExtra['add-tests'] = {
      estimate: { total_cost_usd: 0.0267, total_duration_secs: 30, confidence: 'low', likely_usd: 0.19, worst_usd: 1.29, cap_usd: 0.25, unpriced_tasks: ['T3'], start_rung: 'cheap', by_rung: [{ rung: 'cheap', model: 'gpt-oss-120b', tasks: ['T1', 'T2'], likely_usd: 0.12 }] },
      tasks: {
        T1: {
          start_rung: 'cheap',
          estimate: { likely_usd: 0.05, likely_secs: 40, worst_usd: 0.32, worst_rungs: ['cheap', 'mid', 'strong'], first_try_rate: 0.7, basis: 'same_tier', samples: 12 },
          acceptance: [{ id: 'AC1', text: 'tokens round-trip', checks: [], source_checks: [] }],
          verify: []
        }
      }
    }
    await mountPage()

    const card = await openPlan('add-tests')
    const est = within(card).getByTestId('plan-estimate')

    expect(est.textContent).toBe('likely $0.19 · worst $1.29 for the priced tasks · 1 task unpriced · cap $0.25 · the worst case is over the cap: roko stops at $0.25 · roko’s estimate, from similar past tries · low confidence')
    expect(est.querySelector('.rk-est-over')?.textContent).toBe(' · the worst case is over the cap: roko stops at $0.25')
    expect(within(card).getByTestId('task-estimate-T1').textContent).toBe('starts on cheap · likely $0.05 · worst $0.32')
  })

  it('F10: the estimate says what it rests on as roko gives it: a mix with its defaults is “partly from its defaults”, never “similar past tries”; low confidence said', async () => {
    const est = (basis: string) => ({ likely_usd: 0.05, likely_secs: 40, worst_usd: 0.32, worst_rungs: ['cheap', 'mid'], first_try_rate: 0.7, basis, samples: 4 })

    backend.planExtra['add-tests'] = {
      estimate: { total_cost_usd: 0.03, total_duration_secs: 30, confidence: 'low', likely_usd: 0.15, worst_usd: 0.96, cap_usd: 1, unpriced_tasks: [], start_rung: 'cheap', by_rung: null },
      tasks: { T1: { estimate: est('same_tier'), acceptance: [{ id: 'AC1', text: 'a', checks: [], source_checks: [] }] }, T2: { estimate: est('defaults') }, T3: { estimate: est('any_task') } }
    }
    await mountPage()

    const card = await openPlan('add-tests')
    const text = within(card).getByTestId('plan-estimate').textContent

    expect(text).toBe('likely $0.15 · worst $0.96 · cap $1.00 · roko’s estimate, partly from its defaults · low confidence')
    expect(text).not.toContain('similar past tries')
  })

  it('also required, not checked automatically: under a task’s checked criteria, as text; the review task judges them when the plan says so; nothing when there are none', async () => {
    backend.planExtra['add-tests'] = {
      tasks: {
        T1: {
          acceptance: [{ id: 'AC1', text: 'tokens round-trip', checks: [], source_checks: [] }],
          also_required: ['The README mentions --since', 'Help text lists it <b>bold</b>'],
          also_required_judged_in_review: true
        },
        T2: { acceptance: [{ id: 'AC1', text: 'parses', checks: [], source_checks: [] }], also_required: [], also_required_judged_in_review: false }
      }
    }
    await mountPage()

    const card = await openPlan('add-tests')
    const also = within(card).getByTestId('also-required-T1')

    expect(also.querySelector('.rk-also-k')?.textContent).toBe('also required · not checked automatically · the review task judges these')
    expect([...also.querySelectorAll('li')].map(li => li.textContent)).toEqual(['The README mentions --since', 'Help text lists it <b>bold</b>'])
    expect(also.querySelector('b')).toBeNull()
    expect(within(card).queryByTestId('also-required-T2')).toBeNull()
  })

  it('also required shows in the task’s own panel too, and on a plan whose criteria are all unchecked', async () => {
    backend.planExtra['add-tests'] = {
      tasks: { T1: { also_required: ['The README mentions --since'], also_required_judged_in_review: false }, T2: { also_required: [] } }
    }
    await mountPage()

    const card = await openPlan('add-tests')

    // No task has a checked criterion: the tasks list says what no check proves all the same.
    expect([...within(card).getByTestId('also-required-T1').querySelectorAll('li')].map(li => li.textContent)).toEqual(['The README mentions --since'])

    // roko takes the block out of the task's description: its own panel says it.
    fireEvent.click(card.querySelector('.roko-node[data-node="T1"]') as HTMLElement)
    const also = await within(card).findByTestId('task-also-required')

    expect(also.querySelector('.rk-also-k')?.textContent).toBe('also required · not checked automatically')
    expect([...also.querySelectorAll('li')].map(li => li.textContent)).toEqual(['The README mentions --since'])

    fireEvent.click(card.querySelector('.roko-node[data-node="T2"]') as HTMLElement)
    await within(card).findByRole('region', { name: 'Task T2' })
    expect(within(card).queryByTestId('task-also-required')).toBeNull()
  })

  it('a plan document keeps its lists’ shape: wrapped lines join their item, sub-items nest, code inside bold stays code; the checks it did not keep say why', async () => {
    backend.planExtra['add-tests'] = {
      doc: { markdown: '## What to build\n\n1. **`lexer.rs`: `Token`**\n   - covers every kind,\n     EOF included\n   - never panics\n\n2. **`parser.rs`**\n\n## Then\n\n3. fuzz it\n4. ship it\n', truncated: false },
      dropped_checks: [{ id: 'SC3', reason: 'needs a person to judge it' }],
      tasks: { T1: { start_rung: 'cheap' } }
    }
    await mountPage()

    const card = await openPlan('add-tests')
    const doc = await within(card).findByTestId('plan-doc')
    const items = (doc.querySelector('ol.rk-doc-list') as HTMLElement).querySelectorAll(':scope > li')

    expect(items).toHaveLength(2)
    expect(items[0].querySelector('b > code')?.textContent).toBe('lexer.rs')
    expect([...items[0].querySelectorAll('.rk-doc-sub > li')].map(li => li.textContent)).toEqual(['covers every kind, EOF included', 'never panics'])
    expect(doc.textContent).not.toContain('`')
    // A list keeps its own numbers.
    expect(doc.querySelectorAll('ol.rk-doc-list')[1]?.getAttribute('start')).toBe('3')
    expect(within(card).getByTestId('plan-dropped').textContent).toBe('not kept from its sourceSC3 needs a person to judge it')
    // A planned pad shows the rung its task starts on.
    expect(within(card).getByTestId('plan-graph').querySelector('.roko-node[data-node="T1"] .rk-rchip')?.textContent).toBe('cheap')
  })

  it('a mori-style plan reads as a document first: its summary, each task’s acceptance and the checks that prove it, the rubric folded, the estimate by rung', async () => {
    backend.planExtra['add-tests'] = {
      doc: {
        markdown: '# Add tests\n\nThe lexer and the parser get tests that pin their behaviour.\n\n## Quick reference\n\n- `Token` covers every kind\n- **no panics** on bad input\n\n<img src=x onerror="alert(1)">\n\n```\ncargo test -p lexer\n```',
        truncated: false
      },
      rubric: { markdown: '# Review rubric\n\n- Compiles\n- Tests pass', truncated: false, path: 'plans/add-tests/rubric.md' },
      imported_from: { kind: 'mori', plan: '08g-add-tests' },
      plan_checks: [{ name: 'plan[0:compile]', phase: 'compile', command: 'cargo build', fail_msg: null, covers: [], expect: null }],
      estimate: { total_cost_usd: 0.0267, total_duration_secs: 30, confidence: 'low', likely_usd: 0.04, worst_usd: 0.31, start_rung: 'cheap', by_rung: [{ rung: 'cheap', model: 'gpt-oss-120b', tasks: ['T1', 'T2', 'T3'], likely_usd: null }] },
      tasks: {
        T1: {
          acceptance: [
            { id: 'AC1', text: 'Every token kind round-trips through `Token::parse`', checks: ['verify[0:unit]'], source_checks: [] },
            { id: 'AC2', text: 'Bad input returns an error, never a panic', checks: ['verify[1:clippy]'], linked_by: 'quote', source_checks: [] }
          ],
          verify: [
            { name: 'verify[0:unit]', phase: 'test', command: 'cargo test -p lexer', fail_msg: 'a token kind does not round-trip', covers: ['AC1'], expect: 'fail_on_base' },
            { name: 'verify[1:clippy]', phase: 'lint', command: 'cargo clippy -p lexer', fail_msg: null, covers: [], expect: null }
          ],
          start_rung: 'cheap',
          goal: 'The lexer covers every token kind',
          section: 'Quick reference',
          non_goals: []
        }
      }
    }
    await mountPage()

    const card = await openPlan('add-tests')
    const doc = await within(card).findByTestId('plan-doc')

    expect(doc.textContent).toContain('The lexer and the parser get tests that pin their behaviour.')
    // Its own title is the card's: the document does not say it again.
    expect(doc.textContent).not.toContain('Add tests')
    expect(doc.querySelector('h4')?.textContent).toBe('Quick reference')
    expect(doc.querySelector('li code')?.textContent).toBe('Token')
    expect(doc.querySelector('li b')?.textContent).toBe('no panics')
    expect(doc.querySelector('pre')?.textContent).toBe('cargo test -p lexer')
    // The plan's markdown is untrusted: it stays text.
    expect(doc.querySelector('img')).toBeNull()
    expect(doc.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(within(card).getByTestId('plan-estimate').textContent).toBe('likely $0.04 · worst $0.31 · roko’s estimate · low confidence')

    const t1 = within(card).getByTestId('plan-tasks').querySelector('[data-task="T1"]') as HTMLElement

    const criteria = within(t1).getByRole('list', { name: 'What T1 must do' }).querySelectorAll('li')

    expect(criteria).toHaveLength(2)
    // Each criterion is followed by the check that covers it, named as a run names it.
    expect(criteria[0].textContent).toContain('AC1')
    expect(criteria[0].querySelector('.roko-checkcmd')?.textContent).toBe('verify[0:unit] cargo test -p lexer')
    expect(criteria[0].querySelector('.roko-checkcmd')?.getAttribute('title')).toContain('if it fails: a token kind does not round-trip')
    // A check the criterion only quotes (a mori import declares no coverage) is drawn dashed, and says so.
    expect(criteria[1].querySelector('.rk-accept-by')?.getAttribute('data-linked')).toBe('quote')
    expect(criteria[1].querySelector('.roko-checkcmd')?.getAttribute('title')).toMatch(/^the criterion names this check \(the plan declares no coverage\)/)
    expect(t1.textContent).toContain('verify[1:clippy] cargo clippy -p lexer')
    expect(t1.textContent).toContain('The lexer covers every token kind')
    expect(t1.textContent).toContain('§ Quick reference')
    expect(t1.querySelector('.rk-rchip')?.textContent).toBe('cheap')
    expect(within(card).getByTestId('plan-checks').textContent).toContain('plan[0:compile] cargo build')
    expect(within(card).getByTestId('plan-imported').textContent).toBe('from mori')

    const rubric = within(card).getByTestId('plan-rubric')

    expect(rubric.tagName).toBe('DETAILS')
    expect(rubric.hasAttribute('open')).toBe(false)
    expect(rubric.textContent).toContain('Tests pass')
  })

  it('one plan and nothing chosen: it is the plan, and a title roko knows only as the id is said once (dogfood U8)', async () => {
    await reloadPlugin()
    backend.plans = [{ id: 'add-tests', title: 'add-tests', task_count: 3, tasks_done: 0, status: 'ready' }]
    await mountPage()
    openTab(/^Plans/)

    expect(await screen.findByTestId('plan-card-add-tests')).toBeTruthy()
    expect(screen.queryByText('Pick a plan')).toBeNull()
    expect(screen.getByRole('list', { name: 'roko plans' }).querySelector('.roko-row-meta .roko-mono')).toBeNull()
  })
})

describe('v3: dogfood fixes (round v6)', () => {
  it('a resume says which run it resumed, and the plan’s total over its runs shows on its row and its head (U10)', async () => {
    const first = '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b'
    const resume = '3f4a5b6c-7d8e-4f9a-8b1c-2d3e4f5a6b7c'

    backend.runs = [
      { run_id: resume, kind: 'plan', label: 'Pocket synth (resume)', plan_id: 'pocket-synth', state: 'succeeded', cost_usd: 0.12, max_usd: 0.5, started_at: new Date(Date.now() - 600_000).toISOString(), resumes: first, chain: { run_ids: [first, resume], cost_usd: 0.3, progress: { total: 4, passed: 4, failed: 0, running: 0, pending: 0, blocked: 0, stopped: 0, unverified: 0 } } },
      { run_id: first, kind: 'plan', label: 'pocket-synth', plan_id: 'pocket-synth', state: 'failed', cost_usd: 0.18, max_usd: 0.5, started_at: new Date(Date.now() - 1_800_000).toISOString() },
      ...backend.runs
    ]
    await mountPage({ run: resume })

    const card = await screen.findByTestId(`run-card-${resume}`)

    expect(within(card).getByTestId('resumes').textContent).toBe('it carries on an earlier run')
    expect(within(card).getByTestId('plan-chain').textContent).toBe('this plan over 2 runs: $0.30 · 4/4 tasks passed')
    fireEvent.click(within(card).getByTestId('resumes'))
    await waitFor(() => expect(window.location.hash).toBe(`#/roko#run=${first}`))
  })

  it('a try roko ended in the agent’s place shows as a stop in roko’s words, not as the agent speaking (U2, U4)', async () => {
    const t0 = Date.now() - 30_000
    const id = '5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e'

    backend.runs = [ladderRow({ run_id: id, started_at: new Date(t0).toISOString() }), ...backend.runs]
    backend.eventsFor[id] = [{ cursor: 10, type: 'agent_output', group: 'agent', task_id: 'T3', stopped: true, ts_millis: t0 + 9_000, text: 'T3 stopped: it hit its turn cap (12 turns)' }]
    await mountPage({ run: id })

    const stream = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('stream')

    await waitFor(() => expect(stream.querySelector('.rk-ln[data-kind="stopped"]')?.textContent).toContain('■ stopped: it hit its turn cap (12 turns)'))
    expect(stream.querySelector('.rk-ln[data-kind="stopped"]')?.getAttribute('data-tone')).toBe('fail')
  })

  it('a trusted run’s tool step shows once, not as its screened step and then the call’s end (U5)', async () => {
    const t0 = Date.now() - 30_000
    const id = '4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d'

    backend.runs = [ladderRow({ run_id: id, started_at: new Date(t0).toISOString() }), ...backend.runs]
    backend.eventsFor[id] = [
      { cursor: 10, type: 'agent_output', group: 'tool', ring: 'L0', task_id: 'T3', tool: 'read_file', target: 'synth/svf.py', ts_millis: t0 + 1_000, text: 'T3 read_file synth/svf.py' },
      { cursor: 11, type: 'agent_output', group: 'tool', ring: 'L0', task_id: 'T3', tool: 'read_file', target: null, ts_millis: t0 + 1_400, text: 'T3 read_file' }
    ]
    await mountPage({ run: id })

    const stream = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('stream')

    await waitFor(() => expect(stream.textContent).toContain('read_file synth/svf.py'))
    expect([...stream.querySelectorAll('.rk-ln[data-kind="tool"]')]).toHaveLength(1)
  })
})

describe('v3: the mark and sound (spec §4.12, §3.8)', () => {
  it('the empty page shows the pitch: roko’s wordmark and the workspace’s ladder with its start rung (spec §7, 0:00)', async () => {
    // A fresh page: no run picked from an earlier test.
    await reloadPlugin()
    backend.runs = []
    backend.pending = []
    backend.ladder = LADDER
    await mountPage()

    const glass = await screen.findByTestId('ladder-glass')

    // The wordmark replaces the face (design system §5.1): dim, nothing has run here yet.
    expect(glass.querySelector('.rk-ladderglass-mark svg')?.getAttribute('data-value')).toBe('ROKO')
    expect(glass.querySelector('.rk-ladderglass-mark svg')?.getAttribute('data-tone')).toBe('dim')
    expect(document.querySelector('.rk-mark')).toBeNull()
    expect([...glass.querySelectorAll('.rk-starts-rung')].map(r => r.querySelector('.rk-starts-name')?.textContent)).toEqual(['top', 'strong', 'mid', '▸ cheap'])
    expect(glass.textContent).toContain('cheapest model first · your checks decide when it is done')
  })

  it('f is focus mode: the run alone on the page for a recording; f or Esc leaves it (spec §7)', async () => {
    await mountPage({ run: RUN_ACTIVE })
    await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    act(() => {
      fireEvent.keyDown(window, { key: 'f' })
    })
    expect(screen.getByTestId('roko-page').getAttribute('data-focus')).toBe('true')
    expect(screen.getByTestId('focus-exit').textContent).toContain('to leave')
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    expect(screen.getByTestId('roko-page').getAttribute('data-focus')).toBeNull()
  })

  it('the ladder is a scale: a task that passes on mid plays F4 and its fifth; off by default, nothing plays', async () => {
    const freqs: number[] = []

    class FakeAudio {
      currentTime = 0
      state = 'running'
      destination = {}

      createOscillator() {
        return { connect: () => undefined, frequency: { setValueAtTime: (hz: number) => freqs.push(Math.round(hz * 100) / 100) }, start: () => undefined, stop: () => undefined, type: 'sine' }
      }

      createGain() {
        return { connect: () => undefined, gain: { exponentialRampToValueAtTime: () => undefined, setValueAtTime: () => undefined } }
      }

      close() {
        return Promise.resolve()
      }
    }

    setGlobal('AudioContext', FakeAudio)

    try {
      backend.runs = [ladderRow(), ...backend.runs]
      await mountPage({ run: LADDER_RUN })
      await within(await screen.findByTestId(`run-card-${LADDER_RUN}`)).findByTestId('ladder')

      const socket = await openSocket()
      const passed = (cursor: number) => ({ lines: [{ cursor, group: 'task', task_id: 'T3', outcome: 'passed', text: 'T3 passed', ts_millis: Date.now(), type: 'task_completed' }], run_id: LADDER_RUN, type: 'lines' })

      push(socket, passed(9400))
      expect(freqs).toHaveLength(0)

      await turnSounds(true)
      freqs.length = 0
      await new Promise(resolve => setTimeout(resolve, 120))
      push(socket, passed(9401))
      // T3 stands on mid (the ladder's second rung): F4, then a fifth above.
      expect(freqs).toEqual([349.23, 523.85])
      await turnSounds(false)
    } finally {
      setGlobal('AudioContext', undefined)
    }
  })

  it('a lesson kept just now chimes, whichever of the socket or the card saw it first; one from the page’s history stays quiet', async () => {
    const freqs: number[] = []

    class FakeAudio {
      currentTime = 0
      state = 'running'
      destination = {}

      createOscillator() {
        return { connect: () => undefined, frequency: { setValueAtTime: (hz: number) => freqs.push(Math.round(hz * 100) / 100) }, start: () => undefined, stop: () => undefined, type: 'sine' }
      }

      createGain() {
        return { connect: () => undefined, gain: { exponentialRampToValueAtTime: () => undefined, setValueAtTime: () => undefined } }
      }

      close() {
        return Promise.resolve()
      }
    }

    setGlobal('AudioContext', FakeAudio)

    // Sounds were switched off after the last test that played them, which let its audio context go: this one plays.
    let on = false

    try {
      backend.pending = []
      backend.runs = [ladderRow(), ...backend.runs]
      await mountPage({ run: LADDER_RUN })
      await within(await screen.findByTestId(`run-card-${LADDER_RUN}`)).findByTestId('ladder')
      await turnSounds(true)
      on = true
      await new Promise(resolve => setTimeout(resolve, 120))
      freqs.length = 0

      const socket = await openSocket()
      const lesson = (key: string, ts: number) => ({ data: { admission: 'light_admitted', entry_id: key }, key, kind: 'knowledge', plan_id: 'tally-budgets', ring: 'L3', run_id: LADDER_RUN, task_id: 'T1', text: 'T1: kept a new lesson', ts, type: 'loop' })

      // A lesson of the page's history (an hour old): quiet.
      push(socket, lesson('knowledge:tally:T1:old', Date.now() - 3_600_000))
      expect(freqs).toEqual([])
      // One kept just now: the glass chime.
      push(socket, lesson('knowledge:tally:T1:new', Date.now()))
      expect(freqs).toEqual([1600, 2400])
    } finally {
      // Sounds go back off for the tests after this one, whatever happened above.
      if (on) {
        await turnSounds(false)
      }

      setGlobal('AudioContext', undefined)
    }
  })
})

describe('v3: the composer (spec §5.7, mockup 04)', () => {
  it('where it starts: the ladder with the start rung, how far it can climb before the cap stops it, and roko’s estimate when it has one', async () => {
    backend.ladder = LADDER.map(r => (r.rung === 'cheap' ? { ...r, priced_by: 'snapshot', price_snapshot: 'prices-2026-09-28' } : r))
    // 0.6.0 P7, as docs/ui-api.md gives it.
    backend.estimate = {
      start_rung: 'cheap',
      climb: ['cheap', 'mid', 'strong'],
      ladder: null,
      likely: { usd: 0.02, seconds: 60 },
      worst_usd: 0.31,
      max_usd: 0.5,
      stops_at_cap: false,
      similar: { runs: 23, tasks: 23, first_try: 16, first_try_rate: 0.7, p90_usd: 0.06 },
      checks: [{ name: 'verify[0:test]', phase: 'test', command: 'python3 -m unittest discover -s tests', source: 'roko.toml' }],
      basis: '≈ the median of 23 similar runs Hermes started here',
      confidence: 'medium'
    }
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const form = await screen.findByRole('dialog')
    const panel = await within(form).findByTestId('where-it-starts')

    expect(panel.querySelector('.rk-starts-rung[data-start="true"]')?.textContent).toContain('▸ cheap')
    // Where a rung's prices come from (roko's price snapshot), on hover.
    expect(panel.querySelector('.rk-starts-rung[data-start="true"] .rk-starts-price')?.getAttribute('title')).toBe("priced by roko's price snapshot prices-2026-09-28")
    expect(panel.querySelector('.rk-starts-rung[data-off="true"]')?.textContent).toContain('not for chat runs')
    // Asked as the composer opens: the cap starts at the smallest detent over what 9 in 10 similar runs cost.
    await waitFor(() => expect(within(panel).getByTestId('starts-rule').textContent).toBe('2 failed tries → a rung up, at most to strong. The $0.25 cap stops it before it spends past it.'))
    expect(within(panel).getByRole('img', { name: 'likely about $0.02' })).toBeTruthy()
    expect(within(panel).getByTestId('starts-likely').textContent).toContain('about a minute · cheap rung')
    expect(within(panel).getByTestId('starts-basis').textContent).toBe('≈ the median of 23 similar runs Hermes started here')
    expect(within(panel).getByTestId('starts-similar').textContent).toBe('23 similar tasks: 70% passed on the first try.')
    expect(within(panel).getByRole('list', { name: 'The checks roko will run' }).textContent).toContain('testpython3 -m unittest discover -s testsroko.toml')
    // The person's cap is theirs: a worst case under it says so, and the estimate no longer moves it.
    fireEvent.change(within(form).getByLabelText('Spend cap'), { target: { value: '0.50' } })

    const ask = 'Add a --since DATE flag to tally report, with a test'

    fireEvent.change(within(form).getByRole('textbox', { name: /What should roko do/ }), { target: { value: ask } })
    await waitFor(() => expect(within(panel).getByTestId('starts-rule').textContent).toBe('2 failed tries → a rung up, at most to strong. At worst ≈ $0.31, under the $0.50 cap.'))
    // The estimate is asked with the request's length, never its words: a URL ends up in logs (plugin-review Q5).
    await waitFor(() => expect(called('GET', `/estimate?chars=${ask.length}&domain=code`)).toBe(true), { timeout: 2_000 })
    expect(api.mock.calls.some(([req]) => String(req.path).includes('/estimate') && String(req.path).includes('prompt'))).toBe(false)
    await new Promise(r => setTimeout(r, 700))
    expect((within(form).getByLabelText('Spend cap') as HTMLInputElement).value).toBe('0.50')
    // The cap is this surface's one bone number.
    expect(form.querySelector('.rk-cap-well .rk-dots')?.getAttribute('data-tone')).toBe('bone')
    // The composer is the page's: closed, it leaves the next view clear.
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('where it starts says a run with no check ends unverified, and shows what the estimate rests on when it has nothing to go by', async () => {
    backend.ladder = LADDER
    backend.estimate = {
      start_rung: 'cheap',
      climb: ['cheap', 'mid', 'strong'],
      ladder: null,
      likely: null,
      worst_usd: null,
      max_usd: 0.5,
      stops_at_cap: true,
      similar: null,
      checks: [],
      basis: 'nothing to go by yet: no run has ended in this workspace',
      confidence: 'low'
    }
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const form = await screen.findByRole('dialog')
    const panel = await within(form).findByTestId('where-it-starts')

    await waitFor(() => expect(within(panel).getByTestId('starts-rule').textContent).toBe('roko found no check to run, so it never climbs: the run ends unverified. The $0.50 cap stops it before it spends past it.'))
    expect(within(panel).getByTestId('starts-basis').textContent).toBe('nothing to go by yet: no run has ended in this workspace')
    expect(within(panel).queryByTestId('starts-likely')).toBeNull()
    expect(within(panel).queryByTestId('starts-similar')).toBeNull()
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
})

describe('v3: the route and escalation sheet (spec §5.3, mockup 02)', () => {
  const climbing = () =>
    ladderRow({
      run_id: '0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e',
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
        t.task_id === 'T3'
          ? {
              ...t,
              climb: [
                tryOf(1, 'cheap', 'start', 'failed', { key_line: "error: argument cmd: invalid choice: 'budget'", verdict: 'gate_failed', why: 'its check verify[0:test] failed' }),
                tryOf(2, 'cheap', 'retry', 'failed', { verdict: 'gate_failed', why: 'its check verify[0:test] failed' }),
                tryOf(3, 'mid', 'climb', 'running', {
                  cost_usd: 0.018,
                  prompt: { lessons: [{ id: 'k-cents', text: 'Amounts are integer cents everywhere; print them with format_cents().', confidence: 0.8, citations: 3, kept_by: 'T1' }], playbook_ids: [], episodes: 0, left_out: [], sections: [], dropped_sections: [], estimated_tokens: null },
                  feedback: { from_attempt: 2, check: 'verify', failing_steps: ['verify[0:test] (`python3 -m unittest`): exit code: 1'], diagnosis: 'test_budget_set expects "$" before the amount: render_summary prints the cents without it.', errors: ["AssertionError: 'food  50.00' != 'food  $50.00'"] }
                })
              ]
            }
          : t
      )
    })

  it('a pad opens its sheet: the task’s climb on its own ladder, what its prompt carried, what try 2 told try 3, the cost of each try', async () => {
    const row = climbing()

    backend.runs = [row, ...backend.runs]
    await mountPage({ run: String(row.run_id) })

    const card = await screen.findByTestId(`run-card-${row.run_id}`)

    await waitFor(() => expect(card.querySelector('.roko-node[data-node="T3"]')).toBeTruthy())
    fireEvent.click(card.querySelector('.roko-node[data-node="T3"]') as HTMLElement)

    const sheet = await within(card).findByTestId('inspector-T3')

    expect(sheet.classList.contains('rk-sheet')).toBe(true)
    expect(sheet.querySelector('.roko-inspector-head')?.textContent).toContain('climbed')
    expect(within(sheet).getByText(/^try 3 of up to 6/)).toBeTruthy()

    // 01 CLIMB: each try on the rung it ran on, the next rung's condition, the rung chats cannot use.
    const climb = within(sheet).getByTestId('climb')
    const rung = (name: string) => climb.querySelector(`.rk-climb-rung[data-rung="${name}"]`) as HTMLElement

    expect([...climb.querySelectorAll('.rk-climb-rung')].map(r => r.getAttribute('data-rung'))).toEqual(['top', 'strong', 'mid', 'cheap'])
    expect([...rung('cheap').querySelectorAll('.rk-trycard')].map(c => c.getAttribute('data-testid'))).toEqual(['try-1', 'try-2'])
    expect(within(rung('mid')).getByTestId('try-3').textContent).toContain('▲ up from cheap')
    expect(rung('strong').textContent).toContain('○○ next, if mid fails its check twice')
    expect(rung('top').textContent).toContain('not for chat runs: its agent runs its own tools')
    expect(climb.textContent).toContain('roko moves a task up one rung after 2 tries on it did not pass (a failed check, or a try that spent its rung’s allowance), at most 2 rungs.')

    // 02 IN ITS PROMPT: the lesson it carried, and what try 2's check told it, in orange.
    const prompt = within(sheet).getByTestId('in-its-prompt')

    expect(prompt.textContent).toContain('Amounts are integer cents everywhere; print them with format_cents().')
    expect(prompt.textContent).toContain('kept by T1 of this run · confirmed 3 times')
    expect(within(prompt).getByTestId('retry-feedback').textContent).toContain('what try 2’s check told try 3')
    expect(within(prompt).getByTestId('retry-feedback').textContent).toContain('render_summary prints the cents without it.')

    // 04 COST: a bar a try, the running one rose; the task's total.
    const cost = within(sheet).getByTestId('try-cost')

    expect(cost.querySelectorAll('.rk-trycost-row')).toHaveLength(3)
    expect(cost.querySelector('.rk-trycost-row[data-outcome="running"]')?.textContent).toContain('$0.02…')
    expect(within(cost).getByRole('img', { name: 'T3 cost $0.04 so far' })).toBeTruthy()

    // ↑ picks try 1: its check output, never another try's (dogfood U2); C copies its key line.
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowUp' })
    })
    act(() => {
      fireEvent.keyDown(window, { key: 'ArrowUp' })
    })
    await waitFor(() => expect(within(sheet).getByTestId('try-1').getAttribute('aria-pressed')).toBe('true'))
    expect(sheet.querySelector('.roko-keyline')?.textContent).toBe("error: argument cmd: invalid choice: 'budget'")
    expect(within(sheet).getByTestId('in-its-prompt').textContent).toContain('roko did not say what this try’s prompt carried')
    expect(sheet.querySelector('.rk-sheet-foot')?.textContent).toContain('copy the key line')
  })

  it('check output is the try’s that ran the check: a try stopped at the cap shows none, and try 2 keeps its own (the live climb take)', async () => {
    // The take's shape: tries 1 and 2 failed their check on cheap, try 3 climbed to mid and ran no check before the
    // run's cap stopped it (budget_exhausted, 776 s); the card's check_tail is try 2's, and the run's why tells of
    // the check's newest run in its own key line.
    const id = 'c3d4e5f6-a7b8-4c9d-8e0f-1a2b3c4d5e6f'
    const row = ladderRow({
      run_id: id,
      state: 'stopped',
      active: false,
      cost_usd: 0.23,
      max_usd: 0.25,
      why: {
        summary: "The run stopped: it reached its cap of $0.25, with $0.23 spent. T1's check verify[0:test] did not pass, all 2 times it ran: AssertionError: 0.022977651974189474 not greater than 0.05.",
        gates_not_passed: [{ task_id: 'T1', title: 'Add a notch output', gate: 'verify[0:test]', runs: 2, key_line: 'AssertionError: 0.022977651974189474 not greater than 0.05', output: 'FAIL: test_notch_depth\nAssertionError: 0.022977651974189474 not greater than 0.05' }],
        blocked: [],
        unverified_tasks: [],
        errors: []
      },
      tasks: [
        {
          task_id: 'T1',
          title: 'Add a notch output',
          outcome: 'stopped',
          attempts: 3,
          model: 'glm-4.7',
          gates: [{ gate: 'verify[0:test]', passed: false }],
          depends_on: [],
          check_tail: { attempt: 2, gate: 'verify[0:test]', passed: false, command: 'python3 -m unittest', exit_code: 1, duration_ms: null, lines: ['FAIL: test_notch_gain', 'AssertionError: 0.39924369334685733 not greater than 0.4'], live: false },
          climb: [
            tryOf(1, 'cheap', 'start', 'failed', { key_line: 'AssertionError: 0.2216885707588871 not less than 0.2', verdict: 'gate_failed', why: 'its check verify[0:test] failed' }),
            tryOf(2, 'cheap', 'retry', 'failed', { key_line: 'AssertionError: 0.39924369334685733 not greater than 0.4', verdict: 'gate_failed', why: 'its check verify[0:test] failed' }),
            tryOf(3, 'mid', 'climb', 'stopped', { duration_ms: 776_000, verdict: 'budget_exhausted', why: 'roko stopped it at the run’s cap' })
          ],
          lives: null
        }
      ]
    })

    backend.runs = [row, ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(card.querySelector('.roko-node[data-node="T1"]')).toBeTruthy())
    fireEvent.click(card.querySelector('.roko-node[data-node="T1"]') as HTMLElement)

    const sheet = await within(card).findByTestId('inspector-T1')
    const checkOutput = () => [...sheet.querySelectorAll('.rk-mod')].find(m => m.querySelector('.rk-mod-label')?.textContent === 'check output') ?? null

    // Try 3, the newest and the one picked, ran no check: no check output is its.
    expect(within(sheet).getByTestId('try-3').getAttribute('aria-pressed')).toBe('true')
    expect(checkOutput()).toBeNull()
    expect(sheet.querySelector('.roko-keyline')).toBeNull()
    expect(sheet.textContent).not.toContain('0.022977651974189474')

    // Try 2 ran it: its own output, labelled try 2.
    fireEvent.click(within(sheet).getByTestId('try-2'))
    await waitFor(() => expect(within(sheet).getByTestId('try-2').getAttribute('aria-pressed')).toBe('true'))
    expect(checkOutput()?.querySelector('.rk-mod-note')?.textContent).toBe('try 2 · verify[0:test] · exit 1')
    expect(sheet.querySelector('.roko-keyline')?.textContent).toBe('AssertionError: 0.39924369334685733 not greater than 0.4')
  })

  it('attempt rows say what ended each try, and name a climb (dogfood U1, U3)', async () => {
    const row = climbing()
    const tasks = (row.tasks as Array<Record<string, unknown>>).map(t =>
      t.task_id === 'T3'
        ? {
            ...t,
            attempt_log: [1, 2, 3].map(n => ({ attempt: n, model: n < 3 ? 'gpt-oss-120b' : 'glm-4.7', provider: n < 3 ? 'cerebras' : 'zai', gates: n < 3 ? [{ gate: 'verify[0:test]', passed: false }] : [] })),
            climb: (t.climb as Array<Record<string, unknown>>).map(c => (c.attempt === 2 ? { ...c, verdict: 'turn_cap', why: 'it hit its turn cap (12 turns)' } : c))
          }
        : t
    )

    // Without a ladder on the card, the sheet lists attempts as rows. A run of its own: the page keeps each run's
    // selected task.
    const id = '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a'

    backend.runs = [{ ...row, run_id: id, ladder: null, tasks }, ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(card.querySelector('.roko-node[data-node="T3"]')).toBeTruthy())
    fireEvent.click(card.querySelector('.roko-node[data-node="T3"]') as HTMLElement)

    const rows = [...(await within(card).findByTestId('inspector-T3')).querySelectorAll('.roko-pipe-row')] as HTMLElement[]

    expect(rows.map(r => r.querySelector('.roko-pipe-end')?.textContent)).toEqual(['check failed', 'turn cap', 'retrying'])
    expect(rows[1].querySelector('.roko-pipe-end')?.getAttribute('title')).toBe('it hit its turn cap (12 turns)')
    expect(rows[2].textContent).toContain('▲ mid')
  })
})

/** Mockup 03's fourteen runs: passes per rung, oldest first (cheap takes over as the lessons land). */
const HEAT = {
  strong: [1, 1, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
  mid: [2, 1, 2, 1, 1, 1, 1, 0, 1, 1, 0, 1, 0, 1],
  cheap: [1, 1, 2, 1, 2, 3, 2, 3, 4, 3, 4, 3, 5, 4]
}
const LEARNING_RUN = (i: number) => `${String(i).padStart(2, '0')}a1b2c3-0000-4000-8000-00000000000${i % 10}`
/** GET /learning as plugin-runs' 0.6.0 backend answers it (docs/ui-api.md). */
const LEARNING = {
  runs: HEAT.cheap.map((cheap, i) => ({
    run_id: LEARNING_RUN(i),
    label: `run ${i + 1}`,
    state: 'succeeded',
    finished_at: new Date(Date.UTC(2026, 9, 7 + Math.floor((i * 9) / 14), 10)).toISOString(),
    cost_usd: 0.15,
    tasks: 5,
    passed: cheap + HEAT.mid[i] + HEAT.strong[i],
    first_try: 3,
    climbs: 1,
    cost_per_pass: 0.15 / (cheap + HEAT.mid[i] + HEAT.strong[i]),
    cost_per_pass_by: 'roko',
    rungs: null,
    lessons_kept: [],
    lessons_used: []
  })),
  kpis: {
    cost_per_pass: { value: 0.031, first: 0.05, series: [50, 52, 47, 49, 44, 45, 41, 40, 38, 37, 36, 34, 33, 31].map(v => v / 1000) },
    first_try_rate: { value: 0.71, first: 0.46, series: [46, 44, 50, 52, 51, 58, 57, 61, 60, 66, 64, 69, 70, 71].map(v => v / 100) },
    climbs_per_run: { value: 0.4, first: 1.3, series: [13, 12, 14, 11, 10, 9, 9, 8, 7, 7, 6, 5, 5, 4].map(v => v / 10) }
  },
  lessons_first_try: { with: { passed: 7, of: 8, rate: 0.875 }, without: { passed: 3, of: 7, rate: 0.4286 }, design: 'control_arm', comparable: true, difference: 0.4464, note: "randomised: roko's control arm withheld the lessons from the tasks without" },
  where_passed: {
    rungs: LADDER,
    runs: HEAT.cheap.map((cheap, i) => ({ run_id: LEARNING_RUN(i), passed: { cheap, mid: HEAT.mid[i], strong: HEAT.strong[i] } })),
    cheapest_share: { first: 0.41, last: 0.78 }
  },
  lessons: [
    {
      id: 'k-cents',
      text: 'Amounts are integer cents everywhere; print them with format_cents().',
      kept_by: { run_id: 'ddf4e5b1-0000-4000-8000-000000000001', task_id: 'T1', at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      uses: [1, 2, 3, 4].map(i => ({ run_id: `ddf4e5b1-0000-4000-8000-00000000000${i}`, task_id: 'T2', first_try: true, climbed: false, passed: true })),
      first_try: 4,
      confidence: 0.8
    },
    {
      id: 'k-subparsers',
      text: "tally's CLI nests actions with add_subparsers(dest=…), one handler each.",
      kept_by: { run_id: '3c6601bf-0000-4000-8000-000000000001', task_id: 'T2', at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
      uses: [
        { run_id: 'x', task_id: 'T1', first_try: true, climbed: false, passed: true },
        { run_id: 'y', task_id: 'T1', first_try: true, climbed: false, passed: true },
        { run_id: 'z', task_id: 'T3', first_try: false, climbed: true, passed: true }
      ],
      first_try: 2,
      confidence: 0.55
    }
  ],
  homeostat: {
    variables: [
      { ev: 'pass_rate', value: 0.86, bound: 0.7, inner: 0.75, state: 'in_bounds' },
      { ev: 'usd_per_verified_success', value: 0.031, bound: 0.1, inner: null, state: 'in_bounds' },
      { ev: 'false_green', value: 0.08, bound: 0.05, inner: null, state: 'breached' },
      { ev: 'latency_p90_s', value: 48, bound: 120, inner: null, state: 'in_bounds' }
    ],
    controller: { episode_id: 'm1-7', phase: 'hold', change: null }
  }
}

describe('v3: Learning (spec §5.6, mockup 03)', () => {
  it('Learning opens on its overview: the three numbers with their trends and what drove them, where work passed, the loops, lessons that paid off, the homeostat', async () => {
    backend.learning = LEARNING
    backend.ladder = LADDER
    await mountPage()
    openTab(/^Learning/)

    const page = await screen.findByTestId('learning-overview')
    const usd = await within(page).findByTestId('kpi-usd')

    // The one bone number: what a passed task costs, against the first runs, from roko's own variable.
    expect(within(usd).getByRole('img', { name: '$0.03 per verified task' })).toBeTruthy()
    // roko's ratio of sums over every ended run, failed and stopped ones included: "per verified task" (Q2).
    expect(within(usd).getByText('cost per verified task')).toBeTruthy()
    expect(usd.textContent).toContain('↓ 38% · was $0.05 on your first runs')
    expect(usd.textContent).toContain('roko’s own figures · last 14 runs')
    expect(within(within(page).getByTestId('kpi-first')).getByRole('img', { name: '71% passed on the first try' })).toBeTruthy()
    // What drove it only from what the runs show (first tries with a lesson in the prompt, and without), never a guess.
    expect(within(page).getByTestId('kpi-first').textContent).toContain("↑ from 46% · with a lesson 7/8 passed first try, without 3/7 · +45 points · randomised: roko's control arm withheld the lessons from the tasks without")
    expect(within(page).getByTestId('kpi-climbs').querySelector('.rk-kpi2-note')?.textContent).toBe('↓ from 1.3')

    // Where work passed: rungs top first, a cell per run, the top rung hatched for chat runs, cheap taking over.
    const heat = within(page).getByTestId('where-passed')
    const rows = [...heat.querySelectorAll('.rk-heat-row[data-rung]')] as HTMLElement[]

    expect(rows.map(r => r.getAttribute('data-rung'))).toEqual(['top', 'strong', 'mid', 'cheap'])
    expect(rows[0].getAttribute('data-off')).toBe('true')
    expect(rows[3].querySelectorAll('.rk-heat-cell')).toHaveLength(14)
    expect(rows[3].querySelector('.rk-heat-cell[data-now="true"]')?.getAttribute('data-n')).toBe('4')
    expect(within(heat).getByTestId('heat-moved').textContent).toBe('cheap ↑ 41% → 78% of passes')
    expect(heat.textContent).toContain('top: not for chat runs')

    // Lessons that paid off: who kept each, and its chain of later tasks.
    const paid = within(page).getByTestId('lessons-paid')

    expect(within(paid).getByTestId('lesson-paid-k-cents').textContent).toContain('by ddf4e5b1 · T1 · in 4 prompts since')
    expect(within(paid).getByTestId('lesson-paid-k-cents').textContent).toContain('4/4 first try')
    expect(within(paid).getByTestId('lesson-paid-k-subparsers').textContent).toContain('2/3 · 1 climbed')

    // The homeostat: four meters, false green out of bounds in red, and what M1 did.
    const homeo = within(page).getByTestId('homeostat')

    expect(homeo.querySelectorAll('.rk-gauge')).toHaveLength(4)
    expect(within(homeo).getByTestId('gauge-false_green').getAttribute('data-out')).toBe('true')
    expect(within(homeo).getByRole('img', { name: 'pass rate: 86%, bound ≥ 70%' })).toBeTruthy()
    // The p90 wait reads as a stopwatch (in the dot font "48s" would read "485"), and is said in seconds.
    expect(within(homeo).getByRole('img', { name: 'p90 wait: 48 seconds, bound ≤ 120 seconds' })).toBeTruthy()
    expect(within(homeo).getByTestId('gauge-latency_p90_s').textContent).not.toMatch(/\ds/)
    expect(within(homeo).getByTestId('m1-line').textContent).toBe('M1 holding · false green out of bounds')

    // It moves live: roko's ev.update and m1.episode arrive as loop frames (0.6.0 `essential`, `controller`).
    const socket = await openSocket()

    // (Ten minutes ago: the next tests' own events stay the newest.)
    push(socket, { data: { ev: 'false_green', value: 0.02, bound: 0.05, inner: null, state: 'in_bounds' }, key: 'essential:false_green:2', kind: 'essential', ring: 'L3', run_id: null, task_id: null, text: 'false green 2%', ts: Date.now() - 600_000, type: 'loop' })
    push(socket, { data: { episode_id: 'm1-8', phase: 'hold', change: 'tier_floor: cheap -> mid' }, key: 'controller:m1-8', kind: 'controller', ring: 'L3', run_id: null, task_id: null, text: 'M1 moved tier_floor', ts: Date.now() - 600_000, type: 'loop' })
    await waitFor(() => expect(within(homeo).getByTestId('gauge-false_green').getAttribute('data-out')).toBeNull())
    expect(within(homeo).getByTestId('m1-line').textContent).toBe('M1 moved tier_floor cheap → mid · all four in bounds')

    // The lessons view opens on the wall of lessons that paid off.
    openTab(/^Knowledge/)

    const wall = await screen.findByTestId('lesson-wall')

    expect(wall.querySelectorAll('.rk-chain')).toHaveLength(2)
    expect(wall.textContent).toContain('Amounts are integer cents everywhere')
  })

  it('the five loops: each event a mark on its ring, the ring counts, and the newest learning in the log', async () => {
    backend.learning = LEARNING
    await mountPage()

    const socket = await openSocket()
    const now = Date.now()

    push(socket, { data: {}, key: 'loop:route:1', kind: 'route', ring: 'L1', run_id: RUN_ACTIVE, task_id: 'T2', text: 'T2 attempt 2 → glm-4.7', ts: now - 120_000, type: 'loop' })
    push(socket, { data: {}, key: 'loop:knowledge:1', kind: 'knowledge', ring: 'L3', run_id: RUN_ACTIVE, task_id: 'T3', text: "T3: kept a new lesson: tally's CLI nests actions with add_subparsers", ts: now - 60_000, type: 'loop' })
    openTab(/^Learning/)

    const loops = await screen.findByTestId('five-loops')

    // The ring's count is its marks: every L1 event of the last hour (the card's own loop events too).
    const l1 = loops.querySelectorAll('.rk-orrery-tick[data-ring="L1"]').length

    expect(l1).toBeGreaterThan(0)
    expect(within(loops).getByTestId('orrery-L1').textContent).toBe(`attemptsL1 · min${l1}`)
    expect(within(loops).getByTestId('orrery-L3').textContent).toContain('learning')
    // A lesson that just landed glows on L3, and the mark's eyes turn to a star.
    expect(loops.querySelector('.rk-orrery-lesson')).toBeTruthy()
    expect(within(loops).getByTestId('learning-log').textContent).toContain("T3: kept a new lesson: tally's CLI nests actions")
  })

  it('the workspace scope asks for it, and says what its numbers rest on: the coverage note, roko’s recorded tasks, how many runs of how many', async () => {
    backend.learning = {
      ...LEARNING,
      scope: 'workspace',
      scope_label: 'every plan run in this workspace',
      coverage: { source: 'run records', runs: 14, found: 34, lessons_from: 3, note: 'lessons and what prompts carried are known for 3 of 14 runs, the ones Hermes started' },
      recorded_tasks: { tasks: 412, cost_usd: 12.9, cost_per_task_usd: 0.031, typical_task_ms: 72_000 }
    }
    backend.ladder = LADDER
    await mountPage()
    openTab(/^Learning/)
    fireEvent.click(await screen.findByTestId('learning-scope-workspace'))
    await waitFor(() => expect(called('GET', '/learning?scope=workspace')).toBe(true))

    const foot = await screen.findByTestId('learning-coverage')

    expect(foot.textContent).toBe('◌ lessons and what prompts carried are known for 3 of 14 runs, the ones Hermes startedroko recorded 412 tasks here · about $0.03 a task · 1:12 each')
    expect(screen.getByTestId('learning-window').textContent).toMatch(/^14 of 34 runs/)
    fireEvent.click(screen.getByTestId('learning-scope-hermes'))
  })

  it('what drove the first tries: both n’s always, the difference whichever way it points once each side has 5 tasks, the backend’s note as given, and how the sides were drawn (Q3)', async () => {
    backend.learning = {
      ...LEARNING,
      lessons_first_try: { with: { passed: 2, of: 3, rate: 0.667 }, without: { passed: 1, of: 2, rate: 0.5 }, design: 'observational', comparable: false, difference: null, note: 'too few tasks to compare yet (n = 3 and 2)' }
    }
    await mountPage()
    openTab(/^Learning/)

    const page = await screen.findByTestId('learning-overview')

    await waitFor(() => expect(within(page).getByTestId('kpi-first').textContent).toContain('with a lesson 2/3 passed first try, without 1/2 · too few tasks to compare yet (n = 3 and 2) · observational'))

    // Lessons behind: said as it is, never only when they come out ahead.
    backend.learning = {
      ...LEARNING,
      lessons_first_try: { with: { passed: 3, of: 8, rate: 0.375 }, without: { passed: 5, of: 7, rate: 0.714 }, design: 'observational', comparable: true, difference: -0.339, note: 'observational: tasks without a lesson differ in other ways too' }
    }
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'learning'] })
    })
    await waitFor(() => expect(within(page).getByTestId('kpi-first').textContent).toContain('with a lesson 3/8 passed first try, without 5/7 · −34 points · observational: tasks without a lesson differ in other ways too'))
  })

  it('on a backend without /learning, the overview works out what it can from the runs it has, and says what needs 0.6.0', async () => {
    await mountPage()
    openTab(/^Learning/)

    const page = await screen.findByTestId('learning-overview')

    await waitFor(() => expect(within(page).getByTestId('kpi-first').textContent).toContain('needs the plugin’s learning view (0.6.0)'))
    expect(within(page).getByTestId('lessons-paid').textContent).toContain('needs the plugin’s learning view (0.6.0)')
    expect(within(page).getByTestId('homeostat').textContent).toContain('needs the plugin’s learning view (0.6.0)')
  })
})

describe('mission control (0.3.0)', () => {
  const nodeIn = (card: HTMLElement, id: string) => card.querySelector(`.roko-node[data-node="${id}"]`) as HTMLElement

  it('clicking a task opens the inspector: attempts, checks, and the agent note as text; Esc closes it', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(nodeIn(card, 'T1')).toBeTruthy())
    fireEvent.click(nodeIn(card, 'T1'))

    const inspector = await within(card).findByTestId('inspector-T1')

    expect(within(inspector).getByText('lexer')).toBeTruthy()
    expect(within(inspector).getByText('#1')).toBeTruthy()
    expect(within(inspector).getByText('verify[0:test]')).toBeTruthy()
    // Markdown in an agent's note stays literal.
    expect(within(inspector).getByText('The lexer handles **all** token kinds; 12 tests pass.')).toBeTruthy()
    expect(inspector.querySelector('strong')).toBeNull()
    expect(nodeIn(card, 'T1').getAttribute('data-selected')).toBe('true')

    // A retried task lists both attempts.
    fireEvent.click(nodeIn(card, 'T2'))
    const second = await within(card).findByTestId('inspector-T2')

    expect(within(second).getByText('#1')).toBeTruthy()
    expect(within(second).getByText('#2')).toBeTruthy()

    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' })
    })
    await waitFor(() => expect(within(card).queryByTestId('inspector-T2')).toBeNull())
  })

  it('a retry that has not reached its checks shows none of the attempt before’s verdicts', async () => {
    // Live end-to-end, 2026-10-13: attempt 5 was still with its agent, and the inspector showed attempt 4's
    // failed check on it. Here attempt 2 runs its check now; attempt 1's verdict stays on attempt 1.
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(nodeIn(card, 'T2')).toBeTruthy())
    fireEvent.click(nodeIn(card, 'T2'))

    const inspector = await within(card).findByTestId('inspector-T2')
    const rows = inspector.querySelectorAll('.roko-pipe-row')

    expect(rows.length).toBe(2)
    expect(rows[0].querySelector('.roko-pipe-stage[data-state="fail"]')).toBeTruthy()
    expect(rows[1].querySelector('.roko-pipe-stage[data-state="fail"]')).toBeNull()
    expect(rows[1].querySelector('.roko-pipe-stage[data-state="run"]')).toBeTruthy()
  })

  it('a failed run says why, points at the task, and shows what was blocked', async () => {
    await mountPage({ run: RUN_FAILED })

    const card = await screen.findByTestId(`run-card-${RUN_FAILED}`)
    const why = await within(card).findByTestId('why')

    expect(within(why).getByText('Why it did not pass')).toBeTruthy()
    expect(within(why).getByText(/python: command not found/)).toBeTruthy()
    expect(nodeIn(card, 'T1').getAttribute('data-state')).toBe('failed')
    expect(nodeIn(card, 'T2').getAttribute('data-state')).toBe('blocked')
    expect(within(nodeIn(card, 'T2')).getByText('blocked by T1')).toBeTruthy()
    expect(card.querySelector('.roko-edge[data-state="blocked"]')).toBeTruthy()

    fireEvent.click(within(why).getByRole('button', { name: /Inspect T1/ }))
    const inspector = await within(card).findByTestId('inspector-T1')

    expect(within(inspector).getByText('bash: line 1: python: command not found')).toBeTruthy()
    expect(within(inspector).getByText('#3')).toBeTruthy()
  })

  it('replays a finished run: the graph shows each task as it was at the playhead', async () => {
    await mountPage({ run: RUN_FAILED })

    const card = await screen.findByTestId(`run-card-${RUN_FAILED}`)

    fireEvent.click(await within(card).findByTestId('replay-start'))

    const slider = await within(card).findByRole('slider', { name: 'Replay position' })

    // At the start nothing had run yet.
    expect(nodeIn(card, 'T1').getAttribute('data-state')).toBe('pending')
    expect(nodeIn(card, 'T2').getAttribute('data-state')).toBe('pending')
    fireEvent.keyDown(slider, { key: 'End' })
    await waitFor(() => expect(nodeIn(card, 'T1').getAttribute('data-state')).toBe('failed'))
    expect(nodeIn(card, 'T2').getAttribute('data-state')).toBe('blocked')
    // A step back: T1 was still working then.
    fireEvent.keyDown(slider, { key: 'ArrowLeft' })
    await waitFor(() => expect(nodeIn(card, 'T1').getAttribute('data-state')).toBe('running'))
    expect(slider.getAttribute('aria-valuetext')).toMatch(/^\d+:\d{2} of 9:13$/)
    // In the stream, what had not happened yet at the playhead waits, faint.
    expect(card.querySelectorAll('.rk-ln[data-future="true"]').length).toBeGreaterThan(0)

    fireEvent.click(within(card).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(nodeIn(card, 'T1').getAttribute('data-state')).toBe('failed'))
    expect(within(card).queryByRole('slider')).toBeNull()
  })

  it('Changes: a file list beside a unified diff, with numbers, tint, and hostile text printed literally', async () => {
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')

    const changes = await within(card).findByTestId('changes')

    expect(called('GET', `/runs/${RUN_DONE}/diff?max_files=150`)).toBe(true)
    expect(within(changes).getByText('3 files')).toBeTruthy()
    expect(within(within(changes).getByRole('navigation', { name: 'Changed files' })).getAllByRole('button')).toHaveLength(3)
    expect(within(changes).getByText('@@ -10,4 +10,6 @@')).toBeTruthy()
    expect(within(changes).getByText('pub fn sub')).toBeTruthy()
    // The hostile line is text: no element was made from it.
    const hostile = [...changes.querySelectorAll('.roko-dcode')].find(el => el.textContent === HOSTILE_LINE)

    expect(hostile).toBeTruthy()
    expect(changes.querySelector('img')).toBeNull()
    // Light tint: keywords and strings become spans of text.
    expect([...changes.querySelectorAll('.roko-t-kw')].map(el => el.textContent)).toContain('fn')
    expect([...changes.querySelectorAll('.roko-t-str')].map(el => el.textContent)).toContain('"clamp"')
    expect(changes.querySelector('.roko-dl[data-tag="del"] .roko-ln')?.textContent).toBe('11')
    expect(within(changes).getByText('Binary file: no line changes to show.')).toBeTruthy()
    expect(within(changes).getByText('This change is too large to show here.')).toBeTruthy()
    // A file can be folded.
    fireEvent.click(within(changes).getByRole('button', { expanded: true, name: /lib\.rs/ }))
    expect(within(changes).queryByText('@@ -10,4 +10,6 @@')).toBeNull()
  })

  it('Merge asks first, merges exactly the reviewed commit, and offers the undo command', async () => {
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')
    await within(card).findByTestId('changes')
    fireEvent.click(await within(card).findByTestId('merge-button'))

    const dialog = await screen.findByRole('dialog', { name: 'Merge this run’s work into main?' })

    expect(within(dialog).getByText('d66293e3 → main · fast-forward')).toBeTruthy()
    expect(called('POST', `/runs/${RUN_DONE}/merge`)).toBe(false)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }))

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.objectContaining({ body: { commit: DONE_COMMIT }, method: 'POST', path: `/api/plugins/roko/runs/${RUN_DONE}/merge` }))
    )

    const merged = await within(card).findByTestId('merged')

    expect(merged.textContent).toContain('Merged into main')
    fireEvent.click(within(merged).getByRole('button', { name: /Copy undo command/ }))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('git -C /work/ws reset --keep 3cfff55c8a68aa'))
    await waitFor(() => expect(toastTitles()).toContain('roko: merged into main'))
  })

  it('a demo run offers no Merge: its output stays on its run branch', async () => {
    await reloadPlugin()
    backend.runs = backend.runs.map(row => (row.run_id === RUN_DONE ? { ...row, kind: 'plan', label: 'demo-hello-world', plan_id: 'demo-hello-world' } : row))
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')

    const changes = await within(card).findByTestId('changes')

    expect((await within(changes).findByTestId('demo-output')).textContent).toBe('Demo output: it stays on its run branch')
    expect(within(changes).queryByTestId('merge-button')).toBeNull()
    expect(within(changes).queryByRole('button', { name: /Copy merge command/ })).toBeNull()
    expect(called('GET', `/runs/${RUN_DONE}/merge`)).toBe(false)
  })

  it('Merge is refused with the reason and the command when the checkout is not safe to merge into', async () => {
    // The previous test merged this run in this window; start from a fresh plugin.
    await reloadPlugin()
    backend.mergeCheck = {
      ...backend.mergeCheck,
      can_merge: false,
      command: `git -C /work/ws merge roko/batch/${RUN_DONE}`,
      mode: null,
      reason: 'the checkout has uncommitted changes to 1 tracked file; commit or stash them first'
    }
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')

    const changes = await within(card).findByTestId('changes')

    expect(await within(changes).findByText(/uncommitted changes to 1 tracked file/)).toBeTruthy()
    expect(within(changes).queryByTestId('merge-button')).toBeNull()
    fireEvent.click(within(changes).getByRole('button', { name: /Copy merge command/ }))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(`git -C /work/ws merge roko/batch/${RUN_DONE}`))
  })

  it('the composer starts a run with a cap, and opens it', async () => {
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const dialog = await screen.findByRole('dialog', { name: 'New roko run' })
    const submit = within(dialog).getByTestId('composer-submit') as HTMLButtonElement

    expect(submit.disabled).toBe(true)
    expect(within(dialog).getByTestId('composer-limits').textContent).toBe('at most $5.00 per run' + 'today $0.42 of $10.00' + '$8.58 left today')
    fireEvent.change(within(dialog).getByLabelText('What should roko do?'), { target: { value: 'Add a --json flag' } })
    fireEvent.click(within(dialog).getByRole('button', { name: '$2.00' }))
    fireEvent.change(within(dialog).getByLabelText(/^Name it/), { target: { value: 'JSON output' } })
    expect(submit.textContent).toBe('Start · cap $2.00')
    fireEvent.click(submit)

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({ body: { max_usd: 2, prompt: 'Add a --json flag', title: 'JSON output' }, method: 'POST', path: '/api/plugins/roko/runs' })
      )
    )
    expect(await screen.findByTestId(`run-card-${RUN_NEW}`)).toBeTruthy()
    expect(window.location.hash).toBe(`#/roko#run=${RUN_NEW}`)
    await waitFor(() => expect(toastTitles()).toContain('roko: run started · cap $2.00'))
  })

  it('the composer checks the cap, can plan first, and submits with ⌘↵', async () => {
    await mountPage()
    act(() => {
      fireEvent.keyDown(window, { key: 'n' })
    })

    const dialog = await screen.findByRole('dialog', { name: 'New roko run' })

    fireEvent.change(within(dialog).getByLabelText('What should roko do?'), { target: { value: 'Plan the parser rewrite' } })
    fireEvent.change(within(dialog).getByLabelText('Spend cap'), { target: { value: '6' } })
    expect(within(dialog).getByText('Enter a cap of at most $5.00.')).toBeTruthy()
    expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(within(dialog).getByRole('button', { name: 'plan first' }))
    expect(within(dialog).getByTestId('composer-submit').textContent).toBe('Write the plan')
    fireEvent.keyDown(dialog, { key: 'Enter', metaKey: true })

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.objectContaining({ body: { plan: true, prompt: 'Plan the parser rewrite' }, method: 'POST', path: '/api/plugins/roko/runs' }))
    )

    const card = await screen.findByTestId(`run-card-${RUN_PLANGEN}`)

    expect(within(card).getByText(/roko’s planner is breaking the request into tasks/)).toBeTruthy()
  })

  it('j and k move through the runs; [ and ] switch the run views', async () => {
    await mountPage({ run: RUN_ACTIVE })
    await screen.findByTestId(`run-card-${RUN_ACTIVE}`)
    act(() => {
      fireEvent.keyDown(window, { key: 'j' })
    })
    await waitFor(() => expect(window.location.hash).not.toBe(`#/roko#run=${RUN_ACTIVE}`))
    expect(window.location.hash).toMatch(/^#\/roko#run=/)
    act(() => {
      fireEvent.keyDown(window, { key: ']' })
    })
    await waitFor(() => expect(window.location.hash).toMatch(/&view=activity$/))
  })

  it('a chat card for a finished run offers Review & merge, which opens its changes', async () => {
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${RUN_DONE}"}`} />)

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openFold(card)
    await within(card).findByTestId('receipt')
    // Ended: the Receipt (spec v3 §4.6) says what changed, where, and how far it was checked.
    // A batch branch goes by its run's short id, as roko's headline does; the line's title has it in full.
    expect(within(card).getByTestId('receipt').textContent).toContain(`+30 −0 in 1 file · roko/batch/${RUN_DONE.slice(0, 8)} · verified`)
    expect(within(within(card).getByTestId('receipt')).getByTitle(`roko/batch/${RUN_DONE}`)).toBeTruthy()
    fireEvent.click(within(card).getByRole('button', { name: /Review & merge/ }))
    expect(window.location.hash).toBe(`#/roko#run=${RUN_DONE}&view=changes`)
  })

  it('a chat card says the backend\'s next step when there is one, and opens where it is done', async () => {
    backend.runs = backend.runs.map(row => (row.run_id === RUN_DONE ? { ...row, next: { action: 'review', label: 'review the unverified changes', why: 'no check ran on T2' } } : row))
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${RUN_DONE}"}`} />)

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)
    const key = await within(card).findByTestId('cc-next')

    expect(key.textContent).toBe('review the unverified changes')
    expect(within(card).queryByRole('button', { name: /Review & merge/ })).toBeNull()
    fireEvent.click(key)
    expect(window.location.hash).toBe(`#/roko#run=${RUN_DONE}&view=changes`)
  })

  it('a chat card for a live plan run shows the plan’s strip, who it waits on, and the graph in miniature in its details', async () => {
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${RUN_ACTIVE}"}`} />)

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(within(card).getByTestId('card-tasks').querySelector('svg')?.getAttribute('aria-label')).toMatch(/^1 of 3 tasks passed/))
    // The strip: a square a task; T2 runs but waits on the person's sign-off: orange, "you", not the agent's blue.
    expect(card.querySelectorAll('.rk-rc-strip i')).toHaveLength(3)
    expect(card.querySelector('.rk-rc-strip i[data-state="you"]')).toBeTruthy()
    expect(within(card).getByTestId('card-pill').getAttribute('data-state')).toBe('you')
    openFold(card)
    await waitFor(() => expect(within(card).getByRole('img', { name: '3 tasks in 2 waves' })).toBeTruthy())
    expect(card.querySelectorAll('.roko-mini-dot')).toHaveLength(3)
    expect(card.querySelector('.roko-mini-dot[data-state="waiting"]')).toBeTruthy()
    expect(card.querySelector('.roko-mini-dot[data-state="running"]')).toBeNull()
  })

  it('the status chip shows what waits on the person before the running run', async () => {
    mountContribution('statusBar.right', 'roko:chip')

    const chip = await screen.findByTestId('roko-status-chip')

    // The run waits on the person, so the chip says that: orange, blinking fast (design system §4.9).
    await waitFor(() => expect(within(chip).getByTestId('chip-waiting')).toBeTruthy())
    expect(chip.querySelector('.rk-chip-led')?.getAttribute('data-state')).toBe('you')
    expect(within(chip).queryByTestId('chip-live')).toBeNull()
  })

  it('the status chip shows the running run’s time on its glass while nothing waits on the person', async () => {
    backend.pending = []
    mountContribution('statusBar.right', 'roko:chip')

    const chip = await screen.findByTestId('roko-status-chip')

    await waitFor(() => expect(within(chip).getByTestId('chip-live')).toBeTruthy())
    expect(chip.querySelector('.rk-chip-led')?.getAttribute('data-state')).toBe('live')
    expect(chip.querySelector('[data-testid="chip-live"] .rk-dots')?.getAttribute('data-value')).toMatch(/^\d+:\d\d$/)
  })

  it('a prompt run’s task is named after the run, not after the chat host', async () => {
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)
    const inspector = await within(card).findByTestId('inspector-T1')

    expect(within(inspector).getByText('Add clamp() with a test')).toBeTruthy()
    expect(within(card).queryByText('Request from chat host hermes')).toBeNull()
  })

  it('a plan run named by its slug shows the plan’s own title', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    expect(await within(card).findByRole('heading', { name: 'Add tests' })).toBeTruthy()
    // The slug is an internal name (design system §6.4): neither the head nor the crumb shows it.
    expect(card.querySelector('.roko-hero-slug')).toBeNull()
    expect(screen.getByRole('navigation', { name: 'Where you are' }).textContent).toBe('Runs › Add tests')
  })

  it('a refused merge says why in the dialog, as sentences', async () => {
    await reloadPlugin()
    backend.mergeConflict = true
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')
    fireEvent.click(await within(card).findByTestId('merge-button'))

    const dialog = await screen.findByRole('dialog', { name: 'Merge this run’s work into main?' })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }))
    expect(
      await within(dialog).findByText('the run’s branch moved since you reviewed it, so nothing was merged. Review the changes again, then merge.'.replace('’', "'"))
    ).toBeTruthy()
    expect(within(card).queryByTestId('merged')).toBeNull()
  })

  it('Changes says the work is merged once it is, instead of “no changes”', async () => {
    backend.merged = true
    backend.diffGone = true
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')

    const merged = await within(card).findByTestId('changes-merged')

    expect(within(merged).getByText('This run’s work is merged')).toBeTruthy()
    expect(within(merged).getByText("Its changes (1 file changed, 30 insertions(+)) are in your checkout.")).toBeTruthy()
    expect(within(card).queryByText('No changes to review')).toBeNull()
  })

  it('motion stops for people who ask for less', () => {
    const css = document.head.querySelector('style[data-hermes-plugin="roko"]')?.textContent ?? ''

    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
    expect(css).toMatch(/prefers-reduced-motion:reduce\)\{\.roko \*,[^}]*animation-duration:0s!important/)
    // No literal colors outside the glass's own tokens: the body's colours come from the theme, and the glass
    // (spec v3 §3.1, the one sanctioned fixed material) is defined once, as --ph-* tokens.
    const rest = css.replace(/--ph-[\w-]+:[^;}]+/g, '')

    expect(css).toContain('--ph-void:#0b0c0d')
    expect(rest).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(rest).not.toMatch(/rgba?\(/)
  })
})

describe('0.4.0: the live control surface', () => {
  const nodeIn = (card: HTMLElement, id: string) => card.querySelector(`.roko-node[data-node="${id}"]`) as HTMLElement
  const overviewFrame = async () => (await backend.handle({ path: '/api/plugins/roko/overview' })) as Record<string, unknown>
  const cardOf = async (runId: string) => ((await backend.handle({ path: `/api/plugins/roko/runs/${runId}` })) as { run: Record<string, unknown> }).run

  // Each test starts from a fresh plugin: live state (socket health, loop events, agent moves) is per window.
  beforeEach(async () => {
    await reloadPlugin()
  })

  afterAll(async () => {
    await reloadPlugin()
  })

  it('the run’s readings are one glass: tasks with the plan’s strip, time, spent against its cap, checks (design system §4.2)', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)
    const glass = await within(card).findByTestId('card-glass')

    // Changing numbers are dot-matrix displays: an SVG of lit dots that says its value to assistive tech.
    const spend = within(glass).getByRole('img', { name: 'spent $0.42 of $0.50' })

    expect(spend.tagName.toLowerCase()).toBe('svg')
    // "$0.42": money on the glass is to the cent, as everywhere (design system §6.3).
    expect(spend.querySelectorAll('.rk-dots-on')).toHaveLength(5)
    expect(within(glass).getByRole('img', { name: '1 of 2 checks passed' })).toBeTruthy()
    // Four cells, a label over each reading.
    expect([...glass.querySelectorAll('.rk-rc-label')].map(m => m.textContent)).toEqual(['tasks', 'time', 'spent', 'checks'])
    // TASKS draws the plan as a strip, a square a task: T1 passed, T2 waits on the person.
    const strip = [...within(glass).getByTestId('card-tasks').querySelectorAll('.rk-rc-strip i')].map(i => i.getAttribute('data-state'))

    expect(strip).toContain('pass')
    expect(strip).toContain('you')
    // CHECKS: a pip a check.
    expect(within(glass).getByTestId('card-checks').querySelectorAll('.rk-pips i')).toHaveLength(2)
    // What is happening now: T2 waits on a sign-off.
    expect(within(card).getByTestId('horizon').textContent).toContain('waiting on you')
    // The sequencer's playhead stands on the wave that is working.
    expect(card.querySelector('.rk-playhead')?.getAttribute('data-mode')).toBe('live')
    expect(card.querySelector('.rk-step-col[data-active="true"]')).toBeTruthy()
    expect(nodeIn(card, 'T2').getAttribute('data-channel')).toBe('you')
    expect(nodeIn(card, 'T1').getAttribute('data-channel')).toBe('pass')
  })

  it('socket frames update the page without polling: a fresh card, agent moves on the ticker, new timeline lines', async () => {
    // Nothing waits on the person here, so a running task shows its agent's moves.
    backend.pending = []
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(nodeIn(card, 'T1')).toBeTruthy())

    const socket = await openSocket()

    expect(socket.url).toMatch(/^ws:\/\/127\.0\.0\.1:9119\/api\/plugins\/roko\/live\?token=/)
    push(socket, { hello: true, hub: 'open', overview: await overviewFrame(), server_time: new Date().toISOString(), type: 'hello', version: PAGE_VERSION })
    await waitFor(() => expect(screen.getByTestId('live-state').textContent).toBe('live'))
    api.mockClear()

    // A run frame replaces the card: T3 starts, the headline moves.
    const run = await cardOf(RUN_ACTIVE)
    const tasks = (run.tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T3' ? { ...t, outcome: 'running', step: 'agent', step_detail: 'glm-5.1', attempts: 1, step_since: new Date().toISOString() } : t))

    push(socket, { run: { ...run, headline: 'running · gates 1/2 · $0.44 of $0.50 · 1m 20s', cost_usd: 0.44, tasks }, type: 'run' })
    await waitFor(() => expect(nodeIn(card, 'T3').getAttribute('data-state')).toBe('running'))
    // The glass says the new spend at once.
    expect(within(card).getByRole('img', { name: 'spent $0.44 of $0.50' })).toBeTruthy()

    // An agent's tool step reaches the ticker and its pad at once.
    push(socket, { attempt: 1, kind: 'tool', plan_id: 'add-tests', run_id: RUN_ACTIVE, target: 'src/parser.rs', task_id: 'T3', tool: 'Edit', tool_id: 'T3-1-0', ts: Date.now(), type: 'live' })
    await waitFor(() => expect(card.querySelector('.rk-ticker-item[data-age="0"]')?.textContent).toBe('T3 Edit src/parser.rs'))
    expect(within(nodeIn(card, 'T3')).getByText('Edit src/parser.rs')).toBeTruthy()

    // Timeline lines merge into the activity by cursor.
    push(socket, { lines: [{ cursor: 9100, group: 'agent', task_id: 'T3', attempt: 1, model: 'glm-5.1', provider: 'zai', text: 'T3 attempt 1 on glm-5.1 (zai)', ts_millis: Date.now(), type: 'agent_spawned' }], run_id: RUN_ACTIVE, type: 'lines' })
    openRunFold(card, 'steps')
    expect(await within(card).findByText('T3 attempt 1 on glm-5.1 (zai)')).toBeTruthy()
    // None of that needed a request.
    expect(called('GET', `/runs/${RUN_ACTIVE}`)).toBe(false)
  })

  it('untrusted words in frames stay text: HTML prints literally (an agent’s **bold** shows as bold in the ticker)', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)
    const socket = await openSocket()
    const hostile = '<img src=x onerror="alert(1)"> **not bold**'

    await waitFor(() => expect(nodeIn(card, 'T1')).toBeTruthy())
    push(socket, { attempt: 2, kind: 'text', plan_id: 'add-tests', run_id: RUN_ACTIVE, screened: false, task_id: 'T2', text: hostile, ts: Date.now(), type: 'live' })
    await waitFor(() => expect(card.querySelector('.rk-ticker')?.textContent).toContain('<img src=x onerror="alert(1)"> not bold'))
    expect(card.querySelector('.rk-ticker img, .rk-ticker strong')).toBeNull()
    // The words' own markdown (spec v3 round v6, on camera): bold as bold, the markers gone, never HTML.
    expect(card.querySelector('.rk-ticker .rk-said b')?.textContent).toBe('not bold')

  })

  it('an agent\u2019s words reach the ticker as one running line: the end of what it says, not a token each', async () => {
    backend.pending = []
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(nodeIn(card, 'T1')).toBeTruthy())

    const socket = await openSocket()
    const frame = { attempt: 1, plan_id: 'add-tests', run_id: RUN_ACTIVE, task_id: 'T3', type: 'live' }
    const newest = () => card.querySelector('.rk-ticker-item[data-age="0"]')?.textContent

    push(socket, { ...frame, kind: 'reasoning', said: 'Reading', text: 'Reading', ts: Date.now() })
    push(socket, { ...frame, kind: 'reasoning', said: 'Reading the parser', text: ' the parser', ts: Date.now() })
    // A frame without `said` (an older backend) continues the line too.
    push(socket, { ...frame, kind: 'reasoning', text: ' first.', ts: Date.now() })
    await waitFor(() => expect(newest()).toBe('T3 \u201cReading the parser first.\u201d'))
    expect(card.querySelectorAll('.rk-ticker-item[data-kind="reasoning"]')).toHaveLength(1)

    // A long stretch shows its end, where the agent is now.
    push(socket, { ...frame, kind: 'text', said: `${'word '.repeat(80)}and the newest words`, text: ' words', ts: Date.now() })
    await waitFor(() => expect(newest()).toMatch(/^T3 \u201c\u2026.*and the newest words\u201d$/))
    // ...in a box that keeps its newest end in view when the line is wider than the ticker.
    expect(card.querySelector('.rk-ticker-item[data-age="0"] > .rk-said > span')?.textContent).toMatch(/and the newest words\u201d$/)

    // A tool call ends the stretch: the next words are a new line, and the step trails off behind them.
    push(socket, { ...frame, kind: 'tool', target: 'src/parser.rs', tool: 'Edit', tool_id: 'T3-1-0', ts: Date.now() })
    push(socket, { ...frame, kind: 'text', said: 'Edited.', text: 'Edited.', ts: Date.now() })
    await waitFor(() => expect(newest()).toBe('T3 \u201cEdited.\u201d'))
    expect(card.querySelector('.rk-ticker-item[data-age="1"]')?.textContent).toBe('T3 Edit src/parser.rs')
  })

  it('the inspector shows why an attempt runs on its model: source, probability, and the candidates as bars', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(nodeIn(card, 'T2')).toBeTruthy())
    fireEvent.click(nodeIn(card, 'T2'))

    const inspector = await within(card).findByTestId('inspector-T2')
    const route = within(inspector).getByTestId('route')

    expect(within(route).getByTestId('route-decider').textContent).toBe('picked by the router')
    expect(route.querySelector('.rk-route-p')?.textContent).toBe('p 0.82')
    expect(within(route).getByText('highest expected pass rate for a retry of verify[0:test]')).toBeTruthy()

    const rows = within(route).getAllByRole('listitem')

    // The models this run can't use fold under one line.
    expect(rows).toHaveLength(2)
    expect(rows[0].getAttribute('data-pick')).toBe('true')
    // The bars are relative to the best score: scores decided this pick.
    expect((rows[0].querySelector('.rk-cand-bar i') as HTMLElement).style.width).toBe('100%')
    fireEvent.click(within(route).getByTestId('route-unusable'))

    const unusable = within(route).getAllByRole('listitem')[2]

    expect(unusable.getAttribute('data-eligible')).toBe('false')
    expect(within(unusable).getByText('over the per-task cap')).toBeTruthy()
    // The sign-off hold shows in the inspector with roko's deadline.
    expect(within(inspector).getByText(/Waits for your sign-off/)).toBeTruthy()

    // T1 kept a lesson.
    fireEvent.click(nodeIn(card, 'T1'))
    const first = await within(card).findByTestId('inspector-T1')

    expect(within(first).getByText('Lexer tests live in tests/lexer.rs and run with cargo test -p lexer')).toBeTruthy()

    // A ladder pick says so: the rung, no probability, no score bars (the router's scores did not decide it).
    const ladder = within(first).getByTestId('route')

    expect(ladder.getAttribute('data-scored')).toBe('false')
    expect(within(ladder).getByTestId('route-decider').textContent).toBe('picked by the model ladder')
    expect(ladder.textContent).toContain('rung mid')
    expect(ladder.querySelector('.rk-route-p')).toBeNull()
    expect(ladder.querySelector('.rk-cand-bar i')).toBeNull()
    expect(ladder.textContent).toContain('could have run it')
    expect(within(ladder).getByTestId('route-unusable').textContent).toBe('1 model this run cannot use ›')
  })

  it('a task that works shows its last tool steps and its words from the card when the page opens mid-attempt', async () => {
    backend.liveSteps = true
    backend.pending = []
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(card.querySelector('.rk-ticker')?.textContent).toContain('cargo test -p parser'))
    fireEvent.click(nodeIn(card, 'T2'))

    const live = await within(card).findByTestId('task-live')

    expect(within(live).getAllByText('src/parser.rs')).toHaveLength(2)
    expect(within(live).getByText('The trailing comma case now parses; running the tests.')).toBeTruthy()
  })

  it('orange means you: a run that waits on the person is orange wherever it shows, and its lights blink fast', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    // The head's pill says it, orange and blinking fast, and its sentence is roko's question.
    const pill = () => card.querySelector('.rk-runhead [data-testid="card-pill"]') as HTMLElement

    await waitFor(() => expect(pill().getAttribute('data-state')).toBe('you'))
    expect(pill().getAttribute('data-blink')).toBe('fast')
    expect(within(card).getByTestId('card-status').textContent).toMatch(/^roko asks: /)
    // The horizon's light turns orange and blinks fast, and its line says so.
    const ticker = within(card).getByTestId('horizon')

    expect(ticker.getAttribute('data-tone')).toBe('you')
    expect(ticker.querySelector('.rk-led')?.getAttribute('data-tone')).toBe('you')
    expect(ticker.querySelector('.rk-led')?.getAttribute('data-blink')).toBe('fast')
    expect(ticker.querySelector('.rk-ticker-item[data-channel="you"]')?.textContent).toContain('waiting on you')
    // The pad that waits is orange and blinks fast.
    const pad = card.querySelector('.roko-node[data-node="T2"]') as HTMLElement

    expect(pad.getAttribute('data-channel')).toBe('you')
    expect(pad.querySelector('.rk-led')?.getAttribute('data-blink')).toBe('fast')
    // The Runs tab counts what needs the person, in orange, from any tab.
    expect(screen.getByTestId('waiting-count').textContent).toBe('2')
    expect(screen.getByRole('tab', { name: 'Runs, 2 need you' })).toBeTruthy()
    expect(screen.getByTestId('waiting-badge').querySelector('.rk-led')?.getAttribute('data-blink')).toBe('fast')

    // On Runs: what needs the person comes first, then the run, its pill orange and its strip's square too.
    fireEvent.click(screen.getByTestId('crumb-runs'))

    const home = await screen.findByTestId('runs-home')

    expect(within(within(home).getByTestId('needs-you')).getAllByTestId(/^pending-[0-9a-f]{6}$/)).toHaveLength(2)

    const running = within(home).getByTestId(`run-card-${RUN_ACTIVE}`)

    expect(running.querySelector('.rk-rc-head [data-testid="card-pill"]')?.getAttribute('data-state')).toBe('you')
    expect(running.querySelector('.rk-rc-strip i[data-state="you"]')).toBeTruthy()
  })

  it('the cap knob turns in detents and stops at what may be spent', async () => {
    backend.leftUsd = 1.5
    await refreshOverview()
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const dialog = await screen.findByRole('dialog', { name: 'New roko run' })
    const knob = within(dialog).getByRole('slider', { name: 'Spend cap knob' })

    expect(knob.getAttribute('aria-valuetext')).toBe('$0.50')
    fireEvent.keyDown(knob, { key: 'ArrowRight' })
    expect(knob.getAttribute('aria-valuetext')).toBe('$1.00')
    fireEvent.keyDown(knob, { key: 'ArrowRight' })
    // $2 and $5 are past the $1.50 left today: the knob stops, and those detents are off.
    expect(knob.getAttribute('aria-valuetext')).toBe('$1.00')
    expect((within(dialog).getByRole('button', { name: '$2.00' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(knob, { key: 'Home' })
    expect(knob.getAttribute('aria-valuetext')).toBe('$0.25')
    expect((within(dialog).getByLabelText('Spend cap') as HTMLInputElement).value).toBe('0.25')
    expect(within(dialog).getByTestId('composer-submit').textContent).toBe('Start · cap $0.25')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('the monitor pane shows the newest live run beside the chat, and a calm display when nothing runs', async () => {
    mountContribution('panes', 'roko:monitor')

    const monitor = await screen.findByTestId('monitor')

    expect(await within(monitor).findByText('add-tests')).toBeTruthy()
    // The run card, as in the chat (design system §4.8): its glass, its sentence, its key.
    await waitFor(() => expect(within(monitor).getByRole('img', { name: 'spent $0.42 of $0.50' })).toBeTruthy())
    expect(within(monitor).getByTestId('card-tasks').querySelector('svg')?.getAttribute('aria-label')).toMatch(/^1 of 3 tasks passed/)
    expect(within(monitor).getByTestId('card-status').textContent).toMatch(/^roko asks: /)
    expect(within(monitor).getByRole('button', { name: '2 waiting' })).toBeTruthy()

    cleanup()
    backend.runs = backend.runs.filter(row => row.state !== 'running')
    queryClient.removeQueries({ queryKey: ['roko'] })
    mountContribution('panes', 'roko:monitor')

    const idle = await screen.findByTestId('monitor')

    // Idle: a quiet glass that says no run is going.
    expect(await within(idle).findByRole('img', { name: 'no run going' })).toBeTruthy()
    expect(within(idle).getByRole('button', { name: /new run/ })).toBeTruthy()
  })

  it('an empty chat offers to delegate: a chip fills that chat’s composer and focuses it', async () => {
    const setDraft = vi.spyOn(host.composer, 'setDraft').mockResolvedValue(true)
    const focus = vi.spyOn(host.composer, 'focus').mockImplementation(() => undefined)
    const c = contribution('chat.empty', 'roko:delegate')!

    mount(
      <ContribBoundary id={c.id}>
        <ContribRender render={() => (c.data as { render: (p: { sessionId: string }) => ReactNode }).render({ sessionId: 's-42' })} />
      </ContribBoundary>
    )

    const card = await screen.findByTestId('delegate')

    fireEvent.click(within(card).getByRole('button', { name: '--json flag + test' }))
    await waitFor(() =>
      expect(setDraft).toHaveBeenCalledWith('s-42', 'Use roko to add a --json flag to the CLI that prints the report as JSON, with a test for it. Cap it at $1.')
    )
    expect(focus).toHaveBeenCalledWith('s-42')
    setDraft.mockRestore()
    focus.mockRestore()
  })

  it('the → roko key in the chat composer opens a New run with the chat’s draft', async () => {
    const getDraft = vi.spyOn(host.composer, 'getDraft').mockResolvedValue('Write a haiku about checked work')

    // The status chip hosts the New run device wherever the person is.
    mountContribution('statusBar.right', 'roko:chip')
    mountContribution('composer.actions', 'roko:composer-key')

    fireEvent.click(await screen.findByTestId('composer-key'))

    const dialog = await screen.findByRole('dialog', { name: 'New roko run' })

    expect((within(dialog).getByLabelText('What should roko do?') as HTMLTextAreaElement).value).toBe('Write a haiku about checked work')
    expect(getDraft).toHaveBeenCalledWith(null)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    getDraft.mockRestore()
  })

  it('ships a roko theme with a light and a dark palette', () => {
    const theme = contribution('themes', 'roko:theme')?.data as { colors: Record<string, string>; darkColors: Record<string, string>; customCSS: string }
    const required = ['background', 'foreground', 'card', 'cardForeground', 'popover', 'popoverForeground', 'primary', 'primaryForeground', 'secondary', 'secondaryForeground', 'accent', 'accentForeground', 'muted', 'mutedForeground', 'border', 'input', 'ring', 'destructive', 'destructiveForeground']

    for (const palette of [theme.colors, theme.darkColors]) {
      for (const key of required) {
        expect(palette[key], key).toMatch(/^#[0-9a-f]{6}$/)
      }
    }

    // roko's design system (§3.1, §3.3): aluminium by day, neutral graphite by night; blue while roko works.
    expect(theme.colors.primary).toBe('#ff5f1f')
    expect(theme.colors.background).toBe('#e3e4e1')
    expect(theme.darkColors.background).toBe('#141516')
    expect(theme.darkColors.sidebarBackground).toBe('#0f1011')
    expect(theme.customCSS).toContain('--ui-orange:#ff5f1f')
    expect(theme.customCSS).toContain('--roko-live:#6b95ff')
    expect(theme.customCSS).not.toContain('#ee8fba')
    // Archivo, and Martian Mono for the page's figures, loaded while the theme is on.
    expect((theme as { typography?: { fontUrl?: string; fontSans?: string } }).typography?.fontSans).toMatch(/^"Archivo", /)
    expect((theme as { typography?: { fontUrl?: string } }).typography?.fontUrl).toContain('family=Martian+Mono:wdth,wght@87.5,')
    expect(resolveTheme('roko')?.label).toBe('roko')
  })

  it('a settings page: the connection, the limits, sounds and the doctor', async () => {
    mountContribution('settings.plugins', 'roko:settings')

    const page = await screen.findByTestId('roko-settings')

    expect(await within(page).findByText(/http:\/\/127\.0\.0\.1:6677 · v0\.1\.0 · ok/)).toBeTruthy()
    expect(within(page).getByText('at most $5.00')).toBeTruthy()
    expect(await within(page).findByText('roko serve 0.1.0, status ok')).toBeTruthy()
    expect((within(page).getByRole('switch', { name: /Play short blips/ }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('false')
    // The mark is on by default; studio ticks wait for sound.
    expect((within(page).getByRole('switch', { name: /Show roko’s mark/ }) as HTMLButtonElement).getAttribute('aria-checked')).toBe('true')
    expect((within(page).getByRole('switch', { name: /Studio/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('sounds are off by default; turning them on plays one blip and is remembered', async () => {
    const created: unknown[] = []

    class FakeAudio {
      currentTime = 0
      state = 'running'
      destination = {}

      constructor() {
        created.push(this)
      }

      createOscillator() {
        return { connect: () => undefined, frequency: { setValueAtTime: () => undefined }, start: () => undefined, stop: () => undefined, type: 'sine' }
      }

      createGain() {
        return { connect: () => undefined, gain: { exponentialRampToValueAtTime: () => undefined, setValueAtTime: () => undefined } }
      }

      close() {
        return Promise.resolve()
      }
    }

    setGlobal('AudioContext', FakeAudio)
    await mountPage({ run: RUN_ACTIVE })
    mountContribution('settings.plugins', 'roko:settings')

    // The switch lives on roko's settings page (design system §5.6), not on the page's header.
    const key = within(await screen.findByTestId('roko-settings')).getByRole('switch', { name: /Play short blips/ })

    expect(screen.queryByTestId('sound-key')).toBeNull()
    expect(key.getAttribute('aria-checked')).toBe('false')
    act(() => {
      emitGatewayEvent({ payload: { cost_usd: 0.2, headline: 'succeeded', label: 'quiet run', run_id: RUN_DONE, state: 'succeeded' }, session_id: 's1', type: 'plugin.roko.run.ended' })
    })
    expect(created).toHaveLength(0)

    fireEvent.click(key)
    await waitFor(() => expect(key.getAttribute('aria-checked')).toBe('true'))
    expect(created).toHaveLength(1)
    expect(localStorage.getItem('hermes.plugin.roko.sound')).toBe('true')
    fireEvent.click(key)
    await waitFor(() => expect(localStorage.getItem('hermes.plugin.roko.sound')).toBe('false'))
    setGlobal('AudioContext', undefined)
  })

  it('run events from Hermes: a pet line when a run ends or needs the person, a toast when a chat starts one', async () => {
    act(() => {
      emitGatewayEvent({ payload: { cost_usd: 0.42, headline: 'succeeded · gates 2/2', label: 'add-tests', run_id: RUN_ACTIVE, state: 'succeeded' }, session_id: 's1', type: 'plugin.roko.run.ended' })
    })
    await waitFor(() => expect($petPluginMessages.get().map(m => m.text)).toContain('roko · passed: add-tests · $0.42'))

    act(() => {
      emitGatewayEvent({ payload: { code: 'zz9yy8', kind: 'confirm', question: 'Accept the summary?', run_id: RUN_ACTIVE, task_id: 'T2', title: 'the summary T2 wrote' }, session_id: 's1', type: 'plugin.roko.waiting' })
    })
    await waitFor(() => expect($petPluginMessages.get().map(m => m.text)).toContain('roko needs you: the summary T2 wrote'))
    expect($petPluginMessages.get().find(m => m.text.startsWith('roko needs you'))?.tone).toBe('wait')

    // A replayed event (a reconnect) says nothing again.
    const before = $notifications.get().length

    act(() => {
      emitGatewayEvent({ payload: { kind: 'run', label: 'Fix the flaky test', max_usd: 1, run_id: RUN_NEW, source: 'chat', state: 'running' }, replayed: true, session_id: 's1', type: 'plugin.roko.run.started' } as never)
    })
    expect($notifications.get().length).toBe(before)

    act(() => {
      emitGatewayEvent({ payload: { kind: 'run', label: 'Fix the flaky test', max_usd: 1, run_id: RUN_NEW, source: 'chat', state: 'running' }, session_id: 's1', type: 'plugin.roko.run.started' })
    })
    await waitFor(() => expect(toastTitles()).toContain('roko: run started · cap $1.00'))
    // Started from the app: the New run device already said so.
    const count = toastTitles().length

    act(() => {
      emitGatewayEvent({ payload: { kind: 'run', label: 'From the page', max_usd: 1, run_id: RUN_DONE, source: 'ui', state: 'running' }, session_id: 's1', type: 'plugin.roko.run.started' })
    })
    expect(toastTitles().length).toBe(count)
  })

  it('a chat with a live roko run gets a light on its sidebar row', async () => {
    const c = contribution('sessionRow.trailing', 'roko:session-led')!
    const row = (sessionId: string) => (c.data as { render: (p: { sessionId: string }) => ReactNode }).render({ sessionId })

    mount(
      <>
        <ContribRender render={() => row('sess-1')} />
        <ContribRender render={() => row('sess-other')} />
      </>
    )

    const led = await screen.findByTestId('session-led')

    expect(led.getAttribute('aria-label')).toBe('roko: add-tests · waiting on you')
    expect(screen.getAllByTestId('session-led')).toHaveLength(1)
  })

  it('reduced motion: the orrery stands still (time moves its marks, never a sweep), and nothing decodes', async () => {
    const before = (window as unknown as { matchMedia?: unknown }).matchMedia

    setGlobal('matchMedia', (query: string) => ({ addEventListener: () => undefined, addListener: () => undefined, dispatchEvent: () => false, matches: query.includes('reduce'), media: query, onchange: null, removeEventListener: () => undefined, removeListener: () => undefined }))

    try {
      await mountPage({ tab: 'loops' })

      const loops = await screen.findByTestId('loops')

      expect(loops.querySelector('.rk-orrery-hand')).toBeTruthy()
      expect([...loops.querySelectorAll('.rk-orrery *')].some(el => /animation/.test(el.getAttribute('style') ?? ''))).toBe(false)
    } finally {
      setGlobal('matchMedia', before)
    }
  })

  it('with actions turned off there is no → roko key and no new-run key in the monitor', async () => {
    backend.canWrite = false
    await refreshOverview()
    mountContribution('composer.actions', 'roko:composer-key')
    mountContribution('panes', 'roko:monitor')

    const monitor = await screen.findByTestId('monitor')

    await within(monitor).findByText('add-tests')
    expect(screen.queryByTestId('composer-key')).toBeNull()
  })
})

describe('setup and updates (0.5.0)', () => {
  const setupModule = () => screen.findByTestId('setup-module')

  it('a current backend: no restart banner, no setup module, no chip tag', async () => {
    await mountPage()
    await screen.findByTestId('roko-page')
    expect(screen.queryByTestId('restart-banner')).toBeNull()
    expect(screen.queryByTestId('setup-module')).toBeNull()
    mountContribution('statusBar.right', 'roko:chip')
    await screen.findByTestId('roko-status-chip')
    expect(screen.queryByTestId('chip-restart')).toBeNull()
  })

  it('a backend from before the update (no install, no setup): a restart banner with the ⌘Q steps, one toast, the chip says restart', async () => {
    backend.install = null
    await reloadPlugin()
    await mountPage()

    const banner = await screen.findByTestId('restart-banner')

    expect(within(banner).getByText('Hermes is still running the roko backend it started with, from before this update.')).toBeTruthy()
    expect(within(banner).getByText('Quit Hermes with ⌘Q. Closing the window is not enough: the app keeps running.')).toBeTruthy()
    expect(within(banner).getByText('Open Hermes again.')).toBeTruthy()
    expect(within(banner).getByRole('img', { name: 'restart' })).toBeTruthy()
    expect(within(banner).queryByTestId('reload-window')).toBeNull()
    await waitFor(() => expect(toastTitles().filter(t => t === 'roko: restart Hermes to finish the update')).toHaveLength(1))

    // A second overview is the same restart: no second toast.
    await refreshOverview()
    expect(toastTitles().filter(t => t === 'roko: restart Hermes to finish the update')).toHaveLength(1)

    mountContribution('statusBar.right', 'roko:chip')
    expect(await screen.findByTestId('chip-restart')).toBeTruthy()
  })

  it('the backend says its files changed (install.backend_stale): the banner takes its words, and the module does not repeat them', async () => {
    backend.install = { ...backend.install, backend_stale: true, disk_version: NEWER_VERSION }
    backend.problems = [PROBLEM_RESTART, PROBLEM_MODEL]
    await mountPage()

    const banner = await screen.findByTestId('restart-banner')

    expect(within(banner).getByText(`roko ${NEWER_VERSION} is installed, but Hermes is still running ${PAGE_VERSION}.`)).toBeTruthy()

    const module = await setupModule()

    expect(within(module).queryByTestId('problem-restart-hermes')).toBeNull()
    expect(within(module).getByTestId('problem-no-tool-loop-model')).toBeTruthy()
  })

  it('a backend newer than this page: only the page is old, so the key reloads the window (⌘R)', async () => {
    backend.pluginVersion = NEWER_VERSION
    await mountPage()

    const banner = await screen.findByTestId('restart-banner')

    expect(within(banner).getByText(`Hermes runs roko ${NEWER_VERSION}, but this page is still ${PAGE_VERSION}.`)).toBeTruthy()
    expect(within(banner).getByText('Reload the window: press ⌘R, or the key here.')).toBeTruthy()
    expect(within(banner).getByTestId('reload-window').textContent).toContain('reload window')
    expect(within(banner).queryByTestId('restart-hermes')).toBeNull()
  })

  it('restart hermes asks first, then uses Hermes’ own relaunch', async () => {
    backend.install = { ...backend.install, backend_stale: true, disk_version: NEWER_VERSION }
    await mountPage()

    fireEvent.click(within(await screen.findByTestId('restart-banner')).getByTestId('restart-hermes'))

    const confirm = await screen.findByRole('dialog', { name: 'Restart Hermes now?' })

    expect(within(confirm).getByText(/A chat that is answering right now stops there/)).toBeTruthy()
    expect(relaunchApp).not.toHaveBeenCalled()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restart Hermes' }))
    await waitFor(() => expect(relaunchApp).toHaveBeenCalledTimes(1))
  })

  it('without Hermes’ relaunch, the banner gives the steps and no key', async () => {
    const saved = bridge.relaunchApp

    delete (bridge as { relaunchApp?: unknown }).relaunchApp

    try {
      backend.install = { ...backend.install, backend_stale: true, disk_version: NEWER_VERSION }
      await mountPage()

      const banner = await screen.findByTestId('restart-banner')

      expect(within(banner).getByText('Open Hermes again.')).toBeTruthy()
      expect(within(banner).queryByTestId('restart-hermes')).toBeNull()
    } finally {
      ;(bridge as { relaunchApp?: unknown }).relaunchApp = saved
    }
  })

  it('an older backend than this page (plugin_version) asks for the restart', async () => {
    backend.pluginVersion = OLDER_VERSION
    await mountPage()

    expect(within(await screen.findByTestId('restart-banner')).getByText(`roko ${PAGE_VERSION} is installed, but Hermes is still running ${OLDER_VERSION}.`)).toBeTruthy()
  })

  it('without install on the overview, the pages read it from /health', async () => {
    backend.installOnOverview = false
    backend.install = { ...backend.install, backend_stale: true, disk_version: NEWER_VERSION }
    await mountPage()

    expect(within(await screen.findByTestId('restart-banner')).getByText(`roko ${NEWER_VERSION} is installed, but Hermes is still running ${PAGE_VERSION}.`)).toBeTruthy()
    expect(called('GET', '/health')).toBe(true)
  })

  it('the setup module numbers the problems, blocking first, each with its one fix', async () => {
    backend.problems = [PROBLEM_MODEL, PROBLEM_BOUNDARY]
    await mountPage()

    const module = await setupModule()
    const rows = module.querySelectorAll('.rk-problem')

    expect(within(module).getByText('1 blocking new runs')).toBeTruthy()
    expect(rows[0].getAttribute('data-testid')).toBe('problem-workspace-refuses-chat-runs')
    expect(rows[0].querySelector('.rk-problem-n')?.textContent).toBe('01')
    expect(rows[1].getAttribute('data-testid')).toBe('problem-no-tool-loop-model')
    expect(within(module).getByText('roko refuses runs started from Hermes in this workspace.')).toBeTruthy()
    expect(within(module).getByText('Its roko.toml has no data-model boundary, so roko turns down every run a chat starts.')).toBeTruthy()

    // A command fix: one key copies it.
    expect(within(module).getByText('roko config models list')).toBeTruthy()
    fireEvent.click(within(module).getByTestId('fix-copy-no-tool-loop-model'))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('roko config models list'))
  })

  it('an action fix previews what it changes on the glass, offers its ways, applies that preview, then says what is next', async () => {
    backend.problems = [PROBLEM_BOUNDARY]
    backend.fixNext = COMMIT_NEXT
    await mountPage()

    const module = await setupModule()

    fireEvent.click(within(module).getByTestId('fix-workspace-refuses-chat-runs'))

    let panel = await within(module).findByTestId('fix-panel-workspace-refuses-chat-runs')

    expect(called('GET', '/setup/fix?action=workspace-chat-ready')).toBe(true)
    expect(called('POST', '/setup/fix')).toBe(false)
    expect(within(panel).getByText('Make this workspace accept runs started from Hermes')).toBeTruthy()
    expect(within(panel).getByText('/work/ws/roko.toml')).toBeTruthy()
    // The recommended way comes first and is the one shown.
    expect(within(panel).getByTestId('fix-variant-local').getAttribute('aria-pressed')).toBe('true')
    expect(within(panel).getByTestId('fix-variant-local').textContent).toContain('recommended')
    expect(within(panel).getByTestId('fix-preview').querySelector('[data-line=add]')?.textContent).toBe('+allow_without_data_llm = true\n')
    expect(within(panel).getByTestId('fix-preview').querySelector('[data-line=del]')?.textContent).toBe('-allow_without_data_llm = false\n')

    // The other way: the preview follows it.
    fireEvent.click(within(panel).getByTestId('fix-variant-boundary'))
    await waitFor(() => expect(called('GET', '/setup/fix?action=workspace-chat-ready&variant=boundary')).toBe(true))
    panel = await within(module).findByTestId('fix-panel-workspace-refuses-chat-runs')
    await waitFor(() => expect(within(panel).getByTestId('fix-variant-boundary').getAttribute('aria-pressed')).toBe('true'))
    expect(within(panel).getByText(/glm-4-7 screens what a run fetched/)).toBeTruthy()
    expect([...within(panel).getByTestId('fix-preview').querySelectorAll('[data-line=add]')].map(line => line.textContent)).toContain('+[agent.data_llm]\n')

    fireEvent.click(within(panel).getByTestId('fix-apply-workspace-refuses-chat-runs'))
    await waitFor(() => expect(backend.applied).toEqual([{ action: 'workspace-chat-ready', digest: 'digest-boundary', variant: 'boundary' }]))

    const done = await screen.findByTestId('fix-done-workspace-refuses-chat-runs')

    expect(done.textContent).toBe(`Changed /work/ws/roko.toml. roko accepts runs started from Hermes now.next ${COMMIT_NEXT}`)
    expect(done.querySelector('.rk-led')?.getAttribute('data-tone')).toBe('pass')

    // The next look no longer lists the problem, so its row goes; what was done and what is next stay.
    const note = await screen.findByTestId('fix-done-note')

    expect(note.textContent).toContain(COMMIT_NEXT)
    expect(note.getAttribute('data-ready')).toBe('true')
    expect(screen.queryByTestId('problem-workspace-refuses-chat-runs')).toBeNull()

    // Committing roko.toml comes next, and the note has the key Merge has: the same fix, previewed, then applied.
    fireEvent.click(within(note).getByTestId('fix-commit-roko-toml'))

    const commit = await within(note).findByTestId('fix-panel-commit-roko-toml')

    expect(called('GET', '/setup/fix?action=commit-roko-toml')).toBe(true)
    fireEvent.click(within(commit).getByTestId('fix-apply-commit-roko-toml'))
    await waitFor(() => expect(backend.applied).toContainEqual({ action: 'commit-roko-toml', digest: 'digest-commit' }))
    await waitFor(() => expect(screen.getByTestId('fix-done-note').textContent).toContain('Committed roko.toml'))
    expect(screen.queryByTestId('fix-commit-roko-toml')).toBeNull()
    fireEvent.click(within(screen.getByTestId('fix-done-note')).getByTestId('fix-done-note-close'))
    await waitFor(() => expect(screen.queryByTestId('fix-done-note')).toBeNull())
  })

  it('a fix that took while roko still refuses runs says so in orange', async () => {
    backend.problems = [PROBLEM_BOUNDARY]
    backend.fixReady = false
    await mountPage()

    const module = await setupModule()

    fireEvent.click(within(module).getByTestId('fix-workspace-refuses-chat-runs'))
    fireEvent.click(within(await within(module).findByTestId('fix-panel-workspace-refuses-chat-runs')).getByTestId('fix-apply-workspace-refuses-chat-runs'))

    const note = await screen.findByTestId('fix-done-note')

    expect(note.textContent).toContain('but it still refuses runs started from Hermes')
    expect(note.getAttribute('data-ready')).toBe('false')
    expect(note.querySelector('.rk-led')?.getAttribute('data-tone')).toBe('you')
    fireEvent.click(within(note).getByTestId('fix-done-note-close'))
    await waitFor(() => expect(screen.queryByTestId('fix-done-note')).toBeNull())
  })

  it('a file that changed since the preview is refused; look again shows the new preview', async () => {
    backend.problems = [PROBLEM_BOUNDARY]
    backend.fixConflict = true
    await mountPage()

    const module = await setupModule()

    fireEvent.click(within(module).getByTestId('fix-workspace-refuses-chat-runs'))
    fireEvent.click(within(await within(module).findByTestId('fix-panel-workspace-refuses-chat-runs')).getByTestId('fix-apply-workspace-refuses-chat-runs'))

    const panel = await within(module).findByTestId('fix-panel-workspace-refuses-chat-runs')

    expect(await within(panel).findByText('/work/ws/roko.toml changed since the preview')).toBeTruthy()
    api.mockClear()
    fireEvent.click(within(panel).getByRole('button', { name: 'look again' }))
    await waitFor(() => expect(called('GET', '/setup/fix?action=workspace-chat-ready&variant=local')).toBe(true))
    expect(backend.applied).toEqual([])
  })

  it('cancel leaves the preview without applying anything', async () => {
    backend.problems = [PROBLEM_BOUNDARY]
    await mountPage()

    const module = await setupModule()

    fireEvent.click(within(module).getByTestId('fix-workspace-refuses-chat-runs'))
    fireEvent.click(within(await within(module).findByTestId('fix-panel-workspace-refuses-chat-runs')).getByRole('button', { name: 'cancel' }))
    expect(within(module).queryByTestId('fix-panel-workspace-refuses-chat-runs')).toBeNull()
    expect(backend.applied).toEqual([])
  })

  it('a backend without the fix route (404) says to restart Hermes, not that something broke', async () => {
    backend.problems = [PROBLEM_BOUNDARY]
    backend.fixRouteMissing = true
    await mountPage()

    const module = await setupModule()

    fireEvent.click(within(module).getByTestId('fix-workspace-refuses-chat-runs'))
    expect(await within(module).findByText(/still runs the roko backend from before your update/)).toBeTruthy()
    expect(within(module).getByText(/Quit Hermes with ⌘Q/)).toBeTruthy()
  })

  it('a blocking problem disables the composer’s start key and shows the problem with its fix in place', async () => {
    backend.problems = [PROBLEM_BOUNDARY]
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const dialog = await screen.findByRole('dialog', { name: 'New roko run' })

    fireEvent.change(within(dialog).getByLabelText('What should roko do?'), { target: { value: 'Add a --json flag' } })

    const submit = within(dialog).getByTestId('composer-submit') as HTMLButtonElement
    const card = within(dialog).getByTestId('problem-card-workspace-refuses-chat-runs')

    expect(submit.disabled).toBe(true)
    expect(submit.title).toBe('roko refuses runs started from Hermes in this workspace.')
    expect(within(card).getByText('roko can’t start work from Hermes until this is fixed:')).toBeTruthy()
    expect(within(card).getByTestId('fix-workspace-refuses-chat-runs')).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('a refused start shows the problem roko named, not a raw error', async () => {
    backend.refuseWith = PROBLEM_BOUNDARY
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const dialog = await screen.findByRole('dialog', { name: 'New roko run' })

    fireEvent.change(within(dialog).getByLabelText('What should roko do?'), { target: { value: 'Add a --json flag' } })
    fireEvent.click(within(dialog).getByTestId('composer-submit'))

    const card = await within(dialog).findByTestId('problem-card-workspace-refuses-chat-runs')

    expect(within(card).getByText('roko did not start it:')).toBeTruthy()
    expect(within(card).getByText('Its roko.toml has no data-model boundary, so roko turns down every run a chat starts.')).toBeTruthy()
    expect(dialog.querySelector('.roko-result[data-tone=bad]')).toBeNull()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('a blocking problem disables Run plan…, with the problem beside it', async () => {
    backend.problems = [PROBLEM_BOUNDARY]
    await mountPage()
    const card = await openPlan('add-tests')
    const key = within(card).getByTestId('run-plan') as HTMLButtonElement

    expect(key.disabled).toBe(true)
    expect(within(card).getByTestId('problem-card-workspace-refuses-chat-runs')).toBeTruthy()
  })

  it('a refused plan run closes the confirm and shows the problem with its fix', async () => {
    backend.refuseWith = PROBLEM_BOUNDARY
    await mountPage()
    const card = await openPlan('add-tests')

    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue…' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Start a paid roko run?' })).getByRole('button', { name: 'Run plan' }))

    const refused = await screen.findByRole('dialog', { name: 'roko did not start the plan' })

    expect(within(refused).getByTestId('problem-card-workspace-refuses-chat-runs')).toBeTruthy()
    expect(within(refused).getByTestId('fix-workspace-refuses-chat-runs')).toBeTruthy()
    fireEvent.keyDown(refused, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'roko did not start the plan' })).toBeNull())
  })

  it('the monitor pane shows the first problem compactly, and the restart when there is one', async () => {
    backend.problems = [PROBLEM_BOUNDARY, PROBLEM_MODEL]
    mountContribution('panes', 'roko:monitor')

    const strip = await screen.findByTestId('setup-strip')

    expect(strip.getAttribute('data-severity')).toBe('block')
    expect(within(strip).getByText('roko refuses runs started from Hermes in this workspace.')).toBeTruthy()
    expect(within(strip).getByText('+1')).toBeTruthy()
    expect(within(strip).getByText('make ready')).toBeTruthy()

    cleanup()
    backend.install = null
    queryClient.removeQueries({ queryKey: ['roko'] })
    mountContribution('panes', 'roko:monitor')

    const banner = await screen.findByTestId('restart-banner')

    expect(banner.getAttribute('data-compact')).toBe('true')
  })
})

describe('0.7 serve and projects', () => {
  const enc = encodeURIComponent
  const navLabel = () => (contribution('sidebar.nav', 'roko:nav')?.data as { label: string }).label
  // plugin-core's words (serve.py): the code, roko's message and the hint, and the log's last lines.
  const failed = () => serveState(PROJECT_WS, 'failed', { error: serveError('start_failed'), log_tail: ['error: could not bind 127.0.0.1:6912', HOSTILE_LINE, 'roko serve: exiting'] })
  const pickInHeader = async (name: RegExp) => {
    fireEvent.click(screen.getByTestId('project-switch'))
    fireEvent.click(within(await screen.findByTestId('project-menu')).getByRole('radio', { name }))
  }

  afterEach(async () => {
    // The page keeps the project it shows per window: go back to the default for the tests after these.
    cleanup()
    localStorage.removeItem('roko.project')
    backend.projects = null
    await reloadPlugin()
  })

  it('every serve state shows in the banner, the header, the chip and the sidebar row, and is said once', async () => {
    backend.projects = [projectRow(PROJECT_WS)]
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'starting')
    // Nothing waits on the person, so the sidebar row has room for the serve's state.
    backend.pending = []
    await mountPage()
    mountContribution('statusBar.right', 'roko:chip')

    const states: Array<[string, () => Record<string, unknown>, string, RegExp]> = [
      ['starting', () => serveState(PROJECT_WS, 'starting'), 'starting', /^roko serve is starting for ws…/],
      ['stopped', () => serveState(PROJECT_WS, 'stopped'), 'stopped', /^roko serve is not running for ws\./],
      ['failed', failed, 'failed to start', /^roko serve did not start for ws\./],
      ['outdated', () => serveState(PROJECT_WS, 'outdated', { error: serveError('no_mcp') }), 'outdated', /^The roko for ws is too old for Hermes\./],
      ['not_found', () => serveState(PROJECT_WS, 'not_found', { error: serveError('not_found') }), 'not found', /^Hermes cannot find roko on this machine\./]
    ]

    for (const [state, make, word, title] of states) {
      backend.serves[PROJECT_WS] = make()
      await refreshOverview()

      const banner = await screen.findByTestId('serve-banner')

      await waitFor(() => expect(banner.getAttribute('data-state')).toBe(state))
      expect(banner.textContent).toMatch(title)
      expect(screen.getByTestId('live-state').textContent).toBe(word)
      expect(screen.getByTestId('serve-said').textContent).toBe(`roko serve ${word}`)
      expect(screen.getByTestId('serve-said').getAttribute('aria-live')).toBe('polite')
      expect(screen.getByTestId('chip-serve').textContent).toBe(word)
      await waitFor(() => expect(navLabel()).toBe(`roko · ${word}`))
      // The banner says it: the backend's own row about the serve (roko-unreachable, roko-not-found) is not shown as well.
      expect(screen.queryByTestId('problem-roko-unreachable')).toBeNull()
      expect(screen.queryByTestId('problem-roko-not-found')).toBeNull()
    }

    // Starting: the light blinks rose and the word sweeps along the glass.
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'starting')
    await refreshOverview()
    await waitFor(() => expect(screen.getByTestId('serve-banner').getAttribute('data-state')).toBe('starting'))
    expect(screen.getByTestId('serve-banner').querySelector('.rk-led[data-tone=live][data-blink=slow]')).toBeTruthy()
    expect(screen.getByTestId('serve-banner').querySelector('.rk-dots[data-sweep=true]')).toBeTruthy()
    expect(screen.getByTestId('serve-starting').textContent).toMatch(/^0:0\d · usually ready within a minute$/)

    // Running: no banner, the header is live again on the serve's own URL; remote: the plugin never starts it.
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'running')
    await refreshOverview()
    await waitFor(() => expect(screen.queryByTestId('serve-banner')).toBeNull())
    expect(screen.getByTestId('serve-said').textContent).toBe('roko serve running')
    expect(screen.getByTestId('roko-connection').textContent).toBe('ok · 127.0.0.1:6912 · v0.1.0')
    expect(screen.queryByTestId('chip-serve')).toBeNull()
    await waitFor(() => expect(navLabel()).toBe('roko'))
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'remote', { url: 'https://roko.example.net' })
    await refreshOverview()
    await waitFor(() => expect(screen.getByTestId('roko-connection').textContent).toBe('ok · remote · roko.example.net · v0.1.0'))
    expect(screen.queryByTestId('serve-banner')).toBeNull()
  })

  it('a failed start shows the last lines of its log as text; a hint copies the command it quotes, and only that', async () => {
    backend.projects = [projectRow(PROJECT_WS)]
    backend.serves[PROJECT_WS] = failed()
    await mountPage()

    const banner = await screen.findByTestId('serve-banner')

    // roko's words, and the backend's hint as a sentence.
    expect(banner.textContent).toContain('roko serve exited before it answered (exit code 1)')
    expect(banner.querySelector('.rk-serve-hint')?.textContent).toBe("The log's last lines say why; `roko serve --workdir /work/ws` in a terminal shows the whole error.")
    expect(banner.querySelector('.rk-fix-cmd')?.textContent).toBe('roko serve --workdir /work/ws')
    expect(within(banner).queryByTestId('serve-log')).toBeNull()
    fireEvent.click(within(banner).getByTestId('serve-log-key'))

    const log = within(banner).getByTestId('serve-log')

    expect(log.textContent).toBe(`error: could not bind 127.0.0.1:6912\n${HOSTILE_LINE}\nroko serve: exiting\n`)
    expect(log.querySelector('img')).toBeNull()
    expect(within(banner).getByTestId('serve-start').textContent).toBe('start again')

    // No roko: the install command copies.
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'not_found', { error: serveError('not_found') })
    await refreshOverview()
    await waitFor(() => expect(banner.getAttribute('data-state')).toBe('not_found'))
    expect(banner.querySelector('.rk-fix-cmd')?.textContent).toBe('cargo install --path crates/roko-cli')
    fireEvent.click(within(banner).getByTestId('serve-fix-copy'))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('cargo install --path crates/roko-cli'))
    expect(within(banner).queryByTestId('serve-start')).toBeNull()

    // A roko too old to start a serve: the update command; a running serve without /mcp: words only, and its restart key.
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'outdated', { url: null, pid: null, actions: [], error: serveError('too_old') })
    await refreshOverview()
    await waitFor(() => expect(banner.querySelector('.rk-fix-cmd')?.textContent).toBe('git pull && cargo install --path crates/roko-cli'))
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'outdated', { error: serveError('no_mcp') })
    await refreshOverview()
    await waitFor(() => expect(banner.querySelector('.rk-serve-hint')?.textContent).toBe('Update roko, then restart roko serve (Restart on the roko page).'))
    expect(banner.querySelector('.rk-fix-cmd')).toBeNull()
    expect(within(banner).queryByTestId('serve-fix-copy')).toBeNull()
    expect(within(banner).getByTestId('serve-restart')).toBeTruthy()
  })

  it('Start: a stopped serve starts from the banner, the composer waits for it, and the page looks every 2 s until it runs', async () => {
    backend.projects = [projectRow(PROJECT_WS)]
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'stopped')
    backend.pending = []
    await mountPage()

    const banner = await screen.findByTestId('serve-banner')

    // One orange key a screen: starting roko serve is the thing to do, so new run steps back meanwhile.
    expect(within(banner).getByTestId('serve-start').getAttribute('data-tone')).toBe('primary')
    expect(screen.getByTestId('new-run').getAttribute('data-tone')).toBeNull()
    expect(screen.getByTestId('roko-connection').textContent).toBe(`roko serve stopped · ${PROJECT_WS}`)
    fireEvent.click(within(banner).getByTestId('serve-start'))
    await waitFor(() => expect(backend.servePosts).toEqual([{ action: 'start', project: PROJECT_WS }]))
    await waitFor(() => expect(screen.getByTestId('serve-banner').getAttribute('data-state')).toBe('starting'))

    // A request can be written meanwhile; its start key waits for roko serve, which the composer says.
    fireEvent.click(screen.getByTestId('new-run'))

    const dialog = await screen.findByRole('dialog', { name: 'New roko run' })

    fireEvent.change(within(dialog).getByLabelText('What should roko do?'), { target: { value: 'Add a --json flag' } })
    expect(within(dialog).getByTestId('serve-banner').getAttribute('data-state')).toBe('starting')
    expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).getByTestId('composer-serve-said').textContent).toBe('roko serve starting')

    // roko serve answers: nothing is refetched by hand, the page's own look every 2 s finds it.
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'running')
    await waitFor(() => expect(within(dialog).queryByTestId('serve-banner')).toBeNull(), { timeout: 4_500 })
    expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(false)
    // Said inside the dialog, where assistive tech is while it is open.
    expect(within(dialog).getByTestId('composer-serve-said').textContent).toBe('roko serve running')
    expect(screen.queryByTestId('serve-banner')).toBeNull()
    expect(screen.getByTestId('new-run').getAttribute('data-tone')).toBe('primary')
    fireEvent.keyDown(dialog, { key: 'Escape' })
  })

  it('a busy restart asks first, naming the runs it stops, then sends force; a stop the backend finds busy asks too', async () => {
    backend.projects = [projectRow(PROJECT_WS)]
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'running', { busy: { active_runs: 1 } })
    backend.serveBusy = 1
    mountContribution('settings.plugins', 'roko:settings')

    const page = await screen.findByTestId('roko-settings')

    expect((await within(page).findByTestId('settings-serve')).textContent).toBe(' running · ws · pid 4242 · started by Hermes · stops after 60 idle minutes')
    fireEvent.click(within(page).getByTestId('serve-restart'))

    const confirm = await screen.findByRole('dialog', { name: 'Restart roko serve while runs are going?' })

    expect(confirm.textContent).toContain('1 run is going in ws: restarting roko serve stops it. What passed is kept.')
    expect(within(confirm).getByTestId('serve-busy-runs').textContent).toContain('add-tests')
    // Asked first: nothing was sent yet.
    expect(backend.servePosts).toEqual([])
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restart roko serve' }))
    await waitFor(() => expect(backend.servePosts).toEqual([{ action: 'restart', force: true, project: PROJECT_WS }]))

    // The overview did not know it was busy; the backend does, and says so: the same question, in its words.
    backend.servePosts = []
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'running')
    backend.serveBusy = 2
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'overview'] })
    })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Restart roko serve while runs are going?' })).toBeNull())
    fireEvent.click(await within(page).findByTestId('serve-stop'))

    const asked = await screen.findByRole('dialog', { name: 'Stop roko serve while runs are going?' })

    expect(asked.textContent).toContain('2 runs are going in ws; stopping roko serve stops them.')
    expect(backend.servePosts).toEqual([{ action: 'stop', project: PROJECT_WS }])
    fireEvent.click(within(asked).getByRole('button', { name: 'Stop roko serve' }))
    await waitFor(() => expect(backend.servePosts.at(-1)).toEqual({ action: 'stop', force: true, project: PROJECT_WS }))
    // stop waits for roko serve and answers its new state.
    await waitFor(() => expect(within(page).getByTestId('settings-serve').textContent).toMatch(/^ stopped · ws/))
  })

  it('the composer picks the project: the projects, choose folder… (POST /projects add), and set up roko in a new one', async () => {
    backend.projects = [projectRow(PROJECT_WS), projectRow(PROJECT_SYNTH)]
    await mountPage()
    fireEvent.click(await screen.findByTestId('new-run'))

    const dialog = await screen.findByRole('dialog', { name: 'New roko run' })
    const module = within(dialog).getByTestId('composer-project')

    expect(within(module).getByRole('radio', { name: 'ws, roko serve running, default' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(module).getByRole('radio', { name: /^pocket-synth/ }))
    await waitFor(() => expect(called('GET', `/overview?project=${enc(PROJECT_SYNTH)}`)).toBe(true))
    await waitFor(() => expect(within(module).getByRole('radio', { name: /^pocket-synth/ }).getAttribute('aria-checked')).toBe('true'))
    expect(localStorage.getItem('roko.project')).toBe(PROJECT_SYNTH)

    // A folder that is no git checkout: the backend's reason, nothing added.
    selectPaths.mockResolvedValueOnce(['/Users/someone/Downloads'])
    fireEvent.click(within(module).getByTestId('choose-folder'))
    expect(
      await within(module).findByText("/Users/someone/Downloads is not a git checkout, and roko works on branches of one. Make it one first: git -C '/Users/someone/Downloads' init, then commit what you have.")
    ).toBeTruthy()
    expect(selectPaths).toHaveBeenCalledWith(expect.objectContaining({ directories: true, multiple: false }))

    // A folder inside a checkout: the backend keeps its top folder, and the composer is now for it. It has no roko.toml:
    // its roko serve runs on roko's defaults, but roko refuses runs from Hermes there until it is set up.
    selectPaths.mockResolvedValueOnce(['/work/tally/src'])
    fireEvent.click(within(module).getByTestId('choose-folder'))
    await waitFor(() => expect(backend.projectPosts.at(-1)).toEqual({ action: 'add', path: '/work/tally/src' }))
    await waitFor(() => expect(within(module).getByRole('radio', { name: 'tally, roko serve running, needs setup' }).getAttribute('aria-checked')).toBe('true'))

    // roko is not set up there: start waits, and "set up roko here" says what it does (no diff: roko init writes the
    // file), then applies it.
    fireEvent.change(within(dialog).getByLabelText('What should roko do?'), { target: { value: 'Add a --json flag' } })

    const card = await within(dialog).findByTestId('problem-card-project-needs-setup')

    expect(card.textContent).toContain("roko isn't set up for runs from Hermes in tally.")
    expect(within(dialog).queryByTestId('serve-banner')).toBeNull()
    expect(within(dialog).getByTestId('composer-serve-said').textContent).toBe('roko serve running')
    expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(card).getByTestId('fix-project-needs-setup'))

    const panel = await within(card).findByTestId('fix-panel-project-needs-setup')

    expect(called('GET', `/setup/fix?action=setup-project&project=${enc('/work/tally')}`)).toBe(true)
    expect(panel.textContent).toContain('Set up roko in tally')
    expect(panel.textContent).toContain('Runs `roko init` in /work/tally')
    expect(panel.querySelector('.rk-fix-path')?.textContent).toBe('in /work/tally')
    expect(panel.textContent).toContain('Nothing is committed: commit roko.toml yourself when you are happy with it.')
    expect(panel.textContent).not.toContain('Nothing in the file changes.')
    expect(within(panel).queryByTestId('fix-preview')).toBeNull()
    fireEvent.click(within(card).getByTestId('fix-apply-project-needs-setup'))
    await waitFor(() => expect(backend.applied).toEqual([{ action: 'setup-project', digest: 'a3f1c2d4e5b6a7c8', project: '/work/tally' }]))

    // Set up (its serve restarted on the new roko.toml before the reply came): the run goes to that project at once.
    await waitFor(() => expect(within(dialog).queryByTestId('problem-card-project-needs-setup')).toBeNull())
    await waitFor(() => expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(within(dialog).getByTestId('composer-submit'))
    await waitFor(() => expect(api.mock.calls.some(([req]) => req.method === 'POST' && req.path === '/api/plugins/roko/runs' && (req.body as { project?: string }).project === '/work/tally')).toBe(true))
  })

  it('project-needs-setup (no roko.toml) still offers set up roko here: the backend’s row, once, while its serve runs on roko’s defaults', async () => {
    backend.projects = [projectRow(PROJECT_WS), projectRow('/work/tally', { needs_setup: true, ready: false, last_used: null })]
    backend.pending = []
    await mountPage()
    await pickInHeader(/^tally/)

    const module = await screen.findByTestId('setup-module')
    const row = await within(module).findByTestId('problem-project-needs-setup')

    expect(row.textContent).toContain("roko isn't set up for runs from Hermes in tally.")
    expect(within(row).getByTestId('fix-project-needs-setup').textContent).toBe('set up roko here')
    expect(within(module).getAllByTestId('problem-project-needs-setup')).toHaveLength(1)
    // Its serve runs: no serve banner, and nothing calls the project "not set up" in place of the serve's state.
    expect(screen.queryByTestId('serve-banner')).toBeNull()
    expect(screen.getByTestId('serve-said').textContent).toBe('roko serve running')
    expect(screen.queryByText(/not set up/)).toBeNull()
  })

  it('no model provider: the failed banner says roko’s words and copies the key fix; no separate row, no set up roko here', async () => {
    // roko's not_initialized (round 1): no LLM provider. Here also in a checkout without roko.toml: the key comes first.
    backend.projects = [projectRow(PROJECT_WS, { needs_setup: true, ready: false })]
    backend.serves[PROJECT_WS] = noProvider(PROJECT_WS)
    await mountPage()
    mountContribution('statusBar.right', 'roko:chip')

    const banner = await screen.findByTestId('serve-banner')

    expect(banner.getAttribute('data-state')).toBe('failed')
    expect(banner.textContent).toContain('roko serve did not start for ws.')
    expect(banner.textContent).toContain('/work/ws is not set up for roko: no LLM provider configured.')
    expect(banner.querySelector('.rk-serve-hint')?.textContent).toBe('Give roko a model key: a line such as OPENAI_API_KEY=… in ~/.roko/.env, or run `hermes roko init --workdir /work/ws`, which offers the key Hermes has.')
    expect(banner.querySelector('.rk-fix-cmd')?.textContent).toBe('hermes roko init --workdir /work/ws')
    fireEvent.click(within(banner).getByTestId('serve-fix-copy'))
    await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith('hermes roko init --workdir /work/ws'))
    expect(within(banner).getByTestId('serve-start').textContent).toBe('start again')
    // The banner is the backend's no-model-provider row; nothing offers to set roko up for it.
    expect(screen.queryByTestId('problem-no-model-provider')).toBeNull()
    expect(screen.queryByTestId('fix-project-needs-setup')).toBeNull()
    expect(screen.queryByText(/not set up in ws/)).toBeNull()
    expect(screen.getByTestId('live-state').textContent).toBe('failed to start')
    expect(screen.getByTestId('chip-serve').textContent).toBe('failed to start')
  })

  it('set up roko here in the setup module says what roko init creates (the backend’s summary, else its own line), never “Nothing in the file changes.”', async () => {
    backend.projects = [projectRow(PROJECT_WS), projectRow('/work/tally', { needs_setup: true, ready: false, last_used: null })]
    await mountPage()
    await pickInHeader(/^tally/)

    const row = await within(await screen.findByTestId('setup-module')).findByTestId('problem-project-needs-setup')

    fireEvent.click(within(row).getByTestId('fix-project-needs-setup'))

    // The backend's summary says what roko init writes: the panel shows that, and the project's path, nothing else.
    let panel = await within(row).findByTestId('fix-panel-project-needs-setup')

    expect(panel.querySelector('.rk-fix-summary')?.textContent).toMatch(/^Runs `roko init` in \/work\/tally: it writes roko\.toml .* and roko's `\.roko\/` folder\./)
    expect(panel.querySelector('.rk-fix-path')?.textContent).toBe('in /work/tally')
    expect(panel.textContent).not.toContain('Nothing in the file changes.')
    expect(panel.textContent).not.toContain('changes /work/tally')

    // A backend that sends no summary (its preview is empty: roko.toml does not exist yet): the page says it itself.
    backend.setupSummary = false
    fireEvent.click(within(panel).getByRole('button', { name: 'cancel' }))
    fireEvent.click(within(row).getByTestId('fix-project-needs-setup'))
    panel = await within(row).findByTestId('fix-panel-project-needs-setup')
    expect(panel.querySelector('.rk-fix-summary')?.textContent).toBe('roko init writes roko.toml and .roko/ in tally.')
    expect(panel.textContent).not.toContain('Nothing in the file changes.')
  })

  it('the header switches the project the page shows, keeps it for the window, and goes back to the default', async () => {
    backend.projects = [projectRow(PROJECT_WS), projectRow(PROJECT_SYNTH)]
    backend.serves[PROJECT_SYNTH] = serveState(PROJECT_SYNTH, 'stopped')
    await mountPage()

    const key = await screen.findByTestId('project-switch')

    expect(key.textContent).toBe('ws')
    fireEvent.click(key)

    const menu = await screen.findByTestId('project-menu')

    expect(within(menu).getAllByRole('radio').map(r => r.getAttribute('aria-label'))).toEqual(['ws, roko serve running, default', 'pocket-synth, roko serve stopped'])
    fireEvent.click(within(menu).getByRole('radio', { name: /^pocket-synth/ }))
    await waitFor(() => expect(screen.getByTestId('project-switch').textContent).toBe('pocket-synth'))
    expect(localStorage.getItem('roko.project')).toBe(PROJECT_SYNTH)

    // The page is that project's: its serve, its plans.
    expect((await screen.findByTestId('serve-banner')).getAttribute('data-state')).toBe('stopped')
    expect(screen.getByTestId('serve-banner').textContent).toContain('roko serve is not running for pocket-synth.')
    openTab(/^Plans/)
    await waitFor(() => expect(called('GET', `/plans?project=${enc(PROJECT_SYNTH)}`)).toBe(true))

    // Back to the default project: 0.6's routes, nothing kept.
    await pickInHeader(/^ws/)
    await waitFor(() => expect(screen.getByTestId('project-switch').textContent).toBe('ws'))
    expect(localStorage.getItem('roko.project')).toBeNull()
    await waitFor(() => expect(screen.queryByTestId('serve-banner')).toBeNull())
  })

  it('a project Hermes no longer knows, kept from an earlier visit, gives way to the default', async () => {
    backend.projects = [projectRow(PROJECT_WS)]
    localStorage.setItem('roko.project', '/work/gone')
    await setPluginEnabled('roko', false)
    await setPluginEnabled('roko', true)
    // The backend refuses it (`invalid`): the window forgets it.
    await waitFor(() => expect(called('GET', `/overview?project=${enc('/work/gone')}`)).toBe(true))
    await waitFor(() => expect(localStorage.getItem('roko.project')).toBeNull())
    await mountPage()
    await waitFor(() => expect(screen.getByTestId('project-switch').textContent).toBe('ws'))
    expect(screen.queryByTestId('pick-project')).toBeNull()
  })

  it('runs say their project once more than one is known; a socket serve frame ends the banner at once', async () => {
    backend.projects = [projectRow(PROJECT_WS), projectRow(PROJECT_SYNTH)]
    backend.runs = backend.runs.map(row => ({ ...row, project: row.run_id === RUN_ACTIVE ? { path: PROJECT_SYNTH, name: 'pocket-synth' } : { path: PROJECT_WS, name: 'ws' } }))
    await mountPage({ run: RUN_ACTIVE })

    // The run's page says its project once; what waits on it there needs no tag of its own.
    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(within(card).getAllByTestId('run-project')).toHaveLength(1))
    expect(within(card).getByTestId('run-project').getAttribute('title')).toBe(PROJECT_SYNTH)
    // On Runs, each run says its own.
    fireEvent.click(screen.getByTestId('crumb-runs'))

    const rows = await screen.findByRole('list', { name: 'roko runs' })

    expect(within(rows).getAllByTestId('run-project').map(el => el.textContent)).toEqual(['ws', 'ws', 'ws'])
    expect(within(screen.getByRole('region', { name: 'Running' })).getByTestId('run-project').textContent).toBe('pocket-synth')

    // One project: nothing to tell apart.
    backend.projects = [projectRow(PROJECT_WS)]
    await refreshOverview()
    await waitFor(() => expect(screen.queryAllByTestId('run-project')).toHaveLength(0))

    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'starting')
    await refreshOverview()
    expect((await screen.findByTestId('serve-banner')).getAttribute('data-state')).toBe('starting')

    const socket = await openSocket()

    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'running')
    push(socket, { type: 'serve', serve: serveState(PROJECT_WS, 'running') })
    await waitFor(() => expect(screen.queryByTestId('serve-banner')).toBeNull())
  })

  it('no project yet: the page, the chip and the sidebar row ask for one; choose folder… adds it and the page shows it', async () => {
    backend.projects = []
    backend.pending = []
    await mountPage()
    mountContribution('statusBar.right', 'roko:chip')

    const pick = await screen.findByTestId('pick-project')

    expect(pick.textContent).toContain('Pick the project roko works in.')
    expect(screen.getByTestId('live-state').textContent).toBe('no project')
    expect(screen.getByTestId('chip-pick').textContent).toBe('no project')
    await waitFor(() => expect(navLabel()).toBe('roko · no project'))
    // No serve to reach: no red banner, and the backend's "No project is chosen" row is the pick itself.
    expect(screen.queryByTestId('problem-roko-unreachable')).toBeNull()
    expect(document.querySelector('.roko-banner[data-tone=bad]')).toBeNull()
    expect(screen.getByTestId('project-switch').textContent).toBe('pick a project')

    // The composer's 00 PROJECT is where it is picked; start waits for it.
    fireEvent.click(screen.getByTestId('new-run'))

    const dialog = await screen.findByRole('dialog', { name: 'New roko run' })

    expect(within(dialog).getByTestId('composer-project').textContent).toContain('none yet')
    expect(within(dialog).queryAllByRole('radio', { name: /roko serve/ })).toHaveLength(0)
    expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    expect(within(dialog).getByTestId('choose-folder').getAttribute('data-tone')).toBe('primary')
    selectPaths.mockResolvedValueOnce(['/work/tally'])
    fireEvent.click(within(dialog).getByTestId('choose-folder'))
    await waitFor(() => expect(backend.projectPosts).toEqual([{ action: 'add', path: '/work/tally' }]))
    // The backend names the project it added; the page shows it (the first project is the default).
    await waitFor(() => expect(screen.getByTestId('project-switch').textContent).toBe('tally'))
    expect(localStorage.getItem('roko.project')).toBeNull()
    await waitFor(() => expect(screen.queryByTestId('pick-project')).toBeNull())
    fireEvent.keyDown(dialog, { key: 'Escape' })
  })

  it('actions from the app off: no choose folder (the backend refuses adds then), and the CLI line says how', async () => {
    backend.projects = []
    backend.canWrite = false
    await mountPage()

    const pick = await screen.findByTestId('pick-project')

    expect(pick.textContent).toContain('In a terminal: hermes roko projects add <path>')
    expect(within(pick).queryByTestId('choose-folder')).toBeNull()

    backend.projects = [projectRow(PROJECT_WS), projectRow(PROJECT_SYNTH)]
    await refreshOverview()
    await waitFor(() => expect(screen.getByTestId('project-switch').textContent).toBe('ws'))
    fireEvent.click(screen.getByTestId('project-switch'))
    expect(within(await screen.findByTestId('project-menu')).queryByTestId('choose-folder')).toBeNull()
  })

  it('a remote roko serve without a project is no "no project": nothing to pick, the connection says where', async () => {
    backend.projects = []
    backend.remoteUrl = 'https://roko.example.net'
    await mountPage()
    await waitFor(() => expect(screen.getByTestId('roko-connection').textContent).toBe('ok · remote · roko.example.net · v0.1.0'))
    expect(screen.queryByTestId('pick-project')).toBeNull()
    expect(screen.queryByTestId('project-switch')).toBeNull()
    expect(screen.queryByTestId('serve-banner')).toBeNull()
    expect(screen.getByTestId('live-state').textContent).not.toBe('no project')
  })

  it('a setup card about the project shown acts on that project: fix.project rides the preview and the apply', async () => {
    backend.projects = [projectRow(PROJECT_WS), projectRow(PROJECT_SYNTH)]
    // roko serve runs in pocket-synth, but its roko refuses runs from Hermes; the backend's own rows carry the project.
    backend.problems = [
      { ...PROBLEM_BOUNDARY, fix: { ...(PROBLEM_BOUNDARY.fix as Record<string, unknown>), project: PROJECT_SYNTH } },
      { id: 'project-needs-setup', severity: 'block', title: "roko isn't set up for runs from Hermes in pocket-synth.", detail: 'It has no roko.toml.', fix: { kind: 'action', label: 'set up roko here', action: 'setup-project', command: null, docs: null, project: PROJECT_SYNTH } }
    ]
    await mountPage()
    await pickInHeader(/^pocket-synth/)
    await waitFor(() => expect(screen.getByTestId('project-switch').textContent).toBe('pocket-synth'))

    const module = await screen.findByTestId('setup-module')

    // The backend's setup row is shown once (the page derives none of its own).
    expect(within(module).getAllByTestId('problem-project-needs-setup')).toHaveLength(1)
    fireEvent.click(within(module).getByTestId('fix-workspace-refuses-chat-runs'))
    await within(module).findByTestId('fix-panel-workspace-refuses-chat-runs')
    expect(called('GET', `/setup/fix?action=workspace-chat-ready&project=${enc(PROJECT_SYNTH)}`)).toBe(true)
    fireEvent.click(within(module).getByTestId('fix-apply-workspace-refuses-chat-runs'))
    await waitFor(() => expect(backend.applied).toEqual([{ action: 'workspace-chat-ready', digest: 'digest-local', project: PROJECT_SYNTH, variant: 'local' }]))
  })

  it('restart roko serve as a setup fix: its summary, then a busy restart asks first and sends force; the serve says starting', async () => {
    backend.projects = [projectRow(PROJECT_WS)]
    backend.serveBusy = 1
    // readiness._outdated: roko serve runs but lacks a tool this plugin needs; restarting it on the newer roko fixes it.
    backend.problems = [
      {
        id: 'roko-serve-outdated',
        severity: 'block',
        title: 'roko serve is too old for this plugin.',
        detail: 'It lacks roko_plan_run, so plans cannot run from Hermes. Update roko, then restart roko serve.',
        fix: { kind: 'action', label: 'restart roko serve', action: 'restart-serve', command: `hermes roko serve restart --project ${PROJECT_WS}`, docs: 'troubleshooting.md#roko-serve-is-too-old', project: PROJECT_WS }
      }
    ]
    await mountPage()

    const row = await screen.findByTestId('problem-roko-serve-outdated')

    fireEvent.click(within(row).getByTestId('fix-roko-serve-outdated'))

    const panel = await within(row).findByTestId('fix-panel-roko-serve-outdated')

    expect(panel.textContent).toContain('Restart roko serve for ws')
    expect(panel.querySelector('.rk-fix-path')?.textContent).toBe('in /work/ws')
    expect(panel.textContent).toContain('1 run is going in ws: restarting stops it (their work so far is kept).')
    expect(panel.textContent).not.toContain('Nothing in the file changes.')
    fireEvent.click(within(panel).getByTestId('fix-apply-roko-serve-outdated'))

    // The backend refused it (busy) and did nothing: the page asks, in the backend's words, naming the run.
    const confirm = await screen.findByRole('dialog', { name: 'Restart roko serve while runs are going?' })

    expect(confirm.textContent).toContain('1 run is going in ws; restarting roko serve stops them.')
    expect(within(confirm).getByTestId('serve-busy-runs').textContent).toContain('add-tests')
    expect(backend.applied).toEqual([{ action: 'restart-serve', project: PROJECT_WS }])
    fireEvent.click(within(confirm).getByRole('button', { name: 'Restart roko serve' }))
    await waitFor(() => expect(backend.applied.at(-1)).toEqual({ action: 'restart-serve', force: true, project: PROJECT_WS }))

    // The reply's serve: the banner says starting at once.
    expect((await screen.findByTestId('serve-banner')).getAttribute('data-state')).toBe('starting')
    expect((await screen.findByTestId('fix-done-note')).textContent).toContain('roko serve is starting for ws.')
  })

  it('the project shown reaches /pending, /health and the live socket; switching it dials the socket again', async () => {
    backend.projects = [projectRow(PROJECT_WS), projectRow(PROJECT_SYNTH)]
    await mountPage()

    const first = await openSocket()

    expect(first.url).not.toContain('project=')
    await pickInHeader(/^pocket-synth/)
    await waitFor(() => expect(liveSocket()?.url).toContain(`project=${enc(PROJECT_SYNTH)}`))
    expect(first.readyState).toBe(3)

    openTab(/^Waiting/)
    await waitFor(() => expect(called('GET', `/pending?project=${enc(PROJECT_SYNTH)}`)).toBe(true))
    openTab(/^Insights/)
    await waitFor(() => expect(called('GET', `/health?project=${enc(PROJECT_SYNTH)}`)).toBe(true))
  })

  it('Waiting lists what waits in every project whose serve runs, each with its run’s project (an item names none)', async () => {
    backend.projects = [projectRow(PROJECT_WS), projectRow(PROJECT_SYNTH)]
    // The held call waits in RUN_ACTIVE, in pocket-synth; the sign-off in a run in ws.
    backend.runs = [
      { run_id: RUN_NEW, kind: 'run', label: 'Add a --json flag', state: 'running', cost_usd: 0.01, max_usd: 0.5, started_at: new Date().toISOString(), source: 'ui', project: { path: PROJECT_WS, name: 'ws' } },
      ...backend.runs.map(row => ({ ...row, project: row.run_id === RUN_ACTIVE ? { path: PROJECT_SYNTH, name: 'pocket-synth' } : { path: PROJECT_WS, name: 'ws' } }))
    ]
    backend.pending = backend.pending.map(item => (item.code === 'a1b2c3' ? { ...item, run_id: RUN_NEW } : item))
    await mountPage({ tab: 'waiting' })
    openTab(/^Waiting/)

    const confirm = await screen.findByTestId('pending-a1b2c3')
    const effect = await screen.findByTestId('pending-d4e5f6')

    expect(within(confirm).getByTestId('run-project').textContent).toBe('ws')
    expect(within(effect).getByTestId('run-project').textContent).toBe('pocket-synth')
    expect(called('GET', '/pending')).toBe(true)

    // pocket-synth's serve stops: what waits there cannot be asked for, so it leaves the list.
    backend.serves[PROJECT_SYNTH] = serveState(PROJECT_SYNTH, 'stopped')
    await refreshOverview()
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'pending'] })
    })
    await waitFor(() => expect(screen.queryByTestId('pending-d4e5f6')).toBeNull())
    expect(screen.getByTestId('pending-a1b2c3')).toBeTruthy()
  })

  it('the app opening asks the backend to ensure roko serve, once; an older backend’s 404 changes nothing', async () => {
    backend.projects = [projectRow(PROJECT_WS)]
    backend.serves[PROJECT_WS] = serveState(PROJECT_WS, 'stopped')
    await reloadPlugin()
    await waitFor(() => expect(backend.servePosts).toEqual([{ action: 'ensure' }]))
    expect(called('POST', '/serve')).toBe(true)
    // ensure started it: the overview says starting.
    expect(backend.serves[PROJECT_WS].state).toBe('starting')

    // With no project, ensure is refused (`invalid`, nothing to start): the page ignores it and asks for one.
    backend.projects = []
    backend.servePosts = []
    await reloadPlugin()
    await waitFor(() => expect(backend.servePosts).toEqual([{ action: 'ensure' }]))
    await mountPage()
    expect(await screen.findByTestId('pick-project')).toBeTruthy()
    cleanup()

    // A 0.6 backend has no /serve: the 404 is ignored and the page works as before.
    backend.reset()
    await reloadPlugin()
    await waitFor(() => expect(called('POST', '/serve')).toBe(true))
    await mountPage()
    expect(screen.getByTestId('roko-connection').textContent).toBe('ok · 127.0.0.1:6677 · v0.1.0')
    expect(screen.queryByTestId('restart-banner')).toBeNull()
    expect(screen.queryByTestId('project-switch')).toBeNull()
  })
})

describe('v7 (plugin-wow): the Ladder at scale, and honest tries', () => {
  /** A try roko charged to the provider (a 429): not the agent's, so never a ✕ and never toward a climb. */
  const refused = (attempt: number, rung: string) =>
    tryOf(attempt, rung, attempt === 1 ? 'start' : 'retry', 'failed', { blame: 'infra', verdict: 'provider_error', failed_check: null, key_line: null, why: 'the provider failed' })
  const many = (n: number, running: number) =>
    Array.from({ length: n }, (_, i) => ({
      task_id: `T${i + 1}`,
      title: `Task ${i + 1}`,
      outcome: i < running ? 'passed' : i === running ? 'running' : 'pending',
      attempts: i <= running ? 1 : 0,
      gates: [],
      depends_on: [],
      climb: i < running ? [tryOf(1, 'cheap', 'start', 'passed')] : i === running ? [tryOf(1, 'cheap', 'start', 'running')] : [],
      lives: null
    }))

  it('a try the provider refused is ∿, never a ✕: on the ladder, in the lives, and in why a task climbed', async () => {
    const failover = { model: 'gpt-oss-120b', provider: 'cerebras', class: 'rate_limited', why: 'rate limited' }
    const tasks = (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
      t.task_id === 'T2'
        ? { ...t, attempts: 2, climb: [refused(1, 'cheap'), tryOf(2, 'cheap', 'failover', 'passed', { failover })] }
        : t.task_id === 'T3'
          ? { ...t, attempts: 4, climb: [refused(1, 'cheap'), tryOf(2, 'cheap', 'retry', 'failed'), tryOf(3, 'cheap', 'retry', 'failed'), tryOf(4, 'mid', 'climb', 'running')] }
          : t
    )

    backend.runs = [ladderRow({ tasks }), ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const card = await screen.findByTestId(`run-card-${LADDER_RUN}`)
    const ladder = await within(card).findByTestId('ladder')
    const cheap = ladder.querySelector('.rk-rung[data-rung="cheap"]') as HTMLElement

    // T3's ghost on cheap is its two failed tries; the refused one is a ∿ beside it, and T2 has no ghost at all.
    expect([...cheap.querySelectorAll('.rk-tok[data-state="ghost"]')].map(g => g.textContent)).toEqual(['✕✕'])
    expect(within(ladder).getByTestId('ladder-refused-T3').textContent).toBe('∿')
    // T2 passed on cheap after the provider refused its first try: the ∿ under its token, never a ✕.
    expect([...within(ladder).getByTestId('ladder-marks-T2').querySelectorAll('i')].map(i => i.getAttribute('data-mark'))).toEqual(['i'])
    expect(cheap.getAttribute('aria-label')).toContain('T2 passed, after a provider refused 1 try')
    expect(cheap.getAttribute('aria-label')).toContain('T3 failed 2 times here and climbed')
    // The pads say the same: ∿ for the refused try.
    const lives = (node: string) => [...(card.querySelector(`.roko-node[data-node="${node}"]`) as HTMLElement).querySelectorAll('.rk-lives i')].map(i => i.getAttribute('data-life'))

    expect(lives('T2')).toEqual(['i', 'p'])
    expect(lives('T3')).toEqual(['i', 'x', 'x', 'r'])
    expect(ladder.querySelector('.rk-lad-foot')?.textContent).toContain('∿ provider refused')
  })

  it('a task that passed on strong after failing there shows that ✕ before its ✓', async () => {
    const climb = [
      tryOf(1, 'cheap', 'start', 'failed'),
      tryOf(2, 'cheap', 'retry', 'failed'),
      tryOf(3, 'mid', 'climb', 'failed'),
      tryOf(4, 'mid', 'retry', 'failed'),
      tryOf(5, 'strong', 'climb', 'failed'),
      tryOf(6, 'strong', 'retry', 'passed')
    ]
    const tasks = (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T3' ? { ...t, outcome: 'passed', attempts: 6, climb, lives: { rung: 'strong', used: 2, of: 2 } } : t))

    backend.runs = [ladderRow({ tasks }), ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    const ladder = await within(await screen.findByTestId(`run-card-${LADDER_RUN}`)).findByTestId('ladder')
    const rung = (name: string) => ladder.querySelector(`.rk-rung[data-rung="${name}"]`) as HTMLElement

    expect(rung('strong').querySelector('[data-testid="ladder-token-T3"]')?.getAttribute('data-state')).toBe('passed')
    expect([...within(ladder).getByTestId('ladder-marks-T3').querySelectorAll('i')].map(i => i.getAttribute('data-mark'))).toEqual(['x'])
    expect(rung('mid').querySelector('.rk-tok[data-state="ghost"]')?.textContent).toBe('✕✕')
    expect(rung('cheap').querySelector('.rk-tok[data-state="ghost"]')?.textContent).toBe('✕✕')
    expect(rung('strong').getAttribute('aria-label')).toContain('T3 passed, after 1 failed try here')
  })

  it('a long phase fits: eight tasks keep their labels; fourteen go dense, ids in titles, the running one named; thirty are dots', async () => {
    backend.runs = [ladderRow({ tasks: many(8, 3) }), ...backend.runs]
    await mountPage({ run: LADDER_RUN })

    let ladder = await within(await screen.findByTestId(`run-card-${LADDER_RUN}`)).findByTestId('ladder')

    expect(ladder.getAttribute('data-density')).toBeNull()
    expect(within(ladder).getByTestId('ladder-token-T2').textContent).toBe('T2')

    cleanup()
    queryClient.removeQueries({ queryKey: ['roko'] })
    // T4 passed on cheap after a failed try there: dense, that is a red corner mark on its square.
    const fourteen = many(14, 9).map(t => (t.task_id === 'T4' ? { ...t, attempts: 2, climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'passed')] } : t))

    backend.runs = backend.runs.map(row => (row.run_id === LADDER_RUN ? ladderRow({ tasks: fourteen }) : row))
    await mountPage({ run: LADDER_RUN })
    ladder = await within(await screen.findByTestId(`run-card-${LADDER_RUN}`)).findByTestId('ladder')
    expect(ladder.getAttribute('data-density')).toBe('dense')
    expect(ladder.querySelectorAll('.rk-tok:not(.rk-tok-echo)')).toHaveLength(14)
    expect(within(ladder).getByTestId('ladder-token-T3').textContent).toBe('')
    expect(within(ladder).getByTestId('ladder-token-T3').getAttribute('title')).toContain('T3 passed')
    expect(within(ladder).getByTestId('ladder-token-T10').textContent).toBe('T10')
    expect(within(ladder).getByTestId('ladder-token-T4').getAttribute('data-marked')).toBe('x')
    expect(within(ladder).getByTestId('ladder-token-T4').getAttribute('title')).toContain('T4 passed, after 1 failed try here')

    cleanup()
    queryClient.removeQueries({ queryKey: ['roko'] })
    backend.runs = backend.runs.map(row => (row.run_id === LADDER_RUN ? ladderRow({ tasks: many(30, 20) }) : row))
    await mountPage({ run: LADDER_RUN })
    ladder = await within(await screen.findByTestId(`run-card-${LADDER_RUN}`)).findByTestId('ladder')
    expect(ladder.getAttribute('data-density')).toBe('dots')
    expect(ladder.querySelectorAll('.rk-tok:not(.rk-tok-echo)')).toHaveLength(30)
  })
})

describe('v7 (plugin-wow): build glass, a C++ check read as an instrument', () => {
  const BUILD = [
    '$ cmake --preset core && cmake --build --preset core --target spec_p3_tone',
    '-- Configuring done (1.8s)',
    '[  9%] Building CXX object core/CMakeFiles/undertow_core.dir/src/Version.cpp.o',
    '[ 27%] Building CXX object core/CMakeFiles/undertow_core.dir/src/SineOsc.cpp.o',
    '[ 45%] Building CXX object core/CMakeFiles/undertow_core.dir/src/Oversampler.cpp.o'
  ]
  const ERROR = [
    '[ 61%] Building CXX object core/CMakeFiles/undertow_core.dir/src/RumbleTone.cpp.o',
    "/Users/x/dev/undertow/core/src/RumbleTone.cpp:84:23: error: no member named 'tanhApprox' in namespace 'undertow::dsp'",
    '   84 |     const float y = dsp::tanhApprox(g * (x - k * s4));',
    '      |                     ~~~~~^',
    "/Users/x/dev/undertow/core/src/RumbleTone.cpp:91:9: warning: unused variable 'drive' [-Wunused-variable]",
    '1 warning and 1 error generated.'
  ]
  const DOCTEST = [
    'tests/spec/p0/engine_test.cpp:41:',
    'TEST CASE:  P0.05 the audio thread does not allocate',
    '',
    'tests/spec/p0/engine_test.cpp:52: ERROR: CHECK( count == 0 ) is NOT correct!',
    '  values: CHECK( 2 == 0 )',
    '',
    '[doctest] test cases:  4 |  3 passed | 1 failed | 0 skipped',
    '[doctest] Status: FAILURE!'
  ]
  // Each test its own run: the window keeps a run's live items and each check's lines by run.
  const RUNS = ['b1d2e3f4-0a1b-4c2d-8e3f-000000000071', 'b1d2e3f4-0a1b-4c2d-8e3f-000000000072', 'b1d2e3f4-0a1b-4c2d-8e3f-000000000073', 'b1d2e3f4-0a1b-4c2d-8e3f-000000000074']
  const building = (id: string) =>
    ladderRow({ run_id: id, tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T3' ? { ...t, step: 'check', step_detail: 'verify[0:build]', step_since: new Date(Date.now() - 20_000).toISOString() } : t)) })
  const line = (socket: FakeSocket, id: string, lines: string[], attempt = 3) =>
    push(socket, { attempt, gate: 'verify[0:build]', kind: 'check', line: lines.at(-1), plan_id: 'tally-budgets', run_id: id, stream: 'stdout', tail: lines.slice(-12), task_id: 'T3', ts: Date.now(), type: 'live' })

  it('a build shows how far it is and what compiles now, on the stream, the pad and the horizon; its error becomes a hazard card', async () => {
    const id = RUNS[0]

    backend.runs = [building(id), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const stream = await within(card).findByTestId('stream')
    const socket = await openSocket()

    // Two items, the second with only the newest lines: the glass reads the whole check as the window heard it.
    line(socket, id, BUILD.slice(0, 4))
    line(socket, id, BUILD)

    const meter = await within(stream).findByTestId('build-meter')

    expect(within(meter).getByRole('img', { name: 'built 45%' })).toBeTruthy()
    expect(meter.textContent).toContain('compiling Oversampler.cpp')
    expect(meter.textContent).toContain('3 units · 0 warnings')
    // Under a glass the raw lines are only the newest three, and none the meter already says (a progress line's
    // object path wraps into noise in the narrow stream).
    const raw = [...within(stream).getByTestId('stream-check').querySelectorAll('span')].map(s => s.textContent ?? '')

    expect(raw.length).toBeLessThanOrEqual(3)
    expect(raw.some(l => /\[\s*\d+%\]/.test(l))).toBe(false)
    await waitFor(() => expect(within(card).getByTestId('pad-check-T3').textContent).toBe('45%'))
    expect(within(card).getByTestId('pad-check-T3').getAttribute('title')).toBe('building 45% · Oversampler.cpp')
    await waitFor(() => expect(within(card).getByTestId('horizon').textContent).toContain('building 45% · Oversampler.cpp'))

    // The compiler stops: a hazard card with where, what, the source line and its caret; no account path on screen.
    line(socket, id, [...BUILD, ...ERROR])

    const hazard = await within(stream).findByTestId('build-hazard')

    expect(hazard.querySelector('.rk-hz-loc')?.textContent).toBe('core/src/RumbleTone.cpp:84:23')
    expect(hazard.querySelector('.rk-hz-msg')?.textContent).toBe("error: no member named 'tanhApprox' in namespace 'undertow::dsp'")
    // The source line loses only the indent it shares with its caret line, so the caret still points where the
    // compiler pointed.
    expect(hazard.querySelector('.rk-hz-code')?.textContent).toContain('84 │ const float y = dsp::tanhApprox(g * (x - k * s4));')
    expect(hazard.querySelector('.rk-hz-caret')?.textContent).toContain('^')
    expect(hazard.textContent).toContain('1 warning')
    expect(stream.querySelector('[data-testid="build-glass"]')?.textContent).not.toContain('/Users/x')
    await waitFor(() => expect(within(card).getByTestId('horizon').textContent).toContain("✕ RumbleTone.cpp:84 no member named 'tanhApprox'"))
  })

  it('tests read as pips with the first failure and what it saw, in the stream and the task’s sheet', async () => {
    const tail = { attempt: 3, gate: 'verify[1:test]', passed: false, command: 'tools/spec.sh 0 engine', exit_code: 1, duration_ms: 1_840, lines: DOCTEST, live: false }
    const failedTry = tryOf(3, 'mid', 'climb', 'failed', { failed_check: 'verify[1:test]', key_line: 'tests/spec/p0/engine_test.cpp:52: ERROR: CHECK( count == 0 ) is NOT correct!' })
    const id = RUNS[1]
    const row = ladderRow({
      run_id: id,
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T3' ? { ...t, climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'failed'), failedTry, tryOf(4, 'mid', 'retry', 'running')], check_tail: tail } : t))
    })

    backend.runs = [row, ...backend.runs]
    backend.eventsFor[id] = [
      { cursor: 10, type: 'agent_spawned', group: 'agent', task_id: 'T3', attempt: 3, model: 'glm-4.7', ts_millis: Date.now() - 30_000, text: 'T3 attempt 3 on glm-4.7' },
      { cursor: 11, type: 'gate_result', group: 'gate', task_id: 'T3', gate: 'verify[1:test]', passed: false, ts_millis: Date.now() - 20_000, text: 'T3 gate verify[1:test] did not pass' }
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const stream = await within(card).findByTestId('stream')
    const pips = await within(stream).findByTestId('test-pips')

    expect(pips.querySelectorAll('.rk-tp-pips i')).toHaveLength(4)
    expect(pips.querySelectorAll('.rk-tp-pips i[data-pip="f"]')).toHaveLength(1)
    expect(pips.querySelector('.rk-tp-count')?.textContent).toBe('✕ 3 of 4 passed')
    expect(pips.querySelector('.rk-tp-fail b')?.textContent).toBe('✕ P0.05 the audio thread does not allocate')
    expect(pips.querySelector('.rk-tp-expr')?.textContent).toBe('CHECK( count == 0 ) · saw CHECK( 2 == 0 )')

    // The task's sheet reads the same check.
    fireEvent.click(card.querySelector('.roko-node[data-node="T3"]') as HTMLElement)

    const sheet = await within(card).findByTestId('inspector-T3')

    fireEvent.click(within(sheet).getByTestId('try-3'))
    expect(within(await within(sheet).findByTestId('inspector-glass')).getByTestId('test-pips').querySelector('.rk-tp-count')?.textContent).toBe('✕ 3 of 4 passed')
  })

  it('a page opened mid-build reads the card’s tail: the pad and the horizon say how far; a ctest failure is named', async () => {
    const id = RUNS[3]
    const CTEST = [
      ' 1/3 Test  #1: osc.sine_is_clean ................   Passed    0.02 sec',
      ' 2/3 Test  #2: fdn.is_stable_at_max .............***Failed    0.03 sec',
      'libs/core/tests/test_fdn.cpp:41: FAILED:',
      '  REQUIRE( peak < 4.0f )',
      'with expansion:',
      '  inf < 4.0f',
      ' 3/3 Test  #3: core.version_is_set ..............   Passed    0.01 sec',
      '67% tests passed, 1 tests failed out of 3'
    ]
    const tail = { attempt: 3, gate: 'verify[0:build]', passed: null, command: null, exit_code: null, duration_ms: null, lines: BUILD, live: true }
    const t2tail = { attempt: 1, gate: 'verify[1:test]', passed: false, command: null, exit_code: 8, duration_ms: 900, lines: CTEST, live: false }
    const row = building(id)

    row.tasks = (row.tasks as Array<Record<string, unknown>>).map(t =>
      t.task_id === 'T3'
        ? { ...t, check_tail: tail }
        : t.task_id === 'T2'
          ? { ...t, outcome: 'running', attempts: 2, climb: [tryOf(1, 'cheap', 'start', 'failed', { failed_check: 'verify[1:test]' }), tryOf(2, 'cheap', 'retry', 'running')], check_tail: t2tail }
          : t
    )
    backend.runs = [row, ...backend.runs]
    backend.eventsFor[id] = [
      { cursor: 10, type: 'agent_spawned', group: 'agent', task_id: 'T2', attempt: 1, model: 'gpt-oss-120b', ts_millis: Date.now() - 60_000, text: 'T2 attempt 1' },
      { cursor: 11, type: 'gate_result', group: 'gate', task_id: 'T2', gate: 'verify[1:test]', passed: false, ts_millis: Date.now() - 50_000, text: 'T2 gate verify[1:test] did not pass' }
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(within(card).getByTestId('pad-check-T3').textContent).toBe('45%'))
    expect(within(card).getByTestId('horizon').textContent).toContain('building 45% · Oversampler.cpp')
    // Catch2 under ctest: the case is the failed test's name, and what it saw is the expansion.
    const pips = await within(await within(card).findByTestId('stream')).findByTestId('test-pips')

    expect(pips.querySelector('.rk-tp-fail b')?.textContent).toBe('✕ fdn.is_stable_at_max')
    expect(pips.querySelector('.rk-tp-expr')?.textContent).toBe('REQUIRE( peak < 4.0f ) · saw inf < 4.0f')
  })

  it('reads the real P0 run’s checks: a doctest failure with what the spec logged, CMake’s errors as hazard cards', async () => {
    const W = '~/dev/undertow/.roko/worktrees/attempt-afa08b39d03a16f8ee04'
    const TRY3 = [
      `${W}/tests/spec/p0/plugin_test.cpp:147:`,
      'TEST CASE:  P0.11 processBlock is finite, never allocates, and hands host parameter changes to the engine',
      '',
      `${W}/tests/spec/p0/plugin_test.cpp:183: ERROR: CHECK( allocations == 0 ) is NOT correct!`,
      '  values: CHECK( 11400 == 0 )',
      '  logged: 11400 heap allocations inside processBlock: preallocate the MIDI event array and everything else in prepareToPlay',
      '',
      '[doctest] test cases:   6 |   5 passed | 1 failed | 0 skipped',
      '[doctest] assertions: 719 | 717 passed | 2 failed |',
      '[doctest] Status: FAILURE!'
    ]
    const TRY4 = [
      'spec: FAIL spec_p0_plugin: `cmake --preset plugin` failed (full log: build/spec-logs/plugin-configure.log):',
      `CMake Error: Could not read presets from ${W}:`,
      'Error: @34,24: Invalid extra field "noTestsAction" in Preset',
      '      "noTestsAction": "error"',
      '                       ^',
      'Error: @33,26: Invalid extra field "outputOnFailure" in Preset',
      '      "outputOnFailure": true,'
    ]
    const TRY1 = [
      'spec: FAIL spec_p0_plugin: `cmake --preset plugin` failed (full log: build/spec-logs/plugin-configure.log):',
      'CMake Error at CMakeLists.txt:19 (add_subdirectory):',
      '  add_subdirectory given source "plugin" which is not an existing directory.',
      '',
      '-- Configuring incomplete, errors occurred!'
    ]
    // The task's failed check as a page opened after it reads it: its card's tail, and the timeline's gate line.
    const failed = async (n: number, lines: string[]) => {
      const id = `b1d2e3f4-0a1b-4c2d-8e3f-00000000008${n}`
      const tail = { attempt: 3, gate: 'verify[0:test]', passed: false, command: 'tools/spec.sh 0 plugin', exit_code: 1, duration_ms: 9_000, lines, live: false }

      cleanup()
      backend.runs = [ladderRow({ run_id: id, tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T3' ? { ...t, climb: [tryOf(3, 'mid', 'start', 'failed', { failed_check: 'verify[0:test]' }), tryOf(4, 'mid', 'retry', 'running')], check_tail: tail } : t)) }), ...backend.runs]
      backend.eventsFor[id] = [
        { cursor: 10, type: 'agent_spawned', group: 'agent', task_id: 'T3', attempt: 3, model: 'glm-4.7', ts_millis: Date.now() - 30_000, text: 'T3 attempt 3 on glm-4.7' },
        { cursor: 11, type: 'gate_result', group: 'gate', task_id: 'T3', gate: 'verify[0:test]', passed: false, ts_millis: Date.now() - 20_000, text: 'T3 gate verify[0:test] did not pass' }
      ]
      await mountPage({ run: id })

      return within(await screen.findByTestId(`run-card-${id}`)).findByTestId('stream')
    }

    // doctest: the case, where, what it checked and saw, and the line the spec logged for exactly this.
    let pips = await within(await failed(5, TRY3)).findByTestId('test-pips')

    expect(pips.querySelector('.rk-tp-count')?.textContent).toBe('✕ 5 of 6 passed')
    expect(pips.querySelector('.rk-tp-fail b')?.textContent).toMatch(/^✕ P0\.11 processBlock is finite, never allocates/)
    expect(pips.querySelector('.rk-tp-fail small')?.textContent).toBe(' p0/plugin_test.cpp:183')
    expect(pips.querySelector('.rk-tp-expr')?.textContent).toBe('CHECK( allocations == 0 ) · saw CHECK( 11400 == 0 )')
    expect(pips.querySelector('.rk-tp-logged')?.textContent).toBe('11400 heap allocations inside processBlock: preallocate the MIDI event array and everything else in prepareToPlay')

    // A tail that lost the TEST CASE line names the failure by where it is, never "a test".
    pips = await within(await failed(6, TRY3.slice(2))).findByTestId('test-pips')
    expect(pips.querySelector('.rk-tp-fail b')?.textContent).toBe('✕ p0/plugin_test.cpp:183')
    expect(pips.querySelector('.rk-tp-fail small')).toBeNull()

    // CMake could not read the presets: the presets file's line, its message, the line it quotes and the caret;
    // not the last line it printed (hermes-pilot P-10's `"outputOnFailure": true,`).
    let hazard = await within(await failed(7, TRY4)).findByTestId('build-hazard')

    expect(hazard.querySelector('.rk-stamp')?.textContent).toContain('configure failed')
    expect(hazard.querySelector('.rk-hz-loc')?.textContent).toBe('CMakePresets.json:34:24')
    expect(hazard.querySelector('.rk-hz-msg')?.textContent).toBe('CMake error: Invalid extra field "noTestsAction" in Preset')
    expect(hazard.querySelector('.rk-hz-code')?.textContent).toContain('34 │ "noTestsAction": "error"')
    expect(hazard.querySelector('.rk-hz-caret')?.textContent).toBe(`${' '.repeat(18)}^`)
    // P-21: a narrow glass (the stream at 1440 px) keeps 16 characters around the caret, the cut ends marked there.
    const win = hazard.querySelector('.rk-hz-code > .rk-hz-win') as HTMLElement

    expect(win.textContent).toBe('Action": "error"')
    expect(win.getAttribute('data-l')).toBe('true')
    expect(win.getAttribute('data-r')).toBeNull()
    expect(hazard.querySelector('.rk-hz-code > .rk-hz-cut')?.textContent).toBe('"noTests')
    expect(hazard.querySelector('.rk-hz-caret .rk-hz-win')?.textContent?.indexOf('^')).toBe(win.textContent?.indexOf('"error"'))
    expect(hazard.querySelector('.rk-hz-verdict')?.textContent).toContain('`cmake --preset plugin` failed')

    // An error at a line of a CMakeLists file: its message is the indented line under it.
    hazard = await within(await failed(8, TRY1)).findByTestId('build-hazard')
    expect(hazard.querySelector('.rk-hz-loc')?.textContent).toBe('CMakeLists.txt:19')
    expect(hazard.querySelector('.rk-hz-msg')?.textContent).toBe('CMake error: add_subdirectory given source "plugin" which is not an existing directory.')
  })

  it('output with no build, error or tests stays lines: the last 40 of them', async () => {
    const id = RUNS[2]

    backend.runs = [building(id), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const stream = await within(card).findByTestId('stream')
    const socket = await openSocket()
    const lines = Array.from({ length: 45 }, (_, i) => `checking file ${i + 1}`)

    lines.forEach((_, i) => line(socket, id, lines.slice(Math.max(0, i - 11), i + 1)))

    await waitFor(() => expect(within(stream).getByTestId('stream-check').querySelector('.rk-ln-new')?.textContent).toBe('checking file 45'))
    expect(within(stream).getByTestId('stream-check').querySelectorAll('span')).toHaveLength(40)
    expect(within(stream).queryByTestId('build-glass')).toBeNull()
  })
})

describe('v7 (plugin-wow): chat polish', () => {
  it('a plan writing’s chat card names its planner’s model, and its glass says when it has no time (hermes-pilot P-5)', async () => {
    const id = 'e1d2e3f4-0a1b-4c2d-8e3f-000000000091'
    const writing = { stage: 'recording', model: 'gpt-5-4-mini', attempt: 1, attempts: 1, calls: 1, cost_usd: 0.032, reason: null, elapsed_s: null, text: 'writing the plan: recording' }

    const row = { run_id: id, kind: 'plan_generate', label: 'P0 · Undertow foundation', plan_id: 'p0-undertow-foundation', state: 'succeeded', active: false, cost_usd: 0.032, max_usd: null, started_at: null, writing, headline: 'succeeded · plan p0-undertow-foundation · 3 tasks' }

    // roko keeps no time for a finished plan writing: the glass says so, never a made-up clock.
    backend.runs = [{ ...row, duration_ms: null }, ...backend.runs]
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${id}"}`} />)

    const card = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(within(card).getByTestId('card-status').textContent).toContain('written by gpt-5-4-mini'))
    expect(within(card).getByTestId('card-time').querySelector('svg')?.getAttribute('aria-label')).toBe('time unknown')

    // With a time, the glass reads it.
    cleanup()
    queryClient.clear()
    backend.runs = [{ ...row, duration_ms: 65_000 }, ...backend.runs.filter(r => r.run_id !== id)]
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${id}"}`} />)
    await waitFor(async () => expect((await screen.findByTestId(`run-card-${id}`)).querySelector('[data-testid="card-time"] svg')?.getAttribute('data-value')).toBe('1:05'))
  })
})

describe('v7 (plugin-wow): one word for an ended plan writing', () => {
  it('its chat card’s stamp says plan written, as its row and headline do, not passed (the lead, after R1l)', async () => {
    const id = 'e1d2e3f4-0a1b-4c2d-8e3f-000000000093'
    const row = { run_id: id, kind: 'plan_generate', label: 'P4.1 · Undertow editor fixes', plan_id: 'p4-1-undertow-editor-fixes', state: 'succeeded', active: false, cost_usd: 0.21, max_usd: 0.5, started_at: null, headline: 'succeeded · plan p4-1-undertow-editor-fixes · 2 tasks · $0.21 of $0.50' }

    backend.runs = [row, ...backend.runs]
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${id}"}`} />)
    await waitFor(async () => expect((await screen.findByTestId(`run-card-${id}`)).querySelector('[data-testid="card-pill"]')?.textContent).toBe('✓plan written'))
    // A run that passed keeps its stamp.
    cleanup()
    queryClient.clear()
    backend.runs = [{ ...row, kind: 'plan', run_id: `${id.slice(0, -1)}4` }, ...backend.runs]
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${id.slice(0, -1)}4"}`} />)
    await waitFor(async () => expect((await screen.findByTestId(`run-card-${id.slice(0, -1)}4`)).querySelector('[data-testid="card-pill"]')?.textContent).toBe('✓passed'))
  })
})

describe('v7 (plugin-wow): the NOW corner names the try running now', () => {
  it('a task waiting its turn with a newer route is not named as what runs now (hermes-pilot P-16)', async () => {
    const id = 'b1d2e3f4-0a1b-4c2d-8e3f-000000000090'
    const at = (s: number) => new Date(Date.now() - s * 1_000).toISOString()
    const route = (model: string, rung: string) => ({ model, rung, source: 'ladder', stage: 'ladder', provider: 'zai', candidates: [] })
    const tasks = (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
      t.task_id === 'T2'
        ? { ...t, outcome: 'running', attempts: 1, climb: [tryOf(1, 'mid', 'start', 'running')], attempt_log: [{ attempt: 1, model: 'glm-4.7', provider: 'zai', started_at: at(60), gates: [], route: route('glm-4.7', 'mid') }] }
        : t.task_id === 'T3'
          ? { ...t, outcome: 'pending', attempts: 1, climb: [tryOf(1, 'cheap', 'start', 'failed')], attempt_log: [{ attempt: 2, model: 'gpt-5.4-mini', provider: 'openai', started_at: at(10), gates: [], route: route('gpt-5.4-mini', 'strong') }] }
          : { ...t, outcome: t.task_id === 'T1' ? 'passed' : 'pending' }
    )

    backend.runs = [ladderRow({ run_id: id, tasks }), ...backend.runs]
    await mountPage({ run: id })

    // The head's sentence says what runs now: Task 2, on the model its try runs on.
    const status = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('card-status')

    expect(status.textContent).toBe('Task 2 is running on glm-4.7.')
  })
})

describe('v7 (plugin-wow): no account name in the merge confirm', () => {
  it('says where the merge lands by the project’s folder, never /Users/<name> (hermes-pilot P-15, PW-3)', async () => {
    // The backend's boundary writes the home as `~` in every card (test_v07_wow: the merge dialog's fields).
    backend.doneWorkspace = '~/dev/undertow'
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')
    fireEvent.click(await within(card).findByTestId('merge-button'))

    const dialog = await screen.findByRole('dialog')

    // The folder's own name; its home-relative path (the backend's) on hover only (design system §6.4).
    expect(dialog.textContent).toContain('in undertow')
    expect(dialog.textContent).not.toMatch(/\/Users\/[^/\s]+/)
    expect(within(dialog).getByTitle('~/dev/undertow')).toBeTruthy()
  })
})

describe('v7 (plugin-wow): the real P0 run’s sheet', () => {
  it('says roko’s own budget for a task’s tries, not a guess from the ladder (hermes-pilot P-11)', async () => {
    const id = 'b1d2e3f4-0a1b-4c2d-8e3f-000000000089'
    const failed = { failed_check: 'verify[0:test]' }
    const climb = [tryOf(1, 'mid', 'start', 'failed', failed), tryOf(2, 'mid', 'retry', 'failed', failed), tryOf(3, 'strong', 'climb', 'failed', failed), tryOf(4, 'strong', 'retry', 'running')]

    backend.runs = [ladderRow({ run_id: id, tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T3' ? { ...t, climb, tries_allowed: 4 } : t)) }), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(card.querySelector('.roko-node[data-node="T3"]')).toBeTruthy())
    fireEvent.click(card.querySelector('.roko-node[data-node="T3"]') as HTMLElement)
    expect(within(await within(card).findByTestId('inspector-T3')).getByText(/^try 4 of up to 4/)).toBeTruthy()
  })
})

describe('v7 (plugin-wow): a long run’s history', () => {
  it('opens on its newest lines, then pages back a page at a time until its start', async () => {
    const id = 'c1d2e3f4-0a1b-4c2d-8e3f-000000000081'
    const t0 = Date.now() - 3_600_000

    backend.runs = [ladderRow({ run_id: id, state: 'succeeded', active: false, started_at: new Date(t0).toISOString() }), ...backend.runs]
    backend.eventsLong[id] = Array.from({ length: 900 }, (_, i) => ({ cursor: (i + 1) * 10, type: 'gate_rung_started', group: 'gate', task_id: 'T1', ts_millis: t0 + i * 1_000, text: `T1 checking verify[${i}:build]` }))
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    openRunFold(card, 'steps')

    // The newest 400, not the first ones: the page is about now.
    expect(await within(card).findByText('T1 checking verify[899:build]')).toBeTruthy()
    expect(within(card).queryByText('T1 checking verify[499:build]')).toBeNull()
    expect(called('GET', `/runs/${id}/events?tail=400`)).toBe(true)
    // It draws the newest 300 of them: a long run's page stays light.
    expect(card.querySelectorAll('.roko-feed-row')).toHaveLength(300)
    expect(within(card).getByTestId('feed-earlier').textContent).toBe('earlier ↑ · 100 more here')

    // earlier ↑ brings the 200 before them; at the start it goes.
    fireEvent.click(await within(card).findByTestId('feed-earlier'))
    expect(await within(card).findByText('T1 checking verify[300:build]')).toBeTruthy()
    expect(called('GET', `/runs/${id}/events?before=5010&limit=200`)).toBe(true)
    expect(card.querySelectorAll('.roko-feed-row')).toHaveLength(600)
    fireEvent.click(await within(card).findByTestId('feed-earlier'))
    expect(await within(card).findByText('T1 checking verify[100:build]')).toBeTruthy()
    fireEvent.click(await within(card).findByTestId('feed-earlier'))
    expect(await within(card).findByText('T1 checking verify[0:build]')).toBeTruthy()
    await waitFor(() => expect(within(card).queryByTestId('feed-earlier')).toBeNull())
  })

  it('waits while the backend reads a long run: never its first lines as its newest, and socket lines are not its history', async () => {
    const id = 'c1d2e3f4-0a1b-4c2d-8e3f-000000000082'
    const t0 = Date.now() - 3_600_000

    backend.runs = [ladderRow({ run_id: id, state: 'succeeded', active: false, started_at: new Date(t0).toISOString(), reading: true, events_read: 40_000 }), ...backend.runs]
    backend.eventsLong[id] = Array.from({ length: 900 }, (_, i) => ({ cursor: (i + 1) * 10, type: 'gate_rung_started', group: 'gate', task_id: 'T1', ts_millis: t0 + i * 1_000, text: `T1 checking verify[${i}:build]` }))
    backend.eventsReading[id] = 2

    // The socket brought the run's newest line before the page ever read the run.
    await mountPage({ tab: 'runs' })
    push(await openSocket(), { lines: [{ cursor: 9_010, group: 'gate', task_id: 'T1', text: 'T1 checking verify[900:build]', ts_millis: t0 + 900_000, type: 'gate_rung_started' }], run_id: id, type: 'lines' })
    cleanup()
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    // The card says it shows what the backend read so far, and draws no receipt or check count from half a run.
    expect(within(card).getByTestId('run-reading').textContent).toBe("Reading this run's history · 40,000 events so far · the page fills in as it reads")
    expect(card.querySelector('.rk-receipt, [data-testid="receipt"]')).toBeNull()
    expect(within(card).getByTestId('card-checks').textContent).toContain('reading…')
    openRunFold(card, 'steps')
    expect((await within(card).findByTestId('feed-reading')).textContent).toMatch(/^Reading this run's history · (40|80),000 events so far$/)
    expect(within(card).queryByText('No events yet.')).toBeNull()

    // Then its newest lines, the socket's with them; never its first ones, and never a read from its start.
    expect(await within(card).findByText('T1 checking verify[899:build]', {}, { timeout: 3_000 })).toBeTruthy()
    expect(within(card).getByText('T1 checking verify[900:build]')).toBeTruthy()
    expect(within(card).queryByText('T1 checking verify[0:build]')).toBeNull()
    expect(within(card).queryByTestId('feed-reading')).toBeNull()
    expect(api.mock.calls.filter(([req]) => req.path === `/api/plugins/roko/runs/${id}/events?tail=400`)).toHaveLength(3)
    expect(called('GET', `/runs/${id}/events?limit=200`)).toBe(false)

    // An ended run's card is looked at again while it was still being read, until the backend has read it all.
    backend.runs = backend.runs.map(r => (r.run_id === id ? { ...r, reading: false, events_read: 139_676 } : r))
    await waitFor(() => expect(within(card).queryByTestId('run-reading')).toBeNull(), { timeout: 6_000 })
  })

  it('shows a tool call roko failed (a bash timeout, the real P0 run’s key evidence) in the stream and in Problems', async () => {
    const id = 'c1d2e3f4-0a1b-4c2d-8e3f-000000000084'
    const t0 = Date.now() - 600_000

    backend.runs = [ladderRow({ run_id: id, state: 'failed', active: false, started_at: new Date(t0).toISOString() }), ...backend.runs]
    backend.eventsLong[id] = [
      { cursor: 10, type: 'agent_output', group: 'tool', task_id: 'T3', tool: 'bash', target: 'cmake --build --preset dev', ts_millis: t0 + 1_000, text: 'T3 bash cmake --build --preset dev' },
      { cursor: 20, type: 'agent_output', group: 'error', task_id: 'T3', tool_error: 'timed out after 60001 ms', passed: false, ts_millis: t0 + 61_000, text: 'T3 tool error: timed out after 60001 ms' }
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const stream = await within(card).findByTestId('stream')

    await waitFor(() => expect(stream.textContent).toContain('✕ tool error'))
    expect(stream.textContent).toContain('timed out after 60001 ms')
    openRunFold(card, 'steps')
    fireEvent.click(await within(card).findByRole('button', { name: /^Problems/ }))
    await waitFor(() => expect(card.querySelector('.roko-feed-list')?.textContent).toContain('tool error: timed out after 60001 ms'))
  })

  it('keeps every earlier page the person asked for, past the 1,200 lines it keeps of a run', async () => {
    const id = 'c1d2e3f4-0a1b-4c2d-8e3f-000000000083'
    const t0 = Date.now() - 3_600_000

    backend.runs = [ladderRow({ run_id: id, state: 'succeeded', active: false, started_at: new Date(t0).toISOString() }), ...backend.runs]
    backend.eventsLong[id] = Array.from({ length: 2_000 }, (_, i) => ({ cursor: (i + 1) * 10, type: 'gate_rung_started', group: 'gate', task_id: 'T1', ts_millis: t0 + i * 1_000, text: `T1 checking verify[${i}:build]` }))
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    openRunFold(card, 'steps')
    expect(await within(card).findByText('T1 checking verify[1999:build]')).toBeTruthy()

    // 400 newest, then 8 pages of 200 back: 2,000 lines, all kept, down to the run's first.
    for (let page = 0; page < 9 && within(card).queryByTestId('feed-earlier'); page += 1) {
      const rows = card.querySelectorAll('.roko-feed-row').length

      fireEvent.click(within(card).getByTestId('feed-earlier'))
      await waitFor(() => expect(card.querySelectorAll('.roko-feed-row').length).toBeGreaterThan(rows))
    }

    expect(within(card).getByText('T1 checking verify[0:build]')).toBeTruthy()
    expect(card.querySelectorAll('.roko-feed-row')).toHaveLength(2_000)
    expect(within(card).queryByTestId('feed-earlier')).toBeNull()
  })
})

describe('v8 (plugin-wow #3): the build, a long piece of work’s phases in order', () => {
  it('a project with phases heads Plans with its build: the glass reads the whole build, a pad a phase, and what it waits on', async () => {
    backend.build = undertowBuild()
    await mountPage()
    // A long piece of work's phases head Plans (design system §5.1): no tab of their own.
    expect(screen.queryByRole('tab', { name: 'Build' })).toBeNull()
    fireEvent.click(await screen.findByRole('tab', { name: 'Plans' }))

    const build = await screen.findByTestId('build')
    const head = within(build).getByTestId('build-head')

    expect(head.textContent).toContain('UNDERTOW')
    expect(head.textContent).toContain('~/dev/undertow')
    expect(head.textContent).toContain('P2 plan being written')
    expect(head.textContent).toMatch(/phases2\/6/)
    expect(head.textContent).toMatch(/tasks8\/8/)
    expect(head.textContent).toMatch(/runs4/)
    expect(head.textContent).toMatch(/time2h 47m/)
    expect(within(build).getByTestId('build-spend').querySelector('[aria-label]')?.getAttribute('aria-label')).toBe('$2.79 spent on the build')
    expect(head.textContent).toContain('spent on the build · roko’s ledger')
    expect(within(build).getByTestId('build-incl').textContent).toBe('incl. $0.25 plan writing · $0.10 outside the phases')
    expect(within(build).getByTestId('build-receipt').textContent).toBe('1 phase built so far on claude-sonnet-4-6 ≈ $2.96 · roko spent $1.02: 2.9× less · 1 run still to read')
    expect(within(build).getByTestId('build-basis').textContent).toBe("≈ each passed phase's passing tries at claude-sonnet-4-6's list prices · roko's spend includes 2 runs that didn't pass")

    const pads = Array.from(within(build).getByTestId('build-song').querySelectorAll('.rk-phase'))

    expect(pads.map(pad => pad.getAttribute('data-state'))).toEqual(['passed', 'passed', 'writing', 'specified', 'specified', 'specified'])
    expect(pads[0].getAttribute('aria-label')).toBe('P0 foundation: passed, 3 of 3 tasks')
    expect(pads[0].textContent).toContain('$1.05 · 1h 31m · 3 runs')
    expect(pads[0].querySelectorAll('.rk-phase-tasks i[data-on=true]')).toHaveLength(3)
    expect(pads[1].textContent).toContain('$1.17 · incl. $0.15 plan writing · 1h 16m · 1 run')
    expect(pads[2].getAttribute('data-next')).toBe('true')
    expect(pads[3].tagName).toBe('DIV') // only specified: nothing to open
    expect(pads[3].getAttribute('title')).toBe('a 16-step bassline sequencer locked to the host transport')

    const next = within(build).getByTestId('build-next')

    expect(next.textContent).toContain('roko is writing P2’s plan')
    expect(next.textContent).toContain('the hypnotic part of the sound')
    // A pad opens its latest run.
    fireEvent.click(pads[1])
    await waitFor(() => expect(window.location.hash).toBe(`#/roko#run=${RUN_FAILED}`))
  })

  it('the receipt of a run the build has not read yet is read: its card is opened in the background', async () => {
    backend.build = undertowBuild()
    await mountPage({ tab: 'build' })
    await screen.findByTestId('build')
    await waitFor(() => expect(backend.calls.some(call => call.path.endsWith(`/runs/${RUN_DONE}`))).toBe(true))
  })

  it('wow 3: the build’s ladder line, from roko’s records of the landed work, shows under the receipt as the backend words it', async () => {
    const build = undertowBuild()
    const line = 'landed work by the rung it passed on: mid 24, strong 6 · 25 of 30 passed on the first try · 1 climb'

    build.ladder_line = line
    backend.build = build
    await mountPage({ tab: 'build' })

    expect((await screen.findByTestId('build-ladder')).textContent).toBe(line)
    // Without one (no passed phase), no line.
    cleanup()
    queryClient.clear()
    backend.build = undertowBuild()
    await mountPage({ tab: 'build' })
    await screen.findByTestId('build')
    expect(screen.queryByTestId('build-ladder')).toBeNull()
  })

  it('wow 1: the phase reel shows each passed phase’s own UI shot in order, its spend and time as on its pad', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGMQQAIMODkALAcCQaqvfAkAAAAASUVORK5CYII='
    const build = undertowBuild() as { phases: Record<string, unknown>[] }
    const IDLE = 'artifacts/ui/editor-idle.png'
    const VOICE = 'artifacts/ui/editor-voice.png'

    build.phases[0] = { ...build.phases[0], shot: { run_id: RUN_DONE, path: IDLE, bytes: 119_209 } }
    build.phases[1] = { ...build.phases[1], shot: { run_id: RUN_NEW, path: VOICE, bytes: 120_311 } }
    backend.build = build
    backend.artifactFiles[IDLE] = { ok: true, path: IDLE, mime: 'image/png', data: PNG }
    backend.artifactFiles[VOICE] = { ok: true, path: VOICE, mime: 'image/png', data: PNG }
    await mountPage({ tab: 'build' })

    const reel = await screen.findByTestId('build-reel')

    await within(reel).findByRole('img', { name: 'P1: editor-voice.png' })
    expect(within(reel).getAllByRole('img').map(img => img.getAttribute('alt'))).toEqual(['P0: editor-idle.png', 'P1: editor-voice.png'])
    // The phase still writing its plan has no shot, so no place in the reel.
    expect([...reel.querySelectorAll('figcaption')].map(c => [...c.childNodes].map(n => n.textContent).filter(Boolean))).toEqual([
      ['P0 · foundation', '$1.05 · 1h 31m'],
      ['P1 · voice', '$1.17 · 1h 16m']
    ])
    // Each from its own phase's run, once: the pads leave their shots to the reel.
    const asked = api.mock.calls.map(([req]) => String(req.path)).filter(p => p.includes('/artifact?path='))

    expect(asked).toHaveLength(2)
    expect(asked.some(p => p.includes(RUN_DONE)) && asked.some(p => p.includes(RUN_NEW))).toBe(true)
    expect(within(screen.getByTestId('phase-0')).queryByRole('img')).toBeNull()
    // One shot is no reel: its pad keeps it.
    cleanup()
    queryClient.clear()
    build.phases[1] = { ...build.phases[1], shot: null }
    await mountPage({ tab: 'build' })
    await within(await screen.findByTestId('phase-0')).findByRole('img', { name: 'P0: editor-idle.png' })
    expect(screen.queryByTestId('build-reel')).toBeNull()
  })

  it('wow 2: the build’s chart is the backend’s two series by phase, a spark each with its range, each phase’s figure on hover', async () => {
    const build = undertowBuild()
    const cost = "each phase's whole spend, failed runs and plan writing too, over the tasks roko verified: P0 $0.35 · P1 $0.23"
    const first = "of the tasks each phase's runs tried, failed runs too, those whose first try passed: P0 3 of 4 · P1 4 of 5"

    build.chart = [
      { label: 'cost per verified task, by phase', values: [0.351268, 0.23446], range: '$0.23 to $0.35', words: cost, tone: 'bone' },
      { label: 'first-try rate, by phase', values: [0.75, 0.8], range: '75% to 80%', words: first, tone: 'pass' }
    ]
    backend.build = build
    await mountPage({ tab: 'build' })

    const head = await screen.findByTestId('build-head')

    for (const [words, cell] of [
      [cost, 'cost per verified task, by phase$0.23 to $0.35'],
      [first, 'first-try rate, by phase75% to 80%']
    ]) {
      const spark = within(head).getByRole('img', { name: words })

      expect(spark.closest('.rk-build-cell')?.textContent).toBe(cell)
      expect(spark.closest('[title]')?.getAttribute('title')).toBe(words)
    }
    // Without a chart, the head keeps its four cells.
    cleanup()
    queryClient.clear()
    backend.build = undertowBuild()
    await mountPage({ tab: 'build' })
    expect((await screen.findByTestId('build-head')).querySelectorAll('.rk-build-cell')).toHaveLength(4)
  })

  it('P-52: a phase whose run roko refused with every rung skipped says what works in the backend’s words, not “resume”', async () => {
    const build = undertowBuild() as { phases: Record<string, unknown>[]; next: Record<string, unknown> }
    const words = 'P2’s run was refused: every rung was skipped because its provider could not bill: recharge cerebras and zai, then resume it'

    build.phases[2] = { ...build.phases[2], state: 'stopped', run_id: RUN_FAILED, writing_id: null }
    build.next = { n: 2, do: 'resume', plan_id: 'p2-undertow-rumble', run_id: RUN_FAILED, words }
    backend.build = build
    await mountPage({ tab: 'build' })

    const next = await screen.findByTestId('build-next')

    expect(next.textContent).toContain(words)
    expect(next.textContent).not.toContain('and only what is left runs')
    expect(within(next).getByTestId('build-open').textContent).toBe('open P2’s run')
  })

  it('option 1: the build’s receipt is the backend’s words as they are; without them, no receipt and no basis', async () => {
    const build = undertowBuild() as { receipt: Record<string, unknown> }

    build.receipt = { ...build.receipt, words: 'the receipt as the backend words it' }
    backend.build = build
    await mountPage({ tab: 'build' })

    expect((await screen.findByTestId('build-receipt')).textContent).toBe('the receipt as the backend words it')
    cleanup()
    queryClient.clear()
    build.receipt = { ...build.receipt, words: null }
    await mountPage({ tab: 'build' })
    await screen.findByTestId('build')
    expect(screen.queryByTestId('build-receipt')).toBeNull()
    expect(screen.queryByTestId('build-basis')).toBeNull()
  })

  it('P-6: a phase only specified is next: its key writes the plan from its spec, which roko reads itself', async () => {
    const build = undertowBuild()
    const phases = build.phases as Array<Record<string, unknown>>

    phases[2] = { ...phases[2], state: 'specified', writing_id: null, cost_usd: null }
    build.next = { n: 2, do: 'write', spec: 'docs/specs/phase-2-rumble.md' }
    backend.build = build
    await mountPage({ tab: 'build' })
    fireEvent.click(await screen.findByTestId('build-write'))

    const dialog = await screen.findByRole('dialog')

    // The spec goes as its path: nothing of it is copied into the request, and the plan's title is its own field.
    expect(within(dialog).getByTestId('composer-spec').textContent).toContain('docs/specs/phase-2-rumble.md')
    expect((within(dialog).getByLabelText(/Anything to add/) as HTMLTextAreaElement).value).toBe('')
    expect((within(dialog).getByLabelText(/Name it/) as HTMLInputElement).value).toBe('P2 · Rumble and modulation')
    fireEvent.click(within(dialog).getByTestId('composer-submit'))
    await waitFor(() => expect(api.mock.calls.some(([req]) => req.method === 'POST' && req.path === '/api/plugins/roko/runs')).toBe(true))

    const [[asked]] = api.mock.calls.filter(([req]) => req.method === 'POST' && req.path === '/api/plugins/roko/runs')

    expect(asked.body).toEqual({ plan: true, spec_path: 'docs/specs/phase-2-rumble.md', title: 'P2 · Rumble and modulation' })
  })

  it('P-50: a phase whose plan branch was merged into main by hand reads merged, its pad apart from the build’s next', async () => {
    const build = undertowBuild()
    const phases = build.phases as Array<Record<string, unknown>>

    phases[4] = { ...phases[4], state: 'merged', ended: 'run cancelled', plan_id: 'p4-undertow-phosphor-editor', tasks: { passed: 5, total: 7 }, roko_coverage: { kept: 12, total: 12 }, runs: 2 }
    backend.build = build
    await mountPage({ tab: 'build' })

    const pad = await screen.findByTestId('phase-4')

    expect(pad.querySelector('.rk-phase-word')?.textContent).toBe('merged by hand · run cancelled')
    expect(pad.querySelector('.rk-phase-word')?.getAttribute('data-tone')).toBe('pass')
    expect(pad.querySelector('.rk-phase-top i')?.textContent).toBe('✓')
    // Built, as a passed pad is: no checks line.
    expect(screen.queryByTestId('phase-cover-4')).toBeNull()
  })

  it('phase 2’s stills: a phase whose tasks ran out of rungs says so before the resume, and offers its plan again', async () => {
    const build = undertowBuild()

    build.next = { n: 2, do: 'resume', plan_id: 'p2-undertow-rumble-4', run_id: RUN_FAILED, covered: 23, total: 23, plans: 4, newest: true, exhausted: ['T2', 'T3'] }
    backend.build = build
    await mountPage({ tab: 'build' })

    const next = await screen.findByTestId('build-next')

    expect(next.textContent).toContain('P2 stopped: T2 and T3 ran out of rungs, so roko says split or replan them; then resume p2-undertow-rumble-4 (the newest of 4), and only what is left runs · it runs 23 of its spec’s 23 checks')
    fireEvent.click(within(next).getByTestId('build-write'))

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByTestId('composer-spec').textContent).toContain('docs/specs/phase-2-rumble.md')
    expect((within(dialog).getByLabelText(/Anything to add/) as HTMLTextAreaElement).value).toBe(
      'The plan p2-undertow-rumble-4 stopped: T2 and T3 failed their checks on the ladder’s last rung. Split them into smaller tasks, or plan them another way.'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('P-6: what the request adds counts the missing checks the build does not name', async () => {
    const build = undertowBuild()
    const missing = Array.from({ length: 20 }, (_, i) => `P2.${String(i + 1).padStart(2, '0')}`)

    build.next = { n: 2, do: 'rewrite', plan_id: 'p2-undertow-rumble-3', spec: 'docs/specs/phase-2-rumble.md', covered: 0, total: 23, missing }
    backend.build = build
    await mountPage({ tab: 'build' })
    fireEvent.click(await screen.findByTestId('build-write'))

    const dialog = await screen.findByRole('dialog')

    expect((within(dialog).getByLabelText(/Anything to add/) as HTMLTextAreaElement).value).toContain('P2.19, P2.20 and 3 more not run)')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('P-7: a roko that caps plan writing gets a cap for it from the composer; an older one keeps its own limit', async () => {
    const build = undertowBuild()

    build.next = { n: 2, do: 'write', spec: 'docs/specs/phase-2-rumble.md' }
    backend.build = build
    backend.planWritingCap = true
    await mountPage({ tab: 'build' })
    fireEvent.click(await screen.findByTestId('build-write'))

    const dialog = await screen.findByRole('dialog')

    expect(dialog.textContent).toContain('the most writing the plan may spend')
    fireEvent.change(within(dialog).getByLabelText('Spend cap'), { target: { value: '0.60' } })
    expect(within(dialog).getByTestId('composer-submit').textContent).toContain('Write the plan · cap $0.60')
    fireEvent.click(within(dialog).getByTestId('composer-submit'))
    await waitFor(() => expect(api.mock.calls.some(([req]) => req.method === 'POST' && req.path === '/api/plugins/roko/runs')).toBe(true))

    const [[asked]] = api.mock.calls.filter(([req]) => req.method === 'POST' && req.path === '/api/plugins/roko/runs')

    expect(asked.body).toEqual({ plan: true, spec_path: 'docs/specs/phase-2-rumble.md', title: 'P2 · Rumble and modulation', max_usd: 0.6 })
  })

  it('P-6: the composer plans from the request alone once the spec is taken off', async () => {
    const build = undertowBuild()

    build.next = { n: 2, do: 'write', spec: 'docs/specs/phase-2-rumble.md' }
    backend.build = build
    await mountPage({ tab: 'build' })
    fireEvent.click(await screen.findByTestId('build-write'))

    const dialog = await screen.findByRole('dialog')

    fireEvent.click(within(dialog).getByRole('button', { name: 'Plan from the request alone' }))
    expect(within(dialog).queryByTestId('composer-spec')).toBeNull()
    expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText('What should roko do?'), { target: { value: 'Add an LFO to the filter' } })
    fireEvent.click(within(dialog).getByTestId('composer-submit'))
    await waitFor(() => expect(api.mock.calls.some(([req]) => req.method === 'POST' && req.path === '/api/plugins/roko/runs')).toBe(true))

    const [[asked]] = api.mock.calls.filter(([req]) => req.method === 'POST' && req.path === '/api/plugins/roko/runs')

    expect(asked.body).toEqual({ plan: true, prompt: 'Add an LFO to the filter', title: 'P2 · Rumble and modulation' })
  })

  it('a plan that misses its spec’s checks is never offered to run: NEXT says write it again, and its key asks for it', async () => {
    const build = undertowBuild()
    const phases = build.phases as Array<Record<string, unknown>>
    const missing = Array.from({ length: 19 }, (_, i) => `P2.${String(i + 1).padStart(2, '0')}`)

    phases[2] = { ...phases[2], state: 'written', writing_id: null, plan_id: 'p2-undertow-rumble', coverage: { total: 19, covered: 0, missing } }
    build.next = { n: 2, do: 'rewrite', plan_id: 'p2-undertow-rumble', spec: 'docs/specs/phase-2-rumble.md', covered: 0, total: 19, missing }
    backend.build = build
    await mountPage({ tab: 'build' })

    const next = await screen.findByTestId('build-next')

    expect(next.textContent).toContain('P2’s plan p2-undertow-rumble misses 19 of its spec’s 19 checks: write it again')
    expect(screen.queryByTestId('build-run')).toBeNull()
    expect(screen.getByTestId('phase-cover-2').textContent).toBe('checks 0/19 of its spec')
    expect(screen.getByTestId('phase-cover-2').getAttribute('data-short')).toBe('true')
    fireEvent.click(within(next).getByTestId('build-write'))

    const dialog = await screen.findByRole('dialog')
    const added = (within(dialog).getByLabelText(/Anything to add/) as HTMLTextAreaElement).value

    // P-6: the spec goes by its path; what the request adds says what the last plan missed.
    expect(within(dialog).getByTestId('composer-spec').textContent).toContain('docs/specs/phase-2-rumble.md')
    expect(added).toBe(
      'The plan p2-undertow-rumble ran 0 of this spec’s 19 acceptance checks (P2.01, P2.02, P2.03, P2.04, P2.05, P2.06, P2.07, P2.08, P2.09, P2.10, P2.11, P2.12, P2.13, P2.14, P2.15, P2.16, P2.17, P2.18, P2.19 not run). Make each one a verify step whose command is exactly the spec’s command, with nothing around it.'
    )
    expect(added).not.toContain('docs/specs')
    expect((within(dialog).getByLabelText(/Name it/) as HTMLInputElement).value).toBe('P2 · Rumble and modulation')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  })

  it('P-18: a failover tag stays inside its rail, and once its task passed it says so in the past', async () => {
    const failover = { model: 'gpt-5.4-mini', provider: 'openai', class: 'circuit_open', why: 'failing, so roko paused it' }
    const id = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d'
    const row = ladderRow({
      run_id: id,
      state: 'succeeded',
      active: false,
      tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t =>
        t.task_id === 'T3' ? { ...t, outcome: 'passed', step: null, climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'failed'), tryOf(3, 'mid', 'failover', 'passed', { failover })] } : t
      )
    })

    backend.runs = [row, ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const tag = await within(card).findByTestId('ladder-failover-T3')

    expect(tag.textContent).toBe('⇄ passed after a failover')
    expect(tag.getAttribute('data-channel')).toBeNull()
    expect(tag.getAttribute('title')).toBe('its first pick was passed over (failing, so roko paused it); it passed on the model it moved to')
    expect((tag as HTMLElement).style.maxWidth).toMatch(/^calc\(100% - /)
  })

  it('P-30: a setup problem seen once folds to one line, opens on a click, and a new problem shows whole again', async () => {
    const approvals = { id: 'hermes-approvals-off-p30', severity: 'warn', title: 'Hermes approvals are off: roko runs start without asking you.', detail: 'Set approvals.mode to smart.', fix: { kind: 'command', label: 'turn approvals on', action: null, command: 'hermes config set approvals.mode smart', docs: null } }

    backend.problems = [approvals]
    await mountPage()
    await refreshOverview()
    expect(await screen.findByTestId('setup-module')).toBeTruthy()
    cleanup()
    await mountPage({ tab: 'build' })

    const line = await screen.findByTestId('setup-line')

    expect(screen.queryByTestId('setup-module')).toBeNull()
    expect(line.textContent).toBe('Hermes approvals are off: roko runs start without asking you.turn approvals on')
    fireEvent.click(line)
    expect(await screen.findByTestId('setup-module')).toBeTruthy()
    cleanup()
    backend.problems = [approvals, { ...PROBLEM_MODEL, id: 'no-tool-loop-model-p30' }]
    await mountPage()
    await refreshOverview()
    expect(await screen.findByTestId('setup-module')).toBeTruthy()
  })

  it('roko’s own kept count leads a pad and NEXT, and the plugin’s count flags where the two disagree (bug-72dc0d)', async () => {
    const build = undertowBuild()
    const phases = build.phases as Array<Record<string, unknown>>
    const missing = ['P2.03', 'P2.07', 'P2.11', 'P2.19']

    phases[2] = { ...phases[2], state: 'written', writing_id: null, plan_id: 'p2-undertow-rumble-3', coverage: { total: 23, covered: 19, missing }, roko_coverage: { total: 23, kept: 20, shallow: 1, cannot_run: 0, dropped: 1, missing: 1, writing_id: 'w-3' }, coverage_agrees: false }
    build.next = { n: 2, do: 'rewrite', plan_id: 'p2-undertow-rumble-3', spec: 'docs/specs/phase-2-rumble.md', covered: 19, total: 23, roko_kept: 20, roko_total: 23, missing }
    backend.build = build
    await mountPage({ tab: 'build' })

    const cover = await screen.findByTestId('phase-cover-2')

    expect(cover.textContent).toBe('checks 20/23 kept by roko ≠ 19/23 run')
    expect(cover.getAttribute('data-cross')).toBe('true')
    expect(cover.getAttribute('title')).toContain('roko counts 20 of 23 kept; the plugin finds 19 of the spec’s 23 commands in the plan’s checks')
    expect(screen.getByTestId('build-next').textContent).toContain('P2’s plan p2-undertow-rumble-3: roko counts 20 of its spec’s 23 checks kept, the plugin 19: write it again')
  })

  it('roko’s count and the plugin’s agreeing: one count, said once', async () => {
    const build = undertowBuild()
    const phases = build.phases as Array<Record<string, unknown>>

    phases[2] = { ...phases[2], state: 'written', writing_id: null, plan_id: 'p2-undertow-rumble-3', coverage: { total: 23, covered: 23, missing: [] }, roko_coverage: { total: 23, kept: 23, shallow: 0, cannot_run: 0, dropped: 0, missing: 0, writing_id: 'w-3' }, coverage_agrees: true }
    build.next = { n: 2, do: 'run', plan_id: 'p2-undertow-rumble-3', covered: 23, total: 23, roko_kept: 23, roko_total: 23 }
    backend.build = build
    await mountPage({ tab: 'build' })

    expect((await screen.findByTestId('phase-cover-2')).textContent).toBe('checks 23/23 kept by roko')
    expect(screen.getByTestId('build-next').textContent).toContain('P2’s plan p2-undertow-rumble-3 is written and keeps all 23 of its spec’s checks (roko’s count, and the plugin’s): run it next')
  })

  it('P-30: a setup problem shown whole folds to its line on the next tab, unless it stops runs', async () => {
    const approvals = { id: 'hermes-approvals-off-p30-tabs', severity: 'warn', title: 'Hermes approvals are off: roko runs start without asking you.', detail: 'Set approvals.mode to smart.', fix: { kind: 'command', label: 'turn approvals on', action: null, command: 'hermes config set approvals.mode smart', docs: null } }

    backend.problems = [approvals]
    await mountPage()
    await refreshOverview()
    expect(await screen.findByTestId('setup-module')).toBeTruthy()
    openTab(/^Plans/)
    expect(await screen.findByTestId('setup-line')).toBeTruthy()
    expect(screen.queryByTestId('setup-module')).toBeNull()
  })

  it('phase 4 prep C: a passed phase’s pad shows its first UI shot, its bytes from the backend', async () => {
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGMQQAIMODkALAcCQaqvfAkAAAAASUVORK5CYII='
    const build = undertowBuild() as { phases: Record<string, unknown>[] }

    build.phases[0] = { ...build.phases[0], shot: { run_id: RUN_DONE, path: 'artifacts/ui/editor-idle.png', bytes: 119_209 } }
    backend.build = build
    backend.artifactFiles['artifacts/ui/editor-idle.png'] = { ok: true, path: 'artifacts/ui/editor-idle.png', mime: 'image/png', data: PNG }
    await mountPage()
    fireEvent.click(await screen.findByRole('tab', { name: 'Plans' }))

    const pad = await screen.findByTestId('phase-0')
    const shot = await within(pad).findByRole('img', { name: 'P0: editor-idle.png' })

    expect(shot.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    // One image a passed phase: the other pads ask for none.
    expect(api.mock.calls.filter(([req]) => String(req.path).includes('/artifact?path=')).length).toBe(1)
  })

  it('a project without phases has no build on Plans', async () => {
    await mountPage()
    fireEvent.click(await screen.findByRole('tab', { name: 'Plans' }))
    await screen.findByRole('list', { name: 'roko plans' })
    expect(screen.queryByTestId('build')).toBeNull()
  })
})

describe('v8 (plugin-wow P-14): a plan whose last run stopped part way, continued or started over', () => {
  const STOPPED = { run_id: '6988f0b8-4199-4abf-9cfc-67713bc60e34', status: 'failed', passed_tasks: ['T1'], tasks_left: ['T2'] }

  it('Run plan… asks whether to continue the stopped run or start over, and says which in the confirm', async () => {
    backend.planExtra['add-tests'] = { resumable_run: STOPPED }
    await mountPage()
    const card = await openPlan('add-tests')

    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))

    const form = await screen.findByRole('dialog')
    const choice = within(form).getByTestId('resume-choice')

    expect(within(form).queryByRole('switch')).toBeNull()
    expect(choice.textContent).toContain('Its last run, 6988f0b8 (failed), passed T1, and T2 is left.')
    expect(within(choice).getByTestId('resume-what').textContent).toBe('Only T2 runs; what passed is kept.')
    fireEvent.click(within(choice).getByRole('button', { name: 'start over' }))
    expect(within(choice).getByTestId('resume-what').textContent).toBe('Every task runs again, and 6988f0b8’s progress is set aside (roko resume 6988f0b8 brings it back).')
    fireEvent.click(within(form).getByRole('button', { name: 'Continue…' }))

    const confirm = await screen.findByRole('dialog', { name: 'Start a paid roko run?' })

    expect(within(confirm).getByText(/on model calls, starting over \(6988f0b8’s progress is set aside\)\. This spends real money\./)).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Run plan' }))
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.objectContaining({ body: { max_usd: 0.5, fresh: true, title: 'Add tests' }, method: 'POST', path: '/api/plugins/roko/plans/add-tests/run' }))
    )
  })

  it('P-61: a run whose tasks all passed and whose delivery a crash cut: a resume only delivers', async () => {
    backend.planExtra['add-tests'] = { resumable_run: { ...STOPPED, status: 'interrupted', passed_tasks: ['T1', 'T2'], tasks_left: [], delivery_pending: true } }
    await mountPage()
    const card = await openPlan('add-tests')

    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))

    const choice = within(await screen.findByRole('dialog')).getByTestId('resume-choice')

    expect(choice.textContent).toContain('Its last run, 6988f0b8 (interrupted), passed T1 and T2, and its delivery didn’t finish.')
    expect(within(choice).getByTestId('resume-what').textContent).toBe('No task runs again: only its delivery (the merge, the plan check and the batch).')
    fireEvent.click(within(choice).getByRole('button', { name: 'start over' }))
    expect(within(choice).getByTestId('resume-what').textContent).toBe('Every task runs again, and 6988f0b8’s progress is set aside (roko resume 6988f0b8 brings it back).')
  })

  it('a run roko refuses until it says continue or start over: the confirm says why, and the form then asks', async () => {
    backend.resumableFor['add-tests'] = STOPPED
    await mountPage()
    const card = await openPlan('add-tests')

    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue…' }))

    const confirm = await screen.findByRole('dialog', { name: 'Start a paid roko run?' })

    fireEvent.click(within(confirm).getByRole('button', { name: 'Run plan' }))
    expect(await within(confirm).findByText('Its last run, 6988f0b8, stopped part way: cancel, then choose in Run plan… whether to continue it or start over.')).toBeTruthy()
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Start a paid roko run?' })).toBeNull())
    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))
    expect(within(await screen.findByRole('dialog')).getByTestId('resume-choice').textContent).toContain('continue 6988f0b8')
  })

  it('a run that started over says whose progress it set aside, and a CLI run goes by roko’s short id', async () => {
    const graph = 'graph-p0-undertow-foundation-ab1c1e59-1111-4222-8333-444455556666'
    const done = backend.runs.find(run => run.run_id === RUN_DONE) ?? {}

    backend.runs = [{ ...done, run_id: graph, set_aside: STOPPED }, ...backend.runs]
    await mountPage({ run: graph })

    const card = await screen.findByTestId(`run-card-${graph}`)

    expect(within(card).getByTestId('set-aside').textContent).toBe('it started over: the earlier run’s progress is set aside')
    // Ids stay in the fold (design system §6.4), and there a CLI run goes by roko's short id.
    expect(card.querySelector('.rk-runhead')?.textContent).not.toMatch(/ab1c1e59|6988f0b8|graph-p0/)
    expect(within(card).getByTestId('run-id').textContent).toBe('run ab1c1e59')
  })
})

describe('v8 (plugin-wow P-19 to P-29): the pilot’s second list', () => {
  const ended = (id: string, tasks: (t: Record<string, unknown>) => Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ladderRow({ run_id: id, state: 'failed', active: false, finished_at: new Date(Date.now() - 60_000).toISOString(), tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(tasks), ...extra })
  const refused = (attempt: number, rung: string) => tryOf(attempt, rung, attempt === 1 ? 'start' : 'retry', 'failed', { blame: 'infra', verdict: 'provider_error', failed_check: null, key_line: null })
  const pad = async (card: HTMLElement, id: string) => {
    await waitFor(() => expect(card.querySelector(`.roko-node[data-node="${id}"]`)).toBeTruthy())

    return card.querySelector(`.roko-node[data-node="${id}"]`) as HTMLElement
  }

  it('P-19: an ended run’s TOOK says the time roko counted from, not the run record’s later start', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000019'
    const finished = new Date(2026, 9, 19, 19, 4, 15)
    const took = (3600 + 16 * 60 + 27) * 1000
    const hhmm = (d: Date) => d.toLocaleTimeString(undefined, { hour: '2-digit', hour12: false, minute: '2-digit', second: '2-digit' }).slice(0, 5)

    backend.runs = [ended(id, t => t, { state: 'succeeded', started_at: new Date(2026, 9, 19, 17, 50, 44).toISOString(), finished_at: finished.toISOString(), duration_ms: took }), ...backend.runs]
    await mountPage({ run: id })

    const time = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('card-time')

    // 1:16:27 counted from 17:47:48, roko's plan load; the record says 17:50:44, after the 2 min 56 s pre-check.
    expect(time.textContent).toContain(`from ${hhmm(new Date(finished.getTime() - took))}`)
    expect(time.textContent).not.toContain(`from ${hhmm(new Date(2026, 9, 19, 17, 50, 44))}`)
  })

  it('P-20: what a check told the next try shows its markdown as type, never as asterisks', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000020'
    const feedback = {
      from_attempt: 1,
      check: 'verify',
      failing_steps: [],
      diagnosis: 'The check failed in **tests/spec/p0/plugin_test.cpp** at **line 183**: `allocations == 0` did not hold.',
      errors: ['**11400** heap allocations in `processBlock`']
    }

    backend.runs = [ladderRow({ run_id: id, tasks: (ladderRow().tasks as Array<Record<string, unknown>>).map(t => (t.task_id === 'T3' ? { ...t, climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'running', { feedback })] } : t)) }), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    fireEvent.click(await pad(card, 'T3'))

    const told = await within(await within(card).findByTestId('inspector-T3')).findByTestId('retry-feedback')

    expect(told.textContent).not.toContain('**')
    expect([...told.querySelectorAll('p b')].map(b => b.textContent)).toEqual(['tests/spec/p0/plugin_test.cpp', 'line 183'])
    expect(told.querySelector('p code')?.textContent).toBe('allocations == 0')
    expect(told.querySelector('li b')?.textContent).toBe('11400')
    expect(told.querySelector('li code')?.textContent).toBe('processBlock')
  })

  it('P-21: a narrow glass keeps the source line’s window around its caret; the rule is the glass’s own width', () => {
    const css = document.head.querySelector('style[data-hermes-plugin="roko"]')?.textContent ?? ''

    expect(css).toMatch(/\.rk-hz\{[^}]*container-type:inline-size/)
    expect(css).toContain('@container (max-width:360px){.rk-hz-cut{display:none}')
    expect(css).toMatch(/\.rk-hz-caret \.rk-hz-win::before,\.rk-hz-caret \.rk-hz-win::after\{visibility:hidden\}/)
  })

  it('P-22: an ended pad too narrow for its foot keeps its time: the seconds go first, then its tries (its head counts them)', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000022'
    const climb = [
      tryOf(1, 'cheap', 'start', 'failed'),
      tryOf(2, 'cheap', 'retry', 'failed'),
      tryOf(3, 'mid', 'climb', 'failed'),
      tryOf(4, 'mid', 'retry', 'failed'),
      tryOf(5, 'strong', 'climb', 'failed'),
      tryOf(6, 'strong', 'retry', 'failed')
    ]
    // A width model for the pads' feet: 7 px a character and 10 px a try or check mark, in 100 px.
    const foot = (el: HTMLElement) => el.classList.contains('roko-node-foot')
    const scroll = (el: HTMLElement) => (foot(el) ? (el.textContent ?? '').length * 7 + el.querySelectorAll('.rk-lives i, .roko-pip').length * 10 : 0)

    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return scroll(this) } })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return foot(this) ? 100 : 0 } })

    try {
      backend.runs = [
        ended(id, t =>
          t.task_id === 'T3'
            ? { ...t, outcome: 'failed', attempts: 6, step: null, duration_ms: 2_003_000, climb, lives: { rung: 'strong', used: 2, of: 2 } }
            : t.task_id === 'T1'
              ? { ...t, duration_ms: 40_000 }
              : t
        ),
        ...backend.runs
      ]
      await mountPage({ run: id })

      const card = await screen.findByTestId(`run-card-${id}`)
      const t3 = await pad(card, 'T3')

      await waitFor(() => expect(t3.querySelector('.roko-node-time')?.textContent).toBe('33m'))
      expect(t3.querySelector('.roko-node-time')?.getAttribute('title')).toBe('33m 23s')
      expect(t3.querySelector('.rk-lives')).toBeNull()
      expect(t3.querySelector('.roko-node-attempts')?.textContent).toBe('×6')
      expect(t3.querySelector('.rk-rchip')?.textContent).toBe('strong ▲')

      // A pad with room keeps everything.
      const t1 = await pad(card, 'T1')

      expect(t1.querySelector('.roko-node-time')?.textContent).toBe('40s')
      expect(t1.querySelector('.roko-node-time')?.getAttribute('title')).toBeNull()
      expect(t1.querySelector('.roko-pips')).toBeTruthy()
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    }
  })

  it('P-27: the header says the serve’s state first, then where it is, short; the full address is in its tip', async () => {
    await mountPage()
    expect(screen.getByTestId('roko-connection').textContent).toBe('ok · 127.0.0.1:6677 · v0.1.0')
  })

  it('P-28: a plan shows each task’s check at a glance, above its graph, so a check that can’t fit the project shows at once', async () => {
    await mountPage()

    const card = await openPlan('add-tests')
    const checks = within(card).getByTestId('task-checks')

    expect([...checks.querySelectorAll('.rk-taskcheck')].map(row => row.textContent)).toEqual(['T1$ cargo test -p lexer', 'T2no checks of its own', 'T3$ cargo test -p parser+1'])
    expect(checks.querySelectorAll('.rk-taskcheck')[2].getAttribute('title')).toBe('cargo test -p parser\ncargo clippy')
    expect(checks.compareDocumentPosition(within(card).getByTestId('plan-graph')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('P-35: a long check command keeps its end in view, where the runner of an && chain sits', async () => {
    const chain = "test -f core/CMakeLists.txt && grep -q 'CONFIGURE_DEPENDS' core/CMakeLists.txt && grep -q 'undertow_core' core/CMakeLists.txt && cargo check -p undertow_core"

    backend.planExtra['add-tests'] = { tasks: { T1: { checks: [chain] } } }
    await mountPage()

    const row = within(await openPlan('add-tests')).getByTestId('task-checks').querySelector('.rk-taskcheck') as HTMLElement

    expect(row.textContent).toMatch(/^T1\$ test -f core\/CMakeLists\.txt && grep -q 'CONF… .*&& cargo check -p undertow_core$/)
    expect(row.getAttribute('title')).toBe(chain)
  })

  it('P-29: an ended task’s pad says the rung it ran on last, and that a failover moved it there', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000029'
    const failover = { model: 'glm-4.7', provider: 'zai', class: 'rate_limited', why: 'rate limited' }

    backend.runs = [
      ended(
        id,
        t => (t.task_id === 'T1' ? { ...t, attempts: 4, climb: [refused(1, 'mid'), refused(2, 'mid'), refused(3, 'mid'), tryOf(4, 'strong', 'failover', 'passed', { failover })], lives: { rung: 'mid', used: 0, of: 2 } } : t),
        { state: 'succeeded' }
      ),
      ...backend.runs
    ]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)
    const chip = (await pad(card, 'T1')).querySelector('.rk-rchip') as HTMLElement

    expect(chip.textContent).toBe('strong ⇄')
    expect(chip.getAttribute('title')).toBe('A failover moved it from mid to the strong rung (rate limited)')
    // The Ladder puts it on strong too.
    expect((await within(card).findByTestId('ladder')).querySelector('.rk-rung[data-rung="strong"] [data-testid="ladder-token-T1"]')).toBeTruthy()
  })

  it('P-31: a failover tag too long for its rail says it short, the long words in its tip', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000031'
    const failover = { model: 'gpt-5.4-mini', provider: 'openai', class: 'circuit_open', why: 'failing, so roko paused it' }
    // A width model for the tags: 8 px a character, in a 120 px rail.
    const tag = (el: HTMLElement) => el.classList.contains('rk-lad-failover')

    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get(this: HTMLElement) { return tag(this) ? (this.textContent ?? '').length * 8 : 0 } })
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get(this: HTMLElement) { return tag(this) ? 120 : 0 } })

    try {
      backend.runs = [
        ended(id, t => (t.task_id === 'T3' ? { ...t, outcome: 'passed', step: null, climb: [tryOf(1, 'cheap', 'start', 'failed'), tryOf(2, 'cheap', 'retry', 'failed'), tryOf(3, 'mid', 'failover', 'passed', { failover })] } : t), { state: 'succeeded' }),
        ...backend.runs
      ]
      await mountPage({ run: id })

      const shown = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('ladder-failover-T3')

      await waitFor(() => expect(shown.textContent).toBe('⇄ via failover'))
      expect(shown.getAttribute('title')).toBe('its first pick was passed over (failing, so roko paused it); it passed on the model it moved to')
    } finally {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth
    }
  })

  it('P-32, P-33: a pad’s coverage breaks only between its parts; NEXT says which of a phase’s plans it names', async () => {
    const build = undertowBuild()
    const phases = build.phases as Array<Record<string, unknown>>
    const missing = Array.from({ length: 19 }, (_, i) => `P2.${String(i + 1).padStart(2, '0')}`)

    phases[2] = { ...phases[2], state: 'written', writing_id: null, plan_id: 'p2-undertow-rumble-2', cost_usd: 0.31, writing_usd: 0.31, coverage: { total: 19, covered: 0, missing } }
    build.next = { n: 2, do: 'rewrite', plan_id: 'p2-undertow-rumble-2', spec: 'docs/specs/phase-2-rumble.md', covered: 0, total: 19, missing, plans: 2, newest: true }
    backend.build = build
    await mountPage({ tab: 'build' })

    expect((await screen.findByTestId('build-next')).textContent).toContain('P2’s plan p2-undertow-rumble-2 (the newest of 2) misses 19 of its spec’s 19 checks: write it again')
    expect([...screen.getByTestId('phase-cover-2').querySelectorAll('span')].map(part => part.textContent)).toEqual(['checks 0/19', 'of its spec'])
    expect(document.head.querySelector('style[data-hermes-plugin="roko"]')?.textContent).toContain('.rk-phase-cover span{white-space:nowrap}')
    // All of its spend was plan writing: said once, not "$0.31 · incl. $0.31".
    expect(screen.getByTestId('phase-2').textContent).toContain('$0.31 plan writing')
    expect(screen.getByTestId('phase-2').textContent).not.toContain('incl.')
  })

  it('P-34: Run plan… offers no resume for a plan whose last run left nothing to resume', async () => {
    backend.planExtra['add-tests'] = { resumable_run: null }
    await mountPage()

    const card = await openPlan('add-tests')

    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))

    const form = await screen.findByRole('dialog')

    expect(within(form).queryByRole('switch')).toBeNull()
    expect(within(form).queryByTestId('resume-choice')).toBeNull()
    expect(within(form).queryByText('Resume the last run of this plan')).toBeNull()
  })

  it('a run that failed says whose work its branch holds, verified: not a bare "verified" beside FAILED', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000030'
    const receipt = { changes: { kind: 'verified', files: 8, additions: 506, deletions: 0, branch: 'roko/batch/6988f0b8', merged: false } }

    backend.runs = [ended(id, t => (t.task_id === 'T3' ? { ...t, outcome: 'failed', step: null } : t), { receipt }), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(within(card).getByTestId('receipt').textContent).toContain('+506 −0 in 8 files · roko/batch/6988f0b8 · verified: T1, T2, T4'), { timeout: 5_000 })
  })
})

describe('v8 (plugin-wow #4): where the time went', () => {
  const phases = (model: number, tools: number, checks: number, extra: Record<string, unknown> = {}) => ({
    basis: 'roko',
    split: true,
    queue_ms: 80,
    workspace_ms: 290,
    prompt_ms: 30,
    ttft_ms: 300,
    model_ms: model,
    tools_ms: tools,
    checks_ms: checks,
    other_ms: 10,
    model_calls: 3,
    tool_calls: 2,
    tools: [],
    checks: [],
    ...extra
  })
  const at = (offset: number) => new Date(Date.UTC(2026, 9, 20, 12, 0, 0) + offset).toISOString()
  const timed = (attempt: number, rung: string, reason: string, outcome: string, start: number, timing: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => {
    const ms = timing && timing.basis === 'roko' ? ['prompt_ms', 'model_ms', 'tools_ms', 'checks_ms', 'other_ms'].reduce((n, k) => n + Number(timing[k] ?? 0), 0) : Number(timing?.agent_ms ?? 0) + Number(timing?.checks_ms ?? 0)

    return tryOf(attempt, rung, reason, outcome, { started_at: at(start), duration_ms: ms, timing, ...extra })
  }
  const timedRun = (id: string, t2Timing: Record<string, unknown> = phases(9_000, 1_000, 4_000)) =>
    ladderRow({
      run_id: id,
      state: 'succeeded',
      active: false,
      started_at: at(0),
      finished_at: at(90_000),
      tasks: [
        { task_id: 'T1', title: 'Seed the core library', outcome: 'passed', attempts: 1, gates: [], depends_on: [], climb: [timed(1, 'cheap', 'start', 'passed', 1_000, phases(20_000, 5_000, 10_000))], lives: { rung: 'cheap', used: 1, of: 2 } },
        { task_id: 'T2', title: 'Sine sub oscillator', outcome: 'passed', attempts: 1, gates: [], depends_on: ['T1'], climb: [timed(1, 'cheap', 'start', 'passed', 40_000, t2Timing)], lives: { rung: 'cheap', used: 1, of: 2 } },
        {
          task_id: 'T3',
          title: 'Band-limited saw',
          outcome: 'passed',
          attempts: 2,
          gates: [],
          depends_on: ['T1'],
          climb: [timed(1, 'cheap', 'start', 'failed', 40_000, phases(10_000, 2_000, 6_000)), timed(2, 'cheap', 'retry', 'passed', 60_000, phases(15_000, 3_000, 9_000))],
          lives: { rung: 'cheap', used: 2, of: 2 }
        }
      ],
      graph: { waves: [['T1'], ['T2', 'T3']], edges: [['T1', 'T2'], ['T1', 'T3']] }
    })

  it('a run’s time view: tasks as lanes, each try a run of its phases, the critical path, and the run’s split', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000041'

    backend.runs = [timedRun(id), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    openRunFold(card, 'time')

    const view = await within(card).findByTestId('time-view')
    const lanes = [...view.querySelectorAll('.rk-tl-lane')] as HTMLElement[]

    expect(lanes.map(lane => lane.querySelector('.rk-tl-name b')?.textContent)).toEqual(['T1', 'T2', 'T3'])
    // T3 failed once on cheap, then passed: two tries on its lane, each its model, tools, checks and the rest.
    const t3 = [...lanes[2].querySelectorAll('.rk-tl-try')] as HTMLElement[]

    expect(t3.map(t => t.getAttribute('data-outcome'))).toEqual(['failed', 'passed'])
    expect([...t3[1].querySelectorAll('i')].map(i => i.getAttribute('data-kind'))).toEqual(['model', 'tools', 'checks', 'other'])
    expect(Number.parseFloat(t3[1].style.left)).toBeCloseTo((60_000 / 90_000) * 100, 3)
    expect((t3[1].querySelector('i[data-kind="model"]') as HTMLElement).style.flexGrow).toBe('15000')
    // The critical path: T3 ended last, after T1.
    expect(lanes.map(lane => lane.getAttribute('data-critical'))).toEqual(['true', null, 'true'])
    expect(view.textContent).toContain('roko’s own split of each try')

    const split = within(view).getByTestId('time-split')

    // model 54,000 of the tries' 94,160 ms: 57 %.
    expect(split.textContent).toContain('model57%')
    expect(split.textContent).toContain('T1 → T3')
    // A lane's name opens its task's sheet.
    fireEvent.click(lanes[1].querySelector('.rk-tl-name') as HTMLElement)
    expect(await within(card).findByTestId('inspector-T2')).toBeTruthy()
  })

  it('a try an older roko timed without splitting model from tools is one span, never "the model took 13 s"', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000042'

    backend.runs = [timedRun(id, phases(13_072, 0, 2_000, { split: false, tool_calls: 2 })), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    openRunFold(card, 'time')

    const view = await within(card).findByTestId('time-view')
    const t2 = view.querySelectorAll('.rk-tl-lane')[1].querySelector('.rk-tl-try') as HTMLElement

    expect([...t2.querySelectorAll('i')].map(i => i.getAttribute('data-kind'))).toEqual(['agent', 'checks', 'other'])
    expect(t2.getAttribute('title')).toContain('model and tools 13s')
    expect(within(view).getByTestId('time-split').textContent).toContain('1 try did not split model from tools (a roko before f407b62e9)')
  })

  it('a run timed from events says so, and a run with no try time yet says what it waits for', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000043'

    backend.runs = [timedRun(id, { basis: 'events', split: false, agent_ms: 9_000, checks_ms: 3_000 }), ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    openRunFold(card, 'time')
    expect((await within(card).findByTestId('time-view')).textContent).toContain('≈ from event times')
  })

  it('the spec gate shows its progress on the horizon before any agent runs', async () => {
    const id = 'c8f19000-1111-4222-8333-000000000044'
    const pending = (ladderRow().tasks as Array<Record<string, unknown>>).map(t => ({ ...t, outcome: 'pending', attempts: 0, step: null, climb: [], lives: null }))

    backend.runs = [ladderRow({ run_id: id, tasks: pending, spec_gate: { state: 'running', steps_total: 8, steps_done: 5, cached: 2, passed: 0, ms: 40_000, elapsed_ms: null, blocked: null, started_at: at(0) } }), ...backend.runs]
    await mountPage({ run: id })

    const gate = await within(await screen.findByTestId(`run-card-${id}`)).findByTestId('spec-gate')

    expect(gate.textContent).toContain('spec gate · 5/8 steps · 2 cached')
    expect((gate.querySelector('.rk-sg-bar i') as HTMLElement).style.width).toBe('62.5%')
  })
})

describe('v8 (plugin-wow #7): what a run made', () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAADklEQVR4nGMQQAIMODkALAcCQaqvfAkAAAAASUVORK5CYII='
  const made = (extra: Record<string, unknown>[] = []) => ({
    ok: true,
    commit: 'd66293e36e22',
    items: [
      { path: 'artifacts/ui/editor-idle.png', name: 'editor-idle.png', kind: 'image', bytes: 812_000, width: 1200, height: 760 },
      { path: 'artifacts/audio/init.wav', name: 'init.wav', kind: 'audio', bytes: 4_300_000, audio: { seconds: 15, rate: 48_000, bits: 24, channels: 2, peaks: Array.from({ length: 240 }, (_, i) => (i < 120 ? 0.5 : 0)) } },
      { path: 'artifacts/reports/pluginval-strict.txt', name: 'pluginval-strict.txt', kind: 'report', bytes: 9_100, verdict: 'passed', line: 'SUCCESS' },
      { path: 'artifacts/reports/auval.txt', name: 'auval.txt', kind: 'report', bytes: 300, verdict: 'failed', line: 'AU VALIDATION FAILED: 1 test failed' },
      ...extra
    ]
  })

  it('an ended run shows what its work added: its UI shots, a sound’s waveform with a play key, a report’s verdict', async () => {
    backend.artifacts[RUN_DONE] = made()
    backend.artifactFiles['artifacts/ui/editor-idle.png'] = { ok: true, path: 'artifacts/ui/editor-idle.png', mime: 'image/png', data: PNG }
    await mountPage({ run: RUN_DONE })

    const strip = await within(await screen.findByTestId(`run-card-${RUN_DONE}`)).findByTestId('run-made')
    const shot = await within(strip).findByRole('img', { name: 'editor-idle.png, 1200 × 760' })

    // The shot, from the bytes the backend checked: URL-safe base64 made standard again.
    expect(shot.getAttribute('src')).toBe(`data:image/png;base64,${PNG.replace(/-/g, '+').replace(/_/g, '/')}`)

    const sound = within(strip).getByTestId('made-init.wav')

    expect(sound.textContent).toContain('init.wav')
    expect(sound.textContent).toContain('15s · 48 kHz · 24-bit')
    // Its waveform from its peaks: 60 bars, the loud half tall, the silent half flat.
    const bars = [...sound.querySelectorAll('.rk-made-wave i')] as HTMLElement[]

    expect(bars).toHaveLength(60)
    expect(bars[0].style.height).toBe('50%')
    expect(bars[59].style.height).toBe('0%')
    // Never played by itself: its bytes are asked for only when the person presses play.
    expect(api.mock.calls.some(([req]) => String(req.path).includes('artifact?path=artifacts%2Faudio'))).toBe(false)
    fireEvent.click(within(sound).getByRole('button', { name: 'play init.wav' }))
    await waitFor(() => expect(api.mock.calls.some(([req]) => String(req.path).includes('artifact?path=artifacts%2Faudio%2Finit.wav'))).toBe(true))
    // Each report says its tool's own verdict.
    expect(within(strip).getByTestId('made-pluginval-strict.txt').getAttribute('data-verdict')).toBe('passed')
    expect(within(strip).getByTestId('made-auval.txt').textContent).toContain('AU VALIDATION FAILED: 1 test failed')
    expect(within(strip).getByTestId('made-auval.txt').getAttribute('data-verdict')).toBe('failed')
  })

  it('phase 4 prep A: a shot opens large, with its name and size, ←/→ to the run’s other shots and Esc to close', async () => {
    const shots = [
      { path: 'artifacts/ui/editor-clipping.png', name: 'editor-clipping.png', kind: 'image', bytes: 152_392, width: 1200, height: 760 },
      { path: 'artifacts/ui/editor-idle.png', name: 'editor-idle.png', kind: 'image', bytes: 119_209, width: 1200, height: 760 }
    ]

    backend.artifacts[RUN_DONE] = { ok: true, commit: 'd66293e36e22', items: shots }
    for (const shot of shots) backend.artifactFiles[shot.path] = { ok: true, path: shot.path, mime: 'image/png', data: PNG }
    await mountPage({ run: RUN_DONE })

    const strip = await within(await screen.findByTestId(`run-card-${RUN_DONE}`)).findByTestId('run-made')

    fireEvent.click(await within(strip).findByRole('button', { name: 'Open editor-clipping.png large' }))

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('editor-clipping.png')).toBeTruthy()
    expect(dialog.textContent).toContain('1200 × 760 · 149 KB · 1 of 2')
    expect(await within(dialog).findByRole('img', { name: 'editor-clipping.png' })).toBeTruthy()
    fireEvent.keyDown(dialog, { key: 'ArrowRight' })
    expect(await within(screen.getByRole('dialog')).findByText('editor-idle.png')).toBeTruthy()
    expect(screen.getByRole('dialog').textContent).toContain('2 of 2')
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('phase 4 prep B: an image the run added under artifacts/ shows in Changes; another binary file keeps its note', async () => {
    backend.diffExtra = [{ path: 'artifacts/ui/editor-idle.png', old_path: null, status: 'added', additions: 0, deletions: 0, binary: true, language: null, truncated: false, hunks: [] }]
    backend.artifactFiles['artifacts/ui/editor-idle.png'] = { ok: true, path: 'artifacts/ui/editor-idle.png', mime: 'image/png', data: PNG }
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    openRunFold(card, 'changes')

    const changes = await within(card).findByTestId('changes')
    const shot = await within(changes).findByRole('img', { name: 'artifacts/ui/editor-idle.png' })

    expect(shot.getAttribute('src')).toBe(`data:image/png;base64,${PNG}`)
    expect(within(changes).getAllByText('Binary file: no line changes to show.')).toHaveLength(1)
  })

  it('a run that made nothing under artifacts/ shows no strip', async () => {
    await mountPage({ run: RUN_DONE })
    await screen.findByTestId(`run-card-${RUN_DONE}`)
    await waitFor(() => expect(api.mock.calls.some(([req]) => String(req.path).endsWith(`/runs/${RUN_DONE}/artifacts`))).toBe(true))
    expect(screen.queryByTestId('run-made')).toBeNull()
  })
})

describe('unloading', () => {
  it('disabling removes every contribution, the style, the cached queries and the event listener', async () => {
    await setPluginEnabled('roko', false)

    for (const area of ['routes', 'sidebar.nav', 'statusBar.right', 'palette', 'transcript.directives', 'panes', 'chat.empty', 'composer.actions', 'sessionRow.trailing', 'themes', 'settings.plugins']) {
      expect(registry.getArea(area).some(c => c.source === 'plugin:roko')).toBe(false)
    }

    expect(document.head.querySelector('style[data-hermes-plugin="roko"]')).toBeNull()
    expect(queryClient.getQueryCache().findAll({ queryKey: ['roko'] })).toHaveLength(0)
    // The live socket closed with the plugin.
    expect(FakeSocket.all.filter(socket => socket.readyState === 1)).toHaveLength(0)

    api.mockClear()
    act(() => {
      emitGatewayEvent({ payload: { name: 'roko_status', result: { run_id: RUN_DONE } }, session_id: 's1', type: 'tool.complete' })
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(api).not.toHaveBeenCalled()
  })
})

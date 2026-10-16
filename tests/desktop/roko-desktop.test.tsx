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
  PAGE_VERSION
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
function openTab(name: RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }))
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

    await waitFor(() => expect(chip.textContent).toContain('1 running · 2 waiting'))
    expect(chip.querySelector('.roko-dot')?.getAttribute('data-tone')).toBe('good')

    fireEvent.click(chip)
    expect(window.location.hash).toBe('#/roko#tab=waiting')
  })

  it('turns red when roko is unreachable and amber when it is degraded', async () => {
    backend.reachable = false
    mountContribution('statusBar.right', 'roko:chip')

    const chip = await screen.findByTestId('roko-status-chip')

    await waitFor(() => expect(chip.querySelector('.roko-dot')?.getAttribute('data-tone')).toBe('bad'))

    cleanup()
    backend.reachable = true
    backend.connectionStatus = 'degraded'
    queryClient.removeQueries({ queryKey: ['roko'] })
    mountContribution('statusBar.right', 'roko:chip')

    const again = await screen.findByTestId('roko-status-chip')

    await waitFor(() => expect(again.querySelector('.roko-dot')?.getAttribute('data-tone')).toBe('warn'))
  })
})

describe('the /roko page', () => {
  it('header: connection, spend, and the Runs tab with the selected run card', async () => {
    await mountPage({ run: RUN_ACTIVE })

    await waitFor(() => expect(screen.getByTestId('roko-connection').textContent).toBe('http://127.0.0.1:6677 · v0.1.0 · ok'))
    expect(screen.getByTestId('roko-spend').textContent).toBe('today $0.42 of $10.00 · $1.00 committed · $8.58 left')

    const list = screen.getByRole('list', { name: 'roko runs' })

    expect(within(list).getByText('add-tests')).toBeTruthy()
    expect(within(list).getByText('Add clamp() with a test')).toBeTruthy()
    expect(within(list).getByText('Plan the parser rewrite')).toBeTruthy()

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(within(card).getByText('lexer')).toBeTruthy())
    expect(card.querySelector('.roko-pill')?.textContent).toBe('⟳ running')
    expect(within(card).getByText('running · gates 1/2 · $0.42 of $0.50 · 1m 05s')).toBeTruthy()
    // 0.42 of 0.50 is 84 %: amber.
    expect(card.querySelector('.roko-meter')?.getAttribute('data-level')).toBe('warn')
    expect(card.querySelector('.roko-meter-text')?.textContent).toBe('$0.42 / $0.50')
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
    // The hero's instruments, and the request the person typed.
    expect(within(card).getByText('Add tests for the lexer and the parser, and write up what they cover.')).toBeTruthy()
    expect(within(card).getByTestId('instrument-eta').textContent).toContain('~4 min')
    expect(within(card).getByRole('img', { name: '1 of 3 tasks passed, 1 running' })).toBeTruthy()
    // What runs now.
    expect(within(within(card).getByTestId('now-strip')).getByText('waiting on you')).toBeTruthy()
    expect(within(card).getByText('Waiting on you (2)')).toBeTruthy()
    expect(within(card).getByRole('button', { name: 'Cancel run' })).toBeTruthy()
  })

  it('selecting a run shows its delivery and copies the review command; the selection lives in the hash', async () => {
    await mountPage()

    fireEvent.click(within(screen.getByRole('list', { name: 'roko runs' })).getByText('Add clamp() with a test'))

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    await waitFor(() => expect(within(card).getByText(`roko/batch/${RUN_DONE}`)).toBeTruthy())
    expect(window.location.hash).toBe(`#/roko#run=${RUN_DONE}`)
    expect(within(card).getByText('1 file changed, 30 insertions(+)')).toBeTruthy()
    expect(within(card).getByText('src/lib.rs')).toBeTruthy()
    expect(within(card).queryByRole('button', { name: 'Cancel run' })).toBeNull()

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

    await waitFor(() => expect(card.querySelector('.roko-pill')?.getAttribute('data-tone')).toBe('warn'))
    expect(card.querySelector('.roko-pill')?.textContent).toContain('unverified')
    expect(card.querySelector('.roko-meter-text')?.textContent).toBe('— / —')
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

    fireEvent.click(within(card).getByRole('tab', { name: /^Activity/ }))

    expect(await within(card).findByText('T1 started: lexer')).toBeTruthy()
    expect(await within(card).findByText('T2 gate verify[0:test] failed')).toBeTruthy()
    expect(called('GET', `/runs/${RUN_ACTIVE}/events?limit=200`)).toBe(true)
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

  it('Cancel run asks first, then POSTs /runs/{id}/cancel', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    fireEvent.click(await within(card).findByRole('button', { name: 'Cancel run' }))

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByText('Cancel this roko run?')).toBeTruthy()
    expect(called('POST', `/runs/${RUN_ACTIVE}/cancel`)).toBe(false)

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel run' }))
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
    expect(within(effect).getByText('held action')).toBeTruthy()
  })

  it('Approve sends POST /decide with the code and the note, shows the outcome and refreshes', async () => {
    await mountPage()
    openTab(/^Waiting/)

    const confirm = await screen.findByTestId('pending-a1b2c3')

    fireEvent.change(within(confirm).getByRole('textbox', { name: 'Note for roko (optional)' }), { target: { value: 'looks right' } })
    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve' }))

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

    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve' }))
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

    fireEvent.click(within(effect).getByRole('button', { name: 'Reject' }))
    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(expect.objectContaining({ body: { approve: false, code: 'd4e5f6' }, path: '/api/plugins/roko/decide' }))
    )
    // roko's outcome only when it adds to the verb: not "Rejected · rejected".
    await waitFor(() => expect(toastTitles()).toContain('roko: Rejected'))
    expect(toastTitles()).not.toContain('roko: Rejected · rejected')

    backend.failures.set('/decide', { code: 'not_found', hint: 'It may have been answered already.', message: 'No waiting item a1b2c3.' })

    const confirm = await screen.findByTestId('pending-a1b2c3')

    fireEvent.click(within(confirm).getByRole('button', { name: 'Approve' }))
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

  it('a demo stays a demo after its run by its set; without any set (an older roko) a demo- id is the sign', async () => {
    await reloadPlugin()
    // roko's own listing after demo-hello ran: no longer `fixture`, still in `demos`; a top-level demo- plan of the person's.
    backend.plans = [
      { id: 'add-tests', title: 'Add tests', task_count: 3, tasks_done: 1, status: 'ready', group: 'work' },
      { id: 'demo-mine', title: 'My own demo plan', task_count: 1, tasks_done: 0, status: 'ready' },
      { id: 'demo-hello', title: 'Roko plan-runner demo', task_count: 1, tasks_done: 1, status: 'done', group: 'demos' }
    ]
    await mountPage()
    openTab(/^Plans/)

    let rows = await screen.findByRole('list', { name: 'roko plans' })
    const titles = () => [...rows.querySelectorAll('.roko-row-title')].map(el => el.textContent)
    const sections = () => [...rows.querySelectorAll('.roko-list-section')].map(el => el.firstChild?.textContent)

    expect(sections()).toEqual(['Demos', 'Your plans', 'work'])
    expect(titles()).toEqual(['Roko plan-runner demo', 'My own demo plan', 'Add tests'])
    cleanup()

    // An older roko or plugin: no plan carries `group`.
    backend.plans = backend.plans.map(({ group: _group, ...plan }) => plan)
    queryClient.removeQueries({ queryKey: ['roko'] })
    await mountPage()
    openTab(/^Plans/)
    rows = await screen.findByRole('list', { name: 'roko plans' })
    await waitFor(() => expect(sections()).toEqual(['Demos', 'Your plans']))
    expect(titles()).toEqual(['My own demo plan', 'Roko plan-runner demo', 'Add tests'])
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
  it('a run roko ended as interrupted reads as its own outcome: its reason, what is kept, no Merge', async () => {
    const id = '5b0c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4'
    const reason = 'roko stopped while this run was going (machine restart or crash)'

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
    expect(within(why).getByTestId('why-next').textContent).toContain('kept on its own branch')
    expect(within(card).queryByTestId('merge-button')).toBeNull()
    expect(within(card).queryByRole('button', { name: /Copy merge command/ })).toBeNull()
    expect(called('GET', `/runs/${id}/merge`)).toBe(false)

    // In the run list it is its own outcome, orange: not a failure, not a pass.
    const row = [...document.querySelectorAll('.roko-row')].find(r => r.textContent?.includes('crash-demo')) as HTMLElement

    expect(row.textContent).toContain('interrupted')
    expect(row.querySelector('.rk-led')?.getAttribute('data-tone')).toBe('you')
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

    const tasks = within(card).getByTestId('instrument-tasks')

    expect(tasks.textContent).not.toMatch(/running/)
    expect(tasks.textContent).toContain('1 stopped')
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
    const checks = await within(card).findByTestId('instrument-checks')

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
    const pill = card.querySelector('.roko-hero-top .roko-pill') as HTMLElement

    expect(pill.textContent).toBe('■ stopped · cap')
    expect(pill.getAttribute('data-tone')).toBe('muted')
    expect(pill.getAttribute('data-stop')).toBe('cap')
    // The dashboard's words: the cap and the spend as roko gives them.
    expect(pill.getAttribute('title')).toBe('roko stopped the run at its cap of $0.05 ($0.032 spent)')
    expect((card.querySelector('.roko-hero-top .roko-dot') as HTMLElement).getAttribute('data-tone')).toBe('muted')
    expect((card.querySelector('.roko-headline') as HTMLElement).textContent).toBe('stopped: the run reached its cap · tasks 0/2 · $0.032 of $0.05 · 3s')

    const why = within(card).getByTestId('why')

    expect(why.getAttribute('data-tone')).toBe('muted')
    expect(why.textContent).toContain('Why it stopped')
    expect(why.textContent).toContain('The run stopped: it reached its cap of $0.05, with $0.032 spent.')
    expect(why.textContent).not.toContain('did not pass')
    expect(within(card).getByTestId('next').textContent).toBe('raise the cap and run it again')
    expect(within(card).getByTestId('instrument-tasks').textContent).toContain('2 stopped')

    // The task the cap stopped says why in its inspector.
    fireEvent.click(within(why).getByRole('button', { name: 'Inspect T2' }))
    expect((await within(card).findByTestId('task-stopped')).textContent).toBe(
      "Stopped at the run's cap: its next model call would cost about $0.021, and only $0.018 of the $0.05 cap was left"
    )

    // In the runs list too; a run that failed (an older card, no budget_stop) still says so.
    const rows = screen.getByRole('list', { name: 'roko runs' })
    const capRow = within(rows).getByText('Cap stop').closest('[role="listitem"]') as HTMLElement

    expect(capRow.textContent).toContain('stopped · cap')
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
    const pill = card.querySelector('.roko-hero-top .roko-pill') as HTMLElement

    expect(pill.textContent).toBe('■ stopped · day limit')
    expect(pill.getAttribute('data-tone')).toBe('muted')
    expect(pill.getAttribute('title')).toBe('roko stopped the run at today’s limit of $20.00 ($20.04 spent)')
    expect(within(card).getByTestId('why').textContent).toContain('Why it stopped')
    // Nothing to press: a run started now would stop at once.
    expect(within(card).getByTestId('next').getAttribute('data-action')).toBe('none')
    expect(within(card).getByTestId('next').textContent).toBe('raise the daily limit or run it tomorrow')

    const rows = screen.getByRole('list', { name: 'roko runs' })

    expect((within(rows).getByText('Day stop').closest('[role="listitem"]') as HTMLElement).textContent).toContain('stopped · day limit')

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
    const tasks = within(card).getByTestId('instrument-tasks')

    expect(tasks.textContent).toContain('1 skipped')
    expect(tasks.querySelector('.roko-ring-arc[data-kind="skipped"]')).toBeTruthy()

    const row = within(screen.getByRole('list', { name: 'roko runs' })).getByText('One skipped').closest('[role="listitem"]') as HTMLElement

    expect(row.querySelectorAll('.rk-strip i[data-state="skipped"]')).toHaveLength(1)
    expect(row.querySelectorAll('.rk-strip i[data-state="pending"]')).toHaveLength(0)
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
    expect(within(card).getByTestId('now-checking').textContent).toBe('checking the workspace: cargo test')
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

    expect((await within(card).findByTestId('instrument-starting')).textContent).toBe('starting…')
    expect(card.textContent).not.toMatch(/started \d+s ago/)

    // roko's start arrives: the clock counts from it, not from the click.
    backend.runs = backend.runs.map(row => (row.run_id === id ? { ...row, started_at: new Date(Date.now() - 2_000).toISOString() } : row))
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko', 'run', id] })
    })
    await waitFor(() => expect(within(card).queryByTestId('instrument-starting')).toBeNull())
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

    expect((await within(card).findByTestId('ticker-checking')).textContent).toMatch(/^checking the workspace: cargo clippy \(2 of 3\) · 3:0\d$/)
    expect(within(card).getByTestId('now-checking').textContent).toMatch(/^checking the workspace: cargo clippy \(2 of 3\) · 3:0\d$/)
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

    expect((await within(card).findByTestId('now-checking')).textContent).toMatch(/^finishing: the plan's checks before delivery · 0:2\d$/)
  })

  it('an older card without `checking` keeps the plain idle words', async () => {
    const id = '6c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d6'

    backend.runs = [{ run_id: id, kind: 'plan', label: 'speed-test', plan_id: 'speed-test', state: 'running', active: true, cost_usd: 0, max_usd: 0.5, started_at: new Date().toISOString() }, ...backend.runs]
    await mountPage({ run: id })

    const card = await screen.findByTestId(`run-card-${id}`)

    await waitFor(() => expect(within(card).getByTestId('now-strip').textContent).toContain('between tasks…'))
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

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))

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

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))

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

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))

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

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))
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

    expect(card.querySelector('.roko-pill')?.textContent).toContain('unverified')
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

    expect(card.querySelector('.roko-pill')?.textContent).toContain('interrupted')
    expect(within(card).getByTestId('why').textContent).toContain('nothing runs it any more')
    expect((await within(card).findByTestId('next-key')).textContent).toContain('run the plan again')

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))

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

    expect(card.querySelector('.roko-pill')?.textContent).toContain('failed')
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
    expect(within(card).queryByRole('button', { name: 'Cancel run' })).toBeNull()
    expect(screen.queryByTestId('new-run')).toBeNull()
    openTab(/^Waiting/)

    const notes = await screen.findAllByTestId('actions-off')

    expect(notes[0].textContent).toContain('/roko approve a1b2c3')
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull()
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
  it('::roko-run renders a live compact card that expands to the full card', async () => {
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${RUN_ACTIVE}"}`} />)

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(card.querySelector('.roko-meter-text')?.textContent).toBe('$0.42 / $0.50'))
    expect(card.getAttribute('data-compact')).toBe('true')
    expect(within(card).getByText('2 waiting on you')).toBeTruthy()

    fireEvent.click(within(card).getByRole('button', { name: 'Details' }))
    expect(await screen.findByText('lexer')).toBeTruthy()
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

  it('::roko-plan shows the waves, the estimate and Run plan…', async () => {
    mount(<TranscriptDirectiveLeaf streaming={false} text={'::roko-plan{id="add-tests"}'} />)

    const card = await screen.findByTestId('plan-card-add-tests')

    expect(within(card).getByText('W2')).toBeTruthy()
    expect(within(card).getByTestId('plan-estimate').textContent).toBe('est $0.03 · ~30s · confidence low')
    expect(within(card).getByRole('button', { name: 'Run plan…' })).toBeTruthy()
  })

  it('::roko-pending lists that run’s waiting items with Approve and Reject', async () => {
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-pending{run="${RUN_ACTIVE}"}`} />)

    const item = await screen.findByTestId('pending-a1b2c3')

    expect(screen.getByTestId('pending-d4e5f6')).toBeTruthy()
    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }))
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

  it('one aggregated toast and one native notification per poll; nothing on the first load', async () => {
    // Hermes throttles a plugin's native notifications to one a second; earlier
    // tests (Cancel run) may have just used it.
    await new Promise(resolve => setTimeout(resolve, 1_100))
    await reloadPlugin()
    await waitFor(() => expect(queryClient.getQueryData(['roko', 'overview'])).toBeDefined())

    // First load: seeded, nothing announced.
    expect(toastTitles()).not.toContain('roko: run succeeded · 1 item waits on you')
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
        title: 'roko: run succeeded · 1 item waits on you'
      })
    )
    expect(toastTitles().filter(t => t === 'roko: run succeeded · 1 item waits on you')).toHaveLength(1)
    expect(toastTitles()[0]).toBe('roko: run succeeded · 1 item waits on you')

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
    expect(screen.getByTestId('roko-connection').textContent).toBe('unreachable · http://127.0.0.1:6677')
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
    expect(screen.getByTestId('live-state').querySelector('.rk-led')?.getAttribute('data-tone')).toBe('fail')
    expect(within(await screen.findByTestId('setup-module')).getByTestId('problem-roko-unreachable')).toBeTruthy()

    fireEvent.click(screen.getByTestId('new-run'))

    const dialog = await screen.findByRole('dialog')

    expect(within(dialog).getByTestId('problem-card-roko-unreachable')).toBeTruthy()
    expect((within(dialog).getByTestId('composer-submit') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(dialog, { key: 'Escape' })
  })

  it('roko down: a running run is only its last known state, its clock stopped, nothing to cancel; the chip says offline', async () => {
    backend.reachable = false
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)
    const note = await within(card).findByTestId('last-known')

    expect(note.textContent).toMatch(/^roko serve is not answering: this is the run’s last known state(, from \d{2}:\d{2}(:\d{2})?)?\. It may still be going, or it stopped when roko did\.$/)
    expect(card.querySelector('.roko-pill')?.textContent).toContain('last seen running')
    expect(within(card).queryByRole('button', { name: 'Cancel run' })).toBeNull()

    const row = [...document.querySelectorAll('.roko-row')].find(r => r.textContent?.includes('add-tests')) as HTMLElement

    expect(row.textContent).toContain('last seen running')
    cleanup()
    mountContribution('statusBar.right', 'roko:chip')
    expect(await screen.findByTestId('chip-offline')).toBeTruthy()
    // What roko last said is not news: no "1 running" beside "offline".
    expect(screen.getByTestId('roko-status-chip').textContent).not.toMatch(/running|waiting/)
  })

  it('roko stops while a run is open: the card turns into its last known state, with one note and no second error', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    expect(card.querySelector('.roko-pill')?.textContent).toContain('running')
    expect(within(card).getAllByRole('button', { name: 'Approve' }).length).toBeGreaterThan(0)
    backend.reachable = false
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['roko'] })
    })

    const note = await within(card).findByTestId('last-known')

    // Its sign-offs are only what roko last said: an answer needs roko.
    expect(within(card).queryByRole('button', { name: 'Approve' })).toBeNull()

    expect(note.textContent).toContain('It may still be going, or it stopped when roko did.')
    expect(card.getAttribute('data-state')).toBe('last_seen')
    expect(card.querySelector('.roko-pill')?.textContent).toContain('last seen running')
    expect(within(card).queryByRole('button', { name: 'Cancel run' })).toBeNull()
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
    // Lines after the playhead are dimmed.
    expect(card.querySelectorAll('.roko-feed-row[data-future="true"]').length).toBeGreaterThan(0)

    fireEvent.click(within(card).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(nodeIn(card, 'T1').getAttribute('data-state')).toBe('failed'))
    expect(within(card).queryByRole('slider')).toBeNull()
  })

  it('Changes: a file list beside a unified diff, with numbers, tint, and hostile text printed literally', async () => {
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))

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

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))
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

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))

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

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))

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

    expect(within(card).getByText('1 file changed, 30 insertions(+)')).toBeTruthy()
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

  it('a chat card for a live plan run shows the graph in miniature and what runs now', async () => {
    mount(<TranscriptDirectiveLeaf streaming={false} text={`::roko-run{id="${RUN_ACTIVE}"}`} />)

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(within(card).getByRole('img', { name: '3 tasks in 2 waves' })).toBeTruthy())
    expect(card.querySelectorAll('.roko-mini-dot')).toHaveLength(3)
    // T2 runs but waits on the person's sign-off: orange, "you", not the agent's blue.
    expect(card.querySelector('.roko-mini-dot[data-state="waiting"]')).toBeTruthy()
    expect(card.querySelector('.roko-mini-dot[data-state="running"]')).toBeNull()
    expect(within(card).getByText('waiting on you')).toBeTruthy()
    expect(within(card).getByTestId('cc-waiting').getAttribute('data-channel')).toBe('you')
    expect(within(card).getByText('1/3 tasks passed', { exact: false })).toBeTruthy()
  })

  it('the status chip carries a step strip for the running run', async () => {
    mountContribution('statusBar.right', 'roko:chip')

    const chip = await screen.findByTestId('roko-status-chip')

    await waitFor(() => expect(chip.querySelector('.rk-chip-strip')).toBeTruthy())
    expect(chip.querySelector('.rk-chip-strip')?.getAttribute('aria-label')).toBe('1 of 3 tasks passed, 1 running')
    // The run waits on the person, so what runs is what waits: orange, blinking fast.
    expect([...chip.querySelectorAll('.rk-chip-strip i')].map(i => i.getAttribute('data-state'))).toEqual(['passed', 'waiting', 'pending'])
  })

  it('the status chip’s strip stays blue while nothing waits on the person', async () => {
    backend.pending = []
    mountContribution('statusBar.right', 'roko:chip')

    const chip = await screen.findByTestId('roko-status-chip')

    await waitFor(() => expect(chip.querySelector('.rk-chip-strip')).toBeTruthy())
    expect([...chip.querySelectorAll('.rk-chip-strip i')].map(i => i.getAttribute('data-state'))).toEqual(['passed', 'running', 'pending'])
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
    expect(card.querySelector('.roko-hero-slug')?.textContent).toBe('add-tests')
  })

  it('a refused merge says why in the dialog, as sentences', async () => {
    await reloadPlugin()
    backend.mergeConflict = true
    await mountPage({ run: RUN_DONE })

    const card = await screen.findByTestId(`run-card-${RUN_DONE}`)

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))
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

    fireEvent.click(within(card).getByRole('tab', { name: /^Changes/ }))

    const merged = await within(card).findByTestId('changes-merged')

    expect(within(merged).getByText('This run’s work is merged')).toBeTruthy()
    expect(within(merged).getByText("Its changes (1 file changed, 30 insertions(+)) are in your checkout.")).toBeTruthy()
    expect(within(card).queryByText('No changes to review')).toBeNull()
  })

  it('motion stops for people who ask for less', () => {
    const css = document.head.querySelector('style[data-hermes-plugin="roko"]')?.textContent ?? ''

    expect(css).toContain('@media (prefers-reduced-motion:reduce)')
    expect(css).toMatch(/prefers-reduced-motion:reduce\)\{\.roko \*,[^}]*animation-duration:0s!important/)
    // No literal colors: every color comes from the theme.
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(css).not.toMatch(/rgba?\(/)
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

  it('the run is one instrument: a dot-matrix display bar with numbered modules, the ticker, the sequencer', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)
    const display = await within(card).findByTestId('display')

    // Changing numbers are dot-matrix displays: an SVG of lit dots that says its value to assistive tech.
    const spend = within(display).getByRole('img', { name: 'spent $0.42' })

    expect(spend.tagName.toLowerCase()).toBe('svg')
    expect(spend.querySelectorAll('.rk-dots-on')).toHaveLength(5)
    expect(within(display).getByRole('img', { name: '1 of 2 checks passed' })).toBeTruthy()
    expect([...display.querySelectorAll('.rk-mod')].map(m => m.textContent)).toEqual(['01tasks', '02time', '03spend', '04checks', '05model', '06pulse'])
    // 05 MODEL says where the latest pick came from: the router, learned, with its probability.
    // An older backend's `source: "router"` with scores that differ: picked by the router, with its odds.
    expect(within(display).getByTestId('instrument-model').textContent).toContain('router · p 0.82')
    // The ticker: T2 waits on a sign-off, so that is what is happening now.
    expect(card.querySelector('.rk-ticker')?.textContent).toContain('waiting on you')
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
    expect(within(card).getByText('running · gates 1/2 · $0.44 of $0.50 · 1m 20s')).toBeTruthy()
    // The spend display rolled the digits that changed.
    const spend = within(card).getByRole('img', { name: 'spent $0.44' })

    expect(spend.querySelectorAll('.rk-dots-on[data-roll="true"]').length).toBeGreaterThan(0)

    // An agent's tool step reaches the ticker and its pad at once.
    push(socket, { attempt: 1, kind: 'tool', plan_id: 'add-tests', run_id: RUN_ACTIVE, target: 'src/parser.rs', task_id: 'T3', tool: 'Edit', tool_id: 'T3-1-0', ts: Date.now(), type: 'live' })
    await waitFor(() => expect(card.querySelector('.rk-ticker-item[data-age="0"]')?.textContent).toBe('T3 Edit src/parser.rs'))
    expect(within(nodeIn(card, 'T3')).getByText('Edit src/parser.rs')).toBeTruthy()

    // Timeline lines merge into the activity by cursor.
    push(socket, { lines: [{ cursor: 9100, group: 'agent', task_id: 'T3', text: 'T3 attempt 1 on glm-5.1 (zai)', ts_millis: Date.now(), type: 'agent_spawned' }], run_id: RUN_ACTIVE, type: 'lines' })
    fireEvent.click(within(card).getByRole('tab', { name: /^Activity/ }))
    expect(await within(card).findByText('T3 attempt 1 on glm-5.1 (zai)')).toBeTruthy()
    // None of that needed a request.
    expect(called('GET', `/runs/${RUN_ACTIVE}`)).toBe(false)
  })

  it('untrusted words in frames stay text: the ticker and the loops print markup literally', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)
    const socket = await openSocket()
    const hostile = '<img src=x onerror="alert(1)"> **not bold**'

    await waitFor(() => expect(nodeIn(card, 'T1')).toBeTruthy())
    push(socket, { attempt: 2, kind: 'text', plan_id: 'add-tests', run_id: RUN_ACTIVE, screened: false, task_id: 'T2', text: hostile, ts: Date.now(), type: 'live' })
    await waitFor(() => expect(card.querySelector('.rk-ticker')?.textContent).toContain(hostile))
    expect(card.querySelector('.rk-ticker img, .rk-ticker strong')).toBeNull()

    push(socket, { data: {}, key: 'diagnosis:hostile', kind: 'diagnosis', plan_id: 'add-tests', ring: 'L2', run_id: RUN_ACTIVE, task_id: 'T2', text: hostile, ts: Date.now(), type: 'loop' })
    fireEvent.click(within(card).getByRole('tab', { name: /^Loops/ }))

    const loops = await within(card).findByTestId('loops')

    expect(within(loops).getAllByText(hostile).length).toBeGreaterThan(0)
    expect(loops.querySelector('img, strong')).toBeNull()
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

  it('the Loops view: a dial with a tick per event on its ring, each ring’s latest events and roko’s numbers', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    fireEvent.click(await within(card).findByRole('tab', { name: /^Loops/ }))

    const loops = await within(card).findByTestId('loops')

    await waitFor(() => expect(loops.querySelectorAll('.rk-dial-tick')).toHaveLength(activeLoops().length))
    expect(loops.querySelectorAll('.rk-dial-tick[data-channel="you"]').length).toBe(2)
    expect(called('GET', '/loops')).toBe(true)

    const l1 = within(loops).getByTestId('ring-L1')

    // An older backend's bare numbers ("(learned; p 0.82; over …)") are said in words from the event's data.
    expect(within(l1).getByText('T2 attempt 2 → glm-5.1, picked by the router (p 0.82)')).toBeTruthy()
    expect(within(l1).getByRole('img', { name: '3 events on L1' })).toBeTruthy()
    await waitFor(() => expect(within(l1).getByText('verify[0:test] up to 1 retry · passes 92%')).toBeTruthy())
    expect(within(within(loops).getByTestId('ring-L3')).getByText('glm-5.1 · passes 90% of 9 tasks')).toBeTruthy()
    expect(within(within(loops).getByTestId('ring-L4')).getByText('model routing healthy · holdout 10% · reach 4% · 40 decisions')).toBeTruthy()

    // A loop frame drops a fresh tick on its ring.
    const socket = await openSocket()

    push(socket, { data: { loop_id: 'L-route', state: 'watch' }, key: 'health:L-route:watch', kind: 'loop_health', plan_id: null, ring: 'L4', run_id: RUN_ACTIVE, task_id: null, text: 'L-route: healthy → watch (eps rose to 0.12)', ts: Date.now(), type: 'loop' })
    await waitFor(() => expect(loops.querySelector('.rk-dial-tick[data-fresh="true"]')).toBeTruthy())
    expect(within(within(loops).getByTestId('ring-L4')).getByText('L-route: healthy → watch (eps rose to 0.12)')).toBeTruthy()
    push(socket, { data: { loop_id: 'L-know', state: 'probation', h: 0.2, eps: 0.04 }, key: 'health:L-know:probation', kind: 'loop_health', plan_id: null, ring: 'L4', run_id: RUN_ACTIVE, task_id: null, text: 'L-know: probation · h 0.20', ts: Date.now(), type: 'loop' })
    expect(await within(within(loops).getByTestId('ring-L4')).findByText('lessons in prompts: on probation · holdout 20% · reach 4%')).toBeTruthy()

    // The page's Loops tab hears every run.
    cleanup()
    await mountPage({ tab: 'loops' })
    expect((await screen.findAllByText('L-route: healthy → watch (eps rose to 0.12)')).length).toBeGreaterThan(0)
  })

  it('orange means you: a run that waits on the person is orange wherever it shows, and its lights blink fast', async () => {
    await mountPage({ run: RUN_ACTIVE })

    const card = await screen.findByTestId(`run-card-${RUN_ACTIVE}`)

    await waitFor(() => expect(within(card).getByTestId('hero-waiting')).toBeTruthy())
    // The hero says it, in the you channel; the display bar says it instead of "1 running".
    expect(within(card).getByTestId('hero-waiting').getAttribute('data-channel')).toBe('you')
    expect(within(card).getByTestId('instrument-waiting').getAttribute('data-channel')).toBe('you')
    // The ticker's glass and light turn orange, and the light blinks fast.
    const ticker = card.querySelector('.rk-ticker') as HTMLElement

    expect(ticker.getAttribute('data-tone')).toBe('you')
    expect(ticker.querySelector('.rk-led')?.getAttribute('data-tone')).toBe('you')
    expect(ticker.querySelector('.rk-led')?.getAttribute('data-blink')).toBe('fast')
    expect(ticker.querySelector('.rk-ticker-item[data-channel="you"]')?.textContent).toContain('waiting on you')
    // The now strip: T2 waits on you; the label goes orange too.
    const now = within(card).getByTestId('now-strip')

    expect(now.querySelector('.roko-now-label')?.getAttribute('data-channel')).toBe('you')
    expect(now.querySelector('.roko-now-item[data-channel="you"]')?.textContent).toContain('waiting on you')
    // The pad that waits is orange and blinks fast.
    const pad = card.querySelector('.roko-node[data-node="T2"]') as HTMLElement

    expect(pad.getAttribute('data-channel')).toBe('you')
    expect(pad.querySelector('.rk-led')?.getAttribute('data-blink')).toBe('fast')
    // The run list: the word and the strip of the waiting run are orange, its light blinks fast.
    const row = [...document.querySelectorAll('.roko-row')].find(r => r.textContent?.includes('add-tests')) as HTMLElement

    expect(row.querySelector('.roko-row-meta [data-tone="warn"]')?.textContent).toBe('waiting on you')
    expect(row.querySelector('.rk-strip i[data-state="waiting"]')).toBeTruthy()
    expect(row.querySelector('.roko-row-lead .rk-led')?.getAttribute('data-tone')).toBe('you')
    expect(row.querySelector('.roko-row-lead .rk-led')?.getAttribute('data-blink')).toBe('fast')
    // The Waiting tab counts in orange too.
    expect(screen.getByTestId('waiting-count').textContent).toBe('2')
    expect(screen.getByTestId('waiting-count').className).toContain('rk-count-you')
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
    await waitFor(() => expect(within(monitor).getByRole('img', { name: '1 of 3 tasks passed, 1 running' })).toBeTruthy())
    expect(monitor.querySelector('.rk-ticker')).toBeTruthy()
    expect(within(monitor).getByRole('button', { name: '2 waiting' })).toBeTruthy()

    cleanup()
    backend.runs = backend.runs.filter(row => row.state !== 'running')
    queryClient.removeQueries({ queryKey: ['roko'] })
    mountContribution('panes', 'roko:monitor')

    const idle = await screen.findByTestId('monitor')

    expect(await within(idle).findByRole('img', { name: 'no run' })).toBeTruthy()
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

    expect(theme.colors.primary).toBe('#ff5f1f')
    expect(theme.colors.background).toBe('#e8e8e6')
    expect(theme.darkColors.background).toBe('#121314')
    expect(theme.customCSS).toContain('--ui-orange:#ff5f1f')
    expect(resolveTheme('roko')?.label).toBe('roko')
  })

  it('a settings page: the connection, the limits, sounds and the doctor', async () => {
    mountContribution('settings.plugins', 'roko:settings')

    const page = await screen.findByTestId('roko-settings')

    expect(await within(page).findByText(/http:\/\/127\.0\.0\.1:6677 · v0\.1\.0 · ok/)).toBeTruthy()
    expect(within(page).getByText('at most $5.00')).toBeTruthy()
    expect(await within(page).findByText('roko serve 0.1.0, status ok')).toBeTruthy()
    expect((within(page).getByRole('switch') as HTMLButtonElement).getAttribute('aria-checked')).toBe('false')
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

    const key = await screen.findByTestId('sound-key')

    expect(key.getAttribute('aria-pressed')).toBe('false')
    act(() => {
      emitGatewayEvent({ payload: { cost_usd: 0.2, headline: 'succeeded', label: 'quiet run', run_id: RUN_DONE, state: 'succeeded' }, session_id: 's1', type: 'plugin.roko.run.ended' })
    })
    expect(created).toHaveLength(0)

    fireEvent.click(key)
    expect(key.getAttribute('aria-pressed')).toBe('true')
    expect(created).toHaveLength(1)
    expect(localStorage.getItem('hermes.plugin.roko.sound')).toBe('true')
    fireEvent.click(key)
    expect(localStorage.getItem('hermes.plugin.roko.sound')).toBe('false')
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

  it('reduced motion: the dial’s hand stands still, and nothing decodes', async () => {
    const before = (window as unknown as { matchMedia?: unknown }).matchMedia

    setGlobal('matchMedia', (query: string) => ({ addEventListener: () => undefined, addListener: () => undefined, dispatchEvent: () => false, matches: query.includes('reduce'), media: query, onchange: null, removeEventListener: () => undefined, removeListener: () => undefined }))

    try {
      await mountPage({ tab: 'loops' })

      const loops = await screen.findByTestId('loops')

      expect(loops.querySelector('.rk-dial-hand')?.getAttribute('data-still')).toBe('true')
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

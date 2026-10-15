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

import { activeLoops, type ApiRequest, DONE_COMMIT, FakeBackend, HOSTILE_LINE, RUN_ACTIVE, RUN_DONE, RUN_FAILED, RUN_NEW, RUN_PLANGEN, RUN_UNVERIFIED } from './fake-backend'

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
  it('shows waves, task chips, checks and the estimate', async () => {
    await mountPage()
    openTab(/^Plans/)

    const card = await screen.findByTestId('plan-card-add-tests')

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
    openTab(/^Plans/)

    const card = await screen.findByTestId('plan-card-add-tests')

    fireEvent.click(within(card).getByRole('button', { name: 'Run plan…' }))

    const form = await screen.findByRole('dialog')
    const cap = within(form).getByLabelText('Spend cap (max_usd)') as HTMLInputElement

    expect(cap.value).toBe('1.00')
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

describe('limits and permissions', () => {
  it('the cap cannot pass the per-run cap or what is left today', async () => {
    await mountPage()
    openTab(/^Plans/)

    const card = await screen.findByTestId('plan-card-add-tests')

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
    openTab(/^Plans/)
    await screen.findByTestId('plan-card-add-tests')
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
    expect(screen.getByText(/Restart Hermes to load roko's backend\./)).toBeTruthy()
    expect((await screen.findByTestId('roko-status-text')).textContent).toBe('roko: 1 run active (fake /roko status)')
    expect(gatewayRequest).toHaveBeenCalledWith('command.dispatch', { arg: 'status', name: 'roko' })
    expect(screen.queryByRole('tab', { name: /^Runs/ })).toBeNull()
  })

  it('roko unreachable: the error and hint show, and the last known runs stay', async () => {
    backend.reachable = false
    await mountPage()

    const title = await screen.findByText('roko serve is not answering at http://127.0.0.1:6677', { selector: '.roko-banner-title' })
    const banner = title.closest('.roko-banner') as HTMLElement

    expect(banner.getAttribute('data-tone')).toBe('bad')
    expect(within(banner).getByText('Start it with `roko serve`.')).toBeTruthy()
    expect(within(banner).getByText(/^Showing the last known runs · checked \d{2}:\d{2}:\d{2}$/)).toBeTruthy()
    expect(screen.getByTestId('roko-connection').textContent).toBe('unreachable · http://127.0.0.1:6677')
    expect(within(screen.getByRole('list', { name: 'roko runs' })).getByText('add-tests')).toBeTruthy()
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
    expect(within(display).getByTestId('instrument-model').textContent).toContain('learned · p 0.82')
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
    push(socket, { hello: true, hub: 'open', overview: await overviewFrame(), server_time: new Date().toISOString(), type: 'hello', version: '0.4.0' })
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

    expect(within(route).getByText('learned')).toBeTruthy()
    expect(route.querySelector('.rk-route-p')?.textContent).toBe('p 0.82')
    expect(within(route).getByText('highest expected pass rate for a retry of verify[0:test]')).toBeTruthy()

    const rows = within(route).getAllByRole('listitem')

    expect(rows).toHaveLength(3)
    expect(rows[0].getAttribute('data-pick')).toBe('true')
    expect(rows[2].getAttribute('data-eligible')).toBe('false')
    expect(within(rows[2]).getByText('over the per-task cap')).toBeTruthy()
    // The bars are relative to the best score.
    expect((rows[0].querySelector('.rk-cand-bar i') as HTMLElement).style.width).toBe('100%')
    // The sign-off hold shows in the inspector with roko's deadline.
    expect(within(inspector).getByText(/Waits for your sign-off/)).toBeTruthy()

    // T1 kept a lesson.
    fireEvent.click(nodeIn(card, 'T1'))
    const first = await within(card).findByTestId('inspector-T1')

    expect(within(first).getByText('Lexer tests live in tests/lexer.rs and run with cargo test -p lexer')).toBeTruthy()
    expect(within(first).getAllByText('ladder').length).toBeGreaterThan(0)
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

    expect(within(l1).getByText('T2 attempt 2 → glm-5.1 (learned; p 0.82; over gpt-5.4-mini 0.71)')).toBeTruthy()
    expect(within(l1).getByRole('img', { name: '3 events on L1' })).toBeTruthy()
    await waitFor(() => expect(within(l1).getByText('verify[0:test] · 1 retries · 92% pass')).toBeTruthy())
    expect(within(within(loops).getByTestId('ring-L3')).getByText('glm-5.1 · 90% · 9 tasks')).toBeTruthy()
    expect(within(within(loops).getByTestId('ring-L4')).getByText('L-route · healthy · h 0.10 · ε 0.04')).toBeTruthy()

    // A loop frame drops a fresh tick on its ring.
    const socket = await openSocket()

    push(socket, { data: { loop_id: 'L-route', state: 'watch' }, key: 'health:L-route:watch', kind: 'loop_health', plan_id: null, ring: 'L4', run_id: RUN_ACTIVE, task_id: null, text: 'L-route: healthy → watch (eps rose to 0.12)', ts: Date.now(), type: 'loop' })
    await waitFor(() => expect(loops.querySelector('.rk-dial-tick[data-fresh="true"]')).toBeTruthy())
    expect(within(within(loops).getByTestId('ring-L4')).getByText('L-route: healthy → watch (eps rose to 0.12)')).toBeTruthy()

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

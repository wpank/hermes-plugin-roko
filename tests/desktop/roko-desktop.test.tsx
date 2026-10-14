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
import { $gateway } from '@/store/gateway'
import { $notifications } from '@/store/notifications'

import { type ApiRequest, DONE_COMMIT, FakeBackend, HOSTILE_LINE, RUN_ACTIVE, RUN_DONE, RUN_FAILED, RUN_NEW, RUN_PLANGEN, RUN_UNVERIFIED } from './fake-backend'

const HARNESS = process.env.ROKO_HARNESS_DIR!
const SOURCE = process.env.ROKO_PLUGIN_SOURCE!
const HOME = path.join(HARNESS, 'home')
const PLUGIN_FILE = path.join(HOME, 'plugins', 'roko', 'desktop', 'plugin.js')

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
const nativeNotify = vi.fn(async () => true)
const writeClipboard = vi.fn(async () => true)

const bridge = {
  agentPluginsRoot: async () => path.join(HOME, 'plugins'),
  api,
  desktopPluginsRoot: async () => path.join(HOME, 'desktop-plugins'),
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
  fs.mkdirSync(path.join(HOME, 'desktop-plugins'), { recursive: true })
  fs.copyFileSync(SOURCE, PLUGIN_FILE)
  fs.writeFileSync(path.join(HOME, 'plugins', 'roko', 'plugin.yaml'), 'name: roko\n')

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = bridge
  $gateway.set({ request: gatewayRequest } as never)

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

    expect(palette).toEqual(['roko: Open', 'roko: New run…', "roko: What's waiting on me", 'roko: Health check'])
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

    fireEvent.click(within(dialog).getByRole('button', { name: 'Plan it first' }))
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
    expect(card.querySelector('.roko-mini-dot[data-state="running"]')).toBeTruthy()
    expect(within(card).getByText('waiting on you')).toBeTruthy()
    expect(within(card).getByText('1/3 tasks passed', { exact: false })).toBeTruthy()
  })

  it('the status chip carries a live progress ring for the running run', async () => {
    mountContribution('statusBar.right', 'roko:chip')

    const chip = await screen.findByTestId('roko-status-chip')

    await waitFor(() => expect(chip.querySelector('.roko-ring')).toBeTruthy())
    expect(chip.querySelector('.roko-ring')?.getAttribute('aria-label')).toBe('1 of 3 tasks passed, 1 running')
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

describe('unloading', () => {
  it('disabling removes every contribution, the style, the cached queries and the event listener', async () => {
    await setPluginEnabled('roko', false)

    for (const area of ['routes', 'sidebar.nav', 'statusBar.right', 'palette', 'transcript.directives']) {
      expect(registry.getArea(area).some(c => c.source === 'plugin:roko')).toBe(false)
    }

    expect(document.head.querySelector('style[data-hermes-plugin="roko"]')).toBeNull()
    expect(queryClient.getQueryCache().findAll({ queryKey: ['roko'] })).toHaveLength(0)

    api.mockClear()
    act(() => {
      emitGatewayEvent({ payload: { name: 'roko_status', result: { run_id: RUN_DONE } }, session_id: 's1', type: 'tool.complete' })
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(api).not.toHaveBeenCalled()
  })
})

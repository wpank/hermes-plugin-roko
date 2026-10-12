/**
 * vitest for the desktop half: runs desktop/plugin.js through the REAL Hermes
 * desktop runtime loader, contribution registry, SDK and React from the
 * installed Hermes checkout (read-only). Only the Electron bridge
 * (window.hermesDesktop) and the gateway socket are faked, in the tests.
 *
 * Needs tests/desktop/node_modules, built by setup.sh from Hermes' own
 * node_modules. Caches go to tests/desktop/.harness, never into Hermes.
 *
 *   HERMES_AGENT_SRC   the Hermes checkout (default: ~/.hermes/hermes-agent)
 */
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const hermes = path.resolve(
  (process.env.HERMES_AGENT_SRC || path.join(os.homedir(), '.hermes', 'hermes-agent')).replace(/^~(?=$|\/)/, os.homedir())
)
const desktop = path.join(hermes, 'apps', 'desktop')
// Pin React the way apps/desktop/vite.config.ts does: one copy for the app, the SDK and the plugin.
const requireFromApp = createRequire(path.join(desktop, 'vite.config.ts'))
const reactDir = path.dirname(requireFromApp.resolve('react/package.json'))
const reactDomDir = path.dirname(requireFromApp.resolve('react-dom/package.json'))

export default defineConfig({
  root: here,
  cacheDir: path.join(here, '.harness', 'vite-cache'),
  plugins: [react()],
  // The plugin and the Hermes sources live outside `root`.
  server: { fs: { allow: [repo, hermes] } },
  resolve: {
    alias: {
      '@/debug/dev-only': path.join(desktop, 'src', 'debug', 'dev-only.noop.ts'),
      '@': path.join(desktop, 'src'),
      '@hermes/plugin-sdk': path.join(desktop, 'src', 'sdk', 'index.ts'),
      '@hermes/shared/billing': path.join(hermes, 'apps', 'shared', 'src', 'billing-types.ts'),
      '@hermes/shared': path.join(hermes, 'apps', 'shared', 'src'),
      react: reactDir,
      'react-dom': reactDomDir,
      'react/jsx-dev-runtime': path.join(reactDir, 'jsx-dev-runtime.js'),
      'react/jsx-runtime': path.join(reactDir, 'jsx-runtime.js')
    },
    dedupe: ['react', 'react-dom', 'react-router', '@tanstack/react-query']
  },
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['*.test.tsx'],
    setupFiles: [path.join(desktop, 'vitest.setup.ts')],
    testTimeout: 30_000,
    env: {
      ROKO_HARNESS_DIR: path.join(here, '.harness'),
      ROKO_PLUGIN_SOURCE: path.join(repo, 'desktop', 'plugin.js')
    }
  }
})

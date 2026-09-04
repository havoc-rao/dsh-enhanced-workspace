/**
 * Headless-render mount lane: prove the npm-packed plugin mounts into a real
 * `dsh web` instance, shadows `sidebar.workspaces`, and renders without
 * crashing the shell.
 *
 * The server is NOT started here — `scripts/e2e-mount.sh` boots `dsh web`
 * (with the plugin mounted through the official `dsh plugin add` channel) and
 * injects the base URL via `DSH_E2E_URL`. This spec:
 *
 *  1. seeds one workspace (+ a session) through the host's own RPC surface —
 *     the same `workspace.create` / `session.create` calls the UI makes — so
 *     the sidebar has a real workspace to render;
 *  2. loads the page in headless Chromium and asserts the plugin's
 *     `[data-dsh-enhanced-workspace="browser"]` mount is visible with actual
 *     workspace rows in it;
 *  3. asserts no crash markers: no `pageerror`, no plugin-prefixed
 *     `console.error`.
 *
 * Deterministic by construction: every wait is on a DOM marker and any crash
 * trips the very next assertion.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test'

const rawBaseUrl = process.env.DSH_E2E_URL
if (!rawBaseUrl) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)')
}
/** The booted DSH web base URL (guarded non-null above). */
const BASE_URL: string = rawBaseUrl

/** Workspace the sidebar renders against (created by the lane's seeding). */
const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-workspace')

/** The plugin's shadow-mount marker (src/client/Browser.tsx region root). */
const BROWSER_SELECTOR = '[data-dsh-enhanced-workspace="browser"]'

let api: APIRequestContext

/** Seed one workspace + one session through the host's unary RPC surface. */
async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  const workspace = await api.post(`${BASE_URL}/api/workspace.create`, {
    data: { type: 'client-request', rpcId: 'e2e-mount-workspace', method: 'workspace.create', payload: { path: WORKSPACE_PATH } },
  })
  expect(workspace.ok(), `workspace.create: ${workspace.status()} ${await workspace.text()}`).toBe(true)
  const workspaceBody = (await workspace.json()) as {
    result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown }
  }
  expect(workspaceBody.result.ok).toBe(true)
  const workspaceId = (workspaceBody.result as { value: { workspace: { workspaceId: string } } }).value.workspace.workspaceId

  // A session is optional for the mount probe; a failure must not mask the
  // core assertion (the workspace row renders on its own).
  const session = await api.post(`${BASE_URL}/api/session.create`, {
    data: { type: 'client-request', rpcId: 'e2e-mount-session', method: 'session.create', payload: { workspaceId } },
  })
  if (!session.ok()) {
    console.warn(`[e2e-mount] session.create skipped: ${session.status()} ${await session.text()}`)
  }
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  await seedSession()
})

test.afterAll(async () => {
  await api?.dispose()
})

test('the enhanced workspace region shadows the sidebar and renders rows without crashing', async ({ page }) => {
  const pageErrors: Error[] = []
  const pluginConsoleErrors: string[] = []
  page.on('pageerror', error => { pageErrors.push(error) })
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('dsh-enhanced-workspace')) {
      pluginConsoleErrors.push(message.text())
    }
  })

  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' })

  // The plugin's shadow mount is visible and occupies the sidebar region.
  const region = page.locator(BROWSER_SELECTOR)
  await expect(region).toBeVisible({ timeout: 60_000 })

  // It renders actual workspace rows (the seeded workspace appears as a row
  // with its basename as the title — same derivation the built-in uses).
  const rows = region.locator('[role="treeitem"]')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  await expect(region).toContainText(join(WORKSPACE_PATH).split(/[\\/]/).pop() ?? 'e2e-mount')

  // The recency module renders above the workspace list (its section title).
  await expect(region.locator('section')).toHaveCount(1)

  // No crash markers anywhere on the page.
  expect(pageErrors, `pageerrors: ${pageErrors.map(error => error.message).join(' | ')}`).toEqual([])
  expect(pluginConsoleErrors, `plugin console errors: ${pluginConsoleErrors.join(' | ')}`).toEqual([])
})
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
/** Launch-token authenticated URL: GETting it at `/` mints the session cookie
 *  the `/api/*` channels demand (browser-auth process-token exchange). */
const AUTH_URL = process.env.DSH_E2E_AUTH_URL
if (!AUTH_URL) {
  throw new Error('DSH_E2E_AUTH_URL is not set — boot a DSH web instance with the plugin mounted and point this lane at it (see scripts/e2e-mount.sh)')
}

/** Workspace the sidebar renders against (created by the lane's seeding). */
const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-workspace')

/** The plugin's shadow-mount marker (src/client/Browser.tsx region root). */
const BROWSER_SELECTOR = '[data-dsh-enhanced-workspace="browser"]'

let api: APIRequestContext

/**
 * Seed one workspace + one session through the host's unary RPC surface —
 * the current Host wire: `POST /api/<namespace>/<method>` with the
 * `client-request` envelope and the typert `{ args: { request: … } }`
 * payload, so the sidebar has a real workspace to render.
 */
async function seedSession(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  const workspace = await api.post(`${BASE_URL}/api/workspace/create`, {
    data: { type: 'client-request', rpcId: 'e2e-mount-workspace', method: 'workspace/create', payload: { args: { request: { path: WORKSPACE_PATH } } } },
  })
  expect(workspace.ok(), `workspace.create: ${workspace.status()} ${await workspace.text()}`).toBe(true)
  const workspaceBody = (await workspace.json()) as {
    result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown }
  }
  expect(workspaceBody.result.ok).toBe(true)
  const workspaceId = (workspaceBody.result as { value: { workspace: { workspaceId: string } } }).value.workspace.workspaceId

  // A session is optional for the mount probe; a failure must not mask the
  // core assertion (the workspace row renders on its own).
  const session = await api.post(`${BASE_URL}/api/session/create`, {
    data: { type: 'client-request', rpcId: 'e2e-mount-session', method: 'session/create', payload: { args: { request: { workspaceId } } } },
  })
  if (!session.ok()) {
    console.warn(`[e2e-mount] session.create skipped: ${session.status()} ${await session.text()}`)
  }
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  // browser-auth: the launch-token GET mints the authority-bound session
  // cookie that every following /api/* call must carry.
  await api.get(AUTH_URL)
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
    // 只收集插件专属错误（写法同上游组合 lane）：harness dev 构建的
    // hydration 警告组件栈含 combo bundle URL（…/dsh-enhanced-workspace/
    // client.js 等），不能据此误报——带冒号后缀的插件文案（本插件
    // warn/error 前缀形式）与 [dsh-enhanced-workspace] 括号前缀才是插件的。
    if (message.type() === 'error'
      && (message.text().includes('dsh-enhanced-workspace:')
        || message.text().includes('[dsh-enhanced-workspace]'))) {
      pluginConsoleErrors.push(message.text())
    }
  })

  // The authenticated URL (token query) — a plain origin load would answer
  // 401 until the browser-auth exchange ran.
  await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded' })

  // A brand-new scratch DSH_HOME mounts the web app's first-run onboarding
  // takeover, which holds `#root` inert and blocks pointer/keyboard input
  // app-wide. The lane only probes the plugin region, so it strips the
  // overlay and the inert flag after the mount assertions below.
  const stripOnboarding = (): Promise<void> => page.evaluate(() => {
    document.querySelector<HTMLElement>('[class*="onboardingOverlay"]')?.remove()
    // The first-run welcome may also ride a shared Modal (full-viewport mask
    // + dialog, role="presentation"): remove the whole modal layer too, or
    // its mask keeps intercepting pointer events for every later hover.
    const mask = document.querySelector<HTMLElement>('[class*="_mask_"]')
    mask?.parentElement?.remove()
    const appRoot = document.getElementById('root')
    if (appRoot !== null) appRoot.inert = false
  })

  // The plugin's shadow mount is visible and occupies the sidebar region.
  const region = page.locator(BROWSER_SELECTOR)
  await expect(region).toBeVisible({ timeout: 60_000 })

  // It renders actual workspace rows (the seeded workspace appears as a row
  // with its basename as the title — same derivation the built-in uses).
  const rows = region.locator('[role="treeitem"]')
  await expect(rows.first()).toBeVisible({ timeout: 30_000 })
  await expect(region).toContainText(join(WORKSPACE_PATH).split(/[\\/]/).pop() ?? 'e2e-mount')

  // Release the first-run takeover before any interaction with the region.
  await stripOnboarding()

  // The recency module renders above the workspace list. A workspace seeded
  // before first paint counts as recent by definition (its creation stamp
  // scores it), so the region shows BOTH sections: recents + all.
  await expect(region.locator('section')).toHaveCount(2)

  // The search input filters the ORIGINAL dirs list in place: a match keeps
  // the dir row and hides the recency module, a no-match query empties the
  // tree with a hint line, and clearing the query restores everything.
  const searchInput = region.locator('input[type="search"]')
  await expect(searchInput).toBeVisible()
  const basename = join(WORKSPACE_PATH).split(/[\\/]/).pop() ?? 'e2e-mount'
  await searchInput.fill(basename)
  await expect(region.locator('section')).toHaveCount(1, { timeout: 15_000 }) // recents hidden
  await expect(region.locator('[role="treeitem"]').filter({ hasText: basename })).toBeVisible({ timeout: 15_000 })
  await searchInput.fill('zzz-no-such-session')
  await expect(region.locator('[role="treeitem"]')).toHaveCount(0, { timeout: 15_000 })
  await expect(region.locator('[class*="searchStatus"]').first()).toBeVisible({ timeout: 15_000 })
  await searchInput.fill('')
  await expect(region.locator('section')).toHaveCount(2, { timeout: 15_000 }) // recents back

  // The workspace hover card (built-in ui-workspace parity): dwelling on a
  // real workspace row opens the portaled right-side card with the full
  // directory path (and the creation time), and the card is a copy target.
  const workspaceRow = region.locator('[role="treeitem"]').filter({ hasText: basename }).first()
  await workspaceRow.hover()
  const hoverCard = page.locator('[class*="hoverContent"]').last()
  await expect(hoverCard).toBeVisible({ timeout: 15_000 })
  // The full directory path is locale-independent (the created-time line is
  // dictionary copy and differs by the scratch home's locale).
  await expect(hoverCard).toContainText(WORKSPACE_PATH)

  // The shell's own collapse fold: the toggle is the logo row's last button
  // (brand first when wide, toggle last in both states). Collapsing must NOT
  // squeeze the wide chrome — the region folds to the rail: wide chrome
  // unmounts and only the two rail controls stay.
  const shellToggle = page.locator('div[class*="logoRow"] button').last()
  await shellToggle.click()
  await expect(region.locator('input[type="search"]')).toHaveCount(0, { timeout: 15_000 })
  await expect(region.locator('section')).toHaveCount(0)
  await expect(region.locator('[role="treeitem"]')).toHaveCount(0)
  const railButtons = region.locator('button[class*="railButton"]')
  await expect(railButtons).toHaveCount(2, { timeout: 15_000 })

  // Rail search = expand + land in the input (built-in gesture): the shell
  // flips wide, the input mounts and takes focus after the slide.
  await railButtons.last().click()
  await expect(region.locator('input[type="search"]')).toBeVisible({ timeout: 15_000 })
  await expect(region.locator('input[type="search"]')).toBeFocused({ timeout: 15_000 })
  await expect(region.locator('section')).toHaveCount(2, { timeout: 15_000 }) // recents back

  // Fold again from the shell toggle, then expand from the rail, to prove
  // the fold is repeatable and stays in sync with the shell either way.
  await shellToggle.click()
  await expect(region.locator('input[type="search"]')).toHaveCount(0, { timeout: 15_000 })
  await expect(region.locator('button[class*="railButton"]')).toHaveCount(2)
  await shellToggle.click()
  await expect(region.locator('input[type="search"]')).toBeVisible({ timeout: 15_000 })
  await expect(region.locator('section')).toHaveCount(2, { timeout: 15_000 })

  // No crash markers anywhere on the page.
  expect(pageErrors, `pageerrors: ${pageErrors.map(error => error.message).join(' | ')}`).toEqual([])
  expect(pluginConsoleErrors, `plugin console errors: ${pluginConsoleErrors.join(' | ')}`).toEqual([])
})
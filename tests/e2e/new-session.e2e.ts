/**
 * New-session regression lane: prove the workspace row's plus button starts a
 * frontend session in a real `dsh web` (row plus → uiWorkspace.startSession →
 * host session.create → the blank session row appears under the workspace).
 *
 * Regression context: the plus button was reported dead ("点击无效"). The
 * lane seeds an EMPTY workspace and clicks its plus, then asserts the click
 * lands without a pageerror and the workspace's session list shows a blank
 * (新会话 / New Session) row — before the fix the click handler threw
 * `cannot get property "uiWorkspace" without inject` and nothing happened.
 *
 * The server is NOT started here — `scripts/e2e-mount.sh` boots `dsh web`
 * (with the npm-packed plugin mounted through the official `dsh plugin add`
 * channel) and injects the base URL via `DSH_E2E_URL`.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test'

const rawBaseUrl = process.env.DSH_E2E_URL
if (!rawBaseUrl) {
  throw new Error('DSH_E2E_URL is not set — boot a DSH web instance with the plugin mounted (see scripts/e2e-mount.sh)')
}
/** The booted DSH web base URL (guarded non-null above). */
const BASE_URL: string = rawBaseUrl
/** Launch-token authenticated URL: GETting it at `/` mints the session cookie
 *  the `/api/*` channels demand (browser-auth process-token exchange). */
const AUTH_URL = process.env.DSH_E2E_AUTH_URL
if (!AUTH_URL) {
  throw new Error('DSH_E2E_AUTH_URL is not set — boot a DSH web instance with the plugin mounted (see scripts/e2e-mount.sh)')
}

/** The seeded empty directory (no session ever created in it). */
const WORKSPACE_PATH = process.env.DSH_E2E_NEW_SESSION_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-new-session')

/** The plugin's shadow-mount marker (src/client/Browser.tsx region root). */
const BROWSER_SELECTOR = '[data-dsh-enhanced-workspace="browser"]'

/** Blank-session row copy (locale-agnostic match over the zh/en dictionaries). */
const BLANK_SESSION_RE = /新会话|New Session/i

let api: APIRequestContext

/** Seed one EMPTY workspace through the host's unary RPC surface (no session). */
async function seedEmptyWorkspace(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  const response = await api.post(`${BASE_URL}/api/workspace/create`, {
    data: { type: 'client-request', rpcId: 'e2e-new-session-seed', method: 'workspace/create', payload: { args: { request: { path: WORKSPACE_PATH } } } },
  })
  expect(response.ok(), `workspace.create: ${response.status()} ${await response.text()}`).toBe(true)
  const body = (await response.json()) as {
    result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown }
  }
  expect(body.result.ok).toBe(true)
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  // browser-auth: the launch-token GET mints the authority-bound session
  // cookie that every following /api/* call must carry.
  await api.get(AUTH_URL)
  await seedEmptyWorkspace()
})

test.afterAll(async () => {
  await api?.dispose()
})

/** Strip the first-run onboarding takeover that holds `#root` inert. */
async function stripOnboarding(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[class*="onboardingOverlay"]')?.remove()
    const mask = document.querySelector<HTMLElement>('[class*="_mask_"]')
    mask?.parentElement?.remove()
    const appRoot = document.getElementById('root')
    if (appRoot !== null) appRoot.inert = false
  })
}

test('the workspace row plus button starts a new session (empty workspace)', async ({ page }) => {
  const pageErrors: Error[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', error => { pageErrors.push(error) })
  page.on('console', message => {
    const text = message.text()
    if (
      message.type() === 'error' && text.includes('dsh-enhanced-workspace')
      // uiWorkspace.startSession's own non-fatal failure warning — the exact
      // symptom of a dead new-session flow.
      || text.includes('new session failed')
    ) {
      consoleErrors.push(text)
    }
  })

  // The authenticated URL (token query) — a plain origin load would answer
  // 401 until the browser-auth exchange ran.
  await page.goto(AUTH_URL, { waitUntil: 'domcontentloaded' })

  // The plugin's shadow mount is visible and renders the seeded row.
  const region = page.locator(BROWSER_SELECTOR)
  await expect(region).toBeVisible({ timeout: 60_000 })
  await stripOnboarding(page)

  // Narrow to exactly one row via the search filter (locale-free, and the
  // recency module folds away while searching) — same posture as the
  // delete-workspace lane.
  const basename = join(WORKSPACE_PATH).split(/[\\/]/).pop() ?? 'new-session-e2e-workspace'
  const searchInput = region.locator('input[type="search"]')
  await expect(searchInput).toBeVisible({ timeout: 30_000 })
  await searchInput.fill(basename)
  const row = region.locator('[role="treeitem"]').filter({ hasText: basename }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })

  // Click the row's New Session plus — the SECOND button of the hover-actions
  // span (the first is the ellipsis row menu). NOTE: ui-workspace's initial
  // navigation may auto-connect this brand-new workspace (newest creation
  // stamp) and land its blank session before the click — the lane therefore
  // asserts no pre-click state, only the click's contract below.
  await row.getByRole('button').last().click()

  // THE regression assertions: the click must land without dying — before
  // the fix the handler threw `cannot get property "uiWorkspace" without
  // inject` (a pageerror) and the click was dead. After the click the row
  // holds its expanded session list with a blank (新会话 / New Session) row
  // — whether the click created it or rode the auto-connect blank-reuse path.
  await expect(row).toHaveAttribute('aria-expanded', 'true', { timeout: 15_000 })
  const blankRow = region.locator('[role="treeitem"]').filter({ hasText: BLANK_SESSION_RE }).first()
  await expect(blankRow).toBeVisible({ timeout: 15_000 })

  // No crash markers anywhere on the page.
  expect(pageErrors, `pageerrors: ${pageErrors.map(error => error.message).join(' | ')}`).toEqual([])
  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([])
})
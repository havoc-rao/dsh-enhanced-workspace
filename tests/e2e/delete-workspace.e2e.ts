/**
 * Delete-workspace regression lane: prove the row menu's 删除工作区 flow works
 * end to end in a real `dsh web` (row menu → confirm dialog → host RPC →
 * row removal). The lane seeds an EMPTY workspace — no sessions — the exact
 * shape reported broken ("确认按钮点了没反应, 对话框卡住"), and drives the
 * real UI with locale-free selectors (menu items by role order, the confirm
 * button by its danger class).
 *
 * Regression context: the confirm closure lived on the dialog seat object
 * built at menu-click time, so its `deleteWorkspaceTarget` guard saw the
 * pre-dialog null forever and silently swallowed every confirm. A live
 * dialog + a dead button was the exact symptom; this lane pins the fix.
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
const WORKSPACE_PATH = process.env.DSH_E2E_WORKSPACE ?? join(tmpdir(), 'dsh-e2e-delete-workspace')

/** The plugin's shadow-mount marker (src/client/Browser.tsx region root). */
const BROWSER_SELECTOR = '[data-dsh-enhanced-workspace="browser"]'

let api: APIRequestContext
let workspaceId = ''

/** Seed one EMPTY workspace through the host's unary RPC surface (no session). */
async function seedEmptyWorkspace(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  const response = await api.post(`${BASE_URL}/api/workspace/create`, {
    data: { type: 'client-request', rpcId: 'e2e-delete-seed', method: 'workspace/create', payload: { args: { request: { path: WORKSPACE_PATH } } } },
  })
  expect(response.ok(), `workspace.create: ${response.status()} ${await response.text()}`).toBe(true)
  const body = (await response.json()) as {
    result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown }
  }
  expect(body.result.ok).toBe(true)
  workspaceId = (body.result as { value: { workspace: { workspaceId: string } } }).value.workspace.workspaceId
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  // browser-auth: the launch-token GET mints the authority-bound session
  // cookie that every following /api/* call must carry.
  await api.get(AUTH_URL)
  await seedEmptyWorkspace()
})

test.afterAll(async () => {
  // Cleanup guard so the serial mount lane never sees a leftover row. The UI
  // lane must already have deleted it (its own assertion fails otherwise);
  // host delete on an unknown id is an idempotent no-op, so this cannot
  // paper over a failed UI delete.
  if (workspaceId !== '') {
    await api.post(`${BASE_URL}/api/workspace/delete`, {
      data: { type: 'client-request', rpcId: 'e2e-delete-cleanup', method: 'workspace/delete', payload: { args: { request: { workspaceId } } } },
    }).catch(() => { /* best-effort */ })
  }
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

test('row menu 删除工作区 removes the empty workspace row and closes the dialog', async ({ page }) => {
  const pageErrors: Error[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', error => { pageErrors.push(error) })
  page.on('console', message => {
    if (message.type() === 'error' && message.text().includes('dsh-enhanced-workspace')) {
      consoleErrors.push(message.text())
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
  // recency module folds away while searching).
  const basename = join(WORKSPACE_PATH).split(/[\\/]/).pop() ?? 'delete-e2e-workspace'
  const searchInput = region.locator('input[type="search"]')
  await expect(searchInput).toBeVisible({ timeout: 30_000 })
  await searchInput.fill(basename)
  const row = region.locator('[role="treeitem"]').filter({ hasText: basename }).first()
  await expect(row).toBeVisible({ timeout: 15_000 })

  // Open the row's 更多 menu: the first button in the hover-actions span
  // (ellipsis anchor; the second is the per-row New Session plus).
  await row.getByRole('button').first().click()

  // 删除工作区 is the LAST menuitem (rename, move, separator, delete) —
  // locale-free and stable while the menu copy may differ per locale.
  const deleteItem = page.getByRole('menuitem').last()
  await expect(deleteItem).toBeVisible({ timeout: 10_000 })
  await deleteItem.click()

  // The browser's confirm dialog mounts portaled; its destructive action is
  // the footer's danger-styled button (locale-free).
  const dialog = page.locator('[role="dialog"]').last()
  await expect(dialog).toBeVisible({ timeout: 10_000 })
  const confirmButton = dialog.locator('button[class*="dangerAction"]')
  await expect(confirmButton).toBeVisible()
  await confirmButton.click()

  // THE regression assertions: the row disappears and the dialog closes —
  // before the fix the confirm was silently swallowed (no busy, no RPC, no
  // error) and this waited forever.
  await expect(
    region.locator('[role="treeitem"]').filter({ hasText: basename }),
  ).toHaveCount(0, { timeout: 20_000 })
  await expect(dialog).toHaveCount(0, { timeout: 10_000 })

  // The host registration is really gone (not just hidden by the tree): the
  // controller's rename on the deleted id must fail. (The old unary
  // `workspace.list` endpoint no longer exists on the Host wire — the list
  // surface is the `workspace.follow` stream — so a failing mutation is the
  // locale-free proof of absence.)
  const rename = await api.post(`${BASE_URL}/api/workspace/rename`, {
    data: { type: 'client-request', rpcId: 'e2e-delete-rename', method: 'workspace/rename', payload: { args: { request: { workspaceId, title: 'should-not-exist' } } } },
  })
  expect(rename.ok()).toBe(true)
  const renameBody = (await rename.json()) as {
    result: { ok: true; value: unknown } | { ok: false; error: unknown }
  }
  expect(renameBody.result.ok).toBe(false)

  // No crash markers anywhere on the page (plugin-prefixed console failures).
  expect(pageErrors, `pageerrors: ${pageErrors.map(error => error.message).join(' | ')}`).toEqual([])
  expect(consoleErrors, `plugin console errors: ${consoleErrors.join(' | ')}`).toEqual([])
})
/**
 * Hover-card alignment lane: the compact card bed must sit top-aligned with
 * the anchored row and 8px right of the row's right edge (built-in
 * ui-workspace parity) — the `HoverCard` primitive derives the position
 * from the ANCHOR element, and `HoverRowAnchorSync` re-anchors fileTreeUi
 * rows to the full row box (the framework's `rowLabel` fragment would
 * otherwise mis-place the card). Runs in the consumer-only mount lane
 * (local fallback rows, anchor = the row) and in the provider+consumer
 * compose shape (fileTreeUi v2 label slots); seeds its own workspace in a
 * disjoint basename so other lanes' `hasText` filters stay unambiguous.
 */
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test'

const BASE_URL = process.env.DSH_E2E_URL
if (!BASE_URL) throw new Error('DSH_E2E_URL is not set')
const AUTH_URL = process.env.DSH_E2E_AUTH_URL

const WORKSPACE_PATH = join(tmpdir(), 'dsh-geom-anchor-box')
const REGION_SELECTOR = '[data-dsh-enhanced-workspace="browser"]'

let api: APIRequestContext

async function seed(): Promise<void> {
  mkdirSync(WORKSPACE_PATH, { recursive: true })
  const workspace = await api.post(`${BASE_URL}/api/workspace/create`, {
    data: { type: 'client-request', rpcId: 'geom-workspace', method: 'workspace/create', payload: { args: { request: { path: WORKSPACE_PATH } } } },
  })
  const body = (await workspace.json()) as { result: { ok: true; value: { workspace: { workspaceId: string } } } | { ok: false; error: unknown } }
  if (!body.result.ok) throw new Error(`workspace.create failed: ${JSON.stringify(body.result)}`)
  const workspaceId = (body.result as { value: { workspace: { workspaceId: string } } }).value.workspace.workspaceId
  const session = await api.post(`${BASE_URL}/api/session/create`, {
    data: { type: 'client-request', rpcId: 'geom-session', method: 'session/create', payload: { args: { request: { workspaceId } } } },
  })
  if (!session.ok()) console.warn(`[geom] session.create skipped: ${session.status()} ${await session.text()}`)
}

test.beforeAll(async () => {
  api = await request.newContext({ baseURL: BASE_URL })
  if (AUTH_URL !== undefined) await api.get(AUTH_URL)
  await seed()
})

test.afterAll(async () => {
  await api?.dispose()
})

async function stripOnboarding(page: Page): Promise<void> {
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('[class*="onboardingOverlay"]')?.remove()
    const mask = document.querySelector<HTMLElement>('[class*="_mask_"]')
    mask?.parentElement?.remove()
    const appRoot = document.getElementById('root')
    if (appRoot !== null) appRoot.inert = false
  })
}

/** Log the card-vs-anchor geometry for one hover target. */
async function measureHover(page: Page, label: string, target: ReturnType<Page['locator']>, outDir: string, cardText: string): Promise<void> {
  await target.hover()
  // Discriminate by card body text: the workspace card lingers in its
  // dismissal window while the new card dwells open.
  const hoverContent = page.locator(`[class*="hoverContent"]`, { hasText: cardText }).last()
  await expect(hoverContent).toBeVisible({ timeout: 15_000 })
  const rowBox = await target.boundingBox()
  const probe = await hoverContent.evaluate(el => {
    const chain: unknown[] = []
    let node: HTMLElement | null = el as HTMLElement
    // Climb from the hover body up to the row level; the card is portaled,
    // so the chain ends at body — the ANCHOR lives in the tree instead, and
    // it is whatever element whose rect the card math used:
    //   card.left = anchor.right + 8, card.top = anchor.top (compact).
    const card = (el.parentElement?.parentElement ?? null) as HTMLElement | null
    let anchor: { tag: string; cls: string; rect: Record<string, number> } | null = null
    if (card !== null) {
      const wantedRight = card.getBoundingClientRect().left - 8
      const wantedTop = card.getBoundingClientRect().top
      // The anchor is the shallowest element whose rect matches the card
      // derivation, skipping the card and its siblings (portaled).
      for (const cand of document.querySelectorAll<HTMLElement>('div, span')) {
        if (card.contains(cand)) continue
        const r = cand.getBoundingClientRect()
        if (Math.abs(r.right - wantedRight) <= 1 && Math.abs(r.top - wantedTop) <= 1) {
          anchor = { tag: cand.tagName, cls: cand.className ?? '', rect: r.toJSON() }
          break
        }
      }
    }
    for (let depth = 0; node !== null && depth < 6; depth += 1) {
      const r = node.getBoundingClientRect()
      chain.push({
        depth, tag: node.tagName, cls: String(node.className ?? ''), attr: [...node.attributes].map(a => a.name).slice(0, 8),
        rect: r.toJSON(),
      })
      node = node.parentElement
    }
    // Full horizontal context: the region's box, its ancestors up to the
    // shell's sidebar column, and the card's computed padding — so the
    // "too far" gap can be attributed precisely (card vs row, row vs
    // sidebar edge, or the card's own content inset).
    const region = document.querySelector<HTMLElement>('[data-dsh-enhanced-workspace="browser"]')
    const context = region === null ? null : {
      region: region.getBoundingClientRect().toJSON(),
      regionPad: getComputedStyle(region).padding,
      regionRight: getComputedStyle(region).paddingRight,
      cardPad: card === null ? null : getComputedStyle(card).padding,
      cardPadLeft: card === null ? null : getComputedStyle(card).paddingLeft,
      content: card === null ? null : (el.getBoundingClientRect().left - card.getBoundingClientRect().left),
      shell: (() => { const s = region.parentElement; return s === null ? null : s.getBoundingClientRect().toJSON() })(),
    }
    return { chain, card: card === null ? null : card.getBoundingClientRect().toJSON(), anchor, context }
  })
  console.log(`[geom-hovercard] ${label} rowBox=${JSON.stringify(rowBox)}`)
  console.log(`[geom-hovercard] ${label} chain=${JSON.stringify(probe.chain, null, 1)}`)
  console.log(`[geom-hovercard] ${label} card=${JSON.stringify(probe.card)}`)
  console.log(`[geom-hovercard] ${label} anchor=${JSON.stringify(probe.anchor)}`)
  console.log(`[geom-hovercard] ${label} context=${JSON.stringify(probe.context)}`)
  await page.screenshot({ path: join(outDir, `${label}.png`) })
  // The alignment contract (built-in ui-workspace parity): the compact card
  // bed sits top-aligned with the row and 8px right of the row's right edge.
  // The primitive derives it from the ANCHOR (bed.left = anchor.right + 8,
  // bed.top = anchor.top) — with HoverRowAnchorSync the anchor IS the row.
  if (probe.card !== null && rowBox !== null) {
    expect(Math.abs(probe.card.top - rowBox.y), `${label}: card top vs row top`).toBeLessThanOrEqual(1)
    expect(Math.abs(probe.card.left - (rowBox.x + rowBox.width + 8)), `${label}: card left vs row right + 8`).toBeLessThanOrEqual(1)
  }
}

test('hover card geometry vs anchor row', async ({ page }) => {
  const outDir = join('test-results', 'hover-geometry')
  mkdirSync(outDir, { recursive: true })
  const pageErrors: string[] = []
  page.on('pageerror', error => { pageErrors.push(String(error)) })

  const authUrl = AUTH_URL ?? BASE_URL
  await page.goto(authUrl, { waitUntil: 'domcontentloaded' })

  // Detect which row path is live: provider present → fileTreeUi v2 models.
  const provider = await page.locator('style[data-plugin="dsh-file-tree-ui"]').count()
  console.log(`[geom-hovercard] provider stylesheets: ${provider} → ${provider > 0 ? 'fileTreeUi v2 path' : 'local fallback path'}`)

  const region = page.locator(REGION_SELECTOR)
  await expect(region).toBeVisible({ timeout: 120_000 })
  await stripOnboarding(page)

  const basename = join(WORKSPACE_PATH).split(/[\\/]/).pop() ?? 'dsh-geom-anchor-box'
  const workspaceRow = region.locator('[role="treeitem"]').filter({ hasText: basename }).last()
  await expect(workspaceRow).toBeVisible({ timeout: 30_000 })

  // Workspace card.
  await measureHover(page, 'workspace-card', workspaceRow, outDir, basename)

  // Session card (expand the workspace row first if needed).
  if ((await workspaceRow.getAttribute('aria-expanded')) !== 'true') {
    await workspaceRow.click()
  }
  const sessionRow = region.locator('[role="treeitem"]').filter({ hasNotText: basename }).first()
  await expect(sessionRow).toBeVisible({ timeout: 30_000 })
  await measureHover(page, 'session-card', sessionRow, outDir, 'New Session')

  console.log(`[geom-hovercard] pageerrors: ${JSON.stringify(pageErrors)}`)
  expect(pageErrors).toEqual([])
})
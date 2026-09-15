// @vitest-environment jsdom
/**
 * Component spec of the P2 fileTreeUi v1 consumer integration (provider:
 * dsh-file-tree-ui). With the service present, session rows render through
 * the provider's REAL TreeRow / RowMenu / TreeGuideLayer components; without
 * it (missing / mismatched / unloaded) the built-in fallback rows render.
 *
 * The service fixture is built from the upstream source components — vitest
 * is outside the client-bundle purity gate, so value-importing
 * `dsh-file-tree-ui/src/client/*.tsx` is legal here (tsdown never sees it).
 * Assertions are semantic (roles / aria / text / SVG / inline styles): no
 * reliance on CSS-module hashed class names beyond contains-matching.
 */
import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { TreeRow } from 'dsh-file-tree-ui/src/client/TreeRow.tsx'
import { TreeGuideLayer } from 'dsh-file-tree-ui/src/client/TreeGuideLayer.tsx'
import { RowMenu } from 'dsh-file-tree-ui/src/client/RowMenu.tsx'
import type { FileTreeUiServiceV1 } from 'dsh-file-tree-ui/client-contract'
import { EnhancedWorkspaceBrowser, GUIDE_STROKE_HOVER } from '../src/client/Browser.tsx'
import { DIRECTORY_FLOW_SLOT, SEARCH_SLOT, type EnhancedWorkspaceBrowserProps } from '../src/client/contract.ts'
import { createFileTreeUiResolver } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'
import { ROOT_FOLDER_ID } from '../src/client/model.ts'
import { createEnhancedWorkspaceStore, type EnhancedWorkspaceState } from '../src/client/store.ts'

const W = (id: string): WorkspaceId => id as WorkspaceId

/** Fixed "now" for deterministic relative-time labels. */
const NOW = Date.now()

/** One fixture session row (all ordinary user-origin, non-blank). */
function session(id: string, title: string, ageMs: number, blank = false): SessionSummary {
  return {
    id: id as SessionId,
    displayTitle: title,
    blank,
    running: false,
    completed: true,
    updatedAt: NOW - ageMs,
  }
}

/** One fixture workspace view. */
function workspace(id: string, title: string, sessionIds: string[]): WorkspaceView {
  return {
    workspaceId: id as WorkspaceId,
    path: `/projects/${id}`,
    title,
    sessionIds: sessionIds as SessionId[],
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
  }
}

const WORKSPACES = [
  workspace('w-art', '绘画收集', ['s1', 's2']),
  workspace('w-docs', '文档', ['s7']),
]
const SESSIONS_BY_ID: Record<string, SessionSummary> = {
  s1: session('s1', '画布草图', 1000),
  s2: session('s2', '配色研究', 2000),
  s7: session('s7', 'README 整理', 7000),
}
const SESSIONS_STATE = {
  ids: ['s1', 's2', 's7'],
  byId: SESSIONS_BY_ID,
  current: undefined as SessionId | undefined,
  phase: 'ready',
  subagentsByParent: {},
}
const WORKSPACES_STATE = {
  items: WORKSPACES,
  archivedSessionIds: [],
  state: 'ready',
  phase: 'ready',
  baselinesReady: true,
}

/** Mutable fixture seats: re-bound before each test and read by the
 *  `useWorkspaces` / `useSessions` / `useFileTreeUi` closures. */
let workspacesState: typeof WORKSPACES_STATE = WORKSPACES_STATE
let sessionsState: typeof SESSIONS_STATE = SESSIONS_STATE

/**
 * The fileTreeUi v1 service seat: undefined by default (missing provider →
 * built-in session rows); a test binds a REAL provider-shaped service here
 * and re-renders — the same way the `internal/service` subscription flips
 * the snapshot at runtime.
 */
let fileTreeUiSeat: FileTreeUiServiceV1 | undefined = undefined

/** The provider-shaped service fixture: the REAL upstream components. */
function makeFileTreeUiService(): FileTreeUiServiceV1 {
  return {
    protocolVersion: 1,
    renderRow: props => <TreeRow {...props} />,
    renderGuideLayer: props => <TreeGuideLayer {...props} />,
    renderRowMenu: props => <RowMenu {...props} />,
  }
}

/** Minimal locale seat over the zh dictionary. */
const t = ((key: string, params?: Record<string, string | number>): string => {
  const template = zh[key as keyof typeof zh]
  if (template === undefined) return key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      params[name] === undefined ? whole : String(params[name]))
}) as unknown as EnhancedWorkspaceBrowserProps['t']

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let instance: ReturnType<ReturnType<typeof createEnhancedWorkspaceStore>['create']>
let latestProps: EnhancedWorkspaceBrowserProps

/** Render the browser over a fresh real store engine instance. */
async function renderBrowser(): Promise<EnhancedWorkspaceBrowserProps> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  instance = createEnhancedWorkspaceStore().create()
  latestProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useWorkspaces: (selector: (snapshot: typeof WORKSPACES_STATE) => unknown) => selector(workspacesState),
    useSessions: (selector: (snapshot: typeof SESSIONS_STATE) => unknown) => selector(sessionsState),
    useSessionPendingInteraction: (selector: (snapshot: ReadonlyMap<string, unknown>) => unknown) => selector(new Map()),
    useStore: (selector: (snapshot: EnhancedWorkspaceState) => unknown) =>
      useSyncExternalStore(instance.store.subscribe, () => selector(instance.store.getSnapshot())),
    actions: instance.actions,
    t,
    useDirectoryFlow: (selector: (occupied: boolean) => unknown) => selector(false),
    useFileTreeUi: (selector: (value: FileTreeUiServiceV1 | undefined) => unknown) => selector(fileTreeUiSeat),
    renderSlot: ((_key: string) => {
      expect([DIRECTORY_FLOW_SLOT, SEARCH_SLOT]).toContain(_key)
      return null
    }) as unknown as EnhancedWorkspaceBrowserProps['renderSlot'],
    startSession: vi.fn(),
    open: vi.fn(),
    renameSession: vi.fn(async () => undefined),
    forkSession: vi.fn(),
    archiveSession: vi.fn(async () => undefined),
    renameWorkspace: vi.fn(async () => undefined),
    deleteWorkspace: vi.fn(async () => undefined),
    insertWorkspaceBefore: vi.fn(async () => undefined),
    createWorkspace: vi.fn(async () => { throw new Error('unused in this spec') }),
    pickDirectory: vi.fn(async () => null),
    probeGit: vi.fn(async () => null),
    remoteGit: {
      fetchMarkers: vi.fn(async () => new Map()),
      refresh: vi.fn(async () => new Map()),
    },
    continueInWorkspace: vi.fn(async () => undefined),
    persistence: { load: vi.fn(async () => null), save: vi.fn(async () => undefined) },
  } as unknown as EnhancedWorkspaceBrowserProps
  await act(async () => {
    root.render(<EnhancedWorkspaceBrowser {...latestProps} />)
  })
  return latestProps
}

/** Re-render the mounted browser (flips the fileTreeUi seat snapshot). */
async function rerender(): Promise<void> {
  await act(async () => {
    root.render(<EnhancedWorkspaceBrowser {...latestProps} />)
  })
}

/** One treeitem row whose text contains `text`, or undefined. */
function rowByText(text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .find(row => row.textContent?.includes(text))
}

/** One workspace/folder row OUTSIDE the recency section (the folder tree). */
function treeRowByText(text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .find(row => row.textContent?.includes(text)
      && row.closest('section')?.querySelector('h3')?.textContent !== zh.recents)
}

/** One session row (treeitem; not a workspace/folder/repo/subws row, and not
 *  under the recency section) by title. Hashed CSS-module class names keep
 *  the camelCase local names (`_sessionRow_…`, `_rowCompact_…`), so the
 *  discriminator matches those exact spellings. */
function sessionRowByText(text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .find(row => row.textContent?.includes(text)
      && !/workspaceRow|folderRow|repoRow|subwsRow|unregRow/.test(row.className)
      && row.closest('section')?.querySelector('h3')?.textContent !== zh.recents)
}

/** True when the element carries the built-in sessionRow class (fallback). */
function isFallbackSessionRow(row: HTMLElement): boolean {
  return row.className.includes('sessionRow')
}

/** One menu item (portal seat) whose text contains `text`, or undefined. */
function menuItemByText(text: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent?.includes(text))
}

function click(target: Element): void {
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

/** Type into an input the React way (prototype setter + bubbling input). */
function typeText(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** React's onMouseEnter derives from a bubbling mouseover. */
function mouseEnter(target: Element): void {
  act(() => { target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
}

/** React's onPointerEnter derives from a bubbling pointerover. */
function pointerEnter(target: Element): void {
  act(() => { target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })) })
}

/** Fire dragstart with a recording DataTransfer stub (jsdom ships none). */
function dragStartWithPayload(row: HTMLElement): { effectAllowed: string; payloads: Record<string, string> } {
  const payloads: Record<string, string> = {}
  const transfer = {
    effectAllowed: '',
    setData: (type: string, value: string): void => { payloads[type] = value },
  }
  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  act(() => { row.dispatchEvent(event) })
  return { effectAllowed: transfer.effectAllowed, payloads }
}

beforeEach(() => {
  localStorage.clear()
  workspacesState = WORKSPACES_STATE
  sessionsState = SESSIONS_STATE
  fileTreeUiSeat = undefined
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  vi.useRealTimers()
  act(() => { root?.unmount() })
  container?.remove()
  document.body.querySelectorAll('[data-testid]').forEach(node => node.remove())
  for (const node of [...document.body.children]) {
    if (node !== container) node.remove()
  }
})

describe('fileTreeUi v1 service seat (index.tsx resolver)', () => {
  it('resolves a valid v1 service and warns exactly once per degraded episode', () => {
    const warn = vi.fn()
    const service = makeFileTreeUiService()
    // One reader for the whole episode: warn-once state must persist across
    // repeated reads and every failure mode (missing / version / partial).
    let currentValue: unknown = undefined
    const resolver = createFileTreeUiResolver(() => currentValue, warn)

    expect(resolver()).toBeUndefined()
    expect(resolver()).toBeUndefined()
    expect(warn, 'missing service warns once').toHaveBeenCalledTimes(1)

    // Protocol mismatch (version 2) → still the same degraded episode.
    currentValue = { ...service, protocolVersion: 2 }
    expect(resolver()).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)

    // Partial implementation (missing a render method) → undefined.
    const { renderRowMenu: _dropped, ...partial } = service
    currentValue = partial
    expect(resolver()).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)

    // A valid service resolves and re-arms the warning for the next episode.
    currentValue = service
    expect(resolver()).toBe(service)
    expect(warn).toHaveBeenCalledTimes(1)
    currentValue = undefined
    expect(resolver(), 'unload is a new episode but still warns once').toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
    expect(resolver()).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('re-arms the warning after a valid service was seen, and never warns on valid reads', () => {
    const warn = vi.fn()
    const service = makeFileTreeUiService()
    const resolver = createFileTreeUiResolver(() => currentValue, warn)
    let currentValue: unknown = service
    expect(resolver()).toBe(service)
    expect(warn).not.toHaveBeenCalled()

    // Unload: a NEW degraded episode warns once again…
    currentValue = undefined
    expect(resolver()).toBeUndefined()
    expect(resolver()).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)

    // …and re-provide resets it (a valid read re-arms the warning).
    currentValue = service
    expect(resolver()).toBe(service)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('fileTreeUi service path (tree session rows)', () => {
  it('replaces the row skeleton: status-dot slot (16px), title, menu button, active wash; click opens, drag source unchanged', async () => {
    const props = await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    // The current session (still unset in this fixture) is a plain row.
    click(treeRowByText('绘画收集')!)
    const row = sessionRowByText('画布草图')!
    expect(row, 'session row renders').toBeDefined()

    // Skeleton replacement: the built-in sessionRow class is gone; the row
    // is a service TreeRow (compact) with the status slot as its leading.
    expect(isFallbackSessionRow(row), 'service row drops the built-in skeleton').toBe(false)
    expect(row.getAttribute('role')).toBe('treeitem')
    expect(row.querySelector('[class*="sessionStatusSlot"]'), 'status-dot leading slot keeps the 16px caption').not.toBeNull()
    // The status slot wrapper is fixed at 16px (leadingSlotWidth).
    const leadingWrapper = [...row.children].find(child =>
      child instanceof HTMLElement && child.style.width === '16px')
    expect(leadingWrapper, 'leading slot reserves 16px').toBeDefined()
    // The visually hidden status label rides the dot.
    expect(row.querySelector('[class*="visuallyHidden"]')?.textContent, 'hidden status caption').toBe(zh.sessionStatusDone)

    // The row menu comes from the service (RowMenu): one ellipsis button
    // with the row-menu aria label; the three business items open it.
    const menuButton = row.querySelector<HTMLButtonElement>('button[aria-label]')
    expect(menuButton, 'service RowMenu button').toBeDefined()
    click(menuButton!)
    expect(menuItemByText(zh.rename)).toBeDefined()
    expect(menuItemByText(zh.sessionFork)).toBeDefined()
    expect(menuItemByText(zh.sessionArchive)).toBeDefined()
    // Selecting closes the menu first (RowMenu), then runs the business
    // openers — the session rename opens the rename dialog pre-filled with
    // the current title (the built-in row's menu behaves identically).
    click(menuItemByText(zh.rename)!)
    expect(menuItemByText(zh.rename), 'menu closes after select').toBeUndefined()
    const renameInput = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(input => input.getAttribute('aria-label') === zh.folderName).at(-1)
    expect(renameInput, 'rename dialog opens with the current title').toBeDefined()
    expect(renameInput!.value).toBe('画布草图')
    typeText(renameInput!, '画布草图v2')
    click([...document.body.querySelectorAll('button')]
      .find(button => button.textContent === zh.rename)!)
    expect(props.renameSession).toHaveBeenCalledWith('s1', '画布草图v2')

    // Clicking the row opens the session.
    click(row)
    expect(props.open).toHaveBeenCalledWith('s1')

    // Drag source unchanged: copy semantics + x-dsh-reference payload.
    const drag = dragStartWithPayload(row)
    expect(drag.effectAllowed).toBe('copy')
    expect(drag.payloads['application/x-dsh-reference+json'])
      .toBe(JSON.stringify({ version: 1, kind: 'session', id: 's1' }))
  })

  it('carries the current-session wash (active) and stays draggable=false for blank rows', async () => {
    await renderBrowser()
    // Make s1 the current session: its row carries the wash. The store's
    // baseline hydration auto-expands the current session's workspace group,
    // so the session rows are visible without clicking.
    sessionsState = { ...SESSIONS_STATE, current: 's1' as SessionId }
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    const currentRow = sessionRowByText('画布草图')!
    expect(currentRow.className, 'current row gets the wash (rowCurrent)').toContain('rowCurrent')
    const otherRow = sessionRowByText('配色研究')!
    expect(otherRow.className, 'non-current row stays plain').not.toContain('rowCurrent')

    // Blank current session: "新会话" row, no menu, not draggable.
    sessionsState = {
      ...SESSIONS_STATE,
      current: 'blank1' as SessionId,
      ids: [...SESSIONS_STATE.ids, 'blank1'],
      byId: { ...SESSIONS_BY_ID, blank1: session('blank1', 'New Session', 0, true) },
    }
    await rerender()
    const blankRow = sessionRowByText(zh.newSession)!
    expect(blankRow, 'blank row from the service path').toBeDefined()
    expect(blankRow.getAttribute('draggable')).toBe('false')
    expect(blankRow.querySelector('button'), 'blank rows carry no menu').toBeNull()
    // The wash still applies (the current session IS the blank one).
    expect(blankRow.className).toContain('rowCurrent')
  })
})

describe('fileTreeUi service path (flat list + container layer)', () => {
  it('renders flat-list session rows without indent/guides (compact fallback) and the blank row without a menu', async () => {
    const props = await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    act(() => { instance.actions.setGroupBy('flat') })
    await rerender()

    const row = sessionRowByText('画布草图')!
    expect(row).toBeDefined()
    // No indent, no guides: no inline padding and no guide bands.
    expect(row.style.paddingLeft, 'flat rows keep the CSS fallback inset').toBe('')
    expect(row.querySelectorAll('[class*="guideHit"]')).toHaveLength(0)
    expect(row.style.backgroundImage).toBe('')
    expect(row.querySelector('button[aria-label]'), 'flat non-blank rows keep their menu').not.toBeNull()
    // Flat mode honors the same open-on-click.
    click(row)
    expect(props.open).toHaveBeenCalledWith('s1')
  })

  it('paints the container layer strokes continuously and lets the row only light the hovered column; band click folds, never opens', async () => {
    const props = await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    // One ancestor folder → session rows carry 2 columns (folder + workspace).
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.moveWorkspaceIn(W('w-art'), alpha) })
    act(() => { instance.actions.setFolderExpanded(alpha, true) })
    await rerender()
    click(treeRowByText('绘画收集')!) // open the session list

    const sessionRow = sessionRowByText('画布草图')!
    const bands = sessionRow.querySelectorAll<HTMLElement>('[class*="guideHit"]')
    expect(bands.length, 'one band per ancestor column (folder + workspace)').toBe(2)
    // The container (TreeGuideLayer) owns the continuous strokes…
    const layer = [...container.querySelectorAll<HTMLElement>('[class*="sessionList"]')]
      .find(el => el.querySelector('[role="treeitem"]') !== null)
    expect(layer, 'sessionList container becomes the guide layer').toBeDefined()
    expect(layer!.style.backgroundImage, 'the layer paints the full stroke set').toContain('linear-gradient')
    // …while the row paints NOTHING until a band is hovered (paintMode
    // 'layer' — no double strokes).
    expect(sessionRow.style.backgroundImage, 'row stays clean until hover').toBe('')

    // Hovering the deepest band lights the whole workspace column on the row.
    mouseEnter(bands[1]!)
    expect(sessionRow.style.backgroundImage).toContain(GUIDE_STROKE_HOVER)

    // Clicking the deepest band collapses the session list WITHOUT opening.
    click(bands[1]!)
    expect(props.open, 'band clicks never open the session').not.toHaveBeenCalled()
    expect(instance.getSnapshot().groupExpansion['w-art'], 'deepest band folds the workspace').toBe(false)
    expect(sessionRowByText('画布草图'), 'session list folded').toBeUndefined()

    // Reopen and click the folder column band — folds the folder instead.
    click(treeRowByText('绘画收集')!)
    const again = sessionRowByText('画布草图')!
    click(again.querySelectorAll<HTMLElement>('[class*="guideHit"]')[0]!)
    expect(props.open).not.toHaveBeenCalled()
    expect(instance.getSnapshot().folderExpansion[alpha], 'folder column band folds the folder').toBe(false)
    expect(treeRowByText('绘画收集'), 'the folded folder hides its workspace row').toBeUndefined()
  })
})

describe('fileTreeUi hover card interlock', () => {
  it('opens its hover card on dwell and stays disabled while the row menu is open', async () => {
    // Real timers + explicit dwell waits: the HoverCard's open delay is a
    // plain setTimeout (ui-primitives), both paths behave identically.
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    click(treeRowByText('绘画收集')!)
    const row = sessionRowByText('画布草图')!
    const props = latestProps

    const dwell = async (): Promise<void> => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) })
    }

    // Occurrences of the row title in the whole document: the row label (1)
    // plus the hover card's heading — the card is PORTALED to document.body.
    const titleCount = (): number => (document.body.textContent?.split('画布草图').length ?? 1) - 1
    expect(titleCount(), 'closed card adds no title').toBe(1)

    // Dwell 500ms on the row (service row inside the HoverCard anchor).
    pointerEnter(row.parentElement!)
    await dwell()
    expect(titleCount(), 'hover card opens with the row title').toBe(2)

    // Opening the row menu suppresses the card for the same hover — the
    // disabled HoverCard closes its open card immediately.
    const menuButton = row.querySelector<HTMLButtonElement>('button[aria-label]')!
    click(menuButton!)
    expect(menuItemByText(zh.rename)).toBeDefined()
    expect(titleCount(), 'opening the menu closes the open card').toBe(1)
    pointerEnter(row.parentElement!)
    await dwell()
    expect(titleCount(), 'menu open keeps the card disabled').toBe(1)

    // Selecting an item closes the menu and the card works again.
    click(menuItemByText(zh.sessionFork)!)
    expect(props.forkSession, 'RowMenu select still runs the business action').toHaveBeenCalledWith('s1')
    expect(menuItemByText(zh.sessionFork), 'menu closes after select').toBeUndefined()
    pointerEnter(row.parentElement!)
    await dwell()
    expect(titleCount(), 'card returns once the menu closes').toBe(2)
  })
})

describe('fileTreeUi snapshot flips (provider ↔ missing)', () => {
  it('switches between the service rows and the built-in fallback without a blank screen', async () => {
    const props = await renderBrowser()
    // 1. Missing at mount → built-in fallback rows (unchanged pre-P2 shape).
    click(treeRowByText('绘画收集')!)
    const fallbackRow = sessionRowByText('画布草图')!
    expect(isFallbackSessionRow(fallbackRow), 'fallback keeps the built-in skeleton').toBe(true)
    // The fallback row still opens and drags (regression guard).
    click(fallbackRow)
    expect(props.open).toHaveBeenCalledWith('s1')

    // 2. Provider arrives (subscription-driven flip) → service rows.
    vi.mocked(props.open).mockClear()
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    const serviceRow = sessionRowByText('画布草图')!
    expect(serviceRow, 'service row still renders (no white screen)').toBeDefined()
    expect(isFallbackSessionRow(serviceRow), 'skeleton replaced').toBe(false)
    click(serviceRow)
    expect(props.open).toHaveBeenCalledWith('s1')

    // 3. Provider unloads → back to the fallback, still interactive.
    vi.mocked(props.open).mockClear()
    fileTreeUiSeat = undefined
    await rerender()
    const fallbackAgain = sessionRowByText('画布草图')!
    expect(fallbackAgain, 'fallback row still renders (no white screen)').toBeDefined()
    expect(isFallbackSessionRow(fallbackAgain), 'built-in skeleton returns').toBe(true)
    click(fallbackAgain)
    expect(props.open).toHaveBeenCalledWith('s1')
  })
})
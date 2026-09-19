// @vitest-environment jsdom
/**
 * Component spec of the fileTreeUi v2 consumer integration (provider:
 * dsh-file-tree-ui). With the service present the browser builds WHOLE-TREE
 * row models per section and renders each section through ONE
 * `renderFileTree` call (the provider's real FileTree framework owns the
 * tree chrome, the fold interaction and the guide-hover seat); without it
 * (missing / mismatched / unloaded) the built-in fallback rows render,
 * byte-for-byte the pre-v1 shape.
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
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { FileTree } from 'dsh-file-tree-ui/src/client/FileTree.tsx'
import { RowMenu } from 'dsh-file-tree-ui/src/client/RowMenu.tsx'
import type {
  FileTreeProps,
  FileTreeRowModel,
  FileTreeNode,
  FileTreeUiServiceV2,
} from 'dsh-file-tree-ui/client-contract'
import { EnhancedWorkspaceBrowser, GUIDE_STROKE_HOVER } from '../src/client/Browser.tsx'
import { DIRECTORY_FLOW_SLOT, SEARCH_SLOT, type EnhancedWorkspaceBrowserProps } from '../src/client/contract.ts'
import { createFileTreeUiResolver } from '../src/client/index.tsx'
import { zh } from '../src/client/locales.ts'
import { ROOT_FOLDER_ID } from '../src/client/model.ts'
import { sessionMention } from '../src/client/reference.ts'
import { createEnhancedWorkspaceStore, type EnhancedWorkspaceState } from '../src/client/store.ts'
import type { GitProbeResultJSON } from '../src/shared/git.ts'

const W = (id: string): WorkspaceId => id as WorkspaceId

/** Fixed "now" for deterministic relative-time labels. */
const NOW = Date.now()

/** One fixture session row (all ordinary user-origin, non-blank). */
function session(id: string, title: string, ageMs: number, blank = false, cwd?: string): SessionSummary {
  return {
    id: id as SessionId,
    displayTitle: title,
    blank,
    running: false,
    completed: true,
    updatedAt: NOW - ageMs,
    ...(cwd === undefined ? {} : { cwd }),
  }
}

/** One fixture workspace view (path overridable for the git fixtures). */
function workspace(id: string, title: string, sessionIds: string[], path?: string): WorkspaceView {
  return {
    workspaceId: id as WorkspaceId,
    path: path ?? `/projects/${id}`,
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
 * The fileTreeUi v2 service seat: undefined by default (missing provider →
 * built-in rows); a test binds a REAL provider-shaped service here and
 * re-renders — the same way the `internal/service` subscription flips the
 * snapshot at runtime.
 */
let fileTreeUiSeat: FileTreeUiServiceV2 | undefined = undefined

/** The provider-shaped v2 service fixture: the REAL upstream components
 *  (FileTree framework + RowMenu). */
function makeFileTreeUiService(): FileTreeUiServiceV2 {
  return {
    protocolVersion: 2,
    renderFileTree: props => <FileTree {...props} />,
    renderRowMenu: props => <RowMenu {...props} />,
  }
}

/** Like makeFileTreeUiService but records every renderFileTree props object
 *  (model-shape assertions while still rendering through the real FileTree). */
function makeRecordingFileTreeUiService(): { service: FileTreeUiServiceV2; trees: FileTreeProps[] } {
  const trees: FileTreeProps[] = []
  const service: FileTreeUiServiceV2 = {
    protocolVersion: 2,
    renderFileTree: props => {
      trees.push(props)
      return <FileTree {...props} />
    },
    renderRowMenu: props => <RowMenu {...props} />,
  }
  return { service, trees }
}

/** True when the node is a FileTreeRowModel (a label-carrying object — the
 *  framework's own discrimination). */
function isRowModel(node: FileTreeNode): node is FileTreeRowModel {
  return typeof node === 'object' && node !== null && 'label' in node
}

/** One model row by key inside a tree's row list. */
function rowModelOf(tree: FileTreeProps | undefined, key: string): FileTreeRowModel | undefined {
  if (tree === undefined) return undefined
  for (const node of tree.rows) {
    if (isRowModel(node) && node.key === key) return node
  }
  return undefined
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
async function renderBrowser(probe: GitProbeResultJSON | null = null): Promise<EnhancedWorkspaceBrowserProps> {
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
    useFileTreeUi: (selector: (value: FileTreeUiServiceV2 | undefined) => unknown) => selector(fileTreeUiSeat),
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
    probeGit: vi.fn(async () => probe),
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

/** Wait out the framework's fold EXIT animation (timeout fallback =
 *  FOLD_ANIMATION_MS + 80ms) so assertions read the final DOM state. */
async function settleFold(): Promise<void> {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
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

/** A native drag event with a null dataTransfer (the row handlers guard it). */
function dragEvent(type: string, clientY: number): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as DragEvent
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: null })
  return event
}

/** Stub one row's bounding rect so folderDropZone/rowDropZone math is deterministic. */
function stubRect(row: HTMLElement, top: number, height: number): void {
  row.getBoundingClientRect = (): DOMRect => ({
    top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top,
    toJSON: () => ({}),
  }) as DOMRect
}

/** Start a drag on a row (its handler seeds the drag seat). */
function dragStart(row: HTMLElement): void {
  act(() => { row.dispatchEvent(dragEvent('dragstart', 0)) })
}

/** Move the pointer over a target row (computes the drop zone). */
function dragOver(row: HTMLElement, clientY: number): void {
  act(() => { row.dispatchEvent(dragEvent('dragover', clientY)) })
}

/** Release the drag over the target row. */
function dropOn(row: HTMLElement, clientY: number): void {
  act(() => { row.dispatchEvent(dragEvent('drop', clientY)) })
}

/** End the drag (clears the seat). */
function dragEnd(row: HTMLElement): void {
  act(() => { row.dispatchEvent(dragEvent('dragend', 0)) })
}

/** The framework row's chevron toggle (v2: clickable when the model carries
 *  expanded + onToggle). */
function chevronOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>('[class*="chevron"]')
}

/** The provider's resting-indicator hover rule, read from its stylesheet —
 *  the JS-mutual-exclusion counterpart the service path relies on (jsdom
 *  applies no styles, so the rule itself is asserted). */
function upstreamRestingIndicatorRule(): string | undefined {
  const require = createRequire(import.meta.url)
  const packageRoot = dirname(require.resolve('dsh-file-tree-ui/package.json'))
  const css = readFileSync(join(packageRoot, 'src', 'client', 'tree-row.module.css'), 'utf8')
  const match = css.match(/\.row:hover\s*>\s*\.restingIndicator\s*\{[^}]*\}/)
  return match?.[0]
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

describe('fileTreeUi v2 service seat (index.tsx resolver)', () => {
  it('resolves a valid v2 service and warns exactly once per degraded episode', () => {
    const warn = vi.fn()
    const service = makeFileTreeUiService()
    // One reader for the whole episode: warn-once state must persist across
    // repeated reads and every failure mode (missing / version / partial).
    let currentValue: unknown = undefined
    const resolver = createFileTreeUiResolver(() => currentValue, warn)

    expect(resolver()).toBeUndefined()
    expect(resolver()).toBeUndefined()
    expect(warn, 'missing service warns once').toHaveBeenCalledTimes(1)

    // Protocol mismatch (version 1) → still the same degraded episode.
    currentValue = { ...service, protocolVersion: 1 }
    expect(resolver()).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)

    // Partial implementation (missing renderFileTree) → undefined.
    const { renderFileTree: _dropped, ...partial } = service
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
    // is the framework's compact TreeRow with the status slot as its
    // leading (the model-driven DOM passthrough rides the same TreeRow).
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

    // Drag source unchanged: copy semantics + x-dsh-reference payload — the
    // reference payload now carries the canonical mention as the drop text.
    const drag = dragStartWithPayload(row)
    expect(drag.effectAllowed).toBe('copy')
    expect(drag.payloads['application/x-dsh-reference+json'])
      .toBe(JSON.stringify({ version: 1, kind: 'session', id: 's1', label: '画布草图', mention: sessionMention('s1', '画布草图') }))
    expect(drag.payloads['text/plain']).toBe(sessionMention('s1', '画布草图'))
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
    // The workspace's children list is the framework's continuous guide
    // layer (childrenList 'layer' — the built-in sessionListLayer's role),
    // while the row paints NOTHING until a band is hovered (onlyHighlight).
    const layer = sessionRow.closest<HTMLElement>('[class*="layer"]')
    expect(layer, 'session rows sit inside the container layer').not.toBeNull()
    expect(layer!.style.backgroundImage, 'the layer paints the full stroke set').toContain('linear-gradient')
    expect(sessionRow.style.backgroundImage, 'row stays clean until hover').toBe('')

    // Hovering the deepest band lights the whole workspace column on the row.
    mouseEnter(bands[1]!)
    expect(sessionRow.style.backgroundImage).toContain(GUIDE_STROKE_HOVER)

    // Clicking the deepest band collapses the session list WITHOUT opening
    // (the framework routes the band click to the column's onToggle).
    click(bands[1]!)
    expect(props.open, 'band clicks never open the session').not.toHaveBeenCalled()
    expect(instance.getSnapshot().groupExpansion['w-art'], 'deepest band folds the workspace').toBe(false)
    await settleFold()
    expect(sessionRowByText('画布草图'), 'session list folded').toBeUndefined()

    // Reopen and click the folder column band — folds the folder instead.
    click(treeRowByText('绘画收集')!)
    const again = sessionRowByText('画布草图')!
    click(again.querySelectorAll<HTMLElement>('[class*="guideHit"]')[0]!)
    expect(props.open).not.toHaveBeenCalled()
    expect(instance.getSnapshot().folderExpansion[alpha], 'folder column band folds the folder').toBe(false)
    await settleFold()
    expect(treeRowByText('绘画收集'), 'the folded folder hides its workspace row').toBeUndefined()
  })
})

describe('fileTreeUi hover card interlock', () => {
  it('opens its hover card on dwell and stays disabled while the row menu is open', async () => {
    // Real timers + explicit dwell waits: the HoverCard's open delay is a
    // plain setTimeout (ui-primitives), both paths behave identically. The
    // v2 card anchor rides the row's LABEL slot (the framework owns the row
    // chrome), so the dwell target is the label span inside the row.
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    click(treeRowByText('绘画收集')!)
    const row = sessionRowByText('画布草图')!
    const label = row.querySelector<HTMLElement>('[class*="rowLabel"]')!
    const props = latestProps
    // The hover-card trigger is the wrapper span around the label slot's
    // anchor (the framework's rowLabel span wraps that wrapper).
    const anchorWrapper = (): HTMLElement => label.firstElementChild as HTMLElement

    const dwell = async (): Promise<void> => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) })
    }

    // Occurrences of the row title in the whole document: the row label (1)
    // plus the hover card's heading — the card is PORTALED to document.body.
    const titleCount = (): number => (document.body.textContent?.split('画布草图').length ?? 1) - 1
    expect(titleCount(), 'closed card adds no title').toBe(1)

    // Dwell 500ms on the row's label (the service row's hover-card anchor).
    pointerEnter(anchorWrapper())
    await dwell()
    expect(titleCount(), 'hover card opens with the row title').toBe(2)

    // Opening the row menu suppresses the card for the same hover — the
    // disabled HoverCard closes its open card immediately.
    const menuButton = row.querySelector<HTMLButtonElement>('button[aria-label]')!
    click(menuButton!)
    expect(menuItemByText(zh.rename)).toBeDefined()
    expect(titleCount(), 'opening the menu closes the open card').toBe(1)
    pointerEnter(anchorWrapper())
    await dwell()
    expect(titleCount(), 'menu open keeps the card disabled').toBe(1)

    // Selecting an item closes the menu and the card works again.
    click(menuItemByText(zh.sessionFork)!)
    expect(props.forkSession, 'RowMenu select still runs the business action').toHaveBeenCalledWith('s1')
    expect(menuItemByText(zh.sessionFork), 'menu closes after select').toBeUndefined()
    pointerEnter(anchorWrapper())
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

/** The acme probe: two trees of one repo (own tree + linked worktree). */
const PROBE_MAIN = '/work/acme'
const PROBE_LINK = '/tmp/acme/feat-payment'
const PROBE: GitProbeResultJSON = {
  trees: {
    [PROBE_MAIN]: { root: PROBE_MAIN, repoKey: '/work/acme/.git', role: 'main', branch: 'main' },
    [PROBE_LINK]: { root: PROBE_LINK, repoKey: '/work/acme/.git', role: 'linked', branch: 'feat/payment' },
  },
  bindings: { [PROBE_MAIN]: PROBE_MAIN, [PROBE_LINK]: PROBE_LINK },
  scannedAt: 1000,
}

/** One folder row (treeitem) OUTSIDE the recency section, by label. */
function folderRowByText(text: string): HTMLElement | undefined {
  return treeRowByText(text)
}

/** The row's drop-zone visual class (before/after/on). */
function dropClassOf(row: HTMLElement, zone: 'Before' | 'After' | 'On'): boolean {
  return row.className.includes(`rowDrop${zone}`)
}

describe('fileTreeUi service path (FolderRow)', () => {
  it('paints one guide column per ancestor level, the junction with expansion, and folds on row click', async () => {
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.createFolder(alpha, 'beta') })
    const beta = instance.getSnapshot().folders[alpha]!.folderIds[0]!
    act(() => { instance.actions.moveWorkspaceIn(W('w-art'), beta) })
    act(() => { instance.actions.setFolderExpanded(alpha, true) })
    act(() => { instance.actions.setFolderExpanded(beta, true) })
    await rerender()

    const alphaRow = folderRowByText('alpha')!
    const betaRow = folderRowByText('beta')!
    // Skeleton replacement on folder rows too (the framework TreeRow).
    expect(alphaRow.className, 'folder row rides the service skeleton').not.toContain('folderRow')
    expect(alphaRow.getAttribute('role')).toBe('treeitem')
    expect(alphaRow.getAttribute('aria-expanded')).toBe('true')
    // One column per ancestor: top-level folder 0 bands, its child 1, the
    // session rows under beta keep 2 (folder columns + the workspace's own).
    expect(alphaRow.querySelectorAll('[class*="guideHit"]'), 'top-level folder has no bands').toHaveLength(0)
    expect(betaRow.querySelectorAll('[class*="guideHit"]'), 'depth-1 folder has one band').toHaveLength(1)
    // The junction rides the DEEPEST ancestor column — a top-level row has no
    // columns, so it paints nothing at all (exactly like the built-in path).
    expect(alphaRow.style.backgroundImage, 'top-level folder paints no strokes').toBe('')
    // A depth-1 row: the corner segment + trunk appear while expanded and
    // disappear when the row folds (the ancestor vertical stays).
    expect(betaRow.style.backgroundImage, 'expanded: the corner segment').toContain('linear-gradient(0deg')
    expect(betaRow.style.backgroundImage, 'expanded: the corner trunk').toContain('transparent 100%)')
    click(betaRow)
    expect(instance.getSnapshot().folderExpansion[beta], 'row click folds the folder').toBe(false)
    // Clicks flip the MODEL's expanded — the row itself re-renders
    // immediately (only the fold SUBTREE plays its exit animation).
    expect(folderRowByText('beta')!.style.backgroundImage, 'collapsed: corner gone').not.toContain('linear-gradient(0deg')
    expect(folderRowByText('beta')!.style.backgroundImage, 'collapsed: ancestor vertical stays').toContain('linear-gradient(90deg')
    // Reopen beta, then fold alpha from its own row — the subtree unmounts
    // after the fold exit animation completes.
    click(folderRowByText('beta')!)
    click(alphaRow)
    expect(instance.getSnapshot().folderExpansion[alpha], 'row click folds the ancestor too').toBe(false)
    await settleFold()
    expect(folderRowByText('beta'), 'folding unmounts the subtree').toBeUndefined()
  })

  it('renders the drop three-state (before/on/after) from the consumer-side zone judgement', async () => {
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.createFolder(alpha, 'beta') })
    const beta = instance.getSnapshot().folders[alpha]!.folderIds[0]!
    act(() => { instance.actions.setFolderExpanded(alpha, true) })
    act(() => { instance.actions.setFolderExpanded(beta, true) })
    await rerender()

    const alphaRow = folderRowByText('alpha')!
    const betaRow = folderRowByText('beta')!
    expect(alphaRow.className).not.toContain('rowDrop')
    // Dragging the beta FOLDER over alpha: the whole zone ladder is
    // previewable (workspace-source before-zones are deliberately suppressed
    // by the consumer's dropZoneOf).
    stubRect(alphaRow, 100, 30) // mid 115, band 4.5
    dragStart(betaRow)
    dragOver(alphaRow, 100)
    expect(dropClassOf(alphaRow, 'Before'), 'top band = before').toBe(true)
    dragOver(alphaRow, 115)
    expect(dropClassOf(alphaRow, 'On'), 'middle band = on').toBe(true)
    dragOver(alphaRow, 130)
    expect(dropClassOf(alphaRow, 'After'), 'bottom band = after').toBe(true)
    dragEnd(alphaRow)
    expect(alphaRow.className, 'drag end clears the preview').not.toContain('rowDrop')
  })

  it('keeps folder drag semantics in the consumer (move + text/plain id)', async () => {
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    act(() => { instance.actions.setFolderExpanded(instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!, true) })
    await rerender()
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    const drag = dragStartWithPayload(folderRowByText('alpha')!)
    expect(drag.effectAllowed).toBe('move')
    expect(drag.payloads['text/plain']).toBe(alpha)
  })

  it('routes the folder menu items to their openers and never toggles the row on band clicks', async () => {
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.createFolder(alpha, 'beta') })
    const beta = instance.getSnapshot().folders[alpha]!.folderIds[0]!
    act(() => { instance.actions.setFolderExpanded(alpha, true) })
    await rerender()

    // Menu route: new-subfolder opens the input dialog.
    const alphaRow = folderRowByText('alpha')!
    click(alphaRow.querySelector<HTMLButtonElement>('button[aria-label]')!)
    expect(menuItemByText(zh.newSubfolder)).toBeDefined()
    click(menuItemByText(zh.newSubfolder)!)
    const folderInput = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(input => input.getAttribute('aria-label') === zh.folderName).at(-1)
    expect(folderInput, 'new-subfolder opens the folder-name dialog').toBeDefined()

    // Menu route: delete opens the confirm dialog.
    click(folderRowByText('beta')!.querySelector<HTMLButtonElement>('button[aria-label]')!)
    click(menuItemByText(zh.deleteFolderTitle)!)
    expect([...document.body.querySelectorAll('[role="dialog"]')]
      .some(dialog => dialog.textContent?.includes(zh.deleteFolderTitle)),
    'delete opens the confirm dialog').toBe(true)

    // Band click folds the ANCESTOR (alpha via beta's band) without toggling
    // the row itself — the folder keeps its own expansion state.
    const betaRow = folderRowByText('beta')!
    const band = betaRow.querySelectorAll<HTMLElement>('[class*="guideHit"]')[0]!
    mouseEnter(band)
    expect(betaRow.style.backgroundImage, 'the ancestor line lights up').toContain(GUIDE_STROKE_HOVER)
    const betaExpandedBefore = instance.getSnapshot().folderExpansion[beta]
    click(band)
    expect(instance.getSnapshot().folderExpansion[alpha], 'band folds the ancestor').toBe(false)
    expect(instance.getSnapshot().folderExpansion[beta], 'the row itself keeps its expansion').toBe(betaExpandedBefore)
  })
})

describe('fileTreeUi service path (LeafRow)', () => {
  it('seats the collapsed busy marker in the restingIndicator slot, hidden on hover by the provider rule', async () => {
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    // '绘画收集' is collapsed with two completed sessions → the top-priority
    // done dot sits in the actions slot at rest.
    const row = treeRowByText('绘画收集')!
    expect(row.className, 'workspace row rides the service skeleton').not.toContain('workspaceRow')
    const resting = row.querySelector<HTMLElement>('[class*="restingIndicator"]')
    expect(resting, 'the busy marker rides the restingIndicator slot').not.toBeNull()
    expect(resting!.querySelector('[class*="rowBusy"]'), 'the built-in marker markup rides inside').not.toBeNull()
    expect(resting!.querySelector('[class*="visuallyHidden"]')?.textContent, 'the status caption is sr-only').not.toBe('')
    // The mutual exclusion is the provider's CSS (asserted on its
    // stylesheet): .row:hover > .restingIndicator { display: none }.
    const rule = upstreamRestingIndicatorRule()
    expect(rule, 'provider ships the hover-hide rule').toBeDefined()
    expect(rule).toContain('display: none')
    // Expanded → no resting marker (the dot only marks collapsed dirs).
    click(row)
    const expandedRow = treeRowByText('绘画收集')!
    expect(expandedRow.querySelector('[class*="restingIndicator"]'), 'expanded rows carry no dot').toBeNull()
  })

  it('keeps the git cross-tree pill as the trailing slot and the plus button as its own action', async () => {
    const props = await renderBrowser(PROBE)
    fileTreeUiSeat = makeFileTreeUiService()
    workspacesState = {
      ...WORKSPACES_STATE,
      items: [workspace('w-acme', 'acme', ['ga1', 'gc1'], PROBE_MAIN)],
    } as typeof WORKSPACES_STATE
    sessionsState = {
      ...SESSIONS_STATE,
      ids: ['ga1', 'gc1'],
      byId: {
        ga1: session('ga1', '初始化脚手架', 1000, false, PROBE_MAIN),
        gc1: session('gc1', 'hotfix 排查', 2000, false, PROBE_LINK),
      },
    }
    await rerender()
    const row = treeRowByText('acme')!
    const pill = row.querySelector<HTMLElement>('[class*="gitPillMulti"]')
    expect(pill, 'the cross-tree count rides the trailing slot').not.toBeNull()
    expect(pill!.textContent).toBe('2 棵')
    // The plus button is the consumer's own action inside the actions slot.
    const plus = row.querySelector<HTMLButtonElement>(`button[aria-label="${zh.newSessionAria.replace('{name}', 'acme')}"]`)
    expect(plus, 'the new-session plus button stays').not.toBeNull()
    click(plus!)
    expect(props.startSession).toHaveBeenCalledWith('w-acme')
  })

  it('still opens its hover card on dwell and suppresses it while the row menu is open', async () => {
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    const row = treeRowByText('绘画收集')!
    const label = row.querySelector<HTMLElement>('[class*="rowLabel"]')!
    const dwell = async (): Promise<void> => {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 700)) })
    }
    const card = (): HTMLElement | null => document.body.querySelector('[class*="hoverContent"]')
    pointerEnter(label.firstElementChild!)
    await dwell()
    expect(card(), 'workspace hover card opens').not.toBeNull()
    // Opening the row menu disables the HoverCard for the same hover.
    click(row.querySelector<HTMLButtonElement>('button[aria-label]')!)
    expect(menuItemByText(zh.rename)).toBeDefined()
    pointerEnter(label.firstElementChild!)
    await dwell()
    expect(card(), 'menu open keeps the card closed').toBeNull()
  })
})

describe('fileTreeUi service path (container continuity + subws headers)', () => {
  it('keeps the overflow button inside the framework layer so the container supplies its line', async () => {
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    workspacesState = {
      ...WORKSPACES_STATE,
      items: [workspace('w-art', '绘画收集', ['s1', 's2', 's3', 's4', 's5', 's6'])],
    } as typeof WORKSPACES_STATE
    sessionsState = {
      ...SESSIONS_STATE,
      ids: ['s1', 's2', 's3', 's4', 's5', 's6'],
      byId: {
        s1: session('s1', '画布草图', 1000),
        s2: session('s2', '配色研究', 2000),
        s3: session('s3', '构图笔记', 3000),
        s4: session('s4', '笔刷测试', 4000),
        s5: session('s5', '参考图收集', 5000),
        s6: session('s6', '导出脚本', 6000),
      },
    }
    await rerender()
    click(treeRowByText('绘画收集')!)
    const overflow = container.querySelector<HTMLButtonElement>('[class*="overflowButton"]')
    expect(overflow, 'the overflow control renders under the service path').not.toBeNull()
    const layer = overflow!.closest('[class*="layer"]') as HTMLElement | null
    expect(layer, 'the button sits inside the framework layer container').not.toBeNull()
    expect(layer!.style.backgroundImage, 'the layer keeps painting the full stroke set').toContain('linear-gradient')
    expect(overflow!.style.backgroundImage, 'the button itself carries no row background').toBe('')
  })

  it('renders the subwsRow header with no baseline strokes of its own, hover lights the column', async () => {
    await renderBrowser(PROBE)
    fileTreeUiSeat = makeFileTreeUiService()
    workspacesState = {
      ...WORKSPACES_STATE,
      items: [workspace('w-acme', 'acme', ['ga1', 'gc1'], PROBE_MAIN)],
    } as typeof WORKSPACES_STATE
    sessionsState = {
      ...SESSIONS_STATE,
      ids: ['ga1', 'gc1'],
      byId: {
        ga1: session('ga1', '初始化脚手架', 1000, false, PROBE_MAIN),
        gc1: session('gc1', 'hotfix 排查', 2000, false, PROBE_LINK),
      },
    }
    await rerender()
    // Two cwd trees → split mode; the linked group header carries the
    // branch label.
    click(treeRowByText('acme')!)
    const header = treeRowByText('feat/payment')
    expect(header, 'the linked-tree group header renders').toBeDefined()
    expect(header!.className, 'header rides the framework compact variant').toContain('rowCompact')
    // indentPx = workspace indent (8, top level) + the 20px session offset.
    expect(header!.style.paddingLeft).toBe('28px')
    // The workspace's children list is the framework layer — the header
    // itself paints NOTHING until a band is hovered (no double draw).
    expect(header!.style.backgroundImage, 'header draws no baseline strokes').toBe('')
    const band = header!.querySelectorAll<HTMLElement>('[class*="guideHit"]')[0]!
    mouseEnter(band)
    expect(header!.style.backgroundImage, 'hover lights only the hovered column').toContain(GUIDE_STROKE_HOVER)
    const layer = header!.closest('[class*="layer"]') as HTMLElement | null
    expect(layer, 'header sits inside the container layer').not.toBeNull()
    expect(layer!.style.backgroundImage, 'the container keeps the continuous strokes').toContain('linear-gradient')
  })
})

describe('fileTreeUi snapshot flips (all row kinds)', () => {
  it('falls every migrated row kind back to the built-in on unload, white-screen free', async () => {
    const props = await renderBrowser()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.moveWorkspaceIn(W('w-art'), alpha) })
    act(() => { instance.actions.setFolderExpanded(alpha, true) })
    await rerender()
    click(treeRowByText('绘画收集')!)

    // 1. No service: every row kind is the built-in skeleton.
    expect(folderRowByText('alpha')!.className).toContain('folderRow')
    expect(treeRowByText('绘画收集')!.className).toContain('workspaceRow')
    expect(sessionRowByText('画布草图')!.className).toContain('sessionRow')

    // 2. Provider arrives: every kind switches to the framework skeleton and
    // stays interactive (folder click still folds, session click still opens).
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    expect(folderRowByText('alpha'), 'folder row still renders (no white screen)').toBeDefined()
    expect(folderRowByText('alpha')!.className).not.toContain('folderRow')
    expect(treeRowByText('绘画收集')!.className).not.toContain('workspaceRow')
    expect(sessionRowByText('画布草图')!.className).not.toContain('sessionRow')
    click(folderRowByText('alpha')!)
    expect(instance.getSnapshot().folderExpansion[alpha], 'service folder click still folds').toBe(false)
    click(folderRowByText('alpha')!) // reopen the folder (list stays open)
    click(sessionRowByText('画布草图')!)
    expect(props.open).toHaveBeenCalledWith('s1')

    // 3. Provider unloads: the whole tree falls back to the built-in rows.
    fileTreeUiSeat = undefined
    await rerender()
    expect(folderRowByText('alpha')!.className, 'folder falls back').toContain('folderRow')
    expect(treeRowByText('绘画收集')!.className, 'workspace falls back').toContain('workspaceRow')
    expect(sessionRowByText('画布草图')!.className, 'session falls back').toContain('sessionRow')
  })
})

describe('fileTreeUi v2 model building (renderFileTree props)', () => {
  it('builds the whole-tree row models: slots, children/childrenList, expanded/onToggle wiring and DOM passthrough', async () => {
    await renderBrowser()
    // One folder with the workspace moved in; both levels open so the
    // workspace carries its session rows.
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.moveWorkspaceIn(W('w-art'), alpha) })
    act(() => { instance.actions.setFolderExpanded(alpha, true) })
    act(() => { instance.actions.setGroupExpanded('w-art', true) })
    const { service, trees } = makeRecordingFileTreeUiService()
    fileTreeUiSeat = service
    await rerender()

    // The recency module and the "all" section each render through ONE
    // renderFileTree call (the recency fixture is empty → no rows).
    const all = trees.filter(tree => tree.treeKey === 'all').at(-1)
    expect(all, 'the "all" section renders through one renderFileTree call').toBeDefined()
    const recents = trees.find(tree => tree.treeKey === 'recents')
    expect(recents, 'the recency module renders through one renderFileTree call').toBeDefined()
    // The recency module lists every workspace (activity-scored) — each row
    // is a top-level leaf model with its prefixed group key.
    expect(recents!.rows).toHaveLength(2)
    expect(rowModelOf(recents, 'recent:w-art'), 'recents rows are leaf models').toBeDefined()

    // The folder row model: slot content + expansion state wiring + DOM
    // semantics + 'plain' children list (built-in folderChildren shape).
    const folder = rowModelOf(all, alpha)
    expect(folder, 'folder row model').toBeDefined()
    expect(folder!.label).toBe('alpha')
    expect(folder!.expanded).toBe(true)
    expect(typeof folder!.onToggle).toBe('function')
    expect(folder!.guideColumns, 'top-level folder owns no guide columns').toHaveLength(0)
    expect(folder!.junction).toBe(true)
    expect(folder!.indentPx).toBe(8)
    expect(folder!.active).toBe(false)
    expect(folder!.childrenList).toBe('plain')
    expect(folder!.role).toBe('treeitem')
    expect(folder!.draggable).toBe(true)
    expect(typeof folder!.onClick).toBe('function')
    expect(typeof folder!.onDragStart).toBe('function')
    // The subtree is ALWAYS carried (fold gating belongs to the framework);
    // the append-drop hint is absent while no append is armed.
    expect(folder!.children, 'folder children = the moved-in workspace row').toHaveLength(1)

    // The workspace leaf model: its session list rides the 'layer' variant
    // (the built-in renderGuideLayer/sessionListLayer shape) and the rows
    // carry the folder + workspace guide columns. It hangs under the folder
    // model's children, like the built-in subtree.
    const leaf = (folder!.children as FileTreeNode[])
      .find(node => isRowModel(node) && node.key === 'w-art') as FileTreeRowModel | undefined
    expect(leaf, 'workspace leaf model').toBeDefined()
    expect(leaf!.expanded).toBe(true)
    expect(typeof leaf!.onToggle).toBe('function')
    expect(leaf!.childrenList).toBe('layer')
    expect(leaf!.junction).toBe(true)
    expect(leaf!.indentPx).toBe(16)
    expect(leaf!.guideColumns, 'one column per ancestor folder').toHaveLength(1)
    expect(leaf!.guideColumns![0]!.id).toBe(alpha)
    expect(typeof leaf!.guideColumns![0]!.onToggle).toBe('function')
    expect(leaf!.children!.length, 'both session rows ride the children').toBe(2)

    // The session row model: content slots + DOM passthrough (the values
    // the v1 renderRow call carried, now model fields).
    const sessionModel = (leaf!.children as FileTreeNode[]).find(node => isRowModel(node) && node.key === 's1') as FileTreeRowModel
    expect(sessionModel, 'session row model').toBeDefined()
    expect(sessionModel.expanded).toBeUndefined()
    expect(sessionModel.compact).toBe(true)
    expect(sessionModel.leadingSlotWidth).toBe(16)
    expect(sessionModel.active).toBe(false)
    expect(sessionModel.guideColumns, 'folder column + the workspace own column').toHaveLength(2)
    expect(sessionModel.guideColumns![1]!.id).toBe('w-art')
    expect(sessionModel.role).toBe('treeitem')
    expect(sessionModel.draggable).toBe(true)
    expect(typeof sessionModel.onClick).toBe('function')
    expect(typeof sessionModel.onDragStart).toBe('function')
  })

  it('gates the subtree by expanded in the final DOM (framework fold gate) and reopens cleanly', async () => {
    const props = await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    // Open the session list, then fold the workspace: the framework plays
    // the exit animation and unmounts the children; reopening restores them
    // — no consumer-side conditional rendering, no white screen.
    click(treeRowByText('绘画收集')!)
    expect(sessionRowByText('画布草图'), 'session rows visible while expanded').toBeDefined()
    click(treeRowByText('绘画收集')!)
    expect(instance.getSnapshot().groupExpansion['w-art'], 'row click folds the workspace').toBe(false)
    await settleFold()
    expect(sessionRowByText('画布草图'), 'folded: session rows unmount after the exit animation').toBeUndefined()
    click(treeRowByText('绘画收集')!)
    expect(sessionRowByText('画布草图'), 'reopened: session rows return').toBeDefined()
    click(sessionRowByText('画布草图')!)
    expect(props.open).toHaveBeenCalledWith('s1')
  })

  it('routes the chevron click to onToggle (toggle, stopPropagation — never opens a session)', async () => {
    const props = await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    await rerender()
    const row = treeRowByText('绘画收集')!
    const chevron = chevronOf(row)
    expect(chevron, 'expandable rows carry the framework chevron').not.toBeNull()
    expect(instance.getSnapshot().groupExpansion['w-art'], 'starts collapsed').toBeUndefined()
    click(chevron!)
    expect(instance.getSnapshot().groupExpansion['w-art'], 'chevron toggles the workspace open').toBe(true)
    expect(props.open, 'chevron clicks stop propagation — no session opens').not.toHaveBeenCalled()
    click(chevronOf(treeRowByText('绘画收集')!)!)
    expect(instance.getSnapshot().groupExpansion['w-art'], 'chevron toggles the workspace shut again').toBe(false)
    await settleFold()
    expect(sessionRowByText('画布草图'), 'chevron fold unmounts the session list').toBeUndefined()
  })

  it('lights the ancestor line across rows through the FRAMEWORK-internal seat (consumer holds no seat)', async () => {
    await renderBrowser()
    fileTreeUiSeat = makeFileTreeUiService()
    // Two nested folders + a workspace with an open session list: hovering
    // the folder band must light the SAME column on the session rows below —
    // the seat lives inside the provider's FileTree (the consumer no longer
    // carries GuideHover state or guideHitBands of its own).
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.createFolder(alpha, 'beta') })
    const beta = instance.getSnapshot().folders[alpha]!.folderIds[0]!
    act(() => { instance.actions.moveWorkspaceIn(W('w-art'), beta) })
    act(() => { instance.actions.setFolderExpanded(alpha, true) })
    act(() => { instance.actions.setFolderExpanded(beta, true) })
    await rerender()
    click(treeRowByText('绘画收集')!) // open the session list
    const sessionRow = sessionRowByText('画布草图')!
    expect(sessionRow.style.backgroundImage, 'no hover → no strokes on the layer rows').toBe('')
    // Hover the folder band on the beta row: col 0 = alpha — the session
    // rows' own column 0 is the same alpha stroke, so their line lights up.
    const betaRow = folderRowByText('beta')!
    mouseEnter(betaRow.querySelectorAll<HTMLElement>('[class*="guideHit"]')[0]!)
    expect(sessionRow.style.backgroundImage, 'the framework seat lights the descendant line').toContain(GUIDE_STROKE_HOVER)
    // Moving off the band clears the seat — the descendant stroke returns
    // to its resting state (per-row highlight only, nothing stale).
    act(() => {
      betaRow.querySelectorAll<HTMLElement>('[class*="guideHit"]')[0]!
        .dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(sessionRow.style.backgroundImage, 'seat cleared → descendant line rests').toBe('')
  })
})
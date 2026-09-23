// @vitest-environment jsdom
/**
 * Component spec of the enhanced workspace browser (shadow occupant of
 * `sidebar.workspaces`): real store engine instance, fixture session /
 * workspace snapshots, vi.fn() injected actions; asserts user-visible
 * behavior — the original workspace-collects-sessions interaction and the
 * multi-level folder management on top of it.
 */
import { StrictMode, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: the service fixture seat is typed against the provider's v1
// contract (runtime fixtures are constructed from the real components below
// in file-tree-ui.client.spec.tsx).
import type { FileTreeUiServiceV2 } from 'dsh-file-tree-ui/client-contract'
import { EnhancedWorkspaceBrowser, GUIDE_STROKE_HOVER, guideBackground } from '../src/client/Browser.tsx'
import { SessionHoverContent, WorkspaceHoverContent } from '../src/client/HoverCards.tsx'
import {
  DIRECTORY_FLOW_SLOT,
  SEARCH_GLOBAL_KEY,
  SEARCH_INPUT_SELECTOR,
  SEARCH_RAIL_BUTTON_SELECTOR,
  SEARCH_SLOT,
  commitSearchQueryFromDom,
  searchHandle,
  type EnhancedDirectoryFlowOwnerProps,
  type EnhancedSearchHandle,
  type EnhancedSearchOwnerProps,
  type EnhancedWorkspaceBrowserProps,
  type EnhancedWorkspaceGlobal,
} from '../src/client/contract.ts'
import { ROOT_FOLDER_ID, recentGroupKey, type SessionNode } from '../src/client/model.ts'
import { zh } from '../src/client/locales.ts'
import type { EnhancedWorkspaceState } from '../src/client/store.ts'
import { createEnhancedWorkspaceStore } from '../src/client/store.ts'
import { sessionMention } from '../src/client/reference.ts'

const W = (id: string): WorkspaceId => id as WorkspaceId

/** Fixed "now" for deterministic relative-time labels. */
const NOW = Date.now()

/** One fixture session row (all ordinary user-origin, non-blank). */
function session(id: string, title: string, ageMs: number): SessionSummary {
  return {
    id: id as SessionId,
    displayTitle: title,
    blank: false,
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

/** The drawing-collection workspace with six sessions (overflow control) and one docs workspace. */
const WORKSPACES = [
  workspace('w-art', '绘画收集', ['s1', 's2', 's3', 's4', 's5', 's6']),
  workspace('w-docs', '文档', ['s7']),
]
const SESSIONS_BY_ID: Record<string, SessionSummary> = {
  s1: session('s1', '画布草图', 1000),
  s2: session('s2', '配色研究', 2000),
  s3: session('s3', '构图笔记', 3000),
  s4: session('s4', '笔刷测试', 4000),
  s5: session('s5', '参考图收集', 5000),
  s6: session('s6', '导出脚本', 6000),
  s7: session('s7', 'README 整理', 7000),
}
const SESSIONS_STATE = {
  ids: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'],
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

/**
 * Mutable fixture seats: re-bound before each test and read by the
 * `useWorkspaces` / `useSessions` closures, so a test can swap in a NEW
 * snapshot (immutable update) and re-render to simulate a runtime update —
 * e.g. a session stamp advancing when a new query lands.
 */
let workspacesState: typeof WORKSPACES_STATE = WORKSPACES_STATE
let sessionsState: typeof SESSIONS_STATE = SESSIONS_STATE

/** Directory-flow hole fixture: occupancy of the plugin-owned slot key plus
 *  the recorded owner conversation of every `renderSlot` call. */
let directoryFlowOccupied = false
let flowOwners: EnhancedDirectoryFlowOwnerProps[] = []

/** fileTreeUi v2 service seat fixture: undefined by default (the missing
 *  provider posture → built-in session rows); a spec flips it to a service
 *  fixture and re-renders to exercise the service path. */
let fileTreeUiSeat: FileTreeUiServiceV2 | undefined = undefined

/** Search-hole fixture: the owner object of every search `renderSlot` call,
 *  and the handle the (real) slot inject face would deliver to an occupant. */
let searchOwners: EnhancedSearchOwnerProps[] = []
let searchOccupied = false
/** The search handle captured the way a real external occupant receives it
 *  (slot props); asserted to be the shared contract singleton. */
let capturedSearchHandle: EnhancedSearchHandle | null = null

/** Minimal locale seat over the zh dictionary (the en translation shares the key union). */
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
/** The props of the latest render (re-render with overrides to flip the
 *  shell's fold state, like the real host does). */
let latestProps: EnhancedWorkspaceBrowserProps

/** Render the browser over a fresh real store engine instance. */
async function renderBrowser(
  persistence: EnhancedWorkspaceBrowserProps['persistence'] = defaultPersistence(),
  strict = false,
  wide = true,
): Promise<EnhancedWorkspaceBrowserProps> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  instance = createEnhancedWorkspaceStore().create()
  latestProps = {
    wide,
    expandSidebar: vi.fn(),
    useWorkspaces: (selector: (snapshot: typeof WORKSPACES_STATE) => unknown) => selector(workspacesState),
    useSessions: (selector: (snapshot: typeof SESSIONS_STATE) => unknown) => selector(sessionsState),
    // No fixture session carries a pending interaction: the empty snapshot.
    useSessionPendingInteraction: (selector: (snapshot: ReadonlyMap<string, unknown>) => unknown) => selector(new Map()),
    useStore: (selector: (snapshot: EnhancedWorkspaceState) => unknown) =>
      useSyncExternalStore(instance.store.subscribe, () => selector(instance.store.getSnapshot())),
    actions: instance.actions,
    t,
    useDirectoryFlow: (selector: (occupied: boolean) => unknown) => selector(directoryFlowOccupied),
    useFileTreeUi: (selector: (value: FileTreeUiServiceV2 | undefined) => unknown) => selector(fileTreeUiSeat),
    renderSlot: ((key: string, owner: unknown) => {
      expect([DIRECTORY_FLOW_SLOT, SEARCH_SLOT]).toContain(key)
      if (key === SEARCH_SLOT) {
        // The real slot machinery merges the declaration's common inject face
        // (`EnhancedSearchHandle`) into the occupant's props; the fixture
        // mirrors that by capturing the shared handle — exactly what an
        // external occupant reads.
        searchOwners.push(owner as EnhancedSearchOwnerProps)
        capturedSearchHandle = searchHandle
        return searchOccupied ? <div data-testid="search-occupant" /> : null
      }
      const flowOwner = owner as EnhancedDirectoryFlowOwnerProps
      flowOwners.push(flowOwner)
      // A visible occupant only while the owner requests the interaction —
      // mirroring the real occupant's `if (!open) return null` posture.
      return flowOwner.open ? <div data-testid="flow-marker" /> : null
    }) as unknown as EnhancedWorkspaceBrowserProps['renderSlot'],
    startSession: vi.fn(),
    open: vi.fn(),
    renameSession: vi.fn(async () => undefined),
    forkSession: vi.fn(),
    archiveSession: vi.fn(async () => undefined),
    renameWorkspace: vi.fn(async () => undefined),
    deleteWorkspace: vi.fn(async () => undefined),
    insertWorkspaceBefore: vi.fn(async () => undefined),
    createWorkspace: vi.fn(async () => {
      throw new Error('unused in this spec')
    }),
    pickDirectory: vi.fn(async () => null),
    // Git probe: this spec renders the no-git world (probe unavailable →
    // every git-derived surface falls back to the built-in shape). Git-layer
    // behavior lives in tests/git-model.spec.ts + the git browser spec.
    probeGit: vi.fn(async () => null),
    // Remote markers: absent in this spec (no dsh-remote mirror in the
    // fixture) — the fetch source resolves an empty map.
    remoteGit: {
      fetchMarkers: vi.fn(async () => new Map()),
      refresh: vi.fn(async () => new Map()),
    },
    continueInWorkspace: vi.fn(async () => undefined),
    persistence,
  } as unknown as EnhancedWorkspaceBrowserProps
  await act(async () => {
    const browser = <EnhancedWorkspaceBrowser {...latestProps} />
    root.render(strict ? <StrictMode>{browser}</StrictMode> : browser)
  })
  return latestProps
}

/** Re-render the mounted browser with overridden props (shell fold flip). */
async function rerenderWith(overrides: Partial<EnhancedWorkspaceBrowserProps>): Promise<void> {
  await act(async () => {
    root.render(<EnhancedWorkspaceBrowser {...latestProps} {...overrides} />)
  })
}

/** Inert persistence face: nothing durable stored, saves no-op. */
function defaultPersistence(): EnhancedWorkspaceBrowserProps['persistence'] {
  return { load: vi.fn(async () => null), save: vi.fn(async () => undefined) }
}

/** One row (treeitem) whose text contains `text`, or undefined. */
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

/** One session row under the workspace tree (not the recency section). */
function sessionRowByText(text: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>('[class*="sessionRow"]')]
    .find(row => row.closest('section')?.querySelector('h3')?.textContent !== zh.recents
      && row.textContent?.includes(text))
}

/** One menu item (portal seat) whose text contains `text`, or undefined. */
function menuItemByText(text: string): HTMLElement | undefined {
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent?.includes(text))
}

/** A button (anywhere, including portals) matching its aria-label. */
function buttonByAria(label: string): HTMLButtonElement | undefined {
  return [...document.body.querySelectorAll<HTMLButtonElement>('button')]
    .find(button => button.getAttribute('aria-label') === label)
}

function click(target: Element): void {
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

function typeText(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A native drag event (jsdom ships no DragEvent/DataTransfer; the row
 *  handlers read `clientY` and guard the null dataTransfer). */
function dragEvent(type: string, clientY: number): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as DragEvent
  Object.defineProperty(event, 'clientY', { value: clientY })
  Object.defineProperty(event, 'dataTransfer', { value: null })
  return event
}

/** Stub one row's bounding rect so drop-zone math is deterministic. */
function stubRect(row: HTMLElement, top: number, height: number): void {
  row.getBoundingClientRect = (): DOMRect => ({
    top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top,
    toJSON: () => ({}),
  }) as DOMRect
}

/** Start a drag on a row. */
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

/** Move the pointer onto a band (React's onMouseEnter derives from mouseover). */
function hover(target: Element): void {
  act(() => { target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
}

function treeitemRows(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
}

/** Open the ellipsis menu of a tree row whose label matches `rowText`. */
function openRowMenu(rowText: string): void {
  const row = treeRowByText(rowText)
  expect(row).toBeDefined()
  const menuButton = row!.querySelector<HTMLButtonElement>('button[aria-label]')
  expect(menuButton, `row "${rowText}" should expose its menu button`).toBeDefined()
  click(menuButton!)
}

beforeEach(() => {
  localStorage.clear()
  workspacesState = WORKSPACES_STATE
  sessionsState = SESSIONS_STATE
  directoryFlowOccupied = false
  flowOwners = []
  searchOccupied = false
  searchOwners = []
  capturedSearchHandle = null
  // Default posture: no fileTreeUi provider (missing service) — the browser
  // renders its built-in session rows.
  fileTreeUiSeat = undefined
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { root?.unmount() })
  container?.remove()
  document.body.querySelectorAll('[data-testid]').forEach(node => node.remove())
  // Portal seats (menus/dialogs) mount on document.body; drop them between tests.
  for (const node of [...document.body.children]) {
    if (node !== container) node.remove()
  }
})

describe('enhanced workspace browser', () => {
  it('keeps the built-in workspace behavior: the row collects its sessions (click toggles, plus starts a session, overflow bounds the list)', async () => {
    const props = await renderBrowser()
    // Baseline adoption puts every workspace at the root account.
    expect(treeitemRows().map(row => row.textContent?.trim())).toEqual(
      expect.arrayContaining([expect.stringContaining('绘画收集'), expect.stringContaining('文档')]),
    )
    // Collapsed: no session rows.
    expect(rowByText('画布草图')).toBeUndefined()

    // Clicking the workspace row in the tree expands the collected sessions —
    // it does NOT start a new session (the previous wrong effect), and the
    // recency row for the same workspace keeps its own expansion state.
    click(treeRowByText('绘画收集')!)
    expect(rowByText('画布草图')).toBeDefined()
    expect(rowByText('导出脚本')).toBeUndefined()
    expect(props.startSession).not.toHaveBeenCalled()

    // The overflow control bounds the list at five rows and expands on demand.
    const overflowMore = [...container.querySelectorAll<HTMLElement>('.overflowButton, [class*="overflowButton"]')]
      .find(node => node.textContent?.includes('1'))
    expect(overflowMore, 'overflow row should offer the remaining 1 session').toBeDefined()
    click(overflowMore!)
    expect(rowByText('导出脚本')).toBeDefined()
    const overflowLess = [...container.querySelectorAll<HTMLElement>('[class*="overflowButton"]')]
      .find(node => node.textContent?.includes('收起'))
    click(overflowLess!)
    expect(rowByText('导出脚本')).toBeUndefined()

    // Collapse again: the list hides entirely.
    click(treeRowByText('绘画收集')!)
    expect(rowByText('画布草图')).toBeUndefined()

    // The plus button starts a session in that workspace and opens the row.
    const plus = buttonByAria('在「绘画收集」中新建会话')
    expect(plus).toBeDefined()
    click(plus!)
    expect(props.startSession).toHaveBeenCalledWith('w-art')
    expect(rowByText('画布草图')).toBeDefined()
  })

  it('Cmd/Ctrl+N is the plus-button effect, keyboarded: new session in the current workspace (then the recent workspace, then the plain New Session view) and the group opens', async () => {
    sessionsState = { ...SESSIONS_STATE, current: 's2' as SessionId } as typeof SESSIONS_STATE
    const props = await renderBrowser()

    // s2 属「绘画收集」；先收起该组再按 Cmd+N —— 与行内 + 按钮完全同效：
    // 会话组被展开、startSession 显式带上当前会话所在的工作区。
    click(treeRowByText('绘画收集')!)
    expect(rowByText('画布草图')).toBeUndefined()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }))
    })
    expect(props.startSession).toHaveBeenCalledWith('w-art')
    expect(rowByText('画布草图'), 'Cmd+N opens the workspace group like the plus button').toBeDefined()

    // 没有当前会话时落到第一个列出的工作区（0.1.5-rc.2 起快照不再暴露
    // recentWorkspaceId，Host 顺序的第一个工作区即最近语义；Ctrl+N 同义）——
    // 目标是它的行，同样展开其会话组。
    vi.mocked(props.startSession).mockClear()
    act(() => {
      sessionsState = { ...SESSIONS_STATE, current: undefined }
      workspacesState = {
        ...WORKSPACES_STATE,
        items: [WORKSPACES[1]!, WORKSPACES[0]!], // 文档 排到最前
      } as typeof WORKSPACES_STATE
      root.render(<EnhancedWorkspaceBrowser {...props} />)
    })
    expect(rowByText('README 整理')).toBeUndefined()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true }))
    })
    expect(props.startSession).toHaveBeenCalledWith('w-docs')
    expect(rowByText('README 整理'), 'the recent workspace group opens too').toBeDefined()

    // 既无当前会话也无工作区：无参 startSession（内置 New Session 视图）。
    vi.mocked(props.startSession).mockClear()
    act(() => {
      sessionsState = { ...SESSIONS_STATE, current: undefined }
      workspacesState = { ...WORKSPACES_STATE, items: [] } as typeof WORKSPACES_STATE
      root.render(<EnhancedWorkspaceBrowser {...props} />)
    })
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }))
    })
    expect(props.startSession).toHaveBeenCalledWith()

    // 变体与噪声键不触发：裸 n、Cmd+Shift+N、Cmd+Alt+N、Cmd+J、按键重复。
    vi.mocked(props.startSession).mockClear()
    for (const init of [
      { key: 'n' },
      { key: 'n', metaKey: true, shiftKey: true },
      { key: 'n', metaKey: true, altKey: true },
      { key: 'j', metaKey: true },
    ]) {
      act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true })) })
    }
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true, repeat: true, bubbles: true }))
    })
    expect(props.startSession).not.toHaveBeenCalled()
  })

  it('wraps workspaces into multi-level directories: root folder, subfolder, and a move into the folder', async () => {
    await renderBrowser()

    // Root-level "New folder" icon button (tooltip-seated) opens the input dialog.
    click(buttonByAria('新建目录')!)
    const [dialogInput] = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(input => input.getAttribute('aria-label') === '目录名称')
    expect(dialogInput).toBeDefined()
    typeText(dialogInput!, '产品组')
    click(buttonByAria('确认') ?? [...document.body.querySelectorAll('button')]
      .find(button => button.textContent === '确认')!)

    // The folder row appears at depth 1.
    const folderRow = rowByText('产品组')
    expect(folderRow).toBeDefined()

    // Folder menu → New subfolder nests a second level.
    openRowMenu('产品组')
    click(menuItemByText('新建子目录')!)
    const subInput = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(input => input.getAttribute('aria-label') === '目录名称').at(-1)
    typeText(subInput!, '客户端')
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)

    // The subfolder hides under the collapsed parent and appears once expanded.
    expect(rowByText('客户端')).toBeUndefined()
    click(folderRow!)
    expect(rowByText('客户端')).toBeDefined()

    // Move the docs workspace into 产品组 (menu → move-to picker).
    openRowMenu('文档')
    click(menuItemByText('移动到…')!)
    const topLevelOption = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes('产品组'))
    expect(topLevelOption).toBeDefined()
    click(topLevelOption!)
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)

    // The workspace now renders inside the folder branch, not at the root.
    const nestedDocs = treeRowByText('文档')
    expect(nestedDocs).toBeDefined()
    const folderBranch = nestedDocs!.closest('[class*="folderBranch"]')
    expect(folderBranch, 'docs workspace should live inside the folder branch').toBeDefined()
    expect(folderBranch!.textContent).toContain('产品组')
  })

  it('creates a subfolder straight from the folder-row plus, without toggling the row', async () => {
    await renderBrowser()

    // A collapsed root-level folder to host the subfolder.
    click(buttonByAria('新建目录')!)
    let input = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(field => field.getAttribute('aria-label') === '目录名称').at(-1)
    typeText(input!, '产品组')
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)
    const folderRow = rowByText('产品组')
    expect(folderRow, 'the folder row appears').toBeDefined()
    expect(folderRow!.getAttribute('aria-expanded'), 'new folders start collapsed').toBe('false')

    // The plus sits in the folder row's own action group, tagged for the folder.
    const plus = folderRow!.querySelector<HTMLButtonElement>(
      `button[aria-label="${zh.newSubfolderAria.replace('{name}', '产品组')}"]`,
    )
    expect(plus, 'the folder row exposes the new-subfolder plus').toBeDefined()
    click(plus!)

    // The same in-place dialog the menu's "新建子目录" opens: folder-name input.
    input = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(field => field.getAttribute('aria-label') === '目录名称').at(-1)
    expect(input, 'the row plus opens the create-subfolder dialog').toBeDefined()
    typeText(input!, '客户端')
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)

    // The plus click stops propagation: the collapsed folder stays collapsed,
    // and its new child hides under it until expanded.
    expect(folderRow!.getAttribute('aria-expanded'), 'clicking the plus does not fold the row').toBe('false')
    expect(rowByText('客户端'), 'the subfolder hides under the collapsed parent').toBeUndefined()
    click(folderRow!)
    expect(rowByText('客户端'), 'the subfolder lands inside the folder').toBeDefined()
  })

  it('deleting a folder promotes its workspaces back to the top level', async () => {
    const props = await renderBrowser()
    // Create 归档 at the root, move 绘画收集 into it.
    click(buttonByAria('新建目录')!)
    const input = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(field => field.getAttribute('aria-label') === '目录名称').at(-1)
    typeText(input!, '归档')
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)

    openRowMenu('绘画收集')
    click(menuItemByText('移动到…')!)
    click([...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes('归档'))!)
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)
    // The leaf hides under the collapsed folder; expand to verify the move.
    click(rowByText('归档')!)
    expect(treeRowByText('绘画收集')!.closest('[class*="folderBranch"]')?.textContent).toContain('归档')

    // Delete the folder: the confirmation dialog names the promotion parent.
    openRowMenu('归档')
    click(menuItemByText('删除目录')!)
    const dialogText = document.body.textContent ?? ''
    expect(dialogText).toContain('其中的工作区与子目录将上移到「（顶层）」')
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '删除')!)

    // Promoted: the workspace is a root leaf again, the folder is gone.
    expect(rowByText('归档')).toBeUndefined()
    expect(treeRowByText('绘画收集')).toBeDefined()
    expect(treeRowByText('绘画收集')!.closest('[class*="folderBranch"]')).toBeNull()
  })

  it('workspace delete confirm commits the host delete and closes the dialog (regression: dead confirm button)', async () => {
    const props = await renderBrowser()

    // Row menu → 删除工作区 opens the browser's confirm dialog.
    openRowMenu('绘画收集')
    click(menuItemByText('删除工作区')!)
    const dialog = [...document.body.querySelectorAll<HTMLElement>('[role="dialog"]')].at(-1)
    expect(dialog, 'confirm dialog should open').toBeDefined()

    // Confirm via the footer's danger button. Before the fix, the seat's
    // confirm closure captured the PRE-dialog `deleteWorkspaceTarget` (null)
    // forever, so this click silently did nothing: no host call, no busy
    // latch, no error, dialog stayed open — the reported "删除不了" hang.
    const confirmButton = [...dialog!.querySelectorAll('button')]
      .find(button => button.textContent === '删除工作区')
    expect(confirmButton, 'danger confirm button').toBeDefined()
    click(confirmButton!)

    // The host delete fires exactly once, for the row's workspace id.
    expect(props.deleteWorkspace).toHaveBeenCalledTimes(1)
    expect(props.deleteWorkspace).toHaveBeenCalledWith(W('w-art'))

    // The resolved delete closes the dialog (microtask flush inside act).
    await act(async () => { await Promise.resolve() })
    expect(document.querySelector('[role="dialog"]'), 'dialog closes after the committed delete').toBeNull()
  })

  it('renders recency rows as workspace-style rows: capped at five, expandable, and count-free', async () => {
    // Six dirs total — the recency section must show exactly the five most
    // recent ones; the sixth stays in the tree below the bottom border.
    workspacesState = {
      ...WORKSPACES_STATE,
      items: [
        ...WORKSPACES,
        workspace('w-x1', '甲组', []),
        workspace('w-x2', '乙组', []),
        workspace('w-x3', '丙组', []),
        workspace('w-x4', '丁组', []),
      ],
    }
    await renderBrowser()
    const section = container.querySelector('section')
    expect(section, 'recency section should render with workspaces present').toBeDefined()
    const recentRows = [...section!.querySelectorAll<HTMLElement>('[class*="workspaceRow"]')]
    expect(recentRows.length).toBe(5)
    expect(recentRows[0]!.textContent).toContain('绘画收集')
    expect(section!.querySelector('[role="treeitem"]')!.getAttribute('aria-expanded')).toBe('false')
    expect(section!.querySelector('[class*="rowCount"]'), 'recency rows carry no session-count badge').toBeNull()
    expect(section!.querySelector('[class*="rowTime"]'), 'recency rows show no relative time either (stamps stay in the store)').toBeNull()

    // A recency row expands its session list exactly like an original
    // workspace row — but with its OWN expansion memory: the tree row for
    // the same workspace stays collapsed (no open/close linkage).
    expect(section!.querySelector('[class*="sessionRow"]')).toBeNull()
    click(recentRows[0]!)
    const expandedSession = [...section!.querySelectorAll<HTMLElement>('[class*="sessionRow"]')]
      .find(row => row.textContent?.includes('画布草图'))
    expect(expandedSession, 'recency row expands the workspace session list').toBeDefined()
    expect(treeRowByText('绘画收集')!.getAttribute('aria-expanded')).toBe('false')
  })

  it('collapses each section from its own header: the all-button folds folders and tree rows only, the recents-button only the recency rows', async () => {
    await renderBrowser()
    // A folder holding the art workspace.
    click(buttonByAria('新建目录')!)
    const input = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(field => field.getAttribute('aria-label') === '目录名称').at(-1)
    typeText(input!, '产品组')
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)
    openRowMenu('绘画收集')
    click(menuItemByText('移动到…')!)
    click([...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes('产品组'))!)
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)

    // Expand everything: the folder (reveals the nested workspace), the tree
    // workspace's session list, and the recency row's own session list.
    click(rowByText('产品组')!)
    expect(treeRowByText('绘画收集'), 'nested workspace reveals once the folder opens').toBeDefined()
    click(treeRowByText('绘画收集')!)
    expect(sessionRowByText('画布草图'), 'tree workspace row expands its session list').toBeDefined()
    const recencySection = [...container.querySelectorAll('section')]
      .find(section => section.querySelector('h3')?.textContent === zh.recents)!
    click([...recencySection.querySelectorAll<HTMLElement>('[class*="workspaceRow"]')][0]!)
    expect(recencySection.querySelector('[class*="sessionRow"]')).not.toBeNull()

    // The collapse icon button sits in BOTH section headers.
    const allSection = [...container.querySelectorAll('section')]
      .find(section => section.querySelector('h3')?.textContent === zh.all)!
    const allCollapse = [...allSection.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.getAttribute('aria-label') === zh.collapseAll)
    expect(allCollapse, 'collapse-all button sits beside the new-folder action').toBeDefined()
    const recentsCollapse = [...recencySection.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.getAttribute('aria-label') === zh.collapseAll)
    expect(recentsCollapse, 'collapse-all button sits in the recents header too').toBeDefined()

    // The "all" header's button folds only its own section: the folder and
    // the tree session rows collapse, while the recency rows stay open.
    click(allCollapse!)
    expect(sessionRowByText('画布草图'), 'tree session rows fold back').toBeUndefined()
    expect(rowByText('产品组')!.getAttribute('aria-expanded')).toBe('false')
    // The nested workspace row is hidden again under the collapsed folder;
    // the tree itself keeps the membership intact.
    expect(treeRowByText('绘画收集'), 'workspace hides with its collapsed folder').toBeUndefined()
    expect(recencySection.querySelector('[class*="sessionRow"]'), 'recency rows keep their expansion').not.toBeNull()
    const folderId = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    expect(instance.getSnapshot().folders[folderId]?.workspaceIds).toContain(W('w-art'))
    expect(instance.getSnapshot().folderExpansion).toEqual({})
    expect(instance.getSnapshot().groupExpansion).toEqual({ [recentGroupKey(W('w-art'))]: true })

    // The recents header's button then folds only the recency rows; the
    // already-collapsed tree stays untouched.
    click(recentsCollapse!)
    expect(recencySection.querySelector('[class*="sessionRow"]'), 'recency rows fold on their own button').toBeNull()
    expect(instance.getSnapshot().groupExpansion).toEqual({})
  })

  it('collapses both modules from the browser header button: recency rows and the workspace list fold together', async () => {
    await renderBrowser()
    // A folder holding the art workspace.
    click(buttonByAria('新建目录')!)
    const input = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(field => field.getAttribute('aria-label') === '目录名称').at(-1)
    typeText(input!, '产品组')
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)
    openRowMenu('绘画收集')
    click(menuItemByText('移动到…')!)
    click([...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes('产品组'))!)
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)

    // Expand everything: the folder (reveals the nested workspace), the tree
    // workspace's session list, and the recency row's own session list.
    click(rowByText('产品组')!)
    expect(treeRowByText('绘画收集'), 'nested workspace reveals once the folder opens').toBeDefined()
    click(treeRowByText('绘画收集')!)
    expect(sessionRowByText('画布草图'), 'tree workspace row expands its session list').toBeDefined()
    const recencySection = [...container.querySelectorAll('section')]
      .find(section => section.querySelector('h3')?.textContent === zh.recents)!
    click([...recencySection.querySelectorAll<HTMLElement>('[class*="workspaceRow"]')][0]!)
    expect(recencySection.querySelector('[class*="sessionRow"]')).not.toBeNull()

    // The browser header carries its own collapse-all button (beside the
    // view-options and add actions).
    const headerCollapse = buttonByAria(zh.collapseEverything)
    expect(headerCollapse, 'collapse-all button sits in the browser header').toBeDefined()

    // One click folds BOTH modules: recency rows and the workspace list.
    click(headerCollapse!)
    expect(recencySection.querySelector('[class*="sessionRow"]'), 'recency rows fold with the header button').toBeNull()
    expect(sessionRowByText('画布草图'), 'tree session rows fold too').toBeUndefined()
    expect(rowByText('产品组')!.getAttribute('aria-expanded')).toBe('false')
    expect(treeRowByText('绘画收集'), 'workspace hides with its collapsed folder').toBeUndefined()
    expect(instance.getSnapshot().folderExpansion).toEqual({})
    expect(instance.getSnapshot().groupExpansion).toEqual({})
  })

  it('refreshes the recency stamp only when a new query lands; browsing gestures never touch', async () => {
    const props = await renderBrowser()
    // Mount baseline-seeds the observer: no query has been sent, no stamps.
    expect(instance.getSnapshot().recentTouchById).toEqual({})

    // Browsing gestures — expanding a row, starting a session, opening a
    // session — never refresh the recency stamp.
    click(treeRowByText('绘画收集')!)
    click(buttonByAria('在「绘画收集」中新建会话')!)
    const artSessionRow = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .find(row => row.textContent?.includes('画布草图'))
    click(artSessionRow!)
    expect(props.open).toHaveBeenCalledWith('s1')
    expect(instance.getSnapshot().recentTouchById).toEqual({})

    // A new query in w-art: the session stamp advances → the workspace gets
    // its recency stamp (w-docs, untouched by the query, stays unstamped).
    act(() => {
      sessionsState = {
        ...sessionsState,
        byId: {
          ...sessionsState.byId,
          s1: { ...sessionsState.byId['s1']!, updatedAt: NOW },
        },
      }
      root.render(<EnhancedWorkspaceBrowser {...props} />)
    })
    expect(instance.getSnapshot().recentTouchById['w-art']).toBeGreaterThan(0)
    expect(instance.getSnapshot().recentTouchById['w-docs']).toBeUndefined()
  })

  it('renders the built-in status presentation: the loading dot on the running session and dir-level sync on its workspace', async () => {
    // 本会话 = s1（绘画收集 工作区的会话）且正在运行；s2 已完成；s8 空闲。
    const byId = {
      ...SESSIONS_BY_ID,
      s1: { ...SESSIONS_BY_ID['s1']!, running: true, completed: false },
      s8: { ...SESSIONS_BY_ID['s1']!, id: 's8' as SessionId, displayTitle: '空闲会话', running: false, completed: false },
    }
    sessionsState = {
      ...SESSIONS_STATE,
      current: 's1' as SessionId,
      ids: [...SESSIONS_STATE.ids, 's8' as SessionId],
      byId,
    } as typeof SESSIONS_STATE
    // 空闲会话挂进 w-art，才能与树行一起渲染。
    workspacesState = {
      ...WORKSPACES_STATE,
      items: [
        { ...WORKSPACES[0]!, sessionIds: [...WORKSPACES[0]!.sessionIds, 's8' as SessionId] },
        WORKSPACES[1]!,
      ],
    } as typeof WORKSPACES_STATE
    await renderBrowser()

    // 本会话正 loading：s1 行显示 ongoing 像素追逐点 + 屏幕阅读器文案；
    // dir 级同步：含本会话的「绘画收集」行图标点亮（最近行虽未展开，同样
    // 点亮——收起不熄灭，踪迹靠逐层标记读出）。
    const artRow = treeRowByText('绘画收集')!
    expect(artRow.getAttribute('aria-expanded')).toBe('true') // first-encounter expansion
    expect(artRow.querySelector('[class*="folderActive"]'), 'workspace holding the current session lights its glyph').not.toBeNull()
    expect(artRow.className, 'the workspace holding the current session carries the current-session wash').toContain('workspaceRowCurrent')
    const recencySection = [...container.querySelectorAll('section')]
      .find(section => section.querySelector('h3')?.textContent === zh.recents)
    expect(recencySection?.querySelector('[class*="folderActive"]'), 'the collapsed recency row holding the current session keeps its glyph lit').not.toBeNull()
    expect(recencySection?.querySelector('[class*="workspaceRowCurrent"]'), 'the collapsed recency row keeps its wash on').not.toBeNull()
    const sessionRowOf = (text: string): HTMLElement =>
      [...container.querySelectorAll<HTMLElement>('[class*="sessionRow"]')]
        .find(row => row.closest('section')?.querySelector('h3')?.textContent !== zh.recents
          && row.textContent?.includes(text))!
    const runningRow = sessionRowOf('画布草图') // s1
    expect(runningRow.querySelector('[data-state="ongoing"]'), 'running session shows the loading dot').not.toBeNull()
    expect(runningRow.className, 'the viewer-open session row carries the wash').toContain('sessionRowCurrent')
    expect(runningRow.textContent).toContain('运行中')
    expect(sessionRowOf('配色研究').querySelector('[data-state="done"]'), 'completed session shows the done dot').not.toBeNull()
    expect(sessionRowOf('配色研究').className, 'other session rows keep their plain surface').not.toContain('sessionRowCurrent')
    expect(sessionRowOf('空闲会话').querySelector('[data-state]'), 'idle sessions show no dot').toBeNull()
  })

  it('annotates a sandbox-escalation approval on the session row: amber dot + shield mark + its own status text; plain approvals keep the unadorned row', async () => {
    // s1 的待批审批是提权审批（approveEscalation 的 reason 前缀），s2 是普通
    // 审批 —— DSH 行模型对两者只给同一个 amber 等待点，提权标注是本浏览器的
    // 增强：盾牌 + 专属状态文案，落在行与 hover 卡上。
    await renderBrowser()
    const pending = new Map<SessionId, SessionPendingInteraction>([
      ['s1' as SessionId, { key: 'approval:1', kind: 'approval', sessionId: 's1' as SessionId, reason: 'escalate sandbox to workspace-write: 测试' }],
      ['s2' as SessionId, { key: 'approval:2', kind: 'approval', sessionId: 's2' as SessionId }],
    ])
    act(() => {
      root.render(
        <EnhancedWorkspaceBrowser {...latestProps} useSessionPendingInteraction={selector => selector(pending)} />,
      )
    })
    // 无当前会话时工作区行默认收起：先展开「绘画收集」，会话行才进 DOM。
    const artRow = treeRowByText('绘画收集')
    expect(artRow).toBeDefined()
    click(artRow!)

    const escalated = sessionRowByText('画布草图')! // s1
    expect(escalated.querySelector('[data-state="warning"]'), 'the elevation waits on the same amber dot as any approval').not.toBeNull()
    const mark = escalated.querySelector('[class*="escalationMark"]')
    expect(mark, 'the row carries the dedicated shield mark').not.toBeNull()
    expect(mark!.getAttribute('title'), 'the mark tooltip names the elevation').toBe(zh.sessionStatusEscalation)
    expect(escalated.textContent, 'the row status text names the elevation, not the generic wait').toContain(zh.sessionStatusEscalation)

    const plain = sessionRowByText('配色研究')! // s2
    expect(plain.querySelector('[data-state="warning"]'), 'a plain approval keeps the built-in amber dot').not.toBeNull()
    expect(plain.querySelector('[class*="escalationMark"]'), 'plain approvals carry no shield').toBeNull()
    expect(plain.textContent, 'the plain approval keeps the generic waiting-status text').toContain('等待处理')

    // hover 卡：提权审批列出专属状态行（同款 amber 点）。
    const holder = document.createElement('div')
    document.body.appendChild(holder)
    const hoverRoot = createRoot(holder)
    await act(async () => {
      hoverRoot.render(
        <SessionHoverContent
          node={{
            id: 's1' as SessionId,
            current: false,
            title: '画布草图',
            blank: false,
            pendingInteraction: 'escalation',
            running: false,
            runningSubagentCount: 0,
            completed: false,
            updatedAt: NOW,
            recentInputs: [],
            recentOutputs: [],
          }}
          now={NOW}
          t={t}
        />,
      )
    })
    expect(holder.textContent).toContain(zh.sessionStatusEscalation)
    expect(holder.querySelector('[data-state="warning"]'), 'the card status line carries the amber dot').not.toBeNull()
    await act(async () => { hoverRoot.unmount() })
    holder.remove()
  })

  it('marks a collapsed workspace with its hidden sessions\' top status dot: working loading / completed green; the hover card spells every count', async () => {
    // s1（绘画收集 的会话）正在运行；其余已完成；文档工作区 s7 已完成。
    // 无「当前会话」——这个标记与 current 无关，只跟「收起 && 内部有会话
    // 状态」挂钩。
    sessionsState = {
      ...SESSIONS_STATE,
      byId: {
        ...SESSIONS_BY_ID,
        s1: { ...SESSIONS_BY_ID['s1']!, running: true, completed: false },
      },
    } as typeof SESSIONS_STATE
    await renderBrowser()

    // 收起（无当前会话时是默认态）即显示标记点——不依赖 hover，占操作
    // 按钮槽位的尾端。
    let artRow = treeRowByText('绘画收集')!
    expect(artRow.getAttribute('aria-expanded')).toBe('false')
    let busy = artRow.querySelector('[class*="rowBusy"]')
    expect(busy, 'collapsed dir with a working session carries the loading dot').not.toBeNull()
    expect(busy!.querySelector('[data-state="ongoing"]'), 'it is the session rows\' own pixel-chase loading dot').not.toBeNull()
    expect(busy!.getAttribute('title'), 'the dot carries the working-count label').toBe('1 个会话正在工作')
    expect(busy!.textContent, 'screen-reader copy matches the title').toContain('1 个会话正在工作')
    // 只有已完成会话的工作区（文档，s7 已完成）收起时带绿点。
    const docsBusy = treeRowByText('文档')!.querySelector('[class*="rowBusy"]')
    expect(docsBusy, 'collapsed workspace with only completed sessions carries the green done dot').not.toBeNull()
    expect(docsBusy!.querySelector('[data-state="done"]'), 'completed sub-sessions reflect the green dot').not.toBeNull()
    expect(docsBusy!.getAttribute('title')).toBe('1 个会话已完成')

    // 展开会话列表：标记点退场（会话行自己的点在场）。
    click(artRow)
    artRow = treeRowByText('绘画收集')!
    expect(artRow.getAttribute('aria-expanded')).toBe('true')
    expect(artRow.querySelector('[class*="rowBusy"]'), 'expanded dir: the session rows carry the dots').toBeNull()

    // 再收起：点回来，且一直跟着状态走。
    click(artRow)
    artRow = treeRowByText('绘画收集')!
    expect(artRow.getAttribute('aria-expanded')).toBe('false')
    expect(artRow.querySelector('[class*="rowBusy"]'), 'recollapsed dir regains the dot').not.toBeNull()

    // hover 二选一：点让位给操作按钮（菜单 + 新建），点直接消失。
    hover(artRow)
    artRow = treeRowByText('绘画收集')!
    expect(artRow.querySelector('[class*="rowBusy"]'), 'hover swaps the dot out for the action buttons').toBeNull()
    expect(artRow.querySelectorAll('button[aria-label*="绘画收集"]').length, 'the revealed row actions occupy the freed slot').toBeGreaterThan(0)
    // 离开后点回来。
    act(() => {
      artRow.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    })
    expect(treeRowByText('绘画收集')!.querySelector('[class*="rowBusy"]'), 'leaving the row restores the dot').not.toBeNull()

    // s1 也变为已完成：工作态的点换成绿色完成点（w-art 全体完成）。
    act(() => {
      sessionsState = {
        ...sessionsState,
        byId: {
          ...sessionsState.byId,
          s1: { ...SESSIONS_BY_ID['s1']!, running: false, completed: true },
        },
      } as typeof SESSIONS_STATE
      root.render(<EnhancedWorkspaceBrowser {...latestProps} />)
    })
    const doneBusy = treeRowByText('绘画收集')!.querySelector('[class*="rowBusy"]')
    expect(doneBusy, 'an all-completed collapsed dir keeps the done dot').not.toBeNull()
    expect(doneBusy!.querySelector('[data-state="ongoing"]'), 'no loading dot once nothing works').toBeNull()
    expect(doneBusy!.querySelector('[data-state="done"]'), 'the green done dot takes over').not.toBeNull()
    expect(doneBusy!.getAttribute('title')).toBe('6 个会话已完成')

    // 工作区 hover 卡（卡片组件级，HoverCard 壳是 ui-primitives 行为）：
    // 每个非零计数一条状态行 + 对应颜色的点。
    const holder = document.createElement('div')
    document.body.appendChild(holder)
    const hoverRoot = createRoot(holder)
    await act(async () => {
      hoverRoot.render(
        <WorkspaceHoverContent label="绘画收集" cwd="/projects/w-art" createdAt={0} t={t} status={{ ongoing: 1 }} />,
      )
    })
    expect(holder.textContent).toContain('1 个会话正在工作')
    expect(holder.querySelector('[data-state="ongoing"]'), 'the card status line carries the loading dot').not.toBeNull()
    // 完成 + 工作并存：绿点状态行一起列出（工作优先在前）。
    await act(async () => {
      hoverRoot.render(
        <WorkspaceHoverContent label="绘画收集" cwd="/projects/w-art" createdAt={0} t={t} status={{ ongoing: 1, done: 2 }} />,
      )
    })
    expect(holder.textContent).toContain('2 个会话已完成')
    expect(holder.querySelector('[data-state="done"]'), 'the card status line carries the green done dot').not.toBeNull()
    await act(async () => { hoverRoot.unmount() })
    holder.remove()
  })

  it('marks every collapsed ancestor dir on the path to the current session, level by level', async () => {
    // 本会话 = s1（绘画收集 的会话）；把工作区挪进根目录「产品组」。
    sessionsState = { ...SESSIONS_STATE, current: 's1' as SessionId } as typeof SESSIONS_STATE
    await renderBrowser()
    click(buttonByAria('新建目录')!)
    const input = [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .filter(field => field.getAttribute('aria-label') === '目录名称').at(-1)
    typeText(input!, '产品组')
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)
    openRowMenu('绘画收集')
    click(menuItemByText('移动到…')!)
    click([...document.body.querySelectorAll<HTMLElement>('[role="option"]')]
      .find(option => option.textContent?.includes('产品组'))!)
    click([...document.body.querySelectorAll('button')].find(button => button.textContent === '确认')!)

    // 目录收起：工作区行连同会话行全部隐藏，但目录行本身仍带当前会话标记
    // （wash + 图标点亮）——会话被收起时，father dir 逐层标记不熄灭。
    const folderRow = treeRowByText('产品组')!
    expect(folderRow.getAttribute('aria-expanded')).toBe('false')
    expect(treeRowByText('绘画收集'), 'workspace hides under the collapsed folder').toBeUndefined()
    expect(sessionRowByText('画布草图'), 'the session hides with the workspace').toBeUndefined()
    expect(folderRow.className, 'the collapsed ancestor folder keeps the current-session wash').toContain('folderRowCurrent')
    expect(folderRow.querySelector('[class*="folderActive"]'), 'the collapsed ancestor folder keeps its glyph lit').not.toBeNull()

    // 展开目录，再收起工作区自己的会话列表：工作区行现身但会话行隐藏，该行
    // 仍带着标记——收起的是「会话」本身，标记留在父亲行上。
    click(folderRow)
    click(treeRowByText('绘画收集')!)
    expect(rowByText('画布草图'), 'collapsed session list hides the rows').toBeUndefined()
    const artRow = treeRowByText('绘画收集')!
    expect(artRow.getAttribute('aria-expanded')).toBe('false')
    expect(artRow.className, 'the collapsed workspace row keeps the current-session wash').toContain('workspaceRowCurrent')
    expect(artRow.querySelector('[class*="folderActive"]'), 'the collapsed workspace row keeps its glyph lit').not.toBeNull()

    // 展开会话列表：当前会话行才现身，带着自己的 wash。
    click(artRow)
    expect(sessionRowByText('画布草图')!.className, 'the viewer-open session row carries the wash').toContain('sessionRowCurrent')
  })

  it('exports typed workspace and session references for the chat composer', async () => {
    await renderBrowser()
    const workspaceRow = treeRowByText('绘画收集')!
    if (workspaceRow.getAttribute('aria-expanded') !== 'true') click(workspaceRow)
    const sessionRow = sessionRowByText('画布草图')!
    // The workspace drag references its primary session (current, else the
    // most recent member — s1 here, fixture current is undefined) under the
    // workspace title; the session drag references the session itself.
    const expected: Record<string, Record<string, unknown>> = {
      workspace: {
        version: 1, kind: 'workspace', id: 'w-art', label: '绘画收集', sessionId: 's1',
        mention: sessionMention('s1', '绘画收集'),
      },
      session: {
        version: 1, kind: 'session', id: 's1', label: '画布草图',
        mention: sessionMention('s1', '画布草图'),
      },
    }
    for (const [row, kind, id, effect] of [[workspaceRow, 'workspace', 'w-art', 'copyMove'], [sessionRow, 'session', 's1', 'copy']] as const) {
      const data = new Map<string, string>()
      const transfer = { effectAllowed: '', setData: (key: string, value: string) => data.set(key, value) }
      const event = new Event('dragstart', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'dataTransfer', { value: transfer })
      act(() => { row.dispatchEvent(event) })
      expect(row.draggable).toBe(true)
      expect(JSON.parse(data.get('application/x-dsh-reference+json')!)).toEqual(expected[kind])
      expect(data.get('text/plain'), 'the drop payload is the canonical mention, never a raw id').toBe(expected[kind].mention as string)
      expect(transfer.effectAllowed).toBe(effect)
      act(() => { row.dispatchEvent(dragEvent('dragend', 0)) })
    }
  })

  it('drags a workspace onto a folder row: the drop moves it into that folder (appended)', async () => {
    await renderBrowser()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, '产品组') })
    const folderRow = treeRowByText('产品组')!
    const sourceRow = treeRowByText('绘画收集')!
    stubRect(folderRow, 0, 48)

    dragStart(sourceRow)
    dragOver(folderRow, 24) // mid band → 'on'
    expect(folderRow.matches('[class*="dropOn"]'), 'folder target shows the move-into highlight').toBe(true)
    dropOn(folderRow, 24)

    const team = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    expect(instance.getSnapshot().folders[team]?.workspaceIds).toEqual([W('w-art')])
    expect(instance.getSnapshot().folders[ROOT_FOLDER_ID]?.workspaceIds).toEqual([W('w-docs')])
  })

  it('drags a workspace to a folder row\'s TOP EDGE: the drop anchors it at the OUTER level, not inside', async () => {
    await renderBrowser()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, '产品组') })
    const team = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.moveWorkspaceIn(W('w-art'), team) })
    act(() => { instance.actions.setFolderExpanded(team, true) }) // reveal the nested workspace row
    const folderRow = treeRowByText('产品组')!
    const sourceRow = treeRowByText('绘画收集')!
    stubRect(folderRow, 0, 48)

    dragStart(sourceRow)
    dragOver(folderRow, 8) // above the mid band → 'before' (the gap above the folder row)
    expect(folderRow.matches('[class*="dropBefore"]')).toBe(false)
    const hint = container.querySelector('[role="status"]')!
    expect(hint.textContent).toBe('移至顶层工作区末尾')
    expect(hint.parentElement!.contains(treeRowByText('文档')!)).toBe(true)
    expect(hint.parentElement!.contains(folderRow)).toBe(false)
    expect(hint.parentElement!.lastElementChild).toBe(hint)
    dropOn(folderRow, 8)

    // The workspace lands in the folder's PARENT account (外层), not inside.
    expect(new Set(instance.getSnapshot().folders[ROOT_FOLDER_ID]!.workspaceIds))
      .toEqual(new Set([W('w-art'), W('w-docs')]))
    expect(instance.getSnapshot().folders[team]?.workspaceIds, 'the folder itself stays empty').toEqual([])
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it.each([false, true])('previews the parent workspace append position (empty: %s)', async (empty) => {
    await renderBrowser()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, '父目录') })
    const parent = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => {
      instance.actions.createFolder(parent, '子目录')
      instance.actions.setFolderExpanded(parent, true)
      if (!empty) instance.actions.moveWorkspaceIn(W('w-docs'), parent)
    })
    const childRow = treeRowByText('子目录')!
    const source = treeRowByText('绘画收集')!
    stubRect(childRow, 0, 48)
    dragStart(source)
    dragOver(childRow, 8)
    expect(childRow.matches('[class*="dropBefore"]')).toBe(false)
    const hint = container.querySelector('[role="status"]')!
    expect(hint.textContent).toBe('移至『父目录』的工作区末尾')
    const region = hint.parentElement!
    expect(region.contains(childRow)).toBe(false)
    expect(region.lastElementChild).toBe(hint)
    expect(region.contains(treeRowByText('文档')!)).toBe(!empty)
    dropOn(childRow, 8)
    expect(instance.getSnapshot().folders[parent]!.workspaceIds)
      .toEqual(empty ? [W('w-art')] : [W('w-docs'), W('w-art')])
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('clears the append preview on drag end and keeps folder reorder lines', async () => {
    await renderBrowser()
    act(() => {
      instance.actions.createFolder(ROOT_FOLDER_ID, '甲目录')
      instance.actions.createFolder(ROOT_FOLDER_ID, '乙目录')
    })
    const target = treeRowByText('乙目录')!
    const source = treeRowByText('绘画收集')!
    stubRect(target, 0, 48)
    dragStart(source)
    dragOver(target, 8)
    expect(container.querySelector('[role="status"]')).not.toBeNull()
    act(() => { source.dispatchEvent(dragEvent('dragend', 0)) })
    expect(container.querySelector('[role="status"]')).toBeNull()
    dragStart(treeRowByText('甲目录')!)
    dragOver(target, 8)
    expect(target.matches('[class*="dropBefore"]')).toBe(true)
    expect(container.querySelector('[role="status"]')).toBeNull()
  })

  it('drags a workspace before another workspace row: anchored insert inside the same folder', async () => {
    const props = await renderBrowser()
    const docs = treeRowByText('文档')!
    const art = treeRowByText('绘画收集')!
    stubRect(art, 0, 48)

    dragStart(docs)
    dragOver(art, 10) // above the midpoint → 'before'
    expect(art.matches('[class*="dropBefore"]'), 'workspace target shows the anchor line').toBe(true)
    dropOn(art, 10)

    expect(instance.getSnapshot().folders[ROOT_FOLDER_ID]?.workspaceIds).toEqual([W('w-docs'), W('w-art')])
    expect(props.startSession).not.toHaveBeenCalled()
  })

  it('guards folder drops: a cycle into its own descendant fails non-fatally and the tree stays', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await renderBrowser()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.createFolder(alpha, 'beta') })
    click(treeRowByText('alpha')!) // expand alpha so beta renders
    const alphaRow = treeRowByText('alpha')!
    const betaRow = treeRowByText('beta')!
    stubRect(betaRow, 0, 48)

    dragStart(alphaRow)
    dragOver(betaRow, 24) // 'on' → moving alpha under its own descendant
    dropOn(betaRow, 24)

    const after = instance.getSnapshot().folders
    expect(after[alpha]?.folderIds).toHaveLength(1) // beta still under alpha
    expect(after[ROOT_FOLDER_ID]?.folderIds).toEqual([alpha])
    expect(warn, 'the cycle guard warns non-fatally').toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('search: in-place filter of the original dirs list', () => {
  /** The region's `type="search"` input. */
  const searchInput = (): HTMLInputElement =>
    [...document.body.querySelectorAll<HTMLInputElement>('input')]
      .find(input => input.type === 'search')!

  /** The region's section blocks (recents + all), in render order. */
  const sections = (): HTMLElement[] => [...container.querySelectorAll('section')]

  it('dir-level match: the tree filters in place, the recency section hides, and clearing restores everything', async () => {
    const props = await renderBrowser()
    const input = searchInput()
    expect(input.placeholder).toBe(zh.searchPlaceholder)
    expect(sections()).toHaveLength(2) // recents + all (seeded workspaces are recent by creation)

    typeText(input, '文档')
    // No results surface: the SAME tree renders, filtered — recency is gone,
    // the non-matching dir hides, the matching dir stays.
    expect(sections()).toHaveLength(1)
    expect(sections()[0]!.querySelector('h3')?.textContent).toBe(zh.all)
    expect(treeRowByText('绘画收集')).toBeUndefined()
    expect(treeRowByText('文档')).toBeDefined()

    // Clearing the query restores the full list including the recency module.
    typeText(input, '')
    expect(sections()).toHaveLength(2)
    expect(treeRowByText('绘画收集')).toBeDefined()
    expect(treeRowByText('文档')).toBeDefined()
  })

  it('session-level match keeps the owning dir visible, and the row still expands to its sessions', async () => {
    await renderBrowser()
    typeText(searchInput(), '构图')
    expect(treeRowByText('绘画收集'), 'the dir holding the matching session stays').toBeDefined()
    expect(treeRowByText('文档'), 'non-matching dirs hide').toBeUndefined()
    // The kept row behaves like the original: clicking expands its sessions.
    click(treeRowByText('绘画收集')!)
    expect(sessionRowByText('构图笔记')).toBeDefined()
    expect(sessionRowByText('配色研究')).toBeDefined()
    expect(treeRowByText('绘画收集')!.getAttribute('aria-expanded')).toBe('true')
  })

  it('a match inside a subfolder keeps the folder path and opens it', async () => {
    await renderBrowser()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, '产品组') })
    const team = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.moveWorkspaceIn(W('w-art'), team) })
    typeText(searchInput(), '画布草图') // session title inside w-art
    const folderRow = treeRowByText('产品组')
    expect(folderRow, 'the folder path of a match stays').toBeDefined()
    expect(folderRow!.getAttribute('aria-expanded'), 'folders holding a match open').toBe('true')
    expect(treeRowByText('绘画收集')).toBeDefined()
    expect(treeRowByText('文档'), 'sibling dirs hide').toBeUndefined()
    expect(sessionRowByText('README 整理'), 'the sibling dir‘s sessions are gone too').toBeUndefined()
  })

  it('a query matching nothing shows the no-match hint instead of a blank area', async () => {
    await renderBrowser()
    typeText(searchInput(), '不存在的关键词')
    expect(container.querySelector('[class*="searchStatus"]')?.textContent).toContain(zh.searchNoMatches)
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(0)
  })

  it('flat mode filters the session rows by title', async () => {
    await renderBrowser()
    act(() => { instance.actions.setGroupBy('flat') })
    typeText(searchInput(), '构图')
    expect(sessionRowByText('构图笔记')).toBeDefined()
    expect(sessionRowByText('配色研究'), 'non-matching flat rows hide').toBeUndefined()
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(1)
    typeText(searchInput(), '')
    expect(sessionRowByText('配色研究'), 'clearing restores the flat list').toBeDefined()
  })
})

describe('rail fold (shell collapse parity)', () => {
  it('collapsed: only the two rail controls render — no header, input, or tree, and the list seat stays', async () => {
    await renderBrowser(defaultPersistence(), false, false)
    expect(buttonByAria(zh.addWorkspace), 'rail add control').toBeDefined()
    expect(buttonByAria(zh.searchAria), 'rail search control').toBeDefined()
    expect(container.querySelector('header'), 'wide title header is gone').toBeNull()
    expect(container.querySelector('input'), 'wide search input is gone').toBeNull()
    expect(container.querySelectorAll('[role="treeitem"]'), 'the tree is gone').toHaveLength(0)
    expect(container.querySelectorAll('section'), 'the recency/tree sections are gone').toHaveLength(0)
    expect(container.querySelector('[class*="scroll"]'), 'the list seat stays mounted').not.toBeNull()
  })

  it('rail add opens the directory picker directly', async () => {
    const props = await renderBrowser(defaultPersistence(), false, false)
    click(buttonByAria(zh.addWorkspace)!)
    expect(props.pickDirectory).toHaveBeenCalled()
  })

  it('rail search requests the shell expansion (built-in gesture)', async () => {
    const props = await renderBrowser(defaultPersistence(), false, false)
    click(buttonByAria(zh.searchAria)!)
    expect(props.expandSidebar).toHaveBeenCalled()
  })

  it('rail search lands focus in the input once the shell flips wide, after the slide', async () => {
    vi.useFakeTimers()
    try {
      const props = await renderBrowser(defaultPersistence(), false, false)
      click(buttonByAria(zh.searchAria)!)
      expect(props.expandSidebar).toHaveBeenCalled()
      await rerenderWith({ wide: true })
      expect(container.querySelector('input'), 'the input mounted with the wide flip').not.toBeNull()
      expect(document.activeElement, 'focus waits for the slide').not.toBe(container.querySelector('input'))
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement, 'focus lands after the shell slide').toBe(container.querySelector('input'))
    } finally {
      vi.useRealTimers()
    }
  })

  it('the search query outlives the fold: collapsing clears the chrome, expanding restores the same filter', async () => {
    await renderBrowser(defaultPersistence(), false, true)
    typeText(container.querySelector<HTMLInputElement>('input[type="search"]')!, '画布草图')
    expect(treeRowByText('绘画收集'), 'the dir holding the match stays').toBeDefined()
    expect(treeRowByText('文档'), 'non-matching dirs hide').toBeUndefined()

    // Collapse: the wide chrome unmounts, the rail takes over.
    await rerenderWith({ wide: false })
    expect(container.querySelector('input'), 'the input is wide-only').toBeNull()
    expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(0)

    // Expand: the SAME filter comes back — no silent query drop.
    await rerenderWith({ wide: true })
    expect(treeRowByText('绘画收集'), 'the in-progress filter survives the fold').toBeDefined()
    expect(treeRowByText('文档')).toBeUndefined()
    expect(container.querySelector('[class*="searchStatus"]'), 'a blank query is not forced').toBeNull()

    // Clearing the restored input restores the whole tree.
    typeText(container.querySelector<HTMLInputElement>('input[type="search"]')!, '')
    expect(treeRowByText('文档'), 'clearing restores the full list').toBeDefined()
  })
})

describe('external search trigger surface (slot handle + global mirror + DOM fallback)', () => {
  it('wide: the shared handle seed + focus drives the real input and filter, and the global mirror exposes it', async () => {
    vi.useFakeTimers()
    try {
      await renderBrowser()
      const input = container.querySelector<HTMLInputElement>(SEARCH_INPUT_SELECTOR)
      expect(input, 'the DOM fallback marker addresses the input').not.toBeNull()
      expect(input!.getAttribute('aria-label'), 'the localized aria label is the second DOM anchor').toBe(zh.searchAria)
      // The slot fixture captured the same singleton an external occupant gets.
      expect(capturedSearchHandle).not.toBeNull()
      expect(searchHandle.available, 'the mounted region publishes a live handle').toBe(true)
      expect(searchHandle.input()).toBe(input)

      act(() => { searchHandle.setQuery('文档') })
      expect(input!.value, 'the handle writes React state, not DOM value').toBe('文档')
      expect(treeRowByText('文档'), 'the seeded query filters the tree').toBeDefined()
      expect(treeRowByText('绘画收集')).toBeUndefined()

      input!.blur()
      act(() => { searchHandle.focus() })
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement, 'focus lands in the search input').toBe(input)

      act(() => { searchHandle.setQuery('') })
      expect(treeRowByText('绘画收集'), 'clearing through the handle restores the list').toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('the global mirror delegates to the same handle and publishes the DOM selector constants', async () => {
    vi.useFakeTimers()
    try {
      await renderBrowser()
      const host = window as unknown as Record<string, EnhancedWorkspaceGlobal | undefined>
      const mirror = host[SEARCH_GLOBAL_KEY]
      expect(mirror, 'the mounted browser installs the imperative mirror').toBeDefined()
      expect(mirror!.searchAvailable()).toBe(true)
      expect(mirror!.querySelector).toBe(SEARCH_INPUT_SELECTOR)
      expect(mirror!.railButtonSelector).toBe(SEARCH_RAIL_BUTTON_SELECTOR)
      act(() => { mirror!.setSearchQuery('文档') })
      expect(treeRowByText('文档')).toBeDefined()
      act(() => { mirror!.focusSearch() })
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement).toBe(container.querySelector(SEARCH_INPUT_SELECTOR))
    } finally {
      vi.useRealTimers()
    }
  })

  it('collapsed: the handle arms the built-in expand gesture and lands focus after the fold', async () => {
    vi.useFakeTimers()
    try {
      const props = await renderBrowser(defaultPersistence(), false, false)
      expect(container.querySelector(SEARCH_INPUT_SELECTOR), 'no input while collapsed').toBeNull()
      act(() => { searchHandle.setQuery('文档') })
      act(() => { searchHandle.focus() })
      expect(props.expandSidebar, 'focus requests the shell expansion').toHaveBeenCalled()

      await rerenderWith({ wide: true })
      expect(document.activeElement, 'focus waits for the slide').not.toBe(container.querySelector(SEARCH_INPUT_SELECTOR))
      act(() => { vi.advanceTimersByTime(300) })
      expect(document.activeElement, 'the collapsed trigger lands in the input').toBe(container.querySelector(SEARCH_INPUT_SELECTOR))
      expect(treeRowByText('文档'), 'the query seeded while collapsed survived the fold').toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('DOM fallback: commitSearchQueryFromDom writes through React and the rail button expands the shell', async () => {
    vi.useFakeTimers()
    try {
      const props = await renderBrowser(defaultPersistence(), false, false)
      expect(commitSearchQueryFromDom('文档'), 'no input while collapsed: the caller expands first').toBe(false)
      const rail = container.querySelector<HTMLButtonElement>(SEARCH_RAIL_BUTTON_SELECTOR)
      expect(rail, 'the rail button carries its stable marker').not.toBeNull()
      click(rail!)
      expect(props.expandSidebar).toHaveBeenCalled()

      await rerenderWith({ wide: true })
      act(() => { vi.advanceTimersByTime(300) })
      expect(commitSearchQueryFromDom('文档'), 'the mounted input accepted the DOM commit').toBe(true)
      expect(container.querySelector<HTMLInputElement>(SEARCH_INPUT_SELECTOR)!.value).toBe('文档')
      expect(treeRowByText('文档'), 'the DOM-committed query filters the tree').toBeDefined()
      expect(treeRowByText('绘画收集')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('occupied search hole: the occupant renders beside the field and its props carry the handle', async () => {
    searchOccupied = true
    await renderBrowser()
    expect(searchOwners.length, 'the hole renders from the first wide render').toBeGreaterThan(0)
    expect(container.querySelector('[data-testid="search-occupant"]'), 'the occupant mounts inside the search bar').not.toBeNull()
    // The occupant's props ARE the inject face in the real renderer: the same
    // handle identity the external action path uses.
    expect(capturedSearchHandle).toBe(searchHandle)
  })

  it('unmount withdraws the handle and the global mirror (no dead external trigger)', async () => {
    await renderBrowser()
    expect(searchHandle.available).toBe(true)
    act(() => { root.unmount() })
    expect(searchHandle.available, 'the region owns the handle lifecycle').toBe(false)
    expect(searchHandle.input(), 'no live input after unmount').toBeNull()
    expect((window as unknown as Record<string, unknown>)[SEARCH_GLOBAL_KEY], 'the mirror is withdrawn').toBeUndefined()
    expect(() => { searchHandle.focus(); searchHandle.setQuery('x') }, 'externally calling a dead handle is a no-op').not.toThrow()
  })
})

describe('the add entry and the plugin-owned directory-flow hole', () => {
  it('unoccupied hole: the add entry opens the native directory picker (self-owned fallback)', async () => {
    const props = await renderBrowser()
    click(buttonByAria(zh.addWorkspace)!)
    expect(flowOwners, 'the hole stays unrendered while unoccupied').toHaveLength(0)
    expect(props.pickDirectory).toHaveBeenCalled()
    expect(props.createWorkspace).not.toHaveBeenCalled()
  })

  it('occupied hole: clicking add renders the occupant with the flow owner conversation', async () => {
    directoryFlowOccupied = true
    const props = await renderBrowser()
    // The hole stays mounted from the first render (the built-in posture);
    // every owner published before the click is closed.
    expect(flowOwners.length, 'the occupant mounts with the browser').toBeGreaterThan(0)
    expect(flowOwners.every(owner => !owner.open)).toBe(true)
    expect(container.querySelector('[data-testid="flow-marker"]'), 'closed occupants hide themselves').toBeNull()

    click(buttonByAria(zh.addWorkspace)!)
    const opened = flowOwners.at(-1)!
    expect(opened.open).toBe(true)
    expect(container.querySelector('[data-testid="flow-marker"]'), 'the occupant renders').not.toBeNull()
    expect(props.pickDirectory, 'occupied hole never falls back to the native picker').not.toHaveBeenCalled()

    // Cancel withdraws the request: the SAME conversation flips `open` off.
    act(() => { opened.onCancel() })
    expect(flowOwners.at(-1)!.open).toBe(false)
    expect(container.querySelector('[data-testid="flow-marker"]'), 'the occupant hides again').toBeNull()
  })

  it('occupied hole: a picked path is adopted through createWorkspace and lands in the tree', async () => {
    directoryFlowOccupied = true
    await renderBrowser(defaultPersistence(), false, true)
    // The Host baseline gains the picked workspace (the adoption only re-homes
    // registry ids; the tree renders the Host list).
    workspacesState = { ...WORKSPACES_STATE, items: [...WORKSPACES, workspace('w-new', '远程镜像', [])] }
    const createWorkspace = vi.fn(async () => workspace('w-new', '远程镜像', []))
    await rerenderWith({ createWorkspace })

    click(buttonByAria(zh.addWorkspace)!)
    act(() => { flowOwners.at(-1)!.onPicked('/mirror/remote-project') })
    expect(createWorkspace).toHaveBeenCalledWith({ path: '/mirror/remote-project' })
    expect(flowOwners.at(-1)!.open, 'the flow closes once the path is picked').toBe(false)
    expect(treeRowByText('远程镜像'), 'the adopted workspace joins the tree').toBeDefined()
  })

  it('the occupant unloads while the flow is open: the request is withdrawn, not leaked to the next occupant', async () => {
    directoryFlowOccupied = true
    await renderBrowser()
    click(buttonByAria(zh.addWorkspace)!)
    expect(flowOwners.at(-1)!.open).toBe(true)
    // The occupant goes away — the hole unmounts entirely; a stale `open`
    // must not resurface when a new occupant arrives later.
    directoryFlowOccupied = false
    await rerenderWith({})
    expect(container.querySelector('[data-testid="flow-marker"]'), 'the flow unmounts with its occupant').toBeNull()
    directoryFlowOccupied = true
    await rerenderWith({})
    expect(flowOwners.at(-1)!.open, 'the next occupant starts closed').toBe(false)
  })

  it('rail add uses the same entry: an occupied hole opens the flow from the rail', async () => {
    directoryFlowOccupied = true
    const props = await renderBrowser(defaultPersistence(), false, false)
    click(buttonByAria(zh.addWorkspace)!)
    expect(flowOwners.at(-1)!.open).toBe(true)
    expect(container.querySelector('[data-testid="flow-marker"]')).not.toBeNull()
    expect(props.pickDirectory).not.toHaveBeenCalled()
  })
})

describe('indent guides (better-sidebar FileTree parity)', () => {
  it('paints one 1px stroke per ancestor-folder column, a corner on expanded folder rows, and the bright 2px hover stroke', async () => {
    // No ancestors → no guide layers at all.
    expect(guideBackground(0, false)).toEqual({})
    expect(guideBackground(0, true)).toEqual({})
    // One ancestor: a single faint stroke at the 8px base column.
    const single = guideBackground(1, false)
    expect(single.backgroundImage).toContain('transparent 8px')
    expect(single.backgroundImage).not.toContain('transparent 16px')
    expect(single.backgroundImage).not.toContain(GUIDE_STROKE_HOVER)
    // Deep open row: one stroke per ancestor column (8, 16, 24) — never at
    // the row's own content column (32) — plus the 8px corner across the
    // deepest indent column (x=24 → ends at the row content start).
    const deep = guideBackground(3, true)
    expect(deep.backgroundImage).toContain('transparent 8px')
    expect(deep.backgroundImage).toContain('transparent 16px')
    expect(deep.backgroundImage).toContain('transparent 24px')
    expect(deep.backgroundImage).not.toContain('transparent 32px')
    expect(deep.backgroundSize).toContain('8px 100%')
    expect(deep.backgroundPosition).toContain('24px 0')
    // The corner carries its OWN trunk below: a 1px vertical at the row's
    // icon column (one indent step right of the corner) from the corner
    // down to the row bottom, so the first child-row segment starts flush
    // with the "├─" joint instead of leaving a gap under it.
    expect(deep.backgroundImage).toContain('transparent 100%)')
    expect(deep.backgroundSize).toContain('1px 100%')
    expect(deep.backgroundPosition).toContain('32px 0')
    // Collapsed deep row: the corner AND its trunk are gone, the verticals
    // stay.
    const collapsed = guideBackground(3, false)
    expect(collapsed.backgroundImage).not.toContain('linear-gradient(0deg')
    expect(collapsed.backgroundImage).not.toContain('transparent 100%)')
    // The hovered column swaps to the bright, 2px-wide stroke; the other
    // columns keep the faint 1px stroke.
    const highlighted = guideBackground(2, false, 1)
    expect(highlighted.backgroundImage).toContain(GUIDE_STROKE_HOVER)
    expect(highlighted.backgroundImage).toContain('transparent 15.5px')
    expect(highlighted.backgroundImage).toContain('transparent 17.5px')
    expect(highlighted.backgroundImage).toContain('transparent 8px')
    expect(highlighted.backgroundImage).not.toContain('transparent 17px')
  })

  it('quick-collapse from any descendant row: hovering a band lights the ancestor line, clicking folds the folder', async () => {
    await renderBrowser()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.createFolder(alpha, 'beta') })
    const beta = instance.getSnapshot().folders[alpha]!.folderIds[0]!
    act(() => { instance.actions.moveWorkspaceIn(W('w-art'), beta) })
    act(() => { instance.actions.setFolderExpanded(alpha, true) })
    act(() => { instance.actions.setFolderExpanded(beta, true) })

    const alphaRow = treeRowByText('alpha')!
    const betaRow = treeRowByText('beta')!
    const artRow = treeRowByText('绘画收集')!

    // Column alignment: a top-level folder carries no guides at all; the
    // row directly under it paints one stroke at its icon column (8); the
    // leaf under beta paints two — one per ancestor, exactly at the
    // ancestors' icon columns.
    expect(alphaRow.querySelectorAll('[class*="guideHit"]'), 'top-level rows get no bands').toHaveLength(0)
    expect(alphaRow.style.backgroundImage).toBe('')
    expect(betaRow.querySelectorAll('[class*="guideHit"]')).toHaveLength(1)
    expect(artRow.querySelectorAll('[class*="guideHit"]')).toHaveLength(2)
    const bands = artRow.querySelectorAll<HTMLElement>('[class*="guideHit"]')
    expect(bands[0]!.style.left, 'column 0 sits at the 8px base').toBe('4.5px')
    expect(bands[1]!.style.left, 'column 1 sits one 8px step in').toBe('12.5px')
    expect(artRow.style.backgroundImage).toContain('transparent 8px')
    expect(artRow.style.backgroundImage).toContain('transparent 16px')

    // Hover the deepest band (beta's column): beta's whole vertical line
    // lights up on every descendant row of its subtree — the leaf repaints
    // that stroke bright; beta's own row (shallower) stays faint.
    hover(bands[1]!)
    expect(artRow.style.backgroundImage).toContain(GUIDE_STROKE_HOVER)
    expect(betaRow.style.backgroundImage).not.toContain(GUIDE_STROKE_HOVER)

    // Click the band: beta collapses from the leaf row, folding its subtree
    // (beta's own row stays — only its children unmount).
    click(bands[1]!)
    expect(instance.getSnapshot().folderExpansion[beta]).toBe(false)
    expect(treeRowByText('beta')!.getAttribute('aria-expanded')).toBe('false')
    expect(treeRowByText('绘画收集')).toBeUndefined()
    expect(treeRowByText('alpha'), 'alpha stays open').toBeDefined()
    expect(instance.getSnapshot().groupExpansion['w-art'], 'the band click never toggles the leaf row itself').toBeUndefined()

    // Re-open beta; the band directly under it (column 0) folds alpha from
    // the leaf row — one level per click, all the way up the chain, and the
    // collapse never touches the leaf's own expansion.
    click(treeRowByText('beta')!)
    const artRowAgain = treeRowByText('绘画收集')!
    const bandsAgain = artRowAgain.querySelectorAll<HTMLElement>('[class*="guideHit"]')
    expect(bandsAgain.length, 'the leaf keeps one band per ancestor after reopen').toBe(2)
    hover(bandsAgain[0]!)
    expect(artRowAgain.style.backgroundImage).toContain(GUIDE_STROKE_HOVER)
    click(bandsAgain[0]!)
    expect(instance.getSnapshot().folderExpansion[alpha]).toBe(false)
    expect(instance.getSnapshot().folderExpansion[beta]).toBe(true)
    expect(treeRowByText('beta')).toBeUndefined()
  })

  it('hangs session rows off their workspace column: aligned strokes through the folder levels, hover lights the whole line, and the deepest band collapses the session list', async () => {
    await renderBrowser()
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, 'alpha') })
    const alpha = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    act(() => { instance.actions.moveWorkspaceIn(W('w-art'), alpha) })
    act(() => { instance.actions.setFolderExpanded(alpha, true) })
    click(treeRowByText('绘画收集')!) // open the session list

    const artRow = treeRowByText('绘画收集')!
    const sessionRow = sessionRowByText('画布草图')!
    // Session rows carry every ancestor stroke — the folder column (8) plus
    // the workspace's OWN column (16, at the workspace row's icon column).
    const bands = sessionRow.querySelectorAll<HTMLElement>('[class*="guideHit"]')
    expect(bands.length).toBe(2)
    expect(bands[0]!.style.left).toBe('4.5px')
    expect(bands[1]!.style.left).toBe('12.5px')
    expect(sessionRow.style.backgroundImage).toContain('transparent 8px')
    expect(sessionRow.style.backgroundImage).toContain('transparent 16px')
    // The workspace row paints the corner (joins alpha's stroke to its icon)
    // while its session list is open — like an expanded folder row — and the
    // corner carries its own trunk down to the row bottom, so the workspace
    // column starts flush with the corner (not detached at the first row).
    expect(artRow.style.backgroundImage).toContain('linear-gradient(0deg')
    expect(artRow.style.backgroundImage).toContain('transparent 100%)')
    // The session-LIST container paints the full stroke set on its box, so
    // the lines read continuous across the 1px hairline row gaps (and any
    // in-list separator rows); each row's own layer keeps the highlight.
    // (The session row's immediate parent is the HoverCard anchor span —
    // the list box is one level up.)
    const sessionList = sessionRow.parentElement!.parentElement!
    expect(sessionList.className).toContain('sessionList')
    expect(sessionList.style.backgroundImage).toContain('transparent 8px')
    expect(sessionList.style.backgroundImage).toContain('transparent 16px')

    // Hover the workspace's band: the whole line lights up across EVERY
    // session row of the list; the workspace row itself stays unlit.
    hover(bands[1]!)
    expect(sessionRow.style.backgroundImage).toContain(GUIDE_STROKE_HOVER)
    expect(sessionRowByText('配色研究')!.style.backgroundImage).toContain(GUIDE_STROKE_HOVER)
    expect(artRow.style.backgroundImage).not.toContain(GUIDE_STROKE_HOVER)

    // Click the deepest band: collapses the session list from the deepest
    // row — the workspace row stays, only its sessions fold.
    click(bands[1]!)
    expect(instance.getSnapshot().groupExpansion['w-art']).toBe(false)
    expect(rowByText('画布草图')).toBeUndefined()
    expect(treeRowByText('绘画收集'), 'the workspace row stays').toBeDefined()
  })
})
describe('durable envelope persistence', () => {
  /** A durable envelope built through a real store engine (models a previous session). */
  function envelopeFor(folderName: string): EnhancedWorkspaceState {
    const seed = createEnhancedWorkspaceStore().create()
    seed.actions.adoptWorkspace(W('w-art'))
    seed.actions.createFolder(ROOT_FOLDER_ID, folderName)
    const team = seed.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    seed.actions.moveWorkspaceIn(W('w-art'), team)
    seed.actions.setFolderExpanded(team, true)
    seed.actions.setGroupExpanded(W('w-art'), true)
    return structuredClone(seed.getSnapshot())
  }

  const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

  it('restores the saved directory tree when the store is pristine, then saves it back', async () => {
    const persistence = defaultPersistence()
    vi.mocked(persistence.load).mockResolvedValue(envelopeFor('团队'))
    await renderBrowser(persistence)
    await act(async () => {}) // flush the load promise
    expect(persistence.load).toHaveBeenCalledTimes(1)
    expect(treeRowByText('团队'), 'the folder row restores').toBeDefined()
    expect(treeRowByText('绘画收集'), 'the folder member restores').toBeDefined()
    const teamId = Object.keys(instance.getSnapshot().folders).find(id => id !== ROOT_FOLDER_ID)
    expect(instance.getSnapshot().folderExpansion[teamId!]).toBe(true)
    // Live workspaces the envelope lacks (w-docs) are adopted at the root.
    expect(instance.getSnapshot().folders[ROOT_FOLDER_ID]!.workspaceIds).toEqual([W('w-docs')])

    // Once the first load settled, the state writes back debounced.
    await act(async () => { await sleep(400) })
    expect(persistence.save).toHaveBeenCalledTimes(1)
    expect(persistence.save).toHaveBeenCalledWith(expect.objectContaining({
      groupBy: 'workspace',
      folders: expect.objectContaining({}),
    }))
  })

  it('never restores over a tree the current session already built', async () => {
    let resolveLoad!: (value: EnhancedWorkspaceState | null) => void
    const persistence = {
      load: vi.fn(() => new Promise<EnhancedWorkspaceState | null>(resolved => { resolveLoad = resolved })),
      save: vi.fn(async () => undefined),
    }
    await renderBrowser(persistence)
    // The session creates a folder before the durable envelope lands.
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, '会话组') })
    await act(async () => { resolveLoad(envelopeFor('团队')) })
    expect(treeRowByText('会话组')).toBeDefined()
    expect(treeRowByText('团队'), 'the stale envelope stays out').toBeUndefined()
    await act(async () => { await sleep(400) })
    expect(persistence.save).not.toHaveBeenCalled()
  })

  it.each(['load-first', 'baseline-first'])('preserves folder membership across refresh when %s', async arrival => {
    // 基线未到达：0.1.5-rc.2 起快照以 phase 表达到达节拍（baselinesReady 已
    // 从契约移除）——pending 期间恢复、收养、同步、保存全部禁止。
    workspacesState = { ...WORKSPACES_STATE, phase: 'pending', items: [] }
    let resolveLoad!: (value: EnhancedWorkspaceState | null) => void
    const persistence = {
      load: vi.fn(() => new Promise<EnhancedWorkspaceState | null>(resolve => { resolveLoad = resolve })),
      save: vi.fn(async () => undefined),
    }
    const envelope = envelopeFor('团队')
    const team = envelope.folders[ROOT_FOLDER_ID]!.folderIds[0]!
    const props = await renderBrowser(persistence)
    const baseline = async (): Promise<void> => {
      workspacesState = WORKSPACES_STATE
      await act(async () => { root.render(<EnhancedWorkspaceBrowser {...props} />) })
    }
    if (arrival === 'load-first') await act(async () => { resolveLoad(envelope) })
    else await baseline()
    await act(async () => { await sleep(400) })
    expect(instance.getSnapshot().folders[ROOT_FOLDER_ID]!.workspaceIds).toEqual([])
    expect(persistence.save).not.toHaveBeenCalled()
    expect(props.insertWorkspaceBefore).not.toHaveBeenCalled()
    if (arrival === 'load-first') await baseline()
    else await act(async () => { resolveLoad(envelope) })
    expect(instance.getSnapshot().folders[team]!.workspaceIds).toEqual([W('w-art')])
    expect(instance.getSnapshot().folders[ROOT_FOLDER_ID]!.workspaceIds).toEqual([W('w-docs')])
    await act(async () => { await sleep(400) })
    expect(persistence.load).toHaveBeenCalledTimes(1)
    expect(persistence.save).toHaveBeenLastCalledWith(expect.objectContaining({
      folders: expect.objectContaining({ [team]: expect.objectContaining({ workspaceIds: [W('w-art')] }) }),
    }))
  })

  it('keeps writes and host reconciliation disabled after load fails, even after edits', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const persistence = {
      load: vi.fn(async () => { throw new Error('RPC unavailable') }),
      save: vi.fn(async () => undefined),
    }
    const props = await renderBrowser(persistence)
    act(() => { instance.actions.createFolder(ROOT_FOLDER_ID, '本地目录') })
    await act(async () => { await sleep(400) })
    expect(persistence.save).not.toHaveBeenCalled()
    expect(props.insertWorkspaceBefore).not.toHaveBeenCalled()
    expect(instance.getSnapshot().folders[ROOT_FOLDER_ID]!.workspaceIds).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('writes disabled'), expect.any(Error))
    warn.mockRestore()
  })

  it('restores once under StrictMode effect replay', async () => {
    const saved = envelopeFor('团队')
    const team = saved.folders[ROOT_FOLDER_ID]!.folderIds[0]!
    const persistence = { load: vi.fn(async () => saved), save: vi.fn(async () => undefined) }
    await renderBrowser(persistence, true)
    expect(persistence.load).toHaveBeenCalledTimes(1)
    expect(instance.getSnapshot().folders[team]!.workspaceIds).toEqual([W('w-art')])
    await act(async () => { await sleep(400) })
    expect(persistence.save).toHaveBeenCalledTimes(1)
  })

  it('keeps an already hydrated store writable after the sidebar remounts', async () => {
    const saved = envelopeFor('团队')
    const team = saved.folders[ROOT_FOLDER_ID]!.folderIds[0]!
    const persistence = { load: vi.fn(async () => saved), save: vi.fn(async () => undefined) }
    const props = await renderBrowser(persistence)
    act(() => { root.render(null) })
    await act(async () => { root.render(<EnhancedWorkspaceBrowser {...props} />) })
    act(() => { instance.actions.renameFolder(team, '重命名') })
    await act(async () => { await sleep(400) })
    expect(persistence.load).toHaveBeenCalledTimes(1)
    expect(persistence.save).toHaveBeenLastCalledWith(expect.objectContaining({
      folders: expect.objectContaining({ [team]: expect.objectContaining({ name: '重命名', workspaceIds: [W('w-art')] }) }),
    }))
  })

  it('ignores a load that settles after the browser unmounts', async () => {
    let resolveLoad!: (value: EnhancedWorkspaceState | null) => void
    const persistence = {
      load: vi.fn(() => new Promise<EnhancedWorkspaceState | null>(resolve => { resolveLoad = resolve })),
      save: vi.fn(async () => undefined),
    }
    await renderBrowser(persistence)
    const initial = instance.getSnapshot()
    act(() => { root.render(null) })
    await act(async () => { resolveLoad(envelopeFor('团队')); await sleep(400) })
    expect(instance.getSnapshot()).toBe(initial)
    expect(persistence.save).not.toHaveBeenCalled()
  })

  it('uses a confirmed empty baseline to prune genuinely deleted workspaces', async () => {
    workspacesState = { ...WORKSPACES_STATE, items: [] }
    const envelope = envelopeFor('团队')
    const team = envelope.folders[ROOT_FOLDER_ID]!.folderIds[0]!
    const persistence = { load: vi.fn(async () => envelope), save: vi.fn(async () => undefined) }
    await renderBrowser(persistence)
    expect(instance.getSnapshot().folders[team]!.workspaceIds).toEqual([])
    await act(async () => { await sleep(400) })
    expect(persistence.save).toHaveBeenCalledTimes(1)
  })

  it('holds writes until the first load settles, then writes the tree', async () => {
    let resolveLoad!: (value: EnhancedWorkspaceState | null) => void
    const persistence = {
      load: vi.fn(() => new Promise<EnhancedWorkspaceState | null>(resolved => { resolveLoad = resolved })),
      save: vi.fn(async () => undefined),
    }
    await renderBrowser(persistence)
    // No durable value yet: however long we wait, nothing is written.
    await act(async () => { await sleep(400) })
    expect(persistence.save).not.toHaveBeenCalled()
    // The first load settles (nothing durable): the write gate opens.
    await act(async () => { resolveLoad(null) })
    await act(async () => { await sleep(400) })
    expect(persistence.save).toHaveBeenCalledTimes(1)
    // A steady state writes ONCE — the debounce coalesces.
    await act(async () => { await sleep(400) })
    expect(persistence.save).toHaveBeenCalledTimes(1)
  })
})

describe('hover cards (built-in ui-workspace parity)', () => {
  /** Point into an element (React onPointerEnter derives from pointerover). */
  function pointerEnter(target: Element): void {
    act(() => { target.dispatchEvent(new Event('pointerover', { bubbles: true })) })
  }

  /** Point out of an element (React onPointerLeave derives from pointerout). */
  function pointerLeave(target: Element): void {
    act(() => { target.dispatchEvent(new Event('pointerout', { bubbles: true })) })
  }

  /** The open hover card's body (portaled to document.body), or undefined. */
  function cardContent(): HTMLElement | undefined {
    return [...document.body.querySelectorAll<HTMLElement>('[class*="hoverContent"]')].at(-1)
  }

  /** The hover card anchor wrapper of a row (HoverCard wraps the row itself). */
  function cardAnchor(row: HTMLElement): HTMLElement {
    return row.parentElement as HTMLElement
  }

  /** A role="button" element (the copyable card is a div, not a button tag). */
  function roleButtonByAria(label: string): HTMLElement | undefined {
    return [...document.body.querySelectorAll<HTMLElement>('[role="button"]')]
      .find(element => element.getAttribute('aria-label') === label)
  }

  /** Install the async browser clipboard and restore its prior host shape. */
  function installClipboard(writeText: (text: string) => Promise<void>): () => void {
    const prior = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    return () => {
      if (prior === undefined) Reflect.deleteProperty(navigator, 'clipboard')
      else Object.defineProperty(navigator, 'clipboard', prior)
    }
  }

  it('workspace hover card shows the directory and creation time and copies the full path', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    const restoreClipboard = installClipboard(writeText)
    try {
      await renderBrowser()
      const row = treeRowByText('绘画收集')!
      pointerEnter(cardAnchor(row))
      act(() => { vi.advanceTimersByTime(500) })
      // Card body: full title + cwd + absolute creation time.
      const card = cardContent()
      expect(card).toBeDefined()
      expect(card!.textContent).toContain('绘画收集')
      expect(card!.textContent).toContain('/projects/w-art')
      expect(card!.textContent).toMatch(/创建于 \d+年\d+月\d+日 \d{2}:\d{2}/)
      // The whole card is a copy target for the full path.
      const copyButton = roleButtonByAria('复制: /projects/w-art')
      expect(copyButton).toBeDefined()
      click(copyButton!)
      await act(async () => {})
      expect(writeText).toHaveBeenCalledWith('/projects/w-art')
      // The copied label replaces the card body and the wrapper's visually
      // hidden status seat reports it (both live on document.body).
      expect(document.querySelector('[role="status"]')?.textContent).toBe('已复制')
      expect(cardContent()).toBeUndefined()
    } finally {
      restoreClipboard()
      vi.useRealTimers()
    }
  })

  it('session hover card shows title, relative time, and the live status line after the dwell', async () => {
    vi.useFakeTimers()
    try {
      await renderBrowser()
      click(treeRowByText('绘画收集')!)
      const row = sessionRowByText('画布草图')!
      pointerEnter(cardAnchor(row))
      act(() => { vi.advanceTimersByTime(500) })
      const card = cardContent()
      expect(card).toBeDefined()
      expect(card!.textContent).toContain('画布草图')
      // The activity stamp is 1s old: the now bucket, bare (no "前").
      expect(card!.textContent).toContain('现在')
      // The fixture session is completed: the green done line reads.
      expect(card!.textContent).toContain('已完成')
    } finally {
      vi.useRealTimers()
    }
  })

  it('suppresses the session hover card while the row menu is open', async () => {
    vi.useFakeTimers()
    try {
      await renderBrowser()
      click(treeRowByText('绘画收集')!)
      const row = sessionRowByText('画布草图')!
      const anchor = cardAnchor(row)
      pointerEnter(anchor)
      act(() => { vi.advanceTimersByTime(500) })
      expect(cardContent()).toBeDefined()
      pointerLeave(anchor)
      // Menu open (disabled) suppresses the card for the same dwell.
      openRowMenu('画布草图')
      pointerEnter(anchor)
      act(() => { vi.advanceTimersByTime(1000) })
      expect(cardContent()).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows the session file domain as a flat name | path list, switchable to the directory tree with clickable marks', async () => {
    vi.useFakeTimers()
    try {
      sessionsState = {
        ...SESSIONS_STATE,
        byId: {
          ...SESSIONS_BY_ID,
          s7: {
            ...SESSIONS_BY_ID.s7,
            projectionValues: {
              sessionStats: {
                recentInputs: ['docs/readme.md'],
                recentOutputs: ['docs/notes.md', 'docs/plan.md'],
              },
            },
          } as SessionSummary,
        },
      }
      await renderBrowser()
      click(treeRowByText('文档')!)
      const row = sessionRowByText('README 整理')!
      pointerEnter(cardAnchor(row))
      act(() => { vi.advanceTimersByTime(500) })
      const card = cardContent()!
      // Default list mode: every file as one `name | path` row, laid out flat
      // (the flex gap is visual — no spaces around the divider).
      expect(card.querySelector('[data-hover-files-scroll]')).toBeTruthy()
      expect(card.textContent).toContain('输入源')
      expect(card.textContent).toContain('输出源')
      expect(card.textContent).toContain('readme.md|docs/readme.md')
      expect(card.textContent).toContain('notes.md|docs/notes.md')
      expect(card.textContent).toContain('plan.md|docs/plan.md')
      // The toolbar toggle switches to the merged directory tree.
      click(buttonByAria('树形')!)
      expect(cardContent()!.textContent).toContain('docs/')
      expect(card.textContent).toContain('readme.md')
      // File rows are clickable observation targets: clicking marks the row
      // (the aria-label carries the full path; the row text the basename).
      const fileButton = buttonByAria('docs/readme.md')
      expect(fileButton).toBeDefined()
      click(fileButton!)
      expect(buttonByAria('docs/readme.md')?.getAttribute('aria-pressed')).toBe('true')
      // Clicking the marked row clears the mark.
      click(buttonByAria('docs/readme.md')!)
      expect(buttonByAria('docs/readme.md')?.getAttribute('aria-pressed')).toBe('false')
    } finally {
      vi.useRealTimers()
    }
  })
})

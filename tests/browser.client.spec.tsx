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
import type { SessionId, SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import { EnhancedWorkspaceBrowser, GUIDE_STROKE_HOVER, guideBackground } from '../src/client/Browser.tsx'
import type { EnhancedWorkspaceBrowserProps } from '../src/client/contract.ts'
import { ROOT_FOLDER_ID } from '../src/client/model.ts'
import { zh } from '../src/client/locales.ts'
import type { EnhancedWorkspaceState } from '../src/client/store.ts'
import { createEnhancedWorkspaceStore } from '../src/client/store.ts'

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
  recentWorkspaceId: undefined,
}

/**
 * Mutable fixture seats: re-bound before each test and read by the
 * `useWorkspaces` / `useSessions` closures, so a test can swap in a NEW
 * snapshot (immutable update) and re-render to simulate a runtime update —
 * e.g. a session stamp advancing when a new query lands.
 */
let workspacesState: typeof WORKSPACES_STATE = WORKSPACES_STATE
let sessionsState: typeof SESSIONS_STATE = SESSIONS_STATE

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

/** Render the browser over a fresh real store engine instance. */
async function renderBrowser(persistence: EnhancedWorkspaceBrowserProps['persistence'] = defaultPersistence(), strict = false): Promise<EnhancedWorkspaceBrowserProps> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  instance = createEnhancedWorkspaceStore().create()
  const props = {
    useWorkspaces: (selector: (snapshot: typeof WORKSPACES_STATE) => unknown) => selector(workspacesState),
    useSessions: (selector: (snapshot: typeof SESSIONS_STATE) => unknown) => selector(sessionsState),
    useStore: (selector: (snapshot: EnhancedWorkspaceState) => unknown) =>
      useSyncExternalStore(instance.store.subscribe, () => selector(instance.store.getSnapshot())),
    actions: instance.actions,
    t,
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
    persistence,
  } as unknown as EnhancedWorkspaceBrowserProps
  await act(async () => {
    const browser = <EnhancedWorkspaceBrowser {...props} />
    root.render(strict ? <StrictMode>{browser}</StrictMode> : browser)
  })
  return props
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
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterEach(() => {
  act(() => { root.unmount() })
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

  it('collapses every expandable dir row from either section header: folders, workspace lists, and recency lists fold back', async () => {
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
    expect(rowByText('画布草图')).toBeDefined()
    const recencySection = [...container.querySelectorAll('section')]
      .find(section => section.querySelector('h3')?.textContent === zh.recents)!
    click([...recencySection.querySelectorAll<HTMLElement>('[class*="workspaceRow"]')][0]!)
    expect(recencySection.querySelector('[class*="sessionRow"]')).not.toBeNull()

    // The collapse-all icon button sits in BOTH section headers.
    const allSection = [...container.querySelectorAll('section')]
      .find(section => section.querySelector('h3')?.textContent === zh.all)!
    const allCollapse = [...allSection.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.getAttribute('aria-label') === zh.collapseAll)
    expect(allCollapse, 'collapse-all button sits beside the new-folder action').toBeDefined()
    const recentsCollapse = [...recencySection.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.getAttribute('aria-label') === zh.collapseAll)
    expect(recentsCollapse, 'collapse-all button sits in the recents header too').toBeDefined()

    // One click on the "all" header's button folds the whole outline back.
    click(allCollapse!)
    expect(rowByText('画布草图')).toBeUndefined()
    expect(recencySection.querySelector('[class*="sessionRow"]')).toBeNull()
    expect(rowByText('产品组')!.getAttribute('aria-expanded')).toBe('false')
    // The nested workspace row is hidden again under the collapsed folder;
    // the tree itself keeps the membership intact.
    expect(treeRowByText('绘画收集'), 'workspace hides with its collapsed folder').toBeUndefined()
    const folderId = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    expect(instance.getSnapshot().folders[folderId]?.workspaceIds).toContain(W('w-art'))
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
    expect(folderRow.matches('[class*="dropBefore"]'), 'the top edge shows the outer-anchor line').toBe(true)
    dropOn(folderRow, 8)

    // The workspace lands in the folder's PARENT account (外层), not inside.
    expect(new Set(instance.getSnapshot().folders[ROOT_FOLDER_ID]!.workspaceIds))
      .toEqual(new Set([W('w-art'), W('w-docs')]))
    expect(instance.getSnapshot().folders[team]?.workspaceIds, 'the folder itself stays empty').toEqual([])
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
    // Collapsed deep row: the corner is gone, the verticals stay.
    const collapsed = guideBackground(3, false)
    expect(collapsed.backgroundImage).not.toContain('linear-gradient(0deg')
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
    // while its session list is open — like an expanded folder row.
    expect(artRow.style.backgroundImage).toContain('linear-gradient(0deg')

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
    workspacesState = { ...WORKSPACES_STATE, baselinesReady: false, items: [] }
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

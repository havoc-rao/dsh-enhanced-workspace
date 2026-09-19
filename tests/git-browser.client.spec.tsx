// @vitest-environment jsdom
/**
 * Component spec of the git-worktree layer of the enhanced browser
 * (Browser.tsx): the probe-backed row pill (single tree / "n 棵" / none),
 * the subworkspace grouping inside an expanded workspace, the repo grouping
 * mode with its no-git flattening, and the unregistered-tree group's
 * one-click registration. Real store engine instance + fixture snapshots +
 * a probe stub returning the acme index; asserts user-visible rows.
 */
import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { EnhancedWorkspaceBrowser } from '../src/client/Browser.tsx'
import { WorkspaceHoverContent } from '../src/client/HoverCards.tsx'
import { DIRECTORY_FLOW_SLOT, SEARCH_SLOT, type EnhancedWorkspaceBrowserProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import { createEnhancedWorkspaceStore, type EnhancedWorkspaceState } from '../src/client/store.ts'
import type { GitProbeResultJSON, RemoteGitMarker } from '../src/shared/git.ts'
// Type-only: the fileTreeUi v2 seat (this spec keeps the missing-provider
// posture — built-in session rows; the service-path spec lives in
// file-tree-ui.client.spec.tsx).
import type { FileTreeUiServiceV2 } from 'dsh-file-tree-ui/client-contract'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const W = (id: string): WorkspaceId => id as WorkspaceId
const NOW = Date.now()

const MAIN = '/work/acme'
const PAY = '/tmp/acme/feat-payment'
const HF = '/tmp/acme/hotfix-login'
const GH = '/tmp/acme/gh-pages'
// A dsh-remote mirror workspace: the LOCAL path (mirror) has no .git; the
// marker carries the REMOTE repo state (branch dev, 3 dirty, 1 staged,
// 2 ahead / 1 behind of origin/dev).
const REMOTE_PATH = '/Users/u/.dsh/remote-workspaces/1.2.3.4-root-22/acme'
const REMOTE_MARKER: RemoteGitMarker = {
  isRepo: true,
  branch: 'dev',
  dirty: 3,
  staged: 1,
  ahead: 2,
  behind: 1,
  upstream: 'origin/dev',
  root: '/srv/acme',
  remotePath: '/srv/acme',
  machine: { id: 'm1', name: 'dev', host: '1.2.3.4', port: 22, username: 'root' },
  mirrorDir: REMOTE_PATH,
  at: NOW,
}

function session(id: string, title: string, cwd: string, ageMs: number): SessionSummary {
  return {
    id: id as SessionId,
    displayTitle: title,
    blank: false,
    running: false,
    completed: true,
    updatedAt: NOW - ageMs,
    cwd,
  }
}

function workspace(id: string, title: string, path: string, sessionIds: string[]): WorkspaceView {
  return {
    workspaceId: id as WorkspaceId,
    path,
    title,
    sessionIds: sessionIds as SessionId[],
    createdAt: new Date(NOW - 86_400_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
  }
}

const WORKSPACES: WorkspaceView[] = [
  // cross-tree workspace: own tree + a session in the hotfix worktree
  workspace('w-acme', 'acme', MAIN, ['sa1', 'sc1']),
  // single-tree workspace (homogeneous)
  workspace('w-pay', 'feat-payment', PAY, ['p1']),
  // no-git workspace (hammerspoon)
  workspace('w-hs', 'hammerspoon', '/Users/u/.hammerspoon', ['h1']),
  // remote-mirror workspace (marker-backed; no local .git)
  workspace('w-rm', 'my-remote', REMOTE_PATH, ['r1']),
]
const SESSIONS_BY_ID: Record<string, SessionSummary> = {
  sa1: session('sa1', '初始化脚手架', MAIN, 1000),
  sc1: session('sc1', 'hotfix 排查', HF, 2000),
  p1: session('p1', 'fix webhook retry', PAY, 3000),
  h1: session('h1', '窗口布局脚本', '/Users/u/.hammerspoon', 4000),
  r1: session('r1', '远端联调', REMOTE_PATH, 5000),
}
const SESSIONS_STATE = {
  ids: ['sa1', 'sc1', 'p1', 'h1', 'r1'],
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
  recentWorkspaceId: undefined as WorkspaceId | undefined,
}

/** The acme probe index: four trees, three bound, gh-pages unregistered. */
const PROBE: GitProbeResultJSON = {
  trees: {
    [MAIN]: { root: MAIN, repoKey: '/work/acme/.git', role: 'main', branch: 'main' },
    [PAY]: { root: PAY, repoKey: '/work/acme/.git', role: 'linked', branch: 'feat/payment' },
    [HF]: { root: HF, repoKey: '/work/acme/.git', role: 'linked', branch: 'hotfix/login' },
    [GH]: { root: GH, repoKey: '/work/acme/.git', role: 'linked', detached: '1a2b3c4' },
  },
  bindings: { [MAIN]: MAIN, [PAY]: PAY, [HF]: HF },
  scannedAt: 1000,
}

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
let createWorkspaceMock: ReturnType<typeof vi.fn>

async function renderBrowser(probe: GitProbeResultJSON | null = PROBE, markers: ReadonlyMap<string, RemoteGitMarker> = new Map()): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  instance = createEnhancedWorkspaceStore().create()
  createWorkspaceMock = vi.fn(async (input: { path: string }) => workspace('w-new', 'new', input.path, []))
  latestProps = {
    wide: true,
    expandSidebar: vi.fn(),
    useWorkspaces: (selector: (snapshot: typeof WORKSPACES_STATE) => unknown) => selector(WORKSPACES_STATE),
    useSessions: (selector: (snapshot: typeof SESSIONS_STATE) => unknown) => selector(SESSIONS_STATE),
    // No fixture session carries a pending interaction: the empty snapshot.
    useSessionPendingInteraction: (selector: (snapshot: ReadonlyMap<string, unknown>) => unknown) => selector(new Map()),
    useStore: (selector: (snapshot: EnhancedWorkspaceState) => unknown) =>
      useSyncExternalStore(instance.store.subscribe, () => selector(instance.store.getSnapshot())),
    actions: instance.actions,
    t,
    useDirectoryFlow: (selector: (occupied: boolean) => unknown) => selector(false),
    useFileTreeUi: (selector: (value: FileTreeUiServiceV2 | undefined) => unknown) => selector(undefined),
    renderSlot: ((_key: string) => {
      // The region renders both plugin-owned holes while wide; this spec's
      // git assertions are occupant-agnostic, so every key renders nothing.
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
    createWorkspace: createWorkspaceMock,
    pickDirectory: vi.fn(async () => null),
    probeGit: vi.fn(async () => probe),
    remoteGit: {
      fetchMarkers: vi.fn(async () => markers),
      refresh: vi.fn(async () => markers),
    },
    continueInWorkspace: vi.fn(async () => undefined),
    persistence: {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
    },
  } as unknown as EnhancedWorkspaceBrowserProps
  await act(async () => {
    root.render(<EnhancedWorkspaceBrowser {...latestProps} />)
  })
  // Flush the probe promise chain (effect → probeGit → setGitProbe).
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
}

/** Re-render after an external store action (the store engine notifies). */
async function rerender(): Promise<void> {
  await act(async () => {
    root.render(<EnhancedWorkspaceBrowser {...latestProps} />)
  })
}

function text(): string {
  return container.textContent ?? ''
}

function rowsByLabel(label: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[class*="workspaceRow"]')]
    .filter(row => row.textContent?.includes(label) === true)
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.innerHTML = ''
})

afterEach(() => {
  act(() => { root?.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

describe('git-worktree browser layer', () => {
  it('renders only the cross-tree count on rows (no branch tag — hover card only)', async () => {
    await renderBrowser()
    // user feedback: workspace rows carry no branch tag; homogeneous
    // workspace rows show neither the branch nor any git pill
    const pay = rowsByLabel('feat-payment')[0]
    expect(pay?.textContent).not.toContain('feat/payment')
    expect(pay?.querySelector('[class*="gitPill"]')).toBeNull()
    // cross-tree workspace: the count form stays
    const acme = rowsByLabel('acme')[0]
    expect(acme?.textContent).toContain('2 棵')
    // no-git workspace: no pill at all
    const hs = rowsByLabel('hammerspoon')[0]
    expect(hs?.textContent).not.toContain('棵')
    expect(hs?.querySelector('[class*="gitPill"]')).toBeNull()
  })

  it('groups an expanded workspace into subworkspaces by session cwd', async () => {
    await renderBrowser()
    // expand the cross-tree workspace row
    const acmeRow = rowsByLabel('acme')[0]!
    await act(async () => { acmeRow.click() })
    await rerender()
    expect(text()).toContain('本工作区')
    expect(text()).toContain('hotfix/login')
    // group headers group their own sessions
    const groups = [...container.querySelectorAll<HTMLElement>('[class*="subwsRow"]')]
    expect(groups.map(g => g.textContent).join('|')).toContain('hotfix/login')
    // Guide continuity through the split: the group headers carry the
    // workspace's own stroke column plus the hover bands, and the
    // session-list container paints the strokes across headers and rows —
    // the vertical line never fragments at a header row.
    const ownHeader = groups.find(g => g.textContent?.includes('本工作区'))!
    expect(ownHeader.style.backgroundImage).toContain('transparent 8px')
    expect(ownHeader.querySelectorAll('[class*="guideHit"]'), 'a top-level workspace has one column (its own)').toHaveLength(1)
    const sessionListBox = container.querySelector<HTMLElement>('[class*="sessionList"]')
    expect(sessionListBox?.style.backgroundImage).toContain('transparent 8px')
  })

  it('renders repo groups, flattens no-git workspaces, and registers an unregistered tree', async () => {
    await renderBrowser()
    // switch to the repo grouping mode through the store action
    await act(async () => { instance.actions.setGroupBy('repo') })
    await rerender()
    const repoRows = [...container.querySelectorAll<HTMLElement>('[class*="repoRow"]')]
    // repo group + the unregistered-tree group header
    expect(repoRows.some(row => row.textContent?.includes('acme'))).toBe(true)
    expect(text()).toContain('未注册工作树')
    // no-git workspaces flatten below the repo groups
    expect(text()).toContain('未关联 git 仓库的工作区')
    // expand the unregistered group and register gh-pages
    const unregHeader = repoRows.find(row => row.textContent?.includes('未注册工作树'))!
    await act(async () => { unregHeader.click() })
    await rerender()
    const unregRow = [...container.querySelectorAll<HTMLElement>('[class*="unregRow"]')]
    expect(unregRow.some(row => row.textContent?.includes('gh-pages'))).toBe(true)
    await act(async () => { unregRow[0]!.click() })
    await act(async () => { await Promise.resolve(); await Promise.resolve() })
    expect(createWorkspaceMock).toHaveBeenCalledWith({ path: GH })
  })

  it('shows the tree binding on the workspace hover card (and the no-git notice)', async () => {
    // Component-level: the hover card content itself (the HoverCard shell is
    // ui-primitives behavior, not this plugin's contract).
    const holder = document.createElement('div')
    document.body.appendChild(holder)
    const hoverRoot = createRoot(holder)
    const tree = PROBE.trees[MAIN]!
    const peers = Object.values(PROBE.trees).filter(t => t.repoKey === tree.repoKey && t.root !== tree.root)
    await act(async () => {
      hoverRoot.render(
        <WorkspaceHoverContent label="acme" cwd={MAIN} createdAt={NOW} t={t} git={{ tree, peers }} />,
      )
    })
    expect(holder.textContent).toContain('分支')
    expect(holder.textContent).toContain('main')
    expect(holder.textContent).toContain('主树（外部 space）')
    expect(holder.textContent).toContain('同仓库树')
    expect(holder.textContent).toContain('feat/payment')
    // no-git variant
    await act(async () => {
      hoverRoot.render(<WorkspaceHoverContent label="hammerspoon" cwd="/Users/u/.hammerspoon" createdAt={NOW} t={t} git={null} />)
    })
    expect(holder.textContent).toContain('未检测到 git 仓库')
    await act(async () => { hoverRoot.unmount() })
    holder.remove()
  })

  it('offers "continue in another tree" from the row menu and starts a session there', async () => {
    await renderBrowser()
    const acmeRow = rowsByLabel('acme')[0]!
    const menuButton = acmeRow.querySelector<HTMLButtonElement>('button[aria-label*="acme"]')
    expect(menuButton).not.toBeNull()
    await act(async () => { menuButton!.click() })
    await act(async () => { await Promise.resolve() })
    // portal menu: the section label and the peer tree entry
    const bodyText = document.body.textContent ?? ''
    expect(bodyText).toContain('在目标树继续…')
    const treeEntry = [...document.body.querySelectorAll<HTMLElement>('*')]
      .filter(el => el.children.length === 0 && el.textContent === 'feat/payment')
      .pop()
    expect(treeEntry).toBeDefined()
    await act(async () => { treeEntry!.click() })
    await act(async () => { await Promise.resolve() })
    // title carry-over: the source row (acme) has no current session in this
    // fixture, so its first visible session title travels along.
    expect(latestProps.continueInWorkspace).toHaveBeenCalledWith(W('w-pay'), '初始化脚手架')
  })

  it('falls back to the built-in shape when the probe is unavailable', async () => {
    await renderBrowser(null)
    expect(text()).not.toContain('棵')
    expect(container.querySelector('[class*="gitPill"]')).toBeNull()
    expect(container.querySelectorAll('[class*="workspaceRow"]').length).toBeGreaterThan(0)
  })

  it('keeps the branch off mirror workspace rows (hover card only)', async () => {
    await renderBrowser(PROBE, new Map([[REMOTE_PATH, REMOTE_MARKER]]))
    const remote = rowsByLabel('my-remote')[0]!
    // user feedback: no branch tag on the row — marker state lives in the
    // hover card (remote section), covered by the hover-card spec below
    expect(remote.querySelector('[class*="gitPillRemote"]')).toBeNull()
    expect(remote.querySelector('[class*="gitPill"]')).toBeNull()
    expect(remote.textContent).not.toContain('⎇')
    expect(remote.textContent).not.toContain('dev')
    // the session aggregate never renders for remote rows either
    expect(remote.querySelector('[class*="gitPillMulti"]')).toBeNull()
    // local workspaces follow the same no-branch-tag rule
    const pay = rowsByLabel('feat-payment')[0]!
    expect(pay.textContent).not.toContain('feat/payment')
    expect(pay.querySelector('[class*="gitPill"]')).toBeNull()
    // no-git workspace: still no pill
    expect(rowsByLabel('hammerspoon')[0]?.querySelector('[class*="gitPill"]')).toBeNull()
  })

  it('shows the remote section on the mirror hover card (branch/sync/machine/path; no counts)', async () => {
    const holder = document.createElement('div')
    document.body.appendChild(holder)
    const hoverRoot = createRoot(holder)
    await act(async () => {
      hoverRoot.render(
        <WorkspaceHoverContent
          label="my-remote"
          cwd={REMOTE_PATH}
          createdAt={NOW}
          t={t}
          // probed locally: no .git → git null; the REMOTE marker still renders
          git={null}
          remote={REMOTE_MARKER}
        />,
      )
    })
    const card = holder.textContent ?? ''
    expect(card).toContain('⎇')
    expect(card).toContain('dev')
    // user feedback: dirty/staged counts are gone from the card
    expect(card).not.toContain('·3')
    expect(card).not.toContain('暂存')
    expect(card).toContain('同步')
    expect(card).toContain('↑2 ↓1')
    expect(card).toContain('远端')
    expect(card).toContain('root@1.2.3.4')
    expect(card).toContain('远端路径')
    expect(card).toContain('/srv/acme')
    // the remote section REPLACES the no-git notice
    expect(card).not.toContain('未检测到 git 仓库')
    await act(async () => { hoverRoot.unmount() })
    holder.remove()
  })

  it('groups mirror workspaces into their remote repo in the repo view (no row pill)', async () => {
    await renderBrowser(PROBE, new Map([[REMOTE_PATH, REMOTE_MARKER]]))
    await act(async () => { instance.actions.setGroupBy('repo') })
    await rerender()
    const remote = rowsByLabel('my-remote')[0]
    expect(remote).toBeDefined()
    // the branch lives in the hover card, not on the repo-view row either
    expect(remote?.querySelector('[class*="gitPillRemote"]')).toBeNull()
    expect(remote?.textContent).not.toContain('⎇')
    // the remote repo group row (named by the remote root basename) exists
    const repoRows = [...container.querySelectorAll<HTMLElement>('[class*="repoRow"]')]
    expect(repoRows.some(row => row.textContent?.includes('acme'))).toBe(true)
  })

  it('renders nothing remote when the marker source degrades (offline / not a mirror)', async () => {
    await renderBrowser(PROBE, new Map())
    const remote = rowsByLabel('my-remote')[0]!
    expect(remote.querySelector('[class*="gitPillRemote"]')).toBeNull()
    expect(remote.textContent).not.toContain('⎇')
  })
})

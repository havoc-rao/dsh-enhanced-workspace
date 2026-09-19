// @vitest-environment jsdom
/**
 * Real-runtime integration of the sidebar's amber waiting dot: the REAL
 * `UiSession` pending-interaction seat (loaded from the published
 * dsh-client-ui-session client bundle through the loader shim, exactly like
 * tests/harness/runtime-client.ts) + a LIVE `useSessionPendingInteraction`
 * selector hook (the useSyncExternalStore bridge the ui-renderer binds for
 * every slot) + the REAL EnhancedWorkspaceBrowser.
 *
 * This proves the end-to-end contract behind the "黄点事件": whatever
 * publishes a `kind: 'approval'` entry into the ui-session pending map —
 * ui-approval's `PendingApproval` (the composer panel's 等待审批) or this
 * plugin's own audit-trail fallback seat — the workspace/busy marker and the
 * session row flip from the blue loading dot to the amber waiting dot,
 * synchronously with the map; settling the ask flips them back.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import * as cordis from '@deepseek-ai/cordis'
import * as storeNs from '@deepseek-ai/dsh-client-store'
import * as slotsNs from '@deepseek-ai/dsh-client-ui-slots'
import * as ReactNs from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { PendingInteractionPublisher, SessionPendingInteractionBase } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionPendingInteraction, SessionPendingInteractionSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import { EnhancedWorkspaceBrowser } from '../src/client/Browser.tsx'
import type { EnhancedWorkspaceBrowserProps } from '../src/client/contract.ts'
import { DIRECTORY_FLOW_SLOT, SEARCH_SLOT, type EnhancedDirectoryFlowOwnerProps } from '../src/client/contract.ts'
import { zh } from '../src/client/locales.ts'
import type { EnhancedWorkspaceState } from '../src/client/store.ts'
import { createEnhancedWorkspaceStore } from '../src/client/store.ts'

// ── 从真实 client bundle 里装载真正的 UiSession ────────────────────────
interface LoaderRecord {
  id: string
  factory: (require: (specifier: string) => unknown) => unknown
}

let captured: Record<string, unknown> = {}

function requireFromLoader(specifier: string): unknown {
  if (specifier === '@deepseek-ai/cordis') return cordis
  if (specifier === '@deepseek-ai/dsh-client-store') return storeNs
  if (specifier === '@deepseek-ai/dsh-client-ui-slots') return slotsNs
  if (specifier === 'react/jsx-runtime') return jsxRuntime
  if (specifier === 'react') return ReactNs
  throw new Error(`ui-session test loader: unmapped dependency '${specifier}'`)
}

const loaderWindow = {
  __ModuleLoader__: {
    load(record: LoaderRecord): void {
      captured = (record.factory(requireFromLoader) ?? {}) as Record<string, unknown>
    },
  },
} as unknown as Window

const requireLocal = createRequire(import.meta.url)
const sessionPkgJsonPath = requireLocal.resolve('@deepseek-ai/dsh-client-ui-session/package.json')
const sessionBundleSource = readFileSync(join(dirname(sessionPkgJsonPath), 'lib', 'client.js'), 'utf8')
new Function('window', sessionBundleSource)(loaderWindow)

interface RealUiSession {
  pendingInteractions: {
    getSnapshot: () => SessionPendingInteractionSnapshot
    subscribe: (listener: () => void) => () => void
  }
  registerPendingInteraction<T extends SessionPendingInteractionBase>(
    precedence: (interaction: T) => number,
  ): PendingInteractionPublisher<T>
}

const UiSession = captured.UiSession as unknown as new (
  ctx: unknown,
  sessions: unknown,
) => RealUiSession

// ── 浏览器 fixture（沿用 browser.client.spec.tsx 的姿势）────────────────
const NOW = Date.now()

function session(id: string, title: string, ageMs: number, running: boolean): SessionSummary {
  return {
    id: id as SessionId,
    displayTitle: title,
    blank: false,
    running,
    completed: !running,
    updatedAt: NOW - ageMs,
  }
}

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

const WORKSPACES = [workspace('w-art', '绘画收集', ['s1', 's2'])]
const SESSIONS_BY_ID: Record<string, SessionSummary> = {
  s1: session('s1', '画布草图', 1000, true), // running → blue loading dot
  s2: session('s2', '配色研究', 2000, false),
}
const SESSIONS_STATE: SessionListState = {
  ids: ['s1', 's2'].map(id => id as SessionId),
  byId: SESSIONS_BY_ID,
  current: 's1' as SessionId,
  phase: 'ready',
  subagentsByParent: {},
  jobsBySession: {},
  currentAddress: undefined,
}

const t = ((key: string, params?: Record<string, string | number>): string => {
  const template = zh[key as keyof typeof zh]
  if (template === undefined) return key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (whole, name: string) =>
      params[name] === undefined ? whole : String(params[name]))
}) as unknown as EnhancedWorkspaceBrowserProps['t']

function makeProps(
  uiSession: RealUiSession,
  useSessionPendingInteraction: NonNullable<EnhancedWorkspaceBrowserProps['useSessionPendingInteraction']>,
  instance: ReturnType<ReturnType<typeof createEnhancedWorkspaceStore>['create']>,
): EnhancedWorkspaceBrowserProps {
  return {
    wide: true,
    expandSidebar: vi.fn(),
    useWorkspaces: (selector: (snapshot: { items: WorkspaceView[]; archivedSessionIds: never[]; state: string; phase: string; baselinesReady: boolean }) => unknown) => selector({
      items: WORKSPACES,
      archivedSessionIds: [],
      state: 'ready',
      phase: 'ready',
      baselinesReady: true,
    }),
    useSessions: (selector: (snapshot: SessionListState) => unknown) => selector(SESSIONS_STATE),
    useSessionPendingInteraction,
    useStore: (selector: (snapshot: EnhancedWorkspaceState) => unknown) =>
      useSyncExternalStore(instance.store.subscribe, () => selector(instance.getSnapshot() as EnhancedWorkspaceState)),
    actions: instance.actions,
    t,
    useDirectoryFlow: (selector: (occupied: boolean) => unknown) => selector(false),
    useFileTreeUi: (selector: (value: unknown) => unknown) => selector(undefined),
    renderSlot: ((key: string, owner: unknown) => {
      if (key === SEARCH_SLOT) return null
      void (owner as EnhancedDirectoryFlowOwnerProps)
      void DIRECTORY_FLOW_SLOT
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
    createWorkspace: vi.fn(async () => { throw new Error('unused') }),
    pickDirectory: vi.fn(async () => null),
    probeGit: vi.fn(async () => null),
    remoteGit: {
      fetchMarkers: vi.fn(async () => new Map()),
      refresh: vi.fn(async () => new Map()),
    },
    continueInWorkspace: vi.fn(async () => undefined),
    persistence: { load: vi.fn(async () => null), save: vi.fn(async () => undefined) },
  } as unknown as EnhancedWorkspaceBrowserProps
}

/** Mount one browser over a fresh store + the REAL UiSession seat. */
async function mount(uiSession: RealUiSession): Promise<{
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
  instance: ReturnType<ReturnType<typeof createEnhancedWorkspaceStore>['create']>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const instance = createEnhancedWorkspaceStore().create()
  const useLivePending: NonNullable<EnhancedWorkspaceBrowserProps['useSessionPendingInteraction']> = <S,>(
    selector: (snapshot: SessionPendingInteractionSnapshot) => S,
  ) => selector(
    useSyncExternalStore(
      (listener) => uiSession.pendingInteractions.subscribe(listener),
      () => uiSession.pendingInteractions.getSnapshot(),
      () => uiSession.pendingInteractions.getSnapshot(),
    ) as SessionPendingInteractionSnapshot,
  )
  await act(async () => {
    root.render(<EnhancedWorkspaceBrowser {...makeProps(uiSession, useLivePending, instance)} />)
  })
  return { container, root, instance }
}

/** The collapsed-dir status dot of one workspace row (the recency row shows
 *  busy markers while folded): its StateDot's data-state, or null. */
function busyDotOf(container: HTMLDivElement, workspaceTitle: string): HTMLElement | null {
  const row = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
    .find(candidate => candidate.textContent?.includes(workspaceTitle))!
  return row.querySelector('[data-state]')
}

/** The recency section's FIRST session row (after expanding its workspace). */
function recencySessionRow(container: HTMLDivElement, title: string): HTMLElement {
  const section = [...container.querySelectorAll('section')]
    .find(section => section.querySelector('h3')?.textContent === zh.recents)!
  return [...section.querySelectorAll<HTMLElement>('[class*="sessionRow"]')]
    .find(row => row.textContent?.includes(title))!
}

describe('real ui-session pending seat → sidebar amber dot', () => {
  it('flips the workspace busy marker and the session row from blue to amber when an approval entry lands, and back when it settles', async () => {
    const fakeSessions = {
      list: {
        getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {} }),
        subscribe: () => () => {},
      },
    }
    const ctx = new cordis.Context()
    const uiSession = new UiSession(ctx, fakeSessions)
    const { container } = await mount(uiSession)

    // Running + no pending → the collapsed workspace row carries the BLUE
    // loading dot ('1 个会话正在工作').
    const busy = busyDotOf(container, '绘画收集')
    expect(busy?.getAttribute('data-state'), 'running workspace marker starts blue').toBe('ongoing')

    // A `kind: 'approval'` entry on the REAL seat — exactly what ui-approval's
    // PendingApproval (composer 等待审批 panel) publishes — must flip the
    // workspace marker to amber, synchronously with the map.
    const publish = uiSession.registerPendingInteraction<SessionPendingInteraction>(
      () => -1,
    )
    let remove: () => void
    act(() => {
      remove = publish(
        { key: 'approval:1', kind: 'approval', sessionId: 's1' as SessionId },
        async () => undefined,
      )
    })
    const amber = busyDotOf(container, '绘画收集')
    expect(amber?.getAttribute('data-state'), 'the approval entry turns the workspace marker amber').toBe('warning')

    // Settling the approval removes the entry → the blue dot is correct again
    // (the tool is genuinely running once more).
    act(() => { remove() })
    expect(busyDotOf(container, '绘画收集')?.getAttribute('data-state'), 'settled approval returns the blue marker').toBe('ongoing')
  })

  it('shows the amber dot and the escalation shield on the expanded session row through the real seat', async () => {
    const fakeSessions = {
      list: {
        getSnapshot: () => ({ ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {} }),
        subscribe: () => () => {},
      },
    }
    const ctx = new cordis.Context()
    const uiSession = new UiSession(ctx, fakeSessions)
    const { container } = await mount(uiSession)
    // Expand the recency workspace row so its session rows enter the DOM.
    act(() => {
      const recencyRow = [...container.querySelectorAll<HTMLElement>('[role="treeitem"]')]
        .find(candidate => candidate.textContent?.includes('绘画收集'))!
      recencyRow.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const row = recencySessionRow(container, '画布草图')
    expect(row.querySelector('[data-state="ongoing"]'), 'running session row starts on the blue loading dot').not.toBeNull()

    const publish = uiSession.registerPendingInteraction<SessionPendingInteraction>(
      () => -1,
    )
    act(() => {
      publish(
        {
          key: 'approval:2',
          kind: 'approval',
          sessionId: 's1' as SessionId,
          reason: 'escalate sandbox to workspace-write: fixture',
        },
        async () => undefined,
      )
    })
    expect(row.querySelector('[data-state="warning"]'), 'the approval entry turns the session row amber').not.toBeNull()
    expect(row.querySelector('[data-state="ongoing"]'), 'the blue loading dot is gone while waiting').toBeNull()
    expect(row.textContent).toContain(zh.sessionStatusEscalation)
    expect(row.querySelector('[class*="escalationMark"]'), 'the shield mark rides the real seat').not.toBeNull()
  })
})
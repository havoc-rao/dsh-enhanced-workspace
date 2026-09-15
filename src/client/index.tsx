/**
 * Enhanced workspace browser, client half: shadows the built-in
 * `sidebar.workspaces` region (priority -1 — "lowest renders" wins the
 * single slot cell over ui-workspace's default 0) with the recency module,
 * the folder tree, and the flat list. The registration declares its own
 * store seat, inject face, locale namespace — and ONE child slot, the
 * plugin-owned directory-flow hole (`enhanced-workspace.workspace.directoryFlow`)
 * the add entry renders when a picker package occupies it (native
 * `pickDirectory` fallback otherwise). It deliberately does NOT re-declare
 * the built-in entry's sub-slots (`directoryFlow` / `workspaceIcon` /
 * `workspaceMenu` / `workspaceHoverIcon`): they stay declared by the built-in
 * entry — which shadows ≠ unloads, so re-declaring them would throw (one
 * declarer per slot key), and a declaration-less entry has no render
 * authorization for them (see the design doc §7).
 * @module dsh-enhanced-workspace/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
// Type-only (erased — never reaches the purity gate): the client Connection
// handle that carries the generic RPC caller. `ctx.connection` itself is not
// typed on the client Context, so the handle is read like the gateway does —
// `ctx.get('connection')` with this explicit face.
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls ui-sidebar's SlotMap merge — it declares the
// 'sidebar.workspaces' owner share (wide/expandSidebar) into the uislots
// SlotMap that register() constrains its keys against.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the SlotRegistry service merge (`ctx.slots`).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Workspace selector share (`useWorkspaces`) into
// GlobalStandardProps.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the Session selector shares (`useSessions`,
// `useSessionPendingInteraction`) into GlobalStandardProps.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls ui-workspace's Context merge (`ctx.uiWorkspace`, the
// workspace navigation service carrying startSession/pickDirectory).
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls dsh-client-locale's Context merge — `ctx.locale` (the
// LocaleRuntime registering this plugin's dictionary) is declared there.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { EnhancedWorkspaceBrowser } from './Browser.tsx'
import {
  DIRECTORY_FLOW_SLOT,
  FILE_TREE_UI_SERVICE,
  FILE_TREE_UI_PROTOCOL_VERSION,
  resolveFileTreeUiServiceV1,
  SEARCH_SLOT,
  searchHandle,
  type EnhancedWorkspaceInjected,
  type EnhancedWorkspacePersistence,
} from './contract.ts'
import type { FileTreeUiServiceV1 } from 'dsh-file-tree-ui/client-contract'
import { NS, en, zh, type EnhancedWorkspaceKey } from './locales.ts'
import { createGitProbe, createPersistence } from './persistence.ts'
import { createRemoteGitSource } from './remote-git.ts'
import { createEnhancedWorkspaceStore } from './store.ts'

export type { EnhancedWorkspaceBrowserProps, EnhancedWorkspaceInjected } from './contract.ts'
export type { EnhancedWorkspaceKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The enhanced workspace browsing region copy. */
    enhancedWorkspace: EnhancedWorkspaceKey
  }
}

/**
 * Dev-only component → source locator (dsh-code-finder, B 档接入): the
 * tsdown `define` bakes `process.env.NODE_ENV` into a literal, so this block
 * is statically dead (tree-shaken) in production builds, and `setupCodeFinder`
 * is itself a runtime no-op outside development — zero production footprint.
 *
 * Hold Opt+Shift and hover any React element → overlay shows
 * `Component  file:line:col` (via the `codeFinderTsdown()` build-time
 * `data-locatorjs` attributes / dev fiber info); click copies the location.
 */
if (process.env.NODE_ENV === 'development') {
  // Client bundles are CJS module-loader factories — no top-level await.
  void import('@havocrao/dsh-code-finder/runtime').then(({ setupCodeFinder }) => {
    setupCodeFinder({})
  })
}

/** How long the title carry-over waits for the fresh session id to land. */
const CONTINUE_TITLE_WAIT_MS = 3000

/** The consumer-side diagnostic text (provider contract header recipe,
 *  Chinese, one-shot per degraded episode to avoid console spam). */
const FILE_TREE_UI_DIAGNOSTIC = '[dsh-file-tree-ui] 服务缺失或协议不兼容：'
  + `fileTreeUi 应为 v${FILE_TREE_UI_PROTOCOL_VERSION}（renderRow/`
  + 'renderGuideLayer/renderRowMenu 均为函数）；当前值将被忽略并回退本地渲染。'

/**
 * Build the snapshot reader for the OPTIONAL fileTreeUi v1 service seat.
 *
 * The service is never declared in this plugin's cordis `inject` array
 * (cordis has no optional inject — a hard injection would fail the whole
 * page for users who upgraded the consumer without the provider). Instead
 * the seat is a snapshot/subscribe pair: the reader re-reads
 * `ctx.get('fileTreeUi')` on every snapshot call (each fiber activation
 * re-reads — no handle is cached across lifecycles; provider unload flips
 * the snapshot back to undefined) and the `internal/service` event tracks
 * provide/unload changes. Missing / protocol-mismatched / unloaded values
 * resolve to undefined and the diagnostic warns exactly once per degraded
 * episode (a later valid read re-arms the warning).
 * @param get - the raw service getter (bound to the live ctx).
 * @param warn - diagnostic sink (console.warn in production).
 * @returns the snapshot reader.
 */
export function createFileTreeUiResolver(
  get: () => unknown,
  warn: (message: string) => void = message => console.warn(message),
): () => FileTreeUiServiceV1 | undefined {
  let degraded = false
  return () => {
    const resolved = resolveFileTreeUiServiceV1(get())
    if (resolved !== undefined) {
      degraded = false
      return resolved
    }
    if (!degraded) {
      degraded = true
      warn(FILE_TREE_UI_DIAGNOSTIC)
    }
    return undefined
  }
}

/**
 * Poll the observable sessions list until an id outside `before` appears.
 * Resolves undefined on timeout (startSession's blank-reuse path yields no
 * new id, and a missing rename is better than renaming someone else's row).
 */
async function waitForNewSessionId(
  list: { getSnapshot: () => { ids: readonly (string & {})[] } },
  before: ReadonlySet<string>,
  timeoutMs: number,
): Promise<SessionId | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const fresh = list.getSnapshot().ids.find(id => !before.has(id as string))
    if (fresh !== undefined) return fresh as SessionId
    if (Date.now() > deadline) return undefined
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

/**
 * Required services (cordis fiber inject). The target slot is declared by
 * the built-in ui-workspace, whose activation order relative to this one is
 * NOT constrained — `slots.inject()` covers the slot declaration itself, and
 * `uiWorkspace` (the navigation service carrying startSession/pickDirectory)
 * is listed so this fiber waits for it too, the same convention every
 * in-harness consumer of the service follows (ui-sidebar, ui-conversation,
 * ui-directory-picker-browse).
 */
export const inject = ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'locale', 'connection']

/**
 * Register the enhanced browser once the slot declaration is on the ledger
 * (the inject call waits for it). The inject factory returns plain callbacks
 * bound to the runtime services; data reads use the framework hooks.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-enhanced-workspace: dictionaries')

  // Resolve the service at call time; a captured absent handle must not
  // permanently disable persistence after the connection becomes available.
  const buildPersistence = (): EnhancedWorkspacePersistence => createPersistence(
    () => ctx.get('connection') as ConnectionHandle | undefined,
  )
  const probeGit = createGitProbe(
    () => ctx.get('connection') as ConnectionHandle | undefined,
  )
  // Remote-mirror git markers: the browser half fetches the dsh-remote
  // endpoint directly (same origin); the source owns the per-path memo/TTL
  // and the silent-degrade posture.
  const remoteGit = createRemoteGitSource()

  // Optional fileTreeUi v1 service seat: one per apply() (per fiber
  // lifecycle), so the warn-once state survives repeated snapshot reads
  // while the reader itself never caches a service handle across
  // activations — getSnapshot re-reads ctx.get every call.
  const readFileTreeUi = createFileTreeUiResolver(() => ctx.get(FILE_TREE_UI_SERVICE))

  const injected = (): EnhancedWorkspaceInjected => ({
    // Picking-share hooks compartment: the renderer binds `directoryFlow`
    // into the `useDirectoryFlow` selector hook on the browser props, so the
    // add entry reacts to the hole's occupancy (hide nothing, but switch
    // between the occupant's picking interaction and the native fallback).
    hooks: {
      directoryFlow: {
        getSnapshot: () => ctx.slots.entries(DIRECTORY_FLOW_SLOT).length > 0,
        subscribe: listener => ctx.slots.subscribe(DIRECTORY_FLOW_SLOT, listener),
      },
      // The optional fileTreeUi v1 service seat (see createFileTreeUiResolver
      // above): a snapshot/subscribe pair. The readonly `internal/service`
      // bus fires on every provide/unload change; the snapshot re-reads the
      // live value each time, so a late provider arrival lights up the rows
      // without a remount and an unload falls back to the local rendering.
      fileTreeUi: {
        getSnapshot: () => readFileTreeUi(),
        subscribe: listener => ctx.on('internal/service', listener),
      },
    },
    startSession: (workspaceId) => { ctx.uiWorkspace.startSession(workspaceId) },
    open: (sessionId) => { ctx.sessions.open(sessionId) },
    renameSession: async (sessionId, title) => {
      const session = ctx.sessions.binding(sessionId)?.session
      if (session === undefined) throw new Error(`unknown session "${sessionId}"`)
      const result = await session.rename(title)
      if (!result.ok) throw new Error(result.error.message)
    },
    forkSession: (sessionId) => {
      ctx.sessions.fork({ sessionId, increaseTitle: true })
        .then((childId) => { ctx.sessions.open(childId) })
        .catch(() => {
          // Fork or child-rename failure keeps the current selection.
        })
    },
    renameWorkspace: async (workspaceId, title) => { await ctx.workspaces.rename(workspaceId, title) },
    deleteWorkspace: async (workspaceId) => { await ctx.workspaces.delete(workspaceId) },
    insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
      await ctx.workspaces.insertBefore(workspaceId, beforeWorkspaceId)
    },
    archiveSession: async (sessionId) => { await ctx.workspaces.archiveSession(sessionId) },
    insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
      await ctx.workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId)
    },
    createWorkspace: input => ctx.workspaces.create(input),
    pickDirectory: () => ctx.uiWorkspace.pickDirectory(),
    probeGit,
    remoteGit,
    // The client sessions face is read-only (+ open); starting a session in
    // a workspace is the workspaces service verb — the same call the row's
    // plus button and Cmd/Ctrl+N use.
    continueInWorkspace: async (workspaceId, title) => {
      // The client sessions face is read-only and startSession returns void,
      // so the fresh session is located by diffing the observable list ids.
      // A reused blank session (startSession's reuse path) produces no new
      // id: the carry-over is then skipped rather than renaming a stranger.
      const list = ctx.sessions.list
      const before = new Set<string>(list.getSnapshot().ids.map(id => id as string))
      ctx.uiWorkspace.startSession(workspaceId)
      if (title === undefined || title.trim() === '') return
      const fresh = await waitForNewSessionId(list, before, CONTINUE_TITLE_WAIT_MS)
      if (fresh === undefined) return
      const session = ctx.sessions.binding(fresh)?.session
      if (session !== undefined) await session.rename(title)
    },
    persistence: buildPersistence(),
  })

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      priority: -1,
      // The enhanced browser declares its OWN directory-flow hole (plugin
      // namespace). The official `sidebar.workspaces.directoryFlow` key is
      // declared by the built-in entry, which stays on the ledger under
      // shadowing — re-declaring it throws (one declarer per slot key) and a
      // declaration-less entry has no render authorization for it; the logo
      // sub-slots share the same fate (design doc §7.1).
      //
      // The search hole rides the same convention. Its common `inject` face
      // publishes the live `EnhancedSearchHandle` to every occupant AND to
      // any plugin that waits on the declaration through
      // `ctx.slots.inject(SEARCH_SLOT, …)`; `searchHandle` is the same
      // singleton mirrored on `window.__DSH_ENHANCED_WORKSPACE__` and on the
      // search input's stable DOM attribute — the three external trigger
      // paths documented in contract.ts.
      children: {
        [DIRECTORY_FLOW_SLOT]: { kind: 'single', scope: 'root' },
        [SEARCH_SLOT]: { kind: 'single', scope: 'root', inject: searchHandle },
      },
      store: createEnhancedWorkspaceStore(),
      inject: injected,
      locale: NS,
      registrant: 'dsh-enhanced-workspace',
    },
    EnhancedWorkspaceBrowser,
  ))
}
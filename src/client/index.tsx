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

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only (erased — never reaches the purity gate): the client Connection
// handle that carries the generic RPC caller. `ctx.connection` itself is not
// typed on the client Context, so the handle is read like the gateway does —
// `ctx.get('connection')` with this explicit face.
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls ui-sidebar's SlotMap merge — it declares the
// 'sidebar.workspaces' owner share (wide/expandSidebar) into the uislots
// SlotMap that register() constrains its keys against.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls dsh-client-locale's Context merge — `ctx.locale` (the
// LocaleRuntime registering this plugin's dictionary) is declared there.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { EnhancedWorkspaceBrowser } from './Browser.tsx'
import {
  DIRECTORY_FLOW_SLOT,
  type EnhancedWorkspaceInjected,
  type EnhancedWorkspacePersistence,
} from './contract.ts'
import { NS, en, zh, type EnhancedWorkspaceKey } from './locales.ts'
import { createGitProbe, createPersistence } from './persistence.ts'
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

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'sessions', 'workspaces', 'locale', 'connection']

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
    },
    startSession: (workspaceId) => { ctx.workspaces.startSession(workspaceId) },
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
    pickDirectory: () => ctx.workspaces.pickDirectory(),
    probeGit,
    // The client sessions face is read-only (+ open); starting a session in
    // a workspace is the workspaces service verb — the same call the row's
    // plus button and Cmd/Ctrl+N use.
    continueInWorkspace: async (workspaceId) => {
      ctx.workspaces.startSession(workspaceId)
    },
    persistence: buildPersistence(),
  })

  ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      priority: -1,
      // The enhanced browser declares its OWN directory-flow hole (plugin
      // namespace). The official `sidebar.workspaces.directoryFlow` key is
      // declared by the built-in entry, which stays on the ledger under
      // shadowing — re-declaring it throws (one declarer per slot key) and a
      // declaration-less entry has no render authorization for it; the logo
      // sub-slots share the same fate (design doc §7.1).
      children: {
        [DIRECTORY_FLOW_SLOT]: { kind: 'single', scope: 'root' },
      },
      store: createEnhancedWorkspaceStore(),
      inject: injected,
      locale: NS,
      registrant: 'dsh-enhanced-workspace',
    },
    EnhancedWorkspaceBrowser,
  )
}
/**
 * Enhanced workspace browser, client half: shadows the built-in
 * `sidebar.workspaces` region (priority -1 — "lowest renders" wins the
 * single slot cell over ui-workspace's default 0) with the recency module,
 * the folder tree, and the flat list. The registration declares its own
 * store seat, inject face, and locale namespace; it deliberately declares NO
 * child slots — the built-in entry keeps its declarations, and re-declaring
 * them would throw (one declarer per slot), which is also why the logo
 * plugin's row holes are unavailable in shadow mode (see the design doc §7).
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
import type { EnhancedWorkspaceInjected, EnhancedWorkspacePersistence } from './contract.ts'
import { NS, en, zh, type EnhancedWorkspaceKey } from './locales.ts'
import { isPersistedViewState } from './model.ts'
import {
  PERSISTENCE_CHANNEL,
  PERSISTENCE_LOAD_ENDPOINT,
  PERSISTENCE_LOCAL_FALLBACK_KEY,
  PERSISTENCE_SAVE_ENDPOINT,
} from '../shared/persistence.ts'
import { createEnhancedWorkspaceStore, type EnhancedWorkspaceState } from './store.ts'

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

  /**
   * Build the persistence face: the Host's durable envelope file first (via
   * the plugin's own Connection RPC channel — the desktop app binds the
   * webserver to an OS-assigned port per launch, so localStorage is
   * origin-scoped and worthless across restarts), with the legacy
   * localStorage key as a best-effort same-origin fallback. A failed host
   * read never breaks the browser: loading falls back and saving degrades
   * to the fallback key (which may be lost on the next launch, but the
   * tree stays usable within the session).
   */
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const buildPersistence = (): EnhancedWorkspacePersistence => {
    const loadFromHost = async (): Promise<EnhancedWorkspaceState | null> => {
      try {
        const result = await connection?.rpc.call(PERSISTENCE_CHANNEL, PERSISTENCE_LOAD_ENDPOINT, {})
        if (result === undefined) return null
        if (!result.ok) return null
        const envelope = result.value
        return envelope !== null && envelope !== undefined && isPersistedViewState(envelope) ? envelope : null
      } catch (error) {
        console.warn('dsh-enhanced-workspace: host envelope load failed, using fallback storage', error)
        return null
      }
    }
    const loadFromLocal = (): EnhancedWorkspaceState | null => {
      try {
        const raw = localStorage.getItem(PERSISTENCE_LOCAL_FALLBACK_KEY)
        if (raw === null) return null
        const parsed: unknown = JSON.parse(raw)
        return isPersistedViewState(parsed) ? parsed : null
      } catch (error) {
        console.warn('dsh-enhanced-workspace: fallback envelope load failed', error)
        return null
      }
    }
    const saveToHost = async (state: EnhancedWorkspaceState): Promise<boolean> => {
      try {
        const result = await connection?.rpc.call(PERSISTENCE_CHANNEL, PERSISTENCE_SAVE_ENDPOINT, { state })
        if (result === undefined) return false
        if (result.ok) return true
        console.warn('dsh-enhanced-workspace: host envelope save rejected', result.error)
        return false
      } catch (error) {
        console.warn('dsh-enhanced-workspace: host envelope save failed, using fallback storage', error)
        return false
      }
    }
    const saveToLocal = (state: EnhancedWorkspaceState): void => {
      try {
        localStorage.setItem(PERSISTENCE_LOCAL_FALLBACK_KEY, JSON.stringify(state))
      } catch (error) {
        console.warn('dsh-enhanced-workspace: fallback envelope save failed', error)
      }
    }
    return {
      load: async () => (await loadFromHost()) ?? loadFromLocal(),
      save: async (state) => {
        if (!(await saveToHost(state))) saveToLocal(state)
      },
    }
  }

  const injected = (): EnhancedWorkspaceInjected => ({
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
    persistence: buildPersistence(),
  })

  ctx.slots.register(
    {
      name: 'sidebar.workspaces',
      priority: -1,
      store: createEnhancedWorkspaceStore(),
      inject: injected,
      locale: NS,
      registrant: 'dsh-enhanced-workspace',
    },
    EnhancedWorkspaceBrowser,
  )
}
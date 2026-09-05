/**
 * The enhanced browser's inject face and composed props. The registration
 * supplies the business actions (bound to `ctx.workspaces` / `ctx.sessions`
 * in `index.tsx`); the component receives them plus its own store seat, the
 * sidebar owner share, and the locale `t` — the four-share composition of the
 * ui-slots contract.
 * @module dsh-enhanced-workspace/client/contract
 */

import type {
  SessionId,
  WorkspaceId,
  WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
  PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { createEnhancedWorkspaceStore, EnhancedWorkspaceState } from './store.ts'
import type { NS } from './locales.ts'

/**
 * Origin-independent persistence face of the enhanced browser: loading and
 * storing the whole viewing state (the envelope) through the Host-side file
 * (`~/.dsh/storages/dsh-enhanced-workspace.json`). The implementations
 * route over the plugin's `/enhanced-workspace` Connection RPC channel with
 * a localStorage fallback; the browser never touches storage directly.
 */
export interface EnhancedWorkspacePersistence {
  /** Load the stored envelope; null only when storage is confirmed empty; failures reject. */
  load(): Promise<EnhancedWorkspaceState | null>
  /** Store the current envelope wholesale (the caller owns debouncing). */
  save(state: EnhancedWorkspaceState): Promise<void>
}

/**
 * Registrant business face of the enhanced browser region. Data reads use
 * the framework hooks; these are the Host actions the region drives.
 */
export interface EnhancedWorkspaceInjected {
  /** Start a New Session in a Workspace (reuse-or-create its blank session and open it). */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Open a real Session. */
  open: (sessionId: SessionId) => void
  /** Rename a Session (explicit user title; resolves on host acceptance). */
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  /** Fork a Session at its last completed turn and open the child. */
  forkSession: (sessionId: SessionId) => void
  /** Rename a Host Workspace (rejects on name conflict; resolves on durability). */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /** Delete only a Host Workspace registration; directory and Session logs remain. */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /** Reorder a Workspace in the durable registry display order (omitted anchor appends). */
  insertWorkspaceBefore: (workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId) => Promise<void>
  /** Archive a Session into the registry-global set: hidden from grouping surfaces. */
  archiveSession: (sessionId: SessionId) => Promise<void>
  /** Reorder a session inside its Workspace account (DOM-insertBefore semantics). */
  insertSessionBefore: (
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ) => Promise<void>
  /** Adopt a picked host directory as a real Workspace. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /** Open the Host's native directory picker. */
  pickDirectory: () => Promise<string | null>
  /** Durable envelope load/store (Host file first, localStorage fallback). */
  persistence: EnhancedWorkspacePersistence
}

/** Full browser props: sidebar owner share + viewing store + injected actions + the locale seat. */
export type EnhancedWorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsStore<ReturnType<typeof createEnhancedWorkspaceStore>>
  & InjectFace<EnhancedWorkspaceInjected>
  & PropsLocale<typeof NS>
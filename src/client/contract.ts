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
import type { GitProbeResultJSON } from '../shared/git.ts'
import type { RemoteGitSource } from './remote-git.ts'
import type {
  InjectFace,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
  PropsStore,
  HostObservable,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { createEnhancedWorkspaceStore, EnhancedWorkspaceState } from './store.ts'
import type { NS } from './locales.ts'

/**
 * The enhanced browser's own directory-flow hole. The official holes
 * (`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`)
 * are declared by the built-in ui-workspace entries, which stay on the ledger
 * forever under shadowing (shadow ≠ unload); ui-slots allows exactly ONE
 * declarer per slot key, so a shadowing entry can neither re-declare them
 * (register throws → plugin boot fails) nor render them (its `renderSlot`
 * face is narrowed to its own children declaration; anything else throws
 * `SlotOwnershipError`). This plugin therefore exposes its OWN hole under a
 * plugin-owned key; the add entry renders it exactly like the built-in
 * browser renders the official hole. Picker packages (e.g. dsh-remote) point
 * at this key in combined profiles via their build-time slot-key setting
 * (dsh-remote defaults to the official keys and switches on
 * `DSH_REMOTE_DIRECTORY_FLOW_SLOT`). The key string is the cross-plugin
 * protocol — both sides keep the literal in sync, and the local typecheck
 * enforces it here (register children + renderSlot are both constrained to
 * `SlotMap` keys).
 */
export const DIRECTORY_FLOW_SLOT = 'enhanced-workspace.workspace.directoryFlow' as const

/**
 * Owner share of the enhanced directory-flow hole: the complete conversation
 * between the trigger surface and the picking interaction. This mirrors the
 * official hole's contract verbatim (ui-workspace `DirectoryFlowOwnerProps`,
 * redeclared here because ui-workspace is not a dependency of this package):
 * the occupant owns everything between `open` and the picked path, the owner
 * owns adoption — an occupant written against either hole works against both.
 */
export interface EnhancedDirectoryFlowOwnerProps {
  /** True while a picking interaction is requested; flipping back to false withdraws the request. */
  open: boolean
  /** True while the owner adopts a picked path (`createWorkspace` in flight); occupants disable their commit affordances. */
  busy: boolean
  /** The operator picked a directory (absolute host path); the owner adopts it. */
  onPicked: (path: string) => void
  /** The operator dismissed the interaction; the owner just closes the flow. */
  onCancel: () => void
  /** The interaction itself failed (chooser missing, listing denied); the owner reports the failure. */
  onError: (message: string) => void
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Directory-flow hole under the enhanced sidebar browser (declared by the shadowing entry). */
    [DIRECTORY_FLOW_SLOT]: {
      kind: 'single'
      scope: 'root'
      owner: EnhancedDirectoryFlowOwnerProps
    }
  }
}

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
  /** Picking-share hooks compartment: the renderer binds each source into a
   *  `use<Name>` selector hook on the component props. */
  hooks: {
    /** True while the enhanced directory-flow hole is occupied by a picker package. */
    directoryFlow: HostObservable<boolean>
  }
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
  /**
   * Compute the git-repo index over a path list (workspace paths + session
   * cwds, deduped host-side). Resolves to null when the Connection is
   * unavailable or the probe failed. Callers treat null as "no git layer".
   */
  probeGit: (paths: readonly string[]) => Promise<GitProbeResultJSON | null>
  /**
   * Remote-mirror git markers (dsh-remote `GET /dsh-remote/git-workspace`):
   * branch + dirty state of the REMOTE repo behind a mirror workspace —
   * the mirror's local `.git` does not exist, so the local probe alone can
   * never see it. Fetches are memoized per path with a TTL and every
   * failure degrades to "no marker" (never blocks, never errors).
   */
  remoteGit: RemoteGitSource
  /**
   * Start a NEW session in a target workspace and open it — the "在目标树
   * 继续" verb. Honest semantics: a session's cwd is fixed at creation and
   * there is no cross-tree move API, so switching trees is a new session in
   * the target workspace, never a relocation. A source title (when given)
   * is carried over by renaming the freshly created session once it appears
   * in the sessions list.
   */
  continueInWorkspace: (workspaceId: WorkspaceId, title?: string) => Promise<void>
  /** Durable envelope load/store (Host file first, localStorage fallback). */
  persistence: EnhancedWorkspacePersistence
}

/** Full browser props: sidebar owner share + child-render share (the
 *  enhanced directory-flow hole) + viewing store + injected actions + the
 *  locale seat. */
export type EnhancedWorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsRenderSlots<typeof DIRECTORY_FLOW_SLOT>
  & PropsStore<ReturnType<typeof createEnhancedWorkspaceStore>>
  & InjectFace<EnhancedWorkspaceInjected>
  & PropsLocale<typeof NS>
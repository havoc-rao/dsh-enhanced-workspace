/**
 * The enhanced workspace browser's viewing store: the folder tree, the
 * per-folder expansion state, the recency touch timestamps, and the session
 * list viewing fields — persisted across surface remounts and reloads under
 * `dsh.enhanced-workspace.v1`. Module level exports the factory only (a
 * module-level handle would pin the store identity across plugin reloads);
 * the registration receives the factory's return type via its store
 * declaration.
 * @module dsh-enhanced-workspace/client/store
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  adoptWorkspaceIn,
  createFolderIn,
  deleteFolderIn,
  moveFolderIn,
  moveWorkspaceIn,
  renameFolderIn,
  restoredState,
  retainLiveKeys,
  type FolderId,
  type FolderTree,
  type LiveKeysSlice,
  type PersistedViewState,
  type SessionGroupBy,
  type SessionOrderBy,
} from './model.ts'
export type { SessionGroupBy, SessionOrderBy } from './model.ts'

/** Browser-local order account key for the hierarchy-free flat Session list. */
export const FLAT_SESSION_ORDER_KEY = '__flat_session_order__'

/**
 * Enhanced workspace browser viewing state (the persisted envelope). The
 * state is stored as one JSON file on the Host side (`~/.dsh/storages/`,
 * see `src/host/storage.ts`) — never localStorage, whose origin (the
 * webserver port) changes on every desktop launch.
 */
export type EnhancedWorkspaceState = PersistedViewState

/** Annotation twin of the actions literal below; drift fails assignability at the defineStore call. */
type EnhancedWorkspaceActions = {
  setGroupBy: (draft: EnhancedWorkspaceState, mode: SessionGroupBy) => void
  setOrderBy: (draft: EnhancedWorkspaceState, mode: SessionOrderBy) => void
  setGroupExpanded: (draft: EnhancedWorkspaceState, key: string, expanded: boolean) => void
  setFolderExpanded: (draft: EnhancedWorkspaceState, folderId: FolderId, expanded: boolean) => void
  /**
   * Collapse every expandable directory row: expanded folders AND workspace
   * session groups (recency rows included) fold back to the top-level
   * outline. The tree and the recency stamps themselves stay untouched.
   */
  collapseAll: (draft: EnhancedWorkspaceState) => void
  /**
   * Record a recency stamp at Date.now() — written only when a new query was
   * sent in the workspace (observed via {@link observeSessionActivity}; clicks
   * and opens never touch). Idempotent — one stamp per observation batch.
   */
  touchWorkspace: (draft: EnhancedWorkspaceState, workspaceId: WorkspaceId) => void
  syncSessionOrderAccount: (
    draft: EnhancedWorkspaceState,
    accountKey: string,
    order: string[],
    updatedAt: Record<string, number>,
  ) => void
  setSessionOrder: (draft: EnhancedWorkspaceState, accountKey: string, order: string[]) => void
  /** Create a folder under `parentFolderId`; validation throws the model errors. */
  createFolder: (draft: EnhancedWorkspaceState, parentFolderId: FolderId, name: string) => void
  /** Rename a folder; sibling-uniqueness and root protection throw the model errors. */
  renameFolder: (draft: EnhancedWorkspaceState, folderId: FolderId, name: string) => void
  /** Delete a folder, promoting its children into the parent; the root is protected. */
  deleteFolder: (draft: EnhancedWorkspaceState, folderId: FolderId) => void
  /** Move a folder (re-parent + sibling positioning); cycle/depth guards throw. */
  moveFolder: (
    draft: EnhancedWorkspaceState,
    folderId: FolderId,
    beforeFolderId?: FolderId,
    parentFolderId?: FolderId,
  ) => void
  /** Move a workspace into a folder at the anchor (omitted anchor appends). */
  moveWorkspaceIn: (
    draft: EnhancedWorkspaceState,
    workspaceId: WorkspaceId,
    targetFolderId: FolderId,
    beforeWorkspaceId?: WorkspaceId,
  ) => void
  /** Adopt a Host-created workspace at the root account head (idempotent). */
  adoptWorkspace: (draft: EnhancedWorkspaceState, workspaceId: WorkspaceId) => void
  /** Prune every dead workspace id after the Host baseline (one-way convergence). */
  retainLiveKeys: (draft: EnhancedWorkspaceState, liveWorkspaceIds: readonly WorkspaceId[]) => void
  /**
   * Restore the persisted envelope — the folder tree, the expansion maps,
   * the recency stamps, and the viewing mode — replacing the current state,
   * then converge onto the Host baseline (adopt live workspaces the
   * envelope does not know, prune dead ids, drop expansion keys of folders
   * the envelope does not hold). Throws `TypeError` on an invalid envelope.
   */
  restoreEnvelope: (draft: EnhancedWorkspaceState, envelope: unknown, liveWorkspaceIds: readonly WorkspaceId[]) => void
}

/** ISO-8601 now (a fresh stamp per action call). */
function now(): string {
  return new Date().toISOString()
}

/**
 * Create the enhanced workspace browser store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createEnhancedWorkspaceStore(): EngineStoreHandle<EnhancedWorkspaceState, EnhancedWorkspaceActions> {
  return defineStore({
    init: (): EnhancedWorkspaceState => ({
      folders: {
        root: {
          folderId: 'root' as FolderId,
          name: 'Root',
          parentFolderId: null,
          workspaceIds: [],
          folderIds: [],
          createdAt: '0',
          updatedAt: '0',
        },
      },
      folderExpansion: {},
      recentTouchById: {},
      groupBy: 'workspace',
      orderBy: 'updated',
      groupExpansion: {},
      sessionOrderByAccount: {},
      sessionUpdatedAtByAccount: {},
    }),
    // NOTE: no `persist` key. The desktop app binds its webserver to an
    // OS-assigned port per launch and Chromium partitions localStorage per
    // origin (port included), so localStorage-based persistence silently
    // lost the folder tree on every restart. Durability now lives on the
    // Host side (`~/.dsh/storages/dsh-enhanced-workspace.json`) via the
    // `/enhanced-workspace` RPC channel; the browser hydrates with
    // `restoreEnvelope` and writes back debounced.
    actions: {
      setGroupBy: (draft, mode) => { draft.groupBy = mode },
      setOrderBy: (draft, mode) => { draft.orderBy = mode },
      setGroupExpanded: (draft, key, expanded) => { draft.groupExpansion[key] = expanded },
      setFolderExpanded: (draft, folderId, expanded) => { draft.folderExpansion[folderId] = expanded },
      collapseAll: draft => {
        draft.folderExpansion = {}
        draft.groupExpansion = {}
      },
      touchWorkspace: (draft, workspaceId) => {
        draft.recentTouchById[workspaceId] = Date.now()
      },
      syncSessionOrderAccount: (draft, accountKey, order, updatedAt) => {
        draft.sessionOrderByAccount[accountKey] = order
        draft.sessionUpdatedAtByAccount[accountKey] = updatedAt
      },
      setSessionOrder: (draft, accountKey, order) => {
        draft.sessionOrderByAccount[accountKey] = order
      },
      createFolder: (draft, parentFolderId, name) => {
        const folderId = crypto.randomUUID() as FolderId
        const next = createFolderIn(draft.folders, parentFolderId, name, folderId, now())
        draft.folders = next.folders
      },
      renameFolder: (draft, folderId, name) => {
        draft.folders = renameFolderIn(draft.folders, folderId, name, now())
      },
      deleteFolder: (draft, folderId) => {
        draft.folders = deleteFolderIn(draft.folders, folderId, now())
        delete draft.folderExpansion[folderId]
      },
      moveFolder: (draft, folderId, beforeFolderId, parentFolderId) => {
        draft.folders = moveFolderIn(draft.folders, folderId, beforeFolderId, parentFolderId, now())
      },
      moveWorkspaceIn: (draft, workspaceId, targetFolderId, beforeWorkspaceId) => {
        draft.folders = moveWorkspaceIn(draft.folders, workspaceId, targetFolderId, beforeWorkspaceId, now())
      },
      adoptWorkspace: (draft, workspaceId) => {
        draft.folders = adoptWorkspaceIn(draft.folders, workspaceId, now())
      },
      retainLiveKeys: (draft, liveWorkspaceIds) => {
        const slice: LiveKeysSlice = {
          folders: draft.folders,
          folderExpansion: draft.folderExpansion,
          recentTouchById: draft.recentTouchById,
          groupExpansion: draft.groupExpansion,
          sessionOrderByAccount: draft.sessionOrderByAccount,
          sessionUpdatedAtByAccount: draft.sessionUpdatedAtByAccount,
        }
        const retained = retainLiveKeys(slice, liveWorkspaceIds)
        draft.folders = retained.folders
        draft.folderExpansion = retained.folderExpansion
        draft.recentTouchById = retained.recentTouchById
        draft.groupExpansion = retained.groupExpansion
        draft.sessionOrderByAccount = retained.sessionOrderByAccount
        draft.sessionUpdatedAtByAccount = retained.sessionUpdatedAtByAccount
      },
      restoreEnvelope: (draft, envelope, liveWorkspaceIds) => {
        const next = restoredState(envelope, liveWorkspaceIds, now())
        draft.folders = next.folders
        draft.folderExpansion = next.folderExpansion
        draft.recentTouchById = next.recentTouchById
        draft.groupBy = next.groupBy
        draft.orderBy = next.orderBy
        draft.groupExpansion = next.groupExpansion
        draft.sessionOrderByAccount = next.sessionOrderByAccount
        draft.sessionUpdatedAtByAccount = next.sessionUpdatedAtByAccount
      },
    },
  })
}
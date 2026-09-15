/**
 * Pure data plane of the enhanced workspace browser: the folder-tree model
 * (records, CRUD decisions, guards), the Host-order reconciliation, the
 * recency derivation, and the session-group derivations the browser renders.
 * Every function here is side-effect free — the store actions that persist
 * the tree and the components that render it both operate on these outputs.
 * @module dsh-enhanced-workspace/client/model
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'

/**
 * Pending interaction kinds a session row surfaces. The framework removed its
 * exported union with the client-runtime split; the member values are stable.
 */
export type PendingInteractionStatus = 'approval' | 'plan-review' | 'question'

/** Pending interactions by Session, as published by the ui-session assembly. */
export type SessionPendingInteractions = ReadonlyMap<SessionId, { readonly kind: string }>

/** No pending interactions: the default for derivations that render no indicator. */
const EMPTY_PENDING: SessionPendingInteractions = new Map()

/** Map one domain-owned pending interaction kind onto the row presentation union. */
export function pendingInteractionOf(kind: string | undefined): PendingInteractionStatus | undefined {
  return kind === 'approval' || kind === 'plan-review' || kind === 'question' ? kind : undefined
}

/**
 * Identifies one folder record. The reserved root id (`ROOT_FOLDER_ID`) is a
 * constant; everything else is a generated uuid. Brands are compile-time
 * only — records persist as plain strings.
 */
export type FolderId = string & { readonly '__enhanced-workspace-folder': 'FolderId' }

/** Brand a string as a {@link FolderId}. */
export function FolderId(id: string): FolderId {
  return id as FolderId
}

/** Reserved id of the root folder record (children are the browser's top level). */
export const ROOT_FOLDER_ID = FolderId('root')

/**
 * Maximum tree depth, root included (root = 1). A folder may become a child
 * of a folder whose depth equals the cap; the next level would exceed it.
 */
export const MAX_FOLDER_DEPTH = 6

/** One durable folder record: identity, name, parent, and the two ordered child accounts. */
export interface FolderRecord {
  folderId: FolderId
  /** Display name; non-empty, unique among the folder's siblings (workspace titles may match). */
  name: string
  /** Owning folder; null only for the root record. */
  parentFolderId: FolderId | null
  /** Directly owned workspaces in display order (subfolder rows render first). */
  workspaceIds: WorkspaceId[]
  /** Direct child folders in display order. */
  folderIds: FolderId[]
  /** ISO-8601 creation instant. */
  createdAt: string
  /** ISO-8601 last-mutation instant. */
  updatedAt: string
}

/** A folder operation named a folder the tree does not hold. */
export class FolderNotFoundError extends Error {
  constructor(readonly folderId: FolderId) {
    super(`folder '${folderId}' does not exist`)
    this.name = 'FolderNotFoundError'
  }
}

/** A folder create or rename duplicated a sibling folder name. */
export class FolderNameConflictError extends Error {
  constructor(readonly name: string) {
    super(`a sibling folder is already named '${name}'`)
    this.name = 'FolderNameConflictError'
  }
}

/** A rename or delete named the root folder, which is immortal. */
export class FolderRootProtectedError extends Error {
  constructor(readonly operation: string) {
    super(`cannot ${operation} the root folder`)
    this.name = 'FolderRootProtectedError'
  }
}

/** A folder move named a target that is the folder itself or one of its descendants. */
export class FolderCycleError extends Error {
  constructor(readonly folderId: FolderId, readonly parentFolderId: FolderId) {
    super(`cannot move folder '${folderId}' under '${parentFolderId}': the target is the folder or one of its descendants`)
    this.name = 'FolderCycleError'
  }
}

/** A folder create or move would nest the tree deeper than MAX_FOLDER_DEPTH. */
export class FolderDepthExceededError extends Error {
  constructor(readonly folderId: FolderId, readonly parentFolderId: FolderId, readonly maxDepth: number) {
    super(`cannot nest folder '${folderId}' under '${parentFolderId}': depth would exceed the ${maxDepth}-level cap`)
    this.name = 'FolderDepthExceededError'
  }
}

/** A workspace move named a workspace the tree does not hold. */
export class WorkspaceNotInTreeError extends Error {
  constructor(readonly workspaceId: WorkspaceId) {
    super(`workspace '${workspaceId}' is not in the folder tree`)
    this.name = 'WorkspaceNotInTreeError'
  }
}

/** A workspace move named an anchor that the target folder does not hold. */
export class WorkspaceAnchorMissingError extends Error {
  constructor(readonly workspaceId: WorkspaceId, readonly folderId: FolderId) {
    super(`workspace '${workspaceId}' is not accounted by folder '${folderId}'`)
    this.name = 'WorkspaceAnchorMissingError'
  }
}

/**
 * Folder record map keyed by folder id (the durable tree). The plain string
 * index keeps computed spread keys and the root literal unambiguous.
 */
export type FolderTree = Record<string, FolderRecord>

/**
 * Depth of a folder, root = 1. Throws {@link FolderNotFoundError} on a
 * missing record; the walk is cycle-guarded (a corrupt tree fails loud
 * instead of hanging).
 */
export function depthOf(folders: FolderTree, folderId: FolderId): number {
  const visited = new Set<FolderId>()
  let depth = 0
  let cursor: FolderId | undefined = folderId
  while (cursor !== undefined) {
    if (visited.has(cursor)) {
      throw new Error(`folder tree is inconsistent: cycle through '${cursor}'`)
    }
    visited.add(cursor)
    depth += 1
    // Explicit annotation breaks the loop's circular inference (cursor is
    // re-assigned from record.parentFolderId at the tail, which would make
    // `record`'s type depend on itself through the loop-back).
    const record: FolderRecord | undefined = folders[cursor]
    if (record === undefined) throw new FolderNotFoundError(cursor)
    cursor = record.parentFolderId ?? undefined
  }
  return depth
}

/** The folder whose workspace account holds the id, when one does. */
export function folderOfWorkspace(folders: FolderTree, workspaceId: WorkspaceId): FolderId | undefined {
  for (const record of Object.values(folders)) {
    if (record.workspaceIds.includes(workspaceId)) return record.folderId
  }
  return undefined
}

/** Whether `candidate`'s parent chain reaches `ancestor` (cycle-guarded walk). */
function isDescendantOf(folders: FolderTree, candidate: FolderId, ancestor: FolderId): boolean {
  const visited = new Set<FolderId>()
  let cursor: FolderId | undefined = candidate
  while (cursor !== undefined) {
    if (cursor === ancestor) return true
    if (visited.has(cursor)) {
      throw new Error(`folder tree is inconsistent: cycle through '${cursor}'`)
    }
    visited.add(cursor)
    // See depthOf: the loop-back assignment makes the record type circular.
    const record: FolderRecord | undefined = folders[cursor]
    if (record === undefined) throw new FolderNotFoundError(cursor)
    cursor = record.parentFolderId ?? undefined
  }
  return false
}

function assertSiblingNameFree(folders: FolderTree, parent: FolderRecord, excludeId: FolderId | undefined, name: string): void {
  if (parent.folderIds.some(id => id !== excludeId && folders[id]?.name === name)) {
    throw new FolderNameConflictError(name)
  }
}

/**
 * Create one folder under an existing parent: validate depth and sibling-name
 * uniqueness, then append the new record to the parent's `folderIds` account.
 * @param folders - current tree.
 * @param parentFolderId - owning folder (the root creates a top-level folder).
 * @param name - display name, non-empty and sibling-unique.
 * @param folderId - the new record's id (generated by the caller — purity).
 * @param now - ISO-8601 stamp for both records.
 * @returns the next tree plus the new record's id.
 */
export function createFolderIn(
  folders: FolderTree,
  parentFolderId: FolderId,
  name: string,
  folderId: FolderId,
  now: string,
): { folders: FolderTree; folderId: FolderId } {
  const parent = folders[parentFolderId]
  if (parent === undefined) throw new FolderNotFoundError(parentFolderId)
  if (name.trim() === '') throw new FolderNameConflictError(name)
  if (depthOf(folders, parentFolderId) >= MAX_FOLDER_DEPTH) {
    throw new FolderDepthExceededError(folderId, parentFolderId, MAX_FOLDER_DEPTH)
  }
  assertSiblingNameFree(folders, parent, undefined, name)
  const record: FolderRecord = {
    folderId,
    name,
    parentFolderId,
    workspaceIds: [],
    folderIds: [],
    createdAt: now,
    updatedAt: now,
  }
  return {
    folders: {
      ...folders,
      [folderId]: record,
      [parentFolderId]: { ...parent, folderIds: [...parent.folderIds, folderId], updatedAt: now },
    },
    folderId,
  }
}

/**
 * Rename one folder. The name must be free among the folder's siblings; the
 * root cannot be renamed.
 * @param folders - current tree.
 * @param folderId - folder to rename.
 * @param name - new display name.
 * @param now - ISO-8601 stamp.
 * @returns the next tree.
 */
export function renameFolderIn(folders: FolderTree, folderId: FolderId, name: string, now: string): FolderTree {
  if (folderId === ROOT_FOLDER_ID) throw new FolderRootProtectedError('rename')
  const record = folders[folderId]
  if (record === undefined) throw new FolderNotFoundError(folderId)
  if (record.name === name) return folders
  const parent = record.parentFolderId === null ? undefined : folders[record.parentFolderId]
  if (parent === undefined) {
    throw new Error(`folder tree is inconsistent: folder '${folderId}' names a missing parent`)
  }
  assertSiblingNameFree(folders, parent, folderId, name)
  return { ...folders, [folderId]: { ...record, name, updatedAt: now } }
}

/**
 * Delete one folder and promote its children into the parent: the subfolders,
 * then the workspaces, keep their relative order and land at the deleted
 * folder's slot in both parent accounts (subfolders first, workspaces after —
 * the display order). The root cannot be deleted.
 * @param folders - current tree.
 * @param folderId - folder to delete.
 * @param now - ISO-8601 stamp for the touched parent.
 * @returns the next tree without the folder.
 */
export function deleteFolderIn(folders: FolderTree, folderId: FolderId, now: string): FolderTree {
  if (folderId === ROOT_FOLDER_ID) throw new FolderRootProtectedError('delete')
  const record = folders[folderId]
  if (record === undefined) throw new FolderNotFoundError(folderId)
  const parentId = record.parentFolderId
  if (parentId === null) {
    throw new Error(`folder tree is inconsistent: folder '${folderId}' with no parent is not the root`)
  }
  const parent = folders[parentId]
  if (parent === undefined) throw new FolderNotFoundError(parentId)
  const at = parent.folderIds.indexOf(folderId)
  if (at === -1) {
    throw new Error(`folder tree is inconsistent: folder '${folderId}' is absent from its parent's account`)
  }
  const next: FolderTree = { ...folders }
  delete next[folderId]
  next[parentId] = {
    ...parent,
    folderIds: [...parent.folderIds.slice(0, at), ...record.folderIds, ...parent.folderIds.slice(at + 1)],
    workspaceIds: [...parent.workspaceIds.slice(0, at), ...record.workspaceIds, ...parent.workspaceIds.slice(at)],
    updatedAt: now,
  }
  for (const childId of record.folderIds) {
    const child = next[childId]
    if (child !== undefined) next[childId] = { ...child, parentFolderId: parentId, updatedAt: now }
  }
  return next
}

/**
 * Move one folder within the tree, DOM-insertBefore-like: with an anchor the
 * folder lands before that sibling; without one it appends to the end of the
 * target parent's `folderIds` account. The target parent defaults to the
 * folder's current parent, so an omitted parent is an in-place reorder.
 * Moving under the folder itself or one of its descendants is rejected as a
 * cycle; a target whose depth already equals {@link MAX_FOLDER_DEPTH} is
 * rejected as too deep.
 * @param folders - current tree.
 * @param folderId - folder to move.
 * @param beforeFolderId - sibling anchor in the target parent; omitted appends.
 * @param parentFolderId - target parent; omitted keeps the current parent.
 * @param now - ISO-8601 stamp for every touched record.
 * @returns the next tree.
 */
export function moveFolderIn(
  folders: FolderTree,
  folderId: FolderId,
  beforeFolderId: FolderId | undefined,
  parentFolderId: FolderId | undefined,
  now: string,
): FolderTree {
  const record = folders[folderId]
  if (record === undefined) throw new FolderNotFoundError(folderId)
  const currentParentId = record.parentFolderId
  if (currentParentId === null) throw new FolderRootProtectedError('move')
  const currentParent = folders[currentParentId]
  if (currentParent === undefined) throw new FolderNotFoundError(currentParentId)
  if (!currentParent.folderIds.includes(folderId)) {
    throw new Error(`folder tree is inconsistent: folder '${folderId}' is absent from its parent's account`)
  }
  const targetParentId = parentFolderId ?? currentParentId
  const targetParent = folders[targetParentId]
  if (targetParent === undefined) throw new FolderNotFoundError(targetParentId)
  if (beforeFolderId !== undefined && !targetParent.folderIds.includes(beforeFolderId)) {
    throw new FolderNotFoundError(beforeFolderId)
  }
  if (targetParentId !== currentParentId) {
    if (targetParentId === folderId || isDescendantOf(folders, targetParentId, folderId)) {
      throw new FolderCycleError(folderId, targetParentId)
    }
    if (depthOf(folders, targetParentId) >= MAX_FOLDER_DEPTH) {
      throw new FolderDepthExceededError(folderId, targetParentId, MAX_FOLDER_DEPTH)
    }
  }
  if (targetParentId === currentParentId) {
    if (beforeFolderId === folderId) return folders
    const without = currentParent.folderIds.filter(candidate => candidate !== folderId)
    const at = beforeFolderId === undefined ? without.length : without.indexOf(beforeFolderId)
    const folderIds = [...without.slice(0, at), folderId, ...without.slice(at)]
    if (folderIds.every((candidate, index) => candidate === currentParent.folderIds[index])) return folders
    return { ...folders, [currentParentId]: { ...currentParent, folderIds, updatedAt: now } }
  }
  const without = currentParent.folderIds.filter(candidate => candidate !== folderId)
  const at = beforeFolderId === undefined ? targetParent.folderIds.length : targetParent.folderIds.indexOf(beforeFolderId)
  return {
    ...folders,
    [currentParentId]: { ...currentParent, folderIds: without, updatedAt: now },
    [targetParentId]: {
      ...targetParent,
      folderIds: [...targetParent.folderIds.slice(0, at), folderId, ...targetParent.folderIds.slice(at)],
      updatedAt: now,
    },
    [folderId]: { ...record, parentFolderId: targetParentId, updatedAt: now },
  }
}

/**
 * Move one workspace within the tree: out of its current owner's workspace
 * account and into the target folder's account (at the anchor, appended when
 * omitted). Depth and cycle guards do not apply — workspaces are leaves.
 * @param folders - current tree.
 * @param workspaceId - workspace to move.
 * @param targetFolderId - new owner folder.
 * @param beforeWorkspaceId - workspace anchor in the target folder; omitted appends.
 * @param now - ISO-8601 stamp for every touched record.
 * @returns the next tree.
 */
export function moveWorkspaceIn(
  folders: FolderTree,
  workspaceId: WorkspaceId,
  targetFolderId: FolderId,
  beforeWorkspaceId: WorkspaceId | undefined,
  now: string,
): FolderTree {
  const target = folders[targetFolderId]
  if (target === undefined) throw new FolderNotFoundError(targetFolderId)
  if (beforeWorkspaceId !== undefined && !target.workspaceIds.includes(beforeWorkspaceId)) {
    throw new WorkspaceAnchorMissingError(beforeWorkspaceId, targetFolderId)
  }
  const ownerId = folderOfWorkspace(folders, workspaceId)
  if (ownerId === undefined) throw new WorkspaceNotInTreeError(workspaceId)
  const owner = folders[ownerId] as FolderRecord
  if (ownerId === targetFolderId) {
    if (beforeWorkspaceId === workspaceId) return folders
    const without = owner.workspaceIds.filter(candidate => candidate !== workspaceId)
    const at = beforeWorkspaceId === undefined ? without.length : without.indexOf(beforeWorkspaceId)
    const workspaceIds = [...without.slice(0, at), workspaceId, ...without.slice(at)]
    if (workspaceIds.every((candidate, index) => candidate === owner.workspaceIds[index])) return folders
    return { ...folders, [ownerId]: { ...owner, workspaceIds, updatedAt: now } }
  }
  const without = owner.workspaceIds.filter(candidate => candidate !== workspaceId)
  const at = beforeWorkspaceId === undefined ? target.workspaceIds.length : target.workspaceIds.indexOf(beforeWorkspaceId)
  return {
    ...folders,
    [ownerId]: { ...owner, workspaceIds: without, updatedAt: now },
    [targetFolderId]: {
      ...target,
      workspaceIds: [...target.workspaceIds.slice(0, at), workspaceId, ...target.workspaceIds.slice(at)],
      updatedAt: now,
    },
  }
}

/**
 * Adopt a Host-created workspace into the tree at the root account head
 * (mirrors the Host's newest-first create semantics). Workspaces already in
 * the tree are left untouched.
 * @param folders - current tree.
 * @param workspaceId - the workspace the Host created.
 * @param now - ISO-8601 stamp for the root record.
 * @returns the next tree.
 */
export function adoptWorkspaceIn(folders: FolderTree, workspaceId: WorkspaceId, now: string): FolderTree {
  if (folderOfWorkspace(folders, workspaceId) !== undefined) return folders
  const root = folders[ROOT_FOLDER_ID]
  if (root === undefined) return folders
  return {
    ...folders,
    [ROOT_FOLDER_ID]: { ...root, workspaceIds: [workspaceId, ...root.workspaceIds], updatedAt: now },
  }
}

/**
 * The persisted slice `retainLiveKeys` prunes: workspace-keyed maps plus the
 * folder tree. Workspaces the Host no longer lists are removed from every
 * folder account, the expansion state, the touch timestamps, the session
 * order accounts, and the update-stamp accounts; folders themselves are kept
 * (only a folder delete removes a folder).
 */
export interface LiveKeysSlice {
  folders: FolderTree
  folderExpansion: Record<string, boolean>
  recentTouchById: Record<string, number>
  groupExpansion: Record<string, boolean>
  sessionOrderByAccount: Record<string, string[]>
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>
}

/**
 * One-way convergence against the Host baseline: keep exactly the live
 * workspace ids and drop everything else (local storage never writes back to
 * the Host). Folder keys in the expansion map are retained untouched.
 * @param state - the persisted slice.
 * @param liveWorkspaceIds - workspaces the Host baseline lists.
 * @returns the pruned slice (same references where nothing changed).
 */
export function retainLiveKeys(state: LiveKeysSlice, liveWorkspaceIds: readonly WorkspaceId[]): LiveKeysSlice {
  const live = new Set(liveWorkspaceIds.map(id => id as string))
  // A prefixed recency-row key lives and dies with its workspace id.
  const isLiveKey = (key: string): boolean =>
    live.has(key) || (key.startsWith(RECENT_GROUP_KEY_PREFIX) && live.has(key.slice(RECENT_GROUP_KEY_PREFIX.length)))
  const pruneWorkspaceKeys = (map: Record<string, unknown>): boolean =>
    Object.keys(map).some(key => !isLiveKey(key))
  if (!pruneWorkspaceKeys(state.recentTouchById)
    && !pruneWorkspaceKeys(state.groupExpansion)
    && !pruneWorkspaceKeys(state.sessionOrderByAccount)
    && !pruneWorkspaceKeys(state.sessionUpdatedAtByAccount)
    && !Object.values(state.folders).some(record => record.workspaceIds.some(id => !live.has(id as string)))) {
    return state
  }
  const folders: FolderTree = {}
  for (const [folderId, record] of Object.entries(state.folders)) {
    if (record.workspaceIds.length === 0 || record.workspaceIds.every(id => live.has(id as string))) {
      folders[folderId as FolderId] = record
      continue
    }
    folders[folderId as FolderId] = { ...record, workspaceIds: record.workspaceIds.filter(id => live.has(id as string)) }
  }
  const keep = (map: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(map).filter(([key]) => isLiveKey(key)))
  return {
    folders,
    folderExpansion: state.folderExpansion,
    recentTouchById: keep(state.recentTouchById) as Record<string, number>,
    groupExpansion: keep(state.groupExpansion) as Record<string, boolean>,
    sessionOrderByAccount: keep(state.sessionOrderByAccount) as Record<string, string[]>,
    sessionUpdatedAtByAccount: keep(state.sessionUpdatedAtByAccount) as Record<string, Record<string, number>>,
  }
}

/**
 * The persisted slice of the viewing state — exactly the store's durable
 * fields (the folder tree, the expansion maps, the recency stamps, and the
 * viewing mode), also known as the *envelope*: the host half stores this
 * shape under `<dsh-home>/storages/dsh-enhanced-workspace.json` and the
 * browser restores it through {@link restoredState}. The reserved
 * `__flat_session_order__` account key lives inside `sessionOrderByAccount`,
 * so the flat-list order travels with the envelope like every other order.
 */
export interface PersistedViewState {
  /** The folder tree (root record included); display order = the records' child accounts. */
  folders: FolderTree
  /** Per-folder expand/collapse (root itself is never rendered, never keyed here). */
  folderExpansion: Record<string, boolean>
  /** New-query-send stamps by workspace id (derived activity time needs no storage). */
  recentTouchById: Record<string, number>
  /** Session-list grouping mode: workspace sections or one flat recency list. */
  groupBy: SessionGroupBy
  /** Session-order strategy: newest activity or the stored per-account order. */
  orderBy: SessionOrderBy
  /** Explicit zero-or-five-session state keyed by Workspace group identity. */
  groupExpansion: Record<string, boolean>
  /** Shared editable order per Workspace group plus the browser-local flat-list account. */
  sessionOrderByAccount: Record<string, string[]>
  /** Last observed update timestamps per order account for one-time promotion events. */
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>
}

/** Session-list grouping mode: workspace sections, the git-repo view, or one flat recency list. */
export type SessionGroupBy = 'workspace' | 'repo' | 'flat'

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBooleanMap(value: unknown): value is Record<string, boolean> {
  return isPlainRecord(value) && Object.values(value).every(item => typeof item === 'boolean')
}

function isFiniteNumberMap(value: unknown): value is Record<string, number> {
  return isPlainRecord(value) && Object.values(value).every(item => typeof item === 'number' && Number.isFinite(item))
}

/**
 * Whether `value` is a structurally sound {@link PersistedViewState}: a
 * root-anchored, depth-capped, cycle-free folder tree plus the typed viewing
 * maps. This is the client-side twin of the host's `validateEnvelope`; the
 * host gate already vets what crosses the RPC boundary, so this guard exists
 * to keep a stale or hand-edited value from crashing the browser's own
 * render path.
 * @param value - candidate envelope (any JSON value).
 * @returns whether every structural check passes.
 */
export function isPersistedViewState(value: unknown): value is PersistedViewState {
  if (!isPlainRecord(value)) return false
  if (value.groupBy !== 'workspace' && value.groupBy !== 'repo' && value.groupBy !== 'flat') return false
  if (value.orderBy !== 'updated' && value.orderBy !== 'manual') return false
  if (!isBooleanMap(value.folderExpansion) || !isBooleanMap(value.groupExpansion)) return false
  if (!isFiniteNumberMap(value.recentTouchById)) return false
  if (!isPlainRecord(value.sessionOrderByAccount)
    || !Object.values(value.sessionOrderByAccount).every(entry => Array.isArray(entry) && entry.every(item => typeof item === 'string'))) return false
  if (!isPlainRecord(value.sessionUpdatedAtByAccount)
    || !Object.values(value.sessionUpdatedAtByAccount).every(isFiniteNumberMap)) return false

  const folders = value.folders
  if (!isPlainRecord(folders)) return false
  const root = folders[ROOT_FOLDER_ID]
  if (!isPlainRecord(root) || root.folderId !== 'root' || root.parentFolderId !== null) return false
  for (const [key, record] of Object.entries(folders)) {
    if (!isPlainRecord(record)) return false
    if (record.folderId !== key) return false
    if (typeof record.name !== 'string' || record.name.trim() === '') return false
    if (!Array.isArray(record.workspaceIds) || !record.workspaceIds.every(item => typeof item === 'string')) return false
    if (!Array.isArray(record.folderIds) || !record.folderIds.every(item => typeof item === 'string')) return false
    const parent = record.parentFolderId
    if (parent !== null) {
      if (typeof parent !== 'string') return false
      const parentRecord = folders[parent] as { readonly folderIds: unknown } | undefined
      if (parentRecord === undefined || !Array.isArray(parentRecord.folderIds) || !parentRecord.folderIds.includes(key)) return false
    }
    for (const childId of record.folderIds) {
      const child = folders[childId] as { readonly parentFolderId: unknown } | undefined
      if (child === undefined || child.parentFolderId !== key) return false
    }
  }
  for (const folderId of Object.keys(folders)) {
    const visited = new Set<string>()
    let cursor: string | undefined = folderId
    let depth = 0
    while (cursor !== undefined) {
      depth += 1
      if (depth > MAX_FOLDER_DEPTH) return false
      if (visited.has(cursor)) return false
      visited.add(cursor)
      // See depthOf: the loop-back assignment makes the record type circular.
      const record: { readonly parentFolderId: string | null } | undefined =
        folders[cursor] as { readonly parentFolderId: string | null } | undefined
      if (record === undefined) return false
      cursor = record.parentFolderId ?? undefined
    }
  }
  return true
}

/**
 * Rebuild the viewing state from a persisted envelope and converge it onto
 * the Host baseline: take the stored tree and maps, adopt every live
 * workspace the envelope does not know yet (root-account head, idempotent),
 * then prune every dead workspace id from the workspace-keyed maps exactly
 * like the store's `retainLiveKeys` action does. Expansion keys of folders
 * the stored tree does not hold are dropped as well. Ordering converges
 * once the Host baseline is ready: callers must never pass a loading or
 * stale baseline here, because an empty list authoritatively prunes all ids.
 * @param envelope - the persisted envelope (validated by
 *   {@link isPersistedViewState}; anything else throws `TypeError`).
 * @param liveWorkspaceIds - workspaces the Host baseline lists.
 * @param now - ISO-8601 stamp for records the convergence touches.
 * @returns the next viewing state (fresh object graph; the envelope is not mutated).
 */
export function restoredState(
  envelope: unknown,
  liveWorkspaceIds: readonly WorkspaceId[],
  now: string,
): PersistedViewState {
  if (!isPersistedViewState(envelope)) {
    throw new TypeError('dsh-enhanced-workspace: refusing to restore an invalid persisted envelope')
  }
  const live = liveWorkspaceIds.map(id => id as WorkspaceId)
  let folders = envelope.folders
  for (const workspaceId of live) {
    folders = adoptWorkspaceIn(folders, workspaceId, now)
  }
  const folderIds = new Set(Object.keys(folders).map(id => id as FolderId))
  const keptExpansion: Record<string, boolean> = {}
  for (const [folderId, expanded] of Object.entries(envelope.folderExpansion)) {
    if (folderIds.has(folderId as FolderId)) keptExpansion[folderId] = expanded
  }
  const retained = retainLiveKeys(
    {
      folders,
      folderExpansion: keptExpansion,
      recentTouchById: envelope.recentTouchById,
      groupExpansion: envelope.groupExpansion,
      sessionOrderByAccount: envelope.sessionOrderByAccount,
      sessionUpdatedAtByAccount: envelope.sessionUpdatedAtByAccount,
    },
    live,
  )
  return {
    folders: retained.folders,
    folderExpansion: retained.folderExpansion,
    recentTouchById: retained.recentTouchById,
    groupBy: envelope.groupBy,
    orderBy: envelope.orderBy,
    groupExpansion: retained.groupExpansion,
    sessionOrderByAccount: retained.sessionOrderByAccount,
    sessionUpdatedAtByAccount: retained.sessionUpdatedAtByAccount,
  }
}

/**
 * Depth-first workspace order over the folder tree: for every folder its
 * child folders' subtrees first, then its directly owned workspaces, starting
 * at the root. This is the order the browser renders AND the order the Host's
 * flat registry display is reconciled to (see {@link orderDeltas}).
 * @param folders - current tree.
 * @returns workspace ids in tree order (unreachable folders contribute nothing).
 */
export function treeOrder(folders: FolderTree): WorkspaceId[] {
  const out: WorkspaceId[] = []
  const walk = (folderId: FolderId, visited: Set<FolderId>): void => {
    if (visited.has(folderId)) return
    visited.add(folderId)
    const record = folders[folderId]
    if (record === undefined) return
    for (const childId of record.folderIds) walk(childId, visited)
    out.push(...record.workspaceIds)
  }
  walk(ROOT_FOLDER_ID, new Set())
  return out
}

/**
 * Minimal `insertBefore` move set transforming the Host's current flat order
 * into the desired order: the longest subsequence of the desired order that
 * already appears in the current order stays put (longest increasing
 * subsequence over current positions), and every other item moves before its
 * next stable item — or to the end when none follows. Moves are emitted so a
 * straight application in order produces exactly the desired order:
 * end-appends first (in desired order), then anchored moves in reverse
 * desired order (repeated inserts before the same anchor keep their order).
 * @param current - the Host's current durable order.
 * @param desired - the tree order to reconcile to.
 * @returns the move instructions in application order.
 */
export function orderDeltas(
  current: readonly WorkspaceId[],
  desired: readonly WorkspaceId[],
): Array<{ workspaceId: WorkspaceId; beforeWorkspaceId?: WorkspaceId }> {
  if (current.length === 0 || desired.length === 0) return []
  const position = new Map(current.map((id, index) => [id, index]))
  const aligned: WorkspaceId[] = []
  for (const id of desired) {
    if (position.has(id)) aligned.push(id)
  }
  if (aligned.length <= 1) return []
  const positions = aligned.map(id => position.get(id) as number)
  // Longest increasing subsequence over positions (O(n²) — registries are small).
  const length = new Array<number>(positions.length).fill(1)
  const prev = new Array<number>(positions.length).fill(-1)
  let bestEnd = 0
  for (let i = 0; i < positions.length; i++) {
    for (let j = 0; j < i; j++) {
      if (positions[j]! < positions[i]! && length[j]! + 1 > length[i]!) {
        length[i] = length[j]! + 1
        prev[i] = j
      }
    }
    if (length[i]! > length[bestEnd]!) bestEnd = i
  }
  const stable = new Set<WorkspaceId>()
  for (let i = bestEnd; i >= 0; i = prev[i]!) {
    stable.add(aligned[i] as WorkspaceId)
    if (prev[i] === -1) break
  }
  const moves: Array<{ workspaceId: WorkspaceId; beforeWorkspaceId?: WorkspaceId }> = []
  const ends: WorkspaceId[] = []
  const anchored: Array<{ workspaceId: WorkspaceId; beforeWorkspaceId: WorkspaceId }> = []
  let nextStable: WorkspaceId | undefined
  for (let i = aligned.length - 1; i >= 0; i--) {
    const id = aligned[i] as WorkspaceId
    if (stable.has(id)) {
      nextStable = id
      continue
    }
    if (nextStable === undefined) ends.push(id)
    else anchored.push({ workspaceId: id, beforeWorkspaceId: nextStable })
  }
  // End-appends run first, in desired order (appending e1 then e2 produces
  // e1 before e2); anchored moves follow in reverse desired order so repeated
  // inserts before the same anchor keep their order.
  for (let i = ends.length - 1; i >= 0; i--) moves.push({ workspaceId: ends[i] as WorkspaceId })
  for (const move of anchored) moves.push(move)
  return moves
}

/** Whether a session row is visible: not a subagent child, not archived, and blank only when current. */
function sessionVisible(
  session: SessionSummary,
  current: SessionId | undefined,
  archived: ReadonlySet<SessionId>,
): boolean {
  return session.origin !== 'subagent'
    && !archived.has(session.id)
    && (!session.blank || session.id === current)
}

/** A blank session's canonical title never enters search or labels; the renderer localizes it. */
function sessionTitle(session: SessionSummary): string {
  return session.blank ? 'New Session' : session.displayTitle
}

/** Descendant counts projected for one possible parent session (runtime subagent-lineage contract). */
export interface SubagentDescendantSummary {
  /** All descendants connected through uninterrupted subagent-origin lineage. */
  count: number
  /** Descendants whose exact session summary is currently running. */
  runningCount: number
}

/**
 * Local twin of the runtime's `indexSubagentDescendants`. The published
 * `@deepseek-ai/dsh-client-runtime` client bundle is the DSH `__ModuleLoader__`
 * wire layer — no importable node/browser-neutral entry exists — so the pure
 * semantics below mirror the published implementation 1:1 (subagent-origin
 * chain walk, ordinary forks terminate propagation, cycles fail soft, orphan
 * owners stay harmless map keys). The browser's own row badges are the only
 * consumer; type-level sharing keeps the runtime import out of this module's
 * runtime graph.
 * @param summaries - retained session summaries keyed by id.
 * @returns descendant totals and running totals keyed by possible parent id.
 */
function indexSubagentDescendants(
  summaries: Readonly<Record<SessionId, SessionSummary>>,
): ReadonlyMap<SessionId, SubagentDescendantSummary> {
  const indexed = new Map<SessionId, SubagentDescendantSummary>()
  for (const descendant of Object.values(summaries)) {
    if (descendant.origin !== 'subagent') continue
    const seen = new Set<SessionId>()
    let current: SessionSummary | undefined = descendant
    while (current?.origin === 'subagent' && current.parentId !== undefined && !seen.has(current.id)) {
      seen.add(current.id)
      const aggregate = indexed.get(current.parentId)
      if (aggregate === undefined) {
        indexed.set(current.parentId, { count: 1, runningCount: descendant.running ? 1 : 0 })
      } else {
        aggregate.count += 1
        if (descendant.running) aggregate.runningCount += 1
      }
      current = summaries[current.parentId]
    }
  }
  return indexed
}

/** Recency comparator: newest first, id as the deterministic tiebreak. */
function byRecency(a: SessionSummary, b: SessionSummary): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt
  return a.id < b.id ? -1 : 1
}

/** Session-row status dot (built-in parity): pending interaction outranks
 *  live activity, which outranks the completion reminder. */
export type SessionStatusDot = 'done' | 'ongoing' | 'warning'

/**
 * The session row's status dot, mirroring the built-in presentation: a
 * pending user interaction renders amber ('warning'), own or subagent
 * activity renders the blue pixel-chase loading dot ('ongoing'), a finished
 * but unviewed session renders green ('done'), and idle sessions — like the
 * blank New Session placeholder — show no dot at all.
 * @param node - the derived session row.
 * @returns the dot state, or undefined for no dot.
 */
export function sessionStatusDot(
  node: {
    pendingInteraction: PendingInteractionStatus | undefined
    running: boolean
    runningSubagentCount: number
    completed: boolean
    blank: boolean
  },
): SessionStatusDot | undefined {
  if (node.blank) return undefined
  if (node.pendingInteraction !== undefined) return 'warning'
  if (node.running || node.runningSubagentCount > 0) return 'ongoing'
  if (node.completed) return 'done'
  return undefined
}

/**
 * The directory row's activity sync: a workspace or folder row holding the
 * current session lights its folder glyph in the business color — whether
 * the group is expanded or not. When the session's own rows are collapsed
 * away, every ancestor dir on the path still carries the mark, so the open
 * session's trail reads down the tree from any collapsed level.
 * @param containsCurrent - whether the group holds the selected session.
 */
export function dirActive(containsCurrent: boolean): boolean {
  return containsCurrent
}

/** One top-level session row in a group or the flat list. */
export interface SessionNode {
  id: SessionId
  /** Whether this row is the session currently open in the viewer (the row
   *  that is "on display right now" — drives the current-session wash). */
  current: boolean
  title: string
  blank: boolean
  pendingInteraction?: PendingInteractionStatus
  running: boolean
  runningSubagentCount: number
  completed: boolean
  updatedAt: number
  cwd?: string
  recentInputs: readonly string[]
  recentOutputs: readonly string[]
}

/** Group key for sessions outside every workspace. */
export const UNGROUPED_KEY = ''

/**
 * Recency-row expansion keyspace: `recent:<workspaceId>`. The recency module
 * renders the same workspaces as the tree below it, but its expand/collapse
 * state must NOT travel to the tree rows (no open/close linkage) — the
 * prefixed group key gives the section its own expansion memory.
 */
export const RECENT_GROUP_KEY_PREFIX = 'recent:'

/** The recency module's standalone group key for one workspace. */
export function recentGroupKey(workspaceId: WorkspaceId): string {
  return `${RECENT_GROUP_KEY_PREFIX}${workspaceId}`
}

/** Display label for the ungrouped bucket row. */
export const UNGROUPED_LABEL = 'Ungrouped'

/** One workspace leaf row: a workspace's group inside a folder (or the ungrouped bucket). */
export interface WorkspaceLeaf {
  /** Group key: the workspace id or {@link UNGROUPED_KEY}. */
  key: string
  workspaceId: WorkspaceId | undefined
  cwd: string | undefined
  createdAt: number | undefined
  label: string
  sessionCount: number
  expanded: boolean
  containsCurrent: boolean
  /** Aggregated session-status counts of the group's visible sessions (the
   *  collapsed-dir marker's data). Computed from the member summaries, so a
   *  COLLAPSED leaf still carries it (its `sessions` list is empty while
   *  folded): the row renders the top-priority dot in the actions slot and
   *  the hover card lists every nonzero count. */
  status: WorkspaceSessionStatus
  sessions: readonly SessionNode[]
}

/** One folder node of the derived forest. */
export interface FolderNode {
  folderId: FolderId
  name: string
  /** Tree depth, root = 0 (top-level folders render at depth 1, indent depth - 1). */
  depth: number
  expanded: boolean
  children: readonly FolderNode[]
  workspaceGroups: readonly WorkspaceLeaf[]
  /** Visible top-level sessions directly in this folder's workspaces. */
  sessionCount: number
  /** The subtree contains the selected session. */
  containsCurrent: boolean
}

/** The derived forest: folder nodes + the root's own workspace leaves + the trailing ungrouped bucket. */
export interface ForestResult {
  folders: readonly FolderNode[]
  /**
   * Workspaces the root account owns directly, as top-level leaves. Render
   * order at every level is `folderIds` then `workspaceIds`, so these land
   * between the folder nodes and the ungrouped bucket.
   */
  topLevel: readonly WorkspaceLeaf[]
  ungrouped: WorkspaceLeaf | undefined
}

/** Session-order strategy within a workspace group (and the recency rows' lists). */
export type SessionOrderBy = 'manual' | 'updated'

/** Viewing state consumed by the forest derivation. */
export interface ForestView {
  folderExpansion: Readonly<Record<string, boolean>>
  groupExpansion: Readonly<Record<string, boolean>>
  /**
   * Session-order strategy: `'updated'` (default) sorts a group's sessions by
   * newest activity; `'manual'` prefers the stored per-account order with
   * unknown/new sessions trailing in account order.
   */
  orderBy?: SessionOrderBy
  /** Stored per-account session order (workspace id → order); missing accounts keep account order. */
  sessionOrderBy?: Readonly<Record<string, readonly string[]>>
  ungroupedOrder?: readonly string[]
}

/**
 * Reorder visible members per the order strategy: `'updated'` sorts by
 * newest activity (id as the deterministic tiebreak); `'manual'` applies the
 * stored account order with unknown/new ids trailing in account order.
 */
function orderedMembers(
  members: readonly SessionSummary[],
  stored: readonly string[] | undefined,
  orderBy: SessionOrderBy,
): SessionSummary[] {
  if (orderBy !== 'manual') return [...members].sort(byRecency)
  if (stored === undefined || stored.length === 0) return [...members]
  const byId = new Map(members.map(session => [session.id as string, session]))
  const included = new Set<string>()
  const ordered: SessionSummary[] = []
  for (const key of stored) {
    const session = byId.get(key)
    if (session === undefined || included.has(key)) continue
    ordered.push(session)
    included.add(key)
  }
  for (const session of members) {
    if (included.has(session.id)) continue
    ordered.push(session)
  }
  return ordered
}

/**
 * Projection-table local contract of the session-stats domain package (a
 * plugin-side peer, not a peer dependency here): its key merges into
 * {@link SessionProjectionMap} at the host deployment, so consumers read the
 * slice through this local spelling instead of a value import that would
 * break the purity gate (the read is a plain property access either way).
 */
interface SessionStatsProjection {
  recentInputs?: readonly string[]
  recentOutputs?: readonly string[]
}

/** Read the session-stats slice off a projection-value table, when present. */
function projectionSessionStats(
  values: Readonly<Partial<SessionProjectionMap>> | undefined,
): SessionStatsProjection | undefined {
  if (values === undefined) return undefined
  return (values as unknown as { sessionStats?: SessionStatsProjection }).sessionStats
}

function sessionNode(
  session: SessionSummary,
  descendants: ReadonlyMap<SessionId, { runningCount: number }>,
  current: SessionId | undefined,
  pending: SessionPendingInteractions = EMPTY_PENDING,
): SessionNode {
  const stats = projectionSessionStats(session.projectionValues)
  const pendingInteraction = pendingInteractionOf(pending.get(session.id)?.kind)
  return {
    id: session.id,
    current: session.id === current,
    title: sessionTitle(session),
    blank: session.blank,
    running: session.running,
    runningSubagentCount: descendants.get(session.id)?.runningCount ?? 0,
    completed: session.completed === true,
    updatedAt: session.updatedAt,
    recentInputs: stats?.recentInputs ?? [],
    recentOutputs: stats?.recentOutputs ?? [],
    ...(session.cwd === undefined ? {} : { cwd: session.cwd }),
    ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
  }
}

/**
 * Aggregated session-status counts of a workspace group (the collapsed-dir
 * status marker's data): how many of the group's visible sessions sit in
 * each row-dot state. Absent keys read 0.
 */
export type WorkspaceSessionStatus = Partial<Record<SessionStatusDot, number>>

/**
 * Aggregate a workspace group's visible sessions into the collapsed-dir
 * status marker's counts. Each session lands in exactly one state, following
 * `sessionStatusDot`'s per-session outranking — pending interaction
 * ('warning') > own/subagent activity ('ongoing') > completion ('done');
 * idle sessions and blank placeholders never count. Computed from the member
 * summaries so a COLLAPSED leaf whose `sessions` list is empty still carries
 * the marker: the row renders the top-priority dot in the actions slot, its
 * hover card lists every nonzero count.
 * @param members - the workspace's visible session summaries.
 * @param descendants - subagent descendant index
 *   ({@link indexSubagentDescendants}); absent keeps own activity only.
 * @param pending - pending-interaction map (defaults to none).
 */
export function workspaceSessionStatus(
  members: readonly SessionSummary[],
  descendants: ReadonlyMap<SessionId, SubagentDescendantSummary> = new Map(),
  pending: SessionPendingInteractions = EMPTY_PENDING,
): WorkspaceSessionStatus {
  const counts: WorkspaceSessionStatus = {}
  for (const member of members) {
    const dot = sessionStatusDot({
      pendingInteraction: pendingInteractionOf(pending.get(member.id)?.kind),
      running: member.running,
      runningSubagentCount: descendants.get(member.id)?.runningCount ?? 0,
      completed: member.completed === true,
      blank: member.blank,
    })
    if (dot === undefined) continue
    counts[dot] = (counts[dot] ?? 0) + 1
  }
  return counts
}

/**
 * Build one workspace leaf row: its visible members (archived / blank /
 * subagent rows filtered), the group expansion from the view, the stored
 * per-account session order, and the session rows when expanded. Shared by
 * the folder forest and the recency module so both render the same row.
 * @param workspace - the real workspace view.
 * @param list - sessions list snapshot (`current` feeds containsCurrent).
 * @param archived - registry-global archive set.
 * @param expandedGroups - group keys the user expanded.
 * @param view - expansion state and per-account session orders.
 * @param descendants - subagent descendant index ({@link indexSubagentDescendants}).
 * @param rowKey - the group key this row's expansion reads/writes; defaults to
 *   the workspace id (the tree rows), the recency module passes its prefixed
 *   key ({@link recentGroupKey}) so its rows expand independently.
 */
function buildLeaf(
  workspace: WorkspaceView,
  list: SessionListState,
  archived: ReadonlySet<SessionId>,
  expandedGroups: ReadonlySet<string>,
  view: ForestView,
  descendants: ReadonlyMap<SessionId, SubagentDescendantSummary>,
  pending: SessionPendingInteractions = EMPTY_PENDING,
  rowKey: string = workspace.workspaceId,
): WorkspaceLeaf {
  const members: SessionSummary[] = []
  for (const id of workspace.sessionIds) {
    const summary = list.byId[id]
    if (summary === undefined) continue // account may lead the list pull; the row appears when the summary lands
    if (!sessionVisible(summary, list.current, archived)) continue
    members.push(summary)
  }
  const key = rowKey
  const expanded = expandedGroups.has(key)
  // The stored session order belongs to the workspace, not to the row's
  // expansion key: tree rows and recency rows share one account order.
  const ordered = orderedMembers(members, view.sessionOrderBy?.[workspace.workspaceId], view.orderBy ?? 'updated')
  return {
    key,
    workspaceId: workspace.workspaceId,
    cwd: workspace.path,
    createdAt: Date.parse(workspace.createdAt),
    label: workspace.title,
    sessionCount: members.length,
    expanded,
    containsCurrent: list.current !== undefined && workspace.sessionIds.includes(list.current as SessionId),
    status: workspaceSessionStatus(members, descendants, pending),
    sessions: expanded ? ordered.map(member => sessionNode(member, descendants, list.current, pending)) : [],
  }
}

/** Expanded group keys from the view (shared by the forest and the recency module). */
function expandedGroupKeys(view: ForestView): ReadonlySet<string> {
  return new Set(Object.entries(view.groupExpansion)
    .filter(([, expanded]) => expanded)
    .map(([key]) => key))
}

/**
 * Standalone workspace leaf (the recency module's building block): same row
 * as the forest renders for that workspace — expansion, session rows, order,
 * `containsCurrent` — for callers that hold the workspace directly instead
 * of a folder account.
 * @param list - sessions list snapshot.
 * @param workspace - the real workspace view.
 * @param archivedSessionIds - registry-global archive set.
 * @param view - expansion state and per-account session orders.
 */
export function deriveWorkspaceLeaf(
  list: SessionListState,
  workspace: WorkspaceView,
  archivedSessionIds: readonly SessionId[],
  view: ForestView,
  pending: SessionPendingInteractions = EMPTY_PENDING,
): WorkspaceLeaf {
  return buildLeaf(workspace, list, new Set(archivedSessionIds), expandedGroupKeys(view), view, indexSubagentDescendants(list.byId), pending)
}

/**
 * Derive the browser forest: the folder tree (top level = the root record's
 * children) with each folder's workspaces as {@link WorkspaceLeaf} rows in
 * account order, sessions populated under expanded groups, plus the trailing
 * ungrouped bucket for sessions outside every workspace. Unreachable folders
 * (not reachable from the root) are never rendered.
 * @param list - sessions list snapshot (`current` feeds containsCurrent).
 * @param workspaces - real workspaces in stable Host order (leaves resolve by id).
 * @param folders - the plugin's folder tree.
 * @param archivedSessionIds - registry-global archive set.
 * @param view - expansion state and the browser-local ungrouped order.
 * @returns folder nodes in render order plus the ungrouped bucket.
 */
export function deriveFolderForest(
  list: SessionListState,
  workspaces: readonly WorkspaceView[],
  folders: FolderTree,
  archivedSessionIds: readonly SessionId[],
  view: ForestView,
  pending: SessionPendingInteractions = EMPTY_PENDING,
): ForestResult {
  const archived = new Set(archivedSessionIds)
  const expandedGroups = expandedGroupKeys(view)
  const ungroupedOrder = view.ungroupedOrder
  const descendants = indexSubagentDescendants(list.byId)
  const workspaceById = new Map(workspaces.map(workspace => [workspace.workspaceId, workspace]))
  const currentGroup: string | undefined = list.current === undefined
    ? undefined
    : (workspaces.find(workspace => workspace.sessionIds.includes(list.current as SessionId))?.workspaceId as string | undefined)
      ?? UNGROUPED_KEY

  const buildFolder = (record: FolderRecord, depth: number, visited: Set<FolderId>): FolderNode => {
    const children: FolderNode[] = []
    const workspaceGroups: WorkspaceLeaf[] = []
    let sessionCount = 0
    let containsCurrent = false
    if (!visited.has(record.folderId)) {
      const nextVisited = new Set(visited)
      nextVisited.add(record.folderId)
      for (const childId of record.folderIds) {
        const child = folders[childId]
        if (child === undefined) continue
        const node = buildFolder(child, depth + 1, nextVisited)
        children.push(node)
        sessionCount += node.sessionCount
        containsCurrent ||= node.containsCurrent
      }
      for (const id of record.workspaceIds) {
        const workspace = workspaceById.get(id)
        if (workspace === undefined) continue
        const leaf = buildLeaf(workspace, list, archived, expandedGroups, view, descendants, pending)
        workspaceGroups.push(leaf)
        sessionCount += leaf.sessionCount
        containsCurrent ||= leaf.containsCurrent
      }
    }
    return {
      folderId: record.folderId,
      name: record.name,
      depth,
      expanded: view.folderExpansion[record.folderId] === true,
      children,
      workspaceGroups,
      sessionCount,
      containsCurrent,
    }
  }

  const root = folders[ROOT_FOLDER_ID]
  let foldersOut: readonly FolderNode[] = []
  let topLevel: readonly WorkspaceLeaf[] = []
  if (root !== undefined) {
    const rootNode = buildFolder(root, 0, new Set())
    foldersOut = rootNode.children
    topLevel = rootNode.workspaceGroups
  }

  const accounted = new Set<SessionId>()
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds) accounted.add(id)
  }
  const stray = list.ids
    .map(id => list.byId[id])
    .filter((session): session is SessionSummary =>
      session !== undefined && !accounted.has(session.id) && sessionVisible(session, list.current, archived))
  let ungrouped: WorkspaceLeaf | undefined
  if (stray.length > 0) {
    const ordered = ungroupedOrder === undefined
      ? [...stray].sort(byRecency)
      : (() => {
        const byId = new Map(stray.map(session => [session.id as string, session]))
        const included = new Set<string>()
        const out: SessionSummary[] = []
        for (const key of ungroupedOrder) {
          const session = byId.get(key)
          if (session === undefined || included.has(key)) continue
          out.push(session)
          included.add(key)
        }
        for (const session of [...stray].sort(byRecency)) {
          if (included.has(session.id)) continue
          out.push(session)
        }
        return out
      })()
    ungrouped = {
      key: UNGROUPED_KEY,
      workspaceId: undefined,
      cwd: undefined,
      createdAt: undefined,
      label: UNGROUPED_LABEL,
      sessionCount: ordered.length,
      expanded: expandedGroups.has(UNGROUPED_KEY),
      containsCurrent: currentGroup === UNGROUPED_KEY,
      status: workspaceSessionStatus(ordered, descendants),
      sessions: expandedGroups.has(UNGROUPED_KEY)
        ? ordered.map(session => sessionNode(session, descendants, list.current))
        : [],
    }
  }
  return { folders: foldersOut, topLevel, ungrouped }
}

/**
 * Derive the flat session list ("In one list" mode): every session — fork
 * children included — as a top-level row, strictly newest-first.
 * @param list - sessions list snapshot.
 * @param archivedSessionIds - registry-global archive set.
 * @returns flat rows in render order.
 */
export function deriveFlat(
  list: SessionListState,
  archivedSessionIds: readonly SessionId[],
  pending: SessionPendingInteractions = EMPTY_PENDING,
): SessionNode[] {
  const archived = new Set(archivedSessionIds)
  const descendants = indexSubagentDescendants(list.byId)
  const rows: SessionSummary[] = []
  for (const id of list.ids) {
    const session = list.byId[id]
    if (session === undefined || !sessionVisible(session, list.current, archived)) continue
    rows.push(session)
  }
  rows.sort(byRecency)
  return rows.map(session => sessionNode(session, descendants, list.current, pending))
}

/**
 * Filter flat session rows down to the ones matching `query`
 * (case-insensitive substring on the display title). Blank placeholders
 * never match (their canonical title displays localized, so matching it
 * would tie search to one language).
 * @param rows - the derived flat list ("In one list" mode).
 * @param query - caller text; surrounding whitespace is ignored.
 * @returns the matching rows, unchanged for a blank query.
 */
export function filterFlatByQuery(rows: readonly SessionNode[], query: string): readonly SessionNode[] {
  const q = query.trim().toLowerCase()
  if (q === '') return rows
  return rows.filter(row => !row.blank && row.title.toLowerCase().includes(q))
}

/**
 * Filter the derived folder forest down to the rows matching `query`
 * (case-insensitive substring), preserving the ORIGINAL tree structure:
 * a workspace leaf stays when its display label, its cwd basename, or any
 * of its visible sessions' titles matches ("dir-level" and "session-level"
 * hits keep the same row); a folder stays when its own name matches or any
 * descendant stays; folders holding a descendant match render expanded so
 * the kept rows are reachable without extra clicks. Blank / archived /
 * subagent-origin sessions never match.
 * @param forest - the browser's derived folder forest.
 * @param sessions - sessions list snapshot (session-title authority).
 * @param workspaces - Workspace membership and display titles.
 * @param query - caller text; surrounding whitespace is ignored.
 * @param archivedSessionIds - registry-global archive set.
 * @returns the filtered forest, preserving the original row shapes; all
 *   sections are empty when nothing matches (the caller shows the hint).
 */
export function filterForestByQuery(
  forest: ForestResult,
  sessions: SessionListState,
  workspaces: readonly WorkspaceView[],
  query: string,
  archivedSessionIds: readonly SessionId[],
): ForestResult {
  const q = query.trim().toLowerCase()
  if (q === '') return forest
  const archived = new Set(archivedSessionIds)
  const has = (text: string | undefined): boolean => text !== undefined && text.toLowerCase().includes(q)
  const basename = (path: string): string => path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''

  // Stray sessions (outside every workspace) are the ungrouped bucket's members.
  const accounted = new Set<SessionId>()
  for (const workspace of workspaces) {
    for (const id of workspace.sessionIds) accounted.add(id)
  }
  const forestUngroupedSessionIds = sessions.ids.filter(id => !accounted.has(id))
  // Session-level matches of one workspace (or the ungrouped bucket): the
  // visible summaries behind its session ids.
  const visibleSessionTitles = (sessionIds: readonly SessionId[]): readonly string[] => {
    const titles: string[] = []
    for (const id of sessionIds) {
      const summary = sessions.byId[id]
      if (summary === undefined || summary.blank || !sessionVisible(summary, sessions.current, archived)) continue
      titles.push(sessionTitle(summary))
    }
    return titles
  }
  const workspaceMatches = (leaf: WorkspaceLeaf): boolean => {
    if (has(leaf.label)) return true
    if (has(basename(leaf.cwd ?? ''))) return true
    if (leaf.workspaceId !== undefined) {
      const workspace = workspaces.find(candidate => candidate.workspaceId === leaf.workspaceId)
      if (workspace !== undefined) return visibleSessionTitles(workspace.sessionIds).some(title => has(title))
      return false
    }
    // The ungrouped bucket: label or any stray session title.
    return visibleSessionTitles(forestUngroupedSessionIds).some(title => has(title))
  }

  const filterFolder = (node: FolderNode): FolderNode | undefined => {
    const children: FolderNode[] = []
    for (const child of node.children) {
      const filtered = filterFolder(child)
      if (filtered !== undefined) children.push(filtered)
    }
    const workspaceGroups = node.workspaceGroups.filter(workspaceMatches)
    if (children.length === 0 && workspaceGroups.length === 0 && !has(node.name)) return undefined
    return {
      ...node,
      children,
      workspaceGroups,
      // A folder holding a descendant match opens so the kept rows show;
      // a name-only match keeps the folder's own expansion state.
      expanded: node.expanded || children.length > 0 || workspaceGroups.length > 0,
    }
  }

  return {
    folders: forest.folders.map(filterFolder).filter((node): node is FolderNode => node !== undefined),
    topLevel: forest.topLevel.filter(workspaceMatches),
    ungrouped: forest.ungrouped !== undefined && workspaceMatches(forest.ungrouped) ? forest.ungrouped : undefined,
  }
}

/** One new-query observation pass over the session list. */
export interface SessionActivityObservation {
  /** Sessions whose stamp advanced past what the previous pass saw (a new query send). */
  advanced: readonly SessionId[]
  /** The next seen table: every current session seeded at its stamp. */
  seen: Readonly<Record<string, number>>
}

/**
 * Detect new-query sends from the sessions snapshot. The host bumps a
 * session's `updatedAt` on every durable session mutation, and sending a new
 * query is the dominant one — so a stamp advancing past what a previous pass
 * saw means the session received fresh activity since (the read API exposes
 * no separate "query sent" event, so the stamp advance is the observation).
 * First-seen sessions are baseline-seeded and never reported (their
 * appearance is not a query send); sessions that vanished are forgotten.
 * Side-effect free: the caller maps `advanced` to workspace touches.
 * @param seen - stamps recorded by the previous pass ({@link SessionActivityObservation.seen}).
 * @param byId - current session summaries keyed by id.
 * @returns the advanced sessions plus the next seen table.
 */
export function observeSessionActivity(
  seen: Readonly<Record<string, number>>,
  byId: Readonly<Record<SessionId, SessionSummary>>,
): SessionActivityObservation {
  const advanced: SessionId[] = []
  const nextSeen: Record<string, number> = {}
  for (const [id, session] of Object.entries(byId)) {
    const previous = seen[id]
    if (previous !== undefined && session.updatedAt > previous) advanced.push(session.id)
    nextSeen[id] = session.updatedAt
  }
  return { advanced, seen: nextSeen }
}

/** One rendered row of the recency module: a workspace leaf (expandable session list, order, `containsCurrent`) plus its recency stamp. */
export interface RecentsNode extends WorkspaceLeaf {
  /** The row's score: max(query-send touch, derived activity time). */
  updatedAt: number
}

/**
 * Derive the recency module rows: the `limit` most recently queried
 * workspaces as full {@link WorkspaceLeaf} rows — the same expandable
 * workspace row the forest renders (session list, row menu, contain
 * `containsCurrent`), plus the recency stamp for the trailing relative time.
 * Every workspace is scored by `max(touchAt, derivedAt)` where derived
 * activity is the newest session `updatedAt` (falling back to the workspace
 * `createdAt` without sessions), newest first with the workspace id as the
 * deterministic tiebreak. Touch stamps are written exclusively by
 * {@link observeSessionActivity} — a stamp means a new query was sent in the
 * workspace (clicks and opens never touch), while the derived activity keeps
 * workspaces ranked on session activity the observer had not seen yet.
 * @param workspaces - real workspaces in stable Host order.
 * @param sessions - sessions list snapshot.
 * @param touches - recorded query-send timestamps by workspace id.
 * @param limit - maximum rows.
 * @param view - expansion state and per-account session orders.
 * @param archivedSessionIds - registry-global archive set.
 * @returns recency rows in display order.
 */
export function deriveRecentWorkspaces(
  workspaces: readonly WorkspaceView[],
  sessions: SessionListState,
  touches: Readonly<Record<string, number>>,
  limit: number,
  view: ForestView,
  archivedSessionIds: readonly SessionId[] = [],
): RecentsNode[] {
  const archived = new Set(archivedSessionIds)
  const expandedGroups = expandedGroupKeys(view)
  const descendants = indexSubagentDescendants(sessions.byId)
  const scored = workspaces.map((workspace): { node: RecentsNode; score: number } => {
    let derived = Date.parse(workspace.createdAt)
    for (const id of workspace.sessionIds) {
      const summary = sessions.byId[id]
      if (summary !== undefined) derived = Math.max(derived, summary.updatedAt)
    }
    const score = Math.max(touches[workspace.workspaceId] ?? 0, derived)
    return {
      node: {
        // The prefixed row key keeps the recency module's expand/collapse
        // independent from the workspace list's rows (no linkage).
        ...buildLeaf(workspace, sessions, archived, expandedGroups, view, descendants, EMPTY_PENDING, recentGroupKey(workspace.workspaceId)),
        updatedAt: score,
      },
      score,
    }
  })
  scored.sort((left, right) => right.score - left.score
    || (left.node.key < right.node.key ? -1 : 1))
  return scored.slice(0, limit).map(entry => entry.node)
}

/** One rendered row of the recent-files directory tree: a path segment at its depth. */
export interface RecentFileTreeRow {
  /** Segment depth below the path root; the renderer indents by it. */
  depth: number
  /** `dir` rows render with a trailing separator. */
  kind: 'dir' | 'file'
  /** The segment's own name (never empty; separators were split off). */
  name: string
  /** The row's full path from the root, for the clipped-name tooltip. */
  path: string
}

/** One directory node of the recent-files tree: subdirectories and leaf names. */
interface RecentFileDir {
  dirs: Map<string, RecentFileDir>
  files: string[]
}

/**
 * Split one path into its non-empty segments on both separators, so POSIX
 * and Windows roots alike lose their leading separator (a drive letter like
 * `C:` remains a first segment).
 */
function pathSegments(path: string): string[] {
  return path.split(/[/\\]/).filter(segment => segment !== '')
}

/**
 * Shorten one path against the project root: a path under `root` (the
 * session's project directory) loses the root prefix, a sibling merely
 * sharing the prefix keeps its full form, and a root-equal path becomes
 * empty. Omitted root keeps the path verbatim.
 * @param path - the stored, model-facing path.
 * @param root - the project directory to shorten.
 * @returns the display path.
 */
function displayPath(path: string, root?: string): string {
  if (root === undefined) return path
  const base = root.replace(/[/\\]+$/, '')
  if (path === base) return ''
  const separator = path[base.length]
  if (path.startsWith(base) && (separator === '/' || separator === '\\')) {
    return path.slice(base.length)
  }
  return path
}

/**
 * One flat list row: the file's name and its display path (shortened under
 * `root`), the "name | path" shape the hover card's list mode renders.
 */
export interface RecentFileListRow {
  /** The file's basename. */
  name: string
  /** The display path (root-shortened when under it). */
  path: string
}

/**
 * The hover card's flat file list (list mode): every path as one row of
 * `name | path`, in the recency order the projection served, deduplicated
 * defensively. No directory scaffolding, no row budget — the scrollable file
 * box bounds the card instead.
 * @param paths - recency-ordered distinct paths (exactly one of the
 *   projection's `recentInputs`/`recentOutputs` lists).
 * @param root - the project directory to shorten; omitted keeps paths verbatim.
 * @returns the list rows.
 */
export function recentFileList(paths: readonly string[], root?: string): readonly RecentFileListRow[] {
  const rows: RecentFileListRow[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    if (seen.has(path)) continue
    const segments = pathSegments(displayPath(path, root))
    if (segments.length === 0) continue
    seen.add(path)
    rows.push({ name: segments.at(-1) as string, path: segments.join('/') })
  }
  return rows
}

/**
 * The session hover card's recent-files directory tree: the recency-ordered
 * path list folded into nested segments and rendered depth-first with each
 * level's directories before its files (both in the order the paths arrived,
 * which is most-recently-modified first). Two compaction rules keep the card
 * short: a single file renders as one flat VSCode-style path row (no dir
 * rows at all), and a run of directories where every level holds exactly one
 * subdirectory and no file merges into one row — `src/client/rows/` renders
 * as a single merged row instead of three. Paths inside `root` (the
 * session's project directory) display relative to it; paths outside keep
 * their full form. The render budget is `rowLimit` rows — every retained
 * but unrendered file counts into `hiddenFiles` so the card can report the
 * exact remainder.
 * @param paths - recency-ordered distinct paths (exactly one of the
 *   projection's `recentInputs`/`recentOutputs` lists; deduplicated
 *   defensively here regardless).
 * @param rowLimit - maximum rendered `dir` + `file` rows.
 * @param root - the project directory to shorten; omitted keeps paths verbatim.
 * @returns the flattened rows and the number of files kept off the card.
 */
export function recentFileTree(
  paths: readonly string[],
  rowLimit: number,
  root?: string,
): { rows: readonly RecentFileTreeRow[]; hiddenFiles: number } {
  const treeRoot: RecentFileDir = { dirs: new Map(), files: [] }
  const seen = new Set<string>()
  let fileCount = 0
  let singlePath = ''
  for (const path of paths) {
    if (seen.has(path)) continue
    const display = displayPath(path, root)
    const segments = pathSegments(display)
    if (segments.length === 0) continue
    seen.add(path)
    if (fileCount === 0) singlePath = segments.join('/')
    fileCount += 1
    let dir = treeRoot
    for (const segment of segments.slice(0, -1)) {
      let child = dir.dirs.get(segment)
      if (child === undefined) {
        child = { dirs: new Map(), files: [] }
        dir.dirs.set(segment, child)
      }
      dir = child
    }
    const name = segments.at(-1) as string
    if (!dir.files.includes(name)) dir.files.push(name)
  }
  // VSCode-style single-file display: one path, one flat row. The path is
  // the row's name (shortened under `root`), so a lone deep file needs no
  // directory scaffolding.
  if (fileCount === 1) {
    return { rows: [{ depth: 0, kind: 'file', name: singlePath, path: singlePath }], hiddenFiles: 0 }
  }
  const rows: RecentFileTreeRow[] = []
  let renderedFiles = 0
  /**
   * Emit one row for `name` (a directory) merged with any descending
   * singleton chain — every level that holds exactly one subdirectory and no
   * file of its own — then recurse into the chain end's children. A file
   * at any level stops the chain there, so `src/client/` with `tree.ts`
   * still renders `src` and its chain separately.
   * @param name - this directory's segment.
   * @param dir - this directory's node.
   * @param depth - the row's indent depth.
   * @param prefix - accumulated path before this directory's segment.
   */
  const walk = (name: string, dir: RecentFileDir, depth: number, prefix: string): void => {
    if (rows.length >= rowLimit) return
    const chain: string[] = [name]
    let node = dir
    let chainPrefix = `${prefix}${name}/`
    while (node.dirs.size === 1 && node.files.length === 0) {
      // The size guard means this loop body runs exactly once.
      for (const [nextName, child] of node.dirs) {
        chain.push(nextName)
        chainPrefix += `${nextName}/`
        node = child
      }
    }
    rows.push({ depth, kind: 'dir', name: chain.join('/'), path: chainPrefix })
    for (const [childName, child] of node.dirs) {
      if (rows.length >= rowLimit) return
      walk(childName, child, depth + 1, chainPrefix)
    }
    for (const childName of node.files) {
      if (rows.length >= rowLimit) return
      rows.push({ depth: depth + 1, kind: 'file', name: childName, path: `${chainPrefix}${childName}` })
      renderedFiles += 1
    }
  }
  for (const [name, dir] of treeRoot.dirs) walk(name, dir, 0, '')
  for (const name of treeRoot.files) {
    if (rows.length >= rowLimit) return { rows, hiddenFiles: fileCount - renderedFiles }
    rows.push({ depth: 0, kind: 'file', name, path: name })
    renderedFiles += 1
  }
  return { rows, hiddenFiles: fileCount - renderedFiles }
}

/** Relative-time bucket of a row's trailing label. */
export type RelativeTimeUnit = 'now' | 'minutes' | 'hours' | 'days' | 'months' | 'years'

/** Structured relative time: the bucket plus its magnitude (0 for 'now'). */
export interface RelativeTime {
  unit: RelativeTimeUnit
  n: number
}

/**
 * Compact relative time for recency rows, as a structured bucket the renderer
 * localizes.
 * @param updatedAt - epoch ms of the last activity.
 * @param now - current epoch ms (injected for pure rendering).
 * @returns the bucket and magnitude.
 */
export function relativeTime(updatedAt: number, now: number): RelativeTime {
  const MIN = 60_000
  const HOUR = 3_600_000
  const DAY = 86_400_000
  const diff = Math.max(0, now - updatedAt)
  if (diff < MIN) return { unit: 'now', n: 0 }
  if (diff < HOUR) return { unit: 'minutes', n: Math.floor(diff / MIN) }
  if (diff < DAY) return { unit: 'hours', n: Math.floor(diff / HOUR) }
  if (diff < 30 * DAY) return { unit: 'days', n: Math.floor(diff / DAY) }
  if (diff < 365 * DAY) return { unit: 'months', n: Math.floor(diff / (30 * DAY)) }
  return { unit: 'years', n: Math.floor(diff / (365 * DAY)) }
}
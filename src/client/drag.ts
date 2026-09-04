/**
 * Drop state machine of the enhanced browser: drag sources (workspace rows
 * and folder rows), drop zones computed from the pointer position over a
 * target row, and drop operations resolved against the folder tree. Every
 * function here is side-effect free; the browser dispatches the resolved
 * operation through the store actions, which enforce the tree guards
 * (cycle / depth / root / sibling names) and fail non-fatally.
 *
 * Drop semantics follow the design doc FR-1: a workspace dragged onto a
 * folder row moves INTO that folder (appended); a workspace dragged onto a
 * workspace row anchors before/after it inside that row's owning folder; a
 * folder dragged onto a folder row moves under it ('on') or reorders
 * relative to it ('before'/'after'). Interleaving folders and workspaces at
 * one level is not representable, so folder targets never serve as workspace
 * anchors and vice versa. Dropping a row onto itself is a no-op.
 * @module dsh-enhanced-workspace/client/drag
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import { FolderId, folderOfWorkspace, ROOT_FOLDER_ID, type FolderId as FolderIdBrand, type FolderTree } from './model.ts'

/** What is being dragged. */
export type DragKind = 'workspace' | 'folder'

/** The drag source: the row kind plus the dragged id (workspace or folder id). */
export interface DragSource {
  kind: DragKind
  id: string
}

/** Drop position relative to the target row. */
export type DropZone = 'before' | 'on' | 'after'

/** A drop target row: its kind and id plus the computed pointer zone. */
export interface DropTarget {
  kind: 'folder' | 'workspace'
  id: string
  zone: DropZone
}

/** Outcome of a drop resolution: nothing to do, or a move to dispatch. */
export type DropResolution =
  | { kind: 'noop' }
  | { kind: 'move-workspace'; folderId: FolderIdBrand; beforeWorkspaceId?: WorkspaceId }
  | { kind: 'move-folder'; beforeFolderId?: FolderIdBrand; parentFolderId?: FolderIdBrand }

/**
 * Drop zone over a workspace row: the pointer above the row's midpoint lands
 * 'before' it, below lands 'after' it.
 * @param rect - the target row's bounding rect.
 * @param clientY - the pointer's viewport Y.
 */
export function rowDropZone(rect: Pick<DOMRect, 'top' | 'height'>, clientY: number): 'before' | 'after' {
  return clientY < rect.top + rect.height / 2 ? 'before' : 'after'
}

/**
 * Drop zone over a folder row: a middle band means 'on' (move into that
 * folder); the edges reorder relative to the folder row within its parent.
 * @param rect - the target row's bounding rect.
 * @param clientY - the pointer's viewport Y.
 */
export function folderDropZone(rect: Pick<DOMRect, 'top' | 'height'>, clientY: number): DropZone {
  const mid = rect.top + rect.height / 2
  const band = rect.height * 0.15
  if (clientY >= mid - band && clientY <= mid + band) return 'on'
  return clientY < mid ? 'before' : 'after'
}

/**
 * Resolve dropping a workspace onto a target row:
 * - folder target: move into that folder, appended ("拖到目录行 = 移入该目录
 *   末尾");
 * - workspace target: anchor-insert inside the target's owning folder —
 *   'before' inserts right before it, 'after' right after it (or appends when
 *   the target is the folder's last workspace). Dropping onto the workspace's
 *   own row is a no-op.
 * @param folders - the plugin's folder tree (display authority).
 * @param workspaceId - the dragged workspace.
 * @param targetKind - the drop-target row kind.
 * @param targetId - the drop-target row id (folder id or workspace id).
 * @param zone - the pointer zone over the target row.
 * @returns the drop resolution; the caller dispatches it through the store
 *   actions (their no-op and guard semantics apply on top).
 */
export function resolveWorkspaceDrop(
  folders: FolderTree,
  workspaceId: WorkspaceId,
  targetKind: 'folder' | 'workspace',
  targetId: string,
  zone: DropZone,
): DropResolution {
  if (targetKind === 'folder') {
    return { kind: 'move-workspace', folderId: FolderId(targetId) }
  }
  if (targetId === workspaceId) return { kind: 'noop' }
  const ownerId = folderOfWorkspace(folders, targetId as WorkspaceId) ?? ROOT_FOLDER_ID
  const owner = folders[ownerId]
  if (owner !== undefined && zone === 'after') {
    const at = owner.workspaceIds.indexOf(targetId as WorkspaceId)
    const next = owner.workspaceIds[at + 1]
    if (next !== undefined) return { kind: 'move-workspace', folderId: ownerId, beforeWorkspaceId: next }
  }
  return {
    kind: 'move-workspace',
    folderId: ownerId,
    ...(zone === 'before' ? { beforeWorkspaceId: targetId as WorkspaceId } : {}),
  }
}

/**
 * Resolve dropping a folder onto a target folder row:
 * - 'on' moves it under the target (appended);
 * - 'before' reorders it right before the target inside the target's parent;
 * - 'after' reorders it right after the target (or appends when the target
 *   is its parent's last folder). Dropping the folder onto itself is a no-op.
 * Cycle / depth / root guards stay with the store action.
 * @param folders - the plugin's folder tree.
 * @param folderId - the dragged folder.
 * @param targetId - the drop-target folder row.
 * @param zone - the pointer zone over the target row.
 * @returns the drop resolution; `{}`-like no-op when the target is not a folder.
 */
export function resolveFolderDrop(
  folders: FolderTree,
  folderId: FolderIdBrand,
  targetId: FolderIdBrand,
  zone: DropZone,
): DropResolution {
  if (folderId === targetId) return { kind: 'noop' }
  const target = folders[targetId]
  if (target === undefined) return { kind: 'noop' }
  if (zone === 'on') return { kind: 'move-folder', parentFolderId: targetId }
  const parentId = target.parentFolderId
  if (parentId === null) return { kind: 'noop' }
  const parent = folders[parentId]
  if (parent === undefined) return { kind: 'noop' }
  if (zone === 'before') return { kind: 'move-folder', beforeFolderId: targetId, parentFolderId: parentId }
  const next = parent.folderIds[parent.folderIds.indexOf(targetId) + 1]
  if (next !== undefined) return { kind: 'move-folder', beforeFolderId: next, parentFolderId: parentId }
  return { kind: 'move-folder', parentFolderId: parentId }
}
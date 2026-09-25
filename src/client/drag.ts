/**
 * Drop state machine of the enhanced browser: drag sources (workspace rows
 * and folder rows), drop zones computed from the pointer position over a
 * target row, and drop operations resolved against the folder tree. Every
 * function here is side-effect free; the browser dispatches the resolved
 * operation through the store actions, which enforce the tree guards
 * (cycle / depth / root / sibling names) and fail non-fatally.
 *
 * Drop semantics follow the design doc FR-1 with one level's children now
 * living in ONE unified account (folders and workspaces interleave): a
 * workspace dragged onto a folder row's MIDDLE ('on') moves INTO that folder
 * (appended); the row's TOP/BOTTOM edges ('before'/'after') position the
 * workspace at that folder's own slot in its parent level — directly before
 * or after the folder row, interleaving the level (a top-level folder's
 * parent is the root, so the workspace lands at the browser's top level). A
 * workspace dragged onto a workspace row anchors before/after it inside that
 * row's owning folder. A folder dragged onto a folder row moves under it
 * ('on') or reorders relative to it; a folder dragged onto a workspace row
 * reorders relative to that workspace (folders and workspaces are equal
 * anchor citizens now). Dropping a row onto itself is a no-op.
 * @module dsh-enhanced-workspace/client/drag
 */

import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  FolderId,
  ROOT_FOLDER_ID,
  folderChild,
  folderOfWorkspace,
  isChildOf,
  workspaceChild,
  type FolderChild,
  type FolderId as FolderIdBrand,
  type FolderTree,
} from './model.ts'

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
  | { kind: 'move-workspace'; folderId: FolderIdBrand; beforeChild?: FolderChild }
  | { kind: 'move-folder'; beforeChild?: FolderChild; parentFolderId?: FolderIdBrand }

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
 * folder); the edges position the row relative to that folder within its
 * parent level.
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
 * - folder target, 'on': move into that folder, appended ("拖到目录行正中 =
 *   移入该目录末尾");
 * - folder target, 'before' / 'after': position the workspace at the folder
 *   row's own slot in the parent level — before or after the folder row,
 *   interleaving the level (levels share one child account, so no outer-level
 *   fallback is needed anymore);
 * - workspace target: anchor-insert inside the target's owning folder —
 *   'before' inserts right before it, 'after' right after it (or appends when
 *   the target is the level's last child). Dropping onto the workspace's own
 *   row is a no-op.
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
    if (zone === 'on') return { kind: 'move-workspace', folderId: FolderId(targetId) }
    const parentId = folders[targetId as FolderId]?.parentFolderId
    if (parentId === null || parentId === undefined) return { kind: 'noop' }
    if (zone === 'before') {
      return { kind: 'move-workspace', folderId: parentId, beforeChild: folderChild(FolderId(targetId)) }
    }
    // 'after': insert after the folder row at its parent level.
    const parent = folders[parentId]
    const at = parent?.children.findIndex(child => isChildOf(child, 'folder', targetId)) ?? -1
    const next = parent?.children[at + 1]
    if (next !== undefined) return { kind: 'move-workspace', folderId: parentId, beforeChild: next }
    return { kind: 'move-workspace', folderId: parentId }
  }
  if (targetId === workspaceId) return { kind: 'noop' }
  const ownerId = folderOfWorkspace(folders, targetId as WorkspaceId) ?? ROOT_FOLDER_ID
  const owner = folders[ownerId]
  if (owner !== undefined && zone === 'after') {
    const at = owner.children.findIndex(child => isChildOf(child, 'workspace', targetId))
    const next = owner.children[at + 1]
    if (next !== undefined) return { kind: 'move-workspace', folderId: ownerId, beforeChild: next }
  }
  return {
    kind: 'move-workspace',
    folderId: ownerId,
    ...(zone === 'before' ? { beforeChild: workspaceChild(targetId as WorkspaceId) } : {}),
  }
}

/**
 * Resolve dropping a folder onto a target row:
 * - folder target, 'on': move it under the target (appended);
 * - folder target, 'before' / 'after': reorder it relative to the target
 *   inside the target's parent level;
 * - workspace target: reorder it relative to that workspace row inside the
 *   workspace's owning folder ('before' / 'after'; appends when the target is
 *   the level's last child) — folders and workspaces interleave as equals.
 * Dropping the folder onto itself is a no-op.
 * Cycle / depth / root guards stay with the store action.
 * @param folders - the plugin's folder tree.
 * @param folderId - the dragged folder.
 * @param targetKind - the drop-target row kind.
 * @param targetId - the drop-target row id (folder id or workspace id).
 * @param zone - the pointer zone over the target row.
 * @returns the drop resolution; a no-op when the target cannot serve as an anchor.
 */
export function resolveFolderDrop(
  folders: FolderTree,
  folderId: FolderIdBrand,
  targetKind: 'folder' | 'workspace',
  targetId: string,
  zone: DropZone,
): DropResolution {
  if (targetKind === 'workspace') {
    if (zone === 'on') return { kind: 'noop' }
    const ownerId = folderOfWorkspace(folders, targetId as WorkspaceId) ?? ROOT_FOLDER_ID
    const owner = folders[ownerId]
    if (owner === undefined) return { kind: 'noop' }
    if (zone === 'before') {
      return { kind: 'move-folder', parentFolderId: ownerId, beforeChild: workspaceChild(targetId as WorkspaceId) }
    }
    const at = owner.children.findIndex(child => isChildOf(child, 'workspace', targetId))
    const next = owner.children[at + 1]
    if (next !== undefined) return { kind: 'move-folder', parentFolderId: ownerId, beforeChild: next }
    return { kind: 'move-folder', parentFolderId: ownerId }
  }
  if (folderId === targetId) return { kind: 'noop' }
  const target = folders[targetId as FolderIdBrand]
  if (target === undefined) return { kind: 'noop' }
  if (zone === 'on') return { kind: 'move-folder', parentFolderId: targetId as FolderIdBrand }
  const parentId = target.parentFolderId
  if (parentId === null) return { kind: 'noop' }
  const parent = folders[parentId]
  if (parent === undefined) return { kind: 'noop' }
  if (zone === 'before') {
    return { kind: 'move-folder', parentFolderId: parentId, beforeChild: folderChild(targetId as FolderIdBrand) }
  }
  const at = parent.children.findIndex(child => isChildOf(child, 'folder', targetId))
  const next = parent.children[at + 1]
  // The dragged folder sitting right after the target resolves to the
  // self-anchor; the model treats "before itself" as a no-op.
  if (next !== undefined) return { kind: 'move-folder', parentFolderId: parentId, beforeChild: next }
  return { kind: 'move-folder', parentFolderId: parentId }
}
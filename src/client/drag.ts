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
  MAX_FOLDER_DEPTH,
  ROOT_FOLDER_ID,
  depthOf,
  folderChild,
  folderOfWorkspace,
  isChildOf,
  isDescendantOf,
  workspaceChild,
  type FolderChild,
  type FolderId as FolderIdBrand,
  type FolderRowNode,
  type FolderTree,
  type WorkspaceLeaf,
} from './model.ts'

/** What is being dragged. */
export type DragKind = 'workspace' | 'folder'

/** The drag source: the row kind plus the dragged id (workspace or folder id). */
export interface DragSource {
  kind: DragKind
  id: string
}

/**
 * Selection key of one tree row: `kind:id` (the same spelled identity the
 * drag group uses). Row kinds without an id (the ungrouped bucket) have no
 * key and can never be selected.
 */
export function selectionKeyOf(kind: DragKind, id: string): string {
  return `${kind}:${id}`
}

/**
 * The rows a group drag carries, in display order: recency rows first (in
 * their recency order), then the folder forest depth-first (expanded folders
 * only — their hidden children are never visible, and the selection is
 * pruned to the visible rows on every fold change), mixing folders and
 * workspaces as they interleave on screen. Duplicate ids (a recency row
 * whose workspace also appears in the tree) collapse to the first
 * occurrence. Only rows the caller selected participate.
 * @param recents - the recency module's rows, top first.
 * @param topRows - the "all" section's top-level rows (folder forest +
 *   root-level leaves) in display order.
 * @param selectedKeys - the current selection's `selectionKeyOf` set.
 * @returns the ordered drag group (empty when nothing selected).
 */
export function orderedDragSources(
  recents: readonly WorkspaceLeaf[],
  topRows: readonly FolderRowNode[],
  selectedKeys: ReadonlySet<string>,
): readonly DragSource[] {
  const sources: DragSource[] = []
  const seen = new Set<string>()
  const push = (kind: DragKind, id: string): void => {
    const key = selectionKeyOf(kind, id)
    if (!selectedKeys.has(key) || seen.has(key)) return
    seen.add(key)
    sources.push({ kind, id })
  }
  for (const recent of recents) {
    if (recent.workspaceId !== undefined) push('workspace', recent.workspaceId)
  }
  const walk = (rows: readonly FolderRowNode[]): void => {
    for (const row of rows) {
      if (row.kind === 'folder') {
        push('folder', row.node.folderId)
        if (row.node.expanded) walk(row.node.rows)
      } else if (row.leaf.workspaceId !== undefined) {
        push('workspace', row.leaf.workspaceId)
      }
    }
  }
  walk(topRows)
  return sources
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

/** One group-drop member: the dragged row plus its resolved outcome. */
export interface GroupDropItem {
  source: DragSource
  resolution: DropResolution
}

/**
 * Resolve a GROUP drop (⌘/Ctrl+click multi-select dragged together): every
 * source resolves independently against the ORIGINAL tree with the same
 * per-kind rules as a single drag, so the group keeps its display order when
 * the moves apply sequentially (insert-before anchors compose: each next
 * source lands behind the previous one at the same anchor; an 'after' anchor
 * already resolves to its next sibling / append). Group-aware pre-skips turn
 * the moves a single drag would surrender to the store guards into clean
 * no-ops:
 * - a workspace dropped onto its own row is a no-op (single-drag rule);
 * - a folder source dropped 'on' a folder row that IS the folder itself or
 *   lies inside its own subtree is a no-op (the cycle guard would reject);
 * - a folder source dropped 'on' a folder row already at
 *   {@link MAX_FOLDER_DEPTH} is a no-op (the depth guard would reject).
 * The remaining per-item guard failures (reorder anchors whose owning folder
 * sits inside the dragged folder's subtree, depth on reorders) stay with the
 * store actions — the browser skips those items non-fatally, so one bad
 * member never cancels the whole group move.
 * @param folders - the plugin's folder tree (display authority).
 * @param sources - the dragged rows in display order (see
 *   {@link orderedDragSources}); one entry = an ordinary single drag.
 * @param target - the drop-target row + pointer zone, shared by every source.
 * @returns one item per source, in the same order (no-op resolutions
 *   included); the browser dispatches each move with the item's source id.
 */
export function resolveGroupDrop(
  folders: FolderTree,
  sources: readonly DragSource[],
  target: DropTarget,
): readonly GroupDropItem[] {
  return sources.map(source => {
    const folderId = source.id as FolderIdBrand
    const resolution = source.kind === 'workspace'
      ? resolveWorkspaceDrop(folders, source.id as WorkspaceId, target.kind, target.id, target.zone)
      : resolveGroupFolderDrop(folders, folderId, target)
    return { source, resolution }
  })
}

/** The folder-source half of {@link resolveGroupDrop}: the single-drag
 *  resolver plus the group-aware pre-skips ('on' a folder that is itself or
 *  sits inside one's own subtree, or is already at max depth). */
function resolveGroupFolderDrop(
  folders: FolderTree,
  folderId: FolderIdBrand,
  target: DropTarget,
): DropResolution {
  if (target.kind === 'workspace') {
    return resolveFolderDrop(folders, folderId, 'workspace', target.id, target.zone)
  }
  // Folder source onto a folder row.
  if (target.id === folderId) return { kind: 'noop' }
  if (target.zone === 'on') {
    const targetFolderId = FolderId(target.id)
    if (targetFolderId === folderId || isDescendantOf(folders, targetFolderId, folderId)) return { kind: 'noop' }
    if (depthOf(folders, targetFolderId) >= MAX_FOLDER_DEPTH) return { kind: 'noop' }
  }
  return resolveFolderDrop(folders, folderId, 'folder', target.id, target.zone)
}
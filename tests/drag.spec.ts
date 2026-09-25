import { describe, expect, it } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { FolderId, FolderTree } from '../src/client/model.ts'
import {
  ROOT_FOLDER_ID,
  createFolderIn,
  folderChild,
  moveWorkspaceIn,
  workspaceChild,
  FolderId as folderIdOf,
} from '../src/client/model.ts'
import { folderDropZone, resolveFolderDrop, resolveWorkspaceDrop, rowDropZone } from '../src/client/drag.ts'

const W = (id: string): WorkspaceId => id as WorkspaceId
const F = (id: string): FolderId => folderIdOf(id)
const NOW = '2026-09-04T00:00:00.000Z'

function rootTree(workspaceIds: readonly string[] = []): FolderTree {
  return {
    [ROOT_FOLDER_ID]: {
      folderId: ROOT_FOLDER_ID,
      name: 'Root',
      parentFolderId: null,
      children: workspaceIds.map(id => workspaceChild(W(id))),
      createdAt: NOW,
      updatedAt: NOW,
    },
  }
}

describe('rowDropZone / folderDropZone', () => {
  const rect = { top: 100, height: 48 }

  it('splits a workspace row at its midpoint into before/after', () => {
    expect(rowDropZone(rect, 123)).toBe('before')
    expect(rowDropZone(rect, 124)).toBe('after')
  })

  it('reserves a middle band of a folder row for "on"', () => {
    expect(folderDropZone(rect, 100)).toBe('before')
    expect(folderDropZone(rect, 123)).toBe('on') // mid=124, band≈7.2
    expect(folderDropZone(rect, 124)).toBe('on')
    expect(folderDropZone(rect, 147)).toBe('after')
  })
})

describe('resolveWorkspaceDrop', () => {
  it('moves a workspace into a folder row (appended) on the middle band', () => {
    let tree = rootTree(['w1'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, '团队', F('团队'), NOW).folders
    const result = resolveWorkspaceDrop(tree, W('w1'), 'folder', '团队', 'on')
    expect(result).toEqual({ kind: 'move-workspace', folderId: F('团队') })
  })

  it('interleaves at the folder row\'s own slot on the before/after edges', () => {
    let tree = rootTree(['w1'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, '团队', F('团队'), NOW).folders
    tree = moveWorkspaceIn(tree, W('w1'), F('团队'), undefined, NOW)
    // 偏上（行间）：锚定到该目录行之前 —— 与目录行同层交错，不再落到父级末尾。
    expect(resolveWorkspaceDrop(tree, W('w1'), 'folder', '团队', 'before'))
      .toEqual({ kind: 'move-workspace', folderId: ROOT_FOLDER_ID, beforeChild: folderChild(F('团队')) })
    // Nested target: the outer level is the nesting folder.
    tree = createFolderIn(tree, F('团队'), '子组', F('子组'), NOW).folders
    tree = moveWorkspaceIn(tree, W('w1'), F('子组'), undefined, NOW)
    expect(resolveWorkspaceDrop(tree, W('w1'), 'folder', '子组', 'before'))
      .toEqual({ kind: 'move-workspace', folderId: F('团队'), beforeChild: folderChild(F('子组')) })
    // 偏下：锚定到目录行之后 —— 下一个兄弟条目（若有），否则追加到该层级末尾。
    tree = createFolderIn(tree, F('团队'), '后组', F('后组'), NOW).folders // 团队: [子组, 后组]
    expect(resolveWorkspaceDrop(tree, W('w1'), 'folder', '子组', 'after'))
      .toEqual({ kind: 'move-workspace', folderId: F('团队'), beforeChild: folderChild(F('后组')) })
    // Target row is the level's last child: append instead.
    expect(resolveWorkspaceDrop(tree, W('w1'), 'folder', '后组', 'after'))
      .toEqual({ kind: 'move-workspace', folderId: F('团队') })
  })

  it('anchors before/after a workspace row inside its owning folder', () => {
    let tree = rootTree(['w1', 'w2', 'w3'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, '团队', F('团队'), NOW).folders
    tree = moveWorkspaceIn(tree, W('w3'), F('团队'), undefined, NOW)

    // w2's next sibling is the folder 团队: dropping w1 after w2 anchors
    // BEFORE the folder — the workspace interleaves the root level.
    expect(resolveWorkspaceDrop(tree, W('w1'), 'workspace', 'w2', 'after'))
      .toEqual({ kind: 'move-workspace', folderId: ROOT_FOLDER_ID, beforeChild: folderChild(F('团队')) })
    // w3 is the only workspace in 团队: dropping w1 before w3 moves it in anchored there.
    expect(resolveWorkspaceDrop(tree, W('w1'), 'workspace', 'w3', 'before'))
      .toEqual({ kind: 'move-workspace', folderId: F('团队'), beforeChild: workspaceChild(W('w3')) })
    // w3 is 团队's last child: dropping after it appends inside 团队.
    expect(resolveWorkspaceDrop(tree, W('w1'), 'workspace', 'w3', 'after'))
      .toEqual({ kind: 'move-workspace', folderId: F('团队') })
  })

  it('resolves "after" as anchored to the target\'s next sibling of ANY kind', () => {
    // Root children: b, c, a(folder): dropping w-c after w-b anchors before…
    // c itself (the dragged workspace already follows b → self-anchor no-op);
    // dropping after the folder row a appends (it is the last child).
    let tree = rootTree(['b', 'c'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    expect(resolveWorkspaceDrop(tree, W('c'), 'workspace', 'b', 'after'))
      .toEqual({ kind: 'move-workspace', folderId: ROOT_FOLDER_ID, beforeChild: workspaceChild(W('c')) })
    expect(resolveWorkspaceDrop(tree, W('c'), 'folder', 'a', 'after'))
      .toEqual({ kind: 'move-workspace', folderId: ROOT_FOLDER_ID })
    expect(resolveWorkspaceDrop(tree, W('c'), 'folder', 'a', 'before'))
      .toEqual({ kind: 'move-workspace', folderId: ROOT_FOLDER_ID, beforeChild: folderChild(F('a')) })
  })

  it('treats a drop onto the workspace\'s own row as a no-op', () => {
    const tree = rootTree(['a', 'b'])
    expect(resolveWorkspaceDrop(tree, W('a'), 'workspace', 'a', 'before')).toEqual({ kind: 'noop' })
    expect(resolveWorkspaceDrop(tree, W('a'), 'workspace', 'a', 'after')).toEqual({ kind: 'noop' })
  })
})

describe('resolveFolderDrop', () => {
  it('moves a folder under a target folder row ("on")', () => {
    let tree = rootTree()
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'b', F('b'), NOW).folders
    expect(resolveFolderDrop(tree, F('a'), 'folder', 'b', 'on'))
      .toEqual({ kind: 'move-folder', parentFolderId: F('b') })
  })

  it('reorders before/after a target folder within its parent', () => {
    let tree = rootTree()
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'b', F('b'), NOW).folders
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'c', F('c'), NOW).folders
    expect(resolveFolderDrop(tree, F('c'), 'folder', 'a', 'before'))
      .toEqual({ kind: 'move-folder', parentFolderId: ROOT_FOLDER_ID, beforeChild: folderChild(F('a')) })
    expect(resolveFolderDrop(tree, F('a'), 'folder', 'c', 'after')) // c is last → append
      .toEqual({ kind: 'move-folder', parentFolderId: ROOT_FOLDER_ID })
  })

  it('reorders a folder relative to a workspace row (interleaving as equals)', () => {
    let tree = rootTree(['w-mid'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'b', F('b'), NOW).folders
    // Root children: w-mid, a, b. Dragging b after w-mid anchors before a —
    // the folder lands BETWEEN the workspace and a.
    expect(resolveFolderDrop(tree, F('b'), 'workspace', 'w-mid', 'after'))
      .toEqual({ kind: 'move-folder', parentFolderId: ROOT_FOLDER_ID, beforeChild: folderChild(F('a')) })
    // Dragging a before w-mid anchors at the workspace row.
    expect(resolveFolderDrop(tree, F('a'), 'workspace', 'w-mid', 'before'))
      .toEqual({ kind: 'move-folder', parentFolderId: ROOT_FOLDER_ID, beforeChild: workspaceChild(W('w-mid')) })
    // The dragged folder already following the workspace resolves to the
    // self-anchor (a no-op).
    expect(resolveFolderDrop(tree, F('a'), 'workspace', 'w-mid', 'after'))
      .toEqual({ kind: 'move-folder', parentFolderId: ROOT_FOLDER_ID, beforeChild: folderChild(F('a')) })
  })

  it('drops onto itself or a missing/root target resolve to a no-op', () => {
    const tree = rootTree()
    expect(resolveFolderDrop(tree, F('a'), 'folder', 'a', 'on')).toEqual({ kind: 'noop' })
    expect(resolveFolderDrop(tree, F('a'), 'folder', 'missing', 'on')).toEqual({ kind: 'noop' })
    expect(resolveFolderDrop(tree, F('a'), 'folder', ROOT_FOLDER_ID as unknown as string, 'before')).toEqual({ kind: 'noop' })
  })
})
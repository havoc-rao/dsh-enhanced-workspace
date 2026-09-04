import { describe, expect, it } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { FolderId, FolderTree } from '../src/client/model.ts'
import { ROOT_FOLDER_ID, createFolderIn, moveWorkspaceIn, FolderId as folderIdOf } from '../src/client/model.ts'
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
      workspaceIds: workspaceIds.map(W),
      folderIds: [],
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
  it('moves a workspace into a folder row (appended)', () => {
    let tree = rootTree(['w1'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, '团队', F('团队'), NOW).folders
    const result = resolveWorkspaceDrop(tree, W('w1'), 'folder', '团队', 'on')
    expect(result).toEqual({ kind: 'move-workspace', folderId: F('团队') })
  })

  it('anchors before/after a workspace row inside its owning folder', () => {
    let tree = rootTree(['w1', 'w2', 'w3'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, '团队', F('团队'), NOW).folders
    tree = moveWorkspaceIn(tree, W('w3'), F('团队'), undefined, NOW)

    // w2 is under the root with w1 before it: dropping w1 after w2 anchors at w3?
    // (root order: w1 w2; 团队 holds w3) — dropping w1 after w2 appends under root.
    expect(resolveWorkspaceDrop(tree, W('w1'), 'workspace', 'w2', 'after'))
      .toEqual({ kind: 'move-workspace', folderId: ROOT_FOLDER_ID })
    // w3 is the only workspace in 团队: dropping w1 before w3 moves it in anchored there.
    expect(resolveWorkspaceDrop(tree, W('w1'), 'workspace', 'w3', 'before'))
      .toEqual({ kind: 'move-workspace', folderId: F('团队'), beforeWorkspaceId: W('w3') })
    // w3 is 团队's last workspace: dropping after it appends inside 团队.
    expect(resolveWorkspaceDrop(tree, W('w1'), 'workspace', 'w3', 'after'))
      .toEqual({ kind: 'move-workspace', folderId: F('团队') })
  })

  it('resolves "after" as anchored to the target\'s next sibling', () => {
    const tree = rootTree(['a', 'b', 'c'])
    expect(resolveWorkspaceDrop(tree, W('c'), 'workspace', 'a', 'after'))
      .toEqual({ kind: 'move-workspace', folderId: ROOT_FOLDER_ID, beforeWorkspaceId: W('b') })
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
    expect(resolveFolderDrop(tree, F('a'), F('b'), 'on'))
      .toEqual({ kind: 'move-folder', parentFolderId: F('b') })
  })

  it('reorders before/after a target folder within its parent', () => {
    let tree = rootTree()
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'b', F('b'), NOW).folders
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'c', F('c'), NOW).folders
    expect(resolveFolderDrop(tree, F('c'), F('a'), 'before'))
      .toEqual({ kind: 'move-folder', beforeFolderId: F('a'), parentFolderId: ROOT_FOLDER_ID })
    expect(resolveFolderDrop(tree, F('a'), F('c'), 'after')) // c is last → append
      .toEqual({ kind: 'move-folder', parentFolderId: ROOT_FOLDER_ID })
  })

  it('drops onto itself or a missing/root target resolve to a no-op', () => {
    const tree = rootTree()
    expect(resolveFolderDrop(tree, F('a'), F('a'), 'on')).toEqual({ kind: 'noop' })
    expect(resolveFolderDrop(tree, F('a'), F('missing'), 'on')).toEqual({ kind: 'noop' })
    expect(resolveFolderDrop(tree, F('a'), ROOT_FOLDER_ID, 'before')).toEqual({ kind: 'noop' })
  })
})
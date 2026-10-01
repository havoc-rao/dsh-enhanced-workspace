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
  type FolderNode,
  type FolderRowNode,
  type WorkspaceLeaf,
} from '../src/client/model.ts'
import {
  folderDropZone,
  orderedDragSources,
  resolveFolderDrop,
  resolveGroupDrop,
  resolveWorkspaceDrop,
  rowDropZone,
  selectionKeyOf,
  type DragSource,
  type DropTarget,
} from '../src/client/drag.ts'

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
/* ── Multi-select group drag (⌘/Ctrl+click) ─────────────────────────── */

/** One workspace leaf fixture row (id-derived label). */
const leaf = (id: string): WorkspaceLeaf => ({
  key: id,
  workspaceId: W(id),
  cwd: undefined,
  createdAt: 0,
  label: id,
  sessionCount: 0,
  expanded: false,
  containsCurrent: false,
  status: {},
  sessions: [],
})

/** One folder node fixture; `expanded` gates whether the walker descends. */
const folderNode = (id: string, rows: FolderRowNode[] = [], expanded = true): FolderNode => ({
  folderId: F(id),
  name: id,
  depth: 0,
  expanded,
  rows,
  sessionCount: 0,
  containsCurrent: false,
  status: {},
})

describe('orderedDragSources', () => {
  it('lists the selected rows in display order, recency section first', () => {
    const recents = [leaf('w-recent2'), leaf('w-recent1')]
    const topRows: FolderRowNode[] = [
      { kind: 'workspace', leaf: leaf('w-tree') },
      { kind: 'folder', node: folderNode('团队', [
        { kind: 'workspace', leaf: leaf('w-inner') },
        { kind: 'folder', node: folderNode('子目录', [{ kind: 'workspace', leaf: leaf('w-deep') }]) },
        { kind: 'workspace', leaf: leaf('w-inner2') },
      ]) },
    ]
    const selected = new Set([
      selectionKeyOf('workspace', 'w-inner2'),
      selectionKeyOf('workspace', 'w-recent2'),
      selectionKeyOf('workspace', 'w-inner'),
      selectionKeyOf('folder', '子目录'),
      selectionKeyOf('workspace', 'w-deep'),
      selectionKeyOf('workspace', 'w-absent'), // selected but not rendered
    ])
    expect(orderedDragSources(recents, topRows, selected)).toEqual([
      { kind: 'workspace', id: 'w-recent2' },
      { kind: 'workspace', id: 'w-inner' },
      { kind: 'folder', id: '子目录' },
      { kind: 'workspace', id: 'w-deep' },
      { kind: 'workspace', id: 'w-inner2' },
    ])
  })

  it('collapses a duplicate id (recency + tree) to the first occurrence', () => {
    const recents = [leaf('w-dup')]
    const topRows: FolderRowNode[] = [{ kind: 'workspace', leaf: leaf('w-dup') }, { kind: 'workspace', leaf: leaf('w-other') }]
    const selected = new Set([selectionKeyOf('workspace', 'w-dup'), selectionKeyOf('workspace', 'w-other')])
    expect(orderedDragSources(recents, topRows, selected)).toEqual([
      { kind: 'workspace', id: 'w-dup' },
      { kind: 'workspace', id: 'w-other' },
    ])
  })

  it('never descends into a collapsed folder (hidden children are not draggable)', () => {
    const collapsedChildren: FolderRowNode[] = [
      { kind: 'workspace', leaf: leaf('w-hidden') },
      { kind: 'folder', node: folderNode('隐藏目录', [{ kind: 'workspace', leaf: leaf('w-deep-hidden') }]) },
    ]
    const topRows: FolderRowNode[] = [{ kind: 'folder', node: folderNode('团队', collapsedChildren, false) }]
    const selected = new Set([selectionKeyOf('workspace', 'w-hidden'), selectionKeyOf('folder', '团队')])
    expect(orderedDragSources([], topRows, selected)).toEqual([{ kind: 'folder', id: '团队' }])
  })

  it('returns an empty group when nothing is selected', () => {
    const topRows: FolderRowNode[] = [{ kind: 'workspace', leaf: leaf('w-tree') }]
    expect(orderedDragSources([], topRows, new Set())).toEqual([])
  })
})

describe('resolveGroupDrop', () => {
  it('moves a workspace group into a folder "on" in display order (appended)', () => {
    let tree = rootTree(['w1', 'w2', 'w3'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, '团队', F('团队'), NOW).folders
    const target: DropTarget = { kind: 'folder', id: '团队', zone: 'on' }
    expect(resolveGroupDrop(tree, [{ kind: 'workspace', id: 'w2' }, { kind: 'workspace', id: 'w1' }], target)).toEqual([
      { source: { kind: 'workspace', id: 'w2' }, resolution: { kind: 'move-workspace', folderId: F('团队') } },
      { source: { kind: 'workspace', id: 'w1' }, resolution: { kind: 'move-workspace', folderId: F('团队') } },
    ])
  })

  it('keeps display order when a group anchors before a row (insert-before composition)', () => {
    let tree = rootTree(['w-anchor', 'w3', 'w2', 'w1'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, '甲', F('甲'), NOW).folders
    tree = moveWorkspaceIn(tree, W('w1'), F('甲'), undefined, NOW)
    tree = moveWorkspaceIn(tree, W('w2'), F('甲'), undefined, NOW)
    tree = moveWorkspaceIn(tree, W('w3'), F('甲'), undefined, NOW)
    // Group [w2, w1] anchored before the root-level row w-anchor: both leave
    // 甲 and land before w-anchor, w2 first (display order preserved).
    const target: DropTarget = { kind: 'workspace', id: 'w-anchor', zone: 'before' }
    const resolutions = resolveGroupDrop(tree, [{ kind: 'workspace', id: 'w2' }, { kind: 'workspace', id: 'w1' }], target)
    expect(resolutions.map(entry => entry.resolution)).toEqual([
      { kind: 'move-workspace', folderId: ROOT_FOLDER_ID, beforeChild: workspaceChild(W('w-anchor')) },
      { kind: 'move-workspace', folderId: ROOT_FOLDER_ID, beforeChild: workspaceChild(W('w-anchor')) },
    ])
    // Applying them sequentially in source order yields [w2, w1, w-anchor].
    let applied = tree
    for (const entry of resolutions) {
      if (entry.resolution.kind === 'move-workspace') {
        applied = moveWorkspaceIn(applied, entry.source.id as WorkspaceId, entry.resolution.folderId, entry.resolution.beforeChild, NOW)
      }
    }
    expect(applied[ROOT_FOLDER_ID]!.children.slice(0, 3).map(child => child.id)).toEqual(['w2', 'w1', 'w-anchor'])
  })

  it('pre-skips a folder dropped "on" itself or its own descendant; the rest of the group still moves', () => {
    let tree = rootTree(['w-art'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'alpha', F('alpha'), NOW).folders
    tree = createFolderIn(tree, F('alpha'), 'beta', F('beta'), NOW).folders
    // Group [alpha(folder), w-art] dropped "on" beta (beta ⊂ alpha).
    const target: DropTarget = { kind: 'folder', id: 'beta', zone: 'on' }
    const resolutions = resolveGroupDrop(tree, [
      { kind: 'folder', id: 'alpha' },
      { kind: 'workspace', id: 'w-art' },
    ], target)
    expect(resolutions).toEqual([
      { source: { kind: 'folder', id: 'alpha' }, resolution: { kind: 'noop' } },
      { source: { kind: 'workspace', id: 'w-art' }, resolution: { kind: 'move-workspace', folderId: F('beta') } },
    ])
    // Dropping the group onto alpha itself: alpha no-ops, w-art moves in.
    const selfTarget: DropTarget = { kind: 'folder', id: 'alpha', zone: 'on' }
    expect(resolveGroupDrop(tree, [
      { kind: 'folder', id: 'alpha' },
      { kind: 'workspace', id: 'w-art' },
    ], selfTarget).map(entry => entry.resolution)).toEqual([
      { kind: 'noop' },
      { kind: 'move-workspace', folderId: F('alpha') },
    ])
  })

  it('pre-skips a folder dragged "on" a folder already at max depth', () => {
    let tree = rootTree()
    // Build a chain: root → d1 → … → d5 (root = depth 1, so d5 sits at the
    // MAX_FOLDER_DEPTH frontier: nothing may be parented UNDER it).
    let parent: FolderId = ROOT_FOLDER_ID
    for (let i = 1; i <= 5; i++) {
      const id = F(`d${i}`)
      tree = createFolderIn(tree, parent, `d${i}`, id, NOW).folders
      parent = id
    }
    // Folder c at the root, dropped "on" d5: the depth guard would reject,
    // so the group resolver pre-skips to a clean no-op.
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'c', F('c'), NOW).folders
    const target: DropTarget = { kind: 'folder', id: 'd5', zone: 'on' }
    expect(resolveGroupDrop(tree, [{ kind: 'folder', id: 'c' }], target)).toEqual([
      { source: { kind: 'folder', id: 'c' }, resolution: { kind: 'noop' } },
    ])
  })

  it("treats a member dropped onto its own row as a no-op without blocking the group", () => {
    const tree = rootTree(['w1', 'w2', 'w3'])
    const target: DropTarget = { kind: 'workspace', id: 'w1', zone: 'after' }
    const resolutions = resolveGroupDrop(tree, [
      { kind: 'workspace', id: 'w1' },
      { kind: 'workspace', id: 'w3' },
    ], target)
    expect(resolutions.map(entry => entry.resolution)).toEqual([
      { kind: 'noop' },
      { kind: 'move-workspace', folderId: ROOT_FOLDER_ID, beforeChild: workspaceChild(W('w2')) },
    ])
  })

  it('resolves a single-member group exactly like a single drag', () => {
    let tree = rootTree(['w1'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, '团队', F('团队'), NOW).folders
    const single: DropTarget = { kind: 'folder', id: '团队', zone: 'on' }
    const group = resolveGroupDrop(tree, [{ kind: 'workspace', id: 'w1' }], single)
    expect(group).toEqual([
      { source: { kind: 'workspace', id: 'w1' }, resolution: resolveWorkspaceDrop(tree, W('w1'), 'folder', '团队', 'on') },
    ])
  })
})

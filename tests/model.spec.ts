import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  SessionPendingInteraction,
  SessionPendingInteractionBase,
  SessionPendingInteractionSnapshot,
} from '@deepseek-ai/dsh-client-ui-session/client'
import {
  FolderCycleError,
  FolderDepthExceededError,
  FolderId,
  FolderNameConflictError,
  FolderNotFoundError,
  FolderRootProtectedError,
  MAX_FOLDER_DEPTH,
  ROOT_FOLDER_ID,
  WorkspaceAnchorMissingError,
  WorkspaceNotInTreeError,
  adoptWorkspaceIn,
  createFolderIn,
  isPersistedViewState,
  deleteFolderIn,
  depthOf,
  deriveFlat,
  deriveFolderForest,
  deriveRecentWorkspaces,
  dirActive,
  filterFlatByQuery,
  filterForestByQuery,
  folderOfWorkspace,
  moveFolderIn,
  moveWorkspaceIn,
  observeSessionActivity,
  orderDeltas,
  pendingInteractionOf,
  recentFileList,
  recentFileTree,
  recentGroupKey,
  relativeTime,
  renameFolderIn,
  restoredState,
  retainLiveKeys,
  sessionPendingInteractionsOf,
  sessionStatusDot,
  treeOrder,
  UNGROUPED_KEY,
  workspaceSessionStatus,
  type FolderRecord,
  type FolderTree,
  type ForestResult,
  type ForestView,
  type LiveKeysSlice,
  type SubagentDescendantSummary,
} from '../src/client/model.ts'

const F = (id: string): FolderId => FolderId(id)
const W = (id: string): WorkspaceId => id as WorkspaceId
const S = (id: string): SessionId => id as SessionId

const NOW = '2026-09-04T00:00:00.000Z'

function folder(id: string, name: string, parent: FolderId | null, folderIds: string[] = [], workspaceIds: string[] = []): FolderRecord {
  return {
    folderId: F(id),
    name,
    parentFolderId: parent,
    workspaceIds: workspaceIds.map(W),
    folderIds: folderIds.map(F),
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function rootTree(workspaceIds: string[] = []): FolderTree {
  return { [ROOT_FOLDER_ID]: folder('root', 'Root', null, [], workspaceIds) }
}

describe('folder tree depth and lookup', () => {
  it('counts depth with root = 1', () => {
    const tree = rootTree()
    expect(depthOf(tree, ROOT_FOLDER_ID)).toBe(1)
    const withChild = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    expect(depthOf(withChild, F('a'))).toBe(2)
    const withGrandchild = createFolderIn(withChild, F('a'), 'b', F('b'), NOW).folders
    expect(depthOf(withGrandchild, F('b'))).toBe(3)
  })

  it('throws on a missing folder', () => {
    const tree = rootTree()
    expect(() => depthOf(tree, F('nope'))).toThrow(FolderNotFoundError)
    expect(folderOfWorkspace(tree, W('w'))).toBeUndefined()
  })
})

describe('createFolderIn', () => {
  it('appends a new folder to the parent account and stamps both records', () => {
    const tree = rootTree()
    const next = createFolderIn(tree, ROOT_FOLDER_ID, '团队', F('a'), NOW)
    expect(next.folders[ROOT_FOLDER_ID]?.folderIds).toEqual([F('a')])
    expect(next.folders[F('a')]).toMatchObject({ name: '团队', parentFolderId: ROOT_FOLDER_ID, workspaceIds: [], folderIds: [] })
    expect(next.folders[F('a')]?.updatedAt).toBe(NOW)
  })

  it('rejects a missing parent and a sibling name conflict', () => {
    const tree = rootTree()
    expect(() => createFolderIn(tree, F('missing'), 'x', F('a'), NOW)).toThrow(FolderNotFoundError)
    const withA = createFolderIn(tree, ROOT_FOLDER_ID, 'same', F('a'), NOW).folders
    expect(() => createFolderIn(withA, ROOT_FOLDER_ID, 'same', F('b'), NOW)).toThrow(FolderNameConflictError)
    // Rejects also when only a deeper sibling shares the name? No — siblings only.
    const withAChild = createFolderIn(withA, ROOT_FOLDER_ID, 'top', F('c'), NOW).folders
    expect(() => createFolderIn(withAChild, F('a'), 'top', F('d'), NOW)).not.toThrow()
  })

  it('caps nesting at MAX_FOLDER_DEPTH levels including the root', () => {
    let tree = rootTree()
    let chain = ROOT_FOLDER_ID
    for (let level = 2; level <= MAX_FOLDER_DEPTH; level++) {
      const id = F(`lvl-${level}`)
      tree = createFolderIn(tree, chain, `lvl-${level}`, id, NOW).folders
      chain = id
    }
    // Depth MAX_FOLDER_DEPTH reached: one more level is rejected.
    expect(() => createFolderIn(tree, chain, 'too-deep', F('overflow'), NOW))
      .toThrow(FolderDepthExceededError)
    expect(() => createFolderIn(tree, ROOT_FOLDER_ID, 'sibling', F('x'), NOW)).not.toThrow()
  })
})

describe('renameFolderIn', () => {
  it('renames and enforces sibling uniqueness', () => {
    const tree = createFolderIn(rootTree(), ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    const next = renameFolderIn(tree, F('a'), 'A2', NOW)
    expect(next[F('a')]?.name).toBe('A2')
    expect(() => renameFolderIn(tree, F('a'), 'a', NOW)).not.toThrow()
  })

  it('protects the root and rejects unknown folders', () => {
    expect(() => renameFolderIn(rootTree(), ROOT_FOLDER_ID, 'x', NOW)).toThrow(FolderRootProtectedError)
    expect(() => renameFolderIn(rootTree(), F('nope'), 'x', NOW)).toThrow(FolderNotFoundError)
  })
})

describe('deleteFolderIn (promotion)', () => {
  function populated(): FolderTree {
    // root children: folder 'a' (holds b + w1) … root workspaces w0
    let tree = rootTree(['w0'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    tree = createFolderIn(tree, F('a'), 'b', F('b'), NOW).folders
    tree = moveWorkspaceIn(tree, W('w0'), F('a'), undefined, NOW) // w0 into a (end)
    tree = moveWorkspaceIn(tree, W('w0'), ROOT_FOLDER_ID, undefined, NOW) // w0 back to root (end)
    return tree
  }

  it('promotes subfolders first, then workspaces, at the deleted slot in both accounts', () => {
    // Build: root folderIds = [] then [a]; its workspaces move into `a`, so
    // the account ends with folderIds = [a], workspaceIds = [].
    let tree = rootTree(['w1', 'w2'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    tree = createFolderIn(tree, F('a'), 'b', F('b'), NOW).folders
    tree = moveWorkspaceIn(tree, W('w1'), F('a'), undefined, NOW)
    tree = moveWorkspaceIn(tree, W('w2'), F('a'), undefined, NOW)
    const rootBefore = tree[ROOT_FOLDER_ID]!
    expect(rootBefore.folderIds).toEqual([F('a')])
    expect(rootBefore.workspaceIds).toEqual([])

    const next = deleteFolderIn(tree, F('a'), NOW)
    const root = next[ROOT_FOLDER_ID]!
    // Subfolders first, then workspaces, in relative order — all at slot 0.
    expect(root.folderIds).toEqual([F('b')])
    expect(root.workspaceIds).toEqual([W('w1'), W('w2')])
    expect(next[F('a')]).toBeUndefined()
    // Promoted child re-parented to the root.
    expect(next[F('b')]?.parentFolderId).toBe(ROOT_FOLDER_ID)
  })

  it('inserts promoted items at the deleted folder slot among existing siblings', () => {
    let tree = rootTree(['w0', 'w1'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'x', F('x'), NOW).folders
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'y', F('y'), NOW).folders
    tree = createFolderIn(tree, F('a'), 'b', F('b'), NOW).folders
    tree = moveWorkspaceIn(tree, W('w1'), F('a'), undefined, NOW)
    // root folderIds: [x, a, y]; delete `a` at index 1.
    const next = deleteFolderIn(tree, F('a'), NOW)
    expect(next[ROOT_FOLDER_ID]?.folderIds).toEqual([F('x'), F('b'), F('y')])
    // workspaceIds at the same index: [w0, w1] (w1 promoted at index 1).
    expect(next[ROOT_FOLDER_ID]?.workspaceIds).toEqual([W('w0'), W('w1')])
  })

  it('protects the root and rejects unknown folders', () => {
    expect(() => deleteFolderIn(rootTree(), ROOT_FOLDER_ID, NOW)).toThrow(FolderRootProtectedError)
    expect(() => deleteFolderIn(rootTree(), F('nope'), NOW)).toThrow(FolderNotFoundError)
  })
})

describe('moveFolderIn', () => {
  function tree(): FolderTree {
    let t = rootTree()
    for (const id of ['a', 'b', 'c']) t = createFolderIn(t, ROOT_FOLDER_ID, id, F(id), NOW).folders
    t = createFolderIn(t, F('a'), 'deep', F('deep'), NOW).folders
    return t
  }

  it('reorders within the same parent (anchor / end / no-op)', () => {
    // [a, b, c] → move a before c → [b, a, c].
    const move = moveFolderIn(tree(), F('a'), F('c'), undefined, NOW)
    expect(move[ROOT_FOLDER_ID]?.folderIds).toEqual([F('b'), F('a'), F('c')])
    // Then a to the end: [b, c, a].
    const toEnd = moveFolderIn(move, F('a'), undefined, undefined, NOW)
    expect(toEnd[ROOT_FOLDER_ID]?.folderIds).toEqual([F('b'), F('c'), F('a')])
    expect(moveFolderIn(tree(), F('a'), F('b'), undefined, NOW)[ROOT_FOLDER_ID]?.folderIds)
      .toEqual([F('a'), F('b'), F('c')])
  })

  it('moves across parents (re-parent + position) and updates parentFolderId', () => {
    const moved = moveFolderIn(tree(), F('b'), undefined, F('a'), NOW)
    expect(moved[F('a')]?.folderIds).toEqual([F('deep'), F('b')])
    expect(moved[F('b')]?.parentFolderId).toBe(F('a'))
    expect(moved[ROOT_FOLDER_ID]?.folderIds).toEqual([F('a'), F('c')])
    // Anchored insert into the target.
    const anchored = moveFolderIn(tree(), F('b'), F('deep'), F('a'), NOW)
    expect(anchored[F('a')]?.folderIds).toEqual([F('b'), F('deep')])
  })

  it('rejects a cycle (self or descendant target), depth overflow, and root moves', () => {
    const t = tree()
    expect(() => moveFolderIn(t, F('a'), undefined, F('a'), NOW)).toThrow(FolderCycleError)
    expect(() => moveFolderIn(t, F('a'), undefined, F('deep'), NOW)).toThrow(FolderCycleError)
    // Deep-chain `a → chain-3 → … → chain-6` down to the cap on one branch;
    // moving the sibling branch `b` under the deepest chain node is no cycle
    // (the target's parent chain never reaches `b`) but overflows the cap.
    let t2 = t
    let chain = F('a')
    for (let level = 3; level <= MAX_FOLDER_DEPTH; level++) {
      const id = F(`chain-${level}`)
      t2 = createFolderIn(t2, chain, `chain-${level}`, id, NOW).folders
      chain = id
    }
    expect(() => moveFolderIn(t2, F('b'), undefined, chain, NOW)).toThrow(FolderDepthExceededError)
    expect(() => moveFolderIn(t, ROOT_FOLDER_ID, undefined, F('a'), NOW)).toThrow(FolderRootProtectedError)
  })

  it('rejects unknown folders and anchors not in the target', () => {
    const t = tree()
    expect(() => moveFolderIn(t, F('nope'), undefined, ROOT_FOLDER_ID, NOW)).toThrow(FolderNotFoundError)
    expect(() => moveFolderIn(t, F('a'), F('c'), F('a'), NOW)).toThrow(FolderNotFoundError)
  })
})

describe('moveWorkspaceIn', () => {
  it('reorders within one folder and moves across folders at the anchor', () => {
    let t = rootTree(['w1', 'w2', 'w3'])
    const within = moveWorkspaceIn(t, W('w3'), ROOT_FOLDER_ID, W('w1'), NOW)
    expect(within[ROOT_FOLDER_ID]?.workspaceIds).toEqual([W('w3'), W('w1'), W('w2')])
    t = createFolderIn(t, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    const moved = moveWorkspaceIn(t, W('w2'), F('a'), undefined, NOW)
    expect(moved[F('a')]?.workspaceIds).toEqual([W('w2')])
    expect(moved[ROOT_FOLDER_ID]?.workspaceIds).toEqual([W('w1'), W('w3')])
  })

  it('rejects unknown targets and workspaces outside the tree', () => {
    const t = rootTree(['w1'])
    expect(() => moveWorkspaceIn(t, W('w1'), F('nope'), undefined, NOW)).toThrow(FolderNotFoundError)
    expect(() => moveWorkspaceIn(t, W('nope'), ROOT_FOLDER_ID, undefined, NOW)).toThrow(WorkspaceNotInTreeError)
    expect(() => moveWorkspaceIn(t, W('w1'), ROOT_FOLDER_ID, W('nope'), NOW)).toThrow(WorkspaceAnchorMissingError)
  })
})

describe('adoptWorkspaceIn', () => {
  it('prepends to the root account and is idempotent', () => {
    const adopted = adoptWorkspaceIn(rootTree([]), W('w1'), NOW)
    expect(adopted[ROOT_FOLDER_ID]?.workspaceIds).toEqual([W('w1')])
    expect(adoptWorkspaceIn(adopted, W('w1'), NOW)).toBe(adopted)
  })
})

describe('retainLiveKeys', () => {
  const slice = (): LiveKeysSlice => ({
    folders: (() => {
      let t = rootTree(['w1'])
      t = createFolderIn(t, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
      return moveWorkspaceIn(t, W('w1'), F('a'), undefined, NOW)
    })(),
    folderExpansion: { a: true },
    recentTouchById: { w1: 1, dead: 2 },
    groupExpansion: { w1: true, dead: true },
    sessionOrderByAccount: { w1: ['s'], dead: ['x'] },
    sessionUpdatedAtByAccount: { w1: { s: 1 }, dead: { x: 2 } },
  })

  it('prunes dead workspace ids everywhere but keeps folders', () => {
    const retained = retainLiveKeys(slice(), [W('w1')])
    expect(retained.folders[F('a')]?.workspaceIds).toEqual([W('w1')])
    expect(retained.folders[ROOT_FOLDER_ID]?.folderIds).toEqual([F('a')])
    expect(retained.recentTouchById).toEqual({ w1: 1 })
    expect(retained.groupExpansion).toEqual({ w1: true })
    expect(retained.sessionOrderByAccount).toEqual({ w1: ['s'] })
    expect(retained.sessionUpdatedAtByAccount).toEqual({ w1: { s: 1 } })
    expect(retained.folderExpansion).toEqual({ a: true })
  })

  it('strips dead workspace memberships from folder accounts without deleting the folder', () => {
    const retained = retainLiveKeys(slice(), [])
    expect(retained.folders[F('a')]?.workspaceIds).toEqual([])
    expect(retained.folders[F('a')]).toBeDefined()
  })

  it('returns the same references when nothing is dead', () => {
    const state: LiveKeysSlice = {
      folders: rootTree(['w1']),
      folderExpansion: {},
      recentTouchById: { w1: 1 },
      groupExpansion: { w1: true },
      sessionOrderByAccount: { w1: ['s'] },
      sessionUpdatedAtByAccount: { w1: { s: 1 } },
    }
    expect(retainLiveKeys(state, [W('w1')])).toBe(state)
  })
})

describe('treeOrder', () => {
  it('walks depth-first: child subtrees before own workspaces, root first', () => {
    let t = rootTree(['w0', 'w1', 'w2'])
    t = createFolderIn(t, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    t = createFolderIn(t, F('a'), 'b', F('b'), NOW).folders
    t = moveWorkspaceIn(t, W('w1'), F('a'), undefined, NOW)
    t = moveWorkspaceIn(t, W('w2'), F('b'), undefined, NOW)
    expect(treeOrder(t)).toEqual([W('w2'), W('w1'), W('w0')])
  })
})

describe('orderDeltas', () => {
  const ids = (...xs: string[]): WorkspaceId[] => xs.map(W)

  it('emits nothing for an already-aligned order', () => {
    expect(orderDeltas(ids('a', 'b', 'c'), ids('a', 'b', 'c'))).toEqual([])
    expect(orderDeltas(ids('a', 'b', 'c'), ids('a', 'b', 'c'))).toHaveLength(0)
  })

  it('moves one item before its anchor', () => {
    // current a b c → desired b a c: the LIS keeps b, c stable (current
    // positions 1, 2), so the single minimal move pushes a before c — the
    // same final order as moving b before a, but the stable tail anchors at c.
    expect(orderDeltas(ids('a', 'b', 'c'), ids('b', 'a', 'c'))).toEqual([
      { workspaceId: W('a'), beforeWorkspaceId: W('c') },
    ])
  })

  it('moves one item to the end', () => {
    expect(orderDeltas(ids('a', 'b', 'c'), ids('b', 'c', 'a'))).toEqual([
      { workspaceId: W('a') },
    ])
  })

  it('keeps the longest stable run and moves only the rest, in application order', () => {
    // Stable run a, b, d (in order in current); only c moves — appended to the end.
    expect(orderDeltas(ids('a', 'b', 'c', 'd'), ids('a', 'b', 'd', 'c'))).toEqual([
      { workspaceId: W('c') },
    ])
  })

  it('reverses a full list with one end-append per moved item', () => {
    // Desired [c, b, a]: nothing is stable except c; appending b then a reaches it.
    expect(orderDeltas(ids('a', 'b', 'c'), ids('c', 'b', 'a'))).toEqual([
      { workspaceId: W('b') },
      { workspaceId: W('a') },
    ])
  })

  it('keeps repeated same-anchor inserts in desired order', () => {
    // current: a b c d e ; desired: c a b e d → stable a, b, e; c anchors at a, d appends.
    expect(orderDeltas(ids('a', 'b', 'c', 'd', 'e'), ids('c', 'a', 'b', 'e', 'd'))).toEqual([
      { workspaceId: W('d') },
      { workspaceId: W('c'), beforeWorkspaceId: W('a') },
    ])
  })
})

describe('observeSessionActivity', () => {
  const summary = (id: string, updatedAt: number): SessionSummary => ({
    id: S(id),
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt,
  })

  it('baseline-seeds first-seen sessions and reports no advances', () => {
    const first = observeSessionActivity({}, { [S('s1')]: summary('s1', 100) })
    expect(first.advanced).toEqual([])
    expect(first.seen).toEqual({ s1: 100 })
  })

  it('reports only sessions whose stamp advanced (a new query) and reseeds the table', () => {
    const first = observeSessionActivity({}, {
      [S('s1')]: summary('s1', 100),
      [S('s2')]: summary('s2', 200),
    })
    const second = observeSessionActivity(first.seen, {
      [S('s1')]: summary('s1', 100), // unchanged: no advance
      [S('s2')]: summary('s2', 350), // advanced: a new query landed
      [S('s3')]: summary('s3', 50), // newly seen: seeded, never reported
    })
    expect(second.advanced).toEqual([S('s2')])
    expect(second.seen).toEqual({ s1: 100, s2: 350, s3: 50 })
  })

  it('forgets sessions that vanished instead of reporting them', () => {
    const first = observeSessionActivity({}, { [S('s1')]: summary('s1', 100) })
    const second = observeSessionActivity(first.seen, {})
    expect(second.advanced).toEqual([])
    expect(second.seen).toEqual({})
  })

  it('never reports a stamp moving backwards', () => {
    const first = observeSessionActivity({}, { [S('s1')]: summary('s1', 100) })
    const second = observeSessionActivity(first.seen, { [S('s1')]: summary('s1', 50) })
    expect(second.advanced).toEqual([])
    expect(second.seen).toEqual({ s1: 50 })
  })
})

describe('sessionStatusDot / dirActive', () => {
  it('prioritizes pending interaction, live activity, then the completion reminder', () => {
    const node = (overrides: Partial<Parameters<typeof sessionStatusDot>[0]> = {}): Parameters<typeof sessionStatusDot>[0] => ({
      pendingInteraction: undefined,
      running: false,
      runningSubagentCount: 0,
      completed: false,
      blank: false,
      ...overrides,
    })
    expect(sessionStatusDot(node())).toBeUndefined() // idle: no dot
    expect(sessionStatusDot(node({ blank: true, completed: true }))).toBeUndefined()
    expect(sessionStatusDot(node({ pendingInteraction: 'approval' }))).toBe('warning')
    expect(sessionStatusDot(node({ pendingInteraction: 'escalation' }))).toBe('warning')
    // Pending interaction outranks running.
    expect(sessionStatusDot(node({ pendingInteraction: 'question', running: true }))).toBe('warning')
    expect(sessionStatusDot(node({ running: true }))).toBe('ongoing')
    expect(sessionStatusDot(node({ runningSubagentCount: 2 }))).toBe('ongoing')
    expect(sessionStatusDot(node({ completed: true }))).toBe('done')
  })

  it('marks every dir holding the current session, collapsed or expanded', () => {
    // The mark is the ancestor trail: it must survive collapse, so a hidden
    // session still leaves every father dir lit level by level.
    expect(dirActive(true)).toBe(true)
    expect(dirActive(false)).toBe(false)
  })

  it('aggregates a workspace group\'s status counts: waiting > working > completed; blanks never count', () => {
    // Same per-session outranking as the session rows' dots; the counts must
    // come from the member summaries so a COLLAPSED leaf (whose session rows
    // list is empty) still carries the marker.
    const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
      id: S(id),
      displayTitle: id,
      running: false,
      blank: false,
      updatedAt: 100,
      ...overrides,
    })
    // indexSubagentDescendants is private; feed the projected map the same
    // shape sessionNode consumes (running descendants per parent id).
    const descendants = new Map<SessionId, SubagentDescendantSummary>([
      [S('s2'), { count: 1, runningCount: 1 }],
    ])
    const pending = new Map<SessionId, { readonly kind: string }>([
      [S('s5'), { kind: 'approval' }],
    ])
    expect(workspaceSessionStatus([], descendants)).toEqual({})
    expect(workspaceSessionStatus([summary('u')], descendants, pending)).toEqual({}) // idle: no state
    expect(workspaceSessionStatus([
      summary('u'),
      summary('s1', { running: true }), // own activity → working
      summary('s2'), // subagent running under it → working
      summary('s3', { completed: true }), // completed → done
      summary('s4', { completed: true, running: true }), // activity outranks completion
      summary('s5'), // pending interaction → waiting (outranks idle)
      summary('s6', { blank: true, running: true }), // not a visible session
    ], descendants, pending)).toEqual({ warning: 1, ongoing: 3, done: 1 })
  })
})

describe('pendingInteractionOf / sessionPendingInteractionsOf', () => {
  it('maps the three framework kinds onto the row presentation union', () => {
    expect(pendingInteractionOf({ kind: 'approval' })).toBe('approval')
    expect(pendingInteractionOf({ kind: 'plan-review' })).toBe('plan-review')
    expect(pendingInteractionOf({ kind: 'question' })).toBe('question')
    expect(pendingInteractionOf(undefined)).toBeUndefined()
    expect(pendingInteractionOf({ kind: 'unknown-kind' })).toBeUndefined()
  })

  it('refines the sandbox-escalation approval into the dedicated annotation, keyed off the stable reason prefix', () => {
    // approveEscalation composes `escalate sandbox to <mode>: <justification>`.
    expect(pendingInteractionOf({ kind: 'approval', reason: 'escalate sandbox to workspace-write: fixture' })).toBe('escalation')
    expect(pendingInteractionOf({ kind: 'approval', reason: 'escalate sandbox to danger-full-access: fixture' })).toBe('escalation')
    // Any other reason — or none at all — stays a plain approval.
    expect(pendingInteractionOf({ kind: 'approval', reason: 'allow read of ~/.ssh/config' })).toBe('approval')
    expect(pendingInteractionOf({ kind: 'approval' })).toBe('approval')
  })

  it('reads the ui-session snapshot as the browser entry view (the roster seam types the escalation reason)', () => {
    // The plugin's local compile knows the approval roster member; base
    // entries stand in for the kinds other packages augment (question…).
    const snapshot = new Map<SessionId, SessionPendingInteractionBase | SessionPendingInteraction>([
      [S('s1'), { key: 'approval:1', kind: 'approval', sessionId: S('s1'), reason: 'escalate sandbox to workspace-write: fixture' }],
      [S('s2'), { key: 'approval:2', kind: 'approval', sessionId: S('s2') }],
      [S('s3'), { key: 'question:1', kind: 'question', sessionId: S('s3') }],
    ]) as SessionPendingInteractionSnapshot
    const viewed = sessionPendingInteractionsOf(snapshot)
    expect(pendingInteractionOf(viewed.get(S('s1')))).toBe('escalation')
    expect(pendingInteractionOf(viewed.get(S('s2')))).toBe('approval')
    expect(pendingInteractionOf(viewed.get(S('s3')))).toBe('question')
    expect(pendingInteractionOf(viewed.get(S('s4')))).toBeUndefined()
  })
})

describe('deriveRecentWorkspaces', () => {
  const workspace = (id: string, sessionIds: readonly string[], createdAt: string, title = id): WorkspaceView => ({
    workspaceId: W(id),
    path: `/projects/${id}`,
    title,
    sessionIds: sessionIds.map(S),
    createdAt,
    updatedAt: createdAt,
  })
  const rootTreeForRecents = (workspaceIds: readonly string[]): FolderTree => ({
    [ROOT_FOLDER_ID]: {
      folderId: ROOT_FOLDER_ID,
      name: 'Root',
      parentFolderId: null,
      workspaceIds: workspaceIds.map(W),
      folderIds: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  })
  const summary = (id: string, updatedAt: number): SessionSummary => ({
    id: S(id),
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt,
  })
  const sessionState = (items: readonly SessionSummary[]): SessionListState => ({
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })

  it('scores by max(touch, derived activity) and falls back to createdAt', () => {
    const workspaces = [
      workspace('old', ['s1'], '2026-01-01T00:00:00.000Z'),
      workspace('touched', [], '2026-01-01T00:00:00.000Z'),
      workspace('recent', [], '2026-09-01T00:00:00.000Z'),
    ]
    const sessions = sessionState([summary('s1', Date.parse('2026-08-01T00:00:00.000Z'))])
    const view: ForestView = { folderExpansion: {}, groupExpansion: {} }
    const rows = deriveRecentWorkspaces(workspaces, sessions, { touched: Date.parse('2026-09-02T00:00:00.000Z') }, 10, view)
    // touched (touch 09-02) > recent (created 09-01) > old (session 08-01)
    expect(rows.map(row => row.workspaceId)).toEqual([W('touched'), W('recent'), W('old')])
    expect(rows[0]?.updatedAt).toBe(Date.parse('2026-09-02T00:00:00.000Z'))
    expect(rows[1]?.updatedAt).toBe(Date.parse('2026-09-01T00:00:00.000Z'))
  })

  it('bounds by limit and tie-breaks on the id', () => {
    const workspaces = [workspace('z', [], '2026-09-01T00:00:00.000Z'), workspace('a', [], '2026-09-01T00:00:00.000Z')]
    const view: ForestView = { folderExpansion: {}, groupExpansion: {} }
    const rows = deriveRecentWorkspaces(workspaces, sessionState([]), {}, 1, view)
    expect(rows.map(row => row.workspaceId)).toEqual([W('a')])
  })

  it('carries an expandable workspace leaf: sessions, expansion, containsCurrent, and archived filtering', () => {
    const workspaces = [workspace('w', ['s1', 's2'], '2026-01-01T00:00:00.000Z')]
    const sessions = sessionState([
      summary('s1', Date.parse('2026-09-01T00:00:00.000Z')),
      summary('s2', Date.parse('2026-09-02T00:00:00.000Z')),
    ])
    sessions.current = S('s1')
    // The recency row's expansion lives under its own prefixed group key.
    const view: ForestView = { folderExpansion: {}, groupExpansion: { [recentGroupKey(W('w'))]: true } }
    const [row] = deriveRecentWorkspaces(workspaces, sessions, {}, 5, view)
    expect(row).toBeDefined()
    expect(row?.label).toBe('w')
    expect(row?.expanded).toBe(true)
    expect(row?.containsCurrent).toBe(true)
    expect(row?.sessionCount).toBe(2)
    // Default strategy 'updated': the expanded list is newest-first.
    expect(row?.sessions.map(session => session.id)).toEqual([S('s2'), S('s1')])
    // The row is a leaf: it can expand its session list like a tree workspace row.
    expect(row ? 'sessions' in row : false).toBe(true)

    // No open/close linkage: expanding the tree row does NOT expand the
    // recency row, and the recency row's key never leaks into the tree.
    expect(deriveRecentWorkspaces(workspaces, sessions, {}, 5, { folderExpansion: {}, groupExpansion: { w: true } })[0]?.expanded)
      .toBe(false)
    expect(deriveFolderForest(sessions, workspaces, rootTreeForRecents(['w']), [], { folderExpansion: {}, groupExpansion: { [recentGroupKey(W('w'))]: true } })
      .topLevel[0]?.expanded).toBe(false)

    const manual = deriveRecentWorkspaces(workspaces, sessions, {}, 5, { ...view, orderBy: 'manual' })
    expect(manual[0]?.sessions.map(session => session.id)).toEqual([S('s1'), S('s2')])

    const archived = deriveRecentWorkspaces(workspaces, sessions, {}, 5, view, [S('s2')])
    expect(archived[0]?.sessionCount).toBe(1)
    expect(archived[0]?.sessions.map(session => session.id)).toEqual([S('s1')])
  })
})

describe('deriveFolderForest', () => {
  const workspace = (id: string, sessionIds: readonly string[], title = id): WorkspaceView => ({
    workspaceId: W(id),
    path: `/projects/${id}`,
    title,
    sessionIds: sessionIds.map(S),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const summary = (id: string, updatedAt = 100, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
    id: S(id),
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt,
    ...overrides,
  })
  const sessionState = (items: readonly SessionSummary[], current?: SessionId): SessionListState => ({
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })

  it('assembles the forest from the root and skips unreachable folders', () => {
    let tree = rootTree(['w0', 'w1'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    tree = moveWorkspaceIn(tree, W('w1'), F('a'), undefined, NOW)
    tree = createFolderIn(tree, F('a'), 'b', F('b'), NOW).folders
    // An orphan folder that nothing references (not reachable from root).
    const orphaned = { ...tree, [F('orphan')]: folder('orphan', 'orphan', F('missing'), [], []) }
    const result = deriveFolderForest(
      sessionState([summary('s0')]),
      [workspace('w0', ['s0']), workspace('w1', [])],
      orphaned,
      [],
      { folderExpansion: {}, groupExpansion: {} },
    )
    expect(result.folders).toHaveLength(1)
    const a = result.folders[0]
    expect(a?.name).toBe('a')
    expect(a?.depth).toBe(1)
    expect(a?.children.map(child => child.folderId)).toEqual([F('b')])
    expect(a?.workspaceGroups.map(leaf => leaf.workspaceId)).toEqual([W('w1')])
    // Root-owned workspaces surface as top-level leaves.
    expect(result.topLevel.map(leaf => leaf.workspaceId)).toEqual([W('w0')])
    expect(result.ungrouped).toBeUndefined()
  })

  it('gates sessions by expansion, marks containsCurrent, and buckets stray sessions', () => {
    let tree = rootTree(['w0'])
    tree = createFolderIn(tree, ROOT_FOLDER_ID, 'a', F('a'), NOW).folders
    const result = deriveFolderForest(
      sessionState([summary('s0'), summary('stray')], S('s0')),
      [workspace('w0', ['s0'])],
      tree,
      [],
      // The ungrouped bucket is a group like any other: expand it to read rows.
      { folderExpansion: { [F('a')]: true }, groupExpansion: { w0: true, [UNGROUPED_KEY]: true } },
    )
    const w0 = result.topLevel[0]
    expect(w0?.sessions.map(session => session.id)).toEqual([S('s0')])
    expect(w0?.containsCurrent).toBe(true)
    expect(result.ungrouped?.key).toBe(UNGROUPED_KEY)
    expect(result.ungrouped?.sessions.map(session => session.id)).toEqual([S('stray')])
  })

  it('orders sessions per the strategy: updated (default) sorts by activity, manual keeps the account order', () => {
    const base = (orderBy?: ForestView['orderBy'], sessionOrderBy?: Record<string, string[]>): ForestView => ({
      folderExpansion: {},
      groupExpansion: { w0: true },
      ...(orderBy === undefined ? {} : { orderBy }),
      ...(sessionOrderBy === undefined ? {} : { sessionOrderBy }),
    })
    // Account order lists the newest session LAST — 'updated' must re-sort it.
    const sessions = sessionState([summary('old', 100), summary('new', 300)])
    const leaf = (view: ForestView): readonly string[] =>
      deriveFolderForest(sessions, [workspace('w0', ['old', 'new'])], rootTree(['w0']), [], view)
        .topLevel[0]!.sessions.map(session => session.id)

    expect(leaf(base('updated'))).toEqual([S('new'), S('old')])
    expect(leaf(base(undefined))).toEqual([S('new'), S('old')])
    expect(leaf(base('manual'))).toEqual([S('old'), S('new')])
    // Manual + stored order: stored first, unknown/new ids trail in account order.
    expect(leaf(base('manual', { w0: ['new'] }))).toEqual([S('new'), S('old')])
  })

  it('excludes archived and subagent sessions from every surface', () => {
    const result = deriveFolderForest(
      sessionState([summary('arch'), summary('child', 100, { origin: 'subagent' }), summary('ok')]),
      [workspace('w0', ['arch', 'child', 'ok'])],
      rootTree(['w0']),
      [S('arch')],
      { folderExpansion: {}, groupExpansion: { w0: true } },
    )
    const w0 = result.topLevel[0]
    expect(w0?.sessionCount).toBe(1)
    expect(w0?.sessions.map(session => session.id)).toEqual([S('ok')])
  })
})

describe('deriveFlat', () => {
  it('renders every visible session newest-first', () => {
    const sessions: SessionListState = {
      ids: [S('a'), S('b')],
      byId: {
        [S('a')]: { id: S('a'), displayTitle: 'a', running: false, blank: false, updatedAt: 1 },
        [S('b')]: { id: S('b'), displayTitle: 'b', running: false, blank: false, updatedAt: 2 },
      },
      current: undefined,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    }
    const rows = deriveFlat(sessions, [])
    expect(rows.map(row => row.id)).toEqual([S('b'), S('a')])
  })

  it('marks the viewer-open session row as current', () => {
    const sessions: SessionListState = {
      ids: [S('a'), S('b')],
      byId: {
        [S('a')]: { id: S('a'), displayTitle: 'a', running: false, blank: false, updatedAt: 1 },
        [S('b')]: { id: S('b'), displayTitle: 'b', running: false, blank: false, updatedAt: 2 },
      },
      current: S('a'),
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    }
    const rows = deriveFlat(sessions, [])
    expect(rows.find(row => row.id === S('a'))?.current, 'the open session row is current').toBe(true)
    expect(rows.find(row => row.id === S('b'))?.current, 'every other row is not').toBe(false)
  })
})

describe('filterForestByQuery (in-place dirs-list filter)', () => {
  /** One fixture summary; `cwd` optional (exactOptionalPropertyTypes). */
  function summary(id: string, displayTitle: string, updatedAt: number, extra: Partial<SessionSummary> = {}): SessionSummary {
    return {
      id: S(id),
      displayTitle,
      blank: false,
      running: false,
      completed: true,
      updatedAt,
      ...extra,
    }
  }

  const sessions: SessionListState = {
    ids: [S('s1'), S('s2'), S('s3'), S('s4'), S('sub'), S('blank'), S('u1')],
    byId: {
      [S('s1')]: summary('s1', '画布草图', 900),
      [S('s2')]: summary('s2', '配色研究', 800),
      [S('s3')]: summary('s3', '构图笔记', 700),
      [S('s4')]: summary('s4', 'README 整理', 600),
      [S('sub')]: summary('sub', '子代理汇报', 500, { origin: 'subagent', parentId: S('s1') }),
      [S('blank')]: summary('blank', '', 400, { blank: true }),
      [S('u1')]: summary('u1', '未分组草稿', 300),
    },
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
  const workspaces: WorkspaceView[] = [
    { workspaceId: W('w-art'), path: '/projects/w-art', title: '绘画收集', sessionIds: [S('s1'), S('s2'), S('s3'), S('sub')], createdAt: NOW, updatedAt: NOW },
    { workspaceId: W('w-docs'), path: '/projects/w-docs', title: '文档', sessionIds: [S('s4')], createdAt: NOW, updatedAt: NOW },
  ]
  /** The derived forest: 产品组 holds w-art (s1..s3), w-docs sits at the root, u1 is ungrouped. */
  function forest(): ForestResult {
    const team = createFolderIn(rootTree(['w-art', 'w-docs']), ROOT_FOLDER_ID, '产品组', F('team'), NOW)
    const moved = moveWorkspaceIn(team.folders, W('w-art'), F('team'), undefined, NOW)
    return deriveFolderForest(sessions, workspaces, moved, [], {
      folderExpansion: {},
      groupExpansion: {},
      orderBy: 'updated',
    })
  }

  it('dir-level match: a workspace title keeps that leaf, everything else hides', () => {
    const filtered = filterForestByQuery(forest(), sessions, workspaces, '文档', [])
    expect(filtered.folders).toEqual([])
    expect(filtered.topLevel.map(leaf => leaf.workspaceId)).toEqual([W('w-docs')])
    expect(filtered.ungrouped).toBeUndefined()
  })

  it('dir-level match: the cwd basename keeps a renamed workspace leaf', () => {
    const filtered = filterForestByQuery(forest(), sessions, workspaces, 'w-docs', [])
    expect(filtered.topLevel.map(leaf => leaf.workspaceId)).toEqual([W('w-docs')])
  })

  it('session-level match keeps the owning dir, and the folder path opens to reveal it', () => {
    const filtered = filterForestByQuery(forest(), sessions, workspaces, '构图', [])
    expect(filtered.topLevel).toEqual([])
    expect(filtered.ungrouped).toBeUndefined()
    expect(filtered.folders).toHaveLength(1)
    const folder = filtered.folders[0]!
    expect(folder.name).toBe('产品组')
    expect(folder.workspaceGroups.map(leaf => leaf.workspaceId)).toEqual([W('w-art')])
    expect(folder.expanded, 'a folder holding a descendant match opens').toBe(true)
  })

  it('a folder name match alone keeps the folder without opening it', () => {
    const filtered = filterForestByQuery(forest(), sessions, workspaces, '产品组', [])
    expect(filtered.folders).toHaveLength(1)
    const folder = filtered.folders[0]!
    expect(folder.name).toBe('产品组')
    expect(folder.expanded, 'name-only matches keep the folder‘s own expansion').toBe(false)
    expect(folder.workspaceGroups, 'non-matching workspaces hide inside a name-matched folder').toEqual([])
  })

  it('the ungrouped bucket stays when its label or a stray session title matches', () => {
    expect(filterForestByQuery(forest(), sessions, workspaces, 'ungrouped', []).ungrouped?.workspaceId).toBeUndefined()
    expect(filterForestByQuery(forest(), sessions, workspaces, '未分组草稿', []).ungrouped?.key).toBe(UNGROUPED_KEY)
  })

  it('blank / subagent-origin sessions never match, and a blank query passes the forest through unchanged', () => {
    const f = forest()
    expect(filterForestByQuery(f, sessions, workspaces, '子代理汇报', []).topLevel).toEqual([])
    expect(filterForestByQuery(f, sessions, workspaces, '子代理汇报', []).folders).toEqual([])
    expect(filterForestByQuery(f, sessions, workspaces, '   ', []), 'a blank query returns the forest untouched').toBe(f)
    // Archived sessions never match: the only hit (s1) is hidden, so the
    // whole subtree filters out along with the leaf.
    const archived = filterForestByQuery(f, sessions, workspaces, '画布草图', [S('s1')])
    expect(archived.topLevel).toEqual([])
    expect(archived.folders).toEqual([])
  })
})

describe('filterFlatByQuery', () => {
  it('keeps title matches case-insensitively and never matches blank placeholders', () => {
    const sessions: SessionListState = {
      ids: [S('a'), S('b')],
      byId: {
        [S('a')]: { id: S('a'), displayTitle: 'Alpha notes', running: false, blank: false, updatedAt: 1 },
        [S('b')]: { id: S('b'), displayTitle: 'Beta', running: false, blank: false, updatedAt: 2 },
      },
      current: undefined,
      phase: 'ready',
      subagentsByParent: {},
      jobsBySession: {},
      currentAddress: undefined,
    }
    const flat = deriveFlat(sessions, [])
    expect(filterFlatByQuery(flat, 'alpha').map(row => row.id)).toEqual([S('a')])
    expect(filterFlatByQuery(flat, '')).toBe(flat)

    // A blank (current) placeholder never matches, even on the canonical title.
    const withBlank: SessionListState = {
      ...sessions,
      ids: [S('a'), S('blank')],
      byId: {
        ...sessions.byId,
        [S('blank')]: { id: S('blank'), displayTitle: 'New Session', running: false, blank: true, updatedAt: 5 },
      },
      current: S('blank'),
    }
    const flatWithBlank = deriveFlat(withBlank, [])
    expect(flatWithBlank.map(row => row.id)).toContain(S('blank'))
    expect(filterFlatByQuery(flatWithBlank, 'new').map(row => row.id)).not.toContain(S('blank'))
  })
})

describe('relativeTime', () => {
  const now = Date.parse('2026-09-04T00:00:00.000Z')
  it('buckets by elapsed time', () => {
    expect(relativeTime(now - 30_000, now)).toEqual({ unit: 'now', n: 0 })
    expect(relativeTime(now - 5 * 60_000, now)).toEqual({ unit: 'minutes', n: 5 })
    expect(relativeTime(now - 3 * 3_600_000, now)).toEqual({ unit: 'hours', n: 3 })
    expect(relativeTime(now - 2 * 86_400_000, now)).toEqual({ unit: 'days', n: 2 })
    expect(relativeTime(now - 4 * 30 * 86_400_000, now)).toEqual({ unit: 'months', n: 4 })
    expect(relativeTime(now - 365 * 86_400_000, now)).toEqual({ unit: 'years', n: 1 })
  })
})

describe('isPersistedViewState', () => {
  /** An envelope whose tree is built through the model functions themselves. */
  function envelope(): Record<string, unknown> {
    let folders: FolderTree = {
      root: {
        folderId: 'root' as FolderId, name: 'Root', parentFolderId: null,
        workspaceIds: [], folderIds: [], createdAt: '0', updatedAt: '0',
      },
    }
    folders = adoptWorkspaceIn(folders, W('w1'), NOW)
    folders = createFolderIn(folders, ROOT_FOLDER_ID, '团队', F('f1'), NOW).folders
    folders = createFolderIn(folders, F('f1'), '产品', F('f2'), NOW).folders
    folders = moveWorkspaceIn(folders, W('w1'), F('f2'), undefined, NOW)
    return {
      folders,
      folderExpansion: { f1: true },
      recentTouchById: { w1: 1788514153563 },
      groupBy: 'workspace',
      orderBy: 'manual',
      groupExpansion: { w1: true, 'recent:w1': true },
      sessionOrderByAccount: { w1: ['s1'] },
      sessionUpdatedAtByAccount: { w1: { s1: 1 } },
    }
  }

  it('accepts a model-built envelope', () => {
    expect(isPersistedViewState(envelope())).toBe(true)
  })

  it('rejects a missing root and a root with a parent', () => {
    const orphan = envelope()
    delete (orphan.folders as FolderTree).root
    expect(isPersistedViewState(orphan)).toBe(false)
    const parented = envelope()
    ;(parented.folders as FolderTree).root = {
      folderId: 'root' as FolderId, name: 'Root', parentFolderId: F('f1'),
      workspaceIds: [], folderIds: [], createdAt: '0', updatedAt: '0',
    }
    expect(isPersistedViewState(parented)).toBe(false)
  })

  it('rejects a cycle that the bidirectional account checks pass', () => {
    const cycle = envelope()
    const folders = cycle.folders as FolderTree
    folders.root = {
      folderId: 'root' as FolderId, name: 'Root', parentFolderId: null,
      workspaceIds: [W('w1')], folderIds: [], createdAt: '0', updatedAt: '0',
    }
    const f1 = folders[F('f1')]!
    const f2 = folders[F('f2')]!
    // f1 ↔ f2 mutual parenting: both account checks agree, only the
    // parent-chain walk can reject the loop.
    folders[F('f1')] = { ...f1, parentFolderId: F('f2') }
    folders[F('f2')] = { ...f2, parentFolderId: F('f1'), folderIds: [F('f1')] }
    expect(isPersistedViewState(cycle)).toBe(false)
  })

  it('rejects nesting deeper than MAX_FOLDER_DEPTH (a bidirectionally sound chain lets the walk reject)', () => {
    // Root + `count` folders, every parent listing its child: only the
    // parent-chain walk can reject a chain past the cap.
    const chain = (count: number): Record<string, unknown> => {
      const next = envelope()
      const folders = next.folders as FolderTree
      // The fixture tree's f1/f2 do not exist in the chain: drop them so
      // the bidirectional account checks pass and the walk decides.
      delete folders[F('f1')]
      delete folders[F('f2')]
      folders.root = {
        folderId: 'root' as FolderId, name: 'Root', parentFolderId: null,
        workspaceIds: [], folderIds: [F('d1')], createdAt: '0', updatedAt: '0',
      }
      for (let level = 1; level <= count; level++) {
        const id = F(`d${level}`)
        folders[id] = {
          folderId: id, name: `lvl-${level}`,
          parentFolderId: level === 1 ? ROOT_FOLDER_ID : F(`d${level - 1}`),
          workspaceIds: [], folderIds: level === count ? [] : [F(`d${level + 1}`)],
          createdAt: '0', updatedAt: '0',
        }
      }
      return next
    }
    // Root + 5 folders = depth 6 (the cap, root included): accepted.
    expect(isPersistedViewState(chain(MAX_FOLDER_DEPTH - 1))).toBe(true)
    // One folder deeper than the cap: rejected.
    expect(isPersistedViewState(chain(MAX_FOLDER_DEPTH))).toBe(false)
  })

  it('rejects mistyped maps and enums', () => {
    expect(isPersistedViewState({ ...envelope(), groupBy: 'tree' })).toBe(false)
    expect(isPersistedViewState({ ...envelope(), orderBy: 'abc' })).toBe(false)
    expect(isPersistedViewState({ ...envelope(), recentTouchById: { w1: 'yesterday' } })).toBe(false)
    expect(isPersistedViewState({ ...envelope(), folderExpansion: { f1: 1 } })).toBe(false)
    expect(isPersistedViewState({ ...envelope(), sessionOrderByAccount: { w1: 42 } })).toBe(false)
    expect(isPersistedViewState({ ...envelope(), sessionUpdatedAtByAccount: { w1: { s1: 'x' } } })).toBe(false)
  })

  it('tolerates expansion keys of unknown folders (client-side guard is structural, not strict)', () => {
    const loose = envelope()
    ;(loose.folderExpansion as Record<string, boolean>).ghost = true
    expect(isPersistedViewState(loose)).toBe(true)
  })
})

describe('restoredState', () => {
  /** Envelope with f1 → f2 (w1 inside f2), dead workspace w2 at root, w3 everywhere. */
  function envelope(): Record<string, unknown> {
    let folders: FolderTree = {
      root: {
        folderId: 'root' as FolderId, name: 'Root', parentFolderId: null,
        workspaceIds: [W('w2')], folderIds: [], createdAt: '0', updatedAt: '0',
      },
    }
    folders = adoptWorkspaceIn(folders, W('w2'), NOW)
    folders = adoptWorkspaceIn(folders, W('w1'), NOW)
    folders = createFolderIn(folders, ROOT_FOLDER_ID, '团队', F('f1'), NOW).folders
    folders = createFolderIn(folders, F('f1'), '产品', F('f2'), NOW).folders
    folders = moveWorkspaceIn(folders, W('w1'), F('f2'), undefined, NOW)
    return {
      folders,
      folderExpansion: { f1: true, ghost: true },
      recentTouchById: { w1: 1, w2: 2, w3: 3 },
      groupBy: 'flat',
      orderBy: 'manual',
      groupExpansion: { w1: true, 'recent:w1': true, w3: true },
      sessionOrderByAccount: { w1: ['s1'], w3: ['s2'] },
      sessionUpdatedAtByAccount: { w1: { s1: 1 }, w2: { s2: 2 } },
    }
  }

  it('restores the tree and viewing maps, adopting live workspaces the envelope lacks', () => {
    const next = restoredState(envelope(), [W('w1'), W('w2'), W('w3')], NOW)
    expect(next.folders[F('f2')]?.workspaceIds).toEqual([W('w1')])
    expect(next.folders[ROOT_FOLDER_ID]?.workspaceIds).toContain(W('w2'))
    expect(next.folders[ROOT_FOLDER_ID]?.workspaceIds).toContain(W('w3'))
    expect(next.folderExpansion[F('f1')]).toBe(true)
    expect(next.groupBy).toBe('flat')
    expect(next.orderBy).toBe('manual')
  })

  it('prunes dead workspace ids from every workspace-keyed map and folder account', () => {
    const next = restoredState(envelope(), [W('w1')], NOW)
    expect(next.folders[ROOT_FOLDER_ID]?.workspaceIds).toEqual([])
    expect(next.recentTouchById).toEqual({ w1: 1 })
    expect(next.groupExpansion).toEqual({ w1: true, 'recent:w1': true })
    expect(next.sessionOrderByAccount).toEqual({ w1: ['s1'] })
    expect(next.sessionUpdatedAtByAccount).toEqual({ w1: { s1: 1 } })
  })

  it('drops expansion keys of folders the envelope does not hold', () => {
    const next = restoredState(envelope(), [W('w1')], NOW)
    expect(next.folderExpansion).toEqual({ f1: true })
    expect(next.folderExpansion.ghost).toBeUndefined()
  })

  it('throws a TypeError on an invalid envelope', () => {
    expect(() => restoredState({ folders: {}, groupBy: 'x' }, [W('w1')], NOW)).toThrow(TypeError)
  })
})

describe('recentFileTree', () => {
  it('folds recency-ordered paths into indented dir rows before file rows', () => {
    expect(recentFileTree(['src/deep/b.ts', 'src/a.ts', 'README.md'], 20)).toEqual({
      rows: [
        { depth: 0, kind: 'dir', name: 'src', path: 'src/' },
        { depth: 1, kind: 'dir', name: 'deep', path: 'src/deep/' },
        { depth: 2, kind: 'file', name: 'b.ts', path: 'src/deep/b.ts' },
        { depth: 1, kind: 'file', name: 'a.ts', path: 'src/a.ts' },
        { depth: 0, kind: 'file', name: 'README.md', path: 'README.md' },
      ],
      hiddenFiles: 0,
    })
  })

  it('drops the leading separator of absolute paths and keeps a Windows drive segment', () => {
    expect(recentFileTree(['/Users/me/proj/main.ts', 'C:\\proj\\win.ts'], 20)).toEqual({
      rows: [
        // Each path's singleton directory chain merges into one row.
        { depth: 0, kind: 'dir', name: 'Users/me/proj', path: 'Users/me/proj/' },
        { depth: 1, kind: 'file', name: 'main.ts', path: 'Users/me/proj/main.ts' },
        { depth: 0, kind: 'dir', name: 'C:/proj', path: 'C:/proj/' },
        { depth: 1, kind: 'file', name: 'win.ts', path: 'C:/proj/win.ts' },
      ],
      hiddenFiles: 0,
    })
  })

  it('renders paths inside the project root relative to it, and outside paths in full', () => {
    const root = '/Users/havoc/projects/deepseek-harness/'
    expect(recentFileTree([
      '/Users/havoc/projects/deepseek-harness/packages/client/rows/Rows.tsx',
      '/Users/havoc/projects/deepseek-harness/packages/client/tree.ts',
      '/Users/havoc/other/notes.md',
    ], 20, root)).toEqual({
      rows: [
        // packages/client merge; tree.ts lives at that level and stops the
        // chain, so rows stays a separate level under it.
        { depth: 0, kind: 'dir', name: 'packages/client', path: 'packages/client/' },
        { depth: 1, kind: 'dir', name: 'rows', path: 'packages/client/rows/' },
        { depth: 2, kind: 'file', name: 'Rows.tsx', path: 'packages/client/rows/Rows.tsx' },
        { depth: 1, kind: 'file', name: 'tree.ts', path: 'packages/client/tree.ts' },
        // Outside the root: the full absolute path stays.
        { depth: 0, kind: 'dir', name: 'Users/havoc/other', path: 'Users/havoc/other/' },
        { depth: 1, kind: 'file', name: 'notes.md', path: 'Users/havoc/other/notes.md' },
      ],
      hiddenFiles: 0,
    })
    // A root with no trailing separator matches too, and a path equal to the
    // root (no segments after shortening) is skipped entirely.
    expect(recentFileTree(['/p/src/a.ts', '/p/other/b.ts', '/p'], 20, '/p')).toEqual({
      rows: [
        { depth: 0, kind: 'dir', name: 'src', path: 'src/' },
        { depth: 1, kind: 'file', name: 'a.ts', path: 'src/a.ts' },
        { depth: 0, kind: 'dir', name: 'other', path: 'other/' },
        { depth: 1, kind: 'file', name: 'b.ts', path: 'other/b.ts' },
      ],
      hiddenFiles: 0,
    })
    // A sibling that merely shares the root's prefix is not under it.
    expect(recentFileTree(['/p/src/a.ts', '/project/x.ts'], 20, '/p')).toEqual({
      rows: [
        { depth: 0, kind: 'dir', name: 'src', path: 'src/' },
        { depth: 1, kind: 'file', name: 'a.ts', path: 'src/a.ts' },
        { depth: 0, kind: 'dir', name: 'project', path: 'project/' },
        { depth: 1, kind: 'file', name: 'x.ts', path: 'project/x.ts' },
      ],
      hiddenFiles: 0,
    })
  })

  it('shortens the single-file flat row under the project root', () => {
    expect(recentFileTree(['/Users/h/proj/src/client/rows/Rows.tsx'], 20, '/Users/h/proj')).toEqual({
      rows: [{ depth: 0, kind: 'file', name: 'src/client/rows/Rows.tsx', path: 'src/client/rows/Rows.tsx' }],
      hiddenFiles: 0,
    })
  })

  it('flattens paths into name | path rows, shortened under the root and deduplicated', () => {
    expect(recentFileList([
      '/Users/u/proj/packages/client/rows.ts',
      '/Users/u/proj/packages/client/tree.ts',
      '/Users/u/elsewhere/notes.md',
      '/Users/u/proj/packages/client/rows.ts',
      '/Users/u/proj',
    ], '/Users/u/proj')).toEqual([
      { name: 'rows.ts', path: 'packages/client/rows.ts' },
      { name: 'tree.ts', path: 'packages/client/tree.ts' },
      { name: 'notes.md', path: 'Users/u/elsewhere/notes.md' },
    ])
    // No root: the leading separator is still normalized away, matching the
    // tree form.
    expect(recentFileList(['/x/y.ts', '/x/y.ts'])).toEqual([{ name: 'y.ts', path: 'x/y.ts' }])
    expect(recentFileList(['/p'], '/p')).toEqual([])
  })

  it('caps rendered rows at the budget and reports the exact hidden file count', () => {
    expect(recentFileTree(['a/1.ts', 'a/2.ts', 'a/3.ts', 'b.ts', 'c.ts'], 4)).toEqual({
      rows: [
        { depth: 0, kind: 'dir', name: 'a', path: 'a/' },
        { depth: 1, kind: 'file', name: '1.ts', path: 'a/1.ts' },
        { depth: 1, kind: 'file', name: '2.ts', path: 'a/2.ts' },
        { depth: 1, kind: 'file', name: '3.ts', path: 'a/3.ts' },
      ],
      hiddenFiles: 2,
    })
  })

  it('deduplicates defensively and skips separator-only and empty inputs', () => {
    expect(recentFileTree(['x/y.ts', 'x/y.ts', '/', '', 'src\\'], 20)).toEqual({
      rows: [
        { depth: 0, kind: 'dir', name: 'x', path: 'x/' },
        { depth: 1, kind: 'file', name: 'y.ts', path: 'x/y.ts' },
        // A trailing separator leaves one segment; nothing nests under it.
        { depth: 0, kind: 'file', name: 'src', path: 'src' },
      ],
      hiddenFiles: 0,
    })
  })

  it('keeps one leaf per name inside a directory across separator spellings', () => {
    expect(recentFileTree(['a/b.ts', 'a\\b.ts'], 20)).toEqual({
      rows: [
        { depth: 0, kind: 'dir', name: 'a', path: 'a/' },
        { depth: 1, kind: 'file', name: 'b.ts', path: 'a/b.ts' },
      ],
      // Both paths arrived; the second leaf shares the first's row, so it
      // counts as kept off the card.
      hiddenFiles: 1,
    })
  })
})

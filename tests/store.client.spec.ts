// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  FolderDepthExceededError,
  FolderNameConflictError,
  FolderRootProtectedError,
  FolderId,
  ROOT_FOLDER_ID,
} from '../src/client/model.ts'
import { createEnhancedWorkspaceStore } from '../src/client/store.ts'

const W = (id: string): WorkspaceId => id as WorkspaceId
const F = (id: string): FolderId => FolderId(id)

beforeEach(() => {
  localStorage.clear()
})

describe('enhanced workspace store', () => {
  it('initializes with the root folder record and default view fields', () => {
    const store = createEnhancedWorkspaceStore().create()
    const state = store.getSnapshot()
    expect(state.folders[ROOT_FOLDER_ID]).toMatchObject({
      folderId: 'root',
      parentFolderId: null,
      workspaceIds: [],
      folderIds: [],
    })
    expect(state.groupBy).toBe('workspace')
    expect(state.orderBy).toBe('updated')
    expect(state.folderExpansion).toEqual({})
    expect(state.recentTouchById).toEqual({})
  })

  it('creates folders through the action and persists sibling checks', () => {
    const instance = createEnhancedWorkspaceStore().create()
    instance.actions.createFolder(ROOT_FOLDER_ID, '产品组')
    const after = instance.getSnapshot()
    expect(after.folders[ROOT_FOLDER_ID]?.folderIds).toHaveLength(1)
    expect(() => instance.actions.createFolder(ROOT_FOLDER_ID, '产品组')).toThrow(FolderNameConflictError)
    expect(() => instance.actions.renameFolder(ROOT_FOLDER_ID, 'x')).toThrow(FolderRootProtectedError)
  })

  it('enforces the depth cap through the action', () => {
    const instance = createEnhancedWorkspaceStore().create()
    let parent = ROOT_FOLDER_ID
    for (let level = 2; level <= 6; level++) {
      instance.actions.createFolder(parent, `lvl-${level}`)
      // The action mints the record id itself (crypto.randomUUID): read the
      // new folder's id back from the tree instead of assuming the name.
      parent = instance.getSnapshot().folders[parent]!.folderIds.at(-1)!
    }
    expect(() => instance.actions.createFolder(parent, 'too-deep')).toThrow(FolderDepthExceededError)
  })

  it('deletes folders with promotion and clears their expansion entry', () => {
    const instance = createEnhancedWorkspaceStore().create()
    instance.actions.createFolder(ROOT_FOLDER_ID, 'a')
    const a = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    instance.actions.setFolderExpanded(a, true)
    instance.actions.deleteFolder(a)
    const after = instance.getSnapshot()
    expect(after.folders[ROOT_FOLDER_ID]?.folderIds).toEqual([])
    expect(after.folderExpansion[a]).toBeUndefined()
  })

  it('moves workspaces between folders and keeps the tree consistent', () => {
    const instance = createEnhancedWorkspaceStore().create()
    instance.actions.adoptWorkspace(W('w1'))
    instance.actions.createFolder(ROOT_FOLDER_ID, '团队')
    const team = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    instance.actions.moveWorkspaceIn(W('w1'), team)
    const after = instance.getSnapshot()
    expect(after.folders[team]?.workspaceIds).toEqual([W('w1')])
    expect(after.folders[ROOT_FOLDER_ID]?.workspaceIds).toEqual([])
    // Idempotent adoption does not duplicate membership.
    instance.actions.adoptWorkspace(W('w1'))
    expect(instance.getSnapshot().folders[team]?.workspaceIds).toEqual([W('w1')])
  })

  it('records touches and prunes dead keys on the baseline', () => {
    const instance = createEnhancedWorkspaceStore().create()
    instance.actions.adoptWorkspace(W('w1'))
    instance.actions.touchWorkspace(W('w1'))
    expect(instance.getSnapshot().recentTouchById[W('w1')]).toBeGreaterThan(0)
    instance.actions.retainLiveKeys([W('other')])
    const after = instance.getSnapshot()
    expect(after.recentTouchById).toEqual({})
    expect(after.folders[ROOT_FOLDER_ID]?.workspaceIds).toEqual([])
    expect(after.folders[ROOT_FOLDER_ID]).toBeDefined()
  })

  it('collapses only the workspace-list rows through the all action', () => {
    const instance = createEnhancedWorkspaceStore().create()
    instance.actions.adoptWorkspace(W('w1'))
    instance.actions.createFolder(ROOT_FOLDER_ID, 'a')
    const a = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    instance.actions.setFolderExpanded(a, true)
    instance.actions.setGroupExpanded(W('w1'), true)
    instance.actions.setGroupExpanded('recent:w1', true)
    instance.actions.collapseAll()
    const after = instance.getSnapshot()
    // The "all" section folds — folder and tree-row session groups — while
    // the recency rows keep their expansion; the tree itself stays intact.
    expect(after.folderExpansion).toEqual({})
    expect(after.groupExpansion).toEqual({ 'recent:w1': true })
    expect(after.folders[ROOT_FOLDER_ID]?.folderIds).toEqual([a])
  })

  it('collapses only the recency rows through the recents action', () => {
    const instance = createEnhancedWorkspaceStore().create()
    instance.actions.adoptWorkspace(W('w1'))
    instance.actions.createFolder(ROOT_FOLDER_ID, 'a')
    const a = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    instance.actions.setFolderExpanded(a, true)
    instance.actions.setGroupExpanded(W('w1'), true)
    instance.actions.setGroupExpanded('recent:w1', true)
    instance.actions.collapseRecents()
    const after = instance.getSnapshot()
    // Only the prefixed recency-row keys fold; the folder and the tree-row
    // keys stay expanded.
    expect(after.groupExpansion).toEqual({ [W('w1')]: true })
    expect(after.folderExpansion).toEqual({ [a]: true })
  })

  it('collapses both modules through the everything action', () => {
    const instance = createEnhancedWorkspaceStore().create()
    instance.actions.adoptWorkspace(W('w1'))
    instance.actions.createFolder(ROOT_FOLDER_ID, 'a')
    const a = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    instance.actions.setFolderExpanded(a, true)
    instance.actions.setGroupExpanded(W('w1'), true)
    instance.actions.setGroupExpanded('recent:w1', true)
    instance.actions.collapseEverything()
    const after = instance.getSnapshot()
    // The header's collapse is the union of both section actions: folders,
    // tree-row groups, AND recency rows all fold; the tree stays intact.
    expect(after.folderExpansion).toEqual({})
    expect(after.groupExpansion).toEqual({})
    expect(after.folders[ROOT_FOLDER_ID]?.folderIds).toEqual([a])
  })

  it('keeps prefixed recency-row expansion keys in step with their workspace on the baseline', () => {
    const instance = createEnhancedWorkspaceStore().create()
    instance.actions.setGroupExpanded('recent:w1', true)
    instance.actions.setGroupExpanded(W('w1'), true)
    // Live baseline: both the row key and the tree key survive…
    instance.actions.retainLiveKeys([W('w1')])
    let after = instance.getSnapshot()
    expect(after.groupExpansion).toEqual({ 'recent:w1': true, [W('w1')]: true })
    // …and a dead workspace takes its prefixed row key with it.
    instance.actions.retainLiveKeys([W('other')])
    after = instance.getSnapshot()
    expect(after.groupExpansion).toEqual({})
  })
})
describe('enhanced workspace store persistence envelope', () => {
  it('restores the envelope through the action and converges onto the baseline', () => {
    const instance = createEnhancedWorkspaceStore().create()
    // Build a durable envelope through the same actions (models a previous
    // session's state): folder 团队 with w1 inside, dead w2 at root.
    instance.actions.adoptWorkspace(W('w2'))
    instance.actions.createFolder(ROOT_FOLDER_ID, '团队')
    const team = instance.getSnapshot().folders[ROOT_FOLDER_ID]!.folderIds[0]!
    instance.actions.adoptWorkspace(W('w1'))
    instance.actions.moveWorkspaceIn(W('w1'), team)
    instance.actions.setFolderExpanded(team, true)
    instance.actions.touchWorkspace(W('w1'))
    const snapshot = instance.getSnapshot()
    const envelope = structuredClone(snapshot)

    // A fresh instance starts empty; the envelope lands wholesale.
    const fresh = createEnhancedWorkspaceStore().create()
    fresh.actions.restoreEnvelope(envelope, [W('w1'), W('w3')])
    const after = fresh.getSnapshot()
    expect(after.folders[team]?.workspaceIds).toEqual([W('w1')])
    expect(after.folderExpansion[team]).toBe(true)
    expect(after.recentTouchById[W('w1')]).toBeGreaterThan(0)
    // W('w2') is no longer live: pruned from the root account, and W('w3')
    // (live but absent from the envelope) is adopted at the root head.
    expect(after.folders[ROOT_FOLDER_ID]?.workspaceIds).toEqual([W('w3')])
  })

  it('rejects a garbage envelope with a TypeError', () => {
    const instance = createEnhancedWorkspaceStore().create()
    expect(() => instance.actions.restoreEnvelope({ folders: {}, groupBy: 'nope' }, [W('w1')])).toThrow(TypeError)
  })
})

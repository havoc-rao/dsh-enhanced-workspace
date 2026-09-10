/**
 * Unit spec of the client-side git model (src/client/git-model.ts): session
 * → tree binding, the workspace aggregate pill rule (none/single/multi),
 * the subworkspace grouping (own / linked / nogit), and the unregistered
 * tree set — all pure, driven by host-probe JSON fixtures (the acme layout
 * of the design concept: main tree + feat-payment + hotfix/login linked +
 * gh-pages unregistered, hammerspoon anywhere = no git).
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { GitProbeResultJSON } from '../src/shared/git.ts'
import {
  aggregateWorkspaceTrees,
  bindSessionTrees,
  deriveSubworkspaceGroups,
  normalizeProbePath,
  sessionsTrees,
  treeOfCwd,
  treesByWorkspace,
  unregisteredTrees,
} from '../src/client/git-model.ts'

const MAIN = '/work/acme'
const PAY = '/tmp/acme/feat-payment'
const HF = '/tmp/acme/hotfix-login'
const GH = '/tmp/acme/gh-pages'
const STRAY = '/tmp/acme/detached-stray'

/** The acme probe fixture (trees + bindings), shared by every case.
 *  gh-pages exists as a tree but has NO binding — the unregistered case. */
function acmeIndex(): GitProbeResultJSON {
  return {
    trees: {
      [MAIN]: { root: MAIN, repoKey: '/work/acme/.git', role: 'main', branch: 'main' },
      [PAY]: { root: PAY, repoKey: '/work/acme/.git', role: 'linked', branch: 'feat/payment' },
      [HF]: { root: HF, repoKey: '/work/acme/.git', role: 'linked', branch: 'hotfix/login' },
      [GH]: { root: GH, repoKey: '/work/acme/.git', role: 'linked', detached: '1a2b3c4' },
      [STRAY]: { root: STRAY, repoKey: '/work/acme/.git', role: 'linked', detached: 'deadbee' },
    },
    bindings: {
      [MAIN]: MAIN,
      [PAY]: PAY,
      [HF]: HF,
      [STRAY]: STRAY,
      // subdirectory inside the main tree binds to the main tree
      '/work/acme/tmp/prototype-ui': MAIN,
    },
    scannedAt: 1000,
  }
}

describe('normalizeProbePath / treeOfCwd', () => {
  it('normalizes duplicates and trailing slashes for lookups', () => {
    expect(normalizeProbePath('/a//b/')).toBe('/a/b')
    expect(normalizeProbePath('C:\\a\\b')).toBe('C:/a/b')
  })

  it('resolves exact and subdirectory cwds; none for unbound paths', () => {
    const index = acmeIndex()
    expect(treeOfCwd(index, PAY)?.branch).toBe('feat/payment')
    expect(treeOfCwd(index, '/work/acme/tmp/prototype-ui')?.role).toBe('main')
    expect(treeOfCwd(index, '/work/acme/tmp/prototype-ui/')).toBeDefined()
    expect(treeOfCwd(index, '/elsewhere')).toBeUndefined()
    expect(treeOfCwd(index, undefined)).toBeUndefined()
  })
})

describe('bindSessionTrees', () => {
  it('binds every session by its own cwd (cross-tree workspace works)', () => {
    const index = acmeIndex()
    const sessions = [
      { id: 'sa1' as SessionId, cwd: '/work/acme' },
      { id: 'sc1' as SessionId, cwd: HF }, // cross-tree session inside acme workspace
      { id: 'sh1' as SessionId, cwd: '~/.hammerspoon' },
    ]
    const bound = bindSessionTrees(sessions, index)
    expect(bound.get('sa1' as SessionId)?.branch).toBe('main')
    expect(bound.get('sc1' as SessionId)?.branch).toBe('hotfix/login')
    expect(bound.has('sh1' as SessionId)).toBe(false)
  })
})

describe('aggregateWorkspaceTrees (row pill rule)', () => {
  it('none → no pill; single → the tree; multi → count', () => {
    const index = acmeIndex()
    expect(aggregateWorkspaceTrees([{ id: 'x' as SessionId, cwd: '~/nope' }], index)).toEqual({ kind: 'none' })
    expect(aggregateWorkspaceTrees([{ id: 'x' as SessionId, cwd: PAY }], index)).toEqual({
      kind: 'single',
      tree: index.trees[PAY],
    })
    expect(aggregateWorkspaceTrees([
      { id: 'a' as SessionId, cwd: MAIN },
      { id: 'b' as SessionId, cwd: HF },
    ], index)).toEqual({ kind: 'multi', trees: [index.trees[MAIN], index.trees[HF]] })
    expect(sessionsTrees([{ id: 'a' as SessionId, cwd: PAY }], index)).toHaveLength(1)
  })
})

describe('deriveSubworkspaceGroups', () => {
  it('groups own / linked / nogit sessions of one workspace', () => {
    const index = acmeIndex()
    const groups = deriveSubworkspaceGroups(MAIN, [
      { id: 'sa1' as SessionId, cwd: MAIN },
      { id: 'sa2' as SessionId, cwd: '/work/acme/tmp/prototype-ui' }, // own tree via subdir
      { id: 'sc1' as SessionId, cwd: HF },
      { id: 'sh1' as SessionId, cwd: '/elsewhere' },
    ], index)
    expect(groups.map(g => [g.key, g.sessionIds])).toEqual([
      ['own', ['sa1', 'sa2']],
      ['hotfix/login', ['sc1']],
      ['nogit', ['sh1']],
    ])
    expect(groups[0]?.own).toBe(true)
    expect(groups[1]?.tree?.branch).toBe('hotfix/login')
    expect(groups[2]?.tree).toBeUndefined()
  })

  it('flattens to a single own group for ordinary single-tree workspaces', () => {
    const index = acmeIndex()
    const groups = deriveSubworkspaceGroups(PAY, [
      { id: 'p1' as SessionId, cwd: PAY },
      { id: 'p2' as SessionId, cwd: PAY },
    ], index)
    expect(groups).toHaveLength(1)
    expect(groups[0]?.key).toBe('own')
  })

  it('detached linked trees group by their sha', () => {
    const index = acmeIndex()
    const groups = deriveSubworkspaceGroups(MAIN, [
      { id: 'sa1' as SessionId, cwd: MAIN },
      { id: 'g1' as SessionId, cwd: STRAY },
    ], index)
    expect(groups.map(g => g.key)).toEqual(['own', 'deadbee'])
  })
})

describe('unregisteredTrees', () => {
  it('reports trees no path binds to; a binding un-registers the tree', () => {
    const index = acmeIndex()
    // gh-pages exists as a tree but nothing binds to it.
    const unreg = unregisteredTrees(index, [PAY, MAIN, HF]).map(t => t.root)
    expect(unreg).toContain(GH)
    expect(unreg).not.toContain(PAY)
    // Once a session cwd binds it (host adds the binding), it leaves the set.
    const withBinding: GitProbeResultJSON = {
      ...index,
      bindings: { ...index.bindings, [GH]: GH },
    }
    const covered = unregisteredTrees(withBinding, [PAY, HF]).map(t => t.root)
    expect(covered).not.toContain(GH)
  })
})

describe('treesByWorkspace', () => {
  it('maps every git workspace to its tree roots (reverse lookup)', () => {
    const index = acmeIndex()
    const byTree = treesByWorkspace(index, [
      { workspaceId: 'w-acme' as WorkspaceId, path: MAIN },
      { workspaceId: 'w-proto' as WorkspaceId, path: '/work/acme/tmp/prototype-ui' },
      { workspaceId: 'w-hs' as WorkspaceId, path: '~/.hammerspoon' },
    ])
    expect(byTree.get(MAIN)).toEqual(['w-acme', 'w-proto'])
    expect(byTree.has('~/.hammerspoon')).toBe(false)
  })
})
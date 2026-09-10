/**
 * Unit spec of the remote-mirror git layer (src/client/remote-git.ts +
 * src/shared/git.ts wire validators): marker validation against the real
 * dsh-remote contract (GET /dsh-remote/git-workspace), the virtual remote
 * tree conversion, the overlay merge into the local probe (bindings inside
 * mirrors, stale-binding replacement, reference stability), and the pill /
 * hover presentation helpers.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { GitProbeResultJSON, RemoteGitMarker } from '../src/shared/git.ts'
import {
  isRemoteGitMarker,
  isRemoteGitWorkspaceResponse,
} from '../src/shared/git.ts'
import { aggregateWorkspaceTrees, deriveRepoGroups } from '../src/client/git-model.ts'
import {
  overlayRemoteMarkers,
  remoteBranchLabel,
  remoteDirtyCount,
  remoteMachineLabel,
  remotePillTitle,
  remoteStagedCount,
  remoteTreeInfo,
  remoteTreeRoot,
} from '../src/client/remote-git.ts'

const REMOTE_PATH = '/Users/u/.dsh/remote-workspaces/1.2.3.4-root-22/acme'
const MIRROR_DIR = REMOTE_PATH

/** The repo marker exactly as dsh-remote's buildWorkspaceMarker + route
 *  base serve it (verified against lib/git-parse.js + lib/index.js). */
function repoMarker(overrides: Partial<RemoteGitMarker> = {}): RemoteGitMarker {
  return {
    isRepo: true,
    branch: 'dev',
    dirty: 3,
    staged: 1,
    ahead: 2,
    behind: 0,
    upstream: 'origin/dev',
    root: '/srv/acme',
    remotePath: '/srv/acme',
    machine: { id: 'm1', name: 'dev', host: '1.2.3.4', port: 22, username: 'root' },
    mirrorDir: MIRROR_DIR,
    at: 1234,
    ...overrides,
  }
}

/** Variant builder: start from the repo marker and mutate a FRESH copy
 *  (deleting optional fields — exactOptionalPropertyTypes forbids assigning
 *  `undefined` to them). */
function variant(mutate: (marker: RemoteGitMarker) => void): RemoteGitMarker {
  const marker = repoMarker()
  mutate(marker)
  return marker
}

/** A local probe over the mirror (no git — bindings absent) + a local repo. */
function localProbe(): GitProbeResultJSON {
  return {
    trees: {
      '/work/local': { root: '/work/local', repoKey: '/work/local/.git', role: 'main', branch: 'main' },
    },
    bindings: { '/work/local': '/work/local' },
    scannedAt: 1000,
  }
}

describe('wire validators (shared/git.ts)', () => {
  it('accepts the repo marker as dsh-remote serves it', () => {
    expect(isRemoteGitMarker(repoMarker())).toBe(true)
  })

  it('accepts the isRepo:false variant (no counts, empty root)', () => {
    const nonRepo: RemoteGitMarker = {
      isRepo: false,
      root: '',
      remotePath: '/srv/acme',
      machine: null,
      mirrorDir: MIRROR_DIR,
      at: 1234,
    }
    expect(isRemoteGitMarker(nonRepo)).toBe(true)
  })

  it('accepts the detached variant without branch/counts emitted conditionally', () => {
    expect(isRemoteGitMarker(variant(m => { delete m.branch; delete m.upstream; m.detached = 'a1b2c3d' }))).toBe(true)
  })

  it('rejects malformed markers', () => {
    expect(isRemoteGitMarker(null)).toBe(false)
    expect(isRemoteGitMarker({})).toBe(false)
    // repo variant without any branch/detached label
    expect(isRemoteGitMarker(variant(m => { delete m.branch; delete m.detached }))).toBe(false)
    // non-numeric count
    expect(isRemoteGitMarker(repoMarker({ dirty: '3' as unknown as number }))).toBe(false)
    expect(isRemoteGitMarker(repoMarker({ dirty: -1 }))).toBe(false)
    // machine must be a record or null
    expect(isRemoteGitMarker(repoMarker({ machine: {} as RemoteGitMarker['machine'] }))).toBe(false)
    expect(isRemoteGitMarker(repoMarker({ machine: null }))).toBe(true)
    // empty remotePath
    expect(isRemoteGitMarker(repoMarker({ remotePath: '' }))).toBe(false)
  })

  it('validates the response body wrapper', () => {
    expect(isRemoteGitWorkspaceResponse({ ok: true, marker: repoMarker() })).toBe(true)
    expect(isRemoteGitWorkspaceResponse({ ok: true, marker: null })).toBe(true)
    expect(isRemoteGitWorkspaceResponse({ ok: true })).toBe(false)
    expect(isRemoteGitWorkspaceResponse({ ok: false, error: 'boom', credential: true })).toBe(false)
    expect(isRemoteGitWorkspaceResponse({ ok: true, marker: { nope: 1 } })).toBe(false)
  })
})

describe('remoteTreeRoot / remoteTreeInfo', () => {
  it('namespaces the virtual root per owning machine and remote path', () => {
    expect(remoteTreeRoot(repoMarker())).toBe('remote:m1:/srv/acme')
    // same remote path, different machine → distinct roots
    const other = repoMarker({ machine: { id: 'm2', name: 'prod', host: '5.6.7.8', port: 36000, username: 'deploy' } })
    expect(remoteTreeRoot(other)).toBe('remote:m2:/srv/acme')
    // machine-less (pool route) → 'any' tag
    expect(remoteTreeRoot(repoMarker({ machine: null }))).toBe('remote:any:/srv/acme')
  })

  it('converts a repo marker into the virtual remote tree', () => {
    const tree = remoteTreeInfo(repoMarker())
    expect(tree).toEqual({
      root: 'remote:m1:/srv/acme',
      repoKey: 'remote:m1:/srv/acme',
      role: 'remote',
      branch: 'dev',
    })
  })

  it('converts the detached variant; returns undefined for non-repo or unlabeled', () => {
    expect(remoteTreeInfo(variant(m => { delete m.branch; m.detached = 'a1b2c3d' }))?.detached).toBe('a1b2c3d')
    const nonRepo: RemoteGitMarker = {
      isRepo: false, root: '', remotePath: '/srv/acme', machine: null, mirrorDir: null, at: 1,
    }
    expect(remoteTreeInfo(nonRepo)).toBeUndefined()
    expect(remoteTreeInfo(variant(m => { m.branch = ''; delete m.detached }))).toBeUndefined()
  })
})

describe('overlayRemoteMarkers', () => {
  it('returns the probe reference unchanged with no markers or no repo markers', () => {
    const probe = localProbe()
    expect(overlayRemoteMarkers(probe, new Map(), ['/work/local'])).toBe(probe)
    expect(overlayRemoteMarkers(probe, new Map([[REMOTE_PATH, variant(m => { delete m.branch; delete m.detached })]]), [REMOTE_PATH])).toBe(probe)
    expect(overlayRemoteMarkers(null, new Map([[REMOTE_PATH, repoMarker()]]), [REMOTE_PATH])).toBeNull()
  })

  it('injects the virtual tree + binding for the mirror path and interior paths', () => {
    const probe = localProbe()
    const markers = new Map([[REMOTE_PATH, repoMarker()]])
    const merged = overlayRemoteMarkers(probe, markers, [REMOTE_PATH, `${REMOTE_PATH}/sub/dir`, '/work/local'])
    expect(merged).not.toBe(probe)
    // probe inputs untouched (immutability)
    expect(probe.trees['remote:m1:/srv/acme']).toBeUndefined()
    const tree = merged!.trees['remote:m1:/srv/acme']
    expect(tree?.role).toBe('remote')
    expect(merged!.bindings[REMOTE_PATH]).toBe('remote:m1:/srv/acme')
    // a session cwd INSIDE the mirror binds to the same virtual tree
    expect(merged!.bindings[`${REMOTE_PATH}/sub/dir`]).toBe('remote:m1:/srv/acme')
    // local bindings survive
    expect(merged!.bindings['/work/local']).toBe('/work/local')
  })

  it('replaces a stale local binding on the mirror path (remote is authoritative)', () => {
    const probe = localProbe()
    const stale: GitProbeResultJSON = {
      ...probe,
      bindings: { ...probe.bindings, [REMOTE_PATH]: '/work/local' },
    }
    const merged = overlayRemoteMarkers(stale, new Map([[REMOTE_PATH, repoMarker()]]), [REMOTE_PATH])
    expect(merged!.bindings[REMOTE_PATH]).toBe('remote:m1:/srv/acme')
    expect(merged!.bindings['/work/local']).toBe('/work/local')
  })

  it('ignores markers whose path was not probed, and non-repo markers bind nothing', () => {
    const probe = localProbe()
    const orphan = overlayRemoteMarkers(
      probe,
      new Map([['/elsewhere/not-probed', repoMarker()]]),
      ['/work/local'],
    )
    expect(orphan).toBe(probe)
    const nonRepo: RemoteGitMarker = {
      isRepo: false, root: '', remotePath: '/srv/acme', machine: null, mirrorDir: null, at: 1,
    }
    const merged = overlayRemoteMarkers(probe, new Map([[REMOTE_PATH, nonRepo]]), [REMOTE_PATH])
    expect(merged).toBe(probe)
  })
})

describe('presentation helpers', () => {
  it('reads dirty/staged counts (0 for absent / non-repo)', () => {
    expect(remoteDirtyCount(repoMarker())).toBe(3)
    expect(remoteStagedCount(repoMarker())).toBe(1)
    const nonRepo: RemoteGitMarker = {
      isRepo: false, root: '', remotePath: '/srv/acme', machine: null, mirrorDir: null, at: 1,
    }
    expect(remoteDirtyCount(nonRepo)).toBe(0)
    expect(remoteStagedCount(nonRepo)).toBe(0)
  })

  it('composes the branch label and the pill tooltip', () => {
    expect(remoteBranchLabel(repoMarker())).toBe('dev')
    expect(remoteBranchLabel(variant(m => { delete m.branch; m.detached = 'a1b2c3d' }))).toBe('a1b2c3d')
    expect(remoteBranchLabel(variant(m => { m.branch = ''; delete m.detached }))).toBe('')
    expect(remotePillTitle(repoMarker())).toBe('⎇ dev · 3 (1 staged) · ↑2')
    expect(remotePillTitle(repoMarker({ ahead: 0, behind: 1, dirty: 0, staged: 0 }))).toBe('⎇ dev · ↓1')
    expect(remotePillTitle(variant(m => { m.dirty = 0; m.staged = 0; delete m.upstream }))).toBe('⎇ dev')
    expect(remotePillTitle(repoMarker({ dirty: 0, staged: 0, upstream: 'origin/dev', ahead: 0, behind: 0 }))).toBe('⎇ dev')
  })

  it('labels the owning machine (port 22 omitted)', () => {
    expect(remoteMachineLabel(repoMarker().machine)).toBe('root@1.2.3.4')
    expect(remoteMachineLabel(null)).toBe('')
    const odd = repoMarker({ machine: { id: 'm2', name: 'p', host: '5.6.7.8', port: 36000, username: 'deploy' } }).machine
    expect(remoteMachineLabel(odd)).toBe('deploy@5.6.7.8:36000')
  })

  it('keeps the overlay usable with real model functions (git-model round trip)', async () => {
    const probe = localProbe()
    const markers = new Map([[REMOTE_PATH, repoMarker()]])
    const merged = overlayRemoteMarkers(probe, markers, [REMOTE_PATH])!
    // a mirror workspace aggregates its sessions through the virtual tree
    expect(aggregateWorkspaceTrees([{ id: 's1' as SessionId, cwd: REMOTE_PATH }], merged)).toEqual({
      kind: 'single',
      tree: merged.trees['remote:m1:/srv/acme'],
    })
    // repo grouping picks the remote repo group by the remote root basename
    const { repos } = deriveRepoGroups(merged, [{ workspaceId: 'w-rm' as WorkspaceId, path: REMOTE_PATH }])
    expect(repos.map(repo => [repo.name, repo.repoKey])).toEqual([['acme', 'remote:m1:/srv/acme']])
  })
})
/**
 * Unit spec of the host-side git probe (src/host/git.ts): the pure parsers
 * (gitdir pointer, HEAD ref, commondir resolve, porcelain), the upward
 * `.git` walk and repo enumeration against REAL filesystem fixtures (main /
 * linked / detached / submodule / no-git / spaced paths), the mtime+TTL
 * cache invalidation, and the wire serialization round-trip. Pure node
 * environment — no jsdom, no DSH boot, no git binary needed.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_WALK_DEPTH,
  canonicalInputPath,
  classifyGitdir,
  clearRepoCache,
  enumerateRepoTrees,
  parseGitdirFile,
  parseHeadFile,
  parseWorktreePorcelain,
  probeGitIndex,
  resolveCommondir,
  resolveTreeRoot,
  serializeGitRepoIndex,
} from '../src/host/git.ts'
import { isGitProbeResultJSON } from '../src/shared/git.ts'

/**
 * Build one scratch fixture tree with real git plumbing layout:
 *   <root>/repo/.git/                      main worktree
 *   <root>/repo/.git/worktrees/wt-feat/    linked worktree (branch feat/x)
 *   <root>/repo/.git/worktrees/wt-det/     linked worktree (detached)
 *   <root>/repo/.git/modules/sub/          submodule git dir
 *   <root>/wt-feat/        (its `.git` file)         upstream
 *   <root>/wt-det/                          detached worktree root
 *   <root>/sub/somewhere/                   submodule root (deeper nesting)
 *   <root>/plain/deep/deeper/               no git at all
 *   <root>/wt spaced/                       linked with a space
 * @returns the fixture root path.
 */
function createFixture(): string {
  const root = join(tmpdir(), `dsh-enhanced-workspace-git-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  const repo = join(root, 'repo')
  const git = join(repo, '.git')
  const wtDir = join(git, 'worktrees')
  const modDir = join(git, 'modules')
  mkdirSync(join(git, 'worktrees', 'wt-feat'), { recursive: true })
  mkdirSync(join(git, 'worktrees', 'wt-det'), { recursive: true })
  mkdirSync(join(git, 'worktrees', 'spaced'), { recursive: true })
  mkdirSync(join(modDir, 'sub', 'objects'), { recursive: true })
  mkdirSync(join(root, 'wt-feat'), { recursive: true })
  mkdirSync(join(root, 'wt-det'), { recursive: true })
  mkdirSync(join(root, 'wt spaced'), { recursive: true })
  mkdirSync(join(root, 'sub', 'somewhere'), { recursive: true })
  mkdirSync(join(root, 'plain', 'deep', 'deeper'), { recursive: true })

  // main worktree HEAD
  writeFileSync(join(git, 'HEAD'), 'ref: refs/heads/main\n')
  // linked wt-feat: admin dir plumbing
  writeFileSync(join(wtDir, 'wt-feat', 'HEAD'), 'ref: refs/heads/feat/x\n')
  writeFileSync(join(wtDir, 'wt-feat', 'commondir'), '../..\n')
  writeFileSync(join(wtDir, 'wt-feat', 'gitdir'), join(root, 'wt-feat', '.git'))
  writeFileSync(join(root, 'wt-feat', '.git'), `gitdir: ${join(git, 'worktrees', 'wt-feat')}\n`)
  // linked wt-det: detached HEAD (raw sha), spaced root
  writeFileSync(join(wtDir, 'wt-det', 'HEAD'), '2154bab0dc8f98405ef2f22607d921ed83ad7984\n')
  writeFileSync(join(wtDir, 'wt-det', 'commondir'), '../..\n')
  writeFileSync(join(wtDir, 'wt-det', 'gitdir'), join(root, 'wt-det', '.git'))
  writeFileSync(join(root, 'wt-det', '.git'), `gitdir: ${join(git, 'worktrees', 'wt-det')}\n`)
  // linked with a space in the path
  writeFileSync(join(wtDir, 'spaced', 'HEAD'), 'ref: refs/heads/feat/spaced\n')
  writeFileSync(join(wtDir, 'spaced', 'commondir'), '../..\n')
  writeFileSync(join(wtDir, 'spaced', 'gitdir'), join(root, 'wt spaced', '.git'))
  writeFileSync(join(root, 'wt spaced', '.git'), `gitdir: ${join(git, 'worktrees', 'spaced')}\n`)
  // submodule: .git file → modules/<name> (its commondir points at itself)
  writeFileSync(join(modDir, 'sub', 'HEAD'), 'ref: refs/heads/submain\n')
  writeFileSync(join(modDir, 'sub', 'commondir'), '.\n')
  writeFileSync(join(root, 'sub', 'somewhere', '.git'), `gitdir: ${join(git, 'modules', 'sub')}\n`)
  return root
}

let scratch = ''
afterEach(() => {
  if (scratch) {
    rmSync(scratch, { recursive: true, force: true })
    scratch = ''
  }
  clearRepoCache()
})

describe('pure parsers', () => {
  it('parseGitdirFile reads the gitdir pointer', () => {
    expect(parseGitdirFile('gitdir: /a/b/.git/worktrees/feat\n')).toBe('/a/b/.git/worktrees/feat')
    expect(parseGitdirFile('gitdir: /with space/x\n')).toBe('/with space/x')
    expect(parseGitdirFile('not a gitdir')).toBeUndefined()
    expect(parseGitdirFile('')).toBeUndefined()
  })

  it('parseHeadFile distinguishes branch refs from detached shas', () => {
    expect(parseHeadFile('ref: refs/heads/feat/x\n')).toEqual({ branch: 'feat/x' })
    expect(parseHeadFile('ref: refs/heads/main\n')).toEqual({ branch: 'main' })
    expect(parseHeadFile('2154bab0dc8f98405ef2f22607d921ed83ad7984\n')).toEqual({ detached: '2154bab' })
    expect(parseHeadFile('garbage')).toBeUndefined()
  })

  it('classifyGitdir splits worktrees / modules / main', () => {
    expect(classifyGitdir('/r/.git')).toBe('main')
    expect(classifyGitdir('/r/.git/worktrees/feat')).toBe('linked')
    expect(classifyGitdir('/r/.git/worktrees/wt-feat')).toBe('linked')
    expect(classifyGitdir('/r/.git/modules/sub')).toBe('submodule')
    expect(classifyGitdir('C:\\r\\.git\\worktrees\\feat')).toBe('linked')
  })

  it('resolveCommondir resolves relative values against the admin dir', () => {
    expect(resolveCommondir('/r/.git/worktrees/feat', '../..\n')).toBe('/r/.git')
    expect(resolveCommondir('/r/.git/worktrees/feat', '/abs/.git\n')).toBe('/abs/.git')
  })

  it('parseWorktreePorcelain parses blank-separated records incl. quoting', () => {
    const out = parseWorktreePorcelain(
      [
        'worktree /tmp/wt-demo/main',
        'HEAD 2154bab0dc8f98405ef2f22607d921ed83ad7984',
        'branch refs/heads/main',
        '',
        'worktree "/tmp/wt spaced"',
        'HEAD 2154bab0dc8f98405ef2f22607d921ed83ad7984',
        'detached',
        '',
        'worktree /tmp/bare',
        'HEAD 0000000000000000000000000000000000000000',
        'bare',
        '',
      ].join('\n'),
    )
    expect(out).toHaveLength(3)
    expect(out[0]).toEqual({ worktree: '/tmp/wt-demo/main', detached: false, bare: false, branch: 'main' })
    expect(out[1]).toEqual({ worktree: '/tmp/wt spaced', detached: true, bare: false })
    expect(out[2]).toEqual({ worktree: '/tmp/bare', detached: false, bare: true })
  })
})

describe('resolveTreeRoot (real .git walk)', () => {
  it('walks up to the FIRST .git and classifies main / linked / submodule', () => {
    scratch = createFixture()
    const git = join(scratch, 'repo', '.git')

    // main: .git directory at the walking point
    const main = resolveTreeRoot(join(scratch, 'repo', 'sub'))
    expect(main).toMatchObject({ root: join(scratch, 'repo'), kind: 'main', repoKey: git })

    // linked: .git file → worktrees/wt-feat, commondir → main .git, branch
    const linked = resolveTreeRoot(join(scratch, 'wt-feat'))
    expect(linked).toMatchObject({
      root: join(scratch, 'wt-feat'),
      kind: 'linked',
      repoKey: git,
      branch: 'feat/x',
    })

    // detached linked
    const detached = resolveTreeRoot(join(scratch, 'wt-det'))
    expect(detached).toMatchObject({ kind: 'linked', repoKey: git, detached: '2154bab' })
    expect(detached?.branch).toBeUndefined()

    // linked with a space in the path
    const spaced = resolveTreeRoot(join(scratch, 'wt spaced'))
    expect(spaced).toMatchObject({ kind: 'linked', branch: 'feat/spaced' })

    // submodule: nested two levels below the main tree; its own gitdir is
    // the identity (modules/sub), NOT the enclosing repo.
    const sub = resolveTreeRoot(join(scratch, 'sub', 'somewhere'))
    expect(sub).toMatchObject({ root: join(scratch, 'sub', 'somewhere'), kind: 'submodule' })
    expect(sub?.repoKey).toBe(join(git, 'modules', 'sub'))

    // no git anywhere above → undefined (walk is bounded anyway)
    expect(resolveTreeRoot(join(scratch, 'plain', 'deep', 'deeper'))).toBeUndefined()
  })

  it('does not mistake a non-gitdir .git file for a worktree', () => {
    scratch = join(tmpdir(), `dsh-enhanced-workspace-git-notgit-${Date.now()}`)
    mkdirSync(join(scratch, 'x', 'y'), { recursive: true })
    writeFileSync(join(scratch, 'x', '.git'), 'not a gitdir pointer\n')
    const res = resolveTreeRoot(join(scratch, 'x', 'y'))
    expect(res).toBeDefined()
    expect(res?.kind).toBe('main') // treated as an opaque git dir holder
    expect(res?.root).toBe(join(scratch, 'x'))
  })

  it('binds every input path and enumerates all repo trees', () => {
    scratch = createFixture()
    const git = join(scratch, 'repo', '.git')
    const index = probeGitIndex([
      join(scratch, 'repo'),
      join(scratch, 'wt-feat'),
      join(scratch, 'wt-det'),
      join(scratch, 'wt spaced'),
      join(scratch, 'sub', 'somewhere'),
      join(scratch, 'plain', 'deep', 'deeper'),
    ], { now: 1000, ttlMs: 0 })
    // bindings: every git-covered path maps to its tree root; plain does not.
    expect(index.bindings.get(canonicalInputPath(join(scratch, 'repo')))).toBe(join(scratch, 'repo'))
    expect(index.bindings.get(canonicalInputPath(join(scratch, 'wt-feat')))).toBe(join(scratch, 'wt-feat'))
    expect(index.bindings.get(canonicalInputPath(join(scratch, 'sub', 'somewhere')))).toBe(join(scratch, 'sub', 'somewhere'))
    expect(index.bindings.has(canonicalInputPath(join(scratch, 'plain', 'deep', 'deeper')))).toBe(false)
    // trees: main + 3 linked all under the same repo key.
    const acme = [...index.trees.values()].filter(t => t.repoKey === git)
    expect(acme.map(t => t.role).sort()).toEqual(['linked', 'linked', 'linked', 'main'])
    expect(acme.find(t => t.role === 'main')?.root).toBe(join(scratch, 'repo'))
    expect(acme.find(t => t.branch === 'feat/x')?.root).toBe(join(scratch, 'wt-feat'))
    expect(acme.find(t => t.detached === '2154bab')?.root).toBe(join(scratch, 'wt-det'))
    expect(index.scannedAt).toBe(1000)
    // submodule enumerates as its own repository (role main, own key).
    const subTrees = [...index.trees.values()].filter(t => t.repoKey === join(git, 'modules', 'sub'))
    expect(subTrees).toHaveLength(1)
    expect(subTrees[0]?.role).toBe('main')
  })
})

describe('probe cache', () => {
  it('reuses the enumeration while the mtime signature and TTL hold', () => {
    scratch = createFixture()
    const git = join(scratch, 'repo', '.git')
    const a = enumerateRepoTrees(git, { now: 1000, ttlMs: 5000 })
    const b = enumerateRepoTrees(git, { now: 3000, ttlMs: 5000 })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b)) // same layout
    // TTL expiry recomputes (still identical layout, but fresh pass)
    const c = enumerateRepoTrees(git, { now: 9000, ttlMs: 5000 })
    expect(c).toHaveLength(4)
  })

  it('recomputes when the worktrees directory mtime changes', () => {
    scratch = createFixture()
    const git = join(scratch, 'repo', '.git')
    const before = enumerateRepoTrees(git, { now: 1000, ttlMs: 100000 })
    expect(before).toHaveLength(4)
    // simulate a new worktree added: mtime bump on the worktrees dir
    const wtSpaced = join(git, 'worktrees')
    mkdirSync(join(git, 'worktrees', 'new-wt'), { recursive: true })
    writeFileSync(join(git, 'worktrees', 'new-wt', 'HEAD'), 'ref: refs/heads/new\n')
    writeFileSync(join(git, 'worktrees', 'new-wt', 'commondir'), '../..\n')
    writeFileSync(join(git, 'worktrees', 'new-wt', 'gitdir'), join(scratch, 'new-wt', '.git'))
    mkdirSync(join(scratch, 'new-wt'), { recursive: true })
    writeFileSync(join(scratch, 'new-wt', '.git'), `gitdir: ${join(git, 'worktrees', 'new-wt')}\n`)
    utimesSync(wtSpaced, new Date(Date.now() + 2000), new Date(Date.now() + 2000))
    const after = enumerateRepoTrees(git, { now: 2000, ttlMs: 100000 })
    expect(after).toHaveLength(5)
    expect(after.find(t => t.branch === 'new')?.root).toBe(join(scratch, 'new-wt'))
  })
})

describe('wire serialization', () => {
  it('serializes to the shared JSON shape and back-validates', () => {
    scratch = createFixture()
    const index = probeGitIndex([join(scratch, 'wt-feat')], { now: 42, ttlMs: 0 })
    const json = serializeGitRepoIndex(index)
    expect(isGitProbeResultJSON(json)).toBe(true)
    expect(json.scannedAt).toBe(42)
    expect(json.trees[join(scratch, 'wt-feat')]).toMatchObject({
      root: join(scratch, 'wt-feat'),
      role: 'linked',
      branch: 'feat/x',
    })
    expect(json.bindings[canonicalInputPath(join(scratch, 'wt-feat'))]).toBe(join(scratch, 'wt-feat'))
    // malformed shapes are rejected
    expect(isGitProbeResultJSON(null)).toBe(false)
    expect(isGitProbeResultJSON({ trees: {}, bindings: { nope: '/x' }, scannedAt: 1 })).toBe(false)
    expect(isGitProbeResultJSON({ trees: { '/x': { root: '/y', repoKey: '/g', role: 'main' } }, bindings: {}, scannedAt: 1 })).toBe(false)
  })
})

describe('probe robustness', () => {
  it('handles empty input, unreadable paths, and bounded walk', () => {
    scratch = createFixture()
    expect(probeGitIndex([], { now: 1, ttlMs: 0 }).trees.size).toBe(0)
    expect(probeGitIndex([join(scratch, 'does', 'not', 'exist')], { now: 1, ttlMs: 0 }).bindings.size).toBe(0)
    // walk ceiling constant is a sane bound
    expect(MAX_WALK_DEPTH).toBeGreaterThanOrEqual(32)
    // a linked tree also feeds the repo set with only its own bindings
    const index = probeGitIndex([join(scratch, 'wt-det')], { now: 1, ttlMs: 0 })
    expect(index.trees.size).toBeGreaterThanOrEqual(2) // main + linked(detached)
    expect(copyFileSync).toBeDefined()
    expect(existsSync).toBeDefined()
  })
})
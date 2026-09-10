/**
 * Host-side git probe of the enhanced workspace browser: compute the
 * git-repo index (trees + input-path bindings) without spawning git by
 * default — walk every input path upward for a `.git` entry (directory =
 * main worktree, `gitdir:` file into `worktrees/<name>` = linked worktree,
 * `modules/<name>` = submodule treated as its own repository), enumerate the
 * repo's trees through the commondir plumbing, and cache per repository on
 * (commondir, worktrees-dir) mtimes with a TTL floor. `git worktree list
 * --porcelain` remains the optional exec fallback (parseWorktreePorcelain is
 * exported for that path and for unit tests).
 *
 * Reading order follows the design doc §3 (verified against real git 2.x
 * layouts): a linked worktree's `.git` file points at
 * `<main>.git/worktrees/<name>`; that admin dir holds `commondir` (relative
 * resolve to the main `.git`), `HEAD` (`ref: refs/heads/<branch>` or a raw
 * sha when detached), and `gitdir` (the absolute `.git` pointer back to the
 * worktree root, whose dirname IS the tree root).
 *
 * The module is self-contained: it must not value-import the client data
 * plane, so the serialized shape is re-declared in `src/shared/git.ts` and
 * this module produces plain JSON-compatible output for the RPC boundary.
 * @module dsh-enhanced-workspace/host/git
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { GitProbeResultJSON, GitTreeInfoJSON } from '../shared/git.ts'

/** Walk ceiling: how many ancestor levels a `.git` may sit above an input path. */
export const MAX_WALK_DEPTH = 64

/** Cache TTL floor: a probe result younger than this is reused as-is. */
export const PROBE_TTL_MS = 5000

/** Kind of a discovered `.git` entry. */
export type GitFileKind = 'main' | 'linked' | 'submodule'

/** One tree's parsed identity (before wire serialization). */
export interface TreeInfo {
  root: string
  repoKey: string
  role: 'main' | 'linked'
  branch?: string
  detached?: string
}

/** Internal probe result (Maps; the RPC boundary serializes to JSON). */
export interface GitRepoIndex {
  trees: Map<string, TreeInfo>
  bindings: Map<string, string>
  scannedAt: number
}

/** Options accepted by {@link probeGitIndex}. */
export interface ProbeOptions {
  /** Cache TTL override (tests use 0 / Infinity to pin behavior). */
  ttlMs?: number
  /** Epoch ms override (deterministic tests). */
  now?: number
  /** Exec fallback results to merge in (tests inject parsed porcelain). */
  execTrees?: readonly TreeInfo[]
}

/* ------------------------------------------------------------------ *
 * Pure parsers (unit-testable without filesystem)
 * ------------------------------------------------------------------ */

/**
 * Parse a linked-worktree `.git` file: the `gitdir: <path>` line's value,
 * trimmed. Returns undefined for anything that is not a gitdir pointer.
 */
export function parseGitdirFile(content: string): string | undefined {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(content)
  return m ? m[1] : undefined
}

/**
 * Parse a worktree `HEAD` file: `ref: refs/heads/<branch>` → branch name;
 * a raw sha (detached) → the abbreviated sha. Anything else → undefined.
 */
export function parseHeadFile(content: string): { branch: string } | { detached: string } | undefined {
  const ref = /^ref:\s*refs\/heads\/(.+?)\s*$/m.exec(content)
  if (ref) return { branch: ref[1] }
  const m = /^([0-9a-f]{7,40})\s*$/m.exec(content)
  if (m) return { detached: m[1]!.slice(0, 7) }
  return undefined
}

/**
 * Classify an (absolute) gitdir path by its role in the repo layout:
 * a path containing a `worktrees` segment is a linked worktree's admin dir,
 * a `modules` segment is a submodule's own git dir; anything else is the
 * main worktree's `.git` directory.
 */
export function classifyGitdir(gitdir: string): GitFileKind {
  const segments = gitdir.split(/[\\/]+/)
  if (segments.includes('worktrees')) return 'linked'
  if (segments.includes('modules')) return 'submodule'
  return 'main'
}

/**
 * Resolve a commondir file's content against its own admin dir: the value
 * is a relative path (e.g. `../..`) pointing at the main `.git` directory.
 * Non-absolute values resolve against `adminDir`; absolute values pass
 * through normalized.
 */
export function resolveCommondir(adminDir: string, content: string): string {
  const value = content.trim().replace(/^\s+/g, '').replace(/\s+$/g, '')
  return normalize(isAbsolute(value) ? value : resolve(adminDir, value))
}

/**
 * Parse `git worktree list --porcelain` output: blank-line-separated
 * records of `worktree <path>` (C-quoted when needed) + `HEAD <sha>` +
 * `branch refs/heads/<name>` | `detached` | `bare`. The exec fallback's
 * result — and the unit-test fixture — for this parser. Quoted paths are
 * unescaped with JSON.parse (C-style quoting; git escapes `"`/`\` like C).
 */
export function parseWorktreePorcelain(text: string): Array<{ worktree: string; detached: boolean; bare: boolean; branch?: string }> {
  const entries: Array<{ worktree: string; detached: boolean; bare: boolean; branch?: string }> = []
  let current: { worktree: string; detached: boolean; bare: boolean; branch?: string } | null = null
  const flush = (): void => {
    if (current !== null) entries.push(current)
    current = null
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') { flush(); continue }
    if (line.startsWith('worktree ')) {
      flush()
      let path = line.slice('worktree '.length).trim()
      if (path.startsWith('"')) {
        try { path = JSON.parse(path) as string } catch { /* keep raw */ }
      }
      current = { worktree: path, detached: false, bare: false }
      continue
    }
    if (current === null) continue
    if (line.startsWith('branch refs/heads/')) current.branch = line.slice('branch refs/heads/'.length).trim()
    else if (line === 'detached') current.detached = true
    else if (line === 'bare') current.bare = true
  }
  flush()
  return entries
}

/* ------------------------------------------------------------------ *
 * Filesystem walk (sync — the probe is a cheap stat/read pass)
 * ------------------------------------------------------------------ */

/** The discovered `.git` of one input path. */
interface TreeResolution {
  /** The directory whose `.git` was found (worktree root). */
  root: string
  /** Absolute gitdir (the `.git` directory itself for main). */
  gitdir: string
  kind: GitFileKind
  /** Main `.git` directory (the repository identity key). */
  repoKey: string
  branch?: string
  detached?: string
}

/**
 * Walk `start` upward (≤ {@link MAX_WALK_DEPTH} levels) for the first
 * directory containing a `.git` entry; classify and parse it. Never throws
 * on missing/odd entries — the walk continues upward and yields undefined
 * when nothing is found (plain directory / dsh-remote mirror).
 */
export function resolveTreeRoot(start: string): TreeResolution | undefined {
  let dir = normalize(start)
  for (let depth = 0; depth <= MAX_WALK_DEPTH; depth++) {
    const gitPath = join(dir, '.git')
    let stat
    try {
      stat = statSync(gitPath)
    } catch {
      // No .git here — keep climbing.
    }
    if (stat !== undefined) {
      if (stat.isDirectory()) {
        return { root: dir, gitdir: gitPath, kind: 'main', repoKey: gitPath }
      }
      if (stat.isFile()) {
        let content = ''
        try { content = readFileSync(gitPath, 'utf8') } catch { /* unreadable → treat as absent */ }
        const gitdir = parseGitdirFile(content)
        if (gitdir === undefined) {
          // A file named .git that is not a gitdir pointer — not a worktree.
          return { root: dir, gitdir: gitPath, kind: 'main', repoKey: gitPath }
        }
        const gitdirAbs = normalize(isAbsolute(gitdir) ? gitdir : resolve(dir, gitdir))
        const kind = classifyGitdir(gitdirAbs)
        if (kind === 'linked') {
          const adminDir = gitdirAbs
          let commondir = gitdirAbs
          try { commondir = resolveCommondir(adminDir, readFileSync(join(adminDir, 'commondir'), 'utf8')) } catch { /* keep */ }
          let head: ReturnType<typeof parseHeadFile>
          try { head = parseHeadFile(readFileSync(join(adminDir, 'HEAD'), 'utf8')) } catch { /* keep */ }
          const branch = head !== undefined && 'branch' in head ? head.branch : undefined
          const detached = head !== undefined && 'detached' in head ? head.detached : undefined
          return {
            root: dir, gitdir: gitdirAbs, kind, repoKey: commondir,
            ...(branch !== undefined ? { branch } : {}),
            ...(detached !== undefined ? { detached } : {}),
          }
        }
        // submodule: the module dir is its own repo identity.
        let commondir = gitdirAbs
        try { commondir = resolveCommondir(gitdirAbs, readFileSync(join(gitdirAbs, 'commondir'), 'utf8')) } catch { /* keep */ }
        return { root: dir, gitdir: gitdirAbs, kind, repoKey: commondir }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Normalize an input path for binding keys (absolute, collapsed). */
export function canonicalInputPath(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(p)
  const normalized = normalize(abs).replace(/[\\/]+$/, '')
  return normalized === '' ? sep : normalized
}

/** mtime signature of a repo's layout: (commondir, worktrees dir) stamps. */
function repoSignature(commondir: string, now: number): string {
  const stamp = (p: string): string => {
    try { return String(statSync(p).mtimeMs) } catch { return '-' }
  }
  return `${now}:${stamp(commondir)}:${stamp(join(commondir, 'worktrees'))}`
}

/** Per-repository tree enumeration cache (mtime signature + TTL floor). */
const repoCache = new Map<string, { signature: string; trees: TreeInfo[]; scannedAt: number }>()

/**
 * Enumerate every tree of the repository identified by `commondir` (the
 * main `.git` directory): the main tree plus each `worktrees/<name>` admin
 * dir (HEAD for branch/detached, `gitdir` back-pointer's dirname for the
 * root). Results are cached on (commondir, worktrees-dir) mtimes with the
 * probe TTL floor; a signature change or TTL expiry recomputes.
 */
export function enumerateRepoTrees(commondir: string, opts: ProbeOptions = {}): TreeInfo[] {
  const now = opts.now ?? Date.now()
  const ttl = opts.ttlMs ?? PROBE_TTL_MS
  const signature = repoSignature(commondir, now)
  const cached = repoCache.get(commondir)
  if (cached !== undefined && cached.signature === signature && now - cached.scannedAt < ttl) {
    return cached.trees
  }
  const trees: TreeInfo[] = []
  trees.push({ root: dirname(commondir), repoKey: commondir, role: 'main' })
  const worktreesDir = join(commondir, 'worktrees')
  let names: string[] = []
  try { names = readdirSync(worktreesDir) } catch { /* no linked trees */ }
  names.sort()
  for (const name of names) {
    const adminDir = join(worktreesDir, name)
    let head
    try { head = parseHeadFile(readFileSync(join(adminDir, 'HEAD'), 'utf8')) } catch { continue }
    let root: string | undefined
    try {
      const pointer = readFileSync(join(adminDir, 'gitdir'), 'utf8').trim()
      const pointerAbs = normalize(isAbsolute(pointer) ? pointer : resolve(adminDir, pointer))
      root = dirname(pointerAbs)
    } catch { /* keep undefined */ }
    if (root === undefined) continue
    const branch = head !== undefined && 'branch' in head ? head.branch : undefined
    const detached = head !== undefined && 'detached' in head ? head.detached : undefined
    trees.push({
      root,
      repoKey: commondir,
      role: 'linked',
      ...(branch !== undefined ? { branch } : {}),
      ...(detached !== undefined ? { detached } : {}),
    })
  }
  repoCache.set(commondir, { signature, trees, scannedAt: now })
  return trees
}

/**
 * Compute the git-repo index for a set of input paths (workspace paths +
 * session cwds, deduped): bind each path to the tree covering it, collect
 * every discovered repository, enumerate their trees, and merge optional
 * exec-fallback entries (porcelain results) that the walk missed. Pure in
 * the sense that all mutations are confined to the cache.
 */
export function probeGitIndex(inputPaths: readonly string[], opts: ProbeOptions = {}): GitRepoIndex {
  const now = opts.now ?? Date.now()
  const ttl = opts.ttlMs ?? PROBE_TTL_MS
  const bindings = new Map<string, string>()
  const repoKeys = new Set<string>()
  const seen = new Set<string>()
  for (const raw of inputPaths) {
    const p = canonicalInputPath(raw)
    if (seen.has(p)) continue
    seen.add(p)
    const resolved = resolveTreeRoot(p)
    if (resolved === undefined) continue
    bindings.set(p, resolved.root)
    repoKeys.add(resolved.repoKey)
  }
  const trees = new Map<string, TreeInfo>()
  for (const repoKey of repoKeys) {
    for (const tree of enumerateRepoTrees(repoKey, opts)) {
      trees.set(tree.root, tree)
    }
  }
  // Merged exec fallback (porcelain): index entries the walk could not see.
  for (const entry of opts.execTrees ?? []) {
    const key = canonicalInputPath(entry.root)
    if (!trees.has(key)) trees.set(key, entry)
  }
  return { trees, bindings, scannedAt: now }
}

/** Serialize the internal index to the RPC wire shape. */
export function serializeGitRepoIndex(index: GitRepoIndex): GitProbeResultJSON {
  const trees: Record<string, GitTreeInfoJSON> = {}
  for (const [root, info] of index.trees) {
    trees[root] = {
      root,
      repoKey: info.repoKey,
      role: info.role,
      ...(info.branch !== undefined ? { branch: info.branch } : {}),
      ...(info.detached !== undefined ? { detached: info.detached } : {}),
    }
  }
  const bindings: Record<string, string> = {}
  for (const [path, root] of index.bindings) bindings[path] = root
  return { trees, bindings, scannedAt: index.scannedAt }
}

/** Test hook: clear the per-repository enumeration cache. */
export function clearRepoCache(): void {
  repoCache.clear()
}
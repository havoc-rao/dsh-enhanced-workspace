/**
 * Wire names and JSON shapes of the plugin's git-probe domain: the
 * Connection RPC endpoint literal plus the serialized git-repo index the
 * host half produces and the browser consumes. Shared by both halves — the
 * host registers the endpoint and the browser calls it, one spelling keeps
 * the two from drifting silently. The browser-side model functions
 * (`bindSessionTrees` / subworkspace grouping) consume exactly this shape.
 * @module dsh-enhanced-workspace/shared/git
 */

/** Channel-relative endpoint computing the git-repo index from a path list.
 *  The payload is `{ paths: string[] }` (workspace paths + session cwds,
 *  deduped); the result is a {@link GitProbeResultJSON}. */
export const GIT_PROBE_ENDPOINT = 'git/probe' as const

/** Role of a tree relative to its repository (how the `.git` was found). */
export type GitTreeRoleJSON = 'main' | 'linked'

/**
 * One tree of a repository: its canonical root, the repository identity key
 * (the canonical main `.git` directory path — shared by every tree of the
 * repo), and the branch / detached head read from the tree's HEAD file.
 */
export interface GitTreeInfoJSON {
  /** Canonical (normalized, absolute) tree root. */
  root: string
  /** Repository identity key: the canonical main `.git` directory path. */
  repoKey: string
  /** main = directly holds `.git/`; linked = `.git` file into worktrees/. */
  role: GitTreeRoleJSON
  /** HEAD ref basename (e.g. `feat/x`); absent when detached. */
  branch?: string
  /** First 7 chars of the detached HEAD sha; absent when on a branch. */
  detached?: string
}

/**
 * The host's git probe result, serialized for the wire: every tree of every
 * discovered repository and the input-path → tree-root bindings (an input
 * path absent from `bindings` has no git tree above it — plain directory or
 * a dsh-remote mirror, whose sync ignores `.git`).
 */
export interface GitProbeResultJSON {
  /** tree root (canonical absolute path) → tree info. */
  trees: Record<string, GitTreeInfoJSON>
  /** each probed input path (canonical) → the tree root covering it. */
  bindings: Record<string, string>
  /** Epoch ms of the scan (cache freshness marker). */
  scannedAt: number
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether `value` is one structurally sound tree info record. */
export function isGitTreeInfoJSON(value: unknown): value is GitTreeInfoJSON {
  if (!isPlainRecord(value)) return false
  if (typeof value.root !== 'string' || value.root === '') return false
  if (typeof value.repoKey !== 'string' || value.repoKey === '') return false
  if (value.role !== 'main' && value.role !== 'linked') return false
  const { branch, detached } = value
  if (branch !== undefined && typeof branch !== 'string') return false
  if (detached !== undefined && typeof detached !== 'string') return false
  return true
}

/**
 * Whether `value` is a structurally sound {@link GitProbeResultJSON}: trees
 * keyed by their own root, bindings keyed by canonical input paths, every
 * referenced tree root present in `trees`.
 * @param value - candidate probe result (any JSON value).
 * @returns whether every structural check passes.
 */
export function isGitProbeResultJSON(value: unknown): value is GitProbeResultJSON {
  if (!isPlainRecord(value)) return false
  if (typeof value.scannedAt !== 'number' || !Number.isFinite(value.scannedAt)) return false
  if (!isPlainRecord(value.trees)) return false
  for (const [key, entry] of Object.entries(value.trees)) {
    if (!isGitTreeInfoJSON(entry) || entry.root !== key) return false
  }
  if (!isPlainRecord(value.bindings)) return false
  for (const [path, treeRoot] of Object.entries(value.bindings)) {
    if (path === '' || typeof treeRoot !== 'string') return false
    if (value.trees[treeRoot] === undefined) return false
  }
  return true
}
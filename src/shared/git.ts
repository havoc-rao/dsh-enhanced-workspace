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

/** Same-origin HTTP endpoint of the dsh-remote host half: the workspace git
 *  marker of a remote-mirror workspace. `?local=<abs mirror path>` (any path
 *  INSIDE a mirror resolves to its owning mirror) returns
 *  `{ ok: true, marker: RemoteGitMarker | null }` — marker null = the local
 *  path is not a remote mirror (plain local workspace). The endpoint TTL-
 *  caches per (machine, remote dir); `?refresh=1` bypasses. Credential /
 *  registry / transport failures surface as HTTP 500/501 + `{ error,
 *  credential }` — the caller degrades to "no marker" silently. */
export const REMOTE_GIT_WORKSPACE_PATH = '/dsh-remote/git-workspace' as const

/** Role of a tree relative to its repository (how the `.git` was found).
 *  `remote` = a VIRTUAL tree synthesized by the client from a dsh-remote
 *  git-workspace marker (a mirror workspace whose LOCAL `.git` does not
 *  exist); the host half never produces it. */
export type GitTreeRoleJSON = 'main' | 'linked' | 'remote'

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
  if (value.role !== 'main' && value.role !== 'linked' && value.role !== 'remote') return false
  const { branch, detached } = value
  if (branch !== undefined && typeof branch !== 'string') return false
  if (detached !== undefined && typeof detached !== 'string') return false
  return true
}

/** The owning remote machine of a workspace marker (from the dsh-remote
 *  machine registry; null when the endpoint routed through the shared pool
 *  without a saved record — the `?local=` path always resolves one). */
export interface RemoteGitMachineJSON {
  id: string
  name: string
  host: string
  port: number
  username: string
}

/** The workspace git marker of a remote-mirror workspace, as served by
 *  `GET /dsh-remote/git-workspace` (dsh-remote host half). One compact
 *  snapshot of the REMOTE repo: branch (or detached short sha), dirty /
 *  staged counts, upstream sync state, the remote canonical root, and the
 *  owning machine. Count fields are absent on the `isRepo: false` variant
 *  (a remote dir that is not a git repository) — consumers read them as 0.
 */
export interface RemoteGitMarker {
  /** Whether the remote dir is a git repository (false is NOT an error). */
  isRepo: boolean
  /** HEAD ref basename on the remote (e.g. `dev`); absent when detached. */
  branch?: string
  /** Short detached HEAD sha; absent when on a branch. */
  detached?: string
  /** Porcelain entry count of `git status` (all changes incl. untracked). */
  dirty?: number
  /** Porcelain entries whose index column is a staged change. */
  staged?: number
  /** Commits ahead of the upstream tracking ref. */
  ahead?: number
  /** Commits behind the upstream tracking ref. */
  behind?: number
  /** Upstream tracking ref (e.g. `origin/dev`); absent without one. */
  upstream?: string
  /** Upstream ref deleted remotely. */
  gone?: boolean
  /** Canonical remote repo top level (empty when `isRepo` is false). */
  root: string
  /** The remote directory this workspace mirrors. */
  remotePath: string
  /** Owning machine (null only on pool-routed calls — never for `?local=`). */
  machine: RemoteGitMachineJSON | null
  /** The local mirror directory (null on `?path=` calls). */
  mirrorDir: string | null
  /** Epoch ms of the remote snapshot. */
  at: number
}

/** The wire body of `GET /dsh-remote/git-workspace`: `ok: true` plus the
 *  marker (null = the given local path is not a remote mirror). */
export interface RemoteGitWorkspaceResponse {
  ok: true
  marker: RemoteGitMarker | null
}

function isCountNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Whether `value` is a structurally sound remote machine record. */
export function isRemoteGitMachineJSON(value: unknown): value is RemoteGitMachineJSON {
  if (value === null || !isPlainRecord(value)) return false
  return typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.host === 'string'
    && isCountNumber(value.port)
    && typeof value.username === 'string'
}

/** Whether `value` is a structurally sound {@link RemoteGitMarker} (both the
 *  `isRepo: true` and `isRepo: false` variants). */
export function isRemoteGitMarker(value: unknown): value is RemoteGitMarker {
  if (!isPlainRecord(value)) return false
  if (value.isRepo !== true && value.isRepo !== false) return false
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return false
  if (typeof value.root !== 'string') return false
  if (typeof value.remotePath !== 'string' || value.remotePath === '') return false
  if (value.mirrorDir !== null && typeof value.mirrorDir !== 'string') return false
  if (value.machine !== null && !isRemoteGitMachineJSON(value.machine)) return false
  if (value.isRepo === false) return true
  // Repo variant: branch or detached label plus the count fields.
  const { branch, detached, upstream, gone } = value
  if (branch !== undefined && typeof branch !== 'string') return false
  if (detached !== undefined && typeof detached !== 'string') return false
  if (upstream !== undefined && typeof upstream !== 'string') return false
  if (gone !== undefined && typeof gone !== 'boolean') return false
  if (branch === undefined && detached === undefined) return false
  for (const key of ['dirty', 'staged', 'ahead', 'behind']) {
    if (value[key] !== undefined && !isCountNumber(value[key])) return false
  }
  return true
}

/** Whether `value` is a structurally sound {@link RemoteGitWorkspaceResponse}. */
export function isRemoteGitWorkspaceResponse(value: unknown): value is RemoteGitWorkspaceResponse {
  if (!isPlainRecord(value)) return false
  if (value.ok !== true) return false
  return value.marker === null || isRemoteGitMarker(value.marker)
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
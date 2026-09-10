/**
 * Remote-mirror git markers of the enhanced workspace browser: the fetch
 * layer consuming the dsh-remote host-half endpoint
 * `GET /dsh-remote/git-workspace?local=<mirror path>` (same origin — the
 * browser half fetches it directly, exactly like dsh-remote's own client),
 * and the pure merge layer that overlays the returned markers onto the
 * local git probe as VIRTUAL remote trees.
 *
 * Why an overlay: a mirror workspace's local directory has no `.git`
 * (mirror sync ignores it), so the host's `git/probe` (`.git` upward walk)
 * reports "no git" for it. The marker carries what the probe cannot see —
 * the REMOTE repo's branch, dirty/staged counts and upstream sync. The
 * merge injects one virtual tree (`role: 'remote'`, root namespaced per
 * owning machine) plus bindings from every probed path inside the mirror,
 * so ALL existing derivations (row aggregate, subworkspace groups, repo
 * grouping, unregistered trees, search) work on remote workspaces without
 * renderer branching; the marker detail map additionally feeds the remote
 * row pill (`⎇ branch ·N`) and the hover card's remote section.
 *
 * Failure posture (task contract): every failure — transport, credential /
 * registry (HTTP 500/501), non-mirror (`marker: null`), `isRepo: false`,
 * malformed body — degrades to "no marker" silently. Markers are
 * decoration: they never block or error the workspace browser. Fetch
 * results are memoized per normalized path with a TTL (`?refresh=1`
 * bypasses both the client memo and the endpoint cache).
 * @module dsh-enhanced-workspace/client/remote-git
 */

import {
  isRemoteGitWorkspaceResponse,
  REMOTE_GIT_WORKSPACE_PATH,
  type GitProbeResultJSON,
  type GitTreeInfoJSON,
  type RemoteGitMarker,
  type RemoteGitMachineJSON,
} from '../shared/git.ts'
import { normalizeProbePath } from './git-model.ts'

/* ------------------------------------------------------------------ *
 * Pure marker → tree / presentation layer (unit-testable, no I/O)
 * ------------------------------------------------------------------ */

/**
 * The virtual tree identity of a remote marker: a namespaced root that
 * can never collide with a local canonical path and keeps distinct owning
 * machines apart (`remote:<machineTag>:<remotePath>`). Consumers only
 * ever show its basename, so the namespace is invisible in the UI.
 */
export function remoteTreeRoot(marker: RemoteGitMarker): string {
  const machine = marker.machine
  const tag = machine === null
    ? 'any'
    : (machine.id !== '' ? machine.id : `${machine.host}:${machine.port}:${machine.username}`)
  return `remote:${tag}:${marker.remotePath}`
}

/**
 * Convert a remote marker into the virtual tree the overlay injects:
 * `undefined` for `isRepo: false` markers (a remote non-repo dir is "no
 * git" — same fallback as a local plain directory) or markers without any
 * branch/detached label. The tree's `repoKey` equals its root: every
 * mirror maps 1:1 to its own virtual tree, so peers / "在目标树继续"
 * (which filter by `repoKey`) never surface remote entries.
 */
export function remoteTreeInfo(marker: RemoteGitMarker): GitTreeInfoJSON | undefined {
  if (marker.isRepo !== true) return undefined
  const branch = marker.branch === undefined || marker.branch === '' ? undefined : marker.branch
  const detached = marker.detached === undefined || marker.detached === '' ? undefined : marker.detached
  if (branch === undefined && detached === undefined) return undefined
  const root = remoteTreeRoot(marker)
  return {
    root,
    repoKey: root,
    role: 'remote',
    ...(branch !== undefined ? { branch } : {}),
    ...(detached !== undefined ? { detached } : {}),
  }
}

/**
 * Overlay remote markers onto the local probe result: for every probed
 * path covered by a repo marker (exact match, or the LONGEST marker key
 * that is a path prefix of it — a session cwd inside a mirror binds even
 * when the caller only fetched the mirror-root paths), inject the virtual
 * remote tree and bind the path to it (REPLACING a stale local binding —
 * a mirror's `.git` walk result is never authoritative for the remote
 * state). Returns the SAME probe reference when nothing changes (no
 * markers, no repo markers), so React memoization stays intact. `null`
 * probe stays `null` — markers extend the local git layer, they never
 * substitute for it.
 * @param probe - host `git/probe` result (may be null = layer unavailable).
 * @param markers - normalized local path → repo marker (from the fetch
 *  layer; `isRepo: false` markers never enter the map).
 * @param paths - every path the probe was asked about (workspace paths +
 *  session cwds): interior mirror paths resolve through their bindings too.
 */
export function overlayRemoteMarkers(
  probe: GitProbeResultJSON | null,
  markers: ReadonlyMap<string, RemoteGitMarker>,
  paths: readonly string[],
): GitProbeResultJSON | null {
  if (probe === null || markers.size === 0) return probe
  // Longest marker key first: an exact match and the deepest covering
  // mirror root both resolve to the marker; unrelated paths skip below.
  const mirrorRoots = [...markers.keys()].sort((a, b) => b.length - a.length)
  let trees: Record<string, GitTreeInfoJSON> | undefined
  let bindings: Record<string, string> | undefined
  for (const raw of paths) {
    const path = normalizeProbePath(raw)
    const marker = mirrorRoots.find(key => path === key || path.startsWith(`${key}/`))
    if (marker === undefined) continue
    const info = markers.get(marker)
    if (info === undefined) continue
    const tree = remoteTreeInfo(info)
    if (tree === undefined) continue
    trees ??= { ...probe.trees }
    bindings ??= { ...probe.bindings }
    trees[tree.root] = tree
    bindings[path] = tree.root
  }
  return trees === undefined ? probe : { ...probe, trees, bindings: bindings ?? probe.bindings }
}

/** The dirty count of a marker (0 for the `isRepo: false` variant). */
export function remoteDirtyCount(marker: RemoteGitMarker): number {
  return marker.isRepo === true ? marker.dirty ?? 0 : 0
}

/** The staged count of a marker (0 when absent). */
export function remoteStagedCount(marker: RemoteGitMarker): number {
  return marker.isRepo === true ? marker.staged ?? 0 : 0
}

/** The pill/hover label of a remote marker: branch or detached short sha. */
export function remoteBranchLabel(marker: RemoteGitMarker): string {
  return marker.branch ?? marker.detached ?? ''
}

/** Tooltip of the remote pill: `⎇ branch · N (M staged) · ↑ahead ↓behind`
 *  — the same summary dsh-remote's own chip shows. */
export function remotePillTitle(marker: RemoteGitMarker): string {
  const label = remoteBranchLabel(marker)
  const parts = [`⎇ ${label}`]
  const dirty = remoteDirtyCount(marker)
  const staged = remoteStagedCount(marker)
  if (dirty > 0) parts.push(`· ${dirty}${staged > 0 ? ` (${staged} staged)` : ''}`)
  const sync: string[] = []
  if (marker.upstream !== undefined && marker.upstream !== '') {
    if ((marker.ahead ?? 0) > 0) sync.push(`↑${marker.ahead}`)
    if ((marker.behind ?? 0) > 0) sync.push(`↓${marker.behind}`)
  }
  if (sync.length > 0) parts.push(`· ${sync.join(' ')}`)
  return parts.join(' ')
}

/** Human label of the owning machine: `user@host[:port]` (port omitted at
 *  the default 22). */
export function remoteMachineLabel(machine: RemoteGitMachineJSON | null): string {
  if (machine === null) return ''
  const at = `${machine.username}@${machine.host}`
  return Number(machine.port) === 22 || Number(machine.port) === 0 ? at : `${at}:${machine.port}`
}

/* ------------------------------------------------------------------ *
 * Fetch layer: per-path memo + TTL + in-flight dedupe, never throws
 * ------------------------------------------------------------------ */

/** The browser-side face of the remote git markers. */
export interface RemoteGitSource {
  /** Fetch repo markers for the given local paths (memoized; a path whose
   *  marker is null — not a mirror — is memoized as absent too). Resolves
   *  a map of normalized path → repo marker; never rejects. */
  fetchMarkers(paths: readonly string[]): Promise<ReadonlyMap<string, RemoteGitMarker>>
  /** Same, bypassing the memo AND the endpoint cache (`?refresh=1`). */
  refresh(paths: readonly string[]): Promise<ReadonlyMap<string, RemoteGitMarker>>
}

/** Cache TTL of one fetched marker (mirrors dsh-remote's own client). */
export const REMOTE_GIT_MARKER_TTL_MS = 5000

/** Cache entry cap (oldest evicted). */
export const REMOTE_GIT_MARKER_MAX = 128

interface MarkerCacheEntry {
  at: number
  promise: Promise<RemoteGitMarker | null>
}

export interface RemoteGitSourceOptions {
  /** Marker cache TTL override (tests pin behavior). */
  ttlMs?: number
}

/**
 * Create the remote-marker fetch source: one memoized queue per instance,
 * one HTTP GET per distinct path (sequential within one batch — the
 * endpoint TTL-caches server-side, mounts re-querying within 5s are cheap).
 * @param fetcher - injected `fetch` (tests stub it; defaults to the global).
 */
export function createRemoteGitSource(
  fetcher: (input: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }> = (input, init) => fetch(input, init),
  options: RemoteGitSourceOptions = {},
): RemoteGitSource {
  const ttlMs = options.ttlMs ?? REMOTE_GIT_MARKER_TTL_MS
  const cache = new Map<string, MarkerCacheEntry>()

  const fetchOne = (path: string, refresh: boolean): Promise<RemoteGitMarker | null> => {
    const key = normalizeProbePath(path)
    if (key === '') return Promise.resolve(null)
    const hit = cache.get(key)
    if (!refresh && hit !== undefined && Date.now() - hit.at < ttlMs) return hit.promise
    const params = new URLSearchParams()
    params.set('local', key)
    if (refresh) params.set('refresh', '1')
    const promise = fetcher(`${REMOTE_GIT_WORKSPACE_PATH}?${params.toString()}`, { method: 'GET' })
      .then(async (response) => {
        if (!response.ok) {
          // 500/501: credential-less / offline machine, machine not saved,
          // registry trouble — silent degrade to "no marker".
          console.warn(`dsh-enhanced-workspace: git-workspace marker unavailable (HTTP ${response.status}) for ${key}`)
          return null
        }
        let body: unknown
        try { body = await response.json() } catch {
          console.warn(`dsh-enhanced-workspace: git-workspace marker body is not JSON for ${key}`)
          return null
        }
        if (!isRemoteGitWorkspaceResponse(body)) {
          console.warn(`dsh-enhanced-workspace: git-workspace marker shape mismatch for ${key}`)
          return null
        }
        const marker = body.marker
        // marker null = not a mirror; isRepo:false = remote non-repo —
        // both are "no git state" (absent from the returned map).
        return marker !== null && marker.isRepo === true ? marker : null
      })
      .catch((error: unknown) => {
        console.warn(`dsh-enhanced-workspace: git-workspace marker fetch failed for ${key}`, error)
        return null
      })
    if (cache.size >= REMOTE_GIT_MARKER_MAX) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, { at: Date.now(), promise })
    return promise
  }

  const collect = async (paths: readonly string[], refresh: boolean): Promise<ReadonlyMap<string, RemoteGitMarker>> => {
    const out = new Map<string, RemoteGitMarker>()
    for (const raw of paths) {
      const key = normalizeProbePath(raw)
      if (key === '' || out.has(key)) continue
      const marker = await fetchOne(raw, refresh)
      if (marker !== null) out.set(key, marker)
    }
    return out
  }

  return {
    fetchMarkers: paths => collect(paths, false),
    refresh: paths => collect(paths, true),
  }
}
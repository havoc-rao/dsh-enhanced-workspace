/**
 * Pure client data plane of the git-worktree domain: consume the host's
 * probe result (`GitProbeResultJSON`, see `src/shared/git.ts`) and derive
 * the session-level tree bindings, the per-workspace tree aggregation
 * (single-tree pill / cross-tree count / none), the subworkspace grouping
 * (own tree vs. linked trees vs. no-git), and the unregistered-tree set.
 *
 * Design anchor (v3, docs/plan/2026-09-10): tree ownership is a SESSION
 * property — `session.cwd` → tree via the probe bindings; a workspace row
 * only summarizes its sessions' trees. Plain directories and dsh-remote
 * mirrors (whose sync ignores `.git`) simply have no binding and render the
 * default no-git form. Every function here is side-effect free.
 * @module dsh-enhanced-workspace/client/git-model
 */

import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import type { GitProbeResultJSON, GitTreeInfoJSON } from '../shared/git.ts'

/** Normalize a path for binding lookups (browser-safe, no node:path). */
export function normalizeProbePath(p: string): string {
  const collapsed = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '')
  return collapsed === '' ? '/' : collapsed
}

/** The tree covering one cwd, per the probe bindings; undefined = no git. */
export function treeOfCwd(index: GitProbeResultJSON, cwd: string | undefined): GitTreeInfoJSON | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const treeRoot = index.bindings[normalizeProbePath(cwd)]
  return treeRoot === undefined ? undefined : index.trees[treeRoot]
}

/** Session → tree binding: every session's cwd resolves to its tree (or none). */
export function bindSessionTrees(
  sessions: readonly { readonly id: SessionId; readonly cwd?: string }[],
  index: GitProbeResultJSON,
): ReadonlyMap<SessionId, GitTreeInfoJSON> {
  const out = new Map<SessionId, GitTreeInfoJSON>()
  for (const session of sessions) {
    const tree = treeOfCwd(index, session.cwd)
    if (tree !== undefined) out.set(session.id, tree)
  }
  return out
}

/** Stable identity of a tree inside a repo (branch/detached + root). */
export function treeKey(tree: GitTreeInfoJSON): string {
  return `${tree.branch ?? tree.detached ?? ''}@${tree.root}`
}

/**
 * The distinct trees a workspace's sessions sit in, in first-encounter
 * order (the aggregation source for the row pill: 0 → no pill, 1 → the
 * tree's pill, >1 → a "n 棵" count).
 */
export function sessionsTrees(
  sessions: readonly { readonly id: SessionId; readonly cwd?: string }[],
  index: GitProbeResultJSON,
): GitTreeInfoJSON[] {
  const seen = new Set<string>()
  const out: GitTreeInfoJSON[] = []
  for (const session of sessions) {
    const tree = treeOfCwd(index, session.cwd)
    if (tree === undefined) continue
    const key = treeKey(tree)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tree)
  }
  return out
}

/** One subworkspace group: the sessions sharing one tree (or no tree). */
export interface SubworkspaceGroup {
  /** Group key: 'own' (cwd under the workspace's own tree), a branch /
   *  detached name (linked tree), or 'nogit' (no tree). */
  key: string
  tree: GitTreeInfoJSON | undefined
  /** Whether the group's tree is the workspace's own tree. */
  own: boolean
  sessionIds: SessionId[]
}

/**
 * Group a workspace's sessions by their cwd's tree (v3 subworkspace):
 * sessions with no git tree → the `nogit` group; sessions under the
 * workspace's own tree → the `own` group (labelled "本工作区" upstream);
 * sessions in a DIFFERENT tree → one group per branch/detached. The
 * renderer flattens single-group results (no group headers at all), so
 * ordinary single-tree workspaces keep the built-in shape.
 * @param workspacePath - the workspace's registered path.
 * @param sessions - the workspace's sessions.
 * @param index - host probe result.
 * @returns groups in first-encounter order.
 */
export function deriveSubworkspaceGroups(
  workspacePath: string,
  sessions: readonly { readonly id: SessionId; readonly cwd?: string }[],
  index: GitProbeResultJSON,
): SubworkspaceGroup[] {
  const ownTree = treeOfCwd(index, workspacePath)
  const groups = new Map<string, SubworkspaceGroup>()
  const push = (key: string, tree: GitTreeInfoJSON | undefined, sessionId: SessionId): void => {
    let group = groups.get(key)
    if (group === undefined) {
      group = { key, tree, own: key === 'own', sessionIds: [] }
      groups.set(key, group)
    }
    group.sessionIds.push(sessionId)
  }
  for (const session of sessions) {
    const tree = treeOfCwd(index, session.cwd)
    if (tree === undefined) {
      push('nogit', undefined, session.id)
      continue
    }
    const sameTree = ownTree !== undefined && treeKey(tree) === treeKey(ownTree)
    push(sameTree ? 'own' : (tree.branch ?? tree.detached ?? 'own'), tree, session.id)
  }
  return [...groups.values()]
}

/**
 * The workspace aggregate pill state from its sessions' trees.
 * `none` → no pill (no git anywhere); `single` → one tree; `multi` → count.
 */
export type WorkspaceTreeAggregate =
  | { kind: 'none' }
  | { kind: 'single'; tree: GitTreeInfoJSON }
  | { kind: 'multi'; trees: GitTreeInfoJSON[] }

/** Aggregate the tree information of a workspace's sessions (row pill rule). */
export function aggregateWorkspaceTrees(
  sessions: readonly { readonly id: SessionId; readonly cwd?: string }[],
  index: GitProbeResultJSON,
): WorkspaceTreeAggregate {
  const trees = sessionsTrees(sessions, index)
  if (trees.length === 0) return { kind: 'none' }
  if (trees.length === 1) return { kind: 'single', tree: trees[0]! }
  return { kind: 'multi', trees }
}

/**
 * Trees the probe knows but NO input path binds to — worktrees created
 * outside DSH (or workspaces deleted since): the "未注册工作树" set.
 * @param index - host probe result.
 * @param referencedPaths - workspace paths + session cwds (any joined shape).
 */
export function unregisteredTrees(
  index: GitProbeResultJSON,
  referencedPaths: readonly string[],
): GitTreeInfoJSON[] {
  const referenced = new Set(referencedPaths.map(p => normalizeProbePath(p)))
  const bound = new Set<string>()
  for (const [path, treeRoot] of Object.entries(index.bindings)) {
    bound.add(treeRoot)
    // A binding whose key is a strict prefix of a referenced path counts the
    // reference as covered even when the host normalized differently.
    for (const ref of referenced) {
      if (ref.startsWith(path + '/') || path === ref) {
        bound.add(treeRoot)
        break
      }
    }
  }
  return Object.values(index.trees).filter(tree => !bound.has(tree.root))
}

/** All input paths bound to a tree, keyed by tree root (for reverse lookup). */
export function treesByWorkspace(
  index: GitProbeResultJSON,
  workspacePaths: readonly { readonly workspaceId: WorkspaceId; readonly path: string }[],
): Map<string, WorkspaceId[]> {
  const out = new Map<string, WorkspaceId[]>()
  for (const workspace of workspacePaths) {
    const tree = treeOfCwd(index, workspace.path)
    if (tree === undefined) continue
    const list = out.get(tree.root) ?? []
    list.push(workspace.workspaceId)
    out.set(tree.root, list)
  }
  return out
}
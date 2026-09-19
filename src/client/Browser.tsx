/**
 * The enhanced workspace/session browsing region: section header (title +
 * view options + add workspace + search), the recency module, the folder
 * forest (or the flat list), and the session rows. This component is the
 * shadowing occupant of `sidebar.workspaces`; all data arrives through the
 * framework hooks and the store seat, all Host actions through the inject
 * face.
 *
 * Interaction semantics mirror the built-in browser: a workspace row collects
 * its sessions (click toggles the list, the plus button starts a New Session,
 * the ellipsis menu renames / moves / deletes the Workspace), and folder rows
 * wrap workspaces into multi-level directories (new subfolder / rename /
 * move / delete with child promotion). Icons are the ui-primitives outline
 * set — no emoji or text glyphs.
 *
 * Indent guides (VSCode-style, ported from the better-sidebar FileTree):
 * rows paint a 1px vertical guide line under every ancestor folder at that
 * ancestor's icon column (inline background gradients — see
 * `guideBackground`), with a horizontal corner on expanded folder rows —
 * and on workspace rows while their session list is open — so the folder
 * structure reads at a glance. Each ancestor stroke is also a CLICK TARGET
 * (`guideHitBands`): hovering a row reveals a small band over every
 * ancestor column, the band under the pointer lights up together with the
 * ancestor's WHOLE vertical line across its visible subtree, and clicking
 * it collapses that ancestor — from any descendant row, so a folder full of
 * expanded subfolders folds without scrolling to find the folder rows.
 * Session rows hang off their workspace the way files hang off a directory:
 * they draw all folder strokes plus the workspace's own column, and its
 * band quickly collapses the session list. The folder tree has no
 * collapsible root: the guide columns cover exactly the real ancestors
 * (the 8px indent grid), unlike the file tree's root-anchored columns.
 * @module dsh-enhanced-workspace/client/Browser
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react'
import {
  HoverCard,
  IconArchiveOutline20,
  IconBranchOutline16,
  IconChevronUpOutline14,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconFolderClose16,
  IconFolderOpen16,
  IconFolderOpenOutline16,
  IconPersonalizationOutline16,
  IconPlusOutline16,
  IconProjectAddOutline16,
  IconSearchOutline16,
  IconTrashOutline16,
  IconTriangleRightFill14,
  Menu,
  StateDot,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { MenuEntry, StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import {
  DIRECTORY_FLOW_SLOT,
  SEARCH_GLOBAL_KEY,
  SEARCH_INPUT_SELECTOR,
  SEARCH_RAIL_BUTTON_SELECTOR,
  SEARCH_SLOT,
  installSearchHandle,
  type EnhancedDirectoryFlowOwnerProps,
  type EnhancedSearchOwnerProps,
  type EnhancedWorkspaceBrowserProps,
  type EnhancedWorkspaceGlobal,
} from './contract.ts'
// Type-only (erased — never reaches the purity gate): the optional
// fileTreeUi v2 client service provided by dsh-file-tree-ui (v2 = the
// provider owns the tree FRAMEWORK — container/subtrees/guides/chevron
// interaction/fold animations/row chrome; the consumer injects per-row
// content + expansion state data via FileTreeRowModel). The value arrives
// through the `useFileTreeUi` selector hook (snapshot of the
// `ctx.get('fileTreeUi')` service); when undefined every row falls back to
// this module's built-in rendering.
import type { FileTreeRowModel, FileTreeNode, FileTreeUiServiceV2 } from 'dsh-file-tree-ui/client-contract'
import {
  folderDropZone,
  resolveFolderDrop,
  resolveWorkspaceDrop,
  rowDropZone,
  type DragSource,
  type DropTarget,
  type DropZone,
} from './drag.ts'
import {
  ConfirmDialog,
  InputDialog,
  MoveToDialog,
  folderErrorMessage,
  type ConfirmDialogState,
  type InputDialogState,
  type MoveToDialogState,
} from './Dialogs.tsx'
import { SessionHoverContent, WorkspaceHoverContent, workspaceStatusLabel } from './HoverCards.tsx'
import {
  deriveFlat,
  deriveFolderForest,
  deriveRecentWorkspaces,
  dirActive,
  filterFlatByQuery,
  filterForestByQuery,
  folderOfWorkspace,
  observeSessionActivity,
  orderDeltas,
  pendingInteractionOf,
  RECENT_GROUP_KEY_PREFIX,
  referenceSessionOf,
  sessionPendingInteractionsOf,
  sessionStatusDot,
  treeOrder,
  workspaceSessionStatus,
  ROOT_FOLDER_ID,
  UNGROUPED_KEY,
  type FolderId,
  type FolderNode,
  type SessionGroupBy,
  type SessionNode,
  type SessionPendingInteractions,
  type WorkspaceLeaf,
} from './model.ts'
import {
  aggregateWorkspaceTrees,
  basename,
  deriveRepoGroups,
  deriveSubworkspaceGroups,
  normalizeProbePath,
  treeOfCwd,
  unregisteredTrees,
  type GitRepoGroupDerived,
} from './git-model.ts'
import { overlayRemoteMarkers } from './remote-git.ts'
import {
  WORKSPACE_REFERENCE_MIME,
  encodeDragReference,
  sessionReferencePayload,
  stashActiveReference,
  workspaceReferencePayload,
} from './reference.ts'
import type { GitProbeResultJSON, GitTreeInfoJSON, RemoteGitMarker } from '../shared/git.ts'
import { FLAT_SESSION_ORDER_KEY } from './store.ts'
import type { EnhancedWorkspaceState } from './store.ts'
import css from './Browser.module.css'

/** Recency-module row budget: only the five most recently queried dirs. */
const RECENTS_LIMIT = 5
/** Session rows visible per Workspace before the local overflow control. */
const COLLAPSED_SESSION_LIMIT = 5
/** Rail→wide slide duration (the shell's AppFrame track transition); a rail
 *  search click lands the input focus only after the slide completes. */
const EXPAND_SLIDE_MS = 300
/** Folder-tree indent: 8px base (built-in 8px row-cell parity) + 8px per level. */
const FOLDER_INDENT_BASE_PX = 8
const FOLDER_INDENT_STEP_PX = 8
/** Session rows under a workspace: workspace indent + this offset (title-column delta, 32px vs 12px before unification). */
const SESSION_INDENT_OFFSET_PX = 20

/** Left inset for one tree row: 8px base + 8px per ancestor folder level. */
function rowIndent(ancestorFolderCount: number): number {
  return FOLDER_INDENT_BASE_PX + ancestorFolderCount * FOLDER_INDENT_STEP_PX
}

/** The indent-guide stroke: the app's border token slightly faded (the
 *  repo's color-mix pattern), the visual weight of VSCode's guide lines —
 *  clearly visible but quieter than the row dividers. (Mirror of the
 *  better-sidebar FileTree guide, re-geometried to this tree's 8px step.) */
export const GUIDE_STROKE = 'color-mix(in srgb, var(--dsw-alias-border-l1, rgba(128, 128, 128, 0.35)) 70%, transparent)'

/** The guide stroke while its column is hovered: the ancestor's WHOLE
 *  vertical line lights up (every row in its visible subtree paints this
 *  stroke at the same column — see the highlightCol parameter below). A
 *  strong accent so the full "collapse target" line reads at a glance. The
 *  band's ::before stroke in Browser.module.css mirrors this look — keep the
 *  two in sync. */
export const GUIDE_STROKE_HOVER = 'color-mix(in srgb, var(--dsw-alias-interactive-bg-hover-accent, #4c8dff) 80%, transparent)'

/** Half-width of the clickable band around each guide stroke, in px. The
 *  stroke itself is 1px; the band (2 × this) sits on the 8px column grid so
 *  neighbor bands touch without overlapping (columns are exactly 8px apart),
 *  and the deepest band's outside edge stops 3.5px short of the row's
 *  content — the band never overlaps the chevron or glyph. */
const GUIDE_HIT_HALF = 4

/**
 * One row's indent-guide background layer set: a 1px vertical stroke under
 * every ancestor folder at that ancestor's icon column (column k sits at
 * `8 + 8k` — the same grid as the rows' own indents, so each stroke aligns
 * with the folder row that owns that level), plus — on expanded rows
 * (folders, and workspaces with their session list open) — the horizontal
 * corner segment joining the deepest ancestor stroke to the row's icon (the
 * "├─" joint) WITH the vertical trunk at the row's own column continuing
 * below that corner, so the subtree's stroke starts flush with the joint.
 * Collapsed rows keep just the verticals, so the folder structure reads at
 * a glance exactly like the VSCode explorer.
 *
 * Neighboring rows decide where strokes stop: a row at ancestor-count A
 * draws only the A ancestor columns, so the first shallower sibling below a
 * subtree simply has no stroke for it — each guide ends flush at its
 * subtree's last row, never dangling into empty space.
 *
 * `highlightCol`: when a guide band is hovered, the ancestor's whole line
 * lights up — every row carrying that column's stroke paints it in the
 * hover stroke instead (2px, centered on the 1px guide).
 *
 * The style is applied inline as background longhands (never the `background`
 * shorthand): the shorthand would claim `background-color`, which the
 * stylesheet's row fill and hover fill own.
 */
export function guideBackground(ancestorCount: number, isOpenDir: boolean, highlightCol?: number): CSSProperties {
  if (ancestorCount <= 0) return {}
  const image: string[] = []
  const size: string[] = []
  const position: string[] = []
  const repeat: string[] = []
  if (isOpenDir) {
    // The corner: a horizontal stroke across the deepest indent column at
    // the row's vertical center (rows have no fixed height — percentage
    // stops keep the joint centered whoever resizes them).
    const from = (ancestorCount - 1) * FOLDER_INDENT_STEP_PX + FOLDER_INDENT_BASE_PX
    image.push(`linear-gradient(0deg, transparent calc(50% - 0.5px), ${GUIDE_STROKE} calc(50% - 0.5px), ${GUIDE_STROKE} calc(50% + 0.5px), transparent calc(50% + 0.5px))`)
    size.push(`${FOLDER_INDENT_STEP_PX}px 100%`)
    position.push(`${from}px 0`)
    repeat.push('no-repeat')
    // The corner's own trunk: the vertical stroke at the row's OWN column
    // (one indent step right of the corner) runs from the corner down to
    // the row's bottom, so the first child / session-row segment starts
    // flush with the joint — the better-sidebar branch glyph carries the
    // vertical through the corner row. Without it the line reads as two
    // detached fragments: a corner, then a fresh segment starting below.
    image.push(`linear-gradient(0deg, transparent calc(50% + 0.5px), ${GUIDE_STROKE} calc(50% + 0.5px), ${GUIDE_STROKE} 100%, transparent 100%)`)
    size.push('1px 100%')
    position.push(`${ancestorCount * FOLDER_INDENT_STEP_PX + FOLDER_INDENT_BASE_PX}px 0`)
    repeat.push('no-repeat')
  }
  for (let k = 0; k < ancestorCount; k++) {
    const x = k * FOLDER_INDENT_STEP_PX + FOLDER_INDENT_BASE_PX
    if (k === highlightCol) {
      // The hovered column: the full line, 2px and brighter.
      image.push(`linear-gradient(90deg, transparent ${x - 0.5}px, ${GUIDE_STROKE_HOVER} ${x - 0.5}px, ${GUIDE_STROKE_HOVER} ${x + 1.5}px, transparent ${x + 1.5}px)`)
    } else {
      image.push(`linear-gradient(90deg, transparent ${x}px, ${GUIDE_STROKE} ${x}px, ${GUIDE_STROKE} ${x + 1}px, transparent ${x + 1}px)`)
    }
    size.push('100% 100%')
    position.push('0px 0px')
    repeat.push('no-repeat')
  }
  return {
    backgroundImage: image.join(', '),
    backgroundSize: size.join(', '),
    backgroundPosition: position.join(', '),
    backgroundRepeat: repeat.join(', '),
  }
}

/** The hovered guide band: the row owning it, its column, and the ancestor
 *  that owns the stroke — the whole vertical line of that ancestor lights up
 *  across its visible subtree while the band is hovered (see
 *  `guideBackground`'s highlightCol). */
export interface GuideHover {
  /** The owning row's key (folder id / workspace leaf key / session id). */
  row: string
  /** The ancestor column under the pointer (index into the row's guide columns). */
  col: number
  /** The ancestor the stroke belongs to: a folder id, or a workspace group
   *  key (the deepest column when the row sits below a workspace leaf). */
  ancestor: string
}

/**
 * One guide column of a row: the ancestor whose stroke runs at that column,
 * plus the collapse action for it. Folders and workspace groups are both
 * collapsible ancestors — a workspace leaf is the "directory" of its session
 * rows, so session rows carry one extra column (the leaf's own) whose band
 * collapses the session list.
 */
export interface GuideColumn {
  /** Folder id or workspace group key (the archetype of the identity). */
  id: string
  /** Collapse the ancestor (toggle its expansion) — the band click action. */
  onToggle: () => void
}

/** The guide columns of a folder or workspace leaf row: one per ancestor
 *  folder, in root-side-first order (column k collapses `ancestors[k]`). */
function folderGuideColumns(ancestors: readonly FolderId[], onToggleFolder: (folderId: FolderId) => void): GuideColumn[] {
  return ancestors.map(folderId => ({ id: folderId, onToggle: () => onToggleFolder(folderId) }))
}

/**
 * The indent-guide seat shared by every tree row: the hovered band plus the
 * state setter, so one row's hover lights the ancestor's whole line across
 * every row of its visible subtree (the highlight is computed per row during
 * render — same model as the better-sidebar FileTree).
 */
export interface GuideSeat {
  hover: GuideHover | null
  /** Setter with identity guard: pass a thunk; rows re-use the previous
   *  value when the row+column already match, so re-entry renders nothing. */
  onHover: (setter: (prev: GuideHover | null) => GuideHover | null) => void
}

/** The row's highlighted guide column, when the hovered band's ancestor is
 *  IN this row's own chain at exactly that column — the row is then part of
 *  the ancestor's visible subtree, so its stroke at that column lights up
 *  with the whole line (a different branch's row of the same depth must not).
 *  The ancestor's own row is shallower, so its chain can never hold the
 *  ancestor at that column — only descendant rows light up. */
function guideHighlightColumn(hover: GuideHover | null, columns: readonly GuideColumn[]): number | undefined {
  if (hover === null || hover.col >= columns.length) return undefined
  return columns[hover.col]!.id === hover.ancestor ? hover.col : undefined
}

/** The clickable indent-guide bands on one row: one per guide column k in
 *  [0, columns.length), absolutely positioned exactly over that ancestor's
 *  stroke. Invisible until the row is hovered; the band under the pointer
 *  lights up (`.guideHit:hover`) and — while hovered — the ancestor's whole
 *  vertical line lights up across its subtree (the row background painter,
 *  `guideBackground`'s highlightCol); clicking the band collapses that
 *  ancestor (the folder — or, on session rows, the workspace group — whose
 *  vertical line was clicked). Clicks stop propagation so the row's own
 *  open/toggle action never fires. Rows without ancestors get no bands. */
function guideHitBands(
  rowKey: string,
  columns: readonly GuideColumn[],
  onHover: (setter: (prev: GuideHover | null) => GuideHover | null) => void,
): ReactNode[] {
  const bands: ReactNode[] = []
  for (let k = 0; k < columns.length; k++) {
    const column = columns[k]!
    bands.push(
      <span
        key={k}
        className={css.guideHit}
        style={{ left: k * FOLDER_INDENT_STEP_PX + FOLDER_INDENT_BASE_PX - (GUIDE_HIT_HALF - 0.5) }}
        onMouseEnter={() => {
          onHover(prev => prev !== null && prev.row === rowKey && prev.col === k
            ? prev
            : { row: rowKey, col: k, ancestor: column.id })
        }}
        onMouseLeave={() => {
          onHover(prev => prev !== null && prev.row === rowKey && prev.col === k ? null : prev)
        }}
        onClick={(event) => {
          event.stopPropagation()
          column.onToggle()
        }}
      />,
    )
  }
  return bands
}

/** Immutable membership toggle for local expand arrays. */
function toggled(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter(candidate => candidate !== key) : [...list, key]
}

/** Stable selector identity for the framework hook cache (never re-created). */
const identity = <T,>(snapshot: T): T => snapshot

/** Debounce of durable envelope writes (coalesces quick toggles/edits into one file write). */
const PERSIST_DEBOUNCE_MS = 300

/** Git probe refresh debounce on window focus (git state changes outside DSH:
 *  worktree add/remove, branch switch — re-probed shortly after focus). */
const PROBE_REFRESH_DEBOUNCE_MS = 1200

/** Group-expansion key prefix for repo groups in the "按仓库分组" view. */
const REPO_GROUP_KEY_PREFIX = 'repo:'

/** Group-expansion key prefix for subworkspace (tree) groups inside a
 *  workspace: `tw:<workspaceKey>:<groupKey>`. */
const SUBWS_GROUP_KEY_PREFIX = 'tw:'

// A slot can remount over the same store. Hydration belongs to that store's
// action identity, not its React mount; weak keys do not retain disposed stores.
const hydratedStores = new WeakSet<EnhancedWorkspaceBrowserProps['actions']>()

/** The enhanced browsing region. Folds with the shell: `wide` renders the
 *  full browser (header, search, tree); the collapsed 56px rail renders only
 *  the search (expands the shell and lands focus in the input) and add
 *  controls (built-in ui-workspace parity). The queried tree state outlives
 *  the fold so collapsing never drops a filter in progress.
 *  @param props - the four-share composed props. */
export function EnhancedWorkspaceBrowser(props: EnhancedWorkspaceBrowserProps): ReactNode {
  const {
    // Shell owner share: the region folds with the sidebar — `wide` renders
    // the full browser, the 56px rail renders the two icon controls.
    wide, expandSidebar,
    useStore, actions, t,
    useDirectoryFlow, useFileTreeUi, renderSlot,
    startSession, open,
    renameSession, forkSession, archiveSession,
    renameWorkspace, deleteWorkspace,
    insertWorkspaceBefore, createWorkspace, pickDirectory, probeGit, remoteGit, persistence,
  } = props
  const workspaces = props.useWorkspaces(identity)
  const sessions = props.useSessions(identity)
  const pendingInteractions = sessionPendingInteractionsOf(props.useSessionPendingInteraction(identity))
  const state = useStore(identity)
  const [query, setQuery] = useState('')
  // The optional fileTreeUi v2 service snapshot (undefined = missing /
  // incompatible / unloaded → every row renders the built-in fallback).
  // Subscribed at this top level so provide/unload flips the whole tree
  // between the two renderings without a remount.
  const fileTreeUi = useFileTreeUi(identity)

  // ── Git probe (derived cache, never persisted) ──────────────────────────
  // The repo index lives in browser state, not the envelope: it is a
  // read-only derivation of workspace paths + session cwds, refreshed on
  // mount (once the workspace baseline is ready) and on window focus
  // (debounced) — git state changes outside DSH (worktree add/remove, branch
  // switch) self-heal on the next refresh. null = probe unavailable/failed:
  // every git-derived surface renders its no-git fallback. Remote-mirror
  // markers ride along: the LOCAL probe can never see a mirror's git state
  // (no .git in the mirror), so the dsh-remote marker source runs in
  // parallel and its results overlay the probe as virtual remote trees.
  const [gitProbe, setGitProbe] = useState<GitProbeResultJSON | null>(null)
  const [gitMarkers, setGitMarkers] = useState<ReadonlyMap<string, RemoteGitMarker>>(() => new Map())
  const collectGitPaths = useCallback((): string[] => {
    const paths = new Set<string>()
    for (const workspace of workspaces.items) paths.add(workspace.path)
    for (const session of Object.values(sessions.byId)) {
      if (session.cwd !== undefined && session.cwd !== '') paths.add(session.cwd)
    }
    return [...paths]
  }, [workspaces.items, sessions.byId])
  const refreshGit = useCallback((hard = false): void => {
    const paths = collectGitPaths()
    void probeGit(paths).then(setGitProbe)
    // hard = manual "重新检测 git": bypass the client memo AND the endpoint
    // cache (?refresh=1); soft refreshes (mount / focus) reuse the TTL.
    const fetch = hard ? remoteGit.refresh : remoteGit.fetchMarkers
    void fetch(paths).then(setGitMarkers)
  }, [collectGitPaths, probeGit, remoteGit])
  useEffect(() => {
    if (workspaces.phase !== 'ready') return
    refreshGit()
  }, [workspaces.phase === 'ready', refreshGit])
  const focusTimerRef = useRef<number | null>(null)
  useEffect(() => {
    const onFocus = (): void => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current)
      focusTimerRef.current = window.setTimeout(refreshGit, PROBE_REFRESH_DEBOUNCE_MS)
    }
    window.addEventListener('focus', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current)
    }
  }, [refreshGit])
  // The git seat every surface reads: the LOCAL probe + the remote markers
  // overlaid into ONE index (virtual remote trees under `role: 'remote'`),
  // plus the marker map itself for the hover detail. The
  // merge is reference-stable: with no markers it returns the probe as-is,
  // so state changes unrelated to git never churn the derived surfaces.
  const gitPaths = useMemo(collectGitPaths, [collectGitPaths])
  const gitIndex = useMemo(
    () => overlayRemoteMarkers(gitProbe, gitMarkers, gitPaths),
    [gitProbe, gitMarkers, gitPaths],
  )
  const gitSeat = useMemo(
    () => ({
      probe: gitIndex,
      markers: gitMarkers,
      onRefresh: () => { refreshGit(true) },
    }),
    [gitIndex, gitMarkers, refreshGit],
  )
  // "Show more" overflow toggles for long session lists, owned HERE so the
  // browser header's collapse-everything can reset both sections' overflows
  // in one shot; GroupedView renders the rows against this state.
  const [sessionsOverflow, setSessionsOverflow] = useState<string[]>([])

  // Rail search = expand + land in the search box: the flag arms before the
  // expand request; once the shell flips wide the input mounts and takes
  // focus after the slide (the built-in browser's gesture).
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const [searchOnExpand, setSearchOnExpand] = useState(false)
  useEffect(() => {
    if (!wide || !searchOnExpand) return
    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus({ preventScroll: true })
      setSearchOnExpand(false)
    }, EXPAND_SLIDE_MS)
    return () => { window.clearTimeout(timer) }
  }, [wide, searchOnExpand])

  // ── External search trigger surface ─────────────────────────────────────
  // The search hole (`SEARCH_SLOT`) exists so an external plugin (dsh-hotkey)
  // can drive THIS search state instead of guessing at DOM: the handle below
  // is published through the slot's common inject face and mirrored on
  // `window.__DSH_ENHANCED_WORKSPACE__`. The handle's shape is deliberately
  // one capability per method:
  //  - `focusSearch()` runs the SAME two-step the rail button runs — arm the
  //    `searchOnExpand` gesture, then request the shell expansion — so
  //    "focus while collapsed" and "focus while wide" are one code path (the
  //    effect above is the only place that touches the input's focus: no
  //    duplicate, drift-prone focus logic here). `expandSidebar()` is a no-op
  //    request while already wide, and the slide-length delay before the
  //    focus is the built-in gesture's timing, not a divergence;
  //  - `setQuery()` replaces the `query` state directly (React state setters
  //    are safe to call through a stable wrapper), and the value survives a
  //    collapsed→wide fold.
  const focusSearch = useCallback((): void => {
    setSearchOnExpand(true)
    expandSidebar()
  }, [expandSidebar])
  const setSearchQuery = useCallback((next: string): void => { setQuery(next) }, [])
  const readSearchInput = useCallback((): HTMLInputElement | null => searchInputRef.current, [])
  // Publish/withdraw the handle with the region's mount. `installSearchHandle`
  // restores the previous owner on cleanup, so StrictMode's setup/cleanup
  // replay and spec remounts never leave a dead handle behind.
  useEffect(
    () => installSearchHandle({ focus: focusSearch, setQuery: setSearchQuery, input: readSearchInput }),
    [focusSearch, setSearchQuery, readSearchInput],
  )
  // Imperative mirror for hotkey actions: their `run` executes outside React
  // and cannot hold slot props; `contract.ts` owns the key/shape, this only
  // wires the live callbacks.
  useEffect(() => {
    const mirror: EnhancedWorkspaceGlobal = {
      focusSearch,
      setSearchQuery,
      searchInput: readSearchInput,
      searchAvailable: () => true,
      querySelector: SEARCH_INPUT_SELECTOR,
      railButtonSelector: SEARCH_RAIL_BUTTON_SELECTOR,
    }
    const host = window as unknown as Record<string, EnhancedWorkspaceGlobal | undefined>
    const previous = host[SEARCH_GLOBAL_KEY]
    host[SEARCH_GLOBAL_KEY] = mirror
    return () => {
      if (host[SEARCH_GLOBAL_KEY] === mirror) {
        if (previous === undefined) delete host[SEARCH_GLOBAL_KEY]
        else host[SEARCH_GLOBAL_KEY] = previous
      }
    }
  }, [focusSearch, setSearchQuery, readSearchInput])

  // Read once per mount, independently of baseline arrival. Cancellation
  // detaches obsolete effects (including StrictMode's setup/cleanup replay).
  const loadRef = useRef<ReturnType<typeof persistence.load> | null>(null)
  const [loaded, setLoaded] = useState<{ envelope: Awaited<ReturnType<typeof persistence.load>> } | null>(null)
  const [restoreStatus, setRestoreStatus] = useState<'unknown' | 'restored' | 'empty' | 'failed'>(() => hydratedStores.has(actions) ? 'restored' : 'unknown')
  const hydratedRef = useRef(hydratedStores.has(actions))
  useEffect(() => {
    if (hydratedStores.has(actions)) return
    let cancelled = false
    loadRef.current ??= Promise.resolve().then(() => persistence.load())
    void loadRef.current.then(envelope => {
      if (!cancelled) setLoaded({ envelope })
    }, error => {
      if (cancelled) return
      console.warn('dsh-enhanced-workspace: envelope load failed; writes disabled', error)
      setRestoreStatus('failed')
    })
    return () => { cancelled = true }
  }, [persistence, actions])

  // Restore only with the CURRENT authoritative baseline. An empty list
  // before baselinesReady is not evidence that every saved workspace died.
  useEffect(() => {
    if (hydratedRef.current || loaded === null || workspaces.phase !== 'ready') return
    hydratedRef.current = true
    try {
      if (loaded.envelope !== null) {
        // A tree edited while loading cannot safely replace the disk tree.
        // Keep the in-memory edit, but do not silently overwrite durable data.
        const root = state.folders[ROOT_FOLDER_ID]
        if (Object.keys(state.folders).length !== 1 || root === undefined
          || root.workspaceIds.length !== 0 || root.folderIds.length !== 0) {
          throw new Error('tree changed before restore completed')
        }
        actions.restoreEnvelope(loaded.envelope, workspaces.items.map(workspace => workspace.workspaceId))
      }
      hydratedStores.add(actions)
      setRestoreStatus(loaded.envelope === null ? 'empty' : 'restored')
    } catch (error) {
      console.warn('dsh-enhanced-workspace: envelope restore failed; writes disabled', error)
      setRestoreStatus('failed')
    }
  }, [loaded, workspaces.phase === 'ready', workspaces.items, state.folders, actions])
  const persistedReady = restoreStatus === 'restored' || restoreStatus === 'empty'

  // No adoption or pruning may race durable restore.
  useEffect(() => {
    if (!persistedReady || workspaces.phase !== 'ready') return
    actions.retainLiveKeys(workspaces.items.map(workspace => workspace.workspaceId))
    for (const workspace of workspaces.items) {
      if (folderOfWorkspace(state.folders, workspace.workspaceId) === undefined) {
        actions.adoptWorkspace(workspace.workspaceId)
      }
    }
  }, [persistedReady, workspaces.phase === 'ready', workspaces.items, state.folders, actions])

  // Failed reads never authorize a write, including a later edit or reconnect.
  useEffect(() => {
    if (!persistedReady || workspaces.phase !== 'ready') return
    const timer = setTimeout(() => {
      void persistence.save(state).catch(error => {
        console.warn('dsh-enhanced-workspace: envelope save failed', error)
      })
    }, PERSIST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [persistedReady, workspaces.phase === 'ready', state, persistence])

  // Recency stamps refresh ONLY on a new query send: the host bumps a
  // session's updatedAt on durable session activity (a send dominates), so a
  // stamp advancing past the previous pass marks the session's workspace.
  // Workspace row clicks / opens / session starts never touch — the recency
  // module ranks dirs by real query activity, not by browsing.
  const workspaceIdBySession = useMemo(() => {
    const map = new Map<SessionId, WorkspaceId>()
    for (const workspace of workspaces.items) {
      for (const id of workspace.sessionIds) map.set(id, workspace.workspaceId)
    }
    return map
  }, [workspaces.items])
  const seenUpdatedAtRef = useRef<Readonly<Record<string, number>>>({})
  useEffect(() => {
    const observation = observeSessionActivity(seenUpdatedAtRef.current, sessions.byId)
    seenUpdatedAtRef.current = observation.seen
    if (observation.advanced.length === 0) return
    const touched = new Set<WorkspaceId>()
    for (const sessionId of observation.advanced) {
      const workspaceId = workspaceIdBySession.get(sessionId)
      if (workspaceId !== undefined) touched.add(workspaceId)
    }
    // One stamp per workspace per batch (a burst of sessions sends one touch).
    for (const workspaceId of touched) actions.touchWorkspace(workspaceId)
  }, [sessions, workspaceIdBySession, actions])

  // Host flat-order reconciliation: after every tree change, move the Host
  // registry order onto the tree's depth-first order with the minimal move
  // set, so every other surface (picker, rail, flat lists) follows the tree.
  useEffect(() => {
    if (!persistedReady || workspaces.phase !== 'ready' || workspaces.items.length === 0) return
    const current = workspaces.items.map(workspace => workspace.workspaceId)
    const desired = treeOrder(state.folders)
    const deltas = orderDeltas(current, desired)
    if (deltas.length === 0) return
    void (async () => {
      for (const move of deltas) {
        try {
          await insertWorkspaceBefore(move.workspaceId, move.beforeWorkspaceId)
        } catch (error) {
          // Non-fatal by design: the tree stays the display authority; the
          // next mutation retries the reconciliation.
          console.warn('dsh-enhanced-workspace: host order reconcile failed', move, error)
        }
      }
    })()
  }, [persistedReady, workspaces.phase === 'ready', workspaces.items, state.folders, insertWorkspaceBefore])

  // First-encounter expansion (built-in parity): the group holding the
  // selected session opens unless the user already recorded a choice, so the
  // workspace that collects the current session shows its rows right away.
  const currentGroup = useMemo(() => {
    if (sessions.current === undefined) return undefined
    return (workspaces.items.find(workspace => workspace.sessionIds.includes(sessions.current as SessionId))
      ?.workspaceId as string | undefined) ?? UNGROUPED_KEY
  }, [sessions.current, workspaces.items])
  useEffect(() => {
    if (currentGroup === undefined || Object.hasOwn(state.groupExpansion, currentGroup)) return
    actions.setGroupExpanded(currentGroup, true)
  }, [currentGroup, state.groupExpansion, actions])

  // Cmd/Ctrl+N — New Session in the CURRENT workspace: the row plus-button
  // effect (expand the workspace's session group, then start) applied to the
  // workspace of the session in focus, or the recent workspace without one —
  // the same fallback chain the runtime's startSession resolves. The handler
  // rides a ref so the listener is installed exactly once per mount while
  // every keystroke sees the latest selection (navigation re-renders never
  // re-register it). Scope: a browser-region mechanism — it lives while this
  // region is mounted; the shell's rail New Session button covers the
  // collapsed-sidebar case. Unknown chords and already-handled events pass
  // through untouched.
  const newSessionRef = useRef<(event: KeyboardEvent) => void>(() => {})
  newSessionRef.current = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.repeat) return
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
    if (event.key.toLowerCase() !== 'n') return
    event.preventDefault()
    event.stopPropagation()
    const currentWorkspaceId = sessions.current === undefined
      ? undefined
      : workspaceIdBySession.get(sessions.current)
    const workspaceId = currentWorkspaceId ?? workspaces.items[0]?.workspaceId
    if (workspaceId !== undefined) {
      actions.setGroupExpanded(workspaceId, true)
      startSession(workspaceId)
    } else {
      // No workspace anywhere: the runtime clears into the New Session view.
      startSession()
    }
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => { newSessionRef.current(event) }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [])

  // Content search input: while the query is non-blank the browser filters
  // the original dirs list in place (see `filterForestByQuery`), hides the
  // recency module, and restores everything on an empty query.
  const searching = query.trim() !== ''

  const addWorkspace = async (path: string): Promise<void> => {
    try {
      const created = await createWorkspace({ path })
      actions.adoptWorkspace(created.workspaceId)
    } catch (error) {
      console.warn('dsh-enhanced-workspace: add workspace failed', error)
    }
  }

  // ── Directory-flow hole (plugin-owned key) ───────────────────────────────
  // The official `sidebar.workspaces.directoryFlow` hole is declared by the
  // built-in browser entry, which stays on the ledger under shadowing — a
  // declaration-less shadowing entry can neither re-declare nor render it
  // (SlotOwnershipError). So the add entry renders THIS plugin's own hole,
  // with the same owner conversation as the built-in flow contract
  // (`EnhancedDirectoryFlowOwnerProps`): the occupant owns everything between
  // `open` and the picked path; the owner adopts. Unoccupied → the native
  // `pickDirectory()` fallback keeps the entry fully self-owned.
  const directoryFlowAvailable = useDirectoryFlow(identity)
  const [flowOpen, setFlowOpen] = useState(false)
  const [flowBusy, setFlowBusy] = useState(false)
  // Withdraw an open flow whose occupant unloaded mid-interaction (nobody is
  // left to cancel) — the built-in picker's posture.
  useEffect(() => {
    if (flowOpen && !directoryFlowAvailable) setFlowOpen(false)
  }, [flowOpen, directoryFlowAvailable])
  const flowOwner: EnhancedDirectoryFlowOwnerProps = {
    open: flowOpen,
    busy: flowBusy,
    onPicked: (path: string) => {
      setFlowBusy(true)
      void addWorkspace(path).finally(() => { setFlowBusy(false) })
      setFlowOpen(false)
    },
    onCancel: () => { setFlowOpen(false) },
    onError: (message: string) => {
      console.warn('dsh-enhanced-workspace: add workspace flow failed', message)
      setFlowOpen(false)
    },
  }
  /** The region's Add entry: occupied hole → hand the picking interaction to
   *  the hole's occupant; unoccupied → open the native directory picker. */
  const openAddEntry = (): void => {
    if (directoryFlowAvailable) setFlowOpen(true)
    else void pickDirectory().then(path => { if (path !== null) void addWorkspace(path) })
  }

  // Owner share of the search hole. Deliberately empty (the slot publishes
  // the inject handle, not a conversation); the stable reference keeps the
  // renderSlot occurrence from churning child registrations on every render.
  const searchOwner = useMemo<EnhancedSearchOwnerProps>(() => ({}), [])

  const view = useMemo(
    () => ({
      folderExpansion: state.folderExpansion,
      groupExpansion: state.groupExpansion,
      orderBy: state.orderBy,
      sessionOrderBy: state.sessionOrderByAccount,
      ungroupedOrder: state.sessionOrderByAccount[FLAT_SESSION_ORDER_KEY],
    }),
    [state.folderExpansion, state.groupExpansion, state.orderBy, state.sessionOrderByAccount],
  )
  const forest = useMemo(
    () => deriveFolderForest(sessions, workspaces.items, state.folders, workspaces.archivedSessionIds, view, pendingInteractions),
    [sessions, workspaces.items, state.folders, workspaces.archivedSessionIds, view, pendingInteractions],
  )
  const recents = useMemo(
    () => deriveRecentWorkspaces(workspaces.items, sessions, state.recentTouchById, RECENTS_LIMIT, view, workspaces.archivedSessionIds),
    [workspaces.items, sessions, state.recentTouchById, view, workspaces.archivedSessionIds],
  )
  const flat = useMemo(
    () => deriveFlat(sessions, workspaces.archivedSessionIds, pendingInteractions),
    [sessions, workspaces.archivedSessionIds, pendingInteractions],
  )
  // While searching, the SAME tree renders filtered down to the matching
  // dirs (workspace title / cwd basename / session title hits; folders keep
  // the match path) — no separate results surface. The recency module is
  // omitted in this state (`recents={[]}` below).
  const filteredForest = useMemo(
    () => searching
      ? filterForestByQuery(forest, sessions, workspaces.items, query, workspaces.archivedSessionIds)
      : forest,
    [searching, forest, sessions, workspaces.items, query, workspaces.archivedSessionIds],
  )
  const filteredFlat = useMemo(
    () => searching ? filterFlatByQuery(flat, query) : flat,
    [searching, flat, query],
  )
  const searchEmpty = searching
    && (state.groupBy === 'flat'
      ? filteredFlat.length === 0
      : filteredForest.folders.length === 0
        && filteredForest.topLevel.length === 0
        && filteredForest.ungrouped === undefined)

  // --- Browser-owned dialog seats (outlive row unmounts during collapse) ---

  /** Folder create/rename target carrying its live seat id. */
  interface FolderInputTarget extends InputDialogState { folderId: FolderId }
  interface FolderCreateTarget extends InputDialogState { parentFolderId: FolderId }
  interface FolderDeleteTarget extends ConfirmDialogState { folderId: FolderId }
  interface FolderMoveTarget extends MoveToDialogState { folderId: FolderId }
  interface WorkspaceRenameTarget extends InputDialogState { workspaceId: WorkspaceId }
  interface WorkspaceDeleteTarget extends ConfirmDialogState { workspaceId: WorkspaceId }
  interface WorkspaceMoveTarget extends MoveToDialogState { workspaceId: WorkspaceId }
  interface SessionRenameTarget extends InputDialogState { sessionId: SessionId }

  const [createFolderTarget, setCreateFolderTarget] = useState<FolderCreateTarget | null>(null)
  const [renameFolderTarget, setRenameFolderTarget] = useState<FolderInputTarget | null>(null)
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderDeleteTarget | null>(null)
  const [moveFolderTarget, setMoveFolderTarget] = useState<FolderMoveTarget | null>(null)
  const [renameWorkspaceTarget, setRenameWorkspaceTarget] = useState<WorkspaceRenameTarget | null>(null)
  const [deleteWorkspaceTarget, setDeleteWorkspaceTarget] = useState<WorkspaceDeleteTarget | null>(null)
  const [moveWorkspaceTarget, setMoveWorkspaceTarget] = useState<WorkspaceMoveTarget | null>(null)
  const [renameSessionTarget, setRenameSessionTarget] = useState<SessionRenameTarget | null>(null)

  /** Live sibling-conflict hint for folder name inputs (create + rename). */
  const folderSiblingConflict = (parentFolderId: FolderId, excludeId: FolderId | undefined) =>
    (draft: string): string | undefined => {
      const trimmed = draft.trim()
      if (trimmed === '') return undefined
      const parent = state.folders[parentFolderId]
      if (parent === undefined) return undefined
      const duplicate = parent.folderIds.some(id =>
        id !== excludeId && state.folders[id]?.name === trimmed)
      return duplicate ? t('folderNameConflict') : undefined
    }

  /** Live duplicate-title hint for the workspace rename input. */
  const workspaceNameConflict = (currentTitle: string) => (draft: string): string | undefined => {
    const trimmed = draft.trim()
    if (trimmed === '' || trimmed === currentTitle.trim()) return undefined
    return workspaces.items.some(workspace => workspace.title === trimmed) ? t('renameConflict') : undefined
  }

  // Confirm handlers are id-parameterized and close over no dialog state
  // (the seats carry the ids; error updates use functional setState), so the
  // menus and the dialog seats can hold their closures across renders.

  const confirmCreateFolder = (parentFolderId: FolderId, draft: string): void => {
    try {
      actions.createFolder(parentFolderId, draft.trim())
      setCreateFolderTarget(null)
    } catch (error) {
      setCreateFolderTarget(current => current === null
        ? current
        : { ...current, error: folderErrorMessage(error, t) })
    }
  }
  const confirmRenameFolder = (folderId: FolderId, draft: string): void => {
    try {
      actions.renameFolder(folderId, draft.trim())
      setRenameFolderTarget(null)
    } catch (error) {
      setRenameFolderTarget(current => current === null
        ? current
        : { ...current, error: folderErrorMessage(error, t) })
    }
  }
  const confirmDeleteFolder = (folderId: FolderId): void => {
    try {
      actions.deleteFolder(folderId)
      setDeleteFolderTarget(null)
    } catch (error) {
      setDeleteFolderTarget(current => current === null
        ? current
        : { ...current, error: folderErrorMessage(error, t) })
    }
  }
  const confirmMoveFolder = (folderId: FolderId, targetFolderId: FolderId): void => {
    try {
      actions.moveFolder(folderId, undefined, targetFolderId)
      setMoveFolderTarget(null)
    } catch (error) {
      setMoveFolderTarget(current => current === null
        ? current
        : { ...current, error: folderErrorMessage(error, t) })
    }
  }
  const confirmRenameWorkspace = (workspaceId: WorkspaceId, draft: string): void => {
    // The dialog seats carry the ids and the confirm closures are built at
    // menu-click time — a guard reading this render frame's seat state would
    // see the PRE-dialog value (null) forever after, silently swallowing the
    // confirm. The functional updater owns the freshness check; the RPC fires
    // unconditionally because a visible confirm button implies a live seat
    // (same posture as the synchronous folder actions).
    setRenameWorkspaceTarget(current => current === null || current.workspaceId !== workspaceId
      ? current
      : { ...current, busy: true, error: null })
    void renameWorkspace(workspaceId, draft.trim())
      .then(() => {
        setRenameWorkspaceTarget(current => current === null || current.workspaceId !== workspaceId
          ? current
          : null)
      })
      .catch((error: unknown) => {
        setRenameWorkspaceTarget(current => current === null || current.workspaceId !== workspaceId
          ? current
          : { ...current, busy: false, error: error instanceof Error ? error.message : String(error) })
      })
  }
  const confirmDeleteWorkspace = (workspaceId: WorkspaceId): void => {
    // Same frame-capture trap as renameWorkspace above: the confirmation
    // closure lives on the seat object built before the dialog rendered, so
    // the old `deleteWorkspaceTarget` guard returned on the pre-dialog null
    // forever — the confirm button appeared dead (no busy, no RPC, no error).
    // Freshness now lives in the functional updater; the delete fires
    // unconditionally (a live dialog seat is guaranteed while the button is
    // on screen; unknown ids are idempotent on the host side).
    setDeleteWorkspaceTarget(current => current === null || current.workspaceId !== workspaceId
      ? current
      : { ...current, busy: true, error: null })
    void deleteWorkspace(workspaceId)
      .then(() => {
        setDeleteWorkspaceTarget(current => current === null || current.workspaceId !== workspaceId
          ? current
          : null)
      })
      .catch((error: unknown) => {
        setDeleteWorkspaceTarget(current => current === null || current.workspaceId !== workspaceId
          ? current
          : { ...current, busy: false, error: error instanceof Error ? error.message : String(error) })
      })
  }
  const confirmMoveWorkspace = (workspaceId: WorkspaceId, targetFolderId: FolderId): void => {
    try {
      actions.moveWorkspaceIn(workspaceId, targetFolderId)
      setMoveWorkspaceTarget(null)
    } catch (error) {
      setMoveWorkspaceTarget(current => current === null || current.workspaceId !== workspaceId
        ? current
        : { ...current, error: folderErrorMessage(error, t) })
    }
  }
  const confirmRenameSession = (sessionId: SessionId, draft: string): void => {
    // Frame-capture trap shared with rename/delete workspace: the seat's
    // confirm closure predates the dialog render, so a guard on this frame's
    // seat state would see the pre-dialog null forever. Functional updater
    // owns freshness; the RPC fires unconditionally.
    setRenameSessionTarget(current => current === null || current.sessionId !== sessionId
      ? current
      : { ...current, busy: true, error: null })
    void renameSession(sessionId, draft.trim())
      .then(() => {
        setRenameSessionTarget(current => current === null || current.sessionId !== sessionId
          ? current
          : null)
      })
      .catch((error: unknown) => {
        setRenameSessionTarget(current => current === null || current.sessionId !== sessionId
          ? current
          : { ...current, busy: false, error: error instanceof Error ? error.message : String(error) })
      })
  }

  const openers: RowOpeners = {
    onNewFolder: () => setCreateFolderTarget({ parentFolderId: ROOT_FOLDER_ID, title: t('newFolder'), label: t('folderName'), placeholder: t('folderNamePlaceholder'), initial: '', confirmLabel: t('confirm'), error: null, busy: false, confirm: draft => confirmCreateFolder(ROOT_FOLDER_ID, draft) }),
    onNewSubfolder: parentFolderId => setCreateFolderTarget({ parentFolderId, title: t('createFolderTitle'), label: t('folderName'), placeholder: t('folderNamePlaceholder'), initial: '', confirmLabel: t('confirm'), error: null, busy: false, confirm: draft => confirmCreateFolder(parentFolderId, draft) }),
    onRenameFolder: (folderId, name) => setRenameFolderTarget({
      folderId, title: t('renameFolderTitle'), label: t('folderName'),
      placeholder: t('folderNamePlaceholder'), initial: name, confirmLabel: t('rename'),
      error: null, busy: false, confirm: draft => confirmRenameFolder(folderId, draft),
    }),
    onDeleteFolder: (folderId, name, parentName) => setDeleteFolderTarget({
      folderId, title: t('deleteFolderTitle'),
      description: t('deleteFolderDescription', { parent: parentName }),
      confirmLabel: t('delete'), error: null, busy: false, confirm: () => confirmDeleteFolder(folderId),
    }),
    onMoveFolder: (folderId, name) => setMoveFolderTarget({
      folderId, title: t('moveFolderTitle'), description: t('moveToDescription'),
      excludedFolderId: folderId, subjectName: name, error: null, busy: false,
      confirm: targetFolderId => confirmMoveFolder(folderId, targetFolderId),
    }),
    onRenameWorkspace: (workspaceId, currentTitle) => setRenameWorkspaceTarget({
      workspaceId, title: t('renameWorkspaceTitle'), label: t('folderName'),
      placeholder: t('folderNamePlaceholder'), initial: currentTitle, confirmLabel: t('rename'),
      conflict: workspaceNameConflict(currentTitle), error: null, busy: false,
      confirm: draft => confirmRenameWorkspace(workspaceId, draft),
    }),
    onDeleteWorkspace: (workspaceId, title) => setDeleteWorkspaceTarget({
      workspaceId, title: t('deleteWorkspaceTitle'), description: t('deleteWorkspaceDescription'),
      confirmLabel: t('deleteWorkspaceTitle'), error: null, busy: false, confirm: () => confirmDeleteWorkspace(workspaceId),
    }),
    onMoveWorkspace: (workspaceId, label) => setMoveWorkspaceTarget({
      workspaceId, title: t('moveWorkspaceTitle'), description: t('moveToDescription'),
      excludedFolderId: undefined, subjectName: label, error: null, busy: false,
      confirm: targetFolderId => confirmMoveWorkspace(workspaceId, targetFolderId),
    }),
    onRenameSession: (sessionId, currentTitle) => setRenameSessionTarget({
      sessionId, title: t('renameSessionTitle'), label: t('folderName'),
      placeholder: t('folderNamePlaceholder'), initial: currentTitle, confirmLabel: t('rename'),
      error: null, busy: false, confirm: draft => confirmRenameSession(sessionId, draft),
    }),
  }
  const toggleOverflow = (key: string): void => setSessionsOverflow(keys => toggled(keys, key))
  // The recents header's collapse: only the recency module's rows fold (its
  // `recent:` keyspace) — the workspace list below keeps its expansion, and
  // only the recency rows' "show more" overflows reset with them.
  const collapseRecents = (): void => {
    actions.collapseRecents()
    setSessionsOverflow(keys => keys.filter(key => !key.startsWith(RECENT_GROUP_KEY_PREFIX)))
  }
  // The "all" header's collapse: only this section's expandable rows — the
  // folder forest and the tree/ungrouped session groups — fold back; recency
  // rows keep their expansion, and only this section's overflows reset.
  const collapseAll = (): void => {
    actions.collapseAll()
    setSessionsOverflow(keys => keys.filter(key => key.startsWith(RECENT_GROUP_KEY_PREFIX)))
  }
  // The browser header's collapse: BOTH modules fold — the recency rows and
  // the workspace-list rows (folders + tree/ungrouped groups) — and every
  // "show more" overflow resets with them (both section overflows owned).
  const collapseEverything = (): void => {
    actions.collapseEverything()
    setSessionsOverflow([])
  }

  return (
    // The region folds with the shell: `wide` renders the full browser, the
    // 56px rail (`css.rail`) only the two icon controls below. The wide
    // chrome unmounts at the collapse settle (the shell fades it out while
    // it is still `wide`) and remounts with the fade-in animation on expand.
    <div className={`${css.region} ${wide ? css.wide : css.rail}`} data-dsh-enhanced-workspace="browser">
      {wide && (
        <header className={css.header}>
          <span className={css.title}>{t('workspaces')}</span>
          <div className={css.headerActions}>
            <Tooltip label={t('collapseEverything')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('collapseEverything')}
                onClick={collapseEverything}
              >
                <IconChevronUpOutline14 />
              </button>
            </Tooltip>
            <ViewOptionsMenu
              groupBy={state.groupBy}
              orderBy={state.orderBy}
              onGroupPick={mode => actions.setGroupBy(mode)}
              onOrderPick={mode => actions.setOrderBy(mode)}
              t={t}
            />
            <Tooltip label={t('addWorkspace')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('addWorkspace')}
                onClick={openAddEntry}
              >
                <IconProjectAddOutline16 />
              </button>
            </Tooltip>
          </div>
        </header>
      )}
      {wide
        ? (
          <div className={css.searchBar}>
            <IconSearchOutline16 className={css.searchIcon} />
            <input
              ref={searchInputRef}
              className={css.searchInput}
              type="search"
              aria-label={t('searchAria')}
              /* Stable external marker: the DOM fallback trigger path
                 (`SEARCH_INPUT_ATTR_VALUE`, contract.ts). Class names are
                 hashed per build; this attribute is the contract. */
              data-dsh-enhanced-workspace="search"
              placeholder={t('searchPlaceholder')}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
            {/* The search hole: an optional occupant (e.g. a hotkey plugin's
                companion control) renders beside the field while the browser
                is wide. Its props carry the slot's common `inject` face —
                the live search handle (`focus` / `setQuery` / `input`). */}
            {renderSlot(SEARCH_SLOT, searchOwner)}
          </div>
        )
        : (
          // The collapsed rail: search expands the shell and lands in the
          // input (built-in gesture); add opens the directory picker right
          // from the rail. 36px boxes, primary ink, 12px rhythm — the shell's
          // rail spec.
          <div className={css.railActions}>
            <Tooltip label={t('addWorkspace')} delayMs={500}>
              <button
                type="button"
                className={css.railButton}
                aria-label={t('addWorkspace')}
                onClick={openAddEntry}
              >
                <IconProjectAddOutline16 size={18} />
              </button>
            </Tooltip>
            <Tooltip label={t('searchAria')} delayMs={500}>
              <button
                type="button"
                className={css.railButton}
                aria-label={t('searchAria')}
                /* Stable external marker (SEARCH_RAIL_BUTTON_ATTR_VALUE):
                   a DOM fallback clicks this while the input is absent, then
                   waits for the fold and focuses the input. */
                data-dsh-enhanced-workspace="search-button"
                onClick={focusSearch}
              >
                <IconSearchOutline16 size={18} />
              </button>
            </Tooltip>
          </div>
        )}
      {/* The directory-flow hole stays mounted while occupied (the built-in
          posture): the occupant owns everything between `open` and the picked
          path and hides itself while `open` is false, so its in-progress
          state survives open/close cycles. */}
      {directoryFlowAvailable && renderSlot(DIRECTORY_FLOW_SLOT, flowOwner)}
      {/* Always-mounted seat keeps the region's flex slot while the tree
          itself is wide-only. */}
      <div className={css.scroll}>
        {wide && (searching
          ? searchEmpty
            ? (
              // The filtered tree is fully empty — a quiet hint instead of a
              // blank area (the query stays; clearing it restores the list).
              <div className={css.searchStatus} role="status">{t('searchNoMatches')}</div>
            )
            : state.groupBy === 'flat'
              ? <FlatList props={props} rows={filteredFlat} onRename={openers.onRenameSession} fileTreeUi={fileTreeUi} />
              : <GroupedView
                props={props}
                forest={filteredForest.folders}
                topLevel={filteredForest.topLevel}
                // While filtering, the recency module is omitted: the user
                // sees only the matching dirs of the original list.
                recents={[]}
                ungrouped={filteredForest.ungrouped}
                openers={openers}
                sessionsOverflow={sessionsOverflow}
                onToggleOverflow={toggleOverflow}
                onCollapseRecents={collapseRecents}
                onCollapseAll={collapseAll}
                git={gitSeat}
                query={query}
                fileTreeUi={fileTreeUi}
              />
          : state.groupBy === 'flat'
            ? <FlatList props={props} rows={flat} onRename={openers.onRenameSession} fileTreeUi={fileTreeUi} />
            : <GroupedView
              props={props}
              forest={forest.folders}
              topLevel={forest.topLevel}
              recents={recents}
              ungrouped={forest.ungrouped}
              openers={openers}
              sessionsOverflow={sessionsOverflow}
              onToggleOverflow={toggleOverflow}
              onCollapseRecents={collapseRecents}
              onCollapseAll={collapseAll}
              git={gitSeat}
              query={query}
              fileTreeUi={fileTreeUi}
            />)}
      </div>
      {createFolderTarget !== null && (
        <InputDialog
          state={{
            ...createFolderTarget,
            conflict: folderSiblingConflict(createFolderTarget.parentFolderId, undefined),
          }}
          onCancel={() => setCreateFolderTarget(null)}
          t={t}
        />
      )}
      {renameFolderTarget !== null && (
        <InputDialog
          state={{
            ...renameFolderTarget,
            conflict: folderSiblingConflict(
              state.folders[renameFolderTarget.folderId]?.parentFolderId ?? ('root' as FolderId),
              renameFolderTarget.folderId,
            ),
          }}
          onCancel={() => setRenameFolderTarget(null)}
          t={t}
        />
      )}
      {deleteFolderTarget !== null && (
        <ConfirmDialog state={deleteFolderTarget} onCancel={() => setDeleteFolderTarget(null)} t={t} />
      )}
      {moveFolderTarget !== null && (
        <MoveToDialog state={moveFolderTarget} folders={state.folders} onCancel={() => setMoveFolderTarget(null)} t={t} />
      )}
      {renameWorkspaceTarget !== null && (
        <InputDialog state={renameWorkspaceTarget} onCancel={() => setRenameWorkspaceTarget(null)} t={t} />
      )}
      {deleteWorkspaceTarget !== null && (
        <ConfirmDialog state={deleteWorkspaceTarget} onCancel={() => setDeleteWorkspaceTarget(null)} t={t} />
      )}
      {moveWorkspaceTarget !== null && (
        <MoveToDialog state={moveWorkspaceTarget} folders={state.folders} onCancel={() => setMoveWorkspaceTarget(null)} t={t} />
      )}
      {renameSessionTarget !== null && (
        <InputDialog state={renameSessionTarget} onCancel={() => setRenameSessionTarget(null)} t={t} />
      )}
    </div>
  )
}

/** Grouping and ordering menu; own open state (built-in parity). */
function ViewOptionsMenu({ groupBy, orderBy, onGroupPick, onOrderPick, t }: {
  groupBy: SessionGroupBy
  orderBy: 'manual' | 'updated'
  onGroupPick: (mode: SessionGroupBy) => void
  onOrderPick: (mode: 'manual' | 'updated') => void
  t: EnhancedWorkspaceBrowserProps['t']
}): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <Menu
      open={open}
      onClose={() => { setOpen(false) }}
      items={[
        { type: 'label' as const, id: 'group-by', text: t('groupByLabel') },
        { id: 'workspace', label: t('groupByWorkspace') },
        { id: 'repo', label: t('groupByRepo') },
        { id: 'flat', label: t('groupByFlat') },
        { type: 'separator' as const, id: 'order-by-separator' },
        { type: 'label' as const, id: 'order-by', text: t('orderByLabel') },
        { id: 'manual', label: t('orderByManual') },
        { id: 'updated', label: t('orderByUpdated') },
      ]}
      selectedIds={[groupBy, orderBy]}
      onSelect={(id) => {
        if (id === 'workspace' || id === 'repo' || id === 'flat') onGroupPick(id)
        else if (id === 'manual' || id === 'updated') onOrderPick(id)
        setOpen(false)
      }}
      align="end"
      dense
      portal
      anchor={(
        <Tooltip label={t('viewOptionsLabel')} side="bottom" delayMs={500}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('viewOptionsLabel')}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconPersonalizationOutline16 />
          </button>
        </Tooltip>
      )}
    />
  )
}

/** Row menu openers supplied by the browser root (dialog seats live there). */
interface RowOpeners {
  onNewFolder: () => void
  onNewSubfolder: (parentFolderId: FolderId) => void
  onRenameFolder: (folderId: FolderId, name: string) => void
  onDeleteFolder: (folderId: FolderId, name: string, parentName: string) => void
  onMoveFolder: (folderId: FolderId, name: string) => void
  onRenameWorkspace: (workspaceId: WorkspaceId, title: string) => void
  onDeleteWorkspace: (workspaceId: WorkspaceId, title: string) => void
  onMoveWorkspace: (workspaceId: WorkspaceId, label: string) => void
  onRenameSession: (sessionId: SessionId, title: string) => void
}

/** Row callbacks shared by every leaf and folder row. */
interface RowCallbacks {
  onToggleGroup: (key: string) => void
  onToggleFolder: (folderId: FolderId) => void
  onWorkspaceClick: (key: string) => void
  onSessionOpen: (sessionId: SessionId) => void
  onStartSession: (workspaceId: WorkspaceId, key: string) => void
  openers: RowOpeners
  t: EnhancedWorkspaceBrowserProps['t']
  /** Workspace whose PATH binds to a tree root (the "在目标树继续" resolver). */
  workspaceIdForTree?: (treeRoot: string) => WorkspaceId | undefined
  /** Source session title of a workspace row (current session when it lives
   *  there, else the row's first visible session) — the title carried over
   *  by "在目标树继续". */
  sessionTitleFor?: (workspaceId: WorkspaceId) => string | undefined
  /** Continue in a target tree: new session in the bound workspace, or
   *  register the tree first when no workspace owns it yet. The source
   *  workspace names the title to carry over. */
  onContinueInTree?: (tree: GitTreeInfoJSON, sourceWorkspaceId: WorkspaceId | undefined) => void
}

/** Drag & drop seat shared by every workspace and folder row. */
interface DragSeat {
  dragSource: DragSource | null
  appendWorkspaceFolderId: FolderId | null
  onDragStart: (source: DragSource) => void
  onDragOver: (target: DropTarget) => void
  onDragLeave: (kind: DropTarget['kind'], id: string) => void
  onDragEnd: () => void
  onDrop: (source: DragSource, target: DropTarget) => void
  /** Visual drop zone for a row during an active drag, or undefined. */
  dropZoneOf: (kind: DropTarget['kind'], id: string) => DropZone | undefined
}

/** Session-row verbs (grouped leaf rows and the flat list share this seat). */
interface SessionRowSeat {
  onOpen: (sessionId: SessionId) => void
  onRename: (sessionId: SessionId, title: string) => void
  onFork: (sessionId: SessionId) => void
  onArchive: (sessionId: SessionId) => void
  t: EnhancedWorkspaceBrowserProps['t']
}

/** The recency module plus the folder forest, root-level leaves, and the ungrouped bucket. */
function GroupedView(props: {
  props: EnhancedWorkspaceBrowserProps
  forest: readonly FolderNode[]
  topLevel: readonly WorkspaceLeaf[]
  recents: ReturnType<typeof deriveRecentWorkspaces>
  ungrouped: WorkspaceLeaf | undefined
  openers: RowOpeners
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  onCollapseRecents: () => void
  onCollapseAll: () => void
  /** Active search query (repo view filters groups and members against it). */
  query: string
  /** Git seat: repo grouping + subworkspace groups + the unregistered-tree
   *  group all derive from it. `probe: null` renders every git surface in
   *  its no-git fallback. `markers` carries the dsh-remote workspace
   *  markers (mirror rows show their branch in the hover card only — no
   *  row pill). */
  git: { probe: GitProbeResultJSON | null; markers: ReadonlyMap<string, RemoteGitMarker>; onRefresh: () => void }
  /** The optional fileTreeUi v2 service (undefined → built-in rows). When
   *  present the WHOLE tree renders through the provider's FileTree
   *  framework (this module builds the row models per section). */
  fileTreeUi: FileTreeUiServiceV2 | undefined
}): ReactNode {
  const { t, actions, startSession } = props.props
  const state = props.props.useStore(identity)
  // Framework feeds are real hooks: they MUST run at the component top level
  // (a call inside useMemo would be an invalid hook call under the real DSH
  // runtime; the jsdom fixtures hide it because their selectors are plain
  // functions).
  const workspaceList = props.props.useWorkspaces(identity)
  const sessionList = props.props.useSessions(identity)
  // Workspace → session cwd list, for the git aggregation (cross-tree
  // count + subworkspace groups): the derived leaves only carry sessions
  // while expanded, so the git layer reads the live session list directly.
  const sessionCwdsByWorkspace = useMemo(() => {
    const map = new Map<WorkspaceId, readonly { id: SessionId; cwd?: string }[]>()
    for (const workspace of workspaceList.items) {
      const list: { id: SessionId; cwd?: string }[] = []
      for (const id of workspace.sessionIds) {
        const summary = sessionList.byId[id]
        if (summary === undefined) continue
        list.push(summary.cwd === undefined ? { id } : { id, cwd: summary.cwd })
      }
      map.set(workspace.workspaceId, list)
    }
    return (workspaceId: WorkspaceId | undefined): readonly { id: SessionId; cwd?: string }[] =>
      workspaceId === undefined ? [] : (map.get(workspaceId) ?? [])
  }, [workspaceList, sessionList])
  // Tree root → workspace bound to it (via workspace PATHS), for the
  // "在目标树继续" resolver: a tree may have zero (unregistered) or one owner.
  const treeWorkspaceIndex = useMemo(() => {
    const index = new Map<string, WorkspaceId>()
    if (props.git.probe === null) return index
    for (const workspace of workspaceList.items) {
      const tree = treeOfCwd(props.git.probe, workspace.path)
      if (tree !== undefined && !index.has(tree.root)) index.set(tree.root, workspace.workspaceId)
    }
    return index
  }, [props.git.probe, workspaceList])
  // Expanded group-key set for the subworkspace headers (`tw:` keys live in
  // the same groupExpansion map the section collapse-all already clears).
  const expandedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const [key, value] of Object.entries(state.groupExpansion)) {
      if (value) set.add(key)
    }
    return set
  }, [state.groupExpansion])
  /** Source title for the continue carry-over: the current session's title
   *  when it belongs to this row, else the row's first visible session. */
  const sessionTitleFor = (workspaceId: WorkspaceId): string | undefined => {
    const current = sessionList.current
    if (current !== undefined) {
      const owner = workspaceList.items.find(workspace => workspace.sessionIds.includes(current))
      if (owner !== undefined && owner.workspaceId === workspaceId) {
        const summary = sessionList.byId[current]
        if (summary !== undefined && !summary.blank) return summary.displayTitle
      }
    }
    const workspace = workspaceList.items.find(candidate => candidate.workspaceId === workspaceId)
    for (const id of workspace?.sessionIds ?? []) {
      const summary = sessionList.byId[id]
      if (summary !== undefined && !summary.blank && summary.origin !== 'subagent') return summary.displayTitle
    }
    return undefined
  }
  const callbacks: RowCallbacks = {
    onToggleGroup: key => actions.setGroupExpanded(key, !state.groupExpansion[key]),
    onToggleFolder: folderId => actions.setFolderExpanded(folderId, !state.folderExpansion[folderId]),
    // Clicking a workspace row only toggles its session list — it never
    // refreshes the recency stamp (only a new query send does).
    onWorkspaceClick: key => {
      actions.setGroupExpanded(key, !state.groupExpansion[key])
    },
    onSessionOpen: sessionId => props.props.open(sessionId),
    onStartSession: (workspaceId, key) => {
      actions.setGroupExpanded(key, true)
      startSession(workspaceId)
    },
    openers: props.openers,
    t,
    workspaceIdForTree: (treeRoot) => treeWorkspaceIndex.get(treeRoot),
    sessionTitleFor,
    onContinueInTree: (tree, sourceWorkspaceId) => {
      const workspaceId = treeWorkspaceIndex.get(tree.root)
      const title = sourceWorkspaceId === undefined ? undefined : sessionTitleFor(sourceWorkspaceId)
      const continueIn = (target: WorkspaceId): void => {
        actions.setGroupExpanded(target, true)
        props.props.continueInWorkspace(target, title).catch(error => {
          console.warn('dsh-enhanced-workspace: continue-in-tree failed', target, error)
        })
      }
      if (workspaceId !== undefined) {
        continueIn(workspaceId)
        return
      }
      // Unregistered tree: register it as a workspace, adopt, then continue.
      props.props.createWorkspace({ path: tree.root })
        .then(created => {
          actions.adoptWorkspace(created.workspaceId)
          continueIn(created.workspaceId)
        })
        .catch(error => {
          console.warn('dsh-enhanced-workspace: register-and-continue failed', tree.root, error)
        })
    },
  }
  const sessionSeat: SessionRowSeat = {
    onOpen: callbacks.onSessionOpen,
    onRename: props.openers.onRenameSession,
    onFork: sessionId => props.props.forkSession(sessionId),
    onArchive: sessionId => {
      props.props.archiveSession(sessionId).catch((error: unknown) => {
        console.warn('dsh-enhanced-workspace: session archive rejected', error)
      })
    },
    t,
  }
  const topLevelLabel = t('moveDestinationTopLevel')
  // One relative-time stamp per render pass, shared by every session row's
  // hover card (the same posture as the built-in tree).
  const now = Date.now()

  // Drag & drop seat: source + highlighted target live here; drops resolve
  // against the tree through the pure drag module and dispatch store actions
  // (guards fail non-fatally, see handleRowDrop).
  const [dragSource, setDragSource] = useState<DragSource | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const handleRowDrop = (source: DragSource, target: DropTarget): void => {
    try {
      const resolution = source.kind === 'folder'
        ? resolveFolderDrop(state.folders, source.id as FolderId, target.id as FolderId, target.zone)
        : resolveWorkspaceDrop(state.folders, source.id as WorkspaceId, target.kind, target.id, target.zone)
      if (resolution.kind === 'move-workspace') {
        actions.moveWorkspaceIn(source.id as WorkspaceId, resolution.folderId, resolution.beforeWorkspaceId)
      } else if (resolution.kind === 'move-folder') {
        actions.moveFolder(source.id as FolderId, resolution.beforeFolderId, resolution.parentFolderId)
      }
    } catch (error) {
      // Tree guards (cycle / depth / root) and corrupt trees fail non-fatally;
      // the drag simply cancels and the tree stays the display authority.
      console.warn('dsh-enhanced-workspace: drop rejected', source, target, error)
    } finally {
      setDragSource(null)
      setDropTarget(null)
    }
  }
  const drag: DragSeat = {
    dragSource,
    appendWorkspaceFolderId: dragSource?.kind === 'workspace' && dropTarget?.kind === 'folder' && dropTarget.zone === 'before'
      ? state.folders[dropTarget.id as FolderId]?.parentFolderId ?? null
      : null,
    onDragStart: source => setDragSource(source),
    onDragOver: target => setDropTarget(current =>
      current !== null && current.kind === target.kind && current.id === target.id && current.zone === target.zone
        ? current
        : target),
    onDragLeave: (kind, id) => setDropTarget(current =>
      current !== null && current.kind === kind && current.id === id ? null : current),
    onDragEnd: () => {
      setDragSource(null)
      setDropTarget(null)
    },
    onDrop: handleRowDrop,
    dropZoneOf: (kind, id) => {
      if (dragSource === null || dropTarget === null || dropTarget.kind !== kind || dropTarget.id !== id) return undefined
      // Workspace top-edge drops append to the parent; only that region gets a preview.
      if (kind === 'folder' && dragSource.kind === 'workspace' && dropTarget.zone === 'before') return undefined
      return dropTarget.zone
    },
  }
  /** The indent-guide band under the pointer (null = none): while set, the
   *  whole vertical line of the hovered ancestor lights up across its
   *  visible subtree — the "click collapses this whole folder" signal.
   *  Shared by every tree row; the recency rows (top-level, no ancestor
   *  folders) never produce or consume it. */
  const [hoverGuide, setHoverGuide] = useState<GuideHover | null>(null)
  const guide: GuideSeat = {
    hover: hoverGuide,
    onHover: setHoverGuide,
  }
  return (
    // The container swallows dragover/drop so a drag released on empty space
    // cancels instead of navigating (dropped text must never leave the region).
    // `data-dsh-ew-browser` marks the whole tree as plugin-owned for the
    // window-level chat-drop router (zones inside it are never intercepted).
    <div
      className={css.grouped}
      data-dsh-ew-browser=""
      onDragOver={event => { if (dragSource !== null) event.preventDefault() }}
      onDrop={event => {
        if (dragSource === null) return
        event.preventDefault()
        setDragSource(null)
        setDropTarget(null)
        stashActiveReference(null)
      }}
    >
      {props.fileTreeUi === undefined
        ? (
      <>
      {props.recents.length > 0
        ? (
          // Top five most-recently-queried dirs as ordinary workspace rows —
          // expandable session list, row menu, new-session button. No session
          // count and no relative time on the UI (the recency stamps stay
          // recorded in the store for ordering); the bottom border divides
          // this section from the workspace list below.
          <section className={`${css.section} ${css.sectionDivider}`}>
            <div className={css.sectionHeader}>
              <h3 className={css.sectionTitle}>{t('recents')}</h3>
              <Tooltip label={t('collapseAll')} side="bottom" delayMs={500}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('collapseAll')}
                  onClick={props.onCollapseRecents}
                >
                  <IconChevronUpOutline14 />
                </button>
              </Tooltip>
            </div>
            {props.recents.map(recent => (
              <LeafRow
                key={recent.workspaceId}
                leaf={recent}
                // Recency rows are top-level workspace rows: no ancestor
                // folders, so no indent guides.
                ancestors={[]}
                callbacks={callbacks}
                sessionSeat={sessionSeat}
                sessionsOverflow={props.sessionsOverflow}
                onToggleOverflow={props.onToggleOverflow}
                drag={drag}
                guide={guide}
                now={now}
                git={props.git.probe}
                gitMarkers={props.git.markers}
                sessionsForGit={sessionCwdsByWorkspace(recent.workspaceId)}
                expandedKeys={expandedKeys}
              />
            ))}
          </section>
        )
        : null}
      {props.forest.length > 0 || props.topLevel.length > 0 || props.ungrouped !== undefined || state.groupBy === 'repo'
        ? (
          // The full workspace tree below the recents border: the folder
          // forest, root-level leaves, and the ungrouped bucket — or, in the
          // git-repo grouping mode, the repo forest with the no-git
          // workspaces flattened below and the unregistered-tree group last.
          <section className={css.section}>
            <div className={css.sectionHeader}>
              <h3 className={css.sectionTitle}>{t('all')}</h3>
              <div className={css.headerActions}>
                <Tooltip label={t('collapseAll')} side="bottom" delayMs={500}>
                  <button
                    type="button"
                    className={css.iconButton}
                    aria-label={t('collapseAll')}
                    onClick={props.onCollapseAll}
                  >
                    <IconChevronUpOutline14 />
                  </button>
                </Tooltip>
                <Tooltip label={t('newFolder')} side="bottom" delayMs={500}>
                  <button
                    type="button"
                    className={css.iconButton}
                    aria-label={t('newFolder')}
                    onClick={props.openers.onNewFolder}
                  >
                    <IconPlusOutline16 />
                  </button>
                </Tooltip>
              </div>
            </div>
            {state.groupBy === 'repo'
              ? (
                <>
                  <RepoForestView
                    props={props.props}
                    git={props.git}
                    callbacks={callbacks}
                    sessionSeat={sessionSeat}
                    sessionsOverflow={props.sessionsOverflow}
                    onToggleOverflow={props.onToggleOverflow}
                    drag={drag}
                    guide={guide}
                    now={now}
                    sessionsForGit={sessionCwdsByWorkspace}
                    query={props.query}
                  />
                  <UnregGroup git={props.git.probe} props={props.props} />
                </>
              )
              : (
                <>
                  {props.forest.map(folder => (
                    <FolderRow
                      key={folder.folderId}
                      node={folder}
                      parentName={topLevelLabel}
                      callbacks={callbacks}
                      sessionSeat={sessionSeat}
                      sessionsOverflow={props.sessionsOverflow}
                      onToggleOverflow={props.onToggleOverflow}
                      drag={drag}
                      ancestors={[]}
                      guide={guide}
                      now={now}
                      git={props.git.probe}
                      gitMarkers={props.git.markers}
                      sessionsForGit={sessionCwdsByWorkspace}
                      expandedKeys={expandedKeys}
                    />
                  ))}
                  <WorkspaceDropRegion
                    active={drag.appendWorkspaceFolderId === ROOT_FOLDER_ID}
                    label={t('dropWorkspaceTopLevelEnd')}
                    depth={0}
                  >
                    {props.topLevel.map(leaf => (
                      <LeafRow
                        key={leaf.key}
                        leaf={leaf}
                        ancestors={[]}
                        callbacks={callbacks}
                        sessionSeat={sessionSeat}
                        sessionsOverflow={props.sessionsOverflow}
                        onToggleOverflow={props.onToggleOverflow}
                        drag={drag}
                        guide={guide}
                        now={now}
                        git={props.git.probe}
                        gitMarkers={props.git.markers}
                        sessionsForGit={sessionCwdsByWorkspace(leaf.workspaceId as WorkspaceId)}
                        expandedKeys={expandedKeys}
                      />
                    ))}
                  </WorkspaceDropRegion>
                  {props.ungrouped !== undefined && (
                    <LeafRow
                      leaf={props.ungrouped}
                      ancestors={[]}
                      callbacks={callbacks}
                      sessionSeat={sessionSeat}
                      sessionsOverflow={props.sessionsOverflow}
                      onToggleOverflow={props.onToggleOverflow}
                      drag={drag}
                      guide={guide}
                      now={now}
                      git={null}
                      gitMarkers={props.git.markers}
                      sessionsForGit={[]}
                    />
                  )}
                  <UnregGroup git={props.git.probe} props={props.props} />
                </>
              )}
          </section>
        )
        : null}
      </>
        )
        : (
          // v2 service path: the provider owns the tree framework — the
          // guide seat, chevron/fold interactions and the row chrome all live
          // inside its FileTree; this module only injects the row models
          // (ServiceGroupedView builds the recents + "all" section forests).
          <ServiceGroupedView
            props={props.props}
            fileTreeUi={props.fileTreeUi}
            forest={props.forest}
            topLevel={props.topLevel}
            recents={props.recents}
            ungrouped={props.ungrouped}
            openers={props.openers}
            sessionsOverflow={props.sessionsOverflow}
            onToggleOverflow={props.onToggleOverflow}
            onCollapseRecents={props.onCollapseRecents}
            onCollapseAll={props.onCollapseAll}
            state={state}
            query={props.query}
            git={props.git}
            callbacks={callbacks}
            sessionSeat={sessionSeat}
            drag={drag}
            sessionsForGit={sessionCwdsByWorkspace}
            expandedKeys={expandedKeys}
            now={now}
          />
        )}
    </div>
  )
}

/** Preview the actual append destination without changing row indentation. */
function WorkspaceDropRegion(props: {
  active: boolean
  label: string
  depth: number
  children: ReactNode
}): ReactNode {
  return (
    <div
      className={`${css.dropRegion}${props.active ? ` ${css.workspaceDropRegion}` : ''}`}
      style={props.active ? { backgroundPositionX: `${rowIndent(props.depth)}px` } : undefined}
    >
      {props.children}
      {props.active && (
        <div role="status" className={css.workspaceAppendHint} style={{ marginLeft: `${rowIndent(props.depth)}px` }}>
          <span className={css.workspaceAppendLabel}>{props.label}</span>
        </div>
      )}
    </div>
  )
}

/** One folder row plus its subtree. */
function FolderRow(props: {
  node: FolderNode
  parentName: string
  callbacks: RowCallbacks
  sessionSeat: SessionRowSeat
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  drag: DragSeat
  /** Root-side-first folder chain above this row; column k of the indent
   *  guides belongs to `ancestors[k]`. Empty for top-level folders. */
  ancestors: readonly FolderId[]
  guide: GuideSeat
  /** Current epoch ms, forwarded to the subtree's session hover cards. */
  now: number
  /** Git probe seat forwarded to the subtree's workspace rows. */
  git?: GitProbeResultJSON | null
  /** Remote-mirror marker map forwarded to the subtree's workspace rows. */
  gitMarkers?: ReadonlyMap<string, RemoteGitMarker>
  /** Workspace → session cwd list (git aggregation source). */
  sessionsForGit?: (workspaceId: WorkspaceId | undefined) => readonly { id: SessionId; cwd?: string }[]
  /** Expanded group keys forwarded to the subtree's workspace rows. */
  expandedKeys?: ReadonlySet<string>
}): ReactNode {
  const { node, callbacks } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const dropZone = props.drag.dropZoneOf('folder', node.folderId)
  // Dir-level activity sync: a folder holding the current session — expanded
  // or not — lights its glyph and carries the current-session wash. A
  // collapsed trail still marks every ancestor dir on the path, so the open
  // session stays locatable level by level.
  const active = dirActive(node.containsCurrent)
  // While a guide band is hovered, the ancestor's whole line lights up:
  // every row whose stroke at the hovered column belongs to the same
  // ancestor renders that stroke highlighted — the hovered row included
  // (its band sits on that column), so the full line from the ancestor's
  // corner down through its visible subtree reads as the collapse target.
  const guideColumns = folderGuideColumns(props.ancestors, callbacks.onToggleFolder)
  const highlightCol = guideHighlightColumn(props.guide.hover, guideColumns)
  // The row menu (new subfolder / rename / move / delete) — one shared
  // business list + dispatch for both rendering paths.
  const folderMenuEntries = [
    { id: 'new-subfolder', label: callbacks.t('newSubfolder'), icon: <IconPlusOutline16 /> },
    { id: 'rename', label: callbacks.t('rename'), icon: <IconEditOutline16 /> },
    { id: 'move', label: callbacks.t('move'), icon: <IconFolderOpenOutline16 /> },
    { type: 'separator' as const, id: 'folder-actions-separator' },
    { id: 'delete', label: callbacks.t('deleteFolderTitle'), icon: <IconTrashOutline16 />, danger: true },
  ] satisfies readonly MenuEntry[]
  const onFolderMenuSelect = (id: string): void => {
    setMenuOpen(false)
    if (id === 'new-subfolder') callbacks.openers.onNewSubfolder(node.folderId)
    else if (id === 'rename') callbacks.openers.onRenameFolder(node.folderId, node.name)
    else if (id === 'move') callbacks.openers.onMoveFolder(node.folderId, node.name)
    else if (id === 'delete') callbacks.openers.onDeleteFolder(node.folderId, node.name, props.parentName)
  }
  // Folder drags MOVE: text/plain folder id, and the tree's drag seat keeps
  // the drop-zone judgement (folderDropZone) in the consumer — only the
  // visual three-state goes to the service row.
  const folderDragStart = (event: DragEvent<HTMLDivElement>): void => {
    const transfer = event.dataTransfer
    if (transfer !== null) {
      transfer.effectAllowed = 'move'
      transfer.setData('text/plain', node.folderId)
    }
    props.drag.onDragStart({ kind: 'folder', id: node.folderId })
  }
  const folderDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (props.drag.dragSource === null) return
    event.preventDefault()
    props.drag.onDragOver({
      kind: 'folder',
      id: node.folderId,
      zone: folderDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
    })
  }
  const folderDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      props.drag.onDragLeave('folder', node.folderId)
    }
  }
  const folderDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (props.drag.dragSource === null) return
    event.preventDefault()
    props.drag.onDrop(props.drag.dragSource, {
      kind: 'folder',
      id: node.folderId,
      zone: folderDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
    })
  }
  const folderRow = (
      <div
        className={`${css.folderRow}${active ? ` ${css.folderRowCurrent}` : ''}${dropZone === 'before' ? ` ${css.dropBefore}` : ''}${dropZone === 'after' ? ` ${css.dropAfter}` : ''}${dropZone === 'on' ? ` ${css.dropOn}` : ''}`}
        role="treeitem"
        aria-expanded={node.expanded}
        style={{
          paddingLeft: `${rowIndent(props.ancestors.length)}px`,
          ...guideBackground(props.ancestors.length, node.expanded, highlightCol),
        }}
        draggable
        onDragStart={folderDragStart}
        onDragOver={folderDragOver}
        onDragLeave={folderDragLeave}
        onDrop={folderDrop}
        onDragEnd={() => props.drag.onDragEnd()}
        onClick={() => callbacks.onToggleFolder(node.folderId)}
      >
        {guideHitBands(node.folderId, guideColumns, props.guide.onHover)}
        <span className={css.chevron}>
          <IconTriangleRightFill14 className={node.expanded ? `${css.arrow} ${css.arrowOpen}` : css.arrow} />
        </span>
        <span className={`${css.rowGlyph}${active ? ` ${css.folderActive}` : ''}`}>
          {node.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
        </span>
        <span className={css.rowLabel}>{node.name}</span>
        <span className={css.rowActions}>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={folderMenuEntries}
            onSelect={onFolderMenuSelect}
            dense
            portal
            closeOnPointerLeave
            anchor={(
              <button
                type="button"
                className={css.iconButton}
                aria-label={callbacks.t('rowMenuAria', { name: node.name })}
                onClick={event => { event.stopPropagation(); setMenuOpen(value => !value) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        </span>
      </div>
    )
  return (
    <div className={css.folderBranch}>
      {folderRow}
      {node.expanded
        ? (
          <div className={css.folderChildren}>
            {node.children.map(child => (
              <FolderRow
                key={child.folderId}
                node={child}
                parentName={node.name}
                callbacks={callbacks}
                sessionSeat={props.sessionSeat}
                sessionsOverflow={props.sessionsOverflow}
                onToggleOverflow={props.onToggleOverflow}
                drag={props.drag}
                ancestors={[...props.ancestors, node.folderId]}
                guide={props.guide}
                now={props.now}
              />
            ))}
            <WorkspaceDropRegion
              active={props.drag.appendWorkspaceFolderId === node.folderId}
              label={callbacks.t('dropWorkspaceFolderEnd', { name: node.name })}
              depth={props.ancestors.length + 1}
            >
              {node.workspaceGroups.map(leaf => (
                <LeafRow
                  key={leaf.key}
                  leaf={leaf}
                  ancestors={[...props.ancestors, node.folderId]}
                  callbacks={callbacks}
                  sessionSeat={props.sessionSeat}
                  sessionsOverflow={props.sessionsOverflow}
                  onToggleOverflow={props.onToggleOverflow}
                  drag={props.drag}
                  guide={props.guide}
                  now={props.now}
                  {...(props.git === undefined || props.git === null ? {} : { git: props.git })}
                  {...(props.gitMarkers === undefined ? {} : { gitMarkers: props.gitMarkers })}
                  sessionsForGit={props.sessionsForGit?.(leaf.workspaceId as WorkspaceId) ?? []}
                  {...(props.expandedKeys === undefined ? {} : { expandedKeys: props.expandedKeys })}
                />
              ))}
            </WorkspaceDropRegion>
          </div>
        )
        : null}
    </div>
  )
}

/** One workspace leaf row (or the ungrouped bucket) with its session rows. */
function LeafRow(props: {
  leaf: WorkspaceLeaf
  /** Root-side-first folder chain above this row; every entry is one 8px
   *  indent step AND one indent-guide column (`ancestors[k]` owns column k
   *  — a band click collapses it). Empty for top-level rows. */
  ancestors: readonly FolderId[]
  callbacks: RowCallbacks
  sessionSeat: SessionRowSeat
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  drag: DragSeat
  guide: GuideSeat
  /** Current epoch ms, injected from the tree render for the session rows'
   *  hover-card relative times (one stamp per render pass). */
  now: number
  /** Git probe seat: subworkspace grouping + the cross-tree count row pill. */
  git?: GitProbeResultJSON | null
  /** Remote-mirror marker map: a row whose cwd holds a marker carries its
   *  REMOTE git state (mirrors have no local .git) — shown in the hover
   *  card only; the workspace row itself renders no branch tag. */
  gitMarkers?: ReadonlyMap<string, RemoteGitMarker>
  /** The workspace's sessions with cwd, for the git aggregation. */
  sessionsForGit?: readonly { id: SessionId; cwd?: string }[]
  /** Expanded group keys (subworkspace headers toggle through these). */
  expandedKeys?: ReadonlySet<string>
}): ReactNode {
  const { leaf, callbacks } = props
  const [menuOpen, setMenuOpen] = useState(false)
  // Row hover flips the actions slot between the collapsed-dir busy marker
  // (loading dot, at rest) and the action buttons (on hover) — either/or.
  const [rowHovered, setRowHovered] = useState(false)
  const hasAccount = leaf.workspaceId !== undefined
  const overflowExpanded = props.sessionsOverflow.includes(leaf.key)
  const shownSessions = overflowExpanded
    ? leaf.sessions
    : leaf.sessions.slice(0, COLLAPSED_SESSION_LIMIT)
  // Remote-mirror marker of THIS row (keyed by the normalized workspace
  // path — the dsh-remote fetch layer and the overlay share the spelling).
  const remoteMarker = hasAccount && leaf.cwd !== undefined && props.gitMarkers !== undefined
    ? props.gitMarkers.get(normalizeProbePath(leaf.cwd))
    : undefined
  // Git aggregate pill: 0 trees → nothing; >1 → "n 棵" (cross-tree count). A
  // single tree's branch no longer renders on the row — user feedback; the
  // hover card carries the branch detail (marker or probe alike).
  const gitAggregate = props.git !== null && props.git !== undefined && hasAccount
    ? aggregateWorkspaceTrees(props.sessionsForGit ?? [], props.git)
    : { kind: 'none' } as const
  // Subworkspace grouping (v3): sessions grouped by their cwd's tree; the
  // renderer flattens single-group results (ordinary workspaces keep the
  // built-in shape).
  const gitGroups = props.git !== null && props.git !== undefined && hasAccount && leaf.cwd !== undefined
    ? deriveSubworkspaceGroups(leaf.cwd, props.sessionsForGit ?? [], props.git)
    : []
  const splitGroups = gitGroups.length > 1
  // Hover-card git seat: undefined = probe unavailable (no section),
  // null = probed, no git; an object = the tree + its peer trees.
  const ownTree = props.git !== null && props.git !== undefined && leaf.cwd !== undefined
    ? treeOfCwd(props.git, leaf.cwd)
    : undefined
  const hoverGit = props.git === undefined
    ? undefined
    : props.git === null || ownTree === undefined
      ? null
      : {
        tree: ownTree,
        peers: Object.values(props.git.trees).filter(tree => tree.repoKey === ownTree.repoKey && tree.root !== ownTree.root),
      }
  // "在目标树继续" targets: the other trees of the same repo (registered or
  // not — an unregistered tree registers on the way through).
  const continueTrees = ownTree === undefined || props.git === null || props.git === undefined
    ? []
    : Object.values(props.git.trees)
      .filter(tree => tree.repoKey === ownTree.repoKey && tree.root !== ownTree.root)
      .sort((a, b) => (a.branch ?? a.detached ?? '').localeCompare(b.branch ?? b.detached ?? ''))
  // One indent step per ancestor folder (0 = top level).
  const depth = props.ancestors.length
  const indentPx = rowIndent(depth)
  const dropZone = hasAccount ? props.drag.dropZoneOf('workspace', leaf.workspaceId as string) : undefined
  // Dir-level activity sync: a workspace holding the current session —
  // expanded or not — lights its glyph and carries the current-session wash
  // (recency rows follow the same rule), so a collapsed session list still
  // marks the way to the open session.
  const active = dirActive(leaf.containsCurrent)
  // See FolderRow: while a guide band is hovered, rows that carry the
  // hovered ancestor's column stroke paint it highlighted.
  const folderColumns = folderGuideColumns(props.ancestors, callbacks.onToggleFolder)
  const highlightCol = guideHighlightColumn(props.guide.hover, folderColumns)
  // Collapsed-dir status marker: a folded workspace carries the top-priority
  // session-status dot of its hidden sessions — pending interaction (amber)
  // > working (the pixel-chase loading dot) > completed (green) — seated in
  // the hover-revealed action buttons' slot, mirroring the session rows'
  // own presentation. The slot is EITHER/OR: at rest the dot shows in place
  // of the buttons; on row hover the dot gives way entirely and the actions
  // (menu + new session) take the slot — never both at once.
  const busyState: StateDotState | undefined = (leaf.status.warning ?? 0) > 0
    ? 'warning'
    : (leaf.status.ongoing ?? 0) > 0
      ? 'ongoing'
      : (leaf.status.done ?? 0) > 0
        ? 'done'
        : undefined
  // The built-in path keeps the JS hover mutual exclusion (its stylesheet has
  // no resting-indicator rule — the existing rowBusy spec asserts the element
  // unmounts on hover).
  const busyLabelBuiltin = hasAccount && !leaf.expanded && busyState !== undefined && !rowHovered
    ? workspaceStatusLabel(busyState, leaf.status[busyState] ?? 1, callbacks.t)
    : undefined
  // Session rows hang one level deeper: besides the folder columns they
  // draw the workspace's OWN column (the deepest stroke, at this row's icon
  // column), whose band collapses the session list — the workspace is the
  // "directory" of its sessions, exactly like a folder of a subtree.
  // Recency rows collapse through their prefixed group key the same way.
  const sessionColumns: GuideColumn[] = [
    ...folderColumns,
    { id: leaf.key, onToggle: () => callbacks.onWorkspaceClick(leaf.key) },
  ]
  /** The session list container: the built-in path's continuous guide layer
   *  (paints the full stroke set inline; the service path hands the same
   *  role to the framework's `childrenList: 'layer'`). */
  const sessionListLayer = (children: ReactNode): ReactNode => (
    <div className={css.sessionList} style={{ ...guideBackground(sessionColumns.length, false) }}>
      {children}
    </div>
  )
  // Workspace drags copyMove an `application/x-dsh-reference+json` reference
  // plus the canonical session-reference mention as `text/plain` (what any
  // text surface — the conversation composer first of all — inserts; the
  // drop-zone judgement (rowDropZone) stays in the consumer — only the
  // visual three-state goes to the service row.
  const workspaceDragStart = (event: DragEvent<HTMLDivElement>): void => {
    const transfer = event.dataTransfer
    if (transfer !== null && leaf.workspaceId !== undefined) {
      transfer.effectAllowed = 'copyMove'
      const payload = workspaceReferencePayload({
        id: leaf.workspaceId as string,
        label: leaf.label,
        primarySession: leaf.primarySession,
      })
      transfer.setData(WORKSPACE_REFERENCE_MIME, encodeDragReference(payload))
      transfer.setData('text/plain', payload.mention)
      stashActiveReference(payload)
    }
    props.drag.onDragStart({ kind: 'workspace', id: leaf.workspaceId as string })
  }
  const workspaceDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (props.drag.dragSource === null) return
    event.preventDefault()
    props.drag.onDragOver({
      kind: 'workspace',
      id: leaf.workspaceId as string,
      zone: rowDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
    })
  }
  const workspaceDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      props.drag.onDragLeave('workspace', leaf.workspaceId as string)
    }
  }
  const workspaceDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (props.drag.dragSource === null) return
    event.preventDefault()
    props.drag.onDrop(props.drag.dragSource, {
      kind: 'workspace',
      id: leaf.workspaceId as string,
      zone: rowDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
    })
  }
  const workspaceRowClick = (): void => {
    if (hasAccount) callbacks.onWorkspaceClick(leaf.key)
    else callbacks.onToggleGroup(leaf.key)
  }
  const ownRow = (
    <div
      className={`${css.workspaceRow}${active ? ` ${css.workspaceRowCurrent}` : ''}${dropZone === 'before' ? ` ${css.dropBefore}` : ''}${dropZone === 'after' ? ` ${css.dropAfter}` : ''}${dropZone === 'on' ? ` ${css.dropOn}` : ''}`}
      role="treeitem"
      aria-expanded={leaf.expanded}
      style={{
        paddingLeft: `${indentPx}px`,
        ...guideBackground(depth, leaf.expanded, highlightCol),
      }}
      draggable={hasAccount}
      onDragStart={hasAccount ? workspaceDragStart : undefined}
      onDragOver={hasAccount ? workspaceDragOver : undefined}
      onDragLeave={hasAccount ? workspaceDragLeave : undefined}
      onDrop={hasAccount ? workspaceDrop : undefined}
      onDragEnd={hasAccount ? () => props.drag.onDragEnd() : undefined}
      onMouseEnter={() => setRowHovered(true)}
      onMouseLeave={() => setRowHovered(false)}
      onClick={workspaceRowClick}
    >
      {guideHitBands(leaf.key, folderColumns, props.guide.onHover)}
      <span className={css.chevron}>
        <IconTriangleRightFill14 className={leaf.expanded ? `${css.arrow} ${css.arrowOpen}` : css.arrow} />
      </span>
      <span className={`${css.rowGlyph}${active ? ` ${css.folderActive}` : ''}`}>
        {leaf.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
      </span>
      <span className={css.rowLabel}>{leaf.label}</span>
      {gitAggregate.kind === 'multi' && (
        <span className={css.gitPillMulti} title={`${gitAggregate.trees.length} 棵树的会话`}>
          {gitAggregate.trees.length} 棵
        </span>
      )}
      <span className={css.rowActions}>
        {hasAccount && (
          <>
            <Menu
              open={menuOpen}
              onClose={() => { setMenuOpen(false) }}
              items={[
                { id: 'rename', label: callbacks.t('rename'), icon: <IconEditOutline16 /> },
                { id: 'move', label: callbacks.t('move'), icon: <IconFolderOpenOutline16 /> },
                ...(continueTrees.length > 0
                  ? [
                    { type: 'label' as const, id: 'continue-label', text: callbacks.t('continueInTree') },
                    ...continueTrees.map(tree => ({
                      id: `tree:${tree.root}`,
                      label: tree.branch ?? tree.detached ?? basename(tree.root),
                      icon: <IconBranchOutline16 />,
                    })),
                  ]
                  : []),
                { type: 'separator' as const, id: 'workspace-actions-separator' },
                { id: 'delete', label: callbacks.t('deleteWorkspaceTitle'), icon: <IconTrashOutline16 />, danger: true },
              ]}
              onSelect={(id) => {
                setMenuOpen(false)
                if (id === 'rename') callbacks.openers.onRenameWorkspace(leaf.workspaceId as WorkspaceId, leaf.label)
                else if (id === 'move') callbacks.openers.onMoveWorkspace(leaf.workspaceId as WorkspaceId, leaf.label)
                else if (id === 'delete') callbacks.openers.onDeleteWorkspace(leaf.workspaceId as WorkspaceId, leaf.label)
                else if (id.startsWith('tree:')) {
                  const root = id.slice('tree:'.length)
                  const tree = continueTrees.find(candidate => candidate.root === root)
                  if (tree !== undefined) callbacks.onContinueInTree?.(tree, leaf.workspaceId)
                }
              }}
              dense
              portal
              closeOnPointerLeave
              anchor={(
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={callbacks.t('rowMenuAria', { name: leaf.label })}
                  onClick={event => { event.stopPropagation(); setMenuOpen(value => !value) }}
                >
                  <IconEllipsisOutline16 />
                </button>
              )}
            />
            <button
              type="button"
              className={css.iconButton}
              aria-label={callbacks.t('newSessionAria', { name: leaf.label })}
              onClick={event => {
                event.stopPropagation()
                callbacks.onStartSession(leaf.workspaceId as WorkspaceId, leaf.key)
              }}
            >
              <IconPlusOutline16 />
            </button>
          </>
        )}
      </span>
      {/* The collapsed-dir status marker occupies the actions slot (right
          edge, where the hover-revealed buttons live): the session rows'
          own dot — amber waiting / loading working / green completed — at
          rest; on row hover it yields the slot to the action buttons
          (either/or, never both). */}
      {busyLabelBuiltin !== undefined && busyState !== undefined && (
        <span className={css.rowBusy} title={busyLabelBuiltin}>
          <StateDot state={busyState} />
          <span className={css.visuallyHidden}>{busyLabelBuiltin}</span>
        </span>
      )}
    </div>
  )
  // The workspace hover card (built-in parity): real Workspace rows show
  // their directory and creation time on dwelling, and the whole card is a
  // copy target for the full path. The ungrouped bucket has no backing
  // Workspace — no card. An open row menu suppresses the card for the same
  // hover (the ellipsis menu is the row's only other dwell surface).
  const rowElement = hasAccount
    ? (
      <HoverCard
        anchor={ownRow}
        content={(
          <WorkspaceHoverContent
            label={leaf.label}
            cwd={leaf.cwd}
            createdAt={leaf.createdAt ?? 0}
            t={callbacks.t}
            status={leaf.status}
            {...(hoverGit === undefined ? {} : { git: hoverGit })}
            {...(remoteMarker === undefined ? {} : { remote: remoteMarker })}
          />
        )}
        disabled={menuOpen}
        copyText={leaf.cwd}
        copyLabel={callbacks.t('copy')}
        copiedLabel={callbacks.t('hoverCopied')}
      />
    )
    : ownRow
  return (
    <div className={css.leafBranch}>
      {rowElement}
      {leaf.expanded
        ? splitGroups
          ? (
            // Subworkspace grouping: the workspace's sessions split by their
            // cwd's tree (own tree / linked tree / no git). Group headers
            // toggle through `tw:`-prefixed group keys (cleared by the
            // section collapse-all like every non-recent key). The LIST
            // container paints the full stroke set (folder columns + the
            // workspace's own column), so the lines run continuously through
            // the group headers, the overflow button, and the 1px row gaps —
            // the session rows' own layers keep only the hover highlight.
            sessionListLayer(
              <>
                {gitGroups.map(group => {
                const subKey = `${SUBWS_GROUP_KEY_PREFIX}${leaf.key}:${group.key}`
                const groupOpen = props.expandedKeys?.has(subKey) ?? false
                const groupSessions = leaf.sessions.filter(session => group.sessionIds.includes(session.id))
                const shown = props.sessionsOverflow.includes(subKey)
                  ? groupSessions
                  : groupSessions.slice(0, COLLAPSED_SESSION_LIMIT)
                const label = group.own
                  ? callbacks.t('subwsOwn', { name: leaf.label })
                  : (group.tree?.branch ?? group.tree?.detached ?? callbacks.t('subwsNogit'))
                return (
                  <div key={subKey}>
                    <div
                      className={css.subwsRow}
                      role="treeitem"
                      aria-expanded={groupOpen}
                      style={{
                        paddingLeft: `${indentPx + SESSION_INDENT_OFFSET_PX}px`,
                        // The header hangs off the workspace like a folder of
                        // its group's sessions: same ancestor strokes (the
                        // container's layer carries them through the row —
                        // this row's layer only lights the hovered one).
                        ...guideBackground(sessionColumns.length, false, guideHighlightColumn(props.guide.hover, sessionColumns)),
                      }}
                      onClick={() => { callbacks.onToggleGroup(subKey) }}
                    >
                      {guideHitBands(subKey, sessionColumns, props.guide.onHover)}
                      <span className={css.chevron}>
                        <IconTriangleRightFill14 className={groupOpen ? `${css.arrow} ${css.arrowOpen}` : css.arrow} />
                      </span>
                      <span className={css.rowLabel}>{label}</span>
                      {group.tree !== undefined && (
                        <span
                          className={`${css.gitPill}${group.tree.role === 'main' ? ` ${css.gitPillMain}` : ''}`}
                        >
                          {group.tree.branch ?? group.tree.detached}
                        </span>
                      )}
                      <span className={css.sessionCount}>{group.sessionIds.length}</span>
                    </div>
                    {groupOpen && (
                      <>
                        {shown.map(session => (
                          <SessionRow key={session.id} session={session} seat={props.sessionSeat} onOpen={props.sessionSeat.onOpen} indent={indentPx + 16} columns={sessionColumns} guide={props.guide} now={props.now} />
                        ))}
                        {groupSessions.length > COLLAPSED_SESSION_LIMIT && (
                          <button
                            type="button"
                            className={css.overflowButton}
                            style={{ marginLeft: `${indentPx + SESSION_INDENT_OFFSET_PX + 24}px` }}
                            aria-expanded={props.sessionsOverflow.includes(subKey)}
                            onClick={() => { props.onToggleOverflow(subKey) }}
                          >
                            {props.sessionsOverflow.includes(subKey)
                              ? callbacks.t('sessionsCollapse')
                              : callbacks.t('sessionsExpand', { n: groupSessions.length - COLLAPSED_SESSION_LIMIT })}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
              </>
              ,
            )
          )
          : sessionListLayer(
            <>
              {shownSessions.map(session => (
                <SessionRow key={session.id} session={session} seat={props.sessionSeat} onOpen={props.sessionSeat.onOpen} indent={indentPx} columns={sessionColumns} guide={props.guide} now={props.now} />
              ))}
              {leaf.sessions.length > COLLAPSED_SESSION_LIMIT && (
                <button
                  type="button"
                  className={css.overflowButton}
                  style={{ marginLeft: `${indentPx + SESSION_INDENT_OFFSET_PX}px` }}
                  aria-expanded={overflowExpanded}
                  onClick={() => { props.onToggleOverflow(leaf.key) }}
                >
                  {overflowExpanded
                    ? callbacks.t('sessionsCollapse')
                    : callbacks.t('sessionsExpand', { n: leaf.sessions.length - COLLAPSED_SESSION_LIMIT })}
                </button>
              )}
            </>,
          )
        : null}
    </div>
  )
}

/**
 * The row's elevation annotation: a small amber shield beside the label
 * marks one pending approval whose grant would ELEVATE the sandbox (the
 * flavor `approveEscalation` requests). The built-in tree renders that
 * flavor as the same plain waiting-approval dot; the plugin's own marker
 * separates it out (see `pendingInteractionOf` — the annotation rides the
 * stable `escalate sandbox to` reason prefix and vanishes when the approval
 * clears). The meaning lives in the row's status text (sr-only) and the
 * hover card; the glyph itself is decorative.
 */
function EscalationMark({ label }: { label: string }): ReactNode {
  return (
    <span className={css.escalationMark} title={label} aria-hidden="true">
      <svg width="12" height="14" viewBox="0 0 14 16" fill="none" aria-hidden="true">
        <path
          d="M7 0.8 L13 3.2 V7.4 C13 11 10.4 14 7 15.2 C3.6 14 1 11 1 7.4 V3.2 Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  )
}

/** One session row (status dot + title + row action menu) with its hover card. */
function SessionRow(props: {
  session: SessionNode
  seat: SessionRowSeat
  onOpen: (sessionId: SessionId) => void
  /** Workspace-row left inset; absent keeps the flat-list CSS inset. */
  indent?: number
  /** The row's guide columns: the workspace's folder ancestors plus the
   *  workspace's OWN column (the deepest stroke — sessions hang off their
   *  workspace, and its band collapses the session list). Absent → the row
   *  renders without guides (flat list / search rows). */
  columns?: readonly GuideColumn[]
  guide?: GuideSeat
  /** Current epoch ms for the hover card's relative-time stamp. */
  now: number
}): ReactNode {
  const { session, seat } = props
  const [menuOpen, setMenuOpen] = useState(false)
  // Explicit field spread: exactOptionalPropertyTypes forbids passing the
  // optional-typed SessionNode straight into the required `| undefined` seats.
  const dot = sessionStatusDot({
    pendingInteraction: session.pendingInteraction,
    running: session.running,
    runningSubagentCount: session.runningSubagentCount,
    completed: session.completed,
    blank: session.blank,
  })
  const dotLabel = dot === 'warning'
    // The escalation flavor gets its own annotation — the reason prefix told
    // it apart from plain approvals (see pendingInteractionOf) — so the
    // row's status text names the elevation, not the generic wait.
    ? session.pendingInteraction === 'escalation' ? seat.t('sessionStatusEscalation') : seat.t('sessionStatusWarning')
    : dot === 'ongoing' ? seat.t('sessionStatusOngoing')
      : dot === 'done' ? seat.t('sessionStatusDone') : undefined
  // See FolderRow: the session rows are the deepest leaf level — they carry
  // every ancestor stroke (folders plus the workspace's own column) and the
  // hovered ancestor's line lights up through them too.
  const highlightCol = guideHighlightColumn(props.guide?.hover ?? null, props.columns ?? [])
  // The row menu entries (rename / fork / archive) — one shared business
  // list for both rendering paths (built-in Menu / service RowMenu).
  const menuEntries = [
    { id: 'rename', label: seat.t('rename'), icon: <IconEditOutline16 /> },
    { id: 'fork', label: seat.t('sessionFork'), icon: <IconBranchOutline16 /> },
    { id: 'archive', label: seat.t('sessionArchive'), icon: <IconArchiveOutline20 size={16} /> },
  ] satisfies readonly MenuEntry[]
  // Item selection: RowMenu already closes the menu before the callback;
  // the built-in Menu path closes in the same handler — both end at the
  // same business dispatch.
  const onMenuSelect = (id: string): void => {
    setMenuOpen(false)
    if (id === 'rename') seat.onRename(session.id, session.title)
    else if (id === 'fork') seat.onFork(session.id)
    else if (id === 'archive') seat.onArchive(session.id)
  }
  // Session drags copy a reference (`application/x-dsh-reference+json`)
  // plus the canonical session-reference mention as `text/plain` and do not
  // enter the tree's move state — identical for both paths.
  const sessionDragStart = (event: DragEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.dataTransfer === null) return
    event.dataTransfer.effectAllowed = 'copy'
    const payload = sessionReferencePayload({
      id: session.id as string,
      label: session.title === '' ? undefined : session.title,
    })
    event.dataTransfer.setData(WORKSPACE_REFERENCE_MIME, encodeDragReference(payload))
    event.dataTransfer.setData('text/plain', payload.mention)
    stashActiveReference(payload)
  }
  // The status-dot leading slot (16px fixed, with a visually hidden label).
  const statusSlot = (
    <span className={css.sessionStatusSlot}>
      {dot !== undefined && (
        <>
          <StateDot state={dot} />
          <span className={css.visuallyHidden}>{dotLabel}</span>
        </>
      )}
    </span>
  )
  const ownRow = (
      <div
        className={`${css.sessionRow}${session.current ? ` ${css.sessionRowCurrent}` : ''}`}
        role="treeitem"
        style={{
          ...(props.indent === undefined ? undefined : { paddingLeft: `${props.indent + SESSION_INDENT_OFFSET_PX}px` }),
          ...(props.columns === undefined ? undefined : guideBackground(props.columns.length, false, highlightCol)),
        }}
        draggable={!session.blank}
        onDragStart={sessionDragStart}
        onClick={() => props.onOpen(session.id)}
      >
        {props.columns !== undefined && props.guide !== undefined && props.columns.length > 0
          ? guideHitBands(session.id, props.columns, props.guide.onHover)
          : null}
        {statusSlot}
        <span className={css.rowLabel}>{session.blank ? seat.t('newSession') : session.title}</span>
        {session.pendingInteraction === 'escalation' && (
          <EscalationMark label={seat.t('sessionStatusEscalation')} />
        )}
        {!session.blank && (
          <span className={css.rowActions}>
            <Menu
              open={menuOpen}
              onClose={() => { setMenuOpen(false) }}
              items={menuEntries}
              onSelect={onMenuSelect}
              dense
              portal
              closeOnPointerLeave
              anchor={(
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={seat.t('rowMenuAria', { name: session.title })}
                  onClick={event => { event.stopPropagation(); setMenuOpen(value => !value) }}
                >
                  <IconEllipsisOutline16 />
                </button>
              )}
            />
          </span>
        )}
      </div>
    )
  // The session hover card (built-in parity): title, relative time, every
  // live status, and the file domain. An open row menu suppresses it for
  // the same hover.
  return (
    <HoverCard
      anchor={ownRow}
      content={<SessionHoverContent node={session} now={props.now} t={seat.t} />}
      disabled={menuOpen}
      copyLabel={seat.t('copy')}
      copiedLabel={seat.t('copied')}
    />
  )
}

/** The flat session list ("In one list" mode). */
function FlatList(props: {
  props: EnhancedWorkspaceBrowserProps
  rows: readonly SessionNode[]
  onRename: (sessionId: SessionId, title: string) => void
  /** The optional fileTreeUi v2 service: when present the whole flat list
   *  renders through one `renderFileTree` (row models; undefined → the
   *  built-in list below). */
  fileTreeUi: FileTreeUiServiceV2 | undefined
}): ReactNode {
  const seat: SessionRowSeat = {
    onOpen: sessionId => props.props.open(sessionId),
    onRename: props.onRename,
    onFork: sessionId => props.props.forkSession(sessionId),
    onArchive: sessionId => {
      props.props.archiveSession(sessionId).catch((error: unknown) => {
        console.warn('dsh-enhanced-workspace: session archive rejected', error)
      })
    },
    t: props.props.t,
  }
  // One relative-time stamp per render pass, shared by every session row's
  // hover card (the same posture as the built-in tree).
  const now = Date.now()
  // The v2 service path owns the per-row menu state (the row components are
  // not mounted — the models' actions read/write this seat).
  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>({})
  const menu: MenuSeat = {
    open: key => openMenus[key] === true,
    onOpenChange: (key, open) => setOpenMenus(prev => prev[key] === open ? prev : { ...prev, [key]: open }),
  }
  const fileTreeUi = props.fileTreeUi
  if (fileTreeUi !== undefined) {
    return fileTreeUi.renderFileTree({
      treeKey: 'flat',
      rows: props.rows.map(session => sessionRowModel({
        session,
        seat,
        onOpen: seat.onOpen,
        now,
        menu,
        fileTreeUi,
      })),
      className: css.flatList,
    })
  }
  return (
    <div className={css.flatList}>
      {props.rows.map(session => (
        <SessionRow key={session.id} session={session} seat={seat} onOpen={seat.onOpen} now={now} />
      ))}
    </div>
  )
}

/* =====================================================================
 * Git-repo grouping view ("按仓库分组", v3): repo group rows (folder-row
 * form) with their workspace members, the no-git workspaces flattened
 * below, and the unregistered-worktree group last. All read the probe
 * result; `probe: null` renders the section without any git furniture.
 * ===================================================================== */

/** Workspace-title/path/branch/session-title match for the repo filter. */
function repoMatch(
  workspace: { workspaceId: WorkspaceId; title: string; path: string },
  sessions: readonly { id: SessionId; title?: string; cwd?: string }[],
  probe: GitProbeResultJSON,
  q: string,
): boolean {
  if (q === '') return true
  if (workspace.title.includes(q) || workspace.path.includes(q)) return true
  for (const session of sessions) {
    if (session.title !== undefined && session.title.includes(q)) return true
    const tree = treeOfCwd(probe, session.cwd)
    if (tree !== undefined && tree.branch?.includes(q)) return true
    if (tree !== undefined && tree.detached?.includes(q)) return true
  }
  return false
}

/** The "按仓库分组" body: repo groups + no-git workspaces, filtered by query. */
function RepoForestView(props: {
  props: EnhancedWorkspaceBrowserProps
  git: { probe: GitProbeResultJSON | null; markers: ReadonlyMap<string, RemoteGitMarker>; onRefresh: () => void }
  callbacks: RowCallbacks
  sessionSeat: SessionRowSeat
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  drag: DragSeat
  guide: GuideSeat
  now: number
  query: string
  sessionsForGit: (workspaceId: WorkspaceId | undefined) => readonly { id: SessionId; cwd?: string }[]
}): ReactNode {
  const { t, actions } = props.props
  const state = props.props.useStore(identity)
  const workspaces = props.props.useWorkspaces(identity)
  const sessions = props.props.useSessions(identity)
  const pendingInteractions = sessionPendingInteractionsOf(props.props.useSessionPendingInteraction(identity))
  const probe = props.git.probe
  const q = props.query.trim().toLowerCase()
  const callbacks = props.callbacks
  const sessionSeat = props.sessionSeat
  const expandedKeys = useMemo(() => {
    const set = new Set<string>()
    for (const [key, value] of Object.entries(state.groupExpansion)) if (value) set.add(key)
    return set
  }, [state.groupExpansion])
  if (probe === null) {
    return <div className={css.searchStatus} role="status">{t('searchNoMatches')}</div>
  }
  const { repos, nogit } = deriveRepoGroups(probe, workspaces.items)
  const workspaceById = new Map(workspaces.items.map(workspace => [workspace.workspaceId, workspace]))
  const sessionTitlesOf = (workspaceId: WorkspaceId): { id: SessionId; title?: string; cwd?: string }[] =>
    (workspaceById.get(workspaceId)?.sessionIds as SessionId[] | undefined)?.map(id => {
      const summary = sessions.byId[id]
      if (summary === undefined) return { id } as { id: SessionId; title?: string; cwd?: string }
      return summary.cwd === undefined
        ? { id, title: summary.displayTitle } as { id: SessionId; title?: string; cwd?: string }
        : { id, title: summary.displayTitle, cwd: summary.cwd } as { id: SessionId; title?: string; cwd?: string }
    }) ?? []
  const visibleRepos = repos
    .map(repo => ({
      ...repo,
      members: repo.workspaceIds.filter(id => {
        const workspace = workspaceById.get(id)
        return workspace !== undefined && repoMatch(workspace, sessionTitlesOf(id), probe, q)
      }),
    }))
    .filter(repo => repo.members.length > 0 || repo.name.includes(q))
  return (
    <>
      {visibleRepos.map(repo => (
        <RepoGroupRow
          key={repo.repoKey}
          repo={repo}
          probe={probe}
          gitMarkers={props.git.markers}
          workspaceById={workspaceById}
          sessions={sessions}
          state={state}
          callbacks={callbacks}
          sessionSeat={sessionSeat}
          sessionsOverflow={props.sessionsOverflow}
          onToggleOverflow={props.onToggleOverflow}
          drag={props.drag}
          guide={props.guide}
          now={props.now}
          sessionsForGit={props.sessionsForGit}
          expandedKeys={expandedKeys}
          actions={actions}
          onRefresh={props.git.onRefresh}
          t={t}
        />
      ))}
      {nogit.length > 0 && (
        <>
          <div className={css.gitNote}>{t('noGitWorkspaces')}</div>
          {nogit.map(workspaceId => {
            const leaf = sessionLeafOf(workspaceById.get(workspaceId), sessions, state, pendingInteractions)
            if (leaf === undefined) return null
            return (
              <LeafRow
                key={workspaceId as string}
                leaf={leaf}
                ancestors={[]}
                callbacks={callbacks}
                sessionSeat={sessionSeat}
                sessionsOverflow={props.sessionsOverflow}
                onToggleOverflow={props.onToggleOverflow}
                drag={props.drag}
                guide={props.guide}
                now={props.now}
                git={null}
                gitMarkers={props.git.markers}
                sessionsForGit={[]}
                expandedKeys={expandedKeys}
              />
            )
          })}
        </>
      )}
    </>
  )
}

/** One repo group row plus its workspace members (per-row menu state). */
function RepoGroupRow(props: {
  repo: GitRepoGroupDerived
  probe: GitProbeResultJSON
  /** Remote-mirror marker map forwarded to the member rows. */
  gitMarkers: ReadonlyMap<string, RemoteGitMarker>
  workspaceById: Map<WorkspaceId, WorkspaceView>
  sessions: SessionListState
  state: { groupExpansion: Record<string, boolean>; folderExpansion: Record<string, boolean> }
  callbacks: RowCallbacks
  sessionSeat: SessionRowSeat
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  drag: DragSeat
  guide: GuideSeat
  now: number
  sessionsForGit: (workspaceId: WorkspaceId | undefined) => readonly { id: SessionId; cwd?: string }[]
  expandedKeys: ReadonlySet<string>
  actions: EnhancedWorkspaceBrowserProps['actions']
  onRefresh: () => void
  t: EnhancedWorkspaceBrowserProps['t']
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const repoKey = `${REPO_GROUP_KEY_PREFIX}${props.repo.repoKey}`
  const open = props.state.groupExpansion[repoKey] === true
  const repoGroupRow = (
      <div
        className={css.repoRow}
        role="treeitem"
        aria-expanded={open}
        onClick={() => { props.actions.setGroupExpanded(repoKey, !open) }}
      >
        <span className={css.chevron}>
          <IconTriangleRightFill14 className={open ? `${css.arrow} ${css.arrowOpen}` : css.arrow} />
        </span>
        <span className={`${css.rowGlyph}${open ? ` ${css.folderActive}` : ''}`}>
          {open ? <IconFolderOpen16 /> : <IconFolderClose16 />}
        </span>
        <span className={css.rowLabel}>{props.repo.name}</span>
        <span className={css.gitPillMain}>{props.t('groupByRepo')}</span>
        <span className={css.sessionCount}>{props.repo.workspaceIds.length}</span>
        <span className={css.rowActions}>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={[
              { id: 'refresh', label: props.t('refreshGitProbe'), icon: <IconBranchOutline16 /> },
              { id: 'organize', label: props.t('organizeIntoFolder'), icon: <IconFolderOpenOutline16 /> },
            ]}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'refresh') props.onRefresh()
            }}
            dense
            portal
            closeOnPointerLeave
            anchor={(
              <button
                type="button"
                className={css.iconButton}
                aria-label={props.t('refreshGitProbe')}
                onClick={event => { event.stopPropagation(); setMenuOpen(value => !value) }}
              >
                <IconEllipsisOutline16 />
              </button>
            )}
          />
        </span>
      </div>
    )
  return (
    <div>
      {repoGroupRow}
      {open && (
        <div className={css.repoChildren}>
          {props.repo.workspaceIds.map((workspaceId: WorkspaceId) => {
            const leaf = sessionLeafOf(props.workspaceById.get(workspaceId), props.sessions, props.state)
            if (leaf === undefined) return null
            return (
              <LeafRow
                key={workspaceId as string}
                leaf={leaf}
                ancestors={[]}
                callbacks={props.callbacks}
                sessionSeat={props.sessionSeat}
                sessionsOverflow={props.sessionsOverflow}
                onToggleOverflow={props.onToggleOverflow}
                drag={props.drag}
                guide={props.guide}
                now={props.now}
                git={props.probe}
                gitMarkers={props.gitMarkers}
                sessionsForGit={props.sessionsForGit(workspaceId)}
                expandedKeys={props.expandedKeys}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

/** Build a leaf row for one workspace (session rows populated when expanded). */
function sessionLeafOf(
  workspace: WorkspaceView | undefined,
  sessions: SessionListState,
  state: { groupExpansion: Record<string, boolean>; folderExpansion: Record<string, boolean> },
  pending: SessionPendingInteractions = new Map(),
): WorkspaceLeaf | undefined {
  if (workspace === undefined) return undefined
  const expanded = state.groupExpansion[workspace.workspaceId] === true
  // The row's visible members (blank / subagent rows off the rows and off
  // the working count — the same filter the session rows below apply).
  const members = workspace.sessionIds
    .map(id => sessions.byId[id as SessionId])
    .filter((summary): summary is SessionSummary => summary !== undefined)
    .filter(summary => !summary.blank && summary.origin !== 'subagent')
  const primarySession = referenceSessionOf(members, sessions.current)
  return {
    key: workspace.workspaceId,
    workspaceId: workspace.workspaceId,
    cwd: workspace.path,
    createdAt: Date.parse(workspace.createdAt),
    label: workspace.title,
    sessionCount: workspace.sessionIds.length,
    expanded,
    containsCurrent: sessions.current !== undefined && workspace.sessionIds.includes(sessions.current as SessionId),
    ...(primarySession === undefined ? {} : { primarySession }),
    // Repo-group leaves carry no subagent descendant index (their session
    // rows render runningSubagentCount: 0 too) — own activity only.
    status: workspaceSessionStatus(members, undefined, pending),
    sessions: expanded
      ? members.map((summary): SessionNode => {
        const pendingInteraction = pendingInteractionOf(pending.get(summary.id))
        return {
          id: summary.id,
          current: summary.id === sessions.current,
          title: summary.blank ? '' : summary.displayTitle,
          blank: summary.blank,
          running: summary.running,
          runningSubagentCount: 0,
          completed: summary.completed === true,
          updatedAt: summary.updatedAt,
          recentInputs: [],
          recentOutputs: [],
          ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
          ...(pendingInteraction === undefined ? {} : { pendingInteraction }),
        }
      })
      : [],
  }
}

/** The "未注册工作树" group: trees the probe knows but no workspace/session
 *  path binds to — one-click registration adopts them as workspaces. */
function UnregGroup(props: {
  git: GitProbeResultJSON | null
  props: EnhancedWorkspaceBrowserProps
}): ReactNode {
  const { t, actions } = props.props
  // EVERY hook runs before the probe-availability early return: a hook after
  // a conditional return changes the hook order when the probe lands
  // (React: "Rendered more hooks than during the previous render" → the
  // slot error boundary tears the whole region down).
  const state = props.props.useStore(identity)
  const workspaces = props.props.useWorkspaces(identity)
  const sessions = props.props.useSessions(identity)
  if (props.git === null) return null
  const referenced = new Set<string>()
  for (const workspace of workspaces.items) referenced.add(workspace.path)
  for (const session of Object.values(sessions.byId)) {
    if (session.cwd !== undefined && session.cwd !== '') referenced.add(session.cwd)
  }
  const unreg = unregisteredTrees(props.git, [...referenced])
  if (unreg.length === 0) return null
  const key = 'tw:unreg'
  const open = state.groupExpansion[key] === true
  const register = (root: string): void => {
    void props.props.createWorkspace({ path: root })
      .then(created => { actions.adoptWorkspace(created.workspaceId) })
      .catch(error => { console.warn('dsh-enhanced-workspace: register worktree failed', root, error) })
  }
  // The unregistered-tree group header shares the repo-row look (30px /
  // 7px / `padding: 0 6px` — overridden inline so the geometry is
  // deterministic regardless of stylesheet order).
  const unregHeader = (
      <div
        className={css.repoRow}
        role="treeitem"
        aria-expanded={open}
        onClick={() => { actions.setGroupExpanded(key, !open) }}
      >
        <span className={css.chevron}>
          <IconTriangleRightFill14 className={open ? `${css.arrow} ${css.arrowOpen}` : css.arrow} />
        </span>
        <span className={css.rowGlyph}>
          <IconFolderClose16 />
        </span>
        <span className={css.rowLabel}>{t('unregTreeGroup')}</span>
        <span className={css.sessionCount}>{unreg.length}</span>
      </div>
    )
  return (
    <div>
      {unregHeader}
      {open && (
        <div className={css.repoChildren}>
          {unreg.map(tree => (
            <div key={tree.root}>
              <div className={css.unregRow} onClick={() => { register(tree.root) }}>
                <span className={css.rowGlyph}>
                  <IconFolderClose16 />
                </span>
                <span className={css.rowLabel}>{basename(tree.root)}</span>
                <span className={css.gitPill}>{tree.detached ?? tree.branch}</span>
                <span className={css.registerButton}>{t('registerTree')}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* =====================================================================
 * fileTreeUi v2 service path: whole-tree MODEL building. When the provider
 * service is present the tree chrome (container/subtrees, indent guides,
 * hover seat, chevron + fold interaction, fold animations, row chrome) is
 * the provider's FileTree framework; this module only builds the
 * FileTreeRowModel forests per section (the recency module and the "all"
 * section — one renderFileTree call each) and injects the per-row content,
 * expansion state data (expanded + onToggle) and DOM semantics. The
 * built-in fallback path above stays byte-for-byte the pre-v2 shape.
 * ===================================================================== */

/** v2 service path: per-row menu open state, hoisted to the section level
 *  (the row components are not mounted when the framework renders the tree)
 *  and keyed by the row's model key. */
interface MenuSeat {
  open: (key: string) => boolean
  onOpenChange: (key: string, open: boolean) => void
}

/** The workspace-append drop preview: an injected non-row FileTreeNode that
 *  appears at the folder's (or the top level's) workspace-group end while an
 *  append is armed — the built-in WorkspaceDropRegion marker, standalone. */
function workspaceAppendHintNode(props: {
  key: string
  active: boolean
  label: string
  depth: number
}): FileTreeNode {
  if (!props.active) return null
  return (
    <div
      key={props.key}
      className={`${css.dropRegion} ${css.workspaceDropRegion}`}
      style={{ backgroundPositionX: `${rowIndent(props.depth)}px` }}
    >
      <div role="status" className={css.workspaceAppendHint} style={{ marginLeft: `${rowIndent(props.depth)}px` }}>
        <span className={css.workspaceAppendLabel}>{props.label}</span>
      </div>
    </div>
  )
}

/** The session-list overflow control: an injected non-row FileTreeNode at
 *  the end of the session list (inside the framework's layer container —
 *  the container's strokes run through it like the built-in path). */
function overflowButtonNode(props: {
  key: string
  total: number
  expanded: boolean
  marginLeft: number
  t: EnhancedWorkspaceBrowserProps['t']
  onToggle: () => void
}): FileTreeNode {
  if (props.total <= COLLAPSED_SESSION_LIMIT) return null
  return (
    <button
      key={props.key}
      type="button"
      className={css.overflowButton}
      style={{ marginLeft: `${props.marginLeft}px` }}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
    >
      {props.expanded
        ? props.t('sessionsCollapse')
        : props.t('sessionsExpand', { n: props.total - COLLAPSED_SESSION_LIMIT })}
    </button>
  )
}

/** One session row model (status dot + title + row menu + hover card).
 *  Flat-list rows (no indent/columns) render without guides — the compact
 *  CSS fallback padding seats them under the guide columns. */
function sessionRowModel(props: {
  session: SessionNode
  seat: SessionRowSeat
  onOpen: (sessionId: SessionId) => void
  /** Workspace-row left inset; absent keeps the flat-list CSS inset. */
  indent?: number
  /** The row's guide columns (folders + the workspace's own column). */
  columns?: readonly GuideColumn[]
  now: number
  menu: MenuSeat
  fileTreeUi: FileTreeUiServiceV2
}): FileTreeRowModel {
  const { session, seat } = props
  const menuKey = session.id
  // Explicit field spread: exactOptionalPropertyTypes forbids passing the
  // optional-typed SessionNode straight into the required `| undefined` seats.
  const dot = sessionStatusDot({
    pendingInteraction: session.pendingInteraction,
    running: session.running,
    runningSubagentCount: session.runningSubagentCount,
    completed: session.completed,
    blank: session.blank,
  })
  const dotLabel = dot === 'warning'
    ? session.pendingInteraction === 'escalation' ? seat.t('sessionStatusEscalation') : seat.t('sessionStatusWarning')
    : dot === 'ongoing' ? seat.t('sessionStatusOngoing')
      : dot === 'done' ? seat.t('sessionStatusDone') : undefined
  // The row menu entries (rename / fork / archive) — the same business list
  // the built-in path renders through its own Menu.
  const menuEntries = [
    { id: 'rename', label: seat.t('rename'), icon: <IconEditOutline16 /> },
    { id: 'fork', label: seat.t('sessionFork'), icon: <IconBranchOutline16 /> },
    { id: 'archive', label: seat.t('sessionArchive'), icon: <IconArchiveOutline20 size={16} /> },
  ] satisfies readonly MenuEntry[]
  const onMenuSelect = (id: string): void => {
    props.menu.onOpenChange(menuKey, false)
    if (id === 'rename') seat.onRename(session.id, session.title)
    else if (id === 'fork') seat.onFork(session.id)
    else if (id === 'archive') seat.onArchive(session.id)
  }
  // Session drags copy a reference (`application/x-dsh-reference+json`)
  // plus the canonical session-reference mention as `text/plain` and do not
  // enter the tree's move state.
  const sessionDragStart = (event: DragEvent<HTMLDivElement>): void => {
    event.stopPropagation()
    if (event.dataTransfer === null) return
    event.dataTransfer.effectAllowed = 'copy'
    const payload = sessionReferencePayload({
      id: session.id as string,
      label: session.title === '' ? undefined : session.title,
    })
    event.dataTransfer.setData(WORKSPACE_REFERENCE_MIME, encodeDragReference(payload))
    event.dataTransfer.setData('text/plain', payload.mention)
    stashActiveReference(payload)
  }
  // The status-dot leading slot (16px fixed, with a visually hidden label).
  const statusSlot = (
    <span className={css.sessionStatusSlot}>
      {dot !== undefined && (
        <>
          <StateDot state={dot} />
          <span className={css.visuallyHidden}>{dotLabel}</span>
        </>
      )}
    </span>
  )
  const menuOpen = props.menu.open(menuKey)
  return {
    key: session.id,
    // The hover card rides the label slot (the framework owns the row
    // chrome; the label is the row's only consumer-rendered surface).
    label: (
      <HoverCard
        anchor={session.blank ? seat.t('newSession') : session.title}
        content={<SessionHoverContent node={session} now={props.now} t={seat.t} />}
        disabled={menuOpen}
        copyLabel={seat.t('copy')}
        copiedLabel={seat.t('copied')}
      />
    ),
    leading: statusSlot,
    leadingSlotWidth: 16,
    ...(session.pendingInteraction === 'escalation'
      ? { trailing: <EscalationMark label={seat.t('sessionStatusEscalation')} /> }
      : {}),
    compact: true,
    active: session.current,
    ...(props.indent === undefined ? {} : { indentPx: props.indent + SESSION_INDENT_OFFSET_PX }),
    ...(props.columns !== undefined && props.columns.length > 0
      ? { guideColumns: props.columns, junction: false }
      : {}),
    ...(!session.blank
      ? {
        actions: props.fileTreeUi.renderRowMenu({
          open: menuOpen,
          onOpenChange: open => props.menu.onOpenChange(menuKey, open),
          items: menuEntries,
          onSelect: onMenuSelect,
          label: seat.t('rowMenuAria', { name: session.title }),
        }),
      }
      : {}),
    role: 'treeitem',
    draggable: !session.blank,
    onClick: () => props.onOpen(session.id),
    onDragStart: sessionDragStart,
  }
}

/** One workspace leaf row model (or the ungrouped bucket) with its session
 *  list. The session list rides the framework's 'layer' children variant
 *  (the continuous guide strokes the built-in sessionListLayer painted);
 *  subworkspace groups nest under their own header models. */
function leafRowModel(props: {
  leaf: WorkspaceLeaf
  /** Root-side-first folder chain above this row. */
  ancestors: readonly FolderId[]
  callbacks: RowCallbacks
  sessionSeat: SessionRowSeat
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  drag: DragSeat
  now: number
  /** Git probe seat: subworkspace grouping + the cross-tree count row pill. */
  git?: GitProbeResultJSON | null
  /** Remote-mirror marker map (hover card only). */
  gitMarkers?: ReadonlyMap<string, RemoteGitMarker>
  /** The workspace's sessions with cwd, for the git aggregation. */
  sessionsForGit?: readonly { id: SessionId; cwd?: string }[]
  /** Expanded group keys (subworkspace headers toggle through these). */
  expandedKeys?: ReadonlySet<string>
  menu: MenuSeat
  fileTreeUi: FileTreeUiServiceV2
}): FileTreeRowModel {
  const { leaf, callbacks } = props
  const hasAccount = leaf.workspaceId !== undefined
  const overflowExpanded = props.sessionsOverflow.includes(leaf.key)
  const shownSessions = overflowExpanded
    ? leaf.sessions
    : leaf.sessions.slice(0, COLLAPSED_SESSION_LIMIT)
  const remoteMarker = hasAccount && leaf.cwd !== undefined && props.gitMarkers !== undefined
    ? props.gitMarkers.get(normalizeProbePath(leaf.cwd))
    : undefined
  const gitAggregate = props.git !== null && props.git !== undefined && hasAccount
    ? aggregateWorkspaceTrees(props.sessionsForGit ?? [], props.git)
    : { kind: 'none' } as const
  const gitGroups = props.git !== null && props.git !== undefined && hasAccount && leaf.cwd !== undefined
    ? deriveSubworkspaceGroups(leaf.cwd, props.sessionsForGit ?? [], props.git)
    : []
  const splitGroups = gitGroups.length > 1
  const ownTree = props.git !== null && props.git !== undefined && leaf.cwd !== undefined
    ? treeOfCwd(props.git, leaf.cwd)
    : undefined
  const hoverGit = props.git === undefined
    ? undefined
    : props.git === null || ownTree === undefined
      ? null
      : {
        tree: ownTree,
        peers: Object.values(props.git.trees).filter(tree => tree.repoKey === ownTree.repoKey && tree.root !== ownTree.root),
      }
  const continueTrees = ownTree === undefined || props.git === null || props.git === undefined
    ? []
    : Object.values(props.git.trees)
      .filter(tree => tree.repoKey === ownTree.repoKey && tree.root !== ownTree.root)
      .sort((a, b) => (a.branch ?? a.detached ?? '').localeCompare(b.branch ?? b.detached ?? ''))
  const depth = props.ancestors.length
  const indentPx = rowIndent(depth)
  const dropZone = hasAccount ? props.drag.dropZoneOf('workspace', leaf.workspaceId as string) : undefined
  const active = dirActive(leaf.containsCurrent)
  const folderColumns = folderGuideColumns(props.ancestors, callbacks.onToggleFolder)
  // The collapsed-dir status marker: the top-priority status dot of the
  // hidden sessions — the actions slot's resting counterpart (the framework
  // CSS hides it on hover while the actions reveal — the v1 posture).
  const busyState: StateDotState | undefined = (leaf.status.warning ?? 0) > 0
    ? 'warning'
    : (leaf.status.ongoing ?? 0) > 0
      ? 'ongoing'
      : (leaf.status.done ?? 0) > 0
        ? 'done'
        : undefined
  const busyLabel = hasAccount && !leaf.expanded && busyState !== undefined
    ? workspaceStatusLabel(busyState, leaf.status[busyState] ?? 1, callbacks.t)
    : undefined
  // Session rows hang one level deeper: besides the folder columns they draw
  // the workspace's OWN column, whose band collapses the session list.
  const sessionColumns: GuideColumn[] = [
    ...folderColumns,
    { id: leaf.key, onToggle: () => callbacks.onWorkspaceClick(leaf.key) },
  ]
  const workspaceMenuEntries: readonly MenuEntry[] = [
    { id: 'rename', label: callbacks.t('rename'), icon: <IconEditOutline16 /> },
    { id: 'move', label: callbacks.t('move'), icon: <IconFolderOpenOutline16 /> },
    ...(continueTrees.length > 0
      ? [
        { type: 'label' as const, id: 'continue-label', text: callbacks.t('continueInTree') },
        ...continueTrees.map(tree => ({
          id: `tree:${tree.root}`,
          label: tree.branch ?? tree.detached ?? basename(tree.root),
          icon: <IconBranchOutline16 />,
        })),
      ]
      : []),
    { type: 'separator' as const, id: 'workspace-actions-separator' },
    { id: 'delete', label: callbacks.t('deleteWorkspaceTitle'), icon: <IconTrashOutline16 />, danger: true },
  ]
  const onWorkspaceMenuSelect = (id: string): void => {
    props.menu.onOpenChange(leaf.key, false)
    if (id === 'rename') callbacks.openers.onRenameWorkspace(leaf.workspaceId as WorkspaceId, leaf.label)
    else if (id === 'move') callbacks.openers.onMoveWorkspace(leaf.workspaceId as WorkspaceId, leaf.label)
    else if (id === 'delete') callbacks.openers.onDeleteWorkspace(leaf.workspaceId as WorkspaceId, leaf.label)
    else if (id.startsWith('tree:')) {
      const root = id.slice('tree:'.length)
      const tree = continueTrees.find(candidate => candidate.root === root)
      if (tree !== undefined) callbacks.onContinueInTree?.(tree, leaf.workspaceId)
    }
  }
  const workspaceDragStart = (event: DragEvent<HTMLDivElement>): void => {
    const transfer = event.dataTransfer
    if (transfer !== null && leaf.workspaceId !== undefined) {
      transfer.effectAllowed = 'copyMove'
      const payload = workspaceReferencePayload({
        id: leaf.workspaceId as string,
        label: leaf.label,
        primarySession: leaf.primarySession,
      })
      transfer.setData(WORKSPACE_REFERENCE_MIME, encodeDragReference(payload))
      transfer.setData('text/plain', payload.mention)
      stashActiveReference(payload)
    }
    props.drag.onDragStart({ kind: 'workspace', id: leaf.workspaceId as string })
  }
  const workspaceDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (props.drag.dragSource === null) return
    event.preventDefault()
    props.drag.onDragOver({
      kind: 'workspace',
      id: leaf.workspaceId as string,
      zone: rowDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
    })
  }
  const workspaceDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      props.drag.onDragLeave('workspace', leaf.workspaceId as string)
    }
  }
  const workspaceDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (props.drag.dragSource === null) return
    event.preventDefault()
    props.drag.onDrop(props.drag.dragSource, {
      kind: 'workspace',
      id: leaf.workspaceId as string,
      zone: rowDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
    })
  }
  const workspaceRowClick = (): void => {
    if (hasAccount) callbacks.onWorkspaceClick(leaf.key)
    else callbacks.onToggleGroup(leaf.key)
  }
  const gitPillMulti = gitAggregate.kind === 'multi'
    ? (
      <span className={css.gitPillMulti} title={`${gitAggregate.trees.length} 棵树的会话`}>
        {gitAggregate.trees.length} 棵
      </span>
    )
    : undefined
  const menuKey = leaf.key
  const menuOpen = props.menu.open(menuKey)
  // The subtree is ALWAYS built (the framework gates on `expanded` and plays
  // the fold animation); the session list variant is 'layer' — the container
  // paints the continuous stroke set, rows paint only the hover highlight.
  const children: FileTreeNode[] = []
  if (splitGroups) {
    for (const group of gitGroups) {
      const subKey = `${SUBWS_GROUP_KEY_PREFIX}${leaf.key}:${group.key}`
      const groupOpen = props.expandedKeys?.has(subKey) ?? false
      children.push(subwsRowModel({
        subKey,
        label: group.own
          ? callbacks.t('subwsOwn', { name: leaf.label })
          : (group.tree?.branch ?? group.tree?.detached ?? callbacks.t('subwsNogit')),
        groupOpen,
        groupSessions: leaf.sessions.filter(session => group.sessionIds.includes(session.id)),
        overflowExpanded: props.sessionsOverflow.includes(subKey),
        workspaceIndentPx: indentPx,
        columns: sessionColumns,
        seat: props.sessionSeat,
        now: props.now,
        onToggleGroup: callbacks.onToggleGroup,
        onToggleOverflow: props.onToggleOverflow,
        ...(group.tree === undefined ? {} : { tree: group.tree }),
        menu: props.menu,
        fileTreeUi: props.fileTreeUi,
      }))
    }
  } else {
    for (const session of shownSessions) {
      children.push(sessionRowModel({
        session,
        seat: props.sessionSeat,
        onOpen: props.sessionSeat.onOpen,
        indent: indentPx,
        columns: sessionColumns,
        now: props.now,
        menu: props.menu,
        fileTreeUi: props.fileTreeUi,
      }))
    }
    const overflow = overflowButtonNode({
      key: `overflow:${leaf.key}`,
      total: leaf.sessions.length,
      expanded: overflowExpanded,
      marginLeft: indentPx + SESSION_INDENT_OFFSET_PX,
      t: callbacks.t,
      onToggle: () => props.onToggleOverflow(leaf.key),
    })
    if (overflow !== null) children.push(overflow)
  }
  return {
    key: leaf.key,
    // The workspace hover card rides the label slot (see sessionRowModel).
    label: hasAccount
      ? (
        <HoverCard
          anchor={leaf.label}
          content={(
            <WorkspaceHoverContent
              label={leaf.label}
              cwd={leaf.cwd}
              createdAt={leaf.createdAt ?? 0}
              t={callbacks.t}
              status={leaf.status}
              {...(hoverGit === undefined ? {} : { git: hoverGit })}
              {...(remoteMarker === undefined ? {} : { remote: remoteMarker })}
            />
          )}
          disabled={menuOpen}
          copyText={leaf.cwd}
          copyLabel={callbacks.t('copy')}
          copiedLabel={callbacks.t('hoverCopied')}
        />
      )
      : leaf.label,
    leading: leaf.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />,
    expanded: leaf.expanded,
    onToggle: workspaceRowClick,
    guideColumns: folderColumns,
    junction: leaf.expanded,
    indentPx,
    active,
    ...(gitPillMulti === undefined ? {} : { trailing: gitPillMulti }),
    ...(dropZone === undefined ? {} : { dropState: dropZone }),
    ...(!hasAccount
      ? {}
      : {
        actions: (
          <>
            {props.fileTreeUi.renderRowMenu({
              open: menuOpen,
              onOpenChange: open => props.menu.onOpenChange(menuKey, open),
              items: workspaceMenuEntries,
              onSelect: onWorkspaceMenuSelect,
              label: callbacks.t('rowMenuAria', { name: leaf.label }),
            })}
            <button
              type="button"
              className={css.iconButton}
              aria-label={callbacks.t('newSessionAria', { name: leaf.label })}
              onClick={event => {
                event.stopPropagation()
                callbacks.onStartSession(leaf.workspaceId as WorkspaceId, leaf.key)
              }}
            >
              <IconPlusOutline16 />
            </button>
          </>
        ),
      }),
    ...(busyLabel === undefined || busyState === undefined
      ? {}
      : {
        restingIndicator: (
          <span className={css.rowBusy} title={busyLabel}>
            <StateDot state={busyState} />
            <span className={css.visuallyHidden}>{busyLabel}</span>
          </span>
        ),
      }),
    role: 'treeitem',
    draggable: hasAccount,
    ...(hasAccount
      ? {
        onDragStart: workspaceDragStart,
        onDragOver: workspaceDragOver,
        onDragLeave: workspaceDragLeave,
        onDrop: workspaceDrop,
        onDragEnd: () => props.drag.onDragEnd(),
      }
      : {}),
    onClick: workspaceRowClick,
    children,
    childrenList: 'layer',
  }
}

/** One subworkspace (tree) group header model inside an expanded workspace:
 *  the group's sessions nest under it ('layer' variant — the header's list
 *  keeps the continuous strokes, rows paint only the hover highlight). */
function subwsRowModel(props: {
  subKey: string
  label: string
  groupOpen: boolean
  groupSessions: readonly SessionNode[]
  overflowExpanded: boolean
  workspaceIndentPx: number
  columns: readonly GuideColumn[]
  seat: SessionRowSeat
  now: number
  onToggleGroup: (key: string) => void
  onToggleOverflow: (key: string) => void
  /** The group's tree (git pill in the trailing slot). */
  tree?: GitTreeInfoJSON
  menu: MenuSeat
  fileTreeUi: FileTreeUiServiceV2
}): FileTreeRowModel {
  const shown = props.overflowExpanded
    ? props.groupSessions
    : props.groupSessions.slice(0, COLLAPSED_SESSION_LIMIT)
  const children: FileTreeNode[] = []
  for (const session of shown) {
    children.push(sessionRowModel({
      session,
      seat: props.seat,
      onOpen: props.seat.onOpen,
      indent: props.workspaceIndentPx + 16,
      columns: props.columns,
      now: props.now,
      menu: props.menu,
      fileTreeUi: props.fileTreeUi,
    }))
  }
  const overflow = overflowButtonNode({
    key: `overflow:${props.subKey}`,
    total: props.groupSessions.length,
    expanded: props.overflowExpanded,
    marginLeft: props.workspaceIndentPx + SESSION_INDENT_OFFSET_PX + 24,
    t: props.seat.t,
    onToggle: () => props.onToggleOverflow(props.subKey),
  })
  if (overflow !== null) children.push(overflow)
  return {
    key: props.subKey,
    label: props.label,
    expanded: props.groupOpen,
    onToggle: () => props.onToggleGroup(props.subKey),
    compact: true,
    className: css.subwsRow,
    indentPx: props.workspaceIndentPx + SESSION_INDENT_OFFSET_PX,
    // Deterministic geometry override (inline, beats both stylesheets
    // regardless of load order): the row's 26px min-height and 6px radius
    // ride the provider's own metric variables.
    style: {
      '--dsh-ftr-row-min-height': '26px',
      '--dsh-ftr-row-radius': '6px',
    } as CSSProperties,
    guideColumns: props.columns,
    junction: false,
    trailing: (
      <>
        {props.tree !== undefined && (
          <span className={`${css.gitPill}${props.tree.role === 'main' ? ` ${css.gitPillMain}` : ''}`}>
            {props.tree.branch ?? props.tree.detached}
          </span>
        )}
        <span className={css.sessionCount}>{props.groupSessions.length}</span>
      </>
    ),
    role: 'treeitem',
    onClick: () => { props.onToggleGroup(props.subKey) },
    children,
    childrenList: 'layer',
  }
}

/** One folder row model plus its subtree (subfolders first, then the
 *  workspace group — the built-in order). The subtree is always built; the
 *  framework gates on `expanded`. The folder's own children list rides the
 *  'plain' variant (rows paint their own strokes — the pre-P3 shape; the
 *  workspace leaves inside carry their own 'layer' session lists). */
function folderRowModel(props: {
  node: FolderNode
  parentName: string
  callbacks: RowCallbacks
  sessionSeat: SessionRowSeat
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  drag: DragSeat
  /** Root-side-first folder chain above this row. */
  ancestors: readonly FolderId[]
  now: number
  /** Git probe seat forwarded to the subtree's workspace rows. */
  git?: GitProbeResultJSON | null
  /** Remote-mirror marker map forwarded to the subtree's workspace rows. */
  gitMarkers?: ReadonlyMap<string, RemoteGitMarker>
  /** Workspace → session cwd list (git aggregation source). */
  sessionsForGit?: (workspaceId: WorkspaceId | undefined) => readonly { id: SessionId; cwd?: string }[]
  /** Expanded group keys forwarded to the subtree's workspace rows. */
  expandedKeys?: ReadonlySet<string>
  menu: MenuSeat
  fileTreeUi: FileTreeUiServiceV2
}): FileTreeRowModel {
  const { node, callbacks } = props
  const menuKey = node.folderId
  const dropZone = props.drag.dropZoneOf('folder', node.folderId)
  const active = dirActive(node.containsCurrent)
  const guideColumns = folderGuideColumns(props.ancestors, callbacks.onToggleFolder)
  const folderMenuEntries = [
    { id: 'new-subfolder', label: callbacks.t('newSubfolder'), icon: <IconPlusOutline16 /> },
    { id: 'rename', label: callbacks.t('rename'), icon: <IconEditOutline16 /> },
    { id: 'move', label: callbacks.t('move'), icon: <IconFolderOpenOutline16 /> },
    { type: 'separator' as const, id: 'folder-actions-separator' },
    { id: 'delete', label: callbacks.t('deleteFolderTitle'), icon: <IconTrashOutline16 />, danger: true },
  ] satisfies readonly MenuEntry[]
  const onFolderMenuSelect = (id: string): void => {
    props.menu.onOpenChange(menuKey, false)
    if (id === 'new-subfolder') callbacks.openers.onNewSubfolder(node.folderId)
    else if (id === 'rename') callbacks.openers.onRenameFolder(node.folderId, node.name)
    else if (id === 'move') callbacks.openers.onMoveFolder(node.folderId, node.name)
    else if (id === 'delete') callbacks.openers.onDeleteFolder(node.folderId, node.name, props.parentName)
  }
  const folderDragStart = (event: DragEvent<HTMLDivElement>): void => {
    const transfer = event.dataTransfer
    if (transfer !== null) {
      transfer.effectAllowed = 'move'
      transfer.setData('text/plain', node.folderId)
    }
    props.drag.onDragStart({ kind: 'folder', id: node.folderId })
  }
  const folderDragOver = (event: DragEvent<HTMLDivElement>): void => {
    if (props.drag.dragSource === null) return
    event.preventDefault()
    props.drag.onDragOver({
      kind: 'folder',
      id: node.folderId,
      zone: folderDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
    })
  }
  const folderDragLeave = (event: DragEvent<HTMLDivElement>): void => {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      props.drag.onDragLeave('folder', node.folderId)
    }
  }
  const folderDrop = (event: DragEvent<HTMLDivElement>): void => {
    if (props.drag.dragSource === null) return
    event.preventDefault()
    props.drag.onDrop(props.drag.dragSource, {
      kind: 'folder',
      id: node.folderId,
      zone: folderDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
    })
  }
  const children: FileTreeNode[] = []
  for (const child of node.children) {
    children.push(folderRowModel({
      node: child,
      parentName: node.name,
      callbacks,
      sessionSeat: props.sessionSeat,
      sessionsOverflow: props.sessionsOverflow,
      onToggleOverflow: props.onToggleOverflow,
      drag: props.drag,
      ancestors: [...props.ancestors, node.folderId],
      now: props.now,
      menu: props.menu,
      fileTreeUi: props.fileTreeUi,
    }))
  }
  const hint = workspaceAppendHintNode({
    key: `drop:${node.folderId}`,
    active: props.drag.appendWorkspaceFolderId === node.folderId,
    label: callbacks.t('dropWorkspaceFolderEnd', { name: node.name }),
    depth: props.ancestors.length + 1,
  })
  if (hint !== null) children.push(hint)
  for (const leaf of node.workspaceGroups) {
    children.push(leafRowModel({
      leaf,
      ancestors: [...props.ancestors, node.folderId],
      callbacks,
      sessionSeat: props.sessionSeat,
      sessionsOverflow: props.sessionsOverflow,
      onToggleOverflow: props.onToggleOverflow,
      drag: props.drag,
      now: props.now,
      ...(props.git === undefined || props.git === null ? {} : { git: props.git }),
      ...(props.gitMarkers === undefined ? {} : { gitMarkers: props.gitMarkers }),
      sessionsForGit: props.sessionsForGit?.(leaf.workspaceId as WorkspaceId) ?? [],
      ...(props.expandedKeys === undefined ? {} : { expandedKeys: props.expandedKeys }),
      menu: props.menu,
      fileTreeUi: props.fileTreeUi,
    }))
  }
  return {
    key: node.folderId,
    label: node.name,
    leading: node.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />,
    expanded: node.expanded,
    onToggle: () => callbacks.onToggleFolder(node.folderId),
    guideColumns,
    junction: node.expanded,
    indentPx: rowIndent(props.ancestors.length),
    active,
    ...(dropZone === undefined ? {} : { dropState: dropZone }),
    actions: props.fileTreeUi.renderRowMenu({
      open: props.menu.open(menuKey),
      onOpenChange: open => props.menu.onOpenChange(menuKey, open),
      items: folderMenuEntries,
      onSelect: onFolderMenuSelect,
      label: callbacks.t('rowMenuAria', { name: node.name }),
    }),
    role: 'treeitem',
    draggable: true,
    onDragStart: folderDragStart,
    onDragOver: folderDragOver,
    onDragLeave: folderDragLeave,
    onDrop: folderDrop,
    onDragEnd: () => props.drag.onDragEnd(),
    onClick: () => callbacks.onToggleFolder(node.folderId),
    children,
    childrenList: 'plain',
  }
}

/** One repo group row model plus its workspace members. */
function repoGroupRowModel(props: {
  repo: GitRepoGroupDerived
  probe: GitProbeResultJSON
  gitMarkers: ReadonlyMap<string, RemoteGitMarker>
  workspaceById: Map<WorkspaceId, WorkspaceView>
  sessions: SessionListState
  state: { groupExpansion: Record<string, boolean>; folderExpansion: Record<string, boolean> }
  callbacks: RowCallbacks
  sessionSeat: SessionRowSeat
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  drag: DragSeat
  now: number
  sessionsForGit: (workspaceId: WorkspaceId | undefined) => readonly { id: SessionId; cwd?: string }[]
  expandedKeys: ReadonlySet<string>
  onRefresh: () => void
  onToggle: () => void
  t: EnhancedWorkspaceBrowserProps['t']
  menu: MenuSeat
  fileTreeUi: FileTreeUiServiceV2
}): FileTreeRowModel {
  const repoKey = `${REPO_GROUP_KEY_PREFIX}${props.repo.repoKey}`
  const open = props.state.groupExpansion[repoKey] === true
  const repoGlyph = (
    <span className={open ? css.folderActive : undefined}>
      {open ? <IconFolderOpen16 /> : <IconFolderClose16 />}
    </span>
  )
  const children: FileTreeNode[] = []
  for (const workspaceId of props.repo.workspaceIds) {
    const leaf = sessionLeafOf(props.workspaceById.get(workspaceId), props.sessions, props.state)
    if (leaf === undefined) continue
    children.push(leafRowModel({
      leaf,
      ancestors: [],
      callbacks: props.callbacks,
      sessionSeat: props.sessionSeat,
      sessionsOverflow: props.sessionsOverflow,
      onToggleOverflow: props.onToggleOverflow,
      drag: props.drag,
      now: props.now,
      git: props.probe,
      gitMarkers: props.gitMarkers,
      sessionsForGit: props.sessionsForGit(workspaceId),
      expandedKeys: props.expandedKeys,
      menu: props.menu,
      fileTreeUi: props.fileTreeUi,
    }))
  }
  return {
    key: repoKey,
    label: props.repo.name,
    leading: repoGlyph,
    expanded: open,
    onToggle: props.onToggle,
    trailing: (
      <>
        <span className={css.gitPillMain}>{props.t('groupByRepo')}</span>
        <span className={css.sessionCount}>{props.repo.workspaceIds.length}</span>
      </>
    ),
    actions: props.fileTreeUi.renderRowMenu({
      open: props.menu.open(repoKey),
      onOpenChange: open => props.menu.onOpenChange(repoKey, open),
      items: [
        { id: 'refresh', label: props.t('refreshGitProbe'), icon: <IconBranchOutline16 /> },
        { id: 'organize', label: props.t('organizeIntoFolder'), icon: <IconFolderOpenOutline16 /> },
      ],
      onSelect: (id) => {
        // RowMenu closes before the callback; 'organize' is declared but
        // has no action in the built-in shape either — preserved as-is.
        if (id === 'refresh') props.onRefresh()
      },
      label: props.t('refreshGitProbe'),
    }),
    className: css.repoRow,
    style: {
      padding: '0 6px',
      '--dsh-ftr-row-radius': '7px',
    } as CSSProperties,
    role: 'treeitem',
    onClick: props.onToggle,
    children,
    childrenList: 'plain',
  }
}

/** The "未注册工作树" group models (header + register rows), or [] when the
 *  probe is unavailable or no unregistered tree exists. */
function unregGroupNodes(props: {
  git: GitProbeResultJSON | null
  workspaces: readonly WorkspaceView[]
  sessions: SessionListState
  open: boolean
  onToggle: () => void
  register: (root: string) => void
  t: EnhancedWorkspaceBrowserProps['t']
  menu: MenuSeat
  fileTreeUi: FileTreeUiServiceV2
}): FileTreeNode[] {
  if (props.git === null) return []
  const referenced = new Set<string>()
  for (const workspace of props.workspaces) referenced.add(workspace.path)
  for (const session of Object.values(props.sessions.byId)) {
    if (session.cwd !== undefined && session.cwd !== '') referenced.add(session.cwd)
  }
  const unreg = unregisteredTrees(props.git, [...referenced])
  if (unreg.length === 0) return []
  const key = 'tw:unreg'
  return [
    {
      key,
      label: props.t('unregTreeGroup'),
      leading: <IconFolderClose16 />,
      expanded: props.open,
      onToggle: props.onToggle,
      trailing: <span className={css.sessionCount}>{unreg.length}</span>,
      className: css.repoRow,
      style: {
        padding: '0 6px',
        '--dsh-ftr-row-radius': '7px',
      } as CSSProperties,
      role: 'treeitem',
      onClick: props.onToggle,
      children: unreg.map(tree => ({
        key: tree.root,
        label: basename(tree.root),
        leading: <IconFolderClose16 />,
        trailing: <span className={css.gitPill}>{tree.detached ?? tree.branch}</span>,
        // The always-visible register pill sits in the actions slot
        // (actionsVisible — this is not a hover-revealed action).
        actions: <span className={css.registerButton}>{props.t('registerTree')}</span>,
        actionsVisible: true,
        compact: true,
        className: css.unregRow,
        style: {
          padding: '0 6px',
          border: '1px dashed var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.35))',
          '--dsh-ftr-row-min-height': '26px',
          '--dsh-ftr-row-radius': '6px',
        } as CSSProperties,
        onClick: () => { props.register(tree.root) },
      })),
      childrenList: 'plain',
    },
  ]
}

/** The v2 service path's section assembly: builds the recency module's and
 *  the "all" section's FileTreeRowModel forests and hands each section's
 *  rows to ONE `renderFileTree` call (the section headers stay outside the
 *  FileTree containers). The row menu open state is hoisted here. */
function ServiceGroupedView(props: {
  props: EnhancedWorkspaceBrowserProps
  fileTreeUi: FileTreeUiServiceV2
  forest: readonly FolderNode[]
  topLevel: readonly WorkspaceLeaf[]
  recents: ReturnType<typeof deriveRecentWorkspaces>
  ungrouped: WorkspaceLeaf | undefined
  openers: RowOpeners
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  onCollapseRecents: () => void
  onCollapseAll: () => void
  state: EnhancedWorkspaceState
  query: string
  git: { probe: GitProbeResultJSON | null; markers: ReadonlyMap<string, RemoteGitMarker>; onRefresh: () => void }
  callbacks: RowCallbacks
  sessionSeat: SessionRowSeat
  drag: DragSeat
  sessionsForGit: (workspaceId: WorkspaceId | undefined) => readonly { id: SessionId; cwd?: string }[]
  expandedKeys: ReadonlySet<string>
  now: number
}): ReactNode {
  const { t, actions } = props.props
  // Framework feeds are real hooks: they MUST run at the component top level
  // (repo mode + the unregistered-tree group read them; the degree of
  // git-gated rendering varies but the hook order never may).
  const workspaces = props.props.useWorkspaces(identity)
  const sessions = props.props.useSessions(identity)
  const pendingInteractions = sessionPendingInteractionsOf(props.props.useSessionPendingInteraction(identity))
  const [openMenus, setOpenMenus] = useState<Record<string, boolean>>({})
  const menu: MenuSeat = {
    open: key => openMenus[key] === true,
    onOpenChange: (key, open) => setOpenMenus(prev => prev[key] === open ? prev : { ...prev, [key]: open }),
  }
  const register = (root: string): void => {
    void props.props.createWorkspace({ path: root })
      .then(created => { actions.adoptWorkspace(created.workspaceId) })
      .catch(error => { console.warn('dsh-enhanced-workspace: register worktree failed', root, error) })
  }
  const unregKey = 'tw:unreg'
  const unregOpen = props.state.groupExpansion[unregKey] === true
  const unregNodes = unregGroupNodes({
    git: props.git.probe,
    workspaces: workspaces.items,
    sessions,
    open: unregOpen,
    onToggle: () => { actions.setGroupExpanded(unregKey, !unregOpen) },
    register,
    t,
    menu,
    fileTreeUi: props.fileTreeUi,
  })

  // The recency module: top-level workspace rows (no ancestor folders, no
  // indent guides), one per recently queried dir.
  const recentsRows = props.recents.map(recent => leafRowModel({
    leaf: recent,
    ancestors: [],
    callbacks: props.callbacks,
    sessionSeat: props.sessionSeat,
    sessionsOverflow: props.sessionsOverflow,
    onToggleOverflow: props.onToggleOverflow,
    drag: props.drag,
    now: props.now,
    git: props.git.probe,
    gitMarkers: props.git.markers,
    sessionsForGit: props.sessionsForGit(recent.workspaceId as WorkspaceId),
    expandedKeys: props.expandedKeys,
    menu,
    fileTreeUi: props.fileTreeUi,
  }))

  // The "all" section: repo mode (repo groups + no-git workspaces + the
  // unregistered-tree group) or the folder forest (folders, root-level
  // leaves, the ungrouped bucket, the unregistered-tree group).
  const allRows: FileTreeNode[] = []
  if (props.state.groupBy === 'repo') {
    if (props.git.probe === null) {
      allRows.push(<div key="repo-status" className={css.searchStatus} role="status">{t('searchNoMatches')}</div>)
    } else {
      const probe = props.git.probe
      const q = props.query.trim().toLowerCase()
      const { repos, nogit } = deriveRepoGroups(probe, workspaces.items)
      const workspaceById = new Map(workspaces.items.map(workspace => [workspace.workspaceId, workspace]))
      const sessionTitlesOf = (workspaceId: WorkspaceId): { id: SessionId; title?: string; cwd?: string }[] =>
        (workspaceById.get(workspaceId)?.sessionIds as SessionId[] | undefined)?.map(id => {
          const summary = sessions.byId[id]
          if (summary === undefined) return { id } as { id: SessionId; title?: string; cwd?: string }
          return summary.cwd === undefined
            ? { id, title: summary.displayTitle } as { id: SessionId; title?: string; cwd?: string }
            : { id, title: summary.displayTitle, cwd: summary.cwd } as { id: SessionId; title?: string; cwd?: string }
        }) ?? []
      const visibleRepos = repos
        .map(repo => ({
          ...repo,
          members: repo.workspaceIds.filter(id => {
            const workspace = workspaceById.get(id)
            return workspace !== undefined && repoMatch(workspace, sessionTitlesOf(id), probe, q)
          }),
        }))
        .filter(repo => repo.members.length > 0 || repo.name.includes(q))
      for (const repo of visibleRepos) {
        const repoKey = `${REPO_GROUP_KEY_PREFIX}${repo.repoKey}`
        const repoOpen = props.state.groupExpansion[repoKey] === true
        allRows.push(repoGroupRowModel({
          repo,
          probe,
          gitMarkers: props.git.markers,
          workspaceById,
          sessions,
          state: props.state,
          callbacks: props.callbacks,
          sessionSeat: props.sessionSeat,
          sessionsOverflow: props.sessionsOverflow,
          onToggleOverflow: props.onToggleOverflow,
          drag: props.drag,
          now: props.now,
          sessionsForGit: props.sessionsForGit,
          expandedKeys: props.expandedKeys,
          onRefresh: props.git.onRefresh,
          onToggle: () => { actions.setGroupExpanded(repoKey, !repoOpen) },
          t,
          menu,
          fileTreeUi: props.fileTreeUi,
        }))
      }
      if (nogit.length > 0) {
        allRows.push(<div key="git-note" className={css.gitNote}>{t('noGitWorkspaces')}</div>)
        for (const workspaceId of nogit) {
          const leaf = sessionLeafOf(workspaceById.get(workspaceId), sessions, props.state, pendingInteractions)
          if (leaf === undefined) continue
          allRows.push(leafRowModel({
            leaf,
            ancestors: [],
            callbacks: props.callbacks,
            sessionSeat: props.sessionSeat,
            sessionsOverflow: props.sessionsOverflow,
            onToggleOverflow: props.onToggleOverflow,
            drag: props.drag,
            now: props.now,
            git: null,
            gitMarkers: props.git.markers,
            sessionsForGit: [],
            expandedKeys: props.expandedKeys,
            menu,
            fileTreeUi: props.fileTreeUi,
          }))
        }
      }
      allRows.push(...unregNodes)
    }
  } else {
    for (const folder of props.forest) {
      allRows.push(folderRowModel({
        node: folder,
        parentName: t('moveDestinationTopLevel'),
        callbacks: props.callbacks,
        sessionSeat: props.sessionSeat,
        sessionsOverflow: props.sessionsOverflow,
        onToggleOverflow: props.onToggleOverflow,
        drag: props.drag,
        ancestors: [],
        now: props.now,
        git: props.git.probe,
        gitMarkers: props.git.markers,
        sessionsForGit: props.sessionsForGit,
        expandedKeys: props.expandedKeys,
        menu,
        fileTreeUi: props.fileTreeUi,
      }))
    }
    for (const leaf of props.topLevel) {
      allRows.push(leafRowModel({
        leaf,
        ancestors: [],
        callbacks: props.callbacks,
        sessionSeat: props.sessionSeat,
        sessionsOverflow: props.sessionsOverflow,
        onToggleOverflow: props.onToggleOverflow,
        drag: props.drag,
        now: props.now,
        git: props.git.probe,
        gitMarkers: props.git.markers,
        sessionsForGit: props.sessionsForGit(leaf.workspaceId as WorkspaceId),
        expandedKeys: props.expandedKeys,
        menu,
        fileTreeUi: props.fileTreeUi,
      }))
    }
    const topHint = workspaceAppendHintNode({
      key: 'drop:root',
      active: props.drag.appendWorkspaceFolderId === ROOT_FOLDER_ID,
      label: t('dropWorkspaceTopLevelEnd'),
      depth: 0,
    })
    if (topHint !== null) allRows.push(topHint)
    if (props.ungrouped !== undefined) {
      allRows.push(leafRowModel({
        leaf: props.ungrouped,
        ancestors: [],
        callbacks: props.callbacks,
        sessionSeat: props.sessionSeat,
        sessionsOverflow: props.sessionsOverflow,
        onToggleOverflow: props.onToggleOverflow,
        drag: props.drag,
        now: props.now,
        git: null,
        gitMarkers: props.git.markers,
        sessionsForGit: [],
        menu,
        fileTreeUi: props.fileTreeUi,
      }))
    }
    allRows.push(...unregNodes)
  }
  const showAll = props.forest.length > 0 || props.topLevel.length > 0 || props.ungrouped !== undefined || props.state.groupBy === 'repo'
  return (
    <>
      {props.recents.length > 0 && (
        <section className={`${css.section} ${css.sectionDivider}`}>
          <div className={css.sectionHeader}>
            <h3 className={css.sectionTitle}>{t('recents')}</h3>
            <Tooltip label={t('collapseAll')} side="bottom" delayMs={500}>
              <button
                type="button"
                className={css.iconButton}
                aria-label={t('collapseAll')}
                onClick={props.onCollapseRecents}
              >
                <IconChevronUpOutline14 />
              </button>
            </Tooltip>
          </div>
          {props.fileTreeUi.renderFileTree({ treeKey: 'recents', rows: recentsRows })}
        </section>
      )}
      {showAll && (
        <section className={css.section}>
          <div className={css.sectionHeader}>
            <h3 className={css.sectionTitle}>{t('all')}</h3>
            <div className={css.headerActions}>
              <Tooltip label={t('collapseAll')} side="bottom" delayMs={500}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('collapseAll')}
                  onClick={props.onCollapseAll}
                >
                  <IconChevronUpOutline14 />
                </button>
              </Tooltip>
              <Tooltip label={t('newFolder')} side="bottom" delayMs={500}>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('newFolder')}
                  onClick={props.openers.onNewFolder}
                >
                  <IconPlusOutline16 />
                </button>
              </Tooltip>
            </div>
          </div>
          {props.fileTreeUi.renderFileTree({ treeKey: 'all', rows: allRows })}
        </section>
      )}
    </>
  )
}

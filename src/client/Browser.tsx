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

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
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
import type { SessionId, WorkspaceId } from '@deepseek-ai/dsh-client-runtime/client'
import {
  DIRECTORY_FLOW_SLOT,
  type EnhancedDirectoryFlowOwnerProps,
  type EnhancedWorkspaceBrowserProps,
} from './contract.ts'
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
import { SessionHoverContent, WorkspaceHoverContent } from './HoverCards.tsx'
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
  RECENT_GROUP_KEY_PREFIX,
  sessionStatusDot,
  treeOrder,
  ROOT_FOLDER_ID,
  UNGROUPED_KEY,
  type FolderId,
  type FolderNode,
  type SessionNode,
  type WorkspaceLeaf,
} from './model.ts'
import { FLAT_SESSION_ORDER_KEY } from './store.ts'
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
export const GUIDE_STROKE = 'color-mix(in srgb, var(--dsw-alias-border-l1, var(--ds-color-border, rgba(128, 128, 128, 0.35))) 70%, transparent)'

/** The guide stroke while its column is hovered: the ancestor's WHOLE
 *  vertical line lights up (every row in its visible subtree paints this
 *  stroke at the same column — see the highlightCol parameter below). A
 *  strong accent so the full "collapse target" line reads at a glance. The
 *  band's ::before stroke in Browser.module.css mirrors this look — keep the
 *  two in sync. */
export const GUIDE_STROKE_HOVER = 'color-mix(in srgb, var(--dsw-alias-interactive-bg-hover-accent, var(--ds-color-accent, #4c8dff)) 80%, transparent)'

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
 * with the folder row that owns that level), plus — on expanded FOLDER rows
 * only — the horizontal corner segment joining the deepest ancestor stroke
 * to the folder icon (the "├─" joint). Workspace rows and collapsed folders
 * keep just the verticals, so the folder structure reads at a glance exactly
 * like the VSCode explorer.
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
    useDirectoryFlow, renderSlot,
    startSession, open,
    renameSession, forkSession, archiveSession,
    renameWorkspace, deleteWorkspace,
    insertWorkspaceBefore, createWorkspace, pickDirectory, persistence,
  } = props
  const workspaces = props.useWorkspaces(identity)
  const sessions = props.useSessions(identity)
  const state = useStore(identity)
  const [query, setQuery] = useState('')
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
    if (hydratedRef.current || loaded === null || !workspaces.baselinesReady) return
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
  }, [loaded, workspaces.baselinesReady, workspaces.items, state.folders, actions])
  const persistedReady = restoreStatus === 'restored' || restoreStatus === 'empty'

  // No adoption or pruning may race durable restore.
  useEffect(() => {
    if (!persistedReady || !workspaces.baselinesReady) return
    actions.retainLiveKeys(workspaces.items.map(workspace => workspace.workspaceId))
    for (const workspace of workspaces.items) {
      if (folderOfWorkspace(state.folders, workspace.workspaceId) === undefined) {
        actions.adoptWorkspace(workspace.workspaceId)
      }
    }
  }, [persistedReady, workspaces.baselinesReady, workspaces.items, state.folders, actions])

  // Failed reads never authorize a write, including a later edit or reconnect.
  useEffect(() => {
    if (!persistedReady || !workspaces.baselinesReady) return
    const timer = setTimeout(() => {
      void persistence.save(state).catch(error => {
        console.warn('dsh-enhanced-workspace: envelope save failed', error)
      })
    }, PERSIST_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [persistedReady, workspaces.baselinesReady, state, persistence])

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
    if (!persistedReady || !workspaces.baselinesReady || workspaces.items.length === 0) return
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
  }, [persistedReady, workspaces.baselinesReady, workspaces.items, state.folders, insertWorkspaceBefore])

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
    const workspaceId = currentWorkspaceId ?? workspaces.recentWorkspaceId
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
    () => deriveFolderForest(sessions, workspaces.items, state.folders, workspaces.archivedSessionIds, view),
    [sessions, workspaces.items, state.folders, workspaces.archivedSessionIds, view],
  )
  const recents = useMemo(
    () => deriveRecentWorkspaces(workspaces.items, sessions, state.recentTouchById, RECENTS_LIMIT, view, workspaces.archivedSessionIds),
    [workspaces.items, sessions, state.recentTouchById, view, workspaces.archivedSessionIds],
  )
  const flat = useMemo(
    () => deriveFlat(sessions, workspaces.archivedSessionIds),
    [sessions, workspaces.archivedSessionIds],
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
              placeholder={t('searchPlaceholder')}
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
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
                onClick={() => {
                  setSearchOnExpand(true)
                  expandSidebar()
                }}
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
              ? <FlatList props={props} rows={filteredFlat} onRename={openers.onRenameSession} />
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
              />
          : state.groupBy === 'flat'
            ? <FlatList props={props} rows={flat} onRename={openers.onRenameSession} />
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
  groupBy: 'workspace' | 'flat'
  orderBy: 'manual' | 'updated'
  onGroupPick: (mode: 'workspace' | 'flat') => void
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
        { id: 'flat', label: t('groupByFlat') },
        { type: 'separator' as const, id: 'order-by-separator' },
        { type: 'label' as const, id: 'order-by', text: t('orderByLabel') },
        { id: 'manual', label: t('orderByManual') },
        { id: 'updated', label: t('orderByUpdated') },
      ]}
      selectedIds={[groupBy, orderBy]}
      onSelect={(id) => {
        if (id === 'workspace' || id === 'flat') onGroupPick(id)
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
}): ReactNode {
  const { t, actions, startSession } = props.props
  const state = props.props.useStore(identity)
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
    <div
      className={css.grouped}
      onDragOver={event => { if (dragSource !== null) event.preventDefault() }}
      onDrop={event => {
        if (dragSource === null) return
        event.preventDefault()
        setDragSource(null)
        setDropTarget(null)
      }}
    >
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
              />
            ))}
          </section>
        )
        : null}
      {props.forest.length > 0 || props.topLevel.length > 0 || props.ungrouped !== undefined
        ? (
          // The full workspace tree below the recents border: folder forest,
          // root-level leaves, and the ungrouped bucket — shared section
          // styling with the recency module but the last block, so its trailing
          // divider is omitted; the collapse-all and "new folder" actions sit
          // on the title's right side.
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
              />
            )}
          </section>
        )
        : null}
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
  return (
    <div className={css.folderBranch}>
      <div
        className={`${css.folderRow}${active ? ` ${css.folderRowCurrent}` : ''}${dropZone === 'before' ? ` ${css.dropBefore}` : ''}${dropZone === 'after' ? ` ${css.dropAfter}` : ''}${dropZone === 'on' ? ` ${css.dropOn}` : ''}`}
        role="treeitem"
        aria-expanded={node.expanded}
        style={{
          paddingLeft: `${rowIndent(props.ancestors.length)}px`,
          ...guideBackground(props.ancestors.length, node.expanded, highlightCol),
        }}
        draggable
        onDragStart={event => {
          const transfer = event.dataTransfer
          if (transfer !== null) {
            transfer.effectAllowed = 'move'
            transfer.setData('text/plain', node.folderId)
          }
          props.drag.onDragStart({ kind: 'folder', id: node.folderId })
        }}
        onDragOver={event => {
          if (props.drag.dragSource === null) return
          event.preventDefault()
          props.drag.onDragOver({
            kind: 'folder',
            id: node.folderId,
            zone: folderDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
          })
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            props.drag.onDragLeave('folder', node.folderId)
          }
        }}
        onDrop={event => {
          if (props.drag.dragSource === null) return
          event.preventDefault()
          props.drag.onDrop(props.drag.dragSource, {
            kind: 'folder',
            id: node.folderId,
            zone: folderDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
          })
        }}
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
            items={[
              { id: 'new-subfolder', label: callbacks.t('newSubfolder'), icon: <IconPlusOutline16 /> },
              { id: 'rename', label: callbacks.t('rename'), icon: <IconEditOutline16 /> },
              { id: 'move', label: callbacks.t('move'), icon: <IconFolderOpenOutline16 /> },
              { type: 'separator' as const, id: 'folder-actions-separator' },
              { id: 'delete', label: callbacks.t('deleteFolderTitle'), icon: <IconTrashOutline16 />, danger: true },
            ]}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'new-subfolder') callbacks.openers.onNewSubfolder(node.folderId)
              else if (id === 'rename') callbacks.openers.onRenameFolder(node.folderId, node.name)
              else if (id === 'move') callbacks.openers.onMoveFolder(node.folderId, node.name)
              else if (id === 'delete') callbacks.openers.onDeleteFolder(node.folderId, node.name, props.parentName)
            }}
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
}): ReactNode {
  const { leaf, callbacks } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const hasAccount = leaf.workspaceId !== undefined
  const overflowExpanded = props.sessionsOverflow.includes(leaf.key)
  const shownSessions = overflowExpanded
    ? leaf.sessions
    : leaf.sessions.slice(0, COLLAPSED_SESSION_LIMIT)
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
  // Session rows hang one level deeper: besides the folder columns they
  // draw the workspace's OWN column (the deepest stroke, at this row's icon
  // column), whose band collapses the session list — the workspace is the
  // "directory" of its sessions, exactly like a folder of a subtree.
  // Recency rows collapse through their prefixed group key the same way.
  const sessionColumns: GuideColumn[] = [
    ...folderColumns,
    { id: leaf.key, onToggle: () => callbacks.onWorkspaceClick(leaf.key) },
  ]
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
      onDragStart={hasAccount ? (event => {
        const transfer = event.dataTransfer
        if (transfer !== null) {
          transfer.effectAllowed = 'copyMove'
          transfer.setData('application/x-dsh-reference+json', JSON.stringify({ version: 1, kind: 'workspace', id: leaf.workspaceId }))
          transfer.setData('text/plain', leaf.workspaceId as string)
        }
        props.drag.onDragStart({ kind: 'workspace', id: leaf.workspaceId as string })
      }) : undefined}
      onDragOver={hasAccount ? (event => {
        if (props.drag.dragSource === null) return
        event.preventDefault()
        props.drag.onDragOver({
          kind: 'workspace',
          id: leaf.workspaceId as string,
          zone: rowDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
        })
      }) : undefined}
      onDragLeave={hasAccount ? (event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          props.drag.onDragLeave('workspace', leaf.workspaceId as string)
        }
      }) : undefined}
      onDrop={hasAccount ? (event => {
        if (props.drag.dragSource === null) return
        event.preventDefault()
        props.drag.onDrop(props.drag.dragSource, {
          kind: 'workspace',
          id: leaf.workspaceId as string,
          zone: rowDropZone(event.currentTarget.getBoundingClientRect(), event.clientY),
        })
      }) : undefined}
      onDragEnd={hasAccount ? () => props.drag.onDragEnd() : undefined}
      onClick={() => {
        if (hasAccount) callbacks.onWorkspaceClick(leaf.key)
        else callbacks.onToggleGroup(leaf.key)
      }}
    >
      {guideHitBands(leaf.key, folderColumns, props.guide.onHover)}
      <span className={css.chevron}>
        <IconTriangleRightFill14 className={leaf.expanded ? `${css.arrow} ${css.arrowOpen}` : css.arrow} />
      </span>
      <span className={`${css.rowGlyph}${active ? ` ${css.folderActive}` : ''}`}>
        {leaf.expanded ? <IconFolderOpen16 /> : <IconFolderClose16 />}
      </span>
      <span className={css.rowLabel}>{leaf.label}</span>
      <span className={css.rowActions}>
        {hasAccount && (
          <>
            <Menu
              open={menuOpen}
              onClose={() => { setMenuOpen(false) }}
              items={[
                { id: 'rename', label: callbacks.t('rename'), icon: <IconEditOutline16 /> },
                { id: 'move', label: callbacks.t('move'), icon: <IconFolderOpenOutline16 /> },
                { type: 'separator' as const, id: 'workspace-actions-separator' },
                { id: 'delete', label: callbacks.t('deleteWorkspaceTitle'), icon: <IconTrashOutline16 />, danger: true },
              ]}
              onSelect={(id) => {
                setMenuOpen(false)
                if (id === 'rename') callbacks.openers.onRenameWorkspace(leaf.workspaceId as WorkspaceId, leaf.label)
                else if (id === 'move') callbacks.openers.onMoveWorkspace(leaf.workspaceId as WorkspaceId, leaf.label)
                else if (id === 'delete') callbacks.openers.onDeleteWorkspace(leaf.workspaceId as WorkspaceId, leaf.label)
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
          <WorkspaceHoverContent label={leaf.label} cwd={leaf.cwd} createdAt={leaf.createdAt ?? 0} t={callbacks.t} />
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
        ? (
          <div className={css.sessionList}>
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
          </div>
        )
        : null}
    </div>
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
  const dotLabel = dot === 'warning' ? seat.t('sessionStatusWarning')
    : dot === 'ongoing' ? seat.t('sessionStatusOngoing')
      : dot === 'done' ? seat.t('sessionStatusDone') : undefined
  // See FolderRow: the session rows are the deepest leaf level — they carry
  // every ancestor stroke (folders plus the workspace's own column) and the
  // hovered ancestor's line lights up through them too.
  const highlightCol = guideHighlightColumn(props.guide?.hover ?? null, props.columns ?? [])
  const ownRow = (
    <div
      className={`${css.sessionRow}${session.current ? ` ${css.sessionRowCurrent}` : ''}`}
      role="treeitem"
      style={{
        ...(props.indent === undefined ? undefined : { paddingLeft: `${props.indent + SESSION_INDENT_OFFSET_PX}px` }),
        ...(props.columns === undefined ? undefined : guideBackground(props.columns.length, false, highlightCol)),
      }}
      draggable={!session.blank}
      onDragStart={event => {
        event.stopPropagation()
        if (event.dataTransfer === null) return
        event.dataTransfer.effectAllowed = 'copy'
        event.dataTransfer.setData('application/x-dsh-reference+json', JSON.stringify({ version: 1, kind: 'session', id: session.id }))
      }}
      onClick={() => props.onOpen(session.id)}
    >
      {props.columns !== undefined && props.guide !== undefined && props.columns.length > 0
        ? guideHitBands(session.id, props.columns, props.guide.onHover)
        : null}
      <span className={css.sessionStatusSlot}>
        {dot !== undefined && (
          <>
            <StateDot state={dot} />
            <span className={css.visuallyHidden}>{dotLabel}</span>
          </>
        )}
      </span>
      <span className={css.rowLabel}>{session.blank ? seat.t('newSession') : session.title}</span>
      {!session.blank && (
        <span className={css.rowActions}>
          <Menu
            open={menuOpen}
            onClose={() => { setMenuOpen(false) }}
            items={[
              { id: 'rename', label: seat.t('rename'), icon: <IconEditOutline16 /> },
              { id: 'fork', label: seat.t('sessionFork'), icon: <IconBranchOutline16 /> },
              { id: 'archive', label: seat.t('sessionArchive'), icon: <IconArchiveOutline20 size={16} /> },
            ]}
            onSelect={(id) => {
              setMenuOpen(false)
              if (id === 'rename') seat.onRename(session.id, session.title)
              else if (id === 'fork') seat.onFork(session.id)
              else if (id === 'archive') seat.onArchive(session.id)
            }}
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
  // the same hover. Session drags copy a reference and do not enter the tree's move state.
  return (
    <HoverCard
      anchor={ownRow}
      content={<SessionHoverContent node={session} now={props.now} t={seat.t} />}
      disabled={menuOpen}
    />
  )
}

/** The flat session list ("In one list" mode). */
function FlatList(props: {
  props: EnhancedWorkspaceBrowserProps
  rows: readonly SessionNode[]
  onRename: (sessionId: SessionId, title: string) => void
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
  return (
    <div className={css.flatList}>
      {props.rows.map(session => (
        <SessionRow key={session.id} session={session} seat={seat} onOpen={seat.onOpen} now={now} />
      ))}
    </div>
  )
}

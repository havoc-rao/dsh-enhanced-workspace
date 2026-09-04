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
 * @module dsh-enhanced-workspace/client/Browser
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  IconArchiveOutline20,
  IconBranchOutline16,
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
import type { SessionId, SessionSearchResultItem, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-client-runtime/client'
import type { EnhancedWorkspaceBrowserProps } from './contract.ts'
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
import {
  deriveFlat,
  deriveFolderForest,
  deriveRecentWorkspaces,
  dirActive,
  folderOfWorkspace,
  observeSessionActivity,
  orderDeltas,
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

/** Pause between the latest keystroke and a Host content-search request. */
const SEARCH_DEBOUNCE_MS = 250
/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
const SEARCH_QUERY_MAX_CODE_UNITS = 500
/** Recency-module row budget: only the five most recently queried dirs. */
const RECENTS_LIMIT = 5
/** Session rows visible per Workspace before the local overflow control. */
const COLLAPSED_SESSION_LIMIT = 5

/** Immutable membership toggle for local expand arrays. */
function toggled(list: readonly string[], key: string): string[] {
  return list.includes(key) ? list.filter(candidate => candidate !== key) : [...list, key]
}

/** Stable selector identity for the framework hook cache (never re-created). */
const identity = <T,>(snapshot: T): T => snapshot

/** Keep controlled input and RPC payload inside the session.search wire contract. */
function sanitizeSearchQuery(value: string): string {
  const withoutNul = value.replaceAll('\0', '')
  if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul
  let end = SEARCH_QUERY_MAX_CODE_UNITS
  const last = withoutNul.charCodeAt(end - 1)
  const next = withoutNul.charCodeAt(end)
  if (last >= 0xD800 && last <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) end--
  return withoutNul.slice(0, end)
}

/** The enhanced browsing region. @param props - the four-share composed props. */
export function EnhancedWorkspaceBrowser(props: EnhancedWorkspaceBrowserProps): ReactNode {
  const {
    useStore, actions, t,
    startSession, open, searchSessions, searchResultLimit,
    renameSession, forkSession, archiveSession,
    renameWorkspace, deleteWorkspace,
    insertWorkspaceBefore, createWorkspace, pickDirectory,
  } = props
  const workspaces = props.useWorkspaces(identity)
  const sessions = props.useSessions(identity)
  const state = useStore(identity)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState<{ items: readonly SessionSearchResultItem[]; hasMore: boolean } | undefined>(undefined)

  // Baseline convergence: adopt Host workspaces the tree does not know yet
  // (newest first at the root account head) and prune ids the Host no longer
  // lists. Both are idempotent, so re-runs after every tree change settle.
  useEffect(() => {
    if (!workspaces.baselinesReady) return
    actions.retainLiveKeys(workspaces.items.map(workspace => workspace.workspaceId))
    for (const workspace of workspaces.items) {
      if (folderOfWorkspace(state.folders, workspace.workspaceId) === undefined) {
        actions.adoptWorkspace(workspace.workspaceId)
      }
    }
  }, [workspaces.baselinesReady, workspaces.items, state.folders, actions])

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
    if (!workspaces.baselinesReady || workspaces.items.length === 0) return
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
  }, [workspaces.baselinesReady, workspaces.items, state.folders, insertWorkspaceBefore])

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

  // Content search: debounce, sanitize, abort the in-flight request on change.
  useEffect(() => {
    if (query.trim() === '') {
      setSearch(undefined)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      searchSessions(sanitizeSearchQuery(query), controller.signal)
        .then(result => setSearch(result))
        .catch(() => {
          if (!controller.signal.aborted) setSearch(undefined)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [query, searchSessions])

  const searching = query.trim() !== ''

  const addWorkspace = async (): Promise<void> => {
    try {
      const path = await pickDirectory()
      if (path === null) return
      const created = await createWorkspace({ path })
      actions.adoptWorkspace(created.workspaceId)
    } catch (error) {
      console.warn('dsh-enhanced-workspace: add workspace failed', error)
    }
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
    if (renameWorkspaceTarget === null || renameWorkspaceTarget.workspaceId !== workspaceId) return
    setRenameWorkspaceTarget({ ...renameWorkspaceTarget, busy: true, error: null })
    void renameWorkspace(workspaceId, draft.trim())
      .then(() => { setRenameWorkspaceTarget(null) })
      .catch((error: unknown) => {
        setRenameWorkspaceTarget(current => current === null || current.workspaceId !== workspaceId
          ? current
          : { ...current, busy: false, error: error instanceof Error ? error.message : String(error) })
      })
  }
  const confirmDeleteWorkspace = (workspaceId: WorkspaceId): void => {
    if (deleteWorkspaceTarget === null || deleteWorkspaceTarget.workspaceId !== workspaceId) return
    setDeleteWorkspaceTarget({ ...deleteWorkspaceTarget, busy: true, error: null })
    void deleteWorkspace(workspaceId)
      .then(() => { setDeleteWorkspaceTarget(null) })
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
    if (renameSessionTarget === null || renameSessionTarget.sessionId !== sessionId) return
    setRenameSessionTarget({ ...renameSessionTarget, busy: true, error: null })
    void renameSession(sessionId, draft.trim())
      .then(() => { setRenameSessionTarget(null) })
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

  return (
    <div className={css.region} data-dsh-enhanced-workspace="browser">
      <header className={css.header}>
        <span className={css.title}>{t('workspaces')}</span>
        <div className={css.headerActions}>
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
              onClick={() => void addWorkspace()}
            >
              <IconProjectAddOutline16 />
            </button>
          </Tooltip>
        </div>
      </header>
      <div className={css.searchBar}>
        <IconSearchOutline16 className={css.searchIcon} />
        <input
          className={css.searchInput}
          type="search"
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
      </div>
      <div className={css.scroll}>
        {searching
          ? search === undefined
            ? null
            : <SearchList props={props} rows={search.items} />
          : state.groupBy === 'flat'
            ? <FlatList props={props} rows={flat} onRename={openers.onRenameSession} />
            : <GroupedView
              props={props}
              forest={forest.folders}
              topLevel={forest.topLevel}
              recents={recents}
              ungrouped={forest.ungrouped}
              openers={openers}
            />}
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
}): ReactNode {
  const { t, actions, startSession } = props.props
  const state = props.props.useStore(identity)
  const [sessionsOverflow, setSessionsOverflow] = useState<string[]>([])
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
  const toggleOverflow = (key: string): void => setSessionsOverflow(keys => toggled(keys, key))

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
    dropZoneOf: (kind, id) =>
      dragSource !== null && dropTarget !== null && dropTarget.kind === kind && dropTarget.id === id
        ? dropTarget.zone
        : undefined,
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
          <section className={css.section}>
            <h3 className={css.sectionTitle}>{t('recents')}</h3>
            {props.recents.map(recent => (
              <LeafRow
                key={recent.workspaceId}
                leaf={recent}
                callbacks={callbacks}
                sessionSeat={sessionSeat}
                sessionsOverflow={sessionsOverflow}
                onToggleOverflow={toggleOverflow}
                drag={drag}
              />
            ))}
          </section>
        )
        : null}
      {props.forest.length > 0 || props.topLevel.length > 0 || props.ungrouped !== undefined
        ? (
          // The full workspace tree below the recents border: folder forest,
          // root-level leaves, and the ungrouped bucket — same section styling
          // as the recency module, with its own border above the new-folder row.
          <section className={css.section}>
            <h3 className={css.sectionTitle}>{t('all')}</h3>
            {props.forest.map(folder => (
              <FolderRow
                key={folder.folderId}
                node={folder}
                parentName={topLevelLabel}
                callbacks={callbacks}
                sessionSeat={sessionSeat}
                sessionsOverflow={sessionsOverflow}
                onToggleOverflow={toggleOverflow}
                drag={drag}
              />
            ))}
            {props.topLevel.map(leaf => (
              <LeafRow
                key={leaf.key}
                leaf={leaf}
                callbacks={callbacks}
                sessionSeat={sessionSeat}
                sessionsOverflow={sessionsOverflow}
                onToggleOverflow={toggleOverflow}
                drag={drag}
              />
            ))}
            {props.ungrouped !== undefined && (
              <LeafRow
                leaf={props.ungrouped}
                callbacks={callbacks}
                sessionSeat={sessionSeat}
                sessionsOverflow={sessionsOverflow}
                onToggleOverflow={toggleOverflow}
                drag={drag}
              />
            )}
          </section>
        )
        : null}
      <div className={css.newFolderRow}>
        <button type="button" className={css.newFolderButton} onClick={props.openers.onNewFolder}>
          <IconPlusOutline16 />
          <span>{t('newFolder')}</span>
        </button>
      </div>
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
}): ReactNode {
  const { node, callbacks } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const dropZone = props.drag.dropZoneOf('folder', node.folderId)
  // Dir-level activity sync: an expanded folder holding the current session
  // lights its glyph (built-in parity).
  const active = dirActive(node.expanded, node.containsCurrent)
  return (
    <div className={css.folderBranch}>
      <div
        className={`${css.folderRow}${dropZone === 'before' ? ` ${css.dropBefore}` : ''}${dropZone === 'after' ? ` ${css.dropAfter}` : ''}${dropZone === 'on' ? ` ${css.dropOn}` : ''}`}
        role="treeitem"
        aria-expanded={node.expanded}
        style={{ paddingLeft: `${8 + (node.depth - 1) * 14}px` }}
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
              />
            ))}
            {node.workspaceGroups.map(leaf => (
              <LeafRow
                key={leaf.key}
                leaf={leaf}
                callbacks={callbacks}
                sessionSeat={props.sessionSeat}
                sessionsOverflow={props.sessionsOverflow}
                onToggleOverflow={props.onToggleOverflow}
                drag={props.drag}
              />
            ))}
          </div>
        )
        : null}
    </div>
  )
}

/** One workspace leaf row (or the ungrouped bucket) with its session rows. */
function LeafRow(props: {
  leaf: WorkspaceLeaf
  callbacks: RowCallbacks
  sessionSeat: SessionRowSeat
  sessionsOverflow: readonly string[]
  onToggleOverflow: (key: string) => void
  drag: DragSeat
}): ReactNode {
  const { leaf, callbacks } = props
  const [menuOpen, setMenuOpen] = useState(false)
  const hasAccount = leaf.workspaceId !== undefined
  const overflowExpanded = props.sessionsOverflow.includes(leaf.key)
  const shownSessions = overflowExpanded
    ? leaf.sessions
    : leaf.sessions.slice(0, COLLAPSED_SESSION_LIMIT)
  const dropZone = hasAccount ? props.drag.dropZoneOf('workspace', leaf.workspaceId as string) : undefined
  // Dir-level activity sync (built-in parity): an expanded workspace holding
  // the current session lights its glyph — recency rows follow the same rule.
  const active = dirActive(leaf.expanded, leaf.containsCurrent)
  return (
    <div className={css.leafBranch}>
      <div
        className={`${css.workspaceRow}${dropZone === 'before' ? ` ${css.dropBefore}` : ''}${dropZone === 'after' ? ` ${css.dropAfter}` : ''}${dropZone === 'on' ? ` ${css.dropOn}` : ''}`}
        role="treeitem"
        aria-expanded={leaf.expanded}
        draggable={hasAccount}
        onDragStart={hasAccount ? (event => {
          const transfer = event.dataTransfer
          if (transfer !== null) {
            transfer.effectAllowed = 'move'
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
      {leaf.expanded
        ? (
          <div className={css.sessionList}>
            {shownSessions.map(session => (
              <SessionRow key={session.id} session={session} seat={props.sessionSeat} onOpen={props.sessionSeat.onOpen} />
            ))}
            {leaf.sessions.length > COLLAPSED_SESSION_LIMIT && (
              <button
                type="button"
                className={css.overflowButton}
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

/** One session row (status dot + title + row action menu). */
function SessionRow(props: {
  session: SessionNode
  seat: SessionRowSeat
  onOpen: (sessionId: SessionId) => void
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
  return (
    <div
      className={css.sessionRow}
      role="treeitem"
      onClick={() => props.onOpen(session.id)}
    >
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
  return (
    <div className={css.flatList}>
      {props.rows.map(session => (
        <SessionRow key={session.id} session={session} seat={seat} onOpen={seat.onOpen} />
      ))}
    </div>
  )
}

/** Bounded search result rows: the wire item carries only `sessionId` +
 * `snippet`, so titles and workspace labels resolve through the session and
 * workspace snapshots. */
function SearchList(props: {
  props: EnhancedWorkspaceBrowserProps
  rows: readonly SessionSearchResultItem[]
}): ReactNode {
  const sessions = props.props.useSessions(identity)
  const workspaces = props.props.useWorkspaces(identity)
  const workspaceBySession = useMemo(() => {
    const map = new Map<SessionId, WorkspaceView>()
    for (const workspace of workspaces.items) {
      for (const sessionId of workspace.sessionIds) map.set(sessionId, workspace)
    }
    return map
  }, [workspaces.items])
  return (
    <div className={css.flatList}>
      {props.rows.slice(0, props.props.searchResultLimit).map(row => {
        const session = sessions.byId[row.sessionId]
        const workspace = workspaceBySession.get(row.sessionId)
        return (
          <button
            key={row.sessionId}
            type="button"
            className={css.sessionRow}
            onClick={() => props.props.open(row.sessionId)}
          >
            <span className={css.rowLabel}>{session?.displayTitle ?? row.sessionId}</span>
            <span className={css.rowTime}>{workspace?.title ?? ''}</span>
          </button>
        )
      })}
    </div>
  )
}
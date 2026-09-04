/**
 * Browser-owned dialog seats of the enhanced workspace region: the generic
 * name-input dialog (new subfolder / rename folder / rename workspace /
 * rename session), the delete-confirmation dialog (folder promotion and
 * workspace deregistration copy), and the move-to folder picker (workspace
 * and folder targets). Dialogs live at the browser level, not on the rows,
 * so collapsing or removing a row never tears down in-flight dialog state —
 * the same reasoning as the built-in browser's dialog seats.
 * @module dsh-enhanced-workspace/client/Dialogs
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, IconCheckOutline16, IconFolderClose16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  FolderDepthExceededError,
  FolderNameConflictError,
  FolderNotFoundError,
  FolderRootProtectedError,
  ROOT_FOLDER_ID,
  WorkspaceAnchorMissingError,
  WorkspaceNotInTreeError,
  type FolderId,
  type FolderTree,
} from './model.ts'
import type { EnhancedWorkspaceBrowserProps } from './contract.ts'
import css from './Browser.module.css'

/**
 * Localize a folder-tree model error for inline dialog display. Unknown
 * errors fall back to their native message.
 * @param error - thrown validation error.
 * @param t - the browser's locale seat.
 * @returns localized copy.
 */
export function folderErrorMessage(error: unknown, t: EnhancedWorkspaceBrowserProps['t']): string {
  if (error instanceof FolderNameConflictError) return t('folderNameConflict')
  if (error instanceof FolderDepthExceededError) return t('folderDepthExceeded', { max: error.maxDepth })
  if (error instanceof FolderRootProtectedError) return t('folderRootProtected')
  if (error instanceof FolderNotFoundError) return t('folderNotFound')
  if (error instanceof WorkspaceNotInTreeError || error instanceof WorkspaceAnchorMissingError) {
    return t('workspaceNotInTree')
  }
  return error instanceof Error ? error.message : String(error)
}

/** Live validation on the draft: return a warning to show and block confirm. */
export type DraftConflict = (draft: string) => string | undefined

/** One name-input dialog seat (new folder / rename folder / rename workspace / rename session). */
export interface InputDialogState {
  /** Modal heading (localized at the owner). */
  title: string
  /** Input aria label. */
  label: string
  /** Input placeholder. */
  placeholder: string
  /** Initial draft value. */
  initial: string
  /** Confirm button copy (localized at the owner). */
  confirmLabel: string
  /** Live conflict warning on the draft (empty draft never conflicts). */
  conflict?: DraftConflict | undefined
  /** Latched rejection message from the underlying write, when any. */
  error: string | null
  /** Whether the underlying write is in flight (locks the dialog). */
  busy: boolean
  /** Confirm the draft (the owner validates and writes). */
  confirm: (draft: string) => void
}

/** The input dialog: transient draft, IME-safe Enter, select-on-focus. */
export function InputDialog({ state, onCancel, t }: {
  state: InputDialogState
  onCancel: () => void
  t: EnhancedWorkspaceBrowserProps['t']
}): ReactNode {
  const [draft, setDraft] = useState(state.initial)
  const composingRef = useRef(false)
  useEffect(() => {
    setDraft(state.initial)
  }, [state.initial, state.title])
  const warning = state.conflict?.(draft)
  const confirm = (): void => {
    if (state.busy || draft.trim() === '' || warning !== undefined) return
    state.confirm(draft)
  }
  return (
    <Modal
      open
      onClose={state.busy ? () => { /* noop while busy */ } : onCancel}
      closeLabel={t('cancel')}
      title={state.title}
      footer={(
        <>
          <Button variant="outline" disabled={state.busy} onClick={onCancel}>{t('cancel')}</Button>
          <Button
            variant="primary"
            disabled={state.busy || draft.trim() === '' || warning !== undefined}
            onClick={confirm}
          >
            {state.confirmLabel}
          </Button>
        </>
      )}
    >
      <input
        className={css.dialogInput}
        value={draft}
        aria-label={state.label}
        placeholder={state.placeholder}
        autoFocus
        disabled={state.busy}
        onFocus={event => { event.target.select() }}
        onChange={event => { setDraft(event.target.value) }}
        onCompositionStart={() => { composingRef.current = true }}
        onCompositionEnd={() => { composingRef.current = false }}
        onKeyDown={event => {
          if (event.key === 'Enter' && !composingRef.current) {
            event.preventDefault()
            confirm()
          }
        }}
      />
      {warning !== undefined && <div className={css.dialogError} role="alert">{warning}</div>}
      {state.error !== null && <div className={css.dialogError} role="alert">{state.error}</div>}
    </Modal>
  )
}

/** One delete-confirmation seat (folder promotion / workspace deregistration). */
export interface ConfirmDialogState {
  /** Modal heading (localized at the owner). */
  title: string
  /** Supporting sentence (localized at the owner; may embed the parent name). */
  description: string
  confirmLabel: string
  error: string | null
  busy: boolean
  confirm: () => void
}

/** The confirmation dialog: destructive action runs only on explicit confirm. */
export function ConfirmDialog({ state, onCancel, t }: {
  state: ConfirmDialogState
  onCancel: () => void
  t: EnhancedWorkspaceBrowserProps['t']
}): ReactNode {
  return (
    <Modal
      open
      onClose={state.busy ? () => { /* noop while busy */ } : onCancel}
      closeLabel={t('cancel')}
      title={state.title}
      description={state.description}
      footer={(
        <>
          <Button variant="outline" disabled={state.busy} onClick={onCancel}>{t('cancel')}</Button>
          <Button
            variant="outline"
            className={css.dangerAction}
            disabled={state.busy}
            onClick={state.confirm}
          >
            {state.confirmLabel}
          </Button>
        </>
      )}
    >
      {state.error !== null && <div className={css.dialogError} role="alert">{state.error}</div>}
    </Modal>
  )
}

/** One move-to picker row: a folder target in render order. */
interface MoveOption {
  folderId: FolderId
  name: string
  depth: number
}

/**
 * Enumerate move targets: the top-level sentinel row (moves to the root
 * account) followed by every folder in render (depth-first) order. The
 * folder being moved and its whole subtree are excluded — moving a folder
 * into itself or its own descendant is a cycle.
 * @param folders - the durable tree.
 * @param excludedFolderId - subtree to hide (the row being moved), if any.
 * @param topLevelLabel - localized root-row label.
 * @returns picker rows in display order.
 */
export function collectMoveOptions(
  folders: FolderTree,
  excludedFolderId: FolderId | undefined,
  topLevelLabel: string,
): MoveOption[] {
  const excluded = new Set<FolderId>()
  if (excludedFolderId !== undefined) {
    const walkExcluded = (id: FolderId): void => {
      if (excluded.has(id)) return
      excluded.add(id)
      const record = folders[id]
      if (record === undefined) return
      for (const childId of record.folderIds) walkExcluded(childId)
    }
    walkExcluded(excludedFolderId)
  }
  const options: MoveOption[] = [{ folderId: ROOT_FOLDER_ID, name: topLevelLabel, depth: 0 }]
  const walk = (id: FolderId, depth: number): void => {
    const record = folders[id]
    if (record === undefined) return
    for (const childId of record.folderIds) {
      if (!excluded.has(childId)) {
        options.push({ folderId: childId, name: folders[childId]?.name ?? childId, depth })
      }
      walk(childId, depth + 1)
    }
  }
  walk(ROOT_FOLDER_ID, 1)
  return options
}

/** One move-to seat: pick one folder as the new owner. */
export interface MoveToDialogState {
  /** Modal heading (localized at the owner). */
  title: string
  /** Support sentence ("Select a target folder…"). */
  description: string
  /** The folder being moved, when the picker is a folder move (subtree hidden). */
  excludedFolderId: FolderId | undefined
  /** The subject's display name (folder or workspace label). */
  subjectName: string
  error: string | null
  busy: boolean
  /** Commit the move into `targetFolderId` (the owner writes the tree). */
  confirm: (targetFolderId: FolderId) => void
}

/** The move-to folder picker: folder rows by depth, selection confirmed by button or Enter. */
export function MoveToDialog({ state, folders, onCancel, t }: {
  state: MoveToDialogState
  folders: FolderTree
  onCancel: () => void
  t: EnhancedWorkspaceBrowserProps['t']
}): ReactNode {
  const options = collectMoveOptions(folders, state.excludedFolderId, t('moveDestinationTopLevel'))
  const [selected, setSelected] = useState<FolderId>(ROOT_FOLDER_ID)
  useEffect(() => {
    setSelected(ROOT_FOLDER_ID)
  }, [state.title])
  const commit = (): void => {
    if (state.busy) return
    state.confirm(selected)
  }
  return (
    <Modal
      open
      onClose={state.busy ? () => { /* noop while busy */ } : onCancel}
      closeLabel={t('cancel')}
      title={state.title}
      description={state.description}
      footer={(
        <>
          <Button variant="outline" disabled={state.busy} onClick={onCancel}>{t('cancel')}</Button>
          <Button variant="primary" disabled={state.busy} onClick={commit}>{t('confirm')}</Button>
        </>
      )}
    >
      <div className={css.moveSubject}>{state.subjectName}</div>
      <div className={css.moveList} role="listbox" aria-label={state.description}>
        {options.map(option => {
          const active = option.folderId === selected
          return (
            <button
              key={option.folderId}
              type="button"
              role="option"
              aria-selected={active}
              className={active ? `${css.moveRow} ${css.moveRowSelected}` : css.moveRow}
              style={{ paddingLeft: `${8 + option.depth * 14}px` }}
              onClick={() => { setSelected(option.folderId) }}
            >
              <span className={css.rowGlyph}><IconFolderClose16 /></span>
              <span className={css.rowLabel}>{option.name}</span>
              {active && <IconCheckOutline16 className={css.moveCheck} />}
            </button>
          )
        })}
      </div>
      {state.error !== null && <div className={css.dialogError} role="alert">{state.error}</div>}
    </Modal>
  )
}
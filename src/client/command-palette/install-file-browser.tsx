import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { PaletteService, PanelId, PanelSnapshot, Picker, PanelAction } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import { FILE_BROWSER_ENDPOINT, type BrowserResult } from '../../shared/file-browser.ts'
import { PERSISTENCE_CHANNEL } from '../../shared/persistence.ts'
import { WORKSPACE_COMMAND_ID, WORKSPACE_PICKER_ID, createWorkspacePicker, defaultWorkspaceCopy, workspaceTag, type WorkspaceAdapter } from './provider.ts'
import { WorkspaceFileBrowser, browserZh, browserEn, absoluteBrowserPath, fileMention, type FileBrowserAdapter } from './FileBrowser.tsx'
import type { BrowserInteraction } from './browser-interaction.ts'
import { workspaceMention } from '../reference.ts'

interface InsertionActions {
  captureInsertion(): unknown
  insertReference(reference: { source: string; ref: string; label: string; appearance: 'folder' | 'file'; clipboardText: string }, span: unknown): boolean
  focus(): void
}
interface SessionFace { adapter?: { current?: { getSnapshot(): { key: unknown; props: { inputActions?: InsertionActions } } | undefined } } }
const PANEL_ID = 'workspaces.browse-files' as PanelId
/** All Modal, focus/search keys and layered Escape now belong to command-palette. */
export function registerFileBrowser(ctx: Context, palette: PaletteService, workspaces: WorkspaceAdapter): () => void {
  // Older palette versions remain usable; do not register a command with a missing target.
  if (typeof palette.registerPanel !== 'function') return () => {}
  let pendingWorkspaceId: string | undefined
  let workspaceId = ''
  let disposed = false
  let query = ''
  let interaction: BrowserInteraction | undefined
  let adapter: (FileBrowserAdapter & { insertWorkspace(): boolean }) | undefined
  let invocation = 0
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const text = () => ctx.locale.getSnapshot().active.toLowerCase().startsWith('zh') ? browserZh : browserEn
  const current = () => (ctx.get('uiSession') as unknown as SessionFace | undefined)?.adapter?.current?.getSnapshot()
  const getSnapshot = (): PanelSnapshot => {
    const state = interaction?.getState()
    return { title: text().title,
      placeholder: text().filter, query,
      actionsTargetLabel: state?.target?.path ?? '',
      scrollMode: 'contained',
      width: 'compact',
      canGoBack: false, canAccept: !!state?.target?.selected,
      acceptLabel: state?.target?.directory ? text().openDirectory : text().insert,
      footerText: state ? `${state.count}` : '', status: 'ready' }
  }
  const removePanel = palette.registerPanel({
    id: PANEL_ID, getSnapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onOpen: () => {
      invocation++; query = ''; interaction = undefined
      workspaceId = pendingWorkspaceId ?? ''; pendingWorkspaceId = undefined
      if (!workspaceId || !workspaces.getSnapshot().items.some(row => row.workspaceId === workspaceId)) {
        workspaceId = ''; return
      }
      const binding = current()
      const actions = binding?.props.inputActions
      const span = typeof actions?.captureInsertion === 'function' ? actions.captureInsertion() : undefined
      let active = true
      adapter = {
        workspaces: () => workspaces.getSnapshot().items,
        subscribe: listener => workspaces.subscribe(listener),
        copy: path => navigator.clipboard.writeText(path),
        browse: async (request, abort) => {
          if (!workspaces.isConnected()) throw new Error('Connection disconnected')
          if (abort.aborted || !active) throw new Error('Cancelled')
          const connection = ctx.get('connection') as ConnectionHandle | undefined
          if (!connection) throw new Error('Connection unavailable')
          const result = await connection.rpc.call(PERSISTENCE_CHANNEL, FILE_BROWSER_ENDPOINT, request)
          if (abort.aborted || !active) throw new Error('Cancelled')
          if (!result.ok) throw new Error(result.error.message)
          return result.value as BrowserResult
        },
        insert: (path, directory, label) => {
          if (!active || current()?.key !== binding?.key || !actions || span === undefined || typeof actions.insertReference !== 'function') return false
          const workspace = workspaces.getSnapshot().items.find(row => row.workspaceId === workspaceId)
          if (!workspace) return false
          if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return false
          const mention = fileMention(path, directory)
          return actions.insertReference({ source: 'reference', ref: mention,
            label: directory ? `${label}/` : label,
            appearance: directory ? 'folder' : 'file', clipboardText: mention }, span)
        },
        insertWorkspace: () => {
          if (!active || current()?.key !== binding?.key || !actions || span === undefined || typeof actions.insertReference !== 'function') return false
          const workspace = workspaces.getSnapshot().items.find(row => row.workspaceId === workspaceId)
          if (!workspace) return false
          const mention = workspaceMention(workspace.workspaceId, workspace.displayTitle)
          return actions.insertReference({ source: 'reference', ref: mention, label: workspace.displayTitle,
            appearance: 'folder', clipboardText: mention }, span)
        },
      }
      return () => { active = false; adapter = undefined; interaction = undefined; if (current()?.key === binding?.key) actions?.focus?.() }
    },
    getActions: () => {
      const state = interaction?.getState()
      const target = state?.target
      const capturedAdapter = adapter
      const generation = invocation
      if (!target || !state.workspaceId || !capturedAdapter) return []
      const valid = (signal: AbortSignal) => !signal.aborted && adapter === capturedAdapter && invocation === generation
        && interaction?.getState().workspaceId === state.workspaceId && interaction?.getState().stage === state.stage
        && workspaces.getSnapshot().items.some(row => row.workspaceId === state.workspaceId)
      return [
        { id: 'create-new-session', title: text().createSession, iconId: 'create' as const,
          aliases: ['new session', 'create session', '新建会话'], execute: async ({ signal }) => {
            if (!valid(signal)) return { kind: 'cancelled' as const }
            if (!workspaces.isConnected()) return { kind: 'failed' as const, message: text().disconnected }
            if (workspaces.getSnapshot().phase !== 'ready') return { kind: 'failed' as const, message: text().unavailable }
            try {
              await workspaces.createNewSession(state.workspaceId!, signal)
              return valid(signal) ? { kind: 'completed' as const } : { kind: 'cancelled' as const }
            } catch (error) {
              return !valid(signal) ? { kind: 'cancelled' as const }
                : { kind: 'failed' as const, message: error instanceof Error ? error.message : String(error) }
            }
          } },
        { id: 'copy-absolute-path', title: text().copy, aliases: ['copy', 'path', '复制'], execute: async ({ signal }) => {
          if (!valid(signal)) return { kind: 'cancelled' as const }
          await capturedAdapter.copy(target.path)
          return valid(signal) ? { kind: 'stay' as const } : { kind: 'cancelled' as const }
        } },
        { id: 'insert-reference', title: text().insertPath, aliases: ['inputbox', 'ref', 'path', '输入框', '路径引用'], execute: ({ signal }) => {
          if (!valid(signal)) return { kind: 'cancelled' as const }
          return capturedAdapter.insert(target.path, target.directory, target.label)
            ? { kind: 'completed' as const } : { kind: 'failed' as const, message: text().stale }
        } },
        ...(!target.selected ? [{ id: 'insert-workspace-reference', title: text().insertWorkspace,
          aliases: ['workspace ref', '工作区引用'], execute: ({ signal }: { signal: AbortSignal }) => {
            if (!valid(signal)) return { kind: 'cancelled' as const }
            return capturedAdapter.insertWorkspace()
              ? { kind: 'completed' as const } : { kind: 'failed' as const, message: text().stale }
          } }] : []),
        { id: 'toggle-hidden-files', title: text().hidden,
          status: { kind: 'toggle', checked: state.hidden, label: state.hidden ? text().hiddenShown : text().hiddenHidden },
          aliases: ['hidden', 'dotfiles', '隐藏文件'], execute: ({ signal }) => {
            if (!valid(signal)) return { kind: 'cancelled' as const }
            interaction?.setHidden(!interaction.getState().hidden)
            return { kind: 'stay' as const }
          } },
        ...(state.stage === 'tree' ? [{ id: 'toggle-content-preview', title: text().togglePreview,
          status: { kind: 'toggle' as const, checked: state.previewEnabled, label: state.previewEnabled ? text().previewOn : text().previewOff },
          aliases: ['preview', 'content', '预览', '内容'], execute: ({ signal }: { signal: AbortSignal }) => {
            if (!valid(signal)) return { kind: 'cancelled' as const }
            interaction?.setPreviewEnabled(!interaction.getState().previewEnabled)
            return { kind: 'stay' as const }
          } }] : []),
      ]
    },
    onQuery: value => { query = value; notify() },
    move: delta => interaction?.move(delta),
    back: () => interaction?.back() ?? false,
    accept: () => { interaction?.accept(); return { kind: 'stay' } },
    render: () => adapter ? <WorkspaceFileBrowser key={invocation} workspaceId={workspaceId} adapter={adapter} text={text()} close={() => palette.close()}
      shell={{ query, bind: value => { interaction = value; return () => { if (interaction === value) interaction = undefined } }, invalidate: notify, setQuery: value => { query = value; notify() } }} /> : <p role="alert">{text().chooseWorkspace}</p>,
  })
  // Queries remain pure. Only entering Actions captures its composer insertion point.
  const picker: Picker = {
    ...createWorkspacePicker(workspaces, () => ({ ...defaultWorkspaceCopy,
      pickerTitle: text().title, placeholder: text().search,
      emptyText: text() === browserZh ? '尚无工作区' : 'No workspaces yet',
      noResultsText: text().empty, disconnected: text().disconnected, unavailable: text().unavailable })),
    accept: (id, { signal }) => {
      if (signal.aborted || disposed) return { kind: 'cancelled' }
      if (!workspaces.isConnected()) return { kind: 'failed', message: text().disconnected }
      if (workspaces.getSnapshot().phase !== 'ready') return { kind: 'failed', message: text().unavailable }
      if (!workspaces.getSnapshot().items.some(row => row.workspaceId === id)) return { kind: 'failed', message: text().unavailable }
      pendingWorkspaceId = id
      try {
        const opened = palette.openPanel(PANEL_ID)
        // openPanel deliberately aborts the originating accept signal.
        return opened ? { kind: 'stay' } : { kind: 'failed', message: text().unavailable }
      } finally { pendingWorkspaceId = undefined }
    },
    getActions: (id, args): readonly PanelAction[] => {
      const record = workspaces.getSnapshot().items.find(row => row.workspaceId === id)
      if (!record || args.signal.aborted || disposed) return []
      const binding = current()
      const actions = binding?.props.inputActions
      const span = actions?.captureInsertion?.()
      const path = absoluteBrowserPath(record.path, '')
      const valid = (signal: AbortSignal) => !disposed && !args.signal.aborted && !signal.aborted
        && workspaces.getSnapshot().phase === 'ready' && workspaces.isConnected()
        && workspaces.getSnapshot().items.some(row => row.workspaceId === id && row.path === record.path)
      return [
        { id: 'create-new-session', title: text().createSession, iconId: 'create', execute: async ({ signal }) => {
          if (!valid(signal)) return { kind: 'cancelled' }
          try {
            await workspaces.createNewSession(id, signal)
            return valid(signal) ? { kind: 'completed' } : { kind: 'cancelled' }
          } catch (error) {
            return valid(signal) ? { kind: 'failed', message: error instanceof Error ? error.message : String(error) } : { kind: 'cancelled' }
          }
        } },
        { id: 'copy-absolute-path', title: text().copy, execute: async ({ signal }) => {
          if (!valid(signal)) return { kind: 'cancelled' }
          await navigator.clipboard.writeText(path)
          return valid(signal) ? { kind: 'stay' } : { kind: 'cancelled' }
        } },
        { id: 'insert-reference', title: text().insertWorkspace, aliases: ['workspace ref', '工作区引用'], execute: ({ signal }) => {
          if (!valid(signal)) return { kind: 'cancelled' }
          if (current()?.key !== binding?.key || !actions || span === undefined) return { kind: 'failed', message: text().stale }
          const mention = workspaceMention(record.workspaceId, record.displayTitle)
          return actions.insertReference?.({ source: 'reference', ref: mention, label: record.displayTitle, appearance: 'folder', clipboardText: mention }, span)
            ? { kind: 'completed' } : { kind: 'failed', message: text().stale }
        } },
        { id: 'insert-path-reference', title: text().insertPath, aliases: ['path ref', '路径引用'], execute: ({ signal }) => {
          if (!valid(signal)) return { kind: 'cancelled' }
          if (current()?.key !== binding?.key || !actions || span === undefined || /[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return { kind: 'failed', message: text().stale }
          const mention = fileMention(path, true)
          return actions.insertReference?.({ source: 'reference', ref: mention, label: `${record.displayTitle}/`,
            appearance: 'folder', clipboardText: mention }, span)
            ? { kind: 'completed' } : { kind: 'failed', message: text().stale }
        } },
      ]
    },
  }
  let removePicker: (() => void) | undefined
  let removeCommand: () => void
  try {
    removePicker = palette.registerPicker(picker)
    removeCommand = palette.registerCommand({
      id: WORKSPACE_COMMAND_ID,
      describe: () => ({ title: text().title, localizedTitles: { zh: browserZh.title, en: browserEn.title },
        pluginTag: workspaceTag, iconId: 'open', category: text() === browserZh ? '工作区' : 'Workspace',
        aliases: ['workspaces.find', 'workspaces.browse-files', '选择工作区新建会话', 'Create New Session', '新建会话', 'new session',
          '浏览工作区文件', 'Browse Workspace Files', '切换工作区', 'Switch Workspace', '查找工作区', '搜索工作区', '打开工作区', '切换项目',
          'find workspace', 'search workspace', 'open workspace', 'switch project',
          '文件结构', '浏览项目', '复制路径', '文件引用', 'browse files', 'file tree', 'copy path', 'reference'] }),
      target: { kind: 'picker', pickerId: WORKSPACE_PICKER_ID },
    })
  } catch (error) { removePicker?.(); removePanel(); throw error }
  return () => { disposed = true; try { removeCommand() } finally { try { removePicker?.() } finally { removePanel() } } }
}

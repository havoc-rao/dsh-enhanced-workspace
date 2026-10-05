import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { CommandId, PaletteService, PanelId, PanelSnapshot } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import { FILE_BROWSER_ENDPOINT, type BrowserResult } from '../../shared/file-browser.ts'
import { PERSISTENCE_CHANNEL } from '../../shared/persistence.ts'
import { workspaceTag, type WorkspaceAdapter } from './provider.ts'
import { WorkspaceFileBrowser, browserZh, browserEn, fileMention, type FileBrowserAdapter } from './FileBrowser.tsx'
import type { BrowserInteraction } from './browser-interaction.ts'

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
  let query = ''
  let interaction: BrowserInteraction | undefined
  let adapter: FileBrowserAdapter | undefined
  let invocation = 0
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const text = () => ctx.locale.getSnapshot().active.toLowerCase().startsWith('zh') ? browserZh : browserEn
  const current = () => (ctx.get('uiSession') as unknown as SessionFace | undefined)?.adapter?.current?.getSnapshot()
  const getSnapshot = (): PanelSnapshot => {
    const state = interaction?.getState()
    const browsing = state?.stage !== undefined && state.stage !== 'workspace'
    return { title: browsing ? state.target?.label ?? text().title : text().title,
      placeholder: browsing ? text().filter : text().search, query,
      actionsTargetLabel: state?.target?.path ?? '',
      scrollMode: browsing ? 'contained' : 'content',
      width: browsing ? 'wide' : 'compact',
      canGoBack: state?.canGoBack ?? false, canAccept: state !== undefined && (state.stage !== 'workspace' || state.count > 0),
      acceptLabel: state?.stage === 'preview' ? (text() === browserZh ? '选择操作' : 'Actions') : text().title,
      footerText: state ? `${state.count}` : '', status: 'ready' }
  }
  const removePanel = palette.registerPanel({
    id: PANEL_ID, getSnapshot,
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    onOpen: () => {
      invocation++; query = ''; interaction = undefined
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
          if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return false
          const mention = fileMention(path, directory)
          return actions.insertReference({ source: 'reference', ref: mention, label: directory ? `${label}/` : label,
            appearance: directory ? 'folder' : 'file', clipboardText: mention }, span)
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
        && interaction?.getState().workspaceId === state.workspaceId
        && workspaces.getSnapshot().items.some(row => row.workspaceId === state.workspaceId)
      return [
        { id: 'copy-absolute-path', title: text().copy, aliases: ['copy', 'path', '复制'], execute: async ({ signal }) => {
          if (!valid(signal)) return { kind: 'cancelled' as const }
          await capturedAdapter.copy(target.path)
          return valid(signal) ? { kind: 'stay' as const } : { kind: 'cancelled' as const }
        } },
        { id: 'insert-reference', title: text().insert, aliases: ['inputbox', 'ref', '输入框'], execute: ({ signal }) => {
          if (!valid(signal)) return { kind: 'cancelled' as const }
          return capturedAdapter.insert(target.path, target.directory, target.label)
            ? { kind: 'completed' as const } : { kind: 'failed' as const, message: text().stale }
        } },
      ]
    },
    onQuery: value => { query = value; notify() },
    move: delta => interaction?.move(delta),
    back: () => interaction?.back() ?? false,
    accept: () => { interaction?.accept(); return { kind: 'stay' } },
    render: () => adapter ? <WorkspaceFileBrowser key={invocation} adapter={adapter} text={text()} close={() => palette.close()}
      shell={{ query, bind: value => { interaction = value; return () => { if (interaction === value) interaction = undefined } }, invalidate: notify, setQuery: value => { query = value; notify() }, openActions: () => { palette.openPanelActions() } }} /> : null,
  })
  let removeCommand: () => void
  try {
    removeCommand = palette.registerCommand({
      id: 'workspaces.browse-files' as CommandId,
      describe: () => ({ title: text().title, localizedTitles: { zh: browserZh.title, en: browserEn.title },
        pluginTag: workspaceTag, iconId: 'search', aliases: ['文件结构', '浏览项目', '复制路径', '文件引用', 'browse files', 'file tree', 'copy path', 'reference'] }),
      target: { kind: 'panel', panelId: PANEL_ID },
    })
  } catch (error) { removePanel(); throw error }
  return () => { try { removeCommand() } finally { removePanel() } }
}

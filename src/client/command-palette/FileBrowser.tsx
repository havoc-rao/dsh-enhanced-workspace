import { useEffect, useRef, useState } from 'react'
import { IconWorkspaceTreeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserEntry, BrowserRequest, BrowserResult } from '../../shared/file-browser.ts'
import type { WorkspaceRecord } from './provider.ts'
import css from './FileBrowser.module.css'
import { FileTreeLevel } from './FileTree.tsx'
import type { BrowserShell } from './browser-interaction.ts'

export interface FileBrowserAdapter {
  workspaces(): readonly WorkspaceRecord[]
  subscribe(listener: () => void): () => void
  browse(request: BrowserRequest, signal: AbortSignal): Promise<BrowserResult>
  insert(path: string, directory: boolean, label: string): boolean
  copy(path: string): Promise<void>
}
export const browserZh = {
  title: '浏览工作区文件', search: '搜索工作区名称或路径…', filter: '筛选当前目录…',
  close: '关闭', copy: '复制绝对路径', insert: '插入引用', copied: '已复制路径',
  hidden: '显示隐藏文件', loading: '加载中…', empty: '没有匹配的条目', preview: '选择文件查看预览',
  truncated: '结果已截断', stale: '输入框已变化或不可用，请关闭后重新打开', retry: '重试',
}
export const browserEn: typeof browserZh = {
  title: 'Browse Workspace Files', search: 'Search workspace names or paths…', filter: 'Filter this directory…',
  close: 'Close', copy: 'Copy Absolute Path', insert: 'Insert Reference', copied: 'Path copied',
  hidden: 'Show hidden files', loading: 'Loading…', empty: 'No matching entries', preview: 'Select a file to preview',
  truncated: 'Results truncated', stale: 'Composer changed or is unavailable; close and reopen', retry: 'Retry',
}
export function absoluteBrowserPath(root: string, path: string): string {
  const separator = /^[A-Za-z]:[\\/]|^\\\\/u.test(root) ? '\\' : '/'
  return root.replace(/[\\/]+$/u, '') + separator + path.split('/').filter(Boolean).join(separator)
}
export function fileMention(path: string, directory: boolean): string {
  const target = directory && !/[\\/]$/u.test(path) ? `${path}/` : path
  if (!/\s/u.test(target)) return `@${target}`
  // Native grammar leaves a quoted folder open for further descent.
  return directory ? `@"${target}` : `@"${target}"`
}

export function WorkspaceFileBrowser({ adapter, text, close, shell }: {
  adapter: FileBrowserAdapter; text: typeof browserZh; close(): void; shell?: BrowserShell
}) {
  const [workspaces, setWorkspaces] = useState(() => adapter.workspaces())
  const [workspaceId, setWorkspaceId] = useState('')
  const workspace = workspaces.find(row => row.workspaceId === workspaceId)
  const [localSearch, setSearch] = useState('')
  const search = shell?.query ?? localSearch
  const [activeWorkspace, setActiveWorkspace] = useState(0)
  const tree = useRef<HTMLDivElement>(null)
  const [hidden, setHidden] = useState(false)
  const [selected, setSelected] = useState<BrowserEntry | null>(null)
  const [preview, setPreview] = useState<Extract<BrowserResult, { kind: 'file' }> | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => adapter.subscribe(() => setWorkspaces(adapter.workspaces())), [adapter])
  useEffect(() => {
    setPreview(null); setLoading(false)
    if (!workspace || !selected || selected.directory) return
    setLoading(true)
    const controller = new AbortController()
    adapter.browse({ workspaceId: workspace.workspaceId, path: selected.path, preview: true }, controller.signal).then(result => {
      if (!controller.signal.aborted && result.kind === 'file') setPreview(result)
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [adapter, workspace?.workspaceId, selected, revision])
  const select = (entry: BrowserEntry) => { setSelected(entry); setPreview(null); setError(''); setNotice('') }
  const copy = (entry?: BrowserEntry) => {
    if (!workspace) return
    void adapter.copy(absoluteBrowserPath(workspace.path, entry?.path ?? '')).then(() => {
      if (alive.current) setNotice(text.copied)
    }).catch(reason => { if (alive.current) setError(String(reason)) })
  }
  const insert = (entry?: BrowserEntry) => {
    if (!workspace) return
    if (adapter.insert(absoluteBrowserPath(workspace.path, entry?.path ?? ''), entry?.directory ?? true, entry?.name ?? workspace.displayTitle)) close()
    else setError(text.stale)
  }
  const showPreview = workspace && selected && !selected.directory
  const target = workspace && selected ? absoluteBrowserPath(workspace.path, selected.path) : ''
  const stage = !workspace ? 'workspace' : showPreview ? 'preview' : 'tree'
  const matches = workspaces.filter(row => `${row.displayTitle} ${row.path}`.toLowerCase().includes(search.toLowerCase()))
  const chooseWorkspace = (id: string) => {
    if (id === workspaceId) return
    setWorkspaceId(id); setSelected(null); setPreview(null); setError(''); setNotice('')
    setSearch(''); shell?.setQuery?.('')
  }
  useEffect(() => shell?.bind({
    getState: () => ({ stage, canGoBack: !!workspace, count: workspace ? tree.current?.querySelectorAll('[role=treeitem]').length ?? 0 : matches.length,
      ...(workspace ? { workspaceId: workspace.workspaceId, target: {
        path: absoluteBrowserPath(workspace.path, selected?.path ?? ''), directory: selected?.directory ?? true,
        label: selected?.name ?? workspace.displayTitle,
      } } : {}),
    }),
    back: () => {
      if (showPreview) { setSelected(null); setPreview(null); return true }
      if (workspace) { setWorkspaceId(''); setSelected(null); setPreview(null); return true }
      return false
    },
    move: delta => {
      if (!workspace) { setActiveWorkspace(value => Math.max(0, Math.min(matches.length - 1, value + delta))); return }
      const rows = [...(tree.current?.querySelectorAll<HTMLButtonElement>('button[data-tree-main]') ?? [])].filter(row => !row.closest('[hidden]'))
      const index = rows.findIndex(row => row.dataset.path === selected?.path)
      const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))]
      if (next) select({ name: next.dataset.name!, path: next.dataset.path!, directory: next.dataset.directory === 'true' })
      next?.scrollIntoView?.({ block: 'nearest' })
    },
    accept: () => {
      if (!workspace) { const row = matches[Math.min(activeWorkspace, matches.length - 1)]; if (row) chooseWorkspace(row.workspaceId) }
      else if (selected && !selected.directory) shell?.openActions?.()
      else tree.current?.querySelector<HTMLButtonElement>(`button[data-tree-main][data-selected=true]`)?.click()
    },
  }), [shell, stage, workspace, matches.length, activeWorkspace, selected, search])
  useEffect(() => { shell?.invalidate() }, [stage, activeWorkspace, search, selected, workspaces])
  return <div className={css.browser} data-stage={stage} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.target instanceof HTMLInputElement) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const rows = [...(tree.current?.querySelectorAll<HTMLButtonElement>('button[data-tree-main]') ?? [])].filter(row => !row.closest('[hidden]'))
      const index = rows.findIndex(row => row.dataset.path === selected?.path)
      rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus()
    }
  }}>
      {!workspace && <aside className={`${css.workspaces} dsh-palette-list`} data-mode="picker">
        {!shell && <input autoFocus aria-label={text.search} placeholder={text.search} value={search} onChange={event => setSearch(event.target.value)} />}
        {matches.map((row, index) =>
          <button key={row.workspaceId} className={`dsh-palette-row ${css.workspaceRow}`}
            data-active={workspaceId === row.workspaceId || (!workspace && activeWorkspace === index)}
            aria-pressed={workspaceId === row.workspaceId || (!workspace && activeWorkspace === index)}
            onMouseDown={event => { if (shell) event.preventDefault() }}
            onMouseEnter={() => setActiveWorkspace(index)} onClick={() => chooseWorkspace(row.workspaceId)}>
            <span className="dsh-palette-row-icon" aria-hidden="true"><IconWorkspaceTreeOutlineRegular size={16} /></span>
            <span className="dsh-palette-row-text">
              <span className="dsh-palette-row-label" title={row.displayTitle}>{row.displayTitle}</span>
              <small className="dsh-palette-row-detail" title={row.path}>{row.path}</small>
            </span>
            {(workspaceId === row.workspaceId || (!workspace && activeWorkspace === index)) && <kbd className="dsh-palette-enter" aria-hidden="true">↵</kbd>}
          </button>)}
      </aside>}
      {workspace && <section className={css.files} aria-label={workspace.displayTitle}>
        <header className={css.treeHeader}>
          <strong>{workspace.displayTitle}</strong>
        </header>
        <label><input type="checkbox" checked={hidden} onChange={event => setHidden(event.target.checked)} />{text.hidden}</label>
        {error && <div role="alert">{error} <button onClick={() => setRevision(value => value + 1)}>{text.retry}</button></div>}
        {notice && <p role="status">{notice}</p>}
        <div ref={tree} role="tree" aria-label={workspace.displayTitle} className={css.entries}>
          <FileTreeLevel key={`${workspace.workspaceId}:${workspace.path}`} adapter={adapter} workspaceId={workspace.workspaceId}
            text={text} hidden={hidden} filter={search} selected={selected?.path} select={select} copy={copy} insert={insert} />
        </div>
      </section>}
      {workspace && !showPreview && <div className={css.previewPlaceholder} aria-hidden="true" />}
      {showPreview && <section className={css.previewPane} aria-label={selected.name}>
        <small className={css.path}>{target}</small>
        {loading ? <p role="status">{text.loading}</p> : preview && <>
          <pre>{preview.text}</pre>{preview.truncated && <p>{text.truncated}</p>}
        </>}
      </section>}
    </div>
}

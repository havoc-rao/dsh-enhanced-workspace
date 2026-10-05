import { useEffect, useState } from 'react'
import { IconChevronRightOutlineRegular, IconFolderCloseRegular, IconCopyOutlineRegular, IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserEntry, BrowserResult } from '../../shared/file-browser.ts'
import type { FileBrowserAdapter, browserZh } from './FileBrowser.tsx'
import css from './FileBrowser.module.css'

interface TreeProps {
  adapter: FileBrowserAdapter; workspaceId: string; text: typeof browserZh; hidden: boolean; filter?: string;
  selected: string | undefined; select(entry: BrowserEntry): void;
  copy(entry: BrowserEntry): void; insert(entry: BrowserEntry): void;
}
/** Each expanded level owns one bounded request; collapse retains data and nested state. */
export function FileTreeLevel({ path = '', depth = 0, ...props }: TreeProps & { path?: string; depth?: number }) {
  const [result, setResult] = useState<Extract<BrowserResult, { kind: 'directory' }> | null>(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setResult(null); setError('')
    props.adapter.browse({ workspaceId: props.workspaceId, path }, abort.signal).then(value => {
      if (!abort.signal.aborted && value.kind === 'directory') setResult(value)
    }).catch(reason => { if (!abort.signal.aborted) setError(String(reason)) })
    return () => abort.abort()
  }, [props.adapter, props.workspaceId, path, retry])
  if (error) return <div role="alert">{error}<button onClick={() => setRetry(value => value + 1)}>{props.text.retry}</button></div>
  if (!result) return <p role="status">{props.text.loading}</p>
  const entries = result.entries.filter(entry => (props.hidden || !entry.name.startsWith('.'))
    && (entry.directory || !props.filter || entry.path.toLowerCase().includes(props.filter.toLowerCase())))
  return <div role="group" className={depth ? css.subtree : undefined}>
    {entries.map(entry => <FileTreeRow key={entry.path} {...props} entry={entry} depth={depth} />)}
    {!entries.length && <p>{props.text.empty}</p>}
    {result.truncated && <p>{props.text.truncated}</p>}
  </div>
}
function FileTreeRow({ entry, depth, ...props }: TreeProps & { entry: BrowserEntry; depth: number }) {
  const [expanded, setExpanded] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const toggle = () => { setExpanded(value => !value); setLoaded(true) }
  return <div>
    <div role="treeitem" aria-level={depth + 1} aria-selected={props.selected === entry.path}
      aria-expanded={entry.directory ? expanded : undefined} className={css.treeRow}>
      <button className={css.rowMain} aria-label={entry.name} data-tree-main data-path={entry.path}
        data-name={entry.name} data-directory={entry.directory} data-selected={props.selected === entry.path} onKeyDown={event => {
          if (event.nativeEvent.isComposing) return
          if (entry.directory && event.key === 'ArrowRight') { event.preventDefault(); setExpanded(true); setLoaded(true) }
          if (entry.directory && event.key === 'ArrowLeft') { event.preventDefault(); setExpanded(false) }
        }} onFocus={() => props.select(entry)} onClick={() => {
        props.select(entry)
        if (entry.directory) toggle()
      }}>
        <span className={css.chevron} data-expanded={expanded}>
          {entry.directory && <IconChevronRightOutlineRegular />}
        </span>
        {entry.directory ? <IconFolderCloseRegular /> : <IconCodeOutlineRegular />}
        <span className={entry.name.startsWith('.') ? css.hiddenName : css.rowName}>{entry.name}</span>
      </button>
      <span className={css.rowActions}>
        <button title={props.text.copy} aria-label={`${props.text.copy}: ${entry.name}`} onClick={() => props.copy(entry)}><IconCopyOutlineRegular /></button>
        <button title={props.text.insert} aria-label={`${props.text.insert}: ${entry.name}`} onClick={() => props.insert(entry)}>＠</button>
      </span>
    </div>
    {entry.directory && loaded && <div hidden={!expanded}>
      <FileTreeLevel {...props} path={entry.path} depth={depth + 1} />
    </div>}
  </div>
}

/**
 * Hover-card bodies of the enhanced workspace browser, replicated from the
 * built-in ui-workspace rows: the workspace card (title + directory path +
 * absolute creation time; the whole card is a click-to-copy target for the
 * path) and the session card (title, relative time, every live status, and
 * the session's file domain — the read files and the write/edit files, each
 * as a flat `name | path` list by default, switchable to the merged
 * directory tree; file rows are clickable observation marks). The cards
 * themselves ride the shared `HoverCard` primitive (portaled, right of the
 * anchor row); this module only shapes the content and the session file box.
 * @module dsh-enhanced-workspace/client/HoverCards
 */

import { useState } from 'react'
import { IconCodeOutline16, IconFolderClose16, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { EnhancedWorkspaceBrowserProps } from './contract.ts'
import {
  recentFileList,
  recentFileTree,
  relativeTime,
  type RecentFileTreeRow,
  type SessionNode,
  type WorkspaceSessionStatus,
} from './model.ts'
import type { GitTreeInfoJSON, RemoteGitMarker } from '../shared/git.ts'
import {
  remoteBranchLabel,
  remoteMachineLabel,
} from './remote-git.ts'
import css from './Browser.module.css'

/** The browser root's locale seat, prop-passed from the row seats. */
type HoverTranslate = EnhancedWorkspaceBrowserProps['t']

/** Compact `dir`/`file` rows shown per section until the clickable remainder expands the full list. */
const RECENT_FILE_ROWS = 8

/**
 * Absolute creation time through the dictionary's date template (the message
 * clock pattern): `toLocaleString` would follow the browser language, not the
 * app locale, and produce mixed-language text after a switch.
 */
function createdLabel(createdAt: number, t: HoverTranslate): string {
  const d = new Date(createdAt)
  const pad2 = (v: number): string => String(v).padStart(2, '0')
  const date = t('dateYmd', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() })
  return t('hoverCreated', { time: `${date} ${pad2(d.getHours())}:${pad2(d.getMinutes())}` })
}

/**
 * Relative time of the hover card: the compact bucket the rows use ("5 分钟前"
 * / "5min" in en), unlike the row's own trailing label (the plugin's session
 * rows carry no time cell — the card is where the recency stamp reads).
 */
function hoverTimeLabel(updatedAt: number, now: number, t: HoverTranslate): string {
  const { unit, n } = relativeTime(updatedAt, now)
  switch (unit) {
    case 'now': return t('timeNow')
    case 'minutes': return t('timeMinutes', { n })
    case 'hours': return t('timeHours', { n })
    case 'days': return t('timeDays', { n })
    case 'months': return t('timeMonths', { n })
    case 'years': return t('timeYears', { n })
  }
}

/** Hover-card body: display directory path and absolute creation time. */
export function WorkspaceHoverContent({ label, cwd, createdAt, t, git, remote, status }: {
  label: string
  /** The workspace's host directory; absent keeps the card title + time only. */
  cwd: string | undefined
  createdAt: number
  t: HoverTranslate
  /** Aggregated session-status counts of the workspace's visible sessions
   *  (waiting / working / completed) — the collapsed-dir marker's data;
   *  every nonzero count renders a live status line. Absent keeps the
   *  status section off the card. */
  status?: WorkspaceSessionStatus
  /** Git binding of the workspace path: the tree it sits in plus its peer
   *  trees (same repo). `null` = probed and no git; `undefined` = probe
   *  unavailable (no git section at all). */
  git?: { tree: GitTreeInfoJSON; peers: readonly GitTreeInfoJSON[] } | null
  /** Remote-mirror marker (dsh-remote): the workspace's REMOTE git state —
   *  branch + sync + owning machine. Takes precedence over
   *  `git` (a mirror's local `.git` walk is never authoritative). */
  remote?: RemoteGitMarker
}) {
  // Remote section: `⎇ branch`, the upstream sync row, and the owning
  // machine + remote path. Counts (dirty/staged) are intentionally absent —
  // user feedback; dsh-remote's own chip dropped them too.
  const syncParts: string[] = []
  if (remote !== undefined && remote.upstream !== undefined && remote.upstream !== '') {
    if ((remote.ahead ?? 0) > 0) syncParts.push(`↑${remote.ahead}`)
    if ((remote.behind ?? 0) > 0) syncParts.push(`↓${remote.behind}`)
    if (remote.gone === true) syncParts.push('gone')
  }
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverHeading}>
        <div className={css.hoverTitle}>{label}</div>
      </div>
      {cwd !== undefined && <div className={css.hoverPath}>{cwd}</div>}
      <div className={css.hoverTime}>{createdLabel(createdAt, t)}</div>
      {/* The collapsed-dir marker's detail: each nonzero session-state count
          renders a live status line in the session card's own status-line
          language, top-priority first (waiting > working > completed). */}
      {status !== undefined && (['warning', 'ongoing', 'done'] as const).map(state => {
        const count = status[state]
        if (count === undefined || count < 1) return null
        return (
          <div className={css.hoverStatus} key={state}>
            <StateDot state={state} />
            <span>{workspaceStatusLabel(state, count, t)}</span>
          </div>
        )
      })}
      {remote !== undefined && (
        <div className={css.hoverGit}>
          <div className={css.hoverGitRow}>
            <span className={css.hoverGitKey}>{t('hoverBranch')}</span>
            <span className={css.hoverGitPill}>
              <span className={css.gitRemoteGlyph} aria-hidden="true">⎇</span>
              {` ${remoteBranchLabel(remote)}`}
            </span>
          </div>
          {syncParts.length > 0 && (
            <div className={css.hoverGitRow}>
              <span className={css.hoverGitKey}>{t('hoverGitSync')}</span>
              <span className={css.hoverGitValue}>{syncParts.join(' ')}</span>
            </div>
          )}
          <div className={css.hoverGitRow}>
            <span className={css.hoverGitKey}>{t('hoverRemote')}</span>
            <span className={css.hoverGitValue}>{remoteMachineLabel(remote.machine)}</span>
          </div>
          <div className={css.hoverGitRow}>
            <span className={css.hoverGitKey}>{t('hoverRemotePath')}</span>
            <span className={css.hoverGitPath}>{remote.remotePath}</span>
          </div>
        </div>
      )}
      {remote === undefined && git === null && <div className={css.hoverNoGit}>{t('hoverNoGit')}</div>}
      {remote === undefined && git !== undefined && git !== null && (
        <div className={css.hoverGit}>
          <div className={css.hoverGitRow}>
            <span className={css.hoverGitKey}>{t('hoverBranch')}</span>
            <span className={css.hoverGitPill}>{git.tree.branch ?? git.tree.detached ?? '—'}</span>
          </div>
          <div className={css.hoverGitRow}>
            <span className={css.hoverGitKey}>{t('hoverRole')}</span>
            <span className={css.hoverGitValue}>
              {git.tree.role === 'main' ? t('hoverRoleMain') : t('hoverRoleLinked')}
            </span>
          </div>
          {git.peers.length > 0 && (
            <div className={css.hoverPeerList}>
              <div className={css.hoverGitKey}>{t('hoverPeerTrees')}</div>
              {git.peers.map(peer => (
                <div key={peer.root} className={css.hoverPeerRow}>
                  <span className={css.hoverPeerName}>{basenameOf(peer.root)}</span>
                  <span className={css.hoverGitPill}>{peer.branch ?? peer.detached ?? '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Path basename (browser-safe helper for the peer-tree rows). */
function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '')
  const sep = trimmed.lastIndexOf('/')
  return sep >= 0 ? trimmed.slice(sep + 1) : trimmed
}

/** One visible status line of the session hover card: dot state + label. */
interface HoverStatus {
  state: StateDotState
  label: string
}

/**
 * The collapsed-dir status label: "n 个会话正在工作 / 等待处理 / 已完成" —
 * the workspace row's dot title/aria and the workspace hover card's status
 * lines share this spelling per dot state (plural-picked so the en copy
 * stays grammatical).
 */
export function workspaceStatusLabel(state: StateDotState, n: number, t: HoverTranslate): string {
  const one = n === 1
  switch (state) {
    case 'warning':
      return one ? t('workspaceSessionsWaitingOne', { n }) : t('workspaceSessionsWaitingOther', { n })
    case 'ongoing':
      return one ? t('workspaceSessionsWorkingOne', { n }) : t('workspaceSessionsWorkingOther', { n })
    case 'done':
      return one ? t('workspaceSessionsCompletedOne', { n }) : t('workspaceSessionsCompletedOther', { n })
    /* v8 ignore next -- closed ui-primitives StateDotState union */
    default:
      return one ? t('workspaceSessionsWorkingOne', { n }) : t('workspaceSessionsWorkingOther', { n })
  }
}

/**
 * Session status presentation of the hover card; pending interaction is
 * primary and live activity outranks completion reminders — the same
 * outranking the row's status dot applies.
 */
function hoverStatuses(node: SessionNode, t: HoverTranslate): readonly HoverStatus[] {
  const subagents: HoverStatus | undefined = node.runningSubagentCount === 0
    ? undefined
    : {
      state: 'ongoing',
      label: node.runningSubagentCount === 1
        ? t('sessionStatusSubagentsOne', { n: node.runningSubagentCount })
        : t('sessionStatusSubagentsOther', { n: node.runningSubagentCount }),
    }
  let pending: HoverStatus | undefined
  switch (node.pendingInteraction) {
    case 'approval':
      pending = { state: 'warning', label: t('sessionStatusWaitingApproval') }
      break
    case 'escalation':
      pending = { state: 'warning', label: t('sessionStatusEscalation') }
      break
    case 'plan-review':
      pending = { state: 'warning', label: t('sessionStatusPlanReview') }
      break
    case 'question':
      pending = { state: 'warning', label: t('sessionStatusWaitingAnswer') }
      break
    /* v8 ignore next -- closed PendingInteractionStatus union */
    default: break
  }
  if (pending !== undefined) return subagents === undefined ? [pending] : [pending, subagents]
  if (node.running) {
    const primary: HoverStatus = { state: 'ongoing', label: t('sessionStatusOngoing') }
    return subagents === undefined ? [primary] : [primary, subagents]
  }
  if (subagents !== undefined) return [subagents]
  if (node.completed) return [{ state: 'done', label: t('sessionStatusDone') }]
  return [{ state: 'done', label: t('sessionStatusIdle') }]
}

/**
 * Tree-mode vertical indent guides of the hover file box: one 1px line per
 * ancestor level, aligned under each ancestor's glyph column (the indent
 * step is 12px, a glyph's center sits 7px into its slot). Rendered as a
 * multi-stop background so the row's selection tint and the guides coexist.
 * @param depth - the row's tree depth.
 * @returns a CSS background-image value, or undefined for root-level rows.
 */
function hoverIndentGuides(depth: number): string | undefined {
  if (depth === 0) return undefined
  const lines: string[] = []
  for (let level = 0; level < depth; level += 1) {
    const x = level * 12 + 7
    lines.push(
      // The guide stroke rides the host's border-l2 token (dark: white
      // alpha, light: black alpha) so the hover tree adapts to the theme.
      `linear-gradient(to right, transparent ${x}px, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12)) ${x}px, var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12)) ${x + 1}px, transparent ${x + 1}px)`,
    )
  }
  return lines.join(', ')
}

/**
 * One labeled directory-tree section of the hover card: caption heading with
 * the side's file count, then icon-led indented rows (folder glyph for
 * merged directories, code glyph for files) in the code face. The section
 * shows at most {@link RECENT_FILE_ROWS} rows at a time; a clickable exact
 * remainder line expands the full list inside the scrollable file box. File
 * rows are clickable targets: clicking one marks it (background tint) for
 * observation; clicking it again clears the mark.
 */
function RecentFilesSection({ label, files, t, selected, onSelect }: {
  label: string
  files: { rows: readonly RecentFileTreeRow[]; hiddenFiles: number }
  t: HoverTranslate
  selected: string | null
  onSelect: (path: string) => void
}) {
  const [expanded, setExpanded] = useState(false)
  // The derivation is full (the scroll box bounds the card); the compact cap
  // is this section's own slice, in the same DFS order the derivation walked.
  const shownRows = expanded ? files.rows : files.rows.slice(0, RECENT_FILE_ROWS)
  const fileCount = files.rows.filter(row => row.kind === 'file').length + files.hiddenFiles
  const hidden = fileCount - shownRows.filter(row => row.kind === 'file').length
  return (
    <div className={css.hoverFiles}>
      <div className={css.hoverFilesHeader}>
        <span className={css.hoverFilesLabel}>{label}</span>
        <span className={css.hoverFilesCount}>· {fileCount}</span>
      </div>
      <div className={css.hoverFilesTree}>
        {shownRows.map((row, index) => {
          const isFile = row.kind === 'file'
          const marked = selected === row.path
          const guides = hoverIndentGuides(row.depth)
          const rowStyle = {
            paddingLeft: row.depth * 12,
            ...(guides === undefined ? {} : { backgroundImage: guides }),
          }
          const inner = (
            <>
              <span className={css.hoverFileGlyph} aria-hidden="true">
                {row.kind === 'dir' ? <IconFolderClose16 size={14} /> : <IconCodeOutline16 size={14} />}
              </span>
              <span className={row.kind === 'dir' ? css.hoverFileDirName : css.hoverFileName}>
                {row.kind === 'dir' ? `${row.name}/` : row.name}
              </span>
            </>
          )
          // File rows are clickable observation targets; directory rows are
          // plain indentation scaffolding (evergreen, not interactive).
          return isFile
            ? (
              <button
                key={`${row.depth}:${row.name}:${index}`}
                type="button"
                className={`${css.hoverFileRow} ${css.hoverFileRowSelectable}${marked ? ` ${css.hoverFileRowSelected}` : ''}`}
                style={rowStyle}
                title={row.path}
                aria-label={row.path}
                aria-pressed={marked}
                onClick={() => { onSelect(row.path) }}
              >
                {inner}
              </button>
            )
            : (
              <div
                key={`${row.depth}:${row.name}:${index}`}
                className={css.hoverFileRow}
                style={rowStyle}
                title={row.path}
              >
                {inner}
              </div>
            )
        })}
        {hidden > 0 && !expanded && (
          <button
            type="button"
            className={css.hoverFilesMore}
            onClick={() => { setExpanded(true) }}
          >
            {t('hoverRecentFilesMore', { n: String(hidden) })}
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * One labeled flat-list section of the hover card (list mode): caption
 * heading with the side's file count over `name | path` rows laid out
 * directly, every file of the side, in recency order. No row budget — the
 * scrollable file box bounds the card. Rows are clickable targets: clicking
 * one marks it (background tint) for observation; clicking it again clears
 * the mark.
 */
function RecentFilesListSection({ label, paths, root, selected, onSelect }: {
  label: string
  paths: readonly string[]
  root: string | undefined
  selected: string | null
  onSelect: (path: string) => void
}) {
  const rows = recentFileList(paths, root)
  return (
    <div className={css.hoverFiles}>
      <div className={css.hoverFilesHeader}>
        <span className={css.hoverFilesLabel}>{label}</span>
        <span className={css.hoverFilesCount}>· {rows.length}</span>
      </div>
      <div className={css.hoverFilesTree}>
        {rows.map((row, index) => {
          const marked = selected === row.path
          return (
            <button
              key={`${row.path}:${index}`}
              type="button"
              className={`${css.hoverFileRow} ${css.hoverFileRowSelectable}${marked ? ` ${css.hoverFileRowSelected}` : ''}`}
              title={row.path}
              aria-label={row.path}
              aria-pressed={marked}
              onClick={() => { onSelect(row.path) }}
            >
              <span className={css.hoverFileListName}>{row.name}</span>
              <span className={css.hoverFileListDivider} aria-hidden="true">|</span>
              <span className={css.hoverFileListPath}>{row.path}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Session hover-card body: full title, relative time, every relevant live
 * status, and the session's file domain — the read files (input sources) and
 * the write/edit files (output sources), each as a flat `name | path` list by
 * default, switchable to the merged directory tree. The blank New Session
 * placeholder drops the timestamp line (nothing has happened in it yet).
 * @param node - the derived session row.
 * @param now - current epoch ms (injected for pure rendering).
 * @param t - the browser root's locale seat.
 * @returns the card body element.
 */
export function SessionHoverContent({ node, now, t }: { node: SessionNode; now: number; t: HoverTranslate }) {
  const statuses = hoverStatuses(node, t)
  // List mode (name | path, laid out flat) is the default; the toolbar
  // toggle switches the file box to the merged directory tree.
  const [flat, setFlat] = useState(true)
  // One marked file row for observation: clicking a row highlights it,
  // clicking it again clears the mark (null = nothing marked).
  const [selected, setSelected] = useState<string | null>(null)
  const toggleSelected = (path: string): void => {
    setSelected(marked => marked === path ? null : path)
  }
  // Derive every row (the session-stats lists are host-capped at 32 and the
  // scrollable file box bounds the card); the per-section compact cap and the
  // clickable remainder live in RecentFilesSection.
  const inputs = node.recentInputs.length === 0
    ? undefined
    : recentFileTree(node.recentInputs, Number.POSITIVE_INFINITY, node.cwd)
  const outputs = node.recentOutputs.length === 0
    ? undefined
    : recentFileTree(node.recentOutputs, Number.POSITIVE_INFINITY, node.cwd)
  const hasFiles = inputs !== undefined || outputs !== undefined
  return (
    <div className={css.hoverContent}>
      <div className={css.hoverTitle}>{node.blank ? t('newSession') : node.title}</div>
      {/* Same placeholder rule as the row body: no timestamp before the
          first prompt. */}
      {!node.blank && <div className={css.hoverTime}>{hoverTimeLabel(node.updatedAt, now, t)}</div>}
      {statuses.map(status => (
        <div className={css.hoverStatus} key={status.label}>
          <StateDot state={status.state} />
          <span>{status.label}</span>
        </div>
      ))}
      {hasFiles && (
        <div className={css.hoverFilesToolbar}>
          <button
            type="button"
            className={css.hoverModeButton}
            aria-label={flat ? t('hoverViewTree') : t('hoverViewList')}
            onClick={() => { setFlat(v => !v) }}
          >
            {flat ? t('hoverViewTree') : t('hoverViewList')}
          </button>
        </div>
      )}
      {/* The whole file domain scrolls as one box: long input/output lists
          stay reachable without stretching the card past the viewport. */}
      {hasFiles && (
        <div className={css.hoverFilesScroll} data-hover-files-scroll>
          {inputs !== undefined && (flat
            ? <RecentFilesListSection label={t('hoverRecentInputs')} paths={node.recentInputs} root={node.cwd} selected={selected} onSelect={toggleSelected} />
            : <RecentFilesSection label={t('hoverRecentInputs')} files={inputs} t={t} selected={selected} onSelect={toggleSelected} />)}
          {outputs !== undefined && (flat
            ? <RecentFilesListSection label={t('hoverRecentOutputs')} paths={node.recentOutputs} root={node.cwd} selected={selected} onSelect={toggleSelected} />
            : <RecentFilesSection label={t('hoverRecentOutputs')} files={outputs} t={t} selected={selected} onSelect={toggleSelected} />)}
        </div>
      )}
    </div>
  )
}
/**
 * Host-side durable envelope of the enhanced workspace browser: structural
 * validation of the persisted viewing state plus atomic whole-file
 * persistence under `<dsh-home>/storages/`.
 *
 * Why this exists: the client's `defineStore` originally persisted the
 * envelope to localStorage (`persist: 'dsh.enhanced-workspace.v1'`), but the
 * desktop app binds its webserver to an OS-assigned port on every launch
 * (`port: 0` in the electron patch), and Chromium partitions localStorage by
 * origin — port included — so every restart mints a fresh storage bucket and
 * the multi-level directory tree silently vanished. The envelope now lives
 * as one JSON file next to the platform's own storages (`workspace.json`,
 * `session_projcache.json`), read and written over the plugin's own
 * Connection RPC channel (`/enhanced-workspace`, registered in
 * `src/index.ts`).
 *
 * The module is self-contained on purpose: it must not value-import the
 * client data plane (the host node bundle would inline the browser model),
 * so the persisted shape is re-declared here and coupled to
 * `EnhancedWorkspaceState` by construction. Every function is pure except
 * the two file functions; validation is strict so a hand-edited or corrupt
 * file can never poison the browser (a rejected file is simply dropped).
 * @module dsh-enhanced-workspace/host/storage
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** File name of the persisted envelope inside the storages dir. */
export const STORAGE_FILE_NAME = 'dsh-enhanced-workspace.json'

/** Serialized envelope size cap (the tree is a few KB; the cap is a sanity fence). */
export const MAX_ENVELOPE_BYTES = 1024 * 1024

/** Maximum tree depth, root included — the client's model cap, mirrored for validation. */
export const MAX_FOLDER_DEPTH = 6

/** One durable folder record of the persisted envelope (see the client's FolderRecord). */
export interface PersistedFolderRecord {
  folderId: string
  name: string
  parentFolderId: string | null
  workspaceIds: string[]
  folderIds: string[]
  createdAt: string
  updatedAt: string
}

/**
 * The persisted envelope: the client's whole durable viewing state
 * (`EnhancedWorkspaceState`), re-declared for the host without importing the
 * client data plane.
 */
export interface PersistedEnvelope {
  folders: Record<string, PersistedFolderRecord>
  folderExpansion: Record<string, boolean>
  recentTouchById: Record<string, number>
  groupBy: 'workspace' | 'flat'
  orderBy: 'updated' | 'manual'
  groupExpansion: Record<string, boolean>
  sessionOrderByAccount: Record<string, string[]>
  sessionUpdatedAtByAccount: Record<string, Record<string, number>>
}

/** The exact top-level key set an envelope may carry (strict: no surprises from older/newer shapes). */
const ENVELOPE_KEYS = [
  'folderExpansion',
  'folders',
  'groupBy',
  'groupExpansion',
  'orderBy',
  'recentTouchById',
  'sessionOrderByAccount',
  'sessionUpdatedAtByAccount',
] as const

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return isPlainRecord(value) && Object.values(value).every(item => typeof item === 'boolean')
}

function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  return isPlainRecord(value) && Object.values(value).every(item => typeof item === 'number' && Number.isFinite(item))
}

function isFiniteNumberTable(value: unknown): value is Record<string, Record<string, number>> {
  return isPlainRecord(value) && Object.values(value).every(isFiniteNumberRecord)
}

/**
 * Whether `value` is one structurally sound {@link PersistedEnvelope}: exact
 * top-level key set, typed maps, and a folder tree that is cycle-free,
 * depth-capped, root-anchored, and bidirectionally accounted (every child is
 * listed by its parent and every listed child names that parent). Strict by
 * design — the client's model functions are cycle-guarded and fail loud, so
 * the durable boundary must reject anything they cannot render.
 * @param value - candidate envelope (any JSON value).
 * @returns whether the value passes every structural check.
 */
export function validateEnvelope(value: unknown): value is PersistedEnvelope {
  if (!isPlainRecord(value)) return false
  if (Object.keys(value).sort().join('\u0000') !== [...ENVELOPE_KEYS].sort().join('\u0000')) return false
  if (value.groupBy !== 'workspace' && value.groupBy !== 'flat') return false
  if (value.orderBy !== 'updated' && value.orderBy !== 'manual') return false
  if (!isBooleanRecord(value.folderExpansion)) return false
  if (!isFiniteNumberRecord(value.recentTouchById)) return false
  if (!isBooleanRecord(value.groupExpansion)) return false
  if (!isPlainRecord(value.sessionOrderByAccount)
    || !Object.values(value.sessionOrderByAccount).every(isStringArray)) return false
  if (!isFiniteNumberTable(value.sessionUpdatedAtByAccount)) return false

  const folders = value.folders
  if (!isPlainRecord(folders)) return false
  const root = folders.root
  if (!isPlainRecord(root)) return false
  if (root.folderId !== 'root' || root.parentFolderId !== null) return false

  for (const [key, record] of Object.entries(folders)) {
    if (!isPlainRecord(record)) return false
    if (record.folderId !== key) return false
    if (typeof record.name !== 'string' || record.name.trim() === '') return false
    if (!isStringArray(record.workspaceIds) || !isStringArray(record.folderIds)) return false
    if (typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string') return false
    const parent = record.parentFolderId
    if (parent !== null) {
      if (typeof parent !== 'string') return false
      const parentRecord = folders[parent] as { readonly folderIds: unknown } | undefined
      if (parentRecord === undefined || !Array.isArray(parentRecord.folderIds) || !parentRecord.folderIds.includes(key)) return false
    }
    // Child accounts: every listed child exists and names this folder back.
    for (const childId of record.folderIds) {
      const child = folders[childId] as { readonly parentFolderId: unknown } | undefined
      if (child === undefined || child.parentFolderId !== key) return false
    }
  }

  // Parent-chain walks: every folder reaches the root within the depth cap
  // and no walk revisits a folder (cycles are rejected, never hung on).
  for (const folderId of Object.keys(folders)) {
    const visited = new Set<string>()
    let cursor: string | undefined = folderId
    let depth = 0
    while (cursor !== undefined) {
      depth += 1
      if (depth > MAX_FOLDER_DEPTH) return false
      if (visited.has(cursor)) return false
      visited.add(cursor)
      // See the client model's depthOf: the loop-back assignment makes the
      // record type circular without the explicit annotation.
      const record: { readonly parentFolderId: string | null } | undefined =
        folders[cursor] as { readonly parentFolderId: string | null } | undefined
      if (record === undefined) return false
      cursor = record.parentFolderId ?? undefined
    }
  }
  return true
}

/** Serialized size of an envelope, or `Infinity` when it does not stringify. */
export function envelopeByteSize(value: PersistedEnvelope): number {
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return Infinity
  }
}

/**
 * Resolve the DSH home directory (mirror of `resolveDshHome` from
 * `@deepseek-ai/dsh-home-paths`, hand-rolled so the host bundle needs no
 * runtime dependency): `$DSH_HOME` when set and non-blank, else
 * `~/.dsh`; `~` prefixes expand to the home directory.
 * @param env - environment mapping (defaults to `process.env`).
 * @returns the absolute DSH home path.
 */
export function resolveDshHome(
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): string {
  const selected = env.DSH_HOME?.trim()
  if (selected === undefined || selected === '') return join(home, '.dsh')
  if (selected === '~') return home
  if (selected.startsWith('~/') || selected.startsWith('~\\')) return join(home, selected.slice(2))
  return resolve(selected)
}

/** Absolute path of the plugin's envelope file for a DSH home. */
export function envelopeFilePath(dshHome: string): string {
  return join(dshHome, 'storages', STORAGE_FILE_NAME)
}

/**
 * Read and validate the envelope file. A missing file, an unreadable file,
 * or a file whose content fails validation all read as `null` (the caller
 * treats null as "nothing durable yet"); any other I/O error propagates so
 * the RPC handler can report it.
 * @param filePath - absolute envelope file path.
 * @returns the validated envelope, or null when nothing usable is stored.
 */
export async function readEnvelopeFile(filePath: string): Promise<PersistedEnvelope | null> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  return validateEnvelope(parsed) ? parsed : null
}

/**
 * Persist the envelope atomically: write a sibling temp file (fresh bytes
 * per call) and rename it over the target. A crash mid-write leaves the
 * previous envelope intact; a concurrent writer resolves by last rename.
 * @param filePath - absolute envelope file path.
 * @param envelope - validated envelope to store.
 */
export async function writeEnvelopeFile(filePath: string, envelope: PersistedEnvelope): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, filePath)
}
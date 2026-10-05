import { constants } from 'node:fs'
import { open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { BrowserRequest, BrowserResult } from '../shared/file-browser.ts'

export interface BrowserRegistry { get(id: string): { readonly path: string } | undefined }
const ENTRY_LIMIT = 2000
const PREVIEW_BYTES = 64 * 1024
/** Resolve against the live registered root; never allow traversal or escaping symlinks. */
export async function browseWorkspace(registry: BrowserRegistry | undefined, request: BrowserRequest): Promise<BrowserResult> {
  if (!request || typeof request.workspaceId !== 'string' || typeof request.path !== 'string') throw new Error('Invalid file browser request')
  const workspace = registry?.get(request.workspaceId)
  if (!workspace) throw new Error('Workspace is unavailable')
  const root = await realpath(workspace.path)
  const target = await realpath(resolve(root, request.path))
  const within = relative(root, target)
  if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error('Path is outside the workspace')
  if (request.preview) {
    if (!(await stat(target)).isFile()) throw new Error('Not a regular file')
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile()) throw new Error('Not a regular file')
      const bytes = Buffer.alloc(Math.min(stat.size, PREVIEW_BYTES))
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      const content = bytes.subarray(0, bytesRead)
      if (content.includes(0)) throw new Error('Binary file: preview unavailable')
      return { kind: 'file', text: content.toString('utf8'), truncated: stat.size > bytesRead }
    } finally { await file.close() }
  }
  const entries = await readdir(target, { withFileTypes: true })
  // Symlinks intentionally excluded: no accidental traversal into another project.
  const visible = entries.filter(entry => entry.isDirectory() || entry.isFile())
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
  return { kind: 'directory', entries: visible.slice(0, ENTRY_LIMIT).map(entry => ({
    name: entry.name, path: [request.path.replace(/\/$/u, ''), entry.name].filter(Boolean).join('/'), directory: entry.isDirectory(),
  })), truncated: visible.length > ENTRY_LIMIT }
}

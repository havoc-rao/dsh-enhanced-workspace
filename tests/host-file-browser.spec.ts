import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browseWorkspace } from '../src/host/file-browser.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) {
    // Verify the exact fixture target before deleting it.
    if (!root.startsWith(join(tmpdir(), 'dsh-browser-'))) throw new Error('Unexpected fixture path')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-')); roots.push(root)
  await mkdir(join(root, 'project')); await mkdir(join(root, 'project', 'src'))
  await writeFile(join(root, 'project', 'a.txt'), 'hello\n世界')
  await writeFile(join(root, 'outside.txt'), 'secret')
  const registry = { get: (id: string) => id === 'project' ? { path: join(root, 'project') } : undefined }
  return { root, registry }
}
describe('read-only workspace browser', () => {
  it('lists directories first and previews bounded text without any session', async () => {
    const { registry } = await fixture()
    expect(await browseWorkspace(registry, { workspaceId: 'project', path: '' })).toEqual({ kind: 'directory', truncated: false, entries: [
      { name: 'src', path: 'src', directory: true }, { name: 'a.txt', path: 'a.txt', directory: false },
    ] })
    expect(await browseWorkspace(registry, { workspaceId: 'project', path: 'a.txt', preview: true })).toEqual({ kind: 'file', text: 'hello\n世界', truncated: false })
  })
  it('rejects deleted workspaces, traversal, absolute escapes and symlinks outside the root', async () => {
    const { root, registry } = await fixture()
    await symlink(join(root, 'outside.txt'), join(root, 'project', 'escape.txt'))
    for (const path of ['../outside.txt', join(await realpath(root), 'outside.txt'), 'escape.txt']) {
      await expect(browseWorkspace(registry, { workspaceId: 'project', path, preview: true })).rejects.toThrow('outside')
    }
    await expect(browseWorkspace(registry, { workspaceId: 'missing', path: '' })).rejects.toThrow('unavailable')
    expect((await browseWorkspace(registry, { workspaceId: 'project', path: '' }))).not.toHaveProperty('entries.2')
  })
  it('refuses binary and nonregular previews and caps content', async () => {
    const { root, registry } = await fixture()
    await writeFile(join(root, 'project', 'binary'), Buffer.from([0, 1]))
    await writeFile(join(root, 'project', 'large'), 'x'.repeat(70000))
    await expect(browseWorkspace(registry, { workspaceId: 'project', path: 'binary', preview: true })).rejects.toThrow('Binary')
    await expect(browseWorkspace(registry, { workspaceId: 'project', path: 'src', preview: true })).rejects.toThrow('regular')
    const result = await browseWorkspace(registry, { workspaceId: 'project', path: 'large', preview: true })
    expect(result).toMatchObject({ kind: 'file', truncated: true })
    if (result.kind === 'file') expect(result.text.length).toBe(65536)
  })
})

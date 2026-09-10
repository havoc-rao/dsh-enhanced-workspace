/**
 * Unit spec of the host-side durable envelope (src/host/storage.ts): the
 * strict structural validation a client write must pass before it touches
 * the envelope file, the atomic file round-trip, and the DSH-home
 * resolution. Pure node environment — no jsdom, no DSH boot.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_FOLDER_DEPTH,
  envelopeByteSize,
  envelopeFilePath,
  readEnvelopeFile,
  resolveDshHome,
  validateEnvelope,
  writeEnvelopeFile,
  type PersistedEnvelope,
} from '../src/host/storage.ts'

const HOME = '/Users/tester'
const ROOT_RECORD = {
  folderId: 'root',
  name: 'Root',
  parentFolderId: null,
  workspaceIds: [],
  folderIds: ['f1'],
  createdAt: '0',
  updatedAt: '0',
}

/** One structurally valid envelope: root + two nested folders + typed maps. */
function validEnvelope(): PersistedEnvelope {
  return {
    folders: {
      root: ROOT_RECORD,
      f1: {
        folderId: 'f1',
        name: '团队',
        parentFolderId: 'root',
        workspaceIds: ['w1'],
        folderIds: ['f2'],
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
      },
      f2: {
        folderId: 'f2',
        name: '产品',
        parentFolderId: 'f1',
        workspaceIds: ['w2'],
        folderIds: [],
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:00.000Z',
      },
    },
    folderExpansion: { f1: true, 'f2': false, dead: true },
    recentTouchById: { w1: 1788514153563 },
    groupBy: 'workspace',
    orderBy: 'manual',
    groupExpansion: { w1: true, 'recent:w1': true },
    sessionOrderByAccount: { w1: ['s1', 's2'], __flat_session_order__: [] },
    sessionUpdatedAtByAccount: { w1: { s1: 1, s2: 2 } },
  }
}

/** Deep-clone so tests can mutate a fixture without cross-test bleed. */
function envelope(): PersistedEnvelope {
  return structuredClone(validEnvelope())
}

let scratch: string | undefined

afterEach(async () => {
  if (scratch !== undefined) {
    await rm(scratch, { recursive: true, force: true })
    scratch = undefined
  }
})

/** Fresh temp dir for file tests, tracked for cleanup. */
async function tempDir(): Promise<string> {
  scratch = await mkdtemp(join(tmpdir(), 'dsh-enhanced-workspace-storage-'))
  return scratch
}

describe('resolveDshHome', () => {
  it('defaults to ~/.dsh', () => {
    expect(resolveDshHome({}, HOME)).toBe(join(HOME, '.dsh'))
  })

  it('prefers a non-blank $DSH_HOME and expands ~ prefixes', () => {
    expect(resolveDshHome({ DSH_HOME: '/custom/home' }, HOME)).toBe(resolve('/custom/home'))
    expect(resolveDshHome({ DSH_HOME: '~/dev/dsh' }, HOME)).toBe(join(HOME, 'dev', 'dsh'))
    expect(resolveDshHome({ DSH_HOME: '~' }, HOME)).toBe(HOME)
  })

  it('treats a whitespace-only $DSH_HOME as unset', () => {
    expect(resolveDshHome({ DSH_HOME: '   ' }, HOME)).toBe(join(HOME, '.dsh'))
  })

  it('places the envelope file under the storages dir', () => {
    expect(envelopeFilePath(resolveDshHome({}, HOME))).toBe(join(HOME, '.dsh', 'storages', 'dsh-enhanced-workspace.json'))
  })
})

describe('validateEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(validateEnvelope(envelope())).toBe(true)
  })

  it('rejects non-objects and unknown / missing top-level keys', () => {
    expect(validateEnvelope(null)).toBe(false)
    expect(validateEnvelope(42)).toBe(false)
    expect(validateEnvelope({ ...envelope(), surprise: true })).toBe(false)
    const missing = envelope()
    delete (missing as Partial<PersistedEnvelope>).folders
    expect(validateEnvelope(missing)).toBe(false)
  })

  it('rejects the wrong groupBy / orderBy enums', () => {
    expect(validateEnvelope({ ...envelope(), groupBy: 'tree' })).toBe(false)
    expect(validateEnvelope({ ...envelope(), orderBy: 'alphabetical' })).toBe(false)
  })

  it('accepts the git-repo grouping mode', () => {
    expect(validateEnvelope({ ...envelope(), groupBy: 'repo' })).toBe(true)
    expect(validateEnvelope({ ...envelope(), groupBy: 'flat' })).toBe(true)
  })

  it('rejects a missing or mislinked root', () => {
    const orphan = envelope()
    delete orphan.folders.root
    expect(validateEnvelope(orphan)).toBe(false)
    const parentedRoot = envelope()
    parentedRoot.folders.root = { ...ROOT_RECORD, parentFolderId: 'f1' }
    expect(validateEnvelope(parentedRoot)).toBe(false)
  })

  it('rejects records whose id does not match their key or whose name is blank', () => {
    const mismatched = envelope()
    mismatched.folders.f1 = { ...mismatched.folders.f1!, folderId: 'other' }
    expect(validateEnvelope(mismatched)).toBe(false)
    const blank = envelope()
    blank.folders.f1 = { ...blank.folders.f1!, name: '  ' }
    expect(validateEnvelope(blank)).toBe(false)
  })

  it('rejects a child that does not exist, that names the wrong parent, or that the parent does not list', () => {
    const ghost = envelope()
    ghost.folders.f1 = { ...ghost.folders.f1!, folderIds: ['ghost'] }
    expect(validateEnvelope(ghost)).toBe(false)
    const wrongParent = envelope()
    wrongParent.folders.f2 = { ...wrongParent.folders.f2!, parentFolderId: 'root' }
    expect(validateEnvelope(wrongParent)).toBe(false)
    // root does not list f1, but f1 claims root: both sides must agree.
    const unlisted = envelope()
    unlisted.folders.root = { ...unlisted.folders.root!, folderIds: [] }
    expect(validateEnvelope(unlisted)).toBe(false)
  })

  it('rejects a folder cycle', () => {
    const cycle = envelope()
    cycle.folders.root = { ...ROOT_RECORD, folderIds: ['f1'] }
    cycle.folders.f1 = { ...cycle.folders.f1!, parentFolderId: 'f2', folderIds: ['f2'] }
    cycle.folders.f2 = { ...cycle.folders.f2!, parentFolderId: 'f1', folderIds: ['f1'] }
    expect(validateEnvelope(cycle)).toBe(false)
  })

  it('rejects nesting beyond the depth cap (a bidirectionally sound chain lets the walk reject)', () => {
    // Chain helper: root + `count` folders, every parent listing its child.
    const chain = (count: number): PersistedEnvelope => {
      const next = envelope()
      // The fixture tree's f1/f2 do not exist in the chain: drop them so
      // the bidirectional account checks pass and the walk decides.
      delete next.folders.f1
      delete next.folders.f2
      next.folders.root = { ...ROOT_RECORD, folderIds: ['d1'] }
      for (let level = 1; level <= count; level++) {
        const id = `d${level}`
        next.folders[id] = {
          folderId: id,
          name: `lvl-${level}`,
          parentFolderId: level === 1 ? 'root' : `d${level - 1}`,
          workspaceIds: [],
          folderIds: level === count ? [] : [`d${level + 1}`],
          createdAt: '0',
          updatedAt: '0',
        }
      }
      return next
    }
    // Root + 5 folders = depth 6 (the cap, root included): accepted.
    expect(validateEnvelope(chain(MAX_FOLDER_DEPTH - 1))).toBe(true)
    // One folder deeper than the cap: the walk rejects it.
    expect(validateEnvelope(chain(MAX_FOLDER_DEPTH))).toBe(false)
  })

  it('rejects mistyped maps', () => {
    expect(validateEnvelope({ ...envelope(), folderExpansion: { f1: 'yes' } })).toBe(false)
    expect(validateEnvelope({ ...envelope(), recentTouchById: { w1: Number.NaN } })).toBe(false)
    expect(validateEnvelope({ ...envelope(), groupExpansion: { w1: 1 } })).toBe(false)
    expect(validateEnvelope({ ...envelope(), sessionOrderByAccount: { w1: 's1' } })).toBe(false)
    expect(validateEnvelope({ ...envelope(), sessionUpdatedAtByAccount: { w1: { s1: 'x' } } })).toBe(false)
  })
})

describe('envelopeByteSize', () => {
  it('measures the serialized envelope', () => {
    const bytes = envelopeByteSize(envelope())
    expect(bytes).toBeGreaterThan(100)
    expect(bytes).toBeLessThan(10_000)
  })

  it('reports Infinity for an unstringifiable value', () => {
    const circular = envelope() as unknown as PersistedEnvelope
    ;(circular as unknown as { loop?: unknown }).loop = circular
    expect(envelopeByteSize(circular)).toBe(Infinity)
  })
})

describe('envelope file round-trip', () => {
  it('reads null for a missing file', async () => {
    const dir = await tempDir()
    expect(await readEnvelopeFile(join(dir, 'absent.json'))).toBeNull()
  })

  it('rejects corrupt or invalid JSON without changing the file', async () => {
    const dir = await tempDir()
    const corrupt = join(dir, 'corrupt.json')
    await writeFile(corrupt, '{not json')
    await expect(readEnvelopeFile(corrupt)).rejects.toThrow()
    expect(await readFile(corrupt, 'utf8')).toBe('{not json')
    const invalid = join(dir, 'invalid.json')
    await writeFile(invalid, JSON.stringify({ folders: {}, groupBy: 'bogus' }))
    await expect(readEnvelopeFile(invalid)).rejects.toThrow('invalid persisted workspace envelope')
    expect(JSON.parse(await readFile(invalid, 'utf8'))).toEqual({ folders: {}, groupBy: 'bogus' })
  })

  it('writes atomically (parent dirs created, no temp leftovers) and round-trips', async () => {
    const dir = await tempDir()
    const file = join(dir, 'storages', 'dsh-enhanced-workspace.json')
    await writeEnvelopeFile(file, envelope())
    expect(await readEnvelopeFile(file)).toEqual(validEnvelope())
    const names = await readdir(join(dir, 'storages'))
    expect(names).toEqual(['dsh-enhanced-workspace.json'])
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(validEnvelope())
  })

  it('overwrites the previous envelope', async () => {
    const dir = await tempDir()
    const file = join(dir, 'e.json')
    await writeEnvelopeFile(file, envelope())
    const next = envelope()
    next.folders.f1 = { ...next.folders.f1!, name: '重命名' }
    await writeEnvelopeFile(file, next)
    expect((await readEnvelopeFile(file))?.folders.f1?.name).toBe('重命名')
  })
})
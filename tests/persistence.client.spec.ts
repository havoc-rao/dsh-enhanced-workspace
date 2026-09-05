// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { createPersistence } from '../src/client/persistence.ts'
import { createEnhancedWorkspaceStore } from '../src/client/store.ts'
import { PERSISTENCE_LOCAL_FALLBACK_KEY } from '../src/shared/persistence.ts'

const envelope = () => structuredClone(createEnhancedWorkspaceStore().create().getSnapshot())
const handle = (call: ReturnType<typeof vi.fn>) => ({ rpc: { call } }) as unknown as ConnectionHandle

beforeEach(() => { localStorage.clear() })

describe('authoritative persistence reads', () => {
  it.each([
    ['transport failure', () => Promise.reject(new Error('offline'))],
    ['RPC rejection', async () => ({ ok: false, error: { message: 'unavailable' } })],
    ['invalid payload', async () => ({ ok: true, value: {} })],
    ['missing payload', async () => ({ ok: true })],
  ])('rejects %s even when a valid older fallback exists', async (_name, response) => {
    localStorage.setItem(PERSISTENCE_LOCAL_FALLBACK_KEY, JSON.stringify(envelope()))
    const persistence = createPersistence(() => handle(vi.fn(response)))
    await expect(persistence.load()).rejects.toThrow()
  })

  it('resolves the connection for each operation, and rejects an absent service', async () => {
    let connection: ConnectionHandle | undefined
    const persistence = createPersistence(() => connection)
    await expect(persistence.load()).rejects.toThrow('Connection unavailable')
    const saved = envelope()
    connection = handle(vi.fn(async () => ({ ok: true, value: saved })))
    await expect(persistence.load()).resolves.toEqual(saved)
  })

  it('prefers the host envelope over a local fallback', async () => {
    const saved = envelope()
    localStorage.setItem(PERSISTENCE_LOCAL_FALLBACK_KEY, '{broken')
    const persistence = createPersistence(() => handle(vi.fn(async () => ({ ok: true, value: saved }))))
    await expect(persistence.load()).resolves.toEqual(saved)
  })

  it('returns null only for confirmed empty host and local storage', async () => {
    const persistence = createPersistence(() => handle(vi.fn(async () => ({ ok: true, value: null }))))
    await expect(persistence.load()).resolves.toBeNull()
    const saved = envelope()
    localStorage.setItem(PERSISTENCE_LOCAL_FALLBACK_KEY, JSON.stringify(saved))
    await expect(persistence.load()).resolves.toEqual(saved)
    localStorage.setItem(PERSISTENCE_LOCAL_FALLBACK_KEY, '{broken')
    await expect(persistence.load()).rejects.toThrow()
    localStorage.setItem(PERSISTENCE_LOCAL_FALLBACK_KEY, '{}')
    await expect(persistence.load()).rejects.toThrow('Invalid fallback')
  })
})

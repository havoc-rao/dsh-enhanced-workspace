/**
 * Approval-seat poller behavior (fake timers + fake connection): publishes
 * the host snapshot into the seat, syncs removals when asks decide, stops on
 * a missing endpoint, and clears published entries on stop. The pure
 * reconciliation itself is covered in approval-status.spec.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ApprovalSeatEntry } from '../src/client/approval-status.ts'
import {
  approvalSeatKey,
  createApprovalSeatPoller,
} from '../src/client/approval-status.ts'
import { APPROVAL_PENDING_ENDPOINT } from '../src/shared/approval-status.ts'
import { PERSISTENCE_CHANNEL } from '../src/shared/persistence.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const S = (id: string): SessionId => id as SessionId

interface FakeConnection {
  rpc: {
    call: ReturnType<typeof vi.fn>
  }
}

describe('approval seat poller', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const makeConnection = (asks: unknown): FakeConnection => ({
    rpc: {
      call: vi.fn(async () => ({ ok: true as const, value: asks })),
    },
  })

  it('publishes the open-ask snapshot on the first poll and keeps syncing', async () => {
    const connection = makeConnection({ asks: [{ sessionId: 's1', id: 'a1', toolName: 'bash', reason: 'escalate sandbox to workspace-write: t' }] })
    const published = new Map<string, ApprovalSeatEntry>()
    const removers = new Map<string, () => void>()
    const publish = vi.fn((entry: ApprovalSeatEntry) => {
      published.set(entry.key, entry)
      const remove = (): void => { published.delete(entry.key) }
      removers.set(entry.key, remove)
      return remove
    })
    const poller = createApprovalSeatPoller({
      getConnection: () => connection as unknown as ConnectionHandle,
      publish,
      intervalMs: 1000,
      warn: vi.fn(),
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(publish).toHaveBeenCalledTimes(1)
    const entry = published.get(approvalSeatKey(S('s1')))
    expect(entry).toMatchObject({
      key: approvalSeatKey(S('s1')),
      kind: 'approval',
      sessionId: 's1',
      toolName: 'bash',
      reason: 'escalate sandbox to workspace-write: t',
    })
    expect(connection.rpc.call).toHaveBeenCalledWith(PERSISTENCE_CHANNEL, APPROVAL_PENDING_ENDPOINT, {})

    // A settled ask disappears on the next poll.
    connection.rpc.call.mockResolvedValueOnce({ ok: true, value: { asks: [] } })
    await vi.advanceTimersByTimeAsync(1000)
    expect(published.has(approvalSeatKey(S('s1')))).toBe(false)
    poller.stop()
  })

  it('publishes nothing for an unchanged snapshot', async () => {
    const connection = makeConnection({ asks: [{ sessionId: 's1', id: 'a1', toolName: 'bash' }] })
    const publish = vi.fn(() => () => {})
    const poller = createApprovalSeatPoller({
      getConnection: () => connection as unknown as ConnectionHandle,
      publish,
      intervalMs: 1000,
      warn: vi.fn(),
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(publish).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(publish).toHaveBeenCalledTimes(1)
    poller.stop()
  })

  it('stops polling when the host rejects the endpoint (older install) and logs once', async () => {
    const connection: FakeConnection = {
      rpc: {
        call: vi.fn(async () => ({
          ok: false as const,
          error: { code: 'internal', message: 'unknown endpoint', details: {} },
        })),
      },
    }
    const warn = vi.fn()
    const poller = createApprovalSeatPoller({
      getConnection: () => connection as unknown as ConnectionHandle,
      publish: vi.fn(() => () => {}),
      intervalMs: 1000,
      warn,
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(connection.rpc.call).toHaveBeenCalledTimes(1)
    // No further polls after the endpoint was found missing.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(connection.rpc.call).toHaveBeenCalledTimes(1)
  })

  it('retries a transient transport failure on the next tick', async () => {
    const connection: FakeConnection = {
      rpc: {
        call: vi.fn()
          .mockRejectedValueOnce(new Error('connection reset'))
          .mockResolvedValueOnce({ ok: true, value: { asks: [] } }),
      },
    }
    const warn = vi.fn()
    const poller = createApprovalSeatPoller({
      getConnection: () => connection as unknown as ConnectionHandle,
      publish: vi.fn(() => () => {}),
      intervalMs: 1000,
      warn,
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(connection.rpc.call).toHaveBeenCalledTimes(2)
    poller.stop()
  })

  it('clears every published entry on stop', async () => {
    const connection = makeConnection({ asks: [{ sessionId: 's1', id: 'a1', toolName: 'bash' }] })
    const removers: (() => void)[] = []
    const publish = vi.fn(() => {
      const remove = vi.fn()
      removers.push(remove)
      return remove
    })
    const poller = createApprovalSeatPoller({
      getConnection: () => connection as unknown as ConnectionHandle,
      publish,
      intervalMs: 1000,
      warn: vi.fn(),
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(removers).toHaveLength(1)
    poller.stop()
    expect(removers[0]).toHaveBeenCalledTimes(1)
    // Stopped pollers never fire again.
    await vi.advanceTimersByTimeAsync(5000)
    expect(connection.rpc.call).toHaveBeenCalledTimes(1)
  })

  it('never publishes after stop even when a poll is in flight', async () => {
    let resolveCall!: (value: unknown) => void
    const connection: FakeConnection = {
      rpc: {
        call: vi.fn(() => new Promise(resolve => { resolveCall = resolve })),
      },
    }
    const publish = vi.fn(() => () => {})
    const poller = createApprovalSeatPoller({
      getConnection: () => connection as unknown as ConnectionHandle,
      publish,
      intervalMs: 1000,
      warn: vi.fn(),
    })
    poller.start()
    poller.stop()
    // The in-flight response lands AFTER teardown: it must be dropped.
    resolveCall({ ok: true, value: { asks: [{ sessionId: 's1', id: 'a1', toolName: 'bash' }] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(publish).not.toHaveBeenCalled()
  })

  it('ignores a malformed snapshot payload without publishing', async () => {
    const connection = makeConnection({ asks: [{ sessionId: 's1' }] } as unknown)
    const publish = vi.fn(() => () => {})
    const warn = vi.fn()
    const poller = createApprovalSeatPoller({
      getConnection: () => connection as unknown as ConnectionHandle,
      publish,
      intervalMs: 1000,
      warn,
    })
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(publish).not.toHaveBeenCalled()
    poller.stop()
  })
})
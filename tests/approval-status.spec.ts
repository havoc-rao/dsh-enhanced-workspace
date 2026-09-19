/**
 * Approval-status data plane: the shared open-ask fold (host tracker core),
 * the wire validation the client applies to the snapshot, and the client
 * seat reconciliation that keeps the fallback pending-interaction entry in
 * sync. Pure functions only — the poller's timer behavior is covered by the
 * fake-timer spec in approval-seat.client.spec.ts.
 */

import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  APPROVAL_PENDING_ENDPOINT,
  createApprovalAskTable,
  foldApprovalAuditEvent,
  isApprovalAskWireRecord,
  isApprovalPendingPayload,
  latestOpenApprovalAsk,
  snapshotOpenApprovalAsks,
  type ApprovalAskTable,
  type ApprovalAskWireRecord,
} from '../src/shared/approval-status.ts'
import {
  approvalSeatEntryFor,
  approvalSeatKey,
  reconcileApprovalSeats,
  type ApprovalSeatEntry,
} from '../src/client/approval-status.ts'
import { ApprovalStatusSource } from '../src/host/approval-status.ts'

type AuditEvent = { type: string; data: unknown }

const asked = (id: string, toolName = 'bash', extra: Record<string, unknown> = {}): AuditEvent =>
  ({ type: 'approval/asked', data: { id, toolName, ...extra } })
const decided = (id: string, outcome = 'allowed-once'): AuditEvent =>
  ({ type: 'approval/decided', data: { id, outcome } })

const S = (id: string): SessionId => id as SessionId

describe('shared approval-status fold', () => {
  it('records an open ask with its full material and serves it as the session snapshot', () => {
    const table = createApprovalAskTable()
    expect(snapshotOpenApprovalAsks(table)).toEqual([])
    foldApprovalAuditEvent(table, 's1', asked('ask-1', 'bash', { callId: 'call-9', reason: 'escalate sandbox to workspace-write: test' }))
    const latest = latestOpenApprovalAsk(table, 's1')
    expect(latest).toEqual({
      sessionId: 's1',
      id: 'ask-1',
      toolName: 'bash',
      callId: 'call-9',
      reason: 'escalate sandbox to workspace-write: test',
    })
    expect(snapshotOpenApprovalAsks(table)).toEqual([latest])
    expect(latestOpenApprovalAsk(table, 's2')).toBeUndefined()
  })

  it('closes an ask on its matching decided event and forgets the session once nothing is open', () => {
    const table = createApprovalAskTable()
    foldApprovalAuditEvent(table, 's1', asked('ask-1'))
    foldApprovalAuditEvent(table, 's1', decided('ask-1'))
    expect(snapshotOpenApprovalAsks(table)).toEqual([])
    expect(latestOpenApprovalAsk(table, 's1')).toBeUndefined()
  })

  it('keeps the newest ask visible while an older one is still open, then falls back when the newest decides', () => {
    const table = createApprovalAskTable()
    foldApprovalAuditEvent(table, 's1', asked('ask-old', 'read'))
    foldApprovalAuditEvent(table, 's1', asked('ask-new', 'bash'))
    expect(latestOpenApprovalAsk(table, 's1')?.id).toBe('ask-new')
    // The newest settles; the still-open older ask becomes visible again.
    foldApprovalAuditEvent(table, 's1', decided('ask-new'))
    expect(latestOpenApprovalAsk(table, 's1')?.id).toBe('ask-old')
    // The older ask settles too; nothing remains open.
    foldApprovalAuditEvent(table, 's1', decided('ask-old'))
    expect(latestOpenApprovalAsk(table, 's1')).toBeUndefined()
  })

  it('ignores malformed and unrelated events without throwing', () => {
    const table = createApprovalAskTable()
    foldApprovalAuditEvent(table, 's1', { type: 'tool/call', data: {} })
    foldApprovalAuditEvent(table, 's1', asked('')) // blank id
    foldApprovalAuditEvent(table, 's1', asked('ok'))
    // A decided for an unknown id leaves the open ask untouched.
    foldApprovalAuditEvent(table, 's1', decided('nope'))
    expect(latestOpenApprovalAsk(table, 's1')?.id).toBe('ok')
    foldApprovalAuditEvent(table, 's1', { type: 'approval/decided', data: null })
    expect(latestOpenApprovalAsk(table, 's1')?.id).toBe('ok')
    expect(snapshotOpenApprovalAsks(table)).toHaveLength(1)
  })

  it('keeps sessions independent and drops stale asks on forget', () => {
    const table = createApprovalAskTable()
    foldApprovalAuditEvent(table, 's1', asked('a1'))
    foldApprovalAuditEvent(table, 's2', asked('a2'))
    expect(snapshotOpenApprovalAsks(table)).toHaveLength(2)
    foldApprovalAuditEvent(table, 's2', decided('a2'))
    expect(snapshotOpenApprovalAsks(table)).toHaveLength(1)
    const source = new ApprovalStatusSource()
    source.observe('s1', asked('a1'))
    source.observe('s1', asked('a2'))
    source.forget('s1')
    expect(source.snapshot()).toEqual([])
  })

  it('the host source folds through the shared reducer (asked → decided lifecycle)', () => {
    const source = new ApprovalStatusSource()
    source.observe('s1', asked('h1', 'bash', { reason: 'escalate sandbox to danger-full-access: fixture' }))
    expect(source.snapshot()).toHaveLength(1)
    source.observe('s1', { type: 'tool/result', data: {} })
    source.observe('s1', decided('h1'))
    expect(source.snapshot()).toEqual([])
  })
})

describe('approval-status wire validation', () => {
  it('accepts only structurally sound ask records', () => {
    const good: ApprovalAskWireRecord = { sessionId: 's1', id: 'a', toolName: 'bash' }
    expect(isApprovalAskWireRecord(good)).toBe(true)
    expect(isApprovalAskWireRecord({ ...good, callId: 'c1', reason: 'r' })).toBe(true)
    expect(isApprovalAskWireRecord(null)).toBe(false)
    expect(isApprovalAskWireRecord([])).toBe(false)
    expect(isApprovalAskWireRecord({ ...good, sessionId: 7 })).toBe(false)
    expect(isApprovalAskWireRecord({ ...good, id: '' })).toBe(false)
    expect(isApprovalAskWireRecord({ ...good, toolName: '' })).toBe(false)
    expect(isApprovalAskWireRecord({ ...good, callId: 7 })).toBe(false)
    expect(isApprovalAskWireRecord({ ...good, reason: 7 })).toBe(false)
    expect(isApprovalAskWireRecord({ ...good, surprise: true })).toBe(true) // tolerated extras
  })

  it('accepts only payloads whose asks is an array of valid records', () => {
    expect(isApprovalPendingPayload({ asks: [] })).toBe(true)
    expect(isApprovalPendingPayload({ asks: [{ sessionId: 's1', id: 'a', toolName: 'bash' }] })).toBe(true)
    expect(isApprovalPendingPayload({ asks: 'nope' })).toBe(false)
    expect(isApprovalPendingPayload({ asks: [null] })).toBe(false)
    expect(isApprovalPendingPayload({})).toBe(false)
    expect(isApprovalPendingPayload(null)).toBe(false)
  })

  it('exports the channel endpoint spelling', () => {
    expect(APPROVAL_PENDING_ENDPOINT).toBe('approval/pending')
  })
})

describe('approval seat reconciliation', () => {
  const entry = (sessionId: string, reason?: string): ApprovalSeatEntry =>
    approvalSeatEntryFor({ sessionId, id: `ask:${sessionId}`, toolName: 'bash', ...(reason === undefined ? {} : { reason }) })

  it('publishes new open asks and removes entries whose ask closed', () => {
    const published = new Map<string, ApprovalSeatEntry>([
      [approvalSeatKey(S('s1')), entry('s1')],
    ])
    const asks: readonly ApprovalAskWireRecord[] = [
      { sessionId: 's1', id: 'ask:s1', toolName: 'bash' },
      { sessionId: 's2', id: 'ask:s2', toolName: 'bash' },
    ]
    const reconciliation = reconcileApprovalSeats(published, asks)
    expect(reconciliation.toRemove).toEqual([])
    expect(reconciliation.toPublish).toEqual([entry('s2')])
  })

  it('is a no-op while the snapshot is unchanged', () => {
    const published = new Map<string, ApprovalSeatEntry>([
      [approvalSeatKey(S('s1')), entry('s1')],
    ])
    const reconciliation = reconcileApprovalSeats(published, [
      { sessionId: 's1', id: 'ask:s1', toolName: 'bash' },
    ])
    expect(reconciliation.toRemove).toEqual([])
    expect(reconciliation.toPublish).toEqual([])
  })

  it('removes the published entry when the ask decided', () => {
    const published = new Map<string, ApprovalSeatEntry>([
      [approvalSeatKey(S('s1')), entry('s1')],
    ])
    const reconciliation = reconcileApprovalSeats(published, [])
    expect(reconciliation.toRemove).toEqual([approvalSeatKey(S('s1'))])
    expect(reconciliation.toPublish).toEqual([])
  })

  it('replaces an entry whose material changed (reason/tool arrival or update)', () => {
    const published = new Map<string, ApprovalSeatEntry>([
      [approvalSeatKey(S('s1')), entry('s1')],
    ])
    const asks: readonly ApprovalAskWireRecord[] = [
      { sessionId: 's1', id: 'ask:s1', toolName: 'bash', reason: 'escalate sandbox to workspace-write: now' },
    ]
    const reconciliation = reconcileApprovalSeats(published, asks)
    expect(reconciliation.toRemove).toEqual([approvalSeatKey(S('s1'))])
    expect(reconciliation.toPublish).toEqual([entry('s1', 'escalate sandbox to workspace-write: now')])
  })

  it('keeps the seat key stable per session across snapshot churn', () => {
    expect(approvalSeatKey(S('s1'))).toBe('enhanced-workspace:approval:s1')
    expect(entry('s1').key).toBe(approvalSeatKey(S('s1')))
    expect(entry('s1').kind).toBe('approval')
  })
})

describe('approval seat entry shape consumed by the browser model', () => {
  it('publishes the fields the escalation split reads (reason rides along)', () => {
    const entry = approvalSeatEntryFor({
      sessionId: 's1', id: 'a', toolName: 'bash', callId: 'c1', reason: 'escalate sandbox to workspace-write: fixture',
    })
    expect(entry).toMatchObject({ kind: 'approval', sessionId: 's1', toolName: 'bash', callId: 'c1', reason: 'escalate sandbox to workspace-write: fixture' })
    expect(entry).toEqual(approvalSeatEntryFor({ sessionId: 's1', id: 'a', toolName: 'bash', callId: 'c1', reason: 'escalate sandbox to workspace-write: fixture' }))
    // The seat key is per-session and stable across ask ids: a replacing
    // snapshot for the same session keeps the same key (remove-then-publish).
    expect(approvalSeatEntryFor({ sessionId: 's1', id: 'b', toolName: 'bash', callId: 'c1', reason: 'escalate sandbox to workspace-write: fixture' }).key)
      .toBe(entry.key)
    expect(approvalSeatEntryFor({ sessionId: 's2', id: 'a', toolName: 'bash' }).key).not.toBe(entry.key)
  })
})
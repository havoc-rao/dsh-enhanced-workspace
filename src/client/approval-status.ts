/**
 * Client-side approval-status seat: reconciles the host's open-approval
 * ledger into the ui-session pending-interaction map — the fallback path
 * that guarantees the sidebar's amber waiting dot ("hook 状态 / 黄点事件")
 * appears on EVERY approval, even when the `approval/request` remote-event
 * delivery that drives ui-approval's own entry hiccups.
 *
 * Semantics:
 * - Precedence is LOWER than ui-approval's seat (`-1` vs `0`), so the
 *   interactive `PendingApproval` (which also powers the composer approval
 *   panel) always wins while it exists; this seat only becomes the session's
 *   visible entry when ui-approval's is absent — exactly the lost-event
 *   cases. Both entries are `kind: 'approval'`, so the row's dot and hover
 *   labels (including the escalation reason splitting) read the same either
 *   way.
 * - The host audit pair (`approval/asked` → `approval/decided`) is
 *   turn-enclosed and appended on every ask no matter what the answerer
 *   chain did, so the polled snapshot is loss-free where the remote event is
 *   not; a transient connection gap self-heals on the next poll.
 * - The poller publishes nothing when the host half lacks the endpoint (an
 *   older installed version) — it stops and logs once, leaving today's
 *   behavior unchanged.
 * @module dsh-enhanced-workspace/client/approval-status
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PendingInteractionPublisher } from '@deepseek-ai/dsh-client-ui-session/client'
import { PERSISTENCE_CHANNEL } from '../shared/persistence.ts'
import {
  APPROVAL_PENDING_ENDPOINT,
  isApprovalPendingPayload,
  type ApprovalAskWireRecord,
} from '../shared/approval-status.ts'

/** How often the client polls the host's open-approval snapshot. */
export const APPROVAL_POLL_INTERVAL_MS = 1000

/**
 * Precedence of this plugin's pending-approval seat. Below ui-approval's
 * seat (0): the interactive entry — a `PendingApproval` instance that also
 * drives the composer's approval panel — must never be shadowed by a
 * fallback lookup; the fallback only fills seats ui-approval left empty.
 */
export const APPROVAL_SEAT_PRECEDENCE = -1

/** The pending-interaction value this seat publishes (kind 'approval'). */
export interface ApprovalSeatEntry {
  readonly key: string
  readonly kind: 'approval'
  readonly sessionId: SessionId
  /** Tool whose operation requires the decision (from the audit event). */
  readonly toolName?: string
  /** Exact tool call correlated with the ask, when the asker supplied one. */
  readonly callId?: string
  /** The asker's human-readable explanation (drives the escalation split). */
  readonly reason?: string
}

/**
 * Stable pending-interaction key of one session's fallback approval entry.
 * @param sessionId - session owning the (single) visible ask.
 * @returns the seat key (one per session — the seat shows at most one ask).
 */
export function approvalSeatKey(sessionId: SessionId): string {
  return `enhanced-workspace:approval:${sessionId}`
}

/**
 * Build the pending-interaction entry for one open ask.
 * @param ask - open-approval wire record from the host snapshot.
 * @returns the entry published to the pending-interaction seat.
 */
export function approvalSeatEntryFor(ask: ApprovalAskWireRecord): ApprovalSeatEntry {
  const sessionId = ask.sessionId as SessionId
  return {
    key: approvalSeatKey(sessionId),
    kind: 'approval',
    sessionId,
    ...(ask.toolName === undefined ? {} : { toolName: ask.toolName }),
    ...(ask.callId === undefined ? {} : { callId: ask.callId }),
    ...(ask.reason === undefined ? {} : { reason: ask.reason }),
  }
}

/** One reconciliation pass against the currently published entries. */
export interface ApprovalSeatReconciliation {
  /** Entries to publish now (already removed when replacing a key). */
  readonly toPublish: readonly ApprovalSeatEntry[]
  /** Keys whose published entry must be removed first. */
  readonly toRemove: readonly string[]
}

/**
 * Diff the fresh open-ask snapshot against the currently published fallback
 * entries: publish new/changed entries, remove entries whose ask closed.
 * Pure — the caller applies removes before publishes.
 * @param published - currently published entries by seat key.
 * @param asks - fresh open-ask snapshot (one per session).
 * @returns the reconciliation to apply.
 */
export function reconcileApprovalSeats(
  published: ReadonlyMap<string, ApprovalSeatEntry>,
  asks: readonly ApprovalAskWireRecord[],
): ApprovalSeatReconciliation {
  const toPublish: ApprovalSeatEntry[] = []
  const toRemove: string[] = []
  for (const key of published.keys()) {
    if (asks.some(ask => approvalSeatKey(ask.sessionId as SessionId) === key)) continue
    toRemove.push(key)
  }
  for (const ask of asks) {
    const next = approvalSeatEntryFor(ask)
    const current = published.get(next.key)
    if (current !== undefined && sameSeatEntry(current, next)) continue
    if (current !== undefined && !toRemove.includes(next.key)) toRemove.push(next.key)
    toPublish.push(next)
  }
  return { toPublish, toRemove }
}

/** Whether two seat entries carry identical material (key + presentation fields). */
function sameSeatEntry(left: ApprovalSeatEntry, right: ApprovalSeatEntry): boolean {
  return left.key === right.key
    && left.sessionId === right.sessionId
    && left.toolName === right.toolName
    && left.callId === right.callId
    && left.reason === right.reason
}

/**
 * Create the poller that keeps the fallback seat in sync with the host's
 * open-approval ledger. Polls immediately on start, then every
 * {@link APPROVAL_POLL_INTERVAL_MS}. A missing connection retries silently;
 * a host that rejects the endpoint (older install) stops permanently and
 * logs once.
 * @param opts - connection getter, the seat's publication function
 *   (`uiSession.registerPendingInteraction`), and optional poll cadence.
 * @returns start/stop handles.
 */
export function createApprovalSeatPoller(opts: {
  readonly getConnection: () => ConnectionHandle | undefined
  readonly publish: PendingInteractionPublisher<ApprovalSeatEntry>
  readonly intervalMs?: number
  readonly warn?: (message: string) => void
}): { start: () => void; stop: () => void } {
  const intervalMs = opts.intervalMs ?? APPROVAL_POLL_INTERVAL_MS
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  const published = new Map<string, ApprovalSeatEntry>()
  const removers = new Map<string, () => void>()
  let running = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let warned = false

  const removePublished = (key: string): void => {
    removers.get(key)?.()
    removers.delete(key)
    published.delete(key)
  }

  const applyReconciliation = (reconciliation: ApprovalSeatReconciliation): void => {
    for (const key of reconciliation.toRemove) removePublished(key)
    for (const entry of reconciliation.toPublish) {
      const remove = opts.publish(entry, async () => undefined)
      removers.set(entry.key, remove)
      published.set(entry.key, entry)
    }
  }

  const stopPolling = (): void => {
    if (!running) return
    running = false
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    for (const key of [...published.keys()]) removePublished(key)
  }

  const poll = async (): Promise<void> => {
    if (!running) return
    const connection = opts.getConnection()
    if (connection === undefined) return
    let result: Awaited<ReturnType<typeof connection.rpc.call>>
    try {
      result = await connection.rpc.call(PERSISTENCE_CHANNEL, APPROVAL_PENDING_ENDPOINT, {})
    } catch (error) {
      // Transient transport failure: retry next tick (the ledger self-heals).
      if (!warned) {
        warned = true
        warn(`dsh-enhanced-workspace: approval-status poll failed (retrying): ${String(error)}`)
      }
      return
    }
    // Stopped while the request was in flight: never publish after teardown.
    if (!running) return
    if (!result.ok) {
      // A host without the endpoint (older install) can never answer: stop
      // polling and keep today's behavior (ui-approval's seat only).
      stopPolling()
      if (!warned) {
        warned = true
        warn(`dsh-enhanced-workspace: approval-status endpoint unavailable (${result.error.message}); fallback seat disabled`)
      }
      return
    }
    warned = false
    const payload = result.value
    if (!isApprovalPendingPayload(payload)) {
      if (!warned) {
        warned = true
        warn('dsh-enhanced-workspace: approval-status snapshot failed validation; ignored')
      }
      return
    }
    try {
      applyReconciliation(reconcileApprovalSeats(published, payload.asks))
    } catch (error) {
      // A throwing publish must not kill the loop; retry next tick.
      if (!warned) {
        warned = true
        warn(`dsh-enhanced-workspace: approval-status seat publish failed: ${String(error)}`)
      }
    }
  }

  const tick = (): void => {
    if (!running) return
    timer = setTimeout(() => {
      void poll().finally(() => { tick() })
    }, intervalMs)
  }

  return {
    start: () => {
      if (running) return
      running = true
      void poll().then(() => { if (running) tick() })
    },
    stop: stopPolling,
  }
}
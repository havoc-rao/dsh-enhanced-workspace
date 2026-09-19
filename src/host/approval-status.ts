/**
 * Host-side source of the plugin's approval-status mirror: folds the live
 * `session/event` firehose into the open-ask table shared with the client.
 *
 * Why this exists: the sidebar's amber waiting dot ("hook 状态 / 黄点事件")
 * historically depended on one volatile delivery path — the client answering
 * the forwarded `approval/request` remote-event waterfall. When that leg
 * hiccups (agent-context resolution miss, stream generation gap, listener
 * not mounted yet), the approval is never surfaced: the tool call keeps its
 * running (blue) presentation and the dot never turns amber. The durable
 * `approval/asked` / `approval/decided` audit pair, however, is appended by
 * `ApprovalService.request` on EVERY ask, turn-enclosed and before/after the
 * answerer chain — a hook's `ask` decision included — so folding it gives the
 * UI a loss-free second path that is never blocked by the remote-event leg.
 *
 * Live appends only: constructor seeds (restore/fork replay) do not emit
 * `session/event`, and a restored session cannot carry a live open ask (its
 * waterfall died with the previous process), so the table is exactly the set
 * of currently-pending approvals.
 * @module dsh-enhanced-workspace/host/approval-status
 */

import {
  createApprovalAskTable,
  foldApprovalAuditEvent,
  snapshotOpenApprovalAsks,
  type ApprovalAskTable,
  type ApprovalAskWireRecord,
} from '../shared/approval-status.ts'

/** One session audit event as the tracker consumes it. */
export interface SessionAuditEvent {
  readonly type: string
  readonly data: unknown
}

/**
 * The live open-approval ledger of the host process. Insertion-time events
 * fold through the shared pure reducer; disposal drops a session outright.
 */
export class ApprovalStatusSource {
  private readonly table: ApprovalAskTable = createApprovalAskTable()

  /**
   * Fold one `session/event` firehose event into the ledger.
   * @param sessionId - session that owns the event.
   * @param event - the appended session event (only `approval/*` rows matter).
   */
  observe(sessionId: string, event: SessionAuditEvent): void {
    foldApprovalAuditEvent(this.table, sessionId, event)
  }

  /**
   * Drop every ask of one session (it was disposed; stale asks must never
   * re-light the dot after the session row is gone).
   * @param sessionId - session being forgotten.
   */
  forget(sessionId: string): void {
    this.table.delete(sessionId)
  }

  /**
   * The current open-ask snapshot (newest ask per session), served verbatim
   * to the client over the plugin RPC channel.
   * @returns every currently open ask.
   */
  snapshot(): readonly ApprovalAskWireRecord[] {
    return snapshotOpenApprovalAsks(this.table)
  }
}
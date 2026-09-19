/**
 * Pure approval-status data plane shared by the plugin's two halves.
 *
 * The durable, replayable record of "this tool entered approval" is the
 * session audit pair `approval/asked` → `approval/decided` (`dsh-user-approval`
 * appends both, turn-enclosed, whatever the answerer chain does). The Host
 * half folds the live `session/event` firehose through {@link foldApprovalAuditEvent}
 * into an open-ask table and serves it over the plugin RPC channel; the
 * client half reconciles it into the ui-session pending-interaction seat so
 * the sidebar's amber waiting dot ("hook 状态 / 黄点事件") never depends on
 * the volatile `approval/request` remote-event delivery alone.
 *
 * Everything here is side-effect free and JSON-safe, so both bundles and the
 * node test suite share one spelling.
 * @module dsh-enhanced-workspace/shared/approval-status
 */

/** Channel-relative RPC endpoint returning the open-approval snapshot. */
export const APPROVAL_PENDING_ENDPOINT = 'approval/pending'

/** One open approval ask as it crosses the plugin's RPC channel. */
export interface ApprovalAskWireRecord {
  /** Session whose agent owns the ask. */
  readonly sessionId: string
  /** The `approval/asked` event's request id (pairs with `approval/decided`). */
  readonly id: string
  /** Tool whose operation requires the decision. */
  readonly toolName: string
  /** Exact tool call correlated with the ask, when the asker supplied one. */
  readonly callId?: string
  /** The asker's human-readable explanation (e.g. a hook's permission reason). */
  readonly reason?: string
}

/**
 * Whether `value` is one structurally sound {@link ApprovalAskWireRecord}.
 * Strict by design: the client consumes untrusted wire data and must never
 * publish a malformed pending-interaction entry.
 * @param value - candidate record.
 * @returns whether every present field has the expected type.
 */
export function isApprovalAskWireRecord(value: unknown): value is ApprovalAskWireRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return false
  if (typeof record.id !== 'string' || record.id === '') return false
  if (typeof record.toolName !== 'string' || record.toolName === '') return false
  if (record.callId !== undefined && typeof record.callId !== 'string') return false
  if (record.reason !== undefined && typeof record.reason !== 'string') return false
  return true
}

/** The full endpoint payload: every currently open ask, one per session. */
export interface ApprovalPendingPayload {
  readonly asks: readonly ApprovalAskWireRecord[]
}

/**
 * Whether `value` is one structurally sound {@link ApprovalPendingPayload}.
 * @param value - candidate payload.
 * @returns whether the payload is a record whose `asks` is an array of valid
 *   wire records (empty arrays and absent sessions stay valid).
 */
export function isApprovalPendingPayload(value: unknown): value is ApprovalPendingPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const payload = value as Record<string, unknown>
  return Array.isArray(payload.asks) && payload.asks.every(isApprovalAskWireRecord)
}

/**
 * Open approval asks by session: `sessionId → (askId → record)`. Ask ids are
 * service-issued UUIDs, so ordinary strings carry the map keys; the insertion
 * order of the per-session inner map is the ask order.
 */
export type ApprovalAskTable = Map<string, Map<string, ApprovalAskWireRecord>>

/** A new, empty {@link ApprovalAskTable}. */
export function createApprovalAskTable(): ApprovalAskTable {
  return new Map()
}

/** Fields of the `approval/asked` audit event the fold reads. */
interface AskedData {
  readonly id?: unknown
  readonly toolName?: unknown
  readonly callId?: unknown
  readonly reason?: unknown
}

/** Fields of the `approval/decided` audit event the fold reads. */
interface DecidedData {
  readonly id?: unknown
}

/**
 * Fold one durable session audit event into the open-ask table.
 *
 * - `approval/asked` → record the ask (its id becomes the newest open ask of
 *   the session; one ask per tool call may be open in parallel, and the
 *   pending-interaction seat only ever shows one per session — the newest).
 * - `approval/decided` → close the ask with that id; when the newest open ask
 *   closes, the previous one (if any) becomes visible again.
 *
 * Malformed or irrelevant events are ignored (never throw): the fold only
 * ever narrows the table, and a bad audit event must not take down the
 * tracker feeding the UI.
 * @param table - the open-ask table being maintained.
 * @param sessionId - session that owns the event.
 * @param event - the raw session event (shape-checked here).
 */
export function foldApprovalAuditEvent(
  table: ApprovalAskTable,
  sessionId: string,
  event: { readonly type: string; readonly data: unknown },
): void {
  if (event.type === 'approval/asked') {
    const data = typeof event.data === 'object' && event.data !== null
      ? event.data as AskedData
      : {}
    if (typeof data.id !== 'string' || data.id === '' || typeof data.toolName !== 'string') return
    let byId = table.get(sessionId)
    if (byId === undefined) {
      byId = new Map()
      table.set(sessionId, byId)
    }
    byId.set(data.id, {
      sessionId,
      id: data.id,
      toolName: data.toolName,
      ...(typeof data.callId === 'string' && data.callId !== ''
        ? { callId: data.callId }
        : {}),
      ...(typeof data.reason === 'string' && data.reason !== ''
        ? { reason: data.reason }
        : {}),
    })
    return
  }
  if (event.type === 'approval/decided') {
    const data = typeof event.data === 'object' && event.data !== null
      ? event.data as DecidedData
      : {}
    if (typeof data.id !== 'string') return
    const byId = table.get(sessionId)
    if (byId === undefined) return
    byId.delete(data.id)
    if (byId.size === 0) table.delete(sessionId)
    return
  }
}

/**
 * The visible open ask of one session: the NEWEST recorded ask that has not
 * been closed by its `approval/decided`. `undefined` when the session has no
 * open ask.
 * @param table - the open-ask table.
 * @param sessionId - session to read.
 * @returns the newest open ask, or `undefined`.
 */
export function latestOpenApprovalAsk(
  table: ApprovalAskTable,
  sessionId: string,
): ApprovalAskWireRecord | undefined {
  const byId = table.get(sessionId)
  if (byId === undefined || byId.size === 0) return undefined
  return [...byId.values()][byId.size - 1]
}

/**
 * The full open-ask snapshot served to the client: at most one ask per
 * session (the newest), in session insertion order — the exact shape the
 * pending-interaction seat reconciles against.
 * @param table - the open-ask table.
 * @returns every currently open ask, newest per session.
 */
export function snapshotOpenApprovalAsks(table: ApprovalAskTable): readonly ApprovalAskWireRecord[] {
  const snapshot: ApprovalAskWireRecord[] = []
  for (const byId of table.values()) {
    if (byId.size === 0) continue
    snapshot.push([...byId.values()][byId.size - 1])
  }
  return snapshot
}
/**
 * Drag reference protocol of the enhanced browser: the payload row drags
 * write to `application/x-dsh-reference+json`, and the canonical DSH
 * session-reference mention carried as `text/plain` — the drop payload any
 * text surface (the conversation composer first of all) inserts verbatim.
 *
 * The mention format mirrors the host's `@deepseek-ai/dsh-session-reference`
 * wire layer (`uri.ts`: `@[label](dsh-session:<base64url-of-JSON-id>)`)
 * — reimplemented inline because the client bundle purity gate forbids
 * value-importing that host package. The byte-for-byte mirror matters: the
 * host re-encodes the URI it parsed and rejects non-canonical spellings, so
 * the encoding below must match Node's `Buffer.toString('base64url')`
 * exactly (standard base64 alphabet, URL-safe `-_`, no padding).
 *
 * The consumer side of the pipeline is DSH itself: a user message containing
 * the mention is parsed by `parseSessionReferenceText` at pre-step and each
 * cited session's snapshot is attached as read-only context — so a dropped
 * workspace drag is a REAL cross-session reference, not raw text.
 * @module dsh-enhanced-workspace/client/reference
 */

/** Custom MIME carrying the structured drag payload (row-internal moves and
 *  future picker consumers read it; unknown consumers ignore it). */
export const WORKSPACE_REFERENCE_MIME = 'application/x-dsh-reference+json'

/** Current payload schema version (bump on any field change). */
export const REFERENCE_PROTOCOL_VERSION = 1 as const

/** What kind of row is being dragged. */
export type DragReferenceKind = 'workspace' | 'session' | 'folder'

/** One drag payload written to {@link WORKSPACE_REFERENCE_MIME}. */
export interface DragReferencePayload {
  readonly version: typeof REFERENCE_PROTOCOL_VERSION
  readonly kind: DragReferenceKind
  /** Workspace id (kind `workspace`), session id (kind `session`), folder id (kind `folder`). */
  readonly id: string
  /** Canonical session-reference mention — the `text/plain` drop payload. */
  readonly mention: string
  /** Display label for affordances (workspace title / session title). */
  readonly label: string
  /** Referenced session for kind `workspace`; absent when the workspace has
   *  no referenceable (non-blank, non-subagent) session. */
  readonly sessionId?: string
}

/** Serialize a drag payload for {@link WORKSPACE_REFERENCE_MIME}. */
export function encodeDragReference(payload: DragReferencePayload): string {
  return JSON.stringify(payload)
}

/**
 * Parse a drag payload, returning null for anything that is not a valid
 * current-version payload (foreign payloads are ignored, never thrown on).
 * @param json - the MIME's value, or nothing.
 * @returns the parsed payload, or null.
 */
export function parseDragReference(json: string | null | undefined): DragReferencePayload | null {
  if (json === null || json === undefined || json === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as RecursivePartial<DragReferencePayload>
  if (candidate.version !== REFERENCE_PROTOCOL_VERSION) return null
  if (candidate.kind !== 'workspace' && candidate.kind !== 'session' && candidate.kind !== 'folder') return null
  if (typeof candidate.id !== 'string' || typeof candidate.mention !== 'string' || typeof candidate.label !== 'string') return null
  if (candidate.sessionId !== undefined && typeof candidate.sessionId !== 'string') return null
  return {
    version: REFERENCE_PROTOCOL_VERSION,
    kind: candidate.kind,
    id: candidate.id,
    mention: candidate.mention,
    label: candidate.label,
    ...(candidate.sessionId === undefined ? {} : { sessionId: candidate.sessionId }),
  }
}

/**
 * Encode any session-id string as the canonical `dsh-session:` URI — the
 * lossless mirror of the host's `encodeSessionReferenceUri`. Decoding runs in
 * the host (base64url is forgiving), but the STRING must match canonical
 * form exactly, or the host's canonicality check throws.
 * @param sessionId - opaque session id.
 * @returns canonical `dsh-session:` URI.
 */
export function encodeSessionReferenceUri(sessionId: string): string {
  return `dsh-session:${utf8ToBase64Url(JSON.stringify(sessionId))}`
}

/**
 * Render the host-neutral Markdown mention a drag insert ships: an escaped
 * `@[label](uri)` pair, exactly as the host's `formatSessionReferenceMention`
 * would for the same input.
 * @param sessionId - the referenced session.
 * @param label - display label (escaped for the `[]` slot).
 * @returns the canonical mention text.
 */
export function sessionMention(sessionId: string, label: string): string {
  const escaped = label.replace(/[\\\]]/gu, match => `\\${match}`)
  return `@[${escaped}](${encodeSessionReferenceUri(sessionId)})`
}

/** Workspace drag source: id/title plus the session the drag references. */
export interface WorkspaceReferenceSource {
  /** Workspace id (the row's `workspaceId`). */
  readonly id: string
  /** Workspace display title (the row label). */
  readonly label: string
  /** The session this drag references (current, else most recent); absent
   *  when the workspace has no referenceable session — the drop then ships
   *  the plain title instead of a mention. */
  readonly primarySession?: { readonly id: string; readonly title?: string } | undefined
}

/**
 * Build the workspace drag payload: the canonical mention of the workspace's
 * referenced session, labeled by the workspace title. Without a referenceable
 * session the mention falls back to the plain title (never the raw uuid).
 * @param source - workspace drag source.
 * @returns the ready-to-write payload.
 */
export function workspaceReferencePayload(source: WorkspaceReferenceSource): DragReferencePayload {
  const base = {
    version: REFERENCE_PROTOCOL_VERSION,
    kind: 'workspace' as const,
    id: source.id,
    label: source.label,
  }
  const sessionId = source.primarySession?.id
  if (sessionId === undefined) return { ...base, mention: source.label }
  return { ...base, sessionId, mention: sessionMention(sessionId, source.label) }
}

/**
 * Build the session drag payload: the canonical mention of the session
 * itself, labeled by its title (falling back to the id, like the host's
 * candidate labeling does for untitled sessions).
 * @param source - session id and optional title.
 * @returns the ready-to-write payload.
 */
export function sessionReferencePayload(source: { readonly id: string; readonly label?: string | undefined }): DragReferencePayload {
  const label = source.label ?? source.id
  return {
    version: REFERENCE_PROTOCOL_VERSION,
    kind: 'session' as const,
    id: source.id,
    label,
    mention: sessionMention(source.id, label),
  }
}

// ---------------------------------------------------------------------------
// Active-drag stash. The window-level chat-drop router reads the payload
// synchronously during dragover/drop — `DataTransfer.getData` is not
// readable during dragover in Chromium, so the drag source stashes the
// payload here instead. The stash lives in this module (not the router) to
// keep the protocol import graph one-directional.
// ---------------------------------------------------------------------------

let activeReference: DragReferencePayload | null = null

/** Record the payload of a drag currently in flight (null clears it). */
export function stashActiveReference(payload: DragReferencePayload | null): void {
  activeReference = payload
}

/** The payload of the plugin drag currently in flight, or null. */
export function getActiveReference(): DragReferencePayload | null {
  return activeReference
}

/** Encode UTF-8 to RFC 4648 §5 base64url (URL-safe alphabet, no padding). */
function utf8ToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  // Chunked: String.fromCharCode spread must stay under the call-argument cap.
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

/** Structural subset marker — lets parse read partial fields without casts. */
type RecursivePartial<T> = { [K in keyof T]?: T[K] }
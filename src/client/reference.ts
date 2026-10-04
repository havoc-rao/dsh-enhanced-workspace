/**
 * Enhanced-browser drag wire protocol. Tree moves remain local; the external
 * workspace-chain consumer owns structured composer insertion and validates
 * version/kind/id against live items. text/plain carries the same reference
 * identity, not an implicitly chosen session or a raw display label.
 *
 * Session mentions mirror DSH's canonical UTF-8 JSON-id base64url codec and
 * label escaping. Workspace references mirror workspace-chain's
 * workspaceReference(id, label): UTF-8 JSON { id, label }, base64url without
 * padding, prefixed with @workspace-ref/. Both codecs are inline to keep the
 * client bundle independent of non-platform runtime modules.
 * @module dsh-enhanced-workspace/client/reference
 */

export const WORKSPACE_REFERENCE_MIME = 'application/x-dsh-reference+json'
export const REFERENCE_PROTOCOL_VERSION = 1 as const
export type DragReferenceKind = 'workspace' | 'session' | 'folder'

export interface DragReferencePayload {
  readonly version: typeof REFERENCE_PROTOCOL_VERSION
  readonly kind: DragReferenceKind
  /** The dragged entity's own identity, never a workspace's selected session. */
  readonly id: string
  /** Canonical reference text carried in text/plain. */
  readonly mention: string
  readonly label: string
}

export function encodeDragReference(payload: DragReferencePayload): string {
  return JSON.stringify(payload)
}

/** Foreign or invalid payloads are ignored, never thrown on. */
export function parseDragReference(json: string | null | undefined): DragReferencePayload | null {
  if (json === null || json === undefined || json === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const candidate = parsed as Partial<DragReferencePayload>
  if (candidate.version !== REFERENCE_PROTOCOL_VERSION) return null
  if (candidate.kind !== 'workspace' && candidate.kind !== 'session' && candidate.kind !== 'folder') return null
  if (typeof candidate.id !== 'string' || typeof candidate.mention !== 'string' || typeof candidate.label !== 'string') return null
  return {
    version: REFERENCE_PROTOCOL_VERSION,
    kind: candidate.kind,
    id: candidate.id,
    mention: candidate.mention,
    label: candidate.label,
  }
}

/** Byte-for-byte mirror of the host's encodeSessionReferenceUri. */
export function encodeSessionReferenceUri(sessionId: string): string {
  return `dsh-session:${utf8ToBase64Url(JSON.stringify(sessionId))}`
}

export function sessionMention(sessionId: string, label: string): string {
  const escaped = label.replace(/[\\\]]/gu, match => `\\${match}`)
  return `@[${escaped}](${encodeSessionReferenceUri(sessionId)})`
}

/** Byte-for-byte mirror of workspace-chain workspaceReference(id, label). */
export function workspaceMention(id: string, label: string): string {
  return `@workspace-ref/${utf8ToBase64Url(JSON.stringify({ id, label }))}`
}

export interface WorkspaceReferenceSource {
  readonly id: string
  readonly label: string
}

/** Workspace identity is referenceable even without any sessions. */
export function workspaceReferencePayload(source: WorkspaceReferenceSource): DragReferencePayload {
  return {
    version: REFERENCE_PROTOCOL_VERSION,
    kind: 'workspace',
    id: source.id,
    label: source.label,
    mention: workspaceMention(source.id, source.label),
  }
}

/** Only explicitly dragging a session attaches that session's history. */
export function sessionReferencePayload(source: { readonly id: string; readonly label?: string | undefined }): DragReferencePayload {
  const label = source.label ?? source.id
  return {
    version: REFERENCE_PROTOCOL_VERSION,
    kind: 'session',
    id: source.id,
    label,
    mention: sessionMention(source.id, label),
  }
}

/** UTF-8 to RFC 4648 §5 base64url (URL-safe alphabet, no padding). */
function utf8ToBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  }
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '')
}

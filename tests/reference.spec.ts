import { describe, expect, it } from 'vitest'
import {
  REFERENCE_PROTOCOL_VERSION,
  WORKSPACE_REFERENCE_MIME,
  encodeDragReference,
  encodeSessionReferenceUri,
  getActiveReference,
  parseDragReference,
  sessionMention,
  sessionReferencePayload,
  stashActiveReference,
  workspaceReferencePayload,
} from '../src/client/reference.ts'

describe('encodeSessionReferenceUri (DSH host wire mirror)', () => {
  it('matches Node Buffer base64url byte-for-byte (canonicality is strict host-side)', () => {
    for (const sessionId of ['sess-abc', '会话-αβ', 'x'.repeat(200), 'a+b/c=d&e']) {
      const expected = `dsh-session:${Buffer.from(JSON.stringify(sessionId), 'utf8').toString('base64url')}`
      expect(encodeSessionReferenceUri(sessionId)).toBe(expected)
    }
  })

  it('encodes distinct ids to distinct URIs', () => {
    expect(encodeSessionReferenceUri('a')).not.toBe(encodeSessionReferenceUri('b'))
  })
})

describe('sessionMention', () => {
  it('renders the canonical escaped @[label](uri) mention', () => {
    const uri = encodeSessionReferenceUri('s1')
    expect(sessionMention('s1', '重构')).toBe(`@[重构](${uri})`)
  })

  it('escapes backslash and closing bracket in the label', () => {
    expect(sessionMention('s1', 'a\\b]c')).toBe(`@[a\\\\b\\]c](dsh-session:${Buffer.from(JSON.stringify('s1'), 'utf8').toString('base64url')})`)
  })
})

describe('workspaceReferencePayload', () => {
  it('references the primary session under the workspace title label', () => {
    const payload = workspaceReferencePayload({
      id: 'ws-1',
      label: 'dsh-enhanced-workspace',
      primarySession: { id: 'sess-9', title: '重构 dnd 框架' },
    })
    expect(payload.kind).toBe('workspace')
    expect(payload.sessionId).toBe('sess-9')
    expect(payload.mention).toBe(sessionMention('sess-9', 'dsh-enhanced-workspace'))
    expect(payload.label).toBe('dsh-enhanced-workspace')
  })

  it('falls back to the plain title (never the raw uuid) without a referenceable session', () => {
    const payload = workspaceReferencePayload({ id: 'ws-1', label: '空工作区' })
    expect(payload.sessionId).toBeUndefined()
    expect(payload.mention).toBe('空工作区')
  })
})

describe('sessionReferencePayload', () => {
  it('labels by title when present', () => {
    const payload = sessionReferencePayload({ id: 'sess-5', label: '标题' })
    expect(payload.mention).toBe(sessionMention('sess-5', '标题'))
  })

  it('labels by id when untitled (host untitled-session convention)', () => {
    const payload = sessionReferencePayload({ id: 'sess-5' })
    expect(payload.mention).toBe(sessionMention('sess-5', 'sess-5'))
  })
})

describe('payload encode/parse round trip', () => {
  it('round-trips every field', () => {
    const payload = workspaceReferencePayload({
      id: 'ws-1',
      label: 'L',
      primarySession: { id: 'sess-1' },
    })
    expect(parseDragReference(encodeDragReference(payload))).toEqual(payload)
  })

  it('rejects garbage, empty, and foreign-version payloads without throwing', () => {
    expect(parseDragReference(null)).toBeNull()
    expect(parseDragReference('')).toBeNull()
    expect(parseDragReference('not json')).toBeNull()
    expect(parseDragReference('{"version":2,"kind":"workspace","id":"a","mention":"b","label":"c"}')).toBeNull()
    expect(parseDragReference('{"kind":"workspace","id":"a","mention":"b","label":"c"}')).toBeNull()
    expect(parseDragReference('{"version":1,"kind":"ufo","id":"a","mention":"b","label":"c"}')).toBeNull()
    expect(parseDragReference('{"version":1,"kind":"workspace","id":42}')).toBeNull()
  })
})

describe('active-drag stash', () => {
  it('holds exactly the latest stashed payload and clears on null', () => {
    stashActiveReference(null)
    expect(getActiveReference()).toBeNull()
    const payload = sessionReferencePayload({ id: 'sess-1' })
    stashActiveReference(payload)
    expect(getActiveReference()).toBe(payload)
    stashActiveReference(null)
    expect(getActiveReference()).toBeNull()
  })
})

describe('protocol constants', () => {
  it('keeps the MIME and version advertised', () => {
    expect(WORKSPACE_REFERENCE_MIME).toBe('application/x-dsh-reference+json')
    expect(REFERENCE_PROTOCOL_VERSION).toBe(1)
  })
})
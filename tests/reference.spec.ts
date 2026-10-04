import { describe, expect, it } from 'vitest'
import {
  REFERENCE_PROTOCOL_VERSION,
  WORKSPACE_REFERENCE_MIME,
  encodeDragReference,
  encodeSessionReferenceUri,
  parseDragReference,
  sessionMention,
  sessionReferencePayload,
  workspaceReferencePayload,
  workspaceMention,
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
  it('preserves workspace identity without selecting any session', () => {
    const payload = workspaceReferencePayload({ id: 'ws-1', label: '项目' })
    expect(payload).toEqual({ version: 1, kind: 'workspace', id: 'ws-1', label: '项目', mention: workspaceMention('ws-1', '项目') })
    expect(payload).not.toHaveProperty('sessionId')
    expect(payload.mention).not.toContain('dsh-session:')
  })

  it('keeps an empty workspace referenceable, never falling back to plain title', () => {
    const payload = workspaceReferencePayload({ id: 'ws-empty', label: '空工作区' })
    const raw = payload.mention.slice('@workspace-ref/'.length)
    expect(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))).toEqual({ id: 'ws-empty', label: '空工作区' })
  })

  it('mirrors workspace-chain UTF-8 JSON property order and base64url byte-for-byte', () => {
    for (const [id, label] of [['ws-1', '标题'], ['工作区-αβ', 'a\\b]c / + = 😀'], ['x'.repeat(200), '']]) {
      const encoded = Buffer.from(JSON.stringify({ id, label }), 'utf8').toString('base64url')
      expect(workspaceMention(id!, label!)).toBe(`@workspace-ref/${encoded}`)
    }
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

describe('protocol constants', () => {
  it('keeps the MIME and version advertised', () => {
    expect(WORKSPACE_REFERENCE_MIME).toBe('application/x-dsh-reference+json')
    expect(REFERENCE_PROTOCOL_VERSION).toBe(1)
  })
})
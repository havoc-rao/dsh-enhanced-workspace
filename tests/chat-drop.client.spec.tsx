// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CHAT_DROP_AFFORDANCE_ATTR,
  CHAT_DROP_BROWSER_ATTR,
  chatDropZoneOf,
  composerEditable,
  createChatDropAffordance,
  insertTextIntoEditable,
  installChatDropRouter,
  type ChatDropRouterHandlers,
} from '../src/client/chat-drop.ts'
import {
  sessionReferencePayload,
  stashActiveReference,
  workspaceReferencePayload,
  type DragReferencePayload,
} from '../src/client/reference.ts'

/** Minimal conversation-column fixture: plugin tree, composer seat (with an
 *  editable surface and a non-editable chrome area), transcript scroll body. */
function fixtureDom(): {
  tree: HTMLElement
  treeLeaf: HTMLElement
  seat: HTMLElement
  editable: HTMLElement
  chrome: HTMLElement
  scroll: HTMLElement
} {
  document.body.innerHTML = ''
  const tree = document.createElement('div')
  tree.setAttribute(CHAT_DROP_BROWSER_ATTR, '')
  const treeLeaf = document.createElement('span')
  tree.appendChild(treeLeaf)
  const seat = document.createElement('div')
  seat.setAttribute('data-composer-seat', '')
  const editable = document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  const chrome = document.createElement('div')
  seat.append(editable, chrome)
  const scroll = document.createElement('div')
  scroll.setAttribute('data-conversation-scroll', '')
  document.body.append(tree, seat, scroll)
  return { tree, treeLeaf, seat, editable, chrome, scroll }
}

function dispatchOn(target: Element, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

/** jsdom does not implement `document.execCommand` at all — define a stub so
 *  specs can spy on the real call surface (`insertTextIntoEditable`). */
function ensureExecCommand(): void {
  if (typeof document.execCommand !== 'function') {
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      writable: true,
      value: (): boolean => false,
    })
  }
}

beforeEach(ensureExecCommand)

const WORKSPACE_PAYLOAD = () => workspaceReferencePayload({
  id: 'ws-1',
  label: 'dsh-enhanced-workspace',
  primarySession: { id: 'sess-9', title: '重构' },
})

describe('chatDropZoneOf', () => {
  it('classifies the plugin tree, editables, conversation column, and elsewhere', () => {
    const dom = fixtureDom()
    expect(chatDropZoneOf(dom.tree)).toBe('browser')
    expect(chatDropZoneOf(dom.treeLeaf)).toBe('browser')
    expect(chatDropZoneOf(dom.editable)).toBe('editable')
    expect(chatDropZoneOf(dom.chrome)).toBe('chat')
    expect(chatDropZoneOf(dom.scroll)).toBe('chat')
    expect(chatDropZoneOf(document.body)).toBe('other')
    expect(chatDropZoneOf(null)).toBe('other')
  })
})

describe('composerEditable / insertTextIntoEditable', () => {
  it('finds the composer text surface and inserts through execCommand', () => {
    const dom = fixtureDom()
    expect(composerEditable()).toBe(dom.editable)
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const focus = vi.spyOn(dom.editable, 'focus')
    expect(insertTextIntoEditable(dom.editable, 'hello')).toBe(true)
    expect(focus).toHaveBeenCalledOnce()
    expect(exec).toHaveBeenCalledWith('insertText', false, 'hello')
    exec.mockRestore()
    focus.mockRestore()
  })

  it('reports false when execCommand refuses', () => {
    const dom = fixtureDom()
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(false)
    expect(insertTextIntoEditable(dom.editable, 'x')).toBe(false)
    exec.mockRestore()
  })
})

describe('installChatDropRouter', () => {
  let handlers: ChatDropRouterHandlers
  let onActive: (payload: DragReferencePayload | null) => void
  let onInsert: (payload: DragReferencePayload) => void

  beforeEach(() => {
    ensureExecCommand()
    onActive = vi.fn<(payload: DragReferencePayload | null) => void>()
    onInsert = vi.fn<(payload: DragReferencePayload) => void>()
    handlers = { onActive, onInsert }
    stashActiveReference(null)
  })

  afterEach(() => {
    stashActiveReference(null)
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it('routes a drop over the non-editable conversation column into the composer', () => {
    const dom = fixtureDom()
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const off = installChatDropRouter(handlers)
    stashActiveReference(WORKSPACE_PAYLOAD())

    const event = dispatchOn(dom.chrome, 'drop')

    expect(event.defaultPrevented).toBe(true)
    expect(exec).toHaveBeenCalledWith('insertText', false, WORKSPACE_PAYLOAD().mention)
    expect(onInsert).toHaveBeenCalledOnce()
    // The pending affordance is cleared once the drop settles.
    expect(onActive).toHaveBeenLastCalledWith(null)
    off()
  })

  it('routes a drop over the transcript scroll body into the composer', () => {
    const dom = fixtureDom()
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const off = installChatDropRouter(handlers)
    stashActiveReference(WORKSPACE_PAYLOAD())

    const event = dispatchOn(dom.scroll, 'drop')

    expect(event.defaultPrevented).toBe(true)
    expect(exec).toHaveBeenCalledWith('insertText', false, WORKSPACE_PAYLOAD().mention)
    off()
  })

  it('leaves drops on the editable to the default path (mention text/plain)', () => {
    const dom = fixtureDom()
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const off = installChatDropRouter(handlers)
    stashActiveReference(WORKSPACE_PAYLOAD())

    const event = dispatchOn(dom.editable, 'drop')

    expect(event.defaultPrevented).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    expect(onInsert).not.toHaveBeenCalled()
    off()
  })

  it('leaves drops outside the conversation column untouched', () => {
    const dom = fixtureDom()
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const off = installChatDropRouter(handlers)
    stashActiveReference(WORKSPACE_PAYLOAD())

    expect(dispatchOn(document.body, 'drop').defaultPrevented).toBe(false)
    expect(dispatchOn(dom.tree, 'drop').defaultPrevented).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    off()
  })

  it('is inert without a plugin drag in flight', () => {
    const dom = fixtureDom()
    const off = installChatDropRouter(handlers)
    // No stash: a foreign drag (official sidebar rows) keeps default behavior.
    expect(dispatchOn(dom.chrome, 'drop').defaultPrevented).toBe(false)
    expect(dispatchOn(dom.chrome, 'dragover').defaultPrevented).toBe(false)
    expect(onActive).not.toHaveBeenCalled()
    off()
  })

  it('announces enter/leave of the routed column for the affordance', () => {
    const dom = fixtureDom()
    const off = installChatDropRouter(handlers)
    stashActiveReference(WORKSPACE_PAYLOAD())

    const over = dispatchOn(dom.chrome, 'dragover')
    expect(over.defaultPrevented).toBe(true)
    expect(onActive).toHaveBeenCalledWith(WORKSPACE_PAYLOAD())

    // Leaving the window (relatedTarget null) clears the affordance.
    const leave = new Event('dragleave', { bubbles: true, cancelable: true })
    dom.chrome.dispatchEvent(leave)
    expect(onActive).toHaveBeenLastCalledWith(null)

    // Re-enter works again after leave: payload, then null, then payload.
    dispatchOn(dom.chrome, 'dragover')
    expect(onActive).toHaveBeenCalledTimes(3)
    expect(onActive).toHaveBeenLastCalledWith(WORKSPACE_PAYLOAD())
    off()
  })

  it('does not insert without a composer editable (inert hero) but still swallows', () => {
    const dom = fixtureDom()
    dom.editable.remove()
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const off = installChatDropRouter(handlers)
    stashActiveReference(WORKSPACE_PAYLOAD())

    const event = dispatchOn(dom.chrome, 'drop')

    expect(event.defaultPrevented).toBe(true)
    expect(exec).not.toHaveBeenCalled()
    expect(onInsert).not.toHaveBeenCalled()
    off()
  })

  it('disposes cleanly', () => {
    const dom = fixtureDom()
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const off = installChatDropRouter(handlers)
    off()
    stashActiveReference(WORKSPACE_PAYLOAD())
    expect(dispatchOn(dom.chrome, 'drop').defaultPrevented).toBe(false)
    expect(exec).not.toHaveBeenCalled()
  })

  it('routes a session row payload with its own mention', () => {
    const dom = fixtureDom()
    const exec = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const off = installChatDropRouter(handlers)
    const payload = sessionReferencePayload({ id: 'sess-5', label: '标题' })
    stashActiveReference(payload)

    dispatchOn(dom.chrome, 'drop')

    expect(exec).toHaveBeenCalledWith('insertText', false, payload.mention)
    off()
  })
})

describe('createChatDropAffordance', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('shows a pill with the payload label anchored to the composer seat and hides on null', () => {
    fixtureDom()
    const pill = createChatDropAffordance()
    const payload: DragReferencePayload = WORKSPACE_PAYLOAD()

    pill.update(payload)

    const el = document.querySelector<HTMLElement>(`[${CHAT_DROP_AFFORDANCE_ATTR}]`)
    expect(el).not.toBeNull()
    expect(el?.textContent).toBe('引用到输入框：@dsh-enhanced-workspace')
    expect(el?.style.position).toBe('fixed')

    pill.update(null)
    expect(document.querySelector(`[${CHAT_DROP_AFFORDANCE_ATTR}]`)).toBeNull()
    pill.dispose()
  })

  it('stays hidden without a composer seat, and dispose removes the element', () => {
    // No fixture: document.body has no [data-composer-seat].
    const pill = createChatDropAffordance()
    const payload: DragReferencePayload = WORKSPACE_PAYLOAD()

    pill.update(payload)
    expect(document.querySelector(`[${CHAT_DROP_AFFORDANCE_ATTR}]`)).toBeNull()

    fixtureDom()
    pill.update(payload)
    expect(document.querySelector(`[${CHAT_DROP_AFFORDANCE_ATTR}]`)).not.toBeNull()
    pill.dispose()
    expect(document.querySelector(`[${CHAT_DROP_AFFORDANCE_ATTR}]`)).toBeNull()
  })
})
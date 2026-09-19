/**
 * Chat-input drop routing for plugin drags: turns "drag a workspace/session
 * row over the conversation column" into "insert the canonical DSH
 * session-reference mention into the composer draft".
 *
 * Routes (window capture phase; a plugin drag is one whose payload is in the
 * active-drag stash — see reference.ts):
 *
 * - over the plugin's own tree   → untouched (the tree owns its drops)
 * - over a text editable         → untouched (the browser/Lexical default
 *   already inserts `text/plain` = the mention at the drop point)
 * - over the conversation column → intercepted: prevented, the composer
 *   editable is focused, and the mention is inserted through an
 *   `insertText` beforeinput — the same pipeline Lexical feeds on typing —
 *   with a pill affordance above the composer seat while hovering
 * - anywhere else                → untouched (default text drop behavior;
 *   the payload's `text/plain` is the mention, so nothing raw leaks)
 *
 * Mounted at fiber level in index.tsx — NOT inside the browser tree — so the
 * routing survives a collapsed sidebar.
 * @module dsh-enhanced-workspace/client/chat-drop
 */

import {
  getActiveReference,
  type DragReferencePayload,
} from './reference.ts'

/** Marker attribute on the browser tree container; drops inside it belong to
 *  the tree, not to this router. */
export const CHAT_DROP_BROWSER_ATTR = 'data-dsh-ew-browser'

/** Marker attribute on the affordance pill (stable hook for tests/styling). */
export const CHAT_DROP_AFFORDANCE_ATTR = 'data-dsh-ew-chat-drop'

const COMPOSER_SEAT_SELECTOR = '[data-composer-seat]'
const CONVERSATION_SCROLL_SELECTOR = '[data-conversation-scroll]'

/** Where a pointer position lands relative to this router's routing table. */
export type ChatDropZone = 'browser' | 'editable' | 'chat' | 'other'

/**
 * Classify a drop target: the plugin's own tree, a text editable (default
 * text-drop behavior applies), the conversation column outside any editable
 * (routed into the composer), or anywhere else.
 * @param target - the event target (or null).
 * @returns the zone the router should use for it.
 */
export function chatDropZoneOf(target: EventTarget | null): ChatDropZone {
  if (target === null || !(target instanceof Element)) return 'other'
  if (target.closest(`[${CHAT_DROP_BROWSER_ATTR}]`) !== null) return 'browser'
  if (target.closest('[contenteditable], textarea, input') !== null) return 'editable'
  const column = target.closest(`${COMPOSER_SEAT_SELECTOR}, ${CONVERSATION_SCROLL_SELECTOR}`)
  return column === null ? 'other' : 'chat'
}

/** The composer's text surface, when one exists (undefined in the inert hero). */
export function composerEditable(): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${COMPOSER_SEAT_SELECTOR} [contenteditable]`)
}

/**
 * Insert text into an editable at the caret. Uses `execCommand('insertText')`
 * — the document-API path that fires a synchronous `insertText` beforeinput,
 * which is exactly the pipeline the composer's Lexical editor already
 * consumes on typing/drop. Returns false when the browser refused.
 * @param element - the focused text surface (normally the composer editable).
 * @param text - text to insert verbatim.
 * @returns whether the insert was accepted.
 */
export function insertTextIntoEditable(element: HTMLElement, text: string): boolean {
  element.focus()
  if (typeof document.execCommand !== 'function') return false
  const accepted = document.execCommand('insertText', false, text)
  return accepted !== false
}

/** Router callbacks. */
export interface ChatDropRouterHandlers {
  /** A plugin-reference drag entered / left the routed conversation column
   *  (payload on enter, null on exit/drop). Drives the affordance. */
  onActive(payload: DragReferencePayload | null): void
  /** A plugin-reference drop was actually inserted into the composer draft. */
  onInsert?(payload: DragReferencePayload): void
}

/**
 * Install the window-level chat-drop router. Idempotent per install; the
 * returned disposer removes every listener.
 * @param handlers - affordance/insertion callbacks.
 * @returns the disposer.
 */
export function installChatDropRouter(handlers: ChatDropRouterHandlers): () => void {
  let overChat = false

  const onDragOver = (event: DragEvent): void => {
    const payload = getActiveReference()
    if (payload === null) return
    if (chatDropZoneOf(event.target) !== 'chat') return
    // A routed zone must accept the drop or the browser shows 'not allowed'.
    event.preventDefault()
    if (!overChat) {
      overChat = true
      handlers.onActive(payload)
    }
  }
  const onDragLeave = (event: DragEvent): void => {
    if (!overChat) return
    if (event.relatedTarget instanceof Node && event.relatedTarget.isConnected) return
    overChat = false
    handlers.onActive(null)
  }
  const onDrop = (event: DragEvent): void => {
    const payload = getActiveReference()
    if (payload === null) return
    if (chatDropZoneOf(event.target) !== 'chat') return
    event.preventDefault()
    overChat = false
    handlers.onActive(null)
    const editable = composerEditable()
    if (editable === null) return
    if (insertTextIntoEditable(editable, payload.mention)) {
      handlers.onInsert?.(payload)
    }
  }
  const onDragEnd = (): void => {
    if (!overChat) return
    overChat = false
    handlers.onActive(null)
  }

  window.addEventListener('dragover', onDragOver, true)
  window.addEventListener('dragleave', onDragLeave, true)
  window.addEventListener('drop', onDrop, true)
  window.addEventListener('dragend', onDragEnd, true)
  return () => {
    window.removeEventListener('dragover', onDragOver, true)
    window.removeEventListener('dragleave', onDragLeave, true)
    window.removeEventListener('drop', onDrop, true)
    window.removeEventListener('dragend', onDragEnd, true)
  }
}

/** Affordance handle: update() shows/hides the pill, dispose() tears it down. */
export interface ChatDropAffordance {
  /** Show the pill over the composer seat for the payload, or hide it. */
  update(payload: DragReferencePayload | null): void
  dispose(): void
}

/**
 * Imperative drop affordance: a fixed pill above the composer seat while a
 * plugin reference hovers the routed conversation column. Deliberately a
 * plain DOM element (no React root) — it lives at fiber level, independent
 * of the sidebar tree, and carries zero styling dependencies.
 * @returns the affordance handle.
 */
export function createChatDropAffordance(): ChatDropAffordance {
  let element: HTMLDivElement | null = null
  const update = (payload: DragReferencePayload | null): void => {
    if (payload === null) {
      element?.remove()
      element = null
      return
    }
    const seat = document.querySelector<HTMLElement>(COMPOSER_SEAT_SELECTOR)
    if (seat === null) {
      element?.remove()
      element = null
      return
    }
    if (element === null) {
      element = document.createElement('div')
      element.setAttribute(CHAT_DROP_AFFORDANCE_ATTR, '')
      element.style.cssText = [
        'position:fixed',
        'z-index:2147483000',
        'pointer-events:none',
        'background:rgba(17,21,28,0.92)',
        'color:#e8ecf2',
        'font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif',
        'padding:6px 10px',
        'border-radius:8px',
        'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
        'white-space:nowrap',
        'transform:translate(-50%, calc(-100% - 10px))',
      ].join(';')
      document.body.appendChild(element)
    }
    const rect = seat.getBoundingClientRect()
    element.style.left = `${rect.left + rect.width / 2}px`
    element.style.top = `${rect.top}px`
    element.textContent = `引用到输入框：@${payload.label}`
  }
  const dispose = (): void => {
    element?.remove()
    element = null
  }
  return { update, dispose }
}
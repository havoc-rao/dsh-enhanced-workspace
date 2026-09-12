// @vitest-environment jsdom
/**
 * Contract spec of the plugin-owned SEARCH hole (the external trigger
 * surface dsh-hotkey consumes). Two layers, both assertable without the real
 * React shell:
 *
 *  1. `SlotCore` (the pure registry behind `ctx.slots`) — the declaration
 *     built exactly like `index.tsx` declares it accepts the search child,
 *     and the declaration's common `inject` face IS the shared
 *     `searchHandle` singleton (this is what the slot machinery binds into
 *     every occupant's props);
 *  2. the shared handle's unmounted semantics (no region mounted: `available`
 *     false, `focus`/`setQuery` no-ops, `input()` null) and the DOM fallback
 *     helper — the guarantees an external action relies on before/after the
 *     browser region mounts.
 *
 * The mounted behavior (focus/query actually landing in the input, the
 * window mirror's lifecycle, occupant rendering) lives in
 * `browser.client.spec.tsx`'s "external search trigger surface" suite.
 */
import { describe, expect, it, vi } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  DIRECTORY_FLOW_SLOT,
  SEARCH_ATTR,
  SEARCH_GLOBAL_KEY,
  SEARCH_INPUT_ATTR_VALUE,
  SEARCH_INPUT_SELECTOR,
  SEARCH_RAIL_BUTTON_ATTR_VALUE,
  SEARCH_RAIL_BUTTON_SELECTOR,
  SEARCH_SLOT,
  commitSearchQueryFromDom,
  searchHandle,
} from '../src/client/contract.ts'

describe('search slot contract (external trigger surface)', () => {
  it('uses the plugin namespace and the stable DOM markers', () => {
    expect(SEARCH_SLOT).toBe('enhanced-workspace.workspace.search')
    expect(DIRECTORY_FLOW_SLOT).toBe('enhanced-workspace.workspace.directoryFlow')
    expect(SEARCH_GLOBAL_KEY).toBe('__DSH_ENHANCED_WORKSPACE__')
    expect(SEARCH_ATTR).toBe('data-dsh-enhanced-workspace')
    expect(SEARCH_INPUT_ATTR_VALUE).toBe('search')
    expect(SEARCH_RAIL_BUTTON_ATTR_VALUE).toBe('search-button')
    expect(SEARCH_INPUT_SELECTOR).toBe('[data-dsh-enhanced-workspace="search"]')
    expect(SEARCH_RAIL_BUTTON_SELECTOR).toBe('[data-dsh-enhanced-workspace="search-button"]')
  })

  it('the declaration accepts both plugin holes and binds the shared handle as the search inject face', () => {
    const core = new SlotCore()
    // Exactly the two children `index.tsx` registers (same keys/kinds/inject).
    const disposeDeclaration = core.register(
      {
        name: 'root',
        children: {
          [DIRECTORY_FLOW_SLOT]: { kind: 'single', scope: 'root' },
          [SEARCH_SLOT]: { kind: 'single', scope: 'root', inject: searchHandle },
        },
      } as never,
      (() => null) as never,
    )
    try {
      expect(core.spec(SEARCH_SLOT)).toMatchObject({ kind: 'single', scope: 'root' })
      expect(core.specDynamic(SEARCH_SLOT)?.inject).toBe(searchHandle)
      // The occupant registers WITHOUT re-declaring the inject face: the
      // common face is the parent's. A foreign key would throw here.
      const disposeOccupant = core.register(
        { name: SEARCH_SLOT, registrant: 'external-plugin-fixture' } as never,
        (() => null) as never,
      )
      try {
        expect(core.entriesOfSlot(SEARCH_SLOT)).toHaveLength(1)
      } finally {
        disposeOccupant()
      }
      expect(core.entriesOfSlot(SEARCH_SLOT)).toHaveLength(0)
    } finally {
      disposeDeclaration()
    }
    expect(core.spec(SEARCH_SLOT)).toBeUndefined()
  })

  it('unmounted handle is inert: available false, focus/setQuery no-ops, input null (no throw)', () => {
    expect(searchHandle.available).toBe(false)
    expect(searchHandle.input()).toBeNull()
    expect(() => { searchHandle.focus(); searchHandle.setQuery('anything') }).not.toThrow()
  })

  it('DOM fallback finds nothing and reports false while no input is mounted', () => {
    expect(document.querySelector(SEARCH_INPUT_SELECTOR)).toBeNull()
    expect(commitSearchQueryFromDom('文档')).toBe(false)
  })

  it('DOM fallback commits through the React-compatible path once an input is marked', () => {
    const input = document.createElement('input')
    input.setAttribute('data-dsh-enhanced-workspace', 'search')
    const onChange = vi.fn()
    input.addEventListener('input', onChange)
    document.body.appendChild(input)
    try {
      expect(commitSearchQueryFromDom('绘画')).toBe(true)
      expect(input.value).toBe('绘画')
      expect(onChange, 'the bubbling input event reaches listeners (React onChange)').toHaveBeenCalledTimes(1)
    } finally {
      input.remove()
    }
  })
})

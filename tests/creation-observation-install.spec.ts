import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Picker, ItemId } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import installWorkspacePalette from '../src/client/command-palette/install.ts'

it('connects the actual legacy cmd workspace adapter to the Host capability without runtime imports', async () => {
  let picker!: Picker
  const order: string[] = []
  const observation = { create: vi.fn(async () => { order.push('create'); return 'observed' }),
    whenOpened: vi.fn(async () => { order.push('wait') }), phase: vi.fn(), end: vi.fn(async () => {}) }
  const sessions = { list: { getSnapshot: () => ({ byId: {} }), subscribe: () => () => {} },
    create: vi.fn(async () => 'unobserved'), observeCreation: vi.fn(async () => observation) }
  const palette = { registerPicker: (p: Picker) => { picker = p; return () => {} }, registerCommand: () => () => {}, refresh: vi.fn() }
  const ctx = { inject: (_names: string[], apply: (ctx: Context) => void) => apply(ctx as unknown as Context),
    effect: (work: () => unknown) => work(),
    locale: { register: () => () => {}, bind: () => (key: string) => key, subscribe: () => () => {} },
    get: (key: string) => key === 'commandPalette' ? palette : { state: { getSnapshot: () => 'connected', subscribe: () => () => {} } },
    sessions, workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'a', title: 'A', path: '/private/a', sessionIds: [] }] }), subscribe: () => () => {} } },
    uiWorkspace: { openSession: vi.fn(() => { order.push('navigate') }) } }
  installWorkspacePalette(ctx as unknown as Context)
  const result = await picker.accept('a' as ItemId, { signal: new AbortController().signal, context: undefined })
  await Promise.resolve(); await Promise.resolve()
  expect(result).toEqual({ kind: 'completed' })
  expect(sessions.create).not.toHaveBeenCalled()
  expect(observation.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'a' })
  expect(order).toEqual(['create', 'wait', 'navigate'])
  expect(observation.end).toHaveBeenCalledExactlyOnceWith('success')
  expect(JSON.stringify(observation.phase.mock.calls)).not.toContain('/private/a')
})

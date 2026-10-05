// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Panel, PaletteService } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import { registerFileBrowser } from '../src/client/command-palette/install-file-browser.tsx'
import type { WorkspaceAdapter } from '../src/client/command-palette/provider.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('file browser palette panel', () => {
  it('uses the shared panel lifecycle, search, back and selection while guarding composer insertion', async () => {
    let panel!: Panel
    const command = vi.fn(() => vi.fn()), remove = vi.fn(), close = vi.fn()
    const palette = { registerCommand: command, registerPanel: (value: Panel) => { panel = value; return remove }, close } as unknown as PaletteService
    const span = { start: 3, end: 3, draftRev: 7 }
    const inputActions = { captureInsertion: vi.fn(() => span), insertReference: vi.fn(() => true), focus: vi.fn() }
    let key = 'original'
    const call = vi.fn(async () => ({ ok: true, value: { kind: 'directory', entries: [{ name: 'a.ts', path: 'a.ts', directory: false }], truncated: false } }))
    const ctx = {
      get: (name: string) => name === 'uiSession' ? { adapter: { current: { getSnapshot: () => ({ key, props: { inputActions } }) } } } : { rpc: { call } },
      locale: { getSnapshot: () => ({ active: 'zh' }) },
    } as unknown as Context
    const workspaces = {
      getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'other', title: 'Other', displayTitle: 'Other', path: '/other project', sessionIds: [] }] }),
      subscribe: () => () => {}, isConnected: () => true,
    } as unknown as WorkspaceAdapter
    const off = registerFileBrowser(ctx, palette, workspaces)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    let exit: (() => void) | undefined
    let unsubscribe: (() => void) | undefined
    try {
      expect(command).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'panel', panelId: 'workspaces.browse-files' } }))
      const dispose = panel.onOpen!({ signal: new AbortController().signal, context: {} })
      if (typeof dispose === 'function') exit = dispose
      const render = () => root.render(panel.render())
      unsubscribe = panel.subscribe(render)
      await act(async () => render())
      expect(inputActions.captureInsertion).toHaveBeenCalledOnce()
      expect(container.querySelector('input:not([type=checkbox])')).toBeNull()
      expect(container.querySelector('[role=dialog]')).toBeNull()
      await act(async () => panel.onQuery('absent'))
      expect(container.textContent).not.toContain('Other')
      await act(async () => panel.onQuery(''))
      await act(async () => { await panel.accept!({ signal: new AbortController().signal, context: {} }) })
      expect(call).toHaveBeenCalledWith('/enhanced-workspace', 'files/browse', { workspaceId: 'other', path: '' })
      expect(container.querySelector('[data-stage=tree]')).not.toBeNull()
      expect(panel.getSnapshot().scrollMode).toBe('contained')
      expect(container.querySelector('[data-mode=picker]')).toBeNull()
      expect(panel.getSnapshot().width).toBe('wide')
      await act(async () => { container.querySelector<HTMLButtonElement>('button[data-tree-main]')!.click() })
      expect(container.querySelector('[data-stage=preview]')).not.toBeNull()
      expect(panel.getSnapshot().width).toBe('wide')
      await act(async () => { expect(panel.back!()).toBe(true) })
      expect(panel.getSnapshot().width).toBe('wide')
      const actions = panel.getActions!()
      expect(actions.map(action => action.id)).toEqual(['copy-absolute-path', 'insert-reference'])
      const executeArgs = { signal: new AbortController().signal, context: {} }
      key = 'changed'
      expect(await actions[1]!.execute(executeArgs)).toMatchObject({ kind: 'failed' })
      expect(inputActions.insertReference).not.toHaveBeenCalled()
      key = 'original'
      expect(await actions[1]!.execute(executeArgs)).toEqual({ kind: 'completed' })
      expect(inputActions.insertReference).toHaveBeenCalledTimes(1)
      expect(container.textContent).not.toContain('插入引用')
      expect(container.textContent).not.toContain('复制绝对路径')
      expect(inputActions.insertReference).toHaveBeenCalledWith({ source: 'reference', ref: '@"/other project/', label: 'Other/', appearance: 'folder', clipboardText: '@"/other project/' }, span)
      expect(close).not.toHaveBeenCalled() // completed result is closed by the palette framework
      await act(async () => { expect(panel.back!()).toBe(true) })
      expect(container.querySelector('[data-stage=workspace]')).not.toBeNull()
      expect(panel.getSnapshot().scrollMode).toBe('content')
      expect(await actions[1]!.execute(executeArgs)).toEqual({ kind: 'cancelled' })
    } finally {
      unsubscribe?.(); await act(async () => root.unmount()); container.remove(); exit?.(); off()
    }
    expect(inputActions.focus).toHaveBeenCalledOnce()
    expect(remove).toHaveBeenCalledOnce()
  })
  it('does not advertise an unsupported command on old palette versions', () => {
    const registerCommand = vi.fn()
    registerFileBrowser({} as Context, { registerCommand } as unknown as PaletteService, {} as WorkspaceAdapter)()
    expect(registerCommand).not.toHaveBeenCalled()
  })
})

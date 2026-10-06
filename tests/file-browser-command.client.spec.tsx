// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Panel, PaletteService } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import { registerFileBrowser } from '../src/client/command-palette/install-file-browser.tsx'
import { browserZh } from '../src/client/command-palette/FileBrowser.tsx'
import type { WorkspaceAdapter } from '../src/client/command-palette/provider.ts'
import type { BrowserRequest, BrowserResult } from '../src/shared/file-browser.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.unstubAllGlobals())

describe('file browser palette panel', () => {
  it('accepts files directly, guards stale insertion, inserts the root through Actions and returns directly to workspace search', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    let panel!: Panel
    const command = vi.fn(() => vi.fn()), remove = vi.fn(), close = vi.fn(), openPanelActions = vi.fn()
    const palette = { registerCommand: command, registerPanel: (value: Panel) => { panel = value; return remove }, close, openPanelActions } as unknown as PaletteService
    const span = { start: 3, end: 3, draftRev: 7 }
    const inputActions = { captureInsertion: vi.fn(() => span), insertReference: vi.fn(() => true), focus: vi.fn() }
    let key = 'original'
    const call = vi.fn(async (_channel: string, _endpoint: string, request: BrowserRequest): Promise<{ ok: true; value: BrowserResult }> => ({
      ok: true, value: request.preview ? { kind: 'file', text: 'export const answer = 42', truncated: false }
        : { kind: 'directory', entries: request.path ? [{ name: 'nested.ts', path: 'src/nested.ts', directory: false }]
          : [{ name: 'a.ts', path: 'a.ts', directory: false }, { name: 'src', path: 'src', directory: true },
            { name: '.env', path: '.env', directory: false }], truncated: false },
    }))
    const ctx = {
      get: (name: string) => name === 'uiSession' ? { adapter: { current: { getSnapshot: () => ({ key, props: { inputActions } }) } } } : { rpc: { call } },
      locale: { getSnapshot: () => ({ active: 'zh' }) },
    } as unknown as Context
    let connected = true
    const createNewSession = vi.fn(async (_workspaceId: string, _signal: AbortSignal) => {})
    const workspaces = {
      getSnapshot: () => ({ phase: 'ready', items: [{ workspaceId: 'other', title: 'Other', displayTitle: 'Other', path: '/other project', sessionIds: [] }] }),
      subscribe: () => () => {}, isConnected: () => connected, createNewSession,
    } as unknown as WorkspaceAdapter
    const off = registerFileBrowser(ctx, palette, workspaces)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    let exit: (() => void) | undefined
    let unsubscribe: (() => void) | undefined
    const executeArgs = { signal: new AbortController().signal, context: {} }
    const accept = () => act(async () => { await panel.accept!(executeArgs) })
    const select = (path: string) => act(async () => { container.querySelector<HTMLButtonElement>(`button[data-tree-main][data-path="${path}"]`)!.click() })
    try {
      expect(command).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'panel', panelId: 'workspaces.browse-files' } }))
      const dispose = panel.onOpen!(executeArgs)
      if (typeof dispose === 'function') exit = dispose
      const render = () => root.render(panel.render())
      unsubscribe = panel.subscribe(render)
      await act(async () => render())
      expect(inputActions.captureInsertion).toHaveBeenCalledOnce()
      expect(container.querySelector('input:not([type=checkbox])')).toBeNull()
      expect(container.querySelector('[role=dialog]')).toBeNull()
      expect(panel.getSnapshot()).toMatchObject({ title: browserZh.title, width: 'compact', acceptLabel: browserZh.chooseWorkspace, canAccept: true,
        actionsTargetLabel: '/other project/' })
      const workspaceActions = panel.getActions!()
      expect(await workspaceActions[0]!.execute(executeArgs)).toEqual({ kind: 'completed' })
      expect(createNewSession).toHaveBeenLastCalledWith('other', executeArgs.signal)
      expect(call).not.toHaveBeenCalled() // Creating does not require loading a tree.
      expect(await workspaceActions[2]!.execute(executeArgs)).toEqual({ kind: 'completed' })
      expect(inputActions.insertReference).toHaveBeenCalledWith(expect.objectContaining({ label: 'Other/', ref: '@"/other project/' }), span)
      inputActions.insertReference.mockClear()
      await act(async () => panel.onQuery('absent'))
      expect(panel.getActions!()).toEqual([])
      expect(await workspaceActions[0]!.execute(executeArgs)).toEqual({ kind: 'cancelled' })
      expect(container.textContent).not.toContain('Other')
      expect(panel.getSnapshot().canAccept).toBe(false)
      await act(async () => panel.onQuery(''))
      await accept()
      expect(call).toHaveBeenCalledWith('/enhanced-workspace', 'files/browse', { workspaceId: 'other', path: '' })
      expect(container.querySelector('[data-stage=tree]')).not.toBeNull()
      expect(panel.getSnapshot()).toMatchObject({ scrollMode: 'contained', width: 'compact', canAccept: false })
      expect(container.querySelector('[data-mode=picker]')).toBeNull()
      expect(container.querySelector('[data-reference-footer]')).toBeNull()
      await act(async () => { expect(await panel.getActions!()[2]!.execute(executeArgs)).toEqual({ kind: 'completed' }) })
      expect(inputActions.insertReference).toHaveBeenLastCalledWith({ source: 'reference', ref: '@"/other project/', label: 'Other/', appearance: 'folder', clipboardText: '@"/other project/' }, span)
      expect(close).not.toHaveBeenCalled() // The palette closes Actions returning completed.
      inputActions.insertReference.mockClear(); close.mockClear()

      await select('src')
      expect(panel.getSnapshot()).toMatchObject({ acceptLabel: browserZh.openDirectory, canAccept: true })
      expect(container.querySelector('[role=treeitem][aria-expanded=true]')).not.toBeNull()
      await accept()
      expect(container.querySelector('[role=treeitem][aria-expanded=false]')).not.toBeNull()
      expect(inputActions.insertReference).not.toHaveBeenCalled()
      await select('a.ts')
      expect(container.querySelector('[data-stage=tree]')).not.toBeNull()
      expect(container.querySelector('[data-stage=preview]')).toBeNull()
      expect(container.querySelector('section[data-file-preview]')).not.toBeNull()
      expect(panel.getSnapshot()).toMatchObject({ width: 'compact', acceptLabel: browserZh.insert, canAccept: true })
      const actions = panel.getActions!()
      expect(actions.map(action => action.id)).toEqual(['create-new-session', 'copy-absolute-path', 'insert-reference', 'toggle-hidden-files', 'toggle-content-preview'])
      expect(container.querySelector(`header button[aria-label="${browserZh.togglePreview}"]`)).toBeNull()
      expect(actions[4]).toMatchObject({ title: browserZh.togglePreview,
        status: { kind: 'toggle', checked: true, label: browserZh.previewOn } })
      await act(async () => { expect(await actions[4]!.execute(executeArgs)).toEqual({ kind: 'stay' }) })
      expect(container.querySelector('section[data-file-preview]')).toBeNull()
      expect(panel.getActions!()[4]).toMatchObject({ status: { checked: false, label: browserZh.previewOff } })
      expect(actions[4]!.status?.checked).toBe(true)
      await act(async () => { expect(await actions[4]!.execute(executeArgs)).toEqual({ kind: 'stay' }) })
      expect(container.querySelector('section[data-file-preview]')).not.toBeNull()
      expect(panel.getActions!()[4]!.status?.checked).toBe(true)
      expect(await actions[0]!.execute(executeArgs)).toEqual({ kind: 'completed' })
      expect(createNewSession).toHaveBeenLastCalledWith('other', executeArgs.signal) // File actions use its parent workspace.
      connected = false
      expect(await actions[0]!.execute(executeArgs)).toEqual({ kind: 'failed', message: browserZh.disconnected })
      connected = true
      createNewSession.mockRejectedValueOnce(new Error('creation refused'))
      expect(await actions[0]!.execute(executeArgs)).toEqual({ kind: 'failed', message: 'creation refused' })
      const cancellation = new AbortController()
      createNewSession.mockImplementationOnce(async () => { cancellation.abort() })
      expect(await actions[0]!.execute({ ...executeArgs, signal: cancellation.signal })).toEqual({ kind: 'cancelled' })
      expect(container.querySelector('input[type=checkbox]')).toBeNull()
      expect(container.querySelector('[data-path=".env"]')).toBeNull()
      expect(actions[3]).toMatchObject({ title: browserZh.hidden,
        status: { kind: 'toggle', checked: false, label: browserZh.hiddenHidden } })
      await act(async () => { expect(await actions[3]!.execute(executeArgs)).toEqual({ kind: 'stay' }) })
      expect(container.querySelector('[data-path=".env"]')).not.toBeNull()
      expect(panel.getActions!()[3]).toMatchObject({ title: browserZh.hidden,
        status: { kind: 'toggle', checked: true, label: browserZh.hiddenShown } })
      // Reopening Actions reads the current state; the captured action stays immutable.
      expect(actions[3]!.status?.checked).toBe(false)
      await act(async () => { expect(await panel.getActions!()[3]!.execute(executeArgs)).toEqual({ kind: 'stay' }) })
      expect(panel.getActions!()[3]!.status?.checked).toBe(false)
      expect(container.querySelector('[data-path=".env"]')).toBeNull()
      const aborted = new AbortController(); aborted.abort()
      expect(await panel.getActions!()[3]!.execute({ ...executeArgs, signal: aborted.signal })).toEqual({ kind: 'cancelled' })
      expect(panel.getActions!()[3]!.status?.checked).toBe(false)
      expect(await panel.getActions!()[4]!.execute({ ...executeArgs, signal: aborted.signal })).toEqual({ kind: 'cancelled' })
      expect(panel.getActions!()[4]!.status?.checked).toBe(true)
      key = 'changed'
      await accept()
      expect(inputActions.insertReference).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
      expect(container.textContent).toContain(browserZh.stale)
      expect(await actions[2]!.execute(executeArgs)).toMatchObject({ kind: 'failed' })
      key = 'original'
      await accept() // The palette routes Enter to the panel accept handler.
      expect(inputActions.insertReference).toHaveBeenCalledOnce()
      expect(inputActions.insertReference).toHaveBeenCalledWith({ source: 'reference', ref: '@"/other project/a.ts"', label: 'a.ts', appearance: 'file', clipboardText: '@"/other project/a.ts"' }, span)
      expect(close).toHaveBeenCalledOnce()
      expect(openPanelActions).not.toHaveBeenCalled()

      await act(async () => panel.onQuery('a.ts'))
      expect(panel.getSnapshot().query).toBe('a.ts')
      await act(async () => { expect(panel.back!()).toBe(true) })
      expect(container.querySelector('[data-stage=workspace]')).not.toBeNull()
      expect(container.querySelector('section[data-file-preview]')).toBeNull()
      expect(panel.getSnapshot()).toMatchObject({ query: '', scrollMode: 'content', width: 'compact', acceptLabel: browserZh.chooseWorkspace })
      expect(container.textContent).toContain('Other')
      expect(await actions[2]!.execute(executeArgs)).toEqual({ kind: 'cancelled' })
      expect(await actions[3]!.execute(executeArgs)).toEqual({ kind: 'cancelled' })
      expect(await actions[4]!.execute(executeArgs)).toEqual({ kind: 'cancelled' })
      expect(panel.getActions!().some(action => action.id === 'toggle-content-preview')).toBe(false)
      expect(panel.back!()).toBe(false)
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

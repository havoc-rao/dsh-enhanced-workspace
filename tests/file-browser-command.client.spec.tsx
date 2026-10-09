// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createPaletteController } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import type { Panel, PaletteService, Picker, ItemId } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import { registerFileBrowser } from '../src/client/command-palette/install-file-browser.tsx'
import { browserZh } from '../src/client/command-palette/FileBrowser.tsx'
import type { WorkspaceAdapter } from '../src/client/command-palette/provider.ts'
import type { BrowserRequest, BrowserResult } from '../src/shared/file-browser.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => vi.unstubAllGlobals())

describe('file browser palette panel', () => {
  it('uses the real controller to enter a non-first workspace and restore Picker query/selection across Back and reentry', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
    const inputActions = { captureInsertion: vi.fn(() => ({})), insertReference: vi.fn(() => true), focus: vi.fn() }
    const call = vi.fn(async () => ({ ok: true, value: { kind: 'directory', entries: [], truncated: false } }))
    const ctx = { locale: { getSnapshot: () => ({ active: 'en' }) },
      get: (name: string) => name === 'uiSession'
        ? { adapter: { current: { getSnapshot: () => ({ key: 'original', props: { inputActions } }) } } }
        : { rpc: { call } } } as unknown as Context
    const workspaces: WorkspaceAdapter = {
      getSnapshot: () => ({ phase: 'ready', items: ['first', 'second'].map(id => ({ workspaceId: id,
        title: `Project ${id}`, displayTitle: `Project ${id}`, path: `/projects/${id}`, sessionIds: [] })) }),
      getCurrentSessionId: () => undefined, subscribe: () => () => {}, isConnected: () => true,
      createNewSession: vi.fn(async () => {}),
    }
    const palette = createPaletteController({ captureContext: () => ({}) })
    const off = registerFileBrowser(ctx, palette, workspaces)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    const render = () => root.render(palette.getSnapshot().panel?.render() ?? null)
    const unsubscribe = palette.subscribe(render)
    try {
      await act(async () => { palette.openCommands() })
      const command = palette.getSnapshot().rows.find(row => row.id === 'workspaces.find')!
      await act(async () => { await palette.accept(command.key) })
      expect(palette.getSnapshot().mode).toBe('picker')
      expect(inputActions.captureInsertion).not.toHaveBeenCalled()
      await act(async () => { palette.setQuery('Project') })
      const rows = palette.getSnapshot().rows
      expect(rows.map(row => row.id)).toEqual(['first', 'second'])
      const target = rows[1]!
      expect(palette.getSnapshot().selectedKey).toBe(rows[0]!.key)
      // Explicit row accept (click path), not a pre-selected first-row stub.
      await act(async () => { await palette.accept(target.key) })
      expect(palette.getSnapshot()).toMatchObject({ mode: 'panel', panelId: 'workspaces.browse-files' })
      expect(container.querySelector('header strong')?.textContent).toBe('Project second')
      expect(container.querySelector('[data-mode=picker]')).toBeNull()
      expect(call).toHaveBeenLastCalledWith('/enhanced-workspace', 'files/browse', { workspaceId: 'second', path: '' })
      expect(inputActions.captureInsertion).toHaveBeenCalledOnce()
      await act(async () => { palette.setQuery('file filter') })
      await act(async () => { expect(palette.back()).toBe(true) })
      expect(palette.getSnapshot()).toMatchObject({ mode: 'picker', query: 'Project', selectedKey: target.key })
      expect(container.querySelector('[role=tree]')).toBeNull()
      expect(inputActions.focus).toHaveBeenCalledOnce()
      // Old component cleanup must not destroy the new Panel bridge on reentry.
      await act(async () => { await palette.accept() })
      expect(container.querySelector('header strong')?.textContent).toBe('Project second')
      expect(palette.getSnapshot().panel?.actionsTargetLabel).toBe('/projects/second/')
      expect(inputActions.captureInsertion).toHaveBeenCalledTimes(2)
      await act(async () => { palette.back() })
      expect(palette.getSnapshot()).toMatchObject({ mode: 'picker', query: 'Project', selectedKey: target.key })
      expect(workspaces.createNewSession).not.toHaveBeenCalled()
    } finally {
      unsubscribe(); await act(async () => { root.unmount(); palette.close(); off(); palette.dispose() }); container.remove()
    }
  })
  it('accepts files directly, guards stale insertion, inserts the root through Actions and returns directly to workspace search', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
    let panel!: Panel
    let picker!: Picker
    const command = vi.fn(() => vi.fn()), remove = vi.fn(), close = vi.fn(), openPanelActions = vi.fn()
    const palette = { registerPicker: (value: Picker) => { picker = value; return vi.fn() }, openPanel: () => { const dispose = panel.onOpen!(executeArgs); if (typeof dispose === 'function') exit = dispose; return true }, registerCommand: command, registerPanel: (value: Panel) => { panel = value; return remove }, close, openPanelActions } as unknown as PaletteService
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
      expect(command).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'picker', pickerId: 'workspaces.find' } }))
      // Picker actions work before any tree RPC and capture insertion at actions entry.
      const workspaceActions = picker.getActions!('other' as ItemId, executeArgs)
      expect(workspaceActions.map(action => action.id)).toEqual(['create-new-session', 'insert-reference', 'insert-path-reference', 'copy-absolute-path'])
      expect(workspaceActions[1]!.title).toBe(browserZh.insertWorkspace)
      expect(workspaceActions[2]!.title).toBe(browserZh.insertPath)
      expect(await workspaceActions[0]!.execute(executeArgs)).toEqual({ kind: 'completed' })
      expect(createNewSession).toHaveBeenLastCalledWith('other', executeArgs.signal)
      expect(call).not.toHaveBeenCalled()
      // Creating a session leaves focus to the host; a reference insertion hands
      // the keyboard back to the composer so the caret lands after the chip
      // instead of at the draft start (the Modal's closing bare focus).
      expect(inputActions.focus).not.toHaveBeenCalled()
      expect(await workspaceActions[1]!.execute(executeArgs)).toEqual({ kind: 'completed' })
      expect(inputActions.focus).toHaveBeenCalledTimes(1)
      const workspaceRef = `@workspace-ref/${Buffer.from(JSON.stringify({ id: 'other', label: 'Other' })).toString('base64url')}`
      expect(inputActions.insertReference).toHaveBeenCalledWith({ source: 'reference', ref: workspaceRef,
        label: 'Other', appearance: 'folder', clipboardText: workspaceRef }, span)
      expect(await workspaceActions[2]!.execute(executeArgs)).toEqual({ kind: 'completed' })
      expect(inputActions.focus).toHaveBeenCalledTimes(2)
      expect(inputActions.insertReference).toHaveBeenLastCalledWith({ source: 'reference', ref: '@"/other project/',
        label: 'Other/', appearance: 'folder', clipboardText: '@"/other project/' }, span)
      key = 'changed'
      expect(await workspaceActions[2]!.execute(executeArgs)).toMatchObject({ kind: 'failed' })
      expect(await workspaceActions[1]!.execute(executeArgs)).toMatchObject({ kind: 'failed' })
      expect(inputActions.focus).toHaveBeenCalledTimes(2) // failed insertions never steal the keyboard
      key = 'original'; inputActions.insertReference.mockClear()
      expect(await picker.accept('other' as ItemId, executeArgs)).toEqual({ kind: 'stay' })
      const render = () => root.render(panel.render())
      unsubscribe = panel.subscribe(render)
      await act(async () => render())
      expect(inputActions.captureInsertion).toHaveBeenCalledTimes(2)
      expect(container.querySelector('input:not([type=checkbox])')).toBeNull()
      expect(container.querySelector('[role=dialog]')).toBeNull()
      expect(call).toHaveBeenCalledWith('/enhanced-workspace', 'files/browse', { workspaceId: 'other', path: '' })
      expect(container.querySelector('[data-stage=tree]')).not.toBeNull()
      expect(panel.getSnapshot()).toMatchObject({ scrollMode: 'contained', width: 'compact', canAccept: false })
      expect(container.querySelector('[data-mode=picker]')).toBeNull()
      expect(container.querySelector('[data-reference-footer]')).toBeNull()
      // Root Actions follow the shared convention: inserts first, copy last, view toggles last.
      expect(panel.getActions!().map(action => action.id)).toEqual(['create-new-session', 'insert-workspace-reference',
        'insert-reference', 'copy-absolute-path', 'toggle-hidden-files', 'toggle-content-preview'])
      await act(async () => { expect(await panel.getActions!().find(action => action.id === 'insert-reference')!.execute(executeArgs)).toEqual({ kind: 'completed' }) })
      expect(inputActions.insertReference).toHaveBeenLastCalledWith({ source: 'reference', ref: '@"/other project/',
        label: 'Other/', appearance: 'folder', clipboardText: '@"/other project/' }, span)
      const rootWorkspaceAction = panel.getActions!().find(action => action.id === 'insert-workspace-reference')!
      expect(rootWorkspaceAction.title).toBe(browserZh.insertWorkspace)
      expect(await rootWorkspaceAction.execute(executeArgs)).toEqual({ kind: 'completed' })
      expect(inputActions.insertReference).toHaveBeenLastCalledWith({ source: 'reference', ref: workspaceRef,
        label: 'Other', appearance: 'folder', clipboardText: workspaceRef }, span)
      expect(close).not.toHaveBeenCalled() // The palette closes Actions returning completed.
      inputActions.insertReference.mockClear(); close.mockClear()

      await select('src')
      expect(panel.getSnapshot()).toMatchObject({ acceptLabel: browserZh.openDirectory, canAccept: true })
      expect(container.querySelector('[role=treeitem][aria-expanded=true]')).not.toBeNull()
      expect(await panel.getActions!().find(action => action.id === 'insert-reference')!.execute(executeArgs)).toEqual({ kind: 'completed' })
      expect(inputActions.insertReference).toHaveBeenLastCalledWith({ source: 'reference', ref: '@"/other project/src/',
        label: 'src/', appearance: 'folder', clipboardText: '@"/other project/src/' }, span)
      inputActions.insertReference.mockClear()
      await accept()
      expect(container.querySelector('[role=treeitem][aria-expanded=false]')).not.toBeNull()
      expect(inputActions.insertReference).not.toHaveBeenCalled()
      await select('a.ts')
      expect(container.querySelector('[data-stage=tree]')).not.toBeNull()
      expect(container.querySelector('[data-stage=preview]')).toBeNull()
      expect(container.querySelector('section[data-file-preview]')).not.toBeNull()
      expect(panel.getSnapshot()).toMatchObject({ width: 'compact', acceptLabel: browserZh.insert, canAccept: true })
      const actions = panel.getActions!()
      expect(actions.map(action => action.id)).toEqual(['create-new-session', 'insert-reference', 'copy-absolute-path', 'toggle-hidden-files', 'toggle-content-preview'])
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
      expect(await actions.find(action => action.id === 'insert-reference')!.execute(executeArgs)).toMatchObject({ kind: 'failed' })
      key = 'original'
      await accept() // The palette routes Enter to the panel accept handler.
      expect(inputActions.insertReference).toHaveBeenCalledOnce()
      expect(inputActions.insertReference).toHaveBeenCalledWith({ source: 'reference', ref: '@"/other project/a.ts"', label: 'a.ts', appearance: 'file', clipboardText: '@"/other project/a.ts"' }, span)
      expect(close).toHaveBeenCalledOnce()
      expect(openPanelActions).not.toHaveBeenCalled()

      await act(async () => panel.onQuery('a.ts'))
      expect(panel.getSnapshot().query).toBe('a.ts')
      expect(panel.back!()).toBe(false) // CMD owns restoring the Picker frame.
      expect(container.querySelector('[data-mode=picker]')).toBeNull()
      expect(panel.getSnapshot().query).toBe('a.ts')
      exit?.(); exit = undefined
      expect(await actions[2]!.execute(executeArgs)).toEqual({ kind: 'cancelled' })
      expect(await actions[3]!.execute(executeArgs)).toEqual({ kind: 'cancelled' })
      expect(await actions[4]!.execute(executeArgs)).toEqual({ kind: 'cancelled' })
    } finally {
      unsubscribe?.(); await act(async () => root.unmount()); container.remove(); exit?.(); off()
    }
    // Two picker-side insertions handed the keyboard back; the panel close
    // handback (dispose) is the third.
    expect(inputActions.focus).toHaveBeenCalledTimes(3)
    expect(remove).toHaveBeenCalledOnce()
  })
  it('guards direct panel access and accepts navigation even when openPanel aborts its signal', async () => {
    let panel!: Panel; let picker!: Picker; let exit: (() => void) | undefined
    const captureInsertion = vi.fn(() => ({})), insertReference = vi.fn(() => true)
    const clipboard = vi.fn(async () => {})
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
    let items = [{ workspaceId: 'one', title: 'One', displayTitle: 'One', path: '/one', sessionIds: [] }]
    const controller = new AbortController()
    const args = { context: {}, signal: controller.signal }
    const openPanel = vi.fn(() => {
      controller.abort()
      const dispose = panel.onOpen!({ context: {}, signal: new AbortController().signal })
      if (typeof dispose === 'function') exit = dispose
      return true
    })
    const palette = { registerPanel: (value: Panel) => { panel = value; return vi.fn() },
      registerPicker: (value: Picker) => { picker = value; return vi.fn() }, registerCommand: () => vi.fn(), openPanel } as unknown as PaletteService
    const ctx = { locale: { getSnapshot: () => ({ active: 'en' }) },
      get: () => ({ adapter: { current: { getSnapshot: () => ({ key: 'composer', props: { inputActions: { captureInsertion, insertReference } } }) } } }) } as unknown as Context
    const workspaces = { getSnapshot: () => ({ phase: 'ready', items }), isConnected: () => true,
      subscribe: () => () => {}, createNewSession: vi.fn(async () => {}) } as unknown as WorkspaceAdapter
    const off = registerFileBrowser(ctx, palette, workspaces)
    try {
      expect(panel.onOpen!(args)).toBeUndefined()
      expect(captureInsertion).not.toHaveBeenCalled()
      expect(panel.getActions!()).toEqual([])
      expect(await picker.accept('missing' as ItemId, args)).toMatchObject({ kind: 'failed' })
      expect(openPanel).not.toHaveBeenCalled()
      const actions = picker.getActions!('one' as ItemId, args)
      expect(await actions[3]!.execute(args)).toEqual({ kind: 'stay' })
      expect(clipboard).toHaveBeenCalledWith('/one/')
      items = []
      expect(await actions[2]!.execute(args)).toEqual({ kind: 'cancelled' })
      expect(insertReference).not.toHaveBeenCalled()
      items = [{ workspaceId: 'one', title: 'One', displayTitle: 'One', path: '/one', sessionIds: [] }]
      expect(await picker.accept('one' as ItemId, args)).toEqual({ kind: 'stay' })
      expect(controller.signal.aborted).toBe(true)
      expect(openPanel).toHaveBeenCalledOnce()
      expect(await picker.accept('one' as ItemId, args)).toEqual({ kind: 'cancelled' })
      exit?.(); exit = undefined
      expect(panel.onOpen!({ ...args, signal: new AbortController().signal })).toBeUndefined()
      expect(panel.getActions!()).toEqual([])
    } finally { exit?.(); off() }
  })
  it('does not advertise an unsupported command on old palette versions', () => {
    const registerCommand = vi.fn()
    registerFileBrowser({} as Context, { registerCommand } as unknown as PaletteService, {} as WorkspaceAdapter)()
    expect(registerCommand).not.toHaveBeenCalled()
  })
})

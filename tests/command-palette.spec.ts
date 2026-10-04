import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createPaletteController } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import type { Command, ItemId, Picker, QueryBatch } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import installWorkspacePalette from '../src/client/command-palette/install.ts'
import { createWorkspacePicker, registerWorkspaceProvider, WORKSPACE_COMMAND_ID, WORKSPACE_PICKER_ID, workspaceTag, type WorkspaceAdapter, type WorkspaceRecord } from '../src/client/command-palette/provider.ts'

const row = (id: string, title: string, path = `/projects/${id}`, displayTitle = title): WorkspaceRecord => ({
  workspaceId: id, title, displayTitle, path, sessionIds: [id],
})
function fixture(items: WorkspaceRecord[] = []) {
  let phase = 'ready'
  let connected = true
  let current: string | undefined
  const openWorkspace = vi.fn(async () => {})
  const adapter: WorkspaceAdapter = {
    getSnapshot: () => ({ phase, items }), isConnected: () => connected,
    getCurrentSessionId: () => current, subscribe: vi.fn(() => vi.fn()), openWorkspace,
  }
  const picker = createWorkspacePicker(adapter)
  const controller = new AbortController()
  return { picker, adapter, openWorkspace, controller,
    setPhase: (value: string) => { phase = value },
    setConnected: (value: boolean) => { connected = value },
    setCurrent: (value: string) => { current = value },
    query: async (query = '', limit = 50): Promise<QueryBatch> => picker.query({ query, limit, signal: controller.signal, context: undefined }),
    accept: (id: string) => picker.accept(id as ItemId, { signal: controller.signal, context: undefined }),
  }
}

describe('workspace palette provider', () => {
  it('matches stored/display titles, basename and full path using every normalized token', async () => {
    const f = fixture([row('a', 'default-workspace', '/Users/me/project', '默认工作区'), row('b', 'Other', 'C:\\Dev\\Tools\\')])
    for (const query of ['默认 工作区', 'default-workspace', 'project', '/users/me/project', 'ＤＥＦＡＵＬＴ PROJECT']) {
      expect((await f.query(query)).items.map(x => x.id)).toEqual(['a'])
    }
    expect((await f.query('tools')).items.map(x => x.id)).toEqual(['b'])
    expect((await f.query('default absent')).items).toEqual([])
    expect((await f.query('默认')).items[0]?.label).toBe('默认工作区')
  })
  it('ranks each token exact, prefix, substring, subsequence and retains host ties', async () => {
    const f = fixture([row('subsequence', 'a-l-p-h-a'), row('substring', 'xalpha'), row('prefix', 'alphabet'), row('exact', 'alpha'), row('tie', 'alpha')])
    f.setCurrent('subsequence')
    expect((await f.query('ALPHA')).items.map(x => x.id)).toEqual(['exact', 'tie', 'prefix', 'substring', 'subsequence'])
    expect((await f.query()).items[0]?.id).toBe('subsequence')
    const multi = fixture([row('a', 'alpha', '/other/betatron'), row('b', 'alpha', '/other/beta')])
    expect((await multi.query('alpha beta')).items.map(x => x.id)).toEqual(['b', 'a'])
  })
  it('bounds results and reports hasMore', async () => {
    const f = fixture([row('a', 'A'), row('b', 'B')])
    expect(await f.query('', 1)).toMatchObject({ items: [{ id: 'a' }], hasMore: true })
    for (const limit of [-1, NaN, Infinity]) expect(await f.query('', limit)).toEqual({ items: [], hasMore: true })
  })
  it('distinguishes unavailable from an empty ready catalogue and rejects disconnected acceptance', async () => {
    const f = fixture([row('a', 'A')])
    f.setPhase('loading')
    await expect(f.query()).rejects.toThrow('尚未就绪')
    expect(await f.accept('a')).toMatchObject({ kind: 'failed' })
    f.setPhase('ready'); f.setConnected(false)
    await expect(f.query()).rejects.toThrow('连接已断开')
    expect(await f.accept('a')).toMatchObject({ kind: 'failed', message: '连接已断开' })
    expect(f.openWorkspace).not.toHaveBeenCalled()
    expect(await fixture().query()).toEqual({ items: [], hasMore: false })
  })
  it('rechecks membership, cancels before handoff, and never emits a success toast', async () => {
    const items = [row('a', 'A')]
    const f = fixture(items)
    await f.query(); items.length = 0
    expect(await f.accept('a')).toMatchObject({ kind: 'failed' })
    items.push(row('a', 'A'))
    expect(await f.accept('a')).toEqual({ kind: 'completed' })
    expect(f.openWorkspace).toHaveBeenCalledExactlyOnceWith('a')
    f.controller.abort()
    expect(await f.accept('a')).toEqual({ kind: 'cancelled' })
    expect(f.openWorkspace).toHaveBeenCalledTimes(1)
    expect(await f.query()).toEqual({ items: [], hasMore: false })
  })
  it('awaits navigation and reports rejected opens with workspace context and the original error', async () => {
    const f = fixture([row('a', 'A', '/missing/project')])
    let reject!: (error: Error) => void
    f.openWorkspace.mockImplementation(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let settled = false
      const accepted = Promise.resolve(f.accept('a')).then(result => { settled = true; return result })
      await Promise.resolve()
      expect(settled).toBe(false)
      const error = new Error('workspace directory does not exist')
      reject(error)
      expect(await accepted).toEqual({ kind: 'failed', message: error.message })
      expect(warn).toHaveBeenCalledExactlyOnceWith('dsh-enhanced-workspace: open workspace failed',
        { workspaceId: 'a', path: '/missing/project' }, error)
    } finally { warn.mockRestore() }
  })
  it('honors cancellation after navigation handoff without trying a second open', async () => {
    const f = fixture([row('a', 'A')])
    let finish!: () => void
    f.openWorkspace.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
    const accepted = f.accept('a')
    f.controller.abort()
    finish()
    expect(await accepted).toEqual({ kind: 'cancelled' })
    expect(f.openWorkspace).toHaveBeenCalledTimes(1)
  })
  it('registers stable IDs and releases contributions idempotently, including partial failure', () => {
    const removePicker = vi.fn(), removeCommand = vi.fn()
    const palette = { registerPicker: vi.fn(() => removePicker), registerCommand: vi.fn(() => removeCommand) }
    const f = fixture()
    const off = registerWorkspaceProvider(palette, f.adapter)
    expect(WORKSPACE_COMMAND_ID).toBe('workspaces.find')
    expect(palette.registerCommand).toHaveBeenCalledWith(expect.objectContaining({ id: WORKSPACE_COMMAND_ID, target: { kind: 'picker', pickerId: WORKSPACE_PICKER_ID } }))
    off(); off()
    expect(removePicker).toHaveBeenCalledTimes(1); expect(removeCommand).toHaveBeenCalledTimes(1)
    palette.registerCommand.mockImplementation(() => { throw new Error('duplicate') })
    expect(() => registerWorkspaceProvider(palette, f.adapter)).toThrow('duplicate')
    expect(removePicker).toHaveBeenCalledTimes(2)
  })
})

describe('two-layer palette compatibility', () => {
  it('searches across tag and child fields without leaking unrelated commands; accepts pure English and legacy rows', () => {
    let language = 'zh-CN'
    const controller = createPaletteController({ captureContext: () => undefined, getLocale: () => language })
    const action = { kind: 'action' as const, execute: () => ({ kind: 'completed' as const }) }
    controller.registerCommand({ id: 'workspace.switch' as Command['id'],
      describe: () => ({ title: '切换', localizedTitles: { zh: '切换', en: 'Switch' }, pluginTag: workspaceTag }), target: action })
    controller.registerCommand({ id: 'other.switch' as Command['id'],
      describe: () => ({ title: 'Switch', pluginTag: { id: 'other', title: 'Other' } }), target: action })
    controller.registerCommand({ id: 'english.open' as Command['id'],
      describe: () => ({ title: 'Open', localizedTitles: { en: 'Open' },
        pluginTag: { id: 'english', title: 'English', localizedTitles: { en: 'English' } } }), target: action })
    controller.registerCommand({ id: 'legacy.open' as Command['id'],
      describe: () => ({ title: 'Legacy Open', category: 'Legacy' }), target: action })
    try {
      controller.openCommands()
      for (const query of ['wsp swt', '工区 switch', '工作区 切换']) {
        controller.setQuery(query)
        expect(controller.getSnapshot().rows.map(row => row.id)).toEqual(['workspace.switch'])
      }
      for (const locale of ['zh-CN', 'en-US']) {
        language = locale
        controller.setQuery('english open')
        expect(controller.getSnapshot().rows).toMatchObject([{ label: 'Open', pluginTagLabel: 'English' }])
        expect(controller.getSnapshot().rows).toHaveLength(1)
        expect(controller.getSnapshot().rows[0]!.secondaryLabel).toBeUndefined()
        expect(controller.getSnapshot().rows[0]!.pluginTagSecondaryLabel).toBeUndefined()
        controller.setQuery('legacy')
        expect(controller.getSnapshot().rows).toMatchObject([{ label: 'Legacy Open', detail: 'Legacy' }])
        expect(controller.getSnapshot().rows[0]!.pluginTagId).toBeUndefined()
      }
    } finally { controller.dispose() }
  })

  it('preserves picker entry/back navigation and detaches an active picker when the provider unloads', async () => {
    const f = fixture([row('a', 'A')])
    const offInvalidation = vi.fn()
    f.adapter.subscribe = vi.fn(() => offInvalidation)
    const controller = createPaletteController({ captureContext: () => undefined, getLocale: () => 'zh' })
    const off = registerWorkspaceProvider(controller, f.adapter)
    try {
      controller.openCommands()
      controller.setQuery('wsp swt')
      const key = controller.getSnapshot().rows[0]!.key
      expect(controller.getSnapshot().rows[0]).toMatchObject({ iconId: 'open', pluginTagIconId: 'workspace' })
      await controller.accept(key)
      expect(controller.getSnapshot()).toMatchObject({ mode: 'picker', pickerId: WORKSPACE_PICKER_ID, canGoBack: true })
      expect(controller.getSnapshot().rows).toMatchObject([{ id: 'a', label: 'A' }])
      const assertResourceIcons = () => {
        expect(controller.getSnapshot().rows).toHaveLength(1)
        for (const resource of controller.getSnapshot().rows) {
          expect(resource.iconId).toBeUndefined()
          expect(resource.pluginTagIconId).toBeUndefined()
          expect(resource.icon).toBeUndefined()
        }
      }
      assertResourceIcons()
      controller.close()
      expect(controller.openPicker(WORKSPACE_PICKER_ID)).toBe(true)
      assertResourceIcons() // Direct quick-open must not inherit the tag either.
      controller.close()
      controller.openCommands()
      controller.setQuery('wsp swt')
      await controller.accept(key)
      assertResourceIcons()
      expect(controller.back()).toBe(true)
      expect(controller.getSnapshot()).toMatchObject({ mode: 'commands', query: 'wsp swt', selectedKey: key })
      expect(offInvalidation).toHaveBeenCalledTimes(3)
      await controller.accept(key)
      off(); off()
      expect(offInvalidation).toHaveBeenCalledTimes(4)
      expect(controller.getSnapshot().rows).toEqual([])
      expect(f.openWorkspace).not.toHaveBeenCalled()
    } finally { off(); controller.dispose() }
  })
})

describe('optional palette installation', () => {
  it('waits for the optional service, reuses title owner/openWorkspace, invalidates and cleans up', async () => {
    let activate: ((ctx: Context) => void) | undefined
    const disposers: (() => void)[] = []
    let picker: Picker | undefined
    let command: Command | undefined
    const listeners: Record<'workspace' | 'session' | 'connection' | 'locale', () => void> = {
      workspace: vi.fn(), session: vi.fn(), connection: vi.fn(), locale: vi.fn(),
    }
    const off = { workspace: vi.fn(), session: vi.fn(), connection: vi.fn(), locale: vi.fn(), dictionary: vi.fn(), picker: vi.fn(), command: vi.fn() }
    let language = 'zh'
    let dictionaries: Record<string, Record<string, string>> = {}
    let connected = true
    const openWorkspace = vi.fn(async () => {}), refresh = vi.fn()
    const ctx = {
      inject: vi.fn((_keys, callback) => { activate = callback }),
      effect: (effect: () => () => void) => { disposers.push(effect()) },
      get: (key: string): unknown => key === 'commandPalette' ? ctx.commandPalette : ({ state: { getSnapshot: () => connected ? 'connected' : 'disconnected', subscribe: (fn: () => void) => { listeners.connection = fn; return off.connection } } }),
      locale: {
        register: (_ns: string, dict: typeof dictionaries) => { dictionaries = dict; return off.dictionary },
        bind: () => (key: string) => dictionaries[language]![key],
        subscribe: (fn: () => void) => { listeners.locale = fn; return off.locale },
      },
      workspaces: { list: { getSnapshot: () => ({ phase: 'ready', items: [row('default', 'default-workspace')] }), subscribe: (fn: () => void) => { listeners.workspace = fn; return off.workspace } } },
      sessions: { list: { getSnapshot: () => ({ byId: {} }), subscribe: (fn: () => void) => { listeners.session = fn; return off.session } } },
      uiWorkspace: { openWorkspace },
      commandPalette: {
        registerPicker: (value: Picker) => { picker = value; return off.picker },
        registerCommand: (value: Command) => { command = value; return off.command }, refresh,
      },
    }
    installWorkspacePalette(ctx as unknown as Context)
    expect(ctx.inject).toHaveBeenCalledWith(['commandPalette'], expect.any(Function))
    expect(picker).toBeUndefined()
    activate!(ctx as unknown as Context)
    expect(command!.id).toBe('workspaces.find')
    // Use the real cmd matcher: both languages must find one localized row.
    const controller = createPaletteController({ captureContext: () => undefined, getLocale: () => language })
    controller.registerPicker(picker!)
    controller.registerCommand(command!)
    controller.openCommands()
    const assertSearch = (title: string, category: string) => {
      const descriptor = command!.describe(undefined)
      expect(descriptor).toMatchObject({ title, category, iconId: 'open',
        localizedTitles: { zh: '切换工作区', en: 'Switch Workspace' },
        pluginTag: { id: 'workspace', title: 'Workspace', iconId: 'workspace', localizedTitles: { zh: '工作区', en: 'Workspace' } } })
      expect(descriptor.pluginTag).toBe(workspaceTag)
      expect(descriptor.title).not.toContain(' · ')
      for (const query of ['', '切换工作区', 'Switch Workspace', '工作区', 'Workspace',
        '搜索工作区', 'open workspace', '切换 workspace', 'switch 工作区',
        'wsp swt', '工区 switch', 'workspace', 'wsp', '工区', 'swt', 'workspaces.find']) {
        controller.setQuery(query)
        expect(controller.getSnapshot().rows).toMatchObject([{ id: WORKSPACE_COMMAND_ID, label: title, detail: category,
          iconId: 'open', pluginTagIconId: 'workspace' }])
        expect(controller.getSnapshot().rows).toHaveLength(1)
        const row = controller.getSnapshot().rows[0]!
        if (language === 'zh') {
          expect(row).toMatchObject({ secondaryLabel: 'Switch Workspace', secondaryLocale: 'en',
            pluginTagId: 'workspace', pluginTagLabel: '工作区', pluginTagSecondaryLabel: 'Workspace' })
        } else {
          expect(row).toMatchObject({ pluginTagId: 'workspace', pluginTagLabel: 'Workspace' })
          expect(row.secondaryLabel).toBeUndefined()
          expect(row.secondaryLocale).toBeUndefined()
          expect(row.pluginTagSecondaryLabel).toBeUndefined()
        }
      }
      controller.setQuery('unrelated')
      expect(controller.getSnapshot().rows).toEqual([])
    }
    assertSearch('切换工作区', '工作区')
    const args = { query: '', limit: 10, context: undefined, signal: new AbortController().signal }
    expect((await picker!.query(args)).items[0]?.label).toBe('默认工作区')
    language = 'en'; listeners.locale()
    expect(refresh).toHaveBeenCalledOnce()
    controller.refresh()
    assertSearch('Switch Workspace', 'Workspace')
    controller.dispose()
    expect((await picker!.query(args)).items[0]?.label).toBe('Default Workspace')
    const invalidate = vi.fn()
    const unsubscribe = picker!.subscribeInvalidation!(invalidate)
    listeners.workspace(); listeners.session(); listeners.connection()
    expect(invalidate).toHaveBeenCalledTimes(3)
    expect(await picker!.accept('default' as ItemId, args)).toEqual({ kind: 'completed' })
    expect(openWorkspace).toHaveBeenCalledExactlyOnceWith('default')
    connected = false
    expect(await picker!.accept('default' as ItemId, args)).toMatchObject({ kind: 'failed' })
    unsubscribe(); disposers.reverse().forEach(dispose => dispose())
    for (const dispose of Object.values(off)) expect(dispose).toHaveBeenCalledOnce()
  })
})

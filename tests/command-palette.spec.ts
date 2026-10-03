import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Command, ItemId, Picker, QueryBatch } from '@deepseek-ai/dsh-client-ui-command-palette/core'
import installWorkspacePalette from '../src/client/command-palette/install.ts'
import { createWorkspacePicker, registerWorkspaceProvider, WORKSPACE_COMMAND_ID, WORKSPACE_PICKER_ID, type WorkspaceAdapter, type WorkspaceRecord } from '../src/client/command-palette/provider.ts'

const row = (id: string, title: string, path = `/projects/${id}`, displayTitle = title): WorkspaceRecord => ({
  workspaceId: id, title, displayTitle, path, sessionIds: [id],
})
function fixture(items: WorkspaceRecord[] = []) {
  let phase = 'ready'
  let connected = true
  let current: string | undefined
  const startSession = vi.fn()
  const adapter: WorkspaceAdapter = {
    getSnapshot: () => ({ phase, items }), isConnected: () => connected,
    getCurrentSessionId: () => current, subscribe: vi.fn(() => vi.fn()), startSession,
  }
  const picker = createWorkspacePicker(adapter)
  const controller = new AbortController()
  return { picker, adapter, startSession, controller,
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
    expect(f.startSession).not.toHaveBeenCalled()
    expect(await fixture().query()).toEqual({ items: [], hasMore: false })
  })
  it('rechecks membership, cancels before handoff, and never reports navigation settlement or a success toast', async () => {
    const items = [row('a', 'A')]
    const f = fixture(items)
    await f.query(); items.length = 0
    expect(await f.accept('a')).toMatchObject({ kind: 'failed' })
    items.push(row('a', 'A'))
    expect(await f.accept('a')).toEqual({ kind: 'completed' })
    expect(f.startSession).toHaveBeenCalledExactlyOnceWith('a')
    f.controller.abort()
    expect(await f.accept('a')).toEqual({ kind: 'cancelled' })
    expect(f.startSession).toHaveBeenCalledTimes(1)
    expect(await f.query()).toEqual({ items: [], hasMore: false })
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

describe('optional palette installation', () => {
  it('waits for the optional service, reuses title owner/startSession, invalidates and cleans up', async () => {
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
    const startSession = vi.fn(), refresh = vi.fn()
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
      uiWorkspace: { startSession },
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
    const args = { query: '', limit: 10, context: undefined, signal: new AbortController().signal }
    expect((await picker!.query(args)).items[0]?.label).toBe('默认工作区')
    language = 'en'; listeners.locale()
    expect(refresh).toHaveBeenCalledOnce()
    expect((await picker!.query(args)).items[0]?.label).toBe('Default Workspace')
    const invalidate = vi.fn()
    const unsubscribe = picker!.subscribeInvalidation!(invalidate)
    listeners.workspace(); listeners.session(); listeners.connection()
    expect(invalidate).toHaveBeenCalledTimes(3)
    expect(await picker!.accept('default' as ItemId, args)).toEqual({ kind: 'completed' })
    expect(startSession).toHaveBeenCalledExactlyOnceWith('default')
    connected = false
    expect(await picker!.accept('default' as ItemId, args)).toMatchObject({ kind: 'failed' })
    unsubscribe(); disposers.reverse().forEach(dispose => dispose())
    for (const dispose of Object.values(off)) expect(dispose).toHaveBeenCalledOnce()
  })
})

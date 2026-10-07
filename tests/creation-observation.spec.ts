import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPaletteSession } from '../src/client/command-palette/create-session.ts'
import type { CreationObservation } from '../src/client/command-palette/creation-observation.ts'

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
function fixture() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const ready = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  const observation = { create: vi.fn(async () => 'fresh'), whenOpened: vi.fn((_id: string, _signal: AbortSignal) => ready), phase: vi.fn(), end: vi.fn(async () => {}) } satisfies CreationObservation<string>
  const actions = { workspaceId: 'private-workspace', create: vi.fn(async () => 'fallback'), validateNavigation: vi.fn(), open: vi.fn(), observeCreation: vi.fn(async (): Promise<CreationObservation<string> | undefined> => observation) }
  const controller = new AbortController()
  return { actions, observation, controller, reject, resolve, run: () => createPaletteSession(actions, controller.signal) }
}
afterEach(() => vi.useRealTimers())
describe('optional scoped creation observation', () => {
  it('uses one observed create, navigates first, and finishes only on actual open state', async () => {
    const f = fixture(); await f.run()
    expect(f.actions.create).not.toHaveBeenCalled()
    expect(f.observation.create).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'private-workspace' })
    expect(f.actions.open).toHaveBeenCalledExactlyOnceWith('fresh')
    expect(f.observation.whenOpened.mock.invocationCallOrder[0]).toBeLessThan(f.actions.open.mock.invocationCallOrder[0]!)
    expect(f.observation.end).not.toHaveBeenCalled()
    f.controller.abort(); f.resolve(); await flush()
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('success')
    expect(f.observation.phase.mock.calls.map(call => call[0])).toEqual(['command.navigation', 'command.entryToReady'])
    expect(JSON.stringify(f.observation.phase.mock.calls)).not.toContain('private-workspace')
  })
  it.each(['error', 'closed'])('does not mistake a settled %s initial open for success', async state => {
    const f = fixture(); await f.run(); f.reject(new Error(state)); await flush()
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('error')
  })
  it('bounds readiness waiting without cancelling navigation and ignores late completion', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.run()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('timeout')
    f.resolve(); await flush()
    expect(f.observation.end).toHaveBeenCalledOnce()
    expect(f.actions.open).toHaveBeenCalledOnce()
  })
  it('falls back if capability transport is unavailable', async () => {
    const f = fixture(); f.actions.observeCreation.mockRejectedValue(new Error('unavailable'))
    await f.run()
    expect(f.actions.create).toHaveBeenCalledOnce()
    expect(f.actions.open).toHaveBeenCalledExactlyOnceWith('fallback')
    expect(f.observation.whenOpened).not.toHaveBeenCalled()
  })
  it('does not retry observed business failure and preserves its exact error', async () => {
    const f = fixture(); const error = new Error('private-failure')
    f.observation.create.mockRejectedValue(error)
    await expect(f.run()).rejects.toBe(error)
    expect(f.actions.create).not.toHaveBeenCalled()
    expect(f.actions.open).not.toHaveBeenCalled()
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('error')
  })
  it('cancels before observed creation when abort arrives during capability acquisition', async () => {
    const f = fixture(); const pending = f.run(); f.controller.abort(); await pending
    expect(f.observation.create).not.toHaveBeenCalled()
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('cancelled')
  })
  it('commits but does not navigate when cancelled during creation', async () => {
    const f = fixture(); f.observation.create.mockImplementation(async () => { f.controller.abort(); return 'committed' })
    await f.run()
    expect(f.actions.open).not.toHaveBeenCalled()
    expect(f.observation.whenOpened).not.toHaveBeenCalled()
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('cancelled')
  })
  it('keeps navigation result when all diagnostic hooks fail', async () => {
    const f = fixture()
    f.observation.phase.mockImplementation(() => { throw new Error('diagnostic') })
    f.observation.whenOpened.mockImplementation(() => { throw new Error('diagnostic') })
    f.observation.end.mockRejectedValue(new Error('transport'))
    await expect(f.run()).resolves.toBeUndefined(); await flush()
    expect(f.actions.open).toHaveBeenCalledOnce()
  })
  it('aborts only the diagnostic wait if navigation throws and preserves the business error', async () => {
    const f = fixture(); const error = new Error('navigation failure')
    f.actions.open.mockImplementation(() => { throw error })
    await expect(f.run()).rejects.toBe(error)
    const diagnosticSignal = f.observation.whenOpened.mock.calls[0]![1]
    expect(diagnosticSignal.aborted).toBe(true)
    expect(f.controller.signal.aborted).toBe(false)
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('error')
    f.resolve(); await flush()
    expect(f.observation.end).toHaveBeenCalledOnce()
  })
  it('clears the deadline on success instead of emitting a later timeout', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.run(); f.resolve(); await flush()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('success')
    expect(f.observation.whenOpened.mock.calls[0]![1].aborted).toBe(false)
  })
  it('bounds the diagnostic waiter without aborting the business command', async () => {
    vi.useFakeTimers(); const f = fixture(); await f.run()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(f.observation.whenOpened.mock.calls[0]![1].aborted).toBe(true)
    expect(f.controller.signal.aborted).toBe(false)
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('timeout')
  })
  it('reports V2 relative intervals with navigation success independent of later opening error', async () => {
    const f = fixture()
    let clock = 0
    const interval = vi.fn()
    f.actions.observeCreation.mockResolvedValue({ ...f.observation, version: 2, mark: () => clock, interval })
    f.observation.create.mockImplementation(async () => { clock = 20; return 'fresh' })
    f.actions.open.mockImplementation(() => { clock = 25 })
    await f.run(); clock = 70; f.reject(new Error('opening failed')); await flush()
    expect(interval.mock.calls).toEqual([
      ['command.navigation', 20, 25, 'success'],
      ['command.entryToReady', 0, 70, 'error'],
    ])
    expect(f.observation.phase).not.toHaveBeenCalled()
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith('error')
  })
  it('includes the V2 begin round trip in entry-to-ready without shifting other phases', async () => {
    const f = fixture(); let clock = 0; const interval = vi.fn()
    f.actions.observeCreation.mockResolvedValue({ ...f.observation, version: 2, beginDurationMs: 12, mark: () => clock, interval })
    f.observation.create.mockImplementation(async () => { clock = 20; return 'fresh' })
    await f.run(); clock = 35; f.resolve(); await flush()
    expect(interval.mock.calls).toEqual([
      ['command.navigation', 20, 20, 'success'],
      ['command.entryToReady', -12, 35, 'success'],
    ])
  })
  it.each(['cancelled', 'timeout'] as const)('preserves structured %s opening classification without logging the error', async outcome => {
    const f = fixture(); await f.run()
    f.reject(Object.assign(new Error('private diagnostic'), { outcome })); await flush()
    expect(f.observation.end).toHaveBeenCalledExactlyOnceWith(outcome)
    expect(JSON.stringify(f.observation.phase.mock.calls)).not.toContain('private diagnostic')
  })
  it('reports V2 cancellation after creation without navigating', async () => {
    const f = fixture(); const interval = vi.fn(); let clock = 0
    f.actions.observeCreation.mockResolvedValue({ ...f.observation, version: 2, mark: () => clock, interval })
    f.observation.create.mockImplementation(async () => { clock = 10; f.controller.abort(); return 'fresh' })
    await f.run()
    expect(interval).toHaveBeenCalledExactlyOnceWith('command.entryToReady', 0, 10, 'cancelled')
    expect(f.actions.open).not.toHaveBeenCalled()
  })
  it('isolates concurrent readiness and rejection', async () => {
    const a = fixture(), b = fixture(); await Promise.all([a.run(), b.run()])
    b.reject(new Error('private')); a.resolve(); await flush()
    expect(a.observation.end).toHaveBeenCalledExactlyOnceWith('success')
    expect(b.observation.end).toHaveBeenCalledExactlyOnceWith('error')
    expect(a.observation.whenOpened).toHaveBeenCalledOnce(); expect(b.observation.whenOpened).toHaveBeenCalledOnce()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { createPaletteSession } from '../src/client/command-palette/create-session.ts'

function fixture() {
  const actions = { create: vi.fn(async () => 'fresh'), validateNavigation: vi.fn(), open: vi.fn() }
  const controller = new AbortController()
  return { actions, controller, run: () => createPaletteSession(actions, controller.signal) }
}

describe('palette session command lifecycle', () => {
  it('creates once, validates after commitment, then opens the exact identity', async () => {
    const f = fixture()
    await f.run()
    expect(f.actions.create).toHaveBeenCalledOnce()
    expect(f.actions.validateNavigation).toHaveBeenCalledOnce()
    expect(f.actions.open).toHaveBeenCalledExactlyOnceWith('fresh')
    expect(f.actions.create.mock.invocationCallOrder[0]).toBeLessThan(f.actions.validateNavigation.mock.invocationCallOrder[0]!)
    expect(f.actions.validateNavigation.mock.invocationCallOrder[0]).toBeLessThan(f.actions.open.mock.invocationCallOrder[0]!)
  })
  it('does no work when cancelled before creation', async () => {
    const f = fixture(); f.controller.abort(); await f.run()
    expect(f.actions.create).not.toHaveBeenCalled()
    expect(f.actions.open).not.toHaveBeenCalled()
  })
  it('lets committed creation finish but does not navigate after cancellation', async () => {
    const f = fixture()
    let resolve!: (id: string) => void
    f.actions.create.mockImplementation(() => new Promise(done => { resolve = done }))
    const pending = f.run(); f.controller.abort(); resolve('committed')
    await pending
    expect(f.actions.create).toHaveBeenCalledOnce()
    expect(f.actions.validateNavigation).not.toHaveBeenCalled()
    expect(f.actions.open).not.toHaveBeenCalled()
  })
  it.each(['create', 'validateNavigation', 'open'] as const)('preserves the original %s failure without retry', async phase => {
    const f = fixture(); const error = new Error('private diagnostic')
    f.actions[phase].mockImplementation(() => { throw error })
    await expect(f.run()).rejects.toBe(error)
    expect(f.actions.create).toHaveBeenCalledOnce()
    if (phase !== 'open') expect(f.actions.open).not.toHaveBeenCalled()
  })
})

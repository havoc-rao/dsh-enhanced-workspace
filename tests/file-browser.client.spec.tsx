// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkspaceFileBrowser, browserZh, absoluteBrowserPath, fileMention, type FileBrowserAdapter } from '../src/client/command-palette/FileBrowser.tsx'
import type { BrowserResult } from '../src/shared/file-browser.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const previewDelay = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 175)) })
const viewport = (narrow = false) => vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
  matches: narrow && query === '(max-width: 720px)', media: query,
  addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(),
})))
const fixture = (): FileBrowserAdapter => ({
  workspaces: () => [
    { workspaceId: 'other', title: 'Other', displayTitle: 'Other', path: '/projects/other', sessionIds: [] },
    { workspaceId: 'second', title: 'Second', displayTitle: 'Second', path: '/projects/second', sessionIds: [] },
  ],
  subscribe: () => () => {}, copy: vi.fn(async () => {}), insert: vi.fn(() => true),
  browse: vi.fn(async ({ path, preview }): Promise<BrowserResult> => preview
    ? { kind: 'file', text: 'export const answer = 42', truncated: false }
    : { kind: 'directory', entries: path ? [{ name: 'a.ts', path: 'src/a.ts', directory: false }]
      : [{ name: 'src', path: 'src', directory: true }, { name: '.hidden', path: '.hidden', directory: false }], truncated: false }),
})
const mount = async (adapter: FileBrowserAdapter) => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); const close = vi.fn()
  await act(async () => { root.render(<WorkspaceFileBrowser adapter={adapter} text={browserZh} close={close} />) })
  const click = async (label: string) => {
    const buttons = [...container.querySelectorAll('button')]
    const button = buttons.find(button => button.getAttribute('aria-label') === label)
      ?? buttons.filter(button => button.textContent === label).at(-1)
      ?? buttons.find(button => button.textContent?.includes(label))
    expect(button, label).toBeTruthy()
    await act(async () => { button!.click() })
  }
  return { container, close, click, dispose: async () => { await act(async () => { root.unmount() }); container.remove() } }
}

afterEach(() => vi.unstubAllGlobals())

describe('workspace file browser UI', () => {
  it('joins absolute cross-project paths and quotes spaces', () => {
    expect(absoluteBrowserPath('/projects/app/', 'src/a.ts')).toBe('/projects/app/src/a.ts')
    expect(absoluteBrowserPath('C:\\Dev\\app', 'src/a.ts')).toBe('C:\\Dev\\app\\src\\a.ts')
    expect(fileMention('/projects/my app/a.ts', false)).toBe('@"/projects/my app/a.ts"')
    expect(fileMention('/projects/app/src', true)).toBe('@/projects/app/src/')
  })
  it('keeps the tree visible while selecting, previewing, copying and inserting a file', async () => {
    viewport()
    const adapter = fixture(); vi.mocked(adapter.insert).mockReturnValue(false)
    const view = await mount(adapter)
    const { container, close, click } = view
    try {
      expect(container.querySelector('[data-stage=workspace]')).not.toBeNull()
      expect(container.querySelector('[role=tree]')).toBeNull()
      expect(container.querySelector('section[data-file-preview]')).toBeNull()
      expect(adapter.browse).not.toHaveBeenCalled()
      await click('Other')
      expect(container.querySelector('[data-stage=tree]')).not.toBeNull()
      const header = container.querySelector('header')!
      expect(header.querySelector('strong')?.textContent).toBe('Other')
      expect(header.querySelector('small')?.textContent).toBe('/projects/other')
      expect(header.querySelector('small')?.title).toBe('/projects/other')
      expect(container.textContent).not.toContain('.hidden')
      expect(container.querySelector('section[data-file-preview]')).toBeNull()
      expect(container.querySelector('[data-reference-footer]')).toBeNull()
      expect(container.querySelector(`button[aria-label="${browserZh.togglePreview}"]`)?.getAttribute('aria-pressed')).toBe('true')
      await click('src')
      expect(container.querySelector('[role=treeitem][aria-expanded=true]')).not.toBeNull()
      await click('src')
      expect(container.querySelector('[role=treeitem][aria-expanded=false]')).not.toBeNull()
      await click('src')
      expect(vi.mocked(adapter.browse).mock.calls.filter(([request]) => request.path === 'src')).toHaveLength(1)
      await click('a.ts')
      expect(container.querySelector('[data-stage=tree]')).not.toBeNull()
      expect(container.querySelector('[data-stage=preview]')).toBeNull()
      expect(container.querySelector('[role=tree]')).not.toBeNull()
      expect(container.querySelector('section[data-file-preview]')).not.toBeNull()
      expect(container.querySelector('[data-reference-footer]')).toBeNull()
      expect(vi.mocked(adapter.browse).mock.calls.filter(([request]) => request.preview)).toHaveLength(0)
      await previewDelay()
      expect(container.textContent).toContain('export const answer = 42')
      await click(`${browserZh.copy}: a.ts`)
      expect(adapter.copy).toHaveBeenCalledWith('/projects/other/src/a.ts')
      await click(`${browserZh.insert}: a.ts`)
      expect(adapter.insert).toHaveBeenCalledWith('/projects/other/src/a.ts', false, 'a.ts')
      expect(container.textContent).toContain(browserZh.stale)
      expect(close).not.toHaveBeenCalled()
      vi.mocked(adapter.insert).mockReturnValue(true)
      await click(`${browserZh.insert}: a.ts`)
      expect(adapter.insert).toHaveBeenLastCalledWith('/projects/other/src/a.ts', false, 'a.ts')
      expect(close).toHaveBeenCalledOnce()
      await click('src')
      expect(container.querySelector('[data-stage=tree]')).not.toBeNull()
      expect(container.querySelector('section[data-file-preview]')).toBeNull()
      expect(container.querySelector('[data-mode=picker]')).toBeNull()
      expect(container.textContent).not.toContain('Second')
    } finally { await view.dispose() }
  })
  it('keeps the hidden-file checkbox as a standalone browser fallback', async () => {
    viewport()
    const view = await mount(fixture())
    try {
      await view.click('Other')
      const checkbox = view.container.querySelector<HTMLInputElement>('input[type=checkbox]')!
      expect(checkbox.checked).toBe(false)
      expect(view.container.querySelector('[data-path=".hidden"]')).toBeNull()
      await act(async () => checkbox.click())
      expect(checkbox.checked).toBe(true)
      expect(view.container.querySelector('[data-path=".hidden"]')).not.toBeNull()
      await act(async () => checkbox.click())
      expect(view.container.querySelector('[data-path=".hidden"]')).toBeNull()
    } finally { await view.dispose() }
  })
  it('inserts with Enter when the file row itself has focus, without waiting for preview', async () => {
    viewport()
    const adapter = fixture(); const view = await mount(adapter)
    try {
      await view.click('Other'); await view.click('src')
      const row = view.container.querySelector<HTMLButtonElement>('button[data-tree-main][data-path="src/a.ts"]')!
      await act(async () => {
        row.focus()
        row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      })
      expect(adapter.insert).toHaveBeenCalledOnce()
      expect(adapter.insert).toHaveBeenCalledWith('/projects/other/src/a.ts', false, 'a.ts')
      expect(view.close).toHaveBeenCalledOnce()
      expect(vi.mocked(adapter.browse).mock.calls.filter(([request]) => request.preview)).toHaveLength(0)
    } finally { await view.dispose() }
  })
  it('defaults preview off on narrow viewports and remembers the toggle without extra preview RPCs', async () => {
    viewport(true)
    const adapter = fixture(); const view = await mount(adapter)
    const { container, click } = view
    const previewCalls = () => vi.mocked(adapter.browse).mock.calls.filter(([request]) => request.preview)
    try {
      await click('Other'); await click('src'); await click('a.ts')
      expect(container.querySelector(`button[aria-label="${browserZh.togglePreview}"]`)?.getAttribute('aria-pressed')).toBe('false')
      expect(container.querySelector('section[data-file-preview]')).toBeNull()
      await previewDelay()
      expect(previewCalls()).toHaveLength(0)
      await click(browserZh.togglePreview)
      expect(container.querySelector('section[data-file-preview]')).not.toBeNull()
      await previewDelay()
      expect(previewCalls()).toHaveLength(1)
      await click(browserZh.togglePreview)
      expect(container.querySelector('section[data-file-preview]')).toBeNull()
      await click('src'); await click('src'); await click('a.ts')
      await previewDelay()
      expect(container.querySelector(`button[aria-label="${browserZh.togglePreview}"]`)?.getAttribute('aria-pressed')).toBe('false')
      expect(previewCalls()).toHaveLength(1)
      await click(`${browserZh.insert}: a.ts`)
      expect(adapter.insert).toHaveBeenCalledWith('/projects/other/src/a.ts', false, 'a.ts')
    } finally { await view.dispose() }
  })
  it('shows preview failures inside the pane without blocking reference insertion', async () => {
    viewport()
    const adapter = fixture(); const browse = adapter.browse
    adapter.browse = vi.fn((request, signal) => request.preview ? Promise.reject(new Error('Preview unavailable')) : browse(request, signal))
    const view = await mount(adapter)
    try {
      await view.click('Other'); await view.click('src'); await view.click('a.ts'); await previewDelay()
      const pane = view.container.querySelector('section[data-file-preview]')!
      expect(pane.textContent).toContain('Preview unavailable')
      expect(view.container.querySelector('[role=tree]')).not.toBeNull()
      expect(view.container.querySelector('[data-stage=tree]')).not.toBeNull()
      await view.click(`${browserZh.insert}: a.ts`)
      expect(adapter.insert).toHaveBeenCalledWith('/projects/other/src/a.ts', false, 'a.ts')
      expect(view.close).toHaveBeenCalledOnce()
    } finally { await view.dispose() }
  })
  it('inserts the selected directory from its row without requesting a preview', async () => {
    viewport()
    const adapter = fixture(); const view = await mount(adapter)
    try {
      await view.click('Other'); await view.click('src')
      expect(view.container.querySelector('[data-reference-footer]')).toBeNull()
      expect(view.container.querySelector('section[data-file-preview]')).toBeNull()
      await view.click(`${browserZh.insert}: src`)
      expect(adapter.insert).toHaveBeenCalledWith('/projects/other/src', true, 'src')
      expect(view.close).toHaveBeenCalledOnce()
      expect(vi.mocked(adapter.browse).mock.calls.some(([request]) => request.preview)).toBe(false)
    } finally { await view.dispose() }
  })
})

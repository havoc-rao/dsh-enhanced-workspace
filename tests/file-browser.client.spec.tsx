// @vitest-environment jsdom
import { createRoot } from 'react-dom/client'
import { act } from 'react-dom/test-utils'
import { describe, expect, it, vi } from 'vitest'
import { WorkspaceFileBrowser, browserZh, absoluteBrowserPath, fileMention, type FileBrowserAdapter } from '../src/client/command-palette/FileBrowser.tsx'
import type { BrowserResult } from '../src/shared/file-browser.ts'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('workspace file browser UI', () => {
  it('joins absolute cross-project paths and quotes spaces', () => {
    expect(absoluteBrowserPath('/projects/app/', 'src/a.ts')).toBe('/projects/app/src/a.ts')
    expect(absoluteBrowserPath('C:\\Dev\\app', 'src/a.ts')).toBe('C:\\Dev\\app\\src\\a.ts')
    expect(fileMention('/projects/my app/a.ts', false)).toBe('@"/projects/my app/a.ts"')
    expect(fileMention('/projects/app/src', true)).toBe('@/projects/app/src/')
  })
  it('selects a workspace, drills directories, previews, copies and inserts without navigation', async () => {
    const adapter: FileBrowserAdapter = {
      workspaces: () => [
        { workspaceId: 'other', title: 'Other', displayTitle: 'Other', path: '/projects/other', sessionIds: [] },
        { workspaceId: 'second', title: 'Second', displayTitle: 'Second', path: '/projects/second', sessionIds: [] },
      ],
      subscribe: () => () => {}, copy: vi.fn(async () => {}), insert: vi.fn(() => false),
      browse: vi.fn(async ({ path, preview }): Promise<BrowserResult> => preview
        ? { kind: 'file', text: 'export const answer = 42', truncated: false }
        : { kind: 'directory', entries: path ? [{ name: 'a.ts', path: 'src/a.ts', directory: false }]
          : [{ name: 'src', path: 'src', directory: true }, { name: '.hidden', path: '.hidden', directory: false }], truncated: false }),
    }
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container); const close = vi.fn()
    const click = async (label: string) => {
      const buttons = [...document.querySelectorAll('button')]
      const button = buttons.find(button => button.getAttribute('aria-label') === label)
        ?? buttons.filter(button => button.textContent === label).at(-1)
        ?? buttons.find(button => button.textContent?.includes(label))
      expect(button, label).toBeTruthy()
      await act(async () => { button!.click() })
    }
    try {
      await act(async () => { root.render(<WorkspaceFileBrowser adapter={adapter} text={browserZh} close={close} />) })
      expect(document.querySelector('[data-stage=workspace]')).not.toBeNull()
      expect(document.querySelector('[role=tree]')).toBeNull()
      expect(document.querySelector('pre')).toBeNull()
      expect(adapter.browse).not.toHaveBeenCalled()
      await click('Other')
      expect(document.querySelector('[data-stage=tree]')).not.toBeNull()
      expect(document.body.textContent).not.toContain('.hidden')
      expect(document.querySelector('pre')).toBeNull()
      await click('src')
      expect(document.querySelector('[role=treeitem][aria-expanded=true]')).not.toBeNull()
      expect(document.querySelector('[data-stage=tree]')).not.toBeNull()
      await click('src')
      expect(document.querySelector('[role=treeitem][aria-expanded=false]')).not.toBeNull()
      await click('src')
      expect(vi.mocked(adapter.browse).mock.calls.filter(([request]) => request.path === 'src')).toHaveLength(1)
      await click('a.ts')
      expect(document.querySelector('[data-stage=preview]')).not.toBeNull()
      expect(document.body.textContent).toContain('export const answer = 42')
      await click(`${browserZh.copy}: a.ts`)
      expect(adapter.copy).toHaveBeenCalledWith('/projects/other/src/a.ts')
      await click(`${browserZh.insert}: a.ts`)
      expect(adapter.insert).toHaveBeenCalledWith('/projects/other/src/a.ts', false, 'a.ts')
      expect(document.body.textContent).toContain(browserZh.stale)
      expect(close).not.toHaveBeenCalled()
      vi.mocked(adapter.insert).mockReturnValue(true)
      await click(`${browserZh.insert}: a.ts`)
      expect(close).toHaveBeenCalledOnce()
      await click('src')
      expect(document.querySelector('[data-stage=tree]')).not.toBeNull()
      expect(document.querySelector('pre')).toBeNull()
      expect(document.querySelector('[data-mode=picker]')).toBeNull()
      expect(document.body.textContent).not.toContain('Second')
    } finally { await act(async () => { root.unmount() }); container.remove() }
  })
})

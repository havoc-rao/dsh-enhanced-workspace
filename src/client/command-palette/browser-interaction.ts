export interface BrowserInteractionState {
  stage: 'tree'
  canGoBack: boolean
  count: number
  hidden: boolean
  previewEnabled: boolean
  workspaceId?: string
  target?: { path: string; directory: boolean; label: string; selected: boolean }
}
/** Provider-owned browser behavior, exposed to the palette shell through a live bridge. */
export interface BrowserInteraction {
  getState(): BrowserInteractionState
  back(): boolean
  move(delta: number): void
  accept(): void
  setHidden(hidden: boolean): void
  setPreviewEnabled(enabled: boolean): void
}
export interface BrowserShell {
  query: string
  bind(interaction: BrowserInteraction): () => void
  invalidate(): void
  setQuery?(query: string): void
}

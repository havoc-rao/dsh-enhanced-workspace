export interface BrowserInteractionState {
  stage: 'workspace' | 'tree' | 'preview'
  canGoBack: boolean
  count: number
  workspaceId?: string
  target?: { path: string; directory: boolean; label: string }
}
/** Provider-owned browser behavior, exposed to the palette shell through a live bridge. */
export interface BrowserInteraction {
  getState(): BrowserInteractionState
  back(): boolean
  move(delta: number): void
  accept(): void
}
export interface BrowserShell {
  query: string
  bind(interaction: BrowserInteraction): () => void
  invalidate(): void
  setQuery?(query: string): void
  openActions?(): void
}

export const FILE_BROWSER_ENDPOINT = 'files/browse'
export interface BrowserEntry { name: string; path: string; directory: boolean }
export type BrowserResult = { kind: 'directory'; entries: BrowserEntry[]; truncated: boolean }
  | { kind: 'file'; text: string; truncated: boolean }
export interface BrowserRequest { workspaceId: string; path: string; preview?: boolean }

// Runtime collaboration uses the optional service; palette imports are erased.
import { basename } from '../git-model.ts';
import type { CommandId, Disposer, ItemId, PaletteService, Picker, PickerId } from '@deepseek-ai/dsh-client-ui-command-palette/core';

export interface WorkspaceRecord {
  readonly workspaceId: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly path: string;
  readonly sessionIds: readonly string[];
}
export interface WorkspaceSnapshot {
  readonly phase: string;
  readonly items: readonly WorkspaceRecord[];
}
export interface WorkspaceAdapter {
  /** Complete host catalogue, not the filtered/collapsed sidebar forest. */
  getSnapshot(): WorkspaceSnapshot;
  getCurrentSessionId(): string | undefined;
  isConnected(): boolean;
  /** Subscribe to BOTH catalogue and current-session retention changes. */
  subscribe(listener: () => void): Disposer;
  /** Public navigation completion; supersession may resolve without opening. */
  openWorkspace(workspaceId: string): Promise<void>;
}
export interface WorkspaceCopy {
  commandTitle: string; category: string; pickerTitle: string; placeholder: string;
  emptyText: string; noResultsText: string; unavailable: string; missing: string;
  disconnected: string; defaultName: string;
}
/** Stable domain tag shared by every workspace command; titles never include the tag. */
export const workspaceTag = {
  id: 'workspace',
  title: 'Workspace',
  localizedTitles: { zh: '工作区', en: 'Workspace' },
  iconId: 'workspace',
} as const;
/** Independent child-command translations; the palette owns display and fuzzy search. */
export const workspaceCommandMetadata = {
  zh: { title: '切换工作区', category: '工作区' },
  en: { title: 'Switch Workspace', category: 'Workspace' },
} as const;
const workspaceCommandAliases: readonly string[] = [
  ...Object.values(workspaceCommandMetadata).flatMap(({ title, category }) => [title, category]),
  '查找工作区', '搜索工作区', '打开工作区', '切换项目',
  'find workspace', 'search workspace', 'open workspace', 'switch project',
];
export const defaultWorkspaceCopy: WorkspaceCopy = {
  commandTitle: workspaceCommandMetadata.zh.title, category: workspaceCommandMetadata.zh.category, pickerTitle: '切换工作区',
  placeholder: '搜索工作区名称或路径…', emptyText: '尚无工作区', noResultsText: '没有匹配的工作区',
  unavailable: '工作区列表尚未就绪', missing: '该工作区已不存在',
  disconnected: '连接已断开', defaultName: '默认工作区',
};
export const WORKSPACE_PICKER_ID = 'workspaces.find' as PickerId;
export const WORKSPACE_COMMAND_ID = 'workspaces.find' as CommandId;
const normalize = (value: string): string => value.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
/** Exact > prefix > substring > ordered subsequence. Every token must match. */
function match(field: string, token: string): number | null {
  const text = normalize(field);
  const at = text.indexOf(token);
  if (at >= 0) return text === token ? 0 : at === 0 ? 1 : 2;
  let cursor = 0;
  for (const char of token) {
    const index = text.indexOf(char, cursor);
    if (index < 0) return null;
    cursor = index + char.length;
  }
  return 3;
}
function score(record: WorkspaceRecord, tokens: readonly string[]): number | null {
  let total = 0;
  for (const token of tokens) {
    const candidates = [record.title, record.displayTitle, basename(record.path), record.path].map(field => match(field, token))
      .filter((value): value is number => value !== null);
    if (candidates.length === 0) return null;
    total += Math.min(...candidates);
  }
  return total;
}

export function createWorkspacePicker<C = unknown>(adapter: WorkspaceAdapter,
  copy: () => WorkspaceCopy = () => defaultWorkspaceCopy): Picker<C> {
  return {
    id: WORKSPACE_PICKER_ID,
    queryMode: 'local',
    describe: () => {
      const text = copy();
      return { title: text.pickerTitle, placeholder: text.placeholder,
        emptyText: text.emptyText, noResultsText: text.noResultsText };
    },
    query: ({ query, limit, signal }) => {
      const snapshot = adapter.getSnapshot();
      if (signal.aborted) return { items: [], hasMore: false };
      if (!adapter.isConnected()) throw new Error(copy().disconnected);
      if (snapshot.phase !== 'ready') throw new Error(copy().unavailable);
      const normalized = normalize(query);
      const tokens = normalized ? normalized.split(' ') : [];
      const current = adapter.getCurrentSessionId();
      const ranked = snapshot.items.flatMap((record, index) => {
        const value = score(record, tokens);
        return value === null ? [] : [{ record, index, score: value,
          current: current !== undefined && record.sessionIds.includes(current) }];
      });
      // Empty query prefers current; queried results prefer relevance. Ties retain host order.
      ranked.sort((a, b) => (tokens.length ? a.score - b.score : Number(b.current) - Number(a.current))
        || a.index - b.index || a.record.workspaceId.localeCompare(b.record.workspaceId));
      // Invalid bounds never accidentally expose an unbounded catalogue.
      const bound = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
      return { items: ranked.slice(0, bound).map(({ record }) => ({
        id: record.workspaceId as ItemId, label: record.displayTitle, detail: record.path,
      })), hasMore: ranked.length > bound };
    },
    accept: async (id, { signal }) => {
      if (signal.aborted) return { kind: 'cancelled' };
      const snapshot = adapter.getSnapshot();
      if (!adapter.isConnected()) return { kind: 'failed', message: copy().disconnected };
      if (snapshot.phase !== 'ready') return { kind: 'failed', message: copy().unavailable };
      const record = snapshot.items.find(workspace => workspace.workspaceId === id);
      if (!record) return { kind: 'failed', message: copy().missing };
      if (signal.aborted) return { kind: 'cancelled' };
      try {
        await adapter.openWorkspace(record.workspaceId);
        // The host owns supersession; do not announce success or open again.
        return signal.aborted ? { kind: 'cancelled' } : { kind: 'completed' };
      } catch (error: unknown) {
        console.warn('dsh-enhanced-workspace: open workspace failed',
          { workspaceId: record.workspaceId, path: record.path }, error);
        if (signal.aborted) return { kind: 'cancelled' };
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
      }
    },
    subscribeInvalidation: listener => adapter.subscribe(listener),
  };
}

export function registerWorkspaceProvider<C = unknown>(
  palette: Pick<PaletteService<C>, 'registerCommand' | 'registerPicker'>,
  adapter: WorkspaceAdapter, copy: () => WorkspaceCopy = () => defaultWorkspaceCopy,
): Disposer {
  const removePicker = palette.registerPicker(createWorkspacePicker<C>(adapter, copy));
  let removeCommand: Disposer;
  try {
    removeCommand = palette.registerCommand({
      id: WORKSPACE_COMMAND_ID,
      describe: () => {
        const text = copy();
        return {
          pluginTag: workspaceTag,
          iconId: 'open',
          title: text.commandTitle,
          localizedTitles: { zh: workspaceCommandMetadata.zh.title, en: workspaceCommandMetadata.en.title },
          category: text.category, aliases: workspaceCommandAliases,
        };
      },
      target: { kind: 'picker', pickerId: WORKSPACE_PICKER_ID },
    });
  } catch (error) { removePicker(); throw error; }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    try { removeCommand(); } finally { removePicker(); }
  };
}

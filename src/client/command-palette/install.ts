import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace';
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import type { Context } from '@deepseek-ai/cordis';
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client';
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type { PaletteService } from '@deepseek-ai/dsh-client-ui-command-palette/core';
import { registerWorkspaceProvider, workspaceCommandMetadata, type WorkspaceAdapter, type WorkspaceCopy } from './provider.ts';

const NS = 'enhancedWorkspacePalette' as const;
const zh: WorkspaceCopy = {
  commandTitle: workspaceCommandMetadata.zh.title, category: workspaceCommandMetadata.zh.category, pickerTitle: '选择工作区新建会话',
  placeholder: '搜索工作区名称或路径…', emptyText: '尚无工作区', noResultsText: '没有匹配的工作区',
  unavailable: '工作区列表尚未就绪', missing: '该工作区已不存在', disconnected: '连接已断开', defaultName: '默认工作区',
};
const en: WorkspaceCopy = {
  commandTitle: workspaceCommandMetadata.en.title, category: workspaceCommandMetadata.en.category, pickerTitle: 'Choose a Workspace for a New Session',
  placeholder: 'Search workspace names or paths…', emptyText: 'No workspaces yet', noResultsText: 'No matching workspaces',
  unavailable: 'Workspace catalogue is not ready', missing: 'This workspace no longer exists', disconnected: 'Connection is disconnected', defaultName: 'Default Workspace',
};
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { enhancedWorkspacePalette: keyof WorkspaceCopy }
}

/** Call from enhanced-workspace apply(ctx); no required top-level palette injection. */
export default function installWorkspacePalette(ctx: Context): void {
  ctx.inject(['commandPalette'], paletteCtx => {
    paletteCtx.effect(() => paletteCtx.locale.register(NS, { zh, en }));
    const t = paletteCtx.locale.bind(NS);
    const copy = (): WorkspaceCopy => ({
      commandTitle: t('commandTitle'), category: t('category'), pickerTitle: t('pickerTitle'),
      placeholder: t('placeholder'), emptyText: t('emptyText'), noResultsText: t('noResultsText'),
      unavailable: t('unavailable'), missing: t('missing'), disconnected: t('disconnected'), defaultName: t('defaultName'),
    });
    // Linked plugins can resolve different Cordis type identities. Read the
    // service by its public structural contract, not ambient Context merging.
    const palette = paletteCtx.get('commandPalette') as PaletteService;
    const connection = paletteCtx.get('connection') as unknown as ConnectionHandle;
    const adapter: WorkspaceAdapter = {
      getSnapshot: () => {
        const snapshot = paletteCtx.workspaces.list.getSnapshot();
        return { ...snapshot, items: snapshot.items.map(record => ({
          ...record, displayTitle: workspaceDisplayTitle(record.title, t('defaultName')),
        })) };
      },
      isConnected: () => connection.state.getSnapshot() === 'connected',
      getCurrentSessionId: () => Object.values(paletteCtx.sessions.list.getSnapshot().byId)
        .find(row => (row.retainedBy.mainView ?? 0) > 0)?.id,
      subscribe: listener => {
        const offWorkspaces = paletteCtx.workspaces.list.subscribe(listener);
        const offSessions = paletteCtx.sessions.list.subscribe(listener);
        const offConnection = connection.state.subscribe(listener);
        return () => {
          try { offWorkspaces(); } finally { try { offSessions(); } finally { offConnection(); } }
        };
      },
      // Explicit create never reuses a blank session (unlike openWorkspace/startSession).
      createNewSession: async (workspaceId, signal) => {
        if (signal.aborted) return;
        const sessionId = await paletteCtx.sessions.create({ workspaceId: workspaceId as WorkspaceId });
        // Host creation is committed; cancellation leaves it catalogued but does not navigate.
        if (signal.aborted) return;
        if (!adapter.isConnected()) throw new Error(copy().disconnected);
        const latest = adapter.getSnapshot();
        if (latest.phase !== 'ready') throw new Error(copy().unavailable);
        if (!latest.items.some(row => row.workspaceId === workspaceId)) throw new Error(copy().missing);
        paletteCtx.uiWorkspace.openSession(sessionId);
      },
    };
    paletteCtx.effect(() => registerWorkspaceProvider(palette, adapter, copy));
    paletteCtx.effect(() => paletteCtx.locale.subscribe(() => palette.refresh()));
  });
}

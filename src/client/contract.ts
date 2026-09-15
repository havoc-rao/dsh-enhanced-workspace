/**
 * The enhanced browser's inject face and composed props. The registration
 * supplies the business actions (bound to `ctx.workspaces` / `ctx.sessions`
 * in `index.tsx`); the component receives them plus its own store seat, the
 * sidebar owner share, and the locale `t` — the four-share composition of the
 * ui-slots contract.
 * @module dsh-enhanced-workspace/client/contract
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only (erased — never reaches the purity gate): the fileTreeUi v1
// client-service contract provided by the dsh-file-tree-ui plugin. The
// service is OPTIONAL at runtime: this plugin never declares it in its
// cordis `inject` array (cordis has no optional inject — a hard injection
// would fail the whole page for users who upgrade the consumer without the
// provider), and only collaborates through `ctx.get('fileTreeUi')` +
// `ctx.on('internal/service', …)` subscriptions with a local fallback.
import type { FileTreeUiServiceV1 } from 'dsh-file-tree-ui/client-contract'
import type { GitProbeResultJSON } from '../shared/git.ts'
import type { RemoteGitSource } from './remote-git.ts'
import type {
  InjectFace,
  PropsLocale,
  PropsRenderSlots,
  PropsRuntime,
  PropsStore,
  HostObservable,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { createEnhancedWorkspaceStore, EnhancedWorkspaceState } from './store.ts'
import type { NS } from './locales.ts'

/**
 * The enhanced browser's own directory-flow hole. The official holes
 * (`sidebar.workspaces.directoryFlow` / `conversation.hero.workspace.directoryFlow`)
 * are declared by the built-in ui-workspace entries, which stay on the ledger
 * forever under shadowing (shadow ≠ unload); ui-slots allows exactly ONE
 * declarer per slot key, so a shadowing entry can neither re-declare them
 * (register throws → plugin boot fails) nor render them (its `renderSlot`
 * face is narrowed to its own children declaration; anything else throws
 * `SlotOwnershipError`). This plugin therefore exposes its OWN hole under a
 * plugin-owned key; the add entry renders it exactly like the built-in
 * browser renders the official hole. Picker packages (e.g. dsh-remote) point
 * at this key in combined profiles via their build-time slot-key setting
 * (dsh-remote defaults to the official keys and switches on
 * `DSH_REMOTE_DIRECTORY_FLOW_SLOT`). The key string is the cross-plugin
 * protocol — both sides keep the literal in sync, and the local typecheck
 * enforces it here (register children + renderSlot are both constrained to
 * `SlotMap` keys).
 */
export const DIRECTORY_FLOW_SLOT = 'enhanced-workspace.workspace.directoryFlow' as const

/**
 * The fileTreeUi v1 SERVICE NAME — a documented string protocol shared with
 * the dsh-file-tree-ui provider plugin. Cross-plugin runtime values cannot be
 * value-imported (the client-bundle purity gate forbids value-importing the
 * provider package), so provider and consumer each keep their own literal;
 * only the type crosses the boundary (`import type … from
 * 'dsh-file-tree-ui/client-contract'`, erased at build).
 */
export const FILE_TREE_UI_SERVICE = 'fileTreeUi' as const

/** The v1 protocol version of the fileTreeUi service (documented literal,
 *  held by both sides). */
export const FILE_TREE_UI_PROTOCOL_VERSION = 1 as const

/**
 * Hand-written shape check of the optional fileTreeUi service (the
 * consumer-side diagnostic recipe from the provider's contract header).
 * Returns undefined for missing / null / wrong-version / partial values —
 * the caller then falls back to its local rendering and must not white
 * screen. No runtime import of the provider package happens here.
 * @param value - the raw `ctx.get('fileTreeUi')` value.
 * @returns the v1 service, or undefined when absent/incompatible.
 * @see {@link FILE_TREE_UI_SERVICE} {@link FILE_TREE_UI_PROTOCOL_VERSION}
 */
export function resolveFileTreeUiServiceV1(value: unknown): FileTreeUiServiceV1 | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<FileTreeUiServiceV1>
  if (candidate.protocolVersion !== FILE_TREE_UI_PROTOCOL_VERSION
    || typeof candidate.renderRow !== 'function'
    || typeof candidate.renderGuideLayer !== 'function'
    || typeof candidate.renderRowMenu !== 'function') {
    return undefined
  }
  return candidate as FileTreeUiServiceV1
}

/**
 * The enhanced browser's own SEARCH hole — the external trigger contract for
 * the session search field. Declared next to the directory-flow hole for the
 * same reason (the built-in `sidebar.workspaces` sub-slots are owned by the
 * built-in entry, which shadowing never unloads, so an external plugin cannot
 * reach the search through an official hole).
 *
 * Unlike the directory-flow hole (which hands the occupying picker an
 * `open`/`onPicked` conversation), this hole carries a COMMON INJECT FACE
 * declared at the slot level: every registered entry — and any plugin that
 * merely waits for the declaration through `ctx.slots.inject(SEARCH_SLOT, …)`
 * — receives {@link EnhancedSearchHandle}, so a hotkey plugin can drive the
 * real search state (focus the field, seed/clear the query, reach the live
 * input) instead of guessing at DOM. The declarative shape is a function
 * handle rather than owner/occupant conversation state: there is nothing for
 * an occupant to take over, only a capability to invoke.
 *
 * The key string is the cross-plugin protocol: external packages keep the
 * literal in sync (there is no shared type import across plugin bundles) and
 * the local typecheck enforces it at the register/render sites here.
 */
export const SEARCH_SLOT = 'enhanced-workspace.workspace.search' as const

/**
 * The external search handle carried by {@link SEARCH_SLOT}'s common inject
 * face. Delivered to every registered entry through the slot props, to
 * `ctx.slots.inject(SEARCH_SLOT, …)` waiters, and mirrored on
 * `window.__DSH_ENHANCED_WORKSPACE__` for the imperative (hotkey-action)
 * path. Every method is live: it re-reads the mounted browser's state on each
 * call, so a caller holding the handle across a sidebar fold/unfold keeps
 * working.
 */
export interface EnhancedSearchHandle {
  /**
   * Focus the search field. When the sidebar is collapsed the field does not
   * exist yet: the call arms the built-in "search on expand" gesture
   * (`setSearchOnExpand` + `expandSidebar()`) and lands focus in the input
   * once the shell flips wide — the same two-step the rail's search button
   * performs. A no-op when the browser region is not mounted.
   */
  focus: () => void
  /**
   * Replace the search query (empty string clears the filter). The value
   * survives a collapsed→wide fold, so `setQuery('x')` before `focus()`
   * also works; callers seed THEN focus to type into a prefilled box.
   * A no-op when the browser region is not mounted.
   */
  setQuery: (query: string) => void
  /**
   * The live search input, or null while collapsed / unmounted. Read-only
   * escape hatch for a caller that implements its own query commit (the
   * stable DOM attribute is still the declarative fallback).
   */
  input: () => HTMLInputElement | null
  /** True while a live handle exists (the browser region is mounted). */
  readonly available: boolean
}

/**
 * The stable DOM attribute this region marks its externally addressable
 * surfaces with. The value on the wide search input is
 * {@link SEARCH_INPUT_ATTR_VALUE}; the collapsed rail's search button carries
 * {@link SEARCH_RAIL_BUTTON_ATTR_VALUE} (it expands the shell and lands focus
 * in the input, the built-in gesture). A DOM fallback trigger clicks the rail
 * button when the input is absent, waits for the fold, then focuses.
 */
export const SEARCH_ATTR = 'data-dsh-enhanced-workspace' as const

/** {@link SEARCH_ATTR} value of the search input (see {@link SEARCH_INPUT_SELECTOR}). */
export const SEARCH_INPUT_ATTR_VALUE = 'search' as const

/** {@link SEARCH_ATTR} value of the collapsed rail's search button. */
export const SEARCH_RAIL_BUTTON_ATTR_VALUE = 'search-button' as const

/**
 * Stable DOM marker of the search input, for the DOM fallback path of an
 * external trigger (a hotkey plugin that runs before the slot declaration is
 * live, or that deliberately avoids slot coupling). The input also carries
 * `aria-label` = the localized `searchAria` copy. The rail's search button
 * carries {@link SEARCH_RAIL_BUTTON_SELECTOR} when collapsed — click it, then
 * wait for the input (bounded), exactly like the built-in gesture.
 */
export const SEARCH_INPUT_SELECTOR = `[${SEARCH_ATTR}="${SEARCH_INPUT_ATTR_VALUE}"]` as const

/** The rail search button's stable DOM marker (collapsed shell only). */
export const SEARCH_RAIL_BUTTON_SELECTOR = `[${SEARCH_ATTR}="${SEARCH_RAIL_BUTTON_ATTR_VALUE}"]` as const

/**
 * Global key of the imperative search mirror. A hotkey action's `run` has no
 * React access; this is its service-first path (mirroring dsh-hotkey's own
 * `window.__DSH_HOTKEY__` convention), with the slot handle and the DOM
 * selector as the other two paths. Installed by the mounted browser and
 * withdrawn on unmount.
 */
export const SEARCH_GLOBAL_KEY = '__DSH_ENHANCED_WORKSPACE__' as const

/**
 * The imperative mirror's shape (see {@link SEARCH_GLOBAL_KEY}). `focus` and
 * `setQuery` delegate to the live handle; `querySelector` /
 * `railButtonSelector` are the DOM fallback constants, so a consumer needs no
 * hard-coded literals.
 */
export interface EnhancedWorkspaceGlobal {
  /** Focus the search field (expanding the sidebar first when collapsed). */
  focusSearch: () => void
  /** Replace the search query (expanding + focusing only when `focus` is also called). */
  setSearchQuery: (query: string) => void
  /** The live search input element, or null while collapsed / unmounted. */
  searchInput: () => HTMLInputElement | null
  /** True while the region (and therefore the search handle) is mounted. */
  searchAvailable: () => boolean
  /** Stable selector of the search input (DOM fallback). */
  readonly querySelector: typeof SEARCH_INPUT_SELECTOR
  /** Stable selector of the collapsed rail's search button (DOM fallback). */
  readonly railButtonSelector: typeof SEARCH_RAIL_BUTTON_SELECTOR
}

/**
 * The mounted browser's live search implementation, registered by
 * `Browser.tsx` and read lazily by {@link searchHandle}. The reverse
 * direction of the dependency (component → contract, never the other way at
 * runtime) keeps this module free of React imports, so the inject face in
 * `index.tsx`, the global mirror, and component specs all share one handle
 * identity.
 */
interface LiveSearch {
  focus: () => void
  setQuery: (query: string) => void
  input: () => HTMLInputElement | null
}

let liveSearch: LiveSearch | null = null

/**
 * Install the mounted browser's live search surface (called from a mount
 * effect; the previous owner is restored on cleanup, so StrictMode's
 * setup/cleanup replay and test remounts never leave a dead handle).
 * @param live - the mounted implementation.
 * @returns cleanup restoring the previous owner.
 */
export function installSearchHandle(live: LiveSearch): () => void {
  const previous = liveSearch
  liveSearch = live
  return () => { liveSearch = previous }
}

/**
 * The shared {@link EnhancedSearchHandle} — one identity for the slot inject
 * face, the global mirror, and the component spec. Calls are live reads of
 * the currently mounted browser; with no region mounted, `focus` / `setQuery`
 * are no-ops and `available` is false.
 */
export const searchHandle: EnhancedSearchHandle = {
  focus: () => { liveSearch?.focus() },
  setQuery: (query: string) => { liveSearch?.setQuery(query) },
  input: () => liveSearch?.input() ?? null,
  get available() { return liveSearch !== null },
}

/**
 * DOM fallback: commit a query into the live search input the React way —
 * write through the prototype's value setter (bypassing React's own value
 * tracker) and dispatch a bubbling `input` event, which React's synthetic
 * `onChange` listens for. Returns false when no input is mounted (collapsed
 * shell: click {@link SEARCH_RAIL_BUTTON_SELECTOR} and retry after the fold).
 * @param query - the value to commit.
 * @returns whether an input received the query.
 */
export function commitSearchQueryFromDom(query: string): boolean {
  const input = document.querySelector<HTMLInputElement>(SEARCH_INPUT_SELECTOR)
  if (input === null) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (setter === undefined) return false
  setter.call(input, query)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/**
 * Owner share of the enhanced directory-flow hole: the complete conversation
 * between the trigger surface and the picking interaction. This mirrors the
 * official hole's contract verbatim (ui-workspace `DirectoryFlowOwnerProps`,
 * redeclared here because ui-workspace is not a dependency of this package):
 * the occupant owns everything between `open` and the picked path, the owner
 * owns adoption — an occupant written against either hole works against both.
 */
export interface EnhancedDirectoryFlowOwnerProps {
  /** True while a picking interaction is requested; flipping back to false withdraws the request. */
  open: boolean
  /** True while the owner adopts a picked path (`createWorkspace` in flight); occupants disable their commit affordances. */
  busy: boolean
  /** The operator picked a directory (absolute host path); the owner adopts it. */
  onPicked: (path: string) => void
  /** The operator dismissed the interaction; the owner just closes the flow. */
  onCancel: () => void
  /** The interaction itself failed (chooser missing, listing denied); the owner reports the failure. */
  onError: (message: string) => void
}

/**
 * Owner share of the enhanced search hole. Intentionally empty: the slot
 * exists to publish the {@link EnhancedSearchHandle} inject face, not to run
 * a conversation with an occupant (contrast the directory-flow hole above).
 * The type is declared rather than inlined so a future owner-supplied datum
 * has one place to land.
 */
export interface EnhancedSearchOwnerProps {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Directory-flow hole under the enhanced sidebar browser (declared by the shadowing entry). */
    [DIRECTORY_FLOW_SLOT]: {
      kind: 'single'
      scope: 'root'
      owner: EnhancedDirectoryFlowOwnerProps
    }
    /**
     * Search hole under the enhanced sidebar browser: a single/root cell with
     * NO owner conversation — the slot's common `inject` face carries the
     * live {@link EnhancedSearchHandle}, which every occupant receives on its
     * props and which is also the external trigger contract.
     */
    [SEARCH_SLOT]: {
      kind: 'single'
      scope: 'root'
      owner: EnhancedSearchOwnerProps
      inject: EnhancedSearchHandle
    }
  }
}

/**
 * Origin-independent persistence face of the enhanced browser: loading and
 * storing the whole viewing state (the envelope) through the Host-side file
 * (`~/.dsh/storages/dsh-enhanced-workspace.json`). The implementations
 * route over the plugin's `/enhanced-workspace` Connection RPC channel with
 * a localStorage fallback; the browser never touches storage directly.
 */
export interface EnhancedWorkspacePersistence {
  /** Load the stored envelope; null only when storage is confirmed empty; failures reject. */
  load(): Promise<EnhancedWorkspaceState | null>
  /** Store the current envelope wholesale (the caller owns debouncing). */
  save(state: EnhancedWorkspaceState): Promise<void>
}

/**
 * Registrant business face of the enhanced browser region. Data reads use
 * the framework hooks; these are the Host actions the region drives.
 */
export interface EnhancedWorkspaceInjected {
  /** Picking-share hooks compartment: the renderer binds each source into a
   *  `use<Name>` selector hook on the component props. */
  hooks: {
    /** True while the enhanced directory-flow hole is occupied by a picker package. */
    directoryFlow: HostObservable<boolean>
    /**
     * The optional fileTreeUi v1 client service (dsh-file-tree-ui provider).
     * Snapshot/subscribe pair: each fiber activation re-reads
     * `ctx.get('fileTreeUi')` (no handle is cached across lifecycles), and
     * provider unload flips the snapshot back to undefined. The browser
     * renders SessionRow through the service when present and falls back to
     * its built-in row rendering otherwise (missing / protocol-mismatched /
     * unloaded — see `resolveFileTreeUiServiceV1`).
     */
    fileTreeUi: HostObservable<FileTreeUiServiceV1 | undefined>
  }
  /** Start a New Session in a Workspace (reuse-or-create its blank session and open it). */
  startSession: (workspaceId?: WorkspaceId) => void
  /** Open a real Session. */
  open: (sessionId: SessionId) => void
  /** Rename a Session (explicit user title; resolves on host acceptance). */
  renameSession: (sessionId: SessionId, title: string) => Promise<void>
  /** Fork a Session at its last completed turn and open the child. */
  forkSession: (sessionId: SessionId) => void
  /** Rename a Host Workspace (rejects on name conflict; resolves on durability). */
  renameWorkspace: (workspaceId: WorkspaceId, title: string) => Promise<void>
  /** Delete only a Host Workspace registration; directory and Session logs remain. */
  deleteWorkspace: (workspaceId: WorkspaceId) => Promise<void>
  /** Reorder a Workspace in the durable registry display order (omitted anchor appends). */
  insertWorkspaceBefore: (workspaceId: WorkspaceId, beforeWorkspaceId?: WorkspaceId) => Promise<void>
  /** Archive a Session into the registry-global set: hidden from grouping surfaces. */
  archiveSession: (sessionId: SessionId) => Promise<void>
  /** Reorder a session inside its Workspace account (DOM-insertBefore semantics). */
  insertSessionBefore: (
    workspaceId: WorkspaceId,
    sessionId: SessionId,
    beforeSessionId?: SessionId,
  ) => Promise<void>
  /** Adopt a picked host directory as a real Workspace. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /** Open the Host's native directory picker. */
  pickDirectory: () => Promise<string | null>
  /**
   * Compute the git-repo index over a path list (workspace paths + session
   * cwds, deduped host-side). Resolves to null when the Connection is
   * unavailable or the probe failed. Callers treat null as "no git layer".
   */
  probeGit: (paths: readonly string[]) => Promise<GitProbeResultJSON | null>
  /**
   * Remote-mirror git markers (dsh-remote `GET /dsh-remote/git-workspace`):
   * branch + dirty state of the REMOTE repo behind a mirror workspace —
   * the mirror's local `.git` does not exist, so the local probe alone can
   * never see it. Fetches are memoized per path with a TTL and every
   * failure degrades to "no marker" (never blocks, never errors).
   */
  remoteGit: RemoteGitSource
  /**
   * Start a NEW session in a target workspace and open it — the "在目标树
   * 继续" verb. Honest semantics: a session's cwd is fixed at creation and
   * there is no cross-tree move API, so switching trees is a new session in
   * the target workspace, never a relocation. A source title (when given)
   * is carried over by renaming the freshly created session once it appears
   * in the sessions list.
   */
  continueInWorkspace: (workspaceId: WorkspaceId, title?: string) => Promise<void>
  /** Durable envelope load/store (Host file first, localStorage fallback). */
  persistence: EnhancedWorkspacePersistence
}

/** Full browser props: sidebar owner share + child-render share (the two
 *  plugin-owned holes: directory flow + search) + viewing store + injected
 *  actions + the locale seat. */
export type EnhancedWorkspaceBrowserProps =
  PropsRuntime<'sidebar.workspaces'>
  & PropsRenderSlots<typeof DIRECTORY_FLOW_SLOT | typeof SEARCH_SLOT>
  & PropsStore<ReturnType<typeof createEnhancedWorkspaceStore>>
  & InjectFace<EnhancedWorkspaceInjected>
  & PropsLocale<typeof NS>
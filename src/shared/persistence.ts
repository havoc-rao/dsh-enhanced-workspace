/**
 * Wire names of the plugin's durable-envelope persistence: the Connection
 * RPC channel and its endpoint literals, plus the legacy localStorage key
 * used as a same-origin fallback. Shared by both halves — the host
 * registers the channel under these literals and the browser calls them, so
 * one spelling keeps the two from drifting silently.
 * @module dsh-enhanced-workspace/shared/persistence
 */

/** The plugin's logical RPC channel (absolute prefix on the host webserver). */
export const PERSISTENCE_CHANNEL = '/enhanced-workspace'

/** Channel-relative endpoint reading the stored envelope (null when none is stored). */
export const PERSISTENCE_LOAD_ENDPOINT = 'load'

/** Channel-relative endpoint writing the client's envelope wholesale. */
export const PERSISTENCE_SAVE_ENDPOINT = 'save'

/** Legacy localStorage key (the pre-host-store persistence); fallback only now. */
export const PERSISTENCE_LOCAL_FALLBACK_KEY = 'dsh.enhanced-workspace.v1'
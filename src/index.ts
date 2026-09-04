/**
 * Host half of dsh-enhanced-workspace: owns the plugin's durable envelope —
 * the folder tree, expansion state, and recency stamps — as one JSON file
 * under `<dsh-home>/storages/`, served to the browser bundle over the
 * plugin's own Connection RPC channel (`/enhanced-workspace`, endpoints
 * `load` and `save`, loopback authority — matching the desktop app and the
 * local web server, which is also why the client never relied on its own
 * HTTP fetch for this).
 *
 * Why the host stores the tree instead of the client's localStorage:
 * the desktop app binds its webserver to an OS-assigned port per launch
 * (see `apps/electron/config/electron.patch.yml`), and Chromium partitions
 * localStorage by origin — port included — so every restart minted a fresh
 * bucket and the multi-level directory silently vanished. See
 * `src/host/storage.ts` for the validation and file discipline.
 * @module dsh-enhanced-workspace
 */

import { Context } from '@deepseek-ai/cordis'
// Type-only: the published package augments `Context` with the host
// `connection` service (HostConnectionHandle) in rpc-host.d.ts; the import
// keeps that declaration in the type graph and is erased from the bundle.
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import {
  PERSISTENCE_CHANNEL,
  PERSISTENCE_LOAD_ENDPOINT,
  PERSISTENCE_SAVE_ENDPOINT,
} from './shared/persistence.ts'
import {
  envelopeByteSize,
  envelopeFilePath,
  MAX_ENVELOPE_BYTES,
  readEnvelopeFile,
  resolveDshHome,
  validateEnvelope,
  writeEnvelopeFile,
  type PersistedEnvelope,
} from './host/storage.ts'

/** Cordis plugin name (the cordis.patch.yml row references the package name). */
export const name = 'dsh-enhanced-workspace'

/** Services required before applying: the Connection transport that mounts RPC channels. */
export const inject = ['connection']

/** One decoded `/enhanced-workspace` request payload (load carries none). */
interface SaveEnvelopePayload {
  state?: unknown
}

/**
 * Plugin body: register the persistence channel for the browser half. Every
 * endpoint returns the Connection `RpcResult` shape: business failures
 * (validation rejection, storage errors) fold into the error branch — the
 * client never sees a thrown transport error for a rejected envelope.
 * @param ctx - cordis context (with the injected `connection` service).
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as HostConnectionHandle | undefined
  if (connection === undefined) {
    ctx.logger.warn('dsh-enhanced-workspace: no Connection service; durable envelope persistence disabled')
    return
  }
  const remove = connection.rpc.handle(
    PERSISTENCE_CHANNEL,
    async (endpoint, payload) => {
      const file = envelopeFilePath(resolveDshHome())
      if (endpoint === PERSISTENCE_LOAD_ENDPOINT) {
        try {
          const envelope = await readEnvelopeFile(file)
          return { ok: true, value: envelope } as const
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: `dsh-enhanced-workspace: envelope read failed: ${String(error)}`,
              details: {},
            },
          } as const
        }
      }
      if (endpoint === PERSISTENCE_SAVE_ENDPOINT) {
        const candidate = (payload as SaveEnvelopePayload | null | undefined)?.state
        if (!validateEnvelope(candidate)) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: 'dsh-enhanced-workspace: envelope validation rejected the save',
              details: {},
            },
          } as const
        }
        if (envelopeByteSize(candidate) > MAX_ENVELOPE_BYTES) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: `dsh-enhanced-workspace: envelope exceeds the ${MAX_ENVELOPE_BYTES}-byte cap`,
              details: {},
            },
          } as const
        }
        try {
          await writeEnvelopeFile(file, candidate as PersistedEnvelope)
          return { ok: true, value: null } as const
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: `dsh-enhanced-workspace: envelope write failed: ${String(error)}`,
              details: {},
            },
          } as const
        }
      }
      return {
        ok: false,
        error: {
          code: 'internal',
          message: `dsh-enhanced-workspace: unknown endpoint ${JSON.stringify(endpoint)}`,
          details: {},
        },
      } as const
    },
    { authority: 'loopback' },
  )
  // The registration is a cordis effect on this context; it disposes itself
  // with the fiber (`remove` exists for eager teardown only).
  void remove
}
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

// The plugin's own view of the core session lifecycle events it consumes.
// Declared here instead of type-importing @deepseek-ai/dsh-session: the
// session package's ambient merges (its own `Context.sessions` store) would
// collide with the api-session-controller's client face elsewhere in the
// bundle's type graph. The real runtime event is emitted by the core session
// store into every root context (the api-session-controller's host half
// consumes the same firehose); this declaration only narrows what the
// tracker reads — id + the audit event shape — and is erased at build.
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Post-commit append feed of one live session. */
    'session/event'(session: { readonly id: string }, event: { readonly type: string; readonly data: unknown }): void
    /** A session left the store — its open asks are gone with it. */
    'session/disposed'(session: { readonly id: string }): void
  }
}
// Type-only: the published package augments `Context` with the host
// `connection` service (HostConnectionHandle) in rpc-host.d.ts; the import
// keeps that declaration in the type graph and is erased from the bundle.
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import {
  PERSISTENCE_CHANNEL,
  PERSISTENCE_LOAD_ENDPOINT,
  PERSISTENCE_SAVE_ENDPOINT,
} from './shared/persistence.ts'
import { GIT_PROBE_ENDPOINT } from './shared/git.ts'
import {
  probeGitIndex,
  serializeGitRepoIndex,
} from './host/git.ts'
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
import { ApprovalStatusSource } from './host/approval-status.ts'
import { APPROVAL_PENDING_ENDPOINT } from './shared/approval-status.ts'

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
 *
 * Endpoints:
 * - `load` / `save` — the durable envelope (see src/host/storage.ts);
 * - `git/probe` — the git-repo index over a path list (see src/host/git.ts);
 * - `approval/pending` — the open-approval snapshot (see
 *   src/host/approval-status.ts), the loss-free path that keeps the sidebar's
 *   amber waiting dot stable.
 * @param ctx - cordis context (with the injected `connection` service).
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as HostConnectionHandle | undefined
  if (connection === undefined) {
    ctx.logger.warn('dsh-enhanced-workspace: no Connection service; durable envelope persistence disabled')
    return
  }
  // Live open-approval ledger: `approval/asked` → `approval/decided` audit
  // events off the session/event firehose. Registered before the channel so
  // the first poll already sees every ask that happened since mount.
  const approvalStatus = new ApprovalStatusSource()
  ctx.on('session/event', (session, event) => {
    if (event.type === 'approval/asked' || event.type === 'approval/decided') {
      approvalStatus.observe(session.id, event)
    }
  })
  ctx.on('session/disposed', (session) => {
    approvalStatus.forget(session.id)
  })
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
      if (endpoint === GIT_PROBE_ENDPOINT) {
        const paths = (payload as { paths?: unknown } | null | undefined)?.paths
        if (!Array.isArray(paths) || paths.some(item => typeof item !== 'string')) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: 'dsh-enhanced-workspace: git/probe expects { paths: string[] }',
              details: {},
            },
          } as const
        }
        try {
          const index = probeGitIndex(paths as string[])
          return { ok: true, value: serializeGitRepoIndex(index) } as const
        } catch (error) {
          // Probe failures are soft by design: an empty index keeps the
          // browser usable without any git-derived layer.
          ctx.logger.warn('dsh-enhanced-workspace: git probe failed', error)
          return {
            ok: false,
            error: {
              code: 'internal',
              message: `dsh-enhanced-workspace: git probe failed: ${String(error)}`,
              details: {},
            },
          } as const
        }
      }
      if (endpoint === APPROVAL_PENDING_ENDPOINT) {
        return {
          ok: true,
          value: { asks: approvalStatus.snapshot() },
        } as const
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
  )
  // The registration is a cordis effect on this context; it disposes itself
  // with the fiber (`remove` exists for eager teardown only).
  void remove
}
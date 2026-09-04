/**
 * Host half of dsh-enhanced-workspace: a near-empty plugin whose only job is
 * to give the profile mount a module to load. All behavior lives in the
 * client bundle (see `src/client/index.tsx`), which shadows the built-in
 * `sidebar.workspaces` region through the slots service.
 * @module dsh-enhanced-workspace
 */

import { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name (the cordis.patch.yml row references the package name). */
export const name = 'dsh-enhanced-workspace'

/**
 * Plugin body. No host-side registration exists today; the apply exists so
 * the mount row is a valid plugin and future host capabilities (e.g. a
 * fenced route for heavy storage) have a home.
 * @param ctx - cordis context.
 */
export function apply(ctx: Context): void {
  // Client-only enhancement: nothing to register on the host side.
  void ctx
}
/**
 * Vitest-only stand-in for `@deepseek-ai/dsh-client-runtime/client`, resolved
 * through a `resolve.alias` in vitest.config.ts — a guard for any future
 * value-import of the runtime specifier (the current suite only type-imports
 * it, and the type surface now comes from the resolvable api packages, so
 * `pnpm typecheck` needs no runtime declarations either).
 *
 * Why this exists: the published runtime client bundle is the DSH client wire
 * layer — `window.__ModuleLoader__.load({ id, factory })`, a loader-shaped
 * CJS closure with no ESM exports. A plain Node ESM import therefore yields
 * empty bindings (`defineStore` would be `undefined`), the package exports
 * map does not expose the bundle's file path at all, and the real store
 * engine is unreachable from specs. This module reads the REAL published
 * bundle source, evaluates it against a shim `window` whose loader executes
 * the factory with a synchronous `require` over the two dependencies the
 * bundle pulls (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots` —
 * statically imported here, so their ESM namespaces are settled before the
 * factory runs), and re-exports the genuine engine surface. The spec then
 * exercises the real engine (`defineStore` + immer drafts + localStorage
 * persistence), not a lookalike.
 * @module dsh-enhanced-workspace/tests/harness/runtime-client
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import * as cordis from '@deepseek-ai/cordis'
import * as slots from '@deepseek-ai/dsh-client-ui-slots'

/** The loader record shape the DSH wire layer publishes bundles as. */
interface LoaderRecord {
  id: string
  factory: (require: (specifier: string) => unknown) => unknown
}

/** Module.exports captured from the last (only) bundle `load` call. */
let captured: Record<string, unknown> = {}

/** Loader-side dependency table: the two specifiers the runtime bundle requires. */
function requireFromLoader(specifier: string): unknown {
  if (specifier === '@deepseek-ai/cordis') return cordis
  if (specifier === '@deepseek-ai/dsh-client-ui-slots') return slots
  throw new Error(`dsh-enhanced-workspace test loader: unmapped dependency '${specifier}'`)
}

/** The `window` the bundle source sees: nothing but the loader it calls. */
const loaderWindow = {
  __ModuleLoader__: {
    load(record: LoaderRecord): void {
      const module = { exports: {} as Record<string, unknown> }
      const result = record.factory(requireFromLoader)
      captured = (result ?? module.exports) as Record<string, unknown>
    },
  },
} as unknown as Window

// Resolve the real bundle through the package's own exports (package.json is
// exposed by the exports map) and evaluate it in this realm: its only
// top-level side effect is the loader call, and the factory body is plain
// CJS-closure code. `new Function` provides the `window` binding directly.
const require = createRequire(import.meta.url)
const packageJsonPath = require.resolve('@deepseek-ai/dsh-client-runtime/package.json')
const bundleSource = readFileSync(join(dirname(packageJsonPath), 'lib', 'client.js'), 'utf8')
new Function('window', bundleSource)(loaderWindow)

/** The real engine surface (typed from the store-engine package so this
 *  harness stays free of the runtime wire package, which the local registry
 *  does not publish a resolvable `/client` types entry for — the platform
 *  store engine live here is `@deepseek-ai/dsh-client-store`). */
import type {
  createSnapshotStore as CreateSnapshotStoreDef,
  defineStore as DefineStoreDef,
  shallowEqual as ShallowEqualDef,
} from '@deepseek-ai/dsh-client-store'

/** The genuine store engine: declare a store → `EngineStoreHandle<T, A>`. */
export const defineStore = captured.defineStore as unknown as typeof DefineStoreDef

/** The genuine bare snapshot store (flush + optional persistence). */
export const createSnapshotStore = captured.createSnapshotStore as unknown as typeof CreateSnapshotStoreDef

/** The genuine shallow-equality helper travelling with the engine. */
export const shallowEqual = captured.shallowEqual as unknown as typeof ShallowEqualDef
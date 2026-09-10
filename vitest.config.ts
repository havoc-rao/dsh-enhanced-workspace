/**
 * Vitest config: inline the npm-published `@deepseek-ai/*` packages whose
 * BUILT lib bundles css side-effect imports (e.g. `dsh-client-ui-primitives`
 * imports `katex/dist/katex.min.css` at the top of its `lib/index.js`).
 * Installed from the npm registry these packages live under
 * `node_modules/.pnpm` and are externalized by vitest — Node then chokes on
 * the `.css` import. Inlining routes them through Vite's transform, which
 * stubs css imports (the default `css: false`). DOM-dependent specs opt in
 * per file with the `// @vitest-environment jsdom` pragma.
 *
 * The runtime `client` alias: the published `@deepseek-ai/dsh-client-runtime`
 * client bundle is the DSH `window.__ModuleLoader__` wire layer with no ESM
 * exports, so vitest resolves it to the loader shim in
 * `tests/harness/runtime-client.ts`, which executes the REAL bundle and
 * re-exports the genuine store engine. Production and typecheck are
 * untouched (tsdown externalizes the real package; tsc reads its published
 * declarations through node_modules resolution).
 */
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: '@deepseek-ai/dsh-client-runtime/client',
        replacement: fileURLToPath(new URL('./tests/harness/runtime-client.ts', import.meta.url)),
      },
    ],
  },
  test: {
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
    exclude: [
      'tests/e2e/**',
      // Parallel dev worktrees live under tmp/<repo>/<branch> (AGENTS.md):
      // they hold their own copy of every spec, and collecting them here
      // would run the OTHER checkout's code against this one's config.
      '**/tmp/**',
      // pnpm's in-repo store keeps a per-project mirror of the checkout
      // (`.pnpm-store/v11/projects/<hash>/tests/…`); without this the whole
      // suite is collected twice against the mirrored copy.
      '**/.pnpm-store/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
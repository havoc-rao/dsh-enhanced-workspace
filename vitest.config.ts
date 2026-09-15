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
 * re-exports the genuine store engine. The spec suite only type-imports the
 * runtime specifier (types now sourced from the resolvable api packages —
 * see the harness header), so this alias is a guard for any future
 * value-import; `pnpm typecheck` no longer needs the package's declarations.
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
      // The P2 specs value-import dsh-file-tree-ui's REAL src components to
      // build the fileTreeUi v1 service fixture. The linked package resolves
      // its OWN node_modules (a separate pnpm virtual store), so its react /
      // react-dom copies are distinct module instances from ours — two
      // Reacts would break hooks („Cannot read properties of null (reading
      // 'useRef')"). The provider's peer versions match ours (both React
      // 18.3.1), so pin the react family to OUR copies: one instance, one
      // store. (ui-primitives/other packages may stay per-store copies —
      // with a shared React, their hooks and elements interoperate.)
      { find: /^react$/, replacement: fileURLToPath(new URL('./node_modules/react/index.js', import.meta.url)) },
      { find: /^react\/jsx-runtime$/, replacement: fileURLToPath(new URL('./node_modules/react/jsx-runtime.js', import.meta.url)) },
      { find: /^react-dom$/, replacement: fileURLToPath(new URL('./node_modules/react-dom/index.js', import.meta.url)) },
      { find: /^react-dom\/client$/, replacement: fileURLToPath(new URL('./node_modules/react-dom/client.js', import.meta.url)) },
    ],
  },
  test: {
    server: {
      deps: {
        inline: [
          /@deepseek-ai\/dsh-client-ui-primitives/,
          // The linked dsh-file-tree-ui provider: P2 specs value-import its
          // REAL src components (TreeRow / TreeGuideLayer / RowMenu) to build
          // the fileTreeUi v1 service fixture — inside node_modules they must
          // run through Vite's transform (TSX + css modules), not Node.
          /dsh-file-tree-ui/,
        ],
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
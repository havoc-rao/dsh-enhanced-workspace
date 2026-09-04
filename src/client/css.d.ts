/**
 * Ambient declarations for the css-module imports the tsdown pipeline
 * compiles to hashed class maps (see tsdown.config.ts makeCssPlugin). The
 * typecheck surface sees the raw `.module.css` files, which TypeScript
 * cannot load on its own.
 */

declare module '*.module.css' {
  /** Hashed class map produced by the build's lightningcss transform. */
  const classes: Record<string, string>
  export default classes
}
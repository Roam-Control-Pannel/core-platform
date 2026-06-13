/**
 * Ambient declaration for side-effect CSS imports (e.g. `import "@/global.css"`).
 *
 * The native app imports a global stylesheet for its side effect (NativeWind picks it
 * up via the Metro transform). TypeScript 6.0 errors (TS2882) on side-effect imports of
 * non-code modules unless a type declaration exists; Metro transpiles without type-checking,
 * so only the `tsc --noEmit` typecheck step (CI) surfaces it. This committed declaration
 * makes the CSS import type-check independent of any generated artifacts.
 */
declare module "*.css";

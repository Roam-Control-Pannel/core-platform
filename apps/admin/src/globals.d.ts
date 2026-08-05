/**
 * Ambient declaration for side-effect CSS imports (e.g. `import "./globals.css"`).
 *
 * TypeScript 6.0 errors (TS2882) on side-effect imports of non-code modules unless a
 * type declaration exists. Next.js generates one inside .next/types during a build, but
 * a bare `tsc --noEmit` (the CI typecheck step) runs with no .next present, so the shim
 * is absent there. This committed declaration makes the CSS import type-check in every
 * context — CI, local, built or not — independent of generated artifacts.
 */
declare module "*.css";

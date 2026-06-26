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

/**
 * CSS Modules (`import styles from "./X.module.css"`). More specific than the side-effect
 * `*.css` glob above, so it wins for module imports and gives a typed class map (instead of
 * `any`), while plain `import "./globals.css"` still resolves via `*.css`. Used by the app
 * chrome (TopBar/TabBar), whose responsive rules need real CSS the inline-style convention
 * can't express. Next generates this inside .next/types on build; committed here so a bare
 * `tsc --noEmit` (CI typecheck, no .next) type-checks too.
 */
declare module "*.module.css" {
  const classes: { readonly [key: string]: string };
  export default classes;
}

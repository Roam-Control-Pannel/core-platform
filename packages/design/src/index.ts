/**
 * @roam/design — the design system as code.
 *
 * The token layer (the single source of truth every surface renders from), plus
 * helpers that derive CSS from those tokens for the web surface. Components (the
 * ported hi-fi classes — .btn-hi, .pill, .card-hi, .poll-hi, etc.) land in a later
 * slice; this is the foundation they'll build on.
 */
export * from "./tokens/index.js";
export { rootCss, typeScaleCss } from "./css.js";

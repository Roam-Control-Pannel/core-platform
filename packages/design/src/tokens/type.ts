/**
 * Typography tokens — a modernist grotesk system (all Google Fonts, open-source) and the
 * type scale.
 *
 *   display — Archivo        (headings, brand moments)
 *   ui      — Archivo        (UI / body — the workhorse; one family, weight does the work)
 *   mono    — JetBrains Mono  (labels / data / eyebrows, uppercase tracked)
 *
 * The scale is "size/weight/tracking". Sizes in px (callers convert to rem/sp as their
 * platform needs); tracking in em. NOTE: the actual @font-face loading is the Google-Fonts
 * @import at the top of each app's globals.css — keep those in lockstep with these names.
 */

export const font = {
  display: "'Archivo', system-ui, sans-serif",
  ui: "'Archivo', system-ui, sans-serif",
  mono: "'JetBrains Mono', ui-monospace, monospace",
} as const;

/** Type scale. weight is a CSS font-weight; tracking is letter-spacing in em. */
export const type = {
  display: { size: 56, weight: 600, tracking: -0.01, family: font.display },
  h1: { size: 32, weight: 600, tracking: 0, family: font.display },
  h2: { size: 24, weight: 600, tracking: 0, family: font.display },
  h3: { size: 20, weight: 600, tracking: 0, family: font.display },
  body: { size: 16, weight: 400, tracking: 0, family: font.ui },
  bodyS: { size: 13, weight: 400, tracking: 0, family: font.ui },
  /** uppercase, used for eyebrows / data labels */
  monoLabel: { size: 11, weight: 700, tracking: 0.12, family: font.mono },
} as const;

export type FontToken = keyof typeof font;
export type TypeToken = keyof typeof type;

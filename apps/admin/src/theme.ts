/**
 * Roam HQ — the editorial visual language.
 *
 * A deliberately different register from the consumer app's warm pastel system: a
 * data-dense, black/white/red "internal terminal" look — hairline grid, heavy grotesk
 * numerals, one hot-red accent. Fonts are the ones globals.css already loads (Archivo for
 * display + UI, JetBrains Mono for micro-labels), so no new font payload.
 */
export const C = {
  bg: "#F4F3F1", // page — warm off-white
  panel: "#FFFFFF",
  ink: "#151312", // near-black headlines / numbers
  inkSoft: "#403A35",
  muted: "#8C857C", // grey captions
  faint: "#B4ADA3", // faint timestamps
  line: "#E4E0DA", // hairline dividers/borders
  lineStrong: "#D7D2CA",
  red: "#E5372A", // the accent
  redInk: "#C21F14",
  redSoft: "#FBEAE7",
  bar: "#D9D5CF", // inactive chart bar
} as const;

export const F = {
  display: "var(--display)", // Archivo — headlines, big numbers
  ui: "var(--ui)", // Archivo — body
  mono: "var(--mono)", // JetBrains Mono — micro-labels
} as const;

/** A bordered white surface — the base of every card in the grid. */
export const panel = {
  background: C.panel,
  border: `1px solid ${C.line}`,
  borderRadius: 4,
} as const;

/** The grey uppercase micro-label used above every stat/section. */
export const label = {
  fontFamily: F.ui,
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: ".07em",
  textTransform: "uppercase",
  color: C.muted,
} as const;

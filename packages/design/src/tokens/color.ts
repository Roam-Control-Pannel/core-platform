/**
 * Colour tokens — ported verbatim from the Foundations handoff
 * (roam-wires.css :root + roam-hifi.css :root additions). These hex values are
 * authoritative; the hi-fi screens render against them.
 *
 * USAGE RULES (from the handoff, enforced by convention not by type):
 *   - crimson is for PRIMARY ACTION / ACTIVE / BRAND only — never a background wash.
 *     One crimson CTA per view.
 *   - gold is reserved for the GOLD business tier and ★ ratings ONLY.
 *   - paper is the app background; card is the raised surface; ink is primary text.
 */

export const color = {
  // Brand — crimson ramp
  crimson: "#C2123F", // primary action / active / brand
  crimson500: "#D6214E",
  crimson600: "#B01038", // hover
  crimson700: "#9D0F33", // text on tint
  crimsonTint: "#FBE6EC", // fills
  crimsonTint2: "#F6D2DD", // emphasis fills / borders

  // Accent — gold (Gold tier + ★ ratings ONLY)
  gold: "#CAA14A",
  goldTint: "#F7EFDA",

  // Semantic
  success: "#1F8A5B",
  successTint: "#E3F3EA",
  info: "#2A5FB0",
  infoTint: "#E6EEFB",

  // Neutral — warm ramp
  paper: "#F6F3EF", // app background
  paper2: "#EFE9E2", // sunken / segmented track
  card: "#FFFFFF", // raised surface
  ink: "#211D1A", // primary text
  inkHi: "#1A1714", // highest-contrast text (hi-fi)
  ink2: "#4D463F", // secondary text
  muted: "#857C72", // tertiary
  faint: "#AAA093", // disabled / hint
  line: "#E4DED6", // borders
  line2: "#D6CEC3", // stronger borders
} as const;

export type ColorToken = keyof typeof color;

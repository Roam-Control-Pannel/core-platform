/**
 * Spacing, radius, elevation, motion — ported from the Foundations handoff.
 *
 * Radius values reconcile to the ACTUAL CSS (roam-wires.css :root), which is the
 * render-truth: sm 7 / md 12 / lg 18 / xl 26. (The README prose said lg 16 / sheet 18;
 * the CSS wins — lg is 18, plus an xl of 26.) "full" is a sentinel for pills/avatars.
 *
 * Elevation captures both the wires shadows (sh1/2/3) and the richer hi-fi pair
 * (shadowKey/shadowPop = the README's L2/L3). All values verbatim from :root.
 *
 * Motion timings + the signature easing curve, from the handoff's Interactions section.
 */

/** 4px base spacing ramp. */
export const space = {
  0: 0,
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
  12: 48,
  16: 64,
} as const;

export const radius = {
  sm: 7,
  md: 12,
  lg: 18,
  xl: 26,
  /** phone-screen frame radius (documentation chrome; rarely used in product) */
  phone: 32,
  /** pills / avatars — caller renders as 9999px or 50% */
  full: 9999,
} as const;

export const elevation = {
  /** L1 cards */
  sh1: "0 1px 2px rgba(33,29,26,.06)",
  /** wires popover */
  sh2: "0 6px 22px rgba(33,29,26,.10)",
  /** wires sheet/modal */
  sh3: "0 18px 50px rgba(33,29,26,.14)",
  /** hi-fi L2 — popovers/raised */
  shadowKey: "0 1px 2px rgba(33,29,26,.05),0 8px 24px rgba(33,29,26,.07)",
  /** hi-fi L3 — sheets/modals */
  shadowPop: "0 2px 6px rgba(33,29,26,.06),0 20px 48px rgba(33,29,26,.16)",
} as const;

export const motion = {
  /** tap feedback */
  tap: "120ms",
  /** standard transitions */
  transition: "240ms",
  /** sheets / nav */
  sheet: "320ms",
  /** signature easing for transitions */
  ease: "cubic-bezier(.2,.8,.2,1)",
  /** tap ease */
  easeTap: "ease-out",
} as const;

export type SpaceToken = keyof typeof space;
export type RadiusToken = keyof typeof radius;
export type ElevationToken = keyof typeof elevation;
export type MotionToken = keyof typeof motion;

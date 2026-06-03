/**
 * @roam/design tokens — the single source of truth every surface renders from.
 *
 * Ported verbatim from the Claude Design Foundations handoff (roam-wires.css +
 * roam-hifi.css :root blocks, and the handoff README's authoritative token spec).
 * Web (CSS vars / Tailwind), native (RN style objects), and console all consume
 * THESE values — a token change here repaints every surface, which is the whole
 * point of the one-design-system architecture.
 */
export { color, type ColorToken } from "./color";
export { font, type, type FontToken, type TypeToken } from "./type";
export {
  space,
  radius,
  elevation,
  motion,
  type SpaceToken,
  type RadiusToken,
  type ElevationToken,
  type MotionToken,
} from "./space";

/**
 * Derived CSS. The TYPED TOKENS are the single source of truth; this turns them into
 * a `:root { --… }` block so the web surface can consume them as CSS variables and
 * Tailwind can map to them — without anyone re-typing a hex value. Native consumes the
 * same token objects directly (no CSS), so both surfaces stay in lockstep by construction.
 *
 * Variable naming mirrors the handoff CSS (--crimson, --paper, --ink, --r-md, etc.) so
 * the ported hi-fi component classes line up against these vars unchanged.
 */
import { color } from "./tokens/color";
import { font, type } from "./tokens/type";
import { space, radius, elevation, motion } from "./tokens/space";

/**
 * Map a camelCase token key to the handoff's kebab CSS var suffix.
 * A hyphen goes at a case boundary (crimsonTint → crimson-tint) and at a
 * letter→digit boundary (crimson600 → crimson-600), but NOT between consecutive
 * digits (so 600 stays 600, not 60-0).
 */
function kebab(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1-$2") // case boundary: inkHi → ink-Hi
    .replace(/([a-zA-Z])([0-9])/g, "$1-$2") // letter→digit: crimson600 → crimson-600
    .toLowerCase();
}

/**
 * Build the `:root` CSS variable block as a string. Pure — deterministic from tokens.
 * Returns the full `:root { … }` rule ready to inject into a global stylesheet.
 */
export function rootCss(): string {
  const lines: string[] = [];

  // Colour: --crimson, --crimson-600, --paper, --ink, … (matches handoff var names)
  for (const [key, value] of Object.entries(color)) {
    lines.push(`  --${kebab(key)}: ${value};`);
  }

  // Fonts: --display, --ui, --mono
  for (const [key, value] of Object.entries(font)) {
    lines.push(`  --${key}: ${value};`);
  }

  // Spacing: --space-1 … --space-16
  for (const [key, value] of Object.entries(space)) {
    lines.push(`  --space-${key}: ${value}px;`);
  }

  // Radius: --r-sm … --r-full (handoff uses --r-* names)
  for (const [key, value] of Object.entries(radius)) {
    const v = value === radius.full ? "9999px" : `${value}px`;
    lines.push(`  --r-${key}: ${v};`);
  }

  // Elevation: --sh-1 / --sh-2 / --sh-3 / --shadow-key / --shadow-pop
  for (const [key, value] of Object.entries(elevation)) {
    lines.push(`  --${kebab(key)}: ${value};`);
  }

  // Motion: --motion-tap / --motion-transition / --motion-sheet / --ease / --ease-tap
  for (const [key, value] of Object.entries(motion)) {
    const name = key === "ease" || key === "easeTap" ? kebab(key) : `motion-${kebab(key)}`;
    lines.push(`  --${name}: ${value};`);
  }

  return `:root {\n${lines.join("\n")}\n}\n`;
}

/**
 * Type-scale CSS helper: a utility-class block (`.t-display`, `.t-h1`, …) mirroring the
 * handoff's `.t-*` classes, generated from the type scale so they never drift from the tokens.
 */
export function typeScaleCss(): string {
  const classFor: Record<keyof typeof type, string> = {
    display: "t-display",
    h1: "t-h1",
    h2: "t-h2",
    h3: "t-h3",
    body: "t-body",
    bodyS: "t-body-s",
    monoLabel: "t-mono-label",
  };

  const blocks: string[] = [];
  for (const [token, spec] of Object.entries(type)) {
    const cls = classFor[token as keyof typeof type];
    const decls = [
      `font-family: ${spec.family};`,
      `font-size: ${spec.size}px;`,
      `font-weight: ${spec.weight};`,
      `letter-spacing: ${spec.tracking}em;`,
    ];
    if (token === "monoLabel") decls.push("text-transform: uppercase;");
    blocks.push(`.${cls} {\n  ${decls.join("\n  ")}\n}`);
  }
  return blocks.join("\n\n") + "\n";
}

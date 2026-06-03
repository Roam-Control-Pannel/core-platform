/**
 * Token + CSS-derivation tests. The design layer is pure data and pure functions, so
 * it is fully unit-testable in-sandbox. These guard two things: (1) the authoritative
 * handoff values survived the port (a fat-fingered hex would fail here), and (2) the
 * derived CSS emits the variable names the ported hi-fi component classes expect.
 */
import { describe, it, expect } from "vitest";
import { color, type, font, space, radius } from "./tokens/index.js";
import { rootCss, typeScaleCss } from "./css.js";

describe("colour tokens (authoritative handoff values)", () => {
  it("crimson brand value is exact", () => {
    expect(color.crimson).toBe("#C2123F");
  });
  it("the full crimson ramp is present", () => {
    expect(color.crimson500).toBe("#D6214E");
    expect(color.crimson600).toBe("#B01038");
    expect(color.crimson700).toBe("#9D0F33");
  });
  it("gold is the reserved accent", () => {
    expect(color.gold).toBe("#CAA14A");
  });
  it("warm-neutral anchors are exact", () => {
    expect(color.paper).toBe("#F6F3EF");
    expect(color.ink).toBe("#211D1A");
    expect(color.card).toBe("#FFFFFF");
  });
});

describe("typography tokens", () => {
  it("uses the three handoff families", () => {
    expect(font.display).toContain("Space Grotesk");
    expect(font.ui).toContain("Schibsted Grotesk");
    expect(font.mono).toContain("Space Mono");
  });
  it("display scale matches the handoff (56/600/-1%)", () => {
    expect(type.display.size).toBe(56);
    expect(type.display.weight).toBe(600);
    expect(type.display.tracking).toBe(-0.01);
  });
  it("mono-label is uppercase-tracked at 11/700/+0.12em", () => {
    expect(type.monoLabel.size).toBe(11);
    expect(type.monoLabel.weight).toBe(700);
    expect(type.monoLabel.tracking).toBe(0.12);
  });
});

describe("spacing + radius ramps", () => {
  it("spacing is the 4px base ramp", () => {
    expect(space[1]).toBe(4);
    expect(space[4]).toBe(16);
    expect(space[16]).toBe(64);
  });
  it("radius matches the CSS render-truth (lg 18, xl 26)", () => {
    expect(radius.sm).toBe(7);
    expect(radius.md).toBe(12);
    expect(radius.lg).toBe(18);
    expect(radius.xl).toBe(26);
  });
});

describe("rootCss() derivation", () => {
  const css = rootCss();
  it("emits a :root block", () => {
    expect(css.startsWith(":root {")).toBe(true);
    expect(css.trimEnd().endsWith("}")).toBe(true);
  });
  it("emits the crimson var with the exact value", () => {
    expect(css).toContain("--crimson: #C2123F;");
  });
  it("kebab-cases multi-part keys to match handoff var names", () => {
    expect(css).toContain("--crimson-600: #B01038;");
    expect(css).toContain("--crimson-tint: #FBE6EC;");
    expect(css).toContain("--ink-hi: #1A1714;");
  });
  it("emits font, spacing, radius and elevation vars", () => {
    expect(css).toContain("--display: 'Space Grotesk', system-ui, sans-serif;");
    expect(css).toContain("--space-4: 16px;");
    expect(css).toContain("--r-md: 12px;");
    expect(css).toContain("--r-full: 9999px;");
    expect(css).toContain("--shadow-key:");
    expect(css).toContain("--ease: cubic-bezier(.2,.8,.2,1);");
  });
});

describe("typeScaleCss() derivation", () => {
  const css = typeScaleCss();
  it("emits the .t-* classes mirroring the handoff", () => {
    expect(css).toContain(".t-display {");
    expect(css).toContain(".t-h1 {");
    expect(css).toContain(".t-mono-label {");
  });
  it("mono-label class is uppercased", () => {
    const block = css.slice(css.indexOf(".t-mono-label"));
    expect(block).toContain("text-transform: uppercase;");
  });
});

/**
 * Pill — ported from the hi-fi `.pill` class and its states.
 *
 * States (roam-hifi.css): default (white, neutral border), on (ink-filled — the active
 * chip), crim (crimson-filled), ghost-crim (crimson-tinted). Modifier: sm. Used for
 * category chips, filter chips, follow buttons, the Links row on a venue profile.
 */
import type { HTMLAttributes, CSSProperties } from "react";

export type PillVariant = "neutral" | "on" | "crim" | "ghost-crim";

export interface PillProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: PillVariant;
  size?: "md" | "sm";
}

const base: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  borderRadius: 999,
  padding: "8px 14px",
  fontSize: 13,
  fontWeight: 600,
  background: "#fff",
  border: "1px solid var(--line-2)",
  color: "var(--ink-2)",
  whiteSpace: "nowrap",
};

const variants: Record<PillVariant, CSSProperties> = {
  neutral: {},
  on: { background: "var(--ink-hi)", color: "#fff", borderColor: "var(--ink-hi)" },
  crim: { background: "var(--crimson)", color: "#fff", borderColor: "var(--crimson)" },
  // Borderless tint chip, per the hi-fi mockup (the "Belfast" / "Offer" chips).
  "ghost-crim": {
    background: "var(--crimson-tint)",
    color: "var(--crimson-700)",
    borderColor: "transparent",
  },
};

const smStyle: CSSProperties = { padding: "5px 11px", fontSize: 11.5 };

export function Pill({
  variant = "neutral",
  size = "md",
  style,
  children,
  ...rest
}: PillProps) {
  const composed: CSSProperties = {
    ...base,
    ...variants[variant],
    ...(size === "sm" ? smStyle : {}),
    ...style,
  };
  return (
    <span style={composed} {...rest}>
      {children}
    </span>
  );
}

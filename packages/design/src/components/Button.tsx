/**
 * Button — ported from the hi-fi `.btn-hi` class and its variants.
 *
 * Variants (from roam-hifi.css): pri (crimson primary), dark (ink), ghost (translucent
 * over photography), plus modifiers block (full-width) and sm. Default is the white
 * neutral button. Styling reads the token CSS vars shipped by @roam/design, so a token
 * change repaints it — the component owns layout/structure, not colour values.
 *
 * Usage rule honoured by convention: one crimson (variant="pri") CTA per view.
 */
import type { ButtonHTMLAttributes, CSSProperties } from "react";

export type ButtonVariant = "neutral" | "pri" | "dark" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  block?: boolean;
  size?: "md" | "sm";
}

const base: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 7,
  borderRadius: 12,
  padding: "11px 16px",
  fontSize: 13.5,
  fontWeight: 600,
  border: "1px solid var(--line-2)",
  background: "#fff",
  color: "var(--ink-hi)",
  fontFamily: "var(--ui)",
  whiteSpace: "nowrap",
  boxShadow: "var(--sh-1)",
  cursor: "pointer",
};

const variants: Record<ButtonVariant, CSSProperties> = {
  neutral: {},
  pri: {
    background: "var(--crimson)",
    color: "#fff",
    borderColor: "var(--crimson)",
    boxShadow: "0 1px 2px rgba(194,18,63,.2),0 8px 20px rgba(194,18,63,.22)",
  },
  dark: { background: "var(--ink-hi)", color: "#fff", borderColor: "var(--ink-hi)" },
  ghost: {
    background: "rgba(255,255,255,.16)",
    color: "#fff",
    borderColor: "rgba(255,255,255,.4)",
    backdropFilter: "blur(6px)",
    boxShadow: "none",
  },
};

const smStyle: CSSProperties = { padding: "8px 13px", fontSize: 12.5, borderRadius: 10 };

export function Button({
  variant = "neutral",
  block = false,
  size = "md",
  style,
  children,
  ...rest
}: ButtonProps) {
  const composed: CSSProperties = {
    ...base,
    ...variants[variant],
    ...(size === "sm" ? smStyle : {}),
    ...(block ? { width: "100%" } : {}),
    ...style,
  };
  return (
    <button style={composed} {...rest}>
      {children}
    </button>
  );
}

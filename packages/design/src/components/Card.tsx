/**
 * Card / Stat — ported from `.card-hi` and `.stat-hi`.
 *
 * Card: white raised surface, lg radius (16 per hi-fi), L1 shadow; `flat` drops shadow.
 * Stat: a KPI tile — big display value + mono uppercase key label, used on the Business
 * overview and the You-profile stat row. `delta` shows up/down change in mono.
 */
import type { HTMLAttributes, CSSProperties, ReactNode } from "react";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  flat?: boolean;
}

export function Card({ flat = false, style, children, ...rest }: CardProps) {
  const composed: CSSProperties = {
    background: "#fff",
    border: "1px solid var(--line)",
    borderRadius: 16,
    boxShadow: flat ? "none" : "var(--sh-1)",
    overflow: "hidden",
    ...style,
  };
  return (
    <div style={composed} {...rest}>
      {children}
    </div>
  );
}

export interface StatProps {
  /** The big number / value. */
  value: ReactNode;
  /** The mono uppercase label beneath it. */
  label: ReactNode;
  /** Optional delta, rendered in mono; direction tints it success/crimson. */
  delta?: { text: ReactNode; direction: "up" | "dn" } | undefined;
  style?: CSSProperties | undefined;
}

export function Stat({ value, label, delta, style }: StatProps) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid var(--line)",
        borderRadius: 14,
        padding: "13px 14px",
        ...style,
      }}
    >
      <div
        style={{
          fontFamily: "var(--display)",
          fontWeight: 600,
          fontSize: 24,
          lineHeight: 1,
          letterSpacing: "-.02em",
        }}
      >
        {value}
      </div>
      <div
        style={{
          fontFamily: "var(--mono)",
          fontSize: 9.5,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: "var(--muted)",
          marginTop: 4,
        }}
      >
        {label}
      </div>
      {delta ? (
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            fontWeight: 700,
            color: delta.direction === "up" ? "var(--success)" : "var(--crimson-700)",
            marginTop: 4,
          }}
        >
          {delta.text}
        </div>
      ) : null}
    </div>
  );
}

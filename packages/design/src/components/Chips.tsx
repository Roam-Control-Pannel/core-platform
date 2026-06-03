/**
 * Rate + DistanceChip + AvatarStack — small inline atoms from the hi-fi CSS.
 *
 * Rate (`.rate`): ★ + value; the star uses GOLD (the one sanctioned gold use besides
 * the Gold tier). DistanceChip (`.km`): mono crimson-tinted distance pill. AvatarStack
 * (`.stack`): overlapping circular avatars (the "X going" cluster on plans/meetups).
 */
import type { CSSProperties, ReactNode } from "react";

export interface RateProps {
  value: number | string;
  style?: CSSProperties | undefined;
}

export function Rate({ value, style }: RateProps) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 12,
        fontWeight: 600,
        color: "var(--ink-hi)",
        ...style,
      }}
    >
      <span style={{ color: "var(--gold)" }}>★</span>
      {value}
    </span>
  );
}

export interface DistanceChipProps {
  children: ReactNode;
  style?: CSSProperties | undefined;
}

export function DistanceChip({ children, style }: DistanceChipProps) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontFamily: "var(--mono)",
        fontSize: 11,
        fontWeight: 700,
        color: "var(--crimson-700)",
        background: "var(--crimson-tint)",
        padding: "3px 8px",
        borderRadius: 999,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export interface AvatarStackProps {
  /** Rendered avatar nodes (image slots / initials). Overlap is applied here. */
  children: ReactNode[];
  size?: number;
  style?: CSSProperties | undefined;
}

export function AvatarStack({ children, size = 26, style }: AvatarStackProps) {
  return (
    <div style={{ display: "flex", ...style }}>
      {children.map((child, i) => (
        <div
          key={i}
          style={{
            width: size,
            height: size,
            borderRadius: "50%",
            border: "2px solid #fff",
            marginLeft: i === 0 ? 0 : -8,
            overflow: "hidden",
          }}
        >
          {child}
        </div>
      ))}
    </div>
  );
}

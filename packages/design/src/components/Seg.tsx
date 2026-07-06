/**
 * Seg — segmented control, ported from `.seg`. The Browse/Feed toggle on Explore and
 * Plans/Trips on Plans. Sunken paper-2 track; the active option is a raised white pill.
 * Controlled: caller owns `value` and `onChange`.
 */
import type { CSSProperties } from "react";

export interface SegOption<T extends string> {
  value: T;
  label: string;
}

export interface SegProps<T extends string> {
  options: readonly SegOption<T>[];
  value: T;
  onChange: (value: T) => void;
  style?: CSSProperties | undefined;
}

export function Seg<T extends string>({ options, value, onChange, style }: SegProps<T>) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: "var(--paper-2)",
        // Fully-rounded sunken track with pill segments, per the hi-fi mockup.
        borderRadius: 999,
        padding: 4,
        gap: 2,
        ...style,
      }}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              fontSize: 12.5,
              fontWeight: 600,
              padding: "7px 15px",
              borderRadius: 999,
              border: 0,
              cursor: "pointer",
              fontFamily: "var(--ui)",
              background: active ? "#fff" : "transparent",
              color: active ? "var(--ink-hi)" : "var(--muted)",
              boxShadow: active ? "var(--sh-1)" : "none",
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

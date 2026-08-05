/**
 * Roam HQ shared UI atoms — the editorial building blocks every view composes:
 * Panel, Kicker/Label, BigStat + Delta, a dependency-free Bars chart, filter Chip,
 * and the relative-time / person-label helpers. All on the theme tokens.
 */
"use client";

import type { ReactNode, CSSProperties } from "react";
import { C, F, label as labelStyle, panel } from "../theme";

export function Panel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...panel, ...style }}>{children}</div>;
}

/** Grey uppercase micro-label (section headers, stat captions). */
export function Label({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div style={{ ...labelStyle, ...style }}>{children}</div>;
}

/** The red "ROAM · INTERNAL" style kicker. */
export function Kicker({ children }: { children: ReactNode }) {
  return (
    <div style={{ fontFamily: F.mono, fontSize: 10.5, letterSpacing: ".14em", textTransform: "uppercase", color: C.muted }}>
      {children}
    </div>
  );
}

/** A red delta chip, e.g. "+11.4% vs prior 7d" or "+186 · 7d". */
export function Delta({ children, tone = "red" }: { children: ReactNode; tone?: "red" | "muted" }) {
  return (
    <span style={{ fontFamily: F.mono, fontSize: 12, fontWeight: 700, color: tone === "red" ? C.red : C.muted }}>
      {children}
    </span>
  );
}

/** A big grotesk numeral with an uppercase caption beneath. */
export function BigStat({
  value,
  caption,
  sub,
  accent = false,
  size = 48,
}: {
  value: ReactNode;
  caption: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
  size?: number;
}) {
  return (
    <div>
      <div
        style={{
          fontFamily: F.display,
          fontWeight: 700,
          fontSize: size,
          lineHeight: 1,
          letterSpacing: "-.03em",
          color: accent ? C.red : C.ink,
        }}
      >
        {value}
      </div>
      <div style={{ ...labelStyle, marginTop: 8 }}>{caption}</div>
      {sub ? <div style={{ marginTop: 6 }}>{sub}</div> : null}
    </div>
  );
}

/** A KPI cell for the bordered strip: value, caption, optional sub-note. */
export function Kpi({ value, caption, note }: { value: ReactNode; caption: ReactNode; note?: ReactNode }) {
  return (
    <div style={{ padding: "13px 15px" }}>
      <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 27, lineHeight: 1, letterSpacing: "-.02em", color: C.ink }}>
        {value}
      </div>
      <div style={{ ...labelStyle, marginTop: 5 }}>{caption}</div>
      {note ? <div style={{ fontFamily: F.mono, fontSize: 10.5, color: C.muted, marginTop: 2 }}>{note}</div> : null}
    </div>
  );
}

export interface Bar {
  value: number;
  highlight?: boolean;
  title?: string;
}

/** A minimal CSS bar chart. Bars scale to the max; one may be highlighted red. */
export function Bars({ bars, height = 120, gap = 4 }: { bars: Bar[]; height?: number; gap?: number }) {
  const max = Math.max(1, ...bars.map((b) => b.value));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap, height }}>
      {bars.map((b, i) => (
        <div
          key={i}
          title={b.title ?? String(b.value)}
          style={{
            flex: 1,
            minWidth: 3,
            height: `${Math.max(2, (b.value / max) * 100)}%`,
            background: b.highlight ? C.red : C.bar,
            borderRadius: 1,
          }}
        />
      ))}
    </div>
  );
}

/** A filter chip (Live Activity type toggles). */
export function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        padding: "5px 11px",
        borderRadius: 3,
        fontFamily: F.ui,
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: ".02em",
        textTransform: "uppercase",
        color: active ? "#fff" : C.inkSoft,
        background: active ? C.ink : "transparent",
        border: `1px solid ${active ? C.ink : C.line}`,
      }}
    >
      {children}
    </button>
  );
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <div style={{ padding: "12px 14px", borderRadius: 4, background: C.redSoft, color: C.redInk, fontSize: 13, fontFamily: F.ui }}>
      {message}
    </div>
  );
}

export function SkeletonBlock({ height = 40, style }: { height?: number; style?: CSSProperties }) {
  return <div style={{ height, borderRadius: 3, background: "#EDEAE5", ...style }} />;
}

/** Compact relative time, e.g. "3m", "5h", "2d", falling back to a date. */
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return new Date(iso).toLocaleDateString();
}

/** Clock time for grouped day rows, e.g. "18:40". */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function personLabel(actor: { handle: string | null; displayName: string | null } | null): string {
  if (!actor) return "Someone";
  if (actor.handle) return `@${actor.handle}`;
  if (actor.displayName) return actor.displayName;
  return "Someone";
}

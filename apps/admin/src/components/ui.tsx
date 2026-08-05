/**
 * Small shared UI atoms for Roam HQ — the mono "kicker" label, section headers, a
 * skeleton block, an inline error line, and a relative-time formatter. Kept tiny and
 * dependency-free; everything sits on the @roam/design token vars (globals.css).
 */
"use client";

import type { ReactNode, CSSProperties } from "react";

/** Mono, uppercase micro-label (the crimson kicker used across the surface). */
export function Kicker({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "crimson" }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        letterSpacing: ".08em",
        textTransform: "uppercase",
        color: tone === "crimson" ? "var(--crimson-700)" : "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        letterSpacing: ".06em",
        textTransform: "uppercase",
        color: "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}

export function SkeletonBlock({ height = 40, style }: { height?: number; style?: CSSProperties }) {
  return <div style={{ height, borderRadius: 10, background: "var(--paper-2)", ...style }} />;
}

export function ErrorLine({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: "var(--space-3) var(--space-4)",
        borderRadius: 10,
        background: "var(--crimson-tint)",
        color: "var(--crimson-700)",
        fontSize: 13,
      }}
    >
      {message}
    </div>
  );
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

/** A person's best display label from handle/name. */
export function personLabel(actor: {
  handle: string | null;
  displayName: string | null;
} | null): string {
  if (!actor) return "Someone";
  if (actor.handle) return `@${actor.handle}`;
  if (actor.displayName) return actor.displayName;
  return "Someone";
}

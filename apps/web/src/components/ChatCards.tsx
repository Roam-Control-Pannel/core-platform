/**
 * ChatCards — renderers for rich message kinds inside a thread (venue_card, plan_card,
 * profile_card, image). Each reads the message's payload snapshot (name/title captured at send)
 * and renders a compact, tappable card that links through to the live entity — no per-message
 * fetch. An unknown/absent payload degrades to a neutral note rather than nothing. Image rendering
 * arrives with Phase 2 (media); until then an image kind shows a quiet placeholder.
 */
"use client";

import Link from "next/link";
import type { MessageKind } from "../lib/chatKinds";

export function MessageCard({ kind, payload }: { kind: MessageKind; payload: Record<string, unknown> | null }) {
  if (payload) {
    if (kind === "venue_card" && typeof payload.venueId === "string") {
      return <RefCard href={`/venue/${payload.venueId}`} icon="📍" title={str(payload.name, "A place")} sub="View venue" />;
    }
    if (kind === "plan_card" && typeof payload.planId === "string") {
      return <RefCard href={`/plans/${payload.planId}`} icon="🗓" title={str(payload.title, "A plan")} sub="View plan" />;
    }
    if (kind === "profile_card" && typeof payload.profileId === "string") {
      const handle = typeof payload.handle === "string" && payload.handle ? `@${payload.handle}` : "View profile";
      return <RefCard href={`/u/${payload.profileId}`} icon="👤" title={str(payload.name, "Someone")} sub={handle} />;
    }
  }
  return <Fallback />;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v : fallback;
}

/** A compact, tappable reference card (the shared-entity chrome shared by all card kinds). */
function RefCard({ href, icon, title, sub }: { href: string; icon: string; title: string; sub: string }) {
  return (
    <Link
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        textDecoration: "none",
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid var(--line)",
        background: "#fff",
        maxWidth: 260,
        boxShadow: "var(--sh-1)",
      }}
    >
      <span aria-hidden style={{ fontSize: 20, lineHeight: 1 }}>{icon}</span>
      <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
        <span style={{ fontFamily: "var(--ui)", fontSize: 14, fontWeight: 600, color: "var(--ink-hi)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        <span style={{ fontFamily: "var(--ui)", fontSize: 12, color: "var(--crimson-700)", fontWeight: 600 }}>{sub} ›</span>
      </span>
    </Link>
  );
}

function Fallback() {
  return (
    <div style={{ padding: "8px 12px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--paper-2)", maxWidth: 260 }}>
      <span style={{ color: "var(--muted)", fontStyle: "italic", fontSize: 13 }}>Unsupported message</span>
    </div>
  );
}

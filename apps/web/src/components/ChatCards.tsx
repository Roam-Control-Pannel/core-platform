/**
 * ChatCards — renderers for rich message kinds inside a thread (venue_card, plan_card,
 * profile_card, image). Each reads the message's payload snapshot (name/title captured at send)
 * and renders a compact, tappable card that links through to the live entity — no per-message
 * fetch. An unknown/absent payload degrades to a neutral note rather than nothing. Image rendering
 * arrives with Phase 2 (media); until then an image kind shows a quiet placeholder.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon, type IconName } from "@roam/design";
import type { MessageKind, PollPayload } from "../lib/chatKinds";
import { chatMediaSignedUrl } from "../lib/uploadChatImage";
import { PollMessage } from "./ChatPoll";

export function MessageCard({
  kind,
  payload,
  messageId,
  mine,
}: {
  kind: MessageKind;
  payload: Record<string, unknown> | null;
  messageId?: string;
  mine?: boolean;
}) {
  if (payload) {
    if (kind === "venue_card" && typeof payload.venueId === "string") {
      return <RefCard href={`/venue/${payload.venueId}`} icon="place" title={str(payload.name, "A place")} sub="View venue" />;
    }
    if (kind === "plan_card" && typeof payload.planId === "string") {
      return <RefCard href={`/plans/${payload.planId}`} icon="plan" title={str(payload.title, "A plan")} sub="View plan" />;
    }
    if (kind === "profile_card" && typeof payload.profileId === "string") {
      const handle = typeof payload.handle === "string" && payload.handle ? `@${payload.handle}` : "View profile";
      return <RefCard href={`/u/${payload.profileId}`} icon="person" title={str(payload.name, "Someone")} sub={handle} />;
    }
    if (kind === "image" && typeof payload.path === "string") {
      return <ImageBubble payload={payload} />;
    }
    if (kind === "poll" && messageId && Array.isArray(payload.options)) {
      return <PollMessage messageId={messageId} payload={payload as unknown as PollPayload} mine={!!mine} />;
    }
  }
  return <Fallback />;
}

/**
 * ImageBubble — renders a chat photo. The bucket is private, so we mint a short-lived signed URL
 * (chatMediaSignedUrl) on mount; the stored dims reserve the box so the layout doesn't jump.
 */
function ImageBubble({ payload }: { payload: Record<string, unknown> }) {
  const path = typeof payload.path === "string" ? payload.path : null;
  const width = typeof payload.width === "number" ? payload.width : null;
  const height = typeof payload.height === "number" ? payload.height : null;
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!path) return;
    let cancelled = false;
    chatMediaSignedUrl(path)
      .then((u) => { if (!cancelled) { if (u) setUrl(u); else setFailed(true); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [path]);

  const maxW = 240;
  const boxH = width && height ? Math.round((maxW / width) * height) : 180;

  if (failed) {
    return (
      <div style={{ padding: "8px 12px", borderRadius: 12, border: "1px solid var(--line)", background: "var(--paper-2)", maxWidth: maxW }}>
        <span style={{ color: "var(--muted)", fontStyle: "italic", fontSize: 13 }}>Photo unavailable</span>
      </div>
    );
  }
  if (!url) {
    return <div style={{ width: maxW, height: Math.min(boxH, 320), borderRadius: 12, background: "var(--paper-2)", border: "1px solid var(--line)" }} />;
  }
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{ display: "block", maxWidth: maxW }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- signed URL to a private bucket; next/image can't optimize a short-lived signed URL */}
      <img
        src={url}
        alt="Shared photo"
        style={{ width: "100%", maxWidth: maxW, maxHeight: 320, height: "auto", objectFit: "cover", borderRadius: 12, border: "1px solid var(--line)", display: "block" }}
      />
    </a>
  );
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" && v.trim() ? v : fallback;
}

/** A compact, tappable reference card (the shared-entity chrome shared by all card kinds). */
function RefCard({ href, icon, title, sub }: { href: string; icon: IconName; title: string; sub: string }) {
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
      <Icon name={icon} size={20} style={{ color: "var(--crimson-700)", flexShrink: 0 }} />
      <span style={{ display: "grid", gap: 1, minWidth: 0 }}>
        <span style={{ fontFamily: "var(--ui)", fontSize: 14, fontWeight: 600, color: "var(--ink-hi)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {title}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 2, fontFamily: "var(--ui)", fontSize: 12, color: "var(--crimson-700)", fontWeight: 600 }}>
          {sub} <Icon name="chevronRight" size={12} />
        </span>
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

/**
 * ThreadAvatar — the icon for a chat thread, everywhere one is shown (inbox list + detail header).
 *
 * Precedence, matching WhatsApp/Messenger:
 *   1. a custom group photo (imageUrl) if one is set;
 *   2. else a COMPOSITE of members' avatars (group/plan) — a 2-up cluster of the first faces,
 *      so a fresh group is personal with zero effort;
 *   3. else the single other-person avatar (direct);
 *   4. else a monogram of the thread name (or a plan glyph for plan chats).
 *
 * Purely presentational — the API (chat.listThreads / chat.getThread) resolves imageUrl and
 * supplies memberAvatars; nothing here fetches or signs.
 */
"use client";

import { Icon } from "@roam/design";

export interface ThreadAvatarProps {
  kind: "plan" | "group" | "direct";
  name: string;
  size?: number;
  /** Signed URL of the custom group photo, when set. */
  imageUrl?: string | null;
  /** Up to ~4 member avatar URLs (public profile-media), for the composite fallback. */
  memberAvatars?: string[];
}

export function ThreadAvatar({ kind, name, size = 42, imageUrl, memberAvatars = [] }: ThreadAvatarProps) {
  const ring = "50%";
  const base: React.CSSProperties = {
    width: size,
    height: size,
    borderRadius: ring,
    flexShrink: 0,
    overflow: "hidden",
    display: "grid",
    placeItems: "center",
    background: kind === "plan" ? "var(--crimson-tint-2)" : "var(--paper-2)",
    color: kind === "plan" ? "var(--crimson-700)" : "var(--ink-2)",
    fontSize: Math.round(size * 0.38),
    fontWeight: 700,
  };

  // 1. Custom group photo.
  if (imageUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- signed chat-media URL; next/image can't sign
      <img src={imageUrl} alt="" style={{ ...base, objectFit: "cover" }} />
    );
  }

  const faces = memberAvatars.filter(Boolean);

  // 2. Composite of member faces for a group/plan with 2+ avatars.
  if (kind !== "direct" && faces.length >= 2) {
    return <Composite faces={faces} size={size} />;
  }

  // 3. Single avatar (a DM, or a group where only one member has a photo).
  if (faces.length === 1) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- public profile-media URL
      <img src={faces[0]} alt="" style={{ ...base, objectFit: "cover" }} />
    );
  }

  // 4. Monogram / plan glyph.
  return (
    <span aria-hidden style={base}>
      {kind === "plan" ? <Icon name="plan" size={Math.round(size * 0.43)} /> : name.charAt(0).toUpperCase() || "·"}
    </span>
  );
}

/** A 2-up split circle of the first two member faces (the rest are implied). */
function Composite({ faces, size }: { faces: string[]; size: number }) {
  const [a, b] = faces;
  const half: React.CSSProperties = { width: size / 2, height: size, objectFit: "cover", display: "block" };
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", flexShrink: 0, display: "flex", background: "var(--paper-2)" }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- public profile-media URLs */}
      <img src={a} alt="" style={{ ...half, borderRight: "1px solid #fff" }} />
      {/* eslint-disable-next-line @next/next/no-img-element -- public profile-media URLs */}
      <img src={b} alt="" style={half} />
    </span>
  );
}

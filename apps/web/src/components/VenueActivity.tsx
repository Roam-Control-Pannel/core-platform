/**
 * VenueActivity — the Business Activity Centre feed on a venue's dashboard. Shows recent things
 * locals did with the business (new follows, offer saves, offer redemptions), newest first, with
 * an unread count and a "Mark all read". Reads venueActivity.list / unreadCount / markRead
 * (owner-gated by RLS). Best-effort and self-hiding on error — it's an at-a-glance pulse, not a
 * blocking surface.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon, type IconName } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { timeAgo } from "../lib/townHall";

interface ActivityItem {
  id: string;
  type: string;
  createdAt: string;
  read: boolean;
  offerTitle: string | null;
  actor: { handle: string | null; displayName: string | null; avatarUrl: string | null } | null;
}

function actorName(a: ActivityItem["actor"]): string {
  if (!a) return "Someone";
  return a.displayName?.trim() || (a.handle ? `@${a.handle}` : "Someone");
}

function glyph(type: string): IconName {
  switch (type) {
    case "follow":
      return "plus";
    case "offer_save":
      return "heart";
    case "offer_redeem":
      return "redeem";
    case "sale":
      return "bag";
    default:
      return "sparkle";
  }
}

function phrase(it: ActivityItem): string {
  const who = actorName(it.actor);
  const what = it.offerTitle ? `“${it.offerTitle}”` : "your offer";
  switch (it.type) {
    case "follow":
      return `${who} started following you`;
    case "offer_save":
      return `${who} saved ${what}`;
    case "offer_redeem":
      return `${who} redeemed ${what}`;
    case "sale":
      return `${who} bought ${what}`;
    default:
      return `${who} interacted with your venue`;
  }
}

export function VenueActivity({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [items, setItems] = useState<ActivityItem[] | undefined>(undefined);
  const [unread, setUnread] = useState(0);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const list = trpc.venueActivity.list as unknown as { query: (i: { venueId: string }) => Promise<ActivityItem[]> };
    const counts = trpc.venueActivity.unreadCount as unknown as { query: (i: { venueId: string }) => Promise<{ count: number }> };
    const [rows, c] = await Promise.all([list.query({ venueId }), counts.query({ venueId })]);
    return { rows: Array.isArray(rows) ? rows : [], count: c?.count ?? 0 };
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    load()
      .then(({ rows, count }) => { if (!cancelled) { setItems(rows); setUnread(count); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [load]);

  const markRead = useCallback(async () => {
    setUnread(0);
    setItems((prev) => (prev ? prev.map((i) => ({ ...i, read: true })) : prev));
    const mut = trpc.venueActivity.markRead as unknown as { mutate: (i: { venueId: string }) => Promise<unknown> };
    try { await mut.mutate({ venueId }); } catch { /* best-effort */ }
  }, [trpc, venueId]);

  if (failed) {
    return <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Couldn&apos;t load activity just now.</p>;
  }
  if (items === undefined) {
    return <div style={{ height: 72, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />;
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: "var(--space-3)" }}>
        <span style={{ fontSize: 13, color: "var(--ink-2)" }}>
          {unread > 0 ? (
            <span style={{ fontWeight: 700, color: "var(--crimson-700)" }}>{unread} new</span>
          ) : (
            "All caught up"
          )}
        </span>
        {unread > 0 ? (
          <button
            type="button"
            onClick={() => void markRead()}
            style={{ all: "unset", cursor: "pointer", fontSize: 12.5, fontWeight: 600, color: "var(--muted)", textDecoration: "underline" }}
          >
            Mark all read
          </button>
        ) : null}
      </div>

      {items.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          No activity yet. As people follow you and save your offers, you&apos;ll see it here.
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
          {items.map((it) => (
            <li
              key={it.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--space-3)",
                padding: "10px 12px",
                borderRadius: "var(--r-md)",
                background: it.read ? "transparent" : "var(--crimson-tint)",
                border: `1px solid ${it.read ? "var(--line)" : "var(--crimson-tint-2)"}`,
              }}
            >
              <span
                aria-hidden
                style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 999, background: "var(--paper-2)", color: "var(--crimson-700)", fontSize: 14, flexShrink: 0 }}
              >
                <Icon name={glyph(it.type)} size={14} />
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, color: "var(--ink)", lineHeight: 1.4 }}>{phrase(it)}</span>
              <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>{timeAgo(it.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

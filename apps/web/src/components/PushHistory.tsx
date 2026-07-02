/**
 * PushHistory — a read-only log of the push notifications a venue has sent to its followers.
 *
 * Derived from posts.mine: every post that targeted the `follower_push` destination fanned out as a
 * web push (costing a credit), so filtering the venue's posts to those gives an accurate "what have
 * I pushed" history — title, a snippet, and when — without any new storage. Owner-only by RLS.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { timeAgo } from "../lib/townHall";

interface MinePost {
  id: string;
  kind: string;
  title: string | null;
  body: string | null;
  destinations: string[];
  publishedAt: string | null;
  createdAt: string;
}

export function PushHistory({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [pushes, setPushes] = useState<MinePost[] | undefined>(undefined);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    const mine = trpc.posts.mine as unknown as { query: (i: { venueId: string; limit?: number }) => Promise<MinePost[]> };
    const rows = await mine.query({ venueId, limit: 100 });
    return (Array.isArray(rows) ? rows : []).filter((p) => (p.destinations ?? []).includes("follower_push"));
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    load().then((r) => { if (!cancelled) setPushes(r); }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [load]);

  if (failed) return <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>Couldn&apos;t load push history just now.</p>;
  if (pushes === undefined) return <div style={{ height: 64, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />;
  if (pushes.length === 0) {
    return (
      <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
        No pushes sent yet. When you post an update and tick “Notify followers”, it&apos;ll appear here.
      </p>
    );
  }

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
      {pushes.map((p) => (
        <li key={p.id} style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)", padding: "10px 12px", borderRadius: "var(--r-md)", border: "1px solid var(--line)", background: "var(--card)" }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 999, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}><Icon name="bell" size={14} /></span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontFamily: "var(--ui)", fontWeight: 600, fontSize: 13.5, color: "var(--ink)" }}>
              {p.title?.trim() || "Update"}
            </div>
            {p.body ? (
              <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                {p.body}
              </p>
            ) : null}
          </div>
          <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>
            {timeAgo(p.publishedAt ?? p.createdAt)}
          </span>
        </li>
      ))}
    </ul>
  );
}

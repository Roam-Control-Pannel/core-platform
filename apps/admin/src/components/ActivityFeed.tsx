/**
 * ActivityFeed — the live, merged site-wide stream (adminActivity.feed): signups, wall
 * posts, Forum topics & replies, follows, events and venue claims, newest first. A small
 * "Refresh" re-pulls; auto-refreshes every 60s while mounted.
 */
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, Pill } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { ErrorLine, Kicker, personLabel, SkeletonBlock, timeAgo } from "./ui";

type ActivityKind = "signup" | "post" | "forum_topic" | "forum_reply" | "follow" | "event" | "venue_claim";

interface ActivityActor {
  id: string;
  handle: string | null;
  displayName: string | null;
  avatarUrl: string | null;
}

interface ActivityItem {
  id: string;
  kind: ActivityKind;
  createdAt: string;
  actor: ActivityActor | null;
  title: string;
  entity: { type: string; id: string } | null;
}

const KIND_LABEL: Record<ActivityKind, string> = {
  signup: "Signup",
  post: "Post",
  forum_topic: "Forum",
  forum_reply: "Forum",
  follow: "Follow",
  event: "Event",
  venue_claim: "Claim",
};

export function ActivityFeed() {
  const trpc = useTrpc();
  const [items, setItems] = useState<ActivityItem[] | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(() => {
    setBusy(true);
    (trpc.adminActivity.feed.query({ limit: 40 }) as Promise<ActivityItem[]>)
      .then((d) => {
        if (!mounted.current) return;
        setItems(d);
        setError(null);
      })
      .catch((e: unknown) => mounted.current && setError(e instanceof Error ? e.message : "Failed to load activity."))
      .finally(() => mounted.current && setBusy(false));
  }, [trpc]);

  useEffect(() => {
    mounted.current = true;
    load();
    const t = setInterval(load, 60_000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [load]);

  return (
    <Card style={{ padding: "var(--space-5)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <Kicker tone="crimson">Live activity</Kicker>
        <button
          type="button"
          onClick={load}
          disabled={busy}
          style={{ all: "unset", cursor: busy ? "default" : "pointer", fontFamily: "var(--mono)", fontSize: 11, color: "var(--muted)", textDecoration: "underline" }}
        >
          {busy ? "…" : "Refresh"}
        </button>
      </div>

      {error ? (
        <ErrorLine message={error} />
      ) : !items ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonBlock key={i} height={44} />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 13, padding: "var(--space-4) 0" }}>Nothing yet.</div>
      ) : (
        <div style={{ display: "grid" }}>
          {items.map((it, i) => (
            <Row key={it.id} item={it} first={i === 0} />
          ))}
        </div>
      )}
    </Card>
  );
}

function Row({ item, first }: { item: ActivityItem; first: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-3)",
        padding: "var(--space-3) 0",
        borderTop: first ? "none" : "1px solid var(--line)",
      }}
    >
      <Pill variant="neutral" size="sm">{KIND_LABEL[item.kind]}</Pill>
      <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.4 }}>
        <strong style={{ color: "var(--ink-hi)" }}>{personLabel(item.actor)}</strong> {item.title}
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)", whiteSpace: "nowrap" }}>{timeAgo(item.createdAt)}</div>
    </div>
  );
}

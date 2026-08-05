/**
 * ContentBreakdown — all-time content & social totals (adminMetrics.contentBreakdown),
 * rendered as a compact stat row beneath the growth chart.
 */
"use client";

import { useEffect, useState } from "react";
import { Stat } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { ErrorLine, SkeletonBlock } from "./ui";

interface Breakdown {
  posts: number;
  forumTopics: number;
  forumReplies: number;
  follows: number;
  friendships: number;
  events: number;
  redemptions: number;
}

const grid = {
  display: "grid",
  gap: "var(--space-3)",
  gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
} as const;

export function ContentBreakdown() {
  const trpc = useTrpc();
  const [data, setData] = useState<Breakdown | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminMetrics.contentBreakdown.query() as Promise<Breakdown>)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load breakdown."));
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  if (error) return <ErrorLine message={error} />;
  if (!data) {
    return (
      <div style={grid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonBlock key={i} height={62} style={{ borderRadius: 16 }} />
        ))}
      </div>
    );
  }

  const f = (n: number) => n.toLocaleString();
  return (
    <div style={grid}>
      <Stat value={f(data.posts)} label="Wall posts" />
      <Stat value={f(data.forumTopics)} label="Forum topics" />
      <Stat value={f(data.forumReplies)} label="Forum replies" />
      <Stat value={f(data.follows)} label="Venue follows" />
      <Stat value={f(data.friendships)} label="Friendships" />
      <Stat value={f(data.events)} label="Events" />
      <Stat value={f(data.redemptions)} label="Offer redemptions" />
    </div>
  );
}

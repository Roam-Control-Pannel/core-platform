/**
 * Pulse — the dashboard's top strip of headline numbers (adminMetrics.pulse).
 * Stat tiles on the shared design system; state ladder error → skeleton → content.
 */
"use client";

import { useEffect, useState } from "react";
import { Stat } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { ErrorLine, SkeletonBlock } from "./ui";

interface PulseData {
  users: { total: number; new24h: number; new7d: number; new30d: number };
  venues: { total: number; claimed: number; new30d: number };
  content: { posts7d: number; forum7d: number };
  generatedAt: string;
}

const grid = {
  display: "grid",
  gap: "var(--space-3)",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
} as const;

export function Pulse() {
  const trpc = useTrpc();
  const [data, setData] = useState<PulseData | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminMetrics.pulse.query() as Promise<PulseData>)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load pulse."));
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  if (error) return <ErrorLine message={error} />;
  if (!data) {
    return (
      <div style={grid}>
        {Array.from({ length: 6 }).map((_, i) => (
          <SkeletonBlock key={i} height={74} style={{ borderRadius: 16 }} />
        ))}
      </div>
    );
  }

  const fmt = (n: number) => n.toLocaleString();
  return (
    <div style={grid}>
      <Stat
        value={fmt(data.users.total)}
        label="Total members"
        delta={data.users.new24h > 0 ? { text: `+${fmt(data.users.new24h)} today`, direction: "up" } : undefined}
      />
      <Stat value={`+${fmt(data.users.new7d)}`} label="New · 7 days" />
      <Stat value={`+${fmt(data.users.new30d)}`} label="New · 30 days" />
      <Stat
        value={fmt(data.venues.total)}
        label="Venues"
        delta={data.venues.new30d > 0 ? { text: `+${fmt(data.venues.new30d)} · 30d`, direction: "up" } : undefined}
      />
      <Stat value={fmt(data.venues.claimed)} label="Claimed venues" />
      <Stat value={fmt(data.content.posts7d)} label="Wall posts · 7d" />
      <Stat value={fmt(data.content.forum7d)} label="Forum activity · 7d" />
    </div>
  );
}

/**
 * ModerationQueue — the open trust & safety queue (adminActivity.moderationQueue),
 * oldest-first (longest-waiting on top). Read-only in v1; the resolve/act controls
 * arrive in Phase 3.
 */
"use client";

import { useEffect, useState } from "react";
import { Card, Pill } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { ErrorLine, Kicker, SkeletonBlock, timeAgo } from "./ui";

interface QueueItem {
  id: string;
  entityType: string;
  entityId: string;
  reason: string;
  reporterId: string | null;
  detail: string | null;
  status: string;
  createdAt: string;
}

interface QueueResult {
  pendingCount: number;
  items: QueueItem[];
}

export function ModerationQueue() {
  const trpc = useTrpc();
  const [data, setData] = useState<QueueResult | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (trpc.adminActivity.moderationQueue.query({ limit: 25 }) as Promise<QueueResult>)
      .then((d) => !cancelled && setData(d))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : "Failed to load queue."));
    return () => {
      cancelled = true;
    };
  }, [trpc]);

  return (
    <Card style={{ padding: "var(--space-5)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "var(--space-4)" }}>
        <Kicker tone="crimson">Trust &amp; safety</Kicker>
        {data ? (
          <Pill variant={data.pendingCount > 0 ? "ghost-crim" : "neutral"} size="sm">
            {data.pendingCount} pending
          </Pill>
        ) : null}
      </div>

      {error ? (
        <ErrorLine message={error} />
      ) : !data ? (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonBlock key={i} height={48} />
          ))}
        </div>
      ) : data.items.length === 0 ? (
        <div style={{ color: "var(--muted)", fontSize: 13, padding: "var(--space-2) 0" }}>
          Queue is clear — nothing awaiting review.
        </div>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-2)" }}>
          {data.items.map((it) => (
            <div key={it.id} style={{ display: "grid", gap: 4, padding: "var(--space-3)", borderRadius: 10, background: "var(--paper-2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                <Pill variant="neutral" size="sm">{it.entityType}</Pill>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: it.reason === "auto_flag" ? "var(--crimson-700)" : "var(--muted)" }}>
                  {it.reason}
                </span>
                <span style={{ flex: 1 }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)" }}>{timeAgo(it.createdAt)}</span>
              </div>
              {it.detail ? <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4 }}>{it.detail}</div> : null}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

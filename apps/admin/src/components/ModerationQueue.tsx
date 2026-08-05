/**
 * ModerationQueue — the open trust & safety queue (adminActivity.moderationQueue),
 * oldest-first (longest-waiting on top). Read-only in v1; the resolve/act controls
 * arrive in Phase 3.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, Pill, Button } from "@roam/design";
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

export function ModerationQueue({ canAct = false }: { canAct?: boolean }) {
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

  const resolve = useCallback(
    async (reportId: string, decision: "approved" | "rejected") => {
      const mut = trpc.adminActions.resolveReport as unknown as {
        mutate: (i: { reportId: string; decision: "approved" | "rejected" }) => Promise<{ ok: true }>;
      };
      await mut.mutate({ reportId, decision });
      setData((prev) =>
        prev
          ? { pendingCount: Math.max(0, prev.pendingCount - 1), items: prev.items.filter((it) => it.id !== reportId) }
          : prev,
      );
    },
    [trpc],
  );

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
            <QueueRow key={it.id} item={it} canAct={canAct} onResolve={resolve} />
          ))}
        </div>
      )}
    </Card>
  );
}

function QueueRow({
  item,
  canAct,
  onResolve,
}: {
  item: QueueItem;
  canAct: boolean;
  onResolve: (id: string, decision: "approved" | "rejected") => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const act = async (decision: "approved" | "rejected") => {
    setBusy(true);
    setErr(null);
    try {
      await onResolve(item.id, decision);
    } catch (e) {
      setBusy(false);
      setErr(e instanceof Error ? e.message : "Action failed.");
    }
  };

  return (
    <div style={{ display: "grid", gap: 6, padding: "var(--space-3)", borderRadius: 10, background: "var(--paper-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        <Pill variant="neutral" size="sm">{item.entityType}</Pill>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: ".05em", color: item.reason === "auto_flag" ? "var(--crimson-700)" : "var(--muted)" }}>
          {item.reason}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)" }}>{timeAgo(item.createdAt)}</span>
      </div>
      {item.detail ? <div style={{ fontSize: 12, color: "var(--ink-2)", lineHeight: 1.4 }}>{item.detail}</div> : null}
      {canAct ? (
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", marginTop: 2 }}>
          <Button variant="neutral" size="sm" onClick={() => void act("approved")} disabled={busy}>
            {busy ? "…" : "Keep"}
          </Button>
          <Button variant="pri" size="sm" onClick={() => void act("rejected")} disabled={busy}>
            {busy ? "…" : "Action & close"}
          </Button>
          {err ? <span style={{ fontSize: 11, color: "var(--crimson-700)" }}>{err}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

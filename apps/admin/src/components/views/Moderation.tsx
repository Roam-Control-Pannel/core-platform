/**
 * Moderation — the full trust & safety queue as its own view. Oldest-first (longest
 * waiting on top). Acting roles (admin/owner) get Keep / Action-&-close per item;
 * resolving one removes it and pings onChanged so the sidebar badge updates.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrpc } from "../TrpcProvider";
import { C, F } from "../../theme";
import { ErrorLine, Kicker, Panel, SkeletonBlock, timeAgo } from "../ui";

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
interface QueueResult { pendingCount: number; items: QueueItem[] }

export function ModerationView({ canAct, onChanged }: { canAct: boolean; onChanged: () => void }) {
  const trpc = useTrpc();
  const [data, setData] = useState<QueueResult | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    (trpc.adminActivity.moderationQueue.query({ limit: 100 }) as Promise<QueueResult>)
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load queue."));
  }, [trpc]);
  useEffect(() => { load(); }, [load]);

  const resolve = useCallback(
    async (reportId: string, decision: "approved" | "rejected") => {
      const mut = trpc.adminActions.resolveReport as unknown as { mutate: (i: { reportId: string; decision: "approved" | "rejected" }) => Promise<{ ok: true }> };
      await mut.mutate({ reportId, decision });
      setData((prev) => (prev ? { pendingCount: Math.max(0, prev.pendingCount - 1), items: prev.items.filter((it) => it.id !== reportId) } : prev));
      onChanged();
    },
    [trpc, onChanged],
  );

  return (
    <div style={{ display: "grid", gap: 20 }}>
      <header>
        <Kicker>Roam · Internal</Kicker>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h1 style={{ fontFamily: F.display, fontWeight: 700, fontSize: 40, letterSpacing: "-.03em", margin: "2px 0 0" }}>Moderation</h1>
          {data ? <span style={{ fontFamily: F.mono, fontSize: 13, color: data.pendingCount > 0 ? C.red : C.muted }}>{data.pendingCount} pending</span> : null}
        </div>
      </header>

      {error ? <ErrorLine message={error} /> : !data ? (
        <div style={{ display: "grid", gap: 10 }}>{Array.from({ length: 4 }).map((_, i) => <SkeletonBlock key={i} height={72} />)}</div>
      ) : data.items.length === 0 ? (
        <Panel style={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontFamily: F.display, fontWeight: 700, fontSize: 20, marginBottom: 6 }}>Queue is clear</div>
          <div style={{ color: C.muted, fontSize: 14 }}>Nothing awaiting review right now.</div>
        </Panel>
      ) : (
        <div style={{ display: "grid", gap: 10 }}>
          {data.items.map((it) => <Row key={it.id} item={it} canAct={canAct} onResolve={resolve} />)}
        </div>
      )}
    </div>
  );
}

function Row({ item, canAct, onResolve }: { item: QueueItem; canAct: boolean; onResolve: (id: string, d: "approved" | "rejected") => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const act = async (d: "approved" | "rejected") => {
    setBusy(true); setErr(null);
    try { await onResolve(item.id, d); } catch (e) { setBusy(false); setErr(e instanceof Error ? e.message : "Action failed."); }
  };
  return (
    <Panel style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ fontFamily: F.mono, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "#fff", background: C.ink, borderRadius: 3, padding: "2px 7px" }}>{item.entityType}</span>
        <span style={{ fontFamily: F.mono, fontSize: 11, textTransform: "uppercase", letterSpacing: ".05em", color: item.reason === "auto_flag" ? C.red : C.muted }}>{item.reason}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: F.mono, fontSize: 11, color: C.faint }}>{timeAgo(item.createdAt)}</span>
      </div>
      {item.detail ? <div style={{ fontSize: 13.5, color: C.inkSoft, lineHeight: 1.45, marginTop: 10 }}>{item.detail}</div> : null}
      {canAct ? (
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 14 }}>
          <button type="button" onClick={() => void act("approved")} disabled={busy} style={ghostBtn}>{busy ? "…" : "Keep"}</button>
          <button type="button" onClick={() => void act("rejected")} disabled={busy} style={dangerBtn}>{busy ? "…" : "Action & close"}</button>
          {err ? <span style={{ fontSize: 12, color: C.redInk }}>{err}</span> : null}
        </div>
      ) : null}
    </Panel>
  );
}

const ghostBtn: React.CSSProperties = {
  all: "unset", cursor: "pointer", padding: "7px 14px", border: `1px solid ${C.lineStrong}`, borderRadius: 4,
  fontFamily: F.ui, fontSize: 13, fontWeight: 600, color: C.ink, textAlign: "center",
};
const dangerBtn: React.CSSProperties = {
  all: "unset", cursor: "pointer", padding: "7px 14px", background: C.red, color: "#fff", borderRadius: 4,
  fontFamily: F.ui, fontSize: 13, fontWeight: 700, textAlign: "center",
};

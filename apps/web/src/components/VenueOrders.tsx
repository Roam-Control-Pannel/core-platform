/**
 * VenueOrders — the dashboard Shop tab's order management list. Each order: what sold,
 * amount (with Roam's fee shown honestly), state chip, the voucher code where relevant,
 * and the two owner actions — mark fulfilled (Collected / Redeemed by kind) and Refund
 * (full refund; Stripe pulls the funds back and returns Roam's fee).
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import { useTrpc } from "./TrpcProvider";
import { Button } from "@roam/design";
import { formatPence } from "../lib/money";
import { timeAgo } from "../lib/townHall";

interface VOrder {
  id: string;
  title: string;
  kind: string;
  quantity: number;
  amountPence: number;
  feePence: number;
  currency: string;
  status: string;
  redeemCode: string | null;
  createdAt: string;
}

export function VenueOrders({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const [orders, setOrders] = useState<VOrder[] | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = trpc.market.venueOrders as unknown as { query: (i: { venueId: string }) => Promise<VOrder[]> };
    return q.query({ venueId });
  }, [trpc, venueId]);

  useEffect(() => {
    let cancelled = false;
    load().then((r) => { if (!cancelled) setOrders(Array.isArray(r) ? r : []); }).catch(() => { if (!cancelled) setOrders([]); });
    return () => { cancelled = true; };
  }, [load]);

  const act = useCallback(async (orderId: string, action: "fulfil" | "refund") => {
    if (action === "refund" && !window.confirm("Fully refund this order? The buyer gets everything back.")) return;
    setBusy(orderId);
    setError(null);
    try {
      const proc = (action === "fulfil" ? trpc.market.fulfilOrder : trpc.market.refundOrder) as unknown as {
        mutate: (i: { orderId: string }) => Promise<{ ok: boolean }>;
      };
      await proc.mutate({ orderId });
      setOrders(await load());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "That didn't work — try again.");
    } finally {
      setBusy(null);
    }
  }, [trpc, load]);

  if (orders === undefined) return <div style={{ height: 80, borderRadius: 14, background: "var(--paper-2)" }} aria-hidden />;
  if (orders.length === 0) {
    return <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>No orders yet — they land here the moment someone buys from your shop.</p>;
  }

  return (
    <div>
      {error ? <p role="alert" style={{ margin: "0 0 var(--space-2)", color: "var(--crimson-700)", fontSize: 13 }}>{error}</p> : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
        {orders.map((o) => (
          <li key={o.id} style={{ padding: "12px 14px", borderRadius: 14, border: "1px solid var(--line)", background: "var(--card)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--ui)", fontWeight: 600, fontSize: 14 }}>
                  {o.title}{o.quantity > 1 ? ` × ${o.quantity}` : ""}
                </div>
                <div style={{ marginTop: 2, fontSize: 12, color: "var(--muted)" }}>
                  {formatPence(o.amountPence, o.currency)} · Roam fee {formatPence(o.feePence, o.currency)} · {timeAgo(o.createdAt)}
                  {o.redeemCode ? <> · code <code style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{o.redeemCode}</code></> : null}
                </div>
              </div>
              <span style={{ flexShrink: 0, padding: "3px 9px", borderRadius: 999, fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: o.status === "paid" || o.status === "collected" || o.status === "redeemed" ? "var(--success)" : "var(--muted)", background: o.status === "paid" || o.status === "collected" || o.status === "redeemed" ? "var(--success-tint)" : "var(--paper-2)" }}>
                {o.status}
              </span>
            </div>
            {o.status === "paid" ? (
              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 8 }}>
                <Button variant="pri" size="sm" onClick={() => void act(o.id, "fulfil")} disabled={busy === o.id}>
                  {o.kind === "service" ? "Mark redeemed" : "Mark collected"}
                </Button>
                <Button variant="neutral" size="sm" onClick={() => void act(o.id, "refund")} disabled={busy === o.id}>
                  Refund
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

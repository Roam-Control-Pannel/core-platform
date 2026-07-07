/**
 * MyOrders — /orders: the buyer's purchase history. Each row: what, where, amount, a status
 * chip, and — for paid vouchers/services — the REDEEM CODE to show in-venue. Landing back
 * from Stripe (?placed=...) shows a success note; payment confirmation itself arrives via
 * the webhook, so a just-placed order may read "pending" for a few seconds — said honestly.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { AuthPanel } from "./AuthPanel";
import { formatPence } from "../lib/money";
import { timeAgo } from "../lib/townHall";

interface OrderRow {
  id: string;
  venueId: string;
  venueName: string;
  venueLocality: string | null;
  title: string;
  kind: string;
  quantity: number;
  amountPence: number;
  currency: string;
  status: string;
  redeemCode: string | null;
  createdAt: string;
}

const STATUS_LABEL: Record<string, { label: string; ok?: boolean }> = {
  pending: { label: "Awaiting payment" },
  paid: { label: "Paid", ok: true },
  collected: { label: "Collected", ok: true },
  redeemed: { label: "Redeemed", ok: true },
  refunded: { label: "Refunded" },
  canceled: { label: "Canceled" },
};

export function MyOrders() {
  const trpc = useTrpc();
  const session = useSession();
  const [orders, setOrders] = useState<OrderRow[] | undefined>(undefined);
  const [placed, setPlaced] = useState(false);

  useEffect(() => {
    setPlaced(new URLSearchParams(window.location.search).has("placed"));
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    const q = trpc.market.myOrders as unknown as { query: () => Promise<OrderRow[]> };
    q.query()
      .then((r) => { if (!cancelled) setOrders(Array.isArray(r) ? r : []); })
      .catch(() => { if (!cancelled) setOrders([]); });
    return () => { cancelled = true; };
  }, [trpc, session]);

  if (!session) {
    return (
      <main style={{ maxWidth: 640, margin: "0 auto", padding: "var(--space-6) var(--space-4)" }}>
        <AuthPanel intro="Sign in to see your orders." emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""} onAuthed={() => {}} />
      </main>
    );
  }

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 26, letterSpacing: "-.02em", margin: "0 0 var(--space-2)" }}>
        Your orders
      </h1>
      {placed ? (
        <p style={{ margin: "0 0 var(--space-4)", padding: "10px 14px", borderRadius: 12, background: "var(--success-tint)", color: "var(--success)", fontSize: 13.5, fontWeight: 600 }}>
          Order placed — it&apos;ll show as Paid here within a few seconds of Stripe confirming.
        </p>
      ) : null}

      {orders === undefined ? (
        <div style={{ height: 120, borderRadius: 16, background: "var(--paper-2)" }} aria-hidden />
      ) : orders.length === 0 ? (
        <p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>
          Nothing yet — venue shops across Roam are stocking up. Find something in{" "}
          <Link href="/explore" style={{ color: "var(--crimson-700)" }}>Explore</Link>.
        </p>
      ) : (
        <div style={{ display: "grid", gap: "var(--space-3)" }}>
          {orders.map((o) => {
            const s = STATUS_LABEL[o.status] ?? { label: o.status };
            return (
              <Card key={o.id} style={{ padding: "var(--space-4)" }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15.5 }}>
                      {o.title}{o.quantity > 1 ? ` × ${o.quantity}` : ""}
                    </div>
                    <div style={{ marginTop: 3, fontSize: 13, color: "var(--ink-2)" }}>
                      {o.venueName}{o.venueLocality ? ` · ${o.venueLocality}` : ""} · {timeAgo(o.createdAt)}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 16 }}>{formatPence(o.amountPence, o.currency)}</div>
                    <span style={{ display: "inline-block", marginTop: 4, padding: "3px 10px", borderRadius: 999, fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: s.ok ? "var(--success)" : "var(--muted)", background: s.ok ? "var(--success-tint)" : "var(--paper-2)" }}>
                      {s.label}
                    </span>
                  </div>
                </div>
                {o.redeemCode ? (
                  <div style={{ marginTop: "var(--space-3)", padding: "10px 14px", borderRadius: 12, border: "1px dashed var(--line)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>Show this code in venue to redeem:</span>
                    <code style={{ fontFamily: "var(--mono)", fontWeight: 700, fontSize: 16, letterSpacing: ".12em", color: "var(--crimson-700)" }}>{o.redeemCode}</code>
                  </div>
                ) : null}
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}

/**
 * VenueOrders — the dashboard Shop tab's order management list. Each order: what sold,
 * amount (with Roam's fee shown honestly), state chip, the voucher code where relevant,
 * and the two owner actions — mark fulfilled (Collected / Redeemed by kind) and Refund
 * (full refund; Stripe pulls the funds back and returns Roam's fee).
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useTrpc } from "./TrpcProvider";
import { Button, Pill } from "@roam/design";
import { formatPence } from "../lib/money";
import { timeAgo } from "../lib/townHall";
import { formatClock } from "../lib/readyTime";

type Filter = "all" | "paid" | "fulfilled" | "refunded";
/** Filter keys → catalogue label keys (venueOrders.filters.*). */
const FILTERS: Filter[] = ["all", "paid", "fulfilled", "refunded"];

/** Order-status wire values → catalogue label keys (venueOrders.status.*). Unknown statuses
 *  fall back to the raw wire value at the render site. */
const STATUS_KEY: Record<string, string> = {
  pending: "pending",
  paid: "paid",
  ready: "ready",
  collected: "collected",
  redeemed: "redeemed",
  refunded: "refunded",
  canceled: "canceled",
};

/** Statuses shown in success green (money in + still-good) vs muted (pending/terminal). */
const POSITIVE = new Set(["paid", "ready", "collected", "redeemed"]);

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
  readyAt: string | null;
  createdAt: string;
}

export function VenueOrders({ venueId }: { venueId: string }) {
  const t = useTranslations("venueOrders");
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

  const act = useCallback(async (orderId: string, action: "ready" | "fulfil" | "refund") => {
    if (action === "refund" && !window.confirm(t("refundConfirm"))) return;
    setBusy(orderId);
    setError(null);
    try {
      const proc = (
        action === "ready" ? trpc.market.markReady : action === "fulfil" ? trpc.market.fulfilOrder : trpc.market.refundOrder
      ) as unknown as { mutate: (i: { orderId: string }) => Promise<{ ok: boolean }> };
      await proc.mutate({ orderId });
      setOrders(await load());
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("actionFailed"));
    } finally {
      setBusy(null);
    }
  }, [trpc, load]);

  const [filter, setFilter] = useState<Filter>("all");
  const [code, setCode] = useState("");
  const [codeNote, setCodeNote] = useState<string | null>(null);

  const shown = useMemo(() => {
    if (!orders) return [];
    if (filter === "all") return orders;
    if (filter === "paid") return orders.filter((o) => o.status === "paid" || o.status === "ready");
    if (filter === "fulfilled") return orders.filter((o) => o.status === "collected" || o.status === "redeemed");
    return orders.filter((o) => o.status === "refunded");
  }, [orders, filter]);

  // The in-venue moment: customer reads their code, staff types it, one press redeems.
  const verifyCode = useCallback(async () => {
    const wanted = code.trim().toUpperCase();
    if (!wanted) return;
    const match = orders?.find((o) => o.redeemCode?.toUpperCase() === wanted);
    if (!match) return setCodeNote(t("code.noMatch"));
    if (match.status !== "paid" && match.status !== "ready") {
      const statusLabel = STATUS_KEY[match.status] ? t(`status.${STATUS_KEY[match.status]}`) : match.status;
      return setCodeNote(t("code.alreadyStatus", { status: statusLabel }));
    }
    setCodeNote(null);
    await act(match.id, "fulfil");
    setCode("");
    setCodeNote(t("code.redeemedNote", { title: match.title }));
  }, [code, orders, act]);

  if (orders === undefined) return <div style={{ height: 80, borderRadius: 14, background: "var(--paper-2)" }} aria-hidden />;
  if (orders.length === 0) {
    return <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>{t("empty")}</p>;
  }

  return (
    <div>
      {/* Redeem-a-code: staff type what the customer shows and confirm in one press. */}
      <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <input
          value={code}
          onChange={(e) => { setCode(e.target.value); setCodeNote(null); }}
          onKeyDown={(e) => { if (e.key === "Enter") void verifyCode(); }}
          placeholder={t("code.placeholder")}
          aria-label={t("code.aria")}
          style={{ flex: "1 1 140px", boxSizing: "border-box", padding: "8px 12px", background: "var(--paper-2)", border: "1px solid var(--line)", borderRadius: 999, fontFamily: "var(--mono)", fontSize: 14, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--ink)", outline: "none" }}
        />
        <Button variant="pri" size="sm" onClick={() => void verifyCode()} disabled={busy !== null || !code.trim()}>{t("code.verify")}</Button>
        {codeNote ? <span style={{ fontSize: 12.5, fontWeight: 600, color: codeNote.startsWith("✓") ? "var(--success)" : "var(--crimson-700)" }}>{codeNote}</span> : null}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        {FILTERS.map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)} style={{ all: "unset", cursor: "pointer" }}>
            <Pill variant={filter === f ? "crim" : "neutral"} size="sm">{t(`filters.${f}`)}</Pill>
          </button>
        ))}
      </div>

      {error ? <p role="alert" style={{ margin: "0 0 var(--space-2)", color: "var(--crimson-700)", fontSize: 13 }}>{error}</p> : null}
      {shown.length === 0 ? <p style={{ margin: 0, fontSize: 13, color: "var(--muted)" }}>{t("emptyFiltered")}</p> : null}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
        {shown.map((o) => (
          <li key={o.id} style={{ padding: "12px 14px", borderRadius: 14, border: "1px solid var(--line)", background: "var(--card)" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontFamily: "var(--ui)", fontWeight: 600, fontSize: 14 }}>
                  {o.title}{o.quantity > 1 ? ` × ${o.quantity}` : ""}
                </div>
                <div style={{ marginTop: 2, fontSize: 12, color: "var(--muted)" }}>
                  {formatPence(o.amountPence, o.currency)} · {t("roamFee", { fee: formatPence(o.feePence, o.currency) })} · {timeAgo(o.createdAt)}
                  {o.redeemCode ? <> · {t("codeWord")} <code style={{ fontFamily: "var(--mono)", fontWeight: 700 }}>{o.redeemCode}</code></> : null}
                  {o.readyAt && (o.status === "paid" || o.status === "ready") ? <> · {t("readyBy", { time: formatClock(o.readyAt) })}</> : null}
                </div>
              </div>
              <span style={{ flexShrink: 0, padding: "3px 9px", borderRadius: 999, fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase", color: POSITIVE.has(o.status) ? "var(--success)" : "var(--muted)", background: POSITIVE.has(o.status) ? "var(--success-tint)" : "var(--paper-2)" }}>
                {STATUS_KEY[o.status] ? t(`status.${STATUS_KEY[o.status]}`) : o.status}
              </span>
            </div>
            {o.status === "paid" || o.status === "ready" ? (
              <div style={{ display: "flex", gap: "var(--space-2)", marginTop: 8, flexWrap: "wrap" }}>
                {/* Order-ahead: a product can be marked READY (pings the buyer) before it's collected.
                    Services (vouchers) skip 'ready' — they're redeemed on use. A vendor may also mark
                    collected straight from paid. */}
                {o.status === "paid" && o.kind === "product" ? (
                  <Button variant="pri" size="sm" onClick={() => void act(o.id, "ready")} disabled={busy === o.id}>
                    {t("markReady")}
                  </Button>
                ) : null}
                <Button
                  variant={o.status === "ready" ? "pri" : "neutral"}
                  size="sm"
                  onClick={() => void act(o.id, "fulfil")}
                  disabled={busy === o.id}
                >
                  {o.kind === "service" ? t("markRedeemed") : t("markCollected")}
                </Button>
                <Button variant="neutral" size="sm" onClick={() => void act(o.id, "refund")} disabled={busy === o.id}>
                  {t("refund")}
                </Button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

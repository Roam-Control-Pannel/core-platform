/**
 * VenueShop — the PUBLIC venue page's Shop tab: the live catalogue as a browsable grid,
 * now with real buying (marketplace PR 3). When the venue's payouts are active (`sellable`),
 * each in-stock card gets a Buy button → market.checkout → Stripe's hosted payment page →
 * back to /orders. Signed-out visitors get the just-in-time nudge instead of a dead button;
 * a venue that hasn't finished payout onboarding shows the honest "buying opens soon" note.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, Pill, Icon, Button } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { formatPence } from "../lib/money";

interface ShopItem {
  id: string;
  kind: "product" | "service";
  title: string;
  description: string | null;
  pricePence: number;
  currency: string;
  stock: number | null;
  photoUrl: string | null;
}

export function VenueShop({ venueId }: { venueId: string }) {
  const trpc = useTrpc();
  const session = useSession();
  const [items, setItems] = useState<ShopItem[] | undefined>(undefined);
  const [sellable, setSellable] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const list = trpc.market.listByVenue as unknown as {
      query: (i: { venueId: string }) => Promise<{ sellable: boolean; products: ShopItem[] }>;
    };
    list
      .query({ venueId })
      .then((r) => {
        if (cancelled) return;
        setItems(Array.isArray(r?.products) ? r.products : []);
        setSellable(!!r?.sellable);
      })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [trpc, venueId]);

  const buy = useCallback(async (productId: string, quantity: number) => {
    setBuying(productId);
    setError(null);
    try {
      const checkout = trpc.market.checkout as unknown as {
        mutate: (i: { productId: string; quantity: number }) => Promise<{ url: string }>;
      };
      const { url } = await checkout.mutate({ productId, quantity });
      window.location.href = url; // Stripe-hosted payment page
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Couldn't start checkout.");
      setBuying(null);
    }
  }, [trpc]);

  if (items === undefined) {
    return <div style={{ height: 140, borderRadius: 16, background: "var(--paper-2)" }} aria-hidden />;
  }
  if (items.length === 0) {
    return (
      <p style={{ margin: 0, color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>
        This venue hasn&apos;t stocked its Roam shop yet — check back soon.
      </p>
    );
  }

  return (
    <div>
      {error ? <p role="alert" style={{ margin: "0 0 var(--space-3)", color: "var(--crimson-700)", fontSize: 13 }}>{error}</p> : null}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "var(--space-3)" }}>
        {items.map((p) => {
          const soldOut = p.stock === 0;
          return (
            <Card key={p.id} style={{ overflow: "hidden" }}>
              {p.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                <img src={p.photoUrl} alt="" loading="lazy" style={{ display: "block", width: "100%", height: 120, objectFit: "cover" }} />
              ) : (
                <div aria-hidden style={{ height: 120, display: "grid", placeItems: "center", background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))", color: "var(--crimson-700)" }}>
                  <Icon name={p.kind === "service" ? "ticket" : "bag"} size={28} />
                </div>
              )}
              <div style={{ padding: "var(--space-3)", display: "grid", gap: 6 }}>
                <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 14.5, lineHeight: 1.3 }}>{p.title}</div>
                {p.description ? (
                  <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {p.description}
                  </p>
                ) : null}
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
                  <strong style={{ fontFamily: "var(--display)", fontSize: 16, color: "var(--ink-hi)" }}>{formatPence(p.pricePence, p.currency)}</strong>
                  <Pill variant="neutral" size="sm">{p.kind === "service" ? "Voucher / service" : soldOut ? "Sold out" : "Collect in venue"}</Pill>
                </div>
                {sellable && !soldOut ? (
                  session ? (
                    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                      {p.kind === "product" ? (
                        <select
                          value={qty[p.id] ?? 1}
                          onChange={(e) => setQty((m) => ({ ...m, [p.id]: Number(e.target.value) }))}
                          aria-label="Quantity"
                          style={{ padding: "7px 8px", borderRadius: 10, border: "1px solid var(--line)", background: "var(--paper-2)", fontFamily: "var(--ui)", fontSize: 13, color: "var(--ink)" }}
                        >
                          {Array.from({ length: Math.min(10, p.stock ?? 10) }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      ) : null}
                      <Button variant="pri" size="sm" onClick={() => void buy(p.id, qty[p.id] ?? 1)} disabled={buying !== null}>
                        {buying === p.id ? "Opening checkout…" : "Buy"}
                      </Button>
                    </div>
                  ) : (
                    <Link href="/account" style={{ textDecoration: "none" }}>
                      <Button variant="neutral" size="sm">Sign in to buy</Button>
                    </Link>
                  )
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
      {!sellable ? (
        <p style={{ margin: "var(--space-4) 0 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
          Buying through Roam opens once this venue finishes its payout setup — for now, visit or
          message the venue to purchase.
        </p>
      ) : (
        <p style={{ margin: "var(--space-4) 0 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
          Payments are handled securely by Stripe. Products are collected in venue; vouchers come
          with a redeem code in <Link href="/orders" style={{ color: "var(--crimson-700)" }}>your orders</Link>.
        </p>
      )}
    </div>
  );
}

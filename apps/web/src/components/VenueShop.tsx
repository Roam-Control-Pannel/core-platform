/**
 * VenueShop — the PUBLIC venue page's Shop tab (marketplace PR 2): the venue's live
 * catalogue as a browsable grid. Products and services/vouchers render the same card —
 * photo (or a tinted kind-glyph tile), title, description line, price, and a kind chip.
 *
 * Buying arrives with the checkout slice; until then each card is honest about it (a
 * "buying opens soon" note rather than a dead Buy button). Empty catalogue → the tab's
 * host hides nothing; we render a quiet empty state so the tab never feels broken.
 */
"use client";

import { useEffect, useState } from "react";
import { Card, Pill, Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
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
  const [items, setItems] = useState<ShopItem[] | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const list = trpc.market.listByVenue as unknown as { query: (i: { venueId: string }) => Promise<ShopItem[]> };
    list
      .query({ venueId })
      .then((r) => { if (!cancelled) setItems(Array.isArray(r) ? r : []); })
      .catch(() => { if (!cancelled) setItems([]); });
    return () => { cancelled = true; };
  }, [trpc, venueId]);

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
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "var(--space-3)" }}>
        {items.map((p) => (
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
                <Pill variant="neutral" size="sm">{p.kind === "service" ? "Voucher / service" : p.stock === 0 ? "Sold out" : "Collect in venue"}</Pill>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <p style={{ margin: "var(--space-4) 0 0", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
        Buying through Roam opens soon — for now, visit or message the venue to purchase.
      </p>
    </div>
  );
}

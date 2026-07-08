/**
 * MarketShops — the Market page's "Shops" mode (the improved-design B2C feed): every live
 * product, voucher and experience across the town's claimed venue shops, in one browsable
 * grid. Cards carry a fulfilment badge (Collect / Voucher), the venue's name with a claimed
 * tick, price, and the venue's ★ rating; clicking lands on the venue page's Shop tab
 * (?tab=shop deep link) where the real Buy flow lives.
 *
 * Category chips are DERIVED from the venues actually present in the feed (friendly labels
 * via lib/categories) — no dead chips for categories with nothing to show. The host passes
 * the search query; filtering (title + venue name) is client-side over the loaded set.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Pill, Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { formatPence } from "../lib/money";
import { categoryLabel } from "../lib/categories";

interface FeedProduct {
  id: string;
  kind: "product" | "service";
  title: string;
  description: string | null;
  pricePence: number;
  currency: string;
  stock: number | null;
  photoUrl: string | null;
  venue: { id: string; name: string; category: string | null; rating: number | null };
}

export function MarketShops({ localityName, query }: { localityName: string; query: string }) {
  const trpc = useTrpc();
  const [products, setProducts] = useState<FeedProduct[] | undefined>(undefined);
  const [category, setCategory] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProducts(undefined);
    const browse = trpc.market.browseProducts as unknown as {
      query: (i: { localityName: string }) => Promise<FeedProduct[]>;
    };
    browse
      .query({ localityName })
      .then((r) => { if (!cancelled) setProducts(Array.isArray(r) ? r : []); })
      .catch(() => { if (!cancelled) setProducts([]); });
    return () => { cancelled = true; };
  }, [trpc, localityName]);

  // Chips from the venue categories actually present, in first-seen order.
  const categories = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const p of products ?? []) {
      const c = p.venue.category;
      if (c && !seen.has(c)) { seen.add(c); ordered.push(c); }
    }
    return ordered;
  }, [products]);

  const shown = useMemo(() => {
    if (!products) return [];
    const q = query.trim().toLowerCase();
    let list = category ? products.filter((p) => p.venue.category === category) : products;
    if (q) list = list.filter((p) => p.title.toLowerCase().includes(q) || p.venue.name.toLowerCase().includes(q));
    return list;
  }, [products, category, query]);

  if (products === undefined) {
    return <div style={{ height: 260, borderRadius: 20, background: "var(--paper-2)" }} aria-hidden />;
  }
  if (products.length === 0) {
    return (
      <p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>
        No shops in {localityName} have stocked up yet — businesses add products from their
        dashboard, and they&apos;ll appear here the moment they do.
      </p>
    );
  }

  return (
    <div>
      {categories.length > 1 ? (
        <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
          <button onClick={() => setCategory(null)} style={{ all: "unset", cursor: "pointer" }}>
            <Pill variant={category === null ? "crim" : "neutral"} size="sm">All</Pill>
          </button>
          {categories.map((c) => (
            <button key={c} onClick={() => setCategory(c)} style={{ all: "unset", cursor: "pointer" }}>
              <Pill variant={category === c ? "crim" : "neutral"} size="sm">{categoryLabel(c)}</Pill>
            </button>
          ))}
        </div>
      ) : null}

      {shown.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13.5 }}>Nothing matches — try another category or search.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: "var(--space-4)" }}>
          {shown.map((p) => (
            <Link key={p.id} href={`/venue/${p.venue.id}?tab=shop`} style={{ textDecoration: "none", color: "inherit" }}>
              <Card style={{ overflow: "hidden", height: "100%" }}>
                <div style={{ position: "relative" }}>
                  {p.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                    <img src={p.photoUrl} alt="" loading="lazy" style={{ display: "block", width: "100%", height: 170, objectFit: "cover" }} />
                  ) : (
                    <div aria-hidden style={{ height: 170, display: "grid", placeItems: "center", background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))", color: "var(--crimson-700)" }}>
                      <Icon name={p.kind === "service" ? "ticket" : "bag"} size={30} />
                    </div>
                  )}
                  <span style={fulfilBadge}>
                    <Icon name={p.kind === "service" ? "ticket" : "check"} size={10} strokeWidth={2.5} />{" "}
                    {p.kind === "service" ? "Voucher" : p.stock === 0 ? "Sold out" : "Collect"}
                  </span>
                </div>
                <div style={{ padding: "var(--space-3) var(--space-3) var(--space-4)", display: "grid", gap: 7 }}>
                  <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                    {p.title}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                    <span aria-hidden style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontSize: 10, fontWeight: 700, flexShrink: 0 }}>
                      {p.venue.name.charAt(0).toUpperCase()}
                    </span>
                    <span style={{ fontSize: 12.5, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.venue.name}</span>
                    <Icon name="check" size={11} strokeWidth={3} style={{ color: "var(--success)", flexShrink: 0 }} aria-label="Claimed venue" />
                  </div>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 17, color: "var(--ink-hi)" }}>
                      {formatPence(p.pricePence, p.currency)}
                    </strong>
                    {p.venue.rating != null ? (
                      <span style={{ fontSize: 12.5, color: "var(--ink-2)", whiteSpace: "nowrap" }}>
                        <span style={{ color: "var(--gold)" }}>★</span> <strong>{p.venue.rating.toFixed(1)}</strong>
                      </span>
                    ) : null}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

const fulfilBadge: React.CSSProperties = {
  position: "absolute",
  top: "var(--space-2)",
  left: "var(--space-2)",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 10px",
  borderRadius: 999,
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  fontWeight: 700,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--ink)",
  background: "rgba(255,255,255,.92)",
  boxShadow: "var(--shadow-key)",
};

/**
 * MarketShops — the Market page's "Shops" mode (the improved-design B2C feed): every live
 * product, voucher and experience across the town's claimed venue shops, in one browsable
 * grid. Cards follow the hi-fi mock: tall photo with a COLOURED fulfilment badge (Collect /
 * Gift card / Sold out) and a working save-heart, then title, venue row with claimed tick,
 * and a price ↔ ★rating footer. Clicking lands on the venue page's Shop tab (?tab=shop)
 * where the real Buy flow lives.
 *
 * Hearts are the device-local wishlist (lib/wishlist) — instant, no backend; a "Saved"
 * chip appears in the filter row once anything is hearted. Category chips are DERIVED from
 * the venues actually present (no dead chips); the host passes the search query and
 * filtering (title + venue name) is client-side over the loaded set.
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, Pill, Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { formatPence } from "../lib/money";
import { categoryLabel } from "../lib/categories";
import { useWishlist } from "../lib/wishlist";

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
  const [savedOnly, setSavedOnly] = useState(false);
  const { isSaved, toggle, saved } = useWishlist("product");

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
    if (savedOnly) list = list.filter((p) => isSaved(p.id));
    if (q) list = list.filter((p) => p.title.toLowerCase().includes(q) || p.venue.name.toLowerCase().includes(q));
    return list;
  }, [products, category, savedOnly, isSaved, query]);

  if (products === undefined) {
    return <div style={{ height: 320, borderRadius: 20, background: "var(--paper-2)" }} aria-hidden />;
  }
  if (products.length === 0) {
    return (
      <p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55 }}>
        {/* One template literal, not `{name} text` JSX: Turbopack's JSX transform drops the
            space after an expression when the following text wraps to the next source line
            (rendered "Darlingtonhave"). The literal keeps the spacing compiler-proof. */}
        {`No shops in ${localityName} have stocked up yet — businesses add products from their dashboard, and they'll appear here the moment they do.`}
      </p>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: "var(--space-2)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
        <button onClick={() => { setCategory(null); setSavedOnly(false); }} style={{ all: "unset", cursor: "pointer" }}>
          <Pill variant={category === null && !savedOnly ? "on" : "neutral"} size="sm">All</Pill>
        </button>
        {categories.map((c) => (
          <button key={c} onClick={() => { setCategory(c); setSavedOnly(false); }} style={{ all: "unset", cursor: "pointer" }}>
            <Pill variant={category === c ? "on" : "neutral"} size="sm">{categoryLabel(c)}</Pill>
          </button>
        ))}
        {saved.size > 0 ? (
          <button onClick={() => { setSavedOnly((v) => !v); setCategory(null); }} style={{ all: "unset", cursor: "pointer" }}>
            <Pill variant={savedOnly ? "crim" : "neutral"} size="sm">♥ Saved · {saved.size}</Pill>
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <p style={{ color: "var(--muted)", fontSize: 13.5 }}>Nothing matches — try another category or search.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "var(--space-4)" }}>
          {shown.map((p) => {
            const soldOut = p.stock === 0;
            const badge = soldOut
              ? { label: "Sold out", icon: "ban" as const, color: "var(--muted)" }
              : p.kind === "service"
                ? { label: "Gift card", icon: "card" as const, color: "var(--gold)" }
                : { label: "Collect", icon: "check" as const, color: "var(--crimson-700)" };
            return (
              <div key={p.id} style={{ position: "relative" }}>
                <Link href={`/venue/${p.venue.id}?tab=shop`} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
                  <Card style={{ overflow: "hidden", height: "100%" }}>
                    <div style={{ position: "relative" }}>
                      {p.photoUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- public bucket URL
                        <img src={p.photoUrl} alt="" loading="lazy" style={{ display: "block", width: "100%", height: 250, objectFit: "cover" }} />
                      ) : (
                        <div aria-hidden style={{ height: 250, display: "grid", placeItems: "center", background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))", color: "var(--crimson-700)" }}>
                          <Icon name={p.kind === "service" ? "ticket" : "bag"} size={34} />
                        </div>
                      )}
                      <span style={{ ...badgeStyle, color: badge.color }}>
                        <Icon name={badge.icon} size={10} strokeWidth={2.5} /> {badge.label}
                      </span>
                    </div>
                    <div style={{ padding: "var(--space-3) var(--space-4) var(--space-4)", display: "grid", gap: 8 }}>
                      <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}>
                        {p.title}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <span aria-hidden style={{ width: 24, height: 24, borderRadius: "50%", background: "var(--crimson-tint)", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
                          {p.venue.name.charAt(0).toUpperCase()}
                        </span>
                        <span style={{ fontSize: 13, color: "var(--ink-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.venue.name}</span>
                        <Icon name="check" size={12} strokeWidth={3} style={{ color: "var(--success)", flexShrink: 0 }} aria-label="Claimed venue" />
                      </div>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 2 }}>
                        <strong style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 20, color: "var(--ink-hi)" }}>
                          {formatPence(p.pricePence, p.currency)}
                        </strong>
                        {p.venue.rating != null ? (
                          <span style={{ fontSize: 13, color: "var(--ink-2)", whiteSpace: "nowrap" }}>
                            <span style={{ color: "var(--gold)" }}>★</span> <strong>{p.venue.rating.toFixed(1)}</strong>
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </Card>
                </Link>
                <HeartButton saved={isSaved(p.id)} onToggle={() => toggle(p.id)} label={p.title} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The save-heart — a white circle over the photo's top-right; crimson-filled when saved. */
export function HeartButton({ saved, onToggle, label }: { saved: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      aria-label={saved ? `Remove ${label} from saved` : `Save ${label}`}
      aria-pressed={saved}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
      style={{
        all: "unset",
        cursor: "pointer",
        position: "absolute",
        top: "var(--space-3)",
        right: "var(--space-3)",
        width: 36,
        height: 36,
        borderRadius: "50%",
        background: "rgba(255,255,255,.94)",
        boxShadow: "var(--shadow-key)",
        display: "grid",
        placeItems: "center",
        color: saved ? "var(--crimson)" : "var(--ink-2)",
      }}
    >
      <svg width="17" height="17" viewBox="0 0 24 24" fill={saved ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    </button>
  );
}

const badgeStyle: React.CSSProperties = {
  position: "absolute",
  top: "var(--space-3)",
  left: "var(--space-3)",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "5px 11px",
  borderRadius: 999,
  fontFamily: "var(--mono)",
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: ".07em",
  textTransform: "uppercase",
  background: "rgba(255,255,255,.94)",
  boxShadow: "var(--shadow-key)",
};

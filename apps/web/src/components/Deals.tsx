/**
 * Deals — the Awin affiliate deals surface.
 *
 * Public (browse-freely): reads deals.list and renders advertiser offers/vouchers as cards whose
 * CTA is an Awin-tracked affiliate link (buildAwinLink wraps the destination with the public
 * publisher id). Two entry points share one <DealCard>: the full /deals page (<Deals>) and a
 * compact Home widget (<DealsHomeWidget>). Affiliate links carry rel="sponsored nofollow" and an
 * "Ad" label for clear disclosure. Rows come from the Awin Offers ingestion (a later PR); until
 * then the surface renders an honest empty state.
 */
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, Icon } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { buildAwinLink } from "../lib/awin";

export interface Deal {
  id: string;
  advertiserId: string;
  advertiserName: string | null;
  title: string;
  description: string | null;
  kind: "offer" | "voucher";
  voucherCode: string | null;
  terms: string | null;
  destinationUrl: string;
  imageUrl: string | null;
  category: string | null;
  endsAt: string | null;
}

function useDeals(limit: number): { deals: Deal[] | undefined; error: boolean } {
  const trpc = useTrpc();
  const [deals, setDeals] = useState<Deal[] | undefined>(undefined);
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const list = trpc.deals.list as unknown as { query: (i: { limit: number }) => Promise<Deal[]> };
    list
      .query({ limit })
      .then((r) => { if (!cancelled) setDeals(Array.isArray(r) ? r : []); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [trpc, limit]);
  return { deals, error };
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** One deal card. `clickRef` tags the affiliate link with the surface it was clicked from. */
export function DealCard({ deal, clickRef }: { deal: Deal; clickRef: string }) {
  const href = buildAwinLink({ advertiserId: deal.advertiserId, destinationUrl: deal.destinationUrl, clickRef });
  return (
    <Card style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      {deal.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- external advertiser image, arbitrary host
        <img src={deal.imageUrl} alt="" style={{ width: "100%", aspectRatio: "16 / 9", objectFit: "cover", display: "block", background: "var(--paper-2)" }} />
      ) : null}
      <div style={{ padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: 6, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          {deal.advertiserName ? (
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--crimson-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {deal.advertiserName}
            </span>
          ) : <span />}
          <span aria-label="Affiliate ad" title="Affiliate link — Roam may earn a commission" style={{ flexShrink: 0, fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 5px" }}>
            Ad
          </span>
        </div>

        <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 15.5, color: "var(--ink)", lineHeight: 1.3 }}>
          {deal.title}
        </div>
        {deal.description ? (
          <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
            {deal.description}
          </p>
        ) : null}

        {deal.voucherCode ? (
          <div style={{ marginTop: 2, display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start", fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 700, color: "var(--crimson-700)", background: "var(--crimson-tint)", border: "1px dashed var(--crimson-tint-2)", borderRadius: "var(--r-sm)", padding: "3px 10px" }}>
            <Icon name="ticket" size={13} /> {deal.voucherCode}
          </div>
        ) : null}

        <div style={{ marginTop: "auto", paddingTop: "var(--space-3)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <a
            href={href}
            target="_blank"
            rel="sponsored nofollow noopener noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 999, background: "var(--crimson)", color: "#fff", fontWeight: 600, fontSize: 13.5, textDecoration: "none" }}
          >
            {deal.kind === "voucher" ? "Get deal" : "Shop deal"} <Icon name="chevronRight" size={15} />
          </a>
          {deal.endsAt ? <span style={{ fontSize: 11.5, color: "var(--muted)" }}>Ends {shortDate(deal.endsAt)}</span> : null}
        </div>
      </div>
    </Card>
  );
}

/** Full /deals page body. */
export function Deals() {
  const { deals, error } = useDeals(24);
  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-3)" }}>
        <span aria-hidden>←</span> Home
      </Link>
      <header style={{ marginBottom: "var(--space-4)" }}>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 28, letterSpacing: "-.02em", margin: 0 }}>Deals</h1>
        <p style={{ margin: "6px 0 0", fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5 }}>
          Handpicked offers and voucher codes from brands we partner with. Links marked <strong>Ad</strong> may earn Roam a commission — it never changes the price you pay.
        </p>
      </header>

      {error ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>Couldn&apos;t load deals just now.</p>
        </Card>
      ) : deals === undefined ? (
        <DealsGrid>{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} style={{ height: 220, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />)}</DealsGrid>
      ) : deals.length === 0 ? (
        <Card flat style={{ padding: "var(--space-8)", textAlign: "center" }}>
          <div style={{ display: "grid", placeItems: "center", width: 46, height: 46, margin: "0 auto var(--space-3)", borderRadius: 12, background: "var(--crimson-tint)", color: "var(--crimson-700)" }}>
            <Icon name="ticket" size={22} />
          </div>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: 6 }}>No deals just now</div>
          <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>Fresh offers from our partner brands will appear here soon — check back shortly.</p>
        </Card>
      ) : (
        <DealsGrid>{deals.map((d) => <DealCard key={d.id} deal={d} clickRef="deals" />)}</DealsGrid>
      )}
    </main>
  );
}

function DealsGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "var(--space-4)" }}>{children}</div>;
}

/**
 * Compact Home widget (half-width): a few live deals as slim rows + a link to the full page. Each
 * row IS the affiliate link. Renders nothing when there are no deals, so the dashboard never shows
 * an empty Deals card (half-width widgets that return null leave no grid cell).
 */
export function DealsHomeWidget() {
  const { deals } = useDeals(3);
  if (!deals || deals.length === 0) return null;
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 8, background: "var(--crimson-tint)", color: "var(--crimson-700)" }}><Icon name="ticket" size={15} /></span>
          <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>Deals</h2>
          <span aria-label="Affiliate" title="Affiliate links — Roam may earn a commission" style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 5px" }}>Ad</span>
        </div>
        <Link href="/deals" style={{ fontSize: 13, fontWeight: 600, color: "var(--crimson-700)", textDecoration: "none", whiteSpace: "nowrap" }}>
          All deals <span aria-hidden>→</span>
        </Link>
      </header>
      <div style={{ display: "grid", gap: 2 }}>
        {deals.map((d) => {
          const href = buildAwinLink({ advertiserId: d.advertiserId, destinationUrl: d.destinationUrl, clickRef: "home" });
          return (
            <a
              key={d.id}
              href={href}
              target="_blank"
              rel="sponsored nofollow noopener noreferrer"
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", borderRadius: "var(--r-md)", textDecoration: "none", color: "inherit" }}
            >
              <span aria-hidden style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0, background: "var(--paper-2)", border: "1px solid var(--line)", overflow: "hidden", display: "grid", placeItems: "center", color: "var(--faint)" }}>
                {d.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- external advertiser image
                  <img src={d.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : <Icon name="ticket" size={15} />}
              </span>
              <span style={{ minWidth: 0, flex: 1 }}>
                {d.advertiserName ? <span style={{ display: "block", fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--crimson-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.advertiserName}</span> : null}
                <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title}</span>
              </span>
              <Icon name="chevronRight" size={16} style={{ color: "var(--faint)", flexShrink: 0 }} />
            </a>
          );
        })}
      </div>
    </Card>
  );
}

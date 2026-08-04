/**
 * Deals — the Awin affiliate deals surface.
 *
 * Public (browse-freely): reads deals.list and renders advertiser offers/vouchers as cards whose
 * CTA is an Awin-tracked affiliate link (buildAwinLink wraps the destination with the public
 * publisher id). Two entry points share one <DealCard>: the full /deals page (<Deals>) and a
 * compact Home widget (<DealsHomeWidget>). Affiliate links carry rel="sponsored nofollow" and an
 * "Ad" label for clear disclosure.
 *
 * Awin promotions rarely ship an image, so instead of a flat placeholder each card leads with a
 * branded tile: the discount pulled from the title ("20% Off" → a bold "20% OFF"), or the
 * advertiser's monogram when there's nothing to headline. That gives every card a strong, on-brand
 * visual without depending on advertiser artwork.
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Button, Icon, type IconName } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { CopyLinkButton } from "./CopyLinkButton";
import { buildDealLink } from "../lib/dealLink";
import { getFormatLocale } from "../lib/i18n/runtime";

export interface Deal {
  id: string;
  network?: "awin" | "cj";
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

const PAGE = 24;
type DealPage = { deals: Deal[]; hasMore: boolean };

/** The /deals page feed: category- + keyword-filtered, offset-paginated, accumulating via loadMore. */
function useDealsPage(category: string | null, q: string): {
  deals: Deal[] | undefined;
  hasMore: boolean;
  loadingMore: boolean;
  error: boolean;
  loadMore: () => void;
} {
  const trpc = useTrpc();
  const [deals, setDeals] = useState<Deal[] | undefined>(undefined);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const term = q.trim();
  const list = trpc.deals.list as unknown as {
    query: (i: { category?: string; q?: string; limit: number; offset: number }) => Promise<DealPage>;
  };
  const filter = { ...(category ? { category } : {}), ...(term ? { q: term } : {}) };

  // Reset + load page one whenever the category or search term changes.
  useEffect(() => {
    let cancelled = false;
    setDeals(undefined); setOffset(0); setHasMore(false); setError(false);
    list
      .query({ limit: PAGE, offset: 0, ...filter })
      .then((r) => { if (!cancelled) { setDeals(r.deals); setHasMore(r.hasMore); setOffset(r.deals.length); } })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trpc, category, term]);

  const loadMore = useCallback(() => {
    setLoadingMore(true);
    list
      .query({ limit: PAGE, offset, ...filter })
      .then((r) => {
        setDeals((cur) => [...(cur ?? []), ...r.deals]);
        setHasMore(r.hasMore);
        setOffset((o) => o + r.deals.length);
      })
      .catch(() => {})
      .finally(() => setLoadingMore(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trpc, category, term, offset]);

  return { deals, hasMore, loadingMore, error, loadMore };
}

/** A few live deals for the compact home widget — first page only, no pagination. */
function useDealsPreview(limit: number): Deal[] | undefined {
  const trpc = useTrpc();
  const [deals, setDeals] = useState<Deal[] | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    const list = trpc.deals.list as unknown as { query: (i: { limit: number; offset: number }) => Promise<DealPage> };
    list
      .query({ limit, offset: 0 })
      .then((r) => { if (!cancelled) setDeals(r.deals); })
      .catch(() => { if (!cancelled) setDeals([]); });
    return () => { cancelled = true; };
  }, [trpc, limit]);
  return deals;
}

/** The filter-chip categories (distinct live categories across both networks). */
function useDealCategories(): { category: string; count: number }[] {
  const trpc = useTrpc();
  const [cats, setCats] = useState<{ category: string; count: number }[]>([]);
  useEffect(() => {
    let cancelled = false;
    const q = trpc.deals.categories as unknown as { query: () => Promise<{ categories: { category: string; count: number }[] }> };
    q.query().then((r) => { if (!cancelled) setCats(r.categories ?? []); }).catch(() => { if (!cancelled) setCats([]); });
    return () => { cancelled = true; };
  }, [trpc]);
  return cats;
}

function shortDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(getFormatLocale(), { day: "numeric", month: "short" });
}

/** A category icon inferred from the advertiser + title, so image-less deals still read at a glance. */
function dealIcon(deal: Deal): IconName {
  const s = `${deal.advertiserName ?? ""} ${deal.title}`.toLowerCase();
  if (/\b(hotel|stay|room|night|resort|bed|inn|lodge)\b/.test(s)) return "hotel";
  if (/\b(flight|holiday|package|travel|trip|airport|getaway|cruise|beach)\b/.test(s)) return "flight";
  if (/\b(ape|tree|adventure|outdoor|park|climb|activity|experience|zip|trail)\b/.test(s)) return "outdoor";
  if (/\b(eat|dine|dining|restaurant|food|meal|menu|pizza|coffee|cafe)\b/.test(s)) return "dining";
  if (/\b(shop|store|fashion|clothing|wear|beauty|home|tech)\b/.test(s)) return "bag";
  return "tag";
}

/** The lead visual: advertiser image when present, else a branded, category-appropriate icon tile. */
function DealThumb({ deal, variant }: { deal: Deal; variant: "hero" | "tile" }) {
  const hero = variant === "hero";
  const base: React.CSSProperties = hero
    ? { width: "100%", aspectRatio: "16 / 9", display: "grid", placeItems: "center" }
    : { width: 44, height: 44, borderRadius: 12, flexShrink: 0, display: "grid", placeItems: "center", overflow: "hidden" };

  if (deal.imageUrl) {
    return (
      <div style={{ ...base, background: "var(--paper-2)" }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- external advertiser image */}
        <img src={deal.imageUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
      </div>
    );
  }

  // No image → a soft crimson tile with the category icon.
  return (
    <div
      aria-hidden
      style={{
        ...base,
        background: hero ? "linear-gradient(135deg, var(--crimson-tint), var(--paper-2))" : "var(--crimson-tint)",
        color: "var(--crimson-700)",
      }}
    >
      <Icon name={dealIcon(deal)} size={hero ? 40 : 20} strokeWidth={1.6} />
    </div>
  );
}

/** One deal card. `clickRef` tags the affiliate link with the surface it was clicked from. */
export function DealCard({ deal, clickRef }: { deal: Deal; clickRef: string }) {
  const t = useTranslations("deals");
  const href = buildDealLink({ network: deal.network, advertiserId: deal.advertiserId, destinationUrl: deal.destinationUrl, clickRef });
  return (
    <Card style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <DealThumb deal={deal} variant="hero" />
      <div style={{ padding: "var(--space-4)", display: "flex", flexDirection: "column", gap: 7, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--crimson-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {deal.advertiserName ?? t("featured")}
          </span>
          <span aria-label={t("affiliateAdAria")} title={t("affiliateAdTitle")} style={{ flexShrink: 0, fontFamily: "var(--mono)", fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 5px" }}>
            {t("ad")}
          </span>
        </div>

        <div style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 16, color: "var(--ink-hi)", lineHeight: 1.32, letterSpacing: "-.01em", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
          {deal.title}
        </div>

        {deal.voucherCode ? (
          <div style={{ marginTop: 1, display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start", fontFamily: "var(--mono)", fontSize: 12.5, fontWeight: 700, letterSpacing: ".03em", color: "var(--crimson-700)", background: "var(--crimson-tint)", border: "1px dashed var(--crimson-tint-2)", borderRadius: "var(--r-sm)", padding: "3px 10px" }}>
            <Icon name="ticket" size={13} /> {deal.voucherCode}
          </div>
        ) : null}

        <div style={{ marginTop: "auto", paddingTop: "var(--space-3)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <a
              href={href}
              target="_blank"
              rel="sponsored nofollow noopener noreferrer"
              style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "8px 15px", borderRadius: 999, background: "var(--crimson)", color: "#fff", fontFamily: "var(--ui)", fontWeight: 600, fontSize: 13.5, textDecoration: "none" }}
            >
              {deal.kind === "voucher" ? t("getDeal") : t("shopDeal")} <Icon name="chevronRight" size={15} />
            </a>
            <CopyLinkButton path={`/deals/${deal.id}`} title={deal.title} label="" />
          </span>
          {deal.endsAt ? <span style={{ fontSize: 11.5, color: "var(--muted)", whiteSpace: "nowrap" }}>{t("ends", { date: shortDate(deal.endsAt) })}</span> : null}
        </div>
      </div>
    </Card>
  );
}

/** One category filter chip. */
function CategoryChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        padding: "6px 14px",
        borderRadius: 999,
        fontFamily: "var(--ui)",
        fontSize: 13,
        fontWeight: 600,
        whiteSpace: "nowrap",
        border: `1px solid ${active ? "var(--crimson-tint-2)" : "var(--line-2)"}`,
        background: active ? "var(--crimson-tint)" : "#fff",
        color: active ? "var(--crimson-700)" : "var(--ink-2)",
      }}
    >
      {label}
    </button>
  );
}

/** Full /deals page body: category chips + an interleaved, paginated deal grid. */
export function Deals() {
  const t = useTranslations("deals");
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const { deals, hasMore, loadingMore, error, loadMore } = useDealsPage(category, debounced);
  const categories = useDealCategories();

  // Debounce the keyword so we're not firing a query on every keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebounced(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link href="/" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-3)" }}>
        <span aria-hidden>←</span> {t("home")}
      </Link>
      <header style={{ marginBottom: "var(--space-4)" }}>
        <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 28, letterSpacing: "-.02em", margin: 0 }}>{t("title")}</h1>
        <p style={{ margin: "6px 0 0", fontSize: 14, color: "var(--ink-2)", lineHeight: 1.5 }}>
          {t.rich("intro", { strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      </header>

      {/* Search bar — filter offers by title or brand. */}
      <div style={{ position: "relative", marginBottom: "var(--space-3)", maxWidth: 420 }}>
        <span aria-hidden style={{ position: "absolute", left: 13, top: "50%", transform: "translateY(-50%)", color: "var(--muted)", display: "grid", placeItems: "center" }}>
          <Icon name="search" size={16} />
        </span>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchAria")}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "10px 14px 10px 38px",
            background: "#fff",
            border: "1px solid var(--line-2)",
            borderRadius: 999,
            fontFamily: "var(--ui)",
            fontSize: 16,
            color: "var(--ink)",
            outline: "none",
          }}
        />
      </div>

      {/* Category filter chips (distinct live categories across both networks). */}
      {categories.length > 0 ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
          <CategoryChip label={t("allCategories")} active={category === null} onClick={() => setCategory(null)} />
          {categories.map((c) => (
            <CategoryChip key={c.category} label={c.category} active={category === c.category} onClick={() => setCategory(c.category)} />
          ))}
        </div>
      ) : null}

      {error ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{t("loadFailed")}</p>
        </Card>
      ) : deals === undefined ? (
        <DealsGrid>{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} style={{ height: 250, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />)}</DealsGrid>
      ) : deals.length === 0 ? (
        <Card flat style={{ padding: "var(--space-8)", textAlign: "center" }}>
          <div style={{ display: "grid", placeItems: "center", width: 46, height: 46, margin: "0 auto var(--space-3)", borderRadius: 12, background: "var(--crimson-tint)", color: "var(--crimson-700)" }}>
            <Icon name="ticket" size={22} />
          </div>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: 6 }}>{t("emptyTitle")}</div>
          <p style={{ color: "var(--ink-2)", margin: 0, lineHeight: 1.5 }}>{t("emptyBody")}</p>
        </Card>
      ) : (
        <>
          <DealsGrid>{deals.map((d) => <DealCard key={`${d.network ?? "awin"}-${d.id}`} deal={d} clickRef="deals" />)}</DealsGrid>
          {hasMore ? (
            <div style={{ textAlign: "center", marginTop: "var(--space-6)" }}>
              <Button variant="neutral" onClick={loadMore} disabled={loadingMore}>
                {loadingMore ? t("loadingMore") : t("loadMore")}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </main>
  );
}

function DealsGrid({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "var(--space-4)" }}>{children}</div>;
}

/**
 * DealDetail — the /deals/[dealId] permalink: one deal, full description + terms, the affiliate
 * CTA, and a Share button. This is the URL a shared deal resolves to (the OG tags on the route
 * make it unfurl as a card), so an external recipient lands on Roam, not straight on the
 * advertiser. Ships loading / not-found / error states; the server passes an SSR seed.
 */
export function DealDetail({ dealId, initialDeal }: { dealId: string; initialDeal?: Deal | null }) {
  const t = useTranslations("deals");
  const trpc = useTrpc();
  const [deal, setDeal] = useState<Deal | null | undefined>(initialDeal);
  const [error, setError] = useState(false);

  useEffect(() => {
    // When the server already resolved the deal (SSR seed), trust it — a deal carries no
    // viewer-specific state, so there's nothing to refetch.
    if (initialDeal !== undefined) return;
    let cancelled = false;
    const byId = trpc.deals.byId as unknown as { query: (i: { dealId: string }) => Promise<Deal | null> };
    byId
      .query({ dealId })
      .then((d) => { if (!cancelled) setDeal(d); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [trpc, dealId, initialDeal]);

  const href = deal
    ? buildDealLink({ network: deal.network, advertiserId: deal.advertiserId, destinationUrl: deal.destinationUrl, clickRef: "deal-detail" })
    : "#";

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <Link href="/deals" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none", marginBottom: "var(--space-4)" }}>
        <span aria-hidden>←</span> {t("title")}
      </Link>

      {error ? (
        <Card flat style={{ padding: "var(--space-5)", textAlign: "center" }}>
          <p style={{ color: "var(--muted)", margin: 0 }}>{t("detail.loadFailed")}</p>
        </Card>
      ) : deal === undefined ? (
        <div style={{ height: 300, borderRadius: "var(--r-lg)", background: "var(--paper-2)" }} />
      ) : deal === null ? (
        <Card flat style={{ padding: "var(--space-6)", textAlign: "center" }}>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, marginBottom: "var(--space-2)" }}>
            {t("detail.notFoundTitle")}
          </div>
          <p style={{ color: "var(--ink-2)", margin: 0 }}>{t("detail.notFoundBody")}</p>
        </Card>
      ) : (
        <Card style={{ padding: 0, overflow: "hidden" }}>
          <DealThumb deal={deal} variant="hero" />
          <div style={{ padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: "var(--crimson-700)" }}>
                {deal.advertiserName ?? t("featured")}
              </span>
              <span aria-label={t("affiliateAdAria")} title={t("affiliateAdTitle")} style={{ flexShrink: 0, fontFamily: "var(--mono)", fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 5px" }}>
                {t("ad")}
              </span>
            </div>

            <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 24, lineHeight: 1.25, letterSpacing: "-.015em", margin: 0 }}>
              {deal.title}
            </h1>

            {deal.description ? (
              <p style={{ margin: 0, color: "var(--ink-2)", lineHeight: 1.6 }}>{deal.description}</p>
            ) : null}

            {deal.voucherCode ? (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, alignSelf: "flex-start", fontFamily: "var(--mono)", fontSize: 14, fontWeight: 700, letterSpacing: ".03em", color: "var(--crimson-700)", background: "var(--crimson-tint)", border: "1px dashed var(--crimson-tint-2)", borderRadius: "var(--r-sm)", padding: "6px 14px" }}>
                <Icon name="ticket" size={15} /> {deal.voucherCode}
              </div>
            ) : null}

            <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap", marginTop: "var(--space-2)" }}>
              <a
                href={href}
                target="_blank"
                rel="sponsored nofollow noopener noreferrer"
                style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "10px 20px", borderRadius: 999, background: "var(--crimson)", color: "#fff", fontFamily: "var(--ui)", fontWeight: 600, fontSize: 14.5, textDecoration: "none" }}
              >
                {deal.kind === "voucher" ? t("getDeal") : t("shopDeal")} <Icon name="chevronRight" size={16} />
              </a>
              <CopyLinkButton path={`/deals/${deal.id}`} title={deal.title} />
              {deal.endsAt ? <span style={{ fontSize: 12.5, color: "var(--muted)", whiteSpace: "nowrap" }}>{t("ends", { date: shortDate(deal.endsAt) })}</span> : null}
            </div>

            {deal.terms ? (
              <p style={{ margin: "var(--space-2) 0 0", fontSize: 12, color: "var(--muted)", lineHeight: 1.5 }}>{deal.terms}</p>
            ) : null}
          </div>
        </Card>
      )}
    </main>
  );
}

/**
 * Compact Home widget (half-width): a few live deals as rich rows + a link to the full page. Each
 * row IS the affiliate link. Renders nothing when there are no deals, so the dashboard never shows
 * an empty Deals card (half-width widgets that return null leave no grid cell).
 */
export function DealsHomeWidget() {
  const t = useTranslations("deals");
  const deals = useDealsPreview(3);
  if (!deals || deals.length === 0) return null;
  return (
    <Card style={{ padding: "var(--space-4)" }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center", width: 26, height: 26, borderRadius: 9, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}><Icon name="ticket" size={15} /></span>
          <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>{t("title")}</h2>
          <span aria-label={t("affiliateAria")} title={t("affiliateLinksTitle")} style={{ fontFamily: "var(--mono)", fontSize: 9, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--muted)", border: "1px solid var(--line)", borderRadius: 4, padding: "1px 5px" }}>{t("ad")}</span>
        </div>
        <Link href="/deals" style={{ fontSize: 13, fontWeight: 600, color: "var(--crimson-700)", textDecoration: "none", whiteSpace: "nowrap" }}>
          {t("widget.allDeals")} <span aria-hidden>→</span>
        </Link>
      </header>
      {/* minmax(0, 1fr), not the implicit auto column: a nowrap deal title's min-content would
          otherwise set the track width and push every row past the card's padding. */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 4 }}>
        {deals.map((d) => {
          const href = buildDealLink({ network: d.network, advertiserId: d.advertiserId, destinationUrl: d.destinationUrl, clickRef: "home" });
          return (
            <a
              key={d.id}
              href={href}
              target="_blank"
              rel="sponsored nofollow noopener noreferrer"
              style={{ display: "flex", alignItems: "center", gap: 11, padding: "6px 6px", borderRadius: "var(--r-md)", textDecoration: "none", color: "inherit" }}
            >
              <DealThumb deal={d} variant="tile" />
              {/* overflow:hidden + minWidth:0 down the chain — long advertiser names/titles must
                  ellipsise inside the rail card, never paint past its padding. */}
              <span style={{ minWidth: 0, flex: 1, display: "flex", flexDirection: "column", gap: 2, overflow: "hidden" }}>
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  <span style={{ minWidth: 0, fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "var(--crimson-700)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.advertiserName ?? t("featured")}</span>
                  {d.voucherCode ? <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, fontWeight: 700, color: "var(--crimson-700)", background: "var(--crimson-tint)", borderRadius: 4, padding: "0 5px", flexShrink: 0 }}>{t("widget.code")}</span> : null}
                </span>
                <span style={{ maxWidth: "100%", fontFamily: "var(--display)", fontSize: 14, fontWeight: 600, color: "var(--ink)", lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.title}</span>
              </span>
              <Icon name="chevronRight" size={16} style={{ color: "var(--faint)", flexShrink: 0 }} />
            </a>
          );
        })}
      </div>
    </Card>
  );
}

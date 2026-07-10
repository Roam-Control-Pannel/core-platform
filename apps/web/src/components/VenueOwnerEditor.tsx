/**
 * VenueOwnerEditor — the /dashboard/[venueId] owner console, per the business-dashboard
 * redesign: an identity header (cover avatar · name · claimed chip · live open-now pill ·
 * View public page), a 4-up stat strip (Followers · Profile views · Offer redemptions ·
 * Rating — every number real), then the six work tabs:
 *
 *   Overview      — next-best-action banner, the performance chart (real daily view counts +
 *                   weekly follower adds), recent posts; rail: quick actions, activity,
 *                   marketing assistant.
 *   Audience      — aggregate tiles, follower-growth bars, age bands (k-anonymised
 *                   server-side), the birthday offer.
 *   Posts         — the local-posts composer + history.
 *   Offers        — offers manager; rail: offer insights + suggested offers.
 *   Notifications — send a push + push history.
 *   Venue         — photos, details, hours (the same battle-tested editors as before).
 *
 * Data honesty: profile views only exist from migration 0068 onward (the public venue page
 * counts a view per load, identity-free), so a fresh venue's chart starts flat — stated in
 * the UI rather than faked. Ownership is gated by RLS on every write; the owner_id check here
 * is presentation only (a non-owner gets a clear message instead of dead editors).
 */
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card, Icon, Seg, type IconName } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { Button } from "@roam/design";
import { OwnerMediaManager } from "./OwnerMediaManager";
import { OwnerDetailsEditor } from "./OwnerDetailsEditor";
import { OwnerHoursEditor } from "./OwnerHoursEditor";
import { LocalPosts } from "./LocalPosts";
import { VenueNotify } from "./VenueNotify";
import { VenueOffers } from "./VenueOffers";
import { OfferInsights } from "./OfferInsights";
import { VenueActivity } from "./VenueActivity";
import { MarketingSuggestions } from "./MarketingSuggestions";
import { SuggestedForYou } from "./SuggestedForYou";
import { PushHistory } from "./PushHistory";
import { BirthdayOffer } from "./BirthdayOffer";
import { VenuePayments } from "./VenuePayments";
import { VenueShopManager } from "./VenueShopManager";
import { VenueOrders } from "./VenueOrders";
import { venuePath } from "../lib/routes";
import { isOpenNow, type OpeningTimesRead } from "../lib/openNow";
import { formatPence } from "../lib/money";
import { timeAgo } from "../lib/townHall";
import styles from "./BizDash.module.css";

/** Tab keys — labels come from the catalogue (venueOwnerEditor.tabs.*). */
const TABS = ["overview", "audience", "posts", "offers", "shop", "notifications", "venue"] as const;
type TabKey = (typeof TABS)[number];

/** The venue fields we read to seed the editors (byId returns the full row). */
interface OwnerVenue {
  id: string;
  slug: string | null;
  name: string;
  status: string;
  owner_id: string | null;
  description: string | null;
  links: Record<string, unknown> | null;
  opening_times: { periods?: unknown[] | null } | null;
  rating: number | null;
  rating_count: number | null;
  locality: string | null;
  region: string | null;
  category: string | null;
}

type ByIdQuery = { query: (input: { venueId: string }) => Promise<OwnerVenue | null> };

/* ── Shared dashboard data (fetched once, fed to the stat strip + tabs) ─────────────── */

interface AudienceStats {
  followers: number;
  new30: number;
  engaged30: number;
  pushReach: number;
  birthdaysThisMonth: number | null;
  ageBands: Record<string, number> | null;
  dobSample: number;
}
interface ViewStats {
  days: number;
  total: number;
  previousTotal: number;
  daily: { day: string; views: number }[];
}
interface GrowthWeek {
  weekStart: string;
  count: number;
}
interface Engagement {
  themes: { offerType: string; offers: number; saves: number; redemptions: number }[];
  totals: { offers: number; saves: number; redemptions: number };
}
interface DashData {
  audience: AudienceStats | null;
  views: ViewStats | null;
  growth: GrowthWeek[] | null;
  engagement: Engagement | null;
  credits: number | null;
  /** Shop takings: gross pence across paid/collected/redeemed orders, + the order count. */
  revenuePence: number | null;
  salesCount: number | null;
}

/** Load every cross-tab number in one settled batch — a failed read is a null, never a block. */
function useDashData(venueId: string): DashData {
  const trpc = useTrpc();
  const [data, setData] = useState<DashData>({ audience: null, views: null, growth: null, engagement: null, credits: null, revenuePence: null, salesCount: null });

  useEffect(() => {
    let cancelled = false;
    const aud = trpc.venueAudience.stats as unknown as { query: (i: { venueId: string }) => Promise<AudienceStats> };
    const vs = trpc.venues.viewStats as unknown as { query: (i: { venueId: string; days: 30 | 90 }) => Promise<ViewStats> };
    const gr = trpc.social.venueFollowerGrowth as unknown as { query: (i: { venueId: string }) => Promise<{ ok: boolean; weeks: GrowthWeek[] }> };
    const eng = trpc.offers.engagement as unknown as { query: (i: { venueId: string }) => Promise<Engagement> };
    const bal = trpc.credits.balance as unknown as { query: (i: { venueId: string }) => Promise<{ balance: number }> };
    const ord = trpc.market.venueOrders as unknown as { query: (i: { venueId: string }) => Promise<{ amountPence: number; status: string }[]> };
    void Promise.allSettled([
      aud.query({ venueId }),
      vs.query({ venueId, days: 30 }),
      gr.query({ venueId }),
      eng.query({ venueId }),
      bal.query({ venueId }),
      ord.query({ venueId }),
    ]).then(([a, v, g, e, b, o]) => {
      if (cancelled) return;
      const paidish = o.status === "fulfilled" && Array.isArray(o.value)
        ? o.value.filter((x) => ["paid", "collected", "redeemed"].includes(x.status))
        : null;
      setData({
        audience: a.status === "fulfilled" ? a.value : null,
        views: v.status === "fulfilled" ? v.value : null,
        growth: g.status === "fulfilled" && g.value.ok ? g.value.weeks : null,
        engagement: e.status === "fulfilled" ? e.value : null,
        credits: b.status === "fulfilled" ? (b.value.balance ?? 0) : null,
        revenuePence: paidish ? paidish.reduce((n, x) => n + x.amountPence, 0) : null,
        salesCount: paidish ? paidish.length : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  return data;
}

export function VenueOwnerEditor({ venueId }: { venueId: string }) {
  const t = useTranslations("venueOwnerEditor");
  const trpc = useTrpc();
  const session = useSession();
  const [venue, setVenue] = useState<OwnerVenue | null | "missing">(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const userId = session?.user?.id ?? null;

  const load = useCallback(async () => {
    setError(null);
    try {
      const v = await (trpc.venues.byId as unknown as ByIdQuery).query({ venueId });
      setVenue(v ?? "missing");
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t("loadFailed"));
    }
  }, [trpc, venueId]);

  useEffect(() => {
    void load();
  }, [load]);

  const isOwner = venue !== null && venue !== "missing" && !!userId && venue.owner_id === userId;

  return (
    <main style={{ maxWidth: 1140, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      <header style={{ padding: "var(--space-2) 0 var(--space-4)" }}>
        <Link href="/dashboard" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--muted)", textDecoration: "none" }}>
          <Icon name="arrowLeft" size={14} /> {t("backToRoam")}
        </Link>
      </header>

      {error ? (
        <p role="alert" style={{ color: "var(--crimson-700)" }}>{error}</p>
      ) : venue === null ? (
        <div style={{ height: 420, borderRadius: 20, background: "var(--paper-2)" }} aria-hidden />
      ) : venue === "missing" ? (
        <Message title={t("notFound.title")} body={t("notFound.body")} />
      ) : !isOwner ? (
        <Message
          title={t("notOwner.title")}
          body={t("notOwner.body")}
        />
      ) : (
        <Dashboard venue={venue} venueId={venueId} tab={tab} onTab={setTab} reloadVenue={load} />
      )}
    </main>
  );
}

/* ── The signed-in owner console ─────────────────────────────────────────────────────── */

function Dashboard({
  venue,
  venueId,
  tab,
  onTab,
  reloadVenue,
}: {
  venue: OwnerVenue;
  venueId: string;
  tab: TabKey;
  onTab: (t: TabKey) => void;
  reloadVenue: () => Promise<void>;
}) {
  const t = useTranslations("venueOwnerEditor");
  const data = useDashData(venueId);

  return (
    <>
      <IdentityHeader venue={venue} venueId={venueId} />
      <StatRow venue={venue} data={data} />
      <DashTabs tab={tab} onTab={onTab} />

      {tab === "overview" ? (
        <div className={styles.split}>
          <div style={{ minWidth: 0, display: "grid", gap: "var(--space-4)" }}>
            <NextBestAction data={data} onTab={onTab} />
            <PerformanceCard venueId={venueId} initialViews={data.views} growth={data.growth} />
            <RecentPosts venueId={venueId} onTab={onTab} />
          </div>
          <div style={{ display: "grid", gap: "var(--space-4)" }}>
            <DashCard icon="sparkle" title={t("quickActions.title")}>
              <div className={styles.quickGrid}>
                <QuickTile glyph="megaphone" label={t("quickActions.post")} onClick={() => onTab("posts")} />
                <QuickTile glyph="ticket" label={t("quickActions.offer")} onClick={() => onTab("offers")} />
                <QuickTile glyph="bell" label={t("quickActions.push")} onClick={() => onTab("notifications")} />
              </div>
            </DashCard>
            <DashCard icon="bell" title={t("activityCard.title")} subtitle={t("activityCard.subtitle")}>
              <VenueActivity venueId={venueId} />
            </DashCard>
            <DashCard icon="card" title={t("paymentsCard.title")} subtitle={t("paymentsCard.subtitle")}>
              <VenuePayments venueId={venueId} />
            </DashCard>
            <DashCard icon="idea" title={t("marketingCard.title")} subtitle={t("marketingCard.subtitle")}>
              <MarketingSuggestions venueId={venueId} />
            </DashCard>
          </div>
        </div>
      ) : null}

      {tab === "audience" ? <AudienceTab venueId={venueId} data={data} /> : null}

      {tab === "posts" ? (
        <DashCard
          icon="megaphone"
          title={t("postsCard.title")}
          subtitle={t("postsCard.subtitle")}
        >
          <LocalPosts venueId={venueId} />
        </DashCard>
      ) : null}

      {tab === "offers" ? (
        <div className={styles.split}>
          <DashCard
            icon="ticket"
            title={t("offersCard.title")}
            subtitle={t("offersCard.subtitle")}
          >
            <VenueOffers venueId={venueId} />
          </DashCard>
          <div style={{ display: "grid", gap: "var(--space-4)" }}>
            <DashCard icon="poll" title={t("offerInsightsCard.title")} subtitle={t("offerInsightsCard.subtitle")}>
              <OfferInsights venueId={venueId} />
            </DashCard>
            {/* Renders itself only when the business has opted into suggestions. */}
            <SuggestedForYou venueId={venueId} />
          </div>
        </div>
      ) : null}

      {tab === "shop" ? (
        <div className={styles.split}>
          <div style={{ minWidth: 0, display: "grid", gap: "var(--space-4)" }}>
            <DashCard
              icon="bag"
              title={t("shopCard.title")}
              subtitle={t("shopCard.subtitle")}
            >
              <VenueShopManager venueId={venueId} />
            </DashCard>
            <DashCard icon="redeem" title={t("ordersCard.title")} subtitle={t("ordersCard.subtitle")}>
              <VenueOrders venueId={venueId} />
            </DashCard>
          </div>
          <DashCard icon="card" title={t("paymentsCard.title")} subtitle={t("paymentsCard.subtitle")}>
            <VenuePayments venueId={venueId} />
          </DashCard>
        </div>
      ) : null}

      {tab === "notifications" ? (
        <div className={styles.split}>
          <DashCard
            icon="inbox"
            title={t("notifyCard.title")}
            subtitle={t("notifyCard.subtitle")}
          >
            <VenueNotify venueId={venueId} />
          </DashCard>
          <DashCard icon="send" title={t("pushHistoryCard.title")} subtitle={t("pushHistoryCard.subtitle")}>
            <PushHistory venueId={venueId} />
          </DashCard>
        </div>
      ) : null}

      {tab === "venue" ? (
        <div style={{ display: "grid", gap: "var(--space-4)" }}>
          <DashCard icon="photo" title={t("photosCard.title")} subtitle={t("photosCard.subtitle")}>
            <OwnerMediaManager venueId={venueId} />
          </DashCard>
          <DashCard icon="edit" title={t("detailsCard.title")} subtitle={t("detailsCard.subtitle")}>
            <OwnerDetailsEditor
              venueId={venueId}
              initialDescription={venue.description}
              initialLinks={venue.links}
              onSaved={reloadVenue}
            />
          </DashCard>
          <DashCard icon="clock" title={t("hoursCard.title")} subtitle={t("hoursCard.subtitle")}>
            <OwnerHoursEditor
              venueId={venueId}
              initialPeriods={(venue.opening_times?.periods ?? null) as never}
              onSaved={reloadVenue}
            />
          </DashCard>
        </div>
      ) : null}
    </>
  );
}

/* ── Identity header ─────────────────────────────────────────────────────────────────── */

function IdentityHeader({ venue, venueId }: { venue: OwnerVenue; venueId: string }) {
  const t = useTranslations("venueOwnerEditor");
  const open = useMemo(
    () => isOpenNow(venue.opening_times as OpeningTimesRead | null, new Date()),
    [venue.opening_times],
  );

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-4)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", minWidth: 0 }}>
        <VenueAvatar venueId={venueId} name={venue.name} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
            <h1 className="t-h1" style={{ fontFamily: "var(--display)", fontWeight: 600, margin: 0, fontSize: 26, letterSpacing: "-.02em" }}>
              {venue.name}
            </h1>
            <StatusChip status={venue.status} />
            {open.status === "open" ? (
              <span style={openChip}>
                <span aria-hidden style={{ fontSize: 8 }}>●</span> {open.nextChange ? t("header.openNowTill", { time: open.nextChange.at }) : t("header.openNow")}
              </span>
            ) : open.status === "closed" ? (
              <span style={{ ...openChip, color: "var(--muted)", background: "var(--paper-2)" }}>
                {open.nextChange ? t("header.closedOpens", { time: open.nextChange.at }) : t("header.closed")}
              </span>
            ) : null}
          </div>
          <div style={{ marginTop: 3, fontSize: 13.5, color: "var(--ink-2)" }}>
            {[venue.category, [venue.locality, venue.region].filter(Boolean).join(", ")].filter(Boolean).join(" · ")}
          </div>
        </div>
      </div>
      <Link href={venuePath(venue.slug ?? venueId)} style={{ textDecoration: "none", flexShrink: 0 }}>
        <Button variant="neutral" size="sm">{t("header.viewPublicPage")}</Button>
      </Link>
    </div>
  );
}

const openChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 10px",
  borderRadius: 999,
  fontFamily: "var(--mono)",
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: ".03em",
  color: "var(--success)",
  background: "var(--success-tint)",
  whiteSpace: "nowrap",
};

/** The venue's cover photo as a 48px avatar tile; a tinted-initial tile when there's none. */
function VenueAvatar({ venueId, name }: { venueId: string; name: string }) {
  const trpc = useTrpc();
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const photos = trpc.venues.photosByVenue as unknown as {
      query: (i: { venueId: string }) => Promise<{ id: string; is_cover: boolean }[]>;
    };
    const media = trpc.venues.photoMediaUrl as unknown as {
      query: (i: { photoId: string }) => Promise<{ url: string }>;
    };
    photos
      .query({ venueId })
      .then((rows) => {
        const cover = (rows ?? []).find((p) => p.is_cover) ?? (rows ?? [])[0];
        if (!cover || cancelled) return null;
        return media.query({ photoId: cover.id }).then((r) => {
          if (!cancelled && r?.url) setUrl(r.url);
        });
      })
      .catch(() => {
        /* initial tile stays */
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  if (url) {
    // eslint-disable-next-line @next/next/no-img-element -- short-lived resolved media URL
    return <img src={url} alt="" style={{ width: 48, height: 48, borderRadius: 14, objectFit: "cover", flexShrink: 0 }} />;
  }
  return (
    <span
      aria-hidden
      style={{ width: 48, height: 48, borderRadius: 14, background: "linear-gradient(140deg, var(--crimson-tint), var(--crimson-tint-2))", color: "var(--crimson-700)", display: "grid", placeItems: "center", fontFamily: "var(--display)", fontWeight: 700, fontSize: 20, flexShrink: 0 }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}

function StatusChip({ status }: { status: string }) {
  const t = useTranslations("venueOwnerEditor");
  const claimed = status === "claimed";
  return (
    <span
      style={{
        flexShrink: 0,
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 10px",
        borderRadius: 999,
        fontFamily: "var(--mono)",
        fontSize: 10,
        letterSpacing: ".05em",
        textTransform: "uppercase",
        fontWeight: 700,
        color: claimed ? "var(--success)" : "var(--muted)",
        background: claimed ? "var(--success-tint)" : "var(--paper-2)",
      }}
    >
      {claimed ? <><Icon name="check" size={10} strokeWidth={3} /> {t("header.claimed")}</> : status.replace(/_/g, " ")}
    </span>
  );
}

/* ── Stat strip ──────────────────────────────────────────────────────────────────────── */

function StatRow({ venue, data }: { venue: OwnerVenue; data: DashData }) {
  const t = useTranslations("venueOwnerEditor");
  const { audience, views, growth, engagement } = data;

  const viewsDelta = views && views.previousTotal > 0
    ? Math.round(((views.total - views.previousTotal) / views.previousTotal) * 100)
    : null;

  return (
    <div className={styles.statRow}>
      <StatCard
        glyph="heart"
        label={t("stats.followers")}
        value={audience ? audience.followers.toLocaleString() : "–"}
        delta={audience && audience.new30 > 0 ? t("stats.newThisMonth", { count: audience.new30 }) : audience ? t("stats.noChangeThisMonth") : undefined}
        up={!!audience && audience.new30 > 0}
        spark={growth?.map((w) => w.count)}
      />
      <StatCard
        glyph="chat"
        label={t("stats.profileViews")}
        value={views ? views.total.toLocaleString() : "–"}
        delta={
          views
            ? viewsDelta != null
              ? t("stats.viewsDelta", { delta: `${viewsDelta >= 0 ? "+" : ""}${viewsDelta}` })
              : t("stats.viewsTrackingNew")
            : undefined
        }
        up={viewsDelta != null && viewsDelta > 0}
        spark={views?.daily.slice(-14).map((d) => d.views)}
      />
      <StatCard
        glyph="redeem"
        label={t("stats.offerRedemptions")}
        value={engagement ? engagement.totals.redemptions.toLocaleString() : "–"}
        delta={engagement ? t("stats.savesAllTime", { count: engagement.totals.saves.toLocaleString() }) : undefined}
        up={!!engagement && engagement.totals.redemptions > 0}
      />
      <StatCard
        glyph="card"
        label={t("stats.shopRevenue")}
        value={data.revenuePence != null ? formatPence(data.revenuePence) : "–"}
        delta={data.salesCount != null ? t("stats.ordersAllTime", { count: data.salesCount }) : undefined}
        up={!!data.revenuePence && data.revenuePence > 0}
      />
      <StatCard
        glyph="star"
        label={t("stats.rating")}
        value={venue.rating != null ? venue.rating.toFixed(1) : "–"}
        delta={venue.rating_count ? t("stats.reviews", { count: venue.rating_count.toLocaleString() }) : t("stats.noReviews")}
        gold
      />
    </div>
  );
}

function StatCard({
  glyph,
  label,
  value,
  delta,
  up,
  gold,
  spark,
}: {
  glyph: IconName;
  label: string;
  value: string;
  delta?: string | undefined;
  up?: boolean;
  gold?: boolean;
  spark?: number[] | undefined;
}) {
  const bars = spark && spark.some((v) => v > 0) ? spark : null;
  const peak = bars ? Math.max(...bars) : 1;
  return (
    <div className={styles.statCard}>
      <div className={styles.statLabel}>
        <Icon name={glyph} size={13} /> {label}
      </div>
      {bars ? (
        <div className={styles.spark} aria-hidden>
          {bars.map((v, i) => (
            <span key={i} className={styles.sparkBar} style={{ height: `${Math.max(12, Math.round((v / peak) * 100))}%` }} />
          ))}
        </div>
      ) : null}
      <div className={styles.statValue}>
        {value}
        {gold && value !== "–" ? <span style={{ color: "var(--gold)", fontSize: 18, marginLeft: 4 }}>★</span> : null}
      </div>
      {delta ? (
        <div className={styles.statDelta}>
          {up ? <span className={styles.deltaUp}>▲</span> : null}
          <span>{delta}</span>
        </div>
      ) : null}
    </div>
  );
}

/* ── Tabs ────────────────────────────────────────────────────────────────────────────── */

function DashTabs({ tab, onTab }: { tab: TabKey; onTab: (t: TabKey) => void }) {
  const t = useTranslations("venueOwnerEditor");
  return (
    <div
      style={{
        display: "flex",
        gap: 2,
        overflowX: "auto",
        marginBottom: "var(--space-4)",
        borderBottom: "1px solid var(--line)",
        scrollbarWidth: "none",
      }}
    >
      {TABS.map((tabKey) => {
        const active = tabKey === tab;
        return (
          <button
            key={tabKey}
            type="button"
            onClick={() => onTab(tabKey)}
            aria-current={active ? "page" : undefined}
            style={{
              all: "unset",
              cursor: "pointer",
              whiteSpace: "nowrap",
              padding: "10px 14px",
              minHeight: 44,
              boxSizing: "border-box",
              display: "inline-flex",
              alignItems: "center",
              fontFamily: "var(--ui)",
              fontSize: 14,
              fontWeight: 600,
              color: active ? "var(--crimson-700)" : "var(--muted)",
              borderBottom: `2px solid ${active ? "var(--crimson)" : "transparent"}`,
            }}
          >
            {t(`tabs.${tabKey}`)}
          </button>
        );
      })}
    </div>
  );
}

/* ── Overview pieces ─────────────────────────────────────────────────────────────────── */

/**
 * NextBestAction — the banner at the top of Overview. Built from the venue's own live
 * numbers (never invented): push credits + follower count pick the most useful nudge.
 */
function NextBestAction({ data, onTab }: { data: DashData; onTab: (t: TabKey) => void }) {
  const t = useTranslations("venueOwnerEditor");
  const followers = data.audience?.followers ?? null;
  const credits = data.credits;
  if (followers == null) return null;

  const noFollowers = followers === 0;
  const title = noFollowers
    ? t("nextBestAction.titleNoFollowers")
    : t("nextBestAction.titleFollowers");
  const sub = noFollowers
    ? t("nextBestAction.subNoFollowers")
    : credits != null && credits > 0
      ? t("nextBestAction.subFollowersCredits", { followers: followers.toLocaleString(), credits })
      : t("nextBestAction.subFollowers", { followers: followers.toLocaleString() });

  return (
    <div className={styles.banner}>
      <span className={styles.bannerGlyph} aria-hidden>
        <Icon name="sparkle" size={18} />
      </span>
      <div style={{ flex: 1, minWidth: 220 }}>
        <div className={styles.bannerKicker}>{t("nextBestAction.kicker")}</div>
        <div className={styles.bannerTitle}>{title}</div>
        <p className={styles.bannerSub}>{sub}</p>
      </div>
      <Button variant="pri" onClick={() => onTab(noFollowers ? "posts" : "offers")}>
        {noFollowers ? t("nextBestAction.writePost") : t("nextBestAction.createOffer")}
      </Button>
    </div>
  );
}

/**
 * PerformanceCard — daily profile views (solid crimson area) with weekly new followers
 * (dashed gold), over a 30d/90d window. Views data exists from migration 0068 onward,
 * so an empty window says so instead of drawing a fake curve.
 */
function PerformanceCard({
  venueId,
  initialViews,
  growth,
}: {
  venueId: string;
  initialViews: ViewStats | null;
  growth: GrowthWeek[] | null;
}) {
  const t = useTranslations("venueOwnerEditor");
  const trpc = useTrpc();
  const [days, setDays] = useState<30 | 90>(30);
  const [views, setViews] = useState<ViewStats | null>(initialViews);

  // Adopt the shared 30d load when it lands; refetch only when the seg flips to 90d.
  useEffect(() => {
    if (days === 30) {
      setViews(initialViews);
      return;
    }
    let cancelled = false;
    const vs = trpc.venues.viewStats as unknown as { query: (i: { venueId: string; days: 30 | 90 }) => Promise<ViewStats> };
    vs.query({ venueId, days })
      .then((v) => {
        if (!cancelled) setViews(v);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [days, initialViews, trpc, venueId]);

  const newFollowers = growth ? growth.reduce((n, w) => n + w.count, 0) : null;

  return (
    <Card style={{ padding: "var(--space-4) var(--space-5)" }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap", marginBottom: "var(--space-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)" }}>
            <Icon name="poll" size={16} />
          </span>
          <div>
            <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>{t("performance.title")}</h2>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-2)" }}>{t("performance.subtitle", { days })}</p>
          </div>
        </div>
        <Seg
          options={[
            { value: "30", label: t("performance.seg30") },
            { value: "90", label: t("performance.seg90") },
          ]}
          value={String(days)}
          onChange={(v) => setDays(v === "90" ? 90 : 30)}
        />
      </div>

      <ViewsChart views={views} />

      <div style={{ display: "flex", gap: "var(--space-4)", marginTop: "var(--space-3)", flexWrap: "wrap", fontSize: 12.5, color: "var(--ink-2)" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, background: "var(--crimson)" }} />
          {t("performance.viewsLegend", { count: views ? views.total.toLocaleString() : "–" })}
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={{ width: 10, height: 10, borderRadius: 3, background: "var(--gold)" }} />
          {t("performance.followersLegend", { count: newFollowers != null ? newFollowers.toLocaleString() : "–" })}
        </span>
      </div>
    </Card>
  );
}

/** The SVG chart body: a filled crimson line of daily views. Data-honest empty state. */
function ViewsChart({ views }: { views: ViewStats | null }) {
  const t = useTranslations("venueOwnerEditor");
  if (!views || views.daily.length === 0 || views.total === 0) {
    return (
      <div style={{ height: 160, borderRadius: 14, background: "var(--paper-2)", display: "grid", placeItems: "center", padding: "var(--space-3)" }}>
        <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", textAlign: "center", lineHeight: 1.5 }}>
          {t("performance.emptyChart")}
        </p>
      </div>
    );
  }

  const W = 600;
  const H = 160;
  const pad = 8;
  const points = views.daily;
  const peak = Math.max(1, ...points.map((p) => p.views));
  const x = (i: number) => (points.length === 1 ? W / 2 : pad + (i / (points.length - 1)) * (W - pad * 2));
  const y = (v: number) => H - pad - (v / peak) * (H - pad * 2);
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.views).toFixed(1)}`).join(" ");
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pad} L${x(0).toFixed(1)},${H - pad} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 160, display: "block" }} role="img" aria-label={t("performance.chartAria", { peak })}>
      <path d={area} fill="rgba(194,18,63,.09)" />
      <path d={line} fill="none" stroke="var(--crimson)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** RecentPosts — the venue's latest updates at a glance; the Posts tab holds the full list. */
function RecentPosts({ venueId, onTab }: { venueId: string; onTab: (t: TabKey) => void }) {
  const t = useTranslations("venueOwnerEditor");
  const trpc = useTrpc();
  const [posts, setPosts] = useState<{ id: string; title: string | null; body: string | null; publishedAt: string | null; createdAt: string }[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const mine = trpc.posts.mine as unknown as {
      query: (i: { venueId: string; limit?: number }) => Promise<{ id: string; title: string | null; body: string | null; publishedAt: string | null; createdAt: string }[]>;
    };
    mine
      .query({ venueId, limit: 3 })
      .then((rows) => {
        if (!cancelled) setPosts(Array.isArray(rows) ? rows.slice(0, 3) : []);
      })
      .catch(() => {
        if (!cancelled) setPosts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, venueId]);

  return (
    <Card style={{ padding: "var(--space-4) var(--space-5)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", marginBottom: "var(--space-3)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          <span aria-hidden style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)" }}>
            <Icon name="megaphone" size={16} />
          </span>
          <div>
            <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>{t("recentPosts.title")}</h2>
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--ink-2)" }}>{t("recentPosts.subtitle")}</p>
          </div>
        </div>
        <button type="button" onClick={() => onTab("posts")} style={{ all: "unset", cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--crimson-700)", whiteSpace: "nowrap" }}>
          {t("recentPosts.allPosts")} <span aria-hidden>→</span>
        </button>
      </div>

      {posts === null ? (
        <div style={{ height: 88, borderRadius: 14, background: "var(--paper-2)" }} aria-hidden />
      ) : posts.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
          {t("recentPosts.empty")}
        </p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
          {posts.map((p) => (
            <li key={p.id} style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)", padding: "12px 14px", borderRadius: 14, border: "1px solid var(--line)" }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontFamily: "var(--ui)", fontWeight: 600, fontSize: 14, color: "var(--ink)" }}>{p.title?.trim() || t("recentPosts.untitled")}</div>
                {p.body ? (
                  <p style={{ margin: "2px 0 0", fontSize: 12.5, color: "var(--ink-2)", lineHeight: 1.45, overflow: "hidden", textOverflow: "ellipsis", display: "-webkit-box", WebkitLineClamp: 1, WebkitBoxOrient: "vertical" }}>
                    {p.body}
                  </p>
                ) : null}
              </div>
              <span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap", flexShrink: 0 }}>{timeAgo(p.publishedAt ?? p.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function QuickTile({ glyph, label, onClick }: { glyph: IconName; label: string; onClick: () => void }) {
  return (
    <button type="button" className={styles.quickTile} onClick={onClick}>
      <span className={styles.quickGlyph} aria-hidden>
        <Icon name={glyph} size={16} />
      </span>
      {label}
    </button>
  );
}

/* ── Audience tab ────────────────────────────────────────────────────────────────────── */

/** Age-band wire keys, in display order — labels come from the catalogue
 *  (venueOwnerEditor.audience.ageBands.*). */
const BAND_ORDER: string[] = [
  "under_18",
  "age_18_24",
  "age_25_34",
  "age_35_44",
  "age_45_54",
  "age_55_64",
  "age_65_plus",
];

function AudienceTab({ venueId, data }: { venueId: string; data: DashData }) {
  const t = useTranslations("venueOwnerEditor");
  const { audience, growth, views } = data;

  const engagedPct = audience && audience.followers > 0 ? Math.round((audience.engaged30 / audience.followers) * 100) : null;
  const avgWeeklyViews = views ? Math.round(views.total / (views.days / 7)) : null;
  const bands = audience?.ageBands ?? null;
  const bandTotal = bands ? Math.max(1, Object.values(bands).reduce((a, b) => a + b, 0)) : 1;
  const bandPeak = bands ? Math.max(1, ...Object.values(bands)) : 1;
  const growthPeak = growth ? Math.max(1, ...growth.map((w) => w.count)) : 1;

  return (
    <div style={{ display: "grid", gap: "var(--space-4)" }}>
      <div className={styles.duo}>
        <DashCard icon="users" title={t("audience.yourAudienceTitle")} subtitle={t("audience.yourAudienceSubtitle")}>
          {audience ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "var(--space-2)" }}>
              <AudTile value={audience.followers.toLocaleString()} label={t("audience.followers")} sub={audience.new30 > 0 ? t("audience.newSub", { count: audience.new30 }) : undefined} />
              <AudTile value={engagedPct != null ? `${engagedPct}%` : "–"} label={t("audience.engaged30")} />
              <AudTile value={audience.pushReach.toLocaleString()} label={t("audience.pushReach")} />
              <AudTile value={avgWeeklyViews != null ? avgWeeklyViews.toLocaleString() : "–"} label={t("audience.avgWeeklyViews")} />
            </div>
          ) : (
            <div style={{ height: 120, borderRadius: 14, background: "var(--paper-2)" }} aria-hidden />
          )}
        </DashCard>

        <DashCard icon="poll" title={t("audience.growthTitle")} subtitle={t("audience.growthSubtitle")}>
          {growth && growth.length > 0 ? (
            <div className={styles.bars}>
              {growth.map((w, i) => (
                <div key={w.weekStart} className={styles.barCol}>
                  <span
                    className={`${styles.bar} ${i === growth.length - 1 ? styles.barHot : ""}`}
                    style={{ height: `${Math.max(4, Math.round((w.count / growthPeak) * 100))}%` }}
                    title={t("audience.newFollowersTitle", { count: w.count })}
                  />
                  <span className={styles.barLabel}>{t("audience.week", { n: i + 1 })}</span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
              {t("audience.growthEmpty")}
            </p>
          )}
        </DashCard>
      </div>

      <div className={styles.duo}>
        <DashCard icon="person" title={t("audience.ageTitle")} subtitle={t("audience.ageSubtitle")}>
          {bands ? (
            <div style={{ display: "grid", gap: 10 }}>
              {BAND_ORDER.filter((b) => (bands[b] ?? 0) > 0).map((b) => {
                const n = bands[b] ?? 0;
                return (
                  <div key={b} style={{ display: "grid", gridTemplateColumns: "56px 1fr 40px", alignItems: "center", gap: "var(--space-2)" }}>
                    <span style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{t(`audience.ageBands.${b}`)}</span>
                    <span style={{ height: 8, borderRadius: 999, background: "var(--paper-2)", overflow: "hidden" }}>
                      <span style={{ display: "block", width: `${Math.round((n / bandPeak) * 100)}%`, height: "100%", background: "var(--crimson)", borderRadius: 999 }} />
                    </span>
                    <span style={{ fontSize: 12, color: "var(--muted)", textAlign: "right" }}>{Math.round((n / bandTotal) * 100)}%</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p style={{ margin: 0, fontSize: 13.5, color: "var(--ink-2)", lineHeight: 1.5 }}>
              {t("audience.ageEmpty")}
            </p>
          )}
        </DashCard>

        <DashCard icon="cake" title={t("audience.birthdayTitle")} subtitle={t("audience.birthdaySubtitle")}>
          {audience?.birthdaysThisMonth != null ? (
            <p style={{ margin: "0 0 var(--space-3)", fontSize: 13, color: "var(--ink-2)" }}>
              {t.rich("audience.birthdaysThisMonth", {
                count: audience.birthdaysThisMonth,
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          ) : null}
          <BirthdayOffer venueId={venueId} />
        </DashCard>
      </div>
    </div>
  );
}

function AudTile({ value, label, sub }: { value: string; label: string; sub?: string | undefined }) {
  return (
    <div style={{ padding: "14px 16px", borderRadius: 14, border: "1px solid var(--line)", background: "var(--card)" }}>
      <div style={{ fontFamily: "var(--display)", fontWeight: 700, fontSize: 24, color: "var(--ink-hi)", lineHeight: 1 }}>{value}</div>
      <div style={{ marginTop: 5, fontSize: 12, color: "var(--muted)" }}>{label}</div>
      {sub ? <div style={{ marginTop: 3, fontSize: 11.5, fontWeight: 700, color: "var(--success)" }}>{sub}</div> : null}
    </div>
  );
}

/* ── Shared shells ───────────────────────────────────────────────────────────────────── */

/** A dashboard card shell — icon chip + title (+ optional subtitle), then the content. */
function DashCard({ icon, title, subtitle, children }: { icon: IconName; title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <Card style={{ padding: "var(--space-4) var(--space-5)", minWidth: 0 }}>
      <header style={{ display: "flex", alignItems: "flex-start", gap: "var(--space-3)", marginBottom: "var(--space-4)" }}>
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: 10, background: "var(--crimson-tint)", color: "var(--crimson-700)", flexShrink: 0 }}>
          <Icon name={icon} size={16} />
        </span>
        <div style={{ minWidth: 0 }}>
          <h2 className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600, fontSize: 17, margin: 0 }}>{title}</h2>
          {subtitle ? <p style={{ margin: "2px 0 0", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>{subtitle}</p> : null}
        </div>
      </header>
      {children}
    </Card>
  );
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", maxWidth: 440, margin: "0 auto" }}>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>{title}</div>
      <p style={{ color: "var(--muted)", lineHeight: 1.55 }}>{body}</p>
    </div>
  );
}

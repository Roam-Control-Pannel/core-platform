/**
 * VenueCard — renders a venue from venues.list / venues.near. Two states, both
 * first-class, and a link into the full detail page (/venue/[id]).
 *
 *  - CLAIMED (owner_id set): name, ★rating (gold), category. The cover is the venue's hero
 *    photo (owner cover, else Google Places); venues with no photo fall back to the shared
 *    illustrated cover (see CardCover / FallbackCover), never a broken image.
 *  - UNCLAIMED: the global-launch median experience, designed to look INTENTIONAL, not
 *    broken or provisional. Earlier this card signalled "not real yet" three ways at once
 *    (dashed border + pink placeholder + claim pill); that read as a busy grid because at
 *    launch *every* seed venue is unclaimed, so the busy treatment was all you ever saw.
 *    Now it's a normal card border + the same cover treatment (real photo when there is
 *    one, else the illustrated fallback), and the single unclaimed signal is the quiet
 *    "Claim it free" pill. "From public sources" recedes to a faint footnote. No rating
 *    (there isn't one). The claim affordance itself lives on the detail page — the card is
 *    the navigational entry, keeping one clear claim CTA.
 *
 * Distance: when the card is fed from venues.near it carries `distanceM`, and a tinted
 * pill over the cover renders a real, RPC-computed distance (formatted by a local
 * helper). When fed from the no-origin `list`, distanceM is undefined and no pill
 * shows — we still never fake one.
 *
 * Mobile note: this card is the grid's repeated unit (up to ~50 per load, single-column
 * on phones). Two things follow from that: (1) all static style objects are hoisted to
 * module scope so each card doesn't reallocate them per render, and (2) the component is
 * memoised — Explore re-renders on unrelated state (auth modal, sub-category filter,
 * place header) and the props here are primitives over a stable venue ref, so a shallow
 * memo skips the whole grid's reconciliation on those.
 */
"use client";

import { memo, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import styles from "./VenueCard.module.css";
import Link from "next/link";
import { Card, Pill, Rate, Icon } from "@roam/design";
import { FollowButton } from "./FollowButton";
import { useTrpc } from "./TrpcProvider";
import { venuePath } from "../lib/routes";

/**
 * Local mirror of @roam/core's geo.formatDistance. Core is a Node-ESM package (its
 * internal imports carry .js suffixes), so bundling it into this client component
 * trips Turbopack's resolver — and dragging the whole core package (plus its @roam/db
 * dependency) into the browser just for a four-line formatter is the wrong trade. This
 * is a pure presentation helper; it lives here. (If a shared browser-safe core subset
 * ever exists, swap this back to that import.)
 */
function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  const km = metres / 1000;
  return km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`;
}

/** Compact rating count for the card: 1240 → "1.2k", 980 → "980". */
function formatRatingCount(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return k < 10 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

/**
 * Google price-level enum → a £ run. Null/unspecified is filtered upstream (core
 * normalizePriceLevel), so this only ever sees a meaningful level. The £ runs are
 * currency glyphs (not translated); "Free" is the one worded label, so it comes from
 * the catalogue.
 */
const PRICE_LEVEL_LABELS: Record<string, string> = {
  PRICE_LEVEL_INEXPENSIVE: "£",
  PRICE_LEVEL_MODERATE: "££",
  PRICE_LEVEL_EXPENSIVE: "£££",
  PRICE_LEVEL_VERY_EXPENSIVE: "££££",
};

function priceLevelLabel(
  t: ReturnType<typeof useTranslations>,
  level: string | null | undefined,
): string | null {
  if (!level) return null;
  if (level === "PRICE_LEVEL_FREE") return t("priceFree");
  return PRICE_LEVEL_LABELS[level] ?? null;
}

export interface VenueCardData {
  id: string;
  name: string;
  claimed: boolean;
  category: string | null;
  rating: number | null;
  /** Number of Google ratings behind `rating`, for the "(1,240)" credibility cue. */
  ratingCount?: number | null | undefined;
  /** Google price-level enum ("PRICE_LEVEL_*"), rendered as £..££££. Null → no chip. */
  priceLevel?: string | null | undefined;
  /** Google's clean type label ("Coffee shop"); preferred over the coarse `category`. */
  primaryTypeLabel?: string | null | undefined;
  /** Google businessStatus; "CLOSED_TEMPORARILY" badges the card. (Permanently-closed
   *  venues are dropped at ingest and never reach here.) */
  businessStatus?: string | null | undefined;
  /** Metres from the search origin, present only when sourced from venues.near. */
  distanceM?: number | undefined;
  /**
   * Matched Google Places leaf types (the sub-categories), in Places order. Present
   * when sourced from venues.near / venues.inCategoryNear; powers Explore's
   * sub-category strip. The card itself does not render these.
   */
  categories?: string[] | undefined;
  /**
   * The venue's hero photo id (owner-cover-aware), when it has one. The card lazily
   * resolves it to a cover image; null/absent → the tinted placeholder tile.
   */
  coverPhotoId?: string | null | undefined;
  /** Venue coordinates (for the Explore map pins). Not rendered by the card itself. */
  lat?: number | undefined;
  lng?: number | undefined;
}

/** Whether the caller follows this venue, seeded from Explore's followingSet. */
interface VenueCardProps {
  venue: VenueCardData;
  initialFollowing?: boolean;
  /**
   * A cover url already resolved by the host (Explore batch-resolves a whole page in one
   * call). When present the card renders it immediately — no per-card round-trip, no
   * fallback-then-swap flash. Absent → the card lazily resolves coverPhotoId itself.
   */
  coverUrl?: string | undefined;
}

/* ── Hoisted static styles (allocated once, not per card render) ────────────────── */

const linkStyle: CSSProperties = { textDecoration: "none", color: "inherit", display: "block" };

const cardBody: CSSProperties = {
  padding: "var(--space-3) var(--space-4)",
  display: "grid",
  gap: 6,
};

// Card title at the improved design's scale — the name leads the card below the tall cover.
const nameStyle: CSSProperties = { fontFamily: "var(--display)", fontWeight: 600, fontSize: 17.5, lineHeight: 1.25, letterSpacing: "-.01em" };

// One line, no wrapping: the rating/price atoms stay intact and the type label is the
// single flexible element — it truncates with an ellipsis when space is tight, instead
// of the whole row reflowing. Dots separate the atoms (the improved design's meta rhythm).
const metaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  fontSize: 13.5,
  color: "var(--ink-2)",
  flexWrap: "nowrap",
  minWidth: 0,
};

// The type label ("Clothing Store") — the only element allowed to shrink; ellipsis when it
// can't fit so it never wraps to a second line.
const labelStyle: CSSProperties = {
  flex: "0 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const metaDot: CSSProperties = { color: "var(--faint)", flex: "0 0 auto" };

// Rating + its count sit together ("4.6 ★ (1.2k)"); the count is a quiet secondary cue.
const ratingCluster: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flex: "0 0 auto",
  whiteSpace: "nowrap",
};
const ratingCountStyle: CSSProperties = { color: "var(--faint)", fontSize: 12.5 };
const priceStyle: CSSProperties = { color: "var(--ink-2)", fontWeight: 600, flex: "0 0 auto" };

// Distance — a soft crimson-tinted mono pill floated over the cover, top-left (per the
// improved design), instead of a chip squeezed into the meta row.
const distancePill: CSSProperties = {
  position: "absolute",
  top: "var(--space-3)",
  left: "var(--space-3)",
  padding: "4px 12px",
  borderRadius: 999,
  fontFamily: "var(--mono)",
  fontSize: 11.5,
  fontWeight: 600,
  letterSpacing: ".02em",
  color: "var(--crimson-700)",
  background: "var(--crimson-tint)",
  boxShadow: "var(--shadow-key)",
};

// Temporarily-closed badge — a quiet warning chip over the cover, top-right (the distance
// pill owns the top-left corner).
const closedBadge: CSSProperties = {
  position: "absolute",
  top: "var(--space-3)",
  right: "var(--space-3)",
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 11,
  fontWeight: 600,
  color: "#fff",
  background: "rgba(33,29,26,.72)",
  backdropFilter: "blur(2px)",
};
const coverWrap: CSSProperties = { position: "relative" };

// The footer strip below a hairline: claim/provenance status on the left, the card's one
// action (Follow / Claim it free) on the right.
const footerRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-2)",
  borderTop: "1px solid var(--line)",
  margin: "var(--space-2) 0 0",
  padding: "var(--space-3) var(--space-4)",
};

// The "✓ Claimed" trust chip — the mono/uppercase status language, in success green.
const claimedChip: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 10px",
  borderRadius: 8,
  fontFamily: "var(--mono)",
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--success)",
  background: "var(--success-tint)",
  whiteSpace: "nowrap",
};

const actionWrap: CSSProperties = { flexShrink: 0 };

const coverImg: CSSProperties = { display: "block", width: "100%", height: 168, objectFit: "cover" };

/**
 * The default cover, shown when a venue has no Google Places photo and no owner-uploaded
 * cover. A flat "market street" illustration (public/venue-fallback.svg) — warm and on-brand,
 * so a venue with no real image still reads as an intentional card, not a broken/empty one.
 * To use bespoke artwork, replace that file (keep the path) or point this at a raster.
 */
const VENUE_FALLBACK_SRC = "/venue-fallback.svg";

const fallbackImg: CSSProperties = {
  display: "block",
  width: "100%",
  height: 168,
  objectFit: "cover",
  // a soft warm base shows for the instant before the SVG paints (no flash of empty box)
  background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))",
};

// Provenance, a quiet footer tag — present for honesty, styled to match the claimed chip's
// footprint (mono, uppercase) without borrowing its trust colour.
const provenance: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "5px 10px",
  borderRadius: 8,
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: ".06em",
  textTransform: "uppercase",
  color: "var(--muted)",
  background: "var(--paper-2)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

/**
 * The default illustrated cover (no Places photo, no owner cover). Same 168px height as a
 * real cover, so swapping it in causes no layout shift. Decorative → empty alt + aria-hidden.
 */
function FallbackCover() {
  return (
    // Local SVG asset, not an external/expiring URL, so next/image is fine to skip; it's
    // also tiny and identical across every card, so the browser caches one request.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={VENUE_FALLBACK_SRC} alt="" aria-hidden loading="lazy" style={fallbackImg} />
  );
}

/** Card-level click isolation for the follow control (the card itself is a <Link>). */
function isolateClick(e: { preventDefault: () => void; stopPropagation: () => void }) {
  e.preventDefault();
  e.stopPropagation();
}

/** Prefer Google's clean type label; fall back to our coarse category group. */
function typeLabel(venue: VenueCardData): string | null {
  return venue.primaryTypeLabel?.trim() || venue.category || null;
}

/**
 * The shared meta row — rating + count · type label · price level, dot-separated (the
 * improved design's rhythm; distance lives on the cover now). Used by both card states
 * (a Places rating is real supply whether or not the venue is claimed, so we surface it
 * on both). Renders nothing when the venue has none of these.
 */
function CardMeta({ venue }: { venue: VenueCardData }) {
  const t = useTranslations("venueCard");
  const price = priceLevelLabel(t, venue.priceLevel);
  const label = typeLabel(venue);
  const hasRating = venue.rating != null;
  if (!hasRating && !label && price == null) return null;
  return (
    <div style={metaRow}>
      {hasRating ? (
        <span style={ratingCluster}>
          <Rate value={venue.rating!.toFixed(1)} />
          {venue.ratingCount != null && venue.ratingCount > 0 ? (
            <span style={ratingCountStyle}>({formatRatingCount(venue.ratingCount)})</span>
          ) : null}
        </span>
      ) : null}
      {label ? (
        <>
          {hasRating ? <span style={metaDot} aria-hidden>·</span> : null}
          <span style={labelStyle}>{label}</span>
        </>
      ) : null}
      {price ? (
        <>
          {hasRating || label ? <span style={metaDot} aria-hidden>·</span> : null}
          <span style={priceStyle}>{price}</span>
        </>
      ) : null}
    </div>
  );
}

/** The cover plus its overlays — the distance pill (top-left) and, when Google says the
 *  venue is temporarily closed, the warning badge (top-right). */
function CoverWithBadge({
  venue,
  coverUrl,
}: {
  venue: VenueCardData;
  coverUrl: string | undefined;
}) {
  const t = useTranslations("venueCard");
  const closed = venue.businessStatus === "CLOSED_TEMPORARILY";
  return (
    <div style={coverWrap}>
      <CardCover coverPhotoId={venue.coverPhotoId} resolvedUrl={coverUrl} fallback={<FallbackCover />} />
      {venue.distanceM != null ? <span style={distancePill}>{formatDistance(venue.distanceM)}</span> : null}
      {closed ? <span style={closedBadge}>{t("temporarilyClosed")}</span> : null}
    </div>
  );
}

/**
 * The card's image slot: the venue's cover photo when it has one, else the tinted tile.
 * Resolves the cover id to a media url lazily via venues.photoMediaUrl (the API caches the
 * resolution, so repeated grid loads don't re-bill Google). Until it resolves — or if the
 * venue has no photo, or resolution fails — the `fallback` tile shows (same 132px height,
 * so no layout shift). Owner-uploaded covers come through the SAME id (the API picks the
 * owner cover over the Places photo), so an owner's chosen image just appears here.
 */
function CardCover({
  coverPhotoId,
  resolvedUrl,
  fallback,
}: {
  coverPhotoId: string | null | undefined;
  resolvedUrl: string | undefined;
  fallback: ReactNode;
}) {
  const trpc = useTrpc();
  const [url, setUrl] = useState<string | null>(resolvedUrl ?? null);

  useEffect(() => {
    // Host already resolved it (Explore's batch) — render immediately, no per-card call.
    if (resolvedUrl) {
      setUrl(resolvedUrl);
      return;
    }
    if (!coverPhotoId) return;
    let cancelled = false;
    const resolve = trpc.venues.photoMediaUrl as unknown as {
      query: (input: { photoId: string }) => Promise<{ url: string }>;
    };
    resolve
      .query({ photoId: coverPhotoId })
      .then((r) => {
        if (!cancelled) setUrl(r?.url ?? null);
      })
      .catch(() => {
        /* keep the fallback tile — never a broken image */
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, coverPhotoId, resolvedUrl]);

  if (!url) return <>{fallback}</>;
  return (
    // A plain <img>: the src is a short-lived, keyless googleusercontent / Storage URL
    // resolved fresh per mount (same rationale as VenueDetail's VenuePhoto). next/image
    // would cache a URL that expires and can't be re-optimised, so we opt out.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" loading="lazy" style={coverImg} />
  );
}

export const VenueCard = memo(function VenueCard({
  venue,
  initialFollowing = false,
  coverUrl,
}: VenueCardProps) {
  return (
    <Link href={venuePath(venue.id)} style={linkStyle} className={styles.card}>
      {venue.claimed ? (
        <ClaimedCard venue={venue} initialFollowing={initialFollowing} coverUrl={coverUrl} />
      ) : (
        <UnclaimedCard venue={venue} coverUrl={coverUrl} />
      )}
    </Link>
  );
});

function ClaimedCard({
  venue,
  initialFollowing,
  coverUrl,
}: {
  venue: VenueCardData;
  initialFollowing: boolean;
  coverUrl: string | undefined;
}) {
  const t = useTranslations("venueCard");
  return (
    <Card>
      <CoverWithBadge venue={venue} coverUrl={coverUrl} />
      <div style={cardBody}>
        <div className="t-h3" style={nameStyle}>
          {venue.name}
        </div>
        <CardMeta venue={venue} />
      </div>
      {/* Footer strip: the trust chip + the follow action, split by a hairline. */}
      <div style={footerRow}>
        <span style={claimedChip}>
          <Icon name="check" size={11} strokeWidth={2.5} /> {t("claimed")}
        </span>
        {/* Follow control. Wrapped in a click-isolating span: the card is a <Link>, so
            without stopPropagation/preventDefault a follow tap would navigate to the
            detail page. This keeps FollowButton host-agnostic (no Link awareness). */}
        <span onClick={isolateClick} style={actionWrap}>
          <FollowButton
            venueId={venue.id}
            initialFollowing={initialFollowing}
            emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
          />
        </span>
      </div>
    </Card>
  );
}

function UnclaimedCard({ venue, coverUrl }: { venue: VenueCardData; coverUrl: string | undefined }) {
  const t = useTranslations("venueCard");
  return (
    <Card>
      {/* cover photo when Places (or the owner) has one; else the default illustrated cover */}
      <CoverWithBadge venue={venue} coverUrl={coverUrl} />
      <div style={cardBody}>
        <div className="t-h3" style={nameStyle}>
          {venue.name}
        </div>
        <CardMeta venue={venue} />
      </div>
      {/* Footer strip: provenance on the left, the single unclaimed signal on the right. */}
      <div style={footerRow}>
        <span style={provenance}>{t("fromPublicSources")}</span>
        <span style={actionWrap}>
          <Pill variant="ghost-crim" size="sm">
            {t("claimItFree")}
          </Pill>
        </span>
      </div>
    </Card>
  );
}

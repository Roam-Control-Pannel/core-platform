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
 * Distance: when the card is fed from venues.near it carries `distanceM`, and the
 * DistanceChip renders a real, RPC-computed distance (formatted by a local helper).
 * When fed from the no-origin `list`, distanceM is undefined and no chip shows — we
 * still never fake one.
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
import Link from "next/link";
import { Card, Pill, Rate, DistanceChip } from "@roam/design";
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

export interface VenueCardData {
  id: string;
  name: string;
  claimed: boolean;
  category: string | null;
  rating: number | null;
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

const claimedBody: CSSProperties = {
  padding: "var(--space-3)",
  display: "grid",
  gap: "var(--space-1)",
};

const nameStyle: CSSProperties = { fontFamily: "var(--display)", fontWeight: 600 };

const metaRow: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--space-2)",
  fontSize: 12.5,
  color: "var(--ink-2)",
};

const distanceRight: CSSProperties = { marginLeft: "auto" };

const followWrap: CSSProperties = { marginTop: "var(--space-1)" };

const coverImg: CSSProperties = { display: "block", width: "100%", height: 132, objectFit: "cover" };

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
  height: 132,
  objectFit: "cover",
  // a soft warm base shows for the instant before the SVG paints (no flash of empty box)
  background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))",
};

const unclaimedBody: CSSProperties = {
  padding: "var(--space-3)",
  display: "grid",
  gap: "var(--space-2)",
};

const claimRow: CSSProperties = { display: "flex", gap: "var(--space-2)", marginTop: "var(--space-1)" };

// Provenance, demoted to a faint footnote — present for honesty, quiet enough to recede.
const provenance: CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 9.5,
  letterSpacing: ".04em",
  textTransform: "uppercase",
  color: "var(--faint)",
};

/**
 * The default illustrated cover (no Places photo, no owner cover). Same 132px height as a
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
    <Link href={venuePath(venue.id)} style={linkStyle}>
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
  return (
    <Card>
      <CardCover coverPhotoId={venue.coverPhotoId} resolvedUrl={coverUrl} fallback={<FallbackCover />} />
      <div style={claimedBody}>
        <div className="t-h3" style={nameStyle}>
          {venue.name}
        </div>
        <div style={metaRow}>
          {venue.rating != null ? <Rate value={venue.rating.toFixed(1)} /> : null}
          {venue.category ? <span>{venue.category}</span> : null}
          {venue.distanceM != null ? (
            <DistanceChip style={distanceRight}>{formatDistance(venue.distanceM)}</DistanceChip>
          ) : null}
        </div>
        {/* Follow control. Wrapped in a click-isolating div: the card is a <Link>, so
            without stopPropagation/preventDefault a follow tap would navigate to the
            detail page. This keeps FollowButton host-agnostic (no Link awareness). */}
        <div onClick={isolateClick} style={followWrap}>
          <FollowButton
            venueId={venue.id}
            initialFollowing={initialFollowing}
            emailRedirectTo={typeof window !== "undefined" ? window.location.href : ""}
          />
        </div>
      </div>
    </Card>
  );
}

function UnclaimedCard({ venue, coverUrl }: { venue: VenueCardData; coverUrl: string | undefined }) {
  return (
    <Card>
      {/* cover photo when Places (or the owner) has one; else the default illustrated cover */}
      <CardCover coverPhotoId={venue.coverPhotoId} resolvedUrl={coverUrl} fallback={<FallbackCover />} />
      <div style={unclaimedBody}>
        <div className="t-h3" style={nameStyle}>
          {venue.name}
        </div>
        {venue.category || venue.distanceM != null ? (
          <div style={metaRow}>
            {venue.category ? <span>{venue.category}</span> : null}
            {venue.distanceM != null ? (
              <DistanceChip style={distanceRight}>{formatDistance(venue.distanceM)}</DistanceChip>
            ) : null}
          </div>
        ) : null}
        {/* The single unclaimed signal. */}
        <div style={claimRow}>
          <Pill variant="ghost-crim" size="sm">
            Claim it free
          </Pill>
        </div>
        <div style={provenance}>From public sources</div>
      </div>
    </Card>
  );
}

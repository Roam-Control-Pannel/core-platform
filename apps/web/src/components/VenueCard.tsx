/**
 * VenueCard — renders a venue from venues.list / venues.near. Two states, both
 * first-class, and a link into the full detail page (/venue/[id]).
 *
 *  - CLAIMED (owner_id set): name, ★rating (gold), category. A warm brand tile sits on
 *    top; real photography wires in later (the list endpoint doesn't return images yet,
 *    so we show a tasteful gradient, not a broken image).
 *  - UNCLAIMED: the global-launch median experience, designed to look INTENTIONAL, not
 *    broken or provisional. Earlier this card signalled "not real yet" three ways at once
 *    (dashed border + pink placeholder + claim pill); that read as a busy grid because at
 *    launch *every* seed venue is unclaimed, so the busy treatment was all you ever saw.
 *    Now it's a normal card border + a calm warm locality tile, and the single unclaimed
 *    signal is the quiet "Claim it free" pill. "From public sources" recedes to a faint
 *    footnote. No rating (there isn't one). The claim affordance itself lives on the
 *    detail page — the card is the navigational entry, keeping one clear claim CTA.
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
import { memo, type CSSProperties } from "react";
import Link from "next/link";
import { Card, Pill, Rate, DistanceChip } from "@roam/design";
import { FollowButton } from "./FollowButton";
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
}

/** Whether the caller follows this venue, seeded from Explore's followingSet. */
interface VenueCardProps {
  venue: VenueCardData;
  initialFollowing?: boolean;
}

/* ── Hoisted static styles (allocated once, not per card render) ────────────────── */

const linkStyle: CSSProperties = { textDecoration: "none", color: "inherit", display: "block" };

const claimedTile: CSSProperties = {
  height: 132,
  background:
    "radial-gradient(120% 90% at 20% 10%, #e7b48a 0%, transparent 55%)," +
    "radial-gradient(120% 120% at 90% 90%, #7c3a2a 0%, transparent 60%)," +
    "linear-gradient(150deg, #c96b43, #8f3f29)",
};

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

// Calm warm locality tile. The earlier flat pink (var(--crimson-tint)) read as a
// "provisional" warning; this is a soft neutral→whisper-of-crimson wash that reads as an
// intentional placeholder. crimson-tint is a fills token, used here only as a faint
// gradient endpoint — not the "crimson as background wash" the palette rule forbids.
const unclaimedTile: CSSProperties = {
  height: 132,
  background: "linear-gradient(150deg, var(--paper-2), var(--crimson-tint))",
  display: "grid",
  placeItems: "center",
};

const unclaimedGlyph: CSSProperties = { fontSize: 24, color: "var(--faint)" };

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

/** Card-level click isolation for the follow control (the card itself is a <Link>). */
function isolateClick(e: { preventDefault: () => void; stopPropagation: () => void }) {
  e.preventDefault();
  e.stopPropagation();
}

export const VenueCard = memo(function VenueCard({ venue, initialFollowing = false }: VenueCardProps) {
  return (
    <Link href={venuePath(venue.id)} style={linkStyle}>
      {venue.claimed ? (
        <ClaimedCard venue={venue} initialFollowing={initialFollowing} />
      ) : (
        <UnclaimedCard venue={venue} />
      )}
    </Link>
  );
});

function ClaimedCard({
  venue,
  initialFollowing,
}: {
  venue: VenueCardData;
  initialFollowing: boolean;
}) {
  return (
    <Card>
      <div aria-hidden style={claimedTile} />
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

function UnclaimedCard({ venue }: { venue: VenueCardData }) {
  return (
    <Card>
      {/* calm warm locality tile — intentional placeholder, not a broken pin */}
      <div aria-hidden style={unclaimedTile}>
        <span style={unclaimedGlyph}>◍</span>
      </div>
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

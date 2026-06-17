/**
 * VenueCard — renders a venue from venues.list / venues.near. Two states, both
 * first-class, and now a link into the full detail page (/venue/[id]).
 *
 *  - CLAIMED (owner_id set): name, ★rating (gold), category. A photo slot sits on top;
 *    real photography wires in later (the list endpoint doesn't return images yet, so
 *    we show a tasteful tinted placeholder, not a broken image).
 *  - UNCLAIMED: the global-launch median experience, designed to look INTENTIONAL, not
 *    broken — a brand-tinted tile (no fake photo), the name, category if known, a
 *    "From public sources" honesty label. No rating (there isn't one). The claim
 *    affordance now lives on the detail page (the card is the navigational entry);
 *    this keeps one clear claim CTA rather than competing ones.
 *
 * Distance: when the card is fed from venues.near it carries `distanceM`, and the
 * DistanceChip renders a real, RPC-computed distance (formatted by a local helper).
 * When fed from the no-origin `list`, distanceM is undefined and no chip shows — we
 * still never fake one.
 */
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

export function VenueCard({ venue, initialFollowing = false }: VenueCardProps) {
  return (
    <Link href={venuePath(venue.id)} style={{ textDecoration: "none", color: "inherit", display: "block" }}>
      {venue.claimed ? (
        <ClaimedCard venue={venue} initialFollowing={initialFollowing} />
      ) : (
        <UnclaimedCard venue={venue} />
      )}
    </Link>
  );
}

function ClaimedCard({
  venue,
  initialFollowing,
}: {
  venue: VenueCardData;
  initialFollowing: boolean;
}) {
  return (
    <Card>
      <div
        aria-hidden
        style={{
          height: 132,
          background:
            "radial-gradient(120% 90% at 20% 10%, #e7b48a 0%, transparent 55%)," +
            "radial-gradient(120% 120% at 90% 90%, #7c3a2a 0%, transparent 60%)," +
            "linear-gradient(150deg, #c96b43, #8f3f29)",
        }}
      />
      <div style={{ padding: "var(--space-3)", display: "grid", gap: "var(--space-1)" }}>
        <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600 }}>
          {venue.name}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            fontSize: 12.5,
            color: "var(--ink-2)",
          }}
        >
          {venue.rating != null ? <Rate value={venue.rating.toFixed(1)} /> : null}
          {venue.category ? <span>{venue.category}</span> : null}
          {venue.distanceM != null ? (
            <DistanceChip style={{ marginLeft: "auto" }}>{formatDistance(venue.distanceM)}</DistanceChip>
          ) : null}
        </div>
        {/* Follow control. Wrapped in a click-isolating div: the card is a <Link>, so
            without stopPropagation/preventDefault a follow tap would navigate to the
            detail page. This keeps FollowButton host-agnostic (no Link awareness). */}
        <div
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          style={{ marginTop: "var(--space-1)" }}
        >
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
    <Card style={{ borderStyle: "dashed", borderColor: "var(--line-2)" }}>
      {/* brand-tinted locality tile — intentional, not a broken pin */}
      <div
        aria-hidden
        style={{
          height: 132,
          background: "var(--crimson-tint)",
          display: "grid",
          placeItems: "center",
        }}
      >
        <span style={{ fontSize: 26, color: "var(--crimson-700)", opacity: 0.55 }}>◍</span>
      </div>
      <div style={{ padding: "var(--space-3)", display: "grid", gap: "var(--space-2)" }}>
        <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 600 }}>
          {venue.name}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
          {venue.category ? (
            <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{venue.category}</div>
          ) : null}
          {venue.distanceM != null ? (
            <DistanceChip style={{ marginLeft: "auto" }}>{formatDistance(venue.distanceM)}</DistanceChip>
          ) : null}
        </div>
        <div
          style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            letterSpacing: ".04em",
            textTransform: "uppercase",
            color: "var(--muted)",
          }}
        >
          From public sources
        </div>
        <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-1)" }}>
          <Pill variant="ghost-crim" size="sm">
            Claim it free
          </Pill>
        </div>
      </div>
    </Card>
  );
}

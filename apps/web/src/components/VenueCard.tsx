/**
 * VenueCard — renders a venue from venues.list. Two states, both first-class:
 *
 *  - CLAIMED (owner_id set): name, ★rating (gold), category. A photo slot sits on top;
 *    real photography wires in later (the list endpoint doesn't return images yet, so
 *    we show a tasteful tinted placeholder, not a broken image).
 *  - UNCLAIMED: the global-launch median experience, designed to look INTENTIONAL, not
 *    broken — a brand-tinted tile (no fake photo), the name, category if known, a
 *    "From public sources" honesty label, and a quiet "Claim it free" affordance. No
 *    rating (there isn't one). This must read "new", not "dead".
 *
 * No distance chip: venues.list returns no distance (the PostGIS near-RPC isn't built),
 * so we don't fake one. When that RPC lands, the chip slots in here.
 */
import { Card, Pill, Rate } from "@roam/design";

export interface VenueCardData {
  id: string;
  name: string;
  claimed: boolean;
  category: string | null;
  rating: number | null;
}

export function VenueCard({ venue }: { venue: VenueCardData }) {
  return venue.claimed ? <ClaimedCard venue={venue} /> : <UnclaimedCard venue={venue} />;
}

function ClaimedCard({ venue }: { venue: VenueCardData }) {
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
        {venue.category ? (
          <div style={{ fontSize: 12.5, color: "var(--ink-2)" }}>{venue.category}</div>
        ) : null}
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
          <Pill size="sm">Suggest an edit</Pill>
        </div>
      </div>
    </Card>
  );
}

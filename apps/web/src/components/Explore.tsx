/**
 * Explore — the place-anchored home, and the screen that validates the architecture:
 * a real tRPC call (venues.near) → RLS-scoped data → the component kit → a navigable
 * screen. Ported from the hi-fi Consumer Discovery layout.
 *
 * Now LIVE on both the place switcher AND the feed (this slice):
 *   - The place header is a real PlaceSwitcher. Selecting a place (or "use my location")
 *     re-roots the venue query: `near` is re-issued from the chosen centre, so the grid
 *     re-orders near→far around wherever the user picked. The hardcoded Darlington
 *     constant is gone — Darlington is now just the DEFAULT_PLACE.
 *   - The Feed tab renders FeedList (real posts.feed query) instead of a placeholder,
 *     with its own skeleton/empty/error states. The launch-empty feed is the median
 *     case and reads "new, not dead".
 *
 * Venues load via `venues.near` from the selected place's centre, so the grid is ordered
 * near→far and each card carries a real RPC-computed distance. Loading uses a
 * content-shaped skeleton (not a spinner) per the States spec; empty reads "new".
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Seg, Pill } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { VenueCard, type VenueCardData } from "./VenueCard";
import { PlaceSwitcher, DEFAULT_PLACE, type Place } from "./PlaceSwitcher";
import { FeedList } from "./FeedList";

type Mode = "browse" | "feed";

export function Explore() {
  const trpc = useTrpc();
  const [mode, setMode] = useState<Mode>("browse");
  const [place, setPlace] = useState<Place>(DEFAULT_PLACE);
  const [venues, setVenues] = useState<VenueCardData[] | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-issue `near` from the selected place's centre whenever it changes. Resetting
  // venues to null first restores the skeleton, so a place switch reads as a real load.
  useEffect(() => {
    let cancelled = false;
    setVenues(null);
    setError(null);
    setActiveCategory(null);
    trpc.venues.near
      .query({ lat: place.lat, lng: place.lng, limit: 50 })
      .then((rows) => {
        if (cancelled) return;
        setVenues(
          rows.map((v) => ({
            id: v.id,
            name: v.name,
            claimed: v.claimed,
            category: v.category,
            rating: v.rating,
            distanceM: v.distanceM,
          })),
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load venues.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place]);

  const categories = useMemo(() => {
    if (!venues) return [];
    const set = new Set<string>();
    for (const v of venues) if (v.category) set.add(v.category);
    return Array.from(set).sort();
  }, [venues]);

  const shown = useMemo(() => {
    if (!venues) return [];
    return activeCategory ? venues.filter((v) => v.category === activeCategory) : venues;
  }, [venues, activeCategory]);

  return (
    <main style={{ maxWidth: 1080, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      {/* place header — now a live switcher */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-2) 0 var(--space-4)",
        }}
      >
        <PlaceSwitcher value={place} onChange={setPlace} />
        <Seg
          options={[
            { value: "browse", label: "Browse" },
            { value: "feed", label: "Feed" },
          ]}
          value={mode}
          onChange={(v) => setMode(v as Mode)}
        />
      </header>

      {mode === "feed" ? (
        <FeedList placeName={place.name} />
      ) : (
        <>
          {/* category pills */}
          {categories.length > 0 ? (
            <div
              style={{
                display: "flex",
                gap: "var(--space-2)",
                flexWrap: "wrap",
                paddingBottom: "var(--space-4)",
              }}
            >
              <button onClick={() => setActiveCategory(null)} style={{ all: "unset", cursor: "pointer" }}>
                <Pill variant={activeCategory === null ? "on" : "neutral"}>All</Pill>
              </button>
              {categories.map((c) => (
                <button
                  key={c}
                  onClick={() => setActiveCategory(c)}
                  style={{ all: "unset", cursor: "pointer" }}
                >
                  <Pill variant={activeCategory === c ? "on" : "neutral"}>{c}</Pill>
                </button>
              ))}
            </div>
          ) : null}

          {error ? (
            <ErrorState message={error} />
          ) : venues === null ? (
            <VenueGridSkeleton />
          ) : shown.length === 0 ? (
            <EmptyState />
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                gap: "var(--space-4)",
              }}
            >
              {shown.map((v) => (
                <VenueCard key={v.id} venue={v} />
              ))}
            </div>
          )}
        </>
      )}
    </main>
  );
}

function VenueGridSkeleton() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
        gap: "var(--space-4)",
      }}
    >
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            borderRadius: 16,
            border: "1px solid var(--line)",
            overflow: "hidden",
            background: "var(--card)",
          }}
        >
          <div style={{ height: 132, background: "var(--paper-2)" }} />
          <div style={{ padding: "var(--space-3)", display: "grid", gap: "var(--space-2)" }}>
            <div style={{ height: 14, width: "70%", background: "var(--paper-2)", borderRadius: 6 }} />
            <div style={{ height: 11, width: "45%", background: "var(--paper-2)", borderRadius: 6 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", color: "var(--ink-2)" }}>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Nothing here yet
      </div>
      <p style={{ color: "var(--muted)", maxWidth: 360, margin: "0 auto" }}>
        No venues match this view. Try another category or place, or check back as Roam grows in your area.
      </p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        Couldn&apos;t load venues
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}

/**
 * Explore — the place-anchored home, and the screen that validates the architecture:
 * a real tRPC call (venues.list) → RLS-scoped data → the component kit → a navigable
 * screen. Ported from the hi-fi Consumer Discovery layout.
 *
 * Now: place header (the switcher is a static label this slice — re-rooting is a later
 * seam), Browse/Feed seg (Feed is a placeholder pending the posts-feed query), category
 * pills derived from loaded venues, and the venue grid. Loading uses a content-shaped
 * skeleton (not a spinner) per the States spec; empty reads "new", not "dead".
 */
"use client";

import { useEffect, useMemo, useState } from "react";
import { Seg, Pill } from "@roam/design";
import { useTrpc } from "./TrpcProvider";
import { VenueCard, type VenueCardData } from "./VenueCard";

type Mode = "browse" | "feed";

export function Explore() {
  const trpc = useTrpc();
  const [mode, setMode] = useState<Mode>("browse");
  const [venues, setVenues] = useState<VenueCardData[] | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    trpc.venues.list
      .query({ limit: 50 })
      .then((rows) => {
        if (cancelled) return;
        setVenues(
          rows.map((v) => ({
            id: v.id,
            name: v.name,
            claimed: v.claimed,
            category: v.category,
            rating: v.rating,
          })),
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load venues.");
      });
    return () => {
      cancelled = true;
    };
  }, [trpc]);

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
      {/* place header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "var(--space-2) 0 var(--space-4)",
        }}
      >
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--space-2)",
            fontFamily: "var(--display)",
            fontWeight: 600,
            fontSize: 20,
          }}
        >
          <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--crimson)" }} />
          Darlington
          <span style={{ color: "var(--muted)", fontSize: 14 }}>▾</span>
        </div>
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
        <FeedPlaceholder />
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
        No venues match this view. Try another category, or check back as Roam grows in your area.
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

function FeedPlaceholder() {
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", color: "var(--muted)" }}>
      <p>The local feed is coming soon — geofenced posts from venues near you.</p>
    </div>
  );
}

/**
 * Explore — the place-anchored home, and the screen that proves Slice 2's full loop:
 * a category-pill tap triggers on-demand venue SUPPLY (POST /api/ingest, the server-side
 * gated hop to the API's internalProcedure), then reads the freshly-filled, tiered,
 * category-filtered set back via venues.inCategoryNear and renders it near→far with
 * claimed venues first.
 *
 * TWO LOAD PATHS, deliberately distinct:
 *   - DEFAULT / "All": venues.near from the place centre (all categories, near→far).
 *     This is the landing experience and the place-switch behaviour — unchanged from
 *     the prior slice. Keyed on the place via an effect.
 *   - CATEGORY VIEW: a pill tap runs loadCategory(group) — skeleton up, POST /api/ingest
 *     to fill supply, then venues.inCategoryNear page 1. This is a user ACTION with its
 *     own async lifecycle, NOT a place change, so it lives in its own handler with a
 *     generation-counter guard: rapid pill switching cancels stale loads (latest wins).
 *
 * SUB-CATEGORY STRIP: in a category view, a second horizontally-scrolling pill row of the
 * leaf types present in the loaded set (each venue carries its matched Places types in
 * `categories`). Tapping one filters the grid CLIENT-SIDE — no new fetch; the data is
 * already here. "All" sub-pill clears the leaf filter.
 *
 * Pagination: inCategoryNear returns hasMore/nextOffset; this slice renders page 1 only.
 * A "Load more" surface is the clean next slice (the read already supports it).
 *
 * Loading uses a content-shaped skeleton (not a spinner) per the States spec; empty
 * reads "new". The Feed tab is unchanged (FeedList with its own states).
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Seg, Pill } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { VenueCard, type VenueCardData } from "./VenueCard";
import { PlaceSwitcher, DEFAULT_PLACE, type Place } from "./PlaceSwitcher";
import { FeedList } from "./FeedList";
import { CATEGORY_GROUPS, categoryLabel } from "../lib/categories";
import styles from "./Explore.module.css";

type Mode = "browse" | "feed";

/** Map an inCategoryNear / near row to the card shape, carrying leaf categories. */
function toCardData(v: {
  id: string;
  name: string;
  claimed: boolean;
  category: string | null;
  rating: number | null;
  distanceM?: number | undefined;
  categories?: string[] | undefined;
}): VenueCardData {
  return {
    id: v.id,
    name: v.name,
    claimed: v.claimed,
    category: v.category,
    rating: v.rating,
    distanceM: v.distanceM,
    categories: v.categories,
  };
}

export function Explore() {
  const trpc = useTrpc();
  const session = useSession();
  const [mode, setMode] = useState<Mode>("browse");
  const [place, setPlace] = useState<Place>(DEFAULT_PLACE);
  const [venues, setVenues] = useState<VenueCardData[] | null>(null);
  // venue_ids the caller follows — read once per session, used to seed each card's
  // FollowButton so N cards don't each fetch. Empty when signed out (no follow state).
  const [followingSet, setFollowingSet] = useState<Set<string>>(new Set());
  // null = the "All" view (venues.near). A group name = a category view (ingest + read).
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // The selected leaf type within a category view, or null for "all sub-categories".
  const [activeSub, setActiveSub] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Free-text filter over the loaded set (client-side, by name). Sign-in now lives in the
  // global TopBar, so Explore's header is just the place switcher + Browse/Feed segment.
  const [query, setQuery] = useState("");

  // Generation counter: every load (All or category) bumps this; a completing load only
  // commits if it is still the latest. Guards against races from rapid pill switching
  // and place changes interleaving with in-flight ingests.
  const loadGen = useRef(0);

  // DEFAULT / "All" load: venues.near from the place centre. Runs on mount, on place
  // change, and when the user taps the "All" pill (via loadAll). Resetting venues to
  // null first restores the skeleton, so each (re)load reads as a real load.
  const loadAll = useCallback(() => {
    const gen = ++loadGen.current;
    setActiveCategory(null);
    setActiveSub(null);
    setVenues(null);
    setError(null);
    trpc.venues.near
      .query({ lat: place.lat, lng: place.lng, limit: 50 })
      .then((rows) => {
        if (loadGen.current !== gen) return;
        setVenues(rows.map(toCardData));
      })
      .catch((e: unknown) => {
        if (loadGen.current !== gen) return;
        setError(e instanceof Error ? e.message : "Failed to load venues.");
      });
  }, [trpc, place]);

  // CATEGORY view load: supply (POST /api/ingest) → tiered read (inCategoryNear page 1).
  // Its own lifecycle + generation guard so a later tap cancels an earlier in-flight one.
  const loadCategory = useCallback(
    (group: string) => {
      const gen = ++loadGen.current;
      setActiveCategory(group);
      setActiveSub(null);
      setVenues(null);
      setError(null);

      // Phase 1: fill supply via the server-side gated route. We await it but treat ALL
      // of its non-throwing outcomes (ingested / fresh-coverage / no-matching-places) as
      // "proceed to read" — the read is the source of truth for what to render.
      void (async () => {
        try {
          const res = await fetch("/api/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ category: group, lat: place.lat, lng: place.lng }),
          });
          if (!res.ok) {
            // A failed ingest is non-fatal: we can still read whatever already exists.
            // Log for the dev console; fall through to the read.
            console.warn(`[Explore] ingest for "${group}" returned ${res.status}`);
          }
        } catch (e) {
          console.warn(`[Explore] ingest for "${group}" failed`, e);
          // fall through — read existing supply
        }

        if (loadGen.current !== gen) return;

        // Phase 2: tiered, category-filtered read (claimed first, then near→far).
        try {
          const result = await trpc.venues.inCategoryNear.query({
            category: group,
            lat: place.lat,
            lng: place.lng,
            pageSize: 10,
            pageOffset: 0,
          });
          if (loadGen.current !== gen) return;
          setVenues(result.venues.map(toCardData));
        } catch (e: unknown) {
          if (loadGen.current !== gen) return;
          setError(e instanceof Error ? e.message : "Failed to load venues.");
        }
      })();
    },
    [trpc, place],
  );

  // Mount + place change → the All load. (Pill taps call loadAll/loadCategory directly.)
  useEffect(() => {
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place]);

  // Read the caller's follow set once (per session). Signed-out → empty set: cards
  // show "Follow" and gate to auth on tap. We load all follows and build a Set of
  // venue_ids; each card checks membership. One query for the whole grid.
  useEffect(() => {
    if (!session) {
      setFollowingSet(new Set());
      return;
    }
    let cancelled = false;
    const myFollows = trpc.social.myFollows as unknown as {
      query: () => Promise<{ ok: boolean; follows?: { venue_id: string }[] }>;
    };
    myFollows
      .query()
      .then((res) => {
        if (cancelled) return;
        const ids = res.ok ? (res.follows ?? []).map((f) => f.venue_id) : [];
        setFollowingSet(new Set(ids));
      })
      .catch(() => {
        if (!cancelled) setFollowingSet(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, session]);

  // Sub-category strip options: the distinct leaf types across the loaded set, in first-
  // seen order. Only meaningful in a category view; empty in the All view by design
  // (the All view's refinement is the top-level group pills themselves).
  const subCategories = useMemo(() => {
    if (!venues || activeCategory === null) return [];
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const v of venues) {
      for (const t of v.categories ?? []) {
        if (!seen.has(t)) {
          seen.add(t);
          ordered.push(t);
        }
      }
    }
    return ordered;
  }, [venues, activeCategory]);

  const shown = useMemo(() => {
    if (!venues) return [];
    const q = query.trim().toLowerCase();
    let list = activeSub === null ? venues : venues.filter((v) => (v.categories ?? []).includes(activeSub));
    if (q) list = list.filter((v) => v.name.toLowerCase().includes(q));
    return list;
  }, [venues, activeSub, query]);

  // The category chips, rendered twice by the responsive layout: vertical in the desktop
  // rail, horizontal in the mobile pill row. Same handlers + active state; only the chip
  // shape differs (full-width left-aligned vs auto). vStyle is applied only when vertical.
  const vStyle = { width: "100%", justifyContent: "flex-start" as const };
  const renderCategories = (vertical: boolean) => (
    <>
      <button
        onClick={() => loadAll()}
        style={{ all: "unset", cursor: "pointer", ...(vertical ? { width: "100%" } : {}) }}
      >
        <Pill variant={activeCategory === null ? "on" : "neutral"} {...(vertical ? { style: vStyle } : {})}>
          All
        </Pill>
      </button>
      {CATEGORY_GROUPS.map((c) => (
        <button
          key={c}
          onClick={() => loadCategory(c)}
          style={{ all: "unset", cursor: "pointer", ...(vertical ? { width: "100%" } : {}) }}
        >
          <Pill variant={activeCategory === c ? "on" : "neutral"} {...(vertical ? { style: vStyle } : {})}>
            {categoryLabel(c)}
          </Pill>
        </button>
      ))}
      {/* Marketplace seam — dormant (Stage 5), present in the IA so lighting it up needs no reshuffle. */}
      <span title="Marketplace is coming soon" style={{ cursor: "default", ...(vertical ? { width: "100%" } : {}) }}>
        <Pill
          variant="neutral"
          style={{ borderStyle: "dashed", color: "var(--faint)", ...(vertical ? vStyle : {}) }}
        >
          Market ◇
        </Pill>
      </span>
    </>
  );

  return (
    <main style={{ maxWidth: 1280, margin: "0 auto", padding: "var(--space-4) var(--space-4) var(--space-12)" }}>
      {/* place header — a live switcher + the Browse/Feed segment. (Brand, primary nav and
          sign-in live in the global TopBar now.) */}
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
        <div className={styles.browse}>
          {/* desktop categories rail (hidden on phones — there the pills sit inline) */}
          <aside className={styles.rail}>
            <span className={styles.railLabel}>Categories</span>
            {renderCategories(true)}
          </aside>

          {/* centre column: search · (mobile pills) · sub-categories · venue grid */}
          <div className={styles.center}>
            {/* search — filters the loaded set by name (client-side, place-scoped) */}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={`Search venues in ${place.name}…`}
              aria-label="Search venues"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px 16px",
                marginBottom: "var(--space-3)",
                background: "var(--paper-2)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-full)",
                fontFamily: "var(--ui)",
                fontSize: 13,
                color: "var(--ink)",
                outline: "none",
              }}
            />

            {/* category pills — phones only; on web the rail above carries them */}
            <div className={styles.mobilePills}>{renderCategories(false)}</div>

            {/* sub-category sliding strip — leaf types in the loaded category view */}
            {subCategories.length > 0 ? (
              <div
                style={{
                  display: "flex",
                  gap: "var(--space-2)",
                  overflowX: "auto",
                  paddingBottom: "var(--space-4)",
                  WebkitOverflowScrolling: "touch",
                }}
              >
                <button onClick={() => setActiveSub(null)} style={{ all: "unset", cursor: "pointer", flex: "0 0 auto" }}>
                  <Pill variant={activeSub === null ? "on" : "neutral"} size="sm">
                    All
                  </Pill>
                </button>
                {subCategories.map((t) => (
                  <button
                    key={t}
                    onClick={() => setActiveSub(t)}
                    style={{ all: "unset", cursor: "pointer", flex: "0 0 auto" }}
                  >
                    <Pill variant={activeSub === t ? "on" : "neutral"} size="sm">
                      {t.replace(/_/g, " ")}
                    </Pill>
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ paddingBottom: "var(--space-1)" }} />
            )}

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
                  gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                  gap: "var(--space-4)",
                }}
              >
                {shown.map((v) => (
                  <VenueCard key={v.id} venue={v} initialFollowing={followingSet.has(v.id)} />
                ))}
              </div>
            )}
          </div>

          {/* desktop live-map column. Placeholder until a map provider is chosen (build-plan
              open question #5); the column is reserved so adding the map needs no reflow. */}
          <aside className={styles.mapCol} aria-hidden>
            <div className={styles.mapTile}>
              <span className={styles.mapGlyph}>◍</span>
              <span className={styles.mapLabel}>Map view</span>
              <span className={styles.mapLabel} style={{ color: "var(--faint)" }}>
                coming soon
              </span>
            </div>
          </aside>
        </div>
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

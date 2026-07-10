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
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Seg, Pill, Icon, type IconName } from "@roam/design";
import { useTrpc, useSession } from "./TrpcProvider";
import { VenueCard, type VenueCardData } from "./VenueCard";
import { PlaceSwitcher, type Place } from "./PlaceSwitcher";
import { AuthPanel } from "./AuthPanel";
import { useCurrentPlace } from "../lib/currentPlace";
import { anonCanOpen, anonRecordOpen, ANON_SEARCH_LIMIT } from "../lib/anonDiscovery";
import { FeedList } from "./FeedList";
import { CATEGORY_GROUPS, useCategoryLabel } from "../lib/categories";
import { placeMapsUrl, detectMapsPlatform } from "../lib/directions";
import { VenueMap, type MapVenue } from "./VenueMap";
import { NearbyDepartures } from "./NearbyDepartures";
import styles from "./Explore.module.css";

type Mode = "browse" | "feed";

/**
 * A glyph per category chip (the improved-design rail is icon-led). Keyed by the CANONICAL
 * group name (what the API validates), same lockstep-by-contract as CATEGORY_LABELS —
 * a group with no entry just falls back to the place pin.
 */
const CATEGORY_ICONS: Record<string, IconName> = {
  "Food & Drink": "dining",
  Shopping: "bag",
  "Entertainment & Recreation": "star",
  "Automotive & Transport": "bus",
  "Finance & Business": "briefcase",
  "Health & Wellness": "person",
  Lodging: "hotel",
  "Education & Government": "landmark",
  "Places of Worship": "church",
};

/** Venues shown per page in the grid; "Load more" reveals the next page of this many. */
const PAGE_SIZE = 15;

// Demand-driven discovery threshold. venues.near has NO distance cap — it returns the nearest
// seeded venues globally, so a place far from any existing coverage still comes back with
// far-away rows. To decide whether THIS area needs supply, we count only rows that are
// genuinely near the centre (< NEARBY_RADIUS_M); if fewer than MIN_NEARBY are, we trigger a
// one-time area ingest (POST /api/ingest-area) and re-read. This is how Roam goes global
// without pre-seeding the planet: coverage is pulled the first time someone looks at a place.
const NEARBY_RADIUS_M = 30_000;
const MIN_NEARBY = 3;

/** Map an inCategoryNear / near row to the card shape, carrying leaf categories + cover/coords. */
function toCardData(v: {
  id: string;
  name: string;
  claimed: boolean;
  category: string | null;
  rating: number | null;
  ratingCount?: number | null | undefined;
  priceLevel?: string | null | undefined;
  primaryTypeLabel?: string | null | undefined;
  businessStatus?: string | null | undefined;
  distanceM?: number | undefined;
  categories?: string[] | undefined;
  coverPhotoId?: string | null | undefined;
  lat?: number | undefined;
  lng?: number | undefined;
}): VenueCardData {
  return {
    id: v.id,
    name: v.name,
    claimed: v.claimed,
    category: v.category,
    rating: v.rating,
    ratingCount: v.ratingCount,
    priceLevel: v.priceLevel,
    primaryTypeLabel: v.primaryTypeLabel,
    businessStatus: v.businessStatus,
    distanceM: v.distanceM,
    categories: v.categories,
    coverPhotoId: v.coverPhotoId,
    lat: v.lat,
    lng: v.lng,
  };
}

export function Explore() {
  const t = useTranslations("explore");
  const categoryLabel = useCategoryLabel();
  const trpc = useTrpc();
  const session = useSession();
  const [mode, setMode] = useState<Mode>("browse");
  // The active place is shared with Town Hall and persisted per-device (so it survives
  // navigation and reloads), not local to Explore. See useCurrentPlace.
  const { place, setPlace } = useCurrentPlace();
  const [venues, setVenues] = useState<VenueCardData[] | null>(null);
  // venue_ids the caller follows — read once per session, used to seed each card's
  // FollowButton so N cards don't each fetch. Empty when signed out (no follow state).
  const [followingSet, setFollowingSet] = useState<Set<string>>(new Set());
  // Phones: the venue map is collapsed by default so the venue cards are the first thing you
  // see (an always-on 220px map pushed them below the fold). A toggle reveals it on demand.
  const [showMobileMap, setShowMobileMap] = useState(false);
  // null = the "All" view (venues.near). A group name = a category view (ingest + read).
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  // The selected leaf type within a category view, or null for "all sub-categories".
  const [activeSub, setActiveSub] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // True while the "All" load is pulling fresh supply for a never-before-seen area (the
  // /api/ingest-area hop) — drives a "Discovering places…" state instead of a bare skeleton.
  const [discovering, setDiscovering] = useState(false);
  // True when an anonymous visitor has exhausted their free searched-location allowance and
  // must create an account to open this place. Signed-in users are never gated; the user's own
  // current location and suggested/saved/default centres are always free (see anonDiscovery).
  const [gated, setGated] = useState(false);
  // Free-text filter over the loaded set (client-side, by name). Sign-in now lives in the
  // global TopBar, so Explore's header is just the place switcher + Browse/Feed segment.
  const [query, setQuery] = useState("");
  // Server name-search fall-through: when the loaded set has no match for the typed name, we ask
  // the server (DB-first, then Google Places text search) so a venue Roam hasn't ingested yet can
  // still be found. Cached by the exact query so re-typing the same thing doesn't re-search.
  const [webResults, setWebResults] = useState<{ q: string; venues: VenueCardData[] } | null>(null);
  const [webSearching, setWebSearching] = useState(false);
  const webSearchGen = useRef(0);
  // How many venues the grid currently reveals (paged in PAGE_SIZE steps via "Load more").
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

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
    setDiscovering(false);

    void (async () => {
      try {
        let rows = await trpc.venues.near.query({ lat: place.lat, lng: place.lng, limit: 50 });
        if (loadGen.current !== gen) return;

        // Distance-aware sparseness: only rows genuinely near the centre count as coverage
        // (venues.near returns nearest-globally, so far-away seeds must not mask an empty area).
        const nearby = rows.filter(
          (r) => typeof r.distanceM === "number" && r.distanceM < NEARBY_RADIUS_M,
        );
        if (nearby.length < MIN_NEARBY) {
          // Demand-driven supply: pull the starter categories for this point, then re-read.
          // Non-fatal — if discovery fails or is gated server-side, we render what already exists.
          setDiscovering(true);
          try {
            await fetch("/api/ingest-area", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ lat: place.lat, lng: place.lng }),
            });
          } catch (e) {
            console.warn("[Explore] area discovery failed", e);
          }
          if (loadGen.current !== gen) return;
          try {
            rows = await trpc.venues.near.query({ lat: place.lat, lng: place.lng, limit: 50 });
          } catch {
            /* keep the first read's rows */
          }
          if (loadGen.current !== gen) return;
        }

        setDiscovering(false);
        setVenues(rows.map(toCardData));
      } catch (e: unknown) {
        if (loadGen.current !== gen) return;
        setDiscovering(false);
        setError(e instanceof Error ? e.message : t("errors.loadFailed"));
      }
    })();
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
            // Load a deep set; the grid pages through it client-side in PAGE_SIZE steps.
            pageSize: 50,
            pageOffset: 0,
          });
          if (loadGen.current !== gen) return;
          setVenues(result.venues.map(toCardData));
        } catch (e: unknown) {
          if (loadGen.current !== gen) return;
          setError(e instanceof Error ? e.message : t("errors.loadFailed"));
        }
      })();
    },
    [trpc, place],
  );

  // Mount + place change → the All load, behind the anonymous discovery meter. A signed-in
  // user is never gated. An anonymous one may always open their current location and the
  // suggested/saved/default centres; SEARCHED places are metered to ANON_SEARCH_LIMIT per
  // session. When the allowance is spent, we gate (showing the sign-up surface) instead of
  // loading; otherwise we record the open (idempotent) and load. Re-runs when session flips
  // (e.g. signing up through the gate), which clears the gate and loads.
  useEffect(() => {
    const allowed = !!session || anonCanOpen(place);
    setGated(!allowed);
    if (!allowed) return;
    if (!session && place.source === "search") anonRecordOpen(place);
    loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [place, session]);

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

  // Local matches over the already-loaded set (instant, client-side by name).
  const localMatches = useMemo(() => {
    if (!venues) return [];
    const q = query.trim().toLowerCase();
    let list = activeSub === null ? venues : venues.filter((v) => (v.categories ?? []).includes(activeSub));
    if (q) list = list.filter((v) => v.name.toLowerCase().includes(q));
    return list;
  }, [venues, activeSub, query]);

  // When the local set has nothing for a typed name, we fall through to a server name search that
  // also asks Google for venues Roam hasn't ingested yet (see the debounced effect below).
  const shown = useMemo(() => {
    if (localMatches.length > 0) return localMatches;
    const q = query.trim();
    if (q && webResults && webResults.q === q) return webResults.venues;
    return [];
  }, [localMatches, query, webResults]);

  // Debounced server name search. Fires only when the loaded set has NO local match for a typed
  // name (≥3 chars) — so a venue Roam already shows never triggers a call — and never re-searches
  // the same query. The server is DB-first + budget-capped, so this stays cheap. A generation id
  // discards a stale response if the query changed while it was in flight.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3 || localMatches.length > 0) {
      setWebSearching(false);
      return;
    }
    if (webResults && webResults.q === q) return; // already have this result
    const gen = ++webSearchGen.current;
    const timer = setTimeout(async () => {
      setWebSearching(true);
      try {
        const res = await fetch("/api/ingest-search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, lat: place.lat, lng: place.lng }),
        });
        const data = res.ok ? ((await res.json()) as { venues?: VenueCardData[] }) : { venues: [] };
        if (gen === webSearchGen.current) setWebResults({ q, venues: data.venues ?? [] });
      } catch {
        if (gen === webSearchGen.current) setWebResults({ q, venues: [] });
      } finally {
        if (gen === webSearchGen.current) setWebSearching(false);
      }
    }, 650);
    return () => clearTimeout(timer);
  }, [query, localMatches.length, place.lat, place.lng, webResults]);

  // Reset to the first page whenever the underlying set changes (a new load, category,
  // place, sub-filter, or search) so "Load more" always starts from page 1.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [venues, activeSub, query]);

  // The current page of cards (PAGE_SIZE at a time).
  const visible = useMemo(() => shown.slice(0, visibleCount), [shown, visibleCount]);

  // Resolve the visible page's cover photos in ONE batch call, keyed by venue id, so each
  // card paints the real image on first render instead of doing its own round-trip and
  // flashing the default first. We only request photo ids we haven't asked for yet (tracked
  // in a ref so growing the page / re-renders never re-fetch), and a failure just leaves the
  // card on its default cover. The server reuses its cached google urls across these.
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const requestedCoverIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const wanted = visible.filter(
      (v) => v.coverPhotoId && !requestedCoverIds.current.has(v.coverPhotoId),
    );
    if (wanted.length === 0) return;
    const photoIds = Array.from(new Set(wanted.map((v) => v.coverPhotoId as string)));
    photoIds.forEach((id) => requestedCoverIds.current.add(id));
    let cancelled = false;
    const resolve = trpc.venues.photoMediaUrls as unknown as {
      query: (input: { photoIds: string[] }) => Promise<{ urls: Record<string, string> }>;
    };
    resolve
      .query({ photoIds })
      .then((r) => {
        if (cancelled || !r?.urls) return;
        setCoverUrls((prev) => {
          const next = { ...prev };
          for (const v of wanted) {
            const u = v.coverPhotoId ? r.urls[v.coverPhotoId] : undefined;
            if (u) next[v.id] = u;
          }
          return next;
        });
      })
      .catch(() => {
        /* leave these cards on the default cover */
      });
    return () => {
      cancelled = true;
    };
  }, [visible, trpc]);

  // Map pins: the whole loaded set (not just the visible page), so the map gives the full
  // local overview while the grid pages. Empty until the API returns lat/lng (migration 0025).
  const mapVenues = useMemo<MapVenue[]>(
    () =>
      shown
        .filter((v): v is typeof v & { lat: number; lng: number } => typeof v.lat === "number" && typeof v.lng === "number")
        .map((v) => ({ id: v.id, name: v.name, lat: v.lat, lng: v.lng, claimed: v.claimed })),
    [shown],
  );

  // The category chips, rendered twice by the responsive layout: full-width icon rows in
  // the desktop rail, a sliding icon-pill row on phones. One component (.catBtn); the rail
  // media query reshapes it, so both share the handlers and the crimson-filled active state.
  const categoryChips = (
    <>
      <button
        onClick={() => loadAll()}
        className={`${styles.catBtn} ${activeCategory === null ? styles.catActive : ""}`}
        aria-pressed={activeCategory === null}
      >
        <Icon name="widgets" size={16} /> {t("all")}
      </button>
      {CATEGORY_GROUPS.map((c) => (
        <button
          key={c}
          onClick={() => loadCategory(c)}
          className={`${styles.catBtn} ${activeCategory === c ? styles.catActive : ""}`}
          aria-pressed={activeCategory === c}
        >
          <Icon name={CATEGORY_ICONS[c] ?? "place"} size={16} /> {categoryLabel(c)}
        </button>
      ))}
      {/* The Market — the once-dormant seam, now a live surface of its own. */}
      <Link href="/market" className={styles.catBtn} style={{ textDecoration: "none" }}>
        <Icon name="shop" size={16} /> {t("market")}
      </Link>
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
            { value: "browse", label: t("browse") },
            { value: "feed", label: t("feed") },
          ]}
          value={mode}
          onChange={(v) => setMode(v as Mode)}
        />
      </header>

      {mode === "feed" ? (
        <FeedList placeName={place.name} lat={place.lat} lng={place.lng} />
      ) : gated ? (
        <SignupGate place={place} onAuthed={() => { setGated(false); loadAll(); }} />
      ) : (
        <div className={styles.browse}>
          {/* desktop categories rail (hidden on phones — there the pills sit inline) */}
          <aside className={styles.rail}>
            <span className={styles.railLabel}>{t("categoriesLabel")}</span>
            {categoryChips}
          </aside>

          {/* centre column: search · (mobile pills) · sub-categories · venue grid */}
          <div className={styles.center}>
            {/* search — filters the loaded set by name (client-side, place-scoped) */}
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder", { placeName: place.name })}
              aria-label={t("searchAria")}
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px 16px",
                marginBottom: "var(--space-3)",
                background: "var(--paper-2)",
                border: "1px solid var(--line)",
                borderRadius: "var(--r-full)",
                fontFamily: "var(--ui)",
                // 16px (not 13): iOS Safari zooms the page when a focused input's font is
                // < 16px. This is the search field's only job on mobile, so keep it zoom-free.
                fontSize: 16,
                color: "var(--ink)",
                outline: "none",
              }}
            />

            {/* category chips — phones only; on web the rail above carries them */}
            <div className={styles.mobilePills}>{categoryChips}</div>

            {/* NI live transit — self-hiding outside Northern Ireland / when unconfigured */}
            <NearbyDepartures lat={place.lat} lng={place.lng} placeName={place.name} />

            {/* phones only: the map is collapsed behind a toggle so venue cards lead; the
                desktop map column carries the same map always-on on web. */}
            <div className={styles.mobileMap}>
              <button
                onClick={() => setShowMobileMap((v) => !v)}
                aria-expanded={showMobileMap}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  minHeight: 40,
                  padding: "8px 14px",
                  borderRadius: "var(--r-full)",
                  border: "1px solid var(--line)",
                  background: "var(--paper-2)",
                  fontFamily: "var(--ui)",
                  fontSize: 13,
                  fontWeight: 600,
                  color: "var(--ink-2)",
                }}
              >
                <Icon name="place" size={16} style={{ color: "var(--crimson-700)" }} />
                {showMobileMap ? t("hideMap") : t("showMap")}
              </button>
              {showMobileMap ? (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <VenueMap venues={mapVenues} center={place} className={styles.mobileMapEmbed} />
                  <div style={{ marginTop: "var(--space-2)" }}>
                    <OpenInMaps place={place} variant="pill" />
                  </div>
                </div>
              ) : null}
            </div>

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
                  <Pill variant={activeSub === null ? "crim" : "neutral"} size="sm">
                    {t("all")}
                  </Pill>
                </button>
                {subCategories.map((t) => (
                  <button
                    key={t}
                    onClick={() => setActiveSub(t)}
                    style={{ all: "unset", cursor: "pointer", flex: "0 0 auto" }}
                  >
                    <Pill variant={activeSub === t ? "crim" : "neutral"} size="sm">
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
              discovering ? <DiscoveringState placeName={place.name} /> : <VenueGridSkeleton />
            ) : shown.length === 0 ? (
              webSearching ? <SearchingWebState query={query.trim()} /> : <EmptyState searched={query.trim().length >= 3} />
            ) : (
              <>
                <div className={styles.grid}>
                  {visible.map((v) => (
                    <VenueCard
                      key={v.id}
                      venue={v}
                      initialFollowing={followingSet.has(v.id)}
                      coverUrl={coverUrls[v.id]}
                    />
                  ))}
                </div>

                {/* Load more — reveals the next PAGE_SIZE of the loaded set. */}
                {visibleCount < shown.length ? (
                  <div style={{ display: "flex", justifyContent: "center", marginTop: "var(--space-6)" }}>
                    <button
                      onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                      style={{ all: "unset", cursor: "pointer" }}
                    >
                      <Pill variant="neutral">
                        {t("loadMore", { count: shown.length - visibleCount })}
                      </Pill>
                    </button>
                  </div>
                ) : null}
              </>
            )}
          </div>

          {/* desktop map column — a live Leaflet/OSM map (no provider key) with a pin per
              venue; a floating bar along its bottom edge carries the in-view count and the
              hand-off to the device's default maps app. */}
          <aside className={styles.mapCol}>
            <div className={styles.mapPanel}>
              <VenueMap venues={mapVenues} center={place} className={styles.mapEmbed} />
              <div className={styles.mapBar}>
                <span className={styles.mapCount}>
                  {t("venuesInView", { count: mapVenues.length })}
                </span>
                <OpenInMaps place={place} variant="bar" />
              </div>
            </div>
          </aside>
        </div>
      )}

    </main>
  );
}

/**
 * OpenInMaps — the "open this area in your maps app" hand-off. Roam deliberately doesn't
 * embed a map provider (no SDK, no key, no cost); it centres the device's DEFAULT maps app
 * on the current place. Renders as the map panel's bar button or a mobile pill. Platform is
 * client-only, so we render the web URL first and swap to the device-specific one on mount.
 */
function OpenInMaps({ place, variant }: { place: Place; variant: "bar" | "pill" }) {
  const t = useTranslations("explore");
  const [href, setHref] = useState(() => placeMapsUrl(place.lat, place.lng, place.name, "web"));
  useEffect(() => {
    const platform = detectMapsPlatform(
      navigator.userAgent,
      navigator.maxTouchPoints,
      navigator.platform,
    );
    setHref(placeMapsUrl(place.lat, place.lng, place.name, platform));
  }, [place]);

  // geo: must navigate in place (the OS intercepts); https opens a new tab so Roam stays open.
  const external = href.startsWith("http");
  const anchorProps = external ? { target: "_blank", rel: "noopener noreferrer" as const } : {};

  if (variant === "bar") {
    // The map panel's floating bar action — a quiet bordered pill on the translucent bar.
    return (
      <a href={href} {...anchorProps} style={{ textDecoration: "none", flexShrink: 0 }}>
        <Pill variant="neutral">{t("openInMaps")}</Pill>
      </a>
    );
  }
  return (
    <a href={href} {...anchorProps} style={{ textDecoration: "none" }}>
      <Pill variant="ghost-crim" size="sm">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><Icon name="place" size={14} /> {t("openPlaceInMaps", { placeName: place.name })}</span>
      </Pill>
    </a>
  );
}

/**
 * SignupGate — shown when an anonymous visitor has spent their free searched-location
 * allowance for the session. Their current location and the suggested/saved/default centres
 * stay free; this only blocks opening a NEW searched place. The AuthPanel signs them in or
 * starts a sign-up; on a live session the place loads (the gate clears via onAuthed and the
 * place effect re-runs).
 */
function SignupGate({ place, onAuthed }: { place: Place; onAuthed: () => void }) {
  const t = useTranslations("explore");
  const redirectTo = typeof window !== "undefined" ? window.location.href : "";
  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "var(--space-8) var(--space-4)" }}>
      <div style={{ textAlign: "center" }}>
        <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
          {t("gate.title")}
        </div>
        <p style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>
          {t.rich("gate.body", {
            limit: ANON_SEARCH_LIMIT,
            placeName: place.name,
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </p>
      </div>
      <AuthPanel emailRedirectTo={redirectTo} onAuthed={onAuthed} />
    </div>
  );
}

/**
 * DiscoveringState — the "we're pulling this area in for the first time" state. Shown while
 * /api/ingest-area fills supply for a never-before-seen place, ahead of the re-read. A
 * content-shaped skeleton sits below the line so the load reads as real, not a spinner.
 */
function DiscoveringState({ placeName }: { placeName: string }) {
  const t = useTranslations("explore");
  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "var(--space-3) 0 var(--space-4)",
          color: "var(--ink-2)",
          fontFamily: "var(--ui)",
          fontSize: 14,
        }}
      >
        <Icon name="place" size={16} style={{ color: "var(--crimson-700)" }} />
        {t("discovering", { placeName })}
      </div>
      <VenueGridSkeleton />
    </div>
  );
}

function VenueGridSkeleton() {
  return (
    <div className={styles.grid}>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            borderRadius: 20,
            border: "1px solid var(--line)",
            overflow: "hidden",
            background: "var(--card)",
          }}
        >
          <div style={{ height: 168, background: "var(--paper-2)" }} />
          <div style={{ padding: "var(--space-3) var(--space-4)", display: "grid", gap: "var(--space-2)" }}>
            <div style={{ height: 16, width: "70%", background: "var(--paper-2)", borderRadius: 6 }} />
            <div style={{ height: 12, width: "45%", background: "var(--paper-2)", borderRadius: 6 }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ searched }: { searched?: boolean }) {
  const t = useTranslations("explore");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", color: "var(--ink-2)" }}>
      <div className="t-h2" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        {searched ? t("empty.searchTitle") : t("empty.title")}
      </div>
      <p style={{ color: "var(--muted)", maxWidth: 360, margin: "0 auto" }}>
        {searched ? t("empty.searchBody") : t("empty.body")}
      </p>
    </div>
  );
}

/** Shown while the server name search (DB + Google) is running for a query with no local match. */
function SearchingWebState({ query }: { query: string }) {
  const t = useTranslations("explore");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)", color: "var(--ink-2)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        {t("searchingWeb", { query })}
      </div>
      <p style={{ color: "var(--muted)", maxWidth: 360, margin: "0 auto" }}>{t("searchingWebBody")}</p>
    </div>
  );
}

function ErrorState({ message }: { message: string }) {
  const t = useTranslations("explore");
  return (
    <div style={{ textAlign: "center", padding: "var(--space-12) var(--space-4)" }}>
      <div className="t-h3" style={{ fontFamily: "var(--display)", marginBottom: "var(--space-2)" }}>
        {t("errors.title")}
      </div>
      <p style={{ color: "var(--muted)" }}>{message}</p>
    </div>
  );
}

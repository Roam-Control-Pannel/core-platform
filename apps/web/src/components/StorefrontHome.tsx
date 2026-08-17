/**
 * StorefrontHome — the NI Food to Go Association storefront home (shown on the f2g channel instead
 * of the Roam home). Co-branded: a white hero with the red "order ahead · collect" kicker, the
 * no-commission promise, and a search; category chips; a nearest/fastest/top-rated sort; and the
 * vendor grid from venues.inChannelNear (with each vendor's real prep time).
 *
 * Category filtering is best-effort off the vendor's Google category/type label until a bespoke
 * F2G taxonomy exists. Sort + search are fully wired from the data we have.
 */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useTrpc } from "./TrpcProvider";
import { useStorefrontPlace } from "../lib/storefrontPlace";
import { NI_PLACES, NI_REGION } from "../lib/ni";
import { PlaceSwitcher } from "./PlaceSwitcher";
import { F2GVendorCard, type F2GVendor } from "./F2GVendorCard";
import {
  STOREFRONT,
  STOREFRONT_CATEGORIES,
  STOREFRONT_SORTS,
  type StorefrontCategory,
  type StorefrontSort,
} from "../lib/storefront";

// Vendors per page. Category + sort operate over everything LOADED, so "Load more" grows the pool
// the filters see — a town's full supply, not just the nearest page (the RPC paginates via hasMore).
const PAGE_SIZE = 24;

/** Best-effort match of a vendor's Google label to a storefront category. */
function matchesCategory(v: F2GVendor, cat: StorefrontCategory): boolean {
  if (cat === "all") return true;
  const hay = `${v.primaryTypeLabel ?? ""} ${v.category ?? ""}`.toLowerCase();
  const needles: Record<Exclude<StorefrontCategory, "all">, string[]> = {
    coffee: ["coffee", "café", "cafe", "espresso"],
    bakery: ["bakery", "bakehouse", "patisserie", "bread"],
    hot_food: ["takeaway", "fast food", "chippy", "chip", "kebab", "burger", "pizza", "indian", "chinese", "curry", "hot food"],
    breakfast: ["breakfast", "brunch", "deli"],
  };
  return needles[cat].some((n) => hay.includes(n));
}

function sortVendors(list: F2GVendor[], sort: StorefrontSort): F2GVendor[] {
  const copy = [...list];
  if (sort === "fastest") copy.sort((a, b) => (a.prepMins ?? 15) - (b.prepMins ?? 15));
  else if (sort === "nearest") copy.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));
  else copy.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
  return copy;
}

export function StorefrontHome() {
  const t = useTranslations("storefront");
  const trpc = useTrpc();
  const { place, setPlace } = useStorefrontPlace();
  const [vendors, setVendors] = useState<F2GVendor[] | null>(null);
  const [mode, setMode] = useState<"open" | "members">("open");
  const [discovering, setDiscovering] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [cat, setCat] = useState<StorefrontCategory>("all");
  const [sort, setSort] = useState<StorefrontSort>("fastest");
  const [deliversOnly, setDeliversOnly] = useState(false);
  const [query, setQuery] = useState("");
  // NI town cells (~1km) we've already asked to discover, so we trigger the paid ingest once each.
  const attemptedIngest = useRef<Set<string>>(new Set());
  // Bumped on every place change so an in-flight "load more" for the previous place is discarded
  // instead of appending stale vendors to the new town.
  const loadSeq = useRef(0);
  // Cover images, resolved for the whole grid in ONE batch call (venues.photoMediaUrls) rather than
  // one round-trip per card — keyed by venue id, guarded by a ref so re-renders never re-fetch.
  const [coverUrls, setCoverUrls] = useState<Record<string, string>>({});
  const requestedCoverIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    loadSeq.current++; // invalidate any in-flight "load more" from the previous place
    setVendors(null);
    setDiscovering(false);
    setHasMore(false);
    setNextOffset(0);
    const cell = `${place.lat.toFixed(2)},${place.lng.toFixed(2)}`;

    async function load() {
      const args = { channelKey: "f2g", lat: place.lat, lng: place.lng, pageSize: PAGE_SIZE, pageOffset: 0 } as const;
      try {
        let r = await trpc.venues.storefrontNear.query(args);
        if (cancelled) return;
        setMode(r.mode);

        // Open mode + nothing here yet + not tried before → discover this NI town on demand (the
        // existing budget-guarded Places pull), then re-read once. Members mode never auto-ingests:
        // its supply is opt-in, so an empty area is simply "no members yet".
        if (r.mode === "open" && r.venues.length === 0 && !attemptedIngest.current.has(cell)) {
          attemptedIngest.current.add(cell);
          setDiscovering(true);
          try {
            // Food-to-go-specific supply: asks Google for cafés/bakeries/fast-food directly, so a
            // town whose coarse "Food & Drink" is already covered by pubs still gets real supply.
            await fetch("/api/ingest-food-to-go", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ lat: place.lat, lng: place.lng }),
            });
          } catch {
            /* best-effort — supply may be gated by budget; we just re-read what exists */
          }
          if (cancelled) return;
          r = await trpc.venues.storefrontNear.query(args);
          if (cancelled) return;
          setDiscovering(false);
        }

        setVendors(r.venues as F2GVendor[]);
        setHasMore(r.hasMore);
        setNextOffset(r.nextOffset);
      } catch {
        if (!cancelled) {
          setDiscovering(false);
          setVendors([]);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [trpc, place.lat, place.lng]);

  // "Load more": fetch the next page and APPEND, so category/sort see the town's full supply, not
  // just the nearest page. Guarded by loadSeq so a page arriving after the user switched towns is
  // dropped rather than appended to the wrong place.
  const loadMore = useCallback(async () => {
    const seq = loadSeq.current;
    setLoadingMore(true);
    try {
      const r = await trpc.venues.storefrontNear.query({
        channelKey: "f2g",
        lat: place.lat,
        lng: place.lng,
        pageSize: PAGE_SIZE,
        pageOffset: nextOffset,
      });
      if (seq !== loadSeq.current) return; // place changed mid-flight — discard
      setVendors((prev) => [...(prev ?? []), ...(r.venues as F2GVendor[])]);
      setHasMore(r.hasMore);
      setNextOffset(r.nextOffset);
    } catch {
      /* leave the grid as-is; the button stays for a retry */
    } finally {
      if (seq === loadSeq.current) setLoadingMore(false);
    }
  }, [trpc, place.lat, place.lng, nextOffset]);

  // Resolve every loaded vendor's cover in one batch (≤40 ids, under the procedure's cap of 60), so
  // the grid paints real covers in a single round-trip. Keyed by venue id; the ref guards re-fetch.
  useEffect(() => {
    if (!vendors) return;
    const wanted = vendors.filter(
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
        /* leave these cards on the illustrated default cover */
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, vendors]);

  const shown = useMemo(() => {
    if (!vendors) return [];
    const q = query.trim().toLowerCase();
    const filtered = vendors.filter(
      (v) =>
        matchesCategory(v, cat) &&
        (!deliversOnly || v.delivers === true) &&
        (!q || v.name.toLowerCase().includes(q) || (v.primaryTypeLabel ?? v.category ?? "").toLowerCase().includes(q)),
    );
    return sortVendors(filtered, sort);
  }, [vendors, cat, sort, deliversOnly, query]);

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "0 20px 64px" }}>
      {/* Hero */}
      <section style={{ padding: "36px 0 24px", maxWidth: 640 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".12em", textTransform: "uppercase", color: "var(--crimson)", fontWeight: 700 }}>
          {t("hero.kicker")}
        </div>
        <h1 style={{ fontFamily: "var(--display)", fontWeight: 800, fontSize: 40, lineHeight: 1.03, letterSpacing: "-.02em", margin: "10px 0 0", color: STOREFRONT.navy, textTransform: "uppercase" }}>
          {t("hero.title", { place: place.name })}
        </h1>
        <p style={{ margin: "14px 0 0", fontSize: 15.5, lineHeight: 1.5, color: "var(--ink-2)" }}>{t("hero.body")}</p>

        <div style={{ marginTop: 18, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("hero.searchPlaceholder")}
            aria-label={t("hero.searchPlaceholder")}
            style={{ flex: "1 1 260px", minWidth: 0, boxSizing: "border-box", padding: "12px 14px", fontSize: 14.5, border: "1px solid var(--line-2)", borderRadius: 12, outline: "none", background: "var(--card)", color: "var(--ink)" }}
          />
          <PlaceSwitcher value={place} onChange={setPlace} suggested={NI_PLACES} region={NI_REGION} />
        </div>
      </section>

      {/* Category chips */}
      <div id="categories" style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "8px 0 16px", borderTop: "1px solid var(--line)", borderBottom: "1px solid var(--line)" }}>
        {STOREFRONT_CATEGORIES.map((c) => {
          const on = c === cat;
          return (
            <button
              key={c}
              type="button"
              onClick={() => setCat(c)}
              style={{
                all: "unset",
                cursor: "pointer",
                padding: "8px 14px",
                borderRadius: 10,
                fontSize: 13.5,
                fontWeight: 700,
                border: `1px solid ${on ? STOREFRONT.navy : "var(--line-2)"}`,
                background: on ? STOREFRONT.navy : "transparent",
                color: on ? STOREFRONT.onNavy : "var(--ink-2)",
              }}
            >
              {t(`categories.${c}`)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setDeliversOnly((v) => !v)}
          aria-pressed={deliversOnly}
          style={{
            all: "unset",
            cursor: "pointer",
            padding: "8px 14px",
            borderRadius: 10,
            fontSize: 13.5,
            fontWeight: 700,
            marginLeft: "auto",
            border: `1px solid ${deliversOnly ? STOREFRONT.navy : "var(--line-2)"}`,
            background: deliversOnly ? STOREFRONT.navy : "transparent",
            color: deliversOnly ? STOREFRONT.onNavy : "var(--ink-2)",
          }}
        >
          {t("deliversFilter")}
        </button>
      </div>

      {/* Count + sort */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "16px 0", flexWrap: "wrap" }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: ".05em", textTransform: "uppercase", color: "var(--ink-2)", fontWeight: 700 }}>
          {vendors === null ? " " : t("placesCount", { count: shown.length })}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          {STOREFRONT_SORTS.map((s) => {
            const on = s === sort;
            return (
              <button
                key={s}
                type="button"
                onClick={() => setSort(s)}
                style={{ all: "unset", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 11, letterSpacing: ".05em", textTransform: "uppercase", fontWeight: 700, color: on ? "var(--ink)" : "var(--muted)", borderBottom: `2px solid ${on ? STOREFRONT.yellow : "transparent"}`, paddingBottom: 2 }}
              >
                {t(`sorts.${s}`)}
              </button>
            );
          })}
        </div>
      </div>

      {/* Discovering a fresh NI town (open mode, on-demand ingest in flight). */}
      {discovering ? (
        <div style={{ fontFamily: "var(--mono)", fontSize: 12, letterSpacing: ".04em", color: "var(--muted)", padding: "0 0 12px" }}>
          {t("discovering", { place: place.name })}
        </div>
      ) : null}

      {/* Grid */}
      {vendors === null ? (
        <Grid>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} style={{ borderRadius: 14, height: 210, background: "var(--paper-2)" }} aria-hidden />
          ))}
        </Grid>
      ) : shown.length === 0 ? (
        <div style={{ textAlign: "center", padding: "56px 16px", maxWidth: 420, margin: "0 auto" }}>
          <div style={{ fontSize: 40, marginBottom: 8 }} aria-hidden>🥡</div>
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 700, marginBottom: 6, color: STOREFRONT.navy }}>
            {t(mode === "members" ? "empty.membersTitle" : "empty.title", { place: place.name })}
          </div>
          <p style={{ color: "var(--muted)", lineHeight: 1.55, fontSize: 14 }}>
            {t(mode === "members" ? "empty.membersBody" : "empty.body")}
          </p>
        </div>
      ) : (
        <Grid>
          {shown.map((v) => (
            <F2GVendorCard key={v.id} vendor={v} coverUrl={coverUrls[v.id]} />
          ))}
        </Grid>
      )}

      {/* Load more — grows the pool category + sort see, so they cover the town, not just page 1. */}
      {vendors !== null && hasMore ? (
        <div style={{ display: "flex", justifyContent: "center", padding: "28px 0 0" }}>
          <button
            type="button"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            style={{
              all: "unset",
              cursor: loadingMore ? "default" : "pointer",
              padding: "11px 22px",
              borderRadius: 10,
              border: `1px solid ${STOREFRONT.navy}`,
              color: STOREFRONT.navy,
              fontFamily: "var(--mono)",
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: ".05em",
              textTransform: "uppercase",
              opacity: loadingMore ? 0.6 : 1,
            }}
          >
            {loadingMore ? t("loadingMore") : t("loadMore")}
          </button>
        </div>
      ) : null}

      {/* Co-brand footer */}
      <p style={{ marginTop: 40, paddingTop: 20, borderTop: "1px solid var(--line)", fontSize: 12.5, color: "var(--muted)", lineHeight: 1.5 }}>
        {t("coBrandFooter")}
      </p>
    </main>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(230px, 1fr))", gap: 18 }}>
      {children}
    </div>
  );
}

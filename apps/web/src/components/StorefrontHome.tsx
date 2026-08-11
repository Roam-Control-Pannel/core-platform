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

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useTrpc } from "./TrpcProvider";
import { useCurrentPlace } from "../lib/currentPlace";
import { PlaceSwitcher } from "./PlaceSwitcher";
import { F2GVendorCard, type F2GVendor } from "./F2GVendorCard";
import {
  STOREFRONT,
  STOREFRONT_CATEGORIES,
  STOREFRONT_SORTS,
  type StorefrontCategory,
  type StorefrontSort,
} from "../lib/storefront";

/** Best-effort match of a vendor's Google label to a storefront category. */
function matchesCategory(v: F2GVendor, cat: StorefrontCategory): boolean {
  if (cat === "all") return true;
  const hay = `${v.primaryTypeLabel ?? ""} ${v.category ?? ""}`.toLowerCase();
  const needles: Record<Exclude<StorefrontCategory, "all">, string[]> = {
    coffee: ["coffee", "café", "cafe", "espresso"],
    bakery: ["bakery", "bakehouse", "patisserie", "bread"],
    hot_food: ["takeaway", "fast food", "chippy", "chip", "kebab", "burger", "pizza", "indian", "chinese", "curry", "hot food"],
    breakfast: ["breakfast", "brunch", "deli"],
    forecourt: ["forecourt", "petrol", "service station", "convenience", "garage"],
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
  const { place, setPlace } = useCurrentPlace();
  const [vendors, setVendors] = useState<F2GVendor[] | null>(null);
  const [cat, setCat] = useState<StorefrontCategory>("all");
  const [sort, setSort] = useState<StorefrontSort>("fastest");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setVendors(null);
    trpc.venues.inChannelNear
      .query({ channelKey: "f2g", lat: place.lat, lng: place.lng, pageSize: 40 })
      .then((r) => {
        if (!cancelled) setVendors(r.venues as F2GVendor[]);
      })
      .catch(() => {
        if (!cancelled) setVendors([]);
      });
    return () => {
      cancelled = true;
    };
  }, [trpc, place.lat, place.lng]);

  const shown = useMemo(() => {
    if (!vendors) return [];
    const q = query.trim().toLowerCase();
    const filtered = vendors.filter(
      (v) =>
        matchesCategory(v, cat) &&
        (!q || v.name.toLowerCase().includes(q) || (v.primaryTypeLabel ?? v.category ?? "").toLowerCase().includes(q)),
    );
    return sortVendors(filtered, sort);
  }, [vendors, cat, sort, query]);

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
          <PlaceSwitcher value={place} onChange={setPlace} />
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
          <div className="t-h3" style={{ fontFamily: "var(--display)", fontWeight: 700, marginBottom: 6, color: STOREFRONT.navy }}>{t("empty.title")}</div>
          <p style={{ color: "var(--muted)", lineHeight: 1.55, fontSize: 14 }}>{t("empty.body")}</p>
        </div>
      ) : (
        <Grid>
          {shown.map((v) => (
            <F2GVendorCard key={v.id} vendor={v} />
          ))}
        </Grid>
      )}

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

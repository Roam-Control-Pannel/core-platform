/**
 * Markets — the registry of COUNTRIES Roam operates in, and the single source of truth for
 * per-country scoping (currency, measurement units, a fallback bounding box, a default browse
 * centre, and whether the market is fully live or still self-seeding).
 *
 * WHY THIS EXISTS: the platform was built "global from day one" (venues carry lat/lng + an unused
 * country_code), but nothing ever branched on the visitor's country — a US visitor saw UK defaults
 * and UK-only affiliate deals. This module makes "which market is this?" a first-class, typed
 * lookup so every surface can scope to the visitor's own country and seed empty ones.
 *
 * SCOPE vs the NI fence: this is COUNTRY-level (GB, US, …). The Northern Ireland box in
 * ../geocode (NI_BOUNDS / isNorthernIreland) is a *sub*-fence WITHIN GB for the Food to Go
 * storefront — a different concern, deliberately left where it is.
 *
 * SINGLE SOURCE OF TRUTH: this registry is authoritative and framework-agnostic. Shells (web) do
 * NOT import @roam/core directly (a deliberate boundary — see apps/web/src/lib/ni.ts); they read
 * the resolved market for a visitor through the api tRPC layer (geo router), so there is no mirror
 * of this data to drift. Country bounds are only a *fallback* classifier: the visitor's country
 * normally arrives as an ISO code from the host edge headers (/api/geo), and a venue's country is
 * derived from its address at ingest — bounds are used only when we have coordinates but no code.
 */
import { inBounds, type GeoBounds } from "../geocode/index.js";

/** Measurement system for distances/quantities in a market. Wired to display in a later phase. */
export type UnitSystem = "metric" | "imperial";

/**
 * Operational status of a market:
 *  - "live": fully operational — real seeded supply, the standard experience.
 *  - "seeding": open but effectively empty — visitors are the first contributors (pioneer journey),
 *    supply self-seeds on demand. Everything works; there is just little there yet.
 */
export type MarketStatus = "live" | "seeding";

/** A sensible central place to centre browsing on when we know the country but not the town. */
export interface MarketPlace {
  name: string;
  hint?: string;
  lat: number;
  lng: number;
}

/** A country Roam operates in, keyed by its ISO-3166-1 alpha-2 code (uppercase). */
export interface Market {
  /** ISO-3166-1 alpha-2, uppercase — e.g. "GB", "US". The registry key. */
  code: string;
  /** Human name — e.g. "United Kingdom". */
  name: string;
  /** ISO-4217 currency code — e.g. "GBP", "USD". */
  currency: string;
  /** Distance/quantity units for this market (display wiring lands in a later phase). */
  units: UnitSystem;
  /**
   * Country bounding box — a FALLBACK classifier only (used by marketForCoords when we have a
   * coordinate but no country code). Not a precise border; boxes may overlap neighbours, so the
   * ISO code from edge headers / address data is always preferred when available.
   */
  bounds: GeoBounds;
  /** Where to centre browsing when we know the country but not a specific town. */
  defaultPlace: MarketPlace;
  /** Whether the market is fully live or still self-seeding (pioneer journey). */
  status: MarketStatus;
}

/**
 * The registry. Keyed by ISO-3166-1 alpha-2 (uppercase). Add a country by adding a row here (and,
 * for a live market, seeding its supply). Bounds are generous fallback boxes, NOT precise borders.
 *
 * Units reflect today's behaviour: distances render in km app-wide (formatDistance in ../geo), so
 * GB is "metric" for now to avoid changing behaviour; per-market display wiring is a later phase.
 */
export const MARKETS: Readonly<Record<string, Market>> = {
  GB: {
    code: "GB",
    name: "United Kingdom",
    currency: "GBP",
    units: "metric",
    // Whole-UK box: mainland GB + the isles + Northern Ireland. Lands End/Lizard (~50.0N),
    // Shetland (~60.86N), St Kilda (~-8.6W)/Fermanagh, Lowestoft (~1.76E). The NI Food to Go
    // fence (../geocode NI_BOUNDS) is a stricter sub-box within this and is unrelated.
    bounds: { minLat: 49.8, maxLat: 61.0, minLng: -8.65, maxLng: 1.8 },
    // Darlington — the current seed's centre of gravity (kept for continuity with DEFAULT_PLACE).
    defaultPlace: { name: "Darlington", hint: "County Durham", lat: 54.5253, lng: -1.5536 },
    status: "live",
  },
  US: {
    code: "US",
    name: "United States",
    currency: "USD",
    units: "imperial",
    // Contiguous US only. Alaska (~51–71N, 172E–130W across the antimeridian) and Hawaii
    // (~18.9–22.2N, −160…−154) fall OUTSIDE this box on purpose — they are classified by their
    // ISO country code (the primary signal), not this fallback box.
    bounds: { minLat: 24.4, maxLat: 49.4, minLng: -125.0, maxLng: -66.9 },
    // Neutral contiguous-US centroid — we avoid implying a launch city; when we actually know the
    // visitor's town (the common case) we centre on that instead.
    defaultPlace: { name: "United States", lat: 39.5, lng: -98.35 },
    status: "seeding",
  },
} as const;

/** The market used only as a genuine last resort (localhost / no country signal at all). */
export const DEFAULT_MARKET_CODE = "GB";

/** The last-resort market (see DEFAULT_MARKET_CODE). Never use this to CLASSIFY a visitor. */
export const DEFAULT_MARKET: Market = MARKETS[DEFAULT_MARKET_CODE]!;

/** Normalise a country code to the registry key form (uppercase, trimmed), or null. */
export function normalizeCountryCode(code: string | null | undefined): string | null {
  const c = (code ?? "").trim().toUpperCase();
  return c.length === 2 ? c : null;
}

/**
 * The registered market for an ISO country code, or undefined if we don't (yet) operate there.
 * Undefined is meaningful: an unknown country is treated downstream as generic "seeding" — the
 * pioneer journey, never UK content — so callers must NOT silently fall back to the default market.
 */
export function getMarket(code: string | null | undefined): Market | undefined {
  const c = normalizeCountryCode(code);
  return c ? MARKETS[c] : undefined;
}

/** Whether we operate a registered market for this country code. */
export function isKnownMarket(code: string | null | undefined): boolean {
  return getMarket(code) !== undefined;
}

/** Whether this country code is a fully-live market (vs seeding / unknown). */
export function isLiveMarket(code: string | null | undefined): boolean {
  return getMarket(code)?.status === "live";
}

/** Whether this country is the United Kingdom — the gate for UK-only surfaces (e.g. Deals). */
export function isUnitedKingdom(code: string | null | undefined): boolean {
  return normalizeCountryCode(code) === "GB";
}

/**
 * Fallback classifier: the market whose bounding box contains a coordinate, or undefined. Use only
 * when no ISO country code is available (e.g. raw browser geolocation without a reverse-geocode).
 * Boxes are generous and may overlap near borders; the ISO code is always the better signal.
 */
export function marketForCoords(lat: number, lng: number): Market | undefined {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return undefined;
  for (const m of Object.values(MARKETS)) {
    if (inBounds(lat, lng, m.bounds)) return m;
  }
  return undefined;
}

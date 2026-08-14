/**
 * @roam/core/f2g — the Food to Go marketplace's SUPPLY-side domain logic (Phase 1).
 *
 * Two concerns live here, both framework-agnostic:
 *
 *   1. Collection settings — a venue's order-ahead & collect capability (venue_collection_settings,
 *      migration 0117). Pure sanitisation of an owner's patch + thin DB read/upsert.
 *
 *   2. Listing readiness — "is this venue actually ready to go live on Food to Go?" A venue is
 *      ready only when it is claimed, tagged into the f2g channel, has at least one live menu item,
 *      is taking online payments, and has its collection capability switched on. The DECISION
 *      (`computeListingStatus`) is a pure function of five booleans and is unit-tested; the
 *      assembly (`getListingStatus`) gathers those booleans from the DB under the caller's client.
 *
 * By law this readiness rule lives here ONCE, so the vendor console, an admin view, or a future
 * partner surface all agree on what "ready" means.
 */
import type { RoamClient } from "@roam/db";
import { getChannelByKey, isVenueInChannel } from "../channels/index.js";
import { NI_BOUNDS, inBounds } from "../geocode/index.js";

/** The F2G channel key readiness is measured against. */
export const F2G_CHANNEL_KEY = "f2g";

/**
 * Whether a venue sits inside the Food to Go region (Northern Ireland). Food to Go is an NI-only
 * marketplace: the storefront discovery RPC (venues_food_to_go_near) fences results to NI_BOUNDS,
 * so a venue outside the box could never appear there. We gate the SUPPLY side — listing into the
 * channel and editing collection settings — by the SAME box, so "can list" ⟺ "could appear", and a
 * business outside NI (e.g. a Darlington café) is never offered the surface.
 *
 * Reads the venue's generated lat/lng (migration 0086). A venue with no coordinates is treated as
 * OUT of region — we never opt a venue in on the strength of missing data.
 */
export async function isVenueInFoodToGoRegion(client: RoamClient, venueId: string): Promise<boolean> {
  const { data, error } = await (client as any)
    .from("venues")
    .select("lat, lng")
    .eq("id", venueId)
    .maybeSingle();
  if (error) throw new Error(`f2g: venue region read failed: ${error.message}`);
  const lat = data?.lat;
  const lng = data?.lng;
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  return inBounds(lat, lng, NI_BOUNDS);
}

// ---------------------------------------------------------------------------
// Food-to-go eligibility (Google Places leaf types)
// ---------------------------------------------------------------------------

/**
 * The Association represents "the food-to-go industry, from fast food outlets to cafés & coffee
 * shops" — a NARROWER set than Roam's "Food & Drink" group (which also holds pubs, bars and
 * sit-down restaurants). We approximate a member from the Google Places leaf types a venue
 * carries (venues.categories): grab-and-go places qualify; drink-led and full-service dining
 * do not. This is why the storefront's "open" mode shows cafés and chippies but NOT The Crown.
 *
 * Every leaf here is one Roam actually ingests (all are in CATEGORY_PLACES_TYPES["Food & Drink"]),
 * so a matching leaf genuinely round-trips: Places attaches it, placeToVenueRow persists it, and
 * isFoodToGo reads it back. The grab-and-go takeaway leaves (meal_takeaway, sandwich_shop, deli,
 * bagel_shop) are the bulk of a high street's food-to-go — they must stay in step with the core
 * taxonomy (adding one here without adding it there would silently never match).
 */
export const FOOD_TO_GO_TYPES: ReadonlySet<string> = new Set([
  "cafe",
  "coffee_shop",
  "bakery",
  "fast_food_restaurant",
  "meal_takeaway",
  "sandwich_shop",
  "deli",
  "bagel_shop",
  "donut_shop",
  "dessert_shop",
  "ice_cream_shop",
  "juice_shop",
]);

/**
 * Whether a venue is a food-to-go business, from the Google leaf types it carries. A venue
 * qualifies when ANY of its `categories` leaves is in FOOD_TO_GO_TYPES. Case/whitespace tolerant;
 * a venue with no leaves never qualifies (we don't guess from the coarse group alone, so a pub
 * tagged only "Food & Drink" is correctly excluded).
 */
export function isFoodToGo(categories: readonly string[] | null | undefined): boolean {
  if (!categories) return false;
  for (const c of categories) {
    if (typeof c === "string" && FOOD_TO_GO_TYPES.has(c.trim().toLowerCase())) return true;
  }
  return false;
}

/**
 * The Google Places (New) `includedTypes` we SEARCH when supplying food-to-go venues on demand.
 * Every entry is a real Table A primary type AND is in Roam's CATEGORY_PLACES_TYPES["Food & Drink"],
 * so a match round-trips (Places accepts the request, placeToVenueRow persists the leaf, isFoodToGo
 * reads it back). Asking Google for these types directly is what makes the storefront's supply
 * cafés/bakeries/takeaways/fast-food — NOT the prominent pubs a coarse "Food & Drink" search
 * returns first.
 *
 * The open-mode ingest issues ONE searchNearby PER type (each capped at 20 by Places), so this list
 * is also the per-cell fan-out: more types = broader supply (independent takeaways, sandwich bars
 * and delis included) at the cost of one paid call each. Keep it a subset of FOOD_TO_GO_TYPES.
 */
export const FOOD_TO_GO_SEARCH_TYPES: readonly string[] = [
  "cafe",
  "coffee_shop",
  "bakery",
  "fast_food_restaurant",
  "meal_takeaway",
  "sandwich_shop",
  "deli",
  "bagel_shop",
  "dessert_shop",
  "donut_shop",
  "ice_cream_shop",
  "juice_shop",
];

// ---------------------------------------------------------------------------
// Collection settings
// ---------------------------------------------------------------------------

/** A venue's order-ahead & collect capability. */
export interface CollectionSettings {
  orderAhead: boolean;
  paused: boolean;
  prepTimeMins: number;
  collectionInstructions: string | null;
}

/** The defaults a venue with no stored row behaves as (mirrors migration 0117 column defaults). */
export const DEFAULT_COLLECTION_SETTINGS: CollectionSettings = {
  orderAhead: true,
  paused: false,
  prepTimeMins: 15,
  collectionInstructions: null,
};

/** Bounds mirrored from the DB check constraints, so the app rejects before Postgres does. */
export const PREP_TIME_MIN = 0;
export const PREP_TIME_MAX = 240;
export const COLLECTION_INSTRUCTIONS_MAX = 500;

/**
 * A partial owner edit to collection settings (any subset of the fields). Each is `| undefined`
 * explicitly so a caller under exactOptionalPropertyTypes (the api boundary) may spread a zod
 * object whose optional keys are present-but-undefined; sanitizeCollectionPatch skips those.
 */
export interface CollectionSettingsPatch {
  orderAhead?: boolean | undefined;
  paused?: boolean | undefined;
  prepTimeMins?: number | undefined;
  collectionInstructions?: string | null | undefined;
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Map a venue_collection_settings row to the domain shape. */
export function rowToCollectionSettings(row: any): CollectionSettings {
  return {
    orderAhead: !!row.order_ahead,
    paused: !!row.paused,
    prepTimeMins: typeof row.prep_time_mins === "number" ? row.prep_time_mins : 15,
    collectionInstructions: row.collection_instructions ?? null,
  };
}

/**
 * PURE: validate + normalise an owner's patch into a snake_case DB patch. Clamps prep time into
 * range, trims instructions to their max (empty → null). Throws on a non-integer prep time — a
 * clear contract for the API boundary to surface. Returns only the keys the caller actually set.
 */
export function sanitizeCollectionPatch(patch: CollectionSettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.orderAhead !== undefined) out.order_ahead = !!patch.orderAhead;
  if (patch.paused !== undefined) out.paused = !!patch.paused;
  if (patch.prepTimeMins !== undefined) {
    const n = patch.prepTimeMins;
    if (!Number.isInteger(n)) throw new Error("prepTimeMins must be an integer number of minutes");
    out.prep_time_mins = Math.min(PREP_TIME_MAX, Math.max(PREP_TIME_MIN, n));
  }
  if (patch.collectionInstructions !== undefined) {
    const v = patch.collectionInstructions;
    const trimmed = typeof v === "string" ? v.trim().slice(0, COLLECTION_INSTRUCTIONS_MAX) : "";
    out.collection_instructions = trimmed.length ? trimmed : null;
  }
  return out;
}

/** Read a venue's collection settings, or the defaults if it has never configured them. */
export async function getCollectionSettings(
  client: RoamClient,
  venueId: string,
): Promise<CollectionSettings> {
  const { data, error } = await (client as any)
    .from("venue_collection_settings")
    .select("order_ahead, paused, prep_time_mins, collection_instructions")
    .eq("venue_id", venueId)
    .maybeSingle();
  if (error) throw new Error(`f2g: collection settings read failed: ${error.message}`);
  return data ? rowToCollectionSettings(data) : { ...DEFAULT_COLLECTION_SETTINGS };
}

/**
 * Upsert a venue's collection settings from an owner patch (RLS gates the write to the claimed
 * venue's owner). Returns the settings as they now stand. A no-op patch still upserts a row so the
 * venue has explicit settings once it has visited the form.
 */
export async function upsertCollectionSettings(
  client: RoamClient,
  venueId: string,
  patch: CollectionSettingsPatch,
): Promise<CollectionSettings> {
  const dbPatch = sanitizeCollectionPatch(patch);
  const { data, error } = await (client as any)
    .from("venue_collection_settings")
    .upsert({ venue_id: venueId, ...dbPatch }, { onConflict: "venue_id" })
    .select("order_ahead, paused, prep_time_mins, collection_instructions")
    .maybeSingle();
  if (error) throw new Error(`f2g: collection settings write failed: ${error.message}`);
  return data ? rowToCollectionSettings(data) : { ...DEFAULT_COLLECTION_SETTINGS, ...camelize(dbPatch) };
}

/** Best-effort snake→camel for the fallback return above (only the four known keys). */
function camelize(dbPatch: Record<string, unknown>): Partial<CollectionSettings> {
  const out: Partial<CollectionSettings> = {};
  if ("order_ahead" in dbPatch) out.orderAhead = !!dbPatch.order_ahead;
  if ("paused" in dbPatch) out.paused = !!dbPatch.paused;
  if ("prep_time_mins" in dbPatch) out.prepTimeMins = dbPatch.prep_time_mins as number;
  if ("collection_instructions" in dbPatch)
    out.collectionInstructions = (dbPatch.collection_instructions as string | null) ?? null;
  return out;
}

// ---------------------------------------------------------------------------
// Listing readiness
// ---------------------------------------------------------------------------

/** The five gates a venue must pass to go live on Food to Go. */
export interface ListingChecklist {
  /** status = 'claimed' with an owner. */
  claimed: boolean;
  /** Tagged into the f2g channel (venue_channels). */
  tagged: boolean;
  /** At least one active menu item (venue_products.active). */
  hasActiveProduct: boolean;
  /** Stripe Connect charges enabled (venue_payment_accounts). */
  paymentsEnabled: boolean;
  /** Order-ahead switched on (venue_collection_settings.order_ahead). */
  collectionConfigured: boolean;
}

/** The checklist plus the derived verdict. `missing` lists the gates still failing, in fixed order. */
export interface ListingStatus extends ListingChecklist {
  ready: boolean;
  missing: (keyof ListingChecklist)[];
}

const CHECKLIST_ORDER: (keyof ListingChecklist)[] = [
  "claimed",
  "tagged",
  "hasActiveProduct",
  "paymentsEnabled",
  "collectionConfigured",
];

/**
 * PURE: turn the five gate booleans into a verdict. Ready iff every gate passes; `missing` is the
 * ordered list of failing gates so the console can render the checklist and the next best action.
 */
export function computeListingStatus(checklist: ListingChecklist): ListingStatus {
  const missing = CHECKLIST_ORDER.filter((k) => !checklist[k]);
  return { ...checklist, ready: missing.length === 0, missing };
}

/**
 * Assemble a venue's F2G listing status from the DB under the caller's client. Reads: the venue's
 * status/owner, its f2g channel membership, its active product count, its payment account, and its
 * collection settings. Payment-account visibility is owner-scoped by RLS, so this is meant to be
 * called by the venue's owner (or a service client).
 */
export async function getListingStatus(
  client: RoamClient,
  venueId: string,
): Promise<ListingStatus> {
  const [venue, channel, activeProduct, payment, collection] = await Promise.all([
    (client as any)
      .from("venues")
      .select("status, owner_id")
      .eq("id", venueId)
      .maybeSingle(),
    getChannelByKey(client, F2G_CHANNEL_KEY),
    (client as any)
      .from("venue_products")
      .select("id")
      .eq("venue_id", venueId)
      .eq("active", true)
      .limit(1),
    (client as any)
      .from("venue_payment_accounts")
      .select("charges_enabled")
      .eq("venue_id", venueId)
      .maybeSingle(),
    getCollectionSettings(client, venueId),
  ]);

  if (venue.error) throw new Error(`f2g: venue read failed: ${venue.error.message}`);

  const claimed = venue.data?.status === "claimed" && !!venue.data?.owner_id;
  const tagged = channel ? await isVenueInChannel(client, channel.id, venueId) : false;
  const hasActiveProduct = Array.isArray(activeProduct.data) && activeProduct.data.length > 0;
  const paymentsEnabled = !!payment.data?.charges_enabled;
  const collectionConfigured = collection.orderAhead;

  return computeListingStatus({
    claimed,
    tagged,
    hasActiveProduct,
    paymentsEnabled,
    collectionConfigured,
  });
}

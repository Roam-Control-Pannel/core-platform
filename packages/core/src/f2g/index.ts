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
import { distanceMetres, type LatLng } from "../geo/index.js";

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
// Delivery settings (Phase 7)
// ---------------------------------------------------------------------------

/**
 * A venue's deliver-to-you capability (venue_delivery_settings, migration 0123). Delivery sits
 * alongside collection — a venue can offer either, both, or neither. The delivery AREA is a radius
 * from the venue and/or a postcode allow-list, minus a postcode block-list; the flat fee is the
 * vendor's to keep (platform commission is on the goods subtotal only).
 */
export interface DeliverySettings {
  deliveryEnabled: boolean;
  paused: boolean;
  deliveryFeePence: number;
  minOrderPence: number;
  /** Max straight-line distance from the venue, in metres. null = no radius limit (postcode-only). */
  radiusM: number | null;
  /** Postcode districts we ALSO deliver to even if outside the radius (e.g. ["BT1","BT2"]). */
  postcodeAllow: string[];
  /** Postcode districts we NEVER deliver to even if inside the radius. Block wins over allow. */
  postcodeBlock: string[];
  etaMins: number;
  deliveryNotes: string | null;
}

/** Defaults a venue with no stored row behaves as (mirrors migration 0123 column defaults). */
export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  deliveryEnabled: false,
  paused: false,
  deliveryFeePence: 0,
  minOrderPence: 0,
  radiusM: null,
  postcodeAllow: [],
  postcodeBlock: [],
  etaMins: 45,
  deliveryNotes: null,
};

/** Bounds mirrored from the DB check constraints, so the app rejects before Postgres does. */
export const DELIVERY_FEE_MAX_PENCE = 5_000_000;
export const MIN_ORDER_MAX_PENCE = 5_000_000;
export const DELIVERY_RADIUS_MAX_M = 50_000;
export const DELIVERY_ETA_MIN = 0;
export const DELIVERY_ETA_MAX = 240;
export const DELIVERY_NOTES_MAX = 500;
/** Guard rails on the postcode lists (not DB-enforced; keeps a fat-fingered paste sane). */
export const POSTCODE_LIST_MAX = 200;
export const POSTCODE_TOKEN_MAX = 8;

/** A partial owner edit to delivery settings. Each key `| undefined` for exactOptionalPropertyTypes. */
export interface DeliverySettingsPatch {
  deliveryEnabled?: boolean | undefined;
  paused?: boolean | undefined;
  deliveryFeePence?: number | undefined;
  minOrderPence?: number | undefined;
  radiusM?: number | null | undefined;
  postcodeAllow?: string[] | undefined;
  postcodeBlock?: string[] | undefined;
  etaMins?: number | undefined;
  deliveryNotes?: string | null | undefined;
}

/** Normalise a postcode to a comparable token: upper-cased, all whitespace removed. */
export function normalizePostcode(raw: string | null | undefined): string {
  return (raw ?? "").toUpperCase().replace(/\s+/g, "");
}

/**
 * The OUTWARD code of a normalised UK postcode (the district). A UK inward code is always the last
 * three chars (digit + two letters), so the outward is everything before them: "BT14AB" → "BT1",
 * "BT145CD" → "BT14". Shorter fragments (a partial the user typed) are returned as-is.
 */
export function postcodeOutward(normalised: string): string {
  return normalised.length > 3 ? normalised.slice(0, -3) : normalised;
}

/**
 * Does an allow/block token match a destination's outward code? An alpha-only token is an AREA
 * ("BT" matches every BT district); a token containing a digit is a specific DISTRICT and must
 * match exactly ("BT1" matches BT1 but NOT BT14). Both are compared as normalised outward codes.
 */
export function postcodeMatches(token: string, destOutward: string): boolean {
  const t = normalizePostcode(token);
  if (!t || !destOutward) return false;
  const tOut = postcodeOutward(t);
  return /\d/.test(tOut) ? destOutward === tOut : destOutward.startsWith(tOut);
}

/** Why an address is / isn't deliverable — a stable reason the API and UI can branch on. */
export type DeliverabilityReason =
  | "ok"
  | "delivery_unavailable" // delivery off or paused
  | "no_destination" // missing destination coordinates
  | "postcode_blocked" // in the block-list
  | "outside_ni" // destination is not in Northern Ireland
  | "outside_area"; // outside the radius and not in the allow-list

export interface DeliverabilityResult {
  deliverable: boolean;
  reason: DeliverabilityReason;
  /** Straight-line venue→destination distance in metres, when coordinates allow it. */
  distanceM: number | null;
}

/**
 * PURE: decide whether a venue can deliver to a destination, given its delivery settings, its own
 * coordinates, and the (geocoded) destination. Order of precedence:
 *   1. delivery must be enabled and not paused;
 *   2. a destination coordinate is required (the checkout geocodes the address);
 *   3. the block-list wins over everything;
 *   4. the destination must be inside Northern Ireland (same fence as the supply side);
 *   5. the allow-list overrides the radius (deliver even if further away);
 *   6. otherwise it must be within the radius (a null radius with no allow-match ⇒ out of area).
 * Minimum-order is a basket concern, checked separately at checkout — not here.
 */
export function checkDeliverable(args: {
  settings: DeliverySettings;
  venue: LatLng;
  destLat: number | null | undefined;
  destLng: number | null | undefined;
  destPostcode: string | null | undefined;
}): DeliverabilityResult {
  const { settings, venue } = args;
  if (!settings.deliveryEnabled || settings.paused) {
    return { deliverable: false, reason: "delivery_unavailable", distanceM: null };
  }
  const hasCoords = typeof args.destLat === "number" && typeof args.destLng === "number";
  const destOutward = postcodeOutward(normalizePostcode(args.destPostcode));

  if (destOutward && settings.postcodeBlock.some((t) => postcodeMatches(t, destOutward))) {
    return { deliverable: false, reason: "postcode_blocked", distanceM: null };
  }
  if (!hasCoords) return { deliverable: false, reason: "no_destination", distanceM: null };
  const dest: LatLng = { lat: args.destLat as number, lng: args.destLng as number };
  if (!inBounds(dest.lat, dest.lng, NI_BOUNDS)) {
    return { deliverable: false, reason: "outside_ni", distanceM: null };
  }
  const distanceM = Math.round(distanceMetres(venue, dest));
  if (destOutward && settings.postcodeAllow.some((t) => postcodeMatches(t, destOutward))) {
    return { deliverable: true, reason: "ok", distanceM };
  }
  if (settings.radiusM !== null && distanceM <= settings.radiusM) {
    return { deliverable: true, reason: "ok", distanceM };
  }
  return { deliverable: false, reason: "outside_area", distanceM };
}

/** Map a venue_delivery_settings row to the domain shape. */
export function rowToDeliverySettings(row: any): DeliverySettings {
  return {
    deliveryEnabled: !!row.delivery_enabled,
    paused: !!row.paused,
    deliveryFeePence: typeof row.delivery_fee_pence === "number" ? row.delivery_fee_pence : 0,
    minOrderPence: typeof row.min_order_pence === "number" ? row.min_order_pence : 0,
    radiusM: typeof row.radius_m === "number" ? row.radius_m : null,
    postcodeAllow: Array.isArray(row.postcode_allow) ? row.postcode_allow : [],
    postcodeBlock: Array.isArray(row.postcode_block) ? row.postcode_block : [],
    etaMins: typeof row.eta_mins === "number" ? row.eta_mins : 45,
    deliveryNotes: row.delivery_notes ?? null,
  };
}

/** Normalise, de-dupe and cap a postcode list into comparable tokens (drops empties). */
function sanitizePostcodeList(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const tok = normalizePostcode(raw).slice(0, POSTCODE_TOKEN_MAX);
    if (!tok || seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= POSTCODE_LIST_MAX) break;
  }
  return out;
}

/** Clamp an integer pence value into [0, max], throwing on a non-integer (a clear API contract). */
function clampPence(n: number, max: number, label: string): number {
  if (!Number.isInteger(n)) throw new Error(`${label} must be an integer number of pence`);
  return Math.min(max, Math.max(0, n));
}

/**
 * PURE: validate + normalise an owner's delivery patch into a snake_case DB patch. Clamps money and
 * ETA into range, normalises the postcode lists, trims notes (empty → null). Throws on a non-integer
 * money/eta/radius value. Returns only the keys the caller actually set (mirrors sanitizeCollectionPatch).
 */
export function sanitizeDeliveryPatch(patch: DeliverySettingsPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (patch.deliveryEnabled !== undefined) out.delivery_enabled = !!patch.deliveryEnabled;
  if (patch.paused !== undefined) out.paused = !!patch.paused;
  if (patch.deliveryFeePence !== undefined)
    out.delivery_fee_pence = clampPence(patch.deliveryFeePence, DELIVERY_FEE_MAX_PENCE, "deliveryFeePence");
  if (patch.minOrderPence !== undefined)
    out.min_order_pence = clampPence(patch.minOrderPence, MIN_ORDER_MAX_PENCE, "minOrderPence");
  if (patch.radiusM !== undefined) {
    if (patch.radiusM === null) out.radius_m = null;
    else {
      if (!Number.isInteger(patch.radiusM)) throw new Error("radiusM must be an integer number of metres");
      out.radius_m = Math.min(DELIVERY_RADIUS_MAX_M, Math.max(0, patch.radiusM));
    }
  }
  if (patch.postcodeAllow !== undefined) out.postcode_allow = sanitizePostcodeList(patch.postcodeAllow);
  if (patch.postcodeBlock !== undefined) out.postcode_block = sanitizePostcodeList(patch.postcodeBlock);
  if (patch.etaMins !== undefined) {
    if (!Number.isInteger(patch.etaMins)) throw new Error("etaMins must be an integer number of minutes");
    out.eta_mins = Math.min(DELIVERY_ETA_MAX, Math.max(DELIVERY_ETA_MIN, patch.etaMins));
  }
  if (patch.deliveryNotes !== undefined) {
    const v = patch.deliveryNotes;
    const trimmed = typeof v === "string" ? v.trim().slice(0, DELIVERY_NOTES_MAX) : "";
    out.delivery_notes = trimmed.length ? trimmed : null;
  }
  return out;
}

/** Read a venue's delivery settings, or the defaults (delivery off) if never configured. */
export async function getDeliverySettings(
  client: RoamClient,
  venueId: string,
): Promise<DeliverySettings> {
  const { data, error } = await (client as any)
    .from("venue_delivery_settings")
    .select(
      "delivery_enabled, paused, delivery_fee_pence, min_order_pence, radius_m, postcode_allow, postcode_block, eta_mins, delivery_notes",
    )
    .eq("venue_id", venueId)
    .maybeSingle();
  if (error) throw new Error(`f2g: delivery settings read failed: ${error.message}`);
  return data ? rowToDeliverySettings(data) : { ...DEFAULT_DELIVERY_SETTINGS };
}

/**
 * Upsert a venue's delivery settings from an owner patch (RLS gates the write to the claimed
 * venue's owner). Returns the settings as they now stand.
 */
export async function upsertDeliverySettings(
  client: RoamClient,
  venueId: string,
  patch: DeliverySettingsPatch,
): Promise<DeliverySettings> {
  const dbPatch = sanitizeDeliveryPatch(patch);
  const { data, error } = await (client as any)
    .from("venue_delivery_settings")
    .upsert({ venue_id: venueId, ...dbPatch }, { onConflict: "venue_id" })
    .select(
      "delivery_enabled, paused, delivery_fee_pence, min_order_pence, radius_m, postcode_allow, postcode_block, eta_mins, delivery_notes",
    )
    .maybeSingle();
  if (error) throw new Error(`f2g: delivery settings write failed: ${error.message}`);
  return data ? rowToDeliverySettings(data) : { ...DEFAULT_DELIVERY_SETTINGS };
}

// ---------------------------------------------------------------------------
// Order totals (goods subtotal + delivery fee; commission on goods only)
// ---------------------------------------------------------------------------

/** One priced basket line (a snapshot of unit price × quantity). */
export interface OrderLine {
  unitPricePence: number;
  quantity: number;
}

/** The money breakdown of an order: goods + delivery, with commission taken on goods only. */
export interface OrderTotals {
  goodsSubtotalPence: number;
  deliveryFeePence: number;
  /** Platform commission — computed on the goods subtotal ONLY, never on the delivery fee. */
  applicationFeePence: number;
  /** What the buyer pays: goods + delivery. */
  totalPence: number;
}

/**
 * PURE: total up a basket. The platform commission (`applicationFeePence`) is a fraction of the
 * GOODS subtotal only, so the vendor keeps the whole delivery fee. `applicationFeeBps` is the
 * platform fee in basis points (e.g. 500 = 5%). Negative/fractional inputs are floored to 0/ints.
 */
export function computeOrderTotals(
  lines: readonly OrderLine[],
  deliveryFeePence: number,
  applicationFeeBps: number,
): OrderTotals {
  const goodsSubtotalPence = lines.reduce(
    (sum, l) => sum + Math.max(0, Math.round(l.unitPricePence)) * Math.max(0, Math.round(l.quantity)),
    0,
  );
  const delivery = Math.max(0, Math.round(deliveryFeePence));
  const applicationFeePence = Math.round((goodsSubtotalPence * Math.max(0, applicationFeeBps)) / 10_000);
  return {
    goodsSubtotalPence,
    deliveryFeePence: delivery,
    applicationFeePence,
    totalPence: goodsSubtotalPence + delivery,
  };
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

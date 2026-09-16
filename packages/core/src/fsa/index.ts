/**
 * @roam/core/fsa — Food Standards Agency food-hygiene ratings (C1).
 *
 * Pure, framework-agnostic logic for the FHRS scheme (NI uses FHRS 0–5). Two concerns live here and
 * NOWHERE else, so web/admin/the sync job all agree:
 *
 *   1. isDisplayableRating — the LOAD-BEARING, legally-important rule: an FSA record can carry a
 *      numeric 0–5 rating OR a non-numeric status ("AwaitingInspection", "Exempt", …). A status must
 *      NEVER be coerced to a number — rendering "Awaiting inspection" as a "0" would defame a business
 *      (a real legal exposure). This function is the single gate: it returns a discriminated result the
 *      UI switches on, so a "0" only ever appears for a genuine rating of 0.
 *   2. parseFsaEstablishment — normalise one raw FSA API record into our row shape (the sync writes it).
 *
 * Plus the official-badge metadata (asset id + alt text) and the mandatory Open Government Licence
 * attribution the FSA's terms require wherever the data is shown.
 */

/** A rating as it should be DISPLAYED — a genuine score, a named non-score status, or nothing. */
export type DisplayableRating =
  | { kind: "score"; score: 0 | 1 | 2 | 3 | 4 | 5 }
  | { kind: "awaiting" } // inspected-but-not-yet-rated / awaiting publication
  | { kind: "exempt" } // low-risk business exempt from rating
  | { kind: "none" }; // unknown / unrated / a scheme we don't render (e.g. Scotland's FHIS)

/**
 * Decide how an FSA rating value should display. Accepts the verbatim FSA value (string or number).
 * ONLY an integer 0–5 becomes a score; every non-numeric status maps to awaiting/exempt/none — a
 * status is never shown as a number. Null/unknown/undefined → none.
 */
export function isDisplayableRating(value: string | number | null | undefined): DisplayableRating {
  if (value === null || value === undefined) return { kind: "none" };

  // Numeric path: an FHRS score is an integer 0..5. (Reject 4.5, "05", NaN, etc.)
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 && value <= 5
      ? { kind: "score", score: value as 0 | 1 | 2 | 3 | 4 | 5 }
      : { kind: "none" };
  }

  const raw = value.trim();
  if (raw === "") return { kind: "none" };
  if (/^[0-5]$/.test(raw)) return { kind: "score", score: Number(raw) as 0 | 1 | 2 | 3 | 4 | 5 };

  // Non-numeric status: compare case- and space-insensitively.
  const status = raw.toLowerCase().replace(/[\s_-]+/g, "");
  if (status === "awaitinginspection" || status === "awaitingpublication") return { kind: "awaiting" };
  if (status === "exempt") return { kind: "exempt" };
  // Anything else (FHIS "Pass"/"Improvement Required", "Pass and Eat Safe", unknown) → don't render.
  return { kind: "none" };
}

// ---------------------------------------------------------------------------
// Official FHRS badge artwork (decision #6: self-hosted, unaltered FSA artwork, no third-party script)
// ---------------------------------------------------------------------------

/**
 * The FSA names its official rating images by the establishment's RatingKey ("fhrs_5_en-gb",
 * "fhrs_exempt_en-gb", …), which the sync stores verbatim (fsa_establishments.rating_key). We ship the
 * official image for each key in THIS allowlist under apps/web/public/fsa/<key>.<ext>. The list is
 * every key present in the live NI register (2026-09-16: fhrs_0…5, exempt, awaitinginspection — all
 * en-gb; NI runs FHRS in English). A key outside it — a Welsh cy-gb key, Scotland's FHIS keys, or a
 * key the FSA adds later — gets NO official asset, so the UI falls back to its own mark and can never
 * show a broken image or the wrong scheme's artwork. Grow it only when the matching file ships.
 */
export const FHRS_BADGE_KEYS: ReadonlySet<string> = new Set([
  "fhrs_0_en-gb",
  "fhrs_1_en-gb",
  "fhrs_2_en-gb",
  "fhrs_3_en-gb",
  "fhrs_4_en-gb",
  "fhrs_5_en-gb",
  "fhrs_awaitinginspection_en-gb",
  "fhrs_exempt_en-gb",
]);

/** The descriptor the official sticker prints under each score — the artwork's own words. */
export const FHRS_DESCRIPTOR: Readonly<Record<0 | 1 | 2 | 3 | 4 | 5, string>> = {
  0: "Urgent improvement necessary",
  1: "Major improvement necessary",
  2: "Improvement necessary",
  3: "Generally satisfactory",
  4: "Good",
  5: "Very good",
};

/** Official badge metadata: the self-hosted asset id (= the FSA rating key) + accessible alt text. */
export interface RatingBadge {
  /** The FSA rating key, which is also our asset id (apps/web/public/fsa/<assetId>.<ext>). */
  assetId: string;
  /** Accessible alt / aria-label — carries the descriptor the artwork prints. */
  alt: string;
}

/** Accessible wording for a displayable rating (null for "none"). Shared by badge, chip and alt text. */
export function ratingAlt(rating: DisplayableRating): string | null {
  if (rating.kind === "score") return `Food Hygiene Rating: ${rating.score} out of 5 (${FHRS_DESCRIPTOR[rating.score]})`;
  if (rating.kind === "awaiting") return "Food Hygiene Rating: Awaiting inspection";
  if (rating.kind === "exempt") return "Food Hygiene Rating: Exempt";
  return null;
}

/** The rating keys that legitimately express a displayed rating — the artwork must match what we say. */
function keysForRating(rating: DisplayableRating): string[] {
  const locales = ["en-gb", "cy-gb"];
  switch (rating.kind) {
    case "score":
      return locales.map((l) => `fhrs_${rating.score}_${l}`);
    case "awaiting":
      return locales.flatMap((l) => [`fhrs_awaitinginspection_${l}`, `fhrs_awaitingpublication_${l}`]);
    case "exempt":
      return locales.map((l) => `fhrs_exempt_${l}`);
    default:
      return [];
  }
}

/**
 * The official badge for a rating, or null when we hold no official artwork for it. Requires the
 * FSA's OWN rating key (never derived from the value): it must be one we ship AND agree with the
 * displayed rating, so a stale or mismatched key (the value says 4, the key says fhrs_5) yields no
 * official badge rather than the wrong sticker. A status never gets a numeric badge — the display
 * decision is made first by isDisplayableRating and the key is only allowed to confirm it.
 */
export function officialBadge(ratingKey: string | null | undefined, rating: DisplayableRating): RatingBadge | null {
  if (!ratingKey) return null;
  const key = ratingKey.trim().toLowerCase();
  if (!FHRS_BADGE_KEYS.has(key)) return null;
  if (!keysForRating(rating).includes(key)) return null;
  const alt = ratingAlt(rating);
  return alt ? { assetId: key, alt } : null;
}

/**
 * The Open Government Licence attribution the FSA's terms require wherever the ratings are displayed.
 * Render this near the badge (with RatingDate + our refresh date). Not optional — it's a licence term.
 */
export const FSA_ATTRIBUTION = {
  text: "Contains public sector information licensed under the Open Government Licence v3.0.",
  licenceUrl: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  source: "Food Standards Agency",
  sourceUrl: "https://ratings.food.gov.uk/",
} as const;

/** The parsed, storage-ready shape of one establishment (matches the 0141 columns). */
export interface ParsedFsaEstablishment {
  fhrsid: string;
  businessName: string;
  businessType: string | null;
  address: string | null;
  postcode: string | null;
  ratingValue: string;
  ratingKey: string | null;
  ratingDate: string | null; // ISO date (yyyy-mm-dd) or null
  localAuthority: string | null;
  lat: number | null;
  lng: number | null;
  raw: Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function str(v: any): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}
function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalise one raw FSA API establishment record into our row shape. Tolerant of the FSA's PascalCase
 * fields and its quirks (address split across AddressLine1..4; Geocode as strings; RatingDate as a
 * datetime). Returns null only when there's no usable FHRSID (the stable key we upsert on).
 */
export function parseFsaEstablishment(rec: any): ParsedFsaEstablishment | null {
  if (!rec || typeof rec !== "object") return null;
  const fhrsid = str(rec.FHRSID ?? rec.fhrsid);
  if (!fhrsid) return null;

  const address = [rec.AddressLine1, rec.AddressLine2, rec.AddressLine3, rec.AddressLine4]
    .map((l) => str(l))
    .filter((l): l is string => !!l)
    .join(", ");

  const geo = rec.Geocode ?? rec.geocode ?? {};
  const ratingDateRaw = str(rec.RatingDate ?? rec.ratingDate);
  // FSA gives an ISO datetime or "yyyy-mm-ddT00:00:00"; keep just the date part when present.
  const ratingDate = ratingDateRaw ? (ratingDateRaw.split("T")[0] ?? null) : null;

  return {
    fhrsid,
    businessName: str(rec.BusinessName ?? rec.businessName) ?? "(unknown)",
    businessType: str(rec.BusinessType ?? rec.businessType),
    address: address || null,
    postcode: str(rec.PostCode ?? rec.postCode ?? rec.postcode),
    ratingValue: str(rec.RatingValue ?? rec.ratingValue) ?? "",
    ratingKey: str(rec.RatingKey ?? rec.ratingKey),
    ratingDate: ratingDate && /^\d{4}-\d{2}-\d{2}$/.test(ratingDate) ? ratingDate : null,
    localAuthority: str(rec.LocalAuthorityName ?? rec.localAuthorityName),
    lat: num(geo.Latitude ?? geo.latitude),
    lng: num(geo.Longitude ?? geo.longitude),
    raw: rec as Record<string, unknown>,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

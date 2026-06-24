/**
 * Pure venue-details logic — Slice 7 (Owner Editable Details).
 *
 * The owner twin of buildOwnerPhotoPublicUrl: no network, no key, no tRPC — pure
 * functions the API mutation depends on and CI unit-tests in isolation. They define the
 * WRITE contract for the two owner-editable venue columns, and they are deliberately the
 * single place that decides what a valid `links` map and `description` look like, so the
 * value the owner writes is exactly the value VenueDetail's reader (`linkEntries`) expects.
 *
 * `links` is a FLAT Record<string,string> (label -> url). The reader (linkEntries in
 * VenueDetail) keeps only entries whose value is a non-empty string, so the writer must
 * emit precisely that: a flat string map, never nested, never null-valued. We validate
 * here rather than trust the client.
 *
 * URL policy: http/https only. We reject other schemes (javascript:, data:, mailto:, …)
 * — these links are rendered as anchors on a public discovery surface, so the scheme
 * allow-list is a safety property, not a nicety.
 */

/** Hard caps — generous for real businesses, bounded against abuse. */
export const VENUE_DETAILS_LIMITS = {
  descriptionMax: 2000,
  linkLabelMax: 40,
  linkUrlMax: 2048,
  maxLinks: 12,
} as const;

/**
 * Normalise a free-text description to what we persist.
 * - trims surrounding whitespace
 * - an empty/whitespace-only string becomes null (the "cleared" state the reader treats
 *   identically to "never set" — VenueDetail renders nothing for a null description)
 * - enforces the max length (throws RangeError; the caller maps to a 400)
 */
export function normaliseVenueDescription(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > VENUE_DETAILS_LIMITS.descriptionMax) {
    throw new RangeError(
      `Description exceeds ${VENUE_DETAILS_LIMITS.descriptionMax} characters.`,
    );
  }
  return trimmed;
}

/** A single allowed URL scheme check — http/https only, parsed not regexed. */
export function isAllowedLinkUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

/**
 * Normalise a links map to the flat Record<string,string> we persist and the reader
 * expects. Input is the owner's raw map (label -> url). We:
 *  - trim labels and urls
 *  - drop any entry with an empty label OR empty url (clearing a link = omitting it)
 *  - reject (throw) a label or url over its cap, or a url whose scheme isn't http/https
 *  - reject (throw) more than maxLinks surviving entries
 *  - preserve insertion order (Object.entries order) so the owner's ordering renders
 *
 * Returns null when nothing survives — the "no links" state, which the reader treats
 * identically to an empty map. Persisting null keeps the cleared state unambiguous.
 */
export function normaliseVenueLinks(
  input: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  if (input == null || typeof input !== "object") return null;

  const out: Record<string, string> = {};
  let count = 0;

  for (const [rawLabel, rawValue] of Object.entries(input)) {
    const label = typeof rawLabel === "string" ? rawLabel.trim() : "";
    const url = typeof rawValue === "string" ? rawValue.trim() : "";

    // Clearing a link = leaving label or url blank. Drop silently (not an error).
    if (label.length === 0 || url.length === 0) continue;

    if (label.length > VENUE_DETAILS_LIMITS.linkLabelMax) {
      throw new RangeError(
        `Link label "${label.slice(0, 20)}…" exceeds ${VENUE_DETAILS_LIMITS.linkLabelMax} characters.`,
      );
    }
    if (url.length > VENUE_DETAILS_LIMITS.linkUrlMax) {
      throw new RangeError(`A link URL exceeds ${VENUE_DETAILS_LIMITS.linkUrlMax} characters.`);
    }
    if (!isAllowedLinkUrl(url)) {
      throw new RangeError(`Link "${label}" must be a valid http(s) URL.`);
    }

    // Last-writer-wins on duplicate labels (case-sensitive key, matching the jsonb map).
    if (!(label in out)) count++;
    out[label] = url;

    if (count > VENUE_DETAILS_LIMITS.maxLinks) {
      throw new RangeError(`At most ${VENUE_DETAILS_LIMITS.maxLinks} links are allowed.`);
    }
  }

  return count === 0 ? null : out;
}

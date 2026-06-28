/**
 * Pure profile-details logic — the write contract for the editable `profiles` columns.
 *
 * The profile twin of venue-details: no network, no tRPC — pure functions the profiles
 * mutation depends on and CI unit-tests in isolation. They are the single place that decides
 * what a valid display name / handle / bio / avatar url / social links map looks like, so the
 * value an owner writes is exactly the value the public profile reader expects.
 *
 * `social_links` reuses the venue links contract (a flat label→http(s)-url map) since it is
 * the same shape and the same safety property (anchors on a public surface ⇒ scheme allow-list).
 */
import { isAllowedLinkUrl, normaliseVenueLinks } from "./venue-details.js";

/** Hard caps — generous for real people, bounded against abuse. */
export const PROFILE_LIMITS = {
  displayNameMax: 80,
  bioMax: 600,
  handleMin: 3,
  handleMax: 30,
  imageUrlMax: 2048,
} as const;

/** Handle charset: lowercase letters, digits, underscore. Stable, URL-safe, @-mentionable. */
const HANDLE_RE = /^[a-z0-9_]+$/;

/** Trim a free-text field to what we persist; empty/whitespace → null; enforce a max. */
function normaliseText(
  input: string | null | undefined,
  max: number,
  label: string,
): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) throw new RangeError(`${label} exceeds ${max} characters.`);
  return trimmed;
}

export function normaliseDisplayName(input: string | null | undefined): string | null {
  return normaliseText(input, PROFILE_LIMITS.displayNameMax, "Display name");
}

export function normaliseBio(input: string | null | undefined): string | null {
  return normaliseText(input, PROFILE_LIMITS.bioMax, "Bio");
}

/**
 * Normalise a handle to what we persist: a leading "@" is stripped, the rest is lowercased
 * and trimmed. Empty → null (the "no handle" state). A non-empty handle MUST be
 * handleMin..handleMax chars of [a-z0-9_] — otherwise throw (the caller maps to a 400).
 * Uniqueness is enforced by the DB (profiles.handle unique); a clash surfaces as a 23505.
 */
export function normaliseHandle(input: string | null | undefined): string | null {
  if (input == null) return null;
  let h = input.trim();
  if (h.startsWith("@")) h = h.slice(1);
  h = h.trim().toLowerCase();
  if (h.length === 0) return null;
  if (h.length < PROFILE_LIMITS.handleMin || h.length > PROFILE_LIMITS.handleMax) {
    throw new RangeError(
      `Handle must be ${PROFILE_LIMITS.handleMin}–${PROFILE_LIMITS.handleMax} characters.`,
    );
  }
  if (!HANDLE_RE.test(h)) {
    throw new RangeError("Handle may only contain lowercase letters, numbers and underscores.");
  }
  return h;
}

/**
 * Normalise an image url (avatar / header) to what we persist. We store the resolved PUBLIC
 * url for a public bucket object; empty → null (cleared); must be a valid http(s) url within
 * the length cap. (We don't store the storage path here — the profile-media bucket is public,
 * so the url is stable and the column has always meant "where the image is".)
 */
export function normaliseImageUrl(input: string | null | undefined): string | null {
  if (input == null) return null;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > PROFILE_LIMITS.imageUrlMax) {
    throw new RangeError(`Image URL exceeds ${PROFILE_LIMITS.imageUrlMax} characters.`);
  }
  if (!isAllowedLinkUrl(trimmed)) throw new RangeError("Image URL must be a valid http(s) URL.");
  return trimmed;
}

/** Social links: the same flat label→http(s)-url contract as venue links. */
export function normaliseProfileLinks(
  input: Record<string, unknown> | null | undefined,
): Record<string, string> | null {
  return normaliseVenueLinks(input);
}

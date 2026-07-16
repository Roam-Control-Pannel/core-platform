/**
 * Presence helpers — the PURE, side-effect-free logic behind the presence router (routers/presence.ts).
 *
 * Kept separate (same split as profile-wall.ts ↔ routers/profileWall.ts) so the status rules —
 * note normalisation, the clear-vs-set row shape, and expiry ("is this status still live?") — are
 * unit-tested deterministically with an injected clock, no tRPC/DB/network.
 */

/** The machine-filterable states a friend can be shown. A cleared status is `availability: null` —
 *  never a member of this enum. */
export const AVAILABILITY = ["free_to_meet", "out_and_about", "heads_down"] as const;
export type Availability = (typeof AVAILABILITY)[number];

export const NOTE_MAX = 80;
export const DEFAULT_TTL_HOURS = 4;
export const MAX_TTL_HOURS = 24;

// Location share windows (PR 2). Deliberately short — precise location is only ever ephemeral.
// The DB clamps to the same 1–8h range (set_my_location) as a second line of defence.
export const LOCATION_TTL_CHOICES = [1, 4, 8] as const;
export const DEFAULT_LOCATION_TTL_HOURS = 1;
export const MAX_LOCATION_TTL_HOURS = 8;

const HOUR_MS = 3_600_000;

/** The friend_presence row shape (not in generated DB types until `pnpm db:types`). */
export interface PresenceRow {
  profile_id: string;
  availability: Availability | null;
  note: string | null;
  expires_at: string | null;
  updated_at: string;
}

export interface SetAvailabilityInput {
  /** null clears the status. */
  availability: Availability | null;
  // `| undefined` is explicit so the zod-inferred `.nullish()` input assigns under
  // exactOptionalPropertyTypes (an absent vs. explicitly-undefined note are equivalent here).
  note?: string | null | undefined;
  ttlHours?: number | undefined;
}

/** Trim, collapse internal whitespace, cap at NOTE_MAX; empty/whitespace/null → null.
 *  Mirrors profileWall.normaliseLocation. */
export function normaliseNote(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, NOTE_MAX);
}

/**
 * Build the friend_presence row to upsert. Clearing (`availability: null`) nulls the note AND the
 * expiry so no friend sees a status; setting stamps expires_at = now + ttl (default 4h, so it
 * self-clears). `nowMs` is injected so tests are deterministic.
 */
export function buildPresenceRow(
  profileId: string,
  input: SetAvailabilityInput,
  nowMs: number,
): PresenceRow {
  const clearing = input.availability === null;
  const ttl = input.ttlHours ?? DEFAULT_TTL_HOURS;
  return {
    profile_id: profileId,
    availability: input.availability,
    note: clearing ? null : normaliseNote(input.note),
    expires_at: clearing ? null : new Date(nowMs + ttl * HOUR_MS).toISOString(),
    updated_at: new Date(nowMs).toISOString(),
  };
}

/** True while a status is set AND its expiry (if any) hasn't elapsed. `nowMs` injected. */
export function isLive(
  row: Pick<PresenceRow, "availability" | "expires_at">,
  nowMs: number,
): boolean {
  if (!row.availability) return false;
  if (row.expires_at && new Date(row.expires_at).getTime() <= nowMs) return false;
  return true;
}

/** True while a location share is active — a geo-expiry that's set and still in the future.
 *  (The coordinate itself is nulled on stop, so a present, future geo_expires_at means "sharing".) */
export function isLocationLive(geoExpiresAt: string | null | undefined, nowMs: number): boolean {
  if (!geoExpiresAt) return false;
  return new Date(geoExpiresAt).getTime() > nowMs;
}

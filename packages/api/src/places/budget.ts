/**
 * Places cost-control policy — the daily paid-call budgets and per-client rate limit handed to
 * claim_places_fetch_quota (migration 0024) on every freshness miss.
 *
 * The DEFAULTS live in @roam/core (visible + unit-tested there). This api-layer shim lets an
 * operator OVERRIDE each number via an environment variable WITHOUT a code change or migration —
 * the tuning knob for global self-seed: as discovery opens worldwide, the daily $ ceiling (and the
 * per-client fairness limit) can be raised or lowered per environment from config alone.
 *
 * Resolved once at module load. An unset/blank/invalid override falls back to the core default; a
 * value must be a POSITIVE INTEGER — a 0, negative, or NaN override is ignored, never silently
 * disabling a cost bound. Env vars:
 *   PLACES_DAILY_FETCH_BUDGET   — global paid searchNearby/textSearch calls per day
 *   PLACES_DETAILS_DAILY_BUDGET — global paid Place Details enrichments per day
 *   PLACES_CLIENT_FETCH_LIMIT   — paid calls per client (forwarded IP) per window
 *   PLACES_CLIENT_WINDOW_SECS   — length of that per-client window, in seconds
 */
import { places as corePlaces } from "@roam/core";

/** Parse a positive-integer override, else the fallback. Exported for unit testing. */
export function envPosInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export interface PlacesPolicy {
  dailyFetchBudget: number;
  detailsDailyBudget: number;
  clientFetchLimit: number;
  clientWindowSecs: number;
}

/** Resolve the policy from an env bag (defaults to process.env). Pure — unit-testable. */
export function resolvePlacesPolicy(env: NodeJS.ProcessEnv = process.env): PlacesPolicy {
  return {
    dailyFetchBudget: envPosInt(env.PLACES_DAILY_FETCH_BUDGET, corePlaces.PLACES_DAILY_FETCH_BUDGET),
    detailsDailyBudget: envPosInt(env.PLACES_DETAILS_DAILY_BUDGET, corePlaces.PLACES_DETAILS_DAILY_BUDGET),
    clientFetchLimit: envPosInt(env.PLACES_CLIENT_FETCH_LIMIT, corePlaces.PLACES_CLIENT_FETCH_LIMIT),
    clientWindowSecs: envPosInt(env.PLACES_CLIENT_WINDOW_SECS, corePlaces.PLACES_CLIENT_WINDOW_SECS),
  };
}

/** The active policy for this process — resolved once at load from the environment. */
export const PLACES_POLICY: PlacesPolicy = resolvePlacesPolicy();

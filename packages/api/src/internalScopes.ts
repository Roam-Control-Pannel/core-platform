/**
 * Internal-call SCOPES (holistic plan Phase 1.5).
 *
 * One platform-wide x-internal-call secret used to unlock EVERY internal procedure — ban/unban,
 * claim approval, credits, moderation, paid ingests — and the web deployment held it, because its
 * server-side route handlers make trusted hops for ingest, enrichment, transit and Brevo. A leak of
 * the web's env, or a second app deployment (apps/f2g, Phase 4), would have held the keys to all of
 * it. Now a caller presents ONE of two secrets:
 *
 *   INTERNAL_CALL_SECRET      → scope "full"  — crons, Edge Functions, webhooks, ops. Everything.
 *   INTERNAL_CALL_SECRET_WEB  → scope "web"   — the web app's server routes. ONLY the procedures
 *                                                listed here; anything else is FORBIDDEN even with
 *                                                a valid secret.
 *
 * The list is the exact set the web's route handlers call today (apps/web/src/app/api/**). Add to it
 * deliberately, in the same PR as the route that needs it. Rollout is safe: while
 * INTERNAL_CALL_SECRET_WEB is unset on either side, the web keeps using the full secret and nothing
 * changes; once both sides carry the web secret, the web deployment can no longer reach the rest.
 */

export type InternalScope = "full" | "web";

/** tRPC procedure paths ("router.procedure") the web-scoped secret may call. */
export const WEB_INTERNAL_SCOPE: ReadonlySet<string> = new Set([
  "places.ingestCategory",
  "places.ingestArea",
  "places.ingestFoodToGo",
  "places.searchText",
  "places.enrichVenue",
  "places.googleReviews",
  "transit.nearbyDepartures",
  "transit.planTrip",
  "transit.searchStops",
  "marketing.syncNewUser",
]);

/** PURE: may a caller with `scope` invoke the procedure at `path`? */
export function isAllowedForScope(scope: InternalScope | null, path: string | undefined): boolean {
  if (scope === null) return false;
  if (scope === "full") return true;
  return typeof path === "string" && WEB_INTERNAL_SCOPE.has(path);
}

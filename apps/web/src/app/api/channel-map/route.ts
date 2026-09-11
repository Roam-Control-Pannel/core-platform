/**
 * GET /api/channel-map — the public host → channel-key map, for the web MIDDLEWARE to resolve a
 * hostname to its branded channel from config (the `channel_domains` table) rather than a hardcoded
 * classifier. Onboarding a whitelabel domain then becomes a row in the DB, not a redeploy (review
 * debt: the env-based classifier in lib/channel.ts only knew dev hosts + NEXT_PUBLIC_F2G_HOSTS).
 *
 * Why an endpoint and not a direct DB read in middleware: middleware runs on the Edge, where a
 * per-request DB round-trip is both slow and unreliable (no stable connection pool, no in-process
 * cache across invocations). Instead the map is served here from the Node runtime and CDN-cached,
 * so the edge middleware fetches a warm, shared copy (see lib/channelMap.ts for the memoized fetch).
 *
 * The map is public, low-cardinality and channel-independent, so it is safe to cache hard:
 *   s-maxage=300 (5 min fresh) + stale-while-revalidate=600 (serve stale up to 10 min while the CDN
 * refreshes in the background). A newly-onboarded domain is therefore live within ~5 minutes with no
 * deploy. Fail-open: on any error the body is `{ domains: [] }` and the middleware falls back to its
 * env classifier, so a transient API blip never breaks host resolution.
 *
 * runtime nodejs (the tRPC server client is a Node client, not Edge-safe).
 */
import { NextResponse } from "next/server";
import { getChannelMap } from "../../../lib/serverApi";

export const runtime = "nodejs";

export async function GET() {
  const domains = await getChannelMap();
  return NextResponse.json(
    { domains },
    { headers: { "cache-control": "public, s-maxage=300, stale-while-revalidate=600" } },
  );
}

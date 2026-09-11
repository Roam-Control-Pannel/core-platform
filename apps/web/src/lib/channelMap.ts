/**
 * channelMap — the middleware's host→channel resolver, backed by the DB `channel_domains` map via
 * the CDN-cached `/api/channel-map` endpoint (not a hardcoded classifier).
 *
 * Two-tier resolution, cheapest first:
 *   1. The env classifier (channelKeyForHost): knows the dev hosts, NEXT_PUBLIC_F2G_HOSTS and the
 *      f2g./food. subdomain convention. A positive hit short-circuits with NO network — the known
 *      storefront hosts stay instant, exactly as before this slice.
 *   2. Only when the classifier says "default" do we consult the config map: the host might be a
 *      whitelabel domain onboarded as a DB row that the env classifier can't know. We read it from
 *      the CDN-cached endpoint (see route.ts) and exact-match the normalized host.
 *
 * Caching: the CDN (s-maxage + stale-while-revalidate) is the real cache; this module adds a tiny
 * in-instance memo (TTL below) so a warm edge instance handling a burst of requests doesn't re-fetch
 * per request. Edge instances don't reliably share module state, so the memo is best-effort only —
 * correctness never depends on it (the CDN copy is warm regardless).
 *
 * Fail-open throughout: an unmapped host, an empty map, or a fetch error all resolve to the default
 * channel (or a stale memo if we have one), so a transient API blip degrades to Roam chrome rather
 * than breaking navigation.
 */
import { channelKeyForHost, normalizeHost, DEFAULT_CHANNEL_KEY } from "./channel";

/** One host→channel-key row, matching the /api/channel-map JSON shape. */
interface DomainMapping {
  host: string;
  channelKey: string;
}

/** In-instance memo TTL. Short: the CDN holds the durable cache; this only de-dupes a warm burst. */
const TTL_MS = 60_000;

let memo: { at: number; domains: DomainMapping[] } | null = null;

/** Fetch the config map through the CDN-cached endpoint, memoized per warm instance. Fail-open. */
async function loadMap(origin: string): Promise<DomainMapping[]> {
  const now = Date.now();
  if (memo && now - memo.at < TTL_MS) return memo.domains;
  try {
    const res = await fetch(`${origin}/api/channel-map`, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`channel-map ${res.status}`);
    const body = (await res.json()) as { domains?: DomainMapping[] };
    const domains = Array.isArray(body.domains) ? body.domains : [];
    memo = { at: now, domains };
    return domains;
  } catch {
    // Keep any stale copy; otherwise empty (the env classifier has already had its say).
    return memo?.domains ?? [];
  }
}

/**
 * Resolve a raw Host value to its channel key. `origin` is the request origin (req.nextUrl.origin),
 * used to reach the config endpoint. Never throws — always yields a channel key.
 */
export async function resolveChannelKey(origin: string, rawHost: string | null | undefined): Promise<string> {
  // Tier 1: env classifier — a positive hit needs no network.
  const envKey = channelKeyForHost(rawHost);
  if (envKey !== DEFAULT_CHANNEL_KEY) return envKey;

  // Tier 2: consult the DB-backed config map for a whitelabel domain the classifier doesn't know.
  const host = normalizeHost(rawHost);
  if (!host) return DEFAULT_CHANNEL_KEY;
  const domains = await loadMap(origin);
  const hit = domains.find((d) => d.host === host);
  return hit && hit.channelKey ? hit.channelKey : DEFAULT_CHANNEL_KEY;
}

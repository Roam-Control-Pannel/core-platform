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
import {
  channelKeyForHost,
  normalizeHost,
  isKnownDefaultHost,
  isPlatformPreviewOrigin,
  DEFAULT_CHANNEL_KEY,
} from "./channel";

/** One host→channel-key row, matching the /api/channel-map JSON shape. */
interface DomainMapping {
  host: string;
  channelKey: string;
}

/**
 * In-instance memo TTL. Edge instances don't reliably share module state, so this is best-effort —
 * but it was 60s, which on a cold-ish instance pool bought almost nothing while the lookup ran about
 * once per page view (2026-09-18 Vercel log). Channel domains change when a whitelabel is onboarded,
 * i.e. roughly never, so ten minutes of staleness is a fair trade for ten minutes of no fetches.
 * Onboarding a new domain is still visible within the TTL, and the CDN copy is warm regardless.
 */
const TTL_MS = 10 * 60_000;

let memo: { at: number; domains: DomainMapping[] } | null = null;

/**
 * Per-host resolution memo, including MISSES. Without this, every request for a host that isn't in
 * the map re-ran the whole tier even when the map itself was memoized. Bounded so a flood of junk
 * Host headers can't grow it without limit.
 */
const HOST_MEMO_MAX = 256;
const hostMemo = new Map<string, { at: number; key: string }>();

function rememberHost(host: string, key: string): string {
  if (hostMemo.size >= HOST_MEMO_MAX) {
    const oldest = hostMemo.keys().next();
    if (!oldest.done) hostMemo.delete(oldest.value);
  }
  hostMemo.set(host, { at: Date.now(), key });
  return key;
}

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
  } catch (e) {
    // Keep any stale copy; otherwise empty (the env classifier has already had its say) — but say
    // so: a silent fail-open is how a branded host quietly becomes Roam (plan Phase 1.4).
    reportMapFailure(e);
    return memo?.domains ?? [];
  }
}

/** Throttled ops alert for a failed channel-map lookup. Best-effort, never awaited, never throws. */
let lastReportAt = 0;
const REPORT_EVERY_MS = 10 * 60_000;
function reportMapFailure(e: unknown): void {
  const now = Date.now();
  if (now - lastReportAt < REPORT_EVERY_MS) return;
  lastReportAt = now;
  const detail = e instanceof Error ? e.message : String(e);
  console.error(`[channel-map] lookup failed, resolving hosts fail-open to the default channel: ${detail}`);
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) return;
  const text = `[WARN] web — channel-map lookup failed; unmapped hosts fall open to Roam\n${detail}\nkey: web.channel-map · ${new Date(now).toISOString()}`;
  try {
    void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, content: text }) }).catch(() => {});
  } catch {
    /* never let alerting break resolution */
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

  const host = normalizeHost(rawHost);
  if (!host) return DEFAULT_CHANNEL_KEY;

  // Tier 1b: hosts whose answer is already known (2026-09-18). The canonical Roam host and the
  // loopback dev hosts are the default channel by definition — they were previously falling all the
  // way through to a network fetch that matched nothing and returned the default anyway, about once
  // per page view. A whitelabel host is never the canonical host, so this cannot mask one.
  if (isKnownDefaultHost(host, process.env.NEXT_PUBLIC_SITE_URL)) return DEFAULT_CHANNEL_KEY;

  // Tier 1c: on a platform deployment URL the map endpoint sits behind deployment protection and
  // answers 401 — six of the seven logged errors on 2026-09-18. The lookup cannot succeed there and
  // is not needed: a whitelabel domain is a customer's own domain, never a *.vercel.app address.
  if (isPlatformPreviewOrigin(origin)) return DEFAULT_CHANNEL_KEY;

  // Per-host memo, hits AND misses: the map memo alone still re-walked this tier per request.
  const cached = hostMemo.get(host);
  if (cached && Date.now() - cached.at < TTL_MS) return cached.key;

  // Tier 2: consult the DB-backed config map for a whitelabel domain the classifier doesn't know.
  const domains = await loadMap(origin);
  const hit = domains.find((d) => d.host === host);
  return rememberHost(host, hit && hit.channelKey ? hit.channelKey : DEFAULT_CHANNEL_KEY);
}

/**
 * Awin Offers API client (server-only).
 *
 * Pulls advertiser promotions/vouchers via the Publisher API (api.awin.com, OAuth2 Bearer). Awin's
 * API docs are auth-gated (they 403 to anyone not logged in), so the exact request/response shape
 * couldn't be pinned from outside — this client is therefore DEFENSIVE and SELF-REVEALING:
 *
 *   - the offers path + region are overridable via env (AWIN_API_BASE / AWIN_REGION), and
 *   - AWIN_DEBUG=1 logs the raw JSON of the first request + response (truncated), so one real run
 *     confirms the field names and we tune `normalizeOffer` to reality (same play as Translink).
 *
 * The normaliser reads each field from several plausible names and drops any offer missing the
 * essentials (id, advertiser, title, a destination URL), so a schema mismatch degrades to "fewer
 * deals", never a crash. Publisher account id auto-resolves via /accounts when not configured.
 */

export interface AwinConfig {
  apiKey: string;
  publisherId: string | null;
  baseUrl: string;
  region: string;
  /** Which advertisers' offers to pull: "joined" (partners we earn from) | "notJoined" | "all". */
  membership: string;
  debug: boolean;
  /** Override the offers endpoint path (use `{publisherId}` as a token). Skips endpoint probing. */
  offersPath?: string | null;
  /** Override the offers endpoint method (GET | POST). Defaults to POST (or per the probe). */
  offersMethod?: string | null;
}

/** A normalised offer, shaped for the awin_deals row it becomes. */
export interface AwinOffer {
  promotionId: string;
  advertiserId: string;
  advertiserName: string | null;
  title: string;
  description: string | null;
  kind: "offer" | "voucher";
  voucherCode: string | null;
  terms: string | null;
  destinationUrl: string;
  imageUrl: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

type Json = Record<string, unknown>;

const trunc = (s: string, n = 1200): string => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s);

interface AwinResponse {
  status: number;
  json: unknown;
  text: string;
}

const PER_CALL_TIMEOUT_MS = 12_000;

/** Authenticated request against the Awin API. Never throws on HTTP status — returns it, so the
 *  caller can probe candidate endpoints. A per-call timeout (AbortSignal) means no single call can
 *  hang the whole job; a transport error / timeout comes back as status 0 with the reason in text. */
async function awinReq(cfg: AwinConfig, method: string, path: string, body: string | null, log: (m: string) => void): Promise<AwinResponse> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}${path}`;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
      ...(body ? { body } : {}),
    });
  } catch (e) {
    const ms = Date.now() - started;
    const reason = e instanceof Error ? e.message : String(e);
    if (cfg.debug) log(`awin ${method} ${path} → ERROR ${ms}ms ${reason}`);
    return { status: 0, json: null, text: `transport error after ${ms}ms: ${reason}` };
  }
  const text = await res.text();
  const ms = Date.now() - started;
  if (cfg.debug) log(`awin ${method} ${path} → ${res.status} ${ms}ms len=${text.length} ${trunc(text)}`);
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    /* non-JSON body (e.g. an HTML error page) — leave json null */
  }
  return { status: res.status, json, text };
}

const ok2xx = (s: number): boolean => s >= 200 && s < 300;

/** Resolve the publisher account id: the configured one, else the first publisher from /accounts. */
export async function resolvePublisherId(cfg: AwinConfig, log: (m: string) => void): Promise<string> {
  if (cfg.publisherId) return cfg.publisherId;
  const r = await awinReq(cfg, "GET", "/accounts?type=publisher", null, log);
  if (!ok2xx(r.status)) throw new Error(`Awin /accounts failed: ${r.status} ${trunc(r.text, 300)}`);
  const body = (r.json ?? {}) as Json;
  const accounts = (body.accounts ?? body.data ?? []) as Json[];
  const first = accounts.find((a) => String(a.accountType ?? a.type ?? "publisher").toLowerCase() === "publisher") ?? accounts[0];
  const id = first ? String(first.accountId ?? first.id ?? "") : "";
  if (!id) throw new Error("Awin: could not resolve a publisher account id from /accounts.");
  return id;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const pick = (o: Json, ...keys: string[]): unknown => {
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
};

/** Map a raw Awin promotion to our shape, reading each field from several plausible names. */
export function normalizeOffer(raw: Json): AwinOffer | null {
  const adv = (pick(raw, "advertiser", "programme", "merchant") as Json | undefined) ?? {};
  const voucher = (pick(raw, "voucher", "code") as Json | undefined) ?? {};
  const promotionId = str(pick(raw, "promotionId", "id", "promotionID", "offerId"));
  const advertiserId = str(pick(adv, "id", "advertiserId") ?? pick(raw, "advertiserId", "programmeId"));
  const title = str(pick(raw, "title", "name", "description", "summary"));
  // Prefer a raw landing URL (we add tracking + clickref at render); fall back to any tracked url.
  const destinationUrl =
    str(pick(raw, "urlClickThrough", "landingPage", "url", "destinationUrl", "deepLink")) ??
    str(pick(raw, "urlTracking", "clickThroughUrl"));
  if (!promotionId || !advertiserId || !title || !destinationUrl) return null;

  const voucherCode = str(pick(voucher, "code") ?? pick(raw, "voucherCode", "code"));
  const typeRaw = (str(pick(raw, "type", "promotionType")) ?? "").toLowerCase();
  const kind: "offer" | "voucher" = voucherCode || typeRaw.includes("voucher") || typeRaw.includes("code") ? "voucher" : "offer";

  return {
    promotionId,
    advertiserId,
    advertiserName: str(pick(adv, "name", "advertiserName") ?? pick(raw, "advertiserName", "programmeName")),
    title,
    description: str(pick(raw, "description", "details", "summary")),
    kind,
    voucherCode,
    terms: str(pick(raw, "terms", "termsAndConditions", "conditions")),
    destinationUrl,
    imageUrl: str(pick(adv, "logoUrl", "logo") ?? pick(raw, "imageUrl", "image")),
    startsAt: str(pick(raw, "startDate", "startsAt", "validFrom")),
    endsAt: str(pick(raw, "endDate", "endsAt", "validTo", "expiryDate")),
  };
}

interface Endpoint {
  method: string;
  path: string;
}

const PAGE_SIZE = 100;

/** Pull the offers array out of whatever envelope Awin returns. */
function itemsFrom(json: unknown): Json[] {
  if (Array.isArray(json)) return json as Json[];
  const o = (json ?? {}) as Json;
  const cand = o.data ?? o.offers ?? o.promotions ?? o.results ?? o.content;
  return Array.isArray(cand) ? (cand as Json[]) : [];
}

const offersBody = (cfg: AwinConfig, page: number): string =>
  JSON.stringify({ filters: { membership: cfg.membership, regionCodes: [cfg.region] }, pagination: { page, pageSize: PAGE_SIZE } });

const withQuery = (path: string, page: number): string =>
  `${path}${path.includes("?") ? "&" : "?"}page=${page}&pageSize=${PAGE_SIZE}`;

/**
 * Find the offers endpoint. Awin's docs are auth-gated so the exact path/method couldn't be pinned;
 * when AWIN_OFFERS_PATH isn't set we PROBE the likely candidates (plural/singular × offers/promotions
 * × POST/GET) and use the first that responds 2xx — so one real run discovers it. An explicit
 * AWIN_OFFERS_PATH/METHOD override skips probing entirely.
 */
async function discoverEndpoint(cfg: AwinConfig, publisherId: string, log: (m: string) => void): Promise<{ ep: Endpoint; first: AwinResponse }> {
  if (cfg.offersPath) {
    const method = (cfg.offersMethod ?? "POST").toUpperCase();
    const path = cfg.offersPath.replace("{publisherId}", publisherId);
    const first = await awinReq(cfg, method, method === "GET" ? withQuery(path, 1) : path, method === "POST" ? offersBody(cfg, 1) : null, log);
    return { ep: { method, path }, first };
  }
  // POST /publisher/{id}/promotions first: probing showed GET on it returns 405 (exists, wrong
  // method) while every other path 404s — so this is the resource, and Awin's "Retrieve Offers"
  // docs live at /apidocs/promotions. The rest stay as fallbacks for other accounts/regions.
  const candidates: Endpoint[] = [
    { method: "POST", path: `/publisher/${publisherId}/promotions` },
    { method: "POST", path: `/publishers/${publisherId}/promotions` },
    { method: "POST", path: `/publishers/${publisherId}/offers` },
    { method: "GET", path: `/publisher/${publisherId}/promotions` },
    { method: "GET", path: `/publishers/${publisherId}/promotions` },
    { method: "POST", path: `/publisher/${publisherId}/offers` },
  ];
  const failures: string[] = [];
  for (const ep of candidates) {
    const path = ep.method === "GET" ? withQuery(ep.path, 1) : ep.path;
    const r = await awinReq(cfg, ep.method, path, ep.method === "POST" ? offersBody(cfg, 1) : null, log);
    if (ok2xx(r.status)) {
      log(`awin: offers endpoint = ${ep.method} ${ep.path}`);
      return { ep, first: r };
    }
    // Surface the body for anything that's NOT a plain 404 (a 400/422 means "right path, wrong
    // request" — we want to see it in the response summary, not just the Railway log).
    failures.push(`${ep.method} ${ep.path} → ${r.status}${r.status !== 404 ? ` ${trunc(r.text, 160)}` : ""}`);
  }
  throw new Error(`Awin: no offers endpoint responded. Tried: ${failures.join(" | ")}`);
}

/**
 * Retrieve current offers for the publisher: discover the endpoint, page through it (membership=all
 * so we get offers from advertisers we're joined to AND the wider network), and normalise. Offers
 * that map cleanly are returned; malformed ones are skipped (counted in debug).
 */
export async function retrieveOffers(cfg: AwinConfig, log: (m: string) => void = () => {}): Promise<AwinOffer[]> {
  const publisherId = await resolvePublisherId(cfg, log);
  const { ep, first } = await discoverEndpoint(cfg, publisherId, log);
  const out: AwinOffer[] = [];
  let dropped = 0;
  const consume = (json: unknown): number => {
    const items = itemsFrom(json);
    for (const raw of items) {
      const o = normalizeOffer(raw);
      if (o) out.push(o);
      else dropped++;
    }
    return items.length;
  };
  let count = consume(first.json);
  if (cfg.debug) log(`awin: page 1 → ${count} items (${out.length} kept)`);
  // Cap at 10 pages (1000 offers) — plenty for a curated deals surface, and a hard stop so a huge
  // "all-network" pull can't run past the request budget.
  for (let page = 2; page <= 10 && count >= PAGE_SIZE; page++) {
    const path = ep.method === "GET" ? withQuery(ep.path, page) : ep.path;
    const r = await awinReq(cfg, ep.method, path, ep.method === "POST" ? offersBody(cfg, page) : null, log);
    if (!ok2xx(r.status)) break;
    count = consume(r.json);
    if (cfg.debug) log(`awin: page ${page} → ${count} items (${out.length} kept)`);
  }
  if (dropped > 0) log(`awin: skipped ${dropped} offer(s) missing required fields.`);
  return out;
}

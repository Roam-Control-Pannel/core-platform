/**
 * CJ (Commission Junction) Link Search API client (server-only).
 *
 * Pulls promotional links for the publisher's JOINED advertisers via the Link Search REST API
 * (GET https://link-search.api.cj.com/v2/link-search, Bearer personal-access-token) and normalises
 * them into the cj_deals shape. Two facts pinned from the CJ docs:
 *   - auth is a plain `Authorization: Bearer <token>` (a personal access token), and
 *   - the returned `clickUrl` is ALREADY affiliate-tracked (the website id is baked in), so we store
 *     it verbatim and the web never re-wraps it.
 *
 * CJ Link Search returns XML. Rather than add an XML dependency for one integration, we parse the flat
 * <link> elements with a small, defensive extractor — and try JSON first, in case an account/Accept
 * returns JSON. The client is SELF-REVEALING like the Awin one: CJ_DEBUG=1 logs the raw first response
 * (truncated), so one real run confirms the field names and we tune `normalizeLink` to reality.
 *
 * The normaliser reads each field from several plausible names and drops any link missing the
 * essentials (link id, advertiser, title, a clickUrl), so a schema mismatch degrades to "fewer deals",
 * never a crash.
 */

export interface CjConfig {
  /** CJ personal access token (Bearer). */
  token: string;
  /** Your CJ website id (PID) — the `website-id` query param. */
  websiteId: string;
  /** API base, override per env. Default https://link-search.api.cj.com */
  baseUrl: string;
  /** `advertiser-ids` value: "joined" (partners we earn from, default) | "notjoined" | a comma list. */
  advertiserIds: string;
  /** Optional CJ `link-type` filter (e.g. "Text Link", "Banner"); null = all types. */
  linkType: string | null;
  /** Optional CJ `promotion-type` filter (e.g. "Coupon", "Sale"); null = all. */
  promotionType: string | null;
  /** Keep only links with a promotional signal (coupon/promo-type/end-date) so the surface is deals,
   *  not generic homepage links. Default true; set CJ_ALL_LINKS=1 to keep everything. */
  promotionalOnly: boolean;
  /** Cap deals kept per category so no single category (e.g. Vacation) dominates the surface.
   *  0 = unlimited. Set CJ_MAX_PER_CATEGORY to balance the mix. */
  maxPerCategory: number;
  /** Optional locality tag stored on each row for later geo-relevance; null = global. */
  region: string;
  debug: boolean;
}

/** A normalised CJ link, shaped for the cj_deals row it becomes. */
export interface CjDeal {
  linkId: string;
  advertiserId: string;
  advertiserName: string | null;
  title: string;
  description: string | null;
  kind: "offer" | "voucher";
  voucherCode: string | null;
  /** CJ clickUrl — already affiliate-tracked; stored verbatim, never re-wrapped. */
  destinationUrl: string;
  imageUrl: string | null;
  category: string | null;
  startsAt: string | null;
  endsAt: string | null;
}

const PER_CALL_TIMEOUT_MS = 12_000;
const PAGE_SIZE = 100;
const trunc = (s: string, n = 1200): string => (s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s);

interface CjResponse {
  status: number;
  text: string;
}

/** Authenticated GET against the CJ API. Never throws on HTTP status — returns it (with the body),
 *  so the caller can surface a 401/403 in the sync result. A per-call AbortSignal timeout means no
 *  single call can hang the whole job; a transport error/timeout comes back as status 0. */
async function cjGet(cfg: CjConfig, path: string, log: (m: string) => void): Promise<CjResponse> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}${path}`;
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/xml, application/json;q=0.9" },
      signal: AbortSignal.timeout(PER_CALL_TIMEOUT_MS),
    });
  } catch (e) {
    const ms = Date.now() - started;
    const reason = e instanceof Error ? e.message : String(e);
    if (cfg.debug) log(`cj GET ${path} → ERROR ${ms}ms ${reason}`);
    return { status: 0, text: `transport error after ${ms}ms: ${reason}` };
  }
  const text = await res.text();
  if (cfg.debug) log(`cj GET ${path} → ${res.status} ${Date.now() - started}ms len=${text.length} ${trunc(text)}`);
  return { status: res.status, text };
}

/* ── parsing ─────────────────────────────────────────────────────────────────────────────── */

/** Decode the handful of XML entities CJ emits (order matters: &amp; last). */
function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}

/** First text value of a child tag within an XML fragment (case-insensitive), or "" if absent. */
function xmlTag(fragment: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(fragment);
  return m ? decodeXml(m[1] ?? "") : "";
}

/**
 * Turn a CJ Link Search response into an array of flat field bags. Tries JSON first (some
 * accounts/Accept return JSON), else extracts each <link> XML element into a Record of its child
 * tags. Returns [] on anything unparseable, so a bad body degrades to "no deals", never a throw.
 */
export function parseLinks(body: string): Record<string, string>[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(json)
        ? json
        : (((json as Record<string, unknown>)?.links as unknown) ??
           ((json as Record<string, unknown>)?.data as unknown) ??
           []);
      const list = Array.isArray(arr) ? arr : [];
      return list.map((o) => {
        const rec: Record<string, string> = {};
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (v != null && (typeof v === "string" || typeof v === "number")) rec[k] = String(v);
        }
        return rec;
      });
    } catch {
      return [];
    }
  }
  // XML: pull each <link>…</link> block, then its child tags.
  const out: Record<string, string>[] = [];
  const linkRe = /<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/gi;
  const FIELDS = [
    "link-id", "advertiser-id", "advertiser-name", "link-name", "link-type",
    "clickUrl", "click-url", "description", "coupon-code", "promotion-type",
    "promotion-start-date", "promotion-end-date", "category", "advertiser-category",
  ];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(body)) !== null) {
    const frag = m[1] ?? "";
    const rec: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = xmlTag(frag, f);
      if (v) rec[f] = v;
    }
    out.push(rec);
  }
  return out;
}

const val = (o: Record<string, string>, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

/**
 * A CJ banner/image link's `link-name` is its creative filename — "Generic_120x90",
 * "Chicago_spanish_468x60" — not a human offer title. Detect those so we can prefer the description
 * instead (and drop the link entirely if there's nothing readable).
 */
export function looksLikeCreativeName(name: string): boolean {
  return (
    /\d{2,4}\s*[x×]\s*\d{2,4}/i.test(name) || // banner dimensions: 120x90, 468x60, 728x90
    /^generic\b/i.test(name) ||
    /\.(gif|jpe?g|png|svg)$/i.test(name) // an image filename
  );
}

/** Tidy a raw name/description for display: underscores → spaces, collapse whitespace. */
export function prettifyTitle(s: string): string {
  return s.replace(/_+/g, " ").replace(/\s+/g, " ").trim();
}

/** Choose the best human title: a non-creative link-name, else the description, else null (a pure
 *  banner creative with no text — dropped so we never show "Generic_120x90" as a deal). */
function bestTitle(rawName: string | null, description: string | null): string | null {
  if (rawName && !looksLikeCreativeName(rawName)) return prettifyTitle(rawName);
  if (description) return prettifyTitle(description);
  return null;
}

/**
 * Map a raw CJ link (flat field bag from XML or JSON) to our CjDeal, reading each field from several
 * plausible names. Returns null when a structural essential is missing (id, advertiser, title, or a
 * clickUrl) — the promotional-signal filter is applied separately in retrieveDeals (config-driven).
 */
export function normalizeLink(raw: Record<string, string>): CjDeal | null {
  const linkId = val(raw, "link-id", "linkId", "id");
  const advertiserId = val(raw, "advertiser-id", "advertiserId", "cid");
  const description = val(raw, "description", "link-description");
  const title = bestTitle(val(raw, "link-name", "linkName", "name"), description);
  const destinationUrl = val(raw, "clickUrl", "click-url", "clickURL", "clickurl");
  if (!linkId || !advertiserId || !title || !destinationUrl) return null;

  const voucherCode = val(raw, "coupon-code", "couponCode", "coupon");
  const promoType = (val(raw, "promotion-type", "promotionType") ?? "").toLowerCase();
  const kind: "offer" | "voucher" =
    voucherCode || promoType.includes("coupon") || promoType.includes("code") ? "voucher" : "offer";

  return {
    linkId,
    advertiserId,
    advertiserName: val(raw, "advertiser-name", "advertiserName"),
    title,
    description,
    kind,
    voucherCode,
    destinationUrl,
    imageUrl: val(raw, "image-url", "imageUrl"),
    category: val(raw, "category", "advertiser-category", "primary-category"),
    startsAt: val(raw, "promotion-start-date", "promotionStartDate", "start-date"),
    endsAt: val(raw, "promotion-end-date", "promotionEndDate", "end-date"),
  };
}

/** A link is "promotional" (a real deal, not a generic homepage link) when it carries a coupon, a
 *  promotion type, or a promotion end date. Gate for the deals surface; disabled by CJ_ALL_LINKS=1. */
export function isPromotional(raw: Record<string, string>): boolean {
  return Boolean(
    val(raw, "coupon-code", "couponCode", "coupon") ||
      val(raw, "promotion-type", "promotionType") ||
      val(raw, "promotion-end-date", "promotionEndDate", "end-date"),
  );
}

const ok2xx = (s: number): boolean => s >= 200 && s < 300;

function buildPath(cfg: CjConfig, page: number): string {
  const p = new URLSearchParams({
    "website-id": cfg.websiteId,
    "advertiser-ids": cfg.advertiserIds,
    "records-per-page": String(PAGE_SIZE),
    "page-number": String(page),
  });
  if (cfg.linkType) p.set("link-type", cfg.linkType);
  if (cfg.promotionType) p.set("promotion-type", cfg.promotionType);
  return `/v2/link-search?${p.toString()}`;
}

/**
 * Retrieve current promotional links for the publisher's joined advertisers: page through Link
 * Search, keep promotional links that map cleanly. Malformed/non-promotional links are skipped
 * (counted in debug). Throws on a non-2xx first page (auth/quota) so the sync surfaces the reason.
 */
export async function retrieveDeals(cfg: CjConfig, log: (m: string) => void = () => {}): Promise<CjDeal[]> {
  const out: CjDeal[] = [];
  let droppedStruct = 0;
  let droppedNonPromo = 0;

  const consume = (body: string): number => {
    const links = parseLinks(body);
    for (const raw of links) {
      if (cfg.promotionalOnly && !isPromotional(raw)) { droppedNonPromo++; continue; }
      const deal = normalizeLink(raw);
      if (deal) out.push(deal);
      else droppedStruct++;
    }
    return links.length;
  };

  const first = await cjGet(cfg, buildPath(cfg, 1), log);
  if (!ok2xx(first.status)) {
    throw new Error(`CJ link-search failed: ${first.status} ${trunc(first.text, 300)}`);
  }
  let count = consume(first.text);
  if (cfg.debug) log(`cj: page 1 → ${count} links (${out.length} kept)`);

  // Cap at 10 pages (1000 links) — plenty for a curated deals surface, and a hard stop so a big
  // pull can't run past the request budget. Stop early when a page comes back short.
  for (let page = 2; page <= 10 && count >= PAGE_SIZE; page++) {
    const r = await cjGet(cfg, buildPath(cfg, page), log);
    if (!ok2xx(r.status)) break;
    count = consume(r.text);
    if (cfg.debug) log(`cj: page ${page} → ${count} links (${out.length} kept)`);
  }

  if (droppedNonPromo > 0) log(`cj: skipped ${droppedNonPromo} non-promotional link(s).`);
  if (droppedStruct > 0) log(`cj: skipped ${droppedStruct} link(s) missing a title / required fields.`);

  // Balance the mix: cap deals kept per category so one category (e.g. Vacation) can't dominate.
  if (cfg.maxPerCategory > 0) {
    const perCat = new Map<string, number>();
    const capped: CjDeal[] = [];
    let droppedCap = 0;
    for (const d of out) {
      const key = (d.category ?? "").toLowerCase();
      const n = perCat.get(key) ?? 0;
      if (n >= cfg.maxPerCategory) { droppedCap++; continue; }
      perCat.set(key, n + 1);
      capped.push(d);
    }
    if (droppedCap > 0) log(`cj: capped ${droppedCap} link(s) over ${cfg.maxPerCategory}/category.`);
    return capped;
  }
  return out;
}

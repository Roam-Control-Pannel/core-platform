/**
 * CJ (Commission Junction) Advertiser Lookup API client (server-only).
 *
 * Companion to the Link Search client: where Link Search gives us deals, Advertiser Lookup gives us
 * per-advertiser brand metadata — most importantly a LOGO url — so a CJ deal card can show the
 * merchant's real logo instead of the generic category icon. One lookup per advertiser (cached in
 * cj_advertisers), not per deal.
 *
 * SELF-REVEALING, like the Link Search client: CJ_DEBUG=1 logs the raw first response so we can
 * confirm the real field names against the live API. CJ's public docs do not pin down which field
 * (if any) carries the logo, so `normalizeAdvertiser` reads it from several plausible names and
 * returns logoUrl=null when none is present. A missing logo is NOT an error — the deal card simply
 * falls back to its category icon (zero regression). If a real run shows the logo under a name we
 * don't yet read, we add that name here and re-run; nothing else changes.
 *
 * Advertiser Lookup lives on a DIFFERENT host from Link Search (advertiser-lookup.api.cj.com), so it
 * takes cfg.advertiserLookupBaseUrl. Same Bearer personal-access-token; same XML-or-JSON body shape.
 */
import { cjAuthedGet, decodeXml, val, type CjConfig } from "./client.js";

/** A resolved advertiser: its id, display name, the merchant site (program-url), and a brand logo
 *  derived from that site's domain (null when there's no usable domain). */
export interface CjAdvertiser {
  advertiserId: string;
  advertiserName: string | null;
  programUrl: string | null;
  logoUrl: string | null;
}

/** CJ caps advertiser-ids per lookup call; page in comfortable batches well under that. */
const IDS_PER_CALL = 50;
const RECORDS_PER_PAGE = 50;

const ok2xx = (s: number): boolean => s >= 200 && s < 300;
const trunc = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** First text value of a child tag within an XML fragment (case-insensitive), or "" if absent.
 *  Local copy tolerant of self-closing tags (`<logo-url/>`), which advertiser records can emit. */
function tag(fragment: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(fragment);
  return m ? decodeXml(m[1] ?? "") : "";
}

/**
 * Turn an Advertiser Lookup response into flat field bags — JSON first (some accounts/Accept return
 * JSON), else one Record per `<advertiser>` XML element. Returns [] on anything unparseable, so a bad
 * body degrades to "no logos", never a throw.
 */
export function parseAdvertisers(body: string): Record<string, string>[] {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const json = JSON.parse(trimmed) as unknown;
      const arr = Array.isArray(json)
        ? json
        : (((json as Record<string, unknown>)?.advertisers as unknown) ??
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
  // XML: pull each <advertiser>…</advertiser> block, then the flat fields we care about.
  const out: Record<string, string>[] = [];
  const advRe = /<advertiser(?:\s[^>]*)?>([\s\S]*?)<\/advertiser>/gi;
  const FIELDS = [
    "advertiser-id", "advertiser-name",
    // program-url is the merchant's own site — we derive the brand logo from its domain. (CJ's
    // Advertiser Lookup carries no logo field; the logo-* names remain only to prefer one if CJ ever
    // adds it.)
    "program-url",
    "logo-url", "logo", "advertiser-logo-url", "advertiser-logo", "program-logo-url", "image-url",
  ];
  let m: RegExpExecArray | null;
  while ((m = advRe.exec(body)) !== null) {
    const frag = m[1] ?? "";
    const rec: Record<string, string> = {};
    for (const f of FIELDS) {
      const v = tag(frag, f);
      if (v) rec[f] = v;
    }
    out.push(rec);
  }
  return out;
}

/** Reduce a program URL to a bare domain: strip scheme, credentials, path, port, www.
 *  "http://www.CruiseDirect.com/deals" → "cruisedirect.com". Null when there's no plausible host. */
export function domainFromUrl(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme://
  s = s.replace(/^[^/@]*@/, ""); // user:pass@
  s = (s.split(/[/?#]/)[0] ?? "").split(":")[0] ?? ""; // drop path/query/fragment/port
  s = s.replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s) ? s : null;
}

/** Brand logo for a domain via the Clearbit logo service (public, keyless). A miss 404s and the card
 *  falls back to its category icon (DealThumb's onError), so an unknown/bad domain is harmless. */
export function logoUrlForDomain(domain: string): string {
  return `https://logo.clearbit.com/${domain}`;
}

/**
 * Map a raw advertiser bag to CjAdvertiser. Null when there's no advertiser-id (nothing to key on).
 * CJ Advertiser Lookup exposes no logo field, so the logo is derived from the merchant's own site
 * (program-url) domain; an explicit logo field is still preferred if CJ ever adds one. logoUrl is
 * null only when there's neither a usable domain nor an explicit logo (→ the card keeps its icon).
 */
export function normalizeAdvertiser(raw: Record<string, string>): CjAdvertiser | null {
  const advertiserId = val(raw, "advertiser-id", "advertiserId", "cid");
  if (!advertiserId) return null;
  const programUrl = val(raw, "program-url", "programUrl", "url");
  const explicitLogo = val(raw, "logo-url", "logoUrl", "logo", "advertiser-logo-url", "advertiser-logo", "program-logo-url");
  const domain = domainFromUrl(programUrl);
  const logoUrl =
    (explicitLogo && /^https?:\/\//i.test(explicitLogo) ? explicitLogo : null) ??
    (domain ? logoUrlForDomain(domain) : null);
  return {
    advertiserId,
    advertiserName: val(raw, "advertiser-name", "advertiserName", "name"),
    programUrl,
    logoUrl,
  };
}

/** Split a list into fixed-size chunks. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function buildPath(cfg: CjConfig, ids: string[], page: number): string {
  const p = new URLSearchParams({
    // Advertiser Lookup keys on the account CID, NOT the website PID — prefer the explicit CID.
    "requestor-cid": cfg.advertiserLookupCid ?? cfg.websiteId,
    "advertiser-ids": ids.join(","),
    "records-per-page": String(RECORDS_PER_PAGE),
    "page-number": String(page),
  });
  return `/v2/advertiser-lookup?${p.toString()}`;
}

/**
 * Look up brand metadata (logos) for a set of advertiser ids, batched under the per-call id cap.
 * Returns a map advertiserId → CjAdvertiser for every advertiser the API resolved (whether or not it
 * carried a logo). A non-2xx or unparseable batch is logged and skipped — those advertisers just
 * won't get a logo this run; the sync never fails because a logo was missing.
 */
export async function retrieveAdvertiserLogos(
  cfg: CjConfig,
  advertiserIds: string[],
  log: (m: string) => void = () => {},
): Promise<Map<string, CjAdvertiser>> {
  const base = cfg.advertiserLookupBaseUrl.replace(/\/$/, "");
  const unique = [...new Set(advertiserIds.filter((id) => id && id.trim()))];
  const resolved = new Map<string, CjAdvertiser>();
  let withLogo = 0;

  for (const ids of chunk(unique, IDS_PER_CALL)) {
    const res = await cjAuthedGet(cfg, `${base}${buildPath(cfg, ids, 1)}`, log);
    if (!ok2xx(res.status)) {
      log(`cj advertiser-lookup: batch of ${ids.length} → ${res.status} ${trunc(res.text)} (skipped)`);
      continue;
    }
    for (const raw of parseAdvertisers(res.text)) {
      const adv = normalizeAdvertiser(raw);
      if (!adv) continue;
      resolved.set(adv.advertiserId, adv);
      if (adv.logoUrl) withLogo++;
    }
  }

  log(`cj advertiser-lookup: resolved ${resolved.size}/${unique.length} advertiser(s), ${withLogo} with a logo.`);
  return resolved;
}

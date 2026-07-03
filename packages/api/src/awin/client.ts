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
  debug: boolean;
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

/** Authenticated fetch against the Awin API. Throws on a non-2xx with a truncated body for logs. */
async function awinFetch(cfg: AwinConfig, path: string, init: RequestInit, log: (m: string) => void): Promise<unknown> {
  const url = `${cfg.baseUrl.replace(/\/$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (cfg.debug) log(`awin ${init.method ?? "GET"} ${path} → ${res.status} ${trunc(text)}`);
  if (!res.ok) {
    throw new Error(`Awin ${init.method ?? "GET"} ${path} failed: ${res.status} ${trunc(text, 300)}`);
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

/** Resolve the publisher account id: the configured one, else the first publisher from /accounts. */
export async function resolvePublisherId(cfg: AwinConfig, log: (m: string) => void): Promise<string> {
  if (cfg.publisherId) return cfg.publisherId;
  const body = (await awinFetch(cfg, "/accounts?type=publisher", { method: "GET" }, log)) as Json | null;
  const accounts = (body?.accounts ?? body?.data ?? []) as Json[];
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

/**
 * Retrieve current offers for the publisher. POSTs a filter body (membership=all so we get offers
 * from advertisers we're joined to AND the wider network), pages until a short page, and normalises.
 * Returns the offers that map cleanly; malformed ones are skipped (logged in debug).
 */
export async function retrieveOffers(cfg: AwinConfig, log: (m: string) => void = () => {}): Promise<AwinOffer[]> {
  const publisherId = await resolvePublisherId(cfg, log);
  const pageSize = 100;
  const out: AwinOffer[] = [];
  let dropped = 0;
  for (let page = 1; page <= 20; page++) {
    const body = JSON.stringify({
      filters: { membership: "all", regionCodes: [cfg.region] },
      pagination: { page, pageSize },
    });
    const res = (await awinFetch(cfg, `/publisher/${publisherId}/offers`, { method: "POST", body }, log)) as Json | Json[] | null;
    const items = (Array.isArray(res) ? res : ((res?.data ?? res?.offers ?? res?.promotions ?? []) as Json[])) ?? [];
    for (const raw of items) {
      const o = normalizeOffer(raw);
      if (o) out.push(o);
      else dropped++;
    }
    if (items.length < pageSize) break;
  }
  if (dropped > 0) log(`awin: skipped ${dropped} offer(s) missing required fields.`);
  return out;
}

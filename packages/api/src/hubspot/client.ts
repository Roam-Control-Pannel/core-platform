/**
 * HubSpot CRM client (F2G plan 2.3) — reads the Association's membership out of their own system.
 *
 * READ-ONLY, deliberately. Roam has no business holding write access to a partner's CRM to do a job
 * that only reads, so the private-app token needs just `crm.objects.companies.read` and
 * `crm.objects.contacts.read`. Write-back of onboarding status is plan 2b and will be a separate,
 * explicitly-scoped decision.
 *
 * DORMANT by default: with no `HUBSPOT_TOKEN`, `loadHubspotConfig()` returns null and the job/route
 * no-op with "unconfigured" — the same posture as FSA/Awin/CJ, so this ships and deploys safely long
 * before the token exists.
 *
 * Shape mirrors ../fsa/client.ts: config from env, paged fetches, best-effort logging, and all the
 * parsing delegated to @roam/core/hubspot so the rules are testable without a token (which matters
 * here more than usual — we cannot reach their portal to try things).
 */
import { hubspot } from "@roam/core";

export interface HubspotConfig {
  baseUrl: string;
  token: string;
  /** Which channel's roster this portal feeds. */
  channelKey: string;
  /** HubSpot property names per roster field; env-overridable (see @roam/core/hubspot). */
  propertyMap: hubspot.HubspotPropertyMap;
  /** Objects per page. HubSpot caps list/search at 100. */
  pageSize: number;
  /** Safety bound on pages per run, so a paging bug cannot loop forever against a metered API. */
  maxPages: number;
}

/** Build the config from env, or null when the token is unset (feature dormant). */
export function loadHubspotConfig(): HubspotConfig | null {
  const token = process.env.HUBSPOT_TOKEN?.trim();
  if (!token) return null;
  const pageSize = Number(process.env.HUBSPOT_PAGE_SIZE ?? "100");
  const maxPages = Number(process.env.HUBSPOT_MAX_PAGES ?? "200");
  return {
    baseUrl: (process.env.HUBSPOT_API_BASE ?? "https://api.hubapi.com").replace(/\/+$/, ""),
    token,
    channelKey: process.env.HUBSPOT_CHANNEL_KEY?.trim() || "f2g",
    propertyMap: hubspot.parsePropertyMap(process.env.HUBSPOT_PROPERTY_MAP),
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : 100,
    maxPages: Number.isFinite(maxPages) && maxPages > 0 ? Math.min(maxPages, 1000) : 200,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Thrown for a response that is not worth retrying past — the caller aborts the run cleanly. */
export class HubspotError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "HubspotError";
  }
}

async function call(cfg: HubspotConfig, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${cfg.baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${cfg.token}`,
      "content-type": "application/json",
      accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    // The body often names the offending property, which is the single most useful thing when a
    // portal uses custom property names — surface it rather than just the status.
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 500);
    } catch {
      /* body already consumed or unreadable — the status still tells the story */
    }
    throw new HubspotError(`HubSpot ${init?.method ?? "GET"} ${path} → HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
  }
  return res.json();
}

/**
 * Every company in the portal, paged.
 *
 * `since` switches to the SEARCH endpoint filtered on `hs_lastmodifieddate`, so a nightly run costs
 * one page instead of the whole book. The list endpoint is used for a full sync because search caps
 * out at 10,000 results — fine for incremental deltas, not for a first import of an unknown-size
 * portal.
 */
export async function fetchCompanies(
  cfg: HubspotConfig,
  since: Date | null,
  log: (msg: string) => void = () => {},
): Promise<hubspot.HubspotCompany[]> {
  const props = hubspot.companyProperties(cfg.propertyMap);
  const out: hubspot.HubspotCompany[] = [];
  let skipped = 0;
  let after: string | undefined;

  for (let page = 0; page < cfg.maxPages; page++) {
    let body: any;
    if (since) {
      body = await call(cfg, `/crm/v3/objects/companies/search`, {
        method: "POST",
        body: JSON.stringify({
          filterGroups: [
            { filters: [{ propertyName: "hs_lastmodifieddate", operator: "GTE", value: String(since.getTime()) }] },
          ],
          properties: props,
          limit: cfg.pageSize,
          ...(after ? { after } : {}),
        }),
      });
    } else {
      const qs = new URLSearchParams({ limit: String(cfg.pageSize), properties: props.join(",") });
      if (after) qs.set("after", after);
      body = await call(cfg, `/crm/v3/objects/companies?${qs.toString()}`);
    }

    const results: any[] = Array.isArray(body?.results) ? body.results : [];
    for (const rec of results) {
      const parsed = hubspot.parseCompany(rec, cfg.propertyMap);
      if (parsed) out.push(parsed);
      else skipped++;
    }
    after = body?.paging?.next?.after;
    if (!after || results.length === 0) break;
  }

  if (skipped > 0) log(`hubspot: ${skipped} company record(s) skipped (no usable name).`);
  return out;
}

/**
 * The contacts associated with each company, as a company-id → contacts map.
 *
 * Two calls per batch: associations v4 to learn which contacts belong to which company, then a batch
 * read for the contact properties. Batched at 100 (HubSpot's limit for both) so a few thousand
 * members cost tens of requests, not thousands.
 */
export async function fetchContactsByCompany(
  cfg: HubspotConfig,
  companyIds: readonly string[],
  log: (msg: string) => void = () => {},
): Promise<Map<string, hubspot.HubspotContact[]>> {
  const byCompany = new Map<string, hubspot.HubspotContact[]>();
  if (companyIds.length === 0) return byCompany;
  const props = hubspot.contactProperties(cfg.propertyMap);
  const BATCH = 100;

  for (let i = 0; i < companyIds.length; i += BATCH) {
    const slice = companyIds.slice(i, i + BATCH);

    let assoc: any;
    try {
      assoc = await call(cfg, `/crm/v4/associations/companies/contacts/batch/read`, {
        method: "POST",
        body: JSON.stringify({ inputs: slice.map((id) => ({ id })) }),
      });
    } catch (e) {
      // Best-effort: a company whose contacts we cannot read is still a member, it just has no
      // e-mail yet. Losing the whole run over it would be worse than losing the credential.
      log(`hubspot: association read failed for a batch of ${slice.length}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const wanted = new Set<string>();
    const contactsOf = new Map<string, string[]>();
    for (const row of (Array.isArray(assoc?.results) ? assoc.results : []) as any[]) {
      const companyId = String(row?.from?.id ?? row?._from?.id ?? "");
      if (!companyId) continue;
      const ids = (Array.isArray(row?.to) ? row.to : [])
        .map((t: any) => String(t?.toObjectId ?? t?.id ?? ""))
        .filter(Boolean);
      if (ids.length === 0) continue;
      contactsOf.set(companyId, ids);
      for (const id of ids) wanted.add(id);
    }
    if (wanted.size === 0) continue;

    const byId = new Map<string, hubspot.HubspotContact>();
    const wantedIds = [...wanted];
    for (let j = 0; j < wantedIds.length; j += BATCH) {
      let read: any;
      try {
        read = await call(cfg, `/crm/v3/objects/contacts/batch/read`, {
          method: "POST",
          body: JSON.stringify({ properties: props, inputs: wantedIds.slice(j, j + BATCH).map((id) => ({ id })) }),
        });
      } catch (e) {
        log(`hubspot: contact batch read failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      for (const rec of (Array.isArray(read?.results) ? read.results : []) as any[]) {
        const parsed = hubspot.parseContact(rec, cfg.propertyMap);
        if (parsed) byId.set(parsed.id, parsed);
      }
    }

    for (const [companyId, ids] of contactsOf) {
      const list = ids.map((id) => byId.get(id)).filter((c): c is hubspot.HubspotContact => !!c);
      if (list.length > 0) byCompany.set(companyId, list);
    }
  }

  return byCompany;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

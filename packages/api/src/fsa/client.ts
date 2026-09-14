/**
 * FSA ratings API client (C1). Fetches food-hygiene establishments from the Food Standards Agency's
 * open-data API (api.ratings.food.gov.uk), one NI local authority at a time, and parses each record
 * into our storage shape via @roam/core/fsa.
 *
 * DORMANT by default: with no `FSA_NI_AUTHORITY_IDS` configured, `loadFsaConfig()` returns null and the
 * sync no-ops — so the API/job run before the FSA endpoint is provisioned (same posture as Awin/CJ).
 * The 11 NI council authority ids are supplied via env rather than hardcoded, so a corrected id list is
 * a config change, not a deploy.
 */
import { fsa } from "@roam/core";

/** One parsed FSA establishment (re-exported from the core namespace type for local annotations). */
export type ParsedFsaEstablishment = fsa.ParsedFsaEstablishment;

export interface FsaConfig {
  baseUrl: string;
  /** FSA localAuthorityId values for the 11 NI councils (from env). */
  authorityIds: number[];
  pageSize: number;
}

/** Build the FSA config from env, or null when the authority id list is unset (feature dormant). */
export function loadFsaConfig(): FsaConfig | null {
  const raw = process.env.FSA_NI_AUTHORITY_IDS;
  if (!raw || !raw.trim()) return null;
  const authorityIds = raw
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (authorityIds.length === 0) return null;
  const pageSize = Number(process.env.FSA_PAGE_SIZE ?? "5000");
  return {
    baseUrl: (process.env.FSA_API_BASE ?? "https://api.ratings.food.gov.uk").replace(/\/+$/, ""),
    authorityIds,
    pageSize: Number.isFinite(pageSize) && pageSize > 0 ? Math.min(pageSize, 5000) : 5000,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Fetch every establishment for one NI local authority, paged, and parse it. BEST-EFFORT: a failed
 * authority logs and returns [] (the run continues for the others) — one council's outage must never
 * blank the whole corpus (the caller also refuses to deactivate on an empty pull).
 */
export async function fetchAuthorityEstablishments(
  cfg: FsaConfig,
  authorityId: number,
  log: (msg: string) => void = () => {},
): Promise<ParsedFsaEstablishment[]> {
  const out: ParsedFsaEstablishment[] = [];
  const MAX_PAGES = 200; // pageSize(5000) * 200 = 1M rows — a safety bound, never reached for one LA
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${cfg.baseUrl}/Establishments?localAuthorityId=${authorityId}&pageNumber=${page}&pageSize=${cfg.pageSize}`;
    let batch: any[];
    try {
      const res = await fetch(url, {
        headers: { "x-api-version": "2", accept: "application/json" },
      });
      if (!res.ok) {
        log(`fsa: authority ${authorityId} page ${page} → HTTP ${res.status}; stopping this authority.`);
        break;
      }
      const body = (await res.json()) as any;
      batch = Array.isArray(body?.establishments) ? body.establishments : [];
    } catch (e) {
      log(`fsa: authority ${authorityId} page ${page} fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      break;
    }
    for (const rec of batch) {
      const parsed = fsa.parseFsaEstablishment(rec);
      if (parsed) out.push(parsed);
    }
    if (batch.length < cfg.pageSize) break; // last page
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * List FSA local authorities — the source of truth for FSA_NI_AUTHORITY_IDS.
 *
 * The FSA's Food Hygiene Rating Scheme (FHRS) open-data API publishes every local authority with a
 * numeric `LocalAuthorityId` and a `RegionName`. Our sync (src/fsa/client.ts) pages
 * `/Establishments?localAuthorityId=<id>` per council, so FSA_NI_AUTHORITY_IDS is just the
 * comma-joined `LocalAuthorityId`s of the 11 Northern Ireland councils. This script fetches them so
 * the env value is verified against the live registry, not typed by hand.
 *
 * The API is free, keyless, Open Government Licence v3.0. Must run somewhere with egress to
 * api.ratings.food.gov.uk (the deployed API environment, or a dev machine).
 *
 * RUN (from repo root):
 *   pnpm --filter @roam/api fsa:authorities            # Northern Ireland only (default)
 *   pnpm --filter @roam/api fsa:authorities -- --all   # every UK authority, grouped by region
 *   pnpm --filter @roam/api fsa:authorities -- --region="Scotland"
 *
 * Override the base with FSA_API_BASE if ever needed (defaults to the public endpoint).
 */

interface FsaAuthority {
  LocalAuthorityId: number;
  Name: string;
  RegionName: string | null;
}

function arg(name: string): string | undefined {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf("=");
  return eq === -1 ? "" : hit.slice(eq + 1);
}

/**
 * The 11 Northern Ireland councils, as the FSA registry names them. The DEFAULT mode matches on
 * RegionName OR on these names, so a registry quirk (a differently-labelled or missing region —
 * the `/Authorities/basic` endpoint omits RegionName entirely, which is how the first run of this
 * script returned nothing) can never silently produce an empty NI list.
 */
const NI_COUNCILS = [
  "antrim and newtownabbey",
  "ards and north down",
  "armagh city, banbridge and craigavon",
  "belfast",
  "causeway coast and glens",
  "derry city and strabane",
  "fermanagh and omagh",
  "lisburn and castlereagh",
  "mid and east antrim",
  "mid ulster",
  "newry, mourne and down",
];

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

async function main(): Promise<void> {
  const base = (process.env.FSA_API_BASE ?? "https://api.ratings.food.gov.uk").replace(/\/+$/, "");
  const showAll = arg("all") !== undefined;
  const region = arg("region") ?? (showAll ? null : "Northern Ireland");
  const niMode = region !== null && norm(region) === "northern ireland";

  // The FULL endpoint — `/Authorities/basic` does not carry RegionName.
  const res = await fetch(`${base}/Authorities`, {
    headers: { "x-api-version": "2", accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`FSA /Authorities returned HTTP ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { authorities?: FsaAuthority[] };
  const all = Array.isArray(body.authorities) ? body.authorities : [];
  if (all.length === 0) throw new Error("FSA /Authorities returned no authorities.");

  const match = (a: FsaAuthority) => {
    if (region == null) return true;
    if (norm(a.RegionName) === norm(region)) return true;
    // NI fallback: the council name itself, independent of how the registry labels the region.
    return niMode && NI_COUNCILS.some((c) => norm(a.Name).startsWith(c));
  };
  const rows = all
    .filter(match)
    .sort((a, b) => (a.RegionName ?? "").localeCompare(b.RegionName ?? "") || a.Name.localeCompare(b.Name));

  if (rows.length === 0) {
    const regions = Array.from(new Set(all.map((a) => a.RegionName ?? "(none)"))).sort();
    console.log(`No authorities matched region ${JSON.stringify(region)}.`);
    console.log(`Regions the registry reports: ${regions.join(" · ")}`);
    console.log("Re-run with --all to list every authority, or --region=<one of the above>.");
    return;
  }
  if (niMode && rows.length !== NI_COUNCILS.length) {
    console.log(`⚠ expected ${NI_COUNCILS.length} NI councils, matched ${rows.length} — check the list below.\n`);
  }

  console.log(`FSA authorities${region ? ` in ${region}` : " (all regions)"} — ${rows.length} of ${all.length}:\n`);
  let lastRegion = "";
  for (const a of rows) {
    if (showAll && a.RegionName !== lastRegion) {
      lastRegion = a.RegionName ?? "";
      console.log(`\n[${lastRegion || "—"}]`);
    }
    console.log(`  ${String(a.LocalAuthorityId).padStart(4)}  ${a.Name}`);
  }

  if (region) {
    const ids = rows.map((a) => a.LocalAuthorityId).join(",");
    console.log(`\nFSA_NI_AUTHORITY_IDS (for ${JSON.stringify(region)}):\n${ids}`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

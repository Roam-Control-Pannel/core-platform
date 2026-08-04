# Affiliate deals sync — cron setup

The public Deals surface reads from our own DB (`awin_deals`, `cj_deals`, `cj_advertisers`), not from
the affiliate APIs per view. Three background jobs keep those tables fresh. Each has **two equivalent
triggers** — a runnable Node script (for a Railway cron) and an internal HTTP route (for any
server-to-server scheduler) — so pick one per job; don't run both.

| Job | Node script | Internal route | What it does |
| --- | --- | --- | --- |
| Awin offers | `pnpm --filter @roam/api sync-awin-offers` | `POST /jobs/sync-awin-offers` | Ingest Awin promotions → `awin_deals` |
| CJ offers | `pnpm --filter @roam/api sync-cj-offers` | `POST /jobs/sync-cj-offers` | Ingest CJ Link Search deals → `cj_deals` |
| **CJ logos** | `pnpm --filter @roam/api sync-cj-logos` | `POST /jobs/sync-cj-logos` | Look up each CJ advertiser's brand logo → `cj_advertisers` |

All three are **best-effort and idempotent** (upsert-by-key; an empty/failed pull leaves existing rows
untouched, never blanks the surface). Each is **dormant** until its network's env vars are set — the
route answers `unconfigured` (HTTP 200) and the script refuses to run — so scheduling them before the
network is provisioned is harmless.

---

## Ordering constraint (why the logo sync runs *after* the CJ offers sync)

`sync-cj-logos` looks up logos only for the advertisers that currently appear in `cj_deals` (the
merchants we actually render). So it must run **after** `sync-cj-offers` has populated that table.
Schedule it a little later in the day — a fresh advertiser gets its logo on the *next* logo run, and
until then its card simply shows the category-icon fallback (zero regression).

Logos change rarely, so the logo sync can run far less often than the offers syncs (daily is generous;
even weekly is fine).

---

## Railway cron setup

Each job runs as its own **service** on the same repo/image, with a cron schedule and a start command.
This is the established pattern — the birthday delivery job (`pnpm deliver-birthdays`) runs the same way
(see migration `0055`).

> **Gotcha — the root `railway.json` pins the start command.** The repo's `railway.json` sets
> `deploy.startCommand` to `pnpm --filter @roam/api start` (the long-running API), and **config-as-code
> overrides the dashboard on every deploy**. So a cron service that reads the default `railway.json`
> would ignore whatever start command you type in the dashboard and just run a second copy of the API.
> To give a cron its own command + schedule, point the service at its **own config file** (below).

For each job, add a config file at the repo root and point the service's **Settings → Config-as-code →
Railway Config File** at it. The CJ logo cron ships one already — **`railway.cron-cj-logos.json`**:

```json
{
  "$schema": "https://railway.app/railway.schema.json",
  "build":  { "builder": "DOCKERFILE" },
  "deploy": {
    "startCommand": "pnpm --filter @roam/api sync-cj-logos",
    "cronSchedule": "45 5 * * *",
    "restartPolicyType": "NEVER"
  }
}
```

Steps in the Railway dashboard for the `deals-cj-logos` service:

1. **New service → GitHub Repo → `Roam-Control-Pannel/core-platform`**, branch `main`.
2. **Settings → Config-as-code → Railway Config File → Add File Path →** `railway.cron-cj-logos.json`.
   The start command (`sync-cj-logos`) and schedule (`45 5 * * *`, after the CJ offers sync) now come
   from that file — nothing to type in the dashboard.
3. **Variables →** reference the API service's `CJ_API_TOKEN`, `CJ_WEBSITE_ID`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY` (secrets live in env, never in the config file).
4. **Deploy.** Use **⋯ → Redeploy** to run it once now instead of waiting for 05:45; watch the logs.

The other two syncs (`deals-awin-offers`, `deals-cj-offers`) follow the same recipe — give each its own
`railway.cron-*.json` with the schedule + start command below. The only hard rule is **`deals-cj-logos`
fires after `deals-cj-offers` finishes**.

| Cron service | Schedule (UTC) | Start command |
| --- | --- | --- |
| `deals-awin-offers` | `0 5 * * *` (05:00 daily) | `pnpm --filter @roam/api sync-awin-offers` |
| `deals-cj-offers` | `15 5 * * *` (05:15 daily) | `pnpm --filter @roam/api sync-cj-offers` |
| `deals-cj-logos` | `45 5 * * *` (05:45 daily, **after** CJ offers) | `pnpm --filter @roam/api sync-cj-logos` |

Adjust the times to your existing cadence. Each cron service needs its own copy of the env vars
(reference them from the API service in the Variables tab — they aren't inherited automatically).

### Alternative: schedule the internal HTTP route

If you'd rather keep the long-running API service as the sole worker, POST to the route from any
scheduler using the server-to-server secret (the `x-internal-call` convention — see
`docs/ARCHITECTURE.md`). The route no-ops with `{"ok":true,...}` when unconfigured.

```bash
curl -fsS -X POST https://<api-host>/jobs/sync-cj-logos \
  -H "x-internal-call: $INTERNAL_CALL_SECRET"
# → {"ok":true,"advertisers":42,"resolved":40,"withLogos":37}
```

---

## Env vars

The CJ logo sync reuses the CJ credentials — no new secret is required:

```
CJ_API_TOKEN=<CJ personal access token>     # required (shared with the CJ offers sync)
CJ_WEBSITE_ID=<CJ website / PID>             # required (shared with the CJ offers sync)
CJ_CID=<CJ company / CID>                    # required for Advertiser Lookup — see below (NOT the PID)

# optional (default shown) — the Advertiser Lookup API lives on a different CJ host than Link Search:
CJ_ADVERTISER_LOOKUP_BASE=https://advertiser-lookup.api.cj.com
CJ_DEBUG=1                                   # logs the raw first Lookup response to confirm the logo field
```

### `CJ_CID` — the account CID, not the website PID

Advertiser Lookup authenticates against your **Company ID (CID)** via its `requestor-cid` param — a
*different* number from the **Website ID (PID)** that Link Search uses. If `CJ_CID` is unset, the sync
falls back to `CJ_WEBSITE_ID`, and if your CID and PID differ CJ rejects the call with:

```
400  User is not authorized to access this API on behalf of this CID: <the PID>
```

Fix: find your CID in the CJ dashboard (**Account → Company**, or the number shown by the CJ Developer
Portal for your account — distinct from the per-website PID) and set it as `CJ_CID`. Also confirm the
personal access token is granted access to the **Advertiser Lookup** API (Link Search access alone is
not enough). The offers sync is unaffected — it keeps using `CJ_WEBSITE_ID`.

**First run:** set `CJ_DEBUG=1` for one run and check the logged raw response. CJ's docs don't pin down
which field carries the logo, so `cj/advertisers.ts` reads it from several plausible names and stores
`null` when none is present (the card keeps its icon). If the real response shows the logo under a name
we don't yet read, add that name to the field list in `cj/advertisers.ts` and re-run — nothing else
changes.

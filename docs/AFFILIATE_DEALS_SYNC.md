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

Railway crons are configured **per service in the dashboard** (they aren't declared in `railway.json`).
For each job, add a **Cron Schedule** service on the same repo/image, with the schedule and start
command below. This is the established pattern — the birthday delivery job (`pnpm deliver-birthdays`)
runs the same way (see migration `0055`).

| Cron service | Schedule (UTC) | Start command |
| --- | --- | --- |
| `deals-awin-offers` | `0 5 * * *` (05:00 daily) | `pnpm --filter @roam/api sync-awin-offers` |
| `deals-cj-offers` | `15 5 * * *` (05:15 daily) | `pnpm --filter @roam/api sync-cj-offers` |
| `deals-cj-logos` | `45 5 * * *` (05:45 daily, **after** CJ offers) | `pnpm --filter @roam/api sync-cj-logos` |

Adjust the times to your existing cadence — the only hard rule is **`deals-cj-logos` fires after
`deals-cj-offers` finishes**. A cron service shares the API service's environment, so no extra env is
needed beyond what the sections below list.

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

# optional (default shown) — the Advertiser Lookup API lives on a different CJ host than Link Search:
CJ_ADVERTISER_LOOKUP_BASE=https://advertiser-lookup.api.cj.com
CJ_DEBUG=1                                   # logs the raw first Lookup response to confirm the logo field
```

**First run:** set `CJ_DEBUG=1` for one run and check the logged raw response. CJ's docs don't pin down
which field carries the logo, so `cj/advertisers.ts` reads it from several plausible names and stores
`null` when none is present (the card keeps its icon). If the real response shows the logo under a name
we don't yet read, add that name to the field list in `cj/advertisers.ts` and re-run — nothing else
changes.

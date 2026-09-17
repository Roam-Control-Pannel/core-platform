# Database release runbook — keeping the live schema ahead of the app

> **Why this exists.** In Sep 2026 the F2G storefront went blank for every visitor. Root cause: a
> migration (`0134`, adding `channels.nav/sections/surface`) merged to the repo and passed the CI
> `db` gate, but was **never applied to the live database** the deployed app reads. The app started
> selecting the new columns, the read threw, and the storefront silently emptied — while the data was
> perfectly healthy. The CI `db` gate only ever tests an **ephemeral local** Postgres; it cannot see
> the live DB. This runbook + the two workflows below close that gap.

## The rule
**Schema leads code.** A migration that adds something the app will read must be **applied to the
live DB _and_ its PostgREST cache reloaded** before (or atomically with) the app deploy that needs it.

## The two failure shapes (both now guarded)
- **`42703` (undefined_column):** the migration isn't applied to this project. → apply it.
- **`PGRST204` (schema cache):** the column exists in Postgres but PostgREST hasn't reloaded its
  schema cache — the classic *"I ran the SQL but it's still broken"* trap. → reload the cache.

## Release sequence (per deploy)
1. **Apply migrations to the live project** and **reload the PostgREST cache** — automated by
   `.github/workflows/db-migrate.yml` on every push to `main` (and via *Run workflow*), or manually:
   ```bash
   supabase link --project-ref <PROJECT_REF>
   supabase db push                     # applies pending migrations
   # reload PostgREST so new columns are readable immediately:
   psql "<SUPABASE_DB_URL>" -c "notify pgrst, 'reload schema';"
   # (or Supabase Dashboard → Settings → API → Reload schema)
   ```
2. **Deploy the app.** To truly enforce ordering, disable the host's auto-deploy and trigger the
   deploy only after step 1 succeeds. (Without that, Vercel/Netlify deploy on the same push in
   parallel — the drift guard below still catches a lag, but as a post-hoc alarm rather than a gate.)
3. **Verify** — `.github/workflows/schema-drift.yml` runs automatically on `main` and every 6h;
   or locally:
   ```bash
   SUPABASE_URL=... SUPABASE_ANON_KEY=... pnpm db:drift-check
   ```
   Green = the live DB serves every read the app requires. Red = drift; go back to step 1.

## Out-of-band migrations & the migration ledger
This project's `supabase_migrations.schema_migrations` ledger has under-reported reality (it read
`0017` while the schema was far past it) because migrations were applied out-of-band (direct SQL /
`db push` / dumps). Consequences and fixes:
- The **drift guard is ledger-independent by design** — it probes what the app actually reads
  (`scripts/check-schema-drift.mjs`), not the ledger, so it stays correct regardless.
- Reconcile the ledger once with `supabase migration repair` so `supabase db push` behaves normally
  going forward.
- The repo's migrations are written idempotently (`add column if not exists`, guarded constraints,
  `update … where`), so re-applying is safe even when the ledger disagrees.

## Configuration (repo/deploy secrets)
| Secret | Used by | Purpose |
|---|---|---|
| `SUPABASE_ACCESS_TOKEN` | db-migrate | CLI auth |
| `SUPABASE_PROJECT_REF` | db-migrate | target project |
| `SUPABASE_DB_PASSWORD` | db-migrate | `db push` |
| `SUPABASE_DB_URL` | db-migrate | deterministic `notify pgrst` cache reload (optional) |
| `SUPABASE_URL` | schema-drift | live PostgREST endpoint to probe |
| `SUPABASE_ANON_KEY` | schema-drift | anon key for the probe (public-read only) |

Both workflows **no-op when their secrets are unset**, so they never break a fork PR or an
unconfigured checkout. Add the secrets to activate.

## Extending the guard
When a future migration adds a column the app will read, add it to `REQUIRED_READS` in
`scripts/check-schema-drift.mjs`. That list is the living contract between app code and live schema —
if the app depends on it, the guard should assert it. Since holistic plan Phase 1.6 the guard covers
every channels-era table the app reads (channels, channel_domains, venue_channels, channel_members,
external_refs, orgs, fsa_establishments, job_posts, orders) **and** the RPCs it calls (`RPC_PROBES`):
- `PGRST202` on an RPC = the function or **that exact signature** is not applied (or the cache is
  stale) — the third drift shape, e.g. the 5-arg `venues_food_to_go_near` from 0145.
- A service-only RPC (`order_channel_for_venue`, `claim_places_detail_quota`) is probed as anon and
  must answer `42501 permission denied`. A 2xx there is reported as a **hardening regression** (the
  0149/0151 revoke is not in force) and fails the run.
When a migration adds an RPC the app calls, add a probe with the exact argument names the app sends,
and `expect: "ok"` (client-callable) or `expect: "denied"` (service-only).

## Silent skips are visible
Both workflows no-op without their secrets. The drift script now emits a GitHub Actions `::warning::`
annotation on a skipped CI run, so "green because unconfigured" shows on the run summary instead of
passing for green. Until the secrets in the table above are set, every run of `schema-drift.yml` and
`db-migrate.yml` is a skip — treat a warning there as an action item, not noise.

## Capturing live-only objects (the `venue-media` storage policies)
Migration `0021` is missing from the repo; the `venue-media` bucket's **write** policies exist only in
the live project (0076 dropped its public *read* policy, which is all the repo knows about). A rebuild
from migrations (what the CI `db` gate does on every run) produces a bucket with no upload policy.
Before authoring the migration that reproduces them, read the live definitions verbatim — never guess:
```sql
-- 1. the bucket itself
select id, name, public, file_size_limit, allowed_mime_types, created_at
  from storage.buckets where id = 'venue-media';

-- 2. every storage.objects policy that mentions the bucket (qual = USING, with_check = WITH CHECK)
select policyname, cmd, permissive, roles, qual, with_check
  from pg_policies
 where schemaname = 'storage' and tablename = 'objects'
   and (coalesce(qual, '') ilike '%venue-media%' or coalesce(with_check, '') ilike '%venue-media%')
 order by policyname;
```
Paste the two result sets into the PR that adds `supabase/migrations/NNNN_venue_media_storage.sql`;
the migration must recreate each policy with `drop policy if exists` + `create policy` using the exact
`qual`/`with_check` text, plus a pgTAP test that an owner can insert under their venue prefix and a
stranger cannot.

## Belt-and-braces in the app
Even with this runbook, `@roam/core/channels` degrades gracefully if a channel-config column is
briefly unreadable (missing column or stale cache): it retries on the base column set so the app
stays **working (unbranded/default)** rather than blank. That is a safety net, **not** a substitute
for this runbook — always apply + reload + verify.

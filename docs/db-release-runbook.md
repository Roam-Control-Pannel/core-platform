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

## The guard must run as anon
`SUPABASE_ANON_KEY` must be the project's **anon (public)** key — never the service-role key. The
service-only probes are only meaningful as anon; a service key bypasses every grant and reports each
service-only function as client-callable (the first live run, 2026-09-17, did exactly that). The
script now refuses to run with a non-anon key: it decodes the key's role claim (legacy JWT `role`,
or the `sb_publishable_` / `sb_secret_` prefix) and, independently, reads `places_fetch_quota`,
which 0130 revoked from anon — a 2xx there means elevated privileges, and the run aborts.

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
Done for the policies in `0152_venue_media_storage.sql` (read 2026-09-17; verbatim `qual`/`with_check`;
pgTAP test covers owner/stranger/anon/wrong-venue). One deliberate addition: an **owner-scoped**
SELECT policy, because Postgres filters the rows an UPDATE/DELETE reads through its WHERE clause by
the SELECT policies — with 0076's public-read drop in force, the owner update/delete policies matched
nothing (the test caught it). The public still cannot list the bucket. The bucket's live limits (10 MB; jpeg/png/webp) were read
afterwards and recorded in `0153`, which also gives profile-media the same owner-scoped read and
re-asserts 0076's drop of its public listing policy (also still present live).

**Reading results in the Supabase SQL editor:** it shows only the LAST statement's result set. Run
probe queries one at a time, or the earlier results are silently not displayed.

The same read also showed `venue_media_read_public` still present on the live project although 0076
dropped it. That means **0076 did not reach the project** (or only partly). Verify the rest of 0076
with:
```sql
-- both should be false if 0076's revokes are in force
select has_function_privilege('anon', 'public.claim_places_fetch_quota(text,integer,integer,integer)', 'execute') as anon_fetch_quota,
       has_function_privilege('authenticated', 'public.upsert_place_venues(jsonb)', 'execute')          as auth_upsert_places;
-- should be 0 rows if 0076 §6 ran
select policyname from pg_policies where schemaname = 'storage' and tablename = 'objects'
  and policyname in ('profile_media_public_read', 'venue_media_read_public');
```
If either function answers `true`, re-run `supabase/migrations/0076_security_hardening.sql` in full
(it is idempotent) and reload the schema cache.

## Live parity audit (how the 2026-09-17 audit was done, and how to repeat it)
The ledger cannot be trusted, so parity is proved object by object. Build the **intended** state
locally (every migration applied to a Supabase-shaped Postgres), run the same queries on both sides,
and diff. Run each query on its own in the SQL editor — it shows only the LAST statement's result and
caps at ~100 rows, so split large lists by name range.

| Object | Query (both sides) | What a diff means |
|---|---|---|
| Function existence + grants | `pg_proc` × `has_function_privilege('anon'/'authenticated', oid, 'execute')`, excluding extension functions and trigger returns | missing signature = unapplied migration; grant `true` where intended `false` = a `revoke` never landed (0076 was found this way) |
| Policy names + commands + roles | `pg_policies` for `public`/`storage` | missing policy = unapplied migration |
| Table column counts | `information_schema.columns` grouped by table | count differs = an `add column` never landed |
| Triggers | `pg_trigger where not tgisinternal` | missing trigger = unapplied migration (0130/0131 were found this way) |
| RLS flags | `pg_class.relrowsecurity/relforcerowsecurity` | `false` where intended `true` |
| Policy definitions | `md5(coalesce(qual,'') \|\| '#' \|\| coalesce(with_check,''))` | body differs |
| Function bodies | `md5(pg_get_functiondef(oid))` with `/* */` and `--` comments stripped and **all whitespace removed** | body differs. Do NOT compare raw text: SQL pasted from chat is comment-stripped and reflowed, so raw hashes differ while code is identical |

Findings on 2026-09-17: 0076, 0111, 0112, 0130, 0131, 0132, 0133 had never been applied to the
project (recovered the same day); everything else matched once formatting was ignored. The fifteen
formatting-only function bodies are made byte-identical by
`scripts/db-reconcile-functions-2026-09-17.sql` (cosmetic; keeps grants).

## Belt-and-braces in the app
Even with this runbook, `@roam/core/channels` degrades gracefully if a channel-config column is
briefly unreadable (missing column or stale cache): it retries on the base column set so the app
stays **working (unbranded/default)** rather than blank. That is a safety net, **not** a substitute
for this runbook — always apply + reload + verify.

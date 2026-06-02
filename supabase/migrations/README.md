# Data model — migrations

SQL-first, RLS-enforced. The database is the single source of truth.
**Validated:** all four migrations apply clean against PostgreSQL 16 + PostGIS 3.4, every
Roam table has RLS enabled, dormant seam flags are off, the refund path exists, and venue
proximity uses a spatial GiST index (global by construction).

## Apply order

| File | What it lays down |
|---|---|
| `0001_foundation.sql` | Extensions (pgcrypto, **postgis**, pg_trgm), enums, `feature_flags`, `profiles`, `venues` (claimed + unclaimed, global geo). |
| `0002_social_and_content.sql` | Follows, friendships, plans + members + venues, chat threads/participants/messages, **the meet-up loop** (meetups, options, votes, locations), posts (multi-destination), offers + saves + redemptions, push-credit ledger. |
| `0003_billing_trust_and_dormant_seams.sql` | Billing customers + transactions (**`charge.refunded` path — the DDS gap, closed**), notifications, push subscriptions, moderation queue, user blocks, and the **dormant Stage-5 seams** (shop, trips, automation). |
| `0004_rls.sql` | Row-Level Security on every table + helper functions (`current_profile`, `are_friends`, `in_thread`). |

## The two ideas the schema is built to protect

**Global from day one.** No region-shaped columns. `country_code` is for display/grouping only —
it never gates access. Proximity is `geography(Point,4326)` with a GiST index, so near→far
sorting works anywhere on Earth. Unclaimed venues (Google Places base) are world-readable so the
median global launch experience — browsing places with no owner and no friends yet — is
graceful, not broken.

**No migration to light up v2.** The marketplace, travel, and automation tables exist now as
dormant, RLS-enabled, flag-gated structures. Subscription tiers `free`/`premium`/`gold` all exist;
only `free` is wired to live checkout (`feature_flags.billing.paid_tiers = false`). Turning any of
these on later is a flag flip plus (where needed) a policy addition — never a schema rewrite.

## Local validation (how the check above was run)

Supabase provides `auth.uid()` and the `auth` schema in the real platform. To validate migrations
against a bare Postgres locally, shim them first:

```sql
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key default gen_random_uuid());
create or replace function auth.uid() returns uuid language sql stable
  as $$ select '00000000-0000-0000-0000-000000000000'::uuid $$;
```

Then apply `000*.sql` in order with `psql -v ON_ERROR_STOP=1`. On the real project use
`pnpm db:migrate` (Supabase CLI) and regenerate types with `pnpm db:types`.

## What's NOT here yet (next foundation drop)

- `packages/db` TypeScript client + generated types wiring.
- `packages/core` domain logic + `packages/api` tRPC routers.
- `packages/design` tokens.
- The moderation automated first-pass (Edge Function) and Stripe webhook handler
  (incl. the `charge.refunded` writer that fills `refunded_pence`).
- App scaffolds (web / console / native) and `.env.example`.

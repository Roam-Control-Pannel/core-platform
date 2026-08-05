# Roam HQ — the super-admin dashboard

Roam HQ (`apps/admin`) is the internal, **staff-only** dashboard: one pane of glass over
site-wide activity (signups, content, social, trust & safety), plus the core moderation
and venue-claim actions — every privileged read and write done as a named staff member
and recorded in an audit trail.

It is a separate Next app from the consumer web app (`apps/web`) and the business console
(`apps/console`), but shares the same data layer: the `@roam/design` system, the
Supabase + tRPC wiring, and the `@roam/api` router. The dangerous service-role key **never**
enters the browser bundle — HQ reaches privileged data only through the API's
`adminProcedure`, which verifies staff membership and then escalates server-side.

---

## How access works

There is no self-serve sign-up for HQ. Access is a **plain invite list**: a row in the
`admin_users` table (migration `0113`). Two gates run in order:

1. **Sign in** — staff authenticate on the HQ origin with a Supabase magic link.
2. **Staff check** — the API's `adminProcedure` reads the caller's own `admin_users` row
   (via RLS self-read) and refuses anyone without one (`FORBIDDEN` → "not authorised").

Each member has a **role**:

| role     | can observe | can act (ban/suspend/resolve/claims) | can grant membership |
|----------|:-----------:|:------------------------------------:|:--------------------:|
| `viewer` | ✅          | —                                    | —                    |
| `admin`  | ✅          | ✅                                   | —                    |
| `owner`  | ✅          | ✅                                   | ✅                   |

### Granting / revoking staff

Membership is service-role-only (users cannot write `admin_users`). Grant from the Supabase
SQL editor:

```sql
-- Add a member (look them up by email; profiles.id == auth.users.id)
insert into admin_users (id, role, note)
select u.id, 'admin', 'Ops — added 2026-08'
from auth.users u
where lower(u.email) = 'person@roam-everywhere.com'
on conflict (id) do update set role = excluded.role;

-- Revoke
delete from admin_users where id = (
  select id from auth.users where lower(email) = 'person@roam-everywhere.com'
);
```

The founder (`andrew@roam-everywhere.com`) is seeded as the first `owner` by migration
`0114`. If they hadn't signed up when the migration ran, re-run it (it's idempotent) or
grant manually after their first sign-in.

---

## Migrations

Roam HQ adds two additive migrations — apply them like any other (`pnpm db:migrate`):

- `0113_admin_users.sql` — the `admin_users` allowlist + the `admin_audit_log` table.
- `0114_seed_admin_owner.sql` — seeds the founder as the first owner.

After applying, regenerate DB types with `pnpm db:types` (the CI/dev typecheck already
carries hand-added entries for the two new tables, so this only re-syncs the source of
truth against the live project).

---

## Deploying (Vercel)

HQ is deployed exactly like `apps/web` / `apps/console` — a Vercel **project per app**,
pointed at this monorepo with the app as its root directory.

1. **Create a Vercel project** from the repo.
   - **Root Directory:** `apps/admin`
   - **Framework preset:** Next.js
   - **Build command / install:** the defaults (the app's `prebuild` runs
     `scripts/sync-env.mjs`, which materialises `.env.local` with only the
     `NEXT_PUBLIC_*` vars — server secrets are never copied into the bundle).
2. **Environment variables** (Project → Settings → Environment Variables) — the same
   `NEXT_PUBLIC_*` set the other Next apps use:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `NEXT_PUBLIC_API_URL` — the origin of the standalone API service (HQ appends `/trpc`).
   - HQ needs **no** service-role key and **no** server secrets. That is the point.
3. **Give it a hostname**, e.g. `https://hq.roam-local.com`. Keep it private (the app
   already sends `noindex`).
4. **Allow the origin through the API's CORS list.** On the API service, set
   `CORS_ALLOWED_ORIGINS` to include the HQ origin (see `.env.example`), otherwise the
   browser blocks HQ's tRPC calls:
   ```
   CORS_ALLOWED_ORIGINS=https://roam-local.com,https://business.roam-local.com,https://hq.roam-local.com
   ```
5. **Supabase Auth redirect** — add the HQ origin to the Supabase Auth allowed redirect
   URLs so the magic-link callback lands back on HQ (`https://hq.roam-local.com`).

Local dev: `pnpm --filter @roam/admin dev` serves HQ on **:3002** (already in the API's
dev CORS default).

---

## What's on the dashboard

**Observe (all roles):**
- **Pulse** — members, new 24h/7d/30d, venues, claimed, recent content.
- **Growth** — a 30-day signup sparkline + all-time content & social breakdown.
- **Live activity** — a merged, newest-first stream of signups, wall posts, Forum
  topics & replies, follows, events and venue claims (auto-refreshes every 60s).
- **Trust & safety** — the open moderation queue (auto-flags + user reports).
- **Lookup** — search users & venues with an inline drill-in detail.

**Act (`admin` / `owner`):**
- Resolve a moderation report (keep / action & close).
- Ban / un-ban a user.
- Suspend / restore a venue; approve / reject a pending venue claim.
- Every action is attributed and shown in the **Audit trail** panel.

---

## Architecture notes

- **`adminProcedure`** (`packages/api/src/trpc.ts`) is the one seam that turns a staff JWT
  into a service-role client. It checks `admin_users` under the caller's own client first,
  so no privileged key is needed merely to answer "are you staff?".
- **`@roam/core/admin`** holds the framework-agnostic aggregations and actions; the
  `adminMetrics` / `adminActivity` / `adminSearch` / `adminActions` routers are thin,
  role-gated wrappers.
- **The DB has no rollups** — every metric is computed live from the normalised tables.
  If HQ traffic ever makes that expensive, the next step is a materialised view or a
  periodic rollup table; the core module is where that swap would land.
- **"The Forum"** is still `town_hall_*` in the database (the rename was UI-only); HQ
  labels it "Forum" while querying those tables.

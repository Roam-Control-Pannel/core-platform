# B1 — membership spine: `channel_members` + `orgs` (implementation-depth plan)

> **This is a plan, not a change.** No migrations, tables, or code are written until it's approved.
> Companion to [`f2g-association-build-plan.md`](./f2g-association-build-plan.md). Grounded against
> `main` (highest migration **0134**); migration numbers below are **indicative** — assign the next
> free number at build time.
>
> **Scope of B1:** the two roster/directory tables, their integrity and RLS, the pure `core` logic,
> and pgTAP. **B1 ships dormant and backend-only** — no user-facing tRPC, no UI — exactly as `0116`
> shipped the channel seam dormant. Reads/writes that expose this data to users arrive in the slices
> that own them (import = B3, match review = B4, directory = C2, supplier self-serve = C3).

---

## 0. Why B1 is buildable now

Every input B1 needs is decided: suppliers are `orgs` (#2), admin is staff-operated (#7), commercial
model is free-for-members (#9, no billing column needed). B1 does **not** depend on the roster CSV —
that gates *tuning B2* and *running B3*, not the table shapes. So B1 is the correct next build.

---

## 1. The pivotal RLS decision: `channel_members` is service-role-only

`channel_members` is the **roster of record** and it holds **PII** — verbatim source contact names and
**emails** (no email → no invite, decision #1). Therefore:

- **No `anon`/`authenticated` policy is created for `channel_members`.** With RLS enabled and no
  permissive policy, PostgREST denies all direct client SELECT/INSERT/UPDATE/DELETE by omission — the
  same deny-by-omission `channels` uses for writes (`0116:87-91`). Only `service_role` and
  `SECURITY DEFINER` functions reach the table.
- **All public exposure is a projection, never the table.** The member *directory* (C2) reads through
  a definer RPC (`channel_members_search`) that returns **only safe columns** (display name, category,
  locality, status badge, matched `venue_id`) — **never** `source_email` or raw contact fields. The
  unclaimed member page (B3) reads the same safe projection. This keeps PII server-side by construction:
  there is no client-reachable path to the email column at all.
- A **`0131`-style column-scope trigger** additionally guards the table against a future accidental
  client-role grant (defence in depth): if `current_user in ('authenticated','anon')` it raises. Since
  no client policy exists, this should never fire — it is a tripwire, asserted by pgTAP.

This is the single most important design point in B1. It is also *why B1 exposes no tRPC*: there is no
correct client read of this table until the safe-projection RPC (C2) exists.

---

## 2. Migration — `channel_members` (indicative `0135_channel_members.sql`)

### 2.1 Table

```sql
create table if not exists channel_members (
  id             uuid primary key default gen_random_uuid(),
  channel_id     uuid not null references channels(id) on delete cascade,

  -- Verbatim roster-of-record fields, exactly as the Association's source gave them. Never
  -- overwritten by matching/backfill — the audit trail of what we were told.
  source_name        text not null check (char_length(source_name) between 1 and 200),
  source_address     text,
  source_postcode    text,                       -- match block key (normalised at read/match time)
  source_email       text,                       -- PII; invite target. Never client-readable.
  source_phone       text,
  source_council     text,                       -- NI council area, for the onboarding dashboard
  source_raw         jsonb not null default '{}'::jsonb,  -- the untouched CSV row

  -- Idempotency: a stable per-source key so re-importing the roster updates rather than duplicates.
  -- (channel_id, membership_ref) is unique — see index below.
  membership_ref     text not null check (char_length(membership_ref) between 1 and 200),

  -- The match result (filled by B2/B3; null until matched). No FK cascade surprise: a deleted venue
  -- nulls the link, it does not delete the roster row.
  venue_id           uuid references venues(id) on delete set null,

  -- Who claimed it, once claimed (B3). Null until then.
  claimed_by         uuid references profiles(id) on delete set null,

  -- Status machine (see §4 for the allowed transitions). Enforced by check + a trigger.
  status         text not null default 'imported'
                   check (status in ('imported','invited','claimed','live','lapsed','removed')),

  invited_at     timestamptz,
  claimed_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Idempotent re-import key.
create unique index if not exists channel_members_ref_uq
  on channel_members (channel_id, membership_ref);
-- Dashboard/admin browse and the match join.
create index if not exists channel_members_status_idx  on channel_members (channel_id, status);
create index if not exists channel_members_venue_idx    on channel_members (venue_id);
create index if not exists channel_members_postcode_idx  on channel_members (source_postcode);
```

### 2.2 RLS — deny-by-omission + tripwire trigger

```sql
alter table channel_members enable row level security;
-- NO anon/authenticated policy: deny-by-omission for every direct client operation.
-- service_role and SECURITY DEFINER functions bypass RLS and are the only writers/readers.

create or replace function public.channel_members_guard_client_roles()
  returns trigger language plpgsql security invoker
  set search_path = public, pg_temp
as $$
begin
  -- Defence in depth: even if a client policy is ever added by mistake, a client role can never
  -- write this PII-bearing roster table. Definer/service writes (current_user = the function owner
  -- or 'service_role') pass untouched.
  if current_user in ('authenticated', 'anon') then
    raise exception 'channel_members is service-managed and not client-writable'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists channel_members_guard on channel_members;
create trigger channel_members_guard
  before insert or update or delete on channel_members
  for each row execute function public.channel_members_guard_client_roles();

drop trigger if exists channel_members_updated_at on channel_members;
create trigger channel_members_updated_at
  before update on channel_members
  for each row execute function set_updated_at();
```

> **Note on `set_updated_at`/BEFORE-trigger ordering:** `set_updated_at` already exists and is used by
> `market_listings` (`0072:46`). The guard trigger raises before any row mutation, so ordering with
> `updated_at` is immaterial (a raise aborts the statement).

---

## 3. Migration — `orgs` (indicative `0136_orgs.sql`)

Modelled on `market_listings` (`0072`), with the review-hardened live-or-own read (`0125`), a column
guard (`0131`), and a slug definer (`0044`). **B1 creates the table + read/owner-write + slug + guard.
The client self-serve INSERT policy is deliberately NOT in B1 — it is C3's tightest-scrutiny change.**

### 3.1 Table

```sql
create table if not exists orgs (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid references profiles(id) on delete set null,  -- null until claimed/created
  name         text not null check (char_length(name) between 2 and 200),
  slug         text not null unique,
  description  text check (char_length(description) <= 4000),
  category     text not null default 'supplier',
  -- Contact/presentation — non-PII, world-readable when live.
  website      text,
  locality     text,
  logo_url     text,
  links        jsonb not null default '[]'::jsonb,
  -- Lifecycle + moderation. Moderation is a HARD gate (ARCHITECTURE.md): only 'approved' live orgs
  -- are world-readable. Mirrors the venues moderation enum (0001:31).
  status       text not null default 'draft'  check (status in ('draft','live','removed')),
  moderation   text not null default 'pending' check (moderation in ('pending','auto_approved','approved','rejected')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists orgs_browse_idx on orgs (status, moderation, created_at desc);
create index if not exists orgs_owner_idx   on orgs (owner_id, created_at desc);
```

### 3.2 Slug definer (revoked from client roles — the existence-oracle lesson)

```sql
create or replace function gen_unique_org_slug(p_name text, p_locality text)
returns text language plpgsql security definer set search_path = public
as $$ /* same shape as gen_unique_venue_slug (0044:16): slugify name (+locality), smallest suffix */ $$;

-- A definer slug generator is an existence oracle over orgs. Revoke from client roles so it is only
-- ever called from the BEFORE INSERT trigger / service paths — NOT directly from PostgREST.
revoke execute on function gen_unique_org_slug(text, text) from public, anon, authenticated;

create or replace function set_org_slug() returns trigger
  language plpgsql security definer set search_path = public
as $$ begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := gen_unique_org_slug(new.name, new.locality);
  end if; return new;
end $$;

drop trigger if exists trg_orgs_slug on orgs;
create trigger trg_orgs_slug before insert on orgs
  for each row execute function set_org_slug();
```

### 3.3 RLS — live-or-own read, owner write, column guard

```sql
alter table orgs enable row level security;

-- Public sees only APPROVED + LIVE orgs; an owner always sees their own (any status) — the 0125
-- two-policy pattern (permissive policies OR-combine).
drop policy if exists orgs_read on orgs;
create policy orgs_read on orgs for select
  using (status = 'live' and moderation in ('auto_approved','approved'));
drop policy if exists orgs_read_own on orgs;
create policy orgs_read_own on orgs for select
  using (owner_id = auth.uid());

-- An owner may UPDATE their own org (presentational fields only — see the column guard). No INSERT
-- policy here: creating an org is C3's audited self-serve path. No DELETE (soft-delete via status).
drop policy if exists orgs_owner_update on orgs;
create policy orgs_owner_update on orgs for update
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Column guard (0131 diff-and-raise): an owner may edit only presentational columns; status,
-- moderation, owner_id, slug are server/definer-managed.
create or replace function public.orgs_guard_owner_columns()
  returns trigger language plpgsql security invoker set search_path = public, pg_temp
as $$ begin
  if current_user in ('authenticated','anon') then
    if (to_jsonb(new) - '{name,description,website,locality,logo_url,links,updated_at}'::text[])
       is distinct from
       (to_jsonb(old) - '{name,description,website,locality,logo_url,links,updated_at}'::text[]) then
      raise exception 'orgs: an owner may only edit presentational fields'
        using errcode = '42501';
    end if;
  end if; return new;
end $$;

drop trigger if exists orgs_guard_owner_columns on orgs;
create trigger orgs_guard_owner_columns before update on orgs
  for each row execute function public.orgs_guard_owner_columns();

drop trigger if exists orgs_updated_at on orgs;
create trigger orgs_updated_at before update on orgs
  for each row execute function set_updated_at();
```

> **Moderation gate is real:** `orgs_read` requires `moderation in ('auto_approved','approved')`, so a
> `draft`/`pending` org (the state C3's client INSERT will create) is invisible to the public until
> staff approve it — matching the venues/reviews moderation posture.

---

## 4. Core module — `packages/core/src/membership/` (pure, unit-tested)

By `ARCHITECTURE.md`, the rules live in `core` once. B1 adds the **pure** half; DB-thin wrappers that
the import job (B3) and admin (B4) call are added in those slices (kept minimal here to avoid dead code).

```
packages/core/src/membership/
  index.ts          # types + the pure state machine and normalisers
  index.test.ts     # exhaustive transition table + normaliser fixtures
```

- `export type MemberStatus = 'imported'|'invited'|'claimed'|'live'|'lapsed'|'removed'`.
- **`canTransition(from, to): boolean`** — the single source of truth for the status machine. Allowed
  edges (fail-closed — anything not listed is rejected):

  | from | → allowed to |
  |---|---|
  | `imported` | `invited`, `removed` |
  | `invited` | `claimed`, `lapsed`, `removed` (re-invite: `invited`→`invited` allowed) |
  | `claimed` | `live`, `removed` |
  | `live` | `lapsed`, `removed` |
  | `lapsed` | `invited`, `live`, `removed` |
  | `removed` | *(terminal)* |

- **`normaliseMembershipRef(raw): string`** — trims/upper-cases so re-imports are idempotent against
  `channel_members_ref_uq`.
- **`normalisePostcode(raw): string`** — NI/UK postcode normalisation (uppercase, single internal
  space, handles outward-only codes). *Shared with B2's matcher* — defined here so both use one rule.
- Wire `export * as membership from "./membership/index.js"` into `packages/core/src/index.ts`
  (alongside `channels`, `f2g`, `markets` — `index.ts:14-42`).

A small **`orgs/` pure helper** (`slugifyOrgName`, status/moderation predicates) mirrors the SQL slug
rule so web/native render identically; add the lockstep assertion to the mirror test (D11, A1a).

**No web mirror churn in B1** beyond the D11 mirror test entry — the web has no B1 UI yet.

---

## 5. pgTAP — `supabase/tests/0135_channel_members_test.sql`, `0136_orgs_test.sql`

The `db` gate replays all migrations then runs pgTAP. B1's suite must assert:

**`channel_members`:**
1. Table + every column/type/NOT NULL; the `status` check accepts the 6 values and rejects a 7th.
2. `channel_members_ref_uq` is unique on `(channel_id, membership_ref)` (insert-twice as service_role → 2nd raises).
3. **RLS deny-by-omission:** as `authenticated`, SELECT returns 0 rows and INSERT/UPDATE/DELETE raise (`42501` / insufficient privilege). As `anon`, likewise.
4. **Guard tripwire:** simulate a client-role write path → raises `42501`.
5. `venue_id` / `claimed_by` FK `on delete set null` (delete the venue → row survives, link nulled).

**`orgs`:**
6. Table + columns; `status`/`moderation` checks reject bad values.
7. **`orgs_read` moderation gate:** a `draft`/`pending` org is invisible to `anon`; flipping to
   `live`+`approved` (as service_role) makes it visible.
8. **`orgs_read_own`:** the owner sees their own `draft` org; a different `authenticated` user does not.
9. **No client INSERT** (B1): as `authenticated`, INSERT into `orgs` raises (no policy) — the C3
   self-serve path is a *later* migration; this test locks that B1 didn't open it early.
10. **Column guard:** owner UPDATE of `description` succeeds; owner UPDATE of `status`/`moderation`/
    `owner_id`/`slug` raises `42501`.
11. **Slug:** two orgs with the same name get distinct slugs; `gen_unique_org_slug` EXECUTE is **revoked**
    from `anon`/`authenticated` (calling it as those roles raises).

Unit (vitest, `check` gate): `membership/index.test.ts` — the full transition matrix (every
from×to, allowed and rejected), and the normaliser fixtures (postcode edge cases, ref idempotency).

---

## 6. Done-checks, risk, sequencing

**Done-checks**
- `supabase db reset` + pgTAP green locally and in the `db` gate (all assertions in §5).
- `check` green: `membership` unit tests pass; mirror lockstep test extended for the org-slug rule.
- `grep`: no client-reachable read of `channel_members` exists (no tRPC/RPC added in B1).

**Risk: LOW.** B1 is additive (new tables, no mutation of `venues`/`orders`/`channels`), ships no
user-facing surface, and creates **no client write path** to either table (orgs read + owner-update
only; channel_members service-role-only). The two high-risk paths — `orgs` client INSERT (C3) and
claim tokens (B3) — are explicitly out of B1 and carry their own mandatory security review.

**Two PRs or one?** Recommend **one PR** (`feat(membership): channel_members roster + orgs directory
foundation (F2G B1)`) — the two migrations + one core module + pgTAP are one coherent, reviewable unit,
and both are behaviour-neutral/dormant. If review prefers, split `channel_members` and `orgs` into two
PRs; they have no ordering dependency on each other.

**Migration numbers:** assign the next free at build time (indicative `0135`/`0136`); do not hardcode
in advance — `main` has moved under this plan before.

---

## 7. What B1 deliberately does NOT do (guards against scope creep)

- No import job, CSV parsing, or Places backfill — **B3**.
- No matching / `external_refs` — **B2**.
- No `orgs` client INSERT / supplier self-serve — **C3** (mandatory security review).
- No claim tokens — **B3** (mandatory security review).
- No directory search RPC / member pages / web UI — **C2 / B3**.
- No admin views — **B4**.
- No `membership_mode` flip — Association decision (#4).

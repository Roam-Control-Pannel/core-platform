-- 0136_orgs.sql
--
-- Food to Go · Phase B · Slice B1b — the ORGS directory entity (suppliers, not venues).
--
-- The Association's suppliers are NOT venues (decision #2, docs/f2g-association-build-plan.md §2):
--   - every venue read path (Explore, venues_near, sitemap, discover/[town]) is world-readable and
--     PROXIMITY-ORDERED, so a supplier sitting in `venues` is a product bug (it surfaces on the map);
--   - there is no `venues` INSERT policy to reuse, and the `owner_id is null` Places-freeze (0128) is
--     dead weight for an entity that was never a Google Place.
-- So suppliers get their own directory entity, modelled on `market_listings` (0072) with the
-- review-hardened live-or-own read (0125), a 0131-style column guard, and a slug definer (0044).
--
-- Moderation is a HARD gate (ARCHITECTURE.md): only approved, live orgs are world-readable.
--
-- SCOPE: B1 creates the table + read + owner-UPDATE + slug + column guard. It deliberately does NOT
-- add a client INSERT policy — self-serve supplier creation (with check owner=self, draft/pending)
-- is C3's tightest-scrutiny change and carries its own mandatory security review. In B1 an org is
-- created only by service_role/staff. Additive; idempotent.

create table if not exists orgs (
  id           uuid primary key default gen_random_uuid(),
  -- Null until claimed/created by an owner (staff can create an unclaimed supplier stub).
  owner_id     uuid references profiles(id) on delete set null,
  name         text not null check (char_length(name) between 2 and 200),
  slug         text not null unique,
  description  text check (char_length(description) <= 4000),
  category     text not null default 'supplier',
  -- Presentation / contact — non-PII, world-readable when live+approved.
  website      text,
  locality     text,
  logo_url     text,
  links        jsonb not null default '[]'::jsonb,
  -- Lifecycle. Soft-delete via 'removed'; no hard DELETE policy.
  status       text not null default 'draft' check (status in ('draft', 'live', 'removed')),
  -- Reuses the shared moderation_status enum (0001): only auto_approved/approved are public.
  moderation   moderation_status not null default 'pending',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists orgs_browse_idx on orgs (status, moderation, created_at desc);
create index if not exists orgs_owner_idx   on orgs (owner_id, created_at desc);

-- ── slug: unique, human-readable, generated (same shape as gen_unique_venue_slug, 0044) ───────
create or replace function gen_unique_org_slug(p_name text, p_locality text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  base text;
  loc  text;
  candidate text;
  n int := 0;
begin
  base := lower(coalesce(p_name, ''));
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
  base := trim(both '-' from base);

  loc := lower(coalesce(p_locality, ''));
  loc := regexp_replace(loc, '[^a-z0-9]+', '-', 'g');
  loc := trim(both '-' from loc);

  -- Append the locality for context + uniqueness, unless the name already contains it.
  if loc <> '' and position(loc in base) = 0 then
    base := base || '-' || loc;
  end if;
  base := regexp_replace(base, '-+', '-', 'g');
  base := trim(both '-' from base);
  if length(base) < 1 then
    base := 'org';
  end if;
  base := left(base, 80);

  candidate := base;
  while exists (select 1 from orgs where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n::text;
  end loop;
  return candidate;
end;
$$;

-- A definer slug generator is an existence oracle over orgs — the lesson from the security review.
-- Revoke from client roles so it is only ever reached through the BEFORE INSERT trigger / service
-- paths, never called directly from PostgREST.
revoke execute on function gen_unique_org_slug(text, text) from public;
revoke execute on function gen_unique_org_slug(text, text) from anon, authenticated;

create or replace function set_org_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := gen_unique_org_slug(new.name, new.locality);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_orgs_slug on orgs;
create trigger trg_orgs_slug before insert on orgs
  for each row execute function set_org_slug();

-- ── RLS: live-or-own read, owner UPDATE only (no client INSERT/DELETE in B1), column guard ────
alter table orgs enable row level security;

-- Public sees only APPROVED + LIVE orgs (the moderation hard gate). The 0125 two-policy pattern:
-- permissive policies OR-combine, so an owner additionally sees their own row at any status below.
drop policy if exists orgs_read on orgs;
create policy orgs_read on orgs for select
  using (status = 'live' and moderation in ('auto_approved', 'approved'));

drop policy if exists orgs_read_own on orgs;
create policy orgs_read_own on orgs for select
  using (owner_id = auth.uid());

-- An owner may UPDATE their own org (presentational fields only — see the column guard). No INSERT
-- policy (C3), no DELETE policy (soft-delete via status by staff).
drop policy if exists orgs_owner_update on orgs;
create policy orgs_owner_update on orgs for update
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Column guard (0131 diff-and-raise): an owner edits only presentational columns; status,
-- moderation, owner_id, slug, category are server/definer-managed. Raise (not silently drop) so a
-- future editable field is a loud reminder to extend the allowlist.
create or replace function public.orgs_guard_owner_columns()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    if (to_jsonb(new) - '{name,description,website,locality,logo_url,links,updated_at}'::text[])
       is distinct from
       (to_jsonb(old) - '{name,description,website,locality,logo_url,links,updated_at}'::text[]) then
      raise exception
        'orgs: an owner may only edit name, description, website, locality, logo_url and links'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists orgs_guard_owner_columns on orgs;
create trigger orgs_guard_owner_columns
  before update on orgs
  for each row execute function public.orgs_guard_owner_columns();

drop trigger if exists orgs_updated_at on orgs;
create trigger orgs_updated_at
  before update on orgs
  for each row execute function set_updated_at();

comment on table orgs is
  'Directory entity for Food to Go Association suppliers (NOT venues — suppliers must never surface on the proximity-ordered venue map). Modelled on market_listings; moderation is a hard gate (only auto_approved/approved + live are public). Self-serve client INSERT is added in C3, not here.';
comment on column orgs.moderation is
  'Hard gate: orgs_read exposes a row only when moderation is auto_approved/approved AND status=live.';

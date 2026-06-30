-- 0043_unique_handles.sql
--
-- Make every user's @handle a REQUIRED, globally-unique username (Twitter / Instagram model),
-- so a profile's canonical URL can be /u/{handle} instead of /u/{uuid}.
--
-- Today `handle` is `text unique` but NULLABLE, and new sign-ups land with handle = NULL
-- (handle_new_auth_user, 0006) until the user picks one. This migration:
--   1. Adds gen_unique_handle(seed) — derives a clean, unique handle from a seed string.
--   2. Backfills a handle for every profile that lacks one (row-by-row so each generated
--      handle sees the ones assigned just before it — no in-statement duplicate race).
--   3. Updates handle_new_auth_user so future sign-ups are born WITH a unique handle.
--   4. Enforces the format at the DB level and makes handle NOT NULL.
--
-- Handles are stored lower-cased (the API's normaliseHandle already lower-cases on write), so
-- the existing case-sensitive UNIQUE(handle) constraint is effectively case-insensitive.
-- Idempotent where it can be; safe to run once on the Roam-Core-Platform project.

-- 1. Handle generator: lower-case, fold to [a-z0-9_], collapse/trim underscores, ensure a
--    sensible base, then append the smallest integer suffix that makes it unique. Capped to 30.
create or replace function gen_unique_handle(seed text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := lower(coalesce(seed, ''));
  base := regexp_replace(base, '[^a-z0-9_]+', '_', 'g'); -- non-charset → underscore
  base := regexp_replace(base, '_+', '_', 'g');          -- collapse runs
  base := trim(both '_' from base);
  if length(base) < 3 then
    base := 'roamer';
  end if;
  base := left(base, 24); -- leave headroom for a numeric suffix within the 30-char cap

  candidate := base;
  while exists (select 1 from profiles where handle = candidate) loop
    n := n + 1;
    candidate := left(base, 30 - length(n::text)) || n::text;
  end loop;
  return candidate;
end;
$$;

-- 2. Backfill: give every handle-less profile a unique handle, seeded from display_name.
--    Row-by-row inside one transaction so each gen_unique_handle() call sees the handles the
--    previous iterations have already written (a single bulk UPDATE would not, and could collide).
do $$
declare
  r record;
begin
  for r in select id, display_name from profiles where handle is null or btrim(handle) = '' loop
    update profiles
       set handle = gen_unique_handle(coalesce(nullif(btrim(r.display_name), ''), 'roamer'))
     where id = r.id;
  end loop;
end;
$$;

-- 3. New sign-ups are born with a unique handle (replaces the 0006 version that left it NULL).
create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, display_name, handle)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', null),
    gen_unique_handle(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'roamer'))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

-- 4. Enforce format at the DB level + require a handle on every row.
alter table profiles drop constraint if exists profiles_handle_format;
alter table profiles
  add constraint profiles_handle_format check (handle ~ '^[a-z0-9_]{3,30}$') not valid;
alter table profiles validate constraint profiles_handle_format;

alter table profiles alter column handle set not null;

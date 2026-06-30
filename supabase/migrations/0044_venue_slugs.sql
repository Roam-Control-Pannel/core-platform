-- 0044_venue_slugs.sql
--
-- Give every venue a stable, human-readable, globally-unique `slug` so its canonical URL can be
-- /venue/{slug} (e.g. /venue/the-bridge-hotel-durham) instead of /venue/{uuid} — keyword-rich,
-- shareable, better for search. Legacy /venue/{uuid} links keep working (the route 301s to slug).
--
-- Slug = name slugified, with the locality appended for context + uniqueness when it isn't
-- already in the name, plus the smallest numeric suffix needed to stay unique.
--
-- Order matters: create the unique index BEFORE the backfill so each gen_unique_venue_slug()
-- existence check is index-assisted (the loop would otherwise be O(n^2) on a big venues table).
-- Apply once on the Roam-Core-Platform project.

alter table venues add column if not exists slug text;

create or replace function gen_unique_venue_slug(p_name text, p_locality text)
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

  -- Append the town for context/keywords + uniqueness, unless the name already contains it.
  if loc <> '' and position(loc in base) = 0 then
    base := base || '-' || loc;
  end if;
  base := regexp_replace(base, '-+', '-', 'g');
  base := trim(both '-' from base);
  if length(base) < 1 then
    base := 'venue';
  end if;
  base := left(base, 80);

  candidate := base;
  while exists (select 1 from venues where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n::text;
  end loop;
  return candidate;
end;
$$;

-- Unique index first (NULLs allowed; many while the column is fresh), so the backfill's
-- existence checks below are fast.
create unique index if not exists idx_venues_slug on venues (slug);

-- Backfill row-by-row so each generated slug sees the ones assigned just before it.
do $$
declare
  r record;
begin
  for r in select id, name, locality from venues where slug is null or btrim(slug) = '' loop
    update venues set slug = gen_unique_venue_slug(r.name, r.locality) where id = r.id;
  end loop;
end;
$$;

-- New venues (Places ingest, native creation) get a slug automatically when one isn't supplied.
create or replace function set_venue_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := gen_unique_venue_slug(new.name, new.locality);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_venues_slug on venues;
create trigger trg_venues_slug before insert on venues
  for each row execute function set_venue_slug();

alter table venues alter column slug set not null;

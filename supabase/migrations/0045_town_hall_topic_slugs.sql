-- 0045_town_hall_topic_slugs.sql
--
-- Give every Town Hall topic a human-readable slug, UNIQUE WITHIN ITS LOCALITY, so a topic's
-- canonical URL is /town-hall/{town}/{slug} (e.g. /town-hall/durham/best-sunday-roast). Two
-- different towns may both have a "best-coffee" topic; one town may not have two. Legacy
-- /town-hall/{uuid} links keep working (the route 301s to the canonical nested URL).
--
-- Same shape as the venue-slug migration: unique index first (so the backfill's per-locality
-- existence checks are index-assisted), then row-by-row backfill, then an insert trigger, then
-- NOT NULL. Apply once on the Roam-Core-Platform project.

alter table town_hall_topics add column if not exists slug text;

create or replace function gen_unique_topic_slug(p_title text, p_locality text)
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
  base := lower(coalesce(p_title, ''));
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
  base := trim(both '-' from base);
  if length(base) < 1 then
    base := 'topic';
  end if;
  base := left(base, 80);

  candidate := base;
  -- Uniqueness is scoped to the locality (the URL is /town-hall/{locality}/{slug}).
  while exists (select 1 from town_hall_topics where locality = p_locality and slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n::text;
  end loop;
  return candidate;
end;
$$;

create unique index if not exists idx_town_hall_topics_locality_slug on town_hall_topics (locality, slug);

do $$
declare
  r record;
begin
  for r in select id, title, locality from town_hall_topics where slug is null or btrim(slug) = '' loop
    update town_hall_topics set slug = gen_unique_topic_slug(r.title, r.locality) where id = r.id;
  end loop;
end;
$$;

create or replace function set_topic_slug()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := gen_unique_topic_slug(new.title, new.locality);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_town_hall_topics_slug on town_hall_topics;
create trigger trg_town_hall_topics_slug before insert on town_hall_topics
  for each row execute function set_topic_slug();

alter table town_hall_topics alter column slug set not null;

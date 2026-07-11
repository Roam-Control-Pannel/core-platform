-- 0084_explore_local_radius_cap.sql
--
-- Fix: Explore showed out-of-area venues (e.g. Darlington, 154 km away) when browsing a place
-- whose local coverage is thin. Both browse readers order by distance but never FILTER by it:
--
--   venues_near              (0026): from venues order by geo <-> point limit N     -- no cap
--   venues_in_category_near  (0081): where category=… order by … limit N            -- no cap
--
-- So once the nearby venues in the browsed place run out, the page simply continued to the
-- next-nearest venues ANYWHERE — a 154 km venue filled a Liverpool eateries page. (0081 only
-- bounded the CLAIMED-venue ranking boost to 30 km; it did not bound which rows are eligible.)
--
-- Cap both readers to the app's canonical "local" radius, NEARBY_RADIUS_M = 30 km — the same
-- threshold the feed is geofenced to (0038) and plan suggestions are capped to (0083), and the
-- value the Explore client already uses to decide coverage. Beyond 30 km a venue is simply not a
-- result for that place; if a place is genuinely sparse the list ends (and the client's demand
-- ingest fills it), instead of padding with another city's venues.
--
-- Both are `create or replace` — identical signatures/return types, SECURITY INVOKER, grants
-- unchanged. Only a `st_dwithin(...)` predicate is added; everything else is verbatim.

-- ── All-categories browse ────────────────────────────────────────────────────────────────────
create or replace function venues_near(
  lat         double precision,
  lng         double precision,
  max_results integer default 50
)
returns table (
  id                 uuid,
  name               text,
  owner_id           uuid,
  status             venue_status,
  category           text,
  categories         text[],
  rating             numeric(2,1),
  rating_count       integer,
  price_level        text,
  primary_type_label text,
  business_status    text,
  distance_m         double precision,
  lat_out            double precision,
  lng_out            double precision,
  cover_photo_id     uuid
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    v.id,
    v.name,
    v.owner_id,
    v.status,
    v.category,
    v.categories,
    v.rating,
    v.rating_count,
    v.price_level,
    v.primary_type_label,
    v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out,
    st_x(v.geo::geometry) as lng_out,
    (
      select p.id from venue_photos p
      where p.venue_id = v.id
      order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc
      limit 1
    ) as cover_photo_id
  from venues v
  -- Local only: within 30 km of the browsed point (NEARBY_RADIUS_M). Uses the GiST geo index.
  where st_dwithin(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography, 30000)
  order by v.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;

comment on function venues_near(double precision, double precision, integer) is
  'Near→far venue browse from a (lat,lng) origin, CAPPED to 30 km (NEARBY_RADIUS_M) so a place''s '
  'results never leak in another city''s venues. Returns distance_m, lat_out/lng_out (pins), '
  'cover_photo_id (hero), rating_count/price_level/primary_type_label. SECURITY INVOKER.';

grant execute on function venues_near(double precision, double precision, integer) to anon, authenticated;

-- ── Category browse ──────────────────────────────────────────────────────────────────────────
create or replace function venues_in_category_near(
  filter_category text,
  lat             double precision,
  lng             double precision,
  page_size       integer default 10,
  page_offset     integer default 0
)
returns table (
  id                 uuid,
  name               text,
  owner_id           uuid,
  status             venue_status,
  category           text,
  categories         text[],
  rating             numeric(2,1),
  rating_count       integer,
  price_level        text,
  primary_type_label text,
  business_status    text,
  distance_m         double precision,
  lat_out            double precision,
  lng_out            double precision,
  cover_photo_id     uuid
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    v.id,
    v.name,
    v.owner_id,
    v.status,
    v.category,
    v.categories,
    v.rating,
    v.rating_count,
    v.price_level,
    v.primary_type_label,
    v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out,
    st_x(v.geo::geometry) as lng_out,
    (
      select p.id from venue_photos p
      where p.venue_id = v.id
      order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc
      limit 1
    ) as cover_photo_id
  from venues v
  where v.category = filter_category
    -- Local only: within 30 km of the browsed point (NEARBY_RADIUS_M), so a thin local category
    -- ends the list instead of padding it with far-away venues.
    and st_dwithin(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography, 30000)
  order by
    -- Claimed venues still lead when genuinely local (0081); everything is now within 30 km.
    (v.owner_id is not null
      and st_dwithin(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography, 30000)) desc,
    v.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

comment on function venues_in_category_near(text, double precision, double precision, integer, integer) is
  'Category browse CAPPED to 30 km (NEARBY_RADIUS_M): claimed-local venues lead, then nearest→'
  'furthest, and out-of-area venues are excluded entirely. Returns page_size+1 rows for hasMore, '
  'plus lat_out/lng_out (pins), cover_photo_id (hero), rating_count/price_level. SECURITY INVOKER.';

grant execute on function venues_in_category_near(text, double precision, double precision, integer, integer) to anon, authenticated;

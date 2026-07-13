-- 0089_fix_venue_origin_param_shadowing.sql
--
-- FIX: Explore showed venues from every town at "0 m", regardless of the browsed place.
--
-- Root cause — parameter/column name shadowing introduced by 0086. That migration added
-- generated `lat` / `lng` COLUMNS to `venues` (for cheap map reads). The geo browse functions
-- take origin PARAMETERS also named `lat` / `lng`, and reference them bare inside a query over
-- `venues` — e.g. `st_makepoint(lng, lat)`. In a SQL function a table column shadows a same-named
-- parameter, so after 0086 those `lng`/`lat` bound to the VENUE's own columns, not the origin.
-- Every venue was therefore measured against ITSELF → distance 0 → inside any radius → the 30 km
-- cap (0084) filtered nothing and the browsed origin was ignored. Hence Newcastle showed
-- Liverpool + Darlington + everything, all badged "0 m".
--
-- The fix keeps each function's SIGNATURE identical (so PostgREST arg names, the tRPC callers and
-- the existing grants are all unchanged — `create or replace`, no drop). It computes the origin
-- point in a `with origin as (select … )` CTE that has NO `venues` in scope, so `lat`/`lng` there
-- resolve to the PARAMETERS. The body then references only `origin.g`, never bare lat/lng again.
--
-- Affected functions (all four share the flaw): venues_near, venues_in_category_near,
-- venues_search_by_name, count_fresh_places_venues.

-- ── venues_near ──────────────────────────────────────────────────────────────────────────────
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
  with origin as (select st_setsrid(st_makepoint(lng, lat), 4326)::geography as g)
  select
    v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, o.g) as distance_m,
    st_y(v.geo::geometry) as lat_out,
    st_x(v.geo::geometry) as lng_out,
    (
      select p.id from venue_photos p
      where p.venue_id = v.id
      order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc
      limit 1
    ) as cover_photo_id
  from venues v, origin o
  -- Local only: within 30 km of the browsed point (NEARBY_RADIUS_M).
  where st_dwithin(v.geo, o.g, 30000)
  order by v.geo <-> o.g
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;

-- ── venues_in_category_near ──────────────────────────────────────────────────────────────────
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
  with origin as (select st_setsrid(st_makepoint(lng, lat), 4326)::geography as g)
  select
    v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, o.g) as distance_m,
    st_y(v.geo::geometry) as lat_out,
    st_x(v.geo::geometry) as lng_out,
    (
      select p.id from venue_photos p
      where p.venue_id = v.id
      order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc
      limit 1
    ) as cover_photo_id
  from venues v, origin o
  where v.category = filter_category
    -- Local only: within 30 km of the browsed point (NEARBY_RADIUS_M).
    and st_dwithin(v.geo, o.g, 30000)
  order by
    -- Claimed venues still lead when genuinely local (0081); everything is now within 30 km.
    (v.owner_id is not null and st_dwithin(v.geo, o.g, 30000)) desc,
    v.geo <-> o.g
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

-- ── venues_search_by_name ────────────────────────────────────────────────────────────────────
create or replace function venues_search_by_name(
  q           text,
  lat         double precision,
  lng         double precision,
  max_results integer default 20
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
  with origin as (select st_setsrid(st_makepoint(lng, lat), 4326)::geography as g)
  select
    v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, o.g) as distance_m,
    st_y(v.geo::geometry) as lat_out,
    st_x(v.geo::geometry) as lng_out,
    (
      select p.id from venue_photos p
      where p.venue_id = v.id
      order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc
      limit 1
    ) as cover_photo_id
  from venues v, origin o
  where btrim(q) <> ''
    and v.name ilike '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by v.geo <-> o.g
  limit greatest(1, least(coalesce(max_results, 20), 50));
$$;

-- ── count_fresh_places_venues ────────────────────────────────────────────────────────────────
create or replace function count_fresh_places_venues(
  lat        double precision,
  lng        double precision,
  radius_m   double precision,
  cat        text
)
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  with origin as (select st_setsrid(st_makepoint(lng, lat), 4326)::geography as g)
  select count(*)::int
  from venues v, origin o
  where v.source = 'google_places'
    and v.category = cat
    and v.fetched_at is not null
    and v.fetched_at > now() - interval '30 days'
    and st_dwithin(v.geo, o.g, radius_m);
$$;

comment on function venues_near(double precision, double precision, integer) is
  'Near→far venue browse from a (lat,lng) origin, capped to 30 km. Origin built in a CTE so the '
  'lat/lng params are not shadowed by the venues.lat/lng generated columns (added in 0086).';

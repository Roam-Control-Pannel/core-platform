-- 0090_venue_rpc_origin_param_names.sql
--
-- Hardening follow-up to 0089. That migration fixed the parameter/column shadowing (venues.lat/lng
-- columns from 0086 shadowed the lat/lng origin PARAMETERS) by computing the origin in a CTE. This
-- migration removes the hazard at the source: the origin parameters are renamed to `origin_lat` /
-- `origin_lng`, which cannot collide with any `venues` column — so a future edit that references the
-- origin bare (outside a CTE) can never again bind to a venue's own coordinates. The bodies are the
-- straightforward, cap-at-30 km form again (no CTE needed once the names can't clash).
--
-- Parameter NAMES can't be changed with `create or replace`, so each function is dropped and
-- recreated (atomic within the migration transaction) and its grants re-applied. Signatures'
-- argument TYPES are unchanged; only the names change, so the API's PostgREST calls are updated in
-- lockstep (venues.near / venues.inCategoryNear, places.searchText / the ingest freshness check).

-- ── venues_near ──────────────────────────────────────────────────────────────────────────────
drop function if exists venues_near(double precision, double precision, integer);
create function venues_near(
  origin_lat  double precision,
  origin_lng  double precision,
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
    v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out,
    st_x(v.geo::geometry) as lng_out,
    (
      select p.id from venue_photos p
      where p.venue_id = v.id
      order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc
      limit 1
    ) as cover_photo_id
  from venues v
  where st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 30000)
  order by v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;
comment on function venues_near(double precision, double precision, integer) is
  'Near→far venue browse from an (origin_lat, origin_lng) origin, capped to 30 km. Params are named '
  'origin_* so they can never be shadowed by the venues.lat/lng generated columns (the 0086 bug).';
grant execute on function venues_near(double precision, double precision, integer) to anon, authenticated;

-- ── venues_in_category_near ──────────────────────────────────────────────────────────────────
drop function if exists venues_in_category_near(text, double precision, double precision, integer, integer);
create function venues_in_category_near(
  filter_category text,
  origin_lat      double precision,
  origin_lng      double precision,
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
    v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
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
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 30000)
  order by
    (v.owner_id is not null
      and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 30000)) desc,
    v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;
comment on function venues_in_category_near(text, double precision, double precision, integer, integer) is
  'Category browse capped to 30 km. Origin params named origin_* (unshadowable by venues.lat/lng).';
grant execute on function venues_in_category_near(text, double precision, double precision, integer, integer) to anon, authenticated;

-- ── venues_search_by_name ────────────────────────────────────────────────────────────────────
drop function if exists venues_search_by_name(text, double precision, double precision, integer);
create function venues_search_by_name(
  q           text,
  origin_lat  double precision,
  origin_lng  double precision,
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
  select
    v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out,
    st_x(v.geo::geometry) as lng_out,
    (
      select p.id from venue_photos p
      where p.venue_id = v.id
      order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc
      limit 1
    ) as cover_photo_id
  from venues v
  where btrim(q) <> ''
    and v.name ilike '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 20), 50));
$$;
comment on function venues_search_by_name(text, double precision, double precision, integer) is
  'Name-matched venue search, distance-ordered from (origin_lat, origin_lng). Origin params named '
  'origin_* (unshadowable by venues.lat/lng).';
revoke all on function venues_search_by_name(text, double precision, double precision, integer) from public;
grant execute on function venues_search_by_name(text, double precision, double precision, integer) to anon, authenticated, service_role;

-- ── count_fresh_places_venues ────────────────────────────────────────────────────────────────
drop function if exists count_fresh_places_venues(double precision, double precision, double precision, text);
create function count_fresh_places_venues(
  origin_lat double precision,
  origin_lng double precision,
  radius_m   double precision,
  cat        text
)
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::int
  from venues v
  where v.source = 'google_places'
    and v.category = cat
    and v.fetched_at is not null
    and v.fetched_at > now() - interval '30 days'
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, radius_m);
$$;
comment on function count_fresh_places_venues(double precision, double precision, double precision, text) is
  'Fresh google_places venue count within radius_m of (origin_lat, origin_lng). Origin params named '
  'origin_* (unshadowable by venues.lat/lng).';
grant execute on function count_fresh_places_venues(double precision, double precision, double precision, text) to anon, authenticated, service_role;

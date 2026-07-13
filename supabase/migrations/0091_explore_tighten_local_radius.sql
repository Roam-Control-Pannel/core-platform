-- 0091_explore_tighten_local_radius.sql
--
-- Explore Browse was returning a neighbouring city's venues: a Newcastle search showed Durham
-- venues, because the browse radius (30 km, since 0084) reaches the next city (Durham is ~22 km
-- from Newcastle). The geofence works — it was just too wide for "one town".
--
-- Tighten it to 18 km (NEARBY_RADIUS_M). Chosen from the live data, not guessed:
--   • Largest real-town venue spread is Darlington at ~12.5 km; +~2 km geocode offset ≈ 14.5 km, so
--     18 km keeps every town's OWN venues (Liverpool 5.2 km, Belfast 1.6 km, Penrith 1.4 km fit easily).
--   • The nearest Durham venue is ~20 km from Newcastle, so 18 km excludes the neighbouring city.
--   • Distinct towns are ≥68 km apart in the data, so 18 km can never let one town leak into another.
--
-- This is a body-only change (same signatures as 0090 — origin_lat/origin_lng), so the standalone
-- API service needs no redeploy and there is no coordinated-deploy window. Only venues_near and
-- venues_in_category_near carry the radius cap; venues_search_by_name (name search) is unaffected.

create or replace function venues_near(origin_lat double precision, origin_lng double precision, max_results integer default 50)
returns table (id uuid, name text, owner_id uuid, status venue_status, category text, categories text[],
  rating numeric(2,1), rating_count integer, price_level text, primary_type_label text, business_status text,
  distance_m double precision, lat_out double precision, lng_out double precision, cover_photo_id uuid)
language sql stable security invoker set search_path = public as $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id
  from venues v
  where st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)
  order by v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;
comment on function venues_near(double precision, double precision, integer) is
  'Near→far venue browse from an (origin_lat, origin_lng) origin, capped to 18 km (NEARBY_RADIUS_M) '
  'so a town''s results never include a neighbouring city. origin_* params are unshadowable by venues.lat/lng.';

create or replace function venues_in_category_near(filter_category text, origin_lat double precision, origin_lng double precision,
  page_size integer default 10, page_offset integer default 0)
returns table (id uuid, name text, owner_id uuid, status venue_status, category text, categories text[],
  rating numeric(2,1), rating_count integer, price_level text, primary_type_label text, business_status text,
  distance_m double precision, lat_out double precision, lng_out double precision, cover_photo_id uuid)
language sql stable security invoker set search_path = public as $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id
  from venues v
  where v.category = filter_category
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)
  order by (v.owner_id is not null
      and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)) desc,
    v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;
comment on function venues_in_category_near(text, double precision, double precision, integer, integer) is
  'Category browse capped to 18 km (NEARBY_RADIUS_M) so a town''s results never include a neighbouring city.';

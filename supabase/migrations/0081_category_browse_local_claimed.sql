-- 0081_category_browse_local_claimed.sql
--
-- Fix: a claimed venue far from the browsed place was ranked ABOVE nearby venues in the Explore
-- category browse. venues_in_category_near (0026) orders "claimed first, then nearest":
--
--     order by (v.owner_id is not null) desc, v.geo <-> point
--
-- The `(owner_id is not null)` tier is GLOBAL — it has no distance bound — so a claimed venue in
-- Darlington (154 km away) sorted above every unclaimed Liverpool venue when browsing Liverpool
-- eateries. The claim boost is intended to give a business prominence IN ITS OWN AREA, not to
-- pull it into a different city's results.
--
-- Bound the claim boost to the app's existing "local" radius, NEARBY_RADIUS_M = 30 km (the same
-- threshold Explore uses to decide whether an area has coverage). A claimed venue only jumps the
-- queue when it's within 30 km of the browsed point; beyond that it ranks by pure distance (so a
-- 154 km venue falls to its natural far-down position and never leads a local browse). Everything
-- else about the function is unchanged. `create or replace` — same signature/return type.

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
    st_distance(
      v.geo,
      st_setsrid(st_makepoint(lng, lat), 4326)::geography
    ) as distance_m,
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
  order by
    -- Claimed venues lead ONLY when they're genuinely local (within 30 km). Beyond that the
    -- boost is dropped, so a far claimed venue ranks by distance like any other.
    (v.owner_id is not null
      and st_dwithin(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography, 30000)) desc,
    v.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

comment on function venues_in_category_near(text, double precision, double precision, integer, integer) is
  'Category browse: claimed venues within 30 km lead, then nearest→furthest (a far claimed venue '
  'no longer outranks local ones). Returns page_size+1 rows for hasMore, plus lat_out/lng_out '
  '(pins), cover_photo_id (hero), and rating_count/price_level/primary_type_label. SECURITY INVOKER.';

grant execute on function venues_in_category_near(text, double precision, double precision, integer, integer) to anon, authenticated;

-- 0118_venues_in_channel_near.sql
--
-- Food to Go Marketplace · Phase 2 · Demand — discover a CHANNEL's vendors near a point.
--
-- The storefront home lists Food to Go vendors nearest-first. Doing that as "50 nearest venues
-- overall, then keep the f2g-tagged ones" truncates badly where f2g venues are sparse relative to
-- total venue density — tagged vendors just outside the global top-50 would vanish. So this mirrors
-- venues_in_category_near (0096) exactly, but filters by CHANNEL MEMBERSHIP (venue_channels) instead
-- of category: same card columns, same 18 km cap, same KNN order (claimed first), same
-- CLOSED_PERMANENTLY exclusion, same page_size+1 pagination (caller derives hasMore from the
-- overflow row). The channel id is resolved by the API from the channel key.
--
-- Idempotent; safe to run once. (RPCs aren't in the generated DB types; the API calls via LooseRpc.)

create or replace function venues_in_channel_near(filter_channel_id uuid, origin_lat double precision, origin_lng double precision,
  page_size integer default 20, page_offset integer default 0)
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
  where exists (select 1 from venue_channels vc where vc.venue_id = v.id and vc.channel_id = filter_channel_id)
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  order by (v.owner_id is not null) desc,
    v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 20), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

grant execute on function venues_in_channel_near(uuid, double precision, double precision, integer, integer)
  to anon, authenticated;

comment on function venues_in_channel_near(uuid, double precision, double precision, integer, integer) is
  'F2G Phase 2: a channel''s vendors near a point (venue_channels join), nearest-first, claimed first. '
  'Mirrors venues_in_category_near; the non-truncating source for the Food to Go storefront home.';

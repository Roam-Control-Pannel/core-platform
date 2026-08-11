-- 0120_venues_in_channel_near_prep.sql
--
-- Food to Go · Phase 5 (co-brand storefront) — surface each vendor's prep time on the discovery
-- grid so cards can show a real "READY ~N MIN" pill, not a guess. Recreates venues_in_channel_near
-- (0118) with one extra column, prep_time_mins, left-joined from venue_collection_settings (a venue
-- with no row → null, which the app renders as the 15-min default). Same args, same order/paging.
--
-- Adding a column to a RETURNS TABLE is a return-type change, so this is drop + create (the arg
-- signature is unchanged, so the API's .rpc() call resolves the same either side of deploy).
-- Idempotent.

drop function if exists venues_in_channel_near(uuid, double precision, double precision, integer, integer);

create function venues_in_channel_near(filter_channel_id uuid, origin_lat double precision, origin_lng double precision,
  page_size integer default 20, page_offset integer default 0)
returns table (id uuid, name text, owner_id uuid, status venue_status, category text, categories text[],
  rating numeric(2,1), rating_count integer, price_level text, primary_type_label text, business_status text,
  distance_m double precision, lat_out double precision, lng_out double precision, cover_photo_id uuid,
  prep_time_mins integer)
language sql stable security invoker set search_path = public as $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id,
    vcs.prep_time_mins
  from venues v
  left join venue_collection_settings vcs on vcs.venue_id = v.id
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
  'F2G Phase 2/5: a channel''s vendors near a point (venue_channels join), nearest-first, claimed '
  'first, with each vendor''s prep_time_mins for the storefront "ready in ~N min" pill.';

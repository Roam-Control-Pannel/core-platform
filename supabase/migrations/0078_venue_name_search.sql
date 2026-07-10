-- 0078_venue_name_search.sql
--
-- Server-side venue NAME search for Explore. Before this, the Explore search box was a purely
-- client-side substring filter over the ~50 venues already loaded near the map centre — so a
-- venue that existed in the DB but sat outside that loaded set (or a venue not yet ingested at
-- all) could never be found by name. This RPC is the DB half of the fix:
--
--   1. It powers a proper server-side name search (venues.searchByName) — matches every stored
--      venue by name, distance-ordered from the search origin, NOT limited to the loaded set.
--   2. It is also the read the Google Places text-search fall-through uses after it ingests a
--      newly-found venue (places.searchText), so both the "already in DB" and "just fetched from
--      Google" paths return the SAME card shape.
--
-- Same column set + projection as venues_near (0026) so the client renders the rows identically.
-- SECURITY INVOKER → venues_read (public) RLS applies, exactly like venues_near, so anonymous
-- browsing works. Name match is a trigram-friendly ILIKE '%q%' (pg_trgm is already installed);
-- q is treated as a literal (special chars escaped) so it can't inject a LIKE wildcard.

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
  where btrim(q) <> ''
    and v.name ilike '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
  order by v.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 20), 50));
$$;

comment on function venues_search_by_name(text, double precision, double precision, integer) is
  'Name-matched venue search (ILIKE, literal q), distance-ordered from (lat,lng). Same card projection as venues_near; powers Explore search + the Places text-search fall-through.';

-- Public read, matching venues_near's grants (SECURITY INVOKER + venues_read RLS gate access).
revoke all on function venues_search_by_name(text, double precision, double precision, integer) from public;
grant execute on function venues_search_by_name(text, double precision, double precision, integer) to anon, authenticated, service_role;

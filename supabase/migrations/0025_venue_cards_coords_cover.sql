-- ============================================================================
-- Roam — 0025_venue_cards_coords_cover.sql
-- Bring the Explore grid to life: the two browse read RPCs now also return, per venue,
-- its COORDINATES (for map pins) and its COVER PHOTO id (for the card cover image).
--
--   • lat / lng       — st_y / st_x of the venue's PostGIS point, so the web can drop a
--                       pin per venue without a second round-trip (or any Google call).
--   • cover_photo_id  — the venue's hero photo, by the SAME precedence @roam/core selectHero
--                       uses: an explicit owner cover first, then the best owner upload,
--                       then the best Places photo. So when an owner claims and uploads
--                       (and picks a cover), their image wins over the scraped Places one —
--                       exactly the owner-override the photo model already enforces. NULL
--                       when the venue has no photos (card falls back to its tinted tile).
--
-- Both are cheap: lat/lng are index-free scalar extracts; cover_photo_id is one correlated
-- lookup on idx_venue_photos_venue_position / idx_venue_photos_cover. No Google calls here —
-- resolving a cover id to a displayable URL stays the api's photoMediaUrl job (now cached).
--
-- SECURITY INVOKER preserved on both (venues_read + venue_photos public-read RLS apply);
-- grants re-issued. Return-type change ⇒ drop-then-create (can't `create or replace` a new
-- column set). Re-appliable on a clean reset.
-- ============================================================================

-- ── venues_near (was 0005) ──────────────────────────────────────────────────
drop function if exists venues_near(double precision, double precision, integer);

create function venues_near(
  lat         double precision,
  lng         double precision,
  max_results integer default 50
)
returns table (
  id             uuid,
  name           text,
  owner_id       uuid,
  status         venue_status,
  category       text,
  categories     text[],
  rating         numeric(2,1),
  distance_m     double precision,
  lat_out        double precision,
  lng_out        double precision,
  cover_photo_id uuid
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
  order by v.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;

comment on function venues_near(double precision, double precision, integer) is
  'Near→far venue search from a (lat,lng) origin (KNN over idx_venues_geo). Returns '
  'distance_m plus lat_out/lng_out (for map pins) and cover_photo_id (hero photo, '
  'owner-cover-aware per selectHero). SECURITY INVOKER — venues_read RLS applies.';

grant execute on function venues_near(double precision, double precision, integer) to anon, authenticated;

-- ── venues_in_category_near (was 0017) ──────────────────────────────────────
drop function if exists venues_in_category_near(text, double precision, double precision, integer, integer);

create function venues_in_category_near(
  filter_category text,
  lat             double precision,
  lng             double precision,
  page_size       integer default 10,
  page_offset     integer default 0
)
returns table (
  id             uuid,
  name           text,
  owner_id       uuid,
  status         venue_status,
  category       text,
  categories     text[],
  rating         numeric(2,1),
  distance_m     double precision,
  lat_out        double precision,
  lng_out        double precision,
  cover_photo_id uuid
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
    (v.owner_id is not null) desc,
    v.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

comment on function venues_in_category_near(text, double precision, double precision, integer, integer) is
  'Tiered category browse (claimed first, then nearest→furthest). Returns page_size+1 '
  'rows for hasMore, plus lat_out/lng_out (pins) and cover_photo_id (hero, owner-cover-'
  'aware per selectHero). SECURITY INVOKER — venues_read RLS applies.';

grant execute on function venues_in_category_near(text, double precision, double precision, integer, integer) to anon, authenticated;

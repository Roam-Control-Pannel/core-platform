-- ============================================================================
-- Roam — 0026_venue_card_fields.sql
-- Richer venue cards: persist + return three more Google Places facts per venue.
--
--   • rating_count        — number of ratings behind `rating` ("4.6 ★ (1,240)").
--   • price_level         — Places price enum ("PRICE_LEVEL_*"), null when unspecified.
--   • primary_type_label  — Places' clean localized type label ("Coffee shop").
--
-- These ride field-mask additions (places.userRatingCount / priceLevel /
-- primaryTypeDisplayName) that DO NOT bump the billing tier — userRatingCount and
-- priceLevel share the Enterprise SKU `rating` already pulls, and primaryTypeDisplayName
-- is a cheaper Pro field. Mapped by the pure @roam/core placeToVenueRow.
--
-- THREE parts, mirroring 0018 (writer) + 0025 (readers):
--   1. add the columns (nullable; existing rows backfill via ingest / the enrichment pass).
--   2. redefine upsert_place_venues to write them — STILL frozen on claimed venues
--      (owner_id is null guard), exactly like rating/hours.
--   3. recreate venues_near / venues_in_category_near to return them (return-type change
--      ⇒ drop-then-create). SECURITY INVOKER preserved; grants re-issued.
--
-- Re-appliable on a clean reset (add-column is `if not exists`; functions drop-first).
-- ============================================================================

-- ── 1. Columns ──────────────────────────────────────────────────────────────
alter table venues add column if not exists rating_count       integer;
alter table venues add column if not exists price_level        text;
alter table venues add column if not exists primary_type_label text;
-- "OPERATIONAL" | "CLOSED_TEMPORARILY" | null (permanently-closed venues are dropped at
-- ingest, never inserted), so the card can badge a temporarily-closed venue.
alter table venues add column if not exists business_status    text;

-- ── 2. Writer: upsert_place_venues (was 0018) ───────────────────────────────
drop function if exists upsert_place_venues(jsonb);

create or replace function upsert_place_venues(places jsonb)
returns table (
  out_id          uuid,
  out_source_ref  text,
  out_was_claimed boolean   -- true => row exists but is claimed, so it was left untouched
)
language plpgsql
security definer
set search_path = public
as $$
declare
  elem jsonb;
begin
  if jsonb_typeof(places) is distinct from 'array' then
    raise exception 'upsert_place_venues expects a JSONB array, got %', jsonb_typeof(places)
      using errcode = '22023';
  end if;

  for elem in select * from jsonb_array_elements(places)
  loop
    if (elem->>'source_ref') is null
       or (elem->>'name') is null
       or (elem->>'lat') is null
       or (elem->>'lng') is null then
      continue;
    end if;

    return query
    insert into venues (
      source, source_ref, name, geo, category, categories, rating, address,
      source_attribution, status, fetched_at, opening_times,
      rating_count, price_level, primary_type_label, business_status
    )
    values (
      'google_places',
      elem->>'source_ref',
      elem->>'name',
      st_setsrid(
        st_makepoint((elem->>'lng')::float8, (elem->>'lat')::float8),
        4326
      )::geography,
      elem->>'category',
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(elem->'categories')),
        '{}'::text[]
      ),
      case when elem ? 'rating' and (elem->>'rating') is not null
           then (elem->>'rating')::numeric(2,1) end,
      elem->>'address',
      coalesce(elem->>'source_attribution', 'Information from public sources'),
      'unclaimed',
      now(),
      elem->'opening_times',
      case when elem ? 'rating_count' and (elem->>'rating_count') is not null
           then (elem->>'rating_count')::integer end,
      elem->>'price_level',
      elem->>'primary_type_label',
      elem->>'business_status'
    )
    on conflict (source, source_ref) do update
      set name               = excluded.name,
          geo                = excluded.geo,
          category           = excluded.category,
          categories         = excluded.categories,
          rating             = excluded.rating,
          address            = excluded.address,
          opening_times      = excluded.opening_times,
          rating_count       = excluded.rating_count,
          price_level        = excluded.price_level,
          primary_type_label = excluded.primary_type_label,
          business_status    = excluded.business_status,
          fetched_at         = now()
      where venues.owner_id is null            -- freeze claimed venues against Places
    returning venues.id, venues.source_ref, false;

    if not found then
      return query
      select v.id, v.source_ref, true
      from venues v
      where v.source = 'google_places'
        and v.source_ref = elem->>'source_ref';
    end if;
  end loop;
end;
$$;

comment on function upsert_place_venues(jsonb) is
  'Batch upsert of Google Places venues from a JSONB array. Inserts new unclaimed '
  'venues and refreshes still-unclaimed ones (name/geo/category/categories/rating/'
  'address/opening_times/rating_count/price_level/primary_type_label, bumping '
  'fetched_at); leaves CLAIMED venues untouched (owner_id is null guard). Builds geo '
  'lng-first. SECURITY DEFINER — reached only via the api internalProcedure.';

revoke all on function upsert_place_venues(jsonb) from public;
grant execute on function upsert_place_venues(jsonb) to service_role;

-- ── 3a. Reader: venues_near (was 0025) ──────────────────────────────────────
drop function if exists venues_near(double precision, double precision, integer);

create function venues_near(
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
  'distance_m, lat_out/lng_out (pins), cover_photo_id (hero, owner-cover-aware), plus '
  'rating_count/price_level/primary_type_label for the card. SECURITY INVOKER.';

grant execute on function venues_near(double precision, double precision, integer) to anon, authenticated;

-- ── 3b. Reader: venues_in_category_near (was 0025) ──────────────────────────
drop function if exists venues_in_category_near(text, double precision, double precision, integer, integer);

create function venues_in_category_near(
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
    (v.owner_id is not null) desc,
    v.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

comment on function venues_in_category_near(text, double precision, double precision, integer, integer) is
  'Tiered category browse (claimed first, then nearest→furthest). Returns page_size+1 '
  'rows for hasMore, plus lat_out/lng_out (pins), cover_photo_id (hero), and '
  'rating_count/price_level/primary_type_label for the card. SECURITY INVOKER.';

grant execute on function venues_in_category_near(text, double precision, double precision, integer, integer) to anon, authenticated;

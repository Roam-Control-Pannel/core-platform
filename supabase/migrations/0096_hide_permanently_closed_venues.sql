-- 0096_hide_permanently_closed_venues.sql
--
-- Closed-venue guard on the Explore reads + the enrichment writer (#66).
--
-- The problem: a business that PERMANENTLY closes could linger on Explore forever. business_status
-- was stored but never used as a filter, and only the ingest mapper dropped CLOSED_PERMANENTLY (and
-- only for brand-new rows). Nothing hid an already-listed venue that later closed.
--
-- The fix, two parts:
--   1. READS filter it out — venues_near / venues_in_category_near / venues_search_by_name now
--      exclude business_status = 'CLOSED_PERMANENTLY'. This is the durable guard: whatever marks a
--      venue closed (enrichment below, the photo backfill, or a future re-check sweep), Explore
--      stops showing it. Temporarily-closed venues are KEPT (they reopen; the card badges them).
--   2. ENRICHMENT marks it — apply_venue_details now also writes business_status. Google's Places
--      *search* hides closed venues, but *Details* still reports closure, so the first time anyone
--      opens a since-closed venue's profile it gets marked CLOSED_PERMANENTLY and (1) hides it.
--
-- Deploy-safety: the three read RPCs are recreated body-only with IDENTICAL signatures (no skew).
-- apply_venue_details gains a TRAILING parameter WITH A DEFAULT, so the pre-deploy API's 5-argument
-- call still resolves to the new function (the 6th arg defaults to null) — no coordinated deploy.
--
-- Known limitation (tracked as a follow-up, not built here): a venue that closes AFTER it was
-- already enriched, and never re-viewed, won't be re-marked until a periodic Details re-check sweep
-- exists — enrichment is one-shot (details_fetched_at gate). The read filter still hides any venue
-- once it IS marked.
--
-- Idempotent; safe to run once on the Roam-Core project.

-- ── 1. Reads exclude permanently-closed ──────────────────────────────────────────────────────────
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
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  order by v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;

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
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  order by (v.owner_id is not null
      and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)) desc,
    v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

create or replace function venues_search_by_name(q text, origin_lat double precision, origin_lng double precision, max_results integer default 20)
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
  where btrim(q) <> ''
    and v.name ilike '%' || replace(replace(replace(btrim(q), '\', '\\'), '%', '\%'), '_', '\_') || '%'
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  order by v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 20), 50));
$$;

-- ── 2. Enrichment writer also records business_status ────────────────────────────────────────────
-- Adding a param needs drop+create (a signature change), but the new param is TRAILING and DEFAULTED,
-- so the pre-0096 API's 5-arg call still resolves here (p_business_status → null). Keeps the same
-- owner-null + not-yet-enriched guard.
drop function if exists apply_venue_details(uuid, text, text, jsonb, jsonb);
create function apply_venue_details(
  p_venue_id       uuid,
  p_phone          text,
  p_website        text,
  p_price_range    jsonb,
  p_attributes     jsonb,
  p_business_status text default null
)
returns void
language sql
security invoker
set search_path = public
as $$
  update venues set
    phone              = p_phone,
    website_url        = p_website,
    price_range        = p_price_range,
    attributes         = p_attributes,
    business_status    = coalesce(p_business_status, business_status),
    details_fetched_at = now()
  where id = p_venue_id
    and owner_id is null
    and details_fetched_at is null;
$$;

comment on function apply_venue_details(uuid, text, text, jsonb, jsonb, text) is
  'On-demand enrichment writer (0080; +business_status in 0096): stores the rich Places Details '
  'facts, marks business_status (so a since-closed venue is caught and hidden by the reads), and '
  'stamps details_fetched_at — only while still unclaimed and not yet enriched.';

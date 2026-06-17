-- ============================================================================
-- Roam — 0017_venues_in_category_near.sql
-- The tiered, category-filtered, paginated read that Slice 2's Explore pill tap
-- reads back AFTER ingestCategory (0016) has filled supply. Sibling to
-- venues_near (0005): same PostGIS mechanics, three deliberate differences —
--   1. CATEGORY FILTER: only venues whose canonical group (venues.category)
--      matches the tapped pill.
--   2. ACTIVATED-FIRST TIERING: claimed venues (owner_id set) sort ahead of
--      unclaimed, each sub-ordered nearest→furthest. This is the launch promise —
--      a business that activated is surfaced above the public-source directory
--      row, but the unclaimed median experience still appears, just below.
--   3. PAGINATION: limit/offset, 10 per page at the call site. We return up to
--      (page_size + 1) rows so the CALLER can tell "is there another page?" from
--      whether the overflow row exists — no separate COUNT(*) round-trip.
--
-- WHY A NEW FUNCTION, NOT AN EXTENSION OF venues_near: venues_near is also called
-- by chat.ts (the meet-up venue-card picker) with a pure distance contract. Adding
-- tiering + a category filter + pagination to it would change that shared contract.
-- A dedicated sibling keeps venues_near simple and this purpose-built. (ARCHITECTURE:
-- one function, one job.)
--
-- ORDERING / INDEX: the KNN operator (geo <-> origin) rides idx_venues_geo within
-- each tier; the leading boolean sort key (owner_id is not null) groups the two
-- tiers. At launch/locality volumes the planner's sort over the category-filtered,
-- KNN-ordered set is trivial. Seam if it ever matters: a composite/partial index on
-- (category, (owner_id is not null)) — flagged, NOT built now.
--
-- SECURITY: SECURITY INVOKER (like venues_near) — venues_read RLS (`using (true)`,
-- world-readable) applies, so anonymous browsing works and there is no privilege to
-- escalate. NOT definer (same footgun-avoidance rationale as 0005).
--
-- RE-APPLIABILITY (lesson 3): drop the exact signature first so a clean `db reset`
-- can re-create it without "cannot change return type" if the shape ever changes.
-- ============================================================================

drop function if exists venues_in_category_near(text, double precision, double precision, integer, integer);

create function venues_in_category_near(
  filter_category text,
  lat             double precision,
  lng             double precision,
  page_size       integer default 10,
  page_offset     integer default 0
)
returns table (
  id          uuid,
  name        text,
  owner_id    uuid,
  status      venue_status,
  category    text,
  categories  text[],
  rating      numeric(2,1),
  distance_m  double precision
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
    ) as distance_m
  from venues v
  where v.category = filter_category
  order by
    (v.owner_id is not null) desc,            -- tier 1: claimed/activated first
    v.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography  -- then nearest→furthest
  -- Return one MORE than the page so the caller can detect a next page without COUNT(*).
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

comment on function venues_in_category_near(text, double precision, double precision, integer, integer) is
  'Tiered category browse from a (lat,lng) origin: claimed venues first, then '
  'unclaimed, each nearest→furthest (KNN over idx_venues_geo). Filtered to one '
  'canonical category group. Returns page_size+1 rows so the caller derives hasMore '
  'from the overflow row. SECURITY INVOKER so venues_read RLS (public) applies.';

grant execute on function venues_in_category_near(text, double precision, double precision, integer, integer) to anon, authenticated;

-- ============================================================================
-- Roam — 0005_venues_near_rpc.sql
-- The PostGIS near→far RPC the venues router has documented as a TODO since 0001.
-- Turns Explore from "a list" into "near me": orders venues by real geographic
-- distance from a caller-supplied origin, using the existing GiST index.
--
-- Why an RPC and not a view: distance is relative to a per-request origin (the
-- caller's location / the chosen place centre), so it can't be a static column.
-- This is the canonical place for proximity ordering — the DB does the geo maths
-- against idx_venues_geo, exactly as core/geo's comment says it should.
--
-- Index use: ORDER BY `geo <-> origin` is the PostGIS KNN operator, which the GiST
-- index (idx_venues_geo) accelerates directly. ST_Distance is computed for DISPLAY
-- (returned as distance_m), not used for ordering — ordering rides the <-> operator
-- so the index does the work. On geography, <-> and ST_Distance agree on ordering.
--
-- Security: SECURITY INVOKER (the default). The function runs as the caller, so the
-- venues_read RLS policy (`using (true)` — world-readable) applies normally and
-- anonymous browsing keeps working. We deliberately do NOT use SECURITY DEFINER:
-- there is no privilege to escalate here (venues are public), and definer functions
-- that read their own tables are exactly the footgun that caused an RLS-recursion
-- production lockout on a sibling project. Invoker is correct and safer.
-- ============================================================================

-- Params named lat/lng to match the router's documented contract
-- (rpc('venues_near', { lat, lng, limit })). Internally we build the point
-- lng-FIRST — ST_MakePoint(lng, lat) — the PostGIS axis order the seed uses.
create or replace function venues_near(
  lat         double precision,
  lng         double precision,
  max_results integer default 50
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
-- Lock search_path so the function can't be hijacked by a caller-set path.
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
  order by v.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;

comment on function venues_near(double precision, double precision, integer) is
  'Near→far venue search from a (lat,lng) origin. Orders by the PostGIS KNN operator '
  '(geo <-> origin) against idx_venues_geo; returns distance_m for display. '
  'SECURITY INVOKER so venues_read RLS (public) applies — anonymous browsing works.';

-- Execute grants: both browsing roles. anon = signed-out public browsing (the median
-- Roam experience); authenticated = signed-in users. RLS still gates row visibility;
-- these grants only permit CALLING the function.
grant execute on function venues_near(double precision, double precision, integer) to anon, authenticated;

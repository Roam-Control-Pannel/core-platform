-- 0086_venue_coords_and_review_histogram.sql
--
-- Two small reads the redesigned venue profile needs, both from data we already have:
--
-- 1) COORDINATES for the "Where to find it" map. venues.geo is PostGIS geography, which the
--    venues.byId `select *` returns as opaque WKB — unusable as lat/lng on the client. Expose
--    them as GENERATED STORED columns derived from geo (ST_Y/ST_X on the geometry cast, both
--    immutable), so every reader that already does `select *` (public profile AND the owner
--    dashboard) gets lat/lng for free, and the existing Leaflet map drops straight in.
--
-- 2) The Roam review STAR HISTOGRAM. Google's Places API returns only an average + count, never
--    a 1–5 breakdown — so the rating-distribution bars can't come from Google. They come from
--    our OWN reviews (venue_reviews, 0085), where we have every star. This RPC returns the count
--    per star (5→1), zero-filled, for the approved reviews. SECURITY INVOKER: approved reviews
--    are world-readable under venue_reviews RLS, so anon/auth both read fine.

-- ── 1. venue coordinates (generated from geo) ────────────────────────────────────────────────
alter table venues
  add column if not exists lat double precision generated always as (st_y(geo::geometry)) stored,
  add column if not exists lng double precision generated always as (st_x(geo::geometry)) stored;

comment on column venues.lat is 'Latitude, generated from geo — lets `select *` reads render a map without a spatial call.';
comment on column venues.lng is 'Longitude, generated from geo.';

-- ── 2. Roam review star histogram ────────────────────────────────────────────────────────────
create or replace function venue_review_histogram(venue_id_param uuid)
returns table (stars integer, cnt integer)
language sql
stable
security invoker
set search_path = public
as $$
  with scale as (select generate_series(1, 5) as stars)
  select scale.stars,
         coalesce(count(r.*), 0)::int as cnt
  from scale
  left join venue_reviews r
    on r.venue_id = venue_id_param
   and r.rating = scale.stars
   and r.moderation in ('auto_approved', 'approved')
  group by scale.stars
  order by scale.stars desc;
$$;

comment on function venue_review_histogram(uuid) is
  'Per-star (5→1) counts of a venue''s approved Roam reviews, zero-filled. Powers the rating '
  'distribution bars (Google gives no breakdown; Roam is the only real source). SECURITY INVOKER.';

revoke all on function venue_review_histogram(uuid) from public;
grant execute on function venue_review_histogram(uuid) to anon, authenticated, service_role;

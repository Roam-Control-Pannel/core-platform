-- Migration 0038 — geofence the local news feed to a town.
--
-- THE LOGIC (clarified with the product): every business can post into its OWN town's
-- local news feed, and a user browsing a town sees that town's feed. Before this the
-- posts.feed query was GLOBAL — a Darlington user saw every business's posts everywhere,
-- even though the UI ("the feed for {place}…") implied a town-scoped feed.
--
-- Mirrors venues_near (0005): a per-request origin (the browsing place centre) can't be a
-- static column, so proximity belongs in an RPC. We return the feed-destination, published,
-- moderation-approved posts whose VENUE sits within radius_m of the origin — i.e. the
-- businesses physically in (and immediately around) that town — newest first.
--
-- SECURITY INVOKER (like venues_near): the function runs as the caller so posts_read_public
-- (published + approved) and venues_read (public) RLS both apply normally and anonymous
-- browsing keeps working. No privilege to escalate; definer here would be the RLS-recursion
-- footgun, not a benefit.
--
-- Index use: ST_DWithin on geography is GiST-accelerated by idx_venues_geo; ordering rides
-- published_at (the feed is chronological, not distance-ranked — within a town, recency wins).

create or replace function posts_feed_near(
  lat         double precision,
  lng         double precision,
  radius_m    double precision default 25000,
  max_results integer default 50
)
returns table (
  id             uuid,
  kind           post_kind,
  title          text,
  body           text,
  published_at   timestamptz,
  venue_id       uuid,
  venue_name     text,
  venue_locality text,
  distance_m     double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    p.id,
    p.kind,
    p.title,
    p.body,
    p.published_at,
    v.id   as venue_id,
    v.name as venue_name,
    v.locality as venue_locality,
    st_distance(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography) as distance_m
  from posts p
  join venues v on v.id = p.venue_id
  where p.published_at is not null
    and p.moderation in ('auto_approved', 'approved')
    and 'feed' = any (p.destinations)
    and st_dwithin(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography, greatest(0, radius_m))
  order by p.published_at desc
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;

comment on function posts_feed_near(double precision, double precision, double precision, integer) is
  'Town-geofenced local news feed: feed-destination, published, approved posts whose venue is '
  'within radius_m of a (lat,lng) origin, newest first. SECURITY INVOKER so posts_read_public + '
  'venues_read RLS apply (anonymous browsing works). Mirrors venues_near.';

grant execute on function posts_feed_near(double precision, double precision, double precision, integer)
  to anon, authenticated;

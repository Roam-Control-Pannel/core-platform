-- Migration 0041 — surface post images in the geofenced local news feed.
--
-- Business "local posts" can now carry images (posts.media jsonb). The town feed comes from
-- posts_feed_near (0038); this re-creates that function to ALSO return media, so a post's photo
-- shows in the local news feed just as it does on the venue page. Pure additive column; same
-- filters, ordering, SECURITY INVOKER and grants as 0038.
--
-- Idempotent: create-or-replace.

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
  media          jsonb,
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
    p.media,
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

grant execute on function posts_feed_near(double precision, double precision, double precision, integer)
  to anon, authenticated;

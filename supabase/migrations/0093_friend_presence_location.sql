-- 0093_friend_presence_location.sql
--
-- Live location sharing — PR 2 of "share with friends". Extends friend_presence (0092) with an
-- EPHEMERAL, PRECISE, TIME-BOXED location: a signed-in user shares their exact position with their
-- accepted friends for a bounded window (e.g. 1h / 4h), and it auto-expires. Never permanently on.
--
-- Same privacy model as 0092, unchanged:
--   * friend_presence stays OWNER-ONLY under RLS — no friend or anon caller reads the table directly.
--   * Friends see a shared location EXCLUSIVELY through friends_nearby(), a SECURITY DEFINER function
--     gated by are_friends(auth.uid(), profile_id). There is no code path that returns a non-friend's
--     coordinate.
--
-- Two INDEPENDENT expiries by design: `expires_at` (0092) bounds the availability status; the new
-- `geo_expires_at` bounds the location share. Sharing your location never cuts short your status,
-- and vice versa. friends_nearby() filters geo_expires_at > now() SERVER-SIDE, so a stale location
-- disappears on its own with no cron — and "stop sharing" nulls the coordinate outright (nothing is
-- retained past the window). Availability is surfaced alongside a location only while ITS own expiry
-- is still live.
--
-- Idempotent; safe to run once on the Roam-Core project. Additive only (new columns + one function).

alter table friend_presence
  add column if not exists geo            geography(Point, 4326),
  add column if not exists geo_accuracy_m double precision,
  add column if not exists geo_expires_at timestamptz;

-- Spatial index for the radius filter (mirrors idx_venues_geo). Rows are one-per-active-user, so
-- this stays tiny.
create index if not exists idx_friend_presence_geo on friend_presence using gist (geo);

-- Location WRITES go through these definer functions rather than a direct PostgREST insert: the
-- point is constructed in SQL (st_makepoint), which is unambiguous, and each is hard-scoped to
-- auth.uid() so a caller can ONLY ever write their own row. They touch only the geo_* columns, so
-- sharing a location never disturbs an availability status (0092). The window is clamped 1–8h in
-- SQL as well as at the API — nothing can linger indefinitely.
create or replace function set_my_location(
  p_lat        double precision,
  p_lng        double precision,
  p_accuracy_m double precision default null,
  p_ttl_hours  double precision default 1
)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid     uuid := auth.uid();
  v_expires timestamptz := now() + make_interval(hours => greatest(1, least(8, ceil(coalesce(p_ttl_hours, 1))::int)));
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_lat is null or p_lng is null or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'invalid coordinates';
  end if;
  insert into friend_presence (profile_id, geo, geo_accuracy_m, geo_expires_at, updated_at)
  values (
    v_uid,
    st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
    p_accuracy_m,
    v_expires,
    now()
  )
  on conflict (profile_id) do update
    set geo            = excluded.geo,
        geo_accuracy_m = excluded.geo_accuracy_m,
        geo_expires_at = excluded.geo_expires_at,
        updated_at     = now();
  return v_expires;
end;
$$;

-- Stop sharing: null the coordinate outright (nothing retained past the window). Leaves any
-- availability status untouched. No-op if there's no row / nothing shared.
create or replace function stop_my_location()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update friend_presence
     set geo = null, geo_accuracy_m = null, geo_expires_at = null, updated_at = now()
   where profile_id = auth.uid();
$$;

revoke all on function set_my_location(double precision, double precision, double precision, double precision) from public, anon;
grant execute on function set_my_location(double precision, double precision, double precision, double precision) to authenticated;
revoke all on function stop_my_location() from public, anon;
grant execute on function stop_my_location() to authenticated;

-- The ONLY way to read a friend's live location. Near→far from a caller-supplied origin, gated by
-- are_friends. SECURITY DEFINER (so are_friends is callable — see 0092); auth.uid() inside still
-- resolves to the CALLER, so the gate is per-caller. The origin is computed in a CTE with no
-- friend_presence in scope, so the `origin_lat`/`origin_lng` params can't be shadowed by a column
-- (the 0089 lesson). Returns each friend's precise lat/lng (that's the point — they opted to share),
-- their distance, and their availability IF that status is itself still live.
create or replace function friends_nearby(
  origin_lat double precision,
  origin_lng double precision,
  radius_m   double precision default 5000
)
returns table (
  profile_id     uuid,
  handle         text,
  display_name   text,
  avatar_url     text,
  availability   presence_availability,
  note           text,
  lat            double precision,
  lng            double precision,
  distance_m     double precision,
  geo_expires_at timestamptz,
  updated_at     timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with origin as (
    select st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography as g
  )
  select fp.profile_id, p.handle, p.display_name, p.avatar_url,
         case when fp.expires_at is null or fp.expires_at > now() then fp.availability else null end,
         case when fp.expires_at is null or fp.expires_at > now() then fp.note else null end,
         st_y(fp.geo::geometry) as lat,
         st_x(fp.geo::geometry) as lng,
         st_distance(fp.geo, o.g) as distance_m,
         fp.geo_expires_at,
         fp.updated_at
  from friend_presence fp
  cross join origin o
  join profiles p on p.id = fp.profile_id
  where fp.geo is not null
    and fp.geo_expires_at is not null
    and fp.geo_expires_at > now()
    and st_dwithin(fp.geo, o.g, radius_m)
    and are_friends(auth.uid(), fp.profile_id)
  order by st_distance(fp.geo, o.g) asc;
$$;

-- Signed-in callers only (the are_friends gate scopes what they get back). Never anon.
revoke all on function friends_nearby(double precision, double precision, double precision) from public, anon;
grant execute on function friends_nearby(double precision, double precision, double precision) to authenticated;

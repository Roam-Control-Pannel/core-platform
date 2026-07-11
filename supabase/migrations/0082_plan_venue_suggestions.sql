-- 0082_plan_venue_suggestions.sql
--
-- "Suggestions" for a plan: nearby venues the user might add, shown on the plan page. Anchors on
-- the CENTROID of the plan's current venues (so a Liverpool plan suggests more Liverpool venues),
-- returns the nearest venues NOT already in the plan, nearest-first.
--
-- SECURITY INVOKER: the anchor CTE reads plan_venues under the caller's RLS (owner-or-member,
-- migration 0037), so only a member of the plan can compute its centroid — a non-member gets an
-- empty anchor and therefore no suggestions. venues_read / venue_photos read are public, so the
-- candidate venues read fine. No new access surface. Granted to authenticated only (plans are
-- member-gated; anon never sees a plan).
--
-- Excludes suspended venues (the only "hide me" venue_status) and any venue already in the plan.

create or replace function plan_venue_suggestions(
  plan_id_param uuid,
  max_results   integer default 6
)
returns table (
  id                 uuid,
  name               text,
  category           text,
  primary_type_label text,
  rating             numeric(2,1),
  rating_count       integer,
  distance_m         double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  with anchor as (
    -- Centroid of the plan's venues (visible only to a member via plan_venues RLS).
    select st_centroid(st_collect(v.geo::geometry))::geography as g
    from plan_venues pv
    join venues v on v.id = pv.venue_id
    where pv.plan_id = plan_id_param
  )
  select
    v.id,
    v.name,
    v.category,
    v.primary_type_label,
    v.rating,
    v.rating_count,
    st_distance(v.geo, a.g) as distance_m
  from venues v, anchor a
  where a.g is not null
    and v.status <> 'suspended'
    and v.id not in (
      select pv.venue_id from plan_venues pv where pv.plan_id = plan_id_param
    )
  order by v.geo <-> a.g
  limit greatest(1, least(coalesce(max_results, 6), 20));
$$;

comment on function plan_venue_suggestions(uuid, integer) is
  'Nearby venues to suggest for a plan: nearest to the centroid of the plan''s current venues, '
  'excluding venues already in the plan and suspended venues. SECURITY INVOKER — only a plan '
  'member can compute the anchor (plan_venues RLS), so non-members get nothing.';

revoke all on function plan_venue_suggestions(uuid, integer) from public;
grant execute on function plan_venue_suggestions(uuid, integer) to authenticated, service_role;

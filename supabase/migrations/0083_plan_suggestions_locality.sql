-- 0083_plan_suggestions_locality.sql
--
-- Fix: plan suggestions were anchored on the MEAN CENTROID of the plan's venues, which is not
-- robust to an outlier. A "Liverpool" plan that also contained one far-flung venue (e.g. a
-- stadium added in another country) had its centroid dragged a third of the way across the
-- Atlantic, so the nearest ingested venues to that skewed point were Belfast's — irrelevant to
-- the plan's actual location.
--
-- New anchor: the plan's DOMINANT LOCALITY — the town most of its venues sit in (Liverpool wins
-- 2-to-1 over the outlier). The anchor centroid is computed from ONLY the venues in that locality,
-- so the outlier can't move it; and candidates are capped to within 30 km (NEARBY_RADIUS_M) of
-- that anchor, so a suggestion is always genuinely local to the plan's real place.
--
-- Unchanged: signature/return type, SECURITY INVOKER (member-gated via plan_venues RLS), the
-- exclude-existing + exclude-suspended filters, nearest-first order. create-or-replace only.

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
  with dom as (
    -- The plan's dominant locality: the town most of its venues are in. A single out-of-area
    -- venue is the minority, so it never wins — and is excluded from the anchor below. NULL when
    -- none of the plan's venues carry a locality (then the anchor falls back to all of them).
    select (
      select v.locality
      from plan_venues pv
      join venues v on v.id = pv.venue_id
      where pv.plan_id = plan_id_param and v.locality is not null
      group by v.locality
      order by count(*) desc, v.locality
      limit 1
    ) as loc
  ),
  anchor as (
    -- Centroid of the plan's venues IN the dominant locality (all of them if no locality data),
    -- so the anchor lands on the plan's real place rather than the mean of scattered outliers.
    select st_centroid(st_collect(v.geo::geometry))::geography as g
    from plan_venues pv
    join venues v on v.id = pv.venue_id
    cross join dom
    where pv.plan_id = plan_id_param
      and (dom.loc is null or v.locality is not distinct from dom.loc)
  )
  select
    v.id,
    v.name,
    v.category,
    v.primary_type_label,
    v.rating,
    v.rating_count,
    st_distance(v.geo, a.g) as distance_m
  from venues v
  cross join anchor a
  where a.g is not null
    and v.status <> 'suspended'
    and v.id not in (
      select pv.venue_id from plan_venues pv where pv.plan_id = plan_id_param
    )
    -- Only genuinely local venues: within 30 km of the plan's place (NEARBY_RADIUS_M). This is
    -- what keeps Belfast/other-city venues out of a Liverpool plan's suggestions.
    and st_dwithin(v.geo, a.g, 30000)
  order by v.geo <-> a.g
  limit greatest(1, least(coalesce(max_results, 6), 20));
$$;

comment on function plan_venue_suggestions(uuid, integer) is
  'Nearby venues to suggest for a plan: anchored on the centroid of the plan''s venues in its '
  'DOMINANT locality (robust to an out-of-area outlier), capped to 30 km of that anchor, '
  'excluding venues already in the plan and suspended venues. SECURITY INVOKER (member-gated).';

revoke all on function plan_venue_suggestions(uuid, integer) from public;
grant execute on function plan_venue_suggestions(uuid, integer) to authenticated, service_role;

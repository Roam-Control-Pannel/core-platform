-- 0144_channel_members_search.sql
--
-- Food to Go · Phase C · Slice C2-a — the public MEMBERS DIRECTORY search.
--
-- The scale surface: search/filter/sort the channel's LIVE members server-side and page them, without
-- ever shipping the 5,000-row roster to the client. channel_members (0135) is SERVICE-MANAGED and holds
-- PII (source_email/source_phone) with NO client read policy — so the public directory reaches it only
-- through this SECURITY DEFINER function, which projects ONLY SAFE columns and only LIVE members.
--
-- **The load-bearing property (mandatory column audit at review): this function NEVER selects
-- source_email or source_phone.** Its RETURNS TABLE names exactly the public fields — the member's
-- public name + council + status, and the matched venue's world-readable basics (id/slug/name/locality/
-- rating/geo-derived distance). A definer that bypasses RLS must be trusted to leak nothing; the shape
-- is the contract and the pgTAP asserts no PII column exists on it.
--
-- Radius is a PARAMETER with a NULL = nationwide option (fixes review debt D5/D6 — the old paths fenced
-- an implicit radius). Text search is a simple ILIKE on the public name for v1 (trigram/KNN, as used by
-- venues_search_by_name, is a later refinement); the NI bbox mirrors venues_food_to_go_near (0122).
--
-- Additive; idempotent. After applying, run `notify pgrst, 'reload schema'`.

drop function if exists channel_members_search(text, text, text, double precision, double precision, double precision, integer, integer);

create function channel_members_search(
  p_channel_key text,
  p_query       text default null,
  p_council     text default null,
  p_lat         double precision default null,
  p_lng         double precision default null,
  p_radius_m    double precision default null,   -- NULL = nationwide (no distance fence)
  p_limit       integer default 25,
  p_offset      integer default 0
)
returns table (
  member_id      uuid,
  name           text,               -- source_name (the public business name; SAFE)
  council        text,               -- source_council (SAFE)
  status         text,
  venue_id       uuid,
  venue_slug     text,
  venue_name     text,
  venue_locality text,
  venue_rating   numeric,
  distance_m     double precision
)
language sql
stable
security definer
set search_path = public
as $$
  with origin as (
    select case
      when p_lat is not null and p_lng is not null
      then st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography
    end as g
  )
  select
    m.id,
    m.source_name,
    m.source_council,
    m.status,
    v.id,
    v.slug,
    v.name,
    v.locality,
    v.rating,
    case when o.g is not null and v.geo is not null then st_distance(v.geo, o.g) end as distance_m
  from channel_members m
  join channels c on c.id = m.channel_id and c.key = p_channel_key
  left join venues v on v.id = m.venue_id
  cross join origin o
  where m.status = 'live'                                             -- only live members are public
    and (p_query   is null or m.source_name ilike '%' || replace(replace(p_query, '\', '\\'), '%', '\%') || '%')
    and (p_council is null or m.source_council = p_council)
    and (
      o.g is null or p_radius_m is null                              -- nationwide when no origin/radius
      or (v.geo is not null and st_dwithin(v.geo, o.g, p_radius_m))
    )
  order by
    case when o.g is not null and v.geo is not null then st_distance(v.geo, o.g) end asc nulls last,
    m.source_name asc
  limit greatest(1, least(p_limit, 100))
  offset greatest(0, p_offset);
$$;

comment on function channel_members_search(text, text, text, double precision, double precision, double precision, integer, integer) is
  'Public members-directory search (C2). SECURITY DEFINER over the service-managed channel_members roster, projecting ONLY safe columns (name/council/status + the matched venue''s public basics) and ONLY live members — never source_email/source_phone. Radius is a parameter (NULL = nationwide). Granted to anon/authenticated for the public directory.';

-- Public directory: readable by anon + signed-in. The function''s projection + live-only filter are the
-- gate; it exposes no PII, so a broad grant is safe (mirrors venues_food_to_go_near''s public exposure).
revoke all on function channel_members_search(text, text, text, double precision, double precision, double precision, integer, integer) from public;
grant execute on function channel_members_search(text, text, text, double precision, double precision, double precision, integer, integer) to anon, authenticated;

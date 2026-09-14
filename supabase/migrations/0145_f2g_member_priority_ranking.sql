-- 0145_f2g_member_priority_ranking.sql
--
-- Food to Go · Phase D · Slice D3 — MEMBER-PRIORITY ranking in open mode.
--
-- Open mode (venues_food_to_go_near, 0122→0123) serves EVERY eligible NI food-to-go venue near the
-- point — members and non-members (Google-sourced) alike — ordered claimed-first then nearest. This
-- slice adds one tier ABOVE that: a CONFIRMED F2G MEMBER outranks a claimed non-member, which outranks
-- an unclaimed venue; nearest-first within each tier. Non-members are still served — only re-ranked.
--
-- "Confirmed member" (decision, D3) = on the Association ROSTER matched to this venue
-- (channel_members, status claimed/live) OR the owner has LISTED the venue into the channel
-- (venue_channels). Either is an affirmative "on F2G" signal.
--
-- THE LOAD-BEARING CONSTRAINT: venues_food_to_go_near is SECURITY INVOKER, and channel_members (0135)
-- is deny-by-omission with NO client policy — so an EXISTS over the roster evaluated as the anon caller
-- sees ZERO rows and the member tier would silently never fire. So the roster read is isolated in a
-- small SECURITY DEFINER helper (f2g_member_venue_ids) that projects ONLY venue_id (NO PII), joined into
-- the otherwise-unchanged invoker function. venue_channels is already world-readable.
--
-- BACKWARD-COMPATIBLE: the channel id is a NEW trailing, defaulted parameter (filter_channel_id uuid
-- default null) and is_member a NEW trailing return column (additive — like delivers in 0123). When
-- filter_channel_id is null the helper returns nothing, is_member is false for every row, and the
-- ordering collapses EXACTLY to today's claimed-first/nearest — so any caller not passing a channel id
-- (incl. the currently-deployed 4-arg API call, before its deploy) is unaffected.
--
-- Additive; idempotent. After applying, run `notify pgrst, 'reload schema'`.

-- ── the PII-free member-venue helper (the only elevated read) ──────────────────────────────────────
-- venue_ids that count as a confirmed F2G member of p_channel_id: roster (claimed/live, matched to a
-- venue) UNION owner storefront-tag (venue_channels). SECURITY DEFINER so it may read the service-
-- managed channel_members roster, but it SELECTs venue_id ONLY — never a name/email/phone. Returns no
-- rows when p_channel_id is null (the null-collapse that preserves the pre-D3 ordering).
create or replace function public.f2g_member_venue_ids(p_channel_id uuid)
returns table (venue_id uuid)
language sql
stable
security definer
set search_path = public
as $$
  select m.venue_id
    from channel_members m
   where m.channel_id = p_channel_id
     and m.venue_id is not null
     and m.status in ('claimed', 'live')
  union
  select vc.venue_id
    from venue_channels vc
   where vc.channel_id = p_channel_id;
$$;

comment on function public.f2g_member_venue_ids(uuid) is
  'D3 ranking helper: venue_ids that are confirmed F2G members of p_channel_id — roster (channel_members claimed/live, matched) UNION owner tag (venue_channels). SECURITY DEFINER so it can read the service-managed roster, but projects ONLY venue_id (no PII). Null channel → no rows. Used by venues_food_to_go_near to float members; safe to grant broadly.';

revoke all on function public.f2g_member_venue_ids(uuid) from public;
grant execute on function public.f2g_member_venue_ids(uuid) to anon, authenticated;

-- ── supersede venues_food_to_go_near with the member tier ───────────────────────────────────────────
-- Drop the exact current 4-arg signature (from 0123) and recreate with the trailing filter_channel_id
-- param + is_member column, so exactly one venues_food_to_go_near exists. Everything else — the leaf-type
-- filter, NI bbox, 18km fence, delivers/prep columns, page_size+1 overflow — is unchanged from 0123.
drop function if exists venues_food_to_go_near(double precision, double precision, integer, integer);

create function venues_food_to_go_near(origin_lat double precision, origin_lng double precision,
  page_size integer default 20, page_offset integer default 0, filter_channel_id uuid default null)
returns table (id uuid, name text, owner_id uuid, status venue_status, category text, categories text[],
  rating numeric(2,1), rating_count integer, price_level text, primary_type_label text, business_status text,
  distance_m double precision, lat_out double precision, lng_out double precision, cover_photo_id uuid,
  prep_time_mins integer, delivers boolean, is_member boolean)
language sql stable security invoker set search_path = public as $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id,
    vcs.prep_time_mins,
    coalesce(vds.delivery_enabled and not vds.paused, false) as delivers,
    (fm.venue_id is not null) as is_member
  from venues v
  left join venue_collection_settings vcs on vcs.venue_id = v.id
  left join venue_delivery_settings vds on vds.venue_id = v.id
  -- Member set for the channel, read once via the PII-free definer helper (empty when no channel id).
  left join (select venue_id from f2g_member_venue_ids(filter_channel_id)) fm on fm.venue_id = v.id
  where v.geo is not null
    -- Grab-and-go leaf types only (mirrors @roam/core/f2g FOOD_TO_GO_TYPES).
    and v.categories && array['cafe','coffee_shop','bakery','fast_food_restaurant','meal_takeaway',
      'sandwich_shop','deli','bagel_shop','donut_shop','dessert_shop','ice_cream_shop','juice_shop']::text[]
    -- Northern Ireland bounding box (mirrors @roam/core/geocode NI_BOUNDS) — excludes GB + ROI.
    and st_y(v.geo::geometry) between 54.0 and 55.45
    and st_x(v.geo::geometry) between -8.3 and -5.3
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  -- Tiers: confirmed member first, then claimed non-member, then unclaimed — nearest-first within each.
  -- With filter_channel_id null, fm is always empty → the first key is constant → today's ordering.
  order by (fm.venue_id is not null) desc,
    (v.owner_id is not null) desc,
    v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 20), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

grant execute on function venues_food_to_go_near(double precision, double precision, integer, integer, uuid)
  to anon, authenticated;

comment on function venues_food_to_go_near(double precision, double precision, integer, integer, uuid) is
  'F2G open mode (D3): NI food-to-go venues near a point by Google leaf type, NI-bbox fenced, with prep_time_mins + delivers + is_member. Ranked confirmed-member-first, then claimed, then unclaimed, nearest within each. filter_channel_id null → member tier off (collapses to the pre-D3 claimed-first/nearest ordering).';

-- 0122_f2g_food_to_go_open_mode.sql
--
-- Food to Go · Phase 6 — "open" storefront mode + the membership toggle.
--
-- The Association represents the whole NI food-to-go industry. The storefront can show its
-- vendors two ways, switchable per channel by `channels.membership_mode`:
--
--   'members' — only venues explicitly tagged into the f2g channel (venue_channels). The existing
--               venues_in_channel_near(...) RPC already serves this.
--   'open'    — every eligible NI food-to-go venue near the point, whether claimed or not, by its
--               Google leaf types. Served by the NEW venues_food_to_go_near(...) below.
--
-- Flip the mode with a single UPDATE (bottom of this file / ops runbook) — no data migration, and
-- it's instantly reversible, so the Association can decide either way after launch.
--
-- CORE SAFETY: this only ADDS a read function + a defaulted column. No core table is mutated, no
-- RLS is touched, and the function is SECURITY INVOKER granted to anon/authenticated exactly like
-- venues_in_channel_near — it reads the same venues rows Roam already exposes, just filtered.
--
-- Idempotent.

-- ── membership toggle ──────────────────────────────────────────────────────────────────────
alter table channels
  add column if not exists membership_mode text not null default 'open'
    check (membership_mode in ('open', 'members'));

comment on column channels.membership_mode is
  'How this channel''s storefront selects venues: ''open'' = all eligible venues near the point '
  '(by type), ''members'' = only venues tagged into the channel (venue_channels). Flip to switch.';

-- Make the intent explicit for f2g (default already ''open''; harmless if the column pre-existed).
update channels set membership_mode = 'open' where key = 'f2g' and membership_mode is null;

-- ── open-mode discovery ────────────────────────────────────────────────────────────────────
-- Food-to-go venues near a point, fenced to Northern Ireland (bounding box, so a search near a
-- border town can't surface a Republic-of-Ireland café), grab-and-go types only (cafés, coffee,
-- bakeries, takeaways, fast food — NOT pubs/bars/sit-down restaurants). Same return columns,
-- ordering (claimed-first, nearest) and paging as venues_in_channel_near, so the API maps both
-- identically. The food-to-go leaf set MIRRORS core FOOD_TO_GO_TYPES (@roam/core/f2g) — keep in step.

drop function if exists venues_food_to_go_near(double precision, double precision, integer, integer);

create function venues_food_to_go_near(origin_lat double precision, origin_lng double precision,
  page_size integer default 20, page_offset integer default 0)
returns table (id uuid, name text, owner_id uuid, status venue_status, category text, categories text[],
  rating numeric(2,1), rating_count integer, price_level text, primary_type_label text, business_status text,
  distance_m double precision, lat_out double precision, lng_out double precision, cover_photo_id uuid,
  prep_time_mins integer)
language sql stable security invoker set search_path = public as $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id,
    vcs.prep_time_mins
  from venues v
  left join venue_collection_settings vcs on vcs.venue_id = v.id
  where v.geo is not null
    -- Grab-and-go leaf types only (mirrors @roam/core/f2g FOOD_TO_GO_TYPES).
    and v.categories && array['cafe','coffee_shop','bakery','fast_food_restaurant','meal_takeaway',
      'sandwich_shop','deli','bagel_shop','donut_shop','dessert_shop','ice_cream_shop','juice_shop']::text[]
    -- Northern Ireland bounding box (mirrors @roam/core/geocode NI_BOUNDS) — excludes GB + ROI.
    and st_y(v.geo::geometry) between 54.0 and 55.45
    and st_x(v.geo::geometry) between -8.3 and -5.3
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  order by (v.owner_id is not null) desc,
    v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 20), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

grant execute on function venues_food_to_go_near(double precision, double precision, integer, integer)
  to anon, authenticated;

comment on function venues_food_to_go_near(double precision, double precision, integer, integer) is
  'F2G Phase 6 (open mode): NI food-to-go venues near a point by Google leaf type (cafés, coffee, '
  'bakeries, takeaways, fast food), NI-bbox fenced, claimed-first/nearest, with prep_time_mins.';

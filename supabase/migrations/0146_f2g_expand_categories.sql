-- 0146_f2g_expand_categories.sql
--
-- Food to Go — expand the open-mode eligible leaf set with cuisine TAKEAWAY types (Chinese, Indian,
-- pizza/pasta, kebab, burgers, chippy, Thai, Mexican, sushi, …). Recreates venues_food_to_go_near
-- with the widened `categories &&` array — SAME 5-arg signature as 0145, so a plain create-or-replace
-- (no drop, no grant change). The array MUST mirror @roam/core/f2g FOOD_TO_GO_TYPES exactly.
--
-- The broad `restaurant` leaf is deliberately NOT added (it would pull in all sit-down/fine dining);
-- drink-led leaves (pub/bar/wine_bar/beer_garden) stay out too — F2G is food-to-go.
--
-- NOTE: existing venues only carry these leaves once a RE-INGEST runs with the widened
-- FOOD_TO_GO_SEARCH_TYPES (scripts/reingest-food-to-go.mjs). This migration makes them ELIGIBLE to
-- show; the re-ingest is what supplies them. Idempotent. After applying, run `notify pgrst, 'reload schema'`.

create or replace function venues_food_to_go_near(origin_lat double precision, origin_lng double precision,
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
  left join (select venue_id from f2g_member_venue_ids(filter_channel_id)) fm on fm.venue_id = v.id
  where v.geo is not null
    -- Grab-and-go + cuisine takeaway leaves (mirrors @roam/core/f2g FOOD_TO_GO_TYPES — keep in lockstep).
    and v.categories && array[
      'cafe','coffee_shop','bakery','fast_food_restaurant','meal_takeaway',
      'sandwich_shop','deli','bagel_shop','donut_shop','dessert_shop','ice_cream_shop','juice_shop',
      'american_restaurant','asian_fusion_restaurant','chinese_restaurant','indian_restaurant',
      'italian_restaurant','japanese_restaurant','mexican_restaurant','middle_eastern_restaurant',
      'seafood_restaurant','sushi_restaurant','thai_restaurant','vegan_restaurant','vegetarian_restaurant'
    ]::text[]
    -- Northern Ireland bounding box (mirrors @roam/core/geocode NI_BOUNDS) — excludes GB + ROI.
    and st_y(v.geo::geometry) between 54.0 and 55.45
    and st_x(v.geo::geometry) between -8.3 and -5.3
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  order by (fm.venue_id is not null) desc,
    (v.owner_id is not null) desc,
    v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 20), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;

comment on function venues_food_to_go_near(double precision, double precision, integer, integer, uuid) is
  'F2G open mode: NI food-to-go venues near a point by Google leaf type (grab-and-go + cuisine takeaways, 0146), NI-bbox fenced, with prep_time_mins + delivers + is_member. Ranked member-first, then claimed, then unclaimed, nearest within each. filter_channel_id null → member tier off.';

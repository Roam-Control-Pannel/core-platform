-- 0123_f2g_delivery.sql
--
-- Food to Go Marketplace · Phase 7 · Delivery — a claimed venue's DELIVER-TO-YOU capability, a
-- per-order delivery lifecycle, and multi-item orders (a cart).
--
-- Adds delivery ALONGSIDE the existing order-ahead & collect flow (0117 / 0119) without disturbing
-- it: a collection order keeps behaving exactly as before. Three parts:
--
--   1. venue_delivery_settings — the vendor's delivery capability & rules (1:1 side table, mirrors
--      venue_collection_settings 0117): enabled, paused, a flat fee, a minimum order, a delivery
--      AREA expressed as a radius and/or a postcode allow/block list, an ETA, and a driver note.
--   2. orders — a fulfilment_type axis (collection|delivery), a flat delivery_fee_pence, a
--      delivery_address, delivery-lifecycle timestamps, and two new statuses
--      (out_for_delivery, delivered).
--   3. order_items — one row per basket line, so a delivery order can hold several items under a
--      SINGLE delivery fee and minimum-order threshold (there was no cart before). Collection
--      orders may use it too; the legacy inline product_* columns on orders stay set to a summary
--      for back-compat with existing single-item reads.
--
-- The delivery fee is the vendor's to keep: platform commission (application_fee_pence) is computed
-- on the goods subtotal only, never on the delivery fee.
--
-- Idempotent; safe to run once. After applying, regenerate the DB types:  pnpm db:types
-- Until then (and as the rest of F2G already does) core reads these tables via the loose client
-- cast the way getCollectionSettings does, and the API reads orders/order_items via LooseDb.

-- ── 1. venue_delivery_settings ────────────────────────────────────────────────────────────────
create table if not exists venue_delivery_settings (
  venue_id            uuid primary key references venues(id) on delete cascade,
  -- Standing capability: does this venue deliver at all.
  delivery_enabled    boolean not null default false,
  -- Temporary shutoff (kitchen slammed / no driver right now); distinct from delivery_enabled the
  -- same way venue_collection_settings.paused is distinct from order_ahead.
  paused              boolean not null default false,
  -- Flat fee added to the order total; the vendor keeps it in full (platform commission is on the
  -- goods subtotal only). 0 = free delivery. Capped like a product price.
  delivery_fee_pence  integer not null default 0 check (delivery_fee_pence >= 0 and delivery_fee_pence <= 5000000),
  -- Minimum goods subtotal (EXCLUDING the delivery fee) required to order for delivery. 0 = none.
  min_order_pence     integer not null default 0 check (min_order_pence >= 0 and min_order_pence <= 5000000),
  -- Delivery AREA, part 1: max straight-line distance from the venue, in metres. NULL = no radius
  -- limit (rely on the postcode allow-list instead). 0..50 km.
  radius_m            integer check (radius_m >= 0 and radius_m <= 50000),
  -- Delivery AREA, part 2: postcode-district overrides (upper-cased, e.g. 'BT1','BT2'). allow =
  -- also deliver here even if outside the radius; block = never deliver here even if inside it.
  postcode_allow      text[] not null default '{}',
  postcode_block      text[] not null default '{}',
  -- Typical minutes from order to delivered (prep + travel). 0..240. Shown as the buyer's ETA.
  eta_mins            integer not null default 45 check (eta_mins between 0 and 240),
  -- Free-text note for the buyer ("we deliver Fri–Sun evenings"). Short by design.
  delivery_notes      text check (char_length(delivery_notes) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

drop trigger if exists venue_delivery_settings_updated_at on venue_delivery_settings;
create trigger venue_delivery_settings_updated_at
  before update on venue_delivery_settings
  for each row execute function set_updated_at();

alter table venue_delivery_settings enable row level security;

-- Public read: fee / minimum / area / eta are operational info the storefront shows to shoppers;
-- nothing sensitive. (A venue with no row simply uses the app-layer defaults — delivery off.)
drop policy if exists venue_delivery_settings_read on venue_delivery_settings;
create policy venue_delivery_settings_read on venue_delivery_settings
  for select using (true);

-- Owner writes, only while the venue is claimed — same gate as venue_collection_settings (0117).
drop policy if exists venue_delivery_settings_owner_write on venue_delivery_settings;
create policy venue_delivery_settings_owner_write on venue_delivery_settings
  for all
  using (
    exists (
      select 1 from venues v
      where v.id = venue_delivery_settings.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
  )
  with check (
    exists (
      select 1 from venues v
      where v.id = venue_delivery_settings.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
  );

comment on table venue_delivery_settings is
  'F2G deliver-to-you capability per venue (Phase 7). 1:1 with venues; owner-writable while claimed, public-read. Delivery area = radius_m and/or postcode_allow, minus postcode_block; flat fee is the vendors to keep (commission is on goods only).';

-- ── 2. orders: fulfilment axis, delivery fee/address, lifecycle timestamps, statuses ──────────
-- Fulfilment axis, orthogonal to product_kind. 'collection' keeps every existing order valid.
alter table orders add column if not exists fulfilment_type text not null default 'collection'
  check (fulfilment_type in ('collection', 'delivery'));
-- Flat delivery fee charged on this order (0 for collection). Part of the Stripe total; the vendor
-- keeps it — application_fee_pence is computed on the goods subtotal only.
alter table orders add column if not exists delivery_fee_pence integer not null default 0
  check (delivery_fee_pence >= 0);
-- Where to deliver: {line1,line2,locality,postcode,notes,lat,lng}. NULL for collection orders.
alter table orders add column if not exists delivery_address jsonb;
-- Delivery lifecycle timestamps (parallel to ready_at for collection). eta is stamped at checkout;
-- the other two are stamped by the vendor's advance actions.
alter table orders add column if not exists delivery_eta_at timestamptz;
alter table orders add column if not exists out_for_delivery_at timestamptz;
alter table orders add column if not exists delivered_at timestamptz;

-- Extend the status domain with the two delivery states. Re-add the whole set (0119 pattern). The
-- lifecycle becomes:  pending → paid → (collection) ready → collected
--                                    → (delivery)   out_for_delivery → delivered;  refunded / canceled as before.
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('pending', 'paid', 'ready', 'out_for_delivery', 'delivered',
                    'collected', 'redeemed', 'refunded', 'canceled'));

comment on column orders.fulfilment_type is
  'F2G: how this order is fulfilled — collection (default; picked up in venue) or delivery (dropped to delivery_address). Orthogonal to product_kind.';
comment on column orders.delivery_address is
  'F2G delivery orders: {line1,line2,locality,postcode,notes,lat,lng}. NULL for collection.';

-- ── 3. order_items: multi-line basket (the cart) ──────────────────────────────────────────────
create table if not exists order_items (
  id                uuid primary key default gen_random_uuid(),
  order_id          uuid not null references orders(id) on delete cascade,
  product_id        uuid references venue_products(id) on delete set null,
  product_title     text not null,
  unit_price_pence  integer not null check (unit_price_pence >= 0),
  quantity          integer not null default 1 check (quantity between 1 and 20),
  created_at        timestamptz not null default now()
);

create index if not exists order_items_order_idx on order_items (order_id);

alter table order_items enable row level security;

-- Reads inherit the parent order's visibility: the buyer sees their order's lines; the venue owner
-- sees their venue's order lines. NO client writes (orders + items are written by the API service
-- role, mirroring orders 0071).
drop policy if exists order_items_buyer_read on order_items;
create policy order_items_buyer_read on order_items
  for select using (
    exists (select 1 from orders o where o.id = order_items.order_id and o.buyer_id = auth.uid())
  );

drop policy if exists order_items_owner_read on order_items;
create policy order_items_owner_read on order_items
  for select using (
    exists (
      select 1 from orders o
      join venues v on v.id = o.venue_id
      where o.id = order_items.order_id and v.owner_id = auth.uid()
    )
  );

comment on table order_items is
  'F2G cart: one row per basket line for an order. The order header amount_pence = sum of line totals (goods subtotal); one delivery fee + minimum-order apply to the whole basket. Service-write only; reads inherit the parent order visibility.';

-- ── 4. venues_food_to_go_near: expose a `delivers` flag for storefront badges ─────────────────
-- Extend the open-mode discovery RPC (0122) to also return whether the venue currently offers
-- delivery (enabled and not paused), so the storefront can badge "Delivers" without a second query.
-- Same signature and behaviour otherwise; the extra trailing column is additive for existing readers.
drop function if exists venues_food_to_go_near(double precision, double precision, integer, integer);

create function venues_food_to_go_near(origin_lat double precision, origin_lng double precision,
  page_size integer default 20, page_offset integer default 0)
returns table (id uuid, name text, owner_id uuid, status venue_status, category text, categories text[],
  rating numeric(2,1), rating_count integer, price_level text, primary_type_label text, business_status text,
  distance_m double precision, lat_out double precision, lng_out double precision, cover_photo_id uuid,
  prep_time_mins integer, delivers boolean)
language sql stable security invoker set search_path = public as $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id,
    vcs.prep_time_mins,
    coalesce(vds.delivery_enabled and not vds.paused, false) as delivers
  from venues v
  left join venue_collection_settings vcs on vcs.venue_id = v.id
  left join venue_delivery_settings vds on vds.venue_id = v.id
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
  'F2G open mode: NI food-to-go venues near a point by Google leaf type, NI-bbox fenced, claimed-first/nearest, with prep_time_mins and a delivers flag (Phase 7).';

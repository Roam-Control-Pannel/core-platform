-- 0117_venue_collection_settings.sql
--
-- Food to Go Marketplace · Phase 1 · Supply — a claimed venue's ORDER-AHEAD & COLLECT capability.
--
-- The F2G promise is "order ahead, skip the queue, collect". A vendor configures that capability
-- here as part of going live: whether they take order-ahead at all, their typical prep time (used
-- later to compute an order's ready-at), a temporary "paused" switch for when the kitchen is
-- slammed, and free-text collection instructions ("collect from the till by the window").
--
-- Venue-scoped: a venue has ONE physical collection point regardless of channel, so this is a
-- 1:1 side table on venues rather than per channel membership. Only the F2G storefront reads it
-- today, but the capability is not F2G-specific by nature. Per-ORDER scheduling (the ready-at
-- ticket, collection slots) is Phase 3 · Orders — deliberately NOT here.
--
-- Idempotent; safe to run once. After applying, regenerate the DB types:  pnpm db:types

create table if not exists venue_collection_settings (
  venue_id                uuid primary key references venues(id) on delete cascade,
  -- Does this venue accept order-ahead-and-collect at all.
  order_ahead             boolean not null default true,
  -- Temporary shutoff the vendor flips when they can't take more orders right now. Distinct from
  -- order_ahead (the standing capability); paused is the "we're slammed / closed early" switch.
  paused                  boolean not null default false,
  -- Typical minutes from order to ready. 0–240; the storefront shows "usually ready in ~N min"
  -- and Phase 3 uses it to stamp an order's ready-at.
  prep_time_mins          integer not null default 15 check (prep_time_mins between 0 and 240),
  -- How/where to collect. Shown on the order confirmation + storefront. Short by design.
  collection_instructions text check (char_length(collection_instructions) <= 500),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

drop trigger if exists venue_collection_settings_updated_at on venue_collection_settings;
create trigger venue_collection_settings_updated_at
  before update on venue_collection_settings
  for each row execute function set_updated_at();

alter table venue_collection_settings enable row level security;

-- Public read: prep time / paused / instructions are operational info the storefront shows to
-- shoppers; nothing sensitive. (A venue with no row simply uses the app-layer defaults.)
drop policy if exists venue_collection_settings_read on venue_collection_settings;
create policy venue_collection_settings_read on venue_collection_settings
  for select using (true);

-- Owner writes, only while the venue is claimed — same gate as venue_products (0070).
drop policy if exists venue_collection_settings_owner_write on venue_collection_settings;
create policy venue_collection_settings_owner_write on venue_collection_settings
  for all
  using (
    exists (
      select 1 from venues v
      where v.id = venue_collection_settings.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
  )
  with check (
    exists (
      select 1 from venues v
      where v.id = venue_collection_settings.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
  );

comment on table venue_collection_settings is
  'F2G order-ahead & collect capability per venue (Phase 1 Supply). 1:1 with venues; owner-writable while claimed, public-read. Per-order scheduling is Phase 3, not here.';

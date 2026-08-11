-- 0119_orders_collection.sql
--
-- Food to Go Marketplace · Phase 3 · Orders — the per-order collection lifecycle.
--
-- Order-ahead-and-collect needs two things on an order that 0071 didn't model:
--   ready_at  — the estimated ready-for-collection time, stamped at checkout as now + the venue's
--               prep_time_mins (venue_collection_settings, 0117). Shown to the buyer as their
--               collection ticket's ETA.
--   'ready'   — a new status the vendor flips when the order is actually prepared, so the buyer
--               gets a "ready to collect" ping. Optional: a vendor may still go paid → collected
--               directly (the API's fulfil accepts both paid and ready).
--
-- The collection CODE itself reuses the existing redeem_code (the API now mints it for products
-- too, not just vouchers), so no new code column. The lifecycle becomes:
--   pending → paid → ready → collected (product) / redeemed (service);  refunded / canceled as before.
--
-- Idempotent; safe to run once. (orders isn't in the generated DB types — the API uses LooseDb.)

alter table orders add column if not exists ready_at timestamptz;

-- Extend the status domain with 'ready'. The 0071 inline check is named orders_status_check.
alter table orders drop constraint if exists orders_status_check;
alter table orders add constraint orders_status_check
  check (status in ('pending', 'paid', 'ready', 'collected', 'redeemed', 'refunded', 'canceled'));

comment on column orders.ready_at is
  'F2G: estimated ready-for-collection time (checkout time + venue prep_time_mins). The vendor '
  '"mark ready" action (status=ready) is the real signal; this is the ETA shown on the ticket.';

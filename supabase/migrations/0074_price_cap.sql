-- 0074_price_cap.sql
--
-- Marketplace UX D: tighten the venue-product price ceiling from £50,000 to £9,999 —
-- matching the "most expensive product under $10,000" profile declared to Stripe at
-- Connect signup. The API's zod bound drops in lockstep; existing rows are unaffected
-- (nothing above the new cap exists). Idempotent; run once.

alter table venue_products drop constraint if exists venue_products_price_pence_check;
alter table venue_products add constraint venue_products_price_pence_check
  check (price_pence >= 50 and price_pence <= 999900);

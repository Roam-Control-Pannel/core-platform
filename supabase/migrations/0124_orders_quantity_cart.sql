-- 0124_orders_quantity_cart.sql
--
-- Fix: the Food to Go CART (0123) stores the SUMMED line count in the order header `quantity`
-- (a denormalised total; the real per-line quantities live in order_items, each still 1..20). The
-- 0071 single-item-era check constrained the header `quantity` to 1..20, so any basket whose items
-- summed above 20 (e.g. 15 coffees + 15 pastries) failed the orders insert and blocked checkout
-- with "Couldn't start checkout" — no Stripe session ever created.
--
-- Relax the header check to the cart's real maximum (checkoutCart caps at 50 lines × 20 = 1000).
-- Per-line quantities keep their own 1..20 check on order_items (0123). Idempotent.

alter table orders drop constraint if exists orders_quantity_check;
alter table orders add constraint orders_quantity_check
  check (quantity between 1 and 1000);

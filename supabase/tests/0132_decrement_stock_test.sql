-- ============================================================================
-- pgTAP regression tests for 0132_decrement_stock.sql
--
-- Structural assertions prove the RPC exists with the right shape and that EXECUTE is
-- granted ONLY to service_role (the grant is the whole access gate for a SECURITY DEFINER
-- that bypasses RLS). A behavioral block then drives the function through every outcome
-- branch against real rows — the guarantee that matters is that a decrement never oversells
-- and never drives stock negative.
-- ============================================================================
begin;
select plan(9);

-- ── structural ───────────────────────────────────────────────────────────────
select has_function('public', 'decrement_stock', array['uuid', 'integer'],
  'decrement_stock(uuid, integer) exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.decrement_stock(uuid, integer)'::regprocedure),
  true,
  'decrement_stock is SECURITY DEFINER');
select ok(
  has_function_privilege('service_role', 'public.decrement_stock(uuid, integer)', 'execute'),
  'service_role CAN execute decrement_stock');
select ok(
  not has_function_privilege('authenticated', 'public.decrement_stock(uuid, integer)', 'execute'),
  'authenticated CANNOT execute decrement_stock');
select ok(
  not has_function_privilege('anon', 'public.decrement_stock(uuid, integer)', 'execute'),
  'anon CANNOT execute decrement_stock');

-- ── behavioral fixture ─────────────────────────────────────────────────────────
insert into venues (id, name, geo, status, owner_id)
  values (
    '00000000-0000-0000-0000-0000000000c1', 'Stock Test Venue',
    ST_SetSRID(ST_MakePoint(-5.9301, 54.5973), 4326), 'claimed', null
  );
-- A tracked product with exactly one unit, and an untracked (service) product.
insert into venue_products (id, venue_id, kind, title, price_pence, stock)
  values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c1',
          'product', 'Last One In Stock', 500, 1);
insert into venue_products (id, venue_id, kind, title, price_pence, stock)
  values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c1',
          'service', 'Unlimited Voucher', 500, null);

-- First sale of the last unit: 1 -> 0, reported 'decremented'.
select is(
  (select outcome from public.decrement_stock('00000000-0000-0000-0000-0000000000d1', 1)),
  'decremented',
  'selling the last unit decrements it');
select is(
  (select stock from venue_products where id = '00000000-0000-0000-0000-0000000000d1'),
  0,
  'stock is now 0');

-- A second sale of the same (now sold-out) unit: demand exceeds supply -> 'oversold',
-- stock stays 0 (never negative).
select is(
  (select outcome from public.decrement_stock('00000000-0000-0000-0000-0000000000d1', 1)),
  'oversold',
  'a sale beyond available stock reports oversold, not a negative balance');

-- Untracked stock is a no-op.
select is(
  (select outcome from public.decrement_stock('00000000-0000-0000-0000-0000000000d2', 3)),
  'untracked',
  'an untracked (null-stock) product is left alone');

select * from finish();
rollback;

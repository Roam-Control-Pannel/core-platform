-- ============================================================================
-- pgTAP regression tests for 0149_orders_channel_fee.sql
--
-- Load-bearing properties: the two columns exist with the seeded fees (f2g 7%, roam 5%); the fee
-- bound holds; order_channel_for_venue() resolves roster member → tag → default, in that order, and
-- is unreachable by client roles (the fee is money — only the service client may ask).
-- ============================================================================
begin;
select plan(11);

-- ── structural ───────────────────────────────────────────────────────────────
select has_column('public', 'channels', 'platform_fee_bps', 'channels.platform_fee_bps exists');
select has_column('public', 'orders', 'channel_id', 'orders.channel_id exists');
select has_function('public', 'order_channel_for_venue', array['uuid'], 'order_channel_for_venue(uuid) exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.order_channel_for_venue(uuid)'::regprocedure),
  true, 'order_channel_for_venue is SECURITY DEFINER (it must read the RLS-locked roster)');

-- ── seeds ────────────────────────────────────────────────────────────────────
select is((select platform_fee_bps from channels where key = 'f2g'), 700, 'f2g carries a 7% fee');
select is((select platform_fee_bps from channels where key = 'roam'), 500, 'roam keeps the 5% default');
select throws_ok(
  $$ update channels set platform_fee_bps = 3001 where key = 'f2g' $$,
  '23514', null, 'the fee is bounded (0–3000 bps)');

-- ── fixtures (as the test/owner role: bypasses RLS + the roster guard) ─────────
insert into venues (id, name, geo, status, owner_id, categories) values
  ('00000000-0000-0000-0000-0000000e4901', 'Plain Cafe',
   ST_SetSRID(ST_MakePoint(-5.9300, 54.6000), 4326), 'unclaimed', null, array['cafe']),
  ('00000000-0000-0000-0000-0000000e4902', 'Tagged Cafe',
   ST_SetSRID(ST_MakePoint(-5.9310, 54.6010), 4326), 'unclaimed', null, array['cafe']),
  ('00000000-0000-0000-0000-0000000e4903', 'Roster Cafe',
   ST_SetSRID(ST_MakePoint(-5.9320, 54.6020), 4326), 'unclaimed', null, array['cafe']);

insert into venue_channels (channel_id, venue_id)
  select id, '00000000-0000-0000-0000-0000000e4902' from channels where key = 'f2g';

insert into channel_members (channel_id, source_name, membership_ref, venue_id, status)
  select id, 'Roster Cafe', 'F2G-0149-TEST', '00000000-0000-0000-0000-0000000e4903', 'claimed'
    from channels where key = 'f2g';

-- ── resolution ───────────────────────────────────────────────────────────────
select is(
  (select channel_key || ':' || platform_fee_bps from order_channel_for_venue('00000000-0000-0000-0000-0000000e4901')),
  'roam:500', 'a venue in no channel resolves to the default channel at 5%');
select is(
  (select channel_key || ':' || platform_fee_bps from order_channel_for_venue('00000000-0000-0000-0000-0000000e4902')),
  'f2g:700', 'a venue tagged into f2g resolves to f2g at 7%');
select is(
  (select channel_key || ':' || platform_fee_bps from order_channel_for_venue('00000000-0000-0000-0000-0000000e4903')),
  'f2g:700', 'a roster member (claimed) resolves to f2g at 7% without a tag');

-- ── client roles cannot ask ──────────────────────────────────────────────────
create temp table _oc (k text primary key, v boolean);
do $$
declare
  anon_blocked boolean := false;
  auth_blocked boolean := false;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    perform * from order_channel_for_venue('00000000-0000-0000-0000-0000000e4902');
  exception when insufficient_privilege then anon_blocked := true; end;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000e49ff","role":"authenticated"}', true);
  begin
    perform * from order_channel_for_venue('00000000-0000-0000-0000-0000000e4902');
  exception when insufficient_privilege then auth_blocked := true; end;

  perform set_config('role', 'postgres', true);
  insert into _oc values ('anon', anon_blocked), ('auth', auth_blocked);
end $$;
select ok((select v from _oc where k = 'anon') and (select v from _oc where k = 'auth'),
  'neither anon nor authenticated may execute order_channel_for_venue (service-only)');

select * from finish();
rollback;

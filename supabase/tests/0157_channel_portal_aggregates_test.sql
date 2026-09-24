-- ============================================================================
-- pgTAP regression tests for 0157_channel_portal_aggregates.sql
--
-- These RPCs are SECURITY DEFINER over service-managed data and reachable directly through
-- PostgREST, so the API's gate is not between them and a caller. The property under test is that
-- each one refuses on its own: an officer of channel A asking about channel B gets NO ROWS, not
-- B's numbers and not a misleading row of zeros. The arithmetic is checked too, but the refusal is
-- the reason this file exists.
-- ============================================================================
begin;
select plan(16);

select has_function('public', 'channel_portal_overview', array['uuid'], 'overview exists');
select has_function('public', 'channel_portal_members_by_council', array['uuid'], 'members-by-council exists');
select has_function('public', 'channel_portal_orders', array['uuid', 'timestamptz', 'timestamptz'], 'orders totals exist');
select has_function('public', 'channel_portal_orders_by_venue', array['uuid', 'timestamptz', 'timestamptz'], 'orders-by-venue exists');

select ok(
  not has_function_privilege('anon', 'public.channel_portal_overview(uuid)', 'execute'),
  'anon cannot execute the overview — an anonymous caller has no appointment to check');

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into channels (key, name, is_default, platform_fee_bps) values
  ('test-pa-a-0157', 'Portal A', false, 700),
  ('test-pa-b-0157', 'Portal B', false, 700);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000015701a', 'officer-a@pa.example'),   -- officer of A only
  ('00000000-0000-0000-0000-00000015701b', 'officer-b@pb.example');   -- officer of B only

insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000015701a', 'officer' from channels where key = 'test-pa-a-0157';
insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000015701b', 'officer' from channels where key = 'test-pa-b-0157';

-- Two venues in channel A, both live members. One carries a real FSA rating, one an
-- AwaitingInspection status — which must NOT count as rated.
insert into venues (id, name, geo, status, categories) values
  ('00000000-0000-0000-0000-000000015701', 'Rated Cafe',   st_setsrid(st_makepoint(-5.93, 54.60), 4326)::geography, 'claimed', array['cafe']),
  ('00000000-0000-0000-0000-000000015702', 'Unrated Cafe', st_setsrid(st_makepoint(-5.94, 54.61), 4326)::geography, 'claimed', array['cafe']);

insert into channel_members (channel_id, source_name, membership_ref, venue_id, status, source_council)
  select id, 'Rated Cafe', 'PA-0157-1', '00000000-0000-0000-0000-000000015701', 'live', 'Belfast'
    from channels where key = 'test-pa-a-0157';
insert into channel_members (channel_id, source_name, membership_ref, venue_id, status, source_council)
  select id, 'Unrated Cafe', 'PA-0157-2', '00000000-0000-0000-0000-000000015702', 'live', 'Belfast'
    from channels where key = 'test-pa-a-0157';
-- An imported (not yet live) member: counted in the funnel, absent from the member-venue set.
insert into channel_members (channel_id, source_name, membership_ref, status)
  select id, 'Not Yet Live', 'PA-0157-3', 'imported' from channels where key = 'test-pa-a-0157';

insert into fsa_establishments (fhrsid, business_name, rating_value, local_authority) values
  ('PA0157-R', 'Rated Cafe',   '5',                 'Belfast'),
  ('PA0157-U', 'Unrated Cafe', 'AwaitingInspection', 'Belfast');
insert into external_refs (entity_type, entity_id, dataset, external_id, method) values
  ('venue', '00000000-0000-0000-0000-000000015701', 'fsa', 'PA0157-R', 'auto'),
  ('venue', '00000000-0000-0000-0000-000000015702', 'fsa', 'PA0157-U', 'auto');

-- Orders on channel A: two paid (counted), one pending (not), one refunded (counted separately).
insert into orders (venue_id, product_title, product_kind, amount_pence, application_fee_pence, delivery_fee_pence, status, channel_id)
  select '00000000-0000-0000-0000-000000015701', 'Lunch', 'product', 1000, 70, 200, 'paid', id
    from channels where key = 'test-pa-a-0157';
insert into orders (venue_id, product_title, product_kind, amount_pence, application_fee_pence, delivery_fee_pence, status, channel_id)
  select '00000000-0000-0000-0000-000000015701', 'Lunch', 'product', 2000, 140, 0, 'collected', id
    from channels where key = 'test-pa-a-0157';
insert into orders (venue_id, product_title, product_kind, amount_pence, application_fee_pence, status, channel_id)
  select '00000000-0000-0000-0000-000000015702', 'Abandoned', 'product', 5000, 350, 'pending', id
    from channels where key = 'test-pa-a-0157';
insert into orders (venue_id, product_title, product_kind, amount_pence, application_fee_pence, status, channel_id)
  select '00000000-0000-0000-0000-000000015702', 'Returned', 'product', 900, 63, 'refunded', id
    from channels where key = 'test-pa-a-0157';

create temporary table _pa (name text primary key, ok boolean) on commit drop;

do $$
declare
  ch_a uuid; ch_b uuid;
  live_n int; rated_n int; venues_n int; imported_n int;
  ord_n int; gmv bigint; fees bigint; refunds int;
  by_venue_rows int; council_rows int; council_top text;
  cross_overview int; cross_council int; cross_orders int; cross_by_venue int;
begin
  select id into ch_a from channels where key = 'test-pa-a-0157';
  select id into ch_b from channels where key = 'test-pa-b-0157';

  -- ── officer A, signed in for real, asking about their OWN channel ──────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000015701a","role":"authenticated"}', true);

  select members_live, member_venues_rated, member_venues, members_imported
    into live_n, rated_n, venues_n, imported_n
    from public.channel_portal_overview(ch_a);

  select orders_count, gmv_pence, fees_pence, refunded_count
    into ord_n, gmv, fees, refunds
    from public.channel_portal_orders(ch_a, null, null);

  select count(*)::int into by_venue_rows from public.channel_portal_orders_by_venue(ch_a, null, null);
  select count(*)::int into council_rows from public.channel_portal_members_by_council(ch_a);
  select council into council_top from public.channel_portal_members_by_council(ch_a) limit 1;

  -- ── the SAME officer asking about somebody else's channel ─────────────────
  select count(*)::int into cross_overview from public.channel_portal_overview(ch_b);
  select count(*)::int into cross_council  from public.channel_portal_members_by_council(ch_b);
  select count(*)::int into cross_orders   from public.channel_portal_orders(ch_b, null, null);
  select count(*)::int into cross_by_venue from public.channel_portal_orders_by_venue(ch_b, null, null);

  perform set_config('role', 'postgres', true);
  insert into _pa values
    ('live_two',        live_n = 2),
    ('imported_one',    imported_n = 1),
    ('venues_two',      venues_n = 2),
    ('rated_one',       rated_n = 1),
    ('orders_two',      ord_n = 2),
    ('gmv_3200',        gmv = 3200),
    ('fees_210',        fees = 210),
    ('refunds_one',     refunds = 1),
    ('by_venue_one',    by_venue_rows = 1),
    ('council_one_row', council_rows = 1 and council_top = 'Belfast'),
    ('cross_all_empty', cross_overview = 0 and cross_council = 0
                        and cross_orders = 0 and cross_by_venue = 0);
end $$;

select ok((select ok from _pa where name = 'live_two'),     'the funnel counts the two live members');
select ok((select ok from _pa where name = 'imported_one'), 'and the imported one, which is not yet a member venue');
select ok((select ok from _pa where name = 'venues_two'),   'both live members contribute a member venue');
select ok((select ok from _pa where name = 'rated_one'),
  'only the venue with a 0-5 rating counts as rated — AwaitingInspection is a status, not a 0');
select ok((select ok from _pa where name = 'orders_two'),
  'paid and collected count as sales; the pending checkout does not');
select ok((select ok from _pa where name = 'gmv_3200'),
  'GMV includes the delivery fee: (1000+200) + (2000+0) = 3200');
select ok((select ok from _pa where name = 'fees_210'), 'platform fees sum over counted orders only (70+140)');
select ok((select ok from _pa where name = 'refunds_one'),
  'refunds are reported separately rather than netted off GMV');
select ok((select ok from _pa where name = 'by_venue_one'),
  'per-venue totals cover only venues with counted orders');
select ok((select ok from _pa where name = 'council_one_row'),
  'members group under the council of record');

-- THE one this file exists for.
select ok((select ok from _pa where name = 'cross_all_empty'),
  'an officer of A gets NO ROWS from all four RPCs when asking about channel B — not B''s numbers, '
  'and not a row of zeros that would read as a quiet week');

select * from finish();
rollback;

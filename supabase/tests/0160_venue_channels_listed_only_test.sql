-- ============================================================================
-- pgTAP regression tests for 0160_venue_channels_listed_only.sql
--
-- The defect 0160 closed: from 0154 until that migration, a venue owner listing their own venue on
-- the storefront became a channel MEMBER — priority ranking, member badge, members directory —
-- because `role` defaulted to 'member' and the self-serve insert omitted it. An owner could also set
-- 'member' outright, since the write policy constrained the venue but not the role.
--
-- NARROWED BY 0161. 0160 kept `venue_channels_owner_write` and narrowed it to `role = 'listed'`;
-- that was the right emergency fix while the escalation was live, but it still let an owner write
-- the table directly through PostgREST, into any channel, bypassing the region fence that lives in
-- the router. 0161 removes the policy outright, so THERE IS NO CLIENT-WRITABLE PATH at all — and
-- every assertion about what a client credential may write now lives in 0161's test, where it can be
-- stated in its final form instead of an interim one.
--
-- What remains here is what 0160 itself owns and 0161 does not touch: the column has no default, so
-- a write that omits the role fails loudly rather than silently conferring membership; and 'listed'
-- is genuinely outside the canonical membership predicate.
-- ============================================================================
begin;
select plan(5);

select is(
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'venue_channels' and column_name = 'role'),
  null,
  'role has NO default — an insert that omits it fails rather than granting membership');

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into channels (key, name, is_default) values ('test-vc-0160', 'VC Channel', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000016001a', 'owner@vc.example');

insert into venues (id, name, geo, status, categories, owner_id) values
  ('00000000-0000-0000-0000-000000016001', 'Listed Cafe',
   st_setsrid(st_makepoint(-5.93, 54.60), 4326)::geography, 'claimed', array['cafe'],
   '00000000-0000-0000-0000-00000016001a'),
  ('00000000-0000-0000-0000-000000016002', 'Member Cafe',
   st_setsrid(st_makepoint(-5.94, 54.61), 4326)::geography, 'claimed', array['cafe'],
   '00000000-0000-0000-0000-00000016001a');

-- Written service-side, which since 0161 is the only way these rows can exist at all. The roles are
-- explicit because the column has no default — which is the point being tested.
insert into venue_channels (channel_id, venue_id, role)
  select id, '00000000-0000-0000-0000-000000016001', 'listed' from channels where key = 'test-vc-0160';

insert into channel_members (channel_id, source_name, membership_ref, venue_id, status)
  select id, 'Member Cafe', 'F2G-0160-MEMBER', '00000000-0000-0000-0000-000000016002', 'live'
    from channels where key = 'test-vc-0160';
insert into venue_channels (channel_id, venue_id, role)
  select id, '00000000-0000-0000-0000-000000016002', 'member' from channels where key = 'test-vc-0160';

-- ── the default is gone, even for a service-role write ───────────────────────
-- Stated against the service role deliberately: no policy is involved, so a failure here can only be
-- the NOT NULL constraint doing its job in the absence of the default — the 0154 defect itself.
select throws_ok(
  $$insert into venue_channels (channel_id, venue_id)
    select id, '00000000-0000-0000-0000-000000016002' from channels where key = 'test-vc-0160'$$,
  '23502',
  null,
  'omitting the role FAILS on NOT NULL rather than defaulting to member — the 0154 defect itself');

select throws_ok(
  $$insert into venue_channels (channel_id, venue_id, role)
    select id, '00000000-0000-0000-0000-000000016001', 'associate' from channels where key = 'test-vc-0160'$$,
  '23514',
  null,
  'and the role stays constrained to member|listed');

-- ── listed is not membership ─────────────────────────────────────────────────
select is(
  (select count(*)::int from public.f2g_member_venue_ids((select id from channels where key = 'test-vc-0160'))
    where venue_id = '00000000-0000-0000-0000-000000016001'),
  0,
  'a LISTED venue is absent from f2g_member_venue_ids — listed is never ranked or badged as a member');

select is(
  (select count(*)::int from public.f2g_member_venue_ids((select id from channels where key = 'test-vc-0160'))
    where venue_id = '00000000-0000-0000-0000-000000016002'),
  1,
  'while a MEMBER venue is present — the predicate genuinely distinguishes the two, rather than counting neither');

select * from finish();
rollback;

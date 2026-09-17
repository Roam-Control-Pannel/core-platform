-- ============================================================================
-- pgTAP regression tests for 0150_member_live_spine.sql
--
-- Load-bearing properties: the backfill promotes ONLY verified claims (claimed + claimed_by + venue)
-- and leaves everything else alone; lapsed_at exists; the f2g channel exposes the Association
-- sections in versioned config; and the promoted member is now counted by the ranking helper.
-- ============================================================================
begin;
select plan(8);

select has_column('public', 'channel_members', 'lapsed_at', 'channel_members.lapsed_at exists');

-- ── sections ─────────────────────────────────────────────────────────────────
select is((select sections->>'directory' from channels where key = 'f2g'), 'true', 'f2g exposes the member directory');
select is((select sections->>'jobs'      from channels where key = 'f2g'), 'true', 'f2g exposes the jobs board');
select is((select sections->>'suppliers' from channels where key = 'f2g'), 'true', 'f2g exposes the supplier directory');
select is((select sections->>'storefront' from channels where key = 'f2g'), 'true', 'f2g still exposes the storefront');

-- ── backfill rule, re-applied to fixtures (the migration ran on an empty roster in CI) ────────
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000e5001', 'claimant@live.example');

insert into venues (id, name, geo, status, owner_id, categories) values
  ('00000000-0000-0000-0000-0000000e5011', 'Verified Cafe',
   ST_SetSRID(ST_MakePoint(-5.9300, 54.6000), 4326), 'claimed', '00000000-0000-0000-0000-0000000e5001', array['cafe']),
  ('00000000-0000-0000-0000-0000000e5012', 'Unverified Cafe',
   ST_SetSRID(ST_MakePoint(-5.9310, 54.6010), 4326), 'unclaimed', null, array['cafe']);

insert into channel_members (channel_id, source_name, membership_ref, venue_id, status, claimed_by, claimed_at)
  select id, 'Verified Cafe',   'F2G-0150-A', '00000000-0000-0000-0000-0000000e5011', 'claimed', '00000000-0000-0000-0000-0000000e5001', now() from channels where key = 'f2g';
insert into channel_members (channel_id, source_name, membership_ref, venue_id, status, claimed_by)
  select id, 'Unverified Cafe', 'F2G-0150-B', '00000000-0000-0000-0000-0000000e5012', 'claimed', null from channels where key = 'f2g';
insert into channel_members (channel_id, source_name, membership_ref, venue_id, status)
  select id, 'Invited Cafe',    'F2G-0150-C', null, 'invited' from channels where key = 'f2g';

-- The migration's rule, verbatim.
update channel_members
   set status = 'live'
 where status = 'claimed' and claimed_by is not null and venue_id is not null;

select is((select status from channel_members where membership_ref = 'F2G-0150-A'), 'live',
  'a claim with a claimant and a bound venue is promoted to live');
select is(
  (select string_agg(membership_ref || ':' || status, ',' order by membership_ref)
     from channel_members where membership_ref in ('F2G-0150-B', 'F2G-0150-C')),
  'F2G-0150-B:claimed,F2G-0150-C:invited',
  'a claim without a claimant, and an invited row, are left exactly as they were');

-- ── the promoted member counts as a member for ranking ───────────────────────
select ok(
  exists (select 1 from f2g_member_venue_ids((select id from channels where key = 'f2g'))
           where venue_id = '00000000-0000-0000-0000-0000000e5011'),
  'the live member''s venue is in the member tier');

select * from finish();
rollback;

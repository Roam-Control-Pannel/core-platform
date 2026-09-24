-- ============================================================================
-- pgTAP regression tests for 0160_venue_channels_listed_only.sql
--
-- The defect: from 0154 until this migration, a venue owner listing their own venue on the
-- storefront became a channel MEMBER — priority ranking, member badge, members directory — because
-- `role` defaulted to 'member' and the self-serve insert omitted it. An owner could also set
-- 'member' outright, since the write policy constrained the venue but not the role.
--
-- These tests run as a real `authenticated` role with a real JWT claim, so the policy itself is
-- exercised rather than a function that wraps it.
-- ============================================================================
begin;
select plan(9);

select is(
  (select column_default from information_schema.columns
    where table_schema = 'public' and table_name = 'venue_channels' and column_name = 'role'),
  null,
  'role has NO default — an insert that omits it fails rather than granting membership');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'venue_channels' and policyname = 'venue_channels_owner_write'),
  1,
  'the owner-write policy still exists (self-serve listing is not removed, only narrowed)');

select ok(
  (select with_check from pg_policies
    where schemaname = 'public' and tablename = 'venue_channels'
      and policyname = 'venue_channels_owner_write') like '%listed%',
  'and its WITH CHECK now names the listed role');

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into channels (key, name, is_default) values ('test-vc-0160', 'VC Channel', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000016001a', 'owner@vc.example'),
  ('00000000-0000-0000-0000-00000016001b', 'stranger@vc.example');

-- Two venues owned by the ACTOR, not one. The escalation attempts have to run against a venue the
-- actor owns, or the ownership half of the policy blocks them and the role half is never reached —
-- an assertion that passes for the wrong reason, and says nothing about this migration.
insert into venues (id, name, geo, status, categories, owner_id) values
  ('00000000-0000-0000-0000-000000016001', 'Owned Cafe',
   st_setsrid(st_makepoint(-5.93, 54.60), 4326)::geography, 'claimed', array['cafe'],
   '00000000-0000-0000-0000-00000016001a'),
  ('00000000-0000-0000-0000-000000016003', 'Owned Cafe Two',
   st_setsrid(st_makepoint(-5.95, 54.62), 4326)::geography, 'claimed', array['cafe'],
   '00000000-0000-0000-0000-00000016001a'),
  ('00000000-0000-0000-0000-000000016004', 'Owned Cafe Three',
   st_setsrid(st_makepoint(-5.96, 54.63), 4326)::geography, 'claimed', array['cafe'],
   '00000000-0000-0000-0000-00000016001a'),
  ('00000000-0000-0000-0000-000000016002', 'Someone Elses Cafe',
   st_setsrid(st_makepoint(-5.94, 54.61), 4326)::geography, 'claimed', array['cafe'],
   '00000000-0000-0000-0000-00000016001b');

create temporary table _vc (name text primary key, ok boolean) on commit drop;

do $$
declare
  ch uuid;
  listed_ok boolean := false;
  member_blocked boolean := false;
  omitted_blocked boolean := false;
  promote_blocked boolean := false;
  others_blocked boolean := false;
  service_member_ok boolean := false;
  is_member_after_listing boolean := true;
begin
  select id into ch from channels where key = 'test-vc-0160';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000016001a","role":"authenticated"}', true);

  -- The legitimate self-serve path: list my own venue.
  begin
    insert into venue_channels (channel_id, venue_id, role)
      values (ch, '00000000-0000-0000-0000-000000016001', 'listed');
    listed_ok := true;
  exception when others then listed_ok := false; end;

  -- THE ESCALATION: declare a venue I DO own a member. Ownership is satisfied, so only the role
  -- clause can refuse this.
  begin
    insert into venue_channels (channel_id, venue_id, role)
      values (ch, '00000000-0000-0000-0000-000000016003', 'member');
  exception when others then member_blocked := true; end;

  -- THE DEFECT: omit the role on a venue I own and take whatever the column gives. Must now fail.
  -- Its own venue, untouched by the attempt above: a primary-key conflict would otherwise make this
  -- assertion pass without the column default ever being consulted.
  begin
    insert into venue_channels (channel_id, venue_id)
      values (ch, '00000000-0000-0000-0000-000000016004');
  exception when others then omitted_blocked := true; end;

  -- Promote an existing listing to membership by UPDATE.
  begin
    update venue_channels set role = 'member'
     where channel_id = ch and venue_id = '00000000-0000-0000-0000-000000016001';
    if not found then promote_blocked := true; end if;
  exception when others then promote_blocked := true; end;

  -- Someone else's venue, at any role.
  begin
    insert into venue_channels (channel_id, venue_id, role)
      values (ch, '00000000-0000-0000-0000-000000016002', 'listed');
  exception when others then others_blocked := true; end;

  -- The listed venue must NOT appear in the canonical member set.
  is_member_after_listing := exists (
    select 1 from public.f2g_member_venue_ids(ch)
     where venue_id = '00000000-0000-0000-0000-000000016001');

  -- Service role: membership is still reachable from the audited HQ path.
  perform set_config('role', 'postgres', true);
  begin
    insert into venue_channels (channel_id, venue_id, role)
      values (ch, '00000000-0000-0000-0000-000000016002', 'member');
    service_member_ok := true;
  exception when others then service_member_ok := false; end;

  insert into _vc values
    ('listed_ok',        listed_ok),
    ('member_blocked',   member_blocked),
    ('omitted_blocked',  omitted_blocked),
    ('promote_blocked',  promote_blocked),
    ('others_blocked',   others_blocked),
    ('not_a_member',     is_member_after_listing = false),
    ('service_member_ok', service_member_ok);
end $$;

select ok((select ok from _vc where name = 'listed_ok'),
  'an owner can still list their own claimed venue — self-serve onboarding is intact');
select ok((select ok from _vc where name = 'member_blocked'),
  'but can NEVER declare it a member: the escalation is closed');
select ok((select ok from _vc where name = 'omitted_blocked'),
  'and omitting the role now FAILS rather than defaulting to member — the 0154 defect itself');
select ok((select ok from _vc where name = 'promote_blocked'),
  'nor can a listing be promoted to membership by update');
select ok((select ok from _vc where name = 'others_blocked'),
  'and none of this reaches a venue they do not own');
select ok((select ok from _vc where name = 'not_a_member'),
  'a listed venue is absent from f2g_member_venue_ids — listed is not ranked or badged as a member');

select * from finish();
rollback;

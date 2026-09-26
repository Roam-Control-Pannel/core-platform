-- ============================================================================
-- pgTAP regression tests for 0163_venue_channels_no_client_write.sql
--
-- One claim, stated two ways because they can fail independently: the owner-write policy is gone,
-- and a real `authenticated` role with a real JWT therefore cannot write `venue_channels` at all —
-- not even for a venue it genuinely owns, and not even at the 'listed' role 0160 allowed.
--
-- The second assertion is the one that matters. A policy could be dropped and re-added by a later
-- migration, or another policy could grant the same write; only attacking the table as the role
-- itself proves the door is shut.
-- ============================================================================
begin;
select plan(5);

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'venue_channels' and policyname = 'venue_channels_owner_write'),
  0,
  'venue_channels_owner_write is GONE — self-tagging through PostgREST is removed, not narrowed');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'venue_channels'
      and cmd in ('INSERT', 'UPDATE', 'DELETE', 'ALL')),
  0,
  'and NO other policy grants a client write — the removal was not replaced by an equivalent');

select ok(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'venue_channels' and cmd = 'SELECT') >= 1,
  'while SELECT stays world-readable (0116) — the storefront still reads its own tags');

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into channels (key, name, is_default) values ('test-vc-0163', 'No Write Co', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000016301a', 'owner@nowrite.example');

insert into venues (id, name, geo, status, categories, owner_id) values
  ('00000000-0000-0000-0000-000000016301', 'Genuinely Owned Cafe',
   st_setsrid(st_makepoint(-5.93, 54.60), 4326)::geography, 'claimed', array['cafe'],
   '00000000-0000-0000-0000-00000016301a');

create temporary table _vc3 (name text primary key, ok boolean) on commit drop;

do $$
declare
  ch uuid;
  listed_refused boolean := false;
  member_refused boolean := false;
begin
  select id into ch from channels where key = 'test-vc-0163';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000016301a","role":"authenticated"}', true);

  -- The write 0160 still permitted: own venue, 'listed'. Must now be refused outright.
  begin
    insert into venue_channels (channel_id, venue_id, role)
      values (ch, '00000000-0000-0000-0000-000000016301', 'listed');
  exception when others then listed_refused := true; end;

  begin
    insert into venue_channels (channel_id, venue_id, role)
      values (ch, '00000000-0000-0000-0000-000000016301', 'member');
  exception when others then member_refused := true; end;

  perform set_config('role', 'postgres', true);
  insert into _vc3 values ('listed_refused', listed_refused), ('member_refused', member_refused);
end $$;

select ok((select ok from _vc3 where name = 'listed_refused'),
  'an owner cannot write even ''listed'' for a venue they genuinely own — listing goes through tag_venue_listing');
select ok((select ok from _vc3 where name = 'member_refused'),
  'and certainly not ''member'' — the 0154 escalation stays closed by the absence of any write path');

select * from finish();
rollback;

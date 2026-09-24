-- ============================================================================
-- pgTAP regression tests for 0162_portal_unreachable_members.sql
--
-- 0162 adds one column to channel_portal_overview, but it replaces the function to do it (a
-- `returns table` shape IS the return type), so the tests that matter are as much about what did NOT
-- change as about what did: the internal gate, the refusal shape, and the grants — all of which a
-- drop-and-recreate is exactly the kind of change to lose silently.
-- ============================================================================
begin;
select plan(7);

select ok(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'channel_portal_overview'
      and column_name = 'members_unreachable') = 1
  or exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'channel_portal_overview'
       and 'members_unreachable' = any(p.proargnames)),
  'channel_portal_overview returns members_unreachable');

select ok(
  (select prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'channel_portal_overview'),
  'and is still SECURITY DEFINER after the drop-and-recreate');

select is(
  has_function_privilege('anon', 'public.channel_portal_overview(uuid)', 'EXECUTE'),
  false,
  'anon still cannot execute it — the drop took the grants with it and 0162 restated them');

select is(
  has_function_privilege('authenticated', 'public.channel_portal_overview(uuid)', 'EXECUTE'),
  true,
  'and authenticated still can, so the portal did not silently lose its data');

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into channels (key, name, is_default) values ('test-unreach-0162', 'Unreachable Co', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000016201a', 'officer@unreach.example'),
  ('00000000-0000-0000-0000-00000016201b', 'stranger@unreach.example');

insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000016201a', 'officer'
    from channels where key = 'test-unreach-0162';

-- Two awaiting activation with no address (one null, one blank), one awaiting WITH an address, and
-- one already live with none — which must NOT count, because it is not stuck.
insert into channel_members (channel_id, source_name, membership_ref, status, source_email)
  select id, 'No Email A', 'F2G-0162-A', 'imported', null from channels where key = 'test-unreach-0162';
insert into channel_members (channel_id, source_name, membership_ref, status, source_email)
  select id, 'Blank Email', 'F2G-0162-B', 'invited', '   ' from channels where key = 'test-unreach-0162';
insert into channel_members (channel_id, source_name, membership_ref, status, source_email)
  select id, 'Has Email', 'F2G-0162-C', 'imported', 'c@unreach.example' from channels where key = 'test-unreach-0162';
insert into channel_members (channel_id, source_name, membership_ref, status, source_email)
  select id, 'Live No Email', 'F2G-0162-D', 'live', null from channels where key = 'test-unreach-0162';

create temporary table _un (name text primary key, n int) on commit drop;

do $$
declare
  ch uuid;
  officer_n int;
  stranger_rows int;
begin
  select id into ch from channels where key = 'test-unreach-0162';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000016201a","role":"authenticated"}', true);
  select members_unreachable into officer_n from public.channel_portal_overview(ch);

  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000016201b","role":"authenticated"}', true);
  select count(*)::int into stranger_rows from public.channel_portal_overview(ch);

  perform set_config('role', 'postgres', true);
  insert into _un values ('officer_n', officer_n), ('stranger_rows', stranger_rows);
end $$;

select is((select n from _un where name = 'officer_n'), 2,
  'counts only members AWAITING activation with no usable address — a blank string counts, a live member does not');

select is((select n from _un where name = 'stranger_rows'), 0,
  'and a caller with no appointment still gets NO ROWS, not a row of zeros that would read as a quiet week');

select ok(
  (select count(*)::int from channel_members
    where membership_ref = 'F2G-0162-D' and status = 'live') = 1,
  'the already-live member with no address is still on the roster — it is excluded from the count, not from the channel');

select * from finish();
rollback;

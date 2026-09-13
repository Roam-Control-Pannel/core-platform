-- ============================================================================
-- pgTAP regression tests for 0138_channel_import_runs.sql
--
-- Proves the import-audit table's shape and its service-managed posture: with RLS on and no client
-- policy, anon/authenticated can neither read nor write it, and the guard trigger is a live tripwire.
-- ============================================================================
begin;
select plan(7);

select has_table('public', 'channel_import_runs', 'channel_import_runs table exists');
select has_column('public', 'channel_import_runs', 'report', 'has the report jsonb column');
select has_column('public', 'channel_import_runs', 'matched_accept', 'has the match-outcome counters');
select has_trigger('public', 'channel_import_runs', 'channel_import_runs_guard', 'has the client-role guard');

-- Fixture (as the test/owner role: bypasses RLS + guard).
insert into channel_import_runs (channel_id, imported, matched_accept)
select id, 3, 2 from channels where key = 'f2g';

create temp table _ir (k text primary key, v boolean);

do $$
declare anon_sees int := -1; auth_insert_blocked boolean := false; auth_sees int := -1;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into anon_sees from channel_import_runs;

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-00000000d10f","role":"authenticated"}', true);
  select count(*) into auth_sees from channel_import_runs;
  begin
    insert into channel_import_runs (channel_id, imported)
    select id, 99 from channels where key = 'f2g';
  exception when others then auth_insert_blocked := true; end;

  perform set_config('role', 'postgres', true);
  insert into _ir values ('anon_zero', anon_sees = 0), ('auth_zero', auth_sees = 0), ('auth_insert_blocked', auth_insert_blocked);
end $$;

select ok((select v from _ir where k = 'anon_zero'), 'anon cannot read import runs (deny-by-omission)');
select ok((select v from _ir where k = 'auth_zero'), 'authenticated cannot read import runs');
select ok((select v from _ir where k = 'auth_insert_blocked'), 'authenticated cannot insert an import run');

select * from finish();
rollback;

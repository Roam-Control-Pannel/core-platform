-- ============================================================================
-- pgTAP regression tests for 0159_channel_feature_requests.sql
--
-- This is the portal's first client-writable table, so the tests are mostly about what the policies
-- REFUSE. Every one of these runs as a real `authenticated` role with a real JWT claim, against real
-- RLS — not through a definer function that could be masking the policy.
-- ============================================================================
begin;
select plan(16);

select has_table('public', 'channel_feature_requests', 'the table exists');
select has_function('public', 'is_channel_officer', array['uuid'], 'the officer-only predicate exists');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.channel_feature_requests'::regclass),
  'RLS is enabled');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'channel_feature_requests'),
  2,
  'exactly two policies: one SELECT and one INSERT — triage stays Roam''s');

select is(
  (select string_agg(cmd, ',' order by cmd) from pg_policies
    where schemaname = 'public' and tablename = 'channel_feature_requests'),
  'INSERT,SELECT',
  'and neither of them is UPDATE or DELETE');

select has_trigger('public', 'channel_feature_requests', 'channel_feature_requests_guard',
  'the UPDATE/DELETE tripwire is attached');

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into channels (key, name, is_default) values
  ('test-fr-a-0159', 'Requests A', false),
  ('test-fr-b-0159', 'Requests B', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000015901a', 'officer-a@fr.example'),  -- OFFICER of A
  ('00000000-0000-0000-0000-00000015901c', 'viewer-a@fr.example'),   -- VIEWER of A
  ('00000000-0000-0000-0000-00000015901b', 'officer-b@fr.example');  -- officer of B

insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000015901a', 'officer' from channels where key = 'test-fr-a-0159';
insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000015901c', 'viewer'  from channels where key = 'test-fr-a-0159';
insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000015901b', 'officer' from channels where key = 'test-fr-b-0159';

-- One request already filed for channel A (as owner, bypassing RLS), so reads have something to see.
insert into channel_feature_requests (channel_id, created_by, title, detail, category)
  select id, '00000000-0000-0000-0000-00000015901a', 'Export orders monthly', 'A CSV per month.', 'reporting'
    from channels where key = 'test-fr-a-0159';

create temporary table _fr (name text primary key, ok boolean) on commit drop;

do $$
declare
  ch_a uuid; ch_b uuid;
  officer_sees int; viewer_sees int; b_sees int;
  officer_insert_ok boolean := false;
  viewer_insert_blocked boolean := false;
  cross_insert_blocked boolean := false;
  spoof_blocked boolean := false;
  pretriaged_blocked boolean := false;
  notes_blocked boolean := false;
  update_blocked boolean := false;
begin
  select id into ch_a from channels where key = 'test-fr-a-0159';
  select id into ch_b from channels where key = 'test-fr-b-0159';

  -- ── the OFFICER of A ──────────────────────────────────────────────────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000015901a","role":"authenticated"}', true);

  select count(*)::int into officer_sees from channel_feature_requests;

  begin
    insert into channel_feature_requests (channel_id, created_by, title, category)
      values (ch_a, '00000000-0000-0000-0000-00000015901a', 'Second request', 'storefront');
    officer_insert_ok := true;
  exception when others then officer_insert_ok := false; end;

  -- Filing for somebody else's channel.
  begin
    insert into channel_feature_requests (channel_id, created_by, title)
      values (ch_b, '00000000-0000-0000-0000-00000015901a', 'Not my channel');
  exception when others then cross_insert_blocked := true; end;

  -- Attributing a request to another person.
  begin
    insert into channel_feature_requests (channel_id, created_by, title)
      values (ch_a, '00000000-0000-0000-0000-00000015901b', 'Filed as someone else');
  exception when others then spoof_blocked := true; end;

  -- Filing something that arrives already triaged.
  begin
    insert into channel_feature_requests (channel_id, created_by, title, status)
      values (ch_a, '00000000-0000-0000-0000-00000015901a', 'Pre-triaged', 'planned');
  exception when others then pretriaged_blocked := true; end;

  -- Writing Roam's reply on the way in.
  begin
    insert into channel_feature_requests (channel_id, created_by, title, roam_notes)
      values (ch_a, '00000000-0000-0000-0000-00000015901a', 'With notes', 'We will do this');
  exception when others then notes_blocked := true; end;

  -- Rewriting a filed request (no UPDATE policy + the tripwire).
  begin
    update channel_feature_requests set title = 'Rewritten' where channel_id = ch_a;
    if not found then update_blocked := true; end if;
  exception when others then update_blocked := true; end;

  -- ── the VIEWER of A: reads everything, files nothing ──────────────────────
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000015901c","role":"authenticated"}', true);
  select count(*)::int into viewer_sees from channel_feature_requests;
  begin
    insert into channel_feature_requests (channel_id, created_by, title)
      values (ch_a, '00000000-0000-0000-0000-00000015901c', 'Viewer request');
  exception when others then viewer_insert_blocked := true; end;

  -- ── the officer of B sees none of A's ─────────────────────────────────────
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000015901b","role":"authenticated"}', true);
  select count(*)::int into b_sees from channel_feature_requests;

  perform set_config('role', 'postgres', true);
  insert into _fr values
    ('officer_reads',    officer_sees >= 1),
    ('officer_files',    officer_insert_ok),
    ('cross_blocked',    cross_insert_blocked),
    ('spoof_blocked',    spoof_blocked),
    ('pretriaged_blocked', pretriaged_blocked),
    ('notes_blocked',    notes_blocked),
    ('update_blocked',   update_blocked),
    ('viewer_reads',     viewer_sees >= 1),
    ('viewer_cannot_file', viewer_insert_blocked),
    ('b_sees_none',      b_sees = 0);
end $$;

select ok((select ok from _fr where name = 'officer_reads'),  'an officer reads their organisation''s requests');
select ok((select ok from _fr where name = 'officer_files'),  'and can file a new one');
select ok((select ok from _fr where name = 'cross_blocked'),  'but not for a channel they hold no appointment for');
select ok((select ok from _fr where name = 'spoof_blocked'),  'and cannot attribute a request to somebody else');
select ok((select ok from _fr where name = 'pretriaged_blocked'),
  'a request cannot arrive pre-triaged — status is Roam''s to set');
select ok((select ok from _fr where name = 'notes_blocked'),
  'and cannot carry Roam''s reply written by the partner');
select ok((select ok from _fr where name = 'update_blocked'),
  'a filed request cannot be rewritten by the partner — no UPDATE policy, plus the tripwire');
select ok((select ok from _fr where name = 'viewer_reads'),   'a VIEWER reads the same requests');
select ok((select ok from _fr where name = 'viewer_cannot_file'),
  'but cannot file one — officer and viewer are genuinely different authorities');
select ok((select ok from _fr where name = 'b_sees_none'),
  'an officer of B sees NONE of A''s requests — containment holds for the first writable table too');

select * from finish();
rollback;

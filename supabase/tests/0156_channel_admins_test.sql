-- ============================================================================
-- pgTAP regression tests for 0156_channel_admins.sql
--
-- The load-bearing property is CONTAINMENT: an officer of one channel must see that channel and
-- nothing of any other. This is the whole reason channel_admins exists rather than a row in
-- admin_users, so it is proved here against real RLS with a real simulated caller, not asserted in
-- a comment. The rest — writes are service-only, one role per person per channel — protects it.
-- ============================================================================
begin;
select plan(15);

select has_table('public', 'channel_admins', 'channel_admins exists');
select has_column('public', 'channel_admins', 'profile_id', 'the officer is a profile');
select has_column('public', 'channel_admins', 'role', 'the role is recorded');

-- ── posture: read your own row, write nothing ────────────────────────────────
select ok(
  (select relrowsecurity from pg_class where oid = 'public.channel_admins'::regclass),
  'RLS is enabled');

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'channel_admins'),
  1,
  'exactly ONE policy exists — the self-read; every client write is denied by omission');

select is(
  (select cmd from pg_policies
    where schemaname = 'public' and tablename = 'channel_admins' limit 1),
  'SELECT',
  'and that one policy is a SELECT — an officer can never appoint or promote anyone, themselves included');

select has_trigger('public', 'channel_admins', 'channel_admins_guard',
  'the defence-in-depth tripwire trigger is attached');

-- ── fixtures (owner role: bypasses RLS and the guard) ────────────────────────
insert into channels (key, name, is_default) values
  ('test-assoc-a-0156', 'Association A', false),
  ('test-assoc-b-0156', 'Association B', false);

-- Inserting an auth user creates its profile via trg_auth_user_created (0005).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000015601a', 'officer-a@assoc-a.example'),  -- officer of A only
  ('00000000-0000-0000-0000-00000015601b', 'officer-b@assoc-b.example');  -- officer of B only

insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000015601a', 'officer'
  from channels where key = 'test-assoc-a-0156';
insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000015601b', 'officer'
  from channels where key = 'test-assoc-b-0156';

-- Even with the trigger as the only barrier, a client role cannot write.
set local role authenticated;
select throws_ok(
  $$insert into channel_admins (channel_id, profile_id, role)
    select id, '00000000-0000-0000-0000-00000015601a', 'officer'
    from channels where key = 'test-assoc-b-0156'$$,
  '42501',
  null,
  'a client role can never grant itself an officer role on another channel');
reset role;

-- ── constraints ──────────────────────────────────────────────────────────────
select throws_ok(
  $$insert into channel_admins (channel_id, profile_id, role)
    select id, '00000000-0000-0000-0000-00000015601a', 'viewer'
    from channels where key = 'test-assoc-a-0156'$$,
  '23505',
  null,
  're-appointing the same person on the same channel is refused, so two rows cannot disagree about their role');

select throws_ok(
  $$insert into channel_admins (channel_id, profile_id, role)
    select id, '00000000-0000-0000-0000-00000015601b', 'admin'
    from channels where key = 'test-assoc-a-0156'$$,
  '23514',
  null,
  'the role vocabulary is closed — admin_users'' names are not accepted here');

-- ── THE CONTAINMENT PROOF ────────────────────────────────────────────────────
-- Officer A, signed in for real, against real RLS.
create temporary table _ca (name text primary key, ok boolean) on commit drop;

do $$
declare
  a_total int := -1; a_other int := -1;
  a_admin_own boolean := null; a_admin_other boolean := null;
  anon_total int := -1;
  ch_a uuid; ch_b uuid;
begin
  select id into ch_a from channels where key = 'test-assoc-a-0156';
  select id into ch_b from channels where key = 'test-assoc-b-0156';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000015601a","role":"authenticated"}', true);

  -- Everything officer A can see in this table, and how much of it belongs to another channel.
  select count(*) into a_total from channel_admins;
  select count(*) into a_other from channel_admins where channel_id = ch_b;

  -- The canonical predicate, asked about A's own channel and about somebody else's.
  select public.is_channel_admin(ch_a) into a_admin_own;
  select public.is_channel_admin(ch_b) into a_admin_other;

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into anon_total from channel_admins;

  perform set_config('role', 'postgres', true);
  insert into _ca values
    ('a_sees_only_own_row',  a_total = 1),
    ('a_sees_no_other_rows', a_other = 0),
    ('a_admin_of_own',       a_admin_own is true),
    ('a_not_admin_of_other', a_admin_other is false),
    ('anon_sees_nothing',    anon_total = 0);
end $$;

select ok((select ok from _ca where name = 'a_sees_only_own_row'),
  'an officer sees exactly one row — their own appointment');
select ok((select ok from _ca where name = 'a_sees_no_other_rows'),
  'an officer of A sees NOTHING belonging to channel B');
select ok((select ok from _ca where name = 'a_admin_of_own'),
  'is_channel_admin is true for the channel they were appointed to');
select ok((select ok from _ca where name = 'a_not_admin_of_other'),
  'is_channel_admin is FALSE for a channel they were not — the containment the portal rests on');
select ok((select ok from _ca where name = 'anon_sees_nothing'),
  'an anonymous caller sees no appointments at all');

select * from finish();
rollback;

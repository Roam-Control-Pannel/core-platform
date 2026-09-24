-- ============================================================================
-- pgTAP regression tests for 0158_channel_portal_members.sql
--
-- Two properties, both load-bearing:
--   1. Decision 5.2 Option A holds STRUCTURALLY — `source_email` and `source_phone` are not columns
--      of this function, so no select-list edit can leak them. Asserted against the function's real
--      return signature, not against a sample row that merely happens not to contain them.
--   2. Containment, as everywhere else in the portal: an officer of A gets no rows for channel B.
-- ============================================================================
begin;
select plan(11);

select has_function('public', 'channel_portal_members',
  array['uuid', 'text', 'text', 'text', 'integer', 'integer'], 'the members list exists');

-- The PII proof: read the declared OUT parameters and show the contact columns are absent.
select is(
  (select count(*)::int
     from unnest((select proargnames from pg_proc p
                   join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname = 'channel_portal_members')) as arg
    where arg in ('source_email', 'source_phone', 'email', 'phone')),
  0,
  'decision 5.2 Option A is structural: no e-mail or phone column exists to be selected by mistake');

select ok(
  not has_function_privilege('anon',
    'public.channel_portal_members(uuid, text, text, text, integer, integer)', 'execute'),
  'anon cannot execute it — an anonymous caller has no appointment to check');

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into channels (key, name, is_default) values
  ('test-pm-a-0158', 'Portal A', false),
  ('test-pm-b-0158', 'Portal B', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000015801a', 'officer-a@pm.example'),
  ('00000000-0000-0000-0000-00000015801b', 'officer-b@pm.example');

insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000015801a', 'officer' from channels where key = 'test-pm-a-0158';
insert into channel_admins (channel_id, profile_id, role)
  select id, '00000000-0000-0000-0000-00000015801b', 'officer' from channels where key = 'test-pm-b-0158';

insert into venues (id, name, slug, geo, status, categories) values
  ('00000000-0000-0000-0000-000000015801', 'Bakery Venue', 'bakery-venue-0158',
   st_setsrid(st_makepoint(-5.93, 54.60), 4326)::geography, 'claimed', array['cafe']);

-- A live, matched, activated member WITH contact PII on the row — the PII must not come back.
insert into channel_members
  (channel_id, source_name, membership_ref, member_no, venue_id, status, source_council,
   source_email, source_phone, claimed_at)
  select id, '100% Bakery', 'PM-0158-1', 'M-001',
         '00000000-0000-0000-0000-000000015801', 'live', 'Belfast',
         'secret@member.example', '+44 28 9000 0000', now()
    from channels where key = 'test-pm-a-0158';

-- A second member, different status and no venue, to exercise the filters.
insert into channel_members (channel_id, source_name, membership_ref, status, source_council)
  select id, 'Zeta Catering', 'PM-0158-2', 'imported', 'Derry City and Strabane'
    from channels where key = 'test-pm-a-0158';

create temporary table _pm (name text primary key, ok boolean) on commit drop;

do $$
declare
  ch_a uuid; ch_b uuid;
  all_rows int; total_first int; live_rows int; council_rows int;
  q_rows int; q_name text; q_activated timestamptz; q_no text;
  cross_rows int;
begin
  select id into ch_a from channels where key = 'test-pm-a-0158';
  select id into ch_b from channels where key = 'test-pm-b-0158';

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000015801a","role":"authenticated"}', true);

  select count(*)::int into all_rows from public.channel_portal_members(ch_a);
  select total_count into total_first from public.channel_portal_members(ch_a) limit 1;
  select count(*)::int into live_rows from public.channel_portal_members(ch_a, 'live');
  select count(*)::int into council_rows from public.channel_portal_members(ch_a, null, 'Belfast');

  -- A literal '%' in the search term must be matched literally, not as a wildcard.
  select count(*)::int into q_rows from public.channel_portal_members(ch_a, null, null, '100%');
  select business, activated_at, member_no into q_name, q_activated, q_no
    from public.channel_portal_members(ch_a, null, null, '100%') limit 1;

  -- The same officer, asking about somebody else's channel.
  select count(*)::int into cross_rows from public.channel_portal_members(ch_b);

  perform set_config('role', 'postgres', true);
  insert into _pm values
    ('two_rows',      all_rows = 2),
    ('total_is_two',  total_first = 2),
    ('live_filter',   live_rows = 1),
    ('council_filter',council_rows = 1),
    ('query_literal', q_rows = 1 and q_name = '100% Bakery'),
    ('activated_set', q_activated is not null),
    ('member_no',     q_no = 'M-001'),
    ('cross_empty',   cross_rows = 0);
end $$;

select ok((select ok from _pm where name = 'two_rows'),      'both of the channel''s members are listed');
select ok((select ok from _pm where name = 'total_is_two'),  'total_count rides on every row, so paging cannot disagree with its own label');
select ok((select ok from _pm where name = 'live_filter'),   'the status filter narrows to live members');
select ok((select ok from _pm where name = 'council_filter'),'the council filter uses the council of record');
select ok((select ok from _pm where name = 'query_literal'),
  'a literal %% in a business name is searched literally — "100%% Bakery" is not a wildcard');
select ok((select ok from _pm where name = 'activated_set'), 'the activation date comes through for a claimed member');
select ok((select ok from _pm where name = 'member_no'),     'the membership number is shown (null until 2027 for real rosters)');
select ok((select ok from _pm where name = 'cross_empty'),
  'an officer of A gets NO ROWS for channel B');

select * from finish();
rollback;

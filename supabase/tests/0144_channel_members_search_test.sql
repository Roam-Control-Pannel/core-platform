-- ============================================================================
-- pgTAP regression tests for 0144_channel_members_search.sql
--
-- The load-bearing property: a SECURITY DEFINER function over the PII-bearing, service-managed roster
-- must project NO PII. We assert it structurally (the RETURNS TABLE signature names no email/phone
-- column) AND behaviourally (only LIVE members surface; council + radius filters work; nationwide when
-- no radius). The signature assertion is the mandatory column audit encoded as a test.
-- ============================================================================
begin;
select plan(10);

-- ── structural ───────────────────────────────────────────────────────────────
select has_function('public', 'channel_members_search',
  array['text','text','text','double precision','double precision','double precision','integer','integer'],
  'channel_members_search exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.channel_members_search(text,text,text,double precision,double precision,double precision,integer,integer)'::regprocedure),
  true, 'channel_members_search is SECURITY DEFINER');
select ok(
  has_function_privilege('anon', 'public.channel_members_search(text,text,text,double precision,double precision,double precision,integer,integer)', 'execute'),
  'anon CAN execute the public directory search');
-- The return signature must not expose PII columns (the mandatory column audit).
select ok(
  pg_get_function_result('public.channel_members_search(text,text,text,double precision,double precision,double precision,integer,integer)'::regprocedure) !~* 'email',
  'the return signature exposes NO email column');
select ok(
  pg_get_function_result('public.channel_members_search(text,text,text,double precision,double precision,double precision,integer,integer)'::regprocedure) !~* 'phone',
  'the return signature exposes NO phone column');

-- ── fixtures (owner role: bypasses RLS + the roster guard) ────────────────────
insert into venues (id, name, slug, geo, status, owner_id, locality)
  values ('00000000-0000-0000-0000-0000000cd0c1', 'Live Cafe', 'live-cafe',
          ST_SetSRID(ST_MakePoint(-5.9301, 54.5973), 4326), 'claimed', null, 'Belfast');

-- A LIVE member (with PII on the row) matched to the venue.
insert into channel_members (id, channel_id, source_name, source_email, source_council, membership_ref, venue_id, status)
select '00000000-0000-0000-0000-0000000cd0a1', c.id, 'Live Cafe', 'pii@secret.example', 'Belfast', 'ASSOC-C2A',
       '00000000-0000-0000-0000-0000000cd0c1', 'live'
from channels c where c.key = 'f2g';
-- A non-live member (must never surface in the public directory).
insert into channel_members (id, channel_id, source_name, source_council, membership_ref, status)
select '00000000-0000-0000-0000-0000000cd0a2', c.id, 'Imported Cafe', 'Belfast', 'ASSOC-C2B', 'imported'
from channels c where c.key = 'f2g';

-- ── behavioural (as anon, the public caller) ──────────────────────────────────
create temp table _cd (k text primary key, v boolean);
do $$
declare live_name text; nonlive_seen int; council_derry int; far_seen int; nation_seen int;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  select name into live_name from channel_members_search('f2g') where member_id = '00000000-0000-0000-0000-0000000cd0a1';
  select count(*) into nonlive_seen from channel_members_search('f2g') where member_id = '00000000-0000-0000-0000-0000000cd0a2';
  select count(*) into council_derry from channel_members_search('f2g', null, 'Derry');
  -- Far origin (London) + 5km radius: the Belfast venue is excluded.
  select count(*) into far_seen from channel_members_search('f2g', null, null, 51.5074, -0.1278, 5000);
  -- Nationwide (null radius) with an origin: still returned.
  select count(*) into nation_seen from channel_members_search('f2g', null, null, 51.5074, -0.1278, null);

  perform set_config('role', 'postgres', true);
  insert into _cd values
    ('live_name_ok',   live_name = 'Live Cafe'),
    ('nonlive_hidden', nonlive_seen = 0),
    ('council_filter', council_derry = 0),
    ('radius_excludes', far_seen = 0),
    ('nationwide_incl', nation_seen = 1);
end $$;

select ok((select v from _cd where k = 'live_name_ok'),    'a live member surfaces with its public name');
select ok((select v from _cd where k = 'nonlive_hidden'),  'a non-live member never surfaces');
select ok((select v from _cd where k = 'council_filter'),  'the council filter excludes non-matching members');
select ok((select v from _cd where k = 'radius_excludes'), 'a bounded radius excludes an out-of-range venue');
select ok((select v from _cd where k = 'nationwide_incl'), 'a null radius searches nationwide (D5/D6 fix)');

select * from finish();
rollback;

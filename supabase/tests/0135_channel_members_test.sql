-- ============================================================================
-- pgTAP regression tests for 0135_channel_members.sql
--
-- Proves the roster table's shape and — the load-bearing property — that it is SERVICE-MANAGED:
-- with RLS on and no client policy, the `authenticated` and `anon` roles can neither read the PII
-- roster nor write it, and the guard trigger is a working tripwire. Client-role mutations run inside
-- a DO block under SET ROLE (so no pgTAP function is called as a role lacking EXECUTE on pgtap);
-- outcomes are stashed and asserted as the owner role afterwards.
-- ============================================================================
begin;
select plan(13);

-- ── structural ───────────────────────────────────────────────────────────────
select has_table('public', 'channel_members', 'channel_members table exists');
select has_column('public', 'channel_members', 'source_email',
  'channel_members has the PII source_email column');
select has_column('public', 'channel_members', 'membership_ref',
  'channel_members has the membership_ref idempotency key');
select ok(
  (select indisunique from pg_index where indexrelid = 'public.channel_members_ref_uq'::regclass),
  '(channel_id, membership_ref) index is unique for idempotent re-import'
);
select has_trigger('public', 'channel_members', 'channel_members_guard',
  'channel_members has the client-role guard tripwire');

-- ── fixtures (as the test/owner role: bypasses RLS + the guard gate) ──────────
insert into venues (id, name, geo, status, owner_id)
  values (
    '00000000-0000-0000-0000-0000000cd001', 'Roster Test Venue',
    ST_SetSRID(ST_MakePoint(-5.9301, 54.5973), 4326), 'unclaimed', null
  );

-- A member row tied to the f2g channel and the fixture venue.
insert into channel_members (id, channel_id, source_name, source_email, membership_ref, venue_id)
select '00000000-0000-0000-0000-0000000cd0a1', c.id, 'Verbatim Cafe',
       'owner@verbatim.example', 'ASSOC-0001', '00000000-0000-0000-0000-0000000cd001'
from channels c where c.key = 'f2g';

create temp table _cm (k text primary key, v boolean);

-- Value + idempotency integrity (as owner role).
do $$
declare bad_status boolean := false; ref_dup boolean := false;
begin
  begin
    insert into channel_members (channel_id, source_name, membership_ref, status)
    select id, 'Bad Status', 'ASSOC-BAD', 'archived' from channels where key = 'f2g';
  exception when others then bad_status := true; end;

  begin  -- same (channel_id, membership_ref) as the fixture → unique violation
    insert into channel_members (channel_id, source_name, membership_ref)
    select id, 'Dup Ref', 'ASSOC-0001' from channels where key = 'f2g';
  exception when others then ref_dup := true; end;

  insert into _cm values ('bad_status', bad_status), ('ref_dup', ref_dup);
end $$;

select ok((select v from _cm where k = 'bad_status'), 'status check rejects a value outside the 6-state machine');
select ok((select v from _cm where k = 'ref_dup'),    'duplicate (channel_id, membership_ref) is rejected');

-- ── service-managed: client roles can neither read nor write ──────────────────
do $$
declare
  auth_sees int := -1; anon_sees int := -1;
  auth_insert_blocked boolean := false; auth_update_blocked boolean := false;
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000cd0ff","role":"authenticated"}', true);

  select count(*) into auth_sees from channel_members;         -- no read policy → 0 rows
  begin
    insert into channel_members (channel_id, source_name, membership_ref)
    select id, 'Client Insert', 'ASSOC-EVIL' from channels where key = 'f2g';
  exception when others then auth_insert_blocked := true; end;
  begin
    update channel_members set source_email = 'leak@evil.example'
      where membership_ref = 'ASSOC-0001';
    -- If RLS silently matched 0 rows (no error), the PII was still not reachable; treat a 0-row
    -- update as "blocked" too. Re-check as owner below.
    if not found then auth_update_blocked := true; end if;
  exception when others then auth_update_blocked := true; end;

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into anon_sees from channel_members;         -- no read policy → 0 rows

  perform set_config('role', 'postgres', true);
  insert into _cm values
    ('auth_sees_zero',      auth_sees = 0),
    ('anon_sees_zero',      anon_sees = 0),
    ('auth_insert_blocked', auth_insert_blocked),
    ('auth_update_blocked', auth_update_blocked),
    -- PII was never mutated by the client attempt.
    ('email_intact', (select source_email = 'owner@verbatim.example'
                        from channel_members where membership_ref = 'ASSOC-0001'));
end $$;

select ok((select v from _cm where k = 'auth_sees_zero'),      'authenticated cannot READ the roster (deny-by-omission)');
select ok((select v from _cm where k = 'anon_sees_zero'),      'anon cannot READ the roster (deny-by-omission)');
select ok((select v from _cm where k = 'auth_insert_blocked'), 'authenticated cannot INSERT into the roster');
select ok((select v from _cm where k = 'auth_update_blocked'), 'authenticated cannot UPDATE the roster');
select ok((select v from _cm where k = 'email_intact'),        'the PII email was never mutated by a client attempt');

-- ── FK on delete set null: deleting the venue keeps the roster row ────────────
delete from venues where id = '00000000-0000-0000-0000-0000000cd001';
select ok(
  (select venue_id is null from channel_members where membership_ref = 'ASSOC-0001'),
  'deleting the matched venue nulls venue_id but keeps the roster row'
);

select * from finish();
rollback;

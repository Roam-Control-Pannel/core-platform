-- ============================================================================
-- pgTAP regression tests for 0143_orgs_self_serve.sql  (MANDATORY-review slice)
--
-- Proves the three lines of defence on the first client write to orgs:
--   1. entitlement — a non-member cannot create a supplier at all;
--   2. a hostile payload from a LIVE member is NEUTRALISED to draft/pending/owner=self, slug regenerated
--      (no self-approval, no ownership spoof, no slug-squatting);
--   3. the moderation hard gate — a freshly-created (draft) supplier is invisible to the public; and an
--      owner cannot UPDATE their way to approved.
-- Client writes run under SET ROLE authenticated (auth.uid() from the jwt sub); outcomes are stashed
-- and asserted as the owner role.
-- ============================================================================
begin;
select plan(11);

-- ── structural ───────────────────────────────────────────────────────────────
select has_function('public', 'f2g_can_post_supplier', 'the supplier entitlement exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.f2g_can_post_supplier()'::regprocedure),
  true, 'f2g_can_post_supplier is SECURITY DEFINER');
select has_trigger('public', 'orgs', 'orgs_guard_client_insert', 'the client-insert guard is installed');

-- ── fixtures (owner role: bypasses RLS + the roster guard) ────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000cd0a1', 'live-supplier@f2g.example'),   -- A: LIVE f2g member
  ('00000000-0000-0000-0000-0000000cd0a2', 'not-a-member@rando.example');  -- B: not a member

-- Matched to a venue: half of the canonical membership predicate as of 0154 (live AND matched).
insert into venues (id, name, geo, status, categories) values
  ('00000000-0000-0000-0000-0000000cd0c1', 'Supplier A Cafe',
   ST_SetSRID(ST_MakePoint(-5.9300, 54.6000), 4326), 'claimed', array['cafe']);

insert into channel_members (id, channel_id, source_name, membership_ref, status, claimed_by, venue_id)
select '00000000-0000-0000-0000-0000000cd0b1', c.id, 'Supplier A', 'ASSOC-C3A', 'live',
       '00000000-0000-0000-0000-0000000cd0a1', '00000000-0000-0000-0000-0000000cd0c1'
from channels c where c.key = 'f2g';

create temp table _og (k text primary key, v boolean);

do $$
declare a_ok boolean := false; b_blocked boolean := false; self_approve_blocked boolean := false;
begin
  -- As LIVE member A: submit a HOSTILE payload trying to self-approve, go live, spoof owner, pick a slug.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000cd0a1","role":"authenticated"}', true);
  begin
    insert into orgs (id, owner_id, name, locality, status, moderation, slug)
    values ('00000000-0000-0000-0000-0000000cd0e1', '00000000-0000-0000-0000-0000000cd0a2',
            'Hostile Supplier', 'Belfast', 'live', 'approved', 'premium-slug');
    a_ok := true;
  exception when others then a_ok := false; end;

  -- A cannot self-approve via UPDATE (the 0136 owner-column guard blocks it).
  begin
    update orgs set moderation = 'approved', status = 'live' where id = '00000000-0000-0000-0000-0000000cd0e1';
  exception when others then self_approve_blocked := true; end;

  -- As non-member B: the entitlement gate rejects the insert outright.
  perform set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000cd0a2","role":"authenticated"}', true);
  begin
    insert into orgs (owner_id, name, locality) values ('00000000-0000-0000-0000-0000000cd0a2', 'Not Allowed', 'Belfast');
  exception when others then b_blocked := true; end;

  perform set_config('role', 'postgres', true);
  insert into _og values ('a_ok', a_ok), ('b_blocked', b_blocked), ('self_approve_blocked', self_approve_blocked);
end $$;

select ok((select v from _og where k = 'a_ok'), 'a live member can create a supplier');
-- The hostile payload was neutralised: draft / pending / owner = the caller / slug regenerated.
select is((select status     from orgs where id = '00000000-0000-0000-0000-0000000cd0e1'), 'draft',
  'a self-served supplier is forced to draft (never live on creation)');
select is((select moderation::text from orgs where id = '00000000-0000-0000-0000-0000000cd0e1'), 'pending',
  'moderation is forced to pending (no self-approval on insert)');
select is((select owner_id from orgs where id = '00000000-0000-0000-0000-0000000cd0e1'),
  '00000000-0000-0000-0000-0000000cd0a1'::uuid, 'owner is forced to the caller (no ownership spoof)');
select isnt((select slug from orgs where id = '00000000-0000-0000-0000-0000000cd0e1'), 'premium-slug',
  'a client-supplied slug is ignored and regenerated (no slug-squatting)');
select ok((select v from _og where k = 'self_approve_blocked'),
  'an owner cannot UPDATE their supplier to approved/live');
select ok((select v from _og where k = 'b_blocked'),
  'a non-member cannot create a supplier (entitlement gate)');

-- anon cannot see the draft supplier (moderation hard gate).
do $$
declare anon_sees int := -1;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select count(*) into anon_sees from orgs where id = '00000000-0000-0000-0000-0000000cd0e1';
  perform set_config('role', 'postgres', true);
  insert into _og values ('anon_blind', anon_sees = 0);
end $$;
select ok((select v from _og where k = 'anon_blind'), 'a draft supplier is invisible to the public (hard gate)');

select * from finish();
rollback;

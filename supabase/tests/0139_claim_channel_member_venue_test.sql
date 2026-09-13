-- ============================================================================
-- pgTAP regression tests for 0139_claim_channel_member_venue.sql
--
-- claim_channel_member_venue is the ownership-grant path — the single most dangerous write in the
-- platform. These tests prove the whole gate:
--   * structural — the fn exists, is SECURITY DEFINER, and EXECUTE is granted ONLY to service_role
--     (the grant is the entire access control for a definer that bypasses RLS + the roster guard);
--   * conferral — a matched, imported member is claimed exactly once: venue -> claimed + owner set,
--     member -> claimed, venue_channels tagged;
--   * single-use / idempotency — a same-claimant re-click is a no-op success; a DIFFERENT user's
--     replay is refused (never a second conferral);
--   * adversarial — a token re-pointed at the wrong venue, an already-owned venue (no steal), a
--     non-claimable status, and a missing member each raise their typed SQLSTATE.
-- ============================================================================
begin;
select plan(17);

-- ── structural ───────────────────────────────────────────────────────────────
select has_function('public', 'claim_channel_member_venue', array['uuid', 'uuid', 'uuid'],
  'claim_channel_member_venue(uuid, uuid, uuid) exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.claim_channel_member_venue(uuid, uuid, uuid)'::regprocedure),
  true,
  'claim_channel_member_venue is SECURITY DEFINER');
select ok(
  has_function_privilege('service_role', 'public.claim_channel_member_venue(uuid, uuid, uuid)', 'execute'),
  'service_role CAN execute the conferral');
select ok(
  not has_function_privilege('authenticated', 'public.claim_channel_member_venue(uuid, uuid, uuid)', 'execute'),
  'authenticated CANNOT execute the conferral (ownership can never be self-conferred)');
select ok(
  not has_function_privilege('anon', 'public.claim_channel_member_venue(uuid, uuid, uuid)', 'execute'),
  'anon CANNOT execute the conferral');

-- ── fixtures (as the test/owner role: bypasses RLS + the roster guard) ─────────
-- Two real users (profiles auto-provisioned by trg_auth_user_created).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000cd0a1', 'claimant-a@verbatim.example'),
  ('00000000-0000-0000-0000-0000000cd0a2', 'claimant-b@rival.example');

-- Venues: V1 unclaimed (happy path), V2 unclaimed (wrong-venue binding), V3 already owned by user B.
insert into venues (id, name, geo, status, owner_id) values
  ('00000000-0000-0000-0000-0000000cd0c1', 'Verbatim Cafe',
   ST_SetSRID(ST_MakePoint(-5.9301, 54.5973), 4326), 'unclaimed', null),
  ('00000000-0000-0000-0000-0000000cd0c2', 'Second Venue',
   ST_SetSRID(ST_MakePoint(-5.9302, 54.5974), 4326), 'unclaimed', null),
  ('00000000-0000-0000-0000-0000000cd0c3', 'Already Owned Venue',
   ST_SetSRID(ST_MakePoint(-5.9303, 54.5975), 4326), 'claimed', '00000000-0000-0000-0000-0000000cd0a2');

-- Roster members on the f2g channel, each matched (venue_id set) to one venue.
insert into channel_members (id, channel_id, source_name, source_email, membership_ref, venue_id, status)
select '00000000-0000-0000-0000-0000000cd0e1', c.id, 'Verbatim Cafe', 'owner@verbatim.example',
       'ASSOC-D01', '00000000-0000-0000-0000-0000000cd0c1', 'invited' from channels c where c.key = 'f2g';
insert into channel_members (id, channel_id, source_name, source_email, membership_ref, venue_id, status)
select '00000000-0000-0000-0000-0000000cd0e2', c.id, 'Second Cafe', 'owner2@second.example',
       'ASSOC-D02', '00000000-0000-0000-0000-0000000cd0c2', 'imported' from channels c where c.key = 'f2g';
insert into channel_members (id, channel_id, source_name, source_email, membership_ref, venue_id, status)
select '00000000-0000-0000-0000-0000000cd0e3', c.id, 'Rival Cafe', 'owner3@rival.example',
       'ASSOC-D03', '00000000-0000-0000-0000-0000000cd0c3', 'imported' from channels c where c.key = 'f2g';
insert into channel_members (id, channel_id, source_name, source_email, membership_ref, venue_id, status)
select '00000000-0000-0000-0000-0000000cd0e4', c.id, 'Gone Cafe', 'owner4@gone.example',
       'ASSOC-D04', '00000000-0000-0000-0000-0000000cd0c2', 'removed' from channels c where c.key = 'f2g';

-- ── conferral (the happy path): member D01 -> venue V1 by user A ───────────────
select is(
  (select outcome from public.claim_channel_member_venue(
     '00000000-0000-0000-0000-0000000cd0e1', '00000000-0000-0000-0000-0000000cd0c1',
     '00000000-0000-0000-0000-0000000cd0a1')),
  'claimed',
  'accepting a matched, invited member confers the claim');
select is(
  (select owner_id from venues where id = '00000000-0000-0000-0000-0000000cd0c1'),
  '00000000-0000-0000-0000-0000000cd0a1'::uuid,
  'the venue owner_id is now the claimant (the dangerous write, done here)');
select is(
  (select status::text from venues where id = '00000000-0000-0000-0000-0000000cd0c1'),
  'claimed',
  'the venue status advanced to claimed');
select is(
  (select status from channel_members where id = '00000000-0000-0000-0000-0000000cd0e1'),
  'claimed',
  'the roster member advanced to claimed');
select is(
  (select claimed_by from channel_members where id = '00000000-0000-0000-0000-0000000cd0e1'),
  '00000000-0000-0000-0000-0000000cd0a1'::uuid,
  'the roster member records who claimed it');
select ok(
  exists (
    select 1 from venue_channels vc join channels c on c.id = vc.channel_id
    where vc.venue_id = '00000000-0000-0000-0000-0000000cd0c1' and c.key = 'f2g'
  ),
  'conferral also tags the venue into its channel (members-mode readiness)');

-- ── single-use / idempotency ──────────────────────────────────────────────────
-- Same claimant re-clicks their link: a no-op success, not a second conferral.
select is(
  (select outcome from public.claim_channel_member_venue(
     '00000000-0000-0000-0000-0000000cd0e1', '00000000-0000-0000-0000-0000000cd0c1',
     '00000000-0000-0000-0000-0000000cd0a1')),
  'already_claimed',
  'a same-claimant re-click is an idempotent no-op');
-- A DIFFERENT user presents the (already-used) link: refused — never a second conferral.
select throws_ok(
  $$ select public.claim_channel_member_venue(
       '00000000-0000-0000-0000-0000000cd0e1', '00000000-0000-0000-0000-0000000cd0c1',
       '00000000-0000-0000-0000-0000000cd0a2') $$,
  'P0001', 'NOT_CLAIMABLE',
  'a different user replaying a used invite is refused');

-- ── adversarial ───────────────────────────────────────────────────────────────
-- Token re-pointed at a venue the member isn't matched to: VENUE_MISMATCH.
select throws_ok(
  $$ select public.claim_channel_member_venue(
       '00000000-0000-0000-0000-0000000cd0e2', '00000000-0000-0000-0000-0000000cd0c1',
       '00000000-0000-0000-0000-0000000cd0a1') $$,
  'P0001', 'VENUE_MISMATCH',
  'a token cannot be re-pointed at a venue the member is not matched to');
-- Venue already owned by someone else: CLAIMED_BY_OTHER (never steal a claim).
select throws_ok(
  $$ select public.claim_channel_member_venue(
       '00000000-0000-0000-0000-0000000cd0e3', '00000000-0000-0000-0000-0000000cd0c3',
       '00000000-0000-0000-0000-0000000cd0a1') $$,
  'P0001', 'CLAIMED_BY_OTHER',
  'an already-owned venue is never re-conferred to another user');
-- A non-claimable status (removed): NOT_CLAIMABLE.
select throws_ok(
  $$ select public.claim_channel_member_venue(
       '00000000-0000-0000-0000-0000000cd0e4', '00000000-0000-0000-0000-0000000cd0c2',
       '00000000-0000-0000-0000-0000000cd0a1') $$,
  'P0001', 'NOT_CLAIMABLE',
  'a removed member is not claimable');
-- A missing member: MEMBER_NOT_FOUND.
select throws_ok(
  $$ select public.claim_channel_member_venue(
       '00000000-0000-0000-0000-00000000dead', '00000000-0000-0000-0000-0000000cd0c1',
       '00000000-0000-0000-0000-0000000cd0a1') $$,
  'P0002', 'MEMBER_NOT_FOUND',
  'a missing member raises MEMBER_NOT_FOUND');

select * from finish();
rollback;

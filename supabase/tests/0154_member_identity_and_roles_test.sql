-- ============================================================================
-- pgTAP regression tests for 0154_member_identity_and_roles.sql
--
-- Load-bearing properties:
--   * identity columns exist and actually constrain (a system without an id, a duplicate CRM id, a
--     duplicate membership number are all refused);
--   * venue_channels.role defaults to 'member', so pre-0154 tags rank exactly as they did;
--   * ONE membership predicate — live AND matched — is what the ranking helper, the directory and
--     the members-mode listing each apply. In particular a member HQ marked live with NO claimant is
--     still counted (0150's behaviour), while the legacy 'claimed' status no longer is;
--   * a 'listed' non-member is listed but never ranked or badged as a member;
--   * the council is derived from the matched venue's FSA establishment;
--   * the claim definer lands on 'live' and tags role='member', upgrading an existing 'listed' tag.
-- ============================================================================
begin;
select plan(31);

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000e5401', 'claimant@0154.example'),
  ('00000000-0000-0000-0000-0000000e5402', 'other@0154.example');

insert into venues (id, name, geo, status, categories) values
  ('00000000-0000-0000-0000-0000000e5411', 'Live Member Cafe',
   ST_SetSRID(ST_MakePoint(-5.9300, 54.6000), 4326), 'unclaimed', array['cafe']),
  ('00000000-0000-0000-0000-0000000e5412', 'Legacy Claimed Cafe',
   ST_SetSRID(ST_MakePoint(-5.9301, 54.6001), 4326), 'unclaimed', array['cafe']),
  ('00000000-0000-0000-0000-0000000e5413', 'Listed Non Member',
   ST_SetSRID(ST_MakePoint(-5.9302, 54.6002), 4326), 'unclaimed', array['cafe']),
  ('00000000-0000-0000-0000-0000000e5414', 'Tagged Member',
   ST_SetSRID(ST_MakePoint(-5.9303, 54.6003), 4326), 'unclaimed', array['cafe']),
  ('00000000-0000-0000-0000-0000000e5415', 'Claimable Cafe',
   ST_SetSRID(ST_MakePoint(-5.9304, 54.6004), 4326), 'unclaimed', array['cafe']),
  ('00000000-0000-0000-0000-0000000e5416', 'Upgrade Cafe',
   ST_SetSRID(ST_MakePoint(-5.9305, 54.6005), 4326), 'unclaimed', array['cafe']);

-- ── 1. the identity columns exist ────────────────────────────────────────────
select has_column('public', 'channel_members', 'source_system',       'channel_members.source_system exists');
select has_column('public', 'channel_members', 'source_system_id',    'channel_members.source_system_id exists');
select has_column('public', 'channel_members', 'member_no',           'channel_members.member_no exists (2027)');
select has_column('public', 'channel_members', 'last_seen_import_id', 'channel_members.last_seen_import_id exists');
select has_column('public', 'venue_channels',  'role',                'venue_channels.role exists');
select has_column('public', 'channels',        'contact_email',       'channels.contact_email exists');
select has_column('public', 'channels',        'org_name',            'channels.org_name exists');

-- ── 2. ...and they constrain ─────────────────────────────────────────────────
select throws_ok(
  $$insert into channel_members (channel_id, source_name, membership_ref, source_system)
    select id, 'No Id', 'F2G-0154-BAD', 'hubspot' from channels where key = 'f2g'$$,
  '23514',
  null,
  'a system of record without an id in it is refused');

insert into channel_members (channel_id, source_name, membership_ref, source_system, source_system_id)
  select id, 'CRM Member', 'F2G-0154-CRM', 'hubspot', 'hs-1001' from channels where key = 'f2g';

select throws_ok(
  $$insert into channel_members (channel_id, source_name, membership_ref, source_system, source_system_id)
    select id, 'CRM Member Again', 'F2G-0154-CRM-DUP', 'hubspot', 'hs-1001' from channels where key = 'f2g'$$,
  '23505',
  null,
  'one member per (channel, system, id) — a re-import cannot duplicate a CRM record');

update channel_members set member_no = 'NIF-0001' where membership_ref = 'F2G-0154-CRM';
insert into channel_members (channel_id, source_name, membership_ref)
  select id, 'Number Clash', 'F2G-0154-NO-DUP' from channels where key = 'f2g';

select throws_ok(
  $$update channel_members set member_no = 'NIF-0001' where membership_ref = 'F2G-0154-NO-DUP'$$,
  '23505',
  null,
  'a membership number is unique within a channel (from 2027)');

-- ── 3. venue_channels.role ───────────────────────────────────────────────────
-- AMENDED BY 0160. This fixture used to omit `role` and assert it defaulted to 'member'. That
-- default was the 0154 defect: it turned an omission in the self-serve tagging path into a grant of
-- membership. 0160 dropped it, so the write is explicit here and the absence of a default is
-- asserted in 0160's own test.
insert into venue_channels (channel_id, venue_id, role)
  select id, '00000000-0000-0000-0000-0000000e5414', 'member' from channels where key = 'f2g';

select is(
  (select role from venue_channels where venue_id = '00000000-0000-0000-0000-0000000e5414'),
  'member',
  'a service-side tag written as member is ranked as one, as it was before 0154');

select throws_ok(
  $$insert into venue_channels (channel_id, venue_id, role)
    select id, '00000000-0000-0000-0000-0000000e5413', 'associate' from channels where key = 'f2g'$$,
  '23514',
  null,
  'role is constrained to member|listed');

insert into venue_channels (channel_id, venue_id, role)
  select id, '00000000-0000-0000-0000-0000000e5413', 'listed' from channels where key = 'f2g';

-- ── 4. THE canonical membership predicate ────────────────────────────────────
-- A member HQ marked live: no claimed_by at all. 0150 shipped this deliberately ("they ARE counted,
-- listed and ranked from this moment"), so the predicate must NOT require a claimant.
insert into channel_members (channel_id, source_name, membership_ref, venue_id, status)
  select id, 'Live Member Cafe', 'F2G-0154-LIVE', '00000000-0000-0000-0000-0000000e5411', 'live'
  from channels where key = 'f2g';

-- A legacy 'claimed' row: was counted before 0154, must not be now.
insert into channel_members (channel_id, source_name, membership_ref, venue_id, status, claimed_by)
  select id, 'Legacy Claimed Cafe', 'F2G-0154-CLAIMED', '00000000-0000-0000-0000-0000000e5412', 'claimed',
         '00000000-0000-0000-0000-0000000e5402'
  from channels where key = 'f2g';

select is(
  (select count(*)::int from f2g_member_venue_ids((select id from channels where key = 'f2g'))
    where venue_id = '00000000-0000-0000-0000-0000000e5411'),
  1,
  'a live, matched member with NO claimant is still counted as a member (0150 behaviour preserved)');

select is(
  (select count(*)::int from f2g_member_venue_ids((select id from channels where key = 'f2g'))
    where venue_id = '00000000-0000-0000-0000-0000000e5412'),
  0,
  'the legacy ''claimed'' status is no longer membership — only ''live'' is');

select is(
  (select count(*)::int from f2g_member_venue_ids((select id from channels where key = 'f2g'))
    where venue_id = '00000000-0000-0000-0000-0000000e5413'),
  0,
  'a role=listed non-member is NOT in the member set');

select is(
  (select count(*)::int from f2g_member_venue_ids((select id from channels where key = 'f2g'))
    where venue_id = '00000000-0000-0000-0000-0000000e5414'),
  1,
  'a role=member tag IS in the member set');

select is(
  (select count(*)::int from f2g_member_venue_ids(null)),
  0,
  'a null channel still yields no rows (the pre-D3 ordering collapse)');

-- ── 5. members-mode listing: listed venues appear, but not AS members ────────
select is(
  (select is_member from venues_in_channel_near(
     (select id from channels where key = 'f2g'), 54.6000, -5.9300, 50, 0)
    where id = '00000000-0000-0000-0000-0000000e5414'),
  true,
  'members-mode listing badges a member venue');

select is(
  (select is_member from venues_in_channel_near(
     (select id from channels where key = 'f2g'), 54.6000, -5.9300, 50, 0)
    where id = '00000000-0000-0000-0000-0000000e5413'),
  false,
  'a listed non-member is returned by the listing but is NOT badged a member');

-- ── 6. the public directory ──────────────────────────────────────────────────
-- Council of record comes from the FSA register via the venue's fsa match.
insert into fsa_establishments (fhrsid, business_name, postcode, rating_value, local_authority)
  values ('FHRS-0154-1', 'Live Member Cafe', 'BT1 1AA', '5', 'Belfast City Council');
insert into external_refs (entity_type, entity_id, dataset, external_id, method)
  values ('venue', '00000000-0000-0000-0000-0000000e5411', 'fsa', 'FHRS-0154-1', 'auto');

select is(
  (select count(*)::int from channel_members_search('f2g', null, null, null, null, null, 50, 0)
    where member_id = (select id from channel_members where membership_ref = 'F2G-0154-LIVE')),
  1,
  'a live, matched member is in the public directory');

select is(
  (select council from channel_members_search('f2g', null, null, null, null, null, 50, 0)
    where member_id = (select id from channel_members where membership_ref = 'F2G-0154-LIVE')),
  'Belfast City Council',
  'the council is derived from the matched venue''s FSA establishment');

-- The roster's own value still wins where it has one (the derivation is a fallback, not an override).
update channel_members set source_council = 'Ards and North Down'
 where membership_ref = 'F2G-0154-LIVE';

select is(
  (select council from channel_members_search('f2g', null, null, null, null, null, 50, 0)
    where member_id = (select id from channel_members where membership_ref = 'F2G-0154-LIVE')),
  'Ards and North Down',
  'a council supplied by the roster takes precedence over the derived one');

-- A live member with no matched venue has nothing to list and must not appear.
insert into channel_members (channel_id, source_name, membership_ref, status)
  select id, 'Unmatched Live', 'F2G-0154-NOVENUE', 'live' from channels where key = 'f2g';

select is(
  (select count(*)::int from channel_members_search('f2g', null, null, null, null, null, 50, 0)
    where member_id = (select id from channel_members where membership_ref = 'F2G-0154-NOVENUE')),
  0,
  'the directory applies the whole predicate: a live member with no venue is not listed');

-- ── 7. entitlements: membership PLUS the caller's own claim ──────────────────
insert into channel_members (channel_id, source_name, membership_ref, venue_id, status, claimed_by)
  select id, 'Entitled Member', 'F2G-0154-ENT', '00000000-0000-0000-0000-0000000e5415', 'live',
         '00000000-0000-0000-0000-0000000e5401'
  from channels where key = 'f2g';

select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5401', true);

select is(
  f2g_can_post_as_member((select id from channels where key = 'f2g')),
  true,
  'a claimed, live, matched member may post as a member');

-- Strip the venue: membership requires a match, so the entitlement must fall away with it.
update channel_members set venue_id = null where membership_ref = 'F2G-0154-ENT';

select is(
  f2g_can_post_as_member((select id from channels where key = 'f2g')),
  false,
  'the entitlement applies the whole predicate — no matched venue, no posting');

select is(
  f2g_can_post_supplier(),
  false,
  'the supplier entitlement applies the same predicate');

-- ── 8. the claim definer lands on live and tags the venue as a member ────────
update channel_members set venue_id = '00000000-0000-0000-0000-0000000e5415'
 where membership_ref = 'F2G-0154-ENT';

insert into channel_members (channel_id, source_name, membership_ref, venue_id, status)
  select id, 'Upgrade Cafe', 'F2G-0154-UPGRADE', '00000000-0000-0000-0000-0000000e5416', 'invited'
  from channels where key = 'f2g';

-- This venue was self-listed first; claiming through an Association invite must upgrade the tag.
insert into venue_channels (channel_id, venue_id, role)
  select id, '00000000-0000-0000-0000-0000000e5416', 'listed' from channels where key = 'f2g';

select lives_ok(
  $$select claim_channel_member_venue(
      (select id from channel_members where membership_ref = 'F2G-0154-UPGRADE'),
      '00000000-0000-0000-0000-0000000e5416',
      '00000000-0000-0000-0000-0000000e5401')$$,
  'an invited member can claim its matched venue');

select is(
  (select status from channel_members where membership_ref = 'F2G-0154-UPGRADE'),
  'live',
  'a successful claim lands on LIVE, not the legacy ''claimed'' (0154)');

select is(
  (select role from venue_channels
    where venue_id = '00000000-0000-0000-0000-0000000e5416'),
  'member',
  'claiming upgrades a pre-existing ''listed'' tag to ''member''');

select is(
  (select count(*)::int from f2g_member_venue_ids((select id from channels where key = 'f2g'))
    where venue_id = '00000000-0000-0000-0000-0000000e5416'),
  1,
  'the claimant is a member immediately — no manual HQ step needed');

select is(
  (select (claim_channel_member_venue(
      (select id from channel_members where membership_ref = 'F2G-0154-UPGRADE'),
      '00000000-0000-0000-0000-0000000e5416',
      '00000000-0000-0000-0000-0000000e5401')).outcome),
  'already_claimed',
  're-clicking the link is still an idempotent no-op now that the landing status is live');

select * from finish();
rollback;

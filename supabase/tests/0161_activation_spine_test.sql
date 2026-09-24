-- ============================================================================
-- pgTAP regression tests for 0161_activation_spine.sql
--
-- The security claims under test, in the order they matter:
--   * `venue_channels` has NO client-writable path left at all — 0160 narrowed the owner-write
--     policy, 0161 removes it, so self-tagging through PostgREST is gone rather than restricted.
--   * activation NEVER confers a pair the roster does not already assert (unbound and mismatched
--     both refused), and never revives a lapsed member.
--   * an owner may withdraw their own LISTING but can never remove a MEMBER tag, which would
--     silently un-rank a member the Association placed.
--   * the codes and the attempt audit are unreachable from any client role.
-- ============================================================================
begin;
select plan(23);

-- ── posture ──────────────────────────────────────────────────────────────────
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'venue_channels' and policyname = 'venue_channels_owner_write'),
  0,
  'venue_channels_owner_write is GONE — PostgREST self-tagging is removed, not merely narrowed');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.channel_activation_codes'::regclass),
  'channel_activation_codes has RLS on');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'channel_activation_codes'),
  0,
  'and NO policy — a table of credentials is unreachable from every client role');

select ok(
  (select relrowsecurity from pg_class where oid = 'public.channel_activation_attempts'::regclass),
  'channel_activation_attempts has RLS on');
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'channel_activation_attempts'),
  0,
  'and NO policy — an audit the audited party can read or write is not an audit');

select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'channel_activation_codes'
      and column_name in ('code', 'code_plain', 'secret')),
  0,
  'no column holds a plaintext code — a backup of this table is not a list of live credentials');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('activate_channel_member_venue', 'tag_venue_listing', 'untag_venue_listing')
      and p.prosecdef),
  3,
  'all three conferral functions are SECURITY DEFINER');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('activate_channel_member_venue', 'tag_venue_listing', 'untag_venue_listing')
      and (has_function_privilege('anon', p.oid, 'EXECUTE')
        or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  0,
  'and none is executable by anon or authenticated — the API reaches them with the service client');

-- ── fixtures ─────────────────────────────────────────────────────────────────
insert into channels (key, name, is_default) values ('test-act-0161', 'Activation Channel', false);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000016101a', 'owner@act.example'),
  ('00000000-0000-0000-0000-00000016101b', 'other@act.example');

insert into venues (id, name, geo, status, categories) values
  ('00000000-0000-0000-0000-000000016101', 'Bound Cafe',
   st_setsrid(st_makepoint(-5.93, 54.60), 4326)::geography, 'unclaimed', array['cafe']),
  ('00000000-0000-0000-0000-000000016102', 'Unbound Cafe',
   st_setsrid(st_makepoint(-5.94, 54.61), 4326)::geography, 'unclaimed', array['cafe']),
  ('00000000-0000-0000-0000-000000016103', 'Other Cafe',
   st_setsrid(st_makepoint(-5.95, 54.62), 4326)::geography, 'unclaimed', array['cafe']),
  ('00000000-0000-0000-0000-000000016104', 'Lapsed Cafe',
   st_setsrid(st_makepoint(-5.96, 54.63), 4326)::geography, 'unclaimed', array['cafe']);

-- An owned, claimed venue for the listing tests.
insert into venues (id, name, geo, status, categories, owner_id) values
  ('00000000-0000-0000-0000-000000016105', 'Owned Cafe',
   st_setsrid(st_makepoint(-5.97, 54.64), 4326)::geography, 'claimed', array['cafe'],
   '00000000-0000-0000-0000-00000016101a'),
  ('00000000-0000-0000-0000-000000016106', 'Member Cafe',
   st_setsrid(st_makepoint(-5.98, 54.65), 4326)::geography, 'claimed', array['cafe'],
   '00000000-0000-0000-0000-00000016101a');

insert into channel_members (channel_id, source_name, membership_ref, venue_id, status)
  select id, 'Bound Member', 'F2G-0161-BOUND', '00000000-0000-0000-0000-000000016101', 'imported'
    from channels where key = 'test-act-0161';
insert into channel_members (channel_id, source_name, membership_ref, venue_id, status)
  select id, 'Unbound Member', 'F2G-0161-UNBOUND', null, 'imported'
    from channels where key = 'test-act-0161';
insert into channel_members (channel_id, source_name, membership_ref, venue_id, status)
  select id, 'Lapsed Member', 'F2G-0161-LAPSED', '00000000-0000-0000-0000-000000016104', 'lapsed'
    from channels where key = 'test-act-0161';
insert into channel_members (channel_id, source_name, membership_ref, venue_id, status)
  select id, 'Contested Member', 'F2G-0161-OTHER', '00000000-0000-0000-0000-000000016103', 'imported'
    from channels where key = 'test-act-0161';

-- Someone else already owns the contested venue.
update venues set owner_id = '00000000-0000-0000-0000-00000016101b', status = 'claimed'
  where id = '00000000-0000-0000-0000-000000016103';

-- A venue the Association placed as a member, to prove an owner cannot resign it.
insert into venue_channels (channel_id, venue_id, role)
  select id, '00000000-0000-0000-0000-000000016106', 'member' from channels where key = 'test-act-0161';

create temporary table _act (name text primary key, ok boolean) on commit drop;

do $$
declare
  ch  uuid;
  m_bound uuid; m_unbound uuid; m_lapsed uuid; m_other uuid;
  r   channel_member_claim_result;
  unbound_refused boolean := false;
  mismatch_refused boolean := false;
  lapsed_refused boolean := false;
  other_refused boolean := false;
  activated boolean := false;
  idempotent boolean := false;
  non_owner_refused boolean := false;
  listed_ok boolean := false;
  member_not_demoted boolean := true;
  member_untag_refused boolean := false;
  listed_untag_ok boolean := false;
  client_write_refused boolean := false;
begin
  select id into ch from channels where key = 'test-act-0161';
  select id into m_bound   from channel_members where membership_ref = 'F2G-0161-BOUND';
  select id into m_unbound from channel_members where membership_ref = 'F2G-0161-UNBOUND';
  select id into m_lapsed  from channel_members where membership_ref = 'F2G-0161-LAPSED';
  select id into m_other   from channel_members where membership_ref = 'F2G-0161-OTHER';

  -- An unbound roster row is refused even though a caller might believe the postcodes agree.
  begin
    r := activate_channel_member_venue(m_unbound, '00000000-0000-0000-0000-000000016102',
                                       '00000000-0000-0000-0000-00000016101a');
  exception when others then unbound_refused := (sqlerrm like '%NOT_BOUND%'); end;

  -- A bound row, pointed at a different venue.
  begin
    r := activate_channel_member_venue(m_bound, '00000000-0000-0000-0000-000000016102',
                                       '00000000-0000-0000-0000-00000016101a');
  exception when others then mismatch_refused := (sqlerrm like '%VENUE_MISMATCH%'); end;

  -- A lapsed member has no self-serve route back.
  begin
    r := activate_channel_member_venue(m_lapsed, '00000000-0000-0000-0000-000000016104',
                                       '00000000-0000-0000-0000-00000016101a');
  exception when others then lapsed_refused := (sqlerrm like '%NOT_CLAIMABLE%'); end;

  -- A venue already owned by someone else is never stolen.
  begin
    r := activate_channel_member_venue(m_other, '00000000-0000-0000-0000-000000016103',
                                       '00000000-0000-0000-0000-00000016101a');
  exception when others then other_refused := (sqlerrm like '%CLAIMED_BY_OTHER%'); end;

  -- The legitimate path.
  r := activate_channel_member_venue(m_bound, '00000000-0000-0000-0000-000000016101',
                                     '00000000-0000-0000-0000-00000016101a');
  activated := r.outcome = 'activated';

  -- Re-running is a no-op success for the same account.
  r := activate_channel_member_venue(m_bound, '00000000-0000-0000-0000-000000016101',
                                     '00000000-0000-0000-0000-00000016101a');
  idempotent := r.outcome = 'already_claimed';

  -- Listing: not your venue.
  begin
    perform tag_venue_listing('00000000-0000-0000-0000-000000016102', ch,
                              '00000000-0000-0000-0000-00000016101a');
  exception when others then non_owner_refused := (sqlerrm like '%NOT_VENUE_OWNER%'); end;

  -- Listing: your own claimed venue.
  perform tag_venue_listing('00000000-0000-0000-0000-000000016105', ch,
                            '00000000-0000-0000-0000-00000016101a');
  listed_ok := exists (select 1 from venue_channels
                        where channel_id = ch and venue_id = '00000000-0000-0000-0000-000000016105'
                          and role = 'listed');

  -- Listing a venue that is already a MEMBER must not demote it.
  perform tag_venue_listing('00000000-0000-0000-0000-000000016106', ch,
                            '00000000-0000-0000-0000-00000016101a');
  member_not_demoted := (select role from venue_channels
                          where channel_id = ch and venue_id = '00000000-0000-0000-0000-000000016106') = 'member';

  -- Unlisting: a member tag is the Association's, not the owner's, to remove.
  begin
    perform untag_venue_listing('00000000-0000-0000-0000-000000016106', ch,
                                '00000000-0000-0000-0000-00000016101a');
  exception when others then member_untag_refused := (sqlerrm like '%NOT_A_LISTING%'); end;

  -- Unlisting their own listing is fine.
  perform untag_venue_listing('00000000-0000-0000-0000-000000016105', ch,
                              '00000000-0000-0000-0000-00000016101a');
  listed_untag_ok := not exists (select 1 from venue_channels
                                  where channel_id = ch and venue_id = '00000000-0000-0000-0000-000000016105');

  -- THE REMOVAL: a real authenticated role has no write to venue_channels at all any more.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-00000016101a","role":"authenticated"}', true);
  begin
    insert into venue_channels (channel_id, venue_id, role)
      values (ch, '00000000-0000-0000-0000-000000016105', 'listed');
  exception when others then client_write_refused := true; end;
  perform set_config('role', 'postgres', true);

  insert into _act values
    ('unbound_refused',      unbound_refused),
    ('mismatch_refused',     mismatch_refused),
    ('lapsed_refused',       lapsed_refused),
    ('other_refused',        other_refused),
    ('activated',            activated),
    ('idempotent',           idempotent),
    ('non_owner_refused',    non_owner_refused),
    ('listed_ok',            listed_ok),
    ('member_not_demoted',   member_not_demoted),
    ('member_untag_refused', member_untag_refused),
    ('listed_untag_ok',      listed_untag_ok),
    ('client_write_refused', client_write_refused);
end $$;

select ok((select ok from _act where name = 'client_write_refused'),
  'an authenticated role cannot write venue_channels AT ALL — self-tagging is removed, not narrowed');
select ok((select ok from _act where name = 'unbound_refused'),
  'activation refuses an UNBOUND roster row: the database never confers a pair the roster does not assert');
select ok((select ok from _act where name = 'mismatch_refused'),
  'and refuses a bound row pointed at a different venue');
select ok((select ok from _act where name = 'lapsed_refused'),
  'a lapsed member has no self-serve route back — restoring is an import or an HQ action');
select ok((select ok from _act where name = 'other_refused'),
  'and a venue owned by someone else is never stolen');
select ok((select ok from _act where name = 'activated'),
  'the legitimate activation confers ownership and membership');
select ok((select ok from _act where name = 'idempotent'),
  'and re-running it for the same account is a no-op success, not a failure');

select is(
  (select status::text from venues where id = '00000000-0000-0000-0000-000000016101'),
  'claimed',
  'the activated venue is claimed by its new owner');
select is(
  (select role from venue_channels
    where venue_id = '00000000-0000-0000-0000-000000016101'),
  'member',
  'and tagged as a MEMBER — activation is one of the two routes to membership');
select is(
  (select status from channel_members where membership_ref = 'F2G-0161-BOUND'),
  'live',
  'and the roster row lands on live, inside the canonical membership predicate');

select ok((select ok from _act where name = 'non_owner_refused'),
  'tag_venue_listing refuses a venue the actor does not own, whatever the caller believes');
select ok((select ok from _act where name = 'listed_ok'),
  'an owner can list their own claimed venue');
select ok((select ok from _act where name = 'member_not_demoted'),
  'and listing a venue that is already a member never demotes it');
select ok((select ok from _act where name = 'member_untag_refused'),
  'an owner cannot remove a MEMBER tag — that would un-rank a member the Association placed');
select ok((select ok from _act where name = 'listed_untag_ok'),
  'but can withdraw their own listing');

select * from finish();
rollback;

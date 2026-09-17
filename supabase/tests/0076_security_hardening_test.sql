-- ============================================================================
-- pgTAP regression tests for 0076_security_hardening.sql (added 2026-09-17, when the live project
-- was found to have never received 0076: anon could execute claim_places_fetch_quota and
-- authenticated could execute upsert_place_venues).
--
-- This test pins the posture in the REPO's schema so a future drop+recreate of one of these
-- functions without its revoke fails CI. The LIVE side is covered by scripts/check-schema-drift.mjs,
-- which probes two of them as anon and expects 42501.
-- ============================================================================
begin;
select plan(13);

-- §1 service-only family: neither client role may execute (signatures as they exist today).
select ok(not has_function_privilege('anon', 'public.claim_places_fetch_quota(text,integer,integer,integer)', 'execute')
      and not has_function_privilege('authenticated', 'public.claim_places_fetch_quota(text,integer,integer,integer)', 'execute'),
  'claim_places_fetch_quota: closed to clients');
select ok(not has_function_privilege('anon', 'public.upsert_place_venues(jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'public.upsert_place_venues(jsonb)', 'execute'),
  'upsert_place_venues: closed to clients');
select ok(not has_function_privilege('anon', 'public.upsert_venue_photos(jsonb)', 'execute')
      and not has_function_privilege('authenticated', 'public.upsert_venue_photos(jsonb)', 'execute'),
  'upsert_venue_photos: closed to clients');
select ok(not has_function_privilege('anon', 'public.approve_venue_claim(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.approve_venue_claim(uuid)', 'execute'),
  'approve_venue_claim: closed to clients');
select ok(not has_function_privilege('anon', 'public.reject_venue_claim(uuid,text)', 'execute')
      and not has_function_privilege('authenticated', 'public.reject_venue_claim(uuid,text)', 'execute'),
  'reject_venue_claim: closed to clients');
select ok(not has_function_privilege('anon', 'public.moderate_ban_profile(uuid,boolean)', 'execute')
      and not has_function_privilege('authenticated', 'public.moderate_ban_profile(uuid,boolean)', 'execute'),
  'moderate_ban_profile: closed to clients');
select ok(not has_function_privilege('anon', 'public.moderate_set_venue_suspended(uuid,boolean)', 'execute')
      and not has_function_privilege('authenticated', 'public.moderate_set_venue_suspended(uuid,boolean)', 'execute'),
  'moderate_set_venue_suspended: closed to clients');
select ok(not has_function_privilege('anon', 'public.deliver_birthday_offers()', 'execute')
      and not has_function_privilege('authenticated', 'public.deliver_birthday_offers()', 'execute'),
  'deliver_birthday_offers: closed to clients');
select ok(not has_function_privilege('anon', 'public.venue_link_hosts(uuid)', 'execute')
      and not has_function_privilege('authenticated', 'public.venue_link_hosts(uuid)', 'execute'),
  'venue_link_hosts: closed to clients');

-- §2 internal generators
select ok(not has_function_privilege('anon', 'public.gen_unique_handle(text)', 'execute')
      and not has_function_privilege('authenticated', 'public.gen_unique_handle(text)', 'execute'),
  'gen_unique_handle: closed to clients (existence oracle)');

-- §4 signed-in-only RPCs: anon closed, authenticated open.
select ok(not has_function_privilege('anon', 'public.redeem_offer(uuid)', 'execute')
      and has_function_privilege('authenticated', 'public.redeem_offer(uuid)', 'execute'),
  'redeem_offer: anon closed, authenticated open');
select ok(not has_function_privilege('anon', 'public.request_venue_claim(uuid,text)', 'execute')
      and has_function_privilege('authenticated', 'public.request_venue_claim(uuid,text)', 'execute'),
  'request_venue_claim: anon closed, authenticated open');

-- §5 pinned search_path on the flagged invoker helper.
select ok(exists(select 1 from pg_proc where oid = 'public.are_friends(uuid,uuid)'::regprocedure
                   and proconfig @> array['search_path=public, pg_temp']),
  'are_friends: search_path pinned');

select * from finish();
rollback;

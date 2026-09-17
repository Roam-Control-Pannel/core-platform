-- ============================================================================
-- pgTAP regression tests for 0151_function_execute_hardening.sql
--
-- Load-bearing property: the three service-only functions are unreachable by BOTH client roles
-- (anon and authenticated), not merely revoked from public — Supabase's default privileges grant the
-- client roles EXECUTE directly, so a public-only revoke is a no-op for them. And the definer callers
-- of is_non_evidence_host keep working (they run as owner).
-- ============================================================================
begin;
select plan(11);

-- ── structural: the signatures this migration hardens still exist ────────────
select has_function('public', 'claim_places_detail_quota', array['text','integer','integer','integer'],
  'claim_places_detail_quota(text,int,int,int) exists');
select has_function('public', 'apply_venue_details', array['uuid','text','text','jsonb','jsonb','text'],
  'apply_venue_details 6-arg (0096) exists');
select has_function('public', 'is_non_evidence_host', array['text'],
  'is_non_evidence_host(text) exists');

-- ── the client roles hold NO execute grant (direct grant, not just via public) ─
select ok(not has_function_privilege('anon', 'public.claim_places_detail_quota(text, integer, integer, integer)', 'execute'),
  'anon cannot execute claim_places_detail_quota');
select ok(not has_function_privilege('authenticated', 'public.claim_places_detail_quota(text, integer, integer, integer)', 'execute'),
  'authenticated cannot execute claim_places_detail_quota');

select ok(not has_function_privilege('anon', 'public.apply_venue_details(uuid, text, text, jsonb, jsonb, text)', 'execute'),
  'anon cannot execute apply_venue_details');
select ok(not has_function_privilege('authenticated', 'public.apply_venue_details(uuid, text, text, jsonb, jsonb, text)', 'execute'),
  'authenticated cannot execute apply_venue_details');

select ok(not has_function_privilege('anon', 'public.is_non_evidence_host(text)', 'execute'),
  'anon cannot execute is_non_evidence_host');
select ok(not has_function_privilege('authenticated', 'public.is_non_evidence_host(text)', 'execute'),
  'authenticated cannot execute is_non_evidence_host');

-- ── service_role keeps it ────────────────────────────────────────────────────
select ok(has_function_privilege('service_role', 'public.claim_places_detail_quota(text, integer, integer, integer)', 'execute'),
  'service_role can execute claim_places_detail_quota');

-- ── the definer caller of is_non_evidence_host still works as owner ──────────
-- venue_link_hosts is SECURITY DEFINER and filters through is_non_evidence_host; if the revoke had
-- reached the owner path this would raise insufficient_privilege instead of returning a (empty) set.
select lives_ok(
  $$ select * from venue_link_hosts('00000000-0000-0000-0000-000000000000'::uuid) $$,
  'venue_link_hosts (definer) still evaluates is_non_evidence_host as owner');

select * from finish();
rollback;

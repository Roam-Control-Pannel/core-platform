-- ============================================================================
-- Roam — RLS / schema baseline pgTAP tests  (supabase/tests/00_rls_baseline_test.sql)
--
-- Run in CI by `supabase test db --local` after `supabase db reset` has applied
-- every migration + the dev seed. This file is the BASELINE harness: it asserts
-- only invariants that are already true on `main`, so it proves three things on
-- every PR without depending on any pending fix:
--   1. all migrations apply cleanly (db reset succeeded),
--   2. the dev seed loads,
--   3. the pgTAP runner itself works and is wired into CI.
--
-- Per-exploit regression tests (proving a specific hole is closed) live alongside
-- their fix — each security migration PR adds its own NN_*_test.sql here. Keep this
-- file to assertions that hold on the CURRENT schema; never weaken it to pass.
--
-- pgTAP reference: https://pgtap.org/documentation.html
-- ============================================================================
begin;
select plan(7);

-- (0) Harness smoke — proves the runner executes.
select ok(true, 'pgTAP harness runs');

-- (1) Core tables exist (proves migrations applied, not an empty DB).
select has_table('public', 'friendships', 'friendships table exists');
select has_table('public', 'plan_members', 'plan_members table exists');

-- (2) RLS is ENABLED on the principal user-data tables. These are all true today;
--     the assertions guard against a future migration accidentally disabling RLS.
--     (places_fetch_quota is intentionally NOT asserted here — it is RLS-off on
--      main and is fixed + asserted in the PR-1 security migration's own test.)
select ok(
  (select relrowsecurity from pg_class where oid = 'public.friendships'::regclass),
  'RLS enabled on friendships'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.plan_members'::regclass),
  'RLS enabled on plan_members'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.profiles'::regclass),
  'RLS enabled on profiles'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'public.venues'::regclass),
  'RLS enabled on venues'
);

select * from finish();
rollback;

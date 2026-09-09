-- ============================================================================
-- pgTAP regression tests for 0130_rls_security_hardening.sql
--
-- Proves the three closed holes stay closed. Structural assertions over pg_policies /
-- pg_class / pg_trigger / privileges — deterministic, and each fails loudly if a future
-- migration reopens the hole (e.g. drops the WITH CHECK, restores the self-insert
-- disjunct, or disables RLS on the quota table).
-- ============================================================================
begin;
select plan(9);

-- ── #1 friendships ───────────────────────────────────────────────────────────
select isnt(
  (select with_check from pg_policies
     where schemaname = 'public' and tablename = 'friendships' and policyname = 'friendships_update'),
  null,
  'friendships_update has a WITH CHECK (USING is no longer reused as the post-image check)'
);
select ok(
  (select with_check from pg_policies
     where tablename = 'friendships' and policyname = 'friendships_update') like '%addressee_id%',
  'friendships_update WITH CHECK restricts the post-image to the addressee'
);
select ok(
  (select with_check from pg_policies
     where tablename = 'friendships' and policyname = 'friendships_update') not like '%requester_id%',
  'friendships_update WITH CHECK does not admit the requester (no self-accept)'
);
select ok(
  exists (
    select 1 from pg_trigger
     where tgrelid = 'public.friendships'::regclass
       and tgname = 'friendships_pin_identity'
       and not tgisinternal
  ),
  'friendships identity-pin trigger is installed (pair cannot be repointed on UPDATE)'
);

-- ── #2 plan_members ──────────────────────────────────────────────────────────
select ok(
  (select with_check from pg_policies
     where tablename = 'plan_members' and policyname = 'plan_members_write') like '%owns_plan%',
  'plan_members_write requires plan ownership'
);
select ok(
  (select with_check from pg_policies
     where tablename = 'plan_members' and policyname = 'plan_members_write') not like '%auth.uid%',
  'plan_members_write no longer allows self-insert (auth.uid disjunct removed)'
);

-- ── #3 places_fetch_quota ────────────────────────────────────────────────────
select ok(
  (select relrowsecurity from pg_class where oid = 'public.places_fetch_quota'::regclass),
  'RLS is enabled on places_fetch_quota'
);
select ok(
  not has_table_privilege('anon', 'public.places_fetch_quota', 'INSERT'),
  'anon has no INSERT privilege on places_fetch_quota'
);
select ok(
  not has_table_privilege('authenticated', 'public.places_fetch_quota', 'UPDATE'),
  'authenticated has no UPDATE privilege on places_fetch_quota'
);

select * from finish();
rollback;

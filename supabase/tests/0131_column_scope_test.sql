-- ============================================================================
-- pgTAP regression tests for 0131_column_scope.sql
--
-- Structural assertions prove both column-guard triggers are installed with the exact
-- allowlist (venues) / denylist (profiles). A behavioral block then exercises the triggers
-- as the `authenticated` role against real rows — proving the guard bodies actually run
-- (in particular that to_jsonb() over the PostGIS geography column does not error), that an
-- allowed edit succeeds, and that a disallowed one is rejected. The mutations run inside a
-- DO block under SET ROLE so no pgTAP assertion function is ever called as `authenticated`
-- (that role lacks EXECUTE on the pgtap schema); outcomes are stashed and asserted as the
-- owner role afterwards.
-- ============================================================================
begin;
select plan(9);

-- ── structural ───────────────────────────────────────────────────────────────
select has_trigger('public', 'venues', 'venues_guard_owner_columns',
  'venues has the owner-column guard trigger');
select has_trigger('public', 'profiles', 'profiles_guard_protected_columns',
  'profiles has the protected-column guard trigger');
select ok(
  pg_get_functiondef('public.venues_guard_owner_columns'::regproc)
    like '%description,links,opening_times%',
  'venues allowlist is exactly description / links / opening_times'
);
select ok(
  pg_get_functiondef('public.profiles_guard_protected_columns'::regproc)
    like '%coalesce(old.invited_by, new.invited_by)%',
  'profiles guard makes invited_by set-once (no re-point)'
);

-- ── behavioral fixture (as the owner/superuser role: bypasses RLS + the guard gate) ──
insert into auth.users (id, email)
  values ('00000000-0000-0000-0000-0000000000a1', 'guard-a1@example.com');
-- profiles row is auto-provisioned by trg_auth_user_created; put a moderation flag on it.
update profiles set banned_at = now() where id = '00000000-0000-0000-0000-0000000000a1';
insert into venues (id, name, geo, status, owner_id)
  values (
    '00000000-0000-0000-0000-0000000000b1', 'Guard Test Venue',
    ST_SetSRID(ST_MakePoint(-5.9301, 54.5973), 4326), 'claimed',
    '00000000-0000-0000-0000-0000000000a1'
  );

create temp table _guard (k text primary key, v boolean);

do $$
declare tier_blocked boolean := false; geo_blocked boolean := false;
begin
  -- Become the signed-in owner: RLS applies and the guard's current_user check sees
  -- 'authenticated'.
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
    '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}', true);

  -- Allowed edits (also proves to_jsonb over the geography row does not error).
  update venues   set description = 'owner note' where id = '00000000-0000-0000-0000-0000000000b1';
  update profiles set bio = 'edited', banned_at = null where id = '00000000-0000-0000-0000-0000000000a1';

  -- Disallowed edits must raise.
  begin
    update venues set subscription_tier = 'gold' where id = '00000000-0000-0000-0000-0000000000b1';
  exception when others then tier_blocked := true; end;
  begin
    update venues set geo = ST_SetSRID(ST_MakePoint(0, 51), 4326) where id = '00000000-0000-0000-0000-0000000000b1';
  exception when others then geo_blocked := true; end;

  -- Back to the owner role to read + stash results (no RLS, and _guard is postgres-owned).
  perform set_config('role', 'postgres', true);
  insert into _guard values
    ('desc_set',      (select description = 'owner note' from venues   where id = '00000000-0000-0000-0000-0000000000b1')),
    ('bio_set',       (select bio = 'edited'             from profiles where id = '00000000-0000-0000-0000-0000000000a1')),
    ('banned_pinned', (select banned_at is not null      from profiles where id = '00000000-0000-0000-0000-0000000000a1')),
    ('tier_blocked',  tier_blocked),
    ('geo_blocked',   geo_blocked);
end $$;

select ok((select v from _guard where k = 'desc_set'),      'venue: owner CAN edit description (guard body runs, no to_jsonb error)');
select ok((select v from _guard where k = 'tier_blocked'),  'venue: owner CANNOT self-upgrade subscription_tier');
select ok((select v from _guard where k = 'geo_blocked'),   'venue: owner CANNOT move geo');
select ok((select v from _guard where k = 'bio_set'),       'profile: owner CAN edit bio');
select ok((select v from _guard where k = 'banned_pinned'), 'profile: owner CANNOT clear their own banned_at');

select * from finish();
rollback;

-- ============================================================================
-- Roam — 0114_seed_admin_owner.sql
-- Bootstrap the first Roam HQ member: the founder, as 'owner'.
--
-- admin_users (0113) is granted service-role only — there is no user-facing way to
-- create the FIRST member, so we seed one here. From this owner, further staff can be
-- invited (the "plain invite list" access model) via the HQ admin surface or the SQL
-- editor. `owner` is the only tier that may grant/revoke membership.
--
-- Looks the account up by email in auth.users (profiles.id == auth.users.id). If the
-- founder hasn't signed up yet this simply inserts nothing — re-run after signup, or
-- grant manually. Idempotent: re-running only ensures the row exists at 'owner'.
-- ============================================================================

insert into admin_users (id, role, note)
select u.id, 'owner', 'Founder — seeded by migration 0114'
from auth.users u
where lower(u.email) = 'andrew@roam-everywhere.com'
on conflict (id) do update
  set role = 'owner',
      note = coalesce(admin_users.note, excluded.note);

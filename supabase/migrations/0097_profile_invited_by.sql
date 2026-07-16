-- 0097_profile_invited_by.sql
--
-- Referral attribution for the friend-invite growth loop (#1). When a new user signs up via
-- someone's personal invite link (/i/<handle>), we record WHO brought them in. Mirrors the existing
-- orders.referrer_profile_id precedent (0071): attribution captured from day one, rewards logic
-- later. Set ONCE at signup by social.applyInvite (owner-only under the existing profiles_update
-- RLS); on delete of the inviter it's nulled, never cascading the invitee.
--
-- Additive only (one nullable column + an index); no signature/behaviour change, so no deploy skew.
-- Idempotent; safe to run once on the Roam-Core project.

alter table profiles
  add column if not exists invited_by uuid references profiles(id) on delete set null;

-- For "how many did this profile bring in" reward/analytics reads later.
create index if not exists idx_profiles_invited_by on profiles (invited_by);

comment on column profiles.invited_by is
  'The profile whose invite link brought this user in (referral attribution; set once at signup via '
  'social.applyInvite). Mirrors orders.referrer_profile_id — captured from day one, rewards later.';

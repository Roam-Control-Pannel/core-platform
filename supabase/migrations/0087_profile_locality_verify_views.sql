-- 0087_profile_locality_verify_views.sql
--
-- The remaining profile facts the redesigned /u/[id] header shows, given REAL backing (nothing
-- fabricated): the member's home town, a "verified local" flag, and a wall-view counter.
--
--   home_locality    — the town the member calls home ("Newcastle"), user-editable in the profile
--                      editor. Powers the locality chip + the "Lives in {town}" About line.
--   verified_local   — a trust flag set by an admin/verification step (default false, so the badge
--                      only ever shows when genuinely granted — never asserted by default).
--   wall_view_count  — a simple view tally, bumped by record_profile_view (SECURITY DEFINER, like
--                      record_venue_view / 0068). The client fires it once per profile per session
--                      (a module-level guard), so it counts real visits, not refreshes.

alter table profiles
  add column if not exists home_locality   text,
  add column if not exists verified_local  boolean not null default false,
  add column if not exists wall_view_count integer not null default 0;

comment on column profiles.home_locality is 'The member''s home town (user-set) — the profile locality chip + "Lives in" line.';
comment on column profiles.verified_local is 'Admin/verification-granted "verified local" badge. Default false — never asserted by default.';
comment on column profiles.wall_view_count is 'Profile (wall) view tally, bumped by record_profile_view; shown as the "Wall views" stat.';

-- Bump a profile's view tally. SECURITY DEFINER so an anonymous viewer can count a view without a
-- write grant on profiles (the owner-only profiles_update policy stays intact). No viewer identity
-- is stored — same privacy posture as record_venue_view.
create or replace function record_profile_view(p_profile uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles set wall_view_count = wall_view_count + 1 where id = p_profile;
end;
$$;

revoke all on function record_profile_view(uuid) from public;
grant execute on function record_profile_view(uuid) to anon, authenticated, service_role;

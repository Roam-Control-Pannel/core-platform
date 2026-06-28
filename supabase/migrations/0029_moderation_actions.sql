-- ============================================================================
-- Roam — 0029_moderation_actions.sql
-- The moderation backstop for self-serve claiming (0028): users REPORT, staff ACT.
--
-- Reports already have a home: moderation_queue (0003) + the user_report insert policy
-- (0004). This migration adds the ACTIONS staff take on a report, plus the visibility +
-- ban plumbing that makes "disable / ban" actually mean something:
--
--   1. SUSPEND hides a venue from public discovery. venues_read becomes
--      `status <> 'suspended' OR owner_id = auth.uid()` — the public (and browse RPCs,
--      which are SECURITY INVOKER) stop seeing a suspended venue, while its owner still
--      sees it (so they know it's down). venue_status already had 'suspended' (0001).
--   2. REVOKE undoes a wrongful self-serve claim: ownership cleared, venue back to
--      unclaimed (re-claimable by the right owner), the claim marked rejected.
--   3. BAN flags a profile (profiles.banned_at) and suspends their claimed venues; a
--      banned user can't claim (request_venue_claim refuses them).
--
-- All three actions are SECURITY DEFINER + service_role-only (revoked from public), reached
-- via the api's internal moderation procedures or the SQL editor — never a user JWT.
--
-- Re-appliable: add-column `if not exists`; policy + functions drop/replace.
-- ============================================================================

-- 1. Ban flag on profiles.
alter table profiles add column if not exists banned_at timestamptz;
comment on column profiles.banned_at is
  'Set when a profile is banned by moderation; null = active. Banned users cannot claim '
  'venues; their claimed venues are suspended. Broader write-enforcement extends from here.';

-- 2. Suspended venues are hidden from public discovery (owner still sees their own).
drop policy if exists venues_read on venues;
create policy venues_read on venues for select
  using (status <> 'suspended' or owner_id = auth.uid());

-- 3a. Revoke a (wrongful) claim — ownership cleared, venue re-claimable, claims rejected.
create or replace function moderate_revoke_claim(p_venue_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update venues
    set owner_id = null, status = 'unclaimed'
    where id = p_venue_id;

  update venue_claims
    set status = 'rejected', reviewed_at = now()
    where venue_id = p_venue_id and status = 'approved';
end;
$$;

-- 3b. Suspend / un-suspend a venue (hide from discovery, or restore).
create or replace function moderate_set_venue_suspended(p_venue_id uuid, p_suspended boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_suspended then
    update venues set status = 'suspended' where id = p_venue_id;
  else
    -- Restore to the natural state: claimed if it still has an owner, else unclaimed.
    update venues
      set status = case when owner_id is not null then 'claimed' else 'unclaimed' end
      where id = p_venue_id and status = 'suspended';
  end if;
end;
$$;

-- 3c. Ban / un-ban a profile. Banning also suspends their claimed venues; un-banning
--     restores those it suspended.
create or replace function moderate_ban_profile(p_user_id uuid, p_banned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update profiles
    set banned_at = case when p_banned then now() else null end
    where id = p_user_id;

  if p_banned then
    update venues set status = 'suspended'
      where owner_id = p_user_id and status = 'claimed';
  else
    update venues set status = 'claimed'
      where owner_id = p_user_id and status = 'suspended';
  end if;
end;
$$;

comment on function moderate_revoke_claim(uuid) is 'Moderation: clear ownership + reject claims, venue back to unclaimed. service_role only.';
comment on function moderate_set_venue_suspended(uuid, boolean) is 'Moderation: hide/restore a venue from public discovery. service_role only.';
comment on function moderate_ban_profile(uuid, boolean) is 'Moderation: ban/un-ban a profile + suspend/restore their venues. service_role only.';

revoke all on function moderate_revoke_claim(uuid) from public;
revoke all on function moderate_set_venue_suspended(uuid, boolean) from public;
revoke all on function moderate_ban_profile(uuid, boolean) from public;
grant execute on function moderate_revoke_claim(uuid) to service_role;
grant execute on function moderate_set_venue_suspended(uuid, boolean) to service_role;
grant execute on function moderate_ban_profile(uuid, boolean) to service_role;

-- 4. A banned user cannot claim. Redefine request_venue_claim (from 0028) with the guard.
create or replace function request_venue_claim(
  target_venue_id uuid,
  claim_note      text default null
)
returns venue_claims
language plpgsql
security definer
set search_path = public
as $$
declare
  caller         uuid := auth.uid();
  v_status       venue_status;
  claimant_email text;
  email_host     text;
  matched        boolean := false;
  claim          venue_claims;
begin
  if caller is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  -- Banned users cannot claim.
  if exists (select 1 from profiles where id = caller and banned_at is not null) then
    raise exception 'USER_BANNED' using errcode = '42501';
  end if;

  select status into v_status from venues where id = target_venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status <> 'unclaimed' then
    raise exception 'VENUE_NOT_CLAIMABLE' using errcode = '22023';
  end if;

  select email into claimant_email from auth.users where id = caller;
  if claimant_email is not null and position('@' in claimant_email) > 0 then
    email_host := lower(split_part(claimant_email, '@', 2));
  end if;
  if email_host is not null
     and not is_free_mail_host(email_host)
     and exists (select 1 from venue_link_hosts(target_venue_id) h where h = email_host)
  then
    matched := true;
  end if;

  insert into venue_claims (venue_id, claimant_id, note, status, verified_domain, reviewed_at)
  values (target_venue_id, caller, claim_note, 'approved', matched, now())
  returning * into claim;

  update venues set status = 'claimed', owner_id = caller where id = target_venue_id;

  return claim;
end;
$$;

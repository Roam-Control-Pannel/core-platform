-- 0139_claim_channel_member_venue.sql
--
-- Food to Go · Phase B · Slice B3-d — the INVITE→CLAIM conferral (the ownership-grant path).
--
-- This is the other half of the roster funnel: import (B3-a) and match (B3-b) filled
-- channel_members.venue_id with the Roam venue a member maps to; a signed invite link (the Node
-- HMAC token in packages/api/src/f2g/inviteToken.ts) is emailed to the member's source_email; and
-- accepting that link — as a signed-in user — is what CONFERS OWNERSHIP of the matched venue.
--
-- Ownership conferral is the single most dangerous write in the platform (it sets venues.owner_id).
-- So this function is modelled LINE-FOR-LINE on approve_venue_claim (0007), the proven claim-approval
-- path, and carries the same disciplines:
--   * SECURITY DEFINER, search_path locked, non-recursive (never queries its own policy);
--   * FIXED LOCK ORDER — channel_members then venues (for update) — so a concurrent accept can't race
--     the status flip or double-confer;
--   * the owner_id write happens HERE AND ONLY HERE;
--   * typed SQLSTATE raises for each guard, so the API maps them to clean user-facing outcomes;
--   * EXECUTE revoked from anon/authenticated — only the service role (which the API escalates to,
--     AFTER verifying the token AND that the claimant is signed in) may call it. Ownership can never
--     be self-conferred by a direct PostgREST call.
--
-- SINGLE-USE is enforced by STATE, not by a token table: a member is claimable only while its status
-- is imported/invited. A second accept finds status='claimed' and is a NO-OP if the same claimant
-- re-clicks their link (idempotent), or a hard refusal if a different user presents it.
--
-- ACCEPT SIDE-EFFECT (decision #3, docs/f2g-b3-onboarding-plan.md §5.1): conferral also tags the venue
-- into venue_channels, so a later open→members mode flip needs no backfill (harmless in open mode).
--
-- Additive; idempotent. After applying, run `notify pgrst, 'reload schema'` (see the release runbook).

-- Typed single-row result so the API gets the outcome without parsing error strings on the happy path.
create type channel_member_claim_result as (
  member_id     uuid,
  venue_id      uuid,
  claimed       boolean,      -- true iff THIS call conferred ownership
  venue_status  venue_status,
  outcome       text          -- 'claimed' | 'already_claimed'
);

-- ============================================================================
-- claim_channel_member_venue — the service-role invite→claim conferral.
--
-- Inputs: the roster member id, the venue the token is bound to, and the claimant (the signed-in
-- user, resolved by the API from the JWT — NEVER from the token, so a token can't name its own owner).
--
-- Behaviour:
--   * Loads + locks the member, then (fixed order) the venue.
--   * VENUE_MISMATCH  — the member isn't matched to p_venue_id (a token can't be re-pointed at another
--                       venue): raise.
--   * NOT_CLAIMABLE   — the member's status is not imported/invited AND it isn't an idempotent re-claim
--                       by the same user: raise. (lapsed/removed are never claimable here.)
--   * already_claimed — status='claimed' by THIS claimant already: no-op success (idempotent re-click).
--   * CLAIMED_BY_OTHER— the venue is already owned by a different user: raise (never steal a claim).
--   * Otherwise CONFER: venues -> claimed + owner_id=claimant; member -> claimed + claimed_by/at;
--     tag venue_channels. Returns claimed=true, outcome='claimed'.
-- ============================================================================
create or replace function claim_channel_member_venue(
  p_member_id   uuid,
  p_venue_id    uuid,
  p_claimant_id uuid
)
returns channel_member_claim_result
language plpgsql
security definer
set search_path = public
as $$
declare
  m         channel_members;
  v_status  venue_status;
  v_owner   uuid;
  result    channel_member_claim_result;
begin
  if p_claimant_id is null then
    raise exception 'CLAIMANT_REQUIRED' using errcode = 'P0001';
  end if;

  -- Lock the member row first (same lock order everywhere: member then venue).
  select * into m from channel_members where id = p_member_id for update;
  if not found then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The token binds a specific (member, venue) pair. Refuse if the member is not matched to exactly
  -- that venue — this is what stops a captured token being re-pointed at a different venue.
  if m.venue_id is null or m.venue_id <> p_venue_id then
    raise exception 'VENUE_MISMATCH' using errcode = 'P0001';
  end if;

  -- Lock the venue row too.
  select status, owner_id into v_status, v_owner from venues where id = p_venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Single-use via STATE. Only an imported/invited member is claimable.
  if m.status not in ('imported', 'invited') then
    -- Idempotent re-click by the same claimant who already claimed it: a no-op success, not an error.
    if m.status = 'claimed' and m.claimed_by is not distinct from p_claimant_id then
      result := (m.id, p_venue_id, false, v_status, 'already_claimed');
      return result;
    end if;
    -- Anything else (claimed by someone else, live, lapsed, removed) is not claimable via this link.
    raise exception 'NOT_CLAIMABLE' using errcode = 'P0001';
  end if;

  -- Never steal an existing claim: if the venue is already owned by a DIFFERENT user, refuse. (An
  -- unclaimed venue has owner_id NULL; a re-run where owner is already the claimant falls through.)
  if v_owner is not null and v_owner <> p_claimant_id then
    raise exception 'CLAIMED_BY_OTHER' using errcode = 'P0001';
  end if;

  -- ── Confer ownership — the dangerous write, done here and ONLY here. ────────────────────────────
  update venues
    set status = 'claimed', owner_id = p_claimant_id
    where id = p_venue_id;

  update channel_members
    set status = 'claimed', claimed_by = p_claimant_id, claimed_at = now()
    where id = m.id;

  -- Accept side-effect: tag the venue into its channel (members-mode readiness; harmless in open
  -- mode). added_by is the claimant. Idempotent on the (channel_id, venue_id) primary key.
  insert into venue_channels (channel_id, venue_id, added_by)
    values (m.channel_id, p_venue_id, p_claimant_id)
    on conflict (channel_id, venue_id) do nothing;

  result := (m.id, p_venue_id, true, 'claimed'::venue_status, 'claimed');
  return result;
end;
$$;

comment on function claim_channel_member_venue(uuid, uuid, uuid) is
  'Service-role invite→claim conferral for a channel_members roster member. Confers ownership of the matched venue (venues -> claimed, owner_id=claimant; member -> claimed) and tags venue_channels, ONLY when the member is matched to p_venue_id, is imported/invited, and the venue is not owned by another user. Idempotent no-op on a same-claimant re-click. Mirrors approve_venue_claim: SECURITY DEFINER, lock member then venue, owner_id written here and only here, typed SQLSTATE raises. NOT granted to anon/authenticated — the API calls it with the service client after verifying the invite token and the signed-in claimant.';

-- Ownership can never be self-conferred from a client. Revoke the default PUBLIC execute and grant it
-- back to service_role ALONE (the API escalates to it only after verifying the token + the signed-in
-- claimant). anon/authenticated cannot execute this — the enforcement that keeps the owner_id write
-- off every user-reachable PostgREST path.
revoke all on function claim_channel_member_venue(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function claim_channel_member_venue(uuid, uuid, uuid) to service_role;

-- ============================================================================
-- Roam — 0028_self_serve_claims.sql
-- Make venue claiming SELF-SERVE: claiming a venue grants ownership immediately, instead of
-- parking it in `pending_claim` for manual review. Trust-on-claim, moderate-after — the
-- product decision is "allow access until reported, then suspend/ban".
--
-- WHAT CHANGES:
--   - request_venue_claim now CONFERS OWNERSHIP in the same call: it sets the venue to
--     `claimed` + owner_id = caller and records the claim as `approved` — no review queue.
--   - We STILL compute whether the claimant's email domain matches the venue's website
--     (the old auto-verify evidence) and store it on the claim as `verified_domain`. This is
--     a TRUST SIGNAL, not a gate: it lets moderation later prioritise the weakly-evidenced
--     claims (self-asserted, no domain match) if one is reported.
--
-- WHAT STAYS (the moderation backstop, already present, now the safety net):
--   - venue_status still has `suspended`; approve_venue_claim / reject_venue_claim and the
--     claim denylist (0008) remain for staff/automated moderation. A future moderation
--     surface can revoke ownership (clear owner_id, set suspended) and ban a profile.
--   - The `for update` lock + the `unclaimed`-only guard still prevent two people racing to
--     claim the same venue: the first wins, the venue is no longer `unclaimed`, the rest get
--     VENUE_NOT_CLAIMABLE.
--
-- Re-appliable: add-column is `if not exists`; the function is create-or-replace.
-- ============================================================================

-- 1. Trust signal: did the claimant's email domain match the venue's website at claim time?
alter table venue_claims
  add column if not exists verified_domain boolean not null default false;

comment on column venue_claims.verified_domain is
  'True when the claimant''s (non-free) email host matched a host in the venue''s links at '
  'claim time. NOT a gate (claims are self-serve) — a moderation trust signal for triage.';

-- 2. request_venue_claim: grant ownership immediately (self-serve).
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

  -- Lock the venue row so a concurrent claim can't race the status check.
  select status into v_status from venues where id = target_venue_id for update;

  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Only an unclaimed venue can be claimed. Already claimed/pending/suspended ⇒ not claimable.
  if v_status <> 'unclaimed' then
    raise exception 'VENUE_NOT_CLAIMABLE' using errcode = '22023';
  end if;

  -- Compute the domain-match trust signal (same evidence the old auto-approve used), but it
  -- no longer gates the grant — it's recorded for moderation triage.
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

  -- Record the claim as already approved (self-serve), with the trust signal + audit time.
  insert into venue_claims (venue_id, claimant_id, note, status, verified_domain, reviewed_at)
  values (target_venue_id, caller, claim_note, 'approved', matched, now())
  returning * into claim;

  -- Confer ownership immediately.
  update venues
    set status = 'claimed', owner_id = caller
    where id = target_venue_id;

  return claim;
end;
$$;

comment on function request_venue_claim(uuid, text) is
  'Self-serve claim: confers ownership immediately (venue → claimed, owner_id = caller) and '
  'records an approved venue_claims row with a verified_domain trust signal. Only an '
  'unclaimed venue is claimable (row-locked). SECURITY DEFINER; reached via the api '
  'requestClaim procedure. Moderation (approve/reject/denylist/suspend) remains the backstop.';

-- 3. One-time: clear the existing review queue under the new self-serve rule. Every venue
--    currently parked in `pending_claim` is granted to the EARLIEST pending claimant (the
--    same first-come rule the live path now uses). Any other pending claims for that venue
--    are moot (the venue is no longer claimable) and left for a moderation pass.
with first_pending as (
  select distinct on (venue_id) id, venue_id, claimant_id
  from venue_claims
  where status = 'pending'
  order by venue_id, created_at asc
)
update venues v
  set status = 'claimed', owner_id = fp.claimant_id
  from first_pending fp
  where v.id = fp.venue_id and v.status = 'pending_claim';

with first_pending as (
  select distinct on (venue_id) id, venue_id
  from venue_claims
  where status = 'pending'
  order by venue_id, created_at asc
)
update venue_claims c
  set status = 'approved', reviewed_at = now()
  from first_pending fp
  where c.id = fp.id;

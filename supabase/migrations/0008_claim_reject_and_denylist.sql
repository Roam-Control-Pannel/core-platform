-- ============================================================================
-- Roam — 0008_claim_reject_and_denylist.sql
-- The remaining tail of claim-as-request, in one clean re-definition:
--   (1) ONE canonical "this host is not ownership evidence" deny-list, covering
--       BOTH free-mail (gmail/outlook/…) AND shared aggregators (opentable/
--       instagram/deliveroo/linktr.ee/…). One list, used on both sides of the match.
--   (2) venue_link_hosts re-defined to FILTER its output through that deny-list, so
--       the evidence set is clean AT SOURCE — an aggregator a venue merely links to
--       never enters the candidate host set.
--   (3) approve_venue_claim re-defined to test the claimant's EMAIL host through the
--       SAME deny-list (replacing the old is_free_mail_host call), so there is exactly
--       one place to maintain the exclusion. Behaviour is otherwise unchanged.
--   (4) reject_venue_claim — the path that finally reaches the `rejected` enum value
--       declared back in 0006 and reached by nothing until now.
--
-- WHY THIS IS A CLEAN RE-DEFINITION, NOT A REWRITE:
-- Every function below is `create or replace`; the deny-list predicate is additive;
-- reject_venue_claim is new. No table changes, no data migration. 0007's contract
-- (the venue_claim_approval composite, the SECURITY DEFINER + locked search_path +
-- non-recursive discipline, the grant posture) is preserved verbatim where it carries
-- over. is_free_mail_host is KEPT (not dropped) for back-compat; it is simply no longer
-- the thing approve_venue_claim calls — the superset predicate is.
--
-- SAFETY (same discipline as 0006/0007): definer functions are non-recursive (they read
-- venues/venue_claims/auth.users and write venues/venue_claims; none queries its own
-- policy), search_path is locked, and the privileged functions are NOT granted to
-- anon/authenticated — only the service role (which bypasses grants) can execute them.
-- ============================================================================

-- ============================================================================
-- (1) The canonical non-evidence host deny-list.
--
-- A host on this list can NEVER serve as proof that a claimant controls a venue's
-- domain — whether it appears as the claimant's email host OR as a host the venue
-- links to. Two distinct reasons, one list:
--   * free-mail (gmail.com, …): a consumer mailbox proves nothing about a business.
--   * aggregators / platforms (opentable.com, instagram.com, …): a venue linking to
--     its OpenTable page is normal; controlling @opentable.com is not evidence the
--     claimant is THAT venue. Shared-platform hosts are owned by the platform, not
--     the venue, so a match against one is a false positive.
-- ============================================================================
create or replace function is_non_evidence_host(host text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select lower(host) in (
    -- --- free-mail / consumer mailboxes (superset of is_free_mail_host) -------
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
    'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
    'yandex.com', 'zoho.com', 'fastmail.com', 'pm.me',
    -- --- booking / ordering / reservation aggregators ------------------------
    'opentable.com', 'opentable.co.uk', 'thefork.com', 'thefork.co.uk',
    'resy.com', 'sevenrooms.com', 'quandoo.com', 'quandoo.co.uk',
    'bookatable.com', 'designmynight.com',
    'deliveroo.com', 'deliveroo.co.uk', 'just-eat.com', 'just-eat.co.uk',
    'justeat.com', 'justeat.co.uk', 'ubereats.com', 'doordash.com',
    'grubhub.com', 'order.online', 'slerp.com', 'toasttab.com',
    -- --- review / directory platforms ----------------------------------------
    'tripadvisor.com', 'tripadvisor.co.uk', 'yelp.com', 'yelp.co.uk',
    'google.com', 'goo.gl', 'maps.app.goo.gl', 'g.page',
    'foursquare.com', 'trustpilot.com',
    -- --- social platforms ----------------------------------------------------
    'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'instagr.am',
    'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'youtu.be',
    'linkedin.com', 'pinterest.com', 'snapchat.com', 'threads.net',
    -- --- link-in-bio / generic hosting / shorteners --------------------------
    'linktr.ee', 'linkin.bio', 'beacons.ai', 'carrd.co', 'bio.link',
    'bit.ly', 'tinyurl.com', 't.co', 'ow.ly', 'rebrand.ly',
    'wixsite.com', 'square.site', 'godaddysites.com', 'business.site',
    'wordpress.com', 'blogspot.com', 'weebly.com', 'webflow.io',
    'eventbrite.com', 'eventbrite.co.uk', 'whatsapp.com', 'wa.me'
  );
$$;

comment on function is_non_evidence_host(text) is
  'Canonical deny-list: a host that can NEVER prove venue ownership — free-mail (a consumer mailbox proves nothing) OR a shared aggregator/platform/social/link-in-bio host (owned by the platform, not the venue, so a match is a false positive). Used on BOTH the claimant-email side and the venue-link side so there is one list to maintain. Superset of is_free_mail_host (which is kept for back-compat but no longer the predicate approve_venue_claim calls).';

-- ============================================================================
-- (2) venue_link_hosts — re-defined to filter the evidence set at source.
--
-- Identical host-extraction to 0007 (scheme://host, www-stripped, lowercased,
-- de-duplicated) but now DROPS any host on the deny-list, so aggregator/social/
-- free-mail link hosts never enter the candidate evidence set. A venue whose only
-- links are its Instagram + Deliveroo pages therefore yields NO evidence hosts —
-- which correctly routes its claims to manual review instead of false auto-approval.
-- ============================================================================
create or replace function venue_link_hosts(target_venue_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select host from (
    select distinct lower(
      regexp_replace(
        regexp_replace(value, '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+).*$', '\1'),
        '^www\.', ''
      )
    ) as host
    from venues v,
         lateral jsonb_each_text(coalesce(v.links, '{}'::jsonb)) as l(key, value)
    where v.id = target_venue_id
      and value ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+'
  ) hosts
  where not is_non_evidence_host(host);
$$;

comment on function venue_link_hosts(uuid) is
  'Registrable hosts (www-stripped, lowercased) parsed from a venue''s links jsonb, with non-evidence hosts (free-mail + aggregators/social/link-in-bio, per is_non_evidence_host) filtered OUT at source. The clean evidence set the email-domain auto-match checks a claimant''s email host against. Empty when the venue advertises no own-domain link URLs.';

-- ============================================================================
-- (3) approve_venue_claim — re-defined to use the canonical deny-list on the
-- EMAIL side too. Behaviour is otherwise byte-for-byte the 0007 contract:
-- same venue_claim_approval return, same lock order (claim then venue), same
-- idempotency guard, same "never auto-reject" stance, same grant posture.
--
-- The ONLY change vs 0007: the email-host guard calls is_non_evidence_host(...)
-- instead of is_free_mail_host(...). Because venue_link_hosts now already excludes
-- non-evidence hosts, the link-side EXISTS check is inherently clean; the email-side
-- guard still matters (a claimant emailing from @opentable.com or @gmail.com must not
-- match even if — defensively — such a host ever survived into the evidence set).
-- ============================================================================
create or replace function approve_venue_claim(target_claim_id uuid)
returns venue_claim_approval
language plpgsql
security definer
set search_path = public
as $$
declare
  c            venue_claims;
  v_status     venue_status;
  v_owner      uuid;
  claimant_email text;
  email_host   text;
  matched      boolean := false;
  result       venue_claim_approval;
begin
  -- Lock the claim row.
  select * into c from venue_claims where id = target_claim_id for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Lock the venue row too (same lock order everywhere: claim then venue).
  select status, owner_id into v_status, v_owner
    from venues where id = c.venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotency / guard: only act on a pending claim against a pending_claim venue.
  if c.status <> 'pending' or v_status <> 'pending_claim' then
    result := (c.id, c.venue_id, false, v_status, 'not_actionable');
    return result;
  end if;

  -- Resolve the claimant's email host from auth.users.
  select email into claimant_email from auth.users where id = c.claimant_id;
  if claimant_email is not null and position('@' in claimant_email) > 0 then
    email_host := lower(split_part(claimant_email, '@', 2));
  end if;

  -- Auto-match: real business-domain evidence only. The email host must not be a
  -- non-evidence host, and must appear in the (already deny-list-filtered) link set.
  if email_host is not null
     and not is_non_evidence_host(email_host)
     and exists (select 1 from venue_link_hosts(c.venue_id) h where h = email_host)
  then
    matched := true;
  end if;

  if matched then
    -- Confer ownership — the dangerous write, done here and ONLY here.
    update venues
      set status = 'claimed', owner_id = c.claimant_id
      where id = c.venue_id;

    update venue_claims
      set status = 'approved', reviewed_at = now()
      where id = c.id;

    result := (c.id, c.venue_id, true, 'claimed'::venue_status, 'email_domain');
    return result;
  end if;

  -- No auto-evidence: leave pending for the review queue. Not a rejection.
  result := (c.id, c.venue_id, false, 'pending_claim'::venue_status, 'manual_review_required');
  return result;
end;
$$;

comment on function approve_venue_claim(uuid) is
  'Service-role claim approval. Auto-approves (venue -> claimed, owner_id set; claim -> approved) ONLY when the claimant''s business email host matches a host in the venue''s deny-list-filtered links. Otherwise leaves the claim pending for human review — never auto-rejects. Uses is_non_evidence_host on both the email side and (transitively, via venue_link_hosts) the link side: one deny-list. SECURITY DEFINER, non-recursive, search_path locked. NOT granted to authenticated/anon.';

-- ============================================================================
-- (4) reject_venue_claim — the path to the `rejected` enum value.
--
-- Transitions a pending claim -> rejected, and returns its venue to 'unclaimed'
-- IFF that venue is currently 'pending_claim' AND no OTHER pending claim remains
-- on it. It NEVER un-owns a claimed venue (a venue that has already been approved /
-- has an owner is left exactly as-is; only the stray pending claim is closed).
--
-- Idempotent: rejecting an already-rejected/approved claim is a no-op that returns
-- the claim's current venue status, not an error — so a sweep or a double-click
-- can't corrupt state.
--
-- Records the reason (free text) and reviewed_at. reviewed_by stays NULL for a
-- system/sweep action; a staff console can later pass an explicit reviewer.
--
-- Returns the SAME venue_claim_approval composite as approve_venue_claim, so both
-- review outcomes share one typed shape. `verified` is always false for a rejection
-- (nothing was verified); `method` carries the outcome ('rejected' | 'not_actionable').
--
-- Service-role ONLY (no grant to anon/authenticated): closing a claim and returning
-- a venue to the pool is a privileged review action, never user-reachable.
-- ============================================================================
create or replace function reject_venue_claim(
  target_claim_id uuid,
  reason          text default null
)
returns venue_claim_approval
language plpgsql
security definer
set search_path = public
as $$
declare
  c             venue_claims;
  v_status      venue_status;
  v_owner       uuid;
  other_pending boolean;
  result        venue_claim_approval;
begin
  -- Lock the claim row.
  select * into c from venue_claims where id = target_claim_id for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Lock the venue row (same lock order as approve: claim then venue).
  select status, owner_id into v_status, v_owner
    from venues where id = c.venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotency / guard: only a pending claim can be rejected. Anything else is a
  -- no-op returning current venue status (re-reject, or reject-after-approve).
  if c.status <> 'pending' then
    result := (c.id, c.venue_id, false, v_status, 'not_actionable');
    return result;
  end if;

  -- Close this claim.
  update venue_claims
    set status = 'rejected', reviewed_at = now(), note = coalesce(reason, note)
    where id = c.id;

  -- Return the venue to the pool ONLY if it was waiting on a claim (pending_claim)
  -- and no OTHER pending claim remains. NEVER touch a claimed/suspended venue, and
  -- NEVER clear owner_id (a rejection of a stray claim must not un-own anything).
  if v_status = 'pending_claim' then
    select exists (
      select 1 from venue_claims oc
      where oc.venue_id = c.venue_id
        and oc.id <> c.id
        and oc.status = 'pending'
    ) into other_pending;

    if not other_pending then
      update venues set status = 'unclaimed' where id = c.venue_id;
      result := (c.id, c.venue_id, false, 'unclaimed'::venue_status, 'rejected');
      return result;
    end if;
  end if;

  -- Venue left as-is (still pending_claim with another live claim, or already
  -- claimed/suspended): only this claim was closed.
  result := (c.id, c.venue_id, false, v_status, 'rejected');
  return result;
end;
$$;

comment on function reject_venue_claim(uuid, text) is
  'Service-role claim rejection. Transitions a pending claim -> rejected; returns its venue to unclaimed IFF the venue was pending_claim and no other pending claim remains. NEVER un-owns a claimed venue; never clears owner_id. Idempotent (non-pending claim = no-op). Returns the venue_claim_approval composite shared with approve_venue_claim (verified always false; method = rejected|not_actionable). SECURITY DEFINER, non-recursive, search_path locked. NOT granted to authenticated/anon.';

-- Grant posture: privileged review functions stay service-role only. The service
-- role bypasses grants; revoking from public keeps them off every user path.
revoke all on function is_non_evidence_host(text) from public;
revoke all on function reject_venue_claim(uuid, text) from public;
revoke all on function venue_link_hosts(uuid) from public;
revoke all on function approve_venue_claim(uuid) from public;

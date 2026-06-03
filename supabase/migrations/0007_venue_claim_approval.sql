-- ============================================================================
-- Roam — 0007_venue_claim_approval.sql
-- The OTHER HALF of claim-as-request: the pending_claim -> claimed transition
-- that confers ownership. The dangerous write 0006 deliberately refused to do.
--
-- THE DESIGN (why this shape):
-- 0006 established the rule: a user can only REQUEST a claim (unclaimed ->
-- pending_claim, owner_id stays NULL). Conferring ownership (-> claimed,
-- owner_id set) is "SERVICE-ROLE ONLY ... to enforce verification" (0004 + 0006).
-- This migration builds that service-role path and nothing else.
--
-- The verification MECHANISM, decided this session: EMAIL-DOMAIN AUTO-MATCH.
-- If the claimant's email host matches a host found in the venue's own `links`
-- (the Order/Book/Menu/website URLs the venue already advertises), that is real,
-- checkable evidence the claimant controls the business's domain — so we approve
-- automatically. Anything else (free-mail address, no links, host mismatch) is
-- NOT auto-rejected: it stays `pending` for the human review queue (a real seam,
-- not a stub — 0006's audit table was built for exactly this). A non-match means
-- "couldn't auto-verify", never "fraudulent".
--
-- Why a definer function, not a bare service-role UPDATE in the API:
--   * Conferring ownership is two coupled writes (venues + venue_claims) that must
--     be atomic and must verify the domain in the SAME transaction that flips the
--     status — otherwise a TOCTOU race could approve against stale link data.
--   * Centralising the rule here (not in TS) means every caller of approval runs
--     IDENTICAL logic — the one-core principle applied at the DB layer. Approval is
--     SERVER-SIDE ONLY (a manual/curl call today, a cron/Edge sweep later); the
--     browser never calls it. The TS side only decides WHEN to call; the DB owns
--     WHAT approval means.
--
-- Safe SECURITY DEFINER (same discipline as 0006): non-recursive (reads venues,
-- venue_claims, auth.users; writes venues, venue_claims — never queries its own
-- policy), search_path locked. NOT granted to `authenticated` or `anon` — only the
-- service role (which bypasses grants) can execute it. A signed-in user calling it
-- directly is refused at the grant layer, so ownership can never be self-conferred.
-- ============================================================================

-- --- Helper: extract the registrable host set from a venue's `links` jsonb ---
-- `links` is a jsonb object of { label: url }. We pull each string value, parse
-- its host, and strip a leading 'www.'. Pure, STABLE, no I/O. Returns a set of
-- lowercased hosts (e.g. {'theorangery.co.uk'}). An empty/melformed links object
-- yields no rows, which correctly means "nothing to match against".
create or replace function venue_link_hosts(target_venue_id uuid)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select distinct lower(
    regexp_replace(
      -- host = the part after scheme:// up to the next / ? # or end
      regexp_replace(value, '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+).*$', '\1'),
      '^www\.', ''
    )
  )
  from venues v,
       lateral jsonb_each_text(coalesce(v.links, '{}'::jsonb)) as l(key, value)
  where v.id = target_venue_id
    -- only values that actually look like a URL with a host
    and value ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+';
$$;

comment on function venue_link_hosts(uuid) is
  'Registrable hosts (www-stripped, lowercased) parsed from a venue''s links jsonb. The evidence set the email-domain auto-match checks a claimant''s email host against. Empty when the venue advertises no link URLs.';

-- --- Free-mail hosts that are NEVER acceptable as domain evidence ------------
-- A gmail.com claimant matching a (hypothetical) gmail.com link would be a false
-- positive — consumer mail proves nothing about owning a business. We exclude the
-- common providers so only a genuine business-domain match can auto-approve.
create or replace function is_free_mail_host(host text)
returns boolean
language sql
immutable
set search_path = public
as $$
  select lower(host) in (
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
    'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
    'yandex.com', 'zoho.com', 'fastmail.com', 'pm.me'
  );
$$;

comment on function is_free_mail_host(text) is
  'True for common consumer/free-mail hosts. Such a host can never serve as domain-ownership evidence in the claim auto-match — only a business domain match auto-approves.';

-- ============================================================================
-- approve_venue_claim — the service-role approval path.
--
-- Input: a venue_claims.id. Behaviour:
--   * Loads the claim and its venue, locking both rows (FOR UPDATE) so a
--     concurrent request/approval can't race the status flip.
--   * If the claim is not `pending`, or the venue is not `pending_claim`, returns
--     the claim unchanged with verified=false (idempotent: re-approving an
--     already-approved claim is a no-op, not an error).
--   * Resolves the claimant's email (auth.users.email) and its host.
--   * AUTO-APPROVE iff: host is non-null, NOT a free-mail host, and is in the
--     venue's link-host set. Then, atomically:
--         venues.status -> 'claimed', venues.owner_id -> claimant
--         venue_claims.status -> 'approved', reviewed_at -> now()
--                         reviewed_by left NULL (system action, not a staff member)
--     Returns the updated claim with verified=true, method='email_domain'.
--   * Otherwise leaves everything `pending` and returns verified=false,
--     method='manual_review_required'. NEVER auto-rejects.
--
-- Returns a single-row result so the API gets the outcome typed.
-- ============================================================================
create type venue_claim_approval as (
  claim_id   uuid,
  venue_id   uuid,
  verified   boolean,
  venue_status venue_status,
  method     text     -- 'email_domain' | 'manual_review_required' | 'not_actionable'
);

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

  -- Auto-match: real business-domain evidence only.
  if email_host is not null
     and not is_free_mail_host(email_host)
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
  'Service-role claim approval. Auto-approves (venue -> claimed, owner_id set; claim -> approved) ONLY when the claimant''s business email host matches a host in the venue''s links. Otherwise leaves the claim pending for human review — never auto-rejects. SECURITY DEFINER, non-recursive, search_path locked. NOT granted to authenticated/anon: only the service role may execute it, so ownership can never be self-conferred.';

-- NO grant to anon/authenticated. The service role bypasses grants; ordinary
-- users and the anon role cannot call this. This is the enforcement that keeps
-- the owner_id write off every user-reachable path.
revoke all on function approve_venue_claim(uuid) from public;
revoke all on function venue_link_hosts(uuid) from public;

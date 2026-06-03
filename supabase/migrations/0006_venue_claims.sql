-- ============================================================================
-- Roam — 0006_venue_claims.sql
-- Claim-as-request: the first real write-path on the consumer surface, built as
-- a TRUST EVENT, not a land-grab.
--
-- THE DESIGN (why this shape):
-- Claiming a venue is the single most security-sensitive write in Stage 1 — it is
-- a user asserting "I own this real-world business", which downstream unlocks
-- editing the public listing, posting to people nearby, and (later) taking payment.
-- So a claim must NEVER immediately confer ownership on an unverified say-so.
--
-- Instead a claim is a REQUEST:
--   unclaimed  --(user requests)-->  pending_claim   [owner_id still NULL]
--   pending_claim --(verified, SERVICE ROLE)--> claimed   [owner_id set]
--
-- This completes a seam the data model already left open:
--   * venue_status already has 'pending_claim' (0001), used by nothing until now.
--   * venues_owner_update (0004) already requires status = 'claimed' — i.e. the
--     edit policy was written ASSUMING ownership only exists post-verification.
-- We are finishing that design, not inventing one.
--
-- The dangerous transition (-> claimed, set owner_id) stays SERVICE-ROLE ONLY,
-- exactly as 0004's comment demands ("Claiming ... goes through service role to
-- enforce verification"). The verification MECHANISM is a deliberately dormant
-- seam: a pending_claim row genuinely awaits review. That is a TRUE state, not a
-- stubbed lie — the difference between a clean deferral and technical debt.
--
-- venue_claims is a TABLE (not a column on venues) on purpose: a real review
-- process wants claim history, the ability to hold competing claims on one venue,
-- and an audit trail for the eventual moderation/review queue (a hard gate).
-- A table makes that review step nearly free later; a column would force a
-- migration. Same reasoning that makes pending_claim the right state now.
-- ============================================================================

-- --- Claim lifecycle ---------------------------------------------------------
-- A claim moves through its own small lifecycle, INDEPENDENT of venue_status, so
-- the audit trail survives even after a venue is claimed or a claim is rejected.
--   pending   : submitted, awaiting verification (the launch default)
--   approved  : verification passed; the venue was transitioned to 'claimed'
--   rejected  : verification failed / withdrawn; venue returns to 'unclaimed'
--               (unless another pending claim exists)
create type venue_claim_status as enum ('pending', 'approved', 'rejected');

-- ============================================================================
-- venue_claims — one row per claim attempt. Append-only in spirit: a claim's
-- status is updated as it is reviewed, but rows are not deleted (audit trail).
-- ============================================================================
create table venue_claims (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues(id) on delete cascade,
  -- Who is asking to own this venue. NOT the owner yet — ownership is conferred
  -- only on approval, by setting venues.owner_id via service role.
  claimant_id  uuid not null references profiles(id) on delete cascade,
  status       venue_claim_status not null default 'pending',
  -- Free-text context the claimant supplies ("I'm the owner, here's my role").
  -- Real verification evidence (docs, email-domain proof) attaches here later;
  -- kept as a nullable note for now so the seam exists without over-building it.
  note         text,
  -- Review audit: who actioned it and when (service-role / staff only).
  reviewed_by  uuid references profiles(id) on delete set null,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger trg_venue_claims_updated before update on venue_claims
  for each row execute function set_updated_at();

create index idx_venue_claims_venue on venue_claims (venue_id, created_at desc);
create index idx_venue_claims_claimant on venue_claims (claimant_id, created_at desc);
-- At most ONE pending claim per (venue, claimant): a user can't spam duplicate
-- requests for the same venue, but a DIFFERENT user may still file a competing
-- pending claim (the review process resolves between them).
create unique index uq_venue_claims_one_pending
  on venue_claims (venue_id, claimant_id)
  where status = 'pending';

comment on table venue_claims is
  'Claim REQUESTS (claim-as-request). A pending row means "someone asked to own this venue; awaiting verification" — a true state, never premature ownership. Ownership is conferred only on approval by setting venues.owner_id via service role. Table (not a column) so the eventual review queue gets history + competing claims + audit for free.';

-- ============================================================================
-- The unclaimed -> pending_claim transition, as a SECURITY DEFINER function.
--
-- Why a function and not a bare RLS update policy on venues:
-- We must let a signed-in user flip status unclaimed -> pending_claim AND insert
-- their venue_claims row, but we must NOT let them touch owner_id or any other
-- venue column. A broad venues UPDATE policy can restrict the row (USING) and the
-- resulting row (WITH CHECK) but cannot easily forbid which COLUMNS change — the
-- safe, auditable way to scope this to exactly two side-effects is a function that
-- performs precisely those writes and nothing else.
--
-- SECURITY DEFINER is used DELIBERATELY and SAFELY here. The known footgun (the
-- sibling-project RLS-recursion lockout) was a definer function that queried its
-- OWN policy's table and recursed. This function does NOT do that: it reads/writes
-- venues and venue_claims, and the recursion risk is avoided because we do the
-- authorisation check explicitly against auth.uid() (a stable, non-recursive call)
-- rather than leaning on a policy that calls back into this function. search_path
-- is locked. It is owned by the migration role (postgres), so it runs with the
-- privilege to make exactly the two writes below — no broader venues write policy
-- is granted to users at all.
--
-- It can ONLY move unclaimed -> pending_claim. It cannot set owner_id. It cannot
-- approve. The dangerous step stays elsewhere (service role).
--
-- ERROR CONTRACT (relied on by packages/api/src/routers/venues.ts requestClaim):
-- The errcodes below are forwarded by PostgREST into the RPC error's `code` field
-- (PostgREST mirrors the PostgreSQL error structure: message/detail/hint/code).
-- The API matches on that SQLSTATE string to show a friendly message:
--   28000 -> AUTH_REQUIRED       (not signed in)
--   P0002 -> VENUE_NOT_FOUND
--   22023 -> VENUE_NOT_CLAIMABLE (already pending/claimed/suspended)
--   23505 -> raised by Postgres itself from uq_venue_claims_one_pending
--            (duplicate pending claim) — not RAISEd here, arrives automatically.
-- If you change a code here, change CLAIM_ERROR_BY_SQLSTATE in venues.ts to match.
-- ============================================================================
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
  caller   uuid := auth.uid();
  v_status venue_status;
  claim    venue_claims;
begin
  if caller is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  -- Lock the venue row so a concurrent claim can't race the status check.
  select status into v_status from venues where id = target_venue_id for update;

  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Only an unclaimed venue can be requested. A venue already pending/claimed/
  -- suspended is not claimable through this path.
  if v_status <> 'unclaimed' then
    raise exception 'VENUE_NOT_CLAIMABLE' using errcode = '22023';
  end if;

  -- Record the request. The partial unique index enforces one pending claim per
  -- (venue, claimant); a duplicate raises unique_violation, which the API maps to
  -- a friendly "you've already requested this".
  insert into venue_claims (venue_id, claimant_id, note)
  values (target_venue_id, caller, claim_note)
  returning * into claim;

  -- Move the venue into the pending state. owner_id is untouched (stays NULL).
  update venues set status = 'pending_claim' where id = target_venue_id;

  return claim;
end;
$$;

comment on function request_venue_claim(uuid, text) is
  'Claim-as-request entry point for signed-in users. Moves a venue unclaimed -> pending_claim and records a venue_claims row for the caller. CANNOT set owner_id or approve a claim — ownership is conferred only by the service-role approval path. SECURITY DEFINER but non-recursive (authorises via auth.uid(), not a self-referential policy); search_path locked.';

-- Only signed-in users may request a claim. anon cannot (no grant).
grant execute on function request_venue_claim(uuid, text) to authenticated;

-- ============================================================================
-- RLS on venue_claims.
-- A claimant can see and create THEIR OWN claims. The review side (approve/reject,
-- seeing all claims on a venue) is service-role / staff only — no public policy,
-- so anon and ordinary users get nothing beyond their own rows. Inserts happen
-- through request_venue_claim (definer), but we still scope a direct insert policy
-- to the caller as belt-and-braces, and a select policy so the UI can read back
-- "claim submitted" state.
-- ============================================================================
alter table venue_claims enable row level security;

-- A user sees their own claims (to render "pending review" on the venue page).
create policy venue_claims_own_read on venue_claims for select
  using (claimant_id = auth.uid());

-- A venue owner can see claims against a venue they already own (post-approval
-- visibility; harmless and useful for the console later).
create policy venue_claims_owner_read on venue_claims for select
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

-- Direct insert is scoped to self. (The primary path is the definer function,
-- which bypasses RLS; this policy means a direct insert can't forge a claimant.)
create policy venue_claims_self_insert on venue_claims for insert
  with check (claimant_id = auth.uid());

-- No update/delete policy for users: a claimant cannot self-approve or rewrite
-- review fields. Review is service-role only. (Withdrawing a claim can be added
-- later as a scoped status-> 'rejected' path if product wants it.)

-- ============================================================================
-- Profile provisioning — every auth user must have a profiles row.
--
-- WHY THIS IS HERE NOW: venue_claims.claimant_id is a FK to profiles(id), and a
-- brand-new auth user (just signed up via the claim flow) has an auth.users row
-- but NO profiles row yet. Without provisioning, their first claim would fail the
-- FK. The clean, race-free fix is a trigger that creates the profile the moment
-- the auth user is created — server-side, atomic, independent of any client timing
-- or RLS sequencing. Doing this client-side (insert into profiles after sign-up)
-- is racy and leans on RLS at exactly the wrong moment; a definer trigger owned by
-- the auth schema is the standard Supabase pattern.
--
-- This is foundational rather than claim-specific, but it lands here because the
-- claim flow is the FIRST feature that creates users, so it's the first feature
-- that needs it. (If a later migration moves it earlier, that's fine — it's
-- idempotent via 'on conflict do nothing'.)
--
-- SECURITY DEFINER: runs as the function owner so it can write profiles regardless
-- of the (nonexistent) session at auth-user-creation time. search_path locked.
-- Non-recursive: it writes profiles and reads only the NEW auth.users row.
-- ============================================================================
create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into profiles (id, display_name)
  values (
    new.id,
    -- Best-effort display name from sign-up metadata; null is fine (editable later).
    coalesce(new.raw_user_meta_data ->> 'display_name', null)
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

comment on function handle_new_auth_user() is
  'Provisions a profiles row for every new auth.users row (the claim flow is the first feature that creates users, and venue_claims.claimant_id FKs to profiles). Idempotent via on conflict do nothing; SECURITY DEFINER, search_path locked, non-recursive.';

-- Fire after an auth user is created. Guard against duplicate trigger on re-run.
drop trigger if exists trg_auth_user_created on auth.users;
create trigger trg_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

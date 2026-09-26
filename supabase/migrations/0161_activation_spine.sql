-- ============================================================================
-- 0161 — the activation spine (F2G plan 2.4).
--
-- WHAT THIS REPLACES. B3-d shipped invite→claim: an emailed capability link named a (member, venue)
-- pair and, once clicked by any signed-in account, conferred ownership. The link WAS the credential,
-- so anyone who saw the e-mail — a forward, a shared inbox, a mail archive — could take a real
-- business's listing. Plan §3.2 closes that: "the link no longer confers ownership: it lands on
-- /activate, which still requires the second factor".
--
-- Since there are no membership numbers until 2027, that factor is e-mail possession and nothing
-- else (§3.2, second bullet — recorded there as a real reduction in assurance). Possession is proved
-- one of two ways: the signed-in account's own verified e-mail already equals the roster e-mail, or
-- a one-time code is sent to the roster e-mail and typed back. This migration is the spine both
-- need.
--
-- THREE PARTS.
--   1. `channel_activation_codes` — one-time codes, stored ONLY as a hash, bound to the exact
--      (member, venue, account) triple they were issued for, with an expiry and an attempt counter.
--   2. `channel_activation_attempts` — every attempt, successful or not. §3.2 requires failed
--      attempts to be audited; a table nobody can rewrite is the only way that claim means anything.
--   3. `activate_channel_member_venue` — the conferral, extending 0139/0154's claim definer.
--
-- AND ONE REMOVAL — WHICH IS NOT HERE. §3.2 also says "PostgREST self-tagging into any channel is
-- removed", i.e. `venue_channels_owner_write` must go. That drop is 0163, NOT this file, and the
-- split is the point rather than an accident.
--
-- THIS MIGRATION IS DELIBERATELY ADDITIVE. "Schema leads code" (the release runbook) holds for a
-- migration that ADDS something the app will read: apply it, then deploy. A migration that REMOVES
-- something the RUNNING code still depends on has to go the other way round — deploy first, then
-- drop — or the window between the two is an outage.
--
-- Bundling both halves in one file made both rules impossible to satisfy at once, and deadlocked in
-- practice: the schema-drift guard went red the moment this merged (the tables it probes were not
-- applied yet), the deploy host gates on the check suite and so would not ship the code that stops
-- needing the policy, and the policy could not safely be dropped until that code shipped. Expand
-- here; contract in 0163, once the router calls `tag_venue_listing` instead of writing the table.
--
-- WHY THE DEFINER STILL REQUIRES AN ALREADY-BOUND PAIR. §3.2 also says an unbound roster row binds
-- only when the roster postcode matches the venue. That rule is NOT enforced here, deliberately.
-- `venues` has no postcode column — it is extracted from free-text `address` by UK_POSTCODE_RE
-- (`packages/core/src/matching/index.ts`), and a second copy of that regex in SQL would be a second
-- definition of what a postcode is, drifting silently from the matcher that the roster was imported
-- with. So binding stays in the layer that owns that definition, and is audited below; what the
-- database guarantees is narrower and absolute: activation NEVER confers a pair the roster does not
-- already assert.
--
-- After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================

-- ── 1. one-time codes ───────────────────────────────────────────────────────────────────────────
create table if not exists channel_activation_codes (
  id          uuid primary key default gen_random_uuid(),
  -- The triple the code proves. All three, because a code is not a bearer token: it is useless to
  -- anyone but the account that asked for it, for the venue they asked about.
  member_id   uuid not null references channel_members(id) on delete cascade,
  venue_id    uuid not null references venues(id) on delete cascade,
  profile_id  uuid not null references profiles(id) on delete cascade,
  -- SHA-256 of the code, hex. The plaintext is generated in the API, sent to the roster e-mail, and
  -- never written here or logged: a database backup must not be a list of live credentials.
  code_hash   text not null check (char_length(code_hash) = 64),
  expires_at  timestamptz not null,
  -- Counted per code, so guessing burns the code rather than merely slowing the guesser.
  attempts    int not null default 0 check (attempts >= 0),
  consumed_at timestamptz,
  created_at  timestamptz not null default now()
);

-- Throttling reads: "how many codes has this account asked for lately" and the same per roster row.
create index if not exists channel_activation_codes_profile_idx
  on channel_activation_codes (profile_id, created_at desc);
create index if not exists channel_activation_codes_member_idx
  on channel_activation_codes (member_id, created_at desc);
-- The live-code lookup: the newest unconsumed, unexpired code for a triple.
create index if not exists channel_activation_codes_live_idx
  on channel_activation_codes (member_id, venue_id, profile_id, created_at desc)
  where consumed_at is null;

alter table channel_activation_codes enable row level security;
-- NO POLICY, deliberately: service-managed, like channel_members (0135) and channel_integrations
-- (0155). RLS-on-with-no-policy denies every client role outright. A code hash is a credential;
-- there is no read of this table that a browser should ever make.

comment on table channel_activation_codes is
  'One-time activation codes proving control of a roster member''s e-mail (F2G plan 2.4). Service-'
  'managed: RLS is on with NO policy, so no client role can read or write it. The plaintext code '
  'lives only in the e-mail — this table holds a SHA-256 hash. Bound to a (member, venue, account) '
  'triple so a code cannot be relayed to another account or re-pointed at another venue.';

comment on column channel_activation_codes.attempts is
  'Failed verifications against THIS code. The API burns the code at a small ceiling, so guessing '
  'costs a fresh send (which is itself throttled) rather than unlimited tries.';

-- ── 2. the attempt audit ────────────────────────────────────────────────────────────────────────
create table if not exists channel_activation_attempts (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  -- Nullable: an attempt can fail before a member or venue is even resolved, and that is exactly the
  -- attempt worth recording.
  member_id  uuid references channel_members(id) on delete set null,
  venue_id   uuid references venues(id) on delete set null,
  profile_id uuid references profiles(id) on delete set null,
  outcome    text not null check (char_length(outcome) between 1 and 64),
  -- No e-mail addresses and no codes. Enough to see a pattern, not enough to be a second copy of the
  -- roster's PII (which 2.5 is about masking, not duplicating).
  detail     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists channel_activation_attempts_channel_idx
  on channel_activation_attempts (channel_id, created_at desc);
create index if not exists channel_activation_attempts_profile_idx
  on channel_activation_attempts (profile_id, created_at desc);

alter table channel_activation_attempts enable row level security;
-- NO POLICY: an audit trail the audited party can read is a map of what to avoid, and one they can
-- write is not an audit trail. HQ reads it with the service client.

comment on table channel_activation_attempts is
  'Every activation attempt on a whitelabel channel, successful or not (F2G plan 2.4 — "failed '
  'attempts audited"). Service-managed: RLS on, NO policy. Carries no e-mail address and no code.';

-- ── 3. the tripwires ────────────────────────────────────────────────────────────────────────────
-- Same pattern as 0135/0137/0148/0155/0156: the absence of a policy already denies client roles, so
-- these can only fire if someone later adds one. That is precisely when we want to hear about it.
create or replace function public.channel_activation_guard_client_roles()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'activation state is service-managed and not writable by a client role'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists channel_activation_codes_guard on channel_activation_codes;
create trigger channel_activation_codes_guard
  before insert or update or delete on channel_activation_codes
  for each row execute function public.channel_activation_guard_client_roles();

drop trigger if exists channel_activation_attempts_guard on channel_activation_attempts;
create trigger channel_activation_attempts_guard
  before insert or update or delete on channel_activation_attempts
  for each row execute function public.channel_activation_guard_client_roles();

-- ── 4. the conferral ────────────────────────────────────────────────────────────────────────────
-- Extends claim_channel_member_venue (0139, rewritten by 0154). The differences are what 2.4 is for:
--   * the caller has proved e-mail possession, not merely held a link;
--   * `lapsed` is NOT activatable — a lapsed row means the roster no longer lists them, and
--     restoring that is an import or an HQ action, never a self-serve one;
--   * the member's bound venue must already equal p_venue_id (see the header).
create or replace function activate_channel_member_venue(
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
  m        channel_members;
  v_status venue_status;
  v_owner  uuid;
  result   channel_member_claim_result;
begin
  if p_claimant_id is null then
    raise exception 'CLAIMANT_REQUIRED' using errcode = 'P0001';
  end if;

  -- Same lock order as 0154: member, then venue.
  select * into m from channel_members where id = p_member_id for update;
  if not found then
    raise exception 'MEMBER_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- The roster must already assert this pair. An unbound row is refused here even when the caller
  -- believes the postcodes agree — binding is a separate, audited step (see the header).
  if m.venue_id is null then
    raise exception 'NOT_BOUND' using errcode = 'P0001';
  end if;
  if m.venue_id <> p_venue_id then
    raise exception 'VENUE_MISMATCH' using errcode = 'P0001';
  end if;

  select status, owner_id into v_status, v_owner from venues where id = p_venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  if m.status not in ('imported', 'invited') then
    -- Re-running a completed activation is a no-op success for the SAME account, so a double-submit
    -- or a back-button does not read as a failure.
    if m.status in ('claimed', 'live') and m.claimed_by is not distinct from p_claimant_id then
      result := (m.id, p_venue_id, false, v_status, 'already_claimed');
      return result;
    end if;
    raise exception 'NOT_CLAIMABLE' using errcode = 'P0001';
  end if;

  -- Never steal an existing claim.
  if v_owner is not null and v_owner <> p_claimant_id then
    raise exception 'CLAIMED_BY_OTHER' using errcode = 'P0001';
  end if;

  update venues
    set status = 'claimed', owner_id = p_claimant_id
    where id = p_venue_id;

  update channel_members
    set status = 'live', claimed_by = p_claimant_id, claimed_at = now()
    where id = m.id;

  -- Membership, explicitly. One of only two paths to role='member' (the other being the audited HQ
  -- action); an existing 'listed' tag is upgraded, because someone who self-listed and has now
  -- proved roster membership is a member, not a listing.
  insert into venue_channels (channel_id, venue_id, added_by, role)
    values (m.channel_id, p_venue_id, p_claimant_id, 'member')
    on conflict (channel_id, venue_id) do update set role = 'member';

  result := (m.id, p_venue_id, true, 'claimed'::venue_status, 'activated');
  return result;
end;
$$;

-- MANDATORY, not decoration. Supabase's default privileges grant EXECUTE on every new function in
-- `public` to anon and authenticated (the posture 0151 exists to counteract), and those defaults
-- apply to functions created AFTER 0151 ran. Without this revoke, a browser could call this function
-- directly through PostgREST — and it takes the claimant as a PARAMETER, so anyone could confer
-- ownership of any roster-bound venue on themselves. Same reason as 0139/0154 for the claim definer.
revoke all on function activate_channel_member_venue(uuid, uuid, uuid) from public, anon, authenticated;

comment on function activate_channel_member_venue(uuid, uuid, uuid) is
  'Service-role activation conferral (F2G plan 2.4). Confers ownership of the roster-asserted venue '
  '(venues -> claimed + owner_id, member -> live + claimed_by/at) and tags venue_channels with '
  'role=''member'', ONLY when the member is already bound to p_venue_id, is imported/invited, and the '
  'venue is not owned by another user. Refuses an unbound row (NOT_BOUND) and a lapsed one '
  '(NOT_CLAIMABLE). Idempotent no-op on a same-claimant re-run. NOT granted to anon/authenticated — '
  'the API calls it with the service client only after e-mail possession has been proved.';

-- ── 5. the listing tag, service-side ────────────────────────────────────────────────────────────
-- These are what the router will call INSTEAD of writing venue_channels through the caller's own
-- client. They are SECURITY DEFINER and NOT granted to client roles: the ownership test lives here
-- so a caller cannot forget it, and the region fence stays in the router.
--
-- The matching REMOVAL of `venue_channels_owner_write` is deliberately NOT here — it is 0163. See
-- the header: this migration is additive so it can be applied to a live database whose running code
-- still needs that policy.
create or replace function tag_venue_listing(
  p_venue_id   uuid,
  p_channel_id uuid,
  p_actor_id   uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner  uuid;
  v_status venue_status;
begin
  select owner_id, status into v_owner, v_status from venues where id = p_venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_owner is null or v_owner <> p_actor_id or v_status <> 'claimed' then
    raise exception 'NOT_VENUE_OWNER' using errcode = 'P0001';
  end if;

  -- 'listed', never 'member'. Opting a venue into a storefront is not joining the Association (0160);
  -- an existing member tag is left alone rather than demoted.
  insert into venue_channels (channel_id, venue_id, added_by, role)
    values (p_channel_id, p_venue_id, p_actor_id, 'listed')
    on conflict (channel_id, venue_id) do nothing;
  return true;
end;
$$;

-- As above: these take the actor as a parameter, so a client-callable copy would be a way to write
-- venue_channels on behalf of whoever owns the venue — reopening the path 0161 just closed.
revoke all on function tag_venue_listing(uuid, uuid, uuid) from public, anon, authenticated;

comment on function tag_venue_listing(uuid, uuid, uuid) is
  'Service-role self-serve listing (F2G plan 2.4). Writes venue_channels with role=''listed'' after '
  'checking the actor owns the claimed venue; never writes ''member'' and never demotes an existing '
  'member tag. NOT granted to anon/authenticated — 0161 removed venue_channels_owner_write so the '
  'only route is the API, which applies the channel''s region fence first.';

create or replace function untag_venue_listing(
  p_venue_id   uuid,
  p_channel_id uuid,
  p_actor_id   uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_role  text;
begin
  select owner_id into v_owner from venues where id = p_venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_owner is null or v_owner <> p_actor_id then
    raise exception 'NOT_VENUE_OWNER' using errcode = 'P0001';
  end if;

  select role into v_role from venue_channels
    where channel_id = p_channel_id and venue_id = p_venue_id;
  if not found then
    return false;
  end if;
  -- An owner may withdraw their own LISTING. They may not resign the Association's membership on
  -- its behalf — that is a roster decision, and removing the tag would silently un-rank a member.
  if v_role <> 'listed' then
    raise exception 'NOT_A_LISTING' using errcode = 'P0001';
  end if;

  delete from venue_channels where channel_id = p_channel_id and venue_id = p_venue_id;
  return true;
end;
$$;

revoke all on function untag_venue_listing(uuid, uuid, uuid) from public, anon, authenticated;

comment on function untag_venue_listing(uuid, uuid, uuid) is
  'Service-role self-serve unlisting (F2G plan 2.4). Deletes the venue_channels row only when the '
  'actor owns the venue AND the row is role=''listed''; refuses to remove a ''member'' tag, which '
  'would un-rank a member the Association placed. NOT granted to anon/authenticated.';

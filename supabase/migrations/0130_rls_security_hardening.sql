-- ============================================================================
-- 0130_rls_security_hardening.sql
--
-- Closes three directly-reachable RLS holes from the Sep 2026 security review.
-- All three are reachable from a browser with the public anon/authenticated key
-- against PostgREST (/rest/v1/...) — the tRPC layer is NOT a shield. Forward-only
-- and additive; mirrors the 0076_security_hardening precedent.
-- ============================================================================

-- ── #1 friendships: only the ADDRESSEE may accept, and the identity pair is immutable
--
-- 0004's friendships_update had USING (requester OR addressee) and NO WITH CHECK, so
-- Postgres reused USING as the post-image check and the REQUESTER could self-accept a
-- request they sent. are_friends() then returns true, which is the sole gate on the
-- SECURITY DEFINER friends_nearby()/friends_availability() RPCs — leaking the addressee's
-- precise live GPS. A WITH CHECK alone is NOT sufficient: RLS predicates cannot see OLD,
-- so a requester could instead REWRITE a pending row's (requester_id, addressee_id) to
-- forge an accepted friendship with an arbitrary third party and still satisfy
-- addressee_id = auth.uid(). So we (a) require the post-image addressee to be the caller,
-- and (b) pin the identity columns immutable on UPDATE via a trigger. The only legitimate
-- UPDATE is the addressee setting status='accepted' (respondToFriend); decline and unfriend
-- are DELETEs, and 'blocked' is never written by any code path.
alter policy friendships_update on friendships
  using (requester_id = auth.uid() or addressee_id = auth.uid())
  with check (addressee_id = auth.uid());

create or replace function public.friendships_pin_identity()
  returns trigger
  language plpgsql
  set search_path = public, pg_temp
as $$
begin
  -- The two identity columns never change after insert. Force them back to their old
  -- values so no UPDATE can repoint a row onto a different pair of users.
  new.requester_id := old.requester_id;
  new.addressee_id := old.addressee_id;
  return new;
end;
$$;

drop trigger if exists friendships_pin_identity on friendships;
create trigger friendships_pin_identity
  before update on friendships
  for each row
  execute function public.friendships_pin_identity();

-- ── #2 plan_members: membership is owner-granted, never self-asserted ────────────────
--
-- 0037's plan_members_write allowed `profile_id = auth.uid()`, letting ANY authenticated
-- user insert their own membership row into ANY plan given its uuid (uuids leak via the
-- public plans.preview procedure and /plans/<id> notification hrefs). Membership unlocks
-- plans_read, plan_venues_read, and the plan's private group chat via the
-- get_or_create_plan_thread definer RPC (it self-adds a member to chat_participants).
-- Drop the self-insert disjunct so only the plan owner may add members. owns_plan(plan_id)
-- still lets the owner add themselves or anyone else (the invite flow); the lazy chat
-- late-join writes chat_participants, not plan_members, so nothing legitimate relied on
-- non-owner self-insert here.
drop policy if exists plan_members_write on public.plan_members;
create policy plan_members_write on public.plan_members for insert
  with check (owns_plan(plan_id));

-- ── #3 places_fetch_quota: enable RLS (the one table in the schema that never had it) ─
--
-- 0024 created places_fetch_quota WITHOUT `enable row level security`. With the Supabase
-- cloud default of exposing new public tables to anon/authenticated, PostgREST served it
-- directly — anyone with the public key could reset the paid Google Places daily budget
-- (unbounded billable calls) or exhaust it (deny discovery to everyone). Only the
-- SECURITY DEFINER claim_places_fetch_quota() should ever write it; the definer owner
-- bypasses RLS, so enabling RLS with NO policies denies all direct client access while
-- leaving the claim path fully intact.
alter table public.places_fetch_quota enable row level security;
revoke all on table public.places_fetch_quota from anon, authenticated;  -- belt-and-braces over RLS

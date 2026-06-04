-- Migration 0011 — Stage 2b thread/plan plumbing: creation bootstrap + participant invites.
--
-- Context: chat_threads and chat_participants each had ONLY a SELECT policy
-- (chat_*_read, gated on in_thread). No INSERT path existed, so threads were
-- only reachable via manual SQL seed. This migration makes thread creation a
-- real app action while keeping the invariant "a thread always has its creator
-- as a participant" enforced at the DATA layer, not promised by the API.
--
-- The bootstrap chicken-and-egg: a WITH CHECK (in_thread(id)) INSERT policy on
-- chat_threads can NEVER pass for a brand-new thread (the creator isn't a
-- participant yet, and can't be until the thread exists). Solving this in two
-- API calls leaves a window where a thread exists with zero participants.
-- Instead we route ALL creation through a SECURITY DEFINER function that inserts
-- the thread AND the creator-participant atomically. chat_threads therefore needs
-- no INSERT policy at all — the absence of any other write path IS the guarantee.
--
-- RLS-helper rule (from the 0010 in_thread recursion): any function used by — or
-- writing to — RLS-protected tables runs SECURITY DEFINER with a pinned search_path.
--
-- Idempotent: create-or-replace function; drop-if-exists before each policy.

-- 1. Transactional thread creation. Runs as definer so the two inserts are not
--    blocked by the (absent) chat_threads INSERT policy or the chat_participants
--    WITH CHECK; auth.uid() is still the REAL caller (definer changes role, not the
--    JWT claims GoTrue set). Returns the new thread row for the router to hand back.
create or replace function public.create_thread_with_creator(
  p_is_group boolean default false,
  p_plan_id  uuid    default null,
  p_title    text    default null
)
returns public.chat_threads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_thread public.chat_threads;
begin
  if v_uid is null then
    raise exception 'create_thread_with_creator: no authenticated user'
      using errcode = '28000';
  end if;

  insert into public.chat_threads (is_group, plan_id, title)
  values (p_is_group, p_plan_id, p_title)
  returning * into v_thread;

  insert into public.chat_participants (thread_id, profile_id)
  values (v_thread.id, v_uid);

  return v_thread;
end;
$$;

-- Lock the function down: only authenticated users may call it (not anon).
revoke all on function public.create_thread_with_creator(boolean, uuid, text) from public;
grant execute on function public.create_thread_with_creator(boolean, uuid, text) to authenticated;

-- 2. Participant INSERT policy — for adding OTHERS to an EXISTING thread
--    (addThreadParticipant). You may only add a participant to a thread you are
--    already in. Reuses the live SECURITY DEFINER in_thread(), so no recursion:
--    the policy reads chat_participants, but via a definer function, exactly the
--    pattern 0010 established. The creator-self-add path does NOT use this policy
--    (it goes through the definer function above), so first-participant bootstrap
--    is unaffected.
drop policy if exists chat_participants_write on public.chat_participants;
create policy chat_participants_write
  on public.chat_participants
  for insert
  to authenticated
  with check ( in_thread(thread_id) );

-- Note: deliberately NO chat_threads INSERT policy. Creation is definer-only.
-- Note: no UPDATE policy added here — last_read_at updates are a separate slice.

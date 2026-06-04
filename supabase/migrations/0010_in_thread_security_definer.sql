-- 0010_in_thread_security_definer.sql
--
-- Fix infinite RLS recursion in in_thread().
--
-- in_thread(t) is the membership primitive used by chat_threads/meetups/
-- meetup_options/meetup_votes RLS policies. It reads chat_participants — whose
-- OWN select policy (chat_participants_read) is itself in_thread(thread_id).
-- As a SECURITY INVOKER function the inner read re-triggers that policy, which
-- calls in_thread again => unbounded recursion ("stack depth limit exceeded").
--
-- This was latent until Stage 2a: every prior in_thread caller was either
-- service-role (RLS bypassed) or an anonymous public read. meetup.createMeetup
-- under a real user JWT is the first RLS-enforced authenticated call through it,
-- which is what surfaced the recursion.
--
-- Fix: SECURITY DEFINER so the membership read bypasses RLS, breaking the cycle.
-- Safe — the function returns only a boolean about the current auth.uid() and
-- leaks no rows. search_path is pinned (mandatory for definer functions).
--
-- LESSON: any helper used inside an RLS policy that itself reads an RLS-protected
-- table must be SECURITY DEFINER with a pinned search_path.
--
-- Already applied to prod during the Stage 2a build; this captures it. Idempotent
-- (create or replace), so re-applying is a safe no-op.

create or replace function public.in_thread(t uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from chat_participants cp
    where cp.thread_id = t and cp.profile_id = auth.uid()
  );
$$;

revoke all on function public.in_thread(uuid) from public;
grant execute on function public.in_thread(uuid) to anon, authenticated, service_role;

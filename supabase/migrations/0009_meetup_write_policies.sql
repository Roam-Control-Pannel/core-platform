-- 0009_meetup_write_policies.sql
--
-- Stage 2a schema tail: the INSERT write policies that let a thread participant
-- open a meet-up poll and add candidate venues to it.
--
-- 0004_rls.sql gave meetups / meetup_options only SELECT policies. With RLS on and
-- no permissive INSERT policy, a user-role insert is denied by default, so
-- meetupRouter.createMeetup / addOption could never succeed under a real user JWT.
-- These two policies close that gap, mirroring the existing *_read logic: you may
-- write where you may see. in_thread(uuid) (0004) is the membership primitive
-- (EXISTS a chat_participants row for auth.uid() on that thread).
--
-- These were first created directly against production during the Stage 2a build
-- to unblock runtime proofs and are ALREADY LIVE. This migration captures them so
-- the repo matches prod. Written idempotently (drop-if-exists then create), so
-- applying to prod is a safe no-op and it is re-runnable anywhere.

drop policy if exists meetups_write on meetups;
create policy meetups_write on meetups
  for insert
  with check ( in_thread(thread_id) );

drop policy if exists meetup_options_write on meetup_options;
create policy meetup_options_write on meetup_options
  for insert
  with check (
    exists (
      select 1 from meetups mu
      where mu.id = meetup_options.meetup_id
        and in_thread(mu.thread_id)
    )
  );

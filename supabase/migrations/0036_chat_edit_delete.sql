-- Migration 0036 — edit/delete for chat, completing the author-owns-their-content
-- contract for the chat surface (messages, group titles, leaving a thread).
--
-- Before this, chat_messages had only read + insert policies and chat_threads only
-- read (0004) — so a sent message could never be edited or deleted, a group could
-- never be renamed, and there was no way to leave a thread. These policies add the
-- minimum author/participant-scoped writes; routers add the product guards on top
-- (e.g. only free-standing groups may be renamed). in_thread() is the existing
-- SECURITY DEFINER membership primitive (0010), safe to call inside RLS.
--
-- Idempotent: drop-if-exists before each policy.

-- ----------------------------------------------------------------------------
-- Messages: the sender may edit or delete their OWN message. The WITH CHECK on
-- update keeps the row in a thread the sender still belongs to (defensive — a
-- sender is always in their thread).
-- ----------------------------------------------------------------------------
drop policy if exists chat_messages_update on public.chat_messages;
create policy chat_messages_update
  on public.chat_messages
  for update
  to authenticated
  using (sender_id = auth.uid())
  with check (sender_id = auth.uid() and in_thread(thread_id));

drop policy if exists chat_messages_delete on public.chat_messages;
create policy chat_messages_delete
  on public.chat_messages
  for delete
  to authenticated
  using (sender_id = auth.uid());

-- ----------------------------------------------------------------------------
-- Threads: any participant may UPDATE the thread (used to rename a group title).
-- The router restricts this to free-standing groups so a plan chat's title can't
-- drift from its plan; RLS just enforces "must be a participant".
-- ----------------------------------------------------------------------------
drop policy if exists chat_threads_update on public.chat_threads;
create policy chat_threads_update
  on public.chat_threads
  for update
  to authenticated
  using (in_thread(id))
  with check (in_thread(id));

-- ----------------------------------------------------------------------------
-- Participants: you may remove YOURSELF from a thread (leave a chat). Removing
-- other people is not a participant-level action here.
-- ----------------------------------------------------------------------------
drop policy if exists chat_participants_leave on public.chat_participants;
create policy chat_participants_leave
  on public.chat_participants
  for delete
  to authenticated
  using (profile_id = auth.uid());

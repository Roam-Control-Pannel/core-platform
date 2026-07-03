-- 0061_chat_messages_realtime.sql
-- Enable Supabase Realtime (postgres_changes) for chat_messages so the open conversation reflects
-- new, edited and deleted messages live. RLS still applies per-subscriber: the change stream is
-- evaluated under each socket's JWT, so a user only receives events for threads they participate
-- in (the same guarantee as chat.listMessages). No new policies are needed.
--
-- replica identity full: makes UPDATE/DELETE WAL records carry the whole old row, so the client's
-- `thread_id=eq.{id}` filter can match delete events too (default replica identity is the primary
-- key only, which would drop the thread_id from delete payloads). Small extra WAL per change,
-- acceptable for a chat table.

alter table public.chat_messages replica identity full;

-- Add the table to the realtime publication (idempotent — skip if already a member).
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'chat_messages'
  ) then
    alter publication supabase_realtime add table public.chat_messages;
  end if;
end
$$;

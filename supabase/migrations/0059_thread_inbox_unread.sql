-- 0059_thread_inbox_unread.sql
--
-- Chat Phase 3, Slice A: unread counts + last-message previews for the inbox. Finishes the seam
-- 0002 stubbed (chat_participants.last_read_at) and 0011 deferred ("last_read_at updates are a
-- separate slice"). Two functions:
--
--   * mark_thread_read(thread) — stamp the caller's last_read_at = now() for a thread. SECURITY
--     DEFINER because the deferred UPDATE policy on chat_participants was never added; the function
--     only ever writes the caller's OWN row (profile_id = auth.uid()), so definer is safe + narrow.
--   * thread_inbox() — per-thread last-message snapshot (kind/body/sender/time) + unread count for
--     the caller. SECURITY INVOKER: it runs under the caller's own RLS (they can already read their
--     threads' participant + message rows), so it exposes nothing they couldn't already read.
--
-- Unread = visible messages in the thread, not sent by me, created after my last_read_at. Additive
-- + idempotent (create or replace).

create or replace function mark_thread_read(p_thread uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update chat_participants
    set last_read_at = now()
  where thread_id = p_thread and profile_id = auth.uid();
end;
$$;

revoke all on function mark_thread_read(uuid) from public;
grant execute on function mark_thread_read(uuid) to authenticated;

create or replace function thread_inbox()
returns table (
  thread_id uuid,
  last_kind text,
  last_body text,
  last_sender_id uuid,
  last_created_at timestamptz,
  unread_count integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with mine as (
    select cp.thread_id, cp.last_read_at
    from chat_participants cp
    where cp.profile_id = auth.uid()
  ),
  visible as (
    select m.thread_id, m.kind, m.body, m.sender_id, m.created_at
    from chat_messages m
    join mine on mine.thread_id = m.thread_id
    where m.moderation in ('auto_approved', 'approved')
  ),
  last_msg as (
    select distinct on (v.thread_id)
      v.thread_id,
      v.kind        as last_kind,
      v.body        as last_body,
      v.sender_id   as last_sender_id,
      v.created_at  as last_created_at
    from visible v
    order by v.thread_id, v.created_at desc
  ),
  unread as (
    select v.thread_id, count(*)::int as unread_count
    from visible v
    join mine on mine.thread_id = v.thread_id
    where v.sender_id is distinct from auth.uid()
      and v.created_at > coalesce(mine.last_read_at, 'epoch'::timestamptz)
    group by v.thread_id
  )
  select
    mine.thread_id,
    lm.last_kind,
    lm.last_body,
    lm.last_sender_id,
    lm.last_created_at,
    coalesce(u.unread_count, 0) as unread_count
  from mine
  left join last_msg lm on lm.thread_id = mine.thread_id
  left join unread u on u.thread_id = mine.thread_id;
$$;

grant execute on function thread_inbox() to authenticated;

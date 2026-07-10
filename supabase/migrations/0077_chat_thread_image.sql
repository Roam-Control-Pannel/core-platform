-- 0077_chat_thread_image.sql
--
-- Group-chat personalisation: an optional custom photo per thread. The path points into the
-- existing private `chat-media` bucket (migration 0058), whose storage RLS already scopes
-- read/write to thread participants by the path's first segment — so a group photo is visible
-- only to members, exactly like the messages. No new storage policies are needed.
--
-- Writes to this column go through the existing chat_threads_update RLS policy (participant-only,
-- the same gate that powers rename), so nothing new is needed on chat_threads either. NULL means
-- "no custom photo" — the UI then falls back to a composite of members' avatars.

alter table chat_threads
  add column if not exists image_path text;

comment on column chat_threads.image_path is
  'Optional custom group-photo object path in the chat-media bucket (thread_id/<uuid>.<ext>). NULL → UI shows a member-avatar composite.';

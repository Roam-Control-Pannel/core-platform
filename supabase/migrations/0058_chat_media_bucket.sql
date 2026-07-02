-- ============================================================================
-- Roam — 0058_chat_media_bucket.sql
-- A PRIVATE Storage bucket for chat photos, scoped to a thread's participants.
--
-- MODEL (differs from profile-media, which is public): chat media is private to the people in the
-- conversation, so the bucket is NOT public and there is no world-read policy. Access is gated by
-- THREAD MEMBERSHIP: an object path is `{threadId}/{uuid}.ext`, so the first path segment names the
-- thread, and read/insert require the caller to be a participant of that thread (chat_participants).
-- Reads therefore go through short-lived SIGNED urls (the client mints them; the select policy is
-- what authorises the signature). Delete is limited to the uploader (storage.objects.owner).
--
-- The image message's payload stores the object PATH (not a url) — the path is stable and private;
-- each surface signs a url on render. 10 MB cap; common image types. Re-appliable (bucket upsert;
-- policies drop-first).
-- ============================================================================

-- 1. The bucket (PRIVATE; 10 MB object cap; common image mime types incl. gif).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media',
  'chat-media',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2. RLS on storage.objects, scoped to this bucket + the thread named by the path's first segment.

-- read — only participants of the thread whose id is the first path segment. This policy is also
-- what authorises a participant's createSignedUrl() call, since the bucket is private.
drop policy if exists chat_media_participant_read on storage.objects;
create policy chat_media_participant_read
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'chat-media'
    and exists (
      select 1 from public.chat_participants p
      where p.thread_id::text = (storage.foldername(name))[1]
        and p.profile_id = auth.uid()
    )
  );

-- insert — a participant may upload into their thread's folder (and only there).
drop policy if exists chat_media_participant_insert on storage.objects;
create policy chat_media_participant_insert
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'chat-media'
    and exists (
      select 1 from public.chat_participants p
      where p.thread_id::text = (storage.foldername(name))[1]
        and p.profile_id = auth.uid()
    )
  );

-- delete — the uploader can remove their own object.
drop policy if exists chat_media_owner_delete on storage.objects;
create policy chat_media_owner_delete
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'chat-media' and owner = auth.uid());

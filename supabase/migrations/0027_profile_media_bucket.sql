-- ============================================================================
-- Roam — 0027_profile_media_bucket.sql
-- A public Storage bucket for USER profile images (avatars + headers), with per-user
-- folder RLS — the profile twin of the venue-media bucket.
--
-- MODEL (mirrors venue-media): the bucket is PUBLIC (avatars render on a public discovery
-- surface, so reads are world-readable and the object URL is stable + CDN-cacheable). WRITES
-- are gated to the owner's OWN folder: an object path is `{user_id}/{uuid}.ext`, and the
-- policies require the FIRST path segment to equal auth.uid(). So a signed-in user can only
-- create/replace/delete objects under their own id — never another user's.
--
-- The profiles.avatar_url / header_url columns store the resolved PUBLIC url of the object
-- (the column has always meant "where the image is"); the API column-gate validates it is an
-- http(s) url. No bytes live in Postgres — same posture as venue photos.
--
-- Re-appliable: bucket insert is `on conflict do nothing`; policies drop-first.
-- ============================================================================

-- 1. The bucket (public read; 5 MB object cap; common image mime types).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'profile-media',
  'profile-media',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- 2. RLS on storage.objects, scoped to this bucket. (RLS is already enabled on
--    storage.objects by Supabase; we only add policies.)

-- public read — avatars/headers are a public discovery surface
drop policy if exists profile_media_public_read on storage.objects;
create policy profile_media_public_read
  on storage.objects for select
  using (bucket_id = 'profile-media');

-- owner insert — only into the caller's own {user_id}/… folder
drop policy if exists profile_media_owner_insert on storage.objects;
create policy profile_media_owner_insert
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'profile-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- owner update — replace/rename within the caller's own folder
drop policy if exists profile_media_owner_update on storage.objects;
create policy profile_media_owner_update
  on storage.objects for update
  to authenticated
  using (
    bucket_id = 'profile-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'profile-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- owner delete — remove objects from the caller's own folder
drop policy if exists profile_media_owner_delete on storage.objects;
create policy profile_media_owner_delete
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'profile-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

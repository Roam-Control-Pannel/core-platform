-- ============================================================================
-- 0153 — venue-media bucket limits (verbatim from live) + the profile-media twin of 0152's
--        owner-scoped read.
--
-- 1. venue-media limits. 0152 created the bucket only when absent because its live size/mime
--    settings had not been read yet. They have now (storage.buckets, 2026-09-17):
--      file_size_limit     10485760  (10 MB)
--      allowed_mime_types  image/jpeg, image/png, image/webp
--    Recorded here with the 0027 `on conflict … do update` pattern so a rebuilt database gets the
--    same bucket as live, and a drifted live row is brought back to the versioned values.
--
-- 2. profile-media owner read. The live read that drove 0152 also showed `profile_media_public_read`
--    still present, although 0076 §6 dropped it — so 0076 never reached the project. Re-asserting
--    that drop alone would leave 0027's owner update/delete policies dead, for the reason 0152's test
--    proved for venue-media: Postgres filters the rows an UPDATE/DELETE reads through its WHERE by the
--    SELECT policies. The app never updates/deletes profile objects today (every upload is
--    upsert:false), so nothing breaks either way — but the policies must mean what they say. So:
--    an owner-scoped SELECT (first path segment = auth.uid(), exactly the write predicate), then the
--    public listing policy dropped. Avatars keep rendering: public-bucket object reads bypass RLS.
--
-- Idempotent. Forward-only.
-- ============================================================================

-- ── 1. venue-media limits ────────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('venue-media', 'venue-media', true, 10485760, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ── 2. profile-media: owner-scoped read, no public listing ───────────────────
drop policy if exists profile_media_owner_select on storage.objects;
create policy profile_media_owner_select
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'profile-media'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists profile_media_public_read on storage.objects;

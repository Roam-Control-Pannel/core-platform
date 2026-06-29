-- ============================================================================
-- Roam — 0034_profile_media_video.sql
-- Allow short VIDEO on profile walls. The profile-media bucket (0027) was image-only
-- (jpeg/png/webp, 5 MB). Widen it to accept common web video and a larger ceiling so
-- a wall post can carry a clip. The per-user-folder RLS (0027) is unchanged — it
-- already authorises any object under {user_id}/…, so video uploads need no new policy.
--
-- Client + API still validate type/size per use (avatars stay image-only at 5 MB);
-- the bucket limit is a ceiling, not the per-feature rule.
--
-- Re-appliable: on-conflict update of the existing bucket row.
-- ============================================================================
update storage.buckets
  set file_size_limit = 52428800, -- 50 MB
      allowed_mime_types = array[
        'image/jpeg', 'image/png', 'image/webp',
        'video/mp4', 'video/webm', 'video/quicktime'
      ]
  where id = 'profile-media';

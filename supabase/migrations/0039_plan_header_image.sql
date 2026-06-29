-- Migration 0039 — custom header image for plans.
--
-- Lets a plan owner personalise their plan with a banner image (a night-out, a city break,
-- a list to try) — most striking on mobile/native where the plan reads like a card.
--
-- Storage: reuses the existing public `profile-media` bucket (0027) — the owner uploads under
-- their own {user_id}/… folder (the path-segment RLS already authorises that), so no new bucket
-- or policy is needed. We persist only the resolved PUBLIC url here (the column has always meant
-- "where the image is"); the API validates it is an http(s) url. No bytes live in Postgres,
-- mirroring profiles.avatar_url / header_url and venue photos.
--
-- Null header_url = no custom image; the UI falls back to a calm gradient placeholder.
--
-- Re-appliable: add-column-if-not-exists.

alter table plans
  add column if not exists header_url text;

comment on column plans.header_url is
  'Public URL of the plan''s custom header image (profile-media bucket, owner folder). '
  'Null = default gradient. API validates http(s).';

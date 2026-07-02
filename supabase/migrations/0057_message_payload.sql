-- 0057_message_payload.sql
--
-- Rich message kinds, foundation. chat_messages already carries a `kind` column and listMessages
-- passes every kind through unfiltered (the "rich-kind seam"), but there was nowhere to store the
-- STRUCTURED content of a non-text message. This adds a nullable `payload jsonb` that carries a
-- kind-specific snapshot — e.g. venue_card {venueId,name}, plan_card {planId,title},
-- profile_card {profileId,name,handle}, image {path,width,height,mime}. Text messages leave it null.
--
-- Validation lives in @roam/core (messaging.validateMessage), enforced by the API on write, so the
-- shape is guaranteed before it lands here — Postgres just stores the validated blob. No RLS change:
-- the existing chat_messages participant policies already gate who can read/write a row; the payload
-- rides along with its row. Additive + idempotent.

alter table chat_messages add column if not exists payload jsonb;

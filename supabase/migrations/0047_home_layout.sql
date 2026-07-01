-- 0047_home_layout.sql
--
-- Cross-device personalisation of the Home dashboard. Users can reorder / hide the Home widgets;
-- that preference already persists client-side (localStorage). This adds a per-user store so a
-- SIGNED-IN user's layout follows them across devices.
--
-- home_layout is a small, NON-SENSITIVE UI preference shaped { "order": string[], "hidden": string[] }
-- (widget ids). NULL means "no saved layout" → the client falls back to its default order. The
-- widget ids are opaque strings owned by the web app; the DB stores them verbatim and never
-- interprets them.
--
-- No new RLS needed: profiles already has profiles_update (id = auth.uid()) gating self-writes and
-- profiles_read for reads. The API only ever touches this column for the authed user's OWN row
-- (profiles.homeLayout / profiles.setHomeLayout — both protected procedures). The set_updated_at
-- trigger (0001) bumps updated_at on write. Idempotent; safe to run once on the Roam-Core project.

alter table profiles add column if not exists home_layout jsonb;

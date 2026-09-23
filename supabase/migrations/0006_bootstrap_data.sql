-- ============================================================================
-- Roam pre-F2G baseline — required bootstrap data
--
-- Supabase's schema-only squash intentionally omits DML. These rows are part of
-- a working installation rather than historical application data, so keep them
-- explicit and idempotent here. F2G-owned rows continue to begin at migration
-- 0116 and are deliberately not duplicated in this baseline.
-- ============================================================================

insert into public.feature_flags (key, enabled, description) values
  ('billing.paid_tiers', false, 'Premium/Gold checkout. Dormant at launch (free tier only).'),
  ('marketplace.enabled', false, 'Stage 5 shop/marketplace. Seam modelled, feature off.'),
  ('travel.enabled', false, 'Stage 5 trips/travel. Seam modelled, feature off.'),
  ('automation.enabled', false, 'Stage 5 automated promotion journeys. Seam modelled, feature off.'),
  ('ai.personalisation', false, 'AI personalisation. Post-launch.')
on conflict (key) do update
set enabled = excluded.enabled,
    description = excluded.description;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  (
    'profile-media',
    'profile-media',
    true,
    5242880,
    array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']
  ),
  (
    'chat-media',
    'chat-media',
    false,
    10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif']
  )
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

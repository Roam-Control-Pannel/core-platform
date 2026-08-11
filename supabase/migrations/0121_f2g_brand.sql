-- 0121_f2g_brand.sql
--
-- Food to Go · Phase 5 — Association co-brand. The storefront now wears the NI Food to Go
-- Association's own navy + yellow identity via explicit component tokens (apps/web/src/lib/
-- storefront.ts), so the channel row should NO LONGER override the base palette — the earlier
-- orange/green brand override would recolour the crimson "order ahead" kicker and the base UI.
-- Clear the theme overrides and record the Association logo path (served from the web app's public/).
--
-- Idempotent.

update channels
set theme = '{}'::jsonb,
    logo_url = '/f2g-logo.avif'
where key = 'f2g';

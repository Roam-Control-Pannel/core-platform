-- ============================================================================
-- Roam — 0112_cj_advertisers_program_url.sql
-- Add program_url (the merchant's own website) to cj_advertisers. CJ's Advertiser
-- Lookup API carries no logo field, but it does return each advertiser's site
-- (program-url) — from which the syncCjLogos job derives a brand logo (logo_url).
-- Storing the source domain makes the logo re-derivable later (e.g. swapping the
-- logo provider) without re-hitting CJ. Additive + idempotent; public-read already
-- covers the whole row (0111).
-- ============================================================================

alter table public.cj_advertisers
  add column if not exists program_url text;

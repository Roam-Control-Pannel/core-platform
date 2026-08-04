-- ============================================================================
-- Roam — 0111_cj_advertisers.sql
-- CJ (Commission Junction) advertiser brand metadata — one row per advertiser,
-- holding the merchant's LOGO url looked up from the CJ Advertiser Lookup API
-- (advertiser-lookup.api.cj.com/v2/advertiser-lookup). The deals router attaches
-- this logo to each CJ deal at read time (as its image_url) when the deal has no
-- image of its own, so a card shows the real brand logo instead of the generic
-- category icon. When no logo is known, the card keeps its icon fallback.
--
-- WHY a separate table, not cj_deals.image_url: the offers sync (syncCjOffers)
-- upserts whole cj_deals rows every run and would overwrite a backfilled logo.
-- Keyed by advertiser (not deal), the logo is looked up ONCE per advertiser and
-- survives every offers sync. Populated by the companion job syncCjLogos (service
-- role); this migration only defines the store + public read.
--
-- Logos are PUBLIC brand marks — world-readable, like cj_deals. Writes are
-- service-role only (the sync bypasses RLS). Additive + idempotent.
-- ============================================================================

create table if not exists public.cj_advertisers (
  advertiser_id   text primary key,          -- CJ advertiser (CID) id — matches cj_deals.advertiser_id
  advertiser_name text,
  logo_url        text,                       -- merchant logo (null when the Lookup API exposes none)
  updated_at      timestamptz not null default now()
);

alter table public.cj_advertisers enable row level security;

-- Public read: the anonymous Deals surface joins these logos onto CJ deals at read time, so the
-- browse-freely contract needs select for everyone. No insert/update/delete policy — writes are
-- service-role only (the syncCjLogos job), which bypasses RLS.
drop policy if exists cj_advertisers_public_read on public.cj_advertisers;
create policy cj_advertisers_public_read on public.cj_advertisers
  for select
  using (true);

-- ============================================================================
-- Roam — 0101_search_indexes_plans_deals.sql
-- Extends the site-wide search (search.global) to plans + deals: trigram indexes
-- on their titles so the new ILIKE '%q%' searches don't sequential-scan (same as
-- 0100 for events/topics/listings). pg_trgm is already installed.
--
-- Plans are member-only under RLS, so plan search only ever returns the caller's
-- own plans — the index just makes that read fast. Deals are public (active,
-- in-window) via awin_deals RLS.
--
-- Additive, index-only, safe on live.
-- ============================================================================

create index if not exists idx_plans_title_trgm
  on plans using gin (title gin_trgm_ops);

create index if not exists idx_awin_deals_title_trgm
  on awin_deals using gin (title gin_trgm_ops);

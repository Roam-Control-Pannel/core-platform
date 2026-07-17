-- ============================================================================
-- Roam — 0100_search_indexes.sql
-- Trigram indexes for the site-wide search (search.global). The global search bar
-- runs an ILIKE '%q%' over the title/name of the newly-searched entities; without a
-- trigram GIN index each of those is a sequential scan. pg_trgm is already installed
-- (used by the profiles + venue-name search); these add the same acceleration for
-- events, Town Hall topics and marketplace listings.
--
-- Additive and safe: index-only, no data or signature change. CREATE INDEX (not
-- CONCURRENTLY) is fine here — the tables are small and this runs in a migration.
-- ============================================================================

create extension if not exists pg_trgm;

create index if not exists idx_events_title_trgm
  on events using gin (title gin_trgm_ops);

create index if not exists idx_town_hall_topics_title_trgm
  on town_hall_topics using gin (title gin_trgm_ops);

create index if not exists idx_market_listings_title_trgm
  on market_listings using gin (title gin_trgm_ops);

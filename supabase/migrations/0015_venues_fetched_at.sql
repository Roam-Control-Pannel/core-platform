-- ============================================================================
-- Roam — 0015_venues_fetched_at.sql
-- Adds the staleness stamp for on-demand Places ingestion (Places API New).
--
-- WHY a new column and not `updated_at`: `updated_at` (trg_venues_updated) tracks
-- the last MODIFICATION. Freshness for the Places cache is about the last FETCH —
-- a re-fetch returning identical content is still "fresh" for cost-skip purposes
-- but would not necessarily change `updated_at`. They are different clocks; the
-- ingest path's "do I already have fresh rows for this category+area?" decision
-- must read fetch time, not modification time. Hence a dedicated column.
--
-- NULL is meaningful: a row with `fetched_at IS NULL` was NOT sourced from a Places
-- fetch (e.g. a future roam-native venue, or a row predating ingestion). The cache
-- freshness check only ever considers source='google_places' rows with a non-null
-- stamp, so native venues are never swept into a Places refresh.
-- ============================================================================

alter table venues
  add column fetched_at timestamptz;

comment on column venues.fetched_at is
  'Last time this row''s content was (re)fetched from its external source '
  '(Places API New). NULL = never fetched / not externally sourced. Drives the '
  'on-demand ingestion freshness check; distinct from updated_at (modification time).';

-- Partial index: the freshness check filters to externally-sourced rows and orders/
-- bounds by fetched_at. Index ONLY the google_places rows — native venues never
-- participate in a Places refresh, so they don't belong in this index.
create index idx_venues_places_fetched
  on venues (fetched_at)
  where source = 'google_places';

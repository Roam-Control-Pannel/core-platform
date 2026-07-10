-- 0079_stadiums_category.sql
--
-- "Stadiums" is now its own top-level Explore group (core taxonomy change). Previously a
-- stadium classified into "Entertainment & Recreation" (shown as "Attractions"), because
-- `stadium` was one of that group's Google Places leaf types. It has now MOVED into the new
-- "Stadiums" group (a venue has exactly one `category`).
--
-- The on-demand ingest self-heals per area — the freshness check is category-scoped, so the
-- first tap of the Stadiums pill in an area does one budgeted Places fetch and the upsert
-- re-writes those venues' category to "Stadiums". This migration makes it INSTANT for venues
-- already stored, so the new pill shows results in already-covered areas without waiting for
-- (and paying for) a re-fetch.
--
-- Reclassify every Places-sourced venue currently under Entertainment & Recreation whose
-- matched leaf types include a stadium/arena type. Also trim `categories` to the Stadiums
-- leaf set, matching what placeToVenueRow would have written had the venue been ingested
-- under the Stadiums pill (keeps the sub-category strip consistent).
--
-- Idempotent: re-running finds nothing left under Entertainment & Recreation with those
-- leaves (they're already "Stadiums"), so it is a safe no-op the second time.

update venues
set
  category   = 'Stadiums',
  categories = array(
    select c from unnest(categories) as c
    where c in ('stadium', 'arena')
  )
where source = 'google_places'
  and category = 'Entertainment & Recreation'
  and categories && array['stadium', 'arena'];

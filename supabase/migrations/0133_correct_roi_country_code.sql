-- ============================================================================
-- 0133_correct_roi_country_code.sql
--
-- Corrects the LOW §A3 finding from the Sep 2026 review: the one-shot backfill in
-- 0128_venue_country_code.sql stamped country_code = 'GB' on every venue inside the GB
-- fallback bounding box (lat 49.8–61.0, lng −8.65–1.8). That box spans the WHOLE island of
-- Ireland, so Republic-of-Ireland border towns pulled in by Northern Ireland discovery were
-- stamped GB — a Letterkenny or Dundalk café's products then price in GBP.
--
-- Why not fix it by coordinates: a lat/lng rectangle cannot separate NI from ROI. The border is
-- jagged and Donegal (ROI) sits north of parts of NI, so any box that catches all of ROI also
-- catches NI, and vice-versa. Instead we use the AUTHORITATIVE signal already stored on the row:
-- Places' formatted address. Google's `formattedAddress` ends in the country it assigned — ROI
-- addresses end in "Ireland", NI/GB addresses end in "UK" / "United Kingdom" — which is exactly
-- the same source (the Places `country` component) that 0128 reads into country_code on ingest.
--
-- This only ACCELERATES a correction that already self-heals: 0128's upsert re-derives
-- country_code from the country component on every refresh (`coalesce(excluded.country_code, …)`),
-- so a mis-stamped venue would fix itself within the 30-day freshness cycle regardless. Setting it
-- now spares that window; and if this UPDATE ever mislabels a row, the next refresh's country
-- component corrects it back (coalesce prefers the fresh value).
--
-- Scope guards: only Places-sourced, UNCLAIMED venues currently stamped 'GB' — never touch a
-- claimed/owner-managed venue (its country is owner/address truth, frozen against Places), and
-- never touch GB-mainland rows (their address ends in "UK", so the predicate skips them). A NULL
-- address simply doesn't match and is left for the refresh path.
--
-- Idempotent; re-running is a no-op once corrected (the rows are no longer 'GB').
-- ============================================================================

update venues
   set country_code = 'IE'
 where country_code = 'GB'
   and source = 'google_places'
   and owner_id is null
   and address ~* 'ireland\s*$'                 -- Places country suffix says Ireland…
   and address !~* 'northern\s+ireland\s*$';    -- …but not Northern Ireland (which is GB)

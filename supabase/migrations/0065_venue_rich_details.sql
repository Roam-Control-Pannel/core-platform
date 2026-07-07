-- 0065_venue_rich_details.sql — richer per-venue facts from Google Places (New).
--
-- Adds the Place Details enrichment fields to venues:
--   phone        — nationalPhoneNumber (display + tel: link)
--   website_url  — websiteUri
--   price_range  — normalized {start, end, currency} from Places priceRange
--   attributes   — one jsonb bag of the Atmosphere facts: service options (takeout/delivery/
--                  dineIn/curbsidePickup/reservable), dining (servesBreakfast…VegetarianFood),
--                  amenities (outdoorSeating, liveMusic, goodForChildren/Groups/WatchingSports,
--                  allowsDogs, restroom, menuForChildren), plus paymentOptions /
--                  parkingOptions / accessibilityOptions sub-objects. Only KNOWN keys are
--                  stored (absent = Google gave no signal), so the UI never shows a false "No".
--
-- No RPC changes: cards (venues_near / venues_in_category_near) deliberately don't carry
-- these; the venue page reads select(*) via venues.byId/bySlug so the columns flow through.
-- Values are written by the details enrichment (scripts/backfill-photos.ts), which only
-- touches UNCLAIMED google_places venues — a claimed venue's row stays owner-controlled.

alter table public.venues
  add column if not exists phone text,
  add column if not exists website_url text,
  add column if not exists price_range jsonb,
  add column if not exists attributes jsonb;

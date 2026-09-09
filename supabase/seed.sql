-- ============================================================================
-- Roam — DEV SEED DATA  (supabase/seed.sql)
--
-- NOT a migration. This populates sample data for LOCAL DEVELOPMENT only. It is
-- applied on `supabase db reset` (which re-runs migrations then this file) or by
-- pasting into the dashboard SQL editor. It must NEVER run against production —
-- structure lives in migrations/ (which run everywhere); sample venues do not.
--
-- All seed venues are UNCLAIMED (owner_id NULL, status 'unclaimed'). We deliberately
-- do NOT fake ownership: owner_id is a real FK to profiles(id), and inventing owners
-- would corrupt the data model. The unclaimed state is the global-launch median
-- experience anyway — the one that must be excellent — so seeding it richly is exactly
-- what we want to see and polish. Claimed venues come into existence the honest way:
-- a real user claiming one through the claim procedure.
--
-- Data richness is varied on purpose: some venues carry full detail (rating, multiple
-- categories, description, address) to exercise a populated card; others are sparse
-- (name + locality + "from public sources") to exercise the true median unclaimed card.
--
-- geo is geography(Point, 4326): ST_SetSRID(ST_MakePoint(LNG, LAT), 4326). Note the
-- order — MakePoint takes (longitude, latitude). Coordinates are real Belfast, NI area
-- points, clustered around the city centre. Local dev has no CDN geo-IP headers, so the
-- IP default can't resolve and Explore falls back to DEFAULT_PLACE (Belfast) — seeding
-- here means a fresh `db reset` lands on a populated near→far list, and the PostGIS
-- near→far RPC has sensible geography to sort.
-- ============================================================================

-- Idempotent: clear only the seeded rows (by source tag) so re-running db reset or
-- re-applying doesn't duplicate. Real/claimed venues (different source) are untouched.
delete from venues where source = 'roam-dev-seed';

insert into venues
  (name, geo, locality, region, country_code, category, categories, rating, rating_count,
   description, address, status, source, source_attribution)
values
  -- Richer unclaimed venues (populated-card presentation) --------------------
  ('The Linen Quarter Kitchen', ST_SetSRID(ST_MakePoint(-5.9312, 54.5940), 4326), 'Belfast', 'County Antrim', 'GB',
   'Restaurant', array['Restaurant','British'], 4.6, 128,
   'A long-standing local restaurant known for seasonal British plates.',
   'Bedford Street, Belfast BT2', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Sunflower Coffee House', ST_SetSRID(ST_MakePoint(-5.9268, 54.6006), 4326), 'Belfast', 'County Antrim', 'GB',
   'Café', array['Café','Coffee','Brunch'], 4.4, 86,
   'Independent coffee house with all-day brunch.',
   'Hill Street, Belfast BT1', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('The Dockside Tavern', ST_SetSRID(ST_MakePoint(-5.9279, 54.6010), 4326), 'Belfast', 'County Antrim', 'GB',
   'Pub', array['Pub','Real Ale'], 4.5, 203,
   'Traditional pub near the Cathedral Quarter with a rotating cask selection.',
   'Commercial Court, Belfast BT1', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Ropewalk Wine Bar', ST_SetSRID(ST_MakePoint(-5.9270, 54.6016), 4326), 'Belfast', 'County Antrim', 'GB',
   'Bar', array['Bar','Wine','Tapas'], 4.7, 54,
   'Wine bar and small plates just off the square.',
   'St Anne''s Square, Belfast BT1', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Botanic Bakehouse', ST_SetSRID(ST_MakePoint(-5.9333, 54.5893), 4326), 'Belfast', 'County Antrim', 'GB',
   'Bakery', array['Bakery','Café'], 4.3, 71,
   'Sourdough, pastries and lunch counter.',
   'Botanic Avenue, Belfast BT7', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('The Gasworks Bar', ST_SetSRID(ST_MakePoint(-5.9250, 54.5905), 4326), 'Belfast', 'County Antrim', 'GB',
   'Bar', array['Bar','Real Ale'], 4.6, 167,
   'Long bar and brewery tap known for cask and craft.',
   'Ormeau Road, Belfast BT7', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  -- Sparse unclaimed venues (true median card — name, locality, little else) --
  ('Cathedral Espresso', ST_SetSRID(ST_MakePoint(-5.9258, 54.6001), 4326), 'Belfast', 'County Antrim', 'GB',
   'Café', array['Café'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('The Entries Bar', ST_SetSRID(ST_MakePoint(-5.9280, 54.5995), 4326), 'Belfast', 'County Antrim', 'GB',
   'Bar', array['Bar'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Victoria Street Slice', ST_SetSRID(ST_MakePoint(-5.9245, 54.5978), 4326), 'Belfast', 'County Antrim', 'GB',
   'Restaurant', array['Restaurant','Pizza','Takeaway'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Malone Tea Rooms', ST_SetSRID(ST_MakePoint(-5.9360, 54.5835), 4326), 'Belfast', 'County Antrim', 'GB',
   'Café', array['Café','Tea Room'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('The Shankill Tap', ST_SetSRID(ST_MakePoint(-5.9560, 54.6015), 4326), 'Belfast', 'County Antrim', 'GB',
   'Pub', array['Pub'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  -- A neighbouring-town venue so the data isn't all one locality ------------
  ('Bangor Marina Kitchen', ST_SetSRID(ST_MakePoint(-5.6685, 54.6620), 4326), 'Bangor', 'County Down', 'GB',
   'Restaurant', array['Restaurant','British'], 4.2, 39,
   'Seafront dining a short drive from Belfast.',
   'Quay Street, Bangor BT20', 'unclaimed', 'roam-dev-seed', 'From public sources');

-- Sanity check after seeding (visible when run via psql / SQL editor):
-- select count(*) as seeded, count(rating) as with_rating from venues where source = 'roam-dev-seed';

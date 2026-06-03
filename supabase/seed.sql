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
-- order — MakePoint takes (longitude, latitude). Coordinates are real Darlington, UK
-- area points so the eventual PostGIS near→far RPC has sensible geography to sort.
-- ============================================================================

-- Idempotent: clear only the seeded rows (by source tag) so re-running db reset or
-- re-applying doesn't duplicate. Real/claimed venues (different source) are untouched.
delete from venues where source = 'roam-dev-seed';

insert into venues
  (name, geo, locality, region, country_code, category, categories, rating, rating_count,
   description, address, status, source, source_attribution)
values
  -- Richer unclaimed venues (populated-card presentation) --------------------
  ('The Orangery', ST_SetSRID(ST_MakePoint(-1.5536, 54.5253), 4326), 'Darlington', 'County Durham', 'GB',
   'Restaurant', array['Restaurant','British'], 4.6, 128,
   'A long-standing local restaurant known for seasonal British plates.',
   'Houndgate, Darlington DL1', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Voodoo Café', ST_SetSRID(ST_MakePoint(-1.5521, 54.5241), 4326), 'Darlington', 'County Durham', 'GB',
   'Café', array['Café','Coffee','Brunch'], 4.4, 86,
   'Independent coffee house with all-day brunch.',
   'Skinnergate, Darlington DL3', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('The Quaker House', ST_SetSRID(ST_MakePoint(-1.5559, 54.5268), 4326), 'Darlington', 'County Durham', 'GB',
   'Pub', array['Pub','Real Ale'], 4.5, 203,
   'Traditional pub near the town centre with a rotating cask selection.',
   'Mechanics Yard, Darlington DL3', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Bin Forty Two', ST_SetSRID(ST_MakePoint(-1.5502, 54.5237), 4326), 'Darlington', 'County Durham', 'GB',
   'Bar', array['Bar','Wine','Tapas'], 4.7, 54,
   'Wine bar and small plates on the edge of the market quarter.',
   'Coniscliffe Road, Darlington DL3', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Darlington Bakehouse', ST_SetSRID(ST_MakePoint(-1.5548, 54.5249), 4326), 'Darlington', 'County Durham', 'GB',
   'Bakery', array['Bakery','Café'], 4.3, 71,
   'Sourdough, pastries and lunch counter.',
   'Bondgate, Darlington DL3', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Number Twenty 2', ST_SetSRID(ST_MakePoint(-1.5515, 54.5232), 4326), 'Darlington', 'County Durham', 'GB',
   'Bar', array['Bar','Real Ale'], 4.6, 167,
   'Long bar and brewery tap known for cask and craft.',
   'Coniscliffe Road, Darlington DL3', 'unclaimed', 'roam-dev-seed', 'From public sources'),

  -- Sparse unclaimed venues (true median card — name, locality, little else) --
  ('Clervaux Café', ST_SetSRID(ST_MakePoint(-1.5571, 54.5260), 4326), 'Darlington', 'County Durham', 'GB',
   'Café', array['Café'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('The Hippodrome Bar', ST_SetSRID(ST_MakePoint(-1.5528, 54.5276), 4326), 'Darlington', 'County Durham', 'GB',
   'Bar', array['Bar'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Pennine Pizza', ST_SetSRID(ST_MakePoint(-1.5490, 54.5224), 4326), 'Darlington', 'County Durham', 'GB',
   'Restaurant', array['Restaurant','Pizza','Takeaway'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('Greenbank Tea Rooms', ST_SetSRID(ST_MakePoint(-1.5583, 54.5291), 4326), 'Darlington', 'County Durham', 'GB',
   'Café', array['Café','Tea Room'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  ('The Forge Tap', ST_SetSRID(ST_MakePoint(-1.5461, 54.5212), 4326), 'Darlington', 'County Durham', 'GB',
   'Pub', array['Pub'], null, 0,
   null, null, 'unclaimed', 'roam-dev-seed', 'From public sources'),

  -- A neighbouring-town venue so the data isn't all one locality ------------
  ('Stockton Riverside Kitchen', ST_SetSRID(ST_MakePoint(-1.3110, 54.5705), 4326), 'Stockton-on-Tees', 'County Durham', 'GB',
   'Restaurant', array['Restaurant','British'], 4.2, 39,
   'Riverside dining a short drive from Darlington.',
   'High Street, Stockton-on-Tees TS18', 'unclaimed', 'roam-dev-seed', 'From public sources');

-- Sanity check after seeding (visible when run via psql / SQL editor):
-- select count(*) as seeded, count(rating) as with_rating from venues where source = 'roam-dev-seed';

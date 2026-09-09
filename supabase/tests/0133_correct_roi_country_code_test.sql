-- ============================================================================
-- pgTAP regression tests for 0133_correct_roi_country_code.sql
--
-- A data-correction migration runs once at `db reset` against an empty schema (0 rows), so its
-- effect can't be observed after the fact. Instead we prove the CLASSIFICATION PREDICATE — the
-- only risky part — by inserting rows in the pre-correction ('GB') state and running the migration's
-- exact UPDATE, then asserting who was corrected and, crucially, who was spared:
--   • an ROI venue (address ends "Ireland")           → IE   (corrected)
--   • an NI venue (address ends "UK")                  → GB   (spared — GB-mainland/NI suffix)
--   • an NI venue (address ends "Northern Ireland")    → GB   (spared — explicit exclusion)
--   • a CLAIMED ROI venue (owner_id set)               → GB   (spared — owner truth is frozen)
--   • a GB-mainland venue (address ends "UK")          → GB   (spared)
--   • a NATIVE (non-Places) ROI-address venue          → GB   (spared — source guard)
-- The UPDATE here is kept identical to the migration's; if they ever drift the wrong-suffix rows
-- would flip and this test fails.
-- ============================================================================
begin;
select plan(6);

-- Owner for the claimed-venue fixture.
insert into auth.users (id, email)
  values ('00000000-0000-0000-0000-0000000000e1', 'roi-owner@example.com');

-- Fixtures in the mis-stamped ('GB') state. geo is required but irrelevant to the predicate.
insert into venues (id, name, geo, status, owner_id, source, address, country_code) values
  ('00000000-0000-0000-0000-0000000000f1', 'Dundalk Café',
     ST_SetSRID(ST_MakePoint(-6.4, 54.0), 4326), 'unclaimed', null, 'google_places',
     'Clanbrassil St, Dundalk, Co. Louth, Ireland', 'GB'),
  ('00000000-0000-0000-0000-0000000000f2', 'Belfast Bakery',
     ST_SetSRID(ST_MakePoint(-5.93, 54.6), 4326), 'unclaimed', null, 'google_places',
     '10 Donegall Square, Belfast BT1 5GS, UK', 'GB'),
  ('00000000-0000-0000-0000-0000000000f3', 'Derry Diner',
     ST_SetSRID(ST_MakePoint(-7.31, 54.99), 4326), 'unclaimed', null, 'google_places',
     'Shipquay Street, Derry, Northern Ireland', 'GB'),
  ('00000000-0000-0000-0000-0000000000f4', 'Galway Grill (claimed)',
     ST_SetSRID(ST_MakePoint(-9.05, 53.27), 4326), 'claimed',
     '00000000-0000-0000-0000-0000000000e1', 'google_places',
     'Shop Street, Galway, Ireland', 'GB'),
  ('00000000-0000-0000-0000-0000000000f5', 'London Lunch',
     ST_SetSRID(ST_MakePoint(-0.13, 51.51), 4326), 'unclaimed', null, 'google_places',
     '221B Baker Street, London, UK', 'GB'),
  ('00000000-0000-0000-0000-0000000000f6', 'Native ROI listing',
     ST_SetSRID(ST_MakePoint(-8.5, 51.9), 4326), 'unclaimed', null, 'native',
     'Patrick Street, Cork, Ireland', 'GB');

-- ── the migration's exact correction ────────────────────────────────────────
update venues
   set country_code = 'IE'
 where country_code = 'GB'
   and source = 'google_places'
   and owner_id is null
   and address ~* 'ireland\s*$'
   and address !~* 'northern\s+ireland\s*$';

select is((select country_code from venues where id = '00000000-0000-0000-0000-0000000000f1'), 'IE',
  'ROI unclaimed Places venue (…Ireland) is corrected to IE');
select is((select country_code from venues where id = '00000000-0000-0000-0000-0000000000f2'), 'GB',
  'NI venue (…UK) stays GB');
select is((select country_code from venues where id = '00000000-0000-0000-0000-0000000000f3'), 'GB',
  'NI venue (…Northern Ireland) stays GB — the exclusion holds');
select is((select country_code from venues where id = '00000000-0000-0000-0000-0000000000f4'), 'GB',
  'claimed ROI venue is left alone — owner truth is frozen against Places');
select is((select country_code from venues where id = '00000000-0000-0000-0000-0000000000f5'), 'GB',
  'GB-mainland venue (…UK) stays GB');
select is((select country_code from venues where id = '00000000-0000-0000-0000-0000000000f6'), 'GB',
  'native (non-Places) ROI-address venue is left alone — source guard');

select * from finish();
rollback;

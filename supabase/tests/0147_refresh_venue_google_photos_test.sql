-- ============================================================================
-- pgTAP regression tests for 0147_refresh_venue_google_photos.sql
--
-- The load-bearing property: refreshing EXPIRED Google photo refs obeys the owner-content
-- policy exactly —
--   1. unclaimed                        → replace-all google_places rows
--   2. claimed, no owner uploads        → replace-all its EXISTING google rows; a claimed venue
--                                         with NO google rows gains NONE (never-add)
--   3. any venue with owner_upload rows → untouched (owner library canonical; stale rows kept)
-- — stamps google_photos_refreshed_at only on a real refresh, clears rows for an eligible venue
-- Google now returns no photos for (replace-all), and is EXECUTE-revoked from client roles.
-- Plus list_google_photo_venues: never-refreshed first, owner-library + photoless venues never
-- listed, p_venue_id targets one venue.
--
-- Fixtures: one owner + six venues, one per policy branch (+F: never refreshed, not in the
-- payload). Refs are unique table-wide (venue_photos_places_ref unique index), so every ref
-- string here is distinct.
-- ============================================================================
begin;
select plan(25);

-- ── structural ───────────────────────────────────────────────────────────────
select has_column('public', 'venues', 'google_photos_refreshed_at',
  'venues.google_photos_refreshed_at exists (self-heal negative cache / refresh ordering key)');
select has_function('public', 'refresh_venue_google_photos', array['jsonb'],
  'refresh_venue_google_photos(jsonb) exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.refresh_venue_google_photos(jsonb)'::regprocedure),
  true, 'refresh_venue_google_photos is SECURITY DEFINER (service-side, like upsert_venue_photos)');

-- ── fixtures (as the test/owner role: bypasses RLS) ───────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e70b', 'owner@refresh.example');

insert into venues (id, name, geo, status, owner_id, categories) values
  -- A: unclaimed, two stale Google rows                      → rule 1: replace-all
  ('00000000-0000-0000-0000-00000000e7a1', 'Refresh A (unclaimed)',
   ST_SetSRID(ST_MakePoint(-5.9300, 54.6000), 4326), 'unclaimed', null, array['cafe']),
  -- B: claimed, one stale Google row, NO owner uploads        → rule 2: replace existing
  ('00000000-0000-0000-0000-00000000e7b2', 'Refresh B (claimed, google only)',
   ST_SetSRID(ST_MakePoint(-5.9310, 54.6010), 4326), 'claimed',
   '00000000-0000-0000-0000-00000000e70b', array['cafe']),
  -- C: claimed, NO Google rows at all                         → rule 2 never-add: gains none
  ('00000000-0000-0000-0000-00000000e7c3', 'Refresh C (claimed, no photos)',
   ST_SetSRID(ST_MakePoint(-5.9320, 54.6020), 4326), 'claimed',
   '00000000-0000-0000-0000-00000000e70b', array['cafe']),
  -- D: claimed, one stale Google row AND an owner upload      → rule 3: untouched
  ('00000000-0000-0000-0000-00000000e7d4', 'Refresh D (claimed, owner library)',
   ST_SetSRID(ST_MakePoint(-5.9330, 54.6030), 4326), 'claimed',
   '00000000-0000-0000-0000-00000000e70b', array['cafe']),
  -- E: unclaimed, one stale Google row; Google now returns [] → replace-all clears it
  ('00000000-0000-0000-0000-00000000e7e5', 'Refresh E (unclaimed, now photoless)',
   ST_SetSRID(ST_MakePoint(-5.9340, 54.6040), 4326), 'unclaimed', null, array['cafe']),
  -- F: unclaimed, one Google row, NOT in the payload → never refreshed → lists FIRST
  ('00000000-0000-0000-0000-00000000e7f6', 'Refresh F (never refreshed)',
   ST_SetSRID(ST_MakePoint(-5.9350, 54.6050), 4326), 'unclaimed', null, array['cafe']);
-- list_google_photo_venues requires a Google-sourced venue with a place id.
update venues set source = 'google_places', source_ref = 'ChIJ_refresh_' || right(id::text, 4)
where id in ('00000000-0000-0000-0000-00000000e7a1', '00000000-0000-0000-0000-00000000e7b2',
             '00000000-0000-0000-0000-00000000e7c3', '00000000-0000-0000-0000-00000000e7d4',
             '00000000-0000-0000-0000-00000000e7e5', '00000000-0000-0000-0000-00000000e7f6');

insert into venue_photos (venue_id, source, position, places_photo_ref) values
  ('00000000-0000-0000-0000-00000000e7a1', 'google_places', 0, 'places/a/photos/old-a1'),
  ('00000000-0000-0000-0000-00000000e7a1', 'google_places', 1, 'places/a/photos/old-a2'),
  ('00000000-0000-0000-0000-00000000e7b2', 'google_places', 0, 'places/b/photos/old-b1'),
  ('00000000-0000-0000-0000-00000000e7d4', 'google_places', 0, 'places/d/photos/old-d1'),
  ('00000000-0000-0000-0000-00000000e7e5', 'google_places', 0, 'places/e/photos/old-e1'),
  ('00000000-0000-0000-0000-00000000e7f6', 'google_places', 0, 'places/f/photos/old-f1');
insert into venue_photos (venue_id, source, position, storage_path) values
  ('00000000-0000-0000-0000-00000000e7d4', 'owner_upload', 0, 'venues/e7d4/owner.jpg');

-- ── the refresh: one call, every branch at once ───────────────────────────────
-- Inserted = A (2) + B (1); C gains none, D is untouched, E is cleared → 3.
select is(
  refresh_venue_google_photos('[
    {"venue_id":"00000000-0000-0000-0000-00000000e7a1","photos":[
      {"places_photo_ref":"places/a/photos/new-a1","position":0,"width":4032,"height":3024,
       "attribution":[{"displayName":"Jane D","uri":"https://maps.google.com/jane"}]},
      {"places_photo_ref":"places/a/photos/new-a2","position":1}]},
    {"venue_id":"00000000-0000-0000-0000-00000000e7b2","photos":[
      {"places_photo_ref":"places/b/photos/new-b1","position":0}]},
    {"venue_id":"00000000-0000-0000-0000-00000000e7c3","photos":[
      {"places_photo_ref":"places/c/photos/new-c1","position":0}]},
    {"venue_id":"00000000-0000-0000-0000-00000000e7d4","photos":[
      {"places_photo_ref":"places/d/photos/new-d1","position":0}]},
    {"venue_id":"00000000-0000-0000-0000-00000000e7e5","photos":[]}
  ]'::jsonb),
  3, 'returns the number of google_places rows inserted (A:2 + B:1)');

-- ── rule 1: unclaimed A is replaced wholesale ────────────────────────────────
select is((select count(*) from venue_photos
           where venue_id = '00000000-0000-0000-0000-00000000e7a1' and source = 'google_places')::int,
  2, 'A: holds exactly the fresh set (2 rows)');
select is((select count(*) from venue_photos
           where places_photo_ref in ('places/a/photos/old-a1','places/a/photos/old-a2'))::int,
  0, 'A: every stale ref is gone');
select is((select count(*) from venue_photos
           where places_photo_ref in ('places/a/photos/new-a1','places/a/photos/new-a2'))::int,
  2, 'A: both fresh refs are present');
select isnt((select google_photos_refreshed_at from venues where id = '00000000-0000-0000-0000-00000000e7a1'),
  null, 'A: google_photos_refreshed_at stamped');

-- ── rule 2: claimed B (google rows, no owner uploads) has its EXISTING rows refreshed ──
select is((select count(*) from venue_photos
           where venue_id = '00000000-0000-0000-0000-00000000e7b2' and source = 'google_places')::int,
  1, 'B: still exactly one Google row');
select is((select places_photo_ref from venue_photos
           where venue_id = '00000000-0000-0000-0000-00000000e7b2' and source = 'google_places'),
  'places/b/photos/new-b1', 'B: the stale ref was replaced by the fresh one (claimed venue gets its images back)');
select isnt((select google_photos_refreshed_at from venues where id = '00000000-0000-0000-0000-00000000e7b2'),
  null, 'B: google_photos_refreshed_at stamped');

-- ── rule 2 never-add: claimed C had no Google rows and gains none ─────────────
select is((select count(*) from venue_photos
           where venue_id = '00000000-0000-0000-0000-00000000e7c3')::int,
  0, 'C: a claimed venue with no Google photos is never given any');
select is((select google_photos_refreshed_at from venues where id = '00000000-0000-0000-0000-00000000e7c3'),
  null, 'C: not stamped — nothing was refreshed');

-- ── rule 3: D (owner library) is untouched in every way ──────────────────────
select is((select count(*) from venue_photos
           where venue_id = '00000000-0000-0000-0000-00000000e7d4'
             and source = 'google_places' and places_photo_ref = 'places/d/photos/old-d1')::int,
  1, 'D: its stale Google row is left exactly as it was (not refreshed, not deleted)');
select is((select count(*) from venue_photos
           where venue_id = '00000000-0000-0000-0000-00000000e7d4' and source = 'owner_upload')::int,
  1, 'D: the owner upload is untouched');
select is((select google_photos_refreshed_at from venues where id = '00000000-0000-0000-0000-00000000e7d4'),
  null, 'D: not stamped — an owner library is canonical');

-- ── replace-all: eligible E with an empty fresh set is cleared ───────────────
select is((select count(*) from venue_photos
           where venue_id = '00000000-0000-0000-0000-00000000e7e5')::int,
  0, 'E: an eligible venue Google now returns no photos for has its stale rows cleared');
select isnt((select google_photos_refreshed_at from venues where id = '00000000-0000-0000-0000-00000000e7e5'),
  null, 'E: stamped — the refresh ran (to an empty set)');

-- ── list_google_photo_venues: the runner / cron target list ─────────────────
select has_function('public', 'list_google_photo_venues', array['integer','uuid'],
  'list_google_photo_venues(integer, uuid) exists');
create temp table _lv as
  select id, row_number() over () as rn from list_google_photo_venues(5000);
select ok(
  (select rn from _lv where id = '00000000-0000-0000-0000-00000000e7f6')
    < (select rn from _lv where id = '00000000-0000-0000-0000-00000000e7a1'),
  'F (never refreshed) lists before A (just refreshed) — stalest first');
select is((select count(*) from list_google_photo_venues(5000, '00000000-0000-0000-0000-00000000e7d4'))::int,
  0, 'D (owner library) is never listed — no Place Details call is ever spent on it');
select is((select count(*) from list_google_photo_venues(5000, '00000000-0000-0000-0000-00000000e7c3'))::int,
  0, 'C (no Google rows) is not listed — nothing to refresh');
select is((select count(*) from list_google_photo_venues(5000, '00000000-0000-0000-0000-00000000e7b2'))::int,
  1, 'p_venue_id targets exactly one venue (claimed B with Google rows is refreshable)');

-- ── guards ────────────────────────────────────────────────────────────────────
select throws_ok(
  $$ select refresh_venue_google_photos('{"venue_id":"x"}'::jsonb) $$,
  '22023', null,
  'a non-array payload is rejected (22023)');

create temp table _rp (k text primary key, v boolean);
do $$
declare
  anon_denied boolean := false;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  begin
    perform refresh_venue_google_photos('[]'::jsonb);
  exception when others then anon_denied := true; end;
  perform set_config('role', 'postgres', true);
  insert into _rp values ('anon_denied', anon_denied);
end $$;
select ok((select v from _rp where k = 'anon_denied'),
  'refresh_venue_google_photos EXECUTE is revoked from client roles (anon cannot call it)');

select * from finish();
rollback;

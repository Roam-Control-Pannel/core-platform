-- ============================================================================
-- pgTAP regression tests for 0146_f2g_expand_categories.sql (added by holistic plan Phase 1.6 —
-- this was the one channels-era migration with no test).
--
-- Load-bearing property: the open-mode storefront query's eligible-leaf array includes the cuisine
-- TAKEAWAY leaves (a Chinese takeaway shows) but NOT the broad `restaurant` leaf or drink-led
-- leaves (a sit-down restaurant and a pub do not), and it works for the public (anon) caller. The
-- array must mirror @roam/core/f2g FOOD_TO_GO_TYPES; if someone widens one side only, this test
-- and the core unit test disagree, which is the point.
-- ============================================================================
begin;
select plan(5);

select has_function('public', 'venues_food_to_go_near',
  array['double precision','double precision','integer','integer','uuid'],
  'venues_food_to_go_near keeps the 0145 five-arg signature');

-- ── fixtures near the Belfast origin (54.5973, -5.9301) ─────────────────────
insert into venues (id, name, geo, status, owner_id, categories) values
  ('00000000-0000-0000-0000-0000000e4601', 'Golden Wok (chinese_restaurant)',
   ST_SetSRID(ST_MakePoint(-5.9305, 54.5975), 4326), 'unclaimed', null, array['chinese_restaurant']),
  ('00000000-0000-0000-0000-0000000e4602', 'Kebab Corner (middle_eastern_restaurant)',
   ST_SetSRID(ST_MakePoint(-5.9310, 54.5978), 4326), 'unclaimed', null, array['middle_eastern_restaurant']),
  ('00000000-0000-0000-0000-0000000e4603', 'White Tablecloth (restaurant only)',
   ST_SetSRID(ST_MakePoint(-5.9315, 54.5980), 4326), 'unclaimed', null, array['restaurant']),
  ('00000000-0000-0000-0000-0000000e4604', 'The Crown (pub only)',
   ST_SetSRID(ST_MakePoint(-5.9320, 54.5982), 4326), 'unclaimed', null, array['pub','bar']);

create temp table _e (k text primary key, v boolean);
do $$
declare
  chinese boolean; kebab boolean; sitdown boolean; pub boolean;
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  select
    bool_or(id = '00000000-0000-0000-0000-0000000e4601'),
    bool_or(id = '00000000-0000-0000-0000-0000000e4602'),
    bool_or(id = '00000000-0000-0000-0000-0000000e4603'),
    bool_or(id = '00000000-0000-0000-0000-0000000e4604')
    into chinese, kebab, sitdown, pub
  from venues_food_to_go_near(54.5973, -5.9301, 100, 0, null);
  perform set_config('role', 'postgres', true);
  insert into _e values ('chinese', coalesce(chinese, false)), ('kebab', coalesce(kebab, false)),
                        ('sitdown', coalesce(sitdown, false)), ('pub', coalesce(pub, false));
end $$;

select ok((select v from _e where k = 'chinese'), 'a chinese_restaurant leaf is food-to-go eligible (0146)');
select ok((select v from _e where k = 'kebab'),   'a middle_eastern_restaurant leaf is food-to-go eligible (0146)');
select ok(not (select v from _e where k = 'sitdown'), 'the broad restaurant leaf alone is NOT eligible');
select ok(not (select v from _e where k = 'pub'),     'drink-led leaves (pub/bar) are NOT eligible');

select * from finish();
rollback;

-- ============================================================================
-- pgTAP regression tests for 0145_f2g_member_priority_ranking.sql
--
-- The load-bearing property: open mode floats a CONFIRMED F2G MEMBER above a claimed non-member above
-- an unclaimed venue — nearest-first only WITHIN a tier — and it does so for the PUBLIC (anon) caller,
-- which means the SECURITY DEFINER member helper must pierce the RLS-locked roster (a plain EXISTS as
-- anon would see zero rows). We prove it structurally (the helper is definer; the superseded 5-arg
-- function exists) and behaviourally: a member ranks first despite being FARTHEST, is_member is set
-- correctly, and passing NO channel id collapses to the pre-D3 claimed-first ordering.
--
-- Fixtures sit near a Belfast origin (54.5973, -5.9301). Ranks are asserted RELATIVELY (A<B<C), so any
-- other seed venue near Belfast cannot break the tier ordering being tested.
-- ============================================================================
begin;
select plan(7);

-- ── structural ───────────────────────────────────────────────────────────────
select has_function('public', 'f2g_member_venue_ids', array['uuid'],
  'f2g_member_venue_ids(uuid) exists');
select is(
  (select prosecdef from pg_proc where oid = 'public.f2g_member_venue_ids(uuid)'::regprocedure),
  true, 'f2g_member_venue_ids is SECURITY DEFINER (so it can read the RLS-locked roster)');
select has_function('public', 'venues_food_to_go_near',
  array['double precision','double precision','integer','integer','uuid'],
  'venues_food_to_go_near now takes a trailing filter_channel_id uuid');

-- ── fixtures (as the test/owner role: bypasses RLS + the roster guard) ─────────
-- One real user to own the claimed non-member (profile auto-provisioned by trg_auth_user_created).
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000da0b', 'owner-b@rank.example');

-- Three NI food-to-go venues near the Belfast origin, at INCREASING distance C < B < A, so that a
-- distance-only order would be C, B, A — the opposite of the tier order we expect.
--   A = confirmed member, UNCLAIMED, FARTHEST  (must still rank first)
--   B = claimed non-member, MIDDLE
--   C = unclaimed non-member, CLOSEST
insert into venues (id, name, geo, status, owner_id, categories) values
  ('00000000-0000-0000-0000-00000000da01', 'Member Cafe (far)',
   ST_SetSRID(ST_MakePoint(-5.9300, 54.6300), 4326), 'unclaimed', null, array['cafe']),
  ('00000000-0000-0000-0000-00000000da02', 'Claimed Cafe (mid)',
   ST_SetSRID(ST_MakePoint(-5.9300, 54.6100), 4326), 'claimed',
   '00000000-0000-0000-0000-00000000da0b', array['cafe']),
  ('00000000-0000-0000-0000-00000000da03', 'Unclaimed Cafe (near)',
   ST_SetSRID(ST_MakePoint(-5.9301, 54.5973), 4326), 'unclaimed', null, array['cafe']);

-- A is a confirmed member via the ROSTER (channel_members, status 'live', matched to venue A). This is
-- the harder RLS path: channel_members is deny-by-omission, so only the definer helper can see it.
insert into channel_members (id, channel_id, source_name, membership_ref, venue_id, status)
select '00000000-0000-0000-0000-00000000da0a', c.id, 'Member Cafe', 'RANK-A01',
       '00000000-0000-0000-0000-00000000da01', 'live'
from channels c where c.key = 'f2g';

-- ── behavioural (as anon, the public caller) ──────────────────────────────────
create temp table _r (k text primary key, v text);
do $$
declare
  chan uuid;
  a_rank int; b_rank int; c_rank int;
  a_member boolean; b_member boolean;
  a_rank_null int; b_rank_null int;
begin
  select id into chan from channels where key = 'f2g';
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  -- WITH the channel: member tier active. row_number() over the function's own ordered output.
  with r as (
    select id, is_member, row_number() over () rn
    from venues_food_to_go_near(54.5973, -5.9301, 50, 0, chan)
  )
  select
    max(rn) filter (where id = '00000000-0000-0000-0000-00000000da01'),
    max(rn) filter (where id = '00000000-0000-0000-0000-00000000da02'),
    max(rn) filter (where id = '00000000-0000-0000-0000-00000000da03'),
    bool_or(is_member) filter (where id = '00000000-0000-0000-0000-00000000da01'),
    bool_or(is_member) filter (where id = '00000000-0000-0000-0000-00000000da02')
  into a_rank, b_rank, c_rank, a_member, b_member
  from r;

  -- WITHOUT a channel: the member tier is off → claimed-first/nearest (the pre-D3 ordering).
  with r as (
    select id, row_number() over () rn
    from venues_food_to_go_near(54.5973, -5.9301, 50, 0, null)
  )
  select
    max(rn) filter (where id = '00000000-0000-0000-0000-00000000da01'),
    max(rn) filter (where id = '00000000-0000-0000-0000-00000000da02')
  into a_rank_null, b_rank_null
  from r;

  perform set_config('role', 'postgres', true);
  insert into _r values
    ('member_first',       (a_rank < b_rank and b_rank < c_rank)::text),
    ('a_member',           a_member::text),
    ('b_member',           coalesce(b_member, false)::text),
    ('null_claimed_first', (b_rank_null < a_rank_null)::text);
end $$;

select is((select v from _r where k = 'member_first'), 'true',
  'a confirmed member (farthest) outranks a claimed non-member, which outranks an unclaimed venue');
select is((select v from _r where k = 'a_member'), 'true',
  'the roster member is flagged is_member=true for the public caller (definer helper pierces RLS)');
select is((select v from _r where k = 'b_member'), 'false',
  'a claimed non-member is is_member=false');
select is((select v from _r where k = 'null_claimed_first'), 'true',
  'passing no channel id collapses to claimed-first — the member tier is off (backward compatible)');

select * from finish();
rollback;

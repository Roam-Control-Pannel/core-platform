-- f2g-sweep-cover.sql — derive the NEXT Food to Go sweep points from the FSA register, not from memory.
--
-- The storefront's open-mode ingest pulls venues in a 2.5 km disk around a point
-- (scripts/reingest-food-to-go.mjs). The FSA hygiene-rating register (fsa_establishments, synced
-- nightly by sync-fsa-ni) geocodes every NI takeaway and café, so it is the ground truth for where
-- the supply actually is. This script:
--   1. keeps the FSA takeaways/cafés (the food-to-go proxy) with a sane NI geocode;
--   2. marks the ones already inside a disk that has been swept (the `swept` list below);
--   3. greedily picks the business location whose 2.5 km disk reaches the most still-uncovered
--      businesses, marks them covered, and repeats until the next disk would add fewer than 8
--      businesses (or 80 points) — a set-cover heuristic that places several disks across a wide
--      conurbation (Portadown–Lurgan, Newtownabbey) automatically;
--   4. labels each point with the modal FSA address line + postcode district among the businesses
--      it reached, and prints the ordered list with a running paid-call estimate (25 per point).
--
-- Read-only: temp tables only. Runs as ONE script in the Supabase SQL editor (the temp tables live
-- for one run; the editor's "destructive operations / RLS" prompt is its keyword scan reacting to
-- `drop table` / `create table` on the temp tables — choose "Run without RLS"). The editor shows the
-- LAST result set: the point list. For the coverage headline, run the commented query at the end.
--
-- TO RE-DERIVE after a sweep: add every point that has been swept to the `swept` list (Phase 1's 26
-- and Phase 2's 73 are scripts/reingest-food-to-go.mjs TOWNS grid + PHASE2_POINTS) and re-run; the
-- output is whatever is still unreached. Paste the rows into PHASE2_POINTS-style entries — never
-- hand-edit coordinates.
--
-- Provenance of PHASE2_POINTS (2026-09-16): this script with the 26 Phase 1 points as `swept`,
-- against 16,949 NI establishments → 4,846 takeaways/cafés, 2,246 (46.3%) inside Phase 1 disks,
-- 73 points reaching 1,965 (75.6%) of the remaining 2,600.

drop table if exists p2_est;
drop table if exists p2_pick;

create temp table p2_est as
with swept(lat, lng) as (values
  -- Phase 1: Belfast 3×3 grid (3 km step), Derry 3×3 grid (2.5 km step), eight single-point towns.
  (54.57017, -5.97662), (54.57017, -5.9301), (54.57017, -5.88358),
  (54.5973,  -5.97662), (54.5973,  -5.9301), (54.5973,  -5.88358),
  (54.62443, -5.97662), (54.62443, -5.9301), (54.62443, -5.88358),
  (54.97399, -7.34775), (54.97399, -7.3086), (54.97399, -7.26945),
  (54.9966,  -7.34775), (54.9966,  -7.3086), (54.9966,  -7.26945),
  (55.01921, -7.34775), (55.01921, -7.3086), (55.01921, -7.26945),
  (54.5162, -6.0581), (54.1751, -6.3402), (54.6538, -5.6683), (54.8642, -6.2792),
  (55.1333, -6.6681), (54.3503, -6.6528), (54.5977, -7.3097), (54.3446, -7.6316)
  -- After Phase 2 has run, append PHASE2_POINTS here before re-deriving.
)
select
  e.fhrsid,
  e.business_type,
  e.local_authority,
  -- The most specific address line that is a place, not a county (label only).
  (select v
     from unnest(array[e.raw->>'AddressLine4', e.raw->>'AddressLine3', e.raw->>'AddressLine2']) with ordinality as t(v, i)
    where nullif(trim(v), '') is not null
      and upper(regexp_replace(trim(v), '^(CO\.?|COUNTY)\s+', '', 'i'))
          not in ('ANTRIM', 'DOWN', 'ARMAGH', 'TYRONE', 'LONDONDERRY', 'DERRY', 'FERMANAGH',
                  'NORTHERN IRELAND', 'N. IRELAND', 'N IRELAND', 'UK', 'UNITED KINGDOM')
    order by i limit 1) as town_line,
  case when length(e.pc) between 5 and 7 then left(e.pc, length(e.pc) - 3) end as district,
  ST_Transform(ST_SetSRID(ST_MakePoint(e.lng, e.lat), 4326), 29902) as g,   -- Irish Grid, metres
  false as covered
from (select *, upper(regexp_replace(coalesce(postcode, ''), '\s', '', 'g')) as pc from fsa_establishments) e
where e.lat is not null and e.lng is not null
  and e.lat between 54.0 and 55.45 and e.lng between -8.3 and -5.3          -- NI bounds; drops bad geocodes
  and e.business_type in ('Takeaway/sandwich shop', 'Restaurant/Cafe/Canteen')
  and not exists (
    select 1 from swept p
    where ST_DWithin(ST_SetSRID(ST_MakePoint(e.lng, e.lat), 4326)::geography,
                     ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326)::geography, 2500));

create index on p2_est using gist (g);

create temp table p2_pick (
  rank int, fhrsid text, gained int, lat numeric, lng numeric, town text, district text, council text
);

do $$
declare
  r record;
  n int := 0;
begin
  loop
    select c.fhrsid, count(*) as gained
      into r
      from p2_est c
      join p2_est o on ST_DWithin(c.g, o.g, 2500)
     where not c.covered and not o.covered
     group by c.fhrsid
     order by gained desc, c.fhrsid
     limit 1;
    if not found or r.gained < 8 or n >= 80 then exit; end if;
    n := n + 1;
    insert into p2_pick
    select n, c.fhrsid, r.gained,
           round(ST_Y(ST_Transform(c.g, 4326))::numeric, 5),
           round(ST_X(ST_Transform(c.g, 4326))::numeric, 5),
           (select mode() within group (order by o.town_line)       from p2_est o where not o.covered and ST_DWithin(c.g, o.g, 2500)),
           (select mode() within group (order by o.district)        from p2_est o where not o.covered and ST_DWithin(c.g, o.g, 2500)),
           (select mode() within group (order by o.local_authority) from p2_est o where not o.covered and ST_DWithin(c.g, o.g, 2500))
      from p2_est c
     where c.fhrsid = r.fhrsid;
    update p2_est o
       set covered = true
      from p2_est c
     where c.fhrsid = r.fhrsid and not o.covered and ST_DWithin(c.g, o.g, 2500);
  end loop;
end $$;

-- The ordered point list (cum_calls = 25 paid Places calls per point, one per food-to-go type).
select rank, town, district, council, gained,
       sum(gained) over (order by rank) as cum_businesses,
       rank * 25 as cum_calls,
       lat, lng
  from p2_pick
 order by rank;

-- Coverage headline (swap in as the last statement to see it):
-- select count(*)                        as outside_swept,
--        count(*) filter (where covered) as reached_by_these_points,
--        round(100.0 * count(*) filter (where covered) / nullif(count(*), 0), 1) as pct
--   from p2_est;

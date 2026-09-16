# Food to Go supply sweep — runbook

How the NI Food to Go storefront's venue supply is (re)filled across Northern Ireland, what it
costs, and how the sweep points are derived. Tooling: `scripts/reingest-food-to-go.mjs` (the
sweep) and `scripts/f2g-sweep-cover.sql` (how the points are chosen).

## Why a sweep at all

The storefront only auto-ingests when a town has **zero** food-to-go venues near the visitor
(`StorefrontHome`). Widening the taxonomy (migration 0146 added 13 cuisine-takeaway types) or an
already-thin town never re-triggers it, so supply has to be pushed: one `places.ingestFoodToGo`
call per point, ~25 paid Places `searchNearby` calls each (one per food-to-go type), 2.5 km radius.
Upserts are idempotent on `(source, source_ref)`, claimed venues stay frozen, unclaimed venues'
Google photos are refreshed, so re-running a point is safe.

## Budget

`PLACES_DAILY_FETCH_BUDGET` = 2,000 paid calls/day, shared with the storefront's own auto-ingest.
The sweep sends no client-IP header, so only the global budget gates it; a budget denial stops the
run cleanly and the summary says to re-run tomorrow. Plan each batch to leave headroom.

| Batch | Points | Est. calls | What it reaches |
|---|---|---|---|
| Phase 1 (`--phase=1`, default) | 26 | ~650 | 10 curated `NI_PLACES` towns; Belfast + Derry as 3×3 grids |
| Phase 2a (`--phase=2a`) | 40 | ~1,000 | FSA-derived ranks 1–40 (1,606 takeaways/cafés) |
| Phase 2b (`--phase=2b`) | 33 | ~825 | FSA-derived ranks 41–73 (359 takeaways/cafés) |

Run one batch per day.

## Running it

In the Railway `core-platform` (API) service console, from `/app`:

```bash
NEXT_PUBLIC_API_URL=http://127.0.0.1:$PORT node scripts/reingest-food-to-go.mjs --phase=2a --dry-run   # plan + cost, no calls
NEXT_PUBLIC_API_URL=http://127.0.0.1:$PORT setsid nohup node scripts/reingest-food-to-go.mjs --phase=2a > /tmp/reingest.log 2>&1 &
tail -f /tmp/reingest.log
```

Always run it detached: the console drops during silent stretches and takes a foreground process
with it (Phase 1 lost its last six towns that way). One line prints per town/point plus a final
`Done. N venues inserted …` tally. To resume after a drop, re-run with a narrower selection —
`--town=Bangor,Ballymena` (Phase 1) or `--phase=2 --ranks=23-40` / `--phase=2 --town=BT23`
(Phase 2); completed points persist.

`INTERNAL_CALL_SECRET` must be in the environment (it is in the API service). Locally, load the
root `.env` first and point `NEXT_PUBLIC_API_URL` at a running API.

## Where the Phase 2 points come from (no hand-picked coordinates)

`apps/web/src/lib/ni.ts` only knows the ten curated towns, and typing more town centres from memory
is guesswork. Instead the points are derived from the **FSA hygiene-rating register**
(`fsa_establishments`, 16,949 NI rows synced nightly by `sync-fsa-ni`), which geocodes every
takeaway and café. `scripts/f2g-sweep-cover.sql`:

1. keeps FSA `Takeaway/sandwich shop` + `Restaurant/Cafe/Canteen` rows with a sane NI geocode
   (4,846 on 2026-09-16);
2. marks the ones inside any already-swept 2.5 km disk (Phase 1 reached 2,246 = 46.3%);
3. greedily picks the business location whose 2.5 km disk reaches the most still-uncovered
   businesses, marks them covered, repeats until the next disk would add < 8 (or 80 points) —
   so a wide conurbation gets several disks automatically;
4. labels each point with the modal FSA address line and postcode district of what it reached.

Result on 2026-09-16: 73 points reaching 1,965 of the remaining 2,600 (75.6%), which takes the
whole sweep to ~87% of NI's takeaway/café estate. Those rows are `PHASE2_POINTS` in the script,
verbatim (labels included — "Towns Parks" is the register's wording for the Antrim-town BT41 point;
the district is the reliable key).

**To re-derive** after a sweep (to find what is still unreached, or after the nightly FSA sync
changes the register): append the swept points to the query's `swept` list and re-run it in the
Supabase SQL editor as one script (choose "Run without RLS" — the prompt is a keyword scan reacting
to the temp tables). Paste the rows into the script; never hand-edit coordinates.

## Verifying a sweep

Before/after on the storefront's own eligibility, in the SQL editor:

```sql
select count(*) as f2g_eligible_ni_venues,
       count(*) filter (where v.categories && array['american_restaurant','asian_fusion_restaurant','chinese_restaurant',
         'indian_restaurant','italian_restaurant','japanese_restaurant','mexican_restaurant','middle_eastern_restaurant',
         'seafood_restaurant','sushi_restaurant','thai_restaurant','vegan_restaurant','vegetarian_restaurant']::text[]) as cuisine_takeaways
from venues v
where v.geo is not null
  and st_y(v.geo::geometry) between 54.0 and 55.45 and st_x(v.geo::geometry) between -8.3 and -5.3
  and v.categories && array['cafe','coffee_shop','bakery','fast_food_restaurant','meal_takeaway','sandwich_shop','deli',
    'bagel_shop','donut_shop','dessert_shop','ice_cream_shop','juice_shop','american_restaurant','asian_fusion_restaurant',
    'chinese_restaurant','indian_restaurant','italian_restaurant','japanese_restaurant','mexican_restaurant',
    'middle_eastern_restaurant','seafood_restaurant','sushi_restaurant','thai_restaurant','vegan_restaurant',
    'vegetarian_restaurant']::text[]
  and v.business_status is distinct from 'CLOSED_PERMANENTLY';
```

The two arrays are `FOOD_TO_GO_TYPES` from `@roam/core/f2g` (all leaves, then the 13 cuisine
leaves) — keep them in step if the taxonomy moves on. Baseline before Phase 1 (2026-09-16):
1,228 eligible / 176 cuisine takeaways. Then open `nifood2go.roam-local.com`, pick a swept town,
and check the "Takeaway" chip lists venues.

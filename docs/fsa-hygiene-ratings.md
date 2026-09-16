# FSA food-hygiene ratings — runbook

Official Food Standards Agency hygiene ratings on venue pages and cards, site-wide (every Roam food
venue with a match, not just F2G members). Data is Open Government Licence v3.0; the badge always
carries the rating date and attribution, and a status ("Awaiting inspection", "Exempt") is rendered
as words — never a number (`@roam/core/fsa.isDisplayableRating`).

## Where it shows

| Surface | Component |
|---|---|
| Venue detail page (F2G + core) | `FsaBadge` — score badge, rating date, council, FSA link, OGL attribution |
| F2G storefront cards | `FsaChip` in `F2GVendorCard` + page attribution line |
| Core Explore / any `VenueCard` grid | `FsaChip` + attribution line |

Read path: `venues.fsaRating` (single) / `venues.fsaRatings` (batch, per grid) →
`external_refs` (`dataset='fsa'`) → `fsa_establishments`. Both tables are publicly readable.

## Official badge artwork (decision #6: self-hosted, unaltered)

The venue page shows the FSA's **own** Food Hygiene Rating sticker, not a reproduction. The data is
OGL; the sticker is FSA branding, permitted for display alongside data taken from the FSA API under
the FSA's image terms (unmodified, kept current, attributed) — confirm those terms on the API help
page before adding or changing files. How it is wired:

- **Key → file.** The FSA names each rating image by the establishment's `RatingKey`
  (`fhrs_5_en-gb`, `fhrs_exempt_en-gb`, …); the sync stores it verbatim (`rating_key`). The keys in
  the live NI register (2026-09-16) are `fhrs_0…5_en-gb`, `fhrs_awaitinginspection_en-gb` and
  `fhrs_exempt_en-gb` — NI runs FHRS in English, so no Welsh (`cy-gb`) or Scottish (FHIS) artwork.
- **Server gate** — `@roam/core/fsa.officialBadge(ratingKey, rating)`: returns the badge only when the
  key is in `FHRS_BADGE_KEYS` (the allowlist of shipped files) **and** agrees with the displayed
  rating (a `fhrs_5` key on a value of 4 yields no official badge, never the wrong sticker). A status
  never gets a numeric badge. A missing key is never derived → no official badge.
- **Web gate** — `apps/web/src/lib/fsaBadges.ts` `FSA_BADGE_ASSETS`: one entry per file actually in
  `apps/web/public/fsa/`, with the file's intrinsic size (read from the file, so the box is reserved
  before load). No entry, or a load error → `FsaBadge` falls back to the in-house mark. A page can
  never show a broken image or lose the rating over an asset gap.
- **Never edit the files** (no recolour, crop or rename). The card chip (`FsaChip`) stays the compact
  in-house mark — a sticker built for a shop window doesn't shrink to a 60 px pill.

To add artwork: drop the official file in `public/fsa/<rating_key>.<ext>`, add its key to
`FHRS_BADGE_KEYS` (core, with the test's expected list) and its entry to `FSA_BADGE_ASSETS` (web),
and record the download source + date here.

## Pipeline

1. **Corpus + auto-match — `sync-fsa-ni`** (`packages/api/src/jobs/syncFsaNi.ts`). Pulls each configured
   council from `api.ratings.food.gov.uk` (free, keyless), upserts by `fhrsid`, then matches unlinked
   establishments to venues: grouped by postcode outward code (one candidate read per block), scored by
   `@roam/core/matching` with **contextual name scoring** (locality + descriptor stripping, token
   containment). **Auto-link requires full-postcode agreement** and a clear margin over the runner-up;
   everything else is left for review. Never overwrites a manual link; never re-links a dismissed venue.
2. **Review — Roam HQ → FSA ratings** (`core/admin/fsaReview.ts`, `apps/admin` `FsaReviewView`). Unlinked
   food venues with their same-postcode candidates re-scored on demand. **Confirm** writes
   `external_refs` `method='manual'` (permanent). **No record** / **unlink** write
   `fsa_match_dismissals` (0148) — the venue leaves the queue and the sync skips it. All audited.

## Configuration (Railway `core-platform` service)

| Variable | Value |
|---|---|
| `FSA_NI_AUTHORITY_IDS` | `132,133,134,135,136,138,140,142,144,145,147` (the 11 NI councils) |
| `FSA_PAGE_SIZE` | optional, default 5000 |
| `FSA_API_BASE` | optional, default `https://api.ratings.food.gov.uk` |

Get authority ids from the live registry (never by hand): `pnpm --filter @roam/api fsa:authorities`
(`-- --all` for every UK region). The job is **dormant** when `FSA_NI_AUTHORITY_IDS` is unset.

## Operate

```
pnpm --filter @roam/api sync-fsa-ni        # one run; prints fetched / upserted / matched
```
Nightly: the Railway cron service with config `railway.cron-sync-fsa-ni.json` (03:23), same variables.

Coverage (Supabase SQL editor):
```sql
select count(*) as food_venues, count(r.entity_id) as with_rating,
       round(100.0 * count(r.entity_id) / nullif(count(*),0), 1) as pct
from venues v
left join external_refs r on r.entity_type='venue' and r.dataset='fsa' and r.entity_id=v.id
where v.source='google_places' and v.category='Food & Drink';
```
The HQ tab shows the same numbers live.

## History (NI)
- First sync: 16,949 establishments, 46% of NI food venues linked.
- Contextual matcher (#404): +380 in one run → 74.4%. Residue: ~94 with no record at the venue's
  postcode, ~220 review-band → the HQ queue.

## Backlog
- **UK-wide** (#52): `FSA_AUTHORITY_IDS=all`, venue-driven matching, Scotland FHIS statuses as words.

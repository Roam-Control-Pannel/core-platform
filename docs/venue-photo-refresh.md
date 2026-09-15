# Venue photos — expired Google references (runbook)

## What happens

Roam never stores Google photo bytes (Maps Platform terms). A `venue_photos` row with
`source = 'google_places'` holds a Places (New) photo **reference**
(`places/{placeId}/photos/{token}`), and the API resolves it to a short-lived image URL at read
time (`venues.photoMediaUrl` / `photoMediaUrls` → Places Photo Media).

**Those references expire.** When they do, Google answers the media call with:

```
400 INVALID_ARGUMENT — "The photo resource in the request is invalid.
                        Please retrieve it from Places API endpoints."
```

Because every venue's refs were minted around the same time, they expire together — and every
Google-sourced cover on **every** surface (roam-local.com Explore, the F2G storefront, venue detail
heroes) falls back to the placeholder at once, while venues, rows, ratings, the API key and
billing are all fine. This happened platform-wide in Sep 2026.

**Diagnose in one command** (deployed env or a dev box; `--env-file-if-exists` means it runs on a
Railway console with injected vars):

```
pnpm --filter @roam/api diagnose:photos
```

It prints the raw refs, Google's response body, and a verdict — `EXPIRED REFS` names this case.
A `403` is billing/key, a `429` is quota; those are **not** this runbook.

## How it heals — two layers

### 1. Read-time self-heal (automatic, platform-wide)

`packages/api/src/photos/refresh.ts` (pure core) + its wiring in `routers/venues.ts`.

When a resolve comes back **stale** (400 `INVALID_ARGUMENT` or 404 — never 403/429/5xx, which are
key/quota/outage faults that healing would only mask), the API:

1. checks the venue has **no owner uploads** (an owner library is canonical — never refreshed),
2. checks it wasn't refreshed in the **last hour** (`venues.google_photos_refreshed_at` — a
   restart-safe, multi-replica-safe negative cache; also stops loops on a photo Google removed),
3. claims one unit of the shared **Place Details budget** (`claim_places_detail_quota`;
   `PLACES_DETAILS_DAILY_BUDGET`, default 1000/day),
4. re-fetches the venue's photos with **one photo-only Details call** (`getPlacePhotos`, the
   `id,photos` mask — the cheapest tier),
5. replaces its rows through **`refresh_venue_google_photos`** (migration 0147),
6. serves the fresh photo **at the same gallery position** the caller asked for.

Ten photos of one venue share **one** refresh (per-venue in-flight de-duplication). Any venue
anyone views heals itself; nothing needs a cron to stop being blank. A heal that can't run
(budget, policy) rethrows the original error, so the card degrades exactly as before and the real
fault stays visible in the logs (`[venues.photoMediaUrls] N/M Places photo resolves failed: …`).

### 2. Bulk refresh (operator-run, cron-ready)

```
pnpm --filter @roam/api refresh:photos -- --dry-run --limit=3   # smoke: 3 calls, no writes
pnpm --filter @roam/api refresh:photos                          # heal everything refreshable
pnpm --filter @roam/api refresh:photos -- --limit=500           # a capped, cron-sized pass
pnpm --filter @roam/api refresh:photos -- --venue=<uuid>        # one venue
```

Targets come from `list_google_photo_venues` (0147): **never-refreshed first, then
least-recently refreshed**, owner-library venues never listed. One cheap Details call per venue.
Idempotent and policy-guarded in the database — safe to re-run.

**Recommended:** a Railway cron (like `owner-digest`) running `refresh:photos -- --limit=500`
weekly, so references are renewed before they expire and no first view ever hits a stale one.

**Do not** use `backfill:photos` for this: it uses the Enterprise + Atmosphere Details mask (the
top SKU), overwrites rating/rich fields, and skips claimed venues.

## The refresh policy (enforced in the database — `refresh_venue_google_photos`)

| Venue state | Google photos |
|---|---|
| Unclaimed | replace-all with fresh refs |
| Claimed, owner has **no** uploads | refresh its **existing** Google rows only — never *adds* Google photos to a claimed venue that had none |
| Any venue with owner uploads | **untouched** — owner library canonical; stale Google rows left alone, not deleted |

Owner uploads always rank above Google photos as cover (`venues_food_to_go_near`,
`cover_photo_id` ordering), so nothing scraped can displace owner content.

## Rollout / recovery checklist

1. Apply migration **0147** (`refresh_venue_google_photos`, `list_google_photo_venues`,
   `venues.google_photos_refreshed_at`) + `notify pgrst, 'reload schema'`.
2. Deploy the API — the self-heal is live immediately.
3. Run `refresh:photos -- --dry-run --limit=3`, then `refresh:photos` — everything heals at once.
4. Set up the weekly cron.

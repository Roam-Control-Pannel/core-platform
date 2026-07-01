# Translink NI transit — "Nearby departures" (Stage 5 · Slice 1)

Roam shows a **live departure board** for the nearest Translink stop when a place sits inside
Northern Ireland. It's powered by the **Translink Opendata API** (an EFA "Intermodal Journey
Planner" — a live query API, not a GTFS import) and is **best-effort + self-hiding**: outside NI,
or when the key isn't set, or when there's nothing to show, the card simply doesn't render.

## How it works

```
web place (lat,lng)
   └─(client NI geofence: lib/transitRegion)─▶ POST /api/transit/nearby   [web hop, holds x-internal-call]
          └─▶ transit.nearbyDepartures (internalProcedure)
                 geofence → board cache → per-client throttle + daily budget → EFA calls
                   1. CoordInfo  (XML_COORD_REQUEST) → nearest stop
                   2. Departure-Monitor (XML_DM_REQUEST) → live board
                 parsed by @roam/core/transit → { status, stop, departures, attribution }
```

- **Pure logic** (geofence, rapidJSON parsers, mode mapping, cache-key snapping, fair-use
  constants) lives in `@roam/core/transit` and is unit-tested.
- **Network I/O** (the two EFA calls + the swappable key injection) lives in
  `packages/api/src/transit/client.ts`.
- **Cost/abuse guards** (in-memory board cache, UTC-day budget, per-client throttle) live in
  `packages/api/src/transit/guard.ts`.

## Cost controls (fair-use ~3,000 requests/day)

| Guard | Value | Effect |
| --- | --- | --- |
| Board cache | TTL 45 s (`DEPARTURES_TTL_MS`) | A crowd on one place costs one lookup, not one-per-viewer. A cache hit spends **no** budget. |
| Daily budget | 2,500 EFA requests (`TRANSLINK_DAILY_BUDGET`) | One answer costs up to 2 requests (CoordInfo + DM) → ≈1,250 answers/day, safely under the licence. |
| Per-client throttle | 20 answers / 60 s per forwarded IP | One client can't drain the daily budget. |

> **Known limit:** the guards are **per-process** (in memory). On our single Railway instance
> that's exact. If the API is ever scaled horizontally, the effective ceiling multiplies by the
> instance count — the honest fix is a shared counter (like places' `claim_places_fetch_quota`
> RPC). Documented so it's a known limit, not a silent one.

## Configuration (API service — Railway)

Only the key is required. Set it on the **`core-platform`** service:

```
TRANSLINK_API_KEY=<your key>
```

**How the key rides on each request** is Translink-specific — check your licence/API-access email:

- **Query parameter** (default): `TRANSLINK_AUTH_MODE=query`, param name from `TRANSLINK_AUTH_PARAM`
  (default `key`) → `…XML_DM_REQUEST?…&key=<KEY>`.
- **HTTP header**: `TRANSLINK_AUTH_MODE=header`, header name from `TRANSLINK_AUTH_HEADER`
  (default `Authorization`) → `Authorization: <KEY>`.

Optional: `TRANSLINK_API_BASE` overrides the EFA base URL (default
`http://opendata.translinkniplanner.co.uk/Ext_API/`).

Until `TRANSLINK_API_KEY` is set, the feature is dormant (`nearbyDepartures` returns
`status: "unconfigured"`) and the API still boots.

## Attribution (licence obligation)

Every board carries `TRANSLINK_ATTRIBUTION` — *"Transport Information supplied by Translink
Opendata API"* — and the web card renders it in its footer. Do not remove it.

## Verify

1. Set `TRANSLINK_API_KEY` on Railway and redeploy.
2. Open Roam, switch to a Belfast (or any NI) place → the **Nearby departures** card should
   appear with the nearest stop and upcoming services. A green dot = a realtime estimate.
3. Switch to a non-NI place (e.g. London) → the card disappears entirely.
4. If nothing shows in NI, check the API logs for `[transit]` lines and confirm the auth mode
   matches how your key was issued (query vs header).

## Roadmap (later slices)

- **Slice 2** — `transit.planTrip` (EFA Trip-Request: point-to-point journey planning).
- **Slice 3** — service alerts / disruptions (EFA AddInfo).

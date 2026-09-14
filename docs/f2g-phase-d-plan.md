# F2G Phase D — plan (ranking, images, FSA on cards) + go-live

> Grounded in a full three-way code recon (no guesswork). Roam remains the engine of truth; F2G is
> the partnership whitelabel layer. Each workstream below is an independent, CI-gated slice.

## 0. Verified current state

- **Storefront tier is live.** The `nifood2go.roam-local.com` grid is served by `storefrontNear`
  (`packages/api/src/routers/venues.ts:648`) → open mode → `venues_food_to_go_near` (the **0123**
  version, which added `delivers`). That proves migrations 0116/0122/0123/0134 are on production.
- **Phase B/C DB (0135–0144) is NOT yet applied** — the user confirmed no SQL was run since the F2G
  plan began. Delivered as one paste-ready script (`f2g-migrations-0135-0144.sql`, idempotent, ends
  with a PostgREST schema reload). This is the gate for D3 (needs `channel_members`/`venue_channels`)
  and D4 (needs `external_refs`/`fsa_establishments`).
- **FSA data is empty.** `syncFsaNi` is dormant until `FSA_NI_AUTHORITY_IDS` is set; `fsa_establishments`
  and the `dataset='fsa'` links in `external_refs` are unpopulated, so no rating renders anywhere yet.
- **Blank Google covers** are a live/ops condition, not a code defect — `cover_photo_id` is null iff a
  venue has zero `venue_photos` rows, and the read-time batch resolver swallows failures to the same
  placeholder. Two candidate layers (below), disambiguated by one probe.

---

## D1 — Apply the DB + turn on the data (ops; unblocks D3/D4)

**Goal:** production carries 0135–0144, and the FSA corpus starts populating.

**Steps (user/ops, no code):**
1. Run `f2g-migrations-0135-0144.sql` in the Supabase SQL editor. Idempotent; ends with
   `notify pgrst, 'reload schema'`.
2. Set env on the API: `FSA_NI_AUTHORITY_IDS` (the 11 NI council authority ids), and confirm
   `GOOGLE_PLACES_API_KEY_CORE` is present + authorized (see D2). `NEXT_PUBLIC_F2G_SITE_URL`,
   `F2G_INVITE_SECRET` as before.
3. Run the FSA sync once (`pnpm --filter @roam/api sync-fsa-ni` or the `/jobs/sync-fsa-ni` route),
   then nightly via pg_cron.
4. Confirm parity with the drift guard (`scripts/check-schema-drift.mjs`) against production.

**Risk:** low. All migrations idempotent; FSA sync only writes `method='auto'` refs and never overwrites
manual matches.

---

## D2 — Google image covers: diagnose, then fix

**Goal:** venue cards show real Google photos again.

**Diagnosis (one probe pins the layer):** call `venues.photoMediaUrl({ photoId })` (the **single**
resolver — it propagates the real error, unlike the batch) for one photo id whose venue has a
non-null `cover_photo_id`.
- **Errors (`BAD_GATEWAY`/`NOT_FOUND`)** → **Layer B, read-time resolve.** Cause is the Places key
  authorization, Google quota (429), a stale/malformed ref (404), or egress to
  `places.googleapis.com` blocked. Fix = correct the `GOOGLE_PLACES_API_KEY_CORE` project/authorization
  or quota/egress. **No data change.**
- **Returns a URL, yet most cards still have `cover_photo_id = NULL`** → **Layer A, missing rows.**
  These venues have no `venue_photos`. Fix = repopulate.

**Fixes for Layer A (both already exist as tooling):**
- `scripts/reingest-food-to-go.mjs` — re-runs open-mode ingest per NI town **against the deployed
  API** (only needs `INTERNAL_CALL_SECRET` + `NEXT_PUBLIC_API_URL`); re-fetches even already-populated
  towns (ingest ignores freshness), writing photos via `upsert_venue_photos`. Best fit for
  "Belfast is populated but thin."
- `pnpm --filter @roam/api backfill:photos` — direct-DB Place Details backfill for **unclaimed**
  google_places venues.

**Known limitation:** `upsert_venue_photos` skips **claimed** venues (`owner_id` set); a claimed
F2G venue with no owner upload keeps the placeholder. That is by design (owner controls their media)
— surfaced here so it isn't a surprise.

**What I can build (optional):** a tiny staff-only diagnostic (`venues.photoDiagnostics({ near }`)
or a script) that returns, for a town, `total / null-cover / claimed-null-cover` counts + one live
single-resolve result — so the layer is pinned in one call rather than manual probing. Small.

**Risk:** low. Diagnosis is read-only; reingest is idempotent (replace-all per venue).

---

## D3 — Member-priority ranking (members > claimed non-members > unclaimed)

**Goal:** open mode still serves every eligible NI venue (members + non-members via Google), but ranks
**confirmed F2G members first**, then claimed non-members, then the rest — each tier nearest-first.

**The load-bearing constraint (from recon):** `venues_food_to_go_near` is `SECURITY INVOKER`, and
`channel_members` is deny-by-omission with no client policy — so an `EXISTS` over the roster evaluated
as the anon caller sees **zero rows** and the member tier would silently never fire. `venue_channels`
(the owner self-tag) *is* world-readable.

**Design (surgical, backward-compatible):** new migration **0145**.
1. A small `SECURITY DEFINER`, PII-free helper:
   ```
   f2g_member_venue_ids(p_channel_id uuid) returns table(venue_id uuid)
   -- roster: channel_members where channel_id=p and venue_id not null and status in ('claimed','live')
   -- UNION owner-tag: venue_channels where channel_id=p
   ```
   Touches only `channel_id / venue_id / status` — no PII (consistent with the 0135 definer posture).
   `p_channel_id is null` → empty set. Grant execute to anon/authenticated.
2. Supersede `venues_food_to_go_near`: drop the exact current `(double,double,int,int)` signature,
   recreate with a **trailing** `filter_channel_id uuid default null` and a **trailing** `is_member
   boolean` return column (additive — safe, exactly how 0123 added `delivers`), `LEFT JOIN
   f2g_member_venue_ids(filter_channel_id)`, and
   `ORDER BY is_member DESC, (owner_id is not null) DESC, distance`. Re-grant execute.
   **When `filter_channel_id` is null → `is_member` false for all → ordering collapses to today's
   claimed-first/nearest**, so the currently-deployed 4-arg API call is unaffected.
3. API: `storefrontNear` open branch passes `filter_channel_id: channel.id` (it already has
   `channel.id` in scope); extend the row type + `toStorefrontCard` with `isMember`.
4. pgTAP **0145 test** (none exists for this fn today): seed a member venue, a claimed non-member, an
   unclaimed venue near a Belfast origin; assert the member sorts first and `is_member` is correct.
   Exact `plan(N)`.
5. Web (optional, cheap): a quiet "Member" chip on member cards (`F2GVendorCard`) using the new
   `isMember` flag — the "members badged in open mode" the original plan called for.

**Dependency:** only *visibly* re-ranks once the roster is imported + matched (roster CSV, task #28).
Until then every `is_member` is false and behaviour equals today — so this ships safely now and
activates automatically when the data lands.

**Decision needed:** member = roster (`channel_members` claimed/live) **OR** owner-tag
(`venue_channels`)? Recommend **both** (either is an affirmative "on F2G" signal, and both should
outrank a generic claimed Google venue). Easy to narrow to roster-only.

**Risk:** low–medium (a live ranking change + one function becomes definer-adjacent via the helper).
Mitigated by the null-collapse and the pgTAP ordering test.

---

## D4 — FSA ratings on preview cards + listings

**Goal:** the official FSA hygiene rating shows on storefront preview cards and venue grids (the venue
**detail** page already has it via `FsaBadge`, C1-b).

**Recon verdict:** there is **no batch rating lookup** — only per-venue `venues.fsaRating`. Rendering
24 cards with the current badge = 24 calls (must not ship). Two options considered; recommending the
batch, because it is ONE reusable pattern across every card surface (storefront + Explore + any grid),
mirrors the existing cover batch already wired in `StorefrontHome`, and needs **no** churn to the four
discovery RPCs' return types.

**Design:**
1. **`venues.fsaRatings({ venueIds: uuid[] (1..60) })`** — batch procedure mirroring
   `photoMediaUrls`: one `external_refs .in('entity_id', ids)` read → fhrsids, one
   `fsa_establishments .in('fhrsid', fhrsids)` read, resolve each via `@roam/core/fsa.isDisplayableRating`
   (the guardrail: a non-numeric status is NEVER shown as a score), return `Record<venueId,
   VenueFsaRating>` with `kind==='none'` dropped. Reuses the existing `VenueFsaRating` type — the web
   bundle stays core-free (the API resolves the display shape, exactly like the single `fsaRating`).
2. **Compact badge** — a small coloured score chip (green ≥3 / amber 1–2 / red 0, self-hosted assets)
   for cards, distinct from the full detail-page `FsaBadge`. Status pills ("Awaiting", "Exempt") too.
3. **Wire in:** `StorefrontHome` fires `fsaRatings(pageVenueIds)` alongside the cover batch (parallel
   → no added wall-clock) and passes the result to `F2GVendorCard`; the Roam `VenueCard` grids get the
   same shared hook. One OGL **attribution line** in the grid footer (a licence term — required on any
   surface that shows ratings; one line, not per card).

**Dependency:** hard on D1 — `external_refs`/`fsa_establishments` must exist (0137/0141 applied) and
be populated (`FSA_NI_AUTHORITY_IDS` + sync). Until then `fsaRatings` returns empty and cards simply
show no badge (safe, no error).

**Risk:** low. Additive API + display-only; the `isDisplayableRating` guardrail is already unit-tested.

---

## Sequencing

| Order | Work | Type | Depends on |
|------|------|------|-----------|
| **D1** | Apply 0135–0144, set env, run FSA sync, drift-check | ops (you) | — |
| **D2** | Image probe → fix key/quota **or** reingest | ops + optional small tool | Places key |
| **D3** | Member-priority ranking (0145 + API + test + chip) | code slice (PR) | D1 (channel_members live) |
| **D4** | FSA batch + compact badge on cards | code slice (PR) | D1 (+ FSA data populated) |

D3 and D4 are independent code PRs and can land in parallel; both are safe to merge before the data is
live (they no-op until it is). D2 is mostly ops; I'll build the diagnostic helper if you want the layer
pinned in one call.

## Decisions to confirm
1. **Member definition (D3):** roster + owner-tag (recommended) or roster-only?
2. **FSA delivery (D4):** batch procedure (recommended) or inline into the discovery RPCs?
3. **Image probe (D2):** you run the one `photoMediaUrl` probe (fastest), or I build the diagnostic
   helper first so it reports in one call?

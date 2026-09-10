# Roam core-platform — Phase 4 backlog (deferred from the Sep 2026 security remediation)

**Source review:** `roambugreview20260902_1.md` (2 Sep 2026, PRs #323–#349, @ `cd99b2f`)
**This document:** the work deliberately deferred after Phases 1–3 closed every HIGH and MEDIUM finding.
**Status of Phases 1–3:** complete — see the closing record at the bottom.

Everything here is **LOW severity, transitive, or infra hygiene**. None is a live, high-impact
exploit; all were consciously parked so the HIGH/MEDIUM fixes could ship focused and reviewable.
Line references are from the review and were re-confirmed against `main` while writing this.

---

## A. LOW findings (7)

Grouped by natural PR so each row of work is one coherent change with its own test.

### A1 — Idempotent upserts on two membership tables *(one PR, RLS + no code change needed on client)*

Two tables have an INSERT policy but **no UPDATE policy**, and both are written with
`upsert(..., { ignoreDuplicates: false })`. Re-adding an existing row makes PostgREST attempt the
UPDATE half of the upsert, which RLS denies — surfacing as a **500, not the intended idempotent
no-op**. Same class as the bugs fixed in `0012`/`0014`.

| Site | Table | Symptom |
|---|---|---|
| `packages/api/src/routers/meetup.ts:185-190` | `meetup_options` | re-adding a venue already on a poll → 500 |
| `packages/api/src/routers/chat.ts:258-262` | `chat_participants` | re-adding an existing group member → 500 |

**Fix options (pick one, consistently):**
- Flip both call sites to `ignoreDuplicates: true` (matches `plans.ts:363`, `savedStops.ts:44` — the
  established idiom), **or**
- add a self-scoped UPDATE policy to each table (heavier; only needed if a genuine re-accept must
  mutate the row).

Recommended: `ignoreDuplicates: true`. Confirmed both call sites still carry `ignoreDuplicates: false`
on `main`. Add a small regression test that re-adding is a no-op.

### A2 — Market resolution: bounding-box fallback overrides an explicit country code *(LOW, but a correctness trap)*

`routers/geo.ts:93-94` lets the GB bounding-box fallback win over a caller-supplied `country`. GB's
fallback box (`packages/core/src/markets/index.ts:81`) contains the **whole Republic of Ireland**, so a
Dublin visitor sending `country: "IE"` is resolved to `currency: GBP, name: "United Kingdom"` — the
exact silent fallback the doc comment there forbids.

**Contained today** because consumers read only `market.units`, not currency/name — so no user-visible
defect *yet*. Fix: honour an explicit ISO country code before falling back to the box. Worth doing
alongside the platform's global-market work, and it ties directly into the open **Belfast IP-fallback
design question** (see §D).

> ✅ **Resolved — shipped in #366.** `resolveMarket()` in `@roam/core/markets` now makes an explicit
> country code authoritative; the coordinate box is a fallback only when no code is present. A Dublin
> `IE` visitor resolves to `known:false`/seeding, never GB.

### A3 — GB backfill stamped Irish venues as GB

`0128_venue_country_code.sql:113-117` stamps `GB` on every venue inside the UK bounding box — which
includes ROI. A Letterkenny café's products therefore price in GBP. **Self-heals** on the venue's next
Places refresh (bounded by the 30-day freshness cycle), so this is latent, not permanent.

Fix: a one-shot corrective `UPDATE` that re-nulls `country_code` for venues whose coordinates fall in
ROI (or, better, restrict the original box to actual GB and let the next refresh fill the truth). Do
this **with** A2 — same root cause (GB box over-reaches into Ireland).

> ✅ **Resolved — shipped in #368** (migration `0133`). A lat/lng rectangle can't separate NI from ROI,
> so the correction keys on the authoritative Places address suffix (…"Ireland" → `IE`, …"UK"/"Northern
> Ireland" left as GB), scoped to unclaimed Places-sourced rows, with a pgTAP test over the full
> classification.

### A4 — "Delivers" filter empties the storefront in members mode

`apps/web/.../StorefrontHome.tsx:198` — `delivers` is populated only by the open-mode RPC
`venues_food_to_go_near`, so it is always `false` in members mode, yet the filter button still renders.
Tapping it empties the list. Fix: hide the filter in members mode, or populate `delivers` in the
members-mode query. Pure client/query change.

### A5 — Reviews "Show more" can skip a row

`VenueDetail.tsx:1675` pages `venue_reviews_list` by **absolute offset**. `0127` fixed tie *instability*
but not *offset drift*: if a review is removed between page fetches, one row is silently never shown.
The client's id-dedupe only guards the duplicate direction, not the skip direction. Fix: keyset/cursor
pagination (order + `created_at,id` cursor) rather than numeric offset.

### A6 — Capture the `venue-media` storage bucket policies as a migration *(also an infra item — see §C3)*

Migration `0021` is **missing** (sequence jumps `0020` → `0022`), yet `0076:115` drops a
`venue_media_read_public` policy and `venues.ts:1252` cites "the 0021 storage RLS". The bucket is public
(`0070:8`) and takes owner uploads, but its **write scoping exists only in the live project** — it
cannot be audited or reproduced from this repo. This is the one LOW item with an audit/DR consequence:
a rebuild-from-migrations (now enforced by the PR-0 `db` CI gate!) would produce a bucket **without**
the live write policy. Recommend authoring a `0133_venue_media_storage.sql` that reproduces the live
policy exactly (requires reading it from the prod project first).

---

## B. Dependencies

`next` was already bumped `16.2.7 → 16.2.11` in Phase 3 (PR-3) — the only **direct** high, which also
cleared `sharp` and several moderates. Everything below remains.

### B1 — Transitive high advisories via `pnpm.overrides`

There are currently **no `pnpm.overrides`** in the root `package.json` (confirmed — the `pnpm` block is
empty). These 25 high advisory-instances across 7 remaining packages are all transitive and best pinned
with a single `overrides` block + one `pnpm install --lockfile-only`, gated behind the full CI (`check`
+ `db`):

| Package | Installed | Advisory | Pin to |
|---|---|---|---|
| `hono` | 4.12.23 | CORS reflects any Origin w/ credentials on wildcard default | `≥4.12.25` (4.12.34 clears 7 more) |
| `postcss` | 8.4.31 + 8.5.15 | Arbitrary file read / path traversal via `sourceMappingURL` | `8.5.18` |
| `js-yaml` | 4.2.0 | Quadratic-CPU DoS | `4.3.1` |
| `nanoid` | 3.3.12 | Infinite loop on negative size | `3.3.18` |
| `shell-quote` | 1.8.4 | Quadratic DoS in `parse()` | `1.9.0` |
| `brace-expansion` | 1.1.15 / 2.1.1 / 5.0.6 | Unbounded-expansion DoS | `1.1.18` / `2.1.4` / `5.0.9` |
| `image-size` | 1.2.1 | Infinite-loop DoS on ICNS/JXL/HEIF | **no fix published — track upstream** |
| `sharp` | 0.34.5 (via `next`) | inherited libvips CVEs | `≥0.35.0` (`packages/api` already resolves 0.35.3) |

Note the pnpm-v10 `overrides` syntax and re-run the `db`/`check` gates — a resolution bump can perturb
the graph (this is exactly what bit PR-3 when a floor was left in-range). Pin **exactly** where the
audited fix is a specific patch. `image-size` has no fix: document the exposure (DoS only, on
attacker-supplied image bytes hitting that decoder path) and watch for a release.

### B2 — Deferred major upgrades (each its own project, not a security fix)

Notably behind, all non-urgent, none deprecated/abandoned:

- `undici` 6 → 8 (2 majors; 3 moderate CVEs)
- `zod` 3.25 → 4 (breaking rewrite — touches every `.input()` schema; largest blast radius)
- `typescript` 6 → 7
- `eslint` 9 → 10 + `eslint-plugin-react-hooks` 5 → 7
- `vitest` 3 → 4
- `globals` 15 → 17
- Expo SDK 56 → 57 (one coordinated native-app upgrade)

Sequence by blast radius: `undici`/`globals`/`shell-quote`-class first (low risk), then tooling
(`typescript`/`eslint`/`vitest`), then `zod` 4 and the Expo bump as their own dedicated efforts.

---

## C. Infra / config hygiene

### C1 — `fsevents@2.3.3` missing from `onlyBuiltDependencies`

`fsevents` has an `install: node-gyp rebuild` script but is **not** in the `onlyBuiltDependencies`
allowlist in `pnpm-workspace.yaml` (confirmed: the list is `esbuild`, `msgpackr-extract`, `sharp`,
`@swc/core`, `@parcel/watcher`). Harmless on Linux/CI (fsevents is skipped entirely there — which is why
the `db`/`check` gates stay green), **but a Mac dev running `pnpm install --frozen-lockfile` aborts**
with `ERR_PNPM_IGNORED_BUILDS`. Fix: add `fsevents` to `onlyBuiltDependencies` (and the parallel
`allowBuilds` map). One-line, Mac-only pain, zero CI risk.

### C2 — `msgpackr-extract` dead allowlist entry

`msgpackr-extract` is allowlisted in both `allowBuilds` and `onlyBuiltDependencies` but **no longer
appears in the lockfile** (dead entry, likely left from #218). Cosmetic — remove both entries when
touching C1.

### C3 — `venue-media` storage migration

Same item as **A6** — listed here too because it is an infra/DR gap, not just a review LOW. The PR-0
`db` gate now rebuilds the schema from scratch on every CI run, which makes the missing `0021` storage
policy a real reproducibility hole. Highest-value infra item in this doc.

---

## D. Open design question (not a review finding — flagged during Phase 1-3 work)

**Belfast as the IP-detection fallback.** During the NI dev-seed / market work it surfaced that the
platform's default/fallback location behaviour needs to be *"use the user's location / country IP as the
default"* — a user in Atlanta must not default to Belfast NI. This is a product/design decision, not a
bug fix, and is entangled with **A2** (bounding-box fallback overriding explicit country) and **A3** (GB
box over-reaching into ROI). Recommend tackling A2 + A3 + this fallback policy together as one
"global-market correctness" workstream.

> ✅ **Resolved — option (ii), shipped in #367.** On zero location signal the web no longer asserts a
> town: `LocationGate` shows a neutral "Where would you like to explore?" first-run chooser (share
> location, or search any town/city worldwide) instead of defaulting to Belfast. Detection-succeeds
> paths are unchanged (a visitor's real location wins). Belfast is now only ever a real NI visitor's
> home. A2 + A3 shipped alongside (#366, #368), closing the whole global-market correctness workstream.

---

## E. Review-pass findings (the de-Darlington `VenuePicker` work, PRs #350–#353)

Surfaced by a high-effort review pass over this session's own changes (not from the Sep 2026 review).
Both live in the two `VenuePicker` components and are **low-severity quality/efficiency**, not
correctness bugs. They share a root cause, so they're best fixed together.

### E1 — `VenuePicker` fires `venues.near` twice on open

`apps/web/src/components/ChatShareMenu.tsx:194-215` and `apps/web/src/components/MeetupPanel.tsx`
(~`:335-350`). Each picker does `useState<Place>(currentPlace)`, but `useCurrentPlace()` returns
`DEFAULT_PLACE` (Belfast) on the first render and only hydrates the stored place on a later tick. So a
signed-out visitor whose stored place is, say, Derry opens the picker → the fetch effect queries
`venues.near` for Belfast → the stored place then lands, `setPlace` runs, `place` changes identity → a
second `venues.near` fires for Derry. The first request is wasted and can briefly render the wrong
locality's venues.

**Why it wasn't hot-fixed in the review pass:** the naive fixes make it *worse*. `useCurrentPlace`
returns `DEFAULT_PLACE` before hydrating, so lazy-initialising from `readCurrentPlace()` and/or gating
the follow-effect can overwrite a correctly-initialised place with the not-yet-hydrated Belfast, and a
structurally-equal-but-new-reference `setPlace` still re-triggers the `[place]` fetch effect. A correct
fix needs a considered shared hook plus a reliable "hydrated" signal — see E2.

### E2 — the "follow current place until the user picks a chip" block is copy-pasted into both pickers

The identical `useState(currentPlace)` + `pickedPlace` ref + sync-effect block appears in both
`VenuePicker`s; a change to the follow semantics must be made in both and can drift.

**Fix for E1 + E2 together:** extract a `useFollowingPlace()` hook (e.g. in `apps/web/src/lib/`) that
(a) reads the stored place synchronously so the picker's first `venues.near` already targets the right
locality, (b) follows `currentPlace` until the user picks a chip, and (c) only updates when the place
materially changes (by id + coords) so a new object reference alone can't re-fire the fetch. This
likely wants a small `hydrated` flag added to `useCurrentPlace` so the hook can distinguish "genuinely
Belfast" from "not yet hydrated." Its own PR, with a test for the single-fetch behaviour.

---

## Recommended sequencing

1. **A6 / C3** (venue-media storage migration) — highest value; closes a real DR/audit gap now that CI
   rebuilds from migrations.
2. **A1** (idempotent upserts) — tiny, removes two user-facing 500s.
3. **B1** (transitive `pnpm.overrides`) — one PR, clears 25 high advisory-instances.
4. **C1 / C2** (built-deps allowlist) — one-line Mac-dev fix + dead-entry cleanup.
5. **A4, A5** (storefront filter, review pagination) — client/query polish.
6. **E1 + E2** (`useFollowingPlace` hook) — one small web PR with a test; fixes the picker double-fetch
   and the duplication together.
7. **B2** (major upgrades) — each its own scheduled effort; `zod 4` and Expo 57 are the big ones.

> ✅ **A2 + A3 + §D (global-market correctness) — done this session** (#366, #367, #368). Removed from
> the queue above.

---

## Closing record — Phases 1–3 (done)

Every HIGH and MEDIUM finding is fixed and merged to `main`, each behind the new `db` (pgTAP rebuild)
and `check` (lint/typecheck/test) CI gates.

| PR | Finding(s) | Severity | Migration / change |
|---|---|---|---|
| PR-0 | (enabler) | — | `db` CI job: `supabase db reset` + `supabase test db` (pgTAP); fixed replay bugs in `0041`, `0055` |
| PR-1 | #1 friendships, #2 plan_members, #3 places_fetch_quota | HIGH | `0130` — WITH CHECK + identity-pin trigger; owner-only invite; RLS on + revoke |
| PR-2 | #4 postcode fence | HIGH | `core/f2g` outward-code fix + negative tests |
| PR-3 | `next` direct high | HIGH (dep) | `next` 16.2.7 → 16.2.11 (exact pin) |
| PR-4 | #6 venues, #7 profiles | MEDIUM | `0131` — column-scope guard triggers |
| PR-5 | #5 delivery geocoding | MEDIUM | address-rank ranker + `prefer:"address"` at delivery call sites |
| PR-6 | #8 hard-coded £ | MEDIUM | `core/money.formatPence`; currency added to webhook + refund selects |
| PR-7 | #10 owner digest at volume | MEDIUM | range-paginated scan (was oldest-5000 truncation) |
| PR-8 | #9 cart cap | MEDIUM | client ceiling `min(stock,20)` + server per-item 20 guard |
| PR-9 | #11 admin staff check | MEDIUM | explicit `.eq("id", uid)` predicate (defence-in-depth) |
| PR-10 | #12 non-atomic stock | MEDIUM | `0132` — `decrement_stock` SECURITY DEFINER + `FOR UPDATE` + oversell logging |

**Deltas found during the work (worth keeping):**
- **#1** — the review's one-line WITH CHECK fix was *insufficient*: a row-rewrite could still forge
  `requester_id`/`addressee_id`. PR-1 added a BEFORE-UPDATE identity-pin trigger.
- **#9(a)** — the `order_items.quantity between 1 and 20` half was already fixed by migration `0124`
  before this review window; PR-8 closed the remaining client/server disagreement.
- **#11** — confirmed *not* currently exploitable (the RLS policy holds today); the fix is
  defence-in-depth against the documented ACL-drift risk.
- **#8** — a third latent £ site exists in the F2G path but is NI/GBP-only today, so it does not
  misrender; noted for when F2G goes multi-currency.
- **PR-0's payoff** — the DB gate immediately caught two pre-existing migration *replay* bugs
  (`0041` return-type change, `0055` `cron.job` plan-time reference) that would have broken a
  from-scratch rebuild. A drop-aware static pass confirmed those were the only two of their class.

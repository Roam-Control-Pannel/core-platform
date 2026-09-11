# NI Food to Go Association — build plan & decision record

> **Status:** Phase A shipped. Phase B decisions resolved (§4). Phase B1 planned to implementation
> depth in a companion doc: [`f2g-b1-membership-spine-plan.md`](./f2g-b1-membership-spine-plan.md).
>
> **Grounded against:** `main` at the close of the Sep 2026 security + market + Phase-A work
> (highest migration **0134**). Every falsifiable claim below was checked against the actual code;
> `file:line` evidence is retained so a reviewer can verify without re-deriving.
>
> **House workflow:** one slice = one PR, ships green through both CI gates — `check`
> (lint/typecheck/test) **and** `db` (full `supabase db reset` migration replay + pgTAP) — squash-merged.
> Migration numbers are assigned at build time (the next free number), never hardcoded in advance.

---

## 1. Verdict on the strategy

**Membership is the spine; suppliers are `orgs` not `venues`; solve record-matching once; fix the
scale foundations before 5,000 of anything lands.** That reading is correct and respects
`ARCHITECTURE.md` ("no shell carries its own copy of the truth"). We are building from it.

### Confirmed architectural facts (build on these)

| Fact | Evidence |
|---|---|
| Channel resolution chain end-to-end (host → `channelKeyForHost`/config map → `x-roam-channel` + `roam_channel` cookie → `context.ts` `ctx.channelKey` → `channels.current` → `ChannelProvider` → `useChannel`) | `middleware.ts`, `lib/channelMap.ts`, `lib/channel.ts`, `context.ts:222`, `routers/channels.ts:87-104`, `ChannelProvider.tsx` |
| `venue_channels` is only the storefront **tag** (owner-self-taggable) — it cannot represent a roster member with no claimed venue, nor a supplier with no venue | `0116:69-124` |
| No `venues` INSERT policy anywhere; `upsert_place_venues` is `security definer` with an `owner_id is null` freeze | `0128:21`, Places freeze `0128:92` |
| `orgs` template exists: `market_listings` (owner→profiles, checked text, status enum, live-or-own read, owner write, updated_at trigger) | `0072:14-48` |
| Two-policy "live-or-own" read pattern (OR-combined permissive policies) | `0125:18-20` |
| Column-scope guard pattern (diff-and-raise, gated on client roles only) | `0131:23-80` |
| `gen_unique_venue_slug` definer + BEFORE INSERT trigger | `0044:16-90` |
| `membership_mode` toggle (`open`/`members`) is a single reversible `UPDATE` | `0122:24-35` |
| HMAC single-use expiring token pattern (reused by B3 claim) | `packages/api/src/ownerDigest/token.ts` |
| Core module conventions (`export * as <ns>` from `packages/core/src/index.ts`; pure + DB-thin split) | `packages/core/src/channels/index.ts`, `index.ts:14-42` |

---

## 2. Endorsed design decisions (with evidence)

- **Membership as the spine — `channel_members` distinct from `venue_channels`.** `venue_channels`
  (`0116`) is only the storefront tag; it cannot hold a roster member without a claimed venue, nor a
  supplier with no venue. Endorsed.
- **Suppliers are `orgs`, not `venues`.** Every venue read path (Explore, `venues_near`, `sitemap.ts`,
  `discover/[town]`) is world-readable and proximity-ordered — a supplier there is a product bug. No
  `venues` insert policy exists to reuse, and the `owner_id is null` Places-freeze is dead weight for
  a supplier. **Confirmed by decision #2.**
- **One matching engine, fail-closed.** Postcode-block + name-score + address tiebreak + a
  human-review tail; thresholds as exported `core` constants; never match on coordinates as the key.
  Legal framing is real (an inaccurate FSA rating can be a criminal offence + civil liability).
- **`members` vs `open` is a reversible product toggle** (`membership_mode`, `0122`) — deferred to the
  Association (decision #4).

---

## 3. Phase map & status

### Phase A — Foundations ✅ SHIPPED

| Slice | What | Status |
|---|---|---|
| A1a | core↔web mirror lockstep test (D11) | ✅ #371 |
| A2 | channel config: `nav`/`sections`/`surface` (migration 0134), core parsers + web mirror | ✅ #372 |
| A3-core | channel-aware SSR metadata — brand per host (D2) | ✅ #373 |
| A2-consumers | replace 32 `isF2G` sites with `surface`/`isSectionEnabled` (D3) | ✅ #374 |
| A2-middleware | config-driven host resolution via CDN-cached `/api/channel-map` | ✅ #375 |
| **A1b** | regenerate DB types + delete 180 `LooseDb` casts | ⏸ **deferred** — needs Supabase CLI/token/Docker (absent in the automation env) |
| **A3-b** | per-channel canonical host / 301 / channel-scoped sitemap host | ⏸ **deferred** — custom domain deferred (decision #8) |

### Phase B — Membership spine *(the 5,000)*

- **B1 · `channel_members` roster + `orgs`.** Roster-of-record (verbatim `source_*`, `membership_ref`
  idempotency key, status machine); **service-role-only**, column-scope trigger. `orgs` on the
  `market_listings` template with live-or-own read, owner write, `gen_unique_org_slug` definer
  (revoked from anon/authenticated), column-scope guard. Core `packages/core/src/membership/` +
  `orgs/`, pure + unit-tested. **Planned to implementation depth →
  [`f2g-b1-membership-spine-plan.md`](./f2g-b1-membership-spine-plan.md).**
- **B2 · The matching engine.** `external_refs` (one row per entity×dataset, persisted so matching is
  one-time and human corrections are permanent). Core `packages/core/src/matching/`: `normalisePostcode`,
  `normaliseBusinessName`, `scoreMatch`, `resolveCandidates` with accept/review/reject bands; NI-hard
  fixtures (chains, concessions on one postcode, null geocodes, identical centroids). *Build now on
  fixtures; tune + run once the roster CSV lands (decision #1).*
- **B3 · Bulk onboarding — import, invite, claim** *(D9; mandatory security review)*. Import job
  (`internalProcedure` + `POST /jobs/import-roster`, two-trigger pattern): ingest CSV verbatim → match
  via B2 → **phased Places backfill within the existing quota** (decision #5) → tag matched-live into
  `venue_channels` → per-run report. `claim_venue_with_invite(token)` definer reusing the HMAC
  single-use expiring token (single-use enforced in-DB under a row lock, typed SQLSTATE). Every
  unclaimed member page must already look alive. **pgTAP: replay, expired, race-claimed, forged.**
- **B4 · Roam HQ channel + roster admin (D7).** A 5th `apps/admin` view: channel/domain/config editing,
  roster + import reports, the match-review queue (writes `external_refs` `method='manual'`), invite
  send/resend, onboarding-progress dashboard. **Roam-staff-operated** — every mutation via
  `adminProcedure` → `admin_audit_log`; **no new role / no new RLS surface** (decision #7).

### Phase C — The four requested features

- **C1 · FSA hygiene on venue pages** *(needs B2)*. **Self-hosted SVG + nightly** (decision #6):
  `fsa_establishments` (service-role-only), core `packages/core/src/fsa/` (`isDisplayableRating` —
  "Awaiting inspection" never renders as 0), nightly `syncFsaNi` pulling the **11 NI JSON files**,
  matched via B2. **Fix D4 first** (extract a shared `VenueFacts` from `ClaimedDetail`/`VenueProfileShell`).
  Official badge imagery unaltered; `RatingDate` + our refresh date; OGL attribution.
- **C2 · Members marketplace at scale** *(needs A2, A3, B1, B3)*. `channel_members_search(...)` doing
  all filter/search/sort **server-side** (reuse `venues_search_by_name` trigram+KNN), radius a
  parameter with a null option (fixes D5+D6). `/directory[/town[/category]]`. Ships in **`open` mode**;
  the flip to `members` is the Association's call (decision #4).
- **C3 · Supplier marketplace** *(needs A2, B1)*. `orgs` self-serve INSERT policy
  `with check (owner_id = auth.uid() and status='draft' and moderation='pending')` + column-scope
  trigger. **Moderation is a hard gate.** Posting gated on `sections.suppliers`; **free for members**
  (decision #9) — gate on `channel_members.status='live'`, no billing surface, clean entitlement seam.
- **C4 · Employability board** *(needs A2, B1)*. `job_posts` (modelled on `events`/`0099`, moderation
  gate, only live members may post). **Post-and-apply-out v1** (decision #3) — no CV storage / ATS /
  applicant PII. Nightly expiry sweep. Free for members (decision #9).

---

## 4. Decisions — RESOLVED 2026-09-11

★ = blocks the named slice. **8 of 9 resolved; the roster CSV (#1) is the one outstanding dependency.**

| # | Decision | Resolution | Consequence |
|---|---|---|---|
| **1 ★** | The roster (blocks B2/B3) | **OUTSTANDING — deliverable, not a choice.** Need a ~50-row sample CSV incl. **postcodes** (match block key) + **contact emails** (no email → no invite). | B2 thresholds stay guessed until this lands; B2/B3 can be *designed/built on fixtures* but not tuned/run without it. |
| **2 ★** | Suppliers = `orgs` not `venues` (B1) | **YES — orgs.** | B1 builds `orgs` on `market_listings`; suppliers never touch the world-readable proximity venue paths. |
| **3 ★** | Employability v1 scope (C4) | **Post-and-apply-out.** | C4 = `job_posts` + external apply link. No CV storage / ATS / applicant PII in v1. |
| **4 ★** | `members` vs `open` mode (C2 flip) | **DEFER — decide with the Association.** | Does NOT block B1–B3. C2 ships `open`; the flip is a later reversible single `UPDATE`. |
| **5** | Places backfill budget (B3 live run) | **Phased within existing quota** (`claim_places_fetch_quota` / `PLACES_DAILY_FETCH_BUDGET`). | No new budget knob, no burst cost; full hydration takes several days. |
| **6** | FSA badge delivery (C1) | **Self-hosted SVG + nightly.** | Pull 11 NI JSON files nightly, store, render our own unaltered SVG; RatingDate + refresh date + OGL attribution. No third-party runtime script. |
| **7** | Roster admin (B4) | **Roam-staff-operated.** | B4 adds no new role / no new RLS surface; smallest B4. `channel_admin` self-serve is a later addition. |
| **8** | Custom domain (A3-b) | **DEFER — stay on `nifood2go.roam-local.com`.** | A3-b stays minimal; canonical/301/sitemap-host plan revisited when a real domain is confirmed. |
| **9** | Commercial model (C3/C4) | **Free for members.** | Gate posting on `channel_members.status='live'`; no billing surface in v1; design a clean entitlement seam for a later paywall. |

---

## 5. Sequencing recommendation

1. **B1 next** — fully unblocked by the decisions above; it does not wait on the roster CSV. Planned
   to implementation depth in the companion doc.
2. **B2 in parallel/after** — buildable and unit-testable on NI-hard **fixtures** now; threshold
   tuning + the live import (B3) wait on the roster CSV (decision #1).
3. **B before C, always** — every C slice depends on B.
4. **Two slices carry mandatory security review**: B3 (claim tokens = ownership grants) and C3 (`orgs`
   client insert). Treat like the security remediation — adversarial pgTAP, no green no merge.

*The single hard dependency left across all of Phase B is the roster sample CSV.*

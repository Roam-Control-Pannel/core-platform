# NI Food to Go — Phase C plan (the four requested features)

> **Status:** Phase A + Phase B shipped (`main` at `7fe1798`, highest migration **0140**). This doc scopes
> **Phase C** — the four features the Association actually asked for — to implementation depth, grounded
> against the code that now exists. Every slice is one PR through both CI gates (`check` + `db`), squash-
> merged; migration numbers are assigned at build time (next free is **0141**).
>
> **Framing (holds for every slice):** Roam is the engine of truth; F2G is a whitelabel layer over the one
> core. Phase C adds *new entities and surfaces*, never a second copy of the truth. Two invariants recur:
> **moderation is a hard gate** (only `auto_approved`/`approved` rows are world-readable — `moderation_status`,
> `0001:31`) and **"free for members" is an entitlement seam, not a paywall** (decision #9: gate posting on
> `channel_members.status = 'live'`; no billing surface in v1, but a clean seam for a later paywall).

---

## 1. What Phase C is, and what it depends on

| Slice | Feature | Builds on | New migration(s) | Security review |
|---|---|---|---|---|
| **C1** | FSA hygiene ratings on venue pages | B2 matching, `external_refs` (`fsa` dataset already reserved, `0137:28`) | `fsa_establishments` (~0141) | standard |
| **C2** | Members marketplace at scale (the public directory) | A2 surface/sections, B1 `channel_members`, B3 claims | `channel_members_search` RPC (~0142) | standard (definer read of safe columns only) |
| **C3** | Supplier marketplace (self-serve `orgs`) | B1 `orgs` (`0136`) | `orgs` self-serve INSERT policy + column guard (~0143) | **MANDATORY** (first client write to `orgs`) |
| **C4** | Employability board | `events` model (`0099`), B1 members | `job_posts` (~0144) | standard |

**Shared prerequisite (do first): D4 — extract a shared `VenueFacts`.** C1 renders the FSA badge on the
venue page, whose facts today live inline in `apps/web/src/components/VenueDetail.tsx` (owner + public
variants share the fields but not a component). Extracting a single `VenueFacts` (name/address/hours/
rating/badges) is the D4 review-debt item and the clean insertion point for the badge — do it as the first
commit of C1, not a scattered edit.

**The entitlement seam (C3 + C4, decision #9).** Both C3 and C4 gate *creation* on live membership. Build
it once, in core: `packages/core/src/membership/entitlement.ts` → `canPostAsMember(client, channelKey,
userId): Promise<boolean>` = "this signed-in user owns a `channel_members` row on this channel with
`status='live'`". C3's INSERT policy and C4's post procedure both call it. A later paywall replaces the
body of one function; no surface changes. (channel_members is service-managed PII, so the check runs in a
`SECURITY DEFINER` helper that returns only a boolean — never exposes the roster.)

---

## 2. C1 — FSA hygiene ratings *(needs B2; decision #6: self-hosted SVG + nightly)*

**Why it's real, not cosmetic:** an inaccurate hygiene rating is a legal exposure (a criminal offence +
civil liability), so the match must be conservative and the render must never invent a score. NI uses the
**FHRS 0–5** scheme (England/Wales/NI; Scotland's FHIS pass/improvement is out of scope).

**Data (`fsa_establishments`, migration ~0141)** — service-role-only, mirrors the `channel_members` posture
(RLS on, no client policy, a `0131`-style guard tripwire), because it's bulk-synced reference data no client
should write:
- `fhrsid` (text, unique — the FSA's stable key), `business_name`, `postcode`, `address`, `rating_value`
  (text: `'0'`–`'5'`, `'AwaitingInspection'`, `'Exempt'`), `rating_date` (date), `local_authority`,
  `lat`/`lng`, `raw jsonb` (the untouched record), `synced_at`.
- Index on `postcode` (the match block key) + unique on `fhrsid` (idempotent re-sync).

**Core `packages/core/src/fsa/`** (pure, unit-tested):
- `isDisplayableRating(value)` — **the load-bearing rule**: `'AwaitingInspection'`/`'Exempt'`/null must
  NEVER render as "0". Returns a discriminated `{ kind: 'score', score: 0..5 } | { kind: 'awaiting' } |
  { kind: 'exempt' } | { kind: 'none' }`.
- `ratingBadge(value)` — maps a displayable score to the official FHRS badge asset id + alt text.
- Reuses `@roam/core/matching` (`scoreMatch`/`resolveCandidates`) to match an establishment to a venue by
  name + postcode; a confident match writes `external_refs` (`entity_type='venue'`, `dataset='fsa'`,
  `external_id=fhrsid`, `method='auto'`), a human correction writes `method='manual'` (the B4b review
  pattern, reusable).

**Nightly sync `packages/api/src/jobs/syncFsaNi.ts`** — the `deliverOwnerDigest` shape (a pure
`runFsaSync(service, deps, log)` + a guarded `main()`; Railway cron / an internal route trigger). Pulls the
**11 NI local-authority JSON files** from the FSA open-data endpoint, upserts `fsa_establishments` on
`fhrsid` (cap-proof paging), then re-runs matching for unmatched NI venues. Dormant/no-op if the endpoint
env is unset (safe to ship before it's wired).

**Render (web):** the badge slots into the extracted `VenueFacts` — official FHRS SVG served **self-hosted**
(decision #6: no third-party runtime script), unaltered, with the `RatingDate` AND our `synced_at` refresh
date, plus the required **OGL attribution** line. Shows only when `isDisplayableRating` says so; "Awaiting
inspection" renders as that phrase, never a 0.

**Tests:** core unit (`isDisplayableRating` every branch — the awaiting/exempt/null cases are the point;
`ratingBadge`); API unit (`runFsaSync` upsert idempotency + match-write on a fake client, no network); pgTAP
(`fsa_establishments` service-managed: anon/authenticated cannot read or write; guard tripwire fires).

**Risk:** LOW–MEDIUM (legal framing) — mitigated by conservative matching (fail-closed to no-badge), the
never-render-0 rule, and manual correction surviving re-syncs.

---

## 3. C2 — Members marketplace at scale *(needs A2/A3/B1/B3; ships `open`, flip is decision #4)*

The public storefront directory of the Association's members, built to scale to the 5,000 without shipping
the whole roster to the client. Fixes review debt **D5/D6** (radius handling) along the way.

**`channel_members_search(...)` RPC (migration ~0142)** — `SECURITY DEFINER`, does ALL filter/search/sort
**server-side** and projects **only safe columns** (never `source_email`/`source_phone` — `channel_members`
is PII, `0135`): the member's public name, its matched venue (id/slug/name/locality/rating/geo), FSA badge
(via `external_refs` `fsa` join from C1), and channel status. Parameters: channel key, text query
(reuse the trigram + KNN machinery from `venues_search_by_name`, `0078`/`0106`), council/category filters,
an **optional** radius from a point (null = nationwide — this is the D5/D6 fix; radius is a *parameter*, not
a hardcoded fence), and offset paging (mirrors `venues_food_to_go_near`, `0122`). Execute granted to anon
(it's the public directory) but it only ever returns safe columns of **live** members.

**Membership-mode aware (decision #4):** in `open` mode the storefront shows every eligible venue near the
point (members badged); in `members` mode it shows ONLY member venues. The RPC takes the mode (from
`channels.membership_mode`, `0122`) so the flip is the Association's single reversible `UPDATE`, no code
change. **Ships in `open`.**

**API + web:** `channels.directory({channelKey, q, council, category, near?, radiusM?, cursor})`
publicProcedure over the RPC; a web `/directory[/town[/category]]` route (SSR, channel-scoped, indexable —
these ARE the F2G host's own pages, so under the A3-b Consolidated model they may self-canonical to the F2G
origin: the one place the microsite question resurfaces — confirm at build). Reuses the existing storefront
chrome (A2 `surface`/`sections`).

**Tests:** pgTAP (RPC returns only safe columns — assert `source_email` is absent; live-only; `open` vs
`members` row sets; radius null vs bounded); API unit (arg mapping). **Live tuning waits on the roster CSV.**

**Risk:** MEDIUM (PII projection is the sharp edge) — the definer must be column-audited in review; a pgTAP
test asserting no PII column is returned is mandatory.

---

## 4. C3 — Supplier marketplace *(needs B1 `orgs`; MANDATORY security review)*

`orgs` (`0136`) already exists with live-or-own read, owner UPDATE, slug definer and a column guard — but
**deliberately no client INSERT policy** (`0136:16-18,122`). C3 adds self-serve supplier creation, which is
the first client write to `orgs` and therefore carries a mandatory review.

**Migration ~0143:**
- INSERT policy: `with check (owner_id = auth.uid() and status = 'draft' and moderation = 'pending' and
  public.canPostAsMember(...))` — a member may create only a draft, pending-moderation supplier they own.
  **Moderation is a hard gate** (only `auto_approved`/`approved` + `live` are public — the existing
  `orgs_read`). Entitlement via the shared seam (§1).
- Extend the `orgs` column guard so an owner still can't set `status`/`moderation`/`owner_id`/`slug` on
  insert or update (server/definer-managed) — the `0131`/`0136` diff-and-raise pattern.

**API + web + admin:** `orgs.create`/`orgs.update` protectedProcedure (RLS + entitlement enforce authority);
a web self-serve supplier composer + the supplier's public directory page (gated on `sections.suppliers`,
A2); the moderation queue is the EXISTING `moderation_queue` + `adminActions.resolveReport` (no new admin
surface — report-then-act, like events).

**Tests:** pgTAP is the centre of gravity — a non-member cannot insert; a member can insert ONLY draft+
pending+self-owned; the guard blocks status/moderation/owner escalation; a non-approved org is invisible to
anon. API unit for the composer mapping.

**Risk:** MEDIUM–HIGH (first client write to a directory entity) — mitigated by mirroring the venue-claim
discipline (authority in RLS + a column guard, entitlement in a definer boolean) and the mandatory review.

---

## 5. C4 — Employability board *(needs B1 members; decision #3: post-and-apply-out)*

A member-posted local jobs board. **v1 is post-and-apply-out** (decision #3): **no CV storage, no ATS, no
applicant PII** — a post carries an external apply link, nothing more.

**`job_posts` (migration ~0144)** — modelled line-for-line on `events` (`0099`): `author_id → profiles`,
`channel_id` (scopes it to F2G), `title`/`description`, `locality`/`locality_label`, optional `venue_id` +
`location_name`, `employment_type` (soft enum, API-validated), `apply_url` (the apply-out link),
`expires_at`, `status` (`published`/`closed`), `moderation moderation_status default 'auto_approved'` (the
optimistic posture + report-then-act backstop events uses), world-readable-while-approved read + author-owned
writes. A nightly **expiry sweep** flips past-`expires_at` posts to `closed` (the `events`/cron pattern).

**Entitlement:** creation gated on the shared seam (§1) — **free for live members** (decision #9); no billing.

**API + web + admin:** `jobs.create`/`jobs.list`/`jobs.close` (create/close protected + entitlement-gated;
list public), gated on `sections.jobs` (A2); a web board + composer; moderation via the existing
`moderation_queue`. **No applicant data path exists in v1** — the apply button is an outbound link.

**Tests:** pgTAP (non-member cannot post; author-owned writes; approved-only visibility; expiry sweep
closes past posts); API unit (validation, apply_url required, no PII fields accepted).

**Risk:** LOW — smallest, most self-contained slice; the "no applicant PII" boundary is enforced by simply
not modelling it.

---

## 6. Sequencing, dependencies, risk

**Recommended order:**
1. **C1** (FSA) — starts with the D4 `VenueFacts` extraction (unblocks a cleaner venue page for everything
   after), and its matching reuse validates the `external_refs` `fsa` path end to end.
2. **C4** (jobs) — smallest, fully buildable/testable now on the `events` template; exercises the shared
   entitlement seam first, cheaply.
3. **C3** (suppliers) — the entitlement seam proven by C4; carries the mandatory review for the first `orgs`
   client write.
4. **C2** (directory) — the scale surface; benefits from C1's FSA join and is the one whose live tuning most
   depends on the roster CSV.

**Buildable-now vs blocked:**
- **Buildable + testable on fixtures now:** all four (schemas, core rules, RPCs, moderation, entitlement,
  render) — same posture as Phase B.
- **Waits on the roster CSV (decision #1):** C2's live directory data + relevance tuning; C3/C4 have real
  member posters only once members are live (import + claim run).
- **Waits on env:** C1's FSA sync endpoint; the FSA open-data URL/config.
- **One open product question:** C2's directory pages are the F2G host's OWN indexable pages — under A3-b's
  Consolidated model they could self-canonical to the F2G origin (the microsite edge). Confirm at C2 build.

**Cross-cutting invariants (every slice):** moderation hard gate; entitlement via the one seam; service-
managed PII never projected to clients (definer + safe columns); one slice = one PR, green through both
gates; migration numbers assigned at build time.

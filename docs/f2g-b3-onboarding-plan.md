# B3 — bulk onboarding: import → match → invite → claim (implementation-depth plan)

> **This is a plan, not a change.** No code until approved. Companion to
> [`f2g-association-build-plan.md`](./f2g-association-build-plan.md) and the B1 plan. Grounded against
> `main` (post B1/B2/B4a + the storefront-incident safeguards; highest migration `0137`).
>
> **B3 is the slice the engagement turns on, and the highest-risk one:** an accepted invite **confers
> venue ownership**. It carries a **mandatory security review** — adversarial pgTAP + a human read of
> the token + conferral paths, no green no merge. Two live dependencies gate the *run* (not the build):
> the **roster CSV** (decision #1) and having **`0135`–`0137` applied to the live DB** (release runbook).

---

## 0. Scope & sub-slices

B3 turns the Association's roster into claimable, live members. Four parts, each its own PR so the
security-critical one is reviewed in isolation:

| Sub-slice | What | Migration? | Security review |
|---|---|---|---|
| **B3-a** | **Import** — ingest the CSV into `channel_members` verbatim, idempotent by `membership_ref` | optional `channel_import_runs` | standard |
| **B3-b** | **Match** — run B2's matcher over the roster → `external_refs`; accept/review/reject bands | none | standard |
| **B3-c** | **Places backfill** — budgeted, phased enrichment of matched venues with thin data | none | standard |
| **B3-d** | **Invite → claim** — HMAC invite email + `claim_channel_member_venue` conferral | **`0138` claim fn** | **MANDATORY (ownership grant)** |

Recommended build order: B3-a → B3-b → B3-c → **B3-d last** (the reviewed capstone).

---

## 1. Grounding (file\:line — the patterns B3 reuses, not reinvents)

| Primitive | Where | B3 use |
|---|---|---|
| **Ownership conferral** — `SECURITY DEFINER`, `for update` lock **claim then venue**, idempotency guard, sets `venues.owner_id` **only here** | `0007_venue_claim_approval.sql` `approve_venue_claim` | the exact shape `claim_channel_member_venue` mirrors |
| **Stateless HMAC capability token** — `id.hmac`, constant-time verify, null-secret = off | `packages/api/src/ownerDigest/token.ts` | the invite token (member+venue+exp, signed) |
| **Internal job auth** — `internalProcedure` (x-internal-call secret) | `packages/api/src/trpc.ts:141` | the import endpoint |
| **Two-trigger job → web route → internal tRPC** | `apps/web/src/app/api/ingest-food-to-go/route.ts` + `lib/internalTrpc` | `POST /api/jobs/import-roster` |
| **Budgeted Places pull** — `claim_places_fetch_quota` / `PLACES_DAILY_FETCH_BUDGET` | `packages/api/src/places/budget.ts`, `places.ingestFoodToGo` | B3-c backfill (decision #5: phased within existing quota) |
| **Transactional email** | `packages/api/src/brevo/transactional.ts` `sendTransactionalEmail` | the invite email |
| **Roster + status machine + match ledger** (B1/B2) | `channel_members` (0135), `external_refs` (0137), `@roam/core/membership.canTransition`, `@roam/core/matching.resolveCandidates` | the spine B3 drives |
| **Cap-proof pagination** | `deliverOwnerDigest.ts`, B4a `channelOnboardingStats` | iterating the roster |

---

## 2. B3-a — Import (CSV → `channel_members`, idempotent)

- **Core** `packages/core/src/membership/import.ts` (pure, unit-tested): `parseRosterCsv(text)` → typed rows
  with a **column-mapping** tolerant of header variants (name/postcode/email required; address/council/
  phone/ref optional — see the roster field spec in the Association request list); per-row validation
  (an invalid row is *collected as an error*, never silently dropped); derive `membership_ref` via
  `normaliseMembershipRef` (fallback to a stable hash of name+postcode when the source has no id);
  `normalisePostcode` for the block key. Keeps `source_raw` = the untouched row.
- **Job** `packages/api/src/jobs/importRoster.ts`: upsert each row into `channel_members` on
  `(channel_id, membership_ref)` (the 0135 unique key) — **insert new, update source_\* on re-import,
  never duplicate**; status defaults `imported`. Uses the service client; **cap-proof batched** writes.
  Returns a per-run report (counts + the collected row errors).
- **Transport**: `jobs.importRoster` `internalProcedure` + `POST /api/jobs/import-roster` (Node runtime,
  holds the x-internal-call secret) — invoked from the B4 admin (a staff upload) or a one-off script.
  The CSV itself is passed as text/opaque; **never logged** (it carries PII).
- **Migration (optional, recommended)** `channel_import_runs` (~`0138`): one row per run — channel, actor,
  counts (`imported/updated/matched_accept/review/reject/backfilled/invited/errors`), `started_at`/
  `finished_at`, a JSON error sample. Service-managed (no client policy); surfaced read-only in B4's
  "import reports". Makes every bulk action auditable.

## 3. B3-b — Match (B2 over the roster → `external_refs`)

- **Candidate fetch** (thin DB read, `core/matching` stays pure): for a member, load venues in the same
  **postcode block** — `extractPostcode(venues.address)` can't be indexed, so block by the member's
  `source_postcode` outward code against a venue set near the member (reuse the NI fence), then score in
  JS with `resolveCandidates`. Fixtures already cover the NI-hard cases (chains, shared postcodes, null
  geocodes).
- **Persist** each decision to `external_refs` (0137): `accept` → one row `(channel_member, roam_venue,
  venue_id, method='auto', score)` **and** set `channel_members.venue_id`; `review` → queued for B4's
  match-review queue (no auto-bind); `reject` → left unmatched. **Idempotent + correction-safe**: never
  overwrite a `method='manual'` row (a human correction is permanent — the reverse index prevents
  binding two members to one venue).
- **Thresholds are B2's exported constants** — **calibrate on the roster sample first** (that's what the
  50-row CSV unblocks) before the full run.

## 4. B3-c — Places backfill (budgeted, phased)

- For matched-live members whose venue has thin data (no photo/hours/rating), enrich via the existing
  `places.ingestFoodToGo` path, **governed by `claim_places_fetch_quota` / `PLACES_DAILY_FETCH_BUDGET`**
  — decision #5: **phased within the existing quota**, no burst. When the daily budget is exhausted the
  job records "deferred" and the next run resumes; full hydration takes days, by design. No new budget
  knob, no new cost ceiling.

## 5. B3-d — Invite → claim (the ownership-grant path; MANDATORY security review)

**Token (Node, mirrors `ownerDigest/token.ts`)** `packages/api/src/f2g/inviteToken.ts`:
`sign(memberId, venueId, expTs, secret)` → `` `${memberId}.${venueId}.${expTs}.${b64url(hmac)}` ``;
`verify(token, secret)` → `{ memberId, venueId, expTs } | null`, **constant-time** compare, rejects a
null secret, and rejects when `expTs < now`. **Stateless** — no token table; **single-use is enforced by
STATE** (below), and **expiry is signed into the token**.

**Conferral (migration `~0138`) `claim_channel_member_venue(p_member_id, p_venue_id, p_claimant_id)`** —
a `SECURITY DEFINER` fn modelled line-for-line on `approve_venue_claim`:
- lock order **channel_members then venues** (`for update`);
- **guards** (each a typed SQLSTATE): member exists & belongs to the channel; `member.venue_id = p_venue_id`
  (token can't be re-pointed to another venue); member status ∈ {`imported`,`invited`} (single-use — a
  second accept finds `claimed` and is a **no-op if same claimant, reject if different**); the venue is
  **not already owned by a different user** (never steal an existing claim);
- **confer**: `venues.owner_id = p_claimant_id, status='claimed'` (the dangerous write, here and only here);
  advance `channel_members.status='claimed', claimed_by=p_claimant_id, claimed_at=now()`;
- **revoke execute from public/anon/authenticated; grant service_role only** (the existence-oracle/privilege
  lesson) — the API calls it with the service client *after* verifying the token and the signed-in claimant.

**API** `channels.claimWithInvite({ token })` `protectedProcedure`: `verify()` the token in Node → the
claimant is `ctx.user` (must be signed in) → call the definer via the service client → advance and audit.
Then `adminActions.sendInvite(memberId)` / `resendInvite` (or a job) issues the signed link and delivers
via Brevo to `source_email`, stamping `channel_members.invited_at` and status→`invited`.

**Web** a claim landing page (`/f2g/claim?token=…`): signs the user in if needed, calls
`claimWithInvite`, shows success/expired/already-claimed. **Every unclaimed member page must already look
alive** (name/category/address/map/hours/FSA-later/member badge + "Is this your business?") so the invite
lands somewhere credible — a first-class design task in this sub-slice.

### 5.1 Security decisions to confirm at review (these shape B3-d)
1. **★ Invite model — capability-link vs email-bound.** A signed link = whoever holds it (and signs in)
   becomes owner, matching Roam's existing claim norm. **Recommend: capability-link + short expiry +
   single-use + link emailed only to `source_email`**, and record the claiming user. Stricter option:
   also require the signed-in user's *verified* email to equal `source_email` (blocks a forwarded link,
   at the cost of owners who sign up with a different address). Pick one at review.
2. **Token expiry window** (recommend **14 days**) + resend (new exp, same member/venue).
3. **Accept side-effects** — recommend accept also **tags the venue into `venue_channels`** (members-mode
   readiness; harmless in open mode) so a later mode flip needs no backfill.
4. **Secret** — a dedicated `F2G_INVITE_SECRET` (not reusing the digest secret); rotation invalidates
   outstanding links (acceptable — resend).

## 6. Tests (no green, no merge)
- **pgTAP `0138`** — adversarial: **forged signature** (wrong secret → reject), **expired** token,
  **replay** (second accept no-ops/rejects per claimant), **wrong-venue** binding, **already-owned**
  venue (no steal), and `execute` **revoked** from anon/authenticated.
- **Core unit** — `parseRosterCsv` (header variants, bad rows collected, ref/postcode normalisation,
  idempotent ref), and the match-orchestration decision mapping (accept/review/reject → external_refs ops).
- **API unit** — `inviteToken` sign/verify (tamper, expiry, null-secret), import upsert idempotency.

## 7. Done-checks · risk · sequencing
- **Done:** a CSV import populates `channel_members` idempotently with a run report; the matcher fills
  `external_refs` + `venue_id` for accepts and queues reviews; a signed invite email delivers; accepting
  confers ownership exactly once and advances status; every adversarial pgTAP passes; the security review
  sign-off is recorded.
- **Risk: HIGH** (ownership grant) — mitigated by mirroring the proven `approve_venue_claim` conferral,
  state-enforced single-use, signed expiry, service-role-only execute, and the mandatory review.
- **Build now vs run later:** all four sub-slices are **buildable and fully testable on fixtures now**.
  The **live run** waits on the roster CSV (import + calibration) and `0135`–`0137` being applied to the
  live DB (+ `supabase migration repair`). B3-d's `0138` will itself need applying + a PostgREST reload —
  the drift guard/runbook (#2) now cover exactly that.
- **Unblocks:** **B4b** (match-review queue consumes B3-b's `review` rows; invite resend consumes B3-d),
  and **C2**'s live member directory.

## 8. Open dependency
The single hard external dependency remains the **Association roster CSV** — it calibrates B2's thresholds
(B3-b) and is the input to the live import (B3-a). Everything in this plan is built and green on fixtures
before it arrives; the CSV turns it on.

---

## 9. B3-d — as built (the ownership-grant capstone)

B3-d shipped as its own reviewed PR. What landed and the security posture it carries:

**Files**
- `supabase/migrations/0139_claim_channel_member_venue.sql` — the `SECURITY DEFINER` conferral +
  its typed result type; `supabase/tests/0139_claim_channel_member_venue_test.sql` — 17 adversarial
  pgTAP assertions.
- `packages/api/src/f2g/inviteToken.ts` — the HMAC capability token (+ `inviteToken.test.ts`, 8 tests).
- `packages/api/src/f2g/invite.ts` — `claimMemberVenue` (definer outcome mapping) + `sendMemberInvite`
  (issue link → Brevo → stamp invited) + `renderInviteEmail` (+ `invite.test.ts`, 19 tests).
- `packages/api/src/routers/f2g.ts` — `claimWithInvite` (`protectedProcedure`).
- `packages/api/src/routers/adminActions.ts` — `sendInvite` (`adminProcedure`, audited; idempotent = resend).
- `apps/web/src/app/f2g/claim/page.tsx` — the claim landing page (sign-in → claim → rendered outcome).
- `apps/admin/.../views/Channels.tsx` — an Invite/Resend action per matched member in the roster tab.
- `ApiEnv.f2g` (`context.ts` / `server.ts`) — `F2G_INVITE_SECRET` (+ `F2G_INVITE_TTL_DAYS`, default 14).

**Security decisions taken (§5.1)**
1. **Invite model = capability-link** (per the build instruction): whoever holds a valid, unexpired
   link AND signs in becomes owner; the link is emailed only to `source_email`, and the claiming user
   is recorded (`channel_members.claimed_by`). The stricter verified-email-equals-source-email variant
   was **not** taken (it would lock out owners who sign up with a different address); revisit at review
   if the Association wants it.
2. **Expiry = 14 days**, signed into the token; **resend** issues a fresh expiry (same member/venue).
3. **Accept side-effect** = the conferral also tags the venue into `venue_channels` (members-mode
   readiness; harmless in open mode), inside the same transaction.
4. **Secret** = a dedicated `F2G_INVITE_SECRET` (not the digest secret); rotation invalidates
   outstanding links (staff resend).

**Conferral safety (mirrors `approve_venue_claim`)** — `SECURITY DEFINER`, `search_path` locked,
non-recursive; fixed lock order **member → venue**; `venues.owner_id` written **here and only here**;
guards raise typed SQLSTATEs (`VENUE_MISMATCH` / `NOT_CLAIMABLE` / `CLAIMED_BY_OTHER` / `MEMBER_NOT_FOUND`);
single-use enforced by **state** (claimable only while `imported`/`invited`); a same-claimant re-click
is an idempotent no-op; an already-owned venue is never re-conferred. `execute` **revoked** from
public/anon/authenticated, **granted to `service_role` only** — the API escalates to it only *after*
verifying the token and the signed-in claimant. Every one of these is asserted in pgTAP.

**Runbook note** — applying `0139` to the live DB needs `notify pgrst, 'reload schema'` after the DDL
(the #2 drift guard / release runbook cover this). The **live run** still waits on the roster CSV +
`0135`–`0138` (and now `0139`) being applied. **Mandatory human security review of the conferral +
token + grant remains the gate before the feature is switched on.**

# F2G whitelabel platform — holistic plan (2026-09-17)

**Input:** [`f2g-platform-recon-2026-09.md`](./f2g-platform-recon-2026-09.md) (as-built, 129 verified
gaps, 12 blockers) + Andrew's decisions of 2026-09-17 (§1). **Output:** the target shape of the NI
Food to Go Association ("F2G") whitelabel and the phased work to get there. Status legend for the
recon gaps it closes: **B** blocker · **H** high · **M** medium.

## 1. Decisions taken (2026-09-17)

| # | Question | Decision |
|---|---|---|
| D1 | Independence model | **A separate F2G app in this monorepo** ("a branch away from Roam, still attached"): its own build, host and release cadence; **same database and the same API** — Roam core is the engine, so any activity on F2G is activity on Roam and vice versa. F2G is bespoked to the Association (employability board, supplier directory, member directory, …). |
| D2 | Association portal | **Basic, mostly read-only.** |
| D3 | Orders visibility to the Association | **To be settled together** — options in §5.3 with a recommendation. |
| D4 | Feature requests | **A table + a Roam HQ queue, with status visible to the Association.** |
| D5 | Commission | **Copy is wrong; the F2G fee is 7%.** (Roam's default stays 5% unless told otherwise — §5.4.) |
| D6 | Email sender | **Co-branded Roam.** |
| D7 | Hosting reality (Netlify vs Vercel; how nifood2go maps) | **Unknown — establish together** (§2). |
| D8 | Membership rule | **Membership number is the validation key.** The Association issues each member a unique membership number; a business that activates with a valid number is recognised as an *active member* (priority + recognition). Non-members are still encouraged to claim/activate, without membership priority. The portal must list activated/claimed businesses. |

Still open (settled inside the phases, flagged where they bite): the Roam-side fee (§5.4); whether
Association officers see roster e-mails or aggregates only (§5.2); Supabase Auth e-mail branding
(§5.5); custom domain (recon decision #8).

## 2. Phase 0 — establish the facts (this week, no code)

Three things the repo cannot tell us, each a 10-minute check on your side:

1. **Where the web app runs.** From your laptop: `curl -sI https://nifood2go.roam-local.com | grep -i -E "^(server|x-nf-|x-vercel)"` — a `server: Netlify` / `x-nf-request-id` header means Netlify; `x-vercel-id` means Vercel. Then in that host's dashboard: is `nifood2go.roam-local.com` a **domain alias on the Roam site** (expected) or a second site? Note the site name(s).
2. **How nifood2go resolves to the f2g channel.** In the same dashboard, list the environment variables: is `NEXT_PUBLIC_F2G_HOSTS` set (env classifier) or not (DB `channel_domains` row + `/api/channel-map`)? Paste the variable names (not values).
3. **Which scheduled jobs actually exist.** In Railway, list the services: which of `cron-owner-digest`, `cron-cj-logos`, `cron-sync-fsa-ni` exist and their schedules. Also whether the GitHub repository secrets `SUPABASE_ACCESS_TOKEN` / `SUPABASE_DB_URL` (or equivalents) are set — the migrate and drift workflows are silently inactive without them.

Plus one legal fact: **who is data controller for the roster** the Association supplies (names, e-mails,
membership numbers). The plan assumes the Association is controller and Roam is processor under a
short data-processing agreement; that wording is needed before the portal shows roster rows (§5.2).

## 3. Target architecture

### 3.1 One engine, two apps

```
                 ┌──────────────── Supabase (one project, one migration ledger, Roam-owned) ───────────────┐
                 │  venues · orders(+channel_id) · profiles · channels · channel_members · job_posts · orgs · fsa_* │
                 └──────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                        │
                       ┌────────────── packages/api (one tRPC service on Railway; Roam-owned) ─────────────┐
                       │  all writes; channel-aware links/fees/sender; associationProcedure; HQ procedures  │
                       └───────────┬─────────────────────────────────────────────┬─────────────────────────┘
                                   │                                             │
        ┌──────────── apps/web (Roam) ───────────┐              ┌──────────── apps/f2g (F2G) ────────────┐
        │ roam-local.com · Roam chrome, social IA │              │ nifood2go.roam-local.com · Association │
        │ no F2G branches after Phase 3           │              │ chrome · storefront · directory · jobs │
        │                                         │              │ · suppliers · claim/activate · portal   │
        └─────────────────────────────────────────┘              └────────────────────────────────────────┘
                 ▲ shared UI: packages/design, packages/venue-ui (venue page, shop, checkout), packages/core
        ┌──────────── apps/admin (Roam HQ) ────────────┐
        │ channels · roster · feature-request queue · FSA │
        └─────────────────────────────────────────────┘
```

- **`apps/f2g`** is a new Next.js app: always channel `f2g` (no host classifier, no cookie dance), its
  own `NEXT_PUBLIC_*`, SEO/OG/sitemap/robots, legal pages, i18n catalogue and deploy site. It contains
  the storefront, the three Association features, claim/activate, and the portal.
- **`packages/venue-ui`** (new) holds what both apps render identically — venue page, shop, basket,
  checkout, FSA badge, photo strip — so the agency can restyle the F2G *chrome* without forking the
  *engine* UI, and a checkout fix ships to both. `apps/web` loses every `surface === "storefront"` /
  `isF2G` branch once `apps/f2g` is live (recon §5 coupling points).
- **`packages/api` stays single and Roam-owned.** It becomes *channel-aware where it must be*:
  absolute links (Stripe return, invite claim, digest) come from the channel's origin; the platform
  fee comes from the channel; e-mail sender name is co-branded per channel; orders are stamped with
  the channel they were placed on. Nothing else forks.
- **Release independence** comes from the repo, not from separation of data: path-filtered CI/deploy
  per app (turbo `--filter=...[origin/main]`), a second hosting site for `apps/f2g`, `CODEOWNERS`
  (agency owns `apps/f2g` + F2G packages; Roam owns `packages/api`, `supabase/`, `apps/web`,
  `apps/admin`), and the migrate workflow made live. The F2G kill switch stops being "silently become
  Roam" and becomes an explicit maintenance page on the F2G host.

### 3.2 Membership model (D8)

- **The roster is the source of truth for membership; the membership number is the key.**
  `channel_members.membership_ref` already stores the Association's reference per row (it is the CSV
  idempotency key). It becomes the validation credential: *activate with your membership number*.
- **Canonical definition — one, used everywhere:** an *active member* is a `channel_members` row with
  `status = 'live'` linked to a venue. Priority ranking (`f2g_member_venue_ids`), the directory, the
  jobs composer, supplier posting and the portal's counts all read exactly that. (Today three
  definitions compete and nothing ever writes `live` — recon 4.4, B.)
- **Two activation paths on the F2G site:**
  1. *Member:* claim/activate the venue → enter membership number → server checks the number against
     the roster **and** a second factor from the roster row (postcode outward code or e-mail domain
     match) so a number cannot be guessed → row → `live`, venue linked, `venue_channels.role='member'`.
  2. *Non-member:* claim/activate without a number → venue listed on the storefront, tagged
     `venue_channels.role='listed'`, no priority, no member entitlements, with a standing
     "become a member" prompt linking to the Association.
- **Lifecycle:** each roster re-import is the roster of record — rows absent from the new file →
  `lapsed` after a 30-day grace (loses priority, keeps the listing); HQ/portal can see who lapsed.
  Staff in HQ can still set `live` manually for edge cases; every status change is audited.
- **The invite flow stays** (e-mail with claim link) but the link no longer confers ownership by
  itself: it pre-fills the membership number and still requires sign-in with an account whose e-mail
  matches the roster row or a second factor (closes the bearer-link risk, recon 4.1).
- **Self-tagging into any channel via PostgREST is removed** (recon 4.1, H): tagging becomes
  server-side, NI-fenced, and can only produce `role='listed'`.

### 3.3 Association portal (D2) and feature requests (D4)

- **Role:** a new `channel_admins` table (`channel_id`, `profile_id`, `role` in `officer|viewer`,
  audited), managed from Roam HQ. Officers sign in with an ordinary account; the portal lives at
  `/association` on the F2G host and renders only for that role. API: an `associationProcedure`
  that resolves the caller's channel from `channel_admins` (never from the header hint) and scopes
  every read to it.
- **Portal v1 (read-only):**
  - *Overview:* members total / invited / claimed / live / lapsed; activated non-members; venues by
    council; FSA-rated share among members; jobs (active / total); suppliers (approved / pending);
    orders per period as agreed in §5.3.
  - *Members list:* business, venue, council, membership number, status, activated date — the
    "activated / claimed businesses" list you asked for. Filter + CSV export.
  - *Feature requests:* create (title, detail, category), list with Roam status and notes.
  - *No* writes to membership, no venue editing, no customer data.
- **Feature requests:** table `channel_feature_requests` (`channel_id`, `created_by`, `title`, `detail`,
  `category`, `status` in `new|triaged|planned|in_progress|shipped|declined`, `roam_notes`, timestamps);
  RLS: officers read/insert their channel's rows; HQ full; status changes audited. HQ gets a queue
  view. Notifications: new request → e-mail to a Roam inbox (Brevo transactional); status change →
  e-mail to the requester. The Association sees status in the portal.

### 3.4 Money, comms, legal (D5, D6)

- **Per-channel platform fee:** `channels.platform_fee_bps` (F2G = **700**); checkout reads the fee from
  the order's channel; Roam keeps the global default. The storefront hero's "No commission" line is
  replaced with a truthful statement, and the vendor readiness checklist and the F2G terms state the
  7% fee. (Recon 4.4, H.)
- **Co-branded Roam comms:** per-channel sender display name ("NI Food to Go Association · Roam"),
  co-branded header in transactional templates, links to the channel origin. Buyer order
  confirmation and immediate vendor new-order e-mail/push are added (today: none — recon 4.4, H).
  Supabase Auth e-mails: one neutral co-branded template set for the project (§5.5).
- **Legal on the F2G host:** terms, privacy, attributions (FSA/OGL, Google) as real pages, plus a
  consent banner gating GA4 on every host (recon 4.4, H). Data-processing wording for the roster.

## 4. Phases

Effort is engineer-days of focused work including tests and review, not calendar time. Each phase
is one or more PRs on green; migrations continue to be applied by you from supplied SQL.

### Phase 1 — Truth and safety on the live site (≈ 9 days, start now)

Closes what is wrong or unsafe *today*, without waiting for the split.

| # | Work | Recon gap | Days |
|---|---|---|---|
| 1.1 | Per-channel fee (`channels.platform_fee_bps`, F2G 700) + checkout reads it; hero copy corrected; fee stated in vendor checklist | 4.4 H | 1.5 |
| 1.2 | `live` transition: HQ "Mark live" action (interim until 2.2), audited; header nav shows Directory / Jobs / Suppliers when the section is on; HQ can toggle `directory`; live sections codified in a migration | 4.4 B, 4.2 H, M | 1.5 |
| 1.3 | Consent banner gating GA4; F2G legal pages (terms incl. 7% fee, privacy, attributions) served on the F2G host | 4.4 H, 4.2 H | 1.5 |
| 1.4 | Alerting + health: `/healthz` on the API, uptime check, error tracking (Sentry or equivalent) on web/API/crons; channel-resolution fail-open now alerts | 4.4 H, 4.2 H | 1.5 |
| 1.5 | Make migrate/drift workflows live (secrets), broaden the drift guard to every 0134+ object, add the missing 0146 pgTAP; `venue-media` storage policy into a migration | 4.1 H | 1 |
| 1.6 | Function EXECUTE hardening migration (the ~43 `revoke … from public`-only functions) + pgTAP | 4.1 H | 1 |
| 1.7 | Supplier approval path in HQ (approve/reject pending orgs, audited) | 4.4 H | 1 |
| | Decision needed before 1.1: Roam's own fee stays 5%? | | |

### Phase 2 — Membership spine v2 + order attribution (≈ 10 days)

| # | Work | Recon gap | Days |
|---|---|---|---|
| 2.1 | `orders.channel_id` (+ backfill rule: none — from now on), stamped at checkout; per-channel origin (`channels.origin`) used for Stripe return, invite and digest links | 4.3 H, 4.2 H | 2 |
| 2.2 | Membership-number activation: API `f2g.activateWithMembership` (number + second factor), sets `live`, links venue, `venue_channels.role`; non-member activation path (`listed`); canonical member definition applied to ranking, directory, entitlements; server-side tagging replaces PostgREST self-tag | 4.4 B, 4.3 H, 4.1 H | 4 |
| 2.3 | Roster lifecycle: re-import → `lapsed` after grace; import reports readable in HQ; duplicate-venue guard in auto-accept | 4.4 H, 4.3 M | 2 |
| 2.4 | Invite hardening: link pre-fills number, requires matching sign-in; secret rotation documented | 4.1 M | 1 |
| 2.5 | HQ: mask roster e-mail by default, audit PII reads; membership-number column in Roster view | 4.3 H | 1 |
| | Decisions needed: second factor (postcode vs e-mail); grace period; orders visibility (§5.3) | | |

### Phase 3 — The separate F2G app (≈ 18 days)

| # | Work | Recon gap | Days |
|---|---|---|---|
| 3.1 | `packages/venue-ui`: extract venue page, shop, basket, checkout, FSA badge, photo strip from `apps/web` with no behaviour change; both apps consume it | 4.2 B | 5 |
| 3.2 | `apps/f2g`: new app (fixed channel, own env/SEO/OG/sitemap/robots/i18n/legal), storefront + directory + jobs + suppliers + claim/activate moved in; F2G-specific components move to `packages/f2g-ui` | 4.2 B, H | 6 |
| 3.3 | Hosting: second site for `apps/f2g` on the host from Phase 0, `nifood2go` moved to it; Supabase Auth redirect allow-list; per-app `WEB_ORIGIN` | 4.2 H | 1.5 |
| 3.4 | Release gates: path-filtered CI + deploy per app, `next build` in CI for both apps, web smoke tests, `CODEOWNERS`, branch protection; F2G maintenance page replaces fail-open | 4.2 H | 2.5 |
| 3.5 | Remove every F2G branch from `apps/web`; delete the host classifier; `channels.nav` either rendered or dropped | 4.2 M | 2 |
| 3.6 | Ops: F2G runbook (jobs, budgets, who is paged), job run history table, Railway cron services confirmed, photo-refresh and job-expiry crons committed | 4.4 M, 4.2 H | 1 |
| | Decisions needed: agency access model (§5.1); host from Phase 0 | | |

### Phase 4 — Association portal v1 + feature requests (≈ 12 days)

| # | Work | Recon gap | Days |
|---|---|---|---|
| 4.1 | `channel_admins` + `associationProcedure` + HQ management of officers; pgTAP for scoping | 4.3 B | 2 |
| 4.2 | Aggregate RPCs (members funnel, venues by council, FSA share among members, jobs, suppliers, orders per §5.3), channel-scoped, audited | 4.3 B/H | 3 |
| 4.3 | Portal UI in `apps/f2g/association`: overview, members list (+CSV), feature requests | 4.3 B | 4 |
| 4.4 | `channel_feature_requests` + RLS + HQ queue view + Brevo notifications both ways | 4.3 B/H | 3 |
| | Decisions needed: roster e-mail visibility (§5.2); orders visibility (§5.3) | | |

### Phase 5 — Co-branded comms, DR, data protection (≈ 7 days)

| # | Work | Recon gap | Days |
|---|---|---|---|
| 5.1 | Per-channel sender name + co-branded templates; buyer confirmation + vendor new-order e-mail/push; per-channel push (icon/title) | 4.4 H, 4.2 H/M | 3 |
| 5.2 | Backup/PITR/restore statement + tested restore; RTO/RPO in the runbook | 4.1 H | 1 |
| 5.3 | Roster data-protection: DPA wording, retention/erasure, `deleteMe` covering orders + roster, GDPR export | 4.1 H, 4.4 M | 2 |
| 5.4 | Regenerate DB types (needs Supabase CLI access), delete `LooseDb` casts | 4.1 H | 1 |

**Total ≈ 56 engineer-days**, roughly 11–12 weeks for one engineer, 6–7 with two working Phase 3
and Phase 4 in parallel after Phase 2. Phase 1 can start immediately; Phases 2 → 3 → 4 are
sequential on their data spines; Phase 5 runs alongside 3–4.

## 5. Decisions to settle together

### 5.1 The agency's access
Recommended: the agency works in this repository on `apps/f2g` and `packages/f2g-ui` with
`CODEOWNERS` review from Roam on anything under `packages/api`, `supabase/`, `apps/web`,
`apps/admin`; migrations are proposed by PR and applied by Roam. Alternative: a fork with a
one-way sync — more independent, but every engine change becomes a merge, and "activity on one is
activity on the other" is harder to keep true.

### 5.2 Roster PII in the portal
Option A (recommended for v1): officers see business, venue, council, membership number, status —
no personal e-mail/phone; the Association already holds those. Option B: show roster e-mail with
every read audited. Option A needs no DPA change and avoids the unmasked-PII issue the recon
found in HQ.

### 5.3 Orders visibility (D3)
| Option | What the Association sees | Trade-off |
|---|---|---|
| A. Totals | order count, GMV, fees per week/month for the channel | Simple, no venue consent question, low value per member |
| **B. Per-venue totals (recommended)** | A plus per-venue counts/GMV for *members*, no customer or line data | Shows members what the storefront does for them; needs one line in the membership terms |
| C. Line level | items, times, customers | Not needed for an association; customer-data exposure; no |
Whichever we pick, the data spine is the same (`orders.channel_id`, Phase 2.1), so it does not
block anything else.

### 5.4 Roam's own fee
`PLATFORM_FEE_BPS` default is 500 (5%). F2G becomes 700 via the channel. Confirm Roam stays 5%, and
whether any *venue*-level override is wanted (not planned).

### 5.5 Supabase Auth e-mails
One template set per project. Recommended: neutral co-branded templates ("Roam · powered
platform for NI Food to Go") rather than per-host variants, which Supabase cannot do.

## 6. What this plan deliberately does not do
- No second database, no data sync, no fork of `packages/api` — D1 says shared engine.
- No write features in the portal v1.
- No custom domain work (recon decision #8 stands until you say otherwise).
- No GB-wide FSA (backlog #52), no Phase 2b sweep (backlog).

## 7. Immediate next steps
1. You: the four Phase 0 checks (§2) and answers to §5.1–5.5.
2. Me: Phase 1.1 (fee + copy) and 1.2 (`live` + nav) as the first two PRs — they fix what a member
   sees today and unblock every member feature.

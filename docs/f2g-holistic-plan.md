# F2G whitelabel platform — holistic plan (2026-09-17, rev 3 of 2026-09-23)

**Input:** [`f2g-platform-recon-2026-09.md`](./f2g-platform-recon-2026-09.md) (as-built, 129 verified
gaps, 12 blockers) + Andrew's decisions of 2026-09-17 (§1). Rev 2 folds in an independent review of
rev 1 against the code (portal re-sequenced ahead of the app split; membership model corrected to the
real schema; Phase 3/4 re-scoped and re-estimated; dropped highs restored). **Output:** the target
shape of the NI Food to Go Association ("F2G") whitelabel and the phased work to get there. Recon gap
references use its section numbers; **B** blocker · **H** high · **M** medium.

**Rev 3 (2026-09-23)** folds in the real roster sample and the Association's answers. It is a
correction, not a refinement: there are **no membership numbers until 2027** and the sample has **no
e-mail column**, so the number can be neither the key nor the credential, and HubSpot — their CRM —
has to supply both. Changed: §2 item 4, §3.2, §3.5 (new), Phase 2.

## 1. Decisions taken (2026-09-17)

| # | Question | Decision |
|---|---|---|
| D1 | Independence model | **A separate F2G app in this monorepo** ("a branch away from Roam, still attached"): its own build, host and release cadence; **same database and the same API** — Roam core is the engine, so any activity on F2G is activity on Roam and vice versa. F2G is bespoked to the Association (employability board, supplier directory, member directory, …). |
| D2 | Association portal | **Basic, mostly read-only.** |
| D3 | Orders visibility to the Association | **Option B (2026-09-18):** channel totals **plus per-member-venue counts/GMV**; no customer or line data. Needs one line in the membership terms. |
| D4 | Feature requests | **A table + a Roam HQ queue, with status visible to the Association.** |
| D5 | Commission | **Copy is wrong; the F2G fee is 7%.** (Roam's default stays 5% unless told otherwise — §5.4.) |
| D6 | Email sender | **Co-branded Roam.** |
| D7 | Hosting reality (Netlify vs Vercel; how nifood2go maps) | **Vercel serves production (2026-09-18).** Project `roam-team/core-platform-web`, deploys from `main`; `www.roam-local.com` and `nifood2go.roam-local.com` are domains on the **same** deployment — the host classifier, not separate sites. A Netlify project (`roam-core-platform`) also builds this repo and posts PR previews; it is not production. Supabase API is on the custom domain `auth.roam-local.com`. |
| D8 | Membership rule | **The Association's membership number is the validation key.** A business that activates with a valid number is an *active member* (priority + recognition). Non-members are still encouraged to claim/activate, without membership priority. The portal must list activated/claimed businesses. |

**All of §5 settled 2026-09-18:** 5.1 (agency access — *changed*, see §5.1) · 5.2 (roster PII,
Option A) · 5.3 (orders, Option B) · 5.4 (Roam stays 5%) · 5.5 (Auth e-mail, **Option A — leave
Roam's templates alone**) · 5.6 (vendor console stays in `apps/web`) · 5.7 (activation second factor
as recommended). Custom domain: recon decision #8 stands (no).

## 2. Phase 0 — establish the facts (this week, no code)

Six things the repo cannot tell us. Each is a short check on your side; the plan is blocked on 4.

1. **Where the web app runs.** From your laptop: `curl -sI https://nifood2go.roam-local.com | grep -i -E "^(server|x-nf-|x-vercel)"`. `server: Netlify` / `x-nf-request-id` = Netlify; `x-vercel-id` = Vercel. In that dashboard: is `nifood2go.roam-local.com` a **domain alias on the Roam site** or a second site? Note the site name(s). The answer gets written into `docs/ARCHITECTURE.md` in Phase 4.3 (recon 4.2 H: hosting undocumented).
2. **How nifood2go resolves to the f2g channel.** Same dashboard, environment variables: is `NEXT_PUBLIC_F2G_HOSTS` set (env classifier) or absent (DB `channel_domains` row + `/api/channel-map`)? Paste variable **names** only.
3. **Which scheduled jobs and secrets exist.** Railway: which of `cron-owner-digest`, `cron-cj-logos`, `cron-sync-fsa-ni` exist, with schedules. GitHub repository secrets: are the Supabase access token / DB URL secrets set? (Without them the migrate and drift workflows silently skip — recon 4.1 H.)
4. ~~**A sample roster CSV with the membership-number column**~~ — **ANSWERED 2026-09-23, and it changed the design.** The sample is 48 rows of `Name | Postcode | Address | Town/City`. There is **no e-mail column, no phone, and no membership number**: the Association's CEO confirms numbers are not being issued until **2027**. They hold their membership data in **HubSpot**, and can supply the full list. Consequences are worked through in §3.2 below and in Phase 2; the short version is that the membership number can no longer be the credential *or* the key, and the CRM has to supply both.
5. **Supabase CLI access** for whoever regenerates DB types (recon 4.1 H: types stale since 0134; 182+ loose casts). A Phase 0 ask because it gates 5.4 and makes every later migration safer.
6. **Data controller for the roster.** The plan assumes the Association is controller and Roam is processor under a short data-processing agreement; that wording must exist before the portal shows roster rows (§5.2).

## 3. Target architecture

### 3.1 One engine, two apps

```
                 ┌──────────────── Supabase (one project, one migration ledger, Roam-owned) ───────────────┐
                 │ venues · orders(+channel_id) · profiles · channels(+fee,origin,contact) · channel_members │
                 │ (+lapsed_at) · venue_channels(+role) · channel_admins · channel_feature_requests · …       │
                 └──────────────────────────────────────┬───────────────────────────────────────────────────┘
                                                        │
                       ┌────────────── packages/api (one tRPC service on Railway; Roam-owned) ─────────────┐
                       │ all writes · channel-aware links/fee/sender · associationProcedure · HQ procedures │
                       └───────────┬─────────────────────────────────────────────┬─────────────────────────┘
                                   │                                             │
        ┌──────────── apps/web (Roam) ───────────┐              ┌──────────── apps/f2g (F2G) ────────────┐
        │ roam-local.com · Roam chrome, social IA │              │ nifood2go.roam-local.com · Association │
        │ vendor console (/dashboard) for now     │              │ chrome · storefront · directory · jobs │
        │ no F2G branches after Phase 4           │              │ · suppliers · activate · /association  │
        └─────────────────────────────────────────┘              └────────────────────────────────────────┘
          shared: packages/design · packages/core · packages/venue-ui (client) · packages/venue-server
                  (SSR/metadata/serverApi) · packages/web-auth (session, auth modal, Me) · packages/messages
        ┌──────────── apps/admin (Roam HQ) ────────────┐
        │ channels · roster · officers · request queue │
        └─────────────────────────────────────────────┘
```

- **`apps/f2g`** is a new Next.js app (precedent: `apps/admin` is already a second app with its own
  tRPC client). It is *always* channel `f2g` — no host classifier, no cookie — but must still send
  `x-roam-channel: f2g` on every browser and server call because the API resolves the channel from
  that header (`packages/api/src/context.ts:234`). Own `NEXT_PUBLIC_*`, SEO/OG/sitemap/robots, legal
  pages, i18n namespaces, hosting site, VAPID key.
- **What is shared, as packages, not copies.** The review found the storefront cannot be lifted out
  as "client components" alone: `app/venue/[id]/page.tsx` and `app/directory/page.tsx` are server
  components importing `lib/serverApi` (500 lines, `next/headers`-coupled), `lib/seo`, `lib/channel`;
  `VenueDetail` (1,975 lines) pulls in follow, plans, events, transit and offers; every venue/shop
  component calls `useTranslations` against the single 84-namespace `en.json`; auth is
  `TrpcProvider` + Supabase browser client + `AuthModal` + `MeProvider`. So the split is four
  packages, extracted with no behaviour change first, then consumed by both apps:
  `packages/venue-ui` (venue page with **slots** for the Roam-social parts, shop, basket, checkout,
  FSA badge, photo strip), `packages/venue-server` (serverApi, metadata, JSON-LD),
  `packages/web-auth` (session, auth UI, Me), `packages/messages` (the catalogue split into
  namespaces each app opts into). `next.config.ts` `transpilePackages` lists them; the web bundle's
  "no `@roam/core`" rule is inherited.
- **The vendor console stays in `apps/web` for v1** (§5.6). `VenueFoodToGo`, `VenuePayments`,
  `VenueOrders`, `VenueShopManager` mount at `/dashboard/[venueId]`; the F2G claim page already sends
  members there. It is engine functionality (menus, payments, orders); the F2G app links to it
  co-branded. Packaging it is a later phase if the agency needs to restyle it.
- **`packages/api` stays single and Roam-owned**, channel-aware where it must be: the channel of an
  order is derived server-side from the venue (never from the header hint); absolute links (Stripe
  return, invite, digest) come from `channels.origin`; the platform fee from `channels.platform_fee_bps`;
  the sender name from the channel. When the F2G flag is off, a fixed-channel client gets an explicit
  503/maintenance, never Roam's config (today `channels.current` silently substitutes Roam —
  `routers/channels.ts:107-109`).
- **Server-to-server routes and the secret.** Ten `apps/web/src/app/api/*` handlers (ingest,
  enrich-venue, …) call the API with the single platform-wide `INTERNAL_CALL_SECRET`, and the venue
  page fires `/api/enrich-venue`. The plan gives each app its **own** secret with a **scope list** on
  the API side (which procedures that secret may call), so the F2G deploy can never call ban/approve/
  credits (recon 4.2 H, dropped in rev 1).
- **Release independence** comes from the repo: hosting config *in the repo* per app, path-filtered
  CI/deploy (`turbo --filter=...[origin/main]`), `next build` for both apps in CI, `CODEOWNERS`
  (agency: `apps/f2g`, `packages/f2g-ui`; Roam: `packages/api`, `supabase/`, `apps/web`, `apps/admin`,
  the shared packages), the migrate workflow live.

### 3.2 Membership model (D8) — against the real schema

> **REVISED 2026-09-23 after the real sample arrived.** The first bullet below said the membership
> number is the key and becomes mandatory. That is now impossible: there are no numbers until 2027.
> The revision is stated first because it invalidates the original premise, not because it refines it.

- **~~The membership number is the key, and it becomes mandatory.~~ There is no number.** The sample
  carries none, and the Association is not issuing them until 2027, so `membership_ref` falls back to
  the derived `AUTO:name|postcode|e-mail` key (`packages/core/src/membership/import.ts:103-106`) —
  which on this roster reduces to name+postcode, **both fields the Association edits**. Correct a typo
  in their spreadsheet and the derived key changes, so the next import *inserts a duplicate member
  instead of updating one*. The idempotency guarantee in `0135:62-63` is only as stable as the key fed
  to it, and this key is not stable. **Resolution: identity comes from the CRM.** The Association runs
  **HubSpot**, whose object ids are immutable, so `channel_members` gains `source_system` +
  `source_system_id` and `membership_ref` is derived from those. The 2027 membership number lands in a
  separate `member_no` column as an *attribute*. **The key never becomes the number** — re-keying a
  roster later is a migration nobody should sign up for, and a second whitelabel may have no numbers
  at all.
- **The credential is e-mail possession, not a number.** The sample has no e-mail column either, and
  `sendMemberInvite` returns `no_email` without one (`packages/api/src/f2g/invite.ts:179`) — so today
  **100% of this roster is un-invitable** and the funnel stalls at step three, silently. HubSpot holds
  the contact e-mail the spreadsheet omits; that is the integration's first job, ahead of any
  convenience. §5.7's "second factor" (verified account e-mail equals the roster e-mail, or a one-time
  code to it) is therefore **promoted to the primary and only factor** until 2027, when the number
  becomes a genuine second one. That is a real reduction in assurance and is recorded as such.
- **Consequently, match quality is an access-control decision, not a data-quality one.** With no number
  to prove identity, "you control the e-mail on a roster row bound to venue X" is the entire proof, so
  a wrong auto-match hands a real business's listing to someone who legitimately controls their own
  e-mail. This promotes the review queue and the duplicate-venue guard from hygiene to security
  controls. The sample makes the risk concrete: **13 of 48 rows (27%) are chain branches** (Apache ×5,
  Monte Carlo ×3, Pizza Crew ×3, Love Pizza ×2) and two postcodes each carry two different members.
- **One canonical definition — which is TWO predicates, not one** (corrected 2026-09-23 against the
  shipped code; delivered by migration 0154):

  | | Predicate | Read by |
  |---|---|---|
  | **Membership** — counted, listed, ranked | `status = 'live'` AND `venue_id is not null` | `f2g_member_venue_ids`, the directory, members-mode listing, portal counts |
  | **Entitlement** — may post as a member | membership AND `claimed_by = auth.uid()` | `f2g_can_post_as_member`, `f2g_can_post_supplier` |

  An earlier draft of this bullet made membership require `claimed_by` too. That was wrong: 0150
  shipped an HQ "mark live" action whose own documentation says a staff-marked member "still needs to
  claim/activate to post — but they ARE counted, listed and ranked from this moment". Collapsing the
  two predicates would have silently un-ranked every member HQ has marked live.

  Before 0154 the predicate was said three different ways — the ranking helper counted `claimed|live`
  and every `venue_channels` tag; the directory counted `live` only; the entitlements counted `live` +
  `claimed_by` but not a bound venue. **Consequently the claim definer (0139) now writes `live`, not
  `claimed`:** 0150 backfilled exactly those rows to `live` as "already proven", so leaving new
  claimants at `claimed` put them outside the live-only predicate and required a manual HQ step to be
  ranked. `claimed` is now a legacy status — still valid, still in the state machine, never written.
- **Transitions widened** (`packages/core/src/membership/index.ts:41-48` forbids anything → `live`
  except from `claimed`/`lapsed`): activation adds `imported → live` and `invited → live`.
- **`venue_channels.role`** (`member` | `listed`) is a new column (the table is key-only today,
  `0116:30-37`); `venues_in_channel_near` and the ranking filter on it, so a listed non-member never
  shows as a member when the mode flips.
- **Two activation paths on the F2G site** (`/activate`, replacing `/f2g/claim`):
  1. *Member:* sign in → pick the venue → **prove control of the roster e-mail** (the signed-in
     account's verified e-mail equals `source_email`, or a one-time code sent to it) → the server
     checks that the roster row is unbound or already bound to **this** venue, and that an unbound row
     binds only when the roster postcode matches the venue (otherwise the pair goes to HQ review);
     per-account and per-row throttling; failed attempts audited. Success: a new definer
     (`activate_channel_member_venue`, extending 0139) sets `venues.owner_id`, `claimed_by`,
     `claimed_at`, `status='live'`, `venue_channels.role='member'`.
     *From 2027*, `member_no` is added as a second factor on top — the flow does not otherwise change.
     *Members with no e-mail even in HubSpot* have no self-serve path at all and are activated by HQ
     one at a time; the portal must report how many those are, because that number is the ceiling on
     self-serve onboarding.
  2. *Non-member:* sign in → claim the venue (existing approval flow) → server-side tag
     `venue_channels.role='listed'`, NI-fenced; storefront listing, no priority, no member
     entitlements, a standing "become a member" prompt.
- **Lifecycle.** New columns `last_seen_import_id` and `lapsed_at`. Each import is the roster of
  record: rows absent from it lapse after a 30-day grace (`live → lapsed`; loses priority, keeps the
  listing); a later import containing the number restores `live`. Only safe because the number is
  mandatory (a name/e-mail edit no longer creates a new row).
- **Invites stay** but the link no longer confers ownership: it pre-fills the number and lands on
  `/activate`, which still requires the second factor (closes the bearer-link risk, recon 4.1 M).
- **HQ** gains status actions (`mark live`, `lapse`, `remove`) — none exist today
  (`channelsAdmin.ts` is queries only) — all audited. PostgREST self-tagging into any channel is
  removed (recon 4.1 H).

### 3.3 Association portal (D2) and feature requests (D4) — before the app split

The portal does **not** depend on the separate app: the role, the aggregates and the members list are
API/DB work, and `channelsAdmin.roster` already shows the shape. It is built first inside `apps/web`
at `/association` (rendered only on the F2G host for `channel_admins`) and moves into `apps/f2g`
unchanged in Phase 4.

- **Role:** `channel_admins` (`channel_id`, `profile_id`, `role` in `officer|viewer`, audited),
  managed from Roam HQ; `channels` gains `contact_email` / `org_name` (the recon's "no Association
  identity"). API `associationProcedure` resolves the caller's channel from `channel_admins` — never
  from the header — and scopes every read to it; pgTAP proves an officer of one channel reads nothing
  of another.
- **Portal v1 (read-only):** *Overview* — members total / imported / invited / claimed / live / lapsed;
  activated non-members; venues by council; FSA-rated share among members; jobs (active / total);
  suppliers (approved / pending); orders per period as agreed in §5.3. *Members* — business, venue,
  council, membership number, status, activated date (the activated/claimed list you asked for),
  filter + CSV export; PII per §5.2. *Feature requests* — create + list with Roam status and notes.
  No writes to membership, no venue editing, no customer data.
- **Feature requests:** `channel_feature_requests` (`channel_id`, `created_by`, `title`, `detail`,
  `category`, `status` in `new|triaged|planned|in_progress|shipped|declined`, `roam_notes`,
  timestamps). RLS: officers read/insert their channel's rows; HQ full; status changes audited; HQ
  queue view. Notifications: new request → Roam inbox (Brevo); status change → requester.

### 3.4 Money, comms, legal (D5, D6)

- **Per-channel platform fee:** `channels.platform_fee_bps` (F2G = **700**), read at checkout from the
  order's channel — which requires **channel-of-order** first (`market.ts:385,590` reads only the
  global `applicationFeeBps` and never touches the channel), so the fee and `orders.channel_id` ship
  in one PR (Phase 1.1). Hero "No commission" replaced with a truthful line; the 7% stated in the
  vendor readiness checklist and the F2G terms.
- **Co-branded Roam comms in two steps:** the cheap part early (Phase 2: per-channel sender display
  name "NI Food to Go Association · Roam" and channel-origin links, so Phase 2 invites are not sent as
  plain Roam), the full part later (Phase 5: co-branded templates, buyer confirmation and immediate
  vendor new-order e-mail/push — none exist today, recon 4.4 H). Supabase Auth: §5.5.
- **Legal on the F2G host:** real terms (with the fee), privacy, attributions (FSA/OGL, Google); consent
  banner gating GA4 on every host (recon 4.4 H); DPA wording for the roster.

### 3.5 Membership data from HubSpot (added 2026-09-23)

The Association keeps its membership in HubSpot. That makes the CRM the roster of record and the CSV a
fallback, and it resolves two problems the spreadsheet cannot (§3.2): the **contact e-mail** that is
the activation credential, and the **immutable object id** that is the idempotency key.

- **Direction: one-way, HubSpot → Roam, in v1.** Roam mirrors; it never edits the Association's CRM.
  Write-back is Phase 2b and only after the pull has proved itself.
- **Objects: companies lead, contacts attach.** A member is a company (the trading business we match to
  a venue); its associated contacts supply the e-mail and phone. Where a company has several contacts,
  the roster row takes one — the choice rule is a decision to settle against the real property schema,
  not to guess at here.
- **Shape: the `syncFsaNi` pattern**, which already does this job against a 16,949-row external
  register — a job in `packages/api/src/jobs/`, an internal `/jobs/*` route at `full` scope (Phase 1.5),
  a `railway.cron-sync-hubspot.json` service, incremental on `hs_lastmodifieddate`, every run audited
  and reportable. `external_refs.dataset` widens from `('roam_venue','fsa')` to include `'hubspot'`.
- **Credentials:** a read-only private-app token (`crm.objects.companies.read`,
  `crm.objects.contacts.read`) as a Railway secret. Read-only is not a formality — Roam has no business
  holding write access to a partner's CRM to do a job that only reads.
- **Data protection:** this converts a one-off CSV hand-over into a *continuous* pull of contact PII
  from the Association's systems. The DPA (§2 item 6) must be signed before 2.3 ships — not before it
  is written, but before it runs against live HubSpot.

## 4. Phases

Effort = engineer-days including tests and review. Each phase is one or more PRs on green;
migrations continue to be applied by you from supplied SQL. Order: 1 → 2 → 3, then 4 and 5 in
parallel.

### Phase 1 — Truth and safety on the live site (≈ 12 days, start now)

| # | Work | Recon | Days |
|---|---|---|---|
| 1.1 | `orders.channel_id` (derived server-side from the venue's F2G membership/tag at checkout; no backfill) + `channels.platform_fee_bps` (F2G 700) read from it + hero copy corrected + fee in vendor checklist and terms | 4.4 H, 4.3 H | 2.5 |
| 1.2 | `live` spine, interim: transitions widened; HQ `mark live` / `lapse` / `remove` actions (audited); backfill verified `claimed → live`; header nav shows Directory / Jobs / Suppliers when the section is on; HQ can toggle `directory`; live sections codified in a migration | 4.4 B, 4.2 H/M | 2 |
| 1.3 | Consent banner gating GA4; F2G legal pages on the F2G host | 4.4 H, 4.2 H | 1.5 |
| 1.4 | Alerting + health: API `/healthz`, uptime check, error tracking on web/API/crons; channel-resolution fail-open alerts; flag-off returns maintenance, not Roam | 4.4 H, 4.2 H | 1.5 |
| 1.5 | Per-app internal secrets with a server-side scope list (web deploy can no longer reach ban/approve/credits) | 4.2 H | 1.5 |
| 1.6 | Migrate/drift workflows live (secrets from Phase 0), drift guard over every 0134+ object, 0146 pgTAP, `venue-media` policy migration | 4.1 H | 1 |
| 1.7 | Function EXECUTE hardening migration (~43 `revoke … from public`-only functions) + pgTAP | 4.1 H | 1 |
| 1.8 | Supplier approval in HQ (approve/reject pending orgs, audited) | 4.4 H | 1 |

### Phase 2 — Membership spine v2, without membership numbers (≈ 14 days) — **revised 2026-09-23**

Re-scoped once the real sample landed (§2 item 4). The number is gone as both key and credential, so
the CRM takes over both jobs and the roster CSV becomes a fallback import path rather than the spine.

| # | Work | Recon | Days | Status |
|---|---|---|---|---|
| 2.1 | Identity: `source_system` + `source_system_id`, `member_no` reserved for 2027, `venue_channels.role`, `last_seen_import_id`, `channels.contact_email`/`org_name`; canonical member definition applied to `f2g_member_venue_ids`, `venues_in_channel_near`, directory, entitlements; council derived from the matched venue's FSA `local_authority`; claim definer lands on `live`; pgTAP (31) | 4.4 B, 4.3 H | 3 | **DONE** (0154) |
| 2.2 | **Import hardening** — postcode sanitiser; roster address passed to the matcher (import *and* review queue); `town` recognised; duplicate-venue guard in auto-accept; dry-run; operator column mapping; HQ file picker + preview + rehearse-then-commit | 4.4 H, 4.3 M | 3 | **DONE** |
| 2.3 | **HubSpot sync v1 (read-only)** — companies (lead) + contacts → `channel_members`, incremental on `hs_lastmodifieddate`, nightly cron + officer-triggered "sync now", `external_refs.dataset` widened to `'hubspot'`, audited | 4.4 B | 4 | |
| 2.4 | `/activate`: member path (e-mail possession + binding rules + throttling + audit, `activate_channel_member_venue` definer) and non-member path (server-side `listed` tag); self-tag RPC removed; invite link lands on `/activate` rather than conferring ownership; per-channel sender name | 4.4 B, 4.1 H, 4.2 H | 3 | |
| 2.5 | HQ: roster e-mail masked by default, PII reads audited | 4.3 H | 1 | |

**Deferred out of Phase 2 by the sample:** roster *lifecycle* (lapse after grace, restore on
re-appearance) moves behind 2.3. It was only ever safe because the number was mandatory — "rows absent
from this import lapse" is a destructive rule, and running it on a key derived from an editable name
would lapse members over a corrected typo. Once HubSpot ids are the key it becomes safe again.

### Phase 2b — HubSpot write-back (≈ 3 days; optional, after 2.3 has run clean for a fortnight)

Push Roam onboarding status (`matched` / `invited` / `claimed` / `live`) into a HubSpot property, so
the Association sees adoption inside the tool they already use. Held deliberately: two-way sync is
where data corruption lives, and a one-way pull has to prove itself first.

### Phase 3 — Association portal v1 + feature requests (≈ 11 days; in `apps/web`, moves later)

| # | Work | Recon | Days |
|---|---|---|---|
| 3.1 | `channel_admins` + `associationProcedure` + HQ officer management + pgTAP scoping proof | 4.3 B | 2 |
| 3.2 | Aggregate RPCs (members funnel, venues by council, FSA share among members, jobs, suppliers, orders per §5.3), channel-scoped, audited | 4.3 B/H | 3 |
| 3.3 | `/association` UI: overview, members list + CSV, feature requests | 4.3 B | 3 |
| 3.4 | `channel_feature_requests` + RLS + HQ queue + Brevo notifications both ways | 4.3 B/H | 3 |

### Phase 4 — The separate F2G app (≈ 32 days) — **NOT COMMITTED; trigger-gated (2026-09-18)**

> **Do not start this phase without one of the triggers below being true.**
>
> Its original justification died with decision 5.1. D1 asked for a separate app so that "the F2G site
> moves independently **for the F2G agency**". There is no agency engineer: Roam ships both sides, from
> one repository, on one cadence. What F2G needs today it already has — both `www.roam-local.com` and
> `nifood2go.roam-local.com` are domains on **one** Vercel deployment, and the channel system
> (`surface` / `sections` / `nav`, plus the per-channel canonical host, sitemap, robots and OG art
> delivered in A3-b) is what makes one app serve two brands. That is the design working as intended,
> not a stopgap.
>
> **Start Phase 4 when any ONE of these becomes true:**
> 1. **A second whitelabel exists or is signed.** Package extraction (4.1) pays for itself across two
>    tenants; for one it is cost with no return.
> 2. **Release cadence genuinely conflicts** — an F2G change is blocked, or made risky, by an unrelated
>    Roam change in flight (or the reverse), more than occasionally.
> 3. **Blast radius bites** — a Roam deploy breaks F2G or vice versa, in production, more than once.
> 4. **The Association asks for something the shared app cannot express** — a layout, route shape or
>    identity that `sections`/`nav` genuinely cannot carry.
>
> **What it costs even after it is built:** two builds, two deploy pipelines, two sets of environment
> variables, two places for configuration to drift. The 2026-09-17/18 audit is a preview of that class
> of problem at the schema layer; a second app makes it structural. Weigh that against the triggers.
>
> **Cheaper subsets available without the split**, if a specific need appears: per-channel push
> identity (own VAPID keys and notification title/icon) and per-channel ops alert routing are each
> small, standalone pieces of 4.2/4.6. Take them individually rather than as a reason to split.

| # | Work | Recon | Days |
|---|---|---|---|
| 4.1 | Package extraction with no behaviour change: `venue-ui` (with social slots), `venue-server`, `web-auth`, `messages` (namespace split); `transpilePackages`; both apps consume them | 4.2 B | 12 |
| 4.2 | `apps/f2g`: fixed channel, header on every call, own env/SEO/OG/sitemap/robots/i18n/legal/VAPID; storefront, directory, jobs, suppliers, activate, `/association` moved in; F2G-only components → `packages/f2g-ui`; its own scoped internal secret; push subscriptions re-captured on the new origin (announce) | 4.2 B/H | 10 |
| 4.3 | Hosting: second site from the host found in Phase 0, config in repo, `nifood2go` moved, Supabase Auth redirect allow-list, per-app `WEB_ORIGIN`; topology written into `ARCHITECTURE.md` | 4.2 H | 2 |
| 4.4 | Release gates: path-filtered CI + deploy per app, `next build` both apps, web smoke tests, `CODEOWNERS`, branch protection | 4.2 H | 3 |
| 4.5 | Remove every F2G branch from `apps/web`; delete the host classifier; `channels.nav` rendered by the F2G header or dropped | 4.2 M | 3 |
| 4.6 | Ops: F2G runbook (jobs, budgets, paging), job run-history table, cron services confirmed, photo-refresh and job-expiry crons committed | 4.4 M, 4.2 H | 2 |

### Phase 5 — Co-branded comms, DR, data protection (≈ 7 days; alongside Phase 4)

| # | Work | Recon | Days |
|---|---|---|---|
| 5.1 | Co-branded templates; buyer order confirmation; immediate vendor new-order e-mail/push; per-channel push icon/title | 4.4 H, 4.2 M | 3 |
| 5.2 | Backup/PITR/restore statement, tested restore, RTO/RPO in the runbook | 4.1 H | 1 |
| 5.3 | Roster data-protection: DPA wording, retention/erasure, `deleteMe` covering orders + roster, GDPR export | 4.1 H, 4.4 M | 2 |
| 5.4 | Regenerate DB types (Phase 0 item 5), delete `LooseDb` casts | 4.1 H | 1 |

**Totals.** All five phases ≈ 75 engineer-days. **Committed work, with Phase 4 trigger-gated out,
≈ 43** (Phases 1–3 and 5). Andrew's stated priority — the activated/claimed list in a portal — lands
at the end of **Phase 3**, and never depended on the app split.

**What "days" mean in this document.** They are conventional engineer-day estimates for a human team,
written before this plan was being executed by an agent. They are **not** a wall-clock forecast: Phase 1
was estimated at 12 days and was delivered, together with an unplanned live-parity audit that recovered
seven migrations which had never reached the project, in two sittings on 2026-09-17/18. Read the
numbers as **scope and risk**, not schedule — "12 days" against package extraction (4.1) means *it
touches a large share of the web app* (24 of 247 source files are channel-aware today, across 153
components), and that does not shrink with execution speed. Where a number is doing real work in a
decision, it is the blast radius it stands for, not the hours.

## 5. Decisions to settle together

**5.1 The agency's access — DECIDED 2026-09-18, and not as recommended.** *The agency gets no
development access at all.* Their only route into the roadmap is the **feature-request queue** (D4):
they raise a request, Roam triages, plans and builds it. No repository access, no `CODEOWNERS` entry,
no fork, no agency pull requests, no agency-proposed migrations.

Consequences, all simplifications:
- The Phase 3 feature-request surface (3.4) is no longer a convenience — it **is** the agency's
  interface to Roam, so its status vocabulary and notifications matter more, not less.
- Phase 4's `CODEOWNERS` work (4.4) reduces to ordinary branch protection for the Roam team.
- **Phase 4 is now trigger-gated, not committed** — D1's driver ("the F2G site moves independently
  *for the F2G agency*") no longer exists. The four triggers that would restart it are written into
  the Phase 4 heading; until one is true, F2G stays a host entry on the existing deployment, which is
  what the channel system was built for and what production already runs.

**5.2 Roster PII in the portal — DECIDED 2026-09-18: Option A.** Officers see business, venue,
council, membership number, status — no personal e-mail/phone (the Association already holds them).
Option B (roster e-mail with every read audited) is rejected for v1. A needs no DPA change.

**5.3 Orders visibility (D3) — DECIDED 2026-09-18: Option B.**

| Option | The Association sees | Trade-off |
|---|---|---|
| A. Totals | order count, GMV, fees per week/month for the channel | Simple; low value per member |
| **B. Per-venue totals (recommended)** | A plus per-member-venue counts/GMV; no customer or line data | Shows members what the storefront does for them; needs one line in the membership terms |
| C. Line level | items, times, customers | Not needed by an association; customer-data exposure; no |

The data spine (`orders.channel_id`, Phase 1.1) is the same for all three, so this does not block.

**5.4 Roam's own fee — CONFIRMED 2026-09-18.** Roam stays at 5%; F2G is 7% via the channel. No
venue-level override is planned. Already live (migration 0149).

**5.5 Supabase Auth e-mails — DECIDED 2026-09-18: Option A.** Roam's Auth templates are left exactly
as they are; F2G users receive Roam-branded security mail. Revisit with Option C only if the
Association asks for it.

*Why the first answer couldn't stand.* It was "co-branded is fine as long as that doesn't affect our
Roam Core platform e-mails". It would have. Supabase Auth allows **one template set per project**, and
Roam and F2G share one project, so *any* change to those templates reaches everyone who signs up,
resets a password or confirms an address on **roam-local.com** as well. There is no per-host variant
to hide behind. Hence Option A: the only choice that genuinely leaves Roam's mail untouched.

Affected mail: confirm signup, magic link, password reset, e-mail change, invite. Not affected:
everything we send ourselves through Brevo (owner digest, F2G invites, order mail) — those are already
per-channel capable.

The three options as costed:
| | What Roam users receive | What F2G users receive | Cost |
|---|---|---|---|
| **A — CHOSEN** | unchanged Roam templates | Roam-branded auth mail | none — the F2G site already says "Powered by Roam", so a Roam-branded security e-mail is coherent |
| B | neutral, brand-light templates | the same neutral templates | ~0.5 day; weakens Roam's own mail to gain nothing for F2G |
| C | Roam templates | true F2G templates | ≈ 3 days: take auth mail off Supabase via the **Send Email Hook**, render per-channel and send through the Brevo path we already run; needs the channel captured into user metadata at sign-up |

**5.6 Where the vendor console lives — DECIDED 2026-09-18: stays in `apps/web`** (`/dashboard`),
reached co-branded from the F2G app; it is engine tooling (menus, payments, orders). Packaging it into
a shared `vendor-console` package (≈ 8 days) is not planned — with no agency engineers there is nobody
asking to restyle it.

**5.7 Activation second factor — DECIDED 2026-09-18 as recommended.** The signed-in account's
verified e-mail must equal the roster `source_email`; if it doesn't, a one-time code is sent to
`source_email`. Postcode alone is rejected as the factor — it is printed on the venue page, and most
SME e-mails are generic domains, so "number + postcode" is guessable.

## 6. Deliberately deferred (with the recon gap they leave open)

Not a second database, no data sync, no fork of `packages/api` (D1). No portal writes in v1 (D2).
No custom domain (#8). Backlog: GB-wide FSA (#52); sweep Phase 2b; `orgs.channel_id`; console and
native channel-awareness (neither is deployed for F2G); per-channel cost attribution (Places, Brevo,
Stripe, GA); member self-service membership view; Stripe onboarding branding; webhook handling of
refund/dispute/expiry events; `venue_views` channel column; FSA coverage scoped to members; digest
opt-out per channel; packaging the vendor console (5.6). Each stays on the recon's list.

## 7. Immediate next steps (rev 3, 2026-09-23)

Phase 1 has shipped in full and the live-vs-repo parity audit is closed. Phase 0 items 1–4 are
answered; 5 (Supabase CLI access) and 6 (the DPA) remain, and **6 now gates Phase 2.3**.

1. Me, done: **Phase 2.2** — import hardening, against the real sample.
2. Me, next: **Phase 2.1** (identity model) then **2.3** (HubSpot sync v1), which together restore a
   stable key and supply the missing credential. Phase 3 (the Association portal) is unblocked
   throughout and can run alongside — none of it needs the roster's contents.
3. You: a read-only HubSpot private-app token for the environment; the DPA wording before 2.3 runs
   against live HubSpot; and the full membership list whenever the Association is ready — with 2.2
   shipped, it can be rehearsed in HQ before anything is written.
4. Open question for the Association, to settle against their real property schema: where a member
   company has several HubSpot contacts, which one is the roster contact?

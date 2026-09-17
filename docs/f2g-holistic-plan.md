# F2G whitelabel platform — holistic plan (2026-09-17, rev 2)

**Input:** [`f2g-platform-recon-2026-09.md`](./f2g-platform-recon-2026-09.md) (as-built, 129 verified
gaps, 12 blockers) + Andrew's decisions of 2026-09-17 (§1). Rev 2 folds in an independent review of
rev 1 against the code (portal re-sequenced ahead of the app split; membership model corrected to the
real schema; Phase 3/4 re-scoped and re-estimated; dropped highs restored). **Output:** the target
shape of the NI Food to Go Association ("F2G") whitelabel and the phased work to get there. Recon gap
references use its section numbers; **B** blocker · **H** high · **M** medium.

## 1. Decisions taken (2026-09-17)

| # | Question | Decision |
|---|---|---|
| D1 | Independence model | **A separate F2G app in this monorepo** ("a branch away from Roam, still attached"): its own build, host and release cadence; **same database and the same API** — Roam core is the engine, so any activity on F2G is activity on Roam and vice versa. F2G is bespoked to the Association (employability board, supplier directory, member directory, …). |
| D2 | Association portal | **Basic, mostly read-only.** |
| D3 | Orders visibility to the Association | **To be settled together** — options and a recommendation in §5.3. |
| D4 | Feature requests | **A table + a Roam HQ queue, with status visible to the Association.** |
| D5 | Commission | **Copy is wrong; the F2G fee is 7%.** (Roam's default stays 5% unless told otherwise — §5.4.) |
| D6 | Email sender | **Co-branded Roam.** |
| D7 | Hosting reality (Netlify vs Vercel; how nifood2go maps) | **Unknown — establish together** (§2). |
| D8 | Membership rule | **The Association's membership number is the validation key.** A business that activates with a valid number is an *active member* (priority + recognition). Non-members are still encouraged to claim/activate, without membership priority. The portal must list activated/claimed businesses. |

Open, settled in §5: agency access (5.1) · roster PII in the portal (5.2) · orders visibility (5.3)
· Roam's own fee (5.4) · Supabase Auth e-mail branding (5.5) · where the vendor console lives (5.6)
· the activation second factor (5.7). Custom domain: recon decision #8 stands (no).

## 2. Phase 0 — establish the facts (this week, no code)

Six things the repo cannot tell us. Each is a short check on your side; the plan is blocked on 4.

1. **Where the web app runs.** From your laptop: `curl -sI https://nifood2go.roam-local.com | grep -i -E "^(server|x-nf-|x-vercel)"`. `server: Netlify` / `x-nf-request-id` = Netlify; `x-vercel-id` = Vercel. In that dashboard: is `nifood2go.roam-local.com` a **domain alias on the Roam site** or a second site? Note the site name(s). The answer gets written into `docs/ARCHITECTURE.md` in Phase 4.3 (recon 4.2 H: hosting undocumented).
2. **How nifood2go resolves to the f2g channel.** Same dashboard, environment variables: is `NEXT_PUBLIC_F2G_HOSTS` set (env classifier) or absent (DB `channel_domains` row + `/api/channel-map`)? Paste variable **names** only.
3. **Which scheduled jobs and secrets exist.** Railway: which of `cron-owner-digest`, `cron-cj-logos`, `cron-sync-fsa-ni` exist, with schedules. GitHub repository secrets: are the Supabase access token / DB URL secrets set? (Without them the migrate and drift workflows silently skip — recon 4.1 H.)
4. **A sample roster CSV with the membership-number column** (recon decision #1, still outstanding). This is now load-bearing: D8 makes the number the credential, but the importer only stores a real reference when the CSV has one (`packages/core/src/membership/import.ts:48,142` — otherwise it derives an `AUTO:` key from name+postcode+e-mail). Confirm: the Association issues numbers to every member; their format (digits? prefix? reused after lapse?); whether members know their number.
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

- **The roster is the source of truth; the membership number is the key, and it becomes mandatory.**
  `channel_members.membership_ref` is unique per channel (`0135:62-63`) but is only the Association's
  number when the CSV carries one; the importer will **reject** rows without a real reference (no more
  `AUTO:` keys) once Phase 0 item 4 confirms every member has one.
- **One canonical definition, used everywhere:** an *active member* is a `channel_members` row with
  `status = 'live'`, `claimed_by` set, linked to a venue. Ranking (`f2g_member_venue_ids`, today
  `claimed|live ∪ tag`), the directory (today `live` only), the jobs/supplier entitlements (today
  `claimed_by = auth.uid() and status='live'`), members-mode listing and the portal counts all read
  exactly that. **Backfill:** every existing `claimed` row that came through a verified invite moves
  to `live` in the same migration, so nobody who has already claimed loses priority.
- **Transitions widened** (`packages/core/src/membership/index.ts:41-48` forbids anything → `live`
  except from `claimed`/`lapsed`): activation adds `imported → live` and `invited → live`.
- **`venue_channels.role`** (`member` | `listed`) is a new column (the table is key-only today,
  `0116:30-37`); `venues_in_channel_near` and the ranking filter on it, so a listed non-member never
  shows as a member when the mode flips.
- **Two activation paths on the F2G site** (`/activate`, replacing `/f2g/claim`):
  1. *Member:* sign in → pick the venue → enter the membership number → the server checks: the number
     exists in the roster for this channel; the roster row is unbound or already bound to **this**
     venue (a number can never claim a different listing; unbound rows bind only when the roster
     postcode matches the venue, otherwise the pair goes to HQ review); a **second factor** (§5.7:
     the signed-in account's verified e-mail equals the roster `source_email`, or a one-time code sent
     to `source_email`); per-account and per-number throttling; failed attempts audited. Success: a
     new definer (`activate_channel_member_venue`, extending 0139) sets `venues.owner_id`, `claimed_by`,
     `claimed_at`, `status='live'`, `venue_channels.role='member'`.
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

### Phase 2 — Membership spine v2 (≈ 13 days; needs Phase 0 item 4)

| # | Work | Recon | Days |
|---|---|---|---|
| 2.1 | Schema: mandatory `membership_ref`, `venue_channels.role`, `last_seen_import_id`, `lapsed_at`, `channels.origin`/`contact_email`/`org_name`; canonical member definition applied to `f2g_member_venue_ids`, `venues_in_channel_near`, directory, entitlements; pgTAP | 4.4 B, 4.3 H | 3 |
| 2.2 | `/activate`: member path (number + second factor + binding rules + throttling + audit, `activate_channel_member_venue` definer) and non-member path (server-side `listed` tag); self-tag RPC removed | 4.4 B, 4.1 H | 5 |
| 2.3 | Roster lifecycle: reject rows without a number; lapse after grace; restore on re-appearance; import reports readable in HQ; duplicate-venue guard in auto-accept | 4.4 H, 4.3 M | 2 |
| 2.4 | Invite hardening (pre-fill, lands on `/activate`, second factor); per-channel sender name + channel-origin links; `F2G_INVITE_SECRET` rotation documented | 4.1 M, 4.2 H | 2 |
| 2.5 | HQ: roster e-mail masked by default, PII reads audited; membership-number column | 4.3 H | 1 |

### Phase 3 — Association portal v1 + feature requests (≈ 11 days; in `apps/web`, moves later)

| # | Work | Recon | Days |
|---|---|---|---|
| 3.1 | `channel_admins` + `associationProcedure` + HQ officer management + pgTAP scoping proof | 4.3 B | 2 |
| 3.2 | Aggregate RPCs (members funnel, venues by council, FSA share among members, jobs, suppliers, orders per §5.3), channel-scoped, audited | 4.3 B/H | 3 |
| 3.3 | `/association` UI: overview, members list + CSV, feature requests | 4.3 B | 3 |
| 3.4 | `channel_feature_requests` + RLS + HQ queue + Brevo notifications both ways | 4.3 B/H | 3 |

### Phase 4 — The separate F2G app (≈ 32 days)

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

**Total ≈ 75 engineer-days** — about 15 weeks for one engineer; 9–10 with two once Phase 2 is done
(Phase 4 and Phases 3+5 in parallel). Andrew's stated priority — the activated/claimed list in a
portal — lands at the end of Phase 3, roughly week 7 single-handed, not after the app split.

## 5. Decisions to settle together

**5.1 The agency's access.** Recommended: the agency works in this repository on `apps/f2g` and
`packages/f2g-ui` with `CODEOWNERS` review from Roam on `packages/api`, `supabase/`, `apps/web`,
`apps/admin` and the shared packages; migrations proposed by PR, applied by Roam. Alternative: a fork
with one-way sync — every engine change becomes a merge, and "activity on one is activity on the
other" gets harder to keep true.

**5.2 Roster PII in the portal.** Option A (recommended for v1): officers see business, venue,
council, membership number, status — no personal e-mail/phone (the Association already holds them).
Option B: show roster e-mail with every read audited. A needs no DPA change.

**5.3 Orders visibility (D3).**

| Option | The Association sees | Trade-off |
|---|---|---|
| A. Totals | order count, GMV, fees per week/month for the channel | Simple; low value per member |
| **B. Per-venue totals (recommended)** | A plus per-member-venue counts/GMV; no customer or line data | Shows members what the storefront does for them; needs one line in the membership terms |
| C. Line level | items, times, customers | Not needed by an association; customer-data exposure; no |

The data spine (`orders.channel_id`, Phase 1.1) is the same for all three, so this does not block.

**5.4 Roam's own fee.** Global default is 5%; F2G becomes 7% via the channel. Confirm Roam stays 5%;
no venue-level override is planned.

**5.5 Supabase Auth e-mails.** One template set per project. Recommended: neutral co-branded templates
rather than per-host variants, which Supabase cannot do.

**5.6 Where the vendor console lives.** Recommended for v1: stays in `apps/web` (`/dashboard`),
reached co-branded from the F2G app; it is engine tooling (menus, payments, orders). Packaging it into
a shared `vendor-console` package is a later phase (≈ 8 days) if the agency needs to restyle it.

**5.7 Activation second factor.** Recommended: the signed-in account's verified e-mail must equal the
roster `source_email`; if it doesn't, a one-time code is sent to `source_email`. Postcode alone is
rejected as the factor — it is printed on the venue page, and most SME e-mails are generic domains,
so "number + postcode" is guessable.

## 6. Deliberately deferred (with the recon gap they leave open)

Not a second database, no data sync, no fork of `packages/api` (D1). No portal writes in v1 (D2).
No custom domain (#8). Backlog: GB-wide FSA (#52); sweep Phase 2b; `orgs.channel_id`; console and
native channel-awareness (neither is deployed for F2G); per-channel cost attribution (Places, Brevo,
Stripe, GA); member self-service membership view; Stripe onboarding branding; webhook handling of
refund/dispute/expiry events; `venue_views` channel column; FSA coverage scoped to members; digest
opt-out per channel; packaging the vendor console (5.6). Each stays on the recon's list.

## 7. Immediate next steps

1. You: the six Phase 0 items (§2) — item 4 (the CSV with membership numbers) is the one that blocks
   Phase 2 — and answers to §5.1–5.7.
2. Me, now: Phase 1.1 (orders channel + 7% fee + copy) and 1.2 (`live` spine + nav) as the first two
   PRs; they fix what a member sees today and unblock every member feature.

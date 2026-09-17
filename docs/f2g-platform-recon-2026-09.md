<!-- Recon of the F2G whitelabel platform as built, 2026-09-16, at migration 0148 / main d005c89.
     Method: thirteen independent read-only passes over the repo (tenancy, host→channel routing, deploy
     topology, storefront completeness, membership/onboarding, portal data, portal readiness, security,
     ops, payments, notifications, analytics/legal, other clients + disaster recovery), each producing
     evidence-cited facts and gaps; every gap was then re-checked by an independent skeptic pass against
     the code (129 raised, 128 held at high confidence, 1 at medium, 0 refuted) and weighed for
     materiality against the three goals. Judged severities are the materiality pass's. This document is
     the INPUT to the holistic F2G review plan; it proposes nothing. Line references are as of main
     d005c89 and will drift. -->

# F2G whitelabel platform — as-built map (recon)

Recon of `core-platform` at migration 0148, 13 dimensions, evidence as `path:line`. Judged severities are the materiality judge's; where readers or judges disagree, both are cited.

## 1. Verdict

The shared-database goal is met at the storage layer: F2G is one `channels` row plus side tables (`venue_channels`, `channel_members`, `job_posts.channel_id`) on the common Supabase project, with PII genuinely fenced from client roles, but nothing in RLS scopes by channel and the core entities (venues, orders, orgs, FSA) carry no tenant column, so "F2G data" is derived, not declared. The independence goal is not delivered: nifood2go.roam-local.com and roam-local.com are the same Next.js build, the same API image, the same migration stream and the same push-to-main release train, with F2G chrome expressed as early-returns inside Roam components and every absolute link (Stripe, invites, digests) pointing at the Roam origin. The portal goal is not started: there is no role between "venue owner" and "Roam HQ staff who see every tenant" (decision #7 deferred `channel_admin`), no Association-facing route, and no feature-request mechanism of any kind. The storefront itself is a working order-ahead product, but the three Association features (directory, jobs, suppliers) are unreachable from its chrome, no code path ever moves a roster member to `live` (which every member entitlement requires), and the hero promises "no commission" while checkout takes 5%. Ops is Roam-staff, console-driven, with no alerting, no backup/restore statement, stale generated types, and docs that contradict code on hosting, schedulers and access.

## 2. What exists

**Storefront (nifood2go host)**
- Host classified in edge middleware → `roam_channel` cookie + `x-roam-channel` header (`apps/web/src/middleware.ts:33-60`); `HomeSwitch` renders `StorefrontHome` on `surface==='storefront'` (`components/HomeSwitch.tsx:16-18`).
- `venues.storefrontNear` picks `venues_food_to_go_near` (open mode) or `venues_in_channel_near` (members) server-side (`packages/api/src/routers/venues.ts:936-985`); open mode lists every NI venue matching a hardcoded 25-leaf Google-type array + NI bbox, members ranked first via `f2g_member_venue_ids` (`supabase/migrations/0146:15-54`, `0145:33-55`).
- Cards batch covers + FSA chips with OGL line (`StorefrontHome.tsx:170-234,383-390`); place state is NI-clamped, Belfast default (`lib/storefrontPlace.ts:87-92`).
- Venue page defaults to Shop tab; per-venue basket, Collect/Deliver, server delivery quote, `market.checkoutCart` → Stripe destination charge with `order_items` (`VenueShop.tsx:104-117,281-331`; `routers/market.ts:526-649`); lifecycle pending→paid→ready→collected / out_for_delivery→delivered; owner-only full refund (`market.ts:738-893`).
- Vendor "Food to Go" tab: list/unlist, readiness checklist, collection/delivery settings, live preview (`VenueFoodToGo.tsx:56-60`; `packages/core/src/f2g/index.ts:604-615`).
- Built-but-hidden: `/directory` (SSR over PII-safe `channel_members_search`), `/jobs` (member-gated composer, apply-out), `/suppliers[/slug]` (member-gated draft submission), `/f2g/claim` (`app/directory/page.tsx:1-44`; `Jobs.tsx:70-116`; `Suppliers.tsx:59-91`; `app/f2g/claim/page.tsx:47-79`). No storefront component links to any of them (grep → only `SupplierDetail.tsx:43,50`).
- Whole channel gated by `feature_flags.marketplace.f2g.enabled`, seeded false in 0116 and never flipped in a migration (`0116:148-150`; `routers/channels.ts:103-111`).

**Membership / onboarding**
- `channel_members` roster: verbatim `source_*` PII, `membership_ref` idempotency, six-state status, RLS deny-by-omission + 42501 tripwire trigger (`0135:25-102`); `external_refs` match ledger (`0137:22-53`); `channel_import_runs` audit (`0138:15-33`).
- Pipeline: HQ CSV paste → `adminActions.importRoster` upserts, auto-binds only full-postcode unambiguous matches (`jobs/importRoster.ts:111-190`) → HQ Review tab (`core/admin/reviewQueue.ts:165-223`) → Invite mints HMAC link, emails via Brevo, sets `invited` (`f2g/invite.ts:159-212`) → `/f2g/claim` → `claim_channel_member_venue` (service-role-only definer) confers `venues.owner_id`, sets `claimed`, tags `venue_channels` (`0139:57-140`).
- Status writers found: `invited` (invite.ts:207), `claimed` (0139:117-119). None write `live`, `lapsed`, `removed`. Entitlements `f2g_can_post_as_member`, `f2g_can_post_supplier` and the public directory all require `status='live'` (`0142:24-37`; `0143:27-42`; `0144:68-72`).
- Owner self-serve `channels.tagVenue` lets any NI claimed-venue owner tag into f2g independent of the roster (`routers/channels.ts:176-207`).
- Decisions recorded: #1 roster CSV outstanding, #4 open/members deferred, #7 staff-operated / `channel_admin` later, #8 custom domain deferred (`docs/f2g-association-build-plan.md:120-132`).

**FSA & data products**
- `fsa_establishments` public-read reference corpus, service-only write, nightly sync job dormant unless `FSA_NI_AUTHORITY_IDS` set (`0141:19-49`; `jobs/syncFsaNi.ts:127-148`); `fsa_match_dismissals` service-only (`0148:25-40`); per-venue public `venues.fsaRating(s)` (`routers/venues.ts:679-712`).
- `orgs` (suppliers): global, no `channel_id`, moderation-gated, self-insert pinned to draft/pending (`0136:20-39`; `0143:77-84`). `job_posts`: the only C-phase table with `channel_id` (`0142:46-79`).
- `close_expired_job_posts()` exists but nothing schedules it (`0142:111-131`).

**HQ admin (apps/admin, Roam staff only)**
- Channels view: Config (theme/surface/sections/nav/domains/mode flip), Roster (incl. `source_email`), Review, Onboarding funnel, Import (`apps/admin/src/components/views/Channels.tsx:19,77-96`); FSA review view; all via `adminProcedure` → `admin_users` row, writes audited (`packages/api/src/trpc.ts:88-145`; `routers/channelsAdmin.ts:23-93`).
- `KNOWN_SECTIONS` omits `directory` (`Channels.tsx:29`); nav editor edits a column no web code reads.

**Deploy / ops**
- API: one Railway service from a Dockerfile copying the whole monorepo (`railway.json:3-9`; `Dockerfile:13-29`); three cron configs (cj-logos, owner-digest, sync-fsa-ni); no health endpoint, no alerting (grep sentry/healthz/uptime → none).
- CI: lint/typecheck/vitest (packages only) + local `supabase db reset` + pgTAP; no `next build` (`.github/workflows/ci.yml:45-82`; `vitest.config.ts:5`). `db-migrate.yml` pushes to live on every main push, opt-in via secrets; `schema-drift.yml` probes only `channels` (`scripts/check-schema-drift.mjs:32-38`). Actions logs show both currently skip (secrets empty).
- No hosting config in repo (no netlify.toml/vercel.json); docs say Vercel (`docs/ROAM_HQ.md:71-81`), brief says Netlify.
- Generated DB types last regenerated 2026-08-11; zero references to any 0135+ table; 182–209 `LooseDb` casts (`packages/db/src/generated`; task A1b blocked on Supabase CLI).
- pgTAP exists for 0134–0148 except 0146.

## 3. Architecture as built

**Tenancy in the shared DB.** A channel is a row in `channels` (key, theme, `membership_mode`, `nav`, `sections`, `surface`) resolved from `channel_domains` (`0116:26-78`; `0134:28-77`). No core table has a tenant column; channel-awareness is bolted on via `venue_channels` (owner-writable tag, any channel), `channel_members` (staff-managed roster), `job_posts.channel_id`, and channel-parameterised RPCs. RLS is channel-blind; scoping lives in application/RPC code (`context.ts:173-178,233-236`). `orders`, `orgs`, `profiles`, `fsa_establishments`, `venue_views` carry no channel attribution. Eligibility ("what is F2G") is a hardcoded SQL array + NI bbox mirrored in `packages/core/src/f2g/index.ts:66-156` with a manual-lockstep comment. Key files: `supabase/migrations/0116, 0122, 0134–0148`; `packages/core/src/channels/index.ts`; `packages/core/src/membership/index.ts`.

**Host → channel routing.** Two tiers in `apps/web/src/lib/channel.ts:71-93`: env classifier (`f2g.`/`food.` prefixes, `NEXT_PUBLIC_F2G_HOSTS`) then CDN-cached `/api/channel-map` (s-maxage 300, 60s memo, fail-open to Roam: `lib/channelMap.ts:36-67`). Middleware sets cookie/header and redirects only `/explore` (`middleware.ts:28-43`). Browser tRPC forwards `x-roam-channel`; API treats it as an untrusted hint; `channels.current` returns the row or silently substitutes Roam if the flag is off. `ChannelProvider` hydrates as Roam, bootstraps surface from a hardcoded `key==='f2g'` map, then applies DB config (`ChannelProvider.tsx:76-131`). Ten shared components branch on `surface`/`isEnabled(section)`; 41 files / 248 occurrences reference f2g/storefront. `channels.nav` is parsed but never rendered; `StorefrontHeader` hardcodes its four links (`StorefrontHeader.tsx:25-30`). Which mechanism resolves `nifood2go.roam-local.com` in production is not determinable from the repo.

**Deploy topology.** One `apps/web` build serves both hosts with one root layout (`app/layout.tsx:122-158`) and one build-time `NEXT_PUBLIC_*` set (`scripts/sync-env.mjs:12-14`). One `appRouter` carries Roam and F2G routers (`routers/index.ts:43-100`); one Docker image backs API and all crons. One migration ledger; main = production for web, API and DB; runbook admits migrate-before-deploy is unenforced (`docs/db-release-runbook.md:29-31`). The only runtime decoupling is DB config (`channels.*`, `channel_domains`, feature flag) and defensive fallbacks (`channelSelect` base-column retry, `callFoodToGoNear` 4-arg fallback) added after the Sep 2026 blank-storefront skew incident.

## 4. Confirmed gaps by goal

Status key: NB = not built · P = partial · R = risky · D = doc/code mismatch · U = undocumented. Severity = judged.

### 4.1 Shared DB

| Gap | Status | Sev | Evidence |
|---|---|---|---|
| Any claimed-venue owner can self-tag into any channel via PostgREST and is ranked a "confirmed member"; NI fence is API-only | R | high | `0116:104-124`; `channels.ts:176-207`; `0145:41-50` |
| ~43 function revokes target PUBLIC only; post-0076 definers (e.g. `claim_places_detail_quota`) plausibly anon-executable; pgTAP covers 4 functions | R | high | `0080:44-52,124`; `0147:150-156`; `tests/00_rls_baseline_test.sql:18-45` |
| Migrate/drift workflows no-op without secrets; drift guard asserts only `channels`; 0146 has no pgTAP | P | high | `check-schema-drift.mjs:32-38,52-58`; `db-migrate.yml:35-46` |
| Generated types omit every 0135+ table; 182–209 loose casts; regen hard-coded and blocked | P | high (other-clients-dr) / medium (tenancy) | `packages/db/src/generated` (0 matches); `package.json:20` |
| No backup / PITR / restore / RTO-RPO statement anywhere | NB | high | grep docs/ README supabase/ .github → only venue suspend/restore |
| `venue-media` write policy exists only in live project (missing 0021); rebuild loses it; F2G uploads depend on it | R | high (DR) / medium (security) | `docs/security/phase-4-backlog.md:83-91,157-161` |
| No controller/processor, lawful basis, retention or erasure statement for roster PII | NB | high | `0135:31-37`; `legal/privacy/page.tsx:17-18`; grep gdpr docs/f2g-* → none |
| `orgs` has no `channel_id`; `f2g_can_post_supplier` hardcodes `c.key='f2g'` | P | medium | `0136:20-39`; `0143:34-41` |
| Invite links are bearer capabilities; a mis-addressed roster email confers ownership to a stranger; secret rotation undocumented | R | medium | `f2g/inviteToken.ts:16-27`; `0139:104-108` |
| Orders and notifications carry no channel stamp (see 4.3) | NB | medium | `0071:20-39`; `0123:94-106` |

### 4.2 Independence

| Gap | Status | Sev | Evidence |
|---|---|---|---|
| F2G is not a separate deployable: one Next app/build/bundle, one API image, one migration stream, one release train; every F2G change ships to Roam and vice versa | NB/R | **blocker** (deploy) / high (routing, tenancy, storefront, ops) | `layout.tsx:122-158`; `HomeSwitch.tsx:16-19`; `routers/index.ts:91-100`; `ci.yml:6-10` |
| Single release train: no path filters, staging, tags, env protection; migrate-before-deploy unenforced | R | high | `db-migrate.yml:18-21`; `db-release-runbook.md:29-31` |
| One platform-wide `INTERNAL_CALL_SECRET` held by the web deploy unlocks ban/approve/ingest/credits | R | high | `context.ts:214-224`; `internalTrpc.ts:41-59`; `moderation.ts:80-103` |
| Repo write = live schema on push to main; no CODEOWNERS or path-scoped review | R | high | `db-migrate.yml:18-27,60-70`; `.github/` (workflows only) |
| Route gating hardcoded to `/explore`; town-hall/market/events/deals/plans/threads/basecamp/search render under Association header; `channels.sections` ignored by middleware | P | high | `middleware.ts:28-43`; `0134:70` |
| Fail-open resolution + flag gating silently turns the Association domain into Roam; no alert | R | high | `channelMap.ts:18-20,46-49`; `channels.ts:103-111` |
| No `next build` in CI, no web tests; "kept in lockstep by tests" comment is false | P/D | high (deploy) / medium (routing, storefront) | `ci.yml:45-52`; `vitest.config.ts:5`; `lib/channel.ts:53` |
| F2G routes live in the Roam route tree, reachable on roam-local.com, gated only client-side | P | high | `app/jobs/page.tsx:16-18`; `Jobs.tsx:79-80` |
| Stripe success/cancel/onboarding URLs, invite claim links, digest links all built from `WEB_ORIGIN` → Roam host | R | high | `server.ts:134-136`; `market.ts:412-422,637-647`; `payments.ts:144-148`; `invite.ts:187-188` |
| All email sent as Roam from `no-reply@roam-local.com` (invite, digest, Supabase Auth templates) | P | high | `server.ts:74-75`; `ownerDigest/render.ts:46,71,83-87`; `supabase/email-templates/README.md:29-58` |
| Ops entirely Roam-staff console-driven; no F2G runbook, job status or trigger | NB | high | `docs/f2g-reingest-sweep.md:35-52`; `docs/fsa-hygiene-ratings.md:76-91` |
| Legal pages are Roam placeholder drafts with "placeholder copy" banner, no channel branching, rendered under Association chrome | D | high | `legal/terms/page.tsx:12-22`; `LegalDoc.tsx:44-63`; `ARCHITECTURE.md:116-122` |
| Supabase Auth redirect allow-list for nifood2go unverifiable; comms branding absent from F2G plans | U | high | `AuthPanel.tsx:105,165`; `docs/SSO_SETUP.md:23-24` |
| Directory/Jobs/Suppliers unreachable: header NAV hardcoded, `channels.nav` unread, sections seed `{storefront,explore}` only, HQ cannot toggle `directory`, sitemap lists `/` only | P | high | `StorefrontHeader.tsx:25-30`; `0134:69-77`; `Channels.tsx:29`; `sitemap.ts:33-41` |
| Hosting topology undocumented; docs say Vercel, brief says Netlify; how nifood2go maps to f2g (env vs DB row) unknown; `NEXT_PUBLIC_F2G_*` absent from `.env.example` | D/U | high (deploy) / medium (routing, ops) | `ROAM_HQ.md:71-81`; `SSO_SETUP.md:12-16`; `.env.example` (no F2G vars) |
| One API service + one image for Roam, F2G and crons; boot-time `requireEnv` couples availability | NB | medium | `Dockerfile:22-29`; `server.ts:49-67` |
| F2G eligibility baked into global SQL function and mirrored in core with manual lockstep (0146 already bit) | R | medium | `0146:6,36-47`; `core/f2g/index.ts:80-84,139-142` |
| `f2g` literal hardcoded in ~10–14 web files, API NI gate, OG palette (orange "Food to Go") disagrees with storefront navy/yellow | P/R | medium | `ChannelProvider.tsx:83-85`; `channel.ts:90-91`; `seo.ts:31`; `og/route.tsx:87-93`; `lib/storefront.ts:10-24` |
| Live `sections.jobs/suppliers/directory` exist only as unversioned prod DB state | U | medium | `0134:68-77`; grep sections 0135–0148 → none |
| `channels.nav` editable in HQ, never rendered | D | medium | `Channels.tsx:240-245`; grep `channel.nav` apps/web → none |
| Build-time `NEXT_PUBLIC_*` shared; F2G canonical origin baked into Roam bundle | R | medium | `sync-env.mjs:12-14`; `seo.ts:30-36` |
| Shared `en.json`; DB nav `labelKey`s depend on shipped catalogue | R | medium | `LocaleProvider.tsx:20`; `0134:45-47` |
| Commission is one global `PLATFORM_FEE_BPS`; no per-channel/venue fee | NB | medium | `server.ts:140-143`; `0134:29-31` |
| Stripe onboarding Roam-branded end to end; no `business_profile` | U | medium | `stripe/client.ts:93-106`; `en.json:2640-2662` |
| Push: one VAPID pair, SW fallback title "Roam", no icon, subscriptions not origin-bound | P | medium | `server.ts:57-64`; `public/sw.js:37-46`; `0003:66` |
| Notification/email copy hardcoded Roam-specific English in TS/SQL | R | medium | `server.ts:533-538`; `market.ts:756-889`; `0032:31-92` |
| Console and native send no `x-roam-channel`; hard-wired to Roam; no CI/deploy path; console duplicates pre-channel web client verbatim | NB/U/R | medium | `apps/console/src/lib/trpc.ts:27-39`; `apps/native/src/lib/trpc.ts:23-35` |
| No per-channel cost attribution (Places, Brevo, Stripe, Railway, GA); shared Places budget exhaustion invisible | NB/R | medium | `0024:36-44,140`; `places/budget.ts:13-16`; `Analytics.tsx:14` |
| Members have no self-service membership view or correction path | P | medium | `routers/f2g.ts:191-195`; `0135:71-74` |
| Roam-generic `/business`, `/account`, venue tabs, `/explore` links leak under storefront chrome | P | medium | `BusinessLanding.tsx:39,68-73,135`; `AccountHub.tsx:1-8`; `MyOrders.tsx:104-108` |
| Storefront chrome links to no legal page; "Powered by Roam" is a span | NB | medium | `StorefrontHeader.tsx:78-80`; `StorefrontHome.tsx:421-424` |
| Digest opt-out per profile, not per channel | P | low | `0129:36-40` |
| Country hardcoded GB, one Stripe platform account (undocumented decision) | U | low | `payments.ts:130-133` |
| Attributions page Roam-branded, omits FSA/OGL and GA | P | low | `legal/attributions/page.tsx:12-40` |
| Phase C doc names a `core/membership/entitlement.ts` that does not exist (entitlement is SQL) | D | low | `docs/f2g-phase-c-plan.md:32,125`; `0142:24-43` |

Not material (judge): storefront SEO/i18n partial (sitemap omits `/directory`, `storefront` namespace en-only).

### 4.3 Portal + feature requests

| Gap | Status | Sev | Evidence |
|---|---|---|---|
| No Association-facing role, portal, RLS surface or read tier; every aggregate is `adminProcedure`; granting HQ viewer exposes all tenants and roster emails | NB | **blocker** (tenancy, data, portal, security; membership judged blocker for role, high for data views) | `trpc.ts:88-145`; `0113:32-38`; `channelsAdmin.ts:23-93`; `build-plan.md:130` |
| No feature-request mechanism: no table, router, form, admin view, doc; only abuse reports and a Roam `mailto:` | NB | **blocker** (tenancy, data, portal) / high (membership, security, notifications) | `routers/index.ts:8-68`; `moderation.ts:51-66`; `SettingsHub.tsx:27,147` |
| No partner→Roam notification/email path even if requests were captured | NB | high | `brevo/transactional.ts:32-55`; `admin/HQ.tsx:84-88` |
| No Association identity in data model (`channels` has no owner/contact; `orgs` has one `owner_id`, no members) | NB | high | `0116:26-42`; `0136:20-39` |
| Orders not channel-attributed; F2G orders/GMV/fees unreportable, cannot be backfilled | NB/P | high (5 readers; notifications: medium) | `0071:20-40`; `0123:94-106`; `market.ts:233` |
| No order/revenue/fee/payout aggregate for anyone; `adminMetrics` has no orders | NB | high | `adminMetrics.ts:23-40`; `0071:46-54` |
| Three competing "member" definitions (roster status counts; roster∪tag; `live` only); no canonical count | R | high | `core/admin/channels.ts:124-156`; `0145:39-52`; `0144:72` |
| Roster `source_email` shown unmasked to every HQ member incl. viewers; PII reads unaudited (B4 plan claims "access-logged") | R | high | `core/admin/channels.ts:77,97`; `Channels.tsx:410`; `b4-plan.md:51-52` |
| FSA coverage is site-wide Google food venues, not member/NI scoped; no rating distribution | P | medium | `core/admin/fsaReview.ts:49,408-424` |
| No aggregates for jobs, suppliers, menus, order-ahead/delivery capability | NB | medium | `routers/jobs.ts:42-91`; `suppliers.ts:58-73` |
| No per-channel traffic/engagement measurement (one GA4 property, no channel dimension, no events) | NB | medium | `Analytics.tsx:14-25` |
| `venue_views` has no channel column, owner-only read | P | medium | `0068:14-34`; `venues.ts:1021-1052` |
| Webhook ignores refunds/disputes/failed/expired; `orders.status` unreliable; `ARCHITECTURE.md:127` refund claim refers to 0003 billing seam | P | medium | `server.ts:446-457,569` |
| Analytics and legal absent from every F2G plan | U | medium | grep build-plan → none |
| `channel_import_runs` write-only despite 0138/B4 promising HQ import reports | D | medium (ops) / low (data) | `0138:8,66`; `importRoster.ts:199` |
| Onboarding funnel is point-in-time; no trend | P | low | `core/admin/channels.ts:118-156` |
| Channel audit trail invisible outside HQ | P | low | `0113:61-82` |

Not material: ROAM_HQ.md does not document Channels/FSA views.

### 4.4 Product / security / ops hygiene

| Gap | Status | Sev | Evidence |
|---|---|---|---|
| No code path moves a roster member `claimed→live`; jobs, suppliers, directory all require `live`, so every member-only feature is unreachable | NB | **blocker** (tenancy) / high (membership) | `core/membership/index.ts:41-48`; `invite.ts:207`; `0139:117-119`; `0142:31-36` |
| Hero says "No commission taken out of your local's margin"; checkout applies 5% default fee | D | high | `en.json:1895`; `server.ts:137-143`; `market.ts:385,590` |
| Supplier submissions land draft/pending with no approval procedure, HQ view, or report path | NB | high | `0143:61-62,87`; `moderation.ts:27,51` |
| Live onboarding never run: roster CSV outstanding, thresholds PROVISIONAL, live-DB application unverifiable | P | high | `build-plan.md:120,124`; `core/matching/index.ts:224-232` |
| Auto-accept can bind two members to one venue; re-import never lapses/removes; no writer of `lapsed`/`removed` | R | high | `importRoster.ts:162-184`; `reviewQueue.ts:183-194` |
| No buyer order-confirmation email; no real-time vendor email/push; vendor's only email is next-day Roam digest | NB | high | `deliverOwnerDigest.ts:173`; `invite.ts:195`; `server.ts:552-563` |
| No alerting, health check, error tracking on any path; Sep 2026 incident found by a user | NB | high | grep → none; `channelMap.ts:18-20` |
| GA4 loads unconditionally, no consent banner, despite ARCHITECTURE hard gate | R | high | `layout.tsx:131`; `ARCHITECTURE.md:121` |
| FSA sync: Railway cron service not confirmed created; no run record; failed council pull reports `ok` | R | medium | `railway.cron-sync-fsa-ni.json:6-10`; `fsa/client.ts:43-70` |
| Photo-refresh weekly cron recommended, not committed; `close_expired_job_posts` unscheduled | P | medium | `venue-photo-refresh.md:69-70,92`; `0142:111-131` |
| Docs say pg_cron (code comments, phase-d plan) vs Railway cron (runbook); no `cron.schedule` exists | D | medium | `syncFsaNi.ts:7-8`; `server.ts:386`; `phase-d-plan.md:33-34` |
| B3-d mandatory security sign-off unrecorded; `F2G_INVITE_SECRET` undocumented | U | medium | `b3-plan.md:196-199`; `docs/security/` (phase-4 only) |
| Self-tagged non-roster venues count as members; mode flip is one click with no Association gate | R | medium | `channels.ts:176-207`; `Channels.tsx:148-158` |
| API returns `isMember`; `F2GVendorCard` never renders a member chip | NB | medium | `venues.ts:437`; `F2GVendorCard.tsx:15-27` |
| Refunds owner-only, full-only; no HQ/Association/partial path | P | medium | `market.ts:146-170,862-893` |
| Money flow undocumented in f2g docs; `.env.example` stale Stripe block, example fee 8% vs default 5% | U | medium | `.env.example:64-69,194-196` |
| GDPR export not found; `deleteMe` cascade omits orders and `channel_members` | P | medium | `profiles.ts:576-599` |
| Docs diverge: B3 "tags on import" (only on claim), `fsa_establishments` "service-only" (public read), ARCHITECTURE/ROAM_HQ never mention channels | D | low | `build-plan.md:82-83,99`; `0141:13-15,48-49` |
| Plans describe `internalProcedure` import route + backfill job; built as adminProcedure string; build-plan header says 0134 / Phase B planned | D | low | `b3-plan.md:37,57-59`; `adminActions.ts:183-203` |
| ARCHITECTURE overstates console (claim/push/insights/billing) and native (geofenced push) | D | low | `ARCHITECTURE.md:30-32` |

Not material: header basket links to `/orders` / no cross-page cart / no reorder; client-side storefront search; jobs expiry sweep + `/directory/[council]` unbuilt; storefront exposes no bell/push affordance; photo-refresh cron ad hoc.

## 5. Coupling points that constrain independence

- `apps/web/src/app/layout.tsx:122-158` — single root layout, Roam chrome mounted for all hosts.
- `apps/web/src/middleware.ts:28-70` — only host-aware layer; `/explore` sole gate; cookie/header carrier.
- `apps/web/src/lib/channel.ts:71-93`, `lib/channelMap.ts:36-67`, `app/api/channel-map/route.ts` — classifier with hardcoded `f2g.`/`food.` prefixes and `NEXT_PUBLIC_F2G_HOSTS`; fail-open.
- `apps/web/src/components/ChannelProvider.tsx:76-131` — `key==='f2g'` bootstrap; SSR always Roam.
- `TopBar/TabBar/SideNav/CreateFab/HomeSwitch/VenueDetail/VenueShop/Jobs/Suppliers/Directory` — surface/section branches inside shared components.
- `StorefrontHeader.tsx:25-30` — hardcoded nav; `seo.ts:30-46`, `og/route.tsx:78-94`, `sitemap.ts`, `robots.ts` — key-specific branches.
- `apps/web/messages/en.json:1879` — single catalogue; `scripts/sync-env.mjs` + `next.config.ts` — one build-time env.
- `packages/api/src/routers/index.ts:43-100` — one `appRouter`; `Dockerfile`, `railway.json`, `railway.cron-*.json` — one image.
- `packages/api/src/server.ts:132-143` — `webOrigin`, `PLATFORM_FEE_BPS`, Brevo sender, VAPID; `context.ts:214-236` — one `INTERNAL_CALL_SECRET`, channel as hint only.
- `supabase/migrations/` single ledger; `.github/workflows/{ci,db-migrate,schema-drift}.yml`; no CODEOWNERS.
- `feature_flags.marketplace.f2g.enabled` (0116:148-150) — Roam-owned kill switch.
- `venues_food_to_go_near` array (0146) ↔ `core/f2g/index.ts:66-156` lockstep; `f2g_can_post_supplier` hardcoded key (0143:38); `tagVenue` NI gate (`channels.ts:184`).
- `packages/db/src/generated` stale; `package.json:20` regen hard-coded to one project id.

## 6. Data available for an Association portal

| Dataset | Channel-scoped? | Aggregate read? | Who can read |
|---|---|---|---|
| `channels`, `channel_domains` | yes | `channelsAdmin.list` | public (active rows); staff |
| `venue_channels` (tag) | yes | none | public |
| `channel_members` (roster, PII) | yes | `channelsAdmin.onboarding` byStatus/byCouncil; `roster` (incl. email) | staff only; public `live` subset via `channel_members_search` |
| `channel_import_runs` | yes | none (write-only) | service only |
| `job_posts` | yes | none (paged list) | public (approved); author |
| `venues` | no (derived: tag ∪ roster ∪ NI+type filter) | site-wide `pulse`, `marketsBreakdown` | public; staff |
| `orders` / `order_items` | no | none | buyer; venue owner |
| `orgs` (suppliers) | no | none (paged list) | public (live+approved); owner |
| `external_refs` | no | none | public read |
| `fsa_establishments` | no | `fsaAdmin.coverage` (site-wide, not member-scoped) | public; staff |
| `fsa_match_dismissals` | no | none | service only |
| `venue_collection/delivery_settings`, `venue_products` | no (per venue) | none | public read; owner write |
| `venue_reviews` | no | rolled into `venues.roam_rating` | public |
| `venue_views` | no | none | venue owner only |
| `admin_audit_log` (channel key in `detail`) | partial | `adminActivity.auditLog` (no channel filter) | staff only |
| `profiles` | no | — | self |
| GA4 traffic | no (one property) | Roam GA account only | Roam |

## 7. Refuted claims

No reader-level gap was refuted by the skeptic pass (all `refutedGaps` empty). Documentation claims refuted by code:
- "A domain is a row, not a redeploy / next whitelabel is a config row" (0134:6-9; build-plan:66) — `f2g` key hardcoded in ≥10 web files, API, OG.
- "`channel.ts` normalizeHost kept in lockstep by tests" (`channel.ts:53`) — mirrors test covers CATEGORIES only.
- "Import reports surfaced read-only in Roam HQ" (0138:66; build-plan:89-90) — no reader exists.
- "B3 tags matched-live into `venue_channels`" (build-plan:82-83) — tagging happens only at claim.
- "`fsa_establishments` is service-role-only" (build-plan:100) — 0141 grants public select.
- "Core `membership/entitlement.ts` with `canPostAsMember`" (phase-c-plan:32,125) — entitlement is SQL `f2g_can_post_as_member`.
- "FSA sync triggered by pg_cron" (`syncFsaNi.ts:7-8`; phase-d-plan:33-34) — no `cron.schedule` anywhere.
- "Working `charge.refunded` handler" (`ARCHITECTURE.md:127`) — refers to 0003 billing seam; marketplace webhook handles two events.
- "Console does claim/post/push/insights/billing; native does geofenced push" (`ARCHITECTURE.md:30-32`) — console is posts-only, native is discover+follow.
- "Roster reads are access-logged" (b4-plan:51-52) — only mutations are audited.
- "Multi-item ordering isn't built" (`StorefrontHeader.tsx:12-13`) — `checkoutCart` exists; comment is stale.
- "Web/admin deploy on Vercel" (ROAM_HQ, SSO_SETUP, BREVO docs) vs Netlify per brief — unresolved, no config in repo.

## 8. Open questions for Andrew

**Membership**
- What makes a roster member `live`: automatic on claim, staff action, or Association confirmation?
- Should self-tagged non-roster venues count as members when mode flips, and is the CSV the full roster of record each import (missing rows → `lapsed`)?
- Keep bearer-link invites or require verified email = `source_email`?
- When does the sample roster CSV (decision #1) arrive?

**Portal identity and access**
- Is the Association a new channel-scoped role (`channel_admin`), an org/officer model on `orgs`, or a staff-proxied read-only v1?
- May the Association see row-level roster PII it supplied, or aggregates only? Should HQ viewers see emails unmasked, and should PII reads be audited?
- Does the portal live on the F2G host, inside apps/admin, or as a third app? Observe-only or act (re-invite, lapse, flag match)?
- Which "member" definition is canonical for reporting: roster status, tag, or union?

**Orders and data**
- Stamp `orders` with channel at checkout? What order data may the Association see (counts/GMV vs per-venue vs line-level)?
- Should `orgs` carry `channel_id`, and should eligibility (category array, NI bbox) become channel config?
- Scope FSA reporting to roster members or all NI storefront venues?

**Feature requests**
- In-DB table + HQ queue, external tracker, or email — and who at Roam is notified?

**Deploy and independence**
- What does "move independently" mean: second deployment of this monorepo, route group/package boundary, or separate repo sharing API+DB? Will the agency commit to `main`?
- Which host serves web/admin (Netlify vs Vercel), is nifood2go an alias or second site, and how is it mapped (env vs `channel_domains`)?
- Are `SUPABASE_*` secrets set so migrate/drift are live, and has `supabase migration repair` been run? Is there any staging?
- Should F2G-only server code and crons stay in the one Railway service? Should F2G get its own Places/Brevo/Stripe/GA accounts or per-channel attribution?
- Which Roam surfaces should be blocked on the F2G host vs deliberately shared? Should `StorefrontHeader` read `channels.nav`, and should live sections be codified in a migration?
- Does decision #8 (no custom domain) still hold?

**Payments**
- Is "no commission" a real term (fee 0 for F2G) or copy to correct? Per-channel or per-venue fee, owned by whom? Who beyond the owner may refund, and are partial refunds needed?

**Communications**
- Who is the email sender for F2G (Association domain or co-branded Roam)? Accept Roam-branded Supabase Auth emails? Real-time order emails, and whose Brevo cost? Per-channel `WEB_ORIGIN`/VAPID/opt-out?

**Legal and data protection**
- Controller/processor for the roster; DPA in place? Whose terms govern nifood2go? Consent banner before GA on all hosts? Is GDPR export a launch requirement, and must deletion cover orders and roster rows?

**Ops**
- Which Railway cron services actually exist? Who is paged when an F2G job fails? Should jobs record run history in the DB? Is Phase 2b of the sweep manual again? Are console and native deployed anywhere, and are they in F2G scope? Who holds Supabase CLI access to regenerate types?
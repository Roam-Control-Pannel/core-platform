# B4 — Roam HQ channel + roster admin (implementation-depth plan)

> **This is a plan, not a change.** No code until approved. Companion to
> [`f2g-association-build-plan.md`](./f2g-association-build-plan.md) and the B1 plan. Grounded against
> `main` (post B1/B2 + the storefront-incident safeguards; highest migration `0137`).
>
> **What B4 is:** the Roam-staff console for the Food to Go channel — the 5th `apps/admin` view.
> Decision #7 settled it as **Roam-staff-operated**, so B4 adds **no new role and no new RLS surface**:
> every read/write runs through the existing `adminProcedure` (staff-gated) using the service client,
> and every mutation is audited to `admin_audit_log` via a `@roam/core/admin` action function.

---

## 0. The B4a / B4b split (why, and what's buildable now)

Some of B4 has no data to act on until **B3** (bulk import → match → invite) exists — you can't review
matches that haven't been produced, or resend invites that were never sent. So B4 splits cleanly:

| | Slice | Depends on B3? | Build now? |
|---|---|---|---|
| **B4a** | Channel **config** editing · roster **browser** · onboarding **dashboard** · wire `setVenueChannel` (D7) | **No** | **Yes — unblocked** |
| **B4b** | **Match-review queue** (write `external_refs` `method='manual'`) · **invite send/resend** | **Yes** | Defer to after B3 |

**Recommendation: build B4a now.** It gives staff the console to configure the channel (theme, nav,
sections, membership mode, domains) and to *watch* the roster + onboarding progress — which is exactly
what you want in place *before* B3 runs the import, so you can see it land. B4b is a thin follow-on once
B3 produces review items and invite tokens.

---

## 1. Grounding (file\:line)

| Thing | Where |
|---|---|
| Admin shell + nav registry (`views` array, content swap) | `apps/admin/src/components/HQ.tsx:17-27,111-115` |
| Existing views (the pattern a 5th copies) | `apps/admin/src/components/views/{Overview,Moderation,Lookup,AuditTrail}.tsx` |
| Staff gate | `packages/api/src/trpc.ts:142` `adminProcedure` |
| Audited action pattern (mutation → core fn → `admin_audit_log`) | `packages/api/src/routers/adminActions.ts`, `@roam/core/admin` |
| Observe-only admin reads (service client) | `packages/api/src/routers/adminActivity.ts` |
| `setVenueChannel` action — exists, **unwired** (D7) | `adminActions.ts:100-123` + `core/admin.setVenueChannel` |
| Channel config columns (edited by B4a) | `channels.theme/logo_url/nav/sections/surface/membership_mode` (0116/0122/0134) |
| Domain map (edited by B4a) | `channel_domains` (host → channel_id, 0116) |
| Roster / directory / match ledger (read by B4a, written by B4b) | `channel_members` (0135), `orgs` (0136), `external_refs` (0137) |

---

## 2. B4a — server (all `adminProcedure`, audited)

### 2.1 Reads — a new `channelsAdmin` read router (staff-only, service client)
`channel_members` is service-managed (no client policy), so these reads run as `ctx.service` inside
`adminProcedure`. Staff **may** see the PII (`source_email`) — that is the point of the console and it
is access-logged; the public projection rule (C2) does not apply here.

- `channelsAdmin.list` → every channel with its full config (reuse `channels.listChannels`).
- `channelsAdmin.domains(channelKey)` → the `channel_domains` rows for a channel.
- `channelsAdmin.roster(channelKey, { status?, council?, q?, cursor })` → paginated `channel_members`
  for the channel, filterable by status / council area / name search; joins the matched `venues` row
  (name, slug) when `venue_id` is set. Keyset-paginated (the roster is the "5,000").
- `channelsAdmin.onboardingStats(channelKey)` → counts grouped by `status` and by `source_council`
  (the dashboard). One grouped query, not N.

### 2.2 Writes — added to `adminActions`, each via a `@roam/core/admin` fn writing `admin_audit_log`
- `adminActions.setChannelConfig(channelKey, patch)` — patch over `theme` (hex-validated by
  `parseChannelTheme`), `logo_url`, `surface` (`roam|storefront`), `sections` (allow-map),
  `nav` (validated by `parseChannelNav`), `membership_mode` (`open|members`). Reuses the core
  parsers/validators so a bad value can't be stored. **The `membership_mode` flip (decision #4) is
  one call here** — the reversible switch, staff-gated + audited.
- `adminActions.addChannelDomain(channelKey, host)` / `removeChannelDomain(channelKey, host)` —
  onboard a whitelabel host as a row (pairs with A2-middleware's config-driven resolution). `host`
  normalised via `normalizeHost` before insert.
- **Wire `setVenueChannel`** (already implemented, D7) into the UI — no server change, just consume it.

No new table → **no migration** for B4a. (`channels`/`channel_domains` writes are already
staff/service-only; the new procedures are just the audited front door.)

## 3. B4a — client: the `Channels` view

Add `{ key: "channels", label: "Channels" }` to HQ's `views` and a `<ChannelsView/>` case in the
content swap; new `apps/admin/src/components/views/Channels.tsx` with three sub-tabs:

- **Config** — pick a channel; edit theme swatches, logo, surface, the sections allow-map (toggles),
  the nav editor (ordered key/href/labelKey rows), and the `open ↔ members` mode switch (with a
  confirmation: flipping to `members` hides non-member venues). Domains: list + add/remove host.
- **Roster** — a filterable, paginated table of `channel_members`: source name, council, status
  badge, matched venue (link to the venue), contact email. Filters: status, council, search.
- **Onboarding** — the progress dashboard: a status funnel (imported → invited → claimed → live) and
  a by-council breakdown, from `onboardingStats`.

Follows the existing view components' conventions (`ui.tsx` `Panel`/`Kicker`, `theme.ts` `C`/`F`,
`canAct` gating, `onChanged` badge refresh). Admin has no test runner today (review debt D10), so
verification is typecheck + the deploy preview, matching how the other admin views ship.

## 4. B4a — tests
- **Core** (`@roam/core/admin`) unit tests for the new action fns: the config patch validates/normalises
  (bad hex dropped, bad surface rejected, nav malformed-item-dropped, membership_mode constrained),
  and each writes an `admin_audit_log` entry (assert via a fake service client).
- **pgTAP**: B4a adds no table, but add coverage asserting a **non-staff** caller cannot reach the
  channel-config writes (the `adminProcedure` gate) and that `channel_members` stays unreadable to
  `anon`/`authenticated` (re-assert B1's posture now that a staff read path exists) — cheap regression
  insurance.

## 5. B4b — deferred (needs B3), sketched
- **Match-review queue**: reads the B2 `review`-band candidates B3 persisted, lets staff accept/reject;
  accept writes `external_refs` `method='manual'` (the permanent correction) and tags the venue live.
  New audited `adminActions.resolveMatch(...)`.
- **Invite send/resend**: triggers B3's `claim_venue_with_invite` HMAC-token issue/re-issue via Brevo;
  audited. Both are small once B3 exists.

## 6. Done-checks · risk · sequencing
- **Done (B4a):** a staff user can edit f2g's config (incl. the mode flip) and add a domain, both
  appearing in the Audit view; the roster + onboarding tabs render `channel_members` (empty until B3,
  which is correct); `grep setVenueChannel apps/` is no longer empty (D7 closed); core action tests +
  pgTAP gate green.
- **Risk: LOW–MEDIUM.** No new table/RLS; the one behaviour-sensitive control is the `membership_mode`
  flip — guard it behind a confirm and it's reversible. Staff-only + audited throughout.
- **PR shape:** one PR for B4a (server procedures + core action fns + admin view + tests). B4b is a
  separate PR after B3.
- **Not in B4a:** the match-review queue, invites (B4b); any Association self-serve role (decision #7
  says staff-operated — explicitly out).

## 7. The one decision to confirm before building B4a
Nothing blocks it, but one call shapes the Config tab: **should the `open ↔ members` mode flip live in
this console now** (staff can flip it, audited), or stay a DB-only operation until the Association
signs off (decision #4 deferred the *decision*, not the *control*)? Recommend **building the control
now, behind a confirm** — it's audited and reversible, and having it ready is harmless while the
decision waits. Say if you'd rather omit it from B4a.

# Roam — Architecture

> This document is the **law of the codebase**. The Launch Scope Brief draws the line
> on *what* ships; this draws the line on *how* it's built so that v1 → v5 needs no rewrite.
> When a change tempts you to violate something here under deadline pressure, that
> temptation is the signal to stop, not the reason to proceed.

---

## The one rule everything else serves

**One core. One data model. Thin shells per surface. No shell carries its own copy of the truth.**

There are three consumer/business surfaces — web, business console, native — and there will
be more (a public partner API is on the roadmap). Every one of them is a *thin shell* over the
same `packages/core` and the same database. Business logic does not live in a Next.js route, a
React component, or an Expo screen. It lives in `core`, is exposed through `api`, and is called
identically by every shell.

If you ever find yourself writing the same rule twice in two surfaces, you have already broken
the law. Move it down into `core`.

---

## Workspace layout

```
roam/
├── apps/
│   ├── web/        Consumer web (Next.js 16, React 19) — primary launch surface, SEO, deep links
│   ├── console/    Business console (Next.js 16) — claim, post, push, insights, billing
│   └── native/     Consumer native (Expo / React Native) — geofenced push, app-store presence
├── packages/
│   ├── core/       Domain logic + business rules. Framework-agnostic. NO React, NO Next, NO Expo.
│   ├── db/         Supabase schema, migrations (SQL-first), RLS as code, generated types.
│   ├── api/        tRPC routers — the typed contract every shell calls. Transport boundary.
│   └── design/     Design system as code: tokens → primitives. Consumed by all surfaces.
└── supabase/
    └── migrations/ Timestamped SQL migrations. The data model's single source of truth.
```

### Dependency direction (never violated)

```
apps/*  ──depend on──►  packages/api  ──►  packages/core  ──►  packages/db
apps/*  ──depend on──►  packages/design
```

- `core` may depend on `db` (types + queries). It may **not** depend on `api`, any `app`, or any UI framework.
- `api` depends on `core`. It is the *only* thing that turns core capabilities into callable endpoints.
- `apps` depend on `api` and `design`. They contain **rendering and interaction only** — no business rules.
- Nothing depends on an `app`. Apps are leaves.

A dependency pointing the wrong way is a build-breaking error, not a style nit.

---

## Why these specific choices

| Decision | Why, for *this* project |
|---|---|
| **pnpm + Turborepo** | One install, one typecheck graph, cached builds. A solo builder cannot afford three repos drifting out of sync. |
| **Transport-agnostic `core`** | Native ships at launch alongside web. If core leaked Next-server logic, native would need its own copy — the exact rewrite this doc forbids. Core is built as if native shipped first. |
| **SQL-first migrations + RLS** | The truth lives in Postgres, visible and reviewable, not hidden in an ORM. Row-level security is the data model's own immune system, not app-layer guesswork. Proven on DDS. |
| **tRPC (internal), REST (public, if ever)** | End-to-end types with no codegen step that can be forgotten — a refactor in core fails the build in every shell at once. A future public/partner API is a *separate* thin REST shell over the same core, never tRPC stretched out of role. |
| **Supabase Edge Functions for jobs/push** | Scheduled posts, push credits, digests, geofenced push run server-to-server, calling core directly. Keeps background work in-stack instead of bolting on a separate service. |

---

## Server-to-server auth convention

Background jobs and Edge Functions that call internal endpoints authenticate with a shared
secret header, carried over from the Roam CRM pattern:

```
x-internal-call: <INTERNAL_CALL_SECRET>
```

Middleware validates this header to bypass user-session auth for trusted server-to-server calls.
The secret lives only in environment config, never in the repo. This is the *established* pattern
for cron → API and Edge Function → API calls; do not invent a second mechanism.

---

## The dormant-seam principle (how v1 carries v5 without migration)

The Launch Scope Brief puts marketplace, travel, automation, and data products **below the launch
line** — but requires their *seams* to exist so lighting them up later needs **no migration**.

In practice that means, from the first migration:

- Tables and columns for shop/marketplace, trips/travel, and automation journeys exist in the
  schema as **inactive structures** — present, typed, RLS'd, but unreferenced by any shipping feature.
- Feature availability is gated by config/flags (`feature_flags`), not by the absence of schema.
- Subscription tiers (`free` / `premium` / `gold`) all exist in the enum from day one. Only `free`
  is wired to live checkout at launch; `premium`/`gold` are dormant behind a flag — a config flip,
  not a code change, turns them on.

A dormant seam costs nothing at runtime and saves a migration later. An *absent* seam costs a
migration — exactly what we refuse to pay.

---

## Definition of done (per the brief's "every screen ships its states")

A feature is **not done** until it ships every applicable state:
empty · first-run · loading (skeletons, not spinners) · error · offline · permission-denied ·
no-results · unclaimed-venue · push-quota-exhausted · 404-removed.

Because Roam launches **globally**, the empty/first-run/unclaimed states are not edge cases —
they are the *median* experience in most of the world on day one. They get built first and
built well. "Looks new," never "looks dead."

---

## Hard gates (cannot ship without)

These are non-negotiable for the open internet + app stores. They are not features and they are
not optional:

- Privacy policy, terms, EULA, cookie/consent.
- GDPR/UK-GDPR data export + account deletion (also an app-store requirement).
- Content moderation + reporting on **all** UGC (profiles, posts, chat). Global scale forces
  **automated first-pass + manual queue**, not manual-only. App stores reject without this.
- Block/report users; privacy-respecting friends-nearby (never expose precise location).
- Push consent + opt-out; secure auth, secrets handling, rate limiting, abuse protection.
- Stripe live for the wired tier, with a **working `charge.refunded` → state update** (the DDS gap, closed here).

---

## Commit & CI discipline (carried from DDS / Roam CRM)

- **Lint + TypeScript checks are mandatory in the commit chain.** No green, no merge.
- PRs over direct-to-main.
- Explicit `git add` of named files; `git status` between add and commit.
- Production testing is the primary verification step.
- Idempotent patch scripts where scripted edits are needed, with anchor-uniqueness checks.

---

*Hold the line on scope. Hold the law on architecture. The two together are what let Roam
be shipped proud at v1 and grown into v5 without ever stopping to rebuild the foundation.*

# Pre-F2G Migration Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace migrations `0001` through `0115` with six logically grouped, reproducible migrations while keeping every migration from `0116` onward byte-for-byte unchanged.

**Architecture:** Build the final pre-F2G schema from a clean replay of the existing chain using Supabase CLI `2.117.0`, then split the schema-only result by dependency and domain. Required rows omitted by schema-only generation live in a sixth idempotent bootstrap migration; the F2G history continues unchanged at `0116`.

**Tech Stack:** PostgreSQL 17, Supabase CLI 2.117.0, pgTAP, SQL, pnpm/Turbo, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-16-migration-consolidation-design.md`

## Global Constraints

- Consolidate only migration versions `0001` through `0115`.
- Preserve the names and bytes of every migration version at or above `0116`.
- The active pre-F2G history must contain exactly `0001` through `0006`; versions `0007` through `0115` remain retired.
- Preserve the final schema, RLS posture, function ACLs, triggers, indexes, comments, and required bootstrap rows produced by the original chain.
- Do not commit credentials, database URLs, tokens, passwords, dumps, or backups.
- Do not stage or modify the unrelated untracked `docs/ROADMAP.md` or `findings/` paths.
- Stop before a remote ledger repair or reset if project identity, backups, or schema equivalence cannot be verified.

---

### Task 1: Freeze the reference state and prove the old layout fails the new contract

**Files:**
- Modify: `docs/superpowers/specs/2026-09-16-migration-consolidation-design.md`
- Create: `/private/tmp/roam-pre-f2g-reference/` (untracked verification artifacts)

**Interfaces:**
- Consumes: current `origin/main` migration chain through `0153`.
- Produces: reference schema dump, `0116+` SHA-256 manifest, and a failing layout assertion.

- [ ] **Step 1: Save the current migration manifest**

```bash
mkdir -p /private/tmp/roam-pre-f2g-reference
find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print \
  | sort \
  | while read -r file; do
      version=$(basename "$file" | cut -d_ -f1)
      if [ "$version" -ge 116 ]; then shasum -a 256 "$file"; fi
    done \
  > /private/tmp/roam-pre-f2g-reference/f2g.sha256
```

- [ ] **Step 2: Run the new layout assertion and verify RED**

```bash
actual=$(find supabase/migrations -maxdepth 1 -type f -name '*.sql' \
  | sed 's#.*/##' | cut -d_ -f1 | awk '$1 + 0 < 116' | sort | tr '\n' ' ')
test "$actual" = "0001 0002 0003 0004 0005 0006 "
```

Expected: FAIL because the current tree still contains versions `0007` through `0115`.

- [ ] **Step 3: Replay and dump the original history**

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db start
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db reset
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 test db --local
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db dump --local --schema public,storage \
  --file /private/tmp/roam-pre-f2g-reference/original.sql
```

Expected: reset succeeds, pgTAP passes, and `original.sql` is non-empty.

- [ ] **Step 4: Commit the approved design revision**

```bash
git add docs/superpowers/specs/2026-09-16-migration-consolidation-design.md
git commit -m "docs: scope migration consolidation before f2g"
```

### Task 2: Generate and organize the six pre-F2G migrations

**Files:**
- Replace: `supabase/migrations/0001_foundation.sql` through `supabase/migrations/0115_saved_transit_stops.sql`
- Create: `supabase/migrations/0001_core_foundation.sql`
- Create: `supabase/migrations/0002_venues_and_discovery.sql`
- Create: `supabase/migrations/0003_social_and_community.sql`
- Create: `supabase/migrations/0004_commerce_and_operations.sql`
- Create: `supabase/migrations/0005_security_and_api.sql`
- Create: `supabase/migrations/0006_bootstrap_data.sql`

**Interfaces:**
- Consumes: schema-only output of the original history at version `0115` and top-level DML from the retired migrations.
- Produces: six ordered SQL migrations consumed unchanged by `0116_channels_foundation.sql`.

- [ ] **Step 1: Generate the schema-only pre-F2G squash in a disposable copy**

```bash
work=$(mktemp -d /private/tmp/roam-migration-squash.XXXXXX)
git archive HEAD | tar -x -C "$work"
cd "$work"
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db start
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db reset --version 0115
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 migration squash --local --version 0115
```

Expected: the disposable copy contains one schema-only migration representing versions through `0115`; files `0116` and later remain present and unchanged.

- [ ] **Step 2: Split the generated SQL by responsibility and dependency**

Move complete statements—not fragments—into the six files in this order:

```text
0001_core_foundation.sql
  extensions; enum/domain types; shared timestamp/identity helpers;
  feature_flags and profiles tables, constraints, indexes, and comments

0002_venues_and_discovery.sql
  venues, venue ownership/claims, venue photos/media metadata, discovery/search,
  enrichment, reviews, locality and geo objects

0003_social_and_community.sql
  follows/friendships, plans/meetups, chat, profile wall, Town Hall, events,
  presence and their domain-local functions/indexes/comments

0004_commerce_and_operations.sql
  billing, offers, birthday delivery, marketplace/products/orders, affiliate deals,
  notifications, moderation, admin/audit, saved transit stops

0005_security_and_api.sql
  cross-domain functions and triggers; final RLS enablement/policies; final grants
  and revocations; storage.objects policies; comments on API/security objects

0006_bootstrap_data.sql
  idempotent feature_flags upsert; profile-media bucket upsert; chat-media bucket upsert
```

Each SQL-language function whose body references a later file must be created in `0005`, after all tables exist. Foreign keys remain with the table when they point backward; cross-domain foreign keys that point forward are added with `ALTER TABLE` in `0005`.

- [ ] **Step 3: Write the bootstrap data explicitly**

`0006_bootstrap_data.sql` must upsert the five original feature flags and the final pre-F2G Storage bucket definitions:

```sql
insert into public.feature_flags (key, enabled, description) values
  ('billing.paid_tiers', false, 'Premium/Gold checkout. Dormant at launch (free tier only).'),
  ('marketplace.enabled', false, 'Stage 5 shop/marketplace. Seam modelled, feature off.'),
  ('travel.enabled', false, 'Stage 5 trips/travel. Seam modelled, feature off.'),
  ('automation.enabled', false, 'Stage 5 automated promotion journeys. Seam modelled, feature off.'),
  ('ai.personalisation', false, 'AI personalisation. Post-launch.')
on conflict (key) do update
set enabled = excluded.enabled,
    description = excluded.description;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('profile-media', 'profile-media', true, 5242880,
    array['image/jpeg', 'image/png', 'image/webp', 'video/mp4', 'video/quicktime']),
  ('chat-media', 'chat-media', false, 10485760,
    array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
set name = excluded.name,
    public = excluded.public,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;
```

- [ ] **Step 4: Verify GREEN for the migration-layout assertion**

Run the assertion from Task 1 Step 2.

Expected: PASS with exactly `0001 0002 0003 0004 0005 0006` below the F2G boundary.

- [ ] **Step 5: Verify unchanged F2G bytes**

```bash
find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print \
  | sort \
  | while read -r file; do
      version=$(basename "$file" | cut -d_ -f1)
      if [ "$version" -ge 116 ]; then shasum -a 256 "$file"; fi
    done \
  > /private/tmp/roam-pre-f2g-reference/f2g-after.sha256
diff -u /private/tmp/roam-pre-f2g-reference/f2g.sha256 \
  /private/tmp/roam-pre-f2g-reference/f2g-after.sha256
```

Expected: no diff.

- [ ] **Step 6: Commit the consolidated migrations**

```bash
git add supabase/migrations
git commit -m "refactor(db): consolidate pre-f2g migrations"
```

### Task 3: Make administrator bootstrap explicit and refresh migration documentation

**Files:**
- Create: `supabase/bootstrap/admin-owner.sql`
- Replace: `supabase/migrations/README.md`
- Modify: `docs/db-release-runbook.md`

**Interfaces:**
- Consumes: `public.admin_users`, `public.profiles`, and `auth.users` created by the migration history.
- Produces: an idempotent post-sign-up founder grant and accurate reset/cutover instructions.

- [ ] **Step 1: Add the fail-visible administrator bootstrap script**

```sql
do $$
declare
  founder_id uuid;
begin
  select id into founder_id
  from auth.users
  where lower(email) = 'andrew@roam-everywhere.com';

  if founder_id is null then
    raise exception 'Founder auth user andrew@roam-everywhere.com does not exist';
  end if;

  insert into public.admin_users (id, role, note)
  values (founder_id, 'owner', 'Founder — granted by supabase/bootstrap/admin-owner.sql')
  on conflict (id) do update
  set role = excluded.role,
      note = coalesce(public.admin_users.note, excluded.note);
end
$$;
```

- [ ] **Step 2: Rewrite the migration README**

Document the six pre-F2G files, the preserved `0116+` history, local reset/test commands, why retired versions must not be reintroduced, and the administrator bootstrap command:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/bootstrap/admin-owner.sql
```

- [ ] **Step 3: Update the release runbook**

Replace the blanket claim that every migration is idempotent with the explicit consolidation cutover: existing non-production projects must be backed up and reset; `db push` alone cannot reconcile deleted historical versions.

- [ ] **Step 4: Commit bootstrap and documentation**

```bash
git add supabase/bootstrap/admin-owner.sql supabase/migrations/README.md docs/db-release-runbook.md
git commit -m "docs(db): document consolidated migration cutover"
```

### Task 4: Prove schema and behavior equivalence locally

**Files:**
- Potentially modify: `supabase/migrations/0001_core_foundation.sql` through `0006_bootstrap_data.sql` when verification exposes a real difference
- Potentially modify: `packages/db/src/generated/database.types.ts` only if regeneration finds an intentional schema correction

**Interfaces:**
- Consumes: consolidated migration chain and `/private/tmp/roam-pre-f2g-reference/original.sql`.
- Produces: passing reset, pgTAP, normalized schema diff, and repository checks.

- [ ] **Step 1: Replay the complete consolidated history**

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db reset
```

Expected: all six consolidated migrations and every unchanged migration from `0116` onward apply successfully.

- [ ] **Step 2: Run pgTAP**

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 test db --local
```

Expected: every database test passes.

- [ ] **Step 3: Dump and compare final schemas**

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db dump --local --schema public,storage \
  --file /private/tmp/roam-pre-f2g-reference/consolidated.sql
diff -u /private/tmp/roam-pre-f2g-reference/original.sql \
  /private/tmp/roam-pre-f2g-reference/consolidated.sql
```

Expected: no semantic differences. Dump noise limited to migration-generated comments or stable ordering must be normalized explicitly and documented; unexplained differences block the PR.

- [ ] **Step 4: Verify generated database types**

Generate types from the local rebuilt database and compare them with the checked-in file:

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 gen types typescript --local \
  > /private/tmp/roam-pre-f2g-reference/database.types.ts
diff -u packages/db/src/generated/database.types.ts \
  /private/tmp/roam-pre-f2g-reference/database.types.ts
```

Expected: no schema-loss diff. If the checked-in types are already stale, document the pre-existing mismatch rather than mixing an unrelated regeneration into this PR.

- [ ] **Step 5: Run repository checks with the installed pnpm**

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore ./node_modules/.bin/turbo run lint typecheck test --env-mode=loose
```

Expected: all tasks pass; pre-existing warnings may remain, with no new warnings from this change.

- [ ] **Step 6: Commit verification-driven corrections**

```bash
git add supabase/migrations packages/db/src/generated/database.types.ts
git diff --cached --quiet || git commit -m "fix(db): align consolidated schema with reference"
```

### Task 5: Inventory remotes, prepare cutover, and create the pull request

**Files:**
- Modify: `.github/workflows/db-migrate.yml` only if its comments or safeguards contradict the consolidation cutover
- Create: no checked-in backup files

**Interfaces:**
- Consumes: locally verified migration chain and Supabase/GitHub authentication.
- Produces: remote inventory, safe cutover evidence where credentials permit it, pushed branch, and GitHub PR.

- [ ] **Step 1: Inventory authenticated Supabase projects without mutation**

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 projects list
```

Confirm that `kyancopdkxotzzkzqsmf` resolves to the expected non-production project. Record any other project refs without resetting them unless their identity and disposable classification are explicit.

- [ ] **Step 2: Back up each confirmed cutover target**

Use the target's escaped database URL and write only under `/private/tmp/roam-pre-f2g-reference/<project-ref>/`:

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db dump --db-url "$SUPABASE_DB_URL" \
  --file /private/tmp/roam-pre-f2g-reference/kyancopdkxotzzkzqsmf/schema.sql
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db dump --db-url "$SUPABASE_DB_URL" --data-only --use-copy \
  --file /private/tmp/roam-pre-f2g-reference/kyancopdkxotzzkzqsmf/data.sql
```

Expected: both files exist and are non-empty. Do not continue if either backup fails.

- [ ] **Step 3: Reconcile a schema-equivalent target without replacing application data**

```bash
pnpm db:reconcile-history -- \
  --project-ref kyancopdkxotzzkzqsmf \
  --confirm-project-ref kyancopdkxotzzkzqsmf \
  --schema-equivalence-confirmed \
  --apply \
  --backup-file /private/tmp/roam-pre-f2g-reference/kyancopdkxotzzkzqsmf/migration-ledger.sql
```

Expected: application data remains in place; versions `0001` through `0006` and `0116` onward are applied; versions `0007` through `0115` are absent; `db push --dry-run` is empty. If schema equivalence is not proven, use the documented non-production rebuild fallback instead. If credentials, the database password, or exact identity are unavailable, stop remote work and state that cutover remains a post-merge operator step.

- [ ] **Step 4: Verify the rebuilt remote**

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -c "notify pgrst, 'reload schema';"
SUPABASE_URL="$SUPABASE_URL" SUPABASE_ANON_KEY="$SUPABASE_ANON_KEY" \
  node scripts/check-schema-drift.mjs
```

Expected: PostgREST reload succeeds and the drift probe reports every required read as available.

- [ ] **Step 5: Run final diff and status checks**

```bash
git diff --check origin/main...HEAD
find supabase/migrations -maxdepth 1 -type f -name '*.sql' -print \
  | sort \
  | while read -r file; do
      version=$(basename "$file" | cut -d_ -f1)
      if [ "$version" -ge 116 ]; then shasum -a 256 "$file"; fi
    done \
  > /private/tmp/roam-pre-f2g-reference/f2g-final.sha256
diff -u /private/tmp/roam-pre-f2g-reference/f2g.sha256 \
  /private/tmp/roam-pre-f2g-reference/f2g-final.sha256
git status --short
```

Expected: `git diff --check` and the `0116+` hash comparison pass. Status contains only task files plus the user's untouched untracked paths.

- [ ] **Step 6: Push the branch and open the PR**

```bash
git push -u origin feat/consolidate-migrations
gh pr create --base main --head feat/consolidate-migrations \
  --title "refactor(db): consolidate pre-F2G migrations" \
  --body-file /private/tmp/roam-pre-f2g-reference/pr-body.md
```

The PR body must summarize the `0001–0115` to `0001–0006` reduction, state that `0116+` hashes are unchanged, list reset/pgTAP/schema-diff/type/repository verification, and disclose whether remote cutover completed or remains required after merge.

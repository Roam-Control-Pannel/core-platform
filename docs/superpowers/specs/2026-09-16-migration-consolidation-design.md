# Migration Consolidation Design

## Objective

Replace only the pre-Food-to-Go portion of the Supabase migration chain with six compact, logically grouped baselines, retain the small set of rows required for a working installation, and preserve the Food-to-Go migration history unchanged.

The completed change must preserve the schema, row-level security, grants, functions, triggers, views, comments, and required bootstrap configuration produced by the current migration chain. Historical data corrections do not belong in the new baseline because a newly rebuilt database has no historical application data to correct.

## Current State

- `supabase/migrations/` contains 152 SQL files, numbered `0001` through `0153` with `0021` unused.
- A fresh local database replays every migration and then `supabase/seed.sql`; CI runs this flow before the pgTAP suite.
- `supabase/migrations/README.md` documents only the original four migrations and is no longer an accurate operator guide.
- The remote release workflow targets one project through `SUPABASE_PROJECT_REF` and runs `supabase db push`.
- Project ref `kyancopdkxotzzkzqsmf` is referenced by checked-in application configuration. No other remote project ref is discoverable from the repository.
- The release runbook records that the remote migration ledger has previously under-reported the schema actually installed because SQL was applied out of band.
- Food-to-Go work starts at `0116_channels_foundation.sql`. All migrations from `0116` onward are useful feature history and remain byte-for-byte unchanged.
- Required pre-F2G non-schema state exists inside migrations: feature flags and Storage bucket rows.
- `0114_seed_admin_owner.sql` depends on an existing `auth.users` row. It is not a reliable fresh-install migration because the founder may not have signed up when migrations run.

## Chosen Approach

Replace migrations `0001` through `0115` with six clean, dependency-ordered migrations. Keep every migration from `0116` onward unchanged, then rebuild each confirmed disposable remote project from the consolidated history.

The active history will become:

1. `0001_core_foundation.sql` — extensions, enums, profiles, feature flags, and shared helpers.
2. `0002_venues_and_discovery.sql` — venues, ownership and claims, photos, search, reviews, and enrichment.
3. `0003_social_and_community.sql` — friends, plans, chat, posts, Town Hall, events, and presence.
4. `0004_commerce_and_operations.sql` — billing, offers, marketplace, orders, affiliate deals, notifications, administration, and transit.
5. `0005_security_and_api.sql` — final functions, triggers, RLS policies, grants, and Storage policies that span the domain files.
6. `0006_bootstrap_data.sql` — idempotent pre-F2G feature flags and Storage bucket rows omitted by schema-only generation.

Files `0116_channels_foundation.sql` through the latest migration on `main` retain their existing names and content. At design time the latest migration is `0153_storage_bucket_limits_and_profile_read.sql`; later migrations added during implementation are covered by the same `>= 0116` preservation rule.

The old migration files will be removed from the active migration directory after equivalence testing. Git history remains the archive; duplicating the old files elsewhere in the repository would retain the maintenance burden without improving recoverability.

Future migrations continue the repository's existing ordered naming convention after the latest migration. The missing `0007` through `0115` versions are intentional retired history and are not reused.

## Baseline Generation

The baseline will be generated from a clean local database produced by the existing migration chain, not from the hosted project. This makes the repository's reviewed migration history the source of truth and prevents known remote ledger drift or untracked Dashboard changes from entering the new baseline.

The Supabase CLI's migration-squash workflow will be run in an isolated temporary copy and stopped at version `0115`, so it cannot destroy the source migration chain or absorb F2G migrations. The generated schema will be split into the five dependency-ordered schema files above; omitted required data will be written explicitly in `0006_bootstrap_data.sql`.

The generated SQL must be inspected for:

- extensions and enum types;
- all application tables, constraints, indexes, and sequences;
- functions, overloads, triggers, and views;
- RLS enablement and policies;
- grants and revocations for `anon`, `authenticated`, and `service_role`;
- comments used as schema documentation;
- policies on Supabase-managed tables such as `storage.objects`;
- object ownership or search paths that differ between the local and hosted Supabase runtimes.

Generated statements that describe Supabase-managed internal schemas rather than application-owned objects will not be committed unless they are required to reproduce an application policy or permission.

## Bootstrap Data

`0006_bootstrap_data.sql` will explicitly and idempotently establish:

- the final set of `feature_flags` rows and their intended enabled states;
- the `profile-media` bucket with its final public flag, size limit, and MIME types;
- the `chat-media` bucket with its final private flag, size limit, and MIME types.

Channel rows, channel configuration, channel-domain mappings, and later Storage changes remain owned by unchanged migrations `0116` and later.

The bootstrap migration will not include:

- updates that corrected historical venue rows;
- backfills for rows that cannot exist on a freshly rebuilt database;
- the founder `admin_users` insert;
- local sample records already owned by `supabase/seed.sql`.

The bootstrap migration will use upserts so a local reset and a deliberate reapplication converge on the same state.

## Administrator Bootstrap

The founder grant will move out of schema history into a documented, idempotent operator script under `supabase/bootstrap/`. The script will grant the owner role only when the matching Auth user exists and will fail visibly when it does not, instead of silently inserting zero rows during database setup.

The operator sequence after a destructive remote rebuild is:

1. Create or sign in the intended founder Auth account.
2. Run the administrator bootstrap against the exact remote project.
3. Verify the resulting `admin_users` row.

No password, access token, database URL, or service-role key will be committed.

## Verification

Both histories will be exercised before old files are removed:

1. Replay the current 152-file chain into a clean local Supabase database.
2. Produce a schema-only dump for the application-owned schema surface.
3. Generate the proposed six pre-F2G migrations in a temporary copy while preserving hashes for every migration from `0116` onward.
4. Replay the proposed consolidated history into another clean local database.
5. Compare normalized schema dumps. Any difference must be explained and reviewed; unexplained differences block consolidation.
6. Run `supabase test db --local` against the proposed history.
7. Run the repository lint, typecheck, and unit-test suites affected by the database change.
8. Regenerate `packages/db/src/generated/database.types.ts` from the rebuilt schema and verify that any diff reflects an intentional correction rather than a lost object.
9. Run the local schema-drift probe where its credentials are available.

CI will continue running `supabase db reset` and pgTAP, now against the compact pre-F2G history followed by the unchanged F2G history. Documentation and workflow comments will be updated so they describe the consolidation boundary and do not imply that every migration is idempotent.

## Remote Database Rebuild

Remote work is destructive and will be performed one project at a time.

Before mutation, the implementation will:

1. Install or invoke a pinned Supabase CLI version.
2. Authenticate and list accessible projects.
3. Build an explicit inventory of project refs and classify each as disposable development/staging or out of scope.
4. Treat `kyancopdkxotzzkzqsmf` as the expected primary target, but verify its displayed project identity immediately before reset.
5. Capture schema, roles, and data backups for each target even when its data is believed disposable.
6. Record its pre-reset migration list and run the existing read-only drift probe.

For each confirmed non-production target:

1. Link the repository to that exact project ref.
2. Run a destructive linked reset from the consolidated history, without development sample seed data unless the environment is explicitly intended to contain it.
3. Confirm the remote migration ledger contains `0001` through `0006`, contains the unchanged `0116`-and-later versions, and contains none of the retired `0007` through `0115` versions.
4. Reload the PostgREST schema cache.
5. Run schema-drift checks and representative anonymous reads.
6. Regenerate checked-in database types from the primary remote only after it has passed verification.
7. Re-establish the administrator row after the intended Auth user exists.

If a discovered project is not clearly disposable, it will not be reset. Its backup and inventory will be reported, and preserving it will require a separate ledger-repair and data-preserving reconciliation plan.

The GitHub Actions migration secret points to only one project. After the rebuild, its project ref will be checked against the verified primary target. Additional remotes require separate environments or workflows; they must not silently share one ambiguous secret set.

## Failure Handling and Rollback

- A local replay or schema comparison failure stops the consolidation before any remote operation.
- A backup failure stops work on that remote.
- A project-identity mismatch stops the remote reset.
- A remote reset or verification failure stops processing further remotes.
- The old migrations remain available in the parent Git commit and the remote backup remains available for restoration.
- If the baseline itself is wrong, restore the old migration directory from Git, reset the disposable remote from the old chain, and restore any required data from the captured backup.
- Application deployment must remain paused until the rebuilt remote passes the schema-drift probe and representative reads.

## Scope Boundaries

This change consolidates database history and remote state. It does not redesign the data model, enable dormant features, migrate production data, or create a multi-environment deployment platform. New database behavior discovered during verification will be fixed separately rather than hidden inside the baseline.

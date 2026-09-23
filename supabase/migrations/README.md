# Database migrations

The migration chain is SQL-first and is replayed in filename order by Supabase.

## Pre-F2G baseline

Migrations `0001` through `0115` were consolidated into six dependency-ordered files:

| File | Responsibility |
|---|---|
| `0001_core_foundation.sql` | Extensions, shared types, feature flags, profiles, and foundational objects. |
| `0002_venues_and_discovery.sql` | Venues, claims, media metadata, discovery, search, reviews, locality, and geo objects. |
| `0003_social_and_community.sql` | Friends, plans, meetups, chat, posts, Town Hall, events, and presence. |
| `0004_commerce_and_operations.sql` | Billing, offers, marketplace, orders, affiliate deals, notifications, moderation, administration, and transit. |
| `0005_security_and_api.sql` | Functions, triggers, cross-domain constraints, RLS policies, grants, revocations, and Storage policies. |
| `0006_bootstrap_data.sql` | Required feature-flag and Storage-bucket rows. |

Food-to-Go starts at `0116_channels_foundation.sql`. Every migration from `0116` onward retains its original filename and contents.

Versions `0007` through `0115` are intentionally retired. Do not reuse those numbers or restore individual retired migrations: their final state is already represented by the six baseline files. New migrations continue after the highest migration version in the repository.

## Local verification

Use the repository-pinned Supabase CLI version when rebuilding and testing:

```bash
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 db reset
PNPM_CONFIG_PM_ON_FAIL=ignore pnpm dlx supabase@2.117.0 test db --local
```

Regenerate database types when an intentional schema change requires it:

```bash
pnpm db:types
```

## Existing remote databases

The consolidation rewrites applied migration history. `supabase db push` cannot reconcile a remote whose ledger contains the retired `0007`–`0115` versions by itself.

If the old chain was fully applied and the existing schema is equivalent to a clean replay, preserve all application data and repair only the Supabase migration ledger:

```bash
pnpm db:reconcile-history -- \
  --project-ref <PROJECT_REF> \
  --confirm-project-ref <PROJECT_REF> \
  --schema-equivalence-confirmed \
  --apply \
  --backup-file /absolute/secure/path/<PROJECT_REF>-migration-ledger.sql
```

The script backs up `supabase_migrations.schema_migrations`, retires only ledger versions `0007`–`0115`, refreshes `0001`–`0006` from the consolidated files, and verifies that `db push --dry-run` has nothing pending. It does not modify application schemas or table data.

If schema equivalence cannot be established, do not repair the ledger. Back up and rebuild the confirmed non-production project instead. Follow [the database release runbook](../../docs/db-release-runbook.md#consolidated-history-cutover) and never reset an unverified project.

After the founder has signed in to the target project, grant the initial HQ owner explicitly:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/bootstrap/admin-owner.sql
```

The script fails visibly if the Auth user does not exist and is safe to rerun once they do.

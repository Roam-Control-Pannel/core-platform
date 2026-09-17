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

The consolidation rewrites applied migration history. `supabase db push` cannot reconcile a remote whose ledger contains the retired `0007`–`0115` versions. Since there is no production database yet, each existing disposable development or staging project must be backed up and rebuilt from this chain. Follow [the database release runbook](../../docs/db-release-runbook.md#consolidated-history-cutover) and never reset an unverified project.

After the founder has signed in to a rebuilt project, grant the initial HQ owner explicitly:

```bash
psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/bootstrap/admin-owner.sql
```

The script fails visibly if the Auth user does not exist and is safe to rerun once they do.

-- ============================================================================
-- Roam — 0113_admin_users.sql
-- Roam HQ (super-admin dashboard) foundation: the staff allowlist + an audit log.
--
-- The platform has, until now, had NO notion of a privileged human. Authority is
-- either "a signed-in user acting on their own rows" (RLS via auth.uid()) or "a
-- trusted server" (the shared x-internal-call secret — not tied to a person). Roam
-- HQ needs a third thing: a *named* staff member who may read across all tenants.
--
-- Two additive tables, no behaviour change to any existing surface:
--
--   admin_users     — the allowlist. A row here == this profile is Roam HQ staff.
--                     `role` scopes who may ACT (admin/owner) vs only LOOK (viewer),
--                     used by the api's adminProcedure. RLS: a member may read their
--                     OWN row (so the api can verify "am I staff?" under the caller's
--                     own JWT, no service key needed just to gate). No user writes —
--                     membership is granted service-role only (SQL editor / seed).
--
--   admin_audit_log — every privileged HQ action (ban, resolve report, revoke claim)
--                     lands here, attributed to the acting staff member. Closes the
--                     current gap where moderation actions had no human on record
--                     (moderation_queue.reviewed_by was always null — nothing set it).
--                     RLS enabled with NO policies = deny-all to user JWTs; only the
--                     service-role client (RLS-bypass, reached via adminProcedure)
--                     reads or writes it.
--
-- Idempotent: create-if-not-exists + drop/replace policies. Safe to run once on the
-- Roam-Core project.
-- ============================================================================

-- 1. The staff allowlist. -----------------------------------------------------
create table if not exists admin_users (
  id         uuid primary key references profiles(id) on delete cascade,
  -- 'viewer'  — observe-only (dashboards, feeds, lookup). The v1 default.
  -- 'admin'   — may take moderation/claim actions.
  -- 'owner'   — may also grant/revoke HQ membership.
  role       text not null default 'viewer'
               check (role in ('viewer', 'admin', 'owner')),
  note       text,                                    -- freeform: who/why, for humans
  created_at timestamptz not null default now(),
  created_by uuid references profiles(id) on delete set null
);

comment on table admin_users is
  'Roam HQ staff allowlist. A row grants a profile privileged (cross-tenant, RLS-bypassing) '
  'access via the api adminProcedure. Membership is service-role-granted only; users may read '
  'only their own row.';

alter table admin_users enable row level security;

-- A member may confirm their OWN membership (this is what adminProcedure reads under
-- the caller's JWT). It exposes nothing about who else is staff.
drop policy if exists admin_users_self_read on admin_users;
create policy admin_users_self_read on admin_users for select
  using (id = auth.uid());

-- No insert/update/delete policy: with RLS enabled, user JWTs cannot write. Granting
-- or revoking staff happens through the service-role client (RLS bypass) only.

-- 2. The privileged-action audit log. -----------------------------------------
create table if not exists admin_audit_log (
  id          uuid primary key default gen_random_uuid(),
  -- The staff member who acted. Nullable + set-null on profile delete so the log
  -- survives account removal; actor_email is the durable human-readable snapshot.
  actor_id    uuid references profiles(id) on delete set null,
  actor_email text,
  action      text not null,          -- 'ban_user' | 'unban_user' | 'resolve_report' | ...
  entity_type text,                   -- 'profile' | 'venue' | 'report' | 'claim' | ...
  entity_id   uuid,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

comment on table admin_audit_log is
  'Append-only record of privileged Roam HQ actions, attributed to the acting staff member. '
  'Written by the api adminProcedure (service-role). RLS on with no policies = no user access.';

create index if not exists idx_admin_audit_created
  on admin_audit_log (created_at desc);

alter table admin_audit_log enable row level security;
-- Intentionally no policies: deny-all to any user JWT. Service-role bypasses RLS.

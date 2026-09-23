-- ============================================================================
-- 0155 — channel_integrations: a partner's OAuth connection to their own systems.
--
-- WHY A TABLE AND NOT ENVIRONMENT VARIABLES. Roam Core is a WHITELABEL platform, and onboarding a
-- partner has to be self-service: the partner clicks "Connect", approves scoped read access in their
-- own HubSpot, and we hold a refresh token for THAT partner. Environment variables cannot express
-- that — they are one set of values for the whole deployment, so they would force a Roam engineer to
-- provision every new partnership by hand, which is the thing this design exists to avoid.
--
-- One row per (channel, provider). F2G is the first; the next whitelabel is a row, not a release.
--
-- WHY NOT COLUMNS ON `channels`. `channels` is WORLD-READABLE — 0116 gives it
-- `for select using (active = true)` so the web shell can resolve and theme a host anonymously. A
-- refresh token on that table would be readable by anyone with the anon key. This table is the
-- opposite posture: RLS on with NO client policy at all (deny by omission for read AND write), plus
-- the 0135/0137/0148 tripwire trigger, so only service_role and SECURITY DEFINER paths reach it.
--
-- THE TOKEN IS ENCRYPTED BEFORE IT ARRIVES. `refresh_token_encrypted` holds AES-256-GCM ciphertext
-- produced by the API (packages/api/src/integrations/secretBox.ts) under a key that lives in the
-- API's environment, NOT in the database. So a database dump alone does not yield a partner's CRM
-- credential — an attacker needs both the dump and the API host's environment. The column is named
-- for what it holds so nobody can write a plaintext token into it by accident and think it fine.
--
-- Additive; idempotent. Nothing reads it until an integration is connected.
-- After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================

create table if not exists channel_integrations (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references channels(id) on delete cascade,

  -- The partner system this connection is to. Widening this list is how a second provider arrives.
  provider    text not null check (provider in ('hubspot')),

  -- AES-256-GCM ciphertext (base64) of the OAuth refresh token. NEVER plaintext — see the header.
  refresh_token_encrypted text not null,

  -- The partner's own account id in that provider (HubSpot's portal/hub id), for display and support.
  -- Not a secret: it identifies which portal is connected, which is exactly what an operator needs to
  -- confirm they connected the right one.
  external_account_id text,

  -- The scopes the partner actually granted, as returned by the provider. Stored so a scope change
  -- (which requires re-consent) is visible rather than discovered by a failing sync at 4am.
  scopes      text[] not null default '{}',

  status      text not null default 'connected'
                check (status in ('connected', 'revoked', 'error')),
  -- Why a connection stopped working: a revoked grant, an expired refresh token, a scope removed.
  last_error  text,

  connected_by uuid references profiles(id) on delete set null,
  connected_at timestamptz not null default now(),
  last_sync_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- One connection per provider per channel: connecting again REPLACES the grant rather than
-- accumulating stale refresh tokens that nobody will ever revoke.
create unique index if not exists channel_integrations_channel_provider_uq
  on channel_integrations (channel_id, provider);
-- The nightly cron's driving query: every channel with a working connection.
create index if not exists channel_integrations_provider_status_idx
  on channel_integrations (provider, status);

-- ── RLS: deny-by-omission (no client policy at all) + a defence-in-depth tripwire ────────────────
alter table channel_integrations enable row level security;
-- NO anon/authenticated policy is created. With RLS on and no permissive policy, every direct client
-- SELECT/INSERT/UPDATE/DELETE is denied. service_role and SECURITY DEFINER functions bypass RLS.

create or replace function public.channel_integrations_guard_client_roles()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  -- Tripwire: a client role can never write a partner's OAuth credential, even if a policy is added
  -- by mistake later. It should never fire in normal operation.
  if current_user in ('authenticated', 'anon') then
    raise exception 'channel_integrations is service-managed and not client-writable'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists channel_integrations_guard on channel_integrations;
create trigger channel_integrations_guard
  before insert or update or delete on channel_integrations
  for each row execute function public.channel_integrations_guard_client_roles();

drop trigger if exists channel_integrations_updated_at on channel_integrations;
create trigger channel_integrations_updated_at
  before update on channel_integrations
  for each row execute function set_updated_at();

comment on table channel_integrations is
  'A channel''s OAuth connection to a partner system (HubSpot today). One row per (channel, provider). '
  'Holds an ENCRYPTED refresh token — AES-256-GCM ciphertext produced by the API under a key held in '
  'the API environment, never in the database. SERVICE-MANAGED: RLS on with no client policy, plus a '
  'guard trigger; only service_role / SECURITY DEFINER reach it. Deliberately NOT columns on channels, '
  'which is world-readable (0116).';
comment on column channel_integrations.refresh_token_encrypted is
  'AES-256-GCM ciphertext (base64) of the OAuth refresh token. A plaintext token must never be written here.';
comment on column channel_integrations.external_account_id is
  'The partner''s account id in the provider (HubSpot portal/hub id). Not a secret; identifies WHICH portal is connected.';
comment on column channel_integrations.scopes is
  'Scopes the partner granted, as the provider reported them. A scope change needs re-consent, so storing them makes that visible before a sync fails.';

-- ============================================================================
-- 0156 — channel_admins: the partner's OWN officers (F2G plan 3.1).
--
-- THE THIRD AUTHORITY. Roam has had two so far: a signed-in user (RLS decides what is theirs) and
-- Roam HQ staff (`admin_users` — a named human permitted to read ACROSS all tenants). Neither fits
-- the Association. Michael must see everything about the Food to Go channel and nothing about any
-- other channel, which is precisely the authority `admin_users` does not express: a row there is
-- cross-tenant by design, so making an Association officer a Roam admin would hand a partner the
-- keys to every other partner's data. Hence a separate table, scoped to one channel per row.
--
-- WHY A SELF-READ POLICY AND NOT "NO POLICY AT ALL". `channel_integrations` (0155) is service-managed
-- with no policy whatsoever, because nothing client-side ever has business reading a credential.
-- This table is different: the API gate has to answer "which channel is this caller an officer of?"
-- under the CALLER'S OWN JWT, before any escalation to a service client exists. That is exactly the
-- shape of `admin_users_self_read`, and for the same reason — the check that decides whether to
-- escalate must not itself require the escalated client. So: read your own rows, and nothing else.
--
-- WRITES ARE SERVICE-ONLY. No insert/update/delete policy is created, so with RLS on they are denied
-- by omission; the tripwire trigger (0135/0137/0148/0155 pattern) makes that hold even if a policy is
-- added by mistake later. An officer cannot appoint another officer, and cannot promote themselves
-- from `viewer` to `officer`. Appointments are made in Roam HQ, by Roam staff, audited.
--
-- Additive; idempotent. Nothing reads it until an officer is appointed.
-- After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================

create table if not exists channel_admins (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,

  -- `officer` may act on the channel's behalf (raise feature requests in 3.4). `viewer` may only
  -- read. Both are confined to their own channel; the distinction is about writing, never about
  -- reach. Deliberately NOT named 'admin'/'owner' like admin_users.role — the names are different
  -- because the authority is different, and reusing them would invite someone to treat the two
  -- tables as interchangeable.
  role       text not null default 'viewer'
               check (role in ('officer', 'viewer')),

  -- Why this person holds the role, for the humans who audit it later.
  note       text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The Roam staff member who made the appointment. Null only if that profile is later deleted.
  created_by uuid references profiles(id) on delete set null
);

-- One role per person per channel. Re-appointing UPDATES the role rather than leaving two rows whose
-- precedence nobody has defined.
create unique index if not exists channel_admins_channel_profile_uq
  on channel_admins (channel_id, profile_id);

-- The gate's query, on every single association request: "what is this caller?"
create index if not exists channel_admins_profile_idx on channel_admins (profile_id);
-- Roam HQ's query: "who are this channel's officers?"
create index if not exists channel_admins_channel_idx on channel_admins (channel_id);

-- ── RLS: read your own rows; writes denied by omission + a tripwire ──────────────────────────────
alter table channel_admins enable row level security;

drop policy if exists channel_admins_self_read on channel_admins;
create policy channel_admins_self_read on channel_admins
  for select using (profile_id = auth.uid());

create or replace function public.channel_admins_guard_client_roles()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  -- Tripwire: a client role can never grant, change or revoke an officer role — not even its own.
  -- Should never fire in normal operation; if it does, a policy was added that should not exist.
  if current_user in ('authenticated', 'anon') then
    raise exception 'channel_admins is managed from Roam HQ and is not client-writable'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists channel_admins_guard on channel_admins;
create trigger channel_admins_guard
  before insert or update or delete on channel_admins
  for each row execute function public.channel_admins_guard_client_roles();

drop trigger if exists channel_admins_updated_at on channel_admins;
create trigger channel_admins_updated_at
  before update on channel_admins
  for each row execute function set_updated_at();

-- ── the predicate, defined once ──────────────────────────────────────────────────────────────────
-- "Is the current user an admin of this channel?" — stated here, in one place, because 3.2's
-- aggregate RPCs and 3.4's feature-request RLS will both need it. The project already learned this
-- lesson with the canonical member definition in 0154: a predicate spelled out at each call site
-- drifts, and a drifted authority check is a data leak between partners.
--
-- SECURITY DEFINER so it sees every row rather than only the caller's own (the self-read policy
-- above would otherwise make it answer for the caller by accident and for nobody else at all when
-- used inside another definer's body). It takes the channel as an argument and reads auth.uid()
-- itself, so a caller cannot ask it about somebody else.
create or replace function public.is_channel_admin(p_channel_id uuid)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public, pg_temp
as $$
  select exists (
    select 1 from channel_admins
     where channel_id = p_channel_id
       and profile_id = auth.uid()
  );
$$;

revoke all on function public.is_channel_admin(uuid) from public, anon;
grant execute on function public.is_channel_admin(uuid) to authenticated;

comment on table channel_admins is
  'A partner organisation''s own officers, scoped to ONE channel per row. Distinct from admin_users, '
  'which is Roam HQ staff and cross-tenant by design: an Association officer must see their own '
  'channel and no other. Self-read only (the API gate resolves the caller''s channel under the '
  'caller''s own JWT); writes are service-only, made from Roam HQ and audited.';
comment on column channel_admins.role is
  '''officer'' may act for the channel (e.g. raise feature requests); ''viewer'' may only read. Neither '
  'reaches beyond its own channel — the distinction is about writing, not reach.';
comment on function public.is_channel_admin(uuid) is
  'Canonical predicate: is the CURRENT user an admin (officer or viewer) of this channel? Defined once '
  'so the portal''s aggregates and RLS cannot drift apart. Reads auth.uid() itself, so it cannot be '
  'asked about another user.';

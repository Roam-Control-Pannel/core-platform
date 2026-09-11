-- 0135_channel_members.sql
--
-- Food to Go · Phase B · Slice B1a — the CHANNEL MEMBER ROSTER (the "5,000").
--
-- `venue_channels` (0116) is only the storefront TAG: a claimed venue's owner opts their own venue
-- into a channel. It cannot represent a roster member the Association gave us who has no claimed
-- venue yet (the whole onboarding funnel), nor carry the verbatim source record we must keep. So the
-- roster of record is its own table.
--
-- PII + integrity posture (the load-bearing decision — see docs/f2g-b1-membership-spine-plan.md):
--   channel_members holds PII (verbatim source contact NAMES and EMAILS — the invite targets).
--   Therefore it is SERVICE-MANAGED: RLS is enabled with NO anon/authenticated policy, so PostgREST
--   denies every direct client SELECT/INSERT/UPDATE/DELETE by omission. Only service_role and
--   SECURITY DEFINER functions (the import job in B3, admin in B4) touch it. All PUBLIC exposure of a
--   member (the directory in C2, the unclaimed member page in B3) goes through a definer RPC that
--   projects ONLY safe columns — never source_email/source_phone. There is deliberately no
--   client-reachable read of this table in B1; that is why B1 adds no tRPC.
--
-- A 0131-style guard trigger is a defence-in-depth TRIPWIRE: even if a client policy is ever added
-- by mistake, a client role can never write this table. It should never fire in normal operation.
--
-- Additive and dormant: no existing table is mutated; nothing reads this yet. Idempotent.
-- (After applying, DB types would normally be regenerated with `pnpm db:types`.)

create table if not exists channel_members (
  id             uuid primary key default gen_random_uuid(),
  channel_id     uuid not null references channels(id) on delete cascade,

  -- Verbatim roster-of-record fields, exactly as the Association's source gave them. Never
  -- overwritten by matching/backfill — the audit trail of what we were told.
  source_name        text not null check (char_length(source_name) between 1 and 200),
  source_address     text,
  source_postcode    text,                                 -- match block key (normalised at match time)
  source_email       text,                                 -- PII; invite target. Never client-readable.
  source_phone       text,                                 -- PII.
  source_council     text,                                 -- NI council area, for the onboarding dashboard
  source_raw         jsonb not null default '{}'::jsonb,   -- the untouched CSV row

  -- Idempotency: a stable per-source key so re-importing the roster UPDATES rather than duplicates.
  -- Unique per channel (see index below).
  membership_ref     text not null check (char_length(membership_ref) between 1 and 200),

  -- The match result (filled by B2/B3; null until matched). on delete set null: deleting the venue
  -- nulls the link, it never deletes the roster row.
  venue_id           uuid references venues(id) on delete set null,

  -- Who claimed it, once claimed (B3). Null until then.
  claimed_by         uuid references profiles(id) on delete set null,

  -- Status machine (allowed transitions live in @roam/core/membership.canTransition). The check
  -- constrains the VALUES; the ordering rule is enforced by the writer, not the DB.
  status         text not null default 'imported'
                   check (status in ('imported','invited','claimed','live','lapsed','removed')),

  invited_at     timestamptz,
  claimed_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Idempotent re-import key: (channel, membership_ref) is unique.
create unique index if not exists channel_members_ref_uq
  on channel_members (channel_id, membership_ref);
-- Admin/dashboard browse + the onboarding-progress counts.
create index if not exists channel_members_status_idx   on channel_members (channel_id, status);
-- The match join back to venues.
create index if not exists channel_members_venue_idx     on channel_members (venue_id);
-- Postcode-block lookups for the matcher (B2).
create index if not exists channel_members_postcode_idx  on channel_members (source_postcode);

-- ── RLS: deny-by-omission (no client policy) + a defence-in-depth tripwire ────────────────────
alter table channel_members enable row level security;
-- NO anon/authenticated policy is created: with RLS on and no permissive policy, every direct
-- client operation is denied. service_role and SECURITY DEFINER functions bypass RLS.

create or replace function public.channel_members_guard_client_roles()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  -- Tripwire: a direct client role can never write this PII-bearing roster, even if a policy is
  -- ever added by mistake. Definer/service writes (current_user = the function owner or
  -- 'service_role') fall through untouched.
  if current_user in ('authenticated', 'anon') then
    raise exception 'channel_members is service-managed and not client-writable'
      using errcode = '42501';
  end if;
  -- BEFORE DELETE must return OLD (returning NULL would cancel a legitimate service-role delete);
  -- INSERT/UPDATE return NEW.
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists channel_members_guard on channel_members;
create trigger channel_members_guard
  before insert or update or delete on channel_members
  for each row execute function public.channel_members_guard_client_roles();

drop trigger if exists channel_members_updated_at on channel_members;
create trigger channel_members_updated_at
  before update on channel_members
  for each row execute function set_updated_at();

comment on table channel_members is
  'Roster of record for a channel''s membership (the Food to Go Association''s vendors). Holds verbatim source_* fields incl. PII (source_email/source_phone). SERVICE-MANAGED: RLS on, NO client policy — only service_role / SECURITY DEFINER reach it; public exposure is via safe-column definer RPCs only. Distinct from venue_channels (the owner-self-taggable storefront tag).';
comment on column channel_members.membership_ref is
  'Stable per-source idempotency key; (channel_id, membership_ref) is unique so re-imports update rather than duplicate.';
comment on column channel_members.source_email is
  'PII — the invite target. Never exposed to client roles (no client read policy exists); server/definer paths only.';
comment on column channel_members.status is
  'Onboarding state machine: imported->invited->claimed->live, plus lapsed/removed. Allowed transitions enforced by @roam/core/membership.canTransition (the DB check constrains values only).';

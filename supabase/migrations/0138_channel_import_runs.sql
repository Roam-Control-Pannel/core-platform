-- 0138_channel_import_runs.sql
--
-- Food to Go · Phase B · Slice B3-a — the roster-import AUDIT LOG.
--
-- Every bulk roster import (B3) writes one row here: what channel, who ran it, and the outcome
-- counts (imported/updated, match accept/review/reject, backfilled, invited, errors) plus a small
-- JSON sample of the row errors/warnings. It makes a bulk action — which mutates the 5,000-row
-- roster — auditable and reviewable; the B4 admin surfaces it read-only as "import reports".
--
-- SERVICE-MANAGED, like channel_members (0135): RLS on with NO client policy, so PostgREST denies
-- every direct client read/write by omission — only service_role / SECURITY DEFINER (the import job,
-- the admin read) reach it. A 0131-style guard trigger is a defence-in-depth tripwire. Additive;
-- idempotent.

create table if not exists channel_import_runs (
  id             uuid primary key default gen_random_uuid(),
  channel_id     uuid not null references channels(id) on delete cascade,
  -- Who ran it (a staff upload); null for an unattended/script run.
  actor_id       uuid references profiles(id) on delete set null,
  imported       integer not null default 0,   -- new roster rows inserted
  updated        integer not null default 0,   -- existing rows updated (idempotent re-import)
  matched_accept integer not null default 0,   -- auto-matched to a venue
  matched_review integer not null default 0,   -- sent to the human match-review queue
  matched_reject integer not null default 0,   -- no confident candidate
  backfilled     integer not null default 0,   -- matched venues enriched via Places (B3-c)
  invited        integer not null default 0,   -- invites sent (B3-d; 0 here)
  errors         integer not null default 0,   -- rows that could not be imported
  -- Small samples (capped by the job) of the row errors/warnings, for the report UI.
  report         jsonb not null default '{}'::jsonb,
  started_at     timestamptz,
  finished_at    timestamptz,
  created_at     timestamptz not null default now()
);

create index if not exists channel_import_runs_channel_idx
  on channel_import_runs (channel_id, created_at desc);

-- ── RLS: service-managed (deny-by-omission) + tripwire ────────────────────────────────────────
alter table channel_import_runs enable row level security;
-- No anon/authenticated policy: direct client access denied. service_role / definer only.

create or replace function public.channel_import_runs_guard_client_roles()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'channel_import_runs is service-managed and not client-writable'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists channel_import_runs_guard on channel_import_runs;
create trigger channel_import_runs_guard
  before insert or update or delete on channel_import_runs
  for each row execute function public.channel_import_runs_guard_client_roles();

comment on table channel_import_runs is
  'Audit log of B3 roster imports: per-run outcome counts + a JSON error/warning sample. Service-managed (RLS on, no client policy); surfaced read-only in the Roam HQ admin.';

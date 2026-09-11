-- 0137_external_refs.sql
--
-- Food to Go · Phase B · Slice B2 — the persisted MATCH LEDGER.
--
-- Matching a roster member (channel_members, 0135) to an existing Roam venue — and later a venue to
-- its FSA hygiene record (C1) — is expensive and, once a human has confirmed or corrected it, must
-- be PERMANENT. So every resolved match is one durable row here: one row per (entity, dataset).
--   - method='auto'   : written by the import job (B3) from @roam/core/matching, carrying its score.
--   - method='manual' : written by a human via the admin match-review queue (B4) — the correction of
--                        record; it must survive any later re-run of auto-matching.
--
-- polymorphic by design: entity_type/entity_id name the Roam-side row (a channel_member, a venue),
-- dataset names the external corpus ('roam_venue' for the roster→venue match, 'fsa' for C1), and
-- external_id is the opaque key in that corpus (a venue uuid as text, an FSA FHRSID). No FK on
-- external_id (it spans corpora); the unique key guarantees at most one match per (entity, dataset).
--
-- RLS: PUBLIC READ (it carries no PII — only opaque ids + a score; it drives the "matched" badge and
-- the reverse joins). NO write policy: writes are service-role / SECURITY DEFINER only (the import
-- job, the admin queue), deny-by-omission for client roles, with a 0131-style guard tripwire for
-- defence in depth. Additive; idempotent.

create table if not exists external_refs (
  id           uuid primary key default gen_random_uuid(),
  -- The Roam-side row this match is FOR.
  entity_type  text not null check (entity_type in ('channel_member', 'venue', 'org')),
  entity_id    uuid not null,
  -- The external corpus and the key within it that entity matched to.
  dataset      text not null check (dataset in ('roam_venue', 'fsa')),
  external_id  text not null check (char_length(external_id) between 1 and 200),
  -- How the match was made + (for auto) its confidence in [0,1].
  method       text not null default 'auto' check (method in ('auto', 'manual')),
  score        numeric(4, 3) check (score is null or (score >= 0 and score <= 1)),
  -- Who confirmed a manual match (audit); null for auto.
  matched_by   uuid references profiles(id) on delete set null,
  matched_at   timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- At most one match per (entity, dataset): re-running auto-matching UPSERTs, a manual correction
-- replaces the same row.
create unique index if not exists external_refs_entity_dataset_uq
  on external_refs (entity_type, entity_id, dataset);
-- Reverse lookup: given an external record (a venue), which entities matched it — so the import job
-- can refuse to bind two roster members to the same venue.
create index if not exists external_refs_reverse_idx
  on external_refs (dataset, external_id);

-- ── RLS: public read, no client write (+ tripwire) ────────────────────────────
alter table external_refs enable row level security;

drop policy if exists external_refs_read on external_refs;
create policy external_refs_read on external_refs for select using (true);
-- NO write policy: client roles cannot INSERT/UPDATE/DELETE. Only service_role / SECURITY DEFINER.

create or replace function public.external_refs_guard_client_roles()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  -- Match rows are the confirmed record of truth (a wrong FSA rating is a legal exposure); a client
  -- role must never forge or edit one. Definer/service writes fall through.
  if current_user in ('authenticated', 'anon') then
    raise exception 'external_refs is service-managed and not client-writable'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists external_refs_guard on external_refs;
create trigger external_refs_guard
  before insert or update or delete on external_refs
  for each row execute function public.external_refs_guard_client_roles();

drop trigger if exists external_refs_updated_at on external_refs;
create trigger external_refs_updated_at
  before update on external_refs
  for each row execute function set_updated_at();

comment on table external_refs is
  'Persisted match ledger: one durable row per (entity_type, entity_id, dataset) linking a Roam row (channel_member/venue/org) to an external corpus key (roam_venue uuid, fsa FHRSID). method=auto (from @roam/core/matching, with score) or manual (a human correction of record). Public read (no PII); writes are service/definer only.';
comment on column external_refs.method is
  'auto = written by the import job from the matcher (score set); manual = a human correction via the admin review queue (must survive re-runs of auto-matching).';

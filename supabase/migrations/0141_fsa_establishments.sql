-- 0141_fsa_establishments.sql
--
-- Food to Go · Phase C · Slice C1-a — the FSA HYGIENE reference corpus.
--
-- The Food Standards Agency publishes NI food-hygiene ratings (the FHRS 0–5 scheme) as OPEN DATA
-- under the Open Government Licence — data that is explicitly meant to be displayed publicly. We pull
-- it nightly (C1 sync) into this table, match each establishment to a Roam venue via @roam/core/matching
-- (writing external_refs dataset='fsa', 0137), and render the official badge on the venue page (C1-b).
--
-- RLS posture — the external_refs (0137) shape, NOT the channel_members (0135) one: this is public
-- open-data reference, carries NO PII, and MUST be world-readable so the public venue page can show a
-- rating. So: RLS on, a permissive SELECT policy (public read), and NO write policy — writes are
-- service-role / SECURITY DEFINER only (the nightly sync), with a 0131-style guard tripwire as
-- defence-in-depth. (An earlier note called this "service-role-only"; that was about WRITES — a
-- rating that can't be read can't be rendered, so read is public, exactly like external_refs.)
--
-- Additive; idempotent. After applying, run `notify pgrst, 'reload schema'` (release runbook).

create table if not exists fsa_establishments (
  id              uuid primary key default gen_random_uuid(),
  -- The FSA's stable establishment key (FHRSID). Unique → idempotent re-sync (upsert on it).
  fhrsid          text not null unique check (char_length(fhrsid) between 1 and 64),
  business_name   text not null,
  business_type   text,                                  -- FSA BusinessType (e.g. "Restaurant/Cafe/Canteen")
  address         text,                                  -- AddressLine1..4 concatenated
  postcode        text,                                  -- the match block key (normalised at match time)
  -- Verbatim FSA rating value: '0'..'5' (FHRS), or a non-numeric status. NEVER coerced to a number
  -- here — @roam/core/fsa.isDisplayableRating decides what (if anything) renders, so "AwaitingInspection"
  -- can never surface as a "0".
  rating_value    text not null,
  rating_key      text,                                  -- FSA RatingKey, e.g. 'fhrs_5_en-gb' (badge asset id)
  rating_date     date,                                  -- FSA RatingDate (when the inspection rated it)
  local_authority text,                                  -- LocalAuthorityName (one of the 11 NI councils)
  lat             double precision,
  lng             double precision,
  raw             jsonb not null default '{}'::jsonb,    -- the untouched FSA record (audit / future fields)
  synced_at       timestamptz not null default now(),    -- when we last pulled this row (shown beside RatingDate)
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- Postcode-block lookups for the matcher (C1 sync matches on postcode + name).
create index if not exists fsa_establishments_postcode_idx on fsa_establishments (postcode);

-- ── RLS: public read, no client write (+ tripwire) — the external_refs (0137) posture ─────────────
alter table fsa_establishments enable row level security;

drop policy if exists fsa_establishments_read on fsa_establishments;
create policy fsa_establishments_read on fsa_establishments for select using (true);
-- NO write policy: client roles cannot INSERT/UPDATE/DELETE. Only service_role / SECURITY DEFINER (the sync).

create or replace function public.fsa_establishments_guard_client_roles()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  -- A wrong hygiene rating is a legal exposure; a client role must never forge or edit one. Definer /
  -- service writes (the nightly sync) fall through untouched.
  if current_user in ('authenticated', 'anon') then
    raise exception 'fsa_establishments is service-managed and not client-writable'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists fsa_establishments_guard on fsa_establishments;
create trigger fsa_establishments_guard
  before insert or update or delete on fsa_establishments
  for each row execute function public.fsa_establishments_guard_client_roles();

drop trigger if exists fsa_establishments_updated_at on fsa_establishments;
create trigger fsa_establishments_updated_at
  before update on fsa_establishments
  for each row execute function set_updated_at();

comment on table fsa_establishments is
  'FSA food-hygiene reference corpus (FHRS 0–5, NI). Open data under the Open Government Licence — public READ (no PII), writes are service/definer only (the nightly C1 sync). Matched to venues via external_refs dataset=fsa; the rating renders on the venue page. rating_value is verbatim (never coerced to a number) — @roam/core/fsa.isDisplayableRating gates display so AwaitingInspection/Exempt never show as 0.';
comment on column fsa_establishments.rating_value is
  'Verbatim FSA value: ''0''..''5'' (FHRS) or a status like ''AwaitingInspection''/''Exempt''. Display is decided by @roam/core/fsa.isDisplayableRating, never by casting this to a number.';

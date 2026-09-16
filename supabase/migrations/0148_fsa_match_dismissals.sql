-- ============================================================================
-- Roam — 0148_fsa_match_dismissals.sql
-- FSA match-review (backlog #51): the sticky NEGATIVE decision for a venue's hygiene-rating match.
--
-- The FSA sync (syncFsaNi) auto-links a venue to its FSA establishment only on a confident,
-- unambiguous match; everything else — a moderate name score, a tie between two candidates, no
-- record at the venue's postcode — is left UNLINKED for a human. Roam HQ's FSA review queue
-- (core/admin/fsaReview) re-scores those venues on demand, exactly like the B4b roster queue; the
-- positive decision is the external_refs row (method='manual', permanent). THIS table is the
-- negative one, mirroring channel_members.match_dismissed_at (0140):
--
--   a row here = "a reviewer looked; no FSA record is this venue (or the auto-link was wrong)".
--   - the venue drops out of the default review queue;
--   - the nightly sync will NOT auto-link it (a wrong link that a human removed must never come
--     back on the next run);
--   - a later confirmFsaMatch clears it.
--
-- Its own table (not columns on venues): venues is column-guarded for owners (0131) and this is
-- purely service-side review state. No PII: a venue id, a staff id, a timestamp, an optional note.
--
-- RLS: NO client policies at all — deny-by-omission for select AND write (review state is internal
-- to HQ; nothing public reads it), plus the 0131/0137-style guard tripwire. Service-role only.
-- ============================================================================

create table if not exists fsa_match_dismissals (
  venue_id      uuid primary key references venues(id) on delete cascade,
  dismissed_at  timestamptz not null default now(),
  dismissed_by  uuid references profiles(id) on delete set null,
  -- Why, in a few words ("unlinked wrong auto-match", "closed", "FSA has no record").
  note          text check (note is null or char_length(note) <= 200)
);

comment on table fsa_match_dismissals is
  'FSA match-review: venues a staff reviewer marked as having no correct FSA establishment (or whose '
  'auto-link was removed). Drops the venue from the review queue and blocks the nightly auto-link; '
  'cleared by a later manual confirm. Service-managed; no client access.';

alter table fsa_match_dismissals enable row level security;
-- No policies: client roles can neither read nor write. Only service_role / SECURITY DEFINER.

create or replace function public.fsa_match_dismissals_guard_client_roles()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'fsa_match_dismissals is service-managed and not client-writable'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists fsa_match_dismissals_guard on fsa_match_dismissals;
create trigger fsa_match_dismissals_guard
  before insert or update or delete on fsa_match_dismissals
  for each row execute function public.fsa_match_dismissals_guard_client_roles();

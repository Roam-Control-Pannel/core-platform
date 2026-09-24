-- ============================================================================
-- 0159 — channel_feature_requests: the partner asks Roam for something (F2G plan 3.4).
--
-- The first WRITE in the Association portal. 3.1–3.3 were definer functions over data the partner
-- already owns; this is a table a partner inserts into, so it carries real RLS rather than a gate
-- inside a function, and the interesting work is in what the policies REFUSE.
--
-- OFFICER, NOT ADMIN. 0156 made `officer` and `viewer` distinct: an officer may act for the channel,
-- a viewer may only read. `is_channel_admin` answers "either", which is right for reading and wrong
-- for writing — so this migration adds `is_channel_officer`, and the INSERT policy uses it. A viewer
-- can read every request their organisation has filed and file none.
--
-- WHAT AN OFFICER CANNOT DO, enforced in the policy's WITH CHECK rather than by convention:
--   · file a request for a channel they do not hold an appointment for;
--   · attribute a request to somebody else (`created_by` must be auth.uid());
--   · file one that arrives pre-triaged (`status` must be 'new');
--   · write Roam's private notes (`roam_notes` must be null).
-- There is NO update or delete policy at all: once filed, a request is Roam's to triage. Editing a
-- request after Roam has read and triaged it would let the text change under the decision, so v1
-- does not allow it — an officer who wants to say more files another request.
--
-- The tripwire trigger differs from 0155/0156's, which refuse every client write. This table has a
-- legitimate client INSERT, so the trigger refuses client UPDATE and DELETE only: if an UPDATE
-- policy is ever added by mistake, status and roam_notes still cannot be rewritten by the partner.
--
-- Additive; idempotent. After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================

-- ── the officer-only predicate ───────────────────────────────────────────────────────────────────
-- Stated once, like is_channel_admin, because it will gate every future portal write.
create or replace function public.is_channel_officer(p_channel_id uuid)
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
       and role = 'officer'
  );
$$;

revoke all on function public.is_channel_officer(uuid) from public, anon;
grant execute on function public.is_channel_officer(uuid) to authenticated;

create table if not exists channel_feature_requests (
  id         uuid primary key default gen_random_uuid(),
  channel_id uuid not null references channels(id) on delete cascade,
  -- Who filed it. Kept on delete set null so a departed officer's request survives them — the
  -- request is the organisation's, not the individual's.
  created_by uuid references profiles(id) on delete set null,

  title      text not null check (char_length(title) between 3 and 140),
  detail     text check (detail is null or char_length(detail) <= 4000),
  -- Soft vocabulary: widening it is a migration, which is the point — an unbounded free-text
  -- category becomes unsortable within a month.
  category   text not null default 'other'
               check (category in ('storefront', 'members', 'jobs', 'suppliers', 'reporting', 'other')),

  status     text not null default 'new'
               check (status in ('new', 'triaged', 'planned', 'in_progress', 'shipped', 'declined')),
  -- Roam's working notes, visible to the partner: this is the reply channel, so it is deliberately
  -- NOT private. Anything genuinely internal belongs in admin_audit_log, not here.
  roam_notes text check (roam_notes is null or char_length(roam_notes) <= 4000),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- The portal's list: this channel's requests, newest first.
create index if not exists channel_feature_requests_channel_idx
  on channel_feature_requests (channel_id, created_at desc);
-- Roam HQ's queue: everything still open, across every partner.
create index if not exists channel_feature_requests_status_idx
  on channel_feature_requests (status, created_at desc);

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────────
alter table channel_feature_requests enable row level security;

-- READ: anyone appointed to the channel, officer or viewer.
drop policy if exists channel_feature_requests_read on channel_feature_requests;
create policy channel_feature_requests_read on channel_feature_requests
  for select using (public.is_channel_admin(channel_id));

-- WRITE: officers only, for their own channel, attributed to themselves, untriaged, with no notes.
drop policy if exists channel_feature_requests_insert on channel_feature_requests;
create policy channel_feature_requests_insert on channel_feature_requests
  for insert with check (
    public.is_channel_officer(channel_id)
    and created_by = auth.uid()
    and status = 'new'
    and roam_notes is null
  );

-- No UPDATE policy and no DELETE policy: triage is Roam's, through the service role.

create or replace function public.channel_feature_requests_guard_client_roles()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  -- Unlike 0155/0156, an INSERT here is legitimate for a client role — the policy above decides it.
  -- What must never happen is a client rewriting a request after the fact, so only UPDATE and
  -- DELETE are refused. This should never fire; if it does, a policy exists that should not.
  if current_user in ('authenticated', 'anon') then
    raise exception 'a filed feature request is not editable by the partner'
      using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists channel_feature_requests_guard on channel_feature_requests;
create trigger channel_feature_requests_guard
  before update or delete on channel_feature_requests
  for each row execute function public.channel_feature_requests_guard_client_roles();

drop trigger if exists channel_feature_requests_updated_at on channel_feature_requests;
create trigger channel_feature_requests_updated_at
  before update on channel_feature_requests
  for each row execute function set_updated_at();

comment on table channel_feature_requests is
  'A partner organisation''s requests to Roam, and Roam''s reply. Officers (not viewers) file them; '
  'everyone appointed to the channel reads them. Status and roam_notes are Roam''s to set, through '
  'the service role — there is no client UPDATE policy, and a tripwire trigger refuses client '
  'UPDATE/DELETE even if one is added later.';
comment on column channel_feature_requests.roam_notes is
  'Roam''s reply, VISIBLE to the partner — this is the reply channel. Anything genuinely internal '
  'belongs in admin_audit_log instead.';
comment on function public.is_channel_officer(uuid) is
  'Canonical predicate: is the CURRENT user an OFFICER (not merely a viewer) of this channel? Gates '
  'every partner-side write. Distinct from is_channel_admin, which answers "officer or viewer".';

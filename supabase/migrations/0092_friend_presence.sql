-- 0092_friend_presence.sql
--
-- Friend availability status — PR 1 of the "share with friends" feature. A signed-in user can
-- broadcast a lightweight, self-expiring status ("Free for a coffee") that ONLY their accepted
-- friends can see. No location is stored yet — this PR establishes the friend-only privacy
-- boundary end to end BEFORE any coordinate exists.
--
-- Privacy is enforced at the DATABASE, not the UI:
--   * friend_presence is OWNER-ONLY under RLS — a row is readable/writable solely by its owner
--     (profile_id = auth.uid()). No friend, and no anonymous caller, can touch the table directly.
--   * Friends read each other's status EXCLUSIVELY through friends_availability() — a SECURITY
--     DEFINER function that gates every row behind are_friends(auth.uid(), profile_id). There is
--     therefore NO code path that returns a non-friend's status; the boundary is structural, not
--     UI-deep. (are_friends' EXECUTE was revoked from `authenticated` in 0076, so it CANNOT be
--     used in an RLS policy evaluated as the caller — a definer function is the only correct way
--     to reuse it. auth.uid() inside a definer still resolves to the CALLER, so the gate is
--     per-caller, not per-owner.)
--
-- Ephemeral by construction: every status carries expires_at, and friends_availability() filters
-- expires_at > now() SERVER-SIDE, so a stale status disappears on its own with no cron and even if
-- a client never clears it. Clearing a status nulls the row's availability + expiry. One row per
-- profile (upserted), so the table stays tiny.
--
-- Idempotent; safe to run once on the Roam-Core project.

-- Availability states. NULL availability = "no active status" (cleared / not sharing); these three
-- are the machine-filterable states a friend can be shown (and, in a later PR, alerted on).
do $$ begin
  create type presence_availability as enum ('free_to_meet', 'out_and_about', 'heads_down');
exception when duplicate_object then null;
end $$;

create table if not exists friend_presence (
  profile_id   uuid primary key references profiles(id) on delete cascade,
  availability presence_availability,                       -- NULL = cleared / not sharing a status
  note         text check (note is null or char_length(note) <= 280),  -- short free-text; API caps tighter
  expires_at   timestamptz,                                 -- status auto-clears at this time (NULL = none)
  updated_at   timestamptz not null default now()
);

alter table friend_presence enable row level security;

-- OWNER-ONLY, every operation. Friends never read this table directly — they go through
-- friends_availability() below. This is the whole privacy guarantee.
drop policy if exists friend_presence_owner_select on friend_presence;
create policy friend_presence_owner_select on friend_presence
  for select using (profile_id = auth.uid());

drop policy if exists friend_presence_owner_insert on friend_presence;
create policy friend_presence_owner_insert on friend_presence
  for insert with check (profile_id = auth.uid());

drop policy if exists friend_presence_owner_update on friend_presence;
create policy friend_presence_owner_update on friend_presence
  for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());

drop policy if exists friend_presence_owner_delete on friend_presence;
create policy friend_presence_owner_delete on friend_presence
  for delete using (profile_id = auth.uid());

-- The ONLY way to read a friend's status. SECURITY DEFINER so it can call are_friends (whose
-- EXECUTE is revoked from authenticated by 0076); auth.uid() inside still resolves to the CALLER
-- (it reads the request JWT, not the function owner), so the are_friends gate is per-caller.
-- Returns only accepted friends with a live, non-expired status.
create or replace function friends_availability()
returns table (
  profile_id   uuid,
  handle       text,
  display_name text,
  avatar_url   text,
  availability presence_availability,
  note         text,
  expires_at   timestamptz,
  updated_at   timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select fp.profile_id, p.handle, p.display_name, p.avatar_url,
         fp.availability, fp.note, fp.expires_at, fp.updated_at
  from friend_presence fp
  join profiles p on p.id = fp.profile_id
  where fp.availability is not null
    and (fp.expires_at is null or fp.expires_at > now())
    and are_friends(auth.uid(), fp.profile_id)
  order by fp.updated_at desc;
$$;

-- Signed-in callers only. The default CREATE FUNCTION grant is to PUBLIC (which includes anon), so
-- revoke it and re-grant to authenticated only. (Even if anon slipped through, auth.uid() would be
-- NULL and are_friends(NULL, …) is false → zero rows; this is belt-and-braces.)
revoke all on function friends_availability() from public, anon;
grant execute on function friends_availability() to authenticated;

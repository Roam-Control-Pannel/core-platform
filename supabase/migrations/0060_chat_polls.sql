-- 0060_chat_polls.sql
--
-- Chat polls & voting. A poll is a message of kind='poll' whose payload snapshots the question +
-- options + a `multi` flag (validated by @roam/core). This migration adds the mutable state a poll
-- needs on top of that immutable message:
--
--   * chat_poll_votes — one row per (message, option, voter). Single-choice polls keep at most one
--     row per (message, voter); multi-choice allow several. Votes are NOT anonymous (the product
--     decision) — poll_results returns who voted.
--   * chat_polls — per-poll closable state (only rows for polls that were closed).
--
-- ACCESS MODEL: both tables have RLS enabled with NO policies, so no direct client access. Every
-- read/write goes through three SECURITY DEFINER functions that do their own participant/creator
-- checks — the single, auditable authority for poll access:
--   * cast_poll_vote(message, option) — participant only; enforces single-vs-multi from the poll's
--     payload; toggles (multi) or replaces (single); refuses a closed poll or a bad option.
--   * poll_results(message)          — participant only; returns { closed, votes:[{optionId,
--     profileId, name, avatar}] } so each client tallies against the payload's options.
--   * close_poll(message)            — the poll's CREATOR only; stamps closed_at.
-- Idempotent.

create table if not exists chat_poll_votes (
  message_id uuid not null references chat_messages(id) on delete cascade,
  option_id  text not null,
  profile_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, option_id, profile_id)
);
create index if not exists chat_poll_votes_message_idx on chat_poll_votes (message_id);

create table if not exists chat_polls (
  message_id uuid primary key references chat_messages(id) on delete cascade,
  closed_at  timestamptz,
  closed_by  uuid references profiles(id)
);

-- RLS on, no policies: direct access denied; the SECURITY DEFINER RPCs below are the only path.
alter table chat_poll_votes enable row level security;
alter table chat_polls enable row level security;

-- Cast (or toggle/switch/unvote) the caller's vote on a poll option.
create or replace function cast_poll_vote(p_message uuid, p_option text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread uuid;
  v_kind   text;
  v_multi  boolean;
  v_closed boolean;
begin
  select thread_id, kind, coalesce((payload ->> 'multi')::boolean, false)
    into v_thread, v_kind, v_multi
  from chat_messages where id = p_message;

  if v_thread is null then raise exception 'Poll not found' using errcode = '42704'; end if;
  if v_kind <> 'poll' then raise exception 'Not a poll' using errcode = '22023'; end if;

  if not exists (select 1 from chat_participants where thread_id = v_thread and profile_id = auth.uid()) then
    raise exception 'Not a participant' using errcode = '42501';
  end if;

  select (closed_at is not null) into v_closed from chat_polls where message_id = p_message;
  if coalesce(v_closed, false) then raise exception 'Poll is closed' using errcode = '22023'; end if;

  if not exists (
    select 1 from chat_messages m, jsonb_array_elements(m.payload -> 'options') opt
    where m.id = p_message and opt ->> 'id' = p_option
  ) then
    raise exception 'Unknown option' using errcode = '22023';
  end if;

  if v_multi then
    -- toggle this one option
    if exists (select 1 from chat_poll_votes where message_id = p_message and option_id = p_option and profile_id = auth.uid()) then
      delete from chat_poll_votes where message_id = p_message and option_id = p_option and profile_id = auth.uid();
    else
      insert into chat_poll_votes (message_id, option_id, profile_id) values (p_message, p_option, auth.uid());
    end if;
  else
    -- single choice: tapping your current pick clears it; otherwise replace whatever you had
    if exists (select 1 from chat_poll_votes where message_id = p_message and option_id = p_option and profile_id = auth.uid()) then
      delete from chat_poll_votes where message_id = p_message and profile_id = auth.uid();
    else
      delete from chat_poll_votes where message_id = p_message and profile_id = auth.uid();
      insert into chat_poll_votes (message_id, option_id, profile_id) values (p_message, p_option, auth.uid());
    end if;
  end if;
end;
$$;

revoke all on function cast_poll_vote(uuid, text) from public;
grant execute on function cast_poll_vote(uuid, text) to authenticated;

-- Read a poll's votes (who voted for what) + closed state. Participant only.
create or replace function poll_results(p_message uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_thread uuid;
  v_closed boolean;
  v_votes  jsonb;
begin
  select thread_id into v_thread from chat_messages where id = p_message;
  if v_thread is null then raise exception 'Poll not found' using errcode = '42704'; end if;
  if not exists (select 1 from chat_participants where thread_id = v_thread and profile_id = auth.uid()) then
    raise exception 'Not a participant' using errcode = '42501';
  end if;

  select (closed_at is not null) into v_closed from chat_polls where message_id = p_message;

  select coalesce(jsonb_agg(jsonb_build_object(
           'optionId', v.option_id,
           'profileId', v.profile_id,
           'name', coalesce(nullif(btrim(p.display_name), ''), '@' || p.handle, 'Roam member'),
           'avatar', p.avatar_url
         )), '[]'::jsonb)
    into v_votes
  from chat_poll_votes v
  join profiles p on p.id = v.profile_id
  where v.message_id = p_message;

  return jsonb_build_object('closed', coalesce(v_closed, false), 'votes', v_votes);
end;
$$;

grant execute on function poll_results(uuid) to authenticated;

-- Close a poll (no more voting). Only the poll's creator (the message sender) may.
create or replace function close_poll(p_message uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare v_sender uuid;
begin
  select sender_id into v_sender from chat_messages where id = p_message and kind = 'poll';
  if v_sender is null then raise exception 'Poll not found' using errcode = '42704'; end if;
  if v_sender <> auth.uid() then raise exception 'Only the poll creator can close it' using errcode = '42501'; end if;

  insert into chat_polls (message_id, closed_at, closed_by)
  values (p_message, now(), auth.uid())
  on conflict (message_id) do update set closed_at = now(), closed_by = auth.uid();
end;
$$;

revoke all on function close_poll(uuid) from public;
grant execute on function close_poll(uuid) to authenticated;

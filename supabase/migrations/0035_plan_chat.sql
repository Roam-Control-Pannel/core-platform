-- Migration 0035 — Chat ↔ Plans integration.
--
-- The product split (from the chat/plans differentiation request):
--   • Chat  = direct user-to-user chats AND plan chats.
--   • Plans = users + friends create plans; each plan has its own group chat.
--
-- This migration adds the two get-or-create bootstraps the routers need, both
-- SECURITY DEFINER for the same reason 0011's create_thread_with_creator is:
-- thread creation has a chicken-and-egg with the chat_participants WITH CHECK
-- (in_thread) policy — the creator can't be "in the thread" until the thread
-- and their participant row both exist. Routing creation through a definer
-- function inserts the thread + participants atomically, so a thread can never
-- exist without its members. chat_threads still has NO direct INSERT policy
-- (0011's invariant): the absence of any other write path IS the guarantee.
--
-- RLS-helper rule (0010): any function that reads/writes RLS-protected tables
-- runs SECURITY DEFINER with a pinned search_path.
--
-- Idempotent: create-or-replace functions; create-index-if-not-exists.

-- ----------------------------------------------------------------------------
-- 1. One plan ⇒ at most one plan chat. A partial unique index makes the
--    get-or-create below race-safe: two members opening the chat at once can't
--    create two threads for the same plan (the second insert hits the index).
-- ----------------------------------------------------------------------------
create unique index if not exists uq_chat_threads_plan
  on public.chat_threads (plan_id)
  where plan_id is not null;

-- ----------------------------------------------------------------------------
-- 2. get_or_create_plan_thread — the group chat bound to a plan.
--    Caller must be the plan OWNER or a MEMBER (mirrors plans_read RLS). On first
--    call it creates the thread (is_group, plan_id set, titled after the plan) and
--    seeds participants = owner + all current members. On later calls it returns
--    the existing thread and self-adds the caller (covers members invited after the
--    thread was first opened — the lazy late-join path).
-- ----------------------------------------------------------------------------
create or replace function public.get_or_create_plan_thread(p_plan_id uuid)
returns public.chat_threads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_owner  uuid;
  v_title  text;
  v_thread public.chat_threads;
begin
  if v_uid is null then
    raise exception 'get_or_create_plan_thread: no authenticated user'
      using errcode = '28000';
  end if;

  select owner_id, title into v_owner, v_title
  from public.plans where id = p_plan_id;
  if v_owner is null then
    raise exception 'get_or_create_plan_thread: plan not found'
      using errcode = 'P0002';
  end if;

  -- Owner-or-member gate (the same set plans_read admits).
  if v_uid <> v_owner and not exists (
    select 1 from public.plan_members m
    where m.plan_id = p_plan_id and m.profile_id = v_uid
  ) then
    raise exception 'get_or_create_plan_thread: not a member of this plan'
      using errcode = '42501';
  end if;

  -- Existing plan thread? Ensure the caller is a participant, then return it.
  select * into v_thread from public.chat_threads where plan_id = p_plan_id limit 1;
  if found then
    insert into public.chat_participants (thread_id, profile_id)
    values (v_thread.id, v_uid)
    on conflict (thread_id, profile_id) do nothing;
    return v_thread;
  end if;

  -- Create it, titled after the plan.
  insert into public.chat_threads (is_group, plan_id, title)
  values (true, p_plan_id, coalesce(nullif(btrim(v_title), ''), 'Plan chat'))
  returning * into v_thread;

  -- Seed participants: the owner …
  insert into public.chat_participants (thread_id, profile_id)
  values (v_thread.id, v_owner)
  on conflict (thread_id, profile_id) do nothing;

  -- … and every current member.
  insert into public.chat_participants (thread_id, profile_id)
  select v_thread.id, m.profile_id
  from public.plan_members m
  where m.plan_id = p_plan_id
  on conflict (thread_id, profile_id) do nothing;

  return v_thread;
end;
$$;

revoke all on function public.get_or_create_plan_thread(uuid) from public;
grant execute on function public.get_or_create_plan_thread(uuid) to authenticated;

-- ----------------------------------------------------------------------------
-- 3. get_or_create_direct_thread — the 1:1 chat between the caller and another
--    profile. Dedupes: returns the existing direct thread (is_group=false,
--    plan_id null) whose participants are EXACTLY the two of them, else creates
--    one with both as participants. Keeps the chat inbox free of duplicate DMs.
-- ----------------------------------------------------------------------------
create or replace function public.get_or_create_direct_thread(p_other uuid)
returns public.chat_threads
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid    uuid := auth.uid();
  v_thread public.chat_threads;
begin
  if v_uid is null then
    raise exception 'get_or_create_direct_thread: no authenticated user'
      using errcode = '28000';
  end if;
  if p_other = v_uid then
    raise exception 'get_or_create_direct_thread: cannot start a chat with yourself'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_other) then
    raise exception 'get_or_create_direct_thread: no such profile'
      using errcode = 'P0002';
  end if;

  -- An existing 1:1 thread containing exactly these two people.
  select t.* into v_thread
  from public.chat_threads t
  where t.is_group = false
    and t.plan_id is null
    and exists (select 1 from public.chat_participants p
                where p.thread_id = t.id and p.profile_id = v_uid)
    and exists (select 1 from public.chat_participants p
                where p.thread_id = t.id and p.profile_id = p_other)
    and (select count(*) from public.chat_participants p where p.thread_id = t.id) = 2
  limit 1;
  if found then
    return v_thread;
  end if;

  insert into public.chat_threads (is_group, plan_id, title)
  values (false, null, null)
  returning * into v_thread;

  insert into public.chat_participants (thread_id, profile_id)
  values (v_thread.id, v_uid), (v_thread.id, p_other)
  on conflict (thread_id, profile_id) do nothing;

  return v_thread;
end;
$$;

revoke all on function public.get_or_create_direct_thread(uuid) from public;
grant execute on function public.get_or_create_direct_thread(uuid) to authenticated;

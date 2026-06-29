-- Migration 0037 — fix infinite RLS recursion between plans and plan_members.
--
-- THE BUG (surfaced once plans gained members in the chat/plans work):
--   plans_read         = owner_id = auth.uid() OR exists(plan_members where plan_id = id ...)
--   plan_members_read  = profile_id = auth.uid() OR exists(plans where id = plan_id ...)
-- Selecting from plans runs plans_read, whose plan_members subquery runs plan_members_read,
-- whose plans subquery runs plans_read again → Postgres aborts with "infinite recursion
-- detected in policy for relation plans". The symptom: the /plans list and the Home "Your
-- plans" widget fail with "Couldn't load your plans" the moment any plan has a member row.
--
-- THE FIX (identical pattern to 0010's in_thread): move each cross-table membership check
-- into a SECURITY DEFINER function with a pinned search_path, so the inner read BYPASSES RLS
-- and the policy cycle is broken. The functions leak nothing — each returns a boolean about
-- the current auth.uid(). Then rewrite the plans / plan_members / plan_venues policies to call
-- them instead of inlining the recursive subqueries.
--
-- Idempotent: create-or-replace functions; drop-if-exists before each policy.

-- ----------------------------------------------------------------------------
-- 1. Membership primitives (definer, RLS-bypassing — the recursion breakers).
-- ----------------------------------------------------------------------------
create or replace function public.owns_plan(p_plan uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from plans p where p.id = p_plan and p.owner_id = auth.uid()
  );
$$;

create or replace function public.is_plan_member(p_plan uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from plan_members m where m.plan_id = p_plan and m.profile_id = auth.uid()
  );
$$;

revoke all on function public.owns_plan(uuid) from public;
revoke all on function public.is_plan_member(uuid) from public;
grant execute on function public.owns_plan(uuid) to authenticated, service_role;
grant execute on function public.is_plan_member(uuid) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 2. plans — read for owner-or-member (member check via definer → no recursion).
--    insert/update/delete are owner-only and reference no other table; left as-is.
-- ----------------------------------------------------------------------------
drop policy if exists plans_read on public.plans;
create policy plans_read on public.plans for select
  using (owner_id = auth.uid() or is_plan_member(id));

-- ----------------------------------------------------------------------------
-- 3. plan_members — read/write/delete; owner check via definer → no recursion.
-- ----------------------------------------------------------------------------
drop policy if exists plan_members_read on public.plan_members;
create policy plan_members_read on public.plan_members for select
  using (profile_id = auth.uid() or owns_plan(plan_id));

drop policy if exists plan_members_write on public.plan_members;
create policy plan_members_write on public.plan_members for insert
  with check (owns_plan(plan_id) or profile_id = auth.uid());

drop policy if exists plan_members_delete on public.plan_members;
create policy plan_members_delete on public.plan_members for delete
  using (profile_id = auth.uid() or owns_plan(plan_id));

-- ----------------------------------------------------------------------------
-- 4. plan_venues — read/write for owner-or-member, delete owner-only. Both checks
--    via definer functions (previously inlined subqueries over plans + plan_members).
-- ----------------------------------------------------------------------------
drop policy if exists plan_venues_read on public.plan_venues;
create policy plan_venues_read on public.plan_venues for select
  using (owns_plan(plan_id) or is_plan_member(plan_id));

drop policy if exists plan_venues_write on public.plan_venues;
create policy plan_venues_write on public.plan_venues for insert
  with check (owns_plan(plan_id) or is_plan_member(plan_id));

drop policy if exists plan_venues_delete on public.plan_venues;
create policy plan_venues_delete on public.plan_venues for delete
  using (owns_plan(plan_id));

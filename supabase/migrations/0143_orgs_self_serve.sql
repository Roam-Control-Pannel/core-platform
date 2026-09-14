-- 0143_orgs_self_serve.sql
--
-- Food to Go · Phase C · Slice C3-a — SELF-SERVE supplier creation on `orgs`.
--
-- **This is the first client WRITE to orgs (0136) and carries a MANDATORY security review.** 0136
-- deliberately shipped orgs with a read policy, an owner-UPDATE policy + column guard, and a definer
-- slug — but NO client INSERT policy, precisely because conferring the ability to create a directory
-- entity is the tightest-scrutiny change. This migration adds exactly that, with three lines of defence:
--
--   1. ENTITLEMENT — only a LIVE Food to Go member may create a supplier (decision #9, "free for
--      members"). f2g_can_post_supplier() is the f2g-scoped sibling of f2g_can_post_as_member (0142):
--      a SECURITY DEFINER boolean over the service-managed roster that reveals only the caller's own
--      live membership. It gates the insert in the policy's WITH CHECK.
--   2. WITH CHECK pins the safe shape — owner_id = auth.uid(), status = 'draft', moderation = 'pending'
--      — so a client can only ever create a draft, pending-moderation supplier they own. The MODERATION
--      HARD GATE (orgs_read, 0136) means that row is invisible to the public until staff approve it.
--   3. A BEFORE INSERT client guard NEUTRALISES a hostile payload before the check even runs: it forces
--      owner_id/status/moderation to the safe values and nulls slug so the definer trigger regenerates
--      it (no slug-squatting a competitor's name). Service/staff inserts (current_user not a client
--      role) are untouched — staff can still create a stub with any shape (0136's intent).
--
-- Owners still CANNOT self-approve: the existing orgs_guard_owner_columns (0136) restricts owner UPDATEs
-- to presentational columns, so status/moderation/owner_id/slug/category remain server/definer-managed.
-- Additive; idempotent. After applying, run `notify pgrst, 'reload schema'`.

-- ── entitlement: a LIVE Food to Go member (the f2g-scoped sibling of f2g_can_post_as_member) ───────
create or replace function public.f2g_can_post_supplier()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from channel_members m
    join channels c on c.id = m.channel_id
    where c.key = 'f2g'
      and m.claimed_by = auth.uid()
      and m.status = 'live'
  );
$$;

comment on function public.f2g_can_post_supplier() is
  'Entitlement (decision #9) for self-serve supplier creation: true iff auth.uid() is a LIVE member of the f2g channel. SECURITY DEFINER (reads the service-managed roster) but scoped to the caller''s own membership. The f2g-scoped sibling of f2g_can_post_as_member (0142); gates the orgs self-insert policy.';

revoke all on function public.f2g_can_post_supplier() from public;
grant execute on function public.f2g_can_post_supplier() to authenticated;

-- ── the client-insert guard (neutralise a hostile payload before WITH CHECK) ──────────────────────
create or replace function public.orgs_guard_client_insert()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  -- Only client roles are constrained; service_role / staff (definer paths) create stubs freely (0136).
  if current_user in ('authenticated', 'anon') then
    new.owner_id   := auth.uid();     -- you may only create a supplier you own
    new.status     := 'draft';        -- never public on creation
    new.moderation := 'pending';      -- the moderation hard gate applies (orgs_read)
    new.slug       := null;           -- force set_org_slug to (re)generate — no slug-squatting
  end if;
  return new;
end;
$$;

-- Fires BEFORE trg_orgs_slug ('orgs_...' sorts before 'trg_...'), so nulling slug here lets the
-- definer slug trigger generate it from the (client-supplied) name/locality.
drop trigger if exists orgs_guard_client_insert on orgs;
create trigger orgs_guard_client_insert
  before insert on orgs
  for each row execute function public.orgs_guard_client_insert();

-- ── the self-serve INSERT policy (the reviewed write) ─────────────────────────────────────────────
drop policy if exists orgs_self_insert on orgs;
create policy orgs_self_insert on orgs for insert
  with check (
    owner_id = auth.uid()
    and status = 'draft'
    and moderation = 'pending'
    and public.f2g_can_post_supplier()
  );

comment on policy orgs_self_insert on orgs is
  'C3 self-serve: a LIVE f2g member may create a draft, pending-moderation supplier they own. Entitlement via f2g_can_post_supplier(); the safe shape is pinned by WITH CHECK and defended by orgs_guard_client_insert. Public visibility still requires staff approval (orgs_read moderation hard gate).';

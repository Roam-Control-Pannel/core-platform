-- 0049_venue_activity.sql
--
-- Business Activity Centre: a per-venue feed of things people did with the business — new follows,
-- offer saves, offer redemptions — so an owner sees momentum on their dashboard. Unlike the
-- per-USER `notifications` table, this is VENUE-targeted and read only by the venue owner.
--
-- Rows are written ONLY by SECURITY DEFINER triggers below (a follower saving an offer isn't the
-- owner, so the write must bypass RLS); there is deliberately no INSERT policy for users. The
-- owner reads their venue's rows and marks them read via mark_venue_activity_read().
-- Additive + idempotent; safe to run once on the Roam-Core project.

create table if not exists venue_activity (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues(id) on delete cascade,
  type       text not null,                 -- 'follow' | 'offer_save' | 'offer_redeem'
  actor_id   uuid references profiles(id) on delete set null,
  payload    jsonb not null default '{}'::jsonb,   -- { offerId, offerTitle, ... }
  created_at timestamptz not null default now(),
  read_at    timestamptz
);

create index if not exists venue_activity_venue_created_idx on venue_activity (venue_id, created_at desc);
create index if not exists venue_activity_unread_idx on venue_activity (venue_id) where read_at is null;

alter table venue_activity enable row level security;

-- Owner-only read. No insert/update/delete policies → only the SECURITY DEFINER routines write.
drop policy if exists venue_activity_owner_read on venue_activity;
create policy venue_activity_owner_read on venue_activity for select
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

-- ── event emitters (SECURITY DEFINER so they can write past RLS on the actor's action) ─────────

create or replace function tg_activity_follow() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into venue_activity (venue_id, type, actor_id)
  values (new.venue_id, 'follow', new.follower_id);
  return new;
end;
$$;

create or replace function tg_activity_offer_save() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_venue uuid; v_title text;
begin
  select venue_id, title into v_venue, v_title from offers where id = new.offer_id;
  if v_venue is not null then
    insert into venue_activity (venue_id, type, actor_id, payload)
    values (v_venue, 'offer_save', new.profile_id,
            jsonb_build_object('offerId', new.offer_id, 'offerTitle', v_title));
  end if;
  return new;
end;
$$;

create or replace function tg_activity_offer_redeem() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_venue uuid; v_title text;
begin
  select venue_id, title into v_venue, v_title from offers where id = new.offer_id;
  if v_venue is not null then
    insert into venue_activity (venue_id, type, actor_id, payload)
    values (v_venue, 'offer_redeem', new.profile_id,
            jsonb_build_object('offerId', new.offer_id, 'offerTitle', v_title));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_activity_follow on follows;
create trigger trg_activity_follow after insert on follows
  for each row execute function tg_activity_follow();

drop trigger if exists trg_activity_offer_save on offer_saves;
create trigger trg_activity_offer_save after insert on offer_saves
  for each row execute function tg_activity_offer_save();

drop trigger if exists trg_activity_offer_redeem on offer_redemptions;
create trigger trg_activity_offer_redeem after insert on offer_redemptions
  for each row execute function tg_activity_offer_redeem();

-- Owner marks their venue's activity read (bulk). Returns how many were cleared.
create or replace function mark_venue_activity_read(p_venue uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if not exists (select 1 from venues v where v.id = p_venue and v.owner_id = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;
  update venue_activity set read_at = now() where venue_id = p_venue and read_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;

grant execute on function mark_venue_activity_read(uuid) to authenticated;

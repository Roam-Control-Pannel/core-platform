-- 0053_birthday_offers.sql
--
-- The birthday-offer ENGINE — the privacy-safe pay-off of the DOB work. A business configures one
-- standing "birthday treat"; a daily job delivers it to the followers whose birthday is today AND
-- who opted in — as an in-app notification — and logs the delivery so the business sees COUNTS.
--
-- Privacy: the business never sees who had a birthday. venue_birthday_offer (the treat config) is
-- owner-managed; birthday_deliveries (who got one, when) has NO read policy at all — only the
-- SECURITY DEFINER routines touch it, and the owner sees only aggregate counts via
-- venue_birthday_stats. Delivery is done by deliver_birthday_offers(), meant to run once daily
-- (schedule it with pg_cron — snippet in the PR). Additive + idempotent.

-- ── the treat a venue offers on birthdays ──────────────────────────────────────────────────────
create table if not exists venue_birthday_offer (
  venue_id   uuid primary key references venues(id) on delete cascade,
  enabled    boolean not null default false,
  title      text,
  details    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table venue_birthday_offer enable row level security;
drop policy if exists vbo_owner_all on venue_birthday_offer;
create policy vbo_owner_all on venue_birthday_offer for all
  using (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()))
  with check (exists (select 1 from venues v where v.id = venue_id and v.owner_id = auth.uid()));

drop trigger if exists trg_vbo_updated on venue_birthday_offer;
create trigger trg_vbo_updated before update on venue_birthday_offer
  for each row execute function set_updated_at();

-- ── delivery log (who got a birthday treat, when) — NO read policy, aggregate-only exposure ────
create table if not exists birthday_deliveries (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues(id) on delete cascade,
  user_id      uuid not null references profiles(id) on delete cascade,
  delivered_on date not null default current_date,
  created_at   timestamptz not null default now(),
  unique (venue_id, user_id, delivered_on)
);
alter table birthday_deliveries enable row level security;
-- Intentionally NO policies: this table reveals who had a birthday, so nobody reads it directly.

-- ── the daily delivery job ─────────────────────────────────────────────────────────────────────
-- Finds today's eligible recipients (venue has an enabled treat · follower opted in · birthday is
-- today · not already delivered today), logs each delivery, and drops a birthday notification into
-- their inbox. Idempotent per day via the unique(delivered_on) key. Run once a day (pg_cron).
create or replace function deliver_birthday_offers()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
begin
  with eligible as (
    select bo.venue_id, v.name as venue_name, bo.title, f.follower_id as user_id
    from venue_birthday_offer bo
    join venues v on v.id = bo.venue_id
    join follows f on f.venue_id = bo.venue_id
    join user_private up on up.user_id = f.follower_id
    where bo.enabled = true
      and up.birthday_offers_enabled = true
      and up.birth_date is not null
      and extract(month from up.birth_date) = extract(month from now())
      and extract(day from up.birth_date) = extract(day from now())
  ),
  ins as (
    insert into birthday_deliveries (venue_id, user_id, delivered_on)
    select venue_id, user_id, current_date from eligible
    on conflict (venue_id, user_id, delivered_on) do nothing
    returning venue_id, user_id
  ),
  notified as (
    insert into notifications (recipient_id, type, payload)
    select i.user_id, 'birthday_offer',
      jsonb_build_object(
        'text', '🎂 Happy birthday! ' || coalesce(e.title, 'A birthday treat') || ' from ' || e.venue_name,
        'href', '/venue/' || i.venue_id,
        'venueId', i.venue_id,
        'venueName', e.venue_name
      )
    from ins i
    join (select distinct venue_id, venue_name, title from eligible) e on e.venue_id = i.venue_id
    returning 1
  )
  select count(*) into n from ins;
  return n;
end;
$$;

revoke all on function deliver_birthday_offers() from public;
grant execute on function deliver_birthday_offers() to service_role;

-- ── owner-facing counts (never identities) ─────────────────────────────────────────────────────
create or replace function venue_birthday_stats(p_venue uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  this_month int;
  total      int;
begin
  if not exists (select 1 from venues v where v.id = p_venue and v.owner_id = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;
  select
    count(*) filter (where delivered_on >= date_trunc('month', now())),
    count(*)
  into this_month, total
  from birthday_deliveries where venue_id = p_venue;
  return jsonb_build_object('sentThisMonth', coalesce(this_month, 0), 'sentTotal', coalesce(total, 0));
end;
$$;

grant execute on function venue_birthday_stats(uuid) to authenticated;

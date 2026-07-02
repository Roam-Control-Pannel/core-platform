-- 0055_birthday_delivery_returns.sql
--
-- Birthday engine v2-B: web-push delivery. Until now deliver_birthday_offers() only wrote
-- in-app notifications (Postgres has no way to sign a VAPID JWT / open a web-push socket). To
-- ALSO push, the delivery has to hand the freshly-granted rows to the Node API (which owns the
-- web-push machinery + the credit ledger). So two changes here:
--
--   1. deliver_birthday_offers() now RETURNS the rows it just inserted — (user_id, venue_id,
--      venue_name, title, code, push_ok) — instead of a bare count. The atomic work is
--      unchanged (insert the private grant + the in-app notification, capped 5/user/day,
--      engaged venues first); it just also emits who was granted so the caller can push them.
--      push_ok carries the follow's push_enabled so the job never pushes to a muted follower.
--
--   2. The pg_cron schedule 'birthday-offers-daily' (which called this function DB-side) is
--      unscheduled. The Railway cron now calls it via the Node job (pnpm deliver-birthdays),
--      which reuses pushToProfileIds + the credit ledger. If BOTH ran, whichever fired first
--      would consume the day's grants (on conflict do nothing), leaving the other with nothing
--      to push — so there must be exactly one caller, and it must be the one that can push.
--
-- The in-app notification remains FREE and always lands; the web push is the paid upgrade the
-- job layers on top (1 credit per pushed recipient, capped to the venue's balance).
--
-- Return type changes, so the function is dropped + recreated (create-or-replace can't change
-- a function's return type). Additive + idempotent otherwise.

-- Stop the DB-side schedule so the Node job is the sole caller (guarded: no-op if absent, e.g.
-- when pg_cron was never installed / the job was already removed).
do $$
begin
  if exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'cron' and c.relname = 'job'
  ) and exists (select 1 from cron.job where jobname = 'birthday-offers-daily') then
    perform cron.unschedule('birthday-offers-daily');
  end if;
end $$;

drop function if exists deliver_birthday_offers();

-- Daily delivery: writes the private grant + in-app notification (both free), then RETURNS the
-- newly granted rows so the Node job can push the push_ok ones (1 credit each, balance-capped).
create function deliver_birthday_offers()
returns table (
  user_id uuid,
  venue_id uuid,
  venue_name text,
  title text,
  code text,
  push_ok boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  per_user_cap int := 5;
begin
  return query
  with eligible as (
    select
      bo.venue_id, v.name as venue_name, bo.title, f.follower_id as user_id,
      coalesce(f.push_enabled, false) as push_ok,
      row_number() over (
        partition by f.follower_id
        order by
          -- engaged venues first (this user's saves for the venue), then most-recent follow
          (select count(*) from offer_saves s join offers o on o.id = s.offer_id
             where o.venue_id = bo.venue_id and s.profile_id = f.follower_id) desc,
          f.created_at desc
      ) as rnk
    from venue_birthday_offer bo
    join venues v on v.id = bo.venue_id
    join follows f on f.venue_id = bo.venue_id
    join user_private up on up.user_id = f.follower_id
    where bo.enabled = true
      and up.birthday_offers_enabled = true and up.birth_date is not null
      and extract(month from up.birth_date) = extract(month from now())
      and extract(day from up.birth_date) = extract(day from now())
  ),
  capped as (
    select * from eligible where rnk <= per_user_cap
  ),
  ins as (
    insert into birthday_deliveries (venue_id, user_id, delivered_on, code, expires_at, title)
    select c.venue_id, c.user_id, current_date, upper(substr(md5(random()::text), 1, 6)), current_date + 7, c.title
    from capped c
    on conflict (venue_id, user_id, delivered_on) do nothing
    returning venue_id, user_id, code, expires_at
  ),
  notified as (
    insert into notifications (recipient_id, type, payload)
    select i.user_id, 'birthday_offer',
      jsonb_build_object(
        'text', '🎂 Happy birthday! ' || coalesce(e.title, 'A birthday treat') || ' from ' || e.venue_name,
        'href', '/venue/' || i.venue_id,
        'venueId', i.venue_id, 'venueName', e.venue_name,
        'code', i.code, 'expiresAt', i.expires_at
      )
    from ins i
    join (select distinct venue_id, venue_name, title from capped) e on e.venue_id = i.venue_id
    returning 1
  )
  -- Emit the freshly granted rows (only truly-new inserts survive `on conflict do nothing`), so
  -- the caller pushes each person exactly once. push_ok comes from the follow (never push a mute).
  select i.user_id, i.venue_id, c.venue_name, c.title, i.code, c.push_ok
  from ins i
  join capped c on c.venue_id = i.venue_id and c.user_id = i.user_id;
end;
$$;

revoke all on function deliver_birthday_offers() from public;
grant execute on function deliver_birthday_offers() to service_role;

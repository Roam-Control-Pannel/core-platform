-- 0054_birthday_offers_v2.sql
--
-- Birthday engine v2-A: make the treat REDEEMABLE (closing the funnel: delivered → redeemed) and
-- cap delivery so a user following many places doesn't get a pile of pushes on one morning.
--
--   * birthday_deliveries gains code + expires_at + redeemed_at — the delivery row IS the personal,
--     private, time-boxed grant (no public offers-table entanglement).
--   * A user may read their OWN grants (new self-select policy); businesses still can't read the
--     table (no owner policy) — they only ever see counts.
--   * deliver_birthday_offers() now caps to 5 venues per user per day (engaged venues first),
--     stamps a code + a 7-day expiry, and carries them in the notification payload.
--   * redeem_birthday_offer(venue) lets a user redeem their own live grant (controlled RPC).
--   * venue_birthday_stats() now also returns redeemed counts, so the dashboard shows the funnel.
-- Additive + idempotent.

alter table birthday_deliveries add column if not exists code text;
alter table birthday_deliveries add column if not exists expires_at date;
alter table birthday_deliveries add column if not exists redeemed_at timestamptz;
-- Denormalised so the recipient can see their treat without reading the owner-only offer config.
alter table birthday_deliveries add column if not exists title text;

-- A user can see their OWN birthday grants (to show + redeem them). Business owners still cannot
-- read this table (there is deliberately no owner policy) — they get counts via the stats RPC.
drop policy if exists birthday_deliveries_self_read on birthday_deliveries;
create policy birthday_deliveries_self_read on birthday_deliveries for select
  using (user_id = auth.uid());

-- Daily delivery, now capped + with a redeemable code/expiry.
create or replace function deliver_birthday_offers()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n int := 0;
  per_user_cap int := 5;
begin
  with eligible as (
    select
      bo.venue_id, v.name as venue_name, bo.title, f.follower_id as user_id,
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
    select venue_id, user_id, current_date, upper(substr(md5(random()::text), 1, 6)), current_date + 7, title
    from capped
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
  select count(*) into n from ins;
  return n;
end;
$$;

revoke all on function deliver_birthday_offers() from public;
grant execute on function deliver_birthday_offers() to service_role;

-- A user redeems their own live birthday grant for a venue (most recent, unexpired). Idempotent:
-- re-redeeming returns the same code with alreadyRedeemed=true.
create or replace function redeem_birthday_offer(p_venue uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare d birthday_deliveries%rowtype;
begin
  select * into d from birthday_deliveries
    where venue_id = p_venue and user_id = auth.uid()
      and (expires_at is null or expires_at >= current_date)
    order by delivered_on desc
    limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;
  if d.redeemed_at is not null then
    return jsonb_build_object('ok', true, 'alreadyRedeemed', true, 'code', d.code);
  end if;
  update birthday_deliveries set redeemed_at = now() where id = d.id;
  return jsonb_build_object('ok', true, 'alreadyRedeemed', false, 'code', d.code);
end;
$$;

grant execute on function redeem_birthday_offer(uuid) to authenticated;

-- Owner counts now include redemptions (the funnel), still never identities.
create or replace function venue_birthday_stats(p_venue uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  sent_month int; sent_total int; red_month int; red_total int;
begin
  if not exists (select 1 from venues v where v.id = p_venue and v.owner_id = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;
  select
    count(*) filter (where delivered_on >= date_trunc('month', now())),
    count(*),
    count(*) filter (where redeemed_at is not null and redeemed_at >= date_trunc('month', now())),
    count(*) filter (where redeemed_at is not null)
  into sent_month, sent_total, red_month, red_total
  from birthday_deliveries where venue_id = p_venue;
  return jsonb_build_object(
    'sentThisMonth', coalesce(sent_month, 0),
    'sentTotal', coalesce(sent_total, 0),
    'redeemedThisMonth', coalesce(red_month, 0),
    'redeemedTotal', coalesce(red_total, 0)
  );
end;
$$;

grant execute on function venue_birthday_stats(uuid) to authenticated;

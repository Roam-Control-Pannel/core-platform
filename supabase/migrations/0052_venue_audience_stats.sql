-- 0052_venue_audience_stats.sql
--
-- Aggregate AUDIENCE analytics for a business, computed server-side and returned as counts only —
-- a venue owner sees the shape of their following, never an individual. SECURITY DEFINER (it must
-- read user_private + push_subscriptions across users to aggregate), but owner-gated, and every
-- demographic breakdown is protected by a k-anonymity floor so small followings can't be
-- de-anonymised:
--   * birthdays-this-month is withheld unless the venue has >= 5 followers.
--   * the age-band distribution is withheld unless >= 8 followers have shared a birth date.
-- Individual dates are never returned. Additive + idempotent.

create or replace function venue_audience_stats(p_venue uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  total       int;
  new30       int;
  engaged30   int;
  push_reach  int;
  dob_sample  int;
  bdays_month int;
  bands       jsonb;
  min_total   int := 5;   -- floor for any count-of-people demographic (birthdays)
  min_demo    int := 8;   -- floor for the age-band distribution
begin
  if not exists (select 1 from venues v where v.id = p_venue and v.owner_id = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;

  select count(*) into total from follows f where f.venue_id = p_venue;
  select count(*) into new30 from follows f
    where f.venue_id = p_venue and f.created_at >= now() - interval '30 days';

  -- Engaged: followers who saved OR redeemed one of this venue's offers in the last 30 days.
  select count(distinct u) into engaged30 from (
    select s.profile_id as u
      from offer_saves s join offers o on o.id = s.offer_id
      where o.venue_id = p_venue and s.created_at >= now() - interval '30 days'
        and s.profile_id in (select follower_id from follows where venue_id = p_venue)
    union
    select r.profile_id as u
      from offer_redemptions r join offers o on o.id = r.offer_id
      where o.venue_id = p_venue and r.redeemed_at >= now() - interval '30 days'
        and r.profile_id in (select follower_id from follows where venue_id = p_venue)
  ) e;

  -- Push reach: followers who could actually receive a push (subscribed + not muted).
  select count(distinct f.follower_id) into push_reach
    from follows f
    join push_subscriptions ps on ps.profile_id = f.follower_id
    where f.venue_id = p_venue and coalesce(ps.consent, true) = true and f.push_enabled = true;

  -- DOB sample: followers who've shared a birth date at all.
  select count(*) into dob_sample
    from follows f join user_private up on up.user_id = f.follower_id
    where f.venue_id = p_venue and up.birth_date is not null;

  -- Birthdays this month among opted-in followers (the reachable birthday audience).
  select count(*) into bdays_month
    from follows f join user_private up on up.user_id = f.follower_id
    where f.venue_id = p_venue
      and up.birthday_offers_enabled = true and up.birth_date is not null
      and extract(month from up.birth_date) = extract(month from now());

  if dob_sample >= min_demo then
    select jsonb_object_agg(band, cnt) into bands from (
      select band, count(*)::int as cnt from (
        select case
          when age < 18 then 'under_18'
          when age between 18 and 24 then 'age_18_24'
          when age between 25 and 34 then 'age_25_34'
          when age between 35 and 44 then 'age_35_44'
          when age between 45 and 54 then 'age_45_54'
          when age between 55 and 64 then 'age_55_64'
          else 'age_65_plus'
        end as band
        from (
          select extract(year from age(up.birth_date))::int as age
          from follows f join user_private up on up.user_id = f.follower_id
          where f.venue_id = p_venue and up.birth_date is not null
        ) ages
      ) banded
      group by band
    ) agg;
  else
    bands := null;
  end if;

  return jsonb_build_object(
    'followers', total,
    'new30', new30,
    'engaged30', engaged30,
    'pushReach', push_reach,
    'birthdaysThisMonth', case when total >= min_total then bdays_month else null end,
    'ageBands', bands,
    'dobSample', dob_sample
  );
end;
$$;

grant execute on function venue_audience_stats(uuid) to authenticated;

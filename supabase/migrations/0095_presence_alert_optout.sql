-- 0095_presence_alert_optout.sql
--
-- Per-user opt-out for nearby-and-available push alerts (PR 3 follow-up). A recipient can turn OFF
-- "let friends notify me when they're nearby and free" without leaving the friendship or disabling
-- all push. The preference lives on user_private (owner-only RLS, same home as birthday_offers_enabled)
-- and defaults to TRUE — the alerts are friend-only + throttled + push-consent-gated already, so
-- opt-OUT (not opt-in) is the right default; anyone who doesn't want them flips one switch.
--
-- Enforced at the source: claim_nearby_alert_targets (0094) is recreated to also exclude any friend
-- whose presence_alerts_enabled is false. A user with no user_private row is treated as enabled
-- (coalesce → true), so existing users keep getting alerts until they opt out.
--
-- Idempotent + additive; safe to run once on the Roam-Core project. Depends on 0092–0094.

alter table user_private
  add column if not exists presence_alerts_enabled boolean not null default true;

-- Same signature + body as 0094, plus the recipient opt-out check. create-or-replace keeps the
-- signature identical, so there is no cross-deploy dependency.
create or replace function claim_nearby_alert_targets(
  radius_m      double precision default 5000,
  cooldown_secs integer default 10800
)
returns table (profile_id uuid)
language sql
security definer
set search_path = public, pg_temp
as $$
  with me as (
    select fp.geo, fp.availability, fp.expires_at, fp.geo_expires_at
    from friend_presence fp
    where fp.profile_id = auth.uid()
  ),
  targets as (
    select f.profile_id
    from friend_presence f
    cross join me
    where me.geo is not null
      and me.geo_expires_at is not null and me.geo_expires_at > now()
      and me.availability = 'free_to_meet'
      and (me.expires_at is null or me.expires_at > now())
      and f.profile_id <> auth.uid()
      and f.geo is not null
      and f.geo_expires_at is not null and f.geo_expires_at > now()
      and st_dwithin(f.geo, me.geo, radius_m)
      and are_friends(auth.uid(), f.profile_id)
      and coalesce((select up.presence_alerts_enabled from user_private up where up.user_id = f.profile_id), true)
      and not exists (
        select 1 from presence_alerts a
        where a.from_id = auth.uid()
          and a.to_id = f.profile_id
          and a.alerted_at > now() - make_interval(secs => cooldown_secs)
      )
  ),
  recorded as (
    insert into presence_alerts (from_id, to_id, alerted_at)
    select auth.uid(), t.profile_id, now() from targets t
    on conflict (from_id, to_id) do update set alerted_at = excluded.alerted_at
    returning to_id
  )
  select to_id from recorded;
$$;

revoke all on function claim_nearby_alert_targets(double precision, integer) from public, anon;
grant execute on function claim_nearby_alert_targets(double precision, integer) to authenticated;

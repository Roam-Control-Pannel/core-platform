-- 0094_presence_nearby_alerts.sql
--
-- Nearby-and-available push alerts — PR 3 of "share with friends". The headline moment: when you
-- signal you're up for socialising (availability = 'free_to_meet') WHILE sharing your location,
-- your friends who are ALSO out (sharing their location nearby) get a heads-up — "Alex is nearby
-- and free to meet." The push itself is dispatched by the API (web-push is Node-only); this
-- migration provides the throttled target-selection that makes it safe and bounded.
--
-- Bounded by the FRIEND SET, never all users: claim_nearby_alert_targets only ever looks at the
-- caller's accepted friends who are themselves sharing a live location within radius. It is
-- event-driven (called right after the caller updates their presence), so there is no sweep and no
-- cron.
--
-- Anti-spam by construction (presence_alerts ledger): a given from→to pair is alerted at most once
-- per cooldown window (default 3h). The selection + the ledger write happen in ONE statement (a
-- data-modifying CTE), so concurrent calls can't both slip through, and the recency check reads the
-- pre-statement snapshot so a target is never excluded by its own just-written row.
--
-- Privacy unchanged: everything stays are_friends-gated and auth.uid()-scoped; the ledger is not
-- user-readable (no policies — only the definer function touches it).
--
-- Idempotent; safe to run once on the Roam-Core project. Depends on 0092 + 0093.

-- Throttle ledger: last time `from_id` alerted `to_id`. One row per ordered pair.
create table if not exists presence_alerts (
  from_id    uuid not null references profiles(id) on delete cascade,
  to_id      uuid not null references profiles(id) on delete cascade,
  alerted_at timestamptz not null default now(),
  primary key (from_id, to_id)
);

alter table presence_alerts enable row level security;
-- Deliberately NO policies: this ledger is internal throttle state, written & read only by the
-- definer function below (which bypasses RLS). No client ever reads it.

-- Select the friends to notify for the caller's current presence, record the alert, and return the
-- newly-alerted profile ids — atomically. Returns zero rows unless the CALLER is themselves
-- free_to_meet AND sharing a live location (so we know where they are and that they want company).
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
      and me.geo_expires_at is not null and me.geo_expires_at > now()   -- caller sharing a live location
      and me.availability = 'free_to_meet'                              -- caller wants company
      and (me.expires_at is null or me.expires_at > now())              -- …and that status is still live
      and f.profile_id <> auth.uid()
      and f.geo is not null
      and f.geo_expires_at is not null and f.geo_expires_at > now()     -- friend sharing a live location
      and st_dwithin(f.geo, me.geo, radius_m)                           -- …and nearby
      and are_friends(auth.uid(), f.profile_id)                         -- …and actually a friend
      and not exists (                                                  -- …and not alerted recently
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

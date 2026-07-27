-- ============================================================================
-- Roam — 0107_founder_badges.sql
-- "Founding member" badges — the retention keystone of the new-visitor plan.
--
-- A brand-new visitor is (often) the first person on Roam in their town. To make
-- being first PAY OFF, we award a permanent, honest badge to the earliest
-- community contributors in each locality: "Founding member of Darlington · #3".
--
-- Anchor: authorship of a Town Hall TOPIC (town_hall_topics, 0030) — the one
-- content type that is explicitly locality-scoped (topic.locality), and exactly
-- where the empty-area "Pioneer" banner sends people ("Start the first
-- conversation"). A person's rank in a locality is their position when ranked by
-- the timestamp of their FIRST approved topic there; the first N (default 25)
-- are founders. Only approved topics count (a rejected/spam topic can't mint a
-- badge), and only real authors (author_id not null).
--
-- Computed at READ time from the live topic set — no denormalised table, no
-- trigger, no backfill: existing topics rank correctly the moment this runs, and
-- the ranking can never drift. security invoker is safe because the topics read
-- policy (0030) is world-readable for approved rows, so every caller — signed in
-- or not — computes the identical global ranking.
--
-- Additive: one function + one supporting index. Nothing existing is altered.
-- Idempotent; recreated BODY-ONLY, so no coordinated API deploy is required.
-- ============================================================================

-- Supporting index for the per-locality window below (author's first topic per place).
create index if not exists idx_town_hall_topics_founder
  on town_hall_topics (locality, author_id, created_at)
  where author_id is not null;

-- Founder badges a given profile has earned: the localities where they are among
-- the first p_max_rank community contributors, with their rank and founding date.
create or replace function founder_badges_for_profile(p_profile uuid, p_max_rank integer default 25)
returns table (locality text, locality_label text, rank integer, founded_at timestamptz)
language sql stable security invoker set search_path = public as $$
  with firsts as (
    -- Each author's FIRST approved topic in each locality (one row per author per place).
    select author_id,
           locality,
           min(locality_label) as locality_label,   -- deterministic display label if casing varies
           min(created_at)     as first_at
    from town_hall_topics
    where author_id is not null
      and btrim(locality) <> ''
      and moderation in ('auto_approved', 'approved')
    group by author_id, locality
  ),
  ranked as (
    select author_id, locality, locality_label, first_at,
           row_number() over (partition by locality order by first_at asc, author_id asc) as rnk
    from firsts
  )
  select locality, locality_label, rnk::integer as rank, first_at as founded_at
  from ranked
  where author_id = p_profile
    and rnk <= greatest(1, least(coalesce(p_max_rank, 25), 100))
  order by first_at asc;
$$;

comment on function founder_badges_for_profile(uuid, integer) is
  'Founding-member badges for a profile (0107): the localities where they are among the first '
  'N (default 25) Town Hall topic authors, with rank + founding date. Read-time window over '
  'approved topics — no denormalisation, always consistent across viewers.';

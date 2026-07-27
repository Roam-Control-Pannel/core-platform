-- ============================================================================
-- Roam — 0108_locality_engagement.sql
-- Close the pioneer loop (engagement plan, Layer 4): make sure being first in a
-- town PAYS OFF as it fills in, and give every town an honest founding counter.
--
--   1. notify_locality_newcomer — when a NEW person starts their first Town Hall
--      topic in a locality, ping the town's existing contributors: "Ana just
--      joined you in Darlington". Coalesced via bump_engagement_notification
--      (0103), keyed to a per-locality entity id (md5(locality)::uuid), so each
--      founder gets ONE growing notification ("Ana and 4 others joined you in
--      Darlington"), never a flood. Bounded to the founding phase (2..25 distinct
--      contributors) — past that a town is self-sustaining and the pings stop
--      forever.
--
--   2. locality_founding_stats — the REAL, honest counter behind "N founding
--      members so far · you're #3". Distinct approved-topic authors in a
--      locality + the viewer's founding rank (null if they haven't posted).
--      Read-time, no denormalisation (companion to 0107's founder badges).
--
-- Additive: two functions + one trigger. Nothing existing is altered. Idempotent
-- (body-only recreates); safe to run before or independently of the API deploy.
-- ============================================================================

-- ── 1. "Someone just joined your town" — to the town's existing contributors ──────────────────
-- A newcomer = an author whose FIRST approved topic in this locality is the row that just landed.
-- Fires only during the founding phase so the fan-out is forever bounded.
create or replace function notify_locality_newcomer()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_is_first_here boolean;
  v_contributors  integer;
  v_actor         text;
  v_label         text;
  v_entity        uuid;
  v_href          text;
  r               record;
begin
  -- Only community topics with a real author + locality, and only approved ones can mint a ping.
  if new.author_id is null or btrim(coalesce(new.locality, '')) = '' then return null; end if;
  if new.moderation not in ('auto_approved', 'approved') then return null; end if;

  -- Is this the author's FIRST approved topic in this locality? (this row excluded)
  select not exists (
    select 1 from town_hall_topics
    where locality = new.locality
      and author_id = new.author_id
      and id <> new.id
      and moderation in ('auto_approved', 'approved')
  ) into v_is_first_here;
  if not v_is_first_here then return null; end if;   -- a returning contributor, not a newcomer

  -- Distinct contributors now (including this newcomer). Only ping during the founding phase:
  -- the 2nd..25th arrival. The very first person has no one to notify; past 25, the town stands
  -- on its own and the founders have had their moment.
  select count(distinct author_id) into v_contributors
  from town_hall_topics
  where locality = new.locality
    and author_id is not null
    and moderation in ('auto_approved', 'approved');
  if v_contributors < 2 or v_contributors > 25 then return null; end if;

  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone') into v_actor
    from profiles where id = new.author_id;
  v_label  := coalesce(nullif(btrim(new.locality_label), ''), new.locality);
  v_entity := md5(new.locality)::uuid;               -- stable per-locality entity → coalesced pings
  v_href   := '/town-hall/' || new.locality;

  -- Notify every EARLIER contributor in this locality — the founders watching it grow.
  for r in
    select distinct author_id
    from town_hall_topics
    where locality = new.locality
      and author_id is not null
      and author_id <> new.author_id
      and moderation in ('auto_approved', 'approved')
  loop
    perform bump_engagement_notification(
      r.author_id, 'locality_newcomer', v_entity,
      coalesce(v_actor, 'Someone'), 'joined you in', v_label, v_href);
  end loop;
  return null;
end;
$$;
drop trigger if exists trg_notify_locality_newcomer on town_hall_topics;
create trigger trg_notify_locality_newcomer after insert on town_hall_topics
  for each row execute function notify_locality_newcomer();

-- ── 2. Honest founding stats for a locality ──────────────────────────────────────────────────
-- contributor_count = distinct approved-topic authors; viewer_rank = the viewer's founding
-- position (1 = first ever), or null if they haven't started a topic here. security invoker is
-- safe: the topics read policy (0030) exposes approved rows to everyone, so the count is identical
-- for every caller.
create or replace function locality_founding_stats(p_locality text, p_viewer uuid default null)
returns table (contributor_count integer, viewer_rank integer)
language sql stable security invoker set search_path = public as $$
  with firsts as (
    select author_id, min(created_at) as first_at
    from town_hall_topics
    where locality = p_locality
      and author_id is not null
      and moderation in ('auto_approved', 'approved')
    group by author_id
  ),
  ranked as (
    select author_id, row_number() over (order by first_at asc, author_id asc) as rnk
    from firsts
  )
  select
    (select count(*)::integer from firsts) as contributor_count,
    (select rnk::integer from ranked where author_id = p_viewer) as viewer_rank;
$$;

comment on function locality_founding_stats(text, uuid) is
  'Honest founding counter for a locality (0108): distinct approved-topic authors + the viewer''s '
  'founding rank (null if they have not posted). Read-time; companion to founder_badges (0107).';

-- ── grant hygiene (mirrors 0103/0105): the trigger invokes this regardless of role grants ──
revoke all on function notify_locality_newcomer() from public, anon, authenticated;

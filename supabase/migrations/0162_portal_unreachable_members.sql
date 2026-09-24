-- ============================================================================
-- 0162 — the portal reports how many members CANNOT self-activate (F2G plan 2.4).
--
-- WHY THIS NUMBER EARNS A MIGRATION. Until 2027 there are no membership numbers, so e-mail
-- possession is the only credential there is (§3.2). A roster row with no e-mail address therefore
-- has NO self-serve path at all: it can only be activated by Roam HQ, one at a time, by hand.
--
-- That makes this figure the ceiling on self-serve onboarding, and §3.2 says the portal must report
-- it. Without it the Association reads a healthy funnel — "38 imported, 4 live" — and concludes that
-- members are simply slow, when some of them were never able to start. It is the difference between
-- a conversion problem and a data problem, and only one of those is theirs to fix.
--
-- `members_unreachable` counts rows that are still awaiting activation (imported or invited) and
-- carry no `source_email`. Deliberately NOT every row without an address: a member who is already
-- live got there somehow, and counting them would inflate a number whose whole job is to say how
-- much work is stuck.
--
-- Only `channel_portal_overview` changes. Its gate, its refusal behaviour (no rows rather than a row
-- of zeros) and every other column are exactly as 0157 left them.
--
-- After applying, run `notify pgrst, 'reload schema'`.
-- ============================================================================
-- A `returns table (...)` shape IS the return type, so adding a column cannot be done with
-- `create or replace` — Postgres refuses ("cannot change return type of existing function"). Drop
-- first, which also drops the function's grants; they are restated at the foot of this file.
drop function if exists public.channel_portal_overview(uuid);

create function public.channel_portal_overview(p_channel_id uuid)
returns table (
  members_total      integer,
  members_imported   integer,
  members_invited    integer,
  members_claimed    integer,
  members_live       integer,
  members_lapsed     integer,
  members_removed    integer,
  -- NEW (0162): awaiting activation with no e-mail on file — the ceiling on self-serve onboarding.
  members_unreachable integer,
  -- Non-members that opted their venue into the storefront (venue_channels.role = 'listed', 0154).
  -- Listed, never ranked or badged as members — so they are counted apart from the funnel above.
  listed_non_members integer,
  -- Of the channel's member venues, how many carry a DISPLAYABLE FSA rating ('0'..'5'). A
  -- non-numeric status (AwaitingInspection, Exempt) is not a rating and is not counted as one.
  member_venues      integer,
  member_venues_rated integer,
  jobs_open          integer,
  jobs_total         integer,
  suppliers_approved integer,
  suppliers_pending  integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with allowed as (select public.is_channel_admin(p_channel_id) as ok),
  member_venue as (
    select venue_id from public.f2g_member_venue_ids(p_channel_id)
  ),
  rated as (
    select count(*) filter (where fe.rating_value ~ '^[0-5]$') as n_rated,
           count(*) as n_total
      from member_venue mv
      left join external_refs fer
        on fer.entity_type = 'venue' and fer.entity_id = mv.venue_id and fer.dataset = 'fsa'
      left join fsa_establishments fe on fe.fhrsid = fer.external_id
  ),
  -- Suppliers are NOT channel-scoped in the schema (orgs has no channel_id; creation is gated by
  -- f2g_can_post_supplier). A global count would show this partner another partner's numbers, so
  -- scope it the only honest way: suppliers owned by someone who claimed a membership here.
  sup as (
    select
      count(*) filter (where o.status = 'live' and o.moderation in ('auto_approved', 'approved')) as approved,
      count(*) filter (where o.moderation = 'pending') as pending
      from orgs o
     where o.owner_id in (
       select cm.claimed_by from channel_members cm
        where cm.channel_id = p_channel_id and cm.claimed_by is not null
     )
  )
  select
    (select count(*)::int from channel_members where channel_id = p_channel_id),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'imported'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'invited'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'claimed'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'live'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'lapsed'),
    (select count(*)::int from channel_members where channel_id = p_channel_id and status = 'removed'),
    (select count(*)::int from channel_members
      where channel_id = p_channel_id
        and status in ('imported', 'invited')
        and (source_email is null or btrim(source_email) = '')),
    (select count(*)::int from venue_channels where channel_id = p_channel_id and role = 'listed'),
    (select n_total::int from rated),
    (select n_rated::int from rated),
    (select count(*)::int from job_posts
      where channel_id = p_channel_id and status = 'published'
        and (expires_at is null or expires_at > now())),
    (select count(*)::int from job_posts where channel_id = p_channel_id),
    (select approved::int from sup),
    (select pending::int from sup)
  from allowed where allowed.ok;   -- not an admin of this channel → zero rows, not zeroed counts
$$;

-- Unchanged from 0157, restated because `create or replace` does not carry grants forward when the
-- RETURN TYPE changes — Postgres drops and recreates the function, and the old grants go with it.
revoke all on function public.channel_portal_overview(uuid) from public, anon;
grant execute on function public.channel_portal_overview(uuid) to authenticated;

comment on function public.channel_portal_overview(uuid) is
  'Association portal overview tiles for ONE channel: membership funnel, members awaiting activation '
  'with no e-mail on file (0162 — the ceiling on self-serve onboarding), listed non-members, member '
  'venues and how many carry a displayable FSA rating, jobs, and suppliers owned by this channel''s '
  'members. Gated INTERNALLY on is_channel_admin: a caller without an appointment gets NO ROWS, not '
  'a row of zeros that would read as a quiet week.';

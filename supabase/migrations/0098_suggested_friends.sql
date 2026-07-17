-- 0098_suggested_friends.sql
--
-- "People you may know" for the invite/growth loop (#1). Suggests SECOND-DEGREE connections —
-- accepted friends of your accepted friends — that you aren't already connected to, ranked by how
-- many mutual friends you share. This fills the graph without needing an external invite and
-- compounds the friend-invite loop.
--
-- SECURITY DEFINER because the friendships RLS scopes rows to the two parties, so a caller can't
-- see their friends' friendships directly (the 2nd-degree edges). The function traverses the graph,
-- but auth.uid() inside still resolves to the CALLER, so suggestions are always the caller's own.
-- It returns only public profile fields + an aggregate mutual-friend COUNT (never which friends are
-- mutual — standard PYMK privacy). Excludes: yourself, anyone you already have any edge with
-- (accepted or pending, either direction), and banned profiles.
--
-- Idempotent; safe to run once on the Roam-Core project.

create or replace function suggested_friends(max_results integer default 12)
returns table (
  id           uuid,
  handle       text,
  display_name text,
  avatar_url   text,
  mutual_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with me as (select auth.uid() as uid),
  my_friends as (  -- ids of my accepted friends (edge in either direction)
    select case when f.requester_id = m.uid then f.addressee_id else f.requester_id end as fid
    from friendships f cross join me m
    where f.status = 'accepted' and (f.requester_id = m.uid or f.addressee_id = m.uid)
  ),
  fof as (         -- friends of my friends, tagged with the mutual (via) friend
    select case when f.requester_id = mf.fid then f.addressee_id else f.requester_id end as candidate,
           mf.fid as via
    from friendships f
    join my_friends mf on (f.requester_id = mf.fid or f.addressee_id = mf.fid)
    where f.status = 'accepted'
  ),
  agg as (
    select candidate, count(distinct via)::int as mutual_count
    from fof cross join me m
    where candidate <> m.uid
    group by candidate
  )
  select p.id, p.handle, p.display_name, p.avatar_url, a.mutual_count
  from agg a
  join profiles p on p.id = a.candidate
  cross join me m
  where p.banned_at is null
    and not exists (  -- skip anyone I already have an edge with (accepted OR pending, either way)
      select 1 from friendships x
      where (x.requester_id = m.uid and x.addressee_id = a.candidate)
         or (x.requester_id = a.candidate and x.addressee_id = m.uid)
    )
  order by a.mutual_count desc, p.created_at desc nulls last
  limit greatest(1, least(coalesce(max_results, 12), 50));
$$;

revoke all on function suggested_friends(integer) from public, anon;
grant execute on function suggested_friends(integer) to authenticated;

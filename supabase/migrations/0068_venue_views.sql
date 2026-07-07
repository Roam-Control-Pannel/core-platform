-- 0068_venue_views.sql
--
-- Real profile-view tracking for the business dashboard's "Profile views" stat + performance
-- chart. Privacy-first by construction: ONE ROW PER VENUE PER DAY holding only a counter —
-- no viewer identity, IP, or session is ever stored, so there is nothing to anonymise.
--
-- Writes go through record_venue_view (security definer): the public venue page calls it
-- fire-and-forget on load, incrementing today's bucket. Clients cannot INSERT/UPDATE the
-- table directly (no write policies), so the counter can only ever move +1 per call.
-- Reads are owner-gated by RLS: only the venue's claimed owner can see its view counts.
--
-- Idempotent; safe to run once on the Roam-Core project.

create table if not exists venue_views (
  venue_id uuid not null references venues(id) on delete cascade,
  day date not null,
  views integer not null default 0,
  primary key (venue_id, day)
);

alter table venue_views enable row level security;

-- Owner-only read (the dashboard). No insert/update/delete policies: all writes go through
-- the definer function below.
drop policy if exists venue_views_owner_read on venue_views;
create policy venue_views_owner_read on venue_views
  for select
  using (
    exists (
      select 1 from venues v
      where v.id = venue_views.venue_id
        and v.owner_id = auth.uid()
    )
  );

-- Public increment: +1 on today's bucket for an existing venue. SECURITY DEFINER so anonymous
-- browsers count too (RLS on the table stays closed to direct writes).
create or replace function record_venue_view(p_venue uuid)
returns void
language sql
security definer
set search_path = public
as $$
  insert into venue_views (venue_id, day, views)
  select p_venue, current_date, 1
  where exists (select 1 from venues where id = p_venue)
  on conflict (venue_id, day) do update set views = venue_views.views + 1;
$$;

grant execute on function record_venue_view(uuid) to anon, authenticated;

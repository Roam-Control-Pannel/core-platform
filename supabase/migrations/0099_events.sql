-- ============================================================================
-- Roam — 0099_events.sql
-- What's-on: community-posted local EVENTS. A local starts an event (gig, quiz
-- night, market, meet-up) tagged to a town and, optionally, a venue. Others mark
-- themselves "interested". This is the recurring-reason-to-return surface, and it
-- feeds the SEO town/discover pages with fresh, dated content.
--
-- Modelled on town_hall_topics (0030): community content, locality-scoped, with the
-- same OPTIMISTIC moderation posture (publishes 'auto_approved'; the report-then-act
-- moderation_queue backstop handles abuse) and the same author-owned RLS. The extra
-- shape over a topic is the temporal + spatial dimension: starts_at/ends_at, an
-- optional venue tie, and a geo point so "what's on near me" can ride the GiST index.
--
-- Geo: an event's coordinates come from its venue when one is attached, else from a
-- lat/lng the composer supplies (geocoded place / the browsing centre). A BEFORE
-- trigger derives the geography point (and backfills lat/lng from the venue) so the
-- API only ever inserts plain values — never WKT/GeoJSON through PostgREST.
--
-- RLS: world-readable while approved; author-owned writes (author_id = auth.uid()).
-- interested_count is denormalised and maintained by a SECURITY DEFINER trigger (the
-- interested user isn't the event's author, so the count UPDATE must bypass the
-- author-only write policy) — exactly as town_hall upvotes do.
-- ============================================================================

-- ── events ────────────────────────────────────────────────────────────────────
create table events (
  id               uuid primary key default gen_random_uuid(),
  author_id        uuid references profiles(id) on delete set null,
  locality         text not null,                 -- slug, e.g. 'darlington'
  locality_label   text not null,                 -- display name, e.g. 'Darlington'
  title            text not null,
  description      text,                           -- optional blurb
  category         text,                           -- soft enum, validated in the API
  starts_at        timestamptz not null,
  ends_at          timestamptz,                    -- null = no explicit end
  venue_id         uuid references venues(id) on delete set null,
  location_name    text,                           -- free-text place when no venue is attached
  lat              double precision,               -- supplied by the composer, or backfilled from the venue
  lng              double precision,
  geo              geography(Point, 4326),         -- derived from venue/lat-lng by trigger; powers near-me
  url              text,                           -- optional ticket / info link
  cover_image_url  text,                           -- optional cover (reserved; set in a later slice)
  interested_count integer not null default 0,     -- denormalised; maintained by trigger
  status           text not null default 'published',
  moderation       moderation_status not null default 'auto_approved',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint events_title_len   check (char_length(title) between 1 and 140),
  constraint events_desc_len    check (description is null or char_length(description) <= 8000),
  constraint events_locname_len check (location_name is null or char_length(location_name) <= 200),
  constraint events_url_len     check (url is null or char_length(url) <= 2000),
  constraint events_time_order  check (ends_at is null or ends_at >= starts_at),
  constraint events_status_ok   check (status in ('published', 'cancelled')),
  constraint events_category_ok check (category is null or category in
    ('music','nightlife','food_drink','arts_culture','sports_fitness','community','market_fair','family','learning','other'))
);

-- Primary listing: a town's events, upcoming-first (starts_at forward from now()).
create index idx_events_locality_upcoming on events (locality, starts_at);
-- Global upcoming window (near-me candidate set, cross-town sitemap freshness).
create index idx_events_starts on events (starts_at);
-- Events at a venue (the venue page's "what's on here").
create index idx_events_venue on events (venue_id) where venue_id is not null;
-- Radius search rides the GiST index (mirrors idx_venues_geo).
create index idx_events_geo on events using gist (geo);

create trigger trg_events_updated before update on events
  for each row execute function set_updated_at();

-- ── geo derivation ────────────────────────────────────────────────────────────
-- Attach a venue → the event inherits the venue's coordinates. Otherwise use the
-- lat/lng the composer supplied. Either way the stored geography point is server-
-- derived, so the API inserts only plain numeric columns.
create or replace function set_event_geo()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_geo geography(Point, 4326);
begin
  if new.venue_id is not null then
    select geo into v_geo from venues where id = new.venue_id;
    if v_geo is not null then
      new.geo := v_geo;
      new.lat := st_y(v_geo::geometry);
      new.lng := st_x(v_geo::geometry);
      return new;
    end if;
  end if;

  if new.lat is not null and new.lng is not null then
    new.geo := st_setsrid(st_makepoint(new.lng, new.lat), 4326)::geography;
  else
    new.geo := null;
  end if;
  return new;
end;
$$;

create trigger trg_events_set_geo before insert or update on events
  for each row execute function set_event_geo();

-- ── "interested" (one row per user per event) ─────────────────────────────────
create table event_interest (
  event_id   uuid not null references events(id) on delete cascade,
  user_id    uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (event_id, user_id)
);

-- SECURITY DEFINER: the interested user is not the event author, so this UPDATE to
-- events must bypass the author-only RLS write policy below (same as town_hall votes).
create or replace function events_bump_interest()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update events set interested_count = interested_count + 1 where id = new.event_id;
  elsif tg_op = 'DELETE' then
    update events set interested_count = greatest(0, interested_count - 1) where id = old.event_id;
  end if;
  return null;
end;
$$;

create trigger trg_event_interest_count
  after insert or delete on event_interest
  for each row execute function events_bump_interest();

-- ── RLS ───────────────────────────────────────────────────────────────────────
alter table events         enable row level security;
alter table event_interest enable row level security;

-- Events: world-readable while approved; author writes/edits/removes their own.
create policy events_read on events for select
  using (moderation in ('auto_approved', 'approved'));
create policy events_insert on events for insert
  with check (author_id = auth.uid());
create policy events_update on events for update
  using (author_id = auth.uid());
create policy events_delete on events for delete
  using (author_id = auth.uid());

-- Interest: a user manages only their OWN row (and can read it, to render "interested").
create policy event_interest_read on event_interest for select
  using (user_id = auth.uid());
create policy event_interest_insert on event_interest for insert
  with check (user_id = auth.uid());
create policy event_interest_delete on event_interest for delete
  using (user_id = auth.uid());

-- ── near→far RPC ───────────────────────────────────────────────────────────────
-- UPCOMING events ordered by distance from a (lat,lng) origin, within a radius.
-- SECURITY INVOKER (default): events are public and gated by events_read RLS, so the
-- caller's context applies and anonymous browsing works — no privilege to escalate
-- (same rationale as venues_near, 0005). Only future/ongoing, published, approved rows.
create or replace function events_near(
  lat         double precision,
  lng         double precision,
  radius_m    double precision default 30000,
  max_results integer default 50
)
returns table (
  id           uuid,
  title        text,
  category     text,
  starts_at    timestamptz,
  ends_at      timestamptz,
  locality     text,
  locality_label text,
  venue_id     uuid,
  location_name text,
  interested_count integer,
  distance_m   double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    e.id, e.title, e.category, e.starts_at, e.ends_at, e.locality, e.locality_label,
    e.venue_id, e.location_name, e.interested_count,
    st_distance(e.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography) as distance_m
  from events e
  where e.geo is not null
    and e.status = 'published'
    and e.moderation in ('auto_approved', 'approved')
    and coalesce(e.ends_at, e.starts_at) >= now()
    and st_dwithin(e.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography, greatest(1, coalesce(radius_m, 30000)))
  order by e.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;

comment on function events_near(double precision, double precision, double precision, integer) is
  'Near→far UPCOMING event search from a (lat,lng) origin within radius_m. Orders by the '
  'PostGIS KNN operator (geo <-> origin) against idx_events_geo; returns distance_m for display. '
  'SECURITY INVOKER so events_read RLS (public) applies — anonymous browsing works.';

grant execute on function events_near(double precision, double precision, double precision, integer) to anon, authenticated;

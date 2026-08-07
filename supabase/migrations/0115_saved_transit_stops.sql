-- Saved transit stops — a user's bookmarked Translink stops (Stage 5 · Slice E).
--
-- A saved stop is Roam's OWN data (not Translink's): the opaque EFA stop id plus a snapshot of the
-- name/coords so the "Saved stops" list renders without a live lookup. Private to the owner — unlike
-- follows (public-read), a person's saved stops are visible only to them.
--
-- After applying this migration, regenerate the DB types:  pnpm db:types

create table saved_transit_stops (
  profile_id uuid not null references profiles(id) on delete cascade,
  stop_id    text not null,
  name       text not null,
  lat        double precision not null,
  lng        double precision not null,
  created_at timestamptz not null default now(),
  primary key (profile_id, stop_id)
);

-- The owner's own list, newest first.
create index idx_saved_transit_stops_owner on saved_transit_stops (profile_id, created_at desc);

alter table saved_transit_stops enable row level security;

-- Private: a person may only read/write their OWN saved stops.
create policy saved_transit_stops_read on saved_transit_stops
  for select using (profile_id = auth.uid());
create policy saved_transit_stops_insert on saved_transit_stops
  for insert with check (profile_id = auth.uid());
create policy saved_transit_stops_delete on saved_transit_stops
  for delete using (profile_id = auth.uid());

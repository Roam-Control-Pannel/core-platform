-- 0085_venue_reviews.sql
--
-- Native Roam reviews: first-party ratings + written reviews on a venue, owned by us (not
-- licensed from Google). One review per person per venue (editable), 1–5 stars + optional text.
-- This is the seam by which Roam's own reviews eventually SUPERSEDE the Google rating: the venue
-- profile prefers the Roam score once a venue has enough Roam reviews (a client threshold), and
-- the denormalised rollup below makes the Roam aggregate available cheaply to every surface that
-- today reads venues.rating (cards, suggestions) when we choose to switch them over.
--
-- Model mirrors the profile wall (0031): author_id = auth.uid() writes/edits/removes their own;
-- world-readable while approved (optimistic 'auto_approved' + the report-then-act backstop). The
-- venue's Roam rollup is maintained by a SECURITY DEFINER trigger because the reviewer is not the
-- venue owner, so the venues UPDATE must bypass the owner-only write policy — same reason the
-- profile-post count triggers are DEFINER.
--
-- Re-appliable only on a clean DB (create table has no `if not exists`), like the other feature
-- migrations; the venues rollup columns DO use `if not exists` (venues is a long-lived table).

-- ── the venue's Roam rollup (denormalised; maintained by the trigger below) ───────────────────
alter table venues
  add column if not exists roam_rating       numeric(2,1),
  add column if not exists roam_rating_count integer not null default 0;

comment on column venues.roam_rating is
  'Average of this venue''s approved Roam reviews (1.0–5.0), NULL when it has none. Maintained by '
  'trg_venue_reviews_rollup. The venue profile shows this in place of the Google rating once '
  'roam_rating_count crosses the client threshold — the path to Roam reviews superseding Google.';

-- ── reviews (one per author per venue; editable) ─────────────────────────────────────────────
create table venue_reviews (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id)   on delete cascade,
  author_id   uuid not null references profiles(id) on delete cascade,
  rating      integer not null,
  body        text,
  moderation  moderation_status not null default 'auto_approved',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint venue_reviews_rating_range   check (rating between 1 and 5),
  constraint venue_reviews_body_len       check (body is null or char_length(body) <= 4000),
  constraint venue_reviews_one_per_author unique (venue_id, author_id)
);
create index idx_venue_reviews_venue on venue_reviews (venue_id, created_at desc);
create trigger trg_venue_reviews_updated before update on venue_reviews
  for each row execute function set_updated_at();

-- ── rollup maintenance (SECURITY DEFINER bypasses the owner-only venues write policy) ─────────
-- Recompute the affected venue's average + count from its approved reviews on any change. A full
-- recompute (not a delta) is correct through edits, where a review's rating changes in place.
create or replace function venue_reviews_refresh_rollup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := coalesce(new.venue_id, old.venue_id);
begin
  update venues v
  set roam_rating       = sub.avg_rating,
      roam_rating_count = sub.cnt
  from (
    select round(avg(rating)::numeric, 1) as avg_rating, count(*)::int as cnt
    from venue_reviews
    where venue_id = v_id and moderation in ('auto_approved', 'approved')
  ) sub
  where v.id = v_id;
  return null;
end;
$$;

create trigger trg_venue_reviews_rollup
  after insert or update or delete on venue_reviews
  for each row execute function venue_reviews_refresh_rollup();

-- ── read RPC: reviews with their author, newest first (SECURITY INVOKER — honours read RLS) ───
create or replace function venue_reviews_list(
  venue_id_param uuid,
  max_results    integer default 20,
  page_offset    integer default 0
)
returns table (
  id            uuid,
  rating        integer,
  body          text,
  created_at    timestamptz,
  updated_at    timestamptz,
  author_id     uuid,
  author_name   text,
  author_handle text,
  author_avatar text
)
language sql
stable
security invoker
set search_path = public
as $$
  select r.id, r.rating, r.body, r.created_at, r.updated_at,
         r.author_id, p.display_name, p.handle, p.avatar_url
  from venue_reviews r
  join profiles p on p.id = r.author_id
  where r.venue_id = venue_id_param
    and r.moderation in ('auto_approved', 'approved')
  order by r.created_at desc
  limit greatest(1, least(coalesce(max_results, 20), 50))
  offset greatest(0, coalesce(page_offset, 0));
$$;

grant execute on function venue_reviews_list(uuid, integer, integer) to anon, authenticated;

-- ── RLS ──────────────────────────────────────────────────────────────────────────────────────
alter table venue_reviews enable row level security;

-- World-readable while approved; the author writes/edits/removes only their own.
create policy venue_reviews_read on venue_reviews for select
  using (moderation in ('auto_approved', 'approved'));
create policy venue_reviews_insert on venue_reviews for insert
  with check (author_id = auth.uid());
create policy venue_reviews_update on venue_reviews for update
  using (author_id = auth.uid());
create policy venue_reviews_delete on venue_reviews for delete
  using (author_id = auth.uid());

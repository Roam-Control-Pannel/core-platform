-- 0019_create_venue_photos.sql
-- Slice 5: venue image library — schema + RLS + provenance split.
--
-- Provenance model:
--   source = 'google_places'  → pointer + attribution, NEVER owned bytes.
--                               Written by the ingest path (service_role) only.
--                               Immutable from the owner side (same philosophy as
--                               0018's owner-null hours guard: scraped facts frozen).
--   source = 'owner_upload'    → real Supabase Storage objects we own.
--                               Written/edited/deleted by the venue owner via RLS
--                               (venues.owner_id = auth.uid()). Owner content.
--
-- Render priority (enforced in @roam/core selectHero/galleryOrder): owner > places.
--
-- Billing note: the ingest field mask gains `places.photos`, a billable Places (New)
-- field class (same caveat as `regularOpeningHours` in Slice 4 / 0018). Contained by
-- the existing 2,000/day per-endpoint quota cap.
--
-- Re-appliable: drops dependent objects then recreates. Safe to re-run.

drop table if exists venue_photos cascade;

create table venue_photos (
  id                uuid primary key default gen_random_uuid(),
  venue_id          uuid not null references venues(id) on delete cascade,
  source            text not null check (source in ('google_places','owner_upload')),
  position          int  not null default 0,
  is_cover          boolean not null default false,

  -- google_places rows: pointer + provenance, never owned bytes
  places_photo_ref  text,
  attribution       jsonb,

  -- owner_upload rows: real Storage objects we own
  storage_path      text,
  alt_text          text,

  width             int,
  height            int,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- a google_places row must carry a ref and no storage path
  constraint places_shape check (
    source <> 'google_places'
    or (places_photo_ref is not null and storage_path is null)
  ),
  -- an owner_upload row must carry a storage path and no places ref
  constraint owner_shape check (
    source <> 'owner_upload'
    or (storage_path is not null and places_photo_ref is null)
  )
);

-- gallery render query: photos for a venue, in display order
create index idx_venue_photos_venue_position
  on venue_photos (venue_id, position);

-- fast hero lookup
create index idx_venue_photos_cover
  on venue_photos (venue_id) where is_cover;

-- at most one cover per venue (DB refuses a second, not app logic)
create unique index venue_photos_one_cover
  on venue_photos (venue_id) where is_cover;

-- idempotent Places ingest: re-fetch upserts, never appends duplicates.
-- Partial — owner rows have no ref, so the constraint only binds Places rows.
create unique index venue_photos_places_ref
  on venue_photos (venue_id, places_photo_ref)
  where places_photo_ref is not null;

-- keep updated_at honest on owner edits (reorder / cover / alt_text)
create or replace function set_venue_photos_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger trg_venue_photos_updated_at
  before update on venue_photos
  for each row execute function set_venue_photos_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- RLS: public read; service_role writes Places rows; owner writes own rows only.
-- ────────────────────────────────────────────────────────────────────────────
alter table venue_photos enable row level security;

-- 1. public read — galleries are a public discovery surface (same as hours)
create policy venue_photos_select_public
  on venue_photos for select
  using (true);

-- 2. owner_upload INSERT — owner-gated.
--    The write path MUST .select() the affected row and return ok:false on zero
--    rows (same silent-zero-row class as the 0014 follows/meetups RLS bug).
create policy venue_photos_owner_insert
  on venue_photos for insert
  to authenticated
  with check (
    source = 'owner_upload'
    and exists (
      select 1 from venues v
      where v.id = venue_id and v.owner_id = auth.uid()
    )
  );

-- 3. owner_upload UPDATE — owner-gated, scoped to owner rows.
--    An owner can reorder / set cover / edit alt_text on THEIR OWN media,
--    and can NEVER touch a google_places row (provenance immutable owner-side).
create policy venue_photos_owner_update
  on venue_photos for update
  to authenticated
  using (
    source = 'owner_upload'
    and exists (
      select 1 from venues v
      where v.id = venue_id and v.owner_id = auth.uid()
    )
  )
  with check (
    source = 'owner_upload'
    and exists (
      select 1 from venues v
      where v.id = venue_id and v.owner_id = auth.uid()
    )
  );

-- 4. owner_upload DELETE — owner-gated, scoped to owner rows.
create policy venue_photos_owner_delete
  on venue_photos for delete
  to authenticated
  using (
    source = 'owner_upload'
    and exists (
      select 1 from venues v
      where v.id = venue_id and v.owner_id = auth.uid()
    )
  );

-- NOTE on google_places writes: no policy grants insert/update/delete on
-- google_places rows to `authenticated` or `anon`. The ingest path uses the
-- service_role key, which bypasses RLS. This is deliberate — it is the ONLY
-- writer of google_places rows, which is what keeps scraped-content provenance
-- honest (no client can launder content in under a google_places label).

-- ============================================================================
-- Roam — 0020_upsert_venue_photos.sql
-- Batch upsert of google_places photo rows into venue_photos, REPLACE-ALL per venue.
--
-- COMPANION to upsert_place_venues (0016/0018): venue supply writes the venue row;
-- THIS writes that venue's scraped photo rows. Same posture exactly — SECURITY DEFINER,
-- service_role-only, JSONB-array batch, reached only via the api internalProcedure.
--
-- REPLACE-ALL (not additive): a Places photo ref is a pointer to Google's CURRENT
-- content. On re-ingest Google may drop/rotate/add photos; an additive upsert would
-- accumulate dead refs forever. So per venue we DELETE the existing google_places rows
-- then insert the fresh set — our scraped rows always mirror the last fetch, never a
-- historical accretion. The staleness window gates WHEN we re-fetch; replace-all makes
-- each re-fetch authoritative.
--
-- OWNER CONTENT IS NEVER TOUCHED (two layers):
--   1. the api orchestration excludes CLAIMED venues from the payload entirely, and
--   2. every statement here is scoped to `source = 'google_places'` AND guarded by
--      `venues.owner_id is null` — so even a claimed venue that somehow reached the
--      payload has its (and its owner's) photos left frozen. Same guard discipline as
--      0018's claimed-hours freeze.
--
-- PAYLOAD SHAPE (one element per venue, photos already mapped by @roam/core placePhotos):
--   [ { "venue_id": "<uuid>",
--       "photos": [ { "places_photo_ref": "...", "attribution": [...],
--                     "width": 4032, "height": 3024 }, ... ] }, ... ]
-- A venue with an empty photos[] still gets its stale google_places rows cleared
-- (correct: Places now returns no photos for it).
--
-- Drop-first: the function takes jsonb and returns a scalar count; re-appliable on reset.
-- ============================================================================

drop function if exists upsert_venue_photos(jsonb);

create or replace function upsert_venue_photos(payload jsonb)
returns integer                      -- total google_places photo rows inserted
language plpgsql
security definer
set search_path = public
as $$
declare
  elem        jsonb;
  photo       jsonb;
  v_id        uuid;
  v_unclaimed boolean;
  inserted    integer := 0;
begin
  if jsonb_typeof(payload) is distinct from 'array' then
    raise exception 'upsert_venue_photos expects a JSONB array, got %', jsonb_typeof(payload)
      using errcode = '22023';
  end if;

  for elem in select * from jsonb_array_elements(payload)
  loop
    v_id := (elem->>'venue_id')::uuid;
    if v_id is null then
      continue;
    end if;

    -- Guard: only operate on an UNCLAIMED venue (owner content frozen). If the venue is
    -- claimed or absent, skip it entirely — no delete, no insert.
    select (v.owner_id is null) into v_unclaimed
    from venues v
    where v.id = v_id;

    if v_unclaimed is distinct from true then
      continue;
    end if;

    -- REPLACE-ALL, scoped to scraped rows: clear this venue's google_places photos.
    delete from venue_photos
    where venue_id = v_id
      and source = 'google_places';

    -- Insert the fresh set, preserving Places' order via the array index as `position`.
    if jsonb_typeof(elem->'photos') = 'array' then
      for photo in select * from jsonb_array_elements(elem->'photos')
      loop
        if (photo->>'places_photo_ref') is null then
          continue;
        end if;
        insert into venue_photos (
          venue_id, source, position, is_cover,
          places_photo_ref, attribution, width, height
        )
        values (
          v_id,
          'google_places',
          coalesce((photo->>'position')::int, 0),
          false,
          photo->>'places_photo_ref',
          coalesce(photo->'attribution', '[]'::jsonb),
          case when (photo->>'width')  is not null then (photo->>'width')::int  end,
          case when (photo->>'height') is not null then (photo->>'height')::int end
        );
        inserted := inserted + 1;
      end loop;
    end if;
  end loop;

  return inserted;
end;
$$;

comment on function upsert_venue_photos(jsonb) is
  'Batch REPLACE-ALL of google_places photo rows in venue_photos from a JSONB array '
  '(one element per venue: { venue_id, photos[] }). Per UNCLAIMED venue, deletes the '
  'existing source=google_places rows then inserts the fresh mapped set; owner_upload '
  'rows and CLAIMED venues are never touched (owner_id is null guard). Returns the count '
  'of photo rows inserted. SECURITY DEFINER — reached only via the api internalProcedure.';

revoke all on function upsert_venue_photos(jsonb) from public;
grant execute on function upsert_venue_photos(jsonb) to service_role;

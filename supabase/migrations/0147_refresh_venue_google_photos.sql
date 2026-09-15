-- ============================================================================
-- Roam — 0147_refresh_venue_google_photos.sql
-- Refresh a venue's EXPIRED Google photo references — the policy-enforcing sibling of
-- upsert_venue_photos (0020).
--
-- WHY: Places (New) photo references EXPIRE. A venue ingested months ago still holds
-- venue_photos rows, but Google now answers its refs with
--   400 INVALID_ARGUMENT "The photo resource in the request is invalid. Please retrieve
--   it from Places API endpoints."
-- so every cover on every surface falls back to the placeholder at once. The fix is to
-- re-fetch fresh refs by place id (one Place Details call) and REPLACE the stale rows.
--
-- 0020's upsert cannot do this for CLAIMED venues: it skips them outright (owner content
-- frozen), which is right for a first-time SCRAPE but leaves a claimed venue whose refs
-- expired blank forever. This function implements the agreed refresh policy instead:
--
--   1. UNCLAIMED venue                         → replace-all its google_places rows.
--   2. CLAIMED venue, NO owner uploads          → replace-all its EXISTING google_places
--                                                 rows. NEVER ADDS Google photos to a
--                                                 claimed venue that had none (so a
--                                                 refresh can never introduce scraped
--                                                 content onto an owner's venue).
--   3. Venue WITH owner_upload rows (any claim  → UNTOUCHED. The owner's library is
--      state)                                    canonical; stale Google rows are left
--                                                 alone, never deleted, never refreshed.
--
-- Owner-content invariants (both layers, as in 0020): every write is scoped to
-- `source = 'google_places'`; owner_upload rows are never touched by any statement here.
--
-- google_photos_refreshed_at: stamped on venues when a refresh actually ran. The read-time
-- self-heal uses it as a restart-safe, multi-replica-safe negative cache (do not re-heal
-- a venue refreshed within the last hour); a future rolling-refresh cron can order by it.
-- Setting it from this SECURITY DEFINER function is safe against the 0131 column guard,
-- which fires only for the direct client roles (authenticated/anon).
--
-- PAYLOAD SHAPE — identical to upsert_venue_photos (one element per venue, photos already
-- mapped by @roam/core placePhotos and positioned):
--   [ { "venue_id": "<uuid>",
--       "photos": [ { "places_photo_ref": "...", "attribution": [...],
--                     "width": 4032, "height": 3024, "position": 0 }, ... ] }, ... ]
-- An eligible venue with an empty photos[] has its stale rows cleared (Google now returns
-- no photos for it — correct, mirrors 0020's replace-all).
--
-- Returns the total google_places rows inserted. SECURITY DEFINER, service_role-only,
-- reached only via the api (self-heal) and the refresh runner. Idempotent; re-appliable.
-- ============================================================================

alter table venues add column if not exists google_photos_refreshed_at timestamptz;

comment on column venues.google_photos_refreshed_at is
  'When this venue''s google_places photo refs were last refreshed by '
  'refresh_venue_google_photos (0147). Null = never refreshed since ingest. Read-time '
  'self-heal negative cache + rolling-refresh ordering key.';

drop function if exists refresh_venue_google_photos(jsonb);

create or replace function refresh_venue_google_photos(payload jsonb)
returns integer                      -- total google_places photo rows inserted
language plpgsql
security definer
set search_path = public
as $$
declare
  elem              jsonb;
  photo             jsonb;
  v_id              uuid;
  v_claimed         boolean;
  has_owner_uploads boolean;
  has_google_rows   boolean;
  inserted          integer := 0;
begin
  if jsonb_typeof(payload) is distinct from 'array' then
    raise exception 'refresh_venue_google_photos expects a JSONB array, got %', jsonb_typeof(payload)
      using errcode = '22023';
  end if;

  for elem in select * from jsonb_array_elements(payload)
  loop
    v_id := (elem->>'venue_id')::uuid;
    if v_id is null then
      continue;
    end if;

    -- Absent venue → nothing to do.
    select (v.owner_id is not null) into v_claimed
    from venues v
    where v.id = v_id;
    if v_claimed is null then
      continue;
    end if;

    select exists (select 1 from venue_photos p where p.venue_id = v_id and p.source = 'owner_upload')
      into has_owner_uploads;
    select exists (select 1 from venue_photos p where p.venue_id = v_id and p.source = 'google_places')
      into has_google_rows;

    -- Rule 3: an owner library is canonical — leave the venue entirely alone.
    if has_owner_uploads then
      continue;
    end if;

    -- Rule 2 (never-add): a claimed venue with no Google rows gains none.
    if v_claimed and not has_google_rows then
      continue;
    end if;

    -- Rules 1 & 2: REPLACE-ALL, scoped to scraped rows only.
    delete from venue_photos
    where venue_id = v_id
      and source = 'google_places';

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

    update venues set google_photos_refreshed_at = now() where id = v_id;
  end loop;

  return inserted;
end;
$$;

comment on function refresh_venue_google_photos(jsonb) is
  'Refresh EXPIRED google_places photo refs from a JSONB array (one element per venue: '
  '{ venue_id, photos[] }). Policy: unclaimed → replace-all; claimed with NO owner uploads → '
  'replace-all its EXISTING Google rows (never adds Google photos to a claimed venue that had '
  'none); any venue with owner_upload rows → untouched. Stamps venues.google_photos_refreshed_at '
  'on a real refresh. Returns rows inserted. SECURITY DEFINER — service_role only.';

revoke all on function refresh_venue_google_photos(jsonb) from public;
grant execute on function refresh_venue_google_photos(jsonb) to service_role;

-- ── Which venues can be refreshed, oldest-first ──────────────────────────────────────────
-- The target list for the bulk runner (scripts/refresh-photos) and any future rolling-refresh
-- cron: Google-sourced venues that HAVE google_places rows and NO owner uploads (a rule-3 venue
-- is never listed, so no Place Details call is ever spent on one), ordered never-refreshed
-- first then least-recently refreshed — so a capped run always touches the stalest venues.
-- p_venue_id narrows to one venue (targeted repair). Service-side read; service_role only.
drop function if exists list_google_photo_venues(integer, uuid);

create or replace function list_google_photo_venues(p_limit integer default 500, p_venue_id uuid default null)
returns table (id uuid, name text, source_ref text, google_photos_refreshed_at timestamptz)
language sql stable security definer set search_path = public as $$
  select v.id, v.name, v.source_ref, v.google_photos_refreshed_at
  from venues v
  where v.source = 'google_places'
    and v.source_ref is not null
    and (p_venue_id is null or v.id = p_venue_id)
    and exists (select 1 from venue_photos p where p.venue_id = v.id and p.source = 'google_places')
    and not exists (select 1 from venue_photos p where p.venue_id = v.id and p.source = 'owner_upload')
  order by v.google_photos_refreshed_at asc nulls first, v.id
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

comment on function list_google_photo_venues(integer, uuid) is
  'Refreshable Google-photo venues, never-refreshed first then least-recently refreshed: '
  'source=google_places with a source_ref, having google_places photo rows and NO owner_upload '
  'rows (owner-library venues are never listed). p_venue_id targets one venue. Feeds '
  'scripts/refresh-photos and a rolling-refresh cron. SECURITY DEFINER — service_role only.';

revoke all on function list_google_photo_venues(integer, uuid) from public;
grant execute on function list_google_photo_venues(integer, uuid) to service_role;

-- ============================================================================
-- Roam — 0016_upsert_place_venues.sql
-- Batch upsert for on-demand Google Places (New) ingestion.
--
-- WHY an RPC (not a PostgREST insert from app code): the venue location is a PostGIS
-- geography(Point,4326). The point must be built in the DB (st_makepoint), the dedup
-- must ride the unique(source, source_ref) constraint, and fetched_at must be stamped
-- atomically with the write. Keeping all three in one SQL function mirrors venues_near
-- and request_venue_claim — geo + write-semantics live in the database, not smeared
-- across TypeScript. The app passes a JSONB array; the DB does the rest in one round trip.
--
-- WHY security definer: there is deliberately NO insert policy on venues, and the only
-- update policy (venues_owner_update) is the owner of a CLAIMED venue. So no user/anon
-- client can create or refresh a base-layer venue — by design, venue supply is a
-- server-to-server action. This function is the sanctioned writer; the api layer reaches
-- it ONLY through an internalProcedure (x-internal-call gate). search_path is locked.
--
-- THE TWO-LAYER INVARIANT, enforced here:
--   - New Places venue           -> insert as 'unclaimed', source 'google_places'.
--   - Re-fetch, still unclaimed  -> refresh name/geo/category/categories/rating/address
--                                   + bump fetched_at. Places owns unclaimed venues and
--                                   keeps them current ("looks new, not dead").
--   - Re-fetch, already CLAIMED  -> the `where venues.owner_id is null` guard makes the
--                                   UPDATE match no row: the owner's enrichment is frozen
--                                   against Places. Claiming enriches; re-fetch never
--                                   un-enriches. (Same row — unique constraint honoured —
--                                   never a duplicate.)
--
-- Geo axis order: st_makepoint(lng, lat) — LONGITUDE FIRST. This matches venues_near and
-- the seed; getting it backwards silently places venues in the wrong hemisphere.
-- ============================================================================

-- Drop first: this function's OUT-parameter row type is part of its identity, so a
-- `create or replace` that changes the OUT columns fails ("cannot change return type").
-- Dropping makes the migration re-appliable cleanly on a fresh reset or signature change.
drop function if exists upsert_place_venues(jsonb);

create or replace function upsert_place_venues(places jsonb)
returns table (
  out_id          uuid,
  out_source_ref  text,
  out_was_claimed boolean   -- true => row exists but is claimed, so it was left untouched
)
language plpgsql
security definer
set search_path = public
as $$
declare
  elem jsonb;
begin
  -- Validate shape early: a non-array argument is a programming error, not data.
  if jsonb_typeof(places) is distinct from 'array' then
    raise exception 'upsert_place_venues expects a JSONB array, got %', jsonb_typeof(places)
      using errcode = '22023';
  end if;

  for elem in select * from jsonb_array_elements(places)
  loop
    -- Required identity + fields. Missing name/coords should never reach here (the pure
    -- placeToVenueRow drops them), but guard anyway: skip malformed elements silently.
    if (elem->>'source_ref') is null
       or (elem->>'name') is null
       or (elem->>'lat') is null
       or (elem->>'lng') is null then
      continue;
    end if;

    return query
    insert into venues (
      source, source_ref, name, geo, category, categories, rating, address,
      source_attribution, status, fetched_at
    )
    values (
      'google_places',
      elem->>'source_ref',
      elem->>'name',
      st_setsrid(
        st_makepoint((elem->>'lng')::float8, (elem->>'lat')::float8),
        4326
      )::geography,
      elem->>'category',
      coalesce(
        (select array_agg(value::text) from jsonb_array_elements_text(elem->'categories')),
        '{}'::text[]
      ),
      case when elem ? 'rating' and (elem->>'rating') is not null
           then (elem->>'rating')::numeric(2,1) end,
      elem->>'address',
      coalesce(elem->>'source_attribution', 'Information from public sources'),
      'unclaimed',
      now()
    )
    on conflict (source, source_ref) do update
      set name       = excluded.name,
          geo        = excluded.geo,
          category   = excluded.category,
          categories = excluded.categories,
          rating     = excluded.rating,
          address    = excluded.address,
          fetched_at = now()
      where venues.owner_id is null            -- freeze claimed venues against Places
    returning venues.id, venues.source_ref, false;

    -- If the row existed AND was claimed, the guarded UPDATE matched nothing, so the
    -- INSERT ... ON CONFLICT returned no row. Surface it as was_claimed=true so the
    -- caller can report "left N claimed venues untouched" honestly.
    if not found then
      return query
      select v.id, v.source_ref, true
      from venues v
      where v.source = 'google_places'
        and v.source_ref = elem->>'source_ref';
    end if;
  end loop;
end;
$$;

comment on function upsert_place_venues(jsonb) is
  'Batch upsert of Google Places venues from a JSONB array. Inserts new unclaimed '
  'venues and refreshes still-unclaimed ones (bumping fetched_at); leaves CLAIMED '
  'venues untouched (owner_id is null guard). Builds geo lng-first. SECURITY DEFINER — '
  'reached only via the api internalProcedure; there is no user insert path on venues.';

-- Execute grant: service_role only. This is a server-to-server writer; no anon/auth grant.
revoke all on function upsert_place_venues(jsonb) from public;
grant execute on function upsert_place_venues(jsonb) to service_role;


-- ============================================================================
-- count_fresh_places_venues — the DB-first freshness check for on-demand ingest.
--
-- Answers: "do we already have fresh Google Places venues of this category within
-- `radius_m` of (lat,lng)?" If the count is > 0 the api skips the paid searchNearby
-- call (the cost control). Proximity rides st_dwithin against the GiST geo index;
-- category and source are filtered too.
--
-- THE STALENESS WINDOW IS BAKED IN (30 days), NOT a parameter. Reason: it is a fixed
-- policy constant, not something a caller varies per request, AND passing an `interval`
-- across PostgREST's named-arg RPC resolution fails — PostgREST won't coerce a JSON
-- string into `interval` for overload matching, so the function appears "not found".
-- Keeping the interval internal means the caller passes only numbers + a text category,
-- which PostgREST resolves cleanly. (30 days = the Places New ToS content-cache ceiling.)
--
-- SECURITY INVOKER: venues are world-readable (venues_read using true), so this runs
-- correctly as the caller. No privilege needed — it only reads public rows.
-- Geo axis: st_makepoint(lng, lat) — longitude first, matching venues_near and 0016.
-- ============================================================================

-- Drop the old 5-arg signature (with max_age) if present — a signature change can't be
-- done via create-or-replace, and the stale overload would otherwise linger.
drop function if exists count_fresh_places_venues(double precision, double precision, double precision, text, interval);
drop function if exists count_fresh_places_venues(double precision, double precision, double precision, text);

create or replace function count_fresh_places_venues(
  lat        double precision,
  lng        double precision,
  radius_m   double precision,
  cat        text
)
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::int
  from venues v
  where v.source = 'google_places'
    and v.category = cat
    and v.fetched_at is not null
    and v.fetched_at > now() - interval '30 days'
    and st_dwithin(
          v.geo,
          st_setsrid(st_makepoint(lng, lat), 4326)::geography,
          radius_m
        );
$$;

comment on function count_fresh_places_venues(double precision, double precision, double precision, text) is
  'Count of fresh (fetched_at within 30 days) google_places venues of category `cat` '
  'within radius_m of (lat,lng). Drives the on-demand ingest freshness skip. The 30-day '
  'window is baked in (Places New ToS ceiling) — not a param, to keep PostgREST RPC '
  'resolution clean. SECURITY INVOKER; reads world-readable venues. Geo built lng-first.';

grant execute on function count_fresh_places_venues(double precision, double precision, double precision, text) to anon, authenticated, service_role;

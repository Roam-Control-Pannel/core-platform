-- ============================================================================
-- Roam — 0018_upsert_place_venues_opening_times.sql
-- Redefine upsert_place_venues to carry Places opening hours onto the venue row.
--
-- WHY a redefine and not an ALTER: the `opening_times` COLUMN already exists (0001).
-- This migration changes only the WRITER — the upsert function — so on-demand ingestion
-- now persists the hours the field mask newly requests (places.regularOpeningHours,
-- mapped by the pure @roam/core placeOpeningTimes -> our minimal OpeningTimes shape:
-- { weekdayDescriptions: string[], source: "google_places" }).
--
-- WHAT CHANGES vs 0016 (everything else is byte-identical):
--   - insert column list gains `opening_times`
--   - insert value is `(elem->'opening_times')` — jsonb passthrough. The pure mapper
--     emits `null` when Places returned no hours; the JSON payload then carries
--     "opening_times": null and the arrow yields SQL NULL. Clean round-trip, no coercion.
--   - on-conflict `set` gains `opening_times = excluded.opening_times`, STILL under the
--     existing `where venues.owner_id is null` guard — so a CLAIMED venue's hours are
--     frozen against Places exactly like its name/geo/rating already are. Re-fetch never
--     overwrites owner truth.
--
-- Drop-first for the same reason as 0016: the OUT-row type is part of the function's
-- identity, so this stays cleanly re-appliable on a fresh reset.
-- ============================================================================

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
  if jsonb_typeof(places) is distinct from 'array' then
    raise exception 'upsert_place_venues expects a JSONB array, got %', jsonb_typeof(places)
      using errcode = '22023';
  end if;

  for elem in select * from jsonb_array_elements(places)
  loop
    if (elem->>'source_ref') is null
       or (elem->>'name') is null
       or (elem->>'lat') is null
       or (elem->>'lng') is null then
      continue;
    end if;

    return query
    insert into venues (
      source, source_ref, name, geo, category, categories, rating, address,
      source_attribution, status, fetched_at, opening_times
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
      now(),
      elem->'opening_times'
    )
    on conflict (source, source_ref) do update
      set name          = excluded.name,
          geo           = excluded.geo,
          category      = excluded.category,
          categories    = excluded.categories,
          rating        = excluded.rating,
          address       = excluded.address,
          opening_times = excluded.opening_times,
          fetched_at    = now()
      where venues.owner_id is null            -- freeze claimed venues against Places
    returning venues.id, venues.source_ref, false;

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
  'venues and refreshes still-unclaimed ones (name/geo/category/categories/rating/'
  'address/opening_times, bumping fetched_at); leaves CLAIMED venues untouched '
  '(owner_id is null guard). Builds geo lng-first. SECURITY DEFINER — reached only via '
  'the api internalProcedure; there is no user insert path on venues.';

revoke all on function upsert_place_venues(jsonb) from public;
grant execute on function upsert_place_venues(jsonb) to service_role;

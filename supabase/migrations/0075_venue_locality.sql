-- 0075_venue_locality.sql
--
-- Teach the Places ingest to write venues.locality — the venue's town name.
--
-- venues.locality has existed since 0001 ("powers the locality tile") but no ingest path
-- ever wrote it: the deferred "locality anchoring" slice. Meanwhile everything town-scoped
-- reads it — the Town Hall hub's Places strip (venues.byLocality), the hub coverage stats
-- (venues.localityStats), the Market's town feed (market.browseProducts), hub indexability
-- and the sitemap's venue towns (seo.localities). This revision of upsert_place_venues
-- accepts `locality` in each JSONB element (core placeToVenueRow now supplies it from
-- Places' postal_town/locality address component) and writes it on insert AND refresh.
--
-- Same contract as 0026's revision otherwise: claimed venues stay frozen against Places.

create or replace function upsert_place_venues(places jsonb)
returns table (
  out_id          uuid,
  out_source_ref  text,
  out_was_claimed boolean
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
      source, source_ref, name, geo, category, categories, rating, address, locality,
      source_attribution, status, fetched_at, opening_times,
      rating_count, price_level, primary_type_label, business_status
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
      nullif(trim(elem->>'locality'), ''),
      coalesce(elem->>'source_attribution', 'Information from public sources'),
      'unclaimed',
      now(),
      elem->'opening_times',
      case when elem ? 'rating_count' and (elem->>'rating_count') is not null
           then (elem->>'rating_count')::integer end,
      elem->>'price_level',
      elem->>'primary_type_label',
      elem->>'business_status'
    )
    on conflict (source, source_ref) do update
      set name               = excluded.name,
          geo                = excluded.geo,
          category           = excluded.category,
          categories         = excluded.categories,
          rating             = excluded.rating,
          address            = excluded.address,
          -- Never blank a locality we already know: a refresh missing address components
          -- keeps the existing value rather than regressing to NULL.
          locality           = coalesce(excluded.locality, venues.locality),
          opening_times      = excluded.opening_times,
          rating_count       = excluded.rating_count,
          price_level        = excluded.price_level,
          primary_type_label = excluded.primary_type_label,
          business_status    = excluded.business_status,
          fetched_at         = now()
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

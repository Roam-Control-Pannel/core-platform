-- ============================================================================
-- Roam — 0106_venue_search_tokens.sql
-- Fix venue name search: it only ever matched the WHOLE query as one substring
-- against v.name, so "the duke of york, belfast" (sanitiser turns the comma into
-- a space → "the duke of york belfast") never matched the venue actually named
-- "Duke of York" — the name contains neither "the" nor "belfast".
--
-- The fix: tokenise the query and require every meaningful word (dropping short
-- articles/stopwords) to appear SOMEWHERE in the venue's name + locality + region
-- + category. So "duke" + "york" + "belfast" all hit (name has duke/york, the
-- locality has belfast) and the venue surfaces. A word the user adds that matches
-- nothing (e.g. a wrong town) correctly excludes the venue.
--
-- bool_and over the token set returns NULL for an all-stopword query (e.g. just
-- "the"), which the WHERE treats as no-match — so a meaningless query returns
-- nothing rather than every venue.
--
-- Deploy-safety: recreated BODY-ONLY with the IDENTICAL signature — no coordinated
-- API deploy; behaviour changes the moment this runs. Idempotent.
-- ============================================================================

create or replace function venues_search_by_name(q text, origin_lat double precision, origin_lng double precision, max_results integer default 20)
returns table (id uuid, name text, owner_id uuid, status venue_status, category text, categories text[],
  rating numeric(2,1), rating_count integer, price_level text, primary_type_label text, business_status text,
  distance_m double precision, lat_out double precision, lng_out double precision, cover_photo_id uuid)
language sql stable security invoker set search_path = public as $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id
  from venues v
  where btrim(q) <> ''
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
    -- Every meaningful token must appear in the venue's searchable text (name + place + category).
    and (
      select bool_and(
        lower(coalesce(v.name, '') || ' ' || coalesce(v.locality, '') || ' ' ||
              coalesce(v.region, '') || ' ' || coalesce(v.category, ''))
          like '%' || replace(replace(replace(tok, '\', '\\'), '%', '\%'), '_', '\_') || '%'
      )
      from unnest(regexp_split_to_array(lower(btrim(q)), '\s+')) as tok
      where length(tok) >= 2
        and tok <> all (array['the','and','of','a','an','at','in','on','to','for','with'])
    )
  order by v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 20), 50));
$$;

comment on function venues_search_by_name(text, double precision, double precision, integer) is
  'Local-first venue name search (0078; token-AND matching in 0106). Every meaningful query word '
  'must appear in the venue name/locality/region/category, so "duke of york belfast" finds the '
  'Belfast venue named "Duke of York". Distance-ordered; hides permanently-closed venues.';

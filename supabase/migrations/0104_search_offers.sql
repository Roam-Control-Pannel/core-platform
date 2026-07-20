-- ============================================================================
-- Roam — 0104_search_offers.sql
-- Adds venue OFFERS (a Roam business's own deal, tied to a venue → a town) to the
-- global search, so a place query like "Belfast" surfaces live offers from Belfast
-- venues — the local counterpart to the national affiliate deals.
--
-- search_offers(q) returns LIVE offers (within their date window, non-permanently-
-- closed venue) whose OFFER TITLE, VENUE NAME, or VENUE LOCALITY matches q. The
-- locality match is what makes "Belfast" work; the title/name matches keep keyword
-- search useful too.
--
-- SECURITY INVOKER: offers (offers_read using(true)) and venues are world-readable,
-- so the caller's context is correct and anonymous search works — no privilege to
-- escalate (same rationale as venues_near/venues_search_by_name). q is pre-sanitised
-- by the API (ILIKE wildcards stripped), so the '%'||q||'%' below is literal.
-- ============================================================================

create or replace function search_offers(q text, max_results integer default 6)
returns table (
  offer_id   uuid,
  title      text,
  venue_id   uuid,
  venue_name text,
  venue_slug text,
  locality   text
)
language sql
stable
security invoker
set search_path = public
as $$
  select o.id, o.title, v.id, v.name, v.slug, v.locality
  from offers o
  join venues v on v.id = o.venue_id
  where (o.starts_at is null or o.starts_at <= now())
    and (o.ends_at   is null or o.ends_at   >= now())
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
    and (
      o.title    ilike '%' || q || '%'
      or v.name     ilike '%' || q || '%'
      or v.locality ilike '%' || q || '%'
    )
  order by o.created_at desc
  limit greatest(1, least(coalesce(max_results, 6), 20));
$$;

comment on function search_offers(text, integer) is
  'Live venue offers matching q by offer title, venue name, or venue locality — powers the '
  'global search''s local Offers group. SECURITY INVOKER over world-readable offers/venues.';

grant execute on function search_offers(text, integer) to anon, authenticated;

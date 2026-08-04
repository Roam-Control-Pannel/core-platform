-- ============================================================================
-- Roam — 0110_deal_categories.sql
-- Category chips for the Deals surface: the distinct live-deal categories across
-- BOTH affiliate networks (awin_deals 0062 + cj_deals 0109), with counts, most-
-- populated first. Powers deals.categories → the filter chips on /deals.
--
-- Read-time union over the two stores (no denormalisation). security invoker is
-- safe: each table's *_public_read policy already exposes only live rows, so the
-- counts match what a visitor can actually browse. Additive + idempotent.
-- ============================================================================

create or replace function deal_categories(p_limit integer default 14)
returns table (category text, deal_count bigint)
language sql stable security invoker set search_path = public as $$
  with live as (
    select category from awin_deals
      where active
        and (starts_at is null or starts_at <= now())
        and (ends_at is null or ends_at >= now())
        and category is not null and btrim(category) <> ''
    union all
    select category from cj_deals
      where active
        and (starts_at is null or starts_at <= now())
        and (ends_at is null or ends_at >= now())
        and category is not null and btrim(category) <> ''
  )
  select category, count(*) as deal_count
  from live
  group by category
  order by count(*) desc, category asc
  limit greatest(1, least(coalesce(p_limit, 14), 50));
$$;

comment on function deal_categories(integer) is
  'Distinct live-deal categories across awin_deals + cj_deals with counts (0110), most-populated '
  'first — powers the Deals filter chips. Read-time union; live rows only via each table''s RLS.';

-- 0048_offer_themes.sql
--
-- Offer THEMES + per-theme engagement, the data foundation for business marketing insights and
-- (later) the suggestion engine. Two additive columns on `offers` plus one owner-gated aggregation
-- function. Non-destructive and idempotent; safe to run once on the Roam-Core project.
--
--   offer_type   — a canonical theme string ('percent_off','two_for_one','bogof',… — the full set
--                  lives in @roam/core/offers; the DB stores it verbatim and treats NULL/unknown as
--                  'other'). Not a Postgres enum, so the taxonomy can grow without a migration.
--   discount_pct — the headline % for a percent_off offer (informational in this phase; the 0–50%
--                  preference CAP arrives with claim onboarding).

alter table offers add column if not exists offer_type text;
alter table offers add column if not exists discount_pct numeric(4, 1);

-- Speeds the per-theme rollup below (small tables today, but the group-by wants it).
create index if not exists offers_venue_type_idx on offers (venue_id, offer_type);

-- venue_offer_engagement(venue) → per-theme counts of offers, saves and redemptions for a venue
-- the CALLER OWNS. SECURITY DEFINER (reads offer_saves/redemptions across users), but guarded: a
-- non-owner gets a 42501 (surfaced as FORBIDDEN by the API). The two left joins pre-aggregate saves
-- and redemptions per offer so the theme group-by can't fan out into a cartesian product.
create or replace function venue_offer_engagement(p_venue uuid)
returns table (offer_type text, offers bigint, saves bigint, redemptions bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from venues v where v.id = p_venue and v.owner_id = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;

  return query
    select
      coalesce(o.offer_type, 'other')::text as offer_type,
      count(distinct o.id)::bigint          as offers,
      coalesce(sum(sc.saves), 0)::bigint    as saves,
      coalesce(sum(rc.redemptions), 0)::bigint as redemptions
    from offers o
    left join (select offer_id, count(*) as saves from offer_saves group by offer_id) sc
      on sc.offer_id = o.id
    left join (select offer_id, count(*) as redemptions from offer_redemptions group by offer_id) rc
      on rc.offer_id = o.id
    where o.venue_id = p_venue
    group by coalesce(o.offer_type, 'other');
end;
$$;

grant execute on function venue_offer_engagement(uuid) to authenticated;

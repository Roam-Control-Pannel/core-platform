-- ============================================================================
-- 0080_venue_details_enrichment.sql
-- On-demand venue ENRICHMENT — populate the rich Places facts (0065) for live venues.
--
-- The rich fields (phone, website_url, price_range, attributes) come from a Google Place
-- DETAILS call — the top "Atmosphere" billing tier — which is deliberately NOT part of the
-- lean searchNearby ingest that creates venues (that would put the priciest SKU on the
-- highest-volume call). Before this, the only thing that fetched Details was a hand-run
-- backfill script, so venues created by the live search path never got enriched.
--
-- This adds the demand-driven enrichment path: when a user opens an unclaimed, Places-sourced
-- venue that has never been enriched, the api makes ONE budget-guarded Details call, stores
-- the rich fields, and stamps details_fetched_at. First viewer pays once; everyone after is
-- free; cost scales with venues people actually look at.
--
-- Three parts, mirroring the on-demand INGEST cost machinery (0024):
--   1. venues.details_fetched_at — the "already tried" marker. Distinct from attributes
--      being null (a real venue may simply have no Atmosphere facts on Places), so we never
--      re-pay for a venue we've already asked about.
--   2. claim_places_detail_quota — a SEPARATE daily budget + per-client window for Details
--      calls, isolated from the searchNearby budget (its own bucket keys) so enrichment can
--      never starve area discovery and vice-versa. Same atomic check-and-consume shape as
--      claim_places_fetch_quota.
--   3. apply_venue_details — the writer. Sets the four rich fields + details_fetched_at, ONLY
--      for a still-unclaimed, not-yet-enriched venue (so a claim or a concurrent enrich can't
--      be clobbered). service_role-only, reached solely via the api internalProcedure.
-- ============================================================================

begin;

-- 1. The "already fetched Details" marker. NULL = never enriched (eligible); a timestamp =
--    we've made the one Details call (whatever it returned), so don't pay again.
alter table venues
  add column if not exists details_fetched_at timestamptz;

comment on column venues.details_fetched_at is
  'When the on-demand Places Details enrichment last ran for this venue (0080). NULL = never '
  'enriched (eligible for one Details call). Distinguishes "not tried" from "tried, Places had '
  'no rich facts", so enrichment never re-pays for the same venue.';

-- 2. Details-call budget — a twin of claim_places_fetch_quota (0024) on ITS OWN buckets
--    ('detail-global' / 'detail-client:<key>') so Details spend is capped independently of the
--    searchNearby budget. Same atomic check-and-consume; same places_fetch_quota table.
create or replace function claim_places_detail_quota(
  p_client_key         text,
  p_daily_cap          integer,
  p_client_cap         integer,
  p_client_window_secs integer
)
returns table (allowed boolean, reason text, global_used integer, client_used integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day_start    timestamptz := date_trunc('day', now());
  v_cli_bucket   text;
  v_cli_window   timestamptz;
  v_global_calls integer;
  v_client_calls integer := 0;
begin
  if p_daily_cap is null or p_daily_cap < 0
     or p_client_cap is null or p_client_cap < 0
     or p_client_window_secs is null or p_client_window_secs <= 0 then
    raise exception 'claim_places_detail_quota: invalid policy args (daily=%, client=%, window=%)',
      p_daily_cap, p_client_cap, p_client_window_secs using errcode = '22023';
  end if;

  -- (1) GLOBAL DAILY DETAILS BUDGET — its own bucket, separate from 'global' (searchNearby).
  insert into places_fetch_quota (bucket, window_start, calls)
    values ('detail-global', v_day_start, 0)
    on conflict (bucket, window_start) do nothing;
  select calls into v_global_calls
    from places_fetch_quota
    where bucket = 'detail-global' and window_start = v_day_start
    for update;

  if v_global_calls >= p_daily_cap then
    return query select false, 'daily-budget'::text, v_global_calls, 0;
    return;
  end if;

  -- (2) PER-CLIENT WINDOW (only when a client key was forwarded).
  if p_client_key is not null and p_client_key <> '' then
    v_cli_window := to_timestamp(
      floor(extract(epoch from now()) / p_client_window_secs) * p_client_window_secs
    );
    v_cli_bucket := 'detail-client:' || p_client_key;

    insert into places_fetch_quota (bucket, window_start, calls)
      values (v_cli_bucket, v_cli_window, 0)
      on conflict (bucket, window_start) do nothing;
    select calls into v_client_calls
      from places_fetch_quota
      where bucket = v_cli_bucket and window_start = v_cli_window
      for update;

    if v_client_calls >= p_client_cap then
      return query select false, 'client-rate'::text, v_global_calls, v_client_calls;
      return;
    end if;
  end if;

  -- (3) ALLOWED — consume one unit from each relevant counter.
  update places_fetch_quota set calls = calls + 1
    where bucket = 'detail-global' and window_start = v_day_start;
  if p_client_key is not null and p_client_key <> '' then
    update places_fetch_quota set calls = calls + 1
      where bucket = v_cli_bucket and window_start = v_cli_window;
  end if;

  delete from places_fetch_quota where window_start < now() - interval '2 days';

  return query select true, 'allowed'::text, v_global_calls + 1, v_client_calls + 1;
end;
$$;

comment on function claim_places_detail_quota(text, integer, integer, integer) is
  'Atomically checks a global daily Places DETAILS budget AND a per-client rolling window, '
  'consuming one unit from each iff allowed. Own buckets (detail-global / detail-client:<key>) '
  'so Details spend is capped independently of searchNearby (0024). Called by the api '
  'enrichVenue ONLY when a Details call is imminent. SECURITY DEFINER, service_role only.';

revoke all on function claim_places_detail_quota(text, integer, integer, integer) from public;
grant execute on function claim_places_detail_quota(text, integer, integer, integer) to service_role;

-- 3. The enrichment writer. Sets the four rich fields + stamps details_fetched_at, but ONLY
--    while the venue is still unclaimed AND not yet enriched — so a claim that landed since the
--    eligibility read (or a concurrent enrich) is never overwritten. SECURITY INVOKER: it runs
--    as the caller (service_role, which bypasses RLS); no anon/authenticated grant.
create or replace function apply_venue_details(
  p_venue_id    uuid,
  p_phone       text,
  p_website     text,
  p_price_range jsonb,
  p_attributes  jsonb
)
returns void
language sql
security invoker
set search_path = public
as $$
  update venues set
    phone              = p_phone,
    website_url        = p_website,
    price_range        = p_price_range,
    attributes         = p_attributes,
    details_fetched_at = now()
  where id = p_venue_id
    and owner_id is null
    and details_fetched_at is null;
$$;

comment on function apply_venue_details(uuid, text, text, jsonb, jsonb) is
  'On-demand enrichment writer (0080): stores the rich Places Details facts + stamps '
  'details_fetched_at, only for a still-unclaimed, not-yet-enriched venue. service_role only.';

revoke all on function apply_venue_details(uuid, text, text, jsonb, jsonb) from public;
grant execute on function apply_venue_details(uuid, text, text, jsonb, jsonb) to service_role;

commit;

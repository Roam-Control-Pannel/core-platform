-- ============================================================================
-- Roam — 0024_places_fetch_quota.sql
-- Abuse / cost control for on-demand Google Places ingestion.
--
-- THE PROBLEM: places.ingestCategory makes a PAID searchNearby call when there is no
-- fresh coverage for a point (the count_fresh_places_venues freshness skip, 0016, is the
-- TEMPORAL bound — same area is free for 30 days). That bounds REPEAT cost but not BREADTH:
-- an attacker enumerating many DISTINCT (lat,lng) points each looks "novel" and triggers a
-- paid call. This migration adds the two missing bounds:
--
--   • GLOBAL DAILY BUDGET — a hard ceiling on paid searchNearby calls per day. Evasion-proof
--     (it is global; a botnet of 10k IPs still cannot exceed it). This is the wallet backstop.
--   • PER-CLIENT WINDOW LIMIT — caps paid calls per client (keyed on the forwarded client IP)
--     per rolling fixed window, so one abuser cannot burn the whole daily budget and deny
--     new-area discovery to everyone else. This is the fairness layer.
--
-- The SPATIAL bound (coordinate snapping, which collapses jittered points into one cache
-- key so the freshness skip actually catches enumeration) lives in @roam/core — pure, no DB.
--
-- Both counters live here in one table and are claimed by ONE atomic function, so the
-- check-and-consume is race-free under concurrency (the api never reads-then-writes across
-- two round trips). The function is called ONLY when a paid call is imminent (after a
-- freshness miss), so one claim == one intended paid fetch.
--
-- The policy NUMBERS (daily cap, per-client cap, window length) are NOT baked in here —
-- they are passed as integer args from @roam/core constants, so the policy is visible and
-- unit-testable in TypeScript, and tunable without a migration. (Unlike 0016's 30-day
-- interval, which had to be internal because PostgREST can't resolve an `interval` arg;
-- integers resolve cleanly.)
--
-- SECURITY DEFINER + service_role-only execute: this is a server-to-server writer reached
-- ONLY via the api internalProcedure (x-internal-call gate), exactly like upsert_place_venues.
-- No anon/authenticated grant. search_path is locked.
-- ============================================================================

create table if not exists places_fetch_quota (
  -- 'global' for the daily budget row, or 'client:<key>' for a per-client window row.
  bucket       text not null,
  -- Start of the fixed window this row counts (day-truncated for global; window-floored
  -- for client). (bucket, window_start) is the natural key — one counter row per window.
  window_start timestamptz not null,
  calls        integer not null default 0,
  primary key (bucket, window_start)
);

comment on table places_fetch_quota is
  'Counters for the on-demand Places ingestion cost control: a global daily paid-call '
  'budget and per-client rolling-window limits. Written only by claim_places_fetch_quota '
  '(SECURITY DEFINER), reached only via the api internalProcedure. Stale rows are pruned '
  'opportunistically by the same function.';

-- ----------------------------------------------------------------------------
-- claim_places_fetch_quota — atomically check BOTH bounds and consume one unit iff allowed.
--
-- Returns one row: (allowed, reason, global_used, client_used). When allowed is false the
-- caller must NOT make the paid fetch; reason is 'daily-budget' or 'client-rate'. The api
-- maps a denial to a graceful skipped result (browsing still reads existing supply).
--
-- p_client_key NULL/'' (e.g. local dev with no forwarded IP) => only the global budget is
-- enforced; the per-client check is skipped.
-- ----------------------------------------------------------------------------
-- Drop first: the OUT/table return type is part of the function identity, so a
-- create-or-replace that ever changes those columns fails ("cannot change return type").
-- Dropping keeps the migration cleanly re-appliable on a fresh reset or a signature change.
drop function if exists claim_places_fetch_quota(text, integer, integer, integer);

create or replace function claim_places_fetch_quota(
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
  -- Guard the policy args: a non-positive cap or window is a programming error, not data.
  if p_daily_cap is null or p_daily_cap < 0
     or p_client_cap is null or p_client_cap < 0
     or p_client_window_secs is null or p_client_window_secs <= 0 then
    raise exception 'claim_places_fetch_quota: invalid policy args (daily=%, client=%, window=%)',
      p_daily_cap, p_client_cap, p_client_window_secs using errcode = '22023';
  end if;

  -- (1) GLOBAL DAILY BUDGET. Materialise today's row, then lock + read it.
  insert into places_fetch_quota (bucket, window_start, calls)
    values ('global', v_day_start, 0)
    on conflict (bucket, window_start) do nothing;
  select calls into v_global_calls
    from places_fetch_quota
    where bucket = 'global' and window_start = v_day_start
    for update;

  if v_global_calls >= p_daily_cap then
    return query select false, 'daily-budget'::text, v_global_calls, 0;
    return;
  end if;

  -- (2) PER-CLIENT WINDOW (only when a client key was forwarded).
  if p_client_key is not null and p_client_key <> '' then
    -- Floor now() to the window so a client's calls accumulate within a fixed bucket.
    v_cli_window := to_timestamp(
      floor(extract(epoch from now()) / p_client_window_secs) * p_client_window_secs
    );
    v_cli_bucket := 'client:' || p_client_key;

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
    where bucket = 'global' and window_start = v_day_start;
  if p_client_key is not null and p_client_key <> '' then
    update places_fetch_quota set calls = calls + 1
      where bucket = v_cli_bucket and window_start = v_cli_window;
  end if;

  -- Opportunistic prune: keep the table small without a separate cron. At <= the daily cap
  -- in claims/day this is a handful of cheap deletes on the PK; rows older than 2 days can
  -- never be a live window (longest window is the day bucket).
  delete from places_fetch_quota where window_start < now() - interval '2 days';

  return query select true, 'allowed'::text, v_global_calls + 1, v_client_calls + 1;
end;
$$;

comment on function claim_places_fetch_quota(text, integer, integer, integer) is
  'Atomically checks the global daily Places paid-call budget AND a per-client rolling '
  'window limit, consuming one unit from each iff allowed. Returns (allowed, reason, '
  'global_used, client_used); reason is daily-budget | client-rate | allowed. Called by '
  'the api ingestCategory ONLY when a paid fetch is imminent. SECURITY DEFINER, '
  'service_role only — reached via the internalProcedure gate.';

revoke all on function claim_places_fetch_quota(text, integer, integer, integer) from public;
grant execute on function claim_places_fetch_quota(text, integer, integer, integer) to service_role;

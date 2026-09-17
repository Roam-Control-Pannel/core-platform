-- ============================================================================
-- Roam pre-F2G baseline — Functions, constraints, indexes, triggers, RLS, and API grants
-- Generated from the final schema at migration 0115; see migrations/README.md.
-- ============================================================================
CREATE OR REPLACE FUNCTION "public"."apply_venue_details"("p_venue_id" "uuid", "p_phone" "text", "p_website" "text", "p_price_range" "jsonb", "p_attributes" "jsonb", "p_business_status" "text" DEFAULT NULL::"text") RETURNS "void"
    LANGUAGE "sql"
    SET "search_path" TO 'public'
    AS $$
  update venues set
    phone              = p_phone,
    website_url        = p_website,
    price_range        = p_price_range,
    attributes         = p_attributes,
    business_status    = coalesce(p_business_status, business_status),
    details_fetched_at = now()
  where id = p_venue_id
    and owner_id is null
    and details_fetched_at is null;
$$;


ALTER FUNCTION "public"."apply_venue_details"("p_venue_id" "uuid", "p_phone" "text", "p_website" "text", "p_price_range" "jsonb", "p_attributes" "jsonb", "p_business_status" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."apply_venue_details"("p_venue_id" "uuid", "p_phone" "text", "p_website" "text", "p_price_range" "jsonb", "p_attributes" "jsonb", "p_business_status" "text") IS 'On-demand enrichment writer (0080; +business_status in 0096): stores the rich Places Details facts, marks business_status (so a since-closed venue is caught and hidden by the reads), and stamps details_fetched_at — only while still unclaimed and not yet enriched.';


CREATE OR REPLACE FUNCTION "public"."approve_venue_claim"("target_claim_id" "uuid") RETURNS "public"."venue_claim_approval"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  c            venue_claims;
  v_status     venue_status;
  v_owner      uuid;
  claimant_email text;
  email_host   text;
  matched      boolean := false;
  result       venue_claim_approval;
begin
  -- Lock the claim row.
  select * into c from venue_claims where id = target_claim_id for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Lock the venue row too (same lock order everywhere: claim then venue).
  select status, owner_id into v_status, v_owner
    from venues where id = c.venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotency / guard: only act on a pending claim against a pending_claim venue.
  if c.status <> 'pending' or v_status <> 'pending_claim' then
    result := (c.id, c.venue_id, false, v_status, 'not_actionable');
    return result;
  end if;

  -- Resolve the claimant's email host from auth.users.
  select email into claimant_email from auth.users where id = c.claimant_id;
  if claimant_email is not null and position('@' in claimant_email) > 0 then
    email_host := lower(split_part(claimant_email, '@', 2));
  end if;

  -- Auto-match: real business-domain evidence only. The email host must not be a
  -- non-evidence host, and must appear in the (already deny-list-filtered) link set.
  if email_host is not null
     and not is_non_evidence_host(email_host)
     and exists (select 1 from venue_link_hosts(c.venue_id) h where h = email_host)
  then
    matched := true;
  end if;

  if matched then
    -- Confer ownership — the dangerous write, done here and ONLY here.
    update venues
      set status = 'claimed', owner_id = c.claimant_id
      where id = c.venue_id;

    update venue_claims
      set status = 'approved', reviewed_at = now()
      where id = c.id;

    result := (c.id, c.venue_id, true, 'claimed'::venue_status, 'email_domain');
    return result;
  end if;

  -- No auto-evidence: leave pending for the review queue. Not a rejection.
  result := (c.id, c.venue_id, false, 'pending_claim'::venue_status, 'manual_review_required');
  return result;
end;
$$;


ALTER FUNCTION "public"."approve_venue_claim"("target_claim_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."approve_venue_claim"("target_claim_id" "uuid") IS 'Service-role claim approval. Auto-approves (venue -> claimed, owner_id set; claim -> approved) ONLY when the claimant''s business email host matches a host in the venue''s deny-list-filtered links. Otherwise leaves the claim pending for human review — never auto-rejects. Uses is_non_evidence_host on both the email side and (transitively, via venue_link_hosts) the link side: one deny-list. SECURITY DEFINER, non-recursive, search_path locked. NOT granted to authenticated/anon.';


CREATE OR REPLACE FUNCTION "public"."are_friends"("a" "uuid", "b" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from friendships f
    where f.status = 'accepted'
      and ((f.requester_id = a and f.addressee_id = b)
        or (f.requester_id = b and f.addressee_id = a))
  );
$$;


ALTER FUNCTION "public"."are_friends"("a" "uuid", "b" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bump_engagement_notification"("p_recipient" "uuid", "p_type" "text", "p_entity" "uuid", "p_actor" "text", "p_verb" "text", "p_subject" "text", "p_href" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_id     uuid;
  v_cnt    int;
  v_others text;
  v_text   text;
begin
  select id, coalesce((payload->>'count')::int, 1) into v_id, v_cnt
    from notifications
    where recipient_id = p_recipient and type = p_type and entity_id = p_entity and read_at is null
    order by created_at desc limit 1;
  if v_id is not null then
    v_cnt := v_cnt + 1;
    v_others := case when v_cnt - 1 = 1 then '1 other' else (v_cnt - 1)::text || ' others' end;
    v_text := p_actor || ' and ' || v_others || ' ' || p_verb || ' ' || p_subject;
    update notifications
      set created_at = now(), read_at = null,
          payload = jsonb_build_object('text', v_text, 'href', p_href, 'count', v_cnt)
      where id = v_id;
  else
    v_text := p_actor || ' ' || p_verb || ' ' || p_subject;
    insert into notifications (recipient_id, type, entity_id, payload)
      values (p_recipient, p_type, p_entity, jsonb_build_object('text', v_text, 'href', p_href, 'count', 1));
  end if;
end;
$$;


ALTER FUNCTION "public"."bump_engagement_notification"("p_recipient" "uuid", "p_type" "text", "p_entity" "uuid", "p_actor" "text", "p_verb" "text", "p_subject" "text", "p_href" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."cast_poll_vote"("p_message" "uuid", "p_option" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_thread uuid;
  v_kind   text;
  v_multi  boolean;
  v_closed boolean;
begin
  select thread_id, kind, coalesce((payload ->> 'multi')::boolean, false)
    into v_thread, v_kind, v_multi
  from chat_messages where id = p_message;

  if v_thread is null then raise exception 'Poll not found' using errcode = '42704'; end if;
  if v_kind <> 'poll' then raise exception 'Not a poll' using errcode = '22023'; end if;

  if not exists (select 1 from chat_participants where thread_id = v_thread and profile_id = auth.uid()) then
    raise exception 'Not a participant' using errcode = '42501';
  end if;

  select (closed_at is not null) into v_closed from chat_polls where message_id = p_message;
  if coalesce(v_closed, false) then raise exception 'Poll is closed' using errcode = '22023'; end if;

  if not exists (
    select 1 from chat_messages m, jsonb_array_elements(m.payload -> 'options') opt
    where m.id = p_message and opt ->> 'id' = p_option
  ) then
    raise exception 'Unknown option' using errcode = '22023';
  end if;

  if v_multi then
    -- toggle this one option
    if exists (select 1 from chat_poll_votes where message_id = p_message and option_id = p_option and profile_id = auth.uid()) then
      delete from chat_poll_votes where message_id = p_message and option_id = p_option and profile_id = auth.uid();
    else
      insert into chat_poll_votes (message_id, option_id, profile_id) values (p_message, p_option, auth.uid());
    end if;
  else
    -- single choice: tapping your current pick clears it; otherwise replace whatever you had
    if exists (select 1 from chat_poll_votes where message_id = p_message and option_id = p_option and profile_id = auth.uid()) then
      delete from chat_poll_votes where message_id = p_message and profile_id = auth.uid();
    else
      delete from chat_poll_votes where message_id = p_message and profile_id = auth.uid();
      insert into chat_poll_votes (message_id, option_id, profile_id) values (p_message, p_option, auth.uid());
    end if;
  end if;
end;
$$;


ALTER FUNCTION "public"."cast_poll_vote"("p_message" "uuid", "p_option" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_nearby_alert_targets"("radius_m" double precision DEFAULT 5000, "cooldown_secs" integer DEFAULT 10800) RETURNS TABLE("profile_id" "uuid")
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with me as (
    select fp.geo, fp.availability, fp.expires_at, fp.geo_expires_at
    from friend_presence fp
    where fp.profile_id = auth.uid()
  ),
  targets as (
    select f.profile_id
    from friend_presence f
    cross join me
    where me.geo is not null
      and me.geo_expires_at is not null and me.geo_expires_at > now()
      and me.availability = 'free_to_meet'
      and (me.expires_at is null or me.expires_at > now())
      and f.profile_id <> auth.uid()
      and f.geo is not null
      and f.geo_expires_at is not null and f.geo_expires_at > now()
      and st_dwithin(f.geo, me.geo, radius_m)
      and are_friends(auth.uid(), f.profile_id)
      and coalesce((select up.presence_alerts_enabled from user_private up where up.user_id = f.profile_id), true)
      and not exists (
        select 1 from presence_alerts a
        where a.from_id = auth.uid()
          and a.to_id = f.profile_id
          and a.alerted_at > now() - make_interval(secs => cooldown_secs)
      )
  ),
  recorded as (
    insert into presence_alerts (from_id, to_id, alerted_at)
    select auth.uid(), t.profile_id, now() from targets t
    on conflict (from_id, to_id) do update set alerted_at = excluded.alerted_at
    returning to_id
  )
  select to_id from recorded;
$$;


ALTER FUNCTION "public"."claim_nearby_alert_targets"("radius_m" double precision, "cooldown_secs" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_places_detail_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) RETURNS TABLE("allowed" boolean, "reason" "text", "global_used" integer, "client_used" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."claim_places_detail_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."claim_places_detail_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) IS 'Atomically checks a global daily Places DETAILS budget AND a per-client rolling window, consuming one unit from each iff allowed. Own buckets (detail-global / detail-client:<key>) so Details spend is capped independently of searchNearby (0024). Called by the api enrichVenue ONLY when a Details call is imminent. SECURITY DEFINER, service_role only.';


CREATE OR REPLACE FUNCTION "public"."claim_places_fetch_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) RETURNS TABLE("allowed" boolean, "reason" "text", "global_used" integer, "client_used" integer)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."claim_places_fetch_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."claim_places_fetch_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) IS 'Atomically checks the global daily Places paid-call budget AND a per-client rolling window limit, consuming one unit from each iff allowed. Returns (allowed, reason, global_used, client_used); reason is daily-budget | client-rate | allowed. Called by the api ingestCategory ONLY when a paid fetch is imminent. SECURITY DEFINER, service_role only — reached via the internalProcedure gate.';


CREATE OR REPLACE FUNCTION "public"."close_poll"("p_message" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_sender uuid;
begin
  select sender_id into v_sender from chat_messages where id = p_message and kind = 'poll';
  if v_sender is null then raise exception 'Poll not found' using errcode = '42704'; end if;
  if v_sender <> auth.uid() then raise exception 'Only the poll creator can close it' using errcode = '42501'; end if;

  insert into chat_polls (message_id, closed_at, closed_by)
  values (p_message, now(), auth.uid())
  on conflict (message_id) do update set closed_at = now(), closed_by = auth.uid();
end;
$$;


ALTER FUNCTION "public"."close_poll"("p_message" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."count_fresh_places_venues"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision, "cat" "text") RETURNS integer
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select count(*)::int
  from venues v
  where v.source = 'google_places'
    and v.category = cat
    and v.fetched_at is not null
    and v.fetched_at > now() - interval '30 days'
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, radius_m);
$$;


ALTER FUNCTION "public"."count_fresh_places_venues"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision, "cat" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."count_fresh_places_venues"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision, "cat" "text") IS 'Fresh google_places venue count within radius_m of (origin_lat, origin_lng). Origin params named origin_* (unshadowable by venues.lat/lng).';


CREATE OR REPLACE FUNCTION "public"."create_thread_with_creator"("p_is_group" boolean DEFAULT false, "p_plan_id" "uuid" DEFAULT NULL::"uuid", "p_title" "text" DEFAULT NULL::"text") RETURNS "public"."chat_threads"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_uid    uuid := auth.uid();
  v_thread public.chat_threads;
begin
  if v_uid is null then
    raise exception 'create_thread_with_creator: no authenticated user'
      using errcode = '28000';
  end if;

  insert into public.chat_threads (is_group, plan_id, title)
  values (p_is_group, p_plan_id, p_title)
  returning * into v_thread;

  insert into public.chat_participants (thread_id, profile_id)
  values (v_thread.id, v_uid);

  return v_thread;
end;
$$;


ALTER FUNCTION "public"."create_thread_with_creator"("p_is_group" boolean, "p_plan_id" "uuid", "p_title" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_profile"() RETURNS "uuid"
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public', 'pg_temp'
    AS $$ select auth.uid() $$;


ALTER FUNCTION "public"."current_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."deal_categories"("p_limit" integer DEFAULT 14) RETURNS TABLE("category" "text", "deal_count" bigint)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."deal_categories"("p_limit" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."deal_categories"("p_limit" integer) IS 'Distinct live-deal categories across awin_deals + cj_deals with counts (0110), most-populated first — powers the Deals filter chips. Read-time union; live rows only via each table''s RLS.';


CREATE OR REPLACE FUNCTION "public"."deliver_birthday_offers"() RETURNS TABLE("user_id" "uuid", "venue_id" "uuid", "venue_name" "text", "title" "text", "code" "text", "push_ok" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
#variable_conflict use_column
declare
  per_user_cap int := 5;
begin
  return query
  with eligible as (
    select
      bo.venue_id, v.name as venue_name, bo.title, f.follower_id as user_id,
      coalesce(f.push_enabled, false) as push_ok,
      row_number() over (
        partition by f.follower_id
        order by
          (select count(*) from offer_saves s join offers o on o.id = s.offer_id
             where o.venue_id = bo.venue_id and s.profile_id = f.follower_id) desc,
          f.created_at desc
      ) as rnk
    from venue_birthday_offer bo
    join venues v on v.id = bo.venue_id
    join follows f on f.venue_id = bo.venue_id
    join user_private up on up.user_id = f.follower_id
    where bo.enabled = true
      and up.birthday_offers_enabled = true and up.birth_date is not null
      and extract(month from up.birth_date) = extract(month from now())
      and extract(day from up.birth_date) = extract(day from now())
  ),
  capped as (
    select * from eligible where rnk <= per_user_cap
  ),
  ins as (
    insert into birthday_deliveries (venue_id, user_id, delivered_on, code, expires_at, title)
    select c.venue_id, c.user_id, current_date, upper(substr(md5(random()::text), 1, 6)), current_date + 7, c.title
    from capped c
    on conflict (venue_id, user_id, delivered_on) do nothing
    returning venue_id, user_id, code, expires_at
  ),
  notified as (
    insert into notifications (recipient_id, type, payload)
    select i.user_id, 'birthday_offer',
      jsonb_build_object(
        'text', '🎂 Happy birthday! ' || coalesce(e.title, 'A birthday treat') || ' from ' || e.venue_name,
        'href', '/venue/' || i.venue_id,
        'venueId', i.venue_id, 'venueName', e.venue_name,
        'code', i.code, 'expiresAt', i.expires_at
      )
    from ins i
    join (select distinct venue_id, venue_name, title from capped) e on e.venue_id = i.venue_id
    returning 1
  )
  select i.user_id, i.venue_id, c.venue_name, c.title, i.code, c.push_ok
  from ins i
  join capped c on c.venue_id = i.venue_id and c.user_id = i.user_id;
end;
$$;


ALTER FUNCTION "public"."deliver_birthday_offers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."events_bump_interest"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    update events set interested_count = interested_count + 1 where id = new.event_id;
  elsif tg_op = 'DELETE' then
    update events set interested_count = greatest(0, interested_count - 1) where id = old.event_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."events_bump_interest"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."events_near"("lat" double precision, "lng" double precision, "radius_m" double precision DEFAULT 30000, "max_results" integer DEFAULT 50) RETURNS TABLE("id" "uuid", "title" "text", "category" "text", "starts_at" timestamp with time zone, "ends_at" timestamp with time zone, "locality" "text", "locality_label" "text", "venue_id" "uuid", "location_name" "text", "interested_count" integer, "distance_m" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select
    e.id, e.title, e.category, e.starts_at, e.ends_at, e.locality, e.locality_label,
    e.venue_id, e.location_name, e.interested_count,
    st_distance(e.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography) as distance_m
  from events e
  where e.geo is not null
    and e.status = 'published'
    and e.moderation in ('auto_approved', 'approved')
    and coalesce(e.ends_at, e.starts_at) >= now()
    and st_dwithin(e.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography, greatest(1, coalesce(radius_m, 30000)))
  order by e.geo <-> st_setsrid(st_makepoint(lng, lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;


ALTER FUNCTION "public"."events_near"("lat" double precision, "lng" double precision, "radius_m" double precision, "max_results" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."events_near"("lat" double precision, "lng" double precision, "radius_m" double precision, "max_results" integer) IS 'Near→far UPCOMING event search from a (lat,lng) origin within radius_m. Orders by the PostGIS KNN operator (geo <-> origin) against idx_events_geo; returns distance_m for display. SECURITY INVOKER so events_read RLS (public) applies — anonymous browsing works.';


CREATE OR REPLACE FUNCTION "public"."founder_badges_for_profile"("p_profile" "uuid", "p_max_rank" integer DEFAULT 25) RETURNS TABLE("locality" "text", "locality_label" "text", "rank" integer, "founded_at" timestamp with time zone)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  with firsts as (
    -- Each author's FIRST approved topic in each locality (one row per author per place).
    select author_id,
           locality,
           min(locality_label) as locality_label,   -- deterministic display label if casing varies
           min(created_at)     as first_at
    from town_hall_topics
    where author_id is not null
      and btrim(locality) <> ''
      and moderation in ('auto_approved', 'approved')
    group by author_id, locality
  ),
  ranked as (
    select author_id, locality, locality_label, first_at,
           row_number() over (partition by locality order by first_at asc, author_id asc) as rnk
    from firsts
  )
  select locality, locality_label, rnk::integer as rank, first_at as founded_at
  from ranked
  where author_id = p_profile
    and rnk <= greatest(1, least(coalesce(p_max_rank, 25), 100))
  order by first_at asc;
$$;


ALTER FUNCTION "public"."founder_badges_for_profile"("p_profile" "uuid", "p_max_rank" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."founder_badges_for_profile"("p_profile" "uuid", "p_max_rank" integer) IS 'Founding-member badges for a profile (0107): the localities where they are among the first N (default 25) Town Hall topic authors, with rank + founding date. Read-time window over approved topics — no denormalisation, always consistent across viewers.';


CREATE OR REPLACE FUNCTION "public"."friends_availability"() RETURNS TABLE("profile_id" "uuid", "handle" "text", "display_name" "text", "avatar_url" "text", "availability" "public"."presence_availability", "note" "text", "expires_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select fp.profile_id, p.handle, p.display_name, p.avatar_url,
         fp.availability, fp.note, fp.expires_at, fp.updated_at
  from friend_presence fp
  join profiles p on p.id = fp.profile_id
  where fp.availability is not null
    and (fp.expires_at is null or fp.expires_at > now())
    and are_friends(auth.uid(), fp.profile_id)
  order by fp.updated_at desc;
$$;


ALTER FUNCTION "public"."friends_availability"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."friends_nearby"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision DEFAULT 5000) RETURNS TABLE("profile_id" "uuid", "handle" "text", "display_name" "text", "avatar_url" "text", "availability" "public"."presence_availability", "note" "text", "lat" double precision, "lng" double precision, "distance_m" double precision, "geo_expires_at" timestamp with time zone, "updated_at" timestamp with time zone)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with origin as (
    select st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography as g
  )
  select fp.profile_id, p.handle, p.display_name, p.avatar_url,
         case when fp.expires_at is null or fp.expires_at > now() then fp.availability else null end,
         case when fp.expires_at is null or fp.expires_at > now() then fp.note else null end,
         st_y(fp.geo::geometry) as lat,
         st_x(fp.geo::geometry) as lng,
         st_distance(fp.geo, o.g) as distance_m,
         fp.geo_expires_at,
         fp.updated_at
  from friend_presence fp
  cross join origin o
  join profiles p on p.id = fp.profile_id
  where fp.geo is not null
    and fp.geo_expires_at is not null
    and fp.geo_expires_at > now()
    and st_dwithin(fp.geo, o.g, radius_m)
    and are_friends(auth.uid(), fp.profile_id)
  order by st_distance(fp.geo, o.g) asc;
$$;


ALTER FUNCTION "public"."friends_nearby"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."gen_unique_handle"("seed" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := lower(coalesce(seed, ''));
  base := regexp_replace(base, '[^a-z0-9_]+', '_', 'g'); -- non-charset → underscore
  base := regexp_replace(base, '_+', '_', 'g');          -- collapse runs
  base := trim(both '_' from base);
  if length(base) < 3 then
    base := 'roamer';
  end if;
  base := left(base, 24); -- leave headroom for a numeric suffix within the 30-char cap

  candidate := base;
  while exists (select 1 from profiles where handle = candidate) loop
    n := n + 1;
    candidate := left(base, 30 - length(n::text)) || n::text;
  end loop;
  return candidate;
end;
$$;


ALTER FUNCTION "public"."gen_unique_handle"("seed" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."gen_unique_topic_slug"("p_title" "text", "p_locality" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  base text;
  candidate text;
  n int := 0;
begin
  base := lower(coalesce(p_title, ''));
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
  base := trim(both '-' from base);
  if length(base) < 1 then
    base := 'topic';
  end if;
  base := left(base, 80);

  candidate := base;
  -- Uniqueness is scoped to the locality (the URL is /town-hall/{locality}/{slug}).
  while exists (select 1 from town_hall_topics where locality = p_locality and slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n::text;
  end loop;
  return candidate;
end;
$$;


ALTER FUNCTION "public"."gen_unique_topic_slug"("p_title" "text", "p_locality" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."gen_unique_venue_slug"("p_name" "text", "p_locality" "text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  base text;
  loc  text;
  candidate text;
  n int := 0;
begin
  base := lower(coalesce(p_name, ''));
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
  base := trim(both '-' from base);

  loc := lower(coalesce(p_locality, ''));
  loc := regexp_replace(loc, '[^a-z0-9]+', '-', 'g');
  loc := trim(both '-' from loc);

  -- Append the town for context/keywords + uniqueness, unless the name already contains it.
  if loc <> '' and position(loc in base) = 0 then
    base := base || '-' || loc;
  end if;
  base := regexp_replace(base, '-+', '-', 'g');
  base := trim(both '-' from base);
  if length(base) < 1 then
    base := 'venue';
  end if;
  base := left(base, 80);

  candidate := base;
  while exists (select 1 from venues where slug = candidate) loop
    n := n + 1;
    candidate := base || '-' || n::text;
  end loop;
  return candidate;
end;
$$;


ALTER FUNCTION "public"."gen_unique_venue_slug"("p_name" "text", "p_locality" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_direct_thread"("p_other" "uuid") RETURNS "public"."chat_threads"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_uid    uuid := auth.uid();
  v_thread public.chat_threads;
begin
  if v_uid is null then
    raise exception 'get_or_create_direct_thread: no authenticated user'
      using errcode = '28000';
  end if;
  if p_other = v_uid then
    raise exception 'get_or_create_direct_thread: cannot start a chat with yourself'
      using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where id = p_other) then
    raise exception 'get_or_create_direct_thread: no such profile'
      using errcode = 'P0002';
  end if;

  -- An existing 1:1 thread containing exactly these two people.
  select t.* into v_thread
  from public.chat_threads t
  where t.is_group = false
    and t.plan_id is null
    and exists (select 1 from public.chat_participants p
                where p.thread_id = t.id and p.profile_id = v_uid)
    and exists (select 1 from public.chat_participants p
                where p.thread_id = t.id and p.profile_id = p_other)
    and (select count(*) from public.chat_participants p where p.thread_id = t.id) = 2
  limit 1;
  if found then
    return v_thread;
  end if;

  insert into public.chat_threads (is_group, plan_id, title)
  values (false, null, null)
  returning * into v_thread;

  insert into public.chat_participants (thread_id, profile_id)
  values (v_thread.id, v_uid), (v_thread.id, p_other)
  on conflict (thread_id, profile_id) do nothing;

  return v_thread;
end;
$$;


ALTER FUNCTION "public"."get_or_create_direct_thread"("p_other" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_or_create_plan_thread"("p_plan_id" "uuid") RETURNS "public"."chat_threads"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_uid    uuid := auth.uid();
  v_owner  uuid;
  v_title  text;
  v_thread public.chat_threads;
begin
  if v_uid is null then
    raise exception 'get_or_create_plan_thread: no authenticated user'
      using errcode = '28000';
  end if;

  select owner_id, title into v_owner, v_title
  from public.plans where id = p_plan_id;
  if v_owner is null then
    raise exception 'get_or_create_plan_thread: plan not found'
      using errcode = 'P0002';
  end if;

  -- Owner-or-member gate (the same set plans_read admits).
  if v_uid <> v_owner and not exists (
    select 1 from public.plan_members m
    where m.plan_id = p_plan_id and m.profile_id = v_uid
  ) then
    raise exception 'get_or_create_plan_thread: not a member of this plan'
      using errcode = '42501';
  end if;

  -- Existing plan thread? Ensure the caller is a participant, then return it.
  select * into v_thread from public.chat_threads where plan_id = p_plan_id limit 1;
  if found then
    insert into public.chat_participants (thread_id, profile_id)
    values (v_thread.id, v_uid)
    on conflict (thread_id, profile_id) do nothing;
    return v_thread;
  end if;

  -- Create it, titled after the plan.
  insert into public.chat_threads (is_group, plan_id, title)
  values (true, p_plan_id, coalesce(nullif(btrim(v_title), ''), 'Plan chat'))
  returning * into v_thread;

  -- Seed participants: the owner …
  insert into public.chat_participants (thread_id, profile_id)
  values (v_thread.id, v_owner)
  on conflict (thread_id, profile_id) do nothing;

  -- … and every current member.
  insert into public.chat_participants (thread_id, profile_id)
  select v_thread.id, m.profile_id
  from public.plan_members m
  where m.plan_id = p_plan_id
  on conflict (thread_id, profile_id) do nothing;

  return v_thread;
end;
$$;


ALTER FUNCTION "public"."get_or_create_plan_thread"("p_plan_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_auth_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into profiles (id, display_name, handle)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'display_name', null),
    gen_unique_handle(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), 'roamer'))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;


ALTER FUNCTION "public"."handle_new_auth_user"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."handle_new_auth_user"() IS 'Provisions a profiles row for every new auth.users row (the claim flow is the first feature that creates users, and venue_claims.claimant_id FKs to profiles). Idempotent via on conflict do nothing; SECURITY DEFINER, search_path locked, non-recursive.';


CREATE OR REPLACE FUNCTION "public"."in_thread"("t" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from chat_participants cp
    where cp.thread_id = t and cp.profile_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."in_thread"("t" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_free_mail_host"("host" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select lower(host) in (
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
    'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
    'yandex.com', 'zoho.com', 'fastmail.com', 'pm.me'
  );
$$;


ALTER FUNCTION "public"."is_free_mail_host"("host" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_free_mail_host"("host" "text") IS 'True for common consumer/free-mail hosts. Such a host can never serve as domain-ownership evidence in the claim auto-match — only a business domain match auto-approves.';


CREATE OR REPLACE FUNCTION "public"."is_non_evidence_host"("host" "text") RETURNS boolean
    LANGUAGE "sql" IMMUTABLE
    SET "search_path" TO 'public'
    AS $$
  select lower(host) in (
    -- --- free-mail / consumer mailboxes (superset of is_free_mail_host) -------
    'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
    'msn.com', 'yahoo.com', 'ymail.com', 'icloud.com', 'me.com', 'mac.com',
    'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com',
    'yandex.com', 'zoho.com', 'fastmail.com', 'pm.me',
    -- --- booking / ordering / reservation aggregators ------------------------
    'opentable.com', 'opentable.co.uk', 'thefork.com', 'thefork.co.uk',
    'resy.com', 'sevenrooms.com', 'quandoo.com', 'quandoo.co.uk',
    'bookatable.com', 'designmynight.com',
    'deliveroo.com', 'deliveroo.co.uk', 'just-eat.com', 'just-eat.co.uk',
    'justeat.com', 'justeat.co.uk', 'ubereats.com', 'doordash.com',
    'grubhub.com', 'order.online', 'slerp.com', 'toasttab.com',
    -- --- review / directory platforms ----------------------------------------
    'tripadvisor.com', 'tripadvisor.co.uk', 'yelp.com', 'yelp.co.uk',
    'google.com', 'goo.gl', 'maps.app.goo.gl', 'g.page',
    'foursquare.com', 'trustpilot.com',
    -- --- social platforms ----------------------------------------------------
    'facebook.com', 'fb.com', 'fb.me', 'instagram.com', 'instagr.am',
    'twitter.com', 'x.com', 'tiktok.com', 'youtube.com', 'youtu.be',
    'linkedin.com', 'pinterest.com', 'snapchat.com', 'threads.net',
    -- --- link-in-bio / generic hosting / shorteners --------------------------
    'linktr.ee', 'linkin.bio', 'beacons.ai', 'carrd.co', 'bio.link',
    'bit.ly', 'tinyurl.com', 't.co', 'ow.ly', 'rebrand.ly',
    'wixsite.com', 'square.site', 'godaddysites.com', 'business.site',
    'wordpress.com', 'blogspot.com', 'weebly.com', 'webflow.io',
    'eventbrite.com', 'eventbrite.co.uk', 'whatsapp.com', 'wa.me'
  );
$$;


ALTER FUNCTION "public"."is_non_evidence_host"("host" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."is_non_evidence_host"("host" "text") IS 'Canonical deny-list: a host that can NEVER prove venue ownership — free-mail (a consumer mailbox proves nothing) OR a shared aggregator/platform/social/link-in-bio host (owned by the platform, not the venue, so a match is a false positive). Used on BOTH the claimant-email side and the venue-link side so there is one list to maintain. Superset of is_free_mail_host (which is kept for back-compat but no longer the predicate approve_venue_claim calls).';


CREATE OR REPLACE FUNCTION "public"."is_plan_member"("p_plan" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from plan_members m where m.plan_id = p_plan and m.profile_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."is_plan_member"("p_plan" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."locality_founding_stats"("p_locality" "text", "p_viewer" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("contributor_count" integer, "viewer_rank" integer)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  with firsts as (
    select author_id, min(created_at) as first_at
    from town_hall_topics
    where locality = p_locality
      and author_id is not null
      and moderation in ('auto_approved', 'approved')
    group by author_id
  ),
  ranked as (
    select author_id, row_number() over (order by first_at asc, author_id asc) as rnk
    from firsts
  )
  select
    (select count(*)::integer from firsts) as contributor_count,
    (select rnk::integer from ranked where author_id = p_viewer) as viewer_rank;
$$;


ALTER FUNCTION "public"."locality_founding_stats"("p_locality" "text", "p_viewer" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."locality_founding_stats"("p_locality" "text", "p_viewer" "uuid") IS 'Honest founding counter for a locality (0108): distinct approved-topic authors + the viewer''s founding rank (null if they have not posted). Read-time; companion to founder_badges (0107).';


CREATE OR REPLACE FUNCTION "public"."mark_thread_read"("p_thread" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update chat_participants
    set last_read_at = now()
  where thread_id = p_thread and profile_id = auth.uid();
end;
$$;


ALTER FUNCTION "public"."mark_thread_read"("p_thread" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."mark_venue_activity_read"("p_venue" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare n integer;
begin
  if not exists (select 1 from venues v where v.id = p_venue and v.owner_id = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;
  update venue_activity set read_at = now() where venue_id = p_venue and read_at is null;
  get diagnostics n = row_count;
  return n;
end;
$$;


ALTER FUNCTION "public"."mark_venue_activity_read"("p_venue" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."moderate_ban_profile"("p_user_id" "uuid", "p_banned" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update profiles
    set banned_at = case when p_banned then now() else null end
    where id = p_user_id;

  if p_banned then
    update venues set status = 'suspended'
      where owner_id = p_user_id and status = 'claimed';
  else
    update venues set status = 'claimed'
      where owner_id = p_user_id and status = 'suspended';
  end if;
end;
$$;


ALTER FUNCTION "public"."moderate_ban_profile"("p_user_id" "uuid", "p_banned" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."moderate_ban_profile"("p_user_id" "uuid", "p_banned" boolean) IS 'Moderation: ban/un-ban a profile + suspend/restore their venues. service_role only.';


CREATE OR REPLACE FUNCTION "public"."moderate_revoke_claim"("p_venue_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update venues
    set owner_id = null, status = 'unclaimed'
    where id = p_venue_id;

  update venue_claims
    set status = 'rejected', reviewed_at = now()
    where venue_id = p_venue_id and status = 'approved';
end;
$$;


ALTER FUNCTION "public"."moderate_revoke_claim"("p_venue_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."moderate_revoke_claim"("p_venue_id" "uuid") IS 'Moderation: clear ownership + reject claims, venue back to unclaimed. service_role only.';


CREATE OR REPLACE FUNCTION "public"."moderate_set_venue_suspended"("p_venue_id" "uuid", "p_suspended" boolean) RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if p_suspended then
    update venues set status = 'suspended' where id = p_venue_id;
  else
    -- Restore to the natural state: claimed if it still has an owner, else unclaimed.
    update venues
      set status = case when owner_id is not null then 'claimed' else 'unclaimed' end
      where id = p_venue_id and status = 'suspended';
  end if;
end;
$$;


ALTER FUNCTION "public"."moderate_set_venue_suspended"("p_venue_id" "uuid", "p_suspended" boolean) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."moderate_set_venue_suspended"("p_venue_id" "uuid", "p_suspended" boolean) IS 'Moderation: hide/restore a venue from public discovery. service_role only.';


CREATE OR REPLACE FUNCTION "public"."notify_business_post_comment"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_owner uuid; actor text;
begin
  select v.owner_id into v_owner
    from posts p join venues v on v.id = p.venue_id
    where p.id = new.post_id;
  if v_owner is null or v_owner = new.author_id then return null; end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone') into actor
    from profiles where id = new.author_id;
  insert into notifications (recipient_id, type, payload)
  values (v_owner, 'business_post_comment', jsonb_build_object(
    'text', coalesce(actor, 'Someone') || ' commented on your post',
    'href', '/feed/' || new.post_id::text,
    'actorId', new.author_id
  ));
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_business_post_comment"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_business_post_like"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_owner uuid; actor text;
begin
  select v.owner_id into v_owner
    from posts p join venues v on v.id = p.venue_id
    where p.id = new.post_id;
  if v_owner is null or v_owner = new.liker_id then return null; end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone') into actor
    from profiles where id = new.liker_id;
  perform bump_engagement_notification(v_owner, 'business_post_like', new.post_id,
    coalesce(actor, 'Someone'), 'liked', 'your post', '/feed/' || new.post_id::text);
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_business_post_like"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_event_cancelled"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.status = 'cancelled' and coalesce(old.status, '') <> 'cancelled' then
    insert into notifications (recipient_id, type, payload)
    select ei.user_id, 'event_cancelled', jsonb_build_object(
      'text', 'An event you were interested in was cancelled: “' || coalesce(new.title, '') || '”',
      'href', '/events/' || new.id::text
    )
    from event_interest ei
    where ei.event_id = new.id
      and ei.user_id is distinct from new.author_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_event_cancelled"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_event_interest"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_author uuid;
  v_title  text;
  actor    text;
begin
  select author_id, title into v_author, v_title from events where id = new.event_id;
  if v_author is null or v_author = new.user_id then
    return null;
  end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone')
    into actor from profiles where id = new.user_id;
  insert into notifications (recipient_id, type, payload)
  values (v_author, 'event_interest', jsonb_build_object(
    'text', coalesce(actor, 'Someone') || ' is interested in your event “' || coalesce(v_title, '') || '”',
    'href', '/events/' || new.event_id::text,
    'actorId', new.user_id
  ));
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_event_interest"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_friend_event"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  actor text;
begin
  if tg_op = 'INSERT' and new.status = 'pending' then
    select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone')
      into actor from profiles where id = new.requester_id;
    insert into notifications (recipient_id, type, payload)
    values (new.addressee_id, 'friend_request', jsonb_build_object(
      'text', coalesce(actor, 'Someone') || ' sent you a friend request',
      'href', '/friends',
      'actorId', new.requester_id
    ));
  elsif tg_op = 'UPDATE' and new.status = 'accepted' and old.status is distinct from 'accepted' then
    select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone')
      into actor from profiles where id = new.addressee_id;
    insert into notifications (recipient_id, type, payload)
    values (new.requester_id, 'friend_accept', jsonb_build_object(
      'text', coalesce(actor, 'Someone') || ' accepted your friend request',
      'href', '/u/' || new.addressee_id::text,
      'actorId', new.addressee_id
    ));
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_friend_event"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_locality_newcomer"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_is_first_here boolean;
  v_contributors  integer;
  v_actor         text;
  v_label         text;
  v_entity        uuid;
  v_href          text;
  r               record;
begin
  -- Only community topics with a real author + locality, and only approved ones can mint a ping.
  if new.author_id is null or btrim(coalesce(new.locality, '')) = '' then return null; end if;
  if new.moderation not in ('auto_approved', 'approved') then return null; end if;

  -- Is this the author's FIRST approved topic in this locality? (this row excluded)
  select not exists (
    select 1 from town_hall_topics
    where locality = new.locality
      and author_id = new.author_id
      and id <> new.id
      and moderation in ('auto_approved', 'approved')
  ) into v_is_first_here;
  if not v_is_first_here then return null; end if;   -- a returning contributor, not a newcomer

  -- Distinct contributors now (including this newcomer). Only ping during the founding phase:
  -- the 2nd..25th arrival. The very first person has no one to notify; past 25, the town stands
  -- on its own and the founders have had their moment.
  select count(distinct author_id) into v_contributors
  from town_hall_topics
  where locality = new.locality
    and author_id is not null
    and moderation in ('auto_approved', 'approved');
  if v_contributors < 2 or v_contributors > 25 then return null; end if;

  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone') into v_actor
    from profiles where id = new.author_id;
  v_label  := coalesce(nullif(btrim(new.locality_label), ''), new.locality);
  v_entity := md5(new.locality)::uuid;               -- stable per-locality entity → coalesced pings
  v_href   := '/town-hall/' || new.locality;

  -- Notify every EARLIER contributor in this locality — the founders watching it grow.
  for r in
    select distinct author_id
    from town_hall_topics
    where locality = new.locality
      and author_id is not null
      and author_id <> new.author_id
      and moderation in ('auto_approved', 'approved')
  loop
    perform bump_engagement_notification(
      r.author_id, 'locality_newcomer', v_entity,
      coalesce(v_actor, 'Someone'), 'joined you in', v_label, v_href);
  end loop;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_locality_newcomer"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_offer_followers"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text; v_slug text;
begin
  if not coalesce(new.notify_followers, false) then return null; end if;
  select name, slug into v_name, v_slug from venues where id = new.venue_id;
  insert into notifications (recipient_id, type, entity_id, payload)
  select f.follower_id, 'venue_offer', new.id, jsonb_build_object(
    'text', coalesce(v_name, 'A venue you follow') || ' posted a new offer: “' || coalesce(new.title, '') || '”',
    'href', '/venue/' || coalesce(v_slug, new.venue_id::text)
  )
  from follows f
  where f.venue_id = new.venue_id;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_offer_followers"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_plan_member"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner uuid;
  v_title text;
  actor   text;
begin
  select owner_id, title into v_owner, v_title from plans where id = new.plan_id;
  if v_owner is null or new.profile_id = v_owner then
    return null; -- the owner is a member of their own plan; don't self-notify
  end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone')
    into actor from profiles where id = v_owner;
  insert into notifications (recipient_id, type, payload)
  values (new.profile_id, 'plan_invite', jsonb_build_object(
    'text', coalesce(actor, 'Someone') || ' added you to the plan “' || coalesce(v_title, 'a plan') || '”',
    'href', '/plans/' || new.plan_id::text,
    'actorId', v_owner
  ));
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_plan_member"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_post_like"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_author uuid; actor text;
begin
  select author_id into v_author from profile_posts where id = new.post_id;
  if v_author is null or v_author = new.liker_id then return null; end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone') into actor
    from profiles where id = new.liker_id;
  perform bump_engagement_notification(v_author, 'post_like', new.post_id,
    coalesce(actor, 'Someone'), 'liked', 'your post', '/u/' || v_author::text);
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_post_like"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_reply_upvote"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_author uuid; v_topic uuid; v_slug text; v_locality text; actor text; v_href text;
begin
  select author_id, topic_id into v_author, v_topic from town_hall_replies where id = new.reply_id;
  if v_author is null or v_author = new.voter_id then return null; end if;
  select slug, locality into v_slug, v_locality from town_hall_topics where id = v_topic;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone') into actor
    from profiles where id = new.voter_id;
  v_href := case when v_slug is not null and v_locality is not null
                 then '/town-hall/' || v_locality || '/' || v_slug
                 else '/town-hall/' || v_topic::text end;
  perform bump_engagement_notification(v_author, 'reply_upvote', new.reply_id,
    coalesce(actor, 'Someone'), 'upvoted', 'your reply', v_href);
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_reply_upvote"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_topic_upvote"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_author uuid; v_title text; v_slug text; v_locality text; actor text; v_href text;
begin
  select author_id, title, slug, locality into v_author, v_title, v_slug, v_locality
    from town_hall_topics where id = new.topic_id;
  if v_author is null or v_author = new.voter_id then return null; end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone') into actor
    from profiles where id = new.voter_id;
  v_href := case when v_slug is not null and v_locality is not null
                 then '/town-hall/' || v_locality || '/' || v_slug
                 else '/town-hall/' || new.topic_id::text end;
  perform bump_engagement_notification(v_author, 'topic_upvote', new.topic_id,
    coalesce(actor, 'Someone'), 'upvoted', 'your topic “' || coalesce(v_title, '') || '”', v_href);
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_topic_upvote"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_townhall_reply"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  t_author uuid;
  t_title  text;
  actor    text;
begin
  select author_id, title into t_author, t_title from town_hall_topics where id = new.topic_id;
  if t_author is null or t_author = new.author_id then
    return null;
  end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone')
    into actor from profiles where id = new.author_id;
  insert into notifications (recipient_id, type, payload)
  values (t_author, 'townhall_reply', jsonb_build_object(
    'text', coalesce(actor, 'Someone') || ' replied to "' || t_title || '"',
    'href', '/town-hall/' || new.topic_id::text,
    'actorId', new.author_id
  ));
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_townhall_reply"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_venue_claim"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_name text;
  v_slug text;
begin
  if new.status = old.status then
    return null;
  end if;
  select name, slug into v_name, v_slug from venues where id = new.venue_id;
  if new.status = 'approved' then
    insert into notifications (recipient_id, type, payload)
    values (new.claimant_id, 'claim_approved', jsonb_build_object(
      'text', 'Your claim for ' || coalesce(v_name, 'your venue') || ' was approved — you can manage it now.',
      'href', '/venue/' || coalesce(v_slug, new.venue_id::text)
    ));
  elsif new.status = 'rejected' then
    insert into notifications (recipient_id, type, payload)
    values (new.claimant_id, 'claim_rejected', jsonb_build_object(
      'text', 'Your claim for ' || coalesce(v_name, 'this venue') || ' wasn’t approved.',
      'href', '/venue/' || coalesce(v_slug, new.venue_id::text)
    ));
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_venue_claim"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_venue_follow"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner uuid;
  v_name  text;
  actor   text;
begin
  select owner_id, name into v_owner, v_name from venues where id = new.venue_id;
  if v_owner is null or v_owner = new.follower_id then
    return null;
  end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone')
    into actor from profiles where id = new.follower_id;
  insert into notifications (recipient_id, type, payload)
  values (v_owner, 'venue_follow', jsonb_build_object(
    'text', coalesce(actor, 'Someone') || ' started following ' || coalesce(v_name, 'your venue'),
    'href', '/venue/' || new.venue_id::text,
    'actorId', new.follower_id
  ));
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_venue_follow"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_venue_review"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_owner uuid;
  v_name  text;
  v_slug  text;
begin
  select owner_id, name, slug into v_owner, v_name, v_slug from venues where id = new.venue_id;
  if v_owner is null or v_owner = new.author_id then
    return null;
  end if;
  insert into notifications (recipient_id, type, payload)
  values (v_owner, 'venue_review', jsonb_build_object(
    'text', 'New review on ' || coalesce(v_name, 'your venue'),
    'href', '/venue/' || coalesce(v_slug, new.venue_id::text),
    'actorId', new.author_id
  ));
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_venue_review"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."notify_wall_comment"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  post_author uuid;
  actor       text;
begin
  select author_id into post_author from profile_posts where id = new.post_id;
  if post_author is null or post_author = new.author_id then
    return null;
  end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone')
    into actor from profiles where id = new.author_id;
  insert into notifications (recipient_id, type, payload)
  values (post_author, 'wall_comment', jsonb_build_object(
    'text', coalesce(actor, 'Someone') || ' commented on your post',
    'href', '/u/' || post_author::text,
    'actorId', new.author_id
  ));
  return null;
end;
$$;


ALTER FUNCTION "public"."notify_wall_comment"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."owns_plan"("p_plan" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from plans p where p.id = p_plan and p.owner_id = auth.uid()
  );
$$;


ALTER FUNCTION "public"."owns_plan"("p_plan" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."plan_venue_suggestions"("plan_id_param" "uuid", "max_results" integer DEFAULT 6) RETURNS TABLE("id" "uuid", "name" "text", "category" "text", "primary_type_label" "text", "rating" numeric, "rating_count" integer, "distance_m" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  with dom as (
    -- The plan's dominant locality: the town most of its venues are in. A single out-of-area
    -- venue is the minority, so it never wins — and is excluded from the anchor below. NULL when
    -- none of the plan's venues carry a locality (then the anchor falls back to all of them).
    select (
      select v.locality
      from plan_venues pv
      join venues v on v.id = pv.venue_id
      where pv.plan_id = plan_id_param and v.locality is not null
      group by v.locality
      order by count(*) desc, v.locality
      limit 1
    ) as loc
  ),
  anchor as (
    -- Centroid of the plan's venues IN the dominant locality (all of them if no locality data),
    -- so the anchor lands on the plan's real place rather than the mean of scattered outliers.
    select st_centroid(st_collect(v.geo::geometry))::geography as g
    from plan_venues pv
    join venues v on v.id = pv.venue_id
    cross join dom
    where pv.plan_id = plan_id_param
      and (dom.loc is null or v.locality is not distinct from dom.loc)
  )
  select
    v.id,
    v.name,
    v.category,
    v.primary_type_label,
    v.rating,
    v.rating_count,
    st_distance(v.geo, a.g) as distance_m
  from venues v
  cross join anchor a
  where a.g is not null
    and v.status <> 'suspended'
    and v.id not in (
      select pv.venue_id from plan_venues pv where pv.plan_id = plan_id_param
    )
    -- Only genuinely local venues: within 30 km of the plan's place (NEARBY_RADIUS_M). This is
    -- what keeps Belfast/other-city venues out of a Liverpool plan's suggestions.
    and st_dwithin(v.geo, a.g, 30000)
  order by v.geo <-> a.g
  limit greatest(1, least(coalesce(max_results, 6), 20));
$$;


ALTER FUNCTION "public"."plan_venue_suggestions"("plan_id_param" "uuid", "max_results" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."plan_venue_suggestions"("plan_id_param" "uuid", "max_results" integer) IS 'Nearby venues to suggest for a plan: anchored on the centroid of the plan''s venues in its DOMINANT locality (robust to an out-of-area outlier), capped to 30 km of that anchor, excluding venues already in the plan and suspended venues. SECURITY INVOKER (member-gated).';


CREATE OR REPLACE FUNCTION "public"."poll_results"("p_message" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_thread uuid;
  v_closed boolean;
  v_votes  jsonb;
begin
  select thread_id into v_thread from chat_messages where id = p_message;
  if v_thread is null then raise exception 'Poll not found' using errcode = '42704'; end if;
  if not exists (select 1 from chat_participants where thread_id = v_thread and profile_id = auth.uid()) then
    raise exception 'Not a participant' using errcode = '42501';
  end if;

  select (closed_at is not null) into v_closed from chat_polls where message_id = p_message;

  select coalesce(jsonb_agg(jsonb_build_object(
           'optionId', v.option_id,
           'profileId', v.profile_id,
           'name', coalesce(nullif(btrim(p.display_name), ''), '@' || p.handle, 'Roam member'),
           'avatar', p.avatar_url
         )), '[]'::jsonb)
    into v_votes
  from chat_poll_votes v
  join profiles p on p.id = v.profile_id
  where v.message_id = p_message;

  return jsonb_build_object('closed', coalesce(v_closed, false), 'votes', v_votes);
end;
$$;


ALTER FUNCTION "public"."poll_results"("p_message" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."posts_bump_comments"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    update posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update posts set comment_count = greatest(0, comment_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."posts_bump_comments"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."posts_bump_likes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    update posts set like_count = like_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update posts set like_count = greatest(0, like_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."posts_bump_likes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."posts_feed_near"("lat" double precision, "lng" double precision, "radius_m" double precision DEFAULT 25000, "max_results" integer DEFAULT 50) RETURNS TABLE("id" "uuid", "kind" "public"."post_kind", "title" "text", "body" "text", "media" "jsonb", "published_at" timestamp with time zone, "venue_id" "uuid", "venue_name" "text", "venue_locality" "text", "distance_m" double precision)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select
    p.id,
    p.kind,
    p.title,
    p.body,
    p.media,
    p.published_at,
    v.id   as venue_id,
    v.name as venue_name,
    v.locality as venue_locality,
    st_distance(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography) as distance_m
  from posts p
  join venues v on v.id = p.venue_id
  where p.published_at is not null
    and p.moderation in ('auto_approved', 'approved')
    and 'feed' = any (p.destinations)
    and st_dwithin(v.geo, st_setsrid(st_makepoint(lng, lat), 4326)::geography, greatest(0, radius_m))
  order by p.published_at desc
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;


ALTER FUNCTION "public"."posts_feed_near"("lat" double precision, "lng" double precision, "radius_m" double precision, "max_results" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profile_post_bump_comments"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    update profile_posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update profile_posts set comment_count = greatest(0, comment_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."profile_post_bump_comments"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profile_post_bump_likes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    update profile_posts set like_count = like_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update profile_posts set like_count = greatest(0, like_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."profile_post_bump_likes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_listing_view"("p_listing" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  update market_listings set views = views + 1 where id = p_listing and status = 'live';
$$;


ALTER FUNCTION "public"."record_listing_view"("p_listing" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_profile_view"("p_profile" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  update profiles set wall_view_count = wall_view_count + 1 where id = p_profile;
end;
$$;


ALTER FUNCTION "public"."record_profile_view"("p_profile" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."record_venue_view"("p_venue" "uuid") RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  insert into venue_views (venue_id, day, views)
  select p_venue, current_date, 1
  where exists (select 1 from venues where id = p_venue)
  on conflict (venue_id, day) do update set views = venue_views.views + 1;
$$;


ALTER FUNCTION "public"."record_venue_view"("p_venue" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."redeem_birthday_offer"("p_venue" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare d birthday_deliveries%rowtype;
begin
  select * into d from birthday_deliveries
    where venue_id = p_venue and user_id = auth.uid()
      and (expires_at is null or expires_at >= current_date)
    order by delivered_on desc
    limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'none');
  end if;
  if d.redeemed_at is not null then
    return jsonb_build_object('ok', true, 'alreadyRedeemed', true, 'code', d.code);
  end if;
  update birthday_deliveries set redeemed_at = now() where id = d.id;
  return jsonb_build_object('ok', true, 'alreadyRedeemed', false, 'code', d.code);
end;
$$;


ALTER FUNCTION "public"."redeem_birthday_offer"("p_venue" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."redeem_offer"("p_offer" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_uid uuid := auth.uid();
  v_offer offers%rowtype;
  v_count int;
  v_at timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'auth');
  end if;

  select * into v_offer from offers where id = p_offer;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'not_found');
  end if;

  -- Validity window: a null bound is open-ended.
  if (v_offer.starts_at is not null and v_offer.starts_at > now())
     or (v_offer.ends_at is not null and v_offer.ends_at < now()) then
    return jsonb_build_object('ok', false, 'reason', 'not_active');
  end if;

  -- Already redeemed by this user → idempotent success (re-reveal the code).
  select redeemed_at into v_at from offer_redemptions
    where offer_id = p_offer and profile_id = v_uid limit 1;
  if found then
    return jsonb_build_object('ok', true, 'alreadyRedeemed', true, 'redeemedAt', v_at, 'code', v_offer.code);
  end if;

  -- Global cap.
  if v_offer.max_redemptions is not null then
    select count(*) into v_count from offer_redemptions where offer_id = p_offer;
    if v_count >= v_offer.max_redemptions then
      return jsonb_build_object('ok', false, 'reason', 'sold_out');
    end if;
  end if;

  begin
    insert into offer_redemptions (offer_id, profile_id) values (p_offer, v_uid)
      returning redeemed_at into v_at;
  exception when unique_violation then
    -- Concurrent redemption for the same user — treat as already redeemed.
    select redeemed_at into v_at from offer_redemptions
      where offer_id = p_offer and profile_id = v_uid limit 1;
  end;

  return jsonb_build_object('ok', true, 'alreadyRedeemed', false, 'redeemedAt', v_at, 'code', v_offer.code);
end;
$$;


ALTER FUNCTION "public"."redeem_offer"("p_offer" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reject_venue_claim"("target_claim_id" "uuid", "reason" "text" DEFAULT NULL::"text") RETURNS "public"."venue_claim_approval"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  c             venue_claims;
  v_status      venue_status;
  v_owner       uuid;
  other_pending boolean;
  result        venue_claim_approval;
begin
  -- Lock the claim row.
  select * into c from venue_claims where id = target_claim_id for update;
  if not found then
    raise exception 'CLAIM_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Lock the venue row (same lock order as approve: claim then venue).
  select status, owner_id into v_status, v_owner
    from venues where id = c.venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;

  -- Idempotency / guard: only a pending claim can be rejected. Anything else is a
  -- no-op returning current venue status (re-reject, or reject-after-approve).
  if c.status <> 'pending' then
    result := (c.id, c.venue_id, false, v_status, 'not_actionable');
    return result;
  end if;

  -- Close this claim.
  update venue_claims
    set status = 'rejected', reviewed_at = now(), note = coalesce(reason, note)
    where id = c.id;

  -- Return the venue to the pool ONLY if it was waiting on a claim (pending_claim)
  -- and no OTHER pending claim remains. NEVER touch a claimed/suspended venue, and
  -- NEVER clear owner_id (a rejection of a stray claim must not un-own anything).
  if v_status = 'pending_claim' then
    select exists (
      select 1 from venue_claims oc
      where oc.venue_id = c.venue_id
        and oc.id <> c.id
        and oc.status = 'pending'
    ) into other_pending;

    if not other_pending then
      update venues set status = 'unclaimed' where id = c.venue_id;
      result := (c.id, c.venue_id, false, 'unclaimed'::venue_status, 'rejected');
      return result;
    end if;
  end if;

  -- Venue left as-is (still pending_claim with another live claim, or already
  -- claimed/suspended): only this claim was closed.
  result := (c.id, c.venue_id, false, v_status, 'rejected');
  return result;
end;
$$;


ALTER FUNCTION "public"."reject_venue_claim"("target_claim_id" "uuid", "reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."reject_venue_claim"("target_claim_id" "uuid", "reason" "text") IS 'Service-role claim rejection. Transitions a pending claim -> rejected; returns its venue to unclaimed IFF the venue was pending_claim and no other pending claim remains. NEVER un-owns a claimed venue; never clears owner_id. Idempotent (non-pending claim = no-op). Returns the venue_claim_approval composite shared with approve_venue_claim (verified always false; method = rejected|not_actionable). SECURITY DEFINER, non-recursive, search_path locked. NOT granted to authenticated/anon.';


CREATE OR REPLACE FUNCTION "public"."request_venue_claim"("target_venue_id" "uuid", "claim_note" "text" DEFAULT NULL::"text") RETURNS "public"."venue_claims"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  caller         uuid := auth.uid();
  v_status       venue_status;
  claimant_email text;
  email_host     text;
  matched        boolean := false;
  claim          venue_claims;
begin
  if caller is null then
    raise exception 'AUTH_REQUIRED' using errcode = '28000';
  end if;

  -- Banned users cannot claim.
  if exists (select 1 from profiles where id = caller and banned_at is not null) then
    raise exception 'USER_BANNED' using errcode = '42501';
  end if;

  select status into v_status from venues where id = target_venue_id for update;
  if not found then
    raise exception 'VENUE_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_status <> 'unclaimed' then
    raise exception 'VENUE_NOT_CLAIMABLE' using errcode = '22023';
  end if;

  select email into claimant_email from auth.users where id = caller;
  if claimant_email is not null and position('@' in claimant_email) > 0 then
    email_host := lower(split_part(claimant_email, '@', 2));
  end if;
  if email_host is not null
     and not is_free_mail_host(email_host)
     and exists (select 1 from venue_link_hosts(target_venue_id) h where h = email_host)
  then
    matched := true;
  end if;

  insert into venue_claims (venue_id, claimant_id, note, status, verified_domain, reviewed_at)
  values (target_venue_id, caller, claim_note, 'approved', matched, now())
  returning * into claim;

  update venues set status = 'claimed', owner_id = caller where id = target_venue_id;

  return claim;
end;
$$;


ALTER FUNCTION "public"."request_venue_claim"("target_venue_id" "uuid", "claim_note" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."request_venue_claim"("target_venue_id" "uuid", "claim_note" "text") IS 'Self-serve claim: confers ownership immediately (venue → claimed, owner_id = caller) and records an approved venue_claims row with a verified_domain trust signal. Only an unclaimed venue is claimable (row-locked). SECURITY DEFINER; reached via the api requestClaim procedure. Moderation (approve/reject/denylist/suspend) remains the backstop.';


CREATE OR REPLACE FUNCTION "public"."search_offers"("q" "text", "max_results" integer DEFAULT 6) RETURNS TABLE("offer_id" "uuid", "title" "text", "venue_id" "uuid", "venue_name" "text", "venue_slug" "text", "locality" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."search_offers"("q" "text", "max_results" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."search_offers"("q" "text", "max_results" integer) IS 'Live venue offers matching q by offer title, venue name, or venue locality — powers the global search''s local Offers group. SECURITY INVOKER over world-readable offers/venues.';


CREATE OR REPLACE FUNCTION "public"."send_venue_notification"("p_venue" "uuid", "p_text" "text", "p_recipient" "uuid" DEFAULT NULL::"uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_uid     uuid := auth.uid();
  v_owner   uuid;
  v_name    text;
  v_text    text := btrim(coalesce(p_text, ''));
  v_payload jsonb;
  v_count   integer := 0;
begin
  if v_uid is null then
    raise exception 'send_venue_notification: no authenticated user' using errcode = '28000';
  end if;
  if length(v_text) = 0 then
    raise exception 'send_venue_notification: empty message' using errcode = '22023';
  end if;
  if length(v_text) > 500 then
    v_text := left(v_text, 500);
  end if;

  select owner_id, name into v_owner, v_name from public.venues where id = p_venue;
  if v_owner is null then
    raise exception 'send_venue_notification: venue not found' using errcode = 'P0002';
  end if;
  if v_owner <> v_uid then
    raise exception 'send_venue_notification: not the venue owner' using errcode = '42501';
  end if;

  v_payload := jsonb_build_object(
    'text', coalesce(nullif(btrim(v_name), ''), 'A business') || ': ' || v_text,
    'href', '/venue/' || p_venue::text,
    'venueId', p_venue,
    'venueName', v_name
  );

  if p_recipient is not null then
    -- Individual: only to a profile that actually follows the venue.
    insert into public.notifications (recipient_id, type, payload)
    select p_recipient, 'venue_message', v_payload
    where exists (
      select 1 from public.follows f where f.venue_id = p_venue and f.follower_id = p_recipient
    );
    get diagnostics v_count = row_count;
  else
    -- Collective: every follower (skip the owner if they follow their own venue).
    insert into public.notifications (recipient_id, type, payload)
    select f.follower_id, 'venue_message', v_payload
    from public.follows f
    where f.venue_id = p_venue and f.follower_id <> v_uid;
    get diagnostics v_count = row_count;
  end if;

  return v_count;
end;
$$;


ALTER FUNCTION "public"."send_venue_notification"("p_venue" "uuid", "p_text" "text", "p_recipient" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_event_geo"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_geo geography(Point, 4326);
begin
  if new.venue_id is not null then
    select geo into v_geo from venues where id = new.venue_id;
    if v_geo is not null then
      new.geo := v_geo;
      new.lat := st_y(v_geo::geometry);
      new.lng := st_x(v_geo::geometry);
      return new;
    end if;
  end if;

  if new.lat is not null and new.lng is not null then
    new.geo := st_setsrid(st_makepoint(new.lng, new.lat), 4326)::geography;
  else
    new.geo := null;
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."set_event_geo"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_my_location"("p_lat" double precision, "p_lng" double precision, "p_accuracy_m" double precision DEFAULT NULL::double precision, "p_ttl_hours" double precision DEFAULT 1) RETURNS timestamp with time zone
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
declare
  v_uid     uuid := auth.uid();
  v_expires timestamptz := now() + make_interval(hours => greatest(1, least(8, ceil(coalesce(p_ttl_hours, 1))::int)));
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  if p_lat is null or p_lng is null or p_lat < -90 or p_lat > 90 or p_lng < -180 or p_lng > 180 then
    raise exception 'invalid coordinates';
  end if;
  insert into friend_presence (profile_id, geo, geo_accuracy_m, geo_expires_at, updated_at)
  values (
    v_uid,
    st_setsrid(st_makepoint(p_lng, p_lat), 4326)::geography,
    p_accuracy_m,
    v_expires,
    now()
  )
  on conflict (profile_id) do update
    set geo            = excluded.geo,
        geo_accuracy_m = excluded.geo_accuracy_m,
        geo_expires_at = excluded.geo_expires_at,
        updated_at     = now();
  return v_expires;
end;
$$;


ALTER FUNCTION "public"."set_my_location"("p_lat" double precision, "p_lng" double precision, "p_accuracy_m" double precision, "p_ttl_hours" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_topic_slug"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := gen_unique_topic_slug(new.title, new.locality);
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."set_topic_slug"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_venue_photos_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_venue_photos_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_venue_slug"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if new.slug is null or btrim(new.slug) = '' then
    new.slug := gen_unique_venue_slug(new.name, new.locality);
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."set_venue_slug"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."stop_my_location"() RETURNS "void"
    LANGUAGE "sql" SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  update friend_presence
     set geo = null, geo_accuracy_m = null, geo_expires_at = null, updated_at = now()
   where profile_id = auth.uid();
$$;


ALTER FUNCTION "public"."stop_my_location"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."suggested_friends"("max_results" integer DEFAULT 12) RETURNS TABLE("id" "uuid", "handle" "text", "display_name" "text", "avatar_url" "text", "mutual_count" integer)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  with me as (select auth.uid() as uid),
  my_friends as (  -- ids of my accepted friends (edge in either direction)
    select case when f.requester_id = m.uid then f.addressee_id else f.requester_id end as fid
    from friendships f cross join me m
    where f.status = 'accepted' and (f.requester_id = m.uid or f.addressee_id = m.uid)
  ),
  fof as (         -- friends of my friends, tagged with the mutual (via) friend
    select case when f.requester_id = mf.fid then f.addressee_id else f.requester_id end as candidate,
           mf.fid as via
    from friendships f
    join my_friends mf on (f.requester_id = mf.fid or f.addressee_id = mf.fid)
    where f.status = 'accepted'
  ),
  agg as (
    select candidate, count(distinct via)::int as mutual_count
    from fof cross join me m
    where candidate <> m.uid
    group by candidate
  )
  select p.id, p.handle, p.display_name, p.avatar_url, a.mutual_count
  from agg a
  join profiles p on p.id = a.candidate
  cross join me m
  where p.banned_at is null
    and not exists (  -- skip anyone I already have an edge with (accepted OR pending, either way)
      select 1 from friendships x
      where (x.requester_id = m.uid and x.addressee_id = a.candidate)
         or (x.requester_id = a.candidate and x.addressee_id = m.uid)
    )
  order by a.mutual_count desc, p.created_at desc nulls last
  limit greatest(1, least(coalesce(max_results, 12), 50));
$$;


ALTER FUNCTION "public"."suggested_friends"("max_results" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tg_activity_follow"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  insert into venue_activity (venue_id, type, actor_id)
  values (new.venue_id, 'follow', new.follower_id);
  return new;
end;
$$;


ALTER FUNCTION "public"."tg_activity_follow"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tg_activity_offer_redeem"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_venue uuid; v_title text;
begin
  select venue_id, title into v_venue, v_title from offers where id = new.offer_id;
  if v_venue is not null then
    insert into venue_activity (venue_id, type, actor_id, payload)
    values (v_venue, 'offer_redeem', new.profile_id,
            jsonb_build_object('offerId', new.offer_id, 'offerTitle', v_title));
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."tg_activity_offer_redeem"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."tg_activity_offer_save"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare v_venue uuid; v_title text;
begin
  select venue_id, title into v_venue, v_title from offers where id = new.offer_id;
  if v_venue is not null then
    insert into venue_activity (venue_id, type, actor_id, payload)
    values (v_venue, 'offer_save', new.profile_id,
            jsonb_build_object('offerId', new.offer_id, 'offerTitle', v_title));
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."tg_activity_offer_save"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."thread_inbox"() RETURNS TABLE("thread_id" "uuid", "last_kind" "text", "last_body" "text", "last_sender_id" "uuid", "last_created_at" timestamp with time zone, "unread_count" integer)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  with mine as (
    select cp.thread_id, cp.last_read_at
    from chat_participants cp
    where cp.profile_id = auth.uid()
  ),
  visible as (
    select m.thread_id, m.kind, m.body, m.sender_id, m.created_at
    from chat_messages m
    join mine on mine.thread_id = m.thread_id
    where m.moderation in ('auto_approved', 'approved')
  ),
  last_msg as (
    select distinct on (v.thread_id)
      v.thread_id,
      v.kind        as last_kind,
      v.body        as last_body,
      v.sender_id   as last_sender_id,
      v.created_at  as last_created_at
    from visible v
    order by v.thread_id, v.created_at desc
  ),
  unread as (
    select v.thread_id, count(*)::int as unread_count
    from visible v
    join mine on mine.thread_id = v.thread_id
    where v.sender_id is distinct from auth.uid()
      and v.created_at > coalesce(mine.last_read_at, 'epoch'::timestamptz)
    group by v.thread_id
  )
  select
    mine.thread_id,
    lm.last_kind,
    lm.last_body,
    lm.last_sender_id,
    lm.last_created_at,
    coalesce(u.unread_count, 0) as unread_count
  from mine
  left join last_msg lm on lm.thread_id = mine.thread_id
  left join unread u on u.thread_id = mine.thread_id;
$$;


ALTER FUNCTION "public"."thread_inbox"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."town_hall_bump_replies"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    update town_hall_topics
      set reply_count = reply_count + 1, last_activity_at = now()
      where id = new.topic_id;
  elsif tg_op = 'DELETE' then
    update town_hall_topics
      set reply_count = greatest(0, reply_count - 1)
      where id = old.topic_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."town_hall_bump_replies"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."town_hall_bump_reply_upvotes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    update public.town_hall_replies set upvote_count = upvote_count + 1 where id = new.reply_id;
  elsif tg_op = 'DELETE' then
    update public.town_hall_replies set upvote_count = greatest(0, upvote_count - 1) where id = old.reply_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."town_hall_bump_reply_upvotes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."town_hall_bump_upvotes"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
begin
  if tg_op = 'INSERT' then
    update town_hall_topics set upvote_count = upvote_count + 1 where id = new.topic_id;
  elsif tg_op = 'DELETE' then
    update town_hall_topics set upvote_count = greatest(0, upvote_count - 1) where id = old.topic_id;
  end if;
  return null;
end;
$$;


ALTER FUNCTION "public"."town_hall_bump_upvotes"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."upsert_place_venues"("places" "jsonb") RETURNS TABLE("out_id" "uuid", "out_source_ref" "text", "out_was_claimed" boolean)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."upsert_place_venues"("places" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."upsert_place_venues"("places" "jsonb") IS 'Batch upsert of Google Places venues from a JSONB array. Inserts new unclaimed venues and refreshes still-unclaimed ones (name/geo/category/categories/rating/address/opening_times/rating_count/price_level/primary_type_label, bumping fetched_at); leaves CLAIMED venues untouched (owner_id is null guard). Builds geo lng-first. SECURITY DEFINER — reached only via the api internalProcedure.';


CREATE OR REPLACE FUNCTION "public"."upsert_venue_photos"("payload" "jsonb") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  elem        jsonb;
  photo       jsonb;
  v_id        uuid;
  v_unclaimed boolean;
  inserted    integer := 0;
begin
  if jsonb_typeof(payload) is distinct from 'array' then
    raise exception 'upsert_venue_photos expects a JSONB array, got %', jsonb_typeof(payload)
      using errcode = '22023';
  end if;

  for elem in select * from jsonb_array_elements(payload)
  loop
    v_id := (elem->>'venue_id')::uuid;
    if v_id is null then
      continue;
    end if;

    -- Guard: only operate on an UNCLAIMED venue (owner content frozen). If the venue is
    -- claimed or absent, skip it entirely — no delete, no insert.
    select (v.owner_id is null) into v_unclaimed
    from venues v
    where v.id = v_id;

    if v_unclaimed is distinct from true then
      continue;
    end if;

    -- REPLACE-ALL, scoped to scraped rows: clear this venue's google_places photos.
    delete from venue_photos
    where venue_id = v_id
      and source = 'google_places';

    -- Insert the fresh set, preserving Places' order via the array index as `position`.
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
  end loop;

  return inserted;
end;
$$;


ALTER FUNCTION "public"."upsert_venue_photos"("payload" "jsonb") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."upsert_venue_photos"("payload" "jsonb") IS 'Batch REPLACE-ALL of google_places photo rows in venue_photos from a JSONB array (one element per venue: { venue_id, photos[] }). Per UNCLAIMED venue, deletes the existing source=google_places rows then inserts the fresh mapped set; owner_upload rows and CLAIMED venues are never touched (owner_id is null guard). Returns the count of photo rows inserted. SECURITY DEFINER — reached only via the api internalProcedure.';


CREATE OR REPLACE FUNCTION "public"."venue_audience_stats"("p_venue" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  total       int;
  new30       int;
  engaged30   int;
  push_reach  int;
  dob_sample  int;
  bdays_month int;
  bands       jsonb;
  min_total   int := 5;   -- floor for any count-of-people demographic (birthdays)
  min_demo    int := 8;   -- floor for the age-band distribution
begin
  if not exists (select 1 from venues v where v.id = p_venue and v.owner_id = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;

  select count(*) into total from follows f where f.venue_id = p_venue;
  select count(*) into new30 from follows f
    where f.venue_id = p_venue and f.created_at >= now() - interval '30 days';

  -- Engaged: followers who saved OR redeemed one of this venue's offers in the last 30 days.
  select count(distinct u) into engaged30 from (
    select s.profile_id as u
      from offer_saves s join offers o on o.id = s.offer_id
      where o.venue_id = p_venue and s.created_at >= now() - interval '30 days'
        and s.profile_id in (select follower_id from follows where venue_id = p_venue)
    union
    select r.profile_id as u
      from offer_redemptions r join offers o on o.id = r.offer_id
      where o.venue_id = p_venue and r.redeemed_at >= now() - interval '30 days'
        and r.profile_id in (select follower_id from follows where venue_id = p_venue)
  ) e;

  -- Push reach: followers who could actually receive a push (subscribed + not muted).
  select count(distinct f.follower_id) into push_reach
    from follows f
    join push_subscriptions ps on ps.profile_id = f.follower_id
    where f.venue_id = p_venue and coalesce(ps.consent, true) = true and f.push_enabled = true;

  -- DOB sample: followers who've shared a birth date at all.
  select count(*) into dob_sample
    from follows f join user_private up on up.user_id = f.follower_id
    where f.venue_id = p_venue and up.birth_date is not null;

  -- Birthdays this month among opted-in followers (the reachable birthday audience).
  select count(*) into bdays_month
    from follows f join user_private up on up.user_id = f.follower_id
    where f.venue_id = p_venue
      and up.birthday_offers_enabled = true and up.birth_date is not null
      and extract(month from up.birth_date) = extract(month from now());

  if dob_sample >= min_demo then
    select jsonb_object_agg(band, cnt) into bands from (
      select band, count(*)::int as cnt from (
        select case
          when age < 18 then 'under_18'
          when age between 18 and 24 then 'age_18_24'
          when age between 25 and 34 then 'age_25_34'
          when age between 35 and 44 then 'age_35_44'
          when age between 45 and 54 then 'age_45_54'
          when age between 55 and 64 then 'age_55_64'
          else 'age_65_plus'
        end as band
        from (
          select extract(year from age(up.birth_date))::int as age
          from follows f join user_private up on up.user_id = f.follower_id
          where f.venue_id = p_venue and up.birth_date is not null
        ) ages
      ) banded
      group by band
    ) agg;
  else
    bands := null;
  end if;

  return jsonb_build_object(
    'followers', total,
    'new30', new30,
    'engaged30', engaged30,
    'pushReach', push_reach,
    'birthdaysThisMonth', case when total >= min_total then bdays_month else null end,
    'ageBands', bands,
    'dobSample', dob_sample
  );
end;
$$;


ALTER FUNCTION "public"."venue_audience_stats"("p_venue" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."venue_birthday_stats"("p_venue" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  sent_month int; sent_total int; red_month int; red_total int;
begin
  if not exists (select 1 from venues v where v.id = p_venue and v.owner_id = auth.uid()) then
    raise exception 'NOT_OWNER' using errcode = '42501';
  end if;
  select
    count(*) filter (where delivered_on >= date_trunc('month', now())),
    count(*),
    count(*) filter (where redeemed_at is not null and redeemed_at >= date_trunc('month', now())),
    count(*) filter (where redeemed_at is not null)
  into sent_month, sent_total, red_month, red_total
  from birthday_deliveries where venue_id = p_venue;
  return jsonb_build_object(
    'sentThisMonth', coalesce(sent_month, 0),
    'sentTotal', coalesce(sent_total, 0),
    'redeemedThisMonth', coalesce(red_month, 0),
    'redeemedTotal', coalesce(red_total, 0)
  );
end;
$$;


ALTER FUNCTION "public"."venue_birthday_stats"("p_venue" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."venue_link_hosts"("target_venue_id" "uuid") RETURNS SETOF "text"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $_$
  select host from (
    select distinct lower(
      regexp_replace(
        regexp_replace(value, '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/?#]+).*$', '\1'),
        '^www\.', ''
      )
    ) as host
    from venues v,
         lateral jsonb_each_text(coalesce(v.links, '{}'::jsonb)) as l(key, value)
    where v.id = target_venue_id
      and value ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/?#]+'
  ) hosts
  where not is_non_evidence_host(host);
$_$;


ALTER FUNCTION "public"."venue_link_hosts"("target_venue_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."venue_link_hosts"("target_venue_id" "uuid") IS 'Registrable hosts (www-stripped, lowercased) parsed from a venue''s links jsonb, with non-evidence hosts (free-mail + aggregators/social/link-in-bio, per is_non_evidence_host) filtered OUT at source. The clean evidence set the email-domain auto-match checks a claimant''s email host against. Empty when the venue advertises no own-domain link URLs.';


CREATE OR REPLACE FUNCTION "public"."venue_offer_engagement"("p_venue" "uuid") RETURNS TABLE("offer_type" "text", "offers" bigint, "saves" bigint, "redemptions" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."venue_offer_engagement"("p_venue" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."venue_review_histogram"("venue_id_param" "uuid") RETURNS TABLE("stars" integer, "cnt" integer)
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  with scale as (select generate_series(1, 5) as stars)
  select scale.stars,
         coalesce(count(r.*), 0)::int as cnt
  from scale
  left join venue_reviews r
    on r.venue_id = venue_id_param
   and r.rating = scale.stars
   and r.moderation in ('auto_approved', 'approved')
  group by scale.stars
  order by scale.stars desc;
$$;


ALTER FUNCTION "public"."venue_review_histogram"("venue_id_param" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."venue_review_histogram"("venue_id_param" "uuid") IS 'Per-star (5→1) counts of a venue''s approved Roam reviews, zero-filled. Powers the rating distribution bars (Google gives no breakdown; Roam is the only real source). SECURITY INVOKER.';


CREATE OR REPLACE FUNCTION "public"."venue_reviews_list"("venue_id_param" "uuid", "max_results" integer DEFAULT 20, "page_offset" integer DEFAULT 0) RETURNS TABLE("id" "uuid", "rating" integer, "body" "text", "created_at" timestamp with time zone, "updated_at" timestamp with time zone, "author_id" "uuid", "author_name" "text", "author_handle" "text", "author_avatar" "text")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select r.id, r.rating, r.body, r.created_at, r.updated_at,
         r.author_id, p.display_name, p.handle, p.avatar_url
  from venue_reviews r
  join profiles p on p.id = r.author_id
  where r.venue_id = venue_id_param
    and r.moderation in ('auto_approved', 'approved')
  order by r.created_at desc
  limit greatest(1, least(coalesce(max_results, 20), 50))
  offset greatest(0, coalesce(page_offset, 0));
$$;


ALTER FUNCTION "public"."venue_reviews_list"("venue_id_param" "uuid", "max_results" integer, "page_offset" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."venue_reviews_refresh_rollup"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_id uuid := coalesce(new.venue_id, old.venue_id);
begin
  update venues v
  set roam_rating       = sub.avg_rating,
      roam_rating_count = sub.cnt
  from (
    select round(avg(rating)::numeric, 1) as avg_rating, count(*)::int as cnt
    from venue_reviews
    where venue_id = v_id and moderation in ('auto_approved', 'approved')
  ) sub
  where v.id = v_id;
  return null;
end;
$$;


ALTER FUNCTION "public"."venue_reviews_refresh_rollup"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."venues_in_category_near"("filter_category" "text", "origin_lat" double precision, "origin_lng" double precision, "page_size" integer DEFAULT 10, "page_offset" integer DEFAULT 0) RETURNS TABLE("id" "uuid", "name" "text", "owner_id" "uuid", "status" "public"."venue_status", "category" "text", "categories" "text"[], "rating" numeric, "rating_count" integer, "price_level" "text", "primary_type_label" "text", "business_status" "text", "distance_m" double precision, "lat_out" double precision, "lng_out" double precision, "cover_photo_id" "uuid")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id
  from venues v
  where v.category = filter_category
    and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  order by (v.owner_id is not null
      and st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)) desc,
    v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(page_size, 10), 100)) + 1
  offset greatest(0, coalesce(page_offset, 0));
$$;


ALTER FUNCTION "public"."venues_in_category_near"("filter_category" "text", "origin_lat" double precision, "origin_lng" double precision, "page_size" integer, "page_offset" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."venues_in_category_near"("filter_category" "text", "origin_lat" double precision, "origin_lng" double precision, "page_size" integer, "page_offset" integer) IS 'Category browse capped to 18 km (NEARBY_RADIUS_M) so a town''s results never include a neighbouring city.';


CREATE OR REPLACE FUNCTION "public"."venues_near"("origin_lat" double precision, "origin_lng" double precision, "max_results" integer DEFAULT 50) RETURNS TABLE("id" "uuid", "name" "text", "owner_id" "uuid", "status" "public"."venue_status", "category" "text", "categories" "text"[], "rating" numeric, "rating_count" integer, "price_level" "text", "primary_type_label" "text", "business_status" "text", "distance_m" double precision, "lat_out" double precision, "lng_out" double precision, "cover_photo_id" "uuid")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
  select v.id, v.name, v.owner_id, v.status, v.category, v.categories, v.rating, v.rating_count,
    v.price_level, v.primary_type_label, v.business_status,
    st_distance(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography) as distance_m,
    st_y(v.geo::geometry) as lat_out, st_x(v.geo::geometry) as lng_out,
    (select p.id from venue_photos p where p.venue_id = v.id
     order by p.is_cover desc, (p.source = 'owner_upload') desc, p.position asc limit 1) as cover_photo_id
  from venues v
  where st_dwithin(v.geo, st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography, 18000)
    and v.business_status is distinct from 'CLOSED_PERMANENTLY'
  order by v.geo <-> st_setsrid(st_makepoint(origin_lng, origin_lat), 4326)::geography
  limit greatest(1, least(coalesce(max_results, 50), 100));
$$;


ALTER FUNCTION "public"."venues_near"("origin_lat" double precision, "origin_lng" double precision, "max_results" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."venues_near"("origin_lat" double precision, "origin_lng" double precision, "max_results" integer) IS 'Near→far venue browse from an (origin_lat, origin_lng) origin, capped to 18 km (NEARBY_RADIUS_M) so a town''s results never include a neighbouring city. origin_* params are unshadowable by venues.lat/lng.';


CREATE OR REPLACE FUNCTION "public"."venues_search_by_name"("q" "text", "origin_lat" double precision, "origin_lng" double precision, "max_results" integer DEFAULT 20) RETURNS TABLE("id" "uuid", "name" "text", "owner_id" "uuid", "status" "public"."venue_status", "category" "text", "categories" "text"[], "rating" numeric, "rating_count" integer, "price_level" "text", "primary_type_label" "text", "business_status" "text", "distance_m" double precision, "lat_out" double precision, "lng_out" double precision, "cover_photo_id" "uuid")
    LANGUAGE "sql" STABLE
    SET "search_path" TO 'public'
    AS $$
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


ALTER FUNCTION "public"."venues_search_by_name"("q" "text", "origin_lat" double precision, "origin_lng" double precision, "max_results" integer) OWNER TO "postgres";


COMMENT ON FUNCTION "public"."venues_search_by_name"("q" "text", "origin_lat" double precision, "origin_lng" double precision, "max_results" integer) IS 'Local-first venue name search (0078; token-AND matching in 0106). Every meaningful query word must appear in the venue name/locality/region/category, so "duke of york belfast" finds the Belfast venue named "Duke of York". Distance-ordered; hides permanently-closed venues.';


ALTER TABLE ONLY "public"."chat_messages" REPLICA IDENTITY FULL;


COMMENT ON CONSTRAINT "venues_opening_times_owner_shape" ON "public"."venues" IS 'Slice 8 owner-hours invariant: if opening_times carries a `periods` array it MUST be a jsonb array AND source MUST be ''owner''. Permissive of NULL and the legacy Places shape (which has no periods key). Fine per-interval validation lives in the pure validator (packages/api/src/venue-hours.ts), not here — single source of truth.';


ALTER TABLE ONLY "public"."admin_audit_log"
    ADD CONSTRAINT "admin_audit_log_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."automation_journeys"
    ADD CONSTRAINT "automation_journeys_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."awin_deals"
    ADD CONSTRAINT "awin_deals_awin_promotion_id_key" UNIQUE ("awin_promotion_id");


ALTER TABLE ONLY "public"."awin_deals"
    ADD CONSTRAINT "awin_deals_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."billing_customers"
    ADD CONSTRAINT "billing_customers_pkey" PRIMARY KEY ("venue_id");


ALTER TABLE ONLY "public"."billing_customers"
    ADD CONSTRAINT "billing_customers_stripe_customer_id_key" UNIQUE ("stripe_customer_id");


ALTER TABLE ONLY "public"."billing_transactions"
    ADD CONSTRAINT "billing_transactions_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."billing_transactions"
    ADD CONSTRAINT "billing_transactions_stripe_payment_intent_key" UNIQUE ("stripe_payment_intent");


ALTER TABLE ONLY "public"."birthday_deliveries"
    ADD CONSTRAINT "birthday_deliveries_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."birthday_deliveries"
    ADD CONSTRAINT "birthday_deliveries_venue_id_user_id_delivered_on_key" UNIQUE ("venue_id", "user_id", "delivered_on");


ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_pkey" PRIMARY KEY ("thread_id", "profile_id");


ALTER TABLE ONLY "public"."chat_poll_votes"
    ADD CONSTRAINT "chat_poll_votes_pkey" PRIMARY KEY ("message_id", "option_id", "profile_id");


ALTER TABLE ONLY "public"."chat_polls"
    ADD CONSTRAINT "chat_polls_pkey" PRIMARY KEY ("message_id");


ALTER TABLE ONLY "public"."chat_threads"
    ADD CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."cj_advertisers"
    ADD CONSTRAINT "cj_advertisers_pkey" PRIMARY KEY ("advertiser_id");


ALTER TABLE ONLY "public"."cj_deals"
    ADD CONSTRAINT "cj_deals_cj_link_id_key" UNIQUE ("cj_link_id");


ALTER TABLE ONLY "public"."cj_deals"
    ADD CONSTRAINT "cj_deals_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."event_interest"
    ADD CONSTRAINT "event_interest_pkey" PRIMARY KEY ("event_id", "user_id");


ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("key");


ALTER TABLE ONLY "public"."follows"
    ADD CONSTRAINT "follows_pkey" PRIMARY KEY ("follower_id", "venue_id");


ALTER TABLE ONLY "public"."friend_presence"
    ADD CONSTRAINT "friend_presence_pkey" PRIMARY KEY ("profile_id");


ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_pkey" PRIMARY KEY ("requester_id", "addressee_id");


ALTER TABLE ONLY "public"."market_listings"
    ADD CONSTRAINT "market_listings_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."meetup_locations"
    ADD CONSTRAINT "meetup_locations_pkey" PRIMARY KEY ("meetup_id", "profile_id");


ALTER TABLE ONLY "public"."meetup_options"
    ADD CONSTRAINT "meetup_options_meetup_id_venue_id_key" UNIQUE ("meetup_id", "venue_id");


ALTER TABLE ONLY "public"."meetup_options"
    ADD CONSTRAINT "meetup_options_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."meetup_votes"
    ADD CONSTRAINT "meetup_votes_pkey" PRIMARY KEY ("meetup_id", "voter_id");


ALTER TABLE ONLY "public"."meetups"
    ADD CONSTRAINT "meetups_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."moderation_queue"
    ADD CONSTRAINT "moderation_queue_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."offer_redemptions"
    ADD CONSTRAINT "offer_redemptions_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."offer_saves"
    ADD CONSTRAINT "offer_saves_pkey" PRIMARY KEY ("offer_id", "profile_id");


ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_redeem_code_key" UNIQUE ("redeem_code");


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_stripe_checkout_session_id_key" UNIQUE ("stripe_checkout_session_id");


ALTER TABLE ONLY "public"."places_fetch_quota"
    ADD CONSTRAINT "places_fetch_quota_pkey" PRIMARY KEY ("bucket", "window_start");


ALTER TABLE ONLY "public"."plan_members"
    ADD CONSTRAINT "plan_members_pkey" PRIMARY KEY ("plan_id", "profile_id");


ALTER TABLE ONLY "public"."plan_venues"
    ADD CONSTRAINT "plan_venues_pkey" PRIMARY KEY ("plan_id", "venue_id");


ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."posts_comments"
    ADD CONSTRAINT "posts_comments_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."posts_likes"
    ADD CONSTRAINT "posts_likes_pkey" PRIMARY KEY ("post_id", "liker_id");


ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."presence_alerts"
    ADD CONSTRAINT "presence_alerts_pkey" PRIMARY KEY ("from_id", "to_id");


ALTER TABLE ONLY "public"."profile_post_comments"
    ADD CONSTRAINT "profile_post_comments_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."profile_post_likes"
    ADD CONSTRAINT "profile_post_likes_pkey" PRIMARY KEY ("post_id", "liker_id");


ALTER TABLE ONLY "public"."profile_posts"
    ADD CONSTRAINT "profile_posts_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_handle_key" UNIQUE ("handle");


ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."push_credit_ledger"
    ADD CONSTRAINT "push_credit_ledger_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_profile_id_token_key" UNIQUE ("profile_id", "token");


ALTER TABLE ONLY "public"."saved_transit_stops"
    ADD CONSTRAINT "saved_transit_stops_pkey" PRIMARY KEY ("profile_id", "stop_id");


ALTER TABLE ONLY "public"."shop_orders"
    ADD CONSTRAINT "shop_orders_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."shop_products"
    ADD CONSTRAINT "shop_products_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."town_hall_replies"
    ADD CONSTRAINT "town_hall_replies_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."town_hall_reply_votes"
    ADD CONSTRAINT "town_hall_reply_votes_pkey" PRIMARY KEY ("reply_id", "voter_id");


ALTER TABLE ONLY "public"."town_hall_topics"
    ADD CONSTRAINT "town_hall_topics_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."town_hall_votes"
    ADD CONSTRAINT "town_hall_votes_pkey" PRIMARY KEY ("topic_id", "voter_id");


ALTER TABLE ONLY "public"."trip_stops"
    ADD CONSTRAINT "trip_stops_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."trips"
    ADD CONSTRAINT "trips_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_pkey" PRIMARY KEY ("blocker_id", "blocked_id");


ALTER TABLE ONLY "public"."user_private"
    ADD CONSTRAINT "user_private_pkey" PRIMARY KEY ("user_id");


ALTER TABLE ONLY "public"."venue_activity"
    ADD CONSTRAINT "venue_activity_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."venue_birthday_offer"
    ADD CONSTRAINT "venue_birthday_offer_pkey" PRIMARY KEY ("venue_id");


ALTER TABLE ONLY "public"."venue_claims"
    ADD CONSTRAINT "venue_claims_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."venue_marketing_prefs"
    ADD CONSTRAINT "venue_marketing_prefs_pkey" PRIMARY KEY ("venue_id");


ALTER TABLE ONLY "public"."venue_payment_accounts"
    ADD CONSTRAINT "venue_payment_accounts_pkey" PRIMARY KEY ("venue_id");


ALTER TABLE ONLY "public"."venue_payment_accounts"
    ADD CONSTRAINT "venue_payment_accounts_stripe_account_id_key" UNIQUE ("stripe_account_id");


ALTER TABLE ONLY "public"."venue_photos"
    ADD CONSTRAINT "venue_photos_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."venue_products"
    ADD CONSTRAINT "venue_products_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."venue_reviews"
    ADD CONSTRAINT "venue_reviews_one_per_author" UNIQUE ("venue_id", "author_id");


ALTER TABLE ONLY "public"."venue_reviews"
    ADD CONSTRAINT "venue_reviews_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."venue_views"
    ADD CONSTRAINT "venue_views_pkey" PRIMARY KEY ("venue_id", "day");


ALTER TABLE ONLY "public"."venues"
    ADD CONSTRAINT "venues_pkey" PRIMARY KEY ("id");


ALTER TABLE ONLY "public"."venues"
    ADD CONSTRAINT "venues_source_source_ref_key" UNIQUE ("source", "source_ref");


CREATE INDEX "awin_deals_live_idx" ON "public"."awin_deals" USING "btree" ("active", "ends_at", "created_at" DESC);


CREATE INDEX "chat_poll_votes_message_idx" ON "public"."chat_poll_votes" USING "btree" ("message_id");


CREATE INDEX "cj_deals_live_idx" ON "public"."cj_deals" USING "btree" ("active", "ends_at", "created_at" DESC);


CREATE INDEX "idx_admin_audit_created" ON "public"."admin_audit_log" USING "btree" ("created_at" DESC);


CREATE INDEX "idx_awin_deals_title_trgm" ON "public"."awin_deals" USING "gin" ("title" "public"."gin_trgm_ops");


CREATE INDEX "idx_billing_tx_venue" ON "public"."billing_transactions" USING "btree" ("venue_id", "created_at");


CREATE INDEX "idx_chat_messages_thread" ON "public"."chat_messages" USING "btree" ("thread_id", "created_at");


CREATE INDEX "idx_events_geo" ON "public"."events" USING "gist" ("geo");


CREATE INDEX "idx_events_locality_upcoming" ON "public"."events" USING "btree" ("locality", "starts_at");


CREATE INDEX "idx_events_starts" ON "public"."events" USING "btree" ("starts_at");


CREATE INDEX "idx_events_title_trgm" ON "public"."events" USING "gin" ("title" "public"."gin_trgm_ops");


CREATE INDEX "idx_events_venue" ON "public"."events" USING "btree" ("venue_id") WHERE ("venue_id" IS NOT NULL);


CREATE INDEX "idx_follows_venue" ON "public"."follows" USING "btree" ("venue_id");


CREATE INDEX "idx_friend_presence_geo" ON "public"."friend_presence" USING "gist" ("geo");


CREATE INDEX "idx_friendships_addressee" ON "public"."friendships" USING "btree" ("addressee_id", "status");


CREATE INDEX "idx_market_listings_title_trgm" ON "public"."market_listings" USING "gin" ("title" "public"."gin_trgm_ops");


CREATE INDEX "idx_meetups_thread" ON "public"."meetups" USING "btree" ("thread_id");


CREATE INDEX "idx_moderation_pending" ON "public"."moderation_queue" USING "btree" ("status", "created_at") WHERE ("status" = 'pending'::"public"."moderation_status");


CREATE INDEX "idx_notifications_coalesce" ON "public"."notifications" USING "btree" ("recipient_id", "type", "entity_id") WHERE ("read_at" IS NULL);


CREATE INDEX "idx_notifications_recipient" ON "public"."notifications" USING "btree" ("recipient_id", "created_at" DESC);


CREATE INDEX "idx_notifications_unread" ON "public"."notifications" USING "btree" ("recipient_id") WHERE ("read_at" IS NULL);


CREATE UNIQUE INDEX "idx_offer_redemptions_user" ON "public"."offer_redemptions" USING "btree" ("offer_id", "profile_id") WHERE ("profile_id" IS NOT NULL);


CREATE INDEX "idx_plans_title_trgm" ON "public"."plans" USING "gin" ("title" "public"."gin_trgm_ops");


CREATE INDEX "idx_posts_comments_post" ON "public"."posts_comments" USING "btree" ("post_id", "created_at");


CREATE INDEX "idx_posts_feed" ON "public"."posts" USING "btree" ("published_at" DESC) WHERE ('feed'::"public"."post_destination" = ANY ("destinations"));


CREATE INDEX "idx_posts_venue" ON "public"."posts" USING "btree" ("venue_id", "published_at" DESC);


CREATE INDEX "idx_profile_post_comments_post" ON "public"."profile_post_comments" USING "btree" ("post_id", "created_at");


CREATE INDEX "idx_profile_posts_author" ON "public"."profile_posts" USING "btree" ("author_id", "created_at" DESC);


CREATE INDEX "idx_profiles_display_name_trgm" ON "public"."profiles" USING "gin" ("display_name" "public"."gin_trgm_ops");


CREATE INDEX "idx_profiles_handle_trgm" ON "public"."profiles" USING "gin" ("handle" "public"."gin_trgm_ops");


CREATE INDEX "idx_profiles_invited_by" ON "public"."profiles" USING "btree" ("invited_by");


CREATE INDEX "idx_push_ledger_venue" ON "public"."push_credit_ledger" USING "btree" ("venue_id", "created_at");


CREATE INDEX "idx_redemptions_offer" ON "public"."offer_redemptions" USING "btree" ("offer_id");


CREATE INDEX "idx_saved_transit_stops_owner" ON "public"."saved_transit_stops" USING "btree" ("profile_id", "created_at" DESC);


CREATE INDEX "idx_town_hall_replies_topic" ON "public"."town_hall_replies" USING "btree" ("topic_id", "created_at");


CREATE INDEX "idx_town_hall_topics_category" ON "public"."town_hall_topics" USING "btree" ("locality", "category");


CREATE INDEX "idx_town_hall_topics_founder" ON "public"."town_hall_topics" USING "btree" ("locality", "author_id", "created_at") WHERE ("author_id" IS NOT NULL);


CREATE UNIQUE INDEX "idx_town_hall_topics_locality_slug" ON "public"."town_hall_topics" USING "btree" ("locality", "slug");


CREATE INDEX "idx_town_hall_topics_popular" ON "public"."town_hall_topics" USING "btree" ("locality", "upvote_count" DESC, "last_activity_at" DESC);


CREATE INDEX "idx_town_hall_topics_recent" ON "public"."town_hall_topics" USING "btree" ("locality", "last_activity_at" DESC);


CREATE INDEX "idx_town_hall_topics_title_trgm" ON "public"."town_hall_topics" USING "gin" ("title" "public"."gin_trgm_ops");


CREATE INDEX "idx_venue_claims_claimant" ON "public"."venue_claims" USING "btree" ("claimant_id", "created_at" DESC);


CREATE INDEX "idx_venue_claims_venue" ON "public"."venue_claims" USING "btree" ("venue_id", "created_at" DESC);


CREATE INDEX "idx_venue_photos_cover" ON "public"."venue_photos" USING "btree" ("venue_id") WHERE "is_cover";


CREATE INDEX "idx_venue_photos_venue_position" ON "public"."venue_photos" USING "btree" ("venue_id", "position");


CREATE INDEX "idx_venue_reviews_venue" ON "public"."venue_reviews" USING "btree" ("venue_id", "created_at" DESC);


CREATE INDEX "idx_venues_categories" ON "public"."venues" USING "gin" ("categories");


CREATE INDEX "idx_venues_geo" ON "public"."venues" USING "gist" ("geo");


CREATE INDEX "idx_venues_name_trgm" ON "public"."venues" USING "gin" ("name" "public"."gin_trgm_ops");


CREATE INDEX "idx_venues_owner" ON "public"."venues" USING "btree" ("owner_id");


CREATE INDEX "idx_venues_places_fetched" ON "public"."venues" USING "btree" ("fetched_at") WHERE ("source" = 'google_places'::"text");


CREATE UNIQUE INDEX "idx_venues_slug" ON "public"."venues" USING "btree" ("slug");


CREATE INDEX "idx_venues_status" ON "public"."venues" USING "btree" ("status");


CREATE INDEX "market_listings_browse_idx" ON "public"."market_listings" USING "btree" ("status", "created_at" DESC);


CREATE INDEX "market_listings_owner_idx" ON "public"."market_listings" USING "btree" ("owner_id", "created_at" DESC);


CREATE INDEX "offers_venue_type_idx" ON "public"."offers" USING "btree" ("venue_id", "offer_type");


CREATE INDEX "orders_buyer_idx" ON "public"."orders" USING "btree" ("buyer_id", "created_at" DESC);


CREATE INDEX "orders_venue_idx" ON "public"."orders" USING "btree" ("venue_id", "created_at" DESC);


CREATE UNIQUE INDEX "uq_chat_threads_plan" ON "public"."chat_threads" USING "btree" ("plan_id") WHERE ("plan_id" IS NOT NULL);


CREATE UNIQUE INDEX "uq_venue_claims_one_pending" ON "public"."venue_claims" USING "btree" ("venue_id", "claimant_id") WHERE ("status" = 'pending'::"public"."venue_claim_status");


CREATE INDEX "venue_activity_unread_idx" ON "public"."venue_activity" USING "btree" ("venue_id") WHERE ("read_at" IS NULL);


CREATE INDEX "venue_activity_venue_created_idx" ON "public"."venue_activity" USING "btree" ("venue_id", "created_at" DESC);


CREATE UNIQUE INDEX "venue_photos_one_cover" ON "public"."venue_photos" USING "btree" ("venue_id") WHERE "is_cover";


CREATE UNIQUE INDEX "venue_photos_places_ref" ON "public"."venue_photos" USING "btree" ("venue_id", "places_photo_ref") WHERE ("places_photo_ref" IS NOT NULL);


CREATE INDEX "venue_products_venue_idx" ON "public"."venue_products" USING "btree" ("venue_id", "active", "created_at" DESC);


CREATE OR REPLACE TRIGGER "market_listings_updated_at" BEFORE UPDATE ON "public"."market_listings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "orders_updated_at" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_activity_follow" AFTER INSERT ON "public"."follows" FOR EACH ROW EXECUTE FUNCTION "public"."tg_activity_follow"();


CREATE OR REPLACE TRIGGER "trg_activity_offer_redeem" AFTER INSERT ON "public"."offer_redemptions" FOR EACH ROW EXECUTE FUNCTION "public"."tg_activity_offer_redeem"();


CREATE OR REPLACE TRIGGER "trg_activity_offer_save" AFTER INSERT ON "public"."offer_saves" FOR EACH ROW EXECUTE FUNCTION "public"."tg_activity_offer_save"();


CREATE OR REPLACE TRIGGER "trg_automation_updated" BEFORE UPDATE ON "public"."automation_journeys" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_billing_customers_updated" BEFORE UPDATE ON "public"."billing_customers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_chat_threads_updated" BEFORE UPDATE ON "public"."chat_threads" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_event_interest_count" AFTER INSERT OR DELETE ON "public"."event_interest" FOR EACH ROW EXECUTE FUNCTION "public"."events_bump_interest"();


CREATE OR REPLACE TRIGGER "trg_events_set_geo" BEFORE INSERT OR UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "public"."set_event_geo"();


CREATE OR REPLACE TRIGGER "trg_events_updated" BEFORE UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_friendships_updated" BEFORE UPDATE ON "public"."friendships" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_notify_business_post_comment" AFTER INSERT ON "public"."posts_comments" FOR EACH ROW EXECUTE FUNCTION "public"."notify_business_post_comment"();


CREATE OR REPLACE TRIGGER "trg_notify_business_post_like" AFTER INSERT ON "public"."posts_likes" FOR EACH ROW EXECUTE FUNCTION "public"."notify_business_post_like"();


CREATE OR REPLACE TRIGGER "trg_notify_event_cancelled" AFTER UPDATE ON "public"."events" FOR EACH ROW EXECUTE FUNCTION "public"."notify_event_cancelled"();


CREATE OR REPLACE TRIGGER "trg_notify_event_interest" AFTER INSERT ON "public"."event_interest" FOR EACH ROW EXECUTE FUNCTION "public"."notify_event_interest"();


CREATE OR REPLACE TRIGGER "trg_notify_friend_event" AFTER INSERT OR UPDATE ON "public"."friendships" FOR EACH ROW EXECUTE FUNCTION "public"."notify_friend_event"();


CREATE OR REPLACE TRIGGER "trg_notify_locality_newcomer" AFTER INSERT ON "public"."town_hall_topics" FOR EACH ROW EXECUTE FUNCTION "public"."notify_locality_newcomer"();


CREATE OR REPLACE TRIGGER "trg_notify_offer_followers" AFTER INSERT ON "public"."offers" FOR EACH ROW EXECUTE FUNCTION "public"."notify_offer_followers"();


CREATE OR REPLACE TRIGGER "trg_notify_plan_member" AFTER INSERT ON "public"."plan_members" FOR EACH ROW EXECUTE FUNCTION "public"."notify_plan_member"();


CREATE OR REPLACE TRIGGER "trg_notify_post_like" AFTER INSERT ON "public"."profile_post_likes" FOR EACH ROW EXECUTE FUNCTION "public"."notify_post_like"();


CREATE OR REPLACE TRIGGER "trg_notify_reply_upvote" AFTER INSERT ON "public"."town_hall_reply_votes" FOR EACH ROW EXECUTE FUNCTION "public"."notify_reply_upvote"();


CREATE OR REPLACE TRIGGER "trg_notify_topic_upvote" AFTER INSERT ON "public"."town_hall_votes" FOR EACH ROW EXECUTE FUNCTION "public"."notify_topic_upvote"();


CREATE OR REPLACE TRIGGER "trg_notify_townhall_reply" AFTER INSERT ON "public"."town_hall_replies" FOR EACH ROW EXECUTE FUNCTION "public"."notify_townhall_reply"();


CREATE OR REPLACE TRIGGER "trg_notify_venue_claim" AFTER UPDATE ON "public"."venue_claims" FOR EACH ROW EXECUTE FUNCTION "public"."notify_venue_claim"();


CREATE OR REPLACE TRIGGER "trg_notify_venue_follow" AFTER INSERT ON "public"."follows" FOR EACH ROW EXECUTE FUNCTION "public"."notify_venue_follow"();


CREATE OR REPLACE TRIGGER "trg_notify_venue_review" AFTER INSERT ON "public"."venue_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."notify_venue_review"();


CREATE OR REPLACE TRIGGER "trg_notify_wall_comment" AFTER INSERT ON "public"."profile_post_comments" FOR EACH ROW EXECUTE FUNCTION "public"."notify_wall_comment"();


CREATE OR REPLACE TRIGGER "trg_offers_updated" BEFORE UPDATE ON "public"."offers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_plans_updated" BEFORE UPDATE ON "public"."plans" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_posts_comments_count" AFTER INSERT OR DELETE ON "public"."posts_comments" FOR EACH ROW EXECUTE FUNCTION "public"."posts_bump_comments"();


CREATE OR REPLACE TRIGGER "trg_posts_comments_updated" BEFORE UPDATE ON "public"."posts_comments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_posts_likes_count" AFTER INSERT OR DELETE ON "public"."posts_likes" FOR EACH ROW EXECUTE FUNCTION "public"."posts_bump_likes"();


CREATE OR REPLACE TRIGGER "trg_posts_updated" BEFORE UPDATE ON "public"."posts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_profile_post_comments_count" AFTER INSERT OR DELETE ON "public"."profile_post_comments" FOR EACH ROW EXECUTE FUNCTION "public"."profile_post_bump_comments"();


CREATE OR REPLACE TRIGGER "trg_profile_post_comments_updated" BEFORE UPDATE ON "public"."profile_post_comments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_profile_post_likes_count" AFTER INSERT OR DELETE ON "public"."profile_post_likes" FOR EACH ROW EXECUTE FUNCTION "public"."profile_post_bump_likes"();


CREATE OR REPLACE TRIGGER "trg_profile_posts_updated" BEFORE UPDATE ON "public"."profile_posts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_profiles_updated" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_shop_products_updated" BEFORE UPDATE ON "public"."shop_products" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_town_hall_replies_count" AFTER INSERT OR DELETE ON "public"."town_hall_replies" FOR EACH ROW EXECUTE FUNCTION "public"."town_hall_bump_replies"();


CREATE OR REPLACE TRIGGER "trg_town_hall_replies_updated" BEFORE UPDATE ON "public"."town_hall_replies" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_town_hall_reply_votes_count" AFTER INSERT OR DELETE ON "public"."town_hall_reply_votes" FOR EACH ROW EXECUTE FUNCTION "public"."town_hall_bump_reply_upvotes"();


CREATE OR REPLACE TRIGGER "trg_town_hall_topics_slug" BEFORE INSERT ON "public"."town_hall_topics" FOR EACH ROW EXECUTE FUNCTION "public"."set_topic_slug"();


CREATE OR REPLACE TRIGGER "trg_town_hall_topics_updated" BEFORE UPDATE ON "public"."town_hall_topics" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_town_hall_votes_count" AFTER INSERT OR DELETE ON "public"."town_hall_votes" FOR EACH ROW EXECUTE FUNCTION "public"."town_hall_bump_upvotes"();


CREATE OR REPLACE TRIGGER "trg_user_private_updated" BEFORE UPDATE ON "public"."user_private" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_vbo_updated" BEFORE UPDATE ON "public"."venue_birthday_offer" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_venue_claims_updated" BEFORE UPDATE ON "public"."venue_claims" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_venue_photos_updated_at" BEFORE UPDATE ON "public"."venue_photos" FOR EACH ROW EXECUTE FUNCTION "public"."set_venue_photos_updated_at"();


CREATE OR REPLACE TRIGGER "trg_venue_reviews_rollup" AFTER INSERT OR DELETE OR UPDATE ON "public"."venue_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."venue_reviews_refresh_rollup"();


CREATE OR REPLACE TRIGGER "trg_venue_reviews_updated" BEFORE UPDATE ON "public"."venue_reviews" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_venues_slug" BEFORE INSERT ON "public"."venues" FOR EACH ROW EXECUTE FUNCTION "public"."set_venue_slug"();


CREATE OR REPLACE TRIGGER "trg_venues_updated" BEFORE UPDATE ON "public"."venues" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "trg_vmp_updated" BEFORE UPDATE ON "public"."venue_marketing_prefs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "venue_payment_accounts_updated_at" BEFORE UPDATE ON "public"."venue_payment_accounts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


CREATE OR REPLACE TRIGGER "venue_products_updated_at" BEFORE UPDATE ON "public"."venue_products" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();


ALTER TABLE ONLY "public"."admin_audit_log"
    ADD CONSTRAINT "admin_audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."admin_users"
    ADD CONSTRAINT "admin_users_id_fkey" FOREIGN KEY ("id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."automation_journeys"
    ADD CONSTRAINT "automation_journeys_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."billing_customers"
    ADD CONSTRAINT "billing_customers_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."billing_transactions"
    ADD CONSTRAINT "billing_transactions_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."birthday_deliveries"
    ADD CONSTRAINT "birthday_deliveries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."birthday_deliveries"
    ADD CONSTRAINT "birthday_deliveries_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_sender_id_fkey" FOREIGN KEY ("sender_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."chat_messages"
    ADD CONSTRAINT "chat_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."chat_participants"
    ADD CONSTRAINT "chat_participants_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."chat_poll_votes"
    ADD CONSTRAINT "chat_poll_votes_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."chat_poll_votes"
    ADD CONSTRAINT "chat_poll_votes_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."chat_polls"
    ADD CONSTRAINT "chat_polls_closed_by_fkey" FOREIGN KEY ("closed_by") REFERENCES "public"."profiles"("id");


ALTER TABLE ONLY "public"."chat_polls"
    ADD CONSTRAINT "chat_polls_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "public"."chat_messages"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."chat_threads"
    ADD CONSTRAINT "chat_threads_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."event_interest"
    ADD CONSTRAINT "event_interest_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."event_interest"
    ADD CONSTRAINT "event_interest_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."events"
    ADD CONSTRAINT "events_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."follows"
    ADD CONSTRAINT "follows_follower_id_fkey" FOREIGN KEY ("follower_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."follows"
    ADD CONSTRAINT "follows_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."friend_presence"
    ADD CONSTRAINT "friend_presence_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_addressee_id_fkey" FOREIGN KEY ("addressee_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."friendships"
    ADD CONSTRAINT "friendships_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."market_listings"
    ADD CONSTRAINT "market_listings_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."meetup_locations"
    ADD CONSTRAINT "meetup_locations_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "public"."meetups"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."meetup_locations"
    ADD CONSTRAINT "meetup_locations_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."meetup_options"
    ADD CONSTRAINT "meetup_options_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."meetup_options"
    ADD CONSTRAINT "meetup_options_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "public"."meetups"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."meetup_options"
    ADD CONSTRAINT "meetup_options_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."meetup_votes"
    ADD CONSTRAINT "meetup_votes_meetup_id_fkey" FOREIGN KEY ("meetup_id") REFERENCES "public"."meetups"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."meetup_votes"
    ADD CONSTRAINT "meetup_votes_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "public"."meetup_options"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."meetup_votes"
    ADD CONSTRAINT "meetup_votes_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."meetups"
    ADD CONSTRAINT "meetups_resolved_venue_id_fkey" FOREIGN KEY ("resolved_venue_id") REFERENCES "public"."venues"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."meetups"
    ADD CONSTRAINT "meetups_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."meetups"
    ADD CONSTRAINT "meetups_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_threads"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."moderation_queue"
    ADD CONSTRAINT "moderation_queue_reporter_id_fkey" FOREIGN KEY ("reporter_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."moderation_queue"
    ADD CONSTRAINT "moderation_queue_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."offer_redemptions"
    ADD CONSTRAINT "offer_redemptions_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."offer_redemptions"
    ADD CONSTRAINT "offer_redemptions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."offer_saves"
    ADD CONSTRAINT "offer_saves_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "public"."offers"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."offer_saves"
    ADD CONSTRAINT "offer_saves_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."offers"
    ADD CONSTRAINT "offers_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."venue_products"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_referrer_profile_id_fkey" FOREIGN KEY ("referrer_profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."plan_members"
    ADD CONSTRAINT "plan_members_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."plan_members"
    ADD CONSTRAINT "plan_members_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."plan_venues"
    ADD CONSTRAINT "plan_venues_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."plan_venues"
    ADD CONSTRAINT "plan_venues_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."plan_venues"
    ADD CONSTRAINT "plan_venues_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."plans"
    ADD CONSTRAINT "plans_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."posts_comments"
    ADD CONSTRAINT "posts_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."posts_comments"
    ADD CONSTRAINT "posts_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."posts_likes"
    ADD CONSTRAINT "posts_likes_liker_id_fkey" FOREIGN KEY ("liker_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."posts_likes"
    ADD CONSTRAINT "posts_likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."posts"
    ADD CONSTRAINT "posts_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."presence_alerts"
    ADD CONSTRAINT "presence_alerts_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."presence_alerts"
    ADD CONSTRAINT "presence_alerts_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profile_post_comments"
    ADD CONSTRAINT "profile_post_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."profile_post_comments"
    ADD CONSTRAINT "profile_post_comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profile_post_likes"
    ADD CONSTRAINT "profile_post_likes_liker_id_fkey" FOREIGN KEY ("liker_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profile_post_likes"
    ADD CONSTRAINT "profile_post_likes_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "public"."profile_posts"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profile_posts"
    ADD CONSTRAINT "profile_posts_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."push_credit_ledger"
    ADD CONSTRAINT "push_credit_ledger_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."push_subscriptions"
    ADD CONSTRAINT "push_subscriptions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."saved_transit_stops"
    ADD CONSTRAINT "saved_transit_stops_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."shop_orders"
    ADD CONSTRAINT "shop_orders_buyer_id_fkey" FOREIGN KEY ("buyer_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."shop_orders"
    ADD CONSTRAINT "shop_orders_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."shop_products"
    ADD CONSTRAINT "shop_products_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."town_hall_replies"
    ADD CONSTRAINT "town_hall_replies_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."town_hall_replies"
    ADD CONSTRAINT "town_hall_replies_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."town_hall_topics"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."town_hall_reply_votes"
    ADD CONSTRAINT "town_hall_reply_votes_reply_id_fkey" FOREIGN KEY ("reply_id") REFERENCES "public"."town_hall_replies"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."town_hall_reply_votes"
    ADD CONSTRAINT "town_hall_reply_votes_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."town_hall_topics"
    ADD CONSTRAINT "town_hall_topics_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."town_hall_votes"
    ADD CONSTRAINT "town_hall_votes_topic_id_fkey" FOREIGN KEY ("topic_id") REFERENCES "public"."town_hall_topics"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."town_hall_votes"
    ADD CONSTRAINT "town_hall_votes_voter_id_fkey" FOREIGN KEY ("voter_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."trip_stops"
    ADD CONSTRAINT "trip_stops_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "public"."trips"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."trip_stops"
    ADD CONSTRAINT "trip_stops_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."trips"
    ADD CONSTRAINT "trips_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocked_id_fkey" FOREIGN KEY ("blocked_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."user_blocks"
    ADD CONSTRAINT "user_blocks_blocker_id_fkey" FOREIGN KEY ("blocker_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."user_private"
    ADD CONSTRAINT "user_private_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_activity"
    ADD CONSTRAINT "venue_activity_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."venue_activity"
    ADD CONSTRAINT "venue_activity_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_birthday_offer"
    ADD CONSTRAINT "venue_birthday_offer_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_claims"
    ADD CONSTRAINT "venue_claims_claimant_id_fkey" FOREIGN KEY ("claimant_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_claims"
    ADD CONSTRAINT "venue_claims_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE ONLY "public"."venue_claims"
    ADD CONSTRAINT "venue_claims_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_marketing_prefs"
    ADD CONSTRAINT "venue_marketing_prefs_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_payment_accounts"
    ADD CONSTRAINT "venue_payment_accounts_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_photos"
    ADD CONSTRAINT "venue_photos_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_products"
    ADD CONSTRAINT "venue_products_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_reviews"
    ADD CONSTRAINT "venue_reviews_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_reviews"
    ADD CONSTRAINT "venue_reviews_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venue_views"
    ADD CONSTRAINT "venue_views_venue_id_fkey" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE CASCADE;


ALTER TABLE ONLY "public"."venues"
    ADD CONSTRAINT "venues_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;


ALTER TABLE "public"."admin_audit_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."admin_users" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "admin_users_self_read" ON "public"."admin_users" FOR SELECT USING (("id" = "auth"."uid"()));


ALTER TABLE "public"."automation_journeys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "automation_owner" ON "public"."automation_journeys" USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "automation_journeys"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "automation_journeys"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


ALTER TABLE "public"."awin_deals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "awin_deals_public_read" ON "public"."awin_deals" FOR SELECT USING (("active" AND (("starts_at" IS NULL) OR ("starts_at" <= "now"())) AND (("ends_at" IS NULL) OR ("ends_at" >= "now"()))));


ALTER TABLE "public"."billing_customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "billing_customers_owner" ON "public"."billing_customers" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "billing_customers"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


ALTER TABLE "public"."billing_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "billing_tx_owner" ON "public"."billing_transactions" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "billing_transactions"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


ALTER TABLE "public"."birthday_deliveries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "birthday_deliveries_self_read" ON "public"."birthday_deliveries" FOR SELECT USING (("user_id" = "auth"."uid"()));


CREATE POLICY "blocks_own" ON "public"."user_blocks" USING (("blocker_id" = "auth"."uid"())) WITH CHECK (("blocker_id" = "auth"."uid"()));


ALTER TABLE "public"."chat_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_messages_delete" ON "public"."chat_messages" FOR DELETE TO "authenticated" USING (("sender_id" = "auth"."uid"()));


CREATE POLICY "chat_messages_insert" ON "public"."chat_messages" FOR INSERT WITH CHECK ((("sender_id" = "auth"."uid"()) AND "public"."in_thread"("thread_id")));


CREATE POLICY "chat_messages_read" ON "public"."chat_messages" FOR SELECT USING ("public"."in_thread"("thread_id"));


CREATE POLICY "chat_messages_update" ON "public"."chat_messages" FOR UPDATE TO "authenticated" USING (("sender_id" = "auth"."uid"())) WITH CHECK ((("sender_id" = "auth"."uid"()) AND "public"."in_thread"("thread_id")));


ALTER TABLE "public"."chat_participants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_participants_leave" ON "public"."chat_participants" FOR DELETE TO "authenticated" USING (("profile_id" = "auth"."uid"()));


CREATE POLICY "chat_participants_read" ON "public"."chat_participants" FOR SELECT USING ("public"."in_thread"("thread_id"));


CREATE POLICY "chat_participants_write" ON "public"."chat_participants" FOR INSERT TO "authenticated" WITH CHECK ("public"."in_thread"("thread_id"));


ALTER TABLE "public"."chat_poll_votes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_polls" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."chat_threads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chat_threads_read" ON "public"."chat_threads" FOR SELECT USING ("public"."in_thread"("id"));


CREATE POLICY "chat_threads_update" ON "public"."chat_threads" FOR UPDATE TO "authenticated" USING ("public"."in_thread"("id")) WITH CHECK ("public"."in_thread"("id"));


ALTER TABLE "public"."cj_advertisers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cj_advertisers_public_read" ON "public"."cj_advertisers" FOR SELECT USING (true);


ALTER TABLE "public"."cj_deals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "cj_deals_public_read" ON "public"."cj_deals" FOR SELECT USING (("active" AND (("starts_at" IS NULL) OR ("starts_at" <= "now"())) AND (("ends_at" IS NULL) OR ("ends_at" >= "now"()))));


ALTER TABLE "public"."event_interest" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "event_interest_delete" ON "public"."event_interest" FOR DELETE USING (("user_id" = "auth"."uid"()));


CREATE POLICY "event_interest_insert" ON "public"."event_interest" FOR INSERT WITH CHECK (("user_id" = "auth"."uid"()));


CREATE POLICY "event_interest_read" ON "public"."event_interest" FOR SELECT USING (("user_id" = "auth"."uid"()));


ALTER TABLE "public"."events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "events_delete" ON "public"."events" FOR DELETE USING (("author_id" = "auth"."uid"()));


CREATE POLICY "events_insert" ON "public"."events" FOR INSERT WITH CHECK (("author_id" = "auth"."uid"()));


CREATE POLICY "events_read" ON "public"."events" FOR SELECT USING (("moderation" = ANY (ARRAY['auto_approved'::"public"."moderation_status", 'approved'::"public"."moderation_status"])));


CREATE POLICY "events_update" ON "public"."events" FOR UPDATE USING (("author_id" = "auth"."uid"()));


ALTER TABLE "public"."feature_flags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "ff_read" ON "public"."feature_flags" FOR SELECT USING (true);


ALTER TABLE "public"."follows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "follows_delete" ON "public"."follows" FOR DELETE USING (("follower_id" = "auth"."uid"()));


CREATE POLICY "follows_read" ON "public"."follows" FOR SELECT USING (true);


CREATE POLICY "follows_update" ON "public"."follows" FOR UPDATE USING (("follower_id" = "auth"."uid"())) WITH CHECK (("follower_id" = "auth"."uid"()));


CREATE POLICY "follows_write" ON "public"."follows" FOR INSERT WITH CHECK (("follower_id" = "auth"."uid"()));


ALTER TABLE "public"."friend_presence" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "friend_presence_owner_delete" ON "public"."friend_presence" FOR DELETE USING (("profile_id" = "auth"."uid"()));


CREATE POLICY "friend_presence_owner_insert" ON "public"."friend_presence" FOR INSERT WITH CHECK (("profile_id" = "auth"."uid"()));


CREATE POLICY "friend_presence_owner_select" ON "public"."friend_presence" FOR SELECT USING (("profile_id" = "auth"."uid"()));


CREATE POLICY "friend_presence_owner_update" ON "public"."friend_presence" FOR UPDATE USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));


ALTER TABLE "public"."friendships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "friendships_delete" ON "public"."friendships" FOR DELETE USING ((("requester_id" = "auth"."uid"()) OR ("addressee_id" = "auth"."uid"())));


CREATE POLICY "friendships_insert" ON "public"."friendships" FOR INSERT WITH CHECK (("requester_id" = "auth"."uid"()));


CREATE POLICY "friendships_read" ON "public"."friendships" FOR SELECT USING ((("requester_id" = "auth"."uid"()) OR ("addressee_id" = "auth"."uid"())));


CREATE POLICY "friendships_update" ON "public"."friendships" FOR UPDATE USING ((("requester_id" = "auth"."uid"()) OR ("addressee_id" = "auth"."uid"())));


ALTER TABLE "public"."market_listings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "market_listings_owner_write" ON "public"."market_listings" USING (("owner_id" = "auth"."uid"())) WITH CHECK (("owner_id" = "auth"."uid"()));


CREATE POLICY "market_listings_read" ON "public"."market_listings" FOR SELECT USING ((("status" = 'live'::"text") OR ("owner_id" = "auth"."uid"())));


ALTER TABLE "public"."meetup_locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meetup_locations_read" ON "public"."meetup_locations" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."meetups" "mu"
  WHERE (("mu"."id" = "meetup_locations"."meetup_id") AND ("mu"."state" <> 'ended'::"text") AND "public"."in_thread"("mu"."thread_id")))));


CREATE POLICY "meetup_locations_update" ON "public"."meetup_locations" FOR UPDATE USING (("profile_id" = "auth"."uid"()));


CREATE POLICY "meetup_locations_write" ON "public"."meetup_locations" FOR INSERT WITH CHECK (("profile_id" = "auth"."uid"()));


ALTER TABLE "public"."meetup_options" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meetup_options_read" ON "public"."meetup_options" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."meetups" "mu"
  WHERE (("mu"."id" = "meetup_options"."meetup_id") AND "public"."in_thread"("mu"."thread_id")))));


CREATE POLICY "meetup_options_write" ON "public"."meetup_options" FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."meetups" "mu"
  WHERE (("mu"."id" = "meetup_options"."meetup_id") AND "public"."in_thread"("mu"."thread_id")))));


ALTER TABLE "public"."meetup_votes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meetup_votes_read" ON "public"."meetup_votes" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."meetups" "mu"
  WHERE (("mu"."id" = "meetup_votes"."meetup_id") AND "public"."in_thread"("mu"."thread_id")))));


CREATE POLICY "meetup_votes_update" ON "public"."meetup_votes" FOR UPDATE USING (("voter_id" = "auth"."uid"()));


CREATE POLICY "meetup_votes_write" ON "public"."meetup_votes" FOR INSERT WITH CHECK (("voter_id" = "auth"."uid"()));


ALTER TABLE "public"."meetups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "meetups_read" ON "public"."meetups" FOR SELECT USING ("public"."in_thread"("thread_id"));


CREATE POLICY "meetups_update" ON "public"."meetups" FOR UPDATE USING ("public"."in_thread"("thread_id")) WITH CHECK ("public"."in_thread"("thread_id"));


CREATE POLICY "meetups_write" ON "public"."meetups" FOR INSERT WITH CHECK ("public"."in_thread"("thread_id"));


ALTER TABLE "public"."moderation_queue" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "moderation_report" ON "public"."moderation_queue" FOR INSERT WITH CHECK ((("reason" = 'user_report'::"text") AND ("reporter_id" = "auth"."uid"())));


ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "notifications_own" ON "public"."notifications" FOR SELECT USING (("recipient_id" = "auth"."uid"()));


CREATE POLICY "notifications_update_own" ON "public"."notifications" FOR UPDATE USING (("recipient_id" = "auth"."uid"()));


ALTER TABLE "public"."offer_redemptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."offer_saves" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "offer_saves_own" ON "public"."offer_saves" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));


ALTER TABLE "public"."offers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "offers_owner_all" ON "public"."offers" USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "offers"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "offers"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


CREATE POLICY "offers_read" ON "public"."offers" FOR SELECT USING (true);


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "orders_buyer_read" ON "public"."orders" FOR SELECT USING (("buyer_id" = "auth"."uid"()));


CREATE POLICY "orders_owner_read" ON "public"."orders" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "orders"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


ALTER TABLE "public"."plan_members" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plan_members_delete" ON "public"."plan_members" FOR DELETE USING ((("profile_id" = "auth"."uid"()) OR "public"."owns_plan"("plan_id")));


CREATE POLICY "plan_members_read" ON "public"."plan_members" FOR SELECT USING ((("profile_id" = "auth"."uid"()) OR "public"."owns_plan"("plan_id")));


CREATE POLICY "plan_members_write" ON "public"."plan_members" FOR INSERT WITH CHECK (("public"."owns_plan"("plan_id") OR ("profile_id" = "auth"."uid"())));


ALTER TABLE "public"."plan_venues" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plan_venues_delete" ON "public"."plan_venues" FOR DELETE USING ("public"."owns_plan"("plan_id"));


CREATE POLICY "plan_venues_read" ON "public"."plan_venues" FOR SELECT USING (("public"."owns_plan"("plan_id") OR "public"."is_plan_member"("plan_id")));


CREATE POLICY "plan_venues_write" ON "public"."plan_venues" FOR INSERT WITH CHECK (("public"."owns_plan"("plan_id") OR "public"."is_plan_member"("plan_id")));


ALTER TABLE "public"."plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plans_delete" ON "public"."plans" FOR DELETE USING (("owner_id" = "auth"."uid"()));


CREATE POLICY "plans_insert" ON "public"."plans" FOR INSERT WITH CHECK (("owner_id" = "auth"."uid"()));


CREATE POLICY "plans_read" ON "public"."plans" FOR SELECT USING ((("owner_id" = "auth"."uid"()) OR "public"."is_plan_member"("id")));


CREATE POLICY "plans_update" ON "public"."plans" FOR UPDATE USING (("owner_id" = "auth"."uid"()));


ALTER TABLE "public"."posts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."posts_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "posts_comments_delete" ON "public"."posts_comments" FOR DELETE USING (("author_id" = "auth"."uid"()));


CREATE POLICY "posts_comments_insert" ON "public"."posts_comments" FOR INSERT WITH CHECK (("author_id" = "auth"."uid"()));


CREATE POLICY "posts_comments_read" ON "public"."posts_comments" FOR SELECT USING (("moderation" = ANY (ARRAY['auto_approved'::"public"."moderation_status", 'approved'::"public"."moderation_status"])));


CREATE POLICY "posts_comments_update" ON "public"."posts_comments" FOR UPDATE USING (("author_id" = "auth"."uid"()));


ALTER TABLE "public"."posts_likes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "posts_likes_delete" ON "public"."posts_likes" FOR DELETE USING (("liker_id" = "auth"."uid"()));


CREATE POLICY "posts_likes_insert" ON "public"."posts_likes" FOR INSERT WITH CHECK (("liker_id" = "auth"."uid"()));


CREATE POLICY "posts_likes_read" ON "public"."posts_likes" FOR SELECT USING (("liker_id" = "auth"."uid"()));


CREATE POLICY "posts_owner_all" ON "public"."posts" USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "posts"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "posts"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


CREATE POLICY "posts_read_public" ON "public"."posts" FOR SELECT USING ((("published_at" IS NOT NULL) AND ("moderation" = ANY (ARRAY['auto_approved'::"public"."moderation_status", 'approved'::"public"."moderation_status"]))));


ALTER TABLE "public"."presence_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profile_post_comments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profile_post_comments_delete" ON "public"."profile_post_comments" FOR DELETE USING (("author_id" = "auth"."uid"()));


CREATE POLICY "profile_post_comments_insert" ON "public"."profile_post_comments" FOR INSERT WITH CHECK (("author_id" = "auth"."uid"()));


CREATE POLICY "profile_post_comments_read" ON "public"."profile_post_comments" FOR SELECT USING (("moderation" = ANY (ARRAY['auto_approved'::"public"."moderation_status", 'approved'::"public"."moderation_status"])));


CREATE POLICY "profile_post_comments_update" ON "public"."profile_post_comments" FOR UPDATE USING (("author_id" = "auth"."uid"()));


ALTER TABLE "public"."profile_post_likes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profile_post_likes_delete" ON "public"."profile_post_likes" FOR DELETE USING (("liker_id" = "auth"."uid"()));


CREATE POLICY "profile_post_likes_insert" ON "public"."profile_post_likes" FOR INSERT WITH CHECK (("liker_id" = "auth"."uid"()));


CREATE POLICY "profile_post_likes_read" ON "public"."profile_post_likes" FOR SELECT USING (("liker_id" = "auth"."uid"()));


ALTER TABLE "public"."profile_posts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profile_posts_delete" ON "public"."profile_posts" FOR DELETE USING (("author_id" = "auth"."uid"()));


CREATE POLICY "profile_posts_insert" ON "public"."profile_posts" FOR INSERT WITH CHECK (("author_id" = "auth"."uid"()));


CREATE POLICY "profile_posts_read" ON "public"."profile_posts" FOR SELECT USING (("moderation" = ANY (ARRAY['auto_approved'::"public"."moderation_status", 'approved'::"public"."moderation_status"])));


CREATE POLICY "profile_posts_update" ON "public"."profile_posts" FOR UPDATE USING (("author_id" = "auth"."uid"()));


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_delete" ON "public"."profiles" FOR DELETE USING (("id" = "auth"."uid"()));


CREATE POLICY "profiles_insert" ON "public"."profiles" FOR INSERT WITH CHECK (("id" = "auth"."uid"()));


CREATE POLICY "profiles_read" ON "public"."profiles" FOR SELECT USING (true);


CREATE POLICY "profiles_update" ON "public"."profiles" FOR UPDATE USING (("id" = "auth"."uid"()));


ALTER TABLE "public"."push_credit_ledger" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "push_ledger_owner" ON "public"."push_credit_ledger" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "push_credit_ledger"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


CREATE POLICY "push_own" ON "public"."push_subscriptions" USING (("profile_id" = "auth"."uid"())) WITH CHECK (("profile_id" = "auth"."uid"()));


ALTER TABLE "public"."push_subscriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "redemptions_read" ON "public"."offer_redemptions" FOR SELECT USING ((("profile_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM ("public"."offers" "o"
     JOIN "public"."venues" "v" ON (("v"."id" = "o"."venue_id")))
  WHERE (("o"."id" = "offer_redemptions"."offer_id") AND ("v"."owner_id" = "auth"."uid"()))))));


ALTER TABLE "public"."saved_transit_stops" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "saved_transit_stops_delete" ON "public"."saved_transit_stops" FOR DELETE USING (("profile_id" = "auth"."uid"()));


CREATE POLICY "saved_transit_stops_insert" ON "public"."saved_transit_stops" FOR INSERT WITH CHECK (("profile_id" = "auth"."uid"()));


CREATE POLICY "saved_transit_stops_read" ON "public"."saved_transit_stops" FOR SELECT USING (("profile_id" = "auth"."uid"()));


ALTER TABLE "public"."shop_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "shop_orders_party" ON "public"."shop_orders" FOR SELECT USING ((("buyer_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "shop_orders"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))));


ALTER TABLE "public"."shop_products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "shop_products_owner" ON "public"."shop_products" USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "shop_products"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "shop_products"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


CREATE POLICY "shop_products_read" ON "public"."shop_products" FOR SELECT USING (("active" = true));


ALTER TABLE "public"."town_hall_replies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "town_hall_replies_delete" ON "public"."town_hall_replies" FOR DELETE USING (("author_id" = "auth"."uid"()));


CREATE POLICY "town_hall_replies_insert" ON "public"."town_hall_replies" FOR INSERT WITH CHECK (("author_id" = "auth"."uid"()));


CREATE POLICY "town_hall_replies_read" ON "public"."town_hall_replies" FOR SELECT USING (("moderation" = ANY (ARRAY['auto_approved'::"public"."moderation_status", 'approved'::"public"."moderation_status"])));


CREATE POLICY "town_hall_replies_update" ON "public"."town_hall_replies" FOR UPDATE USING (("author_id" = "auth"."uid"()));


ALTER TABLE "public"."town_hall_reply_votes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "town_hall_reply_votes_delete" ON "public"."town_hall_reply_votes" FOR DELETE USING (("voter_id" = "auth"."uid"()));


CREATE POLICY "town_hall_reply_votes_insert" ON "public"."town_hall_reply_votes" FOR INSERT WITH CHECK (("voter_id" = "auth"."uid"()));


CREATE POLICY "town_hall_reply_votes_read" ON "public"."town_hall_reply_votes" FOR SELECT USING (("voter_id" = "auth"."uid"()));


ALTER TABLE "public"."town_hall_topics" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "town_hall_topics_delete" ON "public"."town_hall_topics" FOR DELETE USING (("author_id" = "auth"."uid"()));


CREATE POLICY "town_hall_topics_insert" ON "public"."town_hall_topics" FOR INSERT WITH CHECK (("author_id" = "auth"."uid"()));


CREATE POLICY "town_hall_topics_read" ON "public"."town_hall_topics" FOR SELECT USING (("moderation" = ANY (ARRAY['auto_approved'::"public"."moderation_status", 'approved'::"public"."moderation_status"])));


CREATE POLICY "town_hall_topics_update" ON "public"."town_hall_topics" FOR UPDATE USING (("author_id" = "auth"."uid"()));


ALTER TABLE "public"."town_hall_votes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "town_hall_votes_delete" ON "public"."town_hall_votes" FOR DELETE USING (("voter_id" = "auth"."uid"()));


CREATE POLICY "town_hall_votes_insert" ON "public"."town_hall_votes" FOR INSERT WITH CHECK (("voter_id" = "auth"."uid"()));


CREATE POLICY "town_hall_votes_read" ON "public"."town_hall_votes" FOR SELECT USING (("voter_id" = "auth"."uid"()));


ALTER TABLE "public"."trip_stops" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "trip_stops_own" ON "public"."trip_stops" USING ((EXISTS ( SELECT 1
   FROM "public"."trips" "t"
  WHERE (("t"."id" = "trip_stops"."trip_id") AND ("t"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."trips" "t"
  WHERE (("t"."id" = "trip_stops"."trip_id") AND ("t"."owner_id" = "auth"."uid"())))));


ALTER TABLE "public"."trips" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "trips_own" ON "public"."trips" USING (("owner_id" = "auth"."uid"())) WITH CHECK (("owner_id" = "auth"."uid"()));


ALTER TABLE "public"."user_blocks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."user_private" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_private_owner_all" ON "public"."user_private" USING (("user_id" = "auth"."uid"())) WITH CHECK (("user_id" = "auth"."uid"()));


CREATE POLICY "vbo_owner_all" ON "public"."venue_birthday_offer" USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_birthday_offer"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_birthday_offer"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


ALTER TABLE "public"."venue_activity" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "venue_activity_owner_read" ON "public"."venue_activity" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_activity"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


ALTER TABLE "public"."venue_birthday_offer" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."venue_claims" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "venue_claims_own_read" ON "public"."venue_claims" FOR SELECT USING (("claimant_id" = "auth"."uid"()));


CREATE POLICY "venue_claims_owner_read" ON "public"."venue_claims" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_claims"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


CREATE POLICY "venue_claims_self_insert" ON "public"."venue_claims" FOR INSERT WITH CHECK (("claimant_id" = "auth"."uid"()));


ALTER TABLE "public"."venue_marketing_prefs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."venue_payment_accounts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "venue_payment_accounts_owner_read" ON "public"."venue_payment_accounts" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_payment_accounts"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


ALTER TABLE "public"."venue_photos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "venue_photos_owner_delete" ON "public"."venue_photos" FOR DELETE TO "authenticated" USING ((("source" = 'owner_upload'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_photos"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))));


CREATE POLICY "venue_photos_owner_insert" ON "public"."venue_photos" FOR INSERT TO "authenticated" WITH CHECK ((("source" = 'owner_upload'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_photos"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))));


CREATE POLICY "venue_photos_owner_update" ON "public"."venue_photos" FOR UPDATE TO "authenticated" USING ((("source" = 'owner_upload'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_photos"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))))) WITH CHECK ((("source" = 'owner_upload'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_photos"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))));


CREATE POLICY "venue_photos_select_public" ON "public"."venue_photos" FOR SELECT USING (true);


ALTER TABLE "public"."venue_products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "venue_products_owner_write" ON "public"."venue_products" USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_products"."venue_id") AND ("v"."owner_id" = "auth"."uid"()) AND ("v"."status" = 'claimed'::"public"."venue_status"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_products"."venue_id") AND ("v"."owner_id" = "auth"."uid"()) AND ("v"."status" = 'claimed'::"public"."venue_status")))));


CREATE POLICY "venue_products_read" ON "public"."venue_products" FOR SELECT USING ((("active" = true) OR (EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_products"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))));


ALTER TABLE "public"."venue_reviews" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "venue_reviews_delete" ON "public"."venue_reviews" FOR DELETE USING (("author_id" = "auth"."uid"()));


CREATE POLICY "venue_reviews_insert" ON "public"."venue_reviews" FOR INSERT WITH CHECK (("author_id" = "auth"."uid"()));


CREATE POLICY "venue_reviews_read" ON "public"."venue_reviews" FOR SELECT USING (("moderation" = ANY (ARRAY['auto_approved'::"public"."moderation_status", 'approved'::"public"."moderation_status"])));


CREATE POLICY "venue_reviews_update" ON "public"."venue_reviews" FOR UPDATE USING (("author_id" = "auth"."uid"()));


ALTER TABLE "public"."venue_views" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "venue_views_owner_read" ON "public"."venue_views" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_views"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


ALTER TABLE "public"."venues" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "venues_owner_update" ON "public"."venues" FOR UPDATE USING ((("owner_id" = "auth"."uid"()) AND ("status" = 'claimed'::"public"."venue_status"))) WITH CHECK ((("owner_id" = "auth"."uid"()) AND ("status" = 'claimed'::"public"."venue_status")));


COMMENT ON POLICY "venues_owner_update" ON "public"."venues" IS 'Owner may UPDATE only their own claimed venue, and the post-update row must remain owned by the caller and claimed (explicit with check, 0022). Column-scope (description + links only) is enforced in the updateVenueDetails tRPC mutation, not here.';


CREATE POLICY "venues_read" ON "public"."venues" FOR SELECT USING ((("status" <> 'suspended'::"public"."venue_status") OR ("owner_id" = "auth"."uid"())));


CREATE POLICY "vmp_owner_all" ON "public"."venue_marketing_prefs" USING ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_marketing_prefs"."venue_id") AND ("v"."owner_id" = "auth"."uid"()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."venues" "v"
  WHERE (("v"."id" = "venue_marketing_prefs"."venue_id") AND ("v"."owner_id" = "auth"."uid"())))));


ALTER PUBLICATION "supabase_realtime" OWNER TO "postgres";


ALTER PUBLICATION "supabase_realtime" ADD TABLE ONLY "public"."chat_messages";


GRANT USAGE ON SCHEMA "public" TO "postgres";


GRANT USAGE ON SCHEMA "public" TO "anon";


GRANT USAGE ON SCHEMA "public" TO "authenticated";


GRANT USAGE ON SCHEMA "public" TO "service_role";


GRANT ALL ON FUNCTION "public"."box2d_in"("cstring") TO "postgres";


GRANT ALL ON FUNCTION "public"."box2d_in"("cstring") TO "anon";


GRANT ALL ON FUNCTION "public"."box2d_in"("cstring") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box2d_in"("cstring") TO "service_role";


GRANT ALL ON FUNCTION "public"."box2d_out"("public"."box2d") TO "postgres";


GRANT ALL ON FUNCTION "public"."box2d_out"("public"."box2d") TO "anon";


GRANT ALL ON FUNCTION "public"."box2d_out"("public"."box2d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box2d_out"("public"."box2d") TO "service_role";


GRANT ALL ON FUNCTION "public"."box2df_in"("cstring") TO "postgres";


GRANT ALL ON FUNCTION "public"."box2df_in"("cstring") TO "anon";


GRANT ALL ON FUNCTION "public"."box2df_in"("cstring") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box2df_in"("cstring") TO "service_role";


GRANT ALL ON FUNCTION "public"."box2df_out"("public"."box2df") TO "postgres";


GRANT ALL ON FUNCTION "public"."box2df_out"("public"."box2df") TO "anon";


GRANT ALL ON FUNCTION "public"."box2df_out"("public"."box2df") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box2df_out"("public"."box2df") TO "service_role";


GRANT ALL ON FUNCTION "public"."box3d_in"("cstring") TO "postgres";


GRANT ALL ON FUNCTION "public"."box3d_in"("cstring") TO "anon";


GRANT ALL ON FUNCTION "public"."box3d_in"("cstring") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box3d_in"("cstring") TO "service_role";


GRANT ALL ON FUNCTION "public"."box3d_out"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."box3d_out"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."box3d_out"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box3d_out"("public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_analyze"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_analyze"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_analyze"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_analyze"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_in"("cstring", "oid", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_in"("cstring", "oid", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geography_in"("cstring", "oid", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_in"("cstring", "oid", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_out"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_out"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_out"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_out"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_recv"("internal", "oid", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_recv"("internal", "oid", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geography_recv"("internal", "oid", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_recv"("internal", "oid", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_send"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_send"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_send"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_send"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_typmod_in"("cstring"[]) TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_typmod_in"("cstring"[]) TO "anon";


GRANT ALL ON FUNCTION "public"."geography_typmod_in"("cstring"[]) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_typmod_in"("cstring"[]) TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_typmod_out"(integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_typmod_out"(integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geography_typmod_out"(integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_typmod_out"(integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_analyze"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_analyze"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_analyze"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_analyze"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_in"("cstring") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_in"("cstring") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_in"("cstring") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_in"("cstring") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_out"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_out"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_out"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_out"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_recv"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_recv"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_recv"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_recv"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_send"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_send"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_send"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_send"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_typmod_in"("cstring"[]) TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_typmod_in"("cstring"[]) TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_typmod_in"("cstring"[]) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_typmod_in"("cstring"[]) TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_typmod_out"(integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_typmod_out"(integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_typmod_out"(integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_typmod_out"(integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."gidx_in"("cstring") TO "postgres";


GRANT ALL ON FUNCTION "public"."gidx_in"("cstring") TO "anon";


GRANT ALL ON FUNCTION "public"."gidx_in"("cstring") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gidx_in"("cstring") TO "service_role";


GRANT ALL ON FUNCTION "public"."gidx_out"("public"."gidx") TO "postgres";


GRANT ALL ON FUNCTION "public"."gidx_out"("public"."gidx") TO "anon";


GRANT ALL ON FUNCTION "public"."gidx_out"("public"."gidx") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gidx_out"("public"."gidx") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_in"("cstring") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_out"("public"."gtrgm") TO "service_role";


GRANT ALL ON FUNCTION "public"."spheroid_in"("cstring") TO "postgres";


GRANT ALL ON FUNCTION "public"."spheroid_in"("cstring") TO "anon";


GRANT ALL ON FUNCTION "public"."spheroid_in"("cstring") TO "authenticated";


GRANT ALL ON FUNCTION "public"."spheroid_in"("cstring") TO "service_role";


GRANT ALL ON FUNCTION "public"."spheroid_out"("public"."spheroid") TO "postgres";


GRANT ALL ON FUNCTION "public"."spheroid_out"("public"."spheroid") TO "anon";


GRANT ALL ON FUNCTION "public"."spheroid_out"("public"."spheroid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."spheroid_out"("public"."spheroid") TO "service_role";


GRANT ALL ON FUNCTION "public"."box3d"("public"."box2d") TO "postgres";


GRANT ALL ON FUNCTION "public"."box3d"("public"."box2d") TO "anon";


GRANT ALL ON FUNCTION "public"."box3d"("public"."box2d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box3d"("public"."box2d") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry"("public"."box2d") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry"("public"."box2d") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry"("public"."box2d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry"("public"."box2d") TO "service_role";


GRANT ALL ON FUNCTION "public"."box"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."box"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."box"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box"("public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."box2d"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."box2d"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."box2d"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box2d"("public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry"("public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."geography"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."bytea"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."bytea"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."bytea"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."bytea"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography"("public"."geography", integer, boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."geography"("public"."geography", integer, boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."geography"("public"."geography", integer, boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography"("public"."geography", integer, boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."box"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."box"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."box"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."box2d"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."box2d"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."box2d"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box2d"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."box3d"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."box3d"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."box3d"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box3d"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."bytea"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."bytea"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."bytea"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."bytea"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geography"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry"("public"."geometry", integer, boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry"("public"."geometry", integer, boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."geometry"("public"."geometry", integer, boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry"("public"."geometry", integer, boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."json"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."json"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."json"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."json"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."jsonb"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."jsonb"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."jsonb"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."jsonb"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."path"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."path"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."path"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."path"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."point"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."point"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."point"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."point"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."polygon"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."polygon"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."polygon"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."polygon"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."text"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."text"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."text"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."text"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry"("path") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry"("path") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry"("path") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry"("path") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry"("point") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry"("point") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry"("point") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry"("point") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry"("polygon") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry"("polygon") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry"("polygon") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry"("polygon") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."_postgis_deprecate"("oldname" "text", "newname" "text", "version" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."_postgis_deprecate"("oldname" "text", "newname" "text", "version" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."_postgis_deprecate"("oldname" "text", "newname" "text", "version" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_postgis_deprecate"("oldname" "text", "newname" "text", "version" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."_postgis_index_extent"("tbl" "regclass", "col" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."_postgis_index_extent"("tbl" "regclass", "col" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."_postgis_index_extent"("tbl" "regclass", "col" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_postgis_index_extent"("tbl" "regclass", "col" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."_postgis_join_selectivity"("regclass", "text", "regclass", "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."_postgis_join_selectivity"("regclass", "text", "regclass", "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."_postgis_join_selectivity"("regclass", "text", "regclass", "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_postgis_join_selectivity"("regclass", "text", "regclass", "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."_postgis_pgsql_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."_postgis_pgsql_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."_postgis_pgsql_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."_postgis_pgsql_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."_postgis_scripts_pgsql_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."_postgis_scripts_pgsql_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."_postgis_scripts_pgsql_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."_postgis_scripts_pgsql_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."_postgis_selectivity"("tbl" "regclass", "att_name" "text", "geom" "public"."geometry", "mode" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."_postgis_selectivity"("tbl" "regclass", "att_name" "text", "geom" "public"."geometry", "mode" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."_postgis_selectivity"("tbl" "regclass", "att_name" "text", "geom" "public"."geometry", "mode" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_postgis_selectivity"("tbl" "regclass", "att_name" "text", "geom" "public"."geometry", "mode" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."_postgis_stats"("tbl" "regclass", "att_name" "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."_postgis_stats"("tbl" "regclass", "att_name" "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."_postgis_stats"("tbl" "regclass", "att_name" "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_postgis_stats"("tbl" "regclass", "att_name" "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_3ddfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_3ddfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_3ddfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_3ddfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_3ddwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_3ddwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_3ddwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_3ddwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_3dintersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_3dintersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_3dintersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_3dintersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_asgml"(integer, "public"."geometry", integer, integer, "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_asgml"(integer, "public"."geometry", integer, integer, "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_asgml"(integer, "public"."geometry", integer, integer, "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_asgml"(integer, "public"."geometry", integer, integer, "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_asx3d"(integer, "public"."geometry", integer, integer, "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_asx3d"(integer, "public"."geometry", integer, integer, "text") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_asx3d"(integer, "public"."geometry", integer, integer, "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_asx3d"(integer, "public"."geometry", integer, integer, "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_bestsrid"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_bestsrid"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_bestsrid"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_bestsrid"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_bestsrid"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_bestsrid"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_bestsrid"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_bestsrid"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_containsproperly"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_containsproperly"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_containsproperly"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_containsproperly"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_coveredby"("geog1" "public"."geography", "geog2" "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_coveredby"("geog1" "public"."geography", "geog2" "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_coveredby"("geog1" "public"."geography", "geog2" "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_coveredby"("geog1" "public"."geography", "geog2" "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_coveredby"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_coveredby"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_coveredby"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_coveredby"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_covers"("geog1" "public"."geography", "geog2" "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_covers"("geog1" "public"."geography", "geog2" "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_covers"("geog1" "public"."geography", "geog2" "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_covers"("geog1" "public"."geography", "geog2" "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_covers"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_covers"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_covers"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_covers"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_crosses"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_crosses"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_crosses"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_crosses"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_dfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_dfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_dfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_dfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_distancetree"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_distancetree"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_distancetree"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_distancetree"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_distancetree"("public"."geography", "public"."geography", double precision, boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_distancetree"("public"."geography", "public"."geography", double precision, boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_distancetree"("public"."geography", "public"."geography", double precision, boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_distancetree"("public"."geography", "public"."geography", double precision, boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography", boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography", boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography", boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography", boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography", double precision, boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography", double precision, boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography", double precision, boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_distanceuncached"("public"."geography", "public"."geography", double precision, boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_dwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_dwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_dwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_dwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_dwithin"("geog1" "public"."geography", "geog2" "public"."geography", "tolerance" double precision, "use_spheroid" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_dwithin"("geog1" "public"."geography", "geog2" "public"."geography", "tolerance" double precision, "use_spheroid" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_dwithin"("geog1" "public"."geography", "geog2" "public"."geography", "tolerance" double precision, "use_spheroid" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_dwithin"("geog1" "public"."geography", "geog2" "public"."geography", "tolerance" double precision, "use_spheroid" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_dwithinuncached"("public"."geography", "public"."geography", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_dwithinuncached"("public"."geography", "public"."geography", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_dwithinuncached"("public"."geography", "public"."geography", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_dwithinuncached"("public"."geography", "public"."geography", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_dwithinuncached"("public"."geography", "public"."geography", double precision, boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_dwithinuncached"("public"."geography", "public"."geography", double precision, boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_dwithinuncached"("public"."geography", "public"."geography", double precision, boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_dwithinuncached"("public"."geography", "public"."geography", double precision, boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_expand"("public"."geography", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_expand"("public"."geography", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_expand"("public"."geography", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_expand"("public"."geography", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_geomfromgml"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_geomfromgml"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_geomfromgml"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_geomfromgml"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_intersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_intersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_intersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_intersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_linecrossingdirection"("line1" "public"."geometry", "line2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_linecrossingdirection"("line1" "public"."geometry", "line2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_linecrossingdirection"("line1" "public"."geometry", "line2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_linecrossingdirection"("line1" "public"."geometry", "line2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_longestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_longestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_longestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_longestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_maxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_maxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_maxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_maxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_orderingequals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_orderingequals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_orderingequals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_orderingequals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_pointoutside"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_pointoutside"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_pointoutside"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_pointoutside"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_sortablehash"("geom" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_sortablehash"("geom" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_sortablehash"("geom" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_sortablehash"("geom" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_touches"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_touches"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_touches"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_touches"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_voronoi"("g1" "public"."geometry", "clip" "public"."geometry", "tolerance" double precision, "return_polygons" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_voronoi"("g1" "public"."geometry", "clip" "public"."geometry", "tolerance" double precision, "return_polygons" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."_st_voronoi"("g1" "public"."geometry", "clip" "public"."geometry", "tolerance" double precision, "return_polygons" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_voronoi"("g1" "public"."geometry", "clip" "public"."geometry", "tolerance" double precision, "return_polygons" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."_st_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."_st_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."_st_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."_st_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."addauth"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."addauth"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."addauth"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."addauth"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("table_name" character varying, "column_name" character varying, "new_srid" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("table_name" character varying, "column_name" character varying, "new_srid" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("table_name" character varying, "column_name" character varying, "new_srid" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("table_name" character varying, "column_name" character varying, "new_srid" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid_in" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid_in" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid_in" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."addgeometrycolumn"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid_in" integer, "new_type" character varying, "new_dim" integer, "use_typmod" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."apply_venue_details"("p_venue_id" "uuid", "p_phone" "text", "p_website" "text", "p_price_range" "jsonb", "p_attributes" "jsonb", "p_business_status" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."apply_venue_details"("p_venue_id" "uuid", "p_phone" "text", "p_website" "text", "p_price_range" "jsonb", "p_attributes" "jsonb", "p_business_status" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."apply_venue_details"("p_venue_id" "uuid", "p_phone" "text", "p_website" "text", "p_price_range" "jsonb", "p_attributes" "jsonb", "p_business_status" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."approve_venue_claim"("target_claim_id" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."approve_venue_claim"("target_claim_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."are_friends"("a" "uuid", "b" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."are_friends"("a" "uuid", "b" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."box3dtobox"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."box3dtobox"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."box3dtobox"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."box3dtobox"("public"."box3d") TO "service_role";


REVOKE ALL ON FUNCTION "public"."bump_engagement_notification"("p_recipient" "uuid", "p_type" "text", "p_entity" "uuid", "p_actor" "text", "p_verb" "text", "p_subject" "text", "p_href" "text") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."bump_engagement_notification"("p_recipient" "uuid", "p_type" "text", "p_entity" "uuid", "p_actor" "text", "p_verb" "text", "p_subject" "text", "p_href" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."cast_poll_vote"("p_message" "uuid", "p_option" "text") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."cast_poll_vote"("p_message" "uuid", "p_option" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."cast_poll_vote"("p_message" "uuid", "p_option" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."cast_poll_vote"("p_message" "uuid", "p_option" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."checkauth"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."checkauth"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."checkauth"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."checkauth"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."checkauth"("text", "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."checkauth"("text", "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."checkauth"("text", "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."checkauth"("text", "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."checkauthtrigger"() TO "postgres";


GRANT ALL ON FUNCTION "public"."checkauthtrigger"() TO "anon";


GRANT ALL ON FUNCTION "public"."checkauthtrigger"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."checkauthtrigger"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."claim_nearby_alert_targets"("radius_m" double precision, "cooldown_secs" integer) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."claim_nearby_alert_targets"("radius_m" double precision, "cooldown_secs" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."claim_nearby_alert_targets"("radius_m" double precision, "cooldown_secs" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."claim_places_detail_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."claim_places_detail_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."claim_places_detail_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."claim_places_detail_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."claim_places_fetch_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."claim_places_fetch_quota"("p_client_key" "text", "p_daily_cap" integer, "p_client_cap" integer, "p_client_window_secs" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."close_poll"("p_message" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."close_poll"("p_message" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."close_poll"("p_message" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."close_poll"("p_message" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."box2df", "public"."box2df") TO "postgres";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."box2df", "public"."box2df") TO "anon";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."box2df", "public"."box2df") TO "authenticated";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."box2df", "public"."box2df") TO "service_role";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."box2df", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."box2df", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."box2df", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."box2df", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."geometry", "public"."box2df") TO "postgres";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."geometry", "public"."box2df") TO "anon";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."geometry", "public"."box2df") TO "authenticated";


GRANT ALL ON FUNCTION "public"."contains_2d"("public"."geometry", "public"."box2df") TO "service_role";


GRANT ALL ON FUNCTION "public"."count_fresh_places_venues"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision, "cat" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."count_fresh_places_venues"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision, "cat" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."count_fresh_places_venues"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision, "cat" "text") TO "service_role";


GRANT ALL ON TABLE "public"."chat_threads" TO "anon";


GRANT ALL ON TABLE "public"."chat_threads" TO "authenticated";


GRANT ALL ON TABLE "public"."chat_threads" TO "service_role";


REVOKE ALL ON FUNCTION "public"."create_thread_with_creator"("p_is_group" boolean, "p_plan_id" "uuid", "p_title" "text") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."create_thread_with_creator"("p_is_group" boolean, "p_plan_id" "uuid", "p_title" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."create_thread_with_creator"("p_is_group" boolean, "p_plan_id" "uuid", "p_title" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."create_thread_with_creator"("p_is_group" boolean, "p_plan_id" "uuid", "p_title" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."current_profile"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."current_profile"() TO "service_role";


GRANT ALL ON FUNCTION "public"."deal_categories"("p_limit" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."deal_categories"("p_limit" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."deal_categories"("p_limit" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."deliver_birthday_offers"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."deliver_birthday_offers"() TO "service_role";


GRANT ALL ON FUNCTION "public"."disablelongtransactions"() TO "postgres";


GRANT ALL ON FUNCTION "public"."disablelongtransactions"() TO "anon";


GRANT ALL ON FUNCTION "public"."disablelongtransactions"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."disablelongtransactions"() TO "service_role";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("table_name" character varying, "column_name" character varying) TO "postgres";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("table_name" character varying, "column_name" character varying) TO "anon";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("table_name" character varying, "column_name" character varying) TO "authenticated";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("table_name" character varying, "column_name" character varying) TO "service_role";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("schema_name" character varying, "table_name" character varying, "column_name" character varying) TO "postgres";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("schema_name" character varying, "table_name" character varying, "column_name" character varying) TO "anon";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("schema_name" character varying, "table_name" character varying, "column_name" character varying) TO "authenticated";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("schema_name" character varying, "table_name" character varying, "column_name" character varying) TO "service_role";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying) TO "postgres";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying) TO "anon";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying) TO "authenticated";


GRANT ALL ON FUNCTION "public"."dropgeometrycolumn"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying) TO "service_role";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("table_name" character varying) TO "postgres";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("table_name" character varying) TO "anon";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("table_name" character varying) TO "authenticated";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("table_name" character varying) TO "service_role";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("schema_name" character varying, "table_name" character varying) TO "postgres";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("schema_name" character varying, "table_name" character varying) TO "anon";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("schema_name" character varying, "table_name" character varying) TO "authenticated";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("schema_name" character varying, "table_name" character varying) TO "service_role";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying) TO "postgres";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying) TO "anon";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying) TO "authenticated";


GRANT ALL ON FUNCTION "public"."dropgeometrytable"("catalog_name" character varying, "schema_name" character varying, "table_name" character varying) TO "service_role";


GRANT ALL ON FUNCTION "public"."enablelongtransactions"() TO "postgres";


GRANT ALL ON FUNCTION "public"."enablelongtransactions"() TO "anon";


GRANT ALL ON FUNCTION "public"."enablelongtransactions"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."enablelongtransactions"() TO "service_role";


GRANT ALL ON FUNCTION "public"."equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."events_bump_interest"() TO "anon";


GRANT ALL ON FUNCTION "public"."events_bump_interest"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."events_bump_interest"() TO "service_role";


GRANT ALL ON FUNCTION "public"."events_near"("lat" double precision, "lng" double precision, "radius_m" double precision, "max_results" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."events_near"("lat" double precision, "lng" double precision, "radius_m" double precision, "max_results" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."events_near"("lat" double precision, "lng" double precision, "radius_m" double precision, "max_results" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."find_srid"(character varying, character varying, character varying) TO "postgres";


GRANT ALL ON FUNCTION "public"."find_srid"(character varying, character varying, character varying) TO "anon";


GRANT ALL ON FUNCTION "public"."find_srid"(character varying, character varying, character varying) TO "authenticated";


GRANT ALL ON FUNCTION "public"."find_srid"(character varying, character varying, character varying) TO "service_role";


GRANT ALL ON FUNCTION "public"."founder_badges_for_profile"("p_profile" "uuid", "p_max_rank" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."founder_badges_for_profile"("p_profile" "uuid", "p_max_rank" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."founder_badges_for_profile"("p_profile" "uuid", "p_max_rank" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."friends_availability"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."friends_availability"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."friends_availability"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."friends_nearby"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."friends_nearby"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."friends_nearby"("origin_lat" double precision, "origin_lng" double precision, "radius_m" double precision) TO "service_role";


REVOKE ALL ON FUNCTION "public"."gen_unique_handle"("seed" "text") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."gen_unique_handle"("seed" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."gen_unique_topic_slug"("p_title" "text", "p_locality" "text") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."gen_unique_topic_slug"("p_title" "text", "p_locality" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."gen_unique_venue_slug"("p_name" "text", "p_locality" "text") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."gen_unique_venue_slug"("p_name" "text", "p_locality" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."geog_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geog_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geog_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geog_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_cmp"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_cmp"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_cmp"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_cmp"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_distance_knn"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_distance_knn"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_distance_knn"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_distance_knn"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_eq"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_eq"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_eq"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_eq"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_ge"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_ge"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_ge"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_ge"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_gist_compress"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_gist_compress"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_gist_compress"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_gist_compress"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_gist_consistent"("internal", "public"."geography", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_gist_consistent"("internal", "public"."geography", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geography_gist_consistent"("internal", "public"."geography", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_gist_consistent"("internal", "public"."geography", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_gist_decompress"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_gist_decompress"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_gist_decompress"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_gist_decompress"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_gist_distance"("internal", "public"."geography", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_gist_distance"("internal", "public"."geography", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geography_gist_distance"("internal", "public"."geography", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_gist_distance"("internal", "public"."geography", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_gist_penalty"("internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_gist_penalty"("internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_gist_penalty"("internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_gist_penalty"("internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_gist_picksplit"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_gist_picksplit"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_gist_picksplit"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_gist_picksplit"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_gist_same"("public"."box2d", "public"."box2d", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_gist_same"("public"."box2d", "public"."box2d", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_gist_same"("public"."box2d", "public"."box2d", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_gist_same"("public"."box2d", "public"."box2d", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_gist_union"("bytea", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_gist_union"("bytea", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_gist_union"("bytea", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_gist_union"("bytea", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_gt"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_gt"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_gt"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_gt"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_le"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_le"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_le"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_le"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_lt"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_lt"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_lt"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_lt"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_overlaps"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_overlaps"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_overlaps"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_overlaps"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_spgist_choose_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_spgist_choose_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_spgist_choose_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_spgist_choose_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_spgist_compress_nd"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_spgist_compress_nd"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_spgist_compress_nd"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_spgist_compress_nd"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_spgist_config_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_spgist_config_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_spgist_config_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_spgist_config_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_spgist_inner_consistent_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_spgist_inner_consistent_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_spgist_inner_consistent_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_spgist_inner_consistent_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_spgist_leaf_consistent_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_spgist_leaf_consistent_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_spgist_leaf_consistent_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_spgist_leaf_consistent_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geography_spgist_picksplit_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geography_spgist_picksplit_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geography_spgist_picksplit_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geography_spgist_picksplit_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geom2d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geom2d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geom2d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geom2d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geom3d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geom3d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geom3d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geom3d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geom4d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geom4d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geom4d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geom4d_brin_inclusion_add_value"("internal", "internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_above"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_above"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_above"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_above"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_below"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_below"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_below"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_below"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_cmp"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_cmp"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_cmp"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_cmp"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_contained_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_contained_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_contained_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_contained_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_contains_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_contains_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_contains_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_contains_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_contains_nd"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_contains_nd"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_contains_nd"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_contains_nd"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_distance_box"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_distance_box"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_distance_box"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_distance_box"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_distance_centroid"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_distance_centroid"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_distance_centroid"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_distance_centroid"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_distance_centroid_nd"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_distance_centroid_nd"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_distance_centroid_nd"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_distance_centroid_nd"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_distance_cpa"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_distance_cpa"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_distance_cpa"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_distance_cpa"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_eq"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_eq"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_eq"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_eq"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_ge"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_ge"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_ge"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_ge"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_compress_2d"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_compress_2d"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_compress_2d"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_compress_2d"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_compress_nd"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_compress_nd"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_compress_nd"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_compress_nd"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_consistent_2d"("internal", "public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_consistent_2d"("internal", "public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_consistent_2d"("internal", "public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_consistent_2d"("internal", "public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_consistent_nd"("internal", "public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_consistent_nd"("internal", "public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_consistent_nd"("internal", "public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_consistent_nd"("internal", "public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_decompress_2d"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_decompress_2d"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_decompress_2d"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_decompress_2d"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_decompress_nd"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_decompress_nd"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_decompress_nd"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_decompress_nd"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_distance_2d"("internal", "public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_distance_2d"("internal", "public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_distance_2d"("internal", "public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_distance_2d"("internal", "public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_distance_nd"("internal", "public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_distance_nd"("internal", "public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_distance_nd"("internal", "public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_distance_nd"("internal", "public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_penalty_2d"("internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_penalty_2d"("internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_penalty_2d"("internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_penalty_2d"("internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_penalty_nd"("internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_penalty_nd"("internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_penalty_nd"("internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_penalty_nd"("internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_picksplit_2d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_picksplit_2d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_picksplit_2d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_picksplit_2d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_picksplit_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_picksplit_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_picksplit_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_picksplit_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_same_2d"("geom1" "public"."geometry", "geom2" "public"."geometry", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_same_2d"("geom1" "public"."geometry", "geom2" "public"."geometry", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_same_2d"("geom1" "public"."geometry", "geom2" "public"."geometry", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_same_2d"("geom1" "public"."geometry", "geom2" "public"."geometry", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_same_nd"("public"."geometry", "public"."geometry", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_same_nd"("public"."geometry", "public"."geometry", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_same_nd"("public"."geometry", "public"."geometry", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_same_nd"("public"."geometry", "public"."geometry", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_sortsupport_2d"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_sortsupport_2d"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_sortsupport_2d"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_sortsupport_2d"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_union_2d"("bytea", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_union_2d"("bytea", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_union_2d"("bytea", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_union_2d"("bytea", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gist_union_nd"("bytea", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gist_union_nd"("bytea", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gist_union_nd"("bytea", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gist_union_nd"("bytea", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_gt"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_gt"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_gt"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_gt"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_hash"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_hash"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_hash"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_hash"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_le"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_le"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_le"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_le"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_left"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_left"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_left"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_left"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_lt"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_lt"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_lt"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_lt"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_overabove"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_overabove"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_overabove"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_overabove"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_overbelow"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_overbelow"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_overbelow"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_overbelow"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_overlaps_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_overlaps_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_overlaps_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_overlaps_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_overlaps_nd"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_overlaps_nd"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_overlaps_nd"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_overlaps_nd"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_overleft"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_overleft"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_overleft"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_overleft"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_overright"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_overright"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_overright"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_overright"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_right"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_right"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_right"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_right"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_same"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_same"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_same"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_same"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_same_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_same_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_same_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_same_3d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_same_nd"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_same_nd"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_same_nd"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_same_nd"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_sortsupport"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_sortsupport"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_sortsupport"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_sortsupport"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_2d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_2d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_2d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_2d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_3d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_3d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_3d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_3d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_choose_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_2d"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_2d"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_2d"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_2d"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_3d"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_3d"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_3d"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_3d"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_nd"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_nd"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_nd"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_compress_nd"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_2d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_2d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_2d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_2d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_3d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_3d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_3d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_3d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_config_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_2d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_2d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_2d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_2d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_3d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_3d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_3d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_3d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_inner_consistent_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_2d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_2d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_2d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_2d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_3d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_3d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_3d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_3d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_leaf_consistent_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_2d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_2d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_2d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_2d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_3d"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_3d"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_3d"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_3d"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_nd"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_nd"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_nd"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_spgist_picksplit_nd"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometry_within_nd"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometry_within_nd"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometry_within_nd"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometry_within_nd"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometrytype"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometrytype"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."geometrytype"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometrytype"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."geometrytype"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."geometrytype"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."geometrytype"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geometrytype"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."geomfromewkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."geomfromewkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."geomfromewkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geomfromewkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."geomfromewkt"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."geomfromewkt"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."geomfromewkt"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."geomfromewkt"("text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_or_create_direct_thread"("p_other" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."get_or_create_direct_thread"("p_other" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."get_or_create_direct_thread"("p_other" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."get_or_create_direct_thread"("p_other" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."get_or_create_plan_thread"("p_plan_id" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."get_or_create_plan_thread"("p_plan_id" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."get_or_create_plan_thread"("p_plan_id" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."get_or_create_plan_thread"("p_plan_id" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."get_proj4_from_srid"(integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."get_proj4_from_srid"(integer) TO "anon";


GRANT ALL ON FUNCTION "public"."get_proj4_from_srid"(integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."get_proj4_from_srid"(integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."gettransactionid"() TO "postgres";


GRANT ALL ON FUNCTION "public"."gettransactionid"() TO "anon";


GRANT ALL ON FUNCTION "public"."gettransactionid"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."gettransactionid"() TO "service_role";


GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gin_extract_query_trgm"("text", "internal", smallint, "internal", "internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gin_extract_value_trgm"("text", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gin_trgm_consistent"("internal", smallint, "text", integer, "internal", "internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gin_trgm_triconsistent"("internal", smallint, "text", integer, "internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gserialized_gist_joinsel_2d"("internal", "oid", "internal", smallint) TO "postgres";


GRANT ALL ON FUNCTION "public"."gserialized_gist_joinsel_2d"("internal", "oid", "internal", smallint) TO "anon";


GRANT ALL ON FUNCTION "public"."gserialized_gist_joinsel_2d"("internal", "oid", "internal", smallint) TO "authenticated";


GRANT ALL ON FUNCTION "public"."gserialized_gist_joinsel_2d"("internal", "oid", "internal", smallint) TO "service_role";


GRANT ALL ON FUNCTION "public"."gserialized_gist_joinsel_nd"("internal", "oid", "internal", smallint) TO "postgres";


GRANT ALL ON FUNCTION "public"."gserialized_gist_joinsel_nd"("internal", "oid", "internal", smallint) TO "anon";


GRANT ALL ON FUNCTION "public"."gserialized_gist_joinsel_nd"("internal", "oid", "internal", smallint) TO "authenticated";


GRANT ALL ON FUNCTION "public"."gserialized_gist_joinsel_nd"("internal", "oid", "internal", smallint) TO "service_role";


GRANT ALL ON FUNCTION "public"."gserialized_gist_sel_2d"("internal", "oid", "internal", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."gserialized_gist_sel_2d"("internal", "oid", "internal", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."gserialized_gist_sel_2d"("internal", "oid", "internal", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."gserialized_gist_sel_2d"("internal", "oid", "internal", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."gserialized_gist_sel_nd"("internal", "oid", "internal", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."gserialized_gist_sel_nd"("internal", "oid", "internal", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."gserialized_gist_sel_nd"("internal", "oid", "internal", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."gserialized_gist_sel_nd"("internal", "oid", "internal", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_compress"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_consistent"("internal", "text", smallint, "oid", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_decompress"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_distance"("internal", "text", smallint, "oid", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_options"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_penalty"("internal", "internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_picksplit"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_same"("public"."gtrgm", "public"."gtrgm", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."gtrgm_union"("internal", "internal") TO "service_role";


REVOKE ALL ON FUNCTION "public"."handle_new_auth_user"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."handle_new_auth_user"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."in_thread"("t" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."in_thread"("t" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."in_thread"("t" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."in_thread"("t" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."box2df", "public"."box2df") TO "postgres";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."box2df", "public"."box2df") TO "anon";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."box2df", "public"."box2df") TO "authenticated";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."box2df", "public"."box2df") TO "service_role";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."box2df", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."box2df", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."box2df", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."box2df", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."geometry", "public"."box2df") TO "postgres";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."geometry", "public"."box2df") TO "anon";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."geometry", "public"."box2df") TO "authenticated";


GRANT ALL ON FUNCTION "public"."is_contained_2d"("public"."geometry", "public"."box2df") TO "service_role";


GRANT ALL ON FUNCTION "public"."is_free_mail_host"("host" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."is_free_mail_host"("host" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."is_free_mail_host"("host" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."is_non_evidence_host"("host" "text") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."is_non_evidence_host"("host" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."is_non_evidence_host"("host" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."is_non_evidence_host"("host" "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."is_plan_member"("p_plan" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."is_plan_member"("p_plan" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."is_plan_member"("p_plan" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."is_plan_member"("p_plan" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."locality_founding_stats"("p_locality" "text", "p_viewer" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."locality_founding_stats"("p_locality" "text", "p_viewer" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."locality_founding_stats"("p_locality" "text", "p_viewer" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", timestamp without time zone) TO "postgres";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", timestamp without time zone) TO "anon";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", timestamp without time zone) TO "authenticated";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", timestamp without time zone) TO "service_role";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", "text", timestamp without time zone) TO "postgres";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", "text", timestamp without time zone) TO "anon";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", "text", timestamp without time zone) TO "authenticated";


GRANT ALL ON FUNCTION "public"."lockrow"("text", "text", "text", "text", timestamp without time zone) TO "service_role";


GRANT ALL ON FUNCTION "public"."longtransactionsenabled"() TO "postgres";


GRANT ALL ON FUNCTION "public"."longtransactionsenabled"() TO "anon";


GRANT ALL ON FUNCTION "public"."longtransactionsenabled"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."longtransactionsenabled"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."mark_thread_read"("p_thread" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."mark_thread_read"("p_thread" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."mark_thread_read"("p_thread" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."mark_thread_read"("p_thread" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."mark_venue_activity_read"("p_venue" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."mark_venue_activity_read"("p_venue" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."mark_venue_activity_read"("p_venue" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."moderate_ban_profile"("p_user_id" "uuid", "p_banned" boolean) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."moderate_ban_profile"("p_user_id" "uuid", "p_banned" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."moderate_revoke_claim"("p_venue_id" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."moderate_revoke_claim"("p_venue_id" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."moderate_set_venue_suspended"("p_venue_id" "uuid", "p_suspended" boolean) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."moderate_set_venue_suspended"("p_venue_id" "uuid", "p_suspended" boolean) TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_business_post_comment"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_business_post_comment"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_business_post_like"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_business_post_like"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_event_cancelled"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_event_cancelled"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_event_interest"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_event_interest"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_friend_event"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_friend_event"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_locality_newcomer"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_locality_newcomer"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_offer_followers"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_offer_followers"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_plan_member"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_plan_member"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_post_like"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_post_like"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_reply_upvote"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_reply_upvote"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_topic_upvote"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_topic_upvote"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_townhall_reply"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_townhall_reply"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_venue_claim"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_venue_claim"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_venue_follow"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_venue_follow"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_venue_review"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_venue_review"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."notify_wall_comment"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."notify_wall_comment"() TO "service_role";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."box2df", "public"."box2df") TO "postgres";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."box2df", "public"."box2df") TO "anon";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."box2df", "public"."box2df") TO "authenticated";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."box2df", "public"."box2df") TO "service_role";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."box2df", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."box2df", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."box2df", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."box2df", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."geometry", "public"."box2df") TO "postgres";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."geometry", "public"."box2df") TO "anon";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."geometry", "public"."box2df") TO "authenticated";


GRANT ALL ON FUNCTION "public"."overlaps_2d"("public"."geometry", "public"."box2df") TO "service_role";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."geography", "public"."gidx") TO "postgres";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."geography", "public"."gidx") TO "anon";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."geography", "public"."gidx") TO "authenticated";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."geography", "public"."gidx") TO "service_role";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."gidx", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."gidx", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."gidx", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."gidx", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."gidx", "public"."gidx") TO "postgres";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."gidx", "public"."gidx") TO "anon";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."gidx", "public"."gidx") TO "authenticated";


GRANT ALL ON FUNCTION "public"."overlaps_geog"("public"."gidx", "public"."gidx") TO "service_role";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."geometry", "public"."gidx") TO "postgres";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."geometry", "public"."gidx") TO "anon";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."geometry", "public"."gidx") TO "authenticated";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."geometry", "public"."gidx") TO "service_role";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."gidx", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."gidx", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."gidx", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."gidx", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."gidx", "public"."gidx") TO "postgres";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."gidx", "public"."gidx") TO "anon";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."gidx", "public"."gidx") TO "authenticated";


GRANT ALL ON FUNCTION "public"."overlaps_nd"("public"."gidx", "public"."gidx") TO "service_role";


REVOKE ALL ON FUNCTION "public"."owns_plan"("p_plan" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."owns_plan"("p_plan" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."owns_plan"("p_plan" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."owns_plan"("p_plan" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_finalfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_finalfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_finalfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_finalfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement", boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement", boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement", boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement", boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement", boolean, "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement", boolean, "text") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement", boolean, "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asflatgeobuf_transfn"("internal", "anyelement", boolean, "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_finalfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_finalfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_finalfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_finalfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_transfn"("internal", "anyelement") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_transfn"("internal", "anyelement") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_transfn"("internal", "anyelement") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_transfn"("internal", "anyelement") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_transfn"("internal", "anyelement", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_transfn"("internal", "anyelement", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_transfn"("internal", "anyelement", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asgeobuf_transfn"("internal", "anyelement", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_combinefn"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_combinefn"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_combinefn"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_combinefn"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_deserialfn"("bytea", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_deserialfn"("bytea", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_deserialfn"("bytea", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_deserialfn"("bytea", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_finalfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_finalfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_finalfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_finalfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_serialfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_serialfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_serialfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_serialfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer, "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer, "text") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer, "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer, "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer, "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer, "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer, "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_asmvt_transfn"("internal", "anyelement", "text", integer, "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry", double precision, integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry", double precision, integer) TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry", double precision, integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_accum_transfn"("internal", "public"."geometry", double precision, integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_clusterintersecting_finalfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_clusterintersecting_finalfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_clusterintersecting_finalfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_clusterintersecting_finalfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_clusterwithin_finalfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_clusterwithin_finalfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_clusterwithin_finalfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_clusterwithin_finalfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_collect_finalfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_collect_finalfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_collect_finalfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_collect_finalfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_makeline_finalfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_makeline_finalfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_makeline_finalfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_makeline_finalfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_polygonize_finalfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_polygonize_finalfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_polygonize_finalfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_polygonize_finalfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_combinefn"("internal", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_combinefn"("internal", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_combinefn"("internal", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_combinefn"("internal", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_deserialfn"("bytea", "internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_deserialfn"("bytea", "internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_deserialfn"("bytea", "internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_deserialfn"("bytea", "internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_finalfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_finalfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_finalfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_finalfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_serialfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_serialfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_serialfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_serialfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_transfn"("internal", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_transfn"("internal", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_transfn"("internal", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_transfn"("internal", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_transfn"("internal", "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_transfn"("internal", "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_transfn"("internal", "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."pgis_geometry_union_parallel_transfn"("internal", "public"."geometry", double precision) TO "service_role";


REVOKE ALL ON FUNCTION "public"."plan_venue_suggestions"("plan_id_param" "uuid", "max_results" integer) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."plan_venue_suggestions"("plan_id_param" "uuid", "max_results" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."plan_venue_suggestions"("plan_id_param" "uuid", "max_results" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."plan_venue_suggestions"("plan_id_param" "uuid", "max_results" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."poll_results"("p_message" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."poll_results"("p_message" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."poll_results"("p_message" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."populate_geometry_columns"("use_typmod" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."populate_geometry_columns"("use_typmod" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."populate_geometry_columns"("use_typmod" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."populate_geometry_columns"("use_typmod" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."populate_geometry_columns"("tbl_oid" "oid", "use_typmod" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."populate_geometry_columns"("tbl_oid" "oid", "use_typmod" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."populate_geometry_columns"("tbl_oid" "oid", "use_typmod" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."populate_geometry_columns"("tbl_oid" "oid", "use_typmod" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_addbbox"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_addbbox"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_addbbox"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_addbbox"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_cache_bbox"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_cache_bbox"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_cache_bbox"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_cache_bbox"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_constraint_dims"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_constraint_dims"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_constraint_dims"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_constraint_dims"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_constraint_srid"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_constraint_srid"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_constraint_srid"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_constraint_srid"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_constraint_type"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_constraint_type"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_constraint_type"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_constraint_type"("geomschema" "text", "geomtable" "text", "geomcolumn" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_dropbbox"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_dropbbox"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_dropbbox"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_dropbbox"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_extensions_upgrade"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_extensions_upgrade"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_extensions_upgrade"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_extensions_upgrade"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_full_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_full_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_full_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_full_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_geos_noop"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_geos_noop"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_geos_noop"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_geos_noop"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_geos_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_geos_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_geos_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_geos_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_getbbox"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_getbbox"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_getbbox"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_getbbox"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_hasbbox"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_hasbbox"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_hasbbox"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_hasbbox"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_index_supportfn"("internal") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_index_supportfn"("internal") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_index_supportfn"("internal") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_index_supportfn"("internal") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_lib_build_date"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_lib_build_date"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_lib_build_date"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_lib_build_date"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_lib_revision"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_lib_revision"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_lib_revision"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_lib_revision"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_lib_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_lib_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_lib_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_lib_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_libjson_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_libjson_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_libjson_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_libjson_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_liblwgeom_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_liblwgeom_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_liblwgeom_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_liblwgeom_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_libprotobuf_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_libprotobuf_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_libprotobuf_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_libprotobuf_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_libxml_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_libxml_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_libxml_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_libxml_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_noop"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_noop"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_noop"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_noop"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_proj_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_proj_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_proj_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_proj_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_scripts_build_date"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_scripts_build_date"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_scripts_build_date"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_scripts_build_date"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_scripts_installed"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_scripts_installed"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_scripts_installed"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_scripts_installed"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_scripts_released"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_scripts_released"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_scripts_released"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_scripts_released"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_svn_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_svn_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_svn_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_svn_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_transform_geometry"("geom" "public"."geometry", "text", "text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_transform_geometry"("geom" "public"."geometry", "text", "text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_transform_geometry"("geom" "public"."geometry", "text", "text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_transform_geometry"("geom" "public"."geometry", "text", "text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_type_name"("geomname" character varying, "coord_dimension" integer, "use_new_name" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_type_name"("geomname" character varying, "coord_dimension" integer, "use_new_name" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_type_name"("geomname" character varying, "coord_dimension" integer, "use_new_name" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_type_name"("geomname" character varying, "coord_dimension" integer, "use_new_name" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_typmod_dims"(integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_typmod_dims"(integer) TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_typmod_dims"(integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_typmod_dims"(integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_typmod_srid"(integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_typmod_srid"(integer) TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_typmod_srid"(integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_typmod_srid"(integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_typmod_type"(integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_typmod_type"(integer) TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_typmod_type"(integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_typmod_type"(integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_version"() TO "service_role";


GRANT ALL ON FUNCTION "public"."postgis_wagyu_version"() TO "postgres";


GRANT ALL ON FUNCTION "public"."postgis_wagyu_version"() TO "anon";


GRANT ALL ON FUNCTION "public"."postgis_wagyu_version"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."postgis_wagyu_version"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."posts_bump_comments"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."posts_bump_comments"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."posts_bump_likes"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."posts_bump_likes"() TO "service_role";


GRANT ALL ON FUNCTION "public"."posts_feed_near"("lat" double precision, "lng" double precision, "radius_m" double precision, "max_results" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."posts_feed_near"("lat" double precision, "lng" double precision, "radius_m" double precision, "max_results" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."posts_feed_near"("lat" double precision, "lng" double precision, "radius_m" double precision, "max_results" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."profile_post_bump_comments"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."profile_post_bump_comments"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."profile_post_bump_likes"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."profile_post_bump_likes"() TO "service_role";


GRANT ALL ON FUNCTION "public"."record_listing_view"("p_listing" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."record_listing_view"("p_listing" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."record_listing_view"("p_listing" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."record_profile_view"("p_profile" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."record_profile_view"("p_profile" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."record_profile_view"("p_profile" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."record_profile_view"("p_profile" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."record_venue_view"("p_venue" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."record_venue_view"("p_venue" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."record_venue_view"("p_venue" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."redeem_birthday_offer"("p_venue" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."redeem_birthday_offer"("p_venue" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."redeem_birthday_offer"("p_venue" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."redeem_offer"("p_offer" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."redeem_offer"("p_offer" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."redeem_offer"("p_offer" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."reject_venue_claim"("target_claim_id" "uuid", "reason" "text") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."reject_venue_claim"("target_claim_id" "uuid", "reason" "text") TO "service_role";


GRANT ALL ON TABLE "public"."venue_claims" TO "anon";


GRANT ALL ON TABLE "public"."venue_claims" TO "authenticated";


GRANT ALL ON TABLE "public"."venue_claims" TO "service_role";


REVOKE ALL ON FUNCTION "public"."request_venue_claim"("target_venue_id" "uuid", "claim_note" "text") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."request_venue_claim"("target_venue_id" "uuid", "claim_note" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."request_venue_claim"("target_venue_id" "uuid", "claim_note" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."search_offers"("q" "text", "max_results" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."search_offers"("q" "text", "max_results" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."search_offers"("q" "text", "max_results" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."send_venue_notification"("p_venue" "uuid", "p_text" "text", "p_recipient" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."send_venue_notification"("p_venue" "uuid", "p_text" "text", "p_recipient" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."send_venue_notification"("p_venue" "uuid", "p_text" "text", "p_recipient" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."send_venue_notification"("p_venue" "uuid", "p_text" "text", "p_recipient" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."set_event_geo"() TO "anon";


GRANT ALL ON FUNCTION "public"."set_event_geo"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."set_event_geo"() TO "service_role";


GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "postgres";


GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "anon";


GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "authenticated";


GRANT ALL ON FUNCTION "public"."set_limit"(real) TO "service_role";


REVOKE ALL ON FUNCTION "public"."set_my_location"("p_lat" double precision, "p_lng" double precision, "p_accuracy_m" double precision, "p_ttl_hours" double precision) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."set_my_location"("p_lat" double precision, "p_lng" double precision, "p_accuracy_m" double precision, "p_ttl_hours" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."set_my_location"("p_lat" double precision, "p_lng" double precision, "p_accuracy_m" double precision, "p_ttl_hours" double precision) TO "service_role";


REVOKE ALL ON FUNCTION "public"."set_topic_slug"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."set_topic_slug"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."set_updated_at"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."set_venue_photos_updated_at"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."set_venue_photos_updated_at"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."set_venue_slug"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."set_venue_slug"() TO "service_role";


GRANT ALL ON FUNCTION "public"."show_limit"() TO "postgres";


GRANT ALL ON FUNCTION "public"."show_limit"() TO "anon";


GRANT ALL ON FUNCTION "public"."show_limit"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."show_limit"() TO "service_role";


GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."show_trgm"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."similarity"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."similarity_dist"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."similarity_op"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dclosestpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dclosestpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dclosestpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dclosestpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3ddfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3ddfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_3ddfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3ddfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3ddistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3ddistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3ddistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3ddistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3ddwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3ddwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_3ddwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3ddwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dintersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dintersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dintersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dintersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dlength"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dlength"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dlength"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dlength"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dlineinterpolatepoint"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dlineinterpolatepoint"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dlineinterpolatepoint"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dlineinterpolatepoint"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dlongestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dlongestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dlongestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dlongestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dmakebox"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dmakebox"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dmakebox"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dmakebox"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dmaxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dmaxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dmaxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dmaxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dperimeter"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dperimeter"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dperimeter"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dperimeter"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dshortestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dshortestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dshortestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dshortestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_addmeasure"("public"."geometry", double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_addmeasure"("public"."geometry", double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_addmeasure"("public"."geometry", double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_addmeasure"("public"."geometry", double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_addpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_addpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_addpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_addpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_addpoint"("geom1" "public"."geometry", "geom2" "public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_addpoint"("geom1" "public"."geometry", "geom2" "public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_addpoint"("geom1" "public"."geometry", "geom2" "public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_addpoint"("geom1" "public"."geometry", "geom2" "public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_affine"("public"."geometry", double precision, double precision, double precision, double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_affine"("public"."geometry", double precision, double precision, double precision, double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_affine"("public"."geometry", double precision, double precision, double precision, double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_affine"("public"."geometry", double precision, double precision, double precision, double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_affine"("public"."geometry", double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_affine"("public"."geometry", double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_affine"("public"."geometry", double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_affine"("public"."geometry", double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_angle"("line1" "public"."geometry", "line2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_angle"("line1" "public"."geometry", "line2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_angle"("line1" "public"."geometry", "line2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_angle"("line1" "public"."geometry", "line2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_angle"("pt1" "public"."geometry", "pt2" "public"."geometry", "pt3" "public"."geometry", "pt4" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_angle"("pt1" "public"."geometry", "pt2" "public"."geometry", "pt3" "public"."geometry", "pt4" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_angle"("pt1" "public"."geometry", "pt2" "public"."geometry", "pt3" "public"."geometry", "pt4" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_angle"("pt1" "public"."geometry", "pt2" "public"."geometry", "pt3" "public"."geometry", "pt4" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_area"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_area"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_area"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_area"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_area"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_area"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_area"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_area"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_area"("geog" "public"."geography", "use_spheroid" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_area"("geog" "public"."geography", "use_spheroid" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_area"("geog" "public"."geography", "use_spheroid" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_area"("geog" "public"."geography", "use_spheroid" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_area2d"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_area2d"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_area2d"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_area2d"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geography", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geography", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geography", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geography", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geometry", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geometry", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geometry", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asbinary"("public"."geometry", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asencodedpolyline"("geom" "public"."geometry", "nprecision" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asencodedpolyline"("geom" "public"."geometry", "nprecision" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asencodedpolyline"("geom" "public"."geometry", "nprecision" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asencodedpolyline"("geom" "public"."geometry", "nprecision" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asewkb"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asewkb"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asewkb"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asewkb"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asewkb"("public"."geometry", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asewkb"("public"."geometry", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asewkb"("public"."geometry", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asewkb"("public"."geometry", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asewkt"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asewkt"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asewkt"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asewkt"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geography", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geography", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geography", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geography", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asewkt"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("geog" "public"."geography", "maxdecimaldigits" integer, "options" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("geog" "public"."geography", "maxdecimaldigits" integer, "options" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("geog" "public"."geography", "maxdecimaldigits" integer, "options" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("geog" "public"."geography", "maxdecimaldigits" integer, "options" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("r" "record", "geom_column" "text", "maxdecimaldigits" integer, "pretty_bool" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("r" "record", "geom_column" "text", "maxdecimaldigits" integer, "pretty_bool" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("r" "record", "geom_column" "text", "maxdecimaldigits" integer, "pretty_bool" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgeojson"("r" "record", "geom_column" "text", "maxdecimaldigits" integer, "pretty_bool" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgml"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgml"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgml"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgml"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgml"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgml"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgml"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgml"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgml"("geog" "public"."geography", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgml"("geog" "public"."geography", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgml"("geog" "public"."geography", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgml"("geog" "public"."geography", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgml"("version" integer, "geog" "public"."geography", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgml"("version" integer, "geog" "public"."geography", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgml"("version" integer, "geog" "public"."geography", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgml"("version" integer, "geog" "public"."geography", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgml"("version" integer, "geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgml"("version" integer, "geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgml"("version" integer, "geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgml"("version" integer, "geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer, "nprefix" "text", "id" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_ashexewkb"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_ashexewkb"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_ashexewkb"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_ashexewkb"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_ashexewkb"("public"."geometry", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_ashexewkb"("public"."geometry", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_ashexewkb"("public"."geometry", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_ashexewkb"("public"."geometry", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_askml"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_askml"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_askml"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_askml"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_askml"("geog" "public"."geography", "maxdecimaldigits" integer, "nprefix" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_askml"("geog" "public"."geography", "maxdecimaldigits" integer, "nprefix" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_askml"("geog" "public"."geography", "maxdecimaldigits" integer, "nprefix" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_askml"("geog" "public"."geography", "maxdecimaldigits" integer, "nprefix" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_askml"("geom" "public"."geometry", "maxdecimaldigits" integer, "nprefix" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_askml"("geom" "public"."geometry", "maxdecimaldigits" integer, "nprefix" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_askml"("geom" "public"."geometry", "maxdecimaldigits" integer, "nprefix" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_askml"("geom" "public"."geometry", "maxdecimaldigits" integer, "nprefix" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_aslatlontext"("geom" "public"."geometry", "tmpl" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_aslatlontext"("geom" "public"."geometry", "tmpl" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_aslatlontext"("geom" "public"."geometry", "tmpl" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_aslatlontext"("geom" "public"."geometry", "tmpl" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asmarc21"("geom" "public"."geometry", "format" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asmarc21"("geom" "public"."geometry", "format" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asmarc21"("geom" "public"."geometry", "format" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asmarc21"("geom" "public"."geometry", "format" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asmvtgeom"("geom" "public"."geometry", "bounds" "public"."box2d", "extent" integer, "buffer" integer, "clip_geom" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asmvtgeom"("geom" "public"."geometry", "bounds" "public"."box2d", "extent" integer, "buffer" integer, "clip_geom" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asmvtgeom"("geom" "public"."geometry", "bounds" "public"."box2d", "extent" integer, "buffer" integer, "clip_geom" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asmvtgeom"("geom" "public"."geometry", "bounds" "public"."box2d", "extent" integer, "buffer" integer, "clip_geom" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_assvg"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_assvg"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_assvg"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_assvg"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_assvg"("geog" "public"."geography", "rel" integer, "maxdecimaldigits" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_assvg"("geog" "public"."geography", "rel" integer, "maxdecimaldigits" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_assvg"("geog" "public"."geography", "rel" integer, "maxdecimaldigits" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_assvg"("geog" "public"."geography", "rel" integer, "maxdecimaldigits" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_assvg"("geom" "public"."geometry", "rel" integer, "maxdecimaldigits" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_assvg"("geom" "public"."geometry", "rel" integer, "maxdecimaldigits" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_assvg"("geom" "public"."geometry", "rel" integer, "maxdecimaldigits" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_assvg"("geom" "public"."geometry", "rel" integer, "maxdecimaldigits" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_astext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_astext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_astext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_astext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geography", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geography", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geography", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geography", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_astext"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_astwkb"("geom" "public"."geometry", "prec" integer, "prec_z" integer, "prec_m" integer, "with_sizes" boolean, "with_boxes" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_astwkb"("geom" "public"."geometry", "prec" integer, "prec_z" integer, "prec_m" integer, "with_sizes" boolean, "with_boxes" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_astwkb"("geom" "public"."geometry", "prec" integer, "prec_z" integer, "prec_m" integer, "with_sizes" boolean, "with_boxes" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_astwkb"("geom" "public"."geometry", "prec" integer, "prec_z" integer, "prec_m" integer, "with_sizes" boolean, "with_boxes" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_astwkb"("geom" "public"."geometry"[], "ids" bigint[], "prec" integer, "prec_z" integer, "prec_m" integer, "with_sizes" boolean, "with_boxes" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_astwkb"("geom" "public"."geometry"[], "ids" bigint[], "prec" integer, "prec_z" integer, "prec_m" integer, "with_sizes" boolean, "with_boxes" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_astwkb"("geom" "public"."geometry"[], "ids" bigint[], "prec" integer, "prec_z" integer, "prec_m" integer, "with_sizes" boolean, "with_boxes" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_astwkb"("geom" "public"."geometry"[], "ids" bigint[], "prec" integer, "prec_z" integer, "prec_m" integer, "with_sizes" boolean, "with_boxes" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asx3d"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asx3d"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asx3d"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asx3d"("geom" "public"."geometry", "maxdecimaldigits" integer, "options" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_azimuth"("geog1" "public"."geography", "geog2" "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_azimuth"("geog1" "public"."geography", "geog2" "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_azimuth"("geog1" "public"."geography", "geog2" "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_azimuth"("geog1" "public"."geography", "geog2" "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_azimuth"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_azimuth"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_azimuth"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_azimuth"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_bdmpolyfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_bdmpolyfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_bdmpolyfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_bdmpolyfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_bdpolyfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_bdpolyfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_bdpolyfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_bdpolyfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_boundary"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_boundary"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_boundary"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_boundary"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_boundingdiagonal"("geom" "public"."geometry", "fits" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_boundingdiagonal"("geom" "public"."geometry", "fits" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_boundingdiagonal"("geom" "public"."geometry", "fits" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_boundingdiagonal"("geom" "public"."geometry", "fits" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_box2dfromgeohash"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_box2dfromgeohash"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_box2dfromgeohash"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_box2dfromgeohash"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision, integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision, integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision, integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision, integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision, "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision, "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision, "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_buffer"("text", double precision, "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision, integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision, integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision, integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision, integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision, "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision, "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision, "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_buffer"("public"."geography", double precision, "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_buffer"("geom" "public"."geometry", "radius" double precision, "quadsegs" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_buffer"("geom" "public"."geometry", "radius" double precision, "quadsegs" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_buffer"("geom" "public"."geometry", "radius" double precision, "quadsegs" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_buffer"("geom" "public"."geometry", "radius" double precision, "quadsegs" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_buffer"("geom" "public"."geometry", "radius" double precision, "options" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_buffer"("geom" "public"."geometry", "radius" double precision, "options" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_buffer"("geom" "public"."geometry", "radius" double precision, "options" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_buffer"("geom" "public"."geometry", "radius" double precision, "options" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_buildarea"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_buildarea"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_buildarea"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_buildarea"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_centroid"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_centroid"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_centroid"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_centroid"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_centroid"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_centroid"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_centroid"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_centroid"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_centroid"("public"."geography", "use_spheroid" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_centroid"("public"."geography", "use_spheroid" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_centroid"("public"."geography", "use_spheroid" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_centroid"("public"."geography", "use_spheroid" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_chaikinsmoothing"("public"."geometry", integer, boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_chaikinsmoothing"("public"."geometry", integer, boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_chaikinsmoothing"("public"."geometry", integer, boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_chaikinsmoothing"("public"."geometry", integer, boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_cleangeometry"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_cleangeometry"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_cleangeometry"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_cleangeometry"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_clipbybox2d"("geom" "public"."geometry", "box" "public"."box2d") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_clipbybox2d"("geom" "public"."geometry", "box" "public"."box2d") TO "anon";


GRANT ALL ON FUNCTION "public"."st_clipbybox2d"("geom" "public"."geometry", "box" "public"."box2d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_clipbybox2d"("geom" "public"."geometry", "box" "public"."box2d") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_closestpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_closestpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_closestpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_closestpoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_closestpointofapproach"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_closestpointofapproach"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_closestpointofapproach"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_closestpointofapproach"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_clusterdbscan"("public"."geometry", "eps" double precision, "minpoints" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_clusterdbscan"("public"."geometry", "eps" double precision, "minpoints" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_clusterdbscan"("public"."geometry", "eps" double precision, "minpoints" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_clusterdbscan"("public"."geometry", "eps" double precision, "minpoints" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_clusterintersecting"("public"."geometry"[]) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_clusterintersecting"("public"."geometry"[]) TO "anon";


GRANT ALL ON FUNCTION "public"."st_clusterintersecting"("public"."geometry"[]) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_clusterintersecting"("public"."geometry"[]) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_clusterkmeans"("geom" "public"."geometry", "k" integer, "max_radius" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_clusterkmeans"("geom" "public"."geometry", "k" integer, "max_radius" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_clusterkmeans"("geom" "public"."geometry", "k" integer, "max_radius" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_clusterkmeans"("geom" "public"."geometry", "k" integer, "max_radius" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_clusterwithin"("public"."geometry"[], double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_clusterwithin"("public"."geometry"[], double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_clusterwithin"("public"."geometry"[], double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_clusterwithin"("public"."geometry"[], double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_collect"("public"."geometry"[]) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_collect"("public"."geometry"[]) TO "anon";


GRANT ALL ON FUNCTION "public"."st_collect"("public"."geometry"[]) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_collect"("public"."geometry"[]) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_collect"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_collect"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_collect"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_collect"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_collectionextract"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_collectionextract"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_collectionextract"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_collectionextract"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_collectionextract"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_collectionextract"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_collectionextract"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_collectionextract"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_collectionhomogenize"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_collectionhomogenize"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_collectionhomogenize"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_collectionhomogenize"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box2d", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box2d", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box2d", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box2d", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box3d", "public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box3d", "public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box3d", "public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box3d", "public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box3d", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box3d", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box3d", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_combinebbox"("public"."box3d", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_concavehull"("param_geom" "public"."geometry", "param_pctconvex" double precision, "param_allow_holes" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_concavehull"("param_geom" "public"."geometry", "param_pctconvex" double precision, "param_allow_holes" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_concavehull"("param_geom" "public"."geometry", "param_pctconvex" double precision, "param_allow_holes" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_concavehull"("param_geom" "public"."geometry", "param_pctconvex" double precision, "param_allow_holes" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_contains"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_containsproperly"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_containsproperly"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_containsproperly"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_containsproperly"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_convexhull"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_convexhull"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_convexhull"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_convexhull"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_coorddim"("geometry" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_coorddim"("geometry" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_coorddim"("geometry" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_coorddim"("geometry" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_coveredby"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_coveredby"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_coveredby"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_coveredby"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_coveredby"("geog1" "public"."geography", "geog2" "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_coveredby"("geog1" "public"."geography", "geog2" "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_coveredby"("geog1" "public"."geography", "geog2" "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_coveredby"("geog1" "public"."geography", "geog2" "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_coveredby"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_coveredby"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_coveredby"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_coveredby"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_covers"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_covers"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_covers"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_covers"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_covers"("geog1" "public"."geography", "geog2" "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_covers"("geog1" "public"."geography", "geog2" "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_covers"("geog1" "public"."geography", "geog2" "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_covers"("geog1" "public"."geography", "geog2" "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_covers"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_covers"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_covers"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_covers"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_cpawithin"("public"."geometry", "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_cpawithin"("public"."geometry", "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_cpawithin"("public"."geometry", "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_cpawithin"("public"."geometry", "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_crosses"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_crosses"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_crosses"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_crosses"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_curvetoline"("geom" "public"."geometry", "tol" double precision, "toltype" integer, "flags" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_curvetoline"("geom" "public"."geometry", "tol" double precision, "toltype" integer, "flags" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_curvetoline"("geom" "public"."geometry", "tol" double precision, "toltype" integer, "flags" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_curvetoline"("geom" "public"."geometry", "tol" double precision, "toltype" integer, "flags" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_delaunaytriangles"("g1" "public"."geometry", "tolerance" double precision, "flags" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_delaunaytriangles"("g1" "public"."geometry", "tolerance" double precision, "flags" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_delaunaytriangles"("g1" "public"."geometry", "tolerance" double precision, "flags" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_delaunaytriangles"("g1" "public"."geometry", "tolerance" double precision, "flags" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_dfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_dfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_dfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_dfullywithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_difference"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_difference"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_difference"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_difference"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_dimension"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_dimension"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_dimension"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_dimension"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_disjoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_disjoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_disjoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_disjoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_distance"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_distance"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_distance"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_distance"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_distance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_distance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_distance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_distance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_distance"("geog1" "public"."geography", "geog2" "public"."geography", "use_spheroid" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_distance"("geog1" "public"."geography", "geog2" "public"."geography", "use_spheroid" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_distance"("geog1" "public"."geography", "geog2" "public"."geography", "use_spheroid" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_distance"("geog1" "public"."geography", "geog2" "public"."geography", "use_spheroid" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_distancecpa"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_distancecpa"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_distancecpa"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_distancecpa"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_distancesphere"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_distancesphere"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_distancesphere"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_distancesphere"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_distancesphere"("geom1" "public"."geometry", "geom2" "public"."geometry", "radius" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_distancesphere"("geom1" "public"."geometry", "geom2" "public"."geometry", "radius" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_distancesphere"("geom1" "public"."geometry", "geom2" "public"."geometry", "radius" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_distancesphere"("geom1" "public"."geometry", "geom2" "public"."geometry", "radius" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_distancespheroid"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_distancespheroid"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_distancespheroid"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_distancespheroid"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_distancespheroid"("geom1" "public"."geometry", "geom2" "public"."geometry", "public"."spheroid") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_distancespheroid"("geom1" "public"."geometry", "geom2" "public"."geometry", "public"."spheroid") TO "anon";


GRANT ALL ON FUNCTION "public"."st_distancespheroid"("geom1" "public"."geometry", "geom2" "public"."geometry", "public"."spheroid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_distancespheroid"("geom1" "public"."geometry", "geom2" "public"."geometry", "public"."spheroid") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_dump"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_dump"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_dump"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_dump"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_dumppoints"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_dumppoints"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_dumppoints"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_dumppoints"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_dumprings"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_dumprings"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_dumprings"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_dumprings"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_dumpsegments"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_dumpsegments"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_dumpsegments"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_dumpsegments"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_dwithin"("text", "text", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_dwithin"("text", "text", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_dwithin"("text", "text", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_dwithin"("text", "text", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_dwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_dwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_dwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_dwithin"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_dwithin"("geog1" "public"."geography", "geog2" "public"."geography", "tolerance" double precision, "use_spheroid" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_dwithin"("geog1" "public"."geography", "geog2" "public"."geography", "tolerance" double precision, "use_spheroid" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_dwithin"("geog1" "public"."geography", "geog2" "public"."geography", "tolerance" double precision, "use_spheroid" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_dwithin"("geog1" "public"."geography", "geog2" "public"."geography", "tolerance" double precision, "use_spheroid" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_endpoint"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_endpoint"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_endpoint"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_endpoint"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_envelope"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_envelope"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_envelope"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_envelope"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_equals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text", "text", boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text", "text", boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text", "text", boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_estimatedextent"("text", "text", "text", boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."box2d", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."box2d", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."box2d", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."box2d", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."box3d", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."box3d", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."box3d", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."box3d", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_expand"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_expand"("box" "public"."box2d", "dx" double precision, "dy" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_expand"("box" "public"."box2d", "dx" double precision, "dy" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_expand"("box" "public"."box2d", "dx" double precision, "dy" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_expand"("box" "public"."box2d", "dx" double precision, "dy" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_expand"("box" "public"."box3d", "dx" double precision, "dy" double precision, "dz" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_expand"("box" "public"."box3d", "dx" double precision, "dy" double precision, "dz" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_expand"("box" "public"."box3d", "dx" double precision, "dy" double precision, "dz" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_expand"("box" "public"."box3d", "dx" double precision, "dy" double precision, "dz" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_expand"("geom" "public"."geometry", "dx" double precision, "dy" double precision, "dz" double precision, "dm" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_expand"("geom" "public"."geometry", "dx" double precision, "dy" double precision, "dz" double precision, "dm" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_expand"("geom" "public"."geometry", "dx" double precision, "dy" double precision, "dz" double precision, "dm" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_expand"("geom" "public"."geometry", "dx" double precision, "dy" double precision, "dz" double precision, "dm" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_exteriorring"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_exteriorring"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_exteriorring"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_exteriorring"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_filterbym"("public"."geometry", double precision, double precision, boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_filterbym"("public"."geometry", double precision, double precision, boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_filterbym"("public"."geometry", double precision, double precision, boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_filterbym"("public"."geometry", double precision, double precision, boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_findextent"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_findextent"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_findextent"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_findextent"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_findextent"("text", "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_findextent"("text", "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_findextent"("text", "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_findextent"("text", "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_flipcoordinates"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_flipcoordinates"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_flipcoordinates"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_flipcoordinates"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_force2d"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_force2d"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_force2d"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_force2d"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_force3d"("geom" "public"."geometry", "zvalue" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_force3d"("geom" "public"."geometry", "zvalue" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_force3d"("geom" "public"."geometry", "zvalue" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_force3d"("geom" "public"."geometry", "zvalue" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_force3dm"("geom" "public"."geometry", "mvalue" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_force3dm"("geom" "public"."geometry", "mvalue" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_force3dm"("geom" "public"."geometry", "mvalue" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_force3dm"("geom" "public"."geometry", "mvalue" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_force3dz"("geom" "public"."geometry", "zvalue" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_force3dz"("geom" "public"."geometry", "zvalue" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_force3dz"("geom" "public"."geometry", "zvalue" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_force3dz"("geom" "public"."geometry", "zvalue" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_force4d"("geom" "public"."geometry", "zvalue" double precision, "mvalue" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_force4d"("geom" "public"."geometry", "zvalue" double precision, "mvalue" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_force4d"("geom" "public"."geometry", "zvalue" double precision, "mvalue" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_force4d"("geom" "public"."geometry", "zvalue" double precision, "mvalue" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_forcecollection"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_forcecollection"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_forcecollection"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_forcecollection"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_forcecurve"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_forcecurve"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_forcecurve"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_forcecurve"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_forcepolygonccw"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_forcepolygonccw"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_forcepolygonccw"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_forcepolygonccw"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_forcepolygoncw"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_forcepolygoncw"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_forcepolygoncw"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_forcepolygoncw"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_forcerhr"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_forcerhr"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_forcerhr"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_forcerhr"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_forcesfs"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_forcesfs"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_forcesfs"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_forcesfs"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_forcesfs"("public"."geometry", "version" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_forcesfs"("public"."geometry", "version" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_forcesfs"("public"."geometry", "version" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_forcesfs"("public"."geometry", "version" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_frechetdistance"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_frechetdistance"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_frechetdistance"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_frechetdistance"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_fromflatgeobuf"("anyelement", "bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_fromflatgeobuf"("anyelement", "bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_fromflatgeobuf"("anyelement", "bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_fromflatgeobuf"("anyelement", "bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_fromflatgeobuftotable"("text", "text", "bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_fromflatgeobuftotable"("text", "text", "bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_fromflatgeobuftotable"("text", "text", "bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_fromflatgeobuftotable"("text", "text", "bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_generatepoints"("area" "public"."geometry", "npoints" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_generatepoints"("area" "public"."geometry", "npoints" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_generatepoints"("area" "public"."geometry", "npoints" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_generatepoints"("area" "public"."geometry", "npoints" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_generatepoints"("area" "public"."geometry", "npoints" integer, "seed" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_generatepoints"("area" "public"."geometry", "npoints" integer, "seed" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_generatepoints"("area" "public"."geometry", "npoints" integer, "seed" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_generatepoints"("area" "public"."geometry", "npoints" integer, "seed" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geogfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geogfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geogfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geogfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geogfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geogfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geogfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geogfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geographyfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geographyfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geographyfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geographyfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geohash"("geog" "public"."geography", "maxchars" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geohash"("geog" "public"."geography", "maxchars" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geohash"("geog" "public"."geography", "maxchars" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geohash"("geog" "public"."geography", "maxchars" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geohash"("geom" "public"."geometry", "maxchars" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geohash"("geom" "public"."geometry", "maxchars" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geohash"("geom" "public"."geometry", "maxchars" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geohash"("geom" "public"."geometry", "maxchars" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomcollfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomcollfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomcollfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomcollfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomcollfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomcollfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomcollfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomcollfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomcollfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomcollfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomcollfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomcollfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomcollfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomcollfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomcollfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomcollfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geometricmedian"("g" "public"."geometry", "tolerance" double precision, "max_iter" integer, "fail_if_not_converged" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geometricmedian"("g" "public"."geometry", "tolerance" double precision, "max_iter" integer, "fail_if_not_converged" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geometricmedian"("g" "public"."geometry", "tolerance" double precision, "max_iter" integer, "fail_if_not_converged" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geometricmedian"("g" "public"."geometry", "tolerance" double precision, "max_iter" integer, "fail_if_not_converged" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geometryfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geometryfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geometryfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geometryfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geometryfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geometryfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geometryfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geometryfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geometryn"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geometryn"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geometryn"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geometryn"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geometrytype"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geometrytype"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geometrytype"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geometrytype"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromewkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromewkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromewkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromewkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromewkt"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromewkt"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromewkt"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromewkt"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromgeohash"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromgeohash"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromgeohash"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromgeohash"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"(json) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"(json) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"(json) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"(json) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"("jsonb") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"("jsonb") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"("jsonb") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"("jsonb") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromgeojson"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromgml"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromgml"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromgml"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromgml"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromgml"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromgml"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromgml"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromgml"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromkml"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromkml"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromkml"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromkml"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfrommarc21"("marc21xml" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfrommarc21"("marc21xml" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfrommarc21"("marc21xml" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfrommarc21"("marc21xml" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromtwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromtwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromtwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromtwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_geomfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_geomfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_geomfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_geomfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_gmltosql"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_gmltosql"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_gmltosql"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_gmltosql"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_gmltosql"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_gmltosql"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_gmltosql"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_gmltosql"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_hasarc"("geometry" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_hasarc"("geometry" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_hasarc"("geometry" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_hasarc"("geometry" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_hausdorffdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_hausdorffdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_hausdorffdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_hausdorffdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_hausdorffdistance"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_hausdorffdistance"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_hausdorffdistance"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_hausdorffdistance"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_hexagon"("size" double precision, "cell_i" integer, "cell_j" integer, "origin" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_hexagon"("size" double precision, "cell_i" integer, "cell_j" integer, "origin" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_hexagon"("size" double precision, "cell_i" integer, "cell_j" integer, "origin" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_hexagon"("size" double precision, "cell_i" integer, "cell_j" integer, "origin" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_hexagongrid"("size" double precision, "bounds" "public"."geometry", OUT "geom" "public"."geometry", OUT "i" integer, OUT "j" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_hexagongrid"("size" double precision, "bounds" "public"."geometry", OUT "geom" "public"."geometry", OUT "i" integer, OUT "j" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_hexagongrid"("size" double precision, "bounds" "public"."geometry", OUT "geom" "public"."geometry", OUT "i" integer, OUT "j" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_hexagongrid"("size" double precision, "bounds" "public"."geometry", OUT "geom" "public"."geometry", OUT "i" integer, OUT "j" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_interiorringn"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_interiorringn"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_interiorringn"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_interiorringn"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_interpolatepoint"("line" "public"."geometry", "point" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_interpolatepoint"("line" "public"."geometry", "point" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_interpolatepoint"("line" "public"."geometry", "point" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_interpolatepoint"("line" "public"."geometry", "point" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_intersection"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_intersection"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_intersection"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_intersection"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_intersection"("public"."geography", "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_intersection"("public"."geography", "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_intersection"("public"."geography", "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_intersection"("public"."geography", "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_intersection"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_intersection"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_intersection"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_intersection"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_intersects"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_intersects"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_intersects"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_intersects"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_intersects"("geog1" "public"."geography", "geog2" "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_intersects"("geog1" "public"."geography", "geog2" "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_intersects"("geog1" "public"."geography", "geog2" "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_intersects"("geog1" "public"."geography", "geog2" "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_intersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_intersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_intersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_intersects"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_isclosed"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_isclosed"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_isclosed"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_isclosed"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_iscollection"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_iscollection"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_iscollection"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_iscollection"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_isempty"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_isempty"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_isempty"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_isempty"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_ispolygonccw"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_ispolygonccw"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_ispolygonccw"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_ispolygonccw"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_ispolygoncw"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_ispolygoncw"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_ispolygoncw"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_ispolygoncw"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_isring"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_isring"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_isring"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_isring"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_issimple"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_issimple"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_issimple"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_issimple"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_isvalid"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_isvalid"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_isvalid"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_isvalid"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_isvalid"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_isvalid"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_isvalid"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_isvalid"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_isvaliddetail"("geom" "public"."geometry", "flags" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_isvaliddetail"("geom" "public"."geometry", "flags" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_isvaliddetail"("geom" "public"."geometry", "flags" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_isvaliddetail"("geom" "public"."geometry", "flags" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_isvalidreason"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_isvalidreason"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_isvalidreason"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_isvalidreason"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_isvalidreason"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_isvalidreason"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_isvalidreason"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_isvalidreason"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_isvalidtrajectory"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_isvalidtrajectory"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_isvalidtrajectory"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_isvalidtrajectory"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_length"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_length"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_length"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_length"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_length"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_length"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_length"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_length"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_length"("geog" "public"."geography", "use_spheroid" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_length"("geog" "public"."geography", "use_spheroid" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_length"("geog" "public"."geography", "use_spheroid" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_length"("geog" "public"."geography", "use_spheroid" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_length2d"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_length2d"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_length2d"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_length2d"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_length2dspheroid"("public"."geometry", "public"."spheroid") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_length2dspheroid"("public"."geometry", "public"."spheroid") TO "anon";


GRANT ALL ON FUNCTION "public"."st_length2dspheroid"("public"."geometry", "public"."spheroid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_length2dspheroid"("public"."geometry", "public"."spheroid") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_lengthspheroid"("public"."geometry", "public"."spheroid") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_lengthspheroid"("public"."geometry", "public"."spheroid") TO "anon";


GRANT ALL ON FUNCTION "public"."st_lengthspheroid"("public"."geometry", "public"."spheroid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_lengthspheroid"("public"."geometry", "public"."spheroid") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_letters"("letters" "text", "font" json) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_letters"("letters" "text", "font" json) TO "anon";


GRANT ALL ON FUNCTION "public"."st_letters"("letters" "text", "font" json) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_letters"("letters" "text", "font" json) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linecrossingdirection"("line1" "public"."geometry", "line2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linecrossingdirection"("line1" "public"."geometry", "line2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_linecrossingdirection"("line1" "public"."geometry", "line2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linecrossingdirection"("line1" "public"."geometry", "line2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linefromencodedpolyline"("txtin" "text", "nprecision" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linefromencodedpolyline"("txtin" "text", "nprecision" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_linefromencodedpolyline"("txtin" "text", "nprecision" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linefromencodedpolyline"("txtin" "text", "nprecision" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linefrommultipoint"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linefrommultipoint"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_linefrommultipoint"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linefrommultipoint"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linefromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linefromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_linefromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linefromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linefromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linefromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_linefromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linefromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linefromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linefromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_linefromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linefromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linefromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linefromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_linefromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linefromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_lineinterpolatepoint"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_lineinterpolatepoint"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_lineinterpolatepoint"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_lineinterpolatepoint"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_lineinterpolatepoints"("public"."geometry", double precision, "repeat" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_lineinterpolatepoints"("public"."geometry", double precision, "repeat" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_lineinterpolatepoints"("public"."geometry", double precision, "repeat" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_lineinterpolatepoints"("public"."geometry", double precision, "repeat" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linelocatepoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linelocatepoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_linelocatepoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linelocatepoint"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linemerge"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linemerge"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_linemerge"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linemerge"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linemerge"("public"."geometry", boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linemerge"("public"."geometry", boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_linemerge"("public"."geometry", boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linemerge"("public"."geometry", boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linestringfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linestringfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_linestringfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linestringfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linestringfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linestringfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_linestringfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linestringfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linesubstring"("public"."geometry", double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linesubstring"("public"."geometry", double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_linesubstring"("public"."geometry", double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linesubstring"("public"."geometry", double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_linetocurve"("geometry" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_linetocurve"("geometry" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_linetocurve"("geometry" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_linetocurve"("geometry" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_locatealong"("geometry" "public"."geometry", "measure" double precision, "leftrightoffset" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_locatealong"("geometry" "public"."geometry", "measure" double precision, "leftrightoffset" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_locatealong"("geometry" "public"."geometry", "measure" double precision, "leftrightoffset" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_locatealong"("geometry" "public"."geometry", "measure" double precision, "leftrightoffset" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_locatebetween"("geometry" "public"."geometry", "frommeasure" double precision, "tomeasure" double precision, "leftrightoffset" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_locatebetween"("geometry" "public"."geometry", "frommeasure" double precision, "tomeasure" double precision, "leftrightoffset" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_locatebetween"("geometry" "public"."geometry", "frommeasure" double precision, "tomeasure" double precision, "leftrightoffset" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_locatebetween"("geometry" "public"."geometry", "frommeasure" double precision, "tomeasure" double precision, "leftrightoffset" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_locatebetweenelevations"("geometry" "public"."geometry", "fromelevation" double precision, "toelevation" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_locatebetweenelevations"("geometry" "public"."geometry", "fromelevation" double precision, "toelevation" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_locatebetweenelevations"("geometry" "public"."geometry", "fromelevation" double precision, "toelevation" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_locatebetweenelevations"("geometry" "public"."geometry", "fromelevation" double precision, "toelevation" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_longestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_longestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_longestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_longestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_m"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_m"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_m"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_m"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makebox2d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makebox2d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_makebox2d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makebox2d"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makeenvelope"(double precision, double precision, double precision, double precision, integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makeenvelope"(double precision, double precision, double precision, double precision, integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_makeenvelope"(double precision, double precision, double precision, double precision, integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makeenvelope"(double precision, double precision, double precision, double precision, integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makeline"("public"."geometry"[]) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makeline"("public"."geometry"[]) TO "anon";


GRANT ALL ON FUNCTION "public"."st_makeline"("public"."geometry"[]) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makeline"("public"."geometry"[]) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makeline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makeline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_makeline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makeline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makepoint"(double precision, double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makepointm"(double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makepointm"(double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_makepointm"(double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makepointm"(double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makepolygon"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makepolygon"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_makepolygon"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makepolygon"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makepolygon"("public"."geometry", "public"."geometry"[]) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makepolygon"("public"."geometry", "public"."geometry"[]) TO "anon";


GRANT ALL ON FUNCTION "public"."st_makepolygon"("public"."geometry", "public"."geometry"[]) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makepolygon"("public"."geometry", "public"."geometry"[]) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makevalid"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makevalid"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_makevalid"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makevalid"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makevalid"("geom" "public"."geometry", "params" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makevalid"("geom" "public"."geometry", "params" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_makevalid"("geom" "public"."geometry", "params" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makevalid"("geom" "public"."geometry", "params" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_maxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_maxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_maxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_maxdistance"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_maximuminscribedcircle"("public"."geometry", OUT "center" "public"."geometry", OUT "nearest" "public"."geometry", OUT "radius" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_maximuminscribedcircle"("public"."geometry", OUT "center" "public"."geometry", OUT "nearest" "public"."geometry", OUT "radius" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_maximuminscribedcircle"("public"."geometry", OUT "center" "public"."geometry", OUT "nearest" "public"."geometry", OUT "radius" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_maximuminscribedcircle"("public"."geometry", OUT "center" "public"."geometry", OUT "nearest" "public"."geometry", OUT "radius" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_memsize"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_memsize"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_memsize"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_memsize"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_minimumboundingcircle"("inputgeom" "public"."geometry", "segs_per_quarter" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_minimumboundingcircle"("inputgeom" "public"."geometry", "segs_per_quarter" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_minimumboundingcircle"("inputgeom" "public"."geometry", "segs_per_quarter" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_minimumboundingcircle"("inputgeom" "public"."geometry", "segs_per_quarter" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_minimumboundingradius"("public"."geometry", OUT "center" "public"."geometry", OUT "radius" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_minimumboundingradius"("public"."geometry", OUT "center" "public"."geometry", OUT "radius" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_minimumboundingradius"("public"."geometry", OUT "center" "public"."geometry", OUT "radius" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_minimumboundingradius"("public"."geometry", OUT "center" "public"."geometry", OUT "radius" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_minimumclearance"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_minimumclearance"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_minimumclearance"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_minimumclearance"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_minimumclearanceline"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_minimumclearanceline"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_minimumclearanceline"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_minimumclearanceline"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mlinefromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mlinefromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_mlinefromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mlinefromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mlinefromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mlinefromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_mlinefromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mlinefromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mlinefromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mlinefromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_mlinefromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mlinefromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mlinefromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mlinefromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_mlinefromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mlinefromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mpointfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mpointfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_mpointfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mpointfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mpointfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mpointfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_mpointfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mpointfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mpointfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mpointfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_mpointfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mpointfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mpointfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mpointfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_mpointfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mpointfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mpolyfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mpolyfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_mpolyfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mpolyfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mpolyfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mpolyfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_mpolyfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mpolyfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mpolyfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mpolyfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_mpolyfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mpolyfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_mpolyfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_mpolyfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_mpolyfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_mpolyfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multi"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multi"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_multi"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multi"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multilinefromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multilinefromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_multilinefromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multilinefromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multilinestringfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multilinestringfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_multilinestringfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multilinestringfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multilinestringfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multilinestringfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_multilinestringfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multilinestringfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multipointfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multipointfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_multipointfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multipointfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multipointfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multipointfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_multipointfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multipointfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multipointfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multipointfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_multipointfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multipointfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multipolyfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multipolyfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_multipolyfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multipolyfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multipolyfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multipolyfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_multipolyfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multipolyfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multipolygonfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multipolygonfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_multipolygonfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multipolygonfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_multipolygonfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_multipolygonfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_multipolygonfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_multipolygonfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_ndims"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_ndims"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_ndims"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_ndims"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_node"("g" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_node"("g" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_node"("g" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_node"("g" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_normalize"("geom" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_normalize"("geom" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_normalize"("geom" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_normalize"("geom" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_npoints"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_npoints"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_npoints"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_npoints"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_nrings"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_nrings"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_nrings"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_nrings"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_numgeometries"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_numgeometries"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_numgeometries"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_numgeometries"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_numinteriorring"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_numinteriorring"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_numinteriorring"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_numinteriorring"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_numinteriorrings"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_numinteriorrings"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_numinteriorrings"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_numinteriorrings"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_numpatches"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_numpatches"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_numpatches"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_numpatches"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_numpoints"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_numpoints"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_numpoints"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_numpoints"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_offsetcurve"("line" "public"."geometry", "distance" double precision, "params" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_offsetcurve"("line" "public"."geometry", "distance" double precision, "params" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_offsetcurve"("line" "public"."geometry", "distance" double precision, "params" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_offsetcurve"("line" "public"."geometry", "distance" double precision, "params" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_orderingequals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_orderingequals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_orderingequals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_orderingequals"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_orientedenvelope"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_orientedenvelope"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_orientedenvelope"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_orientedenvelope"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_overlaps"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_patchn"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_patchn"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_patchn"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_patchn"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_perimeter"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_perimeter"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_perimeter"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_perimeter"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_perimeter"("geog" "public"."geography", "use_spheroid" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_perimeter"("geog" "public"."geography", "use_spheroid" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_perimeter"("geog" "public"."geography", "use_spheroid" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_perimeter"("geog" "public"."geography", "use_spheroid" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_perimeter2d"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_perimeter2d"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_perimeter2d"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_perimeter2d"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_point"(double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_point"(double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_point"(double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_point"(double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_point"(double precision, double precision, "srid" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_point"(double precision, double precision, "srid" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_point"(double precision, double precision, "srid" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_point"(double precision, double precision, "srid" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointfromgeohash"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointfromgeohash"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointfromgeohash"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointfromgeohash"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointinsidecircle"("public"."geometry", double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointinsidecircle"("public"."geometry", double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointinsidecircle"("public"."geometry", double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointinsidecircle"("public"."geometry", double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointm"("xcoordinate" double precision, "ycoordinate" double precision, "mcoordinate" double precision, "srid" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointm"("xcoordinate" double precision, "ycoordinate" double precision, "mcoordinate" double precision, "srid" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointm"("xcoordinate" double precision, "ycoordinate" double precision, "mcoordinate" double precision, "srid" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointm"("xcoordinate" double precision, "ycoordinate" double precision, "mcoordinate" double precision, "srid" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointn"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointn"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointn"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointn"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointonsurface"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointonsurface"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointonsurface"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointonsurface"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_points"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_points"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_points"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_points"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointz"("xcoordinate" double precision, "ycoordinate" double precision, "zcoordinate" double precision, "srid" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointz"("xcoordinate" double precision, "ycoordinate" double precision, "zcoordinate" double precision, "srid" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointz"("xcoordinate" double precision, "ycoordinate" double precision, "zcoordinate" double precision, "srid" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointz"("xcoordinate" double precision, "ycoordinate" double precision, "zcoordinate" double precision, "srid" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_pointzm"("xcoordinate" double precision, "ycoordinate" double precision, "zcoordinate" double precision, "mcoordinate" double precision, "srid" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_pointzm"("xcoordinate" double precision, "ycoordinate" double precision, "zcoordinate" double precision, "mcoordinate" double precision, "srid" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_pointzm"("xcoordinate" double precision, "ycoordinate" double precision, "zcoordinate" double precision, "mcoordinate" double precision, "srid" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_pointzm"("xcoordinate" double precision, "ycoordinate" double precision, "zcoordinate" double precision, "mcoordinate" double precision, "srid" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polyfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polyfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_polyfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polyfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polyfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polyfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_polyfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polyfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polyfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polyfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_polyfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polyfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polyfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polyfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_polyfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polyfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polygon"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polygon"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_polygon"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polygon"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polygonfromtext"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polygonfromtext"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_polygonfromtext"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polygonfromtext"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polygonfromtext"("text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polygonfromtext"("text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_polygonfromtext"("text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polygonfromtext"("text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polygonfromwkb"("bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polygonfromwkb"("bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_polygonfromwkb"("bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polygonfromwkb"("bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polygonfromwkb"("bytea", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polygonfromwkb"("bytea", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_polygonfromwkb"("bytea", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polygonfromwkb"("bytea", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polygonize"("public"."geometry"[]) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polygonize"("public"."geometry"[]) TO "anon";


GRANT ALL ON FUNCTION "public"."st_polygonize"("public"."geometry"[]) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polygonize"("public"."geometry"[]) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_project"("geog" "public"."geography", "distance" double precision, "azimuth" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_project"("geog" "public"."geography", "distance" double precision, "azimuth" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_project"("geog" "public"."geography", "distance" double precision, "azimuth" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_project"("geog" "public"."geography", "distance" double precision, "azimuth" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_quantizecoordinates"("g" "public"."geometry", "prec_x" integer, "prec_y" integer, "prec_z" integer, "prec_m" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_quantizecoordinates"("g" "public"."geometry", "prec_x" integer, "prec_y" integer, "prec_z" integer, "prec_m" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_quantizecoordinates"("g" "public"."geometry", "prec_x" integer, "prec_y" integer, "prec_z" integer, "prec_m" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_quantizecoordinates"("g" "public"."geometry", "prec_x" integer, "prec_y" integer, "prec_z" integer, "prec_m" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_reduceprecision"("geom" "public"."geometry", "gridsize" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_reduceprecision"("geom" "public"."geometry", "gridsize" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_reduceprecision"("geom" "public"."geometry", "gridsize" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_reduceprecision"("geom" "public"."geometry", "gridsize" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_relate"("geom1" "public"."geometry", "geom2" "public"."geometry", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_relatematch"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_relatematch"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_relatematch"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_relatematch"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_removepoint"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_removepoint"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_removepoint"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_removepoint"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_removerepeatedpoints"("geom" "public"."geometry", "tolerance" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_removerepeatedpoints"("geom" "public"."geometry", "tolerance" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_removerepeatedpoints"("geom" "public"."geometry", "tolerance" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_removerepeatedpoints"("geom" "public"."geometry", "tolerance" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_reverse"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_reverse"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_reverse"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_reverse"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision, "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision, "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision, "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision, "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_rotate"("public"."geometry", double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_rotatex"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_rotatex"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_rotatex"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_rotatex"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_rotatey"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_rotatey"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_rotatey"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_rotatey"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_rotatez"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_rotatez"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_rotatez"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_rotatez"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", "public"."geometry", "origin" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", "public"."geometry", "origin" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", "public"."geometry", "origin" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", "public"."geometry", "origin" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_scale"("public"."geometry", double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_scroll"("public"."geometry", "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_scroll"("public"."geometry", "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_scroll"("public"."geometry", "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_scroll"("public"."geometry", "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_segmentize"("geog" "public"."geography", "max_segment_length" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_segmentize"("geog" "public"."geography", "max_segment_length" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_segmentize"("geog" "public"."geography", "max_segment_length" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_segmentize"("geog" "public"."geography", "max_segment_length" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_segmentize"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_segmentize"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_segmentize"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_segmentize"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_seteffectivearea"("public"."geometry", double precision, integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_seteffectivearea"("public"."geometry", double precision, integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_seteffectivearea"("public"."geometry", double precision, integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_seteffectivearea"("public"."geometry", double precision, integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_setpoint"("public"."geometry", integer, "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_setpoint"("public"."geometry", integer, "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_setpoint"("public"."geometry", integer, "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_setpoint"("public"."geometry", integer, "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_setsrid"("geog" "public"."geography", "srid" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_setsrid"("geog" "public"."geography", "srid" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_setsrid"("geog" "public"."geography", "srid" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_setsrid"("geog" "public"."geography", "srid" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_setsrid"("geom" "public"."geometry", "srid" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_setsrid"("geom" "public"."geometry", "srid" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_setsrid"("geom" "public"."geometry", "srid" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_setsrid"("geom" "public"."geometry", "srid" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_sharedpaths"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_sharedpaths"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_sharedpaths"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_sharedpaths"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_shiftlongitude"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_shiftlongitude"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_shiftlongitude"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_shiftlongitude"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_shortestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_shortestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_shortestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_shortestline"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_simplify"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_simplify"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_simplify"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_simplify"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_simplify"("public"."geometry", double precision, boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_simplify"("public"."geometry", double precision, boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_simplify"("public"."geometry", double precision, boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_simplify"("public"."geometry", double precision, boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_simplifypolygonhull"("geom" "public"."geometry", "vertex_fraction" double precision, "is_outer" boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_simplifypolygonhull"("geom" "public"."geometry", "vertex_fraction" double precision, "is_outer" boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_simplifypolygonhull"("geom" "public"."geometry", "vertex_fraction" double precision, "is_outer" boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_simplifypolygonhull"("geom" "public"."geometry", "vertex_fraction" double precision, "is_outer" boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_simplifypreservetopology"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_simplifypreservetopology"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_simplifypreservetopology"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_simplifypreservetopology"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_simplifyvw"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_simplifyvw"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_simplifyvw"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_simplifyvw"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_snap"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_snap"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_snap"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_snap"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision, double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision, double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision, double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("public"."geometry", double precision, double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision, double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision, double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision, double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_snaptogrid"("geom1" "public"."geometry", "geom2" "public"."geometry", double precision, double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_split"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_split"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_split"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_split"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_square"("size" double precision, "cell_i" integer, "cell_j" integer, "origin" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_square"("size" double precision, "cell_i" integer, "cell_j" integer, "origin" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_square"("size" double precision, "cell_i" integer, "cell_j" integer, "origin" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_square"("size" double precision, "cell_i" integer, "cell_j" integer, "origin" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_squaregrid"("size" double precision, "bounds" "public"."geometry", OUT "geom" "public"."geometry", OUT "i" integer, OUT "j" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_squaregrid"("size" double precision, "bounds" "public"."geometry", OUT "geom" "public"."geometry", OUT "i" integer, OUT "j" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_squaregrid"("size" double precision, "bounds" "public"."geometry", OUT "geom" "public"."geometry", OUT "i" integer, OUT "j" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_squaregrid"("size" double precision, "bounds" "public"."geometry", OUT "geom" "public"."geometry", OUT "i" integer, OUT "j" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_srid"("geog" "public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_srid"("geog" "public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_srid"("geog" "public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_srid"("geog" "public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_srid"("geom" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_srid"("geom" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_srid"("geom" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_srid"("geom" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_startpoint"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_startpoint"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_startpoint"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_startpoint"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_subdivide"("geom" "public"."geometry", "maxvertices" integer, "gridsize" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_subdivide"("geom" "public"."geometry", "maxvertices" integer, "gridsize" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_subdivide"("geom" "public"."geometry", "maxvertices" integer, "gridsize" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_subdivide"("geom" "public"."geometry", "maxvertices" integer, "gridsize" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_summary"("public"."geography") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_summary"("public"."geography") TO "anon";


GRANT ALL ON FUNCTION "public"."st_summary"("public"."geography") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_summary"("public"."geography") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_summary"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_summary"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_summary"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_summary"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_swapordinates"("geom" "public"."geometry", "ords" "cstring") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_swapordinates"("geom" "public"."geometry", "ords" "cstring") TO "anon";


GRANT ALL ON FUNCTION "public"."st_swapordinates"("geom" "public"."geometry", "ords" "cstring") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_swapordinates"("geom" "public"."geometry", "ords" "cstring") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_symdifference"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_symdifference"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_symdifference"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_symdifference"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_symmetricdifference"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_symmetricdifference"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_symmetricdifference"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_symmetricdifference"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_tileenvelope"("zoom" integer, "x" integer, "y" integer, "bounds" "public"."geometry", "margin" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_tileenvelope"("zoom" integer, "x" integer, "y" integer, "bounds" "public"."geometry", "margin" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_tileenvelope"("zoom" integer, "x" integer, "y" integer, "bounds" "public"."geometry", "margin" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_tileenvelope"("zoom" integer, "x" integer, "y" integer, "bounds" "public"."geometry", "margin" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_touches"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_touches"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_touches"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_touches"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_transform"("public"."geometry", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_transform"("public"."geometry", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_transform"("public"."geometry", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_transform"("public"."geometry", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "to_proj" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "to_proj" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "to_proj" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "to_proj" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "from_proj" "text", "to_srid" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "from_proj" "text", "to_srid" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "from_proj" "text", "to_srid" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "from_proj" "text", "to_srid" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "from_proj" "text", "to_proj" "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "from_proj" "text", "to_proj" "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "from_proj" "text", "to_proj" "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_transform"("geom" "public"."geometry", "from_proj" "text", "to_proj" "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_translate"("public"."geometry", double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_translate"("public"."geometry", double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_translate"("public"."geometry", double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_translate"("public"."geometry", double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_translate"("public"."geometry", double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_translate"("public"."geometry", double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_translate"("public"."geometry", double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_translate"("public"."geometry", double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_transscale"("public"."geometry", double precision, double precision, double precision, double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_transscale"("public"."geometry", double precision, double precision, double precision, double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_transscale"("public"."geometry", double precision, double precision, double precision, double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_transscale"("public"."geometry", double precision, double precision, double precision, double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_triangulatepolygon"("g1" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_triangulatepolygon"("g1" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_triangulatepolygon"("g1" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_triangulatepolygon"("g1" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_unaryunion"("public"."geometry", "gridsize" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_unaryunion"("public"."geometry", "gridsize" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_unaryunion"("public"."geometry", "gridsize" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_unaryunion"("public"."geometry", "gridsize" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry"[]) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry"[]) TO "anon";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry"[]) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry"[]) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_union"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_union"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_union"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_union"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_union"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_union"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_union"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_union"("geom1" "public"."geometry", "geom2" "public"."geometry", "gridsize" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_voronoilines"("g1" "public"."geometry", "tolerance" double precision, "extend_to" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_voronoilines"("g1" "public"."geometry", "tolerance" double precision, "extend_to" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_voronoilines"("g1" "public"."geometry", "tolerance" double precision, "extend_to" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_voronoilines"("g1" "public"."geometry", "tolerance" double precision, "extend_to" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_voronoipolygons"("g1" "public"."geometry", "tolerance" double precision, "extend_to" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_voronoipolygons"("g1" "public"."geometry", "tolerance" double precision, "extend_to" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_voronoipolygons"("g1" "public"."geometry", "tolerance" double precision, "extend_to" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_voronoipolygons"("g1" "public"."geometry", "tolerance" double precision, "extend_to" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_within"("geom1" "public"."geometry", "geom2" "public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_wkbtosql"("wkb" "bytea") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_wkbtosql"("wkb" "bytea") TO "anon";


GRANT ALL ON FUNCTION "public"."st_wkbtosql"("wkb" "bytea") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_wkbtosql"("wkb" "bytea") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_wkttosql"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_wkttosql"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_wkttosql"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_wkttosql"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_wrapx"("geom" "public"."geometry", "wrap" double precision, "move" double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_wrapx"("geom" "public"."geometry", "wrap" double precision, "move" double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_wrapx"("geom" "public"."geometry", "wrap" double precision, "move" double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_wrapx"("geom" "public"."geometry", "wrap" double precision, "move" double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_x"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_x"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_x"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_x"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_xmax"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_xmax"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."st_xmax"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_xmax"("public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_xmin"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_xmin"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."st_xmin"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_xmin"("public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_y"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_y"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_y"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_y"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_ymax"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_ymax"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."st_ymax"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_ymax"("public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_ymin"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_ymin"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."st_ymin"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_ymin"("public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_z"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_z"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_z"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_z"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_zmax"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_zmax"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."st_zmax"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_zmax"("public"."box3d") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_zmflag"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_zmflag"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_zmflag"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_zmflag"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_zmin"("public"."box3d") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_zmin"("public"."box3d") TO "anon";


GRANT ALL ON FUNCTION "public"."st_zmin"("public"."box3d") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_zmin"("public"."box3d") TO "service_role";


REVOKE ALL ON FUNCTION "public"."stop_my_location"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."stop_my_location"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."stop_my_location"() TO "service_role";


GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."strict_word_similarity"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_commutator_op"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_commutator_op"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_dist_op"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."strict_word_similarity_op"("text", "text") TO "service_role";


REVOKE ALL ON FUNCTION "public"."suggested_friends"("max_results" integer) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."suggested_friends"("max_results" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."suggested_friends"("max_results" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."tg_activity_follow"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."tg_activity_follow"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."tg_activity_offer_redeem"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."tg_activity_offer_redeem"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."tg_activity_offer_save"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."tg_activity_offer_save"() TO "service_role";


GRANT ALL ON FUNCTION "public"."thread_inbox"() TO "anon";


GRANT ALL ON FUNCTION "public"."thread_inbox"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."thread_inbox"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."town_hall_bump_replies"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."town_hall_bump_replies"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."town_hall_bump_reply_upvotes"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."town_hall_bump_reply_upvotes"() TO "service_role";


REVOKE ALL ON FUNCTION "public"."town_hall_bump_upvotes"() FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."town_hall_bump_upvotes"() TO "service_role";


GRANT ALL ON FUNCTION "public"."unlockrows"("text") TO "postgres";


GRANT ALL ON FUNCTION "public"."unlockrows"("text") TO "anon";


GRANT ALL ON FUNCTION "public"."unlockrows"("text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."unlockrows"("text") TO "service_role";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"(character varying, character varying, integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"(character varying, character varying, integer) TO "anon";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"(character varying, character varying, integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"(character varying, character varying, integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"(character varying, character varying, character varying, integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"(character varying, character varying, character varying, integer) TO "anon";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"(character varying, character varying, character varying, integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"(character varying, character varying, character varying, integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"("catalogn_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid_in" integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"("catalogn_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid_in" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"("catalogn_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid_in" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."updategeometrysrid"("catalogn_name" character varying, "schema_name" character varying, "table_name" character varying, "column_name" character varying, "new_srid_in" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."upsert_place_venues"("places" "jsonb") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."upsert_place_venues"("places" "jsonb") TO "service_role";


REVOKE ALL ON FUNCTION "public"."upsert_venue_photos"("payload" "jsonb") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."upsert_venue_photos"("payload" "jsonb") TO "service_role";


GRANT ALL ON FUNCTION "public"."venue_audience_stats"("p_venue" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."venue_audience_stats"("p_venue" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."venue_audience_stats"("p_venue" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."venue_birthday_stats"("p_venue" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."venue_birthday_stats"("p_venue" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."venue_birthday_stats"("p_venue" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."venue_link_hosts"("target_venue_id" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."venue_link_hosts"("target_venue_id" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."venue_offer_engagement"("p_venue" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."venue_offer_engagement"("p_venue" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."venue_offer_engagement"("p_venue" "uuid") TO "service_role";


REVOKE ALL ON FUNCTION "public"."venue_review_histogram"("venue_id_param" "uuid") FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."venue_review_histogram"("venue_id_param" "uuid") TO "anon";


GRANT ALL ON FUNCTION "public"."venue_review_histogram"("venue_id_param" "uuid") TO "authenticated";


GRANT ALL ON FUNCTION "public"."venue_review_histogram"("venue_id_param" "uuid") TO "service_role";


GRANT ALL ON FUNCTION "public"."venue_reviews_list"("venue_id_param" "uuid", "max_results" integer, "page_offset" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."venue_reviews_list"("venue_id_param" "uuid", "max_results" integer, "page_offset" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."venue_reviews_list"("venue_id_param" "uuid", "max_results" integer, "page_offset" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."venue_reviews_refresh_rollup"() TO "anon";


GRANT ALL ON FUNCTION "public"."venue_reviews_refresh_rollup"() TO "authenticated";


GRANT ALL ON FUNCTION "public"."venue_reviews_refresh_rollup"() TO "service_role";


GRANT ALL ON FUNCTION "public"."venues_in_category_near"("filter_category" "text", "origin_lat" double precision, "origin_lng" double precision, "page_size" integer, "page_offset" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."venues_in_category_near"("filter_category" "text", "origin_lat" double precision, "origin_lng" double precision, "page_size" integer, "page_offset" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."venues_in_category_near"("filter_category" "text", "origin_lat" double precision, "origin_lng" double precision, "page_size" integer, "page_offset" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."venues_near"("origin_lat" double precision, "origin_lng" double precision, "max_results" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."venues_near"("origin_lat" double precision, "origin_lng" double precision, "max_results" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."venues_near"("origin_lat" double precision, "origin_lng" double precision, "max_results" integer) TO "service_role";


REVOKE ALL ON FUNCTION "public"."venues_search_by_name"("q" "text", "origin_lat" double precision, "origin_lng" double precision, "max_results" integer) FROM PUBLIC, "anon", "authenticated";


GRANT ALL ON FUNCTION "public"."venues_search_by_name"("q" "text", "origin_lat" double precision, "origin_lng" double precision, "max_results" integer) TO "anon";


GRANT ALL ON FUNCTION "public"."venues_search_by_name"("q" "text", "origin_lat" double precision, "origin_lng" double precision, "max_results" integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."venues_search_by_name"("q" "text", "origin_lat" double precision, "origin_lng" double precision, "max_results" integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."word_similarity"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."word_similarity_commutator_op"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."word_similarity_dist_commutator_op"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."word_similarity_dist_op"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."word_similarity_op"("text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_3dextent"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_3dextent"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_3dextent"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_3dextent"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement", boolean) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement", boolean) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement", boolean) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement", boolean) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement", boolean, "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement", boolean, "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement", boolean, "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asflatgeobuf"("anyelement", boolean, "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgeobuf"("anyelement") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgeobuf"("anyelement") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgeobuf"("anyelement") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgeobuf"("anyelement") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asgeobuf"("anyelement", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asgeobuf"("anyelement", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asgeobuf"("anyelement", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asgeobuf"("anyelement", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer) TO "anon";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer, "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer, "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer, "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer, "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer, "text", "text") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer, "text", "text") TO "anon";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer, "text", "text") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_asmvt"("anyelement", "text", integer, "text", "text") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_clusterintersecting"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_clusterintersecting"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_clusterintersecting"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_clusterintersecting"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_clusterwithin"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_clusterwithin"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_clusterwithin"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_clusterwithin"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON FUNCTION "public"."st_collect"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_collect"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_collect"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_collect"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_extent"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_extent"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_extent"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_extent"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_makeline"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_makeline"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_makeline"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_makeline"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_memcollect"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_memcollect"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_memcollect"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_memcollect"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_memunion"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_memunion"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_memunion"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_memunion"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_polygonize"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_polygonize"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_polygonize"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_polygonize"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry") TO "postgres";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry") TO "anon";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry") TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry") TO "service_role";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry", double precision) TO "postgres";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry", double precision) TO "anon";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry", double precision) TO "authenticated";


GRANT ALL ON FUNCTION "public"."st_union"("public"."geometry", double precision) TO "service_role";


GRANT ALL ON TABLE "public"."admin_audit_log" TO "anon";


GRANT ALL ON TABLE "public"."admin_audit_log" TO "authenticated";


GRANT ALL ON TABLE "public"."admin_audit_log" TO "service_role";


GRANT ALL ON TABLE "public"."admin_users" TO "anon";


GRANT ALL ON TABLE "public"."admin_users" TO "authenticated";


GRANT ALL ON TABLE "public"."admin_users" TO "service_role";


GRANT ALL ON TABLE "public"."automation_journeys" TO "anon";


GRANT ALL ON TABLE "public"."automation_journeys" TO "authenticated";


GRANT ALL ON TABLE "public"."automation_journeys" TO "service_role";


GRANT ALL ON TABLE "public"."awin_deals" TO "anon";


GRANT ALL ON TABLE "public"."awin_deals" TO "authenticated";


GRANT ALL ON TABLE "public"."awin_deals" TO "service_role";


GRANT ALL ON TABLE "public"."billing_customers" TO "anon";


GRANT ALL ON TABLE "public"."billing_customers" TO "authenticated";


GRANT ALL ON TABLE "public"."billing_customers" TO "service_role";


GRANT ALL ON TABLE "public"."billing_transactions" TO "anon";


GRANT ALL ON TABLE "public"."billing_transactions" TO "authenticated";


GRANT ALL ON TABLE "public"."billing_transactions" TO "service_role";


GRANT ALL ON TABLE "public"."birthday_deliveries" TO "anon";


GRANT ALL ON TABLE "public"."birthday_deliveries" TO "authenticated";


GRANT ALL ON TABLE "public"."birthday_deliveries" TO "service_role";


GRANT ALL ON TABLE "public"."chat_messages" TO "anon";


GRANT ALL ON TABLE "public"."chat_messages" TO "authenticated";


GRANT ALL ON TABLE "public"."chat_messages" TO "service_role";


GRANT ALL ON TABLE "public"."chat_participants" TO "anon";


GRANT ALL ON TABLE "public"."chat_participants" TO "authenticated";


GRANT ALL ON TABLE "public"."chat_participants" TO "service_role";


GRANT ALL ON TABLE "public"."chat_poll_votes" TO "anon";


GRANT ALL ON TABLE "public"."chat_poll_votes" TO "authenticated";


GRANT ALL ON TABLE "public"."chat_poll_votes" TO "service_role";


GRANT ALL ON TABLE "public"."chat_polls" TO "anon";


GRANT ALL ON TABLE "public"."chat_polls" TO "authenticated";


GRANT ALL ON TABLE "public"."chat_polls" TO "service_role";


GRANT ALL ON TABLE "public"."cj_advertisers" TO "anon";


GRANT ALL ON TABLE "public"."cj_advertisers" TO "authenticated";


GRANT ALL ON TABLE "public"."cj_advertisers" TO "service_role";


GRANT ALL ON TABLE "public"."cj_deals" TO "anon";


GRANT ALL ON TABLE "public"."cj_deals" TO "authenticated";


GRANT ALL ON TABLE "public"."cj_deals" TO "service_role";


GRANT ALL ON TABLE "public"."event_interest" TO "anon";


GRANT ALL ON TABLE "public"."event_interest" TO "authenticated";


GRANT ALL ON TABLE "public"."event_interest" TO "service_role";


GRANT ALL ON TABLE "public"."events" TO "anon";


GRANT ALL ON TABLE "public"."events" TO "authenticated";


GRANT ALL ON TABLE "public"."events" TO "service_role";


GRANT ALL ON TABLE "public"."feature_flags" TO "anon";


GRANT ALL ON TABLE "public"."feature_flags" TO "authenticated";


GRANT ALL ON TABLE "public"."feature_flags" TO "service_role";


GRANT ALL ON TABLE "public"."follows" TO "anon";


GRANT ALL ON TABLE "public"."follows" TO "authenticated";


GRANT ALL ON TABLE "public"."follows" TO "service_role";


GRANT ALL ON TABLE "public"."friend_presence" TO "anon";


GRANT ALL ON TABLE "public"."friend_presence" TO "authenticated";


GRANT ALL ON TABLE "public"."friend_presence" TO "service_role";


GRANT ALL ON TABLE "public"."friendships" TO "anon";


GRANT ALL ON TABLE "public"."friendships" TO "authenticated";


GRANT ALL ON TABLE "public"."friendships" TO "service_role";


GRANT ALL ON TABLE "public"."market_listings" TO "anon";


GRANT ALL ON TABLE "public"."market_listings" TO "authenticated";


GRANT ALL ON TABLE "public"."market_listings" TO "service_role";


GRANT ALL ON TABLE "public"."meetup_locations" TO "anon";


GRANT ALL ON TABLE "public"."meetup_locations" TO "authenticated";


GRANT ALL ON TABLE "public"."meetup_locations" TO "service_role";


GRANT ALL ON TABLE "public"."meetup_options" TO "anon";


GRANT ALL ON TABLE "public"."meetup_options" TO "authenticated";


GRANT ALL ON TABLE "public"."meetup_options" TO "service_role";


GRANT ALL ON TABLE "public"."meetup_votes" TO "anon";


GRANT ALL ON TABLE "public"."meetup_votes" TO "authenticated";


GRANT ALL ON TABLE "public"."meetup_votes" TO "service_role";


GRANT ALL ON TABLE "public"."meetups" TO "anon";


GRANT ALL ON TABLE "public"."meetups" TO "authenticated";


GRANT ALL ON TABLE "public"."meetups" TO "service_role";


GRANT ALL ON TABLE "public"."moderation_queue" TO "anon";


GRANT ALL ON TABLE "public"."moderation_queue" TO "authenticated";


GRANT ALL ON TABLE "public"."moderation_queue" TO "service_role";


GRANT ALL ON TABLE "public"."notifications" TO "anon";


GRANT ALL ON TABLE "public"."notifications" TO "authenticated";


GRANT ALL ON TABLE "public"."notifications" TO "service_role";


GRANT ALL ON TABLE "public"."offer_redemptions" TO "anon";


GRANT ALL ON TABLE "public"."offer_redemptions" TO "authenticated";


GRANT ALL ON TABLE "public"."offer_redemptions" TO "service_role";


GRANT ALL ON TABLE "public"."offer_saves" TO "anon";


GRANT ALL ON TABLE "public"."offer_saves" TO "authenticated";


GRANT ALL ON TABLE "public"."offer_saves" TO "service_role";


GRANT ALL ON TABLE "public"."offers" TO "anon";


GRANT ALL ON TABLE "public"."offers" TO "authenticated";


GRANT ALL ON TABLE "public"."offers" TO "service_role";


GRANT ALL ON TABLE "public"."orders" TO "anon";


GRANT ALL ON TABLE "public"."orders" TO "authenticated";


GRANT ALL ON TABLE "public"."orders" TO "service_role";


GRANT ALL ON TABLE "public"."places_fetch_quota" TO "anon";


GRANT ALL ON TABLE "public"."places_fetch_quota" TO "authenticated";


GRANT ALL ON TABLE "public"."places_fetch_quota" TO "service_role";


GRANT ALL ON TABLE "public"."plan_members" TO "anon";


GRANT ALL ON TABLE "public"."plan_members" TO "authenticated";


GRANT ALL ON TABLE "public"."plan_members" TO "service_role";


GRANT ALL ON TABLE "public"."plan_venues" TO "anon";


GRANT ALL ON TABLE "public"."plan_venues" TO "authenticated";


GRANT ALL ON TABLE "public"."plan_venues" TO "service_role";


GRANT ALL ON TABLE "public"."plans" TO "anon";


GRANT ALL ON TABLE "public"."plans" TO "authenticated";


GRANT ALL ON TABLE "public"."plans" TO "service_role";


GRANT ALL ON TABLE "public"."posts" TO "anon";


GRANT ALL ON TABLE "public"."posts" TO "authenticated";


GRANT ALL ON TABLE "public"."posts" TO "service_role";


GRANT ALL ON TABLE "public"."posts_comments" TO "anon";


GRANT ALL ON TABLE "public"."posts_comments" TO "authenticated";


GRANT ALL ON TABLE "public"."posts_comments" TO "service_role";


GRANT ALL ON TABLE "public"."posts_likes" TO "anon";


GRANT ALL ON TABLE "public"."posts_likes" TO "authenticated";


GRANT ALL ON TABLE "public"."posts_likes" TO "service_role";


GRANT ALL ON TABLE "public"."presence_alerts" TO "anon";


GRANT ALL ON TABLE "public"."presence_alerts" TO "authenticated";


GRANT ALL ON TABLE "public"."presence_alerts" TO "service_role";


GRANT ALL ON TABLE "public"."profile_post_comments" TO "anon";


GRANT ALL ON TABLE "public"."profile_post_comments" TO "authenticated";


GRANT ALL ON TABLE "public"."profile_post_comments" TO "service_role";


GRANT ALL ON TABLE "public"."profile_post_likes" TO "anon";


GRANT ALL ON TABLE "public"."profile_post_likes" TO "authenticated";


GRANT ALL ON TABLE "public"."profile_post_likes" TO "service_role";


GRANT ALL ON TABLE "public"."profile_posts" TO "anon";


GRANT ALL ON TABLE "public"."profile_posts" TO "authenticated";


GRANT ALL ON TABLE "public"."profile_posts" TO "service_role";


GRANT ALL ON TABLE "public"."profiles" TO "anon";


GRANT ALL ON TABLE "public"."profiles" TO "authenticated";


GRANT ALL ON TABLE "public"."profiles" TO "service_role";


GRANT ALL ON TABLE "public"."push_credit_ledger" TO "anon";


GRANT ALL ON TABLE "public"."push_credit_ledger" TO "authenticated";


GRANT ALL ON TABLE "public"."push_credit_ledger" TO "service_role";


GRANT ALL ON TABLE "public"."push_subscriptions" TO "anon";


GRANT ALL ON TABLE "public"."push_subscriptions" TO "authenticated";


GRANT ALL ON TABLE "public"."push_subscriptions" TO "service_role";


GRANT ALL ON TABLE "public"."saved_transit_stops" TO "anon";


GRANT ALL ON TABLE "public"."saved_transit_stops" TO "authenticated";


GRANT ALL ON TABLE "public"."saved_transit_stops" TO "service_role";


GRANT ALL ON TABLE "public"."shop_orders" TO "anon";


GRANT ALL ON TABLE "public"."shop_orders" TO "authenticated";


GRANT ALL ON TABLE "public"."shop_orders" TO "service_role";


GRANT ALL ON TABLE "public"."shop_products" TO "anon";


GRANT ALL ON TABLE "public"."shop_products" TO "authenticated";


GRANT ALL ON TABLE "public"."shop_products" TO "service_role";


GRANT ALL ON TABLE "public"."town_hall_replies" TO "anon";


GRANT ALL ON TABLE "public"."town_hall_replies" TO "authenticated";


GRANT ALL ON TABLE "public"."town_hall_replies" TO "service_role";


GRANT ALL ON TABLE "public"."town_hall_reply_votes" TO "anon";


GRANT ALL ON TABLE "public"."town_hall_reply_votes" TO "authenticated";


GRANT ALL ON TABLE "public"."town_hall_reply_votes" TO "service_role";


GRANT ALL ON TABLE "public"."town_hall_topics" TO "anon";


GRANT ALL ON TABLE "public"."town_hall_topics" TO "authenticated";


GRANT ALL ON TABLE "public"."town_hall_topics" TO "service_role";


GRANT ALL ON TABLE "public"."town_hall_votes" TO "anon";


GRANT ALL ON TABLE "public"."town_hall_votes" TO "authenticated";


GRANT ALL ON TABLE "public"."town_hall_votes" TO "service_role";


GRANT ALL ON TABLE "public"."trip_stops" TO "anon";


GRANT ALL ON TABLE "public"."trip_stops" TO "authenticated";


GRANT ALL ON TABLE "public"."trip_stops" TO "service_role";


GRANT ALL ON TABLE "public"."trips" TO "anon";


GRANT ALL ON TABLE "public"."trips" TO "authenticated";


GRANT ALL ON TABLE "public"."trips" TO "service_role";


GRANT ALL ON TABLE "public"."user_blocks" TO "anon";


GRANT ALL ON TABLE "public"."user_blocks" TO "authenticated";


GRANT ALL ON TABLE "public"."user_blocks" TO "service_role";


GRANT ALL ON TABLE "public"."user_private" TO "anon";


GRANT ALL ON TABLE "public"."user_private" TO "authenticated";


GRANT ALL ON TABLE "public"."user_private" TO "service_role";


GRANT ALL ON TABLE "public"."venue_activity" TO "anon";


GRANT ALL ON TABLE "public"."venue_activity" TO "authenticated";


GRANT ALL ON TABLE "public"."venue_activity" TO "service_role";


GRANT ALL ON TABLE "public"."venue_birthday_offer" TO "anon";


GRANT ALL ON TABLE "public"."venue_birthday_offer" TO "authenticated";


GRANT ALL ON TABLE "public"."venue_birthday_offer" TO "service_role";


GRANT ALL ON TABLE "public"."venue_marketing_prefs" TO "anon";


GRANT ALL ON TABLE "public"."venue_marketing_prefs" TO "authenticated";


GRANT ALL ON TABLE "public"."venue_marketing_prefs" TO "service_role";


GRANT ALL ON TABLE "public"."venue_payment_accounts" TO "anon";


GRANT ALL ON TABLE "public"."venue_payment_accounts" TO "authenticated";


GRANT ALL ON TABLE "public"."venue_payment_accounts" TO "service_role";


GRANT ALL ON TABLE "public"."venue_photos" TO "anon";


GRANT ALL ON TABLE "public"."venue_photos" TO "authenticated";


GRANT ALL ON TABLE "public"."venue_photos" TO "service_role";


GRANT ALL ON TABLE "public"."venue_products" TO "anon";


GRANT ALL ON TABLE "public"."venue_products" TO "authenticated";


GRANT ALL ON TABLE "public"."venue_products" TO "service_role";


GRANT ALL ON TABLE "public"."venue_reviews" TO "anon";


GRANT ALL ON TABLE "public"."venue_reviews" TO "authenticated";


GRANT ALL ON TABLE "public"."venue_reviews" TO "service_role";


GRANT ALL ON TABLE "public"."venue_views" TO "anon";


GRANT ALL ON TABLE "public"."venue_views" TO "authenticated";


GRANT ALL ON TABLE "public"."venue_views" TO "service_role";


GRANT ALL ON TABLE "public"."venues" TO "anon";


GRANT ALL ON TABLE "public"."venues" TO "authenticated";


GRANT ALL ON TABLE "public"."venues" TO "service_role";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";


ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";


--
-- Dumped schema changes for auth and storage
--

CREATE OR REPLACE TRIGGER "trg_auth_user_created" AFTER INSERT ON "auth"."users" FOR EACH ROW EXECUTE FUNCTION "public"."handle_new_auth_user"();


CREATE POLICY "chat_media_owner_delete" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'chat-media'::"text") AND ("owner" = "auth"."uid"())));


CREATE POLICY "chat_media_participant_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'chat-media'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."chat_participants" "p"
  WHERE ((("p"."thread_id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("p"."profile_id" = "auth"."uid"()))))));


CREATE POLICY "chat_media_participant_read" ON "storage"."objects" FOR SELECT TO "authenticated" USING ((("bucket_id" = 'chat-media'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."chat_participants" "p"
  WHERE ((("p"."thread_id")::"text" = ("storage"."foldername"("objects"."name"))[1]) AND ("p"."profile_id" = "auth"."uid"()))))));


CREATE POLICY "profile_media_owner_delete" ON "storage"."objects" FOR DELETE TO "authenticated" USING ((("bucket_id" = 'profile-media'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));


CREATE POLICY "profile_media_owner_insert" ON "storage"."objects" FOR INSERT TO "authenticated" WITH CHECK ((("bucket_id" = 'profile-media'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));


CREATE POLICY "profile_media_owner_update" ON "storage"."objects" FOR UPDATE TO "authenticated" USING ((("bucket_id" = 'profile-media'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text"))) WITH CHECK ((("bucket_id" = 'profile-media'::"text") AND (("storage"."foldername"("name"))[1] = ("auth"."uid"())::"text")));

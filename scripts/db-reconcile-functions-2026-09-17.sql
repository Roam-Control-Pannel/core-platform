-- ============================================================================
-- Live parity reconcile — 2026-09-17 (see docs/db-release-runbook.md, "Live parity audit").
--
-- The checksum audit of the live project against the repo found fifteen function bodies whose
-- CODE is identical to the repo but whose TEXT differs (line breaks, column aliases, exception
-- wording). Behaviour is unchanged either way. Re-creating them from the repo's own definitions
-- (generated with pg_get_functiondef from a database with every migration applied) makes the
-- live text byte-identical, so the next checksum audit is a zero-diff instead of a fifteen-line
-- explanation. `create or replace` keeps every grant; every signature is unchanged.
--
-- Idempotent. Safe to re-run. Run as the SQL editor's default role ("Run without RLS" if asked).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.cast_poll_vote(p_message uuid, p_option text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.gen_unique_topic_slug(p_title text, p_locality text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.gen_unique_venue_slug(p_name text, p_locality text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.notify_event_cancelled()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.notify_event_interest()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.notify_offer_followers()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.notify_plan_member()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.notify_venue_claim()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.notify_venue_review()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.poll_results(p_message uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.posts_feed_near(lat double precision, lng double precision, radius_m double precision DEFAULT 25000, max_results integer DEFAULT 50)
 RETURNS TABLE(id uuid, kind post_kind, title text, body text, media jsonb, published_at timestamp with time zone, venue_id uuid, venue_name text, venue_locality text, distance_m double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.send_venue_notification(p_venue uuid, p_text text, p_recipient uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.thread_inbox()
 RETURNS TABLE(thread_id uuid, last_kind text, last_body text, last_sender_id uuid, last_created_at timestamp with time zone, unread_count integer)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
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
$function$
;

CREATE OR REPLACE FUNCTION public.upsert_place_venues(places jsonb)
 RETURNS TABLE(out_id uuid, out_source_ref text, out_was_claimed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      source, source_ref, name, geo, category, categories, rating, address, locality, country_code,
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
      nullif(upper(trim(elem->>'country_code')), ''),
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
          -- Never blank a locality/country we already know: a refresh missing address components
          -- keeps the existing value rather than regressing to NULL.
          locality           = coalesce(excluded.locality, venues.locality),
          country_code       = coalesce(excluded.country_code, venues.country_code),
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
$function$
;

CREATE OR REPLACE FUNCTION public.venue_offer_engagement(p_venue uuid)
 RETURNS TABLE(offer_type text, offers bigint, saves bigint, redemptions bigint)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;


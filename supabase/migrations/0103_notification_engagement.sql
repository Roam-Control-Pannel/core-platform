-- ============================================================================
-- Roam — 0103_notification_engagement.sql
-- Tier-2 notification coverage: engagement pings (upvotes / likes) + opt-in
-- offer-to-followers. Upvotes/likes are high-frequency, so they COALESCE — one
-- self-updating "X and N others upvoted your topic" row per item, never a flood.
--
-- Adds a reusable `notifications.entity_id` + a partial index so any type can
-- coalesce by (recipient, type, entity) among unread rows.
--
-- New in-app types:
--   topic_upvote / reply_upvote — upvote on your Town Hall topic / reply  (coalesced)
--   post_like                   — like on your wall post                  (coalesced)
--   venue_offer                 — a venue you follow posted an offer      (opt-in fan-out)
--
-- Additive: one nullable column on `notifications`, one boolean on `offers`,
-- new functions + triggers. Nothing existing is altered.
-- ============================================================================

alter table notifications add column if not exists entity_id uuid;
-- The coalesce lookup: newest unread notification for (recipient, type, entity).
create index if not exists idx_notifications_coalesce
  on notifications (recipient_id, type, entity_id)
  where read_at is null;

-- ── shared coalescing helper ────────────────────────────────────────────────────────────────
-- Bumps an existing unread notification for (recipient, type, entity) — incrementing its count
-- and refreshing its text/timestamp — or inserts the first one. Called from the engagement
-- triggers (SECURITY DEFINER, invoked within other definer functions).
create or replace function bump_engagement_notification(
  p_recipient uuid, p_type text, p_entity uuid, p_actor text, p_verb text, p_subject text, p_href text
) returns void language plpgsql security definer set search_path = public as $$
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

-- ── Town Hall topic upvote → the topic's author ─────────────────────────────────────────────
create or replace function notify_topic_upvote()
returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists trg_notify_topic_upvote on town_hall_votes;
create trigger trg_notify_topic_upvote after insert on town_hall_votes
  for each row execute function notify_topic_upvote();

-- ── Town Hall reply upvote → the reply's author ─────────────────────────────────────────────
create or replace function notify_reply_upvote()
returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists trg_notify_reply_upvote on town_hall_reply_votes;
create trigger trg_notify_reply_upvote after insert on town_hall_reply_votes
  for each row execute function notify_reply_upvote();

-- ── Wall-post like → the post's author ──────────────────────────────────────────────────────
create or replace function notify_post_like()
returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists trg_notify_post_like on profile_post_likes;
create trigger trg_notify_post_like after insert on profile_post_likes
  for each row execute function notify_post_like();

-- ── Opt-in offer → followers ────────────────────────────────────────────────────────────────
-- The owner ticks "notify my followers" on the offer composer; the API writes notify_followers,
-- and this trigger fans the offer out to everyone following the venue. Off by default so a venue
-- can post routine offers without pinging followers.
alter table offers add column if not exists notify_followers boolean not null default false;

create or replace function notify_offer_followers()
returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists trg_notify_offer_followers on offers;
create trigger trg_notify_offer_followers after insert on offers
  for each row execute function notify_offer_followers();

-- ── grant hygiene (mirrors 0076): triggers invoke these regardless of role grants ────────────
revoke all on function bump_engagement_notification(uuid, text, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function notify_topic_upvote()    from public, anon, authenticated;
revoke all on function notify_reply_upvote()    from public, anon, authenticated;
revoke all on function notify_post_like()       from public, anon, authenticated;
revoke all on function notify_offer_followers() from public, anon, authenticated;

-- ============================================================================
-- Roam — 0032_notifications_triggers.sql
-- Light up the notifications table (0003): it has a recipient-private RLS posture
-- (select/update own; NO insert policy), so notifications are PRODUCED by
-- SECURITY DEFINER triggers — a user can't write a row addressed to someone else
-- under their own client. The web app reads them via the new notifications router.
--
-- Producers wired here (the highest-signal, low-noise events):
--   - someone COMMENTS on your profile-wall post          → 'wall_comment'
--   - someone REPLIES to your Town Hall topic              → 'townhall_reply'
--   - someone FOLLOWS a venue you own                      → 'venue_follow'
-- Each trigger denormalises a ready-to-render { text, href, actorId } payload, so
-- the reader stays dumb. Self-actions don't notify (no "you replied to yourself").
--
-- Re-appliable: functions are create-or-replace; triggers are dropped first.
-- ============================================================================

-- A wall comment → notify the post's author.
create or replace function notify_wall_comment()
returns trigger language plpgsql security definer set search_path = public as $$
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

drop trigger if exists trg_notify_wall_comment on profile_post_comments;
create trigger trg_notify_wall_comment after insert on profile_post_comments
  for each row execute function notify_wall_comment();

-- A Town Hall reply → notify the topic's author.
create or replace function notify_townhall_reply()
returns trigger language plpgsql security definer set search_path = public as $$
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

drop trigger if exists trg_notify_townhall_reply on town_hall_replies;
create trigger trg_notify_townhall_reply after insert on town_hall_replies
  for each row execute function notify_townhall_reply();

-- A new follow on a venue → notify the venue's owner.
create or replace function notify_venue_follow()
returns trigger language plpgsql security definer set search_path = public as $$
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

drop trigger if exists trg_notify_venue_follow on follows;
create trigger trg_notify_venue_follow after insert on follows
  for each row execute function notify_venue_follow();

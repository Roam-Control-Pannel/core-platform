-- ============================================================================
-- Roam — 0033_friend_notifications.sql
-- Extend the notification producers (0032) to friendships:
--   - a new friend REQUEST            → notify the addressee ('friend_request')
--   - a request is ACCEPTED           → notify the original requester ('friend_accept')
-- SECURITY DEFINER (a user can't insert a notification addressed to someone else).
-- Re-appliable: create-or-replace fn; trigger dropped first.
-- ============================================================================

create or replace function notify_friend_event()
returns trigger language plpgsql security definer set search_path = public as $$
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

drop trigger if exists trg_notify_friend_event on friendships;
create trigger trg_notify_friend_event after insert or update on friendships
  for each row execute function notify_friend_event();

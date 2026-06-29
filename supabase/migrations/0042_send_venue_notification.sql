-- Migration 0042 — let a business send a notification to its followers.
--
-- notifications (0003) is recipient-private: recipients read/clear their own rows, and there is
-- NO insert policy — producers are SECURITY DEFINER functions/triggers (0032/0033). This adds the
-- producer for a business → follower message: a venue OWNER can notify ALL their followers
-- collectively, or ONE specific follower individually.
--
-- Gate: the caller must own the venue. Individual sends only land if the target actually follows
-- the venue (no notifying arbitrary users). Payload matches the denormalised { text, href }
-- render-model the notification center already uses; type is 'venue_message'.
--
-- Idempotent: create-or-replace.

create or replace function public.send_venue_notification(
  p_venue     uuid,
  p_text      text,
  p_recipient uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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

revoke all on function public.send_venue_notification(uuid, text, uuid) from public;
grant execute on function public.send_venue_notification(uuid, text, uuid) to authenticated;

-- ============================================================================
-- Roam — 0102_notification_coverage.sql
-- Closes the notification-centre coverage gaps found in the audit. Adds the
-- discrete, high-value events that previously happened silently, using the exact
-- SECURITY DEFINER trigger pattern established in 0032/0033 (notifications has no
-- INSERT policy, so definer functions are the only writers). English text in the
-- payload, same as the existing triggers.
--
-- New in-app notification types added here:
--   plan_invite      — you were added to a plan            (trigger: plan_members INSERT)
--   event_interest   — someone's interested in your event  (trigger: event_interest INSERT)
--   event_cancelled  — an event you liked was cancelled    (trigger: events UPDATE→cancelled)
--   venue_review     — a new review on your venue          (trigger: venue_reviews INSERT)
--   claim_approved / claim_rejected — your claim outcome    (trigger: venue_claims UPDATE)
--
-- (order_received for the venue owner, and an in-app friends_nearby row, are added
-- on the code side where those flows already run — see server.ts / presence.ts.)
--
-- Additive: new functions + triggers only, nothing existing is altered. Grants are
-- revoked on the trigger functions (hygiene, mirroring 0076) — triggers invoke them
-- regardless of role grants.
-- ============================================================================

-- ── plan_invite: added to a plan → notify the added member (not the owner) ──────────────────
create or replace function notify_plan_member()
returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists trg_notify_plan_member on plan_members;
create trigger trg_notify_plan_member after insert on plan_members
  for each row execute function notify_plan_member();

-- ── event_interest: someone marks interest → notify the event author ────────────────────────
create or replace function notify_event_interest()
returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists trg_notify_event_interest on event_interest;
create trigger trg_notify_event_interest after insert on event_interest
  for each row execute function notify_event_interest();

-- ── event_cancelled: event flipped to cancelled → notify everyone interested (bar the author) ─
create or replace function notify_event_cancelled()
returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists trg_notify_event_cancelled on events;
create trigger trg_notify_event_cancelled after update on events
  for each row execute function notify_event_cancelled();

-- ── venue_review: a new review → notify the venue owner ─────────────────────────────────────
create or replace function notify_venue_review()
returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists trg_notify_venue_review on venue_reviews;
create trigger trg_notify_venue_review after insert on venue_reviews
  for each row execute function notify_venue_review();

-- ── venue claim decision: approved / rejected → notify the claimant ─────────────────────────
create or replace function notify_venue_claim()
returns trigger language plpgsql security definer set search_path = public as $$
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
drop trigger if exists trg_notify_venue_claim on venue_claims;
create trigger trg_notify_venue_claim after update on venue_claims
  for each row execute function notify_venue_claim();

-- ── grant hygiene: triggers invoke these regardless; deny direct EXECUTE (mirrors 0076) ──────
revoke all on function notify_plan_member()    from public, anon, authenticated;
revoke all on function notify_event_interest() from public, anon, authenticated;
revoke all on function notify_event_cancelled() from public, anon, authenticated;
revoke all on function notify_venue_review()   from public, anon, authenticated;
revoke all on function notify_venue_claim()    from public, anon, authenticated;

-- ============================================================================
-- 0131_column_scope.sql
--
-- Column-scopes the two whole-row self-UPDATE policies flagged in the Sep 2026 review
-- (#6 venues, #7 profiles). RLS row-scopes these tables but not their columns, so from a
-- browser with the public key an owner/user can PATCH ANY column via PostgREST. BEFORE
-- UPDATE triggers constrain the columns for the direct client roles (authenticated/anon);
-- service_role and SECURITY DEFINER functions (Places ingestion, claim approval,
-- moderation, the digest unsubscribe token route) run as another role/owner and are
-- deliberately skipped so their legitimate writes keep working.
-- ============================================================================

-- ── #6 venues: an owner may edit only presentational fields ──────────────────────────
-- The app updates exactly `description` + `links` (updateVenueDetails) and `opening_times`
-- (updateVenueHours) as the authenticated owner — verified as the only authenticated-client
-- writes to venues. Everything else is Places-sourced or server-managed: subscription_tier
-- (a self-upgrade to a paid tier — the standout), rating/rating_count (reputation),
-- geo/locality/place_id/category (discovery placement), name/address, owner_id/status.
-- Allowlist by diffing the row minus the editable keys; raise (not silently drop) on any
-- other change so a future editable field is a loud reminder to extend the list. The jsonb
-- text diff also side-steps the PostGIS trap that `geo = geo` compares bounding boxes, not
-- exact coordinates.
create or replace function public.venues_guard_owner_columns()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    -- Exclude the owner-editable keys AND the generated columns lat/lng: a BEFORE trigger
    -- sees generated columns as NULL in NEW (they are recomputed only after BEFORE
    -- triggers), so leaving them in would falsely flag every edit. They cannot be written
    -- directly anyway, so excluding them opens no hole. updated_at is set by trg_venues_updated.
    if (to_jsonb(new) - '{description,links,opening_times,updated_at,lat,lng}'::text[])
       is distinct from
       (to_jsonb(old) - '{description,links,opening_times,updated_at,lat,lng}'::text[]) then
      raise exception
        'venues: an owner may only edit description, links and opening_times'
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists venues_guard_owner_columns on venues;
create trigger venues_guard_owner_columns
  before update on venues
  for each row execute function public.venues_guard_owner_columns();

-- ── #7 profiles: moderation + immutable fields are not self-writable ──────────────────
-- profiles_update (0004) is a whole-row self-write. A signed-in user must not clear their
-- own banned_at (moderation, set only by the definer moderate_ban_profile), re-point
-- invited_by (set-once referral attribution), or flip owner_digest_opt_out (written only by
-- the service-role unsubscribe token route). Pin those three for direct client roles;
-- everything else on the row (display_name, handle, bio, avatar, prefs, layout, …) stays
-- freely self-editable, so this is a denylist rather than an allowlist. invited_by uses
-- coalesce so the genuine first set (null -> inviter, via the authenticated redeem flow)
-- still works while a re-point (value -> other) is blocked.
create or replace function public.profiles_guard_protected_columns()
  returns trigger
  language plpgsql
  security invoker
  set search_path = public, pg_temp
as $$
begin
  if current_user in ('authenticated', 'anon') then
    new.banned_at            := old.banned_at;                             -- moderation only
    new.invited_by           := coalesce(old.invited_by, new.invited_by);  -- set-once
    new.owner_digest_opt_out := old.owner_digest_opt_out;                  -- token route only
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_guard_protected_columns on profiles;
create trigger profiles_guard_protected_columns
  before update on profiles
  for each row execute function public.profiles_guard_protected_columns();

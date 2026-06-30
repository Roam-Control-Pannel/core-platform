-- 0046_offer_redeem.sql
--
-- Light up the offer-redemption seam (offers / offer_saves / offer_redemptions all exist from
-- 0002; RLS from 0004). offer_redemptions has a READ policy (own row or venue owner) but NO
-- insert policy by design — a redemption is a guarded write, so it goes through this SECURITY
-- DEFINER RPC (same pattern as send_venue_notification). The RPC enforces the rules a plain
-- insert can't: the offer must be live, one redemption per user, and the global max_redemptions
-- cap. A partial unique index is the hard backstop against double-redeeming.
--
-- Honor-system v1: the signed-in user redeems at the counter; staff eyeball the revealed code and
-- the "Redeemed" state. Apply once on the Roam-Core-Platform project.

-- One redemption per user per offer (anonymous/null redemptions, if ever used, are unconstrained).
create unique index if not exists idx_offer_redemptions_user
  on offer_redemptions (offer_id, profile_id) where profile_id is not null;

create or replace function redeem_offer(p_offer uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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

grant execute on function redeem_offer(uuid) to authenticated;
revoke execute on function redeem_offer(uuid) from anon;

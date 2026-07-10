-- 0076_security_hardening.sql
--
-- Security Advisor remediation (July 2026 review). The function audit found no missing
-- in-body auth on user-facing RPCs, but the linter reports the service-only admin family as
-- executable by anon/authenticated in production — i.e. the revokes written in 0008/0020/
-- 0024/0026/0029/0056 have drifted (or were reset by a drop+recreate). This migration
-- RE-ASSERTS every function ACL from first principles, idempotently, so a re-run is always
-- safe and the linter's premise can never be true again. It also:
--   - revokes the internal slug/handle generators (existence oracles via /rest/v1/rpc)
--   - revokes the dead 0004 helpers and the 17 trigger functions (hygiene; not RPC-reachable)
--   - fixes redeem_offer's no-op "revoke from anon" (the grant lives on PUBLIC, not anon)
--   - pins search_path on the four flagged SECURITY INVOKER functions
--   - drops the two broad storage SELECT policies that allowed listing public buckets
--     (public-bucket object URLs do not use storage.objects RLS; nothing in the app
--     calls .list()/.download() — verified across web/native/console)
--
-- Deliberately NOT touched: postgis/pg_trgm/pg_net extension placement (not safely
-- relocatable; accepted advisories), st_estimatedextent (extension-owned; ACL not ours to
-- change — same ownership story as spatial_ref_sys), and the user-facing RPCs that gate
-- themselves on auth.uid() (they NEED anon/authenticated EXECUTE; see the audit table in
-- the PR description).

begin;

/* ── 1. Service-only admin/ingest family: nobody but service_role, ever ────────────────── */

revoke all on function public.approve_venue_claim(target_claim_id uuid) from public, anon, authenticated;
grant execute on function public.approve_venue_claim(target_claim_id uuid) to service_role;

revoke all on function public.reject_venue_claim(target_claim_id uuid, reason text) from public, anon, authenticated;
grant execute on function public.reject_venue_claim(target_claim_id uuid, reason text) to service_role;

revoke all on function public.moderate_ban_profile(p_user_id uuid, p_banned boolean) from public, anon, authenticated;
grant execute on function public.moderate_ban_profile(p_user_id uuid, p_banned boolean) to service_role;

revoke all on function public.moderate_revoke_claim(p_venue_id uuid) from public, anon, authenticated;
grant execute on function public.moderate_revoke_claim(p_venue_id uuid) to service_role;

revoke all on function public.moderate_set_venue_suspended(p_venue_id uuid, p_suspended boolean) from public, anon, authenticated;
grant execute on function public.moderate_set_venue_suspended(p_venue_id uuid, p_suspended boolean) to service_role;

revoke all on function public.deliver_birthday_offers() from public, anon, authenticated;
grant execute on function public.deliver_birthday_offers() to service_role;

revoke all on function public.upsert_place_venues(places jsonb) from public, anon, authenticated;
grant execute on function public.upsert_place_venues(places jsonb) to service_role;

revoke all on function public.upsert_venue_photos(payload jsonb) from public, anon, authenticated;
grant execute on function public.upsert_venue_photos(payload jsonb) to service_role;

revoke all on function public.venue_link_hosts(target_venue_id uuid) from public, anon, authenticated;
grant execute on function public.venue_link_hosts(target_venue_id uuid) to service_role;

revoke all on function public.claim_places_fetch_quota(p_client_key text, p_daily_cap integer, p_client_cap integer, p_client_window_secs integer) from public, anon, authenticated;
grant execute on function public.claim_places_fetch_quota(p_client_key text, p_daily_cap integer, p_client_cap integer, p_client_window_secs integer) to service_role;

/* ── 2. Internal generators + dead helpers: not part of the public API surface ──────────── */
-- The generators are only ever called from inside DEFINER functions (which run as owner),
-- so revoking client roles breaks nothing; exposed, they are handle/slug existence oracles.

revoke all on function public.gen_unique_handle(seed text) from public, anon, authenticated;
grant execute on function public.gen_unique_handle(seed text) to service_role;

revoke all on function public.gen_unique_venue_slug(p_name text, p_locality text) from public, anon, authenticated;
grant execute on function public.gen_unique_venue_slug(p_name text, p_locality text) to service_role;

revoke all on function public.gen_unique_topic_slug(p_title text, p_locality text) from public, anon, authenticated;
grant execute on function public.gen_unique_topic_slug(p_title text, p_locality text) to service_role;

revoke all on function public.current_profile() from public, anon, authenticated;
revoke all on function public.are_friends(a uuid, b uuid) from public, anon, authenticated;

/* ── 3. Trigger functions: never callable via RPC anyway; silence the default grant ─────── */

revoke all on function public.handle_new_auth_user() from public, anon, authenticated;
revoke all on function public.set_venue_slug() from public, anon, authenticated;
revoke all on function public.set_topic_slug() from public, anon, authenticated;
revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.set_venue_photos_updated_at() from public, anon, authenticated;
revoke all on function public.notify_wall_comment() from public, anon, authenticated;
revoke all on function public.notify_townhall_reply() from public, anon, authenticated;
revoke all on function public.notify_venue_follow() from public, anon, authenticated;
revoke all on function public.notify_friend_event() from public, anon, authenticated;
revoke all on function public.tg_activity_follow() from public, anon, authenticated;
revoke all on function public.tg_activity_offer_save() from public, anon, authenticated;
revoke all on function public.tg_activity_offer_redeem() from public, anon, authenticated;
revoke all on function public.town_hall_bump_upvotes() from public, anon, authenticated;
revoke all on function public.town_hall_bump_replies() from public, anon, authenticated;
revoke all on function public.town_hall_bump_reply_upvotes() from public, anon, authenticated;
revoke all on function public.profile_post_bump_likes() from public, anon, authenticated;
revoke all on function public.profile_post_bump_comments() from public, anon, authenticated;

/* ── 4. Signed-in-only RPCs that were open to anon via the default PUBLIC grant ─────────── */
-- Both gate on auth.uid() internally, so this is defense-in-depth + a correct ACL story:
-- 0046's "revoke from anon" was a no-op (anon executed via PUBLIC, which was never revoked).

revoke all on function public.redeem_offer(p_offer uuid) from public, anon;
grant execute on function public.redeem_offer(p_offer uuid) to authenticated, service_role;

revoke all on function public.request_venue_claim(target_venue_id uuid, claim_note text) from public, anon;
grant execute on function public.request_venue_claim(target_venue_id uuid, claim_note text) to authenticated, service_role;

/* ── 5. Pin search_path on the four flagged SECURITY INVOKER functions ──────────────────── */

alter function public.set_updated_at() set search_path = public, pg_temp;
alter function public.set_venue_photos_updated_at() set search_path = public, pg_temp;
alter function public.current_profile() set search_path = public, pg_temp;
alter function public.are_friends(a uuid, b uuid) set search_path = public, pg_temp;

/* ── 6. Public buckets: stop clients enumerating bucket contents ────────────────────────── */
-- Public-bucket objects are served via /storage/v1/object/public/... which does NOT consult
-- storage.objects RLS, so images keep working. These policies only enabled LISTING.

drop policy if exists profile_media_public_read on storage.objects;
drop policy if exists venue_media_read_public on storage.objects;

commit;

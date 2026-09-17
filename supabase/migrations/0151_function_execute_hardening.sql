-- ============================================================================
-- 0151 — Function EXECUTE hardening (holistic plan Phase 1.7).
--
-- WHY. Supabase's default privileges grant EXECUTE on every new public function DIRECTLY to anon and
-- authenticated (`alter default privileges … grant execute on functions to anon, authenticated,
-- service_role`). A `revoke … from public` therefore does NOT close a function to browser callers —
-- the client roles hold their own grant. 0076 fixed this for the then-known set with an explicit
-- `from public, anon, authenticated`; 0149 did the same for order_channel_for_venue. Phase 1.7's
-- audit of every function created since (a query over pg_proc joined to has_function_privilege for
-- anon/authenticated, minus trigger functions) found exactly THREE that were either revoked from
-- public only, or re-created after their revoke without one:
--
--   1. claim_places_detail_quota(text, integer, integer, integer) — 0080. SECURITY DEFINER; consumes
--      the Google Places Details budget (places_fetch_quota). Revoked from public only. A browser
--      caller could burn the daily details budget (`select * from rpc/claim_places_detail_quota`)
--      and black out on-demand enrichment for everyone. Service-only by design (places.ts calls it
--      through the service client).
--   2. apply_venue_details(uuid, text, text, jsonb, jsonb[, text]) — 0080 revoked the 5-arg version;
--      0096 DROPPED it and created the 6-arg version with NO revoke at all, so the client roles hold
--      the default grant. SECURITY INVOKER, so venues RLS still bounds the damage, but it is a
--      service-only writer (places.ts, photos/refresh.ts) and must not be a client RPC.
--   3. is_non_evidence_host(text) — 0008. Immutable SQL deny-list helper, called ONLY from inside
--      SECURITY DEFINER functions (venue_link_hosts, approve_venue_claim), which run as their owner
--      and are unaffected by client-role grants. Exposed, it is a harmless-but-pointless oracle for
--      the claim auto-approval deny-list; closing it removes surface for free.
--
-- NOT touched (deliberately): the five trigger-attached SECURITY DEFINER functions
-- (events_bump_interest, seed_venue_marketing_prefs, set_event_geo, set_org_slug,
-- venue_reviews_refresh_rollup). Triggers fire as the table owner regardless of the caller's EXECUTE
-- grant, and revoking on them is a known foot-gun for `supabase db reset` ordering — left as-is and
-- documented in the recon.
--
-- Idempotent and signature-tolerant: each revoke runs only if that exact signature exists (the 5-arg
-- apply_venue_details is gone on a rebuilt DB but may linger on a live one that skipped 0096's drop).
-- Forward-only. Service-role keeps EXECUTE (it bypasses grants anyway; the grant documents intent).
-- ============================================================================

do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.claim_places_detail_quota(text, integer, integer, integer)',
    'public.apply_venue_details(uuid, text, text, jsonb, jsonb)',
    'public.apply_venue_details(uuid, text, text, jsonb, jsonb, text)',
    'public.is_non_evidence_host(text)'
  ] loop
    if to_regprocedure(sig) is not null then
      execute format('revoke all on function %s from public, anon, authenticated', sig);
      execute format('grant execute on function %s to service_role', sig);
    end if;
  end loop;
end $$;

comment on function public.claim_places_detail_quota(text, integer, integer, integer) is
  'Atomic check-and-consume of the Google Places DETAILS budget (its own buckets, twin of '
  'claim_places_fetch_quota). SECURITY DEFINER; service-role only — anon/authenticated EXECUTE '
  'revoked in 0151 (0080 revoked from public only, which Supabase''s default grants bypass).';

comment on function public.is_non_evidence_host(text) is
  'Deny-list of hosts that are NOT evidence of owning a venue (free-mail, aggregators, social, '
  'link-in-bio). Called only from inside the SECURITY DEFINER claim functions; service-role only '
  'since 0151.';

-- ============================================================================
-- 0150 — The "live" member spine: backfill verified claims to live; codify the Association's
--        sections; a lapsed_at stamp.
--
-- WHY. Every member entitlement (directory listing 0144, jobs composer 0142, supplier posting 0143)
-- and the member tier of the storefront ranking require channel_members.status = 'live' — and until
-- holistic plan Phase 1.2 NOTHING wrote 'live': the invite flow writes 'invited', the claim definer
-- (0139) writes 'claimed'. So no member could ever reach a member-only feature, and the three
-- Association surfaces (directory, jobs, suppliers) were built but unreachable: the storefront header
-- never linked to them and the f2g channel's `sections` allow-map exposed only the storefront.
--
-- WHAT.
--   1. Backfill: every member who reached 'claimed' THROUGH THE VERIFIED PATH — claim_channel_member_venue
--      set claimed_by (the signed-in claimant) and the venue is bound — becomes 'live'. That is the only
--      way a row gets claimed_by today (0139:113-119), so this is "everyone who has already proven
--      themselves", nothing looser. Nobody who has claimed loses priority when Phase 2 tightens the
--      member definition to live-only.
--   2. channel_members.lapsed_at — stamped by HQ's lapse action now, by roster re-import in Phase 2.
--   3. f2g sections: expose directory, jobs and suppliers (the Association features) in the versioned
--      config instead of leaving them as unversioned live-DB state. Merged with ||, so any other key
--      already set live is kept.
--
-- Idempotent. Forward-only. The status transition table (@roam/core/membership) gains
-- imported/invited → live in the same PR; the DB check constraint already allows every value.
-- ============================================================================

alter table channel_members
  add column if not exists lapsed_at timestamptz;

comment on column channel_members.lapsed_at is
  'When the member last moved to ''lapsed'' (HQ action today; roster re-import in Phase 2). Cleared '
  'is not needed: a later ''live'' supersedes it and the audit log holds the history.';

-- ── 1. backfill verified claims → live ───────────────────────────────────────────────────────────
do $$
declare
  n integer;
begin
  update channel_members
     set status = 'live'
   where status = 'claimed'
     and claimed_by is not null
     and venue_id is not null;
  get diagnostics n = row_count;
  raise notice '0150: % verified claimed member(s) moved to live', n;
end $$;

-- ── 3. f2g sections: the Association surfaces are on ─────────────────────────────────────────────
update channels
   set sections = coalesce(sections, '{}'::jsonb)
                  || '{"storefront":true,"directory":true,"jobs":true,"suppliers":true}'::jsonb
 where key = 'f2g';

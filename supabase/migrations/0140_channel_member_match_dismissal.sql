-- 0140_channel_member_match_dismissal.sql
--
-- Food to Go · Phase B · Slice B4b — the MATCH-REVIEW dismissal marker.
--
-- B3-b's matcher auto-binds only confident, unambiguous matches; everything else (a plausible but
-- ambiguous candidate, e.g. a chain's two branches on one postcode) is left UNBOUND for a human. B4b
-- adds the staff match-review queue that surfaces those unbound members with their ranked candidates
-- (the matcher re-run on demand — no stored candidate state to drift) so staff can CONFIRM the right
-- venue (a method='manual' external_ref + venue_id bind, the correction of record).
--
-- But a reviewer also needs to say "none of these candidates is it" and have that STICK — otherwise the
-- member re-appears in the queue on every visit. That negative decision is the only genuinely new
-- persistent state B4b needs, so this migration adds it: a nullable dismissal marker on the roster row.
-- A confirmed match clears it; the queue hides dismissed members unless explicitly asked to show them.
--
-- channel_members is service-managed (0135): RLS on, no client policy, and a guard trigger that blocks
-- EVERY client-role write regardless of column — so these new columns inherit that posture with no RLS
-- change. Only service_role / SECURITY DEFINER (the audited B4b admin action) writes them. Additive;
-- idempotent.

alter table channel_members
  add column if not exists match_dismissed_at timestamptz,
  add column if not exists match_dismissed_by uuid references profiles(id) on delete set null;

-- The review queue reads unbound, non-dismissed members; index the common predicate (a partial index
-- so it stays small — most of the roster ends up bound or dismissed).
create index if not exists channel_members_review_idx
  on channel_members (channel_id)
  where venue_id is null and match_dismissed_at is null;

comment on column channel_members.match_dismissed_at is
  'B4b match-review: set when a staff reviewer marks the member as having no correct venue candidate, so it drops out of the review queue. Cleared when a match is later confirmed. Service-managed (see the channel_members guard).';

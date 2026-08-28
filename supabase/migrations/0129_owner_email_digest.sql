-- 0129_owner_email_digest.sql
--
-- Foundation for OWNER EMAIL NOTIFICATIONS — a daily digest email to venue owners summarising new
-- business activity (reviews, orders, comments, claim decisions) drawn from the notifications table.
-- Business owners today get an in-app bell only; this adds the durable state the digest job needs.
-- Inert on its own: nothing here sends mail — the job (packages/api jobs/deliverOwnerDigest) and the
-- cron that drives it land separately.
--
-- Two pieces:
--   1. owner_digest_state — a per-owner watermark. The job emails activity with created_at AFTER
--      last_emailed_at, then advances it. We deliberately do NOT key off notifications.read_at
--      (opening the in-app centre clears it, so it would suppress un-seen-by-email activity) nor a
--      per-row emailed_at (needs backfill + per-row writes). One row per owner is the cheapest,
--      idempotent watermark.
--   2. profiles.owner_digest_opt_out — the email opt-out. Default FALSE = owners receive the digest
--      (activity on their own listing is service/transactional); every email carries a one-click
--      unsubscribe that flips this true. Service-role only (no client policy) — set via the token
--      route, read by the job.

-- Per-owner send watermark. Service-write only; no RLS policies (only the digest job touches it).
create table if not exists owner_digest_state (
  owner_id        uuid primary key references profiles(id) on delete cascade,
  last_emailed_at timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

comment on table owner_digest_state is
  'Per-owner watermark for the daily owner-activity digest email: the job sends notifications newer '
  'than last_emailed_at, then advances it. Service-role only.';

alter table owner_digest_state enable row level security;
-- No policies: RLS on with zero policies denies all anon/authenticated access; the service role
-- (used by the digest job) bypasses RLS. Owners never read this directly.

-- Email opt-out for the owner digest. Default false = subscribed; the unsubscribe link flips it true.
alter table profiles add column if not exists owner_digest_opt_out boolean not null default false;

comment on column profiles.owner_digest_opt_out is
  'When true, this owner has unsubscribed from the daily business-activity digest email (via the '
  'one-click unsubscribe link). The digest job skips opted-out owners. Default false = subscribed.';

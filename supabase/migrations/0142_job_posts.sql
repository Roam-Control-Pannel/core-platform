-- 0142_job_posts.sql
--
-- Food to Go · Phase C · Slice C4-a — the EMPLOYABILITY BOARD + the shared member-entitlement seam.
--
-- A member-posted local jobs board for a channel. v1 is POST-AND-APPLY-OUT (decision #3): a post
-- carries an external apply link and NOTHING that would store applicant data — no CV, no ATS, no
-- applicant PII. That boundary is enforced structurally: the table has an `apply_url` (required) and
-- simply no column an applicant's data could land in.
--
-- Modelled on `events` (0099): same optimistic moderation posture (publishes `auto_approved`; the
-- report-then-act moderation_queue backstop handles abuse) and the same author-owned RLS. The one
-- addition over events is the ENTITLEMENT GATE on insert — "free for members" (decision #9) means only
-- a LIVE channel member may post. That gate is `f2g_can_post_as_member` below: the single seam C3
-- (self-serve suppliers) reuses, so a future paywall replaces one function body and no policy changes.
--
-- Additive; idempotent. After applying, run `notify pgrst, 'reload schema'`.

-- ── the shared entitlement seam ───────────────────────────────────────────────────────────────────
-- True iff the CALLER (auth.uid()) is a LIVE member of the channel. SECURITY DEFINER so it can read
-- the service-managed channel_members roster (0135, no client read policy) — but it reveals only the
-- caller's OWN membership (never another user's), so it's safe to grant to authenticated for both the
-- RLS with-check below AND a pre-flight UI check. A "live" member is one whose claim went live
-- (status='live'); until a member reaches that state, posting is correctly closed (decision #9).
create or replace function public.f2g_can_post_as_member(p_channel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from channel_members m
    where m.channel_id = p_channel_id
      and m.claimed_by = auth.uid()
      and m.status = 'live'
  );
$$;

comment on function public.f2g_can_post_as_member(uuid) is
  'Entitlement seam (decisions #9): true iff auth.uid() is a LIVE channel_members member of p_channel_id. SECURITY DEFINER (reads the service-managed roster) but scoped to the caller''s own membership. Used by the job_posts insert policy (C4) and reused by the orgs self-serve insert policy (C3). A future paywall replaces this body.';

revoke all on function public.f2g_can_post_as_member(uuid) from public;
grant execute on function public.f2g_can_post_as_member(uuid) to authenticated;

-- ── the board ───────────────────────────────────────────────────────────────────────────────────
create table if not exists job_posts (
  id              uuid primary key default gen_random_uuid(),
  author_id       uuid references profiles(id) on delete set null,
  channel_id      uuid not null references channels(id) on delete cascade,
  title           text not null,
  description     text,
  -- Soft enum (also validated in the API). No CV/ATS: applying is an OUTBOUND link only.
  employment_type text,
  locality        text not null,
  locality_label  text not null,
  venue_id        uuid references venues(id) on delete set null,
  location_name   text,
  apply_url       text not null,                          -- the apply-out link (required — the only apply path)
  salary_text     text,                                   -- optional free-text comp ("£11.50/hr", "Competitive")
  starts_at       timestamptz,
  expires_at      timestamptz,                            -- auto-closes past this (read filter + nightly sweep)
  status          text not null default 'published',
  moderation      moderation_status not null default 'auto_approved',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint job_posts_title_len   check (char_length(title) between 1 and 140),
  constraint job_posts_desc_len    check (description is null or char_length(description) <= 8000),
  constraint job_posts_apply_len   check (char_length(apply_url) between 1 and 2000),
  constraint job_posts_locname_len check (location_name is null or char_length(location_name) <= 200),
  constraint job_posts_salary_len  check (salary_text is null or char_length(salary_text) <= 120),
  constraint job_posts_status_ok   check (status in ('published', 'closed')),
  constraint job_posts_type_ok     check (employment_type is null or employment_type in
    ('full_time','part_time','temporary','apprenticeship','seasonal','casual','internship','other'))
);

-- Board listing: a channel's open posts, newest first.
create index if not exists job_posts_channel_idx on job_posts (channel_id, status, created_at desc);
-- Expiry sweep + read-time expiry filter.
create index if not exists job_posts_expiry_idx on job_posts (expires_at) where status = 'published';

drop trigger if exists job_posts_updated_at on job_posts;
create trigger job_posts_updated_at before update on job_posts
  for each row execute function set_updated_at();

-- ── RLS: public read (approved), author-owned writes, entitlement-gated insert ────────────────────
alter table job_posts enable row level security;

-- Public sees only approved posts (the moderation posture). status is filtered by the board query, so
-- a direct link to a closed post still resolves (mirrors events keeping cancelled events readable).
drop policy if exists job_posts_read on job_posts;
create policy job_posts_read on job_posts for select
  using (moderation in ('auto_approved', 'approved'));

-- INSERT: the author must be the caller, the row starts published+auto_approved, AND the caller must be
-- a LIVE member of the channel (the entitlement seam). This is the one gate over events.
drop policy if exists job_posts_insert on job_posts;
create policy job_posts_insert on job_posts for insert
  with check (
    author_id = auth.uid()
    and status = 'published'
    and moderation = 'auto_approved'
    and public.f2g_can_post_as_member(channel_id)
  );

-- The author manages their own post (edit / close / delete).
drop policy if exists job_posts_update on job_posts;
create policy job_posts_update on job_posts for update using (author_id = auth.uid());
drop policy if exists job_posts_delete on job_posts;
create policy job_posts_delete on job_posts for delete using (author_id = auth.uid());

-- ── nightly expiry sweep ──────────────────────────────────────────────────────────────────────────
-- Flip published posts past their expires_at to 'closed'. SECURITY DEFINER so pg_cron (or an internal
-- route) can run it as a scheduled `select close_expired_job_posts();`. Returns the count closed.
create or replace function public.close_expired_job_posts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer;
begin
  update job_posts
    set status = 'closed'
    where status = 'published' and expires_at is not null and expires_at < now();
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.close_expired_job_posts() from public, anon, authenticated;
grant execute on function public.close_expired_job_posts() to service_role;

comment on table job_posts is
  'F2G employability board (C4). Member-posted local jobs; v1 is post-and-apply-out — apply_url is the ONLY apply path, and no applicant PII is modelled. Modelled on events (optimistic moderation + author-owned RLS); the one addition is the insert entitlement gate f2g_can_post_as_member (live members only, decision #9).';

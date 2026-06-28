-- ============================================================================
-- Roam — 0030_town_hall.sql
-- Town Hall: a per-locality public forum. Locals start TOPICS and REPLY to each
-- other; topics are upvotable so the most-wanted suggestions surface. This is
-- community discussion (about the area, its places, recommendations) — not the
-- venue-scoped `posts` feed (0002) and not private `chat` (0002).
--
-- Scope key: `locality` is a slug of the place name (e.g. 'darlington'), set by
-- the API from the place the user is browsing, so everyone who browses the same
-- town shares one board regardless of how they got there (saved/suggested/search).
--
-- Moderation posture mirrors chat/posts: content publishes OPTIMISTICALLY
-- (moderation 'auto_approved') and the report-then-act backstop (moderation_queue,
-- 0003 + moderation router) is how abuse is handled — same "allow until reported"
-- contract as self-serve claims.
--
-- RLS: world-readable while approved; author-owned writes (author_id = auth.uid()).
-- Upvotes are one-per-(topic,voter); denormalised counts on the topic are kept by
-- SECURITY DEFINER triggers (the voter/replier isn't the topic's author, so the
-- count UPDATE must bypass the author-only RLS write policy).
-- ============================================================================

-- ── topics ──────────────────────────────────────────────────────────────────
create table town_hall_topics (
  id              uuid primary key default gen_random_uuid(),
  locality        text not null,                 -- slug, e.g. 'darlington'
  locality_label  text not null,                 -- display name as first given, e.g. 'Darlington'
  author_id       uuid references profiles(id) on delete set null,
  title           text not null,
  body            text not null,
  upvote_count    integer not null default 0,    -- denormalised; maintained by trigger
  reply_count     integer not null default 0,    -- denormalised; maintained by trigger
  last_activity_at timestamptz not null default now(),
  moderation      moderation_status not null default 'auto_approved',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint town_hall_topics_title_len check (char_length(title) between 1 and 140),
  constraint town_hall_topics_body_len  check (char_length(body) between 1 and 8000)
);
-- Listing is always locality-scoped, sorted by recent activity or by upvotes.
create index idx_town_hall_topics_recent on town_hall_topics (locality, last_activity_at desc);
create index idx_town_hall_topics_popular on town_hall_topics (locality, upvote_count desc, last_activity_at desc);
create trigger trg_town_hall_topics_updated before update on town_hall_topics
  for each row execute function set_updated_at();

-- ── replies ─────────────────────────────────────────────────────────────────
create table town_hall_replies (
  id          uuid primary key default gen_random_uuid(),
  topic_id    uuid not null references town_hall_topics(id) on delete cascade,
  author_id   uuid references profiles(id) on delete set null,
  body        text not null,
  moderation  moderation_status not null default 'auto_approved',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint town_hall_replies_body_len check (char_length(body) between 1 and 8000)
);
create index idx_town_hall_replies_topic on town_hall_replies (topic_id, created_at);
create trigger trg_town_hall_replies_updated before update on town_hall_replies
  for each row execute function set_updated_at();

-- ── upvotes (one per voter per topic) ────────────────────────────────────────
create table town_hall_votes (
  topic_id   uuid not null references town_hall_topics(id) on delete cascade,
  voter_id   uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (topic_id, voter_id)
);

-- ── denormalised-count maintenance ───────────────────────────────────────────
-- SECURITY DEFINER: the voter/replier is not the topic author, so these UPDATEs
-- to town_hall_topics must bypass the author-only RLS write policy below.

create or replace function town_hall_bump_upvotes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update town_hall_topics set upvote_count = upvote_count + 1 where id = new.topic_id;
  elsif tg_op = 'DELETE' then
    update town_hall_topics set upvote_count = greatest(0, upvote_count - 1) where id = old.topic_id;
  end if;
  return null;
end;
$$;

create trigger trg_town_hall_votes_count
  after insert or delete on town_hall_votes
  for each row execute function town_hall_bump_upvotes();

create or replace function town_hall_bump_replies()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update town_hall_topics
      set reply_count = reply_count + 1, last_activity_at = now()
      where id = new.topic_id;
  elsif tg_op = 'DELETE' then
    update town_hall_topics
      set reply_count = greatest(0, reply_count - 1)
      where id = old.topic_id;
  end if;
  return null;
end;
$$;

create trigger trg_town_hall_replies_count
  after insert or delete on town_hall_replies
  for each row execute function town_hall_bump_replies();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table town_hall_topics enable row level security;
alter table town_hall_replies enable row level security;
alter table town_hall_votes  enable row level security;

-- Topics: world-readable while approved; author writes/edits/removes their own.
create policy town_hall_topics_read on town_hall_topics for select
  using (moderation in ('auto_approved', 'approved'));
create policy town_hall_topics_insert on town_hall_topics for insert
  with check (author_id = auth.uid());
create policy town_hall_topics_update on town_hall_topics for update
  using (author_id = auth.uid());
create policy town_hall_topics_delete on town_hall_topics for delete
  using (author_id = auth.uid());

-- Replies: same posture.
create policy town_hall_replies_read on town_hall_replies for select
  using (moderation in ('auto_approved', 'approved'));
create policy town_hall_replies_insert on town_hall_replies for insert
  with check (author_id = auth.uid());
create policy town_hall_replies_update on town_hall_replies for update
  using (author_id = auth.uid());
create policy town_hall_replies_delete on town_hall_replies for delete
  using (author_id = auth.uid());

-- Votes: a voter manages only their OWN vote (and can see it, to render "upvoted").
create policy town_hall_votes_read on town_hall_votes for select
  using (voter_id = auth.uid());
create policy town_hall_votes_insert on town_hall_votes for insert
  with check (voter_id = auth.uid());
create policy town_hall_votes_delete on town_hall_votes for delete
  using (voter_id = auth.uid());

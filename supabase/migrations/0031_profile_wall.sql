-- ============================================================================
-- Roam — 0031_profile_wall.sql
-- Profile walls: a user's personal feed of posts (text + images now, video later),
-- with likes and comments. The social counterpart to the venue `posts` feed (0002)
-- and the Town Hall forum (0030).
--
-- MODEL (the product decision): OWNER-POSTS / PUBLIC-VIEW. Each wall is just the set
-- of profile_posts whose author_id is that profile — a user posts only to their OWN
-- wall (RLS insert: author_id = auth.uid()); anyone (incl. signed-out) can read.
-- Signed-in users can LIKE and COMMENT on any post.
--
-- Images live in the public `profile-media` Storage bucket (0027) under the author's
-- own folder; profile_posts.media holds an array of {type:'image', url} references —
-- the same "no bytes in Postgres" posture as venue/profile photos. The 'type' tag
-- leaves room for {type:'video', ...} when native video lands, with no schema change.
--
-- Moderation mirrors chat/posts/town-hall: publish OPTIMISTICALLY ('auto_approved')
-- with the report-then-act backstop (moderation_queue, 0003). Denormalised like/
-- comment counts are kept by SECURITY DEFINER triggers (the liker/commenter is not
-- the post author, so the count UPDATE must bypass the author-only write policy).
--
-- Re-appliable only on a clean DB (create table has no `if not exists`); intended to
-- run once, like the other feature migrations.
-- ============================================================================

-- ── posts ────────────────────────────────────────────────────────────────────
create table profile_posts (
  id            uuid primary key default gen_random_uuid(),
  author_id     uuid not null references profiles(id) on delete cascade,
  body          text,
  media         jsonb not null default '[]'::jsonb,   -- [{type:'image', url}]; video later
  like_count    integer not null default 0,           -- denormalised; maintained by trigger
  comment_count integer not null default 0,           -- denormalised; maintained by trigger
  moderation    moderation_status not null default 'auto_approved',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- A post must carry SOMETHING — text or at least one media item.
  constraint profile_posts_not_empty check (
    (body is not null and char_length(btrim(body)) > 0)
    or jsonb_array_length(media) > 0
  ),
  constraint profile_posts_body_len check (body is null or char_length(body) <= 5000)
);
create index idx_profile_posts_author on profile_posts (author_id, created_at desc);
create trigger trg_profile_posts_updated before update on profile_posts
  for each row execute function set_updated_at();

-- ── likes (one per liker per post) ───────────────────────────────────────────
create table profile_post_likes (
  post_id    uuid not null references profile_posts(id) on delete cascade,
  liker_id   uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, liker_id)
);

-- ── comments ─────────────────────────────────────────────────────────────────
create table profile_post_comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references profile_posts(id) on delete cascade,
  author_id   uuid references profiles(id) on delete set null,
  body        text not null,
  moderation  moderation_status not null default 'auto_approved',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint profile_post_comments_body_len check (char_length(body) between 1 and 3000)
);
create index idx_profile_post_comments_post on profile_post_comments (post_id, created_at);
create trigger trg_profile_post_comments_updated before update on profile_post_comments
  for each row execute function set_updated_at();

-- ── denormalised-count maintenance (SECURITY DEFINER bypasses author-only RLS) ──
create or replace function profile_post_bump_likes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update profile_posts set like_count = like_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update profile_posts set like_count = greatest(0, like_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;

create trigger trg_profile_post_likes_count
  after insert or delete on profile_post_likes
  for each row execute function profile_post_bump_likes();

create or replace function profile_post_bump_comments()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    update profile_posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update profile_posts set comment_count = greatest(0, comment_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;

create trigger trg_profile_post_comments_count
  after insert or delete on profile_post_comments
  for each row execute function profile_post_bump_comments();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table profile_posts         enable row level security;
alter table profile_post_likes    enable row level security;
alter table profile_post_comments enable row level security;

-- Posts: world-readable while approved; the wall's owner writes/edits/removes their own.
create policy profile_posts_read on profile_posts for select
  using (moderation in ('auto_approved', 'approved'));
create policy profile_posts_insert on profile_posts for insert
  with check (author_id = auth.uid());
create policy profile_posts_update on profile_posts for update
  using (author_id = auth.uid());
create policy profile_posts_delete on profile_posts for delete
  using (author_id = auth.uid());

-- Likes: a liker manages only their OWN like (and can read it, to render "liked").
create policy profile_post_likes_read on profile_post_likes for select
  using (liker_id = auth.uid());
create policy profile_post_likes_insert on profile_post_likes for insert
  with check (liker_id = auth.uid());
create policy profile_post_likes_delete on profile_post_likes for delete
  using (liker_id = auth.uid());

-- Comments: world-readable while approved; the comment author writes/edits/removes their own.
create policy profile_post_comments_read on profile_post_comments for select
  using (moderation in ('auto_approved', 'approved'));
create policy profile_post_comments_insert on profile_post_comments for insert
  with check (author_id = auth.uid());
create policy profile_post_comments_update on profile_post_comments for update
  using (author_id = auth.uid());
create policy profile_post_comments_delete on profile_post_comments for delete
  using (author_id = auth.uid());

-- ============================================================================
-- Roam — 0105_post_engagement.sql
-- Likes + comments on BUSINESS posts (the `posts` feed, 0002) — the venue-page
-- counterpart to the profile wall's likes/comments (0031). Signed-in users can
-- LIKE and COMMENT on any published business post; anyone can read.
--
-- Mirrors 0031 exactly (tables, denormalised counts kept by SECURITY DEFINER
-- triggers, RLS), with ONE difference in the notifications: a business post is
-- owned by the VENUE owner (posts.venue_id → venues.owner_id), not a plain
-- author_id, so the "liked/commented on your post" ping resolves the owner via
-- venues and links to /feed/<id>. Like pings COALESCE (via bump_engagement_
-- notification, 0103) so a popular post can't flood the owner's bell.
--
-- Additive: two nullable-defaulted columns on `posts`, two new tables, new
-- functions + triggers. Nothing existing is altered. Run BEFORE the API deploy.
-- ============================================================================

-- ── denormalised counts on the business post ─────────────────────────────────
alter table posts
  add column if not exists like_count    integer not null default 0,
  add column if not exists comment_count integer not null default 0;

-- ── likes (one per liker per post) ───────────────────────────────────────────
create table posts_likes (
  post_id    uuid not null references posts(id) on delete cascade,
  liker_id   uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, liker_id)
);

-- ── comments ─────────────────────────────────────────────────────────────────
create table posts_comments (
  id          uuid primary key default gen_random_uuid(),
  post_id     uuid not null references posts(id) on delete cascade,
  author_id   uuid references profiles(id) on delete set null,
  body        text not null,
  moderation  moderation_status not null default 'auto_approved',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint posts_comments_body_len check (char_length(body) between 1 and 3000)
);
create index idx_posts_comments_post on posts_comments (post_id, created_at);
create trigger trg_posts_comments_updated before update on posts_comments
  for each row execute function set_updated_at();

-- ── denormalised-count maintenance (SECURITY DEFINER bypasses owner-only RLS) ──
-- The liker/commenter is not the venue owner, so they can't pass posts_owner_all;
-- the count UPDATE must run as definer (same rationale as 0031).
create or replace function posts_bump_likes()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update posts set like_count = like_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update posts set like_count = greatest(0, like_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;
create trigger trg_posts_likes_count
  after insert or delete on posts_likes
  for each row execute function posts_bump_likes();

create or replace function posts_bump_comments()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update posts set comment_count = comment_count + 1 where id = new.post_id;
  elsif tg_op = 'DELETE' then
    update posts set comment_count = greatest(0, comment_count - 1) where id = old.post_id;
  end if;
  return null;
end;
$$;
create trigger trg_posts_comments_count
  after insert or delete on posts_comments
  for each row execute function posts_bump_comments();

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table posts_likes    enable row level security;
alter table posts_comments enable row level security;

-- Likes: a liker manages only their OWN like (and reads it, to render "liked").
create policy posts_likes_read   on posts_likes for select using (liker_id = auth.uid());
create policy posts_likes_insert on posts_likes for insert with check (liker_id = auth.uid());
create policy posts_likes_delete on posts_likes for delete using (liker_id = auth.uid());

-- Comments: world-readable while approved; the comment author writes/edits/removes their own.
create policy posts_comments_read   on posts_comments for select using (moderation in ('auto_approved', 'approved'));
create policy posts_comments_insert on posts_comments for insert with check (author_id = auth.uid());
create policy posts_comments_update on posts_comments for update using (author_id = auth.uid());
create policy posts_comments_delete on posts_comments for delete using (author_id = auth.uid());

-- ── notifications → the venue owner (resolved via posts.venue_id → venues.owner_id) ──
-- Like: coalesced ("X and N others liked your post"), never a flood.
create or replace function notify_business_post_like()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid; actor text;
begin
  select v.owner_id into v_owner
    from posts p join venues v on v.id = p.venue_id
    where p.id = new.post_id;
  if v_owner is null or v_owner = new.liker_id then return null; end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone') into actor
    from profiles where id = new.liker_id;
  perform bump_engagement_notification(v_owner, 'business_post_like', new.post_id,
    coalesce(actor, 'Someone'), 'liked', 'your post', '/feed/' || new.post_id::text);
  return null;
end;
$$;
drop trigger if exists trg_notify_business_post_like on posts_likes;
create trigger trg_notify_business_post_like after insert on posts_likes
  for each row execute function notify_business_post_like();

-- Comment: a direct ping (mirrors notify_wall_comment).
create or replace function notify_business_post_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid; actor text;
begin
  select v.owner_id into v_owner
    from posts p join venues v on v.id = p.venue_id
    where p.id = new.post_id;
  if v_owner is null or v_owner = new.author_id then return null; end if;
  select coalesce(nullif(trim(display_name), ''), '@' || handle, 'Someone') into actor
    from profiles where id = new.author_id;
  insert into notifications (recipient_id, type, payload)
  values (v_owner, 'business_post_comment', jsonb_build_object(
    'text', coalesce(actor, 'Someone') || ' commented on your post',
    'href', '/feed/' || new.post_id::text,
    'actorId', new.author_id
  ));
  return null;
end;
$$;
drop trigger if exists trg_notify_business_post_comment on posts_comments;
create trigger trg_notify_business_post_comment after insert on posts_comments
  for each row execute function notify_business_post_comment();

-- ── grant hygiene (mirrors 0076/0103): triggers invoke these regardless of role grants ──
revoke all on function posts_bump_likes()             from public, anon, authenticated;
revoke all on function posts_bump_comments()          from public, anon, authenticated;
revoke all on function notify_business_post_like()    from public, anon, authenticated;
revoke all on function notify_business_post_comment() from public, anon, authenticated;

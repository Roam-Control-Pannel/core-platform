-- ============================================================================
-- Roam — 0002_social_and_content.sql
-- The differentiator. Friends, follows, plans, chat, the meet-up loop (crown jewel),
-- posts (multi-destination), offers + redemptions, push-credit ledger.
-- ============================================================================

-- --- Follows: a profile follows a venue ------------------------------------
create table follows (
  follower_id uuid not null references profiles(id) on delete cascade,
  venue_id    uuid not null references venues(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (follower_id, venue_id)
);
create index idx_follows_venue on follows (venue_id);

-- --- Friends: symmetric relationship, stored as directed request edge -------
create table friendships (
  requester_id uuid not null references profiles(id) on delete cascade,
  addressee_id uuid not null references profiles(id) on delete cascade,
  status       friendship_status not null default 'pending',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);
create index idx_friendships_addressee on friendships (addressee_id, status);
create trigger trg_friendships_updated before update on friendships
  for each row execute function set_updated_at();

-- ============================================================================
-- plans — a group plan, optionally chat-linked. Add venues, invite friends.
-- ============================================================================
create table plans (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  title       text not null,
  notes       text,
  planned_for timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_plans_updated before update on plans
  for each row execute function set_updated_at();

create table plan_members (
  plan_id   uuid not null references plans(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  -- 'invited' until accepted; owner is implicitly a member.
  accepted  boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (plan_id, profile_id)
);

create table plan_venues (
  plan_id   uuid not null references plans(id) on delete cascade,
  venue_id  uuid not null references venues(id) on delete cascade,
  position  integer not null default 0,
  added_by  uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (plan_id, venue_id)
);

-- ============================================================================
-- chat — 1:1 + group threads. A plan can spawn a "Plan Chat" (thread.plan_id set).
-- ============================================================================
create table chat_threads (
  id          uuid primary key default gen_random_uuid(),
  is_group    boolean not null default false,
  -- If this thread is a Plan Chat, link it back to the plan.
  plan_id     uuid references plans(id) on delete set null,
  title       text,                          -- group title; null for 1:1
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_chat_threads_updated before update on chat_threads
  for each row execute function set_updated_at();

create table chat_participants (
  thread_id  uuid not null references chat_threads(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  last_read_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (thread_id, profile_id)
);

create table chat_messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references chat_threads(id) on delete cascade,
  sender_id   uuid references profiles(id) on delete set null,
  body        text,
  -- Rich content: shared venue cards, polls, location shares, meet-up control.
  -- payload shape discriminated by `kind`. Kept as jsonb so the meet-up loop
  -- can evolve without a migration per message type.
  kind        text not null default 'text',  -- 'text' | 'venue_card' | 'poll' | 'location_share' | 'meetup_event'
  payload     jsonb,
  moderation  moderation_status not null default 'pending',
  created_at  timestamptz not null default now()
);
create index idx_chat_messages_thread on chat_messages (thread_id, created_at);

-- ============================================================================
-- meet-up loop — THE crown jewel. Live vote poll + "meet at X" resolution.
-- A meet-up belongs to a thread; it holds the live poll and the resolved venue.
-- ============================================================================
create table meetups (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references chat_threads(id) on delete cascade,
  started_by  uuid references profiles(id) on delete set null,
  -- Lifecycle: 'voting' (poll open) -> 'resolved' (meet at X) -> 'ended'.
  state       text not null default 'voting',
  resolved_venue_id uuid references venues(id) on delete set null,
  started_at  timestamptz not null default now(),
  resolved_at timestamptz,
  ended_at    timestamptz
);
create index idx_meetups_thread on meetups (thread_id);

-- Candidate venues in the live vote poll.
create table meetup_options (
  id        uuid primary key default gen_random_uuid(),
  meetup_id uuid not null references meetups(id) on delete cascade,
  venue_id  uuid not null references venues(id) on delete cascade,
  added_by  uuid references profiles(id) on delete set null,
  unique (meetup_id, venue_id)
);

-- One vote per participant per meetup (re-votable: upsert on conflict).
create table meetup_votes (
  meetup_id uuid not null references meetups(id) on delete cascade,
  option_id uuid not null references meetup_options(id) on delete cascade,
  voter_id  uuid not null references profiles(id) on delete cascade,
  voted_at  timestamptz not null default now(),
  primary key (meetup_id, voter_id)   -- one active vote per voter; switch = update
);

-- Live, privacy-respecting location share during an active meet-up.
-- Coarse by design; never a precise persistent broadcast.
create table meetup_locations (
  meetup_id  uuid not null references meetups(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  geo        geography(Point, 4326) not null,
  updated_at timestamptz not null default now(),
  primary key (meetup_id, profile_id)
);

-- ============================================================================
-- posts — multi-destination composer output (news / offer / event).
-- ============================================================================
create table posts (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references venues(id) on delete cascade,
  author_id    uuid references profiles(id) on delete set null,
  kind         post_kind not null,
  title        text,
  body         text,
  media        jsonb not null default '[]'::jsonb,   -- Cloudinary refs
  destinations post_destination[] not null default '{profile}',
  -- Scheduling: published when publish_at <= now() and not draft.
  is_draft     boolean not null default false,
  publish_at   timestamptz,
  published_at timestamptz,
  moderation   moderation_status not null default 'pending',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index idx_posts_venue on posts (venue_id, published_at desc);
create index idx_posts_feed on posts (published_at desc) where 'feed' = any(destinations);
create trigger trg_posts_updated before update on posts
  for each row execute function set_updated_at();

-- ============================================================================
-- offers + redemptions — save / view / redeem (QR + code).
-- ============================================================================
create table offers (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  post_id     uuid references posts(id) on delete set null,
  title       text not null,
  details     text,
  code        text,                         -- redemption code (also encoded in QR)
  starts_at   timestamptz,
  ends_at     timestamptz,
  max_redemptions integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_offers_updated before update on offers
  for each row execute function set_updated_at();

create table offer_saves (
  offer_id   uuid not null references offers(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (offer_id, profile_id)
);

create table offer_redemptions (
  id         uuid primary key default gen_random_uuid(),
  offer_id   uuid not null references offers(id) on delete cascade,
  profile_id uuid references profiles(id) on delete set null,
  redeemed_at timestamptz not null default now()
);
create index idx_redemptions_offer on offer_redemptions (offer_id);

-- ============================================================================
-- push-credit ledger — metered credits, buy-more packs. Append-only ledger;
-- balance is the sum. Built now even though paid tiers are dormant, because
-- the free tier still needs a (zero-cost) ledger and the refund path must exist.
-- ============================================================================
create table push_credit_ledger (
  id         uuid primary key default gen_random_uuid(),
  venue_id   uuid not null references venues(id) on delete cascade,
  -- positive = granted/purchased, negative = consumed by a push send.
  delta      integer not null,
  reason     text not null,                  -- 'grant' | 'purchase' | 'send' | 'refund' | 'adjustment'
  ref        text,                           -- e.g. stripe payment intent / push job id
  created_at timestamptz not null default now()
);
create index idx_push_ledger_venue on push_credit_ledger (venue_id, created_at);

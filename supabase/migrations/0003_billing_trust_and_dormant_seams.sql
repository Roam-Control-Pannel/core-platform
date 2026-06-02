-- ============================================================================
-- Roam — 0003_billing_trust_and_dormant_seams.sql
-- Billing (refund gap from DDS closed), notifications, moderation queue,
-- and the DORMANT Stage-5 seams. The seams are present, typed, RLS'd, and
-- unreferenced by any shipping feature — so lighting them up needs NO migration.
-- ============================================================================

-- ============================================================================
-- billing — subscriptions + push-credit packs via Stripe.
-- At launch only the 'free' tier is wired to live checkout (feature_flags:
-- billing.paid_tiers = false). The model is complete regardless.
--
-- THE DDS GAP, CLOSED: charge.refunded must actually update state. We track
-- refunded amounts explicitly and the webhook writes them. A refund is not a
-- no-op here.
-- ============================================================================
create table billing_customers (
  venue_id          uuid primary key references venues(id) on delete cascade,
  stripe_customer_id text unique,
  tier              subscription_tier not null default 'free',
  current_period_end timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create trigger trg_billing_customers_updated before update on billing_customers
  for each row execute function set_updated_at();

create table billing_transactions (
  id                  uuid primary key default gen_random_uuid(),
  venue_id            uuid not null references venues(id) on delete cascade,
  stripe_payment_intent text unique,
  stripe_charge_id    text,
  -- Amounts in minor units (pence). VAT tracked separately for UK/EU compliance.
  amount_pence        integer not null,
  vat_pence           integer not null default 0,
  currency            char(3) not null default 'GBP',
  -- THE REFUND PATH: charge.refunded webhook writes here. Non-zero => refunded.
  refunded_pence      integer not null default 0,
  refunded_at         timestamptz,
  description         text,
  created_at          timestamptz not null default now()
);
create index idx_billing_tx_venue on billing_transactions (venue_id, created_at);

comment on column billing_transactions.refunded_pence is
  'Closes the DDS gap: the charge.refunded webhook MUST update this (and refunded_at). A refund is a real state change, never a 200-skipped no-op.';

-- ============================================================================
-- notifications — persistent Notification Centre (pattern from Roam CRM).
-- Covers social (requests, plan invites, chat, poll resolution) + geofenced
-- (welcome / offer / friends-nearby). Web fallback reads the same store.
-- ============================================================================
create table notifications (
  id         uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references profiles(id) on delete cascade,
  -- Discriminated by type; payload carries the specifics.
  type       text not null,   -- 'friend_request' | 'plan_invite' | 'chat' | 'poll_resolved' | 'offer' | 'friends_nearby' | 'welcome' | ...
  payload    jsonb not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index idx_notifications_recipient on notifications (recipient_id, created_at desc);
create index idx_notifications_unread on notifications (recipient_id) where read_at is null;

-- Push consent + device registration (opt-out is a hard gate).
create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  platform   text not null,           -- 'web' | 'ios' | 'android'
  token      text not null,           -- web push endpoint / FCM / APNs token
  consent    boolean not null default true,
  created_at timestamptz not null default now(),
  unique (profile_id, token)
);

-- ============================================================================
-- moderation_queue — global launch forces automated first-pass + manual queue.
-- Any UGC row (profile, post, chat_message) flagged 'auto_flagged' or reported
-- lands here for human review. App stores reject without working moderation.
-- ============================================================================
create table moderation_queue (
  id           uuid primary key default gen_random_uuid(),
  -- Polymorphic target: which UGC entity needs review.
  entity_type  text not null,         -- 'profile' | 'post' | 'chat_message' | 'venue'
  entity_id    uuid not null,
  reason       text not null,         -- 'auto_flag' | 'user_report'
  reporter_id  uuid references profiles(id) on delete set null,
  detail       text,
  status       moderation_status not null default 'pending',
  reviewed_by  uuid references profiles(id) on delete set null,
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index idx_moderation_pending on moderation_queue (status, created_at) where status = 'pending';

-- User-level block (distinct from venue follow). Symmetric enforcement in app layer.
create table user_blocks (
  blocker_id uuid not null references profiles(id) on delete cascade,
  blocked_id uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id),
  check (blocker_id <> blocked_id)
);

-- ============================================================================
-- DORMANT STAGE-5 SEAMS
-- Present, typed, RLS-ready, gated by feature_flags. Unreferenced by launch
-- features. Their existence is the whole point: v1 → v5 needs no migration.
-- ============================================================================

-- --- Marketplace / Shop (feature_flags: marketplace.enabled = false) ---------
create table shop_products (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  name        text not null,
  description text,
  price_pence integer,
  currency    char(3) not null default 'GBP',
  media       jsonb not null default '[]'::jsonb,
  active      boolean not null default false,    -- dormant: nothing live at launch
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_shop_products_updated before update on shop_products
  for each row execute function set_updated_at();

create table shop_orders (
  id          uuid primary key default gen_random_uuid(),
  buyer_id    uuid references profiles(id) on delete set null,
  venue_id    uuid not null references venues(id) on delete cascade,
  status      text not null default 'draft',
  total_pence integer not null default 0,
  currency    char(3) not null default 'GBP',
  created_at  timestamptz not null default now()
);

-- --- Travel / Trips (feature_flags: travel.enabled = false) ------------------
create table trips (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references profiles(id) on delete cascade,
  title       text not null,
  starts_on   date,
  ends_on     date,
  created_at  timestamptz not null default now()
);

create table trip_stops (
  id        uuid primary key default gen_random_uuid(),
  trip_id   uuid not null references trips(id) on delete cascade,
  venue_id  uuid references venues(id) on delete set null,
  -- A stop may be a place without a Roam venue yet (free text), hence nullable venue.
  label     text,
  geo       geography(Point, 4326),
  position  integer not null default 0,
  arrive_on date
);

-- --- Automation / Promotion journeys (feature_flags: automation.enabled=false)
create table automation_journeys (
  id          uuid primary key default gen_random_uuid(),
  venue_id    uuid not null references venues(id) on delete cascade,
  name        text not null,
  -- Journey definition (discovery answers -> tiered cadence -> auto-posts) as jsonb
  -- so the journey engine can evolve without schema churn.
  definition  jsonb not null default '{}'::jsonb,
  active      boolean not null default false,   -- dormant
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_automation_updated before update on automation_journeys
  for each row execute function set_updated_at();

comment on table shop_products is 'DORMANT Stage-5 seam (marketplace). Modelled now; gated by feature_flags.marketplace.enabled. Existence avoids a future migration.';
comment on table trips is 'DORMANT Stage-5 seam (travel). Modelled now; gated by feature_flags.travel.enabled.';
comment on table automation_journeys is 'DORMANT Stage-5 seam (automation). Modelled now; gated by feature_flags.automation.enabled.';

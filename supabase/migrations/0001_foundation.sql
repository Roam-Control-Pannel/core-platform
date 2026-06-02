-- ============================================================================
-- Roam — 0001_foundation.sql
-- Foundation: extensions, enums, profiles, venues (claimed + unclaimed),
-- global geo model, feature flags. SQL-first, RLS-enforced.
--
-- Principle: this schema is GLOBAL from day one. No region-shaped columns.
-- Go-to-market geofence (if ever used) is a config value, not a schema constraint.
-- ============================================================================

-- --- Extensions --------------------------------------------------------------
create extension if not exists "pgcrypto";      -- gen_random_uuid()
create extension if not exists "postgis";        -- geography(Point) for global proximity
create extension if not exists "pg_trgm";        -- fuzzy venue/text search

-- --- Enums -------------------------------------------------------------------
-- Subscription tiers: ALL exist from day one. Only 'free' is wired to live
-- checkout at launch; 'premium'/'gold' are dormant behind a feature flag.
create type subscription_tier as enum ('free', 'premium', 'gold');

-- Venue lifecycle: most venues launch 'unclaimed' (Google Places base layer).
-- This is the MEDIAN state globally, not an edge case.
create type venue_status as enum ('unclaimed', 'pending_claim', 'claimed', 'suspended');

-- Post types feeding the multi-destination composer.
create type post_kind as enum ('news', 'offer', 'event');

-- Where a post is published (composable destinations).
create type post_destination as enum ('profile', 'feed', 'follower_push');

-- Moderation status on all UGC. Global scale => automated first-pass + manual queue.
create type moderation_status as enum ('pending', 'auto_approved', 'auto_flagged', 'approved', 'rejected');

-- Friend request / friendship lifecycle.
create type friendship_status as enum ('pending', 'accepted', 'blocked');

-- --- updated_at trigger helper ----------------------------------------------
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================================
-- feature_flags — runtime gating. Dormant seams are gated here, not by absent schema.
-- ============================================================================
create table feature_flags (
  key          text primary key,
  enabled      boolean not null default false,
  description  text,
  updated_at   timestamptz not null default now()
);

insert into feature_flags (key, enabled, description) values
  ('billing.paid_tiers',     false, 'Premium/Gold checkout. Dormant at launch (free tier only).'),
  ('marketplace.enabled',    false, 'Stage 5 shop/marketplace. Seam modelled, feature off.'),
  ('travel.enabled',         false, 'Stage 5 trips/travel. Seam modelled, feature off.'),
  ('automation.enabled',     false, 'Stage 5 automated promotion journeys. Seam modelled, feature off.'),
  ('ai.personalisation',     false, 'AI personalisation. Post-launch.');

-- ============================================================================
-- profiles — the "You" surface. Mirrors auth.users (Supabase managed).
-- ============================================================================
create table profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  handle       text unique,
  display_name text,
  avatar_url   text,
  header_url   text,
  bio          text,
  -- Stored location for "your area"; coarse, never precise broadcast.
  home_geo     geography(Point, 4326),
  social_links jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create trigger trg_profiles_updated before update on profiles
  for each row execute function set_updated_at();

-- ============================================================================
-- venues — the core of discovery. Global. Claimed + unclaimed lifecycle.
-- Unclaimed venues are seeded from Google Places; they are browsable, plannable,
-- and navigable WITHOUT an owner. Claiming enriches; it does not unlock existence.
-- ============================================================================
create table venues (
  id            uuid primary key default gen_random_uuid(),
  status        venue_status not null default 'unclaimed',

  -- Identity / source
  name          text not null,
  -- External source linkage (Google Places base layer). Null once fully native.
  source        text,                      -- e.g. 'google_places'
  source_ref    text,                      -- external place id; unique per source
  source_attribution text default 'Information from public sources',

  -- Location — geography is global by construction.
  geo           geography(Point, 4326) not null,
  address       text,
  locality      text,                      -- powers the "locality tile" in unclaimed state
  region        text,
  country_code  char(2),                   -- ISO-3166-1; for display/grouping only, NOT gating

  -- Discovery metadata
  category      text,
  categories    text[] not null default '{}',
  rating        numeric(2,1),              -- base layer rating (e.g. from source) for "looks new not dead"
  rating_count  integer not null default 0,

  -- Claimed enrichment (null until claimed)
  owner_id      uuid references profiles(id) on delete set null,
  description   text,
  opening_times jsonb,
  dress_code    text,
  -- Configurable external links (Order/Book/Menu URLs cover in-app order/pay at launch)
  links         jsonb not null default '{}'::jsonb,
  custom_sections jsonb not null default '[]'::jsonb,

  -- Billing linkage (dormant paid tiers)
  subscription_tier subscription_tier not null default 'free',

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  unique (source, source_ref)
);
create trigger trg_venues_updated before update on venues
  for each row execute function set_updated_at();

-- Global proximity search: GiST index on geography for near→far sorting anywhere on Earth.
create index idx_venues_geo on venues using gist (geo);
create index idx_venues_status on venues (status);
create index idx_venues_owner on venues (owner_id);
create index idx_venues_name_trgm on venues using gin (name gin_trgm_ops);
create index idx_venues_categories on venues using gin (categories);

comment on table venues is
  'Global venue model. Unclaimed (Google Places base) is the median launch state worldwide and must be a graceful, non-embarrassing experience: browsable, plannable, navigable without an owner.';

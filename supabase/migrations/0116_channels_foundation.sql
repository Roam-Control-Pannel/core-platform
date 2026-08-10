-- 0116_channels_foundation.sql
--
-- Food to Go Marketplace · Phase 0 · Slice A — the CHANNEL foundation.
--
-- The whole marketplace rests on one idea: one platform, two views. F2G's storefront and
-- core Roam are the SAME app over the SAME database — a channel is a branded, filtered *view*,
-- never a second copy of the truth (Architecture: "no shell carries its own copy of the truth").
--
-- Three tables, all additive — nothing here disturbs venues/venue_products/orders/reviews:
--   channels          — a branded view (roam, f2g, …). Carries theme tokens + the default flag.
--   channel_domains   — hostname → channel. The web shell resolves the incoming host to a channel;
--                       the API never sees the host, only an x-roam-channel header. Custom domains
--                       later are just new rows here — no migration.
--   venue_channels    — the CHANNEL TAG. A venue opts INTO a non-default channel (f2g) via a row
--                       here. The default channel (roam) shows everything and needs no tags.
--
-- Dormant at launch: gated by feature_flags.marketplace.f2g.enabled = false. Seam present, feature off.
--
-- Idempotent; safe to run once on the Roam-Core project.
-- After applying this migration, regenerate the DB types:  pnpm db:types

-- ============================================================================
-- channels — a branded, filtered view over the one core. 'roam' is the default
-- (shows everything); 'f2g' is the Food to Go storefront (shows only tagged venues).
-- ============================================================================
create table if not exists channels (
  id          uuid primary key default gen_random_uuid(),
  -- URL-safe slug; the stable identifier the API scopes by (x-roam-channel header).
  key         text not null unique check (key ~ '^[a-z][a-z0-9_-]{1,30}$'),
  name        text not null,
  tagline     text,
  -- Exactly one channel is the default fallback (see partial unique index below).
  is_default  boolean not null default false,
  -- Theme token overrides applied on top of the base @roam/design palette by the web shell.
  -- Documented shape (all optional): { "brand": "#hex", "accent": "#hex", "paper": "#hex", "ink": "#hex" }.
  -- Empty object = inherit the base Roam palette unchanged.
  theme       jsonb not null default '{}'::jsonb,
  logo_url    text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Enforce a single default channel (the host-resolution fallback).
create unique index if not exists channels_one_default on channels (is_default) where is_default;

drop trigger if exists channels_updated_at on channels;
create trigger channels_updated_at
  before update on channels
  for each row execute function set_updated_at();

-- ============================================================================
-- channel_domains — hostname → channel. Source of truth for host resolution.
-- Hostnames are stored lowercased, host only (no scheme, no port). Custom domains
-- and new subdomains are added here, never in code.
-- ============================================================================
create table if not exists channel_domains (
  host       text primary key check (host = lower(host) and host !~ '[/:]'),
  channel_id uuid not null references channels(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists channel_domains_channel_idx on channel_domains (channel_id);

-- ============================================================================
-- venue_channels — the CHANNEL TAG. A venue's membership in a non-default channel.
-- Presence of a row = this venue surfaces on that channel's storefront.
-- (venues are implicitly in the default channel; those are never tagged here.)
-- ============================================================================
create table if not exists venue_channels (
  channel_id uuid not null references channels(id) on delete cascade,
  venue_id   uuid not null references venues(id) on delete cascade,
  -- Who tagged it (owner self-serve or a staff member); audit trail for onboarding.
  added_by   uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (channel_id, venue_id)
);
create index if not exists venue_channels_venue_idx on venue_channels (venue_id);
create index if not exists venue_channels_channel_idx on venue_channels (channel_id, created_at desc);

-- ============================================================================
-- RLS
-- ============================================================================
alter table channels        enable row level security;
alter table channel_domains enable row level security;
alter table venue_channels  enable row level security;

-- channels: world-readable when active (the web shell resolves + themes anonymously);
-- writes are staff/service-role only (deny-all-by-omission for user roles).
drop policy if exists channels_read on channels;
create policy channels_read on channels
  for select using (active = true);

-- channel_domains: world-readable (host resolution happens before any session exists);
-- writes are staff/service-role only.
drop policy if exists channel_domains_read on channel_domains;
create policy channel_domains_read on channel_domains
  for select using (true);

-- venue_channels: world-readable (drives the public storefront filter).
drop policy if exists venue_channels_read on venue_channels;
create policy venue_channels_read on venue_channels
  for select using (true);

-- A venue's owner may tag / untag their OWN claimed venue into a channel (self-serve onboarding).
-- Staff-wide tagging and any service-role work bypass RLS via the service client.
drop policy if exists venue_channels_owner_write on venue_channels;
create policy venue_channels_owner_write on venue_channels
  for all
  using (
    exists (
      select 1 from venues v
      where v.id = venue_channels.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
  )
  with check (
    exists (
      select 1 from venues v
      where v.id = venue_channels.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
  );

-- ============================================================================
-- Seed — the two launch channels + dev hostnames + the dormant feature flag.
-- Production hostnames (f2g subdomain, custom domains) are added via admin, not here.
-- ============================================================================
insert into channels (key, name, tagline, is_default, theme) values
  ('roam', 'Roam', 'Hyper-local discovery', true, '{}'::jsonb),
  ('f2g',  'Food to Go', 'Order ahead. Skip the queue.', false,
     '{"brand":"#E8562A","accent":"#1F9D55","paper":"#FFFDF8","ink":"#20140E"}'::jsonb)
on conflict (key) do nothing;

-- Dev/local host map so the seam is runnable out of the box. Real hosts are added via admin.
insert into channel_domains (host, channel_id)
select d.host, c.id
from channels c
join (values
  ('localhost',  'roam'),
  ('roam.local', 'roam'),
  ('f2g.local',  'f2g'),
  ('food.local', 'f2g')
) as d(host, key) on d.key = c.key
on conflict (host) do nothing;

insert into feature_flags (key, enabled, description) values
  ('marketplace.f2g.enabled', false, 'Food to Go marketplace storefront. Channel seam modelled; feature off until launch.')
on conflict (key) do nothing;

comment on table channels is
  'A branded, filtered VIEW over the one core (roam=default/all, f2g=Food to Go). Not a second data model — a channel filters + themes the same venues/products/orders. Gated by feature_flags.marketplace.f2g.enabled.';
comment on table channel_domains is
  'hostname → channel. Source of truth for host resolution; the web shell maps the incoming host to a channel and sends x-roam-channel to the API. Custom domains are new rows, never code.';
comment on table venue_channels is
  'The channel TAG: a venue opts into a non-default channel (f2g). Default channel (roam) shows everything and is never tagged here.';

-- 0072_market_listings.sql
--
-- Marketplace PR 4: the C2C buy/sell/swap marketplace — Facebook-Marketplace-style peer
-- listings. NO payments here by design: buyers and sellers agree in chat (the "Message
-- seller" hand-off) and settle in person, so casual sellers face zero KYC friction.
--
-- Locality-scoped like Town Hall (locality display name; lat/lng stored for a future
-- radius upgrade). Photos are public CDN URLs in the existing profile-media bucket under
-- the seller's uid path prefix (same storage RLS as avatars — no new bucket).
--
-- RLS: everyone reads LIVE listings (plus owners their own, any status); owners write
-- their own rows — plain caller RLS, no service escalation. Idempotent; run once.

create table if not exists market_listings (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references profiles(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 120),
  description text check (char_length(description) <= 2000),
  -- sell → price_pence required by the API; swap/free → null.
  price_pence integer check (price_pence >= 0 and price_pence <= 100000000),
  mode text not null default 'sell' check (mode in ('sell', 'swap', 'free')),
  category text not null default 'other',
  locality text,
  lat double precision,
  lng double precision,
  photo_urls jsonb not null default '[]'::jsonb,
  status text not null default 'live' check (status in ('live', 'sold', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists market_listings_browse_idx on market_listings (status, created_at desc);
create index if not exists market_listings_owner_idx on market_listings (owner_id, created_at desc);

alter table market_listings enable row level security;

drop policy if exists market_listings_read on market_listings;
create policy market_listings_read on market_listings
  for select using (status = 'live' or owner_id = auth.uid());

drop policy if exists market_listings_owner_write on market_listings;
create policy market_listings_owner_write on market_listings
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

drop trigger if exists market_listings_updated_at on market_listings;
create trigger market_listings_updated_at
  before update on market_listings
  for each row execute function set_updated_at();

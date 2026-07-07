-- 0070_venue_products.sql
--
-- Marketplace PR 2: the venue shop's catalogue. One table for BOTH kinds of thing a venue
-- sells — physical products (click & collect; optional stock count) and services/vouchers
-- (digital fulfilment; stock usually null = unlimited). Prices are integer pence (no floats
-- near money, ever); currency is ISO-4217 lowercase, GBP for launch.
--
-- photo_url is a public CDN URL in the existing PUBLIC venue-media bucket (owners upload
-- under their venue-id path prefix, same storage RLS as venue photos) — no new bucket.
--
-- RLS: anyone can read ACTIVE products (they render on the public venue Shop tab); the
-- venue's owner reads all (including deactivated) and has full write, gated on the venue
-- being claimed. Checkout/orders arrive in the next slice (0071).
--
-- Idempotent; safe to run once on the Roam-Core project.

create table if not exists venue_products (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  kind text not null check (kind in ('product', 'service')),
  title text not null check (char_length(title) between 3 and 120),
  description text check (char_length(description) <= 2000),
  price_pence integer not null check (price_pence >= 50 and price_pence <= 5000000),
  currency text not null default 'gbp',
  -- null = untracked/unlimited (typical for services); 0 = sold out.
  stock integer check (stock >= 0),
  photo_url text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists venue_products_venue_idx on venue_products (venue_id, active, created_at desc);

alter table venue_products enable row level security;

-- Public read of live catalogue entries; owners also see their deactivated ones.
drop policy if exists venue_products_read on venue_products;
create policy venue_products_read on venue_products
  for select
  using (
    active = true
    or exists (
      select 1 from venues v
      where v.id = venue_products.venue_id
        and v.owner_id = auth.uid()
    )
  );

-- Owner writes, only while the venue is claimed.
drop policy if exists venue_products_owner_write on venue_products;
create policy venue_products_owner_write on venue_products
  for all
  using (
    exists (
      select 1 from venues v
      where v.id = venue_products.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
  )
  with check (
    exists (
      select 1 from venues v
      where v.id = venue_products.venue_id
        and v.owner_id = auth.uid()
        and v.status = 'claimed'
    )
  );

drop trigger if exists venue_products_updated_at on venue_products;
create trigger venue_products_updated_at
  before update on venue_products
  for each row execute function set_updated_at();
